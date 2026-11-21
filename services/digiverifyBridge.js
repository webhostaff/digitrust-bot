'use strict';

/**
 * DigiVerify top-up bridge (main-bot side).
 *
 * When a customer buys a product that the admin linked to DigiVerify (the
 * "🌉 Link to New Bot" toggle sets `newbot_linked = 1`) and pays for it HERE,
 * this credits that customer's DigiVerify wallet by the amount paid — so the
 * customer tops up their DigiVerify balance from the official bot, and the
 * amount is recorded in DigiVerify. The money is handled here (the main bot's
 * own verified payment); DigiVerify only records the balance.
 *
 * The customer's Telegram user id is the same in both bots (one Telegram
 * account), so we credit DigiVerify by that uid with nothing to map.
 *
 * Configuration (env on the main bot — set the SAME BRIDGE_SECRET on
 * DigiVerify):
 *   DIGIVERIFY_CREDIT_URL  e.g. https://<digiverify-app>.up.railway.app/bridge/credit
 *   BRIDGE_SECRET          shared secret, identical on both sides.
 *
 * Best-effort and idempotent: DigiVerify dedupes by `ref` (order:<id>), so a
 * retry never double-credits. A failure here never blocks the purchase; it is
 * logged and the order is already paid, so the admin can re-trigger if needed.
 */

const axios  = require('axios');
const db     = require('../database/queries');
const logger = require('../utils/logger');

function creditUrl()  { return String(process.env.DIGIVERIFY_CREDIT_URL || '').trim(); }
function secret()     { return String(process.env.BRIDGE_SECRET || '').trim(); }

/** Is this order for a product linked to DigiVerify? */
function isLinked(order) {
  try {
    const p = db.getProduct(Number(order.product_id));
    return p && Number(p.newbot_linked) === 1;
  } catch (_) { return false; }
}

/**
 * Credit the buyer's DigiVerify wallet for a paid, linked order.
 * Call it right after an order is marked paid/delivered. Non-blocking.
 */
async function creditIfLinked(order, userId) {
  try {
    if (!order || !userId) return;
    if (!isLinked(order)) return;

    const url = creditUrl();
    const sec = secret();
    if (!url || !sec) {
      logger.warn(`[digiverify] order #${order.id} is linked but DIGIVERIFY_CREDIT_URL/BRIDGE_SECRET is not set — skipping`);
      return;
    }
    const cents = Math.round(Number(order.total_price || 0) * 100);
    if (!(cents > 0)) return;

    const res = await axios.post(url,
      { uid: Number(userId), cents, ref: `order:${order.id}` },
      { headers: { 'X-Bridge-Secret': sec, 'Content-Type': 'application/json' }, timeout: 15000 });

    if (res.data && res.data.ok) {
      logger.info(`[digiverify] credited $${(cents / 100).toFixed(2)} to ${userId} for order #${order.id}` +
        (res.data.duplicate ? ' (already credited)' : ''));
    } else {
      logger.warn(`[digiverify] credit for order #${order.id} returned: ${JSON.stringify(res.data)}`);
    }
  } catch (e) {
    const status = e.response ? e.response.status : '';
    logger.warn(`[digiverify] credit failed for order #${order?.id}: ${status} ${e.message}`);
  }
}

module.exports = { creditIfLinked, isLinked };
