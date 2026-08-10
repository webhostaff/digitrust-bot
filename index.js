'use strict';

require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const express     = require('express');
const config      = require('./config');
const logger      = require('./utils/logger');

if (!config.botToken) {
  logger.error('BOT_TOKEN is required. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

// ── Init bot ──────────────────────────────────────────────────────────────────
const bot = new TelegramBot(config.botToken, { polling: true });
logger.info('Telegram bot polling started.');

// ── Handlers ──────────────────────────────────────────────────────────────────
const { handleStart, sendMainMenu, handleReferralMenu, showLanguagePicker } = require('./handlers/start');
const { showProducts, showProductDetail, showPreorderProducts, showPreorderProductDetail } = require('./handlers/products');
const buyHandler     = require('./handlers/buy');
const walletHandler  = require('./handlers/wallet');
const { showOrders, showOrderDetail }                   = require('./handlers/orders');
const supportHandler = require('./handlers/support');
const adminHandler   = require('./handlers/admin');
const session        = require('./handlers/session');
const { States }     = require('./handlers/session');
const { ensureUser, checkJoinGate, isMember } = require('./middlewares/auth');
const { mainMenuKb, backKb } = require('./utils/keyboard');
const { escapeHtml, formatPrice } = require('./utils/format');
const { notifyAdmin } = require('./services/adminNotify');
const db = require('./database/queries');

// ── Seed demo products: DISABLED ──────────────────────────────────────────────
// Demo products are no longer auto-seeded on first boot.
// Add your products via the admin panel.

// ── Auth helper ───────────────────────────────────────────────────────────────
async function withAuth(msg, handler) {
  const ok = await ensureUser(bot, msg);
  if (!ok) return;
  const passed = await checkJoinGate(bot, msg.from.id, msg.chat.id);
  if (!passed) return;
  return handler();
}

// ── /start ────────────────────────────────────────────────────────────────────
bot.onText(/\/start(.*)/, async (msg, match) => {
  // Maintenance check
  if (!adminHandler.isAdmin(msg.from.id)) {
    const maintenance = db.getSetting('maintenance_mode', '0') === '1';
    if (maintenance) {
      const maintMsg = db.getSetting('maintenance_message', 'The bot is currently under maintenance. Please try again later.');
      await bot.sendMessage(msg.chat.id, `🚧 <b>Maintenance Mode</b>\n\n${maintMsg}`, { parse_mode: 'HTML' });
      return;
    }
  }
  const ok = await ensureUser(bot, msg);
  if (!ok) return;
  const args = (match[1] || '').trim();

  // Always record referral deep-link first (even before gate)
  if (args && args.startsWith('ref_')) {
    const referrerId = parseInt(args.split('_')[1], 10);
    if (!isNaN(referrerId) && referrerId !== msg.from.id) {
      db.recordReferral(referrerId, msg.from.id);
    }
  }

  // Check Join Required BEFORE showing the main menu
  const passed = await checkJoinGate(bot, msg.from.id, msg.chat.id);
  if (!passed) return;

  await handleStart(bot, msg, args);
});

// ── /admin ────────────────────────────────────────────────────────────────────
bot.onText(/\/emojis/, async (msg) => {
  const ok = await ensureUser(bot, msg);
  if (!ok) return;
  if (!adminHandler.isAdmin(msg.from.id)) {
    await bot.sendMessage(msg.chat.id, '❌ Admin only command.');
    return;
  }
  const emojis = db.getAllEmojis();
  if (!emojis.length) {
    await bot.sendMessage(msg.chat.id,
      '📭 <b>Emoji Library is empty</b>\n\nAdd emojis from <code>/admin → 🎨 Emoji Library</code>',
      { parse_mode: 'HTML' });
    return;
  }
  let txt = '🎨 <b>Your Emoji Library</b>\n\nLong-press to copy, then paste anywhere:\n\n';
  for (const e of emojis) {
    txt += `<code>[emoji:${e.emoji_id}]${e.fallback}</code> — <tg-emoji emoji-id="${e.emoji_id}">${e.fallback}</tg-emoji> <b>${e.name}</b>\n\n`;
  }
  await bot.sendMessage(msg.chat.id, txt, { parse_mode: 'HTML' });
});

// /emoji_id — Premium Emoji ID Extractor
// Debug command to see what's stored in DB
// Full diagnostic: test premium emoji rendering step-by-step
// Test: Use getCustomEmojiStickers to fetch the emoji as a real sticker
// Test ReplyKeyboard vs InlineKeyboard for premium emoji rendering
bot.onText(/\/test_keyboard/, async (msg) => {
  if (!adminHandler.isAdmin(msg.from.id)) return;
  const chatId = msg.chat.id;

  // Test 1: Inline Keyboard (current — no premium emoji support)
  await bot.sendMessage(chatId, 'TEST 1: Inline Keyboard\n(buttons under message)', {
    reply_markup: {
      inline_keyboard: [
        [{ text: '⭐ Premium Test 1', callback_data: 'noop' }],
        [{ text: '🥚 Item with emoji', callback_data: 'noop' }],
      ]
    }
  });

  // Test 2: Reply Keyboard (different type — might support more)
  await bot.sendMessage(chatId, 'TEST 2: Reply Keyboard\n(buttons replace keyboard)', {
    reply_markup: {
      keyboard: [
        ['⭐ Premium Test 2', '🥚 Item'],
        ['🔥 Hot Items', '💎 Diamond'],
        ['🔙 Hide keyboard'],
      ],
      resize_keyboard: true,
      one_time_keyboard: false,
    }
  });

  // Test 3: With entity attempt (some clients render this differently)
  const buttonText = '🥚 Premium';
  await bot.sendMessage(chatId, `TEST 3: Inline with entity attempt`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: buttonText, callback_data: 'noop' }],
      ]
    }
  });

  await bot.sendMessage(chatId,
    `📊 <b>What to look for:</b>\n\n` +
    `Test 1 (Inline): Should show plain emoji\n` +
    `Test 2 (Reply): Might show premium animated\n` +
    `Test 3: Same as Test 1\n\n` +
    `Send /hide to remove the reply keyboard.`,
    { parse_mode: 'HTML' });
});

bot.onText(/\/hide/, async (msg) => {
  await bot.sendMessage(msg.chat.id, 'Keyboard hidden', {
    reply_markup: { remove_keyboard: true }
  });
});

bot.onText(/\/test_sticker\s+(\d+)/, async (msg, match) => {
  if (!adminHandler.isAdmin(msg.from.id)) return;
  const chatId = msg.chat.id;
  const emojiId = match[1];

  try {
    // Call Telegram's getCustomEmojiStickers method
    const stickers = await bot._request('getCustomEmojiStickers', {
      qs: { custom_emoji_ids: JSON.stringify([emojiId]) }
    });
    if (!stickers || !stickers.length) {
      await bot.sendMessage(chatId, `❌ No sticker found for ID ${emojiId}`);
      return;
    }
    const sticker = stickers[0];
    await bot.sendMessage(chatId,
      `🔬 <b>Custom Emoji Info</b>\n\n` +
      `📦 file_id: <code>${sticker.file_id}</code>\n` +
      `🆔 file_unique_id: <code>${sticker.file_unique_id}</code>\n` +
      `📐 width × height: ${sticker.width || '?'}×${sticker.height || '?'}\n` +
      `🎬 is_animated: ${sticker.is_animated}\n` +
      `🎥 is_video: ${sticker.is_video}\n` +
      `📝 type: ${sticker.type}\n` +
      `🎨 emoji: ${sticker.emoji || 'none'}`,
      { parse_mode: 'HTML' });

    // Try sending it as a sticker
    try {
      await bot.sendSticker(chatId, sticker.file_id);
      await bot.sendMessage(chatId, '✅ Above is the sticker rendered. Does it look like the premium emoji?');
    } catch (e) {
      await bot.sendMessage(chatId, `❌ Send sticker failed: ${e.message}`);
    }

    // Also try sendDocument with the thumbnail
    if (sticker.thumbnail && sticker.thumbnail.file_id) {
      try {
        await bot.sendPhoto(chatId, sticker.thumbnail.file_id,
          { caption: '📸 Thumbnail of the emoji (static)' });
      } catch (e) {}
    }
  } catch (e) {
    await bot.sendMessage(chatId, `❌ getCustomEmojiStickers failed: ${e.message}`);
  }
});

