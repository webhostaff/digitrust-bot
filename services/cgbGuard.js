'use strict';

/**
 * services/cgbGuard.js
 * ====================
 * The bridge to the separate "ChatGPT Business Guard" bot (a different
 * Node/Python project on its own Railway service), which owns the actual
 * ChatGPT Business admin panel(s), buys seats, and sends invites.
 *
 * Two directions, ONE shared secret (set the SAME string as GUARD_SECRET
 * here and as AUTO_INVITE_SECRET on the guard's side):
 *
 *   OUTBOUND  notifyGuardOfNewInvite(email)
 *     Called right after a ChatGPT Business order is confirmed (paid), so
 *     the email joins the guard's persistent 10-minute batch queue — the
 *     exact same queue /addManual and its own Telegram button feed. This
 *     never throws: the guard being briefly unreachable must not break
 *     payment confirmation, so failures are logged and nothing more.
 *
 *   INBOUND   handleGuardCallback(req, res)  (mounted as an Express route)
 *     The guard calls this back once a batch is verified in Pending
 *     invites (success) or fails (seat purchase / invite / verification
 *     failure), one call per email. On success this activates the
 *     matching seat automatically (chatgpt-bot.js's activateAndNotifySeat)
 *     instead of the admin needing to notice and tap "Activate" by hand —
 *     that repaints the order card green and messages the customer. On
 *     failure the admin gets a Telegram alert with the reason instead.
 *
 * Both directions are OFF (no-ops) unless their respective env vars are
 * set, so an owner who hasn't set up the guard bot yet sees no behavior
 * change at all.
 */

const logger = require('../utils/logger');

/**
 * Forgive the usual copy-paste mistakes in GUARD_AUTO_INVITE_URL (a real case
 * logged "Invalid URL" on every paid order): surrounding quotes or spaces, no
 * "https://", or just the domain without "/auto-invite". Anything still not a
 * valid address is kept as typed so the startup log and /guardtest can show
 * the owner exactly what is wrong with it (e.g. a literal "<...>" left from
 * the example).
 */
