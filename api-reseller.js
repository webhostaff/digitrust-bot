'use strict';

/**
 * 🏪 RESELLER API
 * 
 * Endpoints:
 *   GET  /api/v1/products     → list products with wholesale prices + stock
 *   GET  /api/v1/balance       → reseller's current balance
 *   POST /api/v1/order         → place order (deducts balance, returns items)
 *   GET  /api/v1/orders        → reseller's order history
 *   GET  /api/v1/product/:id   → single product details
 * 
 * Auth: Header `X-API-Key: <reseller_api_key>`
 */

const express = require('express');
const db = require('./database/queries');
const dbRaw = require('./database/db');
const items = require('./database/items');
const logger = require('./utils/logger');

const router = express.Router();
router.use(express.json({ limit: '1mb' }));

// ── Rate limiting: max 20 requests / 10 seconds per API key ──────────────────
// In-memory (no extra dependency) — resets on deploy, which is fine for abuse protection.
const RATE_WINDOW_MS = 10_000;
const RATE_MAX_REQ   = 20;
const rateBuckets     = new Map(); // apiKey -> { count, windowStart }

function checkRateLimit(apiKey) {
  const now = Date.now();
  let bucket = rateBuckets.get(apiKey);
  if (!bucket || now - bucket.windowStart > RATE_WINDOW_MS) {
    bucket = { count: 0, windowStart: now };
    rateBuckets.set(apiKey, bucket);
  }
  bucket.count++;
  return bucket.count <= RATE_MAX_REQ;
}

// Clean up stale buckets every 5 minutes to avoid unbounded memory growth
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets.entries()) {
    if (now - bucket.windowStart > RATE_WINDOW_MS * 6) rateBuckets.delete(key);
  }
}, 5 * 60_000);

// ── Per-key in-flight lock: prevents the SAME key from racing itself ────────
// (two parallel POST /order calls with the same key, same instant)
const PROCESSING_KEYS = new Set();

// ── Auth middleware ──
function requireApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace(/^Bearer /, '');
  if (!apiKey) return res.status(401).json({ error: 'Missing X-API-Key header' });

  if (!checkRateLimit(apiKey)) {
    return res.status(429).json({ error: 'Rate limit exceeded. Max 20 requests per 10 seconds.' });
  }

  const reseller = db.getResellerByApiKey(apiKey);
  if (!reseller) return res.status(401).json({ error: 'Invalid or inactive API key' });

  req.reseller = reseller;
  req.apiKey   = apiKey;
  next();
}

// ── Standard error response ──
function err(res, code, msg) {
  return res.status(code).json({ error: msg });
}

// ────────────────────────────────────────────────
// GET /api/v1/products — list products
// ────────────────────────────────────────────────
router.get('/products', requireApiKey, (req, res) => {
  try {
    const products = db.getAllActiveProducts();
    const result = products.map(p => ({
      id: p.id,
      title: String(p.title || '').replace(/\[emoji:\d+\]/g, '').trim(),
      description: p.description || '',
      retail_price: Number(p.price) || 0,
      wholesale_price: Number(p.wholesale_price) || 0,
      stock: Number(p.stock_count || p.stock_quantity || 0),
      available: (p.wholesale_price > 0) && ((p.stock_count || p.stock_quantity || 0) > 0),
    }));
    res.json({ success: true, count: result.length, products: result });
  } catch (e) {
    logger.error('API /products: ' + e.message);
    err(res, 500, 'Server error');
  }
});

// ────────────────────────────────────────────────
// GET /api/v1/product/:id
// ────────────────────────────────────────────────
router.get('/product/:id', requireApiKey, (req, res) => {
  try {
    const p = dbRaw.prepare(`
      SELECT p.*, COALESCE((SELECT COUNT(*) FROM product_items WHERE product_id=p.id AND status='available'), 0) AS stock
      FROM products p WHERE p.id = ? AND p.is_active = 1
    `).get(req.params.id);
    if (!p) return err(res, 404, 'Product not found');
    res.json({
      success: true,
      product: {
        id: p.id,
        title: String(p.title || '').replace(/\[emoji:\d+\]/g, '').trim(),
        description: p.description || '',
        retail_price: Number(p.price) || 0,
        wholesale_price: Number(p.wholesale_price) || 0,
        stock: Number(p.stock),
        available: (p.wholesale_price > 0) && (p.stock > 0),
      },
    });
  } catch (e) {
    err(res, 500, 'Server error');
  }
});

