# Bloom demo data

The BLOOM CAFE (Jhamsikhel) and BLOOM CAFE - PKR (Lakeside) test accounts carry a made-up café's
history from Shrawan 1, 2083, for showing Crest to prospects: menu, stock, suppliers, till bills,
staff, roster, attendance, payroll and month-end counts. Everything is generated here and written
to the live database through the linked Supabase CLI. No app code reads these scripts.

## Before a demo: top up to "now"

```bash
cd scripts/demo-bloom
node --no-warnings --import ./register.mjs topup-all.mjs            # shows what would change
node --no-warnings --import ./register.mjs topup-all.mjs --apply    # writes it to the live database
```

It rebuilds the whole history at the current Nepal time, compares it with what is loaded, and writes
only the difference: the day's bills, an open shift and a couple of open tables, supplier bills and
payments, attendance, delivery settlements. Past Ashoj 31 it also closes Ashoj (stock count, Ashoj
payroll, Bhadra paid) and opens Kartik. **When a month closes, open the Owner Report once as the
Owner at each branch**, so the app makes that month's report (the page opens on the newest closed
month; make the older one first).

Its memory is in `~/.claude/demo-bloom/`: `loaded-state.json` (every row loaded, by table and id),
`profiles.json` (the till logins' ids) and `audit-marker.txt`.

## Files

| File | What it does |
| --- | --- |
| `config.mjs` | The café: outlets, menu, recipes, stock items, suppliers, staff, tables, overheads, assets |
| `model.mjs` | Master rows and the recipe explosion (the app's own sub-recipe walk) |
| `pos.mjs` | Bills, kitchen tickets, payments, loyalty, shifts, credit notes, bookings, and what each bill posts to Inventory |
| `ims.mjs` | Purchases, supplier payments, a return, wastage, staff meals, month-end counts |
| `hr.mjs` | Staff records, roster, attendance, leave, overtime, a loan, travel claims, payroll through the app's own `payrollData.js` |
| `build.mjs` | Builds everything and writes ordered SQL files plus `state.json` |
| `topup.mjs` / `topup-all.mjs` | Diff of two states → SQL; the one-step runner |
| `apply.mjs` | Runs SQL files one transaction each, stops at the first error |

## Rules for changing the generator

- **`BASE_CUTOFF` (`config.mjs`) is the first full build's cut-off and must never change.** Anything
  random or averaged that a later "today" could move is pinned to it, so a top-up never rewrites a
  day already loaded. After any change, run `topup.mjs` at the base cut-off against
  `loaded-state.json`: it must report **no changes at all**.
- A new random draw for days already loaded goes on its own stream (`rngFor(..., key)`), never on a
  shared one: one extra draw on a shared stream reshuffles everything after it.
- Times are Nepal wall-clock strings with `+05:45`. Bill numbers, order numbers and the
  complimentary series are assigned after all days are built, in the order the database would.
- The two app bugs this work found are fixed in `computeMonthlyReport.js` (a month's till bills read
  unpaged, and their lines read with every bill id in one URL).
