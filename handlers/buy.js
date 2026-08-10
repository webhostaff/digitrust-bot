'use strict';

const db      = require('../database/queries');
const dbRaw   = require('../database/db');
const session = require('./session');
const { States } = require('./session');
const config  = require('../config');
const {
  orderConfirmKb, paymentMethodKb, cancelKb, backKb, mainMenuKb, walletMenuKb,
} = require('../utils/keyboard');
const { formatPrice, formatReward, calcOrderPrice, PAYMENT_CONFIRM_VALIDITY_MIN, checkPaymentWindow } = require('../utils/format');
const cryptobot = require('../services/cryptobot');
const { checkAndNotifyStockLevel } = require('../services/notifications');
const { evaluateStock } = require('../services/stockAlerts');
const manualDelivery = require('./manualDelivery');
const {
  verifyDepositByTxId, verifyBinancePayOrder, TXID_RE,
} = require('../services/binance');
const logger = require('../utils/logger');
const { t } = require('../utils/i18n');
const escapeHtml = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

// ── Initiate buy ──────────────────────────────────────────────────────────────

async function initiateBuy(bot, chatId, userId, productId, callbackQueryId) {
  let product = db.getProduct(productId);
  // A negotiated price for this customer replaces the public one, so the
  // quoted price and the charged price can never diverge.
  product = db.productForCustomer(userId, product);

  // Use stock_quantity for purchase eligibility
  const stockQty = product?.stock_quantity || 0;

  if (!product || stockQty < 1) {
    // Show friendly out-of-stock message instead of just an alert
    await bot.answerCallbackQuery(callbackQueryId, { text: '' }).catch(() => {});
    await bot.sendMessage(
      chatId,
      `❌ <b>${product?.title || 'This product'} is currently out of stock.</b>\n\n` +
      `You can enable notifications and we will notify you when it is available again.`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔔 Notify me when back in stock', callback_data: `notify_back_${productId}` }],
            [{ text: '🔙 Back to Products', callback_data: 'menu_products' }],
          ],
        },
      }
    );
    return;
  }

  session.set(userId, States.BUY_QUANTITY, {
    productId,
    productTitle: product.title,
    productPrice: product.price,
    bulkMinQty:   product.bulk_min_qty || 0,
    bulkDiscount: product.bulk_discount || 0,
    requiresEmail: product.requires_email === 1,
    maxQty: stockQty,   // no artificial cap — real stock is the limit
  });

  const { formatBulkTiersDisplay: _ftd } = require('../utils/format');
  const bulkLine = _ftd(product);

  await bot.sendMessage(
    chatId,
    `🛒 <b>${product.title}</b>\n\n` +
    `💵 Price per unit: <b>${formatPrice(product.price)}</b>\n` +
    `📦 Available: <b>${stockQty}</b>${bulkLine}\n\n` +
    `📦 <b>How many would you like?</b> (1–${stockQty})`,
    { parse_mode: 'HTML', reply_markup: cancelKb('menu_products') }
  );
}

// ── Step: quantity ────────────────────────────────────────────────────────────

async function handleQuantity(bot, msg) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const sess   = session.get(userId);

  // Re-check live stock before proceeding
  let product  = db.getProduct(sess.data.productId);
  const stockQty = product?.stock_quantity || 0;
  const raw      = (msg.text || '').trim();
  const qty      = parseInt(raw, 10);

  if (isNaN(qty) || qty < 1) {
    await bot.sendMessage(chatId, '❌ Enter a valid number (minimum 1).');
    return;
  }


  if (qty > stockQty) {
    await bot.sendMessage(chatId, `❌ Only <b>${stockQty}</b> available.`, { parse_mode: 'HTML' });
    return;
  }

  // An allowance covers only its first N units; anything beyond falls back to
  // the normal price, so the two portions are priced separately and summed.
  const pricing = db.resolveCustomerPricing(userId, product, qty);
  let { total, unitPrice, discount, discountApplied } = pricing;
  // Apply 5% VIP discount on top
  const isVipUser = db.isVIP(userId);
  if (isVipUser) {
    total = Number((total * 0.95).toFixed(2));
    unitPrice = Number((unitPrice * 0.95).toFixed(4));
  }
  session.update(userId, {
    quantity: qty, total, unitPrice, discount, discountApplied,
    // Remembered so the allowance is consumed only for the units it actually
    // covered, and only once payment succeeds.
    allowanceUnits: pricing.specialUnits || 0,
    allowancePrice: pricing.specialPrice || 0,
    normalUnits:    pricing.normalUnits || 0,
  });

  if (sess.data.requiresEmail) {
    session.set(userId, States.BUY_EMAIL, session.get(userId).data);
    await bot.sendMessage(chatId, '📧 <b>Enter your email address:</b>', {
      parse_mode: 'HTML', reply_markup: cancelKb('back_main'),
    });
  } else {
    await createAndShowSummary(bot, chatId, userId, null);
  }
}

// ── Step: email ───────────────────────────────────────────────────────────────

async function handleEmail(bot, msg) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const email  = (msg.text || '').trim();

  if (!email.includes('@') || !email.includes('.')) {
    await bot.sendMessage(chatId, '❌ Invalid email. Example: <code>user@gmail.com</code>', { parse_mode: 'HTML' });
    return;
  }
  session.update(userId, { email });
  await createAndShowSummary(bot, chatId, userId, email);
}

// ── Create order + show summary ───────────────────────────────────────────────

// In-memory cooldown map: userId → last order timestamp
const ORDER_COOLDOWN = new Map();
const COOLDOWN_MS = 10 * 1000; // 10 seconds between orders
const MAX_QTY_PER_ORDER = 50;  // Hard cap

async function createAndShowSummary(bot, chatId, userId, email) {
  const data    = session.get(userId).data;
  let product = db.getProduct(data.productId);
  // A negotiated price for this customer replaces the public one, so the
  // quoted price and the charged price can never diverge.
  product = db.productForCustomer(userId, product, data.quantity || 1);

  // 1) Cooldown check (skip for admin)
  if (!require('./admin').isAdmin(userId)) {
    const lastOrderAt = ORDER_COOLDOWN.get(userId) || 0;
    const since = Date.now() - lastOrderAt;
    if (since < COOLDOWN_MS) {
      const remaining = Math.ceil((COOLDOWN_MS - since) / 1000);
      await bot.sendMessage(chatId,
        `⏳ <b>Please wait ${remaining} seconds</b>\n\n` +
        `You can only create one order every ${COOLDOWN_MS / 1000} seconds.`,
        { parse_mode: 'HTML' });
      session.clear(userId);
      return;
    }
  }

  // 2) Quantity cap
  if (data.quantity > MAX_QTY_PER_ORDER) {
    await bot.sendMessage(chatId,
      `❌ Maximum ${MAX_QTY_PER_ORDER} items per order.\nYou requested ${data.quantity}. Please split into multiple orders.`,
      { parse_mode: 'HTML' });
    session.clear(userId);
    return;
  }

  // Stock and pending checks have been moved to confirmOrder (order created only when user actively confirms)

  // Store all data in session — order is NOT created until user confirms payment method
  session.set(userId, States.IDLE, session.get(userId).data);

  let summary =
    `🧾 <b>Order Summary</b>\n\n` +
    `📦 <b>Product:</b> ${data.productTitle}\n` +
    `🔢 <b>Quantity:</b> ${data.quantity}\n`;
  if (data.discountApplied) {
    summary += `💵 <b>Unit price:</b> ${formatPrice(data.unitPrice)} <i>(was ${formatPrice(data.productPrice)})</i>\n`;
    summary += `🎁 <b>Bulk Discount:</b> ${data.discount}% off\n`;
  }
  if (email) summary += `📧 <b>Email:</b> ${email}\n`;
  summary += `💵 <b>Total:</b> ${formatPrice(data.total)}\n\nConfirm your order:`;

  await bot.sendMessage(chatId, summary, {
    parse_mode: 'HTML', reply_markup: orderConfirmKb(),
  });
}

// ── Confirm order ─────────────────────────────────────────────────────────────

