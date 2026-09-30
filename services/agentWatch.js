'use strict';

/**
 * Sahbi watches the shop and speaks first.
 *
 * The bot's own admin alerts fire at the instant something happens ("new
 * support message"). This is the layer above them — the things a good partner
 * notices because time passed or because a pattern appeared:
 *
 *   rules (every 5 min, no AI, free)
 *     - a customer still waiting for a reply after N minutes
 *     - a manual delivery stuck, a ChatGPT seat due today, a deposit un-reviewed
 *     - a product selling fast enough to run out within a day
 *     - one customer piling up refund requests
 *     - the shop gone silent at an hour that normally sells
 *     - a good customer who stopped buying — with an idea to win them back
 *
 *   briefs (AI, twice a day by default)
 *     - morning: what happened overnight, what needs doing, ideas to sell more
 *     - evening: the day in numbers, what is still open, one idea for tomorrow
 *
 * Every alert is raised once (deduped in agent_state), held back during quiet
 * hours, written in the owner's Derja, and shown in the app only — never in
 * the Telegram bots.
 */

const raw = require('../database/db');
const logger = require('../utils/logger');
const mem = require('./agentMemory');

const TICK_MS = 5 * 60 * 1000;
const POST_TICK_MS = 60 * 1000; // scheduled posts go out within a minute of their time

// ── Settings (in agent_state, editable from the app) ────────────────────────

const DEFAULTS = {
  watch_enabled: '1',      // rule alerts
  briefs_enabled: '0',     // AI briefs — off by default, they cost tokens
  brief_morning: '09:00',
  brief_evening: '',       // empty = no evening brief; one a day is enough
  quiet_start: '01:00',
  quiet_end: '08:30',
  wait_minutes: '30',      // support reply follow-up
  learn_enabled: '1',      // nightly: re-read the day's chat with the owner and save lessons
  learn_at: '23:30',
};

function setting(k) { return mem.getState(`watch_${k}`, DEFAULTS[k]); }
function allSettings() {
  const o = {};
  for (const k of Object.keys(DEFAULTS)) o[k] = setting(k);
  return o;
}
function saveSettings(patch) {
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in DEFAULTS)) continue;
    let val = String(v);
    if (/^(brief_|quiet_)/.test(k) && val !== '' && !/^\d{1,2}:\d{2}$/.test(val)) continue;
    if (k === 'wait_minutes') val = String(Math.min(1440, Math.max(5, parseInt(val, 10) || 30)));
    if (/_enabled$/.test(k)) val = val === '1' || val === 'true' ? '1' : '0';
    mem.setState(`watch_${k}`, val);
  }
  return allSettings();
}

// ── Time on the owner's clock ────────────────────────────────────────────────

function offsetHours() {
  try {
    const v = parseFloat(require('../database/queries').getSetting('cgb_timezone_offset', '1'));
    return Number.isFinite(v) ? v : 1;
  } catch (_) { return 1; }
}
function local(d = new Date()) { return new Date(d.getTime() + offsetHours() * 3600000); }
const hm = (d) => d.getUTCHours() * 60 + d.getUTCMinutes();
const toMin = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };
const ymd = (d) => d.toISOString().slice(0, 10);

function inQuiet(now = local()) {
  const a = toMin(setting('quiet_start')), b = toMin(setting('quiet_end')), t = hm(now);
  if (a === b) return false;
  return a < b ? (t >= a && t < b) : (t >= a || t < b);
}

// ── Sending ──────────────────────────────────────────────────────────────────

