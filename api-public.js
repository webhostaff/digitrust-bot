'use strict';

/**
 * Public Customer API (v2) — mounted at /api/v2
 *
 * Any customer can mint a key from the bot menu; there is no application step.
 * A key identifies one telegram user, and every purchase is charged to that
 * user's ordinary wallet at that user's ordinary price.
 *
 * The single most important design rule here: **purchases go through
 * `deliverOrderAndChargeWallet`, the same atomic function the bot uses.**
 *
 * The older /api/v1 reseller API did its own stock handling and read from
 * `product_items` while the bot delivers from `stock`, so the two could sell
 * the same unit twice and the API reported "out of stock" on a full shelf.
 * Reusing the bot's function makes that class of bug impossible: one code path,
 * one transaction, one source of truth for balance and stock.
 *
 * Auth:  X-API-Key: sk_...   (or Authorization: Bearer sk_...)
 *
 * Endpoints
 *   GET  /api/v2/products        list products with YOUR price
 *   GET  /api/v2/product/:id     one product
 *   GET  /api/v2/balance         your wallet balance
 *   POST /api/v2/purchase        buy, paid from your wallet
 *   GET  /api/v2/orders          your order history
 *   GET  /api/v2/order/:id       one order, including delivered content
 *   GET  /api/v2/docs            this documentation
 */

const express = require('express');
const db      = require('./database/queries');
const dbRaw   = require('./database/db');
const logger  = require('./utils/logger');

const router = express.Router();
router.use(express.json({ limit: '256kb' }));

// ── Rate limiting ────────────────────────────────────────────────────────────
const RATE_LIMIT   = 60;      // requests
const RATE_WINDOW  = 60_000;  // per minute
const buckets = new Map();

function underRateLimit(key) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.start > RATE_WINDOW) {
    b = { count: 0, start: now };
    buckets.set(key, b);
  }
  b.count += 1;
  return b.count <= RATE_LIMIT;
}

// Keys with a purchase in flight. Without this, two concurrent calls could each
// pass their own balance check before either deducted anything.
const IN_FLIGHT = new Set();

// ── Helpers ──────────────────────────────────────────────────────────────────
const fail = (res, code, message, extra = {}) =>
  res.status(code).json({ success: false, error: message, ...extra });

const cleanTitle = (t) =>
  String(t || '').replace(/\[emoji:\d+\]/g, '').replace(/\s+/g, ' ').trim();

function requireKey(req, res, next) {
  const key = req.headers['x-api-key']
    || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');

  if (!key) return fail(res, 401, 'Missing X-API-Key header');
  if (!underRateLimit(key)) return fail(res, 429, `Rate limit: ${RATE_LIMIT} requests per minute`);

  const row = db.resolveApiKey(key);
  if (!row) return fail(res, 401, 'Invalid or disabled API key');

  const user = db.getUser(row.user_id);
  if (!user) return fail(res, 401, 'Account not found');
  if (user.is_banned) return fail(res, 403, 'Account suspended');

  db.touchApiKey(key);
  req.apiKey = key;
  req.userId = row.user_id;
  req.user   = user;
  next();
}

/** Public shape of a product, priced for this caller. */
function productPayload(userId, product) {
  const forMe = db.productForCustomer(userId, product);
  const allowance = db.getCustomerAllowance(userId, product.id);
  return {
    id:            product.id,
    title:         cleanTitle(product.title),
    description:   product.description || null,
    warranty:      product.warranty || null,
    price:         Number(Number(forMe.price).toFixed(6)),
    public_price:  Number(Number(product.price).toFixed(6)),
    stock:         Number(product.stock_quantity) || 0,
    requires_email: Number(product.requires_email) === 1,
    delivery:      product.delivery_type === 'manual' ? 'manual' : 'instant',
    special_price: allowance
      ? {
          price: Number(allowance.price),
          units_left: allowance.unlimited ? null : allowance.remaining,
          unlimited: allowance.unlimited,
        }
      : null,
  };
}

// ── GET /products ────────────────────────────────────────────────────────────
router.get('/products', requireKey, (req, res) => {
  try {
    const rows = dbRaw.prepare(`
      SELECT * FROM products
      WHERE is_active = 1
      ORDER BY display_order ASC, id ASC
    `).all();
    res.json({
      success: true,
      count: rows.length,
      products: rows.map((p) => productPayload(req.userId, p)),
    });
  } catch (e) {
    logger.error(`[API v2] /products: ${e.message}`);
    fail(res, 500, 'Internal error');
  }
});

// ── GET /product/:id ─────────────────────────────────────────────────────────
router.get('/product/:id', requireKey, (req, res) => {
  try {
    const product = db.getProduct(parseInt(req.params.id, 10));
    if (!product || !product.is_active) return fail(res, 404, 'Product not found');
    res.json({ success: true, product: productPayload(req.userId, product) });
  } catch (e) {
    logger.error(`[API v2] /product: ${e.message}`);
    fail(res, 500, 'Internal error');
  }
});

