# DIGITRUST Bot — Upgrade Notes

Everything here is additive. No existing table is dropped or rewritten, and no
existing feature was removed. The migration runs automatically on boot from
`database/db.js` and is idempotent — restarting any number of times is safe.

---

## ⚠️ Before you deploy

| Item | Why it matters |
|---|---|
| Add the `ADMIN_ID` variable | Your numeric Telegram id. Used by the support bot, the ChatGPT bot and admin pushes. Without it the code falls back to a hard-coded id. |
| `DB_PATH` must point at a Railway **Volume** | Otherwise SQLite is wiped on every deploy and everything below is lost with it. |
| Set `deposit_cutoff_ms` to "now" | Blocks every historical TxID immediately — see the security section. |

`ADMIN_ID` is the only new environment variable. Everything else is configured
inside the bot under `/admin → ⚙️ Settings`.

---

# Part 1 — Support bot

## What was wrong

`support-bot.js` sent `"✅ Your message has been sent"` at the end of every
single `bot.on('message')` with no condition, so the customer got it after each
message. `is_read` existed in the table but was only used to count unread
threads for the admin — nothing was ever shown to the customer. And `showChat`
replayed only the last 15 messages via `messages.slice(-15)`, with no way to go
further back.

## What changed

* The per-message auto-reply is gone. The welcome is sent **once per customer
  ever**, latched in `support_threads.welcomed`.
* Read receipts. The customer sees a single status line:
  * `✓ Sent` — stored, support has not opened it
  * `✓✓ Read by support · HH:MM` — a staff member actually opened the chat

  The line is **edited in place**, so ten messages produce one indicator rather
  than ten. State lives in `support_threads` plus
  `support_messages.is_read` / `read_at`, so it is still correct after a restart.
* Full history: pagination (`⬆️ Older` / `⬇️ Newer`), date separators, a
  timestamp on every message, and a clear 📩 Customer / 📤 Support split.
* Attachments can be replayed per page.
* Customer search, and a `📦 Their orders` shortcut inside the chat.
* Staff is now anyone in `ADMIN_IDS`, not only `ADMIN_ID`.

---

# Part 2 — Refund eligibility

## What was wrong

There was no eligibility field at all. `refund_request_start` filtered only on
`status === 'delivered'`, so every delivered order could be refunded.

## What changed

* `Edit Product → 🔄 Refund Eligibility` toggles a product.
* Non-eligible products are filtered out of the customer's refund list.
* Eligibility is re-checked **server-side three times**: when listing, when the
  request is opened, and again at final submit. A forged callback is rejected
  with a clear message.
* The product page warns the buyer *before* purchase when refunds are
  unavailable.

New column: `products.refund_enabled` (default `1`, so nothing changes until you
opt a product out).

---

# Part 3 — Order history

## What was wrong

`ordersListKb` did `orders.slice(0, 10)`. A customer with more than ten orders
simply never saw the older ones — this is the "some products don't appear" issue.

## What changed

* The cap is gone; nothing is hidden.
* Pagination (8 per page) plus date filters: **All / 7 days / 30 days / This
  month / Last month**.
* The header shows "Showing X of Y total" so the customer can see the list is
  complete.
* Manual-delivery orders show their live stage (🕐 waiting, ⚙️ in progress).

---

# Part 4 — Manual delivery

## What was wrong

Every purchase went through `deliverOrder`, which consumes stock immediately.
There was no alternative path for products you hand over yourself.

## What changed

New column `products.delivery_type` (`'auto'` | `'manual'`), toggled from
`Edit Product → 🚚 Delivery Method`.

For a manual product, on successful payment the order becomes
`awaiting_delivery`, **stock items are not consumed**, and a task is opened in
`manual_deliveries`.

Guarantees, and where they come from:

| Guarantee | Mechanism |
|---|---|
| Never created before payment succeeds | the task is opened only after the atomic charge/settle transaction returns `ok` |
| Never duplicated for one order | `UNIQUE(order_id)` + `INSERT OR IGNORE` |
| Never disappears before it is done | it is a database row, not a message |
| No repeated admin pings | `notifyAdmin` dedupe key + `notified_at` latch |

