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

test('both entry pages offer Google and email, with a separate card-free trial action', () => {
  for (const file of ['../index.html', '../public/index.html']) {
    const html = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(html, /id="memberOAuthGoogle"[^>]*disabled/);
    assert.match(html, /id="memberAuthForm"/);
    assert.match(html, /id="memberStartTrial"[^>]*>Start 10-day trial/);
    assert.match(html, /id="memberSubscribe"[^>]*data-billing="subscribe-paid"[^>]*>Subscribe · \$11\.99\/month/);
    assert.match(html, /No card required/);
    assert.doesNotMatch(html, /memberOAuthApple|apple-sign-in|free with a card/i);
  }
});

test('both entry pages keep the card-free trial action on welcome as well as Profile', () => {
  for (const file of ['../index.html', '../public/index.html']) {
    const html = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(html, /id="memberWelcomeTrial"[^>]*hidden[\s\S]*?id="memberWelcomeStartTrial"[^>]*>Start 10-day trial/);
    assert.match(html, /id="memberStartTrial"[^>]*>Start 10-day trial/);
  }
});

test('a saved session cannot be opened after library access is revoked', () => {
  const identity = { current: 'first' };
  const { data, run } = browserStorage(identity);
  const entry = {id:'locked', title:'Private', settings:{intention:'Personal'}, chapters:[{text:'Rest.'}]};
  const key = 'stillness_session_library_v1:first';
  data.set(key, JSON.stringify([entry]));
  assert.equal(run('readSessionLibrary().length'), 1);
  identity.current = null;
  assert.equal(run('restoreSavedSession("locked")'), false);
  assert.equal(run('readSessionLibrary().length'), 0);
  assert.equal(JSON.parse(data.get(key))[0].id, 'locked');
});
