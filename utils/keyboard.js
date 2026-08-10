'use strict';

const { formatPrice } = require('./format');

// ── Helpers ───────────────────────────────────────────────────────────────────
const mk  = (rows) => ({ inline_keyboard: rows });
const btn = (text, callback_data) => ({ text, callback_data });
const urlBtn = (text, url) => ({ text, url });

// ── User keyboards ────────────────────────────────────────────────────────────

// Language picker (4 languages)
const languagePickerKb = () => mk([
  [btn('🇬🇧 English', 'set_lang_en'),    btn('🇸🇦 العربية', 'set_lang_ar')],
  [btn('🇻🇳 Tiếng Việt', 'set_lang_vi'), btn('🇪🇸 Español', 'set_lang_es')],
]);

const { t } = require('./i18n');

const mainMenuKb = (lang = 'en') => mk([
  [btn(t(lang, 'btn_products'), 'menu_products'),    btn(t(lang, 'btn_preorders'), 'menu_preorders')],
  [btn(t(lang, 'btn_wallet'), 'menu_wallet'),         btn(t(lang, 'btn_orders'), 'menu_orders')],
  [btn(t(lang, 'btn_support'), 'menu_support'),       btn(t(lang, 'btn_vip'), 'menu_vip')],
  [btn(t(lang, 'btn_refunds'), 'refund_request_start'),         btn(t(lang, 'btn_language'), 'menu_language')],
  [btn('🔌 API Access', 'menu_api')],
]);

// Pre-Order products listing (customer view)
const preorderProductsKb = (products) => {
  const rows = products.map((p) => {
    const remaining = Math.max(0, (p.preorder_max || 0) - (p.preorder_count || 0));
    const avail = remaining > 0 ? `🔜 ${remaining} left` : '❌ Full';
    const marker = p.premium_emoji_id ? '⭐️ ' : '';
    const cleanTitle = stripEmojiCodes(p.title || '');
    return [btn(`${marker}${cleanTitle} — ${formatPrice(p.price)} [${avail}]`, `preorder_view_${p.id}`)];
  });
  rows.push([btn('🔙 Back', 'back_main')]);
  return mk(rows);
};

const preorderDetailKb = (productId, available) => {
  if (available > 0) {
    return mk([
      [btn(`🔜 Reserve Pre-Order (${available} slots)`, `preorder_${productId}`)],
      [btn('🔙 Back', 'menu_preorders')],
    ]);
  }
  return mk([
    [btn('❌ All slots reserved', 'noop')],
    [btn('🔙 Back', 'menu_preorders')],
  ]);
};

const joinGateKb = (groupLink, channelLink) => {
  const rows = [];
  if (groupLink)   rows.push([urlBtn('💬 Join Discussion Group', groupLink)]);
  if (channelLink) rows.push([urlBtn('📢 Join Updates Channel', channelLink)]);
  rows.push([btn('✅ Check Again', 'check_membership')]);
  return mk(rows);
};

// Strip [emoji:ID] markers from button text, keep the original emoji character intact.
// The marker is followed by the original emoji which may be 1-7 UTF-16 code units
// (surrogate pairs + skin tone + ZWJ sequences). We just remove the marker tag.
function stripEmojiCodes(text) {
  if (!text) return text;
  return String(text).replace(/\[emoji:\d+\]/g, '');
}

const PRODUCTS_PER_PAGE = 25;

// Strip leading whitespace from title (clean left-align)
function cleanTitle(text) {
  if (!text) return '';
  return String(text)
    .replace(/\[emoji:\d+\]/g, '')        // remove emoji markers
    .replace(/^[\s\u00A0\u200B\u200C\u200D\u2060\uFEFF]+/, '') // trim leading whitespace + zero-width
    .replace(/\s+/g, ' ')                    // collapse spaces
    .trim();
}

