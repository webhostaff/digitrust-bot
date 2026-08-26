'use strict';

/**
 * Customer order history.
 *
 * Previously this screen silently truncated the list: `ordersListKb` did
 * `orders.slice(0, 10)`, so a customer with more than ten orders simply never
 * saw the older ones. The list is now paginated (nothing is dropped) and can be
 * narrowed with date filters.
 */

const db = require('../database/queries');
const logger = require('../utils/logger');
const { orderDetailKb, backKb } = require('../utils/keyboard');
const { formatPrice, statusEmoji } = require('../utils/format');

const PAGE_SIZE = 8;

// Whitelisted filters. The callback only ever carries one of these keys, so no
// user-controlled value reaches the query layer.
const FILTERS = {
  all:        '📋 All',
  '7d':       '🗓 7 days',
  '30d':      '📆 30 days',
  this_month: '🈷 This month',
  last_month: '⏮ Last month',
};

const escapeHtml = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const cleanTitle = (t) =>
  String(t || '').replace(/\[emoji:\d+\]/g, '').replace(/\s+/g, ' ').trim();

/** Human status label — includes the manual-delivery states. */
function statusLabel(order) {
  if (order.status === 'awaiting_delivery') {
    if (order.manual_status === 'processing') return '⚙️ In progress';
    if (order.manual_status === 'cancelled')  return '❌ Cancelled';
    return '🕐 Awaiting delivery';
  }
  return `${statusEmoji(order.status)} ${String(order.status || '').toUpperCase()}`;
}

function shortStatusIcon(order) {
  if (order.status === 'awaiting_delivery') {
    return order.manual_status === 'processing' ? '⚙️' : '🕐';
  }
  return statusEmoji(order.status);
}

/** "29/07 14:05" from a stored UTC timestamp. */
function shortDate(ts) {
  const raw = String(ts || '').replace(' ', 'T');
  const d = new Date(raw.endsWith('Z') ? raw : raw + 'Z');
  if (isNaN(d.getTime())) return String(ts || '').slice(0, 16);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function longDate(ts) {
  const raw = String(ts || '').replace(' ', 'T');
  const d = new Date(raw.endsWith('Z') ? raw : raw + 'Z');
  if (isNaN(d.getTime())) return String(ts || '').slice(0, 16);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Build the keyboard: filter row, one row per order, pagination, back.
 */
function ordersKeyboard(orders, filter, page, totalPages) {
  const rows = [];

  // Filter chips — two rows so labels stay readable on a phone.
  const keys = Object.keys(FILTERS);
  const mkChip = (k) => ({
    text: (k === filter ? '✓ ' : '') + FILTERS[k],
    callback_data: `orders_f_${k}_0`,
  });
  rows.push(keys.slice(0, 3).map(mkChip));
  rows.push(keys.slice(3).map(mkChip));

  for (const o of orders) {
    const title = cleanTitle(o.product_title).slice(0, 22) || 'Product';
    rows.push([{
      text: `${shortStatusIcon(o)} #${o.id} · ${title} · ${formatPrice(o.total_price)}`,
      callback_data: `order_detail_${o.id}`,
    }]);
  }

  if (totalPages > 1) {
    const nav = [];
    if (page > 0) nav.push({ text: '⬅️ Prev', callback_data: `orders_f_${filter}_${page - 1}` });
    nav.push({ text: `${page + 1}/${totalPages}`, callback_data: 'noop' });
    if (page < totalPages - 1) nav.push({ text: 'Next ➡️', callback_data: `orders_f_${filter}_${page + 1}` });
    rows.push(nav);
  }

  rows.push([{ text: '🔙 Back', callback_data: 'back_main' }]);
  return { inline_keyboard: rows };
}

/**
 * Render the order list.
 *
 * @param {string} filter one of the FILTERS keys
 * @param {number} page   zero-based
 */
async function showOrders(bot, chatId, userId, messageId, filter = 'all', page = 0) {
  const safeFilter = Object.prototype.hasOwnProperty.call(FILTERS, filter) ? filter : 'all';
  const orders = db.getUserOrdersFiltered(userId, safeFilter);

  const totalPages  = Math.max(1, Math.ceil(orders.length / PAGE_SIZE));
  const safePage    = Math.max(0, Math.min(page, totalPages - 1));
  const pageOrders  = orders.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  // Small summary so the customer can see nothing is missing.
  const totalAll  = db.getUserOrdersAll(userId).length;
  const delivered = orders.filter((o) => o.status === 'delivered').length;
  const waiting   = orders.filter((o) => o.status === 'awaiting_delivery').length;
  const spent     = orders
    .filter((o) => ['delivered', 'awaiting_delivery'].includes(o.status))
    .reduce((s, o) => s + (Number(o.total_price) || 0), 0);

  let text;
  if (!orders.length) {
    text =
      `📦 <b>My Orders</b>\n\n` +
      `No orders in this period.\n\n` +
      (totalAll > 0
        ? `<i>You have ${totalAll} order(s) in total — try the 📋 All filter.</i>`
        : `<i>You haven't placed any orders yet.</i>`);
  } else {
    text =
      `📦 <b>My Orders</b> — ${FILTERS[safeFilter]}\n\n` +
      `📊 Showing: <b>${orders.length}</b> of <b>${totalAll}</b> total\n` +
      `✅ Delivered: <b>${delivered}</b>` +
      (waiting ? `   🕐 Awaiting: <b>${waiting}</b>` : '') + `\n` +
      `💰 Spent: <b>${formatPrice(spent)}</b>\n\n` +
      `<i>Page ${safePage + 1} of ${totalPages} — newest first.</i>`;
  }

  const kb = ordersKeyboard(pageOrders, safeFilter, safePage, totalPages);

  if (messageId) {
    try {
      await bot.editMessageText(text, {
        chat_id: chatId, message_id: messageId,
        parse_mode: 'HTML', reply_markup: kb,
      });
      return;
    } catch (e) {
      // Previous message was a photo, or content is identical — fall through.
      try { await bot.deleteMessage(chatId, messageId); } catch (e2) { /* ignore */ }
    }
  }
  await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: kb });
}

