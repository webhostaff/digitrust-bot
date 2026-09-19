'use strict';

/**
 * Binance API — USDT deposit verification via account deposit history.
 *
 * Endpoint: GET /sapi/v1/capital/deposit/hisrec
 * Auth:     SIGNED (HMAC-SHA256 of query string using API_SECRET)
 * Permis:   Enable Reading only (no withdraw / no trading required)
 *
 * verifyDepositByTxId(txid) returns:
 *   { found: true, amount, network, asset, address, txid }
 * or:
 *   { found: false, reason, message }
 *
 * Status codes from Binance:
 *   0 = pending
 *   6 = credited but cannot withdraw
 *   1 = success
 *   7 = wrong deposit
 *   8 = waiting user confirm
 */

const crypto = require('crypto');
const axios  = require('axios');
const config = require('../config');
const logger = require('../utils/logger');

const BASE_URL = 'https://api.binance.com';

// Binance network codes → human label
const ALLOWED_NETWORKS = {
  TRX: 'TRC20',
  BSC: 'BEP20',
  TON: 'TON',
};

// TxID format: TRON = 64 hex, BSC = 0x + 64 hex
// TRON = 64 hex, BSC = 0x + 64 hex, TON = 64 hex or a 44-char base64 hash.
const TXID_RE = /^((0x)?[a-fA-F0-9]{64}|[A-Za-z0-9+/_-]{43,48}={0,2})$/;

/**
 * Every spelling a transaction hash can arrive in.
 *
 * TON is the reason this exists. A TON wallet shows the hash as 64 hex
 * characters; Binance stores the SAME hash base64-encoded (44 chars). Compared
 * as text they never match, so a real deposit was reported as "never reached
 * your account" — and the customer was told to keep waiting for money that had
 * already arrived.
 *
 * Both forms are generated from whichever one is given, and matching succeeds
 * if any form lines up.
 */
