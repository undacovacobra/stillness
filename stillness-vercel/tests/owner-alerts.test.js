import assert from 'node:assert/strict';
import test from 'node:test';
import { checkOwnerCredit, creditForecast, deliverOwnerAlerts, notifyGeminiDepleted, ownerAlertConfig } from '../lib/owner-alerts.js';

const config = ownerAlertConfig({
  STILLNESS_OWNER_RESEND_API_KEY: 'send-only-key',
  MEMBER_ADMIN_EMAILS: 'OWNER@example.com',
});
const snapshot = {
  cents: 458, observed_at: '2026-11-23T18:21:29Z', active_members: 10,
  voice_since: 120, scripts_since: 2, voice_week: 120, scripts_week: 2, premium_seconds: 9000,
};
const date = new Date(snapshot.observed_at);

test('uses a recorded balance, actual usage and outstanding premium minutes', () => {
  assert.deepEqual(creditForecast(snapshot), {
    recorded: 458, available: 450, target: 700, observedAt: snapshot.observed_at, members: 10, shortfall: 250,
  });
  assert.equal(creditForecast({ ...snapshot, cents: null }).shortfall, null);
  assert.equal(creditForecast({ ...snapshot, cents: 0 }).available, 0);
});

test('queues a daily shortfall alert only when the recorded balance is insufficient', async () => {
  const queued = [];
  const store = { ownerCreditStatus: async () => snapshot, queueOwnerAlert: async job => queued.push(job) };
  await checkOwnerCredit({ config, store, now: date });
  assert.equal(queued[0].id, 'credit/2026-11-23');
  assert.equal(queued[0].details.shortfall, 250);
  await checkOwnerCredit({ config, store: { ...store, ownerCreditStatus: async () => ({ ...snapshot, cents: 800 }) }, now: date });
  assert.equal(queued.length, 1);
});

test('sends a trial alert only to the owner and uses the same key on retries', async () => {
  const id = 'trial/example';
  const job = { id, attempts: 2, kind: 'trial', details: {} };
  const results = [];
  const store = {
    claimOwnerAlert: async claimed => { assert.equal(claimed, id); return job; },
    finishOwnerAlert: async result => results.push(result.outcome),
  };
  const request = status => async (_url, options) => {
    assert.equal(options.headers['Idempotency-Key'], 'stillness-owner/trial/example');
    const body = JSON.parse(options.body);
    assert.deepEqual(body.to, ['owner@example.com']);
    assert.match(body.subject, /free trial started/i);
    return new Response(null, { status });
  };
  assert.equal((await deliverOwnerAlerts({ config, id, store, request: request(429) })).deferred, 1);
  assert.equal((await deliverOwnerAlerts({ config, id, store, request: request(200) })).accepted, 1);
  assert.deepEqual(results, ['retry', 'accepted']);
});

test('a confirmed Gemini billing failure queues an urgent alert independent of the forecast', async () => {
  const queued = [];
  const store = { queueOwnerAlert: async job => queued.push(job), claimOwnerAlert: async () => null };
  await notifyGeminiDepleted({ config, store, now: date });
  assert.deepEqual(queued, [{ id: 'depleted/2026-11-23', kind: 'depleted' }]);
});
