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
  if (!html || !allowCustom) return stripEmojiMarkers(text);

  const rendered = renderEmojis(text);
  // Unwrap only the ids known to fail. Everything else keeps its icon, which is
  // the whole point of quarantining per id instead of switching the feature off.
  return rendered.replace(/<tg-emoji emoji-id="(\d+)">(.*?)<\/tg-emoji>/gi,
    (whole, id, inner) => (isQuarantined(id) ? inner : whole));
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
      // A quarantined icon already on the button must go, or the message it is
      // attached to keeps failing.
      if (button.icon_custom_emoji_id && isQuarantined(button.icon_custom_emoji_id)) {
        delete button.icon_custom_emoji_id;
      }
      const m = button.text.match(/\[emoji:(\d+)\]/);
      if (!m) continue;
      button.text = stripEmojiMarkers(button.text);
      if (allowIcons && !isQuarantined(m[1]) && !button.icon_custom_emoji_id) {
        button.icon_custom_emoji_id = m[1];
      }
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

/**
 * Did this failure come from a custom emoji rather than our content?
 *
 * DOCUMENT_INVALID is the important one and it is not obvious: a Telegram
 * custom emoji IS a document internally, so an emoji id the bot may not use
 * comes back as "400 Bad Request: DOCUMENT_INVALID" — from sendMessage, with no
 * mention of emoji anywhere. Missing it meant paid orders failed to deliver:
 * the retry never fired and the customer got nothing.
 */
function isCustomEmojiError(err) {
  const msg = String(err && err.message || '').toLowerCase();
  return msg.includes('document_invalid')
      || msg.includes('custom_emoji')
      || msg.includes('custom emoji')
      || msg.includes('emoji_invalid')
      || msg.includes('stickerset_invalid')
      || msg.includes('media_empty')
      || msg.includes("can't parse entities")
      || msg.includes('entity');
}

// ── Bad-emoji quarantine ──────────────────────────────────────────────────────
//
// The first version disabled ALL custom emoji for 15 minutes after any single
// failure. That produced exactly the reported symptom: icons vanish from the
// product list, come back a while later, vanish again — because one unusable
// emoji id, on one product, silently switched off every icon in the bot.
//
// Now only the ids that actually failed are quarantined. A product with a bad
// emoji loses its icon; every other product keeps one. Ids are re-tried after a
// cooling-off period, so a pack that becomes available again heals itself.
const BAD_ID_TTL_MS = 6 * 60 * 60 * 1000;
const badIds = new Map(); // emoji id -> timestamp when it may be retried

// Account-wide failure is a different problem: if Telegram Premium lapses,
// EVERY id fails and quarantining them one at a time would mean one failed
// request per message. Many distinct ids failing in quick succession is the
// signal for that, and only then is everything switched off.
const ACCOUNT_FAIL_WINDOW_MS = 60 * 1000;
const ACCOUNT_FAIL_THRESHOLD = 5;
let recentFailures = [];
let accountBreakerUntil = 0;

function isQuarantined(id) {
  const until = badIds.get(String(id));
  if (!until) return false;
  if (Date.now() >= until) { badIds.delete(String(id)); return false; }
  return true;
}

function customEmojiAllowed() { return Date.now() >= accountBreakerUntil; }

/** Quarantine every custom emoji id that appeared in a message that failed. */
/**
 * Quarantine only the ids that are genuinely unusable.
 *
 * A failed message may carry a dozen emoji ids, and Telegram does not say which
 * one it objected to. Blaming all of them punishes every product that merely
 * shared a message with the broken one — which is exactly how a single bad pack
 * made icons disappear from the whole list.
 *
 * getCustomEmojiStickers checks ids WITHOUT sending anything: valid ids come
 * back, unknown ones do not. So the culprit is identified precisely, for one
 * API call and no message to any customer.
 *
 * If every id checks out, the ids were never the problem — the account was.
 * That is the only case where everything is switched off, because with Premium
 * inactive each message would otherwise pay for a failed request first.
 */
