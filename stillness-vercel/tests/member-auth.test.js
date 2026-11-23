import test from 'node:test';
import assert from 'node:assert/strict';
import { appOrigin, requireMember, requireSameOrigin, setMemberSession, setRecovery, hasRecovery } from '../lib/member-auth.js';

const APP = 'https://stillness-members.example';
const AUTH = 'https://stillness-auth.example';
function response() {
  return {
    headers: {}, code: 200,
    setHeader(key, value) { this.headers[key] = value; },
    getHeader(key) { return this.headers[key]; },
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; }
  };
}
function configure(t) {
  const env = { APP_ORIGIN: APP, SUPABASE_URL: AUTH, SUPABASE_PUBLISHABLE_KEY: 'pub-test', MEMBERS_COOKIE_SECRET: 'secret-test'.repeat(4) };
  for (const [key,value] of Object.entries(env)) {
    const old = process.env[key]; process.env[key] = value;
    t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
  }
}
test('auth rejects cross-origin writes before they perform any operation', t => {
  configure(t);
  const res = response();
  assert.equal(requireSameOrigin({ headers: { origin: 'https://foreign.example', 'content-type': 'application/json' } }, res), false);
  assert.equal(res.code, 403);
});
test('the public alias has its own same-origin callbacks and rejects writes from elsewhere', t => {
  configure(t);
  const alias = 'https://trystillness.example';
  const previous = process.env.STILLNESS_PUBLIC_ORIGIN;
  process.env.STILLNESS_PUBLIC_ORIGIN = alias;
  t.after(() => {
    if (previous === undefined) delete process.env.STILLNESS_PUBLIC_ORIGIN;
    else process.env.STILLNESS_PUBLIC_ORIGIN = previous;
  });
  const headers = { host: 'trystillness.example', origin: alias, 'content-type': 'application/json' };
  assert.equal(appOrigin({ headers }), alias);
  assert.equal(requireSameOrigin({ headers }, response()), true);
  const rejected = response();
  assert.equal(requireSameOrigin({ headers: { ...headers, origin: APP } }, rejected), false);
  assert.equal(rejected.code, 403);
  assert.equal(appOrigin({ headers: { ...headers, host: 'untrusted.example', 'x-forwarded-host': 'trystillness.example' } }), APP);
  assert.equal(appOrigin({ headers: { host: 'stillness-members.example' } }), APP);
});
test('server asks Supabase to verify session owner and confirmed email', async t => {
  configure(t);
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    assert.equal(url, AUTH + '/auth/v1/user');
    assert.equal(opts.headers.Authorization, 'Bearer user-token');
    return Response.json({id:'customer-a',email:'a@example.com',email_confirmed_at:'2026-11-21T00:00:00Z'});
  });
  const user = await requireMember({ headers: { cookie: 'stillness_access=user-token' } }, response());
  assert.equal(user.id, 'customer-a');

  const res = response();
  assert.equal(await requireMember({ headers: { cookie: 'stillness_access=user-token', 'x-stillness-member':'customer-b' } }, res), null);
  assert.equal(res.code, 401);
});
test('a recovery cookie is bound to the login session and uses a secure cookie', t => {
  configure(t);
  const res = response();
  const req = {headers:{}};
  setMemberSession(req,res,{access_token:'first-session',refresh_token:'refresh-session',expires_in:3600});
  setRecovery(req,res,'first-session');
  assert(res.headers['Set-Cookie'].every(cookie => cookie.includes('HttpOnly') && cookie.includes('Secure')));
  const cookies = res.headers['Set-Cookie'].map(cookie => cookie.split(';',1)[0]).join('; ');
  const signedRequest = { headers: { cookie: cookies } };
  assert.equal(hasRecovery(signedRequest,'first-session'), true);
  assert.equal(hasRecovery(signedRequest,'other-session'), false);
  assert.equal(hasRecovery({ headers:{cookie:'stillness_recovery=1'} },'first-session'), false);
});
