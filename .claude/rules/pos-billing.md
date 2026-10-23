---
paths:
  - "src/modules/pos/**"
  - "src/utils/posBillingMath.js"
  - "src/utils/viewPosBill.js"
  - "src/utils/emvQr.js"
---

# POS billing, shifts and the IMS handoff

Written after the S573 critique of the POS module (campaign phase 6), which found five money-path
defects. Everything here is a rule that was broken once, in production code.

## The IMS handoff is the seam where money goes missing

**Manual Sales Entry changed in S756, and it shares these tables.** A save keeps every row's stored
`unit_price` (a correction never reprices a past day — owner decision D8); a cross-mode supersede
re-posts the superseded days' MANUAL `stock_movements` (`repostSupersededMovements`) so the ledger is
not depleted twice; the POS-supersedes check is paged and chunked; and "From POS" revenue uses the POS
rows' own `unit_price`. Since `20260918100000` the database refuses a non-manual `stock_movements`
delete from anyone but the Owner or admin, and a `pos_sale`/`pos_comp` insert below POS or IMS
supervisor.

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
5f-2) and notes a miss. The bill still closes either way.
History: docs/rules-archive/pos-billing.md#silent-ims-post, #ims-handoff-sentences

**Waiting bills are posted by the server too (5f-2, `20261013170000`).** `post_waiting_pos_bills`
(DEFINER; the Owner and the operator any month, a POS manager the open month only) runs
`pos_post_bill_into` on up to 200 of a month's waiting bills per call, each in its own subtransaction,
and answers what it did and how many still wait. `postWaitingBills` (`backfillPosToIms.js`) calls it
until nothing moves, for Periods' **Post POS bills to Inventory** and the floor's
`PosImsPostingBanner` → `postWaitingFromTill`; both then call `post_waiting_credit_notes` (5f-4,
below). A bill already carrying till sales but no mark is marked, never posted again.
`stock_movements_one_sale_per_bill_item` allows one till stock line per bill, source and item.
**Since `20261013180000` (till floor 446) only the server writes them:** `ims_sales_entries_guard` and
`ims_stock_movements_guard` refuse a `pos`/`pos_comp` sale or `pos_sale`/`pos_comp` line from any login
(`pos_sale_server_only`), the Owner and the operator included, except the operator's restore (dated
before the transaction). Never add a page that writes them; call the server.
History: docs/rules-archive/pos-billing.md#backfill-batching

**Since S809 2f (`20261009220000`) the database sets the mark with the rows.**
`sales_entries_stamp_pos_source` (AFTER INSERT statement trigger, DEFINER) marks a bill from its
`pos`/`pos_comp` rows and a credit note from its `pos_credit`/`pos_credit_restock` rows, in the same
transaction. Outside the operator's restore it locks the bill `FOR NO KEY UPDATE` and refuses a till
sale row naming no bill, an open bill or another outlet's (`pos_sale_unlinked`), and rows for a bill
that already has till sale rows from an earlier statement (`pos_bill_already_posted`). **A bill's till
sale rows go in ONE statement.** Since S809 3j (`20261010140000`) a credit note's reversal meets the
same rule: the note is locked and a second reversal statement is refused
(`pos_credit_note_already_posted`), so a note's rows go in one statement.

**An IMS login cannot read till bills (`no_ims_staff`)**, so it reads `pos_ims_waiting_counts`
(DEFINER, numbers per Nepali month) and is told who posts. **Never word a count an IMS login made
itself.**

**`sales_entries` and `stock_movements` can diverge on a bill posted before S830, so neither is
evidence of the other.** The browser's post wrote revenue first and depletion second, best-effort,
so such a bill can have revenue and no movements. Both tables carry a link to the
order (`stock_movements.ref_id`, `sales_entries.pos_order_id`); ask the table you actually mean.
History: docs/rules-archive/pos-billing.md#two-writes-diverge, #ims-handoff-sentences

**`ims_posted_at IS NULL` means "unknown" on any row closed before that column existed**, not
"unposted". Treating unknown as unposted is what caused the double-post. On a client that predates
the column, stamp the rows that already posted before running the first backfill.

**A recipe with no linked ingredients produces no `stock_movements` at all**, legitimately — the
Stock Movements page says so in its own banner. Don't read an empty movements list as a failed
post.

## Table-scoping traps in this module

**`items` is fenced from a POS PIN login, and a fenced read is `[]`, not an error (S809 2f).** The till's comp costs now read
through `pos_recipe_book` (DEFINER; the operator, or a POS Supervisor+ or
the Owner of that outlet; quantities and costs only) via `posRecipeBook.js` (`posFoodCosts`), which feed `recipeCost.js`' `{ book }` walk. Its one SQL copy is the server's post, `pos_bill_stock_lines` (S830, owner Q30 a): a change to either lands in both, with `serverPostTwin.test.js` and a migration probe asserting the same fixture. Comps cost
through `posLineCosts` (S838: recipe plus the STORED line's choices, never the cart). A Staff PIN opening a comp slip is told only a Supervisor+ sees
food costs; an IMS login reaches neither (`no_ims_staff` hides till bills).

**`sales_entries` is period-scoped, not client-scoped**, so it is deliberately absent from
`CLIENT_SCOPED_TABLES` and `scopedDb` throws for it — use plain `supabase.from()`, as
`creditNotePosting.js` does. `stock_movements` and `pos_orders` *are* client-scoped and stay on
`scopedDb`. Getting this wrong fails loudly, which is the point.

**Every period-scoped read here needs `fetchAllRows`**, a parent read as well as its already-paged
child (an unpaged `pos_orders` read once fed the IRD Annexure 13 one-lakh threshold).
History: docs/rules-archive/pos-billing.md#table-scoping-stories

**The operational screens need it as much as the reports (S629):** ask rows-per-what of each screen
(`pos_customers`, slips, shift history, the Kitchen Display's `pos_kot_log`), not of each table.
History: docs/rules-archive/pos-billing.md#operational-screens-sweep

**An `.in(column, ids)` list is a URL as well as a row count.** A uuid costs ~37 characters, so a
few hundred ids is past what proxies accept — that failure is a loud 414, but the row cap still
applies underneath and one order owns many rows. `fetchAllRowsChunked(ids, makeQuery)` and
`runChunkedByIds(ids, makeQuery)` in `src/shared/fetchAllRows.js` handle both at once.

## Shifts

**The Z-report must be captured at close, not at page load, and then frozen.** It is re-read when
the close modal opens **and** again immediately before the write (the drawer count itself takes
minutes), then stored on `pos_shifts.closing_report`, so a reprint shows what was signed. History
renders that snapshot; only pre-S573 shifts fall back to a recompute.

**Expected Cash is `opening + cash sales + cash in − cash out`, from one helper
(`expectedCashOf`)** used by the screen, the close modal and the printed slip. Cash genuinely
moves without being a sale in this market — supplier payments, staff advances, float drops — and
most importantly a customer settling an older **Credit** bill in cash: that order's
`payment_method` stays `'Credit'` forever. `pos_cash_movements` (pay_in / pay_out / credit_settlement) is that ledger, and a Cash customer
payment posts to it inside `record_credit_receipt` (S843; a cancelled one is `credit_receipt_cancel`, out).

**Since S754 (`20260916110000`) there is a fourth movement kind, `refund`**: cash handed back
against a Credit Note, manager-only, one per note, pinned to `direction = 'out'`, so
`expectedCashOf` needed no change. A movement is never edited or deleted (correct it with a second
one), and a closed shift is immutable. **A cash settlement of a delivery-partner bill posts
`paid_amount − commission`**, because that is what the platform remits.

**Three shift rules are owner decisions (S754).**
- **Charge and Complimentary need an open shift.** `closeOrder` re-reads it itself rather than
  trusting the cached `loadOpenShift`, so every bill lands on a drawer count. A Void does not need
  one.
- **Closing a shift over open orders warns and proceeds.** Those bills land on whichever shift is
  open when they are charged. There is no carry-over write.
- **A failed Z-report read refuses the close**, rather than freezing an NPR 0 report onto the
  signed slip.

**The close is checked against the stored rows (S809 1l, `20261009180000`).** `pos_shifts_guard`
adds up Expected Cash itself over `loadShiftReport`'s rows (float + `paid_amount` of paid Cash bills +
Cash legs of paid Split bills + Σin − Σout) and refuses (`pos_shift_figures_changed`) a report whose
eight cash figures are missing or more than NPR 0.01 off, and (`pos_shift_count_mismatch`) a
`closing_cash`/`opening_cash` that is not `pos_cash_count_total()` of its denominations. It refuses
rather than rewrites, because the slip prints from what the page sent. **Expected Cash is now a JS/SQL
pair: change `expectedCashOf`/`loadShiftReport`'s cash rules and the guard in one commit**
(`expectedCashTwin.test.js`), or every honest close is refused. A NULL report is allowed. Not
covered: display figures.

**A bill and a cash entry lock their shift (S809 2b, `20261009190000`).** `guard_pos_order_close`
stamps `shift_id` from the outlet's open shift read `FOR SHARE` on every Charge/Complimentary (refuses
`no_open_shift`), and `pos_cash_movements_guard` reads its shift `FOR SHARE`. A Close Shift waits for a
bill or entry holding the lock and then counts it (1l refuses the stale report); one arriving after the
Close locked the row is refused. A shift's `closed_at` and the report's `capturedAt` are `now()`.
Split legs land after the close, so Close Shift waits (`pos_shift_split_pending`) while a Split bill
closed in the last 11 minutes is short of its legs: one past the legs' 10-minute window (S823).

**A Void is filed by the guard on the shift open now (S823), or none, never refused for it.** A server
`no_open_shift` on a Charge clears the till's cached id.

**PosShifts (S809 4a): every read and write is time-limited, and no answer reads "not known", never
"not opened/closed" (`shiftText.js`).** A lost Open re-reads the server; a retry meets the
one-open-shift index (23505). `loadOpenShift` runs under `useLatestRequest`; the page reloads on
`visibilitychange`, never a timer (owner decision). The Close dialog is pinned to its shift
(`closingShiftRef`): one closed elsewhere writes nothing and the page names Shift History. Messages
that outlive the dialog go in `shiftReadError`/`pageMsg`, never its `msg`.

**Comp Food Cost counts every comped dish on the shift (S856, owner decision)**: whole Complimentary bills
and the `comped` lines of paid bills (`dishCompTotal`, shown under the figure), each at `posLineCosts`'
plate cost. The Complimentary count stays whole bills.

**`salesTotal` is "Total Sales", not "Total Collection"**, on the screen and the signed slip alike:
it includes Credit bills, which are billed but not collected.

**`loadShiftReport` is rebuilt on every page load and every expanded history row, so its reads are
worth keeping flat (S629):** two waves, not four (orders and cash movements, then payments and items,
whose `.in()` lists come from `orders`). Its `pos_orders` read is paged, because every figure on the
report is summed from it; the two `.in()` reads are chunked.
History: docs/rules-archive/pos-billing.md#shift-close-stories

## Order lines

**Replacing an order's lines must be atomic**, never a browser `DELETE` then `INSERT` (a stall
between them leaves a live order with **zero lines**). Use `save_pos_order_items`, which is
`SECURITY INVOKER` so all three RESTRICTIVE staff-isolation families on `pos_order_items` stay
enforced, and derives `client_id` from the order rather than taking it as a parameter.
History: docs/rules-archive/pos-billing.md#atomic-line-save-story

