'use strict';
/**
 * Transaction report for an exchange's verification request (V149).
 *
 * Reads the store's own database and cross-references, for every payment:
 *     TXID → user → order → product → payment → delivery
 * and writes it chronologically (oldest first), with the order list, a per-user summary, the wallet
 * credits that have no TXID, a summary of what was found and a plain statement of what the database
 * does NOT record (so nothing in the report is invented).
 *
 * How the links are made — all of them exact, none guessed:
 *   used_txids        every payment the bot verified on Binance (its TXID / off-chain id / Binance Pay id)
 *   transactions      the ledger row written at the same time carries ref_id = that TXID:
 *                       type 'deposit'                      → the money went into the user's wallet
 *                       type 'purchase' + order_id          → the money paid that order directly
 *   orders / products / manual_deliveries / chatgpt_subscriptions / cgb_admin_cards → the rest of the chain
 * Times are UTC (the database's own clock).
 */

const crypto = require('crypto');
const raw = require('../database/db');
const config = require('../config');
const { offchainDigits } = require('../utils/txid');
const { buildXlsx } = require('../utils/xlsxWriter');

const round = (n, d = 6) => (Number.isFinite(Number(n)) ? Number(Number(n).toFixed(d)) : 0);
const safeAll = (sql, ...p) => { try { return raw.prepare(sql).all(...p); } catch (_) { return []; } };
const clean = (t) => String(t == null ? '' : t).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
const iso = (ms) => (Number.isFinite(Number(ms)) && Number(ms) > 0 ? new Date(Number(ms)).toISOString().slice(0, 19).replace('T', ' ') : '');
const day = (s) => String(s || '').slice(0, 10);

/** One key per payment id: off-chain ids in any spelling meet, hashes compare without case. */
function keyOf(txid) {
  const v = String(txid == null ? '' : txid).trim();
  const d = offchainDigits(v);
  return d ? `offchain:${d}` : v.toLowerCase();
}

function receiverFor(network, address) {
  if (address) return address;
  const n = String(network || '').toUpperCase();
  if (/BEP20|BSC/.test(n)) return config.usdtBep20Address || '(shop BEP20 address — not set in this environment)';
  if (/TRC20|TRON/.test(n)) return config.usdtTrc20Address || '(shop TRC20 address — not set in this environment)';
  if (/TON/.test(n)) return config.usdtTonAddress || '(shop TON address — not set in this environment)';
  if (/PAY/.test(n)) return 'Binance Pay (shop account)';
  return 'Binance (shop account)';
}

function methodLabel(txid, network) {
  const n = String(network || '').trim();
  if (offchainDigits(txid)) return `Binance internal transfer (off-chain)${n ? ` · ${n}` : ''}`;
  if (/pay/i.test(n)) return 'Binance Pay';
  return n ? `USDT ${n}` : 'USDT';
}

/** Stable pseudonym: the same user is the same code in every row, but it cannot be turned back. */
function pseudonym(userId) {
  let salt = raw.prepare("SELECT value FROM settings WHERE key = 'report_salt'").get();
  if (!salt) {
    const v = crypto.randomBytes(16).toString('hex');
    raw.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('report_salt', ?)").run(v);
    salt = { value: v };
  }
  return 'U-' + crypto.createHash('sha256').update(`${userId}:${salt.value}`).digest('hex').slice(0, 6).toUpperCase();
}

/**
 * @param {{anonymize?:boolean, fromDate?:string|null}} opts
 *   fromDate 'YYYY-MM-DD' keeps only payments / orders from that day on.
 */