const productsKb = (products, page = 0) => {
  const totalPages = Math.max(1, Math.ceil(products.length / PRODUCTS_PER_PAGE));
  const currentPage = Math.max(0, Math.min(page, totalPages - 1));
  const start = currentPage * PRODUCTS_PER_PAGE;
  const slice = products.slice(start, start + PRODUCTS_PER_PAGE);

  const rows = slice.map((p) => {
    const qty   = (typeof p.stock_quantity === 'number') ? p.stock_quantity : (p.stock_count || 0);
    const stock = qty > 0 ? `✅ ${qty}` : `❌ Out`;
    const title = cleanTitle(p.title || '').slice(0, 50);
    return [btn(`${title} — ${formatPrice(p.price)} [${stock}]`, `product_${p.id}`)];
  });

  // Pagination row (only if more than one page)
  if (totalPages > 1) {
    const navRow = [];
    if (currentPage > 0) navRow.push(btn('◀️ Prev', `products_page_${currentPage - 1}`));
    navRow.push(btn(`${currentPage + 1}/${totalPages}`, 'noop'));
    if (currentPage < totalPages - 1) navRow.push(btn('Next ▶️', `products_page_${currentPage + 1}`));
    rows.push(navRow);
  }

  rows.push([btn('🔙 Back', 'back_main')]);
  return mk(rows);
};

const productDetailKb = (productId, hasStock, preorderInfo = null) => {
  // preorderInfo: { enabled: bool, available: int (remaining slots) }
  if (hasStock) {
    return mk([
      [btn('🛒 Buy Now', `buy_${productId}`)],
      [btn('🔙 Back', 'menu_products')],
    ]);
  }
  // Out of stock — but Pre-Order may be available
  if (preorderInfo && preorderInfo.enabled && preorderInfo.available > 0) {
    return mk([
      [btn(`🔜 Pre-Order Now (${preorderInfo.available} slots left)`, `preorder_${productId}`)],
      [btn('🔔 Notify me when back in stock', `notify_back_${productId}`)],
      [btn('🔙 Back', 'menu_products')],
    ]);
  }
  // Plain out of stock
  return mk([
    [btn('❌ Out of Stock', 'noop')],
    [btn('🔔 Notify me when back in stock', `notify_back_${productId}`)],
    [btn('🔙 Back', 'menu_products')],
  ]);
};

const orderConfirmKb = () => mk([
  [
    btn('✅ Continue Payment', 'confirm_session'),
    btn('❌ Cancel', 'cancel_session'),
  ],
]);

const paymentMethodKb = (orderId, showCryptobot = true) => mk([
  [btn('💰 Pay with Wallet',       `pay_wallet_${orderId}`)],
  [btn('🟡 Pay with Binance Pay',  `pay_binance_${orderId}`)],
  [btn('💎 Pay with USDT',         `pay_usdt_${orderId}`)],
  ...(showCryptobot ? [[btn('🤖 Pay with CryptoBot', `pay_cryptobot_${orderId}`)]] : []),
  [btn('❌ Cancel',                `cancel_order_${orderId}`)],
]);

const walletMenuKb = () => mk([
  [btn('💳 Top Up Wallet',                'wallet_topup')],
  [btn('📜 Transactions',                 'wallet_transactions')],
  [btn('🔙 Back', 'back_main')],
]);

const walletTopupMethodKb = () => mk([
  [btn('🟡 Top Up with Binance Pay', 'wallet_topup_binance')],
  [btn('💎 Top Up with USDT', 'wallet_topup_usdt')],
  [btn('🤖 Top Up with CryptoBot', 'wallet_topup_cryptobot')],
  [btn('🔙 Back to Wallet', 'menu_wallet')],
]);

const cryptobotAssetKb = () => mk([
  [btn('USDT', 'cryptobot_asset_USDT')],
  [btn('🔙 Back', 'wallet_topup_cryptobot')],
]);

const ordersListKb = (orders) => {
  const statusMap = { pending: '⏳', delivered: '✅', cancelled: '❌' };
  const rows = [];
  // (removed — refund request is now via main menu)
  orders.slice(0, 10).forEach((o) => {
    const emoji = statusMap[o.status] || '❓';
    const title = (o.product_title || '').slice(0, 22);
    rows.push([btn(`${emoji} #${o.id} — ${title}`, `order_detail_${o.id}`)]);
  });
  rows.push([btn('🔙 Back', 'back_main')]);
  return mk(rows);
};

