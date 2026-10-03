'use strict';

/**
 * The agent's hands — read only, by construction.
 *
 * Every tool here answers a question. None of them writes, charges, refunds,
 * changes stock or sends a message to anyone. That is enforced by what this
 * file exports, not by instructions in a prompt: a customer's message can talk
 * a model into trying anything, but it cannot conjure a function that does not
 * exist. If a write tool is ever wanted it belongs behind an explicit human
 * confirmation, added deliberately — never by widening one of these.
 *
 * The shop's own query layer is reused rather than raw SQL, so the agent sees
 * exactly the numbers the admin panel shows and the two can never disagree.
 */

const db = require('../database/queries');
const raw = require('../database/db');
const logger = require('../utils/logger');

/** Titles carry [emoji:ID] markers that are noise to a language model. */
const clean = (t) => String(t || '').replace(/\[emoji:\d+\]/g, '').trim();

const TOOLS = {
  /**
   * The shape of the business in one call.
   *
   * Without it the agent answers every question from a standing start and has
   * no sense of scale — it cannot tell whether 40 orders is a good day or a
   * collapse, or whether a $12 refund is routine or unusual here. One cheap
   * call at the beginning of a conversation makes every later answer better
   * grounded.
   */
  shop_overview: {
    description:
      'A snapshot of the whole shop: size, recent trend, stock health, ' +
      'support backlog and anything that looks wrong. Call this first when ' +
      'the owner asks something open-ended.',
    input: {},
    run: () => {
      const sales = (days) => raw.prepare(`
        SELECT COUNT(*) AS orders, COALESCE(SUM(total_price),0) AS revenue
        FROM orders WHERE status NOT IN ('cancelled','pending')
          AND created_at >= datetime('now', '-' || ? || ' days')
      `).get(days);

      const week = sales(7);
      const prev = raw.prepare(`
        SELECT COUNT(*) AS orders, COALESCE(SUM(total_price),0) AS revenue
        FROM orders WHERE status NOT IN ('cancelled','pending')
          AND created_at >= datetime('now','-14 days')
          AND created_at <  datetime('now','-7 days')
      `).get();

      const pct = (now, before) =>
        before > 0 ? Math.round(((now - before) / before) * 100) : null;

      const products = db.getAllActiveProducts();
      const lowStock = products
        .filter((p) => Number(p.stock_quantity) <= 5)
        .map((p) => ({ id: p.id, title: clean(p.title), stock: p.stock_quantity }));

      let unread = 0;
      try {
        unread = raw.prepare(`
          SELECT COUNT(DISTINCT user_id) AS n FROM support_messages
          WHERE direction='in' AND is_read=0
        `).get()?.n || 0;
      } catch (e) { /* table may be empty */ }

      let refunds = 0;
      try {
        refunds = raw.prepare("SELECT COUNT(*) AS n FROM refund_requests WHERE status='pending'").get()?.n || 0;
      } catch (e) { /* ignore */ }

      return {
        today: sales(1),
        last_7_days: week,
        change_vs_previous_week: {
          orders_pct: pct(week.orders, prev.orders),
          revenue_pct: pct(week.revenue, prev.revenue),
        },
        active_products: products.length,
        out_of_stock: products.filter((p) => Number(p.stock_quantity) <= 0).length,
        low_stock: lowStock,
        customers_waiting_for_reply: unread,
        pending_refunds: refunds,
      };
    },
  },

  // ── Sales and money ──────────────────────────────────────────────────────
  sales_summary: {
    description: 'Totals for a period: orders, units, revenue, and the top products.',
    input: { days: 'number of days to look back, default 7' },
    run: ({ days = 7 }) => {
      const d = Math.min(365, Math.max(1, Number(days) || 7));
      const row = raw.prepare(`
        SELECT COUNT(*) AS orders, COALESCE(SUM(quantity),0) AS units,
               COALESCE(SUM(total_price),0) AS revenue
        FROM orders
        WHERE status NOT IN ('cancelled','pending')
          AND created_at >= datetime('now', '-' || ? || ' days')
      `).get(d);
      const top = raw.prepare(`
        SELECT p.title, SUM(o.quantity) AS units, SUM(o.total_price) AS revenue
        FROM orders o JOIN products p ON p.id = o.product_id
        WHERE o.status NOT IN ('cancelled','pending')
          AND o.created_at >= datetime('now', '-' || ? || ' days')
        GROUP BY o.product_id ORDER BY units DESC LIMIT 8
      `).all(d).map((r) => ({ ...r, title: clean(r.title) }));
      return { days: d, ...row, top_products: top };
    },
  },

  best_hours: {
    description: 'Which hours of the day sell most, in the shop timezone.',
    input: { days: 'lookback window, default 30' },
    run: ({ days = 30 }) => {
      const offset = parseFloat(db.getSetting('shop_timezone_offset', '1')) || 0;
      const r = db.salesByHour(Math.min(180, Number(days) || 30), offset);
      const hours = r.hours.map((h, i) => ({ hour: i, orders: h.count, revenue: Number(h.revenue.toFixed(2)) }));
      return { timezone_offset: offset, total_orders: r.total, hours };
    },
  },

  api_sales: {
    description: 'What was bought through the API, and by whom.',
    input: { days: 'lookback window, default 30' },
    run: ({ days = 30 }) => {
      const a = db.apiSales(Math.min(180, Number(days) || 30));
      return {
        days: a.days, units: a.units, orders: a.orders, revenue: a.revenue,
        buyers: a.buyers.slice(0, 10),
        products: a.products.slice(0, 10).map((p) => ({ ...p, title: clean(p.title) })),
      };
    },
  },

  // ── Stock ────────────────────────────────────────────────────────────────
  products_list: {
    description: 'All active products with price and stock.',
    input: {},
    run: () => db.getAllActiveProducts().map((p) => ({
      id: p.id, title: clean(p.title), price: p.price,
      stock: p.stock_quantity, sold: p.sales_count,
      delivery: p.delivery_type,
      vip_discount: Number(p.no_rank_discount) !== 1,   // false = VIPs pay the normal price: never promise them a discount
    })),
  },

  stock_audit: {
    description: 'Who bought a product and how much, over a period.',
    input: { product_id: 'required', days: 'default 30' },
    run: ({ product_id, days = 30 }) => {
      const a = db.stockAudit(Number(product_id), Math.min(365, Number(days) || 30));
      return { units: a.units, orders: a.orders, revenue: a.revenue, buyers: a.buyers.slice(0, 15) };
    },
  },

  stock_batches: {
    description: 'Stock uploads for a product: size, cost, what sold, profit.',
    input: { product_id: 'required' },
    run: ({ product_id }) => db.stockBatches(Number(product_id), 12).map((b) => ({
      added_at: b.added_at, supplier: b.supplier, total: b.total,
      sold: b.sold, available: b.available,
      unit_cost: b.unit_cost, spent: b.spent, revenue: b.revenue,
      profit_on_sold: b.profit_so_far, net_vs_spend: b.net_vs_spend,
      top_buyers: b.buyers,
    })),
  },

  stock_reconcile: {
    description: 'Does a product\'s stock add up, or did units vanish without a sale?',
    input: { product_id: 'required' },
    run: ({ product_id }) => db.stockReconcile(Number(product_id)),
  },

  suppliers: {
    description: 'Suppliers with how much they supplied and how much sold.',
    input: {},
    run: () => require('../database/items').listSuppliers(),
  },

  find_account_supplier: {
    description: 'Who supplied a specific account (paste an email or part of it).',
    input: { fragment: 'email or any part of the account text' },
    run: ({ fragment }) => require('../database/items')
      .findItemsByContent(String(fragment || ''))
      .slice(0, 10)
      .map((r) => ({
        supplier: r.supplier, product: clean(r.product_title),
        status: r.status, added: r.created_at, sold_to: r.sold_to_user_id,
      })),
  },

  // ── Customers ────────────────────────────────────────────────────────────
  customer_lookup: {
    description: 'One customer: balance, rank, orders, and recent purchases.',
    input: { user_id: 'telegram id, or username without @' },
    run: ({ user_id }) => {
      const q = String(user_id || '').replace(/^@/, '');
      const u = /^\d+$/.test(q)
        ? raw.prepare('SELECT * FROM users WHERE telegram_id = ?').get(Number(q))
        : raw.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(q);
      if (!u) return { found: false };
      const orders = raw.prepare(`
        SELECT o.id, o.quantity, o.total_price, o.status, o.created_at,
               COALESCE(o.source,'bot') AS source, p.title
        FROM orders o LEFT JOIN products p ON p.id = o.product_id
        WHERE o.user_id = ? ORDER BY o.id DESC LIMIT 10
      `).all(u.telegram_id).map((o) => ({ ...o, title: clean(o.title) }));
      const rank = db.getUserRank(u.telegram_id);
      return {
        found: true, user_id: u.telegram_id, username: u.username,
        balance: u.balance, is_vip: !!u.is_vip,
        rank: rank.tier?.name, discount_pct: rank.discountPct, rank_spend: rank.spend,
        recent_orders: orders,
      };
    },
  },

  top_customers: {
    description: 'Biggest spenders over a period.',
    input: { days: 'default 30', limit: 'default 10' },
    run: ({ days = 30, limit = 10 }) => raw.prepare(`
      SELECT o.user_id, u.username, COUNT(*) AS orders,
             SUM(o.quantity) AS units, SUM(o.total_price) AS spent
      FROM orders o LEFT JOIN users u ON u.telegram_id = o.user_id
      WHERE o.status NOT IN ('cancelled','pending')
        AND o.created_at >= datetime('now', '-' || ? || ' days')
      GROUP BY o.user_id ORDER BY spent DESC LIMIT ?
    `).all(Math.min(365, Number(days) || 30), Math.min(50, Number(limit) || 10)),
  },

  // ── Support ──────────────────────────────────────────────────────────────
  support_unread: {
    description: 'Conversations waiting for a reply, oldest message first.',
    input: {},
    run: () => {
      try {
        return raw.prepare(`
          SELECT m.user_id, u.username,
                 COUNT(CASE WHEN m.direction='in' AND m.is_read=0 THEN 1 END) AS unread,
                 MAX(m.created_at) AS last_time
          FROM support_messages m LEFT JOIN users u ON u.telegram_id = m.user_id
          GROUP BY m.user_id HAVING unread > 0
          ORDER BY last_time ASC LIMIT 20
        `).all();
      } catch (e) { return []; }
    },
  },

  support_thread: {
    description: 'The messages of one support conversation, oldest first.',
    input: { user_id: 'required', limit: 'default 60, max 300' },
    run: ({ user_id, limit = 60 }) => {
      try {
        return raw.prepare(`
          SELECT direction, content AS body, created_at FROM support_messages
          WHERE user_id = ? ORDER BY id DESC LIMIT ?
        `).all(Number(user_id), Math.min(300, Number(limit) || 60)).reverse();
      } catch (e) { return []; }
    },
  },

  /**
   * Every conversation of a period, in full — what "read all the chats and
   * summarise them for me" needs.
   *
   * support_unread only counts, and support_thread reads one customer at a
   * time; a digest of the day would take dozens of calls and still miss the
   * threads that were already answered. This returns every thread that had any
   * message in the window, with its messages in order, in one call.
   */
  support_digest: {
    description:
      'ALL support conversations with activity in the last N hours, every thread ' +
      'with its messages in order. Use for "summarise the chats", "what happened ' +
      'today", "who is waiting", or before answering anything about support as a whole.',
    input: {
      hours: 'how far back, default 24 (max 168)',
      max_customers: 'default 25',
    },
    run: ({ hours = 24, max_customers = 25 }) => {
      // Kept small on purpose: this is the most expensive tool by far, and the
      // newest messages of each thread carry the story.
      const h = Math.min(168, Math.max(1, Number(hours) || 24));
      const cap = Math.min(40, Math.max(1, Number(max_customers) || 25));
      try {
        const users = raw.prepare(`
          SELECT m.user_id,
                 MAX(COALESCE(m.username, u.username))     AS username,
                 MAX(COALESCE(m.first_name, u.first_name)) AS first_name,
                 COUNT(*) AS messages,
                 COUNT(CASE WHEN m.direction='in' AND m.is_read=0 THEN 1 END) AS unread,
                 MAX(m.id) AS last_id
          FROM support_messages m LEFT JOIN users u ON u.telegram_id = m.user_id
          WHERE m.created_at >= datetime('now', '-' || ? || ' hours')
            AND m.deleted_at IS NULL
          GROUP BY m.user_id
          ORDER BY last_id DESC
          LIMIT ?
        `).all(h, cap);

        const msgs = raw.prepare(`
          SELECT direction, content, media_type, created_at FROM support_messages
          WHERE user_id = ? AND created_at >= datetime('now', '-' || ? || ' hours')
            AND deleted_at IS NULL
          ORDER BY id DESC LIMIT 8
        `);

        const threads = users.map((u) => {
          const rows = msgs.all(u.user_id, h).reverse();
          const last = rows[rows.length - 1];
          return {
            user_id: u.user_id,
            customer: u.username ? `@${u.username}` : (u.first_name || String(u.user_id)),
            unread: u.unread,
            // The customer spoke last: someone is waiting for an answer.
            waiting_for_reply: !!(last && last.direction === 'in'),
            messages: rows.map((r) => ({
              from: r.direction === 'in' ? 'customer' : 'support',
              at: r.created_at,
              text: String(r.content || (r.media_type ? `[${r.media_type}]` : '')).slice(0, 220),
            })),
          };
        });
        return { hours: h, conversations: threads.length, threads };
      } catch (e) {
        return { error: e.message };
      }
    },
  },

  /**
   * Past answers to similar questions.
   *
   * This is what lets the agent reply in the shop's own voice instead of a
   * generic one: it is shown how this shop has answered before, not told to
   * imagine how it might.
   */
  support_examples: {
    description: 'How this shop answered similar questions before.',
    input: { about: 'a word or phrase from the customer\'s question' },
    run: ({ about }) => {
      const term = `%${String(about || '').trim()}%`;
      try {
        return raw.prepare(`
          SELECT m_in.content AS question, m_out.content AS answer, m_out.created_at
          FROM support_messages m_in
          JOIN support_messages m_out
            ON m_out.user_id = m_in.user_id
           AND m_out.direction = 'out'
           AND m_out.id = (SELECT MIN(id) FROM support_messages x
                           WHERE x.user_id = m_in.user_id AND x.direction='out' AND x.id > m_in.id)
          WHERE m_in.direction = 'in' AND m_in.content LIKE ?
          ORDER BY m_out.id DESC LIMIT 8
        `).all(term);
      } catch (e) { return []; }
    },
  },

  /**
   * Search every support conversation for a word, a name or an email.
   *
   * The tool the owner actually reaches for: "someone asked to change their
   * ChatGPT email yesterday, who was it?". Without it the agent can only read a
   * thread it has already been given a user_id for — which is the one thing the
   * owner does not have when they are trying to remember who someone was.
   */
  support_search: {
    description:
      'Search ALL support conversations for a word, email, name or phrase. ' +
      'Use this to find a customer the owner half-remembers.',
    input: {
      query: 'text to look for — an email, a word, part of a sentence',
      days: 'how far back, default 30',
      limit: 'max results, default 20',
    },
    run: ({ query, days = 30, limit = 20 }) => {
      const term = String(query || '').trim();
      if (term.length < 2) return { error: 'Give at least 2 characters to search for' };

      try {
        const rows = raw.prepare(`
          SELECT m.id, m.user_id, m.direction, m.content, m.created_at,
                 COALESCE(m.username, u.username)     AS username,
                 COALESCE(m.first_name, u.first_name) AS first_name
          FROM support_messages m
          LEFT JOIN users u ON u.telegram_id = m.user_id
          WHERE m.content LIKE ? COLLATE NOCASE
            AND m.created_at >= datetime('now', '-' || ? || ' days')
          ORDER BY m.id DESC
          LIMIT ?
        `).all(`%${term}%`, Math.min(365, Number(days) || 30), Math.min(60, Number(limit) || 20));

        // Grouped by customer: ten messages from one person is one answer to
        // "who was it", not ten.
        const byUser = new Map();
        for (const r of rows) {
          const k = String(r.user_id);
          if (!byUser.has(k)) {
            byUser.set(k, {
              user_id: r.user_id, username: r.username, first_name: r.first_name,
              matches: [], last_seen: r.created_at,
            });
          }
          byUser.get(k).matches.push({
            from: r.direction === 'in' ? 'customer' : 'support',
            text: String(r.content || '').slice(0, 300),
            at: r.created_at,
          });
        }
        return { query: term, found: byUser.size, customers: [...byUser.values()] };
      } catch (e) {
        return { error: e.message };
      }
    },
  },

  /**
   * Which ChatGPT seats belong to a customer.
   *
   * An email-change request is answered by knowing which seat is theirs and
   * when it ends — guessing from the support text alone gets the wrong seat
   * when someone holds more than one.
   */
  cgb_seats_of: {
    description: 'The ChatGPT Business seats held by one customer.',
    input: { user_id: 'telegram id' },
    run: ({ user_id }) => {
      try {
        return db.getCgbSubsByUser(Number(user_id)).map((r) => ({
          id: r.id, email: r.email, status: r.status,
          start: r.start_date, end: r.end_date,
          workspace: r.workspace, renew_intent: r.renew_intent,
        }));
      } catch (e) { return []; }
    },
  },

  // ── Payments ─────────────────────────────────────────────────────────────
  trace_payment: {
    description: 'Follow a TxID or payment id: did it arrive, was it credited, what was bought after.',
    input: { id: 'TxID, Binance id, or part of one' },
    run: ({ id }) => {
      const r = db.traceTxid(String(id || ''));
      if (!r || !r.found) return { found: false };
      return {
        found: true, purpose: r.purpose,
        customer: r.user ? { id: r.user.telegram_id, username: r.user.username, balance: r.user.balance } : null,
        credited: r.credited, ledger: r.ledger.slice(0, 5),
        spent_after: r.spentAfter.slice(0, 8).map((o) => ({ ...o, product_title: clean(o.product_title) })),
        flags: r.flags,
      };
    },
  },

  refund_requests: {
    description: 'Refund requests and their status.',
    input: { status: 'pending | approved | rejected, default pending' },
    run: ({ status = 'pending' }) => {
      try {
        return raw.prepare(`
          SELECT rr.id, rr.user_id, u.username, rr.order_id, rr.amount,
                 rr.reason, rr.status, rr.created_at
          FROM refund_requests rr LEFT JOIN users u ON u.telegram_id = rr.user_id
          WHERE rr.status = ? ORDER BY rr.id DESC LIMIT 20
        `).all(String(status));
      } catch (e) { return []; }
    },
  },

  // ── ChatGPT Business ─────────────────────────────────────────────────────
  cgb_overview: {
    description: 'ChatGPT Business seats: active, renewals paid, renewals owed.',
    input: {},
    run: () => ({
      cycle: (() => {
        const c = require('../services/cgbCycles').calculateBestCycle();
        if (!c) return null;
        const p2 = (n) => String(n).padStart(2, '0');
        const f = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
        return { starts: f(c.startDate || new Date()), ends: f(c.endDate), days_left: c.daysRemaining,
                 cycle_days: c.cycleLength, between_cycles: !!c.inGap };
      })(),
      monthly_price: require('../services/cgbCycles').getMonthlyPrice(),
      paid_renewals: db.getCgbRenewals(10),
      awaiting_payment: db.getCgbPendingRenewals().slice(0, 10),
      scheduled: (db.getCgbScheduled ? db.getCgbScheduled() : []).slice(0, 10),
      due_now: (db.getCgbDueNow ? db.getCgbDueNow() : []).slice(0, 10),
    }),
  },
  cgb_new_seats_since: {
    description:
      'Every ChatGPT Business seat created since a date: email, order id, cycle start/end, days left, status ' +
      '(active/pending/expired). Use for "what came in since X", "who is expiring soon", or to answer any ' +
      'question about a customer\'s cycle without being asked for specifics first. Sorted soonest-expiring first.',
    input: { since: 'YYYY-MM-DD — defaults to 2026-09-26 if not given' },
    run: ({ since } = {}) => {
      const from = /^\d{4}-\d{2}-\d{2}$/.test(String(since || '')) ? since : '2026-09-26';
      const rows = raw.prepare(`
        SELECT cs.order_id, cs.user_id, cs.email, cs.start_date, cs.end_date, cs.status, cs.workspace,
               u.username, u.first_name
        FROM chatgpt_subscriptions cs
        LEFT JOIN users u ON u.telegram_id = cs.user_id
        WHERE cs.start_date >= ?
        ORDER BY cs.end_date ASC
      `).all(from);
      const today = new Date().toISOString().slice(0, 10);
      return {
        since: from,
        count: rows.length,
        seats: rows.map((r) => ({
          order_id: r.order_id, email: r.email,
          customer: r.username ? `@${r.username}` : (r.first_name || `user ${r.user_id}`),
          start: r.start_date, end: r.end_date, status: r.status,
          days_left: Math.ceil((new Date(`${r.end_date}T00:00:00`) - new Date(`${today}T00:00:00`)) / 86400000),
          workspace: r.workspace || null,
        })),
      };
    },
  },
};

