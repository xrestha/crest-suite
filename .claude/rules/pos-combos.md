---
paths:
  - "src/modules/customization/Combo*.jsx"
  - "src/modules/customization/combo*.js"
  - "src/modules/pos/orders/combo*.js"
  - "src/modules/pos/orders/ComboTill.jsx"
  - "src/modules/pos/guestmenu/GuestComboSheet.jsx"
---

# Combos (S839)

The contract is `docs/pos-combos.md`; change it first, then the readers. Owner decisions are listed
there.

- **A combo dish is a real order line**, of its own recipe, category, station, stock and VAT rate,
  carrying a share of the combo price and the tag `combo_line_id`/`combo_id`/`combo_name`/
  `combo_price`/`combo_group_id`/`combo_group_name`/`combo_sort`. There is no combo line of its own.
- **Its `selection_key` ends `@<combo_line_id>/<combo_group_id>`**, after its own option ids, so the
  line key keeps it apart everywhere a line is matched by key. Anything that reads option ids out of a
  key cuts it at `@` first (`optionPartOfKey`, `lineOptionIds`); `isComboLine` / `isComboItem` tell a
  combo dish by its tag or its key. A CHECK on `pos_order_items` keeps the tag and the key in step.
- **The split is one rule in two places**: `pos_combo_shares` (SQL, authoritative) and `comboShares`
  (`comboPricing.js`, display only). A pick's share follows its cheapest dish's guest price, inactive
  dishes included, the last pick takes the rounding. Change both together; the till only ever shows
  the server's prices once a save answers.
- **Total Qty counts a combo once, on the bill, the credit note and the Complimentary Slip**
  (`printedQtyOf` in `comboBillRows.js`, S856, owner decision): what the guest ordered, never its dishes.
- **A bill discount never touches a combo.** `posBillingMath` spreads it per line (0 on a combo dish),
  `storedDiscountRatio` and `billSalesRows` leave combo dishes out, and so do `pos_bill_sales_rows`
  and `guard_pos_order_close` (`discount_on_combo`). A new reader of bill lines that applies the
  discount selects `combo_line_id` or `selection_key`.
- **A combo is one unit** for comps (`combo_comp_whole`), moves (`combo_move_whole`) and removal
  (`combo_incomplete`: a dish is swapped within its pick or the whole combo goes). The server enforces
  all three; the till offers the combo as one row.
- **A function that copies `pos_order_items` rows by column list** (`pos_move_lines`,
  `apply_pos_item_comps`) must carry the seven combo columns, and `guard_pos_item_price` lists them.
- **The till floor** was raised once the combo release was deployed: an older till would read the `@`
  key as an option id.
- **HQ's push carries combos with the choices (S840)**: `master_id` on `pos_combos` / `pos_combo_groups`,
  the rules in `docs/pos-combos.md`.
