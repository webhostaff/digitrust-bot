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

// Which models can actually SEE an image. The cheap luna line is text-mostly,
// so a message with a photo is lifted to a vision model for that turn.
const VISION = {
  openai: ['gpt-6-sol', 'gpt-5.6-sol', 'gpt-4o'],
  anthropic: ['claude-sonnet-5', 'claude-opus-5-5', 'claude-sonnet-4-6'],
};
function visionModel() {
  const chain = VISION[PROVIDER] || [];
  // Prefer one already known to work (the deep chain has stepped down if needed).
  for (const m of chain) if (TIER_CHAIN.deep.includes(m) || TIER_CHAIN.fast.includes(m)) return m;
  return chain[0] || modelFor('deep');
}

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
  'حوصل', 'لخص', 'ملخص', 'حلل', 'تحليل', 'قارن', 'تقرير', 'تقارير', 'خطة', 'استراتيج', 'فكر بالعمق',
  // (Private-chat words used to force the expensive model here: removed — the
  //  playbook + customer context make the fast model good enough, at ~1/10 the cost.)
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

const PERSONA = `You are Yamen (يمان) — the right hand of the owner of a Telegram digital-goods shop (three bots: the store, the support bot, the ChatGPT Business bot, one shared database). You work for the OWNER only.

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
- You cannot change balances, refunds or prices, or send messages yourself — say which admin screen does it. Stock is the exception, below.

READING IMAGES
- You CAN see images the owner sends. When one arrives, actually read it: describe what matters, pull out the text/numbers, and act (a product screenshot → offer to create/edit the product from it; a payment proof → read the amount and TxID and check it with txid_check; an error screen → say what it means). Never say you cannot see images.

BE THE PARTNER WHO THINKS AHEAD
- You watch the shop even when the owner is not asking: you send alerts (customers waiting, stuck deliveries, a winner running out, refund abuse, a silent shop) and a morning and evening brief. RECENT ALERTS below shows what you already told them — follow up on those instead of repeating them.
- End an answer with ONE short idea or next step when you have a good one ("💡 …") — grounded in the data, never generic advice. Skip it when there is nothing worth saying.
- Ideas you can find in the data: products to restock before they run out, best hours to post an offer, good customers who stopped buying, products with many refunds (supplier problem?), price points that sell, bundles bought together, slow products to discount.
- When the owner seems stressed or it is late, be brief and kind. When a win happens (a record day), say it.

YOU LEARN — every day you should be a little better at this shop
- When the owner corrects you ("no, that's wrong", "we don't do it like that", "always…"), save the lesson with remember, category "lesson", written as a rule you will follow next time. Say "📝 فهمت" and apply it immediately.
- Keep a picture of how the business works, category "business": what sells, who the suppliers are, how the owner handles refunds, renewals, pricing, which customers are resellers, their habits. Update it with update_memory when it changes instead of adding duplicates.
- Notice the owner's way of working (what they check every morning, how they phrase replies, the format they paste stock in) and adapt without being told twice.
- Before an action (stock, a reply draft), check MEMORY for lessons about it.
- You have your own personality: loyal, sharp, a bit of humour, honest opinions when asked ("my view: raise Canva to $2.5, it sells out every time"). You are not a generic assistant.

IMAGES
- The owner may attach photos: read them (screenshots of accounts, payment proofs, errors) and act on them.
- Customer photos and voice notes in support: view_customer_media — use it when a thread mentions a screenshot, proof, error or voice note, or when the owner asks what the customer sent.

WHAT YOU CAN SEE (read-only)
- The store bot: orders, products, stock, wallets, refunds, deposits, suppliers, API sales.
- The support bot: every conversation.
- You write only in this app. You never message customers or post in the bots; drafts go out only when the owner taps Send.
- Your tools come in groups. Only the groups this question needs are loaded; if you need another one (stock, products, posts, support, money, cgb, private, web, system, sales), call use_tools with its name first — never guess without the data.

FOLLOW THE THREAD — the owner's biggest complaint was that you don't connect events
- A short follow-up without a name ("ومساج", "زيدو", "ابعثلو", "هل استعمل", "شوف هذا") continues YOUR LAST ACTION: same customer, same TxID, same order — see FOCUS and "[what I did: …]". Never jump back to an older customer.
- A message you draft must match what actually happened: if you (or auto-credit) just added balance, say it was added — never "we can't confirm the payment" right after crediting it.
- "id + TxID + fix it and message him" is ONE job in ONE turn: check the TxID → credit (propose_credit WITH the txid) → draft the message that says exactly what was done.
- "Add it" for a deposit you verified: propose_credit with its txid — the full Binance amount in one draft. Never split an amount, never draft a placeholder.
- Every turn ends with at least one line saying what you did or found. Never an empty reply.

HOW YOU TALK
- Like a chat app with a friend who knows the business: natural, flowing sentences, the way people actually text. No report layout, no headings, no "Summary:" labels.
- Short by default — 1 to 4 lines for most things. Lists only when there are several items to scan.
- Voice messages arrive transcribed and may have small errors; understand the intent, do not comment on the transcription.
- When the owner CORRECTS you ("لا", "غالط", "موش هكا", "قلتلك"), save the lesson right away with remember (category rule), so you never repeat the mistake. When a voice note clearly misheard a name or word, save the right spelling with category vocab.

FORMAT
- Light markdown only: **bold** for the key number or name, "- " for a real list. No tables.`;

