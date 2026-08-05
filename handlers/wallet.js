'use strict';

const { t } = require('../utils/i18n');
const db      = require('../database/queries');
const session = require('./session');
const { States } = require('./session');
const config  = require('../config');
const {
  walletMenuKb, walletTopupMethodKb, cryptobotAssetKb,
  cancelKb, backKb,
} = require('../utils/keyboard');
const { formatPrice, PAYMENT_CONFIRM_VALIDITY_MIN, checkPaymentWindow } = require('../utils/format');
const {
  verifyDepositByTxId, verifyBinancePayOrder, TXID_RE,
} = require('../services/binance');
const cryptobot = require('../services/cryptobot');
const logger = require('../utils/logger');

const MIN_DEPOSIT = 1;

// Track TXIDs currently being verified to prevent rapid duplicate submissions
const PROCESSING_TXIDS = new Set();

// ── Wallet home ───────────────────────────────────────────────────────────────

async function showWallet(bot, chatId, userId, messageId = null) {
  const lang = db.getUserLanguage ? db.getUserLanguage(userId) : 'en';
  const user    = db.getUser(userId);
  const balance = user?.balance || 0;

  const text =
    `💰 <b>Your Wallet</b>\n\n` +
    `💵 <b>Balance:</b> ${formatPrice(balance)}\n\n` +
    `Choose an action:`;

  if (messageId) {
    await bot.editMessageText(text, {
      chat_id: chatId, message_id: messageId,
      parse_mode: 'HTML', reply_markup: walletMenuKb(),
    });
  } else {
    await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: walletMenuKb() });
  }
}

// ── Top-up method picker ──────────────────────────────────────────────────────

async function showTopupMethods(bot, chatId, userId, messageId) {
  const lang = db.getUserLanguage ? db.getUserLanguage(userId) : 'en';
  await bot.editMessageText(
    `💳 <b>Top Up Wallet</b>\n\nChoose a payment method:`,
    {
      chat_id: chatId, message_id: messageId,
      parse_mode: 'HTML', reply_markup: walletTopupMethodKb(),
    }
  );
}

// ── Method 1: External USDT (TRC20/BEP20) — TxID ──────────────────────────────

/**
 * STEP 1 — choose the network.
 *
 * The old flow jumped straight to "send us a TxID". Because the deposit
 * address is shared and every transfer to it is public on the block explorer,
 * that made any unclaimed TxID free money for whoever pasted it first. The
 * flow is now: pick network → reserve a unique amount → transfer exactly that
 * amount → submit the TxID. The reservation is what proves ownership.
 */
async function startUsdtTopup(bot, chatId, userId, messageId) {
  session.clear(userId);

  const rows = [];
  if (config.usdtTrc20Address) rows.push([{ text: '🔴 USDT — TRC20 (TRON)', callback_data: 'topup_net_TRC20' }]);
  if (config.usdtBep20Address) rows.push([{ text: '🟡 USDT — BEP20 (BSC)',  callback_data: 'topup_net_BEP20' }]);
  rows.push([{ text: '🔙 Back', callback_data: 'wallet_topup' }]);

  if (rows.length === 1) {
    await bot.editMessageText(
      '❌ <b>USDT deposits are not configured.</b>\n\nPlease contact support.',
      { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: backKb('wallet_topup') }
    ).catch(() => {});
    return;
  }

  await bot.editMessageText(
    `💎 <b>Top Up via USDT</b>\n\n` +
    `Choose the network you will send from:\n\n` +
    `🔴 <b>TRC20</b> — TRON network\n` +
    `🟡 <b>BEP20</b> — BNB Smart Chain\n\n` +
    `⚠️ <i>Send only USDT on the network you pick. Anything else is lost.</i>`,
    { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } }
  ).catch(() => {});
}

/**
 * STEP 2 — ask for the amount.
 */
