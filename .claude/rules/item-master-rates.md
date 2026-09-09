---
paths:
  - "src/modules/ims/items/**"
  - "src/modules/ims/purchases/**"
  - "src/modules/admin/dataExport/restoreClientData.js"
---

# Item master rates: `purchase_qty` is always 1

> Moved out of the root CLAUDE.md (2026-08-27 /doctor pass) so it loads only when working on
> these files. Root CLAUDE.md keeps the universal invariants.

### Every item is stored in its SMALLEST unit — `purchase_qty` is always 1 (S597, supersedes S566)

`items.per_uom_rate` is a **generated column** — `rate / NULLIF(purchase_qty, 0)` — and `purchase_qty`
is now always **1**, so **`items.rate` is the price of ONE base unit and equals `per_uom_rate`**. A
1 KG bag counted as 1000 GM and costing NPR 500 is stored as `purchase_qty 1, rate 0.50`. Stock
Count, Variance, COGS, Reorder and the Monthly Owner Report all value stock straight off
`per_uom_rate`, so a wrong pair here misprices the item everywhere at once with nothing to flag it.

The Add/Edit Item form collects **one price — "Price per GM (NPR)"** (the label tracks the UOM) —
and writes it to `rate` unchanged. A **"Bought a pack?"** line beneath it does the division on
screen (`500 GM for NPR 388.50 → NPR 0.777 per GM`) and fills the field above; neither of its two
boxes is state that survives, and both are cleared every time the dialog opens. Migration
`20260820100000` backfilled the book (value-preserving: `per_uom_rate` is unchanged for every row)
and a `CHECK (purchase_qty = 1)` holds the line.

**The form's first pass at this kept `Purchase Qty` and `Rate` as fields, and that was the same bug
one layer up.** `Rate` meant the pack price while you typed and the per-unit price once you reopened
the item — one box, two meanings, which is precisely what had just been taken out of the database.
The rule the second pass follows: **a field that is only arithmetic must not look like a field that
is stored.** So the stored value gets a box with a name that states its unit, and the arithmetic
gets a sentence-shaped helper that visibly empties itself. `Purchase Qty` left the form entirely —
it is structurally 1, so a box showing it taught nothing — and `Price per unit` stopped rendering
its value as a *rounded placeholder* (`0.78` for a stored `0.777`), which had made the one number
the page is built on the only one on screen that was not real.

**Until S597 the same column meant two things and the product could not tell.** `per_uom_rate` came
out right either way, so recipe costing and every report looked correct — but **Add Purchase Bill
prefills `items.rate` into a rate box whose Qty is counted in BASE units**, so a 500 GM bottle
stored as `(500, 388.50)` prefilled NPR 388.50 against a qty of 500 GM and billed **NPR 194,250 for
a NPR 388.50 bottle**. 253 of the reference client's 254 items were already `(1, per-unit)`, which
is exactly why it went unseen: `rate` meant "per GM" for all of them and "per bottle" for the one.
Four consequences fell out of that, all now fixed and all worth not re-deriving:

- **`purchase_qty` no longer mirrors `conversion_factor`.** Buy-in-CTN / count-in-BTL belongs to the
  conversion columns alone — that is what the Purchase Bill reads to decide whether its Qty column
  means cartons or bottles. Mirroring it put a per-CTN price in the column every valuation reads as
  per-BTL. The Conversion tab's preview now shows cost **per purchase unit** (`rate × cf`), since
  `rate` is already the per-base-unit figure.
- **The bill prefills `per_uom_rate × cf`, never `items.rate`** (`PurchaseBillForm.jsx`) — the rate
  that matches whichever unit the Qty box is counting, in both cases. Purchase Orders prefills
  bare `per_uom_rate` and has no conversion handling at all — its qty is BASE units, so that is
  internally consistent, not the same rule (an earlier version of this line claimed it did `× cf`;
  it does not, S698). **S709 put that fact on the PO screen itself** — the Unit Price tooltip now
  says "per BASE unit — the unit shown in the UOM column, not a case or a sack", because a
  convention that only exists in a rules file is one a user cannot check while typing. The bill modal was the only place the two units could cross. Each row now also prints
  the master rate for that same unit beneath the box, ambered past 5×/⅕, so a unit mix-up is visible
  on the row rather than only in a grand total where a 500× error still reads as a plausible number.
