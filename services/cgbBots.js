'use strict';
/**
 * Several invite bots, one per panel (V148).
 *
 * The owner runs a separate invite bot (its own Railway service and Telegram bot) for each panel,
 * and wants only ONE working at a time: when one works, the others are off. This module is the
 * switchboard:
 *   - a registry of the bots (name + address); the bot of GUARD_AUTO_INVITE_URL is always there
 *     as "main";
 *   - the ACTIVE one — the one that receives new orders;
 *   - a safe switch: make bot X active = turn the others off, turn X on, point new orders at X.
 *
 * Safety first. A bot is never turned off while paid invites wait in its queue (unless the owner
 * insists), the target is checked BEFORE anything is stopped, and if turning the target on fails
 * the bots that were stopped are turned back on.
 *
 * All bots share one secret (GUARD_SECRET here = AUTO_INVITE_SECRET there).
 */

const db = require('../database/queries');

const KEY_BOTS = 'cgb_invite_bots';
const KEY_ACTIVE = 'cgb_active_bot';
const DEFAULT_ID = 'main';
const MIN_BUILD = 34;                    // the first invite-bot build that can be switched on and off remotely
const TIMEOUT_MS = 8000;

function guardConfig() { return require('./cgbGuard').getConfig(); }

// ── registry ─────────────────────────────────────────────────────────────────

function readExtra() {
  try {
    const v = JSON.parse(db.getSetting(KEY_BOTS, '[]') || '[]');
    return Array.isArray(v) ? v.filter((b) => b && b.id && b.origin) : [];
  } catch (_) { return []; }
}
function writeExtra(list) { db.setSetting(KEY_BOTS, JSON.stringify(list)); }

/** The bot of GUARD_AUTO_INVITE_URL (always there when the integration is configured), then the added ones. */
function list() {
  const out = [];
  const cfg = guardConfig();
  if (cfg.url && cfg.valid) {
    out.push({ id: DEFAULT_ID, name: 'Main', origin: new URL(cfg.url).origin, panel: cfg.panel || '', isDefault: true });
  }
  for (const b of readExtra()) out.push({ id: String(b.id), name: String(b.name || b.id), origin: String(b.origin), panel: String(b.panel || ''), isDefault: false });
  return out;
}
const get = (id) => list().find((b) => b.id === id) || null;

/** The bot that receives new orders, or null (then the main one / the cycle links decide, as before). */
function activeBot() {
  const id = db.getSetting(KEY_ACTIVE, '') || '';
  return id ? get(id) : null;
}
function setActive(id) { db.setSetting(KEY_ACTIVE, id || ''); }

