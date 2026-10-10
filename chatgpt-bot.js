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
const cgbGuard = require('./services/cgbGuard');

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
const cgbSeatDates = require('./services/cgbSeatDates');
const cgbCycles = require('./services/cgbCycles');
const cgbSeatTools = require('./services/cgbSeatTools');

const bot = new TelegramBot(CHATGPT_BOT_TOKEN, { polling: true });
require('./utils/emojiLayer').installEmojiLayer(bot, 'cgb');
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

/**
 * The calendar day as written on the Date, never shifted.
 *
 * toISOString() converts to UTC first. Cycle dates are wall-clock midnights,
 * so on a server whose TZ is not UTC (TZ=Africa/Tunis, say) "26 Sep 00:00"
 * came out as "2026-09-25" — a seat bought between cycles was recorded as
 * starting today instead of on the cycle's start day.
 */
function formatDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
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
// Paid ahead of the cycle it belongs to. Red would say "act now" about a seat
// that must NOT be touched yet, and green would say "done" about one that still
// needs activating — neither is true, so it gets its own colour.
const BAND_BLUE  = '🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦';
// Cancelled/refunded: neither "do this" (red) nor "done" (green).
const BAND_GREY  = '⬛⬛⬛⬛⬛⬛⬛⬛⬛⬛⬛⬛';

/**
 * @param {object} d
 * @param {boolean} activated
 * @param {boolean} scheduled paid early — activate when the cycle opens
 */
function orderCard(d, activated = false, scheduled = false, cancelNote = null) {
  // V156.7: a paid RENEWAL is blue until it is activated (then green), like a seat paid early.
  const band = cancelNote ? BAND_GREY : activated ? BAND_GREEN : ((scheduled || d.renewal) ? BAND_BLUE : BAND_RED);
  const head = cancelNote
    ? '⚫ <b>CANCELLED</b> — no seat to activate'
    : activated
    ? '🟢 <b>ACTIVATED</b> — customer notified'
    : d.renewal
      ? `🔵 <b>RENEWAL PAID</b> — activate it on <b>${d.startDate}</b>`
    : scheduled
      ? '🔵 <b>PAID EARLY</b> — activate when the new cycle starts'
      : '🔴 <b>NOT ACTIVATED YET</b> — action needed';

  return (
    `${band}\n` +
    `${head}\n\n` +
    `🆔 Order: <b>#${d.orderId}</b>\n` +
    `👤 Customer: ${d.name} (<code>${d.userId}</code>)\n` +
    `📧 Email: <code>${d.email}</code>\n` +
    (d.kind ? `${d.kind}\n` : '') +
    ((d.panel || d.cycle) ? `🖥 Panel: <b>${d.panel || '—'}</b>${d.cycle ? ` · 🗓 ${d.cycle}` : ''}\n` : '') +
    `⏱ Duration: <b>${d.days} days</b>\n` +
    `📅 Start date: <b>${d.startDate}</b>\n` +
    `📅 End date: <b>${d.endDate}</b>\n` +
    `💵 Paid: <b>$${d.paid}</b>\n` +
    `💳 Method: <b>${d.method}</b>\n` +
    `🔗 ${d.refLabel}: <code>${d.ref}</code>\n\n` +
    (cancelNote
      ? `${cancelNote}\n`
      : activated
      ? `✅ <i>Activated${d.activatedAt ? ' on ' + d.activatedAt : ''}. The customer has been told.</i>\n` +
        (d.editedNote ? `✏️ <i>${d.editedNote}</i>\n` : '')
      : scheduled
        ? `🗓 <i>This seat starts on ${d.startDate} — its period has not opened yet. Activate it on that ` +
          `date: pressing the button now tells them it is live before it is.</i>\n`
        : `⬇️ <b>Activate the seat, then press the button below.</b>\n`) +
    `${band}`
  );
}

/** Where a seat is (V156.7): its panel's name and its cycle. Active seats use the workspace they were activated in. */
function seatPlace(sub) {
  let panel = '';
  if (sub && sub.id && cgbGuard.seatPanelOf(sub.id)) panel = cgbGuard.panelNameCached(cgbGuard.seatPanelOf(sub.id));   // V157
  if (!panel && sub && sub.status === 'active' && sub.workspace) panel = sub.workspace;
  if (!panel && sub) {
    try { panel = cgbGuard.panelNameCached(cgbGuard.panelForSub(sub)); } catch (_) {}
  }
  if (!panel && sub) { try { panel = require('./services/cgbRouting').placeholderFor(sub.end_date); } catch (_) {} }   // V157.2: its cycle's name
  if (!panel && sub && sub.prev_workspace) panel = sub.prev_workspace;
  return { panel: escapeHtml(panel || ''), cycle: cgbSeatTools.cycleLabel(db, sub && sub.end_date) };
}

/** "🔄 Renewal of …" / "🆕 New seat" for the order card (V156.3). */
function seatKindLine(renewedFromId) {
  if (!renewedFromId) return '🆕 <b>New seat</b>';
  try {
    const prev = queries.getCgbSubById(renewedFromId);
    if (!prev) return '🔄 <b>Renewal</b>';
    return `🔄 <b>Renewal</b> of <code>${escapeHtml(prev.email || '')}</code> (ended ${escapeHtml(String(prev.end_date || '?'))})`;
  } catch (_) { return ''; }
}

function orderCardButtons(d) {
  return {
    inline_keyboard: [[{
      // No green tick here on purpose — a checkmark on the pending button is
      // exactly what made the two states look alike.
      text: '🔔 Activate & Notify Customer',
      callback_data: `cgb_notify_${d.orderId}_${d.userId}_${d.days}_${encodeURIComponent(d.endDate)}`,
    }], [
      // For a customer who asks for a refund before the seat is activated.
      // Opens a confirm step (refund to wallet / refunded outside) — never
      // cancels on a single tap.
      { text: '❌ Cancel order', callback_data: `cgb_ocx_ask_${d.orderId}` },
    ], [
      // A paid seat whose dates are wrong (e.g. a renewal quoted on the wrong cycle).
      { text: '✏️ Change dates', callback_data: `cgb_dates_${d.orderId}` },
      { text: '🖥 Change panel', callback_data: `cgb_cp_${d.orderId}` },
    ]],
  };
}

const getMonthlyPrice = (userId = null) => cgbCycles.getMonthlyPrice(userId);

// ════════════════════════════════════════════════════════════════
// CORE LOGIC: Calculate best billing cycle for today
// ════════════════════════════════════════════════════════════════
// Both the customer bot and the admin panel now call the SAME cycle maths, so
// the panel can never show one cycle while the bot quotes another.
const calculateBestCycle = () => cgbCycles.calculateBestCycle();

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

  // Per-customer rate when one is set, otherwise the shop rate.
  const monthlyPrice = getMonthlyPrice(userId);
  // Split over the cycle's real length, so a full cycle costs exactly the
  // monthly price. The extra month is the NEXT whole cycle, not a flat 30 days.
  const basePrice = cgbCycles.pricePeriod(best, monthlyPrice);
  const extra = cgbCycles.oneMoreCycle(best);
  const finalPrice = extraMonth ? Number((basePrice + monthlyPrice).toFixed(2)) : basePrice;
  const endDate = extraMonth ? extra.endDate : best.endDate;
  // A purchase between two cycles starts on the next start day, not today.
  const startDate = best.startDate || new Date();

  const upcoming = calculateNextCycleStarts();
  const upcomingTxt = upcoming.slice(0, 3).map(u =>
    `   • Day ${u.day} (in ${u.daysAway} day${u.daysAway === 1 ? '' : 's'})`
  ).join('\n');

  const today = new Date();
  const totalDays = extraMonth ? best.daysRemaining + extra.days : best.daysRemaining;

  const txt =
    `👋 <b>ChatGPT Business Subscription</b>\n\n` +
    `📦 <b>Product:</b> ChatGPT Business Seat\n` +
    (best.inGap
      ? `📅 <b>Subscription starts:</b> ${formatDisplayDate(startDate)} <i>(start of the next cycle)</i>\n`
      : `📅 <b>Starts:</b> today, ${formatDisplayDate(today)}\n`) +
    `📅 <b>Subscription ends:</b> ${formatDisplayDate(endDate)}\n` +
    `⏳ <b>Days you'll get:</b> ${totalDays} day${totalDays === 1 ? '' : 's'}\n` +
    `💰 <b>Price:</b> $${finalPrice.toFixed(2)}\n\n` +
    (extraMonth ? '✅ Full month added!\n\n' : '') +
    // Only shown when waiting would actually get them more.
    //
    // It used to print unconditionally, so a customer already being offered a
    // full 30 days was told to "wait for a full month" — advice to delay a
    // purchase that needs no delaying, on the screen where they were about to
    // buy. 28 rather than 30, because a day or two short is not worth waiting
    // a month for either.
    // Measured against the cycle's own length: February's cycle is 27 days,
    // and a fixed 28 would tell someone buying all of it to wait for more.
    (best.daysRemaining >= (best.cycleLength || 30) - 2 || extraMonth
      ? ''
      : `💡 <i>For a full month at $${monthlyPrice}, wait for one of these dates:</i>\n${upcomingTxt}`);

  setSession(userId, 'AWAITING_ACTION', {
    daysRemaining: best.daysRemaining,
    extraMonth,
    extraDays: extra.days,
    basePrice,
    finalPrice,
    startDate: formatDate(startDate),
    endDate: formatDate(endDate),
    monthlyPrice,
  });

  // Buy first, then the optional extra, then the ways out.
  //
  // Telegram gives no button colours, so order and weight are what remain: the
  // action the customer came for goes on top with the price on it, and Support
  // and Cancel share the last row instead of each taking a full-width row that
  // makes leaving look as important as buying.
  const buttons = [
    [{ text: `🛒  Order Now — $${finalPrice.toFixed(2)}`, callback_data: 'order_now' }],
  ];

  buttons.push(extraMonth
    ? [{ text: '➖  Remove extra month', callback_data: 'remove_month' }]
    : [{ text: `➕  Add a full month  ·  +$${monthlyPrice}`, callback_data: 'add_month' }]);

  const lastRow = [];
  if (SUPPORT_BOT_USERNAME) {
    lastRow.push({ text: '💬 Support', url: `https://t.me/${SUPPORT_BOT_USERNAME}` });
  }
  lastRow.push({ text: '✖️ Cancel', callback_data: 'cancel' });
  buttons.push(lastRow);

  await bot.sendMessage(chatId, txt, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: buttons },
  });
}

// ════════════════════════════════════════════════════════════════
// RENEWALS — main menu, seat list, details card
// ════════════════════════════════════════════════════════════════

function workspaceName(sub) {
  if (sub && sub.workspace) return sub.workspace;
  try {
    const row = db.prepare(`SELECT value FROM settings WHERE key='cgb_workspace_name'`).get();
    return row?.value || 'chatgpt_Team';
  } catch (e) {
    return 'chatgpt_Team';
  }
}

/** Whole days left on a seat, never negative. */
function daysLeft(sub) {
  const end = new Date(`${sub.end_date}T00:00:00`);
  const now = new Date(); now.setHours(0, 0, 0, 0);
  return Math.max(0, Math.ceil((end - now) / 86400000));
}

function elapsedDays(sub) {
  const start = new Date(`${sub.start_date}T00:00:00`);
  const now = new Date(); now.setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((now - start) / 86400000));
}

async function showMainMenu(chatId, userId, messageId = null) {
  const subs = queries.getCgbSubsByUser(userId);
  const rows = [];

  // Every option is always shown. Hiding Renew when the list looks empty made
  // the bot appear unchanged to customers whose seat simply is not recorded
  // here yet — they had no way to even ask about it.
  rows.push([
    { text: '🔄 Renew my seat', callback_data: 'cgb_renew_list' },
    { text: '✨ Buy a new seat', callback_data: 'cgb_new' },
  ]);
  rows.push([{ text: '📋 My seats — details', callback_data: 'cgb_details_list' }]);
  if (String(userId) === String(ADMIN_ID)) rows.push([{ text: '🛠 Admin panel', callback_data: 'adm_home' }]);

  // V156: the seats themselves on the first screen — email, workspace, until when, days left.
  const today = ymdLocal(cgbCycles.localNow(new Date()));
  const seatLines = subs.slice(0, 8).map((sub) => {
    const left = sub.end_date ? Math.round((new Date(`${String(sub.end_date).slice(0, 10)}T00:00:00`) - new Date(`${today}T00:00:00`)) / 86400000) : null;
    const icon = sub.status === 'active' ? (left !== null && left <= 3 ? '🟠' : '🟢') : '⏳';
    const when = sub.status === 'active'
      ? `until <b>${escapeHtml(String(sub.end_date || '?'))}</b>${left !== null ? ` · ${left <= 0 ? 'ends today' : `${left} day${left === 1 ? '' : 's'} left`}` : ''}`
      : 'waiting for activation';
    return `${icon} <code>${escapeHtml(sub.email || '—')}</code>\n     🏢 ${escapeHtml(workspaceName(sub))} · ${when}`;
  });

  const txt =
    require('./services/notices').banner('cgb') +
    `🤖 <b>ChatGPT Business</b>\n━━━━━━━━━━━━━━━━━━\n` +
    (subs.length
      ? `<b>Your seat${subs.length === 1 ? '' : 's'}</b>\n${seatLines.join('\n')}` +
        (subs.length > 8 ? `\n… and ${subs.length - 8} more (📋 My seats)` : '') +
        `\n━━━━━━━━━━━━━━━━━━\nRenew a seat before it ends, or buy a new one:`
      : `You have no seat yet.\n━━━━━━━━━━━━━━━━━━\nTap <b>✨ Buy a new seat</b> to see the price for this cycle.`);

  const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } };
  if (messageId) {
    await bot.editMessageText(txt, { chat_id: chatId, message_id: messageId, ...opts }).catch(async () => {
      await bot.sendMessage(chatId, txt, opts);
    });
  } else {
    await bot.sendMessage(chatId, txt, opts);
  }
}

/**
 * The customer's seats as tappable rows.
 * @param {string} action 'renew' or 'details' — decides where a tap goes.
 */
async function showSubList(chatId, userId, action, messageId = null) {
  const subs = queries.getCgbSubsByUser(userId);
  if (!subs.length) {
    // A seat bought in the main store leaves no record in this bot, so "you
    // have none" would be wrong as often as it is right. Say what is actually
    // known and give the customer a way forward.
    await bot.sendMessage(chatId,
      `📭 <b>No subscriptions found on this account</b>\n\n` +
      `If you bought a seat here, it will appear once it is activated.\n` +
      `If you bought it somewhere else in the shop, contact support with your ` +
      `email and it will be added.`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [
        [{ text: '✨ Buy a seat', callback_data: 'cgb_new' }],
        [{ text: '🔙 Menu', callback_data: 'cgb_menu' }],
      ] } });
    return;
  }

  const rows = subs.map((s) => {
    const d = daysLeft(s);
    // The tick/hourglass is the whole point of this list: at a glance the
    // customer sees which seat is about to lapse.
    const mark = d <= 2 ? '⏳' : '✅';
    return [{ text: `${mark} ${s.email} — ${d}d left`, callback_data: `cgb_${action}_${s.id}` }];
  });
  rows.push([{ text: '🔙 Back', callback_data: 'cgb_menu' }]);

  const txt = action === 'renew'
    ? `🔄 <b>Renew</b>\n\nSelect the email you want to renew from the list below:`
    : `📋 <b>Details</b>\n\nSelect an email to see its subscription:`;

  const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } };
  if (messageId) {
    await bot.editMessageText(txt, { chat_id: chatId, message_id: messageId, ...opts }).catch(async () => {
      await bot.sendMessage(chatId, txt, opts);
    });
  } else {
    await bot.sendMessage(chatId, txt, opts);
  }
}

/** Full card for one seat: plan, period, status and next-cycle decision. */
async function showSubDetails(chatId, subId, messageId = null) {
  const s = queries.getCgbSubById(subId);
  if (!s) { await bot.sendMessage(chatId, '❌ Subscription not found.'); return; }

  const d  = daysLeft(s);
  const ws = workspaceName(s);

  const nextLine = s.renew_intent === 'yes'
    ? '🟡 <b>Renewal started — payment required</b>'
    : s.renew_intent === 'no'
      ? '🚫 You chose <b>not</b> to renew'
      : 'Not reserved for next cycle yet';

  const txt =
    `📧 <b>Email</b>\n<code>${escapeHtml(s.email || '')}</code>\n\n` +
    `📚 <b>Subscription</b>\n` +
    `🎫 Plan: ChatGPT Business Seat\n` +
    `🏢 Workspace: ${escapeHtml(ws)}\n` +
    `💳 Amount: $${Number(s.final_price).toFixed(2)}\n` +
    `⏳ Elapsed days: ${elapsedDays(s)}\n` +
    `📅 Period: ${s.start_date} → ${s.end_date}\n\n` +
    `📍 <b>Current status</b>\n` +
    `${d > 0 ? '🟢' : '🔴'} ${d > 0 ? `Active in ${escapeHtml(ws)}` : 'Expired'}\n` +
    `⌛️ Remaining: ${d} day(s)\n\n` +
    `🔁 <b>Next cycle</b>\n${nextLine}\n\n` +
    (s.renew_intent === 'yes'
      ? `⚠️ <i>Your seat is not secured until the renewal is paid. Tap Renew &amp; pay to finish.</i>`
      : `👇 Tap <b>Renew &amp; pay</b> to keep this email for the next cycle.`);

  const rows = [];
  // Renew stays available even after the intent is set: the intent is not a
  // payment, and this is the button that leads to one.
  rows.push([{ text: '🔄 Renew & pay', callback_data: `cgb_renewyes_${s.id}` }]);
  if (s.renew_intent !== 'no') rows.push([{ text: '❌ Will not renew', callback_data: `cgb_renewno_${s.id}` }]);
  rows.push([{ text: '📧 Request an email change', callback_data: `cgb_ereq_${s.id}` }]);
  rows.push([{ text: '🔙 Back', callback_data: 'cgb_menu' }]);

  const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } };
  if (messageId) {
    await bot.editMessageText(txt, { chat_id: chatId, message_id: messageId, ...opts }).catch(async () => {
      await bot.sendMessage(chatId, txt, opts);
    });
  } else {
    await bot.sendMessage(chatId, txt, opts);
  }
}


// ════════════════════════════════════════════════════════════════
// RENEWAL: choose a duration, then pay
// ════════════════════════════════════════════════════════════════

/**
 * Every month from 1 to 12.
 *
 * The first version offered 1, 2, 3, 6 and 12 — the durations a shop finds
 * tidy. But a customer whose other subscriptions renew in July wants 7 months,
 * and offering only 6 or 12 asks them to either waste a month or come back
 * early. There is no cost to allowing all twelve, so there is no reason not to.
 */
const RENEW_MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);

/**
 * Price a renewal of `months` whole months.
 *
 * A renewal starts where the current seat ends, NOT today — that is what makes
 * it a renewal rather than a second purchase. Buying 3 months while 11 days
 * remain must give 11 + 90 days on the same email, not 90 days that quietly
 * discard what was already paid for.
 */
function priceRenewal(sub, months) {
  // Dates and price come from ONE place (cgbCycles.quoteRenewal): in the customer's own cycle.
  return cgbCycles.quoteRenewal(sub, months);
}

/**
 * Bulk discount for a duration, editable from the admin panel.
 *
 * Read as THRESHOLDS, not exact matches: "3:5,6:10,12:15" means 3 months or
 * more gets 5%, 6 or more gets 10%, 12 gets 15%. Exact matching would give 7
 * months a 0% discount while 6 months got 10% — making the longer commitment
 * cost more, which no customer would accept and no shop intends.
 */
function renewDiscountFor(months) {
  return cgbCycles.renewDiscountFor(months);
}


/** V156.7: outside the renewal window (one day before the seat ends → its cycle's start date). */
async function renewalClosed(chatId, sub) {
  const q = priceRenewal(sub, 1);
  if (q.kind === 'notyet') {
    await bot.sendMessage(chatId,
      `🕒 <b>Renewal opens soon</b>\n\n` +
      `📧 <code>${escapeHtml(sub.email || '')}</code> ends on <b>${escapeHtml(String(sub.end_date))}</b>.\n` +
      `You can renew it from <b>${formatDate(q.opensOn)}</b> until <b>${formatDate(q.closedOn)}</b>.`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'cgb_menu' }]] } });
    return true;
  }
  if (q.kind !== 'closed') return false;
  await bot.sendMessage(chatId,
    `⏰ <b>Renewal is closed for this seat</b>\n\n` +
    `📧 <code>${escapeHtml(sub.email || '')}</code> ended on <b>${escapeHtml(String(sub.end_date))}</b>.\n` +
    `It could be renewed until <b>${formatDate(q.closedOn)}</b>.\n\n` +
    `• To keep <b>this email</b>, ask the admin: if he agrees you pay only the days left in its cycle.\n` +
    `• Or buy a new seat.`,
    { parse_mode: 'HTML', reply_markup: { inline_keyboard: [
      [{ text: '📨 Ask to renew this email', callback_data: `cgb_lreq_${sub.id}` }],
      [{ text: '✨ Buy a new seat', callback_data: 'cgb_new' }], [{ text: '🔙 Back', callback_data: 'cgb_menu' }]] } });
  return true;
}

