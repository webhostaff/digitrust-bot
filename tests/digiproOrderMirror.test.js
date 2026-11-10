'use strict';
// V167.8 — DigiPro purchases must show up as real orders: in the customer's
// "My Orders" screen and in the admin's Profit Reports / Binance report. Both
// screens read straight off the `orders` table, so this tests the mirroring
// itself (charge -> order created; refund -> order cancelled) rather than the
// screens, which were already confirmed generic over by inspection.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digipro-mirror-'));
  process.env.DB_PATH = path.join(dir, 'store.db');
  delete require.cache[require.resolve('../config')];
  delete require.cache[require.resolve('../database/db')];
  delete require.cache[require.resolve('../database/queries')];
  const db = require('../database/db');
  const queries = require('../database/queries');
  return { dir, db, queries };
}

function fakeReqRes(body) {
  const headers = { 'X-Digipro-Ts': body.__ts, 'X-Digipro-Sign': body.__sign };
  const req = { body, get: (h) => headers[h] };
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return { req, res };
}

function makeLink({ db, queries }, overrides = {}) {
  const { makeHandler, sign } = require('../services/digiproLink');
  const secret = 'test-secret';
  const now = () => overrides.nowMs || Date.now();
  const deps = {
    secret,
    queries,
    dbRaw: db,
    notifyAdmins: async () => {},
    logger: { info() {}, warn() {}, error() {} },
    now,
    ...overrides,
  };
  async function call(action, fields) {
    const ts = String(Math.floor(now() / 1000));
    const userId = Number(fields.user_id);
    const cents = action === 'balance' ? 0 : Number(fields.amount_cents);
    const ref = action === 'balance' ? '' : String(fields.ref || '');
    const signature = sign(secret, ts, action, userId, cents, ref);
    const { req, res } = fakeReqRes({ ...fields, __ts: ts, __sign: signature });
    await makeHandler(action, deps)(req, res);
    return res;
  }
  return { call, deps };
}

test('a charge mirrors a delivered order the customer and admin both see', async () => {
  const ctx = freshDb();
  const { db, queries } = ctx;
  db.prepare("INSERT INTO users (telegram_id, balance) VALUES (?, ?)").run(555, 50);
  const productId = db.prepare(
    "INSERT INTO products (title, price, is_digipro, unlimited_stock) VALUES ('DigiPro Activation', 5, 1, 1)"
  ).run().lastInsertRowid;

  const { call } = makeLink(ctx);
  const res = await call('charge', { user_id: 555, amount_cents: 500, ref: 'abc12345', title: 'Google activation' });

  assert.equal(res.body.ok, true);
  const order = db.prepare('SELECT * FROM orders WHERE user_id = ?').get(555);
  assert.ok(order, 'order row should exist');
  assert.equal(order.status, 'delivered');
  assert.equal(order.product_id, productId);
  assert.equal(order.source, 'digipro');
  assert.equal(order.total_price, 5);

  // Customer's "My Orders" and admin's Profit Reports both filter/join generically
  // off `orders` — confirm the mirrored row actually satisfies that shape.
  const forCustomer = db.prepare(
    `SELECT o.*, p.title AS product_title FROM orders o LEFT JOIN products p ON o.product_id = p.id WHERE o.user_id = ?`
  ).get(555);
  assert.equal(forCustomer.product_title, 'DigiPro Activation');
  const profitRow = db.prepare(
    `SELECT SUM(total_price) AS total FROM orders WHERE status = 'delivered'`
  ).get();
  assert.equal(profitRow.total, 5);

  fs.rmSync(ctx.dir, { recursive: true, force: true });
});

test('a retried charge with the same ref never mirrors a second order', async () => {
  const ctx = freshDb();
  const { db } = ctx;
  db.prepare("INSERT INTO users (telegram_id, balance) VALUES (?, ?)").run(555, 50);
  db.prepare("INSERT INTO products (title, price, is_digipro, unlimited_stock) VALUES ('DigiPro Activation', 5, 1, 1)").run();

  const { call } = makeLink(ctx);
  await call('charge', { user_id: 555, amount_cents: 500, ref: 'dupe1234', title: 'Google activation' });
  const res2 = await call('charge', { user_id: 555, amount_cents: 500, ref: 'dupe1234', title: 'Google activation' });

  assert.equal(res2.body.duplicate, true);
  const count = db.prepare('SELECT COUNT(*) AS c FROM orders').get().c;
  assert.equal(count, 1);

  fs.rmSync(ctx.dir, { recursive: true, force: true });
});

test('a refund cancels the mirrored order', async () => {
  const ctx = freshDb();
  const { db } = ctx;
  db.prepare("INSERT INTO users (telegram_id, balance) VALUES (?, ?)").run(555, 50);
  db.prepare("INSERT INTO products (title, price, is_digipro, unlimited_stock) VALUES ('DigiPro Activation', 5, 1, 1)").run();

  const { call } = makeLink(ctx);
  await call('charge', { user_id: 555, amount_cents: 500, ref: 'ref00001', title: 'Google activation' });
  const resRefund = await call('refund', { user_id: 555, amount_cents: 500, ref: 'ref00001' });

  assert.equal(resRefund.body.ok, true);
  const order = db.prepare('SELECT * FROM orders WHERE user_id = ?').get(555);
  assert.equal(order.status, 'cancelled');
  assert.match(order.delivered_content, /Refunded/);

  fs.rmSync(ctx.dir, { recursive: true, force: true });
});

test('a charge still succeeds even if no is_digipro product exists yet', async () => {
  const ctx = freshDb();
  const { db } = ctx;
  db.prepare("INSERT INTO users (telegram_id, balance) VALUES (?, ?)").run(555, 50);
  // No product marked is_digipro — mirroring has nothing to attach to.

  const { call } = makeLink(ctx);
  const res = await call('charge', { user_id: 555, amount_cents: 500, ref: 'noprod01', title: 'Google activation' });

  assert.equal(res.body.ok, true, 'the wallet charge itself must never be blocked by a mirroring problem');
  const count = db.prepare('SELECT COUNT(*) AS c FROM orders').get().c;
  assert.equal(count, 0);

  fs.rmSync(ctx.dir, { recursive: true, force: true });
});

test('refunding a ref that was never mirrored (or already cancelled) does not throw', async () => {
  const ctx = freshDb();
  const { db } = ctx;
  db.prepare("INSERT INTO users (telegram_id, balance) VALUES (?, ?)").run(555, 50);
  db.prepare("INSERT INTO products (title, price, is_digipro, unlimited_stock) VALUES ('DigiPro Activation', 5, 1, 1)").run();

  const { call } = makeLink(ctx);
  // Nothing was ever charged for this ref, so there's no matching transaction —
  // the handler reports no_matching_charge, and must not throw either way.
  const res = await call('refund', { user_id: 555, amount_cents: 500, ref: 'ghost001' });
  assert.equal(res.body.ok, false);
  assert.equal(res.body.reason, 'no_matching_charge');

  fs.rmSync(ctx.dir, { recursive: true, force: true });
});
