'use strict';

/**
 * services/businessInbox.js — the owner's PERSONAL Telegram private chats.
 *
 * With Telegram Premium, the owner can connect the store bot to his own
 * account (Telegram → Settings → Telegram Business → Chatbots). Telegram then
 * delivers his 1-to-1 chats to the bot as `business_message` updates, and the
 * bot may answer in them *as him*. This is Telegram's official way; it needs
 * no password and the owner can disconnect it any time from the same screen.
 *
 * Safety, same model as the rest of Yamen:
 *   - Only a connection made by the OWNER's own account is accepted. If
 *     anyone else connects this bot to their account, it is ignored.
 *   - Nothing is ever sent without the owner tapping (propose_business_reply
 *     prepares a card; performAction sends it). No auto-reply here: these
 *     are personal chats.
 *   - Text only is stored, 30 days, so Yamen can show who is waiting and
 *     draft answers. No media is downloaded.
 */

const raw = require('../database/db');
const logger = require('../utils/logger');
const config = require('../config');
const mem = require('./agentMemory');

const KEEP_DAYS = 30;
const bots = {};          // name → bot instance that may hold the connection

function ownerIds() {
  const ids = new Set((config.adminIds || []).map(Number));
  if (process.env.ADMIN_ID) ids.add(Number(process.env.ADMIN_ID));
  return ids;
}

function connection() {
  try { return JSON.parse(mem.getState('business_connection', 'null')); } catch (_) { return null; }
}

function canReply(conn) {
  if (!conn) return false;
  if (conn.rights && typeof conn.rights.can_reply === 'boolean') return conn.rights.can_reply;
  return conn.can_reply !== false;
}

async function onConnection(bot, name, c) {
  const owner = ownerIds();
  if (!c || !c.user || !owner.has(Number(c.user.id))) {
    logger.warn(`[business] ignored a Telegram Business connection from user ${c?.user?.id} (not the owner)`);
    return;
  }
  const record = {
    id: c.id, owner_id: Number(c.user.id), user_chat_id: c.user_chat_id, bot: name,
    enabled: c.is_enabled !== false, can_reply: c.can_reply, rights: c.rights || null, date: c.date,
    connected_at: new Date().toISOString().replace('T', ' ').slice(0, 19),   // UTC, same format as SQLite datetime('now')
  };
  mem.setState('business_connection', JSON.stringify(record));
  logger.info(`[business] connection ${record.enabled ? 'ON' : 'OFF'} (reply ${canReply(record) ? 'allowed' : 'NOT allowed'})`);
  try {
    await bot.sendMessage(c.user_chat_id || c.user.id, record.enabled
      ? `🤝 <b>يمان ولّى يشوف الرسائل الخاصة متاعك.</b>\n` +
        (canReply(record)
          ? `ينجم يحضّرلك ردود، وما يتبعث حتى رد كان كي تضغط انت.`
          : `⚠️ ما عطيتوش صلاحية الرد. كان تحب يحضّرلك ردود يبعثهم باسمك، فعّل <b>Reply to messages</b> في Telegram Business ← Chatbots.`)
      : `🔌 يمان ما عادش يشوف الرسائل الخاصة متاعك (الربط تسكّر).`,
      { parse_mode: 'HTML' });
  } catch (_) {}
}

