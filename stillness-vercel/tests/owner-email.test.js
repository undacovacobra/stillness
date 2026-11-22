import assert from 'node:assert/strict';
import test from 'node:test';
import account from '../api/account.js';
import { listEmailTemplates, validateEmailTemplate, previewEmailTemplate } from '../lib/trial-email-templates.js';
import { emailMessage } from '../lib/trial-email.js';

test('the owner can edit trial templates and preview their substitutions', () => {
  const templates = listEmailTemplates([{ kind: 'reminder', subject: 'Time remaining', body: 'You have {{minutes_left}} until {{trial_end}}.\n{{app_url}}' }]);
  assert.equal(templates.length, 6);
  const template = templates.find(item => item.kind === 'reminder');
  assert.equal(template.custom, true);
  const preview = previewEmailTemplate(template, 'https://stillness.example.com');
  assert.equal(preview.subject, 'Time remaining');
  assert.match(preview.text, /6 min 50 sec/);
  assert.match(preview.text, /https:\/\/stillness\.example\.com\//);
  assert.equal(validateEmailTemplate({ kind: 'reminder', subject: 'Bad\nHeader', body: 'Hi' }), null);
  assert.equal(validateEmailTemplate({ kind: 'reminder', subject: 'Hi', body: '{{unknown}}' }), null);
  assert.equal(validateEmailTemplate({ kind: 'offer', subject: 'Hi', body: '{{trial_end}}' }), null);
});

test('custom offer copy preserves the system unsubscribe footer', () => {
  const job = {
    user_id: '80441e8b-7600-4252-bf71-b477c540f953', kind: 'offer', email: 'member@example.com',
    template: { subject: 'Welcome back', body: 'Take a look.\n{{profile_url}}' },
  };
  const config = { origin: 'https://stillness.example.com', secret: 'test-key', postalAddress: '123 Example St' };
  const message = emailMessage(job, config);
  assert.equal(message.subject, 'Welcome back');
  assert.match(message.text, /Take a look[\s\S]+Unsubscribe[\s\S]+123 Example St/);
  assert.equal(message.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
});

test('an ordinary verified member and an unverified owner cannot use admin email routes', async t => {
  for (const [key, value] of Object.entries({
    SUPABASE_URL: 'https://database.example.com', SUPABASE_PUBLISHABLE_KEY: 'public-test',
    MEMBER_ADMIN_EMAILS: 'owner@example.com', APP_ORIGIN: 'https://stillness.example.com',
  })) {
    const before = process.env[key];
    process.env[key] = value;
    t.after(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before; });
  }
  let auth = { id: 'ordinary-user', email: 'member@example.com', email_confirmed_at: '2026-11-01' };
  const requests = [];
  t.mock.method(globalThis, 'fetch', async url => {
    requests.push(String(url));
    assert.equal(String(url), 'https://database.example.com/auth/v1/user');
    return Response.json(auth);
  });
  async function run(method, action) {
    const req = { method, headers: {
      host: 'stillness.example.com', origin: 'https://stillness.example.com',
      cookie: 'stillness_access=mock', 'content-type': 'application/json',
    },
      query: { view: 'admin-email' }, body: { action, kind: 'welcome', subject: 'Test', body: 'Hi' } };
    const res = { setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await account(req, res);
    return res;
  }
  assert.equal((await run('GET')).code, 403);
  assert.equal((await run('POST', 'admin-email-save')).code, 403);
  auth = { ...auth, email: 'owner@example.com', email_confirmed_at: null };
  assert.equal((await run('POST', 'admin-email-preview')).code, 401);
  auth.email_confirmed_at = '2026-11-01';
  const result = await run('POST', 'admin-email-preview');
  assert.equal(result.code, 200);
  assert.equal(result.body.preview.subject, 'Test');
  assert.equal(requests.length, 4);
});
