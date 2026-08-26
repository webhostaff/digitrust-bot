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
  ADMIN_LOW_STOCK:  'ADMIN_LOW_STOCK',   // per-product low-stock threshold
  ADMIN_MD_CONTENT: 'ADMIN_MD_CONTENT',  // content for a manual-delivery task
};

function get(userId) {
  if (!sessions.has(userId)) sessions.set(userId, { state: States.IDLE, data: {} });
  return sessions.get(userId);
}

function set(userId, state, data = {}) {
  sessions.set(userId, { state, data });
}

function update(userId, partialData) {
  const s = get(userId);
  s.data = { ...s.data, ...partialData };
  sessions.set(userId, s);
}

function clear(userId) {
  sessions.set(userId, { state: States.IDLE, data: {} });
}

module.exports = { States, get, set, update, clear };