- **The "Rate changes detected" sync compares and writes in the box's unit** (`PurchaseBillPage.jsx`
  since S647; it was `Purchases.js` while the form was a modal mounted there): it
  matched the entered per-unit rate against `items.rate` and wrote it back raw, so correcting a
  conversion item's rate by hand would have stored a per-CTN price as per-BTL. It divides by `cf`
  going in, and its epsilon compare stops the prompt re-firing on rates that never moved.
- **A restore normalises on the way in** (`restoreClientData.js`) — a backup predating this rule
  would otherwise come back carrying a pack size and trip the CHECK.

Three things worth keeping in mind before touching this form again:

- **The screen agreed with the user and disagreed with the database.** The "Per UOM rate:" hint special-cased the draft box and printed `form.rate` directly, so it showed the *correct* per-unit figure while saving the wrong one — the one shape of bug a careful user cannot catch by reading the form. That branch is gone; the hint now always derives from `perUom(purchase_qty, rate)`, which is the same arithmetic the DB does.
- **A sub-paisa `per_uom_rate` is legitimate** (a PCS item bought by the 1000), so the Item Master column's `.toFixed(2)` rendered exactly the mis-entries it existed to reveal as a flat `0.00`. Both the column and the form hint share `fmtPerUom()` now, which falls back to 6 decimals below 0.01.
- **`Rate (NPR)` had no `Tip`** while every field around it did — and it is the one field whose meaning is genuinely ambiguous. Any new field in this form needs one from the start, per the tooltip rule below.
- **The pack helper keeps ONE division** (S623): `perUnitOf()` feeds both the "→ NPR x per uom" preview and the rate written into the form — two independent copies of that division briefly existed with different rounding, which is the screen-agrees-with-the-user shape above, one layer up. It coerces with `Number()`, never `parseFloat`, so a prefix-parseable string ("5oo" → 5, "1,200" → 1) can never price an item even if one slips past `QtyInput`. And when both boxes are filled but the division can't run (zero, negative, unparseable), both boxes go invalid — through `fieldAria` with ONE shared id and a single `FieldError` saying Price per UOM still shows its last value (S624; a hand-rolled `aria-invalid` + inline span preceded it, drifting from `.field-error` and binding the message to nothing) — because the rate box deliberately keeps that value, so the state must be visible or the pack line and the saved price silently disagree on screen.

This is distinct from the `purchase_entries` qty/rate convention below ("Purchases: qty/rate storage convention", migrated from the root `CLAUDE.md` by the 2026-09-09 /doctor pass): that one is about a *conversion factor* between purchase and base units on a transaction row, this one is about the item master. Both end in base units, but they are different columns with different arithmetic — and the S597 lesson is precisely that a column allowed two meanings will be read with the wrong one somewhere, silently, by code that looks correct.

## `per_uom_rate` is a generated column

Migrated from the root `CLAUDE.md` (S663).

- `per_uom_rate` on `items` is a **generated column** — never include it in INSERT/UPDATE payloads.

## Deleting an item: the database backs up five of eleven tables (S706)

**`src/modules/ims/items/itemRefTables.js` is the one list of every table with an FK to
`items.id`**, in an order that is safe to delete in, with a `cascades` flag per table. Read it, and
`itemRefTables.test.js` beside it, before changing anything about the delete path.

**Three of the eleven are `ON DELETE CASCADE`** — `requisition_lines`, `staff_meals`,
`vendor_returns`. This is the `confdeltype` rule from `vendor-payables.md` landing in the one place
where the consequence is destroyed history rather than a refused click: for those three, "the
database will stop me" is simply false. A delete the guard failed to warn about is not refused; it
succeeds and takes the rows with it, and nothing errors.

So the guard fails CLOSED, in three specific ways that each shipped as a live bug:

- **The badge map is not the guard map.** `usageMap` only counts a row when `qty > 0`, which is
  right for a chip that means "does this item have live usage" and catastrophic for a delete guard,
  because **`staff_meals.qty` DEFAULTS TO 0**. A zero-quantity staff meal earned no badge, passed
  the guard, and cascaded away under a confirm dialog reading *"Nothing references this item, so no
  purchase, count or recipe changes."* One set of reads builds two maps now: `usageMap` for the
  chip, `refMap` (any row at all) for the guard. Never point the guard at the badge.
