'use strict';
/**
 * ♻️ Replacement cost (V165) — the purchase price of the spare Gemini links lives HERE, in the main bot.
 * The support bot only adds stock; it refuses until a price was set for that stock (one-shot, mandatory).
 *
 * Callbacks: admin_rc (home) · admin_rc_np (price of the NEXT stock) · admin_rc_same (reuse the last price)
 *            admin_rc_cp (re-price the CURRENT stock) · admin_rc_b (batches) · admin_rc_h (reset history)
 */
const db = require('../database/queries');
const session = require('../handlers/session');
const { States } = session;

const KIND = 'gemini';
const BACK = [{ text: '🔙 Admin', callback_data: 'admin_panel' }];
const HOME = [{ text: '🔙 Replacement cost', callback_data: 'admin_rc' }];
const money = (n) => `${(Math.round((Number(n) || 0) * 100) / 100).toFixed(2).replace(/\.00$/, '')}$`;
const day = (t) => String(t || '').slice(0, 16).replace('T', ' ');

function parsePrice(text) {
  const v = parseFloat(String(text || '').replace(',', '.').replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(v) || v <= 0 || v > 10000) return null;
  return Math.round(v * 100) / 100;
}

function srcLabel(b) { return b.source === 'sale_stock' ? 'from sale stock' : b.source === 'earlier' ? 'earlier stock' : 'added by hand'; }
const batchName = (b) => (b.id ? `Batch #${b.id}` : 'Earlier stock');

function viewHome(note = '') {
  const pr = db.replPriceState(KIND);
  const c = db.replStockCounts().find((x) => x.kind === KIND) || {};
  const cur = db.replCurrentBatch(KIND);
  const bs = db.replBatches(KIND, 1);
  const curRow = bs[0];
  let t = `${note ? note + '\n\n' : ''}♻️ <b>Replacement cost — Gemini links</b>\n━━━━━━━━━━━━━━━━━━━━\n`;
  t += `<b>1️⃣ Price for links added BY HAND</b>\n<i>(links taken from the sale stock use the COST typed at upload — automatic)</i>\n`;
  t += pr.ready ? `✅ <b>${money(pr.price)}</b> per link — the support bot can add stock now (it is used once).\n`
                : `⚠️ <b>Not set</b>${pr.price ? ` (last was ${money(pr.price)})` : ''} — the support bot <b>cannot add stock</b> until you set it.\n`;
  t += `\n<b>2️⃣ Current stock</b>\n`;
  t += curRow ? `📦 ${batchName(curRow)} · ${srcLabel(curRow)} · ${money(curRow.price)}/link\n   ${curRow.qty} links · ${curRow.available || 0} left · ${curRow.used || 0} used\n`
              : `<i>No stock yet.</i>\n`;
  t += `\n<b>3️⃣ Since the last Reset</b>\n`;
  t += `🔗 ${c.used || 0} link${c.used === 1 ? '' : 's'} given to customers = <b>${money(c.used_amount)}</b>\n`;
  for (const g of db.replUsedBreakdown(KIND)) t += `   • ${g.count} × ${money(g.price)}${g.batch ? ` (batch #${g.batch})` : ' (earlier stock)'} = ${money(g.amount)}\n`;
  t += `📥 not yet claimed from the supplier: ${c.unclaimed || 0} (${money(c.unclaimed_amount)})\n`;
  t += `📊 All time: <b>${c.total_used || 0}</b> link${c.total_used === 1 ? '' : 's'} replaced = <b>${money(c.total_amount)}</b>\n`;
  t += `\n<i>Each Reset records the number of links and their price, and starts a new count (support bot → ♻️ Replacements → 🔄 Reset).</i>`;
  const kb = [];
  if (pr.price && !pr.ready) kb.push([{ text: `✅ Same price (${money(pr.price)})`, callback_data: 'admin_rc_same' }]);
  kb.push([{ text: pr.ready ? '✏️ Change the price of the next stock' : '💲 Set the price of the next stock', callback_data: 'admin_rc_np' }]);
  kb.push([{ text: '🏷 Set the price of the current stock', callback_data: 'admin_rc_cp' }]);
  kb.push([{ text: '📦 Batches', callback_data: 'admin_rc_b' }, { text: '🧾 Reset history', callback_data: 'admin_rc_h' }]);
  kb.push(BACK);
  return { text: t, kb };
}

function viewBatches() {
  const bs = db.replBatches(KIND, 10);
  let t = '📦 <b>Batches</b> (newest first)\n━━━━━━━━━━━━━━━━━━━━\n';
  if (!bs.length) t += '<i>No stock yet.</i>';
  for (const b of bs) {
    t += `\n<b>${batchName(b)}</b>${b.id ? ' · ' + srcLabel(b) : ''}${b.created_at ? ' · ' + day(b.created_at) : ''}\n` +
         `   ${b.qty} links × ${money(b.price)} · ${b.available || 0} left · ${b.used || 0} used since reset\n`;
  }
  return { text: t, kb: [HOME] };
}

function viewHistory() {
  const rs = db.replResets(KIND, 8);
  let t = '🧾 <b>Reset history</b>\n━━━━━━━━━━━━━━━━━━━━\n';
  if (!rs.length) t += '<i>No reset yet.</i>';
  for (const r of rs) {
    t += `\n🔄 <b>${day(r.reset_at)}</b> — ${r.used} link${r.used === 1 ? '' : 's'} = <b>${money(r.amount)}</b>\n`;
    const bd = r.breakdown || [];
    if (bd.length) for (const g of bd) t += `   • ${g.count} × ${money(g.price)}${g.batch ? ` (batch #${g.batch})` : ' (earlier stock)'} = ${money(g.amount)}\n`;
    else if (r.used) t += `   • ${r.used} × ${money(r.unit_price)}\n`;
  }
  return { text: t, kb: [HOME] };
}

async function show(bot, chatId, msgId, v) {
  const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: v.kb } };
  try { await bot.editMessageText(v.text, { chat_id: chatId, message_id: msgId, ...opts }); }
  catch (_) { await bot.sendMessage(chatId, v.text, opts); }
}