const orderDetailKb  = () => mk([[btn('🔙 My Orders', 'menu_orders')]]);
const cancelKb = (cb = 'back_main') => mk([[btn('❌ Cancel', cb)]]);
const backKb   = (cb = 'back_main') => mk([[btn('🔙 Back', cb)]]);

const supportKb = () => mk([
  [btn('📝 Send Message', 'support_send')],
  [btn('🔙 Back', 'back_main')],
]);

// ── Admin keyboards ───────────────────────────────────────────────────────────

const adminMainKb = () => mk([
  [btn('➕ Add Product',     'admin_add_product'),   btn('✏️ Edit Product', 'admin_edit_product')],
  [btn('🗑 Delete Product',  'admin_delete_product'), btn('📦 Stock',        'admin_stock')],
  [btn('↕️ Sort Products',   'admin_sort_products'),  btn('📋 Orders',       'admin_orders')],
  [btn('🔜 Pre-Orders',      'admin_preorders'),      btn('💳 Pending',      'admin_pending')],
  [btn('👥 Users',           'admin_users'),          btn('📣 Broadcast',    'admin_broadcast')],
  [btn('📊 Statistics',      'admin_stats'),          btn('📈 Profits',      'admin_profits')],
  [btn('🏦 Customer Wallets', 'admin_treasury')],
  [btn('🎫 Tickets',         'admin_tickets'),        btn('💸 Refund',       'admin_refund')],
  [btn('📢 Announcement',    'admin_announcement'),   btn('⚙️ Settings',     'admin_settings')],
  [btn('🎨 Emoji Library',   'admin_emojis'),         btn('🚧 Maintenance',  'admin_maintenance')],
  [btn('🔔 Notifications',   'admin_notifications'), btn('📦 Manual Delivery', 'admin_md_list_pending_0')],
  [btn('🛡 Deposit Review',  'admin_deposits')],
  [btn('🔄 Refund Requests', 'admin_refund_requests')],
  [btn('🛡️ Deposit Cutoff',  'admin_cutoff')],
  [btn('👑 VIP Broadcast',    'admin_vip_toggle')],
  [btn('🕵️ Audit Wallet Bugs', 'admin_audit_wallets')],
  [btn('🚨 Audit OOS Exploit',  'admin_audit_oos')],
  [btn('🗂 Categories',         'admin_categories')],
  [btn('🤖 ChatGPT Business',   'admin_cgb_panel')],
  [btn('🏪 Resellers (API)',    'admin_resellers')],
  [btn('➕ Add User Balance', 'admin_add_balance'),    btn('➖ Remove User Balance', 'admin_remove_balance')],
]);

// Pre-Order management keyboards
const adminPreordersMainKb = () => mk([
  [btn('📋 View All Pre-Orders', 'admin_preorders_list')],
  [btn('⚙️ Manage Product Pre-Orders', 'admin_preorders_manage')],
  [btn('🔙 Back', 'admin_panel')],
]);

const adminPreorderProductsKb = (products) => {
  const rows = products.map((p) => {
    const status = p.preorder_enabled ? '✅' : '⚪';
    const count  = p.preorder_count || 0;
    const max    = p.preorder_max || 0;
    return [btn(`${status} ${p.title} (${count}/${max})`, `admin_pre_setup_${p.id}`)];
  });
  rows.push([btn('🔙 Back', 'admin_preorders')]);
  return mk(rows);
};

const adminPreorderSetupKb = (productId, enabled) => mk([
  [btn(enabled ? '🔴 Disable Pre-Order' : '🟢 Enable Pre-Order', `admin_pre_toggle_${productId}`)],
  [btn('🔢 Set Max Quantity', `admin_pre_setmax_${productId}`)],
  [btn('👥 View Reservations', `admin_pre_reservations_${productId}`)],
  [btn('🔙 Back', 'admin_preorders_manage')],
]);

const adminPreordersListKb = (preorders) => {
  const rows = preorders.slice(0, 15).map((pr) => {
    const status = pr.status === 'reserved' ? '⏳' : (pr.status === 'delivered' ? '✅' : '❌');
    const name = pr.username || pr.first_name || `User ${pr.user_id}`;
    return [btn(`${status} #${pr.id} ${name} — ${pr.product_title} ×${pr.quantity}`, `admin_pre_detail_${pr.id}`)];
  });
  rows.push([btn('🔙 Back', 'admin_preorders')]);
  return mk(rows);
};

