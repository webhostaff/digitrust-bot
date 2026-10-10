'use strict';

const sessions = new Map();

const States = {
  IDLE: 'IDLE',
  ADMIN_SEARCH_ORDER: 'ADMIN_SEARCH_ORDER',

  // Buy flow
  BUY_QUANTITY:   'BUY_QUANTITY',
  BUY_EMAIL:      'BUY_EMAIL',
  BUY_BINANCE_ORDER_ID: 'BUY_BINANCE_ORDER_ID', // pay with Binance Pay
  BUY_USDT_TXID:        'BUY_USDT_TXID',        // pay with USDT TxID
  BUY_CRYPTOBOT_WAIT:   'BUY_CRYPTOBOT_WAIT',   // waiting for CryptoBot invoice payment

  // Wallet top-up flows
  WALLET_TOPUP_USDT_TX:          'WALLET_TOPUP_USDT_TX',          // user sends TxID (TRC20/BEP20)
  WALLET_TOPUP_BINANCE_ID:       'WALLET_TOPUP_BINANCE_ID',       // user sends Binance Pay Order ID
  WALLET_TOPUP_CRYPTOBOT_AMOUNT: 'WALLET_TOPUP_CRYPTOBOT_AMOUNT', // user types USDT amount

  // Support
  SUPPORT_MESSAGE: 'SUPPORT_MESSAGE',

  // Admin — product wizard
  ADMIN_ADD_TITLE:       'ADMIN_ADD_TITLE',
  ADMIN_ADD_DESCRIPTION: 'ADMIN_ADD_DESCRIPTION',
  ADMIN_ADD_PRICE:       'ADMIN_ADD_PRICE',
  ADMIN_ADD_WARRANTY:    'ADMIN_ADD_WARRANTY',
  ADMIN_ADD_REQ_EMAIL:   'ADMIN_ADD_REQ_EMAIL',   // callback only
  ADMIN_ADD_INSTRUCTION: 'ADMIN_ADD_INSTRUCTION', // new
  ADMIN_ADD_IMAGE:       'ADMIN_ADD_IMAGE',
  ADMIN_ADD_STOCK:       'ADMIN_ADD_STOCK',

  // Admin — edit
  ADMIN_EDIT_VALUE: 'ADMIN_EDIT_VALUE',

  // Admin — stock management
  ADMIN_STOCK_DATA:         'ADMIN_STOCK_DATA',       // bulk add stock items (product_items)
  ADMIN_STOCK_ADD_QTY:      'ADMIN_STOCK_ADD_QTY',    // ➕ Add to stock_quantity (numeric)
  ADMIN_STOCK_REMOVE_QTY:   'ADMIN_STOCK_REMOVE_QTY', // ➖ Remove quantity
  ADMIN_STOCK_SET_QTY:      'ADMIN_STOCK_SET_QTY',    // ✏️ Set stock manually
  ADMIN_SALES_COUNT_SET:    'ADMIN_SALES_COUNT_SET',  // set sales_count

  // Admin — broadcast
  ADMIN_BROADCAST_MSG:     'ADMIN_BROADCAST_MSG',
  ADMIN_BROADCAST_CONFIRM: 'ADMIN_BROADCAST_CONFIRM',

  // Admin — support reply
  ADMIN_REPLY_TICKET: 'ADMIN_REPLY_TICKET',

  // Admin — settings
  ADMIN_SETTING_VALUE: 'ADMIN_SETTING_VALUE',

  // Admin — manual balance management
  ADMIN_BALANCE_USER_ID:    'ADMIN_BALANCE_USER_ID',
  ADMIN_BALANCE_AMOUNT_ADD: 'ADMIN_BALANCE_AMOUNT_ADD',
  ADMIN_BALANCE_AMOUNT_REMOVE: 'ADMIN_BALANCE_AMOUNT_REMOVE',

  // Admin — announcement
  ADMIN_ANN_MSG:    'ADMIN_ANN_MSG',
  ADMIN_ANN_TARGET: 'ADMIN_ANN_TARGET',

  // Admin — refund flow
  ADMIN_REFUND_ORDER_ID:    'ADMIN_REFUND_ORDER_ID',
  ADMIN_REFUND_END_DATE:    'ADMIN_REFUND_END_DATE',
  ADMIN_REFUND_WARRANTY:    'ADMIN_REFUND_WARRANTY',

  // Admin — delete stock item
  ADMIN_DELETE_STOCK_ITEM: 'ADMIN_DELETE_STOCK_ITEM',
  ADMIN_SET_ORDER: 'ADMIN_SET_ORDER',
  ADMIN_BULK_TIER_VALUE: 'ADMIN_BULK_TIER_VALUE',
  ADMIN_STOCK_BATCH: 'ADMIN_STOCK_BATCH', // multi-message stock upload (send DONE to finish)
  ADMIN_PRE_SET_MAX: 'ADMIN_PRE_SET_MAX',
  ADMIN_PRE_SEND_CONTENT: 'ADMIN_PRE_SEND_CONTENT',
  ADMIN_STOCK_CONFIRM: 'ADMIN_STOCK_CONFIRM',
  ADMIN_MAINTENANCE_MSG: 'ADMIN_MAINTENANCE_MSG',
  ADMIN_VIP_IMAGE: 'ADMIN_VIP_IMAGE',
  ADMIN_VIP_LIMIT: 'ADMIN_VIP_LIMIT',
  // Spend ranks: one state for editing a tier field, one for adding a tier.
  ADMIN_RANK_EDIT: 'ADMIN_RANK_EDIT',
  ADMIN_RANK_ADD:  'ADMIN_RANK_ADD',
  ADMIN_TXID_SEARCH: 'ADMIN_TXID_SEARCH',
  ADMIN_STOCK_SUPPLIER: 'ADMIN_STOCK_SUPPLIER',
  ADMIN_STOCK_COST: 'ADMIN_STOCK_COST',
  ADMIN_SUPPLIER_LOOKUP: 'ADMIN_SUPPLIER_LOOKUP',
  ADMIN_CGB_CYCLE_END: 'ADMIN_CGB_CYCLE_END',
  ADMIN_CGB_BOT_ADD: 'ADMIN_CGB_BOT_ADD',               // registering another invite bot (V148)
  ADMIN_CGB_CYCLE_PANEL: 'ADMIN_CGB_CYCLE_PANEL',
  ADMIN_CGB_CYCLE_NAME: 'ADMIN_CGB_CYCLE_NAME',       // typing a NAME for a cycle with no invite bot yet (V157.2)     // typing the invite-bot panel of a cycle (V147)
  REFUND_SEARCH: 'REFUND_SEARCH',
  ADMIN_VIP_REVOKE: 'ADMIN_VIP_REVOKE',
  ADMIN_NOTICE_TEXT: 'ADMIN_NOTICE_TEXT',
  ADMIN_SUB_EXPIRY: 'ADMIN_SUB_EXPIRY',
  ADMIN_SUB_MIN: 'ADMIN_SUB_MIN',
  ADMIN_SUB_MINDAYS: 'ADMIN_SUB_MINDAYS',
  ADMIN_VIP_INTERVAL: 'ADMIN_VIP_INTERVAL',
  REFUND_REASON: 'REFUND_REASON',
  REFUND_ACCOUNT: 'REFUND_ACCOUNT',
  REFUND_PHOTO: 'REFUND_PHOTO',
  REFUND_METHOD: 'REFUND_METHOD',
  REFUND_NETWORK: 'REFUND_NETWORK',
  REFUND_ADDRESS: 'REFUND_ADDRESS',
  ADMIN_ANN_BUTTON_ASK: 'ADMIN_ANN_BUTTON_ASK',
  ADMIN_ANN_BUTTON_TEXT: 'ADMIN_ANN_BUTTON_TEXT',
  ADMIN_REFUND_REVIEW_NOTE: 'ADMIN_REFUND_REVIEW_NOTE',
  ADMIN_REFUND_AMOUNT: 'ADMIN_REFUND_AMOUNT',
  ADMIN_USER_SEARCH: 'ADMIN_USER_SEARCH',
  ADMIN_EMOJI_ADD: 'ADMIN_EMOJI_ADD',
  BUY_PREORDER_QTY: 'BUY_PREORDER_QTY',
  BUY_PREORDER_EMAIL: 'BUY_PREORDER_EMAIL',

  // ── V2 ──────────────────────────────────────────────────────────
  WALLET_TOPUP_USDT_AMOUNT: 'WALLET_TOPUP_USDT_AMOUNT', // reserve a unique deposit amount
  ADMIN_DEP_REVERSE:        'ADMIN_DEP_REVERSE',        // reverse a fraudulent deposit
  ADMIN_CUST_PRICE:         'ADMIN_CUST_PRICE',         // negotiated price for one customer
  ADMIN_CUST_PRICE_EDIT:    'ADMIN_CUST_PRICE_EDIT',    // changing an existing special price (V146)
  ADMIN_LOW_STOCK:  'ADMIN_LOW_STOCK',   // per-product low-stock threshold
  ADMIN_MD_CONTENT: 'ADMIN_MD_CONTENT',  // content for a manual-delivery task
};

