'use strict';

/**
 * Billing-cycle maths for ChatGPT Business.
 *
 * Extracted so the admin panel and the customer bot compute the cycle from the
 * SAME code. They previously each had their own idea of it, which is why the
 * panel could show a freshly added cycle while the bot went on quoting a
 * different one — nothing was stale, they were simply answering different
 * questions and neither said so.
 */

const db = require('../database/queries');
const raw = require('../database/db');

/**
 * The time of day a cycle boundary falls on, as [hours, minutes].
 *
 * Day-based cycles used to end at 00:00 — the START of the end day — while the
 * "start next cycle" button used 23:59, its END. So the same calendar day meant
 * two different moments depending on which code asked, and a seat bought on the
 * 25th could be sold either a full day or none at all.
 *
 * One setting now decides it for both. Default 23:59 means "day N is included",
 * which is what a customer assumes when told their seat runs until the 25th.
 */
/**
 * Minutes to shift the clock by, so "today" means the shop owner's today.
 *
 * The server runs on UTC. A shop in UTC+1 that starts a cycle on the 5th finds
 * the bot still on the 4th for the first hour of every day — the owner looks at
 * their phone, sees the 5th, and the bot disagrees. The offset moves the bot's
 * idea of the current moment onto the owner's calendar.
 */
function tzOffsetMinutes() {
  try {
    const v = parseFloat(String(db.getSetting('cgb_timezone_offset', '0') || '0'));
    return Number.isFinite(v) ? Math.round(v * 60) : 0;
  } catch (e) {
    return 0;
  }
}

/** `from`, expressed in the shop's local time. */
function localNow(from = new Date()) {
  const off = tzOffsetMinutes();
  return off ? new Date(from.getTime() + off * 60000) : new Date(from);
}

function boundaryTime() {
  let raw = '23:59';
  try {
    raw = String(db.getSetting('cgb_cycle_end_time', '23:59') || '23:59').trim();
  } catch (e) { /* settings unavailable */ }

  const m = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return [23, 59];
  const h = Math.min(23, Math.max(0, parseInt(m[1], 10)));
  const min = Math.min(59, Math.max(0, parseInt(m[2], 10)));
  return [h, min];
}

/** Configured cycles, or the historical defaults when none are set. */
function getCycles() {
  const cycles = db.getBillingCycles();
  if (cycles.length) return cycles;
  return [
    { id: null, start_day: 26, end_day: 25, is_default: true },
    { id: null, start_day: 16, end_day: 15, is_default: true },
  ];
}

/**
 * An explicitly set cycle end, chosen by the shop owner.
 *
 * Day-of-month cycles answer "when does the month roll over"; they cannot
 * answer "end the current cycle at 8pm tonight because that is when I actually
 * rotate the workspace". When a manual end is set it overrides everything —
 * it is the only case where the owner has stated a fact rather than a rule.
 *
 * A manual end in the past is ignored rather than obeyed: it means the moment
 * has already passed, and quoting a negative period would sell nothing for
 * money. The day-based cycles resume automatically, so a forgotten override
 * cannot silently break the shop.
 */
function manualCycleLocal(localFrom) {
  let raw;
  try {
    raw = db.getSetting('cgb_manual_cycle_end', '');
  } catch (e) {
    return null;
  }
  if (!raw) return null;

  const end = new Date(String(raw).replace(' ', 'T'));
  if (isNaN(end.getTime()) || end <= localFrom) return null;

  return {
    cycle: { id: null, start_day: null, end_day: null, manual: true, ends_at: raw },
    endDate: end,
    // Hours matter here, but a subscription is still sold in whole days, so a
    // part-day is rounded up — never down, which would short the customer.
    daysRemaining: Math.max(1, Math.ceil((end - localFrom) / 86400000)),
  };
}

/** Public form: converts to shop-local time first. */
function manualCycle(from = new Date()) {
  return manualCycleLocal(localNow(from));
}

/**
 * The cycle a purchase made today would land in.
 *
 * "Best" means the one giving the customer the MOST days — which is the part
 * that surprises admins: adding a cycle does not replace the existing ones, and
 * an older cycle keeps winning whenever it happens to run longer. Every cycle is
 * returned alongside the winner so a panel can show why.
 */
function calculateBestCycle(from = new Date()) {
  from = localNow(from);
  const manual = manualCycleLocal(from);
  if (manual) {
    manual.all = [manual];
    return manual;
  }

  const [bh, bm] = boundaryTime();
  const today = new Date(from);
  today.setHours(0, 0, 0, 0);

  const evaluated = getCycles().map((cycle) => {
    let endDate = new Date(today.getFullYear(), today.getMonth(), cycle.end_day, bh, bm, 0, 0);
    // Compare against `from`, not midnight: on the boundary day itself the
    // cycle is still open until the chosen time, and treating it as already
    // past would silently roll every buyer into next month.
    if (endDate < from) {
      endDate = new Date(today.getFullYear(), today.getMonth() + 1, cycle.end_day, bh, bm, 0, 0);
    }
    return {
      cycle,
      endDate,
      daysRemaining: Math.max(1, Math.ceil((endDate - today) / 86400000)),
    };
  });

  if (!evaluated.length) return null;

  let best = evaluated[0];
  for (const e of evaluated) if (e.daysRemaining > best.daysRemaining) best = e;

  best.all = evaluated;
  return best;
}

/**
 * The cycle AFTER the one currently in force.
 *
 * Used by "start next cycle now": the shop rotates the workspace before the
 * calendar says to, so new customers must be sold the following period rather
 * than the few remaining days of one that is already closed.
 *
 * Built from the winning cycle's end date plus a month rather than from a
 * second pass over the cycle list, so it always follows whatever cycle is
 * actually in force — including a manual override.
 */
function nextCycleAfterCurrent(from = new Date()) {
  // calculateBestCycle converts to local time itself; converting here as well
  // would shift the clock twice and push every date an hour out.
  const current = calculateBestCycle(from);
  if (!current) return null;

  const [bh, bm] = boundaryTime();
  const end = new Date(current.endDate);
  const next = new Date(end);
  next.setMonth(next.getMonth() + 1);
  next.setHours(bh, bm, 0, 0);

  const now = localNow(from);
  return {
    endDate: next,
    daysRemaining: Math.max(1, Math.ceil((next - now) / 86400000)),
    replaces: current,
  };
}

function getMonthlyPrice() {
  try {
    const row = raw.prepare(`SELECT value FROM settings WHERE key='chatgpt_monthly_price'`).get();
    return parseFloat(row?.value || '50') || 50;
  } catch (e) {
    return 50;
  }
}

module.exports = { getCycles, calculateBestCycle, getMonthlyPrice, manualCycle, nextCycleAfterCurrent, boundaryTime, localNow, tzOffsetMinutes };