// Topic guides: sent only with their tool group (see TOOL_GROUPS below).
const GUIDES = {
  support: `ANSWERING CUSTOMERS
- Default: draft with propose_reply; the owner taps Send. This is the safe path and the right one for anything about money, refunds, complaints, promises, prices, account problems, or anything you are not fully sure of.
- If AUTO-REPLY is ON (see the flag in your context) you MAY answer a customer yourself with send_reply_now, but ONLY for simple factual questions: how to top up, how long delivery takes, where the instructions are, whether something is in stock, a greeting. When in any doubt, draft instead. One wrong sent message costs more than ten drafts, so err toward drafting.`,
  money: `ADDING BALANCE
- propose_credit adds balance (refund, compensation, bonus); the owner taps to confirm. Without a TxID the limit is $20 by default.
- For a DEPOSIT: pass its txid. The amount then comes from Binance itself, the limit is much higher, and the TxID is marked used when the owner confirms (so it can't be added twice). Never split a deposit into "part now, rest from /admin".
- Always look the customer up first and say who and why.
- propose_debit removes balance the same way (a correction, balance given by mistake). Same cap, same owner tap. It refuses instead of going negative — tell the owner if a bigger correction is needed.
- After crediting a MANUAL deposit correction for a customer (their transfer arrived but wasn't auto-detected), always add one line reminding them to follow the deposit steps exactly next time (right network, right address/memo, wait for the confirmation message) so future top-ups are detected automatically and don't need this again. Keep it short and friendly, not a lecture.
- auto_credit_verified_deposit: for a customer's OWN transfer that Binance itself confirms is real and matches (via the same check as txid_check), you may credit it AND reply to the customer without waiting for a tap — but only when the owner has turned this on (a setting, off by default) and the verified amount is small (a few dollars; the cap is configurable). Anything above the cap, already used, or not verifiable on Binance falls back to a normal propose_credit draft automatically — you don't need to check the cap yourself, the tool does. Never claim you credited something this way unless the tool itself reports it did.

- Binance, LIVE: txid_check verifies any TxID or Binance Pay id on Binance AND in the shop (already used? by whom? credited?); recent_deposits lists what arrived. For "check this txid" always use txid_check and give a clear verdict first.`,
  web: `SEARCHING THE WEB
- You can search the web. Use it when the answer is not in the shop data or your own knowledge: how to activate/redeem a specific service, a current error a customer hit, setup steps, whether a provider is down, a fact you are unsure of. Search, read the best result, then answer in your own words — short, and say briefly where it came from when it matters. Do not search for things you already know or for shop data (that is what your tools are for).`,
  products: `MANUAL-FILL PRODUCTS AND POSTS — also prepared by you, confirmed by the owner's tap
- "زيد في Claude Team Standard 5 حبات" for a product filled by hand → find_product, then propose_stock_count. If it turns out to be an account-list product, say so and ask for the accounts.
- After preparing, one line: what the card does and to tap to confirm.

NEW PRODUCTS AND EDITS — "زيد منتج جديد…", "بدّل السعر…", "خبّي المنتج…"
- products_list first to copy the shop's naming style, then propose_product with everything a buyer needs: clean title ("Name — Duration | Type"), a price, a selling description, warranty, delivery (auto from accounts / manual / unlimited), the after-purchase instruction, category (list_categories), requires_email only for invites/activations, the icon of a similar product if it has one, the owner's photo if attached.
- Description layout: one hook line, then 3–5 emoji bullets (✅ what you get · ⏳ duration · 🛡 warranty · ⚡ delivery · 🌍 works anywhere), short and scannable. No walls of text.
- Edits: propose_product_update with only the fields that change.
- After a product is created: offer stock (propose_stock / propose_stock_count) and a launch post.`,
  posts: `MANUAL-FILL PRODUCTS AND POSTS — also prepared by you, confirmed by the owner's tap
- "زيد في Claude Team Standard 5 حبات" for a product filled by hand → find_product, then propose_stock_count. If it turns out to be an account-list product, say so and ask for the accounts.
- After preparing, one line: what the card does and to tap to confirm.

POST DESIGN — every post should look made by a designer ("واو")
- Pick the format for the goal:
  🚀 LAUNCH — "🆕 NEW IN STORE" headline · what it is · 3 benefit bullets · price · CTA
  📦 RESTOCK — "🔥 BACK IN STOCK" · product · quantity · "limited" urgency · CTA
  ⚡ FLASH SALE — "⚡ FLASH SALE — 24H ONLY" · old price <s>$X</s> → <b>$Y</b> · deadline · CTA
  💸 PRICE DROP / BUNDLE / WEEKLY DEALS — a short list, one line per product with its price
  📢 NEWS / MAINTENANCE / RULES — calm, clear, no hype
- Layout: a strong first line (it is the preview in the chat list), then air — blank lines between blocks. Emoji as bullets, not confetti: 1 per line. <b>bold</b> for product and price only. A thin separator like ━━━━━━━━ between sections in longer posts. <blockquote> for a highlight or a customer quote. End with ONE clear call to action.
- Keep it short: most great posts are 5–9 lines. Photo posts: the text is a caption, under ~900 characters.
- Buttons (buttons field): "🛒 Buy now|product:ID", "💬 Support|https://t.me/…", "🤖 Open the shop|bot". Two short ones share a row.
- Premium emoji: product icons ([emoji:ID] from product titles) render in the group and in customer DMs; in the channel they fall back to the plain emoji automatically — use them.
- target: channel / group / both (default) / users (every customer's DM — only when the owner clearly asks, it reaches everyone) / all. schedule_at for "tomorrow at 10", on the shop clock.
- Customer-facing posts are in English unless the owner says otherwise. If the owner asks for "something wow" or does not like it, offer another style instead of small tweaks.`,
  stock: `ADDING STOCK — you prepare it, the owner confirms with one tap
- The owner pastes accounts in any format ("add these to Notion", a list, a screenshot, email/password pairs on two lines, with or without separators). Understand what ONE account is and how they are separated.
- find_product for the product (names are fuzzy: "ilove pdf" = "iLovePDF Premium"). Several matches → list them and ask which one. None → say so.
- propose_stock:
  - long pasted list → split_by (auto | lines | blank_lines | aymen | sep:<text>) so the server splits the owner's message itself; drop_lines_matching for headers or notes;
  - accounts from a screenshot, or a messy list you had to rebuild → pass them in accounts, joined with the word AYMEN between each account;
  - an account spanning several lines (email on one, password on the next) stays ONE account.
- The result tells you: first_account_full (exactly what one account will look like), odd_accounts (ones that do not match the rest), remembered_format (what the owner taught you before for this product).
- NOT SURE where one account starts and ends — a format you have not seen for this product, odd_accounts present, or several ways to read it? ASK first, briefly, showing how you would cut it: "الحساب الواحد من وين لوين؟ هكا؟ ⬇️ <first account>". Numbering like "1. " and notes the owner typed around the list are never part of an account.
- Once the owner confirms or corrects a format, save it with remember, category "format", naming the product: "Notion: one account per line — email:pass:mailreader link || 2FA … ; drop the 1. numbering". Next time remembered_format has it: use it and do not ask again.
- Then tell the owner in one line: how many, which product, and to check the preview card and tap ➕ Add. Nothing is added before that tap.`,
  system: `CANVA AUTO-INVITES
- Canva Team orders are invited automatically when it is set up and logged in. canva_status tells you. If it is off or logged out, say the order went to the manual fast lane and tell the owner to run /canva in the store bot to log in once.`,
  cgb: `CHATGPT BUSINESS
- The ChatGPT Business bot: seats, cycles and the price right now (cgb_cycle_now), the renewal round — paid / said yes unpaid / no answer / declined / to activate (cgb_renewals), seats by email (cgb_find_seat).
- The ChatGPT Business WORKSPACE (cgb_workspace_report): members, pending invites, whitelist and invite queue from the invite bot, already joined with every seat's order, start, end and days left. For "when does X end", "who expired but is still inside", "who paid but isn't in", "failed invites", "who isn't whitelisted", or a report: call it and answer from its facts — exact dates and counts, never guesses. If workspace_data.ok is false, say the workspace side couldn't be read and why, and answer only from the subscription side. If workspace_data.incomplete is true, say the last workspace read was incomplete.
- A good ChatGPT Business report is short and ordered: first the problems that need action (expired still inside, paid not inside, failed invites, not whitelisted), each with emails and dates; then what to watch (ending soon, invited not accepted); then the totals. End with the one or two actions you'd take first.`,
  private: `PERSONAL PRIVATE CHATS
- The owner's PERSONAL private chats (Telegram Business — people writing to his own account): business_inbox (who is waiting, for how long), business_thread (one chat), propose_business_reply (a card he taps to send AS HIM). These are private: never quote one person's messages to another, never send anything without his tap, write replies in the other person's language and in his voice, and don't promise money, prices, dates or refunds he hasn't stated. Telegram only allows a reply within 24h of their last message — if can_reply_now is false, say so. If it is connected but returns no chats, don't just say "nothing": say since when it has been connected (connected_since_utc, in the owner's local time), how many messages it has received (messages_received_total), and explain the note — only messages that arrive after the connection, only private chats with people; older unread ones and groups/channels/bots are not visible. If business_inbox says connected=false, explain how to connect: Telegram → Settings → Telegram Business → Chatbots → choose the dedicated private-chats bot (the one whose token is BUSINESS_BOT_TOKEN; the store bot also works if there is none), and turn on "Reply to messages".
- PRIVATE-CHAT PLAYBOOK (you are writing AS the owner — be at your most careful):
  1. Always read the chat with business_thread before drafting. Look at "person": if they are a shop customer, use it (what they bought, balance, a ChatGPT seat and its days left) and check live facts with your other tools before you state them — stock, price, an order's status. Never invent a price, date, discount or promise.
  2. Decide what the chat is: a SALE (they want to buy / ask a price) → answer with real stock and price, one clear next step; SUPPORT (a problem with an order or account) → check the order/seat first, then answer; PERSONAL (friends, family, non-business) → short and warm, or just tell the owner and don't draft; SUSPICIOUS (scam, "send me money first", crypto offers, links, requests for codes/passwords) → don't draft, warn the owner.
  3. Write in the other person's language and in the owner's voice — match the length, tone and emoji habits of "your_recent_replies" (style only; never reuse their content, never mention other chats).
  4. One card per chat. For "draft replies for everyone waiting", go through business_inbox, skip personal and suspicious ones (list them for the owner), and prepare a card for each of the rest.
  5. Tell the owner in one line what each draft does and anything he must decide (a price, a refund). If a reply is no longer allowed (can_reply_now false), say so instead of drafting.
  6. THE OWNER ALWAYS WANTS TO GROW THE SHOP BOT. In every SALE and SUPPORT chat (never personal, never suspicious), steer the person to the bot: invite them to order there with the real link from "shop" (shop.store_bot.link; for ChatGPT Business use shop.chatgpt_bot.link; for a problem with an order, shop.support.link), plus ONE short reason that fits (instant delivery, pay from the wallet, available 24/7, order history and warranty in one place). Once per reply, natural, never pushy, in the same language. If they already ordered, point them to the bot for the next one or for renewals. If "shop" has no link for what you need, don't invent one — say "the bot" and tell the owner the link is missing.`,
};