function buildReport({ anonymize = false, fromDate = null } = {}) {
  const generatedAt = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const inPeriod = (dt) => !fromDate || day(dt) >= fromDate;

  // ── load ───────────────────────────────────────────────────────────────────
  const users = new Map(safeAll('SELECT telegram_id, username, first_name, last_name, balance FROM users').map((u) => [Number(u.telegram_id), u]));
  const products = new Map(safeAll('SELECT * FROM products').map((p) => [Number(p.id), p]));
  const orders = safeAll('SELECT * FROM orders ORDER BY created_at, id');
  const orderById = new Map(orders.map((o) => [Number(o.id), o]));
  const ledger = safeAll('SELECT * FROM transactions ORDER BY id');
  const ledgerByRef = new Map();
  const ledgerByOrder = new Map();
  for (const l of ledger) {
    if (l.ref_id) { const k = keyOf(l.ref_id); if (!ledgerByRef.has(k)) ledgerByRef.set(k, []); ledgerByRef.get(k).push(l); }
    if (l.order_id) { const k = Number(l.order_id); if (!ledgerByOrder.has(k)) ledgerByOrder.set(k, []); ledgerByOrder.get(k).push(l); }
  }
  const manual = new Map(safeAll('SELECT * FROM manual_deliveries').map((m) => [Number(m.order_id), m]));
  const subs = new Map();
  for (const s of safeAll('SELECT * FROM chatgpt_subscriptions ORDER BY id')) { const k = Number(s.order_id); if (!subs.has(k)) subs.set(k, []); subs.get(k).push(s); }
  const cards = new Map(safeAll('SELECT * FROM cgb_admin_cards').map((c) => [Number(c.order_id), c]));
  const refunds = new Map(); for (const r of safeAll('SELECT * FROM refunds')) refunds.set(Number(r.order_id), r);
  const bep20 = new Map(safeAll('SELECT * FROM bep20_deposits').map((d) => [keyOf(d.tx_hash), d]));
  const usedTx = safeAll('SELECT * FROM used_txids ORDER BY created_at, id');
  const usedKeys = new Set(usedTx.map((u) => keyOf(u.txid)));

  const who = (uid) => {
    const u = users.get(Number(uid)) || {};
    if (anonymize) return { id: pseudonym(uid), username: '', name: '' };
    return { id: String(uid), username: u.username ? `@${u.username}` : '', name: clean([u.first_name, u.last_name].filter(Boolean).join(' ')) };
  };

  // ── per-order facts ────────────────────────────────────────────────────────
  const orderFacts = (o) => {
    const p = products.get(Number(o.product_id)) || {};
    const title = clean(p.title) || `product #${o.product_id}`;
    const ss = subs.get(Number(o.id)) || [];
    let duration = clean(p.warranty) ? `Warranty: ${clean(p.warranty)}` : '';
    if (ss.length) duration = ss.map((s) => `${s.days_remaining} days (${s.start_date} → ${s.end_date})`).join(' + ');
    // Delivery: a manual product is delivered when support presses it; a ChatGPT seat when it is activated;
    // everything else is delivered in the same atomic step as the payment.
    let delivered = '', deliveredHow = '';
    const md = manual.get(Number(o.id));
    if (md && md.delivered_at) { delivered = md.delivered_at; deliveredHow = 'manual (delivered by support)'; }
    else if (ss.length) {
      const active = ss.filter((s) => s.status === 'active');
      if (active.length) { delivered = active[active.length - 1].updated_at; deliveredHow = 'ChatGPT seat activated'; }
      else deliveredHow = 'ChatGPT seat not activated yet';
    } else if (o.status === 'delivered') { delivered = o.paid_at || ''; deliveredHow = 'automatic (at the moment of payment)'; }
    else if (md) deliveredHow = 'manual — not delivered yet';
    const card = cards.get(Number(o.id));
    return { title, qty: o.quantity, duration, delivered, deliveredHow, card: card ? `${card.chat_id}:${card.message_id}` : '' };
  };

  // ── payment events ─────────────────────────────────────────────────────────
  const events = [];
  const addEvent = (e) => events.push(e);

  for (const u of usedTx) {
    const k = keyOf(u.txid);
    const L = ledgerByRef.get(k) || [];
    const purchases = L.filter((l) => l.type === 'purchase' && l.order_id);
    const deposits = L.filter((l) => l.type === 'deposit');
    const linked = [...new Set(purchases.map((l) => Number(l.order_id)))].map((id) => orderById.get(id)).filter(Boolean);
    const bd = bep20.get(k);
    let kind, status, flag = '';
    if (linked.length) { kind = 'ORDER PAYMENT (direct)'; status = 'Verified on Binance — applied to the order'; }
    else if (deposits.length) { kind = 'WALLET TOP-UP'; status = 'Verified on Binance — credited to the customer\'s wallet'; }
    else { kind = 'VERIFIED, NO LEDGER ENTRY'; status = 'TXID verified and locked, but no credit/order entry was recorded (e.g. underpayment or handled by hand)'; flag = 'CHECK'; }
    addEvent({
      at: u.created_at, kind, userId: u.user_id, orders: linked, txid: u.txid, amount: round(u.amount), asset: u.asset || 'USDT',
      method: methodLabel(u.txid, u.network), receiver: receiverFor(u.network, u.address),
      sender: bd && bd.from_addr ? bd.from_addr : 'not recorded (Binance does not return the sender)',
      status, flag, credited: deposits.length ? round(deposits.reduce((n, l) => n + Number(l.amount), 0)) : '',
      sources: ['used_txids', L.length ? 'transactions' : null, linked.length ? 'orders' : null, bd ? 'bep20_deposits' : null].filter(Boolean).join(' + '),
    });
  }

  // Detected on Binance but never credited: held for review, or waiting for the customer to claim it.
  for (const r of safeAll('SELECT * FROM deposit_reviews ORDER BY id')) {
    if (usedKeys.has(keyOf(r.txid))) continue;
    addEvent({
      at: iso(r.insert_time) || r.created_at, kind: 'DETECTED, NOT CREDITED', userId: r.user_id, orders: [], txid: r.txid, amount: round(r.amount), asset: 'USDT',
      method: methodLabel(r.txid, r.network), receiver: receiverFor(r.network, r.address), sender: 'not recorded (Binance does not return the sender)',
      status: `Held for manual review: ${clean(r.reason) || '—'} (review status: ${r.status}${r.admin_note ? `; ${clean(r.admin_note)}` : ''})`, flag: r.status === 'pending' ? 'PENDING' : '', credited: '',
      sources: 'deposit_reviews',
    });
  }
  for (const d of safeAll('SELECT * FROM pending_deposits ORDER BY first_seen')) {
    if (usedKeys.has(keyOf(d.txid))) continue;
    addEvent({
      at: iso(d.insert_time) || d.first_seen, kind: 'DETECTED, NOT CREDITED', userId: d.user_id || '', orders: [], txid: d.txid, amount: round(d.amount), asset: 'USDT',
      method: methodLabel(d.txid, d.network), receiver: receiverFor(d.network, null), sender: 'not recorded (Binance does not return the sender)',
      status: 'Seen on Binance and submitted by the customer, but not credited yet (waiting to match a reservation)', flag: 'PENDING', credited: '', sources: 'pending_deposits',
    });
  }

  // Other gateways, so the report covers every order the store was paid for.
  // CryptoBot: the invoice row has the money (user, asset, amount, paid_at); the LEDGER ties it to an order or
  // a wallet top-up through ref_id = "cryptobot:<invoice id>".
  for (const c of safeAll('SELECT * FROM cryptobot_invoices ORDER BY id')) {
    if (!(c.paid_at || Number(c.credited) === 1 || /^paid$/i.test(String(c.status || '')))) continue;
    const L = ledgerByRef.get(keyOf(`cryptobot:${c.invoice_id}`)) || [];
    const linked = [...new Set(L.filter((l) => l.type === 'purchase' && l.order_id).map((l) => Number(l.order_id)))].map((id) => orderById.get(id)).filter(Boolean);
    const deposits = L.filter((l) => l.type === 'deposit');
    const kind = linked.length ? 'ORDER PAYMENT (direct)' : deposits.length ? 'WALLET TOP-UP' : 'VERIFIED, NO LEDGER ENTRY';
    addEvent({
      at: c.paid_at || c.created_at, kind, userId: c.user_id || c.telegram_user_id, orders: linked,
      txid: `CryptoBot invoice ${c.invoice_id}`, amount: round(c.paid_amount || c.amount), asset: c.paid_asset || c.asset || 'USDT', method: 'CryptoBot (Crypto Pay)',
      receiver: 'CryptoBot (shop account)', sender: 'not recorded', status: kind === 'VERIFIED, NO LEDGER ENTRY' ? 'Invoice paid, but no credit/order entry was recorded' : 'Paid (CryptoBot invoice)',
      flag: kind === 'VERIFIED, NO LEDGER ENTRY' ? 'CHECK' : '', credited: deposits.length ? round(deposits.reduce((n, l) => n + Number(l.amount), 0)) : '',
      sources: 'cryptobot_invoices' + (L.length ? ' + transactions' : '') + (linked.length ? ' + orders' : ''),
    });
  }
  for (const n of safeAll("SELECT * FROM nowpayments_invoices WHERE credited = 1 OR payment_status IN ('finished','confirmed') ORDER BY id")) {
    const oid = Number(n.order_id || n.related_order_id || 0);
    const o = oid ? orderById.get(oid) : null;
    addEvent({
      at: n.updated_at || n.created_at, kind: o ? 'ORDER PAYMENT (direct)' : 'WALLET TOP-UP', userId: n.telegram_user_id, orders: o ? [o] : [],
      txid: n.tx_hash || `NOWPayments invoice ${n.invoice_id}`, amount: round(n.amount), asset: 'USDT', method: 'NOWPayments',
      receiver: 'NOWPayments (shop account)', sender: 'not recorded', status: `Paid (NOWPayments: ${n.payment_status})`, flag: '', credited: '', sources: 'nowpayments_invoices' + (o ? ' + orders' : ''),
    });
  }
  for (const [k, d] of bep20) {
    if (usedKeys.has(k)) continue;
    addEvent({
      at: d.created_at, kind: 'ON-CHAIN DEPOSIT (legacy record)', userId: d.user_id, orders: [], txid: d.tx_hash, amount: round(d.amount), asset: d.currency || 'USDT',
      method: methodLabel(d.tx_hash, d.network || 'BEP20'), receiver: d.to_addr || receiverFor('BEP20', null), sender: d.from_addr || 'not recorded', status: `Recorded by the old on-chain watcher (${d.status})`,
      flag: '', credited: '', sources: 'bep20_deposits',
    });
  }

  // ── rows ───────────────────────────────────────────────────────────────────
  events.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const evs = events.filter((e) => inPeriod(e.at));

  const txColumns = [
    { header: '#', width: 6 }, { header: 'Date & time (UTC)', width: 20 }, { header: 'Record type', width: 24 },
    { header: 'Order ID(s)', width: 12 }, { header: 'User ID (Telegram)', width: 16 }, { header: 'Username', width: 18 }, { header: 'Name', width: 18 },
    { header: 'Product', width: 34, type: 'wrap' }, { header: 'Duration / warranty', width: 34, type: 'wrap' },
    { header: 'Amount', width: 12, type: 'amount' }, { header: 'Currency', width: 9 }, { header: 'Credited / applied', width: 12, type: 'amount' },
    { header: 'Payment method / network', width: 28 }, { header: 'TXID', width: 46 },
    { header: 'Receiver wallet', width: 44 }, { header: 'Sender wallet', width: 30 },
    { header: 'Payment status', width: 44, type: 'wrap' }, { header: 'Order status', width: 14 },
    { header: 'Delivery date (UTC)', width: 20 }, { header: 'Delivery', width: 26 },
    { header: 'Related message ID (chat:message)', width: 22 }, { header: 'Flag', width: 10 },
    { header: 'Reference chain (TXID → user → order → product → payment → delivery)', width: 90, type: 'wrap' },
    { header: 'Data source (tables)', width: 36 },
  ];
  const txRows = evs.map((e, i) => {
    const w = who(e.userId);
    const os = e.orders.map((o) => ({ o, f: orderFacts(o) }));
    const product = os.map(({ o, f }) => `#${o.id} ${f.title} ×${f.qty}`).join('\n') || '— (wallet top-up)';
    const duration = os.map(({ f }) => f.duration).filter(Boolean).join('\n');
    const delivery = os.map(({ f }) => f.delivered).filter(Boolean).join('\n');
    const how = os.map(({ f }) => f.deliveredHow).filter(Boolean).join('\n');
    const orderStatus = os.map(({ o }) => o.status).join(', ');
    const msg = os.map(({ f }) => f.card).filter(Boolean).join('\n') || 'not stored';
    const chain = `TXID ${String(e.txid).length > 22 ? String(e.txid).slice(0, 10) + '…' + String(e.txid).slice(-8) : e.txid}` +
      ` → user ${w.id}${w.username ? ` (${w.username})` : ''}` +
      (os.length ? ` → order ${os.map(({ o }) => '#' + o.id).join(', ')} → ${os.map(({ f }) => f.title).join(' / ')}` : ' → wallet balance') +
      ` → ${e.amount} ${e.asset} via ${e.method}` +
      (os.length ? ` → ${delivery ? `delivered ${delivery.split('\n')[0]}` : (how || 'not delivered yet')}` : '');
    return [i + 1, e.at, e.kind, os.map(({ o }) => o.id).join(', '), w.id, w.username, w.name, product, duration, e.amount, e.asset, e.credited,
      e.method, e.txid, e.receiver, e.sender, e.status, orderStatus, delivery, how, msg, e.flag, chain, e.sources];
  });

  // Orders (every order, with what funded it)
  const orderColumns = [
    { header: '#', width: 6 }, { header: 'Order ID', width: 10 }, { header: 'Created (UTC)', width: 20 }, { header: 'Paid (UTC)', width: 20 },
    { header: 'User ID (Telegram)', width: 16 }, { header: 'Username', width: 18 }, { header: 'Product', width: 34, type: 'wrap' }, { header: 'Duration / warranty', width: 34, type: 'wrap' },
    { header: 'Qty', width: 6 }, { header: 'Total', width: 12, type: 'amount' }, { header: 'Currency', width: 9 }, { header: 'Payment method (as stored)', width: 22 },
    { header: 'Funded by', width: 26 }, { header: 'TXID', width: 46 }, { header: 'Order status', width: 14 }, { header: 'Refund', width: 16 },
    { header: 'Delivery date (UTC)', width: 20 }, { header: 'Delivery', width: 30 }, { header: 'Related message ID (chat:message)', width: 22 }, { header: 'Created via', width: 12 }, { header: 'Data source (tables)', width: 36 },
  ];
  const ords = orders.filter((o) => inPeriod(o.created_at));
  const cryptoByOrder = new Map();            // order id → CryptoBot invoice id (from the ledger reference)
  for (const l of ledger) if (l.type === 'purchase' && l.order_id && /^cryptobot:/i.test(String(l.ref_id || ''))) cryptoByOrder.set(Number(l.order_id), String(l.ref_id).slice(10));
  const nowByOrder = new Map();
  for (const n of safeAll("SELECT * FROM nowpayments_invoices WHERE credited = 1 OR payment_status IN ('finished','confirmed')")) nowByOrder.set(Number(n.order_id || n.related_order_id || 0), n);
  const orderRows = ords.map((o, i) => {
    const f = orderFacts(o); const w = who(o.user_id);
    const L = (ledgerByOrder.get(Number(o.id)) || []).filter((l) => l.type === 'purchase' && l.ref_id && usedKeys.has(keyOf(l.ref_id)));
    let funded, txid = '';
    if (L.length) { funded = 'Direct payment (TXID verified)'; txid = L[0].ref_id; }
    else if (cryptoByOrder.has(Number(o.id))) { funded = 'CryptoBot invoice'; txid = `CryptoBot invoice ${cryptoByOrder.get(Number(o.id))}`; }
    else if (nowByOrder.has(Number(o.id))) { funded = 'NOWPayments'; txid = nowByOrder.get(Number(o.id)).tx_hash || ''; }
    else if (/wallet/i.test(o.payment_method || '')) funded = 'Wallet balance (see sheet "Per user")';
    else funded = o.payment_method ? `${o.payment_method} (no payment record found)` : '—';
    const rf = refunds.get(Number(o.id));
    return [i + 1, o.id, o.created_at, o.paid_at || '', w.id, w.username, f.title, f.duration, o.quantity, round(o.total_price), 'USDT', o.payment_method || '',
      funded, txid, o.status, rf ? `${rf.status}: ${round(rf.refund_amount)}` : '', f.delivered, f.deliveredHow, f.card || 'not stored', o.source || 'bot',
      ['orders', 'products', 'users', L.length ? 'transactions + used_txids' : null, manual.has(Number(o.id)) ? 'manual_deliveries' : null, subs.has(Number(o.id)) ? 'chatgpt_subscriptions' : null, cards.has(Number(o.id)) ? 'cgb_admin_cards' : null].filter(Boolean).join(' + ')];
  });

  // Per user
  const perUser = new Map();
  const U = (id) => { const k = String(id); if (!perUser.has(k)) perUser.set(k, { id, dep: 0, depN: 0, direct: 0, directN: 0, wallet: 0, walletN: 0, refund: 0 }); return perUser.get(k); };
  for (const e of evs) {
    if (!e.userId) continue;
    if (e.kind === 'WALLET TOP-UP') { const u = U(e.userId); u.dep += e.amount; u.depN++; }
    else if (e.kind === 'ORDER PAYMENT (direct)') { const u = U(e.userId); u.direct += e.amount; u.directN++; }
  }
  for (const o of ords) {
    if (!['delivered', 'completed'].includes(o.status) && !o.paid_at) continue;
    if (/wallet/i.test(o.payment_method || '')) { const u = U(o.user_id); u.wallet += Number(o.total_price) || 0; u.walletN++; }
  }
  for (const r of safeAll('SELECT user_id, SUM(amount) AS s FROM transactions WHERE type = \'refund\' GROUP BY user_id')) { if (perUser.has(String(r.user_id))) perUser.get(String(r.user_id)).refund = round(r.s); }
  const userColumns = [
    { header: 'User ID (Telegram)', width: 18 }, { header: 'Username', width: 18 }, { header: 'Name', width: 20 },
    { header: 'Top-ups (count)', width: 12 }, { header: 'Top-ups (USDT)', width: 14, type: 'amount' },
    { header: 'Direct order payments (count)', width: 16 }, { header: 'Direct order payments (USDT)', width: 16, type: 'amount' },
    { header: 'Orders paid from wallet (count)', width: 16 }, { header: 'Orders paid from wallet (USDT)', width: 16, type: 'amount' },
    { header: 'Refunded to wallet (USDT)', width: 16, type: 'amount' }, { header: 'Wallet balance now (USDT)', width: 16, type: 'amount' },
  ];
  const userRows = [...perUser.values()].sort((a, b) => (b.dep + b.direct) - (a.dep + a.direct)).map((u) => {
    const w = who(u.id);
    return [w.id, w.username, w.name, u.depN, round(u.dep), u.directN, round(u.direct), u.walletN, round(u.wallet), u.refund, round((users.get(Number(u.id)) || {}).balance || 0)];
  });

  // Wallet credits that came with no TXID (admin, referral, refund...): they explain balances, they are not payments.
  const credCols = [{ header: 'Date & time (UTC)', width: 20 }, { header: 'User ID (Telegram)', width: 18 }, { header: 'Username', width: 18 }, { header: 'Type', width: 18 }, { header: 'Amount', width: 12, type: 'amount' }, { header: 'Description', width: 60 }, { header: 'Reference', width: 30 }];
  const credRows = ledger
    .filter((l) => inPeriod(l.created_at) && Number(l.amount) > 0 && l.type !== 'purchase' && !(l.type === 'deposit' && l.ref_id && usedKeys.has(keyOf(l.ref_id))))
    .map((l) => { const w = who(l.user_id); return [l.created_at, w.id, w.username, l.type, round(l.amount), clean(l.description), l.ref_id || '']; });

  // Summary
  const sumBy = (arr, f) => arr.reduce((n, x) => n + f(x), 0);
  const byMethod = new Map();
  for (const e of evs) { const m = e.method; if (!byMethod.has(m)) byMethod.set(m, { n: 0, s: 0 }); const r = byMethod.get(m); r.n++; r.s += e.amount; }
  const flagged = evs.filter((e) => e.flag);
  const delivered = ords.filter((o) => o.status === 'delivered');
  const first = evs.length ? evs[0].at : '', last = evs.length ? evs[evs.length - 1].at : '';
  const summary = [
    ['Report generated (UTC)', generatedAt], ['Period', fromDate ? `from ${fromDate} on` : 'all time'], ['Users shown as', anonymize ? 'anonymous codes (U-xxxxxx)' : 'Telegram ID, username and name'],
    ['First payment in the report (UTC)', first], ['Last payment in the report (UTC)', last], ['', ''],
    ['PAYMENTS', ''], ['Payment records', evs.length], ['Total amount of those records (USDT)', round(sumBy(evs, (e) => e.amount), 2)],
    ['  of which wallet top-ups', evs.filter((e) => e.kind === 'WALLET TOP-UP').length], ['  of which direct order payments', evs.filter((e) => e.kind === 'ORDER PAYMENT (direct)').length],
    ['  detected on Binance but not credited', evs.filter((e) => e.kind === 'DETECTED, NOT CREDITED').length],
    ['Distinct paying users', new Set(evs.map((e) => e.userId).filter(Boolean).map(String)).size], ['', ''],
    ['BY PAYMENT METHOD', 'records · USDT'], ...[...byMethod.entries()].sort((a, b) => b[1].s - a[1].s).map(([m, r]) => [`  ${m}`, `${r.n} · ${round(r.s, 2)}`]), ['', ''],
    ['ORDERS', ''], ['Orders in the period', ords.length], ['  delivered', delivered.length], ['  other statuses', ords.length - delivered.length],
    ['Sales value of delivered orders (USDT)', round(sumBy(delivered, (o) => Number(o.total_price) || 0), 2)],
    ['  paid from wallet balance', delivered.filter((o) => /wallet/i.test(o.payment_method || '')).length], ['  paid directly', delivered.filter((o) => !/wallet/i.test(o.payment_method || '')).length], ['', ''],
    ['THINGS TO LOOK AT', ''], ['Payments flagged CHECK / PENDING in the sheet "Transactions"', flagged.length],
    ['Wallet credits that have no TXID (sheet "Credits without TXID")', credRows.length],
  ];
  const notes = [
    ['What this report is', 'Read from the store\'s own database. Every link between a TXID, a user, an order and a delivery comes from a record written at the time of the payment; nothing is estimated.'],
    ['Times', 'UTC, from the database clock. Seconds are as recorded.'],
    ['TXID', 'Blockchain hash for on-chain deposits; "Off-chain transfer <number>" for a transfer between two Binance accounts (it has no hash); the Binance Pay order id for Binance Pay.'],
    ['Receiver wallet', 'The deposit address Binance reported when the payment was verified. When the record has none, the shop\'s configured address for that network is shown, or "Binance Pay / Binance (shop account)".'],
    ['Sender wallet', 'NOT recorded. Binance\'s deposit API does not return the sender, and the store does not keep it. Only the old on-chain watcher stored it (shown when present).'],
    ['Wallet top-up vs direct payment', 'A TXID either topped up a customer\'s wallet, or paid an order directly. A wallet top-up later spent on orders is linked through the user (sheet "Per user" and the orders paid "from wallet balance"); the database does not tie one top-up to one purchase.'],
    ['Delivery date', 'Automatic products are delivered in the same step as the payment, so the delivery time is the payment time. Manual products: when support delivered them. ChatGPT seats: when the seat was activated (last update of the seat).'],
    ['Related message ID', 'Only the ChatGPT admin card of an order keeps its Telegram message id (chat:message). Other orders: "not stored".'],
    ['Flags', 'CHECK = a TXID was verified but no credit/order entry exists (e.g. underpayment). PENDING = detected on Binance and waiting for review or a claim.'],
    ['Customer data', anonymize ? 'Users are shown as anonymous codes; the same user has the same code everywhere.' : 'Contains Telegram IDs, usernames and names of customers: share only what the exchange asks for.'],
    ['Emails', 'Customer emails are left out of this report on purpose.'],
  ];

  return {
    generatedAt, anonymize, fromDate,
    counts: { payments: evs.length, orders: ords.length, flagged: flagged.length },
    txColumns, txRows, orderColumns, orderRows, userColumns, userRows, credCols, credRows, summary, notes,
  };
}