// ════════════════════════════════════════════════════════════════
// V156.9: ⏰ LATE RENEWALS — after the window: ask → admin agrees → pay the days left
// ════════════════════════════════════════════════════════════════
function ensureLateTable() {
  db.exec(`CREATE TABLE IF NOT EXISTS cgb_late_renewals (
    id INTEGER PRIMARY KEY AUTOINCREMENT, sub_id INTEGER NOT NULL, user_id INTEGER NOT NULL, email TEXT,
    status TEXT NOT NULL DEFAULT 'pending', created_at TEXT DEFAULT (datetime('now')), decided_at TEXT)`);
}
function pendingLateRenewals() {
  ensureLateTable();
  return db.prepare(`SELECT r.*, u.username FROM cgb_late_renewals r LEFT JOIN users u ON u.telegram_id = r.user_id
                      WHERE r.status = 'pending' ORDER BY r.id`).all();
}
function lateCard(r, sub, who) {
  const lq = cgbCycles.lateRenewalQuote(sub);
  const pl = seatPlace(sub);
  return `⏰ <b>Late renewal request #${r.id}</b>\n\n` +
    `👤 ${escapeHtml(who)} (<code>${r.user_id}</code>)\n📧 <code>${escapeHtml(sub.email || '')}</code>\n` +
    `🖥 ${pl.panel || '—'}${pl.cycle ? ` · 🗓 ${pl.cycle}` : ''}\n📅 Ended <b>${escapeHtml(String(sub.end_date))}</b> — the renewal window is closed\n\n` +
    (lq ? `If you agree he pays the days left: <b>${formatDate(lq.from)} → ${formatDate(lq.to)}</b> · ${lq.days} day(s) · <b>$${lq.price.toFixed(2)}</b>`
        : 'No cycle configured — cannot price it.');
}

async function startLateRequest(chatId, userId, subId) {
  const sub = queries.getCgbSubById(subId);
  if (!sub || String(sub.user_id) !== String(userId)) { await bot.sendMessage(chatId, '❌ That seat is not yours.'); return; }
  if (priceRenewal(sub, 1).kind !== 'closed') { await showRenewDurations(chatId, userId, subId); return; }   // still renewable normally
  ensureLateTable();
  const open = db.prepare(`SELECT id, status FROM cgb_late_renewals WHERE sub_id = ? AND status IN ('pending','approved')`).get(sub.id);
  if (open) {
    if (open.status === 'approved') { await showLatePayment(chatId, userId, open.id); return; }
    await bot.sendMessage(chatId, 'ℹ️ Your request was already sent — you will get a message when the admin answers.');
    return;
  }
  const id = db.prepare('INSERT INTO cgb_late_renewals (sub_id, user_id, email) VALUES (?, ?, ?)').run(sub.id, userId, sub.email || '').lastInsertRowid;
  await bot.sendMessage(chatId, `✅ <b>Request sent</b>\n\nThe admin will answer about <code>${escapeHtml(sub.email || '')}</code>. If he agrees, you get a payment button for the days left.`, { parse_mode: 'HTML' });
  if (!ADMIN_ID) return;
  const u = db.prepare('SELECT username, first_name FROM users WHERE telegram_id = ?').get(Number(userId));
  const who = u?.username ? '@' + u.username : (u?.first_name || String(userId));
  await bot.sendMessage(ADMIN_ID, lateCard({ id, user_id: userId }, sub, who), { parse_mode: 'HTML', reply_markup: { inline_keyboard: [
    [{ text: '✅ Agree — he pays the days left', callback_data: `cgb_lrq_a_${id}` }],
    [{ text: '❌ Refuse', callback_data: `cgb_lrq_x_${id}` }],
  ] } }).catch(() => {});
}

async function decideLateRequest(data, chatId, msgId) {
  const [, , how, idRaw] = data.split('_');
  ensureLateTable();
  const r = db.prepare('SELECT * FROM cgb_late_renewals WHERE id = ?').get(Number(idRaw));
  await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(() => {});
  if (!r) { await bot.sendMessage(chatId, '❌ Request not found.'); return; }
  const claimed = db.prepare(`UPDATE cgb_late_renewals SET status = ?, decided_at = datetime('now') WHERE id = ? AND status = 'pending'`)
    .run(how === 'a' ? 'approved' : 'refused', r.id).changes;
  if (!claimed) { await bot.sendMessage(chatId, `ℹ️ Request #${r.id} was already ${r.status}.`); return; }
  if (how === 'x') {
    await bot.sendMessage(Number(r.user_id), `❌ <b>Your late renewal request was not accepted</b>\n\nYou can buy a new seat from /start.`, { parse_mode: 'HTML' }).catch(() => {});
    await bot.sendMessage(chatId, `❌ Late renewal #${r.id} refused — the customer was told.`);
    return;
  }
  const sub = queries.getCgbSubById(r.sub_id);
  const lq = sub && cgbCycles.lateRenewalQuote(sub);
  await bot.sendMessage(Number(r.user_id),
    `✅ <b>The admin agreed to renew your seat</b>\n\n📧 <code>${escapeHtml(r.email || '')}</code>\n` +
    (lq ? `📅 ${formatDate(lq.from)} → ${formatDate(lq.to)} · ${lq.days} day(s)\n💰 <b>$${lq.price.toFixed(2)}</b> (the days left in its cycle)\n\n` : '\n') +
    `Tap below to pay. <i>The price is counted when you pay: the later, the fewer days.</i>`,
    { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '💳 Pay the days left', callback_data: `cgb_lpay_${r.id}` }]] } }).catch(() => {});
  await bot.sendMessage(chatId, `✅ Late renewal #${r.id} agreed — the customer got the payment button.`);
}

/** The payment screen of an agreed late renewal: the remaining days of its own cycle, priced now. */
async function showLatePayment(chatId, userId, reqId) {
  ensureLateTable();
  const r = db.prepare('SELECT * FROM cgb_late_renewals WHERE id = ?').get(Number(reqId));
  if (!r || String(r.user_id) !== String(userId)) { await bot.sendMessage(chatId, '❌ Request not found.'); return; }
  if (r.status === 'paid') { await bot.sendMessage(chatId, 'ℹ️ This renewal is already paid.'); return; }
  if (r.status !== 'approved') { await bot.sendMessage(chatId, 'ℹ️ This request is not agreed (yet).'); return; }
  const sub = queries.getCgbSubById(r.sub_id);
  const lq = sub && cgbCycles.lateRenewalQuote(sub);
  if (!lq) { await bot.sendMessage(chatId, '❌ Could not price it — contact support.'); return; }
  if (isOutOfStock()) { await bot.sendMessage(chatId, `🔴 <b>No seats available</b>\n\n${escapeHtml(outOfStockMessage())}`, { parse_mode: 'HTML' }); return; }
  setSession(userId, 'CONFIRM_ORDER', {
    daysRemaining: lq.days, extraMonth: false, basePrice: lq.price, finalPrice: lq.price,
    startDate: formatDate(lq.from), endDate: formatDate(lq.to), monthlyPrice: lq.monthly,
    email: sub.email, renewalOf: sub.id, renewMonths: 1, lateReqId: r.id,
  });
  const balance = getBalance(userId);
  const rows = [];
  if (Math.round(balance * 100) >= Math.round(lq.price * 100)) rows.push([{ text: `👛 Pay with Balance ($${balance.toFixed(2)})`, callback_data: 'pay_balance' }]);
  else if (balance > 0) rows.push([{ text: `👛 Balance $${balance.toFixed(2)} — not enough`, callback_data: 'balance_short' }]);
  rows.push(
    [{ text: '💳 Pay with Binance Pay', callback_data: 'pay_binance' }],
    [{ text: '💎 USDT BEP20', callback_data: 'pay_bep20' }, { text: '💎 USDT TRC20', callback_data: 'pay_trc20' }],
    [{ text: '🤖 CryptoBot', callback_data: 'pay_cryptobot' }],
  );
  await bot.sendMessage(chatId,
    `⏰ <b>Late renewal</b>\n\n📧 <code>${escapeHtml(sub.email || '')}</code>\n🏢 ${escapeHtml(workspaceName(sub))}\n\n` +
    `📅 Period: ${formatDate(lq.from)} → ${formatDate(lq.to)}\n⏳ Days: <b>${lq.days}</b> (the days left in its cycle)\n` +
    `💰 <b>Price: $${lq.price.toFixed(2)}</b>\n👛 Your balance: <b>$${balance.toFixed(2)}</b>\n\nSelect payment method:`,
    { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } });
}

async function showLateRequests(chatId) {
  const list = pendingLateRenewals();
  if (!list.length) { await bot.sendMessage(chatId, '⏰ No late renewal request is waiting.'); return; }
  for (const r of list.slice(0, 15)) {
    const sub = queries.getCgbSubById(r.sub_id);
    if (!sub) continue;
    await bot.sendMessage(chatId, lateCard(r, sub, r.username ? '@' + r.username : String(r.user_id)), { parse_mode: 'HTML', reply_markup: { inline_keyboard: [
      [{ text: '✅ Agree — he pays the days left', callback_data: `cgb_lrq_a_${r.id}` }],
      [{ text: '❌ Refuse', callback_data: `cgb_lrq_x_${r.id}` }],
    ] } });
  }
}

async function showRenewDurations(chatId, userId, subId, messageId = null) {
  const sub = queries.getCgbSubById(subId);
  if (!sub) { await bot.sendMessage(chatId, '❌ Subscription not found.'); return; }
  if (await renewalClosed(chatId, sub)) return;

  // Three per row: twelve full-width buttons would bury the Back button below
  // the fold and make the screen a scroll rather than a choice.
  const rows = [];
  let row = [];
  for (const m of RENEW_MONTHS) {
    const q = priceRenewal(sub, m);
    row.push({
      text: `${m}mo · $${q.price.toFixed(2)}${q.bulk ? ` −${q.bulk}%` : ''}`,
      callback_data: `cgb_rendur_${subId}_${m}`,
    });
    if (row.length === 3) { rows.push(row); row = []; }
  }
  if (row.length) rows.push(row);
  rows.push([{ text: '🔙 Back', callback_data: `cgb_details_${subId}` }]);

  const txt =
    `🔄 <b>Renew — choose duration</b>\n\n` +
    `📧 <code>${escapeHtml(sub.email)}</code>\n` +
    `📅 Current seat ends: <b>${sub.end_date}</b>\n` +
    (priceRenewal(sub, 1).kind === 'stub'
      ? `🗓 Your previous cycle is no longer sold: your renewal starts with ${priceRenewal(sub, 1).stub.days} extra day(s) until <b>${formatDate(priceRenewal(sub, 1).stub.end)}</b> (priced for those days), then full months. After that everything is normal.\n`
      : '') + `\n` +
    `<i>Pick any number of months. Time is added on top of what you already ` +
    `have — nothing is lost.</i>`;

  const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } };
  if (messageId) {
    await bot.editMessageText(txt, { chat_id: chatId, message_id: messageId, ...opts }).catch(async () => {
      await bot.sendMessage(chatId, txt, opts);
    });
  } else {
    await bot.sendMessage(chatId, txt, opts);
  }
}

async function showRenewPayment(chatId, userId, subId, months, messageId = null) {
  const sub = queries.getCgbSubById(subId);
  if (!sub || String(sub.user_id) !== String(userId)) {
    await bot.sendMessage(chatId, '❌ Subscription not found.');
    return;
  }
  if (isOutOfStock()) {
    await bot.sendMessage(chatId,
      `🔴 <b>No seats available</b>\n\n${escapeHtml(outOfStockMessage())}`, { parse_mode: 'HTML' });
    return;
  }

  if (await renewalClosed(chatId, sub)) return;
  const q = priceRenewal(sub, months);

  setSession(userId, 'CONFIRM_ORDER', {
    daysRemaining: q.days,
    extraMonth: false,
    basePrice: q.price,
    finalPrice: q.price,
    startDate: formatDate(q.from),
    endDate:   formatDate(q.to),
    monthlyPrice: q.monthly,
    email: sub.email,
    renewalOf: subId,
    renewMonths: months,
  });

  const balance = getBalance(userId);
  const canPayWithBalance = Math.round(balance * 100) >= Math.round(q.price * 100);

  const rows = [];
  if (canPayWithBalance) {
    rows.push([{ text: `👛 Pay with Balance ($${balance.toFixed(2)})`, callback_data: 'pay_balance' }]);
  } else if (balance > 0) {
    rows.push([{ text: `👛 Balance $${balance.toFixed(2)} — not enough`, callback_data: 'balance_short' }]);
  }
  rows.push(
    [{ text: '💳 Pay with Binance Pay', callback_data: 'pay_binance' }],
    [{ text: '💎 USDT BEP20', callback_data: 'pay_bep20' }, { text: '💎 USDT TRC20', callback_data: 'pay_trc20' }],
    [{ text: '🤖 CryptoBot', callback_data: 'pay_cryptobot' }],
    [{ text: '⬅️ Change duration', callback_data: `cgb_renewyes_${subId}` }],
  );

  const txt =
    `🔄 <b>Renew ${months} month${months === 1 ? '' : 's'}</b>\n\n` +
    `📧 <code>${escapeHtml(sub.email)}</code>\n` +
    `🏢 ${escapeHtml(workspaceName(sub))}\n\n` +
    `📅 New period: ${formatDate(q.from)} → ${formatDate(q.to)}\n` +
    (q.kind === 'stub'
      ? `ℹ️ <i>Your previous cycle is no longer sold. This renewal first covers the ${q.stub.days} day(s) until ${formatDate(q.stub.end)} (priced for those days only), then the full month${months === 1 ? '' : 's'} up to ${formatDate(q.to)}. After that you renew as usual.</i>\n`
      : '') +
    `⏳ Days added: <b>${q.days}</b>\n` +
    (q.bulk
      ? `💰 <s>$${q.gross.toFixed(2)}</s> → <b>$${q.price.toFixed(2)}</b> (−${q.bulk}%)\n`
      : `💰 <b>Price: $${q.price.toFixed(2)}</b>\n`) +
    `👛 Your balance: <b>$${balance.toFixed(2)}</b>\n\n` +
    `⚠️ <b>Your seat is held only once payment is complete.</b>\n\n` +
    `Select payment method:`;

  const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } };
  if (messageId) {
    await bot.editMessageText(txt, { chat_id: chatId, message_id: messageId, ...opts }).catch(async () => {
      await bot.sendMessage(chatId, txt, opts);
    });
  } else {
    await bot.sendMessage(chatId, txt, opts);
  }
}

// ════════════════════════════════════════════════════════════════
// V156: 🛠 ADMIN PANEL — every owner command as a button
// ════════════════════════════════════════════════════════════════
// A button either opens a screen directly, or asks for the few words a command needs and then runs that very
// command (bot.processUpdate), so a button and a typed command can never behave differently.
const ADM_PROMPTS = {
  addseat:  { cmd: '/addseat',  text: '➕ <b>Add a seat</b>\n\nSend the customer\'s Telegram id and the email:\n<code>5626665035 sara@gmail.com</code>\n\nYou choose the length and the panel next.\n<i>Or all at once:</i> <code>5626665035 sara@gmail.com 2026-11-30 c30</code> (<code>-</code> instead of the panel for none)' },
  setemail: { cmd: '/setemail', text: '📧 <b>Change a seat\'s email</b>\n\nSend the order number (or the seat\'s current email), then the new email:\n<code>20439 new@gmail.com</code>\n<code>old@gmail.com new@gmail.com</code>' },
  setdates: { cmd: '/setdates', text: '✏️ <b>Change a seat\'s dates</b>\n\nSend the order number, the first day and the last day:\n<code>20439 2026-10-05 2026-11-05</code>\n<i>A note for the customer can follow.</i>' },
  ending:   { cmd: '/ending',   text: '🗓 <b>Seats ending on a day</b>\n\nSend the day: <code>2026-10-30</code>, <code>30/10</code> or <code>+3</code>' },
  setprice: { cmd: '/setprice', text: '💲 <b>Custom monthly price for a customer</b>\n\nSend the Telegram id and the price (a note may follow):\n<code>5626665035 12.50</code>' },
  setpanel: { cmd: '/setpanel', text: '🖥 <b>Move a seat to another panel</b>\n\nSend the order number or the seat\'s email:\n<code>23586</code>\n<code>sara@gmail.com</code>\n\n<i>The customer is not told.</i>' },
  delprice: { cmd: '/delprice', text: '🗑 <b>Remove a customer\'s custom price</b>\n\nSend the Telegram id:\n<code>5626665035</code>' },
};

function runAsCommand(chatId, userId, text) {
  bot.processUpdate({ update_id: Date.now(), message: {
    message_id: 0, date: Math.floor(Date.now() / 1000), text,
    from: { id: Number(userId), is_bot: false, first_name: 'admin' }, chat: { id: Number(chatId), type: 'private' },
  } });
}

async function showAdminPanel(chatId, msgId = null) {
  const now = cgbCycles.localNow(new Date());
  const today = cgbSeatTools.ymd(now);
  const tomorrow = cgbSeatTools.parseDay('tomorrow', now);
  const nT = cgbSeatTools.seatsEndingOn(db, today).total;
  const nM = cgbSeatTools.seatsEndingOn(db, tomorrow).total;
  let active = 0, waiting = 0;
  try {
    active = db.prepare("SELECT COUNT(*) n FROM chatgpt_subscriptions WHERE status = 'active' AND date(end_date) >= date(?)").get(today).n;
    waiting = db.prepare("SELECT COUNT(*) n FROM chatgpt_subscriptions WHERE COALESCE(status,'pending') = 'pending'").get().n;
  } catch (_) {}
  const txt =
    `🛠 <b>ChatGPT Business — Admin</b>\n━━━━━━━━━━━━━━━━━━\n` +
    `🟢 Active seats: <b>${active}</b>\n⏳ Waiting for activation: <b>${waiting}</b>\n` +
    `🗓 Ending today: <b>${nT}</b> · tomorrow: <b>${nM}</b>\n━━━━━━━━━━━━━━━━━━\nChoose:`;
  const kb = { inline_keyboard: [
    [{ text: `🗓 Ending today · ${nT}`, callback_data: 'adm_end_today' }, { text: `🗓 Tomorrow · ${nM}`, callback_data: 'adm_end_tomorrow' }],
    [{ text: '🗓 In 3 days', callback_data: 'adm_end_+3' }, { text: '🗓 In 7 days', callback_data: 'adm_end_+7' }, { text: '📅 Other day', callback_data: 'adm_ask_ending' }],
    [{ text: `💙 Paid renewals · ${(() => { try { return db.prepare("SELECT COUNT(*) n FROM chatgpt_subscriptions WHERE renewed_from IS NOT NULL AND COALESCE(status,'pending')='pending'").get().n; } catch (_) { return 0; } })()}`, callback_data: 'adm_paidrenewals' },
     { text: `📩 Email requests · ${(() => { try { return pendingEmailRequests().length; } catch (_) { return 0; } })()}`, callback_data: 'adm_emailreqs' }],
    [{ text: `⏰ Late renewal requests · ${(() => { try { return pendingLateRenewals().length; } catch (_) { return 0; } })()}`, callback_data: 'adm_laterenewals' }],
    [{ text: '➕ Add a seat', callback_data: 'adm_ask_addseat' }, { text: '📧 Change an email', callback_data: 'adm_ask_setemail' }],
    [{ text: '✏️ Change dates', callback_data: 'adm_ask_setdates' }, { text: '🖥 Change a panel', callback_data: 'adm_ask_setpanel' }],
    [{ text: '🔎 Check renewals', callback_data: 'adm_run_checkrenewals' }],
    [{ text: '🔄 Renewals board', callback_data: 'adm_run_renewals' }],
    [{ text: '💰 Custom prices', callback_data: 'adm_run_prices' }, { text: '💲 Set a price', callback_data: 'adm_ask_setprice' }],
    [{ text: '🗑 Remove a price', callback_data: 'adm_ask_delprice' }, { text: '🔌 Test invite bot', callback_data: 'adm_run_guardtest' }],
    [{ text: '⬅️ Customer menu', callback_data: 'cgb_menu' }],
  ] };
  if (msgId) {
    await bot.editMessageText(txt, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: kb })
      .catch(() => bot.sendMessage(chatId, txt, { parse_mode: 'HTML', reply_markup: kb }));
  } else {
    await bot.sendMessage(chatId, txt, { parse_mode: 'HTML', reply_markup: kb });
  }
}

