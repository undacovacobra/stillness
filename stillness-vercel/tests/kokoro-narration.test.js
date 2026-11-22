import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const window = {};
vm.runInNewContext(readFileSync(new URL('../public/kokoro-narration.js', import.meta.url), 'utf8'), { window, AbortController });
const { create } = window.StillnessKokoro;

test('Kokoro loads the opening first, buffers across chapter boundaries and reuses prepared audio', async () => {
  const texts = ['Settle in.', 'Feel your feet.', 'Let your shoulders rest.', 'Come back when ready.', 'Finish.'];
  const requested = [];
  let busy = false;
  const buffer = create(texts.map(text => ({ text })), async (text, signal) => {
    assert.equal(busy, false);
    busy = true;
    signal.throwIfAborted();
    requested.push(text);
    await Promise.resolve();
    busy = false;
    return text;
  });

  assert.equal(await buffer.clip(0, 0), texts[0]);
  assert.deepEqual(requested, [texts[0]]);
  buffer.prefetch(0, 0);
  assert.equal(await buffer.clip(3, 0), texts[3]);
  assert.deepEqual(requested, texts.slice(0, 4));
  assert.equal(await buffer.clip(1, 0), texts[1]);
  assert.equal(requested.length, 4);
  buffer.stop();
  await assert.rejects(buffer.clip(4, 0), { name: 'AbortError' });
});

test('oversized words are split into bounded Kokoro clips without dropping content', async () => {
  const text = 'a'.repeat(800);
  const buffer = create([{ text }], async part => part);
  const clips = await Promise.all(Array.from({ length: buffer.count(0) }, (_, index) => buffer.clip(0, index)));
  assert.ok(clips.every(clip => clip.length <= 240));
  assert.equal(clips.join(''), text);
});