const adminPreorderDetailKb = (preorderId, status) => {
  const rows = [];
  if (status === 'reserved') {
    rows.push([btn('📦 Deliver Now', `admin_pre_deliver_${preorderId}`)]);
    rows.push([btn('💸 Refund to Wallet', `admin_pre_refund_${preorderId}`)]);
  }
  rows.push([btn('🔙 Back', 'admin_preorders_list')]);
  return mk(rows);
};

/**
 * Product ordering list.
 *
 * The old layout packed four buttons into every row
 * (`#N | name | ▲ | ▼`), which squeezed the name into ~22 characters —
 * "⭐Gemin", "☀️Accou", "✳️claude" — and rendered the whole screen useless
 * with 25 products. One product per row gives the name the full width, and
 * paging keeps the screen short enough to actually read.
 */
const SORT_PAGE_SIZE = 10;

const adminSortProductsKb = (products, page = 0) => {
  const totalPages = Math.max(1, Math.ceil(products.length / SORT_PAGE_SIZE));
  const pg = Math.max(0, Math.min(page, totalPages - 1));
  const slice = products.slice(pg * SORT_PAGE_SIZE, (pg + 1) * SORT_PAGE_SIZE);

  const rows = slice.map((p, i) => {
    const pos = pg * SORT_PAGE_SIZE + i + 1;
    const status = p.is_active ? '🟢' : '🔴';
    const title = String(p.title || '').replace(/\[emoji:\d+\]/g, '').trim().slice(0, 34);
    return [btn(`#${pos}  ${status} ${title}`, `admin_sortitem_${p.id}`)];
  });

  if (totalPages > 1) {
    const nav = [];
    if (pg > 0)              nav.push(btn('◀️ Prev', `admin_sort_p_${pg - 1}`));
    nav.push(btn(`${pg + 1}/${totalPages}`, 'noop'));
    if (pg < totalPages - 1) nav.push(btn('Next ▶️', `admin_sort_p_${pg + 1}`));
    rows.push(nav);
  }

  rows.push([btn('🔢 Jump to Position', 'admin_sortbynum')]);
  rows.push([btn('🔄 Auto-Renumber (1,2,3...)', 'admin_resetorder')]);
  rows.push([btn('🔙 Back', 'admin_panel')]);
  return mk(rows);
};

/** Single-product screen: move it, or set an exact position. */
const adminSortItemKb = (productId, page = 0) => mk([
  [btn('⬆️ Move Up', `admin_moveup_${productId}`), btn('⬇️ Move Down', `admin_movedown_${productId}`)],
  [btn('🔢 Set Exact Position', `admin_setorder_${productId}`)],
  [btn('✏️ Edit This Product', `admin_edit_p_${productId}`)],
  [btn('🔙 Back to List', `admin_sort_p_${page}`)],
]);

const adminProfitsKb = () => mk([
  [btn('📅 Today',         'admin_profit_today')],
  [btn('📆 Last 7 Days',   'admin_profit_7days')],
  [btn('🗓 This Month',    'admin_profit_month')],
  [btn('📊 Daily Breakdown (30d)', 'admin_profit_breakdown')],
  [btn('🔙 Back', 'admin_panel')],
]);

const adminRefundConfirmKb = (orderId) => mk([
  [btn('✅ Confirm Refund', `admin_refund_confirm_${orderId}`), btn('❌ Cancel', 'admin_panel')],
]);

const deleteStockItemKb = (stockItems, productId) => {
  const rows = stockItems.slice(0, 20).map((item) => {
    const preview = (item.content || '').slice(0, 30);
    return [btn(`🗑 #${item.id}: ${preview}`, `admin_del_stock_item_${item.id}`)];
  });
  rows.push([btn('🔙 Back to Product', `admin_edit_p_${productId}`)]);
  return mk(rows);
};

