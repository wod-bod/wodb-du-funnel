const path   = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const stripe  = require('stripe')(process.env.STRIPE_SECRET_KEY);

// ── CIRCLE CONFIG ────────────────────────────────────
const CIRCLE_API_TOKEN    = process.env.CIRCLE_API_TOKEN;
const CIRCLE_COMMUNITY_ID = 248627; // WOD BOD COLLECTIVE

// All spaces inside the "RX Method" space group (subscription)
const RX_METHOD_SPACE_IDS = [
  2004118, // Getting Started
  2273591, // Questions
  2585932, // MBD Protocol
  2009786, // Athlete Headquarters
  1980384, // Gymnastics Mastery
  2417369, // DU Challenge Chat
  1980543, // 6 Wk DU Fix
  2002061, // Olympic Lifting Mastery
  2177840, // Performance Stack
  2182485, // Pain Fix
];

// Spaces unlocked by the 6-Week Double Under Fix (one-time, main product)
const DU_FIX_SPACE_IDS = [
  1980543, // 6 Wk DU Fix
];

// Spaces unlocked by the RX Starter Kit (one-time downsell)
const RX_STARTER_KIT_SPACE_IDS = [
  2182485, // Mobility Lab
  1563581, // Gymnastics Kickstarter
  2002272, // Oly Overhaul
  1980533, // Community Chat
];

