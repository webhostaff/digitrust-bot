'use strict';
/**
 * DigiPro activation bot ↔ store link (V167.7).
 *
 * DigiPro is a separate service (its own bot, its own price list). The store
 * stays the single owner of the WALLET: DigiPro never holds money, it asks the
 * store to charge a customer's wallet for a code it is about to issue.
 *
 *   POST /internal/digipro/balance  { user_id }
 *   POST /internal/digipro/charge   { user_id, amount_cents, ref, title }
 *   POST /internal/digipro/refund   { user_id, amount_cents, ref }
 *
 * Auth: HMAC-SHA256 with DIGIPRO_SECRET over  "<ts>|<action>|<user_id>|<amount_cents>|<ref>"
 * sent as X-Digipro-Ts (unix seconds, ±5 min) and X-Digipro-Sign (hex).
 * Money is only ever moved by integer cents, and `ref` makes a charge idempotent:
 * a retried request never charges twice.
 */
const crypto = require('crypto');

const REF_RE = /^[A-Za-z0-9_-]{8,64}$/;
const SKEW_S = 300;

function sign(secret, ts, action, userId, cents, ref) {
  return crypto.createHmac('sha256', secret)
    .update(`${ts}|${action}|${userId}|${cents}|${ref}`).digest('hex');
}

function safeEqualHex(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** @returns an express-compatible handler for one action. */
function makeHandler(action, { secret, queries, dbRaw, notifyAdmins, logger, maxCents = 50000, now = () => Date.now() }) {
  return async function digiproHandler(req, res) {
    try {
      const b = req.body || {};
      const userId = Number(b.user_id);
      const cents = action === 'balance' ? 0 : Number(b.amount_cents);
      const ref = action === 'balance' ? '' : String(b.ref || '');
      const ts = String(req.get('X-Digipro-Ts') || '');

      if (!secret) return res.status(503).json({ ok: false, reason: 'not_configured' });
      if (!Number.isInteger(userId) || userId <= 0) return res.status(400).json({ ok: false, reason: 'bad_user' });
      if (!/^\d{9,12}$/.test(ts) || Math.abs(Math.floor(now() / 1000) - Number(ts)) > SKEW_S) {
        return res.status(401).json({ ok: false, reason: 'bad_time' });
      }
      const expected = sign(secret, ts, action, userId, cents, ref);
      if (!safeEqualHex(req.get('X-Digipro-Sign'), expected)) {
        logger.warn(`[digipro] ${action} rejected: bad signature (user ${userId})`);
        return res.status(401).json({ ok: false, reason: 'bad_signature' });
      }

      const user = queries.getUser(userId);
      if (action === 'balance') {
        if (!user) return res.json({ ok: true, exists: false, balance_cents: 0 });
        return res.json({ ok: true, exists: true, banned: !!user.is_banned, balance_cents: Math.round((Number(user.balance) || 0) * 100) });
      }

      if (!Number.isInteger(cents) || cents < 1 || cents > maxCents) return res.status(400).json({ ok: false, reason: 'bad_amount' });
      if (!REF_RE.test(ref)) return res.status(400).json({ ok: false, reason: 'bad_ref' });
      if (!user) return res.json({ ok: false, reason: 'no_account' });
      if (user.is_banned) return res.json({ ok: false, reason: 'banned' });

      const amount = cents / 100;
      const balCents = () => Math.round((Number(queries.getUser(userId)?.balance) || 0) * 100);
      const chargeKey = `digipro:${ref}`;
      const original = dbRaw.prepare('SELECT user_id, amount FROM transactions WHERE ref_id = ?').get(chargeKey);

      if (action === 'charge') {
        if (original) {
          const same = Number(original.user_id) === userId && Math.round(Math.abs(original.amount) * 100) === cents;
          if (!same) return res.status(409).json({ ok: false, reason: 'ref_conflict' });
          return res.json({ ok: true, duplicate: true, balance_cents: balCents() });   // retried request — never charge twice
        }
        const title = String(b.title || 'Activation code').slice(0, 80);
        const r = queries.chargeWallet(userId, amount, { type: 'digipro', description: `DigiPro — ${title}`, refId: chargeKey });
        if (!r.ok) return res.json({ ok: false, reason: r.reason || 'insufficient', balance_cents: Math.round((Number(r.balance) || 0) * 100) });
        logger.info(`[digipro] charged user=${userId} $${amount.toFixed(2)} ref=${ref} (${title})`);
        Promise.resolve(notifyAdmins && notifyAdmins(`🔑 <b>DigiPro sale</b>\n👤 <code>${userId}</code>\n📦 ${title.replace(/[<>&]/g, '')}\n💵 $${amount.toFixed(2)}\n💰 Balance left: $${(Math.round((Number(r.balance) || 0) * 100) / 100).toFixed(2)}`)).catch(() => {});
        return res.json({ ok: true, balance_cents: Math.round((Number(r.balance) || 0) * 100) });
      }

      if (action === 'refund') {
        if (!original || Number(original.user_id) !== userId || Math.round(Math.abs(original.amount) * 100) !== cents) {
          return res.status(404).json({ ok: false, reason: 'no_matching_charge' });
        }
        const refundKey = `digipro_refund:${ref}`;
        if (dbRaw.prepare('SELECT 1 FROM transactions WHERE ref_id = ?').get(refundKey)) {
          return res.json({ ok: true, duplicate: true, balance_cents: balCents() });
        }
        queries.refundWallet(userId, amount, { type: 'refund', description: 'DigiPro — code could not be issued', refId: refundKey });
        logger.info(`[digipro] refunded user=${userId} $${amount.toFixed(2)} ref=${ref}`);
        return res.json({ ok: true, balance_cents: balCents() });
      }
      return res.status(404).json({ ok: false, reason: 'unknown_action' });
    } catch (e) {
      logger.error(`[digipro] ${action} failed: ${e.message}`);
      return res.status(500).json({ ok: false, reason: 'server_error' });
    }
  };
}

function mount(app, deps) {
  for (const a of ['balance', 'charge', 'refund']) app.post(`/internal/digipro/${a}`, makeHandler(a, deps));
}

module.exports = { mount, makeHandler, sign };
