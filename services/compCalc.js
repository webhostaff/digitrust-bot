'use strict';
/**
 * 🧮 Compensation-links calculator (V166).
 * The links given to customers as replacements/compensation, as ONE clear list:
 *      5 × $0.25 = $1.25
 *      2 × $0.45 = $0.90
 *      7 links = $2.15
 * for Today · 7 days · 30 days · Since reset · All time, plus a free calculator ("3 x 0.45 + 2 x 0.25").
 */
const db = require('../database/queries');
const KIND = 'gemini';
const NAMES = { today: 'Today', d7: 'Last 7 days', d30: 'Last 30 days', reset: 'Since last reset', all: 'All time' };
const ORDER = ['today', 'd7', 'd30', 'reset', 'all'];
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const money = (n) => `$${r2(n).toFixed(2).replace(/\.?0+$/, '')}`;
const plural = (n) => `link${n === 1 ? '' : 's'}`;

/**
 * cb = callback prefix, e.g. 'rq_calc' → rq_calc_today … rq_calc_x ; back = callback of the back button.
 */
function view(period, { cb, back, backText = '🔙 Back' }) {
  const p = NAMES[period] ? period : 'reset';
  const rows = db.replUsedByPeriod(KIND, p);
  let n = 0, amount = 0, un = 0, unAmt = 0;
  let t = `🧮 <b>Compensation links</b> · ${NAMES[p]}\n━━━━━━━━━━━━━━━━━━\n`;
  if (!rows.length) t += `<i>No link was given in this period.</i>\n`;
  for (const r of rows) {
    n += r.n; amount += r.amount; un += r.unclaimed || 0; unAmt += r.unclaimed_amount || 0;
    t += `${r.n} × ${r.price > 0 ? money(r.price) : '<i>no price</i>'} = <b>${money(r.amount)}</b>\n`;
  }
  if (rows.length) t += `━━━━━━━━━━━━━━━━━━\n<b>${n} ${plural(n)} = ${money(amount)}</b>\n`;
  if (un > 0) t += `🟠 Still to claim from the supplier: ${un} ${plural(un)} = ${money(unAmt)}\n`;
  const kb = [
    ORDER.slice(0, 3).map((k) => ({ text: (k === p ? '● ' : '') + NAMES[k], callback_data: `${cb}_${k}` })),
    ORDER.slice(3).map((k) => ({ text: (k === p ? '● ' : '') + NAMES[k], callback_data: `${cb}_${k}` })),
    [{ text: '➕ Calculate a number of links', callback_data: `${cb}_x` }],
    [{ text: backText, callback_data: back }],
  ];
  return { text: t, kb };
}

/** "3 x 0.45 + 2 x 0.25" · "5 0.3" · "4*1.2, 2*0.5" → list + total, or null */
function calc(text) {
  const parts = String(text || '').replace(/[×✕]/g, 'x').split(/[+;\n]+|,(?=\s)/).map((x) => x.trim()).filter(Boolean);
  const items = [];
  for (const part of parts) {
    const m = /^(\d+)\s*(?:x|\*|@|links?)?\s*\$?\s*(\d+(?:[.,]\d+)?)\s*\$?$/i.exec(part);
    if (!m) return null;
    const qty = parseInt(m[1], 10), price = parseFloat(m[2].replace(',', '.'));
    if (!(qty > 0 && price > 0 && qty <= 100000 && price <= 100000)) return null;
    items.push({ qty, price, amount: r2(qty * price) });
  }
  if (!items.length) return null;
  const n = items.reduce((a, b) => a + b.qty, 0), total = r2(items.reduce((a, b) => a + b.amount, 0));
  return { items, n, total, text: items.map((i) => `${i.qty} × ${money(i.price)} = <b>${money(i.amount)}</b>`).join('\n') + `\n━━━━━━━━━━━━━━━━━━\n<b>${n} ${plural(n)} = ${money(total)}</b>` };
}

const PROMPT = '🧮 Send the number of links and the price of one, e.g.\n<code>3 x 0.45</code>\nor several together:\n<code>3 x 0.45 + 2 x 0.25</code>';

module.exports = { view, calc, money, PROMPT, NAMES };
