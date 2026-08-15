'use strict';

/**
 * 🤖 ChatGPT Business Subscription Bot
 * 
 * - Standalone bot with own token (CHATGPT_BOT_TOKEN)
 * - Shares the same database as main bot
 * - Handles billing cycles, pricing, payments
 * - Customer arrives via deep link: t.me/{bot}?start=cgb
 */

const TelegramBot = require('node-telegram-bot-api');
const Database    = require('better-sqlite3');
const logger      = require('./utils/logger');
const { verifyDepositByTxId, verifyBinancePayOrder, TXID_RE } = require('./services/binance');

const CHATGPT_BOT_TOKEN = process.env.CHATGPT_BOT_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_ID || '5626665035', 10);
const SUPPORT_BOT_USERNAME = (process.env.SUPPORT_BOT_USERNAME || '').replace(/^@/, '');

if (!CHATGPT_BOT_TOKEN) {
  logger.warn('ChatGPT Business bot disabled — CHATGPT_BOT_TOKEN missing');
  module.exports = null;
  return;
}

const dbPath = process.env.DB_PATH || '/app/data/store.db';
const db = new Database(dbPath);
const queries = require('./database/queries');

const bot = new TelegramBot(CHATGPT_BOT_TOKEN, { polling: true });
logger.info('🤖 ChatGPT Business Bot started');

// ════════════════════════════════════════════════════════════════
// IN-MEMORY SESSIONS
// ════════════════════════════════════════════════════════════════
const sessions = new Map(); // userId → { state, ...data }

function setSession(userId, state, data = {}) {
  // Spread data FIRST, then set state to override any state in data
  sessions.set(userId, { ...data, state });
}
function getSession(userId) {
  return sessions.get(userId) || null;
}
function clearSession(userId) {
  sessions.delete(userId);
}

// ════════════════════════════════════════════════════════════════
// UTILS
// ════════════════════════════════════════════════════════════════
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
}

function formatDate(d) {
  return d.toISOString().slice(0, 10);
}

function formatDisplayDate(d) {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

/**
 * Is the ChatGPT Business seat available to sell right now?
 *
 * Stored as a plain setting rather than a stock count because seats are not
 * consumed one-by-one from a shelf — either you can take another customer or
 * you cannot. The admin flips it from the main panel.
 */
function isOutOfStock() {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key='cgb_out_of_stock'").get();
    return String(row?.value || '0') === '1';
  } catch (e) {
    return false;   // never block sales because a lookup failed
  }
}

/** Admin-editable message shown while sales are paused. */
function outOfStockMessage() {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key='cgb_out_of_stock_message'").get();
    if (row?.value) return row.value;
  } catch (e) { /* fall through to the default */ }
  return 'Seats are sold out at the moment. We restock regularly — check back soon.';
}

function getMonthlyPrice() {
  try {
    const row = db.prepare(`SELECT value FROM settings WHERE key='chatgpt_monthly_price'`).get();
    return parseFloat(row?.value || '50') || 50;
  } catch (e) {
    return 50;
  }
}

