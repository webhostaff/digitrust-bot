'use strict';

/**
 * The assistant's own memory — the ONLY thing it is allowed to write.
 *
 * Three tables, all separate from shop data:
 *   agent_memory  facts it keeps about the owner, customers, suppliers, rules
 *   agent_chat    every exchange with the owner, so the chat survives restarts
 *   agent_state   small values (the OpenAI conversation chain, last model used)
 *
 * Writing here cannot move money, change stock or message anyone, so giving
 * the model a pen for its own notebook keeps the read-only boundary intact:
 * the worst a manipulated note can do is sit in the notebook, where the owner
 * sees it in the Memory panel and can delete it.
 */

const raw = require('../database/db');

raw.exec(`
  CREATE TABLE IF NOT EXISTS agent_memory (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    text       TEXT NOT NULL,
    category   TEXT DEFAULT 'note',
    source     TEXT DEFAULT 'assistant',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS agent_chat (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    role       TEXT NOT NULL,
    content    TEXT,
    meta       TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS agent_state (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`);

const MAX_NOTE = 500;

// ── Notebook ─────────────────────────────────────────────────────────────────

function addMemory(text, category = 'note', source = 'assistant') {
  const t = String(text || '').trim().slice(0, MAX_NOTE);
  if (!t) return null;
  // The same fact noted twice is one fact: refresh it instead of stacking.
  const dup = raw.prepare('SELECT id FROM agent_memory WHERE lower(text) = lower(?)').get(t);
  if (dup) {
    raw.prepare(`UPDATE agent_memory SET updated_at = datetime('now') WHERE id = ?`).run(dup.id);
    return dup.id;
  }
  return raw.prepare('INSERT INTO agent_memory (text, category, source) VALUES (?, ?, ?)')
    .run(t, String(category || 'note').slice(0, 30), source).lastInsertRowid;
}

function updateMemory(id, text) {
  const t = String(text || '').trim().slice(0, MAX_NOTE);
  if (!t) return false;
  return raw.prepare(`UPDATE agent_memory SET text = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(t, Number(id)).changes > 0;
}

function deleteMemory(id) {
  return raw.prepare('DELETE FROM agent_memory WHERE id = ?').run(Number(id)).changes > 0;
}

function listMemory(limit = 500) {
  return raw.prepare(`SELECT id, text, category, source, created_at, updated_at
                      FROM agent_memory ORDER BY updated_at DESC LIMIT ?`).all(limit);
}

function searchMemory(q, limit = 30) {
  const term = `%${String(q || '').trim()}%`;
  return raw.prepare(`SELECT id, text, category, updated_at FROM agent_memory
                      WHERE text LIKE ? COLLATE NOCASE OR category LIKE ? COLLATE NOCASE
                      ORDER BY updated_at DESC LIMIT ?`).all(term, term, limit);
}

/** What goes into every prompt: the newest notes, within a character budget. */
function memoryForPrompt(budget = 6000) {
  const rows = listMemory(200);
  const out = [];
  let used = 0;
  for (const r of rows) {
    const line = `#${r.id} [${r.category}] ${r.text}`;
    if (used + line.length > budget) break;
    out.push(line);
    used += line.length;
  }
  return { lines: out, total: rows.length };
}

// ── Chat log ─────────────────────────────────────────────────────────────────

function logChat(role, content, meta = null) {
  return raw.prepare('INSERT INTO agent_chat (role, content, meta) VALUES (?, ?, ?)')
    .run(role, String(content || ''), meta ? JSON.stringify(meta) : null).lastInsertRowid;
}

function recentChat(limit = 60) {
  return raw.prepare(`SELECT id, role, content, meta, created_at FROM agent_chat
                      ORDER BY id DESC LIMIT ?`).all(limit).reverse()
    .map((r) => ({ ...r, meta: r.meta ? safeJson(r.meta) : null }));
}

/** Turns since the last "new chat" divider — the context a fresh chain needs. */
function turnsSinceDivider(limit = 16) {
  const rows = raw.prepare(`SELECT role, content FROM agent_chat ORDER BY id DESC LIMIT 200`).all();
  const out = [];
  for (const r of rows) {
    if (r.role === 'divider') break;
    if (r.role === 'user' || r.role === 'assistant') out.push(r);
    if (out.length >= limit) break;
  }
  return out.reverse();
}

function searchChat(q, limit = 20) {
  const term = `%${String(q || '').trim()}%`;
  return raw.prepare(`SELECT id, role, substr(content, 1, 500) AS content, created_at FROM agent_chat
                      WHERE role IN ('user','assistant') AND content LIKE ? COLLATE NOCASE
                      ORDER BY id DESC LIMIT ?`).all(term, limit);
}

// ── State ────────────────────────────────────────────────────────────────────

function getState(key, def = null) {
  const r = raw.prepare('SELECT value FROM agent_state WHERE key = ?').get(key);
  return r ? r.value : def;
}

function setState(key, value) {
  if (value === null || value === undefined) {
    raw.prepare('DELETE FROM agent_state WHERE key = ?').run(key);
    return;
  }
  raw.prepare(`INSERT INTO agent_state (key, value) VALUES (?, ?)
               ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value));
}

function safeJson(s) { try { return JSON.parse(s); } catch (_) { return null; } }

module.exports = {
  addMemory, updateMemory, deleteMemory, listMemory, searchMemory, memoryForPrompt,
  logChat, recentChat, turnsSinceDivider, searchChat,
  getState, setState,
};
