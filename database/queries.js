'use strict';

const db = require('./db');

// ── USERS ─────────────────────────────────────────────────────────────────────

const upsertUser = db.prepare(`
  INSERT INTO users (telegram_id, username, first_name, last_name)
  VALUES (@telegramId, @username, @firstName, @lastName)
  ON CONFLICT(telegram_id) DO UPDATE SET
    username   = excluded.username,
    first_name = excluded.first_name,
    last_name  = excluded.last_name,
    last_seen  = datetime('now')
`);
const getUser         = db.prepare('SELECT * FROM users WHERE telegram_id = ?');
const getUserByUsername = db.prepare("SELECT * FROM users WHERE LOWER(username) = LOWER(?)");
const getAllUsers      = db.prepare('SELECT * FROM users ORDER BY created_at DESC');
const searchUsers      = db.prepare(`
  SELECT * FROM users
  WHERE
    CAST(telegram_id AS TEXT) LIKE ?
    OR LOWER(username)    LIKE ?
    OR LOWER(first_name)  LIKE ?
    OR LOWER(last_name)   LIKE ?
  ORDER BY created_at DESC
  LIMIT 20
`);
const updateBalance   = db.prepare('UPDATE users SET balance = MAX(0, balance + ?) WHERE telegram_id = ?');
const banUser         = db.prepare('UPDATE users SET is_banned = ? WHERE telegram_id = ?');

// ── PRODUCTS ──────────────────────────────────────────────────────────────────

const getAllActiveProducts = db.prepare(`
  SELECT p.*,
    (SELECT COUNT(*) FROM stock WHERE product_id = p.id AND is_sold = 0) AS stock_count
  FROM products p
  WHERE p.is_active = 1
  ORDER BY p.display_order ASC, p.id ASC
`);

// Stale products eligible for a reminder broadcast:
//  - active + in stock (no point advertising something unavailable)
//  - "last activity" = last_sold_at if it was ever sold, otherwise created_at
//    (whichever is more recent/relevant — a never-sold product is judged by
//    its creation date, a previously-sold product by its last sale date)
//  - that last-activity date is older than the threshold (days)
//  - it hasn't already been reminded within the cooldown window (hours),
//    so the same product isn't re-announced on every check cycle
const getStaleProducts = db.prepare(`
  SELECT *,
    COALESCE(last_sold_at, created_at) AS last_activity_at
  FROM products
  WHERE is_active = 1
    AND stock_quantity > 0
    AND COALESCE(last_sold_at, created_at) < datetime('now', '-' || ? || ' days')
    AND (last_stale_reminder_at IS NULL OR last_stale_reminder_at < datetime('now', '-' || ? || ' hours'))
  ORDER BY COALESCE(last_sold_at, created_at) ASC
`);

const markStaleReminderSent = db.prepare(`
  UPDATE products SET last_stale_reminder_at = datetime('now') WHERE id = ?
`);

// The sorting screen mirrors what the customer sees, so it carries the same
// facts the customer list shows: price, stock and sales. Without them the admin
// is reordering bare titles and has to leave the screen to check anything.
const getAllProductsForSorting = db.prepare(`
  SELECT id, title, display_order, is_active,
         price, stock_quantity, sales_count, premium_emoji_id
  FROM products
  ORDER BY display_order ASC, id ASC
`);

// ── Scoped ordering ──────────────────────────────────────────────────────────
// The customer never sees one flat list: categories are their own screens and
// everything without a category falls under "📦 Other Products". Ordering has to
// work the same way, or the admin is dragging rows around a list that exists
// nowhere in the shop.
//
// is_active = 0 is excluded on purpose. A deleted product is a soft-delete —
// still in the table, invisible to customers — so listing it among the things
// being arranged is noise about a product that cannot be bought.
const SORT_COLS = `id, title, display_order, is_active,
                   price, stock_quantity, sales_count, premium_emoji_id, category_id`;

const getUncategorizedForSorting = db.prepare(`
  SELECT ${SORT_COLS} FROM products
  WHERE is_active = 1 AND (category_id IS NULL OR category_id = 0)
  ORDER BY display_order ASC, id ASC
`);

const getCategoryForSorting = db.prepare(`
  SELECT ${SORT_COLS} FROM products
  WHERE is_active = 1 AND category_id = ?
  ORDER BY display_order ASC, id ASC
`);

const updateDisplayOrder = db.prepare(`
  UPDATE products SET display_order = ? WHERE id = ?
`);

const getProduct = db.prepare(`
  SELECT p.*,
    (SELECT COUNT(*) FROM stock WHERE product_id = p.id AND is_sold = 0) AS stock_count
  FROM products p WHERE p.id = ?
`);

const insertProduct = db.prepare(`
  INSERT INTO products
    (title, description, warranty, price, requires_email, image_file_id,
     stock_quantity, sales_count)
  VALUES
    (@title, @description, @warranty, @price, @requiresEmail, @imageFileId,
     @stockQuantity, @salesCount)
`);

const softDeleteProduct = db.prepare('UPDATE products SET is_active = 0 WHERE id = ?');

// Update stock_quantity by adding delta (can be negative for purchases)
const adjustStockQuantity = db.prepare(`
  UPDATE products
  SET stock_quantity = MAX(0, stock_quantity + ?)
  WHERE id = ?
`);

// Set stock_quantity to an exact value
const setStockQuantity = db.prepare(`
  UPDATE products SET stock_quantity = MAX(0, ?) WHERE id = ?
`);

// Increment sales_count (for real purchases)
const incrementSalesCount = db.prepare(`
  UPDATE products SET sales_count = sales_count + ? WHERE id = ?
`);

// Mark a product as "just sold" — resets staleness for the stale-product reminder feature
const markProductSoldNow = db.prepare(`
  UPDATE products SET last_sold_at = datetime('now') WHERE id = ?
`);

// ── STOCK (line items) ─────────────────────────────────────────────────────────

const insertStockItem  = db.prepare('INSERT INTO stock (product_id, content) VALUES (?, ?)');
const getAvailableStock = db.prepare('SELECT * FROM stock WHERE product_id = ? AND is_sold = 0 LIMIT ?');
const getStockItems    = db.prepare('SELECT * FROM stock WHERE product_id = ? AND is_sold = 0 ORDER BY id');
const getStockCount    = db.prepare('SELECT COUNT(*) AS cnt FROM stock WHERE product_id = ? AND is_sold = 0');
const markStockSold    = db.prepare("UPDATE stock SET is_sold = 1, order_id = ?, sold_at = datetime('now') WHERE id = ?");
const clearUnsoldStock = db.prepare('DELETE FROM stock WHERE product_id = ? AND is_sold = 0');
const incrementSoldCount = db.prepare('UPDATE products SET sold_count = sold_count + ? WHERE id = ?');

// ── ORDERS ────────────────────────────────────────────────────────────────────

const insertOrder = db.prepare(`
  INSERT INTO orders (user_id, product_id, quantity, email, total_price)
  VALUES (@userId, @productId, @quantity, @email, @totalPrice)
`);
const getOrder = db.prepare(`
  SELECT o.*, p.title AS product_title, p.price AS product_price,
         u.username, u.first_name
  FROM orders o
  LEFT JOIN products p ON o.product_id = p.id
  LEFT JOIN users u ON o.user_id = u.telegram_id
  WHERE o.id = ?
`);
const getUserOrders = db.prepare(`
  SELECT o.*, p.title AS product_title
  FROM orders o LEFT JOIN products p ON o.product_id = p.id
  WHERE o.user_id = ?
  ORDER BY o.created_at DESC LIMIT 500
`);
const getAllOrders = db.prepare(`
  SELECT o.*, p.title AS product_title, u.username
  FROM orders o
  LEFT JOIN products p ON o.product_id = p.id
  LEFT JOIN users u ON o.user_id = u.telegram_id
  ORDER BY o.created_at DESC LIMIT 50
`);
const updateOrderStatus = db.prepare('UPDATE orders SET status = ? WHERE id = ?');
const completeOrder     = db.prepare(`
  UPDATE orders
  SET status = 'delivered', delivered_content = ?, payment_method = ?, paid_at = datetime('now')
  WHERE id = ? AND status = 'pending'
`);

// ── TRANSACTIONS ──────────────────────────────────────────────────────────────

const insertTransaction  = db.prepare(`
  INSERT INTO transactions (user_id, type, amount, description, ref_id, order_id)
  VALUES (@userId, @type, @amount, @description, @refId, @orderId)
`);
const isRefIdUsed        = db.prepare('SELECT id FROM transactions WHERE ref_id = ?');
const getUserTransactions = db.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 20');
const getTransactionById = db.prepare('SELECT * FROM transactions WHERE id = ?');

// ── NOWPAYMENTS ───────────────────────────────────────────────────────────────
// Legacy — kept only for backward DB compatibility on Railway. Not used anywhere.

const insertInvoice = db.prepare(`
  INSERT INTO nowpayments_invoices
    (telegram_user_id, order_id, amount, invoice_id, invoice_url, purpose, related_order_id)
  VALUES
    (@telegramUserId, @orderId, @amount, @invoiceId, @invoiceUrl, @purpose, @relatedOrderId)
`);
const getInvoiceByOrderId   = db.prepare('SELECT * FROM nowpayments_invoices WHERE order_id = ?');
const getInvoiceByPaymentId = db.prepare('SELECT * FROM nowpayments_invoices WHERE payment_id = ?');
const updateInvoice         = db.prepare(`
  UPDATE nowpayments_invoices
  SET payment_id = COALESCE(@paymentId, payment_id),
      payment_status = COALESCE(@paymentStatus, payment_status),
      updated_at = datetime('now')
  WHERE order_id = @orderId
`);
const markInvoiceCredited = db.prepare(`
  UPDATE nowpayments_invoices
  SET credited = 1, payment_status = 'finished',
      tx_hash = COALESCE(?, tx_hash), updated_at = datetime('now')
  WHERE order_id = ? AND credited = 0
`);
const isInvoiceCredited = db.prepare('SELECT credited FROM nowpayments_invoices WHERE order_id = ?');

// ── BEP20 DEPOSITS (manual USDT BEP20 + Etherscan V2) ─────────────────────────

const insertBep20Deposit = db.prepare(`
  INSERT INTO bep20_deposits (user_id, tx_hash, amount, currency, network, from_addr, to_addr, status)
  VALUES (@userId, @txHash, @amount, @currency, @network, @fromAddr, @toAddr, @status)
`);
const getBep20DepositByHash = db.prepare(
  'SELECT * FROM bep20_deposits WHERE LOWER(tx_hash) = LOWER(?)'
);

// Generic used-TxID table (Binance API verified deposits, TRC20 + BEP20)
const insertUsedTxid = db.prepare(`
  INSERT INTO used_txids (txid, user_id, amount, network, asset, address)
  VALUES (@txid, @userId, @amount, @network, @asset, @address)
`);
const getUsedTxid = db.prepare('SELECT * FROM used_txids WHERE txid = ? COLLATE NOCASE');

// CryptoBot invoices
const insertCryptobotInvoice = db.prepare(`
  INSERT INTO cryptobot_invoices (invoice_id, user_id, asset, amount, pay_url)
  VALUES (@invoiceId, @userId, @asset, @amount, @payUrl)
`);
const getCryptobotInvoiceById = db.prepare('SELECT * FROM cryptobot_invoices WHERE invoice_id = ?');
const markCryptobotPaid = db.prepare(`
  UPDATE cryptobot_invoices
  SET status = 'paid', credited = 1, paid_at = datetime('now')
  WHERE invoice_id = ? AND credited = 0
`);
const getActiveCryptobotInvoicesForUser = db.prepare(`
  SELECT * FROM cryptobot_invoices
  WHERE user_id = ? AND status = 'active'
  ORDER BY created_at DESC
  LIMIT 5
`);



// ── PENDING PAYMENTS ──────────────────────────────────────────────────────────

const insertPendingPayment = db.prepare(`
  INSERT INTO pending_payments (user_id, amount, order_id, type)
  VALUES (@userId, @amount, @orderId, @type)
`);
const updatePendingPayment = db.prepare('UPDATE pending_payments SET status = ?, ref_id = ? WHERE id = ?');
const getPendingPayments   = db.prepare(`
  SELECT pp.*, u.username, u.first_name
  FROM pending_payments pp LEFT JOIN users u ON pp.user_id = u.telegram_id
  WHERE pp.status = 'waiting' ORDER BY pp.created_at DESC
`);

