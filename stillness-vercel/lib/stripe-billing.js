import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const MONTHLY_CENTS = 1199;
const TOPUP_CENTS = 499;
const TRIAL_DAYS = 10;
const STRIPE_VERSION = '2025-03-31.basil';
const SUBSCRIPTION_EVENT_TYPES = new Set(['customer.subscription.updated', 'customer.subscription.deleted']);
const INVOICE_EVENT_TYPES = new Set(['invoice.paid', 'invoice.payment_failed']);
const CHECKOUT_EVENT_TYPES = new Set(['checkout.session.completed', 'checkout.session.async_payment_succeeded']);
const CLOSED_SUBSCRIPTIONS = new Set(['canceled', 'incomplete_expired']);
const CHECKOUT_ACTIONS = new Set(['subscribe-paid', 'topup', 'portal']);

export class BillingError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function stripeSettings(env = process.env) {
  const secret = env.STRIPE_SECRET_KEY?.trim();
  const monthlyPriceId = env.STRIPE_MONTHLY_PRICE_ID?.trim();
  const topupPriceId = env.STRIPE_TOPUP_PRICE_ID?.trim();
  if (!/^(?:sk|rk)_(?:live|test)_/.test(secret || '') || !/^price_\w+$/.test(monthlyPriceId || '') ||
      !/^price_\w+$/.test(topupPriceId || '') || monthlyPriceId === topupPriceId) {
    throw new BillingError(503, 'Billing is being set up. Please check back shortly.');
  }
  const live = /^(?:sk|rk)_live_/.test(secret);
  if (live && env.STRIPE_LIVE_ENABLED !== 'true') {
    throw new BillingError(503, 'Live billing is being set up. Please check back shortly.');
  }
  return {
    secret, monthlyPriceId, topupPriceId, live,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET?.trim(),
    portalConfiguration: env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID?.trim(),
  };
}

