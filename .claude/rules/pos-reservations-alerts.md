---
paths:
  - "src/modules/pos/reservations/**"
  - "src/modules/pos/booking/**"
  - "src/modules/pos/kds/**"
  - "src/modules/pos/posChime.js"
  - "src/modules/pos/orders/PosOrders.jsx"
  - "src/shared/reservationSeen.js"
  - "src/components/ArrivalAlert.jsx"
  - "src/components/ArrivalAlert.css"
---

# POS reservations and the arrival alert

Split out of `.claude/rules/pos-billing.md` word for word (S770 context pass, 2026-09-17), `pos-billing.md` still loads on every POS file; this part loads only on the reservation, booking, kitchen and alert surfaces.

## Reservations: a promise about a future table, never a table state (S677)

`src/modules/pos/reservations/` and `src/modules/pos/booking/` (the public page). The rules that
are load-bearing, each with the reason it exists:

- **Bookings are DERIVED onto the floor and never write `pos_tables.status`.** That stored column
  already drifts against open orders (`PosOrders.jsx` paints occupancy from `pos_orders`, the badge
  from `t.status`); a second writer would compound it. The manual `'reserved'` toggle on Table
  Management is a separate, recordless hold and stays that way.
- **Seating is the handoff, and `seated ⇒ order_id` is a database CHECK.** `seatReservation()` in
  `PosOrders.jsx` sets covers = party size and prefills the buyer; `performSave` writes
  `order_id` + `seated` right after the `pos_orders` insert, from a REF (`seatReservationRef`),
  not state, for the same reason `savingRef` exists. `closeOrder` completes it beside the table
  release through `warnWrite()`. The Covers Report's booked-vs-walk-in split reads that link, so a
  booking contributes covers exactly once, via its order. `completed` is reachable from
  `booked/confirmed/arrived` too (a party seated offline or by hand): kept, but no covers.
- **The handoff from the page to the floor carries the FULL `pos_tables` row**, because
  `table_name` is snapshotted onto the order at first save and printed on every KOT and bill.
- **Today's floor window is the BS day plus six hours**, so a 12:15 AM booking is on tonight's
  board. The Reservations page's day view is strict. The dashboard's Bookings Tonight tile uses
  the floor's window, never the page's.
- **The public RPC `submit_reservation_request` RETURNS jsonb rather than raising** for every
  refusal that should cost quota. An exception rolls back the attempts row with everything else,
  so a refused request would burn nothing and the cheapest attack is to keep getting refused —
  `trial_signup_attempts` could record-then-fail across two HTTP requests; one SQL transaction
  cannot. Validation refusals (`closed_day`, `walk_in`, `full`, `hours`, …) sit BEFORE the
  attempts insert on purpose. **The page words every refusal itself by `code`** and uses the
  server's `message` only as a fallback: the server says "the restaurant", and a client may be a
  cafe, a bar or a banquet hall.
- **The ladder reverses in exactly two places, and only on the booking's own day (S681).**
  `no_show → arrived` ("They turned up") and `cancelled → booked` ("Reinstate"). A no-show is shown
  on every future booking form from that phone number, so a guest marked at 8:20 who walks in at
  8:25 needs a path back that is not "make a second booking and leave the mark". `stampFor(to, now,
  from)` clears the mark being left (`no_show_at`; `cancelled_at` + `cancel_reason`) in the same
  write, so the Covers Report and the Customers no-show column forget it too. `canRevive()` gates
  it to the Nepal civil day of `reserved_for` — the table says what is ever legal, the page says
  when. `completed` stays terminal: the bill that closed it is its own record. **Mark done, the
  reversals and No-show all confirm through `ConfirmModal`** with consequence copy; nothing that
  ends or revives a booking is a bare button.
- **A request is DECLINED, a booking is CANCELLED, and the two reason lists differ** because the
  decline reason is rendered on the guest's phone — "Guest cancelled" shown to a guest who asked
  and was refused is false. `DECLINE_REASONS` when `status === 'requested'`, `CANCEL_REASONS`
  otherwise; both store into `cancel_reason`.
- **The row shows ONE next step** (Confirm → Arrived → Seat) plus 💬 plus a `RowMenu`; 💬 only on
  live rows, because the template is the booking confirmation. Every `transition()` ends in a
  `role="status"` line saying what happened and, when the row belongs to another day, where it
  went — an accepted request is usually for a day other than the one on screen and used to
  simply vanish.
- **"Full" counts ACCEPTED bookings only (S754, owner decision).** `reservation_hour_load`
  (`20260916110000`) used to count a `requested` booking against the room's seats, so an unanswered
  request blocked the slot for every other guest on the public page.