async function handle(bot, query) {
  const data = query.data || '';
  if (!/^admin_rc(_|$)/.test(data)) return false;
  const chatId = query.message.chat.id, msgId = query.message.message_id, adminId = query.from.id;
  bot.answerCallbackQuery(query.id).catch(() => {});
  if (data === 'admin_rc') { session.clear(adminId); await show(bot, chatId, msgId, viewHome()); return true; }
  if (data === 'admin_rc_b') { await show(bot, chatId, msgId, viewBatches()); return true; }
  if (data === 'admin_rc_h') { await show(bot, chatId, msgId, viewHistory()); return true; }
  if (data === 'admin_rc_same') {
    const p = db.replPriceState(KIND).price;
    if (p > 0) db.replSetUnitPrice(KIND, p);
    await show(bot, chatId, msgId, viewHome(`✅ The next stock will be priced <b>${money(p)}</b> per link.`));
    return true;
  }
  if (data === 'admin_rc_np') {
    session.set(adminId, States.ADMIN_REPL_PRICE, {});
    await show(bot, chatId, msgId, { text: `💲 <b>Price of the next stock</b>\n\nSend what ONE link costs you from the supplier, e.g. <code>2.5</code>\n\n<i>It is stamped on every link of the next stock you add in the support bot.</i>`, kb: [HOME] });
    return true;
  }
  if (data === 'admin_rc_cp') {
    const bs = db.replBatches(KIND, 1)[0];
    session.set(adminId, States.ADMIN_REPL_CURPRICE, {});
    await show(bot, chatId, msgId, { text: `🏷 <b>Price of the current stock</b>\n\n${bs ? `${batchName(bs)} — ${bs.qty} links, now ${money(bs.price)} each.` : 'Earlier stock.'}\n\nSend the correct price per link, e.g. <code>2.5</code>.\n<i>Every link of this stock (used or not, since the last Reset) is re-priced.</i>`, kb: [HOME] });
    return true;
  }
  return false;
}

/** Text typed after tapping a price button. Returns true when it handled the message. */
async function handleText(bot, msg, state, text) {
  const chatId = msg.chat.id, adminId = msg.from.id;
  const p = parsePrice(text);
  if (!p) { await bot.sendMessage(chatId, '❌ Send a number greater than 0, e.g. <code>2.5</code>', { parse_mode: 'HTML' }); return true; }
  session.clear(adminId);
  let note;
  if (state === States.ADMIN_REPL_PRICE) {
    db.replSetUnitPrice(KIND, p);
    note = `✅ The next stock will be priced <b>${money(p)}</b> per link. Now add it in the support bot.`;
  } else {
    const r = db.replPriceCurrentStock(KIND, p);
    note = r.ok ? `✅ The current stock is now <b>${money(p)}</b> per link (${r.links} link${r.links === 1 ? '' : 's'} updated).` : '❌ Could not update.';
  }
  const v = viewHome(note);
  await bot.sendMessage(chatId, v.text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: v.kb } });
  return true;
}

module.exports = { handle, handleText, viewHome, viewBatches, viewHistory, parsePrice };