// ════════════════════════════════════════════════════════════════
// CORE LOGIC: Calculate best billing cycle for today
// ════════════════════════════════════════════════════════════════
function calculateBestCycle() {
  const cycles = queries.getBillingCycles();
  if (!cycles.length) {
    // Fallback default cycles
    cycles.push({ start_day: 26, end_day: 25 });
    cycles.push({ start_day: 16, end_day: 15 });
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let best = null;
  for (const cycle of cycles) {
    // Compute end_date for this cycle relative to today
    // The end_date is the next occurrence of cycle.end_day on or after today
    let endDate = new Date(today.getFullYear(), today.getMonth(), cycle.end_day);
    if (endDate < today) {
      // End day already passed this month → next month
      endDate = new Date(today.getFullYear(), today.getMonth() + 1, cycle.end_day);
    }
    const daysRemaining = Math.ceil((endDate - today) / (1000 * 60 * 60 * 24));

    if (!best || daysRemaining > best.daysRemaining) {
      best = {
        cycle,
        endDate,
        daysRemaining,
      };
    }
  }

  return best;
}

function calculateNextCycleStarts() {
  const cycles = queries.getBillingCycles();
  if (!cycles.length) return [];

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const upcoming = [];
  for (const cycle of cycles) {
    let startDate = new Date(today.getFullYear(), today.getMonth(), cycle.start_day);
    if (startDate <= today) {
      startDate = new Date(today.getFullYear(), today.getMonth() + 1, cycle.start_day);
    }
    const daysAway = Math.ceil((startDate - today) / (1000 * 60 * 60 * 24));
    upcoming.push({ day: cycle.start_day, date: startDate, daysAway });
  }
  upcoming.sort((a, b) => a.daysAway - b.daysAway);
  return upcoming;
}

// ════════════════════════════════════════════════════════════════
// WELCOME / CALCULATION SCREEN
// ════════════════════════════════════════════════════════════════
async function showCalculation(chatId, userId, extraMonth = false) {
  // Checked before anything is priced, so the customer never sees an offer we
  // cannot honour.
  if (isOutOfStock()) {
    const buttons = [];
    if (SUPPORT_BOT_USERNAME) {
      buttons.push([{ text: '📞 Contact Support', url: `https://t.me/${SUPPORT_BOT_USERNAME}` }]);
    }
    buttons.push([{ text: '🔄 Check again', callback_data: 'cgb_recheck' }]);
    await bot.sendMessage(
      chatId,
      `🔴 <b>Out of Stock</b>\n\n` +
      `📦 ChatGPT Business Seat\n\n` +
      `${escapeHtml(outOfStockMessage())}`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } }
    );
    return;
  }

  const best = calculateBestCycle();
  if (!best) {
    await bot.sendMessage(chatId, '❌ Error: No billing cycles configured. Contact support.');
    return;
  }

  const monthlyPrice = getMonthlyPrice();
  const basePrice = Number(((best.daysRemaining / 30) * monthlyPrice).toFixed(2));
  const finalPrice = extraMonth ? Number((basePrice + monthlyPrice).toFixed(2)) : basePrice;
  const endDate = extraMonth
    ? new Date(best.endDate.getTime() + 30 * 24 * 60 * 60 * 1000)
    : best.endDate;

  const upcoming = calculateNextCycleStarts();
  const upcomingTxt = upcoming.slice(0, 3).map(u =>
    `   • Day ${u.day} (in ${u.daysAway} day${u.daysAway === 1 ? '' : 's'})`
  ).join('\n');

  const today = new Date();
  const totalDays = extraMonth ? best.daysRemaining + 30 : best.daysRemaining;

  const txt =
    `👋 <b>ChatGPT Business Subscription</b>\n\n` +
    `📦 <b>Product:</b> ChatGPT Business Seat\n` +
    `📅 <b>Today:</b> ${formatDisplayDate(today)}\n` +
    `📅 <b>Subscription ends:</b> ${formatDisplayDate(endDate)}\n` +
    `⏳ <b>Days you'll get:</b> ${totalDays} day${totalDays === 1 ? '' : 's'}\n` +
    `💰 <b>Price:</b> $${finalPrice.toFixed(2)}\n\n` +
    (extraMonth ? '✅ Full month added!\n\n' : '') +
    `💡 <i>For a full month at $${monthlyPrice}, wait for one of these dates:</i>\n${upcomingTxt}`;

  setSession(userId, 'AWAITING_ACTION', {
    daysRemaining: best.daysRemaining,
    extraMonth,
    basePrice,
    finalPrice,
    startDate: formatDate(today),
    endDate: formatDate(endDate),
    monthlyPrice,
  });

  const buttons = [];
  if (!extraMonth) {
    buttons.push([{ text: `➕ Add Full Month (+$${monthlyPrice})`, callback_data: 'add_month' }]);
  } else {
    buttons.push([{ text: '➖ Remove Full Month', callback_data: 'remove_month' }]);
  }
  buttons.push([{ text: `🛒 Order Now — $${finalPrice.toFixed(2)}`, callback_data: 'order_now' }]);
  if (SUPPORT_BOT_USERNAME) {
    buttons.push([{ text: '📞 Support', url: `https://t.me/${SUPPORT_BOT_USERNAME}` }]);
  }
  buttons.push([{ text: '❌ Cancel', callback_data: 'cancel' }]);

  await bot.sendMessage(chatId, txt, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: buttons },
  });
}