bot.onText(/^\/admin(?:@\w+)?$/i, async (msg) => {
  if (String(msg.from.id) !== String(ADMIN_ID)) return;
  await showAdminPanel(msg.chat.id);
});

/** adm_* buttons → true when handled. */
async function handleAdminPanelButton(data, chatId, msgId, userId) {
  if (!data.startsWith('adm_')) return false;
  if (String(userId) !== String(ADMIN_ID)) return true;
  if (data === 'adm_home') { await showAdminPanel(chatId, msgId); return true; }
  if (data === 'adm_emailreqs') { await showEmailRequests(chatId); return true; }
  if (data === 'adm_paidrenewals') { await showPaidRenewals(chatId); return true; }
  if (data === 'adm_laterenewals') { await showLateRequests(chatId); return true; }
  let m = /^adm_end_(today|tomorrow|\+\d+)$/.exec(data);
  if (m) { runAsCommand(chatId, userId, `/ending ${m[1]}`); return true; }
  m = /^adm_run_(checkrenewals|renewals|prices|guardtest)$/.exec(data);
  if (m) { runAsCommand(chatId, userId, `/${m[1]}`); return true; }
  m = /^adm_ask_(\w+)$/.exec(data);
  if (m && ADM_PROMPTS[m[1]]) {
    setSession(userId, 'ADM_TYPE', { cmd: ADM_PROMPTS[m[1]].cmd });
    await bot.sendMessage(chatId, ADM_PROMPTS[m[1]].text, { parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'adm_cancel' }]] } });
    return true;
  }
  if (data === 'adm_cancel') {
    clearSession(userId);
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(() => {});
    await showAdminPanel(chatId);
    return true;
  }
  return true;
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

  // The menu is ALWAYS shown.
  //
  // It used to appear only for customers with a row in chatgpt_subscriptions,
  // and those rows are created solely by purchases made inside THIS bot. Every
  // seat sold as a normal product in the main store therefore had no row, its
  // owner was sent straight to the price calculator, and the entire renewals
  // feature was invisible to almost everyone. Reachability must not depend on
  // which till the customer happened to buy at.
  await showMainMenu(chatId, userId);
});

// A second door into the same menu, for anyone who scrolled past /start.
bot.onText(/^\/(menu|renew|subscriptions?)$/i, async (msg) => {
  await showMainMenu(msg.chat.id, msg.from.id);
});

/**
 * Renewals dashboard — admin only, inside this bot.
 *
 * One screen that answers "where does this renewal round stand?": every seat
 * ending in the window, sorted into paid / said yes but unpaid / no answer /
 * declined, plus what has to be activated today and what later. Each section
 * opens its own list, and a seat to activate opens its order card with the
 * usual Activate button.
 */
const RNW_WINDOW_BACK = 12;   // days: seats that ended recently
const RNW_WINDOW_AHEAD = 10;  // days: seats ending soon
const RNW_PAGE = 8;

const rnwWho = (r) => (r.username ? `@${escapeHtml(r.username)}` : escapeHtml(r.first_name || String(r.user_id)));
const rnwMoney = (n) => `$${Number(n || 0).toFixed(2)}`;

function renewalBoard() {
  const today = ymdLocal(cgbCycles.localNow(new Date()));
  let seats = [];
  try {
    seats = db.prepare(`
      SELECT cs.*, u.username, u.first_name
      FROM chatgpt_subscriptions cs
      LEFT JOIN users u ON cs.user_id = u.telegram_id
      WHERE COALESCE(cs.status, '') IN ('active', 'pending', 'expired')
        AND cs.end_date IS NOT NULL
        AND date(cs.end_date) BETWEEN date(?, '-${RNW_WINDOW_BACK} days') AND date(?, '+${RNW_WINDOW_AHEAD} days')
        -- a seat that IS a renewal is shown under the seat it continues
        AND NOT (cs.renewed_from IS NOT NULL AND date(cs.start_date) > date(?, '-${RNW_WINDOW_BACK} days'))
      ORDER BY date(cs.end_date) ASC, cs.id ASC`).all(today, today, today);
  } catch (e) { logger.warn(`renewal board: ${e.message}`); }

  const succ = db.prepare(`
    SELECT n.*, o.total_price AS paid, o.payment_method
    FROM chatgpt_subscriptions n LEFT JOIN orders o ON o.id = n.order_id
    WHERE n.renewed_from = ? AND COALESCE(n.status,'') IN ('active','pending')
    ORDER BY n.id DESC LIMIT 1`);

  const out = { today, paid: [], unpaid: [], silent: [], declined: [] };
  for (const s0 of seats) {
    const n = succ.get(s0.id);
    const row = { ...s0, next: n || null, cycleOpens: nextCycleStartYmd(String(s0.end_date).slice(0, 10)) };
    if (n) out.paid.push(row);
    else if (s0.renew_intent === 'no') out.declined.push(row);
    else if (s0.renew_intent === 'yes') out.unpaid.push(row);
    else out.silent.push(row);
  }
  out.activateNow = queries.getCgbDueNow();
  out.scheduled = queries.getCgbScheduled();
  out.revenue = out.paid.reduce((a, r) => a + Number(r.next.paid || r.next.final_price || 0), 0);
  return out;
}

function nextState(n, today) {
  if (!n) return '';
  if (n.status === 'active') return '🟢 activated';
  if (String(n.start_date) > today) return `🔵 activate on ${niceDate(n.start_date)}`;
  return '🟠 <b>activate now</b>';
}

function renewalsHome(b) {
  const total = b.paid.length + b.unpaid.length + b.silent.length + b.declined.length;
  const pct = (n) => (total ? ` (${Math.round((n / total) * 100)}%)` : '');
  const nextOpen = [...b.paid, ...b.unpaid, ...b.silent, ...b.declined]
    .map((r) => r.cycleOpens).filter((d) => d >= b.today).sort()[0];

  const txt =
    `🔄 <b>RENEWALS</b>\n` +
    `<i>Seats ending ${niceDate(addDaysYmd(b.today, -RNW_WINDOW_BACK))} → ${niceDate(addDaysYmd(b.today, RNW_WINDOW_AHEAD))}` +
    `${nextOpen ? ` · next cycle opens ${niceDate(nextOpen)}` : ''}</i>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📦 Seats in this round: <b>${total}</b>\n\n` +
    `✅ Renewed & paid   <b>${b.paid.length}</b>${pct(b.paid.length)} · <b>${rnwMoney(b.revenue)}</b>\n` +
    `⏳ Said yes, unpaid  <b>${b.unpaid.length}</b>\n` +
    `🔔 No answer yet     <b>${b.silent.length}</b>\n` +
    `🚫 Won't renew       <b>${b.declined.length}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `⚡ <b>TO DO</b>\n` +
    `🟠 Activate now: <b>${b.activateNow.length}</b>\n` +
    `🔵 Activate later: <b>${b.scheduled.length}</b>` +
    (b.scheduled[0] ? ` <i>(first on ${niceDate(b.scheduled[0].start_date)})</i>` : '') +
    `\n━━━━━━━━━━━━━━━━━━━━\n` +
    `<i>Customers are reminded daily from the day before their seat ends until ` +
    `the new cycle opens. "No" stops the reminders for good.</i>`;

  const kb = [
    [{ text: `🟠 Activate now · ${b.activateNow.length}`, callback_data: 'rnw_l_act_0' },
     { text: `🔵 Later · ${b.scheduled.length}`, callback_data: 'rnw_l_sch_0' }],
    [{ text: `✅ Paid · ${b.paid.length}`, callback_data: 'rnw_l_paid_0' },
     { text: `⏳ Unpaid · ${b.unpaid.length}`, callback_data: 'rnw_l_unp_0' }],
    [{ text: `🔔 No answer · ${b.silent.length}`, callback_data: 'rnw_l_sil_0' },
     { text: `🚫 Declined · ${b.declined.length}`, callback_data: 'rnw_l_dec_0' }],
    [{ text: '🔄 Refresh', callback_data: 'rnw_home' }],
  ];
  return { txt, kb };
}

const RNW_TITLES = {
  act: '🟠 ACTIVATE NOW', sch: '🔵 ACTIVATE LATER', paid: '✅ RENEWED & PAID',
  unp: '⏳ SAID YES — NOT PAID', sil: '🔔 NO ANSWER YET', dec: "🚫 WON'T RENEW",
};

function renewalsList(b, cat, page) {
  const src = { act: b.activateNow, sch: b.scheduled, paid: b.paid, unp: b.unpaid, sil: b.silent, dec: b.declined }[cat] || [];
  const pages = Math.max(1, Math.ceil(src.length / RNW_PAGE));
  page = Math.min(Math.max(0, page), pages - 1);
  const slice = src.slice(page * RNW_PAGE, page * RNW_PAGE + RNW_PAGE);

  const line = (r, i) => {
    const n = page * RNW_PAGE + i + 1;
    const head = `<b>${n}.</b> ${rnwWho(r)} · <code>${escapeHtml(r.email || '')}</code>`;
    if (cat === 'act' || cat === 'sch') {
      return `${head}\n    🗓 ${niceDate(r.start_date)} → ${niceDate(r.end_date)} · ${rnwMoney(r.final_price)}` +
        (r.renewed_from ? ' · 🔄 renewal' : ' · 🆕 new');
    }
    if (cat === 'paid') {
      const x = r.next;
      return `${head}\n    💵 ${rnwMoney(x.paid || x.final_price)} · ${escapeHtml(String(x.payment_method || '—').replace('pay_', ''))}` +
        `\n    🗓 ${niceDate(x.start_date)} → ${niceDate(x.end_date)} · ${nextState(x, b.today)}`;
    }
    const reminded = r.reminder_count ? ` · reminded ${r.reminder_count}×` : '';
    return `${head}\n    📅 ends ${niceDate(r.end_date)}${reminded}` +
      (cat === 'unp' ? ' · <i>chose renew, did not pay</i>' : '');
  };

  let txt = `${RNW_TITLES[cat]} — <b>${src.length}</b>\n━━━━━━━━━━━━━━━━━━━━\n`;
  txt += slice.length ? slice.map(line).join('\n\n') : '<i>Nothing here.</i>';
  if (cat === 'sch' && slice.length) txt += `\n\n<i>Paid ahead of their cycle. Activating early cuts days they paid for.</i>`;
  if (cat === 'act' && slice.length) txt += `\n\n<i>Tap a seat to open its card with the Activate button.</i>`;
  if (pages > 1) txt += `\n\n<i>Page ${page + 1}/${pages}</i>`;

  const kb = [];
  if (cat === 'act' || cat === 'sch') {
    slice.forEach((r, i) => kb.push([{
      text: `${cat === 'act' ? '🔔' : '🔵'} ${page * RNW_PAGE + i + 1}. ${String(r.email || '').slice(0, 30)}`,
      callback_data: `rnw_card_${r.id}`,
    }]));
  }
  const nav = [];
  if (page > 0) nav.push({ text: '◀️', callback_data: `rnw_l_${cat}_${page - 1}` });
  if (page < pages - 1) nav.push({ text: '▶️', callback_data: `rnw_l_${cat}_${page + 1}` });
  if (nav.length) kb.push(nav);
  kb.push([{ text: '🔙 Renewals', callback_data: 'rnw_home' }]);
  return { txt, kb };
}

/** The standard order card for one seat, sent fresh so it can be activated. */
async function sendSeatCard(chatId, subId) {
  const sub = queries.getCgbSubById(subId);
  if (!sub) return bot.sendMessage(chatId, '❌ Seat not found.');
  const ord = sub.order_id ? db.prepare('SELECT * FROM orders WHERE id = ?').get(sub.order_id) : null;
  const u = db.prepare('SELECT username, first_name FROM users WHERE telegram_id = ?').get(sub.user_id);
  const who = u?.username ? '@' + u.username : (u?.first_name || `User ${sub.user_id}`);
  const days = Math.max(1, Math.round((new Date(`${sub.end_date}T12:00:00`) - new Date(`${sub.start_date}T12:00:00`)) / 86400000));
  const d = {
    orderId: sub.order_id || sub.id, userId: sub.user_id, days,
    name: escapeHtml(who), email: escapeHtml(sub.email || '—'),
    startDate: sub.start_date, endDate: sub.end_date,
    paid: Number(sub.final_price ?? ord?.total_price ?? 0).toFixed(2),
    method: ord?.payment_method || '—', refLabel: 'Order', ref: String(sub.order_id || '—'),
  };
  const activated = sub.status === 'active';
  const scheduled = !activated && String(sub.start_date) > ymdLocal(cgbCycles.localNow(new Date()));
  return bot.sendMessage(chatId, orderCard(d, activated, scheduled), {
    parse_mode: 'HTML',
    reply_markup: activated
      ? { inline_keyboard: [[{ text: '✅ Already activated', callback_data: 'noop' }]] }
      : orderCardButtons(d),
  });
}

async function handleRenewalsCallback(q) {
  const chatId = q.message.chat.id;
  const msgId = q.message.message_id;
  const data = q.data;
  if (data.startsWith('rnw_card_')) return sendSeatCard(chatId, parseInt(data.split('_').pop(), 10));
  const b = renewalBoard();
  let view;
  if (data === 'rnw_home') view = renewalsHome(b);
  else {
    const [, , cat, page] = data.split('_');
    view = renewalsList(b, cat, parseInt(page, 10) || 0);
  }
  await bot.editMessageText(view.txt, {
    chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
    reply_markup: { inline_keyboard: view.kb }, disable_web_page_preview: true,
  }).catch(() => {});
}

// Admin: test the link to the invite bot (no queueing, no purchase).
bot.onText(/^\/guardtest$/i, async (msg) => {
  if (String(msg.from.id) !== String(ADMIN_ID)) return;
  const wait = await bot.sendMessage(msg.chat.id, '⏳ Testing the connection to the invite bot…').catch(() => null);
  const r = await cgbGuard.diagnose().catch((e) => ({ ok: false, lines: [`❌ ${e.message}`] }));
  const text = `${r.ok ? '🟢' : '🔴'} <b>Invite bot connection</b>\n\n${r.lines.join('\n')}`;
  if (wait) await bot.editMessageText(text, { chat_id: msg.chat.id, message_id: wait.message_id, parse_mode: 'HTML' }).catch(() => bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' }));
  else await bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
});

bot.onText(/^\/renewals?$/i, async (msg) => {
  if (String(msg.from.id) !== String(ADMIN_ID)) return; // silent for everyone else
  const view = renewalsHome(renewalBoard());
  await bot.sendMessage(msg.chat.id, view.txt, {
    parse_mode: 'HTML', reply_markup: { inline_keyboard: view.kb }, disable_web_page_preview: true,
  });
});

/**
 * Per-customer monthly rate.
 *
 *   /setprice <userId> <price> [note]
 *   /prices
 *   /delprice <userId>
 *
 * Stored as a monthly rate rather than a fixed total, because a ChatGPT seat is
 * billed pro-rata for the days left in the cycle. A flat total would be right
 * on the day it was set and wrong every day after.
 */
bot.onText(/^\/setprice(?:\s+(.+))?$/i, async (msg, match) => {
  if (String(msg.from.id) !== String(ADMIN_ID)) return;
  const chatId = msg.chat.id;
  const parts = String((match && match[1]) || '').trim().split(/\s+/).filter(Boolean);

  if (parts.length < 2) {
    const shopRate = cgbCycles.getMonthlyPrice();
    await bot.sendMessage(chatId,
      `💰 <b>Custom price</b>\n\n` +
      `<code>/setprice &lt;userId&gt; &lt;monthly&gt; [note]</code>\n\n` +
      `Example: <code>/setprice 5626665035 10 reseller</code>\n\n` +
      `Shop rate is <b>$${shopRate.toFixed(2)}/month</b>. A custom rate replaces it ` +
      `for that one customer, everywhere — new seats and renewals alike.\n\n` +
      `<code>/prices</code> lists them · <code>/delprice &lt;userId&gt;</code> removes one`,
      { parse_mode: 'HTML' });
    return;
  }

  const target = parseInt(parts[0], 10);
  const price  = parseFloat(String(parts[1]).replace(/[$,\s]/g, ''));
  const note   = parts.slice(2).join(' ') || null;

  if (!Number.isFinite(target) || !Number.isFinite(price) || price < 0) {
    await bot.sendMessage(chatId, '❌ Need a numeric user id and a price, e.g. <code>/setprice 5626665035 10</code>.',
      { parse_mode: 'HTML' });
    return;
  }

  try {
    db.prepare('INSERT OR IGNORE INTO users (telegram_id) VALUES (?)').run(target);
    queries.setCgbUserPrice(target, price, note, msg.from.id);

    const best = cgbCycles.calculateBestCycle();
    const now  = best ? cgbCycles.pricePeriod(best, price) : 0;
    const u = db.prepare('SELECT username, first_name FROM users WHERE telegram_id = ?').get(target);

    await bot.sendMessage(chatId,
      `✅ <b>Custom price set</b>\n\n` +
      `👤 ${u?.username ? '@' + escapeHtml(u.username) : escapeHtml(u?.first_name || String(target))} · <code>${target}</code>\n` +
      `💰 <b>$${price.toFixed(2)}/month</b> (shop rate $${cgbCycles.getMonthlyPrice().toFixed(2)})\n` +
      (note ? `📝 ${escapeHtml(note)}\n` : '') +
      (best ? `\n<i>A seat bought today (${best.daysRemaining} days) costs them $${now.toFixed(2)}.</i>` : ''),
      { parse_mode: 'HTML' });
  } catch (e) {
    await bot.sendMessage(chatId, `❌ ${e.message}`);
  }
});

bot.onText(/^\/prices$/i, async (msg) => {
  if (String(msg.from.id) !== String(ADMIN_ID)) return;
  const rows = queries.listCgbUserPrices();
  const shop = cgbCycles.getMonthlyPrice();

  if (!rows.length) {
    await bot.sendMessage(msg.chat.id,
      `💰 <b>Custom prices</b>\n\nNone set — everyone pays the shop rate of <b>$${shop.toFixed(2)}/month</b>.\n\n` +
      `<code>/setprice &lt;userId&gt; &lt;monthly&gt;</code>`,
      { parse_mode: 'HTML' });
    return;
  }

  await bot.sendMessage(msg.chat.id,
    `💰 <b>Custom prices</b> · shop rate $${shop.toFixed(2)}/month\n\n` +
    rows.map((r) => {
      const who = r.username ? `@${escapeHtml(r.username)}` : escapeHtml(r.first_name || String(r.user_id));
      const diff = Number(r.monthly_price) - shop;
      return `• ${who} · <code>${r.user_id}</code>\n` +
             `  <b>$${Number(r.monthly_price).toFixed(2)}</b>/mo ` +
             `(${diff === 0 ? 'same' : diff > 0 ? `+$${diff.toFixed(2)}` : `−$${Math.abs(diff).toFixed(2)}`})` +
             (r.note ? ` · ${escapeHtml(r.note)}` : '');
    }).join('\n'),
    { parse_mode: 'HTML' });
});

bot.onText(/^\/delprice(?:\s+(\d+))?$/i, async (msg, match) => {
  if (String(msg.from.id) !== String(ADMIN_ID)) return;
  const target = parseInt((match && match[1]) || '', 10);
  if (!Number.isFinite(target)) {
    await bot.sendMessage(msg.chat.id, 'Usage: <code>/delprice &lt;userId&gt;</code>', { parse_mode: 'HTML' });
    return;
  }
  const n = queries.deleteCgbUserPrice(target);
  await bot.sendMessage(msg.chat.id,
    n ? `✅ Custom price removed — <code>${target}</code> now pays the shop rate of $${cgbCycles.getMonthlyPrice().toFixed(2)}/month.`
      : `ℹ️ <code>${target}</code> had no custom price.`,
    { parse_mode: 'HTML' });
});

/**
 * Register a seat that was sold outside this bot.
 *
 * ChatGPT Business is also sold as an ordinary product in the main store, and
 * those sales write no row here — so their owners have nothing to renew and get
 * no expiry reminder. Rather than guessing dates from old orders (a wrong end
 * date means a reminder at the wrong time, which is worse than none), the shop
 * owner states the facts once and the seat behaves like any other from then on.
 *
 *   /addseat <userId> <email> <YYYY-MM-DD end date> [price]
 */
/**
 * Give a seat to a customer by hand, choosing the cycle from buttons.
 *
 *   /addseat <userId> <email>
 *
 * The end date is picked afterwards rather than typed, because the useful
 * answer is almost always "the current cycle" or "N months" — and a typed date
 * is where a wrong end date creeps in, which then fires a reminder on the wrong
 * day and lets a seat run past what was paid for.
 */
bot.onText(/^\/addseat(?:\s+(.+))?$/i, async (msg, match) => {
  if (String(msg.from.id) !== String(ADMIN_ID)) return;
  const chatId = msg.chat.id;
  const parts  = String((match && match[1]) || '').trim().split(/\s+/).filter(Boolean);

  if (parts.length < 2) {
    await bot.sendMessage(chatId,
      `📝 <b>Add a seat manually</b>\n\n` +
      `<code>/addseat &lt;userId&gt; &lt;email&gt;</code>\n\n` +
      `Example:\n<code>/addseat 5626665035 sasha@gmail.com</code>\n\n` +
      `<i>You pick the cycle next. Use this for seats sold in the main store or ` +
      `arranged privately — the customer then sees it under Renew and Details ` +
      `and gets the expiry reminder.</i>`,
      { parse_mode: 'HTML' });
    return;
  }

  const target = parseInt(parts[0], 10);
  const email  = parts[1];
  if (!Number.isFinite(target) || !/^\S+@\S+\.\S+$/.test(email)) {
    await bot.sendMessage(chatId, '❌ Need a numeric user id then an email.');
    return;
  }

  // V155: everything on one line — /addseat <user> <email> <end date> [panel id | -]
  if (parts[2]) {
    const end = cgbSeatTools.parseDay(parts[2], cgbCycles.localNow(new Date()));
    if (!end) { await bot.sendMessage(chatId, '❌ End date not understood. Use 2026-11-30, 30/11 or +30.'); return; }
    if (parts[3]) {
      const panelId = parts[3] === '-' ? '' : parts[3];
      await createSeatManually(chatId, target, email, end, msg.from.id, { panelId });
    } else {
      await askSeatPanel(chatId, target, email, end);
    }
    return;
  }

  await showSeatCyclePicker(chatId, target, email);
});

// ── V155: which panel a hand-added seat is in (or none) ──
const pendingSeatPanels = new Map();          // token -> { u, e, d, ids, at }
async function askSeatPanel(chatId, target, email, endDate) {
  const now = Date.now();
  for (const [k, v] of pendingSeatPanels) if (now - v.at > PENDING_EDIT_MS) pendingSeatPanels.delete(k);
  const panels = (await cgbGuard.fetchGuardPanelsNamed(6000).catch(() => null)) || [];
  const token = require('crypto').randomBytes(4).toString('hex');
  pendingSeatPanels.set(token, { u: target, e: email, d: endDate, ids: panels.map((p) => p.id), at: now });
  const icon = { running: '🟢', stopped: '⚪', paused: '⏸', waiting: '⏳' };
  const rows = panels.slice(0, 20).map((p, i) => [{ text: `${icon[p.state] || '•'} ${p.name}`, callback_data: `cgb_sp_${token}_${i}` }]);
  rows.push([{ text: '⬜ No panel', callback_data: `cgb_sp_${token}_n` }]);
  await bot.sendMessage(chatId,
    `📝 <b>Add seat</b>\n\n👤 <code>${target}</code>\n📧 <code>${escapeHtml(email)}</code>\n📅 Ends <b>${endDate}</b>\n\n` +
    `Which panel is it in?\n<i>A panel: the email goes on that panel's whitelist in the invite bot with this end date ` +
    `(you get an alert the day before and on the day). No panel: the seat is only saved here.</i>` +
    (panels.length ? '' : `\n\n⚠️ <i>Could not get the panels from the invite bot.</i>`),
    { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } });
}

