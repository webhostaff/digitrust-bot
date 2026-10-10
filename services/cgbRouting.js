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
const DEFAULT_KEY = 'cgb_default_panel';        // the panel new orders go to, chosen in the store (V151)
const PANEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/;

/** { "9": "panel-9", "30": "main" } — cycle END day → panel id. Never throws. */
function panelMap() {
  try {
    const v = JSON.parse(db.getSetting(KEY, '{}') || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch (_) { return {}; }
}

// ── V157.2: a NAME for a cycle whose panel has no invite bot yet ─────────────────────────────────
// The seats of that cycle carry this name (cards, workspace, lists) and their invites are HELD — never sent to
// another panel. Linking the cycle to a real panel later replaces the name, and its emails can then be moved
// to that panel in one tap.
const NAME_KEY = 'cgb_cycle_placeholders';
function placeholderMap() {
  try {
    const v = JSON.parse(db.getSetting(NAME_KEY, '{}') || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch (_) { return {}; }
}
function setCyclePlaceholder(endDay, name) {
  const day = parseInt(endDay, 10);
  if (!(day >= 1 && day <= 31)) return { ok: false, reason: 'a cycle end day is 1 to 31' };
  const map = placeholderMap();
  const clean = String(name || '').replace(/[<>]/g, '').trim().slice(0, 40);
  if (!clean) delete map[String(day)];
  else map[String(day)] = clean;
  db.setSetting(NAME_KEY, JSON.stringify(map));
  return { ok: true, name: clean };
}
/** The temporary name of the cycle a seat ending on `endDate` belongs to ('' = none, or linked to a real panel). */
function placeholderFor(endDate) {
  const d = endDayOf(endDate);
  if (d == null || panelMap()[String(d)]) return '';
  return placeholderMap()[String(d)] || '';
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
    try {
      const ph = placeholderMap();
      if (ph[String(day)]) {
        db.setSetting(`cgb_ph_replaced_${day}`, ph[String(day)]);      // V157.3: remembered for 📤 moving its seats
        delete ph[String(day)]; db.setSetting(NAME_KEY, JSON.stringify(ph));
      }
    } catch (_) {}   // V157.2: the real panel replaces the name
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
  // V157.2: a cycle with only a NAME (no invite bot yet): hold — never send it to another panel.
  const ph = endDay != null ? placeholderMap()[String(endDay)] : null;
  if (ph) return { panel: '', strict: true, source: 'placeholder', placeholder: ph, endDay };
  // V151: the panel the owner CHOSE in the store for new orders. It is his decision, so the order goes exactly
  // there and waits if that panel is stopped — never rerouted to another one.
  const chosen = getDefaultPanel();
  if (chosen) return { panel: chosen, strict: true, source: 'chosen', endDay };
  if (fallbackPanel) return { panel: String(fallbackPanel), strict: false, source: 'default', endDay };
  return { panel: '', strict: false, source: 'none', endDay };
}

/** The panel chosen in the store for new orders ('' = none: GUARD_PANEL_ID / the invite bot decides). */
function getDefaultPanel() {
  const v = String(db.getSetting(DEFAULT_KEY, '') || '').trim();
  return PANEL_ID_RE.test(v) ? v : '';
}
function setDefaultPanel(panelId) {
  if (!panelId) { db.setSetting(DEFAULT_KEY, ''); return { ok: true }; }
  if (!PANEL_ID_RE.test(String(panelId).trim())) return { ok: false, reason: 'a panel id is letters, digits, "-", "_" or "." (no spaces)' };
  db.setSetting(DEFAULT_KEY, String(panelId).trim());
  return { ok: true };
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

/** The invite bot's panels WITH names: [{id, name, state}] (state: running|stopped|waiting). null = unreachable. */
async function listGuardPanelsNamed(guardUrl, fetchImpl = (typeof fetch === 'function' ? fetch : null), timeoutMs = 8000) {
  try {
    if (!guardUrl || !fetchImpl) return null;
    const u = new URL(guardUrl);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetchImpl(`${u.origin}/health`, { signal: ctrl.signal });
      if (!r.ok) return null;
      const j = await r.json();
      const names = j.panel_names || {};
      const out = Object.entries(j.panels || {}).map(([id, st]) => ({
        id, name: names[id] || id,
        state: st && st.owner_stopped ? 'stopped' : (st && st.paused ? 'paused' : 'running'),
      }));
      for (const id of Array.isArray(j.waiting_for_session) ? j.waiting_for_session : []) out.push({ id, name: names[id] || id, state: 'waiting' });
      return out.sort((a, b) => a.name.localeCompare(b.name));
    } finally { clearTimeout(t); }
  } catch (_) { return null; }
}

/** Names not linked to a real panel yet, as panel-like entries: [{ id: 'ph:<name>', name }]. */
function placeholderPanels() {
  const linked = panelMap();
  const seen = new Set();
  const out = [];
  for (const [day, name] of Object.entries(placeholderMap())) {
    if (linked[day] || seen.has(name)) continue;
    seen.add(name);
    out.push({ id: `ph:${name}`, name, state: 'noBot', placeholder: true });
  }
  return out;
}
function replacedName(endDay) { return String(db.getSetting(`cgb_ph_replaced_${endDay}`, '') || ''); }

module.exports = { placeholderPanels, replacedName, placeholderMap, setCyclePlaceholder, placeholderFor, panelMap, setCyclePanel, resolveTarget, getDefaultPanel, setDefaultPanel, listGuardPanelsNamed, listGuardPanels, endDayOf, PANEL_ID_RE, KEY };
