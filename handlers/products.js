'use strict';

const db = require('../database/queries');

// ─── Build Telegram entities from [emoji:ID]fallback markers ───────────────
// This converts: "[emoji:5796...]👨‍⚖ ExpressVPN"
// Into: text="👨‍⚖ ExpressVPN", entities=[{type:'custom_emoji', offset:0, length:N, custom_emoji_id:'5796...'}]
function buildTextAndEntities(rawText) {
  if (!rawText) return { text: '', entities: [] };
  let result = '';
  const entities = [];
  const regex = /\[emoji:(\d+)\]([\s\S]*?)(?=\[emoji:|$)/g;
  let lastIndex = 0;
  let hasMarker = false;

  // First pass: check if there's any marker
  if (!/\[emoji:\d+\]/.test(rawText)) {
    return { text: rawText, entities: [] };
  }

  // Walk through string, splitting at [emoji:ID] tags
  let m;
  const re = /\[emoji:(\d+)\]/g;
  let pos = 0;
  while ((m = re.exec(rawText)) !== null) {
    // Append text before the marker
    if (m.index > pos) {
      result += rawText.substring(pos, m.index);
    }
    const emojiId = m[1];
    // Validate ID — Telegram emoji IDs are 15-25 digits
    if (emojiId.length < 15 || emojiId.length > 25) {
      pos = m.index + m[0].length;
      continue;
    }
    // After the marker, the next 1-7 UTF-16 units are the fallback emoji
    let after = rawText.substring(m.index + m[0].length);
    // Take the first "grapheme" — up to 7 UTF-16 code units that form an emoji
    // Simple heuristic: take chars until we hit a space, letter, or known separator
    let fbLen = 0;
    const maxFb = Math.min(after.length, 7);
    for (let i = 0; i < maxFb; i++) {
      const ch = after.charCodeAt(i);
      // Stop at ASCII letters, digits, space, basic punctuation
      if (ch >= 0x21 && ch <= 0x7E && !'#*0123456789'.includes(after[i])) break;
      fbLen++;
      // If we just consumed a high surrogate, also consume the low surrogate
      if (ch >= 0xD800 && ch <= 0xDBFF && i + 1 < maxFb) {
        fbLen++;
        i++;
      }
    }
    if (fbLen === 0) fbLen = 1; // At least take 1 char as fallback
    const fallback = after.substring(0, fbLen) || '🎁';

    // Add entity
    const offset = result.length; // UTF-16 offset
    entities.push({
      type: 'custom_emoji',
      offset: offset,
      length: fallback.length,
      custom_emoji_id: emojiId,
    });
    result += fallback;
    pos = m.index + m[0].length + fbLen;
  }
  // Append remaining text
  if (pos < rawText.length) {
    result += rawText.substring(pos);
  }
  return { text: result, entities };
}

const { productsKb, productDetailKb, backKb, preorderProductsKb, preorderDetailKb,
        iconBtn, iconIdFrom, productIconId, stripEmojiCodes } = require('../utils/keyboard');
const { formatPrice, expandPremiumEmojis } = require('../utils/format');

// Safe message updater: tries editMessageText, falls back to delete+send if message was a photo/media
async function safeUpdateMessage(bot, chatId, messageId, text, options = {}) {
  if (!messageId) {
    return bot.sendMessage(chatId, text, options);
  }
  try {
    return await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...options });
  } catch (e) {
    // Edit failed (probably original was a photo) - delete and send new
    try { await bot.deleteMessage(chatId, messageId); } catch (e2) {}
    return bot.sendMessage(chatId, text, options);
  }
}

async function showProducts(bot, chatId, messageId = null, page = 0) {
  // If categories exist, show categories list first
  let categories = [];
  try {
    categories = db.getAllCategories ? db.getAllCategories() : [];
  } catch (e) {
    // silent — categories just won't show if DB fails
  }
  if (categories && categories.length > 0) {
    return showCategories(bot, chatId, messageId);
  }

  // Otherwise show all products (legacy behavior)
  const products = db.getAllActiveProducts();
  const text = '🛍 <b>Products</b>\n\nSelect a product:';
  const noText = '📭 No products available yet. Check back soon!';
  const kb = products.length
    ? productsKb(products, page)
    : { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'back_main' }]] };

  if (messageId) {
    await safeUpdateMessage(bot, chatId, messageId, products.length ? text : noText, {
      parse_mode: 'HTML', reply_markup: kb,
    });
  } else {
    await bot.sendMessage(chatId, products.length ? text : noText, {
      parse_mode: 'HTML', reply_markup: kb,
    });
  }
}

