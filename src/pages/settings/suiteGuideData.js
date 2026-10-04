// Crest Suite — deep per-page reference for Admin Settings → Guides → Crest Suite.
// Same shape and voice as imsGuideData.js: every section defines all 10 keys (ModuleGuideTab
// renders `.length` with no null guards).
//
// Why this file exists as a FOURTH guide (S636): the other three are per-module, and the four
// owner-altitude pages belong to none of them — they read ACROSS modules, and that is the whole
// product. They sat in no guide at all, while the IMS guide already documented two Suite-gated
// pages (Demand Forecast, Fixed Assets) purely because those happen to read IMS data. Those two
// stay where they are and are cross-referenced here rather than duplicated; a figure documented
// twice is a figure that will be described two different ways.
//
// The `plan` chip on every section carries BOTH gates, because both are real and they are checked
// by different mechanisms: clients.suite_plan = 'pro' (SuiteGate) AND the Owner/admin role test
// inside the page itself. Neither implies the other.

export const SUITE_GUIDE_GROUPS = [
  // ───────────────────────────── Overview ─────────────────────────────
  {
    key: 'suite-overview',
    label: 'Overview',
    sections: [
      {
        id: 'suite-overview',
        title: 'What Crest Suite is, and what it is not',
        route: null,
        plan: null,
        summary:
          'Crest Suite Pro is the owner layer sold ON TOP of the modules — a separate billed axis (clients.suite_plan), not a bundle that contains IMS, HR or POS. Turning it on says nothing about which modules a client has or which IMS tier they are on. What it buys is synthesis: figures that can only exist by reading two modules at once (labour % needs HR wages and IMS revenue), figures frozen against later edits (the Monthly Report), and figures spanning outlets (the Group Console).',
        workflow: [
          'Sold PER OUTLET, including inside a group. A three-outlet group with Suite Pro on two of them gets a Group Console covering two outlets — and the console names the third rather than quietly omitting it.',
          'Priced per outlet per month in Admin → Settings → Plan Pricing. NPR 2,000 is only the shipped default — whatever is saved there is what clientMRR() charges (annual billing is 25% off). A ★ SUITE pill on both admin client surfaces shows it, so a billed axis is visible on the screens that bill it.',
          'Admin toggles it on Admin → Clients → Billing, together with a Suite end date. There is no self-service purchase path.',
        ],
        fields: [
          { label: 'ONE tier, always', desc: 'suite_plan is NULL or \'pro\' — nothing else. It used to carry starter/growth/pro, but every call site asked for growth, so Suite Starter unlocked nothing at all and Suite Pro added nothing over Suite Growth. Retired S548.' },
          { label: 'SuiteGate vs ModuleGate/PremiumGate', desc: 'SuiteGate is a third gate on a genuinely separate axis, and it NEVER redirects on failure — an ineligible viewer gets an inline upsell in place, because the nav entry has to stay visible to be sold. That is why a Suite nav item carries no featureKey/minPlan tag: those would hide it instead of upselling it.' },
          { label: 'Where a client finds it in the navigation', desc: 'A CREST SUITE menu sits in the nav row beside the Dashboard link on every module panel — IMS, HR and POS alike, since Suite is cross-module. It holds EVERY Suite feature: Owner Dashboard, Owner Report, Profit & Loss, Group Console (with more than one outlet), Demand Forecast and Fixed Assets. A client without suite_plan sees the same group carrying a PRO chip in place of the item count, and the rows still click through to the in-place upsell. (On the Crest-admin panel it renders LAST instead, below Clients / Periods / Guest Menu / Audit Log / Settings — there it is a client-facing layer being looked at from outside, not the operator\'s own work.)' },
          { label: 'Where it lives in the menu (S763)', desc: 'A property that HAS Crest Suite gets its own tab in the top row, beside IMS, HR, POS and Custom, with Owner Dashboard, Owner Report, Profit & Loss, Demand Forecast and Fixed Assets on it (plus Group Console for a multi-outlet group). A property that does not have it sees a PRO-badged "Crest Suite" menu inside each module instead, which opens the same pages and explains what Suite is — so nobody is sold to from the top row, and nobody who has paid has to go looking for it inside a module it does not belong to.' },
          { label: 'Two gates, one list', desc: 'The four owner-altitude pages are Owner-or-admin only. Demand Forecast and Fixed Assets are Suite-billed but IMS-shaped and gated at IMS supervisor rank, so an IMS supervisor who is not the Owner sees a two-item Suite tab. The gate is per item rather than on the whole list precisely so that grouping them did not revoke them from those supervisors; a viewer who can reach none of them sees no tab and no menu at all.' },
          { label: 'The command palette reads the same list', desc: 'Ctrl/Cmd-K searches every Suite destination under a "Suite" tag, using longer names (Monthly Owner/Manager Report, Consolidated Profit & Loss) since it is searched by typing. It builds from the nav\'s own list and applies the same per-item gates, so the two can never disagree about who may see a Suite page — which they did until S638.' },
          { label: 'requireModules', desc: 'Each Suite feature declares its own module floor. Owner Dashboard needs BOTH ims and hr (its original behaviour); Group Console, Consolidated P&L, Monthly Owner Report, Demand Forecast and Fixed Assets need ims only. Do not assume every Suite page needs Owner Dashboard\'s pair.' },
          { label: 'The feature_flags override', desc: 'Each page passes a featureKey (owner_dashboard, monthly_owner_report, consolidated_pnl, multi_outlet), so admin can grant one Suite page to a client without suite_plan. Admin always bypasses everything.' },
        ],
        formulas: [
          'Access = isAdmin OR (every requireModules module enabled AND (Suite is live OR the page\'s feature_flags override is true)) — AND, separately, the page\'s own Owner/admin role check.',
          'Suite is live = suite_plan = \'pro\' AND its end date has not passed by more than the grace period (GRACE_DAYS in subscription.js, 7 days today). The date is suite_ends_at, or the IMS end date for older rows written before that column; a client with no date at all counts as live. This is suiteLive() — the same date the ★ SUITE pill and the MRR figure read, so a lapsed Suite closes these pages instead of only changing a badge.',
        ],
        gotchas: [
          'Suite Pro is NOT a role. Every one of these pages additionally refuses anyone who is not the Owner or a Crest admin, checked inside the page — because SuiteGate reads a plan and ProtectedRoute reads a session, and neither reads a role. Two of the four had no such check until S601 and a third until S617.',
          'Why that mattered more than an ordinary leak: the staff-isolation policies are RESTRICTIVE SELECT filters, so a fenced table returns an empty list with NO error. A POS PIN account reaching Consolidated P&L got real Revenue with every cost table empty — a confident statement reading Net Profit = Revenue at 100% margin, in green.',
          'Demand Forecast and Fixed Assets are Suite Pro too, but they are documented in the Crest IMS guide, where the data they read lives.',
        ],
        connections: 'Reads IMS (periods, purchases, sales, stock, overheads), HR (employees, payroll, attendance, overtime) and POS (revenue arrives through IMS sales entries). Writes nothing except the Monthly Report snapshot, minted at period close.',
      },
    ],
  },

  // ───────────────────────────── Owner altitude ─────────────────────────────
  {
    key: 'suite-owner',
    label: 'Owner',
    sections: [
      {
        id: 'owner-dashboard',
        title: 'Owner Dashboard',
        route: '/owner-dashboard',
        plan: 'Crest Suite Pro · Owner or admin · needs IMS + HR',
        summary:
          'The strategic cross-module view, and the only place in the product that computes real employer labour cost outside a finalized Payroll Run. Two KPI rows — Profitability (Revenue, Spend % so far, Labour Cost %, Prime Cost %, True Net Margin %) and Operations (Wastage Value, Items Below Par, Overdue Payables, Purchases split Cash/Credit) — every tile month-to-date on the open period, and almost all of them clickable through to the page that owns the number.',
        workflow: [
          'Loads the open period automatically. No open period shows a banner linking to Periods rather than a page of dashes.',
          'Read top-left to bottom-right: Revenue sets the denominator, stock bought (Spend % so far) and Labour are the two controllable costs, Prime Cost is their sum, True Net Margin is what is actually kept. The open month has no closing count yet, so the stock half is what was BOUGHT; a closed month\'s Food Cost % is what was USED, on Monthly Summary, the P&L and the Monthly Report (S792, owner decision D30).',
          'Click a tile to land on the page that owns it — Revenue → Sales, Spend % so far → Variance, Labour → Payroll Run, True Net Margin → Overheads, Wastage → Wastage Report, Items Below Par → Reorder Report, Overdue Payables → Payables, Purchases · Cash / Credit → Payment Report. Prime Cost has no link of its own. "View Full Monthly Report →" in the page header opens the Monthly Owner Report.',
          'Below the tiles, the Cost & Margin — Trend chart plots Food Cost, Labour, Prime Cost and Net Margin % for up to the last 12 CLOSED months. It reads each month\'s frozen Monthly Report snapshot rather than working anything out again, so it always agrees with those reports — and it stays empty until the first month is closed. Reports made before S792 froze Food Cost % as purchases ÷ sales and later ones as stock used ÷ sales, so the Food Cost and Prime Cost lines can step at that change; a note under the chart says so.',
        ],
        fields: [
          { label: 'Labour Cost % (MTD) — finalized payroll when there is one, otherwise an estimate', desc: 'When this month\'s Payroll Run is finalized, the tile uses it — gross pay plus overtime plus the employer SSF share, the same figure the Monthly Report uses — and says "from finalized payroll". Until then it is an ESTIMATE and says so: each employee\'s monthly pay for the days that have passed so far, plus approved overtime for the month (not prorated), plus the employer SSF share on basic salary (not allowances, which is how payroll charges it) — counted only for staff who are enrolled in SSF AND have an SSF number, the same test payroll uses. Daily and hourly staff are simplified — a standard day for every day passed, not a real attendance lookup. If payroll is finalized before the month ends, a full month\'s wages sit against part of a month\'s sales, so the tile shows no colour or ✓ / △ / ▲ until the month is over. If payroll cannot be read, the tile shows a dash rather than guessing.' },
          { label: 'Prime Cost % and True Net Margin % both CONTAIN that labour figure', desc: 'Both say which one — finalized payroll or the estimate — inline, under the number, not in a hover tooltip. A figure carrying a red/amber/green verdict has to disclose its basis where it is read — a print or a screenshot loses a hover.' },
          { label: 'Early in the month (before day 10)', desc: 'Spend % so far, Prime Cost % and True Net Margin % show a plain percentage — no colour and no ✓ / △ / ▲. Spend % so far says "Day N of M · settles at month end" underneath; Prime Cost and Net Margin say "Day N of M" with "labour from finalized payroll" or "labour estimate — payroll not finalized". Why: one big stock purchase on day 3 can push food cost into the hundreds of percent until sales catch up, and a red warning on that would be a false alarm. Labour Cost % keeps its colour from day one, because its cost and the revenue it is divided by both build up day by day.' },
          { label: 'True Net Margin needs Overheads', desc: 'Overheads is a Growth IMS feature. Without it the tile reads "—" with "Requires Overheads (Growth)" beneath, rather than a margin silently computed as though fixed costs were zero. With Overheads but nothing entered, it says "Excludes overhead — not entered", which is a different fact.' },
          { label: 'What True Net Margin takes off', desc: 'Revenue minus stock bought so far (net purchases — spend, not stock used, until the month is counted), minus labour (finalized payroll, else the estimate), minus the Overheads page\'s fixed costs (rent, utilities and the like) and its Tax & Fees (card and bank fees, the accountant, licences). Only the Overheads Labour tab is left out, because HR labour is already subtracted and taking both would count wages twice. Until S798 Tax & Fees was left out too, so this margin read higher than Consolidated P&L\'s for the same month.' },
          { label: 'Spend % so far banding', desc: 'Coloured, as a guide, against the client\'s OWN fc_warning_pct / fc_critical_pct from Settings (defaults 35 / 45) — the same scale Variance and Recipes use — with a ✓ / △ / ▲ marker beside the colour so the verdict survives colour-blindness and a black-and-white print. Withheld before day 10, as above.' },
          { label: 'Labour, Prime and Net Margin banding', desc: 'The other three ratios band the same way and now carry the same ✓ / △ / ▲ marker — until S660 they were coloured here without one, beside a Food Cost tile that had it. Labour: healthy ≤30%, watch 30–37%, too high above. Prime: ≤60 / 60–65 / above. Net Margin is the one inverted band — healthy ≥20%, watch 10–20% — and stays unbanded entirely without Overheads, because without it there is no margin to judge. All three come from shared/operatingBands.js, which the Monthly Owner Report and the Roster board read too, so the same month can never be banded two ways on two pages.' },
        ],
        formulas: [
          'Revenue = Σ qty × (price charged on the sale, else the recipe\'s current price) − row discount. Comped dishes are excluded; older sales rows with a blank source are kept.',
          'Net purchases = Σ qty × rate − each supplier bill\'s discount (counted once per bill, spread across its lines) − vendor returns. Spend % so far = net purchases ÷ revenue × 100 (the open month). A closed month\'s Food Cost % = stock used (COGS) ÷ revenue × 100.',
          'Labour Cost % = labour ÷ revenue × 100, where labour is the finalized Payroll Run (gross − absence deduction + OT + employer SSF) when one exists, otherwise the prorated estimate — plus, either way, festival allowance, incentives and Final Settlements finalized for this month (S798 3c), named under the figure. That lump is not accrued with revenue, so while the month runs it carries no verdict ("Lump-sum pay counted · Day N of M").',
          'Prime Cost % = Spend % so far + Labour Cost % (the open month). Benchmark 60–65% for Nepal F&B.',
          'True Net Margin % = (revenue − net purchases − labour − Overheads fixed costs − Tax & Fees) ÷ revenue × 100. Only the Overheads Labour tab is NOT subtracted (labour is already in).',
          'Labour accrual: per employee, (monthly-equivalent gross ÷ days in BS month) × days actually worked inside the elapsed window, + approved OT this period + prorated employer SSF (only for staff enrolled in SSF with an SSF number).',
        ],
        gotchas: [
          'A mid-month joiner accrues only from join_date, and an employee deactivated mid-period is still counted for the days they worked — but ONLY when end_date is actually set and falls inside the period. Deactivating flips status without populating end_date, so a stale or unset end_date must never be read as "worked the whole month".',
          'Needs BOTH modules. A client with only one gets a named banner saying which is missing, because the old behaviour — every KPI showing "—" plus a "no open period" warning — pointed at the wrong cause entirely.',
          'Overdue Payables means credit purchases unpaid for more than 60 days. Purchases · Cash / Credit splits net PURCHASES (after bill discounts; all returns come off Cash) by payment method; it is not a revenue split.',
          'Wastage Value (S792 stage 3, FIGURES-5) is periodWastageValue() — everything logged as waste this month, raw items, prep (sub-recipes) and items since hidden, at each item\'s rate: the Wastage Report\'s total and the Dashboard\'s tile. It is informational and feeds no ratio here; Monthly Summary\'s Wastage column is raw items only (the COGS term), so it can read lower for the same month.',
          'Items Below Par (S792 stage 3, PLANNING-6): if the count cannot be worked out — the stock reads failed, the connection dropped — the tile shows a dash and "Count unavailable — open the report →", never 0, because 0 would read as "nothing to reorder". An item exactly AT par is fine and not counted (buildStockRows, strictly below), as on the Reorder Report.',
        ],
        connections: 'Reads IMS (sales entries, purchases, stock, wastage, par levels, overheads, payables) and HR (employees, salary components, approved overtime) together — the combination is the point. The trend chart reads the frozen Monthly Report snapshots. Links out to Sales, Variance, Payroll Run, Overheads, Wastage Report, Reorder Report, Payables, Payment Report and the Monthly Owner Report (and to Periods when no period is open).',
      },
      {
        id: 'owner-report',
        title: 'Monthly Owner/Manager Report',
        route: '/owner-report',
        plan: 'Crest Suite Pro · Owner or admin · needs IMS',
        summary:
          'The month\'s formal report, captured as a FROZEN SNAPSHOT when the period closes and never recomputed afterwards — even if the underlying data is later corrected in place. That is the whole design: it is the document that was issued, not a live query dressed as one. Every other page in the product is the opposite.',
        workflow: [
          'Generated automatically at period close when the Owner or admin ends the month. Select a closed period to read the report that close produced. If a closed month has none yet (closed before this feature existed, generation failed at close, or an IMS supervisor or manager ended it), opening it here generates and saves one on first view. An open period has no report.',
          'S792 stage 3 (D42): an IMS supervisor or manager may end the month but cannot write this table (owner/admin-only RLS — four restrictive policies refuse every staff account), so their close no longer tries; the report is made the first time the Owner or admin opens it (generation_source \'backfill\'), and the close dialog says so. It therefore shows the month as it stood on that day, including any fix made between the close and the first view. The header says when and how it was made — "Made when Bhadra was ended: <BS date>, <time> (Nepal time)", "Made …, the first time this report was opened" plus a sentence explaining why, or "Regenerated …" — from reportMadeLine.js, in BS and Nepal time rather than the viewer\'s clock; the Excel export carries the same line.',
          'Print it or export to Excel with the client letterhead; the workbook states the period it covers. The printout is several A4 pages — Menu Engineering, Inventory Depth and Trend each start a fresh page (owner decision, S778) — with the business, month and "Page X of Y" in the bottom margin of every page. In Chrome or Edge; a browser that cannot draw page-margin text prints it without that footer.',
          'Admin only: Regenerate Snapshot rebuilds the report from today\'s data and overwrites the frozen one, after a confirmation. Use it after correcting a closed month, or after finalizing payroll late.',
        ],
        fields: [
          { label: 'Why frozen', desc: 'A report an owner acted on in Bhadra must still say in Kartik what it said in Bhadra. A live recompute means the same "Bhadra report" quietly changes every time someone fixes an old purchase bill, and nobody can tell which version a decision was made against.' },
          { label: 'Display values resolved at generation time', desc: 'Names of vendors, items and categories are written into the snapshot, not looked up on read — otherwise renaming a vendor rewrites history.' },
          { label: 'Estimated labour is labelled inline', desc: 'When no payroll was finalized for the period the report prints "· estimated — no payroll finalized for this period" beside the figure, in the document itself. That estimate counts the employer SSF share only for staff enrolled in SSF AND carrying an SSF number, the same test payroll uses. When payroll WAS finalized, the report uses the real payslips instead.' },
          { label: 'Schema version 6 (S747)', desc: 'Reports generated from now on take purchases — and so Food Cost %, Prime Cost %, Net Margin %, the cash/credit split and stock turnover — AFTER supplier bill discounts, and the estimated payroll counts employer SSF only for staff enrolled AND with an SSF number. Reports already generated keep the figures they were frozen with (version 5 or earlier), so a trend comparison across that change includes the change of method. Regenerate Snapshot moves an old month onto version 6.' },
          { label: 'Schema version 14 (S798 4b)', desc: 'When payroll was not finalized for the month, the estimated payroll charges employer SSF on basic salary only, as payroll does, not on basic plus allowances. A report made from now on reads its estimated labour lower by 20% of SSF staff\'s allowances. A report built from finalized payroll is unchanged, and reports already made keep their figures.' },
          { label: 'Schema version 13 (S798 3c)', desc: 'Labour is pay EARNED — gross less unpaid days and the days before a joiner started — plus overtime and employer SSF, and adds the month\'s finalized festival allowance, incentives and leavers\' final settlements (gratuity included), each on its own line. A report made from now on reads labour lower by the unpaid days and higher in a Dashain or settlement month; Trend leaves the Labor, Prime and Net Margin changes blank across the line and says why. Older reports keep their figures and their "Total Payroll Cost" label until regenerated.' },
          { label: 'Schema version 12 (S798)', desc: 'Net Margin % also takes off Tax & Fees, and the IMS section lists Overheads and Tax & Fees, so a report made from now on reads lower than an older one by that month\'s fees; Trend leaves the Net Margin change blank across the line and says why. A leaver whose last day is the month\'s last day now counts in the estimated payroll and as a termination. Labor Analytics prints how many worked days have no clock times, and shows "Hours not recorded" instead of Schedule Variance and Sales per Labor Hour when more than half do.' },
          { label: 'Schema version 9 (S792)', desc: 'Food Cost % is stock used (COGS) ÷ sales, and Prime Cost % and Net Margin % use COGS too; an item hidden since keeps its place in the month. Inventory Variance and the Shrinkage Trend follow the live pages (your variance tolerance, a NPR 500 floor, items with no closing count named rather than judged), Dead Stock counts staff meals as use, build-your-own dishes are "Not rated — costed by build" on the menu matrix, and an archived supplier keeps its name. While uncounted items are material, the three cost ratios show no verdict. Reports made earlier keep their figures and say "on purchases"; the Trend section does not compare Food Cost, Prime or Net Margin across the change.' },
        ],
        formulas: [
          'Every figure is read from the stored snapshot. Nothing recomputes it except an admin pressing Regenerate Snapshot.',
        ],
        gotchas: [
          'Closing a period WITHOUT a closing stock count freezes "closing stock = 0 for every item" into this report, and COGS subtracts closing stock. Periods preflights the count and states what it found inside the close confirmation, red when nothing is counted — it informs, it never blocks, because an admin correcting history legitimately closes uncounted months.',
          'Any figure that values items must filter on active items — an inactive item valued into a frozen snapshot cannot be corrected later, because nothing recomputes it.',
          'Correcting the underlying data does NOT correct this report — and neither does reopening and re-closing the period. Closing only ever ADDS a report and quietly skips a month that already has one. The admin Regenerate Snapshot button on this page is the only way to overwrite it.',
        ],
        connections: 'Minted by Periods at close — or, when an IMS supervisor or manager closed the month, by this page on the Owner\'s first view (D42). Reads the IMS period data; documented in depth in .claude/rules/owner-report.md. Distinct from Consolidated P&L, which is live and recomputes on every load.',
      },
      {
        id: 'consolidated-pnl',
        title: 'Consolidated P&L',
        route: '/pnl',
        plan: 'Crest Suite Pro · Owner or admin · needs IMS',
        summary:
          'The one page in the product that is a STATEMENT rather than a dashboard: Revenue → COGS → Gross Profit → Wastage, Staff Meals, Labour, Overheads, Tax & Fees → Net Profit, for one BS month. It computes nothing of its own, which is the point — it reuses Monthly Summary\'s revenue and COGS rules and the shared computeUsed(), so it can never become a third definition of either.',
        workflow: [
          'Defaults to the most recent CLOSED period, because COGS subtracts a closing count.',
          'An open period still renders, behind a provisional banner. A period closed WITHOUT a count gets its own separate warning — two genuinely different failure modes, distinguished rather than merged.',
          'A grouped owner gets one column per Suite Pro outlet plus a consolidated total, via get_group_pnl().',
        ],
        fields: [
          { label: 'Labour is payroll XOR the Overheads labor bucket — never the sum', desc: 'Applied PER OUTLET before consolidating, because one branch can run payroll while a sibling enters labour by hand. When both exist, the ignored one is NAMED ON SCREEN with its amount rather than silently dropped.' },
          { label: 'Why that rule exists', desc: 'The Overheads table has three buckets (overhead / labor / tax_fees) and different pages deliberately read different subsets. Adding an HR payroll figure on top of an overhead total that already contains a labor bucket double-counts labour — which shipped once on the Dashboard\'s cost pie.' },
          { label: 'LINES is one declaration', desc: 'The same list feeds the single-outlet table, the group matrix and the Excel export. Two hand-written copies of labels and tooltips is exactly how they drift.' },
        ],
        formulas: [
          'Gross Profit = Revenue − COGS. Net Profit = Gross Profit − Wastage − Staff Meals − Labour − Overheads − Tax & Fees.',
          'COGS and revenue come from the shared IMS formulas, never re-derived here.',
        ],
        gotchas: [
          'The grouped statement (get_group_pnl) is Owner or admin only, checked inside the database function itself — the same rule as the Group Console. Being part of an outlet group is not enough on its own; a staff login of a grouped client is refused even if it calls the function directly.',
          'Revenue keeps older sales rows whose source is blank. Comped dishes (source pos_comp) are left out, but a blank source is never treated as a comp — so rows entered before that column existed still count, in both the single-outlet and the grouped statement.',
          'Only Gross Profit and Net Profit are coloured (green when positive, red when negative). Cost lines stay neutral in brackets, in the consolidated column exactly as in each outlet\'s column — a green cost line would read as good news, or to an accountant as a credit.',
        ],
        connections: 'Reads IMS periods, purchases, sales, stock, wastage, staff meals and overheads, plus HR payroll for the labour line. Group columns come from get_group_pnl() (Owner or admin only). Shares its revenue and COGS rules with Monthly Summary.',
      },
    ],
  },

  // ───────────────────────────── Multi-outlet ─────────────────────────────
  {
    key: 'suite-group',
    label: 'Multi-Outlet',
    sections: [
      {
        id: 'multi-outlet',
        title: 'How multi-outlet works',
        route: null,
        plan: 'Crest Suite Pro · Owner or admin',
        summary:
          'A group of outlets is several clients rows joined by clients.group_id. An Owner switches between them from the top bar and every scoped query re-points at the selected outlet. The architecture is SELECTED-OUTLET INDIRECTION, not policy rewriting: profiles.active_client_id was added and only my_client_id() changed, to coalesce(active_client_id, client_id). Every one of ~151 policy references keeps its exact shape and resolves to the selected outlet.',
        workflow: [
          'Admin links outlets by setting clients.group_id. Both new columns default NULL, so an ungrouped client is byte-identical to before — which is what made this safe to ship across the whole book at once.',
          'The Owner picks an outlet in the top bar; the whole app re-scopes. The Group Console rolls the group up.',
        ],
        fields: [
          { label: 'Why not a set-returning my_client_ids()', desc: 'It would touch every policy on ~50 tables and permanently widen RLS from "one client" to "any client in my group" — removing RLS as the backstop behind the scoped query layer\'s own filter.' },
          { label: 'active_client_id is privilege-bearing', desc: 'It decides which tenant every RLS policy resolves to, so it is deliberately NOT on the profiles column allow-list and can never be written by a user. set_active_outlet() is the only write path.' },
          { label: 'Membership is validated at WRITE time', desc: 'my_client_id() runs per row across ~120 policies, so it stays a join-free coalesce. A trigger on clients.group_id clears stale selections instead of every policy re-checking membership.' },
          { label: 'Outlets keep independent periods', desc: 'monthly_periods is unique per (client, year, month), so anything spanning outlets aligns on (bs_year, bs_month) — never period_id.' },
        ],
        formulas: [
          'my_client_id() = coalesce(profiles.active_client_id, profiles.client_id).',
        ],
        gotchas: [
          'Switching outlets is BLOCKED while the offline queue is non-empty — both the stock queue and the POS order queue, since stock operations write against the current tenant just as orders do.',
          'The selected outlet is ONE value on the login, so switching on one device moves every window that login has open. A window left on the old outlet would read every page as empty and "save" edits that change nothing (S798). It now follows: when it wakes, on every page change, and at once when another tab of the same browser switches, it re-reads the login\'s outlet and, if it moved, goes to the dashboard and says which outlet it shows. The staff pages also send the outlet they show, and admin-user-ops refuses a mismatch with "Reload the page" rather than creating a login in the other outlet. Ungrouped logins skip the check entirely.',
          'clients_select is the one policy that had to widen: it was "my client or admin", so an Owner could not read that a sibling outlet existed at all.',
          'Being in a group is never permission on its own. Group figures and group actions are Owner or admin only, checked in the database: get_group_summary, get_group_pnl and push_master_data each refuse anyone else, and set_active_outlet only switches a person into an outlet they may reach. Each owner page also sends non-owners back to the dashboard.',
          'Every client-scoped security policy calls my_client_id() — never a copy of its old body. A copied body ignores the selected outlet, so after switching, that table would quietly read as empty with no error. And no client has a group_id yet, so none of this has run on real data: test with a real group before relying on it.',
        ],
        connections: 'Underpins the Group Console, Outlet Access and the HQ→branch master-data push below. Consolidated P&L\'s group columns ride on the same group_id.',
      },
      {
        id: 'group-dashboard',
        title: 'Group Console',
        route: '/group-dashboard',
        plan: 'Crest Suite Pro · Owner or admin · needs IMS',
        summary:
          'The roll-up across a group for one BS month: group Revenue, Food Cost % (or Spend % so far), Labour % and Covers, then a per-outlet table (Revenue, Net Purchases, Food Cost % or Spend % so far, Labour, Labour %, Covers). An outlet\'s Labour is its finalized payroll, or its Overheads Labor tab when it has none; with neither it reads "not finalized" (an outlet with Crest HR) or "none entered", with no band. Below it sit the two group admin panels — Outlet Access and Push master data.',
        workflow: [
          'Pick a BS month and year — the figures reload on their own as soon as either one changes. The Refresh button beside them only re-reads the same month. The outlet you are currently viewing is marked in the table, and another outlet\'s name is a link that switches you into it.',
          'Read the coverage banner FIRST — it is deliberately above the figures, not a footnote.',
          'S800 — each outlet\'s revenue carries "▲/▼ N% vs <last month>" from a second get_group_summary call for the month before (compareFigures; within 5% or NPR 1,000 it is ≈; a failed read says "couldn\'t check" and costs nothing else). With three or more outlets carrying a figure, the Food Cost / Spend % and Labour % columns mark the Lowest and Highest outlet with a neutral chip (never across two bases). No prime-cost column: outlets in one month can stand on different bases (counted COGS vs spend so far).',
          'S800 — Same item, different price (GroupItemPrices.jsx, below the branch table): for each item bought by two or more Suite Pro outlets in the picked month, each outlet\'s average price per unit, the cheapest marked Lowest, and Above the lowest = Σ (outlet price − lowest price) × what that outlet bought. A note sums it: what the month would have cost had every outlet paid the group\'s lowest price. Owner decisions: the same item means LINKED by the master-data push (master_id), never the same name; prices are before VAT, after each bill\'s discount; the month is the page\'s month. Units that differ (KG at one outlet, GM at another) are listed with an amber Units differ chip and never compared. Until the HQ pushes its items, the panel says there is nothing to compare — no client had a linked item on 2026-10-02.',
        ],
        fields: [
          { label: 'Coverage is stated before the totals', desc: 'Outlets without Suite Pro are named and excluded; outlets with no period open for that month are named and count as zero. A group total that silently omits an outlet is worse than no total.' },
          { label: 'Group percentages are computed on group totals', desc: 'Not as an average of each outlet\'s percentage — otherwise a small outlet swings the group figure as hard as a large one.' },
          { label: 'Not a group? Not an error', desc: 'An outlet with no group_id gets an explanation, not an empty table.' },
        ],
        formulas: [
          'Revenue (per outlet) = Σ qty × (price charged on the sale, else the recipe\'s price) − row discount. Comped dishes are left out; older rows with a blank source are kept. Same basis as the Owner Dashboard and Consolidated P&L.',
          'Net Purchases (per outlet) = Σ qty × rate − each supplier bill\'s discount counted ONCE − vendor returns, across every item. Same basis as the Owner Dashboard\'s Spend % so far.',
          'Labour (per outlet) = get_group_pnl\'s finalized payroll (gross − absence deduction + overtime + employer SSF) plus the month\'s finalized festival, incentive and settlement pay (labour_festival / labour_incentive / labour_settlement, S798 3c; "incl. bonus / final pay", amounts on hover), else the Labor tab. A month whose payroll is not finalized has no figure here ("not finalized"), never zero.',
          'Per outlet (S792, D30): once that outlet\'s month is closed, Food Cost % = stock used (COGS, worked out from get_group_pnl exactly as Consolidated P&L does, hidden items included) ÷ revenue × 100; while it is open, Spend % so far = net purchases ÷ revenue × 100. The group figure is Food Cost % only when every outlet has closed the month, otherwise Spend % so far. An amber "No count" badge marks an outlet that closed without a closing count, whose COGS counts the whole shelf as used.',
          'Same item, different price (per item, per outlet) = value ÷ quantity bought that month, where value = Σ qty × rate − the line\'s share of its bill\'s discount (one discount per bill, shared by line value), before VAT. get_group_item_prices sends the sums; the page divides.',
          'Group Labour % = group labour ÷ group revenue × 100, shown only when every outlet has a labour figure; until then the card names the outlets without one. The page works both out from the raw figures above — the database sends no percentages.',
        ],
        gotchas: [
          'Group-spanning reads cannot go through the normal scoped query layer, and that is intended. get_group_summary() is a SECURITY DEFINER function that checks the caller is the Owner or an admin (group membership alone is refused); it returns RAW aggregates (the page derives the percentages, so this never becomes a fourth definition of those formulas) and filters to suite_plan = \'pro\' SERVER-side. A client-side filter would ship an unpaid outlet\'s revenue to the browser and then hide it.',
          'get_group_item_prices (S800, migration 20261002120000) is the third group function with the same shape: Owner or admin checked inside it (COALESCE\'d, so a login with no profile is refused), Suite Pro outlets only, filtered in the database, raw sums only. Its key is COALESCE(master_id, id): an HQ item is the master and each branch copy points at it. Prices are deliberately NOT on get_group_pnl\'s cost basis, which adds 13% to a PAN-only outlet\'s VAT lines — that is a tax difference, not a buying one.',
          'pos_orders has no period_id or BS columns — only an AD closed_at — and BS→AD conversion lives in JS, so the RPC takes an AD date range from the caller rather than a period.',
          'Since S747 Revenue and Net Purchases use the same basis as every per-outlet page. Before that the console priced sales at the recipe\'s current price with discounts ignored and comps included, took a bill\'s discount off once per LINE, and never subtracted returns — so the same month can show different figures than it did before that change.',
        ],
        connections: 'Reads every outlet in the group through get_group_summary(). The Outlet Access and Master Push panels live on this page. Consolidated P&L answers the same question as a statement rather than a dashboard.',
      },
      {
        id: 'outlet-access',
        title: 'Outlet Access',
        route: '/group-dashboard',
        plan: 'Crest Suite Pro · Owner or admin',
        summary:
          'A matrix of who may switch into which outlet. An Owner reaches every outlet in the group; anyone else reaches their home outlet plus whatever they are allowlisted into — at the same rank they already hold.',
        workflow: [
          'Tick an outlet to let a person work there; untick to take it away. Ticks are only a draft until you press the Save button at the end of THAT person\'s row — each row saves on its own, through set_outlet_access, which replaces that person\'s whole list in one go. Leaving the page before Save keeps nothing.',
          'Unticking moves the person back to their home outlet at once (set_outlet_access clears their selection). It does not sign them out: a window they have open on the removed outlet can no longer read or write it, and moves itself home the next time they return to it or open another page.',
          'Owners have no checkboxes: they reach every outlet in the group already.',
        ],
        fields: [
          { label: 'It grants REACH, never RANK', desc: 'Deliberately not a per-outlet role matrix. That would put a second rank rule into AuthContext, all three hasXAccess helpers and the SQL Owner test — four places that would then have to agree.' },
          { label: 'The home outlet is a fixed marker, not a checkbox', desc: 'Nobody can be locked out of their own branch.' },
          { label: 'Why it lives on this page', desc: 'profiles RLS is self-or-admin only, so an Owner cannot read a sibling outlet\'s staff rows at all. It needs get_group_outlet_access(), the group-wide sibling of the usual staff-name lookup — which is a group-level call, so it belongs on the group page.' },
        ],
        formulas: [],
        gotchas: [
          'The access table has NO write policy at all — set_outlet_access() is the only path.',
          'A revoke also clears active_client_id, so it EVICTS rather than merely denying the next switch. Denying the next switch would leave someone sitting inside an outlet they had just lost access to.',
          'The outlet list here comes from the RPC, not from the session\'s own outlet list: the matrix must include outlets excluded from the FIGURES for want of Suite Pro, because access and staffing are not what the group is billed for.',
        ],
        connections: 'Feeds the top-bar outlet switcher. Rank still comes from the three role axes on the staff account itself.',
      },
      {
        id: 'master-push',
        title: 'Push master data (HQ → branch)',
        route: '/group-dashboard',
        plan: 'Crest Suite Pro · Owner or admin',
        summary:
          'Pushes categories, items, recipes and (optionally) selling prices from the group\'s HQ outlet to one or more branches. You never choose the source — it is always the HQ. Always previews before it writes, and three of its refusals are the rules rather than the implementation.',
        workflow: [
          'The source is always the group\'s HQ outlet (client_groups.hq_client_id), which the consultant sets. If no HQ is set, the panel says so and there is nothing to push.',
          'Tick what to push (Items & categories, Recipes & ingredients, Selling prices — prices needs recipes ticked too) and tick one or more branches. Press Preview changes and read the plan: every create, adopt, update and conflict is listed per branch.',
          'Apply, then confirm. Apply runs the push a second time from the CURRENT data and writes in that same call — so if HQ or a branch was edited between your preview and Apply, what lands is the fresh plan, not the table you read. The table after Apply shows what was actually done.',
        ],
        fields: [
          { label: 'The preview IS the plan', desc: 'Inside one call, the push works out its plan into a temporary table with read-only queries and the write pass applies from that same table, so what is planned and what is written cannot differ within a call. Preview and Apply are two separate calls, though, and Apply works the plan out again.' },
          { label: 'conflict', desc: 'Item names are unique per outlet (since S707). When a branch already has a different item using the name HQ wants to create or rename to, that row is planned as a conflict naming the item in the way. Conflicts are skipped on Apply, and everything else still lands — rename the branch item and push again.' },
          { label: 'Matching is on master_id', desc: 'items and recipes have no unique name constraint (only categories does). The one exception: the first push into a branch that already has data has no master_id yet, so it matches by NAME once, calls it "adopt", and shows every one in the preview before writing.' },
        ],
        formulas: [],
        gotchas: [
          'items.rate is NEVER pushed on update. That is what the BRANCH pays its own supplier and the input to every costing figure it produces — HQ\'s rate would put another city\'s prices into its food cost. It is seeded on create only, because the column is NOT NULL.',
          'Selling price is a separate opt-in, never swept along with the recipe definition.',
          'A price only means the same thing between outlets with the same VAT status (S792 stage 3, migration 20260928180000). The till bills selling_price plus VAT on a VAT-registered outlet and selling_price exactly on a PAN-bill one (D31), and a PAN-bill HQ stores vat_rate 0 — so pushing across that line would have put wrong prices, or 0%-VAT dishes, on the branch\'s till. For a branch whose VAT status differs from HQ\'s: a dish the branch already has keeps the branch\'s own price and VAT rate; a NEW dish arrives switched off the till (pos_enabled false) with no price and the branch\'s VAT rate, so it can never bill a wrong amount or NPR 0; the push result says why beside every such dish. The branch sets its price, then switches it On POS. Sub-recipes are exempt (never sold), and same-status branches are unchanged.',
          'An ingredient with no counterpart at the branch is REPORTED, never dropped. A recipe costed from a silently-shortened list is the wrong-number-nobody-questions shape.',
        ],
        connections: 'Writes into the target outlet\'s IMS master data — Item Master, Categories and Recipes. Everything downstream of those (costing, stock, reports) then reads the pushed rows normally.',
      },
    ],
  },
]
