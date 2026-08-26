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
// The placeholder is one whole emoji: a pictographic character OR a two-letter
// flag (a regional-indicator pair, which is NOT Extended_Pictographic), plus any
// trailing skin-tone modifier, variation selector, keycap or ZWJ continuation.
//
// The previous pattern was /\[emoji:(\d+)\](\S?)/g. `\S` matches ONE UTF-16 code
// unit, but most emoji (🎨 = U+1F3A8) are surrogate PAIRS of two units. So it
// captured half an emoji as the fallback and left the orphaned half loose in the
// string. Telegram then received a malformed custom-emoji entity, which renders
// as a broken glyph — or attaches the entity to the wrong span, so a different
// emoji from the pack appears. That is the "logo changes to a random one" bug.
const EMOJI_BASE = '(?:\\p{Regional_Indicator}\\p{Regional_Indicator}|\\p{Extended_Pictographic})';
const EMOJI_MOD  = '(?:[\\u{1F3FB}-\\u{1F3FF}]|\\u{FE0F}|\\u{20E3}|\\u{200D}' + EMOJI_BASE + ')';
const EMOJI_MARKER = new RegExp(`\\[emoji:(\\d+)\\](${EMOJI_BASE}${EMOJI_MOD}*)?`, 'gu');

function expandPremiumEmojis(text) {
  if (!text) return text;
  return String(text).replace(EMOJI_MARKER, (match, id, fallback) =>
    `<tg-emoji emoji-id="${id}">${fallback || '🎁'}</tg-emoji>`
  );
}

// ── Automatic premium upgrade ─────────────────────────────────────────────────
// Bot API 9.4 (9 Feb 2026) allows a bot to send custom emoji "in messages
// directly sent by the bot to private, group and supergroup chats if the owner
// of the bot has a Telegram Premium subscription".
//
// The bot cannot invent emoji ids, so the mapping comes from the emoji_library
// table the admin already fills in (/admin → Emoji Library): each row stores a
// premium emoji_id plus the plain `fallback` character it stands for. Anywhere
// that plain character appears in outgoing text, it is upgraded to the premium
// version — so a single library entry restyles every message at once, with no
// hardcoded ids anywhere in the code.
//
// NOTE: channels are deliberately absent from Telegram's list above, so channel
// posts keep the plain emoji no matter what is in the library.

let _emojiMapCache = null;
let _emojiMapAt = 0;
const EMOJI_MAP_TTL_MS = 60000;

/** { plainCharacter -> premiumId }, refreshed at most once a minute. */
function emojiMap() {
  const now = Date.now();
  if (_emojiMapCache && (now - _emojiMapAt) < EMOJI_MAP_TTL_MS) return _emojiMapCache;
  const map = new Map();
  try {
    // Lazy require: database/queries.js loads this module, so a top-level
    // require here would be a cycle.
    const db = require('../database/queries');
    for (const row of db.getAllEmojis()) {
      const plain = String(row.fallback || '').trim();
      if (plain && row.emoji_id) map.set(plain, String(row.emoji_id));
    }
  } catch (_) { /* library unavailable — leave text untouched */ }
  _emojiMapCache = map;
  _emojiMapAt = now;
  return map;
}

/** Called after the library changes so the next message picks it up at once. */
function clearEmojiCache() { _emojiMapCache = null; _emojiMapAt = 0; }

/**
 * Replace plain emoji with their premium equivalents, leaving HTML alone.
 *
 * The text is split on tags, so nothing inside <b>, <code> or an existing
 * <tg-emoji> is touched — double-wrapping an emoji that is already premium
 * would produce a malformed entity.
 */
function premiumizeEmojis(text) {
  if (!text) return text;
  const map = emojiMap();
  if (!map.size) return text;

  const parts = String(text).split(/(<[^>]*>)/);
  let depth = 0;                       // inside a <tg-emoji> element?

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.startsWith('<')) {
      if (/^<tg-emoji\b/i.test(part)) depth++;
      else if (/^<\/tg-emoji>/i.test(part)) depth = Math.max(0, depth - 1);
      continue;                        // never rewrite a tag itself
    }
    if (depth > 0 || !part) continue;  // already premium — leave it

    let out = part;
    for (const [plain, id] of map) {
      if (!out.includes(plain)) continue;
      out = out.split(plain).join(`<tg-emoji emoji-id="${id}">${plain}</tg-emoji>`);
    }
    parts[i] = out;
  }
  return parts.join('');
}

/**
 * The one call every outgoing message should use: expand [emoji:ID] markers
 * first, then upgrade whatever plain emoji remain.
 */
function renderEmojis(text) {
  return premiumizeEmojis(expandPremiumEmojis(text));
}

/**
 * Remove [emoji:ID] markers, keeping the plain fallback character.
 *
 * Used wherever a custom-emoji entity cannot be sent — button labels, plain-text
 * messages, channel posts. Without this the raw marker reaches the customer and
 * they see a long number in the middle of a product name.
 */
function stripEmojiMarkers(text) {
  if (!text) return text;
  return String(text).replace(/\[emoji:\d+\]/g, '');
}

/**
 * The premium emoji id for a product — ONE definition for the whole codebase.
 *
 * Two places store an id and they disagreed. `products.title` can carry an
 * inline `[emoji:ID]` marker, and the legacy `products.premium_emoji_id` column
 * holds one too. utils/keyboard.js let the title win while handlers/products.js
 * and services/notifications.js let the column win, so after changing a
 * product's emoji the buttons showed the new one while the product page and the
 * channel post still showed the old one — the "old emojis come back" report.
 *
 * The title wins, because that is what the admin edits when they change an
 * emoji; the column is a fallback for products created before markers existed.
 */
function productEmojiId(p) {
  if (!p) return null;
  const m = String(p.title || '').match(/\[emoji:(\d+)\]/);
  if (m) return m[1];
  return p.premium_emoji_id ? String(p.premium_emoji_id) : null;
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
  expandPremiumEmojis, premiumizeEmojis, renderEmojis, clearEmojiCache,
  stripEmojiMarkers, productEmojiId,
  formatPrice, formatPriceExact, calcOrderPrice, formatBulkTiersDisplay, formatReward, statusEmoji, escapeHtml, truncate,
  PAYMENT_CONFIRM_VALIDITY_MIN, PAYMENT_CONFIRM_VALIDITY_MS, checkPaymentWindow,
  scaleTiersProportionally,
};