Works on all four payment paths: wallet, USDT, Binance Pay, CryptoBot.
Statuses: `pending → processing → delivered`, plus `cancelled` (cancelling
refunds the wallet automatically).

---

# Part 5 — Manual delivery panel

Available in **both** places, with identical data:

* Support bot: `/manual` or the 📦 button in the inbox
* Admin panel: `/admin → 📦 Manual Delivery`

Status tabs with counters, a 🆕 badge on unreviewed tasks, newest-first ordering,
search (order no. / task id / customer / product / email), and per-task actions.

---

# Part 6 — Stock alerts

## What was wrong

`checkAndNotifyStockLevel` published to the public channel only. Nothing reached
the admin, there was no duplicate protection, and no configurable threshold.

## What changed

* Fires at **0** (sold out) and at the **low threshold**.
* Threshold is per product (`products.low_stock_threshold`), falling back to the
  global `low_stock_threshold_default` setting.
* Latching via `oos_notified` / `low_notified`: sell out → **one** alert; stays
  at zero → silence; restock and sell out again → a **new** alert.
* Hooked into every stock mutation: purchases and all six admin stock actions.
* The alert carries product name, id, price, remaining stock, timestamp, and a
  button that jumps straight to stock management.

---

# Part 7 — Admin notification centre

`/admin → 🔔 Notifications`

* Types: manual delivery, out of stock, low stock, refund request, support message.
* Unread / All tabs, unread counter, pagination, mark-all-as-read.
* Opening a notification marks it read and offers a deep link to the related
  task / request / product.
* Also pushed to `ADMIN_IDS`, `ADMIN_ID` and the optional `admin_notify_chat_id`
  channel.
* **Duplicate protection**: `dedupe_key` is `UNIQUE` and the insert is
  `INSERT OR IGNORE`, so the same event is stored exactly once no matter how many
  times the producing code path runs.

---

# Part 8 — Deposit security (critical)

## The vulnerability

The USDT deposit address is a **single shared address**. Every transfer to it is
public on BscScan / Tronscan — TxID, amount and timestamp included. The old code
treated "knows the TxID" as proof of ownership, which is not authentication at
all: anyone could read the explorer and claim any transfer nobody had claimed yet.

Confirmed in production on 2026-08-05:

```
[VERIFY] MATCH FOUND: amount=1117.7303 ... insertTime=1783860551000
Top-up credited: user=354712964 amount=1117.7303 method=USDT BEP20
```

`insertTime` corresponds to roughly 12 July — a **24-day-old** transfer, claimed
on 5 August. The same flaw explains the user whose BEP20 deposit "never
arrived": somebody else submitted their TxID first, so the real owner's attempt
hit the already-used guard.

## The fix — amount reservation

1. Pick network → 2. enter amount → 3. the bot reserves a **unique** figure
(e.g. `10.004731`) → 4. send exactly that → 5. submit the TxID.

A deposit is matched by **(network + exact amount + time window)**, not by who
types the TxID first. The TxID is now only used to look the transfer up.

### Checks applied, in order

| # | Check | Stops |
|---|---|---|
| 1 | TxID never used before | replay |
| 2 | Binance confirms status=1, USDT, our address | fake claims |
| 3 | Age within `deposit_max_age_minutes` | harvested old TxIDs ← the $1117 attack |
| 4 | Timestamp not in the future | clock manipulation |
| 5 | Amount matches a live reservation | random guessing |
| 6 | Reservation belongs to the submitter | front-running |
| 7 | Transfer post-dates the reservation | back-dating |
| 8 | Reservation consumed atomically | double-claim |

### Timers

| Setting | Value | What it measures |
|---|---|---|
| `deposit_max_age_minutes` | **15 min** | Age of the on-chain transfer when the TxID is submitted. This is the security control. |
| `deposit_intent_ttl_minutes` | **30 min** | How long a reserved amount is held before the transfer must be made. |
| `deposit_strict_mode` | `1` | **Keep at 1.** `0` restores the old, exploitable behaviour. |
| `deposit_cutoff_ms` | existing | Global hard floor — set it to "now" during an incident. |
| `PAYMENT_CONFIRM_VALIDITY_MIN` | 20 min | Unrelated: the order-payment session window in `utils/format.js`. |

