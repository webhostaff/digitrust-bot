'use strict';
/**
 * ChatGPT Business seat tools for the owner (V155).
 *  - the seats that END on a given day (the /ending command and the daily list)
 *  - finding a seat by order number or by its current email (/setemail)
 *  - changing a seat's email in the database
 * Pure database work: the Telegram side lives in chatgpt-bot.js.
 */

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** "today" · "tomorrow" · "+3" · "2026-10-30" · "30/10" · "30/10/2026" → YYYY-MM-DD (null if unreadable). */
function parseDay(raw, now) {
  const t = String(raw || '').trim().toLowerCase();
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const plus = (n) => { const d = new Date(base); d.setDate(d.getDate() + n); return ymd(d); };
  if (!t || t === 'today') return ymd(base);
  if (t === 'tomorrow') return plus(1);
  let m = /^\+(\d{1,3})$/.exec(t);
  if (m) return plus(Number(m[1]));
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  const check = (y, mo, d) => {
    const x = new Date(y, mo - 1, d);
    return x.getFullYear() === y && x.getMonth() === mo - 1 && x.getDate() === d ? ymd(x) : null;
  };
  if (m) return check(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{4}))?$/.exec(t);
  if (m) {
    const y = m[3] ? +m[3] : base.getFullYear();
    let r = check(y, +m[2], +m[1]);
    if (r && !m[3] && r < ymd(base)) r = check(y + 1, +m[2], +m[1]);       // 05/01 in October = next January
    return r;
  }
  return null;
}

