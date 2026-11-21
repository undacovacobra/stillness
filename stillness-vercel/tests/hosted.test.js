import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import status from '../api/status.js';
import tts from '../api/tts.js';
import script from '../api/script.js';

function setEnv(t, key, value) {
  const old = process.env[key];
  process.env[key] = value;
  t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
}

function response() {
  return { code: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
}

test('the existing api_key_google environment variable enables hosted status and both APIs', async (t) => {
  setEnv(t, 'GEMINI_API_KEY', '');
  setEnv(t, 'api_key_google', 'server-test-secret');
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    seen.push({ url, options });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [
      { text: '["A personal meditation"]', inlineData: { data: 'AAAA', mimeType: 'audio/L16;rate=24000' } }
    ] } }] }), { status: 200 });
  });
  const s = response(); status({ method: 'GET' }, s);
  assert.equal(s.body.configured, true);
  assert.equal(s.headers['Cache-Control'], 'no-store');
  const audio = response(); await tts({ method: 'POST', body: { text: 'Breathe gently.', voiceName: 'Achird' } }, audio);
  assert.equal(audio.code, 200);
  assert.equal(audio.body.data, 'AAAA');
  const meditation = response(); await script({ method: 'POST', body: { prompt: 'Write a meditation.' } }, meditation);
  assert.equal(meditation.code, 200);
  assert.equal(meditation.body.text, '["A personal meditation"]');
  assert.equal(seen.length, 2);
  for (const request of seen) assert.equal(request.options.headers['x-goog-api-key'], 'server-test-secret');
  assert.equal(JSON.stringify([s.body, audio.body, meditation.body]).includes('server-test-secret'), false);
});

test('the standard key takes precedence and missing configuration stays private', async (t) => {
  setEnv(t, 'GEMINI_API_KEY', 'standard-secret'); setEnv(t, 'api_key_google', 'legacy-secret');
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.headers['x-goog-api-key'], 'standard-secret');
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Meditation' }] } }] }));
  });
  const result = response(); await script({ method: 'POST', body: { prompt: 'Breathe.' } }, result);
  assert.equal(result.code, 200);
  setEnv(t, 'GEMINI_API_KEY', ''); setEnv(t, 'api_key_google', '');
  const missing = response(); await tts({ method: 'POST', body: { text: 'Breathe.' } }, missing);
  assert.equal(missing.code, 503);
  const s = response(); status({ method: 'GET' }, s); assert.equal(s.body.configured, false);
});

function page(path, fetch) {
  const html = readFileSync(new URL(path, import.meta.url), 'utf8');
  const source = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
  const elements = new Map();
  const element = () => ({ value: '', textContent: '', innerHTML: '', style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {} }, listeners: {},
    addEventListener(type, fn) { this.listeners[type] = fn; }, querySelectorAll() { return []; },
    appendChild() {}, contains() { return false; }, pause() {}, play: async () => {},
    setAttribute() {}, removeAttribute() {} });
  const document = { getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
    querySelectorAll() { return []; }, createElement: element, body: element() };
  const storage = { getItem: () => 'stale-personal-secret', setItem() {}, removeItem() {} };
  const context = vm.createContext({ document, window: { addEventListener() {}, name: '' },
    location: { protocol: 'https:', hostname: 'stillness.example' }, localStorage: storage,
    sessionStorage: storage, fetch, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0,
    clearInterval() {}, URL, Blob, atob, console });
  vm.runInContext(source, context);
  return { run: code => vm.runInContext(code, context), elements };
}

for (const path of ['../index.html', '../public/index.html']) {
  test(`${path}: a fresh or returning visitor gets hosted voice before the status check finishes`, async () => {
    const requests = [];
    const p = page(path, async (url, options) => {
      requests.push({ url, options });
      if (url === '/api/status') return new Promise(() => {});
      assert.equal(url, '/api/tts');
      return new Response(JSON.stringify({ data: 'AAAA', mimeType: 'audio/wav' }));
    });
    p.run('init()');
    const ok = await p.run('speakWithGeminiTTS("Breathe.", VOICES[0], () => {})');
    assert.equal(ok, true);
    const voice = requests.find(r => r.url === '/api/tts');
    assert.ok(voice);
    assert.equal(JSON.stringify(voice).includes('stale-personal-secret'), false);
    assert.equal(p.elements.get('voicePlayer').src, 'data:audio/wav;base64,AAAA');
    const before = requests.length;
    await p.elements.get('testStudioVoiceBtn').listeners.click();
    assert.equal(requests.length, before + 1);
    assert.equal(requests.at(-1).url, '/api/tts');
  });

  test(`${path}: an unavailable hosted voice falls back without requesting visitor credentials`, async () => {
    const p = page(path, async () => new Response(JSON.stringify({ error: 'Studio voice is temporarily unavailable.' }), { status: 503 }));
    const ok = await p.run('speakWithGeminiTTS("Breathe.", VOICES[0], () => {})');
    assert.equal(ok, false);
  });
}