// ────────────────────────────────────────────────
// GET /api/v1/balance
// ────────────────────────────────────────────────
router.get('/balance', requireApiKey, (req, res) => {
  res.json({
    success: true,
    reseller: {
      id: req.reseller.id,
      name: req.reseller.name,
      balance: Number(req.reseller.balance) || 0,
      total_spent: Number(req.reseller.total_spent) || 0,
      orders_count: req.reseller.orders_count,
    },
  });
});

// ────────────────────────────────────────────────
// POST /api/v1/order
// Body: { product_id, quantity }
// ────────────────────────────────────────────────
router.post('/order', requireApiKey, (req, res) => {
  // Prevent the same API key from firing two concurrent orders that race each other
  if (PROCESSING_KEYS.has(req.apiKey)) {
    return err(res, 429, 'Another order from this key is still processing — please wait');
  }
  PROCESSING_KEYS.add(req.apiKey);

  try {
    const productId = parseInt(req.body.product_id, 10);
    const quantity = parseInt(req.body.quantity, 10);
    if (!productId || !quantity || quantity < 1) {
      return err(res, 400, 'Invalid product_id or quantity');
    }
    if (quantity > 50) return err(res, 400, 'Max 50 per order');

    const product = dbRaw.prepare(`SELECT * FROM products WHERE id = ? AND is_active = 1`).get(productId);
    if (!product) return err(res, 404, 'Product not found');

    const wholesale = Number(product.wholesale_price) || 0;
    if (wholesale <= 0) return err(res, 400, 'Product not available for resale');

    const total = Number((wholesale * quantity).toFixed(4));

    // Atomic transaction
    const txResult = dbRaw.transaction(() => {
      // Re-fetch reseller (balance might have changed)
      const r = db.getResellerById(req.reseller.id);
      if (!r || !r.is_active) throw new Error('Account inactive');
      if (Number(r.balance) < total) {
        throw new Error(`Insufficient balance: need ${total.toFixed(2)}, have ${Number(r.balance).toFixed(2)}`);
      }

      // Check stock
      const available = dbRaw.prepare(`
        SELECT id, raw_content FROM product_items WHERE product_id = ? AND status = 'available' ORDER BY id LIMIT ?
      `).all(productId, quantity);
      if (available.length < quantity) {
        throw new Error(`Out of stock: requested ${quantity}, available ${available.length}`);
      }

      // Mark items sold — track sold_to_user_id and order_id like the bot does (avoids orphaned records)
      const ids = available.map(i => i.id);
      const placeholders = ids.map(() => '?').join(',');
      dbRaw.prepare(`
        UPDATE product_items
        SET status='sold', sold_at=datetime('now'), sold_to_user_id=?, order_id=NULL
        WHERE id IN (${placeholders})
      `).run(req.reseller.id, ...ids);

      // Decrement stock_quantity
      dbRaw.prepare(`UPDATE products SET stock_quantity = MAX(0, stock_quantity - ?) WHERE id = ?`).run(quantity, productId);

      // Reset staleness — this counts as a real sale for the stale-product reminder feature
      dbRaw.prepare(`UPDATE products SET last_sold_at = datetime('now') WHERE id = ?`).run(productId);

      // Deduct balance + record sale
      db.chargeReseller(req.reseller.id, total);

      // Save reseller order
      const itemsStr = available.map(i => i.raw_content).join('\n');
      const orderResult = db.createResellerOrder(req.reseller.id, productId, quantity, wholesale, total, itemsStr);

      return {
        order_id: orderResult.lastInsertRowid,
        items: available.map(i => i.raw_content),
        new_balance: Number(r.balance) - total,
      };
    })();

    res.json({
      success: true,
      order: {
        id: txResult.order_id,
        product_id: productId,
        product_title: String(product.title || '').replace(/\[emoji:\d+\]/g, '').trim(),
        quantity,
        unit_price: wholesale,
        total,
        items: txResult.items,
        new_balance: Number(txResult.new_balance.toFixed(4)),
      },
    });

    logger.info(`[RESELLER ${req.reseller.name}] Order #${txResult.order_id}: ${quantity}× product #${productId} for $${total}`);
  } catch (e) {
    err(res, 400, e.message);
  } finally {
    PROCESSING_KEYS.delete(req.apiKey);
  }
});

