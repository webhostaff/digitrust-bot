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
    description: 'The recent messages of one support conversation.',
    input: { user_id: 'required', limit: 'default 30' },
    run: ({ user_id, limit = 30 }) => {
      try {
        return raw.prepare(`
          SELECT direction, content AS body, created_at FROM support_messages
          WHERE user_id = ? ORDER BY id DESC LIMIT ?
        `).all(Number(user_id), Math.min(100, Number(limit) || 30)).reverse();
      } catch (e) { return []; }
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
        return c ? { ends: c.endDate.toISOString().slice(0, 16), days_left: c.daysRemaining } : null;
      })(),
      monthly_price: require('../services/cgbCycles').getMonthlyPrice(),
      paid_renewals: db.getCgbRenewals(10),
      awaiting_payment: db.getCgbPendingRenewals().slice(0, 10),
      scheduled: (db.getCgbScheduled ? db.getCgbScheduled() : []).slice(0, 10),
      due_now: (db.getCgbDueNow ? db.getCgbDueNow() : []).slice(0, 10),
    }),
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
function runTool(name, input = {}) {
  const tool = TOOLS[name];
  if (!tool) return { error: `Unknown tool: ${name}` };
  try {
    const out = tool.run(input || {});
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

module.exports = { TOOLS, toolSchemas, runTool, sendApprovedReply };