async function showCategories(bot, chatId, messageId = null) {
  const categories = db.getAllCategories();
  const allProducts = db.getAllActiveProducts();
  const uncategorized = allProducts.filter(p => !p.category_id || p.category_id === 0);

  const rows = [];

  // 1) Categories FIRST — in pairs (2 per row to save space)
  //
  // Built with iconBtn so a category row gets the same premium-emoji icon and
  // colour treatment as the product rows inside it. The icon id can come from
  // either the category's emoji field or its name, since a premium emoji typed
  // into either is stored as an [emoji:ID] marker.
  const catButton = (c) => {
    const count = db.getProductsByCategory(c.id).filter(p => p.is_active).length;
    const iconId = iconIdFrom(c.emoji) || iconIdFrom(c.name);
    const emojiText = stripEmojiCodes(c.emoji || '').trim();
    const nameText  = stripEmojiCodes(c.name  || '').trim();
    const label = `${emojiText ? emojiText + ' ' : ''}${nameText} (${count})`;
    // An empty category reads as unavailable, like an out-of-stock product.
    return iconBtn(label, `cat_${c.id}`, { iconId, inStock: count > 0 });
  };

  for (let i = 0; i < categories.length; i += 2) {
    const row = [catButton(categories[i])];
    if (categories[i + 1]) row.push(catButton(categories[i + 1]));
    rows.push(row);
  }

  // 2) Separator row (Other Products header)
  if (uncategorized.length > 0 && categories.length > 0) {
    rows.push([{ text: '━━━ 📦 Other Products ━━━', callback_data: 'noop' }]);
  }

  // 3) Uncategorized products — one per row
  for (const p of uncategorized) {
    const qty = (typeof p.stock_quantity === 'number') ? p.stock_quantity : (p.stock_count || 0);
    const inStock = qty > 0;
    const stock = inStock ? `✅ ${qty}` : `❌ Out`;
    const cleanTitle = String(p.title || '')
      .replace(/\[emoji:\d+\]/g, '')
      .replace(/^[\s\u00A0\u200B\u200C\u200D\u2060\uFEFF]+/, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 45);
    const price = `$${(p.price || 0).toFixed(2)}`;
    rows.push([iconBtn(
      `${cleanTitle} — ${price} [${stock}]`,
      `product_${p.id}`,
      { iconId: productIconId(p), inStock }
    )]);
  }

  rows.push([{ text: '🔄 Refresh', callback_data: 'refresh_products' }, { text: '🔙 Back', callback_data: 'back_main' }]);

  let text = '🛍 <b>Products</b>\n\n';
  if (categories.length > 0) text += `🗂 ${categories.length} categor${categories.length === 1 ? 'y' : 'ies'}`;
  if (uncategorized.length > 0) {
    text += `${categories.length > 0 ? ' • ' : ''}📦 ${uncategorized.length} product${uncategorized.length === 1 ? '' : 's'}`;
  }
  text += '\n\nTap a category or product:';

  if (messageId) {
    await safeUpdateMessage(bot, chatId, messageId, text, {
      parse_mode: 'HTML', reply_markup: { inline_keyboard: rows },
    });
  } else {
    await bot.sendMessage(chatId, text, {
      parse_mode: 'HTML', reply_markup: { inline_keyboard: rows },
    });
  }
}