const adminProductsKb = (products, action = 'edit') =>
  mk([
    ...products.map((p) => {
      const qty = (typeof p.stock_quantity === 'number') ? p.stock_quantity : (p.stock_count || 0);
      const cleanTitle = stripEmojiCodes(p.title || '');
      return [
        btn(
          `${cleanTitle} — ${formatPrice(p.price)} [${qty} stock / ${p.sales_count || 0} sold]`,
          `admin_${action}_p_${p.id}`
        ),
      ];
    }),
    [btn('🔙 Back', 'admin_panel')],
  ]);

// Bulk pricing overview — shows all 3 tiers at a glance with edit/clear per tier
const adminBulkPriceKb = (product) => {
  const tiers = [
    { n: 1, qty: product.bulk_tier1_qty, price: product.bulk_tier1_price },
    { n: 2, qty: product.bulk_tier2_qty, price: product.bulk_tier2_price },
    { n: 3, qty: product.bulk_tier3_qty, price: product.bulk_tier3_price },
  ];
  const rows = tiers.map((t) => {
    const isSet = t.qty > 0 && t.price > 0;
    const label = isSet
      ? `✏️ Tier ${t.n}: ${t.qty}+ → $${Number(t.price).toFixed(2)}`
      : `➕ Add Tier ${t.n}`;
    const row = [btn(label, `admin_bulkprice_edit_${product.id}_${t.n}`)];
    if (isSet) row.push(btn('🗑', `admin_bulkprice_clear_${product.id}_${t.n}`));
    return row;
  });
  rows.push([btn('🔙 Back to Product', `admin_edit_p_${product.id}`)]);
  return mk(rows);
};

const adminProductEditFieldsKb = (productId) =>
  mk([
    // ── Product fields ────────────────────────────────────────────────
    [btn('✏️ Title',          `admin_edit_field_${productId}_title`)],
    [btn('✏️ Description',    `admin_edit_field_${productId}_description`)],
    [btn('✏️ Price',          `admin_edit_field_${productId}_price`)],
    [btn('💸 Cost Price',     `admin_edit_field_${productId}_cost_price`)],
    [btn('✏️ Warranty',       `admin_edit_field_${productId}_warranty`)],
    [btn('📋 Instruction',    `admin_edit_field_${productId}_instruction`)],
    [btn('💎 Premium Emoji',  `admin_edit_field_${productId}_premium_emoji_id`)],
    [btn('🗂 Set Category',    `admin_assigncat_${productId}`)],
    // ── V2: per-product behaviour toggles ─────────────────────────────
    [btn('🔄 Refund Eligibility',  `admin_toggle_refund_${productId}`)],
    [btn('🚚 Delivery Method',     `admin_toggle_delivery_${productId}`)],
    [btn('🔔 Low-Stock Threshold', `admin_lowstock_${productId}`)],
    [btn('🤖 Toggle ChatGPT Business Mode', `admin_toggle_cgb_${productId}`)],
    [btn('🏪 Wholesale Price', `admin_edit_field_${productId}_wholesale_price`)],
    [btn('🖼 Change Image',    `admin_edit_field_${productId}_image_file_id`)],
    [btn('✏️ Requires Email', `admin_edit_field_${productId}_requires_email`)],
    [btn('✏️ Active',         `admin_edit_field_${productId}_is_active`)],
    [btn('✏️ Sales Count',    `admin_edit_field_${productId}_sales_count`)],
    // ── Bulk pricing (quantity tiers) ──────────────────────────────────
    [btn('📊 Bulk Pricing (by quantity)', `admin_bulkprice_${productId}`)],
    // ── Stock management (direct from edit page) ──────────────────────
    [
      btn('➕ Add Stock Items',  `admin_stock_add_${productId}`),
      btn('📦 View Stock Count', `admin_stock_view_${productId}`),
    ],
    [btn('📋 Show Full Stock Details', `admin_stock_full_${productId}`)],
    [
      btn('➖ Remove Quantity',     `admin_stock_removeqty_${productId}`),
      btn('✏️ Set Stock Manually', `admin_stock_setqty_${productId}`),
    ],
    [
      btn('🔄 Set Stock to 0',   `admin_stock_zero_${productId}`),
      btn('🗑 Clear Unsold Stock', `admin_stock_clear_${productId}`),
    ],
    [btn('🔙 Back', 'admin_edit_product')],
  ]);