// ────────────────────────────────────────────────
// GET /api/v1/orders — order history
// ────────────────────────────────────────────────
router.get('/orders', requireApiKey, (req, res) => {
  try {
    const orders = db.getResellerOrders(req.reseller.id);
    res.json({
      success: true,
      count: orders.length,
      orders: orders.map(o => ({
        id: o.id,
        product_id: o.product_id,
        product_title: o.product_title,
        quantity: o.quantity,
        unit_price: o.unit_price,
        total: o.total,
        status: o.status,
        items: (o.delivered_items || '').split('\n').filter(Boolean),
        created_at: o.created_at,
      })),
    });
  } catch (e) {
    err(res, 500, 'Server error');
  }
});

// ────────────────────────────────────────────────
// GET /api/docs — public API documentation
// ────────────────────────────────────────────────
router.get('/docs', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Reseller API Docs</title>
<style>
body { font-family: -apple-system, sans-serif; max-width: 900px; margin: 40px auto; padding: 20px; color: #2d3748; }
h1 { color: #667eea; }
h2 { border-bottom: 2px solid #667eea; padding-bottom: 6px; margin-top: 30px; }
code { background: #f7fafc; padding: 2px 6px; border-radius: 4px; font-size: 0.95em; }
pre { background: #1a202c; color: #f7fafc; padding: 16px; border-radius: 8px; overflow-x: auto; }
.method { display: inline-block; padding: 3px 10px; border-radius: 4px; color: white; font-weight: bold; font-size: 0.85em; }
.get { background: #38a169; } .post { background: #d69e2e; }
.endpoint { background: #f7fafc; padding: 4px 10px; border-radius: 4px; font-family: monospace; }
.warn { background: #fed7d7; padding: 10px; border-radius: 6px; color: #742a2a; }
</style></head><body>
<h1>🏪 DIGITRUST Reseller API</h1>
<p>RESTful API for resellers to purchase products programmatically.</p>

<div class="warn">
🔑 <b>Authentication:</b> Add header <code>X-API-Key: YOUR_KEY</code> to every request.<br>
Contact admin for an API key.
</div>

<h2>Base URL</h2>
<pre>https://YOUR-RAILWAY-URL.up.railway.app/api/v1</pre>

<h2>1. List Products</h2>
<p><span class="method get">GET</span> <span class="endpoint">/products</span></p>
<pre>curl -H "X-API-Key: YOUR_KEY" https://yourbot.railway.app/api/v1/products</pre>
<p><b>Response:</b></p>
<pre>{
  "success": true,
  "count": 3,
  "products": [
    {
      "id": 1,
      "title": "Netflix Premium",
      "wholesale_price": 4.00,
      "retail_price": 5.00,
      "stock": 12,
      "available": true
    }
  ]
}</pre>

<h2>2. Check Balance</h2>
<p><span class="method get">GET</span> <span class="endpoint">/balance</span></p>
<pre>{
  "success": true,
  "reseller": {
    "name": "MyShop",
    "balance": 50.00,
    "total_spent": 120.00,
    "orders_count": 24
  }
}</pre>

<h2>3. Place Order</h2>
<p><span class="method post">POST</span> <span class="endpoint">/order</span></p>
<pre>curl -X POST -H "X-API-Key: YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"product_id": 1, "quantity": 2}' \\
  https://yourbot.railway.app/api/v1/order</pre>
<p><b>Response (success):</b></p>
<pre>{
  "success": true,
  "order": {
    "id": 1234,
    "product_id": 1,
    "product_title": "Netflix Premium",
    "quantity": 2,
    "unit_price": 4.00,
    "total": 8.00,
    "items": [
      "user1@mail.com:pass1",
      "user2@mail.com:pass2"
    ],
    "new_balance": 42.00
  }
}</pre>
<p><b>Errors:</b></p>
<pre>// Insufficient balance
{ "error": "Insufficient balance: need 8.00, have 5.00" }

// Out of stock
{ "error": "Out of stock: requested 5, available 2" }

// Invalid key
{ "error": "Invalid or inactive API key" }</pre>

<h2>4. Order History</h2>
<p><span class="method get">GET</span> <span class="endpoint">/orders</span></p>
<pre>{
  "success": true,
  "count": 24,
  "orders": [{ ... }]
}</pre>

<h2>5. Product Details</h2>
<p><span class="method get">GET</span> <span class="endpoint">/product/:id</span></p>

<h2>Rate Limits</h2>
<p>Max 50 items per single order. Contact admin for higher limits.</p>

<h2>Need Help?</h2>
<p>Contact admin via main bot Support.</p>
</body></html>`);
});

module.exports = router;