// ── Memory & awareness ───────────────────────────────────────────────────────
// The assistant's notebook is the one place it may write. See agentMemory.js
// for why that keeps the read-only boundary intact.
const mem = require('./agentMemory');

const safe = (fn, fallback = []) => { try { return fn(); } catch (_) { return fallback; } };

TOOLS.remember = {
  description:
    'Save a lasting fact to your own memory: an owner preference or rule, something about a ' +
    'customer, supplier or product, a decision, a recurring problem. Use it without being asked ' +
    'whenever you learn something worth knowing next week. One fact per call, short and specific.',
  input: {
    text: 'the fact, self-contained (include names/ids/emails so it makes sense later)',
    category: 'owner | customer | supplier | product | rule | issue | note | vocab (a word/name to hear correctly in voice notes)',
  },
  run: ({ text, category }) => {
    const id = mem.addMemory(text, category || 'note', 'assistant');
    return id ? { saved: true, id } : { error: 'empty' };
  },
};

TOOLS.update_memory = {
  description: 'Correct or replace one of your memory notes by id (when a fact changed).',
  input: { id: 'the note id (#N in your memory)', text: 'the corrected fact' },
  run: ({ id, text }) => ({ updated: mem.updateMemory(id, text) }),
};

TOOLS.forget = {
  description: 'Delete a memory note by id — when it is wrong, outdated, or the owner asks.',
  input: { id: 'the note id' },
  run: ({ id }) => ({ deleted: mem.deleteMemory(id) }),
};

TOOLS.recall_memory = {
  description: 'Search ALL your memory notes (the prompt shows only the newest).',
  input: { query: 'word, name, email or topic' },
  run: ({ query }) => mem.searchMemory(query),
};

TOOLS.search_past_chats = {
  description: 'Search your earlier conversations with the owner — "what did we say about X".',
  input: { query: 'word or phrase' },
  run: ({ query }) => mem.searchChat(query),
};

/**
 * One timeline of what happened across all three bots.
 *
 * "What's going on?" should not need six tools. Orders, wallet movements,
 * refund requests, manual deliveries, ChatGPT seats, deposit reviews and the
 * admin notification feed, merged newest first.
 */
