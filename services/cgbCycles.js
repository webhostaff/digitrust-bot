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
    startDate: new Date(new Date(localFrom).setHours(0, 0, 0, 0)),
    inGap: false,
    cycleLength: 30,
  };
}

/** Public form: converts to shop-local time first. */
function manualCycle(from = new Date()) {
  return manualCycleLocal(localNow(from));
}

/**
 * A calendar day, clamped to the month's last day.
 *
 * A cycle on day 31 has no 31st in September; JavaScript would silently roll
 * that over to October 1st and quote a period a day off. Clamping keeps it on
 * the last day of the month, which is what "day 31" means to a person.
 */
function dayIn(y, m, d, h = 0, min = 0) {
  const last = new Date(y, m + 1, 0).getDate();
  return new Date(y, m, Math.min(d, last), h, min, 0, 0);
}

const DAY_MS = 86400000;

/**
 * The period a purchase made at `from` belongs to, for one cycle.
 *
 * Both ends of the cycle are used. The old code read only end_day, so a cycle
 * of 26 -> 24 was treated as "ends on the 24th" and a buyer on the 25th — a day
 * that belongs to no cycle — was sold a period starting that same day. Now:
 *
 *   - inside a cycle: the period runs from today to the cycle end;
 *   - in the gap between two cycles: it starts on the next start day, and the
 *     customer gets (and pays for) the whole cycle.
 *
 * cycleLength is the real length of THIS cycle (29 days for 26 Sep -> 24 Oct),
 * so the price is the monthly rate split over the days the cycle actually has,
 * not over a fixed 30.
 */
function evaluateCycle(cycle, from, bh, bm) {
  const today = new Date(from);
  today.setHours(0, 0, 0, 0);

  // Next boundary at or after `from`. Compared against `from`, not midnight: on
  // the boundary day itself the cycle is open until the chosen time.
  let endDate = dayIn(today.getFullYear(), today.getMonth(), cycle.end_day, bh, bm);
  if (endDate < from) endDate = dayIn(today.getFullYear(), today.getMonth() + 1, cycle.end_day, bh, bm);

  // The start of the period that end closes: the latest start day before it.
  let periodStart = dayIn(endDate.getFullYear(), endDate.getMonth(), cycle.start_day);
  if (periodStart >= endDate) periodStart = dayIn(endDate.getFullYear(), endDate.getMonth() - 1, cycle.start_day);

  const inGap = periodStart > today;
  const startDate = inGap ? periodStart : today;

  const cycleLength = Math.max(1, Math.ceil((endDate - periodStart) / DAY_MS));
  const daysRemaining = Math.max(1, Math.ceil((endDate - startDate) / DAY_MS));

  return { cycle, endDate, startDate, periodStart, inGap, cycleLength, daysRemaining };
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
  const evaluated = getCycles().map((cycle) => evaluateCycle(cycle, from, bh, bm));
  if (!evaluated.length) return null;

  let best = evaluated[0];
  for (const e of evaluated) if (e.daysRemaining > best.daysRemaining) best = e;

  best.all = evaluated;
  return best;
}

/**
 * What `days` of this period cost at a monthly rate.
 *
 * The rate is split over the cycle's real length, so a full cycle always costs
 * exactly the monthly price whether that cycle has 28, 29, 30 or 31 days.
 * Periods with no cycle behind them (a manual end) fall back to 30.
 */
function priceFor(days, cycleLength, monthly) {
  const len = cycleLength > 0 ? cycleLength : 30;
  return Number(((days / len) * monthly).toFixed(2));
}

/** Price of the period `best` describes. */
function pricePeriod(best, monthly) {
  if (!best) return 0;
  return priceFor(best.daysRemaining, best.cycleLength, monthly);
}

/**
 * One more whole cycle after `endDate` — the "Add a full month" option.
 *
 * Lands on the cycle's own end day a month later rather than adding a flat 30
 * days, which drifted off the cycle and left the seat ending mid-cycle.
 */
function oneMoreCycle(best) {
  const [bh, bm] = boundaryTime();
  if (best.cycle && best.cycle.end_day && best.cycle.start_day) {
    // The cycle that follows, measured on its own days — a gap day between the
    // two cycles belongs to neither and is not counted as sold.
    const next = evaluateCycle(best.cycle, new Date(best.endDate.getTime() + 60000), bh, bm);
    return { endDate: next.endDate, days: next.cycleLength };
  }
  return { endDate: new Date(best.endDate.getTime() + 30 * DAY_MS), days: 30 };
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
    cycleLength: Math.max(1, Math.round((next - end) / 86400000)),
    replaces: current,
  };
}

/**
 * The monthly rate — for a specific customer when one is given.
 *
 * A per-customer override beats the shop rate. Resellers and long-standing
 * buyers get negotiated numbers, and the alternative is the shop owner
 * remembering to hand-adjust every invoice, which is how a discount promised
 * once quietly stops being honoured.
 */
function getMonthlyPrice(userId = null) {
  if (userId) {
    try {
      const row = raw.prepare('SELECT monthly_price FROM cgb_user_prices WHERE user_id = ?').get(userId);
      const v = Number(row?.monthly_price);
      // 0 is a valid price (a free seat), so only a missing row falls through.
      if (row && Number.isFinite(v) && v >= 0) return v;
    } catch (e) { /* table may not exist yet */ }
  }
  return globalMonthlyPrice();
}

function globalMonthlyPrice() {
  try {
    const row = raw.prepare(`SELECT value FROM settings WHERE key='chatgpt_monthly_price'`).get();
    return parseFloat(row?.value || '50') || 50;
  } catch (e) {
    return 50;
  }
}

module.exports = { getCycles, calculateBestCycle, priceFor, pricePeriod, oneMoreCycle, getMonthlyPrice, manualCycle, nextCycleAfterCurrent, boundaryTime, localNow, tzOffsetMinutes };
