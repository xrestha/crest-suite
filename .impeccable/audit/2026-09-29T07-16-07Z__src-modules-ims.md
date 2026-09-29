# Crest Suite — `/impeccable audit`, IMS module (2026-09-29)

**Scope:** `src/modules/ims/**` — 111 source files, ~50,500 lines — and the 43 IMS routes in `App.js`
(`/ims/count`, the PIN login, skipped). Branch `master` at `9bbe8ccf`.
**Evidence:** (1) the bundled detector over the module (0 findings; confirmed live by planting a known-bad
file, which it flagged); (2) scripted source scans for the five dimensions plus a dropped-`error` scan
over every supabase read and write; (3) a live Playwright sweep of all 43 routes against the CRA dev
server, signed in as admin viewing **CASA ACAI CAFE** (Ashwin 2083 open), in two passes — **Modernist
Light @1280** (alpha-composited text contrast including `color(srgb …)` tints and ancestor opacity,
accessible names, heading outline, console errors) and **Modernist Night @390 with touch emulation**
(`pointer: coarse` confirmed; contrast, clipped content, touch targets, coarse-pointer field size);
(4) every live hit traced to its source line. Baseline: Appendix B of
`2026-09-05T09-39-22Z__crest-suite-all-modules.md` (IMS 14/20).
**Not exercised:** no form submitted and no modal opened beyond what renders on load; no Light-preset
phone pass and no tablet (820px) pass; no throttled-network timing; print output not checked.

## Audit Health Score

| # | Dimension | Score | Key Finding |
|---|-----------|-------|-------------|
| 1 | Accessibility | 3 | Stock Count's and the purchase bill's quantity boxes have no accessible name (322 on one real count sheet) |
| 2 | Performance | 4 | -- |
| 3 | Responsive Design | 2 | On a 390px phone, six pages push real controls past the edge, where `overflow-x: hidden` clips them out of reach — including the bill's Payment field |
| 4 | Theming | 3 | Night is clean on all 43 routes; Light fails AA wherever `--theme-text3` sits on a tinted row, or a row is dimmed with `opacity` |
| 5 | Implementation Integrity | 3 | Every responsive failure is an inline style beating a class (`flexShrink: 0`, fixed grid tracks, no-wrap rows) |
| **Total** | | **15/20** | **Good (address weak dimensions)** |

Against the 2026-09-05 baseline: Accessibility 2→3, Integrity 2→3, Performance 4→4, Theming 3→3,
Responsive 3→2. Responsive did not regress so much as get measured: the baseline scored it from source
("not measured in a browser this pass"), and this pass drove every route at 390px.

## Implementation Integrity Verdict — PASS

The implementation expresses a coherent, product-specific system. The detector is clean across 111
files; the class that held IMS at 2 last time — reads and writes that drop `error` — is **gone**: zero
`const { data } = await …` without `error` and zero bare awaited writes anywhere in the module (the one
`.catch(() => {})` left is a documented offline-cache warm-up after a successful read). All 13 pages the
baseline named now carry `useLatestRequest` (37 files use it); `window.confirm` went from 11 live sites
to none (19 files on `useConfirm`); the seven hand-rolled overlays in Menu Pricing and IMS Staff are on
`Modal`; every mouse-only `<tr onClick>` the baseline listed now has a real control in a cell, each with
a comment naming the rule.

What holds it at 3 is one repeated shape: **an inline style that out-ranks a class the design system
already fixed.** `.page-header--split > *` exists to make header action groups wrap, and an inline
`flexShrink: 0` switches that off on three headers; `.stat-grid`'s `auto-fit` exists so layouts reflow,
and inline `gridTemplateColumns` tracks and non-wrapping flex rows do not. Each site reads correctly in
review and at 1280px; all of them fail only on a phone.

## Executive Summary

- Audit Health Score: **15/20** (Good)
- Issues: **P0 0 · P1 3 · P2 3 · P3 7**
- Measured clean: 0 horizontal clipping on 36 of 43 routes at 390px; 0 fields under 16px under a
  coarse pointer on all 43; 0 unnamed controls on 40 of 43 routes; 0 contrast failures on Night on all
  43; 0 console errors apart from one 400 caused by a pending migration (see Observations).

Top findings:
1. **On a phone, six pages clip real controls out of reach** — the purchase bill's Discount and Payment
   fields, Sales Entry's search and "Only items with sales", Recipe Costing's ingredient search, Best
   Sellers' Bottom 10, and the "+ Add Item" / "+ Add Staff" buttons.
2. **The two heaviest entry grids have unnamed quantity boxes** — Stock Count (every item, both layouts)
   and the purchase bill's Qty and Rate.
