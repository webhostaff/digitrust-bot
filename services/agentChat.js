'use strict';

/**
 * Sahbi — the owner's assistant, opened as an app on the phone.
 *
 * It answers from the shop's real data through services/agentTools.js, whose
 * only write is to the assistant's own notebook (services/agentMemory.js). No
 * tool can move money, change stock or send a message; a customer who writes
 * instructions into a support message can at worst produce a wrong answer on a
 * screen only the owner sees, or a note the owner can delete.
 *
 * Speed comes from three things:
 *   - streaming: words appear as they are produced, tool steps are shown live;
 *   - two tiers: a fast model with light reasoning for everyday questions, the
 *     strongest model with deep reasoning for summaries, analysis and advice —
 *     chosen per message, automatically unless the owner forces one;
 *   - a live snapshot of the shop in every prompt, so simple "what's waiting"
 *     questions need no tool call at all.
 */

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const config = require('../config');
const logger = require('../utils/logger');
const { toolSchemas, runTool, sendApprovedReply, liveSnapshot } = require('./agentTools');
const mem = require('./agentMemory');

const router = express.Router();

// ── Provider & models ────────────────────────────────────────────────────────

const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';

const PROVIDER = (process.env.AGENT_PROVIDER || '').toLowerCase()
  || (ANTHROPIC_KEY ? 'anthropic' : (OPENAI_KEY ? 'openai' : ''));
const API_KEY = PROVIDER === 'openai' ? OPENAI_KEY : ANTHROPIC_KEY;

/**
 * Best first, each followed by the next best. A model the account cannot use
 * answers 404; the next one is tried and the working one remembered, so a miss
 * costs one request per process, not one per message.
 */
const CHAINS = {
  // Cost first. Luna ($0.10 / $0.50 per 1M) answers everyday questions; Sol
  // ($2 / $10) handles summaries and analysis. Astra ($10 / $50) is never used
  // unless pinned with AGENT_MODEL_DEEP=gpt-6-astra — it burned the budget.
  openai: {
    fast: ['gpt-6-luna', 'gpt-5.6-luna', 'gpt-6-sol', 'gpt-4o-mini'],
    deep: ['gpt-6-sol', 'gpt-5.6-sol', 'gpt-6-luna', 'gpt-4o'],
  },
  anthropic: {
    fast: ['claude-sonnet-5', 'claude-sonnet-4-6'],
    deep: ['claude-opus-5-5', 'claude-sonnet-5', 'claude-sonnet-4-6'],
  },
};

// Reasoning tokens are billed as output. Medium is plenty for shop analysis.
const EFFORT = { fast: 'low', deep: 'medium' };

function belongsToProvider(m) {
  if (PROVIDER === 'openai') return !/^claude/i.test(m);
  if (PROVIDER === 'anthropic') return !/^(gpt|o\d|chatgpt)/i.test(m);
  return true;
}

/** AGENT_MODEL pins both tiers; AGENT_MODEL_FAST / AGENT_MODEL_DEEP pin one. */
function buildChain(tier) {
  const base = [...((CHAINS[PROVIDER] || {})[tier] || [])];
  const pins = [process.env[`AGENT_MODEL_${tier.toUpperCase()}`], process.env.AGENT_MODEL]
    .map((x) => String(x || '').trim()).filter(Boolean);
  let chain = base;
  // AGENT_MODEL first, then the tier's own pin, so the tier pin ends up in front.
  for (const want of pins.reverse()) {
    if (!belongsToProvider(want)) {
      logger.warn(`[agent] ${want} does not belong to ${PROVIDER}; ignoring it`);
      continue;
    }
    chain = [want, ...chain.filter((m) => m !== want)];
  }
  return chain;
}

const TIER_CHAIN = { fast: buildChain('fast'), deep: buildChain('deep') };
const tierIndex = { fast: 0, deep: 0 };
const modelFor = (tier) => TIER_CHAIN[tier][tierIndex[tier]] || TIER_CHAIN[tier][0] || '';

function stepDown(tier) {
  const failed = modelFor(tier);
  if (tierIndex[tier] + 1 >= TIER_CHAIN[tier].length) return false;
  tierIndex[tier] += 1;
  logger.warn(`[agent] ${failed} unavailable — ${tier} tier now uses ${modelFor(tier)}`);
  return true;
}

/** The gpt-4 family does not reason and lives on chat/completions. */
const isReasoningOpenAI = (m) => !/^gpt-4/i.test(m);

// ── Token budget ─────────────────────────────────────────────────────────────
//
// Every call's usage is added to today's total. Past the daily budget, Sahbi
// stops calling the AI (the free rule alerts keep running) until tomorrow or
// until the owner raises the budget in the app.