TOOLS.recent_activity = {
  description:
    'Everything that happened in the shop in the last N hours, across the store, support and ' +
    'ChatGPT bots: orders, payments/deposits, refunds, manual deliveries, seats, deposit reviews, ' +
    'admin alerts — one merged timeline, newest first.',
  input: { hours: 'default 24, max 720' },
  run: ({ hours = 24 }) => {
    const h = Math.min(720, Math.max(1, Number(hours) || 24));
    const since = `-${h} hours`;
    const ev = [];
    const push = (kind, rows, fmt) => rows.forEach((r) => ev.push({ kind, at: r.created_at, ...fmt(r) }));

    push('order', safe(() => raw.prepare(`
      SELECT o.id, o.user_id, o.quantity, o.total_price, o.payment_method, o.status, o.source,
             o.created_at, p.title, u.username
      FROM orders o LEFT JOIN products p ON p.id = o.product_id
      LEFT JOIN users u ON u.telegram_id = o.user_id
      WHERE o.created_at >= datetime('now', ?) ORDER BY o.id DESC LIMIT 60`).all(since)),
      (r) => ({ id: r.id, who: r.username ? '@' + r.username : r.user_id,
                what: `${r.quantity}× ${clean(r.title)} $${r.total_price} ${r.status} via ${r.payment_method}${r.source ? ' (' + r.source + ')' : ''}` }));

    push('wallet', safe(() => raw.prepare(`
      SELECT t.id, t.user_id, t.type, t.amount, t.description, t.status, t.created_at, u.username
      FROM transactions t LEFT JOIN users u ON u.telegram_id = t.user_id
      WHERE t.created_at >= datetime('now', ?) ORDER BY t.id DESC LIMIT 60`).all(since)),
      (r) => ({ id: r.id, who: r.username ? '@' + r.username : r.user_id,
                what: `${r.type} $${r.amount} ${r.status || ''} ${clean(r.description || '')}`.trim() }));

    push('refund_request', safe(() => raw.prepare(`
      SELECT id, user_id, order_id, status, amount, reason, created_at FROM refund_requests
      WHERE created_at >= datetime('now', ?) ORDER BY id DESC LIMIT 30`).all(since)),
      (r) => ({ id: r.id, who: r.user_id, what: `order #${r.order_id} ${r.status} ${r.amount ? '$' + r.amount : ''} — ${String(r.reason || '').slice(0, 120)}` }));

    push('manual_delivery', safe(() => raw.prepare(`
      SELECT id, order_id, user_id, status, email, created_at FROM manual_deliveries
      WHERE created_at >= datetime('now', ?) ORDER BY id DESC LIMIT 30`).all(since)),
      (r) => ({ id: r.id, who: r.user_id, what: `order #${r.order_id} ${r.status}${r.email ? ' ' + r.email : ''}` }));

    push('chatgpt_seat', safe(() => raw.prepare(`
      SELECT id, user_id, email, start_date, end_date, status, final_price, created_at
      FROM chatgpt_subscriptions WHERE created_at >= datetime('now', ?) ORDER BY id DESC LIMIT 30`).all(since)),
      (r) => ({ id: r.id, who: r.user_id, what: `${r.email} ${r.status} ${r.start_date}→${r.end_date} $${r.final_price}` }));

    push('deposit_review', safe(() => raw.prepare(`
      SELECT id, user_id, amount, network, status, reason, created_at FROM deposit_reviews
      WHERE created_at >= datetime('now', ?) ORDER BY id DESC LIMIT 30`).all(since)),
      (r) => ({ id: r.id, who: r.user_id, what: `$${r.amount} ${r.network} ${r.status} — ${r.reason || ''}` }));

    push('admin_alert', safe(() => raw.prepare(`
      SELECT id, type, title, body, is_read, created_at FROM admin_notifications
      WHERE created_at >= datetime('now', ?) ORDER BY id DESC LIMIT 40`).all(since)),
      (r) => ({ id: r.id, what: `${r.type}: ${clean(r.title)} ${r.is_read ? '' : '(unread)'} — ${clean(String(r.body || '')).slice(0, 160)}` }));

    ev.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    return { hours: h, events: ev.length, timeline: ev.slice(0, 60) };
  },
};

/**
 * The shop at a glance, computed with no AI — cheap enough to run on every
 * message and on every page open. This is what makes the assistant "know what
 * the owner is doing" before a single tool is called.
 */
function liveSnapshot() {
  const one = (sql, ...a) => safe(() => raw.prepare(sql).get(...a), {}) || {};
  const waiting = safe(() => raw.prepare(`
    SELECT COUNT(*) AS n FROM (
      SELECT m.user_id, (SELECT direction FROM support_messages x
                         WHERE x.user_id = m.user_id AND x.deleted_at IS NULL
                         ORDER BY x.id DESC LIMIT 1) AS last_dir
      FROM support_messages m GROUP BY m.user_id) WHERE last_dir = 'in'`).get().n, 0);
  return {
    support_waiting: waiting,
    support_unread: one(`SELECT COUNT(DISTINCT user_id) AS n FROM support_messages
                         WHERE direction='in' AND is_read=0`).n || 0,
    manual_deliveries_pending: one(`SELECT COUNT(*) AS n FROM manual_deliveries
                         WHERE status IN ('pending','open','waiting','claimed')`).n || 0,
    refund_requests_open: one(`SELECT COUNT(*) AS n FROM refund_requests WHERE status='pending'`).n || 0,
    deposit_reviews_open: one(`SELECT COUNT(*) AS n FROM deposit_reviews WHERE status='pending'`).n || 0,
    chatgpt_to_activate: one(`SELECT COUNT(*) AS n FROM chatgpt_subscriptions
                         WHERE status='pending' AND date(start_date) <= date('now')`).n || 0,
    orders_today: one(`SELECT COUNT(*) AS n, COALESCE(SUM(total_price),0) AS rev FROM orders
                       WHERE status='delivered' AND date(created_at) = date('now')`),
    out_of_stock: safe(() => raw.prepare(`
      SELECT p.id FROM products p WHERE COALESCE(p.is_active,1)=1
        AND COALESCE(p.unlimited_stock,0)=0 AND COALESCE(p.is_chatgpt_business,0)=0
        AND COALESCE(p.delivery_type,'auto') <> 'manual'
        AND (SELECT COUNT(*) FROM product_items i WHERE i.product_id=p.id AND i.status='available') = 0
        AND (SELECT COUNT(*) FROM stock s WHERE s.product_id=p.id AND COALESCE(s.is_sold,0)=0) = 0
    `).all().length, 0),
  };
}

// ── Payments, live ───────────────────────────────────────────────────────────
// Read-only calls to Binance with the shop's own keys — the same lookups the
// admin panel's /trace uses. They cannot move money.

const binance = (() => { try { return require('./binance'); } catch (_) { return null; } })();
const fmtTime = (ms) => (ms ? new Date(Number(ms)).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : null);

TOOLS.txid_check = {
  description:
    'Check a TxID / Binance Pay id / order id end to end: is it on Binance (live), for how much, ' +
    'which network, confirmed or not — AND was it already used in the shop, by whom, credited or not, ' +
    'what was bought with it. Use for any "check this txid" or "did X pay".',
  input: { id: 'the TxID, Binance Pay transaction/order id, or a long part of it' },
  run: async ({ id }) => {
    const needle = String(id || '').trim();
    if (needle.length < 6) return { error: 'id too short' };
    const shop = (() => {
      try {
        const r = db.traceTxid(needle);
        if (!r || !r.found) return { used_in_shop: false };
        return {
          used_in_shop: true, purpose: r.purpose, credited: r.credited,
          customer: r.user ? { id: r.user.telegram_id, username: r.user.username } : null,
          ledger: (r.ledger || []).slice(0, 3),
          spent_after: (r.spentAfter || []).slice(0, 5).map((o) => ({ ...o, product_title: clean(o.product_title) })),
          flags: r.flags,
        };
      } catch (e) { return { error: e.message }; }
    })();
    let chain = { checked: false, reason: 'Binance keys not configured' };
    if (binance) {
      const [dep, pay] = await Promise.all([
        binance.findDepositRaw(needle).catch((e) => ({ ok: false, error: e.message })),
        binance.findPayTransactionRaw(needle).catch((e) => ({ ok: false, error: e.message })),
      ]);
      chain = {
        checked: !!(dep.ok || pay.ok),
        error: !dep.ok && !pay.ok ? (dep.error || pay.error) : undefined,
        onchain_deposits: (dep.matches || []).slice(0, 3).map((m) => ({
          txid: m.txId, amount: m.amount, coin: m.coin, network: m.network,
          status: m.status === 1 ? 'credited to Binance' : m.status === 0 ? 'pending' : `status ${m.status}`,
          at: fmtTime(m.insertTime),
        })),
        binance_pay: (pay.matches || []).slice(0, 3).map((m) => ({
          transaction_id: m.transactionId, order_id: m.orderId, amount: m.amount, currency: m.currency,
          type: m.orderType, at: fmtTime(m.transactionTime),
          from: m.payerInfo ? (m.payerInfo.name || m.payerInfo.binanceId || null) : null,
        })),
      };
    }
    const onBinance = chain.onchain_deposits?.length || chain.binance_pay?.length;
    return {
      verdict: !chain.checked ? 'could not check Binance'
        : !onBinance ? 'NOT found on Binance'
          : shop.used_in_shop ? 'on Binance AND already used in the shop'
            : 'on Binance, NOT used in the shop yet',
      binance: chain, shop,
    };
  },
};

// ── Autonomous crediting for small, VERIFIED deposits ────────────────────────
//
// Off by default (AGENT_AUTO_CREDIT_CAP / auto_credit gate below). When the
// owner turns it on, this handles the exact scenario in the shop's own
// transcripts: a customer's transfer arrived and matched nothing automatic,
// but is small and genuinely verifiable on Binance. Rather than trust
// anything the model or the customer claims, this tool RE-CHECKS BINANCE
// ITSELF (the same lookup txid_check uses) and only ever credits the amount
// Binance reports — never a number typed by the model or the customer.
//
// Every safety gate is enforced HERE, in code, not left to the model's
// judgment (the same principle as send_reply_now's SAFE category list):
//   - a settings toggle, off until the owner turns it on
//   - a per-transaction cap (small dollar amounts only)
//   - a rolling 24h total cap (a bug or an unusual run of deposits can't
//     silently drain more than intended even one small credit at a time)
//   - the TxID must not already be used anywhere in the shop
//   - a real on-chain/Binance-Pay match is REQUIRED; no match, no credit
// Any gate failing falls back to a normal propose_credit DRAFT instead of
// simply refusing — the tool is useful either way, and the model does not
// need to check any of this itself.
//
// The customer-facing message is a FIXED template (see agentChat.js's
// runTools), never model-authored text, so this can't be talked into saying
// something wrong about money. The owner is notified after every autonomous
// credit — never silent — so it stays reviewable.
const AUTO_CREDIT_CAP = Number(process.env.AGENT_AUTO_CREDIT_CAP || 10);
const AUTO_CREDIT_DAILY_CAP = Number(process.env.AGENT_AUTO_CREDIT_DAILY_CAP || AUTO_CREDIT_CAP * 3);