3. **Light-preset AA failures cluster on three causes** — `--theme-text3` on status-tinted rows
   (4.29–4.35:1, ~190 labels across four pages), Dead Stock's `opacity: 0.85` rows (3.66:1, 90 labels),
   and two dimmed or hand-rolled labels.

Recommended next steps: `/impeccable adapt` on the six phone clips (all inline-layout fixes, mostly one
line each), then `/impeccable harden` for the grid labels and the one remaining hand-rolled dialog, then
`/impeccable colorize` for the Light tinted-row pattern.

## Detailed Findings by Severity

### P1 — Major

**[P1] Controls and content clipped off-screen on a phone, on six pages**
- **Location** (measured at 390×844, touch):
  - `/purchases/new` — `purchases/PurchaseBillForm.jsx:543`, header grid
    `gridTemplateColumns: '2fr 1fr 1.4fr auto 90px 1fr'`: **Discount (NPR)** and **Payment
    (Cash / Credit / FonePay)** end 33px and 99px past the viewport.
  - `/sales` — `sales/Sales.js:1247`, the tab row is `display: flex; justify-content: space-between`
    with no wrap: the **Only items with sales** toggle sits at 458–602px and the **Search menu item**
    box at 610–780px, and the last tab is half cut.
  - `/recipes` — `recipes/Recipes.js` toolbar row (`display: flex, gap: 20`, no wrap) with a
    `width: 260` search box at `:1581`: **Find ingredient in recipes** ends 556px past the edge.
  - `/best-sellers` — `reports/BestSellers.js:368`, `gridTemplateColumns: '1fr 1fr'`: the tables' min
    content holds both tracks wide, and the **Bottom 10 Performers** card starts off-screen (+290px).
  - `/menu-pricing` — `recipes/MenuPricing.js:585` and `:943` (both branches) and `/ims/staff` —
    `staff/ImsStaff.jsx:514`: the header action group carries inline `flexShrink: 0`, which defeats
    `.page-header--split > * { min-width: 0; flex-wrap: wrap }`; **+ Add Item** (+132px) and
    **+ Add Staff** (+126px) are wholly past the edge.
- **Category:** Responsive
- **Impact:** `.main-content` is `overflow-x: hidden`, so none of this scrolls into view — it simply is
  not there. On a phone a credit bill cannot be marked Credit — it saves as the default `'Cash'`
  (`PurchaseBillForm.jsx:26`), so it never reaches Outstanding Payables — Sales Entry cannot be
  searched, and a new menu item or staff login cannot be added. S613 settled that the phone is a supported surface.
- **Standard:** WCAG 1.4.10 Reflow (AA).
- **Recommendation:** Move each layout into a class with a breakpoint (the S613 rule: a fixed track
  count belongs in CSS, never inline). For the header groups, delete `flexShrink: 0` — the class
  already does the right thing. Give the Sales and Recipes rows `flex-wrap: wrap` and let the search
  box go `width: 100%` below 600px. Stack Best Sellers' two cards under ~900px.
- **Suggested command:** `/impeccable adapt`

**[P1] Unnamed quantity inputs in Stock Count and the purchase bill**
- **Location:** `stockcount/Stock.js:2540` (phone card) and `:2625` (table), the per-item `QtyInput` on
  every count tab; `purchases/PurchaseBillForm.jsx:695` (line Qty) and `:703` (line Rate).
- **Category:** Accessibility
- **Impact:** measured **322 unnamed inputs** on CASA ACAI CAFE's Stock Count page, and two per line on
  a bill. A screen reader announces "edit text, 34" with no item, field or unit, on the page a month is
  closed from and on the page that writes money. These are the only unnamed inputs left in the module —
  a scan of every `<QtyInput>` and `<input>` in IMS found none others.
- **Standard:** WCAG 4.1.2 Name, Role, Value and 1.3.1 (Level A).
- **Recommendation:** `QtyInput` already forwards `...rest`, so a template `aria-label` fixes each site:
  `` `${FIELD_LABEL[fieldKey]} for ${item.name}` `` on Stock Count, `` `Quantity for ${itemName || 'line ' + n}` ``
  and `` `Rate for …` `` on the bill (the S576 template-label rule).
- **Suggested command:** `/impeccable harden`

**[P1] Light-preset contrast failures from three causes**
- **Location** (measured on Modernist Light @1280; Night passes everywhere):
  - `--theme-text3` 11px secondary lines (item codes, dates, "5 items", "Entered") on rows tinted
    `color-mix(in srgb, var(--theme-red) 3%, transparent)`: **4.35:1** on `/reorder` (51 labels),
    `/supplier-prices` (43), `/stock-report` (26); **4.29:1** on `/purchases` (70). Light text3 clears
    the bare card at 4.54:1, so any row tint takes it under.
  - `stockcount/DeadStock.js:495` — `opacity: r.status === 'Dead' ? 1 : 0.85` on the whole row:
    **3.66:1**, 90 labels. DESIGN.md: "Don't dim a row with `opacity`".
  - `purchases/Purchases.js:768` — "incl. VAT" sub-label at `opacity: 0.75`: **3.24:1**.
  - `reports/BudgetVsActual.js:306, :332` — hand-rolled "No Budget" chip (text2 on a 15% text2 tint):
    **4.41:1**; `reports/StockAgeing.js:541` — `badge-gray` "count+" on a tinted row: **4.19:1**.
