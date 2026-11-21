'use strict';

/**
 * Yamen's studio: create and edit products, and publish posts that look like
 * a designer made them — to the channel, the group, and (on request) every
 * customer of the bot, now or at a set time.
 *
 * Every tool here only PREPARES: it returns a card for the app. The change or
 * the post happens when the owner taps the card (POST /agent/action/approve →
 * perform()). A customer message can make Yamen draft something odd; it
 * cannot make it happen.
 */

const raw = require('../database/db');
const logger = require('../utils/logger');
const mem = require('./agentMemory');

const clean = (t) => String(t || '').replace(/\[emoji:\d+\]/g, '').trim();

// ── Safe Telegram HTML ───────────────────────────────────────────────────────

const ALLOWED = /<\/?(b|strong|i|em|u|ins|s|strike|del|code|pre|blockquote|tg-spoiler|a(\s+href="https?:\/\/[^"]+")?)>/gi;

/** Keep Telegram's formatting tags and [emoji:ID] markers, escape the rest. */
function safeHtml(t) {
  const keep = [];
  const marked = String(t || '').replace(ALLOWED, (m) => { keep.push(m); return `\u0000${keep.length - 1}\u0000`; });
  return marked.replace(/&(?!amp;|lt;|gt;|quot;|#\d+;)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\u0000(\d+)\u0000/g, (_, i) => keep[Number(i)]);
}

/** "🛒 Buy|product:12" / "Support|https://t.me/x" → inline keyboard rows. */
function parseButtons(spec, botUsername) {
  const rows = [];
  for (const line of String(spec || '').split(/\n|;;/).map((x) => x.trim()).filter(Boolean).slice(0, 6)) {
    const [labelRaw, targetRaw] = line.split('|').map((x) => (x || '').trim());
    const label = (labelRaw || '').slice(0, 40);
    let url = targetRaw || '';
    const pm = url.match(/^product:(\d+)$/i);
    if (pm) url = botUsername ? `https://t.me/${botUsername}?start=p_${pm[1]}` : '';
    else if (/^bot$/i.test(url)) url = botUsername ? `https://t.me/${botUsername}` : '';
    if (!label || !/^https?:\/\//.test(url)) continue;
    // Two short buttons share a row, like a designer would lay them out.
    const last = rows[rows.length - 1];
    if (last && last.length === 1 && label.length <= 14 && last[0].text.length <= 14) last.push({ text: label, url });
    else rows.push([{ text: label, url }]);
  }
  return rows.length ? { inline_keyboard: rows } : null;
}

function dataUrlToBuffer(u) {
  const m = String(u || '').match(/^data:(image\/[a-z]+);base64,(.+)$/);
  return m ? { buf: Buffer.from(m[2], 'base64'), type: m[1] } : null;
}

/** "2026-09-27 10:00" on the shop's clock → a real Date. */
function parseShopTime(s) {
  const m = String(s || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/);
  if (!m) return null;
  let off = 1;
  try { off = parseFloat(require('../database/queries').getSetting('cgb_timezone_offset', '1')) || 0; } catch (_) {}
  const utc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - off * 3600000;
  return new Date(utc);
}

// ── Tools ────────────────────────────────────────────────────────────────────

function register(TOOLS, { newAction }) {
  const findCategory = (c) => {
    if (c === undefined || c === null || c === '') return null;
    const cats = raw.prepare('SELECT id, name, emoji FROM categories WHERE COALESCE(is_active,1)=1').all();
    if (/^\d+$/.test(String(c))) return cats.find((x) => x.id === Number(c)) || null;
    const w = String(c).toLowerCase().replace(/\s+/g, '');
    return cats.find((x) => clean(x.name).toLowerCase().replace(/\s+/g, '') === w)
      || cats.find((x) => clean(x.name).toLowerCase().replace(/\s+/g, '').includes(w)) || null;
  };

  TOOLS.list_categories = {
    description: 'The shop\'s product categories (id, name) — to place a new product.',
    input: {},
    run: () => raw.prepare('SELECT id, name, emoji FROM categories WHERE COALESCE(is_active,1)=1 ORDER BY display_order').all()
      .map((c) => ({ id: c.id, name: clean(c.name), emoji: c.emoji })),
  };

  TOOLS.propose_product = {
    description:
      'Prepare a NEW product for the store (the owner confirms with a tap). Write it like a pro: a clean title ' +
      'in the shop\'s style (look at products_list), a selling description with emoji bullets (what you get, ' +
      'duration, warranty, how it is delivered), and the instruction the buyer sees after delivery. Icon: copy ' +
      'another product\'s [emoji:ID] or leave empty. Photo: the owner\'s attached image (image: 1). After it is ' +
      'created, add stock with propose_stock / propose_stock_count and offer a launch post.',
    input: {
      title: 'product title, e.g. "Notion Plus — 1 Year | Private Account"',
      price: 'price in $',
      description: 'selling description (Telegram HTML allowed)',
      warranty: 'e.g. "Full warranty 1 month"',
      instruction: 'optional: shown to the buyer after delivery (how to log in / activate)',
      category: 'optional: category id or name (list_categories)',
      delivery: 'auto (accounts from stock) | manual (you deliver by hand) | unlimited — default auto',
      requires_email: 'yes if the buyer must give an email (invites, activations) — default no',
      emoji_id: 'optional premium emoji id for the icon',
      image: 'optional: 1 to use the photo the owner attached',
      cost: 'optional: what one unit costs the shop, $',
    },
    run: (a) => {
      const title = String(a.title || '').trim();
      const price = Number(String(a.price || '').replace(/[$,\s]/g, ''));
      if (!title) return { error: 'title needed' };
      if (!Number.isFinite(price) || price <= 0) return { error: 'price must be a positive number' };
      const clash = raw.prepare('SELECT id, title FROM products WHERE lower(title) = lower(?) LIMIT 1').get(title);
      if (clash) return { error: `a product with this title already exists (#${clash.id})` };
      const cat = findCategory(a.category);
      if (a.category && !cat) return { error: `category "${a.category}" not found — list_categories` };
      const delivery = ['auto', 'manual', 'unlimited'].includes(String(a.delivery || 'auto').toLowerCase())
        ? String(a.delivery || 'auto').toLowerCase() : 'auto';
      const emojiId = /^\d{10,}$/.test(String(a.emoji_id || '')) ? String(a.emoji_id) : null;
      const img = a.image && a.__owner_images && a.__owner_images[Number(a.image) - 1] ? a.__owner_images[Number(a.image) - 1] : null;
      const payload = {
        title: emojiId && !/\[emoji:\d+\]/.test(title) ? `[emoji:${emojiId}]${title}` : title,
        price, description: safeHtml(a.description || ''), warranty: String(a.warranty || '').slice(0, 120),
        instruction: String(a.instruction || '').slice(0, 1500), categoryId: cat ? cat.id : 0, delivery,
        requiresEmail: /^(y|yes|1|true|نعم|ايه)/i.test(String(a.requires_email || '')) ? 1 : 0,
        image: img, cost: Number.isFinite(Number(a.cost)) ? Number(a.cost) : null,
      };
      const id = newAction('product_create', payload);
      return {
        action_id: id, kind: 'product_create', title: `🆕 ${clean(title)}`,
        summary: `💵 $${price.toFixed(2)} · ${delivery === 'manual' ? '✋ manual' : delivery === 'unlimited' ? '♾ unlimited' : '📦 auto'}` +
          `${cat ? ` · 📁 ${clean(cat.name)}` : ''}${payload.requiresEmail ? ' · 📧 email' : ''}${img ? ' · 🖼 photo' : ''}` +
          `${payload.warranty ? ` · 🛡 ${payload.warranty}` : ''}`,
        preview: `<b>${safeHtml(clean(title))}</b>\n\n${payload.description}` +
          (payload.instruction ? `\n\n<i>After purchase:</i> ${safeHtml(payload.instruction)}` : ''),
        confirm: '🆕 أنشئ المنتج',
      };
    },
  };

  const EDITABLE = {
    price: (v) => { const n = Number(String(v).replace(/[$,\s]/g, '')); return Number.isFinite(n) && n > 0 ? n : null; },
    title: (v) => String(v).trim() || null,
    description: (v) => safeHtml(v),
    warranty: (v) => String(v).slice(0, 120),
    instruction: (v) => String(v).slice(0, 1500),
    is_active: (v) => (/^(1|yes|on|true|show|active|نعم|ايه)/i.test(String(v)) ? 1 : 0),
    cost_price: (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null; },
    wholesale_price: (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null; },
    delivery_type: (v) => (['auto', 'manual'].includes(String(v)) ? String(v) : null),
    unlimited_stock: (v) => (/^(1|yes|true|on)/i.test(String(v)) ? 1 : 0),
    requires_email: (v) => (/^(1|yes|true|on)/i.test(String(v)) ? 1 : 0),
  };

  TOOLS.propose_product_update = {
    description:
      'Prepare changes to an existing product — price, title, description, warranty, instruction, hide/show ' +
      '(is_active), category, delivery_type, cost_price, wholesale_price, icon (emoji_id), photo (image: 1 = the ' +
      'owner\'s attached photo). Shows before → after; the owner confirms with a tap.',
    input: {
      product_id: 'product id',
      changes: 'JSON object of field → new value, e.g. {"price":"2.5","warranty":"3 months"}',
      image: 'optional: 1 to replace the photo with the owner\'s attached one',
      category: 'optional: new category id or name',
      emoji_id: 'optional: new premium icon id ("none" to remove)',
    },
    run: (a) => {
      const p = raw.prepare('SELECT * FROM products WHERE id = ?').get(Number(a.product_id));
      if (!p) return { error: 'product not found' };
      let ch = {};
      try { ch = typeof a.changes === 'object' ? a.changes : JSON.parse(a.changes || '{}'); } catch (_) { return { error: 'changes must be JSON' }; }
      const set = {};
      const lines = [];
      for (const [k, v] of Object.entries(ch || {})) {
        if (!EDITABLE[k]) return { error: `cannot edit "${k}" — allowed: ${Object.keys(EDITABLE).join(', ')}` };
        const val = EDITABLE[k](v);
        if (val === null) return { error: `bad value for ${k}` };
        set[k] = val;
        const before = k === 'description' ? `${String(p[k] || '').slice(0, 40)}…` : p[k];
        lines.push(`${k}: ${k === 'title' ? clean(before) : before} → ${k === 'title' ? clean(val) : (k === 'description' ? `${String(val).slice(0, 40)}…` : val)}`);
      }
      if (a.category !== undefined && a.category !== '') {
        const cat = findCategory(a.category);
        if (!cat) return { error: 'category not found' };
        set.category_id = cat.id; lines.push(`category → ${clean(cat.name)}`);
      }
      if (a.emoji_id) {
        const cur = String(set.title || p.title);
        const stripped = cur.replace(/\[emoji:\d+\]/g, '');
        set.title = /^none$/i.test(String(a.emoji_id)) ? stripped
          : /^\d{10,}$/.test(String(a.emoji_id)) ? `[emoji:${a.emoji_id}]${stripped}` : cur;
        lines.push(/^none$/i.test(String(a.emoji_id)) ? 'icon → removed' : 'icon → new premium emoji');
      }
      const img = a.image && a.__owner_images && a.__owner_images[Number(a.image) - 1] ? a.__owner_images[Number(a.image) - 1] : null;
      if (img) lines.push('photo → the one you attached');
      if (!lines.length) return { error: 'nothing to change' };
      const id = newAction('product_update', { productId: p.id, set, image: img });
      return { action_id: id, kind: 'product_update', title: `✏️ ${clean(p.title)}`, summary: lines.join('\n'), confirm: '✏️ طبّق' };
    },
  };

  TOOLS.propose_post = {
    description:
      'Prepare a post — announcement, offer, restock, launch, flash sale, news — for the CHANNEL, the GROUP, ' +
      'both, or every customer of the bot ("users"). Design it (see POST DESIGN). Nothing goes out until the ' +
      'owner taps. Can attach a product (its photo + Buy button), the owner\'s own photo, several buttons, and ' +
      'a time to publish later.',
    input: {
      target: 'channel | group | both | users | all (channel+group+users) — default both',
      text: 'the post in Telegram HTML (<b>, <i>, <u>, <code>, <blockquote>, <tg-spoiler>, <a href>); ' +
        '[emoji:ID] premium emoji show in the group and in DMs',
      product_id: 'optional: product it is about (adds its photo and a Buy button)',
      image: 'optional: 1 to use the photo the owner attached (instead of the product photo)',
      buttons: 'optional: one per line "Label|url", "Label|product:ID" or "Label|bot"',
      schedule_at: 'optional: "YYYY-MM-DD HH:MM" on the shop clock to publish later',
    },
    run: (a) => {
      const t = String(a.target || 'both').toLowerCase();
      const where = ['channel', 'group', 'both', 'users', 'all'].includes(t) ? t : 'both';
      const body = safeHtml(String(a.text || '').trim());
      if (!body) return { error: 'empty post' };
      if (body.length > 3800) return { error: 'too long for Telegram (max ~3800 characters)' };
      let product = null;
      if (a.product_id) {
        product = raw.prepare('SELECT id, title, image_file_id FROM products WHERE id = ?').get(Number(a.product_id));
        if (!product) return { error: 'product not found' };
      }
      const notif = require('./notifications');
      const has = { channel: !!notif.updatesChannelId(), group: !!notif.updatesGroupId() };
      if ((where === 'channel' && !has.channel) || (where === 'group' && !has.group)) return { error: `no ${where} configured in the bot settings` };
      if (where === 'both' && !has.channel && !has.group) return { error: 'no channel or group configured' };
      let when = null;
      if (a.schedule_at) {
        when = parseShopTime(a.schedule_at);
        if (!when) return { error: 'schedule_at must be "YYYY-MM-DD HH:MM"' };
        if (when.getTime() < Date.now() + 60000) return { error: 'that time has already passed' };
      }
      const img = a.image && a.__owner_images && a.__owner_images[Number(a.image) - 1] ? a.__owner_images[Number(a.image) - 1] : null;
      const users = where === 'users' || where === 'all'
        ? raw.prepare('SELECT COUNT(*) AS n FROM users WHERE COALESCE(is_banned,0)=0').get().n : 0;
      const payload = { where, body, productId: product ? product.id : null, image: img,
        buttons: String(a.buttons || ''), at: when ? when.toISOString() : null };
      const id = newAction('post', payload);
      const label = { channel: '📢 القناة', group: '👥 الجروب', both: '📢 القناة + 👥 الجروب',
        users: `👤 ${users} حريف (رسالة خاصة)`, all: `📢 + 👥 + 👤 ${users} حريف` }[where];
      const btnLabels = (String(a.buttons || '').split(/\n|;;/).map((l) => l.split('|')[0].trim()).filter(Boolean));
      return {
        action_id: id, kind: 'post', title: `📣 منشور → ${label}`,
        summary: [
          img ? '🖼 your photo' : product ? `🖼 ${clean(product.title)} (photo)` : '',
          product && !String(a.buttons || '').trim() ? '🛒 Buy button' : '',
          btnLabels.length ? `🔘 ${btnLabels.join(' · ')}` : '',
          when ? `⏰ ${String(a.schedule_at)}` : '',
          users ? `⚠️ يوصل لـ ${users} حريف في الخاص` : '',
        ].filter(Boolean).join(' · '),
        preview: body, confirm: when ? '⏰ برمج' : '📣 انشر',
      };
    },
  };

  TOOLS.scheduled_posts = {
    description: 'Posts waiting to be published at a set time (and cancel one by id).',
    input: { cancel_id: 'optional: id of a scheduled post to cancel' },
    run: ({ cancel_id }) => {
      let list = [];
      try { list = JSON.parse(mem.getState('scheduled_posts', '[]') || '[]'); } catch (_) {}
      if (cancel_id) {
        const before = list.length;
        list = list.filter((x) => x.id !== cancel_id);
        mem.setState('scheduled_posts', JSON.stringify(list));
        return { cancelled: before !== list.length };
      }
      return list.map((x) => ({ id: x.id, at: x.at, where: x.where, preview: clean(x.body).replace(/<[^>]+>/g, '').slice(0, 80) }));
    },
  };
}

// ── Doing it (only after the owner's tap) ────────────────────────────────────

async function uploadPhoto(bot, dataUrl) {
  const f = dataUrlToBuffer(dataUrl);
  if (!f) return null;
  const owner = String(process.env.ADMIN_ID || (process.env.ADMIN_IDS || '').split(',')[0] || '').trim();
  if (!owner) return null;
  // Telegram gives a reusable file id for a photo once it has been sent once.
  const m = await bot.sendPhoto(owner, f.buf, { caption: '🖼 Yamen — photo saved for a product', disable_notification: true },
    { filename: 'photo.jpg', contentType: f.type });
  const sizes = m && m.photo;
  return sizes && sizes.length ? sizes[sizes.length - 1].file_id : null;
}

async function publishPost(bot, p) {
  const notif = require('./notifications');
  const { renderEmojis } = require('../utils/format');
  const me = await bot.getMe().catch(() => ({ username: '' }));
  let kb = parseButtons(p.buttons, me.username);
  let product = null;
  if (p.productId) {
    product = require('../database/queries').getProduct(p.productId);
    if (!kb && product && me.username) kb = { inline_keyboard: [[{ text: '🛒 Buy now', url: `https://t.me/${me.username}?start=p_${product.id}` }]] };
  }
  let photo = p.image ? dataUrlToBuffer(p.image) : null;
  const photoRef = photo ? photo.buf : (product && product.image_file_id) || null;

  const sendTo = async (chatId, text) => {
    // A photo caption holds 1024 characters; a longer post goes as photo, then text.
    if (photoRef && text.length <= 1000) {
      await bot.sendPhoto(chatId, photoRef, { caption: text, parse_mode: 'HTML', reply_markup: kb || undefined },
        photo ? { filename: 'post.jpg', contentType: photo.type } : undefined);
    } else {
      if (photoRef) await bot.sendPhoto(chatId, photoRef, {}, photo ? { filename: 'post.jpg', contentType: photo.type } : undefined);
      await bot.sendMessage(chatId, text, { parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: kb || undefined });
    }
  };

  const done = [];
  const failed = [];
  const channel = notif.updatesChannelId();
  const group = notif.updatesGroupId();
  if (['channel', 'both', 'all'].includes(p.where) && channel) {
    try { await sendTo(channel, p.body); done.push('📢 القناة'); } catch (e) { failed.push(`channel: ${e.message}`); }
  }
  if (['group', 'both', 'all'].includes(p.where) && group) {
    try { await sendTo(group, renderEmojis(p.body)); done.push('👥 الجروب'); } catch (e) { failed.push(`group: ${e.message}`); }
  }
  if (['users', 'all'].includes(p.where)) {
    // Runs in the background — a few thousand customers take minutes — and
    // reports back in the app when it is finished.
    const users = raw.prepare('SELECT telegram_id FROM users WHERE COALESCE(is_banned,0)=0').all();
    (async () => {
      let ok = 0, ko = 0;
      for (const u of users) {
        try { await sendTo(u.telegram_id, p.body); ok++; } catch (_) { ko++; }
        await new Promise((r) => setTimeout(r, 60));
      }
      mem.logChat('event', `📬 الإعلان وصل لـ ${ok} حريف${ko ? ` · ${ko} ما وصلش (سكّرو البوت)` : ''}`);
    })().catch((e) => logger.warn(`[studio] broadcast: ${e.message}`));
    done.push(`👤 ${users.length} حريف (قاعد يتبعث)`);
  }
  return done.length ? { ok: true, message: `✅ تنشر في ${done.join(' · ')}${failed.length ? ` — ⚠️ ${failed.join('; ')}` : ''}` }
    : { ok: false, error: failed.join('; ') || 'nowhere to publish' };
}

async function perform(a, bot) {
  const db = require('../database/queries');
  if (a.kind === 'product_create') {
    const d = a.payload;
    let fileId = null;
    if (d.image && bot) { try { fileId = await uploadPhoto(bot, d.image); } catch (e) { logger.warn(`[studio] photo: ${e.message}`); } }
    const id = db.insertProduct({
      title: d.title, description: d.description, warranty: d.warranty, price: d.price,
      requiresEmail: d.requiresEmail, imageFileId: fileId, stockQuantity: 0, salesCount: 0,
    });
    if (d.instruction) db.updateProduct(id, 'instruction', d.instruction);
    if (d.categoryId) db.updateProduct(id, 'category_id', d.categoryId);
    if (d.delivery === 'manual') db.updateProduct(id, 'delivery_type', 'manual');
    if (d.delivery === 'unlimited') db.updateProduct(id, 'unlimited_stock', 1);
    if (d.cost !== null && d.cost !== undefined) db.updateProduct(id, 'cost_price', d.cost);
    if (/\[emoji:\d+\]/.test(d.title)) { try { require('../utils/emojiBackup').remember(id, d.title); } catch (_) {} }
    return { ok: true, product_id: id,
      message: `✅ المنتج تعمل — #${id} ${clean(d.title)}${fileId ? ' · 🖼' : ''}. توا زيدلو مخزون وقلّي كان تحب منشور إطلاق.` };
  }
  if (a.kind === 'product_update') {
    const { productId, set, image } = a.payload;
    for (const [k, v] of Object.entries(set)) db.updateProduct(productId, k, v);
    if (image && bot) {
      try { const fid = await uploadPhoto(bot, image); if (fid) db.updateProduct(productId, 'image_file_id', fid); } catch (e) { logger.warn(`[studio] photo: ${e.message}`); }
    }
    return { ok: true, message: `✅ تبدّل: ${Object.keys(set).concat(image ? ['photo'] : []).join(', ')}` };
  }
  if (a.kind === 'post') {
    if (!bot) return { ok: false, error: 'no bot' };
    if (a.payload.at && new Date(a.payload.at).getTime() > Date.now() + 30000) {
      let list = [];
      try { list = JSON.parse(mem.getState('scheduled_posts', '[]') || '[]'); } catch (_) {}
      const id = `sp_${Date.now().toString(36)}`;
      list.push({ id, ...a.payload });
      mem.setState('scheduled_posts', JSON.stringify(list));
      return { ok: true, message: `⏰ تبرمج — يتنشر ${new Date(a.payload.at).toISOString().slice(0, 16).replace('T', ' ')} UTC` };
    }
    return publishPost(bot, a.payload);
  }
  return null;
}

/** Called by the watcher every few minutes: publish what is due. */
async function runScheduled(bot) {
  if (!bot) return;
  let list = [];
  try { list = JSON.parse(mem.getState('scheduled_posts', '[]') || '[]'); } catch (_) { return; }
  const due = list.filter((x) => new Date(x.at).getTime() <= Date.now());
  if (!due.length) return;
  mem.setState('scheduled_posts', JSON.stringify(list.filter((x) => !due.includes(x))));
  for (const p of due) {
    const r = await publishPost(bot, p).catch((e) => ({ ok: false, error: e.message }));
    mem.logChat('event', r.ok ? `⏰ ${r.message}` : `❌ المنشور المبرمج ما تنشرش: ${r.error}`);
  }
}

module.exports = { register, perform, runScheduled, safeHtml, parseButtons };
