'use strict';

const db      = require('../database/queries');
const session = require('./session');
const { States } = require('./session');
const config  = require('../config');
const {
  adminMainKb, adminProductsKb, adminProductEditFieldsKb, adminBulkPriceKb, adminStockManageKb,
  adminUsersKb, adminUserActionsKb, adminTicketsKb, adminTicketActionsKb,
  adminOrdersKb, adminSettingsKb, requiresEmailKb, notifTargetKb,
  announcementTargetKb, adminConfirmKb, adminBackKb, confirmZeroStockKb,
  backToProductEditKb, adminProfitsKb, adminRefundConfirmKb, deleteStockItemKb,
  adminSortProductsKb,
  adminPreordersMainKb, adminPreorderProductsKb, adminPreorderSetupKb,
  adminPreordersListKb, adminPreorderDetailKb,
  adminUserOrdersKb, adminUserOrderDetailKb,
  adminResetWalletConfirmKb,
  adminPreorderConfirmDeliverKb,
  adminEmojiLibraryKb,
} = require('../utils/keyboard');
const items = require('../database/items');
const { formatPrice, escapeHtml, expandPremiumEmojis, scaleTiersProportionally } = require('../utils/format');
const {
  publishToChannel, publishToGroup, broadcastToUsers, autoPublish, autoPublishWithPhoto,
  buildNewProductText, buildStockUpdateText,
  buildLowStockText, buildOutOfStockText, buildPriceDropText,
} = require('../services/notifications');
const { notifyBackInStockSubscribers } = require('./buy');
const { evaluateStock } = require('../services/stockAlerts');
const logger = require('../utils/logger');

// Pending notification context per admin user
const pendingNotifs = new Map();

// ── Security guard ────────────────────────────────────────────────────────────

/**
 * Returns true if userId is in config.adminIds.
 * Used by EVERY admin function.
 */
function isAdmin(userId) {
  return config.adminIds.includes(userId);
}

/**
 * Rejects non-admin callback queries with a visible alert.
 */
async function rejectNonAdmin(bot, queryId) {
  await bot.answerCallbackQuery(queryId, {
    text: '❌ You are not authorized to use this section.',
    show_alert: true,
  }).catch(() => {});
}

// ── Panel ─────────────────────────────────────────────────────────────────────

async function showAdminPanel(bot, chatId, messageId = null) {
  const text = '🔧 <b>Admin Panel</b>\n\nWelcome, Admin.';
  if (messageId) {
    await bot.editMessageText(text, {
      chat_id: chatId, message_id: messageId,
      parse_mode: 'HTML', reply_markup: adminMainKb(),
    });
  } else {
    await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: adminMainKb() });
  }
}

// ── startAddProduct ───────────────────────────────────────────────────────────

async function startAddProduct(bot, chatId, userId, messageId) {
  session.set(userId, States.ADMIN_ADD_TITLE, {});
  await bot.editMessageText(
    '➕ <b>Add Product</b>\n\nStep 1/7\n\n📝 Enter product title:',
    { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: adminBackKb() }
  );
}

// ── Text message handler ──────────────────────────────────────────────────────

// Convert any premium custom emojis in the message into [emoji:ID]🎁 markers
// so they survive storage and re-rendering.
function convertCustomEmojisToMarkers(msg) {
  const text = msg.text || msg.caption || '';
  const entities = msg.entities || msg.caption_entities || [];
  if (!text) return text;

  const customEmojis = entities
    .filter(e => e.type === 'custom_emoji' && e.custom_emoji_id);

  if (!customEmojis.length) return text;

  // Telegram offsets are in UTF-16 code units. We need to convert to UTF-16 array.
  // Build the text as an array of UTF-16 units, then replace from end to start.
  const sorted = [...customEmojis].sort((a, b) => b.offset - a.offset);
  let result = text;
  for (const e of sorted) {
    // Slice using UTF-16 indexing (default string operations in JS use UTF-16)
    const before = result.substring(0, e.offset);
    const original = result.substring(e.offset, e.offset + e.length);
    const after = result.substring(e.offset + e.length);
    result = before + `[emoji:${e.custom_emoji_id}]${original}` + after;
  }
  logger.info(`[EMOJI CONVERT] Found ${customEmojis.length} premium emojis, result: ${result.slice(0, 100)}`);
  return result;
}