function toCsv(columns, rows) {
  const q = (v) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return '\uFEFF' + [columns.map((c) => q(c.header)).join(','), ...rows.map((r) => r.map(q).join(','))].join('\r\n') + '\r\n';
}

/** @returns {{xlsx:Buffer, csv:Buffer, report:object}} */
function buildFiles(opts = {}) {
  const report = buildReport(opts);
  const xlsx = buildXlsx([
    { name: 'Summary', columns: [{ header: 'Item', width: 56, type: 'bold' }, { header: 'Value', width: 40 }], rows: report.summary },
    { name: 'Transactions', columns: report.txColumns, rows: report.txRows },
    { name: 'Orders', columns: report.orderColumns, rows: report.orderRows },
    { name: 'Per user', columns: report.userColumns, rows: report.userRows },
    { name: 'Credits without TXID', columns: report.credCols, rows: report.credRows },
    { name: 'Notes', columns: [{ header: 'Topic', width: 30, type: 'bold' }, { header: 'Explanation', width: 120, type: 'wrap' }], rows: report.notes },
  ]);
  return { xlsx, csv: Buffer.from(toCsv(report.txColumns, report.txRows), 'utf8'), report };
}


/**
 * THE BINANCE REPORT — only what Binance's verification needs, one row per Binance payment:
 *   TXID · user · product · time · price
 * Binance payments = every payment the bot verified on Binance (used_txids): on-chain, off-chain and Binance
 * Pay. CryptoBot / NOWPayments payments, orders paid from the wallet, and deposits that were seen but never
 * credited are NOT Binance transactions of the shop and are left out (their number is reported).
 * A top-up has no product: it says "Wallet top-up". Times are UTC.
 */
