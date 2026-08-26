'use strict';

/**
 * Make premium emoji work on EVERY outgoing message, in every bot.
 *
 * Before this, `renderEmojis` was called by hand in about eight places out of
 * hundreds. Everywhere else a product title went out exactly as stored — so the
 * customer read a raw `[emoji:5391161942546092651]` marker in the middle of the
 * product name. That is the "numbers still show up" report, and it could never
 * be fixed message-by-message: every new message added later would need to
 * remember the call.
 *
 * So it is done once, at the exit door. Every send/edit method is wrapped and
 * the text is prepared according to what the destination can actually accept.
 */

const logger = require('./logger');
const { renderEmojis, stripEmojiMarkers } = require('./format');

/**
 * chat_id -> true when the chat is a channel.
 *
 * Telegram allows bot-sent custom emoji in private, group and supergroup chats
 * ONLY. Sending a <tg-emoji> entity to a channel is rejected, which would mean
 * the message never arrives — strictly worse than a plain emoji. Positive ids
 * are always private chats, so only negative ids are ever looked up, and each
 * result is cached for the process lifetime.
 */
const channelCache = new Map();

async function isChannel(bot, chatId) {
  if (chatId === undefined || chatId === null) return false;
  const key = String(chatId);
  if (key.startsWith('@')) return true;   // public @name is almost always a channel
  if (!key.startsWith('-')) return false; // private chat
  if (channelCache.has(key)) return channelCache.get(key);

  let result = false;
  try {
    const chat = await bot.getChat(chatId);
    result = chat && chat.type === 'channel';
  } catch (e) {
    // Unknown chat: assume channel. A plain emoji renders everywhere, a
    // rejected entity renders nowhere, so the safe guess is the cautious one.
    result = true;
  }
  channelCache.set(key, result);
  return result;
}

/** Custom-emoji entities need HTML; anywhere else the marker is just noise. */
function prepareText(text, parseMode, allowCustom) {
  if (!text) return text;
  const html = String(parseMode || '').toLowerCase() === 'html';
  return (html && allowCustom) ? renderEmojis(text) : stripEmojiMarkers(text);
}

/**
 * Button labels are plain text — a custom emoji there travels in the separate
 * `icon_custom_emoji_id` field, never inside `text`. Any marker left in a label
 * would print as a number, so it is stripped; when the button has no icon yet,
 * the marker's id becomes one so the emoji is not simply lost.
 */
function prepareMarkup(markup, allowIcons) {
  if (!markup || !Array.isArray(markup.inline_keyboard)) return markup;
  for (const row of markup.inline_keyboard) {
    if (!Array.isArray(row)) continue;
    for (const button of row) {
      if (!button || typeof button.text !== 'string') continue;
      const m = button.text.match(/\[emoji:(\d+)\]/);
      if (!m) continue;
      button.text = stripEmojiMarkers(button.text);
      if (allowIcons && !button.icon_custom_emoji_id) button.icon_custom_emoji_id = m[1];
    }
  }
  return markup;
}

function iconsEnabled() {
  try {
    const db = require('../database/queries');
    const v = String(db.getSetting('button_icons_enabled', '1') || '').trim().toLowerCase();
    return !['0', 'no', 'off', 'false', 'disabled', 'non'].includes(v);
  } catch (_) {
    return true;
  }
}

/** Did this failure come from the custom-emoji entity rather than our content? */
function isCustomEmojiError(err) {
  const msg = String(err && err.message || '').toLowerCase();
  return msg.includes('custom_emoji')
      || msg.includes('custom emoji')
      || msg.includes("can't parse entities")
      || msg.includes('entity');
}

/**
 * Wrap a bot instance so every message it sends renders emoji correctly.
 * Safe to call once per bot; a second call is ignored.
 *
 * @param {object} bot   node-telegram-bot-api instance
 * @param {string} label name used in logs
 */