// ════════════════════════════════════════════════════════════════
// /start COMMAND
// ════════════════════════════════════════════════════════════════
bot.onText(/\/start(.*)/, async (msg, match) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  // Register user if not exists (shared DB with main bot)
  try {
    db.prepare(`
      INSERT OR IGNORE INTO users (telegram_id, username, first_name, last_name)
      VALUES (?, ?, ?, ?)
    `).run(userId, msg.from.username || null, msg.from.first_name || null, msg.from.last_name || null);
  } catch (e) {}

  await showCalculation(chatId, userId, false);
});

// ════════════════════════════════════════════════════════════════
// CALLBACK QUERIES
// ════════════════════════════════════════════════════════════════
bot.on('callback_query', async (q) => {
  const userId = q.from.id;
  const chatId = q.message.chat.id;
  const msgId  = q.message.message_id;
  const data   = q.data;

  await bot.answerCallbackQuery(q.id).catch(() => {});

  // ── Admin: Notify customer that subscription is activated ──────────────────
  if (data.startsWith('cgb_notify_')) {
    if (String(userId) !== String(ADMIN_ID)) return;
    // format: cgb_notify_{orderId}_{customerId}_{days}_{endDate}
    const parts      = data.split('_');
    // parts: ['cgb','notify', orderId, customerId, days, ...endDate]
    const orderId    = parts[2];
    const customerId = parts[3];
    const days       = parts[4];
    const endDate    = decodeURIComponent(parts.slice(5).join('_'));
    try {
      await bot.sendMessage(Number(customerId),
        `✅ <b>Your ChatGPT Business Subscription is Now Active!</b>\n\n` +
        `🆔 Order: <b>#${orderId}</b>\n` +
        `⏱ Duration: <b>${days} days</b>\n` +
        `📅 Expiry date: <b>${endDate}</b>\n\n` +
        `Your subscription has been successfully activated on the email you provided.\n` +
        `If you face any issues, please contact our support team.`,
        { parse_mode: 'HTML' }
      );

      // Mark subscription as active in the DB (was never done before — gap fix)
      try {
        queries.activateCgbSubscription(parseInt(orderId, 10));
        db.prepare(`UPDATE orders SET status='delivered' WHERE id=?`).run(parseInt(orderId, 10));
      } catch (e) {
        logger.warn(`cgb_notify_: could not mark order/sub active: ${e.message}`);
      }

      await bot.editMessageReplyMarkup(
        { inline_keyboard: [[{ text: '✅ Customer Notified ✓', callback_data: 'noop' }]] },
        { chat_id: chatId, message_id: msgId }
      ).catch(() => {});
    } catch (e) {
      await bot.sendMessage(chatId, `❌ Could not notify customer: ${e.message}`);
    }
    return;
  }

  if (data === 'cancel') {
    clearSession(userId);
    await bot.sendMessage(chatId,
      '❌ Cancelled.\n\nUse /start to begin a new subscription.',
      { parse_mode: 'HTML' });
    return;
  }

  if (data === 'add_month') {
    await bot.deleteMessage(chatId, msgId).catch(() => {});
    await showCalculation(chatId, userId, true);
    return;
  }

  if (data === 'remove_month') {
    await bot.deleteMessage(chatId, msgId).catch(() => {});
    await showCalculation(chatId, userId, false);
    return;
  }

  if (data === 'cgb_recheck') {
    await showCalculation(chatId, userId, false);
    return;
  }

  if (data === 'order_now') {
    // Checked again here, not only when the offer was drawn: a customer can sit
    // on an old message for hours and tap Order after seats have sold out.
    if (isOutOfStock()) {
      await bot.sendMessage(chatId,
        `🔴 <b>Out of Stock</b>\n\n${escapeHtml(outOfStockMessage())}`,
        { parse_mode: 'HTML' });
      return;
    }
    const s = getSession(userId);
    if (!s || s.state !== 'AWAITING_ACTION') {
      await bot.sendMessage(chatId, '⏰ Session expired. Use /start to begin again.');
      return;
    }
    setSession(userId, 'AWAITING_EMAIL', s);
    await bot.sendMessage(chatId,
      '📧 <b>Please enter the email address for the subscription:</b>\n\n' +
      '<i>This is the email where ChatGPT Business will be activated.</i>',
      { parse_mode: 'HTML' });
    return;
  }

  // Payment method buttons
  if (data === 'pay_binance' || data === 'pay_bep20' || data === 'pay_trc20' || data === 'pay_cryptobot') {
    const s = getSession(userId);
    if (!s || s.state !== 'CONFIRM_ORDER') {
      await bot.sendMessage(chatId, '⏰ Session expired. Use /start to begin again.');
      return;
    }

    try {
      // Find a real CGB product (the one flagged is_chatgpt_business) for FK
      let cgbProductId = 0;
      try {
        const p = db.prepare(`SELECT id FROM products WHERE is_chatgpt_business=1 LIMIT 1`).get();
        if (p) cgbProductId = p.id;
      } catch (e) {}

      // Create order in DB
      const orderResult = db.prepare(`
        INSERT INTO orders (user_id, product_id, quantity, total_price, payment_method, status, email)
        VALUES (?, ?, 1, ?, ?, 'pending', ?)
      `).run(userId, cgbProductId, s.finalPrice, data.replace('pay_', ''), s.email);
      const orderId = orderResult.lastInsertRowid;

      // Create subscription record
      try {
        queries.createCgbSubscription(
          orderId, userId, s.email, s.startDate, s.endDate,
          s.daysRemaining + (s.extraMonth ? 30 : 0),
          s.basePrice, s.extraMonth ? 1 : 0, s.finalPrice
        );
      } catch (subErr) {
        logger.error('createCgbSubscription failed: ' + subErr.message);
      }

      setSession(userId, 'AWAITING_PAYMENT', {
        ...s,
        orderId,
        paymentMethod: data,
        // Ensure these are always present for admin notification
        endDate:       s.endDate      || 'N/A',
        startDate:     s.startDate    || new Date().toISOString().slice(0, 10),
        daysRemaining: s.daysRemaining || 0,
        extraMonth:    s.extraMonth   || false,
        finalPrice:    s.finalPrice   || 0,
      });

      await showPaymentInstructions(chatId, userId, data, s.finalPrice, orderId);
    } catch (e) {
      logger.error('Payment button error: ' + e.message);
      await bot.sendMessage(chatId,
        `❌ Error creating order: ${e.message}\n\nPlease contact support.`,
        { parse_mode: 'HTML' });
    }
    return;
  }

  if (data.startsWith('change_email')) {
    const s = getSession(userId);
    if (!s) return;
    setSession(userId, 'AWAITING_EMAIL', s);
    await bot.sendMessage(chatId, '📧 Please enter the new email:', { parse_mode: 'HTML' });
    return;
  }
});

