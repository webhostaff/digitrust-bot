'use strict';

/**
 * Add accounts to a product's stock — the same thing the admin panel's
 * "Add stock → DONE" does, in one place so every path behaves the same:
 * insert the items, move the stock counter, run the low-stock check, tell the
 * back-in-stock subscribers, and publish the stock update to the channel.
 */

const db = require('../database/queries');
const items = require('../database/items');
const logger = require('../utils/logger');

/**
 * @param {object} bot       the STORE bot (channel posts and subscriber pings go out from it)
 * @param {number} productId
 * @param {string[]} accounts one string per account, exactly as it should be delivered
 * @param {{supplier?:string, unitCost?:number}} opts
 */
async function applyStockUpload(bot, productId, accounts, opts = {}) {
  const product = db.getProduct(productId);
  if (!product) return { ok: false, error: 'Product not found' };
  const clean = (accounts || []).map((a) => String(a || '').trim()).filter(Boolean);
  if (!clean.length) return { ok: false, error: 'No accounts to add' };

  // The panel's own parser, fed with the AYMEN separator it expects, so an
  // item added here is byte-for-byte what the panel would have stored.
  const { valid } = items.validateLines(clean.join('AYMEN'));
  const prevStock = product.stock_quantity || 0;
  const count = items.insertItems(productId, valid, opts.supplier || null, opts.unitCost ?? null);
  db.adjustStockQuantity(productId, count);

  const after = { ok: true, product: String(product.title || '').replace(/\[emoji:\d+\]/g, '').trim(), added: count, before: prevStock, now: prevStock + count };
  if (!bot) return { ...after, note: 'saved; no bot to publish with' };

  try { await require('./stockAlerts').evaluateStock(bot, productId); } catch (e) { logger.warn(`[stockUpload] evaluate: ${e.message}`); }

  if (prevStock === 0 && count > 0) {
    try {
      after.subscribersNotified = await require('../handlers/buy').notifyBackInStockSubscribers(bot, productId);
    } catch (e) { logger.warn(`[stockUpload] back-in-stock: ${e.message}`); }
  }

  if (db.getSetting('stock_notifications_enabled', '1') === '1' && count > 0) {
    try {
      const notif = require('./notifications');
      const fresh = db.getProduct(productId);
      const me = await bot.getMe().catch(() => ({ username: '' }));
      const kb = { inline_keyboard: [[{ text: '🛒 Buy now', url: `https://t.me/${me.username}?start=p_${fresh.id}` }]] };
      await notif.autoPublishWithPhoto(bot, fresh, notif.buildStockUpdateText(fresh, count), kb);
      after.published = true;
    } catch (e) { logger.warn(`[stockUpload] publish: ${e.message}`); }
  }
  logger.info(`[stockUpload] +${count} → product ${productId} (${product.title})`);
  return after;
}

module.exports = { applyStockUpload };
