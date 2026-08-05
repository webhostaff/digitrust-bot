'use strict';

/**
 * Manual delivery.
 *
 * Products flagged `delivery_type = 'manual'` are paid for normally but are NOT
 * handed over automatically — no `product_items` row is consumed. Instead the
 * order moves to status `awaiting_delivery` and a row is opened in
 * `manual_deliveries` for a human to fulfil.
 *
 * Guarantees required by the spec, and where they come from:
 *   • never created before payment succeeds  → callers only invoke this after
 *     the atomic charge/settle transaction returns 'ok'
 *   • never duplicated for one order         → UNIQUE(order_id) + INSERT OR IGNORE
 *   • never disappears before it is done     → the task is a persistent row and
 *     the panel's default tab shows every non-final task
 *   • no repeated admin pings                → notifyAdmin() dedupe key is the
 *     task id, and `notified_at` latches the first push
 */

const db     = require('../database/queries');
const logger = require('../utils/logger');
const config = require('../config');
const { notifyAdmin, escapeHtml, stamp } = require('../services/adminNotify');
const { formatPrice } = require('../utils/format');

const STATUS_LABEL = {
  pending:    '🕐 Awaiting delivery',
  processing: '⚙️ In progress',
  delivered:  '✅ Delivered',
  cancelled:  '❌ Cancelled',
};

/** Clean a stored product title for display (drops [emoji:ID] markers). */
function cleanTitle(t) {
  return escapeHtml(String(t || '').replace(/\[emoji:\d+\]/g, '').trim());
}

/**
 * Open a manual-delivery task for an already-paid order and notify everyone.
 *
 * @param {TelegramBot} bot
 * @param {object} order   full order row (must already be paid)
 * @param {string} paymentMethod human label, e.g. 'wallet' / 'USDT TRC20'
 * @returns {Promise<object|null>} the manual delivery row
 */
async function openManualDelivery(bot, order, paymentMethod) {
  const product = db.getProduct(order.product_id);

  // Idempotent: a second call for the same order returns the existing task
  // and pushes nothing, which is what makes webhook retries harmless.
  const { created, row } = db.createManualDelivery({
    orderId:       order.id,
    userId:        order.user_id,
    productId:     order.product_id,
    quantity:      order.quantity,
    email:         order.email || null,
    totalPaid:     order.total_price,
    paymentMethod: paymentMethod || order.payment_method || null,
  });

  if (!row) {
    logger.error(`openManualDelivery: task row missing for order #${order.id}`);
    return null;
  }
  if (!created) {
    logger.info(`openManualDelivery: task already exists for order #${order.id} — skipping notifications`);
    return row;
  }

  // ── Tell the customer their order is queued, not lost ─────────────────────
  try {
    await bot.sendMessage(
      order.user_id,
      `✅ <b>Payment Received</b>\n\n` +
      `📦 <b>Product:</b> ${cleanTitle(product?.title || order.product_title)}\n` +
      `🔢 <b>Quantity:</b> ${order.quantity}\n` +
      (order.email ? `📧 <b>Email:</b> <code>${escapeHtml(order.email)}</code>\n` : '') +
      `💵 <b>Paid:</b> ${formatPrice(order.total_price)}\n` +
      `🆔 <b>Order:</b> #${order.id}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🖐 <b>This product is delivered manually.</b>\n\n` +
      `Our team has been notified and will prepare your order shortly. ` +
      `You will receive another message here the moment it is ready.\n\n` +
      `<i>You can follow the status any time from 📦 My Orders.</i>`,
      {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '📦 My Orders', callback_data: 'menu_orders' }]] },
      }
    );
  } catch (e) {
    logger.warn(`openManualDelivery: could not notify customer ${order.user_id}: ${e.message}`);
  }

  // ── Tell the admin there is work to do ────────────────────────────────────
  const buyer     = db.getUser(order.user_id);
  const buyerName = buyer?.username ? `@${buyer.username}` : (buyer?.first_name || `User ${order.user_id}`);

  await notifyAdmin(bot, {
    type:  'manual_delivery',
    title: 'New manual delivery request',
    body:
      `🆔 <b>Task:</b> #${row.id}   <b>Order:</b> #${order.id}\n` +
      `📦 <b>Product:</b> ${cleanTitle(product?.title || order.product_title)}\n` +
      `🔢 <b>Quantity:</b> ${order.quantity}\n` +
      (order.email ? `📧 <b>Email:</b> <code>${escapeHtml(order.email)}</code>\n` : '') +
      `💵 <b>Paid:</b> ${formatPrice(order.total_price)}\n` +
      `💳 <b>Method:</b> ${escapeHtml(paymentMethod || 'n/a')}\n\n` +
      `👤 <b>Customer:</b> ${escapeHtml(buyerName)}\n` +
      `🆔 <b>User ID:</b> <code>${order.user_id}</code>\n` +
      `🕒 <b>Placed:</b> ${stamp()}`,
    dedupeKey: `manual_delivery:${row.id}`,
    refType:   'manual_delivery',
    refId:     row.id,
    buttons: [
      [{ text: '📦 Open task', callback_data: `admin_md_view_${row.id}` }],
      [{ text: '✅ Mark delivered', callback_data: `admin_md_deliver_${row.id}` }],
    ],
  });

  db.markManualNotified(row.id);
  return row;
}

