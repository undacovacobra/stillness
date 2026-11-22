import * as store from '../lib/member-store.js';
import { BillingError, createBilling, stripeClient, stripeSettings, verifyStripeWebhook } from '../lib/stripe-billing.js';

function reply(status, body) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request) {
  let settings;
  try {
    settings = stripeSettings(process.env, { forWebhook: true });
  } catch {
    return reply(503, { error: 'Stripe webhook is not configured.' });
  }
  if (!settings.webhookSecret) return reply(503, { error: 'Stripe webhook is not configured.' });

  const maxBytes = 512 * 1024;
  const signature = request.headers.get('stripe-signature');
  const length = Number(request.headers.get('content-length'));
  if (!signature || length > maxBytes) return reply(400, { error: 'Invalid Stripe webhook request.' });
  let event;
  try {
    const raw = Buffer.from(await request.arrayBuffer());
    if (raw.length > maxBytes) return reply(400, { error: 'Invalid Stripe webhook request.' });
    event = verifyStripeWebhook(raw, signature, settings.webhookSecret);
  } catch {
    return reply(400, { error: 'Invalid Stripe webhook signature.' });
  }

  try {
    const billing = createBilling({ stripe: stripeClient(settings.secret), store, settings });
    await billing.webhook(event);
    return reply(200, { received: true });
  } catch (error) {
    if (error instanceof BillingError && error.status === 400) return reply(400, { error: error.message });
    console.warn({ event: 'stripe_webhook_failed', failure: error?.name || 'Error' });
    return reply(503, { error: 'Stripe event could not be recorded.' });
  }
}