async function confirmOrder(bot, chatId, userId, messageId) {
  const sess = session.get(userId);
  if (!sess || !sess.data || !sess.data.productId) {
    await bot.editMessageText('❌ Session expired. Please start again.', {
      chat_id: chatId, message_id: messageId,
      reply_markup: { inline_keyboard: [[{ text: '🛍 Browse Products', callback_data: 'menu_products' }]] },
    });
    return;
  }

  const data    = sess.data;
  let product = db.getProduct(data.productId);
  // A negotiated price for this customer replaces the public one, so the
  // quoted price and the charged price can never diverge.
  product = db.productForCustomer(userId, product, data.quantity || 1);

  // Stock check (live) before creating order
  if (!product || (product.stock_quantity || 0) < data.quantity) {
    await bot.editMessageText('❌ Stock changed. Please start again.',
      { chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🛍 Browse Products', callback_data: 'menu_products' }]] } });
    session.clear(userId);
    return;
  }

  // Auto-cancel stale pending orders silently — never block the user
  try {
    dbRaw.prepare(
      `UPDATE orders SET status='cancelled' WHERE user_id=? AND status='pending' AND datetime(created_at) < datetime('now', '-30 minutes')`
    ).run(userId);
  } catch (e) { logger.warn(`confirmOrder auto-cancel: ${e.message}`); }

  // Cooldown check
  if (!require('./admin').isAdmin(userId)) {
    const lastOrderAt = ORDER_COOLDOWN.get(userId) || 0;
    const since = Date.now() - lastOrderAt;
    if (since < COOLDOWN_MS) {
      const remaining = Math.ceil((COOLDOWN_MS - since) / 1000);
      await bot.editMessageText(
        `⏳ <b>Please wait ${remaining} seconds before placing another order.</b>`,
        { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }
      );
      return;
    }
  }

  // Guard against a stale session. If the user taps "confirm" on an old
  // message after their session expired (or after a bot restart), data.quantity
  // is undefined and the INSERT dies with
  //   SqliteError: NOT NULL constraint failed: orders.quantity
  // which surfaced as an unhandled rejection in production.
  const qty = parseInt(data.quantity, 10);
  if (!data.productId || !Number.isFinite(qty) || qty < 1 || !Number.isFinite(Number(data.total))) {
    session.clear(userId);
    await bot.editMessageText(
      '⏳ <b>This order session has expired.</b>\n\nPlease start again from the product page.',
      { chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🛍 Browse Products', callback_data: 'menu_products' }]] } }
    ).catch(() => {});
    return;
  }

  // ✅ Create the order NOW (only when user actively confirms)
  ORDER_COOLDOWN.set(userId, Date.now());
  const userLang = db.getUserLanguage ? db.getUserLanguage(userId) : 'en';
  const orderId = db.createOrder({
    userId,
    productId:  data.productId,
    quantity:   qty,
    email:      data.email || null,
    totalPrice: data.total,
  });
  // Persist how many units the allowance covered. Payment may complete minutes
  // later, by which time the session could be gone.
  try {
    dbRaw.prepare('UPDATE orders SET allowance_units = ? WHERE id = ?')
      .run(Number(data.allowanceUnits) || 0, orderId);
  } catch (e) { logger.warn(`allowance_units not stored: ${e.message}`); }
  session.update(userId, { orderId });

  await bot.editMessageText(
    `${t(userLang, 'pay_select')}\n\nOrder #${orderId} — ${formatPrice(data.total)}`,
    { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: paymentMethodKb(orderId) }
  );
}

async function cancelOrder(bot, chatId, orderId, userId, messageId) {
  // orderId may be 0 if user cancels before confirming (no DB order was created)
  if (orderId && orderId > 0) {
    db.updateOrderStatus(orderId, 'cancelled');
  }
  session.clear(userId);
  await bot.editMessageText('❌ <b>Order cancelled.</b>', {
    chat_id: chatId, message_id: messageId,
    parse_mode: 'HTML', reply_markup: backKb('back_main'),
  });
}

// ── Pay with wallet ───────────────────────────────────────────────────────────

// In-memory set to prevent concurrent payment processing per order
const PROCESSING_ORDERS = new Set();

async function payWithWallet(bot, chatId, userId, orderId, messageId) {
  // ATOMIC LOCK: prevent double-click race condition
  if (PROCESSING_ORDERS.has(orderId)) {
    await bot.answerCallbackQuery && bot.answerCallbackQuery(messageId, { text: '⏳ Processing... please wait', show_alert: false }).catch(() => {});
    return;
  }
  PROCESSING_ORDERS.add(orderId);

  try {
    const order = db.getOrder(orderId);
    const user  = db.getUser(userId);

    if (!order || order.status !== 'pending') {
      await bot.editMessageText('❌ Order not found or already processed.', { chat_id: chatId, message_id: messageId }).catch(() => {});
      return;
    }

  // Stock check + balance check are both INSIDE the atomic transaction (deliverOrderAndChargeWallet)
  // Capture stock BEFORE to detect low/out-of-stock crossings for notifications
  const stockBefore = db.getProduct(order.product_id)?.stock_quantity || 0;

  // ── MANUAL DELIVERY BRANCH ────────────────────────────────────────────────
  // Products marked delivery_type='manual' have nothing to hand out
  // automatically. Charge the wallet atomically, move the order to
  // 'awaiting_delivery', then open a task for the admin. The manual task is
  // only ever created AFTER the charge succeeds, so an unpaid order can never
  // produce a delivery request.
  const _mdProduct = db.getProduct(order.product_id);
  if (_mdProduct && _mdProduct.delivery_type === 'manual') {
    const manualResult = db.chargeWalletForManualOrder(
      order.id, order.product_id, order.quantity, userId, order.total_price
    );

    if (manualResult.result === 'already_processed') {
      await bot.editMessageText('❌ This order has already been processed.',
        { chat_id: chatId, message_id: messageId }).catch(() => {});
      return;
    }
    if (manualResult.result === 'insufficient_balance') {
      await bot.editMessageText(
        `❌ <b>Insufficient balance!</b>\n\n` +
        `💰 Balance: <b>${formatPrice(manualResult.balance)}</b>\n` +
        `💵 Required: <b>${formatPrice(order.total_price)}</b>\n\nPlease top up your wallet first.`,
        { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: backKb('menu_wallet') }
      ).catch(() => {});
      return;
    }

    db.addTransaction({
      userId, type: 'purchase', amount: -order.total_price,
      description: `Order #${orderId}: ${order.product_title}`,
      refId: null, orderId,
    });

    const freshOrder = db.getOrder(orderId);
    await manualDelivery.openManualDelivery(bot, freshOrder, 'wallet');
    const _paidOrder = db.getOrder(orderId) || order;
    consumeAllowanceFor(_paidOrder, _paidOrder?.allowance_units);
  await handleReferralReward(bot, userId);

    await bot.editMessageText(
      `✅ <b>Payment Confirmed</b>\n\n` +
      `🆔 Order #${orderId} — ${formatPrice(order.total_price)}\n\n` +
      `🖐 This product is delivered manually. Our team has been notified ` +
      `and will send it to you here shortly.`,
      { chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '📦 My Orders', callback_data: 'menu_orders' }]] } }
    ).catch(() => {});

    const stockAfterM = db.getProduct(order.product_id)?.stock_quantity || 0;
    await checkAndNotifyStockLevel(bot, db, order.product_id, stockBefore, stockAfterM);
    await evaluateStock(bot, order.product_id);
    return;
  }

  // ── ATOMIC: deliver + deduct balance in ONE SQLite transaction ──
  const walletResult = db.deliverOrderAndChargeWallet(
    order.id, order.product_id, order.quantity, userId, order.total_price
  );

  if (walletResult && walletResult.result === 'already_processed') {
    await bot.editMessageText('❌ This order has already been processed.', { chat_id: chatId, message_id: messageId }).catch(() => {});
    return;
  }
  if (walletResult && walletResult.result === 'insufficient_balance') {
    await bot.editMessageText(
      `❌ <b>Insufficient balance!</b>\n\n` +
      `💰 Balance: <b>${formatPrice(walletResult.balance)}</b>\n` +
      `💵 Required: <b>${formatPrice(order.total_price)}</b>\n\nPlease top up your wallet first.`,
      { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: backKb('menu_wallet') }
    ).catch(() => {});
    return;
  }

  // ── Handle out_of_stock from atomic transaction ──
  if (walletResult && walletResult.result === 'out_of_stock') {
    const userLang = db.getUserLanguage ? db.getUserLanguage(userId) : 'en';
    // Cancel the pending order immediately
    try { dbRaw.prepare(`UPDATE orders SET status='cancelled' WHERE id=?`).run(orderId); } catch (e) {}
    await bot.editMessageText(
      t(userLang, 'pay_out_of_stock'),
      { chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🛍 Browse Products', callback_data: 'menu_products' }]] } }
    ).catch(() => {});
    return;
  }

  const delivered = walletResult && walletResult.result === 'ok' ? walletResult.content : null;
  if (delivered) {
    db.addTransaction({
      userId, type: 'purchase', amount: -order.total_price,
      description: `Order #${orderId}: ${order.product_title}`,
      refId: null, orderId,
    });
    await sendDelivery(bot, chatId, order, delivered, messageId);
    const _paidOrder = db.getOrder(orderId) || order;
    consumeAllowanceFor(_paidOrder, _paidOrder?.allowance_units);
  await handleReferralReward(bot, userId);

    // Notify admins of the successful purchase
    const buyer       = db.getUser(userId);
    const buyerName   = buyer?.username ? `@${buyer.username}` : (buyer?.first_name || `User ${userId}`);
    const updatedUser = db.getUser(userId);
    const newBalance  = updatedUser?.balance || 0;

    let adminMsg =
      `🛒 <b>New Order Paid</b>\n\n` +
      `🆔 <b>Order:</b> #${order.id}\n` +
      `📦 <b>Product:</b> ${order.product_title}\n` +
      `🔢 <b>Quantity:</b> ${order.quantity}\n` +
      `💵 <b>Total:</b> ${formatPrice(order.total_price)}\n` +
      `💳 <b>Payment:</b> Wallet\n\n` +
      `👤 <b>Customer:</b> ${buyerName}\n` +
      `🆔 <b>User ID:</b> <code>${userId}</code>\n`;
    if (order.email) {
      adminMsg += `📧 <b>Delivery Email:</b> <code>${order.email}</code>\n`;
    }
    adminMsg += `💰 <b>Remaining Balance:</b> ${formatPrice(newBalance)}`;

    for (const adminId of config.adminIds) {
      bot.sendMessage(adminId, adminMsg, { parse_mode: 'HTML' }).catch(() => {});
    }

    // Auto-fire low-stock / out-of-stock notifications to channel + group
    const updated    = db.getProduct(order.product_id);
    const stockAfter = updated?.stock_quantity || 0;
    await checkAndNotifyStockLevel(bot, db, order.product_id, stockBefore, stockAfter);
    await evaluateStock(bot, order.product_id);

    if (stockAfter === 0) {
      logger.info(`Product #${order.product_id} stock reached 0 after order #${orderId}`);
      // Auto-cancel ALL other pending orders for this product and notify customers
      setImmediate(async () => {
        try {
          const stuckOrders = dbRaw.prepare(`
            SELECT o.*, u.username, u.first_name
            FROM orders o
            LEFT JOIN users u ON u.telegram_id = o.user_id
            WHERE o.product_id = ? AND o.status = 'pending' AND o.id != ?
          `).all(order.product_id, orderId);

          for (const stuck of stuckOrders) {
            dbRaw.prepare(`UPDATE orders SET status='cancelled' WHERE id=?`).run(stuck.id);
            try {
              await bot.sendMessage(stuck.user_id,
                `❌ <b>Order #${stuck.id} Cancelled — Out of Stock</b>

` +
                `Sorry, <b>${escapeHtml(order.product_title || 'this product')}</b> just sold out.
` +
                `No payment was taken from your wallet.

` +
                `Check back later or choose another product.`,
                { parse_mode: 'HTML',
                  reply_markup: { inline_keyboard: [[{ text: '🛍 Browse Products', callback_data: 'menu_products' }]] } }
              );
            } catch (e) { logger.warn(`Could not notify user ${stuck.user_id} of cancellation`); }
          }
          if (stuckOrders.length > 0) {
            logger.info(`Auto-cancelled ${stuckOrders.length} stuck pending orders for product #${order.product_id}`);
          }
        } catch (e) { logger.error(`Auto-cancel stuck orders failed: ${e.message}`); }
      });
    }
  } else {
    await sendOutOfStock(bot, chatId, order, 'wallet', messageId);
  }
  } catch (e) {
    logger.error(`payWithWallet error: ${e.message}`);
    try { await bot.sendMessage(chatId, '❌ Payment processing error. Please try again.'); } catch (e2) {}
  } finally {
    PROCESSING_ORDERS.delete(orderId);
  }
}

