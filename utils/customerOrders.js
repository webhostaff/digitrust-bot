'use strict';
/**
 * The "📦 Their orders" screen of the support bot, paged.
 *
 * It used to show the newest 20 orders and then "…and 57 more" with no way to see them,
 * which is exactly when support needs the old ones (a refund, "I never got order #15329").
 * Pure on purpose (no Telegram, no database): the caller passes the orders in.
 */

const PER_PAGE = 20;

const STATUS_ICON = {
  delivered: '✅', pending: '⏳', cancelled: '❌', awaiting_delivery: '🕐',
  awaiting_payment: '💳', refunded: '↩️',
};

function renderCustomerOrders({ orders, name, targetUserId, page = 0, perPage = PER_PAGE, formatDate, escapeHtml }) {
  const list  = Array.isArray(orders) ? orders : [];
  const total = list.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const p     = Math.min(Math.max(0, parseInt(page, 10) || 0), pages - 1);

  let txt = `📦 <b>Orders — ${escapeHtml(name)}</b>\n🆔 <code>${targetUserId}</code>\n`;

  if (!total) {
    return { text: txt + '\n<i>No orders yet.</i>', keyboard: backOnly(targetUserId), page: 0, pages: 1 };
  }

  const spent = list.filter((o) => o.status === 'delivered')
    .reduce((sum, o) => sum + (Number(o.total_price) || 0), 0);
  const from = p * perPage + 1;
  const to   = Math.min(total, (p + 1) * perPage);

  txt += `🧾 <b>${total}</b> orders · 💰 delivered: <b>$${spent.toFixed(2)}</b>\n`;
  if (pages > 1) txt += `📄 Page <b>${p + 1}/${pages}</b> · orders ${from}–${to} of ${total}\n`;
  txt += '\n';

  for (const o of list.slice(p * perPage, p * perPage + perPage)) {
    txt += `${STATUS_ICON[o.status] || '❓'} <b>#${o.id}</b> · ${escapeHtml(String(o.product_title || '').slice(0, 28))}\n` +
           `   $${Number(o.total_price || 0).toFixed(2)} · ${formatDate(o.created_at)}\n`;
  }

  const rows = [];
  if (pages > 1) {
    const go = (n) => `cust_orders_p_${targetUserId}_${n}`;
    rows.push([
      { text: '◀ Newer', callback_data: go(Math.max(0, p - 1)) },
      { text: `${p + 1}/${pages}`, callback_data: go(p) },
      { text: 'Older ▶', callback_data: go(Math.min(pages - 1, p + 1)) },
    ]);
    if (pages > 3) rows.push([
      { text: '⏮ Newest', callback_data: go(0) },
      { text: '⏭ Oldest', callback_data: go(pages - 1) },
    ]);
  }
  rows.push([{ text: '🔙 Back to chat', callback_data: `chat_${targetUserId}` }]);
  return { text: txt, keyboard: { inline_keyboard: rows }, page: p, pages };
}

function backOnly(targetUserId) {
  return { inline_keyboard: [[{ text: '🔙 Back to chat', callback_data: `chat_${targetUserId}` }]] };
}

module.exports = { renderCustomerOrders, PER_PAGE, STATUS_ICON };
