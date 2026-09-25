'use strict';

const config = require('../config');
const { backKb } = require('../utils/keyboard');

/**
 * Show the support page with a direct chat link to the admin.
 * Reads SUPPORT_USERNAME from env (defaults to 'Aymenau12').
 */
async function showSupport(bot, chatId, messageId) {
  const supportBotUsername = 'DigHelptbot';
  const url = `https://t.me/${supportBotUsername}`;

  const text =
    `💬 <b>Customer Support</b>\n\n` +
    `Need help? Click the button below to chat with our support team.\n\n` +
    `📞 <b>Support Bot:</b> @${supportBotUsername}\n\n` +
    `✅ Our team will respond as soon as possible.`;

  const keyboard = {
    inline_keyboard: [
      [{ text: `💬 Open Support Chat`, url }],
      [{ text: '🔙 Back', callback_data: 'back_main' }],
    ],
  };

  if (messageId) {
    await bot.editMessageText(text, {
      chat_id: chatId, message_id: messageId,
      parse_mode: 'HTML', reply_markup: keyboard,
    }).catch(async () => {
      // editMessageText fails if the previous message was a photo or similar — fall back to send
      await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: keyboard });
    });
  } else {
    await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

/**
 * Legacy stubs — kept so index.js callback routing doesn't break.
 * They now simply redirect to the main support page.
 */
async function startSupportMessage(bot, chatId, userId, messageId) {
  await showSupport(bot, chatId, messageId);
}

async function handleSupportMessage(bot, msg) {
  // Direct-chat mode: there is no ticket flow anymore.
  // If somehow a user reaches this state, gently redirect.
  await showSupport(bot, msg.chat.id);
}

module.exports = { showSupport, startSupportMessage, handleSupportMessage };
