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
      // A picture of what the server actually sees: "not logged in" alone
      // cannot tell a login wall from a security check or a changed page.
      const shot = await page.screenshot({ type: 'jpeg', quality: 60 }).catch(() => null);
      return { ok: loggedIn, reason: loggedIn ? 'ok' : 'not logged in', url: page.url(), shot };
    } catch (e) {
      let shot = null;
      try { const pg = ctx && ctx.pages()[0]; if (pg) shot = await pg.screenshot({ type: 'jpeg', quality: 60 }); } catch (_) {}
      return { ok: false, reason: e.message, shot };
    } finally {
      if (ctx) await ctx.close().catch(() => {});
    }
  });
}

async function isOnPeoplePage(page) {
  if (/login|signup/i.test(page.url())) return false;
  // Logged-in signal only: the member search box ("Search members by name or
  // email") or an email field. NOT used to find the invite box — that mix-up
  // was the v1/v2 bug; inviting uses the [role=dialog] opened by the button.
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

    let ctx, page;
    // What we saw, for the link hunt and for the owner's report on failure.
    const trace = { baseline: new Set(), net: new Set(), copied: new Set(), dom: new Set(), postConfirm: new Set(), sent: false, clickAt: 0, confirmAt: 0, reqAfter: new WeakSet(), reqPostConfirm: new WeakSet() };
    try {
      ctx = await newContext(true);
      await ctx.addInitScript(COPY_HOOK);
      await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://www.canva.com' }).catch(() => {});
      page = await ctx.newPage();
      // Listen BEFORE navigating. A network link is a candidate ONLY if its
      // REQUEST started after a "Copy link" click; everything else (page load,
      // the invite reply, anything in flight) is baseline. Judging by request
      // start, not by when the reply is read, closes a race the tests caught:
      // a team link in the "Confirm and invite" reply, read a moment late,
      // looked "new" after the click and was delivered.
      page.on('request', (req) => {
        if (trace.confirmAt) trace.reqPostConfirm.add(req);
        if (trace.clickAt) trace.reqAfter.add(req);
      });
      page.on('response', async (resp) => {
        try {
          const ct = (resp.headers()['content-type'] || '').toLowerCase();
          if (!/json|text|javascript/.test(ct)) return;
          const after = trace.reqAfter.has(resp.request());
          for (const l of findJoinLinks(await resp.text())) {
            // Three kinds of link, by WHEN their request started:
            //  - after a "Copy link" click  → a candidate (net);
            //  - after "Confirm and invite" → most likely THIS customer's own
            //    link (Canva's invite reply carries it — that's how the
            //    "Invite sent!" window knows it). Kept aside, NOT banned.
            //    The V114 rule baselined and permanently banned these, so the
            //    customer's link was then rejected when "Copy link" produced
            //    it: "invited, but the link could not be copied";
            //  - before Confirm (page load, invite window) → team/other,
            //    baseline + permanent ban, as before.
            if (after) trace.net.add(l);
            else if (trace.reqPostConfirm.has(resp.request())) trace.postConfirm.add(l);
            else addBaseline(trace, l);
          }
        } catch (_) {}
      });
      await page.goto(PEOPLE_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });

      if (!(await isOnPeoplePage(page))) {
        forgetSession();
        return { ok: false, reason: 'session expired', needLogin: true };
      }

      const res = await doInvite(page, clean, trace);
      lastInviteAt = Date.now();
      await saveSession(ctx); // keep the session warm (and the accepted cookie banner)
      if (res.link) { rememberLink(res.link, clean); return { ok: true, link: res.link, reused: !!res.reused }; }
      return {
        ok: false,
        reason: res.reason || (res.invited ? 'invited, but the link could not be copied' : 'not invited'),
        invited: res.invited === 'maybe' ? 'maybe' : !!res.invited,
        debug: await failureDebug(page, trace),
      };
    } catch (e) {
      return { ok: false, reason: e.message, invited: trace.sent ? true : 'maybe', debug: page ? await failureDebug(page, trace) : null };
    } finally {
      if (ctx) await ctx.close().catch(() => {});
    }
  });
}