### Why 15 minutes does not hurt honest users

From the production log, honest deposits are claimed 1–2 minutes after arrival
(the user is inside the flow), and Binance moves a deposit from status 0 to 1 in
5–46 seconds. 15 minutes leaves wide margin.

More importantly, `services/binance.js` **soft-fails** a late transfer
(`found: true, tooOld: true`) and lets `handlers/wallet.js` decide, because the
right answer depends on the reservation:

| Situation | Outcome |
|---|---|
| Late + valid reservation owned by the submitter | → manual review, credited by admin |
| Late + no reservation | → **hard refused**, never queued (the harvesting attack) |
| Late + reservation owned by someone else | → refused, logged as a theft attempt |

So the window can be tightened aggressively: legitimate failures degrade to a
manual approval, while the attack path is closed outright.

### Admin tools

* `🛡 Deposit Review` — pending / approved / rejected tabs. Approving credits the
  rightful user and records the TxID as used, so it can never be claimed twice.
* `↩️ Reverse a deposit` — `USER_ID AMOUNT [reason]`. The balance is allowed to
  go negative on purpose: if the thief already spent the money, the debt stays
  visible instead of silently vanishing. Written to `balance_reversals`.

---

# Part 9 — Fraud response

`/admin → 👥 Users → [user] → 🚨 Fraud: cancel all orders`

Shows a preview first, then two choices: cancel **without** refund (the default
for fraud) or cancel **with** refund.

In one transaction it:

* cancels every `pending` and `awaiting_delivery` order
* closes the attached manual-delivery tasks
* **returns the stock** and corrects `sold_count` / `sales_count` — otherwise a
  fraud wave silently destroys the inventory numbers
* **rejects the user's pending refund requests**, so stolen credit cannot be
  cashed out to an external wallet
* releases their open deposit reservations
* leaves `delivered` orders untouched and reports the count — those goods are
  gone and rewriting history would corrupt the accounting

---

# Database changes

## New columns on `products`

| Column | Default | Meaning |
|---|---|---|
| `refund_enabled` | `1` | `1` = refunds allowed, `0` = blocked |
| `delivery_type` | `'auto'` | `'auto'` = instant, `'manual'` = opens a task |
| `low_stock_threshold` | `0` | Per-product alert level; `0` uses the global default |
| `oos_notified` / `low_notified` | `0` | Latch flags; cleared automatically on restock |

## New column on `support_messages`

`read_at` — the exact moment support opened the message.

## New tables

| Table | Purpose |
|---|---|
| `support_threads` | ✓/✓✓ indicator state and the one-time welcome latch |
| `manual_deliveries` | Manual delivery tasks. `UNIQUE(order_id)` prevents duplicates |
| `admin_notifications` | Persistent admin inbox. `UNIQUE(dedupe_key)` prevents duplicates |
| `deposit_intents` | Amount reservations, with a partial UNIQUE index on open rows |
| `deposit_reviews` | Deposits held for manual approval |
| `balance_reversals` | Audit log of every reversal |

`orders.status` gains one new value: **`awaiting_delivery`** (paid, waiting on a
human). Existing statuses are untouched.

---

# Pre-existing bugs fixed along the way