- **Category:** Accessibility / Theming
- **Impact:** secondary text on exactly the rows the page has flagged, which are the rows a reader is
  meant to look at, on the preset an office user is most likely to choose.
- **Standard:** WCAG 1.4.3 Contrast (Minimum), AA.
- **Recommendation:** on a tinted row, secondary text takes `--theme-text2`. One rule
  (a `tr[data-tint] .cell-sub` or a `.row-flagged` class) covers all four tables better than per-cell
  edits. Replace Dead Stock's row opacity with a label or weight change (the S613 rule), drop the
  "incl. VAT" opacity for `--theme-text3`, and use `badge badge-gray` for "No Budget".
- **Suggested command:** `/impeccable colorize`

### P2 — Minor

**[P2] The rate-change prompt is the last hand-rolled overlay in IMS**
- **Location:** `purchases/PurchaseBillPage.jsx:419` — "📦 Rate changes detected".
- **Category:** Accessibility / Integrity
- **Impact:** it asks whether to rewrite Item Master prices, which moves every later stock valuation,
  and it has no `role="dialog"`, no `aria-modal`, no focus move or trap, no Escape and no focus return.
  A keyboard or screen-reader user is left on the page behind it. Its scrim is a frozen
  `rgba(0,0,0,0.72)` where `Modal`'s tokenised one belongs.
- **Recommendation:** render it in `Modal` (a decision dialog earns the scrim); keep the `ActionError`
  and the two buttons as they are.
- **Suggested command:** `/impeccable harden`

**[P2] Sub-recipe drill-in is mouse-only**
- **Location:** `recipes/Recipes.js:2607–2610` — the ingredient cell in a dish's cost breakdown is
  `<td onClick={drillIntoSubRecipe}>` with no control inside.
- **Category:** Accessibility
- **Impact:** a keyboard user cannot open a sub-recipe's own cost breakdown from the dish that uses it
  (they can reach it from the list, losing the context). The baseline's four other row drills were all
  fixed; this one predates them and was missed.
- **Standard:** WCAG 2.1.1 Keyboard (A).
- **Recommendation:** a `.btn-linklike` button around the name inside the cell, as `AssetRegisterTab`
  does.
- **Suggested command:** `/impeccable harden`

**[P2] `PeriodScope` cannot wrap, so a long scope is clipped on a phone**
- **Location:** `src/components/Layout.css:1298` (`.period-scope { white-space: nowrap }`, no max width);
  measured on `/stock-ageing` at 390px, where "12 months to Ashwin 2083 · as at …" runs 26px past the edge.
- **Category:** Responsive
- **Impact:** the chip exists to state the one fact a reader verifies before trusting any figure, and
  the as-of date is the part that gets cut.
- **Recommendation:** `max-width: 100%` with wrapping allowed on `.period-scope-label` (or ellipsis plus
  a `title`). It is shared, so one edit covers every report.
- **Suggested command:** `/impeccable adapt`

### P3 — Polish

- **[P3] Touch targets under 24px** — Menu Pricing's `.th-sort` headers measure 12px tall under a coarse
  pointer (`.th-sort` is missing from the `pointer: coarse` block); `stockcount/ReorderReport.js:680–686`
  is a 16px-tall `role="button"` span that navigates, so it should be a `<Link>`. WCAG 2.5.8. `/impeccable adapt`
- **[P3] `ReportLoadError` gets `error.message`, not the error** — ~20 loaders (`AnnualSummary:73`,
  `BestSellers:82`, `MonthlySummary:54`, `NonVatReport:47`, `Overheads:156/189/319`, `PaymentReport:55`,
  `PeriodComparison:133`, `SupplierContribution:89`, `VatReport:54`, `DeadStock:80`,
  `StockMovements:84/147`, `WastageReport:42`, `MenuRepricing:57`, `RecipeMargin:52`, `Recipes:224`,
  `PurchaseOrders:146`). The card converts either form, but the string drops `code`, so the code-only
  rules (a function or column that is not there yet, a CHECK violation) cannot match and the fine print
  loses the code. `error-messages.md`: pass the object. `/impeccable clarify`
