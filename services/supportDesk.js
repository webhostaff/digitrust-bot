'use strict';

/**
 * services/supportDesk.js — the support bot's conversations, for the
 * "💬 الدعم" section of Yamen's app (owner's request, 30-09): read and answer
 * customers from the app, or hand a case to Yamen.
 *
 * Reads the same support_messages table the support bot writes; replies go
 * out through the support bot's own staff-reply path (support-bot.js →
 * deskReply), so nothing about the customer's experience changes.
 */

const raw = require('../database/db');

function supportBot() {
  try {
    const b = require('../support-bot');
    return b && typeof b.deskReply === 'function' ? b : null;
  } catch (_) { return null; }
}

const RANK = { new: 0, waiting: 1, replied: 2 };

/**
 * Conversations of the last `days`. Order: NEW (unread) first, then read but
 * not answered yet (still a customer waiting — never hidden), then answered;
 * newest first inside each group.
 */
function list({ days = 30, limit = 150 } = {}) {
  const d = Math.max(1, Math.min(90, parseInt(days, 10) || 30));
  const rows = raw.prepare(`
    SELECT m.user_id,
           MAX(m.username) AS username, MAX(m.first_name) AS first_name,
           (SELECT id         FROM support_messages x WHERE x.user_id = m.user_id AND x.deleted_at IS NULL ORDER BY x.id DESC LIMIT 1) AS last_id,
           (SELECT content    FROM support_messages x WHERE x.user_id = m.user_id AND x.deleted_at IS NULL ORDER BY x.id DESC LIMIT 1) AS last_msg,
           (SELECT media_type FROM support_messages x WHERE x.user_id = m.user_id AND x.deleted_at IS NULL ORDER BY x.id DESC LIMIT 1) AS last_media,
           (SELECT direction  FROM support_messages x WHERE x.user_id = m.user_id AND x.deleted_at IS NULL ORDER BY x.id DESC LIMIT 1) AS last_dir,
           (SELECT created_at FROM support_messages x WHERE x.user_id = m.user_id AND x.deleted_at IS NULL ORDER BY x.id DESC LIMIT 1) AS last_at,
           (SELECT MIN(created_at) FROM support_messages x WHERE x.user_id = m.user_id AND x.direction = 'in'
              AND x.id > COALESCE((SELECT MAX(id) FROM support_messages y WHERE y.user_id = m.user_id AND y.direction = 'out' AND y.deleted_at IS NULL), 0)) AS waiting_since,
           COUNT(CASE WHEN m.direction = 'in' AND m.is_read = 0 THEN 1 END) AS unread,
           u.username AS u_username, u.first_name AS u_first_name
    FROM support_messages m
    LEFT JOIN users u ON u.telegram_id = m.user_id
    WHERE m.created_at >= datetime('now', ?)
    GROUP BY m.user_id
    ORDER BY last_id DESC
    LIMIT ?
  `).all(`-${d} days`, Math.max(1, Math.min(400, parseInt(limit, 10) || 150)));

  const mins = (at) => at ? Math.max(0, Math.round((Date.now() - new Date(String(at).replace(' ', 'T') + 'Z').getTime()) / 60000)) : 0;
  const chats = rows.map((r) => {
    const uname = r.username || r.u_username;
    const state = r.unread > 0 ? 'new' : (r.last_dir === 'in' ? 'waiting' : 'replied');
    const media = r.last_media ? `[${r.last_media}]` : '';
    return {
      user_id: r.user_id,
      who: uname ? '@' + uname : (r.first_name || r.u_first_name || String(r.user_id)),
      state,
      unread: r.unread || 0,
      mine_last: r.last_dir === 'out',
      waiting_minutes: state === 'replied' ? 0 : mins(r.waiting_since || r.last_at),
      last_message: String(r.last_msg || media || '').slice(0, 200),
      last_at: r.last_at,
      known_customer: !!r.u_username || !!r.u_first_name,
    };
  }).sort((a, b) => RANK[a.state] - RANK[b.state]);   // stable: newest first inside each group

  return {
    available: !!supportBot(),
    new: chats.filter((c) => c.state === 'new').length,
    waiting: chats.filter((c) => c.state !== 'replied').length,
    chats,
  };
}

function thread(userId, { limit = 120 } = {}) {
  const uid = Number(userId);
  if (!uid) return { error: 'user is required' };
  const msgs = raw.prepare(`
    SELECT id, direction, content, media_type, created_at FROM support_messages
    WHERE user_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT ?
  `).all(uid, Math.max(1, Math.min(300, parseInt(limit, 10) || 120))).reverse();
  if (!msgs.length) return { error: 'no support conversation for this customer' };
  const u = raw.prepare('SELECT username, first_name FROM users WHERE telegram_id = ?').get(uid)
    || raw.prepare('SELECT MAX(username) AS username, MAX(first_name) AS first_name FROM support_messages WHERE user_id = ?').get(uid) || {};
  return {
    user_id: uid,
    who: u.username ? '@' + u.username : (u.first_name || String(uid)),
    messages: msgs.map((m) => ({
      id: m.id,
      from: m.direction === 'out' ? 'support' : 'customer',
      text: m.content || (m.media_type ? `[${m.media_type}]` : ''),
      media: m.media_type || null,
      at: m.created_at,
    })),
  };
}

/** Opening the chat = staff read it (the support bot's normal ✓✓ behaviour). */
async function markRead(userId) {
  const b = supportBot();
  if (!b) return { ok: false, error: 'support bot is not running' };
  try { await b.deskMarkRead(Number(userId)); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
}

async function send(userId, text) {
  const b = supportBot();
  if (!b) return { ok: false, error: 'support bot is not running (SUPPORT_BOT_TOKEN)' };
  return b.deskReply(Number(userId), String(text || '').slice(0, 4000));
}

/** The owner's own recent support replies — a style guide for ✨. */
function styleSample() {
  try {
    return raw.prepare(`SELECT content FROM support_messages
                        WHERE direction = 'out' AND length(content) BETWEEN 8 AND 400 AND deleted_at IS NULL
                        ORDER BY id DESC LIMIT 12`).all().map((r) => r.content);
  } catch (_) { return []; }
}

module.exports = { list, thread, markRead, send, styleSample };
