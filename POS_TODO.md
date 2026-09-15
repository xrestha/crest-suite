# Crest POS — Consolidated To-Do List

Open POS work only. Everything shipped, and everything deliberately decided against, moved to
[POS_DECISIONS.md](POS_DECISIONS.md) on 2026-09-01 with its rationale intact — nothing was deleted.
That file, not this one, is the record of what has already been considered.

**When an item here ships, move it to `POS_DECISIONS.md` in the same commit** rather than striking it
through in place, or this file goes back to being 92% history and stops being read as a to-do list.

**Status key:** 🔴 Missing · 🟡 Partial · 🔵 Deferred (decided to postpone) · ⚪ Open question (not engineering)

Last updated: 2026-09-15 (S755 — five of the S754 known gaps closed in migration `20260917100000` and `admin-user-ops`; one new gap filed in A2)

---

## A. Next builds — ranked by the owner (S754, 2026-09-14)

In this order. Service charge was offered and **not** chosen.

- [ ] 🔴 **Table move / merge / split.** Moving a running order to another table, joining two
  tables onto one bill, and splitting one table's order across bills. S754 added a unique index
  allowing one open order per table (`pos_orders_one_open_per_table`), so a merge has to close or
  re-point the second order in the same transaction rather than leave two open.
- [ ] 🟡 **Crest Customization — release 1 SHIPPED (S758, critique pass S759); open follow-ups
  only.** The shipped entry, with its migrations and the browser smoke test, is in
  [POS_DECISIONS.md](POS_DECISIONS.md) → Shipped. Still open:
  - The Complimentary slip costs a comped dish at its recipe cost only; a customized dish's choice
    stock lines are not added to that figure yet.
  - Stock Movements' Sub-Recipes tab does not walk a choice's sub-recipe stock line (release 1);
    the tab says so.
  - `computeInventoryVariance` / `computeInventoryShrinkageTrend` (owner report) still sum sales
    without the POS-supersedes-manual rule the live pages apply (pre-existing), so a dish entered
    both ways counts its choices twice there, as it already did its recipe.
  - Not yet pressed on a real till after S759: the cart's choices line, the choice window's
    scroll-to-short-group on a refused Add, and the guest sheet's sticky header.
  - Release 2: combos / build-your-own bundles.
  - Deleting a **sub-recipe** that an option's stock line uses is refused by the plain FK
    `pos_option_ingredients.sub_recipe_id` with a generic message — `deleteRecipe`'s pre-check only
    looks at `recipe_ingredients.sub_recipe_id`. Safe direction (nothing is lost); needs the wording.
- [ ] 🔴 **Kitchen and bar printers.** Routing KOT/BOT to a network printer per station instead of
  the till's own print dialog. `pos_bot_categories` already decides the station.

## A2. Known gaps left by S754

The S754 migrations (`20260916100000`, `20260916110000`, `20260916120000`) and Edge Functions
(`pos-staff-login`, `admin-user-ops`) were written and tested but **not applied or deployed live**
when these were filed. Every item below assumes they are.

- [x] **Two bookings saved in the same second can hold the same table** — closed S755:
  `guard_pos_reservation_table_hold` refuses an overlapping live hold under a per-table advisory lock
  (`table_hold_overlap`), on a table link, a window move and a revival.
- [x] **Clear Occupied left no pulled-item record** — closed S755: deleting a fired open line outside
  `save_pos_order_items` writes `pos_kot_removals` ("Table cleared"), and the row now outlives its
  order (`order_id` SET NULL, `order_no`/`table_name` snapshotted).
- [x] **Credit-note amounts were trusted as sent** — closed S755: `guard_pos_credit_note` checks gross
  against the charged lines, discount and net against the bill, and the VAT split, with no second
  copy of the VAT formula (`credit_note_amounts`).
- [ ] 🟡 **The public booking rate limit trusts the first hop of `x-forwarded-for`**
  (`submit_reservation_request`), which a caller can set. S754 deliberately left it alone, because
  nobody has confirmed which hop Supabase's proxy chain appends as trusted. Confirm that first, then
  key the limit on that hop.