async function showProductsByCategory(bot, chatId, messageId, categoryId, page = 0) {
  let products, title;
  if (categoryId === 0) {
    products = db.getAllActiveProducts();
    title = '📋 All Products';
  } else {
    products = db.getProductsByCategory(categoryId).filter(p => p.is_active);
    const cat = db.getCategoryById(categoryId);
    title = `${cat?.emoji || '🗂'} ${cat?.name || 'Category'}`;
  }

  if (!products.length) {
    const kb = { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'menu_products' }]] };
    await safeUpdateMessage(bot, chatId, messageId, `${title}\n\n📭 No products available.`, {
      parse_mode: 'HTML', reply_markup: kb,
    });
    return;
  }

  // Build keyboard with pagination
  const { inline_keyboard } = productsKb(products, page);
  // Replace the "Back" row to go to categories instead of main
  inline_keyboard[inline_keyboard.length - 1] = [{ text: '🔙 Back to categories', callback_data: 'menu_products' }];

  // Update pagination callback to include category
  for (const row of inline_keyboard) {
    for (const btn of row) {
      if (btn.callback_data && btn.callback_data.startsWith('products_page_')) {
        const p = btn.callback_data.split('_').pop();
        btn.callback_data = `cat_page_${categoryId}_${p}`;
      }
    }
  }

  await safeUpdateMessage(bot, chatId, messageId, `${title}\n\nSelect a product:`, {
    parse_mode: 'HTML', reply_markup: { inline_keyboard },
  });
}

async function showProductDetail(bot, chatId, productId, messageId = null, userId = chatId) {
  // In a private chat chatId === userId; kept as an explicit parameter so
  // the customer-price lookup below has a named dependency.
  let product = db.getProduct(productId);
  // A negotiated price for this customer replaces the public one, so the
  // quoted price and the charged price can never diverge.
  product = db.productForCustomer(userId, product);
  if (!product) {
    await bot.sendMessage(chatId, '❌ Product not found.');
    return;
  }

  // ── ChatGPT Business Mode: redirect to secondary bot ──
  if (product.is_chatgpt_business) {
    const cgbBotUsername = process.env.CHATGPT_BOT_USERNAME || '';
    const cleanUsername = cgbBotUsername.replace(/^@/, '');
    const text =
      `<b>${expandPremiumEmojis(product.title)}</b>\n\n` +
      `🤖 <b>This product uses smart billing cycles.</b>\n\n` +
      `📝 ${product.description || 'ChatGPT Business subscription with dynamic pricing based on billing cycle.'}\n\n` +
      `Tap the button below to continue to the subscription bot. ` +
      `The price will be calculated automatically based on the current billing cycle.`;
    const buttons = [];
    if (cleanUsername) {
      buttons.push([{ text: '🤖 Continue to subscription bot', url: `https://t.me/${cleanUsername}?start=cgb_${productId}` }]);
    } else {
      buttons.push([{ text: '⚠️ Subscription bot not configured', callback_data: 'noop' }]);
    }
    buttons.push([{ text: '🔙 Back', callback_data: 'menu_products' }]);

    if (messageId) {
      await safeUpdateMessage(bot, chatId, messageId, text, {
        parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons },
      });
    } else {
      await bot.sendMessage(chatId, text, {
        parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons },
      });
    }
    return;
  }


  // Use stock_quantity for purchase eligibility
  const stockQty  = product.stock_quantity || 0;
  const stockLine = stockQty > 0
    ? `📦 <b>Stock:</b> ${stockQty}`
    : '❌ <b>Out of Stock</b>';

  const { formatBulkTiersDisplay: _ftd } = require('../utils/format');
  const bulkLine = _ftd(product);

  // Format title with premium emoji if set
  const titleHtml = product.premium_emoji_id
    ? `<tg-emoji emoji-id="${product.premium_emoji_id}">🛍</tg-emoji> <b>${expandPremiumEmojis(product.title)}</b>`
    : `<b>${expandPremiumEmojis(product.title)}</b>`;

  // Manual products are fulfilled by a human — say so up-front so the buyer
  // is not surprised when nothing arrives instantly.
  const deliveryLine = product.delivery_type === 'manual'
    ? `\n🖐 <b>Delivery:</b> Manual — sent by our team after payment`
    : '';

  const text =
    `${titleHtml}\n\n` +
    `📝 ${product.description || 'No description.'}\n\n` +
    `🛡 <b>Warranty:</b> ${product.warranty || 'N/A'}\n` +
    `💵 <b>Price:</b> ${formatPrice(product.price)}\n` +
    `${stockLine}\n` +
    `📈 <b>Sold:</b> ${product.sales_count || product.sold_count || 0}` +
    deliveryLine +
    bulkLine;

  const preorderInfo = {
    enabled:   !!product.preorder_enabled,
    available: Math.max(0, (product.preorder_max || 0) - (product.preorder_count || 0)),
  };
  const kb = productDetailKb(productId, stockQty > 0, preorderInfo);

  let photoSent = false;
  if (product.image_file_id) {
    try {
      if (messageId) await bot.deleteMessage(chatId, messageId).catch(() => {});
      await bot.sendPhoto(chatId, product.image_file_id, {
        caption: text, parse_mode: 'HTML', reply_markup: kb,
      });
      photoSent = true;
    } catch (e) {
      // Photo failed (file_id invalid, corrupt, or expired). Fall back to text message.
      // Reset messageId since we may have deleted it
      messageId = null;
    }
  }

  if (photoSent) return;

  if (messageId) {
    await safeUpdateMessage(bot, chatId, messageId, text, { parse_mode: 'HTML', reply_markup: kb });
  } else {
    await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: kb });
  }
}