- **[P3] Heading outline skips h1→h3** on `/summary`, `/overheads`, `/best-sellers`, `/vat-report`,
  `/non-vat-report`, `/period-comparison` (carried from 2026-09-05). `/impeccable polish`
- **[P3] Two private chart palettes** — `reports/PeriodComparison.js:41` `FALLBACK_HEX` and
  `reports/VendorReport.js:45` `VENDOR_SPLIT_COLORS` are the same eight hues, including the undocumented
  `#60a5fa`/`#8b5cf6`, never run through `validate_palette.js` (carried). `/impeccable colorize`
- **[P3] A ledger defined twice** — `reports/VendorReport.js:29` `billAging` is a byte-identical copy
  of `aging()` exported from `purchases/purchasesHelpers.js:249`. One import. `/impeccable polish`
- **[P3] Dead fallbacks** — `reports/OutstandingPayables.js:59–62` names `--theme-text` (no such token)
  and falls `--theme-border` back to itself. Harmless today; reads as meaningful. `/impeccable polish`
- **[P3] 9px chart labels** — `recipes/MenuEngineering.js:600` and `reports/PeriodComparison.js:672–673`
  set Recharts label text at 9px, under the 10px text floor. `/impeccable typeset`

## Patterns & Systemic Issues

- **Inline layout beats the classes that were written to prevent exactly this.** All six phone clips are
  one of three inline shapes: a pinned grid track list, a flex row with no wrap, or `flexShrink: 0` on
  an action group. The tell for the next sweep is the same grep that found them:
  `gridTemplateColumns: '` with a fixed track list outside a print template, and `flexShrink: 0` inside
  a `page-header--split`.
- **`--theme-text3` has almost no headroom on Light** (4.54:1 on the card). Any tint under it — a
  flagged row, a hover, a selected state — fails. Either secondary text moves to `text2` on tinted
  surfaces as a rule, or text3 needs a token-level decision (and DESIGN.md records why the next ramp
  step is not available).
- **The label sweep held everywhere except the two grids built from `QtyInput`** — the component that
  forwards an `id` so a `<label>` can reach it, used here in cells that have no `<label>`.

## Positive Findings

- **The dropped-error class is closed.** Zero reads without `error` and zero bare writes across 111
  files, down from the baseline's P1s in Stock Count, Purchases, Recipes and the asset tabs.
- **Every overlapping-load finding is closed**: all 13 named pages guard with `useLatestRequest`.
- **Every destructive confirm is a real dialog**: `window.confirm` 11 → 0; Menu Pricing's four and IMS
  Staff's three overlays are on `Modal`.
- **Every row drill the baseline named has a keyboard path** — `RowDisclosure` or `.btn-linklike` in a
  cell, with a comment citing the S595/S653 rule so the next editor does not undo it.
- **Night is clean**: zero text-contrast failures on all 43 routes.
- **Touch floors hold**: zero fields under 16px under a coarse pointer on all 43 routes, even on
  inline-styled inputs (the `!important` floor works as designed).
- **Names are complete outside the two grids**: zero unnamed controls on 40 of 43 routes, every
  `<select>` named.
- **Performance stays lean**: no static `xlsx`, `recharts` only where it renders, images only in one
  edit field and a QR code, and the S793 one-request recipe book in place.

## Observations outside the score

- **Migration `20260908120000` (demand forecast `sample_count`) is not applied to the live database.**
  `/demand-forecast` logs a 400 on its first insert, retries without the two columns (the designed
  fallback) and omits the evidence small print. Opening that page recomputes and writes the forecast,
  so this sweep's visit did so, exactly as any visit does.
- Five reports (FIFO, Stock Ageing, Stock Report, Reorder, Demand Forecast) took more than 10 seconds to
  settle in the dev build. The dev build double-runs effects under StrictMode and is unminified, so this
  is not a measurement; re-run the S793 throttled harness if an owner reports it.

## Recommended Actions

1. **[P1] `/impeccable adapt`** — the six phone clips (bill header, Sales tab row, Recipes toolbar, Best
   Sellers grid, the three `flexShrink: 0` headers), plus the `PeriodScope` wrap and the P3 touch
   targets.
2. **[P1] `/impeccable harden`** — template `aria-label`s on the four `QtyInput` sites; the rate-change
   prompt onto `Modal`; the sub-recipe drill as a button.
3. **[P1] `/impeccable colorize`** — text3-on-tint to text2, Dead Stock's row opacity, the "incl. VAT"
   opacity, the "No Budget" chip; then fold the two private chart palettes into one validated set.
4. **[P3] `/impeccable clarify`** — pass error objects, not `.message`, to `ReportLoadError`.
5. **[P3] `/impeccable polish`** — heading levels, the duplicated `aging`, the dead fallbacks, the 9px
   chart labels.