bot.onText(/\/diag_emoji/, async (msg) => {
  const ok = await ensureUser(bot, msg);
  if (!ok) return;
  if (!adminHandler.isAdmin(msg.from.id)) return;
  const chatId = msg.chat.id;

  // Use a well-known premium emoji ID for testing (Telegram's default animated emojis)
  // 5368324170671202286 is a Telegram premium animated emoji
  const TEST_IDS = [
    '5368324170671202286',  // Common animated
    '5364105043988309566',  // Another common one
    '5424818078704282406',
  ];

  await bot.sendMessage(chatId, `🔬 <b>Premium Emoji Diagnostic</b>\n\nRunning 5 tests...`, { parse_mode: 'HTML' });

  // ── Test 1: HTML tg-emoji tag ──────────────────────────────
  try {
    await bot.sendMessage(chatId,
      `<b>Test 1:</b> HTML tg-emoji tag\nUsing parse_mode HTML:\n<tg-emoji emoji-id="${TEST_IDS[0]}">🎁</tg-emoji>`,
      { parse_mode: 'HTML' });
  } catch (e) {
    await bot.sendMessage(chatId, `❌ Test 1 failed: ${e.message}`);
  }

  // ── Test 2: entities array (the "correct" way) ─────────────
  try {
    await bot.sendMessage(chatId,
      `Test 2: entities array\n🎁`,
      {
        entities: [
          { type: 'custom_emoji', offset: 23, length: 2, custom_emoji_id: TEST_IDS[0] }
        ]
      });
  } catch (e) {
    await bot.sendMessage(chatId, `❌ Test 2 failed: ${e.message}`);
  }

  // ── Test 3: Show what entities object looks like in next message ──────
  await bot.sendMessage(chatId,
    `<b>Test 3:</b> Type or paste ANY premium emoji in next message.\n` +
    `I'll show the entity Telegram receives.`,
    { parse_mode: 'HTML' });
  session.set(msg.from.id, 'AWAIT_DIAG_EMOJI', {});
});

// Capture for diagnostic
bot.on('message', async (msg) => {
  if (msg.from && session.get(msg.from.id).state === 'AWAIT_DIAG_EMOJI') {
    const text = msg.text || msg.caption || '';
    const entities = msg.entities || msg.caption_entities || [];
    const customEmojis = entities.filter(e => e.type === 'custom_emoji');

    let report = `🔬 <b>Diagnostic Report</b>\n\n`;
    report += `<b>Text received:</b>\n<code>${text.replace(/</g, '&lt;')}</code>\n\n`;
    report += `<b>Text length:</b> ${text.length}\n`;
    report += `<b>Total entities:</b> ${entities.length}\n`;
    report += `<b>Premium emojis:</b> ${customEmojis.length}\n\n`;

    if (customEmojis.length === 0) {
      report += `❌ <b>NO PREMIUM EMOJI DETECTED</b>\n\n`;
      report += `This means Telegram considers your input as regular emoji.\n`;
      report += `Possible causes:\n`;
      report += `• You sent a regular (free) emoji\n`;
      report += `• Your Telegram client doesn't recognize the emoji as premium\n`;
      report += `• You're using Telegram Web (limited support)`;
    } else {
      report += `✅ <b>PREMIUM EMOJI DETECTED!</b>\n\n`;
      for (const e of customEmojis) {
        report += `📦 <b>Entity:</b>\n`;
        report += `   • type: ${e.type}\n`;
        report += `   • offset: ${e.offset}\n`;
        report += `   • length: ${e.length}\n`;
        report += `   • custom_emoji_id: <code>${e.custom_emoji_id}</code>\n\n`;
      }

      // Now send back using entities — should render premium
      report += `\n<b>Echo test (with entities):</b>`;
      session.clear(msg.from.id);
      await bot.sendMessage(msg.chat.id, report, { parse_mode: 'HTML' });

      // Send echo with rebuilt entities
      try {
        await bot.sendMessage(msg.chat.id, `Echo → ${text}`, {
          entities: customEmojis.map(e => ({
            type: 'custom_emoji',
            offset: e.offset + 7, // "Echo → " is 7 chars
            length: e.length,
            custom_emoji_id: e.custom_emoji_id,
          })),
        });
        await bot.sendMessage(msg.chat.id,
          `\n✅ If the echo above shows the emoji ANIMATED, entities work!\n` +
          `❌ If it shows plain emoji, your account/client doesn't render this pack.`,
          { parse_mode: 'HTML' });
      } catch (e) {
        await bot.sendMessage(msg.chat.id, `❌ Echo failed: ${e.message}`);
      }
      return;
    }
    await bot.sendMessage(msg.chat.id, report, { parse_mode: 'HTML' });
    session.clear(msg.from.id);
    return;
  }
});