// ── Pre-Order Products (separate listing) ─────────────────────────────────────
async function showPreorderProducts(bot, chatId, messageId = null) {
  const products = db.getPreorderEnabledProducts();
  if (!products.length) {
    const text = '🔜 <b>Pre-Orders</b>\n\nNo pre-order products available at the moment.';
    if (messageId) {
      await safeUpdateMessage(bot, chatId, messageId, text, { parse_mode: 'HTML', reply_markup: backKb('back_main') });
    } else {
      await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: backKb('back_main') });
    }
    return;
  }
  const text =
    '🔜 <b>Pre-Order Products</b>\n\n' +
    'Reserve your spot — pay now, receive when stock arrives.\n\n' +
    'Tap a product to see details:';
  if (messageId) {
    await safeUpdateMessage(bot, chatId, messageId, text, { parse_mode: 'HTML', reply_markup: preorderProductsKb(products) });
  } else {
    await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: preorderProductsKb(products) });
  }
}

async function showPreorderProductDetail(bot, chatId, productId, messageId = null, userId = chatId) {
  // In a private chat chatId === userId; kept as an explicit parameter so
  // the customer-price lookup below has a named dependency.
  let product = db.getProduct(productId);
  // A negotiated price for this customer replaces the public one, so the
  // quoted price and the charged price can never diverge.
  product = db.productForCustomer(userId, product);
  if (!product || !product.is_active || !product.preorder_enabled) {
    await bot.sendMessage(chatId, '❌ Pre-order not available for this product.');
    return;
  }
  const remaining = Math.max(0, (product.preorder_max || 0) - (product.preorder_count || 0));
  const preorderTitle = product.premium_emoji_id
    ? `<tg-emoji emoji-id="${product.premium_emoji_id}">🔜</tg-emoji> <b>${expandPremiumEmojis(product.title)}</b>`
    : `🔜 <b>${expandPremiumEmojis(product.title)}</b>`;
  const text =
    `${preorderTitle}\n\n` +
    `${product.description || ''}\n\n` +
    `💵 <b>Price:</b> ${formatPrice(product.price)}\n` +
    `🛡 <b>Warranty:</b> ${product.warranty || 'N/A'}\n` +
    `📦 <b>Available slots:</b> ${remaining} / ${product.preorder_max}\n` +
    `👥 <b>Reserved:</b> ${product.preorder_count || 0}\n\n` +
    `<i>💡 Pay now to reserve your slot. Delivery will be manual once stock arrives.</i>`;

  const kb = preorderDetailKb(productId, remaining);
  let photoSent = false;
  if (product.image_file_id) {
    try {
      if (messageId) {
        await bot.deleteMessage(chatId, messageId).catch(() => {});
      }
      await bot.sendPhoto(chatId, product.image_file_id, { caption: text, parse_mode: 'HTML', reply_markup: kb });
      photoSent = true;
    } catch (e) {
      messageId = null;
    }
  }
  if (photoSent) return;
  if (messageId) {
    await safeUpdateMessage(bot, chatId, messageId, text, { parse_mode: 'HTML', reply_markup: kb });
  } else {
    await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: kb });
  }
}


module.exports = { showProducts, showProductDetail, showPreorderProducts, showPreorderProductDetail, showCategories, showProductsByCategory };