// ── SUPPORT TICKETS ───────────────────────────────────────────────────────────

const insertTicket  = db.prepare('INSERT INTO support_tickets (user_id, message) VALUES (?, ?)');
const getTicket     = db.prepare('SELECT * FROM support_tickets WHERE id = ?');
const replyTicket   = db.prepare(`
  UPDATE support_tickets SET admin_reply = ?, status = 'closed', replied_at = datetime('now') WHERE id = ?
`);
const getOpenTickets = db.prepare(`
  SELECT st.*, u.username, u.first_name
  FROM support_tickets st LEFT JOIN users u ON st.user_id = u.telegram_id
  WHERE st.status = 'open' ORDER BY st.created_at DESC
`);

// ── REFERRALS ─────────────────────────────────────────────────────────────────

const insertReferral      = db.prepare('INSERT OR IGNORE INTO referrals (referrer_id, referred_id) VALUES (?, ?)');
const getReferralByReferred = db.prepare('SELECT * FROM referrals WHERE referred_id = ?');
const markReferralRewarded = db.prepare(`
  UPDATE referrals SET reward_paid = 1, rewarded_at = datetime('now') WHERE referred_id = ?
`);
const getReferralStats = db.prepare(`
  SELECT COUNT(*) AS total_referred, SUM(reward_paid) AS rewarded_count
  FROM referrals WHERE referrer_id = ?
`);

// ── SETTINGS ──────────────────────────────────────────────────────────────────

const getSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
const setSetting = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');

// ── BACK-IN-STOCK NOTIFICATIONS ───────────────────────────────────────────────

const subscribeBackInStock = db.prepare(`
  INSERT OR IGNORE INTO back_in_stock_notifications (user_id, product_id) VALUES (?, ?)
`);

const isSubscribedBackInStock = db.prepare(`
  SELECT id FROM back_in_stock_notifications WHERE user_id = ? AND product_id = ?
`);

const getBackInStockSubscribers = db.prepare(`
  SELECT DISTINCT user_id FROM back_in_stock_notifications WHERE product_id = ?
`);

const clearBackInStockSubscriptions = db.prepare(`
  DELETE FROM back_in_stock_notifications WHERE product_id = ?
`);

// ── STATISTICS ────────────────────────────────────────────────────────────────

const getStats = () => ({
  totalUsers:  db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
  newToday:    db.prepare("SELECT COUNT(*) AS n FROM users WHERE created_at >= date('now','-1 day')").get().n,
  totalOrders: db.prepare('SELECT COUNT(*) AS n FROM orders').get().n,
  delivered:   db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'delivered'").get().n,
  pending:     db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'pending'").get().n,
  revenue:     db.prepare("SELECT COALESCE(SUM(total_price),0) AS r FROM orders WHERE status='delivered'").get().r,
  topProducts: db.prepare('SELECT title, sales_count, sold_count FROM products ORDER BY sales_count DESC LIMIT 5').all(),
});

// ── PROFIT STATISTICS ─────────────────────────────────────────────────────────

// Profit = revenue - cost (cost = cost_price × quantity)
const profitQuery = (whereClause) => `
  SELECT
    COALESCE(SUM(o.total_price), 0)                                            AS revenue,
    COALESCE(SUM(COALESCE(p.cost_price, 0) * o.quantity), 0)                   AS cost,
    COALESCE(SUM(o.total_price) - SUM(COALESCE(p.cost_price, 0) * o.quantity), 0) AS net_profit,
    COUNT(*) AS orders_count
  FROM orders o
  LEFT JOIN products p ON o.product_id = p.id
  WHERE o.status = 'delivered' AND ${whereClause}
`;

const getProfitToday = () =>
  db.prepare(profitQuery("date(o.paid_at) = date('now')")).get();

const getProfitLast7Days = () =>
  db.prepare(profitQuery("o.paid_at >= datetime('now','-7 days')")).get();

const getProfitThisMonth = () =>
  db.prepare(profitQuery("strftime('%Y-%m', o.paid_at) = strftime('%Y-%m','now')")).get();

const getProfitByDay = () =>
  db.prepare(`
    SELECT
      date(o.paid_at) AS day,
      COALESCE(SUM(o.total_price), 0) AS revenue,
      COALESCE(SUM(COALESCE(p.cost_price, 0) * o.quantity), 0) AS cost,
      COALESCE(SUM(o.total_price) - SUM(COALESCE(p.cost_price, 0) * o.quantity), 0) AS net_profit,
      COUNT(*) AS orders_count
    FROM orders o
    LEFT JOIN products p ON o.product_id = p.id
    WHERE o.status='delivered' AND o.paid_at IS NOT NULL
    GROUP BY day
    ORDER BY day DESC
    LIMIT 30
  `).all();

// ── REFUNDS ───────────────────────────────────────────────────────────────────

const insertRefund = db.prepare(`
  INSERT INTO refunds (order_id, user_id, product_id, original_price, refund_amount, warranty_days, end_date)
  VALUES (@orderId, @userId, @productId, @originalPrice, @refundAmount, @warrantyDays, @endDate)
`);
const getRefundByOrderId = db.prepare('SELECT * FROM refunds WHERE order_id = ?');

// ── EMOJI LIBRARY ─────────────────────────────────────────────────────────────

const insertEmoji = db.prepare(`
  INSERT INTO emoji_library (name, emoji_id, fallback)
  VALUES (?, ?, ?)
`);
const getAllEmojis = db.prepare('SELECT * FROM emoji_library ORDER BY name ASC');
const getEmojiByName = db.prepare('SELECT * FROM emoji_library WHERE name = ?');
const deleteEmojiById = db.prepare('DELETE FROM emoji_library WHERE id = ?');
const getEmojiById = db.prepare('SELECT * FROM emoji_library WHERE id = ?');

// ── PRE-ORDER PRODUCTS (customer-facing) ──────────────────────────────────────

const getPreorderEnabledProducts = db.prepare(`
  SELECT p.*
  FROM products p
  WHERE p.is_active = 1 AND p.preorder_enabled = 1
  ORDER BY p.display_order ASC, p.id ASC
`);

// ── PREORDERS ─────────────────────────────────────────────────────────────────

const insertPreorder = db.prepare(`
  INSERT INTO preorders (order_id, user_id, product_id, quantity, email, total_paid, payment_method, status)
  VALUES (@orderId, @userId, @productId, @quantity, @email, @totalPaid, @paymentMethod, 'reserved')
`);

const getAllPreorders = db.prepare(`
  SELECT pr.*, p.title AS product_title, u.username, u.first_name
  FROM preorders pr
  LEFT JOIN products p ON pr.product_id = p.id
  LEFT JOIN users u    ON pr.user_id    = u.telegram_id
  ORDER BY pr.created_at DESC
`);

const getReservedPreordersByProduct = db.prepare(`
  SELECT pr.*, u.username, u.first_name
  FROM preorders pr
  LEFT JOIN users u ON pr.user_id = u.telegram_id
  WHERE pr.product_id = ? AND pr.status = 'reserved'
  ORDER BY pr.created_at ASC
`);

const getPreorderById = db.prepare('SELECT * FROM preorders WHERE id = ?');

const updatePreorderStatus = db.prepare(`
  UPDATE preorders SET status = ?, delivered_content = ?, delivered_at = datetime('now')
  WHERE id = ?
`);

const incrementPreorderCount = db.prepare(`
  UPDATE products SET preorder_count = preorder_count + ? WHERE id = ?
`);

const getPreorderStats = db.prepare(`
  SELECT
    COUNT(*) AS total,
    SUM(CASE WHEN status='reserved' THEN 1 ELSE 0 END)  AS reserved,
    SUM(CASE WHEN status='delivered' THEN 1 ELSE 0 END) AS delivered,
    COALESCE(SUM(total_paid), 0) AS total_revenue
  FROM preorders
`);

// ── Compound helpers ──────────────────────────────────────────────────────────

function upsertAndGetUser({ telegramId, username, firstName, lastName }) {
  upsertUser.run({ telegramId, username, firstName, lastName });
  return getUser.get(telegramId);
}

function addStockItems(productId, lines) {
  let count = 0;
  const insert = db.transaction((items) => {
    for (const line of items) {
      const trimmed = line.trim();
      if (trimmed) { insertStockItem.run(productId, trimmed); count++; }
    }
  });
  insert(lines);
  return count;
}

/**
 * Deliver an order atomically.
 * Uses product_items table (key/account) when available items exist,
 * falls back to legacy stock table otherwise.
 * Returns delivered content string or null if no stock.
 */
function deliverOrder(orderId, productId, quantity, paymentMethod, userId) {
  const items = require('./items');

  return db.transaction(() => {
    // ── IDEMPOTENCY GUARD: check order is still pending inside the transaction ──
    const orderCheck = db.prepare("SELECT status FROM orders WHERE id = ?").get(orderId);
    if (!orderCheck || orderCheck.status !== 'pending') {
      return null; // Already delivered or cancelled — abort
    }

    // ── Deliver using RAW statements (no nested transaction) ──
    const availCount = items.getAvailableCount(productId);

    let content;
    if (availCount > 0) {
      if (availCount < quantity) return null; // Not enough stock
      const deliveredParts = [];
      for (let i = 0; i < quantity; i++) {
        const part = items.deliverItemRaw(productId, userId, orderId);
        if (!part) return null;
        deliveredParts.push(part);
      }
      content = deliveredParts.join('\n\n');
    } else {
      // Legacy fallback: use old stock table
      const stockItems = getAvailableStock.all(productId, quantity);
      if (stockItems.length < quantity) return null;
      for (const item of stockItems) markStockSold.run(orderId, item.id);
      content = stockItems.map((i) => i.content).join('\n');
    }

    // completeOrder now has WHERE status='pending' — second call returns 0 changes
    const res = completeOrder.run(content, paymentMethod, orderId);
    if (res.changes === 0) return null; // Lost the race — another payment beat us

    incrementSoldCount.run(quantity, productId);
    incrementSalesCount.run(quantity, productId);
    adjustStockQuantity.run(-quantity, productId);
    markProductSoldNow.run(productId);
    return content;
  })();
}

// ── Atomic wallet-pay delivery: deliver + deduct balance in ONE transaction ────
function deliverOrderAndChargeWallet(orderId, productId, quantity, userId, price) {
  const items = require('./items');

  return db.transaction(() => {
    // ── IDEMPOTENCY GUARD ──
    const orderCheck = db.prepare("SELECT status FROM orders WHERE id = ?").get(orderId);
    if (!orderCheck || orderCheck.status !== 'pending') return { result: 'already_processed' };

    // ── BALANCE CHECK inside transaction ──
    const userRow = db.prepare("SELECT balance FROM users WHERE telegram_id = ?").get(userId);
    const balance = userRow ? Number(userRow.balance) : 0;
    const priceN  = Number(price);
    if (!hasEnough(balance, priceN)) return { result: 'insufficient_balance', balance };

    // ── Deliver items using RAW statements (no nested transaction) ──
    // deliverItemRaw runs getAvailableItem + markItemSold directly inside THIS transaction
    // This prevents nested-transaction conflicts when multiple users buy concurrently
    const availCount = items.getAvailableCount(productId);
    let content;
    if (availCount > 0) {
      if (availCount < quantity) return { result: 'out_of_stock' };
      const deliveredParts = [];
      for (let i = 0; i < quantity; i++) {
        const part = items.deliverItemRaw(productId, userId, orderId);
        if (!part) return { result: 'out_of_stock' };
        deliveredParts.push(part);
      }
      content = deliveredParts.join('\n\n');
    } else {
      const stockItems = getAvailableStock.all(productId, quantity);
      if (stockItems.length < quantity) return { result: 'out_of_stock' };
      for (const item of stockItems) markStockSold.run(orderId, item.id);
      content = stockItems.map((i) => i.content).join('\n');
    }

    const res = completeOrder.run(content, 'wallet', orderId);
    if (res.changes === 0) return { result: 'already_processed' };

    // Deduct balance atomically in the same transaction
    updateBalance.run(-priceN, userId);

    incrementSoldCount.run(quantity, productId);
    incrementSalesCount.run(quantity, productId);
    adjustStockQuantity.run(-quantity, productId);
    markProductSoldNow.run(productId);
    return { result: 'ok', content };
  })();
}