let BOT = null;

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Light markdown → Telegram HTML (bold, code, bullets). */
function mdToHtml(s) {
  return esc(s)
    .replace(/```([\s\S]*?)```/g, '<pre>$1</pre>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/^#{1,4}\s+(.*)$/gm, '<b>$1</b>')
    .replace(/^\s*[-*]\s+/gm, '• ');
}

function openButton() {
  try {
    const cfg = require('./agentChat').agentConfig();
    return cfg.url ? { inline_keyboard: [[{ text: '🤝 افتح يمان', url: cfg.url }]] } : undefined;
  } catch (_) { return undefined; }
}

/**
 * Sahbi talks in the app only — the owner asked that it never write in the
 * Telegram bots. Alerts and briefs are stored in the app's chat (see the
 * logChat calls) and the app shows them, with a phone notification when the
 * app is installed and allowed to notify.
 */
async function push() { return false; }

/** Once per key. Returns false if this alert was already sent. */
function firstTime(key) {
  const k = `alert_${key}`;
  if (mem.getState(k)) return false;
  mem.setState(k, new Date().toISOString());
  return true;
}
const seen = (key) => !!mem.getState(`alert_${key}`);

// ── Rules ────────────────────────────────────────────────────────────────────

const q = (sql, ...a) => { try { return raw.prepare(sql).all(...a); } catch (e) { logger.warn(`[sahbi] rule query: ${e.message}`); return []; } };
const who = (r) => (r.username ? '@' + r.username : (r.first_name || String(r.user_id)));
const clean = (t) => String(t || '').replace(/\[emoji:\d+\]/g, '').trim();

/**
 * Each rule returns findings: { key, line, weight }. Findings whose key was
 * already alerted are dropped; the rest of one tick go out as ONE message, so
 * five problems are one buzz, not five.
 */
const RULES = [
  function waitingCustomers() {
    const mins = parseInt(setting('wait_minutes'), 10) || 30;
    return q(`
      SELECT m.user_id, COALESCE(m.username, u.username) AS username,
             COALESCE(m.first_name, u.first_name) AS first_name,
             m.id AS last_id, m.content, m.created_at,
             CAST((julianday('now') - julianday(m.created_at)) * 1440 AS INTEGER) AS mins
      FROM support_messages m
      LEFT JOIN users u ON u.telegram_id = m.user_id
      WHERE m.id IN (SELECT MAX(id) FROM support_messages WHERE deleted_at IS NULL GROUP BY user_id)
        AND m.direction = 'in'
        AND m.created_at <= datetime('now', ?)
        AND m.created_at >= datetime('now', '-3 days')
      ORDER BY m.created_at ASC LIMIT 15`, `-${mins} minutes`)
      .map((r) => ({
        key: `wait_${r.user_id}_${r.last_id}`,
        weight: 3, group: 'support', who: who(r), mins: r.mins,
        line: `💬 <b>${esc(who(r))}</b> يستنى رد من <b>${fmtAge(r.mins)}</b>: «${esc(String(r.content || '[media]').slice(0, 90))}»`,
      }));
  },

  // A paid ChatGPT Business seat still not activated (red card) for too long.
  function waitingCgbActivations() {
    const mins = parseInt(setting('wait_minutes'), 10) || 30;
    return q(`
      SELECT cs.order_id, cs.email, u.username, u.first_name, cs.user_id,
             CAST((julianday('now') - julianday(COALESCE(cs.updated_at, cs.created_at))) * 1440 AS INTEGER) AS mins
      FROM chatgpt_subscriptions cs LEFT JOIN users u ON u.telegram_id = cs.user_id
      WHERE cs.status = 'pending'
        AND (cs.start_date IS NULL OR cs.start_date <= date('now'))
        AND COALESCE(cs.updated_at, cs.created_at) <= datetime('now', ?)
        AND COALESCE(cs.updated_at, cs.created_at) >= datetime('now', '-3 days')
      ORDER BY cs.updated_at ASC LIMIT 10`, `-${mins} minutes`)
      .map((r) => ({
        key: `cgbwait_${r.order_id}`,
        weight: 3, group: 'cgb_paid', who: who(r), mins: r.mins,
        line: `🤖 <b>${esc(who(r))}</b> خلّص ChatGPT Business (#${r.order_id}) ويستنى التفعيل من <b>${fmtAge(r.mins)}</b> — <code>${esc(r.email || '')}</code>`,
      }));
  },

  // People waiting in the owner's PERSONAL private chats (Telegram Business).
  function waitingPrivateChats() {
    const mins = parseInt(setting('wait_minutes'), 10) || 30;
    return q(`
      SELECT b.id AS last_id, b.chat_id, b.text, b.username, b.from_name,
             CAST((julianday('now') - julianday(b.created_at)) * 1440 AS INTEGER) AS mins
      FROM business_messages b
      WHERE b.id IN (SELECT MAX(id) FROM business_messages GROUP BY chat_id)
        AND b.is_owner = 0
        AND NOT EXISTS (SELECT 1 FROM business_seen s WHERE s.chat_id = b.chat_id AND s.seen_id >= b.id)
        AND b.created_at <= datetime('now', ?)
        AND b.created_at >= datetime('now', '-1 day')
      ORDER BY b.created_at ASC LIMIT 10`, `-${mins} minutes`)
      .map((r) => ({
        key: `bwait_${r.chat_id}_${r.last_id}`,
        weight: 3, group: 'private', who: r.username ? '@' + r.username : (r.from_name || String(r.chat_id)), mins: r.mins,
        line: `📥 <b>${esc(r.username ? '@' + r.username : (r.from_name || String(r.chat_id)))}</b> كتبلك في الخاص من <b>${fmtAge(r.mins)}</b>: «${esc(String(r.text || '').slice(0, 90))}»`,
      }));
  },

  function stuckManualDeliveries() {
    return q(`
      SELECT md.id, md.order_id, md.user_id, md.email, md.created_at, p.title, u.username, u.first_name,
             CAST((julianday('now') - julianday(md.created_at)) * 1440 AS INTEGER) AS mins
      FROM manual_deliveries md
      LEFT JOIN products p ON p.id = md.product_id
      LEFT JOIN users u ON u.telegram_id = md.user_id
      WHERE md.status IN ('pending','open','waiting','claimed')
        AND md.created_at <= datetime('now', '-30 minutes')
      ORDER BY md.created_at ASC LIMIT 10`)
      .map((r) => ({
        key: `md_${r.id}`,
        weight: 3, group: 'manual', who: who(r), mins: r.mins,
        line: `📦 تسليم يدوي #${r.order_id} (${esc(clean(r.title))}) لـ <b>${esc(who(r))}</b> يستنى من <b>${fmtAge(r.mins)}</b>`,
      }));
  },

  function seatsDueToday() {
    return q(`
      SELECT cs.id, cs.user_id, cs.email, cs.start_date, u.username, u.first_name
      FROM chatgpt_subscriptions cs LEFT JOIN users u ON u.telegram_id = cs.user_id
      WHERE cs.status = 'pending' AND date(cs.start_date) <= date('now')
      LIMIT 10`)
      .map((r) => ({
        key: `seat_${r.id}_${ymd(new Date())}`,
        weight: 3, group: 'seat', who: who(r),
        line: `🤖 مقعد ChatGPT لازمو تفعيل: <b>${esc(who(r))}</b> — <code>${esc(r.email)}</code> (يبدا ${esc(r.start_date)})`,
      }));
  },

  function depositReviews() {
    return q(`
      SELECT id, user_id, amount, network, created_at FROM deposit_reviews
      WHERE status = 'pending' AND created_at <= datetime('now', '-60 minutes') LIMIT 10`)
      .map((r) => ({
        key: `dep_${r.id}`,
        weight: 2,
        line: `🛡 إيداع $${r.amount} (${esc(r.network)}) من <code>${r.user_id}</code> يستنى مراجعة من أكثر من ساعة`,
      }));
  },

  function runningOutFast() {
    const rows = q(`
      SELECT p.id, p.title,
             COALESCE((SELECT SUM(o.quantity) FROM orders o WHERE o.product_id = p.id
                       AND o.status = 'delivered' AND o.created_at >= datetime('now','-24 hours')), 0) AS sold24,
             (SELECT COUNT(*) FROM product_items i WHERE i.product_id = p.id AND i.status = 'available')
           + (SELECT COUNT(*) FROM stock s WHERE s.product_id = p.id AND COALESCE(s.is_sold,0) = 0) AS left_now
      FROM products p
      WHERE COALESCE(p.is_active,1) = 1 AND COALESCE(p.unlimited_stock,0) = 0
        AND COALESCE(p.is_chatgpt_business,0) = 0 AND COALESCE(p.delivery_type,'auto') <> 'manual'`);
    const out = [];
    for (const r of rows) {
      if (r.sold24 < 3) continue;
      const perHour = r.sold24 / 24;
      const hoursLeft = r.left_now / perHour;
      if (r.left_now === 0) {
        out.push({ key: `oos_hot_${r.id}_${ymd(new Date())}`, weight: 3,
          line: `🔥 <b>${esc(clean(r.title))}</b> وفى وهو يبيع (${r.sold24} في 24 ساعة) — كل ساعة بلاش مخزون مبيعات ضايعة` });
      } else if (hoursLeft < 24) {
        out.push({ key: `low_hot_${r.id}_${ymd(new Date())}`, weight: 2,
          line: `⏳ <b>${esc(clean(r.title))}</b>: بقاو <b>${r.left_now}</b> وتبيع ${r.sold24}/يوم — يوفى في ~<b>${Math.max(1, Math.round(hoursLeft))} ساعة</b>` });
      }
    }
    return out;
  },

  function refundPatterns() {
    return q(`
      SELECT r.user_id, u.username, u.first_name, COUNT(*) AS n,
             (SELECT COUNT(*) FROM orders o WHERE o.user_id = r.user_id AND o.status = 'delivered') AS bought
      FROM refund_requests r LEFT JOIN users u ON u.telegram_id = r.user_id
      WHERE r.created_at >= datetime('now', '-30 days')
      GROUP BY r.user_id HAVING n >= 3 OR (n >= 2 AND n * 2 >= bought)`)
      .map((r) => ({
        key: `refpat_${r.user_id}_${ymd(new Date()).slice(0, 7)}`,
        weight: 2,
        line: `🚩 <b>${esc(who(r))}</b> عمل <b>${r.n}</b> طلبات استرجاع في 30 يوم مقابل ${r.bought} شراية — ردّ بالك`,
      }));
  },

  function silentShop() {
    // Normal sales for this 3-hour window over the last 14 days vs. now.
    const exp = q(`
      SELECT COUNT(*) / 14.0 AS e FROM orders
      WHERE status = 'delivered' AND created_at >= datetime('now','-14 days')
        AND created_at < datetime('now','-3 hours')
        AND ((CAST(strftime('%H', created_at) AS INTEGER) - CAST(strftime('%H','now') AS INTEGER) + 24) % 24) >= 21`)[0];
    const act = q(`SELECT COUNT(*) AS n FROM orders WHERE status='delivered' AND created_at >= datetime('now','-3 hours')`)[0];
    const expected = exp ? Number(exp.e) : 0;
    if (expected >= 2 && act && act.n === 0) {
      const slot = Math.floor(Date.now() / (6 * 3600000));
      return [{ key: `silent_${slot}`, weight: 2,
        line: `🔇 حتى بيعة في آخر 3 سوايع، والعادة في هالوقت ~<b>${expected.toFixed(1)}</b> — ثبّت الدفع والبوت خدامين` }];
    }
    return [];
  },

  function premiumIconsPaused() {
    let st;
    try { st = require('../utils/emojiLayer').emojiStatus(); } catch (_) { return []; }
    const out = [];
    if (!st.icons_enabled) {
      out.push({ key: `icons_off_${ymd(new Date())}`, weight: 2,
        line: `🎨 أيقونات الأزرار المدفوعة <b>مطفية</b> من الإعدادات (/admin ← Settings ← 🎨 Button Icons)` });
    }
    if (st.account_blocked) {
      const why = (st.incidents || []).find((i) => i.kind === 'refused');
      out.push({ key: `icons_paused_${Math.floor(Date.now() / (15 * 60000))}`, weight: 3,
        line: `🎨 الأيقونات المدفوعة <b>واقفة ${st.account_minutes_left} دقيقة</b> — تيليجرام رفضها 3 مرات. ` +
          `الأغلب Telegram Premium متاع صاحب البوت موش شغّال.${why ? ` السبب: «${esc(why.reason.slice(0, 80))}»` : ''} ` +
          `كي تصلّحها ابعث /emojireset` });
    }
    return out;
  },

  function lapsedGoodCustomers() {
    return q(`
      SELECT o.user_id, u.username, u.first_name, COUNT(*) AS n, ROUND(SUM(o.total_price), 2) AS spent,
             MAX(o.created_at) AS last_at
      FROM orders o LEFT JOIN users u ON u.telegram_id = o.user_id
      WHERE o.status = 'delivered'
      GROUP BY o.user_id
      HAVING n >= 5 AND last_at < datetime('now','-14 days') AND last_at > datetime('now','-60 days')
      ORDER BY spent DESC LIMIT 3`)
      .map((r) => ({
        key: `lapsed_${r.user_id}_${ymd(new Date()).slice(0, 7)}`,
        weight: 1,
        idea: true,
        line: `💡 <b>${esc(who(r))}</b> شرى ${r.n} مرات ($${r.spent}) وما رجعش من ${esc(String(r.last_at).slice(0, 10))} — نحضّرلو عرض صغير باش يرجع؟`,
      }));
  },
];

function fmtAge(mins) {
  if (mins < 60) return `${mins} دقيقة`;
  const h = Math.floor(mins / 60);
  return h < 24 ? `${h} ساعة` : `${Math.floor(h / 24)} يوم`;
}

const GROUP_LINE = {
  support:  (n) => `💬 <b>${n}</b> حرفاء يستناو رد في الدعم`,
  private:  (n) => `📥 <b>${n}</b> رسائل خاصة جديدة`,
  cgb_paid: (n) => `🤖 <b>${n}</b> خلّصو ChatGPT ويستناو التفعيل`,
  seat:     (n) => `🤖 <b>${n}</b> مقاعد ChatGPT لازمها تفعيل`,
  manual:   (n) => `📦 <b>${n}</b> تسليمات يدوية تستنى`,
};

function compactLines(findings) {
  const out = [];
  const groups = new Map();
  for (const f of findings) {
    if (f.group && GROUP_LINE[f.group]) {
      if (!groups.has(f.group)) { groups.set(f.group, []); out.push({ group: f.group }); }
      groups.get(f.group).push(f);
    } else out.push({ line: f.line });
  }
  return out.map((o) => {
    if (o.line) return o.line;
    const xs = groups.get(o.group);
    if (xs.length === 1) return xs[0].line;          // a single item keeps its detailed line
    const counts = new Map();
    for (const x of xs) if (x.who) counts.set(x.who, (counts.get(x.who) || 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const names = top.slice(0, 3).map(([n, c]) => esc(n) + (c > 1 ? ` ×${c}` : '')).join('، ');
    const rest = top.slice(3).reduce((a, [, c]) => a + c, 0);
    const oldest = Math.max(0, ...xs.map((x) => x.mins || 0));
    return `${GROUP_LINE[o.group](xs.length)}: ${names}${rest ? ` +${rest}` : ''}` +
      (oldest ? ` · الأقدم ${fmtAge(oldest)}` : '');
  });
}

async function runRules() {
  if (setting('watch_enabled') !== '1') return;
  if (inQuiet()) return; // unsent findings stay unsent, and go out after quiet hours

  const findings = [];
  for (const rule of RULES) {
    try { findings.push(...rule()); } catch (e) { logger.warn(`[sahbi] ${rule.name}: ${e.message}`); }
  }
  const fresh = findings.filter((f) => !seen(f.key));
  if (!fresh.length) return;
  fresh.forEach((f) => firstTime(f.key));
  fresh.sort((a, b) => b.weight - a.weight);

  // Short and calm (V132): similar findings collapse into ONE line
  // ("🤖 10 ChatGPT seats need activation: @a، @b +8"), no header or footer
  // (the app's card has its own), at most 5 lines per alert.
  const lines = compactLines(fresh.filter((f) => !f.idea)).concat(fresh.filter((f) => f.idea).slice(0, 1).map((f) => f.line));
  const html = lines.slice(0, 5).join('\n') + (lines.length > 5 ? `\n<i>+${lines.length - 5} أخرين في 🔔 التنبيهات</i>` : '');

  await push('🤝 ' + html);
  const plain = html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  mem.logChat('alert', plain, { kind: 'rules', count: fresh.length });
}

// ── AI briefs ────────────────────────────────────────────────────────────────

const BRIEF_PROMPTS = {
  morning:
    'MORNING BRIEF (you are writing first, the owner did not ask). In the owner\'s Tunisian Derja. ' +
    'Call recent_activity (hours 12) ONCE and support_digest (hours 12) ONCE, nothing else. Structure: ' +
    '1) one-line greeting with the headline; 2) what happened overnight in numbers; ' +
    '3) what needs action today, most urgent first, with names; ' +
    '4) 💡 2–3 concrete ideas to sell more or save time, each grounded in the data ' +
    '(best sellers, best hours, lapsed good customers, low stock on a winner, pricing). ' +
    'Save anything worth remembering. Keep it tight — a phone screen, not a report.',
  evening:
    'EVENING WRAP (you are writing first, the owner did not ask). In the owner\'s Tunisian Derja. ' +
    'Call sales_summary (1 day) ONCE and recent_activity (hours 12) ONCE, nothing else. Structure: ' +
    '1) the day in one line with revenue and orders vs yesterday; 2) what is still open tonight; ' +
    '3) 💡 one idea for tomorrow grounded in today\'s data; 4) a short warm sign-off. ' +
    'Save anything worth remembering. Short.',
};

async function runBrief(kind) {
  const chat = require('./agentChat');
  if (!chat.proactiveTurn || !chat.agentConfig().hasKey) return;
  try {
    // Logged into the app's chat by the turn itself — nothing to send.
    await chat.proactiveTurn(BRIEF_PROMPTS[kind], kind);
  } catch (e) {
    logger.warn(`[sahbi] ${kind} brief failed: ${e.agentMessage || e.message}`);
  }
}

async function runBriefsIfDue() {
  if (setting('briefs_enabled') !== '1') return;
  const now = local();
  const today = ymd(now);
  for (const kind of ['morning', 'evening']) {
    if (!setting(`brief_${kind}`)) continue;
    const at = toMin(setting(`brief_${kind}`));
    const t = hm(now);
    // Fire in the first tick at or after the set time, once per day.
    if (t >= at && t < at + 60 && firstTime(`brief_${kind}_${today}`)) await runBrief(kind);
  }
}

// ── Nightly learning ──────────────────────────────────────────────────────────
//
// "Yamen should get smarter day by day": once a night he re-reads the day's
// conversation with the owner and saves what he should know tomorrow, with the
// same remember tool he uses in chat (so the owner sees and can delete every
// lesson in the app's memory screen). Words he misheard or the owner uses a lot
// are saved as 'vocab' and feed the voice transcriber's hint.
const LEARN_PROMPT =
  'DAILY LEARNING (the owner did not ask — this is your own study time). Below is today\'s conversation between ' +
  'you and the owner. Find what will make you work better tomorrow, and save each item with the remember tool ' +
  '(one call per item, at most 6, short and self-contained):\n' +
  '- his CORRECTIONS of you (lines marked CORRECTING YOU, or he said no / wrong / شبيك / not like that): look at what ' +
  'you DID just before (the [did: …] lines), find the real mistake (wrong customer, wrong amount, a message that ' +
  'contradicts what you did, an empty answer…) → category "rule": a concrete rule for next time;\n' +
  '- his preferences and standing rules → "owner" or "rule";\n' +
  '- how his business works: products, suppliers, processes, recurring customer problems → "product" / "supplier" / "issue";\n' +
  '- words, names or product names you misheard or that he uses often → "vocab" (just the word or name).\n' +
  'Do NOT save: anything already in your memory, one-off facts (today\'s balance, a single order), secrets ' +
  '(passwords, keys, codes, card numbers), or other people\'s private messages. If nothing is worth saving, save nothing.\n' +
  'Then answer with ONE short line in Tunisian Derja: what you learned today (or that there was nothing new).\n\n' +
  'TODAY\'S CONVERSATION:\n';

function todaysTranscript() {
  const rows = q(`SELECT role, content, meta FROM agent_chat
                  WHERE role IN ('user','assistant','event') AND created_at >= datetime('now','-24 hours')
                  ORDER BY id ASC LIMIT 160`);
  const owner = rows.filter((r) => r.role === 'user').length;
  // With what Yamen DID (the work log) and every correction flagged: the old
  // text-only transcript let him conclude "nothing new today" on a day the
  // owner called him "بهيم" for losing the thread (30-09).
  const text = rows.map((r) => {
    let meta = null; try { meta = r.meta ? JSON.parse(r.meta) : null; } catch (_) {}
    const body = String(r.content || '').replace(/\s+/g, ' ').slice(0, 600);
    if (r.role === 'event') return `EVENT: ${body.slice(0, 200)}`;
    if (r.role === 'user') return `OWNER${meta && meta.correcting ? ' (CORRECTING YOU)' : ''}: ${body}`;
    const work = meta && Array.isArray(meta.work) && meta.work.length ? `\n  [did: ${meta.work.slice(0, 5).join(' | ').slice(0, 500)}]` : '';
    return `YAMEN: ${body}${work}`;
  }).join('\n');
  return { owner, text: text.slice(-20000) };
}

async function runLearnIfDue() {
  if (setting('learn_enabled') !== '1') return;
  const now = local(); const today = ymd(now);
  const at = toMin(setting('learn_at') || '23:30');
  const t = hm(now);
  if (!(t >= at && t < at + 60)) return;
  if (!firstTime(`learn_${today}`)) return;
  const tr = todaysTranscript();
  if (tr.owner < 3) return;                         // too little said today to learn from
  const chat = require('./agentChat');
  if (!chat.proactiveTurn) return;
  const reply = await chat.proactiveTurn(LEARN_PROMPT + tr.text, 'learn');
  if (reply) mem.logChat('event', `🧠 ${String(reply).slice(0, 300)}`, { kind: 'learn' });
}

async function tick() {
  try { await require('./agentStudio').runScheduled(BOT); } catch (e) { logger.warn(`[yamen] scheduled posts: ${e.message}`); }
  try { await runRules(); } catch (e) { logger.warn(`[sahbi] rules: ${e.message}`); }
  try { await runBriefsIfDue(); } catch (e) { logger.warn(`[sahbi] briefs: ${e.message}`); }
  try { await runLearnIfDue(); } catch (e) { logger.warn(`[sahbi] learn: ${e.message}`); }
}

function start(bot) {
  BOT = bot;
  // First pass one minute after boot, so a redeploy does not wait five.
  setTimeout(tick, 60 * 1000);
  setInterval(tick, TICK_MS);
  setInterval(() => require('./agentStudio').runScheduled(BOT).catch(() => {}), POST_TICK_MS);
  logger.info('[sahbi] watcher started');
}

/** Alerts sent recently — fed into Sahbi's prompt so it knows what it said. */
function recentAlerts(limit = 6) {
  return q(`SELECT content, created_at FROM agent_chat WHERE role = 'alert' ORDER BY id DESC LIMIT ?`, limit);
}

module.exports = { _compactLines: compactLines, _runLearnIfDue: runLearnIfDue, _todaysTranscript: todaysTranscript, start, tick, runBrief, runRules, allSettings, saveSettings, recentAlerts, RULES };
