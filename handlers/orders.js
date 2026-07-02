'use strict';

const db = require('../database/queries');
const { ordersListKb, orderDetailKb, backKb } = require('../utils/keyboard');
const { formatPrice, statusEmoji } = require('../utils/format');

async function showOrders(bot, chatId, userId, messageId) {
  const orders = db.getUserOrders(userId);

  if (!orders.length) {
    await bot.editMessageText(
      "📦 <b>My Orders</b>\n\nYou haven't placed any orders yet.",
      { chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [
          [{ text: '🔙 Back', callback_data: 'back_main' }],
        ] } }
    );
    return;
  }

  await bot.editMessageText(
    `📦 <b>My Orders</b>\n\n<i>Last ${orders.length} orders:</i>`,
    { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: ordersListKb(orders) }
  );
}

async function showOrderDetail(bot, chatId, userId, orderId, messageId) {
  const order = db.getOrder(orderId);

  if (!order || order.user_id !== userId) {
    await bot.answerCallbackQuery(messageId, { text: '❌ Order not found.', show_alert: true }).catch(() => {});
    return;
  }

  const methodLabel = { wallet: '💰 Wallet', binance: '🟡 Binance Pay' }[order.payment_method] || 'N/A';

  let text =
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🆔 <b>ORDER ID: #${order.id}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `${statusEmoji(order.status)} <b>Status:</b> ${order.status.toUpperCase()}\n` +
    `🛒 <b>Product:</b> ${order.product_title}\n` +
    `🔢 <b>Quantity:</b> ${order.quantity}\n` +
    (order.email ? `📧 <b>Email:</b> ${order.email}\n` : '') +
    `💵 <b>Total:</b> ${formatPrice(order.total_price)}\n` +
    `💳 <b>Payment:</b> ${methodLabel}\n` +
    `📅 <b>Date:</b> ${(order.created_at || '').slice(0, 16)}\n`;

  let contentAsFile = false;
  if (order.status === 'delivered' && order.delivered_content) {
    const c = String(order.delivered_content);
    const lineCount = (c.match(/\n/g) || []).length;
    if (c.length > 500 || lineCount >= 5) {
      // Content is large — will be sent as file after the message
      contentAsFile = true;
      text += `\n━━━━━━━━━━━━━━━━━━━━\n📎 <b>Your ${order.quantity} item(s) will be sent as a file below.</b>`;
    } else {
      const safe = c.replace(/[<>&]/g, ch => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[ch]));
      text += `\n━━━━━━━━━━━━━━━━━━━━\n🎁 <b>Your Product:</b>\n\n<code>${safe}</code>`;
    }
  }

  // Check refund status & warranty
  let refundButton = null;
  let refundStatus = '';
  const existingRefund = db.getPendingRefundForOrder(order.id);
  if (existingRefund) {
    refundStatus = `\n\n🔄 <b>Refund Status:</b> <b>PENDING</b>\n<i>Your refund request is being reviewed.</i>`;
  } else if (order.status === 'delivered') {
    // Check warranty period
    const product = db.getProduct(order.product_id);
    const warranty = product?.warranty || '';
    const m = warranty.match(/(\d+)\s*(day|d|month|m|year|y)/i);
    if (m) {
      const num = parseInt(m[1], 10);
      const unit = m[2].toLowerCase();
      const days = unit.startsWith('d') ? num : (unit.startsWith('m') ? num * 30 : num * 365);
      const orderDate = new Date((order.paid_at || order.created_at).replace(' ', 'T') + 'Z');
      const expiresAt = new Date(orderDate.getTime() + days * 24 * 3600 * 1000);
      if (expiresAt > new Date()) {
        refundButton = [{ text: '🔄 Request Refund', callback_data: `refund_req_${order.id}` }];
        const daysLeft = Math.ceil((expiresAt - new Date()) / (24 * 3600 * 1000));
        refundStatus = `\n\n🛡 <b>Warranty:</b> ${daysLeft} day(s) remaining`;
      }
    }
  }

  // Check past refund history for this order
  const userRefunds = db.getUserRefundRequests(userId);
  const pastRefund = userRefunds.find(r => r.order_id === order.id && r.status !== 'pending');
  if (pastRefund) {
    const emoji = pastRefund.status === 'approved' ? '✅' : '❌';
    refundStatus += `\n\n${emoji} <b>Previous Refund:</b> ${pastRefund.status.toUpperCase()}` +
      (pastRefund.admin_note ? `\n📝 <i>${pastRefund.admin_note}</i>` : '');
  }

  text += refundStatus;

  const kb = { inline_keyboard: [] };
  // Add cancel button for pending orders
  if (order.status === 'pending') {
    kb.inline_keyboard.unshift([{ text: '❌ Cancel This Order', callback_data: `cancel_my_order_${order.id}` }]);
  }
  if (refundButton) kb.inline_keyboard.push(refundButton);
  kb.inline_keyboard.push([{ text: '🔙 Back to Orders', callback_data: 'menu_orders' }]);

  try {
    await bot.editMessageText(text, {
      chat_id: chatId, message_id: messageId,
      parse_mode: 'HTML', reply_markup: kb,
    });
  } catch (e) {
    // Fallback: send a new message if edit fails
    try {
      await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: kb });
    } catch (e2) {}
  }

  // If content is large, send it as a file
  if (contentAsFile) {
    try {
      const buffer = Buffer.from(String(order.delivered_content), 'utf-8');
      const safeName = (order.product_title || 'product')
        .replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 30);
      const filename = `order_${order.id}_${safeName}.txt`;
      await bot.sendDocument(chatId, buffer, {
        caption: `📎 Order #${order.id} — ${order.quantity} item(s)`,
      }, { filename, contentType: 'text/plain' });
    } catch (e) {
      // Fallback: send chunked text
      try {
        const c = String(order.delivered_content);
        const chunks = c.match(/[\s\S]{1,3500}/g) || [];
        for (const chunk of chunks) {
          const safe = chunk.replace(/[<>&]/g, ch => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[ch]));
          await bot.sendMessage(chatId, `<pre>${safe}</pre>`, { parse_mode: 'HTML' });
        }
      } catch (e2) {}
    }
  }
}

module.exports = { showOrders, showOrderDetail };
