'use strict';

/**
 * Shared "stock was just added" hook (V167.31).
 *
 * The shop has several ways to add stock (single confirm, large batch upload,
 * bulk item paste). Pre-orders must be filled FIRST on every one of them, or a
 * normal buyer can grab the fresh stock before the people who pre-ordered —
 * which is exactly what happened when only the single-confirm path had this
 * logic. This one function is called from ALL of them so the behaviour is
 * identical everywhere:
 *   1. auto-deliver this product's reserved pre-orders (FIFO) from the new
 *      stock, before it is offered for normal sale;
 *   2. tell each customer their pre-order is ready;
 *   3. report to the admin;
 *   4. move the product back from "Out of Stock" to Other Products if needed;
 *   5. reset the pre-order-opening announcement flag.
 *
 * Best-effort — never throws into the stock-add flow.
 */

const db     = require('../database/queries');
const logger = require('../utils/logger');
const { escapeHtml, formatPrice } = require('../utils/format');

async function afterRestock(bot, productId, chatId) {
  const product = db.getProduct(productId);

  // 1–3) Fill reserved pre-orders first, from the stock just added.
  try {
    const { delivered, stoppedForStock } = db.autoFulfillPreordersForProduct(productId);
    for (const { preorder: pr, content } of delivered) {
      const now = new Date(); const pad = (n) => String(n).padStart(2, '0');
      const dateStr = `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
      const instr = (product && product.instruction)
        ? `\n━━━━━━━━━━━━━━━━━━━━\n📌 <b>Instructions:</b>\n${escapeHtml(product.instruction)}\n` : '';
      const userMsg =
        `🎉 <b>Your Pre-Order is Ready!</b>\n\n` +
        `📦 <b>Order:</b> ${escapeHtml(product?.title || '')}\n` +
        `🔢 <b>Quantity:</b> ${pr.quantity}\n` +
        (pr.email ? `📧 ${escapeHtml(pr.email)}\n` : '') +
        `💵 ${formatPrice(pr.total_paid)}\n` +
        `📅 Delivered: ${dateStr}\n\n` +
        `━━━━━━━━━━━━━━━━━━━━\n🎁 <b>Your Product(s):</b>\n\n` +
        `<code>${escapeHtml(content)}</code>\n` +
        `━━━━━━━━━━━━━━━━━━━━${instr}\n✨ Thank you for your patience!`;
      try {
        await bot.sendMessage(pr.user_id, userMsg, { parse_mode: 'HTML' });
      } catch (err) {
        try { await bot.sendMessage(pr.user_id, userMsg.replace(/<\/?[^>]+>/g, '')); }
        catch (err2) { logger.error(`[PREORDER AUTO] could not reach ${pr.user_id}: ${err2.message}`); }
      }
    }
    if (chatId && delivered.length > 0) {
      await bot.sendMessage(chatId,
        `🚀 <b>Auto-delivered ${delivered.length} pre-order(s)</b> from the stock you just added. The rest is now on normal sale.` +
        (stoppedForStock ? `\n\n⚠️ Stock ran out — some pre-orders are still waiting. Add more to deliver the rest.` : ''),
        { parse_mode: 'HTML' }).catch(() => {});
    } else if (chatId && stoppedForStock) {
      await bot.sendMessage(chatId,
        `⚠️ Pre-orders are waiting but there was not enough stock to deliver even one. Add more items.`,
        { parse_mode: 'HTML' }).catch(() => {});
    }
  } catch (e) {
    logger.warn(`Pre-order auto-deliver error: ${e.message}`);
  }

  // 4) Restore from "Out of Stock" if it now has stock again.
  try { db.syncStockCategory(productId); } catch (e) { logger.warn(`Stock-category restore error: ${e.message}`); }

  // 5) Allow a fresh pre-order-opening announcement next time it sells out.
  try {
    const fresh = db.getProduct(productId);
    if (fresh && (Number(fresh.stock_quantity) || 0) > 0) db.setSetting(`pre_announced_${productId}`, '');
  } catch (_) {}
}

module.exports = { afterRestock };
