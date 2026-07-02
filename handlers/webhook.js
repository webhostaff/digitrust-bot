'use strict';

/**
 * Express router — handles incoming HTTP traffic.
 *
 * Endpoints:
 *   GET  /health           — uptime probe
 *   GET  /                 — service status
 *   POST /cryptobot/webhook — CryptoBot payment notifications
 *
 * The CryptoBot webhook fires when an invoice transitions to `paid`.
 * We verify the HMAC signature, then credit the user's wallet exactly once
 * (the `cryptobot_invoices.credited` flag is the source of truth).
 */

const express  = require('express');
const cryptobot = require('../services/cryptobot');
const db        = require('../database/queries');
const dbRaw     = require('../database/db');   // raw SQLite — needed for db.prepare() calls
const logger    = require('../utils/logger');

module.exports = function makeRouter(bot) {
  const router = express.Router();

  router.get('/health', (_req, res) => res.json({ status: 'ok' }));
  router.get('/',       (_req, res) => res.json({ service: 'digitrust-bot', status: 'running' }));

  // CryptoBot webhook — must use raw body for signature verification.
  router.post(
    '/cryptobot/webhook',
    express.raw({ type: '*/*' }),
    async (req, res) => {
      const rawBody  = req.body && Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
      const sigHdr   = req.header('crypto-pay-api-signature');

      // Verify HMAC
      if (!cryptobot.verifyWebhookSignature(sigHdr, rawBody)) {
        logger.warn('CryptoBot webhook: invalid signature');
        return res.status(401).json({ ok: false, error: 'bad signature' });
      }

      let payload;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        return res.status(400).json({ ok: false, error: 'bad json' });
      }

      // We only care about invoice_paid updates
      if (payload.update_type !== 'invoice_paid') {
        return res.json({ ok: true, ignored: payload.update_type });
      }

      const inv = payload.payload || {};
      const invoiceId = inv.invoice_id;
      const asset     = inv.asset;
      // Use paid_amount (what we received after CryptoBot fee)
      // Invoice amount already includes the $0.01 fee added at order creation
      const paidAmount = Number(inv.paid_amount != null ? inv.paid_amount : inv.amount);

      if (!invoiceId || !Number.isFinite(paidAmount) || paidAmount <= 0) {
        return res.status(400).json({ ok: false, error: 'bad payload' });
      }

      const payloadStr = String(inv.payload || '');

      try {
        // ── DIRECT ORDER PAYMENT (payload = "order:ORDERID:USERID") ─────────
        // Use invoiceAmount (not paidAmount) so CryptoBot fee doesn't cause underpayment
        if (payloadStr.startsWith('order:')) {
          // Mark invoice as paid FIRST to prevent duplicate processing
          let alreadyProcessed = false;
          try {
            const wasFirst = db.markCryptobotInvoicePaid(invoiceId);
            if (!wasFirst) {
              alreadyProcessed = true;
              logger.info(`CryptoBot order invoice ${invoiceId} already processed — ignoring duplicate webhook`);
            }
          } catch (e) {
            logger.error(`markCryptobotInvoicePaid error: ${e.message}`);
          }

          if (!alreadyProcessed) {
            // Both the regular store AND the ChatGPT Business bot create orders
            // with this exact "order:ID:USER" payload format, since they share
            // the same `orders` table. We must check which one this order
            // actually belongs to before picking a delivery system — routing
            // a ChatGPT Business order into the regular store's stock-delivery
            // logic looks for stock that doesn't exist, reports a false
            // "out of stock", and never runs the ChatGPT Business bot's own
            // customer/admin notifications.
            const m = payloadStr.match(/^order:(\d+):(\d+)$/);
            const parsedOrderId = m ? parseInt(m[1], 10) : null;
            const parsedUserId  = m ? parseInt(m[2], 10) : null;

            let isCgbOrder = false;
            if (parsedOrderId !== null) {
              try {
                const orderRow = dbRaw.prepare(
                  `SELECT o.id, p.is_chatgpt_business
                   FROM orders o
                   JOIN products p ON p.id = o.product_id
                   WHERE o.id = ?`
                ).get(parsedOrderId);
                isCgbOrder = !!(orderRow && orderRow.is_chatgpt_business);
              } catch (e) {
                logger.error(`webhook: failed to classify order #${parsedOrderId}: ${e.message}`);
              }
            }

            if (isCgbOrder) {
              try {
                const chatgptBot = require('../chatgpt-bot');
                if (chatgptBot && typeof chatgptBot.confirmCryptobotPayment === 'function') {
                  await chatgptBot.confirmCryptobotPayment(invoiceId, paidAmount, parsedOrderId, parsedUserId);
                } else {
                  logger.error('webhook: ChatGPT Business bot is not loaded — cannot confirm CryptoBot payment for order #' + parsedOrderId);
                }
              } catch (e) {
                logger.error(`confirmCryptobotPayment failed: ${e.message}`);
              }
            } else {
              const buyHandler = require('./buy');
              try {
                await buyHandler.deliverCryptobotOrder(bot, invoiceId, paidAmount, payloadStr);
              } catch (e) {
                logger.error(`deliverCryptobotOrder failed: ${e.message}`);
              }
            }
          }
          // ALWAYS return — never credit wallet for an order payment
          return res.json({ ok: true });
        }

        // ── WALLET TOP-UP ONLY (payload starts with "topup:") ───────────────
        // New format: payload = "topup:USERID:WANTED_AMOUNT"
        // Old format: payload = "topup:USERID"
        let userId = null;
        let wantedAmount = null;
        let m = payloadStr.match(/^topup:(\d+):([\d.]+)$/);
        if (m) {
          userId = parseInt(m[1], 10);
          wantedAmount = parseFloat(m[2]);
        } else {
          m = payloadStr.match(/^topup:(\d+)$/);
          if (m) userId = parseInt(m[1], 10);
        }

        // For topup: credit what user wanted (if known), otherwise what we received after fee
        const creditAmount = wantedAmount !== null ? wantedAmount : paidAmount;

        const walletHandler = require('./wallet');
        await walletHandler.creditCryptobotPayment(bot, invoiceId, asset, creditAmount, userId);
      } catch (e) {
        logger.error(`CryptoBot credit error: ${e.message}`);
        return res.status(500).json({ ok: false, error: 'internal' });
      }

      return res.json({ ok: true });
    }
  );

  return router;
};
