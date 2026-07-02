'use strict';

const TelegramBot = require('node-telegram-bot-api');
const Database    = require('better-sqlite3');
const logger      = require('./utils/logger');

const SUPPORT_BOT_TOKEN = process.env.SUPPORT_BOT_TOKEN;
const ADMIN_ID          = parseInt(process.env.ADMIN_ID || '5626665035', 10);

if (!SUPPORT_BOT_TOKEN) {
  logger.warn('Support bot disabled — SUPPORT_BOT_TOKEN missing');
  module.exports = null;
  return;
}

const dbPath = process.env.DB_PATH || '/app/data/store.db';
const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS support_messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL,
    username    TEXT,
    first_name  TEXT,
    direction   TEXT NOT NULL,
    content     TEXT,
    media_type  TEXT,
    file_id     TEXT,
    created_at  TEXT DEFAULT (datetime('now')),
    is_read     INTEGER DEFAULT 0
  );
`);

const insertMsg = db.prepare(`
  INSERT INTO support_messages (user_id, username, first_name, direction, content, media_type, file_id)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const getCustomers = db.prepare(`
  SELECT user_id,
    MAX(username) AS username,
    MAX(first_name) AS first_name,
    (SELECT content FROM support_messages WHERE user_id = m.user_id ORDER BY id DESC LIMIT 1) AS last_msg,
    (SELECT media_type FROM support_messages WHERE user_id = m.user_id ORDER BY id DESC LIMIT 1) AS last_media,
    (SELECT direction FROM support_messages WHERE user_id = m.user_id ORDER BY id DESC LIMIT 1) AS last_direction,
    (SELECT created_at FROM support_messages WHERE user_id = m.user_id ORDER BY id DESC LIMIT 1) AS last_time,
    COUNT(CASE WHEN direction = 'in' AND is_read = 0 THEN 1 END) AS unread
  FROM support_messages m
  GROUP BY user_id
  ORDER BY last_time DESC
`);
const getCustomerMessages = db.prepare(`
  SELECT * FROM support_messages WHERE user_id = ? ORDER BY id ASC
`);
const markAsRead = db.prepare('UPDATE support_messages SET is_read = 1 WHERE user_id = ?');
const getUnreadCount = db.prepare(`
  SELECT COUNT(DISTINCT user_id) AS count FROM support_messages WHERE direction = 'in' AND is_read = 0
`);

const bot = new TelegramBot(SUPPORT_BOT_TOKEN, { polling: true });
logger.info('🎫 Support Bot V3 (Inbox + Media) started');

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatTime(iso) {
  if (!iso) return '';
  const date = new Date(iso.replace(' ', 'T') + 'Z');
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return date.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' });
  return date.toLocaleDateString('en', { day: '2-digit', month: 'short' });
}

function displayName(username, firstName, userId) {
  if (username) return `@${username}`;
  if (firstName) return firstName;
  return `User ${userId}`;
}

const adminCurrentChat = new Map();

