import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';

const file = new URL('../public/ambient-player.js', import.meta.url);
const source = existsSync(file) ? readFileSync(file, 'utf8') : '';
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function player({ pending, fail = false, blocked = false, legacy = false, supported = true } = {}) {
  const contexts = [], requests = [];
  class Context {
    constructor() { this.state = 'suspended'; this.currentTime = 0; this.destination = {}; this.sources = []; this.gains = []; this.decodes = 0; this.resumes = 0; contexts.push(this); }
    resume() { this.resumes++; if (!blocked) this.state = 'running'; return Promise.resolve(); }
    createGain() { const gain = { gain: { value: 1 }, connect: target => { gain.output = target; } }; this.gains.push(gain); return gain; }
    createBufferSource() {
      const sound = { loop: false, connect: target => { sound.output = target; }, disconnect() {},
        start: (when, offset) => { sound.startOffset = offset; sound.active = true; },
        stop: () => { sound.active = false; sound.onended?.(); } };
      this.sources.push(sound); return sound;
    }
    decodeAudioData(bytes, success) { this.decodes++; const buffer = { duration: 30 }; success?.(buffer); return Promise.resolve(buffer); }
  }
  const window = supported ? { [legacy ? 'webkitAudioContext' : 'AudioContext']: Context } : {};
  let failed = fail;
  const fetch = async url => { requests.push(url); if (pending) await pending.promise; return { ok: !failed, status: failed ? 503 : 200, arrayBuffer: async () => new ArrayBuffer(8) }; };
  vm.runInNewContext(source, { window, fetch, DOMException, Promise, Map, Set, Math, Number, Error });
  assert.ok(window.StillnessAudio, 'The shared Web Audio player must expose window.StillnessAudio');
  return { api: window.StillnessAudio, contexts, requests, allowFetch: () => { failed = false; } };
}
function sound(api, src = '/audio/ocean.mp3') { const result = api.createSound(); result.src = src; result.loop = true; return result; }

test('two ambient layers share one output and remain active together', async () => {
  const { api, contexts } = player();
  const ocean = sound(api), rain = sound(api, '/audio/rain.mp3');
  assert.equal(contexts.length, 0);
  const first = ocean.play(), second = rain.play();
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].state, 'running');
  await Promise.all([first, second]);
  assert.equal(contexts[0].sources.filter(s => s.active && s.loop).length, 2);
  assert.equal(ocean.paused, false); assert.equal(rain.paused, false);
  assert.ok(contexts[0].gains.every(g => g.output === contexts[0].destination));
});

test('concurrent play and repeated play never duplicate or restart a layer', async () => {
  const { api, contexts, requests } = player(); const ocean = sound(api);
  await Promise.all([ocean.play(), ocean.play()]);
  contexts[0].currentTime = 4; await ocean.play();
  assert.equal(contexts[0].sources.length, 1); assert.equal(ocean.currentTime, 4); assert.equal(requests.length, 1);
});

test('two adapters requesting the same URL share one fetch and decoded buffer', async () => {
  const { api, contexts, requests } = player();
  await Promise.all([sound(api).play(), sound(api).play()]);
  assert.equal(requests.length, 1); assert.equal(contexts[0].decodes, 1);
  assert.equal(contexts[0].sources[0].buffer, contexts[0].sources[1].buffer);
});

test('pausing while a download is pending prevents late playback', async () => {
  const pending = deferred(); const { api, contexts } = player({ pending }); const ocean = sound(api);
  const playing = ocean.play(); ocean.pause(); pending.resolve(); await playing;
  assert.equal(ocean.paused, true); assert.equal(contexts[0].sources.length, 0);
});

test('a new play after cancelling a pending download starts exactly once', async () => {
  const pending = deferred(); const { api, contexts } = player({ pending }); const ocean = sound(api);
  const old = ocean.play(); ocean.pause(); const current = ocean.play(); pending.resolve();
  await Promise.all([old, current]); assert.equal(contexts[0].sources.filter(s => s.active).length, 1);
});

test('pause and resume retain elapsed offset across loop boundaries and explicit reset', async () => {
  const { api, contexts } = player(); const ocean = sound(api); await ocean.play();
  contexts[0].currentTime = 38; ocean.pause(); assert.equal(ocean.currentTime, 8);
  contexts[0].currentTime = 100; await ocean.play();
  assert.equal(contexts[0].sources[1].startOffset, 8);
  contexts[0].currentTime = 103; assert.equal(ocean.currentTime, 11);
  ocean.pause(); ocean.currentTime = 0; await ocean.play(); assert.equal(contexts[0].sources[2].startOffset, 0);
});

test('volume fades update the connected gain without restarting the source', async () => {
  const { api, contexts } = player(); const ocean = sound(api); ocean.volume = 0.2; await ocean.play();
  assert.equal(contexts[0].gains[0].gain.value, 0.2);
  ocean.volume = 0.75; assert.equal(contexts[0].gains[0].gain.value, 0.75);
  ocean.volume = 2; assert.equal(ocean.volume, 1); ocean.volume = -1; assert.equal(ocean.volume, 0);
  assert.equal(contexts[0].sources.length, 1);
});

test('HTTP failures reject and emit an error while allowing a later retry', async () => {
  const { api, contexts, allowFetch, requests } = player({ fail: true }); const ocean = sound(api); const errors = [];
  ocean.addEventListener('error', event => errors.push(event));
  await assert.rejects(ocean.play(), /503/); assert.equal(errors.length, 1); assert.equal(ocean.paused, true);
  allowFetch(); await ocean.play(); assert.equal(requests.length, 2); assert.equal(contexts[0].sources.length, 1);
});

test('a context still suspended after resume rejects with NotAllowedError', async () => {
  const { api } = player({ blocked: true }); const ocean = sound(api);
  await assert.rejects(ocean.play(), { name: 'NotAllowedError' }); assert.equal(ocean.paused, true);
});

test('unlock resumes a legacy context synchronously and unsupported browsers can fall back', async () => {
  const { api, contexts } = player({ legacy: true }); const unlocking = api.unlock();
  assert.equal(contexts[0].resumes, 1); await unlocking;
  assert.equal(player({ supported: false }).api.supported, false);
});
