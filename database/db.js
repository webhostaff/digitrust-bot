'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const config = require('../config');

const dbDir = path.dirname(config.dbPath);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema creation ───────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY,
    telegram_id   INTEGER UNIQUE NOT NULL,
    username      TEXT,
    first_name    TEXT,
    last_name     TEXT,
    balance       REAL    DEFAULT 0.0,
    is_banned     INTEGER DEFAULT 0,
    created_at    TEXT    DEFAULT (datetime('now')),
    last_seen     TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS products (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    title           TEXT    NOT NULL,
    description     TEXT,
    warranty        TEXT,
    price           REAL    NOT NULL,
    image_file_id   TEXT,
    requires_email  INTEGER DEFAULT 1,
    is_active       INTEGER DEFAULT 1,
    sold_count      INTEGER DEFAULT 0,
    stock_quantity  INTEGER DEFAULT 0,
    sales_count     INTEGER DEFAULT 0,
    item_type       TEXT    DEFAULT 'key',
    bulk_min_qty    INTEGER DEFAULT 0,
    bulk_discount   REAL    DEFAULT 0,
    bulk_tier1_qty  INTEGER DEFAULT 0,
    bulk_tier1_price REAL   DEFAULT 0,
    bulk_tier2_qty  INTEGER DEFAULT 0,
    bulk_tier2_price REAL   DEFAULT 0,
    bulk_tier3_qty  INTEGER DEFAULT 0,
    bulk_tier3_price REAL   DEFAULT 0,
    created_at      TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS product_items (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id      INTEGER NOT NULL,
    item_type       TEXT    NOT NULL DEFAULT 'key',
    raw_content     TEXT    NOT NULL,
    email           TEXT,
    password        TEXT,
    recovery        TEXT,
    status          TEXT    NOT NULL DEFAULT 'available',
    sold_to_user_id INTEGER,
    sold_at         TEXT,
    order_id        INTEGER,
    created_at      TEXT    DEFAULT (datetime('now')),
    FOREIGN KEY (product_id) REFERENCES products(id)
  );

  CREATE TABLE IF NOT EXISTS stock (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id  INTEGER NOT NULL,
    content     TEXT    NOT NULL,
    is_sold     INTEGER DEFAULT 0,
    order_id    INTEGER,
    added_at    TEXT    DEFAULT (datetime('now')),
    sold_at     TEXT,
    FOREIGN KEY (product_id) REFERENCES products(id)
  );

  CREATE TABLE IF NOT EXISTS orders (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id           INTEGER NOT NULL,
    product_id        INTEGER NOT NULL,
    quantity          INTEGER NOT NULL,
    email             TEXT,
    total_price       REAL    NOT NULL,
    payment_method    TEXT,
    status            TEXT    DEFAULT 'pending',
    delivered_content TEXT,
    created_at        TEXT    DEFAULT (datetime('now')),
    paid_at           TEXT,
    FOREIGN KEY (user_id)    REFERENCES users(telegram_id),
    FOREIGN KEY (product_id) REFERENCES products(id)
  );

  CREATE TABLE IF NOT EXISTS categories (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL,
    emoji         TEXT    DEFAULT '',
    display_order INTEGER DEFAULT 999,
    is_active     INTEGER DEFAULT 1,
    created_at    TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS resellers (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    api_key       TEXT UNIQUE NOT NULL,
    balance       REAL DEFAULT 0,
    is_active     INTEGER DEFAULT 1,
    total_spent   REAL DEFAULT 0,
    orders_count  INTEGER DEFAULT 0,
    created_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS reseller_orders (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    reseller_id     INTEGER NOT NULL,
    product_id      INTEGER NOT NULL,
    quantity        INTEGER NOT NULL,
    unit_price      REAL NOT NULL,
    total           REAL NOT NULL,
    delivered_items TEXT,
    status          TEXT DEFAULT 'completed',
    created_at      TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_reseller_orders ON reseller_orders(reseller_id);

  CREATE TABLE IF NOT EXISTS billing_cycles (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    start_day     INTEGER NOT NULL,
    end_day       INTEGER NOT NULL,
    is_active     INTEGER DEFAULT 1,
    created_at    TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS chatgpt_subscriptions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id        INTEGER NOT NULL,
    user_id         INTEGER NOT NULL,
    email           TEXT,
    start_date      TEXT NOT NULL,
    end_date        TEXT NOT NULL,
    days_remaining  INTEGER NOT NULL,
    base_price      REAL NOT NULL,
    extra_month     INTEGER DEFAULT 0,
    final_price     REAL NOT NULL,
    status          TEXT DEFAULT 'pending',
    notified_3d     INTEGER DEFAULT 0,
    notified_1d     INTEGER DEFAULT 0,
    notified_0d     INTEGER DEFAULT 0,
    created_at      TEXT DEFAULT (datetime('now')),
    updated_at      TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL,
    type          TEXT    NOT NULL,
    amount        REAL    NOT NULL,
    description   TEXT,
    ref_id        TEXT    UNIQUE,
    order_id      INTEGER,
    status        TEXT    DEFAULT 'completed',
    created_at    TEXT    DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(telegram_id)
  );

  CREATE TABLE IF NOT EXISTS nowpayments_invoices (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_user_id INTEGER NOT NULL,
    order_id         TEXT    UNIQUE NOT NULL,
    amount           REAL    NOT NULL,
    invoice_id       TEXT,
    invoice_url      TEXT,
    payment_id       TEXT,
    payment_status   TEXT    DEFAULT 'waiting',
    tx_hash          TEXT,
    credited         INTEGER DEFAULT 0,
    purpose          TEXT    DEFAULT 'wallet_topup',
    related_order_id INTEGER,
    created_at       TEXT    DEFAULT (datetime('now')),
    updated_at       TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS pending_payments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id   INTEGER,
    user_id    INTEGER NOT NULL,
    amount     REAL    NOT NULL,
    type       TEXT    DEFAULT 'order',
    ref_id     TEXT,
    status     TEXT    DEFAULT 'waiting',
    created_at TEXT    DEFAULT (datetime('now')),
    FOREIGN KEY (order_id) REFERENCES orders(id)
  );

  CREATE TABLE IF NOT EXISTS support_tickets (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL,
    message     TEXT    NOT NULL,
    admin_reply TEXT,
    status      TEXT    DEFAULT 'open',
    created_at  TEXT    DEFAULT (datetime('now')),
    replied_at  TEXT,
    FOREIGN KEY (user_id) REFERENCES users(telegram_id)
  );

  CREATE TABLE IF NOT EXISTS referrals (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    referrer_id INTEGER NOT NULL,
    referred_id INTEGER NOT NULL UNIQUE,
    reward_paid INTEGER DEFAULT 0,
    created_at  TEXT    DEFAULT (datetime('now')),
    rewarded_at TEXT
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS cryptobot_invoices (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_user_id INTEGER NOT NULL,
    order_id         TEXT    UNIQUE NOT NULL,
    invoice_id       TEXT    NOT NULL,
    amount           REAL    NOT NULL,
    purpose          TEXT    NOT NULL DEFAULT 'wallet_topup',
    related_order_id INTEGER,
    invoice_url      TEXT,
    mini_app_url     TEXT,
    web_app_url      TEXT,
    paid_asset       TEXT,
    paid_amount      TEXT,
    paid_at          TEXT,
    credited         INTEGER DEFAULT 0,
    created_at       TEXT    DEFAULT (datetime('now')),
    updated_at       TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS back_in_stock_notifications (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    created_at TEXT    DEFAULT (datetime('now')),
    UNIQUE(user_id, product_id),
    FOREIGN KEY (user_id)    REFERENCES users(telegram_id),
    FOREIGN KEY (product_id) REFERENCES products(id)
  );

  CREATE TABLE IF NOT EXISTS bep20_deposits (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL,
    tx_hash     TEXT    NOT NULL UNIQUE,
    amount      REAL    NOT NULL,
    currency    TEXT    NOT NULL DEFAULT 'USDT',
    network     TEXT    NOT NULL DEFAULT 'BEP20',
    from_addr   TEXT,
    to_addr     TEXT,
    status      TEXT    NOT NULL DEFAULT 'completed',
    created_at  TEXT    DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(telegram_id)
  );

  -- Generic used-TxID table for Binance API verified deposits (TRC20 + BEP20 + Binance Pay orderIds).
  -- An identifier can never be used twice across the entire bot.
  CREATE TABLE IF NOT EXISTS refund_requests (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL,
    order_id        INTEGER NOT NULL,
    reason          TEXT,
    status          TEXT DEFAULT 'pending',
    amount          REAL DEFAULT 0,
    method          TEXT,
    admin_note      TEXT,
    created_at      TEXT DEFAULT (datetime('now')),
    resolved_at     TEXT,
    FOREIGN KEY (order_id) REFERENCES orders(id)
  );
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS used_txids (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    txid        TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    user_id     INTEGER NOT NULL,
    amount      REAL    NOT NULL,
    network     TEXT    NOT NULL,
    asset       TEXT    NOT NULL DEFAULT 'USDT',
    address     TEXT,
    created_at  TEXT    DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(telegram_id)
  );

  -- CryptoBot invoices (for wallet top-ups).
  -- Tracks invoice state so the webhook + manual checks can credit only once.
  CREATE TABLE IF NOT EXISTS cryptobot_invoices (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id    INTEGER NOT NULL UNIQUE,
    user_id       INTEGER NOT NULL,
    asset         TEXT    NOT NULL,
    amount        REAL    NOT NULL,
    status        TEXT    NOT NULL DEFAULT 'active', -- active | paid | expired
    pay_url       TEXT,
    credited      INTEGER DEFAULT 0,
    paid_at       TEXT,
    created_at    TEXT    DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(telegram_id)
  );
`);

// ── Live migrations for existing databases ────────────────────────────────────
const existingUserCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
if (!existingUserCols.includes('language')) db.exec("ALTER TABLE users ADD COLUMN language TEXT DEFAULT 'en'");
if (!existingUserCols.includes('is_vip')) db.exec('ALTER TABLE users ADD COLUMN is_vip INTEGER DEFAULT 0');
if (!existingUserCols.includes('vip_unlocked_at')) db.exec('ALTER TABLE users ADD COLUMN vip_unlocked_at TEXT DEFAULT NULL');

const existingProductCols = db.prepare('PRAGMA table_info(products)').all().map((c) => c.name);
if (!existingProductCols.includes('stock_quantity')) db.exec('ALTER TABLE products ADD COLUMN stock_quantity INTEGER DEFAULT 0');
if (!existingProductCols.includes('sales_count'))   db.exec('ALTER TABLE products ADD COLUMN sales_count INTEGER DEFAULT 0');
if (!existingProductCols.includes('item_type'))     db.exec("ALTER TABLE products ADD COLUMN item_type TEXT DEFAULT 'key'");
if (!existingProductCols.includes('bulk_min_qty'))  db.exec('ALTER TABLE products ADD COLUMN bulk_min_qty INTEGER DEFAULT 0');
if (!existingProductCols.includes('bulk_discount')) db.exec('ALTER TABLE products ADD COLUMN bulk_discount REAL DEFAULT 0');
if (!existingProductCols.includes('bulk_tier1_qty'))   db.exec('ALTER TABLE products ADD COLUMN bulk_tier1_qty INTEGER DEFAULT 0');
if (!existingProductCols.includes('bulk_tier1_price')) db.exec('ALTER TABLE products ADD COLUMN bulk_tier1_price REAL DEFAULT 0');
if (!existingProductCols.includes('bulk_tier2_qty'))   db.exec('ALTER TABLE products ADD COLUMN bulk_tier2_qty INTEGER DEFAULT 0');
if (!existingProductCols.includes('bulk_tier2_price')) db.exec('ALTER TABLE products ADD COLUMN bulk_tier2_price REAL DEFAULT 0');
if (!existingProductCols.includes('bulk_tier3_qty'))   db.exec('ALTER TABLE products ADD COLUMN bulk_tier3_qty INTEGER DEFAULT 0');
if (!existingProductCols.includes('bulk_tier3_price')) db.exec('ALTER TABLE products ADD COLUMN bulk_tier3_price REAL DEFAULT 0');
if (!existingProductCols.includes('instruction'))   db.exec('ALTER TABLE products ADD COLUMN instruction TEXT DEFAULT NULL');
if (!existingProductCols.includes('display_order')) db.exec('ALTER TABLE products ADD COLUMN display_order INTEGER DEFAULT 999');
if (!existingProductCols.includes('category_id'))   db.exec('ALTER TABLE products ADD COLUMN category_id INTEGER DEFAULT 0');
if (!existingProductCols.includes('wholesale_price')) db.exec('ALTER TABLE products ADD COLUMN wholesale_price REAL DEFAULT 0');
if (!existingProductCols.includes('is_chatgpt_business')) db.exec('ALTER TABLE products ADD COLUMN is_chatgpt_business INTEGER DEFAULT 0');
if (!existingProductCols.includes('last_sold_at'))         db.exec('ALTER TABLE products ADD COLUMN last_sold_at TEXT DEFAULT NULL');
if (!existingProductCols.includes('last_stale_reminder_at')) db.exec('ALTER TABLE products ADD COLUMN last_stale_reminder_at TEXT DEFAULT NULL');

// payment_proof was referenced by chatgpt-bot.js's confirmPayment() but never
// actually existed in the orders table — every UPDATE using it was silently
// failing inside a bare try/catch, so paid ChatGPT Business orders stayed at
// status='pending' forever even though the customer/admin saw a confirmation.
const existingOrderCols = db.prepare('PRAGMA table_info(orders)').all().map((c) => c.name);
if (!existingOrderCols.includes('payment_proof')) db.exec('ALTER TABLE orders ADD COLUMN payment_proof TEXT DEFAULT NULL');

// V66: Clean existing product titles (remove leading whitespace + zero-width chars)
try {
  const products = db.prepare('SELECT id, title FROM products').all();
  const updateStmt = db.prepare('UPDATE products SET title = ? WHERE id = ?');
  let cleaned = 0;
  for (const p of products) {
    if (!p.title) continue;
    const original = p.title;
    const cleaned_title = String(original)
      .replace(/\[emoji:\d+\]/g, '')
      .replace(/^[\s\u00A0\u200B\u200C\u200D\u2060\uFEFF]+/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleaned_title !== original) {
      updateStmt.run(cleaned_title, p.id);
      cleaned++;
    }
  }
  if (cleaned > 0) console.log(`[MIGRATION] Cleaned ${cleaned} product title(s)`);
} catch (e) {
  console.error('[MIGRATION] Title cleanup error:', e.message);
}
if (!existingProductCols.includes('preorder_enabled')) db.exec('ALTER TABLE products ADD COLUMN preorder_enabled INTEGER DEFAULT 0');
if (!existingProductCols.includes('preorder_max'))     db.exec('ALTER TABLE products ADD COLUMN preorder_max INTEGER DEFAULT 0');
if (!existingProductCols.includes('preorder_count'))   db.exec('ALTER TABLE products ADD COLUMN preorder_count INTEGER DEFAULT 0');
if (!existingProductCols.includes('cost_price'))       db.exec('ALTER TABLE products ADD COLUMN cost_price REAL DEFAULT 0');

// Refund requests new columns (V19)
try { const cols = db.prepare('PRAGMA table_info(refund_requests)').all().map(c => c.name);
  if (!cols.includes('affected_account')) db.exec("ALTER TABLE refund_requests ADD COLUMN affected_account TEXT DEFAULT NULL");
  if (!cols.includes('photo_file_id'))    db.exec("ALTER TABLE refund_requests ADD COLUMN photo_file_id TEXT DEFAULT NULL");
  if (!cols.includes('refund_method'))    db.exec("ALTER TABLE refund_requests ADD COLUMN refund_method TEXT DEFAULT NULL");
  if (!cols.includes('crypto_network'))   db.exec("ALTER TABLE refund_requests ADD COLUMN crypto_network TEXT DEFAULT NULL");
  if (!cols.includes('wallet_address'))   db.exec("ALTER TABLE refund_requests ADD COLUMN wallet_address TEXT DEFAULT NULL");
} catch (e) {}
if (!existingProductCols.includes('premium_emoji_id')) db.exec('ALTER TABLE products ADD COLUMN premium_emoji_id TEXT DEFAULT NULL');

// ── Default settings for referral cashback ─────────────────────────────
try {
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('referral_cashback_enabled', '1')").run();
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('referral_cashback_pct', '2')").run();
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('referral_min_order', '5')").run();
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('preorder_auto_deliver', '0')").run();
} catch (e) {}

// ── Preorders table ───────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS emoji_library (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT UNIQUE NOT NULL,
    emoji_id    TEXT NOT NULL,
    fallback    TEXT DEFAULT '🎁',
    created_at  TEXT DEFAULT (datetime('now'))
  );
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS preorders (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id        INTEGER,
    user_id         INTEGER NOT NULL,
    product_id      INTEGER NOT NULL,
    quantity        INTEGER NOT NULL,
    email           TEXT,
    total_paid      REAL    NOT NULL,
    payment_method  TEXT,
    status          TEXT    DEFAULT 'reserved',  -- reserved | delivered | refunded
    created_at      TEXT    DEFAULT (datetime('now')),
    delivered_at    TEXT,
    delivered_content TEXT,
    FOREIGN KEY (user_id)    REFERENCES users(telegram_id),
    FOREIGN KEY (product_id) REFERENCES products(id),
    FOREIGN KEY (order_id)   REFERENCES orders(id)
  );
`);


// ── Refunds table ─────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS refunds (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id        INTEGER NOT NULL UNIQUE,
    user_id         INTEGER NOT NULL,
    product_id      INTEGER NOT NULL,
    original_price  REAL    NOT NULL,
    refund_amount   REAL    NOT NULL,
    warranty_days   INTEGER NOT NULL,
    end_date        TEXT    NOT NULL,
    status          TEXT    DEFAULT 'completed',
    created_at      TEXT    DEFAULT (datetime('now')),
    FOREIGN KEY (order_id)   REFERENCES orders(id),
    FOREIGN KEY (user_id)    REFERENCES users(telegram_id),
    FOREIGN KEY (product_id) REFERENCES products(id)
  );
`);

// Migration for nowpayments_invoices: purpose + related_order_id
const existingNowCols = db.prepare('PRAGMA table_info(nowpayments_invoices)').all().map((c) => c.name);
if (!existingNowCols.includes('purpose')) {
  db.exec("ALTER TABLE nowpayments_invoices ADD COLUMN purpose TEXT DEFAULT 'wallet_topup'");
}
if (!existingNowCols.includes('related_order_id')) {
  db.exec('ALTER TABLE nowpayments_invoices ADD COLUMN related_order_id INTEGER');
}

// Migration for cryptobot_invoices: rebuild if the schema differs from expected.
// Older bot versions created this table with different column names (e.g.
// `telegram_user_id NOT NULL` instead of `user_id`). Rather than patch each
// possible legacy shape, we detect drift and rebuild the table cleanly.
// Data preservation: best-effort copy of any rows that match expected columns.
const expectedCryptobotCols = [
  'id', 'invoice_id', 'user_id', 'asset', 'amount',
  'status', 'pay_url', 'credited', 'paid_at', 'created_at',
];
const existingCryptobotCols = db.prepare('PRAGMA table_info(cryptobot_invoices)').all().map((c) => c.name);

if (existingCryptobotCols.length > 0) {
  const hasAllExpected   = expectedCryptobotCols.every((c) => existingCryptobotCols.includes(c));
  const hasLegacyColumns = existingCryptobotCols.some((c) => !expectedCryptobotCols.includes(c));

  if (!hasAllExpected || hasLegacyColumns) {
    // Rebuild the table from scratch with the correct schema.
    db.exec('BEGIN');
    try {
      db.exec('ALTER TABLE cryptobot_invoices RENAME TO cryptobot_invoices_old');
      db.exec(`
        CREATE TABLE cryptobot_invoices (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          invoice_id    INTEGER NOT NULL UNIQUE,
          user_id       INTEGER NOT NULL,
          asset         TEXT    NOT NULL,
          amount        REAL    NOT NULL,
          status        TEXT    NOT NULL DEFAULT 'active',
          pay_url       TEXT,
          credited      INTEGER DEFAULT 0,
          paid_at       TEXT,
          created_at    TEXT    DEFAULT (datetime('now')),
          FOREIGN KEY (user_id) REFERENCES users(telegram_id)
        )
      `);

      // Best-effort copy: only columns that exist in BOTH old and new.
      const commonCols = expectedCryptobotCols.filter((c) =>
        existingCryptobotCols.includes(c) && c !== 'id'
      );
      // If old table had `telegram_user_id` but no `user_id`, copy from it.
      if (existingCryptobotCols.includes('telegram_user_id') && !existingCryptobotCols.includes('user_id')) {
        const others = commonCols.filter((c) => c !== 'user_id');
        if (others.length > 0) {
          const cols = ['user_id', ...others].join(', ');
          const src  = ['telegram_user_id', ...others].join(', ');
          try { db.exec(`INSERT INTO cryptobot_invoices (${cols}) SELECT ${src} FROM cryptobot_invoices_old`); }
          catch (e) { /* ignore — keep going with a fresh empty table */ }
        }
      } else if (commonCols.length > 0) {
        const colList = commonCols.join(', ');
        try { db.exec(`INSERT INTO cryptobot_invoices (${colList}) SELECT ${colList} FROM cryptobot_invoices_old`); }
        catch (e) { /* ignore */ }
      }

      db.exec('DROP TABLE cryptobot_invoices_old');
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      // Last resort: drop the broken table; the CREATE TABLE IF NOT EXISTS at the
      // top of this file will recreate it on next boot.
      try { db.exec('DROP TABLE IF EXISTS cryptobot_invoices_old'); } catch {}
      try { db.exec('DROP TABLE IF EXISTS cryptobot_invoices'); } catch {}
      db.exec(`
        CREATE TABLE cryptobot_invoices (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          invoice_id    INTEGER NOT NULL UNIQUE,
          user_id       INTEGER NOT NULL,
          asset         TEXT    NOT NULL,
          amount        REAL    NOT NULL,
          status        TEXT    NOT NULL DEFAULT 'active',
          pay_url       TEXT,
          credited      INTEGER DEFAULT 0,
          paid_at       TEXT,
          created_at    TEXT    DEFAULT (datetime('now')),
          FOREIGN KEY (user_id) REFERENCES users(telegram_id)
        )
      `);
    }
  }
}

// ── Default settings ──────────────────────────────────────────────────────────
// ── Auto-enable Join Required when group/channel IDs are configured ──────────
// If either REQUIRED_GROUP_ID or REQUIRED_CHANNEL_ID is set in environment,
// join_required_enabled defaults to '1' automatically.
const autoJoinEnabled = (config.requiredGroupId || config.requiredChannelId) ? '1' : '0';

const defaultSettings = [
  ['store_name',                    config.storeName],
  ['welcome_message',               'Buy premium digital products instantly.'],
  ['support_message',               'Our team will respond within 24 hours.'],
  ['min_deposit',                   String(config.minDeposit)],
  ['maintenance_mode',              '0'],
  ['join_required_enabled',         autoJoinEnabled],
  ['required_group_id',             config.requiredGroupId],
  ['required_group_link',           config.requiredGroupLink],
  ['required_channel_id',           config.requiredChannelId],
  ['required_channel_link',         config.requiredChannelLink],
  ['updates_channel_id',            config.updatesChannelId],
  ['updates_group_id',              config.updatesGroupId],
  ['product_notifications_enabled', '1'],
  ['stock_notifications_enabled',   '1'],
  ['referral_reward',               String(config.referralReward)],
  ['stale_product_reminder_enabled',     '0'],
  ['stale_product_threshold_days',       '3'],
  ['stale_product_reminder_cooldown_hr', '24'],
];

const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of defaultSettings) insertSetting.run(k, v);

// ── Force-sync join-gate + updates targets from environment ──────────────────
// Every restart, env vars in Railway are the source of truth.
const upsertSetting = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
if (config.requiredGroupId || config.requiredChannelId) {
  upsertSetting.run('join_required_enabled', '1');
}
if (config.requiredGroupId)     upsertSetting.run('required_group_id',     config.requiredGroupId);
if (config.requiredGroupLink)   upsertSetting.run('required_group_link',   config.requiredGroupLink);
if (config.requiredChannelId)   upsertSetting.run('required_channel_id',   config.requiredChannelId);
if (config.requiredChannelLink) upsertSetting.run('required_channel_link', config.requiredChannelLink);
if (config.updatesChannelId)    upsertSetting.run('updates_channel_id',    config.updatesChannelId);
if (config.updatesGroupId)      upsertSetting.run('updates_group_id',      config.updatesGroupId);


// ── Seed defaults for ChatGPT Business ─────────────
try {
  const cycleCount = db.prepare('SELECT COUNT(*) AS n FROM billing_cycles').get().n;
  if (cycleCount === 0) {
    db.prepare('INSERT INTO billing_cycles (start_day, end_day) VALUES (?, ?)').run(26, 25);
    db.prepare('INSERT INTO billing_cycles (start_day, end_day) VALUES (?, ?)').run(16, 15);
    console.log('[SEED] Default billing cycles created (26-25, 16-15)');
  }
  const priceSet = db.prepare(`SELECT value FROM settings WHERE key='chatgpt_monthly_price'`).get();
  if (!priceSet) {
    db.prepare(`INSERT INTO settings (key, value) VALUES ('chatgpt_monthly_price', '50')`).run();
    console.log('[SEED] Default ChatGPT monthly price set to $50');
  }
} catch (e) { console.error('[SEED] Error:', e.message); }

// ══════════════════════════════════════════════════════════════════════════════
// V2 MIGRATIONS — support read-receipts, refund eligibility, manual delivery,
// stock alerts and the admin notification centre.
//
// Every statement below is additive and idempotent: new columns are only added
// when missing and new tables use CREATE TABLE IF NOT EXISTS, so running this
// against an existing production database never drops or rewrites data.
// ══════════════════════════════════════════════════════════════════════════════

// ── products: refund eligibility, delivery mode, stock alert config ──────────
{
  const cols = db.prepare('PRAGMA table_info(products)').all().map((c) => c.name);

  // Refund eligibility. Default 1 (=eligible) keeps the current behaviour for
  // every product that already exists; the admin opts individual items out.
  if (!cols.includes('refund_enabled')) {
    db.exec('ALTER TABLE products ADD COLUMN refund_enabled INTEGER DEFAULT 1');
  }
  // 'auto'   → stock is consumed and delivered instantly (existing behaviour)
  // 'manual' → payment is taken, then a manual-delivery task is opened for admin
  if (!cols.includes('delivery_type')) {
    db.exec("ALTER TABLE products ADD COLUMN delivery_type TEXT DEFAULT 'auto'");
  }
  // Per-product low-stock alert threshold. 0/NULL → fall back to the global setting.
  if (!cols.includes('low_stock_threshold')) {
    db.exec('ALTER TABLE products ADD COLUMN low_stock_threshold INTEGER DEFAULT 0');
  }
  // Latch flags so the same alert is never repeated while stock stays low/empty.
  // Both are reset to 0 the moment stock is replenished above the threshold.
  if (!cols.includes('oos_notified')) {
    db.exec('ALTER TABLE products ADD COLUMN oos_notified INTEGER DEFAULT 0');
  }
  if (!cols.includes('low_notified')) {
    db.exec('ALTER TABLE products ADD COLUMN low_notified INTEGER DEFAULT 0');
  }
}

// ── support_messages ─────────────────────────────────────────────────────────
// Created here (not only inside support-bot.js) so the main bot can read the
// unread counter even when SUPPORT_BOT_TOKEN is not configured.
db.exec(`
  CREATE TABLE IF NOT EXISTS support_messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL,
    username    TEXT,
    first_name  TEXT,
    direction   TEXT NOT NULL,
    content     TEXT,
    media_type  TEXT,
    file_id     TEXT,
    created_at  TEXT DEFAULT (datetime('now')),
    is_read     INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_support_msgs_user ON support_messages(user_id, id);
`);
{
  const cols = db.prepare('PRAGMA table_info(support_messages)').all().map((c) => c.name);
  // Exact moment support opened the message — powers the ✓✓ timestamp.
  if (!cols.includes('read_at')) {
    db.exec('ALTER TABLE support_messages ADD COLUMN read_at TEXT DEFAULT NULL');
  }
}

// ── support_threads ──────────────────────────────────────────────────────────
// One row per customer. Holds the delivery/read indicator state so ✓ → ✓✓
// survives a bot restart, and remembers whether the one-time welcome was sent.
db.exec(`
  CREATE TABLE IF NOT EXISTS support_threads (
    user_id              INTEGER PRIMARY KEY,
    welcomed             INTEGER DEFAULT 0,
    status_msg_id        INTEGER,
    status_state         TEXT    DEFAULT 'none',
    pending_count        INTEGER DEFAULT 0,
    last_customer_msg_at TEXT,
    last_read_at         TEXT,
    created_at           TEXT    DEFAULT (datetime('now'))
  );
`);

// ── manual_deliveries ────────────────────────────────────────────────────────
// A paid order that needs a human to hand over the product.
// UNIQUE(order_id) is the duplicate guard: an order can never open two tasks.
db.exec(`
  CREATE TABLE IF NOT EXISTS manual_deliveries (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id          INTEGER NOT NULL UNIQUE,
    user_id           INTEGER NOT NULL,
    product_id        INTEGER NOT NULL,
    quantity          INTEGER NOT NULL,
    email             TEXT,
    total_paid        REAL    NOT NULL,
    payment_method    TEXT,
    status            TEXT    DEFAULT 'pending',
    admin_note        TEXT,
    delivered_content TEXT,
    notified_at       TEXT,
    seen_at           TEXT,
    created_at        TEXT    DEFAULT (datetime('now')),
    updated_at        TEXT    DEFAULT (datetime('now')),
    delivered_at      TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_manual_status ON manual_deliveries(status, id);
  CREATE INDEX IF NOT EXISTS idx_manual_user   ON manual_deliveries(user_id);
`);

// ── admin_notifications ──────────────────────────────────────────────────────
// Persistent inbox for the admin. dedupe_key is UNIQUE, so INSERT OR IGNORE
// makes every notification write idempotent — the same event can fire twice
// (webhook retry, double click) and only one row is ever stored.
db.exec(`
  CREATE TABLE IF NOT EXISTS admin_notifications (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    type        TEXT    NOT NULL,
    title       TEXT    NOT NULL,
    body        TEXT,
    ref_type    TEXT,
    ref_id      TEXT,
    dedupe_key  TEXT    UNIQUE,
    is_read     INTEGER DEFAULT 0,
    created_at  TEXT    DEFAULT (datetime('now')),
    read_at     TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_admin_notif_unread ON admin_notifications(is_read, id);
`);

// ── Default settings for the new features ────────────────────────────────────
try {
  const ins = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  ins.run('low_stock_threshold_default', '5');   // used when a product has none of its own
  ins.run('admin_notify_enabled',        '1');   // master switch for admin push messages
  ins.run('admin_notify_chat_id',        '');    // optional private admin channel/group
  ins.run('support_welcome_message',
    '👋 Welcome to Customer Support!\n\n' +
    'Send your question or issue here and our team will reply as soon as possible.\n\n' +
    'You can send text, photos or voice messages.');
} catch (e) {
  console.error('[MIGRATION V2] settings seed error:', e.message);
}

// ══════════════════════════════════════════════════════════════════════════════
// V3 SECURITY MIGRATIONS — deposit ownership binding
//
// Background: the USDT deposit address is a single SHARED address. Every
// transaction sent to it is publicly visible on BscScan / Tronscan, including
// its TxID, amount and timestamp. Treating "knows the TxID" as proof of
// ownership is therefore not authentication at all — anyone can read the
// explorer and claim any transfer that has not been claimed yet.
//
// The fix is amount reservation: before transferring, a user reserves a UNIQUE
// amount (base + random 6-decimal suffix) for a limited time. A deposit is then
// matched to that reservation by (network + exact amount + time window), so a
// stolen TxID no longer proves anything — the thief's own reservation will not
// match the amount they are trying to claim.
// ══════════════════════════════════════════════════════════════════════════════

db.exec(`
  CREATE TABLE IF NOT EXISTS deposit_intents (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL,
    network       TEXT    NOT NULL,
    base_amount   REAL    NOT NULL,
    unique_amount REAL    NOT NULL,
    status        TEXT    DEFAULT 'open',
    created_ms    INTEGER NOT NULL,
    expires_ms    INTEGER NOT NULL,
    claimed_txid  TEXT,
    claimed_at    TEXT,
    created_at    TEXT    DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_intent_lookup ON deposit_intents(status, network, unique_amount);
  CREATE INDEX IF NOT EXISTS idx_intent_user   ON deposit_intents(user_id, status);
`);

// Two people must never be able to hold the same reservation at the same time.
// A partial UNIQUE index enforces that only among rows that are still open.
try {
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_intent_open_unique
    ON deposit_intents(network, unique_amount) WHERE status = 'open';
  `);
} catch (e) {
  console.error('[MIGRATION V3] partial index error:', e.message);
}

// Deposits that arrived but match no reservation. They are NEVER auto-credited;
// the admin reviews each one and approves it to the rightful owner.
db.exec(`
  CREATE TABLE IF NOT EXISTS deposit_reviews (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    txid        TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    user_id     INTEGER NOT NULL,
    amount      REAL    NOT NULL,
    network     TEXT,
    address     TEXT,
    insert_time INTEGER,
    reason      TEXT,
    status      TEXT    DEFAULT 'pending',
    admin_note  TEXT,
    admin_id    INTEGER,
    created_at  TEXT    DEFAULT (datetime('now')),
    resolved_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_dep_review_status ON deposit_reviews(status, id);
`);

// Audit trail for every balance reversal an admin performs.
db.exec(`
  CREATE TABLE IF NOT EXISTS balance_reversals (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id        INTEGER NOT NULL,
    amount         REAL    NOT NULL,
    txid           TEXT,
    reason         TEXT,
    admin_id       INTEGER,
    balance_before REAL,
    balance_after  REAL,
    created_at     TEXT    DEFAULT (datetime('now'))
  );
`);

try {
  const ins = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  // How old an on-chain deposit may be when its TxID is submitted.
  // Deliberately tight. A transfer older than this can no longer be claimed
  // automatically — this is the control that stops harvested TxIDs. Legitimate
  // stragglers are NOT lost: they fall through to the manual review queue.
  ins.run('deposit_max_age_minutes', '15');
  // 1 = require a matching reservation (SECURE). 0 = legacy behaviour (UNSAFE).
  ins.run('deposit_strict_mode', '1');
  // How long a reserved amount stays valid.
  ins.run('deposit_intent_ttl_minutes', '30');
} catch (e) {
  console.error('[MIGRATION V3] settings seed error:', e.message);
}

// Deposits Binance has seen but not yet credited (status != 1). Recorded so
// support can see who is waiting, instead of finding out from a complaint.
// The row is removed as soon as the deposit clears.
db.exec(`
  CREATE TABLE IF NOT EXISTS pending_deposits (
    txid        TEXT PRIMARY KEY COLLATE NOCASE,
    user_id     INTEGER NOT NULL,
    amount      REAL,
    network     TEXT,
    insert_time INTEGER,
    attempts    INTEGER DEFAULT 1,
    first_seen  TEXT DEFAULT (datetime('now')),
    last_seen   TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_pending_dep_user ON pending_deposits(user_id);
`);

module.exports = db;