async function startUsdtAmount(bot, chatId, userId, messageId, network) {
  const net = network === 'TRC20' ? 'TRC20' : 'BEP20';
  session.set(userId, States.WALLET_TOPUP_USDT_AMOUNT, { network: net, startedAt: Date.now() });

  await bot.editMessageText(
    `💎 <b>USDT — ${net}</b>\n\n` +
    `1️⃣ Enter the amount you want to deposit, in USDT.\n` +
    `   Example: <code>10</code>\n\n` +
    `2️⃣ We will give you an <b>exact amount</b> to send.\n` +
    `3️⃣ You must send that exact figure — it is what identifies your deposit.\n\n` +
    `💵 Minimum: <b>${MIN_DEPOSIT} USDT</b>`,
    { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: cancelKb('wallet_topup') }
  ).catch(() => {});
}

/**
 * STEP 3 — reserve a unique amount and show the payment instructions.
 */
async function handleUsdtAmount(bot, msg) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const sess   = session.get(userId);
  const net    = (sess.data && sess.data.network) === 'TRC20' ? 'TRC20' : 'BEP20';

  const base = parseFloat(String(msg.text || '').replace(',', '.').trim());
  if (isNaN(base) || base < MIN_DEPOSIT) {
    await bot.sendMessage(chatId, `❌ Enter a valid amount (minimum <b>${MIN_DEPOSIT} USDT</b>).`, { parse_mode: 'HTML' });
    return;
  }
  if (base > 10000) {
    await bot.sendMessage(chatId, '❌ Single top-up cannot exceed 10,000 USDT. Contact support for larger amounts.');
    return;
  }

  const ttl = parseInt(db.getSetting('deposit_intent_ttl_minutes', '60'), 10) || 60;
  const intent = db.createDepositIntent(userId, net, base, ttl);
  if (!intent) {
    await bot.sendMessage(chatId, '❌ Could not reserve an amount right now. Please try again.');
    return;
  }

  const address = net === 'TRC20' ? config.usdtTrc20Address : config.usdtBep20Address;
  session.set(userId, States.WALLET_TOPUP_USDT_TX, {
    network: net, intentId: intent.id, startedAt: Date.now(),
  });

  await bot.sendMessage(
    chatId,
    `💎 <b>Send exactly this amount</b>\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `💵 <b>Amount:</b>\n<code>${intent.unique_amount.toFixed(6)}</code>\n\n` +
    `📥 <b>${net} address:</b>\n<code>${address}</code>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `⚠️ <b>The amount must match to the last decimal.</b>\n` +
    `That exact figure is reserved for you — it is how we know the deposit is yours. ` +
    `A different amount cannot be credited automatically.\n\n` +
    `<i>The few extra decimals cost you less than a tenth of a cent, and they are ` +
    `credited to your wallet in full.</i>\n\n` +
    `⏰ Reserved for <b>${ttl} minutes</b>.\n\n` +
    `After sending, paste the <b>TxID</b> (transaction hash) here.`,
    {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [
        [{ text: '❌ Cancel reservation', callback_data: `topup_cancel_${intent.id}` }],
        [{ text: '🔙 Wallet', callback_data: 'menu_wallet' }],
      ] },
    }
  );
}

// ── Method 2: Binance Pay (internal) — Order ID ───────────────────────────────

async function startBinancePayTopup(bot, chatId, userId, messageId) {
  const lang = db.getUserLanguage ? db.getUserLanguage(userId) : 'en';
  session.set(userId, States.WALLET_TOPUP_BINANCE_ID, { startedAt: Date.now() });

  const binanceId = config.binanceId || '—';

  await bot.editMessageText(
    `🟡 <b>Top Up via Binance Pay</b>\n\n` +
    `🔹 <b>Binance ID:</b> <code>${binanceId}</code>\n\n` +
    `📌 Steps:\n` +
    `1. Open Binance app → Pay → Send\n` +
    `2. Enter the Binance ID above\n` +
    `3. Choose USDT and amount\n` +
    `4. Confirm transfer\n` +
    `5. Copy the <b>Order ID</b> and send it here\n\n` +
    `⏰ Valid for ${PAYMENT_CONFIRM_VALIDITY_MIN} minutes and can only be used once.\n\n` +
    `<i>Example Order ID:</i>\n` +
    `<code>402117599683977216</code>\n\n` +
    `💵 Minimum deposit: <b>${MIN_DEPOSIT} USDT</b>`,
    {
      chat_id: chatId, message_id: messageId,
      parse_mode: 'HTML', reply_markup: cancelKb('wallet_topup'),
    }
  );
}

