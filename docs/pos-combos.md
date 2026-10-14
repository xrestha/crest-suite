# Combos (S839): the contract

Crest Customization release 2. A **combo** is sold at one price ("Momo Combo, NPR 350") and is made of
**picks** ("Pick a momo", "Pick a drink"); each pick is exactly one dish from a short list, with an
optional extra charge per dish ("Chicken +50"). A **set meal** is a combo whose every pick lists one
dish, so the till adds it in one tap; a **pick-your-own deal** asks one question per pick.

Owner decisions (2026-10-14): both kinds; part of the paid Customization add-on; the bill prints one
line "Momo Combo … NPR 350" with its dishes listed underneath unpriced; guests order combos from the
table QR menu; a dish inside a combo may take its own choices (sizes, add-ons), charged on top; a guest
dropping a dish means swapping it within its pick or removing the whole combo; **a bill discount never
touches a combo**.

Change this file first, then every reader below.

## The model: each dish of a combo is a real order line

A combo on a bill is not a line of its own. Each picked dish is an ordinary `pos_order_items` line, of
its own recipe and category, carrying a share of the combo's price and a combo tag. So it prints on its
own station, takes its own recipe's stock, counts as that dish sold in every report, and carries its
own VAT rate. The tag keeps the dishes of one combo together.

### Setup tables (all `client_id`-scoped, same-client RLS + the `no_self_service_accounts` /
`no_hr_role_staff` restrictive pair, like the option tables)

| Table | Columns |
| --- | --- |
| `pos_combos` | `id`, `client_id`, `name` (unique per client, trimmed, case-insensitive), `guest_price` numeric(12,2) > 0, `description` text NULL, `is_active` bool, `on_guest_menu` bool, `sort` int, `created_at` |
| `pos_combo_groups` (a pick) | `id`, `client_id`, `combo_id`, `name` (unique per combo), `sort`, `created_at` |
| `pos_combo_items` (a dish in a pick) | `id`, `client_id`, `group_id`, `recipe_id` (ON DELETE CASCADE), `extra_price` numeric(12,2) ≥ 0, `is_default` bool, `sort`, `created_at`; unique `(group_id, recipe_id)` |

`guest_price` and `extra_price` are what the GUEST pays: VAT-inclusive on a VAT-registered outlet (menu
prices in Nepal include VAT), the price itself on a PAN outlet. Everything else in the database is
ex-VAT; the conversion happens per dish, below.

A dish in a combo must be active and not a Sub-Recipe. It need NOT be On POS or priced on its own (a
side sold only in combos).

**Writes go through two RPCs**, never the tables (the trigger `guard_pos_combo_edit` refuses a direct
write below the rank, and the RPC keeps a combo whole):
- `save_pos_combo(p_combo jsonb) returns uuid` — INVOKER. `p_combo` = `{ id?, client_id, name, guest_price,
  description?, is_active?, on_guest_menu?, sort?, groups: [{ id?, name, sort?, items: [{ recipe_id,
  extra_price?, is_default?, sort? }] }] }`. Upserts the combo, its picks (by id; a pick without an id
  is new) and their dishes; deletes picks and dishes not in the payload. Returns the combo id.
- `delete_pos_combo(p_combo_id uuid)` — INVOKER.
- Refusals (HINT): `combo_name_taken`, `combo_price_invalid`, `combo_needs_picks` (no pick),
  `combo_pick_empty` (a pick with no dish), `combo_pick_name_taken`, `combo_dish_unavailable` (a dish
  not this outlet's, inactive or a Sub-Recipe), `combo_default_twice`, `option_edit_rank` (below the
  Owner / POS manager / IMS manager / operator), `customization_off` (Customization not live; the
  operator is exempt).

Reads: the three tables through `scopedFrom` (any login of the outlet; the till reads them for its menu).

### The price split — `pos_combo_shares(p_combo_id uuid)` and its JS twin `comboShares()`

Each pick's **share** of `guest_price` is in proportion to its CHEAPEST dish's standalone guest price
(`selling_price × (1 + vat_rate)` on a VAT outlet, `vat_rate` NULL = 0.13; `selling_price` on a PAN
outlet; an unpriced dish weighs 0). If every pick weighs 0, the picks share equally. Shares are rounded
to 2 decimals and the LAST pick (by `sort`, then `id`) takes the remainder, so the shares always add up
to `guest_price` exactly. Because the share depends on the cheapest dish, not on the dish picked, a
swap within a pick never moves the other dishes' prices (Odoo's rule).

A combo dish's line is priced:
- `base_unit_price` = `round((share + extra_price) / (1 + line vat_rate), 2)` — ex-VAT;
- plus its own choices (`options_delta`, priced by the existing Customization rules on THAT dish);
- `unit_price` = `base_unit_price + options_delta`;
- `vat_rate` = the dish's own rate (`COALESCE(vat_rate, 0.13)` on a VAT outlet, 0 on a PAN outlet).

The till never prices a combo dish itself; it shows `guest_price + extras` until the save answers, then
the server's lines.

### A combo dish's line

New columns on `pos_order_items` (snapshots, written only by the server):

| Column | Meaning |
| --- | --- |
| `combo_line_id` uuid | One id per combo on the bill, minted by the till (`crypto.randomUUID()`, lowercase). All dishes of that combo carry it. |
| `combo_id` uuid | Which combo (no FK: the menu can change). |
| `combo_name` text | The combo's name when sold. |
| `combo_price` numeric | The combo's `guest_price` when sold (for display; the money is on the lines). |
| `combo_group_id` uuid | The pick. |
| `combo_group_name` text | The pick's name when sold. |
| `combo_sort` int | The pick's place in the combo. |

