'use strict';

/**
 * Out-of-stock alerts.
 *
 * This is a LIVE STATUS LIST, not an event log. The list answers one question:
 * "what is out of stock right now?" As soon as a product is restocked its alert
 * is deleted, so no historical rows accumulate.
 *
 * Low-stock ("running low") alerts are OFF by default — they buried the
 * out-of-stock rows that actually need action. They can be switched back on
 * with the `stock_low_alerts_enabled` setting.
 *
 * Repetition is prevented by a latch on the product row (`oos_notified`),
 * cleared the moment stock returns. A product that sells out, is restocked and
 * sells out again therefore produces exactly two alerts — never a stream of
 * them while it sits at zero.
 */

const db     = require('../database/queries');
const logger = require('../utils/logger');
const { notifyAdmin, escapeHtml } = require('./adminNotify');

/** Effective low-stock threshold for a product. */
function thresholdFor(product) {
  const own = Number(product.low_stock_threshold) || 0;
  if (own > 0) return own;
  const global = parseInt(db.getSetting('low_stock_threshold_default', '5'), 10);
  return Number.isFinite(global) && global > 0 ? global : 5;
}

/** Are "running low" alerts switched on? Off unless explicitly enabled. */
function lowAlertsEnabled() {
  return db.getSetting('stock_low_alerts_enabled', '0') === '1';
}

/**
 * Evaluate a product's stock level and keep the alert list in sync with
 * reality. Safe to call after every stock mutation — it is idempotent.
 *
 * @param {TelegramBot} bot
 * @param {number} productId
 */
async function evaluateStock(bot, productId) {
  let product;
  try {
    product = db.getProduct(productId);
  } catch (e) {
    logger.warn(`evaluateStock: cannot load product ${productId}: ${e.message}`);
    return;
  }
  if (!product) return;

  const qty = Number(product.stock_quantity) || 0;

  // ── Back in stock → the alert is no longer true, so remove it ────────────
  if (qty > 0) {
    const removed = db.deleteStockNotifications(product.id);
    if (removed > 0 || product.oos_notified || product.low_notified) {
      db.resetStockAlertFlags(product.id);
      if (removed > 0) {
        logger.info(`Cleared ${removed} stock alert(s) for product #${product.id} — restocked to ${qty}`);
      }
    }

    // Optional low-stock warning, only if the admin turned it back on.
    if (lowAlertsEnabled()) {
      const threshold = thresholdFor(product);
      if (qty <= threshold && !product.low_notified) {
        db.setLowNotified(product.id, true);
        await sendAlert(bot, product, 'stock_low', qty, threshold);
      }
    }
    return;
  }

  // ── Out of stock ─────────────────────────────────────────────────────────
  if (product.oos_notified) return; // already listed, stay quiet
  db.setOosNotified(product.id, true);
  await sendAlert(bot, product, 'stock_out', 0, 0);
}

/** Build and dispatch the alert. */
async function sendAlert(bot, product, type, qty, threshold) {
  const botInfo = await bot.getMe().catch(() => ({ username: '' }));
  const titleClean = escapeHtml(
    String(product.title || '').replace(/\[emoji:\d+\]/g, '').trim()
  );

  const buttons = botInfo.username
    ? [[{ text: '🛒 View product', url: `https://t.me/${botInfo.username}?start=p_${product.id}` }],
       [{ text: '📦 Manage stock', callback_data: `admin_stock_select_p_${product.id}` }]]
    : [[{ text: '📦 Manage stock', callback_data: `admin_stock_select_p_${product.id}` }]];

  const isOut = type === 'stock_out';

  await notifyAdmin(bot, {
    type,
    // The product name goes in the TITLE: the notification lists render titles,
    // so a fixed string would leave every row looking identical.
    title: isOut
      ? `Out of stock — ${titleClean.slice(0, 40)}`
      : `Low stock (${qty} left) — ${titleClean.slice(0, 34)}`,
    body:
      `📦 <b>Product:</b> ${titleClean}\n` +
      `🆔 <b>ID:</b> <code>${product.id}</code>\n` +
      `💵 <b>Price:</b> $${Number(product.price || 0).toFixed(2)}\n` +
      (isOut
        ? `📊 <b>Stock:</b> <b>0</b>\n\n<i>Restock the product to resume sales. ` +
          `This alert disappears from the list automatically once you do.</i>`
        : `📊 <b>Remaining:</b> <b>${qty}</b> (alert threshold: ${threshold})`),
    // The sales counter is part of the key, so a later sell-out after a restock
    // is treated as a new event rather than a duplicate.
    dedupeKey: `${type}:${product.id}:${product.sales_count || 0}`,
    refType: 'product',
    refId:   product.id,
    buttons,
  });
}

module.exports = { evaluateStock, thresholdFor, lowAlertsEnabled };