**Since S754 (`20260916100000`) it is also the only thing that may put a price on a line.** The
signature is `save_pos_order_items(p_order_id, p_rows, p_removal_reason, p_expected_version)` and
it returns `{inserted, items_version, items}`. Four rules it enforces:

- **Open orders only** (`order_not_open`).
- **A NEW line is priced from the menu, not the tablet.** It takes `recipes.selling_price`, with VAT
  as `addItem()` computes it. The line must be a dish the till menu would offer: same client,
  active, `pos_enabled`, not a Sub-Recipe, with a `selling_price` above 0 (S809 2h, the guest path's
  rule; `line_not_on_menu` names the dish, and the till's menu read leaves such a dish out). An
  EXISTING line keeps the price it was saved with, so a menu change mid-meal does not reprice food
  already ordered. Comped rows count in the pulled-item record and the sent floor (S809 2h).
- **`p_expected_version` against `pos_orders.items_version`** refuses a save from a tablet that
  loaded the order before another one saved it (`stale_order`). The screen reloads the order and
  says it changed on another device, unless this till holds an unanswered save of that order (S809
  3e, below). NULL keeps the old behaviour for a stale bundle. **A close is pinned the same way
  (S823)**: it sends its save's version, and a moved one is refused (`pos_bill_lines_changed`). Only
  this function moves `items_version`; a new line writer that changes a priced total must bump it.
- **`sent_qty`** — how much of a line the kitchen already has — is stored, not held only in memory.

`guard_pos_item_price` refuses any browser write to a line's price, quantity or identity outside
that function. The function marks its own transaction with `set_config(..., true)`, which a
PostgREST table request cannot carry. `notes` stays directly writable. **A line's sent count may
rise but never fall outside the save (S809 1d, `20261009120000`)**: the count is
`GREATEST(sent_qty, qty if sent_to_kot)`, a direct write that lowers it is refused
(`pos_item_sent_lowered`), and inside the save each replacement row's `sent_qty` is floored at its
share of the stored count for its line, so a count falls only with the quantity, which the removal
record writes up. `sent_to_kot` is left as sent: false with `sent_qty = qty` is the screen's own
"edited since sent" state.

**One open order per table** is a unique index (`pos_orders_one_open_per_table`), not a
floor-view check.

**A changed instruction is its own ticket (S809 3a).** `logKotSend` logs a CHANGE ONLY line
(`isChangeOnlyLine`, `src/modules/pos/kitchenNotes.js`) as a separate `pos_kot_log` row of
`{qty: 0, change: true}` lines, in the same insert as the food; the KDS shows a CHANGE card whose Seen
moves it new → served. **Every count of kitchen tickets adds `.not('items', 'cs', KOT_CHANGE_ITEMS)`**,
and a change line is never mixed into a food ticket, or that filter hides the food. A note changed on a partly sent line also sends a change line for its sent units (`sendsChangeLine`, S833). A guest's order note
goes onto each of their dishes (`guestDishNote`, Q11 a): "Guest ×N: …" on a line already holding the
table's food.

### A line is its recipe PLUS its selection (S758, Crest Customization)

- **`lineKeyOf` in `posOrdersConstants.js` is the one definition of a line's identity**: the recipe
  id, or `recipe_id#selection_key` where `selection_key` is the chosen `pos_options` ids sorted and
  joined with `+` (`selectionKeyOf`; SQL computes the same with `ORDER BY … COLLATE "C"`). Never key a
  merge, diff, send or comp on `recipe_id` alone again — "Momo, extra cheese" and "Momo" are two
  lines. A line with no options has `selection_key = ''` and keys exactly as before.
- **A combo dish's key ends `@<combo>/<pick>` (S839, `pos-combos.md`)**: cut at `@` for option ids.
- **The tablet sends option IDS, never option prices.** `save_pos_order_items` v5 validates a NEW
  line's picks against the live menu and the dish's group rules, prices it as
  `selling_price + Σ price_delta` with each group's first `included_count` picks free (by option
  sort, name, id — `optionsPriceDelta` in `src/shared/optionPricing.js` is the JS twin for display
  only), and writes `pos_order_item_options`. An existing line keeps its price AND its snapshot.
- **The snapshot has no FK to the menu tables** and is written only inside the RPC (or by
  `apply_pos_item_comps`, or an admin restore INSERT) — `guard_pos_item_option_write`.
- **Comps are by line.** `p_full_recipe_ids` now matches only plain lines; a customized line goes in
  `p_full_lines` / carries `selection_key` in `p_partial`. The frontend sends `p_full_lines` only
  when it has one, so a plain comp keeps the old call shape.
- **`OPEN_ORDER_SELECT` reads the selection and the `pos_order_item_options` embed** (since stage 5,
  after `20260919130000` went live); `cartLineFromStored` turns the embed into `options` and the key
  into `option_ids`, so a reopened line has the shape the choice window builds.