function normalizeGuardUrl(raw) {
  let v = String(raw || '').trim().replace(/^['"\s]+|['"\s]+$/g, '');
  if (!v) return '';
  if (!/^https?:\/\//i.test(v)) v = 'https://' + v.replace(/^\/+/, '');
  try {
    const u = new URL(v);
    if (!u.hostname.includes('.')) return String(raw).trim();
    if (u.pathname === '/' || u.pathname === '') u.pathname = '/auto-invite';
    return u.toString();
  } catch (_) {
    return String(raw).trim();
  }
}
const GUARD_URL_RAW = process.env.GUARD_AUTO_INVITE_URL || '';
const GUARD_URL    = normalizeGuardUrl(GUARD_URL_RAW);
function guardUrlValid() { try { new URL(GUARD_URL); return true; } catch (_) { return false; } }      // e.g. https://chatgpt-business-guard-production.up.railway.app/auto-invite
const GUARD_PANEL   = (process.env.GUARD_PANEL_ID || '').trim();            // e.g. panel26 — omit if the guard only has one panel
const SHARED_SECRET = (process.env.GUARD_SECRET || '').trim();
const FETCH_TIMEOUT_MS = 10000;

async function fetchWithTimeout(url, opts) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/**
 * Tell the guard bot a new email needs an invite. Fire-and-forget: any
 * failure (guard offline, wrong URL/secret, network hiccup) is logged and
 * swallowed — a paid order must never be blocked by the OTHER bot being
 * temporarily unreachable. The guard's own queue/batch/seat-purchase logic
 * takes over from here; results come back later via handleGuardCallback.
 */
async function notifyGuardOfNewInvite(email, { orderId = null } = {}) {
  if (!GUARD_URL || !SHARED_SECRET) return; // integration not configured (the startup log says so)
  if (!guardUrlValid()) {
    logger.warn(`[cgbGuard] order #${orderId} NOT sent to the invite bot: GUARD_AUTO_INVITE_URL is not a valid address ("${GUARD_URL_RAW}")`);
    return;
  }
  const clean = String(email || '').trim().toLowerCase();
  if (!clean || !clean.includes('@')) return;
  try {
    const url = new URL(GUARD_URL);
    if (GUARD_PANEL) url.searchParams.set('panel', GUARD_PANEL);
    const resp = await fetchWithTimeout(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Invite-Secret': SHARED_SECRET },
      body: JSON.stringify({ email: clean }),
    });
    const text = await resp.text().catch(() => '');
    if (!resp.ok) {
      logger.warn(`[cgbGuard] auto-invite POST for ${clean} (order #${orderId}) → HTTP ${resp.status}: ${text.slice(0, 300)}`);
      return;
    }
    logger.info(`[cgbGuard] queued ${clean} (order #${orderId}) with the guard bot: ${text.slice(0, 200)}`);
  } catch (e) {
    logger.warn(`[cgbGuard] could not reach the guard bot for ${clean} (order #${orderId}): ${e.message}`);
  }
}

/**
 * Express handler for POST /webhook/cgb-guard-status. Mounted only if
 * GUARD_SECRET is set (see index.js) — otherwise the whole route doesn't
 * exist rather than existing-but-always-401, so it isn't discoverable by
 * guessing when the owner hasn't set up the integration.
 *
 * Body: { email, status: 'success'|'failed', panel, reason }
 * Auth: header X-Invite-Secret, matching GUARD_SECRET (the SAME shared
 * secret used outbound — one value to keep in sync on both bots).
 */
function makeGuardWebhookHandler({ queries, logger: log, activateAndNotifySeat, notifyAdmin, bot }) {
  return async function handleGuardCallback(req, res) {
    const supplied = req.get('X-Invite-Secret') || req.query.secret || '';
    if (!SHARED_SECRET || supplied !== SHARED_SECRET) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const { email, status, panel, reason } = req.body || {};
    const clean = String(email || '').trim().toLowerCase();
    if (!clean || !clean.includes('@')) {
      return res.status(400).json({ error: 'email required' });
    }

    // /digitrusttest from the invite bot: answer OK, touch nothing.
    if (clean === 'connection-test@digitrust.invalid') {
      log.info('[cgbGuard] connection test from the invite bot — OK');
      return res.json({ ok: true, test: true });
    }

    const sub = queries.getPendingCgbSubscriptionByEmail(clean);
    if (!sub) {
      log.warn(`[cgbGuard] callback for ${clean} (${status}) matches no pending seat order — ignored.`);
      return res.json({ ok: true, matched: false });
    }

    if (status === 'success') {
      const result = await activateAndNotifySeat(sub.order_id);
      log.info(`[cgbGuard] auto-activated order #${sub.order_id} (${clean}) from guard callback: ${JSON.stringify(result)}`);
      return res.json({ ok: true, matched: true, activated: result.ok });
    }

    // status === 'failed' (or anything else unexpected): don't touch the
    // order — leave it exactly as a normal pending seat, and tell the admin
    // why, so they can invite/activate manually instead of it silently
    // sitting there looking the same as any other not-yet-activated seat.
    log.warn(`[cgbGuard] invite failed for ${clean} (order #${sub.order_id}, panel ${panel || '?'}): ${reason || 'no reason given'}`);
    try {
      await notifyAdmin(bot, {
        type: 'cgb_guard_invite_failed',
        title: '⚠️ ChatGPT Business Guard could not invite a customer',
        body: `📧 <code>${clean}</code>\n🆔 Order #${sub.order_id}${panel ? ` · panel ${panel}` : ''}\n` +
              `❌ ${reason || 'no reason given'}\n\n<i>Invite/activate this seat manually.</i>`,
        dedupeKey: `cgb_guard_fail:${sub.order_id}:${clean}`,
        refType: 'chatgpt_subscription', refId: sub.order_id,
      });
    } catch (e) {
      log.warn(`[cgbGuard] could not alert admin about failed invite: ${e.message}`);
    }
    return res.json({ ok: true, matched: true, activated: false });
  };
}

/**
 * Ask the guard bot to drop an email from its invite queue because the order
 * was cancelled/refunded here — so it doesn't buy a seat and invite someone
 * who got their money back. Never throws.
 * Returns the guard's answer: 'removed' | 'processing' | 'already_invited' |
 * 'not_found', or 'unreachable' if the call failed, or null when the
 * integration isn't configured.
 */
async function cancelGuardInvite(email, { orderId = null } = {}) {
  if (!GUARD_URL || !SHARED_SECRET) return null;
  const clean = String(email || '').trim().toLowerCase();
  if (!clean.includes('@')) return null;
  try {
    const url = new URL(GUARD_URL);
    url.pathname = url.pathname.replace(/auto-invite\/?$/, 'cancel-invite');
    const resp = await fetchWithTimeout(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Invite-Secret': SHARED_SECRET },
      body: JSON.stringify({ email: clean, ...(GUARD_PANEL ? { panel: GUARD_PANEL } : {}) }),
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok || !body.status) {
      logger.warn(`[cgbGuard] cancel-invite for ${clean} (order #${orderId}) → HTTP ${resp.status}: ${JSON.stringify(body).slice(0, 200)}`);
      return 'unreachable';
    }
    logger.info(`[cgbGuard] cancel-invite for ${clean} (order #${orderId}): ${body.status}`);
    return body.status;
  } catch (e) {
    logger.warn(`[cgbGuard] could not reach the guard bot to cancel ${clean} (order #${orderId}): ${e.message}`);
    return 'unreachable';
  }
}

// Say at startup whether the integration is on — "nothing happens" used to
// look exactly the same whether a variable was missing or misspelled.
if (GUARD_URL && SHARED_SECRET && !guardUrlValid()) {
  logger.warn(`[cgbGuard] integration OFF — GUARD_AUTO_INVITE_URL is not a valid address: "${GUARD_URL_RAW}". It must look like https://your-invite-bot.up.railway.app/auto-invite`);
} else if (GUARD_URL && SHARED_SECRET) {
  logger.info(`[cgbGuard] integration ON → ${GUARD_URL}${GUARD_PANEL ? ` (panel ${GUARD_PANEL})` : ''}${GUARD_URL !== GUARD_URL_RAW.trim() ? ` (fixed from "${GUARD_URL_RAW}")` : ''}`);
} else {
  logger.warn(`[cgbGuard] integration OFF — missing: ${[!GUARD_URL && 'GUARD_AUTO_INVITE_URL', !SHARED_SECRET && 'GUARD_SECRET'].filter(Boolean).join(', ')}`);
}

/**
 * /guardtest — checks the whole DIGITRUST → invite-bot connection WITHOUT
 * queueing anyone or buying anything, and says in plain words what is wrong.
 * Uses /cancel-invite with an address that can never be queued, which needs
 * the right address, the right secret and a ready panel — the same three
 * things a real invite needs. Returns { ok, lines }.
 */
async function diagnose() {
  const lines = [];
  if (!GUARD_URL) lines.push('❌ <b>GUARD_AUTO_INVITE_URL</b> is empty in DIGITRUST → Variables.');
  if (!SHARED_SECRET) lines.push('❌ <b>GUARD_SECRET</b> is empty in DIGITRUST → Variables.');
  if (!GUARD_URL || !SHARED_SECRET) return { ok: false, lines };

  let url;
  try { url = new URL(GUARD_URL); } catch (_) {
    lines.push(`❌ GUARD_AUTO_INVITE_URL is not a valid address: <code>${String(GUARD_URL_RAW).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code>\nIt must look like <code>https://your-invite-bot.up.railway.app/auto-invite</code> — no spaces, no quotes, no &lt; &gt;.`);
    return { ok: false, lines };
  }
  if (!/\/auto-invite\/?$/.test(url.pathname)) {
    lines.push('⚠️ GUARD_AUTO_INVITE_URL should end with <code>/auto-invite</code>.');
  }
  lines.push(`🔗 Invite bot: <code>${url.origin}</code>${GUARD_PANEL ? ` · panel <code>${GUARD_PANEL}</code>` : ''}`);

  try {
    const h = await fetchWithTimeout(`${url.origin}/health`, { method: 'GET' });
    if (!h.ok) { lines.push(`❌ The invite bot answered HTTP ${h.status} — is it running?`); return { ok: false, lines }; }
    lines.push('✅ The invite bot is reachable.');
  } catch (e) {
    lines.push(`❌ Cannot reach the invite bot at that address (${e.name === 'AbortError' ? 'timeout' : e.message}). Check the domain.`);
    return { ok: false, lines };
  }

  const cancelUrl = new URL(url.toString());
  cancelUrl.pathname = cancelUrl.pathname.replace(/auto-invite\/?$/, 'cancel-invite');
  try {
    const r = await fetchWithTimeout(cancelUrl.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Invite-Secret': SHARED_SECRET },
      body: JSON.stringify({ email: 'connection-test@digitrust.invalid', ...(GUARD_PANEL ? { panel: GUARD_PANEL } : {}) }),
    });
    const body = await r.json().catch(() => ({}));
    if (r.status === 401) { lines.push('❌ <b>The secret does not match.</b> GUARD_SECRET here must be exactly the same as AUTO_INVITE_SECRET in the invite bot.'); return { ok: false, lines }; }
    if (r.status === 404) { lines.push('⚠️ The invite bot is an older version (no /cancel-invite). Deploy its latest file, then test again.'); return { ok: false, lines }; }
    if (r.status === 503) { lines.push(`⚠️ Secret OK, but panel <code>${body.panel || GUARD_PANEL || '?'}</code> is not ready in the invite bot (session not uploaded, or wrong GUARD_PANEL_ID).`); return { ok: false, lines }; }
    if (!r.ok || !body.status) { lines.push(`❌ Unexpected answer: HTTP ${r.status}`); return { ok: false, lines }; }
    lines.push('✅ Secret matches and the panel is ready.');
  } catch (e) {
    lines.push(`❌ Connection check failed: ${e.message}`);
    return { ok: false, lines };
  }
  lines.push('✅ <b>DIGITRUST → invite bot works.</b> Paid orders will be queued automatically.');
  lines.push('<i>For the other direction (green card), send /digitrusttest to the invite bot.</i>');
  return { ok: true, lines };
}

module.exports = { notifyGuardOfNewInvite, makeGuardWebhookHandler, cancelGuardInvite, diagnose, _normalizeGuardUrl: normalizeGuardUrl };
