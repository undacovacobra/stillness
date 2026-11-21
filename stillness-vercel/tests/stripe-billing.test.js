import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { createBilling, stripeSettings, verifyStripeWebhook } from '../lib/stripe-billing.js';
import billingAction from '../api/billing.js';
import { POST as stripeWebhook } from '../api/stripe-webhook.js';

const t0 = 1795300000;
const settings = { monthlyPriceId: 'price_month', topupPriceId: 'price_extra', live: false };
const user = { id: 'member1', email: 'member@example.com' };
const account = { user_id: user.id, stripe_customer_id: 'cus_1', status: 'inactive', trial_used: false };
const recurring = {
  id: 'price_month', active: true, livemode: false, unit_amount: 1199, currency: 'usd', type: 'recurring',
  recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' },
};
const invoiceId = 'in_123';
const paidSubscription = {
  id: 'sub_123', customer: 'cus_1', status: 'active', latest_invoice: invoiceId, metadata: { stillness_member: user.id },
  items: { data: [{ price: recurring, quantity: 1, current_period_start: t0, current_period_end: t0 + 30 * 86400 }] },
};
const completedSetup = {
  id: 'cs_test_setup', customer: 'cus_1', client_reference_id: user.id, status: 'complete', mode: 'setup',
  metadata: { stillness_member: user.id, stillness_action: 'subscribe' }, setup_intent: 'seti_1',
};
const paidInvoice = {
  id: invoiceId, customer: 'cus_1', status: 'paid', amount_paid: 1199, currency: 'usd',
  parent: { subscription_details: { subscription: paidSubscription.id } },
};
const event = (type, object) => ({ type, created: t0, livemode: false, id: 'evt_1', data: { object } });

function mock(overrides = {}) {
  const requests = [], writes = [];
  let stripe = async (method, path, body, key) => {
    requests.push({ method, path, body, key });
    if (path === 'prices/price_month') return recurring;
    if (path === 'customers/cus_1') return { id: 'cus_1', metadata: { stillness_member: user.id } };
    if (path === 'subscriptions') return { data: [] };
    if (path === 'checkout/sessions' && method === 'GET') return { data: [] };
    if (path === 'checkout/sessions') return { url: 'https://checkout.stripe.com/c/session' };
    if (path === 'checkout/sessions/cs_test_setup') return completedSetup;
    if (path === 'setup_intents/seti_1') return {
      id: 'seti_1', customer: 'cus_1', status: 'succeeded', usage: 'off_session', payment_method: 'pm_1',
    };
    if (path === 'payment_methods/pm_1') return { id: 'pm_1', customer: 'cus_1', type: 'card', card: { fingerprint: 'fp_1' } };
    if (path === 'subscriptions/sub_123') return paidSubscription;
    if (path === 'invoices/' + invoiceId) return paidInvoice;
    throw new Error('unexpected Stripe request ' + path);
  };
  const store = {
    getMember: async () => ({ ...account }),
    findMemberByCustomer: async () => ({ ...account }),
    claimTrialCard: async () => ({ applied: false, reason: 'duplicate_trial' }),
    applyBillingEvent: async value => { writes.push(value); return { applied: true }; },
    ...overrides.store,
  };
  if (overrides.stripe) {
    const fallback = stripe;
    stripe = async (...args) => overrides.stripe(args, fallback);
  }
  return { requests, writes, billing: createBilling({ stripe, store, settings, now: () => t0 * 1000 }) };
}

test('verifies exact raw Stripe payload and accepts signature rotation', () => {
  const raw = Buffer.from('{ "id": "evt_1", "livemode": false }\n');
  const digest = createHmac('sha256', 'whsec_test').update(`${t0}.`).update(raw).digest('hex');
  assert.equal(verifyStripeWebhook(raw, `t=${t0},v1=${'0'.repeat(64)},v1=${digest}`, 'whsec_test', t0 * 1000).id, 'evt_1');
  assert.throws(() => verifyStripeWebhook(Buffer.from(raw.toString().trim()), `t=${t0},v1=${digest}`, 'whsec_test', t0 * 1000));
  assert.throws(() => verifyStripeWebhook(raw, `t=${t0},v1=${digest}`, 'whsec_test', (t0 + 301) * 1000));
});