const PRICES = { // $ per 1M tokens: [input, cached input, output]
  'gpt-6-astra': [10, 1, 50], 'gpt-6-sol': [2, 0.2, 10], 'gpt-6-luna': [0.1, 0.01, 0.5],
  'gpt-5.6-sol': [4, 0.4, 20], 'gpt-5.6-luna': [0.25, 0.025, 1.2], 'gpt-4o': [2.5, 1.25, 10],
  'gpt-4o-mini': [0.15, 0.075, 0.6],
  'claude-opus-5-5': [15, 1.5, 75], 'claude-sonnet-5': [3, 0.3, 15], 'claude-sonnet-4-6': [3, 0.3, 15],
  'claude-haiku-4-5-20251001': [1, 0.1, 5],
};

const todayKey = () => `usage_${new Date().toISOString().slice(0, 10)}`;

function usageToday() {
  try { return JSON.parse(mem.getState(todayKey(), '') || '{}'); } catch (_) { return {}; }
}

function addUsage(model, inTok, cachedTok, outTok) {
  const u = usageToday();
  const [pi, pc, po] = PRICES[model] || [2, 0.2, 10];
  const fresh = Math.max(0, (inTok || 0) - (cachedTok || 0));
  u.input = (u.input || 0) + (inTok || 0);
  u.cached = (u.cached || 0) + (cachedTok || 0);
  u.output = (u.output || 0) + (outTok || 0);
  u.calls = (u.calls || 0) + 1;
  u.cost = Number(((u.cost || 0) + (fresh * pi + (cachedTok || 0) * pc + (outTok || 0) * po) / 1e6).toFixed(4));
  mem.setState(todayKey(), JSON.stringify(u));
  return u;
}

/** Daily spend ceiling in dollars, set from the app. 0 = no AI at all. */
const budget = () => {
  const v = parseFloat(mem.getState('daily_budget_usd', '0.50'));
  return Number.isFinite(v) ? v : 0.5;
};
const overBudget = () => (usageToday().cost || 0) >= budget();

class BudgetError extends Error {}

/** Parameters a model refused, dropped from later calls to that model. */
const refused = new Map(); // model → Set(param)
const isRefused = (m, p) => (refused.get(m) || new Set()).has(p);
function refuse(m, p) {
  if (!refused.has(m)) refused.set(m, new Set());
  refused.get(m).add(p);
}

/**
 * Which tier a message needs.
 *
 * Deep for anything that asks to read a lot, weigh things or advise; fast for
 * look-ups and chat. Cheap to decide and right almost always — and the owner
 * can force either from the app.
 */
// Deep only when the message clearly asks for reading a lot or reasoning —
// everything else (greetings, look-ups, "who is waiting") goes to the cheap tier.
const DEEP_HINTS = new RegExp([
  'حوصل', 'لخص', 'ملخص', 'حلل', 'تحليل', 'قارن', 'تقرير', 'خطة', 'استراتيج', 'فكر بالعمق',
  'summar', 'analy', 'report', 'compare', 'strategy', 'résum', 'analys',
].join('|'), 'i');

function pickTier(text, mode) {
  if (mode === 'fast' || mode === 'deep') return mode;
  const t = String(text || '');
  if (mem.getState('allow_deep', '1') !== '1') return 'fast';
  if (t.length > 600 || DEEP_HINTS.test(t)) return 'deep';
  return 'fast';
}

// ── Persona & context ────────────────────────────────────────────────────────

