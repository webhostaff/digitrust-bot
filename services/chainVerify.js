'use strict';
/**
 * V167 — USDT deposit verification straight from the blockchain (no Binance, no third-party gateway).
 *
 * The customer sends USDT to the shop's own wallet (e.g. Trust Wallet) and gives us the TxID.
 * We read that transaction from a public node and check, ourselves:
 *   · it succeeded, · it is a USDT transfer (the real USDT contract / mint), · the receiver is OUR address,
 *   · the amount, · the time, · it has enough confirmations.
 *
 * Networks: TRC20 (Tron) · ERC20 (Ethereum) · BEP20 (BNB Smart Chain) · SOL (Solana).
 *
 * verifyDeposit(txid, opts) answers in the SAME shape binance.verifyDepositByTxId used, so every caller
 * (orders, wallet top-ups, reservations, used-txid table) works unchanged:
 *   { found:true, amount, network, asset:'USDT', address, txid, insertTime, tooOld, tooOldMinutes, maxAgeMinutes }
 *   { found:false, reason, message }
 *
 * Public nodes are free but rate-limited; every endpoint can be replaced with a private one through env vars
 * (BSC_RPC_URL, ETH_RPC_URL, SOLANA_RPC_URL, TRON_API_URL + TRONGRID_API_KEY).
 */

const crypto = require('crypto');
const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');