- **A scan that could not run must not read as a scan that found nothing.** `usageScan.ok` is what
  separates "no records" from "we could not check". With it false the column says **"not checked"**
  rather than a dash, a banner names the tables that failed, and the delete refuses outright — the
  `UsageChip` rule (a chip must never be able to mean two things) applied to the *absence* of the
  chip, which is the half that is easy to miss.
- **The clearing loop and the badge read the same list.** They had diverged: the loop knew eight
  tables while eleven referenced `items`, so force-delete emptied the eight and Postgres then
  refused the final delete because `par_levels`, `purchase_order_items` and `stock_movements` still
  held the row. The item survived with its history gone. Deriving both from `ITEM_REF_TABLES` is
  what makes that unrepresentable; the test is what makes a NEW referencing table reach it.

**The test reads the migrations** (the `nepalMoney.test.js` technique) and asserts three things a
comment could not: that every FK to `items(id)` is listed, that each `cascades` flag matches the
schema, and that `vendor_returns` precedes `purchase_entries` — it references both. It was verified
to fail against the pre-fix list on the omission *and* on a wrong cascade flag, because a schema
test that silently matches nothing passes vacuously; the first assertion guards the parser itself.
`recipes.linked_item_id` is deliberately excluded and named in the test, since Item Master lists
only `is_sub_recipe = false` rows.

**A message must not offer a retry that cannot work.** Force-delete's failure text said "Try the
delete again" while a refused clear was the reason — retrying repeats the same refusal forever. It
now names what was already destroyed, what is still holding the item, and says plainly that
retrying will not get past it. Same family as the consequence-not-constraint rule in
`error-messages.md`.

**Hiding is not the free alternative every refusal implies.** Six report reads carry
`.eq('is_active', true)` per the S436 rule that stock is never valued off an inactive item, so
hiding an item that still holds stock takes its value out of stock valuation and the monthly
summary. `HIDE_INSTEAD` is the one string all the refusals share, and it says so. Hide once the
stock is at zero.

## `base_unit` is derived, never chosen (S706)

**Nothing downstream reads `items.base_unit`.** The Purchase Bill scales `qty × conversion_factor`
into the item's `uom` (`PurchaseBillForm.jsx`), so the base unit of a conversion is *always* the
UOM, and a stored value disagreeing with it was always a mistake. The only screen that showed it —
this form's own conversion preview — then labelled the rate `per {base_unit}` when the rate is per
UOM, which is the screen-agrees-with-the-user shape again.

The Conversion tab states the UOM instead of offering a `<select>`, `doSave` writes
`base_unit: form.uom`, and a legacy row repairs itself on its next save. The row badge and the
`hasConversion` test read `item.uom` and no longer require `base_unit` at all — a legacy row with a
null base unit used to hide the badge on a real conversion. **Same move as S597's `Purchase Qty`: a
field with exactly one correct answer must not look like a choice**, and conversion validation is
now the remaining pair (Purchase Unit + Factor), not a trio.

## `min`/`max` on an input in this dialog enforces nothing (S706)

The Add/Edit modal is **not a `<form>`** and Save is a plain `onClick`, so constraint validation
never runs — `min="1" max="100"` on Yield % was decorative for as long as it existed. `yield_pct`
is `numeric(5,2)` with no CHECK, and every recipe cost divides by it
(`qty / (yield_pct / 100)`), so a typed `500` makes every dish using that item cost **a fifth** of
what it does, silently and everywhere at once. A `0` or a negative was quietly rewritten to 100,
which is a different number from the one the user typed and says nothing about it.

Validate in `doSave` and surface it through `fieldErr` + `FieldError`. Any numeric field added to
this form needs the same treatment; the attribute on the input is documentation, not a guard.

## One item name per client, enforced (S707, closing S706's client-side check)

**`items_client_name_key` is `UNIQUE (client_id, lower(name))`** — migration `20260909120000`, over
the WHOLE table. S706's `doSave` check stays as the sentence under the box; the index is what makes
it true. Three properties of that index are decisions, not defaults:

- **Case-insensitive**, because `push_master_data`'s adoption already matches on `lower(name)` and a
  case-sensitive index would be uniqueness the push does not agree with.
