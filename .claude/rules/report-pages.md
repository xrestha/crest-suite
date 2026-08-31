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
  as "report pages" keeps missing the CRUD/entry pages that read and render the same way.)
- **Refusing to render the figure is half the job; the sentence you show instead is the other half
  (S619).** `firstError`/`ReportLoadError` decide *that* something failed. `errorText(err,
  'operator')` (`src/shared/errorText.js`) decides what the reader is told — one table, two
  audiences, and no message that claims a failed write did not land. Before S619 the only such
  table lived inside HR Self-Service and no IMS or POS screen could reach it, so a dead connection
  reached an Owner as a bare `TypeError: Failed to fetch`. Pass the error object through it rather
  than `error.message`, and keep `detail` as fine print. **Since S658 `ActionError` renders that
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
independently) while Poppins' proportional figures left every other currency column ragged.
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