function buildBinanceReport({ anonymize = false, fromDate = null } = {}) {
  const inPeriod = (dt) => !fromDate || day(dt) >= fromDate;
  const users = new Map(safeAll('SELECT telegram_id, username FROM users').map((u) => [Number(u.telegram_id), u]));
  const products = new Map(safeAll('SELECT id, title FROM products').map((p) => [Number(p.id), p]));
  const orderById = new Map(safeAll('SELECT id, product_id, quantity FROM orders').map((o) => [Number(o.id), o]));
  const ledgerByRef = new Map();
  for (const l of safeAll("SELECT ref_id, type, order_id FROM transactions WHERE ref_id IS NOT NULL AND ref_id <> ''")) {
    const k = keyOf(l.ref_id); if (!ledgerByRef.has(k)) ledgerByRef.set(k, []); ledgerByRef.get(k).push(l);
  }
  const used = safeAll('SELECT * FROM used_txids ORDER BY created_at, id');
  const usedKeys = new Set(used.map((u) => keyOf(u.txid)));

  const rows = [];
  let total = 0;
  for (const u of used) {
    if (!inPeriod(u.created_at)) continue;
    const L = ledgerByRef.get(keyOf(u.txid)) || [];
    const orders = [...new Set(L.filter((l) => l.type === 'purchase' && l.order_id).map((l) => Number(l.order_id)))].map((id) => orderById.get(id)).filter(Boolean);
    const product = orders.length
      ? orders.map((o) => `${clean((products.get(Number(o.product_id)) || {}).title) || `product #${o.product_id}`} ×${o.quantity}`).join('\n')
      : (L.some((l) => l.type === 'deposit') ? 'Wallet top-up' : '— (no order or credit recorded)');
    const uid = Number(u.user_id);
    const un = (users.get(uid) || {}).username;
    const amount = round(u.amount);
    total += amount;
    rows.push([rows.length + 1, u.created_at, u.txid, anonymize ? pseudonym(uid) : String(uid), anonymize ? '' : (un ? `@${un}` : ''), product, amount]);
  }
  // Seen on Binance but never credited: not a completed payment, so not in the table — but never hidden.
  const skipped = safeAll('SELECT txid, insert_time, created_at FROM deposit_reviews').filter((r) => !usedKeys.has(keyOf(r.txid)) && inPeriod(iso(r.insert_time) || r.created_at)).length
    + safeAll('SELECT txid, insert_time, first_seen FROM pending_deposits').filter((d) => !usedKeys.has(keyOf(d.txid)) && inPeriod(iso(d.insert_time) || d.first_seen)).length;

  const columns = [
    { header: '#', width: 6 }, { header: 'Date & time (UTC)', width: 20 }, { header: 'TXID', width: 66 },
    { header: 'User ID', width: 16 }, { header: 'Username', width: 20 }, { header: 'Product', width: 40, type: 'wrap' },
    { header: 'Price (USDT)', width: 14, type: 'exact' },
  ];
  return { columns, rows, counts: { payments: rows.length, total: round(total, 6), skipped }, anonymize, fromDate };
}

function buildBinanceFiles(opts = {}) {
  const report = buildBinanceReport(opts);
  const xlsx = buildXlsx([{ name: 'Binance transactions', columns: report.columns, rows: report.rows }]);
  return { xlsx, csv: Buffer.from(toCsv(report.columns, report.rows), 'utf8'), report };
}

module.exports = { buildReport, buildFiles, buildBinanceReport, buildBinanceFiles, toCsv, keyOf, pseudonym };