async function handleAdminText(bot, msg) {
  if (!isAdmin(msg.from.id)) return; // silent drop — already guarded in index.js

  const userId = msg.from.id;
  const chatId = msg.chat.id;

  // ── AUTO-CONVERT premium emojis to [emoji:ID] markers ──────────
  // EXCEPTION: For product titles, we KEEP the original Unicode emoji intact
  // (since buttons can display the actual emoji char, and inline messages will
  // still render premium if the bot account has Premium).
  const sessCheck = session.get(userId);
  // For product TITLES, keep original Unicode emoji intact (don't convert to [emoji:ID])
  // This covers BOTH: editing existing title AND adding new product title
  const isProductTitle =
    sessCheck.state === States.ADMIN_ADD_TITLE ||
    (sessCheck.state === States.ADMIN_EDIT_VALUE && sessCheck.data && sessCheck.data.editField === 'title');
  const text = isProductTitle
    ? (msg.text || msg.caption || '').trim()  // Keep original — no conversion
    : convertCustomEmojisToMarkers(msg).trim();

  const sess   = session.get(userId);
  const s      = sess.state;
  const d      = sess.data;

  // ═══════════════════════════════════════════════════════════════════
  // V2 TEXT STATES
  // ═══════════════════════════════════════════════════════════════════

  // ── Per-product low-stock threshold ──────────────────────────────
  // ── Reverse a fraudulent deposit ─────────────────────────────────
  if (s === States.ADMIN_DEP_REVERSE) {
    const parts    = String(text).trim().split(/\s+/);
    const targetId = parseInt(parts[0], 10);
    const amount   = parseFloat(String(parts[1] || '').replace(',', '.'));
    const reason   = parts.slice(2).join(' ') || 'Fraudulent deposit';

    if (!Number.isFinite(targetId) || !Number.isFinite(amount) || amount <= 0) {
      await bot.sendMessage(chatId, '❌ Format: <code>USER_ID AMOUNT [reason]</code>', { parse_mode: 'HTML' });
      return;
    }
    const target = db.getUser(targetId);
    if (!target) {
      session.clear(userId);
      await bot.sendMessage(chatId, '❌ User not found.');
      return;
    }

    session.clear(userId);
    const res = db.reverseDeposit({ userId: targetId, amount, reason, adminId: userId });
    logger.warn(`Admin ${userId} REVERSED ${amount} from user ${targetId}: ${reason}`);

    await bot.sendMessage(
      chatId,
      `↩️ <b>Deposit Reversed</b>\n\n` +
      `👤 <code>${targetId}</code>\n` +
      `💵 Removed: <b>${formatPrice(amount)}</b>\n` +
      `💰 Balance: ${formatPrice(res.before)} → <b>${formatPrice(res.after)}</b>\n` +
      `📝 <i>${escapeHtml(reason)}</i>` +
      (res.after < 0 ? `\n\n⚠️ <b>Balance is negative — the money had already been spent.</b>` : ''),
      { parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [
          [{ text: '🚫 Ban this user', callback_data: `admin_toggle_ban_${targetId}` }],
          [{ text: '🛡 Deposit Review', callback_data: 'admin_deposits' }],
        ] } }
    );
    return;
  }

  if (s === States.ADMIN_LOW_STOCK) {
    const n = parseInt(text, 10);
    if (isNaN(n) || n < 0) {
      await bot.sendMessage(chatId, '❌ Enter a non-negative number (0 = use the global default).');
      return;
    }
    const productId = d.lowStockProductId;
    require('../database/db').prepare('UPDATE products SET low_stock_threshold = ? WHERE id = ?')
      .run(n, productId);
    // Re-arm the alert latches so the new threshold is evaluated cleanly.
    db.resetStockAlertFlags(productId);
    session.clear(userId);

    const product = db.getProduct(productId);
    const globalDefault = db.getSetting('low_stock_threshold_default', '5');
    await bot.sendMessage(
      chatId,
      `✅ <b>Low-stock threshold updated</b>\n\n` +
      `📦 ${escapeHtml(product?.title || '')}\n` +
      `🔔 Alert when stock reaches: <b>${n > 0 ? n : `${globalDefault} (global default)`}</b>\n` +
      `📊 Current stock: <b>${product?.stock_quantity || 0}</b>`,
      { parse_mode: 'HTML', reply_markup: backToProductEditKb(productId) }
    );
    return;
  }

  // ── Content for a manual-delivery task ───────────────────────────
  if (s === States.ADMIN_MD_CONTENT) {
    const taskId = d.mdTaskId;
    const content = (text || '').trim();
    if (!content) {
      await bot.sendMessage(chatId, '❌ Content cannot be empty.');
      return;
    }
    session.clear(userId);
    const manualDelivery = require('./manualDelivery');
    const res = await manualDelivery.completeManualDelivery(bot, taskId, content);
    await bot.sendMessage(
      chatId,
      res.ok
        ? `✅ <b>Task #${taskId} delivered.</b>` +
          (res.notified ? '' : '\n⚠️ The customer could not be messaged — the content is saved on the task.')
        : `⚠️ Could not deliver: <b>${res.reason}</b>`,
      { parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '📦 Manual Delivery', callback_data: 'admin_md_list_pending_0' }]] } }
    );
    return;
  }

  // ── Create a reseller (this handler was missing entirely: the state was
  //    registered in index.js but nothing consumed it, so "Add New Reseller"
  //    silently did nothing) ───────────────────────────────────────
  if (s === 'ADMIN_RESELLER_NEW_NAME') {
    session.clear(userId);
    const name = (text || '').trim();
    if (name.length < 2 || name.length > 60) {
      await bot.sendMessage(chatId, '❌ Name must be between 2 and 60 characters.');
      return;
    }
    const apiKey = 'rk_' + require('crypto').randomBytes(24).toString('hex');
    try {
      db.createReseller(name, apiKey);
      await bot.sendMessage(
        chatId,
        `✅ <b>Reseller created</b>\n\n` +
        `🏪 <b>Name:</b> ${escapeHtml(name)}\n` +
        `🔑 <b>API key</b> (tap to copy):\n<code>${apiKey}</code>\n\n` +
        `⚠️ <i>Share this key only with the reseller. Add balance before they can order.</i>`,
        { parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: '🏪 Resellers', callback_data: 'admin_resellers' }]] } }
      );
      logger.info(`Admin ${userId} created reseller "${name}"`);
    } catch (e) {
      await bot.sendMessage(chatId, `❌ Could not create reseller: ${e.message}`);
    }
    return;
  }

  // ── Adjust reseller balance (same missing-handler problem) ───────
  if (s === 'ADMIN_RESELLER_BALANCE') {
    const { resellerId } = d;
    const amount = parseFloat(String(text).replace('$', '').replace(',', '.'));
    if (isNaN(amount) || amount === 0) {
      await bot.sendMessage(chatId, '❌ Enter a non-zero amount, e.g. <code>10</code> or <code>-5</code>.', { parse_mode: 'HTML' });
      return;
    }
    const r = db.getResellerById(resellerId);
    if (!r) {
      session.clear(userId);
      await bot.sendMessage(chatId, '❌ Reseller not found.');
      return;
    }
    if (amount < 0 && Math.abs(amount) > Number(r.balance) + 1e-9) {
      await bot.sendMessage(chatId,
        `❌ Cannot subtract ${formatPrice(Math.abs(amount))} — balance is only ${formatPrice(r.balance)}.`,
        { parse_mode: 'HTML' });
      return;
    }
    db.addResellerBalance(resellerId, amount);
    session.clear(userId);
    const updated = db.getResellerById(resellerId);
    await bot.sendMessage(
      chatId,
      `✅ <b>Balance updated</b>\n\n` +
      `🏪 ${escapeHtml(updated.name)}\n` +
      `${amount > 0 ? '➕' : '➖'} ${formatPrice(Math.abs(amount))}\n` +
      `💰 New balance: <b>${formatPrice(updated.balance)}</b>`,
      { parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🏪 Back to reseller', callback_data: `admin_reseller_${resellerId}` }]] } }
    );
    return;
  }

  // ── Product wizard ───────────────────────────────────────────────
  if (s === States.ADMIN_ADD_TITLE) {
    session.set(userId, States.ADMIN_ADD_DESCRIPTION, { title: text });
    await bot.sendMessage(chatId, 'Step 2/7\n\n📋 Enter product description:', { reply_markup: adminBackKb() });
    return;
  }
  if (s === States.ADMIN_ADD_DESCRIPTION) {
    session.update(userId, { description: text });
    session.set(userId, States.ADMIN_ADD_PRICE, session.get(userId).data);
    await bot.sendMessage(chatId, 'Step 3/7\n\n💵 Enter price (e.g. 14.09):', { reply_markup: adminBackKb() });
    return;
  }
  if (s === States.ADMIN_ADD_PRICE) {
    const price = parseFloat(text.replace('$', ''));
    if (isNaN(price) || price <= 0) {
      await bot.sendMessage(chatId, '❌ Enter a valid price, e.g. <code>14.09</code>', { parse_mode: 'HTML' });
      return;
    }
    session.update(userId, { price });
    session.set(userId, States.ADMIN_ADD_WARRANTY, session.get(userId).data);
    await bot.sendMessage(chatId, 'Step 4/7\n\n🛡 Enter warranty info:', { reply_markup: adminBackKb() });
    return;
  }
  if (s === States.ADMIN_ADD_WARRANTY) {
    session.update(userId, { warranty: text });
    session.set(userId, States.ADMIN_ADD_REQ_EMAIL, session.get(userId).data);
    await bot.sendMessage(
      chatId,
      'Step 5/7\n\n📧 <b>Does this product require customer email?</b>',
      { parse_mode: 'HTML', reply_markup: requiresEmailKb() }
    );
    return;
  }
  if (s === States.ADMIN_ADD_INSTRUCTION) {
    const instruction = text.toLowerCase() === 'skip' ? null : text;
    session.update(userId, { instruction });
    session.set(userId, States.ADMIN_ADD_IMAGE, session.get(userId).data);
    await bot.sendMessage(
      chatId,
      'Step 7/8\n\n🖼 Send a product image or type <code>skip</code>:',
      { parse_mode: 'HTML', reply_markup: adminBackKb() }
    );
    return;
  }
  if (s === States.ADMIN_ADD_IMAGE) {
    if (text.toLowerCase() !== 'skip') {
      await bot.sendMessage(chatId, '❌ Send a photo or type <code>skip</code>.', { parse_mode: 'HTML' });
      return;
    }
    session.update(userId, { imageFileId: null });
    await askForInitialStock(bot, chatId, userId);
    return;
  }
  // ── Create new category ─────────────────────────────────
  if (s === 'ADMIN_CAT_NEW_NAME') {
    session.clear(userId);
    const input = (text || '').trim();
    if (!input) {
      await bot.sendMessage(chatId, '❌ Empty name. Try again.');
      return;
    }
    // Simple split: first "word" (or emoji sequence before space) becomes emoji
    let emoji = '', name = input;
    const firstSpace = input.indexOf(' ');
    if (firstSpace > 0 && firstSpace <= 10) {
      const possibleEmoji = input.slice(0, firstSpace);
      // If it's not pure ASCII letters/digits, treat as emoji
      if (!/^[a-zA-Z0-9_-]+$/.test(possibleEmoji)) {
        emoji = possibleEmoji;
        name = input.slice(firstSpace + 1).trim();
      }
    }
    if (!name) name = input;
    try {
      db.createCategory(name, emoji, 999);
      await bot.sendMessage(chatId,
        `✅ <b>Category Created</b>\n\n${emoji} ${escapeHtml(name)}`,
        { parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [
            [{ text: '🗂 View Categories', callback_data: 'admin_categories' }],
            [{ text: '➕ Add Another', callback_data: 'admin_cat_new' }],
          ] } }
      );
      logger.info(`Admin ${userId} created category: ${emoji} ${name}`);
    } catch (e) {
      await bot.sendMessage(chatId, `❌ Error: ${e.message}`);
      logger.error(`Category create failed: ${e.message}`);
    }
    return;
  }

  // ── Rename category ─────────────────────────────────────
  if (s === 'ADMIN_CAT_RENAME') {
    const { catId } = session.get(userId)?.data || {};
    session.clear(userId);
    if (!catId) return;
    const input = (text || '').trim();
    if (!input) { await bot.sendMessage(chatId, '❌ Empty name'); return; }
    let emoji = '', name = input;
    const firstSpace = input.indexOf(' ');
    if (firstSpace > 0 && firstSpace <= 10) {
      const possibleEmoji = input.slice(0, firstSpace);
      if (!/^[a-zA-Z0-9_-]+$/.test(possibleEmoji)) {
        emoji = possibleEmoji;
        name = input.slice(firstSpace + 1).trim();
      }
    }
    if (!name) name = input;
    try {
      const cat = db.getCategoryById(catId);
      db.updateCategoryRow(catId, name, emoji, cat?.display_order || 999);
      await bot.sendMessage(chatId,
        `✅ <b>Renamed</b>\n\n${emoji} ${escapeHtml(name)}`,
        { parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [
            [{ text: '🗂 View Categories', callback_data: 'admin_categories' }],
          ] } }
      );
    } catch (e) {
      await bot.sendMessage(chatId, `❌ Error: ${e.message}`);
    }
    return;
  }

  // ── ChatGPT Business: Set monthly price ──
  if (s === 'ADMIN_CGB_PRICE') {
    session.clear(userId);
    const price = parseFloat(text);
    if (isNaN(price) || price <= 0) { await bot.sendMessage(chatId, '❌ Invalid price'); return; }
    const dbRaw = require('../database/db');
    dbRaw.prepare(`
      INSERT INTO settings (key, value) VALUES ('chatgpt_monthly_price', ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value
    `).run(String(price));
    await bot.sendMessage(chatId,
      `✅ <b>Monthly price updated to $${price.toFixed(2)}</b>`,
      { parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [
          [{ text: '🤖 Back to ChatGPT Panel', callback_data: 'admin_cgb_panel' }]
        ] } }
    );
    return;
  }

  // ── ChatGPT Business: Add cycle ──
  if (s === 'ADMIN_CGB_ADDCYCLE') {
    session.clear(userId);
    const m = text.match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
    if (!m) { await bot.sendMessage(chatId, '❌ Invalid format. Use <code>START-END</code> e.g. <code>26-25</code>', { parse_mode: 'HTML' }); return; }
    const startDay = parseInt(m[1], 10);
    const endDay = parseInt(m[2], 10);
    if (startDay < 1 || startDay > 31 || endDay < 1 || endDay > 31) {
      await bot.sendMessage(chatId, '❌ Days must be between 1 and 31'); return;
    }
    db.addBillingCycle(startDay, endDay);
    await bot.sendMessage(chatId,
      `✅ <b>Cycle added: Day ${startDay} → Day ${endDay}</b>`,
      { parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [
          [{ text: '📅 Back to Cycles', callback_data: 'admin_cgb_cycles' }],
          [{ text: '🤖 Back to Panel', callback_data: 'admin_cgb_panel' }]
        ] } }
    );
    return;
  }

  if (s === States.ADMIN_ADD_STOCK) {
    if (text.toLowerCase() === 'skip') {
      await finalizeProduct(bot, chatId, userId, []);
    } else {
      const lines = text.split('\n').filter((l) => l.trim());
      await finalizeProduct(bot, chatId, userId, lines);
    }
    return;
  }

  // ── Edit product field ────────────────────────────────────────────
  if (s === States.ADMIN_EDIT_VALUE) {
    const { editProductId, editField } = d;
    let value = text;

    if (editField === 'price') {
      value = parseFloat(text.replace('$', ''));
      if (isNaN(value)) { await bot.sendMessage(chatId, '❌ Invalid price.'); return; }
    } else if (['requires_email', 'is_active'].includes(editField)) {
      value = text === '1' ? 1 : 0;
    } else if (editField === 'stock_quantity') {
      value = parseInt(text, 10);
      if (isNaN(value) || value < 0) { await bot.sendMessage(chatId, '❌ Enter a valid non-negative number.'); return; }
    } else if (editField === 'sales_count') {
      value = parseInt(text, 10);
      if (isNaN(value) || value < 0) { await bot.sendMessage(chatId, '❌ Enter a valid non-negative number.'); return; }
    } else if (editField === 'bulk_min_qty') {
      value = parseInt(text, 10);
      if (isNaN(value) || value < 0) { await bot.sendMessage(chatId, '❌ Enter a valid non-negative integer. Use <code>0</code> to disable bulk discount.', { parse_mode: 'HTML' }); return; }
    } else if (editField === 'bulk_discount') {
      value = parseFloat(text.replace('%', ''));
      if (isNaN(value) || value < 0 || value > 100) { await bot.sendMessage(chatId, '❌ Enter a percentage between <b>0</b> and <b>100</b>. Use <code>0</code> to disable.', { parse_mode: 'HTML' }); return; }
    } else if (editField === 'wholesale_price') {
      value = parseFloat(text.replace('$', ''));
      if (isNaN(value) || value < 0) { await bot.sendMessage(chatId, '❌ Enter a valid price (use <code>0</code> to disable)', { parse_mode: 'HTML' }); return; }
    } else if (['bulk_tier1_qty', 'bulk_tier2_qty', 'bulk_tier3_qty'].includes(editField)) {
      value = parseInt(text, 10);
      if (isNaN(value) || value < 0) { await bot.sendMessage(chatId, '❌ Enter a valid non-negative integer. Use <code>0</code> to disable this tier.', { parse_mode: 'HTML' }); return; }
    } else if (['bulk_tier1_price', 'bulk_tier2_price', 'bulk_tier3_price'].includes(editField)) {
      value = parseFloat(text.replace('$', ''));
      if (isNaN(value) || value < 0) { await bot.sendMessage(chatId, '❌ Enter a valid non-negative price. Use <code>0</code> to disable.', { parse_mode: 'HTML' }); return; }
    }

    // Price drop detection → send notification
    let priceDropNotif = false;
    let priceDropOldValue = null;
    // Auto-scale bulk pricing tiers by the same % change as the base price
    // (e.g. base price drops 17% → every set tier price drops 17% too),
    // so the admin doesn't have to manually re-enter every tier.
    let tierScaleChanges = [];
    if (editField === 'price') {
      const oldProduct = db.getProduct(editProductId);
      const oldPrice   = oldProduct ? oldProduct.price : null;
      if (oldPrice !== null && value < oldPrice) {
        priceDropNotif = true;
        priceDropOldValue = oldPrice;
      }
      if (oldProduct) {
        tierScaleChanges = scaleTiersProportionally(oldProduct, oldPrice, value);
      }
    }

    // Allow clearing instruction or premium_emoji_id with 'clear' keyword
    if ((editField === 'instruction' || editField === 'premium_emoji_id') &&
        String(value).toLowerCase().trim() === 'clear') {
      value = null;
    }
    db.updateProduct(editProductId, editField, value);

    // Apply the scaled tier prices (after the base price is saved)
    for (const change of tierScaleChanges) {
      db.updateProduct(editProductId, `bulk_tier${change.tier}_price`, change.newPrice);
    }

    session.clear(userId);

    // Send price drop notification to channel/group
    if (priceDropNotif) {
      try {
        const updatedProduct = db.getProduct(editProductId);
        const botInfo = await bot.getMe().catch(() => ({ username: '' }));
        const dropText = buildPriceDropText(updatedProduct, botInfo.username, priceDropOldValue);
        const kbPd = { inline_keyboard: [[{ text: '🛒 Buy now', url: `https://t.me/${botInfo.username}?start=p_${editProductId}` }]] };
        await autoPublishWithPhoto(bot, updatedProduct, dropText, kbPd);
        logger.info(`Price drop broadcast sent for product ${editProductId}`);
      } catch (e) {
        logger.warn(`Price drop notification failed: ${e.message}`);
      }
    }

    // Show success with back button to edit fields
    const { adminProductEditFieldsKb } = require('../utils/keyboard');
    let tierScaleNote = '';
    if (tierScaleChanges.length) {
      const lines = tierScaleChanges
        .map((c) => `  • Tier ${c.tier}: $${c.oldPrice.toFixed(2)} → $${c.newPrice.toFixed(2)}`)
        .join('\n');
      tierScaleNote = `\n\n📊 <b>Bulk tiers auto-adjusted</b> (same % change as the base price):\n${lines}`;
    }
    await bot.sendMessage(
      chatId,
      `✅ <b>${editField}</b> updated successfully!${priceDropNotif ? '\n\n📢 Price drop notification sent to channel.' : ''}${tierScaleNote}`,
      { parse_mode: 'HTML', reply_markup: adminProductEditFieldsKb(editProductId) }
    );
    return;
  }

  // ── Bulk Pricing — combined "qty price" tier entry ──────────────────
  if (s === States.ADMIN_BULK_TIER_VALUE) {
    const { bulkProductId, bulkTierNum } = d;
    const product = db.getProduct(bulkProductId);
    if (!product) {
      session.clear(userId);
      await bot.sendMessage(chatId, '❌ Product not found.');
      return;
    }

    const m = text.trim().match(/^(\d+)\s+([\d.]+)$/);
    if (!m) {
      await bot.sendMessage(chatId,
        '❌ Invalid format. Send the quantity and price separated by a space.\n\n' +
        '<b>Example:</b> <code>20 0.80</code>',
        { parse_mode: 'HTML' });
      return;
    }
    const qty   = parseInt(m[1], 10);
    const price = parseFloat(m[2]);

    if (qty < 1) {
      await bot.sendMessage(chatId, '❌ Quantity must be at least 1.');
      return;
    }
    if (isNaN(price) || price <= 0) {
      await bot.sendMessage(chatId, '❌ Enter a valid price greater than 0.');
      return;
    }
    if (price >= Number(product.price)) {
      await bot.sendMessage(chatId,
        `❌ Tier price must be <b>lower</b> than the base price (${formatPrice(product.price)}). ` +
        `Bulk pricing is meant to be a discount.`,
        { parse_mode: 'HTML' });
      return;
    }

    // Sanity check against the other two tiers: tiers must make sense as
    // increasing quantity → decreasing price, so an admin can't accidentally
    // set Tier 2 cheaper-qty-but-pricier than Tier 1, etc.
    const otherTiers = [1, 2, 3]
      .filter((n) => n !== bulkTierNum)
      .map((n) => ({ n, qty: product[`bulk_tier${n}_qty`] || 0, price: product[`bulk_tier${n}_price`] || 0 }))
      .filter((t) => t.qty > 0 && t.price > 0);

    for (const other of otherTiers) {
      if (qty > other.qty && price >= other.price) {
        await bot.sendMessage(chatId,
          `❌ A higher quantity tier must have a price lower than ${formatPrice(other.price)} ` +
          `(currently set on Tier ${other.n} at ${other.qty}+ pcs).`,
          { parse_mode: 'HTML' });
        return;
      }
      if (qty < other.qty && price <= other.price) {
        await bot.sendMessage(chatId,
          `❌ A lower quantity tier must have a price higher than ${formatPrice(other.price)} ` +
          `(currently set on Tier ${other.n} at ${other.qty}+ pcs).`,
          { parse_mode: 'HTML' });
        return;
      }
    }

    db.updateProduct(bulkProductId, `bulk_tier${bulkTierNum}_qty`, qty);
    db.updateProduct(bulkProductId, `bulk_tier${bulkTierNum}_price`, price);
    session.clear(userId);

    const fresh = db.getProduct(bulkProductId);
    await bot.sendMessage(
      chatId,
      `✅ <b>Tier ${bulkTierNum} saved:</b> ${qty}+ pcs → ${formatPrice(price)} each`,
      { parse_mode: 'HTML', reply_markup: adminBulkPriceKb(fresh) }
    );
    return;
  }

  // ── Large Stock Upload — multi-message batch accumulator ───────────
  if (s === States.ADMIN_STOCK_BATCH) {
    const productId = d.stockProductId;
    const product   = db.getProduct(productId);
    if (!product) { session.clear(userId); await bot.sendMessage(chatId, '❌ Product not found.'); return; }

    const cmd = text.trim().toUpperCase();

    // Cancel
    if (cmd === 'CANCEL') {
      session.clear(userId);
      await bot.sendMessage(chatId,
        `❌ <b>Upload cancelled.</b> No items were added.`,
        { parse_mode: 'HTML', reply_markup: adminStockManageKb(productId) });
      return;
    }

    // Done — save everything accumulated
    if (cmd === 'DONE') {
      const allItems = d.batchItems || [];
      if (!allItems.length) {
        session.clear(userId);
        await bot.sendMessage(chatId,
          `⚠️ No items were received. Upload cancelled.`,
          { parse_mode: 'HTML', reply_markup: adminStockManageKb(productId) });
        return;
      }

      const prevStock = product.stock_quantity || 0;
      const count     = items.insertItems(productId, allItems);
      db.adjustStockQuantity(productId, count);
      session.clear(userId);

      await bot.sendMessage(chatId,
        `✅ <b>Large Stock Upload Complete!</b>\n\n` +
        `📦 Product: <b>${escapeHtml(product.title)}</b>\n` +
        `📨 Batches received: <b>${d.batchCount}</b>\n` +
        `➕ Items added: <b>${count}</b>\n` +
        `📊 Previous stock: ${prevStock}\n` +
        `📊 New stock: <b>${prevStock + count}</b>`,
        { parse_mode: 'HTML', reply_markup: adminStockManageKb(productId) });

      await evaluateStock(bot, productId);

      // Notify back-in-stock subscribers if stock was zero
      if (prevStock === 0 && count > 0) {
        const notified = await notifyBackInStockSubscribers(bot, productId);
        if (notified > 0) {
          await bot.sendMessage(chatId,
            `🔔 Notified <b>${notified}</b> waiting user(s) that stock is available again.`,
            { parse_mode: 'HTML' });
        }
      }

      // Auto-publish stock update to channel + group (same as regular stock add)
      const notifEnabled = db.getSetting('stock_notifications_enabled', '1');
      if (notifEnabled === '1' && count > 0) {
        try {
          const fresh = db.getProduct(productId);
          const botInfo = await bot.getMe().catch(() => ({ username: '' }));
          const kb = { inline_keyboard: [[{ text: '🛒 Buy now', url: `https://t.me/${botInfo.username}?start=p_${fresh.id}` }]] };
          await autoPublishWithPhoto(bot, fresh, buildStockUpdateText(fresh, count), kb);
        } catch (e) {
          logger.warn(`Batch stock notif error: ${e.message}`);
        }
      }
      return;
    }

    // Regular batch message — parse and accumulate
    const { valid } = items.validateLines(text);
    if (!valid.length) {
      await bot.sendMessage(chatId,
        `⚠️ No valid items found in this message. Send another batch or type <code>DONE</code> to finish (${(d.batchItems || []).length} items accumulated so far).`,
        { parse_mode: 'HTML' });
      return;
    }

    const accumulated = [...(d.batchItems || []), ...valid];
    session.update(userId, { batchItems: accumulated, batchCount: (d.batchCount || 0) + 1 });

    await bot.sendMessage(chatId,
      `✅ <b>Batch ${(d.batchCount || 0) + 1} received</b> — <b>${valid.length}</b> items added\n` +
      `📊 Total accumulated: <b>${accumulated.length}</b> items\n\n` +
      `Send another batch, or type <code>DONE</code> to save all ${accumulated.length} items.\n` +
      `Type <code>CANCEL</code> to discard everything.`,
      { parse_mode: 'HTML' });
    return;
  }

  // ── Stock item bulk add (product_items) ─────────────────────────
  if (s === States.ADMIN_STOCK_DATA) {
    const productId = d.stockProductId;
    const product   = db.getProduct(productId);
    const prevStock = product?.stock_quantity || 0;

    const { valid } = items.validateLines(text);

    if (!valid.length) {
      await bot.sendMessage(chatId, '❌ No valid items found. Please check your format and try again.');
      return;
    }

    // Show CONFIRMATION instead of adding immediately
    // Save items in session for confirmation step
    session.set(userId, States.ADMIN_STOCK_CONFIRM, {
      stockProductId: productId,
      stockItems: valid,
      prevStock: prevStock,
    });

    // Preview first 3 items
    const preview = valid.slice(0, 3).map((v, i) => `${i + 1}. <code>${escapeHtml((v.raw || '').slice(0, 50))}</code>`).join('\n');
    const more = valid.length > 3 ? `\n... and ${valid.length - 3} more` : '';

    await bot.sendMessage(
      chatId,
      `⚠️ <b>Confirm Stock Addition</b>\n\n` +
      `📦 <b>Product:</b> ${escapeHtml(product.title)}\n` +
      `➕ <b>Items to add:</b> <b>${valid.length}</b>\n` +
      `📊 <b>Current stock:</b> ${prevStock}\n` +
      `📊 <b>New stock will be:</b> <b>${prevStock + valid.length}</b>\n\n` +
      `📋 <b>Preview:</b>\n${preview}${more}\n\n` +
      `Are you sure you want to add these ${valid.length} item(s)?`,
      { parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [
          [{ text: `✅ Yes, add ${valid.length} items`, callback_data: 'admin_stock_confirm_yes' }],
          [{ text: '❌ Cancel', callback_data: `admin_edit_p_${productId}` }],
        ] } }
    );
    return;
  }

  // Continued — placeholder to keep regular flow disabled
  if (false) {
    const productId = d.stockProductId;
    const product   = db.getProduct(productId);
    const wasZero   = (product?.stock_quantity || 0) === 0;
    const prevStock = product?.stock_quantity || 0;
    const { valid } = { valid: [] };
    logger.info(`Admin ${userId} adding ${valid.length} stock items to product ${productId}`);
    const count   = items.insertItems(productId, valid);
    const newQty  = db.adjustStockQuantity(productId, count).after;
    session.clear(userId);

    await bot.sendMessage(
      chatId,
      `✅ <b>Stock Items Added Successfully!</b>\n\n` +
      `📦 <b>Product:</b> ${product.title}\n` +
      `➕ <b>Items added:</b> ${count}\n` +
      `📊 <b>Previous stock:</b> ${prevStock}\n` +
      `📊 <b>New stock:</b> ${newQty}`,
      { parse_mode: 'HTML', reply_markup: backToProductEditKb(productId) }
    );

    if (wasZero && newQty > 0) {
      const notified = await notifyBackInStockSubscribers(bot, productId);
      if (notified > 0) {
        await bot.sendMessage(chatId, `🔔 Notified <b>${notified}</b> waiting user(s) that stock is available again.`, { parse_mode: 'HTML' });
      }
    }

    // ── Pre-Order: ASK admin first before auto-delivering ──────────
    try {
      const pending = db.getReservedPreordersByProduct(productId);
      if (pending.length > 0) {
        const productLatest = db.getProduct(productId);
        await bot.sendMessage(
          chatId,
          `🔜 <b>Pre-Order Notice</b>\n\n` +
          `📦 Product: ${escapeHtml(productLatest.title)}\n` +
          `👥 Pending Pre-Orders: <b>${pending.length}</b>\n\n` +
          `Do you want to deliver these pre-orders now?\n\n` +
          `<i>⚠️ If you added wrong items by mistake, choose "No" to skip and fix the stock first.</i>`,
          { parse_mode: 'HTML', reply_markup: adminPreorderConfirmDeliverKb(productId, pending.length) }
        );
      }
    } catch (e) {
      logger.warn(`Pre-order notice error: ${e.message}`);
    }

    const notifEnabled = db.getSetting('stock_notifications_enabled', '1');
    if (notifEnabled === '1') {
      const fresh = db.getProduct(productId);
      const botUserSu = await bot.getMe().catch(() => ({ username: '' }));
      const kbSu = { inline_keyboard: [[{ text: '🛒 Buy now', url: `https://t.me/${botUserSu.username}?start=p_${fresh.id}` }]] };
      await autoPublishWithPhoto(bot, fresh, buildStockUpdateText(fresh, count), kbSu);
    }
    return;
  }

  // ── Add to stock_quantity (numeric) ──────────────────────────────
  if (s === States.ADMIN_STOCK_ADD_QTY) {
    const n = parseInt(text, 10);
    if (isNaN(n) || n < 1) {
      await bot.sendMessage(chatId, '❌ Enter a positive number.');
      return;
    }
    const productId = d.stockProductId;
    const wasZero   = (db.getProduct(productId)?.stock_quantity || 0) === 0;
    const result    = db.adjustStockQuantity(productId, n);
    const product   = db.getProduct(productId);
    session.clear(userId);

    await bot.sendMessage(
      chatId,
      `✅ <b>Quantity Updated!</b>\n\n📦 ${product.title}\n` +
      `➕ Added: ${n}\n📊 New stock: <b>${result.after}</b>`,
      { parse_mode: 'HTML', reply_markup: adminBackKb() }
    );

    await evaluateStock(bot, productId);

    // Fire back-in-stock notifications if was 0 before
    if (wasZero && result.after > 0) {
      const notified = await notifyBackInStockSubscribers(bot, productId);
      if (notified > 0) {
        await bot.sendMessage(chatId, `🔔 Notified <b>${notified}</b> waiting user(s).`, { parse_mode: 'HTML' });
      }
    }

    // Auto-publish stock update to channel + group
    const notifEnabled = db.getSetting('stock_notifications_enabled', '1');
    if (notifEnabled === '1') {
      const botUserSu2 = await bot.getMe().catch(() => ({ username: '' }));
      const kbSu2 = { inline_keyboard: [[{ text: '🛒 Buy now', url: `https://t.me/${botUserSu2.username}?start=p_${product.id}` }]] };
      await autoPublishWithPhoto(bot, product, buildStockUpdateText(product, n), kbSu2);
    }
    return;
  }

  // ── Remove from stock_quantity ───────────────────────────────────
  if (s === States.ADMIN_STOCK_REMOVE_QTY) {
    const n = parseInt(text, 10);
    if (isNaN(n) || n < 1) {
      await bot.sendMessage(chatId, '❌ Enter a positive number.');
      return;
    }
    const productId = d.stockProductId;
    const before    = db.getProduct(productId)?.stock_quantity || 0;
    const result    = db.adjustStockQuantity(productId, -n);
    session.clear(userId);
    await bot.sendMessage(
      chatId,
      `✅ <b>Stock Updated Successfully!</b>\n\n` +
      `📦 ${db.getProduct(productId)?.title}\n` +
      `➖ Removed: ${n}\n` +
      `📊 Previous stock: ${before}\n` +
      `📊 New stock: <b>${result.after}</b>`,
      { parse_mode: 'HTML', reply_markup: backToProductEditKb(productId) }
    );
    await evaluateStock(bot, productId);
    return;
  }

  // ── Set stock_quantity manually ───────────────────────────────────
  if (s === States.ADMIN_STOCK_SET_QTY) {
    const n = parseInt(text, 10);
    if (isNaN(n) || n < 0) {
      await bot.sendMessage(chatId, '❌ Enter a valid non-negative number.');
      return;
    }
    const productId = d.stockProductId;
    const wasZero   = (db.getProduct(productId)?.stock_quantity || 0) === 0;
    const newQty    = db.setStockQuantity(productId, n);
    const product   = db.getProduct(productId);
    session.clear(userId);

    await bot.sendMessage(
      chatId,
      `✅ <b>Stock Set!</b>\n\n📦 ${product.title}\n📊 Stock quantity: <b>${newQty}</b>`,
      { parse_mode: 'HTML', reply_markup: backToProductEditKb(productId) }
    );

    await evaluateStock(bot, productId);

    if (wasZero && newQty > 0) {
      const notified = await notifyBackInStockSubscribers(bot, productId);
      if (notified > 0) {
        await bot.sendMessage(chatId, `🔔 Notified <b>${notified}</b> waiting user(s).`, { parse_mode: 'HTML' });
      }
    }
    return;
  }

  // ── Set sales_count ───────────────────────────────────────────────
  if (s === States.ADMIN_SALES_COUNT_SET) {
    const n = parseInt(text, 10);
    if (isNaN(n) || n < 0) {
      await bot.sendMessage(chatId, '❌ Enter a valid non-negative number.');
      return;
    }
    db.setSalesCount(d.editProductId, n);
    session.clear(userId);
    await bot.sendMessage(
      chatId,
      `✅ Sales count updated to <b>${n}</b>.`,
      { parse_mode: 'HTML', reply_markup: adminBackKb() }
    );
    return;
  }

  // ── Broadcast ─────────────────────────────────────────────────────
  if (s === States.ADMIN_BROADCAST_MSG) {
    session.set(userId, States.ADMIN_BROADCAST_CONFIRM, { broadcastText: msg.html || text });
    const allUsers = db.getAllUsers();
    await bot.sendMessage(
      chatId,
      `📣 <b>Broadcast Preview</b>\n\nWill send to <b>${allUsers.length}</b> users:\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n${text}\n━━━━━━━━━━━━━━━━━━━━\n\nConfirm?`,
      { parse_mode: 'HTML', reply_markup: adminConfirmKb('admin_confirm_broadcast', 'admin_broadcast') }
    );
    return;
  }

  // ── Support reply ─────────────────────────────────────────────────
  if (s === States.ADMIN_REPLY_TICKET) {
    const { replyTicketId } = d;
    const ticket = db.getTicket(replyTicketId);
    db.replyTicket(replyTicketId, text);
    session.clear(userId);

    let notified = false;
    if (ticket) {
      try {
        await bot.sendMessage(
          ticket.user_id,
          `💬 <b>Support Reply</b>\n\nRegarding ticket #${replyTicketId}:\n\n${text}`,
          { parse_mode: 'HTML' }
        );
        notified = true;
      } catch { /* user may have blocked */ }
    }
    await bot.sendMessage(
      chatId,
      `✅ Reply sent!${notified ? '' : '\n⚠️ Could not notify user (may have blocked bot).'}`,
      { reply_markup: adminBackKb() }
    );
    return;
  }

  // ── Settings value ────────────────────────────────────────────────
  if (s === States.ADMIN_SETTING_VALUE) {
    db.setSetting(d.settingKey, text);
    session.clear(userId);
    await bot.sendMessage(chatId, `✅ Setting <b>${d.settingKey}</b> → <code>${text}</code>`, {
      parse_mode: 'HTML', reply_markup: adminBackKb(),
    });
    return;
  }

  // ── Announcement ──────────────────────────────────────────────────
  if (s === States.ADMIN_ANN_MSG) {
    session.set(userId, States.ADMIN_ANN_BUTTON_ASK, { annText: text });
    await bot.sendMessage(
      chatId,
      `📢 <b>Preview:</b>\n\n${text}\n\nWould you like to add a button?`,
      { parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [
          [{ text: '🛒 Add Buy Product Button', callback_data: 'ann_btn_product' }],
          [{ text: '⏭ Skip (no button)', callback_data: 'ann_btn_skip' }],
        ] } }
    );
    return;
  }

  // Admin types button text for product button: "TEXT|PRODUCT_ID"
  if (s === States.ADMIN_ANN_BUTTON_TEXT) {
    const parts = text.split('|').map(p => p.trim());
    if (parts.length < 2) {
      await bot.sendMessage(chatId, '❌ Format: <code>Button Text|PRODUCT_ID</code>\n\nExample: <code>🛒 Buy Now|5</code>', { parse_mode: 'HTML' });
      return;
    }
    const [btnText, prodIdStr] = parts;
    const prodId = parseInt(prodIdStr, 10);
    if (!btnText || !prodId) {
      await bot.sendMessage(chatId, '❌ Invalid format.');
      return;
    }
    const product = db.getProduct(prodId);
    if (!product) {
      await bot.sendMessage(chatId, '❌ Product not found.');
      return;
    }
    const sessData = session.get(userId).data;
    session.set(userId, States.ADMIN_ANN_TARGET, {
      annText: sessData.annText,
      annButton: { text: btnText, product_id: prodId },
    });
    await bot.sendMessage(chatId,
      `✅ Button set: <b>${escapeHtml(btnText)}</b> → ${escapeHtml(product.title)}\n\nWhere to send?`,
      { parse_mode: 'HTML', reply_markup: announcementTargetKb() }
    );
    return;
  }

  // ── Manual balance: step 1 — collect target user ID or @username ──
  if (s === States.ADMIN_BALANCE_USER_ID) {
    const input = text.trim();
    let target = null;

    if (input.startsWith('@')) {
      // Lookup by username
      target = db.getUserByUsername(input.slice(1));
    } else {
      const targetId = parseInt(input, 10);
      if (!isNaN(targetId) && targetId > 0) {
        target = db.getUser(targetId);
      }
    }

    if (!target) {
      await bot.sendMessage(
        chatId,
        `❌ User <code>${input}</code> not found.\n\nEnter a valid Telegram ID or <code>@username</code>.\nThe user must have started the bot at least once.`,
        { parse_mode: 'HTML', reply_markup: adminBackKb() }
      );
      return;
    }

    const targetId = target.telegram_id;
    const op = d.balanceOp === 'remove' ? 'remove' : 'add';
    const nextState = op === 'remove'
      ? States.ADMIN_BALANCE_AMOUNT_REMOVE
      : States.ADMIN_BALANCE_AMOUNT_ADD;
    session.set(userId, nextState, { balanceOp: op, balanceTargetId: targetId });

    const name = target.username ? `@${target.username}` : (target.first_name || `User ${targetId}`);
    const prompt = op === 'remove'
      ? '➖ <b>Remove User Balance</b>\n\n'
      : '➕ <b>Add User Balance</b>\n\n';
    await bot.sendMessage(
      chatId,
      prompt +
      `👤 Target: <b>${name}</b> (<code>${targetId}</code>)\n` +
      `💰 Current balance: <b>${formatPrice(target.balance || 0)}</b>\n\n` +
      `Send the <b>amount</b> to ${op}:`,
      { parse_mode: 'HTML', reply_markup: adminBackKb() }
    );
    return;
  }

  // ── Manual balance: step 2 — apply amount ────────────────────────
  if (s === States.ADMIN_BALANCE_AMOUNT_ADD || s === States.ADMIN_BALANCE_AMOUNT_REMOVE) {
    const op       = s === States.ADMIN_BALANCE_AMOUNT_REMOVE ? 'remove' : 'add';
    const targetId = d.balanceTargetId;
    const amount   = parseFloat((text || '').replace('$', '').replace(',', '.'));

    if (isNaN(amount) || amount <= 0) {
      await bot.sendMessage(chatId, '❌ Enter a valid positive amount. Example: <code>10.00</code>', { parse_mode: 'HTML' });
      return;
    }

    const target = db.getUser(targetId);
    if (!target) {
      await bot.sendMessage(chatId, '❌ Target user no longer exists.', { reply_markup: adminBackKb() });
      session.clear(userId);
      return;
    }

    const currentBalance = Number(target.balance || 0);
    if (op === 'remove' && amount > currentBalance + 1e-9) {
      await bot.sendMessage(
        chatId,
        `❌ Cannot remove <b>${formatPrice(amount)}</b> — user only has <b>${formatPrice(currentBalance)}</b>.`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    const delta = op === 'remove' ? -amount : amount;
    db.updateBalance(targetId, delta);
    db.addTransaction({
      userId:      targetId,
      type:        op === 'remove' ? 'admin_debit' : 'admin_credit',
      amount:      delta,
      description: op === 'remove'
        ? `Admin balance removal (by admin ${userId})`
        : `Admin balance credit (by admin ${userId})`,
      refId:       null,
      orderId:     null,
    });

    const updated = db.getUser(targetId);
    const newBalance = Number(updated?.balance || 0);
    const name = target.username ? `@${target.username}` : (target.first_name || `User ${targetId}`);

    session.clear(userId);

    // Confirm to admin
    await bot.sendMessage(
      chatId,
      `✅ <b>Balance ${op === 'remove' ? 'Removed' : 'Added'}!</b>\n\n` +
      `👤 ${name} (<code>${targetId}</code>)\n` +
      `${op === 'remove' ? '➖' : '➕'} ${formatPrice(amount)}\n` +
      `💰 New balance: <b>${formatPrice(newBalance)}</b>`,
      { parse_mode: 'HTML', reply_markup: adminBackKb() }
    );

    // Notify the user
    try {
      if (op === 'remove') {
        await bot.sendMessage(
          targetId,
          `⚠️ <b>Your wallet was adjusted by admin.</b>\n\n` +
          `Amount: <b>-${formatPrice(amount)}</b>\n` +
          `New Balance: <b>${formatPrice(newBalance)}</b>\n\n` +
          `Contact support if you have questions.`,
          { parse_mode: 'HTML' }
        );
      } else {
        await bot.sendMessage(
          targetId,
          `✅ <b>Your wallet has been credited by admin.</b>\n\n` +
          `Amount: <b>${formatPrice(amount)}</b>\n` +
          `New Balance: <b>${formatPrice(newBalance)}</b>`,
          { parse_mode: 'HTML' }
        );
      }
    } catch (e) {
      logger.warn(`Could not notify user ${targetId} about balance change: ${e.message}`);
    }
    return;
  }

  // ── User Search (text input) ──────────────────────────────────────
  if (s === States.ADMIN_USER_SEARCH) {
    const query = String(text).trim().replace(/^@/, '');
    if (!query) {
      await bot.sendMessage(chatId, '❌ Enter a search term.');
      return;
    }
    const results = db.searchUsers(query);
    session.clear(userId);

    if (!results.length) {
      await bot.sendMessage(
        chatId,
        `🔍 No users found matching "<b>${escapeHtml(query)}</b>".`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔙 Back to Users', callback_data: 'admin_users' }]] } }
      );
      return;
    }

    const rows = results.slice(0, 15).map((u) => {
      const name = u.username || u.first_name || `User ${u.telegram_id}`;
      const banned = u.is_banned ? '🚫 ' : '';
      return [{ text: `${banned}${name} — $${Number(u.balance).toFixed(2)}`, callback_data: `admin_user_${u.telegram_id}` }];
    });
    rows.push([{ text: '🔍 New Search', callback_data: 'admin_user_search' }]);
    rows.push([{ text: '🔙 All Users', callback_data: 'admin_users' }]);

    await bot.sendMessage(
      chatId,
      `🔍 <b>Found ${results.length} user(s)</b> matching "<b>${escapeHtml(query)}</b>"`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } }
    );
    return;
  }

  // ── Edit Broadcast Interval ──────────────────────────────────────
  if (s === States.ADMIN_VIP_INTERVAL) {
    const minutes = parseInt(text.replace(/[^\d]/g, ''), 10);
    if (isNaN(minutes) || minutes < 5 || minutes > 1440) {
      await bot.sendMessage(chatId, '❌ Please enter a valid number between 5 and 1440 minutes.');
      return;
    }
    db.setSetting('vip_broadcast_interval_min', String(minutes));
    session.clear(userId);
    if (typeof global._scheduleVipBroadcast === 'function') {
      global._scheduleVipBroadcast();
    }
    await bot.sendMessage(chatId,
      `✅ <b>Interval Updated</b>\n\nVIP broadcast will now run every <b>${minutes} minute(s)</b>.`,
      { parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🔙 VIP Panel', callback_data: 'admin_vip_toggle' }]] } }
    );
    return;
  }

  // ── Admin Custom Refund Amount ───────────────────────────────────
  if (s === States.ADMIN_REFUND_AMOUNT) {
    const amount = parseFloat(text.replace(',', '.'));
    if (isNaN(amount) || amount <= 0) {
      await bot.sendMessage(chatId, '❌ Please enter a valid amount.');
      return;
    }
    const r = db.getRefundRequestById(d.refundId);
    if (!r) { await bot.sendMessage(chatId, '❌ Refund not found.'); session.clear(userId); return; }
    if (amount > Number(r.total_price)) {
      await bot.sendMessage(chatId, `❌ Amount cannot exceed order total (${formatPrice(r.total_price)}).`);
      return;
    }
    session.clear(userId);
    const sent = await bot.sendMessage(chatId, '⏳ Processing...');
    await processRefundApproval(bot, chatId, sent.message_id, r, amount);
    return;
  }

  // ── Edit VIP Limit ────────────────────────────────────────────────
  if (s === States.ADMIN_VIP_LIMIT) {
    const num = parseInt(text.replace(/[,. ]/g, ''), 10);
    if (isNaN(num) || num < 1 || num > 10000000) {
      await bot.sendMessage(chatId, '❌ Please enter a valid number (1 to 10,000,000).');
      return;
    }
    db.setSetting('vip_limit', String(num));
    session.clear(userId);
    await bot.sendMessage(chatId,
      `✅ <b>VIP Limit Updated</b>\n\nNew limit: <b>${num.toLocaleString()}</b>`,
      { parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🔙 VIP Panel', callback_data: 'admin_vip_toggle' }]] } }
    );
    return;
  }

  // ── Clear VIP Image ───────────────────────────────────────────────
  if (s === States.ADMIN_VIP_IMAGE) {
    if (text.toLowerCase().trim() === 'clear') {
      db.setSetting('vip_image_file_id', '');
      session.clear(userId);
      await bot.sendMessage(chatId, '✅ VIP image cleared.', {
        reply_markup: { inline_keyboard: [[{ text: '🔙 VIP Panel', callback_data: 'admin_vip_toggle' }]] }
      });
    } else {
      await bot.sendMessage(chatId, 'ℹ️ Send a photo or type <code>clear</code> to remove.', { parse_mode: 'HTML' });
    }
    return;
  }

  // ── Edit Maintenance Message ──────────────────────────────────────
  if (s === States.ADMIN_MAINTENANCE_MSG) {
    if (text.length > 500) {
      await bot.sendMessage(chatId, '❌ Message too long (max 500 chars).');
      return;
    }
    db.setSetting('maintenance_message', text);
    session.clear(userId);
    await bot.sendMessage(chatId,
      `✅ <b>Maintenance message updated.</b>\n\n` +
      `Customers will now see:\n<i>${escapeHtml(text)}</i>`,
      { parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🔙 Maintenance Panel', callback_data: 'admin_maintenance' }]] } }
    );
    return;
  }

  // ── Add Emoji to Library ──────────────────────────────────────────
  if (s === States.ADMIN_EMOJI_ADD) {
    const parts = text.split('|').map(p => p.trim());
    if (parts.length < 2 || parts.length > 3) {
      await bot.sendMessage(chatId, '❌ Invalid format. Use: <code>name|EMOJI_ID|fallback</code>', { parse_mode: 'HTML' });
      return;
    }
    const [name, emojiId, fallback = '🎁'] = parts;
    if (!name || !emojiId || !/^\d+$/.test(emojiId)) {
      await bot.sendMessage(chatId, '❌ Name and numeric EMOJI_ID are required.');
      return;
    }
    if (name.length > 50) {
      await bot.sendMessage(chatId, '❌ Name too long (max 50 chars).');
      return;
    }

    const result = db.addEmoji(name.toLowerCase().replace(/\s+/g, '_'), emojiId, fallback);
    session.clear(userId);

    if (!result) {
      await bot.sendMessage(chatId, '❌ Name already used. Try a different one.');
      return;
    }

    await bot.sendMessage(
      chatId,
      `✅ <b>Emoji added!</b>\n\n` +
      `<b>Name:</b> ${escapeHtml(name)}\n` +
      `Preview: <tg-emoji emoji-id="${emojiId}">${fallback}</tg-emoji>\n\n` +
      `Use this anywhere:\n` +
      `<code>[emoji:${emojiId}]${fallback}</code>`,
      { parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🔙 Library', callback_data: 'admin_emojis' }]] } }
    );
    return;
  }

  // ── Send Pre-Order content manually ───────────────────────────────
  if (s === States.ADMIN_PRE_SEND_CONTENT) {
    const { sendPreId } = d;
    logger.info(`[PREORDER SEND] Admin ${userId} sending content for preorder #${sendPreId}`);
    const pr = db.getPreorderById(sendPreId);
    if (!pr) {
      await bot.sendMessage(chatId, `❌ Pre-order #${sendPreId} not found in DB.`);
      session.clear(userId);
      return;
    }
    if (pr.status !== 'reserved') {
      await bot.sendMessage(chatId, `❌ Pre-order #${sendPreId} already ${pr.status}.`);
      session.clear(userId);
      return;
    }
    const product = db.getProduct(pr.product_id);
    const contentToSend = (text || '').trim();
    if (!contentToSend) {
      await bot.sendMessage(chatId, '❌ Content cannot be empty.');
      return;
    }

    logger.info(`[PREORDER SEND] Sending content to user ${pr.user_id}, length=${contentToSend.length}`);

    // Format date
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const dateStr =
      pad(now.getDate()) + '/' + pad(now.getMonth() + 1) + '/' + now.getFullYear() +
      ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes());

    const instr = (product && product.instruction)
      ? `\n━━━━━━━━━━━━━━━━━━━━\n📌 <b>Instructions:</b>\n${escapeHtml(product.instruction)}\n` : '';

    // Build message — keep customer content as code block (safer with HTML)
    const userMsg =
      `🎉 <b>Your Pre-Order is Ready!</b>\n\n` +
      `📦 <b>Order:</b> ${escapeHtml(product?.title || '')}\n` +
      `🔢 <b>Quantity:</b> ${pr.quantity}\n` +
      (pr.email ? `📧 ${escapeHtml(pr.email)}\n` : '') +
      `💵 ${formatPrice(pr.total_paid)}\n` +
      `📅 Delivered: ${dateStr}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🎁 <b>Your Product(s):</b>\n\n` +
      `<code>${escapeHtml(contentToSend)}</code>\n` +
      `━━━━━━━━━━━━━━━━━━━━${instr}\n` +
      `✨ Thank you for your patience!`;

    let sentOk = false;
    try {
      await bot.sendMessage(pr.user_id, userMsg, { parse_mode: 'HTML' });
      sentOk = true;
      logger.info(`[PREORDER SEND] ✅ Sent successfully to ${pr.user_id}`);
    } catch (err) {
      logger.error(`[PREORDER SEND ERROR] ${err.message} | trying without HTML...`);
      try {
        const plainMsg = userMsg.replace(/<\/?[^>]+>/g, '');
        await bot.sendMessage(pr.user_id, plainMsg);
        sentOk = true;
        logger.info(`[PREORDER SEND] ✅ Sent in plain mode`);
      } catch (err2) {
        logger.error(`[PREORDER SEND FATAL] ${err2.message}`);
      }
    }

    if (sentOk) {
      db.markPreorderDelivered(sendPreId, contentToSend);
      session.clear(userId);
      await bot.sendMessage(
        chatId,
        `✅ <b>Pre-Order #${sendPreId} Sent!</b>\n\nDelivered to <code>${pr.user_id}</code>.`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔙 Pre-Orders', callback_data: 'admin_preorders_list' }]] } }
      );
    } else {
      session.clear(userId);
      await bot.sendMessage(
        chatId,
        `⚠️ <b>Failed to send to user.</b>\n\nThe user (<code>${pr.user_id}</code>) may have blocked the bot or never started it.\n\nPre-order NOT marked as delivered. Try again or refund.`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔙 Pre-Orders', callback_data: 'admin_preorders_list' }]] } }
      );
    }
    return;
  }

  // ── Set Pre-Order Max Quantity ────────────────────────────────────
  if (s === States.ADMIN_PRE_SET_MAX) {
    const max = parseInt(text, 10);
    if (isNaN(max) || max < 0) {
      await bot.sendMessage(chatId, '❌ Enter a valid non-negative number.');
      return;
    }
    const { preProductId } = d;
    db.updateProduct(preProductId, 'preorder_max', max);
    session.clear(userId);
    const product = db.getProduct(preProductId);
    await bot.sendMessage(
      chatId,
      `✅ Max set to <b>${max}</b>.\n\n` +
      `⚙️ <b>Pre-Order: ${product.title}</b>\n` +
      `Status: ${product.preorder_enabled ? '✅ ENABLED' : '⚪ Disabled'}\n` +
      `Max: <b>${product.preorder_max}</b> | Reserved: <b>${product.preorder_count}</b>`,
      { parse_mode: 'HTML', reply_markup: adminPreorderSetupKb(preProductId, !!product.preorder_enabled) }
    );
    return;
  }

  // ── Set Display Order with smart auto-shift ───────────────────────
  if (s === States.ADMIN_SET_ORDER) {
    const newPos = parseInt(text, 10);
    if (isNaN(newPos) || newPos < 1) {
      await bot.sendMessage(chatId, '❌ Enter a valid positive number (e.g. 1, 2, 3).');
      return;
    }
    const { setOrderProductId } = d;

    // Step 1: get all products sorted by current display_order
    const all = db.getAllProductsForSorting();
    const total = all.length;
    const targetPos = Math.min(newPos, total); // clamp

    // Step 2: filter out the moving product and insert at targetPos - 1
    const moving = all.find((p) => p.id === setOrderProductId);
    const others = all.filter((p) => p.id !== setOrderProductId);
    others.splice(targetPos - 1, 0, moving);

    // Step 3: renumber everyone 1..N
    others.forEach((p, idx) => db.setDisplayOrder(p.id, idx + 1));

    session.clear(userId);
    const products = db.getAllProductsForSorting();
    await bot.sendMessage(
      chatId,
      `✅ <b>${moving.title}</b> moved to position <b>#${targetPos}</b>.\n` +
      `All other products auto-shifted.\n\n` +
      `↕️ <b>Sort Products</b> updated:`,
      { parse_mode: 'HTML', reply_markup: adminSortProductsKb(products) }
    );
    return;
  }

  // ── Refund flow ───────────────────────────────────────────────────
  // ── Search Order by ID (admin orders panel) ─────────────────────────────────
  if (s === 'ADMIN_SEARCH_ORDER') {
    const orderId = parseInt(text.trim(), 10);
    session.clear(userId);
    if (isNaN(orderId) || orderId <= 0) {
      await bot.sendMessage(chatId, '❌ Invalid order number. Please enter a number like <code>1672</code>.', { parse_mode: 'HTML' });
      return;
    }
    const order = db.getOrder(orderId);
    if (!order) {
      await bot.sendMessage(chatId,
        `❌ <b>Order #${orderId} not found.</b>\n\nPlease check the number and try again.`,
        { parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: '🔍 Search Again', callback_data: 'admin_orders_search' }, { text: '📋 All Orders', callback_data: 'admin_orders' }]] } }
      );
      return;
    }
    const statusEmoji = { pending: '⏳', delivered: '✅', cancelled: '❌', paid: '💰' };
    const payMap = { binance: '🟡 Binance Pay', wallet: '💰 Wallet', usdt: '💎 USDT', cryptobot: '🤖 CryptoBot', bep20: '💎 USDT BEP20', trc20: '💎 USDT TRC20' };
    const uname = order.username ? '@' + order.username : (order.first_name || `User ${order.user_id}`);
    let txt =
      `🔍 <b>Order #${orderId}</b>\n\n` +
      `${statusEmoji[order.status] || '❓'} <b>Status:</b> ${(order.status || '').toUpperCase()}\n` +
      `👤 <b>Customer:</b> ${escapeHtml(uname)} (<code>${order.user_id}</code>)\n` +
      `📦 <b>Product:</b> ${escapeHtml(order.product_title || 'N/A')}\n` +
      `🔢 <b>Qty:</b> ${order.quantity || 1}\n` +
      `💵 <b>Total:</b> $${Number(order.total_price || 0).toFixed(2)}\n` +
      `💳 <b>Payment:</b> ${payMap[order.payment_method] || order.payment_method || 'N/A'}\n` +
      `📅 <b>Created:</b> ${(order.created_at || '').slice(0, 16)}\n`;
    if (order.paid_at) txt += `✅ <b>Paid at:</b> ${(order.paid_at || '').slice(0, 16)}\n`;
    if (order.email) txt += `📧 <b>Email:</b> <code>${escapeHtml(order.email)}</code>\n`;
    if (order.delivered_content) {
      const preview = order.delivered_content.slice(0, 200);
      txt += `\n📦 <b>Delivered Content:</b>\n<code>${escapeHtml(preview)}${order.delivered_content.length > 200 ? '...' : ''}</code>`;
    }
    await bot.sendMessage(chatId, txt, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [
        [{ text: '🔍 Search Again', callback_data: 'admin_orders_search' }, { text: '📋 All Orders', callback_data: 'admin_orders' }],
      ]},
    });
    return;
  }

  if (s === States.ADMIN_REFUND_ORDER_ID) {
    const orderId = parseInt(text, 10);
    if (isNaN(orderId)) {
      await bot.sendMessage(chatId, '❌ Enter a valid Order ID (number only).');
      return;
    }
    const order = db.getOrder(orderId);
    if (!order) {
      await bot.sendMessage(chatId, `❌ Order #${orderId} not found.`, { reply_markup: adminBackKb() });
      session.clear(userId);
      return;
    }
    if (order.status !== 'delivered') {
      await bot.sendMessage(chatId, `❌ Order #${orderId} is not delivered (status: ${order.status}).`, { reply_markup: adminBackKb() });
      session.clear(userId);
      return;
    }
    const existing = db.getRefundByOrderId(orderId);
    if (existing) {
      await bot.sendMessage(chatId, `❌ Order #${orderId} was already refunded ($${existing.refund_amount.toFixed(2)}).`, { reply_markup: adminBackKb() });
      session.clear(userId);
      return;
    }
    session.set(userId, States.ADMIN_REFUND_END_DATE, { refundOrderId: orderId, order });
    await bot.sendMessage(
      chatId,
      `📋 <b>Order #${orderId} Found</b>\n\n` +
      `👤 User: <code>${order.user_id}</code>\n` +
      `📦 Product: ${order.product_title}\n` +
      `💵 Price: ${formatPrice(order.total_price)}\n` +
      `📅 Purchased: ${(order.created_at || '').slice(0, 16)}\n\n` +
      `📅 <b>Step 2:</b> Enter the subscription end date:\n` +
      `Format: <code>YYYY-MM-DD</code> (e.g. 2025-06-15)`,
      { parse_mode: 'HTML', reply_markup: adminBackKb() }
    );
    return;
  }

  if (s === States.ADMIN_REFUND_END_DATE) {
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(text.trim())) {
      await bot.sendMessage(chatId, '❌ Invalid format. Use <code>YYYY-MM-DD</code> (e.g. 2025-06-15)', { parse_mode: 'HTML' });
      return;
    }
    const endDate = new Date(text.trim());
    if (isNaN(endDate.getTime())) {
      await bot.sendMessage(chatId, '❌ Invalid date. Try again.');
      return;
    }
    session.update(userId, { refundEndDate: text.trim() });
    session.set(userId, States.ADMIN_REFUND_WARRANTY, session.get(userId).data);
    await bot.sendMessage(
      chatId,
      `✅ End date set: <b>${text.trim()}</b>\n\n` +
      `🛡 <b>Step 3:</b> Enter the <b>total warranty days</b>:\n` +
      `Example: <code>30</code>`,
      { parse_mode: 'HTML', reply_markup: adminBackKb() }
    );
    return;
  }

  if (s === States.ADMIN_REFUND_WARRANTY) {
    const warrantyDays = parseInt(text, 10);
    if (isNaN(warrantyDays) || warrantyDays < 1) {
      await bot.sendMessage(chatId, '❌ Enter a valid number of days (e.g. 30).');
      return;
    }
    const { refundOrderId, order, refundEndDate } = d;
    const today   = new Date(); today.setHours(0, 0, 0, 0);
    const endDate = new Date(refundEndDate); endDate.setHours(0, 0, 0, 0);
    const msPerDay      = 24 * 60 * 60 * 1000;
    const daysRemaining = Math.max(0, Math.round((endDate - today) / msPerDay));
    const refundAmount  = parseFloat(((daysRemaining / warrantyDays) * order.total_price).toFixed(2));
    session.update(userId, { warrantyDays, daysRemaining, refundAmount });
    await bot.sendMessage(
      chatId,
      `💸 <b>Refund Calculation</b>\n\n` +
      `📦 Order #${refundOrderId}\n` +
      `🛒 ${order.product_title}\n` +
      `💵 Original: ${formatPrice(order.total_price)}\n` +
      `🛡 Warranty Days: ${warrantyDays}\n` +
      `📅 End Date: ${refundEndDate}\n` +
      `⏳ Days Remaining: <b>${daysRemaining}</b>\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `💰 Refund: <b>${formatPrice(refundAmount)}</b>\n` +
      `Formula: (${daysRemaining} ÷ ${warrantyDays}) × ${formatPrice(order.total_price)}\n\n` +
      `Confirm to credit user's wallet?`,
      { parse_mode: 'HTML', reply_markup: adminRefundConfirmKb(refundOrderId) }
    );
    return;
  }
}

