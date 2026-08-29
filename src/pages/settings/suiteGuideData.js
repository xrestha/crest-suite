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
          'Priced at NPR 2,000/outlet/month in clientMRR(), and shown as a ★ SUITE pill on both admin client surfaces so a billed axis is visible on the screens that bill it.',
          'Admin toggles it on Admin → Clients → Billing. There is no self-service purchase path.',
        ],
        fields: [
          { label: 'ONE tier, always', desc: 'suite_plan is NULL or \'pro\' — nothing else. It used to carry starter/growth/pro, but every call site asked for growth, so Suite Starter unlocked nothing at all and Suite Pro added nothing over Suite Growth. Retired S548.' },
          { label: 'SuiteGate vs ModuleGate/PremiumGate', desc: 'SuiteGate is a third gate on a genuinely separate axis, and it NEVER redirects on failure — an ineligible viewer gets an inline upsell in place, because the nav entry has to stay visible to be sold. That is why a Suite nav item carries no featureKey/minPlan tag: those would hide it instead of upselling it.' },
          { label: 'Where a client finds it in the sidebar', desc: 'A labelled, collapsible CREST SUITE group sits under the Dashboard link on every module panel — IMS, HR and POS alike, since Suite is cross-module. It holds EVERY Suite feature: Owner Dashboard, Owner Report, Profit & Loss, Group Console (with more than one outlet), Demand Forecast and Fixed Assets. A client without suite_plan sees the same group carrying a PRO chip in place of the item count, and the rows still click through to the in-place upsell. (On the Crest-admin panel it renders LAST instead, below Clients / Periods / Guest Menu / Audit Log / Settings — there it is a client-facing layer being looked at from outside, not the operator\'s own work.)' },
          { label: 'Two gates inside one group', desc: 'The four owner-altitude pages are Owner-or-admin only. Demand Forecast and Fixed Assets are Suite-billed but IMS-shaped and gated at IMS supervisor rank, so an IMS supervisor who is not the Owner sees a two-item Crest Suite group. The gate is per item rather than on the group precisely so that grouping them did not revoke them from those supervisors; a viewer who can reach none of them sees no group at all.' },
          { label: 'The command palette reads the same list', desc: 'Ctrl/Cmd-K searches every Suite destination under a "Suite" tag, using longer names (Monthly Owner/Manager Report, Consolidated Profit & Loss) since it is searched by typing. It builds from the sidebar\'s own list and applies the same per-item gates, so the two can never disagree about who may see a Suite page — which they did until S638.' },
          { label: 'requireModules', desc: 'Each Suite feature declares its own module floor. Owner Dashboard needs BOTH ims and hr (its original behaviour); Group Console, Consolidated P&L, Monthly Owner Report, Demand Forecast and Fixed Assets need ims only. Do not assume every Suite page needs Owner Dashboard\'s pair.' },
          { label: 'The feature_flags override', desc: 'Each page passes a featureKey (owner_dashboard, monthly_owner_report, consolidated_pnl, multi_outlet), so admin can grant one Suite page to a client without suite_plan. Admin always bypasses everything.' },
        ],
        formulas: [
          'Access = isAdmin OR (every requireModules module enabled AND (suite_plan = \'pro\' OR the page\'s feature_flags override is true)) — AND, separately, the page\'s own Owner/admin role check.',
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
          'The strategic cross-module view, and the only place in the product that computes real employer labour cost outside a finalized Payroll Run. Two KPI rows — Profitability (Revenue, Food Cost %, Labour Cost %, Prime Cost %, True Net Margin %) and Operations (Wastage Value, Items Below Par, Overdue Payables, Purchases split Cash/Credit) — every tile month-to-date on the open period, and almost all of them clickable through to the page that owns the number.',
        workflow: [
          'Loads the open period automatically. No open period shows a banner linking to Periods rather than a page of dashes.',
          'Read top-left to bottom-right: Revenue sets the denominator, Food Cost and Labour are the two controllable costs, Prime Cost is their sum, True Net Margin is what is actually kept.',
          'Click any tile to land on the page that owns it — Sales, Variance, Payroll Run, Overheads, Wastage, Reorder, Payables.',
        ],
        fields: [
          { label: 'Labour Cost % (MTD) — an ESTIMATE, and it says so', desc: 'Prorates each employee\'s monthly-equivalent gross by days elapsed, adds actual approved OT for the period (not prorated) and prorated employer SSF. It refines to the exact figure once Payroll Run is finalized. Daily and hourly staff are deliberately simplified — a standard day every elapsed day, rather than a real attendance lookup.' },
          { label: 'Prime Cost % and True Net Margin % both CONTAIN that estimate', desc: 'Both say so inline, under the number, not in a hover tooltip. A figure carrying a red/amber/green verdict has to disclose its basis where it is read — a print or a screenshot loses a hover.' },
          { label: 'True Net Margin needs Overheads', desc: 'Overheads is a Growth+ IMS feature. Without it the tile reads "—" with "Requires Overheads" beneath, rather than a margin silently computed as though fixed costs were zero. With Overheads but nothing entered, it says "Excludes overhead — not entered", which is a different fact.' },
          { label: 'Food Cost % banding', desc: 'Coloured against the client\'s OWN fc_warning_pct / fc_critical_pct from Settings (defaults 35 / 45) — the same scale Variance and Recipes use — with a ✓ / △ / ▲ marker beside the colour so the verdict survives colour-blindness and a black-and-white print.' },
        ],
        formulas: [
          'Food Cost % = net purchases ÷ revenue × 100. Labour Cost % = prorated labour ÷ revenue × 100.',
          'Prime Cost % = Food Cost % + Labour Cost %. Benchmark 60–65% for Nepal F&B.',
          'True Net Margin % = (revenue − food cost − labour − overheads) ÷ revenue × 100.',
          'Labour accrual: per employee, (monthly-equivalent gross ÷ days in BS month) × days actually worked inside the elapsed window, + approved OT this period + prorated employer SSF.',
        ],
        gotchas: [
          'A mid-month joiner accrues only from join_date, and an employee deactivated mid-period is still counted for the days they worked — but ONLY when end_date is actually set and falls inside the period. Deactivating flips status without populating end_date, so a stale or unset end_date must never be read as "worked the whole month".',
          'Needs BOTH modules. A client with only one gets a named banner saying which is missing, because the old behaviour — every KPI showing "—" plus a "no open period" warning — pointed at the wrong cause entirely.',
          'Overdue Payables means credit purchases unpaid for more than 60 days. Purchases · Cash / Credit splits net PURCHASES by payment method; it is not a revenue split.',
        ],
        connections: 'Reads IMS (sales entries, purchases, stock, wastage, par levels, overheads, payables) and HR (employees, salary components, approved overtime) together — the combination is the point. Links out to Sales, Variance, Payroll Run, Overheads, Wastage Report, Reorder Report and Payables.',
      },
      {
        id: 'owner-report',
        title: 'Monthly Owner/Manager Report',
        route: '/owner-report',
        plan: 'Crest Suite Pro · Owner or admin · needs IMS',
        summary:
          'The month\'s formal report, captured as a FROZEN SNAPSHOT when the period closes and never recomputed afterwards — even if the underlying data is later corrected in place. That is the whole design: it is the document that was issued, not a live query dressed as one. Every other page in the product is the opposite.',
        workflow: [
          'Generated automatically at period close. Select a closed period to read the artifact that close produced.',
          'Print it or export to Excel with the client letterhead; the workbook states the period it covers.',
        ],
        fields: [
          { label: 'Why frozen', desc: 'A report an owner acted on in Bhadra must still say in Kartik what it said in Bhadra. A live recompute means the same "Bhadra report" quietly changes every time someone fixes an old purchase bill, and nobody can tell which version a decision was made against.' },
          { label: 'Display values resolved at generation time', desc: 'Names of vendors, items and categories are written into the snapshot, not looked up on read — otherwise renaming a vendor rewrites history.' },
          { label: 'Estimated labour is labelled inline', desc: 'When no payroll was finalized for the period the report prints "· estimated — no payroll finalized for this period" beside the figure, in the document itself.' },
        ],
        formulas: [
          'Every figure is read from the stored snapshot. There is no recomputation path, deliberately.',
        ],
        gotchas: [
          'Closing a period WITHOUT a closing stock count freezes "closing stock = 0 for every item" into this report, and COGS subtracts closing stock. Periods preflights the count and states what it found inside the close confirmation, red when nothing is counted — it informs, it never blocks, because an admin correcting history legitimately closes uncounted months.',
          'Any figure that values items must filter on active items — an inactive item valued into a frozen snapshot cannot be corrected later, because nothing recomputes it.',
          'Correcting the underlying data does NOT correct this report. Reopening and re-closing the period is what regenerates it.',
        ],
        connections: 'Minted by Periods at close. Reads the IMS period data; documented in depth in .claude/rules/owner-report.md. Distinct from Consolidated P&L, which is live and recomputes on every load.',
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
          'Colour is decided centrally by lineColor(line, amount), and the `strong` flag is NOT something a caller may force. It tests strong-and-positive BEFORE the cost flag, so forcing strong painted every positive consolidated figure success-green — COGS, Wastage, Labour and Tax & Fees all rendering as green parentheses while the identical line sat grey one column left. To a reader comparing branches that made the whole consolidated column read as good news; to an accountant, parenthesised-and-green reads as a credit. If a column needs weight, set fontWeight.',
          'JSX children are an ARGUMENT, not a lazy block: passing the whole table as ReportPage children meant it was fully evaluated before the wrapper\'s loading gate could suppress it, and the page crashed on every visit for a single-outlet client. A gate inside a wrapper cannot protect an eagerly-evaluated children expression — use an early return or a guard at the call site.',
          'Banners are no longer rendered over the error card. A banner derived from state set BEFORE the read printed "the statement is reliable once the period is closed" directly above "nothing here is a real figure — this is a failed read".',
        ],
        connections: 'Reads IMS periods, purchases, sales, stock, wastage, staff meals and overheads, plus HR payroll for the labour line. Group columns come from get_group_pnl(). Shares its revenue and COGS rules with Monthly Summary.',
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
          'A group of outlets is several clients rows joined by clients.group_id. An Owner switches between them from the sidebar and every scoped query re-points at the selected outlet. The architecture is SELECTED-OUTLET INDIRECTION, not policy rewriting: profiles.active_client_id was added and only my_client_id() changed, to coalesce(active_client_id, client_id). Every one of ~151 policy references keeps its exact shape and resolves to the selected outlet.',
        workflow: [
          'Admin links outlets by setting clients.group_id. Both new columns default NULL, so an ungrouped client is byte-identical to before — which is what made this safe to ship across the whole book at once.',
          'The Owner picks an outlet in the sidebar; the whole app re-scopes. The Group Console rolls the group up.',
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
          'clients_select is the one policy that had to widen: it was "my client or admin", so an Owner could not read that a sibling outlet existed at all.',
          'Three defects sat in this feature from S548 until S617 and none were reachable, because no client has ever had a group_id. A feature with no users accumulates faults that every review passes over — worth knowing as a shape, not just as history.',
        ],
        connections: 'Underpins the Group Console, Outlet Access and the HQ→branch master-data push below. Consolidated P&L\'s group columns ride on the same group_id.',
      },
      {
        id: 'group-dashboard',
        title: 'Group Console',
        route: '/group-dashboard',
        plan: 'Crest Suite Pro · Owner or admin · needs IMS',
        summary:
          'The roll-up across a group for one BS month: group Revenue, Food Cost %, Labour % and Covers, then a per-outlet table (Revenue, Net Purchases, Food Cost %, Payroll, Labour %, Covers). Below it sit the two group admin panels — Outlet Access and Push master data.',
        workflow: [
          'Pick a BS month and year, then Refresh. The outlet you are currently viewing is marked in the table.',
          'Read the coverage banner FIRST — it is deliberately above the figures, not a footnote.',
        ],
        fields: [
          { label: 'Coverage is stated before the totals', desc: 'Outlets without Suite Pro are named and excluded; outlets with no period open for that month are named and count as zero. A group total that silently omits an outlet is worse than no total.' },
          { label: 'Group percentages are computed on group totals', desc: 'Not as an average of each outlet\'s percentage — otherwise a small outlet swings the group figure as hard as a large one.' },
          { label: 'Not a group? Not an error', desc: 'An outlet with no group_id gets an explanation, not an empty table.' },
        ],
        formulas: [
          'Group Food Cost % = group net purchases ÷ group revenue × 100. Group Labour % = group finalized payroll ÷ group revenue × 100.',
        ],
        gotchas: [
          'Group-spanning reads cannot go through the normal scoped query layer, and that is intended. get_group_summary() is a SECURITY DEFINER function with its own caller check; it returns RAW aggregates (the page derives the percentages, so this never becomes a fourth definition of those formulas) and filters to suite_plan = \'pro\' SERVER-side. A client-side filter would ship an unpaid outlet\'s revenue to the browser and then hide it.',
          'pos_orders has no period_id or BS columns — only an AD closed_at — and BS→AD conversion lives in JS, so the RPC takes an AD date range from the caller rather than a period.',
          'Never .toISOString() a Date that came from a BS conversion: it returns local midnight, and at Nepal\'s UTC+05:45 that lands on the previous day. This page reintroduced that bug once and shifted both bounds of the comparison by a day.',
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
          'Tick an outlet for a staff member to grant reach. Untick to revoke.',
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
        connections: 'Feeds the sidebar outlet switcher. Rank still comes from the three role axes on the staff account itself.',
      },
      {
        id: 'master-push',
        title: 'Push master data (HQ → branch)',
        route: '/group-dashboard',
        plan: 'Crest Suite Pro · Owner or admin',
        summary:
          'Pushes categories, items and recipes from one outlet to another in a group. Always previews before it writes, and three of its refusals are the rules rather than the implementation.',
        workflow: [
          'Pick the source and target outlet and what to push. Read the preview — every create, update and adopt is listed.',
          'Apply. The write pass applies exactly the rows the preview computed.',
        ],
        fields: [
          { label: 'The preview IS the plan', desc: 'A dry run computes into a temp table with pure SELECTs, and the write pass applies from that same table. Two implementations of "what will happen" is how a preview comes to lie.' },
          { label: 'Matching is on master_id', desc: 'items and recipes have no unique name constraint (only categories does). The one exception: the first push into a branch that already has data has no master_id yet, so it matches by NAME once, calls it "adopt", and shows every one in the preview before writing.' },
        ],
        formulas: [],
        gotchas: [
          'items.rate is NEVER pushed on update. That is what the BRANCH pays its own supplier and the input to every costing figure it produces — HQ\'s rate would put another city\'s prices into its food cost. It is seeded on create only, because the column is NOT NULL.',
          'Selling price is a separate opt-in, never swept along with the recipe definition.',
          'An ingredient with no counterpart at the branch is REPORTED, never dropped. A recipe costed from a silently-shortened list is the wrong-number-nobody-questions shape.',
        ],
        connections: 'Writes into the target outlet\'s IMS master data — Item Master, Categories and Recipes. Everything downstream of those (costing, stock, reports) then reads the pushed rows normally.',
      },
    ],
  },
]
