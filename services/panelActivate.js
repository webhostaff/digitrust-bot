'use strict';
/**
 * Activate a MANUAL order in a panel of the invite bot (V152).
 *
 * Some invites are sold from this store as manual products (the price-per-day "until a date" products).
 * The owner invites the customer himself, then taps 🎟 Activate in a panel: the customer's email goes on
 * that panel's whitelist in the invite bot with the product's end date (so the invite bot never flags it as
 * unknown, and alerts the owner the day before and on the day it ends), and the customer is told the panel's
 * name and the end date.
 *
 * Used by the admin panel of the store bot (prefix "admin_") and by the support bot (no prefix).
 */

const db = require('../database/queries');
const cgbGuard = require('./cgbGuard');
const { escapeHtml } = require('./adminNotify');

const PANEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/;

/** The end date of the task's product: the "until a date" (price per day) end, or null. */
function expiryOf(task) {
  const p = task && db.getProduct(task.product_id);
  const d = p && p.sub_end_date ? String(p.sub_end_date).slice(0, 10) : '';
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

function canActivate(task) {
  return !!task && (task.status === 'pending' || task.status === 'processing') && !!task.email;
}

/** The button shown on a task (only when it can be used). */
function taskButton(task, prefix = '') {
  if (!canActivate(task)) return null;
  return { text: '🎟 Activate in a panel', callback_data: `${prefix}mdpk_${task.id}` };
}

/** Step 1: which panel. */
async function pickerView(taskId, prefix = '') {
  const t = db.getManualDelivery(taskId);
  const back = [{ text: '🔙 Back', callback_data: `${prefix}md_view_${taskId}` }];
  if (!t) return { text: '❌ Task not found.', kb: [back] };
  if (!t.email) return { text: '❌ This order has no email — nothing to whitelist.', kb: [back] };
  if (!canActivate(t)) return { text: 'ℹ️ This task is already closed.', kb: [back] };
  const panels = await cgbGuard.fetchGuardPanelsNamed(6000);
  if (!panels || !panels.length) {
    return { text: '❌ Could not get the panels from the invite bot (is GUARD_AUTO_INVITE_URL set and the bot online?).', kb: [back] };
  }
  const icon = { running: '🟢', stopped: '⚪', paused: '⏸', waiting: '⏳' };
  const kb = panels.filter((p) => PANEL_ID_RE.test(p.id)).map((p) => [{
    text: `${icon[p.state] || '•'} ${p.name}`, callback_data: `${prefix}mdpc:${t.id}:${p.id}`,
  }]);
  kb.push(back);
  const exp = expiryOf(t);
  return {
    text: `🎟 <b>Activate task #${t.id} in a panel</b>\n\n📧 <code>${escapeHtml(t.email)}</code>\n` +
          `📦 ${escapeHtml(String(t.product_title || ''))}\n` +
          `📅 Ends: <b>${exp || '— (this product has no end date)'}</b>\n\n` +
          'Which panel did you invite them into?',
    kb,
  };
}

/** Step 2: confirm (shows exactly what happens). */
async function confirmView(taskId, panelId, prefix = '') {
  const t = db.getManualDelivery(taskId);
  if (!t || !canActivate(t) || !PANEL_ID_RE.test(panelId)) return pickerView(taskId, prefix);
  const name = await cgbGuard.panelNameOf(panelId);
  const exp = expiryOf(t);
  return {
    text: `🎟 <b>Confirm</b>\n\n📧 <code>${escapeHtml(t.email)}</code>\n🖥 Panel: <b>${escapeHtml(name)}</b>\n` +
          `📅 Ends: <b>${exp || '—'}</b>\n\n` +
          '• the email goes on this panel\'s whitelist in the invite bot' + (exp ? ', with this end date (you get an alert the day before and on the day)' : '') + '\n' +
          '• the customer is told the panel and the end date, and the order is closed as delivered',
    kb: [
      [{ text: '✅ Activate & tell the customer', callback_data: `${prefix}mdpy:${t.id}:${panelId}` }],
      [{ text: '🔙 Other panel', callback_data: `${prefix}mdpk_${t.id}` }],
    ],
  };
}

/** Step 3: do it. @returns {{ok:boolean, text:string}} */
async function activate(bot, taskId, panelId) {
  const t = db.getManualDelivery(taskId);
  if (!t) return { ok: false, text: '❌ Task not found.' };
  if (!canActivate(t)) return { ok: false, text: 'ℹ️ This task is already closed — nothing was done.' };
  if (!PANEL_ID_RE.test(panelId)) return { ok: false, text: '❌ Bad panel.' };
  const exp = expiryOf(t);
  const wl = await cgbGuard.whitelistInGuard({
    panel: panelId, email: t.email, expiresOn: exp, note: `order #${t.order_id}`, source: 'store_manual',
  });
  if (!wl.ok) return { ok: false, text: `❌ Not done — ${escapeHtml(wl.reason)}.\nThe customer was not told anything.` };
  const panelName = wl.panelName || (await cgbGuard.panelNameOf(panelId));
  const res = await require('../handlers/manualDelivery').completeManualDelivery(bot, taskId, null, { panelName, expiresOn: exp });
  if (!res.ok) return { ok: false, text: `⚠️ Whitelisted in ${escapeHtml(panelName)}, but the task could not be closed: ${escapeHtml(res.reason)}` };
  try {
    db.db.prepare('UPDATE orders SET delivered_content = ? WHERE id = ?')
      .run(`Workspace: ${panelName}${exp ? ` · until ${exp}` : ''}`, t.order_id);
  } catch (_) { /* the record line is a convenience */ }
  return {
    ok: true,
    text: `✅ Task #${t.id} activated in <b>${escapeHtml(panelName)}</b>` + (exp ? ` until <b>${exp}</b>` : '') + '.' +
          (res.notified ? '\n📨 The customer was told.' : '\n⚠️ The customer could not be messaged.'),
  };
}

module.exports = { expiryOf, canActivate, taskButton, pickerView, confirmView, activate, PANEL_ID_RE };
