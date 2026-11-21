'use strict';

// Keep a paid continuation visible to the cycle that originally supplied the email,
// even when the renewal's last day changes. Unrelated purchases are not included.
// V166.7: when the invite bot names its panel, a seat moved with 🖥 Change panel follows its
// new panel (and leaves the old one), so the invite bot does not flag it as unknown.
function readSeats(db, statuses, day, panel = '') {
  const marks = statuses.map(() => '?').join(',');
  if (day === null) {
    return db.prepare(`SELECT order_id, email, status, start_date, end_date, days_remaining, renewed_from
      FROM chatgpt_subscriptions WHERE status IN (${marks}) ORDER BY created_at, id`).all(...statuses);
  }
  const chain = (name, seed) => `${name}(id) AS (
      ${seed}
      UNION
      SELECT next.id FROM chatgpt_subscriptions next
       JOIN ${name} chain ON next.renewed_from = chain.id
       JOIN chatgpt_subscriptions prev ON prev.id = chain.id
       WHERE lower(trim(next.email)) = lower(trim(prev.email))
         AND next.user_id = prev.user_id
         AND next.status IN ('pending', 'active', 'expired')
         ${name === 'cycle_seats' ? '' : `AND next.id NOT IN (SELECT sub_id FROM cgb_seat_panels WHERE panel_id ${name === 'moved_to' ? '<>' : '='} ?)`}
    )`;
  const cycle = chain('cycle_seats', `SELECT id FROM chatgpt_subscriptions WHERE CAST(strftime('%d', end_date) AS INTEGER) = ?`);
  const cols = 'order_id, email, status, start_date, end_date, days_remaining, renewed_from';
  if (!panel) {
    return db.prepare(`WITH RECURSIVE ${cycle} SELECT ${cols}
        FROM chatgpt_subscriptions WHERE id IN (SELECT id FROM cycle_seats)
          AND status IN (${marks}) ORDER BY created_at, id`).all(day, ...statuses);
  }
  db.exec("CREATE TABLE IF NOT EXISTS cgb_seat_panels (sub_id INTEGER PRIMARY KEY, panel_id TEXT NOT NULL, set_at TEXT DEFAULT (datetime('now')))");
  const movedTo = chain('moved_to', 'SELECT sub_id FROM cgb_seat_panels WHERE panel_id = ?');
  const movedAway = chain('moved_away', 'SELECT sub_id FROM cgb_seat_panels WHERE panel_id <> ?');
  return db.prepare(`WITH RECURSIVE ${cycle}, ${movedTo}, ${movedAway} SELECT ${cols}
      FROM chatgpt_subscriptions
     WHERE ((id IN (SELECT id FROM cycle_seats) AND id NOT IN (SELECT id FROM moved_away))
            OR id IN (SELECT id FROM moved_to))
       AND status IN (${marks}) ORDER BY created_at, id`).all(day, panel, panel, panel, panel, ...statuses);
}

module.exports = { readSeats };