| Bug | Impact | Fix |
|---|---|---|
| `logger` used but never required in `handlers/start.js` | `ReferenceError` 15+ times in the production log, on every referral attempt while the referral system was off | imported |
| `escapeHtml` undefined at `index.js:429` | crash on any text message while maintenance mode was on | imported from `utils/format` |
| 9 × `handleAdminCallback(bot, { ...query, data: { ...query.data, data: 'x' } })` | spread a **string** into an object, so `data` became an object and every regex silently failed. Broke: delete category, set category, toggle ChatGPT mode, delete billing cycle, activate/delete reseller, toggle referral, toggle VIP-new-only, VIP broadcast | pass the string directly |
| `ADMIN_RESELLER_NEW_NAME` / `ADMIN_RESELLER_BALANCE` had no text handler | "Add reseller" and "Add balance" did nothing at all | handlers implemented, with API-key generation |
| `db.prepare(...)` + undefined `userId` in `sendDelivery` | VIP unlock on referral purchase never ran, swallowed by `try/catch` | use `dbRaw.prepare` and `order.user_id` |
| `NOT NULL constraint failed: orders.quantity` | crash (×3 in the log) when a user confirmed an order from a stale message after the session expired | session validated before INSERT, friendly "session expired" message |
| Undefined `recovered` in the delete-order log | threw after a successful delete, showing a false error | removed from the log line |
| `admin_product_<id>` callbacks | dead links — that callback does not exist | point to `admin_edit_p_<id>` |
| `answerCallbackQuery(messageId, ...)` | `message_id` passed where `callback_query_id` was expected | corrected |
| `message is not modified` / `message to edit not found` | harmless Telegram races flooding the logs | filtered out of `unhandledRejection` |

---

# Test results

| Suite | Result |
|---|---|
| Migration & features | 27/27 |
| Deposit security (attack simulations) | 14/14 |
| Fraud response | 14/14 |

The security suite replays the exact $1117.73 incident, plus front-running,
replay, amount guessing, back-dating, 400 concurrent reservations with zero
collisions, and reversal leaving a negative-balance debt trail.

## Manual checklist after deploying

- [ ] Send two messages to the support bot as a customer → welcome appears once, one `✓` line
- [ ] Open the chat as staff → the line becomes `✓✓`
- [ ] Restart the bot → the `✓✓` state is still correct
- [ ] Disable refunds on one product → it disappears from the customer's refund list
- [ ] Place more than 10 orders on a test account → all of them are listed, filters work
- [ ] Set a product to manual, buy it → task appears, customer is told it is queued
- [ ] Deliver the task → customer receives it, task moves to ✅
- [ ] Drop a product's stock to 0 → one alert, no repeats; restock → alert re-arms
- [ ] Wallet → USDT → asks for network, then amount, then gives a unique figure
- [ ] `logger is not defined` no longer appears in the log

---

# Part 10 — Later fixes

## Balance comparison bug

A customer with `$1.00` shown against a `$1.00` price was told
**"Insufficient balance"** and could not buy.

Cause: the check was `balance < price - 0.001`, while the interface rounds to
cents. A stored balance of `0.9989` displays as `$1.00` but fails that test.

Fix: `hasEnough()` compares whole cents, restoring the invariant the interface
promises — *if the two displayed figures are equal, the purchase goes through*.
Applied to all three call sites (wallet purchase, manual-delivery purchase,
preorder).

| Balance | Displayed | Price | Old | New |
|---|---|---|---|---|
| 0.9989 | $1.00 | $1.00 | refused | **passes** |
| 0.9951 | $1.00 | $1.00 | refused | **passes** |
| 0.9940 | $0.99 | $1.00 | refused | refused |
| 5.0000 | $5.00 | $5.01 | refused | refused |

## Erase a customer's order data

`🚨 Fraud → 🧹 Erase their order data`, with two levels:

* **🧽 Wipe delivered content** — clears `delivered_content` on their orders and
  manual tasks, so they can no longer read the keys from "My Orders". The rows
  stay, so sales and stock figures remain correct. This is the normal choice.
* **🗑 Delete everything** — removes the order rows entirely. Irreversible, and
  revenue/sales statistics change because those purchases disappear.

Other customers' data is never touched.

## Stock alerts inside the Support Bot

New section: `/alerts`, or the `🔔 Stock Alerts` button in the inbox.

Tabs (All / 🔴 Out of stock / 🟠 Running low), unread counters, pagination, and
mark-all-as-read. It reads the shared `admin_notifications` table, so an alert
raised by the main bot appears here with the same read state — marking it read
in one place marks it read everywhere. Manual-delivery and support-message
notifications are filtered out of this section.