function localNowString() {
  let off = 0;
  try { off = parseFloat(require('../database/queries').getSetting('cgb_timezone_offset', '1')) || 0; } catch (_) {}
  const d = new Date(Date.now() + off * 3600000);
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} (UTC${off >= 0 ? '+' : ''}${off})`;
}

// ── Token diet: only the tools (and topic guides) a question needs ─────────
//
// Sending all 56 tool descriptions (~6,900 tokens) plus every topic's rules
// (~6,000) with EVERY call is what made Yamen expensive. Tools are grouped;
// a message gets the small core plus the groups its words point to, plus the
// groups used in the last few minutes (so follow-ups like "إيه ابعثو" still
// work). Yamen can load any other group himself with use_tools.
const TOOL_GROUPS = {
  sales:    ['best_hours', 'api_sales', 'top_customers', 'products_list'],
  stock:    ['stock_audit', 'stock_batches', 'stock_reconcile', 'suppliers', 'find_account_supplier', 'propose_stock', 'propose_stock_count', 'list_categories', 'view_customer_media'],
  products: ['products_list', 'list_categories', 'propose_product', 'propose_product_update'],
  posts:    ['propose_post', 'scheduled_posts', 'products_list'],
  support:  ['support_unread', 'support_thread', 'support_digest', 'support_examples', 'support_search', 'propose_reply', 'send_reply_now', 'view_customer_media'],
  money:    ['txid_check', 'auto_credit_verified_deposit', 'recent_deposits', 'trace_payment', 'refund_requests', 'propose_credit', 'propose_debit'],
  cgb:      ['cgb_seats_of', 'cgb_overview', 'cgb_new_seats_since', 'cgb_cycle_now', 'cgb_renewals', 'cgb_workspace_report', 'cgb_find_seat'],
  private:  ['business_inbox', 'business_thread', 'propose_business_reply'],
  web:      ['web_search', 'web_read'],
  system:   ['canva_status', 'emoji_status'],
};
const GROUPED = new Set(Object.values(TOOL_GROUPS).flat());   // anything not listed stays core
const GROUP_HINTS = {
  sales:    /(مبيعات|بيع|ربح|profit|sales|revenue|هالجمعة|الجمعة|الشهر|week|month|ساعات|best|أحسن|api|reseller|top|أكثر)/i,
  stock:    /(مخزون|ستوك|stock|حسابات|accounts|مورّد|مورد|supplier|batch|دفعة|قرب يوفى|نفذ|نفد)/i,
  products: /(منتج|product|السوم|سوم|السعر|price|خبّي|خبي|category|قسم|categor)/i,
  posts:    /(منشور|post|بوست|صمّم|صمم|تصميم|design|قناة|channel|نشر|banner|إعلان|اعلان)/i,
  support:  /(يستنى|يستناو|حرفاء|حريف|رد |ردود|reply|support|دعم|رسائل الدعم|شكوى|تذكرة|ticket|سأل)/i,
  money:    /(رصيد|balance|فلوس|txid|تيكس|binance|بينانس|إيداع|ايداع|deposit|شحن|refund|استرجاع|رجّع|رجع|credit|debit|خلاص|payment|usdt|trc20|bep20)/i,
  cgb:      /(chatgpt|شات ?جي|gpt|business|تفعيل|seat|مقعد|اشتراك|subscription|تجديد|renew|ووركسبيس|workspace|panel|whitelist|يوفى|ينتهي)/i,
  private:  /(الخاص|خاصة|private|كتبلي|كتبولي|telegram business|المحادثات الخاصة)/i,
  web:      /(ابحث|search|انترنت|internet|google|غوغل|موقع|website|https?:\/\/|www\.)/i,
  system:   /(canva|كانفا|emoji|ايموجي|إيموجي)/i,
};
const BRIEF_WORDS = /(حوصلة|حوصل|لخص|ملخص|تقرير|تقارير|report|brief|summary|شنوة الحالة|الحالة اليوم|كيفاش المحل)/i;

function pickGroups(text, { images = 0, proactive = null } = {}) {
  const g = new Set();
  if (proactive === 'learn') return g;             // nightly study: memory tools (core) only
  for (const [name, re] of Object.entries(GROUP_HINTS)) if (re.test(text || '')) g.add(name);
  if (BRIEF_WORDS.test(text || '') || proactive === 'brief' || proactive === 'morning' || proactive === 'evening') ['sales', 'support', 'cgb', 'money', 'stock'].forEach((x) => g.add(x));
  if (images) ['stock', 'money', 'support', 'products'].forEach((x) => g.add(x));
  try {
    const last = JSON.parse(mem.getState('yamen_last_groups', 'null') || 'null');
    if (last && Date.now() - last.at < 15 * 60000) (last.groups || []).forEach((x) => g.add(x));
  } catch (_) {}
  return g;
}

const USE_TOOLS = {
  name: 'use_tools',
  description: 'Load one more group of tools (and its rules) for this question: ' + Object.keys(TOOL_GROUPS).join(', ') + '. Call it before you need a tool that is not in your list.',
  input_schema: { type: 'object', properties: { group: { type: 'string', enum: Object.keys(TOOL_GROUPS) } }, required: ['group'] },
};

function toolsFor(ctx) {
  const want = new Set();
  for (const g of ctx.groups || []) for (const n of TOOL_GROUPS[g] || []) want.add(n);
  const list = toolSchemas().filter((t) => !GROUPED.has(t.name) || want.has(t.name));
  return [...list, USE_TOOLS];
}

function guidesFor(groups) {
  const seen = new Set(); const out = [];
  for (const g of groups || []) {
    const t = GUIDES[g];
    if (t && !seen.has(t)) { seen.add(t); out.push(t); }
  }
  return out.length ? `\n\nRULES FOR THE TOOLS LOADED NOW\n\n${out.join('\n\n')}` : '';
}

function buildInstructions(tier, groups) {
  const snap = (() => { try { return liveSnapshot(); } catch (e) { return { error: e.message }; } })();
  const m = mem.memoryForPrompt(tier === 'deep' ? 3500 : 2000);
  let alerts = [];
  try { alerts = require('./agentWatch').recentAlerts(2); } catch (_) {}
  return `${PERSONA}${guidesFor(groups)}

NOW: ${localNowString()}

FOCUS (the customer you were just working on — short follow-ups like "ومساج", "زيدو", "ابعثلو", "هل استعمل" are about THIS one unless the owner names someone else)
${focusLine()}

RECENT ALERTS YOU SENT
${alerts.length ? alerts.map((a) => `[${a.created_at}] ${String(a.content).slice(0, 400)}`).join('\n') : '(none)'}

LIVE SNAPSHOT (computed this second from the database)
${JSON.stringify(snap)}

MEMORY (${m.total} note${m.total === 1 ? '' : 's'}${m.lines.length < m.total ? `, newest ${m.lines.length} shown — recall_memory for the rest` : ''})
${m.lines.length ? m.lines.join('\n') : '(empty — start filling it)'}`;
}

/**
 * The last turns — for a fresh chain or a stateless provider. Each of
 * Yamen's replies carries its work log ("what I did": the tools, for whom,
 * with what result), and events in between (an auto credit, an auto reply)
 * are included, so a follow-up like "ومساج" after a reset still knows which
 * customer and which operation it is about.
 */
function recap(excludeLastUser = true) {
  const turns = mem.turnsForRecap(10);
  if (excludeLastUser && turns.length && turns[turns.length - 1].role === 'user') turns.pop();
  return turns.map((t) => {
    if (t.role === 'event') return { role: 'assistant', content: `[event] ${String(t.content || '').slice(0, 300)}` };
    let content = String(t.content || '').slice(0, 1500);
    const work = (t.meta && Array.isArray(t.meta.work)) ? t.meta.work : [];
    if (t.role === 'assistant' && work.length) content += `\n[what I did: ${work.slice(0, 8).join(' | ')}]`;
    return { role: t.role, content: content || '(no text)' };
  });
}

// ── Work log & focus ─────────────────────────────────────────────────────────

const WHO_KEYS = ['user', 'user_id', 'userId', 'telegram_id', 'customer', 'username', 'chat_id', 'chatId', 'email'];

function compactArgs(args) {
  return Object.entries(args || {}).filter(([k, v]) => !k.startsWith('__') && v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${String(typeof v === 'object' ? JSON.stringify(v) : v).slice(0, 48)}`).join(', ');
}

/** One short line per tool call: kept with the reply and replayed in the recap. */
function workLine(call, output) {
  let res = String(output || '');
  try {
    const o = JSON.parse(res);
    if (o && typeof o === 'object') {
      if (o.error) res = `ERROR ${o.error}`;
      else if (o.summary) res = `${o.title || ''} ${o.summary}`;
      else res = JSON.stringify(o);
    }
  } catch (_) {}
  return `${call.name}(${compactArgs(call.args)}) → ${res.replace(/\s+/g, ' ').slice(0, 200)}`;
}