// ── Photo handler ─────────────────────────────────────────────────────────────

async function handleAdminPhoto(bot, msg) {
  if (!isAdmin(msg.from.id)) return;

  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const sess   = session.get(userId);

  if (sess.state === States.ADMIN_ADD_IMAGE) {
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    session.update(userId, { imageFileId: fileId });
    await askForInitialStock(bot, chatId, userId);
  } else if (sess.state === States.ADMIN_VIP_IMAGE) {
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    db.setSetting('vip_image_file_id', fileId);
    session.clear(userId);
    await bot.sendMessage(chatId, '✅ VIP image saved.', {
      reply_markup: { inline_keyboard: [[{ text: '🔙 VIP Panel', callback_data: 'admin_vip_toggle' }]] }
    });
    return;
  } else if (sess.state === States.ADMIN_EDIT_VALUE && sess.data.editField === 'image_file_id') {
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    db.updateProduct(sess.data.editProductId, 'image_file_id', fileId);
    session.clear(userId);
    await bot.sendMessage(chatId, '✅ Image updated!', { reply_markup: adminBackKb() });
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function askForInitialStock(bot, chatId, userId) {
  session.set(userId, States.ADMIN_ADD_STOCK, session.get(userId).data);
  await bot.sendMessage(
    chatId,
    '📦 <b>Add initial stock</b> (one item per line):\n\n' +
    '<code>email1@example.com:password1\nemail2@example.com:password2</code>\n\n' +
    'Or type <code>skip</code>.',
    { parse_mode: 'HTML', reply_markup: adminBackKb() }
  );
}

async function finalizeProduct(bot, chatId, userId, stockLines) {
  const d = session.get(userId).data;

  let stockAdded = 0;
  const productId = db.insertProduct({
    title:         d.title,
    description:   d.description,
    warranty:      d.warranty,
    price:         d.price,
    requiresEmail: d.requiresEmail ?? 1,
    imageFileId:   d.imageFileId || null,
    stockQuantity: 0,
    salesCount:    0,
  });

  // Save instruction if provided
  if (d.instruction) {
    db.updateProduct(productId, 'instruction', d.instruction);
  }

  if (stockLines.length > 0) {
    const { valid } = items.validateLines(stockLines.join('#'));
    if (valid.length > 0) {
      stockAdded = items.insertItems(productId, valid);
      db.setStockQuantity(productId, stockAdded);
    }
  }

  session.clear(userId);

  await bot.sendMessage(
    chatId,
    `✅ <b>Product Created!</b>\n\n🆔 ID: ${productId}\n📦 ${d.title}\n💵 ${formatPrice(d.price)}\n` +
    `📧 Email required: ${d.requiresEmail ? 'Yes' : 'No'}\n📦 Stock: ${stockAdded} items`,
    { parse_mode: 'HTML', reply_markup: adminBackKb() }
  );

  const notifEnabled = db.getSetting('product_notifications_enabled', '1');
  if (notifEnabled === '1' && stockAdded > 0) {
    const fresh = db.getProduct(productId);
    const botUserNp = await bot.getMe().catch(() => ({ username: '' }));
    const kbNp = { inline_keyboard: [[{ text: '🛒 Buy now', url: `https://t.me/${botUserNp.username}?start=p_${fresh.id}` }]] };
    await autoPublishWithPhoto(bot, fresh, buildNewProductText(fresh), kbNp);
  }
}

// ── Callback handler ──────────────────────────────────────────────────────────

async function handleAdminCallback(bot, query) {
  // ── Security: hard gate on every admin callback ───────────────────
  if (!isAdmin(query.from.id)) {
    await rejectNonAdmin(bot, query.id);
    return;
  }

  const data   = query.data || '';
  const userId = query.from.id;
  const chatId = query.message.chat.id;
  const msgId  = query.message.message_id;
  const answer = (text = '') => bot.answerCallbackQuery(query.id, { text }).catch(() => {});

  await answer();

  // ═══════════════════════════════════════════════════════════════════
  // V2 CALLBACKS — refund eligibility, delivery mode, stock alerts,
  // notification centre and manual-delivery management.
  // Placed first so they are matched before the older generic patterns.
  // ═══════════════════════════════════════════════════════════════════

  // ═══════════════════════════════════════════════════════════════════
  // V3 — DEPOSIT SECURITY: manual review queue + reversals
  // ═══════════════════════════════════════════════════════════════════

  if (data === 'admin_deposits' || /^admin_dep_list_[a-z]+_\d+$/.test(data)) {
    let status = 'pending', page = 0;
    if (data !== 'admin_deposits') {
      const parts = data.split('_');
      page   = parseInt(parts.pop(), 10) || 0;
      status = parts.slice(3).join('_');
    }
    const TABS = { pending: '🕐 Pending', approved: '✅ Approved', rejected: '❌ Rejected' };
    const safe = Object.prototype.hasOwnProperty.call(TABS, status) ? status : 'pending';

    const PER   = 8;
    const total = db.countDepositReviews(safe);
    const pages = Math.max(1, Math.ceil(total / PER));
    const pg    = Math.max(0, Math.min(page, pages - 1));
    const rows  = db.listDepositReviews(safe, PER, pg * PER);

    const txt =
      `🛡 <b>Deposit Review</b>\n\n` +
      `Deposits that could not be matched to a reservation are held here. ` +
      `They are <b>never</b> credited automatically.\n\n` +
      `🕐 Pending: <b>${db.countDepositReviews('pending')}</b>   ` +
      `✅ Approved: <b>${db.countDepositReviews('approved')}</b>   ` +
      `❌ Rejected: <b>${db.countDepositReviews('rejected')}</b>\n\n` +
      `<b>Showing:</b> ${TABS[safe]} — ${total} item(s)` +
      (rows.length ? '' : '\n\n<i>Nothing here.</i>');

    const kb = [Object.keys(TABS).map((k) => ({
      text: (k === safe ? '✓ ' : '') + TABS[k], callback_data: `admin_dep_list_${k}_0`,
    }))];
    for (const r of rows) {
      kb.push([{
        text: `#${r.id} · ${Number(r.amount).toFixed(2)} ${r.network || ''} · ${r.user_id}`,
        callback_data: `admin_dep_view_${r.id}`,
      }]);
    }
    if (pages > 1) {
      const nav = [];
      if (pg > 0)         nav.push({ text: '◀️ Prev', callback_data: `admin_dep_list_${safe}_${pg - 1}` });
      nav.push({ text: `${pg + 1}/${pages}`, callback_data: 'noop' });
      if (pg < pages - 1) nav.push({ text: 'Next ▶️', callback_data: `admin_dep_list_${safe}_${pg + 1}` });
      kb.push(nav);
    }
    kb.push([{ text: '↩️ Reverse a deposit', callback_data: 'admin_dep_reverse' }]);
    kb.push([{ text: '🔙 Back', callback_data: 'admin_panel' }]);

    try {
      await bot.editMessageText(txt, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: kb } });
    } catch (e) {
      await bot.sendMessage(chatId, txt, { parse_mode: 'HTML', reply_markup: { inline_keyboard: kb } });
    }
    return;
  }

  if (/^admin_dep_view_\d+$/.test(data)) {
    const id = parseInt(data.split('_').pop(), 10);
    const r  = db.getDepositReview(id);
    if (!r) { await answer('❌ Not found'); return; }

    const u   = db.getUser(r.user_id);
    const who = u?.username ? `@${u.username}` : (u?.first_name || `User ${r.user_id}`);
    const when = r.insert_time
      ? new Date(Number(r.insert_time)).toISOString().replace('T', ' ').slice(0, 16)
      : 'unknown';
    const ageMin = r.insert_time ? Math.round((Date.now() - Number(r.insert_time)) / 60000) : null;

    const REASONS = {
      no_matching_reservation: 'No reservation matched this amount',
      predates_reservation:    'Transfer is older than the reservation',
    };

    const txt =
      `🛡 <b>Deposit Review #${r.id}</b>\n\n` +
      `<b>Status:</b> ${String(r.status).toUpperCase()}\n` +
      `⚠️ <b>Reason:</b> ${REASONS[r.reason] || r.reason || 'n/a'}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `💵 <b>Amount:</b> ${Number(r.amount).toFixed(6)} USDT\n` +
      `🌐 <b>Network:</b> ${r.network || 'n/a'}\n` +
      `🔗 <b>TxID:</b>\n<code>${escapeHtml(r.txid)}</code>\n` +
      `📅 <b>On chain:</b> ${when} UTC` +
      (ageMin !== null ? ` (${ageMin} min ago)` : '') + `\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 <b>Claimed by:</b> ${escapeHtml(who)}\n` +
      `🆔 <code>${r.user_id}</code>\n` +
      (u ? `💰 <b>Balance:</b> ${formatPrice(u.balance || 0)}\n` : '') +
      `📝 <b>Submitted:</b> ${String(r.created_at || '').slice(0, 16)}\n` +
      (r.admin_note ? `\n📌 <i>${escapeHtml(r.admin_note)}</i>\n` : '') +
      `\n<i>Approve only if you are sure this transfer really belongs to this user.</i>`;

    const kb = [];
    if (r.status === 'pending') {
      kb.push([{ text: '✅ Approve & credit', callback_data: `admin_dep_ok_${r.id}` }]);
      kb.push([{ text: '❌ Reject',           callback_data: `admin_dep_no_${r.id}` }]);
    }
    kb.push([{ text: '🔙 Back', callback_data: 'admin_deposits' }]);

    try {
      await bot.editMessageText(txt, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: kb } });
    } catch (e) {
      await bot.sendMessage(chatId, txt, { parse_mode: 'HTML', reply_markup: { inline_keyboard: kb } });
    }
    return;
  }

  if (/^admin_dep_ok_\d+$/.test(data)) {
    const id = parseInt(data.split('_').pop(), 10);
    const r  = db.getDepositReview(id);
    if (!r || r.status !== 'pending') { await answer('❌ Already handled'); return; }

    // saveUsedTxid throws on a duplicate — that is the replay guard.
    try {
      db.saveUsedTxid({
        txid: r.txid, userId: r.user_id, amount: r.amount,
        network: r.network, asset: 'USDT', address: r.address || null,
      });
    } catch (e) {
      db.resolveDepositReview(id, 'rejected', 'TxID already credited', userId);
      await answer('❌ This TxID was already credited');
      return await handleAdminCallback(bot, { ...query, data: `admin_dep_view_${id}` });
    }

    db.updateBalance(r.user_id, Number(r.amount));
    db.addTransaction({
      userId: r.user_id, type: 'deposit', amount: Number(r.amount),
      description: `USDT ${r.network} top-up (manually approved)`,
      refId: r.txid, orderId: null,
    });
    db.resolveDepositReview(id, 'approved', `Approved by admin ${userId}`, userId);
    logger.info(`Admin ${userId} APPROVED deposit review #${id} — ${r.amount} to user ${r.user_id}`);

    try {
      const fresh = db.getUser(r.user_id);
      await bot.sendMessage(r.user_id,
        `✅ <b>Deposit Credited</b>\n\n` +
        `💵 <b>${Number(r.amount).toFixed(6)} USDT</b> has been added to your wallet after review.\n` +
        `💰 <b>New balance:</b> ${formatPrice(fresh?.balance || 0)}`,
        { parse_mode: 'HTML' });
    } catch (e) { /* user may have blocked the bot */ }

    await answer('✅ Credited');
    return await handleAdminCallback(bot, { ...query, data: `admin_dep_view_${id}` });
  }

  if (/^admin_dep_no_\d+$/.test(data)) {
    const id = parseInt(data.split('_').pop(), 10);
    db.resolveDepositReview(id, 'rejected', `Rejected by admin ${userId}`, userId);
    logger.info(`Admin ${userId} REJECTED deposit review #${id}`);
    await answer('❌ Rejected');
    return await handleAdminCallback(bot, { ...query, data: `admin_dep_view_${id}` });
  }

  if (data === 'admin_dep_reverse') {
    session.set(userId, States.ADMIN_DEP_REVERSE, {});
    await bot.editMessageText(
      `↩️ <b>Reverse a Deposit</b>\n\n` +
      `Send: <code>USER_ID AMOUNT [reason]</code>\n\n` +
      `Example:\n<code>354712964 1117.7303 stolen TxID</code>\n\n` +
      `The amount is removed from the wallet and written to the audit log. ` +
      `The balance may go negative — if the money was already spent, the debt ` +
      `stays visible instead of disappearing.`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🔙 Cancel', callback_data: 'admin_deposits' }]] } }
    ).catch(() => {});
    return;
  }

  // ── Toggle refund eligibility for a product ───────────────────────
  if (/^admin_toggle_refund_\d+$/.test(data)) {
    const productId = parseInt(data.split('_').pop(), 10);
    const product   = db.getProduct(productId);
    if (!product) { await answer('❌ Product not found'); return; }
    const newVal = Number(product.refund_enabled) === 1 ? 0 : 1;
    db.updateProduct(productId, 'refund_enabled', newVal);
    logger.info(`Admin ${userId} set refund_enabled=${newVal} on product #${productId}`);

    await bot.editMessageText(
      `🔄 <b>Refund Eligibility</b>\n\n` +
      `📦 ${escapeHtml(product.title || '')}\n\n` +
      `Status: ${newVal ? '✅ <b>ELIGIBLE</b> — customers can request a refund'
                        : '🚫 <b>NOT ELIGIBLE</b> — refund requests are blocked'}\n\n` +
      `<i>Blocked products are hidden from the customer's refund list, and the ` +
      `server rejects any request for them even if the button is forged.</i>`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [
          [{ text: newVal ? '🚫 Disable refunds' : '✅ Enable refunds', callback_data: `admin_toggle_refund_${productId}` }],
          [{ text: '🔙 Back to product', callback_data: `admin_edit_p_${productId}` }],
        ] } }
    ).catch(() => {});
    return;
  }

  // ── Toggle automatic / manual delivery ────────────────────────────
  if (/^admin_toggle_delivery_\d+$/.test(data)) {
    const productId = parseInt(data.split('_').pop(), 10);
    const product   = db.getProduct(productId);
    if (!product) { await answer('❌ Product not found'); return; }
    const isManual = product.delivery_type === 'manual';
    const newVal   = isManual ? 'auto' : 'manual';
    require('../database/db').prepare('UPDATE products SET delivery_type = ? WHERE id = ?')
      .run(newVal, productId);
    logger.info(`Admin ${userId} set delivery_type=${newVal} on product #${productId}`);

    await bot.editMessageText(
      `🚚 <b>Delivery Method</b>\n\n` +
      `📦 ${escapeHtml(product.title || '')}\n\n` +
      (newVal === 'manual'
        ? `Mode: 🖐 <b>MANUAL</b>\n\n` +
          `After a successful payment the stock is NOT handed out automatically. ` +
          `A task is opened under 📦 Manual Delivery and you deliver it yourself. ` +
          `The customer is told their order is queued.`
        : `Mode: ⚡ <b>AUTOMATIC</b>\n\n` +
          `Stock items are delivered instantly the moment payment succeeds.`),
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [
          [{ text: newVal === 'manual' ? '⚡ Switch to automatic' : '🖐 Switch to manual',
             callback_data: `admin_toggle_delivery_${productId}` }],
          [{ text: '🔙 Back to product', callback_data: `admin_edit_p_${productId}` }],
        ] } }
    ).catch(() => {});
    return;
  }

  // ── Per-product low-stock threshold ───────────────────────────────
  if (/^admin_lowstock_\d+$/.test(data)) {
    const productId = parseInt(data.split('_').pop(), 10);
    const product   = db.getProduct(productId);
    if (!product) { await answer('❌ Product not found'); return; }
    const globalDefault = db.getSetting('low_stock_threshold_default', '5');
    session.set(userId, States.ADMIN_LOW_STOCK, { lowStockProductId: productId });

    await bot.editMessageText(
      `🔔 <b>Low-Stock Alert Threshold</b>\n\n` +
      `📦 ${escapeHtml(product.title || '')}\n` +
      `📊 Current stock: <b>${product.stock_quantity || 0}</b>\n\n` +
      `Current threshold: <b>${Number(product.low_stock_threshold) > 0
        ? product.low_stock_threshold
        : `${globalDefault} (global default)`}</b>\n\n` +
      `Send the number of units at which you want to be warned.\n` +
      `Send <code>0</code> to fall back to the global default.`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🔙 Cancel', callback_data: `admin_edit_p_${productId}` }]] } }
    ).catch(() => {});
    return;
  }

  // ── Notification centre ───────────────────────────────────────────
  if (data === 'admin_notifications' || /^admin_notif_(all|unread)_\d+$/.test(data)) {
    let mode = 'unread';
    let page = 0;
    if (/^admin_notif_(all|unread)_\d+$/.test(data)) {
      const parts = data.split('_');
      page = parseInt(parts.pop(), 10) || 0;
      mode = parts[2];
    }

    const PER = 8;
    const unreadOnly = mode === 'unread';
    const total  = unreadOnly ? db.countUnreadNotifications() : db.countAdminNotifications();
    const totalPages = Math.max(1, Math.ceil(total / PER));
    const safePage   = Math.max(0, Math.min(page, totalPages - 1));
    const rows = db.getAdminNotifications(PER, safePage * PER, unreadOnly);

    const unreadCount = db.countUnreadNotifications();
    const icons = { manual_delivery: '📦', stock_out: '🔴', stock_low: '🟠',
                    refund_request: '🔄', support_message: '💬' };

    let txt =
      `🔔 <b>Notifications</b>\n\n` +
      `🔴 Unread: <b>${unreadCount}</b>   📋 Total: <b>${db.countAdminNotifications()}</b>\n` +
      `<b>Showing:</b> ${unreadOnly ? '🔴 Unread only' : '📋 All'} — ${total} item(s)\n`;

    if (!rows.length) txt += `\n<i>Nothing here.</i>`;

    const kb = [[
      { text: (unreadOnly ? '✓ ' : '') + '🔴 Unread', callback_data: 'admin_notif_unread_0' },
      { text: (!unreadOnly ? '✓ ' : '') + '📋 All',   callback_data: 'admin_notif_all_0' },
    ]];

    for (const n of rows) {
      const dot = n.is_read ? '' : '🔴 ';
      const when = String(n.created_at || '').slice(5, 16).replace('-', '/');
      kb.push([{
        text: `${dot}${icons[n.type] || '🔔'} ${String(n.title).slice(0, 30)} · ${when}`,
        callback_data: `admin_notif_view_${n.id}`,
      }]);
    }

    if (totalPages > 1) {
      const nav = [];
      if (safePage > 0)              nav.push({ text: '◀️ Prev', callback_data: `admin_notif_${mode}_${safePage - 1}` });
      nav.push({ text: `${safePage + 1}/${totalPages}`, callback_data: 'noop' });
      if (safePage < totalPages - 1) nav.push({ text: 'Next ▶️', callback_data: `admin_notif_${mode}_${safePage + 1}` });
      kb.push(nav);
    }

    if (unreadCount > 0) kb.push([{ text: '✅ Mark all as read', callback_data: 'admin_notif_readall' }]);
    kb.push([{ text: '🔙 Back', callback_data: 'admin_panel' }]);

    try {
      await bot.editMessageText(txt, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: kb } });
    } catch (e) {
      await bot.sendMessage(chatId, txt, { parse_mode: 'HTML', reply_markup: { inline_keyboard: kb } });
    }
    return;
  }

  if (/^admin_notif_view_\d+$/.test(data)) {
    const id = parseInt(data.split('_').pop(), 10);
    const n  = db.getAdminNotification(id);
    if (!n) { await answer('❌ Not found'); return; }

    // Opening a notification is what marks it read.
    db.markNotificationRead(id);

    const icons = { manual_delivery: '📦', stock_out: '🔴', stock_low: '🟠',
                    refund_request: '🔄', support_message: '💬' };

    // Deep link back to whatever the notification is about.
    const jump = [];
    if (n.ref_type === 'manual_delivery') jump.push([{ text: '📦 Open task',    callback_data: `admin_md_view_${n.ref_id}` }]);
    if (n.ref_type === 'refund_request')  jump.push([{ text: '🔄 Open request', callback_data: `admin_refund_view_${n.ref_id}` }]);
    if (n.ref_type === 'product')         jump.push([{ text: '📦 Manage stock', callback_data: `admin_stock_select_p_${n.ref_id}` }]);

    const txt =
      `${icons[n.type] || '🔔'} <b>${escapeHtml(n.title)}</b>\n` +
      `🕒 ${String(n.created_at || '').slice(0, 16)}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `${n.body || '<i>(no details)</i>'}`;

    await bot.editMessageText(txt, {
      chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [...jump, [{ text: '🔙 Notifications', callback_data: 'admin_notifications' }]] },
    }).catch(async () => {
      await bot.sendMessage(chatId, txt, { parse_mode: 'HTML' });
    });
    return;
  }

  if (data === 'admin_notif_readall') {
    const n = db.markAllNotificationsRead();
    await answer(`✅ ${n} marked as read`);
    return await handleAdminCallback(bot, { ...query, data: 'admin_notifications' });
  }

  // ── Manual delivery management (mirrors the Support Bot panel) ─────
  if (/^admin_md_list_[a-z]+_\d+$/.test(data)) {
    const parts  = data.split('_');
    const page   = parseInt(parts.pop(), 10) || 0;
    const status = parts.slice(3).join('_');
    const TABS = { pending: '🕐 Waiting', processing: '⚙️ In progress',
                   delivered: '✅ Delivered', cancelled: '❌ Cancelled', all: '📋 All' };
    const safeStatus = Object.prototype.hasOwnProperty.call(TABS, status) ? status : 'pending';

    const counts = db.getManualDeliveryCounts();
    let rows = db.getAllManualDeliveries();
    if (safeStatus !== 'all') rows = rows.filter((r) => r.status === safeStatus);

    const PER = 8;
    const totalPages = Math.max(1, Math.ceil(rows.length / PER));
    const safePage   = Math.max(0, Math.min(page, totalPages - 1));
    const slice = rows.slice(safePage * PER, (safePage + 1) * PER);

    const txt =
      `📦 <b>Manual Delivery Requests</b>\n\n` +
      `🕐 Waiting: <b>${counts.pending}</b>   ⚙️ In progress: <b>${counts.processing}</b>\n` +
      `✅ Delivered: <b>${counts.delivered}</b>   ❌ Cancelled: <b>${counts.cancelled}</b>\n` +
      (counts.unseen ? `\n🆕 <b>${counts.unseen}</b> new request(s)\n` : '') +
      `\n<b>Showing:</b> ${TABS[safeStatus]} — ${rows.length} result(s)`;

    const kb = [];
    const chip = (k) => ({ text: (k === safeStatus ? '✓ ' : '') + TABS[k], callback_data: `admin_md_list_${k}_0` });
    kb.push(['pending', 'processing'].map(chip));
    kb.push(['delivered', 'cancelled'].map(chip));
    kb.push([chip('all')]);

    for (const r of slice) {
      const isNew = (!r.seen_at && r.status === 'pending') ? '🆕 ' : '';
      const who = r.username ? `@${r.username}` : (r.first_name || `User ${r.user_id}`);
      const title = String(r.product_title || '').replace(/\[emoji:\d+\]/g, '').trim().slice(0, 16);
      kb.push([{ text: `${isNew}#${r.id} · ${who.slice(0, 12)} · ${title} ×${r.quantity}`,
                 callback_data: `admin_md_view_${r.id}` }]);
    }

    if (totalPages > 1) {
      const nav = [];
      if (safePage > 0)              nav.push({ text: '◀️ Prev', callback_data: `admin_md_list_${safeStatus}_${safePage - 1}` });
      nav.push({ text: `${safePage + 1}/${totalPages}`, callback_data: 'noop' });
      if (safePage < totalPages - 1) nav.push({ text: 'Next ▶️', callback_data: `admin_md_list_${safeStatus}_${safePage + 1}` });
      kb.push(nav);
    }
    kb.push([{ text: '🔙 Back', callback_data: 'admin_panel' }]);

    try {
      await bot.editMessageText(txt, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: kb } });
    } catch (e) {
      await bot.sendMessage(chatId, txt, { parse_mode: 'HTML', reply_markup: { inline_keyboard: kb } });
    }
    return;
  }

  if (/^admin_md_view_\d+$/.test(data)) {
    const id = parseInt(data.split('_').pop(), 10);
    const t  = db.getManualDelivery(id);
    if (!t) { await answer('❌ Not found'); return; }
    db.markManualSeen(id);

    const manualDelivery = require('./manualDelivery');
    const who  = t.username ? `@${t.username}` : (t.first_name || `User ${t.user_id}`);
    const user = db.getUser(t.user_id);

    const txt =
      `📦 <b>Manual Delivery #${t.id}</b>\n\n` +
      `<b>Status:</b> ${manualDelivery.STATUS_LABEL[t.status] || t.status}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🆔 <b>Order:</b> #${t.order_id}\n` +
      `🛒 <b>Product:</b> ${manualDelivery.cleanTitle(t.product_title)}\n` +
      `🔢 <b>Quantity:</b> ${t.quantity}\n` +
      (t.email ? `📧 <b>Email:</b> <code>${escapeHtml(t.email)}</code>\n` : '') +
      `💵 <b>Paid:</b> ${formatPrice(t.total_paid)}\n` +
      `💳 <b>Method:</b> ${escapeHtml(t.payment_method || 'n/a')}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 <b>Customer:</b> ${escapeHtml(who)}\n` +
      `🆔 <code>${t.user_id}</code>\n` +
      (user ? `💰 <b>Wallet:</b> ${formatPrice(user.balance || 0)}\n` : '') +
      `📅 <b>Created:</b> ${String(t.created_at || '').slice(0, 16)}\n` +
      (t.delivered_at ? `✅ <b>Delivered:</b> ${String(t.delivered_at).slice(0, 16)}\n` : '') +
      (t.admin_note ? `\n📝 <i>${escapeHtml(t.admin_note)}</i>\n` : '') +
      (t.delivered_content
        ? `\n🎁 <b>Content sent:</b>\n<code>${escapeHtml(String(t.delivered_content).slice(0, 500))}</code>\n`
        : '');

    const kb = [];
    if (t.status === 'pending' || t.status === 'processing') {
      if (t.status === 'pending') kb.push([{ text: '⚙️ Mark as in progress', callback_data: `admin_md_proc_${t.id}` }]);
      kb.push([{ text: '✅ Deliver now (send content)', callback_data: `admin_md_deliver_${t.id}` }]);
      kb.push([{ text: '☑️ Mark delivered (no content)', callback_data: `admin_md_done_${t.id}` }]);
      kb.push([{ text: '❌ Cancel & refund', callback_data: `admin_md_cancel_${t.id}` }]);
    }
    kb.push([{ text: '🔙 Back to list', callback_data: `admin_md_list_${t.status}_0` }]);

    try {
      await bot.editMessageText(txt, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: kb } });
    } catch (e) {
      await bot.sendMessage(chatId, txt, { parse_mode: 'HTML', reply_markup: { inline_keyboard: kb } });
    }
    return;
  }

  if (/^admin_md_proc_\d+$/.test(data)) {
    const id = parseInt(data.split('_').pop(), 10);
    db.setManualDeliveryStatus(id, 'processing', 'Marked in progress');
    await answer('⚙️ In progress');
    return await handleAdminCallback(bot, { ...query, data: `admin_md_view_${id}` });
  }

  if (/^admin_md_deliver_\d+$/.test(data)) {
    const id = parseInt(data.split('_').pop(), 10);
    const t  = db.getManualDelivery(id);
    if (!t) { await answer('❌ Not found'); return; }
    session.set(userId, States.ADMIN_MD_CONTENT, { mdTaskId: id });
    await bot.editMessageText(
      `✍️ <b>Deliver Task #${id}</b>\n\n` +
      `👤 <code>${t.user_id}</code>\n` +
      `📦 ${escapeHtml(String(t.product_title || ''))} ×${t.quantity}\n` +
      (t.email ? `📧 <code>${escapeHtml(t.email)}</code>\n` : '') +
      `\nSend the content to deliver to the customer.\n` +
      `<i>Your next message is forwarded to them and the task is closed.</i>`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🔙 Cancel', callback_data: `admin_md_view_${id}` }]] } }
    ).catch(() => {});
    return;
  }

  if (/^admin_md_done_\d+$/.test(data)) {
    const id = parseInt(data.split('_').pop(), 10);
    const manualDelivery = require('./manualDelivery');
    const res = await manualDelivery.completeManualDelivery(bot, id, null);
    await answer(res.ok ? '✅ Delivered' : `⚠️ ${res.reason}`);
    return await handleAdminCallback(bot, { ...query, data: `admin_md_view_${id}` });
  }

  if (/^admin_md_cancel_\d+$/.test(data)) {
    const id = parseInt(data.split('_').pop(), 10);
    const manualDelivery = require('./manualDelivery');
    const res = await manualDelivery.cancelManualDelivery(bot, id, 'Cancelled by admin');
    await answer(res.ok ? '❌ Cancelled & refunded' : `⚠️ ${res.reason}`);
    return await handleAdminCallback(bot, { ...query, data: `admin_md_view_${id}` });
  }

  // ── Requires-email step ───────────────────────────────────────────
  if (data === 'req_email_yes' || data === 'req_email_no') {
    session.update(userId, { requiresEmail: data === 'req_email_yes' ? 1 : 0 });
    session.set(userId, States.ADMIN_ADD_INSTRUCTION, session.get(userId).data);
    await bot.editMessageText(
      'Step 6/8\n\n📋 <b>Enter the Instruction for this product</b>\n' +
      '(Shown to the customer after purchase. Type <code>skip</code> to leave empty.)',
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: adminBackKb() }
    );
    return;
  }

  // ── Product lists ─────────────────────────────────────────────────
  if (data === 'admin_edit_product') {
    const products = db.getAllActiveProducts();
    await bot.editMessageText('✏️ <b>Select product to edit:</b>', {
      chat_id: chatId, message_id: msgId,
      parse_mode: 'HTML', reply_markup: adminProductsKb(products, 'edit'),
    });
    return;
  }
  if (data === 'admin_delete_product') {
    const products = db.getAllActiveProducts();
    await bot.editMessageText('🗑 <b>Select product to delete:</b>', {
      chat_id: chatId, message_id: msgId,
      parse_mode: 'HTML', reply_markup: adminProductsKb(products, 'delete'),
    });
    return;
  }

  // ── Edit product — select ─────────────────────────────────────────
  if (/^admin_edit_p_\d+$/.test(data)) {
    const productId = parseInt(data.split('_').pop(), 10);
    const product   = db.getProduct(productId);
    const stockQty  = product?.stock_quantity || 0;
    const statusLine = stockQty === 0 ? '❌ <b>OUT OF STOCK</b>' : '✅ <b>IN STOCK</b>';
    const bulkInfo  = (product?.bulk_min_qty > 0 && product?.bulk_discount > 0)
      ? `🎁 <b>Bulk:</b> ${product.bulk_min_qty}+ → ${product.bulk_discount}% off\n`
      : `🎁 <b>Bulk:</b> Disabled\n`;
    const refundInfo   = Number(product?.refund_enabled) === 1
      ? '🔄 <b>Refunds:</b> ✅ Allowed\n'
      : '🔄 <b>Refunds:</b> 🚫 Blocked\n';
    const deliveryInfo = product?.delivery_type === 'manual'
      ? '🚚 <b>Delivery:</b> 🖐 Manual\n'
      : '🚚 <b>Delivery:</b> ⚡ Automatic\n';
    const lowInfo = `🔔 <b>Low-stock alert at:</b> ${
      Number(product?.low_stock_threshold) > 0
        ? product.low_stock_threshold
        : db.getSetting('low_stock_threshold_default', '5') + ' (default)'}\n`;
    await bot.editMessageText(
      `✏️ <b>Edit Product:</b> ${product?.title}\n\n` +
      `📦 <b>Stock qty:</b> ${stockQty}   📈 <b>Sales:</b> ${product?.sales_count || 0}\n` +
      bulkInfo + refundInfo + deliveryInfo + lowInfo +
      `${statusLine}\n\n` +
      `Select a field to edit or manage stock:`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: adminProductEditFieldsKb(productId) }
    );
    return;
  }

  // ── Edit product — field selected ─────────────────────────────────
  if (/^admin_edit_field_\d+_/.test(data)) {
    const parts     = data.split('_');
    const field     = parts.slice(4).join('_');
    const productId = parseInt(parts[3], 10);

    const prompts = {
      title:          'Enter new title:',
      description:    'Enter new description:',
      price:          'Enter new price (e.g. 14.09):',
      cost_price:     'Enter the cost price (what YOU paid per unit, e.g. 5.50).\nThis is used to calculate net profit.',
      premium_emoji_id: '💎 Enter the Premium Emoji ID.\n\n' +
        '🔍 How to get one:\n' +
        '1. Open @emojiidbot or @stickerinfoBot in Telegram\n' +
        '2. Send a premium emoji\n' +
        '3. Copy the numeric ID (e.g. 5368324170671202286)\n\n' +
        'Type <code>clear</code> to remove the premium emoji.',
      warranty:       'Enter new warranty:',
      instruction:    'Enter new instruction (shown to customer after purchase).\nType <code>clear</code> to remove it.',
      requires_email: 'Type <code>1</code> for Yes, <code>0</code> for No:',
      is_active:      'Type <code>1</code> to activate, <code>0</code> to deactivate:',
      stock_quantity: 'Enter new stock quantity (e.g. 50):',
      sales_count:    'Enter new sales count (e.g. 100):',
                  image_file_id:  'Send new product image:',
    };

    // Fetch current value of the field
    const currentProduct = db.getProduct(productId);
    let currentRaw = '';
    let displayLabel = '(empty)';
    if (currentProduct) {
      const raw = currentProduct[field];
      if (raw === null || raw === undefined || raw === '') {
        currentRaw = '';
        displayLabel = '(empty)';
      } else if (field === 'requires_email' || field === 'is_active') {
        currentRaw = String(raw);
        displayLabel = raw ? 'Yes (1)' : 'No (0)';
      } else if (field === 'image_file_id') {
        currentRaw = '';
        displayLabel = raw ? '(image already set)' : '(no image)';
      } else {
        currentRaw = String(raw);
        displayLabel = currentRaw;
      }
    }

    // Set up the edit state
    const keepKb = {
      inline_keyboard: [
        [{ text: '🎨 Choose Emoji from Library', callback_data: 'admin_emoji_picker' }],
        [{ text: '✋ Keep Current (no change)', callback_data: `admin_edit_p_${productId}` }],
        [{ text: '🔙 Back', callback_data: 'admin_panel' }],
      ],
    };

    if (field === 'sales_count') {
      session.set(userId, States.ADMIN_SALES_COUNT_SET, { editProductId: productId });
    } else {
      session.set(userId, States.ADMIN_EDIT_VALUE, { editProductId: productId, editField: field });
    }

    // Send the prompt message
    await bot.editMessageText(
      `✏️ <b>Editing: ${field}</b>\n\n` + (prompts[field] || 'Enter new value:'),
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: keepKb }
    );

    // Send the current value as a SEPARATE tap-to-copy message
    // This way admin can long-press to copy/edit it
    if (currentRaw && currentRaw.length > 0) {
      // Split into chunks if too long (Telegram max ~4000)
      const CHUNK = 3500;
      if (currentRaw.length <= CHUNK) {
        await bot.sendMessage(
          chatId,
          `📋 <b>Current value</b> (tap text below to copy):\n\n<code>${escapeHtml(currentRaw)}</code>`,
          { parse_mode: 'HTML' }
        );
      } else {
        await bot.sendMessage(
          chatId,
          `📋 <b>Current value</b> (long — split into parts, tap each to copy):`,
          { parse_mode: 'HTML' }
        );
        for (let i = 0; i < currentRaw.length; i += CHUNK) {
          const part = currentRaw.slice(i, i + CHUNK);
          await bot.sendMessage(
            chatId,
            `<code>${escapeHtml(part)}</code>`,
            { parse_mode: 'HTML' }
          );
        }
      }
    } else {
      await bot.sendMessage(
        chatId,
        `📋 <b>Current value:</b> <i>${displayLabel}</i>`,
        { parse_mode: 'HTML' }
      );
    }
    return;
  }

  // ── Bulk Pricing (by quantity) — overview screen ───────────────────
  if (/^admin_bulkprice_\d+$/.test(data)) {
    const productId = parseInt(data.split('_').pop(), 10);
    const product   = db.getProduct(productId);
    if (!product) { await answer('❌ Product not found.'); return; }

    const tierLines = [1, 2, 3].map((n) => {
      const qty   = product[`bulk_tier${n}_qty`];
      const price = product[`bulk_tier${n}_price`];
      if (qty > 0 && price > 0) {
        return `  • Tier ${n}: <b>${qty}+ pcs</b> → <b>$${Number(price).toFixed(2)}</b> each`;
      }
      return `  • Tier ${n}: <i>not set</i>`;
    }).join('\n');

    await bot.editMessageText(
      `📊 <b>Bulk Pricing — ${escapeHtml(product.title || '')}</b>\n\n` +
      `Base price (1 pc): <b>${formatPrice(product.price)}</b>\n\n` +
      `${tierLines}\n\n` +
      `Tap a tier below to set or change it. Each tier needs a <b>minimum quantity</b> and a <b>price per piece</b> — once the customer reaches that quantity, every piece in the order is charged at that tier's price.`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: adminBulkPriceKb(product) }
    );
    return;
  }

  // ── Bulk Pricing — edit one tier (combined qty + price prompt) ─────
  if (/^admin_bulkprice_edit_\d+_[123]$/.test(data)) {
    const parts     = data.split('_');
    const productId = parseInt(parts[3], 10);
    const tierNum   = parseInt(parts[4], 10);
    const product   = db.getProduct(productId);
    if (!product) { await answer('❌ Product not found.'); return; }

    const curQty   = product[`bulk_tier${tierNum}_qty`]   || 0;
    const curPrice = product[`bulk_tier${tierNum}_price`] || 0;
    const curLine  = (curQty > 0 && curPrice > 0)
      ? `\n📋 <b>Current:</b> ${curQty}+ pcs → $${Number(curPrice).toFixed(2)} each`
      : '';

    session.set(userId, States.ADMIN_BULK_TIER_VALUE, { bulkProductId: productId, bulkTierNum: tierNum });

    await bot.editMessageText(
      `📊 <b>Tier ${tierNum} — ${escapeHtml(product.title || '')}</b>\n\n` +
      `Send the <b>minimum quantity</b> and the <b>price per piece</b> for this tier, separated by a space.\n\n` +
      `<b>Example:</b> <code>20 0.80</code>\n` +
      `(means: starting at 20 pcs, each piece costs $0.80)` +
      curLine,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: `admin_bulkprice_${productId}` }]] } }
    );
    return;
  }

  // ── Bulk Pricing — clear one tier ───────────────────────────────────
  if (/^admin_bulkprice_clear_\d+_[123]$/.test(data)) {
    const parts     = data.split('_');
    const productId = parseInt(parts[3], 10);
    const tierNum   = parseInt(parts[4], 10);
    const product   = db.getProduct(productId);
    if (!product) { await answer('❌ Product not found.'); return; }

    db.updateProduct(productId, `bulk_tier${tierNum}_qty`, 0);
    db.updateProduct(productId, `bulk_tier${tierNum}_price`, 0);

    await answer(`✅ Tier ${tierNum} cleared.`);
    const fresh = db.getProduct(productId);
    await bot.editMessageText(
      `📊 <b>Bulk Pricing — ${escapeHtml(fresh.title || '')}</b>\n\n` +
      `Tier ${tierNum} has been cleared.`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: adminBulkPriceKb(fresh) }
    );
    return;
  }

  // ── Delete product ────────────────────────────────────────────────
  if (/^admin_delete_p_\d+$/.test(data)) {
    const productId = parseInt(data.split('_').pop(), 10);
    const product   = db.getProduct(productId);
    await bot.editMessageText(
      `⚠️ <b>Delete:</b> ${product?.title}?\n\nThis cannot be undone.`,
      {
        chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: adminConfirmKb(`admin_confirm_delete_${productId}`, 'admin_delete_product'),
      }
    );
    return;
  }
  if (/^admin_confirm_delete_\d+$/.test(data)) {
    const productId = parseInt(data.split('_').pop(), 10);
    db.softDeleteProduct(productId);
    await bot.editMessageText('✅ Product deleted.', {
      chat_id: chatId, message_id: msgId, reply_markup: adminBackKb(),
    });
    return;
  }

  // ── Stock management ──────────────────────────────────────────────
  if (data === 'admin_stock') {
    const products = db.getAllActiveProducts();
    await bot.editMessageText('📦 <b>Stock Management</b>\n\nSelect product:', {
      chat_id: chatId, message_id: msgId,
      parse_mode: 'HTML', reply_markup: adminProductsKb(products, 'stock_select'),
    });
    return;
  }
  if (/^admin_stock_select_p_\d+$/.test(data)) {
    const productId  = parseInt(data.split('_').pop(), 10);
    const product    = db.getProduct(productId);
    const itemStats  = items.getItemStats(productId);
    const stockQty   = product?.stock_quantity || 0;
    const statusLine = stockQty === 0
      ? '❌ <b>OUT OF STOCK</b>'
      : '✅ <b>IN STOCK</b>';

    await bot.editMessageText(
      `📦 <b>${product.title}</b>\n\n` +
      `💵 Price: <b>${formatPrice(product.price)}</b>\n` +
      `${statusLine}\n` +
      `📊 Stock quantity: <b>${stockQty}</b>\n` +
      `📋 Available items: <b>${itemStats.available}</b>\n` +
      `📈 Sales count: <b>${product.sales_count || 0}</b>`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: adminStockManageKb(productId) }
    );
    return;
  }

  // ── Add stock items (product_items) ──────────────────────────────
  if (/^admin_stock_add_\d+$/.test(data)) {
    const productId = parseInt(data.split('_').pop(), 10);
    const product   = db.getProduct(productId);
    session.set(userId, States.ADMIN_STOCK_DATA, { stockProductId: productId });

    const instructions =
      `📦 <b>Add Stock Items — ${product.title}</b>\n\n` +
      `Separate items using <b>AYMEN</b>:\n` +
      `<code>item1AYMENitem2AYMENitem3</code>\n\n` +
      `Each item can be anything (key, account, code, url, etc.).\n` +
      `Example:\n` +
      `<code>user1@mail.com:pass1AYMENuser2@mail.com:pass2</code>\n` +
      `<code>KEY-AAAA-1111AYMENKEY-BBBB-2222</code>`;

    await bot.editMessageText(instructions, {
      chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: backToProductEditKb(productId),
    });
    return;
  }

  // ── Large Stock Upload — multi-message batch mode ─────────────────
  // Allows uploading thousands of items across multiple messages,
  // bypassing Telegram's 4096-character per-message limit.
  // Admin sends batches one by one; types DONE when finished.
  if (/^admin_stock_batch_\d+$/.test(data)) {
    const productId = parseInt(data.split('_').pop(), 10);
    const product   = db.getProduct(productId);
    if (!product) { await answer('❌ Product not found.'); return; }

    session.set(userId, States.ADMIN_STOCK_BATCH, {
      stockProductId: productId,
      batchItems: [],      // accumulated items across messages
      batchCount: 0,       // number of messages received so far
    });

    await bot.editMessageText(
      `📤 <b>Large Stock Upload — ${escapeHtml(product.title)}</b>\n\n` +
      `Send your items in <b>multiple messages</b> — each message can contain as many items as you want (up to Telegram's limit of 4096 chars).\n\n` +
      `Separate items within each message using <b>AYMEN</b>:\n` +
      `<code>item1AYMENitem2AYMENitem3</code>\n\n` +
      `When you've sent all batches, type <code>DONE</code> to save everything.\n` +
      `To cancel, type <code>CANCEL</code>.\n\n` +
      `📊 <b>Current stock:</b> ${product.stock_quantity}`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: `admin_stock_select_p_${productId}` }]] } }
    );
    return;
  }

  // ── Remove from stock_quantity ───────────────────────────────────
  if (/^admin_stock_removeqty_\d+$/.test(data)) {
    const productId = parseInt(data.split('_').pop(), 10);
    const product   = db.getProduct(productId);
    session.set(userId, States.ADMIN_STOCK_REMOVE_QTY, { stockProductId: productId });
    await bot.editMessageText(
      `➖ <b>Remove Quantity</b>\n\n` +
      `Product: <b>${product.title}</b>\n` +
      `Current quantity: <b>${product.stock_quantity || 0}</b>\n\n` +
      `Enter quantity to remove (e.g. 20):\n` +
      `<i>Example: current=100, remove=20 → new=80</i>\n` +
      `<i>Stock will never go below 0.</i>`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: backToProductEditKb(productId) }
    );
    return;
  }

  // ── Set stock_quantity manually ───────────────────────────────────
  if (/^admin_stock_setqty_\d+$/.test(data)) {
    const productId = parseInt(data.split('_').pop(), 10);
    const product   = db.getProduct(productId);
    session.set(userId, States.ADMIN_STOCK_SET_QTY, { stockProductId: productId });
    await bot.editMessageText(
      `✏️ <b>Set Stock Manually</b>\n\n` +
      `Product: <b>${product.title}</b>\n` +
      `Current quantity: <b>${product.stock_quantity || 0}</b>\n\n` +
      `Enter the <b>exact</b> new stock quantity (replaces current value):\n` +
      `<i>Example: current=5, set=100 → new=100</i>`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: backToProductEditKb(productId) }
    );
    return;
  }

  // ── Set stock to 0 (with confirmation) ───────────────────────────
  if (/^admin_stock_zero_\d+$/.test(data)) {
    const productId = parseInt(data.split('_').pop(), 10);
    const product   = db.getProduct(productId);
    await bot.editMessageText(
      `🔄 <b>Set Stock to 0</b>\n\n` +
      `Product: <b>${product.title}</b>\n` +
      `Current stock: <b>${product.stock_quantity || 0}</b>\n\n` +
      `⚠️ Are you sure you want to set this product stock to 0?`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: confirmZeroStockKb(productId) }
    );
    return;
  }
  if (/^admin_stock_zero_confirm_\d+$/.test(data)) {
    const productId = parseInt(data.split('_').pop(), 10);
    const product   = db.getProduct(productId);
    items.clearUnsoldItems(productId);
    db.clearUnsoldStock(productId);
    db.setStockQuantity(productId, 0);
    await bot.editMessageText(
      `✅ <b>Stock set to 0.</b>\n\n<b>${product.title}</b> is now ❌ <b>OUT OF STOCK</b>.`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: backToProductEditKb(productId) }
    );
    await evaluateStock(bot, productId);
    return;
  }

  // ── View stock count ──────────────────────────────────────────────
  if (/^admin_stock_view_\d+$/.test(data)) {
    const productId = parseInt(data.split('_').pop(), 10);
    const product   = db.getProduct(productId);
    const itemStats = items.getItemStats(productId);
    const stockQty  = product?.stock_quantity || 0;
    const statusLine = stockQty === 0 ? '❌ <b>OUT OF STOCK</b>' : '✅ <b>IN STOCK</b>';

    let viewText =
      `📦 <b>${product.title}</b>\n\n` +
      `${statusLine}\n` +
      `📊 Stock quantity: <b>${stockQty}</b>\n` +
      `📋 Available items: <b>${itemStats.available}</b>\n` +
      `🛒 Sold items: <b>${itemStats.sold}</b>\n` +
      `📈 Sales count: <b>${product.sales_count || 0}</b>`;

    const sample = items.getItemsPage(productId).slice(0, 5);
    if (sample.length > 0) {
      const sampleLines = sample.map((it, idx) => {
        return `${idx + 1}. <code>${(it.raw_content || '').slice(0, 50)}</code>`;
      }).join('\n');
      viewText += `\n\n<b>Sample available items:</b>\n${sampleLines}`;
      if (itemStats.available > 5) viewText += `\n<i>…and ${itemStats.available - 5} more</i>`;
    } else {
      viewText += '\n\n<i>No items in inventory yet.</i>';
    }

    await bot.editMessageText(viewText, {
      chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: backToProductEditKb(productId),
    });
    return;
  }

  // ── Show ALL stock items in detail (admin only) ──────────────────
  if (/^admin_stock_full_\d+$/.test(data)) {
    const productId = parseInt(data.split('_').pop(), 10);
    const product   = db.getProduct(productId);
    const all       = items.getAllAvailable(productId);

    // Also get legacy stock items
    const legacyStock = db.getStockItems(productId);

    if (!all.length && !legacyStock.length) {
      await bot.editMessageText(
        `📋 <b>${product.title}</b> — Full Stock\n\n<i>No available items in inventory.</i>`,
        { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: backToProductEditKb(productId) }
      );
      return;
    }

    // Build numbered list of all available items (product_items)
    const lines = all.map((it, idx) => `${idx + 1}. <code>${escapeHtml(it.raw_content || '')}</code>`);
    // Add legacy stock items with their IDs for deletion
    const legacyLines = legacyStock.map((it, idx) => `L${idx + 1}. [#${it.id}] <code>${escapeHtml(it.content || '')}</code>`);
    const allLines = [...lines, ...legacyLines];

    const header =
      `📋 <b>${product.title}</b> — Full Stock\n` +
      `📦 <b>Total available:</b> ${all.length + legacyStock.length}\n` +
      `━━━━━━━━━━━━━━━━━━\n\n`;

    const MAX = 3800;
    let buf = header;
    const chunks = [];
    for (const line of allLines) {
      if ((buf + line + '\n').length > MAX) { chunks.push(buf); buf = ''; }
      buf += line + '\n';
    }
    if (buf) chunks.push(buf);

    // First chunk: edit current message
    await bot.editMessageText(chunks[0], {
      chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
      reply_markup: chunks.length === 1 ? backToProductEditKb(productId) : undefined,
    }).catch(() => {});

    // Remaining chunks: send as new messages
    for (let i = 1; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      await bot.sendMessage(chatId, chunks[i], {
        parse_mode: 'HTML',
        reply_markup: isLast ? backToProductEditKb(productId) : undefined,
      });
    }

    // Send delete buttons for ALL items — both product_items and legacy stock
    // Combine into one list with type marker
    const deletables = [
      ...all.map((it) => ({ id: it.id, content: it.raw_content, type: 'item' })),
      ...legacyStock.map((it) => ({ id: it.id, content: it.content, type: 'stock' })),
    ];

    if (deletables.length > 0) {
      // Build keyboard with delete buttons (max 20 at a time)
      const { mk } = require('../utils/keyboard') || {};
      const buildKb = (rows) => ({ inline_keyboard: rows });
      const rows = deletables.slice(0, 20).map((it) => {
        const preview = String(it.content || '').slice(0, 30);
        const prefix  = it.type === 'item' ? 'i' : 's';
        return [{ text: `🗑 #${it.id}: ${preview}`, callback_data: `admin_del_stock_item_${prefix}_${it.id}` }];
      });
      rows.push([{ text: '🔙 Back to Product', callback_data: `admin_edit_p_${productId}` }]);
      await bot.sendMessage(
        chatId,
        `🗑 <b>Delete a specific account/code:</b>\nTap any item below to remove it from stock.`,
        { parse_mode: 'HTML', reply_markup: buildKb(rows) }
      );
    }
    return;
  }

  if (/^admin_stock_clear_\d+$/.test(data)) {
    const productId    = parseInt(data.split('_').pop(), 10);
    const product      = db.getProduct(productId);
    const itemsCleared = items.clearUnsoldItems(productId);
    db.clearUnsoldStock(productId);
    db.setStockQuantity(productId, 0);
    await bot.editMessageText(
      `✅ <b>All unsold stock cleared.</b>\n\n` +
      `📦 ${product.title}\n` +
      `🗑 Cleared: ${itemsCleared} items\n` +
      `📊 Stock quantity reset to 0.`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: backToProductEditKb(productId) }
    );
    await evaluateStock(bot, productId);
    return;
  }

  // ── Users ─────────────────────────────────────────────────────────
  if (data === 'admin_users') {
    const users = db.getAllUsers();
    await bot.editMessageText(`👥 <b>Users</b> (${users.length} total)`, {
      chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: adminUsersKb(users),
    });
    return;
  }
  // ═══════════════════════════════════════════════════════════════════
  // FRAUD RESPONSE — cancel every open order of one user
  // ═══════════════════════════════════════════════════════════════════

  if (/^admin_fraud_\d+$/.test(data)) {
    const targetId = parseInt(data.split('_').pop(), 10);
    const user = db.getUser(targetId);
    if (!user) { await answer('❌ User not found'); return; }

    const pv = db.previewCancelAllUserOrders(targetId);
    const name = user.username ? `@${user.username}` : (user.first_name || `User ${targetId}`);

    const txt =
      `🚨 <b>Fraud Response</b>\n\n` +
      `👤 ${escapeHtml(name)}\n` +
      `🆔 <code>${targetId}</code>\n` +
      `💰 Balance: <b>${formatPrice(user.balance || 0)}</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `<b>Will be cancelled:</b>\n` +
      `⏳ Pending orders: <b>${pv.pending}</b>\n` +
      `🕐 Paid, awaiting delivery: <b>${pv.awaiting}</b> (${formatPrice(pv.paidValue)})\n` +
      `🔄 Pending refund requests: <b>${pv.pendingRefunds}</b>\n\n` +
      `<b>Will NOT be touched:</b>\n` +
      `✅ Already delivered: <b>${pv.delivered}</b> — the goods are gone, history stays intact\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `Stock is returned to inventory and the sold/sales counters are corrected. ` +
      `Outstanding refund requests are rejected so stolen credit cannot be cashed out.\n\n` +
      `Choose whether the money goes back to their wallet:`;

    await bot.editMessageText(txt, {
      chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [
        [{ text: '🚨 Cancel all — NO refund', callback_data: `admin_fraud_go_${targetId}_0` }],
        [{ text: '↩️ Cancel all + refund wallet', callback_data: `admin_fraud_go_${targetId}_1` }],
        [{ text: '🔙 Back to user', callback_data: `admin_user_${targetId}` }],
      ] },
    }).catch(() => {});
    return;
  }

  if (/^admin_fraud_go_\d+_[01]$/.test(data)) {
    const parts    = data.split('_');
    const refund   = parts.pop() === '1';
    const targetId = parseInt(parts.pop(), 10);
    const user     = db.getUser(targetId);
    if (!user) { await answer('❌ User not found'); return; }

    const r = db.cancelAllUserOrders(targetId, { refund });
    logger.warn(
      `Admin ${userId} FRAUD-CANCELLED all orders for user ${targetId} ` +
      `(refund=${refund}): ${JSON.stringify(r)}`
    );

    const name = user.username ? `@${user.username}` : (user.first_name || `User ${targetId}`);
    const fresh = db.getUser(targetId);

    const txt =
      `✅ <b>Fraud Response Applied</b>\n\n` +
      `👤 ${escapeHtml(name)} — <code>${targetId}</code>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `❌ Pending orders cancelled: <b>${r.cancelledPending}</b>\n` +
      `❌ Paid orders cancelled: <b>${r.cancelledPaid}</b>\n` +
      `📦 Manual delivery tasks closed: <b>${r.manualCancelled}</b>\n` +
      `📊 Stock returned: <b>${r.stockRestored}</b> unit(s)\n` +
      `🔄 Refund requests rejected: <b>${r.refundRequestsRejected}</b>\n` +
      `🎫 Reservations released: <b>${r.reservationsReleased}</b>\n` +
      (refund
        ? `↩️ Refunded to wallet: <b>${formatPrice(r.refunded)}</b>\n`
        : `🚫 <b>No refund issued.</b>\n`) +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `✅ Left untouched (delivered): <b>${r.delivered}</b>\n` +
      `💰 Balance now: <b>${formatPrice(fresh?.balance || 0)}</b>\n\n` +
      (r.delivered > 0
        ? `⚠️ <i>${r.delivered} order(s) were already delivered. Those products cannot be recalled — ` +
          `review them manually if they were bought with stolen credit.</i>\n\n`
        : '') +
      `<i>Next: ban the account, and reverse the fraudulent deposit if you have not yet.</i>`;

    await bot.editMessageText(txt, {
      chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [
        [{ text: user.is_banned ? '✅ Unban' : '🚫 Ban this user', callback_data: `admin_toggle_ban_${targetId}` }],
        [{ text: '↩️ Reverse a deposit', callback_data: 'admin_dep_reverse' }],
        [{ text: '🔙 Back to user', callback_data: `admin_user_${targetId}` }],
      ] },
    }).catch(() => {});
    return;
  }

  if (/^admin_user_\d+$/.test(data)) {
    const targetId = parseInt(data.split('_').pop(), 10);
    const user     = db.getUser(targetId);
    const orders   = db.getUserOrders(targetId);
    if (!user) { await answer('❌ Not found.'); return; }
    const name = user.username || user.first_name || `User ${targetId}`;
    await bot.editMessageText(
      `👤 <b>${name}</b>\n\n🆔 <code>${targetId}</code>\n💰 ${formatPrice(user.balance)}\n` +
      `📦 Orders: ${orders.length}\n📅 Joined: ${(user.created_at || '').slice(0, 10)}\n` +
      `⚡ Status: ${user.is_banned ? '🚫 BANNED' : '✅ Active'}`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: adminUserActionsKb(targetId, !!user.is_banned) }
    );
    return;
  }
  if (/^admin_toggle_ban_\d+$/.test(data)) {
    const targetId = parseInt(data.split('_').pop(), 10);
    const user     = db.getUser(targetId);
    db.banUser(targetId, !user?.is_banned);
    const updated  = db.getUser(targetId);
    await answer(updated.is_banned ? 'User banned 🚫' : 'User unbanned ✅');
    const name = updated.username || updated.first_name || `User ${targetId}`;
    await bot.editMessageText(
      `👤 <b>${name}</b>\n\n💰 ${formatPrice(updated.balance)}\n⚡ ${updated.is_banned ? '🚫 BANNED' : '✅ Active'}`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: adminUserActionsKb(targetId, !!updated.is_banned) }
    );
    return;
  }

  // ── Reset User Wallet to $0 ───────────────────────────────────────
  if (/^admin_user_resetwallet_\d+$/.test(data)) {
    const targetId = parseInt(data.split('_').pop(), 10);
    const user = db.getUser(targetId);
    if (!user) { await answer('❌ Not found'); return; }
    const name = user.username || user.first_name || `User ${targetId}`;
    await bot.editMessageText(
      `🔄 <b>Reset Wallet</b>\n\n` +
      `👤 User: <b>${escapeHtml(name)}</b> (<code>${targetId}</code>)\n` +
      `💰 Current Balance: <b>${formatPrice(user.balance)}</b>\n\n` +
      `⚠️ This will set their wallet balance to <b>$0.00</b>.\n` +
      `This action cannot be undone.\n\n` +
      `Are you sure?`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: adminResetWalletConfirmKb(targetId) }
    );
    return;
  }

  if (/^admin_user_resetwallet_confirm_\d+$/.test(data)) {
    const targetId = parseInt(data.split('_').pop(), 10);
    const user = db.getUser(targetId);
    if (!user) { await answer('❌ Not found'); return; }
    const previousBalance = user.balance;

    // Reset by adding -previousBalance (since updateBalance adds the amount)
    db.updateBalance(targetId, -previousBalance);
    db.addTransaction({
      userId:      targetId,
      type:        'admin_reset',
      amount:      -previousBalance,
      description: `Wallet reset to $0 by admin`,
      refId:       null,
      orderId:     null,
    });

    await answer('✅ Wallet reset to $0');

    // Notify user
    try {
      await bot.sendMessage(
        targetId,
        `⚠️ <b>Your wallet has been reset by admin.</b>\n\n` +
        `Previous balance: <b>${formatPrice(previousBalance)}</b>\n` +
        `New balance: <b>$0.00</b>\n\n` +
        `Contact support if you have questions.`,
        { parse_mode: 'HTML' }
      );
    } catch (e) {
      logger.warn(`Could not notify ${targetId} about wallet reset: ${e.message}`);
    }

    const name = user.username || user.first_name || `User ${targetId}`;
    await bot.editMessageText(
      `✅ <b>Wallet Reset Complete</b>\n\n` +
      `👤 User: <b>${escapeHtml(name)}</b>\n` +
      `💰 Previous: <b>${formatPrice(previousBalance)}</b>\n` +
      `💰 New: <b>$0.00</b>`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🔙 Back to User', callback_data: `admin_user_${targetId}` }]] } }
    );
    return;
  }

  // ── Confirm stock addition ────────────────────────────────────────
  if (data === 'admin_stock_confirm_yes') {
    const sess = session.get(userId);
    if (sess.state !== States.ADMIN_STOCK_CONFIRM) {
      await answer('❌ Session expired. Please try again.');
      return;
    }
    const { stockProductId, stockItems, prevStock } = sess.data;
    const product = db.getProduct(stockProductId);
    if (!product) { await answer('❌ Product not found'); return; }

    const wasZero = prevStock === 0;
    logger.info(`Admin ${userId} CONFIRMED adding ${stockItems.length} stock items to product ${stockProductId}`);

    const count = items.insertItems(stockProductId, stockItems);
    const newQty = db.adjustStockQuantity(stockProductId, count).after;
    session.clear(userId);

    await bot.editMessageText(
      `✅ <b>Stock Items Added Successfully!</b>\n\n` +
      `📦 <b>Product:</b> ${escapeHtml(product.title)}\n` +
      `➕ <b>Items added:</b> ${count}\n` +
      `📊 <b>Previous stock:</b> ${prevStock}\n` +
      `📊 <b>New stock:</b> ${newQty}`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: backToProductEditKb(stockProductId) }
    );

    await evaluateStock(bot, stockProductId);

    // ── BROADCAST to channel & group ───────────────────────────────
    try {
      const fresh = db.getProduct(stockProductId);
      const botUserSC = await bot.getMe().catch(() => ({ username: '' }));
      const kbSC = { inline_keyboard: [[{ text: '🛒 Buy now', url: `https://t.me/${botUserSC.username}?start=p_${fresh.id}` }]] };
      const stockText = buildStockUpdateText(fresh, count);
      await autoPublishWithPhoto(bot, fresh, stockText, kbSC);
      logger.info(`Stock broadcast sent for product ${fresh.id}`);
    } catch (e) {
      logger.warn(`Stock broadcast failed: ${e.message}`);
    }

    // Notify out-of-stock subscribers
    if (wasZero && newQty > 0) {
      const notified = await notifyBackInStockSubscribers(bot, stockProductId);
      if (notified > 0) {
        await bot.sendMessage(chatId,
          `🔔 Notified <b>${notified}</b> waiting user(s) that stock is available again.`,
          { parse_mode: 'HTML' });
      }
    }

    // Pre-Order check
    try {
      const pending = db.getReservedPreordersByProduct(stockProductId);
      if (pending.length > 0) {
        await bot.sendMessage(
          chatId,
          `🔜 <b>Pre-Order Notice</b>\n\n` +
          `📦 Product: ${escapeHtml(product.title)}\n` +
          `👥 Pending Pre-Orders: <b>${pending.length}</b>\n\n` +
          `Do you want to deliver these pre-orders now?\n\n` +
          `<i>⚠️ If you added wrong items by mistake, choose "No" to skip.</i>`,
          { parse_mode: 'HTML',
            reply_markup: adminPreorderConfirmDeliverKb(stockProductId, pending.length) }
        );
      }
    } catch (e) {
      logger.warn(`Pre-order notice error: ${e.message}`);
    }
    return;
  }

  // ── View User's Top-Up History ────────────────────────────────────
  if (/^admin_user_topups_\d+$/.test(data)) {
    const targetId = parseInt(data.split('_').pop(), 10);
    const user = db.getUser(targetId);
    if (!user) { await answer('❌ Not found'); return; }
    const name = user.username || user.first_name || `User ${targetId}`;

    // Get all transactions for this user
    const allTx = db.getUserTransactions(targetId);

    // Filter for top-ups: deposits, admin_credit, refunds
    const topups = allTx.filter(t => ['deposit', 'admin_credit', 'refund', 'referral', 'referral_cashback'].includes(t.type));

    if (!topups.length) {
      await bot.editMessageText(
        `💳 <b>${escapeHtml(name)}'s Top-Up History</b>\n\n` +
        `No top-ups or credits found for this user.`,
        { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: '🔙 Back to User', callback_data: `admin_user_${targetId}` }]] } }
      );
      return;
    }

    // Calculate totals by type
    let totalDeposits = 0;
    let totalAdminCredits = 0;
    let totalRefunds = 0;
    let totalReferrals = 0;
    topups.forEach(t => {
      const a = Number(t.amount) || 0;
      if (t.type === 'deposit') totalDeposits += a;
      else if (t.type === 'admin_credit') totalAdminCredits += a;
      else if (t.type === 'refund') totalRefunds += a;
      else if (t.type === 'referral' || t.type === 'referral_cashback') totalReferrals += a;
    });

    const typeEmoji = {
      deposit: '💰',
      admin_credit: '👨‍💼',
      refund: '↩️',
      referral: '👥',
      referral_cashback: '🎁',
    };
    const typeLabel = {
      deposit: 'User Top-Up',
      admin_credit: 'Admin Add',
      refund: 'Refund',
      referral: 'Referral Bonus',
      referral_cashback: 'Cashback',
    };

    // Format list (latest first, max 20)
    const lines = topups.slice(0, 20).map((t, i) => {
      const emoji = typeEmoji[t.type] || '💵';
      const label = typeLabel[t.type] || t.type;
      const date = (t.created_at || '').slice(0, 16);
      const desc = (t.description || '').slice(0, 60);
      return `${i + 1}. ${emoji} <b>${formatPrice(Math.abs(t.amount))}</b> — ${label} <code>#${t.id}</code>\n` +
             `   📅 ${date}\n` +
             (desc ? `   📝 <i>${escapeHtml(desc)}</i>` : '');
    }).join('\n\n');

    // Build cancel buttons for first 5 deposits
    const cancelRows = topups.slice(0, 5)
      .filter(t => t.type === 'deposit' || t.type === 'admin_credit')
      .map(t => [{
        text: `❌ Cancel #${t.id} (${formatPrice(Math.abs(t.amount))})`,
        callback_data: `admin_cancel_topup_${t.id}_${targetId}`,
      }]);
    cancelRows.push([{ text: '🔙 Back to User', callback_data: `admin_user_${targetId}` }]);

    const total = totalDeposits + totalAdminCredits + totalRefunds + totalReferrals;

    await bot.editMessageText(
      `💳 <b>${escapeHtml(name)}'s Top-Up History</b>\n` +
      `🆔 <code>${targetId}</code>\n\n` +
      `📊 <b>Summary:</b>\n` +
      `💰 User Top-Ups: <b>${formatPrice(totalDeposits)}</b>\n` +
      `👨‍💼 Admin Credits: <b>${formatPrice(totalAdminCredits)}</b>\n` +
      `↩️ Refunds: <b>${formatPrice(totalRefunds)}</b>\n` +
      (totalReferrals > 0 ? `🎁 Referral Bonuses: <b>${formatPrice(totalReferrals)}</b>\n` : '') +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `💵 <b>Total Credited:</b> ${formatPrice(total)}\n\n` +
      `📋 <b>Latest ${topups.length > 20 ? 20 : topups.length} transactions:</b>\n\n` +
      lines +
      (cancelRows.length > 1 ? `\n\n⚠️ <b>Cancel a fraudulent top-up below:</b>` : ''),
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: cancelRows } }
    );
    return;
  }

  // ── Cancel a top-up (fraud/mistake) ───────────────────────────────
  if (/^admin_cancel_topup_\d+_\d+$/.test(data)) {
    const parts = data.split('_');
    const txId = parseInt(parts[3], 10);
    const targetId = parseInt(parts[4], 10);

    const tx = db.getTransactionById(txId);
    if (!tx) { await answer('❌ Not found'); return; }
    if (tx.user_id !== targetId) { await answer('❌ Mismatch'); return; }
    if (!['deposit', 'admin_credit'].includes(tx.type)) {
      await answer('❌ Only deposits or admin credits can be cancelled');
      return;
    }

    const amount = Math.abs(Number(tx.amount));
    const user = db.getUser(targetId);
    const name = user?.username || user?.first_name || `User ${targetId}`;

    await bot.editMessageText(
      `⚠️ <b>Confirm Cancellation</b>\n\n` +
      `🆔 Transaction #${tx.id}\n` +
      `👤 User: ${escapeHtml(name)}\n` +
      `💵 Amount to refund: <b>${formatPrice(amount)}</b>\n` +
      `💰 Current balance: ${formatPrice(user?.balance || 0)}\n` +
      `💵 After cancel: <b>${formatPrice((user?.balance || 0) - amount)}</b>\n\n` +
      `📝 Reason: ${escapeHtml(tx.description || 'N/A')}\n\n` +
      `<b>⚠️ This will:</b>\n` +
      `• Subtract ${formatPrice(amount)} from user's balance\n` +
      `• Mark this transaction as cancelled\n` +
      `• Notify the user\n\n` +
      `Are you sure?`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [
          [{ text: '✅ Yes, Cancel & Refund', callback_data: `admin_confirm_cancel_topup_${txId}` }],
          [{ text: '🔙 No, Go Back', callback_data: `admin_user_topups_${targetId}` }],
        ] } }
    );
    return;
  }

  if (/^admin_confirm_cancel_topup_\d+$/.test(data)) {
    const txId = parseInt(data.split('_').pop(), 10);
    const tx = db.getTransactionById(txId);
    if (!tx) { await answer('❌ Not found'); return; }

    const amount = Math.abs(Number(tx.amount));
    const targetId = tx.user_id;
    const user = db.getUser(targetId);

    // Subtract from balance
    db.updateBalance(targetId, -amount);

    // Add a cancel transaction record
    db.addTransaction({
      userId: targetId,
      type: 'admin_cancel',
      amount: -amount,
      description: `Admin cancelled tx #${txId} (was: ${tx.type})`,
      refId: tx.ref_id || null,
      orderId: null,
    });

    // Notify the user
    try {
      await bot.sendMessage(targetId,
        `⚠️ <b>Top-Up Cancelled</b>\n\n` +
        `Your top-up of <b>${formatPrice(amount)}</b> has been cancelled by admin.\n\n` +
        `If you believe this is a mistake, please contact support.`,
        { parse_mode: 'HTML' }
      );
    } catch (e) {
      logger.warn(`Cancel notify failed: ${e.message}`);
    }

    const updated = db.getUser(targetId);
    await bot.editMessageText(
      `✅ <b>Top-Up Cancelled</b>\n\n` +
      `💵 Amount removed: <b>${formatPrice(amount)}</b>\n` +
      `💰 New balance: <b>${formatPrice(updated?.balance || 0)}</b>\n\n` +
      `User has been notified.`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [
          [{ text: '🔙 Back to User', callback_data: `admin_user_${targetId}` }],
        ] } }
    );
    return;
  }

  // ── View User's Purchases ─────────────────────────────────────────
  // Pagination: admin_user_orders_p_USERID_PAGE
  if (/^admin_user_orders_p_\d+_\d+$/.test(data)) {
    const parts = data.split('_');
    const targetId = parseInt(parts[4], 10);
    const page = parseInt(parts[5], 10);
    const user = db.getUser(targetId);
    if (!user) { await answer('❌ Not found.'); return; }
    const orders = db.getUserOrders(targetId);
    const name = user.username || user.first_name || `User ${targetId}`;
    const delivered = orders.filter(o => o.status === 'delivered').length;
    const totalSpent = orders.filter(o => o.status === 'delivered').reduce((s, o) => s + (o.total_price || 0), 0);
    await bot.editMessageText(
      `📦 <b>${escapeHtml(name)}'s Purchases</b>\n\n` +
      `🆔 User: <code>${targetId}</code>\n` +
      `📊 Total Orders: <b>${orders.length}</b>\n` +
      `✅ Delivered: <b>${delivered}</b>\n` +
      `💰 Total Spent: <b>${formatPrice(totalSpent)}</b>\n\n` +
      `Tap an order to see details (page ${page + 1}):`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: adminUserOrdersKb(targetId, orders, page) }
    ).catch(() => {});
    return;
  }

  if (/^admin_user_orders_\d+$/.test(data)) {
    const targetId = parseInt(data.split('_').pop(), 10);
    const user     = db.getUser(targetId);
    if (!user) { await answer('❌ Not found.'); return; }
    const orders = db.getUserOrders(targetId);
    const name = user.username || user.first_name || `User ${targetId}`;

    if (!orders.length) {
      await bot.editMessageText(
        `📦 <b>${escapeHtml(name)}'s Purchases</b>\n\nNo orders yet.`,
        { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: '🔙 Back to User', callback_data: `admin_user_${targetId}` }]] } }
      );
      return;
    }

    // Stats
    const delivered  = orders.filter(o => o.status === 'delivered').length;
    const totalSpent = orders.filter(o => o.status === 'delivered').reduce((s, o) => s + (o.total_price || 0), 0);

    await bot.editMessageText(
      `📦 <b>${escapeHtml(name)}'s Purchases</b>\n\n` +
      `🆔 User: <code>${targetId}</code>\n` +
      `📊 Total Orders: <b>${orders.length}</b>\n` +
      `✅ Delivered: <b>${delivered}</b>\n` +
      `💰 Total Spent: <b>${formatPrice(totalSpent)}</b>\n\n` +
      `Tap an order to see details (showing latest 15):`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: adminUserOrdersKb(targetId, orders) }
    );
    return;
  }

  // ── View single order from user purchases ─────────────────────────
  if (/^admin_user_order_\d+$/.test(data)) {
    const orderId = parseInt(data.split('_').pop(), 10);
    const order = db.getOrder(orderId);
    if (!order) { await answer('❌ Order not found.'); return; }

    const product = db.getProduct(order.product_id);
    const statusEmoji = { pending: '⏳', delivered: '✅', cancelled: '❌' };
    const emoji = statusEmoji[order.status] || '❓';

    // Main info (no delivered content yet)
    const mainText =
      `📦 <b>Order #${order.id}</b>\n\n` +
      `${emoji} <b>Status:</b> ${order.status.toUpperCase()}\n` +
      `🛒 <b>Product:</b> ${escapeHtml(order.product_title || (product?.title || ''))}\n` +
      `🔢 <b>Quantity:</b> ${order.quantity}\n` +
      (order.email ? `📧 <b>Email:</b> ${escapeHtml(order.email)}\n` : '') +
      `💵 <b>Total:</b> ${formatPrice(order.total_price)}\n` +
      `💳 <b>Method:</b> ${order.payment_method || 'n/a'}\n` +
      `👤 <b>User:</b> <code>${order.user_id}</code>\n` +
      `📅 <b>Created:</b> ${(order.created_at || '').slice(0, 16)}\n` +
      (order.paid_at ? `✅ <b>Paid:</b> ${(order.paid_at || '').slice(0, 16)}\n` : '');

    await bot.editMessageText(
      mainText,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: order.delivered_content ? undefined : adminUserOrderDetailKb(order.user_id) }
    );

    // Send full delivered content if exists (in chunks)
    if (order.delivered_content) {
      const fullContent = order.delivered_content;
      const MAX_CHUNK = 3500;

      await bot.sendMessage(
        chatId,
        `━━━━━━━━━━━━━━━━━━━━\n🎁 <b>Delivered Content (Full):</b>\n━━━━━━━━━━━━━━━━━━━━`,
        { parse_mode: 'HTML' }
      );

      for (let i = 0; i < fullContent.length; i += MAX_CHUNK) {
        const chunk = fullContent.slice(i, i + MAX_CHUNK);
        try {
          await bot.sendMessage(chatId, `<code>${escapeHtml(chunk)}</code>`, { parse_mode: 'HTML' });
        } catch (e) {
          await bot.sendMessage(chatId, chunk).catch(() => {});
        }
      }

      await bot.sendMessage(
        chatId,
        `━━━━━━━━━━━━━━━━━━━━\n📦 End of order content`,
        { parse_mode: 'HTML', reply_markup: adminUserOrderDetailKb(order.user_id) }
      );
    }
    return;
  }

  // ── Orders ────────────────────────────────────────────────────────
  // Pagination: admin_orders_p_PAGE
  if (/^admin_orders_p_\d+$/.test(data)) {
    const page = parseInt(data.split('_').pop(), 10);
    const orders = db.getAllOrders ? db.getAllOrders() : [];
    await bot.editMessageText(`📋 <b>All Orders</b> (${orders.length} total, page ${page + 1})`, {
      chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
      reply_markup: adminOrdersKb(orders, page),
    }).catch(() => {});
    return;
  }

  if (data === 'admin_orders' || /^admin_orders_page_\d+$/.test(data)) {
    const dbRaw   = require('../database/db');
    const page    = data.startsWith('admin_orders_page_') ? parseInt(data.split('_').pop(), 10) : 0;
    const perPage = 50;
    const total   = dbRaw.prepare("SELECT COUNT(*) AS n FROM orders").get().n;
    const orders  = dbRaw.prepare(`
      SELECT o.*, p.title AS product_title, u.username
      FROM orders o
      LEFT JOIN products p ON o.product_id = p.id
      LEFT JOIN users u ON o.user_id = u.telegram_id
      ORDER BY o.created_at DESC
      LIMIT ? OFFSET ?
    `).all(perPage, page * perPage);

    const navRow = [];
    if (page > 0)                             navRow.push({ text: '⬅️ Newer', callback_data: `admin_orders_page_${page - 1}` });
    if ((page + 1) * perPage < total)         navRow.push({ text: 'Older ➡️', callback_data: `admin_orders_page_${page + 1}` });

    const kb = [
      [{ text: '🔍 Search by Order #', callback_data: 'admin_orders_search' }],
      [{ text: '🏆 Top Buyers', callback_data: 'admin_top_buyers' }],
      ...adminOrdersKb(orders).inline_keyboard,
    ];
    if (navRow.length) kb.push(navRow);

    const from = page * perPage + 1;
    const to   = Math.min((page + 1) * perPage, total);
    const txt  = `📋 <b>All Orders</b>\n${from}–${to} of ${total} total`;

    try {
      await bot.editMessageText(txt, {
        chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: kb },
      });
    } catch (e) {
      await bot.sendMessage(chatId, txt, {
        parse_mode: 'HTML', reply_markup: { inline_keyboard: kb },
      });
    }
    return;
  }

  // ── Search order by ID ─────────────────────────────────
  if (data === 'admin_orders_search') {
    session.set(userId, States.ADMIN_SEARCH_ORDER, {});
    await bot.sendMessage(chatId,
      '🔍 <b>Search Order</b>\n\nSend the order number (e.g. <code>1672</code>):',
      { parse_mode: 'HTML' });
    return;
  }

  // ── Top Buyers (leaderboard) ────────────────────────────
  if (data === 'admin_top_buyers') {
    const dbRaw = require('../database/db');
    const top = dbRaw.prepare(`
      SELECT user_id, COUNT(*) AS orders_count, COALESCE(SUM(total_price), 0) AS total_spent
      FROM orders WHERE status='delivered'
      GROUP BY user_id ORDER BY total_spent DESC LIMIT 20
    `).all();

    let txt = `🏆 <b>Top 20 Buyers</b>\n\n`;
    if (!top.length) {
      txt += '<i>No completed orders yet.</i>';
    } else {
      top.forEach((row, i) => {
        const u = db.getUser(row.user_id);
        const name = u ? (u.username ? '@' + u.username : (u.first_name || `User ${row.user_id}`)) : `User ${row.user_id}`;
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i+1}.`;
        txt += `${medal} ${escapeHtml(name)} — <b>${formatPrice(row.total_spent)}</b> (${row.orders_count} orders)\n`;
      });
    }

    await bot.editMessageText(txt, {
      chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '🔙 Back to Orders', callback_data: 'admin_orders' }]] }
    }).catch(() => {});
    return;
  }

  // ── Cancel an order + recover items + refund to wallet ──────────
  // ── Admin: Force-cancel a pending order ─────────────────────────────────────
  if (/^admin_force_cancel_\d+$/.test(data)) {
    const orderId = parseInt(data.split('_').pop(), 10);
    const order   = db.getOrder(orderId);
    if (!order) { await answer('Order not found'); return; }
    if (order.status !== 'pending') {
      await answer(`Cannot cancel — status is "${order.status}"`);
      return;
    }
    await bot.editMessageText(
      `🚫 <b>Cancel Pending Order #${orderId}?</b>\n\n` +
      `📦 Product: ${escapeHtml(order.product_title || 'N/A')}\n` +
      `👤 Customer: <code>${order.user_id}</code>\n` +
      `💵 Total: $${Number(order.total_price || 0).toFixed(2)}\n\n` +
      `⚠️ No payment was taken (wallet orders are atomic).\n` +
      `This will mark the order as cancelled.`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [
          [{ text: '✅ Yes, Cancel Order', callback_data: `admin_force_cancel_confirm_${orderId}` }],
          [{ text: '🔙 Back', callback_data: `admin_order_view_${orderId}` }],
        ]},
      }
    );
    return;
  }

  if (/^admin_force_cancel_confirm_\d+$/.test(data)) {
    const orderId = parseInt(data.split('_').pop(), 10);
    const order   = db.getOrder(orderId);
    if (!order || order.status !== 'pending') {
      await answer('Order not found or already processed');
      return;
    }
    db.updateOrderStatus(orderId, 'cancelled');
    // Notify customer
    try {
      await bot.sendMessage(order.user_id,
        `❌ <b>Order #${orderId} Cancelled</b>\n\n` +
        `Your pending order has been cancelled by the admin.\n` +
        `No payment was taken from your wallet.\n\n` +
        `If you have questions, please contact support.`,
        { parse_mode: 'HTML' }
      );
    } catch (e) {}
    await bot.editMessageText(
      `✅ <b>Order #${orderId} cancelled successfully.</b>\n\nCustomer has been notified.`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '📋 All Orders', callback_data: 'admin_orders' }]] } }
    );
    return;
  }

  if (/^admin_order_cancel_\d+$/.test(data)) {
    const orderId = parseInt(data.split('_').pop(), 10);
    const order = db.getOrder(orderId);
    if (!order) { await answer('❌ Order not found'); return; }

    await bot.editMessageText(
      `⚠️ <b>Cancel Order #${orderId}?</b>\n\n` +
      `👤 User: <code>${order.user_id}</code>\n` +
      `📦 ${escapeHtml(order.product_title || '')}\n` +
      `🔢 Qty: ${order.quantity}\n` +
      `💵 ${formatPrice(order.total_price)}\n` +
      `⚡ Status: ${order.status}\n\n` +
      `This will:\n` +
      `• DELETE the order permanently\n` +
      `• Items will NOT return to stock\n` +
      `• <b>NO refund</b> to user`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [
          [{ text: '🗑 Yes, DELETE order', callback_data: `admin_order_cancel_yes_${orderId}` }],
          [{ text: '🔙 No, keep', callback_data: `admin_order_${orderId}` }],
        ] } }
    ).catch(() => {});
    return;
  }

  if (/^admin_order_cancel_yes_\d+$/.test(data)) {
    const orderId = parseInt(data.split('_').pop(), 10);
    const order = db.getOrder(orderId);
    if (!order) { await answer('❌ Order not found'); return; }

    try {
      // DELETE the order permanently — no recovery, no refund
      const dbRaw = require('../database/db');
      dbRaw.prepare(`DELETE FROM orders WHERE id = ?`).run(orderId);
      try { dbRaw.prepare(`DELETE FROM transactions WHERE order_id = ?`).run(orderId); } catch (e) {}

      await bot.editMessageText(
        `🗑 <b>Order #${orderId} DELETED</b>\n\n` +
        `📦 ${escapeHtml(order.product_title || '')}\n` +
        `❌ No refund issued\n` +
        `🚫 Order removed from database`,
        { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [
            [{ text: '🔙 Back to Orders', callback_data: 'admin_orders' }],
          ] } }
      ).catch(() => {});
      logger.info(`Admin ${userId} DELETED order #${orderId}`);
    } catch (e) {
      logger.error(`Cancel order failed: ${e.message}`);
      await answer(`❌ ${e.message}`);
    }
    return;
  }

  if (/^admin_order_\d+$/.test(data)) {
    const orderId = parseInt(data.split('_').pop(), 10);
    const order   = db.getOrder(orderId);
    if (!order) { await answer('❌ Not found.'); return; }
    const u = db.getUser(order.user_id);
    const username = u?.username ? `@${u.username}` : '—';
    const fullName = [u?.first_name, u?.last_name].filter(Boolean).join(' ') || '—';
    const isVip = u && db.isVIP(order.user_id) ? '👑 VIP' : '';

    const text =
      `📋 <b>Order #${orderId}</b> ${isVip}\n\n` +
      `👤 <b>Customer</b>\n` +
      `   Name: ${escapeHtml(fullName)}\n` +
      `   Username: ${escapeHtml(username)}\n` +
      `   ID: <code>${order.user_id}</code>\n` +
      `   Balance: ${formatPrice(u?.balance || 0)}\n\n` +
      `📦 <b>Product:</b> ${escapeHtml(order.product_title || 'Unknown')}\n` +
      `🔢 <b>Qty:</b> ${order.quantity}\n` +
      (order.email ? `📧 <b>Email:</b> ${escapeHtml(order.email)}\n` : '') +
      `💵 <b>Total:</b> ${formatPrice(order.total_price)}\n` +
      `💳 <b>Payment:</b> ${escapeHtml(order.payment_method || 'N/A')}\n` +
      `⚡ <b>Status:</b> ${escapeHtml(order.status)}\n` +
      `📅 <b>Date:</b> ${(order.created_at || '').slice(0, 16)}` +
      (order.delivered_content ? `\n\n🎁 <b>Delivered:</b>\n<code>${escapeHtml(String(order.delivered_content).slice(0, 300))}</code>` : '');

    const kb = { inline_keyboard: [
      [{ text: '👤 View Customer Profile', callback_data: `admin_user_${order.user_id}` }],
      ...(order.status === 'pending' ? [[{ text: '🚫 Cancel Pending Order', callback_data: `admin_force_cancel_${orderId}` }]] : []),
      [{ text: '🗑 Delete Order', callback_data: `admin_order_cancel_${orderId}` }],
      [{ text: '🔙 Back to Orders', callback_data: 'admin_orders' }],
    ] };

    try {
      await bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: kb });
    } catch (e) {
      logger.warn(`Order view failed: ${e.message}`);
      try { await bot.deleteMessage(chatId, msgId); } catch (e2) {}
      await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: kb });
    }
    return;
  }

  // ── Pending payments ──────────────────────────────────────────────
  if (data === 'admin_pending') {
    const payments = db.getPendingPayments();
    if (!payments.length) {
      await bot.editMessageText('💳 <b>No pending payments.</b>', {
        chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: adminBackKb(),
      });
      return;
    }
    const lines = payments.map((p) => {
      const name = p.username || p.first_name || `User ${p.user_id}`;
      return `• #${p.id} — ${name} — $${Number(p.amount).toFixed(2)} — ${p.type} — ${(p.created_at || '').slice(0, 16)}`;
    }).join('\n');
    await bot.editMessageText(`💳 <b>Pending Payments (${payments.length})</b>\n\n${lines}`, {
      chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: adminBackKb(),
    });
    return;
  }

  // ── Broadcast ─────────────────────────────────────────────────────
  if (data === 'admin_broadcast') {
    session.set(userId, States.ADMIN_BROADCAST_MSG, {});
    await bot.editMessageText(
      '📣 <b>Broadcast</b>\n\nWrite the message to send to ALL users.\nSupports HTML formatting.',
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: adminBackKb() }
    );
    return;
  }
  if (data === 'admin_confirm_broadcast') {
    const d = session.get(userId).data;
    session.clear(userId);
    await bot.editMessageText('📣 Broadcasting…', { chat_id: chatId, message_id: msgId });
    const { sent, failed } = await broadcastToUsers(bot, d.broadcastText);
    await bot.editMessageText(
      `✅ <b>Broadcast Complete!</b>\n\n✅ Sent: ${sent}\n❌ Failed: ${failed}`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: adminBackKb() }
    );
    return;
  }

  // ── Statistics ────────────────────────────────────────────────────
  if (data === 'admin_stats') {
    const s = db.getStats();
    const topList = s.topProducts
      .map((p, i) => `  ${i + 1}. ${p.title} — ${p.sales_count || p.sold_count || 0} sold`)
      .join('\n') || '  No data yet';
    await bot.editMessageText(
      `📊 <b>Store Statistics</b>\n\n` +
      `👥 Total Users: <b>${s.totalUsers}</b>\n🆕 New Today: <b>${s.newToday}</b>\n\n` +
      `📦 Total Orders: <b>${s.totalOrders}</b>\n✅ Delivered: <b>${s.delivered}</b>\n⏳ Pending: <b>${s.pending}</b>\n\n` +
      `💰 Revenue: <b>${formatPrice(s.revenue)}</b>\n\n🏆 <b>Top Products:</b>\n${topList}`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: adminBackKb() }
    );
    return;
  }

  // ── Sort Products ─────────────────────────────────────────────────
  if (data === 'admin_sort_products') {
    const products = db.getAllProductsForSorting();
    if (!products.length) {
      await bot.editMessageText('📦 No products to sort.', {
        chat_id: chatId, message_id: msgId, reply_markup: adminBackKb(),
      });
      return;
    }
    await bot.editMessageText(
      '↕️ <b>Sort Products</b>\n\n' +
      'Each product shows: status, current order, title.\n' +
      'Tap the product name to set a custom number.\n' +
      'Tap ▲ to move up, ▼ to move down.',
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: adminSortProductsKb(products) }
    );
    return;
  }

  // Helper: rebuild display_order as 1,2,3,... from the current sorted list
  const renumberAll = () => {
    const all = db.getAllProductsForSorting();
    all.forEach((p, idx) => db.setDisplayOrder(p.id, idx + 1));
  };

  const refreshSortView = async () => {
    const products = db.getAllProductsForSorting();
    const total = products.length;
    await bot.editMessageText(
      `↕️ <b>Sort Products</b> (${total} products)\n\n` +
      `📌 Tap <b>#number</b> or <b>title</b> to set position.\n` +
      `▲ / ▼ to nudge up/down by one.\n` +
      `🟢 = active &nbsp; 🔴 = hidden`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: adminSortProductsKb(products) }
    );
  };

  // Move product up
  if (/^admin_moveup_\d+$/.test(data)) {
    const productId = parseInt(data.split('_').pop(), 10);
    renumberAll();
    const all = db.getAllProductsForSorting();
    const idx = all.findIndex((p) => p.id === productId);
    if (idx > 0) {
      const above = all[idx - 1];
      const curOrder   = idx + 1;
      const aboveOrder = idx;
      db.setDisplayOrder(productId, aboveOrder);
      db.setDisplayOrder(above.id, curOrder);
    }
    await answer('✅ Moved up');
    await refreshSortView();
    return;
  }

  // Move product down
  if (/^admin_movedown_\d+$/.test(data)) {
    const productId = parseInt(data.split('_').pop(), 10);
    renumberAll();
    const all = db.getAllProductsForSorting();
    const idx = all.findIndex((p) => p.id === productId);
    if (idx < all.length - 1 && idx !== -1) {
      const below = all[idx + 1];
      const curOrder   = idx + 1;
      const belowOrder = idx + 2;
      db.setDisplayOrder(productId, belowOrder);
      db.setDisplayOrder(below.id, curOrder);
    }
    await answer('✅ Moved down');
    await refreshSortView();
    return;
  }

  // Set position by number — show selection menu
  if (data === 'admin_sortbynum') {
    const products = db.getAllProductsForSorting();
    if (!products.length) {
      await answer('No products');
      return;
    }
    const rows = products.map((p, idx) => {
      const status = p.is_active ? '🟢' : '🔴';
      const title = (p.title || '').slice(0, 30);
      return [{ text: `#${idx + 1} ${status} ${title}`, callback_data: `admin_setorder_${p.id}` }];
    });
    rows.push([{ text: '🔙 Back', callback_data: 'admin_sort_products' }]);
    await bot.editMessageText(
      `🔢 <b>Select a Product</b>\n\nTap a product to set its position number.`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: rows } }
    );
    return;
  }

  // Set custom order number
  if (/^admin_setorder_\d+$/.test(data)) {
    const productId = parseInt(data.split('_').pop(), 10);
    const product = db.getProduct(productId);
    if (!product) { await answer('❌ Not found'); return; }
    const total = db.getAllProductsForSorting().length;
    session.set(userId, States.ADMIN_SET_ORDER, { setOrderProductId: productId });
    await bot.editMessageText(
      `🔢 <b>Set Position for:</b>\n${product.title}\n\n` +
      `Current position: <b>#${product.display_order ?? 999}</b>\n` +
      `Total products: <b>${total}</b>\n\n` +
      `Enter the new position number (1 to ${total}):\n\n` +
      `<i>Other products will be auto-shifted to make room.</i>`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'admin_sort_products' }]] } }
    );
    return;
  }

  // Auto-renumber (Reset orders to 1,2,3,...)
  if (data === 'admin_resetorder') {
    renumberAll();
    await answer('✅ Renumbered 1,2,3...');
    await refreshSortView();
    return;
  }

  // ── Profits ──────────────────────────────────────────────────────
  if (data === 'admin_profits') {
    await bot.editMessageText(
      '📈 <b>Profit Reports</b>\n\nSelect a time period:',
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: adminProfitsKb() }
    );
    return;
  }
  // Helper: format a profit block
  const formatProfitBlock = (label, data) => {
    const margin = data.revenue > 0 ? ((data.net_profit / data.revenue) * 100).toFixed(1) : '0.0';
    return `<b>${label}</b>\n\n` +
      `📦 Orders: <b>${data.orders_count || 0}</b>\n` +
      `💰 Revenue: <b>${formatPrice(data.revenue || 0)}</b>\n` +
      `💸 Cost: <b>${formatPrice(data.cost || 0)}</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📈 <b>Net Profit: ${formatPrice(data.net_profit || 0)}</b>\n` +
      `📊 Margin: <b>${margin}%</b>`;
  };

  if (data === 'admin_profit_today') {
    const stats = db.getProfitToday();
    await bot.editMessageText(
      `📅 ${formatProfitBlock("Today's Profit", stats)}\n\n` +
      `<i>💡 Add cost prices in Edit Product → Cost Price for accurate profit.</i>`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: adminProfitsKb() }
    );
    return;
  }
  if (data === 'admin_profit_7days') {
    const stats = db.getProfitLast7Days();
    await bot.editMessageText(
      `📆 ${formatProfitBlock('Last 7 Days Profit', stats)}`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: adminProfitsKb() }
    );
    return;
  }
  if (data === 'admin_profit_month') {
    const stats = db.getProfitThisMonth();
    await bot.editMessageText(
      `🗓 ${formatProfitBlock("This Month's Profit", stats)}`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: adminProfitsKb() }
    );
    return;
  }
  if (data === 'admin_profit_breakdown') {
    const rows = db.getProfitByDay();
    if (!rows.length) {
      await bot.editMessageText('📊 No sales data yet.', {
        chat_id: chatId, message_id: msgId, reply_markup: adminProfitsKb(),
      });
      return;
    }
    const lines = rows.map((r) => {
      return `📅 <b>${r.day}</b> — 📈 ${formatPrice(r.net_profit)} (${r.orders_count} orders, rev ${formatPrice(r.revenue)})`;
    }).join('\n');
    await bot.editMessageText(
      `📊 <b>Daily Net Profit Breakdown (Last 30 days)</b>\n\n${lines}`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: adminProfitsKb() }
    );
    return;
  }

  // ── Pre-Orders Main Menu ──────────────────────────────────────────
  if (data === 'admin_preorders') {
    const stats = db.getPreorderStats();
    await bot.editMessageText(
      `🔜 <b>Pre-Orders</b>\n\n` +
      `📊 Total: <b>${stats.total || 0}</b>\n` +
      `⏳ Reserved: <b>${stats.reserved || 0}</b>\n` +
      `✅ Delivered: <b>${stats.delivered || 0}</b>\n` +
      `💰 Total Revenue: <b>${formatPrice(stats.total_revenue || 0)}</b>`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: adminPreordersMainKb() }
    );
    return;
  }

  if (data === 'admin_preorders_list') {
    const all = db.getAllPreorders();
    if (!all.length) {
      await bot.editMessageText('🔜 No pre-orders yet.', {
        chat_id: chatId, message_id: msgId, reply_markup: adminPreordersMainKb(),
      });
      return;
    }
    await bot.editMessageText(
      `📋 <b>All Pre-Orders</b> (showing latest 15)`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: adminPreordersListKb(all) }
    );
    return;
  }

  if (data === 'admin_preorders_manage') {
    const products = db.getAllActiveProducts();
    if (!products.length) {
      await bot.editMessageText('📦 No products available.', {
        chat_id: chatId, message_id: msgId, reply_markup: adminPreordersMainKb(),
      });
      return;
    }
    await bot.editMessageText(
      `⚙️ <b>Manage Pre-Orders by Product</b>\n\n` +
      `Format: ✅ = enabled, ⚪ = disabled\n` +
      `(reserved / max)`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: adminPreorderProductsKb(products) }
    );
    return;
  }

  // ── Confirm pre-order delivery (after stock was added) ────────────
  if (/^admin_pre_confirm_deliver_\d+$/.test(data)) {
    const productId = parseInt(data.split('_').pop(), 10);
    const pending = db.getReservedPreordersByProduct(productId);
    if (!pending.length) {
      await bot.editMessageText('ℹ️ No pending pre-orders for this product.', {
        chat_id: chatId, message_id: msgId, reply_markup: adminBackKb(),
      });
      return;
    }
    const productLatest = db.getProduct(productId);
    let delivered = 0;
    let failed = 0;
    let lastError = null;

    for (const r of pending) {
      try {
        const itemContent = db.deliverOrder(0, productId, r.quantity, 'preorder', r.user_id);
        if (!itemContent) {
          failed++;
          continue;
        }
        db.markPreorderDelivered(r.id, itemContent);

        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const dateStr =
          pad(now.getDate()) + '/' + pad(now.getMonth() + 1) + '/' + now.getFullYear() +
          ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes());

        const instr = (productLatest && productLatest.instruction)
          ? `\n━━━━━━━━━━━━━━━━━━━━\n📌 <b>Instructions:</b>\n${escapeHtml(productLatest.instruction)}\n` : '';

        const msg =
          `🎉 <b>Your Pre-Order is Ready!</b>\n\n` +
          `📦 ${escapeHtml(productLatest?.title || '')} ×${r.quantity}\n` +
          (r.email ? `📧 ${escapeHtml(r.email)}\n` : '') +
          `💵 ${formatPrice(r.total_paid)}\n` +
          `📅 Delivered: ${dateStr}\n\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `🎁 <b>Your Product(s):</b>\n\n<code>${escapeHtml(itemContent)}</code>\n` +
          `━━━━━━━━━━━━━━━━━━━━${instr}\n` +
          `✨ Thank you for your patience!`;

        try {
          await bot.sendMessage(r.user_id, msg, { parse_mode: 'HTML' });
          delivered++;
          logger.info(`[PREORDER AUTO] Delivered preorder #${r.id} to user ${r.user_id}`);
        } catch (sendErr) {
          try {
            const plainMsg = msg.replace(/<\/?[^>]+>/g, '');
            await bot.sendMessage(r.user_id, plainMsg);
            delivered++;
          } catch (e2) {
            lastError = e2.message;
            failed++;
            logger.error(`[PREORDER AUTO FAIL] ${r.user_id}: ${e2.message}`);
          }
        }
      } catch (e) {
        lastError = e.message;
        failed++;
      }
    }

    await bot.editMessageText(
      `✅ <b>Pre-Order Delivery Complete</b>\n\n` +
      `📦 Product: ${escapeHtml(productLatest?.title || '')}\n` +
      `✅ Delivered: <b>${delivered}</b>\n` +
      (failed > 0 ? `⚠️ Failed: <b>${failed}</b>${lastError ? `\n(${escapeHtml(lastError)})` : ''}` : ''),
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🔙 Admin Panel', callback_data: 'admin_panel' }]] } }
    );
    return;
  }

  if (/^admin_pre_skip_deliver_\d+$/.test(data)) {
    await bot.editMessageText(
      `🚫 <b>Pre-Order delivery skipped.</b>\n\n` +
      `The stock you added remains in inventory.\n` +
      `You can deliver pre-orders manually from Pre-Orders → View All.`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🔙 Admin Panel', callback_data: 'admin_panel' }]] } }
    );
    return;
  }

  // ── Search User ───────────────────────────────────────────────────
  if (data === 'admin_user_search') {
    session.set(userId, States.ADMIN_USER_SEARCH, {});
    await bot.editMessageText(
      `🔍 <b>Search User</b>\n\n` +
      `Type any of:\n` +
      `• User ID (e.g. <code>5626665035</code>)\n` +
      `• @username (with or without @)\n` +
      `• First name or last name\n\n` +
      `Partial matches are supported.`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'admin_users' }]] } }
    );
    return;
  }

  // Setup pre-order for a specific product
  if (/^admin_pre_setup_\d+$/.test(data)) {
    const productId = parseInt(data.split('_').pop(), 10);
    const product = db.getProduct(productId);
    if (!product) { await answer('Not found'); return; }
    await bot.editMessageText(
      `⚙️ <b>Pre-Order: ${product.title}</b>\n\n` +
      `Status: ${product.preorder_enabled ? '✅ <b>ENABLED</b>' : '⚪ Disabled'}\n` +
      `Max Quantity: <b>${product.preorder_max || 0}</b>\n` +
      `Reserved So Far: <b>${product.preorder_count || 0}</b>\n` +
      `Remaining Slots: <b>${Math.max(0, (product.preorder_max || 0) - (product.preorder_count || 0))}</b>\n` +
      `Price: <b>${formatPrice(product.price)}</b>`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: adminPreorderSetupKb(productId, !!product.preorder_enabled) }
    );
    return;
  }

  // Toggle enable/disable
  if (/^admin_pre_toggle_\d+$/.test(data)) {
    const productId = parseInt(data.split('_').pop(), 10);
    const product = db.getProduct(productId);
    const newVal = product.preorder_enabled ? 0 : 1;
    db.updateProduct(productId, 'preorder_enabled', newVal);
    await answer(newVal ? '✅ Pre-Order enabled' : '❌ Pre-Order disabled');
    const updated = db.getProduct(productId);
    await bot.editMessageText(
      `⚙️ <b>Pre-Order: ${updated.title}</b>\n\n` +
      `Status: ${updated.preorder_enabled ? '✅ <b>ENABLED</b>' : '⚪ Disabled'}\n` +
      `Max Quantity: <b>${updated.preorder_max || 0}</b>\n` +
      `Reserved So Far: <b>${updated.preorder_count || 0}</b>\n` +
      `Remaining Slots: <b>${Math.max(0, (updated.preorder_max || 0) - (updated.preorder_count || 0))}</b>`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: adminPreorderSetupKb(productId, !!updated.preorder_enabled) }
    );
    return;
  }

  // Set max quantity
  if (/^admin_pre_setmax_\d+$/.test(data)) {
    const productId = parseInt(data.split('_').pop(), 10);
    const product = db.getProduct(productId);
    session.set(userId, States.ADMIN_PRE_SET_MAX, { preProductId: productId });
    await bot.editMessageText(
      `🔢 <b>Set Max Pre-Order Quantity</b>\n\n` +
      `Product: ${product.title}\n` +
      `Current max: <b>${product.preorder_max || 0}</b>\n\n` +
      `Enter new max quantity (number of slots customers can reserve):`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: `admin_pre_setup_${productId}` }]] } }
    );
    return;
  }

  // View reservations for a product
  if (/^admin_pre_reservations_\d+$/.test(data)) {
    const productId = parseInt(data.split('_').pop(), 10);
    const product = db.getProduct(productId);
    const reservations = db.getReservedPreordersByProduct(productId);
    if (!reservations.length) {
      await bot.editMessageText(
        `📋 <b>${product.title}</b>\n\nNo active reservations yet.`,
        { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: `admin_pre_setup_${productId}` }]] } }
      );
      return;
    }
    const lines = reservations.map((r, i) => {
      const name = r.username || r.first_name || `User ${r.user_id}`;
      const email = r.email ? `📧 ${r.email}` : '';
      return `${i+1}. <b>${name}</b> (<code>${r.user_id}</code>)\n` +
             `   Qty: ${r.quantity} | Paid: ${formatPrice(r.total_paid)} | ${(r.created_at || '').slice(0, 16)}\n` +
             (email ? `   ${email}\n` : '');
    }).join('\n');
    await bot.editMessageText(
      `📋 <b>Reservations for ${product.title}</b>\n\n${lines}`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [
          [{ text: '📦 Deliver All Now', callback_data: `admin_pre_deliverall_${productId}` }],
          [{ text: '🔙 Back', callback_data: `admin_pre_setup_${productId}` }],
        ] } }
    );
    return;
  }

  // Deliver all reservations of a product (uses available stock)
  if (/^admin_pre_deliverall_\d+$/.test(data)) {
    const productId = parseInt(data.split('_').pop(), 10);
    const product = db.getProduct(productId);
    const reservations = db.getReservedPreordersByProduct(productId);
    if (!reservations.length) {
      await answer('No reservations');
      return;
    }
    let delivered = 0;
    let failed    = 0;
    for (const r of reservations) {
      try {
        const content = db.deliverOrder(0, productId, r.quantity, 'preorder', r.user_id);
        if (!content) { failed++; continue; }
        db.markPreorderDelivered(r.id, content);

        // Send to user
        const purchaseDate = new Date().toLocaleString();
        const instr = product.instruction
          ? `\n━━━━━━━━━━━━━━━━━━━━\n📌 <b>Instructions:</b>\n${product.instruction}\n` : '';
        await bot.sendMessage(
          r.user_id,
          `🎉 <b>Your Pre-Order is Ready!</b>\n\n` +
          `📦 Order: ${product.title} ×${r.quantity}\n` +
          (r.email ? `📧 ${r.email}\n` : '') +
          `💵 ${formatPrice(r.total_paid)}\n` +
          `📅 Delivered: ${purchaseDate}\n\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `🎁 <b>Your Product(s):</b>\n\n${content}\n` +
          `━━━━━━━━━━━━━━━━━━━━${instr}\n` +
          `✨ Thank you for your patience!`,
          { parse_mode: 'HTML' }
        ).catch(() => {});

        delivered++;
      } catch (e) {
        logger.warn(`Pre-order deliver fail #${r.id}: ${e.message}`);
        failed++;
      }
    }
    await bot.editMessageText(
      `📦 <b>Bulk Delivery Complete</b>\n\n` +
      `✅ Delivered: ${delivered}\n` +
      `❌ Failed (out of stock): ${failed}`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: `admin_pre_setup_${productId}` }]] } }
    );
    return;
  }

  // Pre-order detail
  if (/^admin_pre_detail_\d+$/.test(data)) {
    const preId = parseInt(data.split('_').pop(), 10);
    const pr = db.getPreorderById(preId);
    if (!pr) { await answer('Not found'); return; }
    const product = db.getProduct(pr.product_id);
    const user = db.getUser(pr.user_id);
    const name = user?.username || user?.first_name || `User ${pr.user_id}`;

    // ── Product full details block ─────────────────────────────────
    let productBlock = '';
    if (product) {
      productBlock =
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `📦 <b>PRODUCT DETAILS</b>\n\n` +
        `🛒 <b>Name:</b> ${escapeHtml(product.title || '')}\n` +
        `📝 <b>Description:</b> ${escapeHtml((product.description || '').slice(0, 200))}\n` +
        `💵 <b>Price:</b> ${formatPrice(product.price)}\n` +
        (product.cost_price ? `💸 <b>Cost:</b> ${formatPrice(product.cost_price)}\n` : '') +
        `🛡 <b>Warranty:</b> ${product.warranty || 'N/A'}\n` +
        `📦 <b>Current Stock:</b> ${product.stock_quantity || 0}\n` +
        `📈 <b>Total Sales:</b> ${product.sales_count || 0}\n` +
        `🔜 <b>Pre-Order Reservations:</b> ${product.preorder_count || 0} / ${product.preorder_max || 0}\n` +
        (product.instruction ? `📌 <b>Instructions:</b>\n${escapeHtml(product.instruction.slice(0, 200))}\n` : '') +
        `━━━━━━━━━━━━━━━━━━━━\n`;
    }

    // Main info block (without delivered content)
    const mainText =
      `🔜 <b>Pre-Order #${pr.id}</b>\n\n` +
      `👤 <b>User:</b> ${escapeHtml(name)} (<code>${pr.user_id}</code>)\n` +
      `💰 <b>User Balance:</b> ${formatPrice(user?.balance || 0)}\n` +
      `🔢 <b>Quantity:</b> ${pr.quantity}\n` +
      (pr.email ? `📧 <b>Email:</b> ${escapeHtml(pr.email)}\n` : '') +
      `💵 <b>Paid:</b> ${formatPrice(pr.total_paid)}\n` +
      `💳 <b>Method:</b> ${pr.payment_method || 'n/a'}\n` +
      `📅 <b>Created:</b> ${(pr.created_at || '').slice(0, 16)}\n` +
      `📊 <b>Status:</b> ${pr.status.toUpperCase()}` +
      (pr.delivered_at ? `\n✅ <b>Delivered At:</b> ${(pr.delivered_at || '').slice(0, 16)}` : '') +
      `\n\n` + productBlock;

    // Send main info
    await bot.editMessageText(
      mainText,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: pr.status === 'delivered' ? undefined : adminPreorderDetailKb(pr.id, pr.status) }
    );

    // If delivered, send the full delivered content in separate messages (no truncation)
    if (pr.status === 'delivered' && pr.delivered_content) {
      const fullContent = pr.delivered_content;
      const MAX_CHUNK = 3500; // Safe Telegram chunk size

      // Header for delivered content
      await bot.sendMessage(
        chatId,
        `━━━━━━━━━━━━━━━━━━━━\n🎁 <b>Delivered Content (Full):</b>\n━━━━━━━━━━━━━━━━━━━━`,
        { parse_mode: 'HTML' }
      );

      // Split into chunks if too long
      for (let i = 0; i < fullContent.length; i += MAX_CHUNK) {
        const chunk = fullContent.slice(i, i + MAX_CHUNK);
        try {
          await bot.sendMessage(
            chatId,
            `<code>${escapeHtml(chunk)}</code>`,
            { parse_mode: 'HTML' }
          );
        } catch (e) {
          // Fallback: send plain text
          await bot.sendMessage(chatId, chunk).catch(() => {});
        }
      }

      // Footer with back button
      await bot.sendMessage(
        chatId,
        `━━━━━━━━━━━━━━━━━━━━\n📦 End of delivered content for Pre-Order #${pr.id}`,
        { parse_mode: 'HTML', reply_markup: adminPreorderDetailKb(pr.id, pr.status) }
      );
    }
    return;
  }

  // Deliver single pre-order — ASK ADMIN FOR THE CONTENT (manual delivery)
  if (/^admin_pre_deliver_\d+$/.test(data)) {
    const preId = parseInt(data.split('_').pop(), 10);
    const pr = db.getPreorderById(preId);
    if (!pr || pr.status !== 'reserved') { await answer('Not deliverable'); return; }
    const product = db.getProduct(pr.product_id);
    const user = db.getUser(pr.user_id);
    const name = user?.username || user?.first_name || `User ${pr.user_id}`;
    session.set(userId, States.ADMIN_PRE_SEND_CONTENT, { sendPreId: preId });
    logger.info(`[PREORDER DELIVER] Admin ${userId} preparing to send preorder #${preId} to user ${pr.user_id}`);
    await bot.editMessageText(
      `📦 <b>Send Pre-Order #${pr.id}</b>\n\n` +
      `👤 To: <b>${escapeHtml(name)}</b> (<code>${pr.user_id}</code>)\n` +
      `🛒 Product: ${escapeHtml(product?.title || '')}\n` +
      `🔢 Quantity: <b>${pr.quantity}</b>\n` +
      (pr.email ? `📧 Email: ${escapeHtml(pr.email)}\n` : '') +
      `💵 Paid: ${formatPrice(pr.total_paid)}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📝 <b>Now type the content to send to the customer.</b>\n\n` +
      `Example: Login email + password\n` +
      `Use # to separate multiple accounts if quantity > 1`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🔙 Cancel', callback_data: `admin_pre_detail_${preId}` }]] } }
    );
    return;
  }

  // Refund single pre-order
  if (/^admin_pre_refund_\d+$/.test(data)) {
    const preId = parseInt(data.split('_').pop(), 10);
    const pr = db.getPreorderById(preId);
    if (!pr || pr.status !== 'reserved') { await answer('Cannot refund'); return; }
    db.updateBalance(pr.user_id, pr.total_paid);
    db.addTransaction({
      userId:      pr.user_id,
      type:        'refund',
      amount:      pr.total_paid,
      description: `Pre-Order #${pr.id} refund`,
      refId:       null,
      orderId:     pr.order_id || null,
    });
    db.markPreorderRefunded(pr.id);
    db.incrementPreorderCount(pr.product_id, -pr.quantity);
    await bot.sendMessage(
      pr.user_id,
      `💸 Your pre-order #${pr.id} has been refunded.\n` +
      `Amount: <b>${formatPrice(pr.total_paid)}</b> added to your wallet.`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
    await answer('✅ Refunded');
    await bot.editMessageText(
      `💸 <b>Pre-Order #${pr.id} Refunded</b>`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'admin_preorders_list' }]] } }
    );
    return;
  }

  // ── Emoji Library ─────────────────────────────────────────────────
  // ── Emoji Picker (used during field editing) ──────────────────────
  if (data === 'admin_emoji_picker') {
    const emojis = db.getAllEmojis();
    if (!emojis.length) {
      await answer('Library is empty. Add emojis first.');
      return;
    }
    // Show as a grid of buttons (up to 30 emojis)
    const rows = [];
    let current = [];
    for (let i = 0; i < emojis.length && i < 30; i++) {
      const e = emojis[i];
      current.push({ text: `${e.fallback} ${e.name}`, callback_data: `admin_emoji_use_${e.id}` });
      if (current.length === 2) {
        rows.push(current);
        current = [];
      }
    }
    if (current.length) rows.push(current);
    rows.push([{ text: '🔙 Cancel', callback_data: 'admin_panel' }]);

    await bot.sendMessage(
      chatId,
      `🎨 <b>Pick an Emoji</b>\n\n` +
      `Tap one — the code will be sent to you as a copyable message.\n` +
      `<i>Then long-press it → Copy → paste into your text above.</i>`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } }
    );
    return;
  }

  // ── Use a specific emoji (sends it as copyable code) ──────────────
  if (/^admin_emoji_use_\d+$/.test(data)) {
    const emojiDbId = parseInt(data.split('_').pop(), 10);
    const emoji = db.getEmojiById(emojiDbId);
    if (!emoji) { await answer('Not found'); return; }
    const code = `[emoji:${emoji.emoji_id}]${emoji.fallback}`;
    await bot.sendMessage(
      chatId,
      `✅ <b>Tap below to copy:</b>\n\n` +
      `<code>${code}</code>\n\n` +
      `Preview: <tg-emoji emoji-id="${emoji.emoji_id}">${emoji.fallback}</tg-emoji>\n\n` +
      `👆 Long-press → Copy → paste into your text above.`,
      { parse_mode: 'HTML' }
    );
    await answer('✅ Copy from message above');
    return;
  }

  if (data === 'admin_emojis') {
    const emojis = db.getAllEmojis();
    const emptyKb = { inline_keyboard: [
      [{ text: '➕ Add New Emoji', callback_data: 'admin_emoji_add' }],
      [{ text: '🔙 Back', callback_data: 'admin_panel' }],
    ] };

    if (!emojis.length) {
      const emptyText = `🎨 <b>Emoji Library</b>\n\n📭 Empty.\n\nAdd premium emojis here to reuse them anywhere.\nType <code>/emojis</code> anytime to see your library.`;
      try {
        await bot.editMessageText(emptyText, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: emptyKb });
      } catch (e) {
        // Edit failed (was photo) - delete & send new
        try { await bot.deleteMessage(chatId, msgId); } catch (e2) {}
        await bot.sendMessage(chatId, emptyText, { parse_mode: 'HTML', reply_markup: emptyKb });
      }
      return;
    }

    // Build preview message with all emojis rendered live
    let preview = `🎨 <b>Emoji Library</b> (${emojis.length} emoji)\n\n`;
    preview += `Long-press any line to copy & paste it:\n\n`;
    for (const e of emojis) {
      preview += `<tg-emoji emoji-id="${e.emoji_id}">${e.fallback}</tg-emoji> <b>${escapeHtml(e.name)}</b>\n`;
      preview += `<code>[emoji:${e.emoji_id}]${e.fallback}</code>\n\n`;
    }

    try {
      await bot.editMessageText(preview, {
        chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: adminEmojiLibraryKb(emojis),
      });
    } catch (e) {
      // Edit failed - delete & send new
      try { await bot.deleteMessage(chatId, msgId); } catch (e2) {}
      await bot.sendMessage(chatId, preview, { parse_mode: 'HTML', reply_markup: adminEmojiLibraryKb(emojis) });
    }
    return;
  }

  if (data === 'admin_emoji_add') {
    session.set(userId, States.ADMIN_EMOJI_ADD, {});
    await bot.editMessageText(
      `➕ <b>Add Emoji to Library</b>\n\n` +
      `Send the emoji info in this format:\n\n` +
      `<code>name|EMOJI_ID|fallback_emoji</code>\n\n` +
      `<b>Example:</b>\n` +
      `<code>fire|5368324170671202286|🔥</code>\n` +
      `<code>gift|5345783234567890123|🎁</code>\n\n` +
      `<b>Tips:</b>\n` +
      `• <b>name</b>: short label (no spaces)\n` +
      `• <b>EMOJI_ID</b>: numeric ID from @emojiidbot\n` +
      `• <b>fallback</b>: emoji shown to non-Premium users`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🔙 Cancel', callback_data: 'admin_emojis' }]] } }
    );
    return;
  }

  if (/^admin_emoji_view_\d+$/.test(data)) {
    const emojiId = parseInt(data.split('_').pop(), 10);
    const emoji = db.getEmojiById(emojiId);
    if (!emoji) { await answer('Not found'); return; }
    await bot.sendMessage(
      chatId,
      `🎨 <b>${escapeHtml(emoji.name)}</b>\n\n` +
      `Preview: <tg-emoji emoji-id="${emoji.emoji_id}">${emoji.fallback}</tg-emoji>\n\n` +
      `Copy this and paste anywhere:\n` +
      `<code>[emoji:${emoji.emoji_id}]${emoji.fallback}</code>`,
      { parse_mode: 'HTML' }
    );
    await answer('Copied below ⬆');
    return;
  }

  if (/^admin_emoji_del_\d+$/.test(data)) {
    const emojiId = parseInt(data.split('_').pop(), 10);
    db.deleteEmoji(emojiId);
    await answer('✅ Deleted');
    // Refresh library view
    const emojis = db.getAllEmojis();
    if (!emojis.length) {
      await bot.editMessageText(
        `🎨 <b>Emoji Library</b>\n\n📭 Empty.`,
        { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [
            [{ text: '➕ Add New Emoji', callback_data: 'admin_emoji_add' }],
            [{ text: '🔙 Back', callback_data: 'admin_panel' }],
          ] } }
      );
      return;
    }
    let preview = `🎨 <b>Emoji Library</b> (${emojis.length} emoji)\n\n`;
    for (const e of emojis) {
      preview += `<tg-emoji emoji-id="${e.emoji_id}">${e.fallback}</tg-emoji> <b>${escapeHtml(e.name)}</b>\n`;
      preview += `<code>[emoji:${e.emoji_id}]${e.fallback}</code>\n\n`;
    }
    await bot.editMessageText(preview, {
      chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
      reply_markup: adminEmojiLibraryKb(emojis),
    });
    return;
  }

  // ── Refund Requests Panel ─────────────────────────────────────────
  if (data === 'admin_refund_requests' || /^admin_refund_tab_\w+_\d+$/.test(data)) {
    const allRequests = db.getAllRefundRequests();

    // Parse tab and page from callback
    let activeTab = 'pending';
    let page = 0;
    if (/^admin_refund_tab_\w+_\d+$/.test(data)) {
      const parts = data.split('_');
      // admin_refund_tab_{tab}_{page}
      page = parseInt(parts.pop(), 10) || 0;
      activeTab = parts.slice(3).join('_');
    }

    const pending    = allRequests.filter(r => r.status === 'pending');
    const processing = allRequests.filter(r => r.status === 'processing');
    const approved   = allRequests.filter(r => r.status === 'approved');
    const rejected   = allRequests.filter(r => r.status === 'rejected');

    const tabMap = { pending, processing, approved, rejected, all: allRequests };
    const shown  = tabMap[activeTab] || allRequests;

    const perPage = 10;
    const total   = shown.length;
    const slice   = shown.slice(page * perPage, (page + 1) * perPage);

    const statusEmoji = { pending: '⏳', processing: '🔃', approved: '✅', rejected: '❌' };
    const tabLabel    = { pending: '⏳ Pending', processing: '🔃 Processing', approved: '✅ Approved', rejected: '❌ Rejected', all: '📋 All' };

    let txt = `🔄 <b>Refund Requests</b>\n\n`;
    txt += `⏳ Pending: <b>${pending.length}</b>  🔃 Processing: <b>${processing.length}</b>\n`;
    txt += `✅ Approved: <b>${approved.length}</b>  ❌ Rejected: <b>${rejected.length}</b>\n`;
    txt += `📋 Total: <b>${allRequests.length}</b>\n\n`;
    txt += `<b>Showing: ${tabLabel[activeTab]}</b> (${total} requests)`;

    const rows = [];

    // Tab filter buttons
    const tabs = ['pending','processing','approved','rejected','all'];
    const tabRow1 = tabs.slice(0,3).map(t => ({
      text: (t === activeTab ? '✓ ' : '') + tabLabel[t],
      callback_data: `admin_refund_tab_${t}_0`
    }));
    const tabRow2 = tabs.slice(3).map(t => ({
      text: (t === activeTab ? '✓ ' : '') + tabLabel[t],
      callback_data: `admin_refund_tab_${t}_0`
    }));
    rows.push(tabRow1);
    rows.push(tabRow2);

    // Refund request buttons
    for (const r of slice) {
      const emoji = statusEmoji[r.status] || '🔄';
      const name  = r.username ? `@${r.username}` : (r.first_name || `User ${r.user_id}`);
      const amt   = Number(r.total_price || 0).toFixed(2);
      rows.push([{ text: `${emoji} #${r.id} · ${name.slice(0, 18)} · $${amt}`, callback_data: `admin_refund_view_${r.id}` }]);
    }

    // Pagination
    const navRow = [];
    if (page > 0)                           navRow.push({ text: '⬅️ Prev', callback_data: `admin_refund_tab_${activeTab}_${page - 1}` });
    if ((page + 1) * perPage < total)       navRow.push({ text: 'Next ➡️', callback_data: `admin_refund_tab_${activeTab}_${page + 1}` });
    if (navRow.length) rows.push(navRow);

    rows.push([{ text: '🔙 Back', callback_data: 'admin_panel' }]);

    try {
      await bot.editMessageText(txt, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } });
    } catch (e) {
      try { await bot.deleteMessage(chatId, msgId); } catch (e2) {}
      await bot.sendMessage(chatId, txt, { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } });
    }
    return;
  }

  if (/^admin_refund_view_\d+$/.test(data)) {
    const refundId = parseInt(data.split('_').pop(), 10);
    const r = db.getRefundRequestById(refundId);
    if (!r) { await answer('Not found'); return; }
    const user = db.getUser(r.user_id);
    const name = user?.username || user?.first_name || `User ${r.user_id}`;

    const statusEmoji = { pending: '⏳', approved: '✅', rejected: '❌' };
    let txt =
      `🔄 <b>Refund Request #${r.id}</b>\n\n` +
      `👤 <b>User:</b> ${escapeHtml(name)} (<code>${r.user_id}</code>)\n` +
      `💰 <b>Wallet:</b> ${formatPrice(user?.balance || 0)}\n\n` +
      `📦 <b>Order #${r.order_id}</b>\n` +
      `🛒 ${escapeHtml(r.product_title || 'Unknown')}\n` +
      `💵 <b>Order Total:</b> ${formatPrice(r.total_price || 0)}\n` +
      `📅 Order date: ${(r.order_date || '').slice(0, 16)}\n\n` +
      `📝 <b>Customer Reason:</b>\n${escapeHtml(r.reason || '(no reason)')}\n`;

    if (r.affected_account) {
      txt += `\n🔑 <b>Affected Account:</b>\n<code>${escapeHtml(r.affected_account)}</code>\n`;
    }
    if (r.refund_method) {
      txt += `\n💳 <b>Customer wants:</b> ${r.refund_method}`;
      if (r.crypto_network) txt += ` (${r.crypto_network})`;
      txt += `\n`;
    }
    if (r.wallet_address) {
      txt += `📍 <b>Refund address:</b>\n<code>${escapeHtml(r.wallet_address)}</code>\n`;
    }

    txt += `\n📊 Status: ${statusEmoji[r.status]} <b>${r.status.toUpperCase()}</b>\n`;
    txt += `📅 Requested: ${(r.created_at || '').slice(0, 16)}`;

    if (r.status !== 'pending') {
      txt += `\n📅 Resolved: ${(r.resolved_at || '').slice(0, 16)}`;
      if (r.admin_note) txt += `\n📝 Admin note: ${escapeHtml(r.admin_note)}`;
      if (r.amount) txt += `\n💵 Refunded: ${formatPrice(r.amount)}`;
    }

    if (r.photo_file_id) {
      txt += `\n\n📸 <i>Customer attached a screenshot — see below.</i>`;
    }

    // ── Warranty-based suggested amount ──────────────────────────────
    let suggestedAmount = null;
    let warrantyInfo = '';
    try {
      const order = db.getOrder(r.order_id);
      if (order) {
        const product = db.getProduct(order.product_id);
        const warranty = product?.warranty || '';
        const m = warranty.match(/(\d+)\s*(day|d|month|m|year|y)/i);
        if (m) {
          const num = parseInt(m[1], 10);
          const unit = m[2].toLowerCase();
          const totalDays = unit.startsWith('d') ? num : (unit.startsWith('m') ? num * 30 : num * 365);
          const orderDateStr = (order.paid_at || order.created_at || '').replace(' ', 'T');
          const orderDate = new Date(orderDateStr + (orderDateStr.endsWith('Z') ? '' : 'Z'));
          const now = new Date();
          const elapsedDays = Math.max(0, Math.floor((now - orderDate) / (24 * 3600 * 1000)));
          const remainingDays = Math.max(0, totalDays - elapsedDays);
          const ratio = totalDays > 0 ? (remainingDays / totalDays) : 0;
          suggestedAmount = Number((Number(r.total_price) * ratio).toFixed(2));
          warrantyInfo =
            `\n\n🛡 <b>Warranty Analysis:</b>\n` +
            `   Total: ${totalDays} day(s)\n` +
            `   Elapsed: ${elapsedDays} day(s)\n` +
            `   Remaining: ${remainingDays} day(s)\n` +
            `   💡 <b>Suggested refund:</b> ${formatPrice(suggestedAmount)} (${Math.round(ratio * 100)}%)`;
        }
      }
    } catch (e) {
      logger.warn(`Warranty calc failed: ${e.message}`);
    }
    txt += warrantyInfo;

    const kb = { inline_keyboard: [] };

    // Processing — show "Mark as Sent" button only
    if (r.status === 'processing') {
      kb.inline_keyboard.push([{ text: '✅ Mark as Sent (Confirm)', callback_data: `admin_refund_mark_sent_${r.id}` }]);
    }

    if (r.status === 'pending') {
      if (suggestedAmount !== null && suggestedAmount > 0 && suggestedAmount < Number(r.total_price)) {
        kb.inline_keyboard.push([{
          text: `💡 Auto-Refund ${formatPrice(suggestedAmount)} (warranty-based)`,
          callback_data: `admin_refund_auto_${r.id}`,
        }]);
      }
      kb.inline_keyboard.push([{ text: `✅ Approve FULL (${formatPrice(r.total_price || 0)})`, callback_data: `admin_refund_full_${r.id}` }]);
      kb.inline_keyboard.push([{ text: '💵 Approve CUSTOM Amount', callback_data: `admin_refund_custom_${r.id}` }]);
      kb.inline_keyboard.push([{ text: '❌ Reject', callback_data: `admin_refund_reject_${r.id}` }]);
    }
    kb.inline_keyboard.push([{ text: '🔙 Back', callback_data: 'admin_refund_requests' }]);

    try {
      try { await bot.deleteMessage(chatId, msgId); } catch (e) {}
      // Send photo first if exists
      if (r.photo_file_id) {
        try { await bot.sendPhoto(chatId, r.photo_file_id, { caption: '📸 Customer screenshot' }); } catch (e) {}
      }
      await bot.sendMessage(chatId, txt, { parse_mode: 'HTML', reply_markup: kb });
    } catch (e) {
      await bot.sendMessage(chatId, txt, { parse_mode: 'HTML', reply_markup: kb });
    }
    return;
  }

  // Approve FULL — pay full order_total to the customer's chosen method
  if (/^admin_refund_full_\d+$/.test(data)) {
    const refundId = parseInt(data.split('_').pop(), 10);
    const r = db.getRefundRequestById(refundId);
    if (!r || r.status !== 'pending') { await answer('❌ Already resolved'); return; }
    await processRefundApproval(bot, chatId, msgId, r, Number(r.total_price) || 0);
    return;
  }

  // Mark Refund as Sent (admin confirms manual transfer completed)
  if (/^admin_refund_mark_sent_\d+$/.test(data)) {
    const refundId = parseInt(data.split('_').pop(), 10);
    await handleMarkRefundSent(bot, chatId, msgId, refundId, query);
    return;
  }

    // Warranty-based auto-refund — ask confirmation first
  if (/^admin_refund_auto_\d+$/.test(data)) {
    const refundId = parseInt(data.split('_').pop(), 10);
    const r = db.getRefundRequestById(refundId);
    if (!r || r.status !== 'pending') { await answer('❌ Already resolved'); return; }

    // Recompute suggested amount
    let suggestedAmount = 0;
    let breakdown = '';
    try {
      const order = db.getOrder(r.order_id);
      const product = db.getProduct(order.product_id);
      const warranty = product?.warranty || '';
      const m = warranty.match(/(\d+)\s*(day|d|month|m|year|y)/i);
      if (m) {
        const num = parseInt(m[1], 10);
        const unit = m[2].toLowerCase();
        const totalDays = unit.startsWith('d') ? num : (unit.startsWith('m') ? num * 30 : num * 365);
        const orderDateStr = (order.paid_at || order.created_at || '').replace(' ', 'T');
        const orderDate = new Date(orderDateStr + (orderDateStr.endsWith('Z') ? '' : 'Z'));
        const elapsedDays = Math.max(0, Math.floor((new Date() - orderDate) / (24 * 3600 * 1000)));
        const remainingDays = Math.max(0, totalDays - elapsedDays);
        const ratio = totalDays > 0 ? (remainingDays / totalDays) : 0;
        suggestedAmount = Number((Number(r.total_price) * ratio).toFixed(2));
        breakdown =
          `🛡 Warranty: ${totalDays} days\n` +
          `⏰ Elapsed: ${elapsedDays} days\n` +
          `✨ Remaining: ${remainingDays} days (${Math.round(ratio * 100)}%)\n\n` +
          `💰 Order total: ${formatPrice(r.total_price)}\n` +
          `📐 Formula: ${remainingDays}/${totalDays} × ${formatPrice(r.total_price)}\n` +
          `= <b>${formatPrice(suggestedAmount)}</b>`;
      }
    } catch (e) {}

    if (suggestedAmount <= 0) {
      await answer('❌ Could not calculate (no warranty period)');
      return;
    }

    await bot.editMessageText(
      `💡 <b>Auto-Refund Calculation</b>\n\n` +
      breakdown + `\n\n` +
      `Do you want to refund <b>${formatPrice(suggestedAmount)}</b> to the customer?`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [
          [{ text: `✅ Yes, refund ${formatPrice(suggestedAmount)}`, callback_data: `admin_refund_auto_confirm_${refundId}_${Math.round(suggestedAmount * 100)}` }],
          [{ text: '🔙 No, go back', callback_data: `admin_refund_view_${refundId}` }],
        ] } }
    );
    return;
  }

  // Confirm warranty-based auto-refund: callback data has amount in cents
  if (/^admin_refund_auto_confirm_\d+_\d+$/.test(data)) {
    const parts = data.split('_');
    const refundId = parseInt(parts[4], 10);
    const cents = parseInt(parts[5], 10);
    const amount = cents / 100;
    const r = db.getRefundRequestById(refundId);
    if (!r || r.status !== 'pending') { await answer('❌ Already resolved'); return; }
    await processRefundApproval(bot, chatId, msgId, r, amount);
    return;
  }

  // Approve CUSTOM amount
  if (/^admin_refund_custom_\d+$/.test(data)) {
    const refundId = parseInt(data.split('_').pop(), 10);
    const r = db.getRefundRequestById(refundId);
    if (!r) { await answer('Not found'); return; }
    session.set(userId, States.ADMIN_REFUND_AMOUNT, { refundId });
    await bot.editMessageText(
      `💵 <b>Custom Refund Amount</b>\n\n` +
      `Order total: ${formatPrice(r.total_price || 0)}\n\n` +
      `Send the amount you want to refund (e.g. <code>2.50</code>):`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: `admin_refund_view_${refundId}` }]] } }
    );
    return;
  }

  // Approve refund → wallet
  if (/^admin_refund_approve_wallet_\d+$/.test(data)) {
    const refundId = parseInt(data.split('_').pop(), 10);
    const r = db.getRefundRequestById(refundId);
    if (!r || r.status !== 'pending') { await answer('❌ Already resolved'); return; }
    const amount = Number(r.total_price) || 0;

    // Add to wallet
    db.updateBalance(r.user_id, amount);
    db.addTransaction({
      userId: r.user_id, type: 'refund', amount: amount,
      description: `Refund for order #${r.order_id}`,
      refId: `refund_${refundId}`, orderId: r.order_id,
    });
    db.updateRefundRequest(refundId, 'approved', `Refunded to wallet: ${amount}$`, amount, 'wallet');

    try {
      await bot.sendMessage(r.user_id,
        `✅ <b>Your Refund Has Been Approved!</b>\n\n` +
        `🆔 Refund #${r.id}\n` +
        `📦 Order #${r.order_id}\n` +
        `💵 Refunded: <b>${formatPrice(amount)}</b>\n` +
        `💳 Method: Wallet\n\n` +
        `Your wallet balance has been updated.`,
        { parse_mode: 'HTML' }
      );
    } catch (e) {}

    await answer('✅ Refund approved');
    await bot.editMessageText(
      `✅ Refund #${refundId} approved and credited to wallet.`,
      { chat_id: chatId, message_id: msgId,
        reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'admin_refund_requests' }]] } }
    );
    return;
  }

  // Approve refund → USDT (mark as approved, admin sends manually)
  if (/^admin_refund_approve_usdt_\d+$/.test(data)) {
    const refundId = parseInt(data.split('_').pop(), 10);
    const r = db.getRefundRequestById(refundId);
    if (!r || r.status !== 'pending') { await answer('❌ Already resolved'); return; }
    const amount = Number(r.total_price) || 0;
    db.updateRefundRequest(refundId, 'approved', `Refunded ${amount}$ via USDT (manual transfer)`, amount, 'usdt');

    try {
      await bot.sendMessage(r.user_id,
        `✅ <b>Your Refund Has Been Approved!</b>\n\n` +
        `🆔 Refund #${r.id}\n` +
        `📦 Order #${r.order_id}\n` +
        `💵 Amount: <b>${formatPrice(amount)}</b>\n` +
        `💳 Method: USDT (manual transfer)\n\n` +
        `Our team will contact you for your USDT address.`,
        { parse_mode: 'HTML' }
      );
    } catch (e) {}

    await answer('✅ Approved (USDT)');
    await bot.editMessageText(
      `✅ Refund #${refundId} approved for USDT transfer.\n\n` +
      `📝 <b>Remember:</b> Contact the user via Support to get their USDT address.`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'admin_refund_requests' }]] } }
    );
    return;
  }

  if (/^admin_refund_reject_\d+$/.test(data)) {
    const refundId = parseInt(data.split('_').pop(), 10);
    const r = db.getRefundRequestById(refundId);
    if (!r || r.status !== 'pending') { await answer('❌ Already resolved'); return; }
    db.updateRefundRequest(refundId, 'rejected', 'Rejected by admin', 0, null);

    try {
      await bot.sendMessage(r.user_id,
        `❌ <b>Refund Request Rejected</b>\n\n` +
        `🆔 Refund #${r.id}\n` +
        `📦 Order #${r.order_id}\n\n` +
        `If you believe this is a mistake, please contact support.`,
        { parse_mode: 'HTML' }
      );
    } catch (e) {}

    await answer('❌ Rejected');
    await bot.editMessageText(
      `❌ Refund #${refundId} rejected. User notified.`,
      { chat_id: chatId, message_id: msgId,
        reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'admin_refund_requests' }]] } }
    );
    return;
  }

  // ── Deposit Cutoff Panel ──────────────────────────────────────────
  if (data === 'admin_cutoff') {
    const cutoff = parseInt(db.getSetting('deposit_cutoff_ms', '0'), 10);
    const cutoffDate = cutoff > 0 ? new Date(cutoff).toISOString().replace('T', ' ').slice(0, 19) : 'Not set';
    await bot.editMessageText(
      `🛡️ <b>Deposit Cutoff Protection</b>\n\n` +
      `Current cutoff: <b>${cutoffDate}</b> UTC\n\n` +
      `Any USDT deposit or Binance Pay transfer dated <b>BEFORE</b> this time will be rejected.\n\n` +
      `This prevents fraud where a user reuses an old TXID from before you started the bot.`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [
          [{ text: '🔄 Reset cutoff to NOW', callback_data: 'admin_cutoff_now' }],
          [{ text: '🔙 Back', callback_data: 'admin_panel' }],
        ] } }
    );
    return;
  }
  if (data === 'admin_cutoff_now') {
    const now = Date.now();
    db.setSetting('deposit_cutoff_ms', String(now));
    await answer('✅ Cutoff updated to NOW');
    await bot.editMessageText(
      `✅ <b>Cutoff Updated</b>\n\n` +
      `New cutoff: <b>${new Date(now).toISOString().replace('T', ' ').slice(0, 19)}</b> UTC\n\n` +
      `All deposits before this time will now be rejected.`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'admin_panel' }]] } }
    );
    return;
  }

    // ── VIP Control Panel ─────────────────────────────────────────────
  if (data === 'admin_vip_toggle') {
    const broadcastEnabled = db.getSetting('vip_auto_broadcast', '0') === '1';
    const systemEnabled = db.getSetting('vip_system_enabled', '1') === '1';
    const totalVips = db.countVIPs();
    await bot.editMessageText(
      `👑 <b>VIP Control Panel</b>\n\n` +
      `<b>1) VIP System:</b> ${systemEnabled ? '🟢 OPEN' : '🔴 CLOSED'}\n` +
      `<i>${systemEnabled ? 'New users can become VIP' : 'No new VIPs accepted'}</i>\n\n` +
      `<b>2) Auto Broadcast:</b> ${broadcastEnabled ? '🟢 ON' : '🔴 OFF'}\n` +
      `<i>Every 30min posts VIP invite to channel & group</i>\n\n` +
      `📊 <b>Stats:</b>\n` +
      `• Current VIPs: <b>${totalVips}</b>\n` +
      `• VIP Limit: <b>${parseInt(db.getSetting('vip_limit', '1000'), 10).toLocaleString()}</b>\n` +
      `• Slots: <b>${Math.max(0, parseInt(db.getSetting('vip_limit', '1000'), 10) - totalVips)}</b>\n` +
      `• Broadcast Interval: <b>${db.getSetting('vip_broadcast_interval_min', '30')} min</b>`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [
          systemEnabled
            ? [{ text: '🔴 CLOSE VIP System', callback_data: 'admin_vip_system_off' }]
            : [{ text: '🟢 OPEN VIP System', callback_data: 'admin_vip_system_on' }],
          broadcastEnabled
            ? [{ text: '🔴 Turn OFF Broadcast', callback_data: 'admin_vip_off' }]
            : [{ text: '🟢 Turn ON Broadcast', callback_data: 'admin_vip_on' }],
          [{ text: '📢 Post Now', callback_data: 'admin_vip_post_now' }],
          [{ text: '🖼 Set VIP Image', callback_data: 'admin_vip_image' }],
          [{ text: '🔢 Edit VIP Limit', callback_data: 'admin_vip_limit' }],
          [{ text: '⏱ Edit Broadcast Interval', callback_data: 'admin_vip_interval' }],
          [
            { text: db.getSetting('referral_enabled', '1') === '1' ? '🔴 Disable Referral' : '🟢 Enable Referral', callback_data: 'admin_referral_toggle' },
            { text: db.getSetting('vip_new_only', '0') === '1' ? '👥 Allow All' : '🆕 New Only', callback_data: 'admin_vip_new_only_toggle' },
          ],
          [{ text: '💰 VIP Earnings Stats', callback_data: 'admin_vip_stats' }],
          [{ text: '🔙 Back', callback_data: 'admin_panel' }],
        ] } }
    );
    return;
  }
  if (data === 'admin_vip_limit') {
    session.set(userId, States.ADMIN_VIP_LIMIT, {});
    const current = parseInt(db.getSetting('vip_limit', '1000'), 10);
    await bot.editMessageText(
      `🔢 <b>Edit VIP Limit</b>\n\n` +
      `Current limit: <b>${current.toLocaleString()}</b>\n\n` +
      `Send the new VIP limit (e.g. <code>2000</code>):\n\n` +
      `<i>This is the maximum number of customers who can become VIP.</i>`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🔙 Cancel', callback_data: 'admin_vip_toggle' }]] } }
    );
    return;
  }

    if (data === 'admin_vip_interval') {
    session.set(userId, States.ADMIN_VIP_INTERVAL, {});
    const current = db.getSetting('vip_broadcast_interval_min', '30');
    await bot.editMessageText(
      `⏱ <b>Edit Broadcast Interval</b>\n\n` +
      `Current: <b>${current} minutes</b>\n\n` +
      `Send the new interval in minutes (e.g. <code>60</code> for 1 hour, <code>120</code> for 2 hours):\n\n` +
      `<i>Minimum: 5 minutes. Maximum: 1440 (24 hours).</i>`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🔙 Cancel', callback_data: 'admin_vip_toggle' }]] } }
    );
    return;
  }

    if (data === 'admin_vip_image') {
    session.set(userId, States.ADMIN_VIP_IMAGE, {});
    const currentImg = db.getSetting('vip_image_file_id', '');
    await bot.editMessageText(
      `🖼 <b>Set VIP Broadcast Image</b>\n\n` +
      (currentImg ? '✅ Image is currently set.\n\n' : '❌ No image set yet.\n\n') +
      `Send a photo to use in VIP broadcasts (channel, group, intro).\n\n` +
      `Type <code>clear</code> to remove the image.`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'admin_vip_toggle' }]] } }
    );
    return;
  }

  // ── 🕵️ AUDIT: Find users who paid → got product AND got money in wallet ─────
  if (data === 'admin_audit_wallets') {
    const dbRaw = require('../database/db');
    // BUG PATTERN: deposit + same order delivered = customer paid once, got product + wallet credit
    // We find all deposits linked to a DELIVERED order
    // (For wallet top-ups: order_id is NULL, so they're excluded)
    const suspicious = dbRaw.prepare(`
      SELECT 
        t.user_id, 
        u.username, 
        u.first_name, 
        u.balance,
        SUM(t.amount) AS total_credited,
        COUNT(DISTINCT t.order_id) AS orders_count,
        COUNT(*) AS bug_count,
        GROUP_CONCAT(DISTINCT t.order_id) AS order_ids
      FROM transactions t
      LEFT JOIN users u ON t.user_id = u.telegram_id
      LEFT JOIN orders o ON t.order_id = o.id
      WHERE t.type = 'deposit'
        AND t.order_id IS NOT NULL
        AND o.id IS NOT NULL
        AND (
          t.description LIKE '%Underpayment%' OR
          t.description LIKE '%Out-of-stock%' OR
          t.description LIKE '%Overpayment%' OR
          t.description LIKE '%refund%(Order%' OR
          t.description LIKE '%(Order #%'
        )
        AND t.description NOT LIKE '%top-up%'
        AND t.description NOT LIKE '%admin%'
        AND t.description NOT LIKE '%Referral%'
      GROUP BY t.user_id
      ORDER BY total_credited DESC
      LIMIT 30
    `).all();

    let txt = `🕵️ <b>Wallet Bug Audit</b>\n\n`;
    if (!suspicious.length) {
      txt += `✅ <b>No suspicious wallet credits detected.</b>\n\n`;
      txt += `<i>This audit finds users who got money in their wallet from the CryptoBot/Binance/USDT payment bug (underpayment, overpayment, or out-of-stock during direct payment).</i>`;
    } else {
      txt += `Found <b>${suspicious.length}</b> user(s) with suspicious wallet credits.\n\n`;
      let totalLost = 0;
      suspicious.slice(0, 15).forEach((s, i) => {
        const name = s.username ? '@' + s.username : (s.first_name || `User ${s.user_id}`);
        const credited = Number(s.total_credited) || 0;
        const balance = Number(s.balance) || 0;
        totalLost += credited;
        const orderIds = (s.order_ids || '').split(',').slice(0, 5).join(', #');
        txt += `${i+1}. ${escapeHtml(name)}\n`;
        txt += `   ID: <code>${s.user_id}</code>\n`;
        txt += `   🐛 Stolen: <b>${formatPrice(credited)}</b> from ${s.orders_count} order(s)\n`;
        txt += `   📦 Orders: #${orderIds}\n`;
        txt += `   💰 Current balance: <b>${formatPrice(balance)}</b>\n\n`;
      });
      if (suspicious.length > 15) {
        txt += `<i>... and ${suspicious.length - 15} more</i>\n\n`;
      }
      txt += `\n💸 <b>Total bug credits: ${formatPrice(totalLost)}</b>`;
    }

    await bot.editMessageText(txt, {
      chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [
        ...(suspicious.length > 0 ? [[
          { text: '⚠️ Deduct ALL bug credits', callback_data: 'admin_audit_deduct_all' }
        ]] : []),
        [{ text: '🔙 Back to Admin', callback_data: 'admin_panel' }]
      ] }
    }).catch(() => {});
    return;
  }

  // ── Deduct all bug credits from suspicious wallets ──────────────────
  if (data === 'admin_audit_deduct_all') {
    const dbRaw = require('../database/db');
    const suspicious = dbRaw.prepare(`
      SELECT t.user_id, SUM(t.amount) AS total_credited
      FROM transactions t
      WHERE t.type = 'deposit'
        AND t.order_id IS NOT NULL
        AND (
          t.description LIKE '%Underpayment refunded%' OR
          t.description LIKE '%Out-of-stock refund%' OR
          t.description LIKE '%Overpayment credit%'
        )
      GROUP BY t.user_id
    `).all();

    let totalDeducted = 0;
    let usersAffected = 0;
    const txDeduct = dbRaw.transaction(() => {
      for (const s of suspicious) {
        const amount = Number(s.total_credited) || 0;
        if (amount <= 0) continue;
        // Get current balance
        const u = dbRaw.prepare(`SELECT balance FROM users WHERE telegram_id=?`).get(s.user_id);
        if (!u) continue;
        const currentBal = Number(u.balance) || 0;
        // Deduct only what's available (don't go negative)
        const deduct = Math.min(amount, currentBal);
        if (deduct > 0) {
          dbRaw.prepare(`UPDATE users SET balance = balance - ? WHERE telegram_id=?`).run(deduct, s.user_id);
          dbRaw.prepare(`
            INSERT INTO transactions (user_id, type, amount, description)
            VALUES (?, 'admin_adjust', ?, ?)
          `).run(s.user_id, -deduct, `Bug credit reversal (admin audit)`);
          totalDeducted += deduct;
          usersAffected++;
        }
      }
    });
    txDeduct();

    await bot.editMessageText(
      `✅ <b>Bug Credits Reversed</b>\n\n` +
      `👥 Users affected: <b>${usersAffected}</b>\n` +
      `💸 Total deducted: <b>${formatPrice(totalDeducted)}</b>\n\n` +
      `<i>Note: For users whose balance was lower than the bug credit, only the available balance was deducted.</i>`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'admin_panel' }]] } }
    ).catch(() => {});
    logger.info(`[ADMIN] Reversed ${formatPrice(totalDeducted)} from ${usersAffected} users (bug audit)`);
    return;
  }


  // ════════════════════════════════════════════════════════
  // 🗂 CATEGORIES MANAGEMENT
  // ════════════════════════════════════════════════════════
  if (data === 'admin_categories') {
    const categories = db.getAllCategories();
    let txt = `🗂 <b>Categories Management</b>\n\nTotal: ${categories.length}\n\n`;
    const rows = categories.map(c => {
      const productsCount = db.getProductsByCategory(c.id).length;
      return [{ text: `${c.emoji || '📂'} ${c.name} (${productsCount})`, callback_data: `admin_cat_edit_${c.id}` }];
    });
    if (categories.length === 0) txt += '<i>No categories yet. Create one!</i>';
    rows.push([{ text: '➕ New Category', callback_data: 'admin_cat_new' }]);
    rows.push([{ text: '🔙 Back', callback_data: 'admin_panel' }]);
    await bot.editMessageText(txt, {
      chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
      reply_markup: { inline_keyboard: rows },
    }).catch(() => {});
    return;
  }

  if (data === 'admin_cat_new') {
    session.set(userId, 'ADMIN_CAT_NEW_NAME', {});
    await bot.sendMessage(chatId,
      '➕ <b>New Category</b>\n\nSend the category name (can include emoji at start):\n\nExamples:\n• <code>🤖 AI Tools</code>\n• <code>🎬 Streaming</code>\n• <code>📧 Email</code>',
      { parse_mode: 'HTML' });
    return;
  }

  if (/^admin_cat_edit_\d+$/.test(data)) {
    const catId = parseInt(data.split('_').pop(), 10);
    const cat = db.getCategoryById(catId);
    if (!cat) { await answer('❌ Not found'); return; }
    const products = db.getProductsByCategory(catId);
    let txt = `🗂 <b>${escapeHtml(cat.emoji || '')} ${escapeHtml(cat.name)}</b>\n\n`;
    txt += `📦 Products: <b>${products.length}</b>\n`;
    if (products.length) {
      txt += '\n<b>Products in this category:</b>\n';
      products.slice(0, 15).forEach(p => {
        txt += `• ${escapeHtml(p.title.slice(0, 40))}\n`;
      });
    }
    await bot.editMessageText(txt, {
      chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [
        [{ text: '✏️ Rename', callback_data: `admin_cat_rename_${catId}` }],
        [{ text: '🗑 Delete Category', callback_data: `admin_cat_delete_${catId}` }],
        [{ text: '🔙 Back', callback_data: 'admin_categories' }],
      ] },
    }).catch(() => {});
    return;
  }

  if (/^admin_cat_rename_\d+$/.test(data)) {
    const catId = parseInt(data.split('_').pop(), 10);
    session.set(userId, 'ADMIN_CAT_RENAME', { catId });
    await bot.sendMessage(chatId,
      '✏️ Send the new name (can include emoji):',
      { parse_mode: 'HTML' });
    return;
  }

  if (/^admin_cat_delete_\d+$/.test(data)) {
    const catId = parseInt(data.split('_').pop(), 10);
    db.deleteCategory(catId);
    await answer('🗑 Category deleted');
    return await handleAdminCallback(bot, { ...query, data: 'admin_categories' });
  }

  // Edit product → assign category
  if (/^admin_assigncat_\d+$/.test(data)) {
    const productId = parseInt(data.split('_').pop(), 10);
    const categories = db.getAllCategories();
    const product = db.getProduct(productId);
    let txt = `🗂 <b>Assign Category</b>\n\nProduct: <b>${escapeHtml(product?.title || '')}</b>\n\n`;
    txt += `Current: ${product?.category_id ? (db.getCategoryById(product.category_id)?.name || 'Unknown') : '(none)'}\n\nSelect:`;
    const rows = categories.map(c => [{
      text: `${c.emoji || '📂'} ${c.name}`,
      callback_data: `admin_setcat_${productId}_${c.id}`,
    }]);
    rows.push([{ text: '❌ Remove from category', callback_data: `admin_setcat_${productId}_0` }]);
    rows.push([{ text: '🔙 Back', callback_data: `admin_edit_p_${productId}` }]);
    await bot.editMessageText(txt, {
      chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
      reply_markup: { inline_keyboard: rows },
    }).catch(() => {});
    return;
  }

  if (/^admin_setcat_\d+_\d+$/.test(data)) {
    const parts = data.split('_');
    const productId = parseInt(parts[2], 10);
    const catId = parseInt(parts[3], 10);
    db.setProductCategory(productId, catId);
    await answer('✅ Category set');
    return await handleAdminCallback(bot, { ...query, data: `admin_edit_p_${productId}` });
  }


  // ── Toggle ChatGPT Business mode for a product ──
  if (/^admin_toggle_cgb_\d+$/.test(data)) {
    const productId = parseInt(data.split('_').pop(), 10);
    const product = db.getProduct(productId);
    if (!product) { await answer('❌ Not found'); return; }
    const newVal = product.is_chatgpt_business ? 0 : 1;
    const dbRaw = require('../database/db');
    dbRaw.prepare('UPDATE products SET is_chatgpt_business=? WHERE id=?').run(newVal, productId);
    await answer(newVal ? '✅ ChatGPT Business Mode ON' : '❌ Mode OFF', true);
    return await handleAdminCallback(bot, { ...query, data: `admin_edit_p_${productId}` });
  }

  // ── ChatGPT Business main panel ──
  if (data === 'admin_cgb_panel') {
    const cycles = db.getBillingCycles();
    const dbRaw = require('../database/db');
    const price = parseFloat((dbRaw.prepare(`SELECT value FROM settings WHERE key='chatgpt_monthly_price'`).get()?.value) || '50');
    const stats = db.getCgbStats();

    let txt = `🤖 <b>ChatGPT Business — Admin Panel</b>\n\n`;
    txt += `💰 Monthly Price: <b>$${price.toFixed(2)}</b>\n`;
    txt += `📅 Active Billing Cycles: <b>${cycles.length}</b>\n\n`;
    txt += `━━━━━━━━━━━━━━━━━\n`;
    txt += `📊 <b>Subscriptions</b>\n`;
    txt += `  🟢 Active: <b>${stats.active}</b>\n`;
    txt += `  ⏳ Awaiting Activation: <b>${stats.awaitingActivation}</b>\n`;
    txt += `  📦 Total All-Time: <b>${stats.total}</b>\n`;
    if (stats.expiringSoon > 0) {
      txt += `  ⚠️ Expiring in 7 days: <b>${stats.expiringSoon}</b>\n`;
    }
    txt += `\n💵 <b>Revenue</b>\n`;
    txt += `  📅 This Month: <b>$${Number(stats.revenueThisMonth).toFixed(2)}</b>\n`;
    txt += `  💰 All-Time: <b>$${Number(stats.totalRevenue).toFixed(2)}</b>\n`;

    await bot.editMessageText(txt, {
      chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [
        [{ text: '📊 Recent Orders', callback_data: 'admin_cgb_stats' }],
        [{ text: '📋 Active Subscriptions', callback_data: 'admin_cgb_active' }],
        [{ text: '💰 Set Monthly Price', callback_data: 'admin_cgb_setprice' }],
        [{ text: '📅 Manage Cycles', callback_data: 'admin_cgb_cycles' }],
        [{ text: '🔙 Back', callback_data: 'admin_panel' }],
      ] }
    }).catch(() => {});
    return;
  }

  // ── CGB Full Stats / Recent Orders ──
  if (data === 'admin_cgb_stats') {
    const stats = db.getCgbStats();
    const payMethodLabel = (m) => ({
      pay_binance:   '🟡 Binance Pay',
      pay_bep20:     '💎 USDT BEP20',
      pay_trc20:     '💎 USDT TRC20',
      pay_cryptobot: '🤖 CryptoBot',
    }[m] || (m || '—'));

    const sEmoji = (s) => ({ active: '🟢', pending: '⏳', cancelled: '🔴' }[s] || '⚪');

    let txt = `📊 <b>ChatGPT Business — All Orders (Last 10)</b>\n\n`;
    txt += `🟢 Active: <b>${stats.active}</b>  ⏳ Pending: <b>${stats.pending}</b>  📦 Total: <b>${stats.total}</b>\n`;
    txt += `💵 Revenue this month: <b>$${Number(stats.revenueThisMonth).toFixed(2)}</b>\n`;
    txt += `💰 Revenue all-time: <b>$${Number(stats.totalRevenue).toFixed(2)}</b>\n`;
    if (stats.expiringSoon > 0) {
      txt += `⚠️ Expiring in 7 days: <b>${stats.expiringSoon}</b>\n`;
    }
    txt += `\n━━━━━━━━━━━━━━━━━\n\n`;

    if (!stats.recentOrders.length) {
      txt += '<i>No orders yet.</i>';
    } else {
      stats.recentOrders.forEach((r, i) => {
        const date = r.created_at ? r.created_at.slice(0, 10) : '—';
        txt += `${i + 1}. ${sEmoji(r.status)} <b>#${r.order_id}</b> — <code>${escapeHtml(r.email || '')}</code>\n`;
        txt += `   💵 <b>$${Number(r.final_price).toFixed(2)}</b> · ${payMethodLabel(r.payment_method)}\n`;
        txt += `   📅 Until: ${r.end_date} · 🗓 Ordered: ${date}\n\n`;
      });
    }

    // Telegram message limit — trim if too long
    if (txt.length > 4000) txt = txt.slice(0, 3990) + '\n<i>…truncated</i>';

    await bot.editMessageText(txt, {
      chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [
        [{ text: '📋 Active Subscriptions', callback_data: 'admin_cgb_active' }],
        [{ text: '🔙 Back', callback_data: 'admin_cgb_panel' }],
      ] }
    }).catch(() => {});
    return;
  }

  // ── Set Monthly Price ──
  if (data === 'admin_cgb_setprice') {
    session.set(userId, 'ADMIN_CGB_PRICE', {});
    await bot.sendMessage(chatId,
      '💰 <b>Set Monthly Price</b>\n\nEnter the new monthly price in USD (e.g. <code>50</code>):',
      { parse_mode: 'HTML' });
    return;
  }

  // ── Manage Cycles ──
  if (data === 'admin_cgb_cycles') {
    const cycles = db.getBillingCycles();
    let txt = `📅 <b>Billing Cycles</b>\n\n`;
    if (!cycles.length) txt += '<i>No cycles configured.</i>';
    const rows = cycles.map(c => [{
      text: `🗑 Delete: Day ${c.start_day} → Day ${c.end_day}`,
      callback_data: `admin_cgb_delcycle_${c.id}`
    }]);
    rows.push([{ text: '➕ Add Cycle', callback_data: 'admin_cgb_addcycle' }]);
    rows.push([{ text: '🔙 Back', callback_data: 'admin_cgb_panel' }]);
    await bot.editMessageText(txt, {
      chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
      reply_markup: { inline_keyboard: rows }
    }).catch(() => {});
    return;
  }

  if (data === 'admin_cgb_addcycle') {
    session.set(userId, 'ADMIN_CGB_ADDCYCLE', {});
    await bot.sendMessage(chatId,
      '📅 <b>Add Billing Cycle</b>\n\nSend in format <code>START-END</code>\n' +
      'Example: <code>26-25</code> (cycle from day 26 to day 25 of next month)\n' +
      'Example: <code>1-30</code> (cycle from day 1 to day 30)',
      { parse_mode: 'HTML' });
    return;
  }

  if (/^admin_cgb_delcycle_\d+$/.test(data)) {
    const cycleId = parseInt(data.split('_').pop(), 10);
    db.removeBillingCycle(cycleId);
    await answer('🗑 Deleted', true);
    return await handleAdminCallback(bot, { ...query, data: 'admin_cgb_cycles' });
  }

  // ── Active Subscriptions ──
  if (data === 'admin_cgb_active') {
    const active = db.getActiveCgbSubs();
    let txt = `📊 <b>Active Subscriptions (${active.length})</b>\n\n`;
    if (!active.length) txt += '<i>No active subscriptions.</i>';
    active.slice(0, 20).forEach((s, i) => {
      txt += `${i+1}. Order #${s.order_id} — <code>${escapeHtml(s.email || '')}</code>\n`;
      txt += `   Until: ${s.end_date} | $${Number(s.final_price).toFixed(2)}\n\n`;
    });
    await bot.editMessageText(txt, {
      chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'admin_cgb_panel' }]] }
    }).catch(() => {});
    return;
  }


  // ════════════════════════════════════════════════════════
  // 🏪 RESELLERS MANAGEMENT
  // ════════════════════════════════════════════════════════
  if (data === 'admin_resellers') {
    const resellers = db.getAllResellers();
    let txt = `🏪 <b>Resellers</b>\n\nTotal: ${resellers.length}\n\n`;
    const rows = resellers.slice(0, 20).map(r => {
      const status = r.is_active ? '✅' : '🚫';
      return [{
        text: `${status} ${r.name} — $${Number(r.balance).toFixed(2)} (${r.orders_count})`,
        callback_data: `admin_reseller_${r.id}`
      }];
    });
    rows.push([{ text: '➕ Add New Reseller', callback_data: 'admin_reseller_new' }]);
    rows.push([{ text: '📖 API Docs URL', callback_data: 'admin_reseller_docs' }]);
    rows.push([{ text: '🔙 Back', callback_data: 'admin_panel' }]);

    await bot.editMessageText(txt, {
      chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
      reply_markup: { inline_keyboard: rows }
    }).catch(() => {});
    return;
  }

  if (data === 'admin_reseller_new') {
    session.set(userId, 'ADMIN_RESELLER_NEW_NAME', {});
    await bot.sendMessage(chatId,
      '➕ <b>New Reseller</b>\n\nSend the reseller name (e.g. <code>MyShop Reseller</code>):',
      { parse_mode: 'HTML' });
    return;
  }

  if (data === 'admin_reseller_docs') {
    const url = process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/api/v1/docs`
      : 'https://your-railway-url.up.railway.app/api/v1/docs';
    await bot.sendMessage(chatId,
      `📖 <b>API Documentation</b>\n\nShare this URL with your resellers:\n\n<code>${url}</code>`,
      { parse_mode: 'HTML' });
    return;
  }

  if (/^admin_reseller_\d+$/.test(data)) {
    const id = parseInt(data.split('_').pop(), 10);
    const r = db.getResellerById(id);
    if (!r) { await answer('❌ Not found'); return; }

    let txt = `🏪 <b>${escapeHtml(r.name)}</b>\n\n`;
    txt += `🔑 API Key:\n<code>${escapeHtml(r.api_key)}</code>\n\n`;
    txt += `💰 Balance: <b>$${Number(r.balance).toFixed(2)}</b>\n`;
    txt += `💵 Total Spent: <b>$${Number(r.total_spent).toFixed(2)}</b>\n`;
    txt += `📦 Orders: <b>${r.orders_count}</b>\n`;
    txt += `Status: ${r.is_active ? '✅ Active' : '🚫 Inactive'}\n`;
    txt += `Created: ${(r.created_at || '').slice(0, 16)}`;

    await bot.editMessageText(txt, {
      chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [
        [{ text: '💰 Add Balance', callback_data: `admin_reseller_balance_${id}` }],
        [{ text: '📦 View Orders', callback_data: `admin_reseller_orders_${id}` }],
        [{ text: r.is_active ? '🚫 Deactivate' : '✅ Activate', callback_data: `admin_reseller_toggle_${id}` }],
        [{ text: '🗑 Delete', callback_data: `admin_reseller_delete_${id}` }],
        [{ text: '🔙 Back', callback_data: 'admin_resellers' }],
      ] }
    }).catch(() => {});
    return;
  }

  if (/^admin_reseller_balance_\d+$/.test(data)) {
    const id = parseInt(data.split('_').pop(), 10);
    session.set(userId, 'ADMIN_RESELLER_BALANCE', { resellerId: id });
    await bot.sendMessage(chatId,
      '💰 Enter amount to add (e.g. <code>10</code>) or negative to subtract (<code>-5</code>):',
      { parse_mode: 'HTML' });
    return;
  }

  if (/^admin_reseller_toggle_\d+$/.test(data)) {
    const id = parseInt(data.split('_').pop(), 10);
    const r = db.getResellerById(id);
    if (!r) return;
    db.toggleReseller(id, r.is_active ? 0 : 1);
    await answer(r.is_active ? '🚫 Deactivated' : '✅ Activated', true);
    return await handleAdminCallback(bot, { ...query, data: `admin_reseller_${id}` });
  }

  if (/^admin_reseller_delete_\d+$/.test(data)) {
    const id = parseInt(data.split('_').pop(), 10);
    db.deleteReseller(id);
    await answer('🗑 Deleted', true);
    return await handleAdminCallback(bot, { ...query, data: 'admin_resellers' });
  }

  if (/^admin_reseller_orders_\d+$/.test(data)) {
    const id = parseInt(data.split('_').pop(), 10);
    const orders = db.getResellerOrders(id);
    let txt = `📦 <b>Orders (${orders.length})</b>\n\n`;
    orders.slice(0, 15).forEach(o => {
      txt += `#${o.id} • ${escapeHtml((o.product_title || '').slice(0, 30))}\n`;
      txt += `   ${o.quantity}× × $${Number(o.unit_price).toFixed(2)} = $${Number(o.total).toFixed(2)}\n`;
      txt += `   ${o.created_at?.slice(0, 16)}\n\n`;
    });
    if (!orders.length) txt += '<i>No orders yet.</i>';
    await bot.editMessageText(txt, {
      chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: `admin_reseller_${id}` }]] }
    }).catch(() => {});
    return;
  }

  // Set wholesale price (used from product edit menu)
  if (/^admin_edit_field_\d+_wholesale_price$/.test(data)) {
    const m = data.match(/^admin_edit_field_(\d+)_wholesale_price$/);
    const productId = parseInt(m[1], 10);
    session.set(userId, 'ADMIN_EDIT_FIELD', { productId, field: 'wholesale_price' });
    await bot.sendMessage(chatId,
      '🏪 <b>Wholesale Price</b>\n\nEnter the wholesale price (for resellers).\nExample: <code>4.50</code>\nUse <code>0</code> to disable resale for this product.',
      { parse_mode: 'HTML' });
    return;
  }


  // ── 🚨 SPECIFIC: Out-of-Stock Exploit Audit ──────────────────────
  if (data === 'admin_audit_oos') {
    const dbRaw = require('../database/db');
    // Find deposits with descriptions matching the OOS exploit
    const suspicious = dbRaw.prepare(`
      SELECT 
        t.user_id, 
        u.username, 
        u.first_name, 
        u.balance,
        SUM(t.amount) AS total_credited,
        COUNT(DISTINCT t.order_id) AS orders_count,
        GROUP_CONCAT(DISTINCT t.order_id) AS order_ids,
        MIN(t.created_at) AS first_exploit,
        MAX(t.created_at) AS last_exploit
      FROM transactions t
      LEFT JOIN users u ON t.user_id = u.telegram_id
      WHERE (t.type = 'deposit' OR t.type = 'refund')
        AND t.order_id IS NOT NULL
        AND (
          t.description LIKE '%Out-of-stock%' OR
          t.description LIKE '%out of stock%' OR
          t.description LIKE '%OOS%' OR
          t.description LIKE '%Auto-refund%' OR
          t.description LIKE '%out_of_stock%'
        )
      GROUP BY t.user_id
      ORDER BY total_credited DESC
      LIMIT 30
    `).all();

    let txt = `🚨 <b>Out-of-Stock Exploit Audit</b>\n\n`;
    if (!suspicious.length) {
      txt += `✅ <b>No out-of-stock exploits detected.</b>\n\n`;
      txt += `<i>This finds users who got wallet credit from the "buy out-of-stock product" bug.</i>`;
    } else {
      txt += `Found <b>${suspicious.length}</b> user(s).\n\n`;
      let totalLost = 0;
      suspicious.slice(0, 15).forEach((s, i) => {
        const name = s.username ? '@' + s.username : (s.first_name || `User ${s.user_id}`);
        const credited = Number(s.total_credited) || 0;
        const balance = Number(s.balance) || 0;
        totalLost += credited;
        const orderIds = (s.order_ids || '').split(',').slice(0, 5).join(', #');
        txt += `${i+1}. ${escapeHtml(name)}\n`;
        txt += `   ID: <code>${s.user_id}</code>\n`;
        txt += `   🚨 Stolen: <b>${formatPrice(credited)}</b> from ${s.orders_count} OOS order(s)\n`;
        txt += `   📦 Orders: #${orderIds}\n`;
        txt += `   💰 Current balance: <b>${formatPrice(balance)}</b>\n\n`;
      });
      if (suspicious.length > 15) txt += `<i>... and ${suspicious.length - 15} more</i>\n\n`;
      txt += `\n💸 <b>Total stolen via OOS: ${formatPrice(totalLost)}</b>`;
    }

    await bot.editMessageText(txt, {
      chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [
        ...(suspicious.length > 0 ? [[
          { text: '⚠️ Deduct ALL stolen', callback_data: 'admin_audit_oos_deduct' }
        ]] : []),
        [{ text: '🔙 Back', callback_data: 'admin_panel' }]
      ] }
    }).catch(() => {});
    return;
  }

  if (data === 'admin_audit_oos_deduct') {
    const dbRaw = require('../database/db');
    const suspicious = dbRaw.prepare(`
      SELECT t.user_id, SUM(t.amount) AS total_credited
      FROM transactions t
      WHERE t.type = 'deposit' AND t.order_id IS NOT NULL
        AND (t.description LIKE '%Out-of-stock%' OR t.description LIKE '%out of stock%' OR t.description LIKE '%OOS%')
      GROUP BY t.user_id
    `).all();

    let totalDeducted = 0, usersAffected = 0;
    const tx = dbRaw.transaction(() => {
      for (const s of suspicious) {
        const amount = Number(s.total_credited) || 0;
        if (amount <= 0) continue;
        const u = dbRaw.prepare(`SELECT balance FROM users WHERE telegram_id=?`).get(s.user_id);
        if (!u) continue;
        const deduct = Math.min(amount, Number(u.balance) || 0);
        if (deduct > 0) {
          dbRaw.prepare(`UPDATE users SET balance = balance - ? WHERE telegram_id=?`).run(deduct, s.user_id);
          dbRaw.prepare(`INSERT INTO transactions (user_id, type, amount, description) VALUES (?, 'admin_adjust', ?, ?)`)
            .run(s.user_id, -deduct, 'OOS exploit reversal (admin audit)');
          totalDeducted += deduct;
          usersAffected++;
        }
      }
    });
    tx();

    await bot.editMessageText(
      `✅ <b>OOS Exploit Reversed</b>\n\n` +
      `👥 Users affected: <b>${usersAffected}</b>\n` +
      `💸 Total deducted: <b>${formatPrice(totalDeducted)}</b>`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'admin_panel' }]] } }
    ).catch(() => {});
    logger.info(`[ADMIN] OOS reversal: ${formatPrice(totalDeducted)} from ${usersAffected} users`);
    return;
  }

  // ── Toggle referral system ───────────────────────────────────────
  if (data === 'admin_referral_toggle') {
    const current = db.getSetting('referral_enabled', '1') === '1';
    db.setSetting('referral_enabled', current ? '0' : '1');
    await answer(current ? '🔴 Referral DISABLED' : '🟢 Referral ENABLED');
    return await handleAdminCallback(bot, { ...query, data: 'admin_vip_toggle' });
  }

  // ── Toggle VIP new-only mode ─────────────────────────────────────
  if (data === 'admin_vip_new_only_toggle') {
    const current = db.getSetting('vip_new_only', '0') === '1';
    db.setSetting('vip_new_only', current ? '0' : '1');
    await answer(current ? '👥 All can earn VIP' : '🆕 Only NEW customers');
    return await handleAdminCallback(bot, { ...query, data: 'admin_vip_toggle' });
  }

  // ── VIP Earnings Statistics ──────────────────────────────────────
  if (data === 'admin_vip_stats') {
    const dbRaw = require('../database/db');
    const vips = dbRaw.prepare(`SELECT telegram_id, username, first_name, balance FROM users WHERE is_vip=1`).all();
    let totalReferralRewards = 0;
    let totalSpent = 0;
    const vipDetails = [];
    for (const v of vips) {
      const refRewards = dbRaw.prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM transactions WHERE user_id=? AND type='referral'`).get(v.telegram_id);
      const earned = Number(refRewards?.total) || 0;
      totalReferralRewards += earned;
      const spent = dbRaw.prepare(`SELECT COALESCE(SUM(total_price), 0) AS total FROM orders WHERE user_id=? AND status='delivered'`).get(v.telegram_id);
      const spentAmount = Number(spent?.total) || 0;
      totalSpent += spentAmount;
      vipDetails.push({
        name: v.username ? '@' + v.username : (v.first_name || `User ${v.telegram_id}`),
        earned, spent: spentAmount,
      });
    }
    vipDetails.sort((a, b) => b.earned - a.earned);

    let txt = `💰 <b>VIP Earnings Report</b>\n\n`;
    txt += `👑 Total VIPs: <b>${vips.length}</b>\n`;
    txt += `💸 Referral Rewards paid: <b>${formatPrice(totalReferralRewards)}</b>\n`;
    txt += `🛒 Total spent by VIPs: <b>${formatPrice(totalSpent)}</b>\n\n`;
    txt += `<b>Top earners (⚠️ = scam alert):</b>\n`;
    for (const v of vipDetails.slice(0, 15)) {
      const warning = v.earned > 5 && v.spent === 0 ? ' ⚠️' : '';
      txt += `${escapeHtml(v.name)} — earned ${formatPrice(v.earned)}, spent ${formatPrice(v.spent)}${warning}\n`;
    }
    txt += `\n⚠️ = Earned referral money but never purchased anything (possible scam)`;

    await bot.editMessageText(txt, {
      chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'admin_vip_toggle' }]] }
    }).catch(() => {});
    return;
  }

  if (data === 'admin_vip_system_on') {
    db.setSetting('vip_system_enabled', '1');
    await answer('🟢 VIP System OPEN');
    return;
  }
  if (data === 'admin_vip_system_off') {
    db.setSetting('vip_system_enabled', '0');
    await answer('🔴 VIP System CLOSED');
    return;
  }
  if (data === 'admin_vip_on') {
    db.setSetting('vip_auto_broadcast', '1');
    await answer('🟢 Auto broadcast ON');
    // Simulate refresh by re-calling
    return await handleAdminCallback(bot, { ...query, data: 'admin_vip_toggle' });
  }
  if (data === 'admin_vip_off') {
    db.setSetting('vip_auto_broadcast', '0');
    await answer('🔴 Auto broadcast OFF');
    return;
  }
  if (data === 'admin_vip_post_now') {
    await answer('⏳ Posting...');
    const totalVips = db.countVIPs();
    const slotsLeft = Math.max(0, parseInt(db.getSetting('vip_limit', '1000'), 10) - totalVips);
    const botUser = await bot.getMe().catch(() => ({ username: 'YourBot' }));
    const text =
      `👑 <b>VIP FOR LIFE</b> 👑\n\n` +
      `🚨 <b>Important:</b> ⏳ VIP closes at <b>${parseInt(db.getSetting('vip_limit', '1000'), 10).toLocaleString()} customers</b>\n` +
      `📊 Only <b>${slotsLeft} slots remaining</b>\n\n` +
      `Invite only <b>3 friends</b> and unlock VIP <b>forever</b>!\n\n` +
      `🎁 <b>VIP Benefits:</b>\n` +
      `💸 5% discount on every purchase for life\n` +
      `🤝 Earn rewards from your team's purchases\n` +
      `🚀 Early access to new and rare products\n` +
      `⚡️ Priority support and faster replies\n\n` +
      `🔥 Invite <b>3 friends</b> today!`;
    const kb = { inline_keyboard: [
      [{ text: '🚀 Open Bot & Invite Friends', url: `https://t.me/${botUser.username}?start=vip` }],
      [{ text: '👑 Become VIP Now', url: `https://t.me/${botUser.username}?start=vip` }],
    ] };
    const { publishToChannel, publishToGroup } = require('../services/notifications');
    const vipImg = db.getSetting('vip_image_file_id', '');
    if (vipImg) {
      const channelId = db.getSetting('required_channel_id', '');
      const groupId   = db.getSetting('required_group_id', '');
      if (channelId) await bot.sendPhoto(channelId, vipImg, { caption: text, parse_mode: 'HTML', reply_markup: kb }).catch(() => {});
      if (groupId)   await bot.sendPhoto(groupId, vipImg, { caption: text, parse_mode: 'HTML', reply_markup: kb }).catch(() => {});
    } else {
      await publishToChannel(bot, text, kb).catch(() => {});
      await publishToGroup(bot, text, kb).catch(() => {});
    }
    await bot.sendMessage(chatId, '✅ Posted to channel and group.');
    return;
  }

  // ── Maintenance Mode ──────────────────────────────────────────────
  if (data === 'admin_maintenance') {
    const enabled = db.getSetting('maintenance_mode', '0') === '1';
    const msg = db.getSetting('maintenance_message', 'The bot is currently under maintenance. Please try again later.');

    await bot.editMessageText(
      `🚧 <b>Maintenance Mode</b>\n\n` +
      `Current status: ${enabled ? '🔴 <b>ON</b> (bot is locked)' : '🟢 <b>OFF</b> (bot is open)'}\n\n` +
      `<b>When ON:</b>\n` +
      `• Customers cannot buy, top-up, or place orders\n` +
      `• They see your maintenance message\n` +
      `• Admin functions remain working\n\n` +
      `<b>Current message shown to customers:</b>\n` +
      `<i>${escapeHtml(msg)}</i>`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [
          enabled
            ? [{ text: '🟢 Turn OFF Maintenance', callback_data: 'admin_maintenance_off' }]
            : [{ text: '🔴 Turn ON Maintenance', callback_data: 'admin_maintenance_on' }],
          [{ text: '✏️ Edit Message', callback_data: 'admin_maintenance_msg' }],
          [{ text: '🔙 Back', callback_data: 'admin_panel' }],
        ] } }
    );
    return;
  }

  if (data === 'admin_maintenance_on') {
    db.setSetting('maintenance_mode', '1');
    await answer('🔴 Maintenance ON');
    // Broadcast to channel + group
    try {
      const msg = db.getSetting('maintenance_message', 'The bot is currently under maintenance.');
      const announcement =
        `🚧 <b>Bot Under Maintenance</b>\n\n` +
        `${msg}\n\n` +
        `⏰ Service will resume shortly. Thank you for your patience.`;
      const channelId = db.getSetting('required_channel_id', '');
      const groupId = db.getSetting('required_group_id', '');
      if (channelId) {
        try { await bot.sendMessage(channelId, announcement, { parse_mode: 'HTML' }); } catch (e) { logger.warn(`Channel notify failed: ${e.message}`); }
      }
      if (groupId) {
        try { await bot.sendMessage(groupId, announcement, { parse_mode: 'HTML' }); } catch (e) { logger.warn(`Group notify failed: ${e.message}`); }
      }
    } catch (e) { logger.warn(`Maintenance broadcast failed: ${e.message}`); }
    // Refresh view
    const msg = db.getSetting('maintenance_message', 'The bot is currently under maintenance. Please try again later.');
    await bot.editMessageText(
      `🚧 <b>Maintenance Mode</b>\n\n` +
      `Current status: 🔴 <b>ON</b> (bot is locked)\n\n` +
      `Customers see: <i>${escapeHtml(msg)}</i>`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [
          [{ text: '🟢 Turn OFF Maintenance', callback_data: 'admin_maintenance_off' }],
          [{ text: '✏️ Edit Message', callback_data: 'admin_maintenance_msg' }],
          [{ text: '🔙 Back', callback_data: 'admin_panel' }],
        ] } }
    );
    return;
  }

  if (data === 'admin_maintenance_off') {
    db.setSetting('maintenance_mode', '0');
    await answer('🟢 Maintenance OFF');
    // Broadcast back-online to channel + group
    try {
      const announcement =
        `✅ <b>Bot is Back Online!</b>\n\n` +
        `🎉 Maintenance complete — service is fully operational again.\n` +
        `Thank you for your patience! 💚`;
      const channelId = db.getSetting('required_channel_id', '');
      const groupId = db.getSetting('required_group_id', '');
      if (channelId) {
        try { await bot.sendMessage(channelId, announcement, { parse_mode: 'HTML' }); } catch (e) { logger.warn(`Channel notify failed: ${e.message}`); }
      }
      if (groupId) {
        try { await bot.sendMessage(groupId, announcement, { parse_mode: 'HTML' }); } catch (e) { logger.warn(`Group notify failed: ${e.message}`); }
      }
    } catch (e) { logger.warn(`Maintenance broadcast failed: ${e.message}`); }
    await bot.editMessageText(
      `🚧 <b>Maintenance Mode</b>\n\n` +
      `Current status: 🟢 <b>OFF</b> (bot is open)\n\n` +
      `Bot is fully operational for customers.`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [
          [{ text: '🔴 Turn ON Maintenance', callback_data: 'admin_maintenance_on' }],
          [{ text: '✏️ Edit Message', callback_data: 'admin_maintenance_msg' }],
          [{ text: '🔙 Back', callback_data: 'admin_panel' }],
        ] } }
    );
    return;
  }

  if (data === 'admin_maintenance_msg') {
    session.set(userId, States.ADMIN_MAINTENANCE_MSG, {});
    await bot.editMessageText(
      `✏️ <b>Edit Maintenance Message</b>\n\n` +
      `Send the new message that customers will see when the bot is in maintenance mode.\n\n` +
      `<i>Current:</i>\n` +
      `${escapeHtml(db.getSetting('maintenance_message', 'The bot is currently under maintenance.'))}`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🔙 Cancel', callback_data: 'admin_maintenance' }]] } }
    );
    return;
  }

  // ── Refund ────────────────────────────────────────────────────────
  if (data === 'admin_refund') {
    session.set(userId, States.ADMIN_REFUND_ORDER_ID, {});
    await bot.editMessageText(
      '💸 <b>Issue Refund</b>\n\n' +
      'Step 1: Enter the <b>Order ID</b> to refund:',
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: adminBackKb() }
    );
    return;
  }
  if (/^admin_refund_confirm_\d+$/.test(data)) {
    const orderId = parseInt(data.split('_').pop(), 10);
    const sess = session.get(userId);
    const { order, refundEndDate, warrantyDays, daysRemaining, refundAmount } = sess.data;
    session.clear(userId);

    if (!order || refundAmount === undefined) {
      await bot.editMessageText('❌ Refund session expired. Please start again.', {
        chat_id: chatId, message_id: msgId, reply_markup: adminBackKb(),
      });
      return;
    }

    // Credit the user's wallet
    db.updateBalance(order.user_id, refundAmount);
    db.addTransaction({
      userId:      order.user_id,
      type:        'refund',
      amount:      refundAmount,
      description: `Refund for Order #${orderId} — ${daysRemaining}/${warrantyDays} days remaining`,
      refId:       null,
      orderId:     orderId,
    });

    // Save refund record
    db.createRefund({
      orderId,
      userId:        order.user_id,
      productId:     order.product_id,
      originalPrice: order.total_price,
      refundAmount,
      warrantyDays,
      endDate:       refundEndDate,
    });

    // Notify user
    try {
      await bot.sendMessage(
        order.user_id,
        `💸 <b>Refund Issued!</b>\n\n` +
        `📦 Order #${orderId} — ${order.product_title}\n` +
        `⏳ Days remaining: <b>${daysRemaining}</b> / ${warrantyDays}\n` +
        `💰 Refunded: <b>${formatPrice(refundAmount)}</b> → added to your wallet\n\n` +
        `Thank you for your trust! 🙏`,
        { parse_mode: 'HTML' }
      );
    } catch (e) {
      logger.warn(`Could not notify user ${order.user_id} about refund: ${e.message}`);
    }

    await bot.editMessageText(
      `✅ <b>Refund Issued!</b>\n\n` +
      `📦 Order #${orderId}\n` +
      `👤 User: <code>${order.user_id}</code>\n` +
      `💰 Refunded: <b>${formatPrice(refundAmount)}</b>`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: adminBackKb() }
    );
    return;
  }

  // ── Delete single stock item (works for both product_items and legacy stock) ──
  if (/^admin_del_stock_item_[is]_\d+$/.test(data)) {
    if (!isAdmin(userId)) { await rejectNonAdmin(bot, query.id); return; }
    const parts2  = data.split('_');
    const type    = parts2[parts2.length - 2]; // 'i' or 's'
    const itemId  = parseInt(parts2[parts2.length - 1], 10);

    let productId = null;
    let deleted   = false;

    if (type === 'i') {
      // product_items table
      const item = items.getItem(itemId);
      if (item && item.status === 'available') {
        productId = item.product_id;
        const changes = items.deleteItem(itemId);
        deleted = changes > 0;
      }
    } else {
      // legacy stock table
      const stockItem = db.getStockItemById(itemId);
      if (stockItem) {
        productId = stockItem.product_id;
        db.deleteStockItem(itemId);
        deleted = true;
      }
    }

    if (!deleted || !productId) {
      await answer('❌ Item not found or already deleted.');
      return;
    }

    // Decrease stock_quantity by 1
    db.adjustStockQuantity(productId, -1);
    const product = db.getProduct(productId);

    // Get remaining items (both types)
    const remainingItems  = items.getAllAvailable(productId);
    const remainingLegacy = db.getStockItems(productId);
    const remaining = [
      ...remainingItems.map((it) => ({ id: it.id, content: it.raw_content, type: 'item' })),
      ...remainingLegacy.map((it) => ({ id: it.id, content: it.content, type: 'stock' })),
    ];

    await answer('✅ Item deleted');

    if (remaining.length === 0) {
      await bot.editMessageText(
        `✅ <b>Item deleted.</b>\n\n📦 ${product.title}\n📊 No more stock items.`,
        { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: backToProductEditKb(productId) }
      );
    } else {
      // Build new keyboard with remaining items
      const rows = remaining.slice(0, 20).map((it) => {
        const preview = String(it.content || '').slice(0, 30);
        const prefix  = it.type === 'item' ? 'i' : 's';
        return [{ text: `🗑 #${it.id}: ${preview}`, callback_data: `admin_del_stock_item_${prefix}_${it.id}` }];
      });
      rows.push([{ text: '🔙 Back to Product', callback_data: `admin_edit_p_${productId}` }]);

      await bot.editMessageText(
        `✅ <b>Item deleted.</b> ${remaining.length} item(s) remaining.\n\n` +
        `Select another item to delete:`,
        { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } }
      );
    }
    return;
  }

  // ── Support tickets ───────────────────────────────────────────────
  if (data === 'admin_tickets') {
    const tickets = db.getOpenTickets();
    if (!tickets.length) {
      await bot.editMessageText('🎫 <b>No open tickets.</b>', {
        chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: adminBackKb(),
      });
      return;
    }
    await bot.editMessageText(`🎫 <b>Open Tickets</b> (${tickets.length})`, {
      chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: adminTicketsKb(tickets),
    });
    return;
  }
  if (/^admin_ticket_\d+$/.test(data)) {
    const ticketId = parseInt(data.split('_').pop(), 10);
    const ticket   = db.getTicket(ticketId);
    if (!ticket) { await answer('❌ Not found.'); return; }
    await bot.editMessageText(
      `🎫 <b>Ticket #${ticketId}</b>\n\n👤 User: <code>${ticket.user_id}</code>\n📅 ${(ticket.created_at || '').slice(0, 16)}\n\n📝 <b>Message:</b>\n${ticket.message}`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: adminTicketActionsKb(ticketId) }
    );
    return;
  }
  if (/^admin_reply_ticket_\d+$/.test(data)) {
    const ticketId = parseInt(data.split('_').pop(), 10);
    session.set(userId, States.ADMIN_REPLY_TICKET, { replyTicketId: ticketId });
    await bot.editMessageText(`✉️ <b>Reply to Ticket #${ticketId}</b>\n\nEnter your reply:`, {
      chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: adminBackKb(),
    });
    return;
  }

  // ── Settings ──────────────────────────────────────────────────────
  if (data === 'admin_settings') {
    await bot.editMessageText('⚙️ <b>Settings</b>\n\nSelect a setting to edit:', {
      chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: adminSettingsKb(),
    });
    return;
  }
  if (/^admin_setting_/.test(data)) {
    const key     = data.replace('admin_setting_', '');
    const current = db.getSetting(key);
    session.set(userId, States.ADMIN_SETTING_VALUE, { settingKey: key });
    await bot.editMessageText(
      `⚙️ <b>Edit: ${key}</b>\n\nCurrent: <code>${current || '(empty)'}</code>\n\nEnter new value:`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: adminBackKb() }
    );
    return;
  }

  // ── Announcement ──────────────────────────────────────────────────
  if (data === 'admin_announcement') {
    session.set(userId, States.ADMIN_ANN_MSG, {});
    await bot.editMessageText(
      '📢 <b>Announcement</b>\n\nWrite your announcement.\n\n' +
      '<b>Formatting:</b>\n' +
      '• HTML: <code>&lt;b&gt;bold&lt;/b&gt;</code>, <code>&lt;i&gt;italic&lt;/i&gt;</code>\n' +
      '• Premium Emoji: <code>[emoji:ID]</code> or use 🎨 button below\n\n' +
      '💡 Get IDs from @emojiidbot',
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [
          [{ text: '🎨 Choose Emoji from Library', callback_data: 'admin_emoji_picker' }],
          [{ text: '🔙 Back', callback_data: 'admin_panel' }],
        ] } }
    );
    return;
  }
  if (data === 'ann_btn_skip') {
    const sessData = session.get(userId).data;
    session.set(userId, States.ADMIN_ANN_TARGET, { annText: sessData.annText });
    await bot.editMessageText(
      `📢 Where to send the announcement?`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: announcementTargetKb() }
    );
    return;
  }
  if (data === 'ann_btn_product') {
    session.set(userId, States.ADMIN_ANN_BUTTON_TEXT, session.get(userId).data);
    await bot.editMessageText(
      `🛒 <b>Add Buy Button</b>\n\nSend the button text and the product ID separated by <code>|</code>:\n\n` +
      `<b>Format:</b> <code>Button Text|PRODUCT_ID</code>\n\n` +
      `<b>Example:</b> <code>🛒 Buy Now|5</code>\n\n` +
      `Get product IDs from /admin → ✏️ Edit Product.`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'admin_panel' }]] } }
    );
    return;
  }

  if (/^ann_(channel|users|both)$/.test(data)) {
    const choice  = data.split('_')[1];
    const sessData = session.get(userId).data;
    const rawText = sessData.annText || '';
    const annText = expandPremiumEmojis(rawText);
    const annButton = sessData.annButton || null; // { text, callback or product_id }
    session.clear(userId);

    // Build reply markup if announcement button was set
    let annKb = undefined;
    if (annButton) {
      if (annButton.product_id) {
        // Buy button - opens the product
        const botUser = await bot.getMe().catch(() => ({ username: '' }));
        annKb = { inline_keyboard: [
          [{ text: annButton.text, url: `https://t.me/${botUser.username}?start=p_${annButton.product_id}` }],
        ] };
      } else if (annButton.url) {
        annKb = { inline_keyboard: [[{ text: annButton.text, url: annButton.url }]] };
      }
    }

    const results = [];
    if (choice !== 'users') {
      const okChannel = await publishToChannel(bot, annText, annKb);
      results.push(`📢 Channel: ${okChannel ? '✅' : '❌'}`);
      const okGroup = await publishToGroup(bot, annText, annKb);
      results.push(`💬 Group: ${okGroup ? '✅' : '❌'}`);
    }
    if (choice !== 'channel') {
      const { sent, failed } = await broadcastToUsers(bot, annText, annKb);
      results.push(`👥 Bot Users: ${sent} sent, ${failed} failed`);
    }
    await bot.editMessageText(`✅ <b>Announcement Sent!</b>\n\n${results.join('\n')}`, {
      chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: adminBackKb(),
    });
    return;
  }

  // ── Notification targets ──────────────────────────────────────────
  if (/^notif_(product|stock)_(channel|both|skip)$/.test(data)) {
    const [, type, choice] = data.match(/^notif_(product|stock)_(channel|both|skip)$/);
    const pending = pendingNotifs.get(userId);
    pendingNotifs.delete(userId);

    if (!pending || choice === 'skip') {
      await bot.editMessageText('🚫 Notification skipped.', {
        chat_id: chatId, message_id: msgId, reply_markup: adminBackKb(),
      });
      return;
    }

    const product = db.getProduct(pending.productId);
    const text    = type === 'product'
      ? buildNewProductText(product)
      : buildStockUpdateText(product, pending.added);

    const results = [];
    const okChannel = await publishToChannel(bot, text);
    results.push(`📢 Channel: ${okChannel ? '✅' : '❌'}`);
    const okGroup = await publishToGroup(bot, text);
    results.push(`💬 Group: ${okGroup ? '✅' : '❌'}`);
    if (choice === 'both') {
      const { sent, failed } = await broadcastToUsers(bot, text);
      results.push(`👥 Bot Users: ${sent} sent, ${failed} failed`);
    }

    await bot.editMessageText(
      `✅ <b>Notification Sent!</b>\n\n${results.join('\n')}`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: adminBackKb() }
    );
    return;
  }

  // ── Manual balance management (Add / Remove) ─────────────────────
  if (data === 'admin_add_balance') {
    session.set(userId, States.ADMIN_BALANCE_USER_ID, { balanceOp: 'add' });
    await bot.editMessageText(
      '➕ <b>Add User Balance</b>\n\n' +
      'Send the customer\'s <b>Telegram ID</b> or <b>@username</b>:',
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: adminBackKb() }
    );
    return;
  }
  if (data === 'admin_remove_balance') {
    session.set(userId, States.ADMIN_BALANCE_USER_ID, { balanceOp: 'remove' });
    await bot.editMessageText(
      '➖ <b>Remove User Balance</b>\n\n' +
      'Send the customer\'s <b>Telegram ID</b> or <b>@username</b>:',
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: adminBackKb() }
    );
    return;
  }
}