- **It covers sub-recipe mirrors.** They are stock-counted alongside real items (Stock Count
  deliberately does not filter `is_sub_recipe`), so one name/one row has to mean the whole table or
  it does not mean anything where it matters. The price is real and accepted: a mirror's name is
  re-derived from its recipe on every save, so a mirror the dedupe renamed fails its next recipe
  save until someone resolves the clash — `Recipes.js` says exactly that instead of surfacing 23505.
- **It covers hidden items.** `is_active = false` is what every delete refusal offers as the
  alternative, so hidden rows accumulate by design and still carry the history the name refers to.

**The check could not see what it most needed to see, and that is the transferable part.**
`loadItems` filters `.eq('is_sub_recipe', false)`, so the array `doSave` tested against did not
contain mirrors at all — the one collision class that splits a Stock Count was invisible to the
guard written to prevent it. `Items.js` now keeps a `book` state (names + codes, unfiltered) built
from a read `checkAllUsage` was already making. **Before trusting an in-memory list as a uniqueness
check, ask what its loader filters out.** `getNextItemCode()` had the same blind spot one column
over and is fixed the same way.

**Three of the four write paths into `items` never ran the check**, which is why an index rather
than more validation was the answer: the Recipes.js mirror (no check in either direction, now
checked plus a 23505 backstop), `push_master_data` (three INSERT/UPDATE sites, any of which would
have raised 23505 and aborted an entire multi-outlet push — the plan gained a `'conflict'` action
that is reported in the preview and skipped by the apply pass), and the Export/Import restore (which
breaks a table on its first failing chunk, so one duplicate pair in an old backup would have
abandoned the client's whole item book — `dedupeItemNames` renames on the way in and reports it).

**`item_code` is deliberately left unconstrained.** Same client-side-max root cause, but nothing
keys off it, and pushing HQ's codes into a branch that minted its own would turn every such push
into an abort. Minting from a fresh unfiltered read is the proportionate fix.

## The delete guard is server-side (S707)

The section above this one describes the browser guard, all of which still stands and all of which
is advice. **`items` carries one permissive policy** (`client_id = my_client_id() OR is_admin()`,
FOR ALL) plus restrictive fences for POS PIN staff, HR self-service and HR-role staff — and it is
correctly NOT in the `no_ims_staff` list, so **every IMS account of any rank can `DELETE` an item
straight through PostgREST**, including `ims_role = 'staff'`, which cannot open Item Master at all.
Five of the eleven FKs hold that delete; the three `ON DELETE CASCADE` tables go with it, and two of
those three (`requisition_lines`, `staff_meals`) have no `log_audit` trigger, so the rows leave no
trace anywhere. Staff meals are inside COGS.

`20260909130000` closes it the way privilege invariant #3 says to — a **BEFORE DELETE trigger**
(`items_guard_referenced_delete`, SECURITY INVOKER, keyed on `current_user`), not an RPC, because an
RPC protects only the callers that opt into it and leaves the open policy exactly as wide.
`force_delete_item(uuid)` is the one way through: SECURITY DEFINER so it passes the trigger,
`COALESCE(is_admin(), false)` so it matches Item Master's own gate, and **atomic**, which the twelve
separate HTTP requests it replaced could never be — that loop is what left eight tables emptied and
the item standing. `itemRefTables.test.js` reads the migration and asserts the SQL list matches
`ITEM_REF_TABLES` in membership *and* order, and that the INVOKER/DEFINER pair has not been swapped.

**Deleting a client still works**, and it is worth knowing why: `items_client_id_fkey` is
`ON DELETE CASCADE` and ClientDrawer deletes the `clients` row from the browser, but
`deleteClientData` (service role) empties `items` first, so the cascade fires on zero rows. If that
step ever fails partway the client-row delete now refuses instead of cascading a half-deleted book
away silently, and ClientDrawer's existing handler already says the right thing.

## Purchases: qty/rate storage convention

Migrated from the root `CLAUDE.md` (2026-09-09 /doctor pass) — it is reachable only from the IMS
purchases and items modules, which this file already loads for.

`purchase_entries.qty` and `rate` are stored in **base units**, not purchase units:

- `stored_qty = entered_qty × conversion_factor`
- `stored_rate = entered_rate ÷ conversion_factor`

All downstream calculations (Stock, Variance, FIFO, Reorder) read these base-unit values directly.
