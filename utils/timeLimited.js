'use strict';
/**
 * Time-limited ("until a date", price per day) products in the APIs (V153).
 *
 * The bot shows "— 2 days · $1.20" because it reads products through applySubscriptionPricing. The APIs read
 * some products straight from the table, so they showed the stored base price and no duration. Everything here
 * starts from a product that went through applySubscriptionPricing, so the API says exactly what the bot says.
 */
const { applySubscriptionPricing } = require('./subscriptionPricing');

const live = (p, from = new Date()) => applySubscriptionPricing(p, from);

/** null for an ordinary product; otherwise what an API caller needs to know about the period. */
function info(product, from = new Date()) {
  if (!product || !product.sub_end_date) return null;
  const p = product.sub_days_left === undefined ? live(product, from) : product;
  if (p.sub_days_left === undefined) return null;                   // unreadable end date: treat as ordinary
  const tomorrow = new Date(from.getTime() + 86400000);
  const t = live({ ...p, title: p.sub_base_title || p.title }, tomorrow);
  return {
    ends_on:        String(p.sub_end_date).slice(0, 10),
    days_left:      Number(p.sub_days_left) || 0,
    price_per_day:  Number(p.sub_price_per_day) || 0,
    min_price:      Number(p.sub_min_price) || 0,
    expired:        !!p.sub_expired,
    price_tomorrow: t.sub_expired ? null : Number(Number(t.price).toFixed(6)),
  };
}

/** A reseller's unit price on a time-limited product: the wholesale price, never above today's live price. */
function resellerUnit(product) {
  const wholesale = Number(product.wholesale_price) || 0;
  if (!product.sub_end_date || wholesale <= 0) return wholesale;
  const livePrice = Number(product.price) || 0;
  return livePrice > 0 ? Math.min(wholesale, livePrice) : wholesale;
}

module.exports = { live, info, resellerUnit };
