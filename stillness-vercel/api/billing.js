import { appOrigin, requireMember, requireSameOrigin } from '../lib/member-auth.js';
import * as store from '../lib/member-store.js';
import { BillingError, createBilling, stripeClient, stripeSettings } from '../lib/stripe-billing.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  if (!requireSameOrigin(req, res)) return;
  const user = await requireMember(req, res);
  if (!user) return;

  let action;
  try {
    action = req.body?.action;
  } catch {
    return res.status(400).json({ error: 'Invalid billing request.' });
  }
  try {
    const settings = stripeSettings();
    const billing = createBilling({ stripe: stripeClient(settings.secret), store, settings });
    const url = await billing.checkout(user, action, appOrigin(req));
    return res.status(200).json({ url });
  } catch (error) {
    if (error instanceof BillingError) return res.status(error.status).json({ error: error.message });
    console.warn({ event: 'billing_action_failed', failure: error?.name || 'Error' });
    return res.status(502).json({ error: 'Billing could not be reached. Please try again shortly.' });
  }
}
