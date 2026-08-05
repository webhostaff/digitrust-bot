'use strict';

/**
 * Customer Support Bot (V4)
 *
 * What changed vs V3
 * ------------------
 * 1. The "✅ Your message has been sent" reply is gone. It used to fire after
 *    EVERY customer message; the welcome text is now sent exactly once per
 *    customer and that fact is persisted in `support_threads.welcomed`.
 *
 * 2. Delivery / read receipts. The customer sees a single status line under
 *    their messages:
 *        ✓  Sent   — stored by the system, support has not opened it yet
 *        ✓✓ Read   — a staff member actually opened the conversation
 *    The indicator's message id and state live in `support_threads`, and
 *    per-message read state lives in `support_messages.is_read` / `read_at`,
 *    so the marks are still correct after a restart.
 *
 * 3. Full conversation history with pagination, date separators and a clear
 *    visual split between customer and support messages.
 *
 * 4. A dedicated "Manual Delivery Requests" section with status tabs, counters,
 *    search and filters.
 *
 * The bot shares the main store database (via ./database/db) so it can read
 * orders, products and manual-delivery tasks directly.
 */

const TelegramBot = require('node-telegram-bot-api');
const logger      = require('./utils/logger');

const SUPPORT_BOT_TOKEN = process.env.SUPPORT_BOT_TOKEN;

if (!SUPPORT_BOT_TOKEN) {
  logger.warn('Support bot disabled — SUPPORT_BOT_TOKEN missing');
  module.exports = null;
  return;
}

// Shared schema + connection: db.js has already run every migration by now.
const rawDb   = require('./database/db');
const queries = require('./database/queries');
const config  = require('./config');
const manualDelivery = require('./handlers/manualDelivery');
const { notifyAdmin } = require('./services/adminNotify');

/**
 * Who counts as support staff.
 * ADMIN_ID (single) is kept for backwards compatibility, and every id from
 * ADMIN_IDS is accepted too, so panel admins can answer tickets as well.
 */
const SUPPORT_STAFF = (() => {
  const ids = new Set();
  const single = parseInt(process.env.ADMIN_ID || '0', 10);
  if (single) ids.add(single);
  for (const id of config.adminIds) if (id) ids.add(Number(id));
  return ids;
})();

const isStaff = (userId) => SUPPORT_STAFF.has(Number(userId));

if (SUPPORT_STAFF.size === 0) {
  logger.warn('Support bot: no ADMIN_ID / ADMIN_IDS configured — staff features are unreachable');
}

// ── Prepared statements ──────────────────────────────────────────────────────

const insertMsg = rawDb.prepare(`
  INSERT INTO support_messages (user_id, username, first_name, direction, content, media_type, file_id)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const getCustomers = rawDb.prepare(`
  SELECT user_id,
    MAX(username)   AS username,
    MAX(first_name) AS first_name,
    (SELECT content    FROM support_messages WHERE user_id = m.user_id ORDER BY id DESC LIMIT 1) AS last_msg,
    (SELECT media_type FROM support_messages WHERE user_id = m.user_id ORDER BY id DESC LIMIT 1) AS last_media,
    (SELECT direction  FROM support_messages WHERE user_id = m.user_id ORDER BY id DESC LIMIT 1) AS last_direction,
    (SELECT created_at FROM support_messages WHERE user_id = m.user_id ORDER BY id DESC LIMIT 1) AS last_time,
    COUNT(*) AS total_msgs,
    COUNT(CASE WHEN direction = 'in' AND is_read = 0 THEN 1 END) AS unread
  FROM support_messages m
  GROUP BY user_id
  ORDER BY last_time DESC
`);

const getMessagesPage = rawDb.prepare(`
  SELECT * FROM support_messages WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?
`);
const countMessages = rawDb.prepare('SELECT COUNT(*) AS n FROM support_messages WHERE user_id = ?');
const getFirstMsg   = rawDb.prepare('SELECT * FROM support_messages WHERE user_id = ? ORDER BY id ASC LIMIT 1');
const getFirstUnread = rawDb.prepare(`
  SELECT id FROM support_messages
  WHERE user_id = ? AND direction = 'in' AND is_read = 0
  ORDER BY id ASC LIMIT 1
`);

const bot = new TelegramBot(SUPPORT_BOT_TOKEN, { polling: true });
logger.info('🎫 Support Bot V4 started (read receipts + history + manual delivery)');

// ── Helpers ──────────────────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Parse a stored UTC timestamp into a Date. */
function toDate(iso) {
  if (!iso) return null;
  const raw = String(iso).replace(' ', 'T');
  const d = new Date(raw.endsWith('Z') ? raw : raw + 'Z');
  return isNaN(d.getTime()) ? null : d;
}

/** "14:05" for today, "29 Jul" otherwise. */
function formatTime(iso) {
  const d = toDate(iso);
  if (!d) return '';
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  if (d.toDateString() === now.toDateString()) return `${p(d.getHours())}:${p(d.getMinutes())}`;
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${d.getDate()} ${months[d.getMonth()]}`;
}

/** "29/07/2026 14:05" — used inside the transcript. */
function formatFull(iso) {
  const d = toDate(iso);
  if (!d) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Day header used to separate messages from different dates. */
function dayKey(iso) {
  const d = toDate(iso);
  if (!d) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
}

function displayName(username, firstName, userId) {
  if (username)  return `@${username}`;
  if (firstName) return firstName;
  return `User ${userId}`;
}

// Which customer each staff member is currently replying to.
// Persisted in settings so a restart does not lose the reply context.
function setActiveChat(staffChatId, targetUserId) {
  queries.setSetting(`support_active_chat_${staffChatId}`, String(targetUserId || ''));
}
function getActiveChat(staffChatId) {
  const v = queries.getSetting(`support_active_chat_${staffChatId}`, '');
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function clearActiveChat(staffChatId) {
  queries.setSetting(`support_active_chat_${staffChatId}`, '');
}

/** Edit the message if possible, otherwise send a new one. */
async function send(chatId, messageId, text, keyboard) {
  const opts = { parse_mode: 'HTML', reply_markup: keyboard, disable_web_page_preview: true };
  if (messageId) {
    try {
      await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...opts });
      return;
    } catch (e) { /* fall through to a fresh message */ }
  }
  await bot.sendMessage(chatId, text, opts);
}

