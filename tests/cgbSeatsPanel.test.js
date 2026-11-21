'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { readSeats } = require('../services/cgbSeatsQuery');

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE chatgpt_subscriptions (
    id INTEGER PRIMARY KEY, order_id INTEGER, user_id INTEGER, email TEXT, status TEXT,
    start_date TEXT, end_date TEXT, days_remaining INTEGER, renewed_from INTEGER, created_at TEXT);
    CREATE TABLE cgb_seat_panels (sub_id INTEGER PRIMARY KEY, panel_id TEXT NOT NULL, set_at TEXT);
    INSERT INTO chatgpt_subscriptions VALUES
    (1,201,7,'stay@example.com','active','2026-10-25','2026-11-24',30,NULL,'2026-10-25'),
    (2,202,8,'solarcity@jaswc.org','active','2026-09-25','2027-08-24',300,NULL,'2026-09-25'),
    (3,203,9,'moved@example.com','active','2026-10-21','2026-11-20',30,NULL,'2026-10-21'),
    (4,204,9,'moved@example.com','pending','2026-11-21','2026-12-19',28,3,'2026-10-30');
    INSERT INTO cgb_seat_panels (sub_id, panel_id) VALUES (2,'panel22'), (3,'panel26');`);
  return db;
}
const emails = (rows) => rows.map((r) => r.email).sort();

test('a seat moved with Change panel is listed for its new panel, with its renewal', () => {
  const db = fixture();
  try { assert.deepEqual(emails(readSeats(db, ['pending', 'active'], 24, 'panel26')), ['moved@example.com', 'moved@example.com', 'stay@example.com']); }
  finally { db.close(); }
});
test('the old panel no longer lists a seat moved away', () => {
  const db = fixture();
  try { assert.deepEqual(emails(readSeats(db, ['pending', 'active'], 20, 'panel20')), []); }
  finally { db.close(); }
});
test('the destination panel 22 lists the moved day-24 order', () => {
  const db = fixture();
  try {
    const got = emails(readSeats(db, ['pending', 'active'], 20, 'panel22'));
    assert.ok(got.includes('solarcity@jaswc.org'));
    assert.ok(!got.includes('moved@example.com'));
  } finally { db.close(); }
});
test('without a panel the feed is the old day-only list', () => {
  const db = fixture();
  try { assert.deepEqual(emails(readSeats(db, ['pending', 'active'], 24)), ['solarcity@jaswc.org', 'stay@example.com']); }
  finally { db.close(); }
});
