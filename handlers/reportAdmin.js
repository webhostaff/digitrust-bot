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
  const lean = transactionReport.buildBinanceReport({});
  const text =
    `📄 <b>Binance Report</b>\n━━━━━━━━━━━━━━━━━━\n` +
    `Only the payments Binance verified for this shop — one row each:\n` +
    `<b>TXID · user · product · time · price</b>\n\n` +
    `💳 Binance payments found: <b>${lean.counts.payments}</b> · <b>${formatPrice(lean.counts.total)}</b>\n` +
    (lean.counts.skipped ? `ℹ️ ${lean.counts.skipped} deposit(s) were seen on Binance but never credited: not in the file.\n` : '') +
    `\nYou get an <b>Excel file</b> and the same table as <b>CSV</b>, oldest first, times in UTC. A wallet top-up shows “Wallet top-up” as its product.\n\n` +
    `<i>It has customers' Telegram IDs and usernames: pick “anonymised” if Binance does not need them. Emails are never included.</i>`;
  return {
    text,
    markup: kb([
      [btn('📄 All time', 'admin_binrep_all')],
      [btn('📅 Last 30 days', 'admin_binrep_30'), btn('📅 Last 90 days', 'admin_binrep_90')],
      [btn('🔒 All time — users anonymised', 'admin_binrep_anon')],
      [btn('📚 Full detailed report (orders, other gateways…)', 'admin_binrep_full')],
      [btn('🔙 Admin Panel', 'admin_panel')],
    ]),
  };
}

const OPTIONS = {
  admin_binrep_all:  { label: 'all time', opts: {} },
  admin_binrep_30:   { label: 'last 30 days', opts: () => ({ fromDate: daysAgo(30) }) },
  admin_binrep_90:   { label: 'last 90 days', opts: () => ({ fromDate: daysAgo(90) }) },
  admin_binrep_anon: { label: 'all time, users anonymised', opts: { anonymize: true }, suffix: '_anonymised' },
  admin_binrep_full: { label: 'full detailed report, all time', opts: {}, full: true },
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
    const stamp = new Date().toISOString().slice(0, 10);
    const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    if (opt.full) {
      const { xlsx, csv, report } = transactionReport.buildFiles(opts);
      const base = `binance-transaction-report-full_${stamp}`;
      await bot.sendDocument(chatId, xlsx,
        { caption: `📚 <b>Full detailed report</b> — ${opt.label}\n💳 ${report.counts.payments} payments · 🛒 ${report.counts.orders} orders` +
                   (report.counts.flagged ? `\n⚠️ ${report.counts.flagged} to look at (see the Flag column)` : '') +
                   `\nTimes are UTC. Read the “Notes” sheet for what the database does not record.`, parse_mode: 'HTML' },
        { filename: `${base}.xlsx`, contentType: XLSX_TYPE });
      await bot.sendDocument(chatId, csv, { caption: '📎 The same transactions as CSV (opens anywhere).' }, { filename: `${base}.csv`, contentType: 'text/csv' });
      logger.info(`Admin ${query.from.id} exported the FULL Binance report: ${report.counts.payments} payments, ${report.counts.orders} orders`);
    } else {
      const { xlsx, csv, report } = transactionReport.buildBinanceFiles(opts);
      const base = `binance-transactions_${stamp}${opt.suffix || ''}`;
      await bot.sendDocument(chatId, xlsx,
        { caption: `📄 <b>Binance transactions</b> — ${opt.label}\n💳 ${report.counts.payments} payments · <b>${formatPrice(report.counts.total)}</b>\n` +
                   `TXID · user · product · time · price. Times are UTC.` +
                   (report.counts.skipped ? `\nℹ️ ${report.counts.skipped} deposit(s) seen on Binance but never credited are not included.` : ''), parse_mode: 'HTML' },
        { filename: `${base}.xlsx`, contentType: XLSX_TYPE });
      await bot.sendDocument(chatId, csv, { caption: '📎 The same table as CSV (opens anywhere).' }, { filename: `${base}.csv`, contentType: 'text/csv' });
      logger.info(`Admin ${query.from.id} exported the Binance transactions (${opt.label}): ${report.counts.payments} payments`);
    }
  } catch (e) {
    logger.error(`Binance report failed: ${e.stack || e.message}`);
    await bot.sendMessage(chatId, `❌ The report could not be built: ${String(e.message).slice(0, 200)}`).catch(() => {});
  } finally {
    if (wait && wait.message_id) bot.deleteMessage(chatId, wait.message_id).catch(() => {});
  }
  return true;
}

module.exports = { handle, homeView };