const pendingSeatPicks = new Map();          // token -> { u, e, ends: [date], at } (V156.1)
/** Cycle options for a hand-added seat. */
async function showSeatCyclePicker(chatId, target, email) {
  const best = cgbCycles.calculateBestCycle();
  const monthly = cgbCycles.getMonthlyPrice(target);
  // V156.1: Telegram allows 64 bytes per button. The user id + email + date used to be packed INTO each button
  // (80+ bytes even for sara@gmail.com), so Telegram refused the whole message and nothing appeared. The choice
  // now waits here under a short token.
  const now = Date.now();
  for (const [k, v] of pendingSeatPicks) if (now - v.at > PENDING_EDIT_MS) pendingSeatPicks.delete(k);
  const token = require('crypto').randomBytes(4).toString('hex');
  const pick = { u: target, e: email, ends: [], at: now };
  pendingSeatPicks.set(token, pick);
  const enc = (o) => {
    if (o.d === undefined) return `${token}_t`;                    // type a date
    pick.ends.push(o.d);
    return `${token}_${pick.ends.length - 1}`;
  };

  const rows = [];
  if (best) {
    rows.push([{
      text: `📅 Current cycle — ends ${formatDate(best.endDate)} (${best.daysRemaining}d)`,
      callback_data: `cgb_seat_${enc({ d: formatDate(best.endDate) })}`,
    }]);
  }
  // Whole months from today, three per row.
  let row = [];
  for (const m of [1, 2, 3, 6, 12]) {
    const end = new Date();
    end.setMonth(end.getMonth() + m);
    row.push({
      text: `${m}mo`,
      callback_data: `cgb_seat_${enc({ d: formatDate(end) })}`,
    });
    if (row.length === 3) { rows.push(row); row = []; }
  }
  if (row.length) rows.push(row);
  rows.push([{ text: '✏️ Type an exact end date', callback_data: `cgb_seatdate_${enc({})}` }]);

  await bot.sendMessage(chatId,
    `📝 <b>Add seat</b>\n\n` +
    `👤 <code>${target}</code>\n` +
    `📧 <code>${escapeHtml(email)}</code>\n` +
    `💰 Their rate: <b>$${monthly.toFixed(2)}/month</b>` +
    `${queries.getCgbUserPrice(target) ? ' <i>(custom)</i>' : ''}\n\n` +
    `Choose how long the seat runs:`,
    { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } });
}

/** Write the seat, tell the customer, and hand it to the normal machinery. */
/**
 * Mark a seat's order active, notify the customer, and repaint its admin
 * card green — the one shared path for BOTH the manual "🔔 Activate &
 * Notify Customer" button and the automatic callback from ChatGPT Business
 * Guard (services/cgbGuard.js's webhook) once it verifies an invite in
 * Pending invites. Everything is derived from the DB rather than passed in
 * by the caller, so either trigger works the same way.
 *
 * chatId/msgId are optional and only come from the button press (the exact
 * message that was tapped); the webhook has neither, so it falls back to
 * the card saved in cgb_admin_cards at send time, and if that's missing
 * too (e.g. a seat added via /addseat with no card ever sent), a fresh
 * confirmation message to ADMIN_ID is sent instead of silently doing
 * nothing.
 *
 * Returns { ok, reason } — reason is set on failure or on a no-op (already
 * active), never thrown, so callers (a Telegram handler or an HTTP route)
 * can each report it their own way.
 */
/**
 * Hand a paid seat's email to the invite bot — to the panel of the seat's CYCLE — and tell the owner
 * when that fails. Until V147 a failure here was only a line in the log: the paid customer simply
 * never got an invite and nobody knew.
 */
async function handOverToGuard(email, orderId, endDate) {
  let r = null;
  try { r = await cgbGuard.notifyGuardOfNewInvite(email, { orderId, endDate }); }
  catch (e) { r = { ok: false, reason: e.message }; }
  if (r && r.held) {                                         // V157.2: its cycle has a name but no invite bot yet
    await bot.sendMessage(ADMIN_ID,
      `⏸ <b>Order #${orderId} — invite it yourself</b>\n📧 <code>${escapeHtml(email || '')}</code>\n` +
      `🏷 Its cycle is in <b>${escapeHtml(r.placeholder)}</b>, which has no invite bot yet, so nothing was sent to another panel.\n\n` +
      `<i>When its bot exists: 📅 Manage Cycles → 🤖 → link it, then 📤 move the cycle's emails there.</i>`,
      { parse_mode: 'HTML' }).catch(() => {});
    return r;
  }
  if (r && r.ok === false) {
    await bot.sendMessage(ADMIN_ID,
      `⚠️ <b>Order #${orderId} was NOT handed to the invite bot</b>\n📧 <code>${escapeHtml(email || '')}</code>\n` +
      `${r.bot && r.bot !== 'main' ? `Bot: <b>${escapeHtml((require('./services/cgbBots').get(r.bot) || {}).name || r.bot)}</b> (the active one)\n` : ''}` +
      `${r.panel ? `Panel: <code>${escapeHtml(r.panel)}</code>${r.source === 'cycle' ? ' (linked to its cycle)' : ''}\n` : ''}` +
      `Reason: ${escapeHtml(r.reason || 'unknown')}\n\n<i>Invite this customer yourself, or fix the link in 📅 Cycles and add the email again.</i>`,
      { parse_mode: 'HTML' }).catch(() => {});
  } else if (r && r.ok && r.panelState && r.panelState !== 'online') {
    logger.info(`order #${orderId}: panel ${r.panel} is ${r.panelState}; the order waits in its queue`);
  }
  return r;
}

/** The buttons of a finished (green) card: the done mark, and the way to correct its dates. */
function activeCardMarkup(orderId) {
  return { inline_keyboard: [
    [{ text: '✅ Done — customer notified', callback_data: 'noop' }],
    [{ text: '✏️ Change dates', callback_data: `cgb_dates_${orderId}` }, { text: '🖥 Change panel', callback_data: `cgb_cp_${orderId}` }],
  ] };
}

async function activateAndNotifySeat(orderIdRaw, { chatId = null, msgId = null, panelName = '', panelId = '', fromGuard = false } = {}) {
  const orderId = parseInt(orderIdRaw, 10);
  if (!Number.isFinite(orderId)) return { ok: false, reason: 'invalid order id' };

  const sub = queries.getCgbSubscriptionByOrder(orderId);
  if (!sub) return { ok: false, reason: `no subscription found for order #${orderId}` };
  if (sub.status === 'active') return { ok: false, reason: 'already active' };
  // A cancelled (refunded) order must never be activated — not by a stale
  // button, and not by the invite bot reporting a success that raced the
  // cancel.
  if (sub.status === 'cancelled') return { ok: false, reason: 'this order was cancelled' };

  const ord = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  const customerId = sub.user_id;
  const days = sub.days_remaining;
  const endDate = sub.end_date;

  // V152: the panel (workspace) the seat is in — told to the customer, stamped on the order and the card.
  // From the invite bot when it invited them itself; otherwise the seat's cycle → its panel.
  let guardOk = null;
  try {
    const cgbGuard = require('./services/cgbGuard');
    if (!panelId) panelId = cgbGuard.panelForSub(sub);
    if (!panelName && panelId) panelName = await cgbGuard.panelNameOf(panelId);
    if (!panelName) panelName = require('./services/cgbRouting').placeholderFor(endDate);   // V157.2: a cycle with only a name
    // Activated by hand: the invite bot did not invite this person, so put them on that panel's whitelist with
    // the seat's end date — otherwise it would flag them as "unknown".
    if (!fromGuard && panelId && !cgbGuard.isPlaceholderPanel(panelId) && sub.email) {
      guardOk = await cgbGuard.whitelistInGuard({ panel: panelId, email: sub.email, expiresOn: endDate, note: `order #${orderId}`, source: 'store' });
      if (guardOk.ok && guardOk.panelName) panelName = guardOk.panelName;
      else if (!guardOk.ok) logger.warn(`activateAndNotifySeat #${orderId}: whitelist in panel ${panelId} failed: ${guardOk.reason}`);
    }
  } catch (e) { logger.warn(`activateAndNotifySeat #${orderId}: panel lookup: ${e.message}`); }

  try {
    await bot.sendMessage(Number(customerId),
      `✅ <b>Your ChatGPT Business Subscription is Now Active!</b>\n\n` +
      `🆔 Order: <b>#${orderId}</b>\n` +
      (panelName ? `🖥 Workspace: <b>${escapeHtml(panelName)}</b>\n` : '') +
      `⏱ Duration: <b>${days} days</b>\n` +
      `📅 Expiry date: <b>${endDate}</b>\n\n` +
      `Your subscription has been successfully activated on the email you provided.\n` +
      `If you face any issues, please contact our support team.`,
      { parse_mode: 'HTML' }
    );
  } catch (e) {
    logger.warn(`activateAndNotifySeat: could not message customer ${customerId}: ${e.message}`);
    // Still activate below — a customer who muted/blocked the bot shouldn't
    // keep their paid seat stuck as "not activated" forever.
  }

  try {
    queries.activateCgbSubscription(orderId);
    // Stamp the workspace onto the row at activation. Reading the setting
    // later would show today's workspace on an old seat if the shop ever
    // moves accounts, which is exactly the field a customer would query.
    try {
      if (panelName) {
        queries.setCgbWorkspace(sub.id, panelName);                 // V152: the real panel it was activated in
      } else if (!sub.workspace) {
        const wsRow = db.prepare(`SELECT value FROM settings WHERE key='cgb_workspace_name'`).get();
        queries.setCgbWorkspace(sub.id, wsRow?.value || 'chatgpt_Team');
      }
    } catch (e) { logger.warn(`workspace stamp: ${e.message}`); }
    db.prepare(`UPDATE orders SET status='delivered' WHERE id=?`).run(orderId);
  } catch (e) {
    return { ok: false, reason: `could not mark order/sub active: ${e.message}` };
  }

  // Repaint the WHOLE card green, not just the button. Editing only the
  // markup left the red band and "NOT ACTIVATED YET" in place, which is
  // what made finished and pending orders look identical in the scrollback.
  const card = queries.getCgbAdminCard ? queries.getCgbAdminCard(orderId) : null;
  const targetChatId = chatId ?? card?.chat_id ?? null;
  const targetMsgId = msgId ?? card?.message_id ?? null;

  const u = db.prepare('SELECT username, first_name FROM users WHERE telegram_id = ?').get(Number(customerId));
  const who = u?.username ? '@' + u.username : (u?.first_name || `User ${customerId}`);
  const p2 = (n) => String(n).padStart(2, '0');
  const now = new Date();
  const greenCard = orderCard({
    orderId,
    userId:    customerId,
    days,
    name:      escapeHtml(who),
    email:     escapeHtml(sub.email || '—'),
    startDate: sub.start_date || '—',
    endDate:   endDate,
    paid:      Number(sub.final_price ?? ord?.total_price ?? 0).toFixed(2),
    method:    ord?.payment_method || '—',
    refLabel:  'Order',
    ref:       String(orderId),
    activatedAt: `${p2(now.getDate())}/${p2(now.getMonth() + 1)} ${p2(now.getHours())}:${p2(now.getMinutes())}`,
    panel:     panelName ? escapeHtml(panelName) : '',
    cycle:     cgbSeatTools.cycleLabel(db, endDate),
    editedNote: (guardOk && !guardOk.ok) ? `Not put on the invite bot's whitelist: ${escapeHtml(guardOk.reason)}` : undefined,
  }, true);
  const doneMarkup = activeCardMarkup(orderId);

  if (targetChatId && targetMsgId) {
    try {
      await bot.editMessageText(greenCard, {
        chat_id: targetChatId, message_id: targetMsgId, parse_mode: 'HTML', reply_markup: doneMarkup,
      });
      return { ok: true };
    } catch (e) {
      // Never leave the card looking untouched: if the repaint fails for any
      // reason, at least flip the button so the state is still readable.
      logger.warn(`activateAndNotifySeat: card repaint failed: ${e.message}`);
      await bot.editMessageReplyMarkup(doneMarkup, { chat_id: targetChatId, message_id: targetMsgId }).catch(() => {});
      return { ok: true };
    }
  }
  // No known card to repaint (typically the webhook path when the original
  // send-time save failed, or a hand-added seat) — a fresh green message is
  // still better than silence.
  try {
    await bot.sendMessage(ADMIN_ID, greenCard, { parse_mode: 'HTML', reply_markup: doneMarkup });
  } catch (e) {
    logger.warn(`activateAndNotifySeat: could not send fallback confirmation: ${e.message}`);
  }
  return { ok: true };
}

/**
 * Redraw the owner's card of an order after its dates changed — the stored card is edited in
 * place; if that is impossible (too old, deleted) a fresh one is sent. Never touches an
 * activated card.
 */
async function repaintSeatCard(orderId, editedNote = null) {
  const data = seatCardData(orderId);
  if (!data || (data.sub.status !== 'pending' && data.sub.status !== 'active')) return false;
  const card = data.card;
  const active = data.sub.status === 'active';
  const scheduled = !active && String(card.startDate) > ymdLocal(cgbCycles.localNow(new Date()));
  if (active) card.editedNote = editedNote;
  const text = orderCard(card, active, scheduled);
  const markup = active ? activeCardMarkup(orderId) : orderCardButtons(card);
  const stored = queries.getCgbAdminCard ? queries.getCgbAdminCard(orderId) : null;
  if (stored) {
    try {
      await bot.editMessageText(text, { chat_id: stored.chat_id, message_id: stored.message_id, parse_mode: 'HTML', reply_markup: markup });
      return true;
    } catch (e) { logger.warn(`repaintSeatCard #${orderId}: ${e.message}`); }
  }
  if (active) { await bot.sendMessage(ADMIN_ID, text, { parse_mode: 'HTML', reply_markup: markup }).catch(() => {}); return true; }
  await sendSeatCard(ADMIN_ID, data.sub.id);
  return true;
}

/**
 * Change a seat's dates; for an ACTIVE seat optionally tell the customer. Returns what happened so
 * the caller can report it: { ok, reason?, wasActive, before, after, told: true|false|'failed' }.
 */
async function changeSeatDates(orderId, start, end, { notify = false, note = null, adminId = null } = {}) {
  const r = cgbSeatDates.applySeatDates(orderId, start, end, { allowActive: true, note, adminId, notified: false });
  if (!r.ok) return r;
  let told = false;
  if (r.wasActive && notify) {
    try {
      await bot.sendMessage(Number(r.sub.user_id), cgbSeatDates.customerDatesMessage({ orderId, before: r.before, after: r.after, note }), { parse_mode: 'HTML' });
      told = true;
      try { db.prepare('UPDATE cgb_date_edits SET notified = 1 WHERE id = (SELECT MAX(id) FROM cgb_date_edits WHERE order_id = ?)').run(orderId); } catch (e) { /* the log is secondary */ }
    } catch (e) {
      told = 'failed';
      logger.warn(`changeSeatDates #${orderId}: could not message customer ${r.sub.user_id}: ${e.message}`);
    }
  }
  const stamp = ymdLocal(cgbCycles.localNow(new Date()));
  await repaintSeatCard(orderId, r.wasActive
    ? `Dates changed on ${stamp}: ${r.before.end} → ${r.after.end}${told === true ? ' — customer told' : ' — customer NOT told'}.`
    : null);
  await suggestPanelAfterDates(orderId, r.before && r.before.end).catch((e) => logger.warn(`suggestPanelAfterDates #${orderId}: ${e.message}`));
  return { ...r, told };
}

// Dates the owner typed for an ACTIVE seat wait here for his confirmation (a wrong date would reach the customer).
const pendingDateEdits = new Map();            // token -> { orderId, start, end, note, at }
const PENDING_EDIT_MS = 15 * 60 * 1000;
function stashDateEdit(edit) {
  const now = Date.now();
  for (const [k, v] of pendingDateEdits) if (now - v.at > PENDING_EDIT_MS) pendingDateEdits.delete(k);
  const token = require('crypto').randomBytes(4).toString('hex');
  pendingDateEdits.set(token, { ...edit, at: now });
  return token;
}

