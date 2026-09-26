'use strict';

/**
 * Manual delivery, fast lane.
 *
 * Invites such as Canva Teams are done by hand on purpose — a personal invite
 * per customer email, nothing automated touching the team. What was slow was
 * everything around the one step that must stay human: finding the email,
 * opening the right page, pressing Deliver, typing, then hunting for the next
 * task. This removes all of that:
 *
 *   - the card carries a copy-email button and a button to the work page
 *     (Canva's people page for Canva products, configurable for any product);
 *   - replying to the card with the content delivers it — no Deliver button;
 *   - content is checked against what the product expects (a Canva join link),
 *     so a pasted email or a wrong link never reaches the customer;
 *   - once one is delivered, the next pending task comes up ready to paste;
 *   - a single link reaches the customer as an "Accept invitation" button.
 */

const db = require('../database/queries');

const CANVA = {
  link: 'https://www.canva.com/settings/people',
  expect: 'canva.com/brand/join',
  label: '🔗 Canva',
  accept: '✅ Accept invitation',
};

const cleanTitle = (t) => String(t || '').replace(/\[emoji:\d+\]/g, '').trim();

/** Work page, expected-content marker and labels for a product. */
function profileFor(productId, title = '') {
  const link = db.getSetting(`md_link_${productId}`, '');
  const expect = db.getSetting(`md_expect_${productId}`, '');
  const isCanva = /canva/i.test(title);
  return {
    link: link || (isCanva ? CANVA.link : ''),
    expect: expect || (isCanva ? CANVA.expect : ''),
    label: link ? '🔗 Open' : (isCanva ? CANVA.label : '🔗 Open'),
    accept: isCanva ? CANVA.accept : '🔗 Open',
  };
}

/** Buttons for a task card: copy email, work page, deliver. */
function taskButtons(task, extra = []) {
  const prof = profileFor(task.product_id, task.product_title);
  const top = [];
  if (task.email) top.push({ text: '📋 Email', copy_text: { text: String(task.email).slice(0, 256) } });
  if (prof.link) top.push({ text: prof.label, url: prof.link });
  const rows = [];
  if (top.length) rows.push(top);
  rows.push([{ text: '✅ Deliver now', callback_data: `md_deliver_${task.id}` }]);
  return rows.concat(extra);
}

/**
 * Is this what the product expects? Returns null when it looks right,
 * otherwise the reason to stop and ask.
 */
function checkContent(task, content) {
  const prof = profileFor(task.product_id, task.product_title);
  const c = String(content || '').trim();
  if (!c) return 'empty';
  if (task.email && c.toLowerCase() === String(task.email).toLowerCase()) return 'that is the customer\'s email, not the invite link';
  if (prof.expect && !c.toLowerCase().includes(prof.expect.toLowerCase())) {
    return `this does not look like a ${/canva/i.test(prof.expect) ? 'Canva invite link' : `"${prof.expect}" link`}`;
  }
  return null;
}

/** The oldest pending task, preferring the same product. */
function nextTask(afterId, productId) {
  const raw = db.db;
  const pick = (sameProduct) => raw.prepare(`
    SELECT md.*, p.title AS product_title, u.username, u.first_name
    FROM manual_deliveries md
    LEFT JOIN products p ON p.id = md.product_id
    LEFT JOIN users u ON u.telegram_id = md.user_id
    WHERE md.status IN ('pending','processing') AND md.id <> ?
      ${sameProduct ? 'AND md.product_id = ?' : ''}
    ORDER BY md.id ASC LIMIT 1`).get(...(sameProduct ? [afterId, productId] : [afterId]));
  return (productId && pick(true)) || pick(false) || null;
}

function pendingCount() {
  try {
    return db.db.prepare(`SELECT COUNT(*) AS n FROM manual_deliveries WHERE status IN ('pending','processing')`).get().n;
  } catch (_) { return 0; }
}

/** A lone link becomes a button for the customer; anything else stays text. */
function customerButton(task, content) {
  const c = String(content || '').trim();
  if (!/^https?:\/\/\S+$/.test(c) || c.length > 2000) return null;
  const prof = profileFor(task.product_id, task.product_title);
  return { text: prof.accept, url: c };
}

module.exports = { profileFor, taskButtons, checkContent, nextTask, pendingCount, customerButton, cleanTitle };