/**
 * Drive Canva's People page and come back with THIS email's personal link.
 *
 * Written against the real page (screenshot from order #17991):
 *   People (N) · [Search members by name or email] · [Invite people]
 *   rows: <email> / "Invite is valid for N more days" / Resend · Copy link
 *   + a cookie banner over the bottom of the page on a fresh browser.
 *
 * What went wrong before (v1/v2): the search box's placeholder contains
 * "email", so `input[placeholder*=email]` matched IT — the bot typed the
 * customer's email into SEARCH, never opened the invite dialog, and reported
 * "invited". The invite dialog is now found only as a [role=dialog] opened by
 * the "Invite people" button, and the invite is VERIFIED by searching for the
 * email afterwards (a pending row must exist) before anything is reported.
 *
 * The link comes from that one row's own "Copy link". The row is located as
 * the smallest element holding this email AND a "Copy link" control AND no
 * other email address — so another customer's link can never be clicked.
 * The copy is caught by the network scan and the clipboard hook (headless
 * Chromium cannot read the clipboard back).
 *
 * SAFETY (owner's hard rule — no public team link):
 *   - join links seen before the invite (page load, dialog) are the team's
 *     shared link and are never accepted;
 *   - a link already delivered to a different email is never reused.
 */
async function doInvite(page, email, trace) {
  await acceptCookies(page);
  await sleep(1200);
  for (const l of await domLinks(page)) addBaseline(trace, l);
  for (const l of trace.net) addBaseline(trace, l);
  trace.net.clear();

  // 1) Already in the team? Reuse a pending invite instead of sending a second
  //    email; stop if they are already a member.
  const existing = await findRow(page, email);
  if (existing === 'member') return { reason: 'already a member of the team', invited: false };
  if (existing === 'pending') {
    trace.sent = true; trace.reused = true;
      return { link: await copyRowLink(page, email, trace), invited: true, reused: true };
  }

  // 2) Open the invite dialog (never the search box).
  //    Real dialog (owner's screenshot): "Invite people to your team" ·
  //    Suggested people chips · [Get invite link] · OR · "Invite people via
  //    email" rows [Enter email address…] [Team member ▾] · [Confirm and invite].
  //    "Get invite link" makes the team's PUBLIC link — it is never clicked,
  //    and no loose "any button with invite in it" fallback exists that could
  //    land on it.
  await clearSearch(page);
  const opened = await clickAny(page, [
    () => page.getByRole('button', { name: /^invite people$/i }).first(),
    () => page.getByRole('button', { name: /invite (people|members)/i }).first(),
  ]);
  if (!opened) return { reason: 'could not find the "Invite people" button', invited: false };
  const dialog = await findInviteDialog(page);
  if (!dialog) return { reason: 'the invite window did not open', invited: false };
  await sleep(700);
  for (const l of await domLinks(page)) addBaseline(trace, l); // anything already shown = team's

  const input = dialog.locator('input[placeholder*="email" i]:not([placeholder*="search" i])').first();
  try { await input.waitFor({ state: 'visible', timeout: 5000 }); }
  catch (_) { return { reason: 'no email box in the invite window', invited: false }; }
  await input.click();
  await input.fill(email);
  // No Enter: with several address rows Enter may jump rows or submit early.
  await sleep(rand(700, 1300));

  const confirm = dialog.getByRole('button', { name: /^\s*(confirm and invite|send invitations?|send invite)\s*$/i }).first();
  let sent = false;
  try {
    if (await confirm.isVisible({ timeout: 3000 })) {
      const label = (await confirm.innerText().catch(() => '')) || '';
      if (/get invite link/i.test(label)) throw new Error('refusing the team-link button');
      trace.confirmAt = Date.now();
      await confirm.click(); sent = true;
    }
  } catch (_) {}
  if (!sent) return { reason: 'no "Confirm and invite" button in the invite window', invited: false };

  // 3) The best source: Canva's own follow-up step (owner's screenshot):
  //    "Invite sent! Follow up with a unique link?" · [<email>] [Copy link] · [Done]
  //    That Copy link is THIS person's unique invite link. We only use it when
  //    the step shows this exact email (Canva lowercases it) and the team-wide
  //    "Get invite link" is not on screen.
  const follow = await findFollowUp(page, email);
  if (follow) {
    trace.sent = true;
    const btn = follow.getByRole('button', { name: /^\s*copy link\s*$/i }).first();
    const link = await clickAndCatch(page, btn, email, trace);
    await clickAny(page, [() => follow.getByRole('button', { name: /^\s*done\s*$/i }).first()]).catch(() => false);
    if (link) return { link, invited: true };
    // No link from the dialog — fall through to the People row, below.
  } else {
    await sleep(rand(1500, 2500));
  }
  await page.keyboard.press('Escape').catch(() => {}); // close whatever is still open
  await sleep(800);

  // 4) Fallback: verify via People search and use the row's own Copy link.
  let row = null;
  for (let i = 0; i < 4 && row !== 'pending'; i++) { row = await findRow(page, email); if (row !== 'pending') await sleep(1500); }
  if (row !== 'pending') {
    if (trace.sent) return { reason: 'invited, but the link could not be copied', invited: true };
    // Send was clicked but nothing confirmed it: it MAY have gone out. 'maybe'
    // makes the owner check People before inviting again (no double email).
    return { reason: 'sent, but the invite does not show in People', invited: 'maybe' };
  }
  trace.sent = true;
  return { link: await copyRowLink(page, email, trace), invited: true };
}