bot.onText(/\/debug_title\s+(\d+)/, async (msg, match) => {
  const ok = await ensureUser(bot, msg);
  if (!ok) return;
  if (!adminHandler.isAdmin(msg.from.id)) return;
  const productId = parseInt(match[1], 10);
  const p = db.getProduct(productId);
  if (!p) { await bot.sendMessage(msg.chat.id, '❌ Product not found'); return; }

  // Show raw bytes
  const title = p.title || '';
  const hex = Array.from(title).slice(0, 50).map(c => {
    const code = c.codePointAt(0);
    return `${c} = U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
  }).join('\n');

  await bot.sendMessage(msg.chat.id,
    `🔍 <b>Product #${productId} Title Debug</b>\n\n` +
    `<b>Raw stored:</b>\n<code>${title.replace(/</g, '&lt;')}</code>\n\n` +
    `<b>Length:</b> ${title.length} chars\n\n` +
    `<b>Premium emoji ID field:</b> <code>${p.premium_emoji_id || 'NULL'}</code>\n\n` +
    `<b>Each character (first 50):</b>\n<code>${hex}</code>`,
    { parse_mode: 'HTML' });
});

bot.onText(/\/emoji_id/, async (msg) => {
  const ok = await ensureUser(bot, msg);
  if (!ok) return;
  if (!adminHandler.isAdmin(msg.from.id)) {
    await bot.sendMessage(msg.chat.id, '❌ Admin only command.');
    return;
  }
  // Set state to await emoji message
  session.set(msg.from.id, 'AWAIT_PREMIUM_EMOJI', {});
  await bot.sendMessage(msg.chat.id,
    `🎨 <b>Custom Emoji ID Extractor</b>\n\n` +
    `Send me a <b>Telegram Premium custom emoji</b> in your next message and I'll reply with its ID.\n\n` +
    `<i>Tip: type the emoji from any premium pack (ChatGPT, Gemini, Netflix logos, etc.) and send it here.</i>\n\n` +
    `Send /cancel to exit.`,
    { parse_mode: 'HTML' });
});

bot.onText(/\/cancel/, async (msg) => {
  if (session.get(msg.from.id).state === 'AWAIT_PREMIUM_EMOJI') {
    session.clear(msg.from.id);
    await bot.sendMessage(msg.chat.id, '✅ Cancelled.');
  }
});

bot.onText(/\/admin/, async (msg) => {
  const ok = await ensureUser(bot, msg);
  if (!ok) return;
  // Server-side admin check — ONLY admin IDs get the panel
  if (!adminHandler.isAdmin(msg.from.id)) {
    await bot.sendMessage(msg.chat.id, '❌ You are not authorized to use this section.');
    return;
  }
  await adminHandler.showAdminPanel(bot, msg.chat.id);
});

// ── Text messages ─────────────────────────────────────────────────────────────
bot.on('message', async (msg) => {
  // ── /emoji_id capture handler ──────────────────────────────────────
  try {
    const fromId = msg.from && msg.from.id;
    if (fromId && session.get(fromId).state === 'AWAIT_PREMIUM_EMOJI') {
      // Look for custom_emoji entities
      const entities = msg.entities || msg.caption_entities || [];
      const customEmojis = entities.filter(e => e.type === 'custom_emoji' && e.custom_emoji_id);
      if (!customEmojis.length) {
        await bot.sendMessage(msg.chat.id,
          `⚠️ No premium emoji found in your message.\n\n` +
          `Make sure to use a real Telegram <b>premium</b> emoji (not a regular one).\n\n` +
          `Try again or /cancel to exit.`,
          { parse_mode: 'HTML' });
        return;
      }
      session.clear(fromId);
      const text = msg.text || msg.caption || '';
      let reply = `✅ <b>Custom emoji captured</b>\nTap an ID below to copy it.\n\n`;
      for (const e of customEmojis) {
        const offset = e.offset || 0;
        const length = e.length || 2;
        const fallback = text.substring(offset, offset + length) || '🎁';
        reply += `<tg-emoji emoji-id="${e.custom_emoji_id}">${fallback}</tg-emoji>\n`;
        reply += `<b>ID:</b> <code>${e.custom_emoji_id}</code>\n\n`;
      }
      reply += `<i>Paste this ID into the product's "Premium Emoji ID" field in /admin.</i>`;
      // Send as TWO messages: first the IDs, then a live preview to confirm it renders
      await bot.sendMessage(msg.chat.id, reply, { parse_mode: 'HTML' });

      // Test preview — confirms the emoji ACTUALLY works on this bot's premium account
      try {
        for (const e of customEmojis) {
          const text = msg.text || msg.caption || '';
          const offset = e.offset || 0;
          const length = e.length || 2;
          const fallback = text.substring(offset, offset + length) || '🎁';
          await bot.sendMessage(msg.chat.id,
            `🧪 <b>Live test:</b> <tg-emoji emoji-id="${e.custom_emoji_id}">${fallback}</tg-emoji>\n\n` +
            `If you see the emoji above, the ID works perfectly!\n` +
            `If you see only ${fallback}, the bot's account doesn't have access to this emoji pack.`,
            { parse_mode: 'HTML' });
        }
      } catch (e) {
        await bot.sendMessage(msg.chat.id,
          `⚠️ Preview test failed: ${e.message}\n\nThe ID was captured but cannot be rendered.`,
          { parse_mode: 'HTML' });
      }
      return;
    }
  } catch (e) {
    // Continue with normal flow
  }

  // ── Maintenance check ─────────────────────────────────────────
  if (msg.from && !adminHandler.isAdmin(msg.from.id)) {
    const maintenance = db.getSetting('maintenance_mode', '0') === '1';
    if (maintenance) {
      const maintMsg = db.getSetting('maintenance_message', 'The bot is currently under maintenance. Please try again later.');
      // Only reply if it's a text message (not commands like /start which were already handled)
      if (msg.text && !msg.text.startsWith('/')) {
        await bot.sendMessage(msg.chat.id,
          `🚧 <b>Maintenance Mode</b>\n\n${escapeHtml(maintMsg)}`,
          { parse_mode: 'HTML' }
        ).catch(() => {});
      }
      return;
    }
  }

  // ── Quick command: /emojis works even inside any session ───
  if (msg.text && /^\/emojis(\s|$)/.test(msg.text.trim())) {
    if (!adminHandler.isAdmin(msg.from.id)) {
      // silent ignore for non-admin
      return;
    }
    const emojis = db.getAllEmojis();
    if (!emojis.length) {
      await bot.sendMessage(msg.chat.id,
        '📭 <b>Emoji Library is empty</b>\n\nAdd emojis from <code>/admin → 🎨 Emoji Library</code>',
        { parse_mode: 'HTML' });
      return;
    }
    let txt = '🎨 <b>Your Emoji Library</b>\n\nLong-press a line to copy & paste:\n\n';
    for (const e of emojis) {
      txt += `<tg-emoji emoji-id="${e.emoji_id}">${e.fallback}</tg-emoji> <b>${e.name}</b>\n` +
             `<code>[emoji:${e.emoji_id}]${e.fallback}</code>\n\n`;
    }
    await bot.sendMessage(msg.chat.id, txt, { parse_mode: 'HTML' });
    return;
  }

  if (!msg.text || msg.text.startsWith('/')) return;

  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const ok     = await ensureUser(bot, msg);
  if (!ok) return;

  const sess  = session.get(userId);
  const state = sess.state;

  // Admin states — all guarded inside handleAdminText
  if (adminHandler.isAdmin(userId)) {
    const adminStates = [
      States.ADMIN_ADD_TITLE, States.ADMIN_ADD_DESCRIPTION, States.ADMIN_ADD_PRICE,
      States.ADMIN_ADD_WARRANTY, States.ADMIN_ADD_INSTRUCTION, States.ADMIN_ADD_IMAGE, States.ADMIN_ADD_STOCK,
      States.ADMIN_EDIT_VALUE, States.ADMIN_STOCK_DATA,
      States.ADMIN_STOCK_ADD_QTY, States.ADMIN_STOCK_REMOVE_QTY, States.ADMIN_STOCK_SET_QTY,
      States.ADMIN_SALES_COUNT_SET,
      States.ADMIN_BROADCAST_MSG, States.ADMIN_BROADCAST_CONFIRM,
      States.ADMIN_REPLY_TICKET, States.ADMIN_SETTING_VALUE, States.ADMIN_ANN_MSG,
      States.ADMIN_BALANCE_USER_ID, States.ADMIN_BALANCE_AMOUNT_ADD, States.ADMIN_BALANCE_AMOUNT_REMOVE,
      States.ADMIN_REFUND_ORDER_ID, States.ADMIN_REFUND_END_DATE, States.ADMIN_REFUND_WARRANTY,
      States.ADMIN_DELETE_STOCK_ITEM, States.ADMIN_SET_ORDER, States.ADMIN_PRE_SET_MAX, States.ADMIN_PRE_SEND_CONTENT, States.ADMIN_USER_SEARCH, States.ADMIN_STOCK_CONFIRM, States.ADMIN_MAINTENANCE_MSG, States.ADMIN_EMOJI_ADD, States.ADMIN_VIP_IMAGE, States.ADMIN_VIP_LIMIT, States.ADMIN_VIP_INTERVAL, States.ADMIN_ANN_BUTTON_ASK, States.ADMIN_ANN_BUTTON_TEXT, States.ADMIN_BULK_TIER_VALUE, States.ADMIN_STOCK_BATCH,
      'ADMIN_CAT_NEW_NAME', 'ADMIN_CAT_RENAME',
      'ADMIN_CGB_PRICE', 'ADMIN_CGB_ADDCYCLE',
      'ADMIN_RESELLER_NEW_NAME', 'ADMIN_RESELLER_BALANCE',
      States.ADMIN_LOW_STOCK, States.ADMIN_MD_CONTENT,
      States.ADMIN_DEP_REVERSE, States.ADMIN_CUST_PRICE,
      // Pre-existing bug: this state was handled in admin.js but never listed
      // here, so the admin's typed refund amount never reached the handler.
      States.ADMIN_REFUND_AMOUNT,
      'ADMIN_SEARCH_ORDER',
    ];
    if (adminStates.includes(state)) {
      await adminHandler.handleAdminText(bot, msg);
      return;
    }
  }

  // User states
  if      (state === States.BUY_QUANTITY)          await buyHandler.handleQuantity(bot, msg);
  else if (state === States.BUY_EMAIL)             await buyHandler.handleEmail(bot, msg);
  else if (state === States.BUY_PREORDER_QTY)      await buyHandler.handlePreorderQty(bot, msg);
  else if (state === States.BUY_PREORDER_EMAIL)    await buyHandler.handlePreorderEmail(bot, msg);
  else if (state === States.BUY_BINANCE_ORDER_ID)  await buyHandler.handleBinanceOrderId(bot, msg);
  else if (state === States.BUY_USDT_TXID)         await buyHandler.handleUsdtTxIdForOrder(bot, msg);
  else if (state === States.WALLET_TOPUP_USDT_AMOUNT)      await walletHandler.handleUsdtAmount(bot, msg);
  else if (state === States.WALLET_TOPUP_USDT_TX)          await walletHandler.handleUsdtTxId(bot, msg);
  else if (state === States.WALLET_TOPUP_BINANCE_ID)        await walletHandler.handleBinancePayOrderId(bot, msg);
  else if (state === States.WALLET_TOPUP_CRYPTOBOT_AMOUNT)  await walletHandler.handleCryptobotAmount(bot, msg);
  else if (state === States.SUPPORT_MESSAGE)       await supportHandler.handleSupportMessage(bot, msg);
  else if (state === States.REFUND_REASON) {
    const reason = (msg.text || '').trim().slice(0, 500);
    if (reason.length < 5) {
      await bot.sendMessage(chatId, '❌ Please provide a clear reason (at least 5 characters).');
      return;
    }
    session.update(userId, { refundReason: reason });
    session.set(userId, States.REFUND_ACCOUNT, sess.data);
    await bot.sendMessage(chatId,
      `📝 <b>Step 2/4 — Affected Account</b>\n\n` +
      `Please send the <b>email/login or account details</b> of the affected account.\n\n` +
      `<i>This helps us identify the problem.</i>`,
      { parse_mode: 'HTML' }
    );
    return;
  }
  else if (state === States.REFUND_ACCOUNT) {
    const account = (msg.text || '').trim().slice(0, 300);
    if (account.length < 3) {
      await bot.sendMessage(chatId, '❌ Please send the affected account details.');
      return;
    }
    session.update(userId, { refundAccount: account });
    session.set(userId, States.REFUND_PHOTO, sess.data);
    await bot.sendMessage(chatId,
      `📸 <b>Step 3/4 — Screenshot</b>\n\n` +
      `Please send a <b>screenshot</b> showing the problem.\n\n` +
      `<i>Send a photo, or type <code>skip</code> to skip.</i>`,
      { parse_mode: 'HTML' }
    );
    return;
  }
  else if (state === States.REFUND_PHOTO) {
    let photoFileId = null;
    if (msg.photo && msg.photo.length) {
      photoFileId = msg.photo[msg.photo.length - 1].file_id;
    } else if (msg.text && msg.text.toLowerCase().trim() === 'skip') {
      photoFileId = null;
    } else {
      await bot.sendMessage(chatId, '❌ Please send a photo or type "skip".');
      return;
    }
    session.update(userId, { refundPhoto: photoFileId });
    session.set(userId, States.REFUND_METHOD, sess.data);
    await bot.sendMessage(chatId,
      `💳 <b>Step 4/4 — Refund Method</b>\n\n` +
      `How would you like to receive the refund?`,
      { parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [
          [{ text: '💰 Wallet (instant)', callback_data: 'refund_method_wallet' }],
          [{ text: '🟡 Binance Pay', callback_data: 'refund_method_binance' }],
          [{ text: '💎 Crypto (USDT)', callback_data: 'refund_method_crypto' }],
        ] } }
    );
    return;
  }
  else if (state === States.REFUND_ADDRESS) {
    const address = (msg.text || '').trim();
    if (address.length < 10) {
      await bot.sendMessage(chatId, '❌ Please send a valid wallet address.');
      return;
    }
    session.update(userId, { refundAddress: address });
    // Now submit
    const d = session.get(userId).data;
    const order = db.getOrder(d.refundOrderId);
    if (!order || order.user_id !== userId) {
      await bot.sendMessage(chatId, '❌ Order not found.');
      session.clear(userId);
      return;
    }
    // Final eligibility re-check: the admin may have disabled refunds for this
    // product while the customer was filling in the form.
    const finalCheck = db.isOrderRefundable(d.refundOrderId);
    if (!finalCheck.ok) {
      session.clear(userId);
      await bot.sendMessage(chatId,
        '🚫 <b>Not Eligible for Refund</b>\n\n' +
        'This product does not support refund requests. Please contact support if you need help.',
        { parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: '🔙 My Orders', callback_data: 'menu_orders' }]] } });
      return;
    }
    db.addRefundRequest({
      userId,
      orderId: d.refundOrderId,
      reason: d.refundReason,
      amount: 0,
      affectedAccount: d.refundAccount,
      photoFileId: d.refundPhoto,
      refundMethod: d.refundMethod,
      cryptoNetwork: d.refundNetwork || null,
      walletAddress: address,
    });
    session.clear(userId);
    await bot.sendMessage(chatId,
      `✅ <b>Refund Request Submitted!</b>\n\n` +
      `🆔 Order #${d.refundOrderId}\n` +
      `💵 Amount: ${order.total_price}$\n` +
      `💳 Method: ${d.refundMethod}${d.refundNetwork ? ' (' + d.refundNetwork + ')' : ''}\n` +
      `📍 Address: <code>${address.slice(0, 50)}...</code>\n\n` +
      `⏳ Our team will review your request.`,
      { parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🔙 Back to Orders', callback_data: 'menu_orders' }]] } }
    );
    // Notify admin through the notification centre (stored + pushed, deduped)
    try {
      const pending = db.getPendingRefundForOrder(d.refundOrderId);
      await notifyAdmin(bot, {
        type:  'refund_request',
        title: 'New refund request',
        body:
          `🆔 <b>Order:</b> #${d.refundOrderId}\n` +
          `👤 <b>User:</b> <code>${userId}</code>\n` +
          `💵 <b>Order total:</b> ${order.total_price}$\n` +
          `💳 <b>Method:</b> ${escapeHtml(d.refundMethod || 'n/a')}` +
          (d.refundNetwork ? ` (${escapeHtml(d.refundNetwork)})` : ''),
        dedupeKey: `refund_request:${pending ? pending.id : d.refundOrderId}`,
        refType: 'refund_request',
        refId:   pending ? pending.id : d.refundOrderId,
        buttons: pending ? [[{ text: '🔄 Review request', callback_data: `admin_refund_view_${pending.id}` }]] : null,
        supportButtons: [[{ text: '🔄 Refund list', callback_data: 'ref_list_0' }]],
      });
    } catch (e) { logger.warn(`refund notify failed: ${e.message}`); }
  }
});

