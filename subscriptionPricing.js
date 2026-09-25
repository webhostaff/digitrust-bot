'use strict';

/**
 * Time-limited products: an account that dies on a fixed date.
 *
 * "Canva account valid until the 19th" is worth less on the 18th than it was on
 * the 12th, and re-pricing it by hand every morning is a job nobody does
 * reliably. The shop states the end date and what the full period is worth; the
 * price and the title follow the calendar by themselves.
 *
 * Everything is derived on READ. Storing "today's price" would be wrong the
 * moment the process sleeps through midnight, and would need a scheduler that
 * can fail silently.
 */

/** Whole days from today until the end date, never negative. */
function daysLeft(endDate, from = new Date()) {
  if (!endDate) return null;
  const end = new Date(`${endDate}T23:59:59`);
  if (isNaN(end.getTime())) return null;
  const today = new Date(from);
  today.setHours(0, 0, 0, 0);
  return Math.max(0, Math.ceil((end - today) / 86400000));
}

/**
 * A product with its price and title brought up to date.
 *
 * Returns the product untouched when it is not time-limited, so every caller
 * can pass everything through this without caring which kind it is.
 */
function applySubscriptionPricing(product, from = new Date()) {
  if (!product) return product;

  // Unlimited stock is applied first and independently of the expiry date: a
  // shop can issue this subscription on demand, so the item count is not what
  // limits it. A large finite number is used rather than Infinity because the
  // value flows into quantity prompts, JSON responses and SQL comparisons,
  // none of which handle Infinity sensibly.
  if (Number(product.unlimited_stock) === 1) {
    product = { ...product, stock_quantity: 999999, is_unlimited: true };
  }

  if (!product.sub_end_date) return product;

  const left = daysLeft(product.sub_end_date, from);
  if (left === null) return product;

  const perDay = Number(product.sub_price_per_day) || 0;
  const floor  = Number(product.sub_min_price) || 0;

  // Below this many days the account is not worth selling: the buyer gets
  // almost nothing and comes back asking why. Withdrawing it early is cheaper
  // than the refund. Default 3; 0 means sell it to the last day.
  const minDays = (product.sub_min_days === null || product.sub_min_days === undefined)
    ? 3 : Number(product.sub_min_days) || 0;

  if (left <= 0 || (minDays > 0 && left < minDays)) {
    return {
      ...product,
      sub_days_left: Math.max(0, left),
      sub_expired: true,
      // Stock is forced to zero rather than the product being hidden, so it
      // keeps its place in the list and the shop can see it lapse.
      stock_quantity: 0,
    };
  }

  const raw = perDay > 0 ? perDay * left : Number(product.price) || 0;
  // Rounded UP to the cent: rounding down would let a long tail of days each
  // shave a fraction, and the shop is the one absorbing it.
  const price = Math.max(floor, Math.ceil(raw * 100) / 100);

  // The suffix is stripped with a pattern that also matches the older
  // "— 8 days left" wording, so titles written before the change are cleaned up
  // instead of ending with two suffixes.
  // Repeated, so a title that already stacked two suffixes is cleaned fully
  // rather than losing only the last one.
  const baseTitle = (product.sub_base_title || String(product.title || ''))
    .replace(/(\s*[—-]\s*\d+\s*days?(\s*left)?)+\s*$/i, '')
    .trim();

  return {
    ...product,
    price,
    title: `${baseTitle} — ${left} day${left === 1 ? '' : 's'}`,
    sub_days_left: left,
    sub_expired: false,
  };
}

module.exports = { daysLeft, applySubscriptionPricing };
