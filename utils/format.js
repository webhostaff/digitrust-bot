'use strict';

/**
 * Shared validity window for payment confirmations (TxID / Order ID).
 * Applies to: order payments (USDT, Binance Pay) and wallet top-ups
 * (USDT, Binance Pay). After this many minutes from when the bot first
 * asked for the TxID/Order ID, the bot must reject it as expired.
 */
const PAYMENT_CONFIRM_VALIDITY_MIN = 20;
const PAYMENT_CONFIRM_VALIDITY_MS  = PAYMENT_CONFIRM_VALIDITY_MIN * 60 * 1000;

/**
 * Returns { expired, remainingMin } given a startedAt timestamp (ms epoch).
 * remainingMin is 0 when expired, otherwise the whole minutes left (min 1).
 */
function checkPaymentWindow(startedAtMs) {
  const elapsed = Date.now() - Number(startedAtMs || 0);
  if (!startedAtMs || elapsed > PAYMENT_CONFIRM_VALIDITY_MS) {
    return { expired: true, remainingMin: 0 };
  }
  const remainingMs = PAYMENT_CONFIRM_VALIDITY_MS - elapsed;
  return { expired: false, remainingMin: Math.max(1, Math.ceil(remainingMs / 60000)) };
}

/** Format price as $X.XX */
const formatPrice = (amount) => `$${Number(amount).toFixed(2)}`;

/**
 * Price shown to an ADMIN, with the real precision.
 *
 * formatPrice always rounds to cents, so a stored price of 0.385 reads as
 * "$0.39" — the admin then cannot tell what was actually saved, and the figure
 * shown differs from the figure charged. This keeps up to four decimals and
 * drops trailing zeros, so $3.00 stays "$3.00" while 0.385 reads "$0.385".
 */
const formatPriceExact = (amount) => {
  const n = Number(amount) || 0;
  const cents = n.toFixed(2);
  if (Math.abs(n - Number(cents)) < 1e-9) return `$${cents}`;
  return `$${n.toFixed(4).replace(/0+$/, '')}`;
};

/**
 * Given a product's old/new base price, returns the new prices for any
 * bulk tiers that have a price set, scaled by the same percentage change
 * as the base price. Tiers with no price set (0) are left untouched.
 *
 * Example: base price drops 17% ($1.00 → $0.83) → every tier price drops
 * the same 17% (e.g. Tier 1 $0.80 → $0.66).
 *
 * Returns an array of { tier, oldPrice, newPrice } only for tiers that
 * actually had a price set (so callers know exactly what changed).
 * Returns [] if oldPrice is invalid/zero (can't compute a ratio) or if
 * the price didn't actually change.
 */
function scaleTiersProportionally(product, oldPrice, newPrice) {
  const oldP = Number(oldPrice);
  const newP = Number(newPrice);
  if (!Number.isFinite(oldP) || oldP <= 0) return [];
  if (!Number.isFinite(newP) || newP < 0) return [];
  if (oldP === newP) return [];

  const ratio = newP / oldP;
  const changes = [];

  for (const n of [1, 2, 3]) {
    const tierPrice = Number(product[`bulk_tier${n}_price`]) || 0;
    if (tierPrice <= 0) continue; // tier not set — nothing to scale
    const scaled = Number((tierPrice * ratio).toFixed(2));
    changes.push({ tier: n, oldPrice: tierPrice, newPrice: scaled });
  }
  return changes;
}

/**
 * Calculate total order price, applying bulk discount if eligible.
 * Returns { total, unitPrice, discount, discountApplied }
 *
 * @param {object} product - { price, bulk_min_qty, bulk_discount }
 * @param {number} quantity
 */
function calcOrderPrice(product, quantity) {
  const basePrice = Number(product.price) || 0;

  // Build tiers from new schema (tier1/2/3), sorted by qty DESC
  const tiers = [
    { qty: Number(product.bulk_tier3_qty) || 0, price: Number(product.bulk_tier3_price) || 0 },
    { qty: Number(product.bulk_tier2_qty) || 0, price: Number(product.bulk_tier2_price) || 0 },
    { qty: Number(product.bulk_tier1_qty) || 0, price: Number(product.bulk_tier1_price) || 0 },
  ];

  // Find the highest tier where quantity meets qty threshold and price is set
  let unitPrice = basePrice;
  let appliedTier = 0;
  for (const t of tiers) {
    if (t.qty > 0 && t.price > 0 && quantity >= t.qty) {
      unitPrice = t.price;
      appliedTier = t.qty;
      break;
    }
  }

  // Fallback to legacy bulk_discount (% off) if no tier matched
  if (appliedTier === 0) {
    const bulkMin = Number(product.bulk_min_qty) || 0;
    const bulkDiscount = Number(product.bulk_discount) || 0;
    if (bulkMin > 0 && bulkDiscount > 0 && quantity >= bulkMin) {
      unitPrice = basePrice * (1 - bulkDiscount / 100);
      appliedTier = bulkMin;
    }
  }

  const total = Number((unitPrice * quantity).toFixed(2));
  const discount = basePrice > 0 ? Math.round((1 - unitPrice / basePrice) * 100) : 0;

  return {
    total,
    unitPrice: Number(unitPrice.toFixed(4)),
    discount,
    discountApplied: appliedTier > 0,
    appliedTier,
  };
}