function slug(name) {
  return String(name || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
}

/** @returns {{ok:boolean, reason?:string, bot?:object}} */
function parseAddInput(text) {
  const parts = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return { ok: false, reason: 'Send: <name> <address> — e.g. Cycle9 https://guard-9.up.railway.app' };
  const addrIdx = parts.findIndex((p) => /^(https?:\/\/)?[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(:\d+)?(\/\S*)?$/i.test(p) || /^https?:\/\/localhost/i.test(p) || /^https?:\/\/127\./.test(p));
  if (addrIdx < 0) return { ok: false, reason: 'I could not find an address (like https://guard-9.up.railway.app).' };
  let addr = parts[addrIdx];
  if (!/^https?:\/\//i.test(addr)) addr = `https://${addr}`;
  let origin;
  try { origin = new URL(addr).origin; } catch (_) { return { ok: false, reason: 'That address is not valid.' }; }
  // "Cycle D https://…  [panel]": everything BEFORE the address is the name (it may have spaces), the word after
  // it is the optional panel id. Address first ("https://… Cycle9 [panel]") is accepted too.
  let name, panel;
  if (addrIdx > 0) {
    name = parts.slice(0, addrIdx).join(' ').slice(0, 30);
    panel = parts[addrIdx + 1] ? parts[addrIdx + 1].slice(0, 41) : '';
  } else {
    if (!parts[1]) return { ok: false, reason: 'Send: <name> <address> — e.g. Cycle9 https://guard-9.up.railway.app' };
    name = parts[1].slice(0, 30);
    panel = parts[2] ? parts[2].slice(0, 41) : '';
  }
  if (panel && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/.test(panel)) return { ok: false, reason: 'The panel id has odd characters.' };
  return { ok: true, name, origin, panel };
}

function add({ name, origin, panel = '' }) {
  const id0 = slug(name) || 'bot';
  const all = list();
  if (all.some((b) => b.origin === origin)) return { ok: false, reason: `That address is already registered (${all.find((b) => b.origin === origin).name}).` };
  if (all.some((b) => b.name.toLowerCase() === String(name).toLowerCase())) return { ok: false, reason: `A bot called "${name}" already exists — pick another name.` };
  let id = id0, n = 2;
  while (id === DEFAULT_ID || all.some((b) => b.id === id)) id = `${id0}-${n++}`;
  const bot = { id, name, origin, panel };
  writeExtra([...readExtra(), bot]);
  return { ok: true, bot: { ...bot, isDefault: false } };
}

function remove(id) {
  if (id === DEFAULT_ID) return { ok: false, reason: 'The main bot comes from GUARD_AUTO_INVITE_URL and cannot be removed here.' };
  const extra = readExtra();
  if (!extra.some((b) => b.id === id)) return { ok: false, reason: 'No such bot.' };
  writeExtra(extra.filter((b) => b.id !== id));
  if ((db.getSetting(KEY_ACTIVE, '') || '') === id) setActive('');
  return { ok: true };
}

// ── talking to a bot ─────────────────────────────────────────────────────────

async function call(bot, path, { method = 'POST', body = null, secret = null } = {}, fetchImpl = fetch) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetchImpl(`${bot.origin}${path}`, {
      method, signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'X-Invite-Secret': secret == null ? guardConfig().secret : secret },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let json = null;
    try { json = await r.json(); } catch (_) { /* not JSON */ }
    return { ok: r.ok, status: r.status, json, reachable: true };
  } catch (e) {
    return { ok: false, status: 0, json: null, reachable: false, error: e.message };
  } finally { clearTimeout(t); }
}

const panelBody = (bot, extra = {}) => ({ ...(bot.panel ? { panel: bot.panel } : {}), ...extra });

/**
 * One bot's condition.
 *   state: running | stopped | paused | no_session | unreachable | unauthorized | old_build | unknown
 * `queued` = invites waiting. `old` = an invite-bot build without remote control (< 34).
 */
async function status(bot) {
  const r = await call(bot, '/api/control', { body: panelBody(bot, { action: 'status' }) });
  if (!r.reachable) return { bot, state: 'unreachable', error: r.error, queued: 0 };
  if (r.status === 401) return { bot, state: 'unauthorized', queued: 0 };
  if (r.status === 404 && !(r.json && r.json.error)) {                      // a build without /api/control
    const h = await call(bot, '/health', { method: 'GET' });
    return { bot, state: 'old_build', queued: 0, reachable: h.reachable };
  }
  if (!r.ok || !r.json) return { bot, state: 'unknown', httpStatus: r.status, queued: 0, detail: r.json && r.json.error };
  const ps = Object.entries(r.json.panels || {});
  const states = ps.map(([, p]) => p.state);
  const queued = ps.reduce((n, [, p]) => n + (Number(p.queued) || 0), 0);
  const build = parseInt(/build\s+(\d+)/i.exec(String(r.json.version || ''))?.[1] || '0', 10);
  let state = 'unknown';
  if (states.length) {
    if (states.includes('running')) state = 'running';
    else if (states.every((s) => s === 'no_session')) state = 'no_session';
    else if (states.every((s) => s === 'stopped' || s === 'no_session')) state = 'stopped';
    else state = 'paused';
  }
  return { bot, state, queued, build, panels: r.json.panels, version: r.json.version };
}

async function control(bot, action, { force = false } = {}) {
  const r = await call(bot, '/api/control', { body: panelBody(bot, { action, force }) });
  if (!r.reachable) return { ok: false, reason: `could not reach ${bot.name} (${r.error})` };
  if (r.status === 401) return { ok: false, reason: `${bot.name}: the secret does not match (AUTO_INVITE_SECRET there must equal GUARD_SECRET here)` };
  if (r.status === 409 && r.json && r.json.error === 'queue_not_empty') return { ok: false, queueNotEmpty: true, queued: r.json.queued, reason: `${bot.name} still has ${r.json.queued} invite(s) waiting` };
  if (r.status === 409 && r.json && r.json.error === 'no_session') return { ok: false, noSession: true, reason: `${bot.name} has no session yet — send its session file first` };
  if (r.status === 400 && r.json && r.json.error === 'panel_required') return { ok: false, reason: `${bot.name} has several panels: register it with the panel id (name address panel)` };
  if (!r.ok) return { ok: false, reason: `${bot.name} answered HTTP ${r.status}${r.json && r.json.error ? ` (${r.json.error})` : ''}` };
  return { ok: true, state: r.json.state, changed: !!r.json.changed, queued: r.json.queued || 0 };
}

// ── the switch ───────────────────────────────────────────────────────────────

/**
 * What switching to `targetId` would do — nothing is touched.
 * blockers: reasons it cannot be done at all; waiting: bots that would be stopped with invites in
 * their queue (the owner may insist); toStop: the bots that are running and will be stopped.
 */
async function planSwitch(targetId) {
  const bots = list();
  const target = bots.find((b) => b.id === targetId);
  if (!target) return { ok: false, blockers: ['That bot is not registered.'], toStop: [], waiting: [], warnings: [] };
  const sts = await Promise.all(bots.map((b) => status(b)));
  const tSt = sts.find((s) => s.bot.id === targetId);
  const blockers = [], warnings = [], toStop = [], waiting = [];
  if (tSt.state === 'unreachable') blockers.push(`${target.name} cannot be reached (${tSt.error || 'no answer'}) — is it deployed and running?`);
  else if (tSt.state === 'unauthorized') blockers.push(`${target.name}: the secret does not match — set AUTO_INVITE_SECRET there to the value of GUARD_SECRET here.`);
  else if (tSt.state === 'old_build') blockers.push(`${target.name} runs an invite-bot build older than ${MIN_BUILD}: update it first (it cannot be switched on/off remotely).`);
  else if (tSt.state === 'no_session') blockers.push(`${target.name} has no session yet — send its session file first (it could not work).`);
  else if (tSt.state === 'unknown') blockers.push(`${target.name} gave an answer I do not understand (HTTP ${tSt.httpStatus || '?'}).`);
  for (const s of sts) {
    if (s.bot.id === targetId) continue;
    if (s.state === 'running' || s.state === 'paused') {
      toStop.push({ bot: s.bot, queued: s.queued });
      if (s.queued > 0) waiting.push({ bot: s.bot, queued: s.queued });
    } else if (s.state === 'unreachable') warnings.push(`${s.bot.name} cannot be reached: I cannot make sure it is off.`);
    else if (s.state === 'unauthorized') warnings.push(`${s.bot.name}: the secret does not match, so I cannot turn it off.`);
    else if (s.state === 'old_build') warnings.push(`${s.bot.name} runs an old build and cannot be turned off remotely — stop it yourself.`);
  }
  return { ok: blockers.length === 0, target, targetState: tSt.state, blockers, warnings, toStop, waiting, statuses: sts };
}

/**
 * Make `targetId` the working bot: stop the others, start it, point new orders at it.
 * Nothing is changed when the plan has blockers, or when a bot to stop still has invites waiting and
 * `force` is not set. If starting the target fails, the bots that were stopped are started again.
 * @returns {{ok:boolean, lines:string[], needsForce?:boolean, plan:object}}
 */
async function switchTo(targetId, { force = false } = {}) {
  const plan = await planSwitch(targetId);
  if (!plan.ok) return { ok: false, lines: plan.blockers, plan };
  if (plan.waiting.length && !force) {
    return { ok: false, needsForce: true, plan, lines: plan.waiting.map((w) => `${w.bot.name} still has ${w.queued} invite(s) waiting.`) };
  }
  const lines = [], stopped = [];
  for (const { bot } of plan.toStop) {
    const r = await control(bot, 'stop', { force });
    if (r.ok) { stopped.push(bot); lines.push(`⏸ ${bot.name} turned off${r.queued ? ` (${r.queued} invite(s) still waiting in it)` : ''}`); }
    else if (r.queueNotEmpty) {
      // It filled up between the check and now: undo and report, nothing is half-done.
      for (const b of stopped) await control(b, 'start');
      return { ok: false, needsForce: true, plan, lines: [r.reason, ...(stopped.length ? ['I turned the bots I had already stopped back on.'] : [])] };
    } else lines.push(`⚠️ ${r.reason} — turn it off yourself`);
  }
  const started = await control(plan.target, 'start');
  if (!started.ok) {
    for (const b of stopped) await control(b, 'start');
    return { ok: false, plan, lines: [started.reason, ...(stopped.length ? ['I turned the bots I had stopped back on, nothing changed.'] : [])] };
  }
  setActive(targetId);
  lines.push(`▶️ ${plan.target.name} ${started.changed ? 'turned on' : 'was already on'} — new orders go to it`);
  return { ok: true, lines, plan };
}

module.exports = { list, get, activeBot, setActive, add, remove, parseAddInput, status, control, call, planSwitch, switchTo,
                   DEFAULT_ID, KEY_BOTS, KEY_ACTIVE, MIN_BUILD };