// ── Pay with Binance Pay (Order ID) ──────────────────────────────────────────

async function startBinancePayForOrder(bot, chatId, userId, orderId, messageId) {
  const order = db.getOrder(orderId);
  if (!order || order.user_id !== userId || order.status !== 'pending') {
    await bot.editMessageText('❌ Order not found or already processed.', {
      chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
    });
    return;
  }
  // Quick stock check — real guard is inside settleDirectPayment
  const _quickStock = require('../database/items').getAvailableCount(order.product_id);
  const _quickQty   = _quickStock > 0 ? _quickStock : (db.getProduct(order.product_id)?.stock_quantity || 0);
  if (_quickQty < order.quantity) {
    dbRaw.prepare(`UPDATE orders SET status='cancelled' WHERE id=?`).run(orderId);
    await bot.editMessageText(
      `❌ <b>Out of Stock</b>\n\nThis product is no longer available.\n<i>No payment was taken.</i>`,
      { chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🛍 Browse Products', callback_data: 'menu_products' }]] } }
    ).catch(() => {});
    return;
  }

  session.set(userId, States.BUY_BINANCE_ORDER_ID, { orderId });

  const binanceId = config.binanceId || '—';

  await bot.editMessageText(
    `🟡 <b>Pay with Binance Pay</b>\n\n` +
    `📦 Order: <b>#${order.id}</b>\n` +
    `💵 Amount due: <b>${formatPrice(order.total_price)}</b>\n\n` +
    `🔹 <b>Binance ID:</b> <code>${binanceId}</code>\n\n` +
    `📌 <b>Steps:</b>\n` +
    `1. Open Binance app → Pay → Send\n` +
    `2. Enter the Binance ID above\n` +
    `3. Send exactly <b>${formatPrice(order.total_price)} USDT</b>\n` +
    `4. Copy the <b>Order ID</b> and send it here\n\n` +
    `💡 If something goes wrong (wrong amount / out of stock), funds are added to your wallet automatically.\n\n` +
    `<i>Example Order ID:</i>\n<code>402117599683977216</code>\n\n` +
    `⏰ Valid for ${PAYMENT_CONFIRM_VALIDITY_MIN} minutes. Order ID can only be used once.`,
    {
      chat_id: chatId, message_id: messageId,
      parse_mode: 'HTML', reply_markup: cancelKb(`cancel_order_${order.id}`),
    }
  );
}

async function handleBinanceOrderId(bot, msg) {
  const userId  = msg.from.id;
  const chatId  = msg.chat.id;
  const orderId = (msg.text || '').trim();
  const sess    = session.get(userId);
  const internalOrderId = sess.data && sess.data.orderId;

  if (!internalOrderId) {
    await bot.sendMessage(chatId, '❌ Session expired. Please start the order again.');
    return;
  }
  if (db.isTxidUsed(orderId)) {
    await bot.sendMessage(chatId, '❌ This Order ID has already been used.', { parse_mode: 'HTML' });
    return;
  }

  // ── PAYMENT WINDOW EXPIRY CHECK (shared 20-minute window) ──
  const _binOrder = db.getOrder(internalOrderId);
  if (_binOrder) {
    const orderStartedAt = new Date(_binOrder.created_at + 'Z').getTime();
    const { expired } = checkPaymentWindow(orderStartedAt);
    if (expired) {
      try { dbRaw.prepare(`UPDATE orders SET status='cancelled' WHERE id=?`).run(internalOrderId); } catch (e) {}
      session.clear(userId);
      await bot.sendMessage(chatId,
        `⏰ <b>Order Expired</b>\n\nThis order is older than ${PAYMENT_CONFIRM_VALIDITY_MIN} minutes and is no longer valid.\nPlease create a new order.`,
        { parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: '🛍 Browse Products', callback_data: 'menu_products' }]] } });
      return;
    }
  }

  const wait = await bot.sendMessage(chatId,
    '⏳ <b>Processing your payment...</b>\n\n' +
    'We are verifying your Binance Pay transaction.\n' +
    'This may take 10-30 seconds.\n\n' +
    '<i>Please wait, do not send another message.</i>',
    { parse_mode: 'HTML' });
  const result = await verifyBinancePayOrder(orderId);
  await bot.deleteMessage(chatId, wait.message_id).catch(() => {});

  if (!result.found) {
    await bot.sendMessage(chatId, result.message, { parse_mode: 'HTML' });
    return;
  }
  if (String(result.currency).toUpperCase() !== 'USDT') {
    await bot.sendMessage(chatId, `❌ Only USDT is accepted. Got ${result.currency}.`, { parse_mode: 'HTML' });
    return;
  }

  await settleDirectPayment(bot, chatId, userId, {
    internalOrderId,
    identifier: orderId,
    paidAmount: result.amount,
    network: 'BinancePay',
    method:  'Binance Pay',
  });
}