/**
 * Canva's "Invite sent!" follow-up step for THIS email, or null. Accepted only
 * if it shows the email (case-insensitive) and no "Get invite link" button.
 */
async function findFollowUp(page, email) {
  const want = email.toLowerCase();
  const byRole = page.locator('[role="dialog"]').filter({ hasText: /invite sent/i }).last();
  let box = null;
  try { await byRole.waitFor({ state: 'visible', timeout: 10000 }); box = byRole; } catch (_) {}
  if (!box) {
    try {
      const h = page.getByText(/invite sent/i).first();
      await h.waitFor({ state: 'visible', timeout: 3000 });
      const anc = h.locator('xpath=ancestor::*[.//button[normalize-space(.)="Copy link"]][1]');
      if (await anc.count()) box = anc.first();
    } catch (_) {}
  }
  if (!box) return null;
  const ok = await box.evaluate((el, want) => {
    const vals = [...el.querySelectorAll('input,textarea')].map((i) => (i.value || '').toLowerCase());
    const text = (el.innerText || '').toLowerCase();
    const showsEmail = vals.includes(want) || text.includes(want);
    const teamBtn = /get invite link/i.test(el.innerText || '');
    return showsEmail && !teamBtn;
  }, want).catch(() => false);
  return ok ? box : null;
}

/**
 * Click a "Copy link" control and return the link it produces. Only links
 * that appear AFTER this click count; everything seen before joins the
 * baseline (team link, other rows), so it can never be handed out.
 */
async function clickAndCatch(page, locator, email, trace) {
  // Only what THIS click produces counts. Earlier copies/network links are
  // set aside for this click (not banned: they may be this customer's own
  // link, e.g. from the invite reply — permanently banning those is exactly
  // what made the V114 flow reject the right link).
  for (const l of trace.net) trace.baseline.add(l);
  for (const l of await copiedLinks(page)) trace.baseline.add(l);
  trace.net.clear(); trace.copied.clear();
  // What the click itself COPIED is the strongest evidence; network second.
  // A link the click COPIED is accepted even if the invite reply already
  // showed it (that's the normal case); a network-only link still has to
  // come from a request made after the click.
  const pick = () =>
    [...trace.copied].find((l) => (!trace.baseline.has(l) || trace.postConfirm.has(l)) && !isBanned(l, email)) ||
    [...trace.net].find((l) => !trace.baseline.has(l) && !isBanned(l, email)) || null;
  for (let attempt = 0; attempt < 2; attempt++) {
    trace.clickAt = Date.now();
    try { await locator.click({ timeout: 5000 }); } catch (_) { return null; }
    const until = Date.now() + 6000;
    while (Date.now() < until) {
      for (const l of await copiedLinks(page)) trace.copied.add(l);
      const hit = pick(); if (hit) return hit;
      await sleep(400);
    }
  }
  return null;
}

/**
 * The invite window: a [role=dialog] if Canva marks it so, otherwise the
 * element around the "Invite people via email" heading. Returns a Locator.
 */
async function findInviteDialog(page) {
  const byRole = page.locator('[role="dialog"]').filter({ hasText: /invite people/i }).last();
  try { await byRole.waitFor({ state: 'visible', timeout: 6000 }); return byRole; } catch (_) {}
  const heading = page.getByText(/invite people (to your team|via email)/i).first();
  try {
    await heading.waitFor({ state: 'visible', timeout: 4000 });
    // Smallest ancestor that holds both an email box and the confirm button.
    const box = heading.locator('xpath=ancestor::*[.//input[contains(translate(@placeholder,"EMAIL","email"),"email")] and .//button[contains(translate(normalize-space(.),"CONFIRMINVTE","confirminvte"),"confirm")]][1]');
    if (await box.count()) return box.first();
  } catch (_) {}
  return null;
}

