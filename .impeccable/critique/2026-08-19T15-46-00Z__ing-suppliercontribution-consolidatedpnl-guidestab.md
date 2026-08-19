---
target: newly created pages from last Monday
total_score: 26
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 3
timestamp: 2026-08-19T15-46-00Z
slug: ing-suppliercontribution-consolidatedpnl-guidestab
---
Method: dual-agent (A: a165852596385f49f · B: a5a84aa7812464905)

# Critique — pages created since Monday 2026-08-17

Scope (git-resolved): StockAgeing.js + stockAgeingCalc.js (/stock-ageing, IMS Pro, supervisor);
SupplierContribution.js + supplierAttribution.js (/supplier-contribution, IMS Pro, manager);
ConsolidatedPnl.jsx (/pnl, Suite Pro via SuiteGate); GuidesTab.jsx + hr/posGuideData (admin
Settings → Guides, Read mode); the new "Product Type Wise" view in POS SalesReport.jsx.

## Design Health Score — 26/40

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 2 | KPI strips render above the `loading` guard — four confident zeros paint during a multi-second FY read (StockAgeing.js:227-258 vs guard at :286). No role="status" on any of four loaders |
| 2 | Match System / Real World | 3 | Excellent plain-language caveats; deducted for bare Δ and pp (SupplierContribution.js:292, :321) |
| 3 | User Control and Freedom | 3 | No URL state on any of the three; `expanded` is a single id so two suppliers never compare |
| 4 | Consistency and Standards | 2 | Three siblings each invented their own empty state, totals row, export-disabled rule. `.data-table tfoot` has no rule in Layout.css |
| 5 | Error Prevention | 3 | Closed-period default, named-not-dropped labour bucket. Deducted for the as-of problem |
| 6 | Recognition Rather Than Recall | 3 | Stock Ageing band columns are quantity in tbody, value in tfoot; the disambiguation is below the table and no-print |
| 7 | Flexibility and Efficiency | 2 | No column sorting. "+ N more" truncates at 12 with no path to the rest, in UI or export |
| 8 | Aesthetic and Minimalist Design | 3 | Restrained; Stock Ageing accumulates 4 cards + 5 band buttons + 2 selects + 2 buttons + 6-line callout above one table |
| 9 | Error Recovery | 1 | Both IMS pages discard every query error. A failed read renders as a finished report of zeros |
| 10 | Help and Documentation | 4 | All three in Help.js, all use NoPeriodState, all carry on-page caveat prose |
| **Total** | | **26/40** | Competent, with one trust-critical hole |

No heuristic scored n/a.

## Design Specificity Verdict

Authored for Crest — the evidence is prose, not composition. The pages inherit incumbent report
grammar exactly (matching FifoReport.js:185-247 beat for beat), which is correct for Operate mode.
What no template ships is the on-screen reasoning: SupplierContribution.js:1-16 argues that `items`
has no vendor column so a supplier share is derived, and renames the page to the question it can
answer; ConsolidatedPnl.jsx:41-60 declares LINES once feeding table, matrix and export; the Product
Type axis suppresses itself when it could only produce one row (SalesReport.jsx:305-311).
ConsolidatedPnl breaks the grammar by dropping the KPI strip — defensible for a formal statement,
but Net Profit is the ninth row of a 13px table.

Deterministic scan: detect.mjs --json returned **0 findings across all 9 target files**, with and
without project config. Positive control: --json src/ returns 34 findings in 10 other files, so the
detector is live. All eight pass/fail greps clean — 5 selects named, 3 labels htmlFor, zero broken
`${x}22` tints, zero badge-gold, zero top-level XLSX import, all 14 transaction reads
fetchAllRows-wrapped with .order('id') tiebreakers, 15 tables in 15 table-wraps, no Fab. Gate
triples in sync.

The notable result: the token/structural layer is clean, and every real defect sits in a layer no
detector covers — error handling, state honesty, report grammar.