// ── Method 3: CryptoBot ───────────────────────────────────────────────────────

async function startCryptobotTopup(bot, chatId, userId, messageId) {
  const lang = db.getUserLanguage ? db.getUserLanguage(userId) : 'en';
  if (!config.cryptobotToken) {
    await bot.editMessageText(
      '❌ <b>CryptoBot is not configured yet.</b>\n\nPlease contact support.',
      { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: backKb('wallet_topup') }
    );
    return;
  }

  session.set(userId, States.WALLET_TOPUP_CRYPTOBOT_AMOUNT, { asset: 'USDT' });

  await bot.editMessageText(
    `🤖 <b>Top Up via CryptoBot</b>\n\n` +
    `1️⃣ Enter the <b>amount</b> in USDT.\n` +
    `   Example: <code>10</code>\n\n` +
    `2️⃣ You'll receive a payment link.\n` +
    `3️⃣ Pay via @CryptoBot on Telegram.\n` +
    `4️⃣ Your wallet is credited automatically.\n\n` +
    `💵 Minimum: <b>${MIN_DEPOSIT} USDT</b>`,
    {
      chat_id: chatId, message_id: messageId,
      parse_mode: 'HTML', reply_markup: cancelKb('wallet_topup'),
    }
  );
}

// ── Handlers for user text input ──────────────────────────────────────────────

/**
 * USDT TxID submission → verify via Binance deposit history.
 */
