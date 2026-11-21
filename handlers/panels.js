/**
 * Simple Panels (V167.12 · reworked V167.24)
 * ───────────────────────────────────────────────────────────────────────────
 * Groups the DELIVERED emails of a product under a named "panel" (e.g. a
 * ChatGPT Business workspace / invitation panel), so the owner can see which
 * emails were added to which panel, when they expire, and remove them.
 *
 * V167.24 changes (what the owner asked):
 *   • The panel is set PER PRODUCT, in the product's own Edit screen
 *     (the "🗂 Panel name" field) — no more global "active panel" + id list.
 *   • An email is recorded only AFTER DELIVERY (not at payment), so manual
 *     products are tracked when the owner actually hands them over.
 *   • Each record stores the product's expiry date (sub_end_date) too.
 *
 * The 🗂 Panels dashboard is now VIEW-ONLY: list panels, see emails + expiry,
 * copy, mark removed, purge. Configuration lives on the product.
 *
 * Fully independent: owns its table, does NOT touch the ChatGPT-seat / invite
 * machinery. Wired lightly:
 *   • handlers/buy.js         → recordOnDelivery for auto-delivered orders
 *   • handlers/manualDelivery → recordOnDelivery after a manual hand-over
 *   • handlers/admin.js       → routes admin_pnl_* here (view only)
 *   • utils/keyboard.js       → "🗂 Panels" button + per-product "Panel name"
 */
const rawDb  = require('../database/db');
const db     = require('../database/queries');
const logger = require('../utils/logger');

// ── Table ─────────────────────────────────────────────────────────────────
rawDb.exec(`
  CREATE TABLE IF NOT EXISTS panel_emails (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    panel      TEXT NOT NULL,
    email      TEXT,
    order_id   INTEGER,
    user_id    INTEGER,
    status     TEXT NOT NULL DEFAULT 'active',   -- 'active' | 'removed'
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    removed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_panel_emails_panel ON panel_emails(panel);
`);
// V167.24: expiry date per record (idempotent add for older DBs).
try {
  const cols = rawDb.prepare(`PRAGMA table_info(panel_emails)`).all().map((c) => c.name);
  if (!cols.includes('expires_at')) rawDb.exec(`ALTER TABLE panel_emails ADD COLUMN expires_at TEXT`);
} catch (_) {}

const stmtInsert   = rawDb.prepare(`INSERT INTO panel_emails (panel, email, order_id, user_id, expires_at) VALUES (?, ?, ?, ?, ?)`);
const stmtByPanel  = rawDb.prepare(`SELECT * FROM panel_emails WHERE panel = ? ORDER BY id DESC`);
const stmtPanels   = rawDb.prepare(`
  SELECT panel,
         SUM(CASE WHEN status='active'  THEN 1 ELSE 0 END) AS active,
         SUM(CASE WHEN status='removed' THEN 1 ELSE 0 END) AS removed,
         COUNT(*) AS total
  FROM panel_emails GROUP BY panel ORDER BY panel`);
const stmtSetStatus = rawDb.prepare(`UPDATE panel_emails SET status = ?, removed_at = CASE WHEN ?='removed' THEN datetime('now') ELSE NULL END WHERE id = ?`);
const stmtDelRemoved = rawDb.prepare(`DELETE FROM panel_emails WHERE panel = ? AND status = 'removed'`);
const stmtById      = rawDb.prepare(`SELECT * FROM panel_emails WHERE id = ?`);
const stmtDupe      = rawDb.prepare(`SELECT id FROM panel_emails WHERE panel = ? AND email = ? AND status = 'active' LIMIT 1`);

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ── Delivery hook ─────────────────────────────────────────────────────────────
/** Record a DELIVERED order's email under its product's own panel (panel_name).
 *  Stores the product's expiry date too. Best-effort — never throws into the
 *  delivery flow. Call this ONLY once the order is actually delivered.
 *  (Kept under the old name so existing require() call sites stay valid.) */
function recordIfPanelProduct(order, userId) {
  try {
    if (!order) return;
    const product = db.getProduct(Number(order.product_id));
    const panel = (product && product.panel_name ? String(product.panel_name) : '').trim();
    if (!panel) return;                      // product is not a panel product
    const email = (order.email || '').trim();
    if (!email) return;                      // nothing to record without an email
    if (stmtDupe.get(panel, email)) return;  // already recorded for this panel
    const expiry = (product && product.sub_end_date) ? String(product.sub_end_date) : null;
    stmtInsert.run(panel, email, order.id || null, userId || null, expiry);
    logger.info(`[PANELS] recorded ${email} (order #${order.id || '?'}) → panel "${panel}"${expiry ? ` (expires ${expiry})` : ''}`);
  } catch (e) {
    logger.warn(`[PANELS] record failed: ${e.message}`);
  }
}
/** Clear alias — delivery is the trigger now. */
const recordOnDelivery = recordIfPanelProduct;

