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
 * The cycle a purchase made today would land in.
 *
 * "Best" means the one giving the customer the MOST days — which is the part
 * that surprises admins: adding a cycle does not replace the existing ones, and
 * an older cycle keeps winning whenever it happens to run longer. Every cycle is
 * returned alongside the winner so a panel can show why.
 */
function calculateBestCycle(from = new Date()) {
  const today = new Date(from);
  today.setHours(0, 0, 0, 0);

  const evaluated = getCycles().map((cycle) => {
    let endDate = new Date(today.getFullYear(), today.getMonth(), cycle.end_day);
    if (endDate < today) {
      endDate = new Date(today.getFullYear(), today.getMonth() + 1, cycle.end_day);
    }
    return {
      cycle,
      endDate,
      daysRemaining: Math.ceil((endDate - today) / 86400000),
    };
  });

  if (!evaluated.length) return null;

  let best = evaluated[0];
  for (const e of evaluated) if (e.daysRemaining > best.daysRemaining) best = e;

  best.all = evaluated;
  return best;
}

function getMonthlyPrice() {
  try {
    const row = raw.prepare(`SELECT value FROM settings WHERE key='chatgpt_monthly_price'`).get();
    return parseFloat(row?.value || '50') || 50;
  } catch (e) {
    return 50;
  }
}

module.exports = { getCycles, calculateBestCycle, getMonthlyPrice };