const TIMEOUT = 15000;
const TRANSFER_SIG = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// ── tiny base58 (Tron addresses / Solana signatures) ───────────────────────────────────────────
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58decode(s) {
  let n = 0n;
  for (const ch of String(s)) {
    const i = B58.indexOf(ch);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  let hex = n.toString(16); if (hex.length % 2) hex = `0${hex}`;
  const lead = (String(s).match(/^1*/) || [''])[0].length;
  return Buffer.concat([Buffer.alloc(lead), n === 0n ? Buffer.alloc(0) : Buffer.from(hex, 'hex')]);
}
/** Tron base58 address → its 20 raw bytes as hex (what logs carry), or null when the checksum is wrong. */
function tronHex(addr) {
  const b = b58decode(addr);
  if (!b || b.length !== 25 || b[0] !== 0x41) return null;
  const sum = crypto.createHash('sha256').update(crypto.createHash('sha256').update(b.subarray(0, 21)).digest()).digest();
  if (!sum.subarray(0, 4).equals(b.subarray(21))) return null;
  return b.subarray(1, 21).toString('hex');
}

// ── what we check, per network ────────────────────────────────────────────────────────────────
const env = (k, d) => (process.env[k] || d);
function networks() {
  return {
    BEP20: { kind: 'evm', label: 'BEP20', name: 'BNB Smart Chain', rpc: env('BSC_RPC_URL', 'https://bsc-dataseed.binance.org'),
             usdt: '0x55d398326f99059ff775485246999027b3197955', decimals: 18, minConf: Number(env('BSC_MIN_CONF', 12)), addr: config.usdtBep20Address },
    ERC20: { kind: 'evm', label: 'ERC20', name: 'Ethereum', rpc: env('ETH_RPC_URL', 'https://ethereum-rpc.publicnode.com'),
             usdt: '0xdac17f958d2ee523a2206206994597c13d831ec7', decimals: 6, minConf: Number(env('ETH_MIN_CONF', 12)), addr: config.usdtErc20Address },
    TRC20: { kind: 'tron', label: 'TRC20', name: 'TRON', api: env('TRON_API_URL', 'https://api.trongrid.io'), key: process.env.TRONGRID_API_KEY || '',
             usdt: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', decimals: 6, addr: config.usdtTrc20Address },
    TON:   { kind: 'ton', label: 'TON', name: 'The Open Network', api: env('TON_API_URL', 'https://toncenter.com'), key: process.env.TONCENTER_API_KEY || '',
             master: 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs', decimals: 6, addr: config.usdtTonAddress },
    SOL:   { kind: 'sol', label: 'SOL', name: 'Solana', rpc: env('SOLANA_RPC_URL', 'https://api.mainnet-beta.solana.com'),
             mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', decimals: 6, addr: config.usdtSolAddress },
  };
}
const configured = (n) => !!(n.addr && String(n.addr).trim());

// ── http (replaceable in tests) ───────────────────────────────────────────────────────────────
let http = {
  get: (url, headers, params) => axios.get(url, { timeout: TIMEOUT, headers: headers || {}, params }).then((r) => r.data),
  post: (url, body, headers) => axios.post(url, body, { timeout: TIMEOUT, headers: headers || {} }).then((r) => r.data),
};
function _setHttp(h) { http = h; }

const rpc = (url, method, params) => http.post(url, { jsonrpc: '2.0', id: 1, method, params }).then((d) => {
  if (d && d.error) throw new Error(`${method}: ${d.error.message || JSON.stringify(d.error)}`);
  return d ? d.result : null;
});

const fail = (reason, message, extra = {}) => ({ found: false, reason, message, ...extra });
const pendingMsg = (n, have, need) =>
  `⏳ <b>Transfer found — waiting for confirmations.</b>\n\n🌐 Network: ${n.label} (${n.name})\n` +
  (need ? `✅ Confirmations: ${have} / ${need}\n\n` : '\n') + 'Send the TxID again in a minute or two.';
const notFoundMsg = (names) =>
  '⏳ <b>This transaction is not visible on the blockchain yet.</b>\n\n' +
  `Checked: ${names.join(', ')}.\nWait a minute or two after sending and send the TxID again. ` +
  'Check that you copied the whole TxID.';

// ── EVM (BSC / Ethereum) ──────────────────────────────────────────────────────────────────────
async function checkEvm(n, txid) {
  const rc = await rpc(n.rpc, 'eth_getTransactionReceipt', [txid]);
  if (!rc) return { state: 'none' };
  if (rc.status !== '0x1') return { state: 'failed' };
  const ours = String(n.addr).toLowerCase().replace(/^0x/, '');
  let total = 0n, sawUsdt = false;
  for (const lg of rc.logs || []) {
    if (String(lg.address).toLowerCase() !== n.usdt) continue;
    if (!lg.topics || lg.topics.length < 3 || String(lg.topics[0]).toLowerCase().replace(/^0x/, '') !== TRANSFER_SIG) continue;
    sawUsdt = true;
    if (String(lg.topics[2]).toLowerCase().slice(-40) === ours) total += BigInt(lg.data || '0x0');
  }
  if (!sawUsdt) return { state: 'wrong_coin' };
  if (total === 0n) return { state: 'wrong_address' };
  const [head, blk] = await Promise.all([rpc(n.rpc, 'eth_blockNumber', []), rpc(n.rpc, 'eth_getBlockByNumber', [rc.blockNumber, false])]);
  const conf = parseInt(head, 16) - parseInt(rc.blockNumber, 16) + 1;
  return {
    state: 'ok', amount: Number(total) / 10 ** n.decimals, confirmations: conf, needed: n.minConf,
    time: blk && blk.timestamp ? parseInt(blk.timestamp, 16) * 1000 : null,
  };
}

// ── Tron ──────────────────────────────────────────────────────────────────────────────────────
async function checkTron(n, txid) {
  const hdr = n.key ? { 'TRON-PRO-API-KEY': n.key } : {};
  const ours = tronHex(n.addr);
  if (!ours) throw new Error('USDT_TRC20_ADDRESS is not a valid Tron address');
  const usdtHex = tronHex(n.usdt);
  const base = String(n.api).replace(/\/$/, '');
  // solidity node = only irreversible (confirmed) transactions
  const solid = await http.post(`${base}/walletsolidity/gettransactioninfobyid`, { value: txid }, hdr);
  let info = solid && solid.id ? solid : null;
  let confirmed = !!info;
  if (!info) {
    const full = await http.post(`${base}/wallet/gettransactioninfobyid`, { value: txid }, hdr);
    if (!full || !full.id) return { state: 'none' };
    info = full;
  }
  if (info.receipt && info.receipt.result && info.receipt.result !== 'SUCCESS') return { state: 'failed' };
  let total = 0n, sawUsdt = false;
  for (const lg of info.log || []) {
    if (String(lg.address).toLowerCase().replace(/^41/, '') !== usdtHex) continue;
    if (!lg.topics || lg.topics.length < 3 || String(lg.topics[0]).toLowerCase() !== TRANSFER_SIG) continue;
    sawUsdt = true;
    if (String(lg.topics[2]).toLowerCase().slice(-40) === ours) total += BigInt(`0x${lg.data || '0'}`);
  }
  if (!sawUsdt) return { state: 'wrong_coin' };
  if (total === 0n) return { state: 'wrong_address' };
  return { state: 'ok', amount: Number(total) / 10 ** n.decimals, confirmations: confirmed ? 1 : 0, needed: 1, time: info.blockTimeStamp || null };
}

// ── TON (USDT jetton) ────────────────────────────────────────────────────────────────────────
/** TON friendly address (EQ…/UQ…) → "0:<hex>" raw form, or null. */
function tonRaw(addr) {
  try {
    const b = Buffer.from(String(addr).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (b.length !== 36) return null;
    return `${b[1] === 0xff ? -1 : b[1]}:${b.subarray(2, 34).toString('hex')}`;
  } catch (_) { return null; }
}
/** A TON hash in any spelling (hex, base64, base64url) → 64-char hex, or null. */
function tonHashHex(h) {
  const v = String(h || '').trim();
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(v)) return v.replace(/^0x/, '').toLowerCase();
  if (/^[A-Za-z0-9+/_-]{43,44}={0,2}$/.test(v)) {
    const x = Buffer.from(v.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('hex');
    return x.length === 64 ? x : null;
  }
  return null;
}
async function checkTon(n, txid, opts = {}) {
  const hdr = n.key ? { 'X-API-Key': n.key } : {};
  const since = Math.floor(Date.now() / 1000) - 48 * 3600;
  const d = await http.get(`${String(n.api).replace(/\/$/, '')}/api/v3/jetton/transfers`, hdr,
    { owner_address: n.addr, jetton_master: n.master, direction: 'in', start_utime: since, limit: 100, sort: 'desc' });
  const list = (d && d.jetton_transfers) || [];
  const wanted = tonHashHex(txid);
  const masterRaw = tonRaw(n.master);
  const mk = (t) => ({ state: 'ok', amount: Number(t.amount) / 10 ** n.decimals, confirmations: 1, needed: 1, time: t.transaction_now ? t.transaction_now * 1000 : null, hash: tonHashHex(t.transaction_hash) });
  const good = list.filter((t) => !t.jetton_master || !masterRaw || String(t.jetton_master).toLowerCase() === masterRaw);
  let t = wanted && good.find((x) => tonHashHex(x.transaction_hash) === wanted);
  if (t) return t.transaction_aborted ? { state: 'failed' } : mk(t);

  // The wallet shows the MESSAGE hash, the chain records the TRANSACTION hash: they differ, so a hash that matches
  // nothing is looked for by the customer's own reserved amount (the reservation is what proves it is theirs).
  if (opts.userId) {
    try {
      const q = require('../database/queries');
      for (const x of good) {
        if (x.transaction_aborted) continue;
        const h = tonHashHex(x.transaction_hash);
        if (h && q.isTxidUsed(h)) continue;
        const amt = Number(x.amount) / 10 ** n.decimals;
        const intent = q.findIntentForDeposit ? q.findIntentForDeposit('TON', amt) : null;
        if (intent && Number(intent.user_id) === Number(opts.userId)) { logger.info(`[CHAIN] TON matched by reserved amount ${amt} (intent #${intent.id})`); return mk(x); }
      }
    } catch (e) { logger.warn(`[CHAIN] TON amount fallback failed: ${e.message}`); }
  }
  return { state: 'none' };
}

// ── Solana ────────────────────────────────────────────────────────────────────────────────────
async function checkSol(n, sig) {
  const get = (commitment) => rpc(n.rpc, 'getTransaction', [sig, { encoding: 'jsonParsed', commitment, maxSupportedTransactionVersion: 0 }]);
  let tx = await get('finalized');
  let confirmed = !!tx;
  if (!tx) { tx = await get('confirmed'); if (!tx) return { state: 'none' }; }
  if (tx.meta && tx.meta.err) return { state: 'failed' };
  const bal = (arr) => (arr || []).filter((b) => b.mint === n.mint && b.owner === n.addr);
  const post = bal(tx.meta && tx.meta.postTokenBalances), pre = bal(tx.meta && tx.meta.preTokenBalances);
  const anyUsdt = [...(tx.meta.postTokenBalances || []), ...(tx.meta.preTokenBalances || [])].some((b) => b.mint === n.mint);
  if (!anyUsdt) return { state: 'wrong_coin' };
  const sum = (a) => a.reduce((s, b) => s + BigInt((b.uiTokenAmount && b.uiTokenAmount.amount) || '0'), 0n);
  const delta = sum(post) - sum(pre);
  if (delta <= 0n) return { state: 'wrong_address' };
  return { state: 'ok', amount: Number(delta) / 10 ** n.decimals, confirmations: confirmed ? 1 : 0, needed: 1, time: tx.blockTime ? tx.blockTime * 1000 : null };
}

/** Which networks could this TxID belong to? */
function candidates(raw) {
  const t = String(raw || '').trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(t)) return { txid: t.toLowerCase(), nets: ['BEP20', 'ERC20'] };
  if (/^[0-9a-fA-F]{64}$/.test(t)) return { txid: t.toLowerCase(), nets: ['TRC20', 'TON'] };   // a TON hash looks the same as a Tron one
  if (/^[A-Za-z0-9+/_-]{43,44}={0,2}$/.test(t)) return { txid: t, nets: ['TON'] };
  if (/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(t)) return { txid: t, nets: ['SOL'] };
  return null;
}
const isChainTxid = (raw) => !!candidates(raw);

const RUN = { evm: checkEvm, tron: checkTron, sol: checkSol, ton: checkTon };

async function verifyDepositInner(rawTxid, opts = {}) {
  const maxAgeMinutes = Number(opts.maxAgeMinutes) > 0 ? Number(opts.maxAgeMinutes) : 0;
  const c = candidates(rawTxid);
  if (!c) return fail('invalid_format', '❌ Invalid TxID format. Please copy the whole transaction hash and resend.');

  const all = networks();
  const nets = c.nets.map((k) => all[k]).filter(configured);
  if (!nets.length) return fail('not_configured', '❌ This network is not available for payment right now. Please choose another one or contact support.');

  const seen = [];
  let hit = null, pending = null, apiError = null;
  await Promise.all(nets.map(async (n) => {
    try {
      const r = await RUN[n.kind](n, c.txid, opts);
      seen.push(`${n.label}`);
      if (r.state === 'none') return;
      r.n = n;
      if (r.state === 'ok') {
        if (r.confirmations < r.needed) { pending = pending || r; return; }
        hit = hit || r;
      } else hit = hit || r;
    } catch (e) {
      logger.warn(`[CHAIN] ${n.label} lookup failed: ${e.message}`);
      apiError = e;
    }
  }));

  if (hit && hit.state !== 'ok') {
    const n = hit.n;
    if (hit.state === 'failed') return fail('failed', `❌ This transaction failed on ${n.name}; no money moved.`);
    if (hit.state === 'wrong_coin') return fail('wrong_coin', `❌ This transaction on ${n.name} is not a USDT transfer. Only USDT (${n.label}) is accepted.`);
    return fail('wrong_address', `❌ This transfer was not sent to our ${n.label} address. Please send to the official address only.`);
  }
  if (!hit) {
    if (pending) return fail('pending', pendingMsg(pending.n, pending.confirmations, pending.needed), { amount: pending.amount, network: pending.n.label, txid: c.txid });
    if (apiError && !seen.length) return fail('api_error', '⚠️ Could not reach the blockchain right now. Please try again in a moment.');
    return fail('not_found', notFoundMsg(nets.map((n) => n.label)));
  }

  // the shop started accepting payments at a set moment: nothing older counts
  let tooOld = false, tooOldMinutes = 0;
  try {
    const cutoff = parseInt(require('../database/queries').getSetting('deposit_cutoff_ms', '0'), 10);
    if (cutoff > 0 && hit.time && hit.time < cutoff) return fail('too_old', '❌ <b>This deposit is too old.</b>\n\nOnly deposits made after the bot was activated can be credited.');
  } catch (_) { /* no settings table in tests */ }
  if (maxAgeMinutes > 0 && hit.time) {
    const age = Date.now() - hit.time;
    if (age < -5 * 60 * 1000) return fail('bad_timestamp', '❌ Could not validate this deposit. Please contact support.');
    if (age > maxAgeMinutes * 60 * 1000) { tooOld = true; tooOldMinutes = Math.round(age / 60000); }
  }
  if (!Number.isFinite(hit.amount) || hit.amount <= 0) return fail('api_error', 'Unexpected amount on the blockchain. Please contact support.');

  return {
    found: true, amount: hit.amount, network: hit.n.label, asset: 'USDT', address: hit.n.addr, txid: hit.hash || c.txid,
    insertTime: hit.time || null, confirmations: hit.confirmations, tooOld, tooOldMinutes, maxAgeMinutes,
  };
}


// ── automatic detection: the recent USDT that arrived at our address, per network ─────────────
/**
 * recentIncoming('BEP20', sinceMs) → [{ txid, amount, time, address, network }]
 * Used by the wallet watcher so a customer who sends the exact reserved amount is credited without a TxID.
 * Only CONFIRMED transfers are returned.
 */
async function recentIncoming(key, sinceMs) {
  const n = networks()[key];
  if (!n || !configured(n)) return [];
  const out = [];
  const push = (txid, amount, time) => { if (txid && Number.isFinite(amount) && amount > 0) out.push({ txid, amount: Math.round(amount * 1e6) / 1e6, time, address: n.addr, network: key }); };

  if (n.kind === 'evm') {
    const head = parseInt(await rpc(n.rpc, 'eth_blockNumber', []), 16);
    const span = Number(env(`${key}_SCAN_BLOCKS`, key === 'BEP20' ? 4800 : 300));        // public nodes cap getLogs ranges
    const logs = await rpc(n.rpc, 'eth_getLogs', [{
      address: n.usdt, fromBlock: `0x${Math.max(0, head - span).toString(16)}`, toBlock: 'latest',
      topics: [`0x${TRANSFER_SIG}`, null, `0x${String(n.addr).toLowerCase().replace(/^0x/, '').padStart(64, '0')}`],
    }]);
    const blockTimes = new Map();
    for (const lg of logs || []) {
      const bn = parseInt(lg.blockNumber, 16);
      if (head - bn + 1 < n.minConf) continue;
      if (!blockTimes.has(lg.blockNumber)) { const b = await rpc(n.rpc, 'eth_getBlockByNumber', [lg.blockNumber, false]); blockTimes.set(lg.blockNumber, b && b.timestamp ? parseInt(b.timestamp, 16) * 1000 : null); }
      const t = blockTimes.get(lg.blockNumber);
      if (t && t < sinceMs) continue;
      push(lg.transactionHash, Number(BigInt(lg.data || '0x0')) / 10 ** n.decimals, t);
    }
  } else if (n.kind === 'tron') {
    const d = await http.get(`${String(n.api).replace(/\/$/, '')}/v1/accounts/${n.addr}/transactions/trc20`, n.key ? { 'TRON-PRO-API-KEY': n.key } : {},
      { only_to: true, only_confirmed: true, contract_address: n.usdt, min_timestamp: sinceMs, limit: 50 });
    for (const t of (d && d.data) || []) {
      if (t.token_info && t.token_info.address && t.token_info.address !== n.usdt) continue;
      push(t.transaction_id, Number(t.value) / 10 ** ((t.token_info && Number(t.token_info.decimals)) || n.decimals), t.block_timestamp);
    }
  } else if (n.kind === 'ton') {
    const d = await http.get(`${String(n.api).replace(/\/$/, '')}/api/v3/jetton/transfers`, n.key ? { 'X-API-Key': n.key } : {},
      { owner_address: n.addr, jetton_master: n.master, direction: 'in', start_utime: Math.floor(sinceMs / 1000), limit: 50, sort: 'desc' });
    for (const t of (d && d.jetton_transfers) || []) {
      if (t.transaction_aborted) continue;
      push(tonHashHex(t.transaction_hash), Number(t.amount) / 10 ** n.decimals, t.transaction_now ? t.transaction_now * 1000 : null);
    }
  } else if (n.kind === 'sol') {
    // incoming USDT lands in the owner's token account, so look there (not at the wallet address)
    const accts = await rpc(n.rpc, 'getTokenAccountsByOwner', [n.addr, { mint: n.mint }, { encoding: 'jsonParsed' }]);
    for (const a of (accts && accts.value) || []) {
      const sigs = await rpc(n.rpc, 'getSignaturesForAddress', [a.pubkey, { limit: 20, commitment: 'finalized' }]);
      for (const sg of sigs || []) {
        if (sg.err || (sg.blockTime && sg.blockTime * 1000 < sinceMs)) continue;
        const r = await checkSol(n, sg.signature);
        if (r.state === 'ok') push(sg.signature, r.amount, r.time);
      }
    }
  }
  return out;
}

/** Same answer, plus one log line so the Railway log shows what happened to every TxID. */
async function verifyDeposit(rawTxid, opts = {}) {
  const r = await verifyDepositInner(rawTxid, opts);
  const id = String(rawTxid || '').trim();
  logger.info(`[CHAIN] ${id.slice(0, 14)}…(${id.length} chars) user=${opts.userId || '-'} → ${r.found ? `OK ${r.amount} ${r.network}${r.tooOld ? ' (too old)' : ''}` : `NO ${r.reason}`}`);
  return r;
}

module.exports = { recentIncoming, tonRaw, tonHashHex, verifyDeposit, isChainTxid, candidates, networks, tronHex, b58decode, _setHttp };
