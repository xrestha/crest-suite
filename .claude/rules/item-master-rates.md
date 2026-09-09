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
  it does not, S698). The bill modal was the only place the two units could cross. Each row now also prints
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

This is distinct from the `purchase_entries` qty/rate convention in `CLAUDE.md` ("Purchases: qty/rate storage convention"): that one is about a *conversion factor* between purchase and base units on a transaction row, this one is about the item master. Both end in base units, but they are different columns with different arithmetic — and the S597 lesson is precisely that a column allowed two meanings will be read with the wrong one somewhere, silently, by code that looks correct.

### Base Unit is the item's UOM, and a conversion factor must be above 1 (S706)

`base_unit` has **no reader**. Every consumer of a conversion goes through `getCf(item)`
(`purchasesHelpers.js`) — `cf > 1 && purchase_unit` — and converts the purchase unit into
**`items.uom`**: the qty a purchase entry stores, the unit Purchases/Returns/the printed voucher
label it with, and the unit stock is counted and valued in. The column is still written (the
HQ→branch `push_master_data` copies it) but nothing computes from it.

So the Conversion tab no longer **asks** for it. It was a free `UNITS` select, which let an item say
"1 CTN = 24 BTL" while its stock was priced per GM, and this dialog's own preview printed the per-GM
rate labelled "per BTL" — the S597 screen-agrees-with-the-reader shape one layer up. `itemPayload()`
derives `base_unit = form.uom`, and the table's badge prints `item.uom` rather than the stored
column, so a legacy row whose `base_unit` disagrees stops advertising a promise nothing keeps. Same
reasoning that took `Purchase Qty` off this form: **a value that is structurally fixed is stated,
not asked.**

A **factor of 1 or below is not a conversion** and is now refused at save. `getCf` has always
ignored one, but the row still carried it, the Conversion tab showed its green dot, and the table
badged `1 CTN = 0.5 BTL` (`!== 1` passes 0.5) — a conversion the reader could see and no bill,
voucher or report honoured.

### The form's rules are pure, in `itemFormRules.js` (S706)

`nextItemCode`, `perUnitOf`, `validateItemForm` and `itemPayload` moved out of `Items.js` and are
tested. Two things they hold that the page had been getting wrong:

- **Yield % is 1–100.** The box has carried `min="1" max="100"` from the start, but the dialog is
  not a `<form>` and nothing submits it, so neither attribute was ever checked: a typed `1000` saved
  as 1000, and `recipeCostCalc` divides by `yield_pct / 100` at every depth — costing every recipe
  using that item at a tenth, in green, with nothing to flag it.
- **Two items may not share a name.** `items` has no `UNIQUE(client_id, name)` and the recipe
  importer maps an ingredient name to whichever row it saw **last**, so a duplicate means recipes
  cost off one twin while purchases accumulate against the other. Refused at save, naming the item
  that already has the name — and **skipped entirely when the items read failed**, since a check
  against a list that may be missing rows can only produce a false all-clear.

**The next item code is `nextProductCode()`** (`src/shared/productCode.js`), shared with Recipe
Costing, Settings' Product Codes and Vendors rather than a fourth inline copy. It escapes the
prefix: `settings.item_code_prefix` / `vendor_code_prefix` are free text, and a prefix carrying a
regex metacharacter ("A(", "C++") threw a `SyntaxError` from inside the save **after `saving` was
already true** — the button stuck on "Saving…", nothing was written, nothing named the prefix.

And it is only meaningful over an authoritative list: a failed read left `items` empty, so the next
item was handed `ITM-001` over codes that already existed — silently, since there is no
`UNIQUE(client_id, item_code)`. Item Master therefore **refuses to open Add while its list is
unknown**, and Settings' "Renumber every item" now excludes sub-recipe mirrors (their `item_code`
IS their recipe code, and a renumbered mirror spent a number Item Master cannot see).

## `per_uom_rate` is a generated column

Migrated from the root `CLAUDE.md` (S663).

- `per_uom_rate` on `items` is a **generated column** — never include it in INSERT/UPDATE payloads.