/** The customer Yamen is working on right now, remembered for 45 minutes. */
function noteFocus(call, output) {
  let who = null;
  for (const k of WHO_KEYS) if (call.args && call.args[k]) { who = String(call.args[k]); break; }
  if (!who) {
    try {
      const o = JSON.parse(output || 'null');
      if (o && typeof o === 'object') who = o.user || o.username || o.telegram_id || o.customer || null;
      if (who && typeof who === 'object') who = who.username || who.telegram_id || null;
    } catch (_) {}
  }
  if (!who) return;
  mem.setState('yamen_focus', JSON.stringify({ who: String(who).slice(0, 60), via: call.name, at: Date.now(),
    last: workLine(call, output).slice(0, 220) }));
}

function focusLine() {
  try {
    const f = JSON.parse(mem.getState('yamen_focus', 'null') || 'null');
    if (!f || Date.now() - f.at > 45 * 60000) return '(none)';
    const mins = Math.round((Date.now() - f.at) / 60000);
    return `${f.who} — ${mins} min ago, last: ${f.last}`;
  } catch (_) { return '(none)'; }
}

/** Yamen used tools but wrote nothing (the "…" reply on 30-09): say what was
 *  done, in plain Derja — one line per consequential operation. */
function replyFromWork(items) {
  const lines = [];
  for (const it of items.slice(0, 8)) {
    const o = it.out || {}; const a = it.args || {};
    const who = a.user || a.user_id || a.chat || o.to || o.user || '';
    if (o.credited) lines.push(`✅ زدت $${Number(o.amount || 0).toFixed(2)} لرصيد ${who} (الـTxID متحقق منو في Binance)${o.customer_notified ? '، والحريف وصلو إشعار' : ''}.`);
    else if (o.sent === true) lines.push(`✅ جاوبت ${who} وحدي.`);
    else if (o.draft_id) lines.push(`✉️ حضّرت رد لـ ${o.to || who} — يستنى موافقتك.`);
    else if (o.action_id) lines.push(`📝 حضّرت: ${o.title || ''} ${String(o.summary || '').split('\n')[0]} — يستنى تأكيدك.`);
    else if (o.error) lines.push(`⚠️ ${TOOL_LABEL[it.name] || it.name}: ${String(o.error).slice(0, 160)}`);
  }
  if (!lines.length) {
    const names = [...new Set(items.map((it) => TOOL_LABEL[it.name] || it.name))].slice(0, 4);
    return `شفت: ${names.join('، ')}. قلّي شنوة تحب نعمل بالضبط.`;
  }
  return lines.join('\n');
}

// A correction from the owner. "شبيك"/"بهيم" were not in any list, so a
// frustrated owner used to get the same mistake again.
const CORRECTION_RE = /(شبيك|بهيم|ماكش فاهم|ما فهمتش|مافهمتش|موش هذا|موش هكا|مش هكا|غالط|غلطت|قتلك|قلتلك|لا لا|ماهوش هكا|علاش عملت|شنوة عملت|not what i|wrong|no no)/i;
const CORRECTION_NOTE = '\n\n[note to Yamen, not from the owner: the owner is CORRECTING you. Re-read FOCUS and "what I did" in ' +
  'the recent turns, say in ONE line what you got wrong, fix it now in this same turn, then save a rule with ' +
  'remember (category "rule") written so it never happens again.]';

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
        const bad = ['reasoning_effort', 'max_completion_tokens', 'max_output_tokens', 'max_tokens', 'reasoning', 'prompt_cache_key']
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
        else if (ev.type === 'response.web_search_call.searching' || (ev.type === 'response.output_item.added' && ev.item && ev.item.type === 'web_search_call')) emit({ type: 'status', text: '🌐 يبحث في الويب' });
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
  search_past_chats: '🧠 يلوّج في كلامنا', txid_check: '🔗 يثبّت الـ TxID في Binance',
  recent_deposits: '🏦 يشوف الإيداعات في Binance', cgb_cycle_now: '🗓 الدورة توا',
  cgb_renewals: '🔄 التجديدات', cgb_find_seat: '📧 يلوّج على الإيميل', order_lookup: '🧾 الطلب',
  emoji_status: '🎨 يثبّت الأيقونات', canva_status: '🎨 حالة Canva', find_product: '🔎 يلوّج على المنتج',
  propose_stock_count: '📦 يحضّر التعبئة', propose_post: '🎨 يصمّم المنشور',
  propose_product: '🆕 يحضّر المنتج', propose_product_update: '✏️ يحضّر التعديل', list_categories: '📁 الأقسام',
  scheduled_posts: '⏰ المنشورات المبرمجة', propose_stock: '📦 يحضّر المخزون', view_customer_media: '🖼 يشوف الصور',
  cgb_workspace_report: '🧾 تقرير الووركسبيس', business_inbox: '📥 الرسائل الخاصة', business_thread: '💬 محادثة خاصة', propose_business_reply: '✉️ يحضّر رد خاص', propose_debit: '➖ يحضّر نقص رصيد', cgb_new_seats_since: '🤖 مقاعد جديدة', auto_credit_verified_deposit: '⚡️ إيداع متحقق منو',
};

/**
 * Run the model's tool calls, in parallel.
 *
 * Returns the text results plus any images a tool wants the model to SEE
 * (customer screenshots) — those cannot travel inside a tool result on every
 * provider, so each caller hands them over in the provider's own way.
 */
async function runTools(calls, ctx) {
  const images = [];
  const results = await Promise.all(calls.map(async (c) => {
    if (c.name === 'use_tools') {
      const g = String((c.args || {}).group || '');
      if (!TOOL_GROUPS[g]) return { id: c.id, output: JSON.stringify({ error: `unknown group "${g}"`, groups: Object.keys(TOOL_GROUPS) }) };
      ctx.groups.add(g);
      return { id: c.id, output: JSON.stringify({ loaded: g, tools: TOOL_GROUPS[g] }) };
    }
    ctx.emit({ type: 'status', text: TOOL_LABEL[c.name] || `⚙️ ${c.name}` });
    ctx.used.push(c.name);
    const args = { ...(c.args || {}) };
    // The owner's own pasted text, so a long list of accounts is split on the
    // server instead of being re-typed by the model.
    if (c.name === 'propose_stock') args.__owner_text = ctx.text;
    // Photos the owner attached, for a product picture or a post.
    if (/^propose_(post|product|product_update)$/.test(c.name)) args.__owner_images = ctx.images;
    const out = await runTool(c.name, args);
    if (out && Array.isArray(out.__images)) { images.push(...out.__images); delete out.__images; }
    if (c.name === 'propose_reply' && out && out.draft_id) {
      ctx.drafts.push(out);
      ctx.emit({ type: 'draft', draft: out });
    }
    // Yamen chose to answer a safe question itself (auto-reply is on).
    if (out && out.__auto_send) {
      const { user_id, text } = out.__auto_send;
      const bot = require('./agentChat')._storeBot || (globalThis.__STORE_BOT__);
      const sb = bot || null;
      let done = { ok: false };
      try {
        const b = require('../support-bot');
        await b.sendMessage(user_id, text);
        require('./agentMemory').logChat('event', `🤝 يمان جاوب الحريف وحدو: "${String(text).slice(0, 80)}"`);
        done = { ok: true };
      } catch (e) { done = { ok: false, error: e.message }; }
      ctx.emit({ type: 'auto_reply', to: user_id, text, ok: done.ok });
      // Replace the tool result the model sees with a plain outcome.
      return { id: c.id, output: JSON.stringify(done.ok ? { sent: true } : { sent: false, error: done.error }) };
    }
    // Yamen verified a small deposit itself and credited it (auto_credit is
    // on). The customer message is a FIXED template, never model text — see
    // the tool's own comment for why. The owner always gets an FYI, since
    // this is the one case where money moved with no tap.
    if (out && out.__auto_credit_notify) {
      const { userId, amount, before, after, txid, network } = out.__auto_credit_notify;
      const bot = require('./agentChat')._storeBot || (globalThis.__STORE_BOT__);
      let sentToCustomer = false;
      try {
        if (bot) {
          await bot.sendMessage(userId,
            `💰 <b>$${amount.toFixed(2)}</b> was added to your balance.\n` +
            `📝 Verified deposit (TxID <code>${String(txid).slice(0, 24)}</code>)`,
            { parse_mode: 'HTML' });
          sentToCustomer = true;
        }
      } catch (_) {}
      try {
        const raw = require('../database/db');
        const u = raw.prepare('SELECT username, first_name FROM users WHERE telegram_id = ?').get(userId);
        const who = u?.username ? '@' + u.username : (u?.first_name || String(userId));
        await require('./adminNotify').notifyAdmin(bot, {
          type: 'agent_auto_credit',
          title: '⚡️ يمان زاد رصيد أوتوماتيك (بلا تأكيد)',
          body: `👤 ${who}\n➕ $${amount.toFixed(2)} → balance ${before.toFixed(2)} → ${after.toFixed(2)}\n` +
                `🔗 TxID: <code>${String(txid).slice(0, 40)}</code> · ${network}\n` +
                `<i>تحقق منو Binance مباشرة، ما فاتش الحد المسموح.</i>`,
          dedupeKey: `agent_auto_credit:${txid}`,
        });
      } catch (_) {}
      require('./agentMemory').logChat('event', `⚡️ يمان زاد $${amount.toFixed(2)} أوتوماتيك (TxID ${txid}) بلا تأكيد`);
      ctx.emit({ type: 'auto_credit', user_id: userId, amount, txid, ok: true });
      return { id: c.id, output: JSON.stringify({ credited: true, amount, customer_notified: sentToCustomer }) };
    }
    if (out && out.action_id) ctx.emit({ type: 'action', action: out });
    if (c.name === 'propose_stock' && out && out.stock_draft_id) {
      ctx.drafts.push({ ...out, kind: 'stock' });
      ctx.emit({ type: 'stock_draft', draft: out });
    }
    // Tool results are the biggest input cost; 12k characters is ~3k tokens.
    return { id: c.id, output: JSON.stringify(out === undefined ? null : out).slice(0, 12000) };
  }));
  calls.forEach((c, i) => {
    if (c.name === 'use_tools' || !results[i]) return;
    ctx.work.push(workLine(c, results[i].output));
    let parsed = null; try { parsed = JSON.parse(results[i].output); } catch (_) {}
    ctx.workItems.push({ name: c.name, args: c.args || {}, out: parsed && typeof parsed === 'object' ? parsed : null });
    try { noteFocus(c, results[i].output); } catch (_) {}
  });
  return { results, images };
}

