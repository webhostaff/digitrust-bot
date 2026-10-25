'use strict';

// Keep a paid continuation visible to the cycle that originally supplied the email,
// even when the renewal's last day changes. Unrelated purchases are not included.
function readSeats(db, statuses, day) {
  const marks = statuses.map(() => '?').join(',');
  if (day === null) {
    return db.prepare(`SELECT order_id, email, status, start_date, end_date, days_remaining, renewed_from
      FROM chatgpt_subscriptions WHERE status IN (${marks}) ORDER BY created_at, id`).all(...statuses);
  }
  return db.prepare(`WITH RECURSIVE cycle_seats(id) AS (
      SELECT id FROM chatgpt_subscriptions
       WHERE CAST(strftime('%d', end_date) AS INTEGER) = ?
      UNION
      SELECT next.id FROM chatgpt_subscriptions next
       JOIN cycle_seats chain ON next.renewed_from = chain.id
       JOIN chatgpt_subscriptions prev ON prev.id = chain.id
       WHERE lower(trim(next.email)) = lower(trim(prev.email))
         AND next.user_id = prev.user_id
         AND next.status IN ('pending', 'active', 'expired')
    ) SELECT order_id, email, status, start_date, end_date, days_remaining, renewed_from
        FROM chatgpt_subscriptions WHERE id IN (SELECT id FROM cycle_seats)
          AND status IN (${marks}) ORDER BY created_at, id`).all(day, ...statuses);
}

module.exports = { readSeats };