function payReferralReward(referredId, rewardAmount) {
  return db.transaction(() => {
    const referral = getReferralByReferred.get(referredId);
    if (!referral || referral.reward_paid) return null;

    const referrerId = referral.referrer_id;
    updateBalance.run(rewardAmount, referrerId);
    insertTransaction.run({
      userId: referrerId,
      type: 'referral',
      amount: rewardAmount,
      description: `Referral reward for user ${referredId}`,
      refId: null,
      orderId: null,
    });
    markReferralRewarded.run(referredId);
    return referrerId;
  })();
}

// ── CASHBACK REFERRAL — pays % of every purchase to referrer for life ────────
const updateUserLanguage = db.prepare('UPDATE users SET language = ? WHERE telegram_id = ?');

function payCashbackReferral(referredUserId, orderTotal, orderId) {
  return db.transaction(() => {
    // Check if cashback is enabled
    const enabled = getSetting.get('referral_cashback_enabled')?.value;
    if (enabled !== '1') return null;

    // Check minimum order threshold (anti-fraud)
    const minRow = getSetting.get('referral_min_order');
    const minOrder = minRow ? parseFloat(minRow.value) : 5.0;
    if (orderTotal < minOrder) return { skipped: 'below_minimum', minOrder };

    // Get the cashback percentage (default 2%)
    const pctRow = getSetting.get('referral_cashback_pct');
    const pct = pctRow ? parseFloat(pctRow.value) : 2.0;
    if (isNaN(pct) || pct <= 0) return null;

    // Find the referrer
    const referral = getReferralByReferred.get(referredUserId);
    if (!referral) return null;
    const referrerId = referral.referrer_id;
    if (!referrerId || referrerId === referredUserId) return null;

    // Calculate cashback amount
    const cashback = parseFloat(((orderTotal * pct) / 100).toFixed(2));
    if (cashback < 0.01) return null;

    // Credit referrer
    updateBalance.run(cashback, referrerId);
    insertTransaction.run({
      userId: referrerId,
      type: 'referral_cashback',
      amount: cashback,
      description: `${pct}% cashback from order #${orderId} by user ${referredUserId}`,
      refId: null,
      orderId,
    });
    return { referrerId, cashback, pct };
  })();
}

// Referral cashback statistics for a user
const getReferralCashbackStats = db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM referrals WHERE referrer_id = ?) AS total_referrals,
    (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE user_id = ? AND type IN ('referral', 'referral_cashback')) AS total_earned
`);

// ── VIP ──────────────────────────────────────────────────────────────────────
const unlockVIPQuery = db.prepare("UPDATE users SET is_vip = 1, vip_unlocked_at = datetime('now') WHERE telegram_id = ?");
const isVIPQuery = db.prepare('SELECT is_vip FROM users WHERE telegram_id = ?');
const countVIPsQuery = db.prepare('SELECT COUNT(*) AS count FROM users WHERE is_vip = 1');
const countReferralsForUser = db.prepare('SELECT COUNT(*) AS count FROM referrals WHERE referrer_id = ?');

// Count referrals where at least one of the invited users has bought (paid order)
const countReferralsWithPurchaseQuery = db.prepare(`
  SELECT COUNT(DISTINCT r.referred_id) AS count
  FROM referrals r
  WHERE r.referrer_id = ?
    AND EXISTS (
      SELECT 1 FROM orders o
      WHERE o.user_id = r.referred_id
        AND o.status IN ('delivered', 'paid')
    )
`);

// Has any invitee made any purchase?
const hasAnyInviteePurchasedQuery = db.prepare(`
  SELECT COUNT(*) AS count
  FROM referrals r
  WHERE r.referrer_id = ?
    AND EXISTS (
      SELECT 1 FROM orders o
      WHERE o.user_id = r.referred_id
        AND o.status IN ('delivered', 'paid')
    )
`);

// ── REFUND REQUESTS ──────────────────────────────────────────────────────────
const insertRefundRequest = db.prepare(`
  INSERT INTO refund_requests (user_id, order_id, reason, amount, affected_account, photo_file_id, refund_method, crypto_network, wallet_address)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const getUserRefundRequests = db.prepare(`
  SELECT rr.*, p.title AS product_title, o.total_price, o.created_at AS order_date
  FROM refund_requests rr
  LEFT JOIN orders o ON o.id = rr.order_id
  LEFT JOIN products p ON p.id = o.product_id
  WHERE rr.user_id = ?
  ORDER BY rr.id DESC LIMIT 20
`);
const getAllRefundRequests = db.prepare(`
  SELECT rr.*, p.title AS product_title, o.total_price,
    u.username AS username, u.first_name AS first_name
  FROM refund_requests rr
  LEFT JOIN orders o ON o.id = rr.order_id
  LEFT JOIN products p ON p.id = o.product_id
  LEFT JOIN users u ON u.telegram_id = rr.user_id
  ORDER BY rr.id DESC
`);
const getRefundRequestById = db.prepare(`
  SELECT rr.*, p.title AS product_title, o.total_price, o.created_at AS order_date
  FROM refund_requests rr
  LEFT JOIN orders o ON o.id = rr.order_id
  LEFT JOIN products p ON p.id = o.product_id
  WHERE rr.id = ?
`);
const getPendingRefundForOrder = db.prepare(`
  SELECT * FROM refund_requests WHERE order_id = ? AND status = 'pending'
`);
const updateRefundRequestStatus = db.prepare(`
  UPDATE refund_requests SET status = ?, admin_note = ?, amount = ?, method = ?, resolved_at = datetime('now')
  WHERE id = ?
`);


// ═══ CATEGORIES ═══════════════════════════════════════
const cat_getAll = db.prepare(`SELECT * FROM categories WHERE is_active=1 ORDER BY display_order ASC, id ASC`);
const cat_getById = db.prepare(`SELECT * FROM categories WHERE id=?`);
const cat_insert = db.prepare(`INSERT INTO categories (name, emoji, display_order) VALUES (?, ?, ?)`);
const cat_update = db.prepare(`UPDATE categories SET name=?, emoji=?, display_order=? WHERE id=?`);
const cat_delete = db.prepare(`DELETE FROM categories WHERE id=?`);
const cat_getProducts = db.prepare(`
  SELECT p.*, COALESCE(SUM(CASE WHEN i.status='available' THEN 1 ELSE 0 END), 0) AS stock_count
  FROM products p
  LEFT JOIN product_items i ON i.product_id = p.id
  WHERE p.is_active=1 AND p.category_id=?
  GROUP BY p.id
  ORDER BY p.display_order ASC, p.id ASC
`);
const cat_setProduct = db.prepare(`UPDATE products SET category_id=? WHERE id=?`);
const cat_resetProducts = db.prepare(`UPDATE products SET category_id=0 WHERE category_id=?`);


// ═══ CHATGPT BUSINESS ═══════════════════════════════════
const cgb_getAllCycles = db.prepare(`SELECT * FROM billing_cycles WHERE is_active=1 ORDER BY start_day ASC`);
const cgb_insertCycle  = db.prepare(`INSERT INTO billing_cycles (start_day, end_day) VALUES (?, ?)`);
const cgb_deleteCycle  = db.prepare(`DELETE FROM billing_cycles WHERE id=?`);
const cgb_updateCycle  = db.prepare(`UPDATE billing_cycles SET start_day=?, end_day=? WHERE id=?`);
const cgb_getCycleById = db.prepare(`SELECT * FROM billing_cycles WHERE id=?`);
const cgb_insertSub    = db.prepare(`
  INSERT INTO chatgpt_subscriptions (order_id, user_id, email, start_date, end_date, days_remaining, base_price, extra_month, final_price, status)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
`);
const cgb_getSubByOrder = db.prepare(`SELECT * FROM chatgpt_subscriptions WHERE order_id=?`);
const cgb_activateSub  = db.prepare(`UPDATE chatgpt_subscriptions SET status='active', updated_at=datetime('now') WHERE order_id=?`);
const cgb_getActive    = db.prepare(`SELECT * FROM chatgpt_subscriptions WHERE status='active' ORDER BY end_date ASC`);
const cgb_getExpiringSubs = db.prepare(`
  SELECT cs.*, u.username, u.first_name 
  FROM chatgpt_subscriptions cs
  LEFT JOIN users u ON cs.user_id = u.telegram_id
  WHERE cs.status='active' 
  AND date(cs.end_date) <= date('now', '+' || ? || ' days')
  AND date(cs.end_date) > date('now')
`);
const cgb_markNotified = (orderId, days) => {
  const col = days === 3 ? 'notified_3d' : days === 1 ? 'notified_1d' : 'notified_0d';
  return db.prepare(`UPDATE chatgpt_subscriptions SET ${col}=1 WHERE order_id=?`).run(orderId);
};


// ═══ RESELLERS ═══════════════════════════════════════
const rs_getAll = db.prepare(`SELECT * FROM resellers ORDER BY id DESC`);
const rs_getById = db.prepare(`SELECT * FROM resellers WHERE id=?`);
const rs_getByKey = db.prepare(`SELECT * FROM resellers WHERE api_key=? AND is_active=1`);
const rs_insert = db.prepare(`INSERT INTO resellers (name, api_key) VALUES (?, ?)`);
const rs_updateBalance = db.prepare(`UPDATE resellers SET balance = balance + ?, total_spent = total_spent + ?, orders_count = orders_count + ? WHERE id=?`);
const rs_setBalance = db.prepare(`UPDATE resellers SET balance = balance + ? WHERE id=?`);
const rs_toggle = db.prepare(`UPDATE resellers SET is_active = ? WHERE id=?`);
const rs_delete = db.prepare(`DELETE FROM resellers WHERE id=?`);
const rs_insertOrder = db.prepare(`
  INSERT INTO reseller_orders (reseller_id, product_id, quantity, unit_price, total, delivered_items, status)
  VALUES (?, ?, ?, ?, ?, ?, 'completed')
`);
const rs_getOrders = db.prepare(`
  SELECT ro.*, p.title AS product_title FROM reseller_orders ro
  LEFT JOIN products p ON ro.product_id = p.id
  WHERE ro.reseller_id = ?
  ORDER BY ro.id DESC LIMIT 100
`);
const rs_setProductWholesale = db.prepare(`UPDATE products SET wholesale_price = ? WHERE id = ?`);

// ═══════════════════════════════════════════════════════════════════════════
// V2 — ORDER HISTORY WITH DATE FILTERS
// ═══════════════════════════════════════════════════════════════════════════

// Full history, newest first, no LIMIT. Pagination happens in the keyboard
// layer so nothing is ever silently dropped by the query itself.
const getUserOrdersAll = db.prepare(`
  SELECT o.*, p.title AS product_title, p.delivery_type,
         md.status AS manual_status
  FROM orders o
  LEFT JOIN products p          ON o.product_id = p.id
  LEFT JOIN manual_deliveries md ON md.order_id = o.id
  WHERE o.user_id = ?
  ORDER BY datetime(o.created_at) DESC, o.id DESC
`);