// ════════════════════════════════════════════════════════════════
// PAYMENT INSTRUCTIONS
// ════════════════════════════════════════════════════════════════
async function showPaymentInstructions(chatId, userId, method, amount, orderId) {
  const bep20 = process.env.USDT_BEP20_ADDRESS || '0x...';
  const trc20 = process.env.USDT_TRC20_ADDRESS || 'T...';
  const binanceId = '263344433';

  let txt = '';
  if (method === 'pay_binance') {
    txt =
      `💰 <b>Pay with Binance Pay</b>\n\n` +
      `📦 Order: #${orderId}\n` +
      `💵 Amount due: <b>$${amount.toFixed(2)}</b>\n\n` +
      `🔷 Binance ID: <code>${binanceId}</code>\n\n` +
      `📌 <b>Steps:</b>\n` +
      `1. Open Binance app → Pay → Send\n` +
      `2. Enter the Binance ID above\n` +
      `3. Send exactly <b>$${amount.toFixed(2)} USDT</b>\n` +
      `4. Copy the <b>Order ID</b> and send it here\n\n` +
      `⚠️ Pay the EXACT amount.`;
  } else if (method === 'pay_bep20' || method === 'pay_trc20') {
    const network = method === 'pay_bep20' ? 'BEP20 (BNB Chain)' : 'TRC20 (TRON)';
    const address = method === 'pay_bep20' ? bep20 : trc20;
    txt =
      `💎 <b>Pay with USDT ${network}</b>\n\n` +
      `📦 Order: #${orderId}\n` +
      `💵 Amount due: <b>$${amount.toFixed(2)} USDT</b>\n\n` +
      `📋 Address:\n<code>${address}</code>\n\n` +
      `📌 <b>Steps:</b>\n` +
      `1. Send <b>$${amount.toFixed(2)} USDT</b> on ${network}\n` +
      `2. Copy the <b>TxID</b> (transaction hash)\n` +
      `3. Send it here\n\n` +
      `⚠️ Pay the EXACT amount.`;
  } else if (method === 'pay_cryptobot') {
    // Create real CryptoBot invoice
    try {
      const cryptobot = require('./services/cryptobot');
      const CRYPTOBOT_FEE = 0.01;
      const orderAmount   = Number(amount.toFixed(2));
      const invoiceAmount = Number((orderAmount + CRYPTOBOT_FEE).toFixed(2));
      const invoice = await cryptobot.createInvoice({
        amount:      invoiceAmount, // زبون يدفع + fee
        asset:       'USDT',
        payload:     `order:${orderId}:${userId}`,
        description: `ChatGPT Business Order #${orderId}`,
      });
      // Save invoice to DB — store original order amount (without fee)
      try {
        const db = require('./database/queries');
        db.saveCryptobotInvoice({
          invoiceId: invoice.invoice_id,
          userId,
          asset:  'USDT',
          amount: orderAmount,
          payUrl: invoice.bot_invoice_url || invoice.pay_url,
        });
      } catch (e) {}

      await bot.sendMessage(chatId,
        `🤖 <b>CryptoBot Payment</b>\n\n` +
        `📦 Order: <b>#${orderId}</b>\n` +
        `💵 Amount: <b>$${invoiceAmount.toFixed(2)} USDT</b> <i>(includes $${CRYPTOBOT_FEE} network fee)</i>\n\n` +
        `Press the button below to pay securely via CryptoBot:`,
        {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [
            [{ text: '💎 Pay with CryptoBot', url: invoice.pay_url }],
            [{ text: '❌ Cancel Order', callback_data: 'cancel' }],
            ...(SUPPORT_BOT_USERNAME ? [[{ text: '📞 Support', url: `https://t.me/${SUPPORT_BOT_USERNAME}` }]] : []),
          ] },
        }
      );
    } catch (e) {
      await bot.sendMessage(chatId,
        `❌ Could not create CryptoBot invoice: ${e.message}\n\nPlease choose another payment method or contact support.`,
        { parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'cancel' }]] } }
      );
    }
    return; // showPaymentInstructions already sent message
  }

  await bot.sendMessage(chatId, txt, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [
      [{ text: '❌ Cancel Order', callback_data: 'cancel' }],
      ...(SUPPORT_BOT_USERNAME ? [[{ text: '📞 Support', url: `https://t.me/${SUPPORT_BOT_USERNAME}` }]] : []),
    ] },
  });
}