// ── Pay with USDT (TxID) ─────────────────────────────────────────────────────

async function startUsdtPayForOrder(bot, chatId, userId, orderId, messageId) {
  const order = db.getOrder(orderId);
  if (!order || order.user_id !== userId || order.status !== 'pending') {
    await bot.editMessageText('❌ Order not found or already processed.', {
      chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
    });
    return;
  }
  const _quickStock2 = require('../database/items').getAvailableCount(order.product_id);
  const _quickQty2   = _quickStock2 > 0 ? _quickStock2 : (db.getProduct(order.product_id)?.stock_quantity || 0);
  if (_quickQty2 < order.quantity) {
    dbRaw.prepare(`UPDATE orders SET status='cancelled' WHERE id=?`).run(orderId);
    await bot.editMessageText(
      `❌ <b>Out of Stock</b>\n\nThis product is no longer available.\n<i>No payment was taken.</i>`,
      { chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🛍 Browse Products', callback_data: 'menu_products' }]] } }
    ).catch(() => {});
    return;
  }

  session.set(userId, States.BUY_USDT_TXID, { orderId });

  const trc20 = config.usdtTrc20Address || '—';
  const bep20 = config.usdtBep20Address || '—';

  await bot.editMessageText(
    `💎 <b>Pay with USDT</b>\n\n` +
    `📦 Order: <b>#${order.id}</b>\n` +
    `💵 Amount due: <b>${formatPrice(order.total_price)}</b>\n\n` +
    `🔹 <b>TRC20 (USDT):</b> <code>${trc20}</code>\n` +
    `🔹 <b>BEP20 (USDT):</b> <code>${bep20}</code>\n\n` +
    `📌 Send <b>exactly ${formatPrice(order.total_price)}</b> to one of the addresses above, then send the bot the <b>TxID</b> (transaction hash).\n\n` +
    `⚠️ <b>Important:</b>\n` +
    `• TRC20 → send via TRON network\n` +
    `• BEP20 → send via BNB Smart Chain\n\n` +
    `💡 If something goes wrong (wrong amount / out of stock), funds are added to your wallet automatically.\n\n` +
    `<i>Example TxID:</i>\n<code>0x1234...abcd</code> (64 chars)\n\n` +
    `⏰ Valid for ${PAYMENT_CONFIRM_VALIDITY_MIN} minutes. TxID can only be used once.`,
    {
      chat_id: chatId, message_id: messageId,
      parse_mode: 'HTML', reply_markup: cancelKb(`cancel_order_${order.id}`),
    }
  );
}

async function handleUsdtTxIdForOrder(bot, msg) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const txid   = (msg.text || '').trim();
  const sess   = session.get(userId);
  const internalOrderId = sess.data && sess.data.orderId;

  if (!internalOrderId) {
    await bot.sendMessage(chatId, '❌ Session expired. Please start the order again.');
    return;
  }
  if (!TXID_RE.test(txid)) {
    await bot.sendMessage(chatId, '❌ Invalid TxID format.', { parse_mode: 'HTML' });
    return;
  }
  if (db.isTxidUsed(txid)) {
    await bot.sendMessage(chatId, '❌ This TxID has already been used.', { parse_mode: 'HTML' });
    return;
  }

  // ── PAYMENT WINDOW EXPIRY CHECK (shared 20-minute window) ──
  const _usdtOrder = db.getOrder(internalOrderId);
  if (_usdtOrder) {
    const orderStartedAt = new Date(_usdtOrder.created_at + 'Z').getTime();
    const { expired } = checkPaymentWindow(orderStartedAt);
    if (expired) {
      try { dbRaw.prepare(`UPDATE orders SET status='cancelled' WHERE id=?`).run(internalOrderId); } catch (e) {}
      session.clear(userId);
      await bot.sendMessage(chatId,
        `⏰ <b>Order Expired</b>\n\nThis order is older than ${PAYMENT_CONFIRM_VALIDITY_MIN} minutes and is no longer valid.\nPlease create a new order.`,
        { parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: '🛍 Browse Products', callback_data: 'menu_products' }]] } });
      return;
    }
  }

  const wait = await bot.sendMessage(chatId,
    '⏳ <b>Processing your payment...</b>\n\n' +
    'We are verifying your USDT transaction on the blockchain.\n' +
    'This may take 30-60 seconds.\n\n' +
    '<i>Please wait, do not send another message.</i>',
    { parse_mode: 'HTML' });
  const result = await verifyDepositByTxId(txid);
  await bot.deleteMessage(chatId, wait.message_id).catch(() => {});

  if (!result.found) {
    await bot.sendMessage(chatId, result.message, { parse_mode: 'HTML' });
    return;
  }

  await settleDirectPayment(bot, chatId, userId, {
    internalOrderId,
    identifier: txid,
    paidAmount: result.amount,
    network: result.network,
    method:  `USDT ${result.network}`,
  });
}

/**
 * Smart settlement for direct crypto payment on an order.
 *
 * Handles all 4 scenarios atomically:
 *   1. Exact amount + stock available  → deliver product
 *   2. Stock ran out                   → NO delivery, contact support
 *   3. Overpaid + stock available      → deliver product (surplus NOT auto-credited)
 *   4. Underpaid                       → NO delivery, contact support
 *
 * For stock-out or underpayment: user must contact support with TxID.
 */
