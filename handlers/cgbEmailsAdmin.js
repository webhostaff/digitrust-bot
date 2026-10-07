'use strict';
/**
 * 📧 Emails from the store bot (V149): the customers who bought a ChatGPT seat and are waiting to be invited,
 * a way to hand them (again) to the invite bot that is working, and an export of every seat's email.
 * Every callback starts with `admin_cgb_emails`.
 */

const raw = require('../database/db');
const cgbBots = require('../services/cgbBots');
const cgbGuard = require('../services/cgbGuard');
const { escapeHtml } = require('../utils/format');
const logger = require('../utils/logger');

const kb = (rows) => ({ inline_keyboard: rows });
const btn = (text, data) => ({ text, callback_data: data });
const ymd = (s) => String(s || '').slice(0, 10);

/** Paid seats not activated yet. A RENEWAL is excluded from "needs an invite": that person is already in the workspace. */
function waiting() {
  const rows = raw.prepare(`
    SELECT cs.*, u.username FROM chatgpt_subscriptions cs LEFT JOIN users u ON u.telegram_id = cs.user_id
    WHERE cs.status = 'pending' ORDER BY cs.created_at, cs.id`).all();
  return { all: rows, newSeats: rows.filter((r) => !r.renewed_from), renewals: rows.filter((r) => r.renewed_from) };
}
const counts = () => ({
  active: raw.prepare("SELECT COUNT(*) AS n FROM chatgpt_subscriptions WHERE status = 'active'").get().n,
});

async function homeView() {
  const w = waiting();
  const active = cgbBots.activeBot();
  const bots = cgbBots.list();
  const target = active || bots.find((b) => b.isDefault) || null;
  const st = target ? await cgbBots.status(target) : null;
  const stateWord = { running: '🟢 working', stopped: '⚪ off', paused: '🟠 paused', no_session: '🟡 no session yet', unreachable: '🔴 cannot be reached', unauthorized: '🔴 secret mismatch', old_build: '🟠 old build', unknown: '🔴 unknown' };
  const list = w.newSeats.slice(0, 15).map((r) => `• #${r.order_id} · <code>${escapeHtml(r.email || '')}</code> · to ${escapeHtml(ymd(r.end_date))}`).join('\n');
  const text =
    `📧 <b>Emails from the store bot</b>\n━━━━━━━━━━━━━━━━━━\n` +
    `⏳ Paid, waiting to be invited: <b>${w.newSeats.length}</b>` + (w.renewals.length ? ` <i>(+ ${w.renewals.length} renewal(s): already in the workspace)</i>` : '') + `\n` +
    `✅ Active seats: <b>${counts().active}</b>\n` +
    `🤖 Invite bot that receives them: <b>${target ? escapeHtml(target.name) : '— none configured —'}</b>${st ? ` · ${stateWord[st.state] || st.state}${st.queued ? ` · ⏳ ${st.queued} already in its queue` : ''}` : ''}\n` +
    (list ? `\n${list}${w.newSeats.length > 15 ? `\n… and ${w.newSeats.length - 15} more` : ''}\n` : `\n<i>Nobody is waiting.</i>\n`) +
    `\n<i>“Send” hands the waiting emails to the invite bot. Anyone it already invited or queued is skipped, so sending twice is safe.</i>`;
  const rows = [];
  if (w.newSeats.length) {
    rows.push([btn(`📤 Send ${w.newSeats.length} to the invite bot`, 'admin_cgb_emails_send')]);
    rows.push([btn('📋 Show them to copy', 'admin_cgb_emails_copy')]);
  }
  rows.push([btn('📄 Export all seats (CSV)', 'admin_cgb_emails_csv')]);
  rows.push([btn('🤖 Invite bots', 'admin_cgb_bots'), btn('🔙 Back', 'admin_cgb_panel')]);
  return { text, markup: kb(rows) };
}

function csvOf(rows) {
  const q = (v) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const head = ['email', 'order_id', 'user_id', 'username', 'status', 'renewal', 'start_date', 'end_date', 'days', 'price_paid_usdt', 'ordered_at_utc'];
  return '\uFEFF' + [head.join(','), ...rows.map((r) => [r.email, r.order_id, r.user_id, r.username ? '@' + r.username : '', r.status, r.renewed_from ? 'yes' : 'no',
    r.start_date, r.end_date, r.days_remaining, r.final_price, r.created_at].map(q).join(','))].join('\r\n') + '\r\n';
}