// ════════════════════════════════════════════════════════════════
// TEXT MESSAGES (email + txid)
// ════════════════════════════════════════════════════════════════
bot.on('message', async (msg) => {
  if (msg.text && msg.text.startsWith('/')) return;
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  if (!text) return;

  const s = getSession(userId);
  if (!s) return;

  // ─── Awaiting email ───
  if (s.state === 'AWAITING_EMAIL') {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
      await bot.sendMessage(chatId, '❌ Invalid email. Please try again.');
      return;
    }
    s.email = text;
    setSession(userId, 'CONFIRM_ORDER', s);

    // Show order summary
    const txt =
      `📋 <b>Order Summary</b>\n\n` +
      `📦 ChatGPT Business Seat\n` +
      `📧 Email: <code>${escapeHtml(text)}</code>\n` +
      `📅 From: ${s.startDate}\n` +
      `📅 To: ${s.endDate}\n` +
      `⏳ Duration: ${s.daysRemaining + (s.extraMonth ? 30 : 0)} days\n` +
      `💰 <b>Total: $${s.finalPrice.toFixed(2)}</b>\n\n` +
      `Select payment method:`;

    await bot.sendMessage(chatId, txt, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [
        [{ text: '💳 Pay with Binance Pay', callback_data: 'pay_binance' }],
        [{ text: '💎 USDT BEP20', callback_data: 'pay_bep20' }, { text: '💎 USDT TRC20', callback_data: 'pay_trc20' }],
        [{ text: '🤖 CryptoBot', callback_data: 'pay_cryptobot' }],
        [{ text: '✏️ Change Email', callback_data: 'change_email' }],
        [{ text: '❌ Cancel', callback_data: 'cancel' }],
      ] },
    });
    return;
  }

  // ─── Awaiting payment TxID / Binance Order ID ───
  if (s.state === 'AWAITING_PAYMENT') {
    const orderId = s.orderId;

    if (s.paymentMethod === 'pay_binance') {
      // Binance Order ID — numeric, 17-19 digits
      if (!/^\d{15,25}$/.test(text)) {
        await bot.sendMessage(chatId, '❌ Invalid Binance Order ID. Please copy the full numeric Order ID.');
        return;
      }
      await bot.sendMessage(chatId,
        '⏳ <b>Processing your payment...</b>\n\nVerifying with Binance Pay. This may take 10-30 seconds.',
        { parse_mode: 'HTML' });

      try {
        const result = await verifyBinancePayOrder(text);
        if (!result.found) {
          await bot.sendMessage(chatId, '❌ ' + (result.message || 'Payment not found.'));
          return;
        }
        // Check amount
        if (Math.abs(result.amount - s.finalPrice) > 0.05) {
          await bot.sendMessage(chatId,
            `❌ Amount mismatch. Required $${s.finalPrice.toFixed(2)}, got $${result.amount.toFixed(2)}.\n\n` +
            `Please contact support.`);
          return;
        }
        await confirmPayment(chatId, userId, orderId, text, s);
      } catch (e) {
        await bot.sendMessage(chatId, '❌ Verification error. Please contact support.');
      }
      return;
    }

    if (s.paymentMethod === 'pay_bep20' || s.paymentMethod === 'pay_trc20') {
      if (!TXID_RE.test(text)) {
        await bot.sendMessage(chatId, '❌ Invalid TxID format. Please send the full transaction hash.');
        return;
      }
      await bot.sendMessage(chatId,
        '⏳ <b>Processing your payment...</b>\n\nVerifying on blockchain. This may take 30-60 seconds.',
        { parse_mode: 'HTML' });

      try {
        const network = s.paymentMethod === 'pay_bep20' ? 'BEP20' : 'TRC20';
        const result = await verifyDepositByTxId(text, network);
        if (!result.found) {
          await bot.sendMessage(chatId, '❌ ' + (result.message || 'Transaction not found.'));
          return;
        }
        if (Math.abs(result.amount - s.finalPrice) > 0.05) {
          await bot.sendMessage(chatId,
            `❌ Amount mismatch. Required $${s.finalPrice.toFixed(2)}, got $${result.amount.toFixed(2)}.\n\n` +
            `Please contact support.`);
          return;
        }
        await confirmPayment(chatId, userId, orderId, text, s);
      } catch (e) {
        await bot.sendMessage(chatId, '❌ Verification error. Please contact support.');
      }
      return;
    }
  }
});