/**
 * Complete a task: notify the customer, close the order, store any content.
 *
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
async function completeManualDelivery(bot, taskId, content = null) {
  const task = db.getManualDelivery(taskId);
  if (!task) return { ok: false, reason: 'not_found' };
  if (task.status === 'delivered') return { ok: false, reason: 'already_delivered' };

  const changed = db.markManualDelivered(taskId, content);
  if (!changed) return { ok: false, reason: 'already_delivered' };

  // Close the underlying order so it stops looking pending everywhere else.
  try {
    db.db.prepare(`
      UPDATE orders
      SET status = 'delivered', delivered_content = COALESCE(?, delivered_content)
      WHERE id = ?
    `).run(content, task.order_id);
  } catch (e) {
    logger.error(`completeManualDelivery: order update failed: ${e.message}`);
  }

  const product = db.getProduct(task.product_id);
  const instr = product?.instruction
    ? `\n━━━━━━━━━━━━━━━━━━━━\n📌 <b>Instructions:</b>\n${escapeHtml(product.instruction)}\n`
    : '';

  const body =
    `🎉 <b>Your Order Is Ready!</b>\n\n` +
    `🆔 <b>Order:</b> #${task.order_id}\n` +
    `📦 <b>Product:</b> ${cleanTitle(task.product_title)}\n` +
    `🔢 <b>Quantity:</b> ${task.quantity}\n` +
    (task.email ? `📧 ${escapeHtml(task.email)}\n` : '') +
    `💵 ${formatPrice(task.total_paid)}\n` +
    `📅 <b>Delivered:</b> ${stamp()}\n` +
    (content
      ? `\n━━━━━━━━━━━━━━━━━━━━\n🎁 <b>Your Product:</b>\n\n<code>${escapeHtml(content)}</code>\n━━━━━━━━━━━━━━━━━━━━`
      : '') +
    instr +
    `\n✨ Thank you for your purchase!`;

  let sent = false;
  try {
    await bot.sendMessage(task.user_id, body, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '📦 My Orders', callback_data: 'menu_orders' }]] },
    });
    sent = true;
  } catch (e) {
    // HTML can fail on odd content — retry as plain text before giving up.
    try {
      await bot.sendMessage(task.user_id, body.replace(/<\/?[^>]+>/g, ''));
      sent = true;
    } catch (e2) {
      logger.error(`completeManualDelivery: customer ${task.user_id} unreachable: ${e2.message}`);
    }
  }

  return { ok: true, notified: sent, task: db.getManualDelivery(taskId) };
}

/**
 * Cancel a task and refund the customer's wallet.
 */
async function cancelManualDelivery(bot, taskId, reason = '') {
  const task = db.getManualDelivery(taskId);
  if (!task) return { ok: false, reason: 'not_found' };
  if (task.status === 'delivered') return { ok: false, reason: 'already_delivered' };
  if (task.status === 'cancelled') return { ok: false, reason: 'already_cancelled' };

  db.setManualDeliveryStatus(taskId, 'cancelled', reason || 'Cancelled by admin');

  // Money back to the wallet — the customer paid but receives nothing.
  const amount = Number(task.total_paid) || 0;
  if (amount > 0) {
    db.updateBalance(task.user_id, amount);
    db.addTransaction({
      userId:      task.user_id,
      type:        'refund',
      amount,
      description: `Manual delivery cancelled — order #${task.order_id}`,
      refId:       `manual_cancel_${taskId}`,
      orderId:     task.order_id,
    });
  }

  try {
    db.db.prepare("UPDATE orders SET status='cancelled' WHERE id = ?").run(task.order_id);
  } catch (e) { /* non-fatal */ }

  try {
    await bot.sendMessage(
      task.user_id,
      `❌ <b>Order #${task.order_id} Cancelled</b>\n\n` +
      `📦 ${cleanTitle(task.product_title)}\n` +
      (reason ? `📝 <i>${escapeHtml(reason)}</i>\n` : '') +
      (amount > 0 ? `\n💰 <b>${formatPrice(amount)}</b> has been refunded to your wallet.\n` : '') +
      `\nPlease contact support if you have any questions.`,
      { parse_mode: 'HTML' }
    );
  } catch (e) { /* customer may have blocked the bot */ }

  return { ok: true };
}

module.exports = {
  openManualDelivery,
  completeManualDelivery,
  cancelManualDelivery,
  STATUS_LABEL,
  cleanTitle,
};
