'use strict';

/**
 * In-bot announcements.
 *
 * A banner shown INSIDE a bot, on the screen a customer already opens — not a
 * broadcast. The two solve different problems: a broadcast interrupts everyone
 * once and is gone, while a notice is read by whoever shows up, for as long as
 * it is relevant. "We are closed until Friday" belongs here; it has to be seen
 * by the person opening the shop at 3am on Thursday, not by whoever happened to
 * be online when the message went out.
 *
 * Each bot keeps its own notice, because the audiences differ: customers of the
 * store, ChatGPT Business subscribers, and staff in the support inbox.
 */

const raw = require('../database/db');

const BOTS = ['store', 'cgb', 'support'];

raw.exec(`
  CREATE TABLE IF NOT EXISTS bot_notices (
    bot        TEXT PRIMARY KEY,
    text       TEXT,
    enabled    INTEGER DEFAULT 0,
    expires_at TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

/**
 * The live notice for a bot, or null.
 *
 * An expired notice returns null rather than being deleted: the text is usually
 * reused ("closed for the weekend" comes round again), and silently destroying
 * something the admin wrote is a worse default than keeping it switched off.
 */
function get(bot) {
  try {
    const row = raw.prepare('SELECT * FROM bot_notices WHERE bot = ?').get(bot);
    if (!row || !row.enabled || !row.text || !String(row.text).trim()) return null;
    if (row.expires_at && new Date(String(row.expires_at).replace(' ', 'T')) <= new Date()) return null;
    return row;
  } catch (e) {
    return null;
  }
}

/** The notice as a block to prepend to a screen, or '' when there is none. */
function banner(bot) {
  const n = get(bot);
  if (!n) return '';
  return `📢 <b>Announcement</b>\n${n.text}\n\n➖➖➖➖➖\n\n`;
}

function set(bot, text, expiresAt = null) {
  raw.prepare(`
    INSERT INTO bot_notices (bot, text, enabled, expires_at, updated_at)
    VALUES (?, ?, 1, ?, datetime('now'))
    ON CONFLICT(bot) DO UPDATE SET
      text = excluded.text, enabled = 1,
      expires_at = excluded.expires_at, updated_at = datetime('now')
  `).run(bot, String(text), expiresAt);
}

function toggle(bot) {
  const row = raw.prepare('SELECT enabled FROM bot_notices WHERE bot = ?').get(bot);
  if (!row) return false;
  const next = row.enabled ? 0 : 1;
  raw.prepare("UPDATE bot_notices SET enabled = ?, updated_at = datetime('now') WHERE bot = ?").run(next, bot);
  return !!next;
}

function clear(bot) {
  return raw.prepare('DELETE FROM bot_notices WHERE bot = ?').run(bot).changes;
}

/** Raw row including disabled/expired ones — for the admin screen. */
function peek(bot) {
  try {
    return raw.prepare('SELECT * FROM bot_notices WHERE bot = ?').get(bot) || null;
  } catch (e) {
    return null;
  }
}

/**
 * Send the notice as a real message to that bot's audience.
 *
 * A banner is read by whoever opens the bot; a message reaches people who are
 * not thinking about the shop right now. Both matter, so the notice text is
 * shared between them — write once, then choose whether to also push it.
 *
 * Audiences differ per bot and are NOT interchangeable: the ChatGPT bot must
 * reach seat holders, not every customer who ever bought a Netflix code, or the
 * message is spam to most of them.
 *
 * @param {object} bot     the Telegram bot instance to send with
 * @param {string} which   'store' | 'cgb' | 'support'
 * @param {function} onProgress optional (sent, total) callback
 */
async function push(bot, which, onProgress = null) {
  const n = peek(which);
  if (!n || !n.text) return { sent: 0, failed: 0, total: 0, error: 'no announcement set' };

  let ids = [];
  try {
    if (which === 'cgb') {
      ids = raw.prepare(`
        SELECT DISTINCT user_id AS id FROM chatgpt_subscriptions
        WHERE COALESCE(status, '') IN ('active', 'pending')
      `).all().map((r) => r.id);
    } else if (which === 'support') {
      // Staff only — the support bot's users are the people who run it.
      ids = raw.prepare('SELECT DISTINCT user_id AS id FROM support_threads').all().map((r) => r.id);
      if (!ids.length) {
        ids = raw.prepare('SELECT DISTINCT user_id AS id FROM support_messages').all().map((r) => r.id);
      }
    } else {
      // Customers who actually bought something. Blasting every /start visitor
      // includes bots and one-off curiosity clicks, which inflates the failure
      // count and teaches nobody to read these.
      ids = raw.prepare(`
        SELECT DISTINCT user_id AS id FROM orders
        WHERE status IN ('delivered', 'paid', 'completed')
      `).all().map((r) => r.id);
    }
  } catch (e) {
    return { sent: 0, failed: 0, total: 0, error: e.message };
  }

  ids = [...new Set(ids.filter(Boolean))];
  const body = `📢 <b>Announcement</b>\n\n${n.text}`;

  let sent = 0, failed = 0;
  for (const id of ids) {
    try {
      await bot.sendMessage(id, body, { parse_mode: 'HTML', disable_web_page_preview: true });
      sent++;
    } catch (e) {
      // Blocked the bot, deleted account, never started it — all normal and
      // none of them should stop the rest of the run.
      failed++;
    }
    if (onProgress && (sent + failed) % 25 === 0) await onProgress(sent + failed, ids.length);
    await new Promise((r) => setTimeout(r, 60)); // stay under Telegram's rate limit
  }

  try {
    raw.prepare("UPDATE bot_notices SET updated_at = datetime('now') WHERE bot = ?").run(which);
  } catch (_) {}

  return { sent, failed, total: ids.length };
}

module.exports = { BOTS, get, banner, set, toggle, clear, peek, push };