async function settleDirectPayment(bot, chatId, userId, info) {
  // ATOMIC LOCK: prevent double-settle of same order
  const { internalOrderId, identifier, paidAmount, network, method } = info;
  const lockId = internalOrderId || (info && info.orderId);
  if (lockId) {
    if (PROCESSING_ORDERS.has(lockId)) {
      logger.warn(`settleDirectPayment: order #${lockId} already processing, skip`);
      return;
    }
    PROCESSING_ORDERS.add(lockId);
  }
  try {
  const order = db.getOrder(internalOrderId);
  if (!order) {
    await bot.sendMessage(chatId, '❌ Order not found.');
    return;
  }

  // Lock the payment ID first to prevent double-spend
  let savedId;
  try {
    savedId = db.saveUsedTxid({
      txid: identifier, userId,
      amount: Number(paidAmount.toFixed(6)),
      network, asset: 'USDT', address: null,
    });
  } catch (e) {
    await bot.sendMessage(chatId, '❌ This payment ID has already been used.', { parse_mode: 'HTML' });
    return;
  }

  const paid     = Number(paidAmount.toFixed(6));
  const required = Number(Number(order.total_price).toFixed(6));
  const epsilon  = 0.001; // allow tiny rounding diff

  // Scenario 4: UNDERPAYMENT — NO wallet credit, contact support
  if (paid + epsilon < required) {
    session.clear(userId);

    await bot.sendMessage(
      chatId,
      `⚠️ <b>Underpayment Received</b>\n\n` +
      `📦 Order: <b>#${order.id}</b>\n` +
      `💵 Required: <b>${formatPrice(required)}</b>\n` +
      `💵 Received: <b>${formatPrice(paid)}</b>\n` +
      `❌ Difference: <b>${formatPrice(required - paid)}</b>\n\n` +
      `❌ <b>Order not delivered.</b>\n` +
      `Please contact support with TxID: <code>${identifier}</code>`,
      { parse_mode: 'HTML' }
    );
    await notifyAdminsDirect(bot, userId, order, paid, method, identifier, 'underpaid', 0);
    return;
  }

  // Try to deliver (atomic — stock is checked + decremented in one transaction)
  const stockBefore = db.getProduct(order.product_id)?.stock_quantity || 0;

  // ── MANUAL DELIVERY BRANCH (external payment already verified above) ──────
  const _mdProd = db.getProduct(order.product_id);
  if (_mdProd && _mdProd.delivery_type === 'manual') {
    const settled = db.settleManualOrderExternal(
      order.id, order.product_id, order.quantity, method
    );
    if (settled.result === 'already_processed') {
      await bot.sendMessage(chatId, '❌ This order has already been processed.');
      return;
    }

    db.addTransaction({
      userId, type: 'purchase', amount: -required,
      description: `Order #${order.id}: ${order.product_title}`,
      refId: identifier, orderId: order.id,
    });

    session.clear(userId);
    const freshManualOrder = db.getOrder(order.id);
    await manualDelivery.openManualDelivery(bot, freshManualOrder, method);
    const _paidOrder = db.getOrder(orderId) || order;
    consumeAllowanceFor(_paidOrder, _paidOrder?.allowance_units);
  await handleReferralReward(bot, userId);

    const stockAfterMd = db.getProduct(order.product_id)?.stock_quantity || 0;
    await checkAndNotifyStockLevel(bot, db, order.product_id, stockBefore, stockAfterMd);
    await evaluateStock(bot, order.product_id);

    const freshUser = db.getUser(userId);
    await notifyAdminsDirect(bot, userId, order, paid, method, identifier,
      'exact', freshUser?.balance || 0);
    return;
  }

  const delivered   = db.deliverOrder(order.id, order.product_id, order.quantity, method, userId);

  if (!delivered) {
    // Scenario 2: OUT OF STOCK — mark cancelled, user already paid externally → contact support
    try { dbRaw.prepare(`UPDATE orders SET status='cancelled' WHERE id=?`).run(order.id); } catch (e) {}
    session.clear(userId);
    await bot.sendMessage(
      chatId,
      `❌ <b>Out of Stock</b>\n\n` +
      `Sorry — the product ran out while processing your payment.\n\n` +
      `📦 Order: <b>#${order.id}</b>\n` +
      `💵 Paid: <b>${formatPrice(paid)}</b>\n\n` +
      `⚠️ Please contact support with TxID: <code>${identifier}</code> to get a refund.`,
      { parse_mode: 'HTML' }
    );
    await notifyAdminsDirect(bot, userId, order, paid, method, identifier, 'out_of_stock', 0);
    return;
  }

  // Delivery succeeded — overpayment is NOT credited to wallet anymore
  const surplus = paid - required;
  if (surplus > epsilon) {
    logger.info(`Overpayment ${surplus} on order #${order.id} (NOT credited to wallet)`);
    // Notify admin so they can decide manually
  }

  // Record the purchase transaction
  db.addTransaction({
    userId, type: 'purchase', amount: -required,
    description: `Order #${order.id}: ${order.product_title}`,
    refId: identifier, orderId: order.id,
  });

  session.clear(userId);
  await sendDelivery(bot, chatId, order, delivered);
  consumeAllowanceFor(order, order?.allowance_units);
  await handleReferralReward(bot, userId);

  if (surplus > epsilon) {
    await bot.sendMessage(
      chatId,
      `💡 <b>Overpayment Notice</b>\n\n` +
      `You sent <b>${formatPrice(paid)}</b> for an order of <b>${formatPrice(required)}</b>.\n` +
      `⚠️ The extra <b>${formatPrice(surplus)}</b> has NOT been credited automatically.\n` +
      `Please contact support if you want a refund of the extra amount.`,
      { parse_mode: 'HTML' }
    );
  }

  // Stock-level notifications
  const stockAfter = db.getProduct(order.product_id)?.stock_quantity || 0;
  await checkAndNotifyStockLevel(bot, db, order.product_id, stockBefore, stockAfter);
  await evaluateStock(bot, order.product_id);

  // Admin notification
  const fresh = db.getUser(userId);
  await notifyAdminsDirect(bot, userId, order, paid, method, identifier,
    surplus > epsilon ? 'overpaid' : 'exact', fresh?.balance || 0);
  } finally {
    if (lockId) PROCESSING_ORDERS.delete(lockId);
  }
}

async function notifyAdminsDirect(bot, userId, order, paid, method, identifier, outcome, newBalance) {
  const buyer     = db.getUser(userId);
  const buyerName = buyer?.username ? `@${buyer.username}` : (buyer?.first_name || `User ${userId}`);

  const outcomeEmoji = {
    exact:        '✅ Delivered',
    overpaid:     '✅ Delivered + 💰 Surplus → Wallet',
    out_of_stock: '⚠️ Out of stock → Contact support (NO auto-refund)',
    underpaid:    '⚠️ Underpaid → Contact support (NO auto-refund)',
  }[outcome] || outcome;

  let msg =
    `🛒 <b>New Order Paid</b>\n\n` +
    `🆔 <b>Order:</b> #${order.id}\n` +
    `📦 <b>Product:</b> ${order.product_title}\n` +
    `🔢 <b>Quantity:</b> ${order.quantity}\n` +
    `💵 <b>Required:</b> ${formatPrice(order.total_price)}\n` +
    `💵 <b>Received:</b> ${formatPrice(paid)}\n` +
    `💳 <b>Method:</b> ${method}\n` +
    `📊 <b>Outcome:</b> ${outcomeEmoji}\n\n` +
    `👤 <b>Customer:</b> ${buyerName}\n` +
    `🆔 <b>User ID:</b> <code>${userId}</code>\n`;
  if (order.email) msg += `📧 <b>Delivery Email:</b> <code>${order.email}</code>\n`;
  msg += `🧾 <b>Payment ID:</b> <code>${identifier}</code>\n`;
  msg += `💰 <b>New Balance:</b> ${formatPrice(newBalance)}`;

  for (const adminId of config.adminIds) {
    bot.sendMessage(adminId, msg, { parse_mode: 'HTML' }).catch(() => {});
  }
}