/** Type the email into the member search; report 'pending' | 'member' | null. */
async function findRow(page, email) {
  const search = page.locator('input[placeholder*="search" i], input[type="search"]').first();
  let searched = false;
  try {
    if (await search.isVisible({ timeout: 2000 })) { await search.fill(''); await search.fill(email); await sleep(1500); searched = true; }
  } catch (_) {}
  let hit = await scanRows(page, email);
  // Canva's search might not list pending invites — look at the full list too.
  if (!hit && searched) { await clearSearch(page); hit = await scanRows(page, email); }
  return hit;
}

function scanRows(page, email) {
  return page.evaluate(({ email }) => {
    const want = email.toLowerCase();
    const EMAIL = /[^\s@]+@[^\s@]+\.[a-z]{2,}/gi;
    const all = [...document.querySelectorAll('body *')].filter((el) =>
      el.children.length === 0 && (el.textContent || '').toLowerCase().includes(want));
    for (const leaf of all) {
      let el = leaf;
      for (let d = 0; el && d < 8; d++, el = el.parentElement) {
        const t = (el.innerText || '');
        const emails = (t.match(EMAIL) || []).map((x) => x.toLowerCase());
        if (emails.some((x) => x !== want)) break;            // grew into another person's row
        if (/copy link|resend|invite is valid/i.test(t)) return 'pending';
        if (/team member|admin|owner|designer|student|teacher/i.test(t) && d >= 2) return 'member';
      }
    }
    return null;
  }, { email }).catch(() => null);
}

/** Click "Copy link" inside THIS email's row only, and collect the link. */
async function copyRowLink(page, email, trace) {
  const marked = await page.evaluate(({ email }) => {
    document.querySelectorAll('[data-dt-copy]').forEach((e) => e.removeAttribute('data-dt-copy'));
    const want = email.toLowerCase();
    const EMAIL = /[^\s@]+@[^\s@]+\.[a-z]{2,}/gi;
    const leaves = [...document.querySelectorAll('body *')].filter((el) =>
      el.children.length === 0 && (el.textContent || '').toLowerCase().includes(want));
    for (const leaf of leaves) {
      let el = leaf;
      for (let d = 0; el && d < 8; d++, el = el.parentElement) {
        const emails = ((el.innerText || '').match(EMAIL) || []).map((x) => x.toLowerCase());
        if (emails.some((x) => x !== want)) break;             // never leave this person's row
        const ctl = [...el.querySelectorAll('button,a,[role="button"],span')]
          .find((c) => /^\s*copy link\s*$/i.test(c.innerText || c.textContent || ''));
        if (ctl) { ctl.setAttribute('data-dt-copy', '1'); return true; }
      }
    }
    return false;
  }, { email }).catch(() => false);
  if (!marked) return null;
  return clickAndCatch(page, page.locator('[data-dt-copy="1"]').first(), email, trace);
}

async function clearSearch(page) {
  const search = page.locator('input[placeholder*="search" i], input[type="search"]').first();
  try { if (await search.isVisible({ timeout: 1000 })) { await search.fill(''); await sleep(600); } } catch (_) {}
}

/** The cookie banner covers the bottom rows on a fresh browser — accept it once. */
async function acceptCookies(page) {
  await clickAny(page, [
    () => page.getByRole('button', { name: /accept all cookies/i }).first(),
    () => page.getByRole('button', { name: /^accept( all)?$/i }).first(),
  ]).catch(() => false);
}

// ── Link finding ──────────────────────────────────────────────────────────────