// ════════════════════════════════════════════════════════════════
// PAYMENT CONFIRMED — finalize order
// ════════════════════════════════════════════════════════════════
async function confirmPayment(chatId, userId, orderId, txid, sessionData) {
  // Mark order as paid
  try {
    db.prepare(`UPDATE orders SET status='paid', payment_proof=? WHERE id=?`).run(txid, orderId);
  } catch (e) {}

  clearSession(userId);

  const txt =
    `✅ <b>Payment Confirmed!</b>\n\n` +
    `📦 Order #${orderId}\n` +
    `📧 Email: ${escapeHtml(sessionData.email)}\n` +
    `📅 Subscription until: ${sessionData.endDate}\n` +
    `💰 Paid: $${sessionData.finalPrice.toFixed(2)}\n\n` +
    `📞 <b>Please contact support to activate your subscription:</b>\n` +
    (SUPPORT_BOT_USERNAME ? `👉 https://t.me/${SUPPORT_BOT_USERNAME}` : '👉 Contact admin') +
    `\n\nYour subscription will be active once support confirms.`;

  await bot.sendMessage(chatId, txt, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [
      ...(SUPPORT_BOT_USERNAME ? [[{ text: '📞 Contact Support', url: `https://t.me/${SUPPORT_BOT_USERNAME}` }]] : []),
      [{ text: '🔄 New Order', callback_data: 'cancel' }],
    ] },
  });

  // Notify admin
  try {
    const user = db.prepare('SELECT username, first_name FROM users WHERE telegram_id=?').get(userId);
    const name = user?.username ? '@' + user.username : (user?.first_name || `User ${userId}`);
    const totalDays = sessionData.daysRemaining + (sessionData.extraMonth ? 30 : 0);

    // Payment method label
    const paymentMethod = sessionData.paymentMethod || 'unknown';
    const payMethodLabel = {
      pay_binance:  '🟡 Binance Pay',
      pay_bep20:    '💎 USDT BEP20',
      pay_trc20:    '💎 USDT TRC20',
      pay_cryptobot:'🤖 CryptoBot',
    }[paymentMethod] || paymentMethod;

    await bot.sendMessage(ADMIN_ID,
      `🎉 <b>New ChatGPT Business Order</b>\n\n` +
      `🆔 Order: <b>#${orderId}</b>\n` +
      `👤 Customer: ${escapeHtml(name)} (<code>${userId}</code>)\n` +
      `📧 Email: <code>${escapeHtml(sessionData.email)}</code>\n` +
      `⏱ Duration: <b>${totalDays} days</b>\n` +
      `📅 Start date: <b>${sessionData.startDate}</b>\n` +
      `📅 End date: <b>${sessionData.endDate}</b>\n` +
      `💵 Paid: <b>$${sessionData.finalPrice.toFixed(2)}</b>\n` +
      `💳 Method: <b>${payMethodLabel}</b>\n` +
      `🔗 TxID: <code>${escapeHtml(txid)}</code>\n\n` +
      `⬇️ Press the button below to notify the customer once you activate their subscription:`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{
            text: '✅ Notify Customer — Subscription Activated',
            callback_data: `cgb_notify_${orderId}_${userId}_${totalDays}_${encodeURIComponent(sessionData.endDate)}`,
          }]],
        },
      }
    );
  } catch (e) {}
}