async function handleUsdtTxId(bot, msg) {
  const userId = msg.from.id;
  const lang   = db.getUserLanguage ? db.getUserLanguage(userId) : 'en';
  const chatId = msg.chat.id;
  const txid   = (msg.text || '').trim();

  // ── PAYMENT WINDOW EXPIRY CHECK (shared 20-minute window) ──
  const sess = session.get(userId);
  const { expired } = checkPaymentWindow(sess.data && sess.data.startedAt);
  if (expired) {
    session.clear(userId);
    await bot.sendMessage(chatId,
      t(lang, 'wallet_topup_expired', { minutes: PAYMENT_CONFIRM_VALIDITY_MIN }),
      { parse_mode: 'HTML', reply_markup: backKb('menu_wallet') });
    return;
  }

  if (!TXID_RE.test(txid)) {
    await bot.sendMessage(chatId, t(lang, 'wallet_invalid_txid'), { parse_mode: 'HTML' });
    return;
  }
  if (db.isTxidUsed(txid)) {
    await bot.sendMessage(chatId, t(lang, 'wallet_already_used'), { parse_mode: 'HTML' });
    return;
  }
  if (PROCESSING_TXIDS.has(txid)) {
    await bot.sendMessage(chatId, t(lang, 'wallet_already_processing'), { parse_mode: 'HTML' });
    return;
  }

  PROCESSING_TXIDS.add(txid);
  let waitMsgId = null;
  try {
    const wait = await bot.sendMessage(chatId, t(lang, 'wallet_verifying'), { parse_mode: 'HTML' });
    waitMsgId = wait.message_id;

    const VERIFY_TIMEOUT = 35000;
    const maxAge = parseInt(db.getSetting('deposit_max_age_minutes', '15'), 10) || 15;
    let result;
    try {
      result = await Promise.race([
        verifyDepositByTxId(txid, { maxAgeMinutes: maxAge }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT')), VERIFY_TIMEOUT))
      ]);
    } catch (err) {
      if (waitMsgId) await bot.deleteMessage(chatId, waitMsgId).catch(() => {});
      await bot.sendMessage(chatId, t(lang, 'wallet_timeout'), { parse_mode: 'HTML' });
      return;
    }

    if (waitMsgId) await bot.deleteMessage(chatId, waitMsgId).catch(() => {});

    // Double-check after verification (race condition protection)
    if (db.isTxidUsed(txid)) {
      await bot.sendMessage(chatId, t(lang, 'wallet_already_used'), { parse_mode: 'HTML' });
      return;
    }

    if (!result.found) {
      // Note: an out-of-window transfer does NOT arrive here. binance.js
      // soft-fails it as found:true + tooOld, because whether it may still be
      // credited depends on the reservation — which is checked below.
      await bot.sendMessage(chatId, result.message, { parse_mode: 'HTML' });
      return;
    }

    // ══════════════════════════════════════════════════════════════════
    // OWNERSHIP GATE
    //
    // Binance has confirmed the transfer is real, recent and went to our
    // address. None of that says WHO sent it — the TxID is public. The
    // deposit is only credited when it matches a live reservation that
    // belongs to this user.
    // ══════════════════════════════════════════════════════════════════
    const strict = db.getSetting('deposit_strict_mode', '1') === '1';

    // A stale transfer with no reservation behind it is the harvesting attack:
    // refuse it outright and never write it to the review queue, so it cannot
    // be approved by accident later.
    if (result.tooOld && !strict) {
      await bot.sendMessage(chatId,
        `⏰ <b>This deposit is outside the claim window.</b>\n\n` +
        `It arrived <b>${result.tooOldMinutes} minutes</b> ago; the limit is ` +
        `<b>${result.maxAgeMinutes} minutes</b>.`,
        { parse_mode: 'HTML', reply_markup: backKb('menu_wallet') });
      return;
    }

    if (strict) {
      const intent = db.findIntentForDeposit(result.network, result.amount);

      // (a) No reservation at all → never auto-credit. Park it for the admin.
      if (!intent) {
        if (result.tooOld) {
          logger.warn(`[SECURITY] Stale unmatched deposit ${txid} (${result.tooOldMinutes} min) refused for ${userId}`);
          await bot.sendMessage(chatId,
            `❌ <b>This deposit cannot be claimed.</b>\n\n` +
            `The transfer is <b>${result.tooOldMinutes} minutes</b> old and matches no ` +
            `active reservation.\n\n` +
            `Deposits must be reserved before sending, and the TxID submitted within ` +
            `<b>${result.maxAgeMinutes} minutes</b>.`,
            { parse_mode: 'HTML', reply_markup: backKb('menu_wallet') });
          return;
        }
        db.addDepositReview({
          txid, userId, amount: result.amount, network: result.network,
          address: result.address, insertTime: result.insertTime,
          reason: 'no_matching_reservation',
        });
        logger.warn(`[SECURITY] Unmatched deposit ${txid} (${result.amount} ${result.network}) claimed by ${userId}`);
        await notifyDepositReview(bot, userId, txid, result, 'No matching reservation');
        await bot.sendMessage(chatId,
          `⚠️ <b>Amount does not match any reservation</b>\n\n` +
          `💵 Received: <b>${Number(result.amount).toFixed(6)} USDT</b>\n\n` +
          `Deposits are matched by the exact reserved amount. Since this one ` +
          `matches no active reservation, it has been sent to our team for manual review.\n\n` +
          `<i>You will be credited once an admin confirms it. This usually takes a short while.</i>`,
          { parse_mode: 'HTML', reply_markup: backKb('menu_wallet') });
        return;
      }

      // (b) The reservation belongs to somebody else → theft attempt.
      if (Number(intent.user_id) !== Number(userId)) {
        logger.warn(
          `[SECURITY] THEFT ATTEMPT — user ${userId} submitted TxID ${txid} ` +
          `matching reservation #${intent.id} owned by ${intent.user_id}`
        );
        await notifyDepositReview(bot, userId, txid, result,
          `Belongs to reservation #${intent.id} of user ${intent.user_id}`);
        await bot.sendMessage(chatId,
          `❌ <b>This deposit is not yours.</b>\n\n` +
          `The amount matches a reservation created by another account. ` +
          `Repeated attempts will result in a permanent ban.`,
          { parse_mode: 'HTML', reply_markup: backKb('menu_wallet') });
        return;
      }

      // (b2) Reservation is valid and genuinely theirs, but the TxID arrived
      //      late. Nobody loses money: it goes to manual review.
      if (result.tooOld) {
        db.addDepositReview({
          txid, userId, amount: result.amount, network: result.network,
          address: result.address, insertTime: result.insertTime,
          reason: 'outside_window',
        });
        await notifyDepositReview(bot, userId, txid, result,
          `Late TxID (${result.tooOldMinutes} min) but reservation #${intent.id} is valid`);
        await bot.sendMessage(chatId,
          `⏰ <b>Submitted a little late</b>\n\n` +
          `Your reservation is valid, but the TxID arrived ${result.tooOldMinutes} minutes ` +
          `after the transfer (limit ${result.maxAgeMinutes}).\n\n` +
          `✅ Nothing is lost — our team will credit it shortly.`,
          { parse_mode: 'HTML', reply_markup: backKb('menu_wallet') });
        return;
      }

      // (c) The transfer must post-date the reservation. A deposit made
      //     BEFORE the user asked for an amount cannot belong to it.
      if (result.insertTime && result.insertTime < Number(intent.created_ms) - 120000) {
        db.addDepositReview({
          txid, userId, amount: result.amount, network: result.network,
          address: result.address, insertTime: result.insertTime,
          reason: 'predates_reservation',
        });
        logger.warn(`[SECURITY] Deposit ${txid} predates reservation #${intent.id}`);
        await notifyDepositReview(bot, userId, txid, result, 'Transfer predates the reservation');
        await bot.sendMessage(chatId,
          `⚠️ <b>This transfer is older than your reservation.</b>\n\n` +
          `It has been sent to our team for manual review.`,
          { parse_mode: 'HTML', reply_markup: backKb('menu_wallet') });
        return;
      }

      // (d) Consume the reservation atomically — it can never be reused.
      if (!db.claimDepositIntent(intent.id, txid)) {
        await bot.sendMessage(chatId, '⚠️ This reservation was already used. Please start a new top-up.',
          { parse_mode: 'HTML', reply_markup: backKb('menu_wallet') });
        return;
      }
      logger.info(`Deposit ${txid} matched reservation #${intent.id} for user ${userId}`);
    }

    await creditFromVerifiedDeposit(bot, chatId, userId, {
      identifier: txid,
      amount: result.amount,
      network: result.network,
      asset:   result.asset,
      address: result.address,
      method:  `USDT ${result.network}`,
    });
  } finally {
    PROCESSING_TXIDS.delete(txid);
  }
}

/**
 * Binance Pay Order ID submission → verify via /sapi/v1/pay/transactions.
 */
async function handleBinancePayOrderId(bot, msg) {
  const userId  = msg.from.id;
  const chatId  = msg.chat.id;
  const lang    = db.getUserLanguage ? db.getUserLanguage(userId) : 'en';
  const rawText = (msg.text || '').trim();
  const orderId = rawText.split(/\s+/)[0].trim();

  // ── PAYMENT WINDOW EXPIRY CHECK (shared 20-minute window) ──
  const sess = session.get(userId);
  const { expired } = checkPaymentWindow(sess.data && sess.data.startedAt);
  if (expired) {
    session.clear(userId);
    await bot.sendMessage(chatId,
      t(lang, 'wallet_topup_expired', { minutes: PAYMENT_CONFIRM_VALIDITY_MIN }),
      { parse_mode: 'HTML', reply_markup: backKb('menu_wallet') });
    return;
  }

  if (!orderId) return;
  if (db.isTxidUsed(orderId)) {
    await bot.sendMessage(chatId, t(lang, 'wallet_already_used'), { parse_mode: 'HTML' });
    return;
  }
  if (PROCESSING_TXIDS.has(orderId)) {
    await bot.sendMessage(chatId, t(lang, 'wallet_already_processing'), { parse_mode: 'HTML' });
    return;
  }

  PROCESSING_TXIDS.add(orderId);

  let waitMsgId = null;
  try {
    const wait = await bot.sendMessage(chatId, t(lang, 'wallet_verifying'), { parse_mode: 'HTML' });
    waitMsgId = wait.message_id;

    // Wrap verification with timeout to prevent hanging
    const VERIFY_TIMEOUT = 35000; // 35 sec
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('TIMEOUT')), VERIFY_TIMEOUT)
    );
    let result;
    try {
      result = await Promise.race([verifyBinancePayOrder(orderId), timeoutPromise]);
    } catch (err) {
      if (waitMsgId) await bot.deleteMessage(chatId, waitMsgId).catch(() => {});
      await bot.sendMessage(chatId,
        '⚠️ <b>Verification timed out.</b>\n\nBinance is slow to respond. Please try again in a moment.\n\n' +
        'If the problem persists, contact support.',
        { parse_mode: 'HTML' }
      );
      session.clear(userId);
      return;
    }

    if (waitMsgId) await bot.deleteMessage(chatId, waitMsgId).catch(() => {});

    if (db.isTxidUsed(orderId)) {
      await bot.sendMessage(chatId, t(lang, 'wallet_already_used'), { parse_mode: 'HTML' });
      return;
    }

    if (!result.found) {
      await bot.sendMessage(chatId, result.message, { parse_mode: 'HTML' });
      return;
    }

    if (String(result.currency).toUpperCase() !== 'USDT') {
      await bot.sendMessage(chatId, `❌ Only USDT is accepted. Got ${result.currency}.`, { parse_mode: 'HTML' });
      return;
    }

    await creditFromVerifiedDeposit(bot, chatId, userId, {
      identifier: orderId,
      amount: result.amount,
      network: 'BinancePay',
      asset:   'USDT',
      address: null,
      method:  'Binance Pay',
    });
  } finally {
    PROCESSING_TXIDS.delete(orderId);
  }
}