/**
 * Single order view.
 */
async function showOrderDetail(bot, chatId, userId, orderId, messageId, callbackQueryId = null) {
  const order = db.getOrder(orderId);

  // Ownership check — a customer can only ever open their own order.
  if (!order || order.user_id !== userId) {
    if (callbackQueryId) {
      await bot.answerCallbackQuery(callbackQueryId, {
        text: '❌ Order not found.', show_alert: true,
      }).catch(() => {});
    }
    return;
  }

  const methodLabel = {
    wallet:    '💰 Wallet',
    binance:   '🟡 Binance Pay',
    cryptobot: '🤖 CryptoBot',
  }[order.payment_method] || (order.payment_method || 'N/A');

  const product = db.getProduct(order.product_id);
  const manual  = db.getManualDeliveryByOrder(order.id);

  let text =
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🆔 <b>ORDER #${order.id}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `${statusLabel(order)}\n` +
    `🛒 <b>Product:</b> ${escapeHtml(cleanTitle(order.product_title))}\n` +
    `🔢 <b>Quantity:</b> ${order.quantity}\n` +
    (order.email ? `📧 <b>Email:</b> ${escapeHtml(order.email)}\n` : '') +
    `💵 <b>Total:</b> ${formatPrice(order.total_price)}\n` +
    `💳 <b>Payment:</b> ${methodLabel}\n` +
    `📅 <b>Date:</b> ${longDate(order.created_at)}\n`;

  // ── Manual delivery progress ────────────────────────────────────────────
  if (manual && manual.status !== 'delivered') {
    const stageText = {
      pending:    '🕐 <b>Awaiting delivery</b>\nOur team has your order in the queue.',
      processing: '⚙️ <b>Being prepared</b>\nOur team is working on it right now.',
      cancelled:  '❌ <b>Cancelled</b>\nThe amount was returned to your wallet.',
    }[manual.status] || '';
    text += `\n━━━━━━━━━━━━━━━━━━━━\n🖐 <b>Manual delivery</b>\n${stageText}\n`;
  }

  let contentAsFile = false;
  if (order.status === 'delivered' && order.delivered_content) {
    const c = String(order.delivered_content);
    const lineCount = (c.match(/\n/g) || []).length;
    if (c.length > 500 || lineCount >= 5) {
      contentAsFile = true;
      text += `\n━━━━━━━━━━━━━━━━━━━━\n📎 <b>Your ${order.quantity} item(s) will be sent as a file below.</b>`;
    } else {
      text += `\n━━━━━━━━━━━━━━━━━━━━\n🎁 <b>Your Product:</b>\n\n<code>${escapeHtml(c)}</code>`;
    }
  }

  // ── Refund availability ─────────────────────────────────────────────────
  // Server-side eligibility: the button only appears when the PRODUCT itself
  // is flagged refundable AND the warranty window is still open.
  let refundButton = null;
  let refundStatus = '';
  const existingRefund = db.getPendingRefundForOrder(order.id);

  if (existingRefund) {
    refundStatus = `\n\n🔄 <b>Refund Status:</b> <b>PENDING</b>\n<i>Your request is being reviewed.</i>`;
  } else if (order.status === 'delivered') {
    const refundable = Number(product?.refund_enabled) === 1;
    const warranty = product?.warranty || '';
    const m = warranty.match(/(\d+)\s*(day|d|month|m|year|y)/i);

    if (!refundable) {
      refundStatus = `\n\n🚫 <i>This product is not eligible for refunds.</i>`;
    } else if (m) {
      const num  = parseInt(m[1], 10);
      const unit = m[2].toLowerCase();
      const days = unit.startsWith('d') ? num : (unit.startsWith('m') ? num * 30 : num * 365);
      const baseRaw = String(order.paid_at || order.created_at || '').replace(' ', 'T');
      const orderDate = new Date(baseRaw.endsWith('Z') ? baseRaw : baseRaw + 'Z');
      const expiresAt = new Date(orderDate.getTime() + days * 24 * 3600 * 1000);
      if (expiresAt > new Date()) {
        refundButton = [{ text: '🔄 Request Refund', callback_data: `refund_req_${order.id}` }];
        const daysLeft = Math.ceil((expiresAt - new Date()) / (24 * 3600 * 1000));
        refundStatus = `\n\n🛡 <b>Warranty:</b> ${daysLeft} day(s) remaining`;
      } else {
        refundStatus = `\n\n🛡 <i>Warranty period has ended.</i>`;
      }
    }
  }

  // Past refund outcome, if any
  const userRefunds = db.getUserRefundRequests(userId);
  const pastRefund = userRefunds.find((r) => r.order_id === order.id && r.status !== 'pending');
  if (pastRefund) {
    const emoji = pastRefund.status === 'approved' ? '✅' : '❌';
    refundStatus += `\n\n${emoji} <b>Previous Refund:</b> ${pastRefund.status.toUpperCase()}` +
      (pastRefund.admin_note ? `\n📝 <i>${escapeHtml(pastRefund.admin_note)}</i>` : '');
  }

  text += refundStatus;

  const kb = { inline_keyboard: [] };
  if (order.status === 'pending') {
    kb.inline_keyboard.push([{ text: '❌ Cancel This Order', callback_data: `cancel_my_order_${order.id}` }]);
  }
  if (refundButton) kb.inline_keyboard.push(refundButton);
  kb.inline_keyboard.push([{ text: '🔙 Back to Orders', callback_data: 'menu_orders' }]);

  // My Orders is the recovery path: it is where a customer goes when the
  // delivery message never arrived. It must be the most reliable screen in the
  // bot, so it never sends custom emoji either.
  try {
    await bot.editMessageText(text, {
      chat_id: chatId, message_id: messageId,
      parse_mode: 'HTML', reply_markup: kb, plain_emoji: true,
    });
  } catch (e) {
    try {
      await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: kb, plain_emoji: true });
    } catch (e2) {
      logger.error(`order detail #${order.id} could not be shown to ${chatId}: ${e2.message}`);
    }
  }

  if (contentAsFile) {
    try {
      const buffer = Buffer.from(String(order.delivered_content), 'utf-8');
      const safeName = cleanTitle(order.product_title || 'product')
        .replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 30);
      await bot.sendDocument(chatId, buffer, {
        caption: `📎 Order #${order.id} — ${order.quantity} item(s)`,
        plain_emoji: true,
      }, { filename: `order_${order.id}_${safeName}.txt`, contentType: 'text/plain' });
    } catch (e) {
      try {
        const chunks = String(order.delivered_content).match(/[\s\S]{1,3500}/g) || [];
        for (const chunk of chunks) {
          await bot.sendMessage(chatId, `<pre>${escapeHtml(chunk)}</pre>`, { parse_mode: 'HTML', plain_emoji: true });
        }
      } catch (e2) { /* ignore */ }
    }
  }
}

module.exports = { showOrders, showOrderDetail, FILTERS };
