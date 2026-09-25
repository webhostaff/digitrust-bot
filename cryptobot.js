'use strict';

/**
 * CryptoBot HTTP API service.
 * Docs: https://help.crypt.bot/crypto-pay-api
 *
 * Used for wallet top-ups only. The flow:
 *   1. User chooses amount → bot calls createInvoice() → gets pay_url
 *   2. User pays via @CryptoBot on Telegram
 *   3. CryptoBot calls our webhook → handler credits wallet
 *   4. (Backup) bot can also poll getInvoice() to verify
 *
 * Required env vars:
 *   CRYPTOBOT_TOKEN          - the API token from @CryptoBot
 *   CRYPTOBOT_WEBHOOK_SECRET - optional secret for webhook signature verification
 */

const axios  = require('axios');
const crypto = require('crypto');
const config = require('../config');
const logger = require('../utils/logger');

const BASE_URL = 'https://pay.crypt.bot/api';

/**
 * Generic POST to CryptoBot API.
 */
async function callApi(method, payload = {}) {
  if (!config.cryptobotToken) {
    throw new Error('CRYPTOBOT_TOKEN not configured');
  }

  const url = `${BASE_URL}/${method}`;
  const { data } = await axios.post(url, payload, {
    headers: {
      'Crypto-Pay-API-Token': config.cryptobotToken,
      'Content-Type': 'application/json',
    },
    timeout: 15000,
  });

  if (!data.ok) {
    const err = data.error || {};
    throw new Error(`CryptoBot ${method} failed: ${err.code} ${err.name}`);
  }
  return data.result;
}

/**
 * Create an invoice for a user to pay.
 * @param {object} opts
 *   amount   - number, in `asset` units (e.g. 10.5)
 *   asset    - 'USDT' (default) | 'TON' | 'BTC' | 'ETH' | 'BNB' | 'TRX' | 'LTC'
 *   payload  - arbitrary string returned in webhook (we use `userId:invoiceId`)
 *   description
 *
 * Returns the invoice object:
 *   { invoice_id, status, pay_url, bot_invoice_url, mini_app_invoice_url, ... }
 */
async function createInvoice({ amount, asset = 'USDT', payload, description }) {
  return callApi('createInvoice', {
    asset,
    amount: String(amount),
    description: description || 'Wallet top-up',
    payload: payload || '',
    paid_btn_name: 'callback',
    paid_btn_url:  config.cryptobotBotUrl || 'https://t.me',
    allow_anonymous: false,
    allow_comments:  false,
    expires_in: 3600, // 1 hour
  });
}

/**
 * Fetch invoice(s) for verification — useful as a backup if webhook didn't fire.
 */
async function getInvoice(invoiceId) {
  const res = await callApi('getInvoices', {
    invoice_ids: String(invoiceId),
    count: 1,
  });
  const list = (res && res.items) || res || [];
  return Array.isArray(list) ? list[0] : null;
}

/**
 * Get app info (used to verify the token works on bot startup).
 */
async function getMe() {
  return callApi('getMe', {});
}

/**
 * Verify webhook signature from CryptoBot.
 * Header: crypto-pay-api-signature
 * Computed: HMAC-SHA256(secret_key, body) where secret_key = SHA256(api_token).
 */
function verifyWebhookSignature(signatureHeader, rawBody) {
  if (!config.cryptobotToken) return false;
  if (!signatureHeader) return false;

  try {
    const secretKey = crypto
      .createHash('sha256')
      .update(config.cryptobotToken)
      .digest();

    const expected = crypto
      .createHmac('sha256', secretKey)
      .update(rawBody)
      .digest('hex');

    return crypto.timingSafeEqual(
      Buffer.from(signatureHeader, 'utf8'),
      Buffer.from(expected, 'utf8')
    );
  } catch (e) {
    logger.warn(`CryptoBot signature check error: ${e.message}`);
    return false;
  }
}

module.exports = {
  createInvoice,
  getInvoice,
  getMe,
  verifyWebhookSignature,
};
