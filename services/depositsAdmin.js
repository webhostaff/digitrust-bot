'use strict';
/**
 * 📥 Binance deposits — the /deposits command as ready buttons (V156).
 * The command and the buttons share render(), so they always say the same thing.
 */
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** "/deposits 30 TON 1.18" style arguments → { days, network, amount } */
function parseArgs(raw) {
  const args = String(raw || '').trim().split(/\s+/).filter(Boolean);
  let days = 7, network = null, amount = null, daysSet = false;
  for (const a of args) {
    if (/^\d+$/.test(a) && Number(a) <= 90 && !daysSet) { days = Number(a); daysSet = true; continue; }
    if (/^[A-Za-z]{2,10}$/.test(a)) { network = a.toUpperCase(); continue; }
    if (/^\d+(\.\d+)?$/.test(a)) { amount = Number(a); continue; }
  }
  return { days, network, amount };
}

/** The query result as one HTML message. */
async function render({ days = 7, network = null, amount = null } = {}) {
  const r = await require('./binance').listRecentDeposits({ days, limit: 15, network, amount });
  if (!r.ok) {
    return `❌ <b>Binance call failed</b>\n\n<code>${esc(r.error)}</code>\n\n` +
      `<i>Usually the API key lacks <b>Enable Reading</b>, or this server's IP is not on the key's allow-list.</i>`;
  }
  const head = `📥 <b>Binance deposits</b> — last ${days} day(s)` +
    `${network ? ` · <b>${esc(network)}</b>` : ''}${amount !== null ? ` · amount <b>${amount}</b>` : ''}\n` +
    `Total in window: <b>${r.total}</b>\nNetworks seen: ${r.networks.map((n) => `<code>${esc(n)}</code>`).join(' ') || '—'}\n`;
  if (!r.matched) {
    return head + `\n❌ <b>Nothing matched</b>.\n\n` +
      (network && !r.networks.includes(network)
        ? `⚠️ <b>Binance has received no ${esc(network)} deposits at all</b> in this window — not one, out of ${r.total}.\n\n` +
          `<i>The transfer never reached Binance, rather than the bot failing to match it. Check the address the customer used ` +
          `against your Binance ${esc(network)} deposit address.</i>`
        : `<i>Try a wider window (30 or 90 days).</i>`);
  }
  const lines = r.rows.map((d) => {
    const when = new Date(Number(d.insertTime)).toISOString().slice(0, 16).replace('T', ' ');
    const state = Number(d.status) === 1 ? '✅' : Number(d.status) === 0 ? '⏳' : `(${d.status})`;
    return `${state} <b>${esc(String(d.amount))}</b> ${esc(d.coin || '')} · ${esc(d.network || '?')} · ${when}\n   <code>${esc(String(d.txId || ''))}</code>`;
  });
  return head + `Matching: <b>${r.matched}</b>${r.matched > r.rows.length ? ` (showing ${r.rows.length})` : ''}\n\n` + lines.join('\n\n');
}

const MENU_TEXT = '📥 <b>Binance deposits</b>\n\nWhat Binance itself received — the answer when a customer says "I paid".\nChoose a network and a window:';
function menuKb() {
  const b = (text, d) => ({ text, callback_data: `admin_deps_q_${d}` });
  return { inline_keyboard: [
    [b('💎 TON · 7 days', '7_TON'), b('💎 TON · 30 days', '30_TON')],
    [b('🟡 BEP20 · 7 days', '7_BSC'), b('🔴 TRC20 · 7 days', '7_TRX')],
    [b('📋 All networks · 7 days', '7_ALL'), b('📋 All · 30 days', '30_ALL')],
    [{ text: '🔎 Find an exact amount', callback_data: 'admin_deps_amt' }],
    [{ text: '🔙 Admin', callback_data: 'admin_panel' }],
  ] };
}

/** Callbacks admin_deps* → true when handled. */
async function handle(bot, query) {
  const data = query.data || '';
  if (!/^admin_deps/.test(data)) return false;
  const chatId = query.message.chat.id;
  const msgId = query.message.message_id;
  bot.answerCallbackQuery(query.id).catch(() => {});
  if (data === 'admin_deps') {
    await bot.editMessageText(MENU_TEXT, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: menuKb() })
      .catch(() => bot.sendMessage(chatId, MENU_TEXT, { parse_mode: 'HTML', reply_markup: menuKb() }));
    return true;
  }
  if (data === 'admin_deps_amt') {
    const session = require('../handlers/session');
    session.set(query.from.id, 'ADMIN_DEP_AMOUNT', {});
    await bot.sendMessage(chatId, '🔎 Send the exact amount (and optionally a network and days), e.g. <code>10.003</code> or <code>10.003 TON 30</code>.\n/cancel to stop.', { parse_mode: 'HTML' });
    return true;
  }
  const m = /^admin_deps_q_(\d+)_([A-Z]+)$/.exec(data);
  if (m) {
    const days = Number(m[1]);
    const network = m[2] === 'ALL' ? null : m[2];
    await bot.sendMessage(chatId, `⏳ Asking Binance for ${days} day(s)${network ? ` · ${network}` : ''}…`);
    const text = await render({ days, network });
    await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '📥 Other search', callback_data: 'admin_deps_menu' }]] } });
    return true;
  }
  if (data === 'admin_deps_menu') {
    await bot.sendMessage(chatId, MENU_TEXT, { parse_mode: 'HTML', reply_markup: menuKb() });
    return true;
  }
  return false;
}

module.exports = { parseArgs, render, handle, menuKb, MENU_TEXT };