const PERSONA = `You are Sahbi ("my friend" in Tunisian) — the right hand of the owner of a Telegram digital-goods shop (three bots: the store, the support bot, the ChatGPT Business bot, one shared database). You work for the OWNER only.

WHO YOU ARE
- A sharp, loyal business partner who has been in the shop from day one. You remember things, you notice things, you protect the owner's money and time.
- Warm but direct. You say "this customer is abusing refunds" when that is the truth. No flattery, no corporate tone, no filler.
- A little humour when the moment allows it — never when money is at stake or someone is upset.
- You call things by name: customers by @username, products by title, amounts with $.

LANGUAGE — two separate decisions, never confuse them
- To the OWNER: exactly the language and register of their LAST message. Tunisian Derja gets Tunisian Derja back — same words, same spelling style (Arabic script or Latin/Arabizi as they wrote it), not formal Arabic. French → French, English → English. Mixed → mix the same way.
- DRAFTS for customers (propose_reply): ENGLISH, unless the owner names another language for that reply.
- Ids, @usernames, emails, amounts, product names: exactly as in the data.

MEMORY — you are the one who never forgets
- Your notebook is shown below under MEMORY. Use it: bring up what you know when it matters ("this is the same guy who charged back in August").
- Save with remember whenever you learn something worth knowing next week: owner preferences and rules ("never refund Canva after 7 days"), facts about customers, suppliers, products, decisions, recurring issues. Do it quietly, without being asked, and without announcing every save — a short "📝 noted" at the end is enough.
- Fix or delete notes that turn out wrong (update_memory / forget). When the owner says "remember…" or "forget…", do it and confirm.
- Older notes: recall_memory. Earlier talks with the owner: search_past_chats.

HOW YOU WORK
- Never guess a number. The LIVE SNAPSHOT below is real and current — answer from it WITHOUT tools whenever it is enough (greetings, "any messages?", "what's waiting"). Call tools only for what the snapshot does not show, and ask for small windows (hours: 12–24, not 720).
- "Any messages?" / "summarise" / "what's new" / "هل في رسالة" / "شنوة صار": support_digest (24h unless they name a period) and recent_activity when useful. Then a real summary: who wrote, what each one wants, answered or not, what needs action now — most urgent first; group repeated issues; end with concrete next steps.
- Cross-check claims: when a thread mentions an order, email or payment, look it up (customer_lookup, trace_payment, cgb_seats_of).
- When the owner describes a customer from memory ("the guy asking about Canva yesterday"), find them with support_search — do not ask who. If several match, list them briefly and ask which. Say what you found before drafting anything.
- When the owner says a job is done ("I changed it, tell him"), draft the confirmation with propose_reply and name exactly what changed. Drafts are sent only when the owner taps Send.
- Lead with the answer. Quantify ("down 23% vs last week, mostly Gemini Pro"). Volunteer what they would want to know. Flag patterns: the same supplier behind complaints, one buyer draining stock, refunds outnumbering purchases.
- Short by default. A greeting gets one line back plus anything urgent from the snapshot. Long only when the question is.
- Unsure? Say which part and what would settle it.
- You cannot change balances, stock, refunds or send messages yourself. If asked, say which admin screen does it.

BE THE PARTNER WHO THINKS AHEAD
- You watch the shop even when the owner is not asking: you send alerts (customers waiting, stuck deliveries, a winner running out, refund abuse, a silent shop) and a morning and evening brief. RECENT ALERTS below shows what you already told them — follow up on those instead of repeating them.
- End an answer with ONE short idea or next step when you have a good one ("💡 …") — grounded in the data, never generic advice. Skip it when there is nothing worth saying.
- Ideas you can find in the data: products to restock before they run out, best hours to post an offer, good customers who stopped buying, products with many refunds (supplier problem?), price points that sell, bundles bought together, slow products to discount.
- When the owner seems stressed or it is late, be brief and kind. When a win happens (a record day), say it.

FORMAT
- Plain text with light markdown: **bold** for key numbers/names, short "- " bullet lists, no tables, no headings for short answers.`;

function localNowString() {
  let off = 0;
  try { off = parseFloat(require('../database/queries').getSetting('cgb_timezone_offset', '1')) || 0; } catch (_) {}
  const d = new Date(Date.now() + off * 3600000);
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} (UTC${off >= 0 ? '+' : ''}${off})`;
}

function buildInstructions(tier) {
  const snap = (() => { try { return liveSnapshot(); } catch (e) { return { error: e.message }; } })();
  const m = mem.memoryForPrompt(tier === 'deep' ? 3500 : 2000);
  let alerts = [];
  try { alerts = require('./agentWatch').recentAlerts(2); } catch (_) {}
  return `${PERSONA}

NOW: ${localNowString()}

RECENT ALERTS YOU SENT
${alerts.length ? alerts.map((a) => `[${a.created_at}] ${String(a.content).slice(0, 400)}`).join('\n') : '(none)'}

LIVE SNAPSHOT (computed this second from the database)
${JSON.stringify(snap)}

