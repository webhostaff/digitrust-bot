'use strict';
/**
 * Fixing the dates of a PAID seat that is not activated yet, and finding the ones that need it (V144).
 *
 * Until V144 a renewal ended on the end day of whichever cycle was "best" for a new buyer that day,
 * so deleting a cycle moved every renewal's end. Those orders are already paid: the customer saw
 * the dates before paying and the card carries them. This lets the owner correct them (/setdates)
 * and lists the ones that disagree with the customer's own cycle (/checkrenewals).
 */

const raw = require('../database/db');
const cycles = require('./cgbCycles');

const DAY_MS = 86400000;
const MAX_SPAN_DAYS = 400;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

function validYmd(s) {
  if (!YMD.test(s)) return null;
  const d = new Date(`${s}T00:00:00`);
  const [y, m, day] = s.split('-').map(Number);
  return d.getFullYear() === y && d.getMonth() === m - 1 && d.getDate() === day ? d : null;   // rejects 2026-02-31
}

/** Days covered, counting both the first and the last day (11 Oct → 9 Nov = 30). */
function daysCovered(start, end) {
  const a = validYmd(start), b = validYmd(end);
  if (!a || !b) return null;
  return Math.round((b.getTime() + DAY_MS - a.getTime()) / DAY_MS);
}

/**
 * Days between two dates, NOT counting the first (5 Oct → 9 Oct = 4).
 * A RENEWAL's "start date" is the day the previous seat ended — a day that is already paid —
 * so the days it adds are the ones after it. This is the same count the customer is quoted.
 */
function daysAfter(start, end) {
  const a = validYmd(start), b = validYmd(end);
  if (!a || !b) return null;
  return Math.max(1, Math.round((b.getTime() - a.getTime()) / DAY_MS));
}

/** '/setdates 20439 2026-10-05 2026-10-09' (arguments only) → {ok, orderId, start, end} | {ok:false, error} */
function parseSetDates(text) {
  const t = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (t.length !== 3) return { ok: false, error: 'Use: /setdates <order> <first day> <last day>   e.g. /setdates 20439 2026-10-11 2026-11-09' };
  const orderId = /^\d+$/.test(t[0]) ? parseInt(t[0], 10) : NaN;
  if (!Number.isFinite(orderId)) return { ok: false, error: `“${t[0]}” is not an order number.` };
  if (!validYmd(t[1])) return { ok: false, error: `“${t[1]}” is not a date. Write it as YYYY-MM-DD (2026-10-11).` };
  if (!validYmd(t[2])) return { ok: false, error: `“${t[2]}” is not a date. Write it as YYYY-MM-DD (2026-11-09).` };
  if (t[2] < t[1]) return { ok: false, error: 'The last day cannot be before the first day.' };
  const span = daysCovered(t[1], t[2]);
  if (span > MAX_SPAN_DAYS) return { ok: false, error: `That is ${span} days — more than ${MAX_SPAN_DAYS}. Check the years.` };
  return { ok: true, orderId, start: t[1], end: t[2] };
}

/** Change the dates of a PAID, NOT YET ACTIVATED seat. Nothing else about the order changes. */
function applySeatDates(orderId, start, end) {
  const sub = raw.prepare('SELECT * FROM chatgpt_subscriptions WHERE order_id = ?').get(orderId);
  if (!sub) return { ok: false, reason: `no seat found for order #${orderId}` };
  if (sub.status === 'active') return { ok: false, reason: 'that seat is already activated and the customer was told its dates' };
  if (sub.status === 'cancelled') return { ok: false, reason: 'that order was cancelled' };
  if (sub.status !== 'pending') return { ok: false, reason: `that order is not paid yet (${sub.status})` };
  // A renewal counts the days AFTER its start (the start is the previous seat's last day, already
  // paid); a new seat counts both ends. The same counts the customer was quoted.
  const days = sub.renewed_from ? daysAfter(start, end) : daysCovered(start, end);
  if (days == null) return { ok: false, reason: 'invalid dates' };
  raw.prepare(`UPDATE chatgpt_subscriptions SET start_date = ?, end_date = ?, days_remaining = ?, updated_at = datetime('now')
               WHERE order_id = ? AND status = 'pending'`).run(start, end, days, orderId);
  return { ok: true, before: { start: sub.start_date, end: sub.end_date, days: sub.days_remaining }, after: { start, end, days }, sub };
}

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * What the customer's own cycle says a renewal of a seat ending `prevEnd` should be — dates and
 * price, from the SAME quote the customer is shown (cgbCycles.quoteRenewal).
 */
function expectedRenewal(userId, prevEnd, months, at) {
  const q = cycles.quoteRenewal({ user_id: userId, end_date: prevEnd }, months, at);
  const start = ymd(q.from), end = ymd(q.to);
  return { start, end, days: q.days, kind: q.kind, months, price: q.price };
}

/**
 * Every PAID renewal that is not activated yet, checked against the customer's own cycle.
 * A renewal is fine when ITS dates equal what 1..12 months in that cycle give; otherwise it is
 * listed with the dates to use (months guessed from its length).
 */
function auditRenewals(now = new Date()) {
  const rows = raw.prepare(`
    SELECT cs.order_id, cs.user_id, cs.email, cs.start_date, cs.end_date, cs.days_remaining, cs.final_price, cs.created_at,
           prev.end_date AS prev_end, u.username, u.first_name
    FROM chatgpt_subscriptions cs
    JOIN chatgpt_subscriptions prev ON prev.id = cs.renewed_from
    LEFT JOIN users u ON u.telegram_id = cs.user_id
    WHERE cs.status = 'pending' ORDER BY cs.start_date, cs.order_id`).all();
  const ok = [], bad = [];
  for (const r of rows) {
    const at = r.created_at ? new Date(String(r.created_at).replace(' ', 'T') + 'Z') : now;   // the day it was bought
    let match = false;
    for (let m = 1; m <= 12 && !match; m++) {
      const e = expectedRenewal(r.user_id, r.prev_end, m, at);
      if (e.start === r.start_date && e.end === r.end_date) match = true;
    }
    // How many months did he pay for? The old rule always billed monthly price × months (less the
    // bulk discount), whatever the days were, so the AMOUNT tells; the days do not (25 days was
    // one month's price).
    const monthly = cycles.getMonthlyPrice(r.user_id);
    let months = 1, gap = Infinity;
    for (let m = 1; m <= 12; m++) {
      const g = Math.abs(Number(r.final_price) - monthly * m * (1 - cycles.renewDiscountFor(m) / 100));
      if (g < gap - 1e-9) { gap = g; months = m; }
    }
    const guess = expectedRenewal(r.user_id, r.prev_end, months, at);
    const who = r.username ? '@' + r.username : (r.first_name || String(r.user_id));
    if (match) { ok.push({ orderId: r.order_id, who }); continue; }
    bad.push({
      orderId: r.order_id, who, email: r.email, userId: r.user_id,
      has: { start: r.start_date, end: r.end_date, days: r.days_remaining, paid: Number(r.final_price) },
      should: guess, prevEnd: r.prev_end,
    });
  }
  return { checked: rows.length, ok, bad };
}

module.exports = { parseSetDates, applySeatDates, auditRenewals, expectedRenewal, daysCovered, daysAfter, validYmd };