// ── Recover delivered items from a user's orders ─────────────────────
// Marks items as 'available' again and increases stock_quantity
async function recoverDeliveredItems(bot, chatId, userId, targetUserId, productId) {
  const items = require('../database/items');
  const result = items.recoverItemsFromUser(targetUserId, productId);
  const product = db.getProduct(productId);
  await bot.sendMessage(chatId,
    `🔄 <b>Items Recovered</b>\n\n` +
    `👤 From user: <code>${targetUserId}</code>\n` +
    `📦 Product: ${product?.title || productId}\n` +
    `✅ Recovered: <b>${result.count}</b> item(s)\n` +
    `📊 Stock restored to: ${product?.stock_quantity || 0}`,
    { parse_mode: 'HTML' }
  );
  logger.info(`Admin ${userId} recovered ${result.count} items from user ${targetUserId} product ${productId}`);
}

// ── Process refund approval with given amount ─────────────────────────────────
async function processRefundApproval(bot, chatId, msgId, r, amount) {
  const method = r.refund_method || 'wallet';
  const orderId = r.order_id;

  // ── WALLET = instant ─────────────────────────────────────────
  if (method === 'wallet') {
    db.updateBalance(r.user_id, amount);
    db.addTransaction({
      userId: r.user_id, type: 'refund', amount: amount,
      description: `Refund for order #${orderId}`,
      refId: `refund_${r.id}`, orderId: orderId,
    });
    db.updateRefundRequest(r.id, 'approved', `Refunded ${amount} to wallet`, amount, 'wallet');
    logger.info(`Refund #${r.id}: credited ${amount} to user ${r.user_id} wallet`);

    // Notify user
    try {
      await bot.sendMessage(r.user_id,
        `✅ <b>Your Refund Has Been Completed!</b>\n\n` +
        `🆔 Refund #${r.id}\n` +
        `📦 Order #${orderId}\n` +
        `💵 Refunded: <b>${formatPrice(amount)}</b>\n` +
        `💳 Method: 💰 Wallet (credited automatically)`,
        { parse_mode: 'HTML' });
    } catch (e) {}

    const confirmText = `✅ Refund #${r.id} completed.\n\n💵 ${formatPrice(amount)} credited to wallet.`;
    const kb = { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'admin_refund_requests' }]] };
    try {
      await bot.editMessageText(confirmText, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: kb });
    } catch (e) {
      try { await bot.deleteMessage(chatId, msgId); } catch (e2) {}
      await bot.sendMessage(chatId, confirmText, { parse_mode: 'HTML', reply_markup: kb });
    }
    return;
  }

  // ── BINANCE / CRYPTO = mark as PROCESSING, show admin a "Mark as Sent" button ─────
  let methodLabel = '';
  let instructions = '';
  if (method === 'binance') {
    methodLabel = '🟡 Binance Pay';
    instructions =
      `📋 <b>Manual Transfer Required</b>\n\n` +
      `1️⃣ Open Binance app\n` +
      `2️⃣ Go to Pay → Send\n` +
      `3️⃣ Enter Binance ID: <code>${r.wallet_address}</code>\n` +
      `4️⃣ Send <b>${formatPrice(amount)} USDT</b>\n` +
      `5️⃣ Once sent, press the button below`;
  } else if (method === 'crypto') {
    methodLabel = `💎 ${r.crypto_network} USDT`;
    instructions =
      `📋 <b>Manual Transfer Required</b>\n\n` +
      `1️⃣ Open your wallet (${r.crypto_network})\n` +
      `2️⃣ Send <b>${formatPrice(amount)} USDT</b>\n` +
      `3️⃣ To this address:\n<code>${r.wallet_address}</code>\n` +
      `4️⃣ Once sent, press the button below`;
  }

  // Mark as 'processing' with amount stored
  db.updateRefundRequest(r.id, 'processing', `Approved ${amount} for ${method} transfer (awaiting admin confirmation)`, amount, method);

  // Notify user that refund is being processed
  try {
    await bot.sendMessage(r.user_id,
      `⏳ <b>Your Refund is Being Processed</b>\n\n` +
      `🆔 Refund #${r.id}\n` +
      `📦 Order #${orderId}\n` +
      `💵 Amount: <b>${formatPrice(amount)}</b>\n` +
      `💳 Method: ${methodLabel}\n\n` +
      `Our team is processing your refund. You'll be notified once it's sent.`,
      { parse_mode: 'HTML' });
  } catch (e) {}

  // Admin sees instructions + Mark as Sent button
  const adminText =
    `⏳ <b>Refund #${r.id} — PENDING TRANSFER</b>\n\n` +
    `👤 User: <code>${r.user_id}</code>\n` +
    `💵 Amount: <b>${formatPrice(amount)}</b>\n` +
    `💳 ${methodLabel}\n` +
    `📍 Address: <code>${r.wallet_address}</code>\n\n` +
    instructions;

  const kb = { inline_keyboard: [
    [{ text: '✅ Mark as Sent (Confirm)', callback_data: `admin_refund_mark_sent_${r.id}` }],
    [{ text: '🔙 Back to refunds', callback_data: 'admin_refund_requests' }],
  ] };

  try {
    await bot.editMessageText(adminText, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: kb });
  } catch (e) {
    try { await bot.deleteMessage(chatId, msgId); } catch (e2) {}
    await bot.sendMessage(chatId, adminText, { parse_mode: 'HTML', reply_markup: kb });
  }
}

