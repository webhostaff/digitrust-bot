'use strict';

/**
 * Product items service.
 * Items are separated by # in the input. Each item is stored as raw_content
 * and delivered as-is to the buyer.
 */

const db = require('./db');

// ── Prepared statements ───────────────────────────────────────────────────────

const insertItem = db.prepare(`
  INSERT INTO product_items
    (product_id, item_type, raw_content, email, password, recovery, status, supplier)
  VALUES
    (@productId, 'key', @rawContent, NULL, NULL, NULL, 'available', @supplier)
`);

const getAvailableItem = db.prepare(`
  SELECT * FROM product_items
  WHERE product_id = ? AND status = 'available'
  ORDER BY id
  LIMIT 1
`);

const getAvailableItemCount = db.prepare(`
  SELECT COUNT(*) AS cnt FROM product_items
  WHERE product_id = ? AND status = 'available'
`);

const markItemSold = db.prepare(`
  UPDATE product_items
  SET status = 'sold',
      sold_to_user_id = ?,
      sold_at = datetime('now'),
      order_id = ?
  WHERE id = ?
`);

const getProductItemsPage = db.prepare(`
  SELECT * FROM product_items
  WHERE product_id = ? AND status = 'available'
  ORDER BY id
  LIMIT 20
`);

const getAllAvailableItems = db.prepare(`
  SELECT * FROM product_items
  WHERE product_id = ? AND status = 'available'
  ORDER BY id
`);

const getTotalItemCount = db.prepare(`
  SELECT COUNT(*) AS cnt FROM product_items WHERE product_id = ?
`);

const getSoldItemCount = db.prepare(`
  SELECT COUNT(*) AS cnt FROM product_items WHERE product_id = ? AND status = 'sold'
`);

const deleteUnsoldItems = db.prepare(`
  DELETE FROM product_items WHERE product_id = ? AND status = 'available'
`);

const deleteSingleItem = db.prepare(`
  DELETE FROM product_items WHERE id = ? AND status = 'available'
`);

const getSingleItem = db.prepare(`
  SELECT * FROM product_items WHERE id = ?
`);

// ── Parsing ───────────────────────────────────────────────────────────────────

/**
 * Parse stock input using # as the separator between items.
 * Each item can be anything (key, account, code, url, etc.).
 * Accepts either an array of strings or a single string.
 * Returns { valid: [{ raw }], invalid: [] }
 */
function validateLines(input) {
  const valid = [];
  const raw = Array.isArray(input) ? input.join('AYMEN') : String(input || '');
  // Only "AYMEN" as separator (admin-requested)
  const parts = raw.split('AYMEN');
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed) valid.push({ raw: trimmed });
  }
  return { valid, invalid: [] };
}

// ── Insert ────────────────────────────────────────────────────────────────────

/**
 * Insert validated items into product_items.
 * Returns number inserted.
 */
const insertItems = db.transaction((productId, validItems, supplier = null) => {
  let count = 0;
  const who = supplier ? String(supplier).trim().slice(0, 60) : null;
  for (const item of validItems) {
    insertItem.run({ productId, rawContent: item.raw, supplier: who });
    count++;
  }
  return count;
});

// ── Supplier lookup ───────────────────────────────────────────────────────────

/**
 * Who supplied a given account, found by any fragment of its content.
 *
 * Searches sold items as well as available ones — a dead account is by
 * definition one already in a customer's hands, so restricting this to stock
 * would answer only the case nobody asks about.
 */
const findItemsByContent = db.prepare(`
  SELECT pi.*, p.title AS product_title, o.id AS order_ref
  FROM product_items pi
  LEFT JOIN products p ON pi.product_id = p.id
  LEFT JOIN orders   o ON pi.order_id   = o.id
  WHERE pi.raw_content LIKE ? COLLATE NOCASE
  ORDER BY pi.id DESC
  LIMIT 20
`);

const listSuppliers = db.prepare(`
  SELECT supplier,
         COUNT(*)                                          AS total,
         SUM(CASE WHEN status = 'available' THEN 1 ELSE 0 END) AS in_stock,
         SUM(CASE WHEN status = 'sold'      THEN 1 ELSE 0 END) AS sold
  FROM product_items
  WHERE supplier IS NOT NULL AND TRIM(supplier) <> ''
  GROUP BY supplier
  ORDER BY total DESC
`);

const itemsBySupplier = db.prepare(`
  SELECT pi.*, p.title AS product_title
  FROM product_items pi
  LEFT JOIN products p ON pi.product_id = p.id
  WHERE pi.supplier = ? COLLATE NOCASE
  ORDER BY pi.id DESC
  LIMIT 30
`);

/**
 * Every account a customer has reported as broken, with who supplied it.
 *
 * Answers the question the shop owner actually has when buying from several
 * suppliers: which of them keeps sending accounts that die. Matching is done on
 * the email inside the reported credential blob, because customers paste the
 * whole block — labels, password and all — and the email is the only part that
 * reliably identifies the item.
 */