function onMessage(name, msg) {
  const conn = connection();
  if (!conn || !conn.enabled || msg.business_connection_id !== conn.id) return;   // not our owner's connection
  if (!msg.chat || msg.chat.type !== 'private') return;
  const from = msg.from || {};
  const isOwner = Number(from.id) === Number(conn.owner_id);
  const text = msg.text || msg.caption ||
    (msg.photo ? '[photo]' : msg.voice ? '[voice]' : msg.video ? '[video]' : msg.document ? '[file]' : msg.sticker ? '[sticker]' : '[message]');
  try {
    raw.prepare(`INSERT INTO business_messages (connection_id, chat_id, from_id, from_name, username, is_owner, message_id, text)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      conn.id, Number(msg.chat.id), Number(from.id) || null,
      [from.first_name, from.last_name].filter(Boolean).join(' ') || null,
      from.username || msg.chat.username || null, isOwner ? 1 : 0, msg.message_id || null, String(text).slice(0, 4000));
    if (Math.random() < 0.02) raw.prepare(`DELETE FROM business_messages WHERE created_at < datetime('now', ?)`).run(`-${KEEP_DAYS} days`);
  } catch (e) {
    logger.warn(`[business] could not store a message: ${e.message}`);
  }
}

/** Hook one bot instance. The connection lives on whichever bot the owner picked. */
function attach(bot, name = 'store') {
  bots[name] = bot;
  bot.on('business_connection', (c) => { onConnection(bot, name, c).catch(() => {}); });
  bot.on('business_message', (m) => onMessage(name, m));
}

/** Private chats with activity in the last `hours`, most-waiting first. */
function inbox({ hours = 48 } = {}) {
  const conn = connection();
  const h = Math.max(1, Math.min(24 * 30, parseInt(hours, 10) || 48));
  const rows = raw.prepare(`
    SELECT b.chat_id, b.text, b.is_owner, b.created_at,
           (SELECT username  FROM business_messages x WHERE x.chat_id = b.chat_id AND x.is_owner = 0 AND x.username  IS NOT NULL ORDER BY x.id DESC LIMIT 1) AS username,
           (SELECT from_name FROM business_messages x WHERE x.chat_id = b.chat_id AND x.is_owner = 0 AND x.from_name IS NOT NULL ORDER BY x.id DESC LIMIT 1) AS from_name,
           (SELECT MAX(created_at) FROM business_messages x WHERE x.chat_id = b.chat_id AND x.is_owner = 0) AS last_in_at,
           CAST((julianday('now') - julianday(b.created_at)) * 1440 AS INTEGER) AS mins
    FROM business_messages b
    WHERE b.id IN (SELECT MAX(id) FROM business_messages GROUP BY chat_id)
      AND b.created_at >= datetime('now', ?)
    ORDER BY b.is_owner ASC, b.created_at ASC
  `).all(`-${h} hours`);
  const chats = rows.map((r) => ({
    chat_id: r.chat_id,
    who: r.username ? '@' + r.username : (r.from_name || String(r.chat_id)),
    waiting: !r.is_owner,
    waiting_minutes: !r.is_owner ? r.mins : 0,
    last_message: String(r.text || '').slice(0, 200),
    // Telegram lets a business bot answer only chats active in the last 24h.
    can_reply_now: canReply(conn) && !!r.last_in_at && (Date.now() - new Date(r.last_in_at.replace(' ', 'T') + 'Z').getTime()) < 24 * 3600 * 1000,
  }));
  // Facts for an honest answer when the list is empty: "nothing here" with
  // twelve unread badges on the owner's screen looks like a bug unless we say
  // WHY — Telegram only forwards messages sent AFTER the connection, and only
  // 1-to-1 chats with people (not groups, channels or other bots).
  let received = 0, lastAt = null;
  try {
    const r = raw.prepare(`SELECT COUNT(*) AS n, MAX(created_at) AS last FROM business_messages WHERE is_owner = 0`).get();
    received = Number(r?.n || 0); lastAt = r?.last || null;
  } catch (_) {}
  return {
    connected: !!(conn && conn.enabled),
    reply_allowed: canReply(conn),
    connected_since_utc: conn?.connected_at || null,
    messages_received_total: received,
    last_message_received_utc: lastAt,
    window_hours: h,
    waiting: chats.filter((c) => c.waiting).length,
    chats,
    note: chats.length ? undefined :
      'Telegram only delivers messages that arrive AFTER the connection, and only private chats with people ' +
      '(not groups, channels or other bots). Unread messages from before the connection are not visible to the bot.',
  };
}

/** One private chat, oldest first. `who` = chat id or @username. */
function thread({ chat, limit = 40 } = {}) {
  const id = resolveChat(chat);
  if (!id) return { error: `no private chat found for "${chat}"` };
  const n = Math.max(1, Math.min(200, parseInt(limit, 10) || 40));
  const msgs = raw.prepare(`SELECT is_owner, text, created_at FROM business_messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?`).all(id, n).reverse();
  return { chat_id: id, messages: msgs.map((m) => ({ from: m.is_owner ? 'you' : 'them', text: m.text, at: m.created_at })) };
}

function resolveChat(chat) {
  const key = String(chat || '').trim();
  if (/^-?\d+$/.test(key)) {
    const r = raw.prepare(`SELECT chat_id FROM business_messages WHERE chat_id = ? LIMIT 1`).get(Number(key));
    return r ? r.chat_id : null;
  }
  const u = key.replace(/^@/, '').toLowerCase();
  if (!u) return null;
  const r = raw.prepare(`SELECT chat_id FROM business_messages WHERE lower(username) = ? ORDER BY id DESC LIMIT 1`).get(u);
  return r ? r.chat_id : null;
}

/** Send an owner-approved reply as the owner. Returns { ok, error? }. */
async function sendReply(chatId, text) {
  const conn = connection();
  if (!conn || !conn.enabled) return { ok: false, error: 'Telegram Business is not connected' };
  if (!canReply(conn)) return { ok: false, error: 'the connection has no "reply" permission (Telegram Business → Chatbots)' };
  const bot = bots[conn.bot] || bots.store;
  if (!bot) return { ok: false, error: 'the bot holding the connection is not running' };
  try {
    const sent = await bot.sendMessage(Number(chatId), String(text), { business_connection_id: conn.id });
    try {
      raw.prepare(`INSERT INTO business_messages (connection_id, chat_id, from_id, is_owner, message_id, text) VALUES (?, ?, ?, 1, ?, ?)`)
        .run(conn.id, Number(chatId), conn.owner_id, sent?.message_id || null, String(text).slice(0, 4000));
    } catch (_) {}
    return { ok: true };
  } catch (e) {
    const m = String(e.message || e);
    return { ok: false, error: /24|expired|BUSINESS_PEER_USAGE_MISSING|not.*allowed/i.test(m)
      ? `Telegram refused: they must have written to you in the last 24 hours (${m})` : m };
  }
}

/**
 * A DEDICATED bot for the owner's private chats (BUSINESS_BOT_TOKEN), so the
 * shop's store bot stays for customers only and the two can never mix. It
 * does nothing for anyone but the owner: /start from the owner explains how
 * to connect it; everyone else gets no answer. Returns the bot, or null.
 */
function startDedicated(TelegramBotClass, token) {
  const t = String(token || '').trim();
  if (!t) return null;
  const bot = new TelegramBotClass(t, { polling: true });
  attach(bot, 'business');
  bot.onText(/^\/start\b/, async (msg) => {
    if (!ownerIds().has(Number(msg.from?.id))) return;       // silent for everyone else
    const conn = connection();
    const on = conn && conn.enabled && conn.bot === 'business';
    await bot.sendMessage(msg.chat.id, on
      ? `🤝 <b>مربوط.</b> يمان يشوف الرسائل الخاصة متاعك عبر البوت هذا.${canReply(conn) ? '' : '\n⚠️ فعّل <b>Reply to messages</b> باش ينجم يبعث الردود باسمك.'}`
      : `🤝 <b>هذا البوت متاع الرسائل الخاصة متاعك مع يمان.</b>\n\n` +
        `باش تربطو:\n1. Telegram ← Settings ← <b>Telegram Business</b> ← <b>Chatbots</b>\n` +
        `2. اكتب اسم البوت هذا واختارو\n3. اختار المحادثات، وفعّل <b>Reply to messages</b>\n\n` +
        `<i>ما يجاوب حتى حد وحدو. يمان يحضّر الرد، وانت تضغط باش يتبعث باسمك.</i>`,
      { parse_mode: 'HTML' }).catch(() => {});
  });
  bot.on('polling_error', (e) => logger.warn(`[business] polling: ${e.message}`));
  bot.getMe().then((me) => logger.info(`[business] dedicated private-chats bot @${me.username} started`)).catch(() => {});
  return bot;
}

module.exports = { attach, startDedicated, inbox, thread, sendReply, connection, _resolveChat: resolveChat };
