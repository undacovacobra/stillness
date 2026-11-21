import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function browserStorage(userId) {
  const source = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
    .match(/<script>\s*([\s\S]*?)<\/script>/)[1];
  const data = new Map();
  const document = { getElementById() {
    return { addEventListener() {}, value: '', classList: { add() {}, remove() {} } };
  } };
  const window = {
    addEventListener() {},
    StillnessMembership: {
      libraryKey() { return userId.current ? `stillness_session_library_v1:${userId.current}` : null; }
    }
  };
  const context = vm.createContext({
    document, window, location: { protocol: 'https:' },
    localStorage: { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value) }
  });
  vm.runInContext(source, context);
  return { data, run: code => vm.runInContext(code, context) };
}

test('both entry pages conceal the meditation workspace while loading the member session', () => {
  for (const file of ['../index.html', '../public/index.html']) {
    const html = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(html, /id="memberStudio"[^>]+hidden/);
    assert.match(html, /id="memberLogin"/);
    assert.match(html, /src="\.\/(?:public\/)?membership\.js" defer/);
  }
});

test('the membership clone reads and writes libraries only for the signed-in account', () => {
  const identity = { current: 'first' };
  const { data, run } = browserStorage(identity);
  const entry = { id: 'saved-1', title: 'My private session', settings: { intention: 'Personal' }, chapters: [{ text: 'Breathe slowly.' }] };
  data.set('stillness_session_library_v1', JSON.stringify([entry]));
  assert.equal(run('readSessionLibrary().length'), 0);
  data.set('stillness_session_library_v1:first', JSON.stringify([entry]));
  assert.equal(run('readSessionLibrary()[0].title'), 'My private session');
  identity.current = 'second';
  assert.equal(run('readSessionLibrary().length'), 0);
  identity.current = null;
  assert.equal(run('readSessionLibrary().length'), 0);
});