// ── /setdates <order> <first day> <last day> — correct a paid seat's dates (owner only) ──
bot.onText(/^\/setdates(?:@\w+)?(?:\s+(.*))?$/i, async (msg, match) => {
  if (String(msg.from.id) !== String(ADMIN_ID)) return;
  const chatId = msg.chat.id;
  const parsed = cgbSeatDates.parseSetDates(match && match[1]);
  if (!parsed.ok) { await bot.sendMessage(chatId, `❌ ${parsed.error}`); return; }
  const seat = seatCardData(parsed.orderId);
  if (!seat) { await bot.sendMessage(chatId, `❌ no seat found for order #${parsed.orderId}`); return; }

  // ACTIVE: the customer was already told the old dates and will be told the new ones — confirm first.
  if (seat.sub.status === 'active') {
    const probe = cgbSeatDates.parseSetDates(`${parsed.orderId} ${parsed.start} ${parsed.end}`);
    if (!probe.ok) { await bot.sendMessage(chatId, `❌ ${probe.error}`); return; }
    if (seat.sub.start_date === parsed.start && seat.sub.end_date === parsed.end) {
      await bot.sendMessage(chatId, '❌ those are already the dates of that seat — nothing to change');
      return;
    }
    const days = seat.sub.renewed_from ? cgbSeatDates.daysAfter(parsed.start, parsed.end) : cgbSeatDates.daysCovered(parsed.start, parsed.end);
    const token = stashDateEdit({ orderId: parsed.orderId, start: parsed.start, end: parsed.end, note: parsed.note });
    const past = parsed.end < ymdLocal(cgbCycles.localNow(new Date()));
    await bot.sendMessage(chatId,
      `⚠️ <b>Order #${parsed.orderId} is ACTIVE</b> — the customer already knows its dates.\n\n` +
      `now:  ${seat.sub.start_date} → <b>${seat.sub.end_date}</b> (${seat.sub.days_remaining} days)\n` +
      `new:  ${parsed.start} → <b>${parsed.end}</b> (${days} days)\n` +
      (past ? `\n🚨 <b>The new end date is in the PAST</b> — the seat would count as expired.\n` : '') +
      `\n<b>The customer would receive:</b>\n━━━━━━━━━━\n` +
      cgbSeatDates.customerDatesMessage({ orderId: parsed.orderId, before: { end: seat.sub.end_date }, after: { end: parsed.end, days }, note: parsed.note }) +
      `\n━━━━━━━━━━\n<i>The price paid ($${Number(seat.sub.final_price).toFixed(2)}) is not changed. Valid for 15 minutes.</i>`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [
        [{ text: '✅ Apply & tell the customer', callback_data: `cgb_sd_y_${token}` }],
        [{ text: '🔕 Apply, do NOT tell the customer', callback_data: `cgb_sd_n_${token}` }],
        [{ text: '❌ Cancel', callback_data: `cgb_sd_x_${token}` }],
      ] } });
    return;
  }

  const r = await changeSeatDates(parsed.orderId, parsed.start, parsed.end, { adminId: msg.from.id });
  if (!r.ok) { await bot.sendMessage(chatId, `❌ ${r.reason}`); return; }
  await bot.sendMessage(chatId,
    `✅ <b>Order #${parsed.orderId}</b> dates changed\n` +
    `before: ${r.before.start} → ${r.before.end} (${r.before.days} days)\n` +
    `now: <b>${r.after.start} → ${r.after.end}</b> (${r.after.days} days)\n\n` +
    `<i>The customer is told these dates when you press Activate &amp; Notify. The price paid ($${Number(r.sub.final_price).toFixed(2)}) is unchanged — if the new period costs less, credit the difference with ➕ Add User Balance.</i>`, { parse_mode: 'HTML' });
});

// ── the three buttons of an ACTIVE seat's date change ──
async function handleDateEditButton(data, userId, chatId) {
  const m = /^cgb_sd_([ynx])_([0-9a-f]{8})$/.exec(data);
  if (!m) return false;
  if (String(userId) !== String(ADMIN_ID)) return true;
  const [, choice, token] = m;
  const edit = pendingDateEdits.get(token);
  if (!edit || Date.now() - edit.at > PENDING_EDIT_MS) {
    pendingDateEdits.delete(token);
    await bot.sendMessage(chatId, '⌛ That change expired (or was already handled). Send /setdates again.');
    return true;
  }
  pendingDateEdits.delete(token);          // one tap, one change: a second tap can never repeat it
  if (choice === 'x') { await bot.sendMessage(chatId, '❌ Cancelled — nothing was changed.'); return true; }
  const notify = choice === 'y';
  const r = await changeSeatDates(edit.orderId, edit.start, edit.end, { notify, note: edit.note, adminId: userId });
  if (!r.ok) { await bot.sendMessage(chatId, `❌ ${r.reason}`); return true; }
  await bot.sendMessage(chatId,
    `✅ <b>Order #${edit.orderId}</b> dates changed\n` +
    `before: ${r.before.start} → ${r.before.end} (${r.before.days} days)\n` +
    `now: <b>${r.after.start} → ${r.after.end}</b> (${r.after.days} days)\n` +
    (r.told === true ? `\n📨 The customer was told.`
      : r.told === 'failed' ? `\n⚠️ <b>The customer could NOT be messaged</b> (he may have blocked the bot) — tell him yourself.`
      : `\n🔕 The customer was NOT told.`), { parse_mode: 'HTML' });
  return true;
}

// ── V155: /ending [day] — the seats that end on a day (default: today and tomorrow) ──
async function sendEndingList(chatId, day, label) {
  const { text, emails } = cgbSeatTools.endingText(cgbSeatTools.seatsEndingOn(db, day), label);
  await bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
  if (emails.length) {
    await bot.sendMessage(chatId, `<code>${escapeHtml(emails.join('\n'))}</code>`, { parse_mode: 'HTML' }).catch(() => {});
  }
  return emails.length;
}
bot.onText(/^\/ending(?:@\w+)?(?:\s+(.*))?$/i, async (msg, match) => {
  if (String(msg.from.id) !== String(ADMIN_ID)) return;
  const now = cgbCycles.localNow(new Date());
  const arg = String((match && match[1]) || '').trim();
  if (!arg) {
    await sendEndingList(msg.chat.id, cgbSeatTools.parseDay('today', now), 'today');
    await sendEndingList(msg.chat.id, cgbSeatTools.parseDay('tomorrow', now), 'tomorrow');
    return;
  }
  const day = cgbSeatTools.parseDay(arg, now);
  if (!day) { await bot.sendMessage(msg.chat.id, '❌ Day not understood. Use /ending 2026-10-30, /ending 30/10, /ending tomorrow or /ending +3.'); return; }
  await sendEndingList(msg.chat.id, day);
});

/** Once a day (at the reminder hour): the seats ending today and tomorrow, sent to the owner. */
async function sendDailyEndingDigest() {
  if (!ADMIN_ID) return;
  const now = cgbCycles.localNow(new Date());
  const { hour } = reminderSettings();
  if (now.getHours() < hour) return;
  const today = cgbSeatTools.ymd(now);
  const last = db.prepare("SELECT value FROM settings WHERE key = 'cgb_ending_digest_last'").get();
  if (last && last.value === today) return;
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('cgb_ending_digest_last', ?)").run(today);
  const t = cgbSeatTools.seatsEndingOn(db, today);
  const m = cgbSeatTools.seatsEndingOn(db, cgbSeatTools.parseDay('tomorrow', now));
  if (!t.total && !m.total) return;
  await bot.sendMessage(ADMIN_ID, '🗓 <b>Seats ending</b> — daily list', { parse_mode: 'HTML' }).catch(() => {});
  if (t.total) await sendEndingList(ADMIN_ID, t.day, 'today');
  if (m.total) await sendEndingList(ADMIN_ID, m.day, 'tomorrow');
}

// ── V155: /setemail <order | current email> <new email> — a customer wants another email on his seat ──
const pendingEmailChanges = new Map();       // token -> { subId, email, at }
bot.onText(/^\/setemail(?:@\w+)?(?:\s+(.*))?$/i, async (msg, match) => {
  if (String(msg.from.id) !== String(ADMIN_ID)) return;
  const chatId = msg.chat.id;
  const p = cgbSeatTools.parseSetEmail(match && match[1]);
  if (!p.ok) { await bot.sendMessage(chatId, `❌ ${p.error}\n\nExample: <code>/setemail 20439 new@gmail.com</code> or <code>/setemail old@gmail.com new@gmail.com</code>`, { parse_mode: 'HTML' }); return; }
  const f = cgbSeatTools.findSeat(db, p.ref);
  if (f.error) { await bot.sendMessage(chatId, `❌ ${escapeHtml(f.error)}`, { parse_mode: 'HTML' }); return; }
  const sub = f.sub;
  if (String(sub.email || '').toLowerCase() === p.email) { await bot.sendMessage(chatId, '❌ That is already the seat\'s email.'); return; }
  const now = Date.now();
  for (const [k, v] of pendingEmailChanges) if (now - v.at > PENDING_EDIT_MS) pendingEmailChanges.delete(k);
  const token = require('crypto').randomBytes(4).toString('hex');
  pendingEmailChanges.set(token, { subId: sub.id, email: p.email, at: now });
  const active = sub.status === 'active';
  await bot.sendMessage(chatId,
    `📧 <b>Change the email of a seat</b>\n\n` +
    `${sub.order_id ? `🆔 Order <b>#${sub.order_id}</b>` : '🆔 Manual seat'} · 👤 <code>${sub.user_id}</code>\n` +
    `📅 ${sub.start_date || '?'} → <b>${sub.end_date}</b> · ${active ? '🟢 active' : '⏳ not activated yet'}\n` +
    `${sub.workspace ? `🖥 ${escapeHtml(sub.workspace)}\n` : ''}\n` +
    `before: <code>${escapeHtml(sub.email || '—')}</code>\nafter: <b><code>${escapeHtml(p.email)}</code></b>\n` +
    (f.others ? `\n<i>${f.others} other seat(s) also use the old email — only this one changes.</i>\n` : '') +
    `\nThe customer is told. <i>Valid for 15 minutes.</i>`,
    { parse_mode: 'HTML', reply_markup: { inline_keyboard: [
      [{ text: '✅ Change + invite the new email (invite bot)', callback_data: `cgb_se_i_${token}` }],
      [{ text: '✅ Change — I invite it myself', callback_data: `cgb_se_m_${token}` }],
      [{ text: '❌ Cancel', callback_data: `cgb_se_x_${token}` }],
    ] } });
});

async function handleEmailChangeButton(data, chatId, msgId, adminId) {
  const [, , choice, token] = data.split('_');
  const edit = pendingEmailChanges.get(token);
  pendingEmailChanges.delete(token);                 // one tap, one change
  await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(() => {});
  if (!edit || Date.now() - edit.at > PENDING_EDIT_MS) { await bot.sendMessage(chatId, '⌛ That change expired — send /setemail again.'); return; }
  if (choice === 'x') { await bot.sendMessage(chatId, '❌ Cancelled — nothing was changed.'); return; }
  const sub = db.prepare('SELECT * FROM chatgpt_subscriptions WHERE id = ?').get(edit.subId);
  if (!sub) { await bot.sendMessage(chatId, '❌ That seat no longer exists.'); return; }
  const lines = await applyEmailChange(sub, edit.email, choice, adminId);
  await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });
}

/** Change a seat's email everywhere (seat, invite bot, customer). Shared by /setemail and request approval. */
async function applyEmailChange(sub, newEmail, choice, adminId, { requested = false } = {}) {
  const edit = { email: newEmail };
  const oldEmail = sub.email;
  const r = cgbSeatTools.changeSeatEmail(db, sub, edit.email);
  const lines = [`✅ <b>Email changed</b>${sub.order_id ? ` · order #${sub.order_id}` : ''}`,
    `<code>${escapeHtml(oldEmail || '—')}</code> → <b><code>${escapeHtml(edit.email)}</code></b>`];
  if (r.changed.length > 1) lines.push(`↪️ also on its renewal that is not active yet`);

  // the invite bot
  const panelId = cgbGuard.panelForSub(sub);
  if (sub.status !== 'active' && oldEmail) {
    const c = await cgbGuard.cancelGuardInvite(oldEmail, { orderId: sub.order_id, endDate: sub.end_date }).catch(() => 'unreachable');
    lines.push(`🗑 Old email's waiting invite: ${escapeHtml(typeof c === 'string' ? c : (c && c.status) || 'asked to cancel')}`);
  }
  if (sub.status === 'active' && oldEmail && panelId) {
    const w = await cgbGuard.whitelistInGuard({ panel: panelId, email: oldEmail, action: 'remove' });
    lines.push(w.ok ? `➖ Old email taken off the whitelist of <b>${escapeHtml(w.panelName)}</b>` : `⚠️ Old email not taken off the whitelist: ${escapeHtml(w.reason)}`);
  }
  if (choice === 'i') {
    const h = await handOverToGuard(edit.email, sub.order_id, sub.end_date);
    lines.push(h && h.ok ? `📨 New email handed to the invite bot${h.panel ? ` (panel <code>${escapeHtml(h.panel)}</code>)` : ''} — it is invited in the next batch`
                         : `⚠️ New email NOT handed to the invite bot — invite it yourself`);
  } else if (panelId) {
    const w = await cgbGuard.whitelistInGuard({ panel: panelId, email: edit.email, expiresOn: sub.end_date, note: `email changed · seat ${sub.id}`, source: 'store' });
    lines.push(w.ok ? `➕ New email on the whitelist of <b>${escapeHtml(w.panelName)}</b> until ${sub.end_date} — invite it yourself`
                    : `⚠️ New email not whitelisted: ${escapeHtml(w.reason)}`);
  }
  if (sub.status === 'active' && oldEmail) lines.push(`\n<i>The old email is still a MEMBER of the workspace until you remove it (invite bot → 👥 Members → 🗑).</i>`);

  let told = false;
  try {
    await bot.sendMessage(Number(sub.user_id),
      (requested ? `✅ <b>Your email change request was approved</b>\n\n` : '') +
      `📧 <b>Your ChatGPT Business seat now uses a new email</b>\n\n` +
      `before: <code>${escapeHtml(oldEmail || '—')}</code>\nnow: <b><code>${escapeHtml(edit.email)}</code></b>\n` +
      `📅 Until <b>${sub.end_date}</b>\n\n` +
      (choice === 'i' ? 'An invitation will reach the new email shortly — accept it from that inbox.' : 'You will receive the invitation on the new email.'),
      { parse_mode: 'HTML' });
    told = true;
  } catch (_) {}
  lines.push(told ? '📨 The customer was told.' : '⚠️ The customer could not be messaged — tell him yourself.');
  logger.info(`[CGB] seat ${sub.id} email ${oldEmail} -> ${edit.email} by ${adminId} (${choice})`);
  return lines;
}

// ════════════════════════════════════════════════════════════════
// V156.4: 📧 EMAIL CHANGE REQUESTS — the customer asks, the admin decides
// ════════════════════════════════════════════════════════════════
function ensureEmailReqTable() {
  db.exec(`CREATE TABLE IF NOT EXISTS cgb_email_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT, sub_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
    old_email TEXT, new_email TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now')), decided_at TEXT, decided_how TEXT)`);
}

function pendingEmailRequests() {
  ensureEmailReqTable();
  return db.prepare(`SELECT r.*, u.username FROM cgb_email_requests r LEFT JOIN users u ON u.telegram_id = r.user_id
                      WHERE r.status = 'pending' ORDER BY r.id`).all();
}

/** The customer taps 📧 Request an email change on one of his seats. */
async function startEmailRequest(chatId, userId, subId) {
  const sub = queries.getCgbSubById(subId);
  if (!sub || String(sub.user_id) !== String(userId) || !['active', 'pending'].includes(String(sub.status || 'pending'))) {
    await bot.sendMessage(chatId, '❌ That seat is not yours or is no longer running.');
    return;
  }
  ensureEmailReqTable();
  const open = db.prepare(`SELECT new_email FROM cgb_email_requests WHERE sub_id = ? AND status = 'pending'`).get(sub.id);
  setSession(userId, 'EMAIL_REQ', { subId: sub.id });
  await bot.sendMessage(chatId,
    `📧 <b>Change the email of a seat</b>\n\nNow: <code>${escapeHtml(sub.email || '')}</code>\n` +
    (open ? `<i>You already asked for <code>${escapeHtml(open.new_email)}</code> — a new request replaces it.</i>\n` : '') +
    `\nSend the <b>new email</b>. The admin checks it and you get a message when it is done.`,
    { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'cgb_menu' }]] } });
}

/** The customer sent the new email: record the request and tell the admin. */
async function submitEmailRequest(chatId, userId, subId, newEmail) {
  const sub = queries.getCgbSubById(subId);
  if (!sub || String(sub.user_id) !== String(userId)) { await bot.sendMessage(chatId, '❌ That seat is not yours.'); return; }
  const email = String(newEmail).trim().toLowerCase();
  if (!cgbSeatTools.EMAIL_RE.test(email)) {
    setSession(userId, 'EMAIL_REQ', { subId });
    await bot.sendMessage(chatId, '❌ That is not an email. Send it again, or tap /start to stop.');
    return;
  }
  if (email === String(sub.email || '').toLowerCase()) { await bot.sendMessage(chatId, 'ℹ️ That is already the email of this seat.'); return; }
  ensureEmailReqTable();
  db.prepare(`UPDATE cgb_email_requests SET status = 'replaced', decided_at = datetime('now') WHERE sub_id = ? AND status = 'pending'`).run(sub.id);
  const reqId = db.prepare(`INSERT INTO cgb_email_requests (sub_id, user_id, old_email, new_email) VALUES (?, ?, ?, ?)`)
    .run(sub.id, userId, sub.email || '', email).lastInsertRowid;
  await bot.sendMessage(chatId,
    `✅ <b>Request sent</b>\n\n<code>${escapeHtml(sub.email || '')}</code> → <code>${escapeHtml(email)}</code>\n\nYou will get a message when the admin has done it.`,
    { parse_mode: 'HTML' });
  if (!ADMIN_ID) return;
  const u = db.prepare('SELECT username, first_name FROM users WHERE telegram_id = ?').get(Number(userId));
  const who = u?.username ? '@' + u.username : (u?.first_name || String(userId));
  await bot.sendMessage(ADMIN_ID, emailRequestCard({ id: reqId, sub, who, userId, newEmail: email }),
    { parse_mode: 'HTML', reply_markup: emailRequestButtons(reqId) }).catch(() => {});
}

function emailRequestCard({ id, sub, who, userId, newEmail }) {
  return `📧 <b>Email change request #${id}</b>\n\n` +
    `👤 ${escapeHtml(who)} (<code>${userId}</code>)\n` +
    `${sub.order_id ? `🆔 Order #${sub.order_id}` : '🆔 Manual seat'} · 📅 ${sub.start_date || '?'} → <b>${sub.end_date}</b> · ${sub.status === 'active' ? '🟢 active' : '⏳ not activated'}\n` +
    `🏢 ${escapeHtml(workspaceName(sub))}\n\n` +
    `before: <code>${escapeHtml(sub.email || '—')}</code>\nafter: <b><code>${escapeHtml(newEmail)}</code></b>`;
}
function emailRequestButtons(reqId) {
  return { inline_keyboard: [
    [{ text: '✅ Approve + invite the new email (invite bot)', callback_data: `cgb_erq_i_${reqId}` }],
    [{ text: '✅ Approve — I invite it myself', callback_data: `cgb_erq_m_${reqId}` }],
    [{ text: '❌ Refuse', callback_data: `cgb_erq_x_${reqId}` }],
  ] };
}

/** The admin decides a request. One decision per request. */
async function decideEmailRequest(data, chatId, msgId, adminId) {
  const [, , how, idRaw] = data.split('_');
  ensureEmailReqTable();
  const req = db.prepare('SELECT * FROM cgb_email_requests WHERE id = ?').get(Number(idRaw));
  await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(() => {});
  if (!req) { await bot.sendMessage(chatId, '❌ Request not found.'); return; }
  if (req.status !== 'pending') { await bot.sendMessage(chatId, `ℹ️ Request #${req.id} was already ${req.status}.`); return; }
  // claim it first, so a double tap cannot apply it twice
  const claimed = db.prepare(`UPDATE cgb_email_requests SET status = 'deciding' WHERE id = ? AND status = 'pending'`).run(req.id).changes;
  if (!claimed) return;
  const sub = queries.getCgbSubById(req.sub_id);
  if (how === 'x') {
    db.prepare(`UPDATE cgb_email_requests SET status = 'refused', decided_at = datetime('now'), decided_how = 'x' WHERE id = ?`).run(req.id);
    await bot.sendMessage(Number(req.user_id),
      `❌ <b>Your email change request was not accepted</b>\n\nYour seat keeps <code>${escapeHtml(req.old_email || '')}</code>. Contact support if you have a question.`,
      { parse_mode: 'HTML' }).catch(() => {});
    await bot.sendMessage(chatId, `❌ Request #${req.id} refused — the customer was told.`);
    return;
  }
  if (!sub || String(sub.email || '').toLowerCase() !== String(req.old_email || '').toLowerCase()) {
    db.prepare(`UPDATE cgb_email_requests SET status = 'stale', decided_at = datetime('now') WHERE id = ?`).run(req.id);
    await bot.sendMessage(chatId, `⚠️ Request #${req.id} not applied: the seat changed since it was asked (its email is now <code>${escapeHtml(sub ? sub.email : '—')}</code>).`, { parse_mode: 'HTML' });
    return;
  }
  const lines = await applyEmailChange(sub, req.new_email, how, adminId, { requested: true });
  db.prepare(`UPDATE cgb_email_requests SET status = 'approved', decided_at = datetime('now'), decided_how = ? WHERE id = ?`).run(how, req.id);
  await bot.sendMessage(chatId, [`✅ <b>Request #${req.id} approved</b>`, ...lines.slice(1)].join('\n'), { parse_mode: 'HTML' });
}

// ════════════════════════════════════════════════════════════════
// V157: 🖥 CHANGE PANEL — admin only, the customer is not told
// ════════════════════════════════════════════════════════════════
const pendingPanelMoves = new Map();          // token -> { subId, ids, names, cardOrder, at }