const adminStockManageKb = (productId) => mk([
  [
    btn('➕ Add Stock Items',      `admin_stock_add_${productId}`),
    btn('📦 View Stock Count',     `admin_stock_view_${productId}`),
  ],
  [btn('📤 Add Large Stock (multi-message)', `admin_stock_batch_${productId}`)],
  [btn('📋 Show Full Stock Details', `admin_stock_full_${productId}`)],
  [
    btn('➖ Remove Quantity',      `admin_stock_removeqty_${productId}`),
    btn('✏️ Set Stock Manually',  `admin_stock_setqty_${productId}`),
  ],
  [
    btn('🔄 Set Stock to 0',      `admin_stock_zero_${productId}`),
    btn('🗑 Clear Unsold Stock',   `admin_stock_clear_${productId}`),
  ],
  [btn('🔙 Back', 'admin_stock')],
]);

const confirmZeroStockKb = (productId) => mk([
  [
    btn('✅ Confirm', `admin_stock_zero_confirm_${productId}`),
    btn('❌ Cancel',  `admin_edit_p_${productId}`),
  ],
]);

const adminUsersKb = (users) =>
  mk([
    [btn('🔍 Search User', 'admin_user_search')],
    ...users.slice(0, 10).map((u) => {
      const name   = u.username || u.first_name || `User ${u.telegram_id}`;
      const banned = u.is_banned ? '🚫 ' : '';
      return [btn(`${banned}${name} — $${Number(u.balance).toFixed(2)}`, `admin_user_${u.telegram_id}`)];
    }),
    [btn('🔙 Back', 'admin_panel')],
  ]);

// Confirmation keyboard for delivering pre-orders after stock add
const adminPreorderConfirmDeliverKb = (productId, count) => mk([
  [btn(`✅ Yes, deliver ${count} pre-order(s)`, `admin_pre_confirm_deliver_${productId}`)],
  [btn('❌ No, skip delivery (I added wrong items)', `admin_pre_skip_deliver_${productId}`)],
]);

const adminUserActionsKb = (userId, isBanned) => mk([
  [btn('📦 View Purchases', `admin_user_orders_${userId}`)],
  [btn('💳 Top-Up History', `admin_user_topups_${userId}`)],
  [btn('🔄 Reset Wallet to $0', `admin_user_resetwallet_${userId}`)],
  [btn('💲 Special Prices', `admin_cprices_${userId}`)],
  [btn('🚨 Fraud: cancel all orders', `admin_fraud_${userId}`)],
  [btn(isBanned ? '✅ Unban' : '🚫 Ban', `admin_toggle_ban_${userId}`)],
  [btn('🔙 Back', 'admin_users')],
]);

// Confirmation keyboard for reset wallet
const adminResetWalletConfirmKb = (userId) => mk([
  [btn('✅ Confirm Reset', `admin_user_resetwallet_confirm_${userId}`)],
  [btn('❌ Cancel', `admin_user_${userId}`)],
]);

// Keyboard for the user's orders list
const adminUserOrdersKb = (userId, orders, page = 0) => {
  const statusMap = { pending: '⏳', delivered: '✅', cancelled: '❌' };
  const PAGE_SIZE = 15;
  const totalPages = Math.max(1, Math.ceil(orders.length / PAGE_SIZE));
  const currentPage = Math.max(0, Math.min(page, totalPages - 1));
  const start = currentPage * PAGE_SIZE;
  const end = start + PAGE_SIZE;
  const pageOrders = orders.slice(start, end);

  const rows = pageOrders.map((o) => {
    const emoji = statusMap[o.status] || '❓';
    const title = (o.product_title || '').slice(0, 25);
    return [btn(`${emoji} #${o.id} ${title} — ${formatPrice(o.total_price)}`, `admin_user_order_${o.id}`)];
  });

  // Pagination row
  if (totalPages > 1) {
    const pagRow = [];
    if (currentPage > 0) pagRow.push(btn('⬅️ Prev', `admin_user_orders_p_${userId}_${currentPage - 1}`));
    pagRow.push(btn(`${currentPage + 1}/${totalPages}`, 'noop'));
    if (currentPage < totalPages - 1) pagRow.push(btn('Next ➡️', `admin_user_orders_p_${userId}_${currentPage + 1}`));
    rows.push(pagRow);
  }

  rows.push([btn('🔙 Back to User', `admin_user_${userId}`)]);
  return mk(rows);
};