- **A dish with option groups adds in ONE TAP when its defaults satisfy every group's rule, and
  opens the choice window only when a required group has no default** (owner decision, S759 —
  reversing S758's "always opens"). The one-tap path still goes through `addCustomLine` with
  `defaultSelection(dishGroups)`, so a defaulted size is priced and snapshotted like any pick; the
  cart's Choices / Change button opens the window for any unsent line whose dish has groups. A failed
  option catalog read is still a failed menu read — without it a dish that must have a size could go
  on plain. Since S809 2h `save_pos_order_items` refuses that too (`option_count`): every new line is
  counted while Customization is live, choices sent or not, as `pos_price_selection` counts it; a line
  already on the order keeps its exemption.
- **A sent line's choices are never edited in place** (owner decision): remove it with a pull reason
  and add it again, so the kitchen gets a fresh ticket. Change exists only on an unsent line.
- **A choice hidden or deleted mid-service never blocks the order unseen (S809 3o).** The choice
  window starts from, and Same as last restores, only offered picks (`src/shared/offeredPicks.js`); the
  cart marks unsent lines whose key is not on the saved order (`lineChoiceTrouble`); the refusal
  sentence parses `option_not_on_menu`/`option_count` (`choiceRefusal.js`): change the RAISE text and
  its regexes together.
- **Stock at close reads the SERVER snapshot, never the cart.** The cart's choices are built by the
  till and carry no stock lines; the server's post (S830, `pos_line_choice_lines`) reads the bill's
  own lines with their `pos_order_item_options.ingredient_deltas`.
  `src/utils/orderLineIngredients.js` is the only place in the app those lines become raw items; its
  SQL twin is `pos_bill_stock_lines`.
- **Phone Back on a guest dish or combo sheet steps back one step**, and on its first step with picks asks before leaving (`useLeaveConfirm`, S842); a sheet's `onClose` may return `false` to stay open.
- **The guest menu calls `get_guest_menu_options` beside `get_guest_menu`**, and a `PGRST202` (the
  function not deployed yet) reads as "no choices", not a warning to every guest.
- **Every public guest function gates on `pos_enabled` AND `client_access_open()` (S809 1h).** A
  new one copies both, and its locked answer must equal its POS-off answer.
- **A guest order is sent once and answered once (S809 3b, `20261010120000`).** `submit_guest_order`
  takes `p_request_id`, the page's key per order: a key that landed returns that order before any
  menu check (keep one overload; the 4-key call resolves through the default).
  `guard_pos_guest_order_request` allows only status/order_id/decided_*, a decided status is final,
  `decided_by`/`decided_at` are the server's and the bill must be the request's outlet's. The till
  answers with `.eq('status','pending').select('id')` and never puts a saved-but-unmarked request back
  on the banner. Guest stage reads leave CHANGE and cancelled tickets out. Closing a table's bill turns
  its waiting ones away (S817, D21), as do 30 minutes unanswered (S834, `guestOrderStale.js`); the close
  first retries this bill's unmarked accepts (S835, D40).

### A size scales the picks after it (S760, build-your-own dishes)

- **One rule in three pricers**: `save_pos_order_items`, `pos_price_selection` and
  `src/shared/optionPricing.js`. The factor is the product of the chosen SIZE options'
  `portion_factor` (NULL = 1, `pos_selection_portion_factor` in SQL, `sizeFactor` in JS). A group's
  `size_scaling` decides the rest: `stock` multiplies its stock lines, `stock_and_price` its price as
  well (`round(price × factor, 2)`, half away from zero on both sides; JS in integer paisa, 4h). A size group is always
  `none`, so a size's own lines never scale. The free-picks rule runs first, so a free pick stays 0.
  A "No …" removal is never a free pick and never counts toward the maximum, only the minimum (Q20 a,
  D15), and a new line priced below zero is refused (`option_price_below_zero`); the editors check first (`dishesBelowZero`, S835).
  Change the rule in all three, and extend the fixture shared by `optionPricing.test.js` and the
  migration's verification block.
- **The scaled quantity is frozen at order time.** `ingredient_deltas` already holds it, so no IMS
  reader multiplies anything and a later factor edit never rewrites a sent line. A snapshot reader
  costs every pick's own `ingredient_deltas` and takes kind and list price from the snapshot
  (`group_kind`, `list_price_delta`, `included`), the catalog only filling a gap (S809 3o). There is no factor
  column on the snapshot on purpose: `apply_pos_item_comps` copies the snapshot's columns by name.
- **`recipes.is_build_your_own` is a mark, not a category.** Category drives KOT/BOT routing, the
  product code prefix and the category splits. The mark makes the till always open the choice window
  (the S759 one-tap default is skipped), makes the guest sheet a stepper (size first, then Review), and
  swaps the dish's cost for a range (`src/shared/buildCost.js`, `useBuildCostRanges`).
- **The till never names the new columns in a recipe query.** The mark reaches the till, Menu Pricing and
  the range through `loadOptionCatalog`'s `buildYourOwn`, which reads `[]` on a missing column, and the
  catalog reads fall back to the S758 column lists. The admin edit dialogs write the new columns only
  when they change. **The IMS rating pages do name `is_build_your_own` since S792** (Menu Engineering,
  Recipe Margin, Best Sellers select it; Menu Repricing filters on it), so on a database without the
  column those pages fail their read, and the till does not.

## Closed in S575 (phase 8), for the record

- **Short cash tender**: single-payment Cash now blocks Confirm Payment when tendered < bill
  total (`cashShortfall` in `PosOrders.jsx` — guard in `closeOrder` too, covering the QR-poll
  path; the Change field flips to a red "Short by"). Split mode always guarded this.
- **Idle lock is WIRED** — `usePosIdleLock` runs from `Layout.js`: PIN-staff sessions on a
  bound device (`pos_device_client_id` in localStorage) lock to `/pos/login` after 3 idle
  minutes, 20s `role="alert"` countdown first. Owner/admin sessions are exempt, and a Kitchen/Bar
  login on `/pos/kds`: the exemption is the LOGIN's, not the page's (S809 1e, Q4 a; one predicate,
  `posIdleLockApplies()`). A touch after the full period locks rather than renews. Don't add a second lock per page. **The exemption must key off the RAW
  `profile.pos_role` column (`isPinStaff` in Layout.js), never the resolved `posRole` rank** —
  that rank is 'manager' for every admin and Owner, so gating on it enables the lock for
  exactly the people it must exempt (S575→S583). The same raw
  test drives the Lock-POS-vs-Sign-out label (account menu on desktop, drawer rail on a phone)
  and the sign-out routing to
  `/pos/login` vs `/login`. **Returning to the tab is not activity (S754)**, since timers do not run
  while a tablet sleeps. Idle time is measured from the last real input: past the lock period it locks at
  once, otherwise only what is left of the period is re-armed. Since S809 3h it survives a page load
  (`crest_idle_last_input` per session id, written even while the lock is off, at most once a second and flushed on pagehide, so a reload can only lock sooner), a lock is `scope:
  'local'`, and a session ending by itself on an activated tablet goes to `/pos/login`.
  **A lock keeps the unsent cart (S776, owner decision).** `handleSignOut` runs `runBeforePosLock()`
  for a PIN session; `PosOrders` keeps the unsaved units for that login in `posLockedCart.js`
  (localStorage, never the replaying offline queue) and restores them once, as unsent, through
  `showLoadedOrder`/`startFreshOrder` (`applyLockedCart`; `keptLinesToRestore`: what the server lacks,
  capped at each line's `unsaved_qty`, S809 3g), only on their own table or takeaway (`keptCartFor`, S835), never into another open order (listed instead), with
  accepted guest request ids (`guestReqs`); what is not consumed is kept again. The PIN screen names
  them. The countdown toast is `zIndex: 1100`, above the till's 1000 layer — at 400 it was invisible.
- **Sales Exceptions ranks by Revenue Impact** (discount + void menu value + comp *potential
  sales value*) — one coherent unit, **all ex-VAT since S754**; Comped Bills, the Z-report (`voidBasis: 'ex_vat'`) and
  the Owner Report share `forgoneMenuValue` since S814. Comp food cost stays in its own
  column. Never reintroduce a total that adds comp COST to revenue figures, or VAT to a sale that
  never happened.
- **The printed settlement slip's Variance now derives from `expectedCashOf`** — the same figure
  as its own Expected Cash line and the frozen `closing_report`. Exactly one definition; a local
  formula in `buildShiftSlipHtml` is how it broke last time.

## Server-side enforcement of the close (S577)

`pos_orders_client` is a plain same-client `FOR ALL` policy, so a Staff-rank till JWT holds UPDATE
on every one of its own client's orders: the discount cap and the void permission are the table's.

**`guard_pos_order_close()` (migration `20260819120000`) is a BEFORE UPDATE trigger, not the
`close_pos_order(...)` RPC the phase-6 critique proposed.** An RPC only protects the callers that
choose to call it and leaves the open policy in place; a trigger sees every write to the table,
through PostgREST or anywhere else, now and for any path added later. Same reasoning, same
`current_user NOT IN ('anon','authenticated')` seam, as `guard_profiles_privileged_columns()`.

**S809 2b (`20261009190000`):** a Charge needs a stored non-comped line and a Complimentary a line
(`pos_bill_empty`, Q8 a; the emptied-CART case is `closeBlocker`'s), and `invoice_fy` is
`pos_invoice_fy(now())` on bills, Credit Notes and NC comps, the request's ignored. That function is
Nepal's date through `bs_months`, the SQL twin of `getBsFiscalYear`: change both together. It returns
NULL past the table's end (2031-04-13) and every caller then refuses (`pos_fiscal_year_unknown`).

**S809 2c (`20261009200000`):** the close stamps `pos_orders.vat_registered` from
`COALESCE(settings.is_vat_registered, true)`. An open-order write clears it, a closed bill keeps OLD's
value (ignored, not refused), and `guard_pos_order_insert` drops it on a new order. A paid close that
SENT the other status is refused (`pos_vat_status_changed`; tills before crest-v420 send none) and the
till reloads its settings. **Every reader of a past bill uses `billVatRegistered(order, current)`**
(`posBillingMath.js`); never pass today's flag into a closed bill's arithmetic.

Three things to know before touching it:

- **The void and discount-cap checks fire only when `close_type`, `status` or `discount_amount`
  change; since S754 the function also locks every closed bill** (below). **S809 1c:** the void test
  keys on `status = 'voided'` OR `close_type = 'void'`, and every close must be billed + paid,
  billed + writeoff or voided + void (HINT `pos_close_mismatch`). The CHECK
  `pos_orders_status_close_type_check` holds the same pairs, COALESCE'd because a CHECK passes on
  NULL.
- **`paid_amount` is deliberately NOT enforced.** Re-deriving the bill total in SQL means a second
  copy of the VAT-on-discounted-base arithmetic and the round-to-the-rupee rule, i.e. a second
  definition of a figure the product is sold on. A drifted copy would not misreport a number, it
  would REJECT real bills mid-service. The two checks that ARE enforced need no money formula: the
  cap is measured against a plain `SUM(qty * unit_price)` over non-comped lines, which is
  byte-for-byte `paySubEx`.
- **`closeOrder` persists the cart through `save_pos_order_items` before billing a paid
  order**, because the trigger can only measure the cap against STORED lines and the Payment
  button never gated on a dirty cart.

History: docs/rules-archive/pos-billing.md#pos-write-guards-copy, #close-guard-origin

## Pulling an already-fired item is now on the record (S577)

`save_pos_order_items` replaces an order's lines wholesale, so without a record a pulled fired line
leaves only `pos_kot_log`, which says *that* it happened but never who, when or why.

**The fix is a record, not a block, and that is deliberate** — pulling a fired item is routine and
legitimate (kitchen ran out, wrong item fired, customer changed their mind), and rank-gating it
would stall a live service behind a manager on every genuine mistake. What was missing was the
name against it.

- `pos_kot_removals` (migration `20260819130000`) is written **inside** `save_pos_order_items`, by
  diffing stored sent quantities against the incoming rows in the same transaction. A caller
  cannot remove a fired line without producing the record, whatever it sends.
- The browser contributes **only the reason** (`p_removal_reason`), which the RPC has no way to
  invent. A missing reason renders as `none given` rather than hiding the row — that is what an
  offline sync, or a till on a pre-S577 bundle, honestly looks like.
- The **offline replay** goes through the same RPC, never delete-then-insert, or going offline
  pulls a fired item with no trace.
- Surfaced on **KOT Log → Pulled Items**. Keep Reconciliation too: it *infers* a pull from the
  order's current state, so it still catches one made by a path that predates the record.
- **A delete outside the RPC records too (S755, `20260917100000`)**: Clear Occupied and any REST
  delete of an open order's lines. An AFTER STATEMENT trigger
  on `pos_order_items` (and a BEFORE DELETE on `pos_orders`) writes the removal with reason
  "Table cleared", using the RPC's own definition of sent, skipped inside the RPC
  (`crest.pos_items_rpc`), for a non-browser request (the JWT role claim, since a cascade changes
  `current_user`) and when the client itself is being deleted. **`pos_kot_removals.order_id` is
  nullable and SET NULL, never CASCADE**, with `order_no`/`table_name` snapshotted, because the
  record has to outlive the order it was pulled from.
- **The record and the ticket log are write-guarded (S809 1d, `20261009120000`).**
  `guard_pos_kot_removals` (INVOKER, `current_user` seam) admits a client session's insert only inside
  `save_pos_order_items` (`crest.pos_kot_removals_rpc`, on for its one insert) or the operator's
  restore. `guard_pos_kot_log` (DEFINER, keyed on `auth.jwt() ->> 'role'`, because deleting a
  ticket's order cascades as the owner) makes a ticket append-only: no client delete, direct or by
  deleting its order (DELETE revoked too); the order must be the outlet's; `sent_at` and the stage
  are stamped; `sent_by` is kept only when it is a POS login of the outlet, else the uploader (Q1 b);
  an UPDATE moves only the stage, forward, with `status_updated_by` stamped; `cancelled` needs a
  voided order, Supervisor, or (S809 3d, Clear) any unblocked POS login once the ORDER no longer holds
  the ticket's dishes (its sent count per line key ≤ what its other uncancelled tickets carry), and is
  final. Stage times and the estimate are the server's (`now()` on entering the stage; the estimate
  only at Start; a skipped stage gets no time). **A DEFINER function that writes either table on a
  client's behalf is checked like the client**: give it its own transaction flag.
- **`save_pos_order_items` keeps one signature**, against the standing keep-the-old-arity rule in
  `.claude/rules/supabase-sql.md`: PostgREST resolves by argument name, so two overloads make every
  older call ambiguous (`function is not unique`), and a stale bundle works through the parameter
  defaults.

History: docs/rules-archive/pos-billing.md#pulled-item-origin

## PosOrders.jsx has THREE returns, and a modal put in the wrong one is invisible

Worth its own heading because it cost a real bug (S578) and nothing static catches it. The file
early-returns the **billing station** (`if (view === 'bills')`, S762 — the `/pos/billing` route,
which renders `BillingStation.jsx`), then the **order screen** (`if (view === 'order') return (...)`),
and then falls through to the **floor view** (`return (<>...</>)`). They render completely different
trees.

Before adding a modal here, check which return the handler that opens it lives in, and press it in
a browser: a misplaced one is a button that silently does nothing.
History: docs/rules-archive/pos-billing.md#three-returns-story

**The `bills` return is the narrowest of the three and should stay that way.** It renders the list,
`floorMsg`, the unsettled-close and write-warnings banners, `loyaltyNoteBanner`, `recentBillsModal`
(Recent Bills plus the credit-note modal it opens, S809.4) and `confirmEl`. The loyalty note and
`recentBillsModal` are elements built once and rendered by this return AND the floor's, because a
modal in one return is a button that does nothing in the other (S578). Every refusal the list can
produce (a bill closed on another till, a table gone from the floor plan, offline, an unsynced order)
goes through `floorMsg`; a Recent Bills reprint failure is a till notice (`showTillNotice`), which
shows above that dialog where `floorMsg` would sit hidden behind it.

## The Billing station is a third VIEW, never a second implementation (S762)

`/pos/billing` renders the same `PosOrders` with `billingStation`. The Bill button does not open a
bill — it runs the floor's own `openTable`/`openOrderById` and lets `openBilling()` fire afterwards.
Three properties hold it together, and each is load-bearing:

- **The arm/consume pair has exactly one consumer.** `billOrder` sets `billOnOpenRef`, and only
  `showLoadedOrder` — the single funnel every "put an existing order on screen" path goes through —
  clears it and hands off. A path that refuses instead never reaches it, so a refusal cannot leave
  the flag armed for whatever order is opened next. Adding a fourth way to reach the order screen
  means routing it through `showLoadedOrder` too, or it will silently not bill.
- **The handoff is a state flag, not an inline call.** `openBilling()` reads `orderItems` for the
  HSC codes that print on the Tax Invoice; called synchronously from `showLoadedOrder` it reads the
  pre-commit cart and the bill goes out short with nothing saying so. The effect waits for
  `view === 'order' && orderId`.
- **The two routes' `PosOrders` carry their own `key` (`orders`, `billing`; `App.js`, S856).** Without it
  React kept ONE instance across a switch, with the view it started on: a Staff PIN sent from
  `/pos/billing` to `/pos/orders` by the rank guard still saw the bills list (found on a real phone).
- **`openTable(table, { existingOnly: true })` must not fall through to a fresh order.** A row is on
  the Billing list because the floor said that table had an open bill; if it does not any more,
  another till closed it, and the covers numpad is a baffling answer to "bill this".

The list itself is derived from `tables`/`tableOrders`/`takeawayOrders` at render — the same floor
read, the same 15 s poll — so "open bill" cannot come to mean two different things on the two
screens. `pos_orders.opened_at` rides in that read and is in **both** floor signatures; a field the
list renders that is missing from a signature means a quiet poll that changed only that field never
repaints.

Note also that neither branch needs an explicit `zIndex` on a child dialog: the order screen is
`position: fixed` at 1000 and therefore its own stacking context, so a nested overlay at the default
100 already paints above it. The billing modal's 1100 is belt-and-braces, not a requirement.

## Move, join and split a table (S836)

Only the six DEFINER functions of `20261014120000` move a bill, table or line (logged, versions bumped,
merged at the lower price); the database frees tables at a close, the till none; a part bill is dine-in;
`pos_moved_out_sent` pairs with `kotMoves.netMovedOutSent`.
History: docs/rules-archive/pos-billing.md#table-moves-design, #idle-lock-stories

## How to smoke-test any of these guards

All three were exercised this way; do the same for the next one.

**Admin and Owner are exempt from every one of them by design, so an admin session proves nothing.**
Use a POS PIN account on a dummy client. The definitive check is not the UI — it is a request fired
straight at PostgREST with that session's own token, which is precisely the attack the guard exists
to stop. Read the anon key out of `/static/js/bundle.js` and the `access_token` out of
`localStorage`, then `fetch` the REST endpoint directly.

**Always include a control that must still succeed.** A guard that refuses everything looks
identical to a guard that works, right up until order-taking breaks. The close guard's control was
an ordinary bill closing; the comp guard's was a plain `{"notes": "..."}` edit on the very row whose
comp columns had just been refused.

**To test a RANK refusal you need the staff token while an admin changes that staff member's role.**
Stash the JWT in `sessionStorage` first — it stays valid independently of the session that issued
it, so one browser profile is enough. Restore the role afterwards and re-read the page to confirm it
took, rather than trusting the change event.

All three passed live on 2026-08-19, each with its control.
History: docs/rules-archive/pos-billing.md#smoke-test-results

## Item-level comp is enforced server-side too (S579)

A comp is the single action whose purpose is to make revenue disappear on purpose. (S809 2b: the
whole-recipe path skips comped lines, and an entry that comps nothing refuses the whole call,
`pos_comp_line_missing`; a comped row on an open order is a cancelled close's leftover, and
`foldCompedSplits` folds it into its line on load.) Three holes, all in the same act, are closed:
the comp columns were unguarded (a comped line leaves the bill: `payableOrderItems`, SalesReport,
demandForecastData and both Credit Note files filter on it), the RPC checked client, not rank, and
`p_comped_by` was caller-supplied (it feeds the column the Sales Exception Report ranks staff by).
**Attribution the subject can choose is not attribution** — same lesson `save_pos_order_items`
already applies to `client_id`.

`guard_pos_item_comp()` (migration `20260819140000`) fences the six comp columns on INSERT and
UPDATE; `apply_pos_item_comps` stays `SECURITY DEFINER`, so `current_user` inside it is the owner
and the guard waves it through — the only write path, the same mechanism as `set_active_outlet()`.
The RPC now checks Supervisor rank and derives `comped_by` from `auth.uid()`. Since S809 1j the rank
test is `pos_caller_has_rank('supervisor')` (a settlement-blocked login is refused), a part-comp takes
1 to qty−1 (`pos_comp_qty_invalid`), and the line's sent count is split between the two rows, the comp
taking sent units first. `pos_order_items_qty_check` backs qty ≥ 1 for every writer.

Two things to preserve if this is ever touched:

- **The cheap test must stay first in the trigger.** It fires per row on the busiest table in POS —
  `save_pos_order_items` replaces a whole line set per save — and `is_admin()` is
  `SECURITY DEFINER`, which Postgres will not inline. Comparing six columns before reaching for
  identity keeps an ordinary line at a few boolean tests.
- **`COALESCE(..., false)` around every authorisation condition.** `pos_role` is NULL for any
  account with no POS access, `NULL IN ('supervisor','manager')` is NULL, and `IF NOT NULL THEN`
  never fires — so the unwrapped form falls open for precisely the accounts with no rank.

History: docs/rules-archive/pos-billing.md#comp-guard-holes

## A guard on how a bill closes is not a guard on a closed bill (S754)

`pos_orders_client`, `pos_order_items` and `pos_order_payments` are plain same-client policies, so
the close guards (S577–S579) left a printed, numbered Tax Invoice open to any till login over REST.
A guard that checks the transition protects the transition, and a closed row is a different
state.
History: docs/rules-archive/pos-billing.md#closed-bill-open-story

Migration `20260916100000` locks it, and a new money guard must fit
the same four rules:

- **An allow-list of what may still change on a closed row**, not a deny-list of what may not.
  `guard_pos_order_close()` compares `to_jsonb(NEW) - allowed` with `to_jsonb(OLD) - allowed`.
  Eight columns are allowed: `ims_posted_at`, `print_count`, `comp_print_count`,
  `credit_note_id`, and the four credit-settlement columns. `credit_note_id` and the settlement
  columns are ranked and set-once. Since S809 1c the two print counters only go up (a lower value
  is ignored, not refused, so a till a reprint behind is not told its print failed; a CHECK keeps
  them ≥ 0), and `ims_posted_at` is set only on a closed bill, at POS Supervisor or above, and then
  stands. The next column added to `pos_orders` is locked by default (invariant #1's reason).
  `vat_registered` (S809 2c) is not on the list and is not refused either: the guard keeps OLD's value.
- **The child tables need their own lock.** Locking `pos_orders` did nothing for its lines and
  payments. Statement-level AFTER triggers (`guard_pos_order_items_closed`,
  `guard_pos_order_payments_closed`) look the order up once per statement, not once per row, on the
  busiest tables in POS.
- **Enumerate every writer before writing the lock, and admit each one narrowly.** The migration's
  header lists every `.update`/`.insert` on those tables in `src/` and every SQL body that touches
  them. Two writers needed an exception:
  - **Split legs are inserted just after the close**, so the one leg insert admitted on a closed
    bill is a Split leg, by `closed_by`, within 10 minutes of the server-stamped `closed_at`, never
    a Loyalty leg, and never past `paid_amount`. `paid_amount` is compared, not re-derived, so there
    is no second copy of the VAT arithmetic.
  - **The operator's restore** inserts closed orders, their lines and legs, and links credit notes
    as `authenticated` with role admin. Those exact writes are let through, and nothing else past
    the lock.
- **A DEFINER function bypasses the row guards, so it re-checks what it bypasses** (the S753 rule).
  `apply_pos_item_comps` and `redeem_loyalty_points` refuse a closed order in their own bodies.

**Attribution moved to the server at the same time.** The close stamps `closed_by := auth.uid()`
and `closed_at := now()`, because a tablet's clock could backdate a bill into a closed month.
`credit_settled_by`, `credit_settled_at` (S823) and `pos_credit_notes.issued_by` are stamped the same way. A foreign-key
cascade runs as the table owner and passes the `current_user` seam, which was measured live: deleting a profile or
shift that a billed order names is Postgres's write, not the browser's, and is not refused.
**That was measured on a BEFORE row trigger (`guard_pos_order_close`); an AFTER STATEMENT trigger on
the child does not see it (measured S755).** It fires once the outer statement ends, as the caller, and
finds the parent gone; the two child guards ask `pos_orders_still_exist(uuid[])` (DEFINER, S822), so a
gone parent passes and an unseen one is refused. A guard that must tell who asked through a cascade
keys on `auth.jwt() ->> 'role'`, not `current_user`.

## A rank the screen requires must be enforced by the table (S754)

**A button that does not render is a statement about the page, not about the data.**
`pos_caller_has_rank(level)` in
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
History: docs/rules-archive/pos-billing.md#rank-guard-origin

| What | Rank the table now requires |
| --- | --- |
| Close a bill (Pay, Void, Complimentary, Credit) | Supervisor |
| Receive or cancel a customer payment (S843) | Supervisor, through the two receipt functions only; a cancel needs a reason; `credit_settled_*` stamped when receipts reach the total |
| Open or close a shift | Supervisor. A **closed shift is immutable**, and a client cannot DELETE one |
| Cash In / Cash Out | Supervisor, against an OPEN shift. **Never edited or deleted**: a mistake is a second movement |
| Cash refund on a credit note (`kind = 'refund'`) | Manager. One per note, written by the note's own trigger: the cash the bill took (`pos_bill_cash_taken`), no more than the note's net (S809 2e) |
| Issue or link a Credit Note | Manager. Never edited or deleted |
| Menu price, VAT rate, `pos_enabled` (`guard_recipe_menu_price`) | POS manager, IMS manager or Owner |
| Till setup `settings` columns (discount reasons, note presets, ticket routing, delivery partners, reservation settings, opening hours, loyalty point value) | POS manager |
| Invoice prefix, VAT number and flag, property address and phone, payment QR | Owner (admin exempt) |
| `pos_tables` but `status` (and `inactive`, S817) | POS manager. **No delete, retire or rename under an open bill**, for everyone; no delete with bills on record, no new order when inactive (S835); names unique in service |
| Loyalty schemes and enrolment (deleting an enrolled customer too) | POS manager |
| Membership types, a customer's card and credit limit (S843) | POS manager; birthdays, anniversaries and consent: Supervisor (`pos_customers_guard_loyalty`) |
| Add or take off loyalty points by hand (`adjust_loyalty_points`, S809 3k) | POS manager; reason required, never below 0 |
| Block / Unblock / Delete a till login (admin-user-ops, S809 3i) | POS manager, as a PIN reset (never a peer manager, own login, or a stronger login). Delete only a login with no rows in `pos_login_recorded_rows` |
| Parking slips (`pos_parking_slips_guard`, S809 1k) | Issue: Supervisor. Reprint, Mark Exited, the day's auto-close: any POS rank. Number (UNIQUE per outlet), issuer, Time In, the linked bill's number, close time and closer are the server's. Never edited; a closed slip stays closed; auto-close only before today's 6 AM Nepal |
| Cancel a kitchen ticket | Supervisor, or its order voided, or any POS login once every dish on it was taken off the order (Clear, S809 3d); final. A void cancels its live ones (S817) |

Three shapes are worth copying:

- **A supervisor's new dish is not refused, it is taken off the till.** Recipe Costing is a
  supervisor screen and always sends `selling_price`. Refusing its insert would break "+ New
  Recipe", so the row lands with `pos_enabled := false` until a manager puts it on from Menu
  Pricing. An UPDATE that re-sends the stored price passes; `vat_rate` NULL and 0.13 count as the
  same price.
- **Only a `status` change is cheap.** The till flips `pos_tables.status` on every seat and bill,
  so the guard returns after ONE `is_admin()` call (its first line, SECURITY DEFINER, so not
  inlined) when `to_jsonb(NEW) - 'status'` equals `OLD` and neither side is `inactive`; the rank
  lookup is skipped. A new guard on a hot table that wants a truly free path puts its cheap test
  above `is_admin()`, not after it.
- **The invoice columns are resolved at PRINT time** (`settings-row.md`), so a waiter changing the
  payment QR would redirect every guest's payment into their own wallet, and a prefix change
  renumbered bills already issued (until S834, `invoiceCodeOf`). Those are the Owner's, not a POS manager's.

**The frontend does not decide these ranks; it mirrors them.** `MenuPricing.js`' `canSetMenuPrice`
tests the RAW `pos_role`/`ims_role` columns because `caller_can_set_menu_price()` does. Using
`hasPosAccess` there would also have required the module to be on, which the database does not.

## A till takes a release by itself, and the database can refuse one too old (S809 1b)

History: docs/rules-archive/pos-billing.md#till-release-history

- **`useReleaseReload(safe, idleMs, beforeReload)`** (`src/shared/releaseWatch.js`) is on the PIN
  screen, the order screen and the KDS. They ask the browser to re-check the worker on arrival and
  every 10 minutes; `controllerchange` after a first install means a release, and the screen reloads
  at its next safe moment (quiet for `idleMs`, no `[role="dialog"]`, its own `safe` true, online). A
  new till screen that sits for hours calls it too.
- **Every `/rest/v1/` call carries `x-crest-build: <APP_VERSION>`** (`buildHeaderFetch.js`, inside
  `supabaseClient.js`'s fetch). Never on auth, storage or Edge Function calls: an Edge Function's
  CORS list refuses a preflight for a header it does not name.
- **`pos_till_build_gate`** (BEFORE STATEMENT on `pos_orders` insert/update and `pos_order_items`
  insert/update/delete, `20261009100000`) refuses a signed-in browser's write from a page older than
  `pos_min_till_build()`, with `pos_till_build_too_old`. NULL is no floor. Anon, the service role and
  no-JWT calls pass. The till that hears it keeps its cart (`reason: 'update'`) and reloads within
  seconds, at most once per 3 minutes.
- **Raising the floor is a migration that replaces `pos_min_till_build()`, and it goes live only
  AFTER that release is deployed.** Raised first, every till is refused with nothing newer to load.
  Raise it only for a release that changes what a till must send; a slice that only refuses REST
  abuse leaves it alone. A new table a till writes under a changed contract can attach the same gate.

## Still open

**A QR payment confirmation is the provider's (S809 1k, `pos_payment_confirmations_guard`).** Only
`pos-payment-webhook` (service role) creates one. A browser session may only set `consumed_at`, once,
after the matched bill is `billed`, and the server stamps the time; every other column, insert and
delete is refused, the operator included. Keep it that way when the feature goes live: the poll
trusts `matched_order_id`, `provider` and `amount`. A deleted bill leaves it unmatched (SET NULL, S835).

Open POS work is tracked in `POS_TODO.md` A2; payment-QR auto-confirm is still blocked on FonePay/eSewa merchant onboarding. The phase-6 critique record (what S575–S767 closed) moved word for word to `docs/rules-archive/pos-billing.md`.

## One bill-math primitive, however the report slices it (S580)

`computeCategoryAmounts` and `computeItemAmounts` in `posBillingMath.js` are delegates of
`computeGroupAmounts(order, items, vatReg, keyOf, seedOf)`. **A new way to slice a bill is a new
`keyOf`, never a new copy of the arithmetic**: this is money math on the bill, and the rule that
keeps COGS in one place (`imsFormulas.js`, S551) applies here for the same reason. The
reconciliation tests assert that buckets sum back to `computeOrderAmounts`, for any key.
History: docs/rules-archive/pos-billing.md#bill-math-history

One level up, `SalesReport.jsx`'s `buildGroupedRows(keyOf, labelOf)` is the same consolidation for
the row builders. Each bill goes through it under its own stamped status (`billVatRegistered`, S809
2c), never one report-wide flag.

**The credit-note branch (S754, owner decision)**, so a day ties to the Z-report and the bill book
and the reversal shows, on every tab including 1L+:

- **the bill stays at full value on its own day;**
- **the note is a MINUS row on the day it was ISSUED**, at the note's own stored figures (the
  printed document's).

The row arithmetic lives in `src/modules/pos/reports/salesReportMath.js` (`billAmounts`,
`creditNoteAmounts`), with tests, and still goes through `computeOrderAmounts`/`computeGroupAmounts`.
The rule is still one rule in one file: three hand-written copies of it is how the tabs would come
to disagree about a return. **Covers Report follows it too.** Credit-noted bills are kept (a credit
note corrects billing, it does not un-seat guests), and dine-in returns net off revenue on the day
they were issued.

**A SPLIT bill is spread across the methods it was paid with** (S754, owner decision), in
proportion to its `pos_order_payments` legs, so Payment Summary's Cash ties to the Z-report, which
counts each leg under its own method. A split bill with no legs recorded shows as
`SPLIT_NO_BREAKDOWN`, never silently as Cash.

**Covers Report is dine-in only** (S754, owner decision). Every cover figure filters through
`coversMath.isDineIn`, and takeaway and delivery get their own line. A takeaway bill's "dwell" is
how long the bag took, not how long a table was held.

**Sales Exceptions values all three kinds before VAT** (S754, owner decision). Voids are at forgone
menu price ex-VAT, comp potential sales value is ex-VAT, and discounts were already pre-VAT. VAT on
a sale that never happened was never revenue, and counting it made a void look ~13% larger than a
discount of the same food. **1L+ merges a name-only party into the same-name PAN party**
(`mergeNameOnlyParties`, which refuses the one ambiguous case), and the walk-in aggregate row
carries no Annexure 13 flag. 1L+ lists years from the first bill's (`fiscalYearsSince`), read when
the tab opens, with its own error slot; a year reads up to 2,00,000 bills (S809 3m).

**The Product Type tab's axes:**
`settings.pos_bot_categories` (Kitchen/Bar — the same set `sendTicket()` routes BOT by, read through
`barCategoriesOf` (NULL = ['Beverage'], empty = no bar and no BOT button, S809 3m), so the report and
the tickets cannot disagree), `pos_order_items.vat_rate` (as billed), and `recipes.is_veg`. An axis
that could only ever produce one row is **hidden, not rendered empty**. When verifying that, note a
hidden axis and a broken lookup look identical on screen — confirm the fetch returned 200 before
concluding the client simply has no data.

## A delivery platform is a party, not a tag on a bill (S596)

Sales Report → Delivery Partners and Customers → Credit each carry a per-partner view,
so a screen can say what one platform owed and what it took. Four rules:

**Commission is measured against the ex-VAT, post-discount base with comped lines excluded — never
`paid_amount`.** That is the base Receive payment pre-fills commission on (`creditLedger.js`), because it is the base Foodmandu
and Pathao themselves invoice on (confirmed with the client at S290). An effective rate computed off the VAT-inclusive total reads
about 13 percentage points low on **every** bill of a VAT-registered client, so a report built that
way would accuse every platform of over-charging, every month, in the alarming direction. Recompute
through `computeOrderAmounts` rather than storing a second copy of the base.

**An unsettled bill is excluded from BOTH sides of the rate.** Commission is recorded at settlement,
never at Charge — deliberately, so staff never see or estimate a platform's cut while billing. An
outstanding bill therefore has a base and no commission, and letting it into the denominator drags
every partner's measured rate toward zero as the month fills up. The absence of a number here is
structural, not missing data; the same distinction the Outstanding column already makes.

**A rate-mismatch flag needs two tolerances or it cries wolf.** Each bill's commission is
`round(base × pct / 100)` at settlement, so a platform charging exactly the agreed rate still
lands up to NPR 0.5 off per bill — a visible percentage swing across a handful of small delivery
orders. The flag requires a gap of ≥0.5 percentage points **and** a rupee gap larger than
rounding could produce (`max(1, settledBills × 0.5)` in aggregate, NPR 1 on a single bill). A
report that raises a false alarm about a supplier relationship is worse than one that stays quiet.

**A rollup must reconcile with the total printed beside it.** Customers → Credit lists every party
(each customer and each platform, S843), so its rows sum to the owed figure above them. Its figures
legitimately differ from the report's — that page is every Credit bill ever, the report is a date
range — which is stated in a line under the table, because two screens showing the same words and
different numbers is a support call.

Effective rate = settled commission ÷ ex-VAT settled base. The contracted rate it is checked
against is `settings.pos_delivery_partners[].commission_pct`, also the settle-time pre-fill.
History: docs/rules-archive/pos-billing.md#delivery-partner-rollup-story


### The HSC code prints under the dish name (S856, owner decision)

The bill and the credit note share one item table (`BILL_TABLE_CSS`, `BILL_TABLE_HEAD`, `billItemRowsHtml`):
S.N., Particulars, Qty, Rate, Amount. In its own 24px column a code like 2202.99 broke over three lines
and ran into the S.N. The payment window's preview carries the order's covers, as the paper does.

### A printed slip is stamped with the BILL's moment, not the print's (S670)

`buildBillHtml` and `buildCompSlipHtml` take Date, Miti and time from `order.closed_at`, never
`new Date()`, which put **today** on every reprint and Bill Register preview (`viewPosBill()`).
History: docs/rules-archive/pos-billing.md#slip-date-story

**The `|| new Date()` fallback is load-bearing, not padding.** The live close path builds its order
object in memory and the in-modal preview renders *before* the order is closed, so `closed_at`
genuinely does not exist yet on either. Remove the fallback and a statutory document prints
`Invalid Date` in front of a customer — a failure only reachable by clicking Charge, never by
reading the diff.

Times on every POS slip and screen go through `src/shared/nepalTime.js`; see
`.claude/rules/design-system.md` for why the obvious `toLocaleTimeString` form is wrong.

### A reprint is a copy of the original, or nothing (S809 4b, 4c)

- **Round Off prints on every bill and every credit note**, PAN included, 0.00 when nothing rounded
  (owner decision). The note's comes from its own stored figures as printed (`creditNoteRoundOff`),
  and it lists a dish's choices with the bill's own `billOptionRow`. A Credit bill prints "Amount on
  credit", not Tender/Change.
- **A reprint takes its HSC codes and Cashier / Authorized by from the bill** (`billReprintData.js`:
  `readHscMap`, `staffNameFor`), never from the `hscMap` state or the reprinter's login. Either read
  failing prints nothing; a document with blank codes or the wrong name is wrong, not partial.
- **A credit note's copy count is the server's (S828 5d), as a parking token's.** The print sends
  `print_count: -1`, `guard_pos_credit_note` writes OLD + 1 for any differing value, and the label is
  the count returned; `nextCreditNoteCopy` labels only a print whose count write failed.
- **A parking token's count is the server's (S814).** The window opens on the tap; a blocked one counts
  nothing. The print sends `print_count: -1` (the guard writes `OLD + 1` for any differing value) and
  labels from the count returned. Never send the page's own: a stale page sending the stored value
  changes nothing.

### The four POS report pages are reports, not till screens (S613)

`SalesReport`, `CoversReport`, `KotLog` and `PosExceptionReport` now render the product's shell
grammar — `page-header`/`page-title`/`page-subtitle`, `stat-grid`/`stat-card` KPI tiles,
`tab-bar` tabs, and keyboard-reachable drill-downs — because they are read at a desk by the same
owner or accountant who reads every other report in the product. `PosOrders` and `KitchenDisplay`
keep the full-screen till idiom deliberately; see `.claude/rules/design-system.md` for the boundary
("a new POS page is a report unless it is operated during service").

Two POS-specific details from that convergence:

- **A `<tr onClick>` is mouse-only.** An inline detail expansion takes `RowDisclosure` in the first
  cell; an opening drill-down takes `.btn-linklike` on the cell carrying the row's identity (invoice
  no., order no., payment method), `stopPropagation()`ing, with `aria-pressed` where the row toggles
  a filter. Never a trailing action column.
  History: docs/rules-archive/pos-billing.md#report-rows-correction
- **KOT vs BOT is a category, not a status.** The KOT chip used `badge-green`; success-green for a
  categorical distinction is the one thing the badge set is not for. KOT is `badge-purple`, BOT
  `badge-gray` since S846 (it was the accent tint).

## A dropped write error in this file is how a dish gets cooked twice (S654)

The general rule is in root CLAUDE.md; what follows is what it costs in this file.
History: docs/rules-archive/pos-billing.md#dropped-write-errors-count, #send-flag-and-replay-stories

- **Printing a ticket is gated on the `sent_to_kot` write, never the other way round.** That flag is
  what makes "already sent" true for every other device and for this one after a reload; a ticket
  printed without it gets the same dish cooked again on the next press. Both send paths print only
  if the flag landed; the order stays saved and only the send is unwound. **Do not reorder these.**
- **The offline-replay status check is a guard, so it fails CLOSED.** It reads `pos_orders.status`
  to avoid overwriting an order another device billed while this one was offline; a read error
  throws to stay queued, with `PGRST116` (row gone) routed to the existing conflict list rather
  than retrying against a dead id forever.
- **A failed poll must not write its empty result.** `loadKotStatus` (a blank kitchen badge reads
  "nothing has been started"), `loadOrderKotTickets`, `loadPendingGuestOrders` (and its
  `seenGuestRequestIds`, or the next good poll re-chimes) and `loadOpenShift` (a null unlinks every
  later bill from the open shift and leaves the Z-report short) all keep last-good.
- **After the bill is committed, warn — do not block, and do not swallow.** Once `pos_orders` is
  updated the invoice number is minted and the close cannot be refused, so `warnWrite()` + the floor
  banner carries what failed afterwards: the split-tender breakdown (the Z-report reconciles against
  a payment mix missing that bill's legs), the table-occupied write (a table shown free with a live
  order gets seated twice), missing HSC codes, reprint counters. **Each
  sentence names the downstream consequence and the recovery, never the error.**
- **`ims_posted_at` is the database's (S809 2f).** A bill whose rows landed is marked in the same
  transaction, so the till's own mark write failing is logged, not shown (a voided bill's too: no
  screen counts it). A post that lands after its wait marks the bill then; a second post is refused.
- **Not everything was made loud, deliberately.** A till that throws red at a cashier holding up a
  queue is worse than a stale reprint counter. The QR-confirmation poll, the `order_no` backfill,
  the co-occurrence suggestions and the Recent Bills comp lookup log and move on. The test is
  whether there is an action the user could take.

## A close whose answer is lost is read back, never retried blind (S776)

- **Every await on the close path is bounded** (`bounded()` / `CLOSE_STEP_MS` in `PosOrders.jsx`). Cancel stays disabled while a close is in flight, so an unbounded await was a till with no way out.
- **A timeout, a dropped connection or a gateway 5xx on the close write is not a failure** (`noAnswer`, S833 for the 5xx). `closeAttemptRef` is set just before the write; `settleUnknownClose()` reads the bill: closed by this login with this close type → `finishClosedBill()` (legs, print, the rest); open straight after the timeout → keep the mark, the write can still land; unreadable → say it is unknown. The next press AND Cancel settle it first.
- **An unknown close stays unknown until it can't land (S809 2d, CHECKOUT-7).** Marks are per order (`closeAttemptFor`; kept on the tablet since S833, `closeAttemptStore.js`, another login's locking the bill until read; since 2g the lock hands back points only when no try at that bill is unsettled, never on an outlet move, and the close returns forgotten points itself). `trackCloseWrite` + `.abortSignal()` make "open" final only `CLOSE_LAND_GRACE_MS` (30 s, over the live 8 s statement and lock timeouts) after the last unanswered write; raise the grace if those timeouts rise. While a mark names the bill the payment controls lock (`closeLocked`, fieldset `.pay-lock`), Cancel discards nothing and hands back no points, and `pollUnsettledCloses` reads it every 15 s. A settled close finishes from the STORED bill (`readStoredBill` → `finishClosedBill({ stored, attempt, background })`): stored lines print and post, legs only from that try's own tenders and only if none landed. In the background: no print (but a void's VOID slip, S835), no Inventory (backfill), legs and points still run. A comp, redeem or buyer step refused `bill_locked`/`order_not_open` after an unanswered press goes through `settleIfEarlierClosed`.
- **Order after the close is an owner decision: Split legs → print → table, booking, IMS, customer, loyalty.** Legs first because of their 10-minute window and because `printBill` reads them. Print counters are not awaited. Don't move bookkeeping back in front of the paper.
- **The close buttons are never `disabled` for a missing input, only `aria-disabled`.** `closeBlocker()` is the one list: closeOrder refuses with its `text`, the button shows its `label`, and `pressClose()` opens the folded section and focuses its `field`. A new close precondition goes into `closeBlocker`, never into a button's `disabled` expression. Void asks first (`confirmVoid`). `closeStartRefusal` (`tillBillChecks.js`) runs first: unread till settings, then an emptied cart (Void exempt, owner Q8 a); `fullInvoiceRefusal` follows the buyer-ID check (a VAT bill above `ABBREVIATED_INVOICE_LIMIT`, measured on what the guest pays, needs name and address, Q9 a).
- **The till's settings come from a read that answered, or billing waits (S809 2a).** `loadTillSettings` bounds the `settings` and `clients` reads, applies and caches only an answer, keeps the offline copy for routing on a failure, and never caches a failure. `billingSettingsLoaded` gates `payBlocker`, `closeBlocker`, `billOrder` and `reprintBill`; a cached copy never opens Payment. Never fall back to defaults in silence: `is_vat_registered ?? true` made every PAN outlet a VAT one on a dropped read.
- **ONE Send, no KOT/BOT button (S854, owner)**; "Save, do not send yet" (`holdOrder`) is the only hold.
  "Send and go back" leaves only on an `ok:` answer. Alt+S / Alt+P by `e.code`, never over a dialog.
- **The order screen has a phone layout and a touch floor.** Below 700px (`narrowTill`) the menu takes the width and the cart is a bottom sheet (`cartOpen`); keep TOTAL and the action buttons outside the folded part. A new control on the order screen takes `.till-hit` (square) or `.till-hit--row` (Layout.css, `pointer: coarse` only) and never an inline `minWidth`/`minHeight`, which would beat the class. The message line (`msg`) renders above Send, not in the top bar.
- **Till text is `errorText(err, 'staff')`, never `err.message`** — the till notices, load-error lines and loyalty lookup included (S776). Three sites keep the server's own sentence on purpose because a guard phrased it for the till: `stripCodeWord` on the close refusal and the off-menu save, and the loyalty award's rank/window refusal. A selected payment method is the accent FILL with `aria-pressed`; hover is only a tint. The order screen's inline controls get the focus pair through `.till-hit`/`.till-hit--row`/`.till-tile`. POS report tab rows are `Tabs`; the Exceptions type row and the KDS station chips are `FilterChips`.
- **Floor and order-screen conventions (S776 polish).** The floor's Inventory-posting banner (`PosImsPostingBanner`, S809 3j) renders only for `canSeeImsPosting` (admin, Owner, POS manager; outlet has Crest IMS, S814); its misses are pruned by every count that answers (`pruneImsMisses`). A new floor notice goes inside `#pos-floor-notices` and adds itself to the summary line, which folds the notices once two or more show (S853); the offline banner, guest orders and `floorMsg` (the answer to the last tap) stay outside the fold. Every open-bill running total (tile, Billing list, POS Dashboard) is `openBillTotal(items, vatReg)` in `posDashboardMath.js`: `computeOrderAmounts` net, no discount, a comped row counted (S854: it is a cancelled close's leftover, which the order screen folds back and charges). An inactive table is muted by a dashed edge, never opacity. 10px is the floor for text on the till. Prices on the till go through `fmtNpr`. Void is `btn btn-danger btn-danger--strong` and Complimentary `btn amber-action-btn` — tints, not solid fills. Payment is the outlined `btn-ghost` beside Send's fill. The covers numpad and "Cash received" (Enter confirms) take the keyboard. `.table-wrap` is `position: relative` app-wide so an `.sr-only` child cannot widen the page.
- **Reports, shifts and staff (S776 polish).** A POS report's date range takes `RangePresets` (BS months, shared with the Customization report) beside its pickers. A drawer variance is `varianceSignal()` in `PosShifts.jsx` everywhere it shows — ✓ balanced green, ▲ short red, △ over amber; never a size threshold that turns a shortfall green. A new POS login is created with `pos_discount_limit: 0` from POS Staff (owner decision); `admin-user-ops` still defaults an unspecified limit to NULL for admin/Owner callers, so an API caller must send it. Printed slip dates go through `nepalDateAd`/`nepalBsLong`. KDS Start is one tap at `DEFAULT_START_MINUTES` (10, owner decision S846); "Other time" opens the presets and keypad; a second one-tap move (Start, Ready, Served, Seen, Clear) within `MOVE_SETTLE_MS` on ANY card is ignored, because the next ticket slides up under the finger (S853); the popup's `confirmStart` and the automatic serve are not held.
- **The payment window's order (S846).** Amount → method → cash received or QR → Confirm, then the `adjustOpen` fold (member card, buyer, discount, points, comps, share slips), then "Other ways to close" (Void, Complimentary; `billingTab` still switches the body). The fold's folded line (`applied`) names every adjustment on the bill, so a new adjustment adds itself there. Buyer details a bill REQUIRES render outside the fold, open. A `closeBlocker` field inside the fold is opened by `pressClose`. A floor or takeaway tile is ONE `button.floor-tile__open` stretched over the card with plain-text chips; never a Tip or a control inside a tile.

