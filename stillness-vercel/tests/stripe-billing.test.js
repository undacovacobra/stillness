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
    if (path === 'subscriptions/sub_123') return paidSubscription;
    if (path === 'invoices/' + invoiceId) return paidInvoice;
    throw new Error('unexpected Stripe request ' + path);
  };
  const store = {
    getMember: async () => ({ ...account }),
    findMemberByCustomer: async () => ({ ...account }),
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

test('legacy card-trial checkout requests are rejected before reaching Stripe', async () => {
  const { billing, requests } = mock();
  await assert.rejects(billing.checkout(user, 'subscribe', 'https://stillness.example'), { status: 400 });
  assert.deepEqual(requests, []);
});

test('even a previously eligible stale Stripe setup event cannot create a subscription', async () => {
  const { billing, requests, writes } = mock({
    store: { claimTrialCard: async () => assert.fail('obsolete trial attempted to claim a card') },
  });
  await billing.webhook(event('checkout.session.completed', completedSetup));
  assert.deepEqual(requests, []);
  assert.deepEqual(writes, []);
});

test('a sparse older checkout event is ignored when Stripe confirms it was setup-only', async () => {
  const { billing, requests, writes } = mock({
    store: { findMemberByCustomer: async () => assert.fail('setup-only Checkout must not process a member') },
  });
  await billing.webhook(event('checkout.session.completed', { id: completedSetup.id }));
  assert.deepEqual(requests.map(({ method, path }) => [method, path]), [['GET', 'checkout/sessions/cs_test_setup']]);
  assert.deepEqual(writes, []);
});

test('a member with a cardless trial can explicitly opt in to immediately paid checkout', async () => {
  const trialMember = {
    ...account, stripe_customer_id: null, status: 'trialing', subscription_id: null, trial_used: true,
    period_ends_at: new Date((t0 + 10 * 86400) * 1000).toISOString(),
  };
  const { billing, requests } = mock({
    store: {
      getMember: async () => trialMember,
      setStripeCustomer: async (id, customer) => ({ ...trialMember, user_id: id, stripe_customer_id: customer }),
    },
    stripe: ([method, path, ...rest], fallback) => path === 'customers' && method === 'POST'
      ? { id: 'cus_1' } : fallback(method, path, ...rest),
  });
  assert.equal(await billing.checkout(user, 'subscribe-paid', 'https://stillness.example'), 'https://checkout.stripe.com/c/session');
  const session = requests.find(request => request.path === 'checkout/sessions' && request.method === 'POST');
  assert.equal(session.body.mode, 'subscription');
  assert.equal(session.body['line_items[0][price]'], 'price_month');
  assert.equal(session.body['line_items[0][quantity]'], 1);
  assert.equal(Object.keys(session.body).some(key => /trial|setup_intent/i.test(key)), false);
  await assert.rejects(billing.checkout(user, 'topup', 'https://stillness.example'), { status: 409 });
});

test('an obsolete open setup Checkout does not block opt-in paid Checkout', async () => {
  const { billing } = mock({
    stripe: ([method, path, ...rest], fallback) => path === 'checkout/sessions' && method === 'GET'
      ? { data: [{ ...completedSetup, status: 'open' }] } : fallback(method, path, ...rest),
  });
  assert.equal(await billing.checkout(user, 'subscribe-paid', 'https://stillness.example'), 'https://checkout.stripe.com/c/session');
});

test('Stripe still reconciles an existing legacy trial subscription without creating another', async () => {
  const trial = {
    ...paidSubscription, status: 'trialing', trial_start: t0, trial_end: t0 + 10 * 86400,
    metadata: { stillness_member: user.id, stillness_trial_claim: 'seti_1' },
  };
  const { billing, requests, writes } = mock({
    stripe: ([method, path, ...rest], fallback) => path === 'subscriptions/sub_123' && method === 'GET'
      ? trial : fallback(method, path, ...rest),
  });
  await billing.webhook(event('customer.subscription.updated', trial));
  assert.equal(writes[0].entitlement, 'trial');
  assert.equal(writes[0].trialClaimId, 'seti_1');
  assert.deepEqual(requests.filter(request => request.method === 'POST'), []);
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

test('repeated paid membership checkouts share a Stripe idempotency key until a new attempt exists', async () => {
  const { billing, requests } = mock();
  await Promise.all([
    billing.checkout(user, 'subscribe-paid', 'https://stillness.example'),
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
    STRIPE_WEBHOOK_SECRET: 'whsec_fixture',
  };
  assert.throws(() => stripeSettings(env), { status: 503 });
  assert.equal(stripeSettings({ ...env, STRIPE_LIVE_ENABLED: 'true' }).live, true);
  assert.throws(() => stripeSettings({
    ...env, STRIPE_LIVE_ENABLED: 'true', STRIPE_WEBHOOK_SECRET: undefined,
  }), { status: 503 });
});

test('Stripe sandbox keys only enable checkout outside production', () => {
  const env = {
    STRIPE_SECRET_KEY: ['sk', 'test', 'fixture'].join('_'),
    STRIPE_MONTHLY_PRICE_ID: 'price_month', STRIPE_TOPUP_PRICE_ID: 'price_extra',
  };
  assert.equal(stripeSettings({ ...env, VERCEL_ENV: 'preview' }).live, false);
  assert.throws(() => stripeSettings({ ...env, VERCEL_ENV: 'production' }), { status: 503 });
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

test('Vercel Stripe verifies raw signatures and safely acknowledges a stale setup completion', async t => {
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
  const staleSetup = { ...event('checkout.session.completed', completedSetup), created: timestamp };
  const transport = t.mock.method(globalThis, 'fetch', async () => assert.fail('obsolete Stripe setup made a network request'));
  const body = JSON.stringify(staleSetup, null, 2);
  const digest = createHmac('sha256', webhookSecret).update(`${timestamp}.${body}`).digest('hex');
  const headers = { 'stripe-signature': `t=${timestamp},v1=${digest}` };
  const checked = await stripeWebhook(new Request('https://stillness.example/api/stripe-webhook', { method: 'POST', body, headers }));
  assert.equal(checked.status, 200);
  const altered = await stripeWebhook(new Request('https://stillness.example/api/stripe-webhook', { method: 'POST', body: body + ' ', headers }));
  assert.equal(altered.status, 400);
  assert.equal(transport.mock.callCount(), 0);
});