async function circleRequest(method, endpoint, body) {
  const res = await fetch(`https://app.circle.so/api/v1/${endpoint}`, {
    method,
    headers: {
      'Authorization': `Token ${CIRCLE_API_TOKEN}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    console.warn(`  Circle ${method} /${endpoint} → ${res.status}: ${text}`);
  }
  return res;
}

async function circleGrantAccess(email) {
  console.log(`  Granting Circle access → ${email}`);
  // Add to community (creates account + sends invite if new member)
  await circleRequest('POST', 'community_members', {
    community_id: CIRCLE_COMMUNITY_ID,
    email,
    suppress_notifications: false,
  });
  // Add to each RX Method space
  for (const space_id of RX_METHOD_SPACE_IDS) {
    await circleRequest('POST', 'space_members', {
      community_id: CIRCLE_COMMUNITY_ID,
      space_id,
      email,
    });
  }
}

// Add a member to the community + a specific set of spaces (for one-time purchases)
async function circleAddToSpaces(email, spaceIds) {
  console.log(`  Circle: adding ${email} to community + ${spaceIds.length} space(s)`);
  await circleRequest('POST', 'community_members', {
    community_id: CIRCLE_COMMUNITY_ID,
    email,
    suppress_notifications: false,
  });
  for (const space_id of spaceIds) {
    await circleRequest('POST', 'space_members', {
      community_id: CIRCLE_COMMUNITY_ID,
      space_id,
      email,
    });
  }
}

async function circleRevokeAccess(email) {
  console.log(`  Revoking Circle access → ${email}`);
  await circleRequest('DELETE', 'community_members', {
    community_id: CIRCLE_COMMUNITY_ID,
    email,
  });
}

// ── APP ──────────────────────────────────────────────
const app = express();

// ── STRIPE WEBHOOK ───────────────────────────────────
// MUST be before express.json() — Stripe signature verification requires the raw body
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig    = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!secret) {
    console.error('⚠️  STRIPE_WEBHOOK_SECRET not set — webhook rejected');
    return res.status(500).send('Webhook secret not configured');
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Acknowledge immediately so Stripe doesn't retry
  res.json({ received: true });

  try {
    const obj = event.data.object;

    if (event.type === 'customer.subscription.created') {
      if (obj.status !== 'active' && obj.status !== 'trialing') return;
      const cust = await stripe.customers.retrieve(obj.customer);
      if (cust.email) await circleGrantAccess(cust.email);
      console.log(`✅  Circle GRANTED (new subscription): ${cust.email}`);

    } else if (event.type === 'invoice.paid') {
      // Skip the creation invoice — already handled by subscription.created
      if (obj.billing_reason === 'subscription_create') return;
      if (obj.customer_email) await circleGrantAccess(obj.customer_email);
      console.log(`✅  Circle GRANTED (renewal): ${obj.customer_email}`);

    } else if (event.type === 'customer.subscription.deleted') {
      // Fires after Stripe exhausts all payment retries and cancels
      const cust = await stripe.customers.retrieve(obj.customer);
      if (cust.email) await circleRevokeAccess(cust.email);
      console.log(`🚫  Circle REVOKED (subscription cancelled): ${cust.email}`);
    }

  } catch (err) {
    // Already sent 200 — just log, don't crash
    console.error('Webhook processing error:', err.message);
  }
});

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── ONE-TIME PRICES (cents) ──────────────────────────
const PRICES = {
  main:        3700,   // $37  — 6-Week Double Under Fix
  springLoaded: 2700,  // $27  — Spring Loaded
  tracker:      700,   // $7   — DU Progression Tracker
};

// ── UPSELL PRICES (one-time, cents) ─────────────────
const UPSELL_PRICES = {
  coaching:    9700,   // $97  — Video Coaching 3-Pack
  rxBlueprint: 2700,   // $27  — RX Fast-Track Blueprint (downsell)
};
const UPSELL_NAMES = {
  coaching:    'Video Coaching 3-Pack',
  rxBlueprint: 'RX Fast-Track Blueprint',
};

// ── SUBSCRIPTION PRICE IDs ───────────────────────────
// Populated on startup via ensureSubscriptionPrices()
// Can be overridden by setting WODB_MONTHLY_PRICE_ID / WODB_ANNUAL_PRICE_ID in .env
let WODB_MONTHLY_PRICE_ID = process.env.WODB_MONTHLY_PRICE_ID || null;
let WODB_ANNUAL_PRICE_ID  = process.env.WODB_ANNUAL_PRICE_ID  || null;

async function ensureSubscriptionPrices() {
  if (WODB_MONTHLY_PRICE_ID && WODB_ANNUAL_PRICE_ID) {
    console.log('  Subscription price IDs loaded from .env');
    return;
  }
  try {
    // Find or create the WOD BOD Method product
    const allProducts = await stripe.products.list({ limit: 100 });
    let product = allProducts.data.find(p => p.name === 'WOD BOD Method' && p.active);
    if (!product) {
      product = await stripe.products.create({
        name: 'WOD BOD Method',
        description: 'Complete CrossFit skill, strength & conditioning membership',
      });
      console.log(`  Created product: ${product.id}`);
    }

    // Monthly — $97/month
    const monthlyList = await stripe.prices.list({ lookup_keys: ['wodb_monthly'], limit: 1 });
    if (monthlyList.data.length > 0) {
      WODB_MONTHLY_PRICE_ID = monthlyList.data[0].id;
    } else {
      const monthly = await stripe.prices.create({
        product:    product.id,
        unit_amount: 9700,
        currency:   'usd',
        recurring:  { interval: 'month' },
        lookup_key: 'wodb_monthly',
        nickname:   'WOD BOD Monthly – $97/mo',
      });
      WODB_MONTHLY_PRICE_ID = monthly.id;
    }

    // Annual — $799/year
    const annualList = await stripe.prices.list({ lookup_keys: ['wodb_annual'], limit: 1 });
    if (annualList.data.length > 0) {
      WODB_ANNUAL_PRICE_ID = annualList.data[0].id;
    } else {
      const annual = await stripe.prices.create({
        product:    product.id,
        unit_amount: 79900,
        currency:   'usd',
        recurring:  { interval: 'year' },
        lookup_key: 'wodb_annual',
        nickname:   'WOD BOD Annual – $799/yr',
      });
      WODB_ANNUAL_PRICE_ID = annual.id;
    }

    console.log(`  Monthly price ID: ${WODB_MONTHLY_PRICE_ID}`);
    console.log(`  Annual  price ID: ${WODB_ANNUAL_PRICE_ID}`);
  } catch (err) {
    console.error('⚠️  Could not ensure subscription prices:', err.message);
    console.error('   Set WODB_MONTHLY_PRICE_ID and WODB_ANNUAL_PRICE_ID in .env manually.');
  }
}

// ── HELPERS ─────────────────────────────────────────
function calcAmount({ addSpringLoaded, addTracker }) {
  let amount = PRICES.main;
  if (addSpringLoaded) amount += PRICES.springLoaded;
  if (addTracker)      amount += PRICES.tracker;
  return amount;
}

function buildDescription({ addSpringLoaded, addTracker }) {
  const items = ['6-Week Double Under Fix'];
  if (addSpringLoaded) items.push('Spring Loaded');
  if (addTracker)      items.push('DU Progression Tracker');
  return items.join(' + ');
}

// ── ROUTES ──────────────────────────────────────────

app.get('/checkout',              (_req, res) => res.sendFile(path.join(__dirname, 'checkout.html')));
app.get('/upsell-1',              (_req, res) => res.sendFile(path.join(__dirname, 'upsell-1.html')));
app.get('/upsell-2',              (_req, res) => res.sendFile(path.join(__dirname, 'upsell-2.html')));
app.get('/thank-you',             (_req, res) => res.sendFile(path.join(__dirname, 'thank-you.html')));
app.get('/downsell',              (_req, res) => res.sendFile(path.join(__dirname, 'downsell.html')));
app.get('/subscription-portal',  (_req, res) => res.sendFile(path.join(__dirname, 'subscription-portal.html')));

// Frontend config — exposes non-secret price IDs so pages can use them
app.get('/config', (_req, res) => {
  res.json({
    publishableKey:      process.env.STRIPE_PUBLISHABLE_KEY,
    wodbMonthlyPriceId:  WODB_MONTHLY_PRICE_ID,
    wodbAnnualPriceId:   WODB_ANNUAL_PRICE_ID,
  });
});

// Create a new PaymentIntent
app.post('/create-payment-intent', async (req, res) => {
  try {
    const { addSpringLoaded = false, addTracker = false, email = '' } = req.body || {};
    const amount = calcAmount({ addSpringLoaded, addTracker });
    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: 'usd',
      receipt_email: email || undefined,
      description:   buildDescription({ addSpringLoaded, addTracker }),
      metadata: {
        product:        '6-Week Double Under Fix',
        addSpringLoaded: String(addSpringLoaded),
        addTracker:      String(addTracker),
      },
      payment_method_types: ['card'],
    });
    res.json({ clientSecret: paymentIntent.client_secret, paymentIntentId: paymentIntent.id, amount });
  } catch (err) {
    console.error('create-payment-intent error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// Update an existing PaymentIntent (order bump toggle)
app.post('/update-payment-intent', async (req, res) => {
  try {
    const { paymentIntentId, addSpringLoaded = false, addTracker = false } = req.body;
    const amount = calcAmount({ addSpringLoaded, addTracker });
    await stripe.paymentIntents.update(paymentIntentId, {
      amount,
      description: buildDescription({ addSpringLoaded, addTracker }),
      metadata: {
        addSpringLoaded: String(addSpringLoaded),
        addTracker:      String(addTracker),
      },
    });
    res.json({ amount });
  } catch (err) {
    console.error('update-payment-intent error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// Called after initial purchase succeeds — saves PM to a Customer for upsell reuse
app.post('/confirm-purchase', async (req, res) => {
  try {
    const { paymentIntentId, email, name, addTracker } = req.body;
    if (!paymentIntentId) throw new Error('paymentIntentId required');

    const pi   = await stripe.paymentIntents.retrieve(paymentIntentId);
    const pmId = pi.payment_method;
    if (!pmId) throw new Error('No payment method on PaymentIntent');

    const existing = await stripe.customers.list({ email: email || '', limit: 1 });
    let customer;
    if (existing.data.length > 0) {
      customer = existing.data[0];
    } else {
      customer = await stripe.customers.create({ email: email || undefined, name: name || undefined });
    }

    try {
      await stripe.paymentMethods.attach(pmId, { customer: customer.id });
    } catch (_) { /* already attached */ }

    await stripe.customers.update(customer.id, {
      invoice_settings: { default_payment_method: pmId },
    });

    // Generate unique tracker URL if they bought the DU Progression Tracker
    let trackerUrl = null;
    if (addTracker && email) {
      const norm  = String(email).trim().toLowerCase();
      const token = crypto.createHmac('sha256', process.env.TRACKER_TOKEN_SECRET || 'dev')
        .update(norm).digest('hex').slice(0, 16);
      trackerUrl = `https://dutracker.wodbodmethod.com/?u=${token}`;
    }

    // Grant Circle access to 6-Week DU Fix space (fire-and-forget — non-blocking)
    if (email) {
      circleAddToSpaces(email, DU_FIX_SPACE_IDS).catch(err =>
        console.error('Circle DU Fix access error:', err.message)
      );
    }

    res.json({ customerId: customer.id, paymentMethodId: pmId, trackerUrl });
  } catch (err) {
    console.error('confirm-purchase error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// One-click charge for one-time upsells (coaching, rxBlueprint)
app.post('/charge-upsell', async (req, res) => {
  try {
    const { customerId, paymentMethodId, product } = req.body;
    if (!UPSELL_PRICES[product]) throw new Error('Invalid upsell product');

    const pi = await stripe.paymentIntents.create({
      amount:         UPSELL_PRICES[product],
      currency:       'usd',
      customer:       customerId,
      payment_method: paymentMethodId,
      description:    UPSELL_NAMES[product],
      confirm:        true,
      off_session:    true,
      metadata: { product: UPSELL_NAMES[product], upsell: 'true' },
    });

    // Grant Circle access for RX Starter Kit (fire-and-forget)
    if (product === 'rxBlueprint') {
      stripe.customers.retrieve(customerId).then(cust => {
        if (cust.email) {
          circleAddToSpaces(cust.email, RX_STARTER_KIT_SPACE_IDS).catch(err =>
            console.error('Circle RX Starter Kit access error:', err.message)
          );
        }
      }).catch(() => {});
    }

    res.json({ success: true, paymentIntentId: pi.id });
  } catch (err) {
    console.error('charge-upsell error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// Create a recurring subscription (WOD BOD membership)
app.post('/create-subscription', async (req, res) => {
  try {
    const { customerId, paymentMethodId, priceId } = req.body;
    if (!customerId || !paymentMethodId || !priceId) {
      throw new Error('customerId, paymentMethodId, and priceId are required');
    }

    // Ensure the payment method is the default for this customer
    await stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });

    const subscription = await stripe.subscriptions.create({
      customer:         customerId,
      items:            [{ price: priceId }],
      default_payment_method: paymentMethodId,
      payment_behavior: 'error_if_incomplete',
      expand:           ['latest_invoice.payment_intent'],
      metadata:         { source: 'double-under-fix-upsell' },
    });

    res.json({ success: true, subscriptionId: subscription.id, status: subscription.status });
  } catch (err) {
    console.error('create-subscription error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// Redirect customer to Stripe hosted billing portal
app.get('/billing-portal', async (req, res) => {
  try {
    const { customerId } = req.query;
    if (!customerId) throw new Error('customerId required');

    const session = await stripe.billingPortal.sessions.create({
      customer:   customerId,
      return_url: 'https://subscriptions.wodbodmethod.com',
    });

    res.redirect(session.url);
  } catch (err) {
    console.error('billing-portal error:', err.message);
    res.status(400).send(`<p style="font-family:sans-serif;padding:40px;color:#888;">Could not open billing portal: ${err.message}</p>`);
  }
});

// Look up a Stripe customer by email (for subscription portal)
app.get('/lookup-customer', async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.json({ found: false });

    const list = await stripe.customers.list({ email: email.trim(), limit: 1 });
    if (!list.data.length) return res.json({ found: false });

    res.json({ found: true, customerId: list.data[0].id });
  } catch (err) {
    console.error('lookup-customer error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// ── START ────────────────────────────────────────────
const PORT = process.env.PORT || 3457;

ensureSubscriptionPrices().then(() => {
  app.listen(PORT, () => {
    console.log(`\n✅  Double Under Fix server → http://localhost:${PORT}`);
    console.log(`    Landing page        : http://localhost:${PORT}/index.html`);
    console.log(`    Checkout            : http://localhost:${PORT}/checkout`);
    console.log(`    Subscription portal : http://localhost:${PORT}/subscription-portal`);
  });
});