function installEmojiLayer(bot, label = 'bot') {
  if (!bot || bot.__emojiLayer) return bot;
  bot.__emojiLayer = true;

  // Where the text lives differs per method, so each is described rather than
  // guessed at: [argument index of the text, argument index of options].
  // A chatIdArg of -1 means the chat id is inside the options object.
  const methods = [
    { name: 'sendMessage',        textArg: 1, optsArg: 2, textKey: null,      chatIdArg: 0 },
    { name: 'editMessageText',    textArg: 0, optsArg: 1, textKey: null,      chatIdArg: -1 },
    { name: 'sendPhoto',          textArg: -1, optsArg: 2, textKey: 'caption', chatIdArg: 0 },
    { name: 'sendDocument',       textArg: -1, optsArg: 2, textKey: 'caption', chatIdArg: 0 },
    { name: 'sendVideo',          textArg: -1, optsArg: 2, textKey: 'caption', chatIdArg: 0 },
    { name: 'sendAnimation',      textArg: -1, optsArg: 2, textKey: 'caption', chatIdArg: 0 },
    { name: 'editMessageCaption', textArg: 0,  optsArg: 1, textKey: null,      chatIdArg: -1 },
  ];

  for (const spec of methods) {
    const original = bot[spec.name];
    if (typeof original !== 'function') continue;

    bot[spec.name] = async function (...args) {
      try {
        const opts = (args[spec.optsArg] && typeof args[spec.optsArg] === 'object')
          ? args[spec.optsArg] : null;

        const chatId = spec.chatIdArg >= 0 ? args[spec.chatIdArg] : (opts ? opts.chat_id : null);
        const allowCustom = !(await isChannel(this, chatId));

        if (opts && opts.reply_markup) {
          prepareMarkup(opts.reply_markup, iconsEnabled() && allowCustom);
        }

        const parseMode = opts ? opts.parse_mode : null;
        if (spec.textKey && opts && typeof opts[spec.textKey] === 'string') {
          opts[spec.textKey] = prepareText(opts[spec.textKey], parseMode, allowCustom);
        } else if (!spec.textKey && spec.textArg >= 0 && typeof args[spec.textArg] === 'string') {
          args[spec.textArg] = prepareText(args[spec.textArg], parseMode, allowCustom);
        }
      } catch (e) {
        // Never let emoji handling stop a message going out.
        logger.warn(`[emoji:${label}] ${spec.name} prepare failed: ${e.message}`);
      }

      try {
        return await original.apply(this, args);
      } catch (err) {
        // The destination refused the custom-emoji entity after all (an unknown
        // chat type, or the bot owner's Premium lapsed). Resend as plain emoji
        // rather than dropping the message.
        if (!isCustomEmojiError(err)) throw err;
        logger.warn(`[emoji:${label}] ${spec.name} rejected entities, retrying plain: ${err.message}`);

        const opts = (args[spec.optsArg] && typeof args[spec.optsArg] === 'object')
          ? args[spec.optsArg] : null;
        const plain = (t) => stripEmojiMarkers(String(t).replace(/<tg-emoji[^>]*>(.*?)<\/tg-emoji>/gi, '$1'));

        if (spec.textKey && opts && typeof opts[spec.textKey] === 'string') {
          opts[spec.textKey] = plain(opts[spec.textKey]);
        } else if (!spec.textKey && spec.textArg >= 0 && typeof args[spec.textArg] === 'string') {
          args[spec.textArg] = plain(args[spec.textArg]);
        }
        if (opts && opts.reply_markup && Array.isArray(opts.reply_markup.inline_keyboard)) {
          for (const row of opts.reply_markup.inline_keyboard) {
            for (const b of row) { if (b) delete b.icon_custom_emoji_id; }
          }
        }
        return await original.apply(this, args);
      }
    };
  }

  // Callback toasts are plain text — a marker there is always a visible number.
  const originalAnswer = bot.answerCallbackQuery;
  if (typeof originalAnswer === 'function') {
    bot.answerCallbackQuery = function (queryId, opts, ...rest) {
      if (opts && typeof opts.text === 'string') opts.text = stripEmojiMarkers(opts.text);
      return originalAnswer.call(this, queryId, opts, ...rest);
    };
  }

  logger.info(`[emoji:${label}] outgoing emoji layer installed`);
  return bot;
}

module.exports = { installEmojiLayer, isChannel, prepareText, prepareMarkup };