// ── Admin UI ──────────────────────────────────────────────────────────────
async function showHome(bot, chatId, messageId) {
  const panels = stmtPanels.all();
  let text =
    '🗂 <b>Panels</b>\n\n' +
    'Delivered emails are grouped by each product’s <b>Panel name</b> ' +
    '(set it in the product’s Edit screen → 🗂 Panel name).\n';

  const rows = [];
  if (panels.length) {
    text += `\n<b>Your panels:</b>\n`;
    for (const p of panels.slice(0, 20)) {
      text += `• <code>${esc(p.panel)}</code> — ${p.active} active${p.removed ? ` · ${p.removed} removed` : ''}\n`;
      rows.push([{ text: `👁 ${p.panel.slice(0, 28)} (${p.active})`, callback_data: `admin_pnl_view_${encodeURIComponent(p.panel)}` }]);
    }
  } else {
    text += `\n<i>No emails recorded yet. They appear here after a panel product is delivered.</i>\n`;
  }
  rows.push([{ text: '🔙 Admin', callback_data: 'admin_panel' }]);

  const kb = { inline_keyboard: rows };
  if (messageId) await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: kb }).catch(() => bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: kb }));
  else await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: kb });
}

async function showPanel(bot, chatId, messageId, panel) {
  const rows_ = stmtByPanel.all(panel);
  const active = rows_.filter((r) => r.status === 'active');
  const removed = rows_.filter((r) => r.status === 'removed');
  let text = `🗂 <b>Panel:</b> <code>${esc(panel)}</code>\n\n` +
    `✅ Active emails: <b>${active.length}</b>${removed.length ? ` · 🗑 removed: <b>${removed.length}</b>` : ''}\n\n`;
  if (!active.length && !removed.length) text += '<i>No emails recorded yet.</i>\n';
  const rows = [];
  for (const r of active.slice(0, 30)) {
    text += `• <code>${esc(r.email)}</code>${r.order_id ? ` · #${r.order_id}` : ''}${r.expires_at ? ` · ⏳ ${esc(r.expires_at)}` : ''}\n`;
    rows.push([{ text: `🗑 Mark removed — ${String(r.email).slice(0, 26)}`, callback_data: `admin_pnl_rm_${r.id}` }]);
  }
  if (active.length) rows.unshift([{ text: '📋 Copy all active emails', callback_data: `admin_pnl_copy_${encodeURIComponent(panel)}` }]);
  if (removed.length) rows.push([{ text: `🧹 Delete ${removed.length} removed record(s)`, callback_data: `admin_pnl_purge_${encodeURIComponent(panel)}` }]);
  rows.push([{ text: '🔙 Panels', callback_data: 'admin_pnl_home' }]);
  const kb = { inline_keyboard: rows };
  if (messageId) await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: kb }).catch(() => bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: kb }));
  else await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: kb });
}

// ── Callback router: handles every admin_pnl_* button ────────────────────────
async function handle(bot, query) {
  const data   = query.data || '';
  if (!/^admin_pnl/.test(data)) return false;
  const chatId = query.message.chat.id;
  const msgId  = query.message.message_id;
  const ack    = (t = '') => bot.answerCallbackQuery(query.id, t ? { text: t } : {}).catch(() => {});

  if (data === 'admin_pnl_home') { await ack(); await showHome(bot, chatId, msgId); return true; }

  const mView = /^admin_pnl_view_(.+)$/.exec(data);
  if (mView) { await ack(); await showPanel(bot, chatId, msgId, decodeURIComponent(mView[1])); return true; }

  const mRm = /^admin_pnl_rm_(\d+)$/.exec(data);
  if (mRm) {
    const row = stmtById.get(parseInt(mRm[1], 10));
    stmtSetStatus.run('removed', 'removed', parseInt(mRm[1], 10));
    await ack('Marked removed');
    if (row) await showPanel(bot, chatId, msgId, row.panel);
    return true;
  }
  const mCopy = /^admin_pnl_copy_(.+)$/.exec(data);
  if (mCopy) {
    await ack();
    const panel = decodeURIComponent(mCopy[1]);
    const emails = stmtByPanel.all(panel).filter((r) => r.status === 'active').map((r) => r.email);
    if (!emails.length) { await bot.sendMessage(chatId, 'No active emails.'); return true; }
    // Plain text, one per line, in a code block for easy copy.
    await bot.sendMessage(chatId, `📋 <b>${esc(panel)}</b> — ${emails.length} email(s):\n<pre>${esc(emails.join('\n'))}</pre>`, { parse_mode: 'HTML' });
    return true;
  }
  const mPurge = /^admin_pnl_purge_(.+)$/.exec(data);
  if (mPurge) {
    const panel = decodeURIComponent(mPurge[1]);
    const n = stmtDelRemoved.run(panel).changes;
    await ack(`Deleted ${n} removed record(s)`);
    await showPanel(bot, chatId, msgId, panel);
    return true;
  }
  await ack();
  await showHome(bot, chatId, msgId);
  return true;
}

// ── Text router: nothing to consume now (config moved to product Edit). ──────
async function handleText() { return false; }

module.exports = { recordIfPanelProduct, recordOnDelivery, handle, handleText };