- [ ] 🔵 **Remove the legacy shared device key once every client has switched it off.** Code to
  remove: the `verify_pos_legacy_device` branch in `pos-staff-login`, its `PGRST202` fallback, and
  `get_pos_staff`'s secret comparison. POS Setup shows when each client's shared key was last used.
- [x] **Archiving a client did not revoke its tablet keys** — closed S755: `deleteClientDataFor` in
  `admin-user-ops` (Archive, Clear Client Data, Delete Client, the trial purge) revokes every live
  `pos_devices` key and rotates/retires the shared key first; a restored client re-activates tablets.
- [x] **A credit note's reason line printed "(no money returned)"** — closed S755: the answer is
  `pos_credit_notes.refund_method`, shown in the Credit Note Book, never printed. Notes issued before
  S755 keep their reason text as printed.
- [ ] 🟡 **Deleting an open order that still has lines is refused as "this bill is closed and
  printed"** (found S755, measured rolled back on live). `guard_pos_order_items_closed_del` is an
  AFTER STATEMENT trigger, so inside the `pos_orders` cascade it fires as `authenticated` and its
  LEFT JOIN reads the just-deleted parent as not open. Fail-closed and reached by no app path (Clear
  Occupied deletes the lines first), but the message is wrong and a direct REST delete of an open
  order cannot succeed. Fix: tell a deleted parent from a closed one inside a SECURITY DEFINER lookup
  (the S749 pattern). `record_pos_kot_removals_on_order_delete` already records that path once it can.

## B. Reports — compliance-adjacent

- [ ] 🟡 `sales_entries`/`purchase_entries` hard-delete on edit (accepted risk — only matters near the NRs 5 crore certification tier). **`pos_orders` itself cannot be deleted or edited once billed, enforced by the database since S754** (`guard_pos_order_delete` plus the closed-bill lock in `guard_pos_order_close`, migration `20260916100000`, applied live 2026-09-14). Before that it was only true because no screen offered it: a till login could delete a billed order over REST. **Narrowed by S698 on the purchases side, not closed:** the replacement is now one transaction inside `save_purchase_bill` rather than two requests, so a bill can no longer end up holding both versions, and a bill with `payable_payments` against it is refused outright by a `BEFORE DELETE` trigger. The lines themselves are still replaced rather than superseded, so an audit trail beyond `audit_logs` would still need a version column. `sales_entries` is unchanged.
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

- [ ] 🟡 **A failed offline sync tells the cashier nothing it can act on.**
  `flushPosOrderQueue` catches per order, leaves the order queued for the next flush, and reports
  the reason with `console.error` — a log, not a breadcrumb. Better placed than Stock Count was
  before S731 (`pendingOrderIds` and the conflict list are real UI, and the shape here is a retry
  rather than a silent drop), which is why this is 🟡: the order is not lost. But a sync that keeps
  failing for a reason someone could act on — a closed period, a refused RLS write, a table another
  device has since billed — says the same "still pending" as one that is merely waiting for signal,
  for ever. **Stock Count is the worked precedent, S731/S732**: collect the failures rather than
  dropping them, convert with `asActionError` at the call site, and surface them where the person
  is looking, keeping `console.error` as the floor for anything they cannot act on. Two things
  from that fix apply here and one does not — POS orders already carry a `client_id` through
  `scopedUpsert`, so the shared-device replay problem does not arise, but `navigator.onLine` is
  just as unreliable on the floor as it is in the storeroom, and `save_pos_order_items` is an
  atomic RPC, so a network failure around it is as safe to re-queue as Stock Count's upserts.
  Closes the POS half of `DOCS-REMEDIATION.md` T6 item 3.
- [ ] 🟡 `PosOrders.jsx` has no breakpoint — a two-panel flex with a fixed 320px cart, so below
  ~600px the menu side collapses to almost nothing. Deferred rather than missed: restructuring the
  live billing screen is not a layout-pass change, and the till is a tablet/desktop device today.

## B4. Timezone follow-ups left by S670

S670 pinned every clock-time *render* to `Asia/Kathmandu` (`src/shared/nepalTime.js`). Two things in
the same family were deliberately not taken, because each changes a figure rather than a label:

Both items that stood here — the Sales Report's runtime-local range bounds and `closed_at` written
by the till — were closed by S754 and moved to `POS_DECISIONS.md`.

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