Visual overlays: not available. A dev server was already up on :3000 but all four pages sit behind
a real Supabase login plus Pro/Suite gates. No injection attempted; no overlay exists.

## Overall Impression

Substantively better than codebase average, procedurally worse in one place. The domain thinking is
the best in the repo. Design-system compliance is perfect by every automated measure. And two of
three pages will show an accountant a page of zeros when the database says no.
ConsolidatedPnl.jsx:135-141 already contains the fix with the reasoning spelled out; it did not
travel 200 lines.

## What's Working

1. **LINES as one declaration driving three renderers** (ConsolidatedPnl.jsx:41-60) — the drift
   failure mode this codebase has paid for, fixed preventively. The exported .xlsx carries the same
   line names the accountant read on screen.
2. **The Product Type control is textbook** (SalesReport.jsx:1041-1052) — a span.field-label, not a
   label, over a .tab-bar with role="group" + aria-labelledby and aria-pressed. S576's rule applied
   verbatim in a module that had 52 bare labels a week ago.
3. **Naming what cannot be attributed** (supplierAttribution.js:20-24, the Not Attributed KPI) — the
   S567 lesson internalised as a design principle. StockAgeing's c/f badge is the same instinct.

## Priority Issues

### [P0] Query errors are discarded — a failed read renders as a confident report of zeros

`grep -n "error"` returns ZERO matches in StockAgeing.js and one comment in SupplierContribution.js.
Every read destructures `{ data }` and drops `error`: StockAgeing.js:42-45, :72-95, :93;
SupplierContribution.js:53, :74-92. Results flow through `|| []`. ConsolidatedPnl does the same on
its single-outlet path (:169-186) while its group path checks correctly.

Why: RLS rejection, network blip, PostgREST schema-cache miss, or the documented auth-token stall all
produce `data:null, error:{...}`. The page renders NPR 0 across the board — identical to a genuinely
quiet period. Strictly worse than a crash: a crash gets reported, a zero gets believed. Neither page
renders an error element at all.

Fix: collect from Promise.all, `find(r => r.error)`, short-circuit with setLoadError before rendering;
render as ConsolidatedPnl.jsx:337 does (role="alert", --theme-red-text) IN PLACE OF the KPI strip.
Command: /impeccable harden

### [P1] Stock Ageing never states its as-of date, and ages every past FY against today

StockAgeing.js:161 is `buildAgeing(batches, consumed, new Date())`; the FY selector (:220-223) accepts
any past year. Selecting FY 2081/82 ages every surviving batch to today — every item lands in 90+
days, the headline KPI turns amber and reports the entire stock value, the row highlight fires on
every row. No as-of in subtitle, print title, or exported workbook.

Why: an ageing schedule without an as-of date is the first thing an accountant checks. Wrong in a
specific direction for any non-current FY, and it fails in the alarming direction. The .xlsx has an
"Oldest (days)" column and no reference date.

Fix: (a) "FY X · aged as of {todayBs}" in the subtitle; (b) for a non-current FY age against that
FY's last period end and say so; (c) stamp the as-of into exportExcel (:197) and printWithTitle.
Command: /impeccable harden

### [P1] The Consolidated column paints every cost line success-green

ConsolidatedPnl.jsx:379-382 calls `lineColor({ ...l, strong: true }, ...)`. lineColor (:81-84) tests
`strong && amount > 0` BEFORE `line.cost`, so every positive consolidated figure is green — COGS,
Wastage, Staff Meals, Labour, Overheads, Tax & Fees. With fmtLine a cost renders as
`(NPR 1,240,000)` in success-green. The identical line is --theme-text2 grey in the single-outlet
table.

Why: DESIGN.md is unambiguous that green means success/healthy. The only page in the product where
the same line is grey in one column and green beside it — on the page a multi-outlet owner uses to
compare branches. To an accountant, parenthesised-and-green reads as a credit.