- **One table cannot be held by two bookings whose windows overlap (S754, owner decision)** —
  `reservationConflicts.js`, over the same half-open `windowOf()` the floor reads, so a 6:00–7:30
  booking and a 7:30 booking on one table do not clash. **The database enforces it too (S755,
  `guard_pos_reservation_table_hold`)**, so two devices saving in the same second cannot both land.
  It is a statement trigger on `pos_reservation_tables` insert/update and on a `pos_reservations`
  update that moves a live booking's window or revives it. It takes `pg_advisory_xact_lock` per table
  in id order, then re-reads with a fresh snapshot, so the second saver is the one refused
  (`table_hold_overlap`, other booking as JSON in DETAIL, worded by `describeHoldRefusal`). The
  live-status list is written once in `pos_reservation_is_live()`, and `reservationConflicts.test.js`
  asserts it equals `LIVE_STATUSES`. The operator's restore insert is exempt. **An edit that moves
  the time releases dropped tables BEFORE the update**, or the move is refused over a table being
  removed (`ReservationModal.save`).
- **Nothing self-confirms.** A public request lands as `requested` and waits for a staff Accept;
  there is no phone verification because there is no SMS rail (POS_TODO C). The staff WhatsApp or
  call is the verification.
- **Closed wins over walk-in-only** (`normalizeReservationSettings` strips the overlap; the
  settings tab clears the other list when one is ticked). Closures are the outlet's own list —
  never derived from the HR holiday calendar, since most outlets are open on a public holiday.
- **`pos_reservations` is the schema's only table with a real `updated_at` trigger.** A new table
  wanting one attaches `touch_updated_at()`; do not write a second function.
- **Generated columns must be in `restoreClientData.js`'s `GENERATED_COLUMNS`.** Registering
  `pos_reservations.phone_canonical` there is how S677 found that `pos_customers.phone_canonical`
  never was, i.e. every restore of the customer book had been rejected since S545 while the backup
  looked complete. Any table carrying a GENERATED column needs the entry the day it is created.
- **A refused submit on the public page must SAY SO beside the button and MOVE the guest (S685).**
  On a phone the Day and Time cards are two screens above "Request this table"; an inline
  `Pick a day.` rendered there, with nothing scrolled or focused and nothing near the thumb, was
  reported as "the button does nothing" — and the three RPCs were probed live before the page
  was suspected, all fine. `validate()` therefore sets the alert beside the button
  (`missingSummary`) and `scrollIntoView` + focus on the first card or field still needed (the
  cards carry `tabIndex={-1}`, un-ringed); picking a day or a time clears the summary. Name and
  phone keep only their inline error, because those fields sit right above the button. The
  submit RPC goes through `withTimeout(…, 20000)` — a stalled call on a public page leaves the
  button on "Sending…" with no way back but a reload.
- **Anything that waits for a human Accept must feed `useNavBadgeCounts` (S686) — and a badge is
  not enough for food (S763).** The rail dot is the right weight for a booking next Tuesday. A guest
  QR ORDER is a person sitting at a table waiting to eat, and its alert lived inside
  `PosOrders.jsx`'s floor view, which does not merely go quiet on another page — it is not mounted,
  so the poll does not run. Reported from the IMS module as "no notification at all", which is
  exactly what S686 was reported as. The shell now polls it (`useGuestOrderAlerts`, 15 s, from
  `Layout.js`) and raises `ArrivalAlert`: a fixed banner with an Open Orders button, plus
  `playGuestAlert` re-sounding every 20 s until someone acts, escalating past three minutes.
  **Ask of any new waiting-for-a-human state which of the two it is** — a number someone will see
  when they next look, or a person who is waiting now.
- **Anything that waits for a human Accept must feed `useNavBadgeCounts` (S686).** The rail's
  amber dot on the HR/POS icon and the per-route `navCounts` chip in `Layout.js` are the shell's
  only alert visible from every page; a count shown on the page the item lands on, or on a
  dashboard tile's second line, was reported as "no notification" by an owner on the IMS
  dashboard. `posRequests` (reservations `status = 'requested'`) is the first POS entry; keep a
  failed count at its last value rather than zero.