// ── GET /balance ─────────────────────────────────────────────────────────────
router.get('/balance', requireKey, (req, res) => {
  const fresh = db.getUser(req.userId);
  res.json({
    success: true,
    balance: Number(Number(fresh?.balance || 0).toFixed(6)),
    currency: 'USD',
    user_id: req.userId,
  });
});

// ── POST /purchase ───────────────────────────────────────────────────────────
/**
 * Body: { product_id, quantity, email? }
 *
 * Charged to the caller's wallet. Top up in the bot first — the API cannot
 * accept payments, only spend what is already there.
 */
router.post(['/purchase', '/order'], requireKey, async (req, res) => {
  if (IN_FLIGHT.has(req.apiKey)) {
    return fail(res, 429, 'Another purchase from this key is still processing');
  }
  IN_FLIGHT.add(req.apiKey);

  try {
    const productId = parseInt(req.body.product_id, 10);
    const quantity  = parseInt(req.body.quantity, 10) || 1;
    const email     = req.body.email ? String(req.body.email).trim() : null;

    if (!Number.isFinite(productId) || productId <= 0) return fail(res, 400, 'product_id is required');
    if (!Number.isFinite(quantity) || quantity < 1)     return fail(res, 400, 'quantity must be 1 or more');
    if (quantity > 100) return fail(res, 400, 'Maximum 100 units per purchase');

    const product = db.getProduct(productId);
    if (!product || !product.is_active) return fail(res, 404, 'Product not found');

    if (Number(product.requires_email) === 1 && !email) {
      return fail(res, 400, 'This product requires an "email" field');
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return fail(res, 400, 'Invalid email format');
    }

    const stock = Number(product.stock_quantity) || 0;
    if (stock < quantity) {
      return fail(res, 409, 'Insufficient stock', { available: stock });
    }

    // Same pricing engine as the bot: special price, allowance, bulk tiers.
    const pricing = db.resolveCustomerPricing(req.userId, product, quantity);
    const total   = Number(Number(pricing.total).toFixed(6));

    const balance = Number(db.getUser(req.userId)?.balance || 0);
    if (balance < total - 0.005) {
      return fail(res, 402, 'Insufficient wallet balance', {
        required: total, balance: Number(balance.toFixed(6)),
        hint: 'Top up your wallet in the bot, then retry.',
      });
    }

    const orderId = db.createOrder({
      userId: req.userId,
      productId,
      quantity,
      email,
      totalPrice: total,
    });
    try {
      dbRaw.prepare('UPDATE orders SET allowance_units = ? WHERE id = ?')
        .run(Number(pricing.specialUnits) || 0, orderId);
    } catch (e) { /* column added by migration; never fatal */ }

    // ── Manual products: take payment, queue a human delivery ───────────────
    if (product.delivery_type === 'manual') {
      const charged = db.chargeWalletForManualOrder(
        orderId, productId, quantity, req.userId, total
      );
      if (charged.result !== 'ok') {
        try {
          dbRaw.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ? AND status = 'pending'")
            .run(orderId);
        } catch (e) { /* non-fatal */ }
        if (charged.result === 'insufficient_balance') {
          return fail(res, 402, 'Insufficient wallet balance', {
            required: total, balance: charged.balance,
            hint: 'Top up your wallet in the bot, then retry.',
          });
        }
        return fail(res, 409, 'Order could not be processed');
      }

      db.addTransaction({
        userId: req.userId, type: 'purchase', amount: -total,
        description: `API order #${orderId}: ${cleanTitle(product.title)}`,
        refId: `api_${orderId}`, orderId,
      });
      db.consumeCustomerAllowance(orderId, req.userId, productId, pricing.specialUnits);

      try {
        const manual = require('./handlers/manualDelivery');
        const botRef = req.app && req.app.get('bot');
        if (botRef) await manual.openManualDelivery(botRef, db.getOrder(orderId), 'wallet');
      } catch (e) {
        logger.warn(`[API v2] manual delivery task for order ${orderId}: ${e.message}`);
      }

      return res.json({
        success: true,
        order: {
          id: orderId, product_id: productId, product: cleanTitle(product.title),
          quantity, total, status: 'awaiting_delivery',
          items: null,
          message: 'Paid. This product is delivered manually — you will receive it in the bot.',
          balance: Number(Number(db.getUser(req.userId)?.balance || 0).toFixed(6)),
        },
      });
    }

    // ── Instant products: the bot's own atomic deliver-and-charge ───────────
    const result = db.deliverOrderAndChargeWallet(
      orderId, productId, quantity, req.userId, total
    );

    if (result.result !== 'ok') {
      // The order row was created before the atomic charge. If the charge did
      // not go through, close it out here — otherwise failed API calls leave a
      // trail of permanently `pending` orders in the customer's history.
      try {
        dbRaw.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ? AND status = 'pending'")
          .run(orderId);
      } catch (e) { /* non-fatal */ }

      if (result.result === 'insufficient_balance') {
        return fail(res, 402, 'Insufficient wallet balance', {
          required: total, balance: Number(result.balance || 0),
          hint: 'Top up your wallet in the bot, then retry.',
        });
      }
      if (result.result === 'out_of_stock')      return fail(res, 409, 'Insufficient stock');
      if (result.result === 'already_processed') return fail(res, 409, 'Order already processed');
      return fail(res, 409, 'Order could not be processed');
    }

    db.addTransaction({
      userId: req.userId, type: 'purchase', amount: -total,
      description: `API order #${orderId}: ${cleanTitle(product.title)}`,
      refId: `api_${orderId}`, orderId,
    });
    db.consumeCustomerAllowance(orderId, req.userId, productId, pricing.specialUnits);

    const fresh = db.getUser(req.userId);
    logger.info(`[API v2] user ${req.userId} bought ${quantity}x product ${productId} for $${total}`);

    res.json({
      success: true,
      order: {
        id: orderId,
        product_id: productId,
        product: cleanTitle(product.title),
        quantity,
        unit_price: Number(Number(total / quantity).toFixed(6)),
        total,
        status: 'delivered',
        items: String(result.content || '').split('\n\n').filter(Boolean),
        balance: Number(Number(fresh?.balance || 0).toFixed(6)),
      },
    });
  } catch (e) {
    logger.error(`[API v2] /purchase: ${e.message}`);
    fail(res, 500, 'Internal error');
  } finally {
    IN_FLIGHT.delete(req.apiKey);
  }
});