// Same, restricted to a window. `sinceExpr`/`untilExpr` are SQLite datetime
// modifiers supplied by the caller from a fixed whitelist (never user input).
function getUserOrdersFiltered(userId, filter = 'all') {
  const all = getUserOrdersAll.all(userId);
  if (filter === 'all') return all;

  const now = new Date();
  let from = null;
  let to   = null;

  if (filter === '7d') {
    from = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
  } else if (filter === '30d') {
    from = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
  } else if (filter === 'this_month') {
    from = new Date(now.getFullYear(), now.getMonth(), 1);
  } else if (filter === 'last_month') {
    from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    to   = new Date(now.getFullYear(), now.getMonth(), 1);
  } else {
    return all;
  }

  return all.filter((o) => {
    // created_at is stored as UTC "YYYY-MM-DD HH:MM:SS"
    const raw = String(o.created_at || '').replace(' ', 'T');
    const d = new Date(raw.endsWith('Z') ? raw : raw + 'Z');
    if (isNaN(d.getTime())) return true; // never hide a row we can't parse
    if (from && d < from) return false;
    if (to   && d >= to)  return false;
    return true;
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// V2 — REFUND ELIGIBILITY
// ═══════════════════════════════════════════════════════════════════════════

// Authoritative server-side check. Used by both the listing and the submit
// handler, so a crafted callback can never open a request for a blocked item.
function isProductRefundable(productId) {
  const row = db.prepare('SELECT refund_enabled FROM products WHERE id = ?').get(productId);
  if (!row) return false;
  return Number(row.refund_enabled) === 1;
}

function isOrderRefundable(orderId) {
  const row = db.prepare(`
    SELECT o.status, o.product_id, p.refund_enabled
    FROM orders o LEFT JOIN products p ON p.id = o.product_id
    WHERE o.id = ?
  `).get(orderId);
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.status !== 'delivered') return { ok: false, reason: 'not_delivered' };
  if (Number(row.refund_enabled) !== 1) return { ok: false, reason: 'not_eligible' };
  return { ok: true };
}

// Delivered orders the customer is actually allowed to open a refund for.
const getRefundableUserOrders = db.prepare(`
  SELECT o.*, p.title AS product_title
  FROM orders o
  JOIN products p ON p.id = o.product_id
  WHERE o.user_id = ?
    AND o.status = 'delivered'
    AND p.refund_enabled = 1
  ORDER BY datetime(o.created_at) DESC, o.id DESC
`);

// ═══════════════════════════════════════════════════════════════════════════
// V2 — MANUAL DELIVERY
// ═══════════════════════════════════════════════════════════════════════════

const md_insert = db.prepare(`
  INSERT OR IGNORE INTO manual_deliveries
    (order_id, user_id, product_id, quantity, email, total_paid, payment_method)
  VALUES (@orderId, @userId, @productId, @quantity, @email, @totalPaid, @paymentMethod)
`);
const md_getByOrder = db.prepare('SELECT * FROM manual_deliveries WHERE order_id = ?');
const md_getById    = db.prepare(`
  SELECT md.*, p.title AS product_title, u.username, u.first_name
  FROM manual_deliveries md
  LEFT JOIN products p ON p.id = md.product_id
  LEFT JOIN users u    ON u.telegram_id = md.user_id
  WHERE md.id = ?
`);
const md_listAll = db.prepare(`
  SELECT md.*, p.title AS product_title, u.username, u.first_name
  FROM manual_deliveries md
  LEFT JOIN products p ON p.id = md.product_id
  LEFT JOIN users u    ON u.telegram_id = md.user_id
  ORDER BY md.id DESC
`);
const md_countByStatus = db.prepare(`
  SELECT status, COUNT(*) AS n FROM manual_deliveries GROUP BY status
`);
const md_setStatus = db.prepare(`
  UPDATE manual_deliveries
  SET status = ?, admin_note = COALESCE(?, admin_note), updated_at = datetime('now')
  WHERE id = ?
`);
const md_markDelivered = db.prepare(`
  UPDATE manual_deliveries
  SET status = 'delivered', delivered_content = COALESCE(?, delivered_content),
      delivered_at = datetime('now'), updated_at = datetime('now')
  WHERE id = ? AND status != 'delivered'
`);
const md_markNotified = db.prepare(`
  UPDATE manual_deliveries SET notified_at = datetime('now') WHERE id = ? AND notified_at IS NULL
`);
const md_markSeen = db.prepare(`
  UPDATE manual_deliveries SET seen_at = datetime('now') WHERE id = ? AND seen_at IS NULL
`);
const md_userList = db.prepare(`
  SELECT md.*, p.title AS product_title
  FROM manual_deliveries md
  LEFT JOIN products p ON p.id = md.product_id
  WHERE md.user_id = ?
  ORDER BY md.id DESC
`);

/**
 * Atomically charge the wallet and open a manual-delivery task.
 *
 * Mirrors deliverOrderAndChargeWallet but deliberately does NOT touch
 * product_items: manual products have no digital stock to hand out. Stock
 * quantity is still decremented so the storefront count stays honest.
 *
 * Returns { result: 'ok' | 'already_processed' | 'insufficient_balance' }.
 */
function chargeWalletForManualOrder(orderId, productId, quantity, userId, price) {
  return db.transaction(() => {
    const orderCheck = db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId);
    if (!orderCheck || orderCheck.status !== 'pending') return { result: 'already_processed' };

    const userRow = db.prepare('SELECT balance FROM users WHERE telegram_id = ?').get(userId);
    const balance = userRow ? Number(userRow.balance) : 0;
    const priceN  = Number(price);
    if (!hasEnough(balance, priceN)) return { result: 'insufficient_balance', balance };

    const res = db.prepare(`
      UPDATE orders
      SET status = 'awaiting_delivery', payment_method = 'wallet', paid_at = datetime('now')
      WHERE id = ? AND status = 'pending'
    `).run(orderId);
    if (res.changes === 0) return { result: 'already_processed' };

    updateBalance.run(-priceN, userId);
    incrementSoldCount.run(quantity, productId);
    incrementSalesCount.run(quantity, productId);
    adjustStockQuantity.run(-quantity, productId);
    markProductSoldNow.run(productId);
    return { result: 'ok' };
  })();
}

/**
 * Same thing for externally-settled payments (USDT / Binance Pay / CryptoBot),
 * where the money has already arrived and only the order state must move.
 */
function settleManualOrderExternal(orderId, productId, quantity, paymentMethod) {
  return db.transaction(() => {
    const orderCheck = db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId);
    if (!orderCheck || orderCheck.status !== 'pending') return { result: 'already_processed' };

    const res = db.prepare(`
      UPDATE orders
      SET status = 'awaiting_delivery', payment_method = ?, paid_at = datetime('now')
      WHERE id = ? AND status = 'pending'
    `).run(paymentMethod, orderId);
    if (res.changes === 0) return { result: 'already_processed' };

    incrementSoldCount.run(quantity, productId);
    incrementSalesCount.run(quantity, productId);
    adjustStockQuantity.run(-quantity, productId);
    markProductSoldNow.run(productId);
    return { result: 'ok' };
  })();
}

// ═══════════════════════════════════════════════════════════════════════════
// V2 — STOCK ALERT LATCHES
// ═══════════════════════════════════════════════════════════════════════════

const stock_setOosNotified = db.prepare('UPDATE products SET oos_notified = ? WHERE id = ?');
const stock_setLowNotified = db.prepare('UPDATE products SET low_notified = ? WHERE id = ?');
const stock_resetFlags     = db.prepare('UPDATE products SET oos_notified = 0, low_notified = 0 WHERE id = ?');

// ═══════════════════════════════════════════════════════════════════════════
// V2 — SUPPORT THREADS (✓ / ✓✓ state + one-time welcome)
// ═══════════════════════════════════════════════════════════════════════════

const th_ensure = db.prepare('INSERT OR IGNORE INTO support_threads (user_id) VALUES (?)');
const th_get    = db.prepare('SELECT * FROM support_threads WHERE user_id = ?');
const th_setWelcomed = db.prepare('UPDATE support_threads SET welcomed = 1 WHERE user_id = ?');
const th_setStatusMsg = db.prepare(`
  UPDATE support_threads
  SET status_msg_id = ?, status_state = ?, pending_count = ?,
      last_customer_msg_at = datetime('now')
  WHERE user_id = ?
`);
const th_markRead = db.prepare(`
  UPDATE support_threads
  SET status_state = 'read', pending_count = 0, last_read_at = datetime('now')
  WHERE user_id = ?
`);

const sm_markRead = db.prepare(`
  UPDATE support_messages
  SET is_read = 1, read_at = datetime('now')
  WHERE user_id = ? AND direction = 'in' AND is_read = 0
`);
const sm_unreadTotal = db.prepare(`
  SELECT COUNT(DISTINCT user_id) AS n FROM support_messages WHERE direction = 'in' AND is_read = 0
`);

// ═══════════════════════════════════════════════════════════════════════════
// V2 — ADMIN NOTIFICATION CENTRE
// ═══════════════════════════════════════════════════════════════════════════

// INSERT OR IGNORE + UNIQUE(dedupe_key) = the same event is stored exactly once,
// no matter how many times the producing code path runs.
const an_insert = db.prepare(`
  INSERT OR IGNORE INTO admin_notifications (type, title, body, ref_type, ref_id, dedupe_key)
  VALUES (@type, @title, @body, @refType, @refId, @dedupeKey)
`);
const an_list = db.prepare(`
  SELECT * FROM admin_notifications ORDER BY id DESC LIMIT ? OFFSET ?
`);
const an_listUnread = db.prepare(`
  SELECT * FROM admin_notifications WHERE is_read = 0 ORDER BY id DESC LIMIT ? OFFSET ?
`);
const an_countAll    = db.prepare('SELECT COUNT(*) AS n FROM admin_notifications');
const an_countUnread = db.prepare('SELECT COUNT(*) AS n FROM admin_notifications WHERE is_read = 0');
const an_get         = db.prepare('SELECT * FROM admin_notifications WHERE id = ?');
const an_markRead    = db.prepare("UPDATE admin_notifications SET is_read = 1, read_at = datetime('now') WHERE id = ?");
const an_markAllRead = db.prepare("UPDATE admin_notifications SET is_read = 1, read_at = datetime('now') WHERE is_read = 0");

// ═══════════════════════════════════════════════════════════════════════════
// V3 — DEPOSIT INTENTS (amount reservation)
// ═══════════════════════════════════════════════════════════════════════════

const nodeCrypto = require('crypto');

