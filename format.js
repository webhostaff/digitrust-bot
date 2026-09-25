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

  // Two bulk systems exist on the same product: the tier table (tier1/2/3, a
  // price per piece) and the older single rule (bulk_min_qty + a percentage).
  // They were evaluated as "tiers first, legacy only if no tier matched", which
  // could charge MORE for a larger order — a 50%-off legacy rule at 10+ beat a
  // 10%-off tier at 50+, so buying 50 cost more per piece than buying 49.
  //
  // Every rule the quantity qualifies for is now a candidate and the customer
  // gets the best of them. A price ladder that ever goes up as you buy more is
  // read as a mistake by the customer, and it is one.
  const candidates = [];

  for (const [n, q, pr] of [
    [1, product.bulk_tier1_qty, product.bulk_tier1_price],
    [2, product.bulk_tier2_qty, product.bulk_tier2_price],
    [3, product.bulk_tier3_qty, product.bulk_tier3_price],
  ]) {
    const minQty = Number(q) || 0;
    const price  = Number(pr) || 0;
    if (minQty > 0 && price > 0 && quantity >= minQty) {
      candidates.push({ unitPrice: price, tier: minQty, source: `tier${n}` });
    }
  }

  const legacyMin = Number(product.bulk_min_qty) || 0;
  const legacyPct = Number(product.bulk_discount) || 0;
  if (legacyMin > 0 && legacyPct > 0 && quantity >= legacyMin) {
    candidates.push({
      unitPrice: basePrice * (1 - legacyPct / 100),
      tier: legacyMin,
      source: 'legacy',
    });
  }

  let unitPrice = basePrice;
  let appliedTier = 0;
  for (const c of candidates) {
    if (c.unitPrice < unitPrice) { unitPrice = c.unitPrice; appliedTier = c.tier; }
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
  // Kill switch. This upgrade now runs on EVERY outgoing message, so a single
  // wrong emoji_id in the library would make Telegram reject messages
  // bot-wide. Setting emoji_auto_upgrade to 0 leaves explicit [emoji:ID]
  // markers working and only disables the library-driven substitution.
  try {
    const db = require('../database/queries');
    const v = String(db.getSetting('emoji_auto_upgrade', '1') || '').trim().toLowerCase();
    if (['0', 'no', 'off', 'false'].includes(v)) return text;
  } catch (_) { /* settings unavailable — carry on */ }

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
/**
 * The price ladder as the customer will actually be charged it.
 *
 * Derived by asking calcOrderPrice for real quantities instead of listing the
 * tier table. A product can carry BOTH a tier table and the older percentage
 * rule, and this used to show the legacy rule only when there were no tiers.
 * With both set the quote said "1 – 49 units $0.39" while an order of 20 was
 * charged $0.36 — the customer reads one price and pays another, which looks
 * like a trick even though the difference was in their favour.
 *
 * Building the display from the pricing function makes the two impossible to
 * disagree: whatever checkout charges, this is what gets printed.
 */
function formatBulkTiersDisplay(product) {
  const basePrice = Number(product.price) || 0;
  if (!basePrice) return '';

  // Every quantity at which any rule could start applying.
  const breakpoints = [1];
  for (const q of [
    product.bulk_tier1_qty, product.bulk_tier2_qty,
    product.bulk_tier3_qty, product.bulk_min_qty,
  ]) {
    const n = Number(q) || 0;
    if (n > 1) breakpoints.push(n);
  }

  const points = [...new Set(breakpoints)].sort((a, b) => a - b);
  if (points.length <= 1) return '';

  // Drop breakpoints that do not change the price. Two rules can overlap so
  // that one never wins, and printing it would promise a discount that never
  // arrives.
  const steps = [];
  for (const q of points) {
    const unit = Number(calcOrderPrice(product, q).unitPrice.toFixed(4));
    const last = steps[steps.length - 1];
    if (last && Math.abs(last.unit - unit) < 0.00005) continue;
    steps.push({ from: q, unit });
  }
  if (steps.length <= 1) return '';

  const labels = steps.map((st, i) => {
    const next = steps[i + 1];
    if (!next) return `${st.from}+ units`;
    const to = next.from - 1;
    return to === st.from ? `${st.from} unit${st.from === 1 ? '' : 's'}` : `${st.from} – ${to} units`;
  });
  const width = Math.max(...labels.map((l) => l.length));

  const lines = steps.map((st, i) => {
    const pad = ' '.repeat(width - labels[i].length);
    const price = `$${st.unit.toFixed(2)}/unit`;
    const best = i === steps.length - 1 && steps.length > 1;
    return `  <code>${labels[i]}${pad}</code>  ${best ? `<b>${price}</b> 🔥` : price}`;
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
