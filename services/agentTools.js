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
    category: 'owner | customer | supplier | product | rule | issue | note',
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

module.exports = { TOOLS, toolSchemas, runTool, sendApprovedReply, liveSnapshot };
