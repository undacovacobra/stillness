import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyBillingEvent,
  claimTrialCard,
  getMember,
  reserveUsage,
  settleUsage,
} from '../lib/member-store.js';

const testUser = '254f469a-00aa-4a45-8b6c-222ee6058a17';

function mockStore(t, responses, key = 'sb_secret_test') {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const next = responses.shift();
    assert.ok(next);
    assert.equal(String(url), 'https://stillness.test.supabase.co/rest/v1/rpc/' + next.rpc);
    assert.equal(options.headers.apikey, key);
    assert.equal(options.headers.Authorization, key.startsWith('eyJ') ? 'Bearer ' + key : undefined);
    if (next.check) next.check(JSON.parse(options.body));
    return new Response(JSON.stringify(next.data), { status: next.status ?? 200 });
  });
  const env = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
  process.env.SUPABASE_URL = 'https://stillness.test.supabase.co';
  process.env.SUPABASE_SECRET_KEY = key;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  t.after(() => {
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    assert.equal(responses.length, 0);
  });
}

test('a new member can be initialized from a verified identity', async (t) => {
  const data = { user_id: testUser, status: 'inactive', remaining_seconds: 0 };
  mockStore(t, [{
    rpc: 'stillness_get_member', data,
    check: (input) => assert.deepEqual(input, { p_user_id: testUser, p_email: 'hello@example.com' }),
  }]);
  assert.deepEqual(await getMember(testUser, 'hello@example.com'), data);
});

test('reservation and reconciliation pass only IDs and billable quantities', async (t) => {
  mockStore(t, [
    {
      rpc: 'stillness_reserve_usage', data: { allowed: true, remaining_seconds: 852, topup_seconds: 0 },
      check: (input) => assert.deepEqual(input, { p_user_id: testUser, p_request_id: 'req-1', p_seconds: 48, p_kind: 'voice' }),
    },
    {
      rpc: 'stillness_settle_usage', data: { settled: true, remaining_seconds: 862 },
      check: (input) => assert.deepEqual(input, { p_user_id: testUser, p_request_id: 'req-1', p_used_seconds: 38 }),
    },
  ], 'eyJ.legacy.token');
  const hold = await reserveUsage(testUser, 'req-1', { seconds: 48, kind: 'voice', text: 'Private meditation' });
  assert.equal(hold.allowed, true);
  assert.equal((await settleUsage(testUser, 'req-1', 38)).remaining_seconds, 862);
});

test('Stripe card trial stores a hash and the webhook carries the verified claim ID', async (t) => {
  mockStore(t, [
    {
      rpc: 'stillness_claim_trial_card', data: { applied: true },
      check: (input) => {
        assert.equal(input.p_setup_id, 'seti_1');
        assert.equal(input.p_customer_id, 'cus_1');
        assert.match(input.p_card_hash, /^[a-f\d]{64}$/);
      },
    },
    {
      rpc: 'stillness_apply_billing_event', data: { applied: true },
      check: (input) => {
        assert.equal(input.p_entitlement, 'trial');
        assert.equal(input.p_trial_claim_id, 'seti_1');
        assert.equal(input.p_event_created, 1789234567);
      },
    },
  ]);
  assert.equal((await claimTrialCard(testUser, 'cus_1', 'seti_1', 'stripe-card-fingerprint')).applied, true);
  await applyBillingEvent({
    eventId: 'evt_1', eventCreated: 1789234567, userId: testUser, customerId: 'cus_1', subscriptionId: 'sub_1',
    entitlement: 'trial', trialClaimId: 'seti_1',
  });
});

test('service errors propagate without revealing account data or keys', async (t) => {
  mockStore(t, [{ rpc: 'stillness_get_member', data: { hint: 'private provider details' }, status: 500 }]);
  await assert.rejects(getMember(testUser), { message: 'Membership storage is unavailable.' });
});