// ════════════════════════════════════════════════════════════════
// CRYPTOBOT PAYMENT CONFIRMED (called from the webhook — no live
// in-memory session exists at this point, so everything is read
// fresh from the DB instead of from `sessionData` like confirmPayment).
// ════════════════════════════════════════════════════════════════
async function confirmCryptobotPayment(invoiceId, paidAmount, orderId, userId) {
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  if (!order) {
    logger.warn(`confirmCryptobotPayment: order #${orderId} not found (invoice ${invoiceId})`);
    return false;
  }
  if (Number(order.user_id) !== Number(userId)) {
    logger.warn(`confirmCryptobotPayment: order #${orderId} user mismatch (expected ${order.user_id}, got ${userId})`);
    return false;
  }
  if (order.status !== 'pending') {
    // Already confirmed (or cancelled) — avoid double notifications on webhook retries
    logger.info(`confirmCryptobotPayment: order #${orderId} already ${order.status} — skipping`);
    return true;
  }

  const sub = queries.getCgbSubscriptionByOrder(orderId);
  if (!sub) {
    logger.error(`confirmCryptobotPayment: no chatgpt_subscriptions row for order #${orderId}`);
    return false;
  }

  // Mark order as paid (payment_proof = invoice id, since there's no typed TxID for CryptoBot)
  try {
    db.prepare(`UPDATE orders SET status='paid', payment_proof=? WHERE id=?`).run(String(invoiceId), orderId);
  } catch (e) {
    logger.error(`confirmCryptobotPayment: failed to mark order #${orderId} paid: ${e.message}`);
  }

  const totalDays = sub.days_remaining + (sub.extra_month ? 30 : 0);

  // Notify customer
  try {
    await bot.sendMessage(userId,
      `✅ <b>Payment Confirmed!</b>\n\n` +
      `📦 Order #${orderId}\n` +
      `📧 Email: ${escapeHtml(sub.email)}\n` +
      `📅 Subscription until: ${sub.end_date}\n` +
      `💰 Paid: $${Number(paidAmount).toFixed(2)}\n\n` +
      `📞 <b>Please contact support to activate your subscription:</b>\n` +
      (SUPPORT_BOT_USERNAME ? `👉 https://t.me/${SUPPORT_BOT_USERNAME}` : '👉 Contact admin') +
      `\n\nYour subscription will be active once support confirms.`,
      {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [
          ...(SUPPORT_BOT_USERNAME ? [[{ text: '📞 Contact Support', url: `https://t.me/${SUPPORT_BOT_USERNAME}` }]] : []),
          [{ text: '🔄 New Order', callback_data: 'cancel' }],
        ] },
      }
    );
  } catch (e) {
    logger.warn(`confirmCryptobotPayment: could not message customer ${userId}: ${e.message}`);
  }

  // Notify admin (same shape as confirmPayment, so both flows look identical to the admin)
  try {
    const user = db.prepare('SELECT username, first_name FROM users WHERE telegram_id=?').get(userId);
    const name = user?.username ? '@' + user.username : (user?.first_name || `User ${userId}`);

    await bot.sendMessage(ADMIN_ID,
      `🎉 <b>New ChatGPT Business Order</b>\n\n` +
      `🆔 Order: <b>#${orderId}</b>\n` +
      `👤 Customer: ${escapeHtml(name)} (<code>${userId}</code>)\n` +
      `📧 Email: <code>${escapeHtml(sub.email)}</code>\n` +
      `⏱ Duration: <b>${totalDays} days</b>\n` +
      `📅 Start date: <b>${sub.start_date}</b>\n` +
      `📅 End date: <b>${sub.end_date}</b>\n` +
      `💵 Paid: <b>$${Number(paidAmount).toFixed(2)}</b>\n` +
      `💳 Method: <b>🤖 CryptoBot</b>\n` +
      `🔗 Invoice: <code>${escapeHtml(String(invoiceId))}</code>\n\n` +
      `⬇️ Press the button below to notify the customer once you activate their subscription:`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{
            text: '✅ Notify Customer — Subscription Activated',
            callback_data: `cgb_notify_${orderId}_${userId}_${totalDays}_${encodeURIComponent(sub.end_date)}`,
          }]],
        },
      }
    );
  } catch (e) {
    logger.warn(`confirmCryptobotPayment: could not notify admin: ${e.message}`);
  }

  return true;
}

bot.on('polling_error', e => logger.error(`CGB polling: ${e.message}`));

module.exports = { bot, confirmCryptobotPayment };
