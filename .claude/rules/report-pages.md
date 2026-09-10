---
paths:
  - "src/components/ReportPage.jsx"
  - "src/components/ReportLoadError.jsx"
  - "src/components/RowDisclosure.jsx"
  - "src/shared/queryError.js"
  - "src/shared/errorText.js"
  - "src/shared/excelLetterhead.js"
  - "src/shared/hooks/useBizInfo.js"
  - "src/modules/ims/reports/**"
  # Reports also live in these two, which is half of why S616 found three drifted pages here:
  # DeadStock/StockReport/ReorderReport/StockMovements/DemandForecast are reports in stockcount/,
  # MenuRepricing/RecipeMargin/MenuEngineering are reports in recipes/. This file never loaded for them.
  - "src/modules/ims/stockcount/**"
  - "src/modules/ims/recipes/**"
  # Added S726 — the same omission as the two above, one directory further on. Variance,
  # TheoreticalVariance, ShrinkageReport and WastageReport are all report pages: they carry
  # `firstError`, `ReportLoadError`, `useLatestRequest` and an Excel letterhead, which is this
  # file's entire subject, and it loaded for none of them.
  - "src/modules/ims/variance/**"
  - "src/modules/pos/reports/**"
  - "src/modules/hr/reports/**"
  - "src/pages/dashboard/**"
---

# Report pages: the six states, and never showing an uncomputed number

> Moved out of the root CLAUDE.md (2026-08-27 /doctor pass) so it loads only when working on
> these files. Root CLAUDE.md keeps the universal invariants.

### A report page must not show a number it has not computed (S594)

`src/components/ReportPage.jsx` exists because the design system governs colour and shape rigorously
and governs **report grammar** — which is what this product almost entirely consists of — not at all.
Three report pages shipped in three days and each invented its own answer to the same two questions:
empty result was `.empty-state` + icon on one and a bare `<p>` on the other two; the totals row was
an inline `fontWeight: 700` on two and a 2px border on the third; and two of the three had **no error
branch at all**. The `/impeccable` detector reported **zero findings** across all of it — the token
layer was perfect — which is the point: a detector that checks colour and shape cannot see this.

Three rules came out of it:

- **This rule is not confined to report pages, and the `paths:` list above is why it keeps being
  re-found (S631).** `EmployeeList.jsx` — an ordinary CRUD screen this file never loads for — held
  the same shape twice: `const { data } = …` then `data || []`, on the employee roster *and* on
  `get_hr_self_service_status`. The roster one also wrote the empty result to the page cache, so the
  lie outlived the failed request. Consequences were the report-page kind exactly: a failed read
  rendered as "this client has no employees", and unknown self-service status rendered as "nobody has
  a login" — offering **Enable Self-Service** to an employee who already had one. When you touch any
  page that reads and renders, apply this whether or not the page calls itself a report.

