# pos-billing.md: archived sections

Moved word for word out of .claude/rules/pos-billing.md in the S770 context pass (2026-09-17). This is history and is not auto-loaded: no rules glob matches docs/. The live rule stays in the rules file, usually with a pointer here. Line numbers refer to the rules file before the move.

---

_Original lines 541–637:_

## Still open from the phase 6 critique

Recorded so they aren't rediscovered from scratch:

- **The close-time guards (discount cap, void, item comp) are closed**, applied and smoke-tested
  (S577–S579). **S754 found what they left open: the closed bill itself, and every other POS table
  a rank gated only on screen** (both sections above). Its migrations were applied live on
  2026-09-14. S755 (`20260917100000`, live 2026-09-15) closed its known gaps: a
  same-second double table hold, Clear Occupied skipping the pulled-item record, credit-note amounts
  trusted as sent, archived outlets keeping their tablet keys, and the refund method printed on the
  note. What remains open is in `POS_TODO.md` A2. The
  payment-QR work stays blocked on FonePay/eSewa merchant onboarding, which is a business
  relationship rather than engineering.
- ~~**The mechanical sweep.**~~ **Closed across S576–S578**, with a fourth pass in S603. Labels: 0
  bare `<label>` vs 54 `htmlFor`, every `<select>` named. Colour: 117 base-signal-token `color:` sites converted, 0
  remain, 128 contrast-variant references now. Modals: all 9 hand-rolled overlays are on the
  shared `Modal`. Three shapes recur here and are worth copying rather than rediscovering — a
  caption over a button group or a read-only figure must be a `<span>` plus
  `role="group"`/`aria-labelledby` (a `<label>` naming no labelable element announces a name the
  browser never binds); a label for a conditionally-rendered control still pairs by `id`, since
  `SearchableSelect` and `BsCalendarPicker` both forward one; and a dialog opened from the order
  screen or the KDS needs `Modal`'s `zIndex` prop, because those are `position: fixed` layers at
  1000 and therefore their own stacking contexts — that single fact is why POS grew nine
  hand-rolled overlays instead of using the component.

  **S604 was the guest menu's own critique (23/40).** Three of its findings are worth carrying:
  the public menu applied `vat_rate` unconditionally while the till gates it on
  `settings.is_vat_registered`, so a non-registered outlet advertised every dish ~13% above what it
  billed — `get_guest_menu` now returns the flag (migration `20260823100000`) and `priceIncVat`
  takes it as a REQUIRED argument, so a call site that forgets it fails toward no-VAT rather than
  toward over-charging. The 5s status poll dropped `error`, so a failed read rendered identically
  to "no open order" — the S594 rule on the guest surface, where the cost is a diner watching a
  tracker that has silently stopped; it now keeps the last known stage and says so. And a raw
  `err.message` from `submit_guest_order` was rendered to an anonymous member of the public.

  **S746 re-analysed it from Admin → Guest Menu, and found the public surface disagreeing with the
  floor.** Three rules, each decided with Aashish:
  - **An inactive table's QR shows the menu and takes no orders.** Both guest RPCs ignored
    `pos_tables.status` while `PosOrders.jsx` makes an inactive tile unclickable, so a guest order
    lit up a table nobody could open. `get_guest_menu` returns `guest_ordering_enabled = false` for
    it and `submit_guest_order` refuses it — the flag alone would be advisory. Status is nullable,
    so the test is `IS DISTINCT FROM 'inactive'`: a NULL-status table was never taken out of service.
  - **A dish with no selling price is not on the public menu** (`selling_price > 0` in both RPCs).
    It rendered NPR 0 and went into a request snapshot with a NULL `unit_price`.
  - **The admin preview frame cannot place an order.** `GuestMenu` detects it is framed
    (`window.self !== window.top`; `frame-ancestors 'self'` means only this app can frame it) and
    swaps Place Order for a disabled button and a note. A guest's phone never frames the page.
  **Any new guest-side refusal needs both halves** — the flag the page reads to hide a control, and
  the check inside `submit_guest_order` — and `pos_enabled` stays the first gate in both (S632).
  The admin page states every one of these above the frame, because a menu that is switched off,
  empty, or order-less looks identical to a broken one from inside it.

  **S767 was the guest menu's third critique (24/40), fixed in full — decisions taken with Aashish.**
  Migration `20260921100000` (applied live 2026-09-16). Rules to keep:
  - **The tracker follows THIS guest's order, never the table's.** `get_guest_order_progress(request)`
    reads the bill that took the request (`pos_guest_order_requests.order_id`, written by
    `PosOrders.jsx` performSave on accept, with a `PGRST204` retry without the column for a stale
    till), only tickets sent after the request was made that carry one of its dishes, and whether that
    bill is closed. It used to combine the request status with `get_guest_table_status` — the least
    advanced ticket on the table's CURRENT bill — so a second-round order nobody had accepted showed
    the first round's "Ready", and a paid bill fell back to "heading to the kitchen" and chimed. The
    page never moves a stage backwards (`laterStage`) and ends on "Your bill is closed" when
    `order_closed`. A cancelled ticket is excluded; the table read counted it as 'new' forever.
    `get_guest_table_status` stays for a guest who never ordered from this phone.
  - **A new accept path must write `order_id` too**, or its guest's tracker falls back to the
    table-based lookup (the earliest bill on the table still open when the request was created).
  - **The restaurant's name and logo are the Owner's**: `settings.guest_menu_name` /
    `guest_menu_logo_url`, set in POS Setup → Guest Menu (`GuestMenuSetup.jsx`), fenced by
    `settings_guard_staff_roles` (`guest_menu_brand_rank`). The logo uploads into `dish-photos` under
    `<client>/guest-menu-logo-<epoch>`; that bucket's policies already admit the Owner. Unset, the
    menu shows `clients.name` through `tidyName` (all-capitals → normal capitals). **The public
    booking page shows the same name and logo** — `get_booking_page` returns `menu_name` /
    `logo_url` since `20260921110000`. A new public page that names the restaurant reads them too,
    rather than `clients.name`.
  - **Allergen warnings reach every client's guests** (no longer gated on the Nutrition flag);
    nutrient figures still are. The filter sheet says the list is built from recorded ingredients and
    to ask staff about a serious allergy — a missing record must not read as "free of it".
  - **Menu sections follow `settings.recipe_categories`** (or `DEFAULT_RECIPE_CATS`), editable in
    Settings → Recipe Categories and in POS Setup → Guest Menu, which a POS-only client without Recipe
    Costing can reach.
  - **Both guest pages wear the default preset**, pinned in `ThemeContext` (`isPinnedGuestSurface`,
    `/pos/menu/` and `/pos/book/`) — see DESIGN.md → "The guest pages". A new public customer route
    joins that list.
  - **The submit is bounded** (`withTimeout`, 20 s) and a timeout reads as "can't tell if it was
    sent", the same as a dropped connection; the order sheet locks while sending.
  - **Back closes a sheet** (`useBackToClose` in `GuestMenu.jsx`: one history entry per open stack,
    popped for the topmost sheet only; off inside the admin preview frame).

  **S603's pass was the input classes.** POS carried 20 of the 62 text controls in the product that
  were wearing `className="form-select"` — a `<select>` class, so `cursor: pointer`, so a text box
  announcing itself as a menu — across `PosTableManagement`, `PosShifts`, `PosStaff`,
  `PosCustomers`, `CreditNotes`, `CoversReport` and the parking slip modal. All on `.form-input`
  now, with `.form-input--auto` where the control sizes to a toolbar rather than filling a field.
  The same pass gave the whole app the 16px `pointer: coarse` floor it had never had, which matters
  more on this module than any other: **the till is a tablet**, and every field on it was 13px, i.e.
  under the threshold at which iOS Safari zooms the viewport on focus and never zooms back.