## Reduced the unique-amount suffix

The reservation suffix was `0.000100–0.009999` (up to one cent). It is now
`0.000101–0.000999` — **at most a tenth of a cent**, averaging 0.055 of a cent.

| | Old | New |
|---|---|---|
| Range | 0.000100 – 0.009999 | 0.000101 – 0.000999 |
| Average cost | 0.505 of a cent | **0.055 of a cent** |
| Values per base amount | 9900 | 899 |

The smaller range does not weaken anything: correctness comes from the partial
UNIQUE index on open reservations, not from the size of the range. A collision
simply causes a redraw.

### The suffix is not a fee

Network fees never touch the USDT amount: BEP20 gas is paid in BNB and TRC20 in
TRX/Energy. The exact figure the customer sends is the exact figure Binance
receives, and the whole of it is credited to their wallet. This is visible in
the production log, where amounts like `35.12544802` and `18.12959494` arrived
with full six-decimal precision.

### Separate: the CryptoBot fee

`handlers/wallet.js` adds a fixed fee on top of CryptoBot top-ups, controlled by
the `cryptobot_fee_fixed` setting (default `0.01`). That one **is** a real charge
to the customer. Set it to `0` in `/admin → ⚙️ Settings` if you do not want it.

---

# Part 11 — Support console rework

## The problem

Inline keyboards live on one specific message. Once a few notifications arrive,
the message carrying the buttons has scrolled away and there is no route back to
the inbox — the console becomes unusable exactly when it is busiest.

## Persistent navigation bar

Staff now get a **ReplyKeyboard** pinned to the bottom of the chat:

```
[ 📥 Inbox    ] [ 💳 Payments ]
[ 📦 Delivery ] [ 🔔 Stock    ]
```

It never scrolls away. Every section is one tap from anywhere.

Taps arrive as ordinary text, so they are intercepted **before** the reply
forwarding logic — otherwise tapping `📥 Inbox` during a conversation would send
the literal words "📥 Inbox" to the customer. A tap also abandons any
half-finished input, which is what a person expects from a navigation button.

New commands: `/menu` (show the console), `/payments`. `/close` now returns to
the console instead of printing a bare line.

The send confirmation now names the recipient — `✅ Sent to @username` — so it is
never ambiguous who received a reply.

## 💳 Payments section

Two different problems, clearly separated:

| Tab | Meaning | Action needed |
|---|---|---|
| ⏳ **Awaiting Binance** | The transfer exists on-chain but Binance has not credited it (`status != 1`) | None — it clears on its own |
| 🛡 **Needs review** | The deposit matched no reservation | A human decision, taken in the main bot |

### Pending deposit tracking

New table `pending_deposits`. When `verifyDepositByTxId` reports `status != 1`,
the attempt is recorded with the amount, network, on-chain age and a retry
counter. `ON CONFLICT(txid) DO UPDATE` means repeated attempts bump the counter
instead of creating duplicates, and the row is deleted the moment the deposit
clears.

Support is notified **once per deposit**, not on every retry.

The customer-facing message was also improved: it now shows the amount and
network, and states that support can already see the deposit — so they stop
opening support tickets about it, which is what the tangled log showed happening.

## Stock alerts now name the product

The alert list showed eight identical rows reading "Product is running low"
with only a timestamp to tell them apart — useless when several products are
low at once.

Cause: the product name was written into the notification `body`, but the list
screens render the `title`, which was a fixed string.

Fixed in `services/stockAlerts.js`:

| Before | After |
|---|---|
| `Product is out of stock` | `Out of stock — Netflix Premium 1 Month` |
| `Product is running low` | `Low stock (3 left) — CapCut Pro Team 1 Month` |

The low-stock title also carries the remaining quantity, so you can triage
without opening anything.

### Existing alerts are rewritten too

A one-off backfill in `database/db.js` lifts the product name out of the body of
alerts already stored, so the 17 rows currently in the list become readable
rather than only new ones. Notifications of other types are untouched.

### Duplicate icon fixed

