import assert from 'node:assert/strict';
import test from 'node:test';
import { emailConfig, emailMessage, emailToken, tokenMember, deliverTrialEmails } from '../lib/trial-email.js';
import route from '../api/trial-email.js';

const id = '80441e8b-7600-4252-bf71-b477c540f953';
const env = {
  STILLNESS_EMAIL_MODE: 'beta', STILLNESS_EMAIL_BETA_RECIPIENTS: 'Tester@example.com',
  RESEND_API_KEY: 'test-key', STILLNESS_EMAIL_FROM: 'Stillness <hello@example.com>',
  STILLNESS_EMAIL_REPLY_TO: 'support@example.com', CRON_SECRET: 'a'.repeat(32),
  STILLNESS_EMAIL_ORIGIN: 'https://stillness.example.com',
  STILLNESS_EMAIL_POSTAL_ADDRESS: '100 Example Street, Example, NY 10001',
};
const config = emailConfig(env);
const job = {
  user_id: id, email: 'tester@example.com', name: 'Sam', kind: 'reminder',
  trial_ends_at: '2026-12-02T09:00:00Z', remaining_seconds: 410, attempts: 1,
};

test('beta sending requires an explicit recipient list and a verified sender configuration', () => {
  assert.equal(emailConfig({}), null);
  assert.equal(emailConfig({ ...env, STILLNESS_EMAIL_BETA_RECIPIENTS: '' }), null);
  assert.equal(emailConfig({ ...env, STILLNESS_EMAIL_ORIGIN: 'http://stillness.example.com' }), null);
  assert.deepEqual(config.recipients, ['tester@example.com']);
});

test('offers are disabled until live billing and a postal address are configured', () => {
  const launch = {
    ...env, STILLNESS_EMAIL_MODE: 'launch', STRIPE_SECRET_KEY: 'rk_live_mock',
    STRIPE_MONTHLY_PRICE_ID: 'price_monthly', STRIPE_TOPUP_PRICE_ID: 'price_topup',
    STRIPE_WEBHOOK_SECRET: 'whsec_mock',
  };
  assert.equal(emailConfig(launch).offersEnabled, false);
  assert.equal(emailConfig({ ...launch, STRIPE_LIVE_ENABLED: 'true' }).offersEnabled, true);
  assert.equal(emailConfig({ ...launch, STRIPE_LIVE_ENABLED: 'true', STILLNESS_EMAIL_POSTAL_ADDRESS: '' }).offersEnabled, false);
});

test('trial notices include the actual end date, minutes and cardless status', () => {
  const started = emailMessage({ ...job, kind: 'started' }, config);
  assert.match(started.text, /15 narrated minutes/);
  assert.match(started.text, /Dec 2, 2026/);
  assert.match(started.text, /No card is needed/);
  const reminder = emailMessage(job, config);
  assert.match(reminder.text, /6 min 50 sec/);
  assert.match(reminder.text, /saved sessions/);
  const ended = emailMessage({ ...job, kind: 'ended' }, config);
  assert.match(ended.text, /reply.*feedback/i);
  assert.doesNotMatch(ended.text, /subscribe/i);
});

test('marketing messages provide an authenticated unsubscribe link and exact Profile route', () => {
  const message = emailMessage({ ...job, kind: 'offer' }, config);
  assert.match(message.text, /https:\/\/stillness\.example\.com\/\?view=profile/);
  assert.equal(message.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  const link = new URL(message.headers['List-Unsubscribe'].slice(1, -1));
  const token = link.searchParams.get('token');
  assert.equal(tokenMember(token, config.secret), id);
  assert.equal(tokenMember(token + 'a', config.secret), null);
  assert.equal(tokenMember(emailToken(id, config.secret), 'different'), null);
});

test('dispatch passes the audience to the database, uses an idempotency key and records delivery', async () => {
  const sent = [];
  let claims = 0;
  const result = await deliverTrialEmails({ config, userId: id, kinds: ['reminder'], store: {
    async claimTrialEmail(input) {
      assert.deepEqual(input, { userId: id, kinds: ['reminder'], recipients: ['tester@example.com'] });
      return claims++ === 0 ? job : null;
    },
    async finishTrialEmail(input) { sent.push(input); },
  }, request: async (url, options) => {
    assert.equal(url, 'https://api.resend.com/emails');
    assert.equal(options.headers['Idempotency-Key'], `stillness/${id}/reminder`);
    assert.equal(JSON.parse(options.body).to[0], job.email);
    return new Response('{}', { status: 200 });
  } });
  assert.equal(result.sent, 1);
  assert.deepEqual(sent, [{ userId: id, kind: 'reminder', attempts: 1, outcome: 'sent' }]);
});

test('ambiguous sends stay claimed and rate limits are deferred', async () => {
  for (const [status, expected] of [[503, null], [429, 'retry'], [422, 'failed']]) {
    const outcomes = [];
    await deliverTrialEmails({ config, userId: id, store: {
      async claimTrialEmail() { return job; },
      async finishTrialEmail(input) { outcomes.push(input.outcome); },
    }, request: async () => new Response('{}', { status }) });
    assert.deepEqual(outcomes, expected ? [expected] : []);
  }
});

test('only signed POSTs save an opt-out and the scheduler checks its bearer token', async t => {
  for (const [key, value] of Object.entries({
    CRON_SECRET: env.CRON_SECRET, SUPABASE_URL: 'https://database.example.com', SUPABASE_SECRET_KEY: 'sb_secret_mock',
  })) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  const writes = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url.pathname, '/rest/v1/rpc/stillness_set_email_preference');
    writes.push(JSON.parse(options.body));
    return new Response('true');
  });
  const run = async request => {
    const response = {
      setHeader() {},
      status(code) { this.code = code; return this; },
      send(body) { this.body = body; return this; },
      json(body) { this.body = body; return this; },
    };
    await route(request, response);
    return response;
  };
  assert.equal((await run({ method: 'GET' })).code, 401);
  assert.equal((await run({ method: 'POST', query: { token: 'invalid' } })).code, 400);
  const token = emailToken(id, env.CRON_SECRET);
  assert.match((await run({ method: 'GET', query: { token } })).body, /<form method="post">/);
  assert.equal(writes.length, 0);
  assert.equal((await run({ method: 'POST', query: { token } })).code, 200);
  assert.deepEqual(writes, [{ p_user_id: id, p_enabled: false }]);
});