async function sendDelivery(bot, chatId, order, content, messageId = null) {
  // Get user language for translations
  const userLang = db.getUserLanguage ? db.getUserLanguage(order.user_id || chatId) : 'en';

  // Build purchase date (DD/MM/YYYY HH:MM:SS)
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const purchaseDate =
    pad(now.getDate()) + '/' + pad(now.getMonth() + 1) + '/' + now.getFullYear() +
    ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds());

  // Fetch product instruction
  const product = db.getProduct(order.product_id);
  let instructionBlock = '';
  if (product && product.instruction && product.instruction.trim()) {
    instructionBlock =
      '\n━━━━━━━━━━━━━━━━━━━━\n' +
      '📌 <b>Instructions:</b>\n' +
      product.instruction + '\n';
  }

  // If product content is large (>500 chars OR >5 lines), send as file
  const contentStr = String(content || '');
  const lineCount = (contentStr.match(/\n/g) || []).length;
  const sendAsFile = contentStr.length > 500 || lineCount >= 5;

  let text;
  if (sendAsFile) {
    text =
      `${t(userLang, 'payment_confirmed')}\n\n` +
      `📦 <b>${t(userLang, 'delivery_order')} #${order.id}</b>\n` +
      `🛒 ${order.product_title}\n` +
      `🔢 ${t(userLang, 'delivery_qty')}: ${order.quantity}\n` +
      (order.email ? `📧 ${order.email}\n` : '') +
      `💵 ${formatPrice(order.total_price)}\n` +
      `📅 <b>${t(userLang, 'purchase_date')}:</b> ${purchaseDate}\n\n` +
      `📎 <b>${order.quantity} item(s) attached below.</b>` +
      instructionBlock +
      `\n\n${t(userLang, 'delivery_footer')}`;
  } else {
    text =
      `${t(userLang, 'payment_confirmed')}\n\n` +
      `📦 <b>${t(userLang, 'delivery_order')} #${order.id}</b>\n` +
      `🛒 ${order.product_title}\n` +
      (order.email ? `📧 ${order.email}\n` : '') +
      `💵 ${formatPrice(order.total_price)}\n` +
      `📅 <b>${t(userLang, 'purchase_date')}:</b> ${purchaseDate}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `${t(userLang, 'delivery_content')}\n\n` +
      `${contentStr}\n` +
      `━━━━━━━━━━━━━━━━━━━━` +
      instructionBlock +
      `\n${t(userLang, 'delivery_footer')}`;
  }

  // Try to edit the existing message first, fall back to sending a new one
  let deliveryDelivered = false;
  if (messageId) {
    try {
      await bot.editMessageText(text, {
        chat_id: chatId, message_id: messageId,
        parse_mode: 'HTML', reply_markup: mainMenuKb(),
      });
      deliveryDelivered = true;
    } catch (e) {
      logger.warn(`sendDelivery: edit failed for order #${order.id}, will send new message: ${e.message}`);
    }
  }
  // If edit failed OR no messageId, send a new message
  if (!deliveryDelivered) {
    try {
      await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: mainMenuKb() });
      deliveryDelivered = true;
    } catch (e) {
      logger.error(`sendDelivery: sendMessage FAILED for order #${order.id} user ${chatId}: ${e.message}`);
      // Notify admin that delivery message failed (but order was delivered in DB)
      for (const adminId of config.adminIds) {
        bot.sendMessage(
          adminId,
          `⚠️ <b>Delivery message FAILED to reach user</b>\n\n` +
          `Order #${order.id} — ${order.product_title}\n` +
          `User: <code>${chatId}</code>\n` +
          `Error: ${e.message}\n\n` +
          `Items are saved in DB. User may need to check My Orders.`,
          { parse_mode: 'HTML' }
        ).catch(() => {});
      }
    }
  }

  // Send content as file if it's large
  if (sendAsFile && deliveryDelivered) {
    try {
      const buffer = Buffer.from(contentStr, 'utf-8');
      const safeName = (order.product_title || 'product')
        .replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 30);
      const filename = `order_${order.id}_${safeName}.txt`;
      await bot.sendDocument(chatId, buffer, {
        caption: `📎 Order #${order.id} — ${order.quantity} item(s)`,
      }, { filename, contentType: 'text/plain' });
    } catch (e) {
      logger.error(`Failed to send order #${order.id} as file: ${e.message}`);
      // Fall back: send the content in a message (split if needed)
      try {
        const chunks = contentStr.match(/[\s\S]{1,3500}/g) || [];
        for (const chunk of chunks) {
          await bot.sendMessage(chatId, `<pre>${chunk.replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))}</pre>`, { parse_mode: 'HTML' });
        }
      } catch (e2) {
        logger.error(`Failed to send fallback chunks for order #${order.id}: ${e2.message}`);
      }
    }
  }

  for (const adminId of config.adminIds) {
    bot.sendMessage(
      adminId,
      `🛒 <b>Order Delivered</b> #${order.id}\n${order.product_title} ×${order.quantity} | ${formatPrice(order.total_price)}\n📅 ${purchaseDate}`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
  }

  // ── Pay 2% cashback to referrer (if enabled) ───────────────────
  try {
    const cashbackResult = db.payCashbackReferral(order.user_id, order.total_price, order.id);

  // ── VIP unlock check: did this purchase qualify the referrer for VIP? ──
  try {
    // NOTE: this block used to call db.prepare() (which does not exist on the
    // queries module) and referenced an undefined `userId`, so it silently
    // threw on every delivery and VIP was never unlocked. Both are fixed here.
    const buyerId = order.user_id;
    const referrerRow = dbRaw
      .prepare('SELECT referrer_id FROM referrals WHERE referred_id = ?')
      .get(buyerId);
    if (referrerRow && referrerRow.referrer_id) {
      const refId = referrerRow.referrer_id;
      const isVipAlready = db.isVIP(refId);
      const refCount = db.countReferrals(refId);
      const vipSystemOpen = db.getSetting('vip_system_enabled', '1') === '1';
      const VIP_LIMIT = parseInt(db.getSetting('vip_limit', '1000'), 10);
      const totalVips = db.countVIPs();
      if (!isVipAlready && refCount >= 3 && vipSystemOpen && (VIP_LIMIT - totalVips) > 0) {
        // Unlock VIP for the referrer
        db.unlockVIP(refId);
        try {
          await bot.sendMessage(refId,
            `👑 <b>CONGRATULATIONS! You unlocked VIP for LIFE!</b>\n\n` +
            `🎉 One of your invited friends just made a purchase!\n\n` +
            `🎁 Your VIP benefits are now ACTIVE:\n` +
            `💸 5% discount on every purchase forever\n` +
            `🚀 Early access to new products\n` +
            `⚡️ Priority support`,
            { parse_mode: 'HTML' });
        } catch (e) {}
      }
    }
  } catch (e) {}

    if (cashbackResult) {
      bot.sendMessage(
        cashbackResult.referrerId,
        `🎁 <b>Referral Cashback!</b>\n\n` +
        `Your referral just made a purchase!\n` +
        `💰 You earned: <b>${formatPrice(cashbackResult.cashback)}</b> (${cashbackResult.pct}%)\n` +
        `Added to your wallet automatically.`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
    }
  } catch (e) {}
}

// ── Pay with CryptoBot (direct order payment) ─────────────────────────────────

async function startCryptobotPayForOrder(bot, chatId, userId, orderId, messageId) {
  if (!config.cryptobotToken) {
    await bot.sendMessage(
      chatId,
      '❌ <b>CryptoBot is not configured.</b>\n\nPlease use another payment method.',
      { parse_mode: 'HTML' }
    );
    return;
  }

  const order = db.getOrder(orderId);
  if (!order || order.user_id !== userId) {
    await bot.sendMessage(chatId, '❌ Order not found.');
    return;
  }

  // Quick stock check before creating CryptoBot invoice
  const _qsC = require('../database/items').getAvailableCount(order.product_id);
  const _qqC = _qsC > 0 ? _qsC : (db.getProduct(order.product_id)?.stock_quantity || 0);
  if (_qqC < order.quantity) {
    dbRaw.prepare(`UPDATE orders SET status='cancelled' WHERE id=?`).run(orderId);
    await bot.sendMessage(chatId,
      `❌ <b>Out of Stock</b>\n\nThis product is no longer available.\n<i>No payment was taken.</i>`,
      { parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🛍 Browse Products', callback_data: 'menu_products' }]] } });
    return;
  }

  if (order.status !== 'pending') {
    await bot.sendMessage(chatId, '❌ This order is no longer pending.');
    return;
  }

  const CRYPTOBOT_FEE = 0.01; // Fixed fee added to cover CryptoBot network fee
  const orderAmount   = Number(order.total_price.toFixed(2));
  const amount        = Number((orderAmount + CRYPTOBOT_FEE).toFixed(2)); // Zبون يدفع السعر + fee
  let invoice;
  try {
    invoice = await cryptobot.createInvoice({
      amount,
      asset:       'USDT',
      payload:     `order:${orderId}:${userId}`,
      description: `Order #${orderId} — ${order.product_title}`,
    });
  } catch (e) {
    await bot.sendMessage(chatId, '❌ Could not create CryptoBot invoice. Try again later.', { parse_mode: 'HTML' });
    return;
  }

  try {
    db.saveCryptobotInvoice({
      invoiceId: invoice.invoice_id,
      userId,
      asset:     'USDT',
      amount:    orderAmount, // نحفظ السعر الأصلي بدون الـ fee في DB
      payUrl:    invoice.bot_invoice_url || invoice.pay_url,
    });
  } catch (e) {}

  const payUrl = invoice.bot_invoice_url || invoice.mini_app_invoice_url || invoice.pay_url;
  await bot.sendMessage(
    chatId,
    `🤖 <b>Pay with CryptoBot</b>\n\n` +
    `📦 Order #${orderId} — ${order.product_title}\n` +
    `💵 Amount: <b>${amount} USDT</b> <i>(includes $${CRYPTOBOT_FEE} network fee)</i>\n` +
    `🆔 Invoice: <code>${invoice.invoice_id}</code>\n` +
    `⏰ Expires in 1 hour\n\n` +
    `👇 Tap <b>Pay Now</b> to pay via @CryptoBot.\n` +
    `Your order will be delivered automatically after payment.`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🤖 Pay Now via CryptoBot', url: payUrl }],
          [{ text: '🔙 Back', callback_data: `confirm_order_${orderId}` }],
        ],
      },
    }
  );
}

