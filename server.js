require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const path = require('path');
const db = require('./db');
const { providers } = require('./payments');

const app = express();
const PORT = process.env.PORT || 3000;
const USD_RATE = Number(process.env.USD_RATE) || 3700;

app.set('trust proxy', 1);
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"]
      }
    }
  })
);

/* ---------- Webhooks (need the raw body, so they come before express.json) ---------- */

function applyVerification(order, result) {
  if (!order || order.status === 'paid') return order;
  const amountOk = result.amount == null || Math.abs(Number(result.amount) - order.amount) < 0.01;
  const currencyOk = !result.currency || result.currency === order.currency;
  if (result.paid && amountOk && currencyOk) {
    db.prepare("UPDATE orders SET status = 'paid', paid_at = datetime('now') WHERE reference = ?").run(order.reference);
  } else if (!result.paid && order.status === 'pending' && result.failed) {
    db.prepare("UPDATE orders SET status = 'failed' WHERE reference = ?").run(order.reference);
  }
  return db.prepare('SELECT * FROM orders WHERE reference = ?').get(order.reference);
}

async function verifyOrder(order) {
  const p = providers[order.provider];
  if (!p) return order;
  try {
    return applyVerification(order, await p.verify(order));
  } catch (e) {
    console.error('verify error', order.reference, e.message);
    return order;
  }
}

const getOrder = ref => db.prepare('SELECT * FROM orders WHERE reference = ?').get(ref);

app.post('/webhooks/flutterwave', express.json(), async (req, res) => {
  const hash = req.get('verif-hash');
  if (!process.env.FLW_SECRET_HASH || hash !== process.env.FLW_SECRET_HASH) return res.sendStatus(401);
  const ref = req.body && req.body.data && req.body.data.tx_ref;
  const order = ref && getOrder(ref);
  if (order && order.provider === 'flutterwave') await verifyOrder(order); // re-verify with the API, never trust the payload alone
  res.sendStatus(200);
});

app.get('/webhooks/pesapal', async (req, res) => {
  const { OrderTrackingId, OrderMerchantReference, OrderNotificationType } = req.query;
  const order = OrderMerchantReference && getOrder(String(OrderMerchantReference));
  if (order && order.provider === 'pesapal') await verifyOrder(order);
  res.json({ orderNotificationType: OrderNotificationType, orderTrackingId: OrderTrackingId, orderMerchantReference: OrderMerchantReference, status: 200 });
});

app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const raw = req.body.toString('utf8');
  if (!providers.stripe.verifyWebhook(raw, req.get('stripe-signature'))) return res.sendStatus(400);
  try {
    const event = JSON.parse(raw);
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const order = getOrder(event.data.object.client_reference_id);
      if (order && order.provider === 'stripe') await verifyOrder(order);
    }
  } catch (e) {
    console.error('stripe webhook', e.message);
  }
  res.sendStatus(200);
});

/* ---------- API ---------- */

app.use(express.json({ limit: '50kb' }));
app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false }));

const strictLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });

const clean = (v, max = 200) => String(v == null ? '' : v).trim().slice(0, max);
const isEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);

app.get('/api/config', (req, res) => {
  res.json({
    usdRate: USD_RATE,
    company: { email: process.env.COMPANY_EMAIL || '', phone: process.env.COMPANY_PHONE || '' },
    providers: Object.fromEntries(Object.entries(providers).map(([k, v]) => [k, v.enabled()]))
  });
});

app.get('/api/products', (req, res) => {
  res.json(db.prepare('SELECT id, name, description, category, price_ugx FROM products WHERE active = 1 ORDER BY id').all());
});

app.post('/api/contact', strictLimit, (req, res) => {
  const name = clean(req.body.name, 100), email = clean(req.body.email, 150), message = clean(req.body.message, 3000);
  if (!name || !isEmail(email) || message.length < 5) return res.status(400).json({ error: 'Please provide your name, a valid email and a message.' });
  db.prepare('INSERT INTO messages (name, email, phone, subject, message) VALUES (?,?,?,?,?)')
    .run(name, email, clean(req.body.phone, 30), clean(req.body.subject, 150), message);
  res.json({ ok: true });
});