// ─── INBOX: shows each customer as a button ──────────────────────────
async function showInbox(chatId, messageId = null, page = 0) {
  const allCustomers = getCustomers.all();
  const unreadStats = getUnreadCount.get();
  const PER_PAGE = 8;
  const totalPages = Math.max(1, Math.ceil(allCustomers.length / PER_PAGE));
  const currentPage = Math.max(0, Math.min(page, totalPages - 1));
  const customers = allCustomers.slice(currentPage * PER_PAGE, (currentPage + 1) * PER_PAGE);

  if (!allCustomers.length) {
    const text = `📭 <b>Inbox</b>\n\nNo customer messages yet.`;
    if (messageId) {
      await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(() => {});
    } else {
      await bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
    }
    return;
  }

  adminCurrentChat.delete(chatId);

  const text =
    `📥 <b>Customer Inbox</b>\n` +
    (unreadStats.count > 0 ? `🔴 <b>${unreadStats.count} unread</b>\n` : '') +
    `<i>${allCustomers.length} total conversations</i>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `Tap a customer to open their chat:`;

  const rows = customers.map((c) => {
    const name = displayName(c.username, c.first_name, c.user_id);
    const time = formatTime(c.last_time);
    const unreadBadge = c.unread > 0 ? `🔴${c.unread} ` : '';
    return [{
      text: `${unreadBadge}${name} · ${time}`,
      callback_data: `chat_${c.user_id}`,
    }];
  });

  // Pagination
  if (totalPages > 1) {
    const pagRow = [];
    if (currentPage > 0) pagRow.push({ text: '◀️ Prev', callback_data: `inbox_p_${currentPage - 1}` });
    pagRow.push({ text: `${currentPage + 1}/${totalPages}`, callback_data: 'noop' });
    if (currentPage < totalPages - 1) pagRow.push({ text: 'Next ▶️', callback_data: `inbox_p_${currentPage + 1}` });
    rows.push(pagRow);
  }
  rows.push([{ text: '🔄 Refresh', callback_data: 'inbox' }]);

  const kb = { inline_keyboard: rows };
  if (messageId) {
    await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: kb })
      .catch(async () => { await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: kb }); });
  } else {
    await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: kb });
  }
}

// ─── CHAT: open conversation with one customer ───────────────────────
async function showChat(chatId, userId, messageId = null) {
  const messages = getCustomerMessages.all(userId);
  markAsRead.run(userId);

  if (!messages.length) {
    await bot.sendMessage(chatId, `❌ No messages from this customer.`);
    return;
  }

  const firstMsg = messages[0];
  const name = displayName(firstMsg.username, firstMsg.first_name, userId);

  // Send header
  await bot.sendMessage(chatId,
    `💬 <b>Chat with ${escapeHtml(name)}</b>\n` +
    `🆔 ID: <code>${userId}</code>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📜 Replaying last ${Math.min(messages.length, 15)} messages...`,
    { parse_mode: 'HTML' }
  );

  // Replay last 15 messages with media
  const recent = messages.slice(-15);
  for (const m of recent) {
    const time = formatTime(m.created_at);
    const who = m.direction === 'in' ? '📩 Customer' : '📤 You';
    const prefix = `${who} · ${time}\n`;

    try {
      if (m.media_type === 'photo' && m.file_id) {
        await bot.sendPhoto(chatId, m.file_id, {
          caption: prefix + (m.content ? escapeHtml(m.content) : ''),
          parse_mode: 'HTML',
        });
      } else if (m.media_type === 'video' && m.file_id) {
        await bot.sendVideo(chatId, m.file_id, {
          caption: prefix + (m.content ? escapeHtml(m.content) : ''),
          parse_mode: 'HTML',
        });
      } else if (m.media_type === 'voice' && m.file_id) {
        await bot.sendVoice(chatId, m.file_id, { caption: prefix.trim() });
      } else if (m.media_type === 'document' && m.file_id) {
        await bot.sendDocument(chatId, m.file_id, {
          caption: prefix + (m.content ? escapeHtml(m.content) : ''),
          parse_mode: 'HTML',
        });
      } else {
        // Plain text
        await bot.sendMessage(chatId,
          prefix + (m.content ? escapeHtml(m.content) : '<i>(empty)</i>'),
          { parse_mode: 'HTML' }
        );
      }
    } catch (e) {
      logger.warn(`Replay msg failed: ${e.message}`);
    }
  }

  adminCurrentChat.set(chatId, userId);

  // Footer with controls
  await bot.sendMessage(chatId,
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `💡 <b>Type your reply below</b> — it will be sent to ${escapeHtml(name)}.`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔄 Refresh', callback_data: `chat_${userId}` }],
          [{ text: '🔙 Back to Inbox', callback_data: 'inbox' }],
        ],
      },
    }
  );
}

// ─── COMMANDS ────────────────────────────────────────────────────────
bot.onText(/^\/start/, async (msg) => {
  if (msg.from.id === ADMIN_ID) {
    await showInbox(msg.chat.id);
    return;
  }
  await bot.sendMessage(msg.chat.id,
    `👋 <b>Welcome to Customer Support!</b>\n\n` +
    `📝 Send your question or issue here, and our team will respond shortly.\n\n` +
    `<i>You can send text, photos, voice messages — anything you need.</i>`,
    { parse_mode: 'HTML' }
  );
});

bot.onText(/^\/inbox/, async (msg) => {
  if (msg.from.id === ADMIN_ID) await showInbox(msg.chat.id);
});

// ─── CALLBACK QUERIES ────────────────────────────────────────────────
bot.on('callback_query', async (q) => {
  if (q.from.id !== ADMIN_ID) {
    await bot.answerCallbackQuery(q.id, { text: 'Not authorized' });
    return;
  }
  await bot.answerCallbackQuery(q.id).catch(() => {});

  const data = q.data;
  const chatId = q.message.chat.id;
  const msgId = q.message.message_id;

  if (data === 'inbox') {
    await showInbox(chatId, msgId);
    return;
  }
  if (data.startsWith('inbox_p_')) {
    const page = parseInt(data.split('_').pop(), 10);
    await showInbox(chatId, msgId, page);
    return;
  }
  if (data === 'noop') return;
  if (/^chat_\d+$/.test(data)) {
    const targetUserId = parseInt(data.split('_')[1], 10);
    await showChat(chatId, targetUserId);
    return;
  }
});

// ─── MESSAGES ────────────────────────────────────────────────────────
bot.on('message', async (msg) => {
  if (msg.text && /^\//.test(msg.text)) return;

  const userId = msg.from.id;
  const chatId = msg.chat.id;

  // ADMIN side
  if (userId === ADMIN_ID) {
    const targetUserId = adminCurrentChat.get(chatId);
    if (!targetUserId) {
      await bot.sendMessage(chatId,
        'ℹ️ Open a customer chat first. Use /inbox.'
      );
      return;
    }

    let mediaType = null, fileId = null;
    const contentText = msg.text || msg.caption || '';

    try {
      if (msg.text) {
        await bot.sendMessage(targetUserId,
          `📩 <b>Support:</b>\n\n${escapeHtml(msg.text)}`,
          { parse_mode: 'HTML' }
        );
      } else if (msg.photo && msg.photo.length) {
        fileId = msg.photo[msg.photo.length - 1].file_id;
        mediaType = 'photo';
        await bot.sendPhoto(targetUserId, fileId, {
          caption: msg.caption ? `📩 ${escapeHtml(msg.caption)}` : '📩 From Support',
          parse_mode: 'HTML',
        });
      } else if (msg.document) {
        fileId = msg.document.file_id;
        mediaType = 'document';
        await bot.sendDocument(targetUserId, fileId, { caption: '📩 From Support' });
      } else if (msg.voice) {
        fileId = msg.voice.file_id;
        mediaType = 'voice';
        await bot.sendVoice(targetUserId, fileId, { caption: '📩 From Support' });
      } else if (msg.video) {
        fileId = msg.video.file_id;
        mediaType = 'video';
        await bot.sendVideo(targetUserId, fileId, {
          caption: msg.caption ? `📩 ${escapeHtml(msg.caption)}` : '📩 From Support',
          parse_mode: 'HTML',
        });
      } else {
        await bot.sendMessage(chatId, '⚠️ Unsupported message type.');
        return;
      }

      insertMsg.run(targetUserId, null, null, 'out', contentText, mediaType, fileId);
      await bot.sendMessage(chatId, `✅ Sent.`);
    } catch (e) {
      logger.error(`Send to ${targetUserId} failed: ${e.message}`);
      await bot.sendMessage(chatId, `❌ Failed: ${e.message}`);
    }
    return;
  }

  // CUSTOMER side
  const username = msg.from.username || null;
  const firstName = msg.from.first_name || null;
  const contentText = msg.text || msg.caption || '';
  let mediaType = null, fileId = null;

  if (msg.photo && msg.photo.length) { fileId = msg.photo[msg.photo.length - 1].file_id; mediaType = 'photo'; }
  else if (msg.document) { fileId = msg.document.file_id; mediaType = 'document'; }
  else if (msg.voice) { fileId = msg.voice.file_id; mediaType = 'voice'; }
  else if (msg.video) { fileId = msg.video.file_id; mediaType = 'video'; }

  insertMsg.run(userId, username, firstName, 'in', contentText, mediaType, fileId);

  const name = displayName(username, firstName, userId);
  const preview = contentText ? contentText.slice(0, 100) : `[${mediaType || 'message'}]`;

  try {
    await bot.sendMessage(ADMIN_ID,
      `🔔 <b>New message from ${escapeHtml(name)}</b>\n\n💬 ${escapeHtml(preview)}`,
      {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [
          [{ text: `💬 Open chat`, callback_data: `chat_${userId}` }],
          [{ text: '📥 Inbox', callback_data: 'inbox' }],
        ] },
      }
    );
  } catch (e) {
    logger.error(`Admin notify failed: ${e.message}`);
  }

  await bot.sendMessage(chatId,
    `✅ Your message has been sent.\n\nOur team will respond as soon as possible.`,
    { parse_mode: 'HTML' }
  ).catch(() => {});
});

bot.on('polling_error', (err) => {
  logger.warn(`Support bot polling error: ${err.message}`);
});

module.exports = bot;