function get(userId) {
  if (!sessions.has(userId)) sessions.set(userId, { state: States.IDLE, data: {} });
  return sessions.get(userId);
}

// ── V154: a payment prompt survives /start and menu taps ────────────────────
// A customer opens "Pay with Binance Pay", then taps /start or a menu button (which clears the session),
// then sends the Order ID — and the bot ignored it, so the order was never processed. The last payment prompt
// is remembered (in memory and in the database, so a restart does not lose it) and, when a message that looks
// like a payment reference arrives while no other flow is active, that prompt is resumed — ONLY while that
// payment is still live: the order is still pending and inside its payment window (the same window the
// payment screen shows), or the wallet top-up is still inside its window. Otherwise nothing changes.
const PAY_STATES = new Set([
  'BUY_BINANCE_ORDER_ID', 'BUY_USDT_TXID', 'WALLET_TOPUP_USDT_TX', 'WALLET_TOPUP_BINANCE_ID',
]);
const payPrompts = new Map();

function rawDb() {
  try { return require('../database/queries').db; } catch (_) { return null; }
}
let _tableReady = false;
function ensureTable(d) {
  if (_tableReady || !d) return;
  d.exec(`CREATE TABLE IF NOT EXISTS pay_prompts (
    user_id INTEGER PRIMARY KEY, state TEXT NOT NULL, data TEXT NOT NULL, at INTEGER NOT NULL)`);
  _tableReady = true;
}
function rememberPayPrompt(userId, state, data) {
  const row = { state, data: { ...data }, at: Date.now() };
  payPrompts.set(userId, row);
  try {
    const d = rawDb(); ensureTable(d);
    if (d) d.prepare('INSERT OR REPLACE INTO pay_prompts (user_id, state, data, at) VALUES (?, ?, ?, ?)')
      .run(userId, state, JSON.stringify(row.data), row.at);
  } catch (_) { /* memory copy still works */ }
}
function lastPayPrompt(userId) {
  let row = payPrompts.get(userId);
  if (!row) {
    try {
      const d = rawDb(); ensureTable(d);
      const r = d && d.prepare('SELECT state, data, at FROM pay_prompts WHERE user_id = ?').get(userId);
      if (r) row = { state: r.state, data: JSON.parse(r.data || '{}'), at: Number(r.at) };
    } catch (_) {}
  }
  return row || null;
}
function forgetPayPrompt(userId) {
  payPrompts.delete(userId);
  try { const d = rawDb(); ensureTable(d); if (d) d.prepare('DELETE FROM pay_prompts WHERE user_id = ?').run(userId); } catch (_) {}
}