export function stripeClient(secret, transport = fetch) {
  return async (method, path, params = {}, key) => {
    const url = new URL(path, 'https://api.stripe.com/v1/');
    if (url.origin !== 'https://api.stripe.com' || !url.pathname.startsWith('/v1/')) {
      throw new Error('Invalid Stripe endpoint');
    }
    const headers = { Authorization: 'Bearer ' + secret, 'Stripe-Version': STRIPE_VERSION };
    if (key) headers['Idempotency-Key'] = key;
    const input = new URLSearchParams(params);
    if (method === 'GET') url.search = input.toString();
    else headers['Content-Type'] = 'application/x-www-form-urlencoded';
    let response;
    try {
      response = await transport(url, {
        method, headers, body: method === 'GET' ? undefined : input,
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      throw new BillingError(502, 'Stripe could not be reached. Please try again.');
    }
    if (!response.ok) {
      const providerError = response.status === 400 ? (await response.json().catch(() => null))?.error : null;
      if (response.status === 409 || response.status === 429 || providerError?.type === 'idempotency_error') {
        throw new BillingError(409, 'A billing request is already being processed. Please try again shortly.');
      }
      throw new BillingError(502, 'Stripe could not complete the request. Please try again shortly.');
    }
    return response.json();
  };
}

export function verifyStripeWebhook(raw, signature, secret, now = Date.now()) {
  if (!secret || typeof signature !== 'string' || signature.length > 4096) throw new Error('Invalid Stripe signature');
  const parts = signature.split(',').map(part => part.trim().split('='));
  const timestamp = parts.find(([type]) => type === 't')?.[1];
  if (!/^\d{1,12}$/.test(timestamp || '') || Math.abs(now / 1000 - Number(timestamp)) > 300) {
    throw new Error('Invalid Stripe event timestamp');
  }
  const expected = createHmac('sha256', secret).update(timestamp + '.').update(raw).digest();
  const valid = parts.some(([type, value]) => type === 'v1' && /^[0-9a-f]{64}$/i.test(value || '') &&
    timingSafeEqual(expected, Buffer.from(value, 'hex')));
  if (!valid) throw new Error('Invalid Stripe signature');
  return JSON.parse(Buffer.from(raw).toString('utf8'));
}

function reference(value) {
  return typeof value === 'string' ? value : value?.id;
}

function stripePath(resource, id) {
  if (!/^[a-zA-Z\d_]+$/.test(id || '')) throw new Error('Invalid Stripe identifier');
  return resource + '/' + id;
}

function stripeDate(seconds) {
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 30000000000) return null;
  return new Date(seconds * 1000).toISOString();
}

function unitPrice(price, id, cents, type) {
  return price?.id === id && price.currency === 'usd' && price.unit_amount === cents && price.type === type;
}

function fixedMonthlyPrice(price, id) {
  return unitPrice(price, id, MONTHLY_CENTS, 'recurring') && price.recurring?.interval === 'month' &&
    price.recurring.interval_count === 1 && price.recurring.usage_type === 'licensed';
}

function providerUrl(raw, domain) {
  let url;
  try { url = new URL(raw); } catch { throw new BillingError(502, 'Stripe did not return a checkout link.'); }
  if (url.origin !== 'https://' + domain || url.username || url.password) {
    throw new BillingError(502, 'Stripe did not return a checkout link.');
  }
  return url.href;
}

function stableKey(kind, id) {
  return 'stillness-' + kind + '-' + createHash('sha256').update(id).digest('hex');
}

export function createBilling({ stripe, store, settings, now = Date.now }) {
  async function activePrice(kind) {
    const monthly = kind !== 'topup';
    const id = monthly ? settings.monthlyPriceId : settings.topupPriceId;
    const price = await stripe('GET', stripePath('prices', id));
    const valid = monthly ? fixedMonthlyPrice(price, id) : unitPrice(price, id, TOPUP_CENTS, 'one_time');
    if (!valid || !price.active || price.livemode !== settings.live) {
      throw new BillingError(503, 'Billing is being set up. Please check back shortly.');
    }
    return id;
  }

  function listSubscriptions(customer) {
    return stripe('GET', 'subscriptions', { customer, status: 'all', limit: 100 });
  }

  async function ensureCustomer(user, member) {
    if (member.stripe_customer_id) return member.stripe_customer_id;
    const customer = await stripe('POST', 'customers', {
      email: user.email,
      'metadata[stillness_member]': user.id,
    }, stableKey('customer', user.id));
    const updated = await store.setStripeCustomer(user.id, customer.id);
    if (!updated?.stripe_customer_id) throw new Error('Stripe customer could not be mapped');
    return updated.stripe_customer_id;
  }

  async function checkout(user, action, origin) {
    if (!CHECKOUT_ACTIONS.has(action)) throw new BillingError(400, 'Invalid billing action.');
    const member = await store.getMember(user.id, user.email);
    const returnUrl = new URL('/?billing=return', origin).href;
    if (action === 'portal') {
      if (!member.stripe_customer_id) throw new BillingError(409, 'Start a subscription to manage billing.');
      const portal = await stripe('POST', 'billing_portal/sessions', {
        customer: member.stripe_customer_id,
        return_url: returnUrl,
        ...(settings.portalConfiguration ? { configuration: settings.portalConfiguration } : {}),
      });
      return providerUrl(portal.url, 'billing.stripe.com');
    }

    const topup = action === 'topup';
    if (topup && (member.status !== 'active' || !(Date.parse(member.period_ends_at) > now()))) {
      throw new BillingError(409, 'Extra minutes are available with a paid membership.');
    }
    const hasStripeSubscription = member.status === 'active' || (member.status === 'trialing' && member.subscription_id);
    if (!topup && hasStripeSubscription && Date.parse(member.period_ends_at) > now()) {
      throw new BillingError(409, 'You already have a membership. Open billing to manage it.');
    }

    const priceId = await activePrice(action);
    const customer = await ensureCustomer(user, member);
    if (!topup) {
      const existing = await listSubscriptions(customer);
      if (existing.data.some(subscription => !CLOSED_SUBSCRIPTIONS.has(subscription.status))) {
        throw new BillingError(409, 'You already have a subscription with Stripe. Open billing to manage it.');
      }
    }
    const recent = await stripe('GET', 'checkout/sessions', { customer, limit: 100 });
    const mode = topup ? 'payment' : 'subscription';
    const family = recent.data.filter(item => item.client_reference_id === user.id && item.mode === mode &&
      item.metadata?.stillness_action === action);
    const activeSession = family.find(item => item.status === 'open');
    if (activeSession) {
      if (activeSession.url) return providerUrl(activeSession.url, 'checkout.stripe.com');
      throw new BillingError(409, 'A checkout is already open. Please try again shortly.');
    }
    const previous = family[0];

    const body = {
      customer,
      client_reference_id: user.id,
      'metadata[stillness_member]': user.id,
      'metadata[stillness_action]': action,
      'payment_method_types[0]': 'card',
      success_url: returnUrl,
      cancel_url: new URL('/?billing=cancel', origin).href,
      mode,
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': 1,
    };
    if (!topup) body['subscription_data[metadata][stillness_member]'] = user.id;
    // Previous paid sessions seed retries. The paid namespace keeps older
    // Stripe idempotency keys for card-trial setup from blocking a purchase.
    const slot = [user.id, topup ? 'topup' : 'paid-membership', previous?.id || 'first'].join(':');
    const session = await stripe('POST', 'checkout/sessions', body, stableKey('checkout', slot));
    return providerUrl(session.url, 'checkout.stripe.com');
  }

  async function storeSubscription(event, member, subscription) {
    if (reference(subscription.customer) !== member.stripe_customer_id || subscription.metadata?.stillness_member !== member.user_id) return;
    const items = subscription.items?.data;
    if (items?.length !== 1 || items[0].quantity !== 1 || !fixedMonthlyPrice(items[0].price, settings.monthlyPriceId)) return;
    const item = items[0];
    const status = subscription.status;
    const periodStartsAt = stripeDate(status === 'trialing' ? subscription.trial_start : item.current_period_start ?? subscription.current_period_start);
    const periodEndsAt = stripeDate(status === 'trialing' ? subscription.trial_end : item.current_period_end ?? subscription.current_period_end);
    const write = {
      eventId: event.id, eventCreated: event.created, userId: member.user_id, customerId: member.stripe_customer_id,
      subscriptionId: subscription.id, periodStartsAt, periodEndsAt, status, cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
    };

    if (status === 'trialing') {
      const claim = subscription.metadata.stillness_trial_claim;
      if (!claim || !periodStartsAt || !periodEndsAt || subscription.trial_end - subscription.trial_start !== TRIAL_DAYS * 86400) return;
      await store.applyBillingEvent({ ...write, entitlement: 'trial', trialClaimId: claim });
      return;
    }
    if (status === 'active') {
      const invoiceId = reference(subscription.latest_invoice);
      if (!invoiceId || !periodStartsAt || !periodEndsAt) return;
      const invoice = await stripe('GET', stripePath('invoices', invoiceId));
      const invoiceSubscription = reference(invoice.parent?.subscription_details?.subscription ?? invoice.subscription);
      if (invoice.status === 'paid' && invoice.amount_paid >= MONTHLY_CENTS && invoice.currency === 'usd' &&
          reference(invoice.customer) === member.stripe_customer_id && invoiceSubscription === subscription.id) {
        await store.applyBillingEvent({ ...write, entitlement: 'paid' });
      }
      return;
    }
    if (['canceled', 'past_due', 'unpaid', 'paused', 'incomplete_expired', 'incomplete'].includes(status)) {
      await store.applyBillingEvent({ ...write, entitlement: 'status' });
    }
  }

  async function completeCheckout(event, checkoutId) {
    const session = await stripe('GET', stripePath('checkout/sessions', checkoutId));
    if (session.mode === 'setup') return;
    const customer = reference(session.customer);
    if (!customer || !session.metadata?.stillness_member) return;
    const member = await store.findMemberByCustomer(customer);
    if (!member || member.user_id !== session.client_reference_id || member.user_id !== session.metadata?.stillness_member ||
        session.status !== 'complete') return;
    const action = session.metadata.stillness_action;
    if (action === 'subscribe-paid' && session.mode === 'subscription' && session.subscription) {
      const subscription = await stripe('GET', stripePath('subscriptions', reference(session.subscription)));
      await storeSubscription(event, member, subscription);
    } else if (action === 'topup' && session.mode === 'payment' && session.payment_status === 'paid' &&
        session.currency === 'usd' && session.amount_total >= TOPUP_CENTS) {
      const lineItems = await stripe('GET', stripePath('checkout/sessions', session.id) + '/line_items', { limit: 2 });
      if (lineItems.has_more || lineItems.data.length !== 1 || lineItems.data[0].quantity !== 1 ||
          !unitPrice(lineItems.data[0].price, settings.topupPriceId, TOPUP_CENTS, 'one_time')) return;
      await store.applyBillingEvent({
        eventId: event.id, eventCreated: event.created, userId: member.user_id, customerId: member.stripe_customer_id,
        subscriptionId: member.subscription_id, status: member.status, entitlement: 'topup', topupPurchaseId: session.id,
      });
    }
  }

  async function webhook(event) {
    if (event.livemode !== settings.live) throw new BillingError(400, 'Stripe event mode does not match this deployment.');
    if (!/^evt_\w+$/.test(event.id || '') || !Number.isSafeInteger(event.created)) throw new BillingError(400, 'Invalid Stripe event.');
    const object = event.data?.object;
    if (!object?.id) throw new BillingError(400, 'Stripe event has no object.');
    if (CHECKOUT_EVENT_TYPES.has(event.type)) {
      // Completing an older setup-only Checkout must never start a paid contract.
      if (object.mode === 'setup') return;
      await completeCheckout(event, object.id);
    } else if (SUBSCRIPTION_EVENT_TYPES.has(event.type) || INVOICE_EVENT_TYPES.has(event.type)) {
      const id = SUBSCRIPTION_EVENT_TYPES.has(event.type) ? object.id
        : reference(object.parent?.subscription_details?.subscription ?? object.subscription);
      if (!id || !reference(object.customer)) return;
      const member = await store.findMemberByCustomer(reference(object.customer));
      if (!member) return;
      const subscription = await stripe('GET', stripePath('subscriptions', id));
      await storeSubscription(event, member, subscription);
    }
  }

  return { checkout, webhook };
}