const di_insert = db.prepare(`
  INSERT INTO deposit_intents (user_id, network, base_amount, unique_amount, created_ms, expires_ms)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const di_expireStale = db.prepare(`
  UPDATE deposit_intents SET status = 'expired'
  WHERE status = 'open' AND expires_ms < ?
`);
const di_openForUser = db.prepare(`
  SELECT * FROM deposit_intents
  WHERE user_id = ? AND status = 'open' AND expires_ms >= ?
  ORDER BY id DESC
`);
const di_findOpenByAmount = db.prepare(`
  SELECT * FROM deposit_intents
  WHERE status = 'open' AND network = ? AND expires_ms >= ?
    AND ABS(unique_amount - ?) < 0.0000021
  ORDER BY id ASC LIMIT 1
`);
const di_claim = db.prepare(`
  UPDATE deposit_intents
  SET status = 'claimed', claimed_txid = ?, claimed_at = datetime('now')
  WHERE id = ? AND status = 'open'
`);
const di_cancel = db.prepare(`
  UPDATE deposit_intents SET status = 'cancelled' WHERE id = ? AND status = 'open'
`);
const di_get = db.prepare('SELECT * FROM deposit_intents WHERE id = ?');

/**
 * Reserve a unique deposit amount for a user.
 *
 * The suffix is drawn with crypto.randomInt so it cannot be guessed, and the
 * partial UNIQUE index on (network, unique_amount) WHERE status='open'
 * guarantees no two live reservations ever collide. On collision we simply
 * draw again.
 *
 * The suffix costs the customer at most 0.000999 USDT — a tenth of a cent.
 *
 * @returns {object|null} the created intent row
 */
function createDepositIntent(userId, network, baseAmount, ttlMinutes) {
  const now = Date.now();
  di_expireStale.run(now); // housekeeping: retire anything past its deadline

  const ttl = (Number(ttlMinutes) > 0 ? Number(ttlMinutes) : 60) * 60 * 1000;
  const base = Number(Number(baseAmount).toFixed(2));

  for (let attempt = 0; attempt < 80; attempt++) {
    // 0.000100 .. 0.009999 — about one cent at most, and USDT keeps 6 decimals
    // on both TRC20 and BEP20, so the exact figure survives the transfer.
    // 0.000101 .. 0.000999 — at most a TENTH of a cent on top of what the
    // customer asked to deposit, so the identifier is effectively free.
    //
    // Note this is not a fee and nothing is lost to the network: BEP20 gas is
    // paid in BNB and TRC20 in TRX/Energy, never in USDT, so the exact figure
    // sent is the exact figure Binance receives.
    //
    // 899 possible values per base amount. A collision only matters between
    // two reservations that are open at the same time for the same base, and
    // the loop simply redraws; the partial UNIQUE index is what guarantees
    // correctness, not the size of the range.
    const suffix = (101 + nodeCrypto.randomInt(0, 899)) / 1e6;
    const unique = Number((base + suffix).toFixed(6));
    try {
      const res = di_insert.run(userId, network, base, unique, now, now + ttl);
      return di_get.get(res.lastInsertRowid);
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) continue; // collision, redraw
      throw e;
    }
  }
  return null; // astronomically unlikely
}

/** Live reservations belonging to a user. */
function getOpenIntents(userId) {
  const now = Date.now();
  di_expireStale.run(now);
  return di_openForUser.all(userId, now);
}

/** Find the live reservation an incoming deposit belongs to, if any. */
function findIntentForDeposit(network, amount) {
  const now = Date.now();
  di_expireStale.run(now);
  return di_findOpenByAmount.get(network, now, Number(amount));
}

const claimDepositIntent  = (id, txid) => di_claim.run(txid, id).changes > 0;
const cancelDepositIntent = (id) => di_cancel.run(id).changes > 0;

// ═══════════════════════════════════════════════════════════════════════════
// V3 — DEPOSIT REVIEW QUEUE (unmatched deposits, admin-approved only)
// ═══════════════════════════════════════════════════════════════════════════

const dr_insert = db.prepare(`
  INSERT OR IGNORE INTO deposit_reviews
    (txid, user_id, amount, network, address, insert_time, reason)
  VALUES (@txid, @userId, @amount, @network, @address, @insertTime, @reason)
`);
const dr_get      = db.prepare('SELECT * FROM deposit_reviews WHERE id = ?');
const dr_byTxid   = db.prepare('SELECT * FROM deposit_reviews WHERE txid = ? COLLATE NOCASE');
const dr_list     = db.prepare("SELECT * FROM deposit_reviews WHERE status = ? ORDER BY id DESC LIMIT ? OFFSET ?");
const dr_count    = db.prepare('SELECT COUNT(*) AS n FROM deposit_reviews WHERE status = ?');
const dr_resolve  = db.prepare(`
  UPDATE deposit_reviews
  SET status = ?, admin_note = ?, admin_id = ?, resolved_at = datetime('now')
  WHERE id = ? AND status = 'pending'
`);

// ═══════════════════════════════════════════════════════════════════════════
// V3 — BALANCE REVERSAL (claw back a fraudulent credit)
// ═══════════════════════════════════════════════════════════════════════════

const rev_insert = db.prepare(`
  INSERT INTO balance_reversals
    (user_id, amount, txid, reason, admin_id, balance_before, balance_after)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const rev_list = db.prepare('SELECT * FROM balance_reversals ORDER BY id DESC LIMIT ?');

/**
 * Remove a credited amount from a user's wallet and record it.
 *
 * The balance is allowed to go negative on purpose: if the thief already spent
 * the money, the debt stays visible instead of silently vanishing.
 */
function reverseDeposit({ userId, amount, txid = null, reason = '', adminId = null }) {
  return db.transaction(() => {
    const before = Number(db.prepare('SELECT balance FROM users WHERE telegram_id = ?').get(userId)?.balance || 0);
    const amt = Number(amount);
    db.prepare('UPDATE users SET balance = balance - ? WHERE telegram_id = ?').run(amt, userId);
    const after = Number(db.prepare('SELECT balance FROM users WHERE telegram_id = ?').get(userId)?.balance || 0);

    db.prepare(`
      INSERT INTO transactions (user_id, type, amount, description, ref_id)
      VALUES (?, 'reversal', ?, ?, ?)
    `).run(userId, -amt, `Deposit reversed: ${reason || 'fraud'}`, txid);

    rev_insert.run(userId, amt, txid, reason, adminId, before, after);
    return { before, after, amount: amt };
  })();
}

/**
 * Cancel every open order belonging to one user, in a single transaction.
 *
 * Used as a fraud response. Two things make this different from a normal
 * per-order cancel:
 *
 *  • `refund` defaults to FALSE. Money taken from a fraudster's wallet is not
 *    handed back — the funds were stolen to begin with.
 *  • Stock is genuinely restored. A paid manual order had `stock_quantity`
 *    decremented and the sold/sales counters incremented; all three are undone,
 *    otherwise a fraud wave silently destroys the inventory numbers.
 *
 * Orders already `delivered` are left untouched — the goods are gone and
 * rewriting history would corrupt the accounting. They are counted and
 * reported so the admin knows the real exposure.
 *
 * @returns {object} summary of what happened
 */
function cancelAllUserOrders(userId, { refund = false } = {}) {
  return db.transaction(() => {
    const orders = db.prepare(`
      SELECT o.*, p.title AS ptitle
      FROM orders o LEFT JOIN products p ON p.id = o.product_id
      WHERE o.user_id = ?
    `).all(userId);

    const out = {
      cancelledPending: 0,
      cancelledPaid:    0,
      manualCancelled:  0,
      refunded:         0,
      stockRestored:    0,
      delivered:        0,
      preordersFreed:   0,
    };

    for (const o of orders) {
      if (o.status === 'delivered') { out.delivered++; continue; }
      if (o.status === 'cancelled')  continue;

      // 'awaiting_delivery' means the customer already paid but nothing was
      // handed over, so the inventory reservation has to be given back.
      const wasPaid = o.status === 'awaiting_delivery';

      db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(o.id);

      if (wasPaid) {
        out.cancelledPaid++;
        adjustStockQuantity.run(o.quantity, o.product_id);      // give stock back
        db.prepare('UPDATE products SET sold_count = MAX(0, sold_count - ?) WHERE id = ?')
          .run(o.quantity, o.product_id);
        db.prepare('UPDATE products SET sales_count = MAX(0, sales_count - ?) WHERE id = ?')
          .run(o.quantity, o.product_id);
        out.stockRestored += o.quantity;

        if (refund) {
          updateBalance.run(Number(o.total_price), userId);
          out.refunded += Number(o.total_price);
        }
      } else {
        out.cancelledPending++;
      }

      // Close any manual-delivery task attached to the order.
      const upd = db.prepare(`
        UPDATE manual_deliveries
        SET status = 'cancelled',
            admin_note = 'Cancelled — fraud response',
            updated_at = datetime('now')
        WHERE order_id = ? AND status NOT IN ('delivered', 'cancelled')
      `).run(o.id);
      if (upd.changes > 0) out.manualCancelled++;
    }

    // Reject the user's outstanding refund requests: a fraudster must not be
    // able to cash stolen credit out to an external wallet.
    const ref = db.prepare(`
      UPDATE refund_requests
      SET status = 'rejected',
          admin_note = 'Rejected — fraud response',
          resolved_at = datetime('now')
      WHERE user_id = ? AND status = 'pending'
    `).run(userId);
    out.refundRequestsRejected = ref.changes;

    // Release any deposit reservations they are holding.
    const di = db.prepare(`
      UPDATE deposit_intents SET status = 'cancelled' WHERE user_id = ? AND status = 'open'
    `).run(userId);
    out.reservationsReleased = di.changes;

    out.total = orders.length;
    return out;
  })();
}

/** Preview the effect of cancelAllUserOrders without changing anything. */
function previewCancelAllUserOrders(userId) {
  const rows = db.prepare(`
    SELECT status, COUNT(*) AS n, COALESCE(SUM(total_price), 0) AS sum
    FROM orders WHERE user_id = ? GROUP BY status
  `).all(userId);
  const out = { pending: 0, awaiting: 0, delivered: 0, cancelled: 0, paidValue: 0, total: 0 };
  for (const r of rows) {
    if (r.status === 'pending')            out.pending   = r.n;
    else if (r.status === 'awaiting_delivery') { out.awaiting = r.n; out.paidValue = r.sum; }
    else if (r.status === 'delivered')     out.delivered = r.n;
    else if (r.status === 'cancelled')     out.cancelled = r.n;
    out.total += r.n;
  }
  out.pendingRefunds = db.prepare(
    "SELECT COUNT(*) AS n FROM refund_requests WHERE user_id = ? AND status = 'pending'"
  ).get(userId).n;
  return out;
}

/**
 * Compare money the way the user sees it.
 *
 * Balances are shown rounded to cents, but the old check was
 * `balance < price - 0.001`. A stored balance of 0.9989 displays as $1.00 yet
 * fails against a $1.00 price, so the customer reads "Balance: $1.00 /
 * Required: $1.00 — Insufficient balance" and cannot buy anything.
 *
 * Comparing whole cents restores the invariant the interface promises:
 * if the two displayed figures are equal, the purchase goes through.
 */
function hasEnough(balance, price) {
  return Math.round(Number(balance) * 100) >= Math.round(Number(price) * 100);
}

/**
 * Erase what a customer can still SEE of their past purchases.
 *
 * Cancelling orders does not stop a fraudster re-opening "My Orders" and
 * reading the keys that were already delivered to them. This wipes
 * `delivered_content` so the product details are gone from their side.
 *
 * The order rows themselves are kept by default: they are your sales record,
 * and deleting them would silently distort revenue and stock statistics.
 * Pass `hardDelete: true` only if you truly want no trace at all.
 *
 * @returns {object} what was removed
 */
function purgeUserOrderData(userId, { hardDelete = false } = {}) {
  return db.transaction(() => {
    const out = { contentWiped: 0, ordersDeleted: 0, manualWiped: 0, kept: 0 };

    const withContent = db.prepare(`
      SELECT COUNT(*) AS n FROM orders
      WHERE user_id = ? AND delivered_content IS NOT NULL AND delivered_content != ''
    `).get(userId).n;

    db.prepare(`
      UPDATE orders SET delivered_content = NULL
      WHERE user_id = ? AND delivered_content IS NOT NULL
    `).run(userId);
    out.contentWiped = withContent;

    // The same content is mirrored on manual-delivery tasks.
    const md = db.prepare(`
      UPDATE manual_deliveries SET delivered_content = NULL
      WHERE user_id = ? AND delivered_content IS NOT NULL
    `).run(userId);
    out.manualWiped = md.changes;

    if (hardDelete) {
      // Detach the tasks first so nothing points at a row that is about to go.
      db.prepare('DELETE FROM manual_deliveries WHERE user_id = ?').run(userId);
      const del = db.prepare('DELETE FROM orders WHERE user_id = ?').run(userId);
      out.ordersDeleted = del.changes;
    } else {
      out.kept = db.prepare('SELECT COUNT(*) AS n FROM orders WHERE user_id = ?').get(userId).n;
    }

    return out;
  })();
}

/** Preview for the purge screen. */
function previewPurge(userId) {
  const total = db.prepare('SELECT COUNT(*) AS n FROM orders WHERE user_id = ?').get(userId).n;
  const withContent = db.prepare(`
    SELECT COUNT(*) AS n FROM orders
    WHERE user_id = ? AND delivered_content IS NOT NULL AND delivered_content != ''
  `).get(userId).n;
  return { total, withContent };
}

// ── Atomic preorder: balance check + deduction in one transaction ─────────────
function chargeWalletForPreorder(userId, amount) {
  return db.transaction(() => {
    const userRow = db.prepare("SELECT balance FROM users WHERE telegram_id = ?").get(userId);
    const balance = userRow ? Number(userRow.balance) : 0;
    if (!hasEnough(balance, amount)) return { ok: false, balance };
    updateBalance.run(-amount, userId);
    return { ok: true };
  })();
}

module.exports = {
  // Users
  upsertAndGetUser,
  getUser:      (id)    => getUser.get(id),
  getUserByUsername: (username) => getUserByUsername.get(username.replace(/^@/, '')),
  getAllUsers:   ()      => getAllUsers.all(),
  setUserLanguage: (id, lang) => updateUserLanguage.run(lang, id),
  getUserLanguage: (id) => {
    const u = getUser.get(id);
    return (u && u.language) ? u.language : 'en';
  },
  searchUsers: (query) => {
    const q = `%${String(query).toLowerCase()}%`;
    return searchUsers.all(q, q, q, q);
  },
  updateBalance:(id, a) => updateBalance.run(a, id),
  banUser:      (id, b) => banUser.run(b ? 1 : 0, id),

  // Products
  getAllActiveProducts: () => getAllActiveProducts.all(),
  getStaleProducts: (thresholdDays, cooldownHours) => getStaleProducts.all(thresholdDays, cooldownHours),
  markStaleReminderSent: (productId) => markStaleReminderSent.run(productId),
  // ─── Resellers ───
  getAllResellers:     () => rs_getAll.all(),
  getResellerById:     (id) => rs_getById.get(id),
  getResellerByApiKey: (key) => rs_getByKey.get(key),
  createReseller:      (name, apiKey) => rs_insert.run(name, apiKey),
  addResellerBalance:  (id, amount) => rs_setBalance.run(amount, id),
  chargeReseller:      (id, amount) => rs_updateBalance.run(-amount, amount, 1, id),
  toggleReseller:      (id, val) => rs_toggle.run(val, id),
  deleteReseller:      (id) => rs_delete.run(id),
  createResellerOrder: (rid, pid, qty, unit, total, items) => rs_insertOrder.run(rid, pid, qty, unit, total, items),
  getResellerOrders:   (id) => rs_getOrders.all(id),
  setWholesalePrice:   (productId, price) => rs_setProductWholesale.run(price, productId),

  // ─── ChatGPT Business ───
  getBillingCycles:    () => cgb_getAllCycles.all(),
  addBillingCycle:     (s, e) => cgb_insertCycle.run(s, e),
  removeBillingCycle:  (id) => cgb_deleteCycle.run(id),
  updateBillingCycle:  (id, s, e) => cgb_updateCycle.run(s, e, id),
  getBillingCycle:     (id) => cgb_getCycleById.get(id),
  createCgbSubscription: (orderId, userId, email, start, end, days, base, extra, final) =>
    cgb_insertSub.run(orderId, userId, email, start, end, days, base, extra, final),
  getCgbSubscriptionByOrder: (orderId) => cgb_getSubByOrder.get(orderId),
  activateCgbSubscription: (orderId) => cgb_activateSub.run(orderId),
  getActiveCgbSubs: () => cgb_getActive.all(),
  getExpiringCgbSubs: (days) => cgb_getExpiringSubs.all(days),
  markCgbNotified: cgb_markNotified,
  getCgbStats: () => ({
    total:        db.prepare(`SELECT COUNT(*) AS n FROM chatgpt_subscriptions`).get().n,
    active:       db.prepare(`SELECT COUNT(*) AS n FROM chatgpt_subscriptions WHERE status='active'`).get().n,
    pending:      db.prepare(`SELECT COUNT(*) AS n FROM chatgpt_subscriptions WHERE status='pending'`).get().n,

    // All-time revenue = every subscription that was created (payment happened to reach this point)
    // We count ALL subscriptions regardless of order.status because old orders got stuck
    // at 'pending' due to the webhook bug — a chatgpt_subscriptions row = money was received.
    totalRevenue: db.prepare(`
      SELECT COALESCE(SUM(final_price), 0) AS n FROM chatgpt_subscriptions
    `).get().n,

    // This month revenue
    revenueThisMonth: db.prepare(`
      SELECT COALESCE(SUM(final_price), 0) AS n FROM chatgpt_subscriptions
      WHERE strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
    `).get().n,

    // Expiring within 7 days (active subs)
    expiringSoon: db.prepare(`
      SELECT COUNT(*) AS n FROM chatgpt_subscriptions
      WHERE status = 'active'
        AND date(end_date) BETWEEN date('now') AND date('now', '+7 days')
    `).get().n,

    // Pending = created but not yet activated by admin (awaiting manual activation)
    awaitingActivation: db.prepare(`
      SELECT COUNT(*) AS n FROM chatgpt_subscriptions WHERE status = 'pending'
    `).get().n,

    // Last 10 orders for overview
    recentOrders: db.prepare(`
      SELECT cs.order_id, cs.email, cs.final_price, cs.status,
             cs.end_date, cs.created_at, o.payment_method
      FROM chatgpt_subscriptions cs
      LEFT JOIN orders o ON o.id = cs.order_id
      ORDER BY cs.created_at DESC LIMIT 10
    `).all(),
  }),

  // ─── Categories ───
  getAllCategories:    ()                       => cat_getAll.all(),
  getCategoryById:     (id)                     => cat_getById.get(id),
  createCategory:      (name, emoji, order)     => cat_insert.run(name, emoji || '', order || 999),
  updateCategoryRow:   (id, name, emoji, order) => cat_update.run(name, emoji || '', order || 999, id),
  deleteCategory:      (id) => { cat_resetProducts.run(id); return cat_delete.run(id); },
  getProductsByCategory: (catId) => cat_getProducts.all(catId),
  setProductCategory:  (productId, catId)       => cat_setProduct.run(catId, productId),
  getAllProductsForSorting: () => getAllProductsForSorting.all(),

  /**
   * The products of ONE customer-visible list, in the order they appear there.
   * @param {number|null} categoryId  null → the "📦 Other Products" group
   */
  getProductsForSorting: (categoryId = null) =>
    (categoryId == null || categoryId === 0)
      ? getUncategorizedForSorting.all()
      : getCategoryForSorting.all(categoryId),

  // Same ordering, but carrying the fields a picker needs. getAllProductsForSorting
  // returns only (id, title, display_order, is_active) — no price — so a picker
  // built on it would show $0.00 for every product.
  getAllProductsBrief: () => db.prepare(`
    SELECT id, title, price, is_active, stock_quantity
    FROM products
    ORDER BY display_order ASC, id ASC
  `).all(),

  // Preorders
  // Emoji Library
  addEmoji: (name, emojiId, fallback = '🎁') => {
    try { return insertEmoji.run(name, emojiId, fallback); }
    catch (e) { return null; }
  },
  getAllEmojis: () => getAllEmojis.all(),
  getEmojiByName: (name) => getEmojiByName.get(name),
  getEmojiById: (id) => getEmojiById.get(id),
  deleteEmoji: (id) => deleteEmojiById.run(id),

  getPreorderEnabledProducts: () => getPreorderEnabledProducts.all(),
  createPreorder: (data) => insertPreorder.run(data),
  getAllPreorders: () => getAllPreorders.all(),
  getReservedPreordersByProduct: (productId) => getReservedPreordersByProduct.all(productId),
  getPreorderById: (id) => getPreorderById.get(id),
  markPreorderDelivered: (id, content) => updatePreorderStatus.run('delivered', content, id),
  markPreorderRefunded: (id) => updatePreorderStatus.run('refunded', null, id),
  incrementPreorderCount: (productId, qty) => incrementPreorderCount.run(qty, productId),
  getPreorderStats: () => getPreorderStats.get(),
  setDisplayOrder: (id, order) => updateDisplayOrder.run(order, id),
  getProduct:          (id) => getProduct.get(id),
  insertProduct: (data) => {
    const res = insertProduct.run({
      ...data,
      stockQuantity: data.stockQuantity || 0,
      salesCount:    data.salesCount    || 0,
    });
    return res.lastInsertRowid;
  },
  updateProduct: (id, field, value) => {
    const allowed = [
      'title','description','price','warranty',
      'requires_email','image_file_id','is_active',
      'stock_quantity','sales_count',
      'bulk_min_qty','bulk_discount','instruction','display_order',
      'preorder_enabled','preorder_max','preorder_count',
      'cost_price','premium_emoji_id',
      'bulk_tier1_qty','bulk_tier1_price',
      'bulk_tier2_qty','bulk_tier2_price',
      'bulk_tier3_qty','bulk_tier3_price',
      'wholesale_price','category_id',
      // V2
      'refund_enabled','delivery_type','low_stock_threshold',
    ];
    if (!allowed.includes(field)) throw new Error(`Field ${field} not allowed`);
    db.prepare(`UPDATE products SET ${field} = ? WHERE id = ?`).run(value, id);
  },
  softDeleteProduct: (id) => softDeleteProduct.run(id),

  // Stock quantity (numeric counter on products)
  adjustStockQuantity: (id, delta) => {
    const before = getProduct.get(id);
    adjustStockQuantity.run(delta, id);
    const after = getProduct.get(id);
    return { before: before?.stock_quantity || 0, after: after?.stock_quantity || 0 };
  },
  setStockQuantity: (id, qty) => {
    setStockQuantity.run(Math.max(0, qty), id);
    return getProduct.get(id)?.stock_quantity || 0;
  },
  setSalesCount: (id, count) => {
    db.prepare('UPDATE products SET sales_count = MAX(0, ?) WHERE id = ?').run(count, id);
  },

  // Stock (line items)
  addStockItems,
  getAvailableStock: (id, qty) => getAvailableStock.all(id, qty),
  getStockItems:     (id)      => getStockItems.all(id),
  getStockCount:     (id)      => getStockCount.get(id).cnt,
  clearUnsoldStock:  (id)      => clearUnsoldStock.run(id),

  // Orders
  createOrder: (data) => {
    const res = insertOrder.run(data);
    return res.lastInsertRowid;
  },
  getOrder:         (id) => getOrder.get(id),
  getUserOrders:    (id) => getUserOrders.all(id),
  getAllOrders:      ()  => getAllOrders.all(),
  updateOrderStatus:(id, status) => updateOrderStatus.run(status, id),
  deliverOrder,
  deliverOrderAndChargeWallet,
  chargeWalletForPreorder,

  // Transactions
  addTransaction:    (data) => insertTransaction.run(data),
  isRefIdUsed:       (ref)  => !!isRefIdUsed.get(ref),
  getUserTransactions:(id)  => getUserTransactions.all(id),
  getTransactionById: (id) => getTransactionById.get(id),

  // VIP
  unlockVIP: (userId) => unlockVIPQuery.run(userId),
  isVIP: (userId) => {
    const r = isVIPQuery.get(userId);
    return r && r.is_vip === 1;
  },
  countVIPs: () => countVIPsQuery.get().count,
  countReferrals: (userId) => countReferralsForUser.get(userId).count,
  countReferralsWithPurchase: (userId) => countReferralsWithPurchaseQuery.get(userId).count,
  hasAnyInviteePurchased: (userId) => hasAnyInviteePurchasedQuery.get(userId).count > 0,

  // Refund Requests
  addRefundRequest: (data) => insertRefundRequest.run(
    data.userId, data.orderId, data.reason || '', data.amount || 0,
    data.affectedAccount || null, data.photoFileId || null,
    data.refundMethod || null, data.cryptoNetwork || null, data.walletAddress || null
  ),
  getUserRefundRequests: (userId) => getUserRefundRequests.all(userId),
  getAllRefundRequests: () => getAllRefundRequests.all(),
  getRefundRequestById: (id) => getRefundRequestById.get(id),
  getPendingRefundForOrder: (orderId) => getPendingRefundForOrder.get(orderId),
  updateRefundRequest: (id, status, note, amount, method) =>
    updateRefundRequestStatus.run(status, note || null, amount || 0, method || null, id),

  // NOWPayments (legacy, kept for DB compat — not used in code)
  saveInvoice: (data) => {
    const res = insertInvoice.run({
      ...data,
      purpose:        data.purpose        || 'wallet_topup',
      relatedOrderId: data.relatedOrderId || null,
    });
    return res.lastInsertRowid;
  },
  getInvoiceByOrderId:   (id) => getInvoiceByOrderId.get(id),
  getInvoiceByPaymentId: (id) => getInvoiceByPaymentId.get(id),
  updateInvoice: (orderId, paymentId, paymentStatus) =>
    updateInvoice.run({ orderId, paymentId, paymentStatus }),
  markInvoiceCredited: (orderId, txHash) =>
    markInvoiceCredited.run(txHash || null, orderId),
  isInvoiceCredited: (orderId) => {
    const row = isInvoiceCredited.get(orderId);
    return row ? row.credited === 1 : false;
  },

  // BEP20 deposits (legacy table, kept for compatibility)
  isBep20TxUsed: (txHash) => !!getBep20DepositByHash.get(txHash),
  saveBep20Deposit: (data) => {
    const res = insertBep20Deposit.run({
      currency: 'USDT',
      network:  'BEP20',
      status:   'completed',
      fromAddr: null,
      toAddr:   null,
      ...data,
    });
    return res.lastInsertRowid;
  },

  // Generic used-TxID checks (Binance verified deposits — TRC20 + BEP20 + Binance Pay)
  isTxidUsed: (txid) => !!getUsedTxid.get(txid),
  saveUsedTxid: (data) => {
    const res = insertUsedTxid.run({
      asset:   'USDT',
      address: null,
      ...data,
    });
    return res.lastInsertRowid;
  },

  // CryptoBot invoices
  saveCryptobotInvoice: (data) => {
    const res = insertCryptobotInvoice.run(data);
    return res.lastInsertRowid;
  },
  getCryptobotInvoice: (invoiceId) => getCryptobotInvoiceById.get(invoiceId),
  markCryptobotInvoicePaid: (invoiceId) => {
    const res = markCryptobotPaid.run(invoiceId);
    return res.changes > 0; // true if it was the first time we mark as paid
  },
  getActiveCryptobotInvoices: (userId) => getActiveCryptobotInvoicesForUser.all(userId),


  // Pending payments
  createPendingPayment: (data) => {
    const res = insertPendingPayment.run(data);
    return res.lastInsertRowid;
  },
  updatePendingPayment: (id, status, refId) => updatePendingPayment.run(status, refId, id),
  getPendingPayments:   () => getPendingPayments.all(),

  // Support
  createTicket:  (userId, message) => { const r = insertTicket.run(userId, message); return r.lastInsertRowid; },
  getTicket:     (id)              => getTicket.get(id),
  replyTicket:   (id, reply)       => replyTicket.run(reply, id),
  getOpenTickets:()                => getOpenTickets.all(),

  // Referrals
  recordReferral: (referrerId, referredId) => {
    if (referrerId === referredId) return { success: false, reason: 'self_referral' };
    // Check if referred user already has any orders or activity (fraud prevention)
    const existing = db.prepare('SELECT * FROM referrals WHERE referred_id = ?').get(referredId);
    if (existing) return { success: false, reason: 'already_referred' };
    // Check if referrer exists
    const referrer = getUser.get(referrerId);
    if (!referrer) return { success: false, reason: 'referrer_not_found' };
    const result = insertReferral.run(referrerId, referredId);
    if (result.changes === 0) return { success: false, reason: 'duplicate' };
    return { success: true, referrerId, referredId };
  },
  payReferralReward,
  payCashbackReferral,
  getReferralStats: (userId) => {
    const row = getReferralStats.get(userId);
    return { totalReferred: row.total_referred || 0, rewardedCount: row.rewarded_count || 0 };
  },

  // Settings
  getSetting: (key, defaultVal = '') => {
    const row = getSetting.get(key);
    return row ? row.value : defaultVal;
  },
  setSetting: (key, value) => setSetting.run(key, String(value)),

  // Back-in-stock notifications
  subscribeBackInStock:  (userId, productId) => subscribeBackInStock.run(userId, productId),
  isSubscribedBackInStock: (userId, productId) => !!isSubscribedBackInStock.get(userId, productId),
  getBackInStockSubscribers:  (productId) => getBackInStockSubscribers.all(productId).map((r) => r.user_id),
  clearBackInStockSubscriptions: (productId) => clearBackInStockSubscriptions.run(productId),

  // Stats
  getStats,
  getProfitToday,
  getProfitLast7Days,
  getProfitThisMonth,
  getProfitByDay,

  // Refunds
  createRefund: (data) => { insertRefund.run(data); },
  getRefundByOrderId: (orderId) => getRefundByOrderId.get(orderId),

  // Delete single stock item by id
  deleteStockItem: (stockId) => db.prepare('DELETE FROM stock WHERE id = ?').run(stockId),
  getStockItemById: (stockId) => db.prepare('SELECT * FROM stock WHERE id = ?').get(stockId),

  // ═══ V2: order history ═══
  getUserOrdersAll:      (userId)          => getUserOrdersAll.all(userId),
  getUserOrdersFiltered,

  // ═══ V2: refund eligibility ═══
  isProductRefundable,
  isOrderRefundable,
  getRefundableUserOrders: (userId) => getRefundableUserOrders.all(userId),

  // ═══ V2: manual delivery ═══
  createManualDelivery: (data) => {
    const res = md_insert.run({
      email:         null,
      paymentMethod: null,
      ...data,
    });
    // changes === 0 → a task for this order already existed (duplicate guard)
    return { created: res.changes > 0, row: md_getByOrder.get(data.orderId) };
  },
  getManualDeliveryByOrder: (orderId) => md_getByOrder.get(orderId),
  getManualDelivery:        (id)      => md_getById.get(id),
  getAllManualDeliveries:   ()        => md_listAll.all(),
  getUserManualDeliveries:  (userId)  => md_userList.all(userId),
  getManualDeliveryCounts:  () => {
    const out = { pending: 0, processing: 0, delivered: 0, cancelled: 0, total: 0, unseen: 0 };
    for (const r of md_countByStatus.all()) {
      if (out[r.status] !== undefined) out[r.status] = r.n;
      out.total += r.n;
    }
    out.unseen = db.prepare(
      "SELECT COUNT(*) AS n FROM manual_deliveries WHERE seen_at IS NULL AND status = 'pending'"
    ).get().n;
    return out;
  },
  setManualDeliveryStatus:  (id, status, note = null) => md_setStatus.run(status, note, id),
  markManualDelivered:      (id, content = null) => md_markDelivered.run(content, id).changes > 0,
  markManualNotified:       (id) => md_markNotified.run(id).changes > 0,
  markManualSeen:           (id) => md_markSeen.run(id),
  chargeWalletForManualOrder,
  settleManualOrderExternal,

  /**
   * Products that are out of stock RIGHT NOW.
   *
   * Read live from the products table rather than from stored notifications,
   * so the list cannot drift: the moment stock is added the product simply
   * stops matching the query and disappears. No cleanup, no stale rows.
   */
  getOutOfStockProducts: () => db.prepare(`
    SELECT id, title, price, stock_quantity, sales_count, is_active, last_sold_at
    FROM products
    WHERE COALESCE(stock_quantity, 0) <= 0 AND is_active = 1
    ORDER BY COALESCE(last_sold_at, created_at) DESC, id DESC
  `).all(),

  countOutOfStockProducts: () => db.prepare(
    'SELECT COUNT(*) AS n FROM products WHERE COALESCE(stock_quantity,0) <= 0 AND is_active = 1'
  ).get().n,

  countPendingRefundRequests: () => db.prepare(
    "SELECT COUNT(*) AS n FROM refund_requests WHERE status = 'pending'"
  ).get().n,

  // NOTE: `orders` has no product_title column — the title lives on `products`
  // and must be reached through orders.product_id. Selecting o.product_title
  // made SQLite throw "no such column", which broke the whole Refunds screen
  // while the counter (a separate query) kept working.
  listPendingRefundRequests: (limit, offset) => db.prepare(`
    SELECT r.*, u.username, u.first_name,
           p.title AS product_title,
           o.quantity, o.total_price, o.status AS order_status
    FROM refund_requests r
    LEFT JOIN users    u ON u.telegram_id = r.user_id
    LEFT JOIN orders   o ON o.id = r.order_id
    LEFT JOIN products p ON p.id = o.product_id
    WHERE r.status = 'pending'
    ORDER BY r.id DESC LIMIT ? OFFSET ?
  `).all(limit, offset),

  /**
   * Everything held in customer wallets right now.
   *
   * This is a LIABILITY, not income: the money has already been paid to you,
   * but the customers have not spent it yet and can still buy with it or ask
   * for it back. Worth watching alongside profit.
   */
  getWalletTreasury: () => {
    const totals = db.prepare(`
      SELECT
        COALESCE(SUM(balance), 0)                              AS total,
        COUNT(*)                                               AS users_total,
        COUNT(CASE WHEN balance >  0.004 THEN 1 END)           AS users_funded,
        COUNT(CASE WHEN balance <  -0.004 THEN 1 END)          AS users_negative,
        COALESCE(SUM(CASE WHEN balance < 0 THEN balance END),0) AS negative_total,
        COALESCE(MAX(balance), 0)                              AS largest
      FROM users
    `).get();

    // Lifetime flows. 'deposit' and 'refund' add money, purchases remove it.
    const flows = db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN amount > 0 THEN amount END), 0) AS credited,
        COALESCE(SUM(CASE WHEN amount < 0 THEN -amount END), 0) AS spent
      FROM transactions
      WHERE status = 'completed' OR status IS NULL
    `).get();

    const byType = db.prepare(`
      SELECT type,
             COUNT(*) AS n,
             COALESCE(SUM(amount), 0) AS sum
      FROM transactions
      WHERE status = 'completed' OR status IS NULL
      GROUP BY type
      ORDER BY ABS(SUM(amount)) DESC
    `).all();

    let resellers = { count: 0, total: 0 };
    try {
      resellers = db.prepare(`
        SELECT COUNT(*) AS count, COALESCE(SUM(balance), 0) AS total
        FROM resellers WHERE is_active = 1
      `).get();
    } catch (e) { /* table may not exist on older installs */ }

    return {
      total:          Number(totals.total) || 0,
      usersTotal:     totals.users_total,
      usersFunded:    totals.users_funded,
      usersNegative:  totals.users_negative,
      negativeTotal:  Number(totals.negative_total) || 0,
      largest:        Number(totals.largest) || 0,
      credited:       Number(flows.credited) || 0,
      spent:          Number(flows.spent) || 0,
      byType,
      resellerCount:  resellers.count || 0,
      resellerTotal:  Number(resellers.total) || 0,
    };
  },

  /** Biggest wallet holders, for the same screen. */
  getTopWallets: (limit = 10) => db.prepare(`
    SELECT telegram_id, username, first_name, balance
    FROM users
    WHERE balance > 0.004
    ORDER BY balance DESC
    LIMIT ?
  `).all(limit),

  // ═══ Self-service API keys ═══

  /** The key for a user, creating one on first request. */
  getOrCreateApiKey: (userId) => {
    const existing = db.prepare('SELECT * FROM api_keys WHERE user_id = ?').get(userId);
    if (existing) return existing;
    const key = 'sk_' + require('crypto').randomBytes(24).toString('hex');
    db.prepare('INSERT INTO api_keys (api_key, user_id) VALUES (?, ?)').run(key, userId);
    return db.prepare('SELECT * FROM api_keys WHERE user_id = ?').get(userId);
  },

  /** Replace a key — used when a customer thinks theirs leaked. */
  regenerateApiKey: (userId) => {
    const key = 'sk_' + require('crypto').randomBytes(24).toString('hex');
    db.prepare('DELETE FROM api_keys WHERE user_id = ?').run(userId);
    db.prepare('INSERT INTO api_keys (api_key, user_id) VALUES (?, ?)').run(key, userId);
    return db.prepare('SELECT * FROM api_keys WHERE user_id = ?').get(userId);
  },

  getApiKey: (userId) => db.prepare('SELECT * FROM api_keys WHERE user_id = ?').get(userId),

  /** Resolve a key to its owner. Returns null for unknown or disabled keys. */
  resolveApiKey: (key) => db.prepare(
    "SELECT * FROM api_keys WHERE api_key = ? AND is_active = 1"
  ).get(String(key || '')),

  touchApiKey: (key) => db.prepare(
    "UPDATE api_keys SET requests = requests + 1, last_used_at = datetime('now') WHERE api_key = ?"
  ).run(key),

  setApiKeyActive: (userId, active) => db.prepare(
    'UPDATE api_keys SET is_active = ? WHERE user_id = ?'
  ).run(active ? 1 : 0, userId),

  // ═══ Per-customer pricing ═══

  /**
   * The customer's live allowance for one product.
   *
   * `remaining` is derived from the usage ledger rather than a stored counter,
   * so it can never drift: cancelled or replayed orders simply are not in the
   * ledger. A qty_limit of 0 means unlimited.
   *
   * @returns {null|{price, limit, used, remaining, unlimited, note}}
   */
  getCustomerAllowance: (userId, productId) => {
    const row = db.prepare(`
      SELECT price, qty_limit, note FROM customer_prices
      WHERE user_id = ? AND product_id = ?
      ORDER BY min_qty ASC LIMIT 1
    `).get(userId, productId);
    if (!row) return null;

    const used = db.prepare(`
      SELECT COALESCE(SUM(units), 0) AS n FROM customer_price_usage
      WHERE user_id = ? AND product_id = ?
    `).get(userId, productId).n;

    const limit = Number(row.qty_limit) || 0;
    return {
      price: Number(row.price),
      limit,
      used,
      unlimited: limit === 0,
      remaining: limit === 0 ? Infinity : Math.max(0, limit - used),
      note: row.note,
    };
  },

  /**
   * Work out what this customer actually pays for `quantity` units.
   *
   * The allowance covers the first N units only; anything beyond it falls back
   * to the normal price (including the product's own bulk tiers). So an
   * allowance of 20 at $1.00 on a $2.00 product means 25 units cost
   * 20x$1.00 + 5x$2.00 = $30.00, and the next order is at the normal price.
   *
   * @returns {{total, unitPrice, specialUnits, specialPrice, normalUnits,
   *            normalUnitPrice, hasAllowance, remainingAfter}}
   */
  resolveCustomerPricing: (userId, product, quantity) => {
    const { calcOrderPrice } = require('../utils/format');
    const qty = Math.max(1, Number(quantity) || 1);
    const normal = calcOrderPrice(product, qty);

    const allowance = module.exports.getCustomerAllowance(userId, product.id);
    if (!allowance) {
      return {
        total: normal.total, unitPrice: normal.unitPrice,
        specialUnits: 0, specialPrice: 0,
        normalUnits: qty, normalUnitPrice: normal.unitPrice,
        hasAllowance: false, remainingAfter: 0,
        discount: normal.discount, discountApplied: normal.discountApplied,
      };
    }

    const specialUnits = allowance.unlimited ? qty : Math.min(qty, allowance.remaining);
    const normalUnits  = qty - specialUnits;

    // Price the leftover units on their own, so bulk tiers are judged on the
    // quantity actually bought at the normal price — not on the whole order.
    const leftover = normalUnits > 0 ? calcOrderPrice(product, normalUnits) : { total: 0, unitPrice: Number(product.price) };
    const total = Number((specialUnits * allowance.price + leftover.total).toFixed(6));

    return {
      total,
      unitPrice: Number((total / qty).toFixed(6)),
      specialUnits,
      specialPrice: allowance.price,
      normalUnits,
      normalUnitPrice: leftover.unitPrice,
      hasAllowance: true,
      unlimited: allowance.unlimited,
      remainingAfter: allowance.unlimited ? Infinity : allowance.remaining - specialUnits,
      discount: 0, discountApplied: false,
    };
  },

  /**
   * Record that an order consumed part of the allowance.
   *
   * Called only after payment succeeds — an abandoned order must not eat the
   * customer's allowance. INSERT OR IGNORE on the order_id primary key makes it
   * safe to call more than once for the same order.
   */
  consumeCustomerAllowance: (orderId, userId, productId, units) => {
    if (!units || units <= 0) return false;
    const res = db.prepare(`
      INSERT OR IGNORE INTO customer_price_usage (order_id, user_id, product_id, units)
      VALUES (?, ?, ?, ?)
    `).run(orderId, userId, productId, units);
    return res.changes > 0;
  },

  /** Give the allowance back when an order is cancelled or refunded. */
  releaseCustomerAllowance: (orderId) =>
    db.prepare('DELETE FROM customer_price_usage WHERE order_id = ?').run(orderId).changes > 0,


  /**
   * The price THIS customer pays for THIS product.
   *
   * Every price shown or charged must go through here, otherwise a customer
   * could be quoted their special price and then billed the public one.
   */
  getEffectivePrice: (userId, productId, fallbackPrice) => {
    const row = db.prepare(
      'SELECT price FROM customer_prices WHERE user_id = ? AND product_id = ?'
    ).get(userId, productId);
    return row ? Number(row.price) : Number(fallbackPrice);
  },

  /**
   * Return the product as THIS customer sees it.
   *
   * A negotiated price overrides the public price and also switches off the
   * bulk tiers: the agreed figure is the agreed figure, whatever the quantity.
   * Because every screen and the checkout all read `product.price`, swapping it
   * here means the quoted price and the charged price can never diverge.
   */
  /**
   * The product as this customer sees it on a listing or detail screen.
   *
   * Display only — the charged total comes from resolveCustomerPricing, which
   * splits an order across the allowance and the normal price. Here the special
   * price is shown while any allowance is left, and the public price once it is
   * used up, so the screen never advertises a price the customer can no longer get.
   */
  productForCustomer: (userId, product, quantity = 1) => {
    if (!product || !userId) return product;
    const allowance = module.exports.getCustomerAllowance(userId, product.id);
    if (!allowance || allowance.remaining <= 0) return product;
    return {
      ...product,
      price: allowance.price,
      publicPrice: Number(product.price),
      hasCustomPrice: true,
      allowanceRemaining: allowance.remaining,
      allowanceUnlimited: allowance.unlimited,
      bulk_tier1_qty: 0, bulk_tier1_price: 0,
      bulk_tier2_qty: 0, bulk_tier2_price: 0,
      bulk_tier3_qty: 0, bulk_tier3_price: 0,
      bulk_min_qty: 0, bulk_discount: 0,
    };
  },

  hasCustomPrice: (userId, productId) => !!db.prepare(
    'SELECT 1 FROM customer_prices WHERE user_id = ? AND product_id = ?'
  ).get(userId, productId),

  setCustomerPrice: ({ userId, productId, price, note = null, adminId = null, minQty = 1, qtyLimit = 0 }) =>
    db.prepare(`
      INSERT INTO customer_prices (user_id, product_id, price, note, created_by, min_qty, qty_limit)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, product_id, min_qty) DO UPDATE SET
        price = excluded.price,
        note = excluded.note,
        qty_limit = excluded.qty_limit,
        updated_at = datetime('now')
    `).run(userId, productId, Number(price), note, adminId,
           Math.max(1, Number(minQty) || 1), Math.max(0, Number(qtyLimit) || 0)),

  // minQty null removes every tier for that product.
  removeCustomerPrice: (userId, productId, minQty = null) => (
    minQty == null
      ? db.prepare('DELETE FROM customer_prices WHERE user_id = ? AND product_id = ?')
          .run(userId, productId).changes
      : db.prepare('DELETE FROM customer_prices WHERE user_id = ? AND product_id = ? AND min_qty = ?')
          .run(userId, productId, minQty).changes
  ),

  listCustomerPrices: (userId) => db.prepare(`
    SELECT cp.*, p.title, p.price AS public_price
    FROM customer_prices cp
    LEFT JOIN products p ON p.id = cp.product_id
    WHERE cp.user_id = ?
    ORDER BY cp.product_id ASC, cp.min_qty ASC
  `).all(userId),

  listPricesForProduct: (productId) => db.prepare(`
    SELECT cp.*, u.username, u.first_name
    FROM customer_prices cp
    LEFT JOIN users u ON u.telegram_id = cp.user_id
    WHERE cp.product_id = ?
    ORDER BY cp.id DESC
  `).all(productId),

  countCustomerPrices: (userId) => db.prepare(
    'SELECT COUNT(*) AS n FROM customer_prices WHERE user_id = ?'
  ).get(userId).n,

  // ═══ V2: stock alert latches ═══
  deleteStockNotifications: (productId) => db.prepare(`
    DELETE FROM admin_notifications
    WHERE type IN ('stock_out','stock_low') AND ref_type = 'product' AND ref_id = ?
  `).run(String(productId)).changes,

  setOosNotified: (id, v) => stock_setOosNotified.run(v ? 1 : 0, id),
  setLowNotified: (id, v) => stock_setLowNotified.run(v ? 1 : 0, id),
  resetStockAlertFlags: (id) => stock_resetFlags.run(id),

  // ═══ V2: support threads ═══
  ensureSupportThread: (userId) => { th_ensure.run(userId); return th_get.get(userId); },
  getSupportThread:    (userId) => th_get.get(userId),
  markSupportWelcomed: (userId) => th_setWelcomed.run(userId),
  setSupportStatusMsg: (userId, msgId, state, pending) =>
    th_setStatusMsg.run(msgId, state, pending, userId),
  markSupportThreadRead: (userId) => {
    sm_markRead.run(userId);
    th_markRead.run(userId);
  },
  getSupportUnreadThreads: () => sm_unreadTotal.get().n,

  // ═══ V2: admin notification centre ═══
  addAdminNotification: (data) => {
    const res = an_insert.run({
      body:    null,
      refType: null,
      refId:   null,
      ...data,
    });
    return res.changes > 0; // false → duplicate, already recorded
  },
  getAdminNotifications: (limit, offset, unreadOnly = false) =>
    (unreadOnly ? an_listUnread : an_list).all(limit, offset),
  getAdminNotification:      (id) => an_get.get(id),
  // Filter the inbox by type — used by the Support Bot's Stock Alerts section.
  // The type list is built by the caller from a fixed whitelist, never input.
  getNotificationsByType: (types, limit, offset) => {
    const marks = types.map(() => '?').join(',');
    return db.prepare(
      `SELECT * FROM admin_notifications WHERE type IN (${marks}) ORDER BY id DESC LIMIT ? OFFSET ?`
    ).all(...types, limit, offset);
  },
  countNotificationsByType: (types, unreadOnly = false) => {
    const marks = types.map(() => '?').join(',');
    return db.prepare(
      `SELECT COUNT(*) AS n FROM admin_notifications WHERE type IN (${marks})` +
      (unreadOnly ? ' AND is_read = 0' : '')
    ).get(...types).n;
  },
  countAdminNotifications:   ()   => an_countAll.get().n,
  countUnreadNotifications:  ()   => an_countUnread.get().n,
  markNotificationRead:      (id) => an_markRead.run(id),
  markAllNotificationsRead:  ()   => an_markAllRead.run().changes,

  cancelAllUserOrders,
  previewCancelAllUserOrders,
  purgeUserOrderData,
  previewPurge,

  // ═══ Pending (uncredited) deposits ═══
  recordPendingDeposit: (d) => db.prepare(`
    INSERT INTO pending_deposits (txid, user_id, amount, network, insert_time)
    VALUES (@txid, @userId, @amount, @network, @insertTime)
    ON CONFLICT(txid) DO UPDATE SET
      attempts  = attempts + 1,
      last_seen = datetime('now')
  `).run({ amount: null, network: null, insertTime: null, ...d }),

  clearPendingDeposit: (txid) =>
    db.prepare('DELETE FROM pending_deposits WHERE txid = ? COLLATE NOCASE').run(txid),

  listPendingDeposits: () => db.prepare(`
    SELECT pd.*, u.username, u.first_name
    FROM pending_deposits pd
    LEFT JOIN users u ON u.telegram_id = pd.user_id
    ORDER BY pd.last_seen DESC
  `).all(),

  countPendingDeposits: () =>
    db.prepare('SELECT COUNT(*) AS n FROM pending_deposits').get().n,

  getPendingDeposit: (txid) =>
    db.prepare('SELECT * FROM pending_deposits WHERE txid = ? COLLATE NOCASE').get(txid),

  // ═══ V3: deposit security ═══
  createDepositIntent,
  getOpenIntents,
  findIntentForDeposit,
  claimDepositIntent,
  cancelDepositIntent,
  getDepositIntent: (id) => di_get.get(id),

  addDepositReview: (data) => {
    const res = dr_insert.run({ address: null, insertTime: null, reason: null, ...data });
    return { created: res.changes > 0, row: dr_byTxid.get(data.txid) };
  },
  getDepositReview:        (id) => dr_get.get(id),
  getDepositReviewByTxid:  (txid) => dr_byTxid.get(txid),
  listDepositReviews:      (status, limit, offset) => dr_list.all(status, limit, offset),
  countDepositReviews:     (status) => dr_count.get(status).n,
  resolveDepositReview:    (id, status, note, adminId) =>
    dr_resolve.run(status, note, adminId, id).changes > 0,

  reverseDeposit,
  listReversals: (limit = 20) => rev_list.all(limit),

  // Raw db
  db,
};