History: docs/rules-archive/pos-billing.md#close-read-back-evidence

## A send whose answer is lost is read back too (S809 3e)

- **Every send step is bounded** (`SEND_STEP_MS` for the order insert and line save, `SEND_READ_MS` for read-backs and small writes, `sendAttempt.js`); the saving flags clear in a `finally`, and the line save is cancelled with `.abortSignal()`.
- **Each online save leaves a mark until its answer is known** (`newSendAttempt`, per order in `sendAttemptRef`, memory only); `noAnswer` (timeout, dropped connection, 5xx) keeps it. A landed mark prints and logs from its own record (`finishLandedSend`), settled after the press, on reopening and by a 15 s poll.
- **A save landed only if its id is on the order (S840)**: `p_save_id` → `pos_orders.recent_saves` (last 50 `{id, v}`); a listed retry answers `duplicate`. `judgeSendAttempts` judges by id, by content only without the column.
- **A late answer never writes onto another order's screen** (`watchScreen`; `backToFloor` moves the screen token): its message goes to the floor with the order's name, and `performSave` reads `itemsVersionRef` once.
- **A send with no answer is kept and prints (S809 3f, Q16).** Only the three send paths pass `performSave({ queue: true })`; a close never queues. A no-answer drops the order's marks, queues the save, marks the link down for `LINK_DOWN_MS` (`tillOffline()`; a read every `LINK_PROBE_MS` ends it sooner, S833) and returns `keptOnTill`; `unknown` is left for an IndexedDB failure or a floor conflict on that order. A held order opens from its queued copy (`screenQueueRef`), saves through the queue, and is never billed until uploaded. Upload rules: `offline-and-cache.md`.
- **Opening a table and reading the menu wait `OPEN_READ_MS` (10 s, owner decision, S841)**; no answer (`noReply`) opens the table from this till's copy and the menu from the saved copy, re-read online on the next order screen (`menuFromSavedRef`). The menu tests `tillOffline()`, never `navigator.onLine`. **One open at a time** (`openOnce`, every tap entry point): a second tap is ignored and the tile says Opening….
- **The menu stays loaded between tables (S847, owner)**: `menuReadMode` decides; never reset `menuLoaded` on leaving.
- **The shell is `inert` behind the order screen** (`tillLayerUp`, `Layout.js`, S841). Focus goes to ← Table on entry (not the search: it raises a tablet's keyboard) and back to the tile or Bill button (`data-table-tile`/`data-takeaway-tile`/`data-bill-for`) when lost.
- **The cover count is written after the line save and only when changed on this tablet** (ORDER-FLOW-14). A saved take-off re-added prints +1 (`sentQtyAfterQtyChange`, ORDER-FLOW-13).

## Customer credit is paid by receipts (S843)

- **A payment is a numbered money receipt** (`pos_credit_receipts`, own series per outlet and year,
  no VAT), split over bills by `pos_credit_receipt_lines` (amount, and a partner's commission kept).
  Only `record_credit_receipt` / `cancel_credit_receipt` (DEFINER, Supervisor+, one transaction,
  bills locked in id order) write either; the guards refuse every client write but the reprint count
  and the operator's restore. Owner decisions: oldest bills first, the cashier may tick others; never
  more than is owed (no advances); a Supervisor or Manager cancels with a reason, never a delete.
- **Owed has one definition**: `pos_credit_open_bills` (paid_amount − Σ active lines' amount +
  commission); `pos_credit_party_events` is the statement, and its balance equals Σ owed.
  `creditOwed.js` is the browser twin for range reports. Pass `p_client_id`: the operator's view-as
  is a browser setting. A bill is stamped `credit_settled_*` only when its receipts reach its total
  ('Mixed' for several methods), so every older reader still means "paid in full"; a cancel
  un-stamps it.
- **A party is a key** (`pos_credit_party_key` / `creditPartyKey`, twins): partner name, else the
  canonical phone (7+ digits), else the name. It is DEFINER (`20261015140000`) because
  `pos_phone_canonical` has no client grant.
- **Cash** needs an open shift: one `credit_settlement` Cash In per receipt (no `order_id`), and a
  cancel's `credit_receipt_cancel` Cash Out; Expected Cash counts both by direction, unchanged.
  `pos_bill_cash_taken` counts a bill's Cash lines, so a credit note refunds the cash really taken.
- **The old whole-bill settle survives only for a bill with no receipts** (an older bundle):
  `guard_pos_order_close` and `pos_cash_movements_guard` refuse it otherwise (`credit_use_receipts`).
- A press with no answer is resent with the same `p_request_id` (the server returns the first
  receipt); until the page knows, it blocks another payment from that party (`settleCredit.js`).
History: docs/rules-archive/pos-billing.md#credit-settle-read-back

## The floor's refusals are a till notice, never `window.alert` (owner decision, S844)

The refusals a waiter must not walk past mid-service (could not check a table for an open order,
could not load a takeaway or a bill to reprint, a blocked print window, the clear-all failures) go
through `showTillNotice(text)` (`TillNotice.jsx`): a red bar fixed at the top, `role="alert"`,
portalled to `<body>` at z-index 2200 (above every `Modal`, below the Calculator and ArrivalAlert),
in all three returns (`tillNoticeEl`), until ✕; a newer one replaces the older. Same words as the old
pop-up. Un-missable is still the property (S616); `window.alert` went because it froze the page, the
guest-order chime and every poll until OK. `TillNotice.test.jsx` fails on any `window.alert` in
`PosOrders.jsx`/`BillingStation.jsx`. A message a waiter may glance past still goes in `floorMsg`.

## Anything that takes money off a bill is a TENDER or a DISCOUNT, and the choice is not cosmetic (S618)

Loyalty redemption was the first thing to face this and it will not be the last — a gift card, a
voucher, a staff allowance and a deposit are all the same question. Two things already in the
codebase decide it, and both push the same way:

- **`computeOrderAmounts` applies `discount_amount` to the PRE-VAT base** and recalculates VAT on
  the discounted amount. So anything booked as a discount reduces the taxable value and the VAT
  remitted. That is correct for a genuine price reduction and wrong for an instrument that settles
  a bill at full price.
- **`guard_pos_order_close()` (S577) enforces `pos_discount_limit` server-side** against
  `SUM(qty * unit_price)`. A redemption booked as a discount is therefore capped by the cashier's
  discount permission — a 10%-capped waiter applying a 20% redemption gets a legitimate bill
  REJECTED mid-service. This is the failure that decides it: the trigger cannot tell a reward from
  a giveaway, and teaching it to would mean a second exemption rule inside a money guard.

A tender touches none of `close_type`/`status`/`discount_amount`, so that trigger never fires, VAT
is charged on the full bill, and **IMS revenue needs no change at all** — the post (the server's since S830) takes
`unit_price`, which a tender does not touch. `expectedCashOf` is likewise safe for free, because
`cashSales` is `byMethod.Cash`.

**Adding a tender means four lists, not one, and three of them are easy to miss:**

1. The `payment_method` CHECKs on **both** `pos_order_payments` and `pos_orders` (drop + recreate;
   the current lists are `20260827160000`'s plus `Deposit` from `20261021110000`, not the baseline,
   which still shows the reverted Foodmandu/Pathao experiment).
2. `PAY_METHODS` (`PosShifts.jsx`), `PAY_METHOD_ORDER` (`SalesReport.jsx`) and `METHOD_GROUP` /
   `GROUP_ORDER` (`posDashboardMath.js`, which falls back to "Other") — the **display**
   lists. Both accumulate with `if (byMethod[m] !== undefined)`, so a method they do not already
   know is **silently dropped**: the Z-report breakdown comes up short of the day's takings with
   nothing on screen saying why, and a manager counts the drawer chasing a shortfall that is only
   a display bug.
3. **NOT `PAYMENT_METHODS`** in `posOrdersConstants.js`. That is the list a cashier PICKS from, and
   a redemption is not picked — it is applied when the customer has a balance.

**Loyalty is earned and spent only at the close, by the closer (S754, `20260916100000`).**
- **`pos_loyalty_ledger` takes no client write, except an admin-only INSERT the browser restore needs**
  (it inserts as `authenticated`). Verify such a table with one row from two identities (Owner
  42501, admin 201), never `has_table_privilege`.
  History: docs/rules-archive/pos-billing.md#loyalty-ledger-restore
- **`redeem_loyalty_points`** needs supervisor rank and an OPEN order.
- **A Loyalty line belongs only on a Split charge (S809 2g, `20261009230000`).** `guard_pos_order_close`
  hands back a standing redemption on any other close via `redeem_loyalty_points(id, 0)`, in the
  close's transaction, so points from a try that never finished return by themselves. The till hands
  back first before a Split charge without points. Never make the till the only path that returns them.
- **A delivery partner neither earns nor spends (S809 2g).** award returns 0 and redeem refuses
  (`pos_points_delivery_partner`) for a partner-tagged bill or a partner's phone in any format:
  `pos_phone_is_delivery_partner` (SQL) and `isDeliveryPartnerPhone` (JS) are twins; change both.
- **`settings_pos_loyalty_point_value_positive`**: a point is worth more than 0; NULL reads as 1
  everywhere. The till never guesses an unread value and stops when the redeemed amount differs from
  its screen (`redeemedAmountDiffers`).
- **`award_loyalty_points`** is callable by the order's `closed_by` within the window after the
  server-stamped `closed_at`, and at any time by `pos_caller_has_rank('manager')` (S815 4g, the one-tap
  "add the points this bill earned" in the customer's History, `PointsHistoryModal`). A late award for a
  bill closed before `pos_customers.loyalty_enrolled_at` is refused (`pos_points_before_enrolment`, D13);
  at the close it is an ordinary 0. The row is an ordinary `earn`, so a Credit Note takes it back.
- **A Credit bill's points are held until it is settled (S815 4g, Q19 c, `20261012100000`).**
  `pos_loyalty_balances(client, customer?)` (INVOKER) is the one place `balance` and `held` are worked
  out; redeem spends only `balance − held` (`pos_points_held`), and the till and Loyalty read it (paged:
  a set-returning RPC stops at 1,000 rows). Never sum the raw ledger for a spendable figure.
- **`loyalty_enrolled_at` is stamped by the server (S815 4g)**: join `now()`, scheme change kept, leave
  cleared, a client's value ignored, a restore INSERT keeps its own. A write that enrols reads it back.
- **`move_loyalty_points` (S815 4g, D11–D14)**: manager; moves `balance − held` as two no-bill `adjust`
  rows; adds/enrols the new number, unenrols the old; `pointsMove` is its JS twin.
- **`adjust_loyalty_points(customer, points, reason)` (S809 3k, `20261010110000`, Q13 b):** Owner, POS
  manager or operator; reason required; never below 0; never adds to a partner's number; `order_id`
  NULL, because redeem hands back and a credit note reverses every adjust row on a bill;
  `created_by = auth.uid()`.
- **A customer is the number, not the spelling (S809 3k).** award and redeem find the customer by
  `phone_canonical` when the bill's phone has 7+ digits (`pos_phone_canonical()` mirrors the generated
  column; `normalizePhone`/`customerPhoneKey`/`phoneForRecord` are the JS twins: change them together),
  else by the raw text. `pos_customers_client_phone_canonical_key` (partial, 7+ digits) holds one row
  per number per outlet; `pos_customers_client_id_phone_key` stays for older tills' upserts.
- **`reverse_loyalty_for_credit_note(p_credit_note_id)`** is manager-only and runs as a credit
  note's side-effect. It takes back the points the bill earned and returns the points spent on it.
  It writes at most two `adjust` rows per customer, each carrying `pos_loyalty_ledger.credit_note_id`,
  and is idempotent twice over: the note row is locked, and a unique index allows one reversal per
  note. A balance may go negative when the earned points were already spent, because the ledger is
  signed and that is the true position.
- **`credit_note_id` on the ledger deliberately has no foreign key.** The restore inserts the
  ledger before `pos_credit_notes`, and one refused chunk would drop every customer's balance.
- **Both older RPCs resolve the outlet by `my_client_id()`**, never `profiles.client_id` (the HOME
  outlet).
- **Schemes, the point value and enrolment need a POS manager** (`20260916110000`).
- **The Loyalty line on an open bill is the RPC's (S809 1i, `20261009150000`).**
  `guard_pos_order_payments_closed` refuses every client session's UPDATE or DELETE of a payment
  line, the operator's included: `bill_locked` on a closed bill, `pos_payment_line_locked` on an open
  one. `redeem_loyalty_points` replaces and hands back its own line as the owner. The test is
  `EXISTS (old_rows)`, because a statement touching no line (an empty order's cascade) still fires.
- **A customer's identity and history are fixed (S809 1i).** `pos_customers_guard_loyalty` (BEFORE
  INSERT/UPDATE/DELETE): no client session changes `phone`/`client_id`/`id`
  (`pos_customer_phone_locked`; the RPCs find a customer by the bill's phone) or deletes a customer
  with ledger rows (`pos_customer_has_points_history`); deleting an enrolled one needs POS manager
  (`pos_customer_delete_rank`). `pos_loyalty_ledger_customer_id_fkey` is NO ACTION, not CASCADE:
  history goes only after its ledger rows (Danger Zone's order), and NO ACTION rather than RESTRICT
  so a client delete's one-statement cascade still passes. Moving points to a new number is Move
  (S815 4g, above), never two hand corrections.

- **A member card is a DISCOUNT, never a tender (S843, owner decisions)**: a real price reduction,
  so it lowers the VAT base and stays inside the cashier's cap (no exemption in the close guard). The
  till fills it (`memberDiscount.js`, reason "Membership – <type> <pct>%"), the cashier may take it
  off; an expired card or switched-off type gives nothing. Card numbers are stored upper-cased (the
  guard). Birthdays/anniversaries need consent (`consent_at`/`consent_by`, server-stamped) and stay
  out of the audit WHEN clauses (Privacy Act). Card, type and credit limit: POS manager.
History: docs/rules-archive/pos-billing.md#tender-and-loyalty-history

## One colour vocabulary, and loudness tracks demand for action (S661)

`src/modules/pos/posSignals.js` is the module's single colour vocabulary — table status, ticket
stage, close type, rank, the two strip helpers — and the header comment is the normative statement
of what each hue means here.
History: docs/rules-archive/pos-billing.md#signal-colour-origin

The general rule is in `DESIGN.md` (**Loudness tracks demand for action**) and summarised in
`.claude/rules/design-system.md`. What is specific to this module:

- **The floor strip is an ATTENTION strip, not a status strip.** `tableStripColor()` resolves
  attention before state: guest order → unfired/unsynced → food ready → live-and-in-hand → quiet.
  A waiter crossing the room can already see which tables are occupied; the strip is for what they
  cannot see. Status keeps its labelled badge, and every strip colour is doubled by a labelled chip
  on the same tile (`⚠ N` / `📵` / `🔔 Guest order` / the Ready badge).
- **The KDS strip is lateness.** `ticketStripColor()` — late / going late / ready / quiet. Stage is
  the column, its heading, and the action button; the strip must not repeat it. The column header
  dot is grey → ink → green since S846 (Started is grey `◷ Started` on a tile) and deliberately does
  **not** mirror the strip: a legend keyed to a retired encoding
  is worse than no legend.
- **`--theme-red` and `--theme-amber` collide under deuteranopia on Light (ΔE 3.1)** — the base
  tokens were never retuned, only `redText`/`amberText` were (S608). Anywhere those two fill
  something as an escalating pair, the distinction needs a shape on the text the reader acts on.
  The KDS elapsed-time line carries `△`/`▲` for exactly this.
- **Two boundaries this rule does not govern**: a *button* keeps the product-wide control
  vocabulary (so the Void button stays red and the Complimentary button stays amber, while the
  records they write read as close types in grey), and the **KOT station chip keeps S613's purple**
  — a settled decision, on a filterable column, and the two purple meanings in this module (station,
  loyalty) never share a screen. BOT went grey in S846 by owner decision, the one S613 colour the
  calm-the-red pass reopened; the vocabulary is DESIGN.md → POS followed in S846.

**The rank ladder is one value, not three files.** All three staff screens (HR, IMS, POS) read
`STAFF_LEVEL_BADGE` from `src/shared/staffLevelBadge.js`; a fourth module reads it too.

## Booking deposits (S854, `20261021110000`)

A no-VAT receipt (`DP-n`) written only by `record_/refund_/apply_booking_deposit` (DEFINER, Supervisor+).
It pays as the `Deposit` Split leg, a TENDER written at Charge time like Loyalty's (`SERVER_LEG_METHODS`
in `closeAttempt.js`; the close guard hands it back on any other close). Always refunded (owner), by its
own method; cash moves as `deposit`/`deposit_refund`, counted by direction.

## Reservations and the arrival alert

Reservations as a promise about a future table (S677), and the repeating arrival alert and the AudioContext that silenced it (S763): `.claude/rules/pos-reservations-alerts.md` (auto-loads for `reservations/`, `booking/`, `kds/`, `posChime.js`, `PosOrders.jsx` and `ArrivalAlert`).

## Server-assigned numbers, the offline queue, and `settings` RLS

Migrated from the root `CLAUDE.md` (S663).

- `pos_orders.order_no` is assigned by a **BEFORE INSERT trigger** (per-client sequential) — never set it from the frontend; read it back via `.select('id, order_no')` after insert. Same pattern for `pos_orders.invoice_no` (BEFORE UPDATE, partitioned by `client_id + invoice_fy + close_type`) and `pos_credit_notes.credit_note_no` (BEFORE INSERT, partitioned by `client_id + invoice_fy`) — never set these from the frontend either. Item-level comps (`pos_order_items.comp_no`) share the **same NC-series** as a whole-order Complimentary Slip — `apply_pos_item_comps` reserves the number under the shared advisory lock and writes every comped row in the same transaction (one number per comp event, not per line); `get_next_pos_comp_slip_no` was dropped in S809 1j, since its lock released before the number was used; `assign_pos_invoice_no()`'s `close_type='writeoff'` branch locks on and considers that same pool, so the two paths can never collide.
- The offline stock count (and POS order-taking) uses IndexedDB (`src/utils/offlineQueue.js`, DB name `crest-offline`) with 10 object stores. Sync flushes on reconnect, on mount and every 15 s while anything waits. **Any read-modify-write on an offline store must happen inside a single `readwrite` transaction** (get + merge + put together), never a readonly get followed by a separate readwrite put — IndexedDB only serialises *overlapping readwrite* transactions on a store, so the two-transaction shape lets concurrent callers read the same pre-image and clobber each other's write. `saveOrder`'s un-awaited KOT and BOT sends both go through `enqueuePosOrder`. POS billing is hard-gated offline (`payBlocker` includes `!isOnline` and unread settings), so the offline surface is order-taking only — no money path is ever reachable without a live server.
- `settings` INSERT/UPDATE follow the standard `is_admin() OR client_id = my_client_id()` pattern (S290, `20260707150000_settings_rls_same_client_write.sql`); the `client_id IS NULL` global-defaults row (`app_name`, `app_tagline`, etc.) stays admin-only automatically since a real client's `client_id` can never equal `NULL`. An RLS-blocked write returns zero rows changed with no error rather than throwing. It still stays on raw `supabase.from()` rather than `scopedDb` (see the `scopedDb` note above), because of the nullable `client_id`.

History: docs/rules-archive/pos-billing.md#settings-rls-and-offline-queue-history

## A credit note that cannot reach Inventory is marked and posted later, like a bill (S747)

**The server posts a note as it is issued (S832 5f-4, Q32, `20261013200000`):**
`pos_credit_notes_post_to_inventory` (AFTER INSERT, DEFINER, exception block) → `pos_post_credit_note_into`,
the bill's `pos_bill_sales_rows` 'pos' rows negated, plus its 'pos_sale' lines back for a "not served"
note, one transaction; waiting notes go through `post_waiting_credit_notes` (the bills RPC's rights).
`creditNotePosting.js` only reads the mark back (`creditNoteInInventory`) and counts. Since `20261013210000` (floor 448) the guards refuse a note's rows and its mark from any login (`pos_credit_server_only`) outside the operator's restore.

- **`pos_credit_notes.ims_posted_at` is stamped only after the rows land** (since S809 2f by the
  database, in the same transaction), and every reversal row
  carries **`sales_entries.pos_credit_note_id`**. The backfill asks the link, never the stamp alone —
  the same reason bills carry `pos_order_id` (above).
- **The reversal takes back what the bill POSTED**: comped lines skipped, the bill discount spread as
  the bill posted it, a `writeoff` bill reverses nothing.
- **The note issues whatever happens**, so failure is a notice with one button, not an error with a
  retry. Recovery is the floor banner's Post to Inventory (open month) or Periods → Post POS bills to
  Inventory (the Owner; any month), each posting waiting notes after the bills; the floor counts them (`unpostedNotes`, head-count, keeps last value on a failed poll) and
  the Credit Note Book badges them.
- **Pre-migration notes were stamped as posted when their client had any `pos_credit` row** — NULL
  on an old row means "unknown", and treating unknown as unposted is how bills double-posted.

**S754 gave the note two more side-effects, and both follow the same "the note issues whatever
happens" rule** (owner decisions).
- **"Was money returned to the customer?" is asked on every note**, because a note corrects the VAT
  register and says nothing about the drawer. **Cash** writes a `pos_cash_movements` refund on
  the open shift. It is checked BEFORE the note is issued, twice (when Cash is picked, and again on
  Issue), because refusing after a permanent numbered note exists is not available. **Other** and
  **None** store nothing in cash. **The answer is `pos_credit_notes.refund_method` (S755)**, shown
  in the Credit Note Book and never printed, never appended to the reason. Notes issued before S755
  keep it in their reason text: a printed note is not rewritten.
  History: docs/rules-archive/pos-billing.md#credit-note-history
- **The bill's loyalty is reversed** through `reverse_loyalty_for_credit_note`.

**Since S809 2e (`20261009210000`) the link, the refund and the points are the note's own
transaction.** `pos_credit_note_settle` (AFTER INSERT, INVOKER) links the bill through
`guard_pos_order_close` (no link refuses the note, `credit_note_link_failed`), writes a Cash refund of
`LEAST(pos_bill_cash_taken(order), net)` on the open shift (`credit_note_refund_no_shift` without one),
and calls `reverse_loyalty_for_credit_note`. SHIFTS-3: the refund is only the cash the bill took (a
Split bill's Cash legs; nothing for card, QR, points or unpaid Credit, where the modal switches Cash
off); cash handed back for a card bill is a Cash Out (owner, 2026-10-09). The operator's restore and
non-client sessions get the link only. The modal prints first, then posts to Inventory; a note never
printed has Print in the Book. **A change to the close guard's link rule, or to
`reverse_loyalty_for_credit_note`, that can refuse will refuse every note.**

**A note says whether its food was served (S809 2e, Q10 a).** `pos_credit_notes.restock`, locked once
issued. A "not served" note posts its reversal as `pos_credit_restock` (counted, negatively, by
`selectDepletingSales`) plus signed `stock_movements` `pos_credit_restock` rows that negate the
bill's own `pos_sale` movements (one per bill and item, a unique index), in the note's month: an item
the bill took off comes back on, and an item a choice ADDED to the bill comes back off (S862
REPORTS-STOCK-4, `HAVING abs(sum) > 1e-9`; until then only the first half was written). It waits
(`bill_waiting`) until the bill's own sale is in Inventory. `ims_sales_entries_guard` refuses a
`pos_credit` row for a restock note (`credit_note_restock_mismatch`, an older page) and a malformed
restock row (`pos_credit_restock_invalid`), the Owner included. Since S828 5d it also refuses a row
naming the wrong kind of record (`sales_entry_link_mismatch`: manual names nothing, a till sale no
note, a reversal its note and no bill), any till row at an outlet with `ims_enabled` false
(`pos_outlet_no_ims`) and a reversal naming another outlet's note (`pos_credit_note_other_outlet`);
the operator meets all of these outside its restore.

**Issuing is manager-only in the table too** (`guard_pos_credit_note`): `issued_by` is stamped, the
original invoice number, label and Miti are the bill's (S828 5d; `invoiceLabel`/`nepalBsLong` are the
JS twins, `bs_months` the table),
a note is never edited except its print count (only upward) and its Inventory stamp (set once, by
a POS manager, the Owner or the operator; S809 1c), never deleted, and a bill is
credited once. **The amounts are checked against the bill (S755, HINT `credit_note_amounts`)**
without a second copy of the VAT formula. The note's gross must equal the bill's non-comped lines,
its discount the bill's discount, taxable + non-taxable must equal gross − discount, and net must
equal taxable + non-taxable + VAT within the rupee rounding and `paid_amount` within NPR 1. VAT needs
a taxable base. `paid_amount` is `payTotal`, the same expression as `computeOrderAmounts().net`,
which is why pinning net to it pins VAT too. Since S809 2c the note is worked out under its bill's
stamp (`billVatRegistered`), so a bill from before a VAT change is credited as issued and passes;
only an unstamped bill (restored from a pre-2c backup) can still meet today's setting and be refused.
**A Credit bill with a credit note against it is no longer owed**, so
it leaves Customers → Credit. A bill settled before it was credited stays in Collected,
because that money really changed hands.