// Keyboard for a single order detail (from user view)
const adminUserOrderDetailKb = (userId) => mk([
  [btn('🔙 Back to Purchases', `admin_user_orders_${userId}`)],
]);

const adminTicketsKb = (tickets) =>
  mk([
    ...tickets.map((t) => {
      const name    = t.username || t.first_name || `User ${t.user_id}`;
      const preview = (t.message || '').slice(0, 22) + '…';
      return [btn(`🎫 #${t.id} — ${name}: ${preview}`, `admin_ticket_${t.id}`)];
    }),
    [btn('🔙 Back', 'admin_panel')],
  ]);

const adminTicketActionsKb = (ticketId) => mk([
  [btn('✉️ Reply', `admin_reply_ticket_${ticketId}`)],
  [btn('🔙 Back', 'admin_tickets')],
]);

const adminOrdersKb = (orders, page = 0) => {
  const statusMap = { pending: '⏳', delivered: '✅', cancelled: '❌' };
  const PAGE_SIZE = 15;
  const totalPages = Math.max(1, Math.ceil(orders.length / PAGE_SIZE));
  const currentPage = Math.max(0, Math.min(page, totalPages - 1));
  const start = currentPage * PAGE_SIZE;
  const pageOrders = orders.slice(start, start + PAGE_SIZE);

  const rows = [];
  for (const o of pageOrders) {
    const emoji = statusMap[o.status] || '❓';
    const user  = o.username || `User ${o.user_id}`;
    const row = [btn(`${emoji} #${o.id} ${user} — ${formatPrice(o.total_price)}`, `admin_order_view_${o.id}`)];
    if (o.status === 'pending') {
      row.push(btn('🚫', `admin_force_cancel_${o.id}`));
    }
    rows.push(row);
  }

  if (totalPages > 1) {
    const pagRow = [];
    if (currentPage > 0) pagRow.push(btn('⬅️ Prev', `admin_orders_p_${currentPage - 1}`));
    pagRow.push(btn(`${currentPage + 1}/${totalPages}`, 'noop'));
    if (currentPage < totalPages - 1) pagRow.push(btn('Next ➡️', `admin_orders_p_${currentPage + 1}`));
    rows.push(pagRow);
  }
  rows.push([btn('🔙 Back', 'admin_panel')]);
  return mk(rows);
};

const adminSettingsKb = () => mk([
  [btn('🏪 Store Name',        'admin_setting_store_name'),         btn('💵 Min Deposit',       'admin_setting_min_deposit')],
  [btn('🔧 Maintenance',       'admin_setting_maintenance_mode'),   btn('🔒 Join Required',     'admin_setting_join_required_enabled')],
  [btn('💬 Group Link',        'admin_setting_required_group_link'),btn('📢 Channel Link',       'admin_setting_required_channel_link')],
  [btn('📡 Updates Channel',   'admin_setting_updates_channel_id'), btn('💬 Updates Group',      'admin_setting_updates_group_id')],
  [btn('🔔 Product Notifs',    'admin_setting_product_notifications_enabled'), btn('📦 Stock Notifs', 'admin_setting_stock_notifications_enabled')],
  [btn('🎁 Referral Cashback', 'admin_setting_referral_cashback_enabled'), btn('💸 Cashback %', 'admin_setting_referral_cashback_pct')],
  [btn('💰 Min Order for Cashback', 'admin_setting_referral_min_order')],
  [btn('💤 Stale Product Reminders', 'admin_setting_stale_product_reminder_enabled'), btn('📅 Stale After (days)', 'admin_setting_stale_product_threshold_days')],
  [btn('🔔 Default Low-Stock Alert', 'admin_setting_low_stock_threshold_default'), btn('🟠 Low-Stock Alerts On/Off', 'admin_setting_stock_low_alerts_enabled')],
  [btn('📡 Admin Alert Chat ID', 'admin_setting_admin_notify_chat_id')],
  [btn('⏰ Deposit Window (min)', 'admin_setting_deposit_max_age_minutes'), btn('🛡 Strict Deposit Mode', 'admin_setting_deposit_strict_mode')],
  [btn('⌛ Reservation TTL (min)', 'admin_setting_deposit_intent_ttl_minutes'), btn('🚧 Deposit Cutoff (ms)', 'admin_setting_deposit_cutoff_ms')],
  [btn('🔕 Admin Alerts On/Off', 'admin_setting_admin_notify_enabled'), btn('💬 Support Welcome Msg', 'admin_setting_support_welcome_message')],
  [btn('🔙 Back', 'admin_panel')],
]);

