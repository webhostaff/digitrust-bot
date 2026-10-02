'use strict';

/**
 * Bulk-pricing tiers (V141). ONE place decides how many tier slots a product
 * has. Every screen, the checkout price, the customer display and the
 * database columns follow this number — raising it later is a one-line change
 * (the database adds the missing columns by itself on the next start).
 */
const MAX_BULK_TIERS = 8;
const TIER_NUMBERS = Array.from({ length: MAX_BULK_TIERS }, (_, i) => i + 1);
const tierQtyCol   = (n) => `bulk_tier${n}_qty`;
const tierPriceCol = (n) => `bulk_tier${n}_price`;
const TIER_COLUMNS = TIER_NUMBERS.flatMap((n) => [tierQtyCol(n), tierPriceCol(n)]);

/** [{ n, qty, price }] for every slot of `product` (unset slots have qty/price 0). */
function tiersOf(product) {
  return TIER_NUMBERS.map((n) => ({
    n,
    qty: Number(product && product[tierQtyCol(n)]) || 0,
    price: Number(product && product[tierPriceCol(n)]) || 0,
  }));
}
const isSet = (t) => t.qty > 0 && t.price > 0;

module.exports = { MAX_BULK_TIERS, TIER_NUMBERS, TIER_COLUMNS, tierQtyCol, tierPriceCol, tiersOf, isSet };