function txidForms(raw) {
  const v = String(raw || '').trim();
  if (!v) return [];

  const forms = new Set();
  const add = (x) => { if (x) forms.add(String(x).toLowerCase()); };

  add(v);
  add(v.replace(/^0x/i, ''));

  const hex = v.replace(/^0x/i, '');
  if (/^[a-f0-9]{64}$/i.test(hex)) {
    // hex → base64, the form Binance uses for TON.
    try {
      const b64 = Buffer.from(hex, 'hex').toString('base64');
      add(b64);
      add(b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')); // url-safe
    } catch (_) {}
  } else if (/^[A-Za-z0-9+/_-]{43,48}={0,2}$/.test(v)) {
    // base64 → hex, for when the customer pastes what Binance showed them.
    try {
      const norm = v.replace(/-/g, '+').replace(/_/g, '/');
      const h = Buffer.from(norm, 'base64').toString('hex');
      if (h.length === 64) add(h);
    } catch (_) {}
  }

  return [...forms];
}

/** Do two hashes refer to the same transaction, in any encoding? */
function sameTxid(a, b) {
  const A = txidForms(a);
  const B = txidForms(b);
  return A.some((x) => B.includes(x));
}

function eqAddr(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

function sign(queryString) {
  return crypto
    .createHmac('sha256', config.binanceApiSecret)
    .update(queryString)
    .digest('hex');
}

async function signedGet(path, params = {}) {
  const timestamp  = Date.now();
  const recvWindow = 10000;
  const qs = new URLSearchParams({
    ...params,
    recvWindow: String(recvWindow),
    timestamp:  String(timestamp),
  }).toString();

  const signature = sign(qs);
  const url = `${BASE_URL}${path}?${qs}&signature=${signature}`;

  return axios.get(url, {
    headers: { 'X-MBX-APIKEY': config.binanceApiKey },
    timeout: 15000,
  });
}

/**
 * @param {object} opts coin — omit to fetch EVERY coin, which the tracer needs.
 */
async function fetchDepositHistory({ coin = 'USDT', startTime, endTime } = {}) {
  // An explicit null means "all coins". Passing the key through as undefined
  // would serialise to the literal string "undefined" and match nothing.
  const params = {};
  if (coin) params.coin = coin;
  if (startTime) params.startTime = String(startTime);
  if (endTime)   params.endTime   = String(endTime);

  const { data } = await signedGet('/sapi/v1/capital/deposit/hisrec', params);
  if (!Array.isArray(data)) {
    throw new Error(`Unexpected Binance response: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return data;
}

/**
 * Verify a single USDT deposit by TxID against Binance deposit history.
 */
async function verifyDepositByTxId(rawTxid, opts = {}) {
  // opts.maxAgeMinutes — reject deposits whose on-chain arrival is older than
  //                      this. The TxID of a shared deposit address is public,
  //                      so an unbounded window means every historical transfer
  //                      is claimable forever by whoever reads the explorer.
  const maxAgeMinutes = Number(opts.maxAgeMinutes) > 0 ? Number(opts.maxAgeMinutes) : 0;
  let tooOld = false;
  let tooOldMinutes = 0;
  // 1. Config check
  if (!config.binanceApiKey || !config.binanceApiSecret) {
    logger.error('Binance API key/secret not configured.');
    return {
      found: false, reason: 'not_configured',
      message: 'Deposit verification is not configured. Please contact support.',
    };
  }
  if (!config.usdtTrc20Address && !config.usdtBep20Address && !config.usdtTonAddress) {
    logger.error('No USDT deposit addresses configured.');
    return {
      found: false, reason: 'not_configured',
      message: 'Deposit addresses are not configured. Please contact support.',
    };
  }

  // 2. Format check
  const txid = (rawTxid || '').trim();
  if (!TXID_RE.test(txid)) {
    return {
      found: false, reason: 'invalid_format',
      message: 'Invalid TxID format. Please check and resend.',
    };
  }

  // 3. Pull deposit history (last 90d + 90-180d window for safety)
  const now = Date.now();
  const ninetyD = 90 * 24 * 60 * 60 * 1000;

  let history = [];
  try {
    const recent = await fetchDepositHistory({
      coin: 'USDT', startTime: now - ninetyD, endTime: now,
    });
    history = history.concat(recent);

    try {
      const older = await fetchDepositHistory({
        coin: 'USDT', startTime: now - 2 * ninetyD, endTime: now - ninetyD,
      });
      history = history.concat(older);
    } catch (e) {
      logger.warn(`Older deposit window fetch failed (ignored): ${e.message}`);
    }
  } catch (err) {
    const data = err.response && err.response.data;
    logger.error(`Binance deposit history error: ${err.message} ${data ? JSON.stringify(data) : ''}`);
    return {
      found: false, reason: 'api_error',
      message: 'Could not reach Binance right now. Please try again in a moment.',
    };
  }

  // 4. Match by txId (case-insensitive, with/without 0x)
  logger.info(`[VERIFY] Looking for TXID: ${txid}`);
  logger.info(`[VERIFY] Fetched ${history.length} deposits from Binance history`);
  if (history.length > 0) {
    logger.info(`[VERIFY] First deposit TxId sample: ${history[0].txId || 'none'}`);
  }
  const match = history.find((d) => d.txId && sameTxid(d.txId, txid));
  if (match) {
    logger.info(`[VERIFY] MATCH FOUND: amount=${match.amount} address=${match.address} status=${match.status} insertTime=${match.insertTime}`);
  } else {
    logger.warn(`[VERIFY] NO MATCH for TXID ${txid}`);
  }

  if (!match) {
    return {
      // Distinct from 'pending': Binance cannot see this transfer AT ALL, so
      // there is no amount and no proof anything was sent. Recording it as a
      // pending deposit produced the "$0.00" rows in the payments list, and
      // would let anyone fill that list with invented TxIDs.
      found: false, reason: 'not_found',
      message:
        '⏳ This TxID is not in our Binance deposit history yet.\n\n' +
        'Binance usually credits deposits within 1–30 minutes after on-chain ' +
        'confirmation. Wait a few minutes and resend the TxID.\n\n' +
        'If it still is not found after 30 minutes, send this TxID to support ' +
        'and it will be checked by hand.',
    };
  }

  // ── FRAUD PROTECTION: reject deposits from before bot was activated ──
  // Read cutoff timestamp (ms) from db settings via lazy require to avoid circular deps
  try {
    const dbq = require('../database/queries');
    const cutoffRaw = dbq.getSetting('deposit_cutoff_ms', '0');
    const cutoffMs = parseInt(cutoffRaw, 10);
    if (cutoffMs > 0 && match.insertTime && Number(match.insertTime) < cutoffMs) {
      logger.warn(`[VERIFY] REJECTED — deposit ${txid} dated ${match.insertTime} is BEFORE cutoff ${cutoffMs}`);
      return {
        found: false, reason: 'too_old',
        message:
          '❌ <b>This deposit is too old.</b>\n\n' +
          'Only deposits made <b>after</b> the bot was activated can be credited.\n' +
          'If you believe this is a mistake, contact support.',
      };
    }
  } catch (e) {
    logger.warn(`Cutoff check error: ${e.message}`);
  }

  // ── FRAUD PROTECTION: deposit age window ────────────────────────────────
  // This is what stops harvested TxIDs. A transfer that landed hours or weeks
  // ago can no longer be claimed, no matter who submits it.
  if (maxAgeMinutes > 0 && match.insertTime) {
    const ageMs = Date.now() - Number(match.insertTime);
    const maxMs = maxAgeMinutes * 60 * 1000;
    if (ageMs > maxMs) {
      // SOFT fail on purpose. The caller decides what to do, because the answer
      // depends on something this layer cannot see: whether a valid reservation
      // owned by the submitter exists.
      //   • reservation matches  → send to manual review (nobody loses money)
      //   • no reservation       → hard reject (this is the harvesting attack)
      // Hard-failing here would punish honest users who were a minute late.
      tooOld = true;
      tooOldMinutes = Math.round(ageMs / 60000);
      logger.warn(`[VERIFY] deposit ${txid} is ${tooOldMinutes} min old (limit ${maxAgeMinutes}) — flagged`);
    }
    // A timestamp in the future means clock skew or a manipulated value.
    if (ageMs < -5 * 60 * 1000) {
      logger.warn(`[VERIFY] REJECTED — deposit ${txid} has a future timestamp`);
      return {
        found: false, reason: 'bad_timestamp',
        message: '❌ Could not validate this deposit. Please contact support.',
      };
    }
  }

  // 5. Status: 1 = success
  const status = Number(match.status);
  if (status !== 1) {
    // The transfer exists on-chain but Binance has not credited it yet. Report
    // the details so the caller can log it — support then sees who is waiting
    // instead of only hearing about it when the customer complains.
    return {
      found: false, reason: 'pending',
      amount:     Number(match.amount),
      network:    ALLOWED_NETWORKS[String(match.network || '').toUpperCase()] || String(match.network || ''),
      insertTime: Number(match.insertTime) || null,
      txid:       match.txId,
      message:
        `⏳ <b>Deposit found — waiting for Binance to confirm it.</b>\n\n` +
        `💵 Amount: <b>${Number(match.amount)} USDT</b>\n` +
        `🌐 Network: ${String(match.network || '').toUpperCase()}\n\n` +
        `This usually takes a few minutes. Send the TxID again shortly.\n` +
        `<i>Our team can already see your deposit — you do not need to contact support.</i>`,
    };
  }

  // 6. Coin
  if (String(match.coin).toUpperCase() !== 'USDT') {
    return {
      found: false, reason: 'wrong_coin',
      message: `❌ Wrong asset. Expected USDT, got ${match.coin}.`,
    };
  }

  // 7. Network
  const network = String(match.network || '').toUpperCase();
  if (!ALLOWED_NETWORKS[network]) {
    return {
      found: false, reason: 'wrong_network',
      message:
        '❌ Unsupported network. Please send USDT only via:\n' +
        '• TRC20 (TRON)\n' +
        '• BEP20 (BNB Smart Chain)',
    };
  }
  const networkLabel = ALLOWED_NETWORKS[network];

  // 8. Address
  //
  // Looked up by network rather than chosen with a two-way ternary. The old
  // form sent everything that was not TRON to the BEP20 address, so a genuine
  // TON deposit would be compared against a BSC address and rejected as "wrong
  // address" — money that arrived, recorded as never having arrived.
  const ADDRESS_BY_NETWORK = {
    TRX: config.usdtTrc20Address,
    BSC: config.usdtBep20Address,
    TON: config.usdtTonAddress,
  };
  const expectedAddr = ADDRESS_BY_NETWORK[network];

  if (!expectedAddr) {
    return {
      found: false, reason: 'wrong_network',
      message: `❌ ${networkLabel} deposits are not configured. Please contact support.`,
    };
  }
  if (!eqAddr(match.address, expectedAddr)) {
    return {
      found: false, reason: 'wrong_address',
      message: `❌ This deposit was sent to a different address. Please send to our official ${networkLabel} address only.`,
    };
  }

  // ✅ All checks passed
  const amount = Number(match.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return {
      found: false, reason: 'api_error',
      message: 'Unexpected amount returned by Binance. Please contact support.',
    };
  }

  return {
    found:   true,
    amount,
    network: networkLabel,
    asset:   'USDT',
    address: match.address,
    txid:    match.txId,
    insertTime: Number(match.insertTime) || null,
    tooOld,
    tooOldMinutes,
    maxAgeMinutes,
  };
}

// ── Binance Pay (C2C internal transfers) ──────────────────────────────────────

/**
 * Verify a Binance Pay C2C transfer (internal Binance ID transfer) by transactionId.
 *
 * Endpoint: GET /sapi/v1/pay/transactions
 * Auth:     SIGNED (Read permission only)
 * Returns:
 *   { found: true, amount, currency, transactionId, orderType }
 * or:
 *   { found: false, reason, message }
 *
 * orderType meaning:
 *   C2C  = direct Binance-ID transfer (this is what we want)
 *   PAY  = merchant payment
 *   PAY_REFUND, C2C_HOLDING, etc.
 */
/**
 * @param {string} rawId Binance Pay order/transaction id
 * @param {object} opts  { maxAgeMinutes } — same freshness rule the on-chain
 *                       path already enforces.
 */
async function verifyBinancePayOrder(rawId, opts = {}) {
  if (!config.binanceApiKey || !config.binanceApiSecret) {
    logger.error('Binance API key/secret not configured.');
    return {
      found: false, reason: 'not_configured',
      message: 'Verification is not configured. Please contact support.',
    };
  }

  const orderId = (rawId || '').trim();
  if (!orderId || orderId.length < 8 || orderId.length > 80) {
    return {
      found: false, reason: 'invalid_format',
      message: 'Invalid Order ID format. Please check and resend.',
    };
  }

  // Pull Pay history (last 90 days). Then 90-180 days for safety.
  const now = Date.now();
  const ninetyD = 90 * 24 * 60 * 60 * 1000;

  let history = [];
  try {
    const recent = await signedGet('/sapi/v1/pay/transactions', {
      startTime: String(now - ninetyD),
      endTime:   String(now),
      limit:     '100',
    });
    const recentRows = (recent.data && Array.isArray(recent.data.data)) ? recent.data.data : [];
    history = history.concat(recentRows);

    try {
      const older = await signedGet('/sapi/v1/pay/transactions', {
        startTime: String(now - 2 * ninetyD),
        endTime:   String(now - ninetyD),
        limit:     '100',
      });
      const olderRows = (older.data && Array.isArray(older.data.data)) ? older.data.data : [];
      history = history.concat(olderRows);
    } catch (e) {
      logger.warn(`Older Pay window fetch failed (ignored): ${e.message}`);
    }
  } catch (err) {
    const data = err.response && err.response.data;
    logger.error(`Binance Pay history error: ${err.message} ${data ? JSON.stringify(data) : ''}`);
    return {
      found: false, reason: 'api_error',
      message: 'Could not reach Binance right now. Please try again in a moment.',
    };
  }

  // Find by any of the possible Binance Pay identifier fields.
  // Different views of Binance Pay show different IDs to the user:
  //   - transactionId : long numeric ID shown in the API
  //   - orderId       : alternative numeric ID
  //   - merchantTradeNo: merchant-side trade number
  // We accept any of them, normalized.
  const wanted = orderId.toLowerCase();
  const match = history.find((t) => {
    const candidates = [
      t.transactionId,
      t.orderId,
      t.merchantTradeNo,
      t.tradeNo,
      t.id,
    ];
    return candidates.some((c) => String(c || '').toLowerCase() === wanted);
  });

  if (!match) {
    // Debug: log a sample of what Binance returned to help diagnose mismatches
    const sample = history.slice(0, 3).map((t) => ({
      transactionId:   t.transactionId,
      orderId:         t.orderId,
      merchantTradeNo: t.merchantTradeNo,
      amount:          t.amount,
      currency:        t.currency,
      orderType:       t.orderType,
    }));
    logger.warn(`Binance Pay Order ID not found: ${orderId}. Total entries: ${history.length}. First 3: ${JSON.stringify(sample)}`);

    return {
      found: false, reason: 'not_found',
      message:
        '⏳ This Order ID was not found in our Binance Pay history.\n\n' +
        'Make sure you copied the exact Order ID from your Binance Pay transaction.\n' +
        'If you just paid, please wait a minute and resend.',
    };
  }

  // ── FRAUD PROTECTION: reject transfers from before bot was activated ──
  try {
    const dbq = require('../database/queries');
    const cutoffRaw = dbq.getSetting('deposit_cutoff_ms', '0');
    const cutoffMs = parseInt(cutoffRaw, 10);
    const txTime = Number(match.transactionTime || match.createTime || 0);
    if (cutoffMs > 0 && txTime > 0 && txTime < cutoffMs) {
      logger.warn(`[VERIFY-PAY] REJECTED — Binance Pay ${orderId} dated ${txTime} is BEFORE cutoff ${cutoffMs}`);
      return {
        found: false, reason: 'too_old',
        message:
          '❌ <b>This transfer is too old.</b>\n\n' +
          'Only Binance Pay transfers made <b>after</b> the bot was activated can be credited.\n' +
          'If you believe this is a mistake, contact support.',
      };
    }
  } catch (e) {
    logger.warn(`Binance Pay cutoff check error: ${e.message}`);
  }

  // ── FRESHNESS ────────────────────────────────────────────────────────────
  // The on-chain paths reject a transfer older than deposit_max_age_minutes;
  // this one only ever checked "before the bot existed", so a Binance Pay id
  // stayed claimable for the full 180-day history window. That is not a
  // theoretical gap: an id from two days ago is one a customer can re-send
  // after already being credited elsewhere, or that a second person can submit.
  try {
    const dbq = require('../database/queries');
    const maxAgeMinutes = Number(opts.maxAgeMinutes) > 0
      ? Number(opts.maxAgeMinutes)
      : (parseInt(dbq.getSetting('deposit_max_age_minutes', '15'), 10) || 0);

    const txTime = Number(match.transactionTime || match.createTime || 0);
    if (maxAgeMinutes > 0 && txTime > 0) {
      const ageMin = Math.floor((Date.now() - txTime) / 60000);
      if (ageMin > maxAgeMinutes) {
        logger.warn(`[VERIFY-PAY] REJECTED — ${orderId} is ${ageMin} min old (limit ${maxAgeMinutes})`);
        return {
          found: false, reason: 'too_old', ageMinutes: ageMin, maxAgeMinutes,
          message:
            '⏰ <b>This transfer is too old to be claimed automatically.</b>\n\n' +
            `It was made <b>${ageMin} minutes</b> ago; the limit is <b>${maxAgeMinutes} minutes</b>.\n\n` +
            'Send a new transfer, or contact support with this Order ID and they ' +
            'can credit it by hand.',
        };
      }
    }
  } catch (e) {
    logger.warn(`Binance Pay age check error: ${e.message}`);
  }

  // Amount: positive = income, negative = expense. We want INCOMING transfers.
  const amount = Number(match.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return {
      found: false, reason: 'wrong_direction',
      message: '❌ This transaction is not an incoming payment.',
    };
  }

  // Must be C2C (Binance-ID transfer) — not refunds or holding orders
  const acceptableTypes = ['C2C', 'PAY'];
  if (!acceptableTypes.includes(match.orderType)) {
    return {
      found: false, reason: 'wrong_type',
      message: `❌ Unsupported transaction type: ${match.orderType}.`,
    };
  }

  // ── FRAUD PROTECTION: the asset must be USDT ────────────────────────────
  //
  // The amount alone says nothing about value. Binance Pay will happily carry
  // any listed token, so without this a sender could transfer 160,000,000 BTTC
  // — worth a few cents — and the bot would read "amount: 160000000" and credit
  // it as if it were dollars. `currency` was being read here for the response
  // but never actually checked.
  const payCurrency = String(match.currency || '').toUpperCase();
  if (payCurrency !== 'USDT') {
    logger.warn(
      `[VERIFY-PAY] REJECTED — order ${orderId} is ${match.amount} ${payCurrency}, not USDT`
    );
    return {
      found: false, reason: 'wrong_coin',
      message:
        `❌ <b>Wrong currency.</b>\n\n` +
        `This transfer was <b>${payCurrency || 'an unknown asset'}</b>, but only ` +
        `<b>USDT</b> is accepted.\n\n` +
        `Please send USDT via Binance Pay and try again.`,
    };
  }

  return {
    found: true,
    amount,
    currency: payCurrency,
    transactionId: match.transactionId,
    orderType: match.orderType,
  };
}

/**
 * Look a TxID up in Binance's own deposit history — no validation, no rules.
 *
 * `verifyDepositByTxId` answers "may this be credited?", and it says no for a
 * dozen reasons that have nothing to do with whether the money arrived: wrong
 * address, too old, already used, amount mismatch. When support is asked "did
 * my deposit arrive?", every one of those is still a YES. This answers only the
 * factual question, so the local database saying "not found" can be separated
 * from the money genuinely never having landed.
 *
 * @param {string} rawTxid full or partial hash, or a Binance transfer id
 * @returns {Promise<{ok:boolean, matches?:Array, error?:string}>}
 */
async function findDepositRaw(rawTxid) {
  const needle = String(rawTxid || '').trim().toLowerCase();
  if (!needle || needle.length < 6) return { ok: false, error: 'id too short' };
  if (!config.binanceApiKey || !config.binanceApiSecret) return { ok: false, error: 'Binance API keys not configured' };

  const now = Date.now();
  const ninetyD = 90 * 24 * 60 * 60 * 1000;
  const windows = [
    { startTime: now - ninetyD, endTime: now },
    { startTime: now - 2 * ninetyD, endTime: now - ninetyD },
  ];

  const rows = [];
  for (const w of windows) {
    // A failed window must not hide the other one: half an answer still tells
    // support more than an error does.
    try {
      // Every coin, not just USDT. The tracer answers "did this arrive?", and a
      // customer who sent TRX or BNB by mistake still sent something — reporting
      // "never reached your account" about money sitting in the account is the
      // worst possible answer, because it ends the investigation.
      const batch = await fetchDepositHistory({ coin: null, ...w });
      rows.push(...batch);
    } catch (e) {
      logger.warn(`findDepositRaw window failed: ${e.message}`);
    }
  }

  // Logged so a "nothing found" can be told apart from "the API call failed" or
  // "the key has no permission" — three very different problems that all look
  // identical from the chat.
  logger.info(`[TRACE] searching ${rows.length} deposit(s) for "${String(needle).slice(0, 16)}…"`);
  if (rows.length) {
    logger.info(`[TRACE] newest sample: txId=${String(rows[0].txId || '').slice(0, 20)}… coin=${rows[0].coin} network=${rows[0].network}`);
  }

  const matches = rows.filter((d) => {
    const tx = String(d.txId || '').toLowerCase();
    const id = String(d.id || '').toLowerCase();
    // Exact match in any encoding first, then the partial search the tracer
    // promises — a shop owner often pastes only the first few characters.
    if (d.txId && sameTxid(d.txId, needle)) return true;
    return tx.includes(needle) || needle.includes(tx) || id === needle;
  });

  logger.info(`[TRACE] ${matches.length} match(es)`);

  return {
    ok: true,
    scanned: rows.length,
    matches: matches.map((d) => ({
      txId: d.txId,
      amount: Number(d.amount),
      coin: d.coin,   // may be TRX, BNB… not only USDT
      network: d.network,
      address: d.address,
      // 0 = pending, 6 = credited but withdrawal-locked, 1 = success.
      status: Number(d.status),
      insertTime: Number(d.insertTime),
      confirmTimes: d.confirmTimes,
    })),
  };
}

/**
 * Look an id up in Binance Pay history — internal, off-chain transfers.
 *
 * A customer who "sent USDT on Binance" may have used the Pay/internal transfer
 * rather than an on-chain BEP20 withdrawal. Those never appear in deposit
 * history, so a deposit-only search reports "never arrived" for money that is
 * sitting in the account. Partial ids are accepted because customers screenshot
 * these and retype them, and they are long.
 *
 * @returns {Promise<{ok:boolean, matches?:Array, error?:string}>}
 */
async function findPayTransactionRaw(rawId) {
  const needle = String(rawId || '').trim().toLowerCase();
  if (!needle || needle.length < 5) return { ok: false, error: 'id too short' };
  if (!config.binanceApiKey || !config.binanceApiSecret) {
    return { ok: false, error: 'Binance API keys not configured' };
  }

  const now = Date.now();
  const ninetyD = 90 * 24 * 60 * 60 * 1000;
  let history = [];

  for (const w of [
    { startTime: String(now - ninetyD), endTime: String(now) },
    { startTime: String(now - 2 * ninetyD), endTime: String(now - ninetyD) },
  ]) {
    try {
      const res = await signedGet('/sapi/v1/pay/transactions', { ...w, limit: '100' });
      const rows = (res.data && Array.isArray(res.data.data)) ? res.data.data : [];
      history = history.concat(rows);
    } catch (e) {
      logger.warn(`findPayTransactionRaw window failed: ${e.message}`);
    }
  }

  const matches = history.filter((t) => {
    // Binance shows a different id in each view, so all of them are searched.
    const ids = [t.transactionId, t.orderId, t.merchantTradeNo, t.tradeNo, t.id]
      .map((c) => String(c || '').toLowerCase())
      .filter(Boolean);
    return ids.some((c) => c === needle || c.includes(needle) || needle.includes(c));
  });

  return {
    ok: true,
    matches: matches.map((t) => ({
      transactionId: t.transactionId,
      orderId:       t.orderId,
      amount:        Number(t.amount),
      currency:      t.currency,
      // PAY / TRANSFER / C2C — tells you how it was sent.
      orderType:     t.orderType,
      transactionTime: Number(t.transactionTime),
      payerInfo:     t.payerInfo,
    })),
  };
}

/**
 * The raw deposit list, straight from Binance, with no filtering at all.
 *
 * Every other function here decides something — is it ours, is it fresh, does
 * the address match. When a deposit "cannot be found", those decisions are
 * exactly what is in question, so this makes none of them: it returns what
 * Binance says, so the shop owner can see with their own eyes whether the money
 * is there. If it is missing here, the problem is upstream of this bot entirely.
 */
async function listRecentDeposits({ days = 7, limit = 15, network = null, amount = null } = {}) {
  if (!config.binanceApiKey || !config.binanceApiSecret) {
    return { ok: false, error: 'Binance API keys not configured' };
  }
  const now = Date.now();
  try {
    const rows = await fetchDepositHistory({
      coin: null, startTime: now - days * 86400000, endTime: now,
    });
    // Filtering happens AFTER the full fetch, never in the request: the point of
    // this command is to see everything Binance holds, and narrowing the query
    // would hide the very rows being looked for. With hundreds of BSC deposits a
    // day, a single TON transfer is invisible in a list of the newest fifteen.
    let rows2 = rows;
    if (network) {
      const want = String(network).toUpperCase();
      rows2 = rows2.filter((d) => String(d.network || '').toUpperCase() === want);
    }
    if (amount !== null && Number.isFinite(Number(amount))) {
      const want = Number(amount);
      rows2 = rows2.filter((d) => Math.abs(Number(d.amount) - want) < 0.000001);
    }

    const sorted = [...rows2].sort((a, b) => Number(b.insertTime) - Number(a.insertTime));
    return {
      ok: true,
      total: rows.length,          // everything in the window
      matched: rows2.length,       // everything after filtering
      networks: [...new Set(rows.map((d) => String(d.network || '?').toUpperCase()))],
      rows: sorted.slice(0, limit),
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  listRecentDeposits,
  verifyDepositByTxId,
  verifyBinancePayOrder,
  findDepositRaw,
  findPayTransactionRaw,
  TXID_RE,
};