// ── Photos ────────────────────────────────────────────────────────────────────
bot.on('photo', async (msg) => {
  if (!adminHandler.isAdmin(msg.from.id)) return;
  await adminHandler.handleAdminPhoto(bot, msg);
});

// ── Callback queries ──────────────────────────────────────────────────────────
bot.on('callback_query', async (query) => {
  const data   = query.data || '';
  const userId = query.from.id;
  const chatId = query.message.chat.id;
  const msgId  = query.message.message_id;
  const answer = (text = '') => bot.answerCallbackQuery(query.id, { text }).catch(() => {});

  // Always register/update user
  const fakeMsg = { from: query.from, chat: query.message.chat };
  const ok = await ensureUser(bot, fakeMsg);
  if (!ok) return answer();

  // ── Join gate ────────────────────────────────────────────────────
  if (data === 'check_membership') {
    const groupId   = db.getSetting('required_group_id',   '');
    const channelId = db.getSetting('required_channel_id', '');
    const [inG, inC] = await Promise.all([
      isMember(bot, userId, groupId),
      isMember(bot, userId, channelId),
    ]);
    if (inG && inC) {
      await answer('✅ Access granted!');
      await sendMainMenu(bot, chatId, query.from.first_name || '');
    } else {
      await answer('❌ Not joined yet. Please join both communities.', true);
    }
    return;
  }

  // ── noop ─────────────────────────────────────────────────────────
  if (data === 'noop') { await bot.answerCallbackQuery(query.id).catch(() => {}); return; }

  // ── MAINTENANCE MODE CHECK ─────────────────────────────────────
  // If maintenance is ON, block all customer actions (admin still works)
  const maintenance = db.getSetting('maintenance_mode', '0') === '1';
  if (maintenance && !adminHandler.isAdmin(userId)) {
    const maintMsg = db.getSetting('maintenance_message', 'The bot is currently under maintenance. Please try again later.');
    await answer('🚧 Maintenance mode', true);
    // Replace the message with maintenance notice
    try {
      await bot.editMessageText(
        `🚧 <b>Bot Under Maintenance</b>\n\n${maintMsg}\n\n⏰ Please try again later.`,
        { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' }
      );
    } catch (e) {
      await bot.sendMessage(chatId,
        `🚧 <b>Bot Under Maintenance</b>\n\n${maintMsg}`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
    }
    return;
  }

  // ── Clear any in-progress FSM state when user navigates ──────────
  // Any top-level navigation callback resets the user's session so
  // stale states (e.g. WALLET_BEP20_TX waiting for input) don't
  // intercept the next message.
  const navCallbacks = new Set([
    'back_main', 'menu_refresh', 'refresh_products', 'menu_products', 'menu_preorders', 'menu_wallet', 'menu_orders', 'menu_language', 'set_lang_en', 'set_lang_ar', 'set_lang_vi', 'set_lang_es',
    'menu_support', 'menu_referral', 'wallet_transactions', 'menu_notifications', 'menu_api',
    'admin_panel',
  ]);
  if (navCallbacks.has(data)) {
    session.clear(userId);
  }

  // ── Navigation ───────────────────────────────────────────────────
  if (data === 'refresh_products') {
    await bot.answerCallbackQuery(query.id, { text: '🔄 Refreshed!' }).catch(() => {});
    try { await bot.deleteMessage(chatId, msgId).catch(() => {}); } catch (e) {}
    await showProducts(bot, chatId);
    return;
  }

  if (data === 'menu_refresh') {
    await bot.answerCallbackQuery(query.id, { text: '🔄 Refreshed!' }).catch(() => {});
    const userLang = db.getUserLanguage(userId);
    try {
      await bot.deleteMessage(chatId, msgId).catch(() => {});
    } catch (e) {}
    await sendMainMenu(bot, chatId, query.from.first_name || '', userId);
    return;
  }

  if (data === 'back_main') {
    const passed = await checkJoinGate(bot, userId, chatId);
    if (!passed) return;
    await answer();
    const userLang = db.getUserLanguage(userId);
    try {
      await bot.editMessageText('🛍 <b>Main Menu</b>', {
        chat_id: chatId, message_id: msgId,
        parse_mode: 'HTML', reply_markup: mainMenuKb(userLang),
      });
    } catch (e) {
      // Was a photo message — delete and resend
      try { await bot.deleteMessage(chatId, msgId); } catch (e2) {}
      await sendMainMenu(bot, chatId, query.from.first_name || '', userId);
    }
    return;
  }
  // Category list — show products of category
  if (/^cat_\d+$/.test(data)) {
    const categoryId = parseInt(data.split('_').pop(), 10);
    const productsHandler = require('./handlers/products');
    await productsHandler.showProductsByCategory(bot, chatId, msgId, categoryId, 0);
    await bot.answerCallbackQuery(query.id).catch(() => {});
    return;
  }
  // Category pagination
  if (/^cat_page_\d+_\d+$/.test(data)) {
    const parts = data.split('_');
    const categoryId = parseInt(parts[2], 10);
    const page = parseInt(parts[3], 10);
    const productsHandler = require('./handlers/products');
    await productsHandler.showProductsByCategory(bot, chatId, msgId, categoryId, page);
    await bot.answerCallbackQuery(query.id).catch(() => {});
    return;
  }

    if (/^products_page_\d+$/.test(data)) {
    const page = parseInt(data.split('_').pop(), 10);
    const productsHandler = require('./handlers/products');
    await productsHandler.showProducts(bot, chatId, msgId, page);
    await bot.answerCallbackQuery(query.id).catch(() => {});
    return;
  }

    if (data === 'menu_products') {
    await answer();
    await showProducts(bot, chatId, msgId);
    return;
  }
  if (data === 'menu_preorders') {
    await answer();
    await showPreorderProducts(bot, chatId, msgId);
    return;
  }

  // ── Language picker ──────────────────────────────────────────
  if (data === 'menu_language') {
    await answer();
    await showLanguagePicker(bot, chatId, msgId);
    return;
  }
  if (/^set_lang_(en|ar|vi|es)$/.test(data)) {
    const lang = data.split('_').pop();
    await answer();
    db.setUserLanguage(userId, lang);
    const t = require('./utils/i18n').t;
    await bot.editMessageText(t(lang, 'language_set'), {
      chat_id: chatId, message_id: msgId, parse_mode: 'HTML'
    });
    // Then show main menu in their new language
    setTimeout(async () => {
      try {
        await sendMainMenu(bot, chatId, query.from.first_name || '', userId);
      } catch (e) {}
    }, 600);
    return;
  }
  if (/^preorder_view_\d+$/.test(data)) {
    await answer();
    await showPreorderProductDetail(bot, chatId, parseInt(data.split('_').pop(), 10), msgId);
    return;
  }
  if (/^product_\d+$/.test(data)) {
    await answer();
    await showProductDetail(bot, chatId, parseInt(data.split('_')[1], 10), msgId);
    return;
  }
  if (/^buy_\d+$/.test(data)) {
    await buyHandler.initiateBuy(bot, chatId, userId, parseInt(data.split('_')[1], 10), query.id);
    return;
  }

  // ── Back-in-stock subscription ────────────────────────────────────
  if (/^notify_back_\d+$/.test(data)) {
    await answer();
    const productId = parseInt(data.split('_').pop(), 10);
    await buyHandler.handleNotifyBackInStock(bot, chatId, userId, productId);
    return;
  }

  if (data === 'confirm_session') {
    await answer();
    await buyHandler.confirmOrder(bot, chatId, userId, msgId);
    return;
  }
  if (data === 'cancel_session') {
    await answer();
    await buyHandler.cancelOrder(bot, chatId, 0, userId, msgId);
    return;
  }
  if (/^confirm_order_\d+$/.test(data)) {
    // Legacy: confirm after order was already created (payment method screen back button)
    await answer();
    const legacyOrderId = parseInt(data.split('_').pop(), 10);
    const legacyOrder = require('./database/queries').getOrder(legacyOrderId);
    if (legacyOrder && legacyOrder.status === 'pending') {
      const { paymentMethodKb } = require('./utils/keyboard');
      await bot.editMessageText(
        `💳 <b>Select Payment Method</b>\n\nOrder #${legacyOrderId} — ${formatPrice(legacyOrder.total_price)}`,
        { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: paymentMethodKb(legacyOrderId) }
      );
    } else {
      await bot.editMessageText('❌ Order is no longer valid.', { chat_id: chatId, message_id: msgId });
    }
    return;
  }
  if (/^cancel_order_\d+$/.test(data)) {
    await answer();
    await buyHandler.cancelOrder(bot, chatId, parseInt(data.split('_').pop(), 10), userId, msgId);
    return;
  }
  if (/^pay_wallet_\d+$/.test(data)) {
    await answer();
    await buyHandler.payWithWallet(bot, chatId, userId, parseInt(data.split('_').pop(), 10), msgId);
    return;
  }
  if (/^pay_binance_\d+$/.test(data)) {
    await answer();
    await buyHandler.startBinancePayForOrder(bot, chatId, userId, parseInt(data.split('_').pop(), 10), msgId);
    return;
  }
  if (/^pay_usdt_\d+$/.test(data)) {
    await answer();
    await buyHandler.startUsdtPayForOrder(bot, chatId, userId, parseInt(data.split('_').pop(), 10), msgId);
    return;
  }
  if (/^pay_cryptobot_\d+$/.test(data)) {
    await answer();
    await buyHandler.startCryptobotPayForOrder(bot, chatId, userId, parseInt(data.split('_').pop(), 10), msgId);
    return;
  }

  // ── Wallet ───────────────────────────────────────────────────────
  if (data === 'menu_wallet')          { await answer(); await walletHandler.showWallet(bot, chatId, userId, msgId); return; }
  if (data === 'wallet_topup')         { await answer(); await walletHandler.showTopupMethods(bot, chatId, userId, msgId); return; }
  // ── V3: USDT network choice + reservation cancel ──────────────────
  if (/^topup_net_(TRC20|BEP20)$/.test(data)) {
    await answer();
    await walletHandler.startUsdtAmount(bot, chatId, userId, msgId, data.split('_').pop());
    return;
  }
  if (/^topup_cancel_\d+$/.test(data)) {
    await answer('Reservation cancelled');
    db.cancelDepositIntent(parseInt(data.split('_').pop(), 10));
    session.clear(userId);
    await walletHandler.showWallet(bot, chatId, userId, msgId);
    return;
  }
  if (data === 'wallet_topup_usdt')    { await answer(); await walletHandler.startUsdtTopup(bot, chatId, userId, msgId); return; }
  if (data === 'wallet_topup_binance') { await answer(); await walletHandler.startBinancePayTopup(bot, chatId, userId, msgId); return; }
  if (data === 'wallet_topup_cryptobot'){ await answer(); await walletHandler.startCryptobotTopup(bot, chatId, userId, msgId); return; }
  if (data === 'wallet_transactions')  { await answer(); await walletHandler.showTransactions(bot, chatId, userId, msgId); return; }

  // ── API access (self-service, no application needed) ─────────────
  if (data === 'menu_api' || data === 'api_regen_confirm' || data === 'api_regen_do') {
    await answer();

    if (data === 'api_regen_confirm') {
      await bot.editMessageText(
        `⚠️ <b>Generate a new key?</b>\n\n` +
        `Your current key stops working immediately. Anything using it will ` +
        `start getting <code>401 Invalid API key</code> until you update it.\n\n` +
        `Only do this if you think your key leaked.`,
        { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [
            [{ text: '🔁 Yes, generate a new key', callback_data: 'api_regen_do' }],
            [{ text: '↩️ Cancel', callback_data: 'menu_api' }],
          ] } }
      ).catch(() => {});
      return;
    }

    const row = data === 'api_regen_do'
      ? db.regenerateApiKey(userId)
      : db.getOrCreateApiKey(userId);

    const me = await bot.getMe().catch(() => ({ username: '' }));
    const base = db.getSetting('api_base_url', '') ||
                 (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '') ||
                 config.publicBaseUrl || 'https://YOUR-DOMAIN';
    const user = db.getUser(userId);

    await bot.editMessageText(
      `🔌 <b>API Access</b>\n\n` +
      `Buy from the shop straight from your own code.\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🔑 <b>Your API key</b> (tap to copy):\n<code>${escapeHtml(row.api_key)}</code>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `💰 <b>Wallet balance:</b> ${formatPrice(user?.balance || 0)}\n` +
      `📊 <b>Requests made:</b> ${row.requests || 0}\n\n` +
      `<b>Base URL</b>\n<code>${escapeHtml(base)}/api/v2</code>\n\n` +
      `<b>Quick start</b>\n` +
      `<pre>curl -H "X-API-Key: ${escapeHtml(row.api_key)}" \\\n  ${escapeHtml(base)}/api/v2/products</pre>\n` +
      `<b>Buy</b>\n` +
      `<pre>curl -X POST ${escapeHtml(base)}/api/v2/purchase \\\n` +
      `  -H "X-API-Key: ${escapeHtml(row.api_key)}" \\\n` +
      `  -H "Content-Type: application/json" \\\n` +
      `  -d '{"product_id":1,"quantity":1}'</pre>\n` +
      `⚠️ <b>Top up your wallet first</b> — the API spends your balance, it cannot take payments.\n\n` +
      `🔒 <i>Treat this key like a password. Anyone holding it can spend your balance.</i>`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [
          [{ text: '📖 Full documentation', url: `${base}/api/v2/docs` }],
          [{ text: '💰 Top Up Wallet', callback_data: 'wallet_topup' }],
          [{ text: '🔁 Generate new key', callback_data: 'api_regen_confirm' }],
          [{ text: '🔙 Back', callback_data: 'back_main' }],
        ] } }
    ).catch(async () => {
      await bot.sendMessage(chatId, `🔑 Your API key:\n<code>${escapeHtml(row.api_key)}</code>`,
        { parse_mode: 'HTML' });
    });
    return;
  }

  // ── Orders ───────────────────────────────────────────────────────
  if (data === 'menu_orders') {
    await answer();
    await showOrders(bot, chatId, userId, msgId, 'all', 0);
    return;
  }
  // orders_f_<filter>_<page>  — date filter + pagination
  if (/^orders_f_[a-z_0-9]+_\d+$/.test(data)) {
    await answer();
    const parts  = data.split('_');
    const page   = parseInt(parts.pop(), 10) || 0;
    const filter = parts.slice(2).join('_');
    await showOrders(bot, chatId, userId, msgId, filter, page);
    return;
  }
  if (/^order_detail_\d+$/.test(data)) {
    await answer();
    await showOrderDetail(bot, chatId, userId, parseInt(data.split('_').pop(), 10), msgId, query.id);
    return;
  }

  // ── Support ──────────────────────────────────────────────────────
  // ── Customer Refund Request ──────────────────────────────────────
  // ── Refund Request entry: list eligible orders + existing requests ───
  if (data === 'refund_request_start') {
    const db = require('./database/queries');
    const userId = query.from.id;
    // Server-side eligibility: getRefundableUserOrders joins products and
    // filters on p.refund_enabled = 1, so a product the admin marked as
    // non-refundable can never appear in this list.
    const eligibleOrders = db.getRefundableUserOrders(userId);
    const allDelivered   = (db.getUserOrdersAll(userId) || []).filter(o => o.status === 'delivered');
    const blockedCount   = Math.max(0, allDelivered.length - eligibleOrders.length);
    const userRefunds = db.getUserRefundRequests ? db.getUserRefundRequests(userId) : [];

    let txt = `🔄 <b>Refund Request</b>\n\n`;
    if (userRefunds.length > 0) {
      txt += `📋 <b>Your existing requests:</b>\n`;
      for (const r of userRefunds.slice(0, 5)) {
        const emoji = r.status === 'approved' ? '✅' : r.status === 'rejected' ? '❌' : r.status === 'processing' ? '⏳' : '🕐';
        txt += `${emoji} Order #${r.order_id} — ${r.status}\n`;
      }
      txt += `\n`;
    }
    if (eligibleOrders.length === 0) {
      txt += blockedCount > 0
        ? `📭 None of your orders are eligible for a refund.\n\n` +
          `<i>${blockedCount} delivered order(s) are for products that do not ` +
          `support refunds. Contact support if you need help.</i>`
        : `📭 You have no delivered orders to refund.`;
    } else {
      txt += `📦 <b>Select an order to refund:</b>`;
      if (blockedCount > 0) {
        txt += `\n\n<i>ℹ️ ${blockedCount} of your order(s) are for non-refundable products and are not listed.</i>`;
      }
    }

    const rows = eligibleOrders.slice(0, 10).map(o => {
      const title = (o.product_title || 'Product').slice(0, 25);
      return [{ text: `#${o.id} — ${title} — $${(o.total_price||0).toFixed(2)}`, callback_data: `refund_req_${o.id}` }];
    });
    rows.push([{ text: '🔙 Back', callback_data: 'back_main' }]);

    try {
      await bot.editMessageText(txt, {
        chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: rows },
      });
    } catch (e) {
      await bot.sendMessage(chatId, txt, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: rows },
      });
    }
    await bot.answerCallbackQuery(query.id).catch(() => {});
    return;
  }

    // ── Customer cancel their own pending order ──────────────
  if (/^cancel_my_order_\d+$/.test(data)) {
    const db = require('./database/queries');
    const dbRaw = require('./database/db');
    const orderId = parseInt(data.split('_').pop(), 10);
    const userId = query.from.id;
    const order = db.getOrder(orderId);

    if (!order || order.user_id !== userId) {
      await bot.answerCallbackQuery(query.id, { text: '❌ Order not found', show_alert: true }).catch(() => {});
      return;
    }
    if (order.status !== 'pending') {
      await bot.answerCallbackQuery(query.id, { text: '❌ Only pending orders can be cancelled', show_alert: true }).catch(() => {});
      return;
    }

    // Mark as cancelled
    try {
      dbRaw.prepare(`UPDATE orders SET status='cancelled' WHERE id=?`).run(orderId);
    } catch (e) {}

    await bot.editMessageText(
      `❌ <b>Order #${orderId} cancelled.</b>\n\n` +
      `You can now create a new order.`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🔙 My Orders', callback_data: 'menu_orders' }]] } }
    ).catch(() => {});
    await bot.answerCallbackQuery(query.id, { text: '✅ Cancelled' }).catch(() => {});
    return;
  }

    if (/^refund_req_\d+$/.test(data)) {
    const orderId = parseInt(data.split('_').pop(), 10);
    const order = db.getOrder(orderId);
    if (!order || order.user_id !== userId) {
      await answer('❌ Order not found');
      return;
    }
    // ── SERVER-SIDE ELIGIBILITY GATE ──────────────────────────────────────
    // Re-checked here, not just when building the list, so a hand-crafted
    // callback for a non-refundable product is rejected.
    const eligibility = db.isOrderRefundable(orderId);
    if (!eligibility.ok) {
      const msg = {
        not_found:     '❌ Order not found.',
        not_delivered: '❌ Only delivered orders can be refunded.',
        not_eligible:  '🚫 This product is not eligible for refunds.',
      }[eligibility.reason] || '❌ This order cannot be refunded.';
      await bot.answerCallbackQuery(query.id, { text: msg, show_alert: true }).catch(() => {});
      return;
    }
    if (db.getPendingRefundForOrder(orderId)) {
      await answer('⏳ You already have a pending refund request for this order');
      return;
    }
    await answer();
    session.set(userId, States.REFUND_REASON, { refundOrderId: orderId });
    await bot.editMessageText(
      `🔄 <b>Request Refund — Order #${orderId}</b>\n\n` +
      `📦 Product: ${order.product_title}\n` +
      `💵 Amount: ${order.total_price}$\n\n` +
      `📝 <b>Please explain the reason for your refund:</b>\n` +
      `<i>(e.g., account not working, wrong product, etc.)</i>`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: `order_detail_${orderId}` }]] } }
    );
    return;
  }

  // ── Customer: View All My Refunds ─────────────────────────────────
  // ── Refund Method Selection ───────────────────────────────────────
  if (data === 'refund_method_wallet') {
    await answer();
    // Wallet refund — no address needed
    const d = session.get(userId).data;
    const order = db.getOrder(d.refundOrderId);
    if (!order) { await bot.sendMessage(chatId, '❌ Order not found.'); session.clear(userId); return; }
    const walletCheck = db.isOrderRefundable(d.refundOrderId);
    if (!walletCheck.ok) {
      session.clear(userId);
      await bot.sendMessage(chatId,
        '🚫 <b>Not Eligible for Refund</b>\n\n' +
        'This product does not support refund requests. Please contact support if you need help.',
        { parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: '🔙 My Orders', callback_data: 'menu_orders' }]] } });
      return;
    }
    db.addRefundRequest({
      userId, orderId: d.refundOrderId, reason: d.refundReason, amount: 0,
      affectedAccount: d.refundAccount, photoFileId: d.refundPhoto,
      refundMethod: 'wallet', cryptoNetwork: null, walletAddress: null,
    });
    session.clear(userId);
    await bot.editMessageText(
      `✅ <b>Refund Request Submitted!</b>\n\n` +
      `🆔 Order #${d.refundOrderId}\n` +
      `💵 Amount: ${order.total_price}$\n` +
      `💳 Method: Wallet\n\n` +
      `⏳ Our team will review your request.`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🔙 Back to Orders', callback_data: 'menu_orders' }]] } }
    );
    try {
      const pendingW = db.getPendingRefundForOrder(d.refundOrderId);
      await notifyAdmin(bot, {
        type:  'refund_request',
        title: 'New refund request',
        body:
          `🆔 <b>Order:</b> #${d.refundOrderId}\n` +
          `👤 <b>User:</b> <code>${userId}</code>\n` +
          `💵 <b>Order total:</b> ${order.total_price}$\n` +
          `💳 <b>Method:</b> Wallet`,
        dedupeKey: `refund_request:${pendingW ? pendingW.id : d.refundOrderId}`,
        refType: 'refund_request',
        refId:   pendingW ? pendingW.id : d.refundOrderId,
        buttons: pendingW ? [[{ text: '🔄 Review request', callback_data: `admin_refund_view_${pendingW.id}` }]] : null,
        supportButtons: [[{ text: '🔄 Refund list', callback_data: 'ref_list_0' }]],
      });
    } catch (e) { logger.warn(`refund notify failed: ${e.message}`); }
    return;
  }
  if (data === 'refund_method_binance') {
    await answer();
    session.update(userId, { refundMethod: 'binance' });
    session.set(userId, States.REFUND_ADDRESS, session.get(userId).data);
    await bot.editMessageText(
      `🟡 <b>Binance Pay Refund</b>\n\n` +
      `Please send your <b>Binance Pay ID</b> (numeric).\n\n` +
      `<i>Example: 263344433</i>`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' }
    );
    return;
  }
  if (data === 'refund_method_crypto') {
    await answer();
    session.update(userId, { refundMethod: 'crypto' });
    await bot.editMessageText(
      `💎 <b>Choose Network</b>\n\n` +
      `Which network for the USDT refund?`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [
          [{ text: 'TRC20 (Tron)',  callback_data: 'refund_net_TRC20' }],
          [{ text: 'BEP20 (BSC)',   callback_data: 'refund_net_BEP20' }],
          [{ text: 'ERC20 (ETH)',   callback_data: 'refund_net_ERC20' }],
          [{ text: 'Polygon',       callback_data: 'refund_net_POLYGON' }],
        ] } }
    );
    return;
  }
  if (/^refund_net_(TRC20|BEP20|ERC20|POLYGON)$/.test(data)) {
    const network = data.split('_').pop();
    await answer();
    session.update(userId, { refundNetwork: network });
    session.set(userId, States.REFUND_ADDRESS, session.get(userId).data);
    await bot.editMessageText(
      `💎 <b>${network} USDT Refund</b>\n\n` +
      `Please send your <b>${network} wallet address</b>:\n\n` +
      `<i>Make sure the address is correct — refunds cannot be reversed.</i>`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' }
    );
    return;
  }

  if (data === 'my_refunds') {
    await answer();
    const refunds = db.getUserRefundRequests(userId);
    if (!refunds.length) {
      await bot.editMessageText(
        `🔄 <b>My Refund Requests</b>\n\nNo refund requests yet.`,
        { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'menu_orders' }]] } }
      );
      return;
    }
    let txt = `🔄 <b>My Refund Requests</b>\n\n`;
    const statusEmoji = { pending: '⏳', approved: '✅', rejected: '❌' };
    for (const r of refunds) {
      const emoji = statusEmoji[r.status] || '🔄';
      txt += `${emoji} <b>#${r.id}</b> · Order #${r.order_id}\n`;
      txt += `📦 ${r.product_title || 'Unknown'}\n`;
      txt += `💵 ${r.total_price || 0}$\n`;
      txt += `📊 Status: <b>${r.status.toUpperCase()}</b>\n`;
      txt += `📅 ${(r.created_at || '').slice(0, 16)}\n`;
      if (r.admin_note) txt += `📝 <i>Admin: ${r.admin_note.slice(0, 100)}</i>\n`;
      txt += `\n`;
    }
    await bot.editMessageText(txt, {
      chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'menu_orders' }]] }
    });
    return;
  }

  // ── VIP Status / Invite ──────────────────────────────────────────
  if (data === 'menu_vip' || data === 'vip_show') {
    await answer();
    const isVip = db.isVIP(userId);
    const referrals = db.countReferrals(userId);
    const REQUIRED = 3;
    const totalVips = db.countVIPs();
    const VIP_LIMIT = parseInt(db.getSetting('vip_limit', '1000'), 10);
    const slotsLeft = Math.max(0, VIP_LIMIT - totalVips);

    // Check if VIP system is OPEN
    const vipSystemOpen = db.getSetting('vip_system_enabled', '1') === '1';
    const hasInviteePurchased = db.hasAnyInviteePurchased(userId);

    // Auto-unlock requires: 3 referrals + at least ONE invitee has purchased
    if (!isVip && referrals >= REQUIRED && slotsLeft > 0 && vipSystemOpen && hasInviteePurchased) {
      db.unlockVIP(userId);
      try {
        await bot.sendMessage(chatId,
          `👑 <b>VIP UNLOCKED!</b>\n\n` +
          `🎉 Congratulations! You invited ${referrals} friends and unlocked VIP for LIFE!\n\n` +
          `🎁 <b>Your benefits:</b>\n` +
          `💸 5% discount on every purchase forever\n` +
          `🤝 Earn rewards from your team's purchases\n` +
          `🚀 Early access to new products\n` +
          `⚡️ Priority support`,
          { parse_mode: 'HTML' });
      } catch (e) {}
    }

    const me = db.getUser(userId);
    const botUser = await bot.getMe().catch(() => ({ username: 'YourBot' }));
    const inviteLink = `https://t.me/${botUser.username}?start=ref_${userId}`;

    let text;
    if (db.isVIP(userId)) {
      text =
        `👑 <b>VIP FOR LIFE</b> 👑\n\n` +
        `🎉 You are a VIP member!\n\n` +
        `🎁 <b>Your active benefits:</b>\n` +
        `💸 5% discount on every purchase\n` +
        `🤝 Earn rewards from your team's purchases\n` +
        `🚀 Early access to new products\n` +
        `⚡️ Priority support\n\n` +
        `🔗 Share & earn from friends' purchases:\n` +
        `<code>${inviteLink}</code>\n\n` +
        `👥 Your team: <b>${referrals}</b> members`;
    } else {
      const remaining = Math.max(0, REQUIRED - referrals);
      const purchaseStatus = hasInviteePurchased
        ? '✅ At least one friend has purchased'
        : '⏳ No friend has purchased yet';
      text =
        `👑 <b>VIP FOR LIFE</b> 👑\n\n` +
        `🚨 <b>Important:</b> ⏳ VIP closes at <b>${VIP_LIMIT.toLocaleString()} customers</b>\n` +
        `📊 <b>${slotsLeft} slots remaining</b>\n\n` +
        `<b>How to unlock VIP:</b>\n` +
        `1️⃣ Invite ${REQUIRED} friends\n` +
        `2️⃣ At least <b>one</b> of them must buy a product\n\n` +
        `📈 <b>Your progress:</b>\n` +
        `👥 Friends invited: <b>${referrals}/${REQUIRED}</b>\n` +
        `🛒 Purchase status: ${purchaseStatus}\n` +
        (remaining > 0
          ? `🎯 <b>Need ${remaining} more friend(s)</b>\n\n`
          : !hasInviteePurchased
            ? `🎯 <b>Waiting for a friend to make a purchase!</b>\n\n`
            : `🎉 <b>You qualify! Refresh to unlock.</b>\n\n`) +
        `🎁 <b>VIP Benefits:</b>\n` +
        `💸 5% discount on every purchase for life\n` +
        `🤝 Earn rewards from your team's purchases\n` +
        `🚀 Early access to new and rare products\n` +
        `⚡️ Priority support and faster replies\n\n` +
        `🔗 <b>Your invite link:</b>\n` +
        `<code>${inviteLink}</code>\n\n` +
        `🔥 Invite ${REQUIRED} friends today and secure your VIP status forever.`;
    }

    const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(inviteLink)}&text=${encodeURIComponent('Join this awesome store and unlock VIP for life!')}`;
    const kb = { inline_keyboard: [
      [{ text: '👉 Share with friends & become VIP', url: shareUrl }],
      [{ text: '🔙 Back', callback_data: 'back_main' }],
    ] };

    try {
      await bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: kb, disable_web_page_preview: true });
    } catch (e) {
      try { await bot.deleteMessage(chatId, msgId); } catch (e2) {}
      await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: kb, disable_web_page_preview: true });
    }
    return;
  }

  // First-time VIP intro (after /start for new users)
  if (data === 'vip_intro_become') {
    await answer();
    // Redirect to VIP screen
    const query2 = { ...query, data: 'menu_vip' };
    // Re-trigger by sending a new message
    try { await bot.deleteMessage(chatId, msgId); } catch (e) {}
    // Send VIP info as fresh message
    const isVip = db.isVIP(userId);
    const referrals = db.countReferrals(userId);
    const botUser = await bot.getMe().catch(() => ({ username: 'YourBot' }));
    const inviteLink = `https://t.me/${botUser.username}?start=ref_${userId}`;
    const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(inviteLink)}&text=${encodeURIComponent('Join this awesome store and unlock VIP for life!')}`;
    await bot.sendMessage(chatId,
      `👑 <b>VIP FOR LIFE</b> 👑\n\n` +
      `Invite <b>3 friends</b> and unlock VIP forever!\n\n` +
      `🔗 Your link:\n<code>${inviteLink}</code>`,
      { parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [
          [{ text: '👉 Share with friends', url: shareUrl }],
          [{ text: '🔙 Main Menu', callback_data: 'back_main' }],
        ] }, disable_web_page_preview: true });
    return;
  }

  if (data === 'vip_intro_skip') {
    await answer();
    try { await bot.deleteMessage(chatId, msgId); } catch (e) {}
    await sendMainMenu(bot, chatId, query.from.first_name || '', userId);
    return;
  }

  if (data === 'menu_support') { await answer(); await supportHandler.showSupport(bot, chatId, msgId); return; }
  if (data === 'support_send') { await answer(); await supportHandler.startSupportMessage(bot, chatId, userId, msgId); return; }

  // ── Referral ─────────────────────────────────────────────────────
  if (data === 'menu_referral') { await answer(); await handleReferralMenu(bot, chatId, userId); return; }

  // ── Admin panel (security checked inside handleAdminCallback) ─────
  if (data === 'admin_panel') {
    if (!adminHandler.isAdmin(userId)) {
      return bot.answerCallbackQuery(query.id, {
        text: '❌ You are not authorized to use this section.',
        show_alert: true,
      }).catch(() => {});
    }
    await answer();
    await adminHandler.showAdminPanel(bot, chatId, msgId);
    return;
  }
  if (data === 'admin_add_product') {
    if (!adminHandler.isAdmin(userId)) {
      return bot.answerCallbackQuery(query.id, {
        text: '❌ You are not authorized to use this section.',
        show_alert: true,
      }).catch(() => {});
    }
    await answer();
    await adminHandler.startAddProduct(bot, chatId, userId, msgId);
    return;
  }

  // All other admin/* and req_email/notif_/ann_/item_type_ callbacks — security inside handleAdminCallback
  if (data.startsWith('admin_') || /^(req_email|notif_|ann_|item_type_)/.test(data)) {
    await adminHandler.handleAdminCallback(bot, query);
    return;
  }

  // ── Delete single stock item ─────────────────────────────────────
  if (/^admin_del_stock_item_[is]_\d+$/.test(data)) {
    await adminHandler.handleAdminCallback(bot, query);
    return;
  }

  // ── Pre-Order customer-facing buttons ────────────────────────────
  if (/^preorder_\d+$/.test(data)) {
    await answer();
    await buyHandler.initiatePreorder(bot, chatId, userId, parseInt(data.split('_').pop(), 10), msgId);
    return;
  }
  if (/^confirm_preorder_\d+$/.test(data)) {
    await answer();
    await buyHandler.confirmPreorder(bot, chatId, userId, parseInt(data.split('_').pop(), 10), msgId);
    return;
  }
  if (/^cancel_preorder_\d+$/.test(data)) {
    await answer();
    await buyHandler.cancelPreorder(bot, chatId, userId, parseInt(data.split('_').pop(), 10), msgId);
    return;
  }

  logger.warn(`Unhandled callback: ${data}`);
  await answer();
});

// ── Error handlers ────────────────────────────────────────────────────────────

// /recover_items USERID PRODUCTID — recover stolen items from a customer's order
bot.onText(/\/recover_items\s+(\d+)\s+(\d+)/, async (msg, match) => {
  if (!adminHandler.isAdmin(msg.from.id)) return;
  const targetUserId = parseInt(match[1], 10);
  const productId = parseInt(match[2], 10);
  await adminHandler.recoverDeliveredItems(bot, msg.chat.id, msg.from.id, targetUserId, productId);
});

bot.on('polling_error', (err) => logger.error(`Polling error: ${err.message}`));
bot.on('error',         (err) => logger.error(`Bot error: ${err.message}`));
process.on('unhandledRejection', (err) => {
  // These Telegram errors are races, not bugs: the user tapped a button twice,
  // or the message was already gone. They were flooding the production logs.
  const m = String((err && err.message) || err || '');
  if (m.includes('message is not modified') ||
      m.includes('message to edit not found') ||
      m.includes('query is too old')) {
    return;
  }
  logger.error(`Unhandled rejection: ${m}`);
});

// ── Express health server ─────────────────────────────────────────────────────
// Keeps Railway happy (HTTP port) and exposes /health + /cryptobot/webhook.
const app           = express();
const webhookRouter = require('./handlers/webhook')(bot);
const resellerApi   = require('./api-reseller'); // ← new: read-only addition, no bot code touched

app.use('/', webhookRouter);
app.use(express.json());
app.use('/api/v1', resellerApi); // legacy reseller API (separate balances)

// Public customer API: self-service keys, wallet-funded, same pricing and the
// same atomic purchase path as the bot itself.
app.set('bot', bot);   // manual-delivery notifications need a bot instance
app.use('/api/v2', require('./api-public'));

app.listen(config.webhookPort, config.webhookHost, () => {
  logger.info(`HTTP server: http://${config.webhookHost}:${config.webhookPort}/`);
  logger.info(`Health:      http://${config.webhookHost}:${config.webhookPort}/health`);
  logger.info(`Reseller API: http://${config.webhookHost}:${config.webhookPort}/api/v1/docs`);
  logger.info(`Customer API: http://${config.webhookHost}:${config.webhookPort}/api/v2/docs`);
  if (config.cryptobotToken) {
    logger.info(`CryptoBot:   http://${config.webhookHost}:${config.webhookPort}/cryptobot/webhook`);
  }
});