const requiresEmailKb = () => mk([[btn('✅ Yes', 'req_email_yes'), btn('❌ No', 'req_email_no')]]);

const notifTargetKb = (context) => mk([
  [btn('📢 Channel + Group only',     `notif_${context}_channel`)],
  [btn('📢 Channel + Group + 👥 Bot Users', `notif_${context}_both`)],
  [btn('🚫 Skip',                     `notif_${context}_skip`)],
]);

const announcementTargetKb = () => mk([
  [btn('📢 Channel + Group only',     'ann_channel')],
  [btn('👥 Bot Users only',           'ann_users')],
  [btn('📢 Channel + Group + 👥 Users','ann_both')],
  [btn('❌ Cancel',                   'admin_panel')],
]);

const adminConfirmKb = (confirmCb, cancelCb = 'admin_panel') => mk([
  [btn('✅ Confirm', confirmCb), btn('❌ Cancel', cancelCb)],
]);

const adminBackKb = () => mk([[btn('🔙 Admin Panel', 'admin_panel')]]);

// Keyboard for the back-in-stock notification message sent to users
const backInStockKb = (productId) => mk([
  [btn('🛒 Buy Now', `product_${productId}`)],
]);

// Go back to the product edit page (for stock callbacks triggered from edit page)
const backToProductEditKb = (productId) => mk([[btn('🔙 Back to Product', `admin_edit_p_${productId}`)]]);


// Emoji Library keyboard
const adminEmojiLibraryKb = (emojis) => {
  const rows = emojis.slice(0, 20).map((e) => [
    btn(`${e.fallback} ${e.name}`, `admin_emoji_view_${e.id}`),
    btn('🗑', `admin_emoji_del_${e.id}`),
  ]);
  rows.push([btn('➕ Add New Emoji', 'admin_emoji_add')]);
  rows.push([btn('🔙 Back', 'admin_panel')]);
  return mk(rows);
};

module.exports = {
  mainMenuKb, joinGateKb, productsKb, productDetailKb,
  languagePickerKb,
  orderConfirmKb, paymentMethodKb, walletMenuKb,
  walletTopupMethodKb, cryptobotAssetKb,
  ordersListKb,
  orderDetailKb, cancelKb, backKb, supportKb,
  adminMainKb, adminProductsKb, adminProductEditFieldsKb, adminBulkPriceKb, adminStockManageKb,
  adminUsersKb, adminUserActionsKb, adminTicketsKb, adminTicketActionsKb,
  adminOrdersKb, adminSettingsKb, requiresEmailKb, notifTargetKb,
  announcementTargetKb, adminConfirmKb, adminBackKb, backInStockKb,
  confirmZeroStockKb, backToProductEditKb,
  adminProfitsKb, adminRefundConfirmKb, deleteStockItemKb,
  adminSortProductsKb,
  adminSortItemKb,
  adminPreordersMainKb, adminPreorderProductsKb, adminPreorderSetupKb,
  adminPreordersListKb, adminPreorderDetailKb,
  preorderProductsKb, preorderDetailKb,
  adminUserOrdersKb, adminUserOrderDetailKb,
  adminResetWalletConfirmKb,
  adminPreorderConfirmDeliverKb,
  adminEmojiLibraryKb,
};