async function deliverCryptobotOrder(bot, invoiceId, paidAmount, payloadStr) {
  const m = String(payloadStr || '').match(/^order:(\d+):(\d+)$/);
  if (!m) return false;
  const orderId = parseInt(m[1], 10);
  const userId  = parseInt(m[2], 10);

  const order = db.getOrder(orderId);
  if (!order) return false;
  if (order.status !== 'pending') return false;

  // ── MANUAL DELIVERY BRANCH ───────────────────────────────────────────────
  const mdProduct = db.getProduct(order.product_id);
  if (mdProduct && mdProduct.delivery_type === 'manual') {
    const settled = db.settleManualOrderExternal(orderId, order.product_id, order.quantity, 'cryptobot');
    if (settled.result !== 'ok') return true; // webhook retry — already handled

    db.addTransaction({
      userId, type: 'purchase', amount: -order.total_price,
      description: `Order #${orderId}: ${order.product_title}`,
      refId: `cryptobot:${invoiceId}`, orderId,
    });

    const freshManual = db.getOrder(orderId);
    await manualDelivery.openManualDelivery(bot, freshManual, 'cryptobot');
    const _paidOrder = db.getOrder(orderId) || order;
    consumeAllowanceFor(_paidOrder, _paidOrder?.allowance_units);
  await handleReferralReward(bot, userId);
    await evaluateStock(bot, order.product_id);
    return true;
  }

  const content = db.deliverOrder(orderId, order.product_id, order.quantity, 'cryptobot', userId);
  if (!content) {
    // Notify user — they already paid, must contact support
    try {
      await bot.sendMessage(
        userId,
        `❌ <b>Out of Stock</b>\n\n` +
        `Sorry — the product ran out while processing your CryptoBot payment.\n\n` +
        `📦 Order: <b>#${orderId}</b>\n` +
        `🆔 Invoice: <code>${invoiceId}</code>\n\n` +
        `Please contact support to get a refund.`,
        { parse_mode: 'HTML' }
      );
    } catch (e) { logger.warn(`Could not notify user ${userId} of CryptoBot out-of-stock: ${e.message}`); }
    db.updateOrderStatus(orderId, 'cancelled');
    for (const adminId of config.adminIds) {
      bot.sendMessage(
        adminId,
        `⚠️ <b>CryptoBot Order #${orderId} — OUT OF STOCK</b>\nUser: <code>${userId}</code>\nInvoice: <code>${invoiceId}</code>\n⚠️ Refund needed!`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
    }
    return true;
  }

  const freshOrder = db.getOrder(orderId);
  await sendDelivery(bot, userId, freshOrder, content);
  return true;
}

async function sendOutOfStock(bot, chatId, order, method, messageId = null) {
  db.updateOrderStatus(order.id, 'cancelled');

  let refundNote = '';
  // For WALLET method: wallet was NEVER charged (atomic), so NO refund needed
  // For EXTERNAL methods (Binance/USDT/CryptoBot): customer already paid — contact support
  if (method === 'wallet') {
    refundNote = '\n\n<i>No payment was taken from your wallet.</i>';
  } else {
    refundNote = `\n\n📞 You already paid externally. Contact support with Order ID: <code>${order.id}</code>`;
  }

  const text = `❌ <b>Out of Stock!</b>\n\nWe ran out of stock while processing your order.${refundNote}`;
  if (messageId) {
    await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' });
  } else {
    await bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
  }

  for (const adminId of config.adminIds) {
    bot.sendMessage(
      adminId,
      `⚠️ <b>Out of Stock Alert</b>\nOrder #${order.id} failed.\nProduct: ${order.product_title}\nUser: ${order.user_id}`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
  }
}

// ── Referral reward ───────────────────────────────────────────────────────────

/**
 * Consume the customer's special-price allowance for a PAID order.
 *
 * Called only after payment succeeds — an abandoned or failed order must never
 * eat the allowance. The ledger is keyed by order_id, so calling this twice for
 * the same order (webhook retry, double tap) is harmless.
 *
 * The unit count is read back from the session snapshot stored on the order at
 * checkout, so it survives the session expiring between payment steps.
 */
function consumeAllowanceFor(order, units) {
  const n = Number(units) || 0;
  if (n <= 0) return;
  try {
    const first = db.consumeCustomerAllowance(order.id, order.user_id, order.product_id, n);
    if (first) {
      const left = db.getCustomerAllowance(order.user_id, order.product_id);
      logger.info(
        `Allowance: order #${order.id} used ${n} unit(s) for user ${order.user_id} ` +
        `on product ${order.product_id}` +
        (left && !left.unlimited ? ` — ${left.remaining} left` : '')
      );
    }
  } catch (e) {
    logger.error(`consumeAllowanceFor(order #${order.id}) failed: ${e.message}`);
  }
}

async function handleReferralReward(bot, referredId) {
  const reward     = parseFloat(db.getSetting('referral_reward', '0.20'));
  const referrerId = db.payReferralReward(referredId, reward);
  if (!referrerId) return;

  bot.sendMessage(
    referrerId,
    `🎉 <b>Referral Reward!</b>\n\nUser ${referredId} made their first purchase via your link.\n` +
    `💰 <b>${formatReward(reward)}</b> added to your wallet!`,
    { parse_mode: 'HTML' }
  ).catch(() => {});
}

// ── Back-in-stock subscription ────────────────────────────────────────────────

async function handleNotifyBackInStock(bot, chatId, userId, productId) {
  const product = db.getProduct(productId);
  if (!product) {
    await bot.sendMessage(chatId, '❌ Product not found.');
    return;
  }

  // If stock is already available, redirect to product
  if ((product.stock_quantity || 0) > 0) {
    await bot.sendMessage(chatId, `✅ <b>${product.title}</b> is already in stock!\n\nTap Buy Now to purchase.`, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '🛒 Buy Now', callback_data: `buy_${productId}` }]] },
    });
    return;
  }

  const alreadySubscribed = db.isSubscribedBackInStock(userId, productId);
  if (alreadySubscribed) {
    await bot.sendMessage(
      chatId,
      `🔔 You're already subscribed to notifications for <b>${product.title}</b>.\n\nWe'll notify you when it's back in stock.`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'menu_products' }]] } }
    );
    return;
  }

  db.subscribeBackInStock(userId, productId);
  await bot.sendMessage(
    chatId,
    `🔔 <b>Notification set!</b>\n\nWe'll notify you as soon as <b>${product.title}</b> is back in stock.`,
    { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'menu_products' }]] } }
  );
}

/**
 * Called by admin stock handlers when stock goes from 0 → N.
 * Notifies all subscribed users and clears subscriptions.
 */
async function notifyBackInStockSubscribers(bot, productId) {
  const product = db.getProduct(productId);
  if (!product) return;

  const subscribers = db.getBackInStockSubscribers(productId);
  if (!subscribers.length) return;

  const { backInStockKb } = require('../utils/keyboard');
  const text =
    `✅ <b>Good news!</b>\n\n` +
    `<b>${product.title}</b> is back in stock.\n\n` +
    `Tap below to buy now.`;

  let notified = 0;
  for (const userId of subscribers) {
    try {
      await bot.sendMessage(userId, text, {
        parse_mode: 'HTML',
        reply_markup: backInStockKb(productId),
      });
      notified++;
    } catch { /* user may have blocked */ }
  }

  // Clear subscriptions after notifying
  db.clearBackInStockSubscriptions(productId);
  logger.info(`Back-in-stock: notified ${notified}/${subscribers.length} users for product #${productId}`);
  return notified;
}



