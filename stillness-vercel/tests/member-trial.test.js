import test from 'node:test';
import assert from 'node:assert/strict';
import { trialIdentifiers } from '../lib/member-trial.js';

function response() {
  return {
    headers:{}, getHeader(k) { return this.headers[k]; }, setHeader(k,v) { this.headers[k]=v; }
  };
}
function environment(t) {
  for (const [k,v] of Object.entries({
    APP_ORIGIN:'https://stillness-members.example',MEMBERS_COOKIE_SECRET:'test-key'.repeat(5),VERCEL:'1'
  })) {
    const prev = process.env[k];
    process.env[k]=v;
    t.after(()=>{ if(prev===undefined)delete process.env[k]; else process.env[k]=prev; });
  }
}
function req(ip,cookie='',forwarded) {
  return { headers:{'x-vercel-forwarded-for':ip,'x-forwarded-for':forwarded,cookie} };
}

test('a signed browser id persists without storing a raw IP or cookie in the ledger',t=>{
  environment(t);
  const res=response();
  const ids=trialIdentifiers(req('198.51.100.8'),res);
  assert.match(ids.deviceHash,/^[a-f0-9]{64}$/);
  assert.match(ids.networkHash,/^[a-f0-9]{64}$/);
  const output = res.headers['Set-Cookie'][0];
  assert.match(output,/HttpOnly; SameSite=Lax; Max-Age=15552000; Secure/);
  const stored=output.split(';')[0];
  assert(!output.includes('198.51.100.8'));
  assert(!output.includes(ids.deviceHash));
  assert.deepEqual(trialIdentifiers(req('198.51.100.8',stored,'203.0.113.11'),response()),ids);
  const alternate=trialIdentifiers(req('198.51.100.9',stored),response());
  assert.equal(alternate.deviceHash,ids.deviceHash);
  assert.notEqual(alternate.networkHash,ids.networkHash);
});
test('changing the cookie invalidates it and the network still limits trials',t=>{
  environment(t);
  const res=response();
  const a=trialIdentifiers(req('203.0.113.9'),res);
  const cookie=res.headers['Set-Cookie'][0].split(';')[0];
  const changed=cookie.replace(/=.*/, '=forged.signature');
  const next=trialIdentifiers(req('203.0.113.9',changed),response());
  assert.notEqual(a.deviceHash,next.deviceHash);
  assert.equal(a.networkHash,next.networkHash);
});
test('IPv6 privacy addresses share the same /64 bucket and mapped IPv4 uses the IPv4 bucket',t=>{
  environment(t);
  const get=ip=>trialIdentifiers(req(ip),response()).networkHash;
  assert.equal(get('2001:db8:1:2::13'),get('2001:0db8:0001:0002:eeee:ffff:1300:2'));
  assert.notEqual(get('2001:db8:1:2::13'),get('2001:db8:1:3::13'));
  assert.equal(get('::ffff:192.0.2.8'),get('192.0.2.8'));
});
test('a Vercel operation does not replace its missing trusted IP with a client-supplied header',t=>{
  environment(t);
  assert.equal(trialIdentifiers(req(undefined,'','203.0.113.1'),response()),null);
  assert.equal(trialIdentifiers(req('203.0.113.1, 198.51.100.1'),response()),null);
});