// Handle admin clicking "Mark as Sent" — finalize the refund
async function handleMarkRefundSent(bot, chatId, msgId, refundId, query) {
  const r = db.getRefundRequestById(refundId);
  if (!r) { return; }
  if (r.status !== 'processing') {
    await bot.answerCallbackQuery(query.id, { text: '❌ Already finalized', show_alert: true });
    return;
  }

  const amount = Number(r.amount) || 0;
  const method = r.refund_method;
  const methodLabel = method === 'binance' ? '🟡 Binance Pay' : `💎 ${r.crypto_network} USDT`;

  // Mark as approved (final)
  db.updateRefundRequest(r.id, 'approved', `${method} transfer confirmed sent by admin`, amount, method);

  // Notify user
  try {
    await bot.sendMessage(r.user_id,
      `✅ <b>Your Refund Has Been Sent!</b>\n\n` +
      `🆔 Refund #${r.id}\n` +
      `📦 Order #${r.order_id}\n` +
      `💵 Amount: <b>${formatPrice(amount)}</b>\n` +
      `💳 Method: ${methodLabel}\n` +
      `📍 To: <code>${r.wallet_address}</code>\n\n` +
      `The transfer has been completed. Check your wallet/account.`,
      { parse_mode: 'HTML' });
  } catch (e) {}

  await bot.editMessageText(
    `✅ <b>Refund #${r.id} Completed</b>\n\n` +
    `💵 ${formatPrice(amount)} sent via ${methodLabel}\n` +
    `User has been notified.`,
    { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'admin_refund_requests' }]] } }
  ).catch(async () => {
    await bot.sendMessage(chatId, `✅ Refund #${r.id} marked as sent.`);
  });
}

module.exports = {
  isAdmin,
  showAdminPanel,
  startAddProduct,
  handleAdminText,
  handleAdminPhoto,
  handleAdminCallback,
  recoverDeliveredItems,
};
