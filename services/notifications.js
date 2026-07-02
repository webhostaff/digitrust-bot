'use strict';

// Format a product title with optional premium emoji prefix.
// Title may also contain inline [emoji:ID] markers — they get expanded too.
function expandTitleEmojis(t) {
  if (!t) return '';
  return String(t).replace(/\[emoji:(\d+)\](\S?)/g, (_, id, fb) => {
    // Validate ID is reasonable length (Telegram emoji IDs are 18-20 digits)
    if (id.length < 15 || id.length > 25) {
      return fb || '🎁'; // Invalid ID — just show fallback
    }
    const safe = fb || '🎁';
    return `<tg-emoji emoji-id="${id}">${safe}</tg-emoji>`;
  });
}

function formatProductTitle(product) {
  const title = product ? (product.title || '') : '';
  const expandedTitle = expandTitleEmojis(title);
  if (product && product.premium_emoji_id) {
    return `<tg-emoji emoji-id="${product.premium_emoji_id}">🛍</tg-emoji> <b>${expandedTitle}</b>`;
  }
  return `<b>${expandedTitle}</b>`;
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const db     = require('../database/queries');
const logger = require('../utils/logger');
const { formatPrice } = require('../utils/format');

// Bot username shown in announcements
const BOT_USERNAME = '@DIGISELLABOT';

/**
 * Publish a message to the updates channel.
 */
// Publish to channel WITH product photo if available
async function publishToChannelWithPhoto(bot, product, text, replyMarkup = null) {
  const channelId = db.getSetting('required_channel_id', '');
  if (!channelId) {
    logger.warn('required_channel_id not set — skipping channel publish');
    return false;
  }
  try {
    if (product && product.image_file_id) {
      await bot.sendPhoto(channelId, product.image_file_id, {
        caption: text, parse_mode: 'HTML',
        reply_markup: replyMarkup || undefined,
      });
    } else {
      await bot.sendMessage(channelId, text, {
        parse_mode: 'HTML', disable_web_page_preview: true,
        reply_markup: replyMarkup || undefined,
      });
    }
    return true;
  } catch (e) {
    logger.warn(`publishToChannelWithPhoto failed: ${e.message}`);
    return false;
  }
}

async function publishToGroupWithPhoto(bot, product, text, replyMarkup = null) {
  const groupId = db.getSetting('required_group_id', '');
  if (!groupId) {
    logger.warn('required_group_id not set — skipping group publish');
    return false;
  }
  try {
    if (product && product.image_file_id) {
      await bot.sendPhoto(groupId, product.image_file_id, {
        caption: text, parse_mode: 'HTML',
        reply_markup: replyMarkup || undefined,
      });
    } else {
      await bot.sendMessage(groupId, text, {
        parse_mode: 'HTML', disable_web_page_preview: true,
        reply_markup: replyMarkup || undefined,
      });
    }
    return true;
  } catch (e) {
    logger.warn(`publishToGroupWithPhoto failed: ${e.message}`);
    return false;
  }
}

async function autoPublishWithPhoto(bot, product, text, replyMarkup = null) {
  const r1 = await publishToChannelWithPhoto(bot, product, text, replyMarkup).catch(e => { logger.error('Channel failed: ' + e.message); return false; });
  const r2 = await publishToGroupWithPhoto(bot, product, text, replyMarkup).catch(e => { logger.error('Group failed: ' + e.message); return false; });
  logger.info(`[BROADCAST] Channel: ${r1}, Group: ${r2}`);
  return r1 || r2;
}

async function publishToChannel(bot, text, replyMarkup = null) {
  const channelId = db.getSetting('required_channel_id', '');
  if (!channelId) {
    logger.warn('updates_channel_id not set — skipping channel publish');
    return false;
  }
  try {
    await bot.sendMessage(channelId, text, { parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: replyMarkup || undefined });
    return true;
  } catch (e) {
    logger.error(`Channel publish failed: ${e.message}`);
    return false;
  }
}

/**
 * Publish a message to the discussion group (requiredGroupId).
 */
async function publishToGroup(bot, text, replyMarkup = null) {
  const groupId = db.getSetting('required_group_id', '');
  if (!groupId) {
    logger.warn('updates_group_id not set — skipping group publish');
    return false;
  }
  try {
    await bot.sendMessage(groupId, text, { parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: replyMarkup || undefined });
    return true;
  } catch (e) {
    logger.error(`Group publish failed: ${e.message}`);
    return false;
  }
}

/**
 * Broadcast a message to all users.
 * Returns { sent, failed }.
 */
async function broadcastToUsers(bot, text, replyMarkup = null) {
  const users = db.getAllUsers();
  let sent = 0, failed = 0;
  for (const user of users) {
    try {
      await bot.sendMessage(user.telegram_id, text, { parse_mode: 'HTML' });
      sent++;
      await new Promise((r) => setTimeout(r, 50)); // rate-limit protection
    } catch {
      failed++;
    }
  }
  return { sent, failed };
}

const buildNewProductText = (product) =>
  `🆕 <b>New Product Available!</b>\n\n` +
  `${formatProductTitle(product)}\n\n` +
  `💵 <b>Price:</b> ${formatPrice(product.price)}\n` +
  `📦 <b>Stock:</b> ${product.stock_quantity || 0}\n` +
  `🛡 <b>Warranty:</b> ${product.warranty || 'N/A'}\n\n` +
  `🛒 Order now 👉 ${BOT_USERNAME}`;

const buildStockUpdateText = (product, added) =>
  `📦 <b>Stock Updated!</b>\n\n` +
  `${formatProductTitle(product)}\n\n` +
  `✅ New stock added: <b>${added} pcs</b>\n` +
  `📦 Available now: <b>${product.stock_quantity || 0} pcs</b>\n\n` +
  `🛒 Order now 👉 ${BOT_USERNAME}`;

const buildLowStockText = (product) =>
  `⚠️ <b>Low Stock Alert!</b>\n\n` +
  `${formatProductTitle(product)}\n\n` +
  `🔥 Only <b>${product.stock_quantity || 0} pcs</b> left!\n` +
  `💵 <b>Price:</b> ${formatPrice(product.price)}\n\n` +
  `🛒 Hurry up 👉 ${BOT_USERNAME}`;

const buildOutOfStockText = (product) =>
  `❌ <b>Out of Stock</b>\n\n` +
  `${formatProductTitle(product)}\n\n` +
  `Sold out! We will restock soon. Stay tuned 📦\n\n` +
  `🔔 Get notified when it's back 👉 ${BOT_USERNAME}`;

/**
 * Price drop notification — shows old price, new price, and the discount %.
 * oldPrice is required; if it's missing/invalid we fall back to the generic
 * "price reduced" wording so this never throws or shows broken numbers.
 */
const buildPriceDropText = (product, botUsername, oldPrice = null) => {
  const link = botUsername ? `https://t.me/${botUsername}` : BOT_USERNAME;
  const newP = Number(product?.price);
  const oldP = Number(oldPrice);

  const havePrices = Number.isFinite(oldP) && Number.isFinite(newP) && oldP > 0 && newP < oldP;

  if (!havePrices) {
    // Fallback — same as before, in case oldPrice wasn't passed correctly
    return (
      `🔥 <b>Price Drop Alert!</b>\n\n` +
      `${formatProductTitle(product)}\n\n` +
      `📉 The price has just been <b>reduced</b>!\n` +
      `🏃 Hurry up and grab it before it goes back up!\n\n` +
      `🛒 Buy now 👉 ${link}`
    );
  }

  const pct = Math.round((1 - newP / oldP) * 100);

  return (
    `🔥 <b>Price Drop Alert!</b>\n\n` +
    `${formatProductTitle(product)}\n\n` +
    `💵 <b>Old Price:</b> <s>${formatPrice(oldP)}</s>\n` +
    `✅ <b>New Price:</b> ${formatPrice(newP)}\n` +
    `🎉 <b>${pct}% OFF</b> — Limited discount available now.\n\n` +
    `🛒 Buy now 👉 ${link}`
  );
};

/**
 * Stale-product reminder — for items that haven't sold (or weren't sold
 * since being added) for a while, even though they're still in stock.
 * Kept short and low-key on purpose so it doesn't read as urgent/spammy.
 */
const buildStaleProductText = (product, botUsername) => {
  const link = botUsername ? `https://t.me/${botUsername}` : BOT_USERNAME;
  const rawDesc = String(product?.description || '').trim();
  const shortDesc = rawDesc.length > 120 ? rawDesc.slice(0, 117) + '…' : rawDesc;

  return (
    `📦 <b>Reminder: This product is still available</b>\n\n` +
    `${formatProductTitle(product)}\n` +
    `💵 <b>Price:</b> ${formatPrice(product.price)}\n` +
    (shortDesc ? `📝 ${escapeHtml(shortDesc)}\n` : '') +
    `\n🛒 Buy now from the bot 👉 ${link}`
  );
};

/**
 * Publish to both channel and group at once. Errors are swallowed
 * so a missing channel/group config never breaks the main flow.
 */
async function autoPublish(bot, text) {
  try { await publishToChannel(bot, text); } catch (e) { /* ignore */ }
  try { await publishToGroup(bot, text);   } catch (e) { /* ignore */ }
}

/**
 * Auto-fire low-stock / out-of-stock notifications based on the stock
 * level BEFORE and AFTER a purchase. Should be called after every
 * successful purchase. Idempotent — only fires when crossing thresholds.
 *
 * Thresholds:
 *   - stockBefore > 3 and stockAfter <= 3 (but > 0)  → LOW STOCK alert
 *   - stockBefore > 0 and stockAfter === 0           → OUT OF STOCK alert
 *
 * @param {TelegramBot} bot
 * @param {object} db        - the database/queries module
 * @param {number} productId
 * @param {number} stockBefore
 * @param {number} stockAfter
 */
async function checkAndNotifyStockLevel(bot, db, productId, stockBefore, stockAfter) {
  const notifEnabled = db.getSetting('stock_notifications_enabled', '1');
  if (notifEnabled !== '1') return;

  const product = db.getProduct(productId);
  if (!product) return;

  // Out of stock (just hit 0)
  if (stockBefore > 0 && stockAfter === 0) {
    const botUserOos = await bot.getMe().catch(() => ({ username: '' }));
    const kbOos = { inline_keyboard: [[{ text: '🔔 Notify me', url: `https://t.me/${botUserOos.username}?start=p_${product.id}` }]] };
    await autoPublishWithPhoto(bot, product, buildOutOfStockText(product), kbOos);
    return;
  }

  // Low stock (crossed below or equal 3, but not 0)
  const LOW_THRESHOLD = 3;
  if (stockBefore > LOW_THRESHOLD && stockAfter <= LOW_THRESHOLD && stockAfter > 0) {
    const botUserLs = await bot.getMe().catch(() => ({ username: '' }));
    const kbLs = { inline_keyboard: [[{ text: '🛒 Buy now', url: `https://t.me/${botUserLs.username}?start=p_${product.id}` }]] };
    await autoPublishWithPhoto(bot, product, buildLowStockText(product), kbLs);
  }
}

/**
 * Periodic stale-product reminder check.
 * Finds products that are active, in stock, and haven't sold (or weren't
 * sold since being added) for at least `stale_product_threshold_days`,
 * then sends one low-key reminder per eligible product — skipping any
 * product reminded within the last `stale_product_reminder_cooldown_hr`
 * hours, and capping how many go out per run so a store with many idle
 * products doesn't flood the channel/group all at once.
 *
 * Controlled entirely by settings, so admins can turn it off or change
 * the threshold from the admin panel without a code change:
 *   - stale_product_reminder_enabled     ('0' | '1', default '0' — opt-in)
 *   - stale_product_threshold_days       (default '3')
 *   - stale_product_reminder_cooldown_hr (default '24')
 *
 * @param {TelegramBot} bot
 * @param {object} db - the database/queries module
 */
const MAX_STALE_REMINDERS_PER_RUN = 3;

async function checkAndSendStaleProductReminders(bot, db) {
  const enabled = db.getSetting('stale_product_reminder_enabled', '0');
  if (enabled !== '1') return;

  const thresholdDays = parseInt(db.getSetting('stale_product_threshold_days', '3'), 10) || 3;
  const cooldownHours = parseInt(db.getSetting('stale_product_reminder_cooldown_hr', '24'), 10) || 24;

  let stale;
  try {
    stale = db.getStaleProducts(thresholdDays, cooldownHours);
  } catch (e) {
    logger.error(`getStaleProducts failed: ${e.message}`);
    return;
  }
  if (!stale || !stale.length) return;

  const batch = stale.slice(0, MAX_STALE_REMINDERS_PER_RUN);
  const botInfo = await bot.getMe().catch(() => ({ username: '' }));

  for (const product of batch) {
    const text = buildStaleProductText(product, botInfo.username);
    const kb = { inline_keyboard: [[{
      text: '🛒 Buy now',
      url: `https://t.me/${botInfo.username}?start=p_${product.id}`,
    }]] };

    try {
      await autoPublishWithPhoto(bot, product, text, kb);
      db.markStaleReminderSent(product.id);
      logger.info(`Stale-product reminder sent for product #${product.id} (${product.title})`);
    } catch (e) {
      logger.warn(`Stale-product reminder failed for product #${product.id}: ${e.message}`);
    }
  }
}

module.exports = {
  publishToChannel,
  publishToChannelWithPhoto,
  publishToGroupWithPhoto,
  autoPublishWithPhoto,
  publishToGroup,
  broadcastToUsers,
  autoPublish,
  checkAndNotifyStockLevel,
  checkAndSendStaleProductReminders,
  buildNewProductText,
  buildStockUpdateText,
  buildLowStockText,
  buildOutOfStockText,
  buildPriceDropText,
  buildStaleProductText,
};