// ═══════════════════════════════════════════════════════════════════════════
// CUSTOMER-FACING RECEIPT INDICATOR  (✓ / ✓✓)
// ═══════════════════════════════════════════════════════════════════════════

const RECEIPT_SENT = (n) => `✓ <i>Sent${n > 1 ? ` · ${n} messages` : ''}</i>`;
const RECEIPT_READ = (when) => `✓✓ <i>Read by support · ${when}</i>`;

/**
 * Refresh the single status line shown to the customer.
 *
 * Only ONE indicator exists per conversation. While support has not read
 * anything it is edited in place, so ten customer messages still produce one
 * indicator rather than ten. Once it flips to ✓✓, the next customer message
 * starts a fresh indicator underneath.
 */
async function updateReceiptSent(userId) {
  const thread = queries.ensureSupportThread(userId);
  const pending = (thread.status_state === 'sent' ? (thread.pending_count || 0) : 0) + 1;

  if (thread.status_state === 'sent' && thread.status_msg_id) {
    try {
      await bot.editMessageText(RECEIPT_SENT(pending), {
        chat_id: userId,
        message_id: thread.status_msg_id,
        parse_mode: 'HTML',
      });
      queries.setSupportStatusMsg(userId, thread.status_msg_id, 'sent', pending);
      return;
    } catch (e) {
      // Too old / identical / deleted — post a new indicator instead.
    }
  }

  try {
    const sent = await bot.sendMessage(userId, RECEIPT_SENT(pending), { parse_mode: 'HTML' });
    queries.setSupportStatusMsg(userId, sent.message_id, 'sent', pending);
  } catch (e) {
    logger.warn(`updateReceiptSent: could not post indicator to ${userId}: ${e.message}`);
  }
}

/**
 * Flip the indicator to ✓✓ and persist the read state of every incoming
 * message. Called ONLY when a staff member actually opens the conversation.
 */