- **A failed read is not an empty period, and it must never render as one.** Every read on the two
  new IMS report pages destructured `{ data }` and dropped `error`, then ran the result through
  `|| []`. An RLS rejection, a network blip, a PostgREST schema-cache miss or the documented
  auth-token stall all produce `data: null, error: {...}` — so the page rendered a complete,
  confident report of NPR 0, visually identical to a genuinely quiet month. That is strictly worse
  than a crash: a crash gets reported, a zero gets believed, and this product is sold on an
  accountant trusting the figure. `firstError(results)` (`src/shared/queryError.js`) is the one
  place a `Promise.all` batch is checked; capture the array instead of destructuring straight
  through. `ConsolidatedPnl`'s group path already had both the check and the sentence for it
  (*"'nothing to show' and 'could not load' are different facts, and only one of them should send
  someone to billing"*) and it had not travelled 200 lines to its own siblings. **Swept
  product-wide in S612 (2026-08-26, measured: 37 files now import firstError/ReportLoadError):**
  every report-class page in IMS/HR/POS — statutory, snapshot computes, variance, stockcount,
  recipes, vendor/payables, POS reports, HR filing sheets — now refuses to render a figure it has
  not computed. `ReportLoadError` (`src/components/ReportLoadError.jsx`, extracted from
  `ReportPage`'s error branch) is the shared error card for pages that predate the `ReportPage`
  shell; `throwFirstError()` is the throwing form for compute helpers running inside a try/catch
  harness (the Monthly Owner Report's `runSection`). Two corollaries the sweep enforced: a failed
  periods read must not wear `NoPeriodState` ("no periods yet" is a claim about the client), and
  on a data-entry page (Overheads) a failed read must block the form outright — saving over rows
  the page could not read is a data-loss shape, not a display bug. A new report page copies this
  from any sibling; there is no unswept example left to copy. (That claim needed one more
  correction: S656 found the two IMS pages that are operational rather than report-shaped —
  `Purchases.js`, which also CACHED the empty result via sessionDataCache so the lie outlived the
  failed request, and `Requisitions.js`, whose `getOnHandMap` fed the over-issue guard from nine
  unchecked reads. Both now follow the Overheads pattern. The S631 lesson stands: a sweep framed
  as "report pages" keeps missing the CRUD/entry pages that read and render the same way. And
  S695 found the worst one still standing: `Stock.js`, the page a month is closed from, dropped
  every read error, rendered every cell blank, and its Save All then DELETED the server's real rows
  for every visible item — the batch-save shape as data loss rather than display. It now renders
  `ReportLoadError` and nothing below it. The rule for an entry page is Overheads' and Stock's:
  a failed read blocks the form, it never shows an empty one.) **S699 found the next shape after
  that one, on a page that had already been swept: `Sales.js` guarded its SALES reads and not the
  MENU.** `init()` dropped the error on both its reads, and the recipe list is what both payload
  builders iterate — so a failed recipes read rendered "No active recipes" above a live Save
  button, built an EMPTY payload, and `save_sales_day` reads an empty payload as "delete this day's
  manual rows and insert nothing". The guard to write is therefore not "did the figures load" but
  **did every read the SAVE depends on load** — which on a merge-and-replace page includes the list
  the payload iterates, not only the values it merges. Its Save/Clear/Import controls are disabled
  on an empty list too, since they sit above the empty state and were reachable either way. Same
  pass: that page's `loadError` was ONE slot written by five loaders, two of them concurrent, so
  the loader that SUCCEEDED cleared the one that FAILED — **a shared error slot with concurrent
  writers is a guard that switches itself off.** It is a per-loader record now, resolved per tab,
  so a failed read on one tab also stops blanking the other three.
- **Refusing to render the figure is half the job; the sentence you show instead is the other half
  (S619).** `firstError`/`ReportLoadError` decide *that* something failed. `errorText(err,
  'operator')` (`src/shared/errorText.js`) decides what the reader is told — one table, two
  audiences, and no message that claims a failed write did not land. Before S619 the only such
  table lived inside HR Self-Service and no IMS or POS screen could reach it, so a dead connection
  reached an Owner as a bare `TypeError: Failed to fetch`. Pass the error object through it rather
  than `error.message`, and keep `detail` as fine print. (Since S682 `ReportLoadError` runs that
  conversion itself on whatever it is handed — the product-wide audit found all ~70 callers still
  passing the raw string — so a report page gets the sentence for free; pass the object anyway so
  the code reaches the detail line.) **Since S658 `ActionError` renders that
  pair for you** (`src/components/ActionError.jsx` + `asActionError`) — the third channel beside
  `FieldError` (one control) and `ReportLoadError` (a whole failed read), for the button just
  pressed. Convert at the call site, and name the CONSEQUENCE before the cause: on the two-write
  sequences this replaced, the first write had already committed, so what the reader needed was
  which state the record is in now, not the constraint that rejected the second one.
- **A dropped WRITE error is silent data loss, and a guard that drops its READ error passes
  vacuously (S613).** The silent-zero rule above is about rendering; these are its two write-side
  twins, and both shipped. **Write:** `Roster.jsx` painted the shift optimistically and dropped the
  upsert's error, so the board showed as saved what the database had refused; `Periods.js` closed a
  month and dropped the next period's INSERT error, silently blocking the client from recording
  anything with no explanation on screen; `PosTableManagement`'s four settings saves fell through to
  INSERT when the existing-row read failed, which splits a client's settings row in two and quietly
  changes what every later settings read returns. An optimistic UI **must** reconcile against the
  failure and say so. **Guard:** `FinalSettlement`'s three finalize gates swallowed their reads, so a
  failed `hr_payslips` read meant "no payroll covers this month" — the gate passing vacuously on
  exactly the double-payment it exists to prevent. **A check that could not run has not passed**:
  refuse and say why, never wave through. Ask of any new guard, "what does this do when its own read
  fails?" — if the answer is "allows the action", it is not a guard.
- **A page can be the reference for the read half and still have no write half at all (S716).**
  `Overheads.js` is cited three times in this file as the pattern an entry page copies for a failed
  READ — and its `save()` was a `scopedDelete` then a `scopedInsert` with neither error
  destructured, ninety lines below a comment reading *"on a data-entry page the silent-zero class
  is a data-loss class"*. Delete lands, insert fails, the period is empty, `loadOverheads()` finds
  nothing, falls into the carry-forward branch, and seeds the PREVIOUS month's figures as an
  editable draft — so the owner saw plausible numbers under a "✓ Saved" tick over data that no
  longer existed. Three things generalise. **Order the two writes so the one that can refuse goes
  first**, and its failure is then a clean no-op the message may say so about. **The recovery path
  is part of the message**: after the failed insert the rows in React state are the only surviving
  copy, so the handler must NOT reload — the reload is what destroys them — and the copy has to
  say "press Save again, do not reload the page first". And **being the named exemplar of a rule is
  not evidence of following its siblings**: S658, whose subject line was *"a failed write stops
  reading as a no-op"*, edited line 242 of this exact function to reword an `alert()` and left 244
  and 257 bare. When a page is cited as a pattern, check the half it is not cited for.
- **The KPI strip does not render while loading or after a failure.** Both pages painted four stat
  cards *above* their `loading` guard, so a multi-second fiscal-year read showed "Capital in 90+ Day
  Stock: NPR 0" in green until the real number arrived — and on a failed read it stayed there. A
  number the page has not computed yet is not a number. `ReportPage` gates `stats`/`note`/`filters`/
  `footnote` on `!loading && !error` so a new page cannot reintroduce this.
- **A report that states a scope must state it everywhere the report goes.** `StockAgeing` aged every
  fiscal year against `new Date()` while its FY selector accepted any past year, so picking a past FY
  pushed every surviving batch into the 90+ band, turned the headline amber and reported the whole
  stock value as stale — failing silently, in the alarming direction. It had no as-of date in the
  subtitle, the print title *or* the workbook. Related: the filter bar is `no-print`, so a printed
  sheet showed a filtered table with no record of the filter. Both are now one `scopeLine` used by
  the page, the print header, a `.print-only` line and the Excel letterhead.

`sheetWithLetterhead()` (`src/shared/excelLetterhead.js`) + `useBizInfo()`
(`src/shared/hooks/useBizInfo.js`) are the same consolidation for exports: three hand-written copies
of the letterhead already existed (`SalesReport.jsx`, `CoversReport.jsx`, `monthlyReportExcel.js`)
and the three new pages had none. Its `scopeLine` parameter is **required**, not optional — a sheet
that does not state what it covers cannot be reconciled a month later by the person who made it.

`.data-table tfoot` and `font-variant-numeric: tabular-nums` are now rules in `Layout.css` rather
than per-call-site inline styles. `tfoot` had **no rule at all**, so every totals row in the product
was hand-styled; `tabular-nums` appeared on exactly one page (`ConsolidatedPnl` found it
independently) while the body font's proportional figures left every other currency column ragged
(true of Poppins then and of Archivo now — it is a property of most UI faces, not of one).
`.data-table--sticky-first` is opt-in, for a wide matrix whose first column is the row label.

### The gate must be INSIDE the branch, not merely present on the page (S616)

`ReportPage` suppresses `stats` while loading or after an error, and the ~20 pages that predate it
have to do it by hand. Three were doing it wrong in a way no audit had caught, because every
earlier sweep asked *does this page have an error branch* — `MenuRepricing.js`, `RecipeMargin.js`
and `DeadStock.js` all answered yes. Their KPI strips simply sat forty lines **above** the
`{loading ? … : loadError ? <ReportLoadError/> : …}` ternary, outside it.

Measured on a forced 500: three `stat-card`s each, rendered directly above the "Could not load this
report" card — `UNDERPRICED DISHES 0`, `MONTHLY OPPORTUNITY NPR 0`, `TOTAL CONTRIBUTION NPR 0`,
`DEAD STOCK ITEMS 0`. And they were **green**: not just a number the page has not computed, but one
that reads as good news. "Nothing is underpriced" and "we have no dead stock" are the two most
reassuring sentences those pages can say, and a failed read said both. They were equally visible on
every ordinary load, before the data arrived.

So the check is positional, not textual. **Grep for the `stat-grid` line and confirm a
`!loading && !loadError` guard opens before it**, rather than confirming `ReportLoadError` appears
somewhere in the file:

```bash
grep -n "stat-grid" <file>          # then read the five lines above it
```

The same applies to any slot `ReportPage` would have gated — `note`, `filters`, `footnote`. A page
that hand-rolls the shell inherits the whole rule, not the error card alone.

**Two more instances in S721, and both are on pages this rule had already named.**
`StockMovements`' KPI strip opened on `{loadError ? <ReportLoadError/> : <>` with `loading`
mentioned nowhere between that line and either `stat-grid`, so every visit and every period change
painted `Movements 0` and a gold `NPR 0` for the period's depletion directly above a card reading
"Building report…" — the table bodies below WERE gated, which is what produced the split screen.
And `DeadStock` — the file S616 was recorded against — had its stat-grid correctly gated by S717
and its **filter tabs** left ungated forty lines below, so `All (0) Dead (0) Slow (0)` sat above the
failed-read card saying "no dead stock, no slow movers" about a period the page never read.

So the rule has a second half worth stating: **gating the stat-grid is not gating the page.** Every
element that reports a COUNT or a FIGURE needs the guard, including tab labels, filter-bar counts
and footnotes. Grep the file for `stat-grid` *and* for count expressions in the filter bar.

**And a third half: the EXPORT BUTTON is a figure-bearing control (S728).** `VendorReport`'s was
`disabled={!!loadError}` with no `loading` in the gate, so it stayed live for the whole duration of
the three reads — and the workbook is built from the stale `ix`/`vendorSummary` while `scopeLine`,
the print title and the FILENAME all come from the already-updated `selectedPeriod`. That is one
month's figures leaving the building inside another month's workbook, which is precisely what S601
exists to prevent; the stale KPI strip beside it is transient and self-correcting, this is not.
**Gate every export, print and share control on `loading` as well as on the error**, and check what
the filename is derived from — a control that emits a FILE is the one place a stale render becomes
permanent.

**And `loading` only covers what the loader awaits (S721).** `StockMovements` fires its sub-recipe
derivation as a deliberate fire-and-forget promise, so `loading` goes false without it — and the
reconciliation note then compared the PREVIOUS period's derived value against the NEW period's
ledger and printed the difference in NPR under the new month's label. A second async source needs
its own flag, and the stale value must be cleared BEFORE the load rather than overwritten after it.

**And `!loading && !loadError` is not the whole guard, because a page can finish loading nothing
(S722).** `PaymentReport` auto-selected `periods.find(x => x.status === 'open')` and, on a client
whose periods are all closed, selected nothing and called no loader at all — so `loading` went
false, `loadError` stayed null, both gates opened, and the page drew its full stat grid at **NPR 0
for every method** with the summary table's total row confidently reading **100%**, over a period
`PeriodScope` was rendering as `—`. `NoPeriodState` did not fire either, since periods *existed*.
Between closing one month and opening the next, a client got a complete report of a month that was
never chosen — the same failure `ReorderReport` had in S696 ("Stock is healthy"), which is the tell
that this is a shape rather than an incident.

Two things to check on any page that auto-selects: **fall back to `periods[0]` rather than to
nothing** — an open period is a preference, not a precondition — and ask what the KPI strip renders
when `selectedPeriod` is null, because `loading` and `loadError` both describe a load that *ran*
and neither says one happened. The honest third state is the S717 `DeadStock` rule in another
guise: when a report cannot judge, it says so instead of reporting zero.

## A gating wrapper cannot protect an eagerly-evaluated children expression (S601)

Migrated from the root `CLAUDE.md` (S663).

`ConsolidatedPnl.jsx` passed its whole table as `ReportPage`'s `children`. `ReportPage` renders
`children` only once the page has loaded — but **JSX children are an ARGUMENT**: the expression is
fully evaluated by the parent and handed over as a finished element tree, so the gate inside the
wrapper never gets a say. `pnl` is `useState(null)` and `loading` is `useState(true)`, so
`LINES.map(l => … pnl[l.key] …)` ran on the first render and threw on `revenue`. It crashed on
**every** visit for a single-outlet client, before `SuiteGate` even rendered — so the entitlement
gate could not stop it either. Only an early return, a guard at the call site (`{!stmt ? null : …}`),
or a render prop can protect it. The same applies to `banners`/`stats`/`note`/`filters`/`footnote`:
`ReportPage` suppresses them while loading or after an error, but the caller still *evaluates* them.

Related, from the same audit: **`banners` is no longer rendered over the error card.** A banner is
derived from state the caller set before the read, so ConsolidatedPnl's "Provisional — this period is
still open… the statement is reliable once the period is closed" printed directly above ReportPage's
own "Nothing here is a real figure — this is a failed read". Two contradictory sentences, one of them
asserting a statement exists.

**A fourth CRUD-page instance (S683): `MenuPricing.js`.** Three reads and the ingredients read all
dropped `error`, so a dead connection rendered *"No menu items yet. Use + Add Item above to add your
first item"* — an empty state that names a button and invites the reader to start re-entering a menu
they already have. It carries `loadError` → `ReportLoadError` now, through `firstError` on the batch and
`fetchAllRowsChunked` on the ingredients `.in()` (every recipe id in one URL). Same for
`TaxPoolTab`'s repair-expense read, whose empty result understated the Section 16 cap.

**And half of that fix was unreachable for three weeks (S690).** `MenuPricing.js` has **two
returns** — a POS-only branch and an IMS branch — and S683 set `loadError` in the shared loader but
rendered `ReportLoadError` in only the first one. The IMS branch, the branch with the food costs
and the margins in it, still fell through to `display.length === 0` and printed the "add your first
item" invitation on a failed read. Nothing about the source looks wrong: `loadError` is set, the
component imports `ReportLoadError`, and the string it renders is in the file. **On a page with
more than one `return`, a failed-read fix has to be checked in every branch that can render the
table** — see `component-library.md`'s standing rule that a page with two returns will put your new
UI where nobody can reach it. Grep the file for `empty-state` and confirm each occurrence has a
`loadError` case above it.