// Create an order and start payment. Prices are always calculated here from the database.
app.post('/api/checkout', strictLimit, async (req, res) => {
  try {
    const { items, customer = {}, provider, currency } = req.body || {};
    const name = clean(customer.name, 100), email = clean(customer.email, 150), phone = clean(customer.phone, 30);
    if (!name || !isEmail(email)) return res.status(400).json({ error: 'Please enter your name and a valid email.' });
    if (!Array.isArray(items) || !items.length || items.length > 30) return res.status(400).json({ error: 'Your cart is empty.' });

    const p = providers[provider];
    if (!p) return res.status(400).json({ error: 'Unknown payment method.' });
    if (!p.enabled()) return res.status(503).json({ error: 'This payment method is not configured yet.' });

    const find = db.prepare('SELECT id, name, price_ugx FROM products WHERE id = ? AND active = 1');
    let totalUgx = 0;
    const lines = [];
    for (const it of items) {
      const qty = Math.min(Math.max(parseInt(it.qty, 10) || 0, 1), 100);
      const prod = find.get(parseInt(it.id, 10));
      if (!prod) return res.status(400).json({ error: 'An item in your cart is no longer available.' });
      totalUgx += prod.price_ugx * qty;
      lines.push({ id: prod.id, name: prod.name, qty, price_ugx: prod.price_ugx });
    }

    // Stripe is USD-only here; other gateways accept UGX or USD.
    const cur = provider === 'stripe' ? 'USD' : currency === 'USD' ? 'USD' : 'UGX';
    const amount = cur === 'UGX' ? totalUgx : Math.ceil((totalUgx / USD_RATE) * 100) / 100;
    if (provider !== 'stripe' && cur === 'UGX' && phone && !/^(\+?256|0)\d{9}$/.test(phone.replace(/\s/g, ''))) {
      return res.status(400).json({ error: 'Please enter a valid Ugandan phone number, e.g. 0772 123456.' });
    }

    const reference = `AURA-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    db.prepare('INSERT INTO orders (reference, customer_name, email, phone, items, amount, currency, provider) VALUES (?,?,?,?,?,?,?,?)')
      .run(reference, name, email, phone, JSON.stringify(lines), amount, cur, provider);

    const order = getOrder(reference);
    try {
      const { redirectUrl, providerRef } = await p.create(order, { name, email, phone });
      db.prepare('UPDATE orders SET provider_ref = ? WHERE reference = ?').run(providerRef, reference);
      res.json({ reference, redirectUrl });
    } catch (e) {
      db.prepare("UPDATE orders SET status = 'failed' WHERE reference = ?").run(reference);
      console.error('create payment failed', e.message);
      res.status(502).json({ error: 'Could not start the payment. Please try another method or contact us.' });
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// Where gateways send the customer back to. We verify server-side before showing a result.
app.get('/payment/callback', async (req, res) => {
  const order = getOrder(clean(req.query.ref, 60));
  if (order) await verifyOrder(order);
  res.redirect(`/status.html?ref=${encodeURIComponent(clean(req.query.ref, 60))}`);
});

app.get('/api/orders/:ref/status', async (req, res) => {
  let order = getOrder(clean(req.params.ref, 60));
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status === 'pending') order = await verifyOrder(order);
  res.json({ reference: order.reference, status: order.status, amount: order.amount, currency: order.currency, provider: order.provider });
});

/* ---------- Minimal admin API (header: x-admin-token) ---------- */

function admin(req, res, next) {
  const token = process.env.ADMIN_TOKEN || '';
  const given = req.get('x-admin-token') || '';
  const a = Buffer.from(token), b = Buffer.from(given);
  if (token.length < 16 || a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.sendStatus(401);
  next();
}
app.get('/api/admin/orders', admin, (req, res) => res.json(db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 500').all()));
app.get('/api/admin/messages', admin, (req, res) => res.json(db.prepare('SELECT * FROM messages ORDER BY id DESC LIMIT 500').all()));
app.post('/api/admin/products', admin, (req, res) => {
  const { name, description, category, price_ugx } = req.body || {};
  if (!name || !description || !category || !(price_ugx > 0)) return res.status(400).json({ error: 'name, description, category, price_ugx required' });
  const r = db.prepare('INSERT INTO products (name, description, category, price_ugx) VALUES (?,?,?,?)').run(clean(name), clean(description, 500), clean(category, 50), Math.round(price_ugx));
  res.json({ id: r.lastInsertRowid });
});
app.put('/api/admin/products/:id', admin, (req, res) => {
  const cur = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!cur) return res.sendStatus(404);
  const n = { ...cur, ...req.body };
  db.prepare('UPDATE products SET name=?, description=?, category=?, price_ugx=?, active=? WHERE id=?')
    .run(clean(n.name), clean(n.description, 500), clean(n.category, 50), Math.round(n.price_ugx), n.active ? 1 : 0, cur.id);
  res.json({ ok: true });
});

/* ---------- Static site ---------- */

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.use((req, res) => res.status(404).sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`Aura Tech Solutions Uganda running on http://localhost:${PORT}`));
