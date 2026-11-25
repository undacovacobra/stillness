import test from 'node:test';
import assert from 'node:assert/strict';
import { renderEmailTemplate } from '../lib/trial-email-templates.js';
import { emailMessage } from '../lib/trial-email.js';
import { geminiBillingUrl } from '../lib/owner-alerts.js';

const origin = 'https://stillness.example';

test('member email keeps custom text and escapes names and markup in the branded version', () => {
  const message = renderEmailTemplate({
    kind: 'welcome',
    name: 'A&B <friend>',
    template: { subject: 'A <quiet> moment', body: 'My <custom> copy\n{{ app_url }}' },
  }, { mode: 'launch', origin });
  assert.match(message.text, /Hi A&B <friend>/);
  assert.match(message.text, /My <custom> copy/);
  assert.match(message.html, /Hi A&amp;B &lt;friend&gt;/);
  assert.match(message.html, /My &lt;custom&gt; copy/);
  assert.match(message.html, /href="https:\/\/stillness\.example\/"/);
  assert.match(message.html, /\/design\/dusk-water\.jpg/);
});

test('offers keep the same authenticated unsubscribe URL in HTML, text and the header', () => {
  const config = { origin, mode: 'launch', secret: 's'.repeat(40), postalAddress: 'Address <line>' };
  const message = emailMessage({ kind: 'offer', user_id: '00000000-0000-0000-0000-000000000001' }, config);
  const url = message.headers['List-Unsubscribe'].slice(1, -1);
  assert.ok(message.html.includes('href="' + url + '"'));
  assert.ok(message.text.includes(url));
  assert.match(message.html, /Address &lt;line&gt;/);
  assert.match(message.html, /\?view=profile/);
});

test('owner balance navigation accepts only the configured AI Studio billing account', () => {
  const url = 'https://aistudio.google.com/u/1/billing?billing=ABCDEF-123456-UVWXYZ';
  assert.equal(geminiBillingUrl({ STILLNESS_GEMINI_BILLING_URL: url }), url);
  for (const candidate of ['https://example.com/billing', 'https://aistudio.google.com@other.example/billing', 'https://aistudio.google.com/billing']) {
    assert.equal(geminiBillingUrl({ STILLNESS_GEMINI_BILLING_URL: candidate }), 'https://aistudio.google.com/projects');
  }
});