- **The Reservations page opens on the whole future book, and Activity is the only view that
  says what changed (S687).** Upcoming = `reserved_for >= today`, unpaged, under day headers;
  Day is the service view. Activity orders by `updated_at DESC LIMIT 100` — `updated_at` is
  trigger-maintained on this table and on no other, which is why it can be trusted here. Only
  `created_by` is stored: the Activity label carries no actor for a confirm/seat/cancel, and a
  future `updated_by` must be set from `auth.uid()` in the trigger, never a parameter. The "new
  since you last looked" stamp is per device (`src/shared/reservationSeen.js`); the page and
  `useNavBadgeCounts` must keep counting from the SAME stamp with the SAME predicate, or the
  nav chip and the tab disagree.

## The alert that repeats, and the AudioContext that silenced it (S763)

`src/modules/pos/posChime.js` now has two exports and they are not interchangeable.
**`playChime` is for an event a person is already sitting in front of** — the guest menu's status
change, the floor's own arrival. **`playGuestAlert` is for an alert that has to carry across a room
and then REPEAT**: three rising notes played twice at roughly double the gain, `urgent` adding a
third round and a harder timbre.

**A chime that builds a new `AudioContext` per call and never closes one goes SILENT after about
six, and every chime in this product did.** Chrome caps a document at roughly six concurrent
contexts. Four call sites — the Kitchen Display, the POS floor's guest-order chime, Reservations,
and the guest's own phone — each on a screen that is opened once and left running, so the seventh
event of a service made no sound at all, with nothing on screen to say so. A guest's order walking
Placed → Confirmed → Sent → Preparing → Ready is five of the six on its own.

`getCtx()` keeps one module-level context and `resume()`s it, because a context created before a
user gesture starts suspended and a tab left alone can have one suspended under it. Verified by
counting: 9 oscillators in a 24-second window, **0 contexts created**. **Every caller now lives in
`posChime.js`** — no new inline copy, and anything that plays a sound goes through it.

**The instructive part is how long it hid.** `posChime.js`'s own header comment had enumerated the
three inline copies and explicitly declined to migrate them: *"each is on a live service screen and
none of them is wrong."* All three were wrong, identically, and it took building something that
repeats to notice. **A note saying "these duplicates are fine" is a claim about the duplicates that
nobody has re-checked since it was written** — when you find one, check the copies rather than the
comment.

`src/components/ArrivalAlert.jsx` is the banner both alerts render, and four of its properties are
load-bearing:

- **It is not a `Modal`.** A cashier mid-bill and a chef mid-service both have something in their
  hands; an alert that traps focus or blocks the screen is worse than the miss it prevents. It is
  `role="alert"` and the page behind it stays fully usable.
- **Mute silences the sound and leaves the banner standing.** The thing is still waiting, and a
  control that removes the evidence is how it gets missed a second time.
- **It reserves its own MEASURED height** (`--arrival-alert-h`, via a `ResizeObserver` — the height
  changes when the TEXT changes, which no window event reports) and `.layout-root` pads by it.
  Without that it simply covered the module nav: un-missable and un-actionable at once.
  `.app-topnav` stays `top: 0`, because a sticky offset is measured from the scrollport's CONTENT
  box and is therefore already inside that padding; repeating the variable there double-counts it
  and leaves a banner-height gap (measured, not reasoned).
- **The pulse is a class**, never an inline `animation`, which is unreachable from
  `prefers-reduced-motion`.

**Two routes suppress the shell banner**, and the reason is who can act rather than what is on
screen: `/pos/orders` answers it better already, and `/pos/kds` because the kitchen cannot Accept a
guest order and a kitchen-team login cannot even reach Orders
(`KITCHEN_TEAM_ALLOWED_PATHS`), so the button would be a dead end.

**The KDS's own standing alert fires on ANY ticket in New, and clears on Start** (owner decision).
It hardens on `WARN_MS` and again on `LATE_MS` — **the same two thresholds the card strip and the
▲/△ marks already use** — so the banner cannot disagree with the board underneath it, and its
elapsed figure rounds the way the card's own label rounds for the same reason. A new alert on this
board reuses those constants rather than choosing its own.

**That trigger was WARN_MS for about an hour, and why it changed is the rule worth keeping.** The
argument for the higher threshold was real and still is: a kitchen working through a queue always
has several tickets in New, and an alert firing every 20 seconds through normal service gets muted
on the first night and never unmuted. What it missed is that **a threshold chosen to avoid annoying
the reader is a window in which the product says nothing** — and the person who asked for the alert
sent a real ticket through, went to look, and found a board with a ticket on it and no alert, which
is the same experience that opened the session one screen along. Before quieting an alert with a
delay, ask what the reader sees during the delay; if the answer is "the thing they are waiting for,
with nothing saying so", the delay is the bug. Loudness is the owner's call to spend, and Mute is
the release valve.