/**
 * Format referral reward — comma decimal, no dollar sign.
 * e.g. 1.00 → "1,00"  |  0.50 → "0,50"
 */
const formatReward = (amount) => Number(amount).toFixed(2).replace('.', ',');

/** Status emoji for orders */
const statusEmoji = (status) =>
  ({ pending: '⏳', delivered: '✅', cancelled: '❌' }[status] || '❓');

/** Escape HTML special chars for Telegram HTML parse mode */
const escapeHtml = (str) =>
  String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/** Truncate string to maxLen chars */
const truncate = (str, maxLen = 30) =>
  str && str.length > maxLen ? str.slice(0, maxLen) + '…' : str || '';


// Convert [emoji:ID] markers to Telegram premium emoji tags.
// Usage:  "[emoji:5368324170671202286]🎉 Welcome!" → animated emoji + "🎉 Welcome!"
// Multiple emojis supported. Fallback emoji is the optional emoji right after the closing ].
function expandPremiumEmojis(text) {
  if (!text) return text;
  // Pattern: [emoji:NUMERIC_ID]optional-fallback-emoji
  return String(text).replace(/\[emoji:(\d+)\](\S?)/g, (match, id, fallback) => {
    const fb = fallback || '🎁';
    return `<tg-emoji emoji-id="${id}">${fb}</tg-emoji>`;
  });
}


// Format bulk tiers for display
function formatBulkTiersDisplay(product) {
  const basePrice = Number(product.price) || 0;

  // Collect active tiers sorted by qty ascending
  const rawTiers = [
    { qty: Number(product.bulk_tier1_qty) || 0, price: Number(product.bulk_tier1_price) || 0 },
    { qty: Number(product.bulk_tier2_qty) || 0, price: Number(product.bulk_tier2_price) || 0 },
    { qty: Number(product.bulk_tier3_qty) || 0, price: Number(product.bulk_tier3_price) || 0 },
  ].filter(t => t.qty > 0 && t.price > 0)
   .sort((a, b) => a.qty - b.qty);

  if (rawTiers.length === 0) {
    // Fallback to legacy bulk_discount
    if (product.bulk_min_qty > 0 && product.bulk_discount > 0) {
      return `\n\n🎁 <b>Bulk Discount:</b> Buy <b>${product.bulk_min_qty}+</b> and save <b>${product.bulk_discount}%</b>!`;
    }
    return '';
  }

  // Build from-to ranges:
  //   Base price row:  1 – (tier1.qty - 1)  →  $basePrice
  //   Tier 1 row:      tier1.qty – (tier2.qty - 1)  →  $tier1.price
  //   ...
  //   Last tier row:   lastTier.qty+         →  $lastTier.price
  const rows = [];

  // Base price row (always shown so the customer sees the full picture)
  const baseTo = rawTiers[0].qty - 1;
  const baseLabel = baseTo === 0
    ? `1 unit`
    : `1 – ${baseTo} ${baseTo === 1 ? 'unit' : 'units'}`;
  rows.push({ label: baseLabel, price: basePrice, isBase: true });

  // Tier rows
  for (let i = 0; i < rawTiers.length; i++) {
    const t    = rawTiers[i];
    const next = rawTiers[i + 1];
    const from = t.qty;
    const to   = next ? next.qty - 1 : null;
    const label = to ? `${from} – ${to} units` : `${from}+ units`;
    rows.push({ label, price: t.price, isBase: false });
  }

  // Pad labels to same width for alignment
  const maxLen = Math.max(...rows.map(r => r.label.length));
  const lines  = rows.map(r => {
    const pad     = ' '.repeat(maxLen - r.label.length);
    const priceStr = `$${Number(r.price).toFixed(2)}/unit`;
    if (r.isBase) {
      return `  <code>${r.label}${pad}</code>  ${priceStr}`;
    }
    return `  <code>${r.label}${pad}</code>  <b>${priceStr}</b> 🔥`;
  });

  return `\n\n🎁 <b>Bulk Pricing — more = cheaper:</b>\n${lines.join('\n')}`;
}

module.exports = {
  expandPremiumEmojis, formatPrice, formatPriceExact, calcOrderPrice, formatBulkTiersDisplay, formatReward, statusEmoji, escapeHtml, truncate,
  PAYMENT_CONFIRM_VALIDITY_MIN, PAYMENT_CONFIRM_VALIDITY_MS, checkPaymentWindow,
  scaleTiersProportionally,
};
