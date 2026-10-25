'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { readSeats } = require('../services/cgbSeatsQuery');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE chatgpt_subscriptions (
    id INTEGER PRIMARY KEY, order_id INTEGER, user_id INTEGER, email TEXT, status TEXT,
    start_date TEXT, end_date TEXT, days_remaining INTEGER, renewed_from INTEGER, created_at TEXT);
    INSERT INTO chatgpt_subscriptions VALUES
    (1,101,7,'Felipe@example.com','expired','2026-08-25','2026-09-24',30,NULL,'2026-08-25'),
    (2,102,7,'felipe@example.com','pending','2026-09-25','2026-11-20',57,1,'2026-10-25'),
    (3,103,7,'felipe@example.com','awaiting_payment','2026-11-21','2026-12-20',30,2,'2026-10-26'),
    (4,104,7,'felipe@example.com','cancelled','2026-11-21','2027-01-20',60,2,'2026-10-27'),
    (5,105,7,'felipe@example.com','active','2026-10-01','2027-02-20',140,NULL,'2026-10-28'),
    (6,106,8,'felipe@example.com','pending','2026-11-21','2027-03-20',120,2,'2026-10-29'),
    (7,107,7,'other@example.com','pending','2026-11-21','2027-04-20',150,2,'2026-10-30');`);
  return db;
}
test('September 24 cycle returns the paid November 20 renewal, even after the ancestor expires', () => {
  const db = fixture();
  try {
    const rows = readSeats(db, ['pending', 'active'], 24);
    assert.deepEqual(rows.map(r => r.order_id), [102]);
    assert.equal(rows[0].end_date, '2026-11-20');
  } finally { db.close(); }
});
test('renewal chain excludes unpaid, cancelled, unrelated purchases and other owners or emails', () => {
  const db = fixture();
  try { assert.deepEqual(readSeats(db, ['pending', 'active'], 24).map(r => r.order_id), [102]); }
  finally { db.close(); }
});
test('paid chained renewals remain visible after another day change', () => {
  const db = fixture();
  try {
    db.exec("UPDATE chatgpt_subscriptions SET status='active', end_date='2026-12-19' WHERE id=3");
    assert.deepEqual(readSeats(db, ['pending', 'active'], 24).map(r => r.end_date), ['2026-11-20','2026-12-19']);
  } finally { db.close(); }
});
test('unfiltered feed preserves the selected statuses', () => {
  const db = fixture();
  try { assert.deepEqual(readSeats(db, ['cancelled'], null).map(r => r.order_id), [104]); }
  finally { db.close(); }
});
test('authenticated seats handler serves the November 20 renewal and rejects a wrong secret', () => {
  const source = fs.readFileSync(path.join(__dirname, '../services/cgbGuard.js'), 'utf8');
  const context = {
    module: { exports: {} }, URL,
    process: { env: { GUARD_SECRET: 'synthetic-test-secret' } },
    require: name => {
      if (name === '../utils/logger') return { warn() {}, info() {} };
      if (name === './cgbRouting' || name === './cgbBots') return {};
      if (name === './cgbSeatsQuery') return { readSeats };
      throw new Error(`Unexpected import ${name}`);
    },
  };
  vm.runInNewContext(source, context);
  const db = fixture();
  try {
    const handler = context.module.exports.makeSeatsHandler({ db });
    const res = { code: 200, status(n) { this.code=n; return this; }, json(value) { this.body=value; return this; } };
    handler({ get: () => 'synthetic-test-secret', query: { end_day: '24' } }, res);
    assert.equal(res.code, 200);
    assert.equal(res.body.seats.length, 1);
    assert.equal(res.body.seats[0].end_date, '2026-11-20');
    assert.equal(res.body.seats[0].renewal, true);
    handler({ get: () => 'incorrect', query: { end_day: '24' } }, res);
    assert.equal(res.code, 401);
  } finally { db.close(); }
});