async function handle(bot, query) {
  const data = query.data || '';
  if (!/^admin_cgb_emails/.test(data)) return false;
  const chatId = query.message.chat.id, msgId = query.message.message_id;
  const edit = (v) => bot.editMessageText(v.text, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: v.markup }).catch(() => {});

  if (data === 'admin_cgb_emails') { await edit(await homeView()); return true; }

  if (data === 'admin_cgb_emails_copy') {
    const w = waiting().newSeats;
    const lines = w.map((r) => r.email).filter(Boolean);
    let chunk = '';
    const out = [];
    for (const l of lines) { if ((chunk + l + '\n').length > 3500) { out.push(chunk); chunk = ''; } chunk += l + '\n'; }
    if (chunk) out.push(chunk);
    if (!out.length) { await bot.sendMessage(chatId, 'Nobody is waiting.'); return true; }
    for (const c of out) await bot.sendMessage(chatId, `<code>${escapeHtml(c.trim())}</code>`, { parse_mode: 'HTML' });
    return true;
  }

  if (data === 'admin_cgb_emails_csv') {
    const rows = raw.prepare(`SELECT cs.*, u.username FROM chatgpt_subscriptions cs LEFT JOIN users u ON u.telegram_id = cs.user_id
                              WHERE cs.status IN ('pending','active') ORDER BY cs.created_at, cs.id`).all();
    await bot.sendDocument(chatId, Buffer.from(csvOf(rows), 'utf8'),
      { caption: `📄 ${rows.length} seat(s): waiting and active. Renewals are marked.` },
      { filename: `chatgpt-seat-emails_${new Date().toISOString().slice(0, 10)}.csv`, contentType: 'text/csv' }).catch(() => {});
    return true;
  }

  if (data === 'admin_cgb_emails_send') {
    const w = waiting().newSeats;
    if (!w.length) { await edit(await homeView()); return true; }
    const active = cgbBots.activeBot();
    const target = active || cgbBots.list().find((b) => b.isDefault);
    await edit({
      text: `📤 <b>Send ${w.length} email(s) to the invite bot?</b>\n\nThey go to <b>${target ? escapeHtml(target.name) : 'the invite bot'}</b>` +
            `${active ? '' : ' (the main bot — you have not chosen another)'}.\nAnyone it already invited or queued is skipped.`,
      markup: kb([[btn('✅ Send', 'admin_cgb_emails_go')], [btn('❌ Cancel', 'admin_cgb_emails')]]),
    });
    return true;
  }

  if (data === 'admin_cgb_emails_go') {
    const w = waiting().newSeats;
    const results = { ok: 0, fail: [], skipped: 0, byBot: {} };
    const wait = await bot.sendMessage(chatId, `⏳ Sending ${w.length} email(s)…`).catch(() => null);
    for (const r of w) {
      const res = await cgbGuard.notifyGuardOfNewInvite(r.email, { orderId: r.order_id, endDate: r.end_date }).catch((e) => ({ ok: false, reason: e.message }));
      if (res === null) { results.skipped++; continue; }
      if (res.ok) { results.ok++; results.byBot[res.bot || 'main'] = (results.byBot[res.bot || 'main'] || 0) + 1; }
      else results.fail.push({ email: r.email, order: r.order_id, reason: res.reason || 'unknown' });
      await new Promise((resolve) => setTimeout(resolve, 120));        // gently: the invite bot answers each one
    }
    if (wait && wait.message_id) bot.deleteMessage(chatId, wait.message_id).catch(() => {});
    logger.info(`Admin ${query.from.id} re-sent ${w.length} waiting email(s) to the invite bot: ${results.ok} ok, ${results.fail.length} failed`);
    const reasons = [...new Set(results.fail.map((f) => f.reason))];
    await bot.sendMessage(chatId,
      `📤 <b>Done</b>\n✅ Handed over: <b>${results.ok}</b>` +
      (Object.keys(results.byBot).length ? ` (${Object.entries(results.byBot).map(([b, n]) => `${escapeHtml(((cgbBots.get(b) || {}).name) || b)}: ${n}`).join(', ')})` : '') + `\n` +
      (results.skipped ? `⚠️ ${results.skipped} not sent: the invite bot is not configured (GUARD_AUTO_INVITE_URL / GUARD_SECRET).\n` : '') +
      (results.fail.length ? `❌ Failed: <b>${results.fail.length}</b> — ${reasons.map((x) => escapeHtml(x)).join('; ')}\n` +
        results.fail.slice(0, 10).map((f) => `• #${f.order} <code>${escapeHtml(f.email)}</code>`).join('\n') + (results.fail.length > 10 ? `\n… and ${results.fail.length - 10} more` : '') + '\n' : '') +
      `\n<i>They now wait in the invite bot's queue (⏳ Queue there). If ChatGPT blocks the bot, use 🖐 “I invited them myself” after inviting them by hand.</i>`,
      { parse_mode: 'HTML', reply_markup: kb([[btn('📧 Emails', 'admin_cgb_emails')]]) });
    return true;
  }
  return false;
}

module.exports = { handle, homeView, waiting, csvOf };
