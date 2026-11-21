'use strict';

/**
 * Verif-bot top-up bridge (main-bot side, V167.34).
 *
 * When a customer buys a product linked to the Verif (Gemini) bot — the admin
 * toggle "🤖 Link to Verif bot" sets `verif_linked = 1` — and pays for it HERE,
 * this adds that many CREDITS to their Verif-bot wallet (one credit per unit
 * bought). The Verif bot's wallet is counted in credits, not dollars, so this
 * sends `credits = quantity` (unlike the DigiVerify bridge, which sends cents).
 *
 * Config (env on the main bot; set the SAME BRIDGE_SECRET on the Verif bot):
 *   VERIF_CREDIT_URL   e.g. https://<verif-app>.up.railway.app/bridge/credit
 *   BRIDGE_SECRET      shared secret, identical on both sides.
 *
 * Best-effort and idempotent (the Verif bot dedupes by `ref`). A failure never
 * blocks the purchase.
 */

const axios  = require('axios');
const db     = require('../database/queries');
const logger = require('../utils/logger');

function url()    { return String(process.env.VERIF_CREDIT_URL || '').trim(); }
function secret() { return String(process.env.BRIDGE_SECRET || '').trim(); }

function isLinked(order) {
  try {
    const p = db.getProduct(Number(order.product_id));
    return p && Number(p.verif_linked) === 1;
  } catch (_) { return false; }
}

/** Credit the buyer's Verif-bot wallet for a paid, linked order. Non-blocking. */
async function creditIfLinked(order, userId) {
  try {
    if (!order || !userId) return;
    if (!isLinked(order)) return;

    const u = url();
    const sec = secret();
    if (!u || !sec) {
      logger.warn(`[verif] order #${order.id} is linked but VERIF_CREDIT_URL/BRIDGE_SECRET not set — skipping`);
      return;
    }
    const credits = Math.max(1, Math.round(Number(order.quantity) || 1));

    const res = await axios.post(u,
      { uid: Number(userId), credits, ref: `order:${order.id}` },
      { headers: { 'X-Bridge-Secret': sec, 'Content-Type': 'application/json' }, timeout: 15000 });

    if (res.data && res.data.ok) {
      logger.info(`[verif] credited ${credits} credit(s) to ${userId} for order #${order.id}` +
        (res.data.duplicate ? ' (already credited)' : ''));
    } else {
      logger.warn(`[verif] credit for order #${order.id} returned: ${JSON.stringify(res.data)}`);
    }
  } catch (e) {
    const status = e.response ? e.response.status : '';
    logger.warn(`[verif] credit failed for order #${order?.id}: ${status} ${e.message}`);
  }
}

module.exports = { creditIfLinked, isLinked };
