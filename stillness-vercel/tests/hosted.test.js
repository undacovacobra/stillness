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

function page(path, fetch, stored = new Map(), kokoro) {
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
  const storage = { getItem: key => stored.get(key) ?? (key.includes('_key') ? 'stale-personal-secret' : null),
    setItem(key, value) { stored.set(key, value); }, removeItem(key) { stored.delete(key); } };
  const context = vm.createContext({ document, window: { addEventListener() {}, name: '', StillnessKokoro: kokoro },
    location: { protocol: 'https:', hostname: 'stillness.example' }, localStorage: storage,
    sessionStorage: storage, fetch, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0,
    clearInterval() {}, URL, Blob, atob, console, AbortController });
  vm.runInContext(source, context);
  return { run: code => vm.runInContext(code, context), elements };
}

test('Kokoro trial starts as soon as its first chapter is ready and reuses its next chapter request', async () => {
  const spoken = [];
  let resolveNext;
  const next = new Promise(resolve => { resolveNext = resolve; });
  const p = page('../public/index.html', async () => assert.fail('The trial must not call the paid speech API'), new Map(), {
    async render(text) {
      spoken.push(text);
      if (text.startsWith('Let your')) await next;
      return { mimeType: 'audio/wav', blob: new Blob([text], { type: 'audio/wav' }) };
    }
  });
  assert.equal(p.run('VOICES.map(voice => voice.name).join()'), 'Kokoro Heart');
  await p.run('toggleVoicePreview(VOICES[0].id)');
  assert.equal(p.elements.get('voicePlayer').src, '/audio/kokoro-heart-preview.mp3');
  assert.deepEqual(spoken, []);
  p.run(`stopVoicePlayback(); state.session = { active: true, paused: false,
    chapters: [{ text: 'Notice your shoulders.' }, { text: 'Let your breathing settle.' }],
    settings: { voiceId: VOICES[0].id } };`);
  await p.run('prepareSessionNarration(state.session)');
  assert.equal(p.run('state.session.narrationReady'), true);
  assert.equal(p.run('state.session.narrationClips[1].length'), 0);
  const preload = p.run('loadKokoroClip(state.session, 1, 0)');
  const playback = p.run('loadKokoroClip(state.session, 1, 0)');
  assert.equal(preload, playback);
  resolveNext();
  await playback;
  assert.deepEqual(spoken, ['Notice your shoulders.', 'Let your breathing settle.']);
});

test('Kokoro keeps filling a bounded buffer while the same clip is playing', async () => {
  const spoken = [];
  const p = page('../public/index.html', async () => assert.fail('Unexpected AI request'), new Map(), {
    async render(text) {
      spoken.push(text);
      return { mimeType: 'audio/wav', blob: new Blob([text], { type: 'audio/wav' }) };
    }
  });
  p.run(`state.session = { active: true, paused: false, chapterIndex: 0,
    chapters: ['Start.', 'Two.', 'Three.', 'Four.', 'Five.'].map(text => ({ text })),
    settings: { voiceId: VOICES[0].id } };`);
  await p.run('prepareSessionNarration(state.session)');
  assert.deepEqual(spoken, ['Start.']);
  await p.run(`playPreparedChapter(state.session, () => {})`);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(spoken, ['Start.', 'Two.', 'Three.', 'Four.']);
  assert.equal(p.run('state.session.chapterIndex'), 0);
  assert.equal(p.run('state.session.narrationClips[4].length'), 0);
  p.run('clearSessionTimers()');
  assert.equal(p.run('state.session.kokoroController.signal.aborted'), true);
});

