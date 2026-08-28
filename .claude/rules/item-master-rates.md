---
paths:
  - "src/modules/ims/items/**"
  - "src/modules/ims/purchases/**"
  - "src/pages/Items.js"
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
- **The bill prefills `per_uom_rate × cf`, never `items.rate`** (`PurchaseBillModal.jsx`) — the rate
  that matches whichever unit the Qty box is counting, in both cases. Purchase Orders had always
  done this (`PurchaseOrders.js:155`); the bill modal was the only holdout. Each row now also prints
  the master rate for that same unit beneath the box, ambered past 5×/⅕, so a unit mix-up is visible
  on the row rather than only in a grand total where a 500× error still reads as a plausible number.
- **The "Rate changes detected" sync compares and writes in the box's unit** (`Purchases.js`): it
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