// Log join-gate status for diagnostics
const joinGateEnabled = db.getSetting('join_required_enabled', '0') === '1';
const dbGroupId       = db.getSetting('required_group_id',   '');
const dbChannelId     = db.getSetting('required_channel_id', '');

logger.info('─────────────────────────────────────────────────');
logger.info(`Admins:  [${config.adminIds.join(', ')}]`);
logger.info(`DB:      ${config.dbPath}`);
logger.info(`Referral reward: $${config.referralReward}`);
logger.info(`Join Required: ${joinGateEnabled ? '✅ ENABLED' : '❌ disabled'}`);
if (joinGateEnabled) {
  logger.info(`  Group  ID: ${dbGroupId   || '(not set)'}`);
  logger.info(`  Channel ID: ${dbChannelId || '(not set)'}`);
}
logger.info('─────────────────────────────────────────────────');

// ── Auto VIP Broadcast (every 30 minutes if enabled) ─────────────────
const { publishToChannel, publishToGroup } = require('./services/notifications');
async function autoVipBroadcast() {
  try {
    const enabled = db.getSetting('vip_auto_broadcast', '0') === '1';
    if (!enabled) return;

    const totalVips = db.countVIPs();
    const VIP_LIMIT = parseInt(db.getSetting('vip_limit', '1000'), 10);
    const slotsLeft = Math.max(0, VIP_LIMIT - totalVips);
    const botUser = await bot.getMe().catch(() => ({ username: 'YourBot' }));

    const text =
      `👑 <b>VIP FOR LIFE</b> 👑\n\n` +
      `🚨 <b>Important:</b> ⏳ VIP closes at <b>${VIP_LIMIT} customers</b>\n` +
      `📊 Only <b>${slotsLeft} slots remaining</b>\n\n` +
      `Invite only <b>3 friends</b> and unlock VIP <b>forever</b>!\n\n` +
      `🎁 <b>VIP Benefits:</b>\n` +
      `💸 5% discount on every purchase for life\n` +
      `🤝 Earn rewards from your team's purchases\n` +
      `🚀 Early access to new and rare products\n` +
      `⚡️ Priority support and faster replies\n\n` +
      `🔥 Invite <b>3 friends</b> today and secure your VIP status forever.`;

    const kb = { inline_keyboard: [
      [{ text: '🚀 Open Bot & Invite Friends', url: `https://t.me/${botUser.username}?start=vip` }],
      [{ text: '👑 Become VIP Now', url: `https://t.me/${botUser.username}?start=vip` }],
    ] };

    const vipImg = db.getSetting('vip_image_file_id', '');
    if (vipImg) {
      const channelId = require('./database/queries').getSetting('required_channel_id', '');
      const groupId   = require('./database/queries').getSetting('required_group_id', '');
      if (channelId) {
        try { await bot.sendPhoto(channelId, vipImg, { caption: text, parse_mode: 'HTML', reply_markup: kb }); } catch (e) {}
      }
      if (groupId) {
        try { await bot.sendPhoto(groupId, vipImg, { caption: text, parse_mode: 'HTML', reply_markup: kb }); } catch (e) {}
      }
    } else {
      await publishToChannel(bot, text, kb).catch(() => {});
      await publishToGroup(bot, text, kb).catch(() => {});
    }
  } catch (e) {
    logger.warn(`Auto VIP broadcast failed: ${e.message}`);
  }
}
// Dynamic interval — uses 'vip_broadcast_interval_min' setting (default 30 min)
let vipBroadcastTimer = null;
function scheduleVipBroadcast() {
  if (vipBroadcastTimer) clearTimeout(vipBroadcastTimer);
  const minutes = parseInt(db.getSetting('vip_broadcast_interval_min', '30'), 10);
  const ms = Math.max(1, minutes) * 60 * 1000;
  vipBroadcastTimer = setTimeout(async () => {
    await autoVipBroadcast();
    scheduleVipBroadcast(); // reschedule with current interval (could have changed)
  }, ms);
  logger.info(`VIP broadcast scheduled in ${minutes} minute(s)`);
}
scheduleVipBroadcast();
// Expose globally so admin handler can reschedule
global._scheduleVipBroadcast = scheduleVipBroadcast;

// ── Stale Product Reminders (checked every 6 hours; settings control on/off + threshold) ──
const { checkAndSendStaleProductReminders } = require('./services/notifications');
const STALE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
async function runStaleProductCheck() {
  try {
    await checkAndSendStaleProductReminders(bot, db);
  } catch (e) {
    logger.warn(`Stale product reminder check failed: ${e.message}`);
  }
}
setInterval(runStaleProductCheck, STALE_CHECK_INTERVAL_MS);
// Run once shortly after boot too, so a freshly-enabled setting doesn't wait 6 hours
setTimeout(runStaleProductCheck, 60 * 1000);

// ── Start Support Bot ─────────────────────────────────────────────────
require('./support-bot');
try { require('./chatgpt-bot'); } catch (e) { logger.warn('chatgpt-bot load: ' + e.message); }