---

_Original lines 1136–1136:_

**A lockout the client calls around an operation is not a lockout.** POS and HR Self-Service both had `check_*_pin_lock` before and `record_*_pin_attempt` after, in the browser, with nothing server-side consulting them — so skipping the two RPCs walked a 4-digit PIN unimpeded. Both now run **inside** `pos-staff-login` / `hr-selfservice-login`, on the same request that signs in. Corollary: the frontend must **not** also call `record_*_pin_attempt`, or every failure double-counts and locks a fat-fingered employee out in 3 attempts instead of 5. Same reasoning applies to any future server-side check — if the browser can skip the call, it is advisory.
---

## S809 stage 3 wave 4 move (2026-10-10)

Two sections that repeated rules this file states elsewhere (the S577/S579 close and comp guards, and the IMS handoff's "`sales_entries` and `stock_movements` can diverge"), moved word for word when wave 4's additions took the POS rules load past its +15% warning. Line numbers refer to the rules file before the move.

## POS write-guards copy

_Original lines 1096–1101:_

## The POS write-guards (S531 invariant 3, S576, S579)

Migrated from the root `CLAUDE.md` (S663). The invariant itself — *a lockout the client calls around an operation is not a lockout* — stays resident there; this is the full POS-side detail behind it.

The invariant itself (a PIN lockout the browser calls around the login is not a lockout: attempts are recorded inside `pos-staff-login` / `hr-selfservice-login`, and the frontend must not also call `record_*_pin_attempt`) is stated once, in `.claude/rules/supabase-sql.md`, invariant 3. **The POS close was the same shape and was fixed the same way in S576** — the discount cap (`pos_discount_limit`) and the void permission (`pos_allow_void`) were both React, over a plain same-client `FOR ALL` policy that hands every till session UPDATE on its own orders. It is now `guard_pos_order_close()`, a BEFORE UPDATE trigger rather than the `close_pos_order(...)` RPC the critique proposed: an RPC protects only the callers that choose to call it and leaves the open policy in place, while a trigger sees every write to the table. Note what it deliberately does *not* enforce — `paid_amount`, because re-deriving the bill total in SQL would be a second copy of the VAT-and-rounding arithmetic, and a drifted copy would reject real bills mid-service rather than merely misreport a number. **Item-level comp was the third and last of the family (S579)**: `guard_pos_item_comp()` fences the comp columns on `pos_order_items` while `apply_pos_item_comps` stays `SECURITY DEFINER` and so remains the only write path — and that RPC now checks Supervisor *rank* (it had only ever checked client) and derives `comped_by` from `auth.uid()` instead of a caller-supplied parameter. **Attribution the subject of the attribution can choose is not attribution**; `comped_by` is what the Sales Exception Report ranks staff by, so a caller able to pass any uuid could comp under a colleague's name.

## Two writes diverge

_Original lines 1170–1181:_

## Two writes in one function can diverge, so one is never evidence of the other (S573)

Moved verbatim from the root `CLAUDE.md` (S769 context-reduction pass). The root keeps only the one-line rule.

A pattern worth recognising beyond POS. `writeSalesEntries` writes revenue to `sales_entries` and
then depletion to `stock_movements` inside a try/catch that swallows failures — deliberately, so a
depletion problem never blocks a bill closing. The consequence is that **a bill can have revenue
and no movements**, and a later guard that inferred "has this already posted?" from
`stock_movements` was therefore *wrong* rather than merely incomplete: it re-posted two bills'
revenue on real data (S573). Whenever a best-effort second write follows a primary one, the second
one's absence proves nothing — give each table its own link back to the source row and ask the
table you actually mean.

---

## Three returns story

Moved word for word out of `## PosOrders.jsx has THREE returns, and a modal put in the wrong one is
invisible` in S809 stage 4 (2026-10-12), when slices 4a–4c took the POS rules load past its +15%
warning. The rule stays in the rules file.

The KOT-pull prompt was placed beside the credit-note modal at the tail of the file — i.e. in the
floor view — while `setQty` only ever runs on the order screen. Pressing × on an already-fired item
therefore did **nothing visible at all**: the state was set, the removal was correctly blocked, and
no dialog appeared anywhere. It compiled, passed the label/colour/duplicate-id detectors, and read
correctly in review. Only pressing the button in a browser found it.

Before adding a modal here, check which return the handler that opens it lives in. Nothing about a
misplaced one fails loudly, and the failure mode — a button that silently does nothing — is the one
a cashier reports as "the till is broken" rather than as a bug you can search for.

---

## Report rows correction

Moved word for word out of `### The four POS report pages are reports, not till screens (S613)` in
S809 stage 4 (2026-10-12). The rule (`.btn-linklike` on the identity cell) stays in the rules file.

- **A `<tr onClick>` is mouse-only.** The RowDisclosure sweep never reached POS, so every
  drill-down here was unreachable by keyboard. An inline detail expansion takes `RowDisclosure` in
  the first cell.

  **Corrected 2026-08-30/S653: the second half of this bullet described a fix that was never
  applied, and prescribed the wrong one.** It said an *opening* drill-down takes a button in a
  trailing `no-print` action column. Nine rows across four POS files were still bare `<tr onClick>`
  when S653 measured them, and a trailing action column contradicts `.btn-linklike`'s own reason for
  existing ("the affordance has to sit on the name itself rather than in a trailing Actions
  column"). What shipped: `.btn-linklike` on the cell carrying the row's **identity** — invoice no.,
  order no., payment method — `stopPropagation()`ing so the row handler cannot double-fire, and
  `aria-pressed` instead of link semantics where the row toggles a filter rather than opening
  something. No column was added, so the tfoot alignment warning no longer applies.

---

## Smoke-test results

Moved word for word out of `## How to smoke-test any of these guards` in S809 stage 4 (2026-10-12).
The method stays in the rules file.

Results, all confirmed live on 2026-08-19:

- **Close guard (S577)** — `{"close_type":"void"}` → 403; a 30% discount → 403 naming the cap; a 10%
  discount → 200. An ordinary close still assigns an invoice, stamps `ims_posted_at`, and leaves
  `pos_order_items` matching the `sales_entries` row.
- **KOT-removal record (S577)** — the prompt names the item and quantity, Remove stays disabled
  until a reason is chosen, and KOT Log → Pulled Items renders the row with the staff name resolved.
- **Comp guard (S579)** — direct `PATCH {comped:true}` → 403, the same dressed with a forged
  `comp_no`/`comped_by` → 403, an INSERT arriving already comped → 403, an ordinary `notes` edit →
  200. The RPC called with `p_comped_by` set to a colleague's real uuid stored the **caller's** id
  instead, and returned 403 once the account was demoted to Staff.

## Silent IMS post

Moved from `.claude/rules/pos-billing.md` ("A closed POS bill must reach IMS", S814), word for word:

It used to return silently: the bill still closed, printed and consumed an invoice number
while Inventory never saw its revenue or ingredient usage, so POS Sales Report and IMS
MonthlySummary disagreed by an unbounded amount with nothing on either page saying so. Found live
on a test client — 15 bills, NPR 18,900 — caused by Ashadh 2083 being left open past its end while
Shrawan was never created, so every bill rung after the BS rollover bailed.

## Loyalty ledger restore

Moved from `.claude/rules/pos-billing.md` (S815, to keep the POS rules load under its ceiling).

`pos_loyalty_ledger` deliberately has no client INSERT/UPDATE/DELETE policy — the two
`SECURITY DEFINER` RPCs are the only write path, the same shape as `apply_pos_item_comps` (S579)
and `set_outlet_access` (S617). But **Export/Import restore inserts through the BROWSER as
`authenticated`**, not through the service role (`restoreClientData.js`), so that lock would have
silently restored every customer's balance as zero and reported success. An admin-only INSERT
policy fixes it without touching the actual threat, which is a till JWT minting itself points.

**A lock that breaks the backup is not a security posture.** Ask of any new locked-down table:
what writes it during a restore, and as which role? It only surfaced because `RESTORE_ORDER` is a
step on the new-feature checklist.

**Verifying such a table needs a PAIR of measurements, never one.** `authenticated` holds INSERT
so the restore path works, which means `has_table_privilege` proves nothing about who is refused.
The evidence is the same row sent to the same table by two identities: Owner → `403 / 42501`,
admin → `201`. A guard that refuses everyone is indistinguishable from a correct one until the
day a restore comes back empty.

**Reading your own role needs the token's `sub`.** `profiles?select=role&limit=1` returns an
arbitrary row for an admin, because an admin can read every profile — it reported the admin
account as `role: client`. Key the query to the JWT's `sub`, and cross-check with a row count
(admin sees all profiles, a client sees exactly one).

## Till release history

Moved from `.claude/rules/pos-billing.md` (S823, to keep the POS rules load under its ceiling).

A till is one long-lived page: the lock, a PIN sign-in and the KDS move by `navigate()`, and a
`CACHE_NAME` bump replaces the worker's cache, never the page running. So until S809 a tablet ran the
code it opened with until someone reloaded it. The defence was keeping every changed RPC callable by
an old page (`p_expected_version DEFAULT NULL`), which protects only the changes someone remembered.
The floor stood at NULL from S809 1b (2026-10-09) until S822's header probe proved `x-crest-build`
reaches the database; S823 (5c) raises it to 438, the first build whose close carries `items_version`,
in a second migration applied only once that build is live (`20261013100100`).

## Backfill batching

Moved from `.claude/rules/pos-billing.md` (S828, to keep the POS rules load under its ceiling).

**That backfill could not finish the months it exists for (fixed S629).** It wrote three sequential
round trips per bill — `sales_entries` insert, `stock_movements` insert, `ims_posted_at` stamp —
plus one update per already-posted bill, so an 800-bill month was ~2,400 requests against the 120 s
wall clock `Periods.js` bounds it with. The operator saw a timeout, and the busier the month the
more certainly it failed. It now prepares every bill's rows first and writes in batches of 40, with
a per-bill retry when a batch is rejected so one bad bill cannot cost its 39 neighbours, and each
bill stamped only after its own revenue lands so an abandoned run leaves the rest for the next one.

**Its own double-post guard was the thing most likely to truncate.** The guard reads
`sales_entries` by `.in('pos_order_id', everyCandidate)` — one row per sold *line*, so a few hundred
bills is already thousands of rows, and the id list itself outran the request URL. Either failure
makes posted bills look unposted, and the function then posts their revenue again: precisely the
bug the guard exists to prevent. It is paged and chunked now, and a failed read **aborts** rather
than being read as "none of these has posted". `backfillPosToIms.test.js` asserts the round-trip
counts as exact numbers, because a regression to per-order writes is invisible otherwise.

## Operational screens sweep

Moved from `.claude/rules/pos-billing.md` (S830, to keep the POS rules load under its ceiling).

**That sweep stopped at the report pages, and S629 found the rest.** The reports were clean; the
*operational* screens were not, and several of them read tables with nothing at all to bound them:
`pos_customers` (a row per phone that has ever been on a bill, so past 1000 a regular cannot be
found by the search box), `pos_parking_slips` (every slip ever; since S814 open slips plus a date range on All), `pos_shifts` history (two or three
a day crosses 1000 inside the first year), Credit Notes' candidate list (its range is whatever the
two pickers are set to), the Z-report's own `pos_orders` read, and `pos_kot_log` on the **Kitchen
Display** — that one sorted oldest-first, so truncation drops the *newest* tickets, the ones the
kitchen is waiting on. The lesson repeats S613's: a sweep organised by table finishes the table it
was named after and leaves its neighbours. Ask rows-per-what, and ask it of the screen as well as
the report.

## Dropped write errors count

Moved out of `.claude/rules/pos-billing.md` (S835, to keep the POS rules load under its warning line).

supabase-js **resolves** with `{ data, error }` — it does not throw on a database error. The general
rule is in root CLAUDE.md; what follows is what that cost specifically here, because `PosOrders.jsx`
carried 32 sites of it (12 reads taking `data` without `error`, 20 writes destructuring nothing) and
**three `try/catch` blocks whose `console.error` had never once run.**

## Table moves design

Moved from `.claude/rules/pos-billing.md` (S836) to keep its load under the check:docs ceiling; the rule there is the summary.

- **The server moves what is STORED, in one transaction** (`20261014120000`): `move_pos_order_table`,
  `join_pos_tables`, `release_joined_table`, `move_pos_order_lines`, `split_pos_part_bill`,
  `put_back_part_bill`, DEFINER, any POS rank. Each locks bills (id order) before tables, refuses a stale
  view (`stale_order`), moves lines with price, choices snapshot and sent count (sent units first), and
  bumps `items_version` on every bill it touches, so a till holding the old view is refused at its next
  save or close. A line landing on a bill that has one of the same key becomes one line at the LOWER
  price (`pos_merge_line`; owner default): `save_pos_order_items` keys stored prices by line, so a bill
  must never hold two uncomped rows of one key. Every action writes `pos_table_moves` (KOT Log → Moves).
  A client PATCH of an open order's `table_id`/`table_name`/`part_of_order_id` is ignored.
- **A join takes the other bill over and deletes it**: lines, tickets (`guard_pos_kot_log` lets
  `order_id` alone change under `crest.pos_table_join_rpc`), pulled-item records, guest orders, seated
  bookings, part bills, its joins and its moves; covers add. Refused while it holds loyalty points. A
  joined table is a `pos_table_joins` row: taken, no bill of its own (`pos_table_joined`), "With T3".
- **A part bill** has no table (`table_id` NULL, the table's `table_name`, `part_of_order_id`), so one
  open bill per table stands. It is dine-in everywhere covers are counted (`coversMath.isDineIn`, and
  `get_group_summary`) and out of turn time. It opens into Payment through `billOnOpenRef`; Cancel offers
  `put_back_part_bill`. An equal split is ONE bill and share slips (`equalShares`), never part-dish invoices.
- **The database frees tables** at a close or an open bill's delete (`pos_orders_release_tables`: its own
  and joined tables, Occupied only, while no other open bill or join holds them). The till frees none: it
  used to free the table on its screen, which after a move elsewhere was another party's.
- **Food sent and then moved stays on its tickets' bill.** `pos_moved_out_sent` (SQL) and
  `kotMoves.netMovedOutSent` are a pair: the Kitchen Display's Clear rule and KOT Reconciliation add it.
  A join needs none (its tickets move), and `move` keeps the bill's id.
- **The screen trusts the stored table**: `OPEN_ORDER_SELECT` reads it, `showLoadedOrder({ stored })`
  keeps it in `screenOrder`, every ticket and slip prints `screenTableName`, `reloadAfterStale` follows a
  moved bill, and a bill gone from the server is looked up in `pos_table_moves` (`openWhereBillWent`).
  The kitchen hears a move twice: a MOVED slip per station with food still live and a CHANGE ticket on the
  bill that has the food (`tableMoves.js`), and the KDS shows a ticket under its bill's table now.

## Idle lock stories

Moved from `.claude/rules/pos-billing.md` (S836) to make room under the check:docs ceiling.

- **The exemption keyed off the resolved rank once (S575→S583).** Any admin or Owner on a machine that had
  ever completed POS device binding was silently signed out after 3 idle minutes, reported as "why does
  the app sign me out when I leave for a while". The rule: key the exemption off the RAW `profile.pos_role`.
- **Returning to the tab used to reset the timer (before S754).** Timers do not run while a tablet sleeps,
  so a tablet that slept for an hour handed whoever woke it three more minutes of the absent waiter's
  session, under that waiter's name on every bill.

## IMS handoff sentences

Moved word for word out of `## The IMS handoff is the seam where money goes missing` in `.claude/rules/pos-billing.md` (S842, to keep the POS rules load under its warning line). These are the paragraphs as they stood; the rule stays there in shorter form.

**A closed POS bill must reach IMS, and if it can't, that must be visible.** Since S830 the DATABASE
posts it. `pos_orders_post_to_inventory` (5f-1, `20261013160000`; AFTER UPDATE OF status to billed,
DEFINER) runs `pos_post_bill_to_ims` → `pos_post_bill_into` in the close's transaction, inside an
exception block, so a failed post never refuses a close and is rolled back whole. The step makes the
INVOKER guards' checks itself (billed, this outlet's, not yet posted, Inventory on with NULL as on, the
bill's Nepal day in the month), writes `pos_bill_sales_rows` in one statement, then
`pos_bill_stock_lines`, and marks a no-dish bill. A bill whose month is not the one OPEN in Inventory
waits, unmarked, on the floor banner. An outlet without Crest IMS posts nothing and leaves bills and
notes unmarked (`outletHasIms`). **Inventory starts the day it is switched on (5f-3, Q31 a, reverses
D6/D7):** `clients.ims_since`, stamped at every switch-on; a bill closed before it, or a note on one, is
never posted, counted or badged (`billCountsForIms`, SQL `before_inventory`). The till only reads the mark back (`billReachedInventory`,
5f-2) and notes a miss. The bill still closes either way. A silent return once left 15 bills out of
Inventory unnoticed.

**`sales_entries` and `stock_movements` can diverge on a bill posted before S830, so neither is
evidence of the other.** The browser's post wrote revenue first and depletion second, best-effort,
so such a bill can have revenue and no movements. A backfill guard that inferred "already posted?"
from `stock_movements` double-posted two bills' revenue on real data. Both tables carry a link to the
order (`stock_movements.ref_id`, `sales_entries.pos_order_id`); ask the table you actually mean.

## Table-scoping stories

Moved word for word out of `## Table-scoping traps in this module` in `.claude/rules/pos-billing.md` (S842, to keep the POS rules load under its warning line). These are the paragraphs as they stood; the rule stays there in shorter form.

**`items` is fenced from a POS PIN login, and a fenced read is `[]`, not an error (S809 2f).** On a
PIN every yield read 100% and every comp its typed Cost Price. The till's comp costs now read
through `pos_recipe_book` (DEFINER; the operator, or a POS Supervisor+ or
the Owner of that outlet; quantities and costs only) via `posRecipeBook.js` (`posFoodCosts`), which feed `recipeCost.js`' `{ book }` walk. Its one SQL copy is the server's post, `pos_bill_stock_lines` (S830, owner Q30 a): a change to either lands in both, with `serverPostTwin.test.js` and a migration probe asserting the same fixture. Comps cost
through `posLineCosts` (S838: recipe plus the STORED line's choices, never the cart). A Staff PIN opening a comp slip is told only a Supervisor+ sees
food costs; an IMS login reaches neither (`no_ims_staff` hides till bills).

**Every period-scoped read here needs `fetchAllRows`.** Six `pos_orders` reads had none and capped
silently at 1000 rows. The worst fed the **IRD Annexure 13** one-lakh threshold, where truncation
drops a party below the disclosure line on a statutory filing — and its *child* item read was
already paged, with a comment explaining why, while the parent was not. Same asymmetry existed on
Covers (truncation skews averages, not just totals), Exceptions, the KOT Register and Customers'
unbounded outstanding-credit read.

**An `.in(column, ids)` list is a URL as well as a row count.** A uuid costs ~37 characters, so a
few hundred ids is past what proxies accept — that failure is a loud 414, but the row cap still
applies underneath and one order owns many rows. `fetchAllRowsChunked(ids, makeQuery)` and
`runChunkedByIds(ids, makeQuery)` in `src/shared/fetchAllRows.js` handle both at once. The
backfill's already-posted guard, above, is the case that needed them.

## Shift close stories

Moved word for word out of `## Shifts` in `.claude/rules/pos-billing.md` (S842, to keep the POS rules load under its warning line). These are the paragraphs as they stood; the rule stays there in shorter form.

**The Z-report must be captured at close, not at page load, and then frozen.** It used to be
computed when the page mounted and never persisted: opening at 8pm and closing at 11pm omitted
three hours of takings from Expected Cash and the Variance, and because Shift History recomputed
live, a *reprinted* Z-report could show different numbers from the one that was signed. The report
is now re-read when the close modal opens **and** again immediately before the write (the drawer
count itself takes minutes), then stored on `pos_shifts.closing_report`. History renders that
snapshot; only pre-S573 shifts fall back to a recompute.

**Expected Cash is `opening + cash sales + cash in − cash out`, from one helper
(`expectedCashOf`)** used by the screen, the close modal and the printed slip. Cash genuinely
moves without being a sale in this market — supplier payments, staff advances, float drops — and
most importantly a customer settling an older **Credit** bill in cash: that order's
`payment_method` stays `'Credit'` forever, so the drawer read as "over" by the settled amount with
no explanation. `pos_cash_movements` (pay_in / pay_out / credit_settlement) is that ledger, and
`PosCustomers`' settle action posts to it automatically.

**Since S754 (`20260916110000`) there is a fourth movement kind, `refund`**: cash handed back
against a Credit Note, manager-only, one per note, pinned to `direction = 'out'`, so
`expectedCashOf` needed no change. A movement is never edited or deleted (correct it with a second
one), and a closed shift is immutable. **A cash settlement of a delivery-partner bill posts
`paid_amount − commission`**, because that is what the platform remits. Posting the gross left
every such shift reading short by the commission.

- **Charge and Complimentary need an open shift.** `closeOrder` re-reads it itself rather than
  trusting the cached `loadOpenShift`, so every bill lands on a drawer count. A Void does not need
  one. BHATTI CHOILA had billed all 18 of its recent bills with no shift open, so this changed a
  real client's routine.

- **A failed Z-report read refuses the close.** Both batches used to drop `error`, and the close
  froze a complete NPR 0 report into `closing_report` and printed it on the signed slip.

**`salesTotal` is "Total Sales", not "Total Collection"** — it includes Credit bills, which are
billed but not collected. The screen had this right and the signed paper slip had it wrong.

**`loadShiftReport` is rebuilt on every page load and every expanded history row, so its reads are
worth keeping flat (S629).** It ran four in a waterfall: the cash-movements read needs nothing from
the orders read, and the payments and items reads derive their `.in()` lists from `orders` but
nothing from each other — two waves, not four. Its `pos_orders` read is also paged now, because
every figure on the report is summed from it and a truncated one understates the drawer with no
error anywhere; the two `.in()` reads are chunked.

## Atomic line save story

Moved word for word out of `## Order lines` in `.claude/rules/pos-billing.md` (S842, to keep the POS rules load under its warning line). These are the paragraphs as they stood; the rule stays there in shorter form.

**Replacing an order's lines must be atomic.** It was a `DELETE` then a separate `INSERT` from the
browser, so a failure or stall between them left a live order with **zero lines** on the server —
the floor tile reads NPR 0 and only the browser's in-memory state can recover it. Same shape that
cost Sales Entry real data (S456). Use `save_pos_order_items`, which is
`SECURITY INVOKER` so all three RESTRICTIVE staff-isolation families on `pos_order_items` stay
enforced, and derives `client_id` from the order rather than taking it as a parameter.

## Close guard origin

Moved word for word out of `## Server-side enforcement of the close (S577)` in `.claude/rules/pos-billing.md` (S842, to keep the POS rules load under its warning line). These are the paragraphs as they stood; the rule stays there in shorter form.

`pos_orders_client` is a plain same-client `FOR ALL` policy, so a Staff-rank till JWT holds UPDATE
on every one of its own client's orders — and the discount cap and the void permission were both
React. A single PATCH with `{"close_type":"void"}` or any `discount_amount` walked past them.
Privilege invariant #3 in its POS form.

- **~~It fires only when `close_type`, `status` or `discount_amount` actually change.~~ Superseded
  S754 — see "A guard on how a bill closes is not a guard on a closed bill" below.** The void and
  discount-cap checks inside it still fire only on those three columns; the function now also locks
  every closed bill. **S809 1c:** the void test keys on `status = 'voided'` OR `close_type = 'void'`,
  and every close must be billed + paid, billed + writeoff or voided + void (HINT
  `pos_close_mismatch`). The CHECK `pos_orders_status_close_type_check` holds the same pairs,
  COALESCE'd because a CHECK passes on NULL. Until then `{"status":"voided"}` with no close type
  skipped Allow Void and dropped the bill out of every report (CHECKOUT-2).

- **`closeOrder` now persists the cart through `save_pos_order_items` before billing a paid
  order**, because the trigger can only measure the cap against STORED lines and the Payment
  button never gated on a dirty cart. That also closed a quieter divergence that predates the
  trigger: the till posted revenue from the in-memory cart (until S814; the server posts the stored
  bill since S830), so an unsaved line was already reaching IMS revenue and the printed bill while never
  existing in `pos_order_items`.

## Pulled item origin

Moved word for word out of `## Pulling an already-fired item is now on the record (S577)` in `.claude/rules/pos-billing.md` (S842, to keep the POS rules load under its warning line). These are the paragraphs as they stood; the rule stays there in shorter form.

`save_pos_order_items` replaces an order's lines wholesale, so a line carrying `sent_to_kot` simply
ceased to exist on the next save: food cooked, ticket printed, line gone from the bill and from
every report that reads it. The only surviving trace was `pos_kot_log`, which is why KOT
Reconciliation could say *that* it happened but never who, when or why. No privilege was needed.

- The **offline replay** was moved onto the same RPC. It was still delete-then-insert, which meant
  going offline was a way to pull a fired item leaving no trace — and it carried S573's
  non-atomic-save risk besides.

- **A delete outside the RPC records too (S755, `20260917100000`).** Clear Occupied and any REST
  delete of an open order's lines used to take fired food with no record. An AFTER STATEMENT trigger
  on `pos_order_items` (and a BEFORE DELETE on `pos_orders`) writes the removal with reason
  "Table cleared", using the RPC's own definition of sent, skipped inside the RPC
  (`crest.pos_items_rpc`), for a non-browser request (the JWT role claim, since a cascade changes
  `current_user`) and when the client itself is being deleted. **`pos_kot_removals.order_id` is now
  nullable and SET NULL**, with `order_no`/`table_name` snapshotted, because the record has to
  outlive the order it was pulled from — under CASCADE, Clear Occupied's second statement destroyed it.

- The 2-arg `save_pos_order_items` signature was **dropped**, against the standing keep-the-old-
  arity rule in `.claude/rules/supabase-sql.md`. PostgREST resolves by argument name, so keeping
  both would make every 2-arg call ambiguous (`function is not unique`) — dropping it is what lets
  a stale bundle keep working via the parameter default. **S754 did the same to the 3-arg form**
  when it added `p_expected_version`, for the same reason.

## Comp guard holes

Moved word for word out of `## Item-level comp is enforced server-side too (S579)` in `.claude/rules/pos-billing.md` (S842, to keep the POS rules load under its warning line). These are the paragraphs as they stood; the rule stays there in shorter form.

The last member of the family, and the one with the most to lose: a comp is the single action whose
purpose is to make revenue disappear on purpose. (S809 2b: the whole-recipe path skips comped lines,
and an entry that comps nothing refuses the whole call, `pos_comp_line_missing`; a comped row on an
open order is a cancelled close's leftover, and `foldCompedSplits` folds it into its line on load.)
Three holes, all in the same act:

- **Nothing guarded the columns.** A till JWT could PATCH `comped = true` onto any of its client's
  lines — the line leaves the bill (`payableOrderItems`, SalesReport, demandForecastData and both
  Credit Note files all filter on it) with no NC number, no reason, no attribution, no slip.
- **The RPC checked client, not rank.** `apply_pos_item_comps`' guard was `is_admin() OR same
  client`, while the UI gates the comp panel on `hasPosAccess('supervisor')`. A Staff-rank account
  that never sees the control could call the function directly.
- **`p_comped_by` was caller-supplied**, and it feeds the column the Sales Exception Report ranks
  staff by. A caller could comp under a colleague's name. **Attribution the subject can choose is
  not attribution** — same lesson `save_pos_order_items` already applies to `client_id`.

- **`COALESCE(..., false)` around every authorisation condition.** `pos_role` is NULL for any
  account with no POS access, `NULL IN ('supervisor','manager')` is NULL, and `IF NOT NULL THEN`
  never fires — so the unwrapped form falls open for precisely the accounts with no rank. The
  pre-existing client check had the same shape and was wrapped at the same time.

## Closed bill open story

Moved word for word out of `## A guard on how a bill closes is not a guard on a closed bill (S754)` in `.claude/rules/pos-billing.md` (S842, to keep the POS rules load under its warning line). These are the paragraphs as they stood; the rule stays there in shorter form.

S577–S579 guarded the moment of the close: the void permission, the discount cap and the comp. The
S754 re-analysis found that **nothing guarded the bill after it**. `pos_orders_client`,
`pos_order_items` and `pos_order_payments` are plain same-client policies. So any till login,
a Staff-rank waiter's PIN included, could do all of this over REST to a printed, numbered
Tax Invoice:

- PATCH its lines, amount or buyer PAN;
- insert or delete its payment legs;
- flip it back to open;
- delete it outright.

A guard that checks the transition protects the transition, and a closed row is a different
state.

Migration `20260916100000` (applied live 2026-09-14) locks it, and a new money guard must fit
the same four rules:

## Rank guard origin

Moved word for word out of `## A rank the screen requires must be enforced by the table (S754)` in `.claude/rules/pos-billing.md` (S842, to keep the POS rules load under its warning line). These are the paragraphs as they stood; the rule stays there in shorter form.

Every POS screen already hid its controls by rank. The table behind each one took any login of the
outlet. **A button that does not render is a statement about the page, not about the data** — the
same lesson as S636's `/pos` route guard, one layer down. `pos_caller_has_rank(level)` in
`20260916110000` is the one POS rank test: admin, the Owner, or a POS login at that rank whose
login neither a Final Settlement nor POS Staff (`pos_blocked_at`, S809 3i) has blocked, with every
operand COALESCE'd. Every trigger below calls
it rather than carrying its own copy, and since S809 1j so do `apply_pos_item_comps`,
`caller_can_set_menu_price` (`pos_caller_has_rank('manager') OR ims_caller_has_rank('manager')`) and
`settings_guard_staff_roles`' POS lines: the last copies are gone. **The operator is exempt from rank,
never from the record (S809 1l, Q26 a)**: outside a restore it meets the same integrity checks on
credit notes, cash entries, shifts, payment lines, customers, tickets and slips (S819). The restore is
an operator INSERT of a row dated before the transaction (`opened_at`/`created_at`/`sent_at` <
`now()`); no screen sends those columns, nor may a new one.

## Bill math history

Moved word for word out of `## One bill-math primitive, however the report slices it (S580)` in `.claude/rules/pos-billing.md` (S842, to keep the POS rules load under its warning line). These are the paragraphs as they stood; the rule stays there in shorter form.

`computeCategoryAmounts` and `computeItemAmounts` in `posBillingMath.js` were byte-for-byte the
same proportional-discount allocation differing only in the grouping key, and the Product Type tab
would have made a third. Both are now delegates of
`computeGroupAmounts(order, items, vatReg, keyOf, seedOf)` — signatures unchanged, so no call site
moved. **A new way to slice a bill is a new `keyOf`, never a new copy of the arithmetic**: this is
money math on the bill, and the rule that keeps COGS in one place (`imsFormulas.js`, S551) applies
here for the same reason. The proof the refactor was exact is that the pre-existing reconciliation
tests passed untouched; the invariant they assert — buckets sum back to `computeOrderAmounts` —
now covers any key.

**The credit-note branch changed in S754 (owner decision).** Until then a credit-noted bill
contributed returned quantity only and never revenue, and simply vanished from Daily. That removed
it from the day it was really sold on, so that day no longer matched the Z-report or the bill book,
and the reversal appeared nowhere. Now, on every tab including 1L+:

**A SPLIT bill is spread across the methods it was paid with** (S754, owner decision), in
proportion to its `pos_order_payments` legs. Before, the whole bill sat under 'Split', a method
nobody pays with, so Payment Summary's Cash could never tie to the Z-report, which always counted
each leg under its own method. A split bill with no legs recorded shows as
`SPLIT_NO_BREAKDOWN`, never silently as Cash.

**The Product Type tab's axes come from data that already existed and nothing was reading:**
`settings.pos_bot_categories` (Kitchen/Bar — the same set `sendTicket()` routes BOT by, read through
`barCategoriesOf` (NULL = ['Beverage'], empty = no bar and no BOT button, S809 3m), so the report and
the tickets cannot disagree), `pos_order_items.vat_rate` (as billed), and `recipes.is_veg`. An axis
that could only ever produce one row is **hidden, not rendered empty**. When verifying that, note a
hidden axis and a broken lookup look identical on screen — confirm the fetch returned 200 before
concluding the client simply has no data.

## Delivery partner rollup story

Moved word for word out of `## A delivery platform is a party, not a tag on a bill (S596)` in `.claude/rules/pos-billing.md` (S842, to keep the POS rules load under its warning line). These are the paragraphs as they stood; the rule stays there in shorter form.

Sales Report → Delivery Partners listed every Foodmandu/Pathao bill and totalled all of them
together, and Customers → Outstanding Credit was bill-by-bill too. So **no screen in the product
could say what one platform owed, or what one platform had taken** — the platform existed only as
a badge on a row. Both screens now carry a per-partner rollup. Four rules came out of building it:

**Commission is measured against the ex-VAT, post-discount base with comped lines excluded — never
`paid_amount`.** That is the base `PosCustomers.jsx` settles on, because it is the base Foodmandu
and Pathao themselves invoice on (confirmed with the client at S290, and the reason the very first
version of the settle flow was wrong). An effective rate computed off the VAT-inclusive total reads
about 13 percentage points low on **every** bill of a VAT-registered client, so a report built that
way would accuse every platform of over-charging, every month, in the alarming direction. Recompute
through `computeOrderAmounts` rather than storing a second copy of the base.

**A rollup must reconcile with the total printed beside it.** Customers' rollup keeps a
**Direct customers** row for non-partner Credit precisely so its Outstanding column ties to the KPI
card directly above it (S567's Stock Count lesson, applied before it could bite). Its figures
legitimately differ from the report's — that page is every Credit bill ever, the report is a date
range — which is stated in a line under the table, because two screens showing the same words and
different numbers is a support call.

Effective rate = settled commission ÷ ex-VAT settled base. The contracted rate it is checked
against is `settings.pos_delivery_partners[].commission_pct`, which existed for a long time as a
settle-time pre-fill and was read by nothing else.

## Slip date story

Moved word for word out of `### A printed slip is stamped with the BILL's moment, not the print's (S670)` in `.claude/rules/pos-billing.md` (S842, to keep the POS rules load under its warning line). These are the paragraphs as they stood; the rule stays there in shorter form.

`buildBillHtml` and `buildCompSlipHtml` derived Date, Miti and time from `new Date()`, so every
reprint — and every preview opened from the Sales Report's Bill Register, which is exactly what that
row click does via `viewPosBill()` — put **today** on a month-old Tax Invoice. Both now read
`order.closed_at`.

## Send flag and replay stories

Moved word for word out of `## A dropped write error in this file is how a dish gets cooked twice (S654)` in `.claude/rules/pos-billing.md` (S842, to keep the POS rules load under its warning line). These are the paragraphs as they stood; the rule stays there in shorter form.

- **Printing a ticket is gated on the `sent_to_kot` write, never the other way round.** That flag is
  what makes "already sent" true for every other device and for this one after a reload. It was
  dropped on failure while `setOrderItems(sent)` and `printTicket()` ran unconditionally — so a
  refused write put food in front of the kitchen that the system still counted as unsent, the KOT
  badge returned, and the next press cooked the same dish again. Both send paths now print only if
  the flag landed; the order stays saved and only the send is unwound. **Do not reorder these.**

- **The offline-replay status check is a guard, so it fails CLOSED.** It reads `pos_orders.status`
  to avoid overwriting an order another device billed while this one was offline; on a dropped read
  error `current` was null, the `if` false, and the replay proceeded — the check stopped working
  exactly when the network did. It now throws to stay queued, with `PGRST116` (row gone) routed to
  the existing conflict list rather than retrying against a dead id forever.

- **A failed poll must not write its empty result.** `loadKotStatus` wrote `{}` and blanked every
  table's kitchen badge, which a waiter reads as "nothing has been started". Same shape in
  `loadOrderKotTickets`, `loadPendingGuestOrders` (which also cleared `seenGuestRequestIds`, so the
  next good poll re-chimed for requests already seen) and `loadOpenShift`, whose null would silently
  unlink every later bill from the open shift and leave the Z-report short. All four keep last-good.

## Close read-back evidence

Moved word for word out of `## A close whose answer is lost is read back, never retried blind (S776)` in `.claude/rules/pos-billing.md` (S842, to keep the POS rules load under its warning line). These are the paragraphs as they stood; the rule stays there in shorter form.

- **A timeout, a dropped connection or a gateway 5xx on the close write is not a failure** (`noAnswer`, S833 for the 5xx). `closeAttemptRef` is set just before the write; `settleUnknownClose()` reads the bill: closed by this login with this close type → `finishClosedBill()` (legs, print, the rest); open straight after the timeout → keep the mark, the write can still land; unreadable → say it is unknown. The next press AND Cancel settle it first. Without this a retry was refused "already closed" and blamed on another till, and the bill never printed.

- Verified live by letting the PATCH reach the server and aborting its response (`route.fetch()` then `route.abort()`), and again with the read-back also aborted.

- **The order screen has a phone layout and a touch floor.** Below 700px (`narrowTill`) the menu takes the width and the cart is a bottom sheet (`cartOpen`); keep TOTAL and the action buttons outside the folded part. A new control on the order screen takes `.till-hit` (square) or `.till-hit--row` (Layout.css, `pointer: coarse` only) and never an inline `minWidth`/`minHeight`, which would beat the class. The message line (`msg`) renders above Send, not in the top bar. Measured S776: 0 of 32 controls under 44px at 820px touch (was 24 of 36).

- **Floor and order-screen conventions (S776 polish).** The floor's Inventory-posting banner (`PosImsPostingBanner`, S809 3j) renders only for `canSeeImsPosting` (admin, Owner, POS manager; outlet has Crest IMS, S814); its misses are pruned by every count that answers (`pruneImsMisses`). An inactive table is muted by a dashed edge, never opacity. 10px is the floor for text on the till (the 9px chips were raised). Prices on the till go through `fmtNpr`. Void is `btn btn-danger btn-danger--strong` and Complimentary `btn amber-action-btn` — tints, not solid fills. Payment is the outlined `btn-ghost` beside Send's fill. The covers numpad and "Cash received" (Enter confirms) take the keyboard. `.table-wrap` is `position: relative` app-wide so an `.sr-only` child cannot widen the page.

## Tender and loyalty history

Moved word for word out of `## Anything that takes money off a bill is a TENDER or a DISCOUNT, and the choice is not cosmetic (S618)` in `.claude/rules/pos-billing.md` (S842, to keep the POS rules load under its warning line). These are the paragraphs as they stood; the rule stays there in shorter form.

3. **NOT `PAYMENT_METHODS`** in `posOrdersConstants.js`. That is the list a cashier PICKS from, and
   a redemption is not picked — it is applied when the customer has a balance. S290→S291 already
   learned this by adding Foodmandu/Pathao there and reverting it.

- **Both older RPCs checked `profiles.client_id`**, the HOME outlet. They moved to `my_client_id()`
  like everything S750 swept.

## Signal colour origin

Moved word for word out of `## One colour vocabulary, and loudness tracks demand for action (S661)` in `.claude/rules/pos-billing.md` (S842, to keep the POS rules load under its warning line). These are the paragraphs as they stood; the rule stays there in shorter form.

`src/modules/pos/posSignals.js` is the module's single colour vocabulary — table status, ticket
stage, close type, rank, the two strip helpers — and the header comment is the normative statement
of what each hue means here. It exists because eight distinct meanings had accumulated on amber
alone, including three categories ("Foodmandu", "supervisor", "reserved") and two states that are
the *good* outcome.

**The rank ladder is now one value, not three files.** All three staff screens read
`STAFF_LEVEL_BADGE` from `src/shared/staffLevelBadge.js`. The identical decision had been made
independently in HR, IMS and POS, and two of the three had drifted: a Supervisor was amber in IMS
and POS — the same amber those modules use for "needs attention" — and brass in HR. Adding a fourth
module now costs nothing.

## Settings RLS and offline queue history

Moved word for word out of `## Server-assigned numbers, the offline queue, and `settings` RLS` in `.claude/rules/pos-billing.md` (S842, to keep the POS rules load under its warning line). These are the paragraphs as they stood; the rule stays there in shorter form.

- The offline stock count (and POS order-taking) uses IndexedDB (`src/utils/offlineQueue.js`, DB name `crest-offline`) with 10 object stores. Sync flushes on reconnect, on mount and every 15 s while anything waits. **Any read-modify-write on an offline store must happen inside a single `readwrite` transaction** (get + merge + put together), never a readonly get followed by a separate readwrite put — IndexedDB only serialises *overlapping readwrite* transactions on a store, so the two-transaction shape lets concurrent callers read the same pre-image and clobber each other's write. This was a real bug (S440): `saveOrder` fires `logKotSend('KOT')` + `logKotSend('BOT')` un-awaited, both routing through `enqueuePosOrder`, which silently dropped one station's queued KOT send offline until the merge was made atomic. POS billing is hard-gated offline (`payBlocker` includes `!isOnline` and unread settings), so the offline surface is order-taking only — no money path is ever reachable without a live server.

- `settings` was, until S290 (`20260707150000_settings_rls_same_client_write.sql`), the one client-scoped table whose INSERT/UPDATE RLS policies were **admin-only** with no same-client allowance — every settings-writing tab in `PosTableManagement.jsx` (Discounts, Quick Notes, Ticket Routing, Delivery Partners) had been silently no-op'ing for any real (non-admin) client login, since an RLS-blocked write returns zero rows changed with no error rather than throwing. Now follows the standard `is_admin() OR client_id = my_client_id()` pattern like every other table; the `client_id IS NULL` global-defaults row (`app_name`, `app_tagline`, etc.) stays admin-only automatically since a real client's `client_id` can never equal `NULL`. Still stays on raw `supabase.from()` rather than `scopedDb` (see the `scopedDb` note above) — that's about the nullable `client_id`, unrelated to this RLS fix.

## Credit note history

Moved word for word out of `## A credit note that cannot reach Inventory is marked and posted later, like a bill (S747)` in `.claude/rules/pos-billing.md` (S842, to keep the POS rules load under its warning line). These are the paragraphs as they stood; the rule stays there in shorter form.

- **The reversal takes back what the bill POSTED**: comped lines skipped, the bill discount spread as
  the bill posted it, a `writeoff` bill reverses nothing (raw `unit_price` once over-reversed).

- **"Was money returned to the customer?" is asked on every note.** A note corrects the VAT
  register and says nothing about the drawer, so a cash refund handed over the counter with no
  record read as a shortfall at the shift close. **Cash** writes a `pos_cash_movements` refund on
  the open shift. It is checked BEFORE the note is issued, twice (when Cash is picked, and again on
  Issue), because refusing after a permanent numbered note exists is not available. **Other** and
  **None** store nothing in cash. **The answer is `pos_credit_notes.refund_method` (S755)**, shown
  in the Credit Note Book and never printed. It was appended to the reason, which printed on the tax
  document as if it were the reason. Notes issued before S755 keep that text: a printed note is not
  rewritten.