/** Seats (pending invite or active) whose last day is `day`, grouped by workspace. */
function seatsEndingOn(db, day) {
  const rows = db.prepare(`
    SELECT cs.id, cs.order_id, cs.user_id, cs.email, cs.end_date, cs.status, cs.workspace, u.username
      FROM chatgpt_subscriptions cs
      LEFT JOIN users u ON u.telegram_id = cs.user_id
     WHERE date(cs.end_date) = date(?)
       AND COALESCE(cs.status, 'pending') IN ('active', 'pending')
       AND cs.email IS NOT NULL AND cs.email <> ''
     ORDER BY COALESCE(cs.workspace, ''), cs.email`).all(day);
  const groups = new Map();
  for (const r of rows) {
    const k = r.workspace || '—';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  return { day, total: rows.length, groups: [...groups.entries()] };
}

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** HTML text of one day's list (and the plain e-mails, for copying). */
function endingText(list, label = '') {
  if (!list.total) return { text: `📅 <b>${list.day}</b>${label ? ` · ${label}` : ''}\nNo seat ends that day.`, emails: [] };
  const lines = [`📅 <b>${list.day}</b>${label ? ` · ${label}` : ''} — <b>${list.total}</b> seat(s) end`];
  const emails = [];
  for (const [ws, rows] of list.groups) {
    lines.push('', `🖥 <b>${esc(ws)}</b> · ${rows.length}`);
    for (const r of rows) {
      emails.push(r.email);
      const who = r.username ? `@${esc(r.username)}` : `<code>${r.user_id}</code>`;
      lines.push(`• <code>${esc(r.email)}</code> — ${who}${r.order_id ? ` · #${r.order_id}` : ' · manual'}${r.status === 'pending' ? ' · ⏳ not activated' : ''}`);
    }
  }
  return { text: lines.join('\n'), emails };
}

/**
 * The seat to change: by order number ("20439" / "#20439") or by its CURRENT email
 * (the latest active or pending seat with that email). → { sub } | { error }
 */
function findSeat(db, ref) {
  const r = String(ref || '').trim().replace(/^#/, '');
  if (/^\d+$/.test(r)) {
    const sub = db.prepare(`SELECT * FROM chatgpt_subscriptions WHERE order_id = ? ORDER BY id DESC LIMIT 1`).get(Number(r));
    return sub && Number(r) > 0 ? { sub } : { error: `no seat found for order #${r}` };
  }
  if (EMAIL_RE.test(r)) {
    const subs = db.prepare(`
      SELECT * FROM chatgpt_subscriptions
       WHERE lower(email) = lower(?) AND COALESCE(status, 'pending') IN ('active', 'pending')
       ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, date(end_date) DESC, id DESC`).all(r);
    if (!subs.length) return { error: `no active or pending seat uses ${r}` };
    return { sub: subs[0], others: subs.length - 1 };
  }
  return { error: 'give the order number or the seat\'s current email' };
}

/** Parse "/setemail <order|old email> <new email>". */
function parseSetEmail(raw) {
  const parts = String(raw || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return { ok: false, error: 'usage: /setemail <order number or current email> <new email>' };
  const next = parts[1].toLowerCase();
  if (!EMAIL_RE.test(next)) return { ok: false, error: `"${parts[1]}" is not an email` };
  return { ok: true, ref: parts[0], email: next };
}

/**
 * Write the new email on the seat — and on a renewal of it that is not active yet (same customer, same old
 * email), so the renewal does not bring the old address back. → { changed: [ids], before }
 */
function changeSeatEmail(db, sub, newEmail) {
  const before = sub.email;
  const ids = [sub.id];
  try {
    const kids = db.prepare(`SELECT id FROM chatgpt_subscriptions WHERE renewed_from = ? AND COALESCE(status,'pending') = 'pending'
                               AND lower(email) = lower(?)`).all(sub.id, before);
    for (const k of kids) ids.push(k.id);
  } catch (_) { /* older database without renewed_from */ }
  const tx = db.transaction(() => {
    for (const id of ids) db.prepare('UPDATE chatgpt_subscriptions SET email = ? WHERE id = ?').run(newEmail, id);
    if (sub.order_id) {
      try { db.prepare('UPDATE orders SET email = ? WHERE id = ? AND lower(COALESCE(email, \'\')) = lower(?)').run(newEmail, sub.order_id, before); } catch (_) {}
    }
  });
  tx();
  return { changed: ids, before };
}

/** Seats recorded as the renewal of a seat on ANOTHER email (V156.3). */
function mismatchedRenewals(db) {
  try {
    return db.prepare(`
      SELECT cs.id, cs.order_id, cs.email, cs.start_date, cs.end_date, cs.status, prev.email AS prev_email
        FROM chatgpt_subscriptions cs JOIN chatgpt_subscriptions prev ON prev.id = cs.renewed_from
       WHERE lower(COALESCE(cs.email,'')) <> lower(COALESCE(prev.email,''))
         AND COALESCE(cs.status,'pending') IN ('active','pending')
       ORDER BY cs.id DESC`).all();
  } catch (_) { return []; }
}

/** Remove a wrong renewal link: the seat becomes a new seat. */
function unlinkRenewal(db, subId) {
  const r = db.prepare(`SELECT cs.id, cs.order_id, cs.email, prev.email AS prev_email FROM chatgpt_subscriptions cs
                         LEFT JOIN chatgpt_subscriptions prev ON prev.id = cs.renewed_from WHERE cs.id = ?`).get(subId);
  if (!r) return { ok: false, reason: 'that seat no longer exists' };
  if (!r.prev_email) return { ok: false, reason: 'that seat is not linked to another one any more' };
  if (String(r.email || '').toLowerCase() === String(r.prev_email).toLowerCase()) return { ok: false, reason: 'same email — that is a real renewal, left as it is' };
  db.prepare('UPDATE chatgpt_subscriptions SET renewed_from = NULL WHERE id = ?').run(subId);
  return { ok: true, ...r };
}

/** "Day 11 → 9" — the cycle a seat ending on `endDate` belongs to (by its end day), or ''. */
function cycleLabel(db, endDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(endDate || ''));
  if (!m) return '';
  const day = Number(m[3]);
  const last = new Date(Number(m[1]), Number(m[2]), 0).getDate();
  try {
    const rows = db.prepare('SELECT start_day, end_day FROM billing_cycles WHERE COALESCE(is_active,1) = 1').all();
    const c = rows.find((r) => Math.min(r.end_day, last) === day);
    return c ? `Day ${c.start_day} → ${c.end_day}` : '';
  } catch (_) { return ''; }
}

/** Paid renewals: waiting for activation, and those activated in the last `days` days (V156.7). */
function paidRenewals(db, todayYmd, days = 20) {
  return db.prepare(`
    SELECT cs.id, cs.order_id, cs.user_id, cs.email, cs.start_date, cs.end_date, cs.status, cs.workspace, cs.final_price,
           prev.workspace AS prev_workspace, u.username
      FROM chatgpt_subscriptions cs
      JOIN chatgpt_subscriptions prev ON prev.id = cs.renewed_from
      LEFT JOIN users u ON u.telegram_id = cs.user_id
     WHERE COALESCE(cs.status,'pending') = 'pending'
        OR (cs.status = 'active' AND date(cs.start_date) >= date(?, '-' || ? || ' days'))
     ORDER BY cs.status DESC, date(cs.start_date), cs.email`).all(todayYmd, days);
}

module.exports = { cycleLabel, paidRenewals, mismatchedRenewals, unlinkRenewal, EMAIL_RE, ymd, parseDay, seatsEndingOn, endingText, findSeat, parseSetEmail, changeSeatEmail };
