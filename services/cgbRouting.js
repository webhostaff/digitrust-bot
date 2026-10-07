'use strict';
/**
 * Which invite-bot panel a ChatGPT Business seat is invited into — by the seat's CYCLE (V147).
 *
 * Every billing cycle is its own ChatGPT workspace (its own billing day), so a customer who bought
 * the cycle that ends on the 9th has to be invited into THAT workspace, not into whichever panel
 * happens to be "the" panel. Until V147 the store sent every order to one fixed panel
 * (GUARD_PANEL_ID).
 *
 * A seat's cycle is told by the day its seat ends: a seat of the cycle "Day 11 → Day 9" always
 * ends on the 9th (new purchases, whole-cycle renewals and the first days of a moved seat all do).
 * So the owner links each cycle (by its end day) to a panel name, once.
 */

const db = require('../database/queries');

const KEY = 'cgb_cycle_panels';
const PANEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/;

/** { "9": "panel-9", "30": "main" } — cycle END day → panel id. Never throws. */
function panelMap() {
  try {
    const v = JSON.parse(db.getSetting(KEY, '{}') || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch (_) { return {}; }
}

function endDayOf(endDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(endDate || ''));
  return m ? parseInt(m[3], 10) : null;
}

/** Link a cycle (by its end day) to a panel; panelId null/'' unlinks it. @returns {{ok:boolean, reason?:string}} */
function setCyclePanel(endDay, panelId) {
  const day = parseInt(endDay, 10);
  if (!(day >= 1 && day <= 31)) return { ok: false, reason: 'a cycle end day is 1 to 31' };
  const map = panelMap();
  if (!panelId) delete map[String(day)];
  else {
    const id = String(panelId).trim();
    if (!PANEL_ID_RE.test(id)) return { ok: false, reason: 'a panel id is letters, digits, "-", "_" or "." (no spaces)' };
    map[String(day)] = id;
  }
  db.setSetting(KEY, JSON.stringify(map));
  return { ok: true };
}

/**
 * Where an invite for a seat ending on `endDate` goes.
 * @returns {{panel:string, strict:boolean, source:'cycle'|'default'|'none', endDay:?number}}
 *   cycle   → linked to this cycle: the order must land in exactly that panel (strict)
 *   default → no link for this cycle: the single fixed panel (GUARD_PANEL_ID), as before
 *   none    → nothing chosen: the invite bot decides (its 📥 choice / the only panel)
 */
function resolveTarget(endDate, fallbackPanel = '') {
  const endDay = endDayOf(endDate);
  const linked = endDay != null ? panelMap()[String(endDay)] : null;
  if (linked) return { panel: String(linked), strict: true, source: 'cycle', endDay };
  if (fallbackPanel) return { panel: String(fallbackPanel), strict: false, source: 'default', endDay };
  return { panel: '', strict: false, source: 'none', endDay };
}

/** The panel ids the invite bot knows (its public /health). null when it cannot be reached. */
async function listGuardPanels(guardUrl, fetchImpl = (typeof fetch === 'function' ? fetch : null), timeoutMs = 8000) {
  try {
    if (!guardUrl || !fetchImpl) return null;
    const u = new URL(guardUrl);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetchImpl(`${u.origin}/health`, { signal: ctrl.signal });
      if (!r.ok) return null;
      const j = await r.json();
      const ids = new Set([...Object.keys(j.panels || {}), ...(Array.isArray(j.waiting_for_session) ? j.waiting_for_session : [])]);
      return [...ids].sort();
    } finally { clearTimeout(t); }
  } catch (_) { return null; }
}

module.exports = { panelMap, setCyclePanel, resolveTarget, listGuardPanels, endDayOf, PANEL_ID_RE, KEY };