async function quarantineFrom(bot, label, payload, reason) {
  const ids = new Set();
  for (const m of String(payload || '').matchAll(/emoji-id="(\d+)"/g)) ids.add(m[1]);
  for (const m of String(payload || '').matchAll(/\[emoji:(\d+)\]/g)) ids.add(m[1]);
  if (!ids.size) return;

  const now = Date.now();
  let valid = null;

  try {
    const list = [...ids].slice(0, 200);
    const res = typeof bot.getCustomEmojiStickers === 'function'
      ? await bot.getCustomEmojiStickers(list)
      : await bot._request('getCustomEmojiStickers',
          { form: { custom_emoji_ids: JSON.stringify(list) } });
    const rows = Array.isArray(res) ? res : (res && res.result) || [];
    valid = new Set(rows.map((st) => String(st.custom_emoji_id)));
  } catch (e) {
    logger.warn(`[emoji:${label}] could not verify emoji ids: ${e.message}`);
  }

  if (valid) {
    const bad = [...ids].filter((id) => !valid.has(id));
    if (bad.length) {
      for (const id of bad) badIds.set(id, now + BAD_ID_TTL_MS);
      logger.warn(`[emoji:${label}] quarantined invalid id(s) ${bad.join(', ')} for 6h: ${reason}`);
      return; // culprit found — the account is fine, other icons keep working
    }
  }

  recentFailures = recentFailures.filter((t) => now - t < ACCOUNT_FAIL_WINDOW_MS);
  recentFailures.push(now);

  if (valid || recentFailures.length >= ACCOUNT_FAIL_THRESHOLD) {
    accountBreakerUntil = now + 15 * 60 * 1000;
    recentFailures = [];
    logger.error(
      `[emoji:${label}] Telegram refused custom emoji that all exist — disabling ` +
      `them for 15 minutes. This means the bot owner's Telegram Premium is not ` +
      `active. Check /admin → Settings → Emoji Check. Cause: ${reason}`
    );
  }
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

        // `plain_emoji: true` opts a message out of custom emoji entirely.
        // Used by anything the customer PAID for — a delivery message carries
        // their licence key, and decoration must never be able to put it at
        // risk. The retry below would rescue it, but a rescued message is still
        // a failed request first: slower, and one more thing that can go wrong
        // on the one message that must not.
        const forcePlain = !!(opts && opts.plain_emoji);
        if (opts && 'plain_emoji' in opts) delete opts.plain_emoji; // never send it to Telegram

        // Breaker next: while it is open nothing custom goes out at all, so a
        // delivery message is never held up by decoration.
        const allowCustom = !forcePlain && customEmojiAllowed() && !(await isChannel(this, chatId));

        if (opts && opts.reply_markup) {
          prepareMarkup(opts.reply_markup, iconsEnabled() && allowCustom);
        }
        if (!allowCustom && opts && opts.reply_markup && Array.isArray(opts.reply_markup.inline_keyboard)) {
          // Button icons are custom emoji too — the same refusal applies.
          for (const row of opts.reply_markup.inline_keyboard) {
            for (const b of row) { if (b) delete b.icon_custom_emoji_id; }
          }
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

        // Everything in this message that could be the culprit gets quarantined.
        const failedOpts = (args[spec.optsArg] && typeof args[spec.optsArg] === 'object') ? args[spec.optsArg] : null;
        const failedText = spec.textKey
          ? (failedOpts ? failedOpts[spec.textKey] : '')
          : args[spec.textArg];
        const iconIds = failedOpts && failedOpts.reply_markup && Array.isArray(failedOpts.reply_markup.inline_keyboard)
          ? failedOpts.reply_markup.inline_keyboard.flat()
              .map((b) => b && b.icon_custom_emoji_id).filter(Boolean)
              .map((id) => `emoji-id="${id}"`).join(' ')
          : '';
        await quarantineFrom(this, label, `${failedText || ''} ${iconIds}`, err.message);

        // Retry with the newly-identified culprit removed and nothing else.
        // The quarantine now knows which id was bad, so the message can go out
        // with every OTHER product's icon intact — the first failing message no
        // longer costs the whole list its icons.
        const stripQuarantined = (t) => String(t || '')
          .replace(/<tg-emoji emoji-id="(\d+)">(.*?)<\/tg-emoji>/gi,
            (whole, id, inner) => (isQuarantined(id) ? inner : whole));

        if (failedOpts && failedOpts.reply_markup && Array.isArray(failedOpts.reply_markup.inline_keyboard)) {
          for (const row of failedOpts.reply_markup.inline_keyboard) {
            for (const b of row) {
              if (b && b.icon_custom_emoji_id && isQuarantined(b.icon_custom_emoji_id)) {
                delete b.icon_custom_emoji_id;
              }
            }
          }
        }
        if (spec.textKey && failedOpts && typeof failedOpts[spec.textKey] === 'string') {
          failedOpts[spec.textKey] = stripQuarantined(failedOpts[spec.textKey]);
        } else if (!spec.textKey && spec.textArg >= 0 && typeof args[spec.textArg] === 'string') {
          args[spec.textArg] = stripQuarantined(args[spec.textArg]);
        }

        try {
          return await original.apply(this, args);
        } catch (err2) {
          if (!isCustomEmojiError(err2)) throw err2;

          // Still refused, so the culprit was not identifiable. Everything
          // custom comes off — a plain message beats a lost one, and this is
          // the last step before the customer would receive nothing.
          const plain = (t) => stripEmojiMarkers(
            String(t).replace(/<tg-emoji[^>]*>(.*?)<\/tg-emoji>/gi, '$1'));

          if (spec.textKey && failedOpts && typeof failedOpts[spec.textKey] === 'string') {
            failedOpts[spec.textKey] = plain(failedOpts[spec.textKey]);
          } else if (!spec.textKey && spec.textArg >= 0 && typeof args[spec.textArg] === 'string') {
            args[spec.textArg] = plain(args[spec.textArg]);
          }
          if (failedOpts && failedOpts.reply_markup && Array.isArray(failedOpts.reply_markup.inline_keyboard)) {
            for (const row of failedOpts.reply_markup.inline_keyboard) {
              for (const b of row) { if (b) delete b.icon_custom_emoji_id; }
            }
          }
          return await original.apply(this, args);
        }
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