// ─────────────────────────────────────────────────────────────────────────────
// PRE-ORDER FLOW (customer side)
// ─────────────────────────────────────────────────────────────────────────────

async function initiatePreorder(bot, chatId, userId, productId, messageId) {
  const product = db.getProduct(productId);
  if (!product) {
    await bot.sendMessage(chatId, '❌ Product not found.');
    return;
  }
  if (!product.preorder_enabled) {
    await bot.sendMessage(chatId, '❌ Pre-Order is not available for this product.');
    return;
  }
  const remaining = (product.preorder_max || 0) - (product.preorder_count || 0);
  if (remaining <= 0) {
    await bot.sendMessage(chatId, '❌ All pre-order slots are taken. Sorry!');
    return;
  }

  // Save preorder context
  session.set(userId, States.BUY_PREORDER_QTY, {
    preProductId: productId,
    preMaxQty:    remaining,
    productTitle: product.title,
    productPrice: product.price,
    requiresEmail: !!product.requires_email,
  });

  await bot.sendMessage(
    chatId,
    `🔜 <b>Pre-Order: ${product.title}</b>\n\n` +
    `💵 Price per unit: <b>${formatPrice(product.price)}</b>\n` +
    `📦 Available slots: <b>${remaining}</b>\n\n` +
    `Enter the quantity you want to reserve (1 to ${remaining}):`,
    { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'menu_products' }]] } }
  );
}

async function handlePreorderQty(bot, msg) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const sess   = session.get(userId);
  if (sess.state !== States.BUY_PREORDER_QTY) return;

  const qty = parseInt(msg.text, 10);
  if (isNaN(qty) || qty < 1) {
    await bot.sendMessage(chatId, '❌ Please enter a valid number.');
    return;
  }
  if (qty > sess.data.preMaxQty) {
    await bot.sendMessage(chatId, `❌ Only ${sess.data.preMaxQty} slots remaining.`);
    return;
  }

  session.update(userId, { preQty: qty });
  let total = qty * sess.data.productPrice;
  if (db.isVIP(userId)) total = Number((total * 0.95).toFixed(2));
  session.update(userId, { preTotal: total });

  if (sess.data.requiresEmail) {
    session.set(userId, States.BUY_PREORDER_EMAIL, session.get(userId).data);
    await bot.sendMessage(chatId, '📧 Please enter your email for delivery:');
    return;
  }
  await askPreorderConfirm(bot, chatId, userId);
}

async function handlePreorderEmail(bot, msg) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const sess   = session.get(userId);
  if (sess.state !== States.BUY_PREORDER_EMAIL) return;
  const email = String(msg.text).trim();
  if (!email.includes('@')) {
    await bot.sendMessage(chatId, '❌ Please enter a valid email.');
    return;
  }
  session.update(userId, { preEmail: email });
  await askPreorderConfirm(bot, chatId, userId);
}

async function askPreorderConfirm(bot, chatId, userId) {
  const sess = session.get(userId);
  const d = sess.data;
  await bot.sendMessage(
    chatId,
    `🔜 <b>Confirm Pre-Order</b>\n\n` +
    `📦 Product: ${d.productTitle}\n` +
    `🔢 Quantity: ${d.preQty}\n` +
    (d.preEmail ? `📧 Email: ${d.preEmail}\n` : '') +
    `💵 Total: <b>${formatPrice(d.preTotal)}</b>\n\n` +
    `Payment will be deducted from your wallet immediately.\n` +
    `Once stock arrives, your order will be delivered automatically.`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ Confirm & Pay from Wallet', callback_data: `confirm_preorder_${d.preProductId}` }],
          [{ text: '❌ Cancel', callback_data: `cancel_preorder_${d.preProductId}` }],
        ],
      },
    }
  );
}

async function confirmPreorder(bot, chatId, userId, productId, messageId) {
  const sess = session.get(userId);
  const d    = sess.data;
  if (!d || d.preProductId !== productId) {
    await bot.sendMessage(chatId, '❌ Session expired. Please try again.');
    return;
  }

  // Re-check availability
  const product = db.getProduct(productId);
  const remaining = (product.preorder_max || 0) - (product.preorder_count || 0);
  if (remaining < d.preQty) {
    await bot.sendMessage(chatId, '❌ Not enough slots left. Please try a smaller quantity.');
    session.clear(userId);
    return;
  }

  // Check wallet balance — floating-point safe
  const userObj = db.getUser(userId);
  const balance = userObj?.balance || 0;
  const balanceRounded = Math.round((balance + Number.EPSILON) * 100) / 100;
  const totalRounded   = Math.round((d.preTotal + Number.EPSILON) * 100) / 100;
  if (balanceRounded < totalRounded) {
    await bot.sendMessage(
      chatId,
      `❌ Insufficient wallet balance.\n\n` +
      `Need: <b>${formatPrice(d.preTotal)}</b>\n` +
      `Have: <b>${formatPrice(balance)}</b>\n\n` +
      `Please top up first.`,
      { parse_mode: 'HTML' }
    );
    session.clear(userId);
    return;
  }

  // ── ATOMIC balance deduction ──
  const preChargeResult = db.chargeWalletForPreorder(userId, d.preTotal);
  if (!preChargeResult || !preChargeResult.ok) {
    await bot.sendMessage(chatId,
      `❌ Insufficient wallet balance.\n\nNeed: <b>${formatPrice(d.preTotal)}</b>\nHave: <b>${formatPrice(preChargeResult?.balance || 0)}</b>\n\nPlease top up first.`,
      { parse_mode: 'HTML' });
    session.clear(userId);
    return;
  }
  db.createPreorder({
    orderId:       null,
    userId,
    productId,
    quantity:      d.preQty,
    email:         d.preEmail || null,
    totalPaid:     d.preTotal,
    paymentMethod: 'wallet',
  });
  db.incrementPreorderCount(productId, d.preQty);
  db.addTransaction({
    userId,
    type:        'preorder',
    amount:      -d.preTotal,
    description: `Pre-Order: ${product.title} ×${d.preQty}`,
    refId:       null,
    orderId:     null,
  });

  session.clear(userId);

  await bot.editMessageText(
    `✅ <b>Pre-Order Confirmed!</b>\n\n` +
    `📦 ${product.title} ×${d.preQty}\n` +
    (d.preEmail ? `📧 ${d.preEmail}\n` : '') +
    `💵 Paid: <b>${formatPrice(d.preTotal)}</b>\n\n` +
    `🎉 You'll be notified when your order is ready!`,
    { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: mainMenuKb() }
  ).catch(async () => {
    await bot.sendMessage(chatId,
      `✅ <b>Pre-Order Confirmed!</b>\n\n📦 ${product.title} ×${d.preQty}\n💵 ${formatPrice(d.preTotal)}`,
      { parse_mode: 'HTML', reply_markup: mainMenuKb() });
  });

  // Notify admins
  for (const adminId of config.adminIds) {
    bot.sendMessage(
      adminId,
      `🔜 <b>New Pre-Order</b>\n` +
      `👤 User: <code>${userId}</code>\n` +
      `📦 ${product.title} ×${d.preQty}\n` +
      `💵 ${formatPrice(d.preTotal)}` +
      (d.preEmail ? `\n📧 ${d.preEmail}` : ''),
      { parse_mode: 'HTML' }
    ).catch(() => {});
  }
}

async function cancelPreorder(bot, chatId, userId, productId, messageId) {
  session.clear(userId);
  await bot.editMessageText(
    '❌ Pre-order cancelled.',
    { chat_id: chatId, message_id: messageId, reply_markup: mainMenuKb() }
  ).catch(() => {
    bot.sendMessage(chatId, '❌ Pre-order cancelled.', { reply_markup: mainMenuKb() });
  });
}


module.exports = {
  initiateBuy, handleQuantity, handleEmail,
  confirmOrder, cancelOrder,
  payWithWallet,
  startBinancePayForOrder, handleBinanceOrderId,
  startUsdtPayForOrder,    handleUsdtTxIdForOrder,
  startCryptobotPayForOrder, deliverCryptobotOrder,
  handleNotifyBackInStock, notifyBackInStockSubscribers,
  initiatePreorder, handlePreorderQty, handlePreorderEmail,
  confirmPreorder, cancelPreorder,
};
