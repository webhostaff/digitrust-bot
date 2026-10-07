'use strict';
/**
 * 📄 Binance Report — admin screen (V149): one tap builds the transaction report an exchange asks for and
 * sends it as an Excel file (all sheets) plus a CSV of the main table. Every callback starts with
 * `admin_binrep`; handleAdminCallback hands them over after its admin check.
 */

const transactionReport = require('../services/transactionReport');
const { formatPrice } = require('../utils/format');
const logger = require('../utils/logger');

const kb = (rows) => ({ inline_keyboard: rows });
const btn = (text, data) => ({ text, callback_data: data });
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

function homeView() {
  const all = transactionReport.buildReport({});
  const total = all.summary.find((r) => r[0] === 'Total amount of those records (USDT)');
  const text =
    `📄 <b>Binance Report</b>\n━━━━━━━━━━━━━━━━━━\n` +
    `The proof of payment an exchange asks for, built from this store's own records.\n\n` +
    `💳 Payments found: <b>${all.counts.payments}</b>${total ? ` · <b>${formatPrice(total[1])}</b>` : ''}\n` +
    `🛒 Orders: <b>${all.counts.orders}</b>\n` +
    (all.counts.flagged ? `⚠️ Payments to look at: <b>${all.counts.flagged}</b> (marked CHECK / PENDING in the file)\n` : '') +
    `\nEvery payment is linked: <b>TXID → user → order → product → payment → delivery</b>, oldest first.\n` +
    `You get an <b>Excel file</b> (Summary · Transactions · Orders · Per user · Credits without TXID · Notes) and a <b>CSV</b> of the transactions.\n\n` +
    `<i>It contains customers' Telegram IDs and usernames: use “anonymised” if the exchange does not need to know who they are. Customer emails are never included.</i>`;
  return {
    text,
    markup: kb([
      [btn('📄 All time', 'admin_binrep_all')],
      [btn('📅 Last 30 days', 'admin_binrep_30'), btn('📅 Last 90 days', 'admin_binrep_90')],
      [btn('🔒 All time — users anonymised', 'admin_binrep_anon')],
      [btn('🔙 Admin Panel', 'admin_panel')],
    ]),
  };
}

const OPTIONS = {
  admin_binrep_all:  { label: 'all time', opts: {} },
  admin_binrep_30:   { label: 'last 30 days', opts: () => ({ fromDate: daysAgo(30) }) },
  admin_binrep_90:   { label: 'last 90 days', opts: () => ({ fromDate: daysAgo(90) }) },
  admin_binrep_anon: { label: 'all time, users anonymised', opts: { anonymize: true }, suffix: '_anonymised' },
};

async function handle(bot, query) {
  const data = query.data || '';
  if (!/^admin_binrep/.test(data)) return false;
  const chatId = query.message.chat.id, msgId = query.message.message_id;

  if (data === 'admin_binrep') {
    const v = homeView();
    await bot.editMessageText(v.text, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: v.markup }).catch(() => {});
    return true;
  }
  const opt = OPTIONS[data];
  if (!opt) return false;

  const wait = await bot.sendMessage(chatId, `⏳ Building the report (${opt.label})…`).catch(() => null);
  try {
    const opts = typeof opt.opts === 'function' ? opt.opts() : opt.opts;
    const { xlsx, csv, report } = transactionReport.buildFiles(opts);
    const stamp = new Date().toISOString().slice(0, 10);
    const base = `binance-transaction-report_${stamp}${opt.suffix || ''}`;
    await bot.sendDocument(chatId, xlsx,
      { caption: `📄 <b>Transaction report</b> — ${opt.label}\n💳 ${report.counts.payments} payments · 🛒 ${report.counts.orders} orders` +
                 (report.counts.flagged ? `\n⚠️ ${report.counts.flagged} to look at (see the Flag column)` : '') +
                 `\nTimes are UTC. Read the “Notes” sheet for what the database does not record.`, parse_mode: 'HTML' },
      { filename: `${base}.xlsx`, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    await bot.sendDocument(chatId, csv, { caption: '📎 The same transactions as CSV (opens anywhere).' },
      { filename: `${base}.csv`, contentType: 'text/csv' });
    logger.info(`Admin ${query.from.id} exported the Binance report (${opt.label}): ${report.counts.payments} payments, ${report.counts.orders} orders`);
  } catch (e) {
    logger.error(`Binance report failed: ${e.stack || e.message}`);
    await bot.sendMessage(chatId, `❌ The report could not be built: ${String(e.message).slice(0, 200)}`).catch(() => {});
  } finally {
    if (wait && wait.message_id) bot.deleteMessage(chatId, wait.message_id).catch(() => {});
  }
  return true;
}

module.exports = { handle, homeView };
