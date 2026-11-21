import test from 'node:test';
import assert from 'node:assert/strict';
import script from '../lib/gemini-script.js';

const intention = '  Maya said "I need space" after our argument on Tuesday.\nMy review with Luis is Friday at 9; my chest feels tight. I hope to listen without defending myself.  ';
const request = { intention, style: 'Loving-kindness', durationMin: 10, chapterCount: 3 };
const chapters = ['Feel the support beneath you as you remember Tuesday with Maya.',
  'Let kindness meet the tightness in your chest, without deciding what Maya will choose.',
  'Before Friday at 9 with Luis, return to your wish to listen without defending yourself.'];

function response() {
  return { code: 200, status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; } };
}

function configure(t) {
  const original = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-only-key';
  t.after(() => {
    if (original === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = original;
  });
}

function provider(text, extra = {}) {
  return new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP',
    content: { role: 'model', parts: [{ text }] }, ...extra }] }), { status: 200 });
}

test('structured requests preserve the complete note and return validated chapters', async t => {
  configure(t);
  let outbound;
  let url;
  t.mock.method(globalThis, 'fetch', async (target, options) => {
    url = target;
    outbound = JSON.parse(options.body);
    assert.ok(options.signal instanceof AbortSignal);
    return provider(JSON.stringify(chapters));
  });
  const result = response();
  await script({ method: 'POST', body: request }, result);
  assert.equal(result.code, 200);
  assert.deepEqual(result.body.chapters, chapters);
  assert.equal(result.body.text, JSON.stringify(chapters));
  assert.match(url, /\/gemini-3\.5-flash-lite:generateContent$/);
  assert.equal(result.body.model, 'gemini-3.5-flash-lite');
  assert.deepEqual(JSON.parse(outbound.contents[0].parts[0].text), { ...request, wordiness: 'average' });
  assert.equal(outbound.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(outbound.generationConfig.responseJsonSchema, {
    type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 3
  });
  const instructions = outbound.systemInstruction.parts.map(p => p.text).join('\n');
  assert.match(instructions, /every chapter/i);
  assert.match(instructions, /named people/i);
  assert.match(instructions, /false reassurance/i);
  assert.match(instructions, /Loving.kindness|chosen style/i);
  assert.equal(JSON.stringify(result.body).includes('test-only-key'), false);
});

for (const [wordiness, wordRange] of [['wordy', '700 to 850'], ['average', '350 to 500'], ['minimal', '100 to 180']]) {
  test(`${wordiness} requests give the writer the chosen guidance level and word budget`, async t => {
    configure(t);
    let payload;
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      payload = JSON.parse(options.body);
      return provider(JSON.stringify(chapters));
    });
    const result = response();
    await script({ method:'POST', body:{...request, wordiness} }, result);
    assert.equal(result.code, 200);
    const data = JSON.parse(payload.contents[0].parts[0].text);
    assert.equal(data.wordiness, wordiness);
    assert.equal(data.intention, intention);
    assert.ok(payload.systemInstruction.parts[0].text.includes(wordRange));
  });
}

test('unsupported guidance levels are rejected before contacting the provider', async t => {
  configure(t);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return provider(JSON.stringify(chapters)); });
  const result = response();
  await script({ method:'POST', body:{...request, wordiness:'unlimited'} }, result);
  assert.equal(result.code, 400);
  assert.equal(calls, 0);
});

for (const [label, invalid] of [
  ['malformed JSON', '["unfinished'], ['empty array', '[]'],
  ['empty chapter', '["One", "   ", "Three"]'],
  ['non-string chapter', '["One", {"text":"Two"}, "Three"]'],
  ['wrong chapter count', '["One", "Two"]'],
  ['object wrapper', '{"chapters":["One","Two","Three"]}']
]) {
  test(`${label} from a provider is rejected and the fallback response is validated`, async t => {
    configure(t);
    const called = [];
    t.mock.method(globalThis, 'fetch', async url => {
      called.push(url);
      return provider(called.length === 1 ? invalid : JSON.stringify(chapters));
    });
    const result = response();
    await script({ method: 'POST', body: request }, result);
    assert.equal(result.code, 200);
    assert.deepEqual(result.body.chapters, chapters);
    assert.equal(called.length, 2);
    assert.notEqual(called[0], called[1]);
  });
}

test('invalid content from every provider fails without returning an unusable script', async t => {
  configure(t);
  t.mock.method(globalThis, 'fetch', async () => provider('[" "]'));
  const result = response();
  await script({ method: 'POST', body: request }, result);
  assert.equal(result.code, 502);
  assert.equal(result.body.chapters, undefined);
  assert.equal(result.body.text, undefined);
});

test('multipart model output skips thinking content and joins the actual JSON', async t => {
  configure(t);
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [
      { thought: true, text: 'Do not return this internal text.' },
      { text: '["One",' }, { text: '"Two", "Three"]' }
    ] } }]
  })));
  const result = response();
  await script({ method: 'POST', body: request }, result);
  assert.equal(result.code, 200);
  assert.deepEqual(result.body.chapters, ['One', 'Two', 'Three']);
});

test('a truncated provider response is retried even when its JSON is parseable', async t => {
  configure(t);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => provider(JSON.stringify(chapters),
    { finishReason: ++calls === 1 ? 'MAX_TOKENS' : 'STOP' }));
  const result = response();
  await script({ method: 'POST', body: request }, result);
  assert.equal(result.code, 200);
  assert.equal(calls, 2);
});

test('a provider that does not support response schemas is retried without schema constraints', async t => {
  configure(t);
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    sent.push({ url, body: JSON.parse(options.body) });
    return sent.length === 1
      ? new Response(JSON.stringify({ error: { message: 'responseJsonSchema is not supported for this model' } }), { status: 400 })
      : provider(JSON.stringify(chapters));
  });
  const result = response();
  await script({ method: 'POST', body: request }, result);
  assert.equal(result.code, 200);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].url, sent[1].url);
  assert.ok(sent[0].body.generationConfig.responseJsonSchema);
  assert.equal(sent[1].body.generationConfig?.responseJsonSchema, undefined);
  assert.deepEqual(sent[0].body.contents, sent[1].body.contents);
  assert.deepEqual(result.body.chapters, chapters);
});

for (const [label, body] of [
  ['empty note', { ...request, intention: '  ' }],
  ['missing note', { ...request, intention: undefined }],
  ['non-string note', { ...request, intention: 42 }],
  ['oversized note', { ...request, intention: 'a'.repeat(12001) }],
  ['empty style', { ...request, style: '' }],
  ['oversized style', { ...request, style: 'a'.repeat(201) }],
  ['zero duration', { ...request, durationMin: 0 }],
  ['excessive duration', { ...request, durationMin: 121 }],
  ['non-numeric duration', { ...request, durationMin: '10' }],
  ['zero chapters', { ...request, chapterCount: 0 }],
  ['fractional chapters', { ...request, chapterCount: 2.5 }],
  ['excessive chapters', { ...request, chapterCount: 25 }],
  ['legacy prompt alongside invalid structured fields', { ...request, intention: '', prompt: 'bypass' }],
  ['null body', null], ['array body', []]
]) {
  test(`bad input: ${label} fails before any provider request`, async t => {
    configure(t);
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => { calls++; return provider(JSON.stringify(chapters)); });
    const result = response();
    await script({ method: 'POST', body }, result);
    assert.equal(result.code, 400);
    assert.equal(calls, 0);
  });
}
