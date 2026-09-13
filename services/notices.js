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

module.exports = { BOTS, get, banner, set, toggle, clear, peek };
