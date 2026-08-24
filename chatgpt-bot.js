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

/**
 * Wallet balance from the shared users table.
 *
 * Read fresh every time rather than cached in the session: the customer can top
 * up in the main bot while this one is sitting on the summary screen, and a
 * stale figure would either hide money they have or offer money they spent.
 */
function getBalance(userId) {
  try {
    const row = db.prepare('SELECT balance FROM users WHERE telegram_id = ?').get(userId);
    return Number(row?.balance) || 0;
  } catch (e) {
    return 0;
  }
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

/**
 * Admin order card, in one of two states.
 *
 * Both states used to open with a green ✅ — the pending button read
 * "✅ Notify Customer" and the finished one "✅ Customer Notified" — and the
 * message body never changed at all, only the button. Two orders side by side
 * were impossible to tell apart at a glance.
 *
 * Now the whole card is banded: a solid red bar top and bottom while the seat
 * is still waiting, solid green once it is activated. The band is the first and
 * last thing on screen, so it reads correctly even when the card is half
 * scrolled off.
 */
const BAND_RED   = '🟥🟥🟥🟥🟥🟥🟥🟥🟥🟥🟥🟥';
const BAND_GREEN = '🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩';

function orderCard(d, activated = false) {
  const band = activated ? BAND_GREEN : BAND_RED;
  const head = activated
    ? '🟢 <b>ACTIVATED</b> — customer notified'
    : '🔴 <b>NOT ACTIVATED YET</b> — action needed';

  return (
    `${band}\n` +
    `${head}\n\n` +
    `🆔 Order: <b>#${d.orderId}</b>\n` +
    `👤 Customer: ${d.name} (<code>${d.userId}</code>)\n` +
    `📧 Email: <code>${d.email}</code>\n` +
    `⏱ Duration: <b>${d.days} days</b>\n` +
    `📅 Start date: <b>${d.startDate}</b>\n` +
    `📅 End date: <b>${d.endDate}</b>\n` +
    `💵 Paid: <b>$${d.paid}</b>\n` +
    `💳 Method: <b>${d.method}</b>\n` +
    `🔗 ${d.refLabel}: <code>${d.ref}</code>\n\n` +
    (activated
      ? `✅ <i>Activated on ${d.activatedAt || 'now'}. The customer has been told.</i>\n`
      : `⬇️ <b>Activate the seat, then press the button below.</b>\n`) +
    `${band}`
  );
}

function orderCardButtons(d) {
  return {
    inline_keyboard: [[{
      // No green tick here on purpose — a checkmark on the pending button is
      // exactly what made the two states look alike.
      text: '🔔 Activate & Notify Customer',
      callback_data: `cgb_notify_${d.orderId}_${d.userId}_${d.days}_${encodeURIComponent(d.endDate)}`,
    }]],
  };
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

      // Repaint the WHOLE card green, not just the button. Editing only the
      // markup left the red band and "NOT ACTIVATED YET" in place, which is
      // what made finished and pending orders look identical in the scrollback.
      //
      // Rebuilt from the database rather than by parsing the old message text:
      // q.message.text arrives with HTML already decoded, so re-escaping it by
      // hand would mangle any address containing & or <.
      try {
        const sub = db.prepare(
          'SELECT * FROM chatgpt_subscriptions WHERE order_id = ?'
        ).get(parseInt(orderId, 10));
        const ord = db.prepare('SELECT * FROM orders WHERE id = ?').get(parseInt(orderId, 10));
        const u   = db.prepare(
          'SELECT username, first_name FROM users WHERE telegram_id = ?'
        ).get(Number(customerId));
        const who = u?.username ? '@' + u.username : (u?.first_name || `User ${customerId}`);

        const p2 = (n) => String(n).padStart(2, '0');
        const now = new Date();

        const greenCard = orderCard({
          orderId,
          userId:    customerId,
          days,
          name:      escapeHtml(who),
          email:     escapeHtml(sub?.email || '—'),
          startDate: sub?.start_date || '—',
          endDate:   endDate,
          paid:      Number(sub?.final_price ?? ord?.total_price ?? 0).toFixed(2),
          method:    ord?.payment_method || '—',
          refLabel:  'Order',
          ref:       String(orderId),
          activatedAt: `${p2(now.getDate())}/${p2(now.getMonth() + 1)} ${p2(now.getHours())}:${p2(now.getMinutes())}`,
        }, true);

        await bot.editMessageText(greenCard, {
          chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: '✅ Done — customer notified', callback_data: 'noop' }]] },
        });
      } catch (e) {
        // Never leave the card looking untouched: if the repaint fails for any
        // reason, at least flip the button so the state is still readable.
        logger.warn(`cgb_notify_: card repaint failed: ${e.message}`);
        await bot.editMessageReplyMarkup(
          { inline_keyboard: [[{ text: '✅ Done — customer notified', callback_data: 'noop' }]] },
          { chat_id: chatId, message_id: msgId }
        ).catch(() => {});
      }
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

  // Balance shown but too small — explain instead of silently doing nothing.
  if (data === 'balance_short') {
    const s = getSession(userId);
    const bal = getBalance(userId);
    const need = s?.finalPrice || 0;
    await bot.sendMessage(chatId,
      `👛 <b>Not enough balance</b>\n\n` +
      `Your balance: <b>$${bal.toFixed(2)}</b>\n` +
      `Order total: <b>$${need.toFixed(2)}</b>\n` +
      `Short by: <b>$${Math.max(0, need - bal).toFixed(2)}</b>\n\n` +
      `Top up in the main store bot, or pay the full amount with one of the crypto methods above.`,
      { parse_mode: 'HTML' });
    return;
  }

  // ── Pay with wallet balance ────────────────────────────────────────────────
  // Same wallet as the main store: both bots share one database and one users
  // row, so credit earned or topped up there is spendable here.
  if (data === 'pay_balance') {
    const s = getSession(userId);
    if (!s || s.state !== 'CONFIRM_ORDER') {
      await bot.sendMessage(chatId, '⏰ Session expired. Use /start to begin again.');
      return;
    }

    if (isOutOfStock()) {
      await bot.sendMessage(chatId, '😔 Sorry, seats just sold out. Nothing was charged.');
      clearSession(userId);
      return;
    }

    let orderId = null;
    try {
      let cgbProductId = 0;
      try {
        const p = db.prepare(`SELECT id FROM products WHERE is_chatgpt_business=1 LIMIT 1`).get();
        if (p) cgbProductId = p.id;
      } catch (e) {}

      // Order first, so the transaction row can point at it and support has
      // something to look up if the charge fails halfway.
      const orderResult = db.prepare(`
        INSERT INTO orders (user_id, product_id, quantity, total_price, payment_method, status, email)
        VALUES (?, ?, 1, ?, 'balance', 'pending', ?)
      `).run(userId, cgbProductId, s.finalPrice, s.email);
      orderId = orderResult.lastInsertRowid;

      // Atomic: balance check, debit and ledger entry in one DB transaction, so
      // the same dollar cannot also be spent in the main bot mid-purchase.
      const charge = queries.chargeWallet(userId, s.finalPrice, {
        type:        'purchase',
        description: `ChatGPT Business seat — order #${orderId}`,
        orderId,
      });

      if (!charge.ok) {
        db.prepare(`UPDATE orders SET status='cancelled' WHERE id=?`).run(orderId);
        await bot.sendMessage(chatId,
          `❌ <b>Payment failed</b>\n\n` +
          (charge.reason === 'no_account'
            ? 'No wallet found for your account. Open the main store bot once, then try again.'
            : `Your balance: <b>$${charge.balance.toFixed(2)}</b>\n` +
              `Order total: <b>$${s.finalPrice.toFixed(2)}</b>\n\n` +
              `Nothing was charged. Top up in the main store bot, or pay with crypto.`),
          { parse_mode: 'HTML' });
        return;
      }

      try {
        queries.createCgbSubscription(
          orderId, userId, s.email, s.startDate, s.endDate,
          s.daysRemaining + (s.extraMonth ? 30 : 0),
          s.basePrice, s.extraMonth ? 1 : 0, s.finalPrice
        );
      } catch (subErr) {
        logger.error('createCgbSubscription failed: ' + subErr.message);
      }

      const paid = {
        ...s,
        orderId,
        paymentMethod: 'pay_balance',
        endDate:       s.endDate      || 'N/A',
        startDate:     s.startDate    || new Date().toISOString().slice(0, 10),
        daysRemaining: s.daysRemaining || 0,
        extraMonth:    s.extraMonth   || false,
        finalPrice:    s.finalPrice   || 0,
      };
      // The wallet reference doubles as the receipt line, so the admin card
      // shows the remaining balance instead of an empty TxID field.
      await confirmPayment(chatId, userId, orderId, `wallet · $${charge.balance.toFixed(2)} left`, paid);
    } catch (e) {
      logger.error('Balance payment error: ' + e.message);
      if (orderId) {
        try { db.prepare(`UPDATE orders SET status='cancelled' WHERE id=?`).run(orderId); } catch (_) {}
      }
      await bot.sendMessage(chatId,
        `❌ Error processing payment: ${e.message}\n\nIf money left your balance, contact support with order #${orderId || '—'}.`,
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

    // The wallet is the same one the main bot tops up — same database, same
    // users row — so a customer with credit there can spend it here instead of
    // being sent off to make another crypto transfer.
    const balance = getBalance(userId);
    // Compare in whole cents. Two figures that print the same must behave the
    // same — a float comparison would reject $5.00 against a total stored as
    // 4.999999999.
    const canPayWithBalance =
      Math.round(balance * 100) >= Math.round(s.finalPrice * 100);

    // Show order summary
    const txt =
      `📋 <b>Order Summary</b>\n\n` +
      `📦 ChatGPT Business Seat\n` +
      `📧 Email: <code>${escapeHtml(text)}</code>\n` +
      `📅 From: ${s.startDate}\n` +
      `📅 To: ${s.endDate}\n` +
      `⏳ Duration: ${s.daysRemaining + (s.extraMonth ? 30 : 0)} days\n` +
      `💰 <b>Total: $${s.finalPrice.toFixed(2)}</b>\n` +
      `👛 Your balance: <b>$${balance.toFixed(2)}</b>\n\n` +
      `Select payment method:`;

    const rows = [];
    if (canPayWithBalance) {
      // Instant and no TxID to paste, so it goes first.
      rows.push([{ text: `👛 Pay with Balance ($${balance.toFixed(2)})`, callback_data: 'pay_balance' }]);
    } else if (balance > 0) {
      // Shown but disabled rather than hidden: a customer who knows they have
      // credit would otherwise think the bot lost it.
      rows.push([{ text: `👛 Balance $${balance.toFixed(2)} — not enough`, callback_data: 'balance_short' }]);
    }
    rows.push(
      [{ text: '💳 Pay with Binance Pay', callback_data: 'pay_binance' }],
      [{ text: '💎 USDT BEP20', callback_data: 'pay_bep20' }, { text: '💎 USDT TRC20', callback_data: 'pay_trc20' }],
      [{ text: '🤖 CryptoBot', callback_data: 'pay_cryptobot' }],
      [{ text: '✏️ Change Email', callback_data: 'change_email' }],
      [{ text: '❌ Cancel', callback_data: 'cancel' }],
    );

    await bot.sendMessage(chatId, txt, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: rows },
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
        // The asset must be USDT before the amount means anything. Without this
        // a sender could transfer 14.94 BTTC — worth a fraction of a cent — and
        // the amount check below would happily match it against a $14.94 price.
        // services/binance.js now rejects non-USDT too; this is the second layer.
        if (String(result.currency || '').toUpperCase() !== 'USDT') {
          await bot.sendMessage(chatId,
            `❌ <b>Wrong currency.</b>\n\n` +
            `That transfer was <b>${escapeHtml(String(result.currency || 'unknown'))}</b>, ` +
            `but only <b>USDT</b> is accepted.`,
            { parse_mode: 'HTML' });
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
      pay_balance:  '👛 Wallet Balance',
    }[paymentMethod] || paymentMethod;

    const card = {
      orderId, userId, days: totalDays,
      name:      escapeHtml(name),
      email:     escapeHtml(sessionData.email),
      startDate: sessionData.startDate,
      endDate:   sessionData.endDate,
      paid:      sessionData.finalPrice.toFixed(2),
      method:    payMethodLabel,
      // A wallet payment has no TxID; the field carries the receipt line instead.
      refLabel:  paymentMethod === 'pay_balance' ? 'Wallet' : 'TxID',
      ref:       escapeHtml(txid),
    };
    await bot.sendMessage(ADMIN_ID, orderCard(card, false), {
      parse_mode: 'HTML',
      reply_markup: orderCardButtons(card),
    });
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

    const card = {
      orderId, userId, days: totalDays,
      name:      escapeHtml(name),
      email:     escapeHtml(sub.email),
      startDate: sub.start_date,
      endDate:   sub.end_date,
      paid:      Number(paidAmount).toFixed(2),
      method:    '🤖 CryptoBot',
      refLabel:  'Invoice',
      ref:       escapeHtml(String(invoiceId)),
    };
    await bot.sendMessage(ADMIN_ID, orderCard(card, false), {
      parse_mode: 'HTML',
      reply_markup: orderCardButtons(card),
    });
  } catch (e) {
    logger.warn(`confirmCryptobotPayment: could not notify admin: ${e.message}`);
  }

  return true;
}

bot.on('polling_error', e => logger.error(`CGB polling: ${e.message}`));

module.exports = { bot, confirmCryptobotPayment };