function todayAutoCreditedTotal() {
  try {
    const row = raw.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
      WHERE type = 'auto_credit_verified_deposit' AND date(created_at) = date('now')
    `).get();
    return Number(row?.total || 0);
  } catch (_) { return 0; }
}

TOOLS.auto_credit_verified_deposit = {
  description:
    `For a customer's own deposit that Binance itself confirms (a TxID or Binance Pay id) — credit it and reply ` +
    `to them immediately, no owner tap needed. Only for SMALL amounts Binance verifies directly; everything else ` +
    `(off, over the cap, already used, not found on Binance) automatically becomes a normal propose_credit draft ` +
    `instead, so calling this is always safe and useful. Always look the customer up first if you don't already ` +
    `know their id.`,
  input: {
    txid: 'the TxID or Binance Pay transaction/order id the customer gave',
    user: 'customer @username or telegram id',
  },
  run: async ({ txid, user }) => {
    const id = String(txid || '').trim();
    if (id.length < 6) return { error: 'txid too short' };
    const key = String(user || '').trim().replace(/^@/, '');
    const u = /^\d+$/.test(key) ? raw.prepare('SELECT * FROM users WHERE telegram_id = ?').get(Number(key))
      : raw.prepare('SELECT * FROM users WHERE lower(username) = lower(?)').get(key);
    if (!u) return { error: `customer "${user}" not found` };

    if (db.isTxidUsed(id)) return { error: `${id} was already used/credited in the shop — check txid_check before crediting again.` };
    if (!binance) return { error: 'Binance is not configured — cannot verify this TxID. Ask the owner to credit it from /admin if he checked it himself.' };

    // Binance FIRST, always — the old order drafted a placeholder $0.01 credit
    // whenever auto-credit was off (owner's 30-09 transcript: "💰 زيد $0.01"
    // for a verified 30 USDT deposit). A draft now always carries the amount
    // Binance itself reports, and nothing at all is drafted for a TxID
    // Binance doesn't know.
    const [dep, pay] = await Promise.all([
      binance.findDepositRaw(id).catch(() => ({ ok: false })),
      binance.findPayTransactionRaw(id).catch(() => ({ ok: false })),
    ]);
    const depositMatch = (dep.matches || [])[0];
    const payMatch = (pay.matches || [])[0];
    if (!depositMatch && !payMatch) {
      return { error: `${id} is NOT found on Binance (deposits or Binance Pay). Do not credit — ask the customer for the right TxID, network, or a screenshot.` };
    }
    const rawAmount = Number(depositMatch ? depositMatch.amount : payMatch.amount);
    if (!Number.isFinite(rawAmount) || rawAmount <= 0) return { error: 'Binance returned an unreadable amount for this TxID.' };
    const amount = Math.round(rawAmount * 100) / 100;
    const network = depositMatch ? depositMatch.network : 'Binance Pay';

    const draftFallback = (reason) => {
      const d = proposeVerifiedCredit(u, amount, id, network);
      return { ...d, auto: false, held_reason: reason, verified_on_binance: { amount, network } };
    };

    const on = (() => { try { return mem.getState('auto_credit', '0') === '1'; } catch (_) { return false; } })();
    if (!on) return draftFallback('auto_credit_off');
    if (amount > AUTO_CREDIT_CAP) return draftFallback(`over_auto_cap_$${AUTO_CREDIT_CAP}`);
    const todayTotal = todayAutoCreditedTotal();
    if (todayTotal + amount > AUTO_CREDIT_DAILY_CAP) return draftFallback(`daily_auto_cap_reached_$${AUTO_CREDIT_DAILY_CAP}`);

    const before = Number(u.balance || 0);
    db.updateBalance(u.telegram_id, amount);
    try {
      db.addTransaction({
        userId: u.telegram_id, type: 'auto_credit_verified_deposit', amount,
        description: `Yamen: verified on-chain deposit ${id}`, refId: id, orderId: null,
      });
    } catch (_) {}
    try {
      db.saveUsedTxid({
        txid: id, userId: u.telegram_id, amount,
        network: depositMatch ? depositMatch.network : 'Binance Pay',
        asset: depositMatch ? depositMatch.coin : (payMatch.currency || 'USDT'),
      });
    } catch (_) {}

    return {
      ok: true, auto: true, txid: id,
      user: u.username ? `@${u.username}` : String(u.telegram_id),
      amount, before, after: before + amount,
      __auto_credit_notify: {
        userId: u.telegram_id, amount, before, after: before + amount, txid: id,
        network: depositMatch ? depositMatch.network : 'Binance Pay',
      },
    };
  },
};

TOOLS.recent_deposits = {
  description: 'Live list of recent deposits received on Binance — "who sent 15.2 today?", "any TRC20 deposit?"',
  input: { days: 'default 2, max 30', network: 'TRX | BSC | TON… optional', amount: 'exact amount, optional' },
  run: async ({ days = 2, network = null, amount = null }) => {
    if (!binance) return { error: 'Binance not available' };
    const r = await binance.listRecentDeposits({
      days: Math.min(30, Math.max(1, Number(days) || 2)), limit: 20,
      network: network || null, amount: amount === null || amount === '' ? null : Number(amount),
    }).catch((e) => ({ ok: false, error: e.message }));
    if (!r.ok) return r;
    return { total: r.total, matched: r.matched, deposits: r.rows.map((d) => ({
      txid: d.txId, amount: Number(d.amount), coin: d.coin, network: d.network,
      status: Number(d.status) === 1 ? 'credited' : 'pending', at: fmtTime(d.insertTime),
    })) };
  },
};

// ── ChatGPT Business bot ─────────────────────────────────────────────────────

TOOLS.cgb_cycle_now = {
  description: 'ChatGPT Business: which cycle a purchase made NOW lands in, start/end, days and price.',
  input: {},
  run: () => {
    const c = require('./cgbCycles');
    const b = c.calculateBestCycle();
    if (!b) return null;
    const f = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return {
      cycle: `${b.cycle.start_day} -> ${b.cycle.end_day}`, renews_at: b.cycle.start_time || '00:00',
      starts: f(b.startDate || new Date()), ends: f(b.endDate), days: b.daysRemaining, cycle_days: b.cycleLength,
      between_cycles: !!b.inGap, monthly_price: c.getMonthlyPrice(), price_now: c.pricePeriod(b, c.getMonthlyPrice()),
      all_cycles: (b.all || []).map((e) => ({ cycle: `${e.cycle.start_day}->${e.cycle.end_day}`, days: e.daysRemaining,
        not_started: !!e.inGap, renews_at: e.cycle.start_time || null })),
    };
  },
};

TOOLS.cgb_renewals = {
  description:
    'ChatGPT Business renewal round: seats ending recently/soon split into renewed & paid, said yes but unpaid, ' +
    'no answer, declined — plus seats to activate now and later. Use for any renewal question.',
  input: {},
  run: () => {
    const rows = raw.prepare(`
      SELECT cs.id, cs.user_id, cs.email, cs.end_date, cs.renew_intent, cs.reminder_count, u.username,
        (SELECT n.id FROM chatgpt_subscriptions n WHERE n.renewed_from = cs.id
           AND COALESCE(n.status,'') IN ('active','pending') LIMIT 1) AS renewed_id
      FROM chatgpt_subscriptions cs LEFT JOIN users u ON u.telegram_id = cs.user_id
      WHERE COALESCE(cs.status,'') IN ('active','pending','expired')
        AND date(cs.end_date) BETWEEN date('now','-12 days') AND date('now','+10 days')
        AND NOT (cs.renewed_from IS NOT NULL AND date(cs.start_date) > date('now','-12 days'))
      ORDER BY date(cs.end_date)`).all();
    const who = (r) => (r.username ? '@' + r.username : String(r.user_id));
    const pick = (f) => rows.filter(f).map((r) => ({ who: who(r), email: r.email, ends: r.end_date, reminded: r.reminder_count || 0 }));
    const toAct = raw.prepare(`SELECT cs.email, cs.start_date, cs.end_date, u.username, cs.user_id FROM chatgpt_subscriptions cs
      LEFT JOIN users u ON u.telegram_id = cs.user_id WHERE cs.status = 'pending' AND date(cs.start_date) <= date('now')`).all();
    const later = raw.prepare(`SELECT cs.email, cs.start_date, cs.end_date, u.username, cs.user_id FROM chatgpt_subscriptions cs
      LEFT JOIN users u ON u.telegram_id = cs.user_id WHERE COALESCE(cs.status,'') IN ('active','pending') AND date(cs.start_date) > date('now')`).all();
    return {
      renewed_paid: pick((r) => r.renewed_id), said_yes_unpaid: pick((r) => !r.renewed_id && r.renew_intent === 'yes'),
      no_answer: pick((r) => !r.renewed_id && !r.renew_intent), declined: pick((r) => !r.renewed_id && r.renew_intent === 'no'),
      activate_now: toAct.map((r) => ({ who: who(r), email: r.email, from: r.start_date, to: r.end_date })),
      activate_later: later.map((r) => ({ who: who(r), email: r.email, from: r.start_date, to: r.end_date })),
    };
  },
};

// ── ChatGPT Business: workspace ⟷ subscriptions, already joined ──────────────
//
// Why this exists: asked "who expired but is still inside?" or "when does X
// end?", the assistant used to stitch raw lists from several tools, which is
// exactly where a fast model slips. This does the joining in code and hands
// over finished facts per email plus ready-made problem lists, so the model
// only has to read and explain.
function cgbLocalDate(d = new Date()) {
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}
function cgbDaysBetween(fromYmd, toYmd) {
  return Math.round((new Date(`${toYmd}T00:00:00`) - new Date(`${fromYmd}T00:00:00`)) / 86400000);
}

async function cgbWorkspaceReport({ email, days } = {}) {
  const window = Math.max(1, Math.min(30, parseInt(days, 10) || 3));
  const today = cgbLocalDate();
  const guard = await require('./cgbGuard').fetchGuardReport();
  const g = guard.ok ? guard.data : null;

  // Latest subscription per email (orders counted), refunded/unpaid shells left out.
  const subRows = raw.prepare(`
    SELECT cs.order_id, cs.user_id, cs.email, cs.start_date, cs.end_date, cs.status, cs.final_price, cs.id,
           u.username, u.first_name
    FROM chatgpt_subscriptions cs LEFT JOIN users u ON u.telegram_id = cs.user_id
    WHERE COALESCE(cs.status, '') NOT IN ('awaiting_payment')
    ORDER BY cs.end_date ASC, cs.id ASC
  `).all();
  const subs = new Map();
  for (const r of subRows) {
    const k = String(r.email || '').trim().toLowerCase();
    if (!k) continue;
    const prev = subs.get(k);
    const orders = (prev?.orders || 0) + 1;
    const keep = !prev || String(r.end_date || '') >= String(prev.end_date || '') ? r : prev.row;
    subs.set(k, { row: keep, orders });
  }

  const members = new Map((g?.members || []).map((m) => [String(m.email).toLowerCase(), m.role || null]));
  const pending = new Set((g?.pending || []).map((e) => String(e).toLowerCase()));
  const wl = new Map((g?.whitelist || []).map((w) => [String(w.email).toLowerCase(), w]));
  const queued = new Map((g?.queue || []).map((q) => [String(q.email).toLowerCase(), q]));
  const all = new Set([...members.keys(), ...pending, ...wl.keys(), ...subs.keys(), ...queued.keys()]);

  const records = [];
  for (const e of all) {
    const s = subs.get(e);
    const r = s?.row;
    const daysLeft = r?.end_date ? cgbDaysBetween(today, r.end_date) : null;
    const role = members.get(e) || null;
    const rec = {
      email: e,
      in_workspace: g ? members.has(e) : null,
      role,
      pending_invite: g ? pending.has(e) : null,
      whitelisted: g ? wl.has(e) : null,
      whitelisted_by: wl.get(e)?.added_by || null,
      queue: queued.get(e) ? { status: queued.get(e).status, error: queued.get(e).last_error || null } : null,
      subscription: r ? {
        order_id: r.order_id, status: r.status, start: r.start_date, end: r.end_date, days_left: daysLeft,
        customer: r.username ? '@' + r.username : (r.first_name || String(r.user_id)), orders: s.orders,
      } : null,
      flags: [],
    };
    const owner = /owner|admin/i.test(role || '');
    const active = r && r.status !== 'cancelled' && daysLeft !== null && daysLeft >= 0;
    if (g) {
      if (rec.in_workspace && r && (daysLeft < 0 || r.status === 'expired')) rec.flags.push('expired_still_inside');
      if (rec.in_workspace && r && r.status === 'cancelled') rec.flags.push('cancelled_still_inside');
      if (active && !rec.in_workspace && !rec.pending_invite) rec.flags.push('paid_not_inside');
      if (rec.pending_invite) rec.flags.push('invited_not_accepted');
      if (rec.in_workspace && !rec.whitelisted && !owner) rec.flags.push('inside_not_whitelisted');
      if (rec.in_workspace && !r && !owner) rec.flags.push('inside_no_subscription');
      if (rec.queue && rec.queue.status === 'failed') rec.flags.push('invite_failed');
    }
    if (active && daysLeft <= window) rec.flags.push('ending_soon');
    records.push(rec);
  }

  if (email) {
    const want = String(email).trim().toLowerCase();
    const rec = records.find((x) => x.email === want) || null;
    const history = subRows.filter((x) => String(x.email || '').toLowerCase() === want)
      .map((x) => ({ order_id: x.order_id, start: x.start_date, end: x.end_date, status: x.status, paid: x.final_price }));
    return {
      today, found: !!rec, record: rec, order_history: history,
      workspace_data: g ? { read_at: g.members_read_at, incomplete: g.last_read_incomplete } : { error: guard.error },
    };
  }

  const pick = (flag, sortBy) => {
    const list = records.filter((x) => x.flags.includes(flag));
    if (sortBy) list.sort(sortBy);
    return { count: list.length, emails: list.slice(0, 40).map((x) => ({
      email: x.email, end: x.subscription?.end || null, days_left: x.subscription?.days_left ?? null,
      customer: x.subscription?.customer || null, order_id: x.subscription?.order_id || null,
      error: x.queue?.error || undefined,
    })) };
  };
  const byDays = (a, b) => (a.subscription?.days_left ?? 1e9) - (b.subscription?.days_left ?? 1e9);
  return {
    today,
    workspace_data: g
      ? { ok: true, read_at: g.members_read_at, incomplete: g.last_read_incomplete, invite_bot_version: g.version,
          members: members.size, pending: pending.size, whitelist: wl.size, queue_waiting: (g.queue || []).filter((q) => q.status === 'waiting').length }
      : { ok: false, error: guard.error, note: 'Only DIGITRUST subscription data is available; workspace columns are unknown.' },
    subscriptions: { emails_with_a_seat: subs.size, active: records.filter((x) => x.subscription && x.subscription.status !== 'cancelled' && x.subscription.days_left >= 0).length },
    problems: {
      expired_still_inside: pick('expired_still_inside', byDays),
      cancelled_still_inside: pick('cancelled_still_inside'),
      paid_not_inside: pick('paid_not_inside', byDays),
      invite_failed: pick('invite_failed'),
      inside_not_whitelisted: pick('inside_not_whitelisted'),
    },
    watch: {
      ending_soon: { window_days: window, ...pick('ending_soon', byDays) },
      invited_not_accepted: pick('invited_not_accepted'),
      inside_no_subscription: pick('inside_no_subscription'),
    },
  };
}

TOOLS.cgb_workspace_report = {
  description:
    'ChatGPT Business — the workspace (from the invite bot: members, pending invites, whitelist, invite queue) ' +
    'already JOINED with DIGITRUST subscriptions (order, start, end, days left, customer). Use it for ANY question ' +
    'about who is in the workspace, when an email started or ends, who expired but is still inside, who paid but ' +
    'is not inside, failed invites, whitelist gaps, or a full report. Pass email to get one person in detail with ' +
    'their order history. Read-only.',
  input: {
    email: 'optional — one email to look up in detail',
    days: 'optional — "ending soon" window in days (default 3)',
  },
  run: (args) => cgbWorkspaceReport(args || {}),
};

// ── The owner's PERSONAL private chats (Telegram Business) ──────────────────
TOOLS.business_inbox = {
  description:
    "The owner's PERSONAL Telegram private chats (people writing to his own account), available once he connects " +
    'the bot in Telegram Business → Chatbots. Lists chats active in the last N hours, who is WAITING for his answer ' +
    'and for how long, the last message, and whether a reply can be sent now (Telegram allows it only within 24h of ' +
    'their last message). Read-only. state: "new" = waiting for him; "replied"; "seen" = he looked and chose not ' +
    'to answer — never report a seen chat as waiting or nag him about it.',
  input: { hours: 'look back this many hours (default 48)' },
  run: ({ hours } = {}) => {
    const r = require('./businessInbox').inbox({ hours });
    for (const c of r.chats || []) {
      try {
        const u = raw.prepare('SELECT username, balance FROM users WHERE telegram_id = ?').get(Number(c.chat_id));
        c.known_customer = !!u;
      } catch (_) { c.known_customer = false; }
    }
    return r;
  },
};
// Who is on the other side of a private chat. In a 1-to-1 chat the chat id IS
// the person's Telegram id, so if they ever used the shop we know them — and a
// reply that ignores "he paid yesterday and his seat isn't active" is the kind
// of mistake that makes an assistant look dumb in front of a customer.
function businessPerson(chatId) {
  try {
    const card = TOOLS.customer_lookup.run({ user_id: String(chatId) });
    if (!card || !card.found) return { known_customer: false };
    const today = new Date().toISOString().slice(0, 10);
    let seats = [];
    try {
      seats = raw.prepare(`SELECT order_id, email, start_date, end_date, status FROM chatgpt_subscriptions
                           WHERE user_id = ? AND COALESCE(status,'') NOT IN ('awaiting_payment','cancelled')
                           ORDER BY end_date DESC LIMIT 3`).all(Number(chatId))
        .map((x) => ({ ...x, days_left: x.end_date ? Math.round((new Date(x.end_date) - new Date(today)) / 86400000) : null }));
    } catch (_) {}
    return { known_customer: true, ...card, recent_orders: (card.recent_orders || []).slice(0, 5), chatgpt_seats: seats };
  } catch (_) {
    return { known_customer: false };
  }
}

// The shop's REAL bot links, so drafts can send people to the shop bot
// without Yamen ever inventing a username.
function shopLinks() {
  const at = (u) => { const v = String(u || '').trim().replace(/^@/, ''); return v ? { username: '@' + v, link: `https://t.me/${v}` } : null; };
  let store = null;
  try { store = at(mem.getState('store_bot_username', '')); } catch (_) {}
  return {
    store_bot: store,
    chatgpt_bot: at(process.env.CHATGPT_BOT_USERNAME),
    support: at(process.env.SUPPORT_BOT_USERNAME),
    store_name: process.env.STORE_NAME || 'DIGITRUST',
  };
}

// A few of the owner's OWN recent private replies, as a style guide only.
function businessStyleSample() {
  try {
    return raw.prepare(`SELECT text FROM business_messages
                        WHERE is_owner = 1 AND length(text) BETWEEN 4 AND 300 AND text NOT LIKE '[%'
                        ORDER BY id DESC LIMIT 12`).all().map((r) => r.text);
  } catch (_) { return []; }
}

TOOLS.business_thread = {
  description:
    'One personal private chat in full (oldest first): "you" = the owner, "them" = the other person. Also returns ' +
    '`person` (if they are a shop customer: balance, rank, recent orders, ChatGPT seats with days left) and ' +
    '`your_recent_replies` (the owner’s own recent private messages — a STYLE guide only, never content to reuse). Read-only.',
  input: { chat: 'chat id or @username from business_inbox', limit: 'max messages (default 40)' },
  run: ({ chat, limit } = {}) => {
    const t = require('./businessInbox').thread({ chat, limit });
    if (t.error) return t;
    return { ...t, person: businessPerson(t.chat_id), your_recent_replies: businessStyleSample(), shop: shopLinks() };
  },
};
TOOLS.propose_business_reply = {
  description:
    'Prepare a reply to send AS THE OWNER in one of his personal private chats. Nothing is sent until he taps ' +
    'the card. Read the thread first; write in the other person\'s language and in the owner\'s voice; never promise ' +
    'money, prices, dates or refunds he has not stated.',
  input: { chat: 'chat id or @username', text: 'the reply', why: 'one short line for the owner: what this answers' },
  run: ({ chat, text, why } = {}) => {
    const bi = require('./businessInbox');
    const id = bi._resolveChat(chat);
    if (!id) return { error: `no private chat found for "${chat}" — use business_inbox first` };
    const body = String(text || '').trim();
    if (!body) return { error: 'empty reply' };
    const conn = bi.connection();
    if (!conn || !conn.enabled) return { error: 'Telegram Business is not connected' };
    const whoLabel = String(chat).startsWith('@') ? chat : `chat ${id}`;
    const action_id = newAction('business_reply', { chatId: id, text: body.slice(0, 4000) });
    return {
      action_id, kind: 'business_reply',
      title: `✉️ رد خاص لـ ${whoLabel}`,
      summary: `${body.slice(0, 600)}${why ? `\n\n📝 ${String(why).slice(0, 160)}` : ''}`,
      confirm: '📨 ابعث باسمي',
    };
  },
};

TOOLS.cgb_find_seat = {
  description: 'Find ChatGPT Business seats by email (or part of it) — who owns it, dates, status, paid.',
  input: { email: 'email or part of it' },
  run: ({ email }) => raw.prepare(`
    SELECT cs.id, cs.user_id, u.username, cs.email, cs.status, cs.start_date, cs.end_date, cs.final_price,
           cs.renew_intent, cs.renewed_from, cs.order_id, o.payment_method
    FROM chatgpt_subscriptions cs LEFT JOIN users u ON u.telegram_id = cs.user_id
    LEFT JOIN orders o ON o.id = cs.order_id
    WHERE cs.email LIKE ? COLLATE NOCASE ORDER BY cs.id DESC LIMIT 10`).all(`%${String(email || '').trim()}%`),
};

TOOLS.order_lookup = {
  description: 'One order by id: product, customer, amount, method, status, dates, TxID, delivery.',
  input: { order_id: 'order number' },
  run: ({ order_id }) => {
    const o = raw.prepare(`SELECT o.*, p.title, u.username FROM orders o LEFT JOIN products p ON p.id = o.product_id
      LEFT JOIN users u ON u.telegram_id = o.user_id WHERE o.id = ?`).get(Number(order_id));
    if (!o) return { found: false };
    const out = { ...o, title: clean(o.title) };
    if (out.delivered_content) out.delivered_content = String(out.delivered_content).replace(/<[^>]+>/g, '').slice(0, 400);
    return out;
  },
};

// ── Stock: proposed by Sahbi, added only when the owner taps "Add" ──────────
//
// The same pattern as propose_reply. The model never writes stock: it turns
// whatever the owner pasted into a clean list of accounts and a draft, and the
// app shows the draft with a button. Only that button — the owner's tap —
// calls stockUpload. A customer message cannot trigger it.

const STOCK_DRAFTS = new Map(); // id → { productId, accounts, supplier, unitCost, at }
const STOCK_TTL = 60 * 60 * 1000;

const norm = (t) => clean(t).toLowerCase().replace(/[^a-z0-9\u0600-\u06ff]+/g, '');

function findProducts(q) {
  const want = norm(q);
  if (!want) return [];
  const all = raw.prepare(`SELECT id, title, price, stock_quantity, delivery_type, unlimited_stock,
      is_chatgpt_business, COALESCE(is_active,1) AS is_active FROM products`).all();
  return all.map((p) => {
    const t = norm(p.title);
    const score = t === want ? 100 : t.startsWith(want) ? 80 : t.includes(want) ? 60
      : want.split(/\s+/).every((w) => t.includes(w)) ? 40 : 0;
    return { ...p, title: clean(p.title), score };
  }).filter((p) => p.score > 0).sort((a, b) => b.score - a.score || b.is_active - a.is_active).slice(0, 8);
}

TOOLS.find_product = {
  description: 'Find products by (part of) their name, tolerant of spacing/case: "ilovepdf", "I LOVE PDF", "notion".',
  input: { name: 'product name or part of it' },
  run: ({ name }) => findProducts(name).map((p) => ({
    id: p.id, title: p.title, price: p.price, in_stock: raw.prepare(
      `SELECT COUNT(*) AS n FROM product_items WHERE product_id = ? AND status = 'available'`).get(p.id).n,
    active: !!p.is_active,
    kind: p.is_chatgpt_business ? 'chatgpt_business' : p.unlimited_stock ? 'unlimited' : p.delivery_type === 'manual' ? 'manual' : 'stock',
  })),
};

/** Split pasted text into accounts. `mode` is decided by the model, or 'auto'. */
function splitAccounts(text, mode = 'auto', dropPattern = '') {
  let t = String(text || '').replace(/\r/g, '');
  let parts;
  const m = String(mode || 'auto').toLowerCase();
  if (m === 'aymen' || (m === 'auto' && /AYMEN/.test(t))) parts = t.split('AYMEN');
  else if (m === 'blank_lines' || (m === 'auto' && /\n\s*\n/.test(t) && t.split(/\n\s*\n/).some((b) => b.trim().includes('\n')))) parts = t.split(/\n\s*\n+/);
  else if (m.startsWith('sep:')) parts = t.split(mode.slice(4));
  else parts = t.split('\n');
  let drop = null;
  try { drop = dropPattern ? new RegExp(dropPattern, 'i') : null; } catch (_) {}
  // In auto mode a line with none of the marks of an account (@ : | / digits)
  // is the owner's own words ("add these to Notion") and is left out.
  const looksLikeAccount = (x) => /[@:|\/\\]|\d{3,}|https?:/.test(x);
  // Inside a multi-line account, leading lines with no account marks are the
  // owner's words ("notion:", "add these") glued to the first block.
  const isHeader = (l) => !looksLikeAccount(l) || /^[^@|\/\\\d]{1,40}:\s*$/.test(l.trim());
  const trimLead = (x) => {
    const lines = x.split('\n');
    while (lines.length > 1 && isHeader(lines[0])) lines.shift();
    return lines.join('\n').trim();
  };
  return parts.map((x) => x.trim()).filter(Boolean)
    .map((x) => (m === 'auto' || m === 'blank_lines' ? trimLead(x) : x))
    // "1. ", "2) ", "- ", "• " in front of an account is the list, not the account.
    .map((x) => x.replace(/^\s*(?:\d{1,4}\s*[.)\-:]\s+|[-•*▪➤►]\s+)/, ''))
    // The owner's own words typed after the last account on the same line:
    // Arabic text after a gap, in stock that is otherwise Latin.
    .map((x) => (/[\u0600-\u06FF]/.test(x) && !/^[^\n]*[\u0600-\u06FF]/.test(x.split(/\s{2,}|\s(?=\S*[\u0600-\u06FF])/)[0])
      ? x.replace(/\s+\S*[\u0600-\u06FF][\s\S]*$/, '').trim() : x))
    .map((x) => x.split('\n').filter((l) => !(drop && drop.test(l))).join('\n').trim())
    .filter(Boolean)
    .filter((x) => m !== 'auto' || (looksLikeAccount(x) && !(x.indexOf('\n') < 0 && isHeader(x))));
}