test('putting a card on file creates a setup checkout without charging or opening a subscription', async () => {
  const { billing, requests } = mock();
  assert.equal(await billing.checkout(user, 'subscribe', 'https://stillness.example'), 'https://checkout.stripe.com/c/session');
  const session = requests.find(req => req.path === 'checkout/sessions' && req.method === 'POST');
  assert.equal(session.body.mode, 'setup');
  assert.equal(session.body['line_items[0][price]'], undefined);
  assert.match(session.body['custom_text[submit][message]'], /\$11\.99/);
  assert.equal(requests.some(req => req.path === 'subscriptions' && req.method === 'POST'), false);
});

test('an already claimed card never opens a recurring subscription for the second account', async () => {
  const { billing, requests, writes } = mock();
  await billing.webhook(event('checkout.session.completed', completedSetup));
  assert.equal(requests.some(req => req.path === 'subscriptions' && req.method === 'POST'), false);
  assert.equal(writes.length, 0);
});

test('trial creation reserves the card before creating a ten-day subscription and recording access', async () => {
  const order = [];
  const trial = {
    ...paidSubscription, status: 'trialing', trial_start: t0, trial_end: t0 + 10 * 86400,
    metadata: { stillness_member: user.id, stillness_trial_claim: 'seti_1' },
  };
  const { billing } = mock({
    stripe: async (args, fallback) => {
      const [method, path, body, key] = args;
      if (method === 'POST' && path === 'subscriptions') {
        order.push('stripe');
        assert.equal(body.trial_period_days, 10);
        assert.equal(body.default_payment_method, 'pm_1');
        assert.match(key, /seti_1/);
        return trial;
      }
      return fallback(...args);
    },
    store: {
      claimTrialCard: async (...args) => {
        order.push('claim');
        assert.deepEqual(args, [user.id, 'cus_1', 'seti_1', 'fp_1']);
        return { applied: true };
      },
      applyBillingEvent: async value => {
        order.push('grant');
        assert.equal(value.entitlement, 'trial');
        assert.equal(value.trialClaimId, 'seti_1');
        assert.equal((Date.parse(value.periodEndsAt) - Date.parse(value.periodStartsAt)) / 86400000, 10);
        return { applied: true };
      },
    },
  });
  await billing.webhook(event('checkout.session.completed', completedSetup));
  assert.deepEqual(order, ['claim', 'stripe', 'grant']);
});

test('renewal requires a current paid invoice for the configured subscription', async () => {
  const { billing, writes } = mock();
  await billing.webhook(event('invoice.paid', paidInvoice));
  assert.equal(writes[0].entitlement, 'paid');
  assert.equal(writes[0].status, 'active');
  assert.equal(writes[0].eventCreated, t0);
  const zero = mock({
    stripe: ([method, path, ...rest], fallback) => path === 'invoices/' + invoiceId
      ? { ...paidInvoice, amount_paid: 0 } : fallback(method, path, ...rest),
  });
  await zero.billing.webhook(event('invoice.paid', paidInvoice));
  assert.equal(zero.writes.length, 0);
});

test('top-ups require paid Checkout and the correct single line item; Stripe session identifies a purchase', async () => {
  const session = {
    id: 'cs_test_extra', customer: 'cus_1', client_reference_id: user.id, mode: 'payment', status: 'complete',
    payment_status: 'paid', currency: 'usd', amount_total: 499,
    metadata: { stillness_member: user.id, stillness_action: 'topup' },
  };
  const line = { quantity: 1, price: { id: 'price_extra', unit_amount: 499, currency: 'usd', type: 'one_time' } };
  function purchase(paymentStatus, actualLine) {
    return mock({ stripe: ([method, path, ...rest], fallback) => {
      if (path === 'checkout/sessions/cs_test_extra') return { ...session, payment_status: paymentStatus };
      if (path === 'checkout/sessions/cs_test_extra/line_items') return { data: [actualLine] };
      return fallback(method, path, ...rest);
    }});
  }
  const paid = purchase('paid', line);
  await paid.billing.webhook(event('checkout.session.completed', session));
  assert.equal(paid.writes[0].entitlement, 'topup');
  assert.equal(paid.writes[0].topupPurchaseId, session.id);
  const unpaid = purchase('unpaid', line);
  await unpaid.billing.webhook(event('checkout.session.completed', session));
  assert.equal(unpaid.writes.length, 0);
  const otherPrice = purchase('paid', { ...line, price: { ...line.price, id: 'price_other' } });
  await otherPrice.billing.webhook(event('checkout.session.completed', session));
  assert.equal(otherPrice.writes.length, 0);
});