The unread marker was 🔴, the same glyph as the out-of-stock icon, so unread
rows read `🔴 🔴 Product is out of stock`. The marker is now 🆕.

## Stock alerts: live list, not a log

Previously the section accumulated every alert ever raised — 17 rows, mostly
"running low", including products that had long since been restocked. It had
become a history nobody could act on.

It is now a **live status list** answering one question: *what is out of stock
right now?*

### What changed

| | Before | After |
|---|---|---|
| Low-stock alerts | Always on | **Off by default** (`stock_low_alerts_enabled`) |
| After restocking | Alert stayed forever | **Alert is deleted** |
| Tabs | All / Out of stock / Running low | None — one list |
| Empty state | Blank | "✅ Everything is in stock" |

`evaluateStock` now deletes a product's alerts as soon as `stock_quantity > 0`,
and re-arms the latch so a future sell-out raises a fresh one. A product that
sells out → is restocked → sells out again produces exactly two alerts, and only
ever one row in the list at a time.

### Existing rows are cleaned up

A one-off migration removes:

* every `stock_low` alert (the feature is off now)
* `stock_out` alerts for products currently back in stock
* orphaned alerts whose product was deleted

and re-arms the latches on everything currently in stock.

### Bringing low-stock alerts back

`/admin → ⚙️ Settings → 🟠 Low-Stock Alerts On/Off`, or set
`stock_low_alerts_enabled` to `1`.

---

# Part 12 — Console counters, live stock, per-customer pricing

## Support bot: every section shows its own count

The inbox and the console now carry live numbers, so you can see where the work
is without opening anything:

```
🔴 Unread conversations: 12
💳 Payments to handle: 3
📦 Deliveries waiting: 2
🔄 Refund requests: 1
🔴 Out of stock: 8
```

When everything is clear it simply says **"Nothing needs attention."**

## Refund Requests in the support bot

New section (`/refunds`, or the `🔄 Refunds` bar button) listing pending
requests with customer, order, amount, method and reason.

Deliberately **read-only**: approving a refund moves real money, so the decision
stays in the main admin panel. This screen is for triage, with a shortcut to
message the customer.

## Out-of-stock list now reads the products table

Previously it listed stored notification rows, which had to be cleaned up to
stay accurate. It is now a live query:

```sql
SELECT ... FROM products
WHERE COALESCE(stock_quantity,0) <= 0 AND is_active = 1
```

The list therefore **cannot** drift. The moment stock is added the product stops
matching and disappears — no cleanup step, nothing to go wrong. Hidden products
are excluded.

## Per-customer pricing

`/admin → 👥 Users → [user] → 💲 Special Prices`

Set with `PRODUCT_ID PRICE [note]`, e.g. `10 3.50 wholesale deal`.

Implemented as a single choke point, `productForCustomer(userId, product)`,
which swaps `product.price` before anything reads it. Because every screen and
the checkout all read that one field, the quoted price and the charged price
cannot diverge. Applied at six sites: four in the buy flow, two in the product
displays.

A negotiated price also **switches off the bulk tiers** for that customer on
that product — the agreed figure is the agreed figure, whatever the quantity.
Other customers keep their tier pricing.

`UNIQUE(user_id, product_id)` means re-setting a price updates it instead of
stacking duplicates.

## Product ordering screen made readable

The old layout packed four buttons into each row (`#N | name | ▲ | ▼`), which
squeezed names into ~22 characters — `⭐Gemin`, `☀️Accou`, `✳️claude` — and with
25 products the screen was unusable.

Now: one product per row at full width, 10 per page, with paging and a header
showing totals. Tapping a product opens a small screen with move up/down, set
exact position, and edit. After a move the list returns to the page that product
is now on, instead of bouncing back to page 1.

## Two more pre-existing bugs fixed

| Bug | Impact |
|---|---|
| `ADMIN_REFUND_AMOUNT` was handled in `admin.js` but never listed in `index.js` | The admin's typed refund amount never reached the handler — refund-by-amount silently did nothing |
| `refreshSortView()` was called with an undefined `productId` in `admin_resetorder` | Introduced during this work and caught before shipping |
