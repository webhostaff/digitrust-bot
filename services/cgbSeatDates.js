'use strict';
/**
 * Fixing the dates of a PAID seat — before it is activated (V144) or after, when the customer is
 * told about the change (V145) — and finding the ones that need it.
 *
 * Until V144 a renewal ended on the end day of whichever cycle was "best" for a new buyer that day,
 * so deleting a cycle moved every renewal's end. Those orders are already paid: the customer saw
 * the dates before paying and the card carries them. This lets the owner correct them (/setdates)
 * and lists the ones that disagree with the customer's own cycle (/checkrenewals).
 */

const raw = require('../database/db');
const cycles = require('./cgbCycles');

raw.exec(`CREATE TABLE IF NOT EXISTS cgb_date_edits (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    INTEGER NOT NULL,
  was_active  INTEGER NOT NULL DEFAULT 0,
  old_start   TEXT, old_end TEXT, old_days INTEGER,
  new_start   TEXT, new_end TEXT, new_days INTEGER,
  notified    INTEGER NOT NULL DEFAULT 0,
  note        TEXT,
  admin_id    TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
)`);

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

const MAX_NOTE = 300;

/**
 * '/setdates 20439 2026-10-05 2026-11-09 [a note for the customer]' (arguments only)
 *   → {ok, orderId, start, end, note} | {ok:false, error}
 * The note is only used when the seat is already active and the customer is told.
 */
function parseSetDates(text) {
  const all = String(text || '').trim().split(/\s+/).filter(Boolean);
  const t = all.slice(0, 3);
  const note = all.slice(3).join(' ').slice(0, MAX_NOTE);
  if (t.length !== 3) return { ok: false, error: 'Use: /setdates <order> <first day> <last day> [note for the customer]   e.g. /setdates 20439 2026-10-05 2026-11-09' };
  const orderId = /^\d+$/.test(t[0]) ? parseInt(t[0], 10) : NaN;
  if (!Number.isFinite(orderId)) return { ok: false, error: `“${t[0]}” is not an order number.` };
  if (!validYmd(t[1])) return { ok: false, error: `“${t[1]}” is not a date. Write it as YYYY-MM-DD (2026-10-11).` };
  if (!validYmd(t[2])) return { ok: false, error: `“${t[2]}” is not a date. Write it as YYYY-MM-DD (2026-11-09).` };
  if (t[2] < t[1]) return { ok: false, error: 'The last day cannot be before the first day.' };
  const span = daysCovered(t[1], t[2]);
  if (span > MAX_SPAN_DAYS) return { ok: false, error: `That is ${span} days — more than ${MAX_SPAN_DAYS}. Check the years.` };
  return { ok: true, orderId, start: t[1], end: t[2], note };
}

/**
 * Change the dates of a PAID seat: not yet activated (nobody was told anything), or ACTIVE with
 * `{ allowActive: true }` — the caller then tells the customer. Nothing else about the order
 * changes: not the price, not the status. Expired, cancelled and unpaid seats are refused.
 */
function applySeatDates(orderId, start, end, { allowActive = false, note = null, adminId = null, notified = false } = {}) {
  const sub = raw.prepare('SELECT * FROM chatgpt_subscriptions WHERE order_id = ?').get(orderId);
  if (!sub) return { ok: false, reason: `no seat found for order #${orderId}` };
  if (sub.status === 'cancelled') return { ok: false, reason: 'that order was cancelled' };
  if (sub.status === 'expired') return { ok: false, reason: 'that seat is expired — it has to be renewed, not edited' };
  if (sub.status === 'active' && !allowActive) return { ok: false, reason: 'that seat is already activated and the customer was told its dates' };
  if (sub.status !== 'pending' && sub.status !== 'active') return { ok: false, reason: `that order is not paid yet (${sub.status})` };
  // A renewal counts the days AFTER its start (the start is the previous seat's last day, already
  // paid); a new seat counts both ends. The same counts the customer was quoted.
  const days = sub.renewed_from ? daysAfter(start, end) : daysCovered(start, end);
  if (days == null) return { ok: false, reason: 'invalid dates' };
  if (sub.start_date === start && sub.end_date === end) return { ok: false, reason: 'those are already the dates of that seat — nothing to change' };
  const wasActive = sub.status === 'active';
  raw.transaction(() => {
    // The expiry reminders look at end_date every day, so they follow the new date by themselves;
    // the old per-seat "already told" flags (3 days / 1 day / today) are cleared so they can fire again.
    raw.prepare(`UPDATE chatgpt_subscriptions SET start_date = ?, end_date = ?, days_remaining = ?,
                   notified_3d = 0, notified_1d = 0, notified_0d = 0, updated_at = datetime('now')
                 WHERE order_id = ? AND status = ?`).run(start, end, days, orderId, sub.status);
    raw.prepare(`INSERT INTO cgb_date_edits (order_id, was_active, old_start, old_end, old_days, new_start, new_end, new_days, notified, note, admin_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(orderId, wasActive ? 1 : 0, sub.start_date, sub.end_date, sub.days_remaining, start, end, days, notified ? 1 : 0, note || null, adminId == null ? null : String(adminId));
  })();
  return { ok: true, wasActive, before: { start: sub.start_date, end: sub.end_date, days: sub.days_remaining }, after: { start, end, days }, sub };
}

/** The message the customer gets when the owner changes the dates of an ACTIVE seat. */
function customerDatesMessage({ orderId, before, after, note }) {
  const esc = (x) => String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return (
    `📅 <b>Your subscription dates were updated</b>\n\n` +
    `🆔 Order: <b>#${orderId}</b>\n` +
    `⏱ Duration: <b>${after.days} days</b>\n` +
    `📅 New expiry date: <b>${esc(after.end)}</b>\n` +
    (before && before.end && before.end !== after.end ? `<i>(previous expiry date: ${esc(before.end)})</i>\n` : '') +
    (note ? `\n📝 ${esc(note)}\n` : '') +
    `\nYour subscription stays active. If you have any question, please contact our support team.`
  );
}

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * What the customer's own cycle says a renewal of a seat ending `prevEnd` should be — dates and
 * price, from the SAME quote the customer is shown (cgbCycles.quoteRenewal).
 */
function expectedRenewal(userId, prevEnd, months, at) {
  const q = cycles.quoteRenewal({ user_id: userId, end_date: prevEnd }, months, at, { ignoreWindow: true });   // judges past sales
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
      // V156.6: renewals start the day after the old end; older ones started ON it — both are right.
      if ((e.start === r.start_date || r.start_date === r.prev_end) && e.end === r.end_date) match = true;
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

module.exports = { parseSetDates, applySeatDates, customerDatesMessage, auditRenewals, expectedRenewal, daysCovered, daysAfter, validYmd };
