'use strict';

/**
 * Admin notification centre.
 *
 * Every notable event goes through `notifyAdmin()`, which does two things:
 *   1. Stores the event in the `admin_notifications` table (the persistent
 *      inbox the admin browses from /admin → 🔔 Notifications).
 *   2. Pushes a Telegram message to every configured admin, plus the optional
 *      private admin channel (`admin_notify_chat_id` setting).
 *
 * Duplicate protection lives in the database: `dedupe_key` is UNIQUE and the
 * insert uses INSERT OR IGNORE. If the key already exists we treat the event
 * as "already handled" and skip the push entirely — that is what stops webhook
 * retries or double taps from spamming the admin.
 *
 * Always pass a STABLE dedupe key derived from the event itself, e.g.
 *   `manual_delivery:14`   not   `manual_delivery:${Date.now()}`
 */

const db     = require('../database/queries');
const config = require('../config');
const logger = require('../utils/logger');

/**
 * The Support Bot instance, registered by support-bot.js on startup.
 *
 * Events are raised all over the codebase by whichever bot happens to be
 * running the code path — a purchase raises a stock alert through the MAIN
 * bot, for example. Pushing through that bot scatters notifications across two
 * chats. Registering the support bot here lets every alert land in one place:
 * the support console.
 */
let supportBot = null;
function setSupportBot(instance) { supportBot = instance; }

const escapeHtml = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/** "29/07/2026 14:05" in the server timezone. */
function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(date.getDate())}/${p(date.getMonth() + 1)}/${date.getFullYear()} ` +
         `${p(date.getHours())}:${p(date.getMinutes())}`;
}

const TYPE_ICON = {
  manual_delivery: '📦',
  stock_out:       '🔴',
  stock_low:       '🟠',
  refund_request:  '🔄',
  support_message: '💬',
};

/**
 * Everyone who should receive an admin push:
 * ADMIN_IDS (the panel admins) + ADMIN_ID (support/CGB owner) + optional channel.
 */
function adminTargets() {
  const targets = new Set();
  for (const id of config.adminIds) targets.add(String(id));

  const single = process.env.ADMIN_ID;
  if (single && String(single).trim()) targets.add(String(single).trim());

  const channel = db.getSetting('admin_notify_chat_id', '');
  if (channel && String(channel).trim()) targets.add(String(channel).trim());

  return [...targets];
}

/**
 * Record + push an admin notification.
 *
 * @param {TelegramBot} bot
 * @param {object} opts
 *   type      - one of TYPE_ICON keys
 *   title     - short headline
 *   body      - HTML-safe detail block (already escaped by the caller)
 *   dedupeKey - stable unique string; repeat calls with the same key are no-ops
 *   refType / refId - what the notification points at
 *   buttons   - optional inline_keyboard rows
 * @returns {Promise<boolean>} true when this was a new event, false when duplicate
 */
async function notifyAdmin(bot, opts) {
  const {
    type, title, body = '', dedupeKey,
    refType = null, refId = null, buttons = null,
    // Buttons whose callback_data the SUPPORT bot understands. The `buttons`
    // above carry admin_* callbacks that only the main bot handles, so sending
    // them through the support bot would produce dead buttons.
    supportButtons = null,
  } = opts;

  // ── 1. Persist (this is also the duplicate check) ──────────────────────────
  let isNew = true;
  try {
    isNew = db.addAdminNotification({
      type, title, body,
      refType, refId: refId == null ? null : String(refId),
      dedupeKey,
    });
  } catch (e) {
    logger.error(`notifyAdmin: could not store notification: ${e.message}`);
  }

  if (!isNew) {
    logger.info(`notifyAdmin: duplicate suppressed (${dedupeKey})`);
    return false;
  }

  // ── 2. Push ───────────────────────────────────────────────────────────────
  if (db.getSetting('admin_notify_enabled', '1') !== '1') return true;

  const icon = TYPE_ICON[type] || '🔔';
  const text =
    `${icon} <b>${escapeHtml(title)}</b>\n` +
    `🕒 ${stamp()}\n` +
    (body ? `\n${body}` : '');

  // Prefer the support console: one place to watch instead of two.
  const pushBot = supportBot || bot;
  const useSupport = pushBot === supportBot;
  const chosen = useSupport ? supportButtons : buttons;
  const markup = chosen && chosen.length ? { inline_keyboard: chosen } : undefined;

  for (const target of adminTargets()) {
    try {
      await pushBot.sendMessage(target, text, {
        parse_mode: 'HTML',
        reply_markup: markup,
        disable_web_page_preview: true,
      });
    } catch (e) {
      // A staff member who never opened the support bot cannot receive from it.
      // Fall back to the bot that raised the event so the alert is not lost.
      if (useSupport) {
        try {
          await bot.sendMessage(target, text, {
            parse_mode: 'HTML',
            reply_markup: buttons && buttons.length ? { inline_keyboard: buttons } : undefined,
            disable_web_page_preview: true,
          });
          continue;
        } catch (e2) { /* fall through to the warning */ }
      }
      logger.warn(`notifyAdmin: push to ${target} failed: ${e.message}`);
    }
  }

  return true;
}

module.exports = { notifyAdmin, setSupportBot, stamp, escapeHtml, adminTargets, TYPE_ICON };
