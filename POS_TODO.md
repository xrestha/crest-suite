# Crest POS — Consolidated To-Do List

Open POS work only. Everything shipped, and everything deliberately decided against, moved to
[POS_DECISIONS.md](POS_DECISIONS.md) on 2026-09-01 with its rationale intact — nothing was deleted.
That file, not this one, is the record of what has already been considered.

**When an item here ships, move it to `POS_DECISIONS.md` in the same commit** rather than striking it
through in place, or this file goes back to being 92% history and stops being read as a to-do list.

**Status key:** 🔴 Missing · 🟡 Partial · 🔵 Deferred (decided to postpone) · ⚪ Open question (not engineering)

Last updated: 2026-10-12 (S820 — stages 1–4 complete; Q19–Q23 answered; stage 4's slices 4a–4l all shipped: waves 1 (4a, 4b, 4c) and 2 (4d, 4e, 4f), then 4g (migration `20261012100000`), 4h (migration `20261012110000`), 4i (migration `20261012120000`), 4j (migration `20261012130000`), 4k (migration `20261012140000`) and 4l (app and docs only); stage 5 sliced 5a–5f and approved, Q28 (a), Q29 (b), 5a shipped (S821, `20261012150000`); stages 6–7 outlined)

---

# S809 re-analysis (2026-10-08)

The second whole-module review of Crest POS, 24 days after S754. About twenty sessions had added POS code
since then that no whole-module review had seen:

- S755's five gap fixes;
- Crest Customization and build-your-own (S758–S760);
- the Billing station (S762) and guest-order alerts (S763);
- the guest menu in the restaurant's name (S767);
- the S776 critique fixes.

Fourteen read-only area reviews covered checkout, order flow, access, shifts, credit notes, the IMS handoff,
reports, the floor and kitchen, guest QR ordering, reservations, customers and parking, Customization, the
database and the docs. A completeness pass then covered three gaps between them: multi-outlet groups
(GAP-OUTLETS), the Crest operator inside a tenant (GAP-OPERATOR), and a till living across a release or
offline (GAP-RELEASE).

Each area ran reviewer → adversarial verifier/judge. The verifier re-read the code and the LIVE function,
trigger, policy and grant bodies, and re-checked every P0 and P1 live. The main session re-checked the P0
against the live catalog itself. Nothing was written to the live database. The evidence for each ID is in
`docs/pos-review-s809/<AREA>.md`: where, what happens, evidence, fix, confidence, verification.

**Live exposure is small.** Only BLOOM CAFE (a test outlet) has POS bills: 40 closed. No POS client is
VAT-registered, none has Customization on, and only 1 booking-table link exists. So most findings are code
findings that bite once a real outlet runs the till. The few seen in live data are marked "live".

**172 findings** (165 in the fourteen area files and 7 in `GAPS.md`) make **171 rows** after merging
ORDER-FLOW-1 = CHECKOUT-9, kept at P1. That is **1 P0 · 7 P1 · 70 P2 · 93 P3**. 65 rows need a migration, and
27 owner decisions (Q1–Q27) are in S809.1. None was rejected outright. The verifiers changed about a fifth
of the severities and corrected most "What happens" lines; each file's "Verified:" lines say what.

## S809.0 Index

Stage: 1 = security, tenant boundaries and REST holes; 2 = bills, tax and stock stored or printed wrong;
3 = the floor, kitchen, guests, bookings, loyalty and report figures (lost work and wrong figures);
4 = P3 copy, docs and polish. Within a stage, P0/P1 rows go first. Mig = needs a migration.

### P0 (0 open; RESERVATIONS-1 shipped in slice 1a, see POS_DECISIONS.md)

| ID | Finding | Stage | Decision | Mig |
| --- | --- | --- | --- | --- |

### P1 (0 open; CHECKOUT-2, DATABASE-1, ORDER-FLOW-2 shipped in slices 1c–1d, ACCESS-1 in 1e, ORDER-FLOW-1 in 2a, CHECKOUT-1 in 2a–2b, GUEST-1 in 3a)

| ID | Finding | Stage | Decision | Mig |
| --- | --- | --- | --- | --- |

### P2 (0 open; shipped in stage 1: CHECKOUT-8, GUEST-4, RESERVATIONS-3, RESERVATIONS-4, DATABASE-4, DATABASE-5, CUSTOMERS-PARKING-7, SHIFTS-2, ACCESS-2, ACCESS-3, ACCESS-4, DOCS-1; in stage 2: CHECKOUT-5, CHECKOUT-7, CHECKOUT-3, CHECKOUT-4, CHECKOUT-10, CREDIT-NOTES-4, SHIFTS-1, CHECKOUT-6, REPORTS-1, CREDIT-NOTES-1, CREDIT-NOTES-2, SHIFTS-3, IMS-HANDOFF-2, IMS-HANDOFF-3, CUSTOMERS-PARKING-1, CUSTOMERS-PARKING-2, CUSTOMERS-PARKING-3, CUSTOMIZATION-1, CUSTOMIZATION-3; in stage 3: ORDER-FLOW-9, ACCESS-5, DATABASE-2, DATABASE-3, CUSTOMERS-PARKING-4, CUSTOMERS-PARKING-5, CUSTOMERS-PARKING-8, GUEST-2, GUEST-3, ORDER-FLOW-11, FLOOR-KITCHEN-2, CREDIT-NOTES-3, IMS-HANDOFF-1, FLOOR-KITCHEN-1, ORDER-FLOW-3, ORDER-FLOW-4, ORDER-FLOW-5, REPORTS-3, ORDER-FLOW-6, ORDER-FLOW-7, ORDER-FLOW-8, ORDER-FLOW-10, RESERVATIONS-2, RESERVATIONS-5, ACCESS-6, ACCESS-7, CUSTOMERS-PARKING-6, SHIFTS-4, DOCS-2, REPORTS-2, FLOOR-KITCHEN-3, IMS-HANDOFF-4, CUSTOMIZATION-2, REPORTS-4)

| ID | Finding | Stage | Decision | Mig |
| --- | --- | --- | --- | --- |

### P3 (0 open; shipped in stage 1: RESERVATIONS-12, CREDIT-NOTES-6, ACCESS-8, ACCESS-9, CHECKOUT-16, DATABASE-9, CHECKOUT-12, CUSTOMERS-PARKING-13; in stage 2: SHIFTS-7, CREDIT-NOTES-5; in stage 3: DATABASE-6, CUSTOMERS-PARKING-12, ORDER-FLOW-18, GUEST-5, GUEST-6, FLOOR-KITCHEN-5, FLOOR-KITCHEN-6, DOCS-9, DOCS-6, FLOOR-KITCHEN-10, ORDER-FLOW-13, ORDER-FLOW-14, REPORTS-8, ORDER-FLOW-12, ORDER-FLOW-15, ORDER-FLOW-16, ACCESS-11, ACCESS-12, CUSTOMERS-PARKING-16, REPORTS-12; in stage 4: SHIFTS-6, SHIFTS-8, SHIFTS-9, SHIFTS-10, SHIFTS-11, CHECKOUT-11, CHECKOUT-13, CHECKOUT-14, CHECKOUT-15, ACCESS-10, CREDIT-NOTES-7, CREDIT-NOTES-8, CREDIT-NOTES-9, CREDIT-NOTES-10, DOCS-8, REPORTS-5, REPORTS-6, REPORTS-7, REPORTS-9, REPORTS-10, REPORTS-11, SHIFTS-5, IMS-HANDOFF-5, IMS-HANDOFF-6, IMS-HANDOFF-7, IMS-HANDOFF-8, IMS-HANDOFF-9, IMS-HANDOFF-10, CUSTOMERS-PARKING-14, CUSTOMERS-PARKING-15, GUEST-8, CUSTOMERS-PARKING-9, CUSTOMERS-PARKING-10, CUSTOMERS-PARKING-11, CUSTOMIZATION-4, CUSTOMIZATION-5, CUSTOMIZATION-6, CUSTOMIZATION-7, CUSTOMIZATION-8, FLOOR-KITCHEN-4, FLOOR-KITCHEN-7, FLOOR-KITCHEN-8, FLOOR-KITCHEN-9, ORDER-FLOW-17, ORDER-FLOW-19, RESERVATIONS-6, RESERVATIONS-7, RESERVATIONS-8, RESERVATIONS-9, RESERVATIONS-10, RESERVATIONS-11, DATABASE-7, DATABASE-8, DOCS-3, DOCS-4, DOCS-5, DOCS-7, DOCS-10, DOCS-11, DOCS-12; GUEST-7 closed as accepted, Q21 (c))

| ID | Finding | Stage | Decision | Mig |
| --- | --- | --- | --- | --- |

### Gaps (0 open; GAP-RELEASE-1 shipped in slice 1b, GAP-OUTLETS-1 in 1g, GAP-OPERATOR-1 in 1l, GAP-OUTLETS-2 in 2h, GAP-OUTLETS-3 in 3n, GAP-OPERATOR-2 and GAP-OPERATOR-3 in 4k)

| ID | Finding | Sev | Stage | Decision | Mig |
| --- | --- | --- | --- | --- | --- |

## S809.1 Owner decisions (Q1–Q29)

Each has a recommended answer. Answering "all as recommended" is enough to start; name any you want
different.

**Answered 2026-10-08 (S809): every stage-1 question, all as recommended.** Q1 (b), Q2 (a), Q3 (a),
Q4 (a), Q5 (a), Q6 (a), Q7 (a), Q24 (a), Q26 (a), Q27 (c).

**Answered 2026-10-09 (S809): every stage-2 question, all as recommended** (asked in plain words).
Q8 (a), Q9 (a), Q10 (a), Q25 (a).

**Answered 2026-10-09 (S809): every stage-3 question** (asked in plain words). Q11 (a), Q14 (1), Q16 yes,
Q17 (a), Q18 (a), as recommended. Two differ from the recommendation:

- **Q12 (c):** POS managers may post waiting till bills and credit notes into Inventory too, from the POS
  side, beside the Owner and the operator. An IMS-role login that cannot post is told who can, never
  "nothing is waiting".
- **Q13 (b):** the Owner and POS managers may add or correct a points balance by hand.

**Q15 (1), settled after research** (Toast and Square both route each dish to exactly the station the
owner assigns, and a one-station café puts everything on it): an empty bar list means nothing goes to the
bar, and only NULL means the `['Beverage']` default, so a new outlet still starts with drinks at the bar.
With an empty list the till hides its BOT button, Ticket Routing says "No bar: every dish prints on the
kitchen ticket", and a category rename in Settings never adds a bar category. Q19–Q23 were answered on 2026-10-12 (below).

**Answered 2026-10-10 (S809, wave 3), both as recommended:** the monthly Owner Report counts only
guests seated at tables from the next report on, done in slice 3m (reports already made stay as they
were, with a note that the counting changed); and a dish taken off and saved, then added back, prints
"+1" so the kitchen makes it again (3e, ORDER-FLOW-13).

**Answered 2026-10-12: every stage-4 question.** Q20 (a), Q22 (a), Q23 (a), as recommended. Two differ
from the recommendation:

- **Q19 (c):** a Credit (tab) bill still earns its points at the close, but they cannot be spent until the
  bill is settled. The guide is corrected to say so.
- **Q21 (c):** no revocable table QR. Staff Accept stays the check on a guest order; GUEST-7 closes as
  accepted, with that reasoning moved to `POS_DECISIONS.md` in 4f (S814).

**Answered 2026-10-12: both stage-5 questions** (asked in plain words). Q28 (a), as recommended. One
differs from the recommendation:

- **Q29 (b):** the server-side post to Inventory is built now, as slice 5f, not left for stage 7.

**Stage 1**

- **Q1 (DATABASE-1) Who is named on a kitchen ticket?** Offline, a ticket is uploaded later by whoever is
  signed in then. (a) Always the login that uploads it: cannot be forged, but an offline ticket is credited
  to the uploader. **(b) Recommended:** keep the waiter the till recorded when that is a POS login of the
  same outlet, otherwise the uploader. This still closes the rewrite and delete holes.
- **Q2 (GUEST-4, RESERVATIONS-3) What should a locked or deactivated outlet's QR menu and booking page
  show?** **(a) Recommended:** nothing to order or book, the same page as POS switched off. (b) The menu,
  view-only, with "ordering is off right now". (c) Leave it.
- **Q3 (RESERVATIONS-4) The limit on online booking requests for the whole outlet.** **(a)
  Recommended:** keep it, but count only requests that became bookings. (b) Drop it and rely on the
  per-phone and per-connection limits. (c) Leave it.
- **Q4 (ACCESS-2) Who may stay signed in on the Kitchen Display?** **(a) Recommended:** only Kitchen/Bar
  team logins; a Front of House login there locks after 3 minutes like a till. (b) Any login, but Exit goes
  back to the PIN screen after 3 idle minutes. (c) Leave it.
- **Q5 (ACCESS-3) May a POS manager reset the PIN of someone with more powers than their own?** **(a)
  Recommended:** no, the Owner does those (the S754 rule applied to resets). (b) Yes, but every reset is
  recorded and shown to the Owner. (c) Leave it.
- **Q6 (DOCS-1) Should a PIN reset end a lockout?** **(a) Recommended:** yes; the new PIN gets five fresh
  tries. (b) No, and the till says "wait until {time}; a reset does not shorten it".
- **Q7 (ACCESS-8) Switch the old shared till key off for every client now?** No till has used it since
  2026-09-14. **(a) Recommended:** yes, all at once. (b) One client at a time by hand. (c) Leave it.

**Stage 2**

- **Q8 (CHECKOUT-1) How does a supervisor without Void clear a table rung by mistake?** **(a)
  Recommended:** an emptied bill is refused and the till says "ask someone with Void"; revisit with the
  table-move build. (b) Allow saving an empty order and let Clear Occupied remove it. (c) Let an emptied
  order close as a void for any supervisor.
- **Q9 (CHECKOUT-5) Buyer details on a Tax Invoice above NPR 10,000.** **(a) Recommended:** require name
  and address, as the till's tip already says. (b) Require them only when the guest gives a PAN. (c) Only
  warn. Worth one question to the accountant, since the research note is from secondary sources.
- **Q10 (CREDIT-NOTES-1) When a note cancels a bill because it is re-billed or was a duplicate, should
  the food go back on the shelf in Inventory?** **(a) Recommended:** the note asks "Was this food served to
  this customer, or is it billed again / a duplicate?", and the second answer puts the stock back. (b) A
  "Re-issue to the right customer" action instead, still needing (a) for duplicates. (c) Keep it, and tell
  owners Variance reads low by that food.

**Stage 3**

- **Q11 (GUEST-1) Where does a guest's order-wide note go?** **(a) Recommended:** onto each dish of that
  order. No migration, and it reaches the ticket and the KDS today; a long note repeats per dish. (b) A
  ticket-level note printed once at the top (a new field on the ticket log). (c) The guest page takes a
  note per dish instead.
- **Q12 (CREDIT-NOTES-3, IMS-HANDOFF-1) Who posts waiting till bills and credit notes into Inventory?**
  **(a) Recommended:** the Owner and the operator, now. Hide the button from IMS-role logins and reword the
  instructions. Add a server-side post later. (b) IMS supervisors and managers too, through a new database
  function (migration). (c) POS managers too, from the POS side.
- **Q13 (CUSTOMERS-PARKING-5) Who may add or correct a points balance by hand?** **(a) Recommended:** the
  Owner only; a point is money at the till. (b) The Owner and POS managers.
- **Q14 (FLOOR-KITCHEN-1) Should a locked till announce a waiting guest order?** **(1) Recommended:** yes;
  the PIN screen checks through the tablet's own key, since it is every PIN till's resting state. (2) No;
  the Kitchen Display raises guest orders and the cook calls the floor. (3) No change; Help says one
  email-login device must stay off the Orders page.
- **Q15 (FLOOR-KITCHEN-3) What does "every category to Kitchen" mean?** **(1) Recommended:** exactly that;
  Beverage stops going to the bar. (2) Keep Beverage to the bar, and POS Setup refuses an all-Kitchen save
  with a sentence saying why.
- **Q16 (ORDER-FLOW-6) Wi-Fi up but internet down: should a failed send queue and print anyway?**
  **Recommended: yes**, the Stock Count answer from S731. The kitchen gets its ticket, and the replay is
  already safe against conflicts. The alternative is to keep refusing until the browser itself says offline.
- **Q17 (ACCESS-5) What does removing a leaver's POS login do?** **(a) Recommended:** block the login and
  keep the name on past bills; Delete only a login with no bills. (b) Keep Delete, but the confirm says the
  name leaves past bills. (c) Copy the staff name onto bills and shifts (migration).
- **Q18 (ACCESS-7) Should locking one till sign the waiter out of the others?** **(a) Recommended:** no;
  a lock ends only that till's session, and revoking a tablet ends the sessions opened on it. (b) Yes, but
  the other till notices at once and keeps its cart. (c) Leave it.

**Stage 4**

- **Q19 (CUSTOMERS-PARKING-9) When does a Credit (tab) bill earn points?** (a) At the close, as now, with
  the guide corrected. **(b) Recommended:** when it is settled, since points follow money received, as the
  guide already promises. (c) At the close, but not spendable until settled.
- **Q20 (CUSTOMIZATION-5) Should a "No onion" use up a free pick or a place under the maximum?** **(a)
  Recommended:** no; removals never count. (b) Keep the rule and document it. (c) Refuse removals in a group
  with free picks.
- **Q21 (GUEST-7) A table QR link that can be revoked?** **(a) Recommended:** a per-table token with a
  "New QR code" button; only the reprinted table changes. (b) QR ordering only while the table has an open
  bill. (c) Accept it; staff Accept is the check.
- **Q22 (REPORTS-5) Should the dashboards follow the Sales Report's credit-note rule?** **(a)
  Recommended:** yes; the bill stays on its day and the note is a minus on its issue day. (b) Keep dropping
  credited bills, but correct the comments and say so on the tile.
- **Q23 (RESERVATIONS-7) May a mistaken cancel be undone before the booking's day?** **(a) Recommended:**
  yes, until the end of the booking's day, as the dialog already promises. (b) Keep the own-day rule and
  reword the dialog.

**Stage 5**

- **Q28 (S782 grants) How far should the clean-up of unused database permissions go?** The browser logins
  hold powers no screen uses (empty a table, lock it, hang a trigger on it); none is reachable through the
  app today. **(a) Recommended:** every table, and new tables start without them. (b) Only the five POS
  tables the outline named.
- **Q29 (IMS-HANDOFF, 4e) Should the server send a paid bill to Inventory itself, as part of the close?**
  Today the till sends it, and a bill whose send failed waits for a manager to send it from the floor.
  **(a) Recommended:** later, with the stage-7 builds; it is a new feature, not a safety fix. (b) Now, as a
  sixth stage-5 slice.

**From the gap pass**

- **Q24 (GAP-OUTLETS-1, stage 1) Should a till follow its login to another outlet at all?** **(a)
  Recommended:** never. It stops with a notice until the login is switched back, because the tablet knows
  which counter it stands at and the login does not. Help and the group guide add: a till that must keep
  billing while the Owner looks at another outlet needs a login of its own. (b) It follows, but parks the
  cart and names the till in the notice. (c) Leave it, and tell group Owners to run tills on PIN logins only.
- **Q25 (GAP-OUTLETS-2, stage 2) After an HQ push, whose call is "On POS" for a dish?** **(a)
  Recommended:** the branch's own. (b) HQ's, but never on a dish with no price. (c) A separate "menu
  availability" in the push, off by default.
- **Q26 (GAP-OPERATOR-1, stage 1) May Crest support issue a credit note or record drawer cash that the
  database refuses to the Owner?** **(a) Recommended:** no. Outside a restore, the operator meets the same
  integrity checks; the operator stays exempt from rank rules (S754). These checks protect the tax record,
  not a rank boundary. (b) Yes, but the screen warns first.
- **Q27 (GAP-RELEASE-1, stage 1) How eagerly should a till take a new release?** (a) It reloads itself at
  the PIN screen and on an idle floor. (b) A "New version — reload" banner, and staff choose. **(c)
  Recommended:** (a), plus a database check that tells a too-old till to reload before it writes under
  changed rules (migration), for releases that change what the till sends.

## S809.2 Fix stages

Split each stage into slices of one migration each before starting, as S798 did, one short chat per slice.
Rows that touch the same table or function ship together:

- CHECKOUT-8 with CREDIT-NOTES-6;
- CHECKOUT-4 with CREDIT-NOTES-4;
- GUEST-4 with RESERVATIONS-3;
- GUEST-3 with ORDER-FLOW-11;
- SHIFTS-5 with REPORTS-7.

- **Stage 1: close the doors.** RESERVATIONS-1 first, then CHECKOUT-2, DATABASE-1, ORDER-FLOW-2 and
  ACCESS-1. After those, the remaining stage-1 rows above.
- **Stage 2: bills, tax and stock right.** CHECKOUT-1 and ORDER-FLOW-1 first.
- **Stage 3: the floor, kitchen, guests, bookings, loyalty and report figures.** GUEST-1 first, with
  ORDER-FLOW-9 (both are allergy notes not reaching the kitchen).
- **Stage 4: P3 copy, docs and polish.** Pull a P3 forward into an earlier slice when that slice already
  edits its file.

**Stage 1 slices (owner approved 2026-10-08).** GAP-RELEASE-1 moved up to slice 2. Every later slice
changes what the database accepts, and a tablet still running the old code would start having its saves
refused mid-service. RESERVATIONS-1 changes nothing the till sends, so it still goes first. After slice 2
ships, reload every till by hand once. Each slice re-reads the live body of any function an earlier slice
changed.

| # | IDs | Migration | Edge Function | Decisions |
| --- | --- | --- | --- | --- |
| 1a ✅ | RESERVATIONS-1, RESERVATIONS-12 (shipped 2026-10-08, `20261008120000` live) | hold guard, composite FKs, `order_id` same-client trigger, `created_by` stamp | — | — |
| 1b ✅ | GAP-RELEASE-1 (shipped 2026-10-09, `20261009100000` live) | `pos_min_till_build()` floor (NULL) + `pos_till_build_gate` statement triggers; the till reloads itself | — | Q27 |
| 1c ✅ | CHECKOUT-2, CHECKOUT-8, CREDIT-NOTES-6 (shipped 2026-10-09, `20261009110000` live) | `guard_pos_order_close` A+B, `pos_orders` CHECK, `guard_pos_credit_note` | — | — |
| 1d ✅ | DATABASE-1, ORDER-FLOW-2 (shipped 2026-10-09, `20261009120000` live) | `pos_kot_log` / `pos_kot_removals` guards, `save_pos_order_items`, `guard_pos_item_price` | — | Q1 |
| 1e ✅ | ACCESS-1, ACCESS-2 (shipped 2026-10-09, app only) | none | — | Q4 |
| 1f ✅ | ACCESS-3, DOCS-1 (shipped 2026-10-09) | none | `admin-user-ops` | Q5, Q6 |
| 1g ✅ | ACCESS-4, GAP-OUTLETS-1 (shipped 2026-10-09, `20261009130000`; pos-staff-login left alone, owner 2026-10-09) | `set_active_outlet`, `set_outlet_access` | — | Q24 |
| 1h ✅ | GUEST-4, RESERVATIONS-3, RESERVATIONS-4 (shipped 2026-10-09, `20261009140000` live; five guest functions gated, not three) | access helper, 3 guest-menu and 3 booking functions | — | Q2, Q3 |
| 1i ✅ | DATABASE-4, DATABASE-5, CUSTOMERS-PARKING-7 (shipped 2026-10-09, `20261009150000` live) | `guard_pos_order_payments_closed`, `pos_customers_guard_loyalty`, ledger FK | — | — |
| 1j ✅ | ACCESS-8, ACCESS-9, CHECKOUT-16, DATABASE-9 (shipped 2026-10-09, `20261009160000` live) | retire the shared key, drop 2 dead RPCs, rank checks, comp quantity | — | Q7 |
| 1k ✅ | CHECKOUT-12, CUSTOMERS-PARKING-13 (shipped 2026-10-09, `20261009170000` live) | payment-confirmation guard, parking-slip trigger and unique number | — | — |
| 1l ✅ | SHIFTS-2, GAP-OPERATOR-1 (shipped 2026-10-09, `20261009180000` live) | `pos_shifts_guard` or `close_pos_shift`, `pos_cash_movements_guard`, `guard_pos_credit_note`, restore flag | — | Q26 |

ACCESS-8 needs a migration (it drops `get_pos_device_secret`), although the index above says no. If 1l is
too big for one chat, split it: SHIFTS-2 with the operator change for the two shift guards, then the
remaining guards.

**Stage 2 slices (owner approved 2026-10-09; Q8, Q9, Q10, Q25 all (a)).** 2a goes first: it fixes both P1s
in the browser with no migration. `guard_pos_order_close` changes in 2b, 2c and 2g, so those three ship in
that order and each starts from the live body the one before left. Two P3s and three S809.4 items are pulled
forward because their functions are rebuilt here anyway.

| # | IDs | Migration | Decisions |
| --- | --- | --- | --- |
| 2a ✅ | CHECKOUT-1 (till half), ORDER-FLOW-1 (= CHECKOUT-9), CHECKOUT-5 (shipped 2026-10-09, app only, crest-v417) | none: the till's settings read, the Bill Register view, `closeBlocker` | Q8, Q9 |
| 2b ✅ | CHECKOUT-1 (server half), CHECKOUT-3, CHECKOUT-4, CREDIT-NOTES-4, CHECKOUT-10, SHIFTS-1 (database half), SHIFTS-7 (P3); S809.4: `apply_pos_item_comps`' skipped partial row (shipped 2026-10-09, `20261009190000` live, crest-v419) | `guard_pos_order_close` (empty bill, open shift `FOR SHARE`, invoice year from the Nepal date), `guard_pos_credit_note` (year), `apply_pos_item_comps` (year, `comped` filter), `pos_cash_movements_guard` (`FOR SHARE`), `pos_shifts_guard` (`closed_at := now()`) | Q8 |
| 2c ✅ | CHECKOUT-6, REPORTS-1, CREDIT-NOTES-5 (P3) (shipped 2026-10-09, `20261009200000` live, crest-v420) | `pos_orders.vat_registered`, stamped at the close (after 2b) | — |
| 2d ✅ | CHECKOUT-7 (shipped 2026-10-09, app only, crest-v418) | none: the close read-back path | — |
| 2e ✅ | CREDIT-NOTES-1, CREDIT-NOTES-2, SHIFTS-3; S809.4: a note's `created_at` is the server's (shipped 2026-10-09, `20261009210000` live, crest-v420) | link trigger on `pos_credit_notes`; a restock `sales_entries` source and `ims_stock_movements_guard` | Q10 |
| 2f ✅ | IMS-HANDOFF-2, IMS-HANDOFF-3 (shipped 2026-10-09, `20261009220000` live, crest-v420; BLOOM's bill 40 was gone, so the repair marked 0) | `sales_entries` stamp trigger (and BLOOM bill 40's stamp); DEFINER depletion and comp-cost reads | — |
| 2g ✅ | CUSTOMERS-PARKING-1, -2, -3 (shipped 2026-10-09, `20261009230000` live, crest-v421; BLOOM's 188 partner points were already gone with the data clear) | `award_loyalty_points` / `redeem_loyalty_points`; `guard_pos_order_close` (a standing Loyalty leg, after 2c); point value > 0 | — |
| 2h ✅ | CUSTOMIZATION-1, CUSTOMIZATION-3, GAP-OUTLETS-2; S809.4: comped rows in `before_sent`/`stored_sent` (shipped 2026-10-09, `20261009240000` live, crest-v421) | `save_pos_order_items` (a must-choose dish with no choices, an unpriced new line), `push_master_data` (the branch keeps On POS and Active) | Q25 |

**Stage 3 slices (owner approved 2026-10-09; Q11–Q18 answered, see S809.1).** No database object is
rebuilt in more than one stage-3 slice, so no function forces an order. `PosOrders.jsx` is edited by 11
slices: merge 3a → 3b → 3c → 3e → 3f → 3g → 3o (3j, 3k, 3l, 3m touch other regions). Also 3a before 3d
(KitchenDisplay.jsx, posSignals.js), 3c before 3h (Layout.js, PosLogin.jsx), 3j before 3n
(ClientDashboard.jsx). Bracketed IDs are P3 rows or S809.4 items pulled forward. Found by the split:
IMS-HANDOFF-4's "fails above ~200–400 bills" half was closed by S810 (8a656b68), and FLOOR-KITCHEN-2
needs a migration since 1d made cancelling a ticket Supervisor-only.

| # | IDs | Migration | Decisions |
| --- | --- | --- | --- |
| 3a ✅ | GUEST-1, ORDER-FLOW-9 (shipped 2026-10-09, app only, crest-v423) | none; a change-only ticket shows as a CHANGE card that "Seen" moves to served | Q11 |
| 3b ✅ | GUEST-2, GUEST-3, ORDER-FLOW-11 [ORDER-FLOW-18, GUEST-5, GUEST-6] (shipped 2026-10-10, `20261010120000` live, crest-v426; the till build floor stays NULL) | `submit_guest_order` (a 5th argument, the 4-argument form dropped), a guard on `pos_guest_order_requests`; raise `pos_min_till_build` only once `x-crest-build` is proven to reach `request.headers` | — |
| 3c ✅ | FLOOR-KITCHEN-1 [FLOOR-KITCHEN-10, DOCS-6; S809.4: the alert rang on the till that accepted] (shipped 2026-10-10, `20261010150000` live, crest-v427) | a tablet-key read of waiting guest orders for the PIN screen | Q14 |
| 3d ✅ | FLOOR-KITCHEN-2 [FLOOR-KITCHEN-5, FLOOR-KITCHEN-6] (shipped 2026-10-10, `20261010130000` live, crest-v426) | `guard_pos_kot_log`: a kitchen login may cancel a ticket whose every line was pulled; stage times are the server's | — |
| 3e ✅ | ORDER-FLOW-3, -4, -5 [ORDER-FLOW-13, -14] (shipped 2026-10-10, app only, crest-v427; ORDER-FLOW-4 took the app-only form) | none | — |
| 3f ✅ | ORDER-FLOW-6, -7, -8 [ORDER-FLOW-15, -16; owner decision Q2 of 2026-10-10] (shipped 2026-10-10, app only, crest-v428) | none (ORDER-FLOW-8's pulled-item record can't be written from the browser since 1d) | Q16 |
| 3g ✅ | ORDER-FLOW-10, RESERVATIONS-2, RESERVATIONS-5 [ORDER-FLOW-12] (shipped 2026-10-10, app only, crest-v428) | none | — |
| 3h ✅ | ACCESS-6, ACCESS-7 [ACCESS-11, ACCESS-12; the legacy shared-key code, its DROPs in a later migration] (shipped 2026-10-10, `20261010180000` live, pos-staff-login v10, admin-user-ops v66, crest-v428; the DROP file `20261010190500` applied live 2026-10-12, S812) | sessions recorded per tablet, `revoke_pos_device` ends them; `pos-staff-login` deploy | Q18 |
| 3i ✅ | ACCESS-5, DATABASE-2, DATABASE-3 [DATABASE-6] (shipped 2026-10-09, `20261010100000` live, admin-user-ops v65, crest-v424) | a POS block marker read by `pos_caller_has_rank`; `admin-user-ops` deploy | Q17 |
| 3j ✅ | CREDIT-NOTES-3, IMS-HANDOFF-1 [DOCS-9] (shipped 2026-10-10, `20261010140000` live, crest-v426) | maybe: whatever a POS manager needs to post from the POS side | Q12 |
| 3k ✅ | CUSTOMERS-PARKING-4, -5, -8 [CUSTOMERS-PARKING-12] (shipped 2026-10-09, `20261010110000` live, crest-v424) | `award_`/`redeem_loyalty_points` match `phone_canonical`, a unique key on it (the raw-phone key kept for older tills), new `adjust_loyalty_points` | Q13 |
| 3l ✅ | CUSTOMERS-PARKING-6, SHIFTS-4, DOCS-2 [CUSTOMERS-PARKING-16] (shipped 2026-10-10, app only, crest-v428) | none | — |
| 3m ✅ | REPORTS-2, FLOOR-KITCHEN-3, IMS-HANDOFF-4 (credit-noted bills) [the Owner Report's covers count seated guests from the next report, owner 2026-10-10; a `CURRENT_SCHEMA_VERSION` bump] (shipped 2026-10-10, app only, crest-v428; Owner Report schema 15) | none | Q15 |
| 3n ✅ | REPORTS-3, GAP-OUTLETS-3 [REPORTS-8] (shipped 2026-10-10, `20261010170000` live, crest-v427) | `get_group_summary` | — |
| 3o ✅ | CUSTOMIZATION-2, REPORTS-4 [REPORTS-12] (shipped 2026-10-10, app only, crest-v428) | none | — |

Wave 1 (drafted together, no shared database object or code region): 3a, 3i, 3k — all shipped 2026-10-09.
Wave 2: 3b, 3d, 3j — all shipped 2026-10-10. Wave 3: 3c, 3e, 3n — all shipped 2026-10-10. Wave 4: 3f,
3g, 3h, 3l, 3m, 3o — all shipped 2026-10-10 (crest-v428). **STAGE 3 COMPLETE.** ✅ `20261010190500`
(the shared key's four functions) applied live and committed on 2026-10-12 (S812, 04ebdb0e).

**Stage 4 slices (owner approved 2026-10-12; Q19 (c), Q20 (a), Q21 (c), Q22 (a), Q23 (a)).** App-only
slices first, then migrations (each planned first), Help and docs last because every other slice changes
what they should say. Bracketed items are S809.4 follow-ups pulled in because the slice already edits
that file.

| # | IDs | Migration | Decisions |
| --- | --- | --- | --- |
| 4a ✅ | SHIFTS-6, -8, -9, -10, -11 [a server `no_open_shift` keeps the cached shift id] (shipped 2026-10-12, app only, crest-v429) | none | — |
| 4b ✅ | CHECKOUT-11, -13, -14, -15, ACCESS-10 [`viewPosBill.js`' dropped name-read error; Billing station's loyalty note and Recent Bills way; Billing "Open Orders" unsaved-changes guard] (shipped 2026-10-12, app only, crest-v429; ACCESS-10 as wording only, owner) | none | — |
| 4c ✅ | CREDIT-NOTES-7, -8, -9, -10, DOCS-8 [Credit Note Book reprint labels from page-open list, app half] (shipped 2026-10-12, app only, crest-v429) | none | — |
| 4d ✅ | REPORTS-5, -6, -7, -9, -10, -11, SHIFTS-5 [B4 Covers Avg Turn Time; Manual Sales by Category counting `pos_credit`; Sales Report / Exceptions comp food cost] (shipped 2026-10-12, app only, crest-v430; Owner Report schema 16; owner D1–D3) | none | Q22 |
| 4e ✅ | IMS-HANDOFF-5, -6, -7, -8, -9, -10 [`imsPostWarning` never decreases; `writeSalesEntries` links by screen `orderId`] (shipped 2026-10-12, app only, crest-v430; owner D4–D7) | none | — |
| 4f ✅ | CUSTOMERS-PARKING-14, -15, GUEST-8; GUEST-7 closed as accepted [Guest Menu Preview wording] (shipped 2026-10-12, app only, crest-v430; owner D8–D10) | none | Q21 |
| 4g ✅ | CUSTOMERS-PARKING-9, -10, -11; owner additions: one-tap "add the points this bill earned", "Move points" [full points history; "+977" bill-history search] (shipped 2026-10-12, S815, migration `20261012100000` applied live, crest-v431; owner D11–D14) | yes | Q19 |
| 4h ✅ | CUSTOMIZATION-4, -5, -6, -7, -8; owner addition: grey "no longer offered" note [`handleSaveRefusal` said "The menu has been reloaded" before the reload ran] (shipped 2026-10-12, S816, migration `20261012110000` applied live, crest-v432; owner D15–D17) | yes | Q20 |
| 4i ✅ | FLOOR-KITCHEN-4, -7, -8, -9, ORDER-FLOW-17, -19 [Ticket Routing hides dishless bar categories; a waiting guest QR order when its bill closes] (shipped 2026-10-12, S817, migration `20261012120000` applied live, crest-v433; owner D18–D21) | yes | — |
| 4j ✅ | RESERVATIONS-6, -7, -8, -9, -10, -11 [Table Management's dead "skewed by bills left open" note removed; a refused Seat hand-off no longer stays armed] (shipped 2026-10-12, S818, migration `20261012130000` applied live, crest-v434; owner D22–D26) | yes | Q23 |
| 4k ✅ | DATABASE-7, -8, GAP-OPERATOR-2, -3 [operator bypasses `guard_pos_kot_log` on UPDATE; `pos_parking_slips_guard` operator INSERT; B's `pos_order_items.recipe_id` FK] (shipped 2026-10-12, S819, migration `20261012140000` applied live, crest-v435; owner D27–D30) | yes | — |
| 4l ✅ | DOCS-3, -4, -5, -7, -10, -11, -12 [KOT button Tip; Owner Report Avg Bill Value Tip; `pos-billing.md` periods-backfill sentence, already rewritten in 2f] (shipped 2026-10-12, S820, app and docs only, crest-v436) | none | — |

Wave 1 (app only, no shared code region): 4a, 4b, 4c — all shipped 2026-10-12. Wave 2: 4d, 4e, 4f — all shipped 2026-10-12 (S814). Then 4g–4k one at a time, 4l last: 4g shipped 2026-10-12 (S815), 4h shipped 2026-10-12 (S816), 4i shipped 2026-10-12 (S817), 4j shipped 2026-10-12 (S818), 4k shipped 2026-10-12 (S819), 4l shipped 2026-10-12 (S820). **Stage 4 is complete.**

**After stage 4 (owner approved 2026-10-12):**

- **Stage 5, database hardening (all migrations):** sliced below (owner approved 2026-10-12).
- **Stage 6, till reliability (app only):** B3 offline sync failure message; unknown-close marks lost on
  reload; a self-ended session drops the unsent cart; offline tickets with null `order_no`; 5xx read as a
  refusal; KDS error wording; "Discard unsaved" copy during a send; unbounded reads (PosCustomers,
  `placeOrder` re-read); 30 s queue after one no-answer; note change on a partly sent line; B3 live clicks.
  Polish found in 4c: the credit note prints its figures with `toFixed` (no comma grouping) where the
  bill uses `npr2`; the Credit Note Book's Date cell shows day and month only, with no year.
- **Stage 7, new builds (owner ranking, section A):** table move/merge/split; Customization follow-ups;
  kitchen and bar printers.
- **Later:** section C, section D, the ⚪ questions.

**Stage 5 slices (owner approved 2026-10-12; Q28 (a), Q29 (b)).** Every slice is a migration, and no
database object or app file is changed by two slices except `ims_sales_entries_guard` (5d, then 5f from
5d's live body). This machine has no local Postgres, so each file checks the live bodies by md5 and runs its
rolled-back probe inside the apply (S819's shape). 5a and 5b go first, because 5b's probe decides 5b's
rate-limit key and whether 5c raises the till build floor. Then 5c, 5d, 5e and 5f, one at a time.

| # | IDs | Migration | Decisions |
| --- | --- | --- | --- |
| 5a ✅ | S782 grants (shipped 2026-10-12, S821, `20261012150000` applied live, migration only): TRUNCATE/REFERENCES/TRIGGER live on 19 tables (`pos_cash_movements`, `pos_loyalty_ledger` among them), MAINTAIN on about 80 (`pos_parking_slips`, `pos_payment_confirmations`, `pos_guest_order_requests` among them) | revoked from anon, authenticated and PUBLIC on every public table; the schema's default privileges stop handing them to new tables | Q28 |
| 5b | A2 rate-limit first hop; A2 delete-open-order message; 4g `pos_customer_phone_locked` names Move | a throwaway header probe first (created, called with a set `x-forwarded-for` and `x-crest-build`, dropped); `submit_reservation_request` keyed on the trusted hop (or left, with the reason recorded); `guard_pos_order_items_closed_del` tells a deleted parent from a closed one (S749 DEFINER lookup); the phone-lock sentence | — |
| 5c | `credit_settled_at := now()`; the `credit_settlement` unique index; the close pins its priced lines (`items_version`, after checking what bumps it); a Split bill's legs inside the shift lock; a void's `shift_id` from the open shift (4a's browser read files it today); raise `pos_min_till_build()` | `guard_pos_order_close`, `pos_shifts_guard`, a partial unique index on `pos_cash_movements`; a second file raising the floor after the deploy, only if 5b's probe sees `x-crest-build` | — |
| 5d | CREDIT-NOTES-5 server half (`original_invoice_*` from the bill); the server-side credit-note print counter (the parking slip's `OLD.print_count + 1`); `ims_sales_entries_guard` checks a `pos_credit` row's note and refuses till rows for a client without Inventory (4e); 2f: a comp-cost read IMS logins may use (`viewPosBill.js`, `loadDeltaExplosion`) | `guard_pos_credit_note`, `ims_sales_entries_guard`, a new DEFINER read | — |
| 5e | `settings_guard_staff_roles` raw ranks; `set_active_outlet` home outlet; B3 `admin-user-ops` discount-limit default; `pos-staff-login`'s pre-S791 fallback; the retired key columns (`AuditLog.js`, `revokeClientTablets`) | those two functions; `admin-user-ops` and `pos-staff-login` deploys; a second file dropping `client_secrets.pos_device_secret`, `pos_legacy_key_retired_at`, `pos_legacy_key_last_used_at` after both deploys | — |
| 5f | 4e: the server posts a closed bill to Inventory from the stored bill in the close's transaction (replacing `postClosedBill`'s browser read); posting a POS-only outlet's past unmarked bills when Inventory is switched on | its own plan first: the depletion walk lives only in `recipeCost.js` ("never a SQL copy of it", `pos-billing.md`), so a server post needs a SQL copy of it or another shape; may take more than one migration | Q29 |

Closed without work: S809.4's `pos_customers` audit trigger (1i) shipped in 3k. Not in stage 5 unless the
owner pulls them in: an FK on `pos_orders.table_id` (4k, needs a decision on deleting a table with bill
history), refusing an order on an inactive table (4i, "if it shows up"), and
`pos_payment_confirmations.matched_order_id`'s NO ACTION key (latent until auto-confirm is live).

**Added to stage 4 by the owner (2026-10-09, 2026-10-10):**

- **One-tap "add the points this bill earned"** on a bill whose award did not land (the till said
  points were not added): works out the exact points from the bill and its scheme, and is reversed by
  a Credit Note on that bill like an ordinary award. Today a manager works the number out and types it
  into Adjust, and a later Credit Note does not take those hand-added points back (3k).
- **"Move points" for a regular's new number**: one action that takes the balance off the old number
  and puts it on the new one, recorded as a pair. Today it is two hand corrections in Adjust (3k).
- ~~**A grey "no longer offered" note on a saved-but-unsent dish** whose choice was hidden since (owner
  2026-10-10, Q3 (b), later): "Granola is no longer offered", blocking nothing. 3o marks only lines not
  yet saved, because a saved line keeps its exemption on the server.~~ Shipped in 4h (S816,
  `savedLineGoneNote`).

## S809.3 Outside POS, filed here

- **IMS count PIN:** a reset leaves the lockout in place, as DOCS-1 does for POS (re-checked by the 1f
  drafter, 2026-10-09: `reset_ims_pin` clears no lock). Same fix as 1f: `record_ims_pin_attempt(true)`
  after `updateUserById`, an audit row (`kind: 'ims_count'`), `ImsStaff.jsx` handling `lockout_cleared:
  false`; `Help.js` ("reset their PIN immediately") and `ImsCountLogin.jsx` are untrue until then. **HR
  Self-Service has no such gap here** (no reset action: Remove + Enable makes a new login); check
  hss-suite's own reset path on its side before filing anything in CROSS-REPO.
- **IMS gate passes have the parking slip's numbering hole** (found by the 1k drafter):
  `ims_gate_pass_void_guard` does not clear a browser-sent `pass_no`, there is no `UNIQUE (client_id,
  pass_no)` (live: 3 rows, 0 duplicates), and vehicle, notes and print count are editable.
- **Trial signup gives a working login before approval** (part of RESERVATIONS-1's reach): RLS honours a
  pending trial's JWT. This is the documented "UI gate, not a security boundary" (`subscription-access.md`).
  RESERVATIONS-1 does not need it changed, but any other cross-tenant read would be reachable the same way.

## S809.4 Found while fixing stage 1 (2026-10-09, not fixed)

- **Legacy shared-key code** (1j): ~~every client's shared key is now off, so delete `pos-staff-login`'s
  legacy branch and PGRST202 fallback, PosLogin's `get_pos_staff` path, the Pos.js legacy notice and the
  Till Devices shared-key panel,~~ fixed in 3h; ~~then drop `get_pos_staff`, `verify_pos_legacy_device`,
  `retire_pos_legacy_device_key`, `pos_legacy_device_key_status` (written in 3h as `20261010190500`,
  applied a day after the release; `auth-and-pins.md`).~~ Dropped 2026-10-12 (S812, 04ebdb0e).
- `settings_guard_staff_roles`' HR, IMS, travel-claim and weather-city lines still test raw ranks, so a
  settlement-blocked login passes them for the hour its token lives (1j did the POS lines).
- ~~`apply_pos_item_comps` skips a `p_partial` row whose line is not found (`CONTINUE`) and still returns an
  NC number, so the till could print an empty comp slip (1j).~~ Fixed in 2b: the whole call is refused
  (`pos_comp_line_missing`).
- `pos_payment_confirmations.matched_order_id` is NO ACTION: once auto-confirm is live, Clear Occupied of a
  bill holding an unused matched confirmation is refused by that key. `pos-payment-webhook` drops the error
  of both its reads (1k).
- ~~Grants hygiene (the S782 trap): `anon` MAINTAIN on `pos_parking_slips` / `pos_payment_confirmations`,
  and TRUNCATE/REFERENCES/TRIGGER on `pos_cash_movements` (1k, 1l).~~ Fixed in 5a (S821), on every table.
- ~~`pos_customers` has no audit trigger, so enrolment changes leave no record; `supabase-sql.md`'s
  `updated_at` table is wrong about it (the till's upsert writes it from the tablet clock) (1i).~~ Both
  fixed in 3k: three enrolment audit triggers, and the table row now says the tablet's clock.
- ~~Credit Note Book reprint labels from the list loaded at page open, so two managers reprinting one note
  print the same copy number (the stored count is right since 1c) (1c).~~ App half fixed in 4c: the
  reprint reads `print_count` just before printing (`nextCreditNoteCopy`). Two reprints at the same
  instant can still share a number until the server keeps the counter (stage 5).
- ~~Kitchen stage times (`started_at`/`ready_at`/`served_at`) are still tablet-supplied, so prep times
  can be shaded (1d).~~ Fixed in 3d: the server stamps each on entering its stage.
- ~~Admin → Guest Menu Preview quotes "This menu isn't available right now"; the guest page says "This menu
  isn't available" (1h).~~ Fixed in 4f: both read `MENU_UNAVAILABLE` / `ORDERING_OFF_TEXT`.
- ~~One-line pulls-forward, now that their functions were rebuilt: SHIFTS-7 (`NEW.closed_at := now()` in
  `pos_shifts_guard`) and SHIFTS-1's database half (`FOR SHARE` on the shift read in
  `pos_cash_movements_guard`) (1l).~~ Both shipped in 2b.
- Sign-out scope: the Owner's and admin's account-menu Sign out, and Crest Staff's (shared with
  hss-suite), are still `global`, so signing out on a shared device ends that login on every device
  (ACCESS-7's shape). An Owner left on a wall KDS never locks, and its Exit opens the till as the
  Owner; Help should steer wall screens onto a Kitchen login (1e).
- ~~A Release reload restarts the idle clock, so a till locks at about 4 minutes once per release
  (ACCESS-6, stage 3) (1e).~~ Fixed in 3h: the last real input is kept per session on the device.
- The Owner cannot see who reset a PIN: the new `staff_pin_vault` UPDATE row is in the admin-only
  Audit Log. The page labels its field "Pin Reset" (`FIELD_LABELS` in `AuditLog.js`). The till's
  lockout line now differs from `SelfServiceLogin.jsx`'s (HR, shared with hss-suite) (1f).
- `set_active_outlet` refuses an allowlisted non-Owner who asks for their HOME outlet by id ("no
  access"), because Outlet Access stores no home row, so the top-bar switcher's home entry fails for
  allowlisted staff (latent, 0 rows). The till's new buttons send NULL. Fix: `outletSwitchArg` inside
  `switchOutlet`, or home-by-id as the reset in SQL (1g).
- **Found while drafting stage 2 (2026-10-09, not fixed):**
  - The close write does not pin the lines it priced: `guard_pos_order_close` accepts a close whose
    `items_version` moved since `paid_amount` was worked out (a second press's save landing before a
    late first try). Fix: send `items_version` with the close and refuse a mismatch; first check what
    bumps it (`apply_pos_item_comps`?) so a normal close is never refused. Since 2d the till says so on
    the floor when the stored lines don't add up to the money (2d).
  - Unknown-close marks live in memory only: a PIN lock, leaving Orders or a reload forgets them (2d).
    ~~The lock still hands back a standing redemption.~~ Fixed in 2g: the lock skips it while a try at
    that bill is unsettled, and the close itself returns forgotten points.
  - A 5xx from the gateway on the close write is reported to the cashier as a refusal, though the
    database may still commit it (2d).
  - ~~The Billing station shows no loyalty note, and has no way to Recent Bills, though many messages say
    "reprint it from Recent Bills" (2d).~~ Fixed in 4b: both render there, one element shared with the floor.
  - A Split bill's payment legs are inserted in a request after the close, so 2b's shift lock does not
    cover them: a Close Shift between the two can freeze a report without that bill's cash leg. Fix:
    `pos_shifts_guard` refuses a close while a Split bill closed in the last 10 minutes on that shift has
    legs short of `paid_amount` ("press Close Shift again in a moment") (2b).
  - ~~A Credit Note inserted by a client session keeps a sent `created_at`, which backdates its printed
    date: set `NEW.created_at := now()` on the non-restore path, with slice 2e (2b).~~ Fixed in 2e.
  - ~~`save_pos_order_items` leaves comped rows out of `before_sent` and `stored_sent`, so after a cancelled
    close the folded, already-sent comped dish reads as not sent and could print on a KOT again (main
    session, 2b review).~~ Fixed in 2h: comped rows count in both.
  - Raise `pos_min_till_build()` to crest-v417 so a till older than 2a cannot charge an emptied cart, but
    only after checking that `x-crest-build` reaches `request.headers` through PostgREST in production
    (1b's open check); every till would be refused otherwise (2b).
  - ~~On a server `no_open_shift` the till keeps its cached shift id until the next press (cosmetic, 2b).~~
    Fixed in 4a: the refusal clears it.
  - ~~`viewPosBill.js`' `get_client_profile_names` read drops its error (blank Cashier), and its reads have
    no time limit; `reprintItemCompSlip` drops both read errors and prints nothing silently (2a).~~ Fixed
    in 4b: every read is bounded and a failed one prints nothing and says so (`billReprintData.js`).
- **Found while drafting stage 2, wave 2 (2c, 2e, 2f; 2026-10-09, not fixed):**
  - ~~The Owner Report's POS section (`computeMonthlyReport.js`) still works out past bills with the VAT
    flag read when the report is generated, so a month generated after a VAT change loses its VAT. Fix:
    add `vat_registered` to its `pos_orders` select and pass `billVatRegistered(o, vatReg)` (2c).~~ Fixed
    in 3m: the section now goes through `salesReportMath.js`' `billAmounts`.
  - CREDIT-NOTES-5's server half: `guard_pos_credit_note` accepts any sent `original_invoice_no`,
    `original_invoice_label` and `original_invoice_date_bs`. Set them from the bill (`v_order.invoice_no`,
    the TI/PB label from `v_order.vat_registered`); no note column needed (2c).
  - `PosCustomers.jsx`' settings comment says `is_vat_registered` moves the delivery commission base by
    about 13 points. It does not: taxable + non-taxable is ex-VAT under either flag (2c).
  - Do not switch an outlet's VAT status before every till has reloaded to crest-v420: an older till
    prints under its old setting while the bill is stamped with the new one (2c).
  - `openBilling` and `openCompTab` never catch a failed cost read, so the comp cost silently shows
    NPR 0 (S695 says callers must) (2f).
  - ~~`imsPostWarning` is a local counter that never goes down: a timed-out post that later lands (now
    marked by the database) still shows "1 not posted" until the page reloads (2f).~~ Fixed in 4e
    (`noteImsMiss` / `pruneImsMisses`).
  - ~~`writeSalesEntries` links rows by the screen's `orderId`, not `updated.id`; equal on every path that
    posts today, but fragile (2f).~~ Fixed in 4e: `postClosedBill` posts the stored bill under its own id.
  - Same cause as IMS-HANDOFF-3, not switched: ~~Sales Report's and Sales Exceptions' comp food cost (one
    line each, `posFoodCosts`),~~ (switched in 4d) `viewPosBill.js` (also opened by IMS logins with no POS
    rank, which `pos_recipe_book` refuses, so it needs a fallback) and the Customization report
    (`loadDeltaExplosion`) (2f). Stage 5: a server read IMS logins may use.
  - ~~A note's takeback has the race bills had (a late post after a Periods post); no refusal for notes
    yet. `creditNotePosting.js`' comment at its mark write and `posted: true` when only the mark failed
    are moot now (2f).~~ Fixed in 3j (`pos_credit_note_already_posted`).
  - ~~"Manual Sales by Category" (`useSalesPivotData.js`) excludes only `pos`/`pos_comp`, so it counts
    `pos_credit` and `pos_credit_restock` rows as hand-entered sales (2e, predates it).~~ Fixed in 4d
    (`isManualSource`).
  - `buildUsageMap` clamps a recipe's net sold at 0 for the base recipe but not for choice extras
    (`ingredient_deltas`); matters only for a negative month (2e).
  - A "not served" note on a bill from an earlier Inventory month puts the food back in the note's
    month; the screen warns that the earlier month's count already settled it, but does not block (2e).
  - Drafting briefs should give each parallel drafter its own scratchpad subfolder and local Postgres
    port: two drafters overwrote each other's replica scripts (2c, 2e).
- ~~A held non-till laptop that is RELOADED with queued POS orders comes back in the login's new outlet,
  and Orders would replay the queue there (ORDER-FLOW-15, queue entries carrying their client) (1g).~~
  Fixed in 3f: each entry carries its outlet, and another outlet's are left alone.
  ~~The cart save on an outlet move also tries to cancel a standing points redemption, which fails once
  the login has moved.~~ Fixed in 2g: an outlet move leaves the points for that bill's own close.
- **Found while drafting stage 2, wave 3 (2g, 2h; 2026-10-09, not fixed):**
  - A guest whose points stand on an open bill from an earlier try sees a lower balance on another till
    and cannot use them there until that bill closes; a line like "N points held on bill 12" would help
    (2g).
  - ~~Customers → Loyalty still offers a delivery partner's customer row for enrolment; enrolling it now
    does nothing (cosmetic, 2g).~~ Fixed in 3k: the row reads "Delivery partner — earns no points".
  - Menu Pricing (both branches) lets a manager tick On POS on a dish with no price, and IMS recipes
    default to `pos_enabled = true`; such a dish now just stays off the till, so Menu Pricing should say
    "not on the till until it has a price" (2h).
  - `push_master_data`'s preview for a dish matched by name on the first push never says its price is
    overwritten when Selling prices is ticked; its plan table has no `DROP … IF EXISTS`, so two calls in
    one transaction fail with 42P07 (tests only) (2h).
  - The till's menu read requires `is_active`/`pos_enabled = true` while `save_pos_order_items` accepts
    NULL (0 NULL rows, latent)~~, and the till's `option_count` message names no dish though the server
    sends one (CUSTOMIZATION-2 would help)~~ (2h). The message half is fixed in 3o (`choiceRefusal.js`).
- **Found while drafting stage 3, wave 1 (3a, 3i, 3k; 2026-10-09, not fixed):**
  - ~~`mergeUnsentLines` (`posOrdersConstants.js`) keeps the base line's note and drops the incoming one,
    so on the lock restore, stale recovery, adopt-open-order and offline-conflict paths a note typed on
    this device (a guest's allergy note included) vanishes when the other copy has any note. Fix:
    `notes: joinNote(l.notes, inc.notes) || null`. Belongs in 3g (3a).~~ Fixed in 3g.
  - ~~`get_guest_order_progress` and `get_guest_table_status` count a CHANGE ticket until it is Seen, so a
    guest's tracker can sit below "Ready" and a table badge read "Sent" meanwhile. Fix: `AND NOT
    (k.items @> '[{"change":true}]'::jsonb)` in each ticket loop. Fold into 3b's migration (3a).~~ Fixed
    in 3b, which also leaves cancelled tickets out of the table badge.
  - A note changed on a partly sent line (2 sent, now 3) reaches only the "+1" ticket; the 2 already
    made never hear of it, on paper or on the KDS (P3, 3a).
  - The cart's note box shows every note, an allergy note included, in grey italic (`--theme-text3`)
    (P3, 3a).
  - ~~**For 3h (`pos-staff-login`):** a blocked login, or a settled leaver, picked from a stale till list
    gets "Invalid credentials" (shown as a wrong PIN), and each try counts toward the lockout. Filter
    `pos_blocked_at` and `settlement_blocked_by` in its staff lookup, or give its own answer (3i).~~
    Fixed in 3h: its own 403 (`switched_off`, "This login is switched off"), not counted.
  - Deleting an IMS or HR staff login (`delete_ims_staff` / `delete_hr_staff`) also SET NULLs its name
    on counts, requisitions, gate passes and approvals: the ACCESS-5 shape outside POS (3i).
  - ~~Live `pos_parking_slips_guard` still lets any operator INSERT through unchanged; its comment says 1l
    narrowed it to a restore, the body does not (3i).~~ Fixed in 4k (S819): the restore only.
  - Clear IMS also deletes the Fixed Assets register and categories, which neither its confirm nor the
    "setup kept" heading mentions (3i).
  - After Clear POS, a manual Sales Entry day whose depletion was skipped because the till covered it
    stays un-depleted until that day is re-saved (3i).
  - ~~The retired shared-key picker `get_pos_staff` still lists blocked logins (nothing calls it since 3h;
    `20261010190500` drops it)~~ (dropped, S812), and the Audit
    Log shows `pos_blocked_at` under its raw column name (`FIELD_LABELS` in AuditLog.js) (3i).
  - Recorded-rows counts are full table scans per Delete press; the Unblock leaver check reads
    `hr_employee_id` only, not the S798 3f-1 employee links (3i).
  - ~~`pos_loyalty_ledger` carries the S782 grants trap: anon and authenticated hold REFERENCES, TRIGGER
    and TRUNCATE (not reachable through REST). `REVOKE TRUNCATE, REFERENCES, TRIGGER ON
    public.pos_loyalty_ledger FROM anon, authenticated;` (3k).~~ Fixed in 5a (S821).
  - ~~Customers' own bill history matches `buyer_phone` exactly and its search misses "+977…" spellings;
    only pre-3k bills typed differently (0 live) (3k).~~ Fixed in 4g: the history matches the stored phone
    and its number, and both Customers searches match by number (`phoneMatchesSearch`). "00977 98…" is not read as the same number by
    either twin (they agree, so nothing splits) (3k).
  - ~~No screen shows a customer's full points history (Adjust shows the latest 10)~~ (History, 4g); Loyalty's member list
    hides when no scheme exists, so balances left after every scheme is deleted cannot be adjusted;
    "+ Add scheme" is `disabled` with no reason when the name is empty (3k).
  - Between a release and every till reloading, an older till that creates a customer typed "+977…"
    stores that spelling, and a new till's later upsert for them is refused and logged (name/PAN
    updates do not land; points still work) (3k).
- **Found while drafting stage 3, wave 2 (3b, 3d, 3j; 2026-10-10, not fixed):**
  - ~~Grants hygiene (the S782 trap): anon and authenticated hold MAINTAIN on `pos_guest_order_requests`
    (3b).~~ Fixed in 5a (S821).
  - ~~The app-wide guest alert (`useGuestOrderAlerts`) keeps ringing on the very till that accepted a guest
    order until it saves, because the request still waits in the database (since S763) (3b).~~ Fixed in 3c:
    an accepted order is held out of that till's alert.
  - `placeOrder`'s menu re-read after a refusal is unbounded (background only) (3b). ~~Help's Order Taking
    bullet still says "(Pro plan)" and "Enable it per client in Admin → Manage Clients → Features".~~
    Fixed in 3c.
  - ~~The operator still bypasses `guard_pos_kot_log` entirely on UPDATE, so an operator's KDS taps keep
    tablet times and skip forward-only, against Q26 (a) (3d).~~ Fixed in 4k (S819): the restore only.
  - The KDS's non-timeout error still says "was not moved — it is back where it was" for a dropped
    connection, where the write may have landed; KOT Log shows "Cancelled" for both a kitchen Clear
    and a void (3d).
  - With two live tickets for one dish and one pulled, a direct API call could Clear either ticket
    (never both); a send whose ticket insert failed leaves food no ticket carries, so the board offers
    Clear and the server refuses it (a supervisor clears it) (3d).
  - ~~IMS-HANDOFF-9 is unchanged: neither the floor banner nor its post checks whether the client has
    Inventory at all; errorText's `pos_sale_unlinked` operator sentence names only Periods (3j).~~ Fixed
    in 4e (`tillPostsToIms`).
  - `ims_sales_entries_guard` lets a `pos_credit` row name any note, with no check that the note belongs
    to the row's outlet (the new lock simply skips a note of another outlet) (3j).
  - ~~IMS-HANDOFF-5 (no "till bills still waiting" note when ending a month) could now use
    `pos_ims_waiting_counts` for any closer, IMS supervisors included (3j).~~ Done in 4e
    (`tillWaitingPreflight`).
  - ~~`pos-billing.md`'s "Periods backfill … re-stamps what it finds" sentence (IMS-HANDOFF-2) is still out
    of date (3j).~~ Found already rewritten in 2f ("`ims_posted_at` is the database's"); closed in 4l.
- **Found while drafting stage 3, wave 3 (3c, 3e, 3n; 2026-10-10, not fixed):**
  - ~~A till lock keeps the cart, a guest's accepted dishes included, but not the accepted request ids, so
    the request still waits (the PIN screen now announces it, correctly). When the waiter signs back in,
    the cart returns with those dishes and the table's banner offers Accept again: pressing it doubles
    the dishes (since S776 plus guest Accept). Belongs in 3g (3c).~~ Fixed in 3g: the accepted request
    ids ride with the kept cart (`guestReqs`).
  - ~~On the Billing station, "Open Orders" from an open bill leaves it with no unsaved-changes guard (no
    `useBlocker` or `beforeunload` in `PosOrders.jsx`, since S762/S763) (3c).~~ Fixed in 4b: the alert bar
    over a bill opened there has no Open Orders and says to close the bill first (`billing-bill`), and a
    reload or closed tab with unsaved lines or recorded payments asks first (`beforeunload`).
  - ~~A save that answered but whose `pos_kot_log` insert failed is only logged to the console, so the food
    has no ticket. Suggested for 3f with ORDER-FLOW-7: a client-minted ticket id, the failed insert kept
    and retried with the same id, a duplicate-key answer read as "it landed" (3e).~~ Fixed in 3f, as
    suggested (the ticket waits in its own queue entry, `posTicketsKey`).
  - ~~A new takeaway whose order insert gets no answer can leave an empty open takeaway order when Send
    Order is pressed again (a table is protected by the one-open-order index). Fix: a client-minted order
    id, as the offline path already does (3e).~~ Fixed in 3f: the id is minted before the insert, and a
    no-answer is queued under it.
  - The ← "Discard N unsaved items?" prompt during an in-flight send still says "nothing reaches the
    kitchen", but the send still lands and now prints; and a second take-off after a saved one (3→2
    saved, then 2→1) prompts "2 × already sent" while the server records 1 (3e).
  - ~~For 3f: when the unknown-send branch queues and prints offline, drop that order's send marks first
    (`putSendAttempts(oid, [])`), or the poll can print the same dishes again if the lost save landed (3e).~~
    Fixed in 3f.
  - ORDER-FLOW-4's residual: a double ticket is still possible when this till's unanswered send did not
    land, another tablet fired the identical full cart meanwhile, AND that tablet is the same login or
    its ticket-log insert failed. The fix if it shows up: a client-minted save id stored by
    `save_pos_order_items` (3e).
  - ~~The Owner Report (`computeMonthlyReport.js`) counts takeaway as covers and drops credited bills from
    them (now owner-decided, slice 3m).~~ Fixed in 3m (schema 15: seated guests, credited bills kept).
    `hr_labour_actuals` counts every paid bill as at least 1 cover and
    Demand Forecast does `o.covers || 1` over all channels; possibly intended for staffing, but the Roster
    calls the figure "covers". `ClientDashboard.jsx` keeps its own copy of `bsDayBoundaryIso` (correct
    today) (3n).
- **Found while drafting stage 3, wave 4 (3f, 3g, 3h, 3l, 3m, 3o; 2026-10-10, not fixed):**
  - ~~Ticket Routing lists only categories with a dish on the till, so a bar category with no dish (the
    default Beverage where the drinks are "Drinks") cannot be moved to KOT there, and that till keeps a
    greyed BOT (3m).~~ Fixed in 4i: listed, marked "no dishes on the till".
  - The 1L+ year's line read fires every 150-bill chunk at once (about 730 requests for a 1,09,500-bill
    year) (3m).
  - ~~The KOT button's Tip still says "food items"; Avg Bill Value on the Owner Report has no Tip~~ (both
    fixed in 4l); a no-bar till shows BOT for a moment on load (3m).
  - The stock-count tablet's lock still signs out on every device (`scope: 'local'` would be safe there:
    `ims_revoke_count_sessions` covers a lost counting tablet) (3h).
  - `pos-staff-login` still carries the dead pre-S791 fallback for a missing `reserve_pos_pin_attempt`
    (3h).
  - `client_secrets.pos_device_secret`, `pos_legacy_key_retired_at` and `pos_legacy_key_last_used_at`
    are read by nothing (`revokeClientTablets` still writes the first two, `AuditLog.js` lists
    `pos_device_secret`): a later column drop (3h).
  - A session that ends by itself does not keep the till's unsent cart (`runBeforePosLock` is not run);
    `ProtectedRoute`'s `!profile` branch still sends a profile-less session on an activated tablet to
    `/login` (3h).
  - ~~A guest QR order still waiting when its table's bill closes is never answered by anything
    (`get_pos_device_guest_alerts` has no age limit), so it rings on and the next party's screen offers
    its Accept (3g).~~ Fixed in 4i (D21): the close turns it away (`pos_orders_close_turns_away_guest_orders`).
  - A table tapped while the sign-in restore's reads are running takes the kept lines (since S776);
    offline between the restore's two reads on a free table, the covers numpad hides the floor message;
    a takeaway closed between the two reads is kept under "could not be read" wording (3g).
  - A customized line reopened from a crest-v427 queue entry has no snapshot (the KOT prints without
    choices, the cart says "No choices picked") (3f).
  - Tickets for an order created offline are logged with `order_no` null (3f).
  - A send whose lost save landed, followed by another tablet saving on top before the upload, shows a
    "NOT applied" conflict though the lines landed (3f).
  - After one no-answer, sends queue for 30 s even if the link recovered sooner; an older (v427) tab
    draws a `kot:` entry as a 0-item takeaway (3f).
  - `credit_settled_at` is still the settling tablet's clock: one line, `NEW.credit_settled_at := now()`
    in `guard_pos_order_close`'s settlement branch, needs a migration (3l).
  - A unique partial index on `pos_cash_movements(order_id) WHERE kind = 'credit_settlement'` would make
    a settle's Cash In once-only across devices (live duplicates: 0) (3l).
  - PosCustomers' settings read, `loadCustomers` and `toggleHistory` have no time limit (3l).
  - `handleSaveRefusal` says "The menu has been reloaded." before the reload runs, and even when it
    fails; the server's `option_count` counts picks of hidden options (harmless while
    `option_not_on_menu` fires first) (3o).
  - On a POS manager's PIN the Customization Report's Margin `items` read is fenced, so costs read NPR 0:
    the 2f item above ("the Customization report (`loadDeltaExplosion`)"), not a new one (3o).
- **Found while building stage 4, wave 2 (4d, 4e, 4f; 2026-10-12, not fixed):**
  - ~~The operator's `imsEnabled` is always true, so a bill the operator closes on an outlet without Crest
    IMS still posts to Inventory (4e).~~ Fixed the same day (owner): `outletHasIms` reads the viewed
    outlet's own module for the operator, on the till and both credit-note screens.
  - Stage 5: a server-side post from the stored bill, stamping it in one transaction (would replace
    `postClosedBill`'s browser read); `ims_sales_entries_guard` refusing till rows for a client without
    Inventory; and, when Inventory is switched on for a POS-only outlet, a way to settle (or post) its
    past unmarked bills, which D6 kept recoverable (4e).
  - ~~The POS-only Home's own POS sales pivot still shows money to Staff rank; D2 covered only the POS
    Dashboard (4d).~~ Fixed the same day (owner): Supervisor and above, as D2.
  - ~~Table Management's "skewed by bills left open" note can no longer show, now that sittings over 12
    hours are left out (4d): remove it in 4j.~~ Removed in 4j (S818).
  - `pos_parking_slips` has no index on `time_in`; the All tab's date range filters on it. Fine at
    today's volume (0 slips live) (4f).
- **Found while building stage 4, slice 4g (2026-10-12, not fixed):**
  - A late award (the one-tap) uses the customer's scheme as it is now, not as it was when the bill
    closed; the History row shows the points before the tap, and the answer says when the server's
    figure differs. Fine while schemes rarely change.
  - A Credit Note on a bill closed before a Move takes its points back from the OLD number, which can go
    below 0 while the new number keeps them (the ledger's true position, as for any spent points).
  - `pos_customer_phone_locked`'s sentence still says "the points stay with the old number"; it should
    name Move. Stage 5 (it is a guard body).
  - A till on crest-v430 or older shows held points as spendable until it reloads; the server refuses
    them with a sentence (`pos_points_held`).
  - Loyalty's member list still hides when no scheme exists, and "+ Add scheme" is still `disabled`
    with no reason when the name is empty (S809.4, 3k): stage 6 (left out of 4l, which changed copy only).
- **Found while building stage 4, slice 4h (2026-10-12, not fixed):**
  - The below-zero checks in the editors look at one option at a time. Two negative choices that only
    go below zero together, or a hidden option shown again with Show again, are refused only by the
    till's save (`option_price_below_zero`, naming the dish). 0 negative options live besides sizes.
  - Put it on dishes checks only the dishes newly ticked, not ones already carrying the group.
  - Menu Pricing's size line and refusal are advisory: on a failed option-catalog read they say
    nothing and the price saves, and the till then refuses the below-zero line by name.
  - A guest whose dish its choices price below zero hears the generic "choices no longer available"
    (`unavailable_options`); the guest page cannot tell it from a hidden choice.
  - A till on crest-v431 or older still numbers a "No …" removal as a free pick on screen and greys
    other picks under its "Max"; the server prices the new rule (0 removals live).
  - The server's `option_count` still counts picks of hidden options (harmless while
    `option_not_on_menu` fires first), as filed in 3o.

- **Found while building stage 4, slice 4i (2026-10-12, not fixed):**
  - `guard_pos_order_insert` does not refuse an order on an inactive table. A till whose floor read is up
    to 15 s old can still open one on a table retired a moment ago; its seat write then leaves the table
    Inactive, and the floor opens that bill from the tile. Stage 5 if it shows up.
  - A guest QR order on a table that never gets a bill is still answered by nothing and rings on
    (`get_pos_device_guest_alerts` has no age limit); 4i answers it only when a bill on that table closes.
  - A guest order accepted into the cart whose "accepted" mark failed to save before the close is turned
    away by the close although its dishes were billed (the save marks it first; a failed mark is rare).
  - A bill voided outside a till (REST) prints no VOID slip: only the Kitchen Display card tells the
    kitchen. A till on crest-v432 or older still cancels a voided order's Served tickets itself.
  - The 12 live tickets of voided orders (all from before S817) stay cancelled, Served ones included.

- **Found while building stage 4, slice 4j (2026-10-12, not fixed):**
  - An unanswered request whose time has passed expires only when the same number asks again; other
    stale requests wait for staff (marked "time passed") and still count on the nav chip. A sweep that
    answers every passed request (on the staff page's load, or a schedule) would clear the chip too.
    0 requests waiting live.
  - The Seat dialog's busy marks come from the page's last read (frozen while the dialog is open); the
    till now refuses a taken table, but the dialog still shows it free until then.
  - A Seat prompt on the floor (a due booking's table tapped) that meets the one-open-order index on its
    first save is adopted onto that order by the existing 23505 path, as before; only the Reservations
    hand-off was changed.
  - A till lock's kept dishes still go onto a new order ahead of a Reservations hand-off to the same
    table, and the booking is then linked to that order.
  - No-show is gated on the booked time in the page only; the table takes it at any time (REST).
  - The S818 read-back of `submit_reservation_request` after the apply was blocked by auto mode; the
    migration's own section 2 asserted md5, SECURITY DEFINER and anon / authenticated / service_role
    EXECUTE inside the apply.

- **Found while building stage 4, slice 4k (2026-10-12, not fixed):**
  - `pos_orders.table_id` still has no FK (FLOOR-KITCHEN's offline-delete note): a table deleted while a
    till holds an offline order for it leaves that order on neither the floor nor Billing. A FK has to
    decide what deleting a table with bill history means (refuse, or SET NULL and keep `table_name`).
  - The new client FKs make a client delete with POS rows left behind cascade only as far as the guards
    allow: `guard_pos_order_delete` refuses a billed bill in that cascade from the operator's browser
    session, so Delete Client stops at its last step and says to run it again. Safe (deleteClientDataFor
    clears POS first), but the message names no table.
  - `fetchViewModules` (AuthContext) still drops its read error; on a failed read `clientModulesKnown`
    stays false and the D30 till notice never shows for support (it fails open, as every UI gate does).
  - `get_client_profile_names` now returns every Crest operator login's id (as "Crest support") to any
    client's caller. One login today; ids only, no name.
  - Live today: 0 bills closed and 0 tickets sent by support (BLOOM CAFE was rebuilt in S810), so the
    new label shows on nothing yet.
  - `POS_DECISIONS.md` has no entry for slice 4j (S818 moved its rows out of this file and wrote none
    there); the CHANGELOG entry is the only record of D22–D26.

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
  - Not yet pressed on a real till after S759: the cart's choices line and the choice window's
    scroll-to-short-group on a refused Add. (The guest sheet's sticky header WAS pressed in S767 —
    it clipped the content under it, and was fixed.)
  - Release 2: combos / build-your-own bundles.
  - **S760 build-your-own: applied live 2026-09-15.** The GUEST steps were pressed in a browser in
    S767 on BHATTI CHOILA's VEG MOMO (size step, Review, Change back to Review). Still to do: the
    template on CASA ACAI CAFE, a Large bowl on the till, scaled stock at bill close, and the cost
    range on Recipe Costing and Menu Pricing (IMS branch).
  - `push_master_data` does not carry `recipes.is_build_your_own`, nor option groups at all, so a
    branch receives a build-your-own dish as an ordinary one.
  - The Complimentary slip and Menu Pricing's POS-only branch show no build-your-own cost range (the
    POS-only branch has no costs at all).
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
  `get_pos_staff`'s secret comparison. Till Devices shows when each client's shared key was last used.
- [x] **Archiving a client did not revoke its tablet keys** — closed S755: `deleteClientDataFor` in
  `admin-user-ops` (Archive, Clear Client Data, Delete Client, the trial purge) revokes every live
  `pos_devices` key and rotates/retires the shared key first; a restored client re-activates tablets.
- [x] **A credit note's reason line printed "(no money returned)"** — closed S755: the answer is
  `pos_credit_notes.refund_method`, shown in the Credit Note Book, never printed. Notes issued before
  S755 keep their reason text as printed.
- [ ] 🔵 **A POS manager cannot re-activate a dead tablet** (ACCESS-10; the owner chose wording only on
  2026-10-12, so the till now says "activated again by the Owner"). A POS manager has only a PIN, which a
  revoked or never-activated tablet refuses, so only the Owner's email sign-in on that tablet can
  activate it (or a POS manager still signed in there). The build, if wanted: an enrolment code the
  Owner issues in Till Devices that a POS manager types on the tablet.
- [ ] 🟡 **Deleting an open order that still has lines is refused as "this bill is closed and
  printed"** (found S755, measured rolled back on live). `guard_pos_order_items_closed_del` is an
  AFTER STATEMENT trigger, so inside the `pos_orders` cascade it fires as `authenticated` and its
  LEFT JOIN reads the just-deleted parent as not open. Fail-closed and reached by no app path (Clear
  Occupied deletes the lines first), but the message is wrong and a direct REST delete of an open
  order cannot succeed. Fix: tell a deleted parent from a closed one inside a SECURITY DEFINER lookup
  (the S749 pattern). `record_pos_kot_removals_on_order_delete` records that path once it can, by line
  with its choices since S817 4i (ORDER-FLOW-19).

## B. Reports — compliance-adjacent

- [ ] 🟡 `sales_entries`/`purchase_entries` hard-delete on edit (accepted risk — only matters near the NRs 5 crore certification tier). **`pos_orders` itself cannot be deleted or edited once billed, enforced by the database since S754** (`guard_pos_order_delete` plus the closed-bill lock in `guard_pos_order_close`, migration `20260916100000`, applied live 2026-09-14). Before that it was only true because no screen offered it: a till login could delete a billed order over REST. **Narrowed by S698 on the purchases side, not closed:** the replacement is now one transaction inside `save_purchase_bill` rather than two requests, so a bill can no longer end up holding both versions, and a bill with `payable_payments` against it is refused outright by a `BEFORE DELETE` trigger. The lines themselves are still replaced rather than superseded, so an audit trail beyond `audit_logs` would still need a version column. `sales_entries` is unchanged.
- [ ] ⚪ Tier-1 software-certification legal question (needs an accountant's answer, not code)

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
  from that fix apply here and one does not — ~~POS orders already carry a `client_id` through
  `scopedUpsert`, so the shared-device replay problem does not arise~~ (untrue: queue entries carried
  none until S809 3f added `client_id`), ~~but `navigator.onLine` is
  just as unreliable on the floor as it is in the storeroom, and `save_pos_order_items` is an
  atomic RPC, so a network failure around it is as safe to re-queue as Stock Count's upserts.~~
  The re-queue is done in S809 3f: a send with no answer is queued and prints, and a refusal no retry
  changes becomes a floor conflict carrying the server's sentence.
  Closes the POS half of `DOCS-REMEDIATION.md` T6 item 3.
- [ ] 🟢 **The Crest Suite tab's UNENTITLED branch was never seen (S763).** `suiteEntitled` is
  `isAdmin || suitePlan === 'pro'`, so an admin session is entitled by definition and cannot reach
  the other path. Verified on a Suite client: the tab renders, its panel carries the five reachable
  items, every Suite path selects it, and the Crest Suite group is gone from the module panels.
  **Unverified:** that a client WITHOUT Suite still sees the PRO-badged group in each module panel
  and no top-row tab, in both the bar and the phone drawer. One sign-in as a non-Suite client's
  Owner answers it — the code path is `suiteUpsellInPanels`.

- [ ] 🟢 **Two guards on the Billing station (S762) were never clicked.** The list, both Bill
  paths (a table and a takeaway), the payment window opening on the right order and ← returning to
  the list were all verified live on BHATTI CHOILA. Two were not, for want of a second actor:
  (1) a Staff-rank PIN typing `/pos/billing` should land back on `/pos/orders` — the component
  carries `if (billingStation && !hasPosAccess('supervisor'))`, read but not exercised; (2) the
  `existingOnly` refusal, where a bill listed here was settled on another till between the load and
  the tap, should say so and refresh rather than open the covers numpad. Both are single clicks
  once a staff PIN and a second device are to hand.

- [ ] 🟢 **Four S776 behaviours were verified in code and tests but never pressed live** (S776,
  2026-09-17), each for want of a real till or live service on the dummy client:
  (1) **the idle lock on a real PIN session** — keep and restore were exercised by firing the lock
  event by hand as the Owner, and the PIN screen's note by a render test, because the browser was not
  an activated till; one activated tablet and a staff PIN left idle for 3 minutes answers it;
  (2) **the KDS estimate presets starting a ticket in one tap** — no New ticket was on the board;
  (3) **the unified variance display** (✓/▲/△) on a closed shift;
  (4) **the Billing station's "Find a table…"**, which needs two or more open bills.
- [ ] 🟡 **`admin-user-ops` still defaults an unnamed discount limit to NULL (= unlimited) for admin
  and Owner callers.** The S776 owner decision (a new POS login starts at 0%) is enforced by POS
  Staff sending `pos_discount_limit: 0`; a create from any other caller still lands unlimited. Making
  the Edge Function default 0 closes it, and needs a deploy.

## B4. Timezone follow-ups left by S670

S670 pinned every clock-time *render* to `Asia/Kathmandu` (`src/shared/nepalTime.js`). Two things in
the same family were deliberately not taken, because each changes a figure rather than a label:

Both items that stood here — the Sales Report's runtime-local range bounds and `closed_at` written
by the till — were closed by S754 and moved to `POS_DECISIONS.md`.

- [x] ~~🟡 **Covers Report's Avg Turn Time silently shrinks its sample.**~~ Fixed in 4d (S814): a 12-hour
  cap (`MAX_SITTING_MINUTES`, owner D3) and a note under the table counting each excluded kind. `if (mins < 0) continue`
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

- [ ] 🟡 QR payment auto-confirmation — receiver scaffold + admin UI shipped S271/S272, 2026-07-06 (`pos-payment-webhook` Edge Function; its secret is `client_secrets.pos_webhook_secret`, admin-only, set in Manage Clients → a client's QR tab — never on `settings`, which every login of the outlet can read). Still needs real FonePay/eSewa merchant onboarding + their actual signature scheme before anything goes live — low priority, blocked on merchant credentials, not engineering.
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