**`selection_key` of a combo dish = `<its option ids, sorted, joined '+'>@<combo_line_id>/<combo_group_id>`**
(all lowercase; the part before `@` is empty when the dish has no choices). The line key stays
`recipe_id#selection_key`, so a combo's dish is a different line from the same dish ordered alone or
in another combo everywhere a line is matched by key: the save, tickets and their Clear rule, pulled
items, the KDS, moves and comps. **Everything that turns `selection_key` into option ids must cut it at
`@` first** (`lineOptionIds`, `cartLineFromStored`). A line is a combo dish when `combo_line_id` is set
or its `selection_key` contains `@` (`isComboLine`).

### Saving (`save_pos_order_items`)

The till sends each combo dish as an ordinary row plus `combo: { line_id, combo_id, group_id }` (the
row's `options` are that dish's own choices). The server:
- builds the selection key above, and takes `combo_name`, `combo_price`, `combo_group_name` and
  `combo_sort` itself, never from the tablet;
- for every combo on the payload (one `combo_line_id`): one row per pick, every pick present, all at the
  same quantity — else `combo_incomplete`. A combo already on the order is checked against the picks it
  was saved with; a new one against the combo's picks today;
- a NEW combo dish must be one of its pick's dishes today, the combo active, Customization live —
  else `combo_dish_not_offered` / `combo_unavailable`;
- prices a new combo dish from today's split (above); an existing line keeps its price, as every line
  does;
- **swapping** a dish = the payload replaces that pick's row with another dish of the pick (same
  `combo_line_id` and `group_id`): the old dish's sent units are recorded as pulled, the new dish is
  priced from today's split and goes on the next ticket. Dropping a dish with no replacement is
  `combo_incomplete`: remove all its dishes to remove the combo;
- the dishes of a combo always share one quantity: two of the same combo with the same picks are one
  combo at qty 2.

### Discounts never touch a combo

The **discountable subtotal** is `Σ qty × unit_price` over lines that are neither comped nor combo
dishes. A bill discount spreads over those lines only:
- `posBillingMath.js`: each line's discount ratio is `discount / discountableSubtotal` for a non-combo
  line and 0 for a combo dish; VAT, taxable and non-taxable follow per line
  (`computeOrderAmounts`, `computeGroupAmounts`, `discountableSubtotal`, `lineDiscountRatio`);
- the close (`guard_pos_order_close`) refuses a discount above the discountable subtotal from anyone
  but the operator (`discount_on_combo`), and measures a cashier's cap against it;
- `pos_bill_sales_rows` (Inventory revenue) applies the discount to non-combo lines only;
- the till's discount box: a percent is of the discountable subtotal; an amount is capped at it; a bill
  of combos only offers no discount.

Every read of bill lines that feeds this maths must select `combo_line_id` (or `selection_key`).

### A combo is one unit for comps and moves

- **Item comps** (`apply_pos_item_comps`): every dish of a combo is comped by the same quantity, in the
  same call — else `combo_comp_whole`. The till's comp panel offers the combo as one row.
- **Moves** (`pos_move_lines`, split / part bill): every dish of a combo moves by the same quantity —
  else `combo_move_whole`. The till's move picker offers the combo as one row. Joining and whole-bill
  moves are unchanged.
- A whole-bill Complimentary, a Void and a Credit Note take every line anyway.

### On paper and on screens

- **Kitchen / bar tickets and the KDS**: each dish on its own station as today, with `↳ <combo_name>`
  under it.
- **The bill (and its reprint and viewer)**: lines of one `combo_line_id` print as ONE row at the
  position of its first dish: the combo's name, qty = the dishes' qty, amount = Σ the dishes' line
  amounts (`qty × unit_price`), rate = amount ÷ qty, no HSC; underneath, each dish's name (and its
  choices) indented and unpriced.
- **The till's cart**: a combo shows as a block — its name, qty stepper and total, with its dishes
  under it, each with its own sent/unsent state and a Swap button; Remove takes the whole combo.

### Guest QR menu

- `get_guest_menu_options(p_table_id)` gains `combos`: `[{ id, name, description, guest_price, sort,
  groups: [{ id, name, sort, share, items: [{ recipe_id, name, is_veg, extra_price, is_default, sort }] }] }]`
  — active combos on the guest menu, every pick with at least one available dish; only while
  Customization is live.
- `submit_guest_order` takes, beside dish items, combo items: `{ combo_id, qty, note, picks:
  [{ group_id, recipe_id, options: [ids] }] }`. It checks them as the save does, prices each dish, and
  stores each as a request item carrying `combo: { line_id (minted), combo_id, name, group_id,
  group_name, sort, price }`. A combo no longer available names it in `unavailable_items`.
- The till's Accept merges a request's combo dishes into the cart as one combo (same `line_id`).

### Reports

- Every dish report counts a combo's dishes as those dishes sold, at their share.
- The Customization Report gains a **Combos** tab: per combo, how many sold (Σ over its
  `combo_line_id`s of their qty), revenue (Σ the dishes' amounts), and each pick's dish mix.

### Rollout

The till floor (`pos_min_till_build`) is raised to this release once it is deployed: an older till
would read a combo dish's `@` key as an option id.
