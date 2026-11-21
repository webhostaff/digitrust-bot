'use strict';
/**
 * 🎁 Referrals — admin screens (V143): switch the programme on/off, see who earns, block one person.
 * Every callback starts with `admin_ref`; handleAdminCallback hands them over after its admin check.
 */

const db = require('../database/queries');
const tracker = require('../services/referralTracker');
const { escapeHtml, formatPrice } = require('../utils/format');
const logger = require('../utils/logger');

const PER_PAGE = 10;
const kb = (rows) => ({ inline_keyboard: rows });
const b = (text, data) => ({ text, callback_data: data });

const cashbackLine = () => {
  const on = db.getSetting('referral_cashback_enabled', '1') === '1';
  return `${on ? '✅' : '⏸'} Lifetime cashback: <b>${db.getSetting('referral_cashback_pct', '2')}%</b> of every purchase (orders from $${db.getSetting('referral_min_order', '5')})`;
};

function homeView(note = '') {
  const on = db.referralProgramOn();
  const o = tracker.overview();
  const text =
    (note ? `${note}\n\n` : '') +
    `🎁 <b>Referrals</b>\n━━━━━━━━━━━━━━━━━━\n` +
    `Programme: ${on ? '🟢 <b>ON</b> — referrers earn' : '🔴 <b>OFF</b> — nobody earns anything new'}\n` +
    `${cashbackLine()}\n` +
    `🎁 First-purchase reward: <b>$${db.getSetting('referral_reward', '0.20')}</b> · 👑 VIP after 3 referrals\n\n` +
    `👥 Referrers: <b>${o.referrers}</b> · referred accounts: <b>${o.referred}</b> (bought: <b>${o.buyers}</b>)\n` +
    `💸 Paid to referrers: <b>${formatPrice(o.paidTotal)}</b> in ${o.paidCount} payouts\n` +
    `   last 7 days: <b>${formatPrice(o.paid7d)}</b> · last 30 days: <b>${formatPrice(o.paid30d)}</b>\n` +
    `🚫 Blocked referrers: <b>${o.blocked}</b>\n\n` +
    `<i>Switching OFF stops new earnings only: balances already in wallets, and VIP already unlocked, stay as they are. ` +
    `New referral links are still recorded, so you can keep tracking.</i>`;
  return {
    text,
    markup: kb([
      [on ? b('🔴 Turn the programme OFF', 'admin_ref_prog_0') : b('🟢 Turn the programme ON', 'admin_ref_prog_1')],
      [b('🏆 Who earns most', 'admin_ref_top_0'), b('📄 Export CSV', 'admin_ref_csv')],
      [b('⚙️ Cashback settings', 'admin_settings')],
      [b('🔙 Admin Panel', 'admin_panel')],
    ]),
  };
}

function topView(page = 0) {
  const t = tracker.topReferrers({ page, perPage: PER_PAGE });
  if (!t.total) {
    return { text: '🏆 <b>Who earns most</b>\n\n<i>No referrals yet.</i>', markup: kb([[b('🔙 Referrals', 'admin_referrals')]]) };
  }
  let text = `🏆 <b>Who earns most</b>  ·  page ${t.page + 1}/${t.pages}\n━━━━━━━━━━━━━━━━━━\n` +
             `🚩 = a warning sign to check · 🚫 = blocked\nTap a person to see everything.`;
  const rows = t.rows.map((r) => [b(
    `${r.flags.length ? '🚩 ' : ''}${r.blocked ? '🚫 ' : ''}${r.name} · $${r.earned.toFixed(2)} · ${r.referred} refs (${r.buyers} bought)`.slice(0, 60),
    `admin_ref_u_${r.id}`)]);
  if (t.pages > 1) {
    rows.push([b('◀', `admin_ref_top_${Math.max(0, t.page - 1)}`), b(`${t.page + 1}/${t.pages}`, `admin_ref_top_${t.page}`),
               b('▶', `admin_ref_top_${Math.min(t.pages - 1, t.page + 1)}`)]);
  }
  rows.push([b('🔙 Referrals', 'admin_referrals')]);
  return { text, markup: kb(rows), page: t.page };
}

