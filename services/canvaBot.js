'use strict';

/**
 * Canva Teams invites, automated.
 *
 * A headless Chromium, logged in once as the shop's Canva account, opens the
 * team's People page for each order, invites the customer's email, and reads
 * back the personal invite link. One customer = one personal invite; the link
 * is tied to their email, exactly as doing it by hand.
 *
 * Why it is built the careful way:
 *   - LOGIN ONCE. The session (cookies + storage) is written to disk and
 *     reused, so the daily "enter a code" step happens a handful of times a
 *     month, not on every invite. When it does expire, the owner is told and
 *     re-logs through a one-time remote link — no credentials touch this code.
 *   - ONE AT A TIME. Invites run through a lock; two orders never drive the
 *     same browser at once (that is what trips Canva's automation checks).
 *   - HUMAN PACING. A minimum gap and small random delays between invites, so
 *     it does not machine-gun the team.
 *   - FAILS SAFE. Any doubt (not logged in, page changed, no link) → the order
 *     falls back to the manual fast lane. It never marks an order delivered
 *     without a real link.
 *
 * Enabled only when CANVA_AUTOMATION=1 and Playwright is installed. Off, the
 * shop behaves exactly as before.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const mem = require('./agentMemory');

const ENABLED = process.env.CANVA_AUTOMATION === '1';

/**
 * Where the Canva session lives.
 *
 * It used to default to /tmp, which Railway wipes on every deploy — so every
 * redeploy silently logged Canva out and orders fell back to manual. Now it
 * sits next to the database (DB_PATH is on the persistent volume). An explicit
 * CANVA_DATA_DIR still wins, EXCEPT the old '/tmp/canva-session' value that
 * .env.example used to suggest: nobody chose that on purpose, and honouring it
 * would keep the "logged out after every deploy" bug alive.
 */
const LEGACY_TMP_DIR = '/tmp/canva-session';
function resolveDataDir() {
  const explicit = (process.env.CANVA_DATA_DIR || '').trim();
  if (explicit && explicit !== LEGACY_TMP_DIR) return explicit;
  const dbPath = (process.env.DB_PATH || '').trim();
  if (dbPath) return path.join(path.dirname(path.resolve(dbPath)), 'canva-session');
  return LEGACY_TMP_DIR; // no volume configured — nothing better to do
}
const DATA_DIR = resolveDataDir();
const STORAGE = path.join(DATA_DIR, 'storage.json');
/**
 * Is DATA_DIR really on a mounted volume? v109 only checked "not /tmp", which
 * would happily say ✅ for a folder inside the image that a deploy wipes too.
 * On Linux, /proc/mounts lists every mount: the deepest mount point containing
 * DATA_DIR tells us. The container root ('/', usually overlay) is NOT
 * persistent; a Railway volume shows up as its own mount (e.g. /app/data).
 * Returns null when it cannot tell (non-Linux dev machine).
 */
function volumeCheck(dir) {
  try {
    const target = path.resolve(dir);
    let best = null;
    for (const line of fs.readFileSync('/proc/mounts', 'utf8').split('\n')) {
      const [, mp, type] = line.split(' ');
      if (!mp) continue;
      const m = mp.replace(/\\040/g, ' ');
      if (target === m || target.startsWith(m === '/' ? '/' : m + '/')) {
        if (!best || m.length > best.mp.length) best = { mp: m, type };
      }
    }
    if (!best) return null;
    const persistent = best.mp !== '/' && !['tmpfs', 'overlay', 'ramfs'].includes(best.type);
    return { persistent, mount: best.mp, type: best.type };
  } catch (_) { return null; }
}
const VOLUME = volumeCheck(DATA_DIR);
const PERSISTENT = VOLUME ? VOLUME.persistent : !DATA_DIR.startsWith('/tmp');
const PEOPLE_URL = 'https://www.canva.com/settings/people';
const MIN_GAP_MS = 20 * 1000;             // never two invites closer than this
const NAV_TIMEOUT = 45 * 1000;

let playwright = null;
let chromium = null;
try {
  if (ENABLED) {
    playwright = require('playwright-core');
    chromium = require('@sparticuz/chromium');
  }
} catch (e) {
  logger.warn(`[canva] automation requested but libraries missing: ${e.message}`);
}