test('test and live Stripe events are never interchangeable', async () => {
  const { billing, requests } = mock();
  await assert.rejects(billing.webhook({ ...event('checkout.session.completed', completedSetup), livemode: true }), /mode/);
  assert.equal(requests.length, 0);
});

test('competing membership checkouts share a Stripe idempotency key until a new attempt exists', async () => {
  const { billing, requests } = mock();
  await Promise.all([
    billing.checkout(user, 'subscribe', 'https://stillness.example'),
    billing.checkout(user, 'subscribe-paid', 'https://stillness.example'),
  ]);
  const posted = requests.filter(req => req.path === 'checkout/sessions' && req.method === 'POST');
  assert.equal(posted.length, 2);
  assert.equal(posted[0].key, posted[1].key);
});

test('live Stripe requires explicit confirmation in environment configuration', () => {
  const env = {
    STRIPE_SECRET_KEY: ['sk', 'live', 'fixture'].join('_'),
    STRIPE_MONTHLY_PRICE_ID: 'price_month', STRIPE_TOPUP_PRICE_ID: 'price_extra',
  };
  assert.throws(() => stripeSettings(env), { status: 503 });
  assert.equal(stripeSettings({ ...env, STRIPE_LIVE_ENABLED: 'true' }).live, true);
});

test('anonymous and cross-origin requests cannot start a billing action', async t => {
  const previous = process.env.APP_ORIGIN;
  process.env.APP_ORIGIN = 'https://stillness.example';
  t.after(() => {
    if (previous === undefined) delete process.env.APP_ORIGIN;
    else process.env.APP_ORIGIN = previous;
  });
  const res = {
    setHeader() {},
    status(status) { this.code = status; return this; },
    json(value) { this.body = value; },
  };
  const req = {
    method: 'POST', headers: { origin: 'https://elsewhere.example', 'content-type': 'application/json' },
    body: { action: 'subscribe' },
  };
  await billingAction(req, res);
  assert.equal(res.code, 403);
  req.headers.origin = 'https://stillness.example';
  await billingAction(req, res);
  assert.equal(res.code, 401);
});

test('Vercel Stripe endpoint checks the untouched Request body before processing', async t => {
  const webhookSecret = ['whsec', 'fixture'].join('_');
  const settings = {
    STRIPE_SECRET_KEY: ['sk', 'test', 'fixture'].join('_'),
    STRIPE_WEBHOOK_SECRET: webhookSecret,
    STRIPE_MONTHLY_PRICE_ID: 'price_month',
    STRIPE_TOPUP_PRICE_ID: 'price_extra',
  };
  const previous = Object.fromEntries(Object.keys(settings).map(name => [name, process.env[name]]));
  Object.assign(process.env, settings);
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const event = { id: 'evt_nothing', created: timestamp, livemode: false, type: 'ping', data: { object: { id: 'acct_1' } } };
  const body = JSON.stringify(event, null, 2);
  const digest = createHmac('sha256', webhookSecret).update(`${timestamp}.${body}`).digest('hex');
  const headers = { 'stripe-signature': `t=${timestamp},v1=${digest}` };
  const checked = await stripeWebhook(new Request('https://stillness.example/api/stripe-webhook', { method: 'POST', body, headers }));
  assert.equal(checked.status, 200);
  const altered = await stripeWebhook(new Request('https://stillness.example/api/stripe-webhook', { method: 'POST', body: body + ' ', headers }));
  assert.equal(altered.status, 400);
});