const JOIN_RE = /https?:\/\/(?:www\.)?canva\.com\/brand\/join\?[^\s"'<>\\)]+/gi;

/** All brand/join links in a blob of text (JSON-escaped or HTML-escaped). */
function findJoinLinks(text) {
  const t = String(text || '')
    .replace(/\\u002[fF]/g, '/').replace(/\\u0026/g, '&').replace(/\\\//g, '/')
    .replace(/&amp;/g, '&');
  return [...new Set((t.match(JOIN_RE) || []).map((l) => l.replace(/[.,;]+$/, '')))];
}

async function domLinks(page) {
  const blob = await page.evaluate(() => {
    const parts = [];
    document.querySelectorAll('input,textarea').forEach((i) => parts.push(i.value || ''));
    document.querySelectorAll('a[href]').forEach((a) => parts.push(a.href));
    parts.push(document.body ? document.body.innerText : '');
    return parts.join('\n');
  }).catch(() => '');
  return findJoinLinks(blob);
}

async function copiedLinks(page) {
  const list = await page.evaluate(() => (window.__dtCopied || []).slice()).catch(() => []);
  return findJoinLinks(list.join('\n'));
}

/** Installed before any Canva script runs: records what "Copy" buttons copy. */
const COPY_HOOK = `(() => {
  window.__dtCopied = [];
  const rec = (t) => { try { if (t) window.__dtCopied.push(String(t)); } catch (_) {} };
  try {
    if (navigator.clipboard) {
      const w = navigator.clipboard.writeText && navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = (t) => { rec(t); return w ? w(t).catch(() => {}) : Promise.resolve(); };
      const wr = navigator.clipboard.write && navigator.clipboard.write.bind(navigator.clipboard);
      navigator.clipboard.write = async (items) => {
        try { for (const it of items || []) for (const ty of it.types || []) if (/text/.test(ty)) rec(await (await it.getType(ty)).text()); } catch (_) {}
        return wr ? wr(items).catch(() => {}) : undefined;
      };
    }
    const ex = document.execCommand.bind(document);
    document.execCommand = (cmd, ...a) => {
      if (String(cmd).toLowerCase() === 'copy') {
        const sel = document.getSelection && String(document.getSelection());
        const el = document.activeElement;
        rec(sel || (el && el.value));
      }
      return ex(cmd, ...a);
    };
    document.addEventListener('copy', (e) => { try { rec(String(document.getSelection())); } catch (_) {} }, true);
  } catch (_) {}
})();`;

/**
 * A team (baseline) link: remembered for this invite AND permanently, so a
 * link once seen as the team's can never be delivered, in any later order.
 */
function addBaseline(trace, l) {
  trace.baseline.add(l);
  try {
    const ban = mem.getState('canva_team_links_v2', null) || {};
    const k = linkKey(l);
    if (!ban[k]) { ban[k] = Date.now(); mem.setState('canva_team_links_v2', ban); }
  } catch (_) {}
  return false;
}
function isBanned(link, email) {
  // v2: the V114 list ('canva_team_links') also holds customers' OWN links
  // banned by the rule fixed above, so it is no longer read.
  const ban = mem.getState('canva_team_links_v2', null) || {};
  return !!ban[linkKey(link)] || deliveredElsewhere(link, email);
}

/** Remember which email got which link, to spot a shared (public) link. */
function linkKey(l) { return require('crypto').createHash('sha256').update(l).digest('hex').slice(0, 20); }
function deliveredElsewhere(link, email) {
  const map = mem.getState('canva_links', null) || {};
  const who = map[linkKey(link)];
  return !!(who && who !== String(email).toLowerCase());
}
function rememberLink(link, email) {
  const map = mem.getState('canva_links', null) || {};
  map[linkKey(link)] = String(email).toLowerCase();
  const keys = Object.keys(map); // keep the last 2000
  if (keys.length > 2000) for (const k of keys.slice(0, keys.length - 2000)) delete map[k];
  mem.setState('canva_links', map);
}

/** Screenshot + what the page offers + which links were seen, for the owner. */
async function failureDebug(page, trace) {
  const shot = await page.screenshot({ type: 'jpeg', quality: 60 }).catch(() => null);
  const buttons = await describePage(page);
  // Masked, never raw: a team link must not end up pasted anywhere.
  const mask = (l) => l.replace(/(token=)([^&]{4})[^&]*/i, '$1$2…');
  return {
    shot, url: page.url(), buttons,
    links: { team: [...trace.baseline].map(mask), after_invite: [...new Set([...trace.net, ...trace.copied, ...trace.dom])].map(mask) },
  };
}

/** Visible buttons / menu items / links, for the owner's failure report. */
async function describePage(page) {
  return page.evaluate(() => {
    const txt = (el) => (el.innerText || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    const seen = new Set(); const out = [];
    document.querySelectorAll('button,[role="button"],[role="menuitem"],a').forEach((el) => {
      const r = el.getBoundingClientRect(); if (!r.width || !r.height) return;
      const t = txt(el); if (t && !seen.has(t)) { seen.add(t); out.push(t); }
    });
    return out.slice(0, 40);
  }).catch(() => []);
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
  _test: { parseSessionText, resolveDataDir, volumeCheck, findJoinLinks, doInvite, findRow, COPY_HOOK, rememberLink, deliveredElsewhere, isBanned, DATA_DIR, STORAGE },
};