async function startPanelChange(chatId, sub) {
  if (!sub || !['active', 'pending'].includes(String(sub.status || 'pending'))) { await bot.sendMessage(chatId, '❌ That seat is not running.'); return; }
  const real = (await cgbGuard.fetchGuardPanelsNamed(6000).catch(() => null)) || [];
  // V157.3: the names given to cycles with no invite bot yet are panels too
  const panels = [...real, ...require('./services/cgbRouting').placeholderPanels().filter((p) => !real.some((r) => r.name === p.name))];
  if (!panels.length) { await bot.sendMessage(chatId, '❌ No panel: none from the invite bot, and no named cycle.'); return; }
  const now = Date.now();
  for (const [k, v] of pendingPanelMoves) if (now - v.at > PENDING_EDIT_MS) pendingPanelMoves.delete(k);
  const token = require('crypto').randomBytes(4).toString('hex');
  pendingPanelMoves.set(token, { subId: sub.id, ids: panels.map((p) => p.id), names: panels.map((p) => p.name), at: now });
  const cur = await seatPanelNow(sub, panels);
  const icon = { running: '🟢', stopped: '⚪', paused: '⏸', waiting: '⏳', noBot: '🏷' };
  const rows = panels.slice(0, 20).map((p, i) => [{ text: `${p.id === cur ? '📍 ' : ''}${icon[p.state] || '•'} ${p.name}${p.placeholder ? ' (no bot yet)' : ''}`.slice(0, 60), callback_data: `cgb_cpp_${token}_${i}` }]);
  rows.push([{ text: '❌ Cancel', callback_data: `cgb_cpd_${token}_x_0` }]);
  const pl = seatPlace(sub);
  await bot.sendMessage(chatId,
    `🖥 <b>Change panel</b> <i>(the customer is not told)</i>\n\n` +
    `${sub.order_id ? `🆔 Order #${sub.order_id}` : '🆔 Manual seat'} · <code>${escapeHtml(sub.email || '')}</code>\n` +
    `📅 ${sub.start_date || '?'} → ${sub.end_date} · ${sub.status === 'active' ? '🟢 active' : '⏳ not activated'}\n` +
    `📍 Now: <b>${pl.panel || '—'}</b>${pl.cycle ? ` · 🗓 ${pl.cycle}` : ''}\n\nMove it to:`,
    { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } });
}

async function handlePanelMoveButton(data, chatId, msgId, adminId) {
  let m = /^cgb_cp_(\d+)$/.exec(data);
  if (m) { await startPanelChange(chatId, queries.getCgbSubscriptionByOrder(Number(m[1]))); return; }
  m = /^cgb_cpp_([0-9a-f]{8})_(\d+)$/.exec(data);
  if (m) {
    const st = pendingPanelMoves.get(m[1]);
    if (!st) { await bot.sendMessage(chatId, '⌛ That choice expired — tap 🖥 Change panel again.'); return; }
    const i = Number(m[2]);
    const sub = queries.getCgbSubById(st.subId);
    const from = await seatPanelNow(sub);
    if (st.ids[i] === from) { await bot.sendMessage(chatId, 'ℹ️ It is already in that panel.'); return; }
    const active = sub.status === 'active';
    const toName = cgbGuard.isPlaceholderPanel(st.ids[i]);              // V157.3: a name with no invite bot yet
    await bot.editMessageText(
      `🖥 <b>Move</b> <code>${escapeHtml(sub.email || '')}</code>\n\n📍 ${escapeHtml((st.ids.indexOf(from) >= 0 ? st.names[st.ids.indexOf(from)] : cgbGuard.panelNameCached(from)) || '—')} → <b>${escapeHtml(st.names[i])}</b>\n\n` +
      (toName
        ? `<i>🏷 That panel has no invite bot yet: the seat takes its name and nothing is sent anywhere — invite it yourself. When its bot exists, linking its cycle moves it there.</i>`
        : active
        ? '<i>It is active: it is taken off the old panel\'s whitelist and put on the new one with its end date. Remove it from the old workspace yourself (invite bot → 👥 Members → 🗑) when you want.</i>'
        : '<i>Not activated yet: its waiting invite is cancelled in the old panel and it goes to the new one.</i>') +
      `\n\nThe customer is <b>not</b> told.`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: toName ? [
        [{ text: '✅ Move — I invite it myself', callback_data: `cgb_cpd_${m[1]}_m_${i}` }],
        [{ text: '❌ Cancel', callback_data: `cgb_cpd_${m[1]}_x_0` }],
      ] : [
        [{ text: '✅ Move + invite it in the new panel (invite bot)', callback_data: `cgb_cpd_${m[1]}_i_${i}` }],
        [{ text: '✅ Move — I invite it myself', callback_data: `cgb_cpd_${m[1]}_m_${i}` }],
        [{ text: '❌ Cancel', callback_data: `cgb_cpd_${m[1]}_x_0` }],
      ] } }).catch(() => {});
    return;
  }
  m = /^cgb_cpd_([0-9a-f]{8})_([imx])_(\d+)$/.exec(data);
  if (!m) return;
  const st = pendingPanelMoves.get(m[1]);
  pendingPanelMoves.delete(m[1]);                       // one tap, one move
  await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(() => {});
  if (m[2] === 'x') { await bot.sendMessage(chatId, '❌ Cancelled — nothing was moved.'); return; }
  if (!st) { await bot.sendMessage(chatId, '⌛ That choice expired — tap 🖥 Change panel again.'); return; }
  const sub = queries.getCgbSubById(st.subId);
  if (!sub) { await bot.sendMessage(chatId, '❌ That seat no longer exists.'); return; }
  const lines = await applyPanelMove(sub, st.ids[Number(m[3])], m[2], adminId);
  await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });
}

/**
 * V157.1: after new dates put a seat in another cycle, its panel did not follow — an active seat kept the
 * panel it was activated in (the card still said "Panel 26"). When the new end belongs to a cycle linked
 * to ANOTHER panel, the admin is offered the move in one tap (or to keep it where it is).
 */
async function suggestPanelAfterDates(orderId, oldEnd) {
  if (!ADMIN_ID) return;
  const sub = queries.getCgbSubscriptionByOrder(orderId);
  if (!sub || !['active', 'pending'].includes(String(sub.status || 'pending'))) return;
  let expected = cgbGuard.panelForSeat(sub.end_date);                // the panel linked to the NEW dates' cycle
  const phNew = require('./services/cgbRouting').placeholderFor(sub.end_date);
  if (!expected && phNew) expected = `ph:${phNew}`;                    // V157.3: a cycle with only a name
  if (!expected) return;
  const real = (await cgbGuard.fetchGuardPanelsNamed(6000).catch(() => null)) || [];
  const panels = [...real, ...require('./services/cgbRouting').placeholderPanels().filter((p) => !real.some((r) => r.name === p.name))];
  const byName = (n) => (panels.find((p) => p.name === n) || {}).id;
  const current = cgbGuard.seatPanelOf(sub.id)
    || (sub.status === 'active' && sub.workspace ? (byName(sub.workspace) || '') : '')
    || cgbGuard.panelForSeat(oldEnd || sub.end_date);   // (same rule as seatPanelNow, with the OLD end for a seat not activated)
  if (!current || current === expected) return;
  const i = panels.findIndex((p) => p.id === expected);
  if (i < 0) return;
  const token = require('crypto').randomBytes(4).toString('hex');
  pendingPanelMoves.set(token, { subId: sub.id, ids: panels.map((p) => p.id), names: panels.map((p) => p.name), at: Date.now() });
  const curName = (panels.find((p) => p.id === current) || {}).name || current;
  const newName = panels[i].name;
  await bot.sendMessage(ADMIN_ID,
    `🖥 <b>Order #${orderId}: new dates, other panel?</b>\n\n<code>${escapeHtml(sub.email || '')}</code> now ends <b>${escapeHtml(String(sub.end_date))}</b> — ` +
    `that cycle (${escapeHtml(cgbSeatTools.cycleLabel(db, sub.end_date) || '?')}) is linked to <b>${escapeHtml(newName)}</b>, ` +
    `but the seat is in <b>${escapeHtml(curName)}</b>.\n\n<i>The customer is not told.</i>`,
    { parse_mode: 'HTML', reply_markup: { inline_keyboard: [
      [{ text: `✅ Move to ${newName} + invite (invite bot)`.slice(0, 60), callback_data: `cgb_cpd_${token}_i_${i}` }],
      [{ text: `✅ Move to ${newName} — I invite it`.slice(0, 60), callback_data: `cgb_cpd_${token}_m_${i}` }],
      [{ text: `Keep it in ${curName}`.slice(0, 60), callback_data: `cgb_cpd_${token}_x_0` }],
    ] } });
}

/** Where a seat really is now: the admin's choice, else (active) the workspace it was activated in, else its cycle's panel. */
async function seatPanelNow(sub, panels = null) {
  const chosen = cgbGuard.seatPanelOf(sub.id);
  if (chosen) return chosen;
  if (sub.status === 'active' && sub.workspace) {
    const list = panels || (await cgbGuard.fetchGuardPanelsNamed(6000).catch(() => null)) || [];
    const hit = list.find((p) => p.name === sub.workspace || p.id === sub.workspace)
      || require('./services/cgbRouting').placeholderPanels().find((p) => p.name === sub.workspace);   // V157.3
    if (hit) return hit.id;
  }
  return cgbGuard.panelForSub(sub);
}

/** Move one seat to another panel. The customer is NOT told. */
async function applyPanelMove(sub, newPanel, mode, adminId) {
  const oldPanel = await seatPanelNow(sub);
  const active = sub.status === 'active';
  const lines = [];
  // a waiting invite is cancelled where it is BEFORE the seat points elsewhere
  if (!active && sub.email) {
    const c = await cgbGuard.cancelGuardInvite(sub.email, { orderId: sub.order_id, endDate: sub.end_date }).catch(() => 'unreachable');
    lines.push(`🗑 Waiting invite in the old panel: ${escapeHtml(typeof c === 'string' ? c : 'asked to cancel')}`);
  }
  cgbGuard.setSeatPanel(sub.id, newPanel);
  const newName = await cgbGuard.panelNameOf(newPanel).catch(() => newPanel);
  lines.unshift(`✅ <b>Moved</b> <code>${escapeHtml(sub.email || '')}</code> → <b>${escapeHtml(newName)}</b>${sub.order_id ? ` · order #${sub.order_id}` : ''}`);
  if (active && oldPanel && oldPanel !== newPanel && sub.email) {
    const w = await cgbGuard.whitelistInGuard({ panel: oldPanel, email: sub.email, action: 'remove' });
    lines.push(w.ok ? `➖ Off the whitelist of <b>${escapeHtml(w.panelName)}</b>` : `⚠️ Not taken off the old whitelist: ${escapeHtml(w.reason)}`);
  }
  if (cgbGuard.isPlaceholderPanel(newPanel)) {
    lines.push(`🏷 <b>${escapeHtml(newName)}</b> has no invite bot yet — nothing was sent; invite it yourself in that workspace.`);
  } else if (mode === 'i' && sub.email) {
    const h = await handOverToGuard(sub.email, sub.order_id, sub.end_date);
    lines.push(h && h.ok ? `📨 Handed to the invite bot — invited in <b>${escapeHtml(newName)}</b> in the next batch` : '⚠️ NOT handed to the invite bot — invite it yourself');
  } else if (sub.email) {
    const w = await cgbGuard.whitelistInGuard({ panel: newPanel, email: sub.email, expiresOn: sub.end_date, note: `moved · seat ${sub.id}`, source: 'store' });
    lines.push(w.ok ? `➕ On the whitelist of <b>${escapeHtml(w.panelName)}</b> until ${sub.end_date} — invite it yourself` : `⚠️ Not whitelisted: ${escapeHtml(w.reason)}`);
  }
  if (active) { try { queries.setCgbWorkspace(sub.id, newName); } catch (_) {} }
  if (sub.order_id) await repaintSeatCard(sub.order_id).catch(() => {});
  if (active && oldPanel && oldPanel !== newPanel) lines.push(`\n<i>It is still a MEMBER of the old workspace until you remove it there.</i>`);
  lines.push('🔕 The customer was not told.');
  logger.info(`[CGB] seat ${sub.id} panel ${oldPanel || '—'} -> ${newPanel} by ${adminId} (${mode})`);
  return lines;
}

bot.onText(/^\/setpanel(?:@\w+)?(?:\s+(.*))?$/i, async (msg, match) => {
  if (String(msg.from.id) !== String(ADMIN_ID)) return;
  const ref = String((match && match[1]) || '').trim();
  if (!ref) { await bot.sendMessage(msg.chat.id, 'Usage: <code>/setpanel 23586</code> or <code>/setpanel email@gmail.com</code>', { parse_mode: 'HTML' }); return; }
  const f = cgbSeatTools.findSeat(db, ref);
  if (f.error) { await bot.sendMessage(msg.chat.id, `❌ ${escapeHtml(f.error)}`, { parse_mode: 'HTML' }); return; }
  await startPanelChange(msg.chat.id, f.sub);
});

// ── V156.7: 💙 paid renewals, each with its panel and cycle ──
async function showPaidRenewals(chatId) {
  const today = ymdLocal(cgbCycles.localNow(new Date()));
  const rows = cgbSeatTools.paidRenewals(db, today, 20);
  if (!rows.length) { await bot.sendMessage(chatId, '💙 No paid renewal waiting, none activated in the last 20 days.'); return; }
  const groups = new Map();
  for (const r of rows) {
    const pl = seatPlace(r);
    const key = `${pl.panel || '—'}${pl.cycle ? ` · 🗓 ${pl.cycle}` : ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const waiting = rows.filter((r) => r.status !== 'active').length;
  let txt = `💙 <b>Paid renewals</b> — 🔵 ${waiting} to activate · 🟢 ${rows.length - waiting} activated (20 days)\n`;
  const blocks = [];
  for (const [place, list] of groups) {
    txt += `\n🖥 <b>${place}</b> · ${list.length}\n`;
    for (const r of list) {
      const who = r.username ? `@${escapeHtml(r.username)}` : `<code>${r.user_id}</code>`;
      txt += `${r.status === 'active' ? '🟢' : '🔵'} <code>${escapeHtml(r.email)}</code> — ${who}${r.order_id ? ` · #${r.order_id}` : ''} · ${r.start_date} → ${r.end_date}\n`;
    }
    blocks.push({ place, emails: list.map((r) => r.email) });
  }
  for (const chunk of txt.match(/[\s\S]{1,3800}(?=\n|$)/g) || [txt]) await bot.sendMessage(chatId, chunk, { parse_mode: 'HTML' });
  for (const b of blocks) {
    await bot.sendMessage(chatId, `🖥 <b>${b.place}</b>\n<code>${escapeHtml(b.emails.join('\n'))}</code>`, { parse_mode: 'HTML' }).catch(() => {});
  }
}

async function showEmailRequests(chatId) {
  const list = pendingEmailRequests();
  if (!list.length) { await bot.sendMessage(chatId, '📧 No email change request is waiting.'); return; }
  for (const r of list.slice(0, 15)) {
    const sub = queries.getCgbSubById(r.sub_id);
    if (!sub) continue;
    await bot.sendMessage(chatId, emailRequestCard({ id: r.id, sub, who: r.username ? '@' + r.username : String(r.user_id), userId: r.user_id, newEmail: r.new_email }),
      { parse_mode: 'HTML', reply_markup: emailRequestButtons(r.id) });
  }
}

// ── /checkrenewals — paid renewals not yet activated whose dates disagree with the customer's cycle ──
bot.onText(/^\/checkrenewals(?:@\w+)?$/i, async (msg) => {
  if (String(msg.from.id) !== String(ADMIN_ID)) return;
  // V156.3: "renewals" sold to a DIFFERENT email than the seat they renew (the Change-Email bug).
  const mism = cgbSeatTools.mismatchedRenewals(db);
  if (mism.length) {
    let t = `🧩 <b>${mism.length} "renewal(s)" on a different email</b>\nThese were new seats: the email was changed during a renewal, so they got the old seat's dates and were linked to it.\n`;
    const kb = [];
    for (const r of mism.slice(0, 15)) {
      t += `\n• ${r.order_id ? `<b>#${r.order_id}</b>` : 'manual'} · <code>${escapeHtml(r.email)}</code> — linked to <code>${escapeHtml(r.prev_email)}</code>\n` +
           `   has ${r.start_date} → ${r.end_date} · ${r.status === 'active' ? '🟢 active' : '⏳ not activated'}`;
      kb.push([{ text: `🆕 #${r.order_id || r.id}: treat as a new seat`, callback_data: `cgb_unlink_${r.id}` }]);
    }
    t += `\n\n<i>"Treat as a new seat" removes the wrong link (the old seat shows as NOT renewed again and gets its reminders). Then check its dates with ✏️ Change dates on its card.</i>`;
    await bot.sendMessage(msg.chat.id, t, { parse_mode: 'HTML', reply_markup: { inline_keyboard: kb } });
  }
  const a = cgbSeatDates.auditRenewals(new Date());
  if (!a.checked) { await bot.sendMessage(msg.chat.id, '🔎 No paid renewal is waiting for activation.'); return; }
  let txt = `🔎 <b>Renewals check</b>\n${a.checked} paid renewal(s) waiting for activation · ✅ ${a.ok.length} right · ⚠️ ${a.bad.length} to look at\n`;
  for (const b of a.bad) {
    txt += `\n⚠️ <b>#${b.orderId}</b> · ${escapeHtml(b.who)} · <code>${escapeHtml(b.email || '')}</code>\n` +
           `   has: ${b.has.start} → ${b.has.end} (${b.has.days} days) · paid <b>$${b.has.paid.toFixed(2)}</b>\n` +
           `   own cycle: <b>${b.should.start} → ${b.should.end}</b> (${b.should.days} days, ${b.should.months} month${b.should.months > 1 ? 's' : ''}) · price <b>$${b.should.price.toFixed(2)}</b>\n` +
           (b.has.paid - b.should.price > 0.05
             ? `   💸 overpaid by <b>$${(b.has.paid - b.should.price).toFixed(2)}</b> — credit it with ➕ Add User Balance (<code>${b.userId}</code>) after you change the dates\n`
             : (b.should.price - b.has.paid > 0.05 ? `   ⚠️ paid <b>$${(b.should.price - b.has.paid).toFixed(2)}</b> less than that period costs\n` : '')) +
           `   <code>/setdates ${b.orderId} ${b.should.start} ${b.should.end}</code>\n`;
  }
  if (a.bad.length) txt += `\n<i>Tap a command to copy it. Check the months before using it: they are guessed from the length. /setdates changes the DATES only — the price paid stays, so settle any difference yourself.</i>`;
  else txt += `\n✅ Every one matches its customer's own cycle.`;
  await bot.sendMessage(msg.chat.id, txt, { parse_mode: 'HTML' });
});


/** The fields the order card shows, rebuilt from the database for one order. */
function seatCardData(orderId) {
  const sub = queries.getCgbSubscriptionByOrder(orderId);
  if (!sub) return null;
  const ord = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  const u = db.prepare('SELECT username, first_name FROM users WHERE telegram_id = ?').get(Number(sub.user_id));
  const who = u?.username ? '@' + u.username : (u?.first_name || `User ${sub.user_id}`);
  return {
    sub, ord,
    card: {
      orderId, userId: sub.user_id, days: sub.days_remaining,
      name: escapeHtml(who), email: escapeHtml(sub.email || '—'),
      startDate: sub.start_date || '—', endDate: sub.end_date || '—',
      paid: Number(sub.final_price ?? ord?.total_price ?? 0).toFixed(2),
      method: ord?.payment_method || '—', refLabel: 'Order', ref: String(orderId),
      kind: seatKindLine(sub.renewed_from),
      renewal: !!sub.renewed_from,
      ...seatPlace(sub),
    },
  };
}

/**
 * Cancel a not-yet-activated ChatGPT Business order (the customer asked for a
 * refund). One shared path, returns { ok, reason?, refunded, amount, guard }.
 *
 * Order of operations matters:
 *   1. flip the seat to 'cancelled' with a conditional UPDATE (only if it is
 *      not already active/cancelled) — this is the lock: if the invite bot's
 *      success callback activated it a moment earlier, changes === 0 and
 *      NOTHING is refunded;
 *   2. only then refund, through the shop's own all-or-nothing refundWallet,
 *      under a fixed ref id so a double tap can never refund twice;
 *   3. tell the invite bot to drop the email from its queue, so no seat is
 *      bought for someone who got their money back.
 */