TOOLS.propose_stock = {
  description:
    'Prepare accounts to ADD TO STOCK of one product. It does not add anything: the owner sees a preview ' +
    'card and taps Add. Either pass the accounts yourself, joined with the word AYMEN between each, or ' +
    'let the server split the owner\'s own pasted message with split_by (best for long lists — no need to ' +
    'repeat them). Always find_product first to get the id. Duplicates already in stock are skipped.',
  input: {
    product_id: 'product id (from find_product)',
    accounts: 'optional: the accounts joined with AYMEN between each one',
    split_by: 'optional, when accounts is empty: auto | lines | blank_lines | aymen | sep:<text> — applied to the owner\'s latest message',
    drop_lines_matching: 'optional regex of lines to leave out (e.g. headers)',
    supplier: 'optional supplier name', unit_cost: 'optional cost per account in $',
  },
  run: ({ product_id, accounts, split_by, drop_lines_matching, supplier, unit_cost, __owner_text }) => {
    const p = raw.prepare('SELECT * FROM products WHERE id = ?').get(Number(product_id));
    if (!p) return { error: 'product not found — use find_product' };
    if (p.is_chatgpt_business || p.unlimited_stock || p.delivery_type === 'manual') {
      return { error: `"${clean(p.title)}" does not use stock items (${p.is_chatgpt_business ? 'ChatGPT Business' : p.unlimited_stock ? 'unlimited' : 'manual delivery'})` };
    }
    let list = accounts && String(accounts).trim()
      ? String(accounts).split('AYMEN').map((x) => x.trim()).filter(Boolean)
      : splitAccounts(__owner_text || '', split_by || 'auto', drop_lines_matching);
    if (!list.length) return { error: 'no accounts found in the message — ask the owner to paste them' };

    const seen = new Set();
    const inBatch = [];
    list = list.filter((a) => { const k = a.toLowerCase(); if (seen.has(k)) { inBatch.push(a); return false; } seen.add(k); return true; });
    const exists = raw.prepare('SELECT 1 FROM product_items WHERE product_id = ? AND raw_content = ? LIMIT 1');
    const already = list.filter((a) => exists.get(p.id, a));
    list = list.filter((a) => !already.includes(a));
    if (!list.length) return { error: 'every account is already in stock', duplicates: already.length };

    // Do the accounts all look alike? One that does not is usually a split in
    // the wrong place, or a note that slipped in — worth a question first.
    const shape = (a) => [
      (a.match(/@/g) || []).length, (a.match(/:/g) || []).length, (a.match(/\|/g) || []).length,
      (a.match(/https?:/g) || []).length, a.split('\n').length,
    ].join('/');
    const counts = {};
    list.forEach((a) => { const k = shape(a); counts[k] = (counts[k] || 0) + 1; });
    const common = Object.entries(counts).sort((x, y) => y[1] - x[1])[0][0];
    const odd = list.map((a, i) => ({ i: i + 1, a })).filter((x) => shape(x.a) !== common || /[\u0600-\u06FF]/.test(x.a));

    let remembered = [];
    try {
      const words = clean(p.title).split(/\s+/).filter((w) => w.length > 2).slice(0, 2);
      remembered = words.flatMap((w) => mem.searchMemory(w, 5))
        .filter((n) => /format|stock|مخزون|حساب|account/i.test(n.text + n.category)).map((n) => n.text);
      remembered = [...new Set(remembered)].slice(0, 3);
    } catch (_) {}

    const id = `stk_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const cost = unit_cost !== undefined && unit_cost !== '' && Number.isFinite(Number(unit_cost)) ? Number(unit_cost) : null;
    STOCK_DRAFTS.set(id, { productId: p.id, accounts: list, supplier: supplier || null, unitCost: cost, at: Date.now() });
    for (const [k, v] of STOCK_DRAFTS) if (Date.now() - v.at > STOCK_TTL) STOCK_DRAFTS.delete(k);
    const inStock = raw.prepare(`SELECT COUNT(*) AS n FROM product_items WHERE product_id = ? AND status='available'`).get(p.id).n;
    return {
      stock_draft_id: id, product_id: p.id, product: clean(p.title), count: list.length,
      in_stock_now: inStock, after: inStock + list.length,
      preview: list.slice(0, 3).map((a) => a.slice(0, 320)), last: list.length > 3 ? list[list.length - 1].slice(0, 320) : null,
      skipped_duplicates: already.length + inBatch.length, supplier: supplier || null, unit_cost: cost,
      first_account_full: list[0].slice(0, 400),
      odd_accounts: odd.slice(0, 5).map((x) => ({ n: x.i, text: x.a.slice(0, 200) })),
      remembered_format: remembered,
      note: odd.length
        ? `${odd.length} account(s) do not look like the others — check them with the owner before they tap Add.`
        : 'All accounts look alike. Waiting for the owner to tap Add in the app.',
    };
  },
};

function takeStockDraft(id) {
  const d = STOCK_DRAFTS.get(id);
  if (!d || Date.now() - d.at > STOCK_TTL) return null;
  STOCK_DRAFTS.delete(id);
  return d;
}

// ── Customer media: see the photos, hear the voice notes ─────────────────────

let SUPPORT_BOT = null;
const supportBot = () => {
  if (SUPPORT_BOT) return SUPPORT_BOT;
  try { const b = require('../support-bot'); if (b && b.getFileLink) SUPPORT_BOT = b; } catch (_) {}
  return SUPPORT_BOT;
};

TOOLS.view_customer_media = {
  description:
    'Look at the photos (screenshots, payment proofs, error screens) and listen to the voice notes a customer ' +
    'sent in support. Returns the images for you to see and voice notes as text. Default: their latest ones.',
  input: { user_id: 'customer telegram id', count: 'how many recent items, default 3, max 6' },
  run: async ({ user_id, count = 3 }) => {
    const bot = supportBot();
    if (!bot) return { error: 'support bot not available' };
    const n = Math.min(6, Math.max(1, Number(count) || 3));
    const rows = raw.prepare(`SELECT id, direction, media_type, file_id, content, created_at FROM support_messages
      WHERE user_id = ? AND file_id IS NOT NULL AND media_type IN ('photo','document','voice')
      ORDER BY id DESC LIMIT ?`).all(Number(user_id), n).reverse();
    if (!rows.length) return { found: 0, note: 'no photos or voice notes from this customer' };
    const out = { found: rows.length, items: [], __images: [] };
    for (const r of rows) {
      try {
        const link = await bot.getFileLink(r.file_id);
        const res = await fetch(link);
        const buf = Buffer.from(await res.arrayBuffer());
        const type = String(res.headers.get('content-type') || '');
        const meta = { from: r.direction === 'in' ? 'customer' : 'support', at: r.created_at, caption: r.content || null };
        if (r.media_type === 'voice') {
          const t = await transcribeBuffer(buf, 'audio/ogg');
          out.items.push({ ...meta, kind: 'voice', text: t || '(could not transcribe)' });
        } else if (r.media_type === 'photo' || /^image\//.test(type) || /\.(jpe?g|png|webp)$/i.test(link)) {
          if (buf.length > 6 * 1024 * 1024) { out.items.push({ ...meta, kind: 'image', note: 'too large' }); continue; }
          const mime = /png/i.test(link) ? 'image/png' : /webp/i.test(link) ? 'image/webp' : 'image/jpeg';
          out.__images.push({ label: `${meta.from} · ${meta.at}${meta.caption ? ' · ' + meta.caption : ''}`, url: `data:${mime};base64,${buf.toString('base64')}` });
          out.items.push({ ...meta, kind: 'image', shown: out.__images.length });
        } else {
          out.items.push({ ...meta, kind: 'file', note: 'not an image — cannot view' });
        }
      } catch (e) {
        out.items.push({ at: r.created_at, error: e.message });
      }
    }
    return out;
  },
};

async function transcribeBuffer(buf, type) {
  if (!process.env.OPENAI_API_KEY) return '';
  for (const model of ['gpt-4o-mini-transcribe', 'whisper-1']) {
    try {
      const form = new FormData();
      form.append('file', new Blob([buf], { type }), 'voice.ogg');
      form.append('model', model);
      form.append('prompt', 'Tunisian Arabic, French, English. Customer of a digital accounts shop.');
      const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: form });
      if (r.status === 404) continue;
      const j = await r.json();
      return String(j.text || '').trim();
    } catch (_) {}
  }
  return '';
}

// ── More actions the owner confirms with one tap ─────────────────────────────
// Same rule as stock: the model prepares, the app shows a card, only the
// owner's tap performs it (POST /agent/action/approve).

const ACTIONS = new Map(); // id → { kind, payload, at }
const ACTION_TTL = 60 * 60 * 1000;
function newAction(kind, payload) {
  const id = `act_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  ACTIONS.set(id, { kind, payload, at: Date.now() });
  for (const [k, v] of ACTIONS) if (Date.now() - v.at > ACTION_TTL) ACTIONS.delete(k);
  return id;
}
function takeAction(id) {
  const a = ACTIONS.get(id);
  if (!a || Date.now() - a.at > ACTION_TTL) return null;
  ACTIONS.delete(id);
  return a;
}


// ── system_guide (V132) ─────────────────────────────────────────────────────
// How the owner's whole system works, end to end, so Yamen reasons about the
// real flow instead of guessing. Read on demand (not sent with every message).
const SYSTEM_GUIDE = {
  overview:
    'DIGITRUST = one Node.js service (Railway) running several Telegram bots on one SQLite DB: ' +
    '(1) the STORE bot — products, wallet, orders, deliveries, referral, /admin panel; ' +
    '(2) the SUPPORT bot — customers write here; staff replies go out with a "📩 Support" header; ✓/✓✓ read receipts; ' +
    '(3) the CHATGPT BUSINESS bot — sells ChatGPT Business seats; (4) the CANVA bot; ' +
    '(5) Yamen\'s own private bot, connected to the owner\'s personal Telegram through Telegram Business (private chats with people only; no groups/channels/bots; can reply only within 24h of their last message). ' +
    'A SEPARATE service, "Business Guard" (Python + Playwright, Postgres, its own Telegram bot), drives the ChatGPT Business admin page: it buys seats, sends invites and removes strangers. Resellers use a REST API (api-reseller / api-public).',
  deposits:
    'Wallet top-ups (USDT on BEP20, TRC20, TON; also Binance Pay and CryptoBot). The customer picks a network and an amount; the bot RESERVES a unique amount: the base plus cents (e.g. 29 → 29.37; rarely 3 decimals like 29.137). The reservation lives ~30–60 min. ' +
    'TON needs the MEMO too (shared Binance address). ' +
    'REAL-TIME SYNC: every ~40 s, while reservations are open, Binance deposit history is read and a transfer matching a reserved amount is credited to that reservation\'s owner automatically — no TxID needed. This covers TON (the wallet shows a different hash than Binance records, by design) and OFF-CHAIN / internal Binance transfers ("Off-chain transfer …" ids, no blockchain hash). ' +
    'The TxID path still exists: the customer pastes a TxID → verified on Binance → must match an open reservation that is HIS, and must not predate it (else → manual review queue, never auto-credit). A deposit older than deposit_max_age_minutes (15) with no reservation is refused (harvested TxIDs). Every credited Binance id is stored in used_txids: nothing is credited twice. ' +
    'The extra cents are credited in full. Unmatched deposits land in the Deposit Review queue for the owner.',
  money_rules:
    'Yamen never moves money silently. propose_credit / propose_debit make a card the owner taps (✅). Without a TxID the limit is $20; with a TxID Binance confirms (and unused) the amount comes from Binance and the limit is AGENT_VERIFIED_CREDIT_CAP ($500). A confirmed TxID is stored as used. ' +
    'auto_credit_verified_deposit may credit small verified deposits alone ONLY if the owner turned auto_credit on. ' +
    'Identical credits are refused while one waits for a tap, or if the same amount was added to that customer in the last hour (again:true only when the owner says it is separate). ' +
    'After the owner taps ✅ you receive "[happened since your last reply …]": those are DONE — messages must say the balance WAS added.',
  chatgpt:
    'ChatGPT Business seat flow: customer buys in the ChatGPT bot/store → gives an email → the order is PENDING (red card, "needs activation") → DIGITRUST sends the email to Business Guard (GUARD_AUTO_INVITE_URL) → the Guard queues it; every 7 minutes (a batch) it buys ONE NEW Standard seat per email on chatgpt.com/admin (card charged, ~$10/mo prorated), sends the invites, verifies, whitelists → it calls back DIGITRUST (/webhook/cgb-guard-status) → the seat is activated and the customer notified. ' +
    'Billing cycles (cgbCycles): seats belong to monthly cycles; renewals and "new seats since" are computed per cycle; the owner can set a manual cycle end. ' +
    'Seats with a future start_date wait for that date.',
  guard:
    'Business Guard details: one browser per panel (Panel 26 today). DRY_RUN=true means it reports strangers but removes nobody. A paid seat is recorded per email and NEVER bought twice (retries reuse it). If an invite "fails" but the email shows up in Users/Pending, it is whitelisted and DIGITRUST told success. Unknown members get an alert with Allow / Delete / Ignore. A frozen browser is killed and relaunched after 20 min. After every restart the queue waits 3 min (time for 🧹 Clear old). Its /start is a dashboard: queue, today\'s invites/seats/failures, last batch.',
  support:
    'Support bot: every customer message is stored (support_messages). Staff replies from the bot or from Yamen\'s app (💬 رسائل الدعم) go out identically. Yamen can suggest (✨) or take a case ("يمان يتكفّل"): read the thread, check orders/TxIDs/photos, then prepare the reply and any credit as cards. Customer-facing text is ENGLISH unless the owner says otherwise.',
  private_chats:
    'The owner\'s personal chats reach Yamen through Telegram Business. Order in the app: 🔴 unread → 🟢 answered → 🟡 read but not answered. Opening a chat in the app marks it read (app only — the other person sees no ✓✓). Yamen never sends there without the owner pressing send.',
  alerts:
    'Watch rules run in the background (waiting customers, pending seats, stock running out, refunds abuse, no sales for hours…). Alerts are short: similar items collapse into one line. Morning brief ~09:00, evening wrap, and a nightly learning pass (23:30) that reads the day and saves rules.',
};

TOOLS.system_guide = {
  description:
    'How the owner\'s whole system works end to end (store, deposits & real-time sync, TON/off-chain, money rules, ' +
    'ChatGPT Business flow & cycles, Business Guard, support, private chats, alerts). Read the relevant topic before ' +
    'answering or acting on anything about how the system behaves — never guess the flow.',
  input: { topic: 'one of: overview, deposits, money_rules, chatgpt, guard, support, private_chats, alerts, all' },
  run: ({ topic }) => {
    const t = String(topic || 'overview').toLowerCase().trim();
    if (t === 'all') return { guide: SYSTEM_GUIDE };
    return SYSTEM_GUIDE[t] ? { topic: t, guide: SYSTEM_GUIDE[t] } : { topics: Object.keys(SYSTEM_GUIDE), guide: SYSTEM_GUIDE.overview };
  },
};

TOOLS.propose_stock_count = {
  description:
    'For products filled BY HAND (manual delivery / counter stock, e.g. "Claude Team Standard"): prepare adding N ' +
    'to the available quantity. The owner confirms with a tap. For products whose stock is a list of accounts, ' +
    'use propose_stock instead.',
  input: { product_id: 'product id (find_product)', quantity: 'how many to add, 1-1000' },
  run: ({ product_id, quantity }) => {
    const p = raw.prepare('SELECT * FROM products WHERE id = ?').get(Number(product_id));
    if (!p) return { error: 'product not found — use find_product' };
    const n = parseInt(quantity, 10);
    if (!Number.isFinite(n) || n < 1 || n > 1000) return { error: 'quantity must be 1-1000' };
    const items = raw.prepare(`SELECT COUNT(*) AS n FROM product_items WHERE product_id = ?`).get(p.id).n;
    if (items > 0 && p.delivery_type !== 'manual') {
      return { error: `"${clean(p.title)}" is sold from a list of accounts — paste the accounts and use propose_stock` };
    }
    const now = Number(p.stock_quantity || 0);
    const id = newAction('stock_count', { productId: p.id, n });
    return { action_id: id, kind: 'stock_count', title: `📦 ${clean(p.title)}`,
      summary: `➕ ${n} (manual fill) · stock ${now} → ${now + n}`, confirm: `➕ زيد ${n}` };
  },
};

// Products, posts, broadcasts and scheduling live in the studio.
require('./agentStudio').register(TOOLS, { newAction });

/** Perform a confirmed action. Called only from the owner's tap. */
async function performAction(a, bot) {
  if (a.kind === 'stock_count') {
    const db2 = require('../database/queries');
    const { productId, n } = a.payload;
    const was = Number(db2.getProduct(productId)?.stock_quantity || 0);
    const r = db2.adjustStockQuantity(productId, n);
    const out = { ok: true, message: `✅ تزادو ${n} — المخزون توا ${r.after}` };
    if (bot) {
      try { await require('./stockAlerts').evaluateStock(bot, productId); } catch (_) {}
      if (was === 0 && r.after > 0) {
        try {
          const k = await require('../handlers/buy').notifyBackInStockSubscribers(bot, productId);
          if (k) out.message += ` · ${k} يستناو تعلمو`;
        } catch (_) {}
      }
    }
    return out;
  }
  if (a.kind === 'credit') {
    const { userId, amount, reason, txid, network } = a.payload;
    // Two drafts for the same deposit (it happened on 30-09: a $0.01 and a
    // $20 one) must never both go through.
    if (txid && db.isTxidUsed(txid)) return { ok: false, error: `هذا الـTxID تزاد قبل — ما زدتش مرة ثانية.` };
    const before = Number((raw.prepare('SELECT balance FROM users WHERE telegram_id = ?').get(userId) || {}).balance || 0);
    db.updateBalance(userId, amount);
    if (txid) {
      try { db.saveUsedTxid({ txid, userId, amount, network: network || '', asset: 'USDT' }); } catch (_) {}
    }
    try { db.addTransaction({ userId, type: 'admin_credit', amount, description: reason, refId: `yamen_${Date.now()}`, orderId: null }); } catch (_) {}
    // Let the customer know, quietly.
    if (bot) {
      try { await bot.sendMessage(userId, `💰 <b>$${amount.toFixed(2)}</b> was added to your balance.
${reason ? '📝 ' + reason : ''}`, { parse_mode: 'HTML' }); } catch (_) {}
    }
    return { ok: true, message: `✅ تزادو $${amount.toFixed(2)} لرصيد الحريف — من ${before.toFixed(2)} لـ ${(before + amount).toFixed(2)}` };
  }
  if (a.kind === 'business_reply') {
    const r = await require('./businessInbox').sendReply(a.payload.chatId, a.payload.text);
    return r.ok ? { ok: true, message: '✅ تبعث الرد باسمك.' } : { ok: false, error: r.error };
  }
  if (a.kind === 'debit') {
    const { userId, amount, reason } = a.payload;
    const before = Number((raw.prepare('SELECT balance FROM users WHERE telegram_id = ?').get(userId) || {}).balance || 0);
    if (amount > before) return { ok: false, error: `balance is now only $${before.toFixed(2)} — deducting $${amount.toFixed(2)} would go negative. Not applied; check with the owner.` };
    db.updateBalance(userId, -amount);
    try { db.addTransaction({ userId, type: 'admin_debit', amount: -amount, description: reason, refId: `yamen_${Date.now()}`, orderId: null }); } catch (_) {}
    if (bot) {
      try { await bot.sendMessage(userId, `➖ <b>$${amount.toFixed(2)}</b> was deducted from your balance.
${reason ? '📝 ' + reason : ''}`, { parse_mode: 'HTML' }); } catch (_) {}
    }
    return { ok: true, message: `✅ تنقّص $${amount.toFixed(2)} من رصيد الحريف — من ${before.toFixed(2)} لـ ${(before - amount).toFixed(2)}` };
  }

  const r = await require('./agentStudio').perform(a, bot);
  if (r) return r;
  return { ok: false, error: 'unknown action' };
}

// ── Add balance to a customer (capped, owner taps to confirm) ────────────────

const CREDIT_CAP = Number(process.env.AGENT_CREDIT_CAP || 20); // max Yamen may propose at once

// A credit backed by a deposit Binance itself confirmed may go above the
// normal cap (the owner still taps to confirm): the 30-09 transcript had Yamen
// split a verified 30 USDT deposit into "$20 now, the other $10 from /admin".
const VERIFIED_CREDIT_CAP = Number(process.env.AGENT_VERIFIED_CREDIT_CAP || 500);

function proposeVerifiedCredit(u, amount, txid, network) {
  if (amount > VERIFIED_CREDIT_CAP) {
    return { error: `verified deposit of $${amount.toFixed(2)} is above $${VERIFIED_CREDIT_CAP} — the owner must add it from /admin` };
  }
  const reason = `Verified deposit ${String(txid).slice(0, 24)} · ${network}`;
  const id = newAction('credit', { userId: u.telegram_id, amount: Number(amount.toFixed(2)), reason, txid: String(txid), network });
  const bal = Number(u.balance || 0);
  return {
    action_id: id, kind: 'credit',
    title: `💰 ${u.username ? '@' + u.username : u.telegram_id}`,
    summary: `➕ $${amount.toFixed(2)} → balance ${bal.toFixed(2)} → ${(bal + amount).toFixed(2)}\n✅ Binance: ${amount.toFixed(2)} USDT · ${network}\n🔗 ${String(txid).slice(0, 30)}`,
    confirm: `💰 زيد $${amount.toFixed(2)}`,
  };
}

function duplicateCredit(userId, amount, txid) {
  const amt = Number(String(amount || '').replace(/[$,\s]/g, ''));
  const tx = String(txid || '').trim();
  for (const [, a] of ACTIONS) {
    if (a.kind !== 'credit' || Number(a.payload.userId) !== Number(userId)) continue;
    if ((tx && a.payload.txid === tx) || (!tx && Number.isFinite(amt) && Math.abs(Number(a.payload.amount) - amt) < 0.005)) {
      return `a credit draft for this customer${tx ? ' and TxID' : ` and $${amt.toFixed(2)}`} is ALREADY waiting for the owner's tap — do not make another; point him to it.`;
    }
  }
  if (!tx && Number.isFinite(amt) && amt > 0) {
    const r = raw.prepare(`SELECT created_at FROM transactions WHERE user_id = ? AND type IN ('admin_credit','deposit')
                           AND ABS(amount - ?) < 0.005 AND created_at >= datetime('now','-60 minutes')
                           ORDER BY id DESC LIMIT 1`).get(Number(userId), amt);
    if (r) return `$${amt.toFixed(2)} was ALREADY added to this customer at ${r.created_at} UTC (confirmed). Do not add it again; if a message is needed, say it was added.`;
  }
  return null;
}

TOOLS.propose_credit = {
  description:
    `Prepare adding balance to a customer's wallet — a refund, compensation, a bonus. Yamen may propose up to ` +
    `$${CREDIT_CAP}; more than that, tell the owner to do it from /admin. Nothing is credited until the owner taps. ` +
    `Find the customer by @username or numeric id first (customer_lookup).`,
  input: {
    user: 'customer @username or telegram id',
    amount: 'dollars to add (positive), max ' + CREDIT_CAP,
    reason: 'short reason shown in the wallet history and to the owner',
    txid: 'optional — the TxID when this credits a deposit. With a TxID Binance confirms (and not used yet), the ' +
          'amount is taken from Binance and the cap is $' + VERIFIED_CREDIT_CAP + ' instead of $' + CREDIT_CAP + '. ' +
          'Use this whenever the owner tells you to add a deposit you found — never split it.',
    again: 'optional true — ONLY when the owner explicitly says this is an additional, separate credit ' +
           '(the tool refuses a credit identical to one waiting for his tap or added in the last hour)',
  },
  run: async ({ user, amount, reason, txid, again }) => {
    const key = String(user || '').trim().replace(/^@/, '');
    let u = /^\d+$/.test(key) ? raw.prepare('SELECT * FROM users WHERE telegram_id = ?').get(Number(key))
      : raw.prepare('SELECT * FROM users WHERE lower(username) = lower(?)').get(key);
    if (!u) return { error: `customer "${user}" not found` };
    // Never the same credit twice (V132, @alex109990 on 30-09: two credits
    // confirmed, then drafted again). Blocked when an identical draft is
    // already waiting for the owner's tap, or the same amount was credited
    // to this customer in the last hour — unless the owner explicitly says
    // it's an additional, separate credit (again: true).
    const dup = duplicateCredit(u.telegram_id, amount, txid);
    if (dup && !again) return { error: dup };
    const tx = String(txid || '').trim();
    if (tx) {
      if (db.isTxidUsed(tx)) return { error: `${tx} was already used/credited in the shop — not proposing it again.` };
      if (!binance) return { error: 'Binance is not configured — cannot verify this TxID.' };
      const [dep, pay] = await Promise.all([
        binance.findDepositRaw(tx).catch(() => ({ ok: false })),
        binance.findPayTransactionRaw(tx).catch(() => ({ ok: false })),
      ]);
      const m = (dep.matches || [])[0] || (pay.matches || [])[0];
      if (!m) return { error: `${tx} is not found on Binance — not proposing a credit for it.` };
      const binAmt = Math.round(Number(m.amount) * 100) / 100;
      return proposeVerifiedCredit(u, binAmt, tx, (dep.matches || [])[0] ? m.network : 'Binance Pay');
    }
    const amt = Number(String(amount).replace(/[$,\s]/g, ''));
    if (!Number.isFinite(amt) || amt <= 0) return { error: 'amount must be a positive number' };
    if (amt > CREDIT_CAP) return { error: `over the $${CREDIT_CAP} limit without a TxID — if this is a deposit, call again with its txid; otherwise the owner adds it from /admin. Never split an amount.` };
    const id = newAction('credit', { userId: u.telegram_id, amount: Number(amt.toFixed(2)), reason: String(reason || 'Added by Yamen').slice(0, 120) });
    return {
      action_id: id, kind: 'credit',
      title: `💰 ${u.username ? '@' + u.username : u.telegram_id}`,
      summary: `➕ $${amt.toFixed(2)} → balance ${Number(u.balance || 0).toFixed(2)} → ${(Number(u.balance || 0) + amt).toFixed(2)}` +
        (reason ? `\n📝 ${String(reason).slice(0, 80)}` : ''),
      confirm: `💰 زيد $${amt.toFixed(2)}`,
    };
  },
};

TOOLS.propose_debit = {
  description:
    `Prepare DEDUCTING balance from a customer's wallet — a correction, a chargeback, balance given by mistake. ` +
    `Same cap as propose_credit ($${CREDIT_CAP}), same owner tap to confirm. Refuses if it would take the ` +
    `balance below $0 — say so and let the owner decide instead of silently clamping it.`,
  input: {
    user: 'customer @username or telegram id',
    amount: 'dollars to remove (positive number), max ' + CREDIT_CAP,
    reason: 'short reason shown in the wallet history and to the owner',
  },
  run: ({ user, amount, reason }) => {
    const amt = Number(String(amount).replace(/[$,\s]/g, ''));
    if (!Number.isFinite(amt) || amt <= 0) return { error: 'amount must be a positive number' };
    if (amt > CREDIT_CAP) return { error: `over the $${CREDIT_CAP} limit — amounts above $${CREDIT_CAP} must be removed by the owner in /admin` };
    const key = String(user || '').trim().replace(/^@/, '');
    let u = /^\d+$/.test(key) ? raw.prepare('SELECT * FROM users WHERE telegram_id = ?').get(Number(key))
      : raw.prepare('SELECT * FROM users WHERE lower(username) = lower(?)').get(key);
    if (!u) return { error: `customer "${user}" not found` };
    const before = Number(u.balance || 0);
    if (amt > before) return { error: `${u.username ? '@' + u.username : u.telegram_id} only has $${before.toFixed(2)} — deducting $${amt.toFixed(2)} would go negative. Confirm with the owner before doing this any other way.` };
    const id = newAction('debit', { userId: u.telegram_id, amount: Number(amt.toFixed(2)), reason: String(reason || 'Removed by Yamen').slice(0, 120) });
    return {
      action_id: id, kind: 'debit',
      title: `💰 ${u.username ? '@' + u.username : u.telegram_id}`,
      summary: `➖ $${amt.toFixed(2)} → balance ${before.toFixed(2)} → ${(before - amt).toFixed(2)}` +
        (reason ? `\n📝 ${String(reason).slice(0, 80)}` : ''),
      confirm: `➖ نقّص $${amt.toFixed(2)}`,
    };
  },
};

// ── Web search (fallback for non-OpenAI-Responses paths) ─────────────────────
// OpenAI's Responses path has a native web_search tool. This gives the same
// ability to the Anthropic and gpt-4 paths, with no API key: a DuckDuckGo
// search, and a reader that pulls the readable text from one result page.

const axios2 = require('axios');
const stripTags = (h) => String(h || '')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
  .replace(/\s+/g, ' ').trim();

TOOLS.web_search = {
  description:
    'Search the web when the answer is not in the shop data or your knowledge — how to activate a service, ' +
    'a current error, steps for a product, whether a site is down. Returns titles, links and snippets. ' +
    'Follow with web_read on the best link for detail.',
  input: { query: 'what to search for' },
  run: async ({ query }) => {
    const q = String(query || '').trim();
    if (!q) return { error: 'empty query' };
    const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9' };

    // 1) DuckDuckGo's JSON "instant answer" API (often enough, and key-free).
    try {
      const j = (await axios2.get('https://api.duckduckgo.com/', {
        params: { q, format: 'json', no_html: 1, skip_disambig: 1 }, timeout: 10000, headers: UA })).data;
      const res = [];
      if (j.AbstractText) res.push({ title: j.Heading || q, url: j.AbstractURL || '', snippet: j.AbstractText });
      for (const t of (j.RelatedTopics || [])) {
        const items = t.Topics || [t];
        for (const it of items) if (it.Text && it.FirstURL && res.length < 6) res.push({ title: it.Text.slice(0, 120), url: it.FirstURL, snippet: it.Text });
      }
      if (res.length) return { query: q, results: res.slice(0, 6), source: 'duckduckgo' };
    } catch (_) {}

    // 2) DuckDuckGo Lite HTML.
    for (const base of ['https://lite.duckduckgo.com/lite/', 'https://html.duckduckgo.com/html/']) {
      try {
        const html = (await axios2.get(base, { params: { q }, timeout: 12000, headers: UA })).data;
        const out = [];
        const re = /<a[^>]*class="[^"]*result(?:__a|-link)[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
        let m;
        while ((m = re.exec(html)) && out.length < 6) {
          let link = m[1]; const dd = link.match(/uddg=([^&]+)/);
          if (dd) { try { link = decodeURIComponent(dd[1]); } catch (_) {} }
          if (/^https?:/.test(link)) out.push({ title: stripTags(m[2]).slice(0, 140), url: link });
        }
        const snips = []; const sre = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
        while ((m = sre.exec(html)) && snips.length < 6) snips.push(stripTags(m[1]).slice(0, 240));
        out.forEach((o, i) => { o.snippet = snips[i] || ''; });
        if (out.length) return { query: q, results: out, source: 'duckduckgo' };
      } catch (_) {}
    }
    return { error: 'search unavailable right now — answer from what you know, or ask the owner' };
  },
};

TOOLS.web_read = {
  description: 'Read the main text of one web page (a link from web_search) for the details.',
  input: { url: 'the page URL' },
  run: async ({ url }) => {
    const u = String(url || '').trim();
    if (!/^https?:\/\//.test(u)) return { error: 'bad url' };
    try {
      const r = await axios2.get(u, { timeout: 14000, maxContentLength: 4e6,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36' } });
      const title = (String(r.data).match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
      return { url: u, title: stripTags(title || '').slice(0, 160), text: stripTags(r.data).slice(0, 4000) };
    } catch (e) {
      return { error: `could not read: ${e.message}` };
    }
  },
};

TOOLS.canva_status = {
  description: 'Whether Canva auto-invites are on and logged in (for "is Canva working?", "did the invite go out?").',
  input: {},
  run: async () => { try { return await require('./canvaBot').status(); } catch (e) { return { error: e.message }; } },
};

TOOLS.emoji_status = {
  description: 'Why premium emoji icons are or are not showing on the bot buttons right now, with recent events.',
  input: {},
  run: () => { try { return require('../utils/emojiLayer').emojiStatus(); } catch (e) { return { error: e.message }; } },
};

/** Shape the model needs to know what it may call. */
function toolSchemas() {
  return Object.entries(TOOLS).map(([name, t]) => ({
    name,
    description: t.description,
    input_schema: {
      type: 'object',
      properties: Object.fromEntries(
        Object.entries(t.input).map(([k, v]) => [k, { type: 'string', description: v }])
      ),
    },
  }));
}

/** Run one tool by name. Unknown names are refused, never guessed at. */
async function runTool(name, input = {}) {
  const tool = TOOLS[name];
  if (!tool) return { error: `Unknown tool: ${name}` };
  try {
    // Some tools ask Binance live, so every tool may be awaited.
    const out = await tool.run(input || {});
    logger.info(`[agent] ${name}(${JSON.stringify(input).slice(0, 80)})`);
    return out === undefined ? null : out;
  } catch (e) {
    logger.warn(`[agent] ${name} failed: ${e.message}`);
    return { error: e.message };
  }
}

/**
 * The ONE action the agent may propose — and it cannot perform it.
 *
 * `propose_reply` writes nothing and sends nothing. It hands the owner a draft
 * and stops. Sending happens only when the owner presses the button, through
 * sendApprovedReply() below, which the model has no way to reach.
 *
 * The split matters: a customer message can talk a model into drafting
 * anything, but a draft that must be read and approved by a human before it
 * moves is a suggestion, not an action.
 */
TOOLS.propose_reply = {
  description:
    'Propose a reply to a customer for the owner to approve. Does NOT send. ' +
    'Call support_examples first so the wording matches how this shop writes.',
  input: {
    user_id: 'the customer to reply to',
    text: 'the exact message to send if approved',
    why: 'one short line on why this is the right reply',
  },
  run: ({ user_id, text, why }) => {
    const uid = Number(user_id);
    const body = String(text || '').trim();
    if (!Number.isFinite(uid) || !body) return { error: 'user_id and text are required' };

    const u = raw.prepare('SELECT username, first_name FROM users WHERE telegram_id = ?').get(uid);
    const id = `d${Date.now()}${Math.floor(Math.random() * 1000)}`;
    DRAFTS.set(id, { user_id: uid, text: body, created: Date.now() });

    // Old drafts are dropped so an approval cannot fire days later against a
    // conversation that has moved on.
    for (const [k, v] of DRAFTS) if (Date.now() - v.created > 30 * 60 * 1000) DRAFTS.delete(k);

    return {
      draft_id: id,
      to: u?.username ? `@${u.username}` : (u?.first_name || String(uid)),
      user_id: uid,
      text: body,
      why: String(why || ''),
      status: 'awaiting_approval',
    };
  },
};

TOOLS.send_reply_now = {
  description:
    'Send a reply to a customer WITHOUT waiting for the owner — allowed ONLY for simple, factual, low-risk ' +
    'questions (how to top up, delivery time, where the instructions are, is a product in stock). NEVER for ' +
    'anything about money owed, refunds, complaints, promises, prices, account problems, or anything you are ' +
    'unsure about — use propose_reply for those. Requires the owner to have turned auto-reply on; if it is off ' +
    'this becomes a normal draft.',
  input: {
    user_id: 'the customer',
    text: 'the exact message to send',
    category: 'one of: how_to | delivery_time | instructions | stock | greeting — the safe kind this is',
  },
  run: ({ user_id, text, category }) => {
    const uid = Number(user_id);
    const body = String(text || '').trim();
    if (!Number.isFinite(uid) || !body) return { error: 'user_id and text required' };
    const SAFE = ['how_to', 'delivery_time', 'instructions', 'stock', 'greeting'];
    const on = (() => { try { return require('./agentMemory').getState('auto_reply', '0') === '1'; } catch (_) { return false; } })();
    // Off, or not a whitelisted kind → fall back to a draft the owner approves.
    if (!on || !SAFE.includes(String(category))) {
      const d = TOOLS.propose_reply.run({ user_id: uid, text: body, why: `auto-reply held (${!on ? 'auto-reply off' : 'needs review: ' + category})` });
      return { ...d, auto: false, held_reason: !on ? 'auto_reply_off' : 'not_a_safe_category' };
    }
    return { __auto_send: { user_id: uid, text: body, category }, sent: 'pending' };
  },
};

/** Drafts waiting for a yes. In memory: a draft not approved promptly is stale. */
const DRAFTS = new Map();

/**
 * Send a draft the owner approved.
 *
 * Called by the chat route, never by the model. The draft is looked up by id
 * rather than taking text from the request, so what gets sent is exactly what
 * was shown on screen — approving one message cannot deliver a different one.
 */
async function sendApprovedReply(draftId, bot) {
  const d = DRAFTS.get(String(draftId));
  if (!d) return { ok: false, error: 'This draft expired. Ask for a fresh one.' };
  if (!bot) return { ok: false, error: 'No bot instance available to send with.' };

  try {
    await bot.sendMessage(d.user_id, d.text);
    try {
      raw.prepare(`
        INSERT INTO support_messages (user_id, username, first_name, direction, content, media_type, file_id)
        VALUES (?, NULL, NULL, 'out', ?, NULL, NULL)
      `).run(d.user_id, d.text);
    } catch (e) {
      // The customer has the message; failing to log it must not look like a
      // failure to send.
      logger.warn(`[agent] reply sent but not logged: ${e.message}`);
    }
    DRAFTS.delete(String(draftId));
    logger.info(`[agent] approved reply sent to ${d.user_id}`);
    return { ok: true, user_id: d.user_id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { TOOLS, toolSchemas, runTool, sendApprovedReply, liveSnapshot, takeStockDraft, splitAccounts, takeAction, performAction, businessPerson, shopLinks };