const parseArgs = (s) => { try { return JSON.parse(s || '{}'); } catch (_) { return {}; } };

/** The owner's message with any attached photos, per provider. */
function ownerContent(ctx, provider) {
  const base = ctx.modelText || ctx.text;
  if (!ctx.images.length) return base;
  const text = base || '(see the image)';
  if (provider === 'responses') {
    return [{ type: 'input_text', text }, ...ctx.images.map((u) => ({ type: 'input_image', image_url: u }))];
  }
  if (provider === 'chat') {
    return [{ type: 'text', text }, ...ctx.images.map((u) => ({ type: 'image_url', image_url: { url: u } }))];
  }
  return [...ctx.images.map(anthropicImage), { type: 'text', text }];
}

function anthropicImage(dataUrl) {
  const m = String(dataUrl).match(/^data:([^;]+);base64,(.+)$/);
  return m ? { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } } : { type: 'text', text: '[image]' };
}

/** OpenAI Responses API — tools + reasoning together, streamed, chained. */
const WEB_SEARCH_ON = process.env.WEB_SEARCH !== '0';

async function turnOpenAIResponses(ctx) {
  const { tier, emit, signal } = ctx;
  // On the Responses API, OpenAI's native web search replaces our fallback
  // web_search/web_read functions, so drop those to avoid a name clash.
  const buildTools = () => {
    const t = toolsFor(ctx)
      .filter((x) => !(WEB_SEARCH_ON && (x.name === 'web_search' || x.name === 'web_read')))
      .map((x) => ({ type: 'function', name: x.name, description: x.description, parameters: x.input_schema }));
    if (WEB_SEARCH_ON && ctx.groups.has('web')) t.push({ type: 'web_search' });
    return t;
  };
  const first = { role: 'user', content: ownerContent(ctx, 'responses') };
  let previous = mem.getState('openai_prev') || null;
  let input = previous ? [first] : [...recap(), first];
  let reply = '';
  let lastInput = 0;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (overBudget()) throw new BudgetError('budget');
    let response;
    try {
      response = await callWithFallback(tier, (model0) => {
        const model = ctx.forcedModel || model0;
        const body = { model, instructions: buildInstructions(tier, ctx.groups), input, tools: buildTools() };
        // Same key on every call → OpenAI keeps the unchanging start (core
        // tools + core rules) in its prompt cache, billed at a fraction.
        if (!isRefused(model, 'prompt_cache_key')) body.prompt_cache_key = 'yamen-owner';
        if (previous) body.previous_response_id = previous;
        if (!isRefused(model, 'max_output_tokens')) body.max_output_tokens = tier === 'deep' ? 6000 : 4000;
        if (!isRefused(model, 'reasoning')) body.reasoning = { effort: ctx.effort };
        return streamResponse(body, (ev) => { if (ev.type === 'delta') reply += ev.text; emit(ev); }, signal);
      });
    } catch (e) {
      // The chain OpenAI keeps expires (30 days) or is lost; start a new one
      // from our own copy of the conversation rather than failing.
      if (previous && /previous.response|not found/i.test(e.agentMessage || '') && round === 0) {
        logger.warn('[agent] conversation chain expired — rebuilding from local history');
        previous = null;
        mem.setState('openai_prev', null);
        input = [...recap(), first];
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
      // call. Once it grows past ~25k tokens (or carries photos), close it:
      // the next message starts fresh from a short recap.
      // 12k, not 25k: past that, every new message re-bills a long history.
      // 24k (was 12k in V129): at 12k the chain reset after almost every TxID
      // check, and Yamen lost the thread. The recap now carries the work log
      // too, so a reset no longer forgets what was just done.
      mem.setState('openai_prev', lastInput > 24000 ? null : previous);
      if (!reply) {
        reply = (response.output || []).filter((o) => o.type === 'message')
          .flatMap((o) => o.content || []).filter((c) => c.type === 'output_text')
          .map((c) => c.text).join('\n');
        if (reply) emit({ type: 'delta', text: reply });
      }
      return reply;
    }
    if (reply && !reply.endsWith('\n')) { reply += '\n\n'; emit({ type: 'delta', text: '\n\n' }); }
    const { results, images } = await runTools(calls, ctx);
    input = results.map((r) => ({ type: 'function_call_output', call_id: r.id, output: r.output }));
    if (images.length) {
      input.push({ role: 'user', content: images.flatMap((im) => [
        { type: 'input_text', text: `Image — ${im.label}` }, { type: 'input_image', image_url: im.url }]) });
    }
  }
  return reply || 'That took too many steps. Try asking something narrower.';
}

