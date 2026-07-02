'use strict';

const db     = require('../database/queries');
const config = require('../config');
const logger = require('../utils/logger');
const { joinGateKb } = require('../utils/keyboard');

const MEMBER_STATUSES = new Set(['member', 'administrator', 'creator']);

async function isMember(bot, userId, chatId) {
  if (!chatId) return true;
  try {
    const m = await bot.getChatMember(chatId, userId);
    return MEMBER_STATUSES.has(m.status);
  } catch {
    return true; // allow if check fails
  }
}

/**
 * Check join gate requirements.
 * If not joined, send the gate message and return false.
 */
async function checkJoinGate(bot, userId, chatId) {
  const enabled = db.getSetting('join_required_enabled', '0');
  if (enabled !== '1') return true;

  const groupId   = db.getSetting('required_group_id',   '');
  const channelId = db.getSetting('required_channel_id', '');

  const [inGroup, inChannel] = await Promise.all([
    isMember(bot, userId, groupId),
    isMember(bot, userId, channelId),
  ]);

  if (inGroup && inChannel) return true;

  const groupLink   = db.getSetting('required_group_link',   '');
  const channelLink = db.getSetting('required_channel_link', '');

  await bot.sendMessage(
    chatId,
    '🔒 <b>Join Required Communities</b>\n\n' +
    'To use this bot, you must join our Telegram group and updates channel first.\n\n' +
    'Please join both, then click <b>Check Again</b>.',
    { parse_mode: 'HTML', reply_markup: joinGateKb(groupLink, channelLink) }
  );
  return false;
}

/**
 * Upsert user and check ban status.
 * Returns false and notifies if banned.
 */
async function ensureUser(bot, msg) {
  const from = msg.from || {};
  const user = db.upsertAndGetUser({
    telegramId: from.id,
    username:   from.username   || null,
    firstName:  from.first_name || null,
    lastName:   from.last_name  || null,
  });

  if (user && user.is_banned) {
    await bot.sendMessage(msg.chat.id, '🚫 You have been banned from this store.');
    return false;
  }
  return true;
}

module.exports = { checkJoinGate, ensureUser, isMember };