Fix: `color: lineColor(l, consolidated[l.key])` — drop the spread. The cell already sets fontWeight 700.
Command: /impeccable polish

### [P1] Supplier Contribution shows two totals that reconcile with neither each other nor their own percentages

(1) KPI reads `totals.attributed` = total − unattributed (:168, rendered :231); the table TOTAL
"Cost of Sales" reads `totals.consumed` = total, INCLUDING unattributed (:373). Same words, same
units, 200px apart, nothing saying they differ. (2) purchasedPct's denominator is purchaseTotal
(:143-144), which filters v > 0, while the footer's Net Purchases is purchaseGrandTotal (:177),
which sums negatives. A vendor whose returns exceeded that period's purchases makes % of Purchases
sum past 100 while the footer asserts a hardcoded 100.0% (:376).

Why: this is the compliance persona's page. Vendor rows tie exactly (supplierAttribution.js:15-19
guarantees it), then the total doesn't, then the page stops being trusted. A hardcoded 100.0% that
can be false forecloses the check.

Fix: label them apart (KPI "Attributed Cost of Sales", footer "TOTAL (incl. not attributed)");
replace the literal 100.0% with `pct(purchaseGrandTotal, purchaseTotal)`.
Command: /impeccable clarify

### [P2] Guides: amber body text at 2.05:1, and a tablist with no panel

(1) ModuleGuideTab.jsx:159 renders the entire "Watch out for" list in `var(--theme-amber)` — base
token, not --theme-amber-text. DESIGN.md measures 2.05:1 on Rosé Dawn, 2.15:1 on Latte. :103's route
chip repeats it: `var(--theme-accent)` (should be --theme-accent-ink) on rgba(0,0,0,0.15).
(2) GuidesTab.jsx:36-47 declares role="tablist"/"tab"/aria-selected with no aria-controls, no
id/role="tabpanel" on the panel, no roving tabIndex or arrow keys. ModuleGuideTab.jsx has exactly one
a11y attribute in the whole file.

Why: the gotchas are the highest-value content in a 1,000-line reference and the least legible text
on 2 of 10 presets. Incomplete ARIA is worse than none. Admin surface — never generates a client bug
report. Note the detector was silent: ModuleGuideTab.jsx is not in the changed-file set, exactly the
S521 "hook only fires on touched files" gap.

Fix: --theme-amber-text at :159; --theme-accent-ink on a color-mix() chip at :103; add
id/aria-controls/role="tabpanel", roving tabindex, arrow handler. Also borderRadius: 6 (:54,:80,:146)
is off the closed 4/8/12/18/24/999 set and fontSize 13.5/12.5/17 is off the closed type scale.
Command: /impeccable audit

### [P2] Cross-cutting consistency drift (invisible to the detector — it governs colour and shape, not report grammar)

- Empty state: .empty-state + icon (StockAgeing.js:289-296) vs bare `<p>` (SupplierContribution.js:274, ConsolidatedPnl.jsx:344)
- Export-disabled-when-empty: yes, yes, NO (SupplierContribution.js:212 downloads a headers-only workbook)
- Totals row: inline fontWeight 700 vs a 2px borderTop. `.data-table tfoot` has NO rule in Layout.css
- Tabular figures: ConsolidatedPnl.jsx sets fontVariantNumeric tabular-nums; a repo-wide grep finds
  ZERO other occurrences. Poppins' default figures are proportional, so every currency column in the
  other two pages and all 11 SalesReport tabs has ragged digits. Belongs in .data-table td
- Accent tint hardcoded: StockAgeing.js:260 literal rgba(201,168,76,…) for a callout whose own
  `<strong>` is var(--theme-accent-ink). ConsolidatedPnl.jsx:293 does the identical job with color-mix()
- Excel letterhead: SalesReport's withLetterhead stamps company/VAT/date range; none of the three new
  exports do — bare json_to_sheet

## Persona Red Flags

