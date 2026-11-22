import { createHmac, timingSafeEqual } from 'node:crypto';
import * as memberStore from './member-store.js';
import { stripeSettings } from './stripe-billing.js';

const kinds = ['welcome', 'started', 'reminder', 'ended', 'offer'];
const memberId = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const emailAddress = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const endDate = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC',
});

export function emailConfig(env = process.env) {
  const mode = env.STILLNESS_EMAIL_MODE;
  const key = env.RESEND_API_KEY?.trim();
  const from = env.STILLNESS_EMAIL_FROM?.trim();
  const replyTo = env.STILLNESS_EMAIL_REPLY_TO?.trim();
  const secret = env.CRON_SECRET?.trim();
  const postalAddress = env.STILLNESS_EMAIL_POSTAL_ADDRESS?.trim();
  const recipients = mode === 'beta'
    ? [...new Set((env.STILLNESS_EMAIL_BETA_RECIPIENTS || '').split(',').map(email => email.trim().toLowerCase()).filter(Boolean))]
    : null;
  if (!['beta', 'launch'].includes(mode) || !key || !from || !emailAddress.test(replyTo || '') || !secret || secret.length < 32 ||
      (recipients && (!recipients.length || recipients.some(email => !emailAddress.test(email))))) return null;
  let origin;
  try {
    const parsed = new URL(env.STILLNESS_EMAIL_ORIGIN || '');
    if (parsed.protocol !== 'https:' || parsed.href !== parsed.origin + '/') return null;
    origin = parsed.origin;
  } catch {
    return null;
  }
  let offersEnabled = false;
  if (mode === 'launch' && postalAddress) {
    try {
      offersEnabled = stripeSettings(env).live === true;
    } catch {
      // Account and trial notices continue while checkout is unavailable.
    }
  }
  return { mode, key, from, replyTo, secret, recipients, origin, offersEnabled, postalAddress };
}

export function secureMatch(actual, expected) {
  if (typeof actual !== 'string' || Buffer.byteLength(actual) !== Buffer.byteLength(expected)) return false;
  return timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

export function emailToken(userId, secret) {
  const signature = createHmac('sha256', secret).update('stillness/unsubscribe/' + userId).digest('base64url');
  return userId + '.' + signature;
}

export function tokenMember(token, secret) {
  if (typeof token !== 'string' || token.length !== 80) return null;
  const userId = token.slice(0, 36);
  return memberId.test(userId) && secureMatch(token, emailToken(userId, secret)) ? userId : null;
}

export function emailMessage(job, config) {
  const url = config.origin + '/';
  const profile = url + '?view=profile';
  const hello = job.name ? 'Hi ' + job.name.replace(/[\r\n]/g, ' ') + ',' : 'Hi there,';
  const ends = job.trial_ends_at ? endDate.format(new Date(job.trial_ends_at)) + ' UTC' : '';
  const seconds = Math.max(0, job.remaining_seconds || 0);
  const timeLeft = Math.floor(seconds / 60) + ' min ' + (seconds % 60) + ' sec';
  const messages = {
    welcome: ['Welcome to Stillness', 'When you’re ready, set aside a few quiet minutes. Start your free trial in Stillness.\n' + url],
    started: ['Your Stillness trial has started', 'You have 15 narrated minutes over 10 days. Your trial ends on ' + ends +
      '. No card is needed and you won’t be charged automatically.\n\nStart a session\n' + url],
    reminder: ['Your Stillness trial ends soon', 'Your trial ends on ' + ends + '. You have ' + timeLeft +
      ' of narrated time left. Access to your saved sessions pauses when the trial ends.\n\nOpen Stillness\n' + url],
    ended: ['Your Stillness trial has ended', 'Your trial has ended and access to your saved sessions is paused. No payment was taken.' +
      (config.mode === 'beta' ? '\n\nFeel free to reply with feedback about how your sessions went.' : '')],
    offer: ['Continue with Stillness', 'If you’d like to keep using Stillness and regain access to your saved sessions, you can view the membership plan from your profile.\n' + profile],
  };
  const [subject, body] = messages[job.kind];
  const message = { from: config.from, to: [job.email], reply_to: config.replyTo, subject, text: hello + '\n\n' + body + '\n\nStillness' };
  if (job.kind === 'offer') {
    const unsubscribe = url + 'api/trial-email?token=' + emailToken(job.user_id, config.secret);
    message.text += '\n\nUnsubscribe from Stillness offers\n' + unsubscribe + '\n\n' + config.postalAddress;
    message.headers = { 'List-Unsubscribe': '<' + unsubscribe + '>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
  }
  return message;
}

export async function deliverTrialEmails({ config, userId = null, kinds: requestedKinds, store = memberStore, request = fetch }) {
  const eligibleKinds = requestedKinds || kinds.filter(kind => kind !== 'offer' || config.offersEnabled);
  const results = { sent: 0, deferred: 0, failed: 0 };
  for (let count = 0; count < (userId ? 1 : 20); count++) {
    const job = await store.claimTrialEmail({ userId, kinds: eligibleKinds, recipients: config.recipients });
    if (!job) break;
    let response;
    try {
      response = await request('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + config.key,
          'Content-Type': 'application/json',
          'Idempotency-Key': 'stillness/' + job.user_id + '/' + job.kind,
        },
        body: JSON.stringify(emailMessage(job, config)),
        signal: AbortSignal.timeout(3500),
      });
    } catch {
      results.deferred++;
      break;
    }
    if (response.status >= 500 || response.status === 408 || response.status === 409) {
      // An uncertain response may already have been accepted by the provider.
      results.deferred++;
      break;
    }
    const outcome = response.ok ? 'sent' : response.status === 429 ? 'retry' : 'failed';
    await store.finishTrialEmail({ userId: job.user_id, kind: job.kind, attempts: job.attempts, outcome });
    if (outcome === 'sent') results.sent++;
    if (outcome === 'retry') {
      results.deferred++;
      break;
    }
    if (outcome === 'failed') {
      results.failed++;
      break;
    }
  }
  return results;
}