for (const path of ['../index.html', '../public/index.html']) {
  test(`${path}: sparse and spacious sessions never stretch a pause beyond one minute`, () => {
    const p = page(path, async () => {});
    for (const mode of ['natural','every','minimal']) {
      for (const [duration,detail,pace] of [[60,'minimal',1.45],[30,'wordy',0.65],[10,'average',1],[1,'wordy',1.45],[3,'minimal',1]]) {
        p.run(`state.durationMin=${duration};state.wordiness='${detail}';state.pausePace=${pace};state.pauseMode='${mode}'`);
        const plan = p.run('getActiveSessionPlan()');
        assert.ok(plan.chapters.every(ch => Number.isInteger(ch.pauseSec) && ch.pauseSec >= 0 && ch.pauseSec <= 60), `${mode}/${duration}/${detail}/${pace}: ${plan.chapters.map(ch => ch.pauseSec)}`);
      }
    }
  });

  test(`${path}: natural pauses give more room to practice than to settling and closing`, () => {
    const p = page(path, async () => {});
    p.run(`state.durationMin=30;state.wordiness='minimal';state.pausePace=1;state.pauseMode='natural'`);
    const plan = p.run('getActiveSessionPlan()');
    assert.ok(plan.chapters[0].pauseSec <= 12);
    assert.ok(plan.chapters.at(-1).pauseSec <= 8);
    assert.ok(plan.chapters[1].pauseSec > plan.chapters[0].pauseSec);
    const normal = plan.chapters.find(ch=>ch.cueType==='practice').pauseSec;
    p.run(`state.pauseMode='minimal'`);
    assert.ok(p.run('getActiveSessionPlan().chapters.find(ch=>ch.cueType==="practice").pauseSec') < normal);
  });

  test(`${path}: an older saved session keeps its script while oversized pauses are shortened`, () => {
    const p = page(path, async () => {});
    p.run(`state.durationMin=30;state.session.phase='done';state.session.totalEstSec=1200;
      state.session.chapters=[{text:'Exact saved practice.',cueType:'practice',pauseSec:300}];
      saveCompletedSession();restoreSavedSession(readSessionLibrary()[0].id,false);`);
    const plan = p.run('getActiveSessionPlan()');
    assert.equal(plan.chapters[0].text, 'Exact saved practice.');
    assert.ok(plan.chapters[0].pauseSec <= 60);
    assert.ok(plan.totalEstSec < 1200);
  });

  test(`${path}: the playback timer clamps even an uncapped legacy chapter`, () => {
    const p = page(path, async () => {});
    p.run(`state.session.active=true;state.session.chapters=[{text:'Rest here.',cueType:'practice',cueLabel:'Reflection',pauseSec:999}];beginChapterPause();`);
    assert.ok(p.run('state.session.pauseTotalSec') <= 60);
    assert.ok(p.run('state.session.pauseRemainingSec') <= 60);
  });

  test(`${path}: a phone interruption pauses progress and offers audio recovery`, () => {
    const p = page(path, async () => {});
    p.run(`state.session.active=true; state.session.phase='speaking'; voicePlayer.paused=true; voicePlayer.ended=false;`);
    p.elements.get('voicePlayer').listeners.pause?.();
    assert.equal(p.run('state.session.phase'), 'audio-blocked');
  });

  test(`${path}: long narration is requested in bounded pieces without losing any words`, async () => {
    const requested = [];
    const p = page(path, async (url, options) => {
      requested.push(JSON.parse(options.body).text);
      return new Response(JSON.stringify({data:'AAAA',mimeType:'audio/wav'}));
    });
    const text = Array(20).fill('Let Jordan and the garden project wait as you notice this gentle breath.').join(' ');
    p.run('var narrationDone = 0');
    await p.run(`speakWithGeminiTTS(${JSON.stringify(text)}, VOICES[0], () => narrationDone++)`);
    for (let i=0; i<20 && p.run('narrationDone')===0; i++) {
      p.elements.get('voicePlayer').onended();
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.ok(requested.length > 1);
    assert.ok(requested.every(part => part.length <= 500));
    assert.equal(requested.join(' '), text);
    assert.equal(p.run('narrationDone'), 1);
  });

  test(`${path}: the session clock waits for voice playback and freezes on an audio failure`, async () => {
    const p = page(path, async () => {});
    p.run(`var tick; setInterval = fn => {tick=fn;return 1}; state.sounds.forEach(sound=>sound.enabled=false);`);
    await p.run('startSession()');
    p.run(`state.session.phase='loading-voice'; tick(); state.session.phase='audio-error'; tick();`);
    assert.equal(p.run('state.session.elapsedSec'), 0);
    p.run(`state.session.phase='speaking'; tick();`);
    assert.equal(p.run('state.session.elapsedSec'), 1);
  });

  test(`${path}: an old play promise cannot mark a newer session as speaking`, async () => {
    const p = page(path, async () => {});
    p.run(`state.session.active = true; state.session.phase = 'loading-voice';
      var resolvePlay; voicePlayer.play = () => new Promise(done => {resolvePlay=done;});`);
    const old = p.run('playInlineAudioData({data:"AAAA",mimeType:"audio/wav"},()=>{})');
    p.run('stopVoicePlayback(); state.session.phase = "loading-voice"; resolvePlay()');
    await old;
    assert.equal(p.run('state.session.phase'), 'loading-voice');
  });

  test(`${path}: stopping audio also cancels a queued retry waiting for background playback`, async () => {
    const p = page(path, async () => {});
    p.run(`var resolveBackground; var retries = 0;
      soundElements.ocean = {play:() => new Promise(done => {resolveBackground=done;})};
      pendingVoiceAction = () => retries++;`);
    const retry = p.run('resumeSessionAudio()');
    p.run('stopVoicePlayback(); resolveBackground()');
    await retry;
    assert.equal(p.run('retries'), 0);
  });

  test(`${path}: audio arriving while paused starts when the user resumes`, async () => {
    const p = page(path, async () => {});
    p.run(`state.session.active = true; state.session.paused = true; state.session.phase = 'loading-voice';`);
    await p.run('playInlineAudioData({data:"AAAA",mimeType:"audio/wav"},()=>{})');
    p.run('toggleSessionPause()');
    await Promise.resolve(); await Promise.resolve();
    assert.equal(p.run('state.session.phase'), 'speaking');
  });

  test(`${path}: phone autoplay blocking retains narration and resumes it on a tap`, async () => {
    const p = page(path, async () => {});
    p.run(`state.session.active = true; state.session.phase = 'loading';
      var attempts = 0; var spokenDone = 0;
      voicePlayer.play = async () => { if (++attempts === 1) throw Object.assign(new Error('gesture required'), {name:'NotAllowedError'}); };`);
    const retained = await p.run('playInlineAudioData({data:"AAAA",mimeType:"audio/wav"}, () => spokenDone++)');
    assert.equal(retained, true);
    assert.equal(p.run('state.session.phase'), 'audio-blocked');
    assert.equal(p.run('spokenDone'), 0);
    await p.run('resumeSessionAudio()');
    assert.equal(p.run('state.session.phase'), 'speaking');
    assert.equal(p.elements.get('voicePlayer').src, 'data:audio/wav;base64,AAAA');
  });

  test(`${path}: a rate limit holds the session at the beginning without playing another voice`, async () => {
    const requests = [];
    const p = page(path, async (url, options) => {
      requests.push(JSON.parse(options.body));
      if (requests.length === 1) return new Response(JSON.stringify({data:'AAAA',mimeType:'audio/wav',model:'gemini-3.8-flash-tts'}));
      if (requests.length === 2) return new Response(JSON.stringify({code:'VOICE_RATE_LIMITED',retryAfterSeconds:30}), {status:429});
      return new Response(JSON.stringify({data:'AAAA',mimeType:'audio/wav',model:'gemini-3.8-flash-tts'}));
    });
    p.run(`state.session.active = true; state.session.settings = captureSessionSettings();
      state.session.chapters = [{text:'First.'},{text:'Second.'}];
      voicePlayer.play = () => {throw new Error('Narration must wait for preparation');};`);
    await p.run('prepareSessionNarration(state.session)');
    assert.equal(p.run('state.session.phase'), 'audio-error');
    assert.equal(p.run('state.session.elapsedSec'), 0);
    assert.equal(p.run('state.session.chapterIndex'), 0);
    assert.equal(p.run('state.session.narrationClips[0].length'), 1);
    assert.equal(requests[1].model, 'gemini-3.8-flash-tts');
    assert.match(p.elements.get('audioRecoveryMessage').textContent, /usage limit.*try again after/i);
    await p.run('resumeSessionAudio()');
    assert.equal(requests.length, 2);
    p.run('voiceRetryAt = 0; state.voiceId = "julian"; voicePlayer.play = async () => {};');
    await p.run('resumeSessionAudio()');
    assert.equal(p.run('state.session.narrationReady'), true);
    assert.deepEqual(requests.map(request => request.text), ['First.', 'Second.', 'Second.']);
    assert.ok(requests.every(request => request.voiceName === 'Vindemiatrix'));
  });

  test(`${path}: a quota error offers soundscape playback that starts without another studio request`, async () => {
    let requests = 0;
    const p = page(path, async () => {
      requests += 1;
      return new Response(JSON.stringify({retryAfterSeconds:120}), {status:429});
    });
    p.run(`state.session.active = true; state.session.studioNarration = true;
      state.session.settings = captureSessionSettings();
      state.session.chapters = [{text:'Read this exact line.', title:'Opening'}];`);
    await p.run('prepareSessionNarration(state.session)');
    assert.match(p.elements.get('playerScriptText').textContent, /try again after/i);
    p.run('beginStudioAlternative("soundscape")');
    assert.equal(p.run('state.session.phase'), 'speaking');
    assert.equal(p.run('state.session.narrationMode'), 'soundscape');
    assert.equal(p.elements.get('playerScriptText').textContent, 'Read this exact line.');
    assert.equal(requests, 1);
  });

  test(`${path}: choosing device narration keeps the same local voice across chapters`, async () => {
    const p = page(path, async () => { throw new Error('No studio request after choosing device narration'); });
    p.run(`var firstVoice = {name:'First', lang:'en-US', localService:true};
      var nextVoice = {name:'Next', lang:'en-US', localService:true};
      var available = [firstVoice]; var spoken = [];
      window.speechSynthesis = {getVoices: () => available, cancel() {}, speak(u) { spoken.push(u.voice); u.onstart(); }};
      var SpeechSynthesisUtterance = function(text) { this.text = text; };
      state.session.active = true; state.session.studioNarration = true; state.session.phase = 'audio-error';
      state.session.settings = captureSessionSettings(); state.session.chapters = [
        {text:'First line.', title:'Opening'}, {text:'Second line.', title:'Closing'}];
      beginStudioAlternative("device");
      available = [nextVoice]; advanceToNextChapter();`);
    assert.equal(p.run('spoken.length'), 2);
    assert.equal(p.run('spoken.every(voice => voice === firstVoice)'), true);
    assert.equal(p.run('state.session.narrationMode'), 'device');
  });

  test(`${path}: delayed silent priming cannot pause narration that has already started`, async () => {
    const p = page(path, async () => {});
    p.run(`var resolvePrime; var pauses = 0; var calls = 0;
      voicePlayer.pause = () => pauses++;
      voicePlayer.play = () => ++calls === 1 ? new Promise(done => {resolvePrime=done}) : Promise.resolve();
      primeVoicePlayback();`);
    await p.run('playInlineAudioData({data:"AAAA",mimeType:"audio/wav"}, () => {})');
    p.run('resolvePrime()'); await Promise.resolve();
    assert.equal(p.run('pauses'), 0);
  });

  test(`${path}: changing script detail requests a fresh script at the chosen level`, async () => {
    const levels = [];
    const p = page(path, async (url, options) => {
      levels.push(JSON.parse(options.body).wordiness);
      return new Response(JSON.stringify({chapters:['One','Two','Three','Four','Five']}));
    });
    p.run('state.intention = "Meeting Jordan tomorrow"');
    await p.run('ensurePersonalScript()');
    p.run('setScriptWordiness("minimal")');
    await p.run('ensurePersonalScript()');
    p.run('setScriptWordiness("wordy")');
    await p.run('ensurePersonalScript()');
    assert.deepEqual(levels, ['average','minimal','wordy']);
  });

  test(`${path}: script detail survives library save and restore`, () => {
    const p = page(path, async () => {});
    p.run(`state.wordiness = 'minimal'; state.session.phase = 'done';
      state.session.chapters = [{text:'A brief practice for Jordan.'}];
      state.session.settings = captureSessionSettings(); saveCompletedSession();
      state.wordiness = 'wordy'; restoreSavedSession(readSessionLibrary()[0].id, false);`);
    assert.equal(p.run('state.wordiness'), 'minimal');
    assert.equal(p.run('getActiveSessionPlan().chapters[0].text'), 'A brief practice for Jordan.');
  });

  test(`${path}: local guidance levels have different amounts of speech at the same duration`, () => {
    const p = page(path, async () => {});
    const count = level => p.run(`state.wordiness = '${level}'; composePersonalChapters().chapters.map(ch => ch.text).join(' ').split(/\\s+/).length`);
    const minimal = count('minimal'), average = count('average'), wordy = count('wordy');
    assert.ok(minimal < average && average < wordy, `${minimal}, ${average}, ${wordy}`);
  });

  test(`${path}: completed sessions survive reload with their exact script and voice`, () => {
    const stored = new Map();
    const p = page(path, async () => {}, stored);
    p.run(`state.intention = 'Tomorrow I am talking with Jordan about the missed deadline.';
      state.voiceId = 'julian';
      state.session.phase = 'done';
      state.session.chapters = [{text:'Let the thought of your conversation with Jordan pass with this breath.', title:'Jordan', roleTag:'Opening', pauseSec:12}];
      state.session.totalEstSec = 180;
      state.session.settings = captureSessionSettings();
      document.getElementById('sessionSaveTitle').value = 'Before talking with Jordan';`);
    assert.equal(p.run('saveCompletedSession()'), true);
    const entries = p.run('readSessionLibrary()');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].title, 'Before talking with Jordan');
    const reloaded = page(path, async () => {}, stored);
    reloaded.run(`restoreSavedSession(${JSON.stringify(entries[0].id)}, false)`);
    assert.equal(reloaded.run('state.voiceId'), 'julian');
    assert.equal(reloaded.run('getActiveSessionPlan().chapters[0].text'), 'Let the thought of your conversation with Jordan pass with this breath.');
    assert.equal(reloaded.run('state.intention'), 'Tomorrow I am talking with Jordan about the missed deadline.');
  });

  test(`${path}: a full library storage never reports a session as saved`, () => {
    const p = page(path, async () => {});
    p.run(`state.session.phase = 'done'; state.session.chapters = [{text:'Breathe.'}];
      localStorage.setItem = () => { throw new Error('QuotaExceeded'); };`);
    assert.equal(p.run('saveCompletedSession()'), false);
    assert.equal(p.run('Boolean(state.session.savedId)'), false);
  });

  test(`${path}: saving keeps the mix settled on during playback and the note used to write it`, () => {
    const p = page(path, async () => {});
    p.run(`state.intention = 'My original note'; state.session.settings = captureSessionSettings();
      state.session.chapters = [{text:'My original practice'}];
      state.intention = 'A different note typed in Studio'; state.voiceId = 'julian';
      state.voiceVolume = 55; state.sounds[0].volume = 25; state.sounds[0].enabled = false;
      finishSession(); saveCompletedSession();`);
    const saved = p.run('readSessionLibrary()[0]');
    assert.equal(saved.settings.intention, 'My original note');
    assert.equal(saved.settings.voiceId, 'julian');
    assert.equal(saved.settings.voiceVolume, 55);
    assert.equal(saved.settings.sounds[0].volume, 25);
    assert.equal(saved.settings.sounds[0].enabled, false);
  });

  test(`${path}: long personal chapters shorten silence instead of adding template-length pauses`, () => {
    const p = page(path, async () => {});
    p.run(`state.intention = 'A detailed note'; state.durationMin = 3;
      state.aiScriptCacheKey = currentScriptCacheKey();
      state.aiGeneratedChapters = Array.from({length:4}, () => Array(75).fill('breathe').join(' '));`);
    const total = p.run('getActiveSessionPlan().chapters.reduce((n,ch) => n + ch.pauseSec, 0)');
    assert.ok(total < 60, `Expected less silence around longer chapters; got ${total}s`);
  });

  test(`${path}: reviewing a note automatically writes a specific script once`, async () => {
    let requests = 0;
    const chapters = ['Let your conversation with Jordan wait while your jaw softens.', 'Notice the tightness before tomorrow’s deadline.', 'You can care about the project without rehearsing it now.', 'Return to this exhale when Jordan comes to mind.', 'Carry one steady breath into tomorrow.'];
    const p = page(path, async (url, options) => {
      if (url === '/api/status') return new Response('{"configured":true}');
      assert.equal(url, '/api/script'); requests++;
      const body = JSON.parse(options.body);
      assert.equal(body.intention, 'Tomorrow I must talk with Jordan about a missed project deadline. My jaw is tight.');
      assert.equal(body.chapterCount, 5);
      return new Response(JSON.stringify({chapters, text:JSON.stringify(chapters)}));
    });
    p.run(`state.intention = 'Tomorrow I must talk with Jordan about a missed project deadline. My jaw is tight.'; switchView('script');`);
    await p.run('ensurePersonalScript()');
    assert.equal(requests, 1);
    assert.equal(p.run('getActiveSessionPlan().chapters[0].text'), chapters[0]);
    assert.equal(p.run('state.scriptStatus'), 'ready');
  });

  test(`${path}: late script generation cannot overwrite a newer personal note`, async () => {
    const pending = new Map();
    const p = page(path, (url, options) => new Promise(resolve => pending.set(JSON.parse(options.body).intention, resolve)));
    p.run('state.intention = "Meeting with Jordan tomorrow"');
    const first = p.run('ensurePersonalScript()');
    p.run('state.intention = "Missing my dog Bailey tonight"');
    const second = p.run('ensurePersonalScript()');
    pending.get('Missing my dog Bailey tonight')(new Response(JSON.stringify({chapters:['Bailey','A breath for Bailey','Remembering Bailey','Missing Bailey','Resting with Bailey']})));
    await second;
    pending.get('Meeting with Jordan tomorrow')(new Response(JSON.stringify({chapters:['Jordan','A meeting','A deadline','Tomorrow','Goodbye']})));
    await first;
    assert.equal(p.run('getActiveSessionPlan().chapters[0].text'), 'Bailey');
  });

  test(`${path}: restoring a saved script takes precedence over in-flight generation for the same note`, async () => {
    let resolve;
    const p = page(path, () => new Promise(done => { resolve = done; }));
    p.run(`state.intention = 'Meeting Jordan tomorrow'; state.session.phase = 'done';
      state.session.chapters = Array.from({length:5}, () => ({text:'Exact saved practice for Jordan', pauseSec:4}));
      saveCompletedSession();`);
    const pending = p.run('ensurePersonalScript()');
    p.run('restoreSavedSession(readSessionLibrary()[0].id, false)');
    resolve(new Response(JSON.stringify({chapters:['New AI words','New AI words','New AI words','New AI words','New AI words']})));
    await pending;
    assert.equal(p.run('getActiveSessionPlan().chapters[0].text'), 'Exact saved practice for Jordan');
  });

  test(`${path}: selecting the next voice preserves the active chapter completion`, () => {
    const p = page(path, async () => {});
    p.run(`state.session.active = true;
      voicePlayer.onended = () => 'chapter complete';
      var choiceClick;
      var choice = { dataset: { selectVoice: 'julian' }, addEventListener(type, fn) { choiceClick = fn; } };
      document.getElementById('voiceGrid').querySelectorAll = selector => selector === '[data-select-voice]' ? [choice] : [];
      renderVoiceGrid(); choiceClick();`);
    assert.equal(p.run('state.voiceId'), 'julian');
    assert.equal(p.run('typeof voicePlayer.onended'), 'function');
  });

  test(`${path}: previewing a voice selects it for the meditation`, async () => {
    const requests = [];
    const p = page(path, async (url, options) => {
      requests.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ data: 'JULIAN', mimeType: 'audio/wav' }));
    });
    await p.run('toggleVoicePreview("julian")');
    assert.equal(p.run('state.voiceId'), 'julian');
    assert.equal(requests[0].voiceName, 'Algieba');
    assert.match(p.elements.get('studioFooterSummary').textContent, /Julian/);
  });

  test(`${path}: a late preview cannot replace the most recently chosen voice`, async () => {
    const pending = new Map();
    const p = page(path, (url, options) => new Promise(resolve => {
      pending.set(JSON.parse(options.body).voiceName, resolve);
    }));
    const first = p.run('toggleVoicePreview("clara")');
    const second = p.run('toggleVoicePreview("julian")');
    pending.get('Algieba')(new Response(JSON.stringify({ data: 'JULIAN', mimeType: 'audio/wav' })));
    await second;
    pending.get('Vindemiatrix')(new Response(JSON.stringify({ data: 'CLARA', mimeType: 'audio/wav' })));
    await first;
    assert.equal(p.elements.get('voicePlayer').src, 'data:audio/wav;base64,JULIAN');
    assert.equal(p.run('state.previewingVoiceId'), 'julian');
  });

  test(`${path}: cached studio narration plays through the chapter handoff with the same voice`, async () => {
    const requests = [];
    const p = page(path, async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      if (requests.length === 2) return new Response('{}', {status:503});
      return new Response(JSON.stringify({data:'AAAA',mimeType:'audio/wav',model:'gemini-3.8-flash-tts'}));
    });
    p.run(`state.session.active = true; state.session.studioNarration = true;
      state.session.settings = captureSessionSettings();
      state.session.chapters = [{text:'First.',title:'Opening',pauseSec:5},{text:'Second.',title:'Closing',pauseSec:5}];`);
    await p.run('prepareSessionNarration(state.session)');
    assert.equal(p.run('state.session.narrationReady'), true);
    assert.equal(p.run('state.session.phase'), 'ready-voice');
    assert.deepEqual(requests.map(r=>r.text), ['First.','Second.','Second.']);
    assert.equal(requests[1].model, 'gemini-3.8-flash-tts');
    assert.equal(requests[2].model, 'gemini-3.8-flash-tts');
    assert.ok(requests.every(r=>r.voiceName === 'Vindemiatrix'));

    await p.run('playCurrentChapter()');
    assert.equal(p.run('state.session.phase'), 'speaking');
    p.elements.get('voicePlayer').onended();
    assert.equal(p.run('state.session.phase'), 'pausing');
    p.run('state.voiceId = "julian"; advanceToNextChapter()');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(p.run('state.session.chapterIndex'), 1);
    assert.equal(p.run('state.session.phase'), 'speaking');
    assert.equal(requests.length, 3);
  });

  test(`${path}: a browser interruption automatically resumes the prepared clip`, async () => {
    const p = page(path, async () => { throw new Error('Playback must use prepared audio'); });
    p.run(`state.session.active=true; state.session.phase='speaking'; state.session.narrationReady=true;
      voicePlayer.paused=true; voicePlayer.ended=false; var attempts=0;
      voicePlayer.play=async () => {attempts++;};`);
    p.elements.get('voicePlayer').listeners.pause();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(p.run('attempts'), 1);
    assert.equal(p.run('state.session.phase'), 'speaking');
  });

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