/** Is the payment this prompt belongs to still in progress? */
function stillLive(row) {
  const { checkPaymentWindow } = require('../utils/format');
  if (row.state === 'BUY_BINANCE_ORDER_ID' || row.state === 'BUY_USDT_TXID') {
    try {
      const order = require('../database/queries').getOrder(row.data && row.data.orderId);
      if (!order || order.status !== 'pending') return false;               // paid, cancelled or gone
      return !checkPaymentWindow(new Date(order.created_at + 'Z').getTime()).expired;
    } catch (_) { return false; }
  }
  return !checkPaymentWindow(row.data && row.data.startedAt).expired;      // wallet top-ups
}

/** Binance Pay order id, an off-chain transfer id, or an on-chain TxID. */
function looksLikePaymentRef(text) {
  const t = String(text || '').trim();
  return /^(off[\s-]?chain(\s*transfer)?\s*)?\d{9,22}$/i.test(t) || /^(0x)?[0-9a-fA-F]{64}$/.test(t);
}

/**
 * If the customer has no active flow and sends something that looks like a payment reference, bring back
 * their last payment prompt, only while that payment is still live. Returns the restored state, or null.
 */
function resumePayment(userId, text) {
  const cur = get(userId);
  if (cur.state !== States.IDLE || !looksLikePaymentRef(text)) return null;
  const row = lastPayPrompt(userId);
  if (!row) return null;
  if (!stillLive(row)) { forgetPayPrompt(userId); return null; }
  sessions.set(userId, { state: row.state, data: { ...row.data } });
  return row.state;
}

function set(userId, state, data = {}) {
  sessions.set(userId, { state, data });
  if (PAY_STATES.has(state)) rememberPayPrompt(userId, state, data);
}

function update(userId, partialData) {
  const s = get(userId);
  s.data = { ...s.data, ...partialData };
  sessions.set(userId, s);
}

function clear(userId) {
  sessions.set(userId, { state: States.IDLE, data: {} });
}

module.exports = { States, get, set, update, clear, resumePayment, looksLikePaymentRef, lastPayPrompt, forgetPayPrompt, PAY_STATES };
