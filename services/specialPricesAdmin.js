'use strict';
/**
 * 💲 Special prices BY PRODUCT (V163).
 * Pick a product (e.g. Gemini): see everyone who has a special price on it, and remove them all together —
 * or just some of them. Always after a confirmation; every removal is logged.
 *
 * Callbacks: admin_spx (products) · admin_spx_p_<productId>_<page> · admin_spx_c_<productId> (confirm all)
 *            admin_spx_y_<productId> (do it) · admin_spx_u_<productId>_<userId> (one customer)
 */
const db = require('../database/queries');
const logger = require('../utils/logger');
const { formatPriceExact } = require('../utils/format');

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clean = (t) => String(t || '').replace(/\[emoji:\d+\]/g, '').trim();
const PER = 12;
const BACK = [{ text: '🔙 Admin', callback_data: 'admin_panel' }];

const who = (r) => (r.username ? `@${r.username}` : (r.first_name || `user`)) + ` · ${r.user_id}`;

/** Products that have special prices, with how many customers each. */
function productsWithPrices() {
  return db.getAllProductsBrief()
    .map((p) => ({ ...p, rows: db.listPricesForProduct(p.id) }))
    .filter((p) => p.rows.length)
    .map((p) => ({ ...p, customers: new Set(p.rows.map((r) => r.user_id)).size }));
}

/** One line per customer (a customer can have several quantity tiers on a product). */
function groupByCustomer(rows) {
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r.user_id)) m.set(r.user_id, { user_id: r.user_id, username: r.username, first_name: r.first_name, tiers: [] });
    m.get(r.user_id).tiers.push(r);
  }
  return [...m.values()];
}

const tierText = (t) => `${t.min_qty > 1 ? `${t.min_qty}+ → ` : ''}${formatPriceExact(t.price)}`;

function viewProducts() {
  const list = productsWithPrices();
  if (!list.length) {
    return { text: '💲 <b>Special prices by product</b>\n\n<i>Nobody has a special price right now.</i>', kb: [BACK] };
  }
  const kb = list.slice(0, 40).map((p) => [{
    text: `${clean(p.title).slice(0, 30)} · ${p.customers} customer${p.customers === 1 ? '' : 's'}`,
    callback_data: `admin_spx_p_${p.id}_0`,
  }]);
  kb.push(BACK);
  return { text: '💲 <b>Special prices by product</b>\n\nPick a product to see who has a special price on it — and remove them together.', kb };
}

function viewProduct(productId, page = 0, note = '') {
  const p = db.getAllProductsBrief().find((x) => x.id === productId);
  const people = groupByCustomer(db.listPricesForProduct(productId));
  const title = p ? clean(p.title) : `Product ${productId}`;
  if (!people.length) {
    return { text: `${note ? note + '\n\n' : ''}💲 <b>${esc(title)}</b>\n\n<i>No customer has a special price on it.</i>`,
             kb: [[{ text: '🔙 Products', callback_data: 'admin_spx' }]] };
  }
  const pages = Math.max(1, Math.ceil(people.length / PER));
  const pg = Math.max(0, Math.min(page, pages - 1));
  const slice = people.slice(pg * PER, (pg + 1) * PER);
  let text = `${note ? note + '\n\n' : ''}💲 <b>${esc(title)}</b>` + (p ? ` — public ${formatPriceExact(p.price)}` : '') +
    `\n👥 <b>${people.length}</b> customer${people.length === 1 ? '' : 's'} with a special price\n━━━━━━━━━━━━━━━━━━━━\n`;
  for (const c of slice) text += `\n• ${esc(who(c))} — ${c.tiers.map(tierText).join(' · ')}`;
  const kb = slice.map((c) => [{ text: `🗑 ${(c.username ? '@' + c.username : (c.first_name || c.user_id)).toString().slice(0, 24)}`,
                                 callback_data: `admin_spx_u_${productId}_${c.user_id}` }]);
  const nav = [];
  if (pg > 0) nav.push({ text: '◀️ Prev', callback_data: `admin_spx_p_${productId}_${pg - 1}` });
  if (pg < pages - 1) nav.push({ text: 'Next ▶️', callback_data: `admin_spx_p_${productId}_${pg + 1}` });
  if (nav.length) kb.push(nav);
  kb.push([{ text: `🗑 Remove ALL (${people.length})`, callback_data: `admin_spx_c_${productId}` }]);
  kb.push([{ text: '🔙 Products', callback_data: 'admin_spx' }]);
  return { text, kb };
}

function viewConfirm(productId) {
  const p = db.getAllProductsBrief().find((x) => x.id === productId);
  const n = groupByCustomer(db.listPricesForProduct(productId)).length;
  return {
    text: `⚠️ <b>Remove ALL special prices on ${esc(p ? clean(p.title) : productId)}?</b>\n\n` +
          `<b>${n}</b> customer${n === 1 ? '' : 's'} will pay the public price${p ? ' (' + formatPriceExact(p.price) + ')' : ''} from now on. ` +
          `Their other products are not touched. This cannot be undone.`,
    kb: [[{ text: `✅ Yes, remove all ${n}`, callback_data: `admin_spx_y_${productId}` }],
         [{ text: '❌ No, go back', callback_data: `admin_spx_p_${productId}_0` }]],
  };
}

/** Delete every special price on the product. Returns the number of customers affected. */
function removeAll(productId) {
  const people = groupByCustomer(db.listPricesForProduct(productId));
  for (const c of people) db.removeCustomerPrice(c.user_id, productId, null);
  return people.length;
}

async function handle(bot, query) {
  const data = query.data || '';
  if (!/^admin_spx/.test(data)) return false;
  const chatId = query.message.chat.id, msgId = query.message.message_id;
  const adminId = query.from.id;
  let v, m;
  if (data === 'admin_spx') v = viewProducts();
  else if ((m = /^admin_spx_p_(\d+)_(\d+)$/.exec(data))) v = viewProduct(+m[1], +m[2]);
  else if ((m = /^admin_spx_c_(\d+)$/.exec(data))) v = viewConfirm(+m[1]);
  else if ((m = /^admin_spx_y_(\d+)$/.exec(data))) {
    const n = removeAll(+m[1]);
    logger.info(`Admin ${adminId} removed ALL special prices on product ${m[1]} (${n} customer(s))`);
    v = viewProduct(+m[1], 0, `✅ Removed the special price of <b>${n}</b> customer${n === 1 ? '' : 's'}.`);
  } else if ((m = /^admin_spx_u_(\d+)_(\d+)$/.exec(data))) {
    db.removeCustomerPrice(+m[2], +m[1], null);
    logger.info(`Admin ${adminId} removed the special price of user ${m[2]} on product ${m[1]}`);
    v = viewProduct(+m[1], 0, `✅ Removed for user <code>${m[2]}</code>.`);
  } else return false;
  const opts = { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: v.kb } };
  try { await bot.editMessageText(v.text, opts); }
  catch (e) { await bot.sendMessage(chatId, v.text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: v.kb } }); }
  return true;
}

module.exports = { handle, viewProducts, viewProduct, viewConfirm, removeAll, productsWithPrices, groupByCustomer };