/**
 * CryptoBot — user typed an amount. Create invoice and send link.
 */
async function handleCryptobotAmount(bot, msg) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const text   = (msg.text || '').trim();
  const sess   = session.get(userId);
  const asset  = (sess.data && sess.data.asset) || 'USDT';

  const wantedAmount = parseFloat(text.replace(',', '.'));
  if (isNaN(wantedAmount) || wantedAmount < MIN_DEPOSIT) {
    await bot.sendMessage(chatId, `❌ Enter a valid amount (minimum <b>${MIN_DEPOSIT} ${asset}</b>).`, { parse_mode: 'HTML' });
    return;
  }
  if (wantedAmount > 10000) {
    await bot.sendMessage(chatId, '❌ Single top-up cannot exceed 10,000 USDT. Please contact support for larger amounts.');
    return;
  }

  // Apply CryptoBot FIXED fee on the customer (so we receive the full wantedAmount)
  // CryptoBot charges a fixed amount per transaction (default: 0.01 USDT)
  // Configurable via setting 'cryptobot_fee_fixed'
  const fee = parseFloat(db.getSetting('cryptobot_fee_fixed', '0.01')) || 0;
  const amount = Number((wantedAmount + fee).toFixed(2));

  let invoice;
  try {
    invoice = await cryptobot.createInvoice({
      amount,
      asset,
      payload: `topup:${userId}:${wantedAmount}`,
      description: `Wallet top-up: ${wantedAmount} ${asset} (incl. ${fee} ${asset} fee)`,
    });
  } catch (e) {
    logger.error(`CryptoBot createInvoice failed: ${e.message}`);
    await bot.sendMessage(chatId, '❌ Could not create invoice. Please try again later.', { parse_mode: 'HTML' });
    return;
  }

  // Save invoice
  try {
    db.saveCryptobotInvoice({
      invoiceId: invoice.invoice_id,
      userId,
      asset,
      amount,
      payUrl: invoice.bot_invoice_url || invoice.pay_url,
    });
  } catch (e) {
    logger.warn(`Invoice save failed: ${e.message}`);
  }

  session.clear(userId);

  const payUrl = invoice.bot_invoice_url || invoice.mini_app_invoice_url || invoice.pay_url;

  await bot.sendMessage(
    chatId,
    `✅ <b>Invoice Created</b>\n\n` +
    `💵 <b>You'll be credited:</b> ${wantedAmount} ${asset}\n` +
    `💳 <b>Total to pay:</b> ${amount} ${asset}` +
    (fee > 0 ? `\n💸 <i>CryptoBot fee: ${fee} ${asset}</i>` : '') + `\n` +
    `🆔 Invoice ID: <code>${invoice.invoice_id}</code>\n` +
    `⏰ Expires in 1 hour\n\n` +
    `👇 Tap the button to pay via @CryptoBot.\n` +
    `Your wallet will be credited automatically after payment.`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '💰 Pay Now', url: payUrl }],
          [{ text: '🔙 Back to Wallet', callback_data: 'menu_wallet' }],
        ],
      },
    }
  );
}

