'use strict';
/**
 * Referral tracker (V143).
 *
 * Answers: who earns from referrals, how much, from whom — and does it look right?
 * Read-only on purpose (no Telegram, no writes): the admin screens call it, tests call it.
 *
 * Money comes from the `transactions` ledger (type 'referral_cashback' = the lifetime %,
 * 'referral' = the one-time first-purchase reward); who brought whom is in `referrals`.
 */

const raw = require('../database/db');

const EARN_TYPES = ['referral_cashback', 'referral'];
const EARN_IN = EARN_TYPES.map((t) => `'${t}'`).join(',');

// Warning-sign thresholds (they are signs to LOOK, never proof).
const BURST_COUNT = 5;          // this many referred accounts created within...
const BURST_MINUTES = 60;       // ...this many minutes
const QUICK_MINUTES = 10;       // a referred account that buys within this long of joining
const QUICK_SHARE = 0.7;        // ...and this share of buyers do it
const MIN_BUYERS = 3;           // flags about buyers need at least this many

const money = (n) => Number(Number(n || 0).toFixed(2));
const ts = (s) => (s ? Date.parse(String(s).replace(' ', 'T') + 'Z') : NaN);

function label(u, id) {
  if (u && u.username) return '@' + u.username;
  if (u && u.first_name) return u.first_name;
  return String(id);
}

function overview() {
  const one = (sql, ...a) => raw.prepare(sql).get(...a);
  const earned = one(`SELECT COALESCE(SUM(amount),0) AS sum, COUNT(*) AS n FROM transactions WHERE type IN (${EARN_IN})`);
  const e7 = one(`SELECT COALESCE(SUM(amount),0) AS sum FROM transactions WHERE type IN (${EARN_IN}) AND created_at >= datetime('now','-7 days')`);
  const e30 = one(`SELECT COALESCE(SUM(amount),0) AS sum FROM transactions WHERE type IN (${EARN_IN}) AND created_at >= datetime('now','-30 days')`);
  return {
    referrers: one('SELECT COUNT(DISTINCT referrer_id) AS n FROM referrals').n,
    referred: one('SELECT COUNT(*) AS n FROM referrals').n,
    buyers: one(`SELECT COUNT(DISTINCT r.referred_id) AS n FROM referrals r
                 JOIN orders o ON o.user_id = r.referred_id AND o.status = 'delivered'`).n,
    paidTotal: money(earned.sum), paidCount: earned.n, paid7d: money(e7.sum), paid30d: money(e30.sum),
    blocked: one('SELECT COUNT(*) AS n FROM users WHERE referral_blocked = 1').n,
  };
}

