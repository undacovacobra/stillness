import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import account from '../api/account.js';

const ORIGIN = 'https://stillness-members.example';
const AUTH = 'https://accounts.example';
const user = {id:'member-a',email:'a@example.com',email_confirmed_at:'now'};

function config(t) {
  for (const [key,value] of Object.entries({
    APP_ORIGIN:ORIGIN,SUPABASE_URL:AUTH,SUPABASE_PUBLISHABLE_KEY:'publishable-test',
    SUPABASE_SECRET_KEY:'sb_secret_test',MEMBERS_COOKIE_SECRET:'test'.repeat(12)
  })) {
    const prev = process.env[key];
    process.env[key] = value;
    t.after(() => { if (prev === undefined) delete process.env[key]; else process.env[key] = prev; });
  }
}

function response() {
  return {
    code:200, headers:{}, getHeader(name) { return this.headers[name]; },
    setHeader(name,value) { this.headers[name]=value; },
    status(code) { this.code=code; return this; },
    json(body) { this.body=body; return this; }
  };
}

function post(body, cookies) {
  return {
    method:'POST', headers:{'content-type':'application/json',origin:ORIGIN,cookie:cookies}, body
  };
}

test('auth options only advertise enabled Google and Apple providers', async t => {
  config(t);
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, AUTH + '/auth/v1/settings');
    assert.equal(options.headers.apikey, 'publishable-test');
    return Response.json({external:{google:true,apple:false,github:true},Unrelated:'omitted'});
  });
  const res=response();
  await account({method:'GET',headers:{},query:{view:'providers'}},res);
  assert.deepEqual(res.body,{google:true,apple:false});
});

test('the OAuth flow uses a same-browser PKCE cookie and the ordinary verified member', async t => {
  config(t);
  let codeVerifier;
  t.mock.method(globalThis, 'fetch', async (target, options) => {
    const url = new URL(target);
    if (url.pathname.endsWith('/settings')) return Response.json({external:{google:true,apple:true}});
    if (url.pathname.endsWith('/token')) {
      const request = JSON.parse(options.body);
      assert.equal(url.searchParams.get('grant_type'),'pkce');
      assert.equal(request.auth_code,'test-auth-code');
      assert.equal(request.code_verifier,codeVerifier);
      return Response.json({user,access_token:'new-access',refresh_token:'new-refresh',expires_in:3600});
    }
    assert.equal(url.pathname,'/rest/v1/rpc/stillness_get_member');
    assert.equal(JSON.parse(options.body).p_user_id,user.id);
    return Response.json({user_id:user.id,name:'',goal:'',status:'inactive',trial_used:false});
  });
  for (const provider of ['google','apple']) {
    const start=response();
    await account(post({action:'oauth',provider}),start);
    const url=new URL(start.body.url);
    assert.equal(url.origin,AUTH);
    assert.equal(url.pathname,'/auth/v1/authorize');
    assert.equal(url.searchParams.get('provider'),provider);
    assert.equal(url.searchParams.get('redirect_to'),ORIGIN+'/?flow=oauth');
    assert.equal(url.searchParams.get('code_challenge_method'),'s256');
    const cookie = start.headers['Set-Cookie'][0];
    assert.match(cookie, /HttpOnly; SameSite=Lax; Max-Age=600; Secure/);
    const requestCookie = cookie.split(';')[0];
    codeVerifier = requestCookie.split('=')[1];
    assert.equal(url.searchParams.get('code_challenge'),createHash('sha256').update(codeVerifier).digest('base64url'));
    const accepted=response();
    await account(post({action:'accept',flow:'oauth',code:'test-auth-code'},requestCookie),accepted);
    assert.equal(accepted.code,200);
    assert.deepEqual(accepted.body.user,{id:user.id,email:user.email});
    assert.equal(accepted.body.member.status,'inactive');
    assert.equal(accepted.body.recovery,undefined);
  }
});

test('unsupported or disabled providers cannot begin OAuth and callback needs its own verifier', async t => {
  config(t);
  const requests = t.mock.method(globalThis,'fetch',async () => Response.json({external:{apple:false}}));
  const wrong=response();
  await account(post({action:'oauth',provider:'github'}),wrong);
  assert.equal(wrong.code,400);
  assert.equal(requests.mock.callCount(),0);
  const disabled=response();
  await account(post({action:'oauth',provider:'apple'}),disabled);
  assert.equal(disabled.code,503);
  assert.equal(disabled.headers['Set-Cookie'],undefined);
  const callback=response();
  await account(post({action:'accept',flow:'oauth',code:'test-auth-code'},'stillness_pkce_signup='+'x'.repeat(43)),callback);
  assert.equal(callback.code,400);
  assert.equal(requests.mock.callCount(),1);
});