/**
 * Tell the admin about a deposit that could not be auto-credited.
 * Deduped on the TxID, so retries by the same user do not spam.
 */
async function notifyDepositReview(bot, userId, txid, result, reason) {
  try {
    const { notifyAdmin } = require('../services/adminNotify');
    const review = db.getDepositReviewByTxid(txid);
    const user   = db.getUser(userId);
    const who    = user?.username ? `@${user.username}` : (user?.first_name || `User ${userId}`);

    await notifyAdmin(bot, {
      type:  'refund_request', // reuses the existing notification centre channel
      title: 'Deposit needs manual review',
      body:
        `⚠️ <b>Reason:</b> ${reason}\n\n` +
        `👤 <b>Submitted by:</b> ${who}\n` +
        `🆔 <code>${userId}</code>\n` +
        `💵 <b>Amount:</b> ${Number(result.amount).toFixed(6)} USDT\n` +
        `🌐 <b>Network:</b> ${result.network}\n` +
        `🔗 <b>TxID:</b> <code>${txid}</code>`,
      dedupeKey: `deposit_review:${txid}`,
      refType:   'deposit_review',
      refId:     review ? review.id : null,
      buttons: review
        ? [[{ text: '🔍 Review deposit', callback_data: `admin_dep_view_${review.id}` }]]
        : null,
    });
  } catch (e) {
    logger.warn(`notifyDepositReview failed: ${e.message}`);
  }
}