/** Every referred account of one referrer, with what they bought and what that earned the referrer. */
function referredOf(referrerId) {
  const rows = raw.prepare(`
    SELECT r.referred_id AS id, r.created_at AS joined, u.username, u.first_name
    FROM referrals r LEFT JOIN users u ON u.telegram_id = r.referred_id
    WHERE r.referrer_id = ? ORDER BY r.created_at DESC`).all(referrerId);
  const stat = raw.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(total_price),0) AS spent, MIN(created_at) AS first,
                            COUNT(DISTINCT total_price) AS distinct_totals
                            FROM orders WHERE user_id = ? AND status = 'delivered'`);
  const commission = commissionByReferred(referrerId);
  return rows.map((r) => {
    const s = stat.get(r.id);
    return { id: r.id, name: label(r, r.id), joined: r.joined, orders: s.n, spent: money(s.spent),
             firstOrder: s.first, distinctTotals: s.distinct_totals, commission: money(commission.get(r.id) || 0) };
  });
}

/** referred user id -> total commission this referrer got from them (parsed from the ledger text). */
function commissionByReferred(referrerId) {
  const map = new Map();
  const tx = raw.prepare(`SELECT amount, description FROM transactions WHERE user_id = ? AND type IN (${EARN_IN})`).all(referrerId);
  for (const t of tx) {
    const m = /user (\d+)/.exec(t.description || '');
    if (m) map.set(Number(m[1]), (map.get(Number(m[1])) || 0) + t.amount);
  }
  return map;
}

/** Warning signs for one referrer, from the referred list. Each: {code, icon, text}. */
function flagsFor(referred) {
  const flags = [];
  const joined = referred.map((r) => ts(r.joined)).filter((t) => !isNaN(t)).sort((a, b) => a - b);
  for (let i = 0; i + BURST_COUNT - 1 < joined.length; i++) {
    if (joined[i + BURST_COUNT - 1] - joined[i] <= BURST_MINUTES * 60000) {
      flags.push({ code: 'BURST', icon: '🚩', text: `${BURST_COUNT}+ referred accounts were created within ${BURST_MINUTES} minutes of each other (could be one person making accounts).` });
      break;
    }
  }
  const buyers = referred.filter((r) => r.orders > 0);
  if (buyers.length >= MIN_BUYERS) {
    const quick = buyers.filter((r) => {
      const a = ts(r.joined), b = ts(r.firstOrder);
      return !isNaN(a) && !isNaN(b) && b - a <= QUICK_MINUTES * 60000 && b >= a - 60000;
    });
    if (quick.length / buyers.length >= QUICK_SHARE) {
      flags.push({ code: 'QUICK', icon: '⚡', text: `${quick.length} of ${buyers.length} buyers bought within ${QUICK_MINUTES} minutes of joining (real customers usually look around first).` });
    }
    const same = buyers.every((r) => r.orders === buyers[0].orders && r.spent === buyers[0].spent && r.distinctTotals === 1);
    if (same) {
      flags.push({ code: 'UNIFORM', icon: '🟰', text: `All ${buyers.length} buyers spent exactly the same ($${buyers[0].spent}) in the same number of orders.` });
    }
  }
  return flags;
}

function referrerRow(id) {
  return raw.prepare('SELECT telegram_id, username, first_name, balance, referral_blocked, created_at FROM users WHERE telegram_id = ?').get(id);
}

/** The ranking: who earned most from referrals. */
function topReferrers({ page = 0, perPage = 10 } = {}) {
  const earned = new Map(raw.prepare(`SELECT user_id, SUM(amount) AS sum, COUNT(*) AS n, MAX(created_at) AS last
                                       FROM transactions WHERE type IN (${EARN_IN}) GROUP BY user_id`).all().map((r) => [r.user_id, r]));
  const counts = raw.prepare(`SELECT r.referrer_id AS id, COUNT(*) AS referred,
                              SUM(CASE WHEN EXISTS (SELECT 1 FROM orders o WHERE o.user_id = r.referred_id AND o.status = 'delivered') THEN 1 ELSE 0 END) AS buyers
                              FROM referrals r GROUP BY r.referrer_id`).all();
  const all = counts.map((c) => {
    const e = earned.get(c.id);
    const u = referrerRow(c.id);
    return { id: c.id, name: label(u, c.id), referred: c.referred, buyers: c.buyers || 0,
             earned: money(e ? e.sum : 0), payouts: e ? e.n : 0, last: e ? e.last : null,
             blocked: !!(u && Number(u.referral_blocked) === 1) };
  }).sort((a, b) => b.earned - a.earned || b.referred - a.referred || a.id - b.id);
  const total = all.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const p = Math.min(Math.max(0, parseInt(page, 10) || 0), pages - 1);
  const slice = all.slice(p * perPage, p * perPage + perPage).map((r) => ({ ...r, flags: flagsFor(referredOf(r.id)) }));
  return { rows: slice, total, page: p, pages };
}

/** One referrer: everything needed to decide. */
function referrerDetail(id) {
  const u = referrerRow(id);
  if (!u) return null;
  const referred = referredOf(id);
  const ledger = raw.prepare(`SELECT created_at, amount, type, order_id, description FROM transactions
                              WHERE user_id = ? AND type IN (${EARN_IN}) ORDER BY id DESC LIMIT 12`).all(id);
  const sum = raw.prepare(`SELECT COALESCE(SUM(amount),0) AS s, COUNT(*) AS n FROM transactions WHERE user_id = ? AND type IN (${EARN_IN})`).get(id);
  const all = raw.prepare(`SELECT COALESCE(SUM(amount),0) AS s FROM transactions WHERE type IN (${EARN_IN})`).get().s;
  const referredSpend = referred.reduce((s, r) => s + r.spent, 0);
  return {
    id, name: label(u, id), balance: money(u.balance), blocked: Number(u.referral_blocked) === 1, joined: u.created_at,
    referred, buyers: referred.filter((r) => r.orders > 0).length,
    earned: money(sum.s), payouts: sum.n, share: all > 0 ? Math.round((sum.s / all) * 100) : 0,
    referredSpend: money(referredSpend), flags: flagsFor(referred), ledger,
  };
}

function csv() {
  const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const rows = raw.prepare(`SELECT t.created_at, t.user_id, u.username, t.type, t.amount, t.order_id, t.description
                            FROM transactions t LEFT JOIN users u ON u.telegram_id = t.user_id
                            WHERE t.type IN (${EARN_IN}) ORDER BY t.id`).all();
  const out = ['date_utc,referrer_id,referrer_username,type,amount,order_id,referred_user_id,description'];
  for (const r of rows) {
    const m = /user (\d+)/.exec(r.description || '');
    out.push([r.created_at, r.user_id, r.username, r.type, r.amount, r.order_id, m ? m[1] : '', r.description].map(esc).join(','));
  }
  return out.join('\n') + '\n';
}

module.exports = { overview, topReferrers, referrerDetail, referredOf, flagsFor, csv, label, EARN_TYPES,
                   BURST_COUNT, BURST_MINUTES, QUICK_MINUTES, MIN_BUYERS };
