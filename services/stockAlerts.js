'use strict';

/**
 * Stock alerts for the admin (out-of-stock + low-stock).
 *
 * Repetition is prevented with two latch flags stored on the product row:
 *   products.oos_notified  — set to 1 once the "sold out" alert has been sent
 *   products.low_notified  — set to 1 once the "running low" alert has been sent
 *
 * Both flags are cleared by `resetStockAlertFlags()` as soon as stock rises
 * back above the threshold. That is what gives the behaviour the spec asks for:
 * a product that sells out, gets restocked and sells out again produces exactly
 * two alerts — never a stream of them while it sits at zero.
 *
 * The threshold is per product (`products.low_stock_threshold`), falling back
 * to the global `low_stock_threshold_default` setting when the product has none.
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

/**
 * Evaluate a product's stock level and fire admin alerts when a boundary is
 * crossed. Safe to call after every stock mutation — it is idempotent.
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

  const qty       = Number(product.stock_quantity) || 0;
  const threshold = thresholdFor(product);
  const botInfo   = await bot.getMe().catch(() => ({ username: '' }));

  const openBtn = botInfo.username
    ? [[{ text: '🛒 View product', url: `https://t.me/${botInfo.username}?start=p_${product.id}` }],
       [{ text: '📦 Manage stock', callback_data: `admin_stock_select_p_${product.id}` }]]
    : [[{ text: '📦 Manage stock', callback_data: `admin_stock_select_p_${product.id}` }]];

  const titleClean = escapeHtml(String(product.title || '').replace(/\[emoji:\d+\]/g, '').trim());

  // ── Restocked above the threshold → clear both latches ────────────────────
  if (qty > threshold) {
    if (product.oos_notified || product.low_notified) {
      db.resetStockAlertFlags(product.id);
      logger.info(`Stock alerts re-armed for product #${product.id} (qty ${qty} > ${threshold})`);
    }
    return;
  }

  // ── Out of stock ──────────────────────────────────────────────────────────
  if (qty === 0) {
    if (product.oos_notified) return; // already alerted, stay quiet
    db.setOosNotified(product.id, true);
    db.setLowNotified(product.id, true); // suppress a redundant low alert too

    await notifyAdmin(bot, {
      type:  'stock_out',
      // The product name belongs in the title, not only in the body: the
      // notification LISTS render titles, so a generic title left every row
      // reading "Product is out of stock" with no way to tell them apart.
      title: `Out of stock — ${titleClean.slice(0, 40)}`,
      body:
        `📦 <b>Product:</b> ${titleClean}\n` +
        `🆔 <b>ID:</b> <code>${product.id}</code>\n` +
        `💵 <b>Price:</b> $${Number(product.price || 0).toFixed(2)}\n` +
        `📊 <b>Stock:</b> <b>0</b>\n\n` +
        `<i>Restock the product to resume sales.</i>`,
      // Includes the current stock cycle so a later sell-out produces a new key.
      dedupeKey: `stock_out:${product.id}:${product.sales_count || 0}`,
      refType: 'product',
      refId:   product.id,
      buttons: openBtn,
    });
    return;
  }

  // ── Running low (0 < qty <= threshold) ────────────────────────────────────
  if (product.low_notified) return;
  db.setLowNotified(product.id, true);

  await notifyAdmin(bot, {
    type:  'stock_low',
    title: `Low stock (${qty} left) — ${titleClean.slice(0, 34)}`,
    body:
      `📦 <b>Product:</b> ${titleClean}\n` +
      `🆔 <b>ID:</b> <code>${product.id}</code>\n` +
      `💵 <b>Price:</b> $${Number(product.price || 0).toFixed(2)}\n` +
      `📊 <b>Remaining:</b> <b>${qty}</b> (alert threshold: ${threshold})`,
    dedupeKey: `stock_low:${product.id}:${product.sales_count || 0}`,
    refType: 'product',
    refId:   product.id,
    buttons: openBtn,
  });
}

module.exports = { evaluateStock, thresholdFor };
