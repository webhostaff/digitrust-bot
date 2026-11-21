'use strict';

/**
 * A safety net for premium product icons.
 *
 * The icons live inside the product title as `[emoji:ID]` markers, which makes
 * them vulnerable: any code that rewrites a title can wipe them, and one did —
 * a startup migration stripped them on every single boot, so the shop owner
 * re-entered every icon after every deploy.
 *
 * That migration is fixed. This is the belt to its braces: the id is copied to
 * a table of its own the moment it is seen, and any product that has lost its
 * marker gets it back automatically at startup. A title can be rewritten by
 * anything; a dedicated table only changes when this file says so.
 */

const raw = require('../database/db');
const logger = require('./logger');

raw.exec(`
  CREATE TABLE IF NOT EXISTS product_emoji_backup (
    product_id INTEGER PRIMARY KEY,
    emoji_id   TEXT NOT NULL,
    fallback   TEXT,
    title_seen TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

const MARKER = /\[emoji:(\d+)\]/;

/** Remember the icon a product currently has. */
function remember(productId, title) {
  try {
    const m = String(title || '').match(MARKER);
    if (!m) return false;

    // The character right after the marker is the plain fallback, kept so a
    // restore can rebuild the title exactly as it was written.
    const after = String(title).slice(String(title).indexOf(m[0]) + m[0].length);
    const fallback = [...after][0] || '';

    raw.prepare(`
      INSERT INTO product_emoji_backup (product_id, emoji_id, fallback, title_seen, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(product_id) DO UPDATE SET
        emoji_id = excluded.emoji_id,
        fallback = excluded.fallback,
        title_seen = excluded.title_seen,
        updated_at = datetime('now')
    `).run(productId, m[1], fallback, String(title));
    return true;
  } catch (e) {
    logger.warn(`[EMOJI BACKUP] remember ${productId}: ${e.message}`);
    return false;
  }
}

/** Snapshot every product that currently carries an icon. */
function backupAll() {
  let n = 0;
  try {
    for (const p of raw.prepare('SELECT id, title FROM products').all()) {
      if (remember(p.id, p.title)) n++;
    }
  } catch (e) {
    logger.error(`[EMOJI BACKUP] backupAll: ${e.message}`);
  }
  return n;
}

/**
 * Put back the marker on any product that has lost it.
 *
 * A product whose title still has a marker is left alone even if the backup
 * disagrees — the live title is the newer truth, since changing an icon is done
 * by editing the title.
 */
function restoreMissing() {
  const restored = [];
  try {
    const rows = raw.prepare(`
      SELECT b.product_id, b.emoji_id, b.fallback, p.title
      FROM product_emoji_backup b
      JOIN products p ON p.id = b.product_id
    `).all();

    const upd = raw.prepare('UPDATE products SET title = ? WHERE id = ?');
    for (const r of rows) {
      const title = String(r.title || '');
      if (MARKER.test(title)) continue;           // still has one — nothing to do

      // Rebuild exactly as it was written: marker, then the plain fallback if
      // the title does not already start with it.
      const startsWithFallback = r.fallback && title.startsWith(r.fallback);
      const rebuilt = `[emoji:${r.emoji_id}]${startsWithFallback ? '' : (r.fallback || '')}${title}`;
      upd.run(rebuilt, r.product_id);
      restored.push(r.product_id);
    }
  } catch (e) {
    logger.error(`[EMOJI BACKUP] restoreMissing: ${e.message}`);
  }
  return restored;
}

/** What the backup holds, for an admin screen. */
function list() {
  try {
    return raw.prepare(`
      SELECT b.*, p.title AS current_title
      FROM product_emoji_backup b
      LEFT JOIN products p ON p.id = b.product_id
      ORDER BY b.updated_at DESC
    `).all();
  } catch (e) {
    return [];
  }
}

/**
 * Run at startup: save what is there, then put back what is missing.
 *
 * Saving first matters. If a deploy has already stripped the markers, there is
 * nothing to save and nothing is overwritten — the restore then puts them back
 * from the previous snapshot.
 */
function syncOnBoot() {
  const saved = backupAll();
  const restored = restoreMissing();
  if (restored.length) {
    logger.warn(
      `[EMOJI BACKUP] restored premium icons on ${restored.length} product(s): ` +
      `${restored.join(', ')} — something had stripped them.`
    );
  } else {
    logger.info(`[EMOJI BACKUP] ${saved} product icon(s) backed up, none missing`);
  }
  return { saved, restored };
}

module.exports = { remember, backupAll, restoreMissing, list, syncOnBoot };