async function cancelSeatOrder(orderIdRaw, { refundToWallet }) {
  const orderId = parseInt(orderIdRaw, 10);
  const data = seatCardData(orderId);
  if (!data) return { ok: false, reason: `no subscription found for order #${orderId}` };
  const { sub } = data;
  if (sub.status === 'active') return { ok: false, reason: 'the seat is already activated — cancel it in the workspace instead' };
  if (sub.status === 'cancelled') return { ok: false, reason: 'already cancelled' };

  const flipped = db.prepare(`
    UPDATE chatgpt_subscriptions SET status = 'cancelled', updated_at = datetime('now')
    WHERE order_id = ? AND COALESCE(status, '') NOT IN ('active', 'cancelled')
  `).run(orderId).changes;
  if (!flipped) return { ok: false, reason: 'the order changed a moment ago (activated or cancelled) — nothing was refunded' };
  db.prepare(`UPDATE orders SET status = 'cancelled' WHERE id = ?`).run(orderId);

  const amount = Number(sub.final_price ?? data.ord?.total_price ?? 0);
  let refunded = false;
  if (refundToWallet && amount > 0) {
    const refId = `cgb_cancel_${orderId}`;
    if (!queries.isRefIdUsed(refId)) {
      queries.refundWallet(Number(sub.user_id), amount, {
        refId, orderId, description: `Refund — ChatGPT Business order #${orderId} cancelled`,
      });
      refunded = true;
    }
  }

  const guard = await cgbGuard.cancelGuardInvite(sub.email, { orderId, endDate: sub.end_date }).catch(() => 'unreachable');

  try {
    await bot.sendMessage(Number(sub.user_id),
      `❌ <b>Your ChatGPT Business order #${orderId} has been cancelled.</b>\n\n` +
      (refunded
        ? `💰 <b>$${amount.toFixed(2)}</b> has been refunded to your wallet balance.`
        : `Our support team will handle your refund with you.`),
      { parse_mode: 'HTML' });
  } catch (e) {
    logger.warn(`cancelSeatOrder: could not message customer ${sub.user_id}: ${e.message}`);
  }
  logger.info(`[CGB] order #${orderId} cancelled (wallet refund: ${refunded ? '$' + amount.toFixed(2) : 'no'}, invite bot: ${guard})`);
  return { ok: true, refunded, amount, guard };
}

/** What the invite bot said, in one line for the admin card. */
function guardCancelLine(guard) {
  switch (guard) {
    case 'removed':         return '🤖 Removed from the invite queue — no seat will be bought.';
    case 'processing':      return '⚠️ The invite bot was buying/inviting it RIGHT NOW — check ChatGPT and revoke the invite if it went out.';
    case 'already_invited': return '⚠️ Already invited in ChatGPT — revoke the pending invite (or remove the member) by hand.';
    case 'unreachable':     return '⚠️ Could not reach the invite bot — check its /queue and remove this email.';
    default:                return '';   // not queued there, or the integration is off
  }
}

async function createSeatManually(chatId, target, email, endDate, adminId, { panelId = '' } = {}) {
  const today = new Date();
  const days = Math.max(0, Math.ceil(
    (new Date(`${endDate}T23:59:00`) - today) / 86400000));
  const monthly = cgbCycles.getMonthlyPrice(target);
  const price = Number(((days / 30) * monthly).toFixed(2));

  try {
    db.prepare('INSERT OR IGNORE INTO users (telegram_id) VALUES (?)').run(target);
    let ws = db.prepare(`SELECT value FROM settings WHERE key='cgb_workspace_name'`).get()?.value || 'chatgpt_Team';
    // V155: in a chosen panel — whitelisted there with its end date; the seat records the panel's name.
    let wl = null;
    if (panelId) {
      wl = await cgbGuard.whitelistInGuard({ panel: panelId, email, expiresOn: endDate, note: `manual seat · user ${target}`, source: 'store' });
      if (wl.ok) ws = wl.panelName || ws;
      else {
        await bot.sendMessage(chatId, `❌ Not saved — the invite bot refused: ${escapeHtml(wl.reason)}`, { parse_mode: 'HTML' });
        return;
      }
    }

    // order_id 0 marks a seat with no order behind it in this bot. Status is
    // 'active' rather than 'awaiting_payment': the admin is stating a fact, not
    // starting a checkout, so there is no payment to wait for.
    db.prepare(`
      INSERT INTO chatgpt_subscriptions
        (order_id, user_id, email, start_date, end_date, days_remaining,
         base_price, extra_month, final_price, status, workspace)
      VALUES (0, ?, ?, ?, ?, ?, ?, 0, ?, 'active', ?)
    `).run(target, email, formatDate(today), endDate, days, price, price, ws);

    await bot.sendMessage(chatId,
      `✅ <b>Seat added</b>\n\n` +
      `📧 <code>${escapeHtml(email)}</code>\n` +
      `👤 <code>${target}</code>\n` +
      `📅 Ends <b>${endDate}</b> (${days} day${days === 1 ? '' : 's'})\n` +
      `💰 Recorded at <b>$${price.toFixed(2)}</b> · $${monthly.toFixed(2)}/mo\n` +
      (wl && wl.ok ? `🖥 Panel <b>${escapeHtml(ws)}</b> — on its whitelist until ${endDate}\n` : `⬜ No panel\n`) +
      `\n<i>They can now renew it, and will be reminded before it expires.</i>`,
      { parse_mode: 'HTML' });

    await bot.sendMessage(target,
      `🤖 <b>Your ChatGPT Business seat is active</b>\n\n` +
      `📧 <code>${escapeHtml(email)}</code>\n` +
      (wl && wl.ok ? `🖥 Workspace: <b>${escapeHtml(ws)}</b>\n` : '') +
      `📅 Until <b>${endDate}</b>\n\n` +
      `Send /menu any time to renew it or see the details.`,
      { parse_mode: 'HTML' }).catch(() => {
      bot.sendMessage(chatId, 'ℹ️ Seat saved, but the customer has not started this bot yet — they will see it when they do.');
    });
    logger.info(`[CGB] seat added manually for ${target} until ${endDate} by ${adminId}`);
  } catch (e) {
    await bot.sendMessage(chatId, `❌ Could not save: ${e.message}`);
  }
}

bot.on('callback_query', async (q) => {
  const userId = q.from.id;
  const chatId = q.message.chat.id;
  const msgId  = q.message.message_id;
  const data   = q.data;

  await bot.answerCallbackQuery(q.id).catch(() => {});

  // ── V156: 🛠 admin panel buttons ───────────────────────────────────────────
  if (await handleAdminPanelButton(data, chatId, msgId, userId)) return;

  // ── Admin: renewals dashboard ──────────────────────────────────────────────
  if (data.startsWith('rnw_')) {
    if (String(userId) !== String(ADMIN_ID)) return;
    await handleRenewalsCallback(q);
    return;
  }

  // ── Admin: cancel an order (customer asked for a refund) ───────────────────
  if (data.startsWith('cgb_ocx_')) {
    if (String(userId) !== String(ADMIN_ID)) return;
    const [, , step, orderIdStr] = data.split('_');   // cgb_ocx_<step>_<orderId>
    const orderId = parseInt(orderIdStr, 10);
    const found = seatCardData(orderId);
    if (!found) { await bot.sendMessage(chatId, `❌ Order #${orderId} not found.`); return; }
    const amount = Number(found.card.paid);

    if (step === 'ask') {
      await bot.editMessageReplyMarkup({ inline_keyboard: [
        [{ text: `💰 Cancel + refund $${amount.toFixed(2)} to wallet`, callback_data: `cgb_ocx_wallet_${orderId}` }],
        [{ text: '🚫 Cancel only (refunded outside)', callback_data: `cgb_ocx_plain_${orderId}` }],
        [{ text: '↩️ Back', callback_data: `cgb_ocx_back_${orderId}` }],
      ] }, { chat_id: chatId, message_id: msgId }).catch(() => {});
      return;
    }
    if (step === 'back') {
      await bot.editMessageReplyMarkup(orderCardButtons(found.card), { chat_id: chatId, message_id: msgId }).catch(() => {});
      return;
    }
    if (step === 'wallet' || step === 'plain') {
      const r = await cancelSeatOrder(orderId, { refundToWallet: step === 'wallet' });
      if (!r.ok) {
        await bot.sendMessage(chatId, `❌ Could not cancel order #${orderId}: ${r.reason}`);
        return;
      }
      const note =
        (r.refunded
          ? `💰 <i>Cancelled — $${r.amount.toFixed(2)} refunded to the customer's wallet. The customer has been told.</i>`
          : `🚫 <i>Cancelled — refund handled outside the bot. The customer has been told.</i>`) +
        (guardCancelLine(r.guard) ? `\n${guardCancelLine(r.guard)}` : '');
      await bot.editMessageText(orderCard(found.card, false, false, note), {
        chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '⚫ Cancelled', callback_data: 'noop' }]] },
      }).catch(async () => {
        await bot.sendMessage(chatId, `⚫ Order #${orderId} cancelled.\n${note}`, { parse_mode: 'HTML' }).catch(() => {});
      });
      return;
    }
    return;
  }

  // ── Admin: Notify customer that subscription is activated ──────────────────
  if (data.startsWith('cgb_notify_')) {
    if (String(userId) !== String(ADMIN_ID)) return;
    // format: cgb_notify_{orderId}_{customerId}_{days}_{endDate} — only
    // orderId is actually used now (customerId/days/endDate are re-read
    // from the DB by activateAndNotifySeat, so a stale/edited callback_data
    // can't send someone the wrong duration or expiry date).
    const orderId = data.split('_')[2];
    const result = await activateAndNotifySeat(orderId, { chatId, msgId });
    if (!result.ok) {
      await bot.sendMessage(chatId, `❌ Could not notify customer: ${result.reason}`);
    }
    return;
  }

  // ── an ACTIVE seat's date change: apply and tell / apply silently / cancel ───
  if (data.startsWith('cgb_sd_')) {
    if (await handleDateEditButton(data, userId, chatId)) return;
  }

  // ── ✏️ Change dates: shows the command, pre-filled ──────────────────────────
  if (/^cgb_dates_\d+$/.test(data)) {
    if (String(userId) !== String(ADMIN_ID)) return;
    const orderId = parseInt(data.split('_').pop(), 10);
    const seat = seatCardData(orderId);
    if (!seat || (seat.sub.status !== 'pending' && seat.sub.status !== 'active')) {
      await bot.sendMessage(chatId, '❌ Only a paid seat — activated or not — can be changed (not a cancelled, unpaid or expired one).');
      return;
    }
    let hint = '';
    if (seat.sub.renewed_from) {
      const prev = queries.getCgbSubById(seat.sub.renewed_from);
      if (prev) {
        const e = cgbSeatDates.expectedRenewal(seat.sub.user_id, prev.end_date, 1, new Date());
        hint = `\n💡 This customer's own cycle gives, for 1 month: <b>${e.start} → ${e.end}</b> (${e.days} days) · price <b>$${e.price.toFixed(2)}</b> — paid <b>$${Number(seat.sub.final_price).toFixed(2)}</b>\n` +
               `<code>/setdates ${orderId} ${e.start} ${e.end}</code>\n`;
      }
    }
    await bot.sendMessage(chatId,
      `✏️ <b>Change dates — order #${orderId}</b>\n` +
      `now: ${seat.sub.start_date} → ${seat.sub.end_date} (${seat.sub.days_remaining} days)\n` + hint +
      `\nSend (first day, last day):\n<code>/setdates ${orderId} ${seat.sub.start_date} ${seat.sub.end_date}</code>\n` +
      (seat.sub.status === 'active'
        ? `<i>This seat is ACTIVE: before anything changes you will see what the customer would receive and choose whether to tell him. You can add a note at the end of the command, e.g. …  your account was moved to a new panel.</i>`
        : `<i>Change the two dates, then send it.</i>`), { parse_mode: 'HTML' });
    return;
  }

  // ── Manual seat: the admin picked a cycle ──────────────────────────────────
  if (/^cgb_seat_/.test(data)) {
    if (String(userId) !== String(ADMIN_ID)) return;   // silent for everyone else
    const m = /^cgb_seat_([0-9a-f]{8})_(\d+)$/.exec(data);
    const pick = m && pendingSeatPicks.get(m[1]);
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(() => {});
    if (!pick || !pick.ends[Number(m[2])]) { await bot.sendMessage(chatId, '⌛ That choice expired — start again with ➕ Add a seat.'); return; }
    pendingSeatPicks.delete(m[1]);
    const payload = { u: pick.u, e: pick.e, d: pick.ends[Number(m[2])] };
    await askSeatPanel(chatId, payload.u, payload.e, payload.d);
    return;
  }

  // V155: the panel of a hand-added seat
  {
    const m = /^cgb_sp_([0-9a-f]{8})_(n|\d+)$/.exec(data);
    if (m) {
      if (String(userId) !== String(ADMIN_ID)) return;
      const st = pendingSeatPanels.get(m[1]);
      pendingSeatPanels.delete(m[1]);                   // one tap, one seat
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(() => {});
      if (!st) { await bot.sendMessage(chatId, '⌛ That choice expired — send /addseat again.'); return; }
      const panelId = m[2] === 'n' ? '' : (st.ids[Number(m[2])] || '');
      await createSeatManually(chatId, st.u, st.e, st.d, userId, { panelId });
      return;
    }
  }

  // V157: 🖥 change panel (admin only)
  if (/^cgb_cp(p|d)?_/.test(data)) {
    if (String(userId) !== String(ADMIN_ID)) return;
    await handlePanelMoveButton(data, chatId, msgId, userId);
    return;
  }

  // V156.9: late renewals
  {
    let m = /^cgb_lreq_(\d+)$/.exec(data);
    if (m) { await startLateRequest(chatId, userId, Number(m[1])); return; }
    m = /^cgb_lpay_(\d+)$/.exec(data);
    if (m) { await showLatePayment(chatId, userId, Number(m[1])); return; }
    if (/^cgb_lrq_[ax]_\d+$/.test(data)) {
      if (String(userId) !== String(ADMIN_ID)) return;
      await decideLateRequest(data, chatId, msgId);
      return;
    }
  }

  // V156.4: email change requests
  {
    const m = /^cgb_ereq_(\d+)$/.exec(data);
    if (m) { await startEmailRequest(chatId, userId, Number(m[1])); return; }
    if (/^cgb_erq_[imx]_\d+$/.test(data)) {
      if (String(userId) !== String(ADMIN_ID)) return;
      await decideEmailRequest(data, chatId, msgId, userId);
      return;
    }
  }

  // V156.3: undo a wrong renewal link
  {
    const m = /^cgb_unlink_(\d+)$/.exec(data);
    if (m) {
      if (String(userId) !== String(ADMIN_ID)) return;
      const r = cgbSeatTools.unlinkRenewal(db, Number(m[1]));
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(() => {});
      await bot.sendMessage(chatId, r.ok
        ? `✅ Seat ${r.order_id ? `#${r.order_id}` : r.id} (<code>${escapeHtml(r.email)}</code>) is now a new seat; <code>${escapeHtml(r.prev_email)}</code> shows as not renewed again.\n` +
          (r.order_id ? `Check its dates: <code>/setdates ${r.order_id} …</code> or ✏️ Change dates on its card.` : '')
        : `ℹ️ ${escapeHtml(r.reason)}`, { parse_mode: 'HTML' });
      return;
    }
  }

  // V155: the change of a seat's email
  if (/^cgb_se_[imx]_[0-9a-f]{8}$/.test(data)) {
    if (String(userId) !== String(ADMIN_ID)) return;
    await handleEmailChangeButton(data, chatId, msgId, userId);
    return;
  }

  if (/^cgb_seatdate_/.test(data)) {
    if (String(userId) !== String(ADMIN_ID)) return;
    const m = /^cgb_seatdate_([0-9a-f]{8})_t$/.exec(data);
    const pick = m && pendingSeatPicks.get(m[1]);
    if (!pick) { await bot.sendMessage(chatId, '⌛ That choice expired — start again with ➕ Add a seat.'); return; }
    pendingSeatPicks.delete(m[1]);
    setSession(userId, 'ADMIN_SEAT_DATE', { target: pick.u, email: pick.e });
    await bot.sendMessage(chatId,
      `📅 Send the end date as <code>YYYY-MM-DD</code>\n\nExample: <code>2026-12-31</code>`,
      { parse_mode: 'HTML' });
    return;
  }

  // ── Renewal navigation ─────────────────────────────────────────────────────
  if (data === 'cgb_menu')         { await showMainMenu(chatId, userId, msgId); return; }
  if (data === 'cgb_new')          { await showCalculation(chatId, userId, false); return; }
  if (data === 'cgb_renew_list')   { await showSubList(chatId, userId, 'renew', msgId); return; }
  if (data === 'cgb_details_list') { await showSubList(chatId, userId, 'details', msgId); return; }

  if (/^cgb_(renew|details)_\d+$/.test(data)) {
    const subId = parseInt(data.split('_').pop(), 10);
    const sub = queries.getCgbSubById(subId);
    // Ownership is re-checked here, not just assumed from the list that
    // produced the button: callback_data is client-supplied and can be replayed
    // with any id, which would otherwise expose another customer's email.
    if (!sub || String(sub.user_id) !== String(userId)) {
      await bot.sendMessage(chatId, '❌ Subscription not found.');
      return;
    }
    await showSubDetails(chatId, subId, msgId);
    return;
  }

  if (/^cgb_renew(yes|no)_\d+$/.test(data)) {
    const wantsRenew = data.startsWith('cgb_renewyes_');
    const subId = parseInt(data.split('_').pop(), 10);
    const sub = queries.getCgbSubById(subId);
    if (!sub || String(sub.user_id) !== String(userId)) {
      await bot.sendMessage(chatId, '❌ Subscription not found.');
      return;
    }

    // ── "Will not renew" — a decision, nothing to pay ────────────────────────
    if (!wantsRenew) {
      queries.setCgbRenewIntent(subId, 'no');
      queries.markCgbReminded(subId);
      await notifyAdminRenewal(sub, 'no');
      await bot.sendMessage(chatId,
        `👍 Noted — <code>${escapeHtml(sub.email)}</code> will not be renewed, ` +
        `and we will not remind you again.\n\n` +
        `It stays active until <b>${sub.end_date}</b>. Changed your mind? Tap below any time.`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [
          [{ text: '🔄 Actually, renew it', callback_data: `cgb_renewyes_${subId}` }],
          [{ text: '🔙 Menu', callback_data: 'cgb_menu' }],
        ] } });
      return;
    }

    // ── "Renew" — this is a purchase, so it goes to payment ──────────────────
    // Tapping Renew used to only set a flag, which read as "done" to the
    // customer: they were told the seat was reserved and were never asked for
    // money. A seat is sold per cycle, so a renewal is a new sale.
    queries.setCgbRenewIntent(subId, 'yes');
    queries.markCgbReminded(subId);
    await notifyAdminRenewal(sub, 'yes');
    await showRenewDurations(chatId, userId, subId);
    return;
  }

  // Duration chosen — price it and go to payment.
  if (/^cgb_rendur_\d+_\d+$/.test(data)) {
    const parts  = data.split('_');
    const subId  = parseInt(parts[2], 10);
    const months = parseInt(parts[3], 10);
    await showRenewPayment(chatId, userId, subId, months, msgId);
    return;
  }

  if (data === 'cancel') {
    // Clear the placeholder too. Clearing only the session left the half-made
    // order and its subscription row behind — which is how one email ended up
    // listed six times.
    const sess = getSession(userId);
    if (sess && sess.orderId) {
      try {
        db.prepare(`UPDATE orders SET status='cancelled' WHERE id=? AND status='pending'`).run(sess.orderId);
        queries.dropUnpaidCgbSubscription(sess.orderId);
      } catch (e) {
        logger.warn(`cancel cleanup for order #${sess.orderId}: ${e.message}`);
      }
    }
    clearSession(userId);
    await bot.sendMessage(chatId,
      '❌ Cancelled. Nothing was charged.\n\nUse /start to begin again.',
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
        const newSubId = queries.createCgbSubscription(
          orderId, userId, s.email, s.startDate, s.endDate,
          s.daysRemaining + (s.extraMonth ? (s.extraDays || 30) : 0),
          s.basePrice, s.extraMonth ? 1 : 0, s.finalPrice
        );
        // Records which seat this renews, so the history of one email stays
        // readable instead of looking like unrelated purchases.
        if (s.lateReqId) { try { db.prepare("UPDATE cgb_late_renewals SET status = 'paid' WHERE id = ?").run(s.lateReqId); } catch (_) {} }   // V156.9
        if (s.renewalOf && newSubId) {
          try { const pc = cgbGuard.seatPanelOf(s.renewalOf); if (pc) cgbGuard.setSeatPanel(newSubId, pc); } catch (_) {}   // V157
          try { queries.linkCgbRenewal(s.renewalOf, newSubId); } catch (_) {}
        }
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
        queries.dropUnpaidCgbSubscription(orderId);
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
        const newSubId = queries.createCgbSubscription(
          orderId, userId, s.email, s.startDate, s.endDate,
          s.daysRemaining + (s.extraMonth ? (s.extraDays || 30) : 0),
          s.basePrice, s.extraMonth ? 1 : 0, s.finalPrice
        );
        // Records which seat this renews, so the history of one email stays
        // readable instead of looking like unrelated purchases.
        if (s.lateReqId) { try { db.prepare("UPDATE cgb_late_renewals SET status = 'paid' WHERE id = ?").run(s.lateReqId); } catch (_) {} }   // V156.9
        if (s.renewalOf && newSubId) {
          try { const pc = cgbGuard.seatPanelOf(s.renewalOf); if (pc) cgbGuard.setSeatPanel(newSubId, pc); } catch (_) {}   // V157
          try { queries.linkCgbRenewal(s.renewalOf, newSubId); } catch (_) {}
        }
      } catch (subErr) {
        logger.error('createCgbSubscription failed: ' + subErr.message);
      }

      // Paid in full right here, so the placeholder becomes a real seat now.
      queries.markCgbSubscriptionPaid(orderId);
      await notifyAdminRenewalPaid(orderId, userId, { ...s, paymentMethod: 'balance' });

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
        try { queries.dropUnpaidCgbSubscription(orderId); } catch (_) {}
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
    // V156.3: a renewal continues ONE seat on ONE email. An old "Change Email" button pressed during a renewal
    // used to swap the email while keeping the renewal's dates and its link to the old seat — a brand-new email
    // was then sold the old seat's cycle and recorded as its renewal.
    if (s.renewalOf) {
      await bot.sendMessage(chatId,
        `ℹ️ A renewal keeps the same email (<code>${escapeHtml(s.email || '')}</code>).\n\n` +
        `• To move THIS seat to another email, send a request to the admin.\n` +
        `• For an extra seat on another email, buy a new one: /start → <b>✨ Buy a new seat</b>.`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '📧 Request an email change', callback_data: `cgb_ereq_${s.renewalOf}` }]] } });
      return;
    }
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

  // ─── V156.4: the new email of an email change request ───
  if (s.state === 'EMAIL_REQ') {
    clearSession(userId);
    await submitEmailRequest(chatId, userId, s.subId, text);
    return;
  }

  // ─── V156: the words a 🛠 admin-panel button asked for → run that command ───
  if (s.state === 'ADM_TYPE' && String(userId) === String(ADMIN_ID)) {
    clearSession(userId);
    runAsCommand(chatId, userId, `${s.cmd} ${text}`);
    return;
  }

  // ─── Admin typed an exact end date for a manual seat ───
  if (s.state === 'ADMIN_SEAT_DATE' && String(userId) === String(ADMIN_ID)) {
    const raw = cgbSeatTools.parseDay(text, cgbCycles.localNow(new Date()));
    if (!raw) {
      await bot.sendMessage(chatId, '❌ Use <code>2026-12-31</code>, <code>31/12</code> or <code>+30</code>.', { parse_mode: 'HTML' });
      return;
    }
    clearSession(userId);
    await askSeatPanel(chatId, s.target, s.email, raw);
    return;
  }

  // ─── Awaiting email ───
  if (s.state === 'AWAITING_EMAIL') {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
      await bot.sendMessage(chatId, '❌ Invalid email. Please try again.');
      return;
    }
    if (s.renewalOf && String(text).toLowerCase() !== String(s.email || '').toLowerCase()) {   // V156.3, belt and braces
      clearSession(userId);
      await bot.sendMessage(chatId, 'ℹ️ A renewal keeps the same email. For another email, buy a new seat: /start → ✨ Buy a new seat.');
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
      `⏳ Duration: ${s.daysRemaining + (s.extraMonth ? (s.extraDays || 30) : 0)} days\n` +
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
        const payMaxAge = (() => {
          try { return parseInt(db.prepare("SELECT value FROM settings WHERE key='deposit_max_age_minutes'").get()?.value || '15', 10) || 15; }
          catch (e) { return 15; }
        })();
        const result = await verifyBinancePayOrder(text, { maxAgeMinutes: payMaxAge });
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
/**
 * Count a ChatGPT Business sale toward the buyer's rank.
 *
 * The main store accrues inside completeOrder, but this bot never calls it —
 * it writes its own orders row — so a customer could spend hundreds here and
 * stay on the bottom tier. Guarded by the order's own status so a webhook that
 * fires twice cannot count the same sale twice.
 */
function accrueRankForCgbOrder(orderId, userId) {
  try {
    const o = db.prepare('SELECT total_price, rank_counted FROM orders WHERE id = ?').get(orderId);
    if (!o || Number(o.rank_counted) === 1) return;
    const amount = Number(o.total_price) || 0;
    if (amount <= 0) return;
    queries.addRankSpend(userId, amount);
    db.prepare('UPDATE orders SET rank_counted = 1 WHERE id = ?').run(orderId);
  } catch (e) {
    // Rank bookkeeping must never block a paid order being confirmed.
    logger.warn(`accrueRankForCgbOrder #${orderId}: ${e.message}`);
  }
}

async function confirmPayment(chatId, userId, orderId, txid, sessionData) {
  // Mark order as paid
  try {
    db.prepare(`UPDATE orders SET status='paid', payment_proof=? WHERE id=?`).run(txid, orderId);
  } catch (e) {}

  // The placeholder becomes a real seat only now — this is the point where the
  // money is confirmed.
  try { queries.markCgbSubscriptionPaid(orderId); } catch (e) {}
  await notifyAdminRenewalPaid(orderId, userId, sessionData);

  accrueRankForCgbOrder(orderId, userId);

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
    const totalDays = sessionData.daysRemaining + (sessionData.extraMonth ? (sessionData.extraDays || 30) : 0);

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
      kind:      seatKindLine(sessionData.renewalOf),
      renewal:   !!sessionData.renewalOf,
      ...seatPlace({ end_date: sessionData.endDate, status: 'pending' }),
    };
    // Paid before its period opens — the start date is still in the future.
    // V156.2: compared with the LOCAL date. The server runs on UTC, so between midnight and 01:00 in Tunisia
    // "today" was still yesterday there and a seat starting today was labelled PAID EARLY.
    const scheduled = !!(card.startDate && String(card.startDate) > ymdLocal(cgbCycles.localNow(new Date())));

    const sentCard = await bot.sendMessage(ADMIN_ID, orderCard(card, false, scheduled), {
      parse_mode: 'HTML',
      reply_markup: orderCardButtons(card),
    });
    try { queries.saveCgbAdminCard(orderId, sentCard.chat.id, sentCard.message_id); } catch (e) {}
    handOverToGuard(sessionData.email, orderId, card.endDate).catch(() => {});
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

  try { queries.markCgbSubscriptionPaid(orderId); } catch (e) {}

  accrueRankForCgbOrder(orderId, sub.user_id);

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
      kind:      seatKindLine(sub.renewed_from),
      renewal:   !!sub.renewed_from,
      ...seatPlace(sub),
    };
    // Paid before its period opens — the start date is still in the future.
    // V156.2: compared with the LOCAL date. The server runs on UTC, so between midnight and 01:00 in Tunisia
    // "today" was still yesterday there and a seat starting today was labelled PAID EARLY.
    const scheduled = !!(card.startDate && String(card.startDate) > ymdLocal(cgbCycles.localNow(new Date())));

    const sentCard = await bot.sendMessage(ADMIN_ID, orderCard(card, false, scheduled), {
      parse_mode: 'HTML',
      reply_markup: orderCardButtons(card),
    });
    try { queries.saveCgbAdminCard(orderId, sentCard.chat.id, sentCard.message_id); } catch (e) {}
    handOverToGuard(sub.email, orderId, card.endDate).catch(() => {});
  } catch (e) {
    logger.warn(`confirmCryptobotPayment: could not notify admin: ${e.message}`);
  }

  return true;
}