function reportedAccounts(limit = 40) {
  const rows = db.prepare(`
    SELECT rr.id, rr.order_id, rr.user_id, rr.affected_account, rr.status,
           rr.created_at, p.title AS product_title
    FROM refund_requests rr
    LEFT JOIN orders   o ON rr.order_id = o.id
    LEFT JOIN products p ON o.product_id = p.id
    WHERE rr.affected_account IS NOT NULL AND TRIM(rr.affected_account) <> ''
    ORDER BY rr.id DESC
    LIMIT ?
  `).all(limit);

  const findByFragment = db.prepare(`
    SELECT supplier, created_at FROM product_items
    WHERE raw_content LIKE ? COLLATE NOCASE
    ORDER BY id DESC LIMIT 1
  `);

  return rows.map((r) => {
    const blob = String(r.affected_account || '');
    const email = (blob.match(/[\w.+-]+@[\w.-]+\.\w{2,}/) || [])[0];
    // Fall back to the first line that is not just a label like "CORREO:".
    const probe = email
      || blob.split(/[\n\r]/).map((l) => l.trim())
             .find((l) => l && !/^[A-Za-zÀ-ÿ]+\s*:?$/.test(l)) || '';

    let supplier = null, addedAt = null;
    if (probe.length >= 4) {
      try {
        const hit = findByFragment.get(`%${probe}%`);
        if (hit) { supplier = hit.supplier; addedAt = hit.created_at; }
      } catch (e) { /* ignore */ }
    }
    return { ...r, probe, supplier, addedAt };
  });
}

/** Recently used supplier names, so the admin can tap instead of retyping. */
const recentSuppliers = db.prepare(`
  SELECT supplier, MAX(id) AS last_id
  FROM product_items
  WHERE supplier IS NOT NULL AND TRIM(supplier) <> ''
  GROUP BY supplier
  ORDER BY last_id DESC
  LIMIT 8
`);

// ── Delivery ──────────────────────────────────────────────────────────────────

/**
 * Deliver one item from product_items for an order.
 * Marks item as sold atomically.
 * Returns formatted delivery string, or null if no stock.
 */
function deliverItem(productId, userId, orderId) {
  return db.transaction(() => {
    const item = getAvailableItem.get(productId);
    if (!item) return null;

    markItemSold.run(userId, orderId, item.id);
    return formatItemDelivery(item);
  })();
}

/**
 * Format a product_items row into the delivery string shown to the user.
 * Delivers raw_content exactly as entered.
 */
function formatItemDelivery(item) {
  return `<code>${item.raw_content}</code>`;
}

// ── Queries ───────────────────────────────────────────────────────────────────

function getAvailableCount(productId) {
  return getAvailableItemCount.get(productId).cnt;
}

function getItemsPage(productId) {
  return getProductItemsPage.all(productId);
}

function getAllAvailable(productId) {
  return getAllAvailableItems.all(productId);
}

function getItemStats(productId) {
  return {
    total:  getTotalItemCount.get(productId).cnt,
    sold:   getSoldItemCount.get(productId).cnt,
    available: getAvailableItemCount.get(productId).cnt,
  };
}

function clearUnsoldItems(productId) {
  return deleteUnsoldItems.run(productId).changes;
}


// Recover items that were delivered to a specific user for a specific product
// Marks them back as 'available' and returns count
function recoverItemsFromUser(targetUserId, productId) {
  const result = db.transaction(() => {
    const stmt = db.prepare(`
      UPDATE product_items 
      SET status='available', sold_to_user_id=NULL, sold_at=NULL, order_id=NULL
      WHERE product_id=? AND sold_to_user_id=? AND status='sold'
    `);
    const info = stmt.run(productId, targetUserId);
    
    // Also restore stock_quantity
    if (info.changes > 0) {
      db.prepare(`UPDATE products SET stock_quantity = stock_quantity + ? WHERE id=?`)
        .run(info.changes, productId);
    }
    return { count: info.changes };
  })();
  return result;
}

// ── Raw deliver: no nested transaction — use inside outer tx only ─────────────
function deliverItemRaw(productId, userId, orderId) {
  const item = getAvailableItem.get(productId);
  if (!item) return null;
  markItemSold.run(userId, orderId, item.id);
  return formatItemDelivery(item);
}

module.exports = {
  reportedAccounts,
  findItemsByContent: (fragment) => findItemsByContent.all(`%${String(fragment || '').trim()}%`),
  listSuppliers:      () => listSuppliers.all(),
  itemsBySupplier:    (name) => itemsBySupplier.all(name),
  recentSuppliers:    () => recentSuppliers.all().map((r) => r.supplier),
  validateLines,
  recoverItemsFromUser,
  insertItems,
  deliverItem,
  deliverItemRaw,
  formatItemDelivery,
  getAvailableCount,
  getItemsPage,
  getAllAvailable,
  getItemStats,
  clearUnsoldItems,
  deleteItem: (id) => deleteSingleItem.run(id).changes,
  getItem:    (id) => getSingleItem.get(id),
};