async function markThreadRead(userId) {
  const thread = queries.ensureSupportThread(userId);

  const firstUnread = getFirstUnread.get(userId);
  if (!firstUnread && thread.status_state === 'read') return; // nothing to do

  queries.markSupportThreadRead(userId);

  if (thread.status_msg_id && thread.status_state !== 'read') {
    const p = (n) => String(n).padStart(2, '0');
    const now = new Date();
    try {
      await bot.editMessageText(RECEIPT_READ(`${p(now.getHours())}:${p(now.getMinutes())}`), {
        chat_id: userId,
        message_id: thread.status_msg_id,
        parse_mode: 'HTML',
      });
    } catch (e) {
      // Indicator gone — harmless; the DB state is the source of truth.
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// INBOX
// ═══════════════════════════════════════════════════════════════════════════

const INBOX_PER_PAGE = 8;

async function showInbox(chatId, messageId = null, page = 0) {
  const all = getCustomers.all();
  const unreadThreads = all.filter((c) => c.unread > 0).length;
  const mdCounts = queries.getManualDeliveryCounts();

  if (!all.length) {
    const text =
      `📭 <b>Support Inbox</b>\n\n` +
      `No customer messages yet.` +
      (mdCounts.pending ? `\n\n📦 <b>${mdCounts.pending}</b> manual delivery request(s) waiting.` : '');
    await send(chatId, messageId, text, { inline_keyboard: [
      [{ text: `📦 Manual Delivery (${mdCounts.pending})`, callback_data: 'md_list_pending_0' }],
      [{ text: '🔔 Stock Alerts', callback_data: 'stock_list_all_0' }],
      [{ text: '🔄 Refresh', callback_data: 'inbox' }],
    ] });
    return;
  }

  clearActiveChat(chatId);

  const totalPages  = Math.max(1, Math.ceil(all.length / INBOX_PER_PAGE));
  const currentPage = Math.max(0, Math.min(page, totalPages - 1));
  const slice = all.slice(currentPage * INBOX_PER_PAGE, (currentPage + 1) * INBOX_PER_PAGE);

  const text =
    `📥 <b>Support Inbox</b>\n` +
    (unreadThreads > 0 ? `🔴 <b>${unreadThreads}</b> conversation(s) unread\n` : '✅ All caught up\n') +
    `💬 ${all.length} conversation(s) total\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `Tap a customer to open their chat:`;

  const rows = slice.map((c) => {
    const name  = displayName(c.username, c.first_name, c.user_id);
    const badge = c.unread > 0 ? `🔴${c.unread} ` : '';
    const dir   = c.last_direction === 'out' ? '↩ ' : '';
    return [{
      text: `${badge}${dir}${name} · ${formatTime(c.last_time)}`,
      callback_data: `chat_${c.user_id}`,
    }];
  });

  if (totalPages > 1) {
    const nav = [];
    if (currentPage > 0) nav.push({ text: '◀️ Prev', callback_data: `inbox_p_${currentPage - 1}` });
    nav.push({ text: `${currentPage + 1}/${totalPages}`, callback_data: 'noop' });
    if (currentPage < totalPages - 1) nav.push({ text: 'Next ▶️', callback_data: `inbox_p_${currentPage + 1}` });
    rows.push(nav);
  }

  const stockUnread = queries.countNotificationsByType(['stock_out', 'stock_low'], true);
  rows.push([{
    text: `📦 Manual Delivery${mdCounts.pending ? ` (${mdCounts.pending})` : ''}`,
    callback_data: 'md_list_pending_0',
  }]);
  rows.push([{
    text: `🔔 Stock Alerts${stockUnread ? ` (${stockUnread})` : ''}`,
    callback_data: 'stock_list_all_0',
  }]);
  rows.push([
    { text: '🔍 Search customer', callback_data: 'cust_search' },
    { text: '🔄 Refresh', callback_data: 'inbox' },
  ]);

  await send(chatId, messageId, text, { inline_keyboard: rows });
}

// ═══════════════════════════════════════════════════════════════════════════
// CONVERSATION VIEW
// ═══════════════════════════════════════════════════════════════════════════

const CHAT_PER_PAGE = 12;

/**
 * Render one page of the conversation as a readable transcript.
 * Page 0 = newest messages; higher pages go further back in time.
 */
async function showChat(staffChatId, targetUserId, page = 0, messageId = null) {
  const total = countMessages.get(targetUserId).n;
  if (!total) {
    await bot.sendMessage(staffChatId, '❌ No messages from this customer.');
    return;
  }

  // Opening the conversation is what marks it read — never before this point.
  await markThreadRead(targetUserId);
  setActiveChat(staffChatId, targetUserId);

  const totalPages  = Math.max(1, Math.ceil(total / CHAT_PER_PAGE));
  const currentPage = Math.max(0, Math.min(page, totalPages - 1));

  // DESC + offset gives the right slice; reverse it back to chronological order.
  const rows = getMessagesPage
    .all(targetUserId, CHAT_PER_PAGE, currentPage * CHAT_PER_PAGE)
    .reverse();

  const first = getFirstMsg.get(targetUserId);
  const name  = displayName(first?.username, first?.first_name, targetUserId);
  const user  = queries.getUser(targetUserId);

  let header =
    `💬 <b>${escapeHtml(name)}</b>\n` +
    `🆔 <code>${targetUserId}</code>\n`;
  if (user) {
    const orders = queries.getUserOrdersAll(targetUserId);
    header +=
      `💰 Balance: <b>$${Number(user.balance || 0).toFixed(2)}</b>` +
      `   📦 Orders: <b>${orders.length}</b>\n`;
  }
  header +=
    `📜 ${total} message(s) · page ${currentPage + 1}/${totalPages}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n`;

  let body = '';
  let lastDay = null;
  const mediaCount = rows.filter((m) => m.media_type && m.file_id).length;

  for (const m of rows) {
    const day = dayKey(m.created_at);
    if (day && day !== lastDay) {
      body += `\n📅 <b>── ${day} ──</b>\n\n`;
      lastDay = day;
    }

    const time = formatFull(m.created_at).slice(-5); // HH:MM
    const mine = m.direction === 'out';
    const who  = mine ? '📤 <b>Support</b>' : '📩 <b>Customer</b>';
    const tick = !mine ? (m.is_read ? ' ✓✓' : ' ✓') : '';

    let line = `${who} · <i>${time}</i>${tick}\n`;
    if (m.media_type) {
      const icon = { photo: '🖼', video: '🎬', voice: '🎤', document: '📎' }[m.media_type] || '📁';
      line += `${icon} <i>[${m.media_type}]</i>${m.content ? ' ' + escapeHtml(m.content) : ''}\n`;
    } else {
      line += `${m.content ? escapeHtml(m.content) : '<i>(empty)</i>'}\n`;
    }
    body += line + '\n';
  }

  const nav = [];
  // "Older" is a HIGHER page index, because page 0 holds the newest slice.
  if (currentPage < totalPages - 1) nav.push({ text: '⬆️ Older', callback_data: `chat_p_${targetUserId}_${currentPage + 1}` });
  if (currentPage > 0)              nav.push({ text: '⬇️ Newer', callback_data: `chat_p_${targetUserId}_${currentPage - 1}` });

  const kbRows = [];
  if (nav.length) kbRows.push(nav);
  if (mediaCount) {
    kbRows.push([{ text: `📎 Show ${mediaCount} attachment(s)`, callback_data: `chat_media_${targetUserId}_${currentPage}` }]);
  }
  kbRows.push([{ text: '📦 Their orders', callback_data: `cust_orders_${targetUserId}` }]);
  kbRows.push([
    { text: '🔄 Refresh', callback_data: `chat_p_${targetUserId}_${currentPage}` },
    { text: '🔙 Inbox',   callback_data: 'inbox' },
  ]);

  const footer =
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `✍️ <b>Type below to reply to ${escapeHtml(name)}.</b>`;

  let full = header + body + footer;
  if (full.length > 4000) {
    full = header + '\n<i>…older lines trimmed, use ⬆️ Older…</i>\n' + body.slice(-3200) + footer;
  }

  await send(staffChatId, messageId, full, { inline_keyboard: kbRows });
}

/** Replay the media attachments of one conversation page. */
async function replayMedia(staffChatId, targetUserId, page) {
  const rows = getMessagesPage
    .all(targetUserId, CHAT_PER_PAGE, page * CHAT_PER_PAGE)
    .reverse()
    .filter((m) => m.media_type && m.file_id);

  if (!rows.length) {
    await bot.sendMessage(staffChatId, 'ℹ️ No attachments on this page.');
    return;
  }

  for (const m of rows) {
    const cap = `${m.direction === 'in' ? '📩 Customer' : '📤 Support'} · ${formatFull(m.created_at)}` +
                (m.content ? `\n${escapeHtml(m.content)}` : '');
    try {
      if (m.media_type === 'photo')         await bot.sendPhoto(staffChatId, m.file_id,    { caption: cap, parse_mode: 'HTML' });
      else if (m.media_type === 'video')    await bot.sendVideo(staffChatId, m.file_id,    { caption: cap, parse_mode: 'HTML' });
      else if (m.media_type === 'voice')    await bot.sendVoice(staffChatId, m.file_id,    { caption: cap, parse_mode: 'HTML' });
      else if (m.media_type === 'document') await bot.sendDocument(staffChatId, m.file_id, { caption: cap, parse_mode: 'HTML' });
    } catch (e) {
      logger.warn(`replayMedia failed: ${e.message}`);
    }
  }
}

/** Quick view of a customer's orders from inside the chat. */
async function showCustomerOrders(staffChatId, targetUserId, messageId = null) {
  const orders = queries.getUserOrdersAll(targetUserId);
  const user   = queries.getUser(targetUserId);
  const name   = user ? displayName(user.username, user.first_name, targetUserId) : `User ${targetUserId}`;

  let txt = `📦 <b>Orders — ${escapeHtml(name)}</b>\n🆔 <code>${targetUserId}</code>\n\n`;
  if (!orders.length) {
    txt += '<i>No orders yet.</i>';
  } else {
    const icon = { delivered: '✅', pending: '⏳', cancelled: '❌', awaiting_delivery: '🕐' };
    for (const o of orders.slice(0, 20)) {
      txt += `${icon[o.status] || '❓'} <b>#${o.id}</b> · ${escapeHtml(String(o.product_title || '').slice(0, 28))}\n` +
             `   $${Number(o.total_price || 0).toFixed(2)} · ${formatFull(o.created_at)}\n`;
    }
    if (orders.length > 20) txt += `\n<i>…and ${orders.length - 20} more</i>`;
  }

  await send(staffChatId, messageId, txt, {
    inline_keyboard: [[{ text: '🔙 Back to chat', callback_data: `chat_${targetUserId}` }]],
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// MANUAL DELIVERY REQUESTS
// ═══════════════════════════════════════════════════════════════════════════

const MD_PER_PAGE = 8;
const MD_TABS = {
  pending:    '🕐 Waiting',
  processing: '⚙️ In progress',
  delivered:  '✅ Delivered',
  cancelled:  '❌ Cancelled',
  all:        '📋 All',
};

async function showManualList(chatId, messageId, status = 'pending', page = 0, searchTerm = '') {
  const safeStatus = Object.prototype.hasOwnProperty.call(MD_TABS, status) ? status : 'pending';
  const counts = queries.getManualDeliveryCounts();

  // Already ordered newest-first by the query layer.
  let rows = queries.getAllManualDeliveries();
  if (safeStatus !== 'all') rows = rows.filter((r) => r.status === safeStatus);

  if (searchTerm) {
    const q = searchTerm.toLowerCase();
    rows = rows.filter((r) =>
      String(r.order_id).includes(q) ||
      String(r.id).includes(q) ||
      String(r.user_id).includes(q) ||
      String(r.username || '').toLowerCase().includes(q) ||
      String(r.first_name || '').toLowerCase().includes(q) ||
      String(r.product_title || '').toLowerCase().includes(q) ||
      String(r.email || '').toLowerCase().includes(q)
    );
  }

  const totalPages  = Math.max(1, Math.ceil(rows.length / MD_PER_PAGE));
  const currentPage = Math.max(0, Math.min(page, totalPages - 1));
  const slice = rows.slice(currentPage * MD_PER_PAGE, (currentPage + 1) * MD_PER_PAGE);

  const txt =
    `📦 <b>Manual Delivery Requests</b>\n\n` +
    `🕐 Waiting: <b>${counts.pending}</b>   ⚙️ In progress: <b>${counts.processing}</b>\n` +
    `✅ Delivered: <b>${counts.delivered}</b>   ❌ Cancelled: <b>${counts.cancelled}</b>\n` +
    (counts.unseen > 0 ? `\n🆕 <b>${counts.unseen}</b> new request(s) not yet reviewed\n` : '') +
    `\n<b>Showing:</b> ${MD_TABS[safeStatus]}` +
    (searchTerm ? ` · search “${escapeHtml(searchTerm)}”` : '') +
    ` — ${rows.length} result(s)`;

  const kb = [];

  const tabKeys = Object.keys(MD_TABS);
  const chip = (k) => ({
    text: (k === safeStatus && !searchTerm ? '✓ ' : '') + MD_TABS[k],
    callback_data: `md_list_${k}_0`,
  });
  kb.push(tabKeys.slice(0, 2).map(chip));
  kb.push(tabKeys.slice(2, 4).map(chip));
  kb.push([chip('all')]);

  for (const r of slice) {
    const isNew = (!r.seen_at && r.status === 'pending') ? '🆕 ' : '';
    const who   = displayName(r.username, r.first_name, r.user_id);
    const title = String(r.product_title || '').replace(/\[emoji:\d+\]/g, '').trim().slice(0, 18);
    kb.push([{
      text: `${isNew}#${r.id} · ${who.slice(0, 14)} · ${title} ×${r.quantity}`,
      callback_data: `md_view_${r.id}`,
    }]);
  }

  if (totalPages > 1) {
    const nav = [];
    const base = searchTerm ? 'md_srch' : `md_list_${safeStatus}`;
    if (currentPage > 0)              nav.push({ text: '◀️ Prev', callback_data: `${base}_${currentPage - 1}` });
    nav.push({ text: `${currentPage + 1}/${totalPages}`, callback_data: 'noop' });
    if (currentPage < totalPages - 1) nav.push({ text: 'Next ▶️', callback_data: `${base}_${currentPage + 1}` });
    kb.push(nav);
  }

  kb.push([
    { text: '🔍 Search', callback_data: 'md_search' },
    { text: '🔄 Refresh', callback_data: `md_list_${safeStatus}_${currentPage}` },
  ]);
  kb.push([{ text: '🔙 Inbox', callback_data: 'inbox' }]);

  await send(chatId, messageId, txt, { inline_keyboard: kb });
}

async function showManualDetail(chatId, messageId, taskId) {
  const t = queries.getManualDelivery(taskId);
  if (!t) {
    await bot.sendMessage(chatId, '❌ Request not found.');
    return;
  }

  // Reviewing the task clears its "new" flag.
  queries.markManualSeen(taskId);

  const who   = displayName(t.username, t.first_name, t.user_id);
  const user  = queries.getUser(t.user_id);
  const order = queries.getOrder(t.order_id);

  const txt =
    `📦 <b>Manual Delivery #${t.id}</b>\n\n` +
    `<b>Status:</b> ${manualDelivery.STATUS_LABEL[t.status] || t.status}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🆔 <b>Order:</b> #${t.order_id}\n` +
    `🛒 <b>Product:</b> ${manualDelivery.cleanTitle(t.product_title)}\n` +
    `🔢 <b>Quantity:</b> ${t.quantity}\n` +
    (t.email ? `📧 <b>Email:</b> <code>${escapeHtml(t.email)}</code>\n` : '') +
    `💵 <b>Paid:</b> $${Number(t.total_paid).toFixed(2)}\n` +
    `💳 <b>Method:</b> ${escapeHtml(t.payment_method || 'n/a')}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `👤 <b>Customer:</b> ${escapeHtml(who)}\n` +
    `🆔 <code>${t.user_id}</code>\n` +
    (user ? `💰 <b>Wallet:</b> $${Number(user.balance || 0).toFixed(2)}\n` : '') +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📅 <b>Created:</b> ${formatFull(t.created_at)}\n` +
    (order?.paid_at    ? `💳 <b>Paid at:</b> ${formatFull(order.paid_at)}\n` : '') +
    (t.delivered_at    ? `✅ <b>Delivered:</b> ${formatFull(t.delivered_at)}\n` : '') +
    (t.admin_note      ? `\n📝 <i>${escapeHtml(t.admin_note)}</i>\n` : '') +
    (t.delivered_content
      ? `\n🎁 <b>Delivered content:</b>\n<code>${escapeHtml(String(t.delivered_content).slice(0, 500))}</code>\n`
      : '');

  const kb = [];
  if (t.status === 'pending' || t.status === 'processing') {
    if (t.status === 'pending') {
      kb.push([{ text: '⚙️ Mark as in progress', callback_data: `md_proc_${t.id}` }]);
    }
    kb.push([{ text: '✅ Deliver now (send content)', callback_data: `md_deliver_${t.id}` }]);
    kb.push([{ text: '☑️ Mark delivered (no content)', callback_data: `md_done_${t.id}` }]);
    kb.push([{ text: '❌ Cancel & refund', callback_data: `md_cancel_${t.id}` }]);
  }
  kb.push([{ text: '💬 Open customer chat', callback_data: `chat_${t.user_id}` }]);
  kb.push([{ text: '🔙 Back to list', callback_data: `md_list_${t.status}_0` }]);

  await send(chatId, messageId, txt, { inline_keyboard: kb });
}

// ═══════════════════════════════════════════════════════════════════════════
// STOCK ALERTS
//
// Reads the shared `admin_notifications` table, so an alert raised by the main
// bot shows up here with the same read state — marking it read in one place
// marks it read everywhere.
// ═══════════════════════════════════════════════════════════════════════════

const STOCK_TYPES = ['stock_out', 'stock_low'];
const STOCK_TABS = {
  all:       '📋 All',
  stock_out: '🔴 Out of stock',
  stock_low: '🟠 Running low',
};
const STOCK_PER_PAGE = 8;

async function showStockAlerts(chatId, messageId, tab = 'all', page = 0) {
  const safeTab = Object.prototype.hasOwnProperty.call(STOCK_TABS, tab) ? tab : 'all';
  const types   = safeTab === 'all' ? STOCK_TYPES : [safeTab];

  const total = queries.countNotificationsByType(types);
  const pages = Math.max(1, Math.ceil(total / STOCK_PER_PAGE));
  const pg    = Math.max(0, Math.min(page, pages - 1));
  const rows  = queries.getNotificationsByType(types, STOCK_PER_PAGE, pg * STOCK_PER_PAGE);

  const outCount = queries.countNotificationsByType(['stock_out'], true);
  const lowCount = queries.countNotificationsByType(['stock_low'], true);

  const txt =
    `🔔 <b>Stock Alerts</b>\n\n` +
    `🔴 Out of stock (unread): <b>${outCount}</b>\n` +
    `🟠 Running low (unread): <b>${lowCount}</b>\n\n` +
    `<b>Showing:</b> ${STOCK_TABS[safeTab]} — ${total} alert(s)` +
    (rows.length ? '' : '\n\n<i>No alerts yet.</i>');

  const kb = [Object.keys(STOCK_TABS).map((k) => ({
    text: (k === safeTab ? '✓ ' : '') + STOCK_TABS[k],
    callback_data: `stock_list_${k}_0`,
  }))];

  for (const n of rows) {
    const dot  = n.is_read ? '' : '🔴 ';
    const icon = n.type === 'stock_out' ? '🔴' : '🟠';
    const when = formatTime(n.created_at);
    kb.push([{
      text: `${dot}${icon} ${String(n.title).slice(0, 26)} · ${when}`,
      callback_data: `stock_view_${n.id}`,
    }]);
  }

  if (pages > 1) {
    const nav = [];
    if (pg > 0)         nav.push({ text: '◀️ Prev', callback_data: `stock_list_${safeTab}_${pg - 1}` });
    nav.push({ text: `${pg + 1}/${pages}`, callback_data: 'noop' });
    if (pg < pages - 1) nav.push({ text: 'Next ▶️', callback_data: `stock_list_${safeTab}_${pg + 1}` });
    kb.push(nav);
  }

  if (outCount + lowCount > 0) {
    kb.push([{ text: '✅ Mark all as read', callback_data: `stock_readall_${safeTab}` }]);
  }
  kb.push([{ text: '🔙 Inbox', callback_data: 'inbox' }]);

  await send(chatId, messageId, txt, { inline_keyboard: kb });
}

async function showStockAlert(chatId, messageId, id) {
  const n = queries.getAdminNotification(id);
  if (!n) {
    await bot.sendMessage(chatId, '❌ Alert not found.');
    return;
  }
  // Opening it is what marks it read.
  queries.markNotificationRead(id);

  const icon = n.type === 'stock_out' ? '🔴' : '🟠';
  const txt =
    `${icon} <b>${escapeHtml(n.title)}</b>\n` +
    `🕒 ${formatFull(n.created_at)}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `${n.body || '<i>(no details)</i>'}`;

  const kb = [];
  if (n.ref_type === 'product' && n.ref_id) {
    kb.push([{ text: '📦 Product ID ' + n.ref_id, callback_data: 'noop' }]);
  }
  kb.push([{ text: '🔙 Stock Alerts', callback_data: 'stock_list_all_0' }]);

  await send(chatId, messageId, txt, { inline_keyboard: kb });
}

// ═══════════════════════════════════════════════════════════════════════════
// COMMANDS
// ═══════════════════════════════════════════════════════════════════════════

bot.onText(/^\/start/, async (msg) => {
  const userId = msg.from.id;

  if (isStaff(userId)) {
    await showInbox(msg.chat.id);
    return;
  }

  // Customers: the welcome is sent exactly once, ever.
  const thread = queries.ensureSupportThread(userId);
  if (!thread.welcomed) {
    const welcome = queries.getSetting(
      'support_welcome_message',
      '👋 Welcome to Customer Support!\n\nSend your question here and our team will reply as soon as possible.'
    );
    await bot.sendMessage(msg.chat.id, welcome, { parse_mode: 'HTML' }).catch(() => {});
    queries.markSupportWelcomed(userId);
  } else {
    await bot.sendMessage(
      msg.chat.id,
      '💬 You can continue the conversation here — just send your message.'
    ).catch(() => {});
  }
});

bot.onText(/^\/inbox/, async (msg) => {
  if (isStaff(msg.from.id)) await showInbox(msg.chat.id);
});

bot.onText(/^\/manual/, async (msg) => {
  if (isStaff(msg.from.id)) await showManualList(msg.chat.id, null, 'pending', 0);
});

bot.onText(/^\/alerts/, async (msg) => {
  if (isStaff(msg.from.id)) await showStockAlerts(msg.chat.id, null, 'all', 0);
});

bot.onText(/^\/close/, async (msg) => {
  if (!isStaff(msg.from.id)) return;
  clearActiveChat(msg.chat.id);
  await bot.sendMessage(msg.chat.id, '✅ Reply mode closed. Use /inbox to pick another conversation.');
});

// ═══════════════════════════════════════════════════════════════════════════
// CALLBACKS
// ═══════════════════════════════════════════════════════════════════════════

bot.on('callback_query', async (q) => {
  if (!isStaff(q.from.id)) {
    await bot.answerCallbackQuery(q.id, { text: 'Not authorized', show_alert: true }).catch(() => {});
    return;
  }
  await bot.answerCallbackQuery(q.id).catch(() => {});

  const data   = q.data || '';
  const chatId = q.message.chat.id;
  const msgId  = q.message.message_id;

  try {
    if (data === 'noop') return;

    if (data === 'inbox')           { await showInbox(chatId, msgId); return; }
    if (/^inbox_p_\d+$/.test(data)) { await showInbox(chatId, msgId, parseInt(data.split('_').pop(), 10)); return; }

    // ── Conversation ──────────────────────────────────────────────────────
    if (/^chat_\d+$/.test(data)) {
      await showChat(chatId, parseInt(data.split('_')[1], 10), 0, msgId);
      return;
    }
    if (/^chat_p_\d+_\d+$/.test(data)) {
      const parts = data.split('_');
      await showChat(chatId, parseInt(parts[2], 10), parseInt(parts[3], 10), msgId);
      return;
    }
    if (/^chat_media_\d+_\d+$/.test(data)) {
      const parts = data.split('_');
      await replayMedia(chatId, parseInt(parts[2], 10), parseInt(parts[3], 10));
      return;
    }
    if (/^cust_orders_\d+$/.test(data)) {
      await showCustomerOrders(chatId, parseInt(data.split('_').pop(), 10), msgId);
      return;
    }
    if (data === 'cust_search') {
      queries.setSetting(`support_state_${chatId}`, 'AWAIT_CUSTOMER_SEARCH');
      await bot.sendMessage(chatId, '🔍 Send a user ID, @username or name to search for:');
      return;
    }

    // ── Stock alerts ──────────────────────────────────────────────────────
    if (/^stock_list_[a-z_]+_\d+$/.test(data)) {
      const parts = data.split('_');
      const page  = parseInt(parts.pop(), 10);
      const tab   = parts.slice(2).join('_');
      await showStockAlerts(chatId, msgId, tab, page);
      return;
    }
    if (/^stock_view_\d+$/.test(data)) {
      await showStockAlert(chatId, msgId, parseInt(data.split('_').pop(), 10));
      return;
    }
    if (/^stock_readall_[a-z_]+$/.test(data)) {
      const cleared = queries.markAllNotificationsRead();
      await bot.sendMessage(chatId, `✅ ${cleared} notification(s) marked as read.`);
      await showStockAlerts(chatId, msgId, data.split('_').slice(2).join('_'), 0);
      return;
    }

    // ── Manual delivery ───────────────────────────────────────────────────
    if (/^md_list_[a-z]+_\d+$/.test(data)) {
      const parts  = data.split('_');
      const page   = parseInt(parts.pop(), 10);
      const status = parts.slice(2).join('_');
      await showManualList(chatId, msgId, status, page);
      return;
    }
    if (/^md_view_\d+$/.test(data)) {
      await showManualDetail(chatId, msgId, parseInt(data.split('_').pop(), 10));
      return;
    }
    if (data === 'md_search') {
      queries.setSetting(`support_state_${chatId}`, 'AWAIT_MD_SEARCH');
      await bot.sendMessage(chatId,
        '🔍 Send an order number, task id, customer name or product to search for:');
      return;
    }
    if (/^md_srch_\d+$/.test(data)) {
      const term = queries.getSetting(`support_md_term_${chatId}`, '');
      await showManualList(chatId, msgId, 'all', parseInt(data.split('_').pop(), 10), term);
      return;
    }
    if (/^md_proc_\d+$/.test(data)) {
      const id = parseInt(data.split('_').pop(), 10);
      queries.setManualDeliveryStatus(id, 'processing', 'Marked in progress');
      await showManualDetail(chatId, msgId, id);
      return;
    }
    if (/^md_deliver_\d+$/.test(data)) {
      const id = parseInt(data.split('_').pop(), 10);
      queries.setSetting(`support_state_${chatId}`, `AWAIT_MD_CONTENT:${id}`);
      const t = queries.getManualDelivery(id);
      await bot.sendMessage(chatId,
        `✍️ <b>Send the content for task #${id}</b>\n\n` +
        `👤 ${escapeHtml(displayName(t?.username, t?.first_name, t?.user_id))}\n` +
        `📦 ${manualDelivery.cleanTitle(t?.product_title)} ×${t?.quantity}\n\n` +
        `<i>Your next message will be delivered to the customer. Send /cancel to abort.</i>`,
        { parse_mode: 'HTML' });
      return;
    }
    if (/^md_done_\d+$/.test(data)) {
      const id = parseInt(data.split('_').pop(), 10);
      const res = await manualDelivery.completeManualDelivery(bot, id, null);
      await bot.sendMessage(chatId, res.ok
        ? `✅ Task #${id} marked delivered.${res.notified ? '' : '\n⚠️ Customer could not be messaged.'}`
        : `⚠️ Could not complete: ${res.reason}`);
      await showManualDetail(chatId, msgId, id);
      return;
    }
    if (/^md_cancel_\d+$/.test(data)) {
      const id = parseInt(data.split('_').pop(), 10);
      const res = await manualDelivery.cancelManualDelivery(bot, id, 'Cancelled by support');
      await bot.sendMessage(chatId, res.ok
        ? `❌ Task #${id} cancelled and the customer was refunded.`
        : `⚠️ Could not cancel: ${res.reason}`);
      await showManualDetail(chatId, msgId, id);
      return;
    }
  } catch (e) {
    logger.error(`Support callback "${data}" failed: ${e.message}`);
    await bot.sendMessage(chatId, `⚠️ Error: ${e.message}`).catch(() => {});
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// MESSAGES
// ═══════════════════════════════════════════════════════════════════════════

bot.on('message', async (msg) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  if (msg.text && /^\/cancel/.test(msg.text) && isStaff(userId)) {
    queries.setSetting(`support_state_${chatId}`, '');
    await bot.sendMessage(chatId, '✅ Cancelled.');
    return;
  }
  if (msg.text && /^\//.test(msg.text)) return;

  // ── STAFF SIDE ────────────────────────────────────────────────────────────
  if (isStaff(userId)) {
    const state = queries.getSetting(`support_state_${chatId}`, '');
    const text  = (msg.text || '').trim();

    // Content for a manual-delivery task
    if (state.startsWith('AWAIT_MD_CONTENT:')) {
      const taskId = parseInt(state.split(':')[1], 10);
      queries.setSetting(`support_state_${chatId}`, '');
      if (!text) {
        await bot.sendMessage(chatId, '❌ Content cannot be empty.');
        return;
      }
      const res = await manualDelivery.completeManualDelivery(bot, taskId, text);
      await bot.sendMessage(chatId, res.ok
        ? `✅ <b>Task #${taskId} delivered.</b>${res.notified ? '' : '\n⚠️ Customer could not be messaged — content saved.'}`
        : `⚠️ Could not deliver: ${res.reason}`,
        { parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: '📦 Manual list', callback_data: 'md_list_pending_0' }]] } });
      return;
    }

    // Manual-delivery search
    if (state === 'AWAIT_MD_SEARCH') {
      queries.setSetting(`support_state_${chatId}`, '');
      queries.setSetting(`support_md_term_${chatId}`, text);
      await showManualList(chatId, null, 'all', 0, text);
      return;
    }

    // Customer search
    if (state === 'AWAIT_CUSTOMER_SEARCH') {
      queries.setSetting(`support_state_${chatId}`, '');
      const q = text.replace(/^@/, '').toLowerCase();
      const found = getCustomers.all().filter((c) =>
        String(c.user_id).includes(q) ||
        String(c.username || '').toLowerCase().includes(q) ||
        String(c.first_name || '').toLowerCase().includes(q)
      );
      if (!found.length) {
        await bot.sendMessage(chatId, `🔍 No customer matches “${escapeHtml(text)}”.`, { parse_mode: 'HTML' });
        return;
      }
      const rows = found.slice(0, 15).map((c) => [{
        text: `${c.unread ? '🔴 ' : ''}${displayName(c.username, c.first_name, c.user_id)} · ${formatTime(c.last_time)}`,
        callback_data: `chat_${c.user_id}`,
      }]);
      rows.push([{ text: '🔙 Inbox', callback_data: 'inbox' }]);
      await bot.sendMessage(chatId, `🔍 <b>${found.length} match(es)</b>`, {
        parse_mode: 'HTML', reply_markup: { inline_keyboard: rows },
      });
      return;
    }

    // ── Normal reply to the active conversation ────────────────────────────
    const targetUserId = getActiveChat(chatId);
    if (!targetUserId) {
      await bot.sendMessage(chatId, 'ℹ️ Open a conversation first — use /inbox.');
      return;
    }

    let mediaType = null, fileId = null;
    const contentText = msg.text || msg.caption || '';

    try {
      if (msg.text) {
        await bot.sendMessage(targetUserId,
          `📩 <b>Support</b>\n\n${escapeHtml(msg.text)}`, { parse_mode: 'HTML' });
      } else if (msg.photo && msg.photo.length) {
        fileId = msg.photo[msg.photo.length - 1].file_id; mediaType = 'photo';
        await bot.sendPhoto(targetUserId, fileId, {
          caption: msg.caption ? `📩 ${escapeHtml(msg.caption)}` : '📩 From Support',
          parse_mode: 'HTML',
        });
      } else if (msg.document) {
        fileId = msg.document.file_id; mediaType = 'document';
        await bot.sendDocument(targetUserId, fileId, { caption: '📩 From Support' });
      } else if (msg.voice) {
        fileId = msg.voice.file_id; mediaType = 'voice';
        await bot.sendVoice(targetUserId, fileId, { caption: '📩 From Support' });
      } else if (msg.video) {
        fileId = msg.video.file_id; mediaType = 'video';
        await bot.sendVideo(targetUserId, fileId, {
          caption: msg.caption ? `📩 ${escapeHtml(msg.caption)}` : '📩 From Support',
          parse_mode: 'HTML',
        });
      } else {
        await bot.sendMessage(chatId, '⚠️ Unsupported message type.');
        return;
      }

      insertMsg.run(targetUserId, null, null, 'out', contentText, mediaType, fileId);
      await bot.sendMessage(chatId, '✅ Sent.', {
        reply_markup: { inline_keyboard: [[
          { text: '💬 Open chat', callback_data: `chat_${targetUserId}` },
          { text: '🔙 Inbox',     callback_data: 'inbox' },
        ]] },
      });
    } catch (e) {
      logger.error(`Support reply to ${targetUserId} failed: ${e.message}`);
      await bot.sendMessage(chatId, `❌ Failed: ${e.message}`);
    }
    return;
  }

  // ── CUSTOMER SIDE ─────────────────────────────────────────────────────────
  const username    = msg.from.username   || null;
  const firstName   = msg.from.first_name || null;
  const contentText = msg.text || msg.caption || '';
  let mediaType = null, fileId = null;

  if (msg.photo && msg.photo.length) { fileId = msg.photo[msg.photo.length - 1].file_id; mediaType = 'photo'; }
  else if (msg.document) { fileId = msg.document.file_id; mediaType = 'document'; }
  else if (msg.voice)    { fileId = msg.voice.file_id;    mediaType = 'voice'; }
  else if (msg.video)    { fileId = msg.video.file_id;    mediaType = 'video'; }

  const thread = queries.ensureSupportThread(userId);

  // One-time welcome — this replaces the old per-message auto-reply.
  if (!thread.welcomed) {
    const welcome = queries.getSetting(
      'support_welcome_message',
      '👋 Welcome to Customer Support!\n\nOur team will reply as soon as possible.'
    );
    await bot.sendMessage(chatId, welcome, { parse_mode: 'HTML' }).catch(() => {});
    queries.markSupportWelcomed(userId);
  }

  insertMsg.run(userId, username, firstName, 'in', contentText, mediaType, fileId);

  // ✓ indicator — one per conversation, edited in place
  await updateReceiptSent(userId);

  // ── Alert staff, but only once per unread batch ───────────────────────────
  const name    = displayName(username, firstName, userId);
  const preview = contentText ? contentText.slice(0, 120) : `[${mediaType || 'message'}]`;
  const firstUnread = getFirstUnread.get(userId);

  try {
    await notifyAdmin(bot, {
      type:  'support_message',
      title: `New support message from ${name}`,
      body:
        `👤 <b>Customer:</b> ${escapeHtml(name)}\n` +
        `🆔 <code>${userId}</code>\n\n` +
        `💬 ${escapeHtml(preview)}`,
      // Keyed on the FIRST unread message of the batch, so follow-up messages
      // in the same batch reuse the key and are suppressed.
      dedupeKey: `support_message:${userId}:${firstUnread ? firstUnread.id : 'x'}`,
      refType: 'support_thread',
      refId:   userId,
      buttons: [[{ text: '💬 Open chat', callback_data: `chat_${userId}` }]],
    });
  } catch (e) {
    logger.warn(`Support staff alert failed: ${e.message}`);
  }
});

bot.on('polling_error', (err) => {
  logger.warn(`Support bot polling error: ${err.message}`);
});

module.exports = bot;