/** OpenAI chat/completions — only for the gpt-4 family, which cannot reason. */
async function turnOpenAIChat(ctx) {
  const { tier, emit, signal } = ctx;
  const buildTools = () => toolsFor(ctx).map((t) => ({
    type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
  const messages = [{ role: 'system', content: buildInstructions(tier, ctx.groups) }, ...recap(),
    { role: 'user', content: ownerContent(ctx, 'chat') }];
  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (overBudget()) throw new BudgetError('budget');
    const res = await callWithFallback(tier, (model0) => axios.post('https://api.openai.com/v1/chat/completions', {
      model: ctx.forcedModel || model0, messages, tools: buildTools(), tool_choice: 'auto', max_tokens: 3000,
    }, { headers: { Authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' }, timeout: 240000, signal }));
    const u = res.data.usage || {};
    addUsage(res.data.model || modelFor(tier), u.prompt_tokens, u.prompt_tokens_details?.cached_tokens, u.completion_tokens);
    const msg = res.data.choices[0].message;
    messages.push(msg);
    const calls = (msg.tool_calls || []).map((c) => ({ id: c.id, name: c.function.name, args: parseArgs(c.function.arguments) }));
    if (!calls.length) { emit({ type: 'delta', text: msg.content || '' }); return msg.content || ''; }
    const { results, images } = await runTools(calls, ctx);
    for (const r of results) messages.push({ role: 'tool', tool_call_id: r.id, content: r.output });
    if (images.length) messages.push({ role: 'user', content: images.flatMap((im) => [
      { type: 'text', text: `Image — ${im.label}` }, { type: 'image_url', image_url: { url: im.url } }]) });
  }
  return 'That took too many steps. Try asking something narrower.';
}

/** Anthropic — stateless, so the recent conversation is sent each time. */
async function turnAnthropic(ctx) {
  const { tier, emit, signal } = ctx;
  const buildTools = () => toolsFor(ctx);
  const messages = [...recap(), { role: 'user', content: ownerContent(ctx, 'anthropic') }];
  // Anthropic wants strictly alternating turns starting with the user; a brief
  // Sahbi wrote on its own leaves two assistant turns in a row, so merge them.
  while (messages.length && messages[0].role !== 'user') messages.shift();
  for (let k = messages.length - 1; k > 0; k--) {
    if (messages[k].role === messages[k - 1].role && typeof messages[k].content === 'string'
        && typeof messages[k - 1].content === 'string') {
      messages[k - 1].content += '\n\n' + messages[k].content;
      messages.splice(k, 1);
    }
  }

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (overBudget()) throw new BudgetError('budget');
    const res = await callWithFallback(tier, (model0) => axios.post('https://api.anthropic.com/v1/messages', {
      model: ctx.forcedModel || model0, max_tokens: tier === 'deep' ? 4000 : 3000, system: buildInstructions(tier, ctx.groups), tools: buildTools(), messages,
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
    const { results, images } = await runTools(calls, ctx);
    messages.push({ role: 'user', content: results.map((r, i) => ({
      type: 'tool_result', tool_use_id: r.id,
      content: i === 0 && images.length
        ? [{ type: 'text', text: r.output }, ...images.map((im) => anthropicImage(im.url))]
        : r.output,
    })) });
  }
  return 'That took too many steps. Try asking something narrower.';
}

// Actions and pictures need a moment more thought than a look-up, even on
// the fast tier — still far cheaper than the deep one.
// More thinking (still the cheap model) for questions whose answer depends on
// getting data right: stock, money, subscriptions, emails, dates, "why".
// More thinking only where a slip costs money or stock. ("@", "email", "why"… used to trigger it on
// half the messages; removed.)
const CAREFUL = /(مخزون|ستوك|stock|زيد|زيدل|اضف|أضف|ضيف|حسابات|accounts|txid|تيكس|ثبّت|ثبت|صورة|image|photo)/i;

/** One owner message, end to end. */
async function runTurn({ text, mode, emit, signal, proactive = null, images = [] }) {
  let tier = pickTier(text, mode);
  const pics = (images || []).filter((u) => /^data:image\/(png|jpe?g|webp|gif);base64,/.test(String(u))).slice(0, 4);
  // A photo needs a model that can see and a moment to think.
  const forcedModel = pics.length ? visionModel() : null;
  if (pics.length) tier = 'deep';
  const effort = tier === 'deep' ? EFFORT.deep : (CAREFUL.test(text) ? 'medium' : EFFORT.fast);
  const groups = pickGroups(text, { images: pics.length, proactive });
  const correcting = !proactive && CORRECTION_RE.test(text || '');
  const ctx = { text, modelText: correcting ? `${text}${CORRECTION_NOTE}` : text, images: pics, tier, effort,
    forcedModel, emit, signal, drafts: [], used: [], groups, work: [], workItems: [], proactive };
  emit({ type: 'start', tier, model: forcedModel || modelFor(tier) });
  // A brief Sahbi writes on its own has no visible question; the prompt is
  // stored as 'auto' so it is neither shown nor replayed as the owner's words.
  mem.logChat(proactive ? 'auto' : 'user', text, { tier, proactive, images: pics.length || undefined, correcting: correcting || undefined });

  const activeModel = forcedModel || modelFor(tier);
  const fn = PROVIDER === 'anthropic' ? turnAnthropic
    : (isReasoningOpenAI(activeModel) ? turnOpenAIResponses : turnOpenAIChat);
  let reply = await fn(ctx);
  if (String(reply || '').replace(/[\s.…]/g, '').length < 2 && ctx.work.length) {
    reply = replyFromWork(ctx.workItems);
    emit({ type: 'delta', text: reply });
  }
  // Photos make the chained context heavy; start the next message fresh.
  if (pics.length) mem.setState('openai_prev', null);
  const meta = { tier, model: forcedModel || modelFor(tier), tools: [...new Set(ctx.used)],
    drafts: ctx.drafts.map((d) => ({ ...d })), proactive, work: ctx.work.slice(0, 12), correcting: correcting || undefined };
  mem.logChat('assistant', reply, meta);
  if (!proactive) mem.setState('yamen_last_groups', JSON.stringify({ groups: [...ctx.groups], at: Date.now() }));
  emit({ type: 'done', ...meta });
  return { reply, drafts: ctx.drafts, ...meta };
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

router.use(express.json({ limit: '20mb' })); // photos travel as data URLs

/** Streaming chat: server-sent events, one JSON object per event. */
router.post('/chat/stream', requireToken, async (req, res) => {
  const text = String(req.body.message || '').trim();
  const mode = String(req.body.mode || 'auto');
  const images = Array.isArray(req.body.images) ? req.body.images : [];
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
    if (!text && !images.length) throw new Error('Empty message');
    await runTurn({ text, mode, emit, signal: ctrl.signal, images });
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

/** The owner's tap on "Add to stock" — the only way stock is ever written from here. */
router.post('/stock/approve', requireToken, async (req, res) => {
  const d = require('./agentTools').takeStockDraft(String(req.body.draft_id || ''));
  if (!d) return res.status(400).json({ error: 'Draft expired or already used — اطلب من يمان من جديد.' });
  try {
    const bot = req.app && (req.app.get('storeBot') || req.app.get('bot'));
    const r = await require('./stockUpload').applyStockUpload(bot, d.productId, d.accounts,
      { supplier: d.supplier, unitCost: d.unitCost });
    if (!r.ok) return res.status(400).json({ error: r.error });
    mem.logChat('event', `✅ تزادو ${r.added} لـ ${String(r.product).replace(/\[emoji:\d+\]/g, '').trim()} — المخزون توا ${r.now}`);
    res.json(r);
  } catch (e) {
    logger.error(`[agent] stock approve: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

/** The owner's tap on any other prepared action (manual stock, a post). */
router.post('/action/approve', requireToken, async (req, res) => {
  const tools = require('./agentTools');
  const a = tools.takeAction(String(req.body.action_id || ''));
  if (!a) return res.status(400).json({ error: 'انتهت صلاحيتو ولا تعمل قبل — اطلب من يمان من جديد.' });
  try {
    const bot = req.app && (req.app.get('storeBot') || req.app.get('bot'));
    const r = await tools.performAction(a, bot);
    if (r.ok) mem.logChat('event', r.message);
    res.status(r.ok ? 200 : 400).json(r);
  } catch (e) {
    logger.error(`[agent] action: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
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
  return { daily_budget_usd: String(budget()), allow_deep: mem.getState('allow_deep', '1'),
    auto_reply: mem.getState('auto_reply', '0'), auto_credit: mem.getState('auto_credit', '0'),
    usage_today: usageToday() };
}
// ── Voice ────────────────────────────────────────────────────────────────────
//
// The browser's own speech recognition barely knows Tunisian Derja, so the app
// records the voice note and the server transcribes it with OpenAI's cheap
// transcription model (about $0.003 a minute), hinted with the shop's words.
// Spoken replies use the phone's own voice when it has one for the language
// (free) and fall back to OpenAI's TTS here.

// Most accurate first: the mini model mis-heard Derja too often (owner's
// report). The difference is ~$0.003/min; falls back if unavailable.
const TRANSCRIBE_MODELS = ['gpt-4o-transcribe', 'gpt-4o-mini-transcribe', 'whisper-1'];
const TTS_MODELS = ['gpt-4o-mini-tts', 'tts-1'];
// Transcription models follow the STYLE of the prompt text, so the hint is a
// sample of how the owner actually talks (Derja written in Arabic script with
// French/English shop words kept as-is), plus the shop's real vocabulary:
// product names from the database and words Yamen learned (memory, 'vocab').
const VOICE_SAMPLE = 'شنوة الحالة اليوم؟ قداش من طلب ChatGPT Business يستنى التفعيل؟ ' +
  'زيد stock متاع Canva، وثبّتلي الـ TxID في Binance. حضّرلي رد للحريف بالدارجة.';
function voiceHint() {
  const words = new Set(['ChatGPT', 'Business', 'Canva', 'Netflix', 'Gemini', 'TxID', 'Binance', 'USDT',
    'TRC20', 'BEP20', 'TON', 'Railway', 'Whitelist', 'Panel', 'stock', 'refund', 'email', 'order']);
  try {
    const raw = require('../database/db');
    for (const r of raw.prepare(`SELECT title FROM products WHERE COALESCE(is_active,1) = 1 ORDER BY id DESC LIMIT 25`).all()) {
      const t = String(r.title || '').replace(/\[emoji:\d+\]/g, '').replace(/[^\p{L}\p{N} +.-]/gu, ' ').trim().split(/\s+/).slice(0, 3).join(' ');
      if (t) words.add(t);
    }
  } catch (_) {}
  try {
    for (const m of mem.listMemory(300).filter((x) => x.category === 'vocab').slice(0, 30)) words.add(String(m.text).slice(0, 40));
  } catch (_) {}
  return `${VOICE_SAMPLE} ${[...words].join(', ')}`.slice(0, 900);
}

router.post('/transcribe', requireToken, express.raw({ type: () => true, limit: '15mb' }), async (req, res) => {
  if (!OPENAI_KEY) return res.status(503).json({ error: 'voice needs OPENAI_API_KEY', fallback: true });
  if (overBudget()) return res.status(429).json({ error: explainError(new BudgetError('budget')) });
  const buf = req.body;
  if (!buf || !buf.length) return res.status(400).json({ error: 'no audio' });
  const type = String(req.get('content-type') || 'audio/webm').split(';')[0];
  const ext = type.includes('mp4') || type.includes('m4a') ? 'm4a' : type.includes('ogg') ? 'ogg' : type.includes('wav') ? 'wav' : 'webm';
  const seconds = Math.max(1, Number(req.query.sec) || buf.length / 16000);
  for (const model of TRANSCRIBE_MODELS) {
    try {
      const form = new FormData();
      form.append('file', new Blob([buf], { type }), `voice.${ext}`);
      form.append('model', model);
      form.append('prompt', voiceHint());
      const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST', headers: { Authorization: `Bearer ${OPENAI_KEY}` }, body: form,
      });
      const j = await r.json().catch(() => ({}));
      if (r.status === 404 || /model/i.test(j?.error?.message || '') && r.status === 400) continue;
      if (!r.ok) return res.status(r.status).json({ error: j?.error?.message || `HTTP ${r.status}` });
      addAudioCost(seconds * 0.003 / 60);
      return res.json({ text: String(j.text || '').trim(), model });
    } catch (e) {
      logger.warn(`[agent] transcribe ${model}: ${e.message}`);
    }
  }
  res.status(502).json({ error: 'transcription failed', fallback: true });
});

router.post('/tts', requireToken, async (req, res) => {
  if (!OPENAI_KEY) return res.status(503).json({ error: 'no OpenAI key' });
  if (overBudget()) return res.status(429).json({ error: 'budget' });
  const text = String(req.body.text || '').replace(/[*`#>_]/g, '').slice(0, 1500);
  if (!text) return res.status(400).json({ error: 'empty' });
  for (const model of TTS_MODELS) {
    try {
      // Calm and clear: speed 1.1 + "quick, lively" (and the app speeding it up
      // again on playback) made Yamen talk ~20% too fast — owner's report.
      const body = { model, voice: 'alloy', input: text, format: 'mp3', speed: 0.95,
        instructions: 'Calm, clear, unhurried pace, with a short pause between sentences — like explaining ' +
          'something to a friend. Pronounce numbers, emails and product names carefully. ' +
          'If the text is Tunisian Arabic, speak it the Tunisian way.' };
      let r = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST', headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify(body) });
      if (r.status === 400) { // a model that refuses speed/instructions: plain request
        delete body.speed; delete body.instructions;
        r = await fetch('https://api.openai.com/v1/audio/speech', {
          method: 'POST', headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'content-type': 'application/json' },
          body: JSON.stringify(body) });
      }
      if (r.status === 404) continue;
      if (!r.ok) return res.status(r.status).json({ error: `HTTP ${r.status}` });
      const audio = Buffer.from(await r.arrayBuffer());
      addAudioCost(text.length * 0.012 / 1000); // ~ $0.012 per 1k characters
      res.set('Content-Type', 'audio/mpeg');
      return res.send(audio);
    } catch (e) {
      logger.warn(`[agent] tts ${model}: ${e.message}`);
    }
  }
  res.status(502).json({ error: 'tts failed' });
});

function addAudioCost(usd) {
  const u = usageToday();
  u.cost = Number(((u.cost || 0) + usd).toFixed(4));
  u.audio = Number(((u.audio || 0) + usd).toFixed(4));
  mem.setState(todayKey(), JSON.stringify(u));
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
  if (b.auto_reply !== undefined) mem.setState('auto_reply', b.auto_reply === '1' || b.auto_reply === true ? '1' : '0');
  if (b.auto_credit !== undefined) mem.setState('auto_credit', b.auto_credit === '1' || b.auto_credit === true ? '1' : '0');
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
<defs>
<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4f46e5"/><stop offset=".55" stop-color="#7c3aed"/><stop offset="1" stop-color="#06b6d4"/></linearGradient>
<radialGradient id="gl" cx=".3" cy=".22" r=".8"><stop offset="0" stop-color="#fff" stop-opacity=".35"/><stop offset=".6" stop-color="#fff" stop-opacity="0"/></radialGradient>
</defs>
<rect width="512" height="512" rx="120" fill="url(#bg)"/>
<rect width="512" height="512" rx="120" fill="url(#gl)"/>
<path d="M150 132 L256 270 L362 132" fill="none" stroke="#fff" stroke-width="54" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M256 270 V392" stroke="#fff" stroke-width="54" stroke-linecap="round"/>
<path d="M388 318 l14 34 34 14 -34 14 -14 34 -14 -34 -34 -14 34 -14z" fill="#fde68a"/>
<circle cx="142" cy="372" r="16" fill="#a5f3fc"/>
</svg>`;

router.get('/icon.svg', (req, res) => {
  res.type('image/svg+xml').set('Cache-Control', 'public, max-age=604800').send(ICON_SVG);
});

router.get('/manifest.json', (req, res) => {
  const t = req.query.t || '';
  res.type('application/manifest+json').json({
    name: 'Yamen · يمان',
    short_name: 'Yamen',
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
// Tapping an alert notification brings the app to the front.
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if ('focus' in c) return c.focus();
    return self.registration.scope && self.clients.openWindow(self.registration.scope + '?t=' + (new URL(self.location).searchParams.get('t') || ''));
  }));
});
`);
});

// ── The phone interface ──────────────────────────────────────────────────────
// Served as one self-contained page so it can be added to a home screen and
// opened like an app, with no build step and nothing to install.
// Reachability probe for the admin panel. Carries no data and needs no token.
// ChatGPT Business activations waiting (paid, card still red) — the live
// counter at the top of the app. Scheduled seats (paid early, their period
// starts later) are counted apart: they don't need action yet.
router.get('/cgb-waiting', requireToken, (req, res) => {
  try {
    const rawDb = require('../database/db');
    const today = new Date().toISOString().slice(0, 10);
    const rows = rawDb.prepare(`
      SELECT cs.order_id, cs.email, cs.start_date,
             COALESCE(u.username, u.first_name, CAST(cs.user_id AS TEXT)) AS who, u.username,
             CAST((julianday('now') - julianday(COALESCE(cs.updated_at, cs.created_at))) * 1440 AS INTEGER) AS mins
      FROM chatgpt_subscriptions cs LEFT JOIN users u ON u.telegram_id = cs.user_id
      WHERE cs.status = 'pending'
      ORDER BY COALESCE(cs.updated_at, cs.created_at) ASC LIMIT 50`).all();
    const now = rows.filter((r) => !r.start_date || r.start_date <= today);
    res.json({
      count: now.length,
      oldest_minutes: now.length ? Math.max(...now.map((r) => r.mins || 0)) : 0,
      scheduled: rows.length - now.length,
      items: now.slice(0, 10).map((r) => ({ order_id: r.order_id, email: r.email, who: r.username ? '@' + r.username : r.who, minutes: r.mins })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Private chats section (Telegram Business) ──────────────────────────────
//
// One model call that returns TEXT only — no tools, nothing written to Yamen's
// chat — used by "✨ اقترح رد" in the private-chats section. Same models, same
// fallback, and it counts toward the daily budget like every other call.
async function suggestOnce(system, user) {
  if (!API_KEY) throw new Error('no AI key configured');
  if (overBudget()) throw new BudgetError('budget');
  // ✨ suggestions: the fast model — a short reply doesn't need the expensive one.
  const tier = 'fast';
  if (PROVIDER === 'anthropic') {
    const res = await callWithFallback(tier, (model) => axios.post('https://api.anthropic.com/v1/messages',
      { model, max_tokens: 900, system, messages: [{ role: 'user', content: user }] },
      { headers: { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout: 120000 }));
    const u = res.data.usage || {};
    addUsage(res.data.model || modelFor(tier), u.input_tokens, u.cache_read_input_tokens, u.output_tokens);
    return (res.data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  }
  if (isReasoningOpenAI(modelFor(tier))) {
    const res = await callWithFallback(tier, (model) => {
      const body = { model, instructions: system, input: user, max_output_tokens: 2000 };
      if (!isRefused(model, 'reasoning')) body.reasoning = { effort: 'low' };
      return axios.post('https://api.openai.com/v1/responses', body,
        { headers: { Authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' }, timeout: 120000 });
    });
    const u = res.data.usage || {};
    addUsage(res.data.model || modelFor(tier), u.input_tokens, u.input_tokens_details?.cached_tokens, u.output_tokens);
    const text = res.data.output_text ||
      (res.data.output || []).flatMap((o) => o.content || []).filter((c) => c.type === 'output_text').map((c) => c.text).join('');
    return String(text || '').trim();
  }
  const res = await callWithFallback(tier, (model) => axios.post('https://api.openai.com/v1/chat/completions',
    { model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: 900 },
    { headers: { Authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' }, timeout: 120000 }));
  const u = res.data.usage || {};
  addUsage(res.data.model || modelFor(tier), u.prompt_tokens, u.prompt_tokens_details?.cached_tokens, u.completion_tokens);
  return String(res.data.choices?.[0]?.message?.content || '').trim();
}

const SUGGEST_SYSTEM =
  'You write ONE reply that the shop owner will send AS HIMSELF in a personal Telegram chat. Output ONLY the ' +
  'reply text — no quotes, no explanation, no options. Rules: write in the other person\'s language (Tunisian ' +
  'Derja if they write Derja), in the owner\'s voice — match the length, tone and emoji habits of ' +
  'your_recent_replies (style only, never their content). Use "person" (their orders, balance, ChatGPT seat) ' +
  'when it matters. Never invent prices, dates, discounts or promises; if an answer needs one you don\'t have, ' +
  'write a short reply that says the owner will confirm. In a sale or support chat, invite them to order ' +
  'through the shop bot with the real link from "shop" (once, naturally, with one short reason); never invent ' +
  'a link. If the chat is personal (family, friends), write a short warm reply with no selling. If it looks ' +
  'like a scam, output exactly: ⚠️ SUSPICIOUS';

router.get('/business/chats', requireToken, (req, res) => {
  try { res.json(require('./agentTools').TOOLS.business_inbox.run({ hours: 24 * 30 })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/business/thread', requireToken, (req, res) => {
  try {
    const t = require('./agentTools').TOOLS.business_thread.run({ chat: req.query.chat, limit: 120 });
    if (t.error) return res.status(404).json(t);
    // Opening a chat in the app = he saw it (app only, nothing sent to Telegram).
    if (req.query.seen !== '0') { try { require('./businessInbox').markSeen(t.chat_id); } catch (_) {} }
    res.json(t);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/business/suggest', requireToken, async (req, res) => {
  try {
    const t = require('./agentTools').TOOLS.business_thread.run({ chat: req.body.chat, limit: 30 });
    if (t.error) return res.status(404).json(t);
    const text = await suggestOnce(SUGGEST_SYSTEM, JSON.stringify({
      chat: t.messages, person: t.person, shop: t.shop, your_recent_replies: t.your_recent_replies,
    }).slice(0, 24000));
    res.json({ text, suspicious: /^⚠️\s*SUSPICIOUS/.test(text) });
  } catch (e) { res.status(e instanceof BudgetError ? 429 : 500).json({ error: explainError(e) }); }
});

router.post('/business/seen', requireToken, (req, res) => {
  try { res.json(require('./businessInbox').markSeen(req.body.chat)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 💬 Support section (support bot conversations) ──────────────────────────

const SUPPORT_SUGGEST_SYSTEM =
  'You write ONE reply that the shop\'s support will send to a customer in the support bot. Output ONLY the reply ' +
  'text — no quotes, no explanation, no options, no greeting line like "Support:" (the bot adds its own header). ' +
  'Language: English, unless the owner\'s rules say otherwise. Answer what the customer actually asked in the LAST ' +
  'messages, using "person" (their balance, orders, ChatGPT seats) — if their order or payment is there, say what ' +
  'you see. Match the tone and length of support_style (style only). Follow owner_rules. Never invent prices, ' +
  'dates, refunds, credits or promises; never say balance was added unless "person" shows it. If the answer needs ' +
  'a check you cannot do (a TxID, a screenshot), ask for exactly what is needed. For a problem with an order, ' +
  'point to the order history in the bot. Keep it short and kind.';

router.get('/support/chats', requireToken, (req, res) => {
  try { res.json(require('./supportDesk').list({ days: 30 })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/support/thread', requireToken, async (req, res) => {
  try {
    const desk = require('./supportDesk');
    const t = desk.thread(req.query.user);
    if (t.error) return res.status(404).json(t);
    let person = null;
    try { person = require('./agentTools').businessPerson(t.user_id); } catch (_) {}
    if (req.query.read !== '0') await desk.markRead(t.user_id);
    res.json({ ...t, person });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/support/suggest', requireToken, async (req, res) => {
  try {
    const desk = require('./supportDesk');
    const t = desk.thread(req.body.user, { limit: 40 });
    if (t.error) return res.status(404).json(t);
    const tools = require('./agentTools');
    let rules = [];
    try { rules = mem.memoryForPrompt(1500).lines; } catch (_) {}
    const text = await suggestOnce(SUPPORT_SUGGEST_SYSTEM, JSON.stringify({
      customer: t.who, chat: t.messages.map((m) => ({ from: m.from, text: m.text, at: m.at })),
      person: tools.businessPerson(t.user_id), shop: tools.shopLinks(),
      support_style: desk.styleSample(), owner_rules: rules,
    }).slice(0, 24000));
    res.json({ text });
  } catch (e) { res.status(e instanceof BudgetError ? 429 : 500).json({ error: explainError(e) }); }
});

// The owner pressed send on text he wrote or reviewed: that IS his tap.
router.post('/support/send', requireToken, async (req, res) => {
  const text = String(req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'empty' });
  const r = await require('./supportDesk').send(req.body.user, text);
  if (r.ok) mem.logChat('event', `✅ Support reply sent to ${req.body.user} (from the app): "${text.slice(0, 80)}"`);
  res.status(r.ok ? 200 : 502).json(r);
});

// The owner typed (or edited) the reply himself and pressed send: sending it
// IS his tap. Goes out as him through the business connection.
router.post('/business/send', requireToken, async (req, res) => {
  const bi = require('./businessInbox');
  const id = bi._resolveChat(req.body.chat);
  const text = String(req.body.text || '').trim();
  if (!id) return res.status(404).json({ error: 'chat not found' });
  if (!text) return res.status(400).json({ error: 'empty' });
  const r = await bi.sendReply(id, text.slice(0, 4000));
  res.status(r.ok ? 200 : 502).json(r);
});

router.get('/ping', (req, res) => res.json({ ok: true, service: 'shop-assistant',
  version: (() => { try { return require('../package.json').version; } catch (_) { return '?'; } })(),
  canva: (() => { try { return require('./canvaBot').available(); } catch (_) { return false; } })() }));

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


// Canva remote-login page, gated by the same token.
try { require('./canvaLoginPage').mount(router, ACCESS_TOKEN); } catch (e) { logger.warn(`[canva] login page: ${e.message}`); }

module.exports = { __runTurnForTest: runTurn, _tokenDiet: { pickGroups, toolsFor, guidesFor, runTools, TOOL_GROUPS, PERSONA, GUIDES }, router, ACCESS_TOKEN, agentConfig, probeAgent, proactiveTurn, canvaLoginUrl: () => {
  const cfg = agentConfig();
  return cfg.base ? `${cfg.base}/agent/canva/login?t=${ACCESS_TOKEN}` : '';
} };