// ════════════════════════════════════════════════════════════════
// RENEWAL REMINDERS
// ════════════════════════════════════════════════════════════════

/** Tell the shop owner which way a customer decided, so seats can be planned. */
/**
 * Tell the owner the moment a renewal is actually PAID.
 *
 * The existing notification fires when a customer merely taps Renew, which is
 * an intention. Money arriving is the event worth interrupting someone for, and
 * treating the two alike turns every notification into noise.
 */
async function notifyAdminRenewalPaid(orderId, userId, sessionData) {
  if (!ADMIN_ID || !sessionData || !sessionData.renewalOf) return;
  try {
    const prev = queries.getCgbSubById(sessionData.renewalOf);
    const u = db.prepare('SELECT username, first_name FROM users WHERE telegram_id = ?').get(userId);
    const who = u?.username ? `@${escapeHtml(u.username)}` : escapeHtml(u?.first_name || String(userId));
    const months = sessionData.renewMonths || 1;
    const today = ymdLocal(cgbCycles.localNow(new Date()));
    const start = sessionData.startDate || '';
    const when = start && start > today
      ? `🔵 Activate on <b>${niceDate(start)}</b> — not before`
      : `🟠 <b>Activate now</b>`;
    const b = renewalBoard();

    await bot.sendMessage(ADMIN_ID,
      `💰 <b>RENEWAL PAID</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 ${who} · <code>${userId}</code>\n` +
      `📧 <code>${escapeHtml(sessionData.email || '')}</code>\n` +
      `💵 <b>$${Number(sessionData.finalPrice || 0).toFixed(2)}</b> · ` +
      `${escapeHtml(String(sessionData.paymentMethod || '').replace('pay_', '') || 'paid')} · ` +
      `${months} month${months === 1 ? '' : 's'}\n` +
      `🗓 ${niceDate(start)} → <b>${niceDate(sessionData.endDate || '')}</b>` +
      (prev?.end_date ? ` <i>(was until ${niceDate(prev.end_date)})</i>` : '') + `\n` +
      `🧾 Order #${orderId}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `${when}\n\n` +
      `📊 This round: ✅ ${b.paid.length} paid · ⏳ ${b.unpaid.length} unpaid · ` +
      `🔔 ${b.silent.length} no answer · 🚫 ${b.declined.length} declined`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [
        [{ text: '📊 Open renewals', callback_data: 'rnw_home' }],
      ] } });
  } catch (e) {
    logger.warn(`notifyAdminRenewalPaid: ${e.message}`);
  }
}

/**
 * A customer's answer to a reminder. "No" is worth knowing (one seat fewer to
 * hold); "yes" is only an intention — the paid message above is the one that
 * matters — so it is sent silently.
 */
async function notifyAdminRenewal(sub, intent) {
  if (!ADMIN_ID) return;
  try {
    const u = db.prepare('SELECT username, first_name FROM users WHERE telegram_id = ?').get(sub.user_id);
    const who = u?.username ? `@${escapeHtml(u.username)}` : escapeHtml(u?.first_name || String(sub.user_id));
    await bot.sendMessage(ADMIN_ID,
      `${intent === 'yes' ? '⏳ <b>Going to renew</b> — payment pending' : "🚫 <b>Won't renew</b>"}\n` +
      `👤 ${who} · <code>${escapeHtml(sub.email || '')}</code>\n` +
      `📅 Seat ends ${niceDate(sub.end_date)}`,
      { parse_mode: 'HTML', disable_notification: intent === 'yes',
        reply_markup: { inline_keyboard: [[{ text: '📊 Open renewals', callback_data: 'rnw_home' }]] } });
  } catch (e) {
    logger.warn(`notifyAdminRenewal: ${e.message}`);
  }
}

function reminderSettings() {
  const get = (k, d) => {
    try {
      const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(k);
      return r ? r.value : d;
    } catch (e) { return d; }
  };
  return {
    enabled: String(get('cgb_reminder_enabled', '1')) === '1',
    // First reminder this many days before the seat ends (1 → the 23rd for a
    // seat ending on the 24th). Then one a day until the next cycle opens.
    before:  Math.max(0, Math.min(7, parseInt(get('cgb_reminder_start_before', '1'), 10) || 1)),
    // Shop-clock hour of the daily message — never in the middle of the night.
    hour:    Math.max(0, Math.min(23, parseInt(get('cgb_reminder_hour', '10'), 10) || 10)),
  };
}

const p2d = (n) => String(n).padStart(2, '0');
const ymdLocal = (d) => `${d.getFullYear()}-${p2d(d.getMonth() + 1)}-${p2d(d.getDate())}`;
const addDaysYmd = (ymd, n) => { const d = new Date(`${ymd}T12:00:00`); d.setDate(d.getDate() + n); return ymdLocal(d); };
const niceDate = (ymd) => {
  const d = new Date(`${ymd}T12:00:00`);
  return isNaN(d) ? ymd : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
};

/**
 * The day the next cycle opens for a seat ending on `endYmd`.
 *
 * The seat's cycle is the one whose end day matches its end date (26 -> 24 for
 * a seat ending on the 24th); the next cycle opens on that cycle's start day.
 * With no matching cycle, the day after the end.
 */
function nextCycleStartYmd(endYmd) {
  const end = new Date(`${endYmd}T12:00:00`);
  const cycles = cgbCycles.getCycles();
  const c = cycles.find((x) => Number(x.end_day) === end.getDate());
  if (!c) return addDaysYmd(endYmd, 1);
  for (let i = 1; i <= 31; i++) {
    const d = new Date(end); d.setDate(d.getDate() + i);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    if (d.getDate() === Math.min(Number(c.start_day), last)) return ymdLocal(d);
  }
  return addDaysYmd(endYmd, 1);
}

/** Has this seat already been renewed AND paid? */
function hasPaidSuccessor(subId) {
  try {
    return !!db.prepare(`SELECT 1 FROM chatgpt_subscriptions WHERE renewed_from = ?
      AND COALESCE(status,'') IN ('active','pending') LIMIT 1`).get(subId);
  } catch (e) { return false; }
}

/**
 * The daily renewal reminder.
 *
 * For a seat ending on the 24th of a 26 -> 24 cycle: the 23rd, the 24th, the
 * 25th and the 26th — one message a day, at the configured hour. It stops:
 *   - for good, the moment the customer answers "No";
 *   - the moment a renewal is paid;
 *   - after the day the next cycle opens.
 * "Yes" goes straight to the payment screen. A customer who said yes but has
 * not paid keeps getting a gentle "finish your payment" message instead.
 */
async function sendRenewalReminders() {
  const { enabled, before, hour } = reminderSettings();
  if (!enabled) return 0;

  const shopNow = cgbCycles.localNow(new Date());
  if (shopNow.getHours() < hour) return 0;
  const today = ymdLocal(shopNow);

  let seats = [];
  try {
    seats = db.prepare(`
      SELECT cs.*, u.username, u.first_name
      FROM chatgpt_subscriptions cs
      LEFT JOIN users u ON cs.user_id = u.telegram_id
      WHERE COALESCE(cs.status, 'pending') IN ('active', 'pending', 'expired')
        AND COALESCE(cs.renew_intent, '') <> 'no'
        AND cs.end_date IS NOT NULL
        AND date(cs.end_date) BETWEEN date(?, '-35 days') AND date(?, '+7 days')
        AND COALESCE(cs.reminder_last_date, '') <> ?
      ORDER BY date(cs.end_date) ASC`).all(today, today, today);
  } catch (e) {
    logger.error(`renewal reminders query failed: ${e.message}`);
    return 0;
  }

  let sent = 0;
  for (const sub of seats) {
    const end = String(sub.end_date).slice(0, 10);
    const first = addDaysYmd(end, -Math.min(before, 1));   // V156.7: never before the renewal window opens (1 day before the end)
    const last = nextCycleStartYmd(end);
    if (today < first || today > last) continue;
    if (hasPaidSuccessor(sub.id)) continue;

    const email = `<code>${escapeHtml(sub.email || '')}</code>`;
    let head;
    if (today < end) {
      const d = Math.round((new Date(`${end}T12:00:00`) - new Date(`${today}T12:00:00`)) / 86400000);
      head = `⏰ <b>Your ChatGPT Business seat ends ${d === 1 ? 'tomorrow' : `in ${d} days`}</b>`;
    } else if (today === end) {
      head = `⏰ <b>Your ChatGPT Business seat ends today</b>`;
    } else if (today < last) {
      head = `⌛ <b>Your ChatGPT Business seat has ended</b>`;
    } else {
      head = `🔔 <b>The new cycle starts today — last reminder</b>`;
    }

    const saidYes = sub.renew_intent === 'yes';
    const body =
      `${head}\n\n` +
      `📧 ${email}\n` +
      `📅 Ends: <b>${niceDate(end)}</b> · next cycle opens <b>${niceDate(last)}</b>\n\n` +
      (saidYes
        ? `You chose to renew, but the payment is not done yet. Finish it to keep the same email for the next cycle.`
        : `Do you want to renew and keep the same email for the next cycle?`);

    const kb = saidYes
      ? [[{ text: '💳 Complete payment', callback_data: `cgb_renewyes_${sub.id}` }],
         [{ text: '❌ No, cancel my renewal', callback_data: `cgb_renewno_${sub.id}` }]]
      : [[{ text: '✅ Yes, renew', callback_data: `cgb_renewyes_${sub.id}` },
          { text: '❌ No', callback_data: `cgb_renewno_${sub.id}` }]];

    try {
      await bot.sendMessage(sub.user_id, body, { parse_mode: 'HTML', reply_markup: { inline_keyboard: kb } });
      sent++;
      await new Promise((r) => setTimeout(r, 120));
    } catch (e) {
      // Blocked the bot, deleted the chat… still marked for today, so the
      // hourly run does not retry every hour.
      logger.warn(`reminder to ${sub.user_id} failed: ${e.message}`);
    }
    try {
      db.prepare(`UPDATE chatgpt_subscriptions SET reminder_last_date = ?, reminder_sent = 1,
        reminder_count = COALESCE(reminder_count,0) + 1, updated_at = datetime('now') WHERE id = ?`).run(today, sub.id);
    } catch (e) { logger.warn(`reminder mark ${sub.id}: ${e.message}`); }
  }

  if (sent) logger.info(`[CGB] ${sent} renewal reminder(s) sent`);
  return sent;
}

// Hourly rather than daily: a daily timer only fires if the process happens to
// be alive at that moment, and a redeploy at the wrong hour would silently skip
// a day of reminders. Hourly with a per-seat flag costs nothing and cannot skip.
const REMINDER_INTERVAL_MS = 60 * 60 * 1000;
setTimeout(() => {
  sendRenewalReminders().catch((e) => logger.error(`reminder run: ${e.message}`));
  sendDailyEndingDigest().catch((e) => logger.error(`ending digest: ${e.message}`));
  setInterval(() => {
    sendRenewalReminders().catch((e) => logger.error(`reminder run: ${e.message}`));
    sendDailyEndingDigest().catch((e) => logger.error(`ending digest: ${e.message}`));
  }, REMINDER_INTERVAL_MS);
}, 30000); // let the process finish booting first

// Register the command menu. Without this the bot's ☰ button is empty, so a
// customer has no way to discover /menu — the feature exists but is invisible
// unless they happen to type the right word.
bot.setMyCommands([
  { command: 'start', description: '🤖 ChatGPT Business' },
  { command: 'menu',  description: '📋 My subscriptions & renew' },
]).then(() => logger.info('CGB command menu registered'))
  .catch((e) => logger.warn(`CGB setMyCommands: ${e.message}`));

// Admin-only commands, scoped to the owner's private chat. Telegram itself
// enforces the scope, so /renewals never appears in a customer's ☰ menu.
if (ADMIN_ID) {
  bot.setMyCommands([
    { command: 'start',    description: '🤖 ChatGPT Business' },
    { command: 'menu',     description: '📋 My subscriptions & renew' },
    { command: 'admin',    description: '🛠 Admin panel (buttons)' },
    { command: 'renewals', description: '🔄 Who renewed (admin)' },
      { command: 'checkrenewals', description: '🔎 Check paid renewals (admin)' },
      { command: 'setdates', description: '✏️ Change a paid seat\'s dates (admin)' },
    { command: 'addseat',  description: '➕ Add a seat manually (admin)' },
    { command: 'ending',   description: '🗓 Seats ending on a day (admin)' },
    { command: 'setemail', description: '📧 Change a seat\'s email (admin)' },
    { command: 'setprice', description: '💰 Custom price for a customer (admin)' },
    { command: 'prices',   description: '💰 List custom prices (admin)' },
    { command: 'guardtest', description: '🔌 Test the link to the invite bot (admin)' },
  ], { scope: { type: 'chat', chat_id: Number(ADMIN_ID) } })
    .then(() => logger.info('CGB admin commands registered'))
    .catch((e) => logger.warn(`CGB admin setMyCommands: ${e.message}`));
}

bot.on('polling_error', e => logger.error(`CGB polling: ${e.message}`));

module.exports = { bot, confirmCryptobotPayment, sendRenewalReminders, activateAndNotifySeat, cancelSeatOrder, sendDailyEndingDigest };
