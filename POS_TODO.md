# Crest POS — Consolidated To-Do List

Open POS work only. Everything shipped, and everything deliberately decided against, moved to
[POS_DECISIONS.md](POS_DECISIONS.md) on 2026-09-01 with its rationale intact — nothing was deleted.
That file, not this one, is the record of what has already been considered.

**When an item here ships, move it to `POS_DECISIONS.md` in the same commit** rather than striking it
through in place, or this file goes back to being 92% history and stops being read as a to-do list.

**Status key:** 🔴 Missing · 🟡 Partial · 🔵 Deferred (decided to postpone) · ⚪ Open question (not engineering)

Last updated: 2026-09-09 (S711 — added B's `pos_order_items.recipe_id` missing-FK entry, found while enumerating what references `recipes`)

---

## B. Reports — compliance-adjacent

- [ ] 🟡 `sales_entries`/`purchase_entries` hard-delete on edit (accepted risk — only matters near the NRs 5 crore certification tier; `pos_orders` itself never hard-deletes once billed, verified). **Narrowed by S698 on the purchases side, not closed:** the replacement is now one transaction inside `save_purchase_bill` rather than two requests, so a bill can no longer end up holding both versions, and a bill with `payable_payments` against it is refused outright by a `BEFORE DELETE` trigger. The lines themselves are still replaced rather than superseded, so an audit trail beyond `audit_logs` would still need a version column. `sales_entries` is unchanged.
- [ ] ⚪ Tier-1 software-certification legal question (needs an accountant's answer, not code)
- [ ] 🟡 `pos_order_items.recipe_id` has **no foreign key at all** (found S711 while enumerating what
  references `recipes`). Every other referencing column is constrained one way or another —
  `sales_entries` refuses the delete, three tables cascade, `pos_kot_removals` sets null — and this
  one lets a recipe be deleted out from under its bill lines, which then point at an id that no
  longer exists. The bill itself still prints, because a line carries its own `name` and `price`
  snapshot; what breaks is anything joining back to `recipes` for a COST, so a comp on the POS
  exception report or a margin on the sales report silently values those lines at zero.
  **The page-level guard added in S711 covers the delete path in the app** (Recipe Costing counts
  POS lines before allowing a delete), which is why this is 🟡 and not 🔴 — but per S707's own
  lesson, a guard that lives only in the page is a guard on the page: the REST API still accepts
  the delete. The fix is a migration adding the FK, which has to decide between `ON DELETE SET NULL`
  (matching `pos_kot_removals`, keeps the bill line and loses the link) and a plain FK (refuses,
  matching `sales_entries` — probably right, since the two tables are the same fact recorded twice).
  Check for pre-existing orphans before adding either, or the migration fails on live data.

## B3. Quality passes on POS itself (added S652–S654, 2026-08-30)

- [ ] 🟡 `PosOrders.jsx` has no breakpoint — a two-panel flex with a fixed 320px cart, so below
  ~600px the menu side collapses to almost nothing. Deferred rather than missed: restructuring the
  live billing screen is not a layout-pass change, and the till is a tablet/desktop device today.

## B4. Timezone follow-ups left by S670

S670 pinned every clock-time *render* to `Asia/Kathmandu` (`src/shared/nepalTime.js`). Two things in
the same family were deliberately not taken, because each changes a figure rather than a label:

- [ ] 🔵 **`SalesReport.jsx` range bounds are still runtime-local.** `loadRange` builds `fromTs`/`toTs`
  with `new Date(iso + 'T00:00:00').toISOString()`, so for a viewer outside Nepal the report selects a
  slightly different **set** of bills — every tab, including the Annexure 13 One Lakh Above sheet,
  where a bill crossing a boundary can move a party across the disclosure threshold. Provably
  identical for a viewer in Nepal. Fix is `bsDayBoundaryIso()` (or a `nepalDayBoundaryIso` in
  `nepalTime.js`, since the `+05:45` literal now exists in four places). Wants its own
  before/after row-count check, which is why it was not bundled.
- [ ] 🔵 **`closed_at` is written by the till, `opened_at` by the server.** A till with a wrong clock
  can record a close before its own open; the Bill Register now flags that past a minute's tolerance
  rather than hiding it, but the only real fix is one clock. `guard_pos_order_close()` is already a
  `BEFORE UPDATE` trigger firing on exactly that transition, so `NEW.closed_at := now()` is a two-line
  addition — but it retroactively splits the column's meaning across old and new rows, so it needs a
  deliberate decision rather than a drive-by.
- [ ] 🟡 **Covers Report's Avg Turn Time silently shrinks its sample.** `if (mins < 0) continue`
  drops skewed pairs with nothing on screen saying how many, and drops nothing for an absurdly large
  positive (a bill left open for days). A footnote naming the excluded count would make it honest.

## C. Reservations — later phases (Phase 1 shipped S677, see POS_DECISIONS.md)

- [ ] 🔵 **Paid SMS confirmations / reminders** (Sparrow or Aakash, ~NPR 1.5 per SMS). Opt-in per
  client; the client must first register a sender ID with the telcos under NTA rules (business
  documents, generic IDs prohibited). Build as an Edge Function `pos-sms` holding the token in
  `client_secrets` (privilege invariant 4). Not before a client with a registered sender ID asks.
- [ ] 🔵 **Deposits / advances for party bookings.** Two things settle the shape before it is built:
  it must be a TENDER, never a discount (`payment_method` CHECKs on two tables plus the two display
  lists — the S618 loyalty rule), and Nepal VAT Act s.16 arguably makes an advance taxable when
  RECEIVED, which needs an accountant's answer and its own receipt document.
- [ ] 🔵 **Walk-in waitlist** (quote a wait, notify when ready). Shares `pos_reservations`
  (`source='walk_in'`, no fixed time); needs a notify channel, which is the SMS item above.
- [ ] ⚪ **Phone verification on the public booking page** — impossible without an SMS rail; today
  the staff WhatsApp/call IS the verification. Revisit with the SMS item.

## D. Known roadmap items

- [ ] 🟡 QR payment auto-confirmation — receiver scaffold + admin UI shipped S271/S272, 2026-07-06 (`pos_payment_webhook` Edge Function, `settings.pos_webhook_secret` config in Manage Clients → QR tab). Still needs real FonePay/eSewa merchant onboarding + their actual signature scheme before anything goes live — low priority, blocked on merchant credentials, not engineering.
- [ ] 🔴 Barcode support (structural, no current need identified)

## Not on this list (deliberately out of scope)

Full double-entry accounting / Chart of Accounts / Debtors-Creditors, multi-warehouse, batch/lot tracking, Production Entry transactions — confirmed general-ERP scope creep, not aligned with Crest's F&B cost-intelligence positioning.

## Two of these five are not engineering

⚪ Tier-1 software-certification needs an accountant's answer; 🟡 QR payment auto-confirmation needs
FonePay/eSewa merchant onboarding. Neither can be closed by a coding session, which is why both have
sat here for months being scrolled past. They belong on a business to-do list — they are kept here
only so the POS picture stays complete.

---

Shipped history and closed decisions: **[POS_DECISIONS.md](POS_DECISIONS.md)**