// ── Shared crediting helper for Binance-verified deposits ─────────────────────

async function creditFromVerifiedDeposit(bot, chatId, userId, info) {
  const { identifier, amount, network, asset, address, method } = info;

  const safeAmount = Number(Number(amount).toFixed(6));
  if (safeAmount + 1e-9 < MIN_DEPOSIT) {
    await bot.sendMessage(
      chatId,
      `❌ Minimum deposit is <b>${MIN_DEPOSIT} USDT</b>.\nReceived: <b>${safeAmount.toFixed(6)} USDT</b>.`,
      { parse_mode: 'HTML' }
    );
    return;
  }
  // Sanity cap: single deposit cannot exceed $50,000
  if (safeAmount > 50000) {
    logger.warn(`Deposit blocked — amount ${safeAmount} exceeds cap for user ${userId}`);
    await bot.sendMessage(chatId, '❌ Deposit amount exceeds the allowed limit. Contact support.', { parse_mode: 'HTML' });
    return;
  }

  let usedId;
  try {
    usedId = db.saveUsedTxid({
      txid: identifier,
      userId,
      amount: safeAmount,
      network,
      asset,
      address: address || null,
    });
  } catch (e) {
    logger.warn(`Duplicate deposit ID blocked: ${identifier} — ${e.message}`);
    await bot.sendMessage(chatId, '❌ This deposit has already been credited.', { parse_mode: 'HTML' });
    return;
  }

  db.updateBalance(userId, safeAmount);
  db.addTransaction({
    userId, type: 'deposit', amount: safeAmount,
    description: `${method} top-up`,
    refId: identifier, orderId: null,
  });

  session.clear(userId);

  const fresh      = db.getUser(userId);
  const newBalance = fresh?.balance || safeAmount;

  await bot.sendMessage(
    chatId,
    `✅ <b>Deposit Verified!</b>\n\n` +
    `💵 <b>Amount:</b> ${formatPrice(safeAmount)} USDT\n` +
    `💳 <b>Method:</b> ${method}\n` +
    `💰 <b>New Balance:</b> ${formatPrice(newBalance)}\n\n` +
    `Your wallet has been credited successfully.`,
    { parse_mode: 'HTML', reply_markup: walletMenuKb() }
  );

  logger.info(`Top-up credited: user=${userId} amount=${safeAmount} method=${method} id=${identifier}`);

  for (const adminId of config.adminIds) {
    bot.sendMessage(
      adminId,
      `💰 <b>Wallet Top-up</b>\n\n` +
      `👤 User: <code>${userId}</code>\n` +
      `💵 Amount: <b>${formatPrice(safeAmount)} USDT</b>\n` +
      `💳 Method: <b>${method}</b>\n` +
      `🧾 ID: <code>${identifier}</code>\n` +
      `💰 New Balance: ${formatPrice(newBalance)}`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
  }
}

// ── CryptoBot webhook → credit wallet ─────────────────────────────────────────

async function creditCryptobotPayment(bot, invoiceId, paidAsset, paidAmount, fallbackUserId = null) {
  const inv = db.getCryptobotInvoice(invoiceId);
  if (!inv) {
    logger.warn(`CryptoBot webhook for unknown invoice ${invoiceId}`);
    return false;
  }
  if (inv.credited) {
    logger.info(`CryptoBot invoice ${invoiceId} already credited — skipping.`);
    return false;
  }

  const userId = inv.user_id || fallbackUserId;
  if (!userId) return false;

  const wasFirst = db.markCryptobotInvoicePaid(invoiceId);
  if (!wasFirst) return false; // another worker beat us

  // Safety: cap credited amount to the invoice amount (never credit more than invoiced)
  const invoicedAmount = Number(inv.amount) || 0;
  const rawAmount = Number(Number(paidAmount).toFixed(6));
  const amount = invoicedAmount > 0 ? Math.min(rawAmount, invoicedAmount) : rawAmount;
  if (amount <= 0) {
    logger.warn(`CryptoBot invoice ${invoiceId} — invalid credit amount ${amount}, skip`);
    return false;
  }

  db.updateBalance(userId, amount);
  db.addTransaction({
    userId, type: 'deposit', amount,
    description: `CryptoBot ${paidAsset} top-up`,
    refId: `cryptobot:${invoiceId}`,
    orderId: null,
  });

  const fresh = db.getUser(userId);
  const newBalance = fresh?.balance || amount;

  try {
    await bot.sendMessage(
      userId,
      `✅ <b>Top-up Received!</b>\n\n` +
      `💵 <b>Amount:</b> ${amount} ${paidAsset}\n` +
      `💳 <b>Via:</b> CryptoBot\n` +
      `💰 <b>New Balance:</b> ${formatPrice(newBalance)}`,
      { parse_mode: 'HTML', reply_markup: walletMenuKb() }
    );
  } catch (e) {
    logger.warn(`Could not DM user ${userId} after CryptoBot payment: ${e.message}`);
  }

  for (const adminId of config.adminIds) {
    bot.sendMessage(
      adminId,
      `💰 <b>Wallet Top-up (CryptoBot)</b>\n\n` +
      `👤 User: <code>${userId}</code>\n` +
      `💵 Amount: <b>${amount} ${paidAsset}</b>\n` +
      `🆔 Invoice: <code>${invoiceId}</code>\n` +
      `💰 New Balance: ${formatPrice(newBalance)}`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
  }

  logger.info(`CryptoBot top-up credited: user=${userId} amount=${amount} ${paidAsset} invoice=${invoiceId}`);
  return true;
}

// ── Transactions ──────────────────────────────────────────────────────────────

async function showTransactions(bot, chatId, userId, messageId) {
  const txns = db.getUserTransactions(userId);

  if (!txns.length) {
    await bot.editMessageText(
      '📜 <b>Transaction History</b>\n\nNo transactions yet.',
      { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: backKb('menu_wallet') }
    );
    return;
  }

  const typeEmoji = {
    deposit: '➕', purchase: '🛒', refund: '↩️', referral: '👥',
    admin_credit: '🛠', admin_debit: '🛠',
  };
  const lines = txns.slice(0, 15).map((tx) => {
    const emoji = typeEmoji[tx.type] || '💵';
    const sign  = tx.amount > 0 ? '+' : '';
    return `${emoji} ${sign}${formatPrice(tx.amount)} — ${(tx.description || '').slice(0, 32)}\n<i>${(tx.created_at || '').slice(0, 10)}</i>`;
  });

  await bot.editMessageText(
    `📜 <b>Transaction History</b>\n\n${lines.join('\n\n')}`,
    { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: backKb('menu_wallet') }
  );
}

module.exports = {
  startUsdtAmount,
  handleUsdtAmount,

  showWallet,
  showTopupMethods,
  startUsdtTopup,
  startBinancePayTopup,
  startCryptobotTopup,
  handleUsdtTxId,
  handleBinancePayOrderId,
  handleCryptobotAmount,
  creditCryptobotPayment,
  showTransactions,
};