MEMORY (${m.total} note${m.total === 1 ? '' : 's'}${m.lines.length < m.total ? `, newest ${m.lines.length} shown — recall_memory for the rest` : ''})
${m.lines.length ? m.lines.join('\n') : '(empty — start filling it)'}`;
}

/** The last turns as plain messages — for a fresh chain or a stateless provider. */
function recap(excludeLastUser = true) {
  const turns = mem.turnsSinceDivider(6);
  if (excludeLastUser && turns.length && turns[turns.length - 1].role === 'user') turns.pop();
  return turns.map((t) => ({ role: t.role, content: String(t.content || '').slice(0, 1200) }));
}

// ── Access ───────────────────────────────────────────────────────────────────

const ACCESS_TOKEN = process.env.AGENT_TOKEN || crypto.randomBytes(16).toString('hex');

function requireToken(req, res, next) {
  const t = req.query.t || req.get('X-Agent-Token') || '';
  if (t !== ACCESS_TOKEN) return res.status(401).json({ error: 'Invalid or missing token' });
  next();
}

// ── Provider calls ───────────────────────────────────────────────────────────

const MAX_ROUNDS = 8;

/** Read an axios error whose body is a stream, so its message can be inspected. */
async function readErrorBody(e) {
  const d = e.response && e.response.data;
  if (d && typeof d.on === 'function') {
    const chunks = [];
    try { for await (const c of d) chunks.push(Buffer.from(c)); } catch (_) {}
    const txt = Buffer.concat(chunks).toString('utf8');
    try { e.response.data = JSON.parse(txt); } catch (_) { e.response.data = { error: { message: txt } }; }
  }
  return e;
}

/**
 * One provider call that survives the recoverable failures:
 *   404 / model_not_found → the next model of this tier;
 *   400 naming a parameter the model refuses → drop it and retry.
 * `send(model)` performs the call for the given model.
 */
async function callWithFallback(tier, send) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const model = modelFor(tier);
    try {
      return await send(model);
    } catch (e0) {
      const e = await readErrorBody(e0);
      if (axios.isCancel(e) || e.name === 'CanceledError') throw e;
      const status = e.response?.status;
      const err = e.response?.data?.error || {};
      const msg = String(err.message || '');
      const notFound = status === 404 || err.code === 'model_not_found' ||
        /model.*(not found|does not exist|not have access)/i.test(msg);
      if (notFound && !/previous.response/i.test(msg) && stepDown(tier)) continue;

      if (status === 400) {
        const bad = ['reasoning_effort', 'max_completion_tokens', 'max_output_tokens', 'max_tokens', 'reasoning']
          .find((p) => msg.includes(p) && !isRefused(model, p));
        if (bad) {
          refuse(model, bad);
          logger.warn(`[agent] ${model} refused ${bad}; retrying without it`);
          continue;
        }
      }
      e.agentMessage = msg || e.message;
      throw e;
    }
  }
  throw new Error('Could not reach a working model');
}

/**
 * Stream one Responses API call. Text deltas go straight to `emit`; resolves
 * with the completed response object (which carries any function calls).
 */
async function streamResponse(body, emit, signal) {
  const res = await axios.post('https://api.openai.com/v1/responses', { ...body, stream: true }, {
    headers: { Authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
    responseType: 'stream',
    timeout: 300000,
    signal,
  });

  return new Promise((resolve, reject) => {
    let buf = '';
    let done = null;
    res.data.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const data = block.split('\n').filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim()).join('');
        if (!data || data === '[DONE]') continue;
        let ev;
        try { ev = JSON.parse(data); } catch (_) { continue; }
        if (ev.type === 'response.output_text.delta' && ev.delta) emit({ type: 'delta', text: ev.delta });
        else if (ev.type === 'response.completed' || ev.type === 'response.incomplete') done = ev.response;
        else if (ev.type === 'response.failed') {
          const m = ev.response?.error?.message || 'The model failed to answer';
          return reject(Object.assign(new Error(m), { agentMessage: m }));
        } else if (ev.type === 'error') {
          const m = ev.error?.message || ev.message || 'Stream error';
          return reject(Object.assign(new Error(m), { agentMessage: m }));
        }
      }
    });
    res.data.on('end', () => (done ? resolve(done) : reject(new Error('Stream ended without a response'))));
    res.data.on('error', reject);
  });
}

const TOOL_LABEL = {
  support_digest: '📨 يقرا المحادثات', support_unread: '📨 يشوف شكون يستنى', support_thread: '💬 يقرا محادثة',
  support_search: '🔎 يلوّج في المحادثات', support_examples: '📚 يشوف كيفاش جاوبت قبل',
  recent_activity: '🕒 يشوف شنوة صار', shop_overview: '📊 نظرة عامة', sales_summary: '📈 المبيعات',
  best_hours: '🕐 أحسن سوايع', api_sales: '🔌 مبيعات API', products_list: '🛍 المنتجات',
  stock_audit: '📦 يراجع المخزون', stock_batches: '📦 الدفعات', stock_reconcile: '🧮 يحسب المخزون',
  suppliers: '🏷 الموردين', find_account_supplier: '🏷 يلوّج على المورد', customer_lookup: '👤 ملف الحريف',
  top_customers: '👑 أحسن الحرفاء', cgb_seats_of: '🤖 مقاعد ChatGPT', trace_payment: '💳 يتبّع الدفعة',
  refund_requests: '🔄 طلبات الاسترجاع', cgb_overview: '🤖 ChatGPT Business', propose_reply: '✍️ يكتب رد',
  remember: '📝 يحفظ', update_memory: '📝 يصلّح ملاحظة', forget: '🗑 ينسى', recall_memory: '🧠 يتفكّر',
  search_past_chats: '🧠 يلوّج في كلامنا',
};

function runTools(calls, emit, drafts, used) {
  return calls.map((c) => {
    emit({ type: 'status', text: TOOL_LABEL[c.name] || `⚙️ ${c.name}` });
    used.push(c.name);
    const out = runTool(c.name, c.args);
    if (c.name === 'propose_reply' && out && out.draft_id) {
      drafts.push(out);
      emit({ type: 'draft', draft: out });
    }
    // Tool results are the biggest input cost; 12k characters is ~3k tokens.
    return { id: c.id, output: JSON.stringify(out === undefined ? null : out).slice(0, 12000) };
  });
}

const parseArgs = (s) => { try { return JSON.parse(s || '{}'); } catch (_) { return {}; } };

/** OpenAI Responses API — tools + reasoning together, streamed, chained. */
async function turnOpenAIResponses(text, tier, emit, signal, drafts, used) {
  const tools = toolSchemas().map((t) => ({
    type: 'function', name: t.name, description: t.description, parameters: t.input_schema,
  }));
  let previous = mem.getState('openai_prev') || null;
  let input = previous ? [{ role: 'user', content: text }] : [...recap(), { role: 'user', content: text }];
  let reply = '';
  let lastInput = 0;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (overBudget()) throw new BudgetError('budget');
    let response;
    try {
      response = await callWithFallback(tier, (model) => {
        const body = { model, instructions: buildInstructions(tier), input, tools };
        if (previous) body.previous_response_id = previous;
        if (!isRefused(model, 'max_output_tokens')) body.max_output_tokens = tier === 'deep' ? 6000 : 2500;
        if (!isRefused(model, 'reasoning')) body.reasoning = { effort: EFFORT[tier] };
        return streamResponse(body, (ev) => { if (ev.type === 'delta') reply += ev.text; emit(ev); }, signal);
      });
    } catch (e) {
      // The chain OpenAI keeps expires (30 days) or is lost; start a new one
      // from our own copy of the conversation rather than failing.
      if (previous && /previous.response|not found/i.test(e.agentMessage || '') && round === 0) {
        logger.warn('[agent] conversation chain expired — rebuilding from local history');
        previous = null;
        mem.setState('openai_prev', null);
        input = [...recap(), { role: 'user', content: text }];
        round -= 1;
        continue;
      }
      throw e;
    }

    previous = response.id;
    const us = response.usage || {};
    addUsage(response.model || modelFor(tier), us.input_tokens, us.input_tokens_details?.cached_tokens, us.output_tokens);
    lastInput = us.input_tokens || lastInput;
    const calls = (response.output || []).filter((o) => o.type === 'function_call')
      .map((c) => ({ id: c.call_id, name: c.name, args: parseArgs(c.arguments) }));

    if (!calls.length) {
      // A chained conversation re-bills its whole history as input on every
      // call. Once it grows past ~25k tokens, close it: the next message starts
      // a fresh chain from a short recap (memory and snapshot carry the rest).
      mem.setState('openai_prev', lastInput > 25000 ? null : previous);
      if (!reply) {
        reply = (response.output || []).filter((o) => o.type === 'message')
          .flatMap((o) => o.content || []).filter((c) => c.type === 'output_text')
          .map((c) => c.text).join('\n');
        if (reply) emit({ type: 'delta', text: reply });
      }
      return reply;
    }
    if (reply && !reply.endsWith('\n')) { reply += '\n\n'; emit({ type: 'delta', text: '\n\n' }); }
    input = runTools(calls, emit, drafts, used)
      .map((r) => ({ type: 'function_call_output', call_id: r.id, output: r.output }));
  }
  return reply || 'That took too many steps. Try asking something narrower.';
}

/** OpenAI chat/completions — only for the gpt-4 family, which cannot reason. */
async function turnOpenAIChat(text, tier, emit, signal, drafts, used) {
  const tools = toolSchemas().map((t) => ({
    type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
  const messages = [{ role: 'system', content: buildInstructions(tier) }, ...recap(), { role: 'user', content: text }];
  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (overBudget()) throw new BudgetError('budget');
    const res = await callWithFallback(tier, (model) => axios.post('https://api.openai.com/v1/chat/completions', {
      model, messages, tools, tool_choice: 'auto', max_tokens: 1500,
    }, { headers: { Authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' }, timeout: 240000, signal }));
    const u = res.data.usage || {};
    addUsage(res.data.model || modelFor(tier), u.prompt_tokens, u.prompt_tokens_details?.cached_tokens, u.completion_tokens);
    const msg = res.data.choices[0].message;
    messages.push(msg);
    const calls = (msg.tool_calls || []).map((c) => ({ id: c.id, name: c.function.name, args: parseArgs(c.function.arguments) }));
    if (!calls.length) { emit({ type: 'delta', text: msg.content || '' }); return msg.content || ''; }
    for (const r of runTools(calls, emit, drafts, used)) messages.push({ role: 'tool', tool_call_id: r.id, content: r.output });
  }
  return 'That took too many steps. Try asking something narrower.';
}

/** Anthropic — stateless, so the recent conversation is sent each time. */
async function turnAnthropic(text, tier, emit, signal, drafts, used) {
  const tools = toolSchemas();
  const messages = [...recap(), { role: 'user', content: text }];
  // Anthropic wants strictly alternating turns starting with the user; a brief
  // Sahbi wrote on its own leaves two assistant turns in a row, so merge them.
  while (messages.length && messages[0].role !== 'user') messages.shift();
  for (let k = messages.length - 1; k > 0; k--) {
    if (messages[k].role === messages[k - 1].role && typeof messages[k].content === 'string') {
      messages[k - 1].content += '\n\n' + messages[k].content;
      messages.splice(k, 1);
    }
  }

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (overBudget()) throw new BudgetError('budget');
    const res = await callWithFallback(tier, (model) => axios.post('https://api.anthropic.com/v1/messages', {
      model, max_tokens: tier === 'deep' ? 4000 : 1500, system: buildInstructions(tier), tools, messages,
    }, {
      headers: { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      timeout: 240000, signal,
    }));
    const u = res.data.usage || {};
    addUsage(res.data.model || modelFor(tier), (u.input_tokens || 0) + (u.cache_read_input_tokens || 0),
      u.cache_read_input_tokens, u.output_tokens);
    const content = res.data.content || [];
    messages.push({ role: 'assistant', content });
    const calls = content.filter((c) => c.type === 'tool_use').map((c) => ({ id: c.id, name: c.name, args: c.input }));
    const said = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (said) emit({ type: 'delta', text: said + (calls.length ? '\n\n' : '') });
    if (!calls.length) return said;
    messages.push({ role: 'user', content: runTools(calls, emit, drafts, used)
      .map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.output })) });
  }
  return 'That took too many steps. Try asking something narrower.';
}

/** One owner message, end to end. */
async function runTurn({ text, mode, emit, signal, proactive = null }) {
  const tier = pickTier(text, mode);
  const drafts = [];
  const used = [];
  emit({ type: 'start', tier, model: modelFor(tier) });
  // A brief Sahbi writes on its own has no visible question; the prompt is
  // stored as 'auto' so it is neither shown nor replayed as the owner's words.
  mem.logChat(proactive ? 'auto' : 'user', text, { tier, proactive });

  const fn = PROVIDER === 'anthropic' ? turnAnthropic
    : (isReasoningOpenAI(modelFor(tier)) ? turnOpenAIResponses : turnOpenAIChat);
  const reply = await fn(text, tier, emit, signal, drafts, used);
  const meta = { tier, model: modelFor(tier), tools: [...new Set(used)], drafts: drafts.map((d) => ({ ...d })), proactive };
  mem.logChat('assistant', reply, meta);
  emit({ type: 'done', ...meta });
  return { reply, drafts, ...meta };
}

/** Sahbi speaking first (briefs). Continues the same conversation. */
let proactiveBusy = false;
async function proactiveTurn(prompt, kind) {
  if (!API_KEY || proactiveBusy || overBudget()) return '';
  proactiveBusy = true;
  try {
    // Briefs run on the cheap tier: they summarise data the tools already shaped.
    const r = await runTurn({ text: prompt, mode: 'fast', emit: () => {}, signal: undefined, proactive: kind });
    return r.reply;
  } finally {
    proactiveBusy = false;
  }
}

function explainError(e) {
  if (e instanceof BudgetError) {
    const u = usageToday();
    return `💸 وصلت للحد اليومي ($${budget().toFixed(2)} — صرفت $${(u.cost || 0).toFixed(2)} اليوم). ` +
      `التنبيهات المجانية تكمّل تخدم. تنجم تزيد الحد من 🧠 ← 💸.`;
  }
  const status = e.response?.status;
  const detail = e.agentMessage || e.response?.data?.error?.message || e.message;
  if (status === 401) return `مفتاح ${PROVIDER} مرفوض — ثبّت ${PROVIDER === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'} في Railway. (${detail})`;
  if (status === 429) return `${PROVIDER}: وصلت للحد أو الرصيد خلص — شوف الفوترة في حسابك. (${detail})`;
  return detail;
}

