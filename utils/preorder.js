'use strict';

/**
 * Pre-Order mode (same-product model, V167.19).
 *
 * A product can have pre-order ENABLED. That alone changes nothing while the
 * product still has stock — it sells normally. The moment its stock hits 0,
 * the product enters PRE-ORDER MODE automatically:
 *   • the title gains a "🔜 Pre-Order" tag (added here, at render time, so it
 *     disappears by itself the moment stock is available again);
 *   • buying it reserves a pre-order (up to the configured slot count) at the
 *     pre-order price, instead of saying "out of stock".
 *
 * Nothing here mutates the product; the tag is derived from live stock, so the
 * title reverts on its own once stock returns and the pre-orders are filled.
 */

/** Pre-order slots still open (max minus already reserved). */
function slotsRemaining(product) {
  if (!product) return 0;
  return Math.max(0, (Number(product.preorder_max) || 0) - (Number(product.preorder_count) || 0));
}

/**
 * Is this product in pre-order mode right now? Enabled, out of stock, and at
 * least one slot free. Sales being paused does not count as pre-order mode.
 */
function preorderActive(product) {
  if (!product) return false;
  if (Number(product.preorder_enabled) !== 1) return false;
  if ((Number(product.stock_quantity) || 0) > 0) return false;
  return slotsRemaining(product) > 0;
}

/** The price a pre-order is charged at: its own special price, or the normal one. */
function preorderPrice(product) {
  const special = Number(product && product.preorder_price) || 0;
  return special > 0 ? special : (Number(product && product.price) || 0);
}

/** The tag PREPENDED to a title while in pre-order mode (empty otherwise).
 *  Includes a trailing space so it reads "🔜 Pre-Order <title>". */
function titlePrefix(product) {
  return preorderActive(product) ? '🔜 Pre-Order ' : '';
}
/** Deprecated — kept so any old caller still works; no longer used. */
function titleSuffix() { return ''; }

module.exports = { slotsRemaining, preorderActive, preorderPrice, titlePrefix, titleSuffix };