// ── Compatibility aliases ────────────────────────────────────────────────────
// Other suppliers in this market expose `/me` for the balance and `/order` for
// the purchase. Mirroring those names means a reseller who already wrote code
// against another shop can point it here by changing only the base URL and key.
router.get('/me', requireKey, (req, res) => {
  const fresh = db.getUser(req.userId);
  res.json({
    success: true,
    user_id: req.userId,
    username: fresh?.username || null,
    balance: Number(Number(fresh?.balance || 0).toFixed(6)),
    currency: 'USD',
  });
});

// ── GET /orders ──────────────────────────────────────────────────────────────
router.get('/orders', requireKey, (req, res) => {
  try {
    const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const all = db.getUserOrdersAll(req.userId);
    res.json({
      success: true,
      total: all.length,
      orders: all.slice(offset, offset + limit).map((o) => ({
        id: o.id,
        product_id: o.product_id,
        product: cleanTitle(o.product_title),
        quantity: o.quantity,
        total: Number(o.total_price),
        status: o.status,
        created_at: o.created_at,
      })),
    });
  } catch (e) {
    logger.error(`[API v2] /orders: ${e.message}`);
    fail(res, 500, 'Internal error');
  }
});

// ── GET /order/:id ───────────────────────────────────────────────────────────
router.get('/order/:id', requireKey, (req, res) => {
  try {
    const order = db.getOrder(parseInt(req.params.id, 10));
    // Ownership check — a key can only ever read its own orders.
    if (!order || order.user_id !== req.userId) return fail(res, 404, 'Order not found');

    res.json({
      success: true,
      order: {
        id: order.id,
        product_id: order.product_id,
        product: cleanTitle(order.product_title),
        quantity: order.quantity,
        email: order.email || null,
        total: Number(order.total_price),
        status: order.status,
        created_at: order.created_at,
        items: order.delivered_content
          ? String(order.delivered_content).split('\n\n').filter(Boolean)
          : null,
      },
    });
  } catch (e) {
    logger.error(`[API v2] /order: ${e.message}`);
    fail(res, 500, 'Internal error');
  }
});

// ── GET /docs ────────────────────────────────────────────────────────────────
router.get('/docs', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}/api/v2`;
  res.json({
    name: 'Customer API v2',
    auth: 'Send header  X-API-Key: sk_...  — get your key from the bot menu (🔌 API Access)',
    note: 'Purchases are paid from your wallet balance. Top up in the bot first.',
    rate_limit: `${RATE_LIMIT} requests per minute`,
    endpoints: {
      'GET  /products':     `${base}/products`,
      'GET  /product/:id':  `${base}/product/1`,
      'GET  /balance':      `${base}/balance`,
      'GET  /me':           `${base}/me   (alias of /balance)`,
      'POST /purchase':     { url: `${base}/purchase`, body: { product_id: 1, quantity: 1, email: 'optional@mail.com' } },
      'POST /order':        `${base}/order   (alias of /purchase)`,
      'GET  /orders':       `${base}/orders?limit=20&offset=0`,
      'GET  /order/:id':    `${base}/order/123`,
    },
    errors: {
      401: 'Missing or invalid API key',
      402: 'Insufficient wallet balance — top up in the bot',
      403: 'Account suspended',
      404: 'Product or order not found',
      409: 'Insufficient stock, or the order was already processed',
      429: 'Rate limited, or a purchase from this key is still in flight',
    },
  });
});

module.exports = router;