// ── Routes ───────────────────────────────────────────────────────────────────

router.use(express.json({ limit: '1mb' }));

/** Streaming chat: server-sent events, one JSON object per event. */
router.post('/chat/stream', requireToken, async (req, res) => {
  const text = String(req.body.message || '').trim();
  const mode = String(req.body.mode || 'auto');
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const emit = (o) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(o)}\n\n`); };
  const ping = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 15000);
  const ctrl = new AbortController();
  // res, not req: on current Node, req 'close' fires as soon as the body has
  // been read, which would cancel every answer before it started.
  res.on('close', () => { if (!res.writableEnded) ctrl.abort(); });

  try {
    if (!API_KEY) throw Object.assign(new Error('No AI key configured. Set OPENAI_API_KEY or ANTHROPIC_API_KEY.'), {});
    if (!text) throw new Error('Empty message');
    await runTurn({ text, mode, emit, signal: ctrl.signal });
  } catch (e) {
    if (!ctrl.signal.aborted) {
      const m = explainError(e);
      logger.error(`[agent] ${m}`);
      mem.logChat('error', m);
      emit({ type: 'error', error: m });
    } else {
      mem.logChat('assistant', '⏹ (stopped)', { stopped: true });
    }
  } finally {
    clearInterval(ping);
    res.end();
  }
});

/** Non-streaming form, kept for scripts and older installed apps. */
router.post('/chat', requireToken, async (req, res) => {
  if (!API_KEY) return res.status(503).json({ error: 'No AI key configured.' });
  const text = String(req.body.message || '').trim();
  if (!text) return res.status(400).json({ error: 'Empty message' });
  try {
    const r = await runTurn({ text, mode: req.body.mode, emit: () => {}, signal: undefined });
    res.json({ reply: r.reply, drafts: r.drafts, model: r.model, tier: r.tier });
  } catch (e) {
    const m = explainError(e);
    logger.error(`[agent] ${m}`);
    res.status(500).json({ error: m });
  }
});

router.post('/approve', requireToken, async (req, res) => {
  const id = String(req.body.draft_id || '');
  if (!id) return res.status(400).json({ error: 'draft_id required' });
  const bot = req.app && req.app.get('bot');
  const r = await sendApprovedReply(id, bot);
  if (!r.ok) return res.status(400).json({ error: r.error });
  mem.logChat('event', `✅ Reply sent to ${r.user_id}`);
  res.json({ ok: true, user_id: r.user_id });
});

/** A new conversation. Memory stays — only the running thread is closed. */
router.post('/reset', requireToken, (req, res) => {
  mem.setState('openai_prev', null);
  mem.logChat('divider', '');
  res.json({ ok: true });
});

/** Instant, no-AI brief for the top of the app. */
router.get('/brief', requireToken, (req, res) => {
  let snap = {};
  try { snap = liveSnapshot(); } catch (_) {}
  res.json({ snapshot: snap, memory: mem.listMemory(1000).length, usage: usageToday(), budget: budget(),
    models: { fast: modelFor('fast'), deep: modelFor('deep') }, provider: PROVIDER, now: localNowString() });
});

function costSettings() {
  return { daily_budget_usd: String(budget()), allow_deep: mem.getState('allow_deep', '1'), usage_today: usageToday() };
}
router.get('/settings', requireToken, (req, res) =>
  res.json({ ...require('./agentWatch').allSettings(), ...costSettings() }));
router.post('/settings', requireToken, (req, res) => {
  const b = req.body || {};
  if (b.daily_budget_usd !== undefined) {
    const v = Math.max(0, Math.min(100, parseFloat(b.daily_budget_usd) || 0));
    mem.setState('daily_budget_usd', String(v));
  }
  if (b.allow_deep !== undefined) mem.setState('allow_deep', b.allow_deep === '1' || b.allow_deep === true ? '1' : '0');
  res.json({ ...require('./agentWatch').saveSettings(b), ...costSettings() });
});

/** "Give me the brief now" from the app — same brief, on demand. */
router.post('/brief/now', requireToken, async (req, res) => {
  const kind = req.body.kind === 'evening' ? 'evening' : 'morning';
  try {
    await require('./agentWatch').runBrief(kind);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: explainError(e) }); }
});

/** Run the watch rules right now (the app's "check now" button). */
router.post('/watch/now', requireToken, async (req, res) => {
  try { await require('./agentWatch').runRules(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/history', requireToken, (req, res) => {
  const after = Number(req.query.after) || 0;
  const items = mem.recentChat(Math.min(200, Number(req.query.limit) || 80));
  res.json({ items: after ? items.filter((i) => i.id > after) : items });
});

router.get('/memory', requireToken, (req, res) => res.json({ items: mem.listMemory(1000) }));
router.post('/memory/add', requireToken, (req, res) => {
  const id = mem.addMemory(req.body.text, req.body.category || 'owner', 'owner');
  res.json({ ok: !!id, id });
});
router.post('/memory/update', requireToken, (req, res) => res.json({ ok: mem.updateMemory(req.body.id, req.body.text) }));
router.post('/memory/delete', requireToken, (req, res) => res.json({ ok: mem.deleteMemory(req.body.id) }));

// The app page lives in its own file so it can be edited as plain HTML.
const PAGE = require('fs').readFileSync(require('path').join(__dirname, 'agentPage.html'), 'utf8');

// ── Installable app: manifest, icon, service worker ──────────────────────────
//
// These three files are what turn a web page into something a phone will keep
// on the home screen with its own icon and no browser chrome. The icon is an
// inline SVG rather than a PNG file so the whole app stays inside this one
// module — nothing to upload, nothing to keep in sync.

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<rect width="512" height="512" rx="112" fill="#0f1115"/>
<circle cx="256" cy="212" r="92" fill="none" stroke="#3b82f6" stroke-width="26"/>
<circle cx="224" cy="196" r="13" fill="#3b82f6"/><circle cx="288" cy="196" r="13" fill="#3b82f6"/>
<path d="M214 244q42 30 84 0" stroke="#3b82f6" stroke-width="18" fill="none" stroke-linecap="round"/>
<rect x="150" y="330" width="212" height="26" rx="13" fill="#3b82f6" opacity=".9"/>
<rect x="150" y="382" width="150" height="26" rx="13" fill="#3b82f6" opacity=".55"/>
</svg>`;

router.get('/icon.svg', (req, res) => {
  res.type('image/svg+xml').set('Cache-Control', 'public, max-age=604800').send(ICON_SVG);
});

router.get('/manifest.json', (req, res) => {
  const t = req.query.t || '';
  res.type('application/manifest+json').json({
    name: 'Sahbi · صاحبي',
    short_name: 'Sahbi',
    // The token travels in start_url so the installed icon opens straight into
    // an authenticated session — otherwise every launch would be a 401.
    start_url: `./?t=${t}`,
    scope: './',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#0f1115',
    theme_color: '#0f1115',
    icons: [
      { src: `./icon.svg?t=${t}`, sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
    ],
  });
});

router.get('/sw.js', (req, res) => {
  // Deliberately minimal: it exists so the app is installable and so a launch
  // with no signal shows the shell instead of a browser error. Answers are
  // never cached — a stale sales figure is worse than no figure.
  res.type('application/javascript').send(`
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;          // never cache chat calls
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
`);
});

// ── The phone interface ──────────────────────────────────────────────────────
// Served as one self-contained page so it can be added to a home screen and
// opened like an app, with no build step and nothing to install.
// Reachability probe for the admin panel. Carries no data and needs no token.
router.get('/ping', (req, res) => res.json({ ok: true, service: 'shop-assistant' }));

router.get('/', (req, res) => {
  // The page calls chat, approve, manifest.json… by RELATIVE path. Opened as
  // /agent (no slash) those resolve to /chat, /approve at the site root, which
  // do not exist — every message fails. Force the slash so they stay under
  // /agent/ whatever the browser did to the link.
  const [pathPart, query] = req.originalUrl.split('?');
  if (!pathPart.endsWith('/')) {
    return res.redirect(302, `${pathPart}/${query ? `?${query}` : ''}`);
  }
  if ((req.query.t || '') !== ACCESS_TOKEN) {
    // Reached by typing the domain by hand, or by an installed app whose token
    // changed on a redeploy. The old message said only "token required", which
    // explains nothing about how to get one.
    const generated = !process.env.AGENT_TOKEN;
    return res.status(401).type('html').send(
      `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:16px/1.7 -apple-system,system-ui,sans-serif;margin:0;padding:32px 24px;
background:#0b0e14;color:#eef1f6}h3{margin:0 0 6px}p{color:#8b95a7;margin:14px 0}
code{background:#151a23;border:1px solid #242b38;border-radius:6px;padding:2px 7px;font-size:14px}
b{color:#eef1f6}</style></head><body>
<h3>🔒 This link needs its access token</h3>
<p>Open it from your bot: <b>/admin → 🤖 AI Assistant → Open Assistant</b>.
The link there carries the token.</p>
${generated ? `<p>⚠️ Your token is regenerated on every deploy, so an installed
app stops working after each one. Add <code>AGENT_TOKEN</code> in Railway with
any long random text to fix that permanently, then reinstall from the fresh link.</p>` : ''}
</body></html>`
    );
  }
  // split/join, not replace(): replace() with a string swaps only the FIRST
  // occurrence. The page carries the token three times, and the one the chat
  // uses was the third — so the page loaded fine and every message was then
  // refused with "Invalid or missing token".
  res.type('html').send(PAGE.split('__TOKEN__').join(ACCESS_TOKEN));
});


/**
 * Everything the admin panel needs to decide what to show.
 *
 * The base URL is resolved here rather than passed in, so the link the panel
 * offers and the link the app opens are built from the same source and cannot
 * drift apart.
 */
function originOf(v) {
  const t = String(v || '').trim();
  if (!t) return '';
  try { return new URL(/^https?:\/\//i.test(t) ? t : `https://${t}`).origin; } catch (_) { return ''; }
}

/**
 * Ask the public address whether it really serves the assistant.
 *
 * "Configured" and "reachable" are different claims. The link can point at a
 * domain that belongs to another service, an old deploy without /agent, or a
 * domain Railway no longer routes — all of which open "Not found". Checking
 * from the server turns that into a reason on the admin screen.
 */
async function probeAgent(base) {
  if (!base) return { ok: false, reason: 'no base' };
  try {
    const r = await axios.get(`${base}/agent/ping`, { timeout: 6000, validateStatus: () => true });
    if (r.status === 200 && r.data && r.data.service === 'shop-assistant') return { ok: true };
    return { ok: false, status: r.status, reason: `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, reason: e.code || e.message };
  }
}

function agentConfig() {
  const manual = String(require('../database/queries').getSetting('api_base_url', '') || '')
    .trim().replace(/\/+$/, '');
  const railway = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RAILWAY_STATIC_URL || '';
  const fromEnv = railway
    ? (railway.startsWith('http') ? railway.replace(/\/+$/, '') : `https://${railway}`)
    : String(config.publicBaseUrl || '').trim().replace(/\/+$/, '');

  // Only the origin is kept. A base saved with a path — /apibase
  // https://x.up.railway.app/api/v2, say — produced /api/v2/agent/, which is
  // not a route, and the button opened a "Not found" page.
  const base = originOf(manual || fromEnv);
  const real = /^https?:\/\/[^\s/]+\.[^\s/]+/.test(base);

  return {
    base: real ? base : '',
    url: real ? `${base}/agent/?t=${ACCESS_TOKEN}` : '',
    hasKey: !!API_KEY,
    provider: PROVIDER,
    model: `⚡ ${modelFor('fast')} · 🧠 ${modelFor('deep')}`,
    // A generated token changes on every deploy, so an installed app would stop
    // working after each one — worth warning about before that happens.
    fixedTok: !!process.env.AGENT_TOKEN,
  };
}


module.exports = { router, ACCESS_TOKEN, agentConfig, probeAgent, proactiveTurn };
