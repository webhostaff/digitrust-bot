'use strict';
/**
 * Verif bot ↔ store SHARED WALLET link (V167.36).
 *
 * The store owns the wallet. The Verif (Gemini) bot uses the SAME wallet, so a
 * customer's balance is shared between both bots: topping up in either place
 * raises the one balance, and a verification in Verif charges it.
 *
 *   POST /internal/verif/balance  { user_id }
 *   POST /internal/verif/charge   { user_id, amount_cents, ref, title }
 *   POST /internal/verif/refund   { user_id, amount_cents, ref }
 *   POST /internal/verif/deposit  { user_id, network }     → reserves a unique
 *        USDT amount on the store's OWN address; the store's chain scanner then
 *        detects the transfer and credits the shared wallet automatically.
 *
 * Auth: HMAC-SHA256 with VERIF_WALLET_SECRET over "<ts>|<action>|<user_id>|<cents>|<ref>"
 * in X-Verif-Ts (unix s, ±5 min) and X-Verif-Sign (hex). Money moves in integer
 * cents only; `ref` makes a charge/refund idempotent.
 */
const crypto = require('crypto');

const REF_RE = /^[A-Za-z0-9_:-]{6,80}$/;
const SKEW_S = 300;
const NETS = { BEP20: 'usdtBep20Address', TRC20: 'usdtTrc20Address', ERC20: 'usdtErc20Address', SOL: 'usdtSolAddress', TON: 'usdtTonAddress' };

function sign(secret, ts, action, userId, cents, ref) {
  return crypto.createHmac('sha256', secret).update(`${ts}|${action}|${userId}|${cents}|${ref}`).digest('hex');
}
function safeEqualHex(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8'), y = Buffer.from(String(b || ''), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function makeHandler(action, { secret, queries, dbRaw, config, notifyAdmins, logger, maxCents = 50000, now = () => Date.now() }) {
  return async function verifHandler(req, res) {
    try {
      const b = req.body || {};
      const userId = Number(b.user_id);
      const cents = (action === 'balance' || action === 'deposit') ? 0 : Number(b.amount_cents);
      const ref = (action === 'balance' || action === 'deposit') ? '' : String(b.ref || '');
      const ts = String(req.get('X-Verif-Ts') || '');

      if (!secret) return res.status(503).json({ ok: false, reason: 'not_configured' });
      if (!Number.isInteger(userId) || userId <= 0) return res.status(400).json({ ok: false, reason: 'bad_user' });
      if (!/^\d{9,12}$/.test(ts) || Math.abs(Math.floor(now() / 1000) - Number(ts)) > SKEW_S) {
        return res.status(401).json({ ok: false, reason: 'bad_time' });
      }
      if (!safeEqualHex(req.get('X-Verif-Sign'), sign(secret, ts, action, userId, cents, ref))) {
        logger.warn(`[verif-wallet] ${action} rejected: bad signature (user ${userId})`);
        return res.status(401).json({ ok: false, reason: 'bad_signature' });
      }

      const user = queries.getUser(userId);

      if (action === 'balance') {
        if (!user) return res.json({ ok: true, exists: false, balance_cents: 0 });
        return res.json({ ok: true, exists: true, banned: !!user.is_banned, balance_cents: Math.round((Number(user.balance) || 0) * 100) });
      }

      if (action === 'deposit') {
        const network = String(b.network || 'BEP20').toUpperCase();
        const addrKey = NETS[network];
        const address = addrKey ? String(config[addrKey] || '').trim() : '';
        if (!address) return res.json({ ok: false, reason: 'network_unavailable' });
        const base = Math.max(1, Math.round((Number(b.base_amount) || 1) * 100) / 100); // dollars
        try {
          const intent = queries.createDepositIntent(userId, network, base, Number(process.env.DEPOSIT_TTL_MIN) || 60);
          return res.json({ ok: true, network, address, amount: intent.unique_amount, ttl_min: Number(process.env.DEPOSIT_TTL_MIN) || 60 });
        } catch (e) {
          logger.warn(`[verif-wallet] deposit intent failed: ${e.message}`);
          return res.json({ ok: false, reason: 'intent_failed' });
        }
      }

      if (!Number.isInteger(cents) || cents < 1 || cents > maxCents) return res.status(400).json({ ok: false, reason: 'bad_amount' });
      if (!REF_RE.test(ref)) return res.status(400).json({ ok: false, reason: 'bad_ref' });
      if (!user) return res.json({ ok: false, reason: 'no_account' });
      if (user.is_banned) return res.json({ ok: false, reason: 'banned' });

      const amount = cents / 100;
      const balCents = () => Math.round((Number(queries.getUser(userId)?.balance) || 0) * 100);
      const chargeKey = `verif:${ref}`;
      const original = dbRaw.prepare('SELECT user_id, amount FROM transactions WHERE ref_id = ?').get(chargeKey);

      if (action === 'charge') {
        if (original) {
          const same = Number(original.user_id) === userId && Math.round(Math.abs(original.amount) * 100) === cents;
          if (!same) return res.status(409).json({ ok: false, reason: 'ref_conflict' });
          return res.json({ ok: true, duplicate: true, balance_cents: balCents() });
        }
        const title = String(b.title || 'Gemini Verification').slice(0, 80);
        const r = queries.chargeWallet(userId, amount, { type: 'verif', description: `Verif — ${title}`, refId: chargeKey });
        if (!r.ok) return res.json({ ok: false, reason: r.reason || 'insufficient', balance_cents: Math.round((Number(r.balance) || 0) * 100) });
        logger.info(`[verif-wallet] charged user=${userId} $${amount.toFixed(2)} ref=${ref}`);
        Promise.resolve(notifyAdmins && notifyAdmins(`🤖 <b>Verif sale</b>\n👤 <code>${userId}</code>\n💵 $${amount.toFixed(2)}\n💰 Left: $${(Math.round((Number(r.balance) || 0) * 100) / 100).toFixed(2)}`)).catch(() => {});
        // Mirror as a delivered order in the customer's history.
        try {
          const pid = Number(process.env.VERIF_PRODUCT_ID) || 0;
          if (pid) queries.createVerifOrder({ userId, productId: pid, totalPrice: amount, title, status: 'delivered', ref });
        } catch (_) {}
        return res.json({ ok: true, balance_cents: Math.round((Number(r.balance) || 0) * 100) });
      }

      if (action === 'refund') {
        if (!original || Number(original.user_id) !== userId || Math.round(Math.abs(original.amount) * 100) !== cents) {
          return res.status(404).json({ ok: false, reason: 'no_matching_charge' });
        }
        const refundKey = `verif_refund:${ref}`;
        if (dbRaw.prepare('SELECT 1 FROM transactions WHERE ref_id = ?').get(refundKey)) {
          return res.json({ ok: true, duplicate: true, balance_cents: balCents() });
        }
        queries.refundWallet(userId, amount, { type: 'refund', description: 'Verif — verification failed', refId: refundKey });
        logger.info(`[verif-wallet] refunded user=${userId} $${amount.toFixed(2)} ref=${ref}`);
        return res.json({ ok: true, balance_cents: balCents() });
      }
      return res.status(404).json({ ok: false, reason: 'unknown_action' });
    } catch (e) {
      logger.error(`[verif-wallet] ${action} failed: ${e.message}`);
      return res.status(500).json({ ok: false, reason: 'server_error' });
    }
  };
}

function mount(app, deps) {
  for (const a of ['balance', 'charge', 'refund', 'deposit']) app.post(`/internal/verif/${a}`, makeHandler(a, deps));
}

module.exports = { mount, makeHandler, sign };
