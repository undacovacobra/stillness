import { createHmac, timingSafeEqual } from 'node:crypto';
import * as memberStore from './member-store.js';
import { stripeSettings } from './stripe-billing.js';
import { renderEmailTemplate } from './trial-email-templates.js';

const kinds = ['welcome', 'started', 'reminder', 'ended', 'offer'];
const memberId = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const emailAddress = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
  const unsubscribe = job.kind === 'offer'
    ? config.origin + '/api/trial-email?token=' + emailToken(job.user_id, config.secret) : '';
  const message = {
    from: config.from, to: [job.email], reply_to: config.replyTo,
    ...renderEmailTemplate(job, config,
      unsubscribe ? { unsubscribeUrl: unsubscribe, postalAddress: config.postalAddress } : undefined),
  };
  if (unsubscribe) {
    message.headers = { 'List-Unsubscribe': '<' + unsubscribe + '>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
  }
  return message;
}

export async function deliverTrialEmails({ config, userId = null, kinds: requestedKinds, store = memberStore, request = fetch }) {
  const eligibleKinds = requestedKinds || kinds.filter(kind => kind !== 'offer' || config.offersEnabled);
  const results = { sent: 0, deferred: 0, failed: 0 };
  for (let count = 0; count < (userId ? 1 : 20); count++) {
    const job = await store.claimTrialEmail({ userId, kinds: eligibleKinds, recipients: config.recipients, mode: config.mode });
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
