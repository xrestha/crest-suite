---
paths:
  - "src/components/ReportPage.jsx"
  - "src/components/ReportLoadError.jsx"
  - "src/components/RowDisclosure.jsx"
  - "src/shared/queryError.js"
  - "src/shared/excelLetterhead.js"
  - "src/shared/hooks/useBizInfo.js"
  - "src/modules/ims/reports/**"
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
  from any sibling; there is no unswept example left to copy.
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
