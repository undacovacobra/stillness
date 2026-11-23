import test from 'node:test';
import assert from 'node:assert/strict';
import tts from '../api/tts.js';
import script from '../api/script.js';
import { withUsage } from '../lib/member-usage.js';
import { encodeWav } from '../lib/encode-wav.js';

const app = 'https://stillness-members.example';
const sb = 'https://auth.example';
const env = {APP_ORIGIN:app,SUPABASE_URL:sb,SUPABASE_PUBLISHABLE_KEY:'public-key',SUPABASE_SECRET_KEY:'sb_secret_test',GEMINI_API_KEY:'provider-key'};
const user = {id:'ada', email:'ada@example.com', email_confirmed_at:'now'};
function setup(t) {
  for (const [name,value] of Object.entries(env)) {
    const old=process.env[name]; process.env[name]=value;
    t.after(() => { if (old === undefined) delete process.env[name]; else process.env[name]=old; });
  }
}
function req(body, token = 'test') {
  return {method:'POST', headers:{origin:app,'content-type':'application/json',cookie:token ? 'stillness_access=' + token : ''},body};
}
function response() {
  return {
    code:200, headers:{}, setHeader(name, value) { this.headers[name]=value; },
    status(code) { this.code=code; return this; }, json(body) { this.body=body; return this; }
  };
}
test('both moderation engines reject an anonymous browser before any provider request', async t => {
  setup(t);
  const network = t.mock.method(globalThis, 'fetch', () => assert.fail('no remote calls for anonymous requests'));
  for (const handler of [tts,script]) {
    const res=response(); await handler(req({text:'Hi', intention:'Hi'},''),res);
    assert.equal(res.code,401);
  }
  assert.equal(network.mock.callCount(),0);
});
test('member without usage cannot reach Gemini', async t => {
  setup(t);
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).endsWith('/auth/v1/user')) return Response.json(user);
    assert(String(url).endsWith('/stillness_reserve_usage'));
    assert.equal(JSON.parse(options.body).p_user_id, user.id);
    return Response.json({allowed:false,reason:'limit'});
  });
  const res=response(); await tts(req({text:'Take a breath.', voiceName:'Algieba'}),res);
  assert.equal(res.code,402);
  assert.equal(res.body.code,'usage_exhausted');
});
test('Kokoro charges the length of the generated WAV to its separate balance', async t => {
  setup(t);
  const wave = Buffer.from(encodeWav(new Float32Array(24000 * 3), 24000));
  const handler = withUsage('kokoro', (_req, res) => {
    res.setHeader('Content-Type', 'audio/wav');
    return res.status(200).send(wave);
  }, () => null);
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const route = String(url);
    if (route.endsWith('/auth/v1/user')) return Response.json(user);
    const body = JSON.parse(options.body);
    if (route.endsWith('/stillness_reserve_usage')) {
      assert.equal(body.p_kind, 'kokoro');
      assert.ok(body.p_seconds > 0);
      return Response.json({ allowed: true, remaining_seconds: 0, topup_seconds: 0, kokoro_remaining_seconds: 3593 });
    }
    assert(route.endsWith('/stillness_settle_usage'));
    assert.equal(body.p_used_seconds, 3);
    return Response.json({ accepted: true, remaining_seconds: 0, topup_seconds: 0, kokoro_remaining_seconds: 3597 });
  });
  const res = response();
  res.send = res.json;
  await handler(req({ text: 'Breathe slowly.' }), res);
  assert.equal(res.code, 200);
  assert.equal(res.body, wave);
  assert.equal(res.headers['Content-Type'], 'audio/wav');
  assert.equal(res.headers['X-Stillness-Kokoro-Seconds'], '3597');
});

test('an exhausted Kokoro allowance blocks generation before the model runs', async t => {
  setup(t);
  const handler = withUsage('kokoro', () => assert.fail('no generation after cap'), () => null);
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).endsWith('/auth/v1/user')) return Response.json(user);
    assert(String(url).endsWith('/stillness_reserve_usage'));
    return Response.json({ allowed: false, reason: 'kokoro_limit', kokoro_remaining_seconds: 0 });
  });
  const res = response();
  await handler(req({text:'Breathe.'}), res);
  assert.equal(res.code,402);
  assert.equal(res.body.code,'kokoro_exhausted');
  assert.equal(res.headers['X-Stillness-Kokoro-Seconds'], '0');
});
test('generated audio is sent only after successfully recording its measured seconds', async t => {
  setup(t);
  let charged;
  const data = Buffer.alloc(24000 * 2 * 3).toString('base64');
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const route=String(url);
    if (route.endsWith('/auth/v1/user')) return Response.json(user);
    if (route.endsWith('/stillness_reserve_usage')) return Response.json({allowed:true});
    if (route.startsWith('https://generativelanguage.googleapis.com/')) {
      return Response.json({candidates:[{content:{parts:[{inlineData:{data,mimeType:'audio/L16;rate=24000'}}]}}]});
    }
    assert(route.endsWith('/stillness_settle_usage'));
    charged=JSON.parse(options.body).p_used_seconds;
    return Response.json({accepted:true,remaining_seconds:30,topup_seconds:4});
  });
  const res=response(); await tts(req({text:'Now breathe.', voiceName:'Algieba'}),res);
  assert.equal(res.code,200);
  assert.equal(charged,3);
  assert.equal(res.body.data,data);
  assert.equal(res.headers['X-Stillness-Remaining-Seconds'],'30');
});
