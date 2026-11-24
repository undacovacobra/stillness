import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const script = readFileSync(new URL('../public/share-practice.js', import.meta.url), 'utf8');
const canonical = 'https://trystillness.vercel.app/meditations/sleep-racing-mind';
const title = 'Guided sleep meditation';

function init(navigator) {
  const status = { textContent: '' };
  const field = { hidden: true, select() { this.selected = true; } };
  const button = { addEventListener(_event, handler) { this.click = handler; } };
  const panel = { hidden: true, querySelector(selector) {
    return { button, '[role="status"]': status, input: field }[selector];
  } };
  const document = { querySelector(selector) {
    return {
      '[data-share-practice]': panel,
      'link[rel="canonical"]': { href: canonical },
      'meta[property="og:title"]': { content: title }
    }[selector];
  } };
  runInNewContext(script, { navigator, document });
  assert.equal(panel.hidden, false);
  return { click: () => button.click(), status, field };
}

test('native sharing uses the public canonical practice link', async () => {
  const calls = [];
  const { click, status } = init({ share: async ({ url, title }) => calls.push([url, title]) });
  await click();
  assert.deepEqual(calls, [[canonical, title]]);
  assert.equal(status.textContent, '');
});

test('desktop sharing copies the public link and confirms it', async () => {
  let copied;
  const { click, status, field } = init({ clipboard: { writeText: async value => { copied = value; } } });
  await click();
  assert.equal(copied, canonical);
  assert.equal(field.hidden, true);
  assert.equal(status.textContent, 'Link copied.');
});

test('dismissing native sharing respects the cancellation', async () => {
  let copied = false;
  const { click, status } = init({
    share: async () => { throw new DOMException('Canceled', 'AbortError'); },
    clipboard: { writeText: async () => { copied = true; } }
  });
  await click();
  assert.equal(copied, false);
  assert.equal(status.textContent, '');
});

test('a blocked clipboard leaves a selected, copyable link', async () => {
  const { click, status, field } = init({});
  await click();
  assert.equal(field.hidden, false);
  assert.equal(field.value, canonical);
  assert.equal(field.selected, true);
  assert.equal(status.textContent, 'Copy the link above.');
});