function detailView(id, note = '') {
  const d = tracker.referrerDetail(id);
  if (!d) return { text: '❌ User not found.', markup: kb([[b('🔙 Who earns most', 'admin_ref_top_0')]]) };
  let text = (note ? `${note}\n\n` : '') +
    `👤 <b>${escapeHtml(d.name)}</b>  <code>${d.id}</code>${d.blocked ? '  🚫 <b>BLOCKED</b>' : ''}\n━━━━━━━━━━━━━━━━━━\n` +
    `💰 Earned from referrals: <b>${formatPrice(d.earned)}</b> (${d.payouts} payouts · ${d.share}% of everything paid)\n` +
    `👛 Wallet balance now: <b>${formatPrice(d.balance)}</b>\n` +
    `👥 Referred: <b>${d.referred.length}</b> · bought: <b>${d.buyers}</b> · they spent: <b>${formatPrice(d.referredSpend)}</b>\n`;
  if (d.flags.length) {
    text += `\n⚠️ <b>Warning signs</b> <i>(signs to look at, not proof)</i>\n` + d.flags.map((f) => `${f.icon} ${escapeHtml(f.text)}`).join('\n') + '\n';
  } else {
    text += `\n✅ No warning signs found.\n`;
  }
  const list = d.referred.filter((r) => r.orders > 0).sort((x, y) => y.commission - x.commission).slice(0, 8);
  if (list.length) {
    text += `\n<b>Referred accounts that bought</b> (top ${list.length})\n` +
      list.map((r) => `• ${escapeHtml(r.name)} — ${r.orders} order${r.orders > 1 ? 's' : ''} · $${r.spent.toFixed(2)} → gave <b>$${r.commission.toFixed(2)}</b>`).join('\n') + '\n';
  }
  if (d.ledger.length) {
    text += `\n<b>Latest payouts</b>\n` + d.ledger.slice(0, 6).map((l) => `• ${escapeHtml(String(l.created_at).slice(0, 16))} · $${Number(l.amount).toFixed(2)}${l.order_id ? ` · order #${l.order_id}` : ''}`).join('\n') + '\n';
  }
  text += `\n<i>Blocking stops his FUTURE referral earnings (cashback, reward, VIP unlock). His wallet and past payouts are not touched.</i>`;
  return {
    text,
    markup: kb([
      [d.blocked ? b('✅ Allow him to earn again', `admin_ref_unblock_${d.id}`) : b('🚫 Block his referral earnings', `admin_ref_block_${d.id}`)],
      [b('➖ Remove User Balance', 'admin_remove_balance'), b('🔙 Who earns most', 'admin_ref_top_0')],
    ]),
  };
}

/** @returns {Promise<boolean>} true when the callback was one of ours */
async function handle(bot, query) {
  const data = query.data || '';
  if (!/^admin_ref(errals|_)/.test(data)) return false;
  const chatId = query.message.chat.id, msgId = query.message.message_id;
  const edit = (v) => bot.editMessageText(v.text, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: v.markup }).catch(() => {});
  let m;
  if (data === 'admin_referrals') { await edit(homeView()); return true; }
  if ((m = /^admin_ref_prog_([01])$/.exec(data))) {
    const on = m[1] === '1';
    db.setSetting('referral_program_enabled', on ? '1' : '0');
    logger.info(`Admin ${query.from.id} set referral_program_enabled=${on ? 1 : 0}`);
    await edit(homeView(on ? '🟢 Referral programme turned ON.' : '🔴 Referral programme turned OFF — no new referral earnings.'));
    return true;
  }
  if ((m = /^admin_ref_top_(\d+)$/.exec(data))) { await edit(topView(parseInt(m[1], 10))); return true; }
  if ((m = /^admin_ref_u_(\d+)$/.exec(data))) { await edit(detailView(parseInt(m[1], 10))); return true; }
  if ((m = /^admin_ref_(block|unblock)_(\d+)$/.exec(data))) {
    const id = parseInt(m[2], 10), block = m[1] === 'block';
    const ok = db.setReferralBlocked(id, block);
    logger.info(`Admin ${query.from.id} ${block ? 'blocked' : 'unblocked'} referral earnings of ${id}`);
    await edit(detailView(id, !ok ? '❌ User not found.' : block ? '🚫 Blocked: he earns nothing more from referrals.' : '✅ He can earn from referrals again.'));
    return true;
  }
  if (data === 'admin_ref_csv') {
    const text = tracker.csv();
    await bot.sendDocument(chatId, Buffer.from(text, 'utf8'), { caption: '📄 Every referral payout (UTC).' },
                           { filename: `referral-payouts-${new Date().toISOString().slice(0, 10)}.csv`, contentType: 'text/csv' }).catch(() => {});
    return true;
  }
  return false;
}

module.exports = { handle, homeView, topView, detailView };
