import test from 'node:test';
import assert from 'node:assert/strict';
import tts from '../lib/gemini-tts.js';
import script from '../lib/gemini-script.js';

const note = 'Private note about Maya and Friday at 9.';
const secret = 'test-secret-that-must-never-appear';

function setup(t, { retryAfter, retryDelay, malformed = false } = {}) {
  const previous = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = secret;
  t.after(() => {
    if (previous === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previous;
  });
  const calls = [];
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args));
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    const details = retryDelay === undefined ? [] : [
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay }
    ];
    return new Response(malformed ? 'invalid JSON' : JSON.stringify({
      error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: `${note} ${secret}`, details }
    }), { status: 429, headers: retryAfter === undefined ? {} : { 'Retry-After': retryAfter } });
  });
  return { calls, warnings };
}

function response(withHeaders = true) {
  const res = { code: 200, headers: {},
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; }
  };
  if (withHeaders) res.setHeader = function (name, value) { this.headers[name] = value; };
  return res;
}

for (const [label, handler, body, code] of [
  ['voice', tts, { text: note, voiceName: 'Achird' }, 'VOICE_RATE_LIMITED'],
  ['structured script', script, { intention: note, style: 'Mindfulness', durationMin: 5, chapterCount: 3 }, 'SCRIPT_RATE_LIMITED'],
  ['legacy script', script, { prompt: note }, 'SCRIPT_RATE_LIMITED']
]) {
  test(`${label}: provider 429 is returned immediately without a model retry burst or private diagnostics`, async t => {
    const { calls, warnings } = setup(t, { retryAfter: '23', retryDelay: '90s' });
    const res = response();
    await handler({ method: 'POST', body }, res);
    assert.equal(res.code, 429);
    assert.equal(res.body.code, code);
    assert.match(res.body.error, /usage limit|quota/i);
    assert.equal(res.body.retryAfterSeconds, 23);
    assert.equal(res.headers['Retry-After'], '23');
    assert.equal(calls.length, 1);
    assert.equal(warnings.length, 1);
    const model = new URL(calls[0].url).pathname.split('/').at(-1).split(':')[0];
    assert.deepEqual(warnings[0], [{ event: 'provider_rate_limited', model, status: 429, retryAfterSeconds: 23 }]);
    const visible = JSON.stringify({ body: res.body, headers: res.headers, warnings });
    assert.equal(visible.includes(note), false);
    assert.equal(visible.includes(secret), false);
    assert.equal(visible.includes('RESOURCE_EXHAUSTED'), false);
  });
}

for (const [label, options, expected] of [
  ['HTTP date', { retryAfter: 'Fri, 20 Nov 2026 12:00:45 GMT' }, 45],
  ['fractional Google delay rounded upward', { retryDelay: '4.200s' }, 5],
  ['invalid header falls through to Google delay', { retryAfter: 'not-a-date', retryDelay: '32s' }, 32],
  ['missing hints default to one minute', {}, 60],
  ['malformed JSON defaults to one minute', { malformed: true }, 60],
  ['invalid negative delay is ignored', { retryDelay: '-5s' }, 60],
  ['unrecognized Google delay is ignored', { retryDelay: 'tomorrow' }, 60],
  ['negative header is ignored', { retryAfter: '-3' }, 60],
  ['zero is clamped to one second', { retryAfter: '0' }, 1],
  ['very large header is bounded', { retryAfter: '999999999999' }, 86400],
  ['very large Google delay is bounded', { retryDelay: '999999999999s' }, 86400]
]) {
  test(`retry timing: ${label}`, async t => {
    t.mock.method(Date, 'now', () => Date.parse('2026-11-20T12:00:00Z'));
    const { calls } = setup(t, options);
    const res = response();
    await tts({ method: 'POST', body: { text: note } }, res);
    assert.equal(res.code, 429);
    assert.equal(res.body.retryAfterSeconds, expected);
    assert.equal(res.headers['Retry-After'], String(expected));
    assert.equal(calls.length, 1);
  });
}

test('rate-limit responses also work with legacy response helpers without setHeader', async t => {
  setup(t, { retryDelay: '12s' });
  const res = response(false);
  await script({ method: 'POST', body: { prompt: note } }, res);
  assert.equal(res.code, 429);
  assert.equal(res.body.retryAfterSeconds, 12);
});
test('a pinned model does not switch providers after a generation failure', async t => {
  const original = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-only-key';
  t.after(() => {
    if (original === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = original;
  });
  const urls = [];
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async url => {
    urls.push(url);
    return new Response('{}', {status:503});
  });
  const result = { status(code) { this.code = code; return this; }, json() {} };
  await tts({ method:'POST', body:{text:'Breathe.', model:'gemini-3.8-flash-lite-tts'} }, result);
  assert.equal(result.code, 502);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /gemini-3\.8-flash-lite-tts:generateContent$/);
});