**Nepali restaurant owner, scanning between rushes.** Reads "Capital in 90+ Day Stock: NPR 0" in green
during the load and moves on. Opens /pnl to answer "did I make money" and must read to the ninth row of
a 13px table; Stock Ageing gives four stat cards for a secondary question, the P&L none for the primary.
Δ and pp as bare notation behind a hover. An 11-button tab bar where Product Type sits between Category
Wise and Item Wise with nothing indicating which answers which question.

**Accountant verifying an exact figure.** Every read on both IMS pages presents a failed query as a real
zero. Two "cost of sales" totals differing by the unattributed amount. A hardcoded 100.0% above a column
that doesn't always sum to 100. The same header carrying quantity in tbody and value in tfoot, with the
disambiguation marked no-print. An exported ageing schedule with "Oldest (days)" and no as-of date.

**Keyboard and screen-reader users.** SupplierContribution.js:303-305 — the expandable row is a bare
`<tr onClick>`. No tabIndex, role="button", onKeyDown, or aria-expanded; the triangle is a decorative
span. The page's only interaction is unreachable without a mouse. GuidesTab tablist with no panel. All
four loading indicators are bare `<p>` — exactly one live region exists across all nine files.

**Multi-outlet Suite Pro owner.** Every cost line green in the Consolidated column. The "Line" column
isn't sticky inside .table-wrap, so with 5 outlets scrolling right to Consolidated scrolls the row labels
off screen. The excluded-outlets disclosure (:392-396) is the one sentence establishing coverage of every
figure above it, and it's the quietest text on the page.

## Minor Observations

- StockAgeing.js:318 — stale-row highlight is 4% amber, below perceptual threshold on dark presets
- StockAgeing.js:268 — filter bar is no-print, so a printed sheet has no record of which filters produced it
- SupplierContribution.js:339/:357 — "+ 14 more" is a dead end in UI and export (:181-189 exports the count)
- StockAgeing.js:38 / SupplierContribution.js:49 use useEffect([clientId]) with an inner authLoading guard.
  ConsolidatedPnl.jsx:107-110 adds authLoading to deps and documents why ("the page sits on Loading… forever").
  Found this week, not backported to two siblings written the same week
- SalesReport.jsx:728-729 — Recharts `<Tooltip contentStyle/labelStyle/itemStyle>` uses dark-preset literals.
  NOT the SVG-attribute exception: that tooltip is an HTML div, so var() would resolve. Stays dark on the
  5 light presets. Pre-existing (2026-07-04)
- SalesReport.jsx:717 — MUTED (#6b7280, the documented chart-tick token) used as chrome text. S540 role
  mismatch; pre-existing
- The new Product Type table has 10 th and 0 in-table Tips — byte-identical to its Category Wise sibling
- hrGuideData.js:31's status vs access_blocked entry is the clearest statement of that trap in the repo,
  CLAUDE.md included

## Questions to Consider

1. Stock Ageing's thesis is "this is cash sitting on a shelf" — so why does it link nowhere? All four
   exits exist (Wastage, Reorder, Menu Engineering, Vendor Returns). Is this Operate mode, or Read mode
   wearing Operate's clothes?
2. Three pages in three days each invented their own empty state, totals row, and error behaviour. The
   design system governs colour and shape rigorously; this product consists almost entirely of report
   grammar, which it doesn't govern. Should there be a `<ReportPage>` shell owning header, KPI strip,
   loading, empty, error and totals — the way NoPeriodState already owns one of those six?
3. The error-handling reasoning is written down, in this repo, in a file touched the same week, and it
   didn't travel 200 lines. Reading errors have cost nothing yet, so the rule is nowhere — meaning the
   first time it costs, it costs as a wrong number someone filed.
4. The Sales Report tab bar is at 11 and Product Type made it so. Those eleven are three questions wearing
   eleven labels: what sold / who bought / what happened to the money. Twelfth tab, or three pages?
