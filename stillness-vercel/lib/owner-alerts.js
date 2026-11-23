import { waitUntil } from '@vercel/functions';
import * as memberStore from './member-store.js';

const billingUrl = 'https://aistudio.google.com/billing';
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

export function ownerAlertConfig(env = process.env) {
  const key = env.STILLNESS_OWNER_RESEND_API_KEY?.trim();
  const to = (env.MEMBER_ADMIN_EMAILS || '').split(',')[0].trim().toLowerCase();
  if (!key || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return null;
  const origin = env.STILLNESS_EMAIL_ORIGIN || 'https://stillness-members.vercel.app';
  return { key, to, origin };
}

export function creditForecast(data) {
  // Three cents per rendered minute includes room for Gemini's scheduled price increase.
  // A cent per script request allows for script input, output, and occasional retries.
  const estimatedUsage = (voiceSeconds, scripts) => Math.ceil(voiceSeconds / 20 + scripts);
  const recorded = data.cents === null ? null : Number(data.cents);
  const available = recorded === null ? null
    : Math.max(0, recorded - estimatedUsage(data.voice_since, data.scripts_since));
  const recent = estimatedUsage(data.voice_week, data.scripts_week);
  const allowances = estimatedUsage(data.premium_seconds, Math.ceil(data.premium_seconds / 300));
  const target = Math.ceil(Math.max(recent, allowances) * 1.25) + 100;
  return {
    recorded, available, target, observedAt: data.observed_at, members: Number(data.active_members),
    shortfall: available === null ? null : Math.max(0, target - available),
  };
}

export function backgroundOwnerAlert(task) {
  waitUntil(task().catch(() => console.warn('Stillness owner notification is pending.')));
}

export async function checkOwnerCredit({ config, store = memberStore, now = new Date() }) {
  const forecast = creditForecast(await store.ownerCreditStatus());
  if (!config || !forecast.shortfall) return forecast;
  const id = 'credit/' + now.toISOString().slice(0, 10);
  await store.queueOwnerAlert({ id, kind: 'credit', details: forecast });
  return forecast;
}

export async function notifyGeminiDepleted({ config = ownerAlertConfig(), store = memberStore, now = new Date() } = {}) {
  if (!config) return;
  const id = 'depleted/' + now.toISOString().slice(0, 10);
  await store.queueOwnerAlert({ id, kind: 'depleted' });
  await deliverOwnerAlerts({ config, id, store });
}

function message(job, config) {
  const admin = config.origin + '/';
  const subject = {
    trial: 'Stillness · A free trial started',
    credit: 'Stillness · Add Gemini credits soon',
    depleted: 'Stillness · Gemini credits are depleted',
    test: 'Stillness · Owner alerts are connected',
  }[job.kind];
  const detail = job.details;
  const text = {
    trial: 'A member started a 10-day free trial. See the new trial in Stillness under Admin → Members.\n\n' + admin,
    credit: job.kind === 'credit'
      ? 'Estimated Gemini credit remaining: ' + usd.format(detail.available / 100) +
        '\nCredit target for ' + detail.members + ' active accounts and recent usage: ' + usd.format(detail.target / 100) +
        '\nEstimated shortfall: ' + usd.format(detail.shortfall / 100) +
        '\n\nCheck the actual balance and add credits in Google AI Studio. After topping up, update the balance in Stillness under Admin → Alerts.\n\n' +
        billingUrl + '\n' + admin : '',
    depleted: 'Google returned a prepaid-credit error while preparing a session. Add credits in AI Studio, then update the balance in Stillness under Admin → Alerts.\n\n' +
      billingUrl + '\n' + admin,
    test: 'Stillness can send trial and Gemini credit alerts to this address.\n\n' + admin,
  }[job.kind];
  return { from: 'Stillness <onboarding@resend.dev>', to: [config.to], subject, text };
}

export async function deliverOwnerAlerts({ config, id = null, store = memberStore, request = fetch }) {
  if (!config) return { accepted: 0, failed: 0, deferred: 0 };
  const stats = { accepted: 0, failed: 0, deferred: 0 };
  for (let count = 0; count < (id ? 1 : 15); count++) {
    const job = await store.claimOwnerAlert(id);
    if (!job) break;
    // Keep an already queued warning from emailing after the owner has topped up.
    if (job.kind === 'credit' && !creditForecast(await store.ownerCreditStatus()).shortfall) {
      await store.finishOwnerAlert({ ...job, outcome: 'accepted' });
      continue;
    }
    let outcome;
    try {
      const response = await request('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + config.key,
          'Content-Type': 'application/json',
          'Idempotency-Key': 'stillness-owner/' + job.id,
        },
        body: JSON.stringify(message(job, config)),
        signal: AbortSignal.timeout(3500),
      });
      outcome = response.ok ? 'accepted' : response.status >= 500 || [408, 409, 429].includes(response.status) ? 'retry' : 'failed';
    } catch {
      outcome = 'retry';
    }
    await store.finishOwnerAlert({ ...job, outcome });
    if (outcome === 'retry') {
      stats.deferred++;
      break;
    }
    stats[outcome]++;
  }
  return stats;
}