const available = () => !!(ENABLED && playwright && chromium);

// ── Session on disk ───────────────────────────────────────────────────────────

function ensureDir() { try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {} }

// ── Session from a Railway variable (CANVA_SESSION) ───────────────────────────
//
// For owners who would rather log in on their own computer than through the
// remote-login page: export the canva.com cookies (e.g. the "Cookie-Editor"
// browser extension → Export → JSON) and paste them into CANVA_SESSION.
// Accepted shapes, raw or base64-encoded:
//   - Cookie-Editor / EditThisCookie export: a JSON ARRAY of cookies
//   - a Playwright storageState object: { cookies: [...], origins: [...] }
//
// The variable only SEEDS the session file. The bot keeps refreshing that file
// after each invite (Canva rotates cookies), so the file is usually fresher
// than the variable. We therefore import the variable only when its content
// CHANGED since the last import (hash kept in agent_state) — pasting a new
// value re-seeds; a mere redeploy keeps the warmer on-disk session.

const SAME_SITE = { no_restriction: 'None', none: 'None', lax: 'Lax', strict: 'Strict' };

/** Parse CANVA_SESSION text into a Playwright storageState, or throw a clear error. */
function parseSessionText(raw) {
  let txt = String(raw || '').trim();
  if (!txt) throw new Error('empty');
  // Railway sometimes gets the value wrapped in quotes by copy-paste.
  if (/^['"].*['"]$/s.test(txt)) txt = txt.slice(1, -1).trim();
  if (!/^[\[{]/.test(txt)) {
    // Not JSON — try base64 (handy when pasting through tools that mangle JSON).
    try { txt = Buffer.from(txt, 'base64').toString('utf8').trim(); } catch (_) {}
  }
  let data;
  try { data = JSON.parse(txt); } catch (e) { throw new Error('not valid JSON (paste the full export, starting with [ or {)'); }

  const list = Array.isArray(data) ? data : Array.isArray(data && data.cookies) ? data.cookies : null;
  if (!list) throw new Error('no cookies found in the value');

  const cookies = [];
  for (const c of list) {
    if (!c || !c.name || c.value === undefined) continue;
    let domain = String(c.domain || '').trim();
    if (!/canva\.com$/i.test(domain.replace(/^\./, ''))) continue; // only Canva's own cookies
    // Cookie-Editor marks host-only cookies with hostOnly:true and no dot;
    // Playwright wants a leading dot for domain-wide ones — keep as exported.
    const expires = typeof c.expires === 'number' ? c.expires
      : typeof c.expirationDate === 'number' ? Math.floor(c.expirationDate)
      : -1; // session cookie
    let sameSite = SAME_SITE[String(c.sameSite || '').toLowerCase()] || (['Strict', 'Lax', 'None'].includes(c.sameSite) ? c.sameSite : 'Lax');
    const secure = !!c.secure || sameSite === 'None';
    cookies.push({
      name: String(c.name), value: String(c.value), domain,
      path: c.path || '/', expires, httpOnly: !!c.httpOnly, secure, sameSite,
    });
  }
  if (!cookies.length) throw new Error('the export has no canva.com cookies — export while on canva.com');
  const origins = (!Array.isArray(data) && Array.isArray(data.origins)) ? data.origins : [];
  return { cookies, origins };
}

let envImport = { used: false, error: null, count: 0 };

/** Seed the session file from CANVA_SESSION when the variable is new or changed. */
function importEnvSession() {
  const raw = process.env.CANVA_SESSION;
  if (!raw || !raw.trim()) return envImport;
  const hash = require('crypto').createHash('sha256').update(raw.trim()).digest('hex').slice(0, 16);
  try {
    const state = parseSessionText(raw);
    envImport = { used: false, error: null, count: state.cookies.length };
    const seen = mem.getState('canva_env_hash', null);
    if (seen === hash && hasSession()) return envImport; // already imported; disk copy is fresher
    ensureDir();
    fs.writeFileSync(STORAGE, JSON.stringify(state));
    mem.setState('canva_env_hash', hash);
    mem.setState('canva_last_login', new Date().toISOString());
    envImport.used = true;
    logger.info(`[canva] session imported from CANVA_SESSION (${state.cookies.length} cookies)`);
  } catch (e) {
    envImport = { used: false, error: e.message, count: 0 };
    logger.warn(`[canva] CANVA_SESSION ignored: ${e.message}`);
  }
  return envImport;
}
function hasSession() { try { return fs.statSync(STORAGE).size > 50; } catch (_) { return false; } }
function forgetSession() { try { fs.unlinkSync(STORAGE); } catch (_) {} }

// ── One shared browser, one invite at a time ──────────────────────────────────

let browser = null;
let lastInviteAt = 0;
let chain = Promise.resolve(); // serialises everything that drives the browser

let launchError = null;

/**
 * Where Chromium is. A real system Chromium (installed by nixpacks) is tried
 * first — it is the most reliable on Railway — then CHROMIUM_PATH if set, then
 * the @sparticuz/chromium binary as a last resort.
 */
async function resolveExecutable() {
  const fsx = require('fs');
  const candidates = [];
  if (process.env.CHROMIUM_PATH) candidates.push(process.env.CHROMIUM_PATH);
  candidates.push('/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable', '/root/.nix-profile/bin/chromium');
  for (const c of candidates) { try { if (c && fsx.existsSync(c)) return { path: c, system: true }; } catch (_) {} }
  const sp = await chromium.executablePath();
  if (sp) return { path: sp, system: false };
  return null;
}

async function launch() {
  if (browser && browser.isConnected()) return browser;
  const exec = await resolveExecutable();
  if (!exec) throw new Error('No Chromium found. Add "chromium" to nixpacks.toml and redeploy, or set CHROMIUM_PATH.');
  // A system Chromium does not want the Lambda-specific flags; the bundled one does.
  const baseArgs = exec.system ? [] : chromium.args;
  try {
    browser = await playwright.chromium.launch({
      args: [...baseArgs, '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      executablePath: exec.path,
      headless: true,
    });
  } catch (e) {
    launchError = `${exec.path}: ${e.message}`;
    const lib = (e.message.match(/error while loading shared libraries: ([^:]+)/) || [])[1];
    throw new Error(lib
      // Only the bundled fallback lacks libraries; a system Chromium brings its
      // own. So this means the build did not install Chromium at all — i.e.
      // Railway is not using our Dockerfile (the Dockerfile fixes exactly this).
      ? `Chromium is missing a system library (${lib}) — the build did not install Chromium. Make sure the Dockerfile is in the repo root and redeploy (Railway → Settings → Builder should say Dockerfile).`
      : `Chromium could not start (${exec.path}): ${e.message.slice(0, 160)}`);
  }
  launchError = null;
  logger.info(`[canva] chromium launched: ${exec.path}${exec.system ? ' (system)' : ' (bundled)'}`);
  browser.on('disconnected', () => { browser = null; });
  return browser;
}

/** A one-shot self-test for /canva: does the browser open and load a page? */
async function selfTest() {
  if (!available()) return { ok: false, error: 'automation off' };
  return exclusive(async () => {
    let ctx;
    try {
      const exec = await resolveExecutable();
      ctx = await newContext(false);
      const page = await ctx.newPage();
      await page.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
      const title = await page.title();
      return { ok: true, chromium: exec ? exec.path : '?', loaded: title || 'page loaded' };
    } catch (e) {
      return { ok: false, error: e.message.slice(0, 200) };
    } finally {
      if (ctx) await ctx.close().catch(() => {});
    }
  });
}

async function newContext(withSession = true) {
  const b = await launch();
  return b.newContext({
    storageState: withSession && hasSession() ? STORAGE : undefined,
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'en-US',
  });
}

async function saveSession(context) {
  ensureDir();
  await context.storageState({ path: STORAGE });
}

/** Run `fn` with sole control of the browser (queued behind everything else). */
function exclusive(fn) {
  const run = chain.then(fn, fn);
  // Keep the chain alive regardless of this task's outcome.
  chain = run.then(() => {}, () => {});
  return run;
}

// ── Login state ───────────────────────────────────────────────────────────────

/** Are we still logged in? Loads the People page and looks for the invite UI. */
async function checkLogin() {
  if (!available()) return { ok: false, reason: 'automation off' };
  return exclusive(async () => {
    let ctx;
    try {
      ctx = await newContext(true);
      const page = await ctx.newPage();
      await page.goto(PEOPLE_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
      const loggedIn = await isOnPeoplePage(page);
      if (loggedIn) await saveSession(ctx);
      return { ok: loggedIn, reason: loggedIn ? 'ok' : 'not logged in' };
    } catch (e) {
      return { ok: false, reason: e.message };
    } finally {
      if (ctx) await ctx.close().catch(() => {});
    }
  });
}

async function isOnPeoplePage(page) {
  if (/login|signup/i.test(page.url())) return false;
  // The email field on the People/invite area is the reliable signal.
  const sel = 'input[type="email"], input[placeholder*="email" i]';
  try {
    await page.waitForSelector(sel, { timeout: 8000 });
    return true;
  } catch (_) {
    // Some layouts hide it behind an "Invite" / "Invite members" button.
    const btn = page.getByRole('button', { name: /invite/i }).first();
    try { if (await btn.isVisible({ timeout: 4000 })) return true; } catch (_) {}
    return false;
  }
}

// ── Remote login: the owner drives a real browser over a link ─────────────────
//
// A short-lived login session opens a Canva login page inside our Chromium and
// streams screenshots to a web page the owner opens; their clicks and typing go
// back to the page. Nothing is stored but the resulting Canva cookies.

let loginSession = null; // { context, page, id, createdAt }

async function startLogin() {
  if (!available()) return { ok: false, error: 'Automation is off (set CANVA_AUTOMATION=1 and redeploy).' };
  await endLogin();
  try {
    const ctx = await newContext(false);
    const page = await ctx.newPage();
    let navErr = null;
    await page.goto('https://www.canva.com/login', { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT })
      .catch((e) => { navErr = e.message; });
    if (navErr && !page.url().includes('canva')) {
      await ctx.close().catch(() => {});
      return { ok: false, error: `Opened the browser but could not reach Canva: ${navErr}` };
    }
    loginSession = { context: ctx, page, id: Math.random().toString(36).slice(2, 10), createdAt: Date.now() };
    return { ok: true, id: loginSession.id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function loginShot() {
  if (!loginSession) return null;
  try { return await loginSession.page.screenshot({ type: 'jpeg', quality: 55 }); } catch (_) { return null; }
}

async function loginClick(xRatio, yRatio) {
  if (!loginSession) return;
  const vp = loginSession.page.viewportSize() || { width: 1280, height: 800 };
  await loginSession.page.mouse.click(Math.round(xRatio * vp.width), Math.round(yRatio * vp.height)).catch(() => {});
}
async function loginType(text) { if (loginSession) await loginSession.page.keyboard.type(text, { delay: 30 }).catch(() => {}); }
async function loginKey(key) { if (loginSession) await loginSession.page.keyboard.press(key).catch(() => {}); }

/** Finish login: verify we can reach People, then save the session. */
async function finishLogin() {
  if (!loginSession) return { ok: false, error: 'no login session' };
  const { context, page } = loginSession;
  try {
    await page.goto(PEOPLE_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    const ok = await isOnPeoplePage(page);
    if (ok) { await saveSession(context); }
    await endLogin();
    if (ok) mem.setState('canva_last_login', new Date().toISOString());
    return ok ? { ok: true } : { ok: false, error: 'still not logged in — could not reach the People page' };
  } catch (e) {
    await endLogin();
    return { ok: false, error: e.message };
  }
}

async function endLogin() {
  if (loginSession) {
    try { await loginSession.context.close(); } catch (_) {}
    loginSession = null;
  }
}

// ── The invite itself ─────────────────────────────────────────────────────────

/**
 * Invite one email and return its personal join link.
 * @returns {Promise<{ok:true,link:string} | {ok:false,reason:string,needLogin?:boolean}>}
 */
async function inviteEmail(email) {
  if (!available()) return { ok: false, reason: 'automation off' };
  const clean = String(email || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean)) return { ok: false, reason: 'invalid email' };
  if (!hasSession()) return { ok: false, reason: 'not logged in', needLogin: true };

  return exclusive(async () => {
    const gap = Date.now() - lastInviteAt;
    if (gap < MIN_GAP_MS) await sleep(MIN_GAP_MS - gap + rand(200, 1200));

    let ctx;
    try {
      ctx = await newContext(true);
      const page = await ctx.newPage();
      await page.goto(PEOPLE_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });

      if (!(await isOnPeoplePage(page))) {
        forgetSession();
        return { ok: false, reason: 'session expired', needLogin: true };
      }

      const link = await doInvite(page, clean);
      lastInviteAt = Date.now();
      await saveSession(ctx); // keep the session warm
      if (link) return { ok: true, link };
      return { ok: false, reason: 'invited, but no link appeared' };
    } catch (e) {
      return { ok: false, reason: e.message };
    } finally {
      if (ctx) await ctx.close().catch(() => {});
    }
  });
}

/**
 * Drive the invite UI. Kept tolerant: Canva changes labels, so several
 * selectors are tried for each step and the copied link is read from whichever
 * surface shows it (a readonly input, or the clipboard).
 */
async function doInvite(page, email) {
  // Open the invite dialog if the email box is not already visible.
  const emailSel = 'input[type="email"], input[placeholder*="email" i]';
  if (!(await visible(page, emailSel))) {
    await clickAny(page, [
      () => page.getByRole('button', { name: /invite (people|members)/i }).first(),
      () => page.getByRole('button', { name: /^invite/i }).first(),
    ]);
    await page.waitForSelector(emailSel, { timeout: 10000 });
  }

  const box = page.locator(emailSel).first();
  await box.click();
  await box.fill(email);
  await page.keyboard.press('Enter').catch(() => {});
  await sleep(rand(500, 1200));

  // Confirm / send.
  await clickAny(page, [
    () => page.getByRole('button', { name: /confirm and invite/i }).first(),
    () => page.getByRole('button', { name: /send invite/i }).first(),
    () => page.getByRole('button', { name: /^invite$/i }).first(),
    () => page.getByRole('button', { name: /confirm/i }).first(),
  ]);

  // The personal link appears on a "copy link" step. Grant clipboard and read.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
  const link = await readInviteLink(page);
  return link;
}

async function readInviteLink(page) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    // 1) a readonly input holding the link
    const val = await page.evaluate(() => {
      const ins = [...document.querySelectorAll('input')];
      const hit = ins.map((i) => i.value || '').find((v) => /canva\.com\/(brand\/join|.*invite)/i.test(v));
      return hit || null;
    }).catch(() => null);
    if (val) return val.trim();

    // 2) click a "Copy link" control, then read the clipboard
    const copied = await clickAny(page, [
      () => page.getByRole('button', { name: /copy link/i }).first(),
      () => page.getByRole('button', { name: /copy/i }).first(),
    ]).catch(() => false);
    if (copied) {
      await sleep(400);
      const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => '')).catch(() => '');
      if (clip && /canva\.com\/(brand\/join|.*invite)/i.test(clip)) return clip.trim();
    }
    await sleep(700);
  }
  return null;
}

// ── Small helpers ─────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => Math.floor(a + Math.random() * (b - a));
async function visible(page, sel) { try { return await page.locator(sel).first().isVisible({ timeout: 1500 }); } catch (_) { return false; } }
async function clickAny(page, makers) {
  for (const make of makers) {
    try {
      const el = make();
      if (await el.isVisible({ timeout: 1500 })) { await el.click(); return true; }
    } catch (_) {}
  }
  return false;
}

async function status() {
  return {
    available: available(),
    enabled: ENABLED,
    logged_in: hasSession(),
    last_login: mem.getState('canva_last_login', null),
    login_in_progress: !!loginSession,
    launch_error: launchError,
    data_dir: DATA_DIR,
    persistent: PERSISTENT,
    mount: VOLUME ? VOLUME.mount : null,
    env_session: process.env.CANVA_SESSION ? (envImport.error ? `error: ${envImport.error}` : `${envImport.count} cookies`) : null,
  };
}

// Seed from CANVA_SESSION once at boot (only matters when automation is on).
if (ENABLED) { try { importEnvSession(); } catch (_) {} }

module.exports = {
  available, status, checkLogin, inviteEmail, selfTest,
  startLogin, loginShot, loginClick, loginType, loginKey, finishLogin, endLogin,
  forgetSession, importEnvSession,
  _test: { parseSessionText, resolveDataDir, volumeCheck, DATA_DIR, STORAGE },
};
