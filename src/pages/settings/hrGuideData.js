// Crest HR — deep per-page reference for Admin Settings → Guides → Crest HR.
// Same shape and voice as imsGuideData.js: groups mirror Layout.js's HR_GROUPS nav order, and
// every section defines all 10 keys (ModuleGuideTab renders `.length` with no null guards).
// HR is a FLAT module (clients.hr_enabled only, no plan tiers), so the `plan` chip carries the
// RANK gate instead — hr_role staff/supervisor/manager is the real access axis.

export const HR_GUIDE_GROUPS = [
  // ───────────────────────────── Overview ─────────────────────────────
  {
    key: 'overview',
    label: 'Overview',
    sections: [
      {
        id: 'overview',
        title: 'How the HR module fits together',
        route: null,
        plan: null,
        summary:
          'Crest HR is a Nepal-first payroll and workforce system: Bikram Sambat months, Labour Act 2074 leave and minimum-wage rules, SSF (Social Security Fund) contributions, and IRD income-tax withholding are built into the arithmetic rather than left to the operator. It is sold flat — a client either has HR (hr_enabled) or does not; there are no Starter/Growth/Pro tiers inside it.',
        workflow: [
          'Set up people first: Employees (the master record), then Pay Setup (basis, basic salary, allowances, SSF enrolment + registration number). Nothing pays correctly until Pay Setup is complete.',
          'Day to day: Roster plans shifts, Attendance records reality (or is generated from the roster), Leave and Overtime run their own approval ladders, and the Holiday Calendar feeds both OT rates and demand forecasting.',
          'At month end: Payroll Run generates a draft, the manager reviews per-employee TDS/TADA, and Finalize locks it — writing advance repayments and closing payroll-paid TADA claims in the same act.',
          'Everything downstream reads finalized payslips: HR Reports (SSF challan, bank transfer, TDS certificate), Festival/Incentive TDS projections, the HR Dashboard cards, and each employee\'s own Self-Service payslip tab.',
        ],
        fields: [
          { label: 'Two kinds of login', desc: 'HR STAFF (people who administer HR — run payroll, approve leave) sign in with email + password at the main /login, created from HR Staff. EMPLOYEES use Self-Service — a public per-company link with a 4-6 digit PIN — to see their own payslips, leave, TADA and roster. An owner uses neither: they already resolve to Manager rank on everything.' },
          { label: 'The rank axis (hr_role)', desc: 'staff < supervisor < manager, NULL = no HR access at all. Each page states its minimum below. Assigning an hr_role to the OWNER\'s own login demotes them out of Owner-level access entirely — staff roles are for staff accounts, never the owner\'s.' },
          { label: 'status vs access_blocked — the distinction that matters most', desc: 'hr_employees.status (active/probation/inactive) is PAYROLL ELIGIBILITY — Payroll Run, Payroll Calculation and Final Settlement all filter their pickers on it. access_blocked is the SELF-SERVICE LOGIN gate. Two different columns, two different Deactivate buttons (Edit form vs Employees\' bulk bar). Conflating them once dropped a resigned employee out of their own final payroll run.' },
        ],
        formulas: [
          'The payroll spine: Roster/Attendance/Leave/Overtime → Payroll Run draft → Finalize → payslips → Reports / Self-Service / next month\'s YTD tax base.',
        ],
        gotchas: [
          'Approved Overtime SUPERSEDES attendance-sheet OT on the same day — they are never added together. The 2× holiday rate is only reachable through the Overtime module.',
          'Approving leave writes real attendance rows; un-approving DELETES them (a blank day, not a guessed status).',
          'Payroll Run refuses to finalize a stale draft — if pay inputs changed since Generate, the only path forward is Regenerate. There is deliberately no "proceed anyway".',
        ],
        connections: 'HR shares the login and profile system with IMS/POS (one account can hold several module roles), reads the same BS calendar utilities, and feeds labour cost into the Owner Dashboard and Monthly Owner Report when the client also runs Crest Suite.',
      },
      {
        id: 'hr-dashboard',
        title: 'HR Dashboard',
        route: '/hr/dashboard',
        plan: 'Supervisor+',
        summary:
          'The operational HR console — not a glance page. An approvals KPI row (pending Leave / Overtime / TADA / shift-swap counts), employee statistics, the SSF deposit-deadline card, outstanding advances, the last finalized payroll, and act-on-it queue tables for each pending pile.',
        workflow: [
          'Open it daily: each KPI in the approvals row links to the page where that queue is cleared.',
          'The SSF card tracks the statutory deposit deadline — the 15th of the month FOLLOWING the payroll month — and shows overdue / due-soon / upcoming state relative to today.',
          'Retiring-soon surfaces employees within 180 days of their retirement date.',
        ],
        fields: [
          { label: 'Pending swap count', desc: 'Counts only swaps at pending_admin — a swap still waiting on the target coworker\'s consent (pending_target) is not yet HR\'s to action, so it does not inflate the queue.' },
        ],
        formulas: [
          'SSF deposit deadline = 15th of the month after the payroll month, from the last finalized run.',
        ],
        gotchas: [
          'Amber means "a queue is waiting", red is reserved for genuinely overdue — a pending approval pile is normal operations, not an error state.',
          'The SSF card only alarms when the deposit amount is above zero — a client with no SSF-enrolled staff never sees a red "missed deadline" for NPR 0.',
        ],
        connections: 'Counts come from the same shared approval-count hook the client Dashboard\'s HR column uses, so the two can never disagree. Cards link to Leave, Overtime, TADA Claims, Roster (swaps), Advances and Payroll Run.',
      },
    ],
  },

  // ───────────────────────────── People ─────────────────────────────
  {
    key: 'hr-people',
    label: 'People',
    sections: [
      {
        id: 'employees',
        title: 'Employees',
        route: '/hr/employees',
        plan: 'Manager only',
        summary:
          'The employee master: every person on the books, with search and filters (status, supervisor, retiring-only), an add/edit drawer, a printable Employee Joining Form, and the controls for employee Self-Service logins — enable with a PIN, bulk block/unblock, or remove.',
        workflow: [
          'Add employees here first — every other HR page keys off this record. Department, supervisor, join date, retirement date and status all matter downstream.',
          'Enable Self-Service per employee: set a 4-6 digit PIN, then share the ONE login link (or QR) the whole company uses — each employee picks their own name on it. Employees log in from their own phones; there is no device setup.',
          'The checkbox column + bulk bar Deactivate/Activate toggles Self-Service LOGIN access (access_blocked) for many employees at once.',
          'Print the Joining Form from the drawer for a paper personnel file.',
        ],
        fields: [
          { label: 'Status (active / probation / inactive)', desc: 'Payroll eligibility. Payroll Run, Payroll Calculation and Final Settlement include active + probation only. The Edit form\'s Deactivate/Activate buttons flip this — use them when someone leaves or returns.' },
          { label: 'Bulk Deactivate / Activate (access_blocked)', desc: 'Blocks or restores Self-Service LOGIN only — status is never touched, so blocking a leaver\'s login can never remove them from their own final payroll. A blocked employee sees the same generic "Invalid credentials" as a wrong PIN.' },
          { label: 'Remove Self-Service', desc: 'Deletes the login account outright (different from blocking, which suspends it). The employee record, payslips and leave history all survive either way.' },
          { label: 'Retirement date / retiring filter', desc: 'The retiring-only filter and the Dashboard card both use a 180-day window.' },
        ],
        formulas: [
          'The payroll-amount stat sums basic salary over active + probation employees only.',
        ],
        gotchas: [
          'Deleting an employee loses their history — prefer status Inactive in almost every real case, exactly like Item Master\'s Hide-vs-Delete rule in IMS.',
          'Self-Service status per employee is read through a dedicated RPC because the profiles table\'s security only lets an account read its own row — a raw query would show every employee as having no login.',
        ],
        connections: 'Feeds every HR page. status → Payroll Run / Calculation / Settlement pickers; access_blocked → Self-Service login only; join date → payroll proration; retirement date → Dashboard; department/supervisor → Roster and filters.',
      },
      {
        id: 'pay-setup',
        title: 'Pay Setup',
        route: '/hr/pay-setup',
        plan: 'Manager only',
        summary:
          'Per-employee salary structure: pay basis (monthly / daily / hourly), basic salary, Dearness Allowance and other allowance/deduction components, SSF enrolment plus the SSF registration number, and bank details for the transfer sheet. Excel export included. This page decides what every payroll figure means.',
        workflow: [
          'Click a row to open the pay drawer. Set the basis first — it changes what "basic" means (per month, per day, or per hour).',
          'Add salary components: each is a flat NPR amount or a percentage of basic; allowances add to gross, deductions subtract from net.',
          'For SSF staff, tick enrolment AND enter the SSF registration number — this is the only place the number is ever entered, and payroll refuses to deduct SSF without it.',
        ],
        fields: [
          { label: 'Pay basis', desc: 'Monthly staff get gross = basic + allowances with absence deductions; daily staff are paid per day worked; hourly staff per hour worked. Daily/hourly rows show only the rate plus an estimate (rate × 26 days, or × 8h × 26) and are excluded from the page totals.' },
          { label: 'SSF enrolment + SSF No.', desc: 'Both are required before payroll deducts the employee\'s 11% — a flag with no number used to withhold money the SSF challan sheet never claimed. Deducting nothing is the recoverable direction.' },
          { label: 'Dearness Allowance', desc: 'A named statutory component: Nepal\'s full-time monthly minimum wage of NPR 19,550 is defined as 12,170 basic + 7,380 dearness, so the form treats it separately from other allowances.' },
        ],
        formulas: [
          'Component amount = flat value, or basic × percent for percent-of-basic components.',
          'Monthly preview: gross = basic + allowances; SSF base = min(basic, 100,000); employee 11%, employer 20%; net = gross − SSF employee share − other deductions.',
        ],
        gotchas: [
          'The form warns — without blocking — when pay falls below the legal floors: monthly basic under 12,170, the per-basis minimum wage (daily 754, hourly 101, part-time hourly 107, monthly 19,550 all-in), or basic under 60% of gross (a Labour Act rule: benefits are computed on basic, so a low basic quietly undercuts leave encashment, gratuity and festival allowance).',
          'Minimum wages were last revised Shrawan 1, 2082 and are reviewed every two years — next review Shrawan 2084. The constants live in one payroll-constants file when they change.',
        ],
        connections: 'Basic, basis, components, SSF fields and join date drive Payroll Run, Payroll Calculation, Gratuity, Festival Allowance, Final Settlement and the Roster\'s labor-cost forecast. Bank details feed HR Reports\' Bank Transfer tab.',
      },
      {
        id: 'holidays',
        title: 'Holiday Calendar',
        route: '/hr/holidays',
        plan: 'Staff+ (all HR logins)',
        summary:
          'The per-fiscal-year list of company holidays, typed Public (gazetted — banks closed, statutory) or Optional (floating), each with an optional demand multiplier for forecasting. The only HR page open to staff rank, so anyone can check what is coming.',
        workflow: [
          'Pick the BS fiscal year, add holidays with month/day, type, and (optionally) a demand multiplier — e.g. 1.5 for a day you expect 50% more covers.',
          'Five fixed national days can be seeded automatically: Constitution Day (3 Ashwin), Prithvi Narayan Shah\'s Birthday (27 Poush), Martyrs\' Day (5 Magh), Democracy Day (7 Falgun), Republic Day (15 Jestha).',
        ],
        fields: [
          { label: 'Public vs Optional', desc: 'Public (gazetted) entries are what the Overtime module reads to auto-suggest the 2× holiday OT rate. Optional holidays are informational.' },
          { label: 'Demand multiplier', desc: 'Feeds the Suite Demand Forecast and the Roster\'s forecast overlay — a way to encode "Dashain week runs hot" once.' },
        ],
        formulas: [
          'Fiscal-year day resolution: a month ≥ Shrawan (month 4) belongs to the FY\'s starting BS year; Baisakh–Ashadh belong to the following BS year — which is why Republic Day (15 Jestha) lands a year later than the FY label suggests.',
        ],
        gotchas: [
          'If this calendar is left empty, Overtime never offers the 2× holiday rate — the 1.5× weekday rate is all anyone gets, silently.',
          'Days are validated against the real BS month length (28-32 days) — there is no 30-day assumption anywhere in the module.',
        ],
        connections: 'Public entries → Overtime\'s holiday-rate auto-suggest → payroll OT amounts. Demand multipliers → Demand Forecast and Roster planning.',
      },
    ],
  },

  // ───────────────────────────── Attendance ─────────────────────────────
  {
    key: 'hr-attendance',
    label: 'Attendance',
    sections: [
      {
        id: 'roster',
        title: 'Staff Roster',
        route: '/hr/roster',
        plan: 'Supervisor+',
        summary:
          'The shift board: assign shift types to employees per day in week or month view, drag to fill ranges, copy a whole week onto the next one, publish days to employees\' Self-Service, approve shift swaps, and see a planned-labor-cost forecast with the demand overlay from the Holiday Calendar and Demand Forecast.',
        workflow: [
          'Define shift types once (name, start/end, colour) in the shift settings panel; assign them to cells by click or drag-select (touch devices get an explicit tap-first/tap-last "Select range" mode).',
          'Publish when a stretch is ready — publishing is per DAY, and only scheduled staff on those days are notified (web push where enabled).',
          '"Suggest" ranks unscheduled employees by fewest hours already scheduled this period, within whatever the Department filter shows.',
          '"⧉ Copy to Next Week" (weekly view) stamps the whole visible week onto the following week, same weekday to same weekday, then lands on it so the exceptions get edited on a real board.',
          'Approve or reject employee-initiated shift swaps from the swap panel once the target coworker has consented.',
        ],
        fields: [
          { label: 'OFF DAY vs Clear (Unassign)', desc: 'OFF DAY writes a real zero-hour row — the day shows on the board, in Generate-from-Roster, and in the employee\'s own Self-Service view. Clear deletes the row entirely (an unplanned blank). They are not the same thing.' },
          { label: 'Publish state (per day)', desc: 'Self-Service only ever returns PUBLISHED days — employees can never see a draft, and un-published edits stay invisible to them.' },
        ],
        formulas: [
          'Planned labor cost per day = Σ over scheduled employees of (hourly rate derived from their pay basis) × shift hours — the same hourly-rate rule payroll itself uses, so plan and payroll can\'t disagree on what an hour costs.',
        ],
        gotchas: [
          'Assigning a shift on a day with APPROVED leave prompts a confirm (override allowed — someone has to cover Dashain); clearing a cell never prompts.',
          'Off days are per employee, not a company-wide weekday — there is no global "Saturday off" switch anywhere in the module.',
          'Copy to Next Week MIRRORS: a cell that is empty this week is cleared next week, so the two weeks end up identical rather than merged. The confirm dialog counts what will be replaced and cleared first, and warns if the target week is already published (staff saw the old version — Re-Publish + Notify afterwards) or if anyone has approved leave on a day being filled.',
          'It copies only what the Department filter is showing. With a filter on, the other departments\' next week is left exactly as it was.',
        ],
        connections: 'Shift length feeds Attendance\'s OT auto-calculation and Generate-from-Roster. Published days feed Self-Service\'s Roster tab. The labor forecast reads Pay Setup rates; the demand overlay reads Holiday Calendar multipliers and the Suite Demand Forecast.',
      },
      {
        id: 'attendance',
        title: 'Attendance',
        route: '/hr/attendance',
        plan: 'Supervisor+',
        summary:
          'The daily record payroll is computed from. Three modes: Mark Attendance (everyone × one day), By Employee (one person × the whole month), Month Summary. Each cell holds a status, start/end times, break minutes, hours worked, OT hours and a note.',
        workflow: [
          'Mark the day\'s statuses — Present, Half Day, Absent, Paid/Unpaid Leave (full or half), Off, Holiday. Bulk-fill a day or a month, or "Generate from Roster" to seed the sheet from published shifts.',
          'Enter start/end times and the sheet derives hours; OT is auto-suggested as hours beyond that day\'s rostered shift length (or beyond 8h if unrostered) — both stay editable.',
          'Clear Day / Clear Employee-Month genuinely delete rows, for redoing a botched stretch.',
        ],
        fields: [
          { label: 'Statuses', desc: 'present, half_day, absent, paid_leave, unpaid_leave, half_paid_leave, half_unpaid_leave, weekly_off ("Off"), holiday. The half-leave pair exists so a half-day leave request lands as exactly half a day\'s pay effect.' },
          { label: 'Time shorthand', desc: 'Time boxes accept colon-free entry — 0800, 800 or 08 all read as 08:00 — and tolerate the seconds the database echoes back. An incomplete time never reaches the record.' },
          { label: 'OT hours', desc: 'Auto-calculated as a SEED (beyond rostered shift length, else beyond 8h), then editable. Attendance OT always pays 1.5× — the 2× holiday rate only exists in the Overtime module.' },
        ],
        formulas: [
          'Hours = (End − Start) − break minutes, floored at 0.',
          'OT suggestion = max(0, hours worked − rostered shift hours), or − 8 when unrostered.',
        ],
        gotchas: [
          'Untouched cells stay EMPTY, never auto-Present — Save writes only cells someone actually touched, so nobody gets paid for a day nobody marked. "— Not marked —" plus the row-delete button is the honest blank state.',
          'Generate from Roster fills GAPS only and never overwrites a manual entry: a shift with hours becomes Present, a zero-hour shift named like an off day becomes Off, any other zero-hour shift becomes Holiday, and a day with no roster row is left blank for manual entry.',
          'Working fewer hours than rostered is a visible shortfall nudge, never an automatic pay deduction — Nepal\'s Labour Act defines only full-day absence deductions, and inventing an hourly proration would be making up law.',
          'Attendance is one row per employee per day, so a month\'s sheet crosses the database\'s silent 1,000-row page size at roughly 34 staff — every read here is paged for that reason. A truncated read once paid daily staff zero and monthly staff a full month with no deductions.',
        ],
        connections: 'The direct input to Payroll Run and Payroll Calculation (statuses, hours, OT). Written by Leave approvals (and deleted by un-approvals). Seeded by the Roster. Approved Overtime entries supersede this sheet\'s OT on their days.',
      },
      {
        id: 'leave',
        title: 'Leave',
        route: '/hr/leave',
        plan: 'Supervisor+',
        summary:
          'Leave types, requests and balances. Types are auto-seeded to Labour Act 2074 defaults on first visit: Home/Annual 18 days (carries forward), Sick 12 (carries forward), Bereavement/Kiriya 13, Maternity 98, Paternity 15, and uncapped Unpaid.',
        workflow: [
          'Requests arrive from Self-Service (or are entered here on behalf of an employee) and sit pending until a supervisor approves or rejects.',
          'Approving writes the matching attendance rows for every day in the range, using the leave type\'s paid/unpaid nature.',
          'Balances show quota, used and remaining per employee per type for the BS year.',
        ],
        fields: [
          { label: 'Half day', desc: 'Counts 0.5 and is only offered on a single-day request — a multi-day range is forced back to full days. First/second half is record-keeping only; pay only distinguishes full vs half.' },
          { label: 'Quota 0 = uncapped', desc: 'The Unpaid type ships with quota 0, meaning no cap — it reduces pay, so it needs no rationing.' },
        ],
        formulas: [
          'Days = every calendar day in the inclusive range. No weekday is assumed off — off days are explicit per employee on the roster, so a "Saturday" inside a leave range is a real leave day unless that employee\'s roster says otherwise.',
          'Used = Σ approved request days for the employee + type whose start date falls in the BS year.',
        ],
        gotchas: [
          'Un-approving DELETES the attendance rows the approval wrote rather than guessing a prior status back — the pre-leave state was never recorded, so a blank "needs manual entry" day is the only honest result.',
          'Deciding a request re-reads its current status from the database first, so two supervisors working the same queue can\'t double-process one request.',
        ],
        connections: 'Approval writes hr_attendance (which payroll reads). Balances and request submission also surface in the employee\'s Self-Service Leave tab. The Roster warns when a shift is assigned over approved leave.',
      },
      {
        id: 'overtime',
        title: 'Overtime',
        route: '/hr/overtime',
        plan: 'Supervisor+',
        summary:
          'Per-employee, per-day OT entries with their own approval ladder (pending → approved / rejected) and an estimated pay preview. This is the module that exists so extraordinary OT — especially holiday OT at double rate — is an approved, attributable record rather than a number typed into the attendance sheet.',
        workflow: [
          'Add an entry: employee, BS day, hours, type (weekday or holiday). The type auto-suggests Holiday when the date matches a gazetted entry in the Holiday Calendar.',
          'A manager approves or rejects; the estimated amount previews what payroll will pay.',
        ],
        fields: [
          { label: 'OT type', desc: 'Weekday pays 1.5×; holiday pays 2×. The 2× rate is reachable ONLY through this module — the attendance sheet\'s OT column always pays 1.5×.' },
        ],
        formulas: [
          'Hourly rate by basis: hourly staff → basic; daily → basic ÷ 8; monthly → basic ÷ (days in the BS month × 8).',
          'Estimated amount = hours × hourly rate × multiplier (1.5 or 2.0).',
        ],
        gotchas: [
          'An APPROVED entry supersedes the attendance sheet\'s OT for that same day — payroll withholds the attendance figure rather than paying both. They used to be added together, which double-paid OT; the supersede rule made that structurally impossible.',
          'Editing an entry keeps its existing status; only new entries start pending. The day field is validated against the real BS month length.',
        ],
        connections: 'Reads the Holiday Calendar (gazetted days → 2× suggestion). Approved entries flow into Payroll Run/Calculation per day, superseding attendance OT. Pending count surfaces on the HR Dashboard.',
      },
    ],
  },

  // ───────────────────────────── Payroll ─────────────────────────────
  {
    key: 'hr-payroll',
    label: 'Payroll',
    sections: [
      {
        id: 'payroll-run',
        title: 'Payroll Run',
        route: '/hr/payroll',
        plan: 'Manager only',
        summary:
          'The transactional payroll page: Generate a draft for the BS month, review each employee\'s row (TDS and TADA are editable), Finalize to lock it, and Reopen to unwind (HR manager or above — it used to be Crest-admin only, which locked the owner out of their own correction). Payslips print with the company letterhead; the run exports to Excel.',
        workflow: [
          'Generate builds a draft from current Attendance, approved Overtime, Advances and approved TADA. Review the rows; edit TDS or TADA where judgment is needed.',
          'Finalize shows a consequence summary — payslip count, total net pay, advance recoveries to be recorded, TADA claims to be closed — because these are real writes to other ledgers, then locks the run.',
          'Reopen (HR manager and above, S620) reverses exactly what Finalize wrote: deletes its advance-repayment rows (reactivating anything with balance again), and un-pays only TADA claims IT marked paid — never one a manager settled by hand.',
          'Regenerate rebuilds the draft from scratch — and resets any manual TDS/TADA edits, with an explicit confirm.',
        ],
        fields: [
          { label: '⚠ SSF no. missing', desc: 'Flags an SSF-enrolled employee with no registration number — payroll deducts nothing for them (the recoverable direction) until the number is entered in Pay Setup.' },
          { label: 'TADA column', desc: 'Auto-filled from approved claims whose trip dates fall in the month, added AFTER tax — TADA is a reimbursement, never taxable income. Zeroing it out here leaves the claim open for cash settlement instead.' },
        ],
        formulas: [
          'On Finalize: payslips lock; one repayment row per active advance at min(installment, outstanding) — idempotent, so a Reopen + re-Finalize never doubles them; advances reaching zero auto-settle; auto-filled TADA claims are marked paid via payroll.',
        ],
        gotchas: [
          'Finalize is BLOCKED outright while the draft is stale — the page recomputes every employee live through the same code that generated the draft and compares net pay; any mismatch, or an employee added since Generate, names itself in an amber banner pointing at Regenerate. There is deliberately no "finalize anyway": a stale draft pays wrong money.',
          'Once finalized, the run is the permanent record — Payroll Calculation\'s Stale badge comparing it against live data is a prompt to investigate, not proof the payslip is wrong (the live data may have changed after a legitimate close).',
        ],
        connections: 'Reads Attendance, Overtime (approved, per-day supersede), Pay Setup, Advances, TADA Claims. Finalized payslips feed HR Reports, Festival/Incentive tax projections, Self-Service payslips, and the Dashboard\'s SSF-deadline card.',
      },
      {
        id: 'payroll-calculation',
        title: 'Calculation (Payroll Review)',
        route: '/hr/calculation',
        plan: 'Manager only',
        summary:
          'The read-only companion to Payroll Run: it never writes anything. It recomputes every figure live from current Attendance/Roster/Overtime/Advances through the identical engine, shows the complete working step by step (printable), and compares the result against the stored payslip.',
        workflow: [
          'Pick the month and an employee to see every intermediate: gross build-up, unpaid days, SSF base, YTD tax figures, projected annual tax, and the resulting TDS — the page to open when someone asks "why is my pay this number?".',
          'Print the working panel as the explanation sheet to hand over.',
        ],
        fields: [
          { label: '⚠ Stale', desc: 'The stored payslip\'s net pay no longer matches a live recompute (compared rounded) — pay inputs changed after Generate. The fix lives on Payroll Run: Regenerate.' },
          { label: 'Not generated', desc: 'A run exists for the month but never picked this employee up (typically added after Generate) — distinct from Stale.' },
          { label: 'OT superseded', desc: 'Shows attendance OT withheld because an approved Overtime entry covers the same day — so a figure that differs from the attendance sheet is explained rather than mysterious.' },
        ],
        formulas: [
          'Identical arithmetic to Payroll Run by construction — both call the same pure compute functions, so this page can never "disagree" with a fresh draft.',
        ],
        gotchas: [
          'Totals render only when EVERY row has a stored payslip — a partial sum would read as the month\'s total.',
          'The printable working uses no hover tooltips on purpose: hovers don\'t print, so every explanation is a visible row or caption.',
        ],
        connections: 'Same inputs as Payroll Run. The Stale badge is the review-side of Payroll Run\'s finalize-block — one detects drift, the other refuses to lock it in.',
      },
      {
        id: 'pay-engine',
        title: 'How pay is calculated',
        route: null,
        plan: 'Reference — applies to every payroll figure',
        summary:
          'The payroll engine is a set of pure functions — no screen edits its rules. Three pay bases, SSF, join-date proration and Nepal income tax (TDS) in one place, so Payroll Run, Calculation, and the Roster\'s cost forecast all mean the same thing by "a day\'s pay".',
        workflow: [
          'MONTHLY: gross = basic + allowances. Unpaid days = absences + unpaid leave + half of each half-day + days before the join date. Absence deduction = (gross ÷ days in the BS month) × unpaid days — allowances are forfeited too, not just basic. SSF base = min(basic × paid fraction, 100,000). Net = gross + OT − absence − SSF 11% − other deductions − TDS − advance recovery.',
          'DAILY: paid days = present + half days × 0.5 + paid leave (paid leave IS paid for daily staff) + half paid leave × 0.5. Earned = daily basic × paid days. No absence deduction, no allowances. OT at (basic ÷ 8) × 1.5.',
          'HOURLY: paid hours = hours worked + paid leave × 8 + half paid leave × 4. Earned = hourly basic × paid hours. OT at basic × 1.5.',
        ],
        fields: [
          { label: 'SSF (Social Security Fund)', desc: 'Employee 11%, employer 20% (31% total on the challan), on a base capped at NPR 100,000 of basic. Deducted only when enrolment AND the registration number are both present. SSF contributors also get the 1% first tax slab (Social Security Tax) waived entirely.' },
          { label: 'Join-date proration', desc: 'Days of the month before an employee\'s join date count as unpaid days, so a mid-month hire is paid from their join date — and because SSF and TDS derive from the absence-adjusted figure, both follow automatically.' },
        ],
        formulas: [
          'TDS method: each month, project annual taxable income (YTD actuals + this month\'s rate for the remaining months), compute annual tax, take the cumulative share due through this month, subtract tax already withheld. Self-correcting: a raise mid-year adjusts the remaining months rather than back-billing.',
          'Slabs FY 2083/84 onward (unified — the married/single distinction was removed): 1% to 10 lakh · 10% to 15 lakh · 20% to 25 lakh · 27% to 40 lakh · 29% above.',
          'Slabs FY 2082/83 — single: 1% to 5 lakh · 10% to 7 lakh · 20% to 10 lakh · 30% to 20 lakh · 36% to 50 lakh · 39% above; married: +1 lakh on the first three bands.',
          'Deductible before tax: retirement contributions (SSF/EPF/CIT) up to min(500,000, annual gross ÷ 3); life insurance premium up to 40,000; health insurance up to 20,000.',
          'Annual tax is spread over months actually employed this fiscal year — not always ÷12 — so a Poush joiner doesn\'t get most of a year\'s tax front-loaded into their first paycheck.',
        ],
        gotchas: [
          'Nepal\'s fiscal year runs Shrawan → Ashadh; Shrawan is month 1 of the tax year. All YTD figures reset there, not at Baisakh.',
          'Lump sums (festival allowance, incentives, settlement items) are taxed marginally — tax(annual taxable + lump) − tax(annual taxable) — never by re-running the monthly engine.',
        ],
        connections: 'Payroll Run and Calculation call these functions directly; the Roster\'s labor forecast reuses the hourly-rate rule; Festival, Incentives and Final Settlement use the marginal lump-sum tax method on top of the same slab tables.',
      },
      {
        id: 'festival',
        title: 'Festival Allowance',
        route: '/hr/festival',
        plan: 'Manager only',
        summary:
          'The statutory festival bonus run (default Dashain), one per BS year per festival: Generate seeds each employee\'s amount, amounts and TDS are editable inline, Finalize locks the run.',
        workflow: [
          'Pick the BS year and festival, Generate, adjust any amounts (each edit recomputes its TDS automatically; editing TDS directly overrides it), then Finalize.',
        ],
        fields: [
          { label: 'Months-worked proration', desc: 'Measured to a reference date of 15 Ashwin (Dashain season), so a mid-year joiner gets a proportional bonus rather than a full month\'s basic.' },
        ],
        formulas: [
          'Amount = round(basic × months worked ÷ 12). Daily/hourly staff get 0 — there is no fixed monthly basic to base it on.',
          'TDS = the marginal lump-sum method: project annual gross from YTD finalized payslips + basic × remaining months, apply the standard deduction caps, then tax(taxable + bonus) − tax(taxable).',
        ],
        gotchas: [
          'Regenerate resets every manual edit (explicit confirm). Once every row is finalized the whole page locks.',
        ],
        connections: 'Reads finalized payslips for the YTD tax base. Final Settlement pro-rates an unpaid festival allowance using the same basic × months ÷ 12 idea.',
      },
      {
        id: 'incentives',
        title: 'Incentives / Bonus',
        route: '/hr/incentives',
        plan: 'Manager only',
        summary:
          'Ad-hoc bonus runs built from reusable incentive types ("Sales Bonus", "Attendance Bonus") defined once — each type pays a flat amount or a percentage of basic. A run is keyed by BS year + a label you choose, so several can coexist in one year.',
        workflow: [
          'Define types in the config modal (name + flat value or % of basic). Start a run: pick the type, name the run (required before Generate), Generate, adjust, Finalize.',
        ],
        fields: [
          { label: 'Calc type', desc: 'fixed = the type\'s default flat NPR value per employee; percent_of_basic = round(basic × value ÷ 100). Either way every seeded amount stays editable per row.' },
        ],
        formulas: [
          'TDS = the same YTD-marginal lump-sum method Festival Allowance uses.',
        ],
        gotchas: [
          'The tax helper here is a DELIBERATE duplicate of Festival\'s, not shared code — duplicating verified tax arithmetic was judged lower-risk than refactoring it. If tax rules change, both pages need the same fix.',
        ],
        connections: 'Reads finalized payslips for the YTD base, like Festival. Types are reusable across runs and years.',
      },
      {
        id: 'advances',
        title: 'Advances & Loans',
        route: '/hr/advances',
        plan: 'Manager only',
        summary:
          'The advance/loan ledger: issue an advance (one-time) or a loan (with an installment), record manual repayments, and watch payroll recover the rest automatically. Filters by type and by active/settled.',
        workflow: [
          'Issue: employee, type, amount, date, optional installment amount, purpose. The detail panel shows the repayment history and derived balance.',
          'Repayments arrive two ways — recorded manually here, or written automatically by Payroll Run\'s Finalize. Both live in the same repayment history.',
        ],
        fields: [
          { label: 'Installment', desc: 'The per-month payroll recovery. LEFT BLANK, the FULL outstanding balance is recovered in the next payroll — the one-time-advance behaviour. Set it for loans meant to amortize.' },
        ],
        formulas: [
          'Outstanding is always DERIVED — amount − Σ repayments. There is no stored balance column to drift out of sync.',
          'Payroll deduction per active advance = min(installment, outstanding); multiple advances for one employee sum.',
        ],
        gotchas: [
          'Finalize auto-settles an advance the moment its balance reaches zero; Reopen deletes payroll\'s own repayment rows and reactivates anything that regains a balance — manual repayments are never touched by either.',
        ],
        connections: 'Payroll Run reads active advances for the deduction and writes repayments on Finalize. Final Settlement deducts every advance\'s full outstanding. The Dashboard shows total outstanding.',
      },
      {
        id: 'tada',
        title: 'TADA Claims',
        route: '/hr/tada',
        plan: 'Supervisor+ (settings: Manager)',
        summary:
          'Travel & Daily Allowance claims: an employee (or the office, on their behalf) files a trip with line items, it climbs an approval ladder — pending → approved → paid — and approved claims auto-fill into payroll as a non-taxable reimbursement. A settings modal holds purpose options, start points and per-vehicle km rates.',
        workflow: [
          'File a claim: trip dates, purpose, start point, line items (travel legs with vehicle type and km, plus other expenses). Approve it to mark the money as owed; it then either rides into the next Payroll Run or is paid by cash/bank and marked paid by hand.',
        ],
        fields: [
          { label: 'Per-vehicle km rates', desc: 'Three fixed vehicle categories — 2-wheeler, 4-wheeler, EV — each with its own NPR/km rate set in the settings modal. Only the rates are editable, not the categories.' },
          { label: 'Status ladder', desc: 'pending → approved (money owed, not yet disbursed — amber) → paid. It is a ladder, not tags: a claim never skips approved.' },
        ],
        formulas: [
          'Travel line = km × the vehicle type\'s rate; claim total = travel lines + other expense lines.',
        ],
        gotchas: [
          'TADA is NOT month-scoped like the rest of HR — claims live on plain AD trip dates with no BS period attached; the month filter buckets them by converting the start date. Don\'t expect a claim to "belong" to a payroll period until payroll pulls it in by date range.',
          'A claim paid by cash or bank (anything other than payroll) is excluded from payroll\'s auto-fill even when its dates fall in the month — otherwise it would be reimbursed twice.',
          'Payroll adds TADA AFTER tax — it is a reimbursement of the employee\'s own money, never taxable income.',
        ],
        connections: 'Approved claims auto-fill Payroll Run\'s TADA column (and are marked paid by its Finalize). Employees file their own claims from Self-Service\'s TADA tab. Pending count surfaces on the HR Dashboard.',
      },
    ],
  },

  // ───────────────────────────── Reports ─────────────────────────────
  {
    key: 'hr-reports',
    label: 'Reports',
    sections: [
      {
        id: 'hr-reports',
        title: 'HR Reports',
        route: '/hr/reports',
        plan: 'Manager only',
        summary:
          'Six statutory and operational outputs in one page: Employee Directory, Payroll Summary, SSF Challan, Bank Transfer sheet, TDS Report, and a per-employee printable TDS Certificate for a fiscal year.',
        workflow: [
          'Pick the month (or FY for the certificate). The Directory loads independently of any payroll run; everything else reads finalized payslips.',
          'SSF Challan is the deposit sheet: per enrolled employee, the contribution base and the 11% + 20% split. Bank Transfer lists net pay against each employee\'s bank details from Pay Setup.',
        ],
        fields: [
          { label: 'TDS Certificate', desc: 'Per employee, per fiscal year — YTD withholding evidence. The company PAN in its header comes from the VAT/PAN number in Settings (Nepal uses one number for both); it prints a blank line only when genuinely unset.' },
        ],
        formulas: [
          'SSF challan row: base = min(basic, 100,000); employee 11% + employer 20% = 31% total.',
          'Employer cost (Payroll Summary) = gross + OT + employer SSF 20%.',
          'Total deductions = absence + SSF employee share + other deductions + TDS.',
        ],
        gotchas: [
          'The challan filters on enrolment AND registration number, and says "N employees without an SSF number excluded" — that count is the other half of the payroll-side SSF gate. If it is ever non-zero, someone\'s Pay Setup needs the number entered.',
        ],
        connections: 'Everything except the Directory reads finalized payslips from Payroll Run. Bank details come from Pay Setup; the PAN from Settings.',
      },
      {
        id: 'gratuity',
        title: 'Gratuity',
        route: '/hr/gratuity',
        plan: 'Manager only',
        summary:
          'A read-only accrual view of the gratuity liability across active and probation staff — who has vested, what has accrued, how much the SSF gratuity fund already covers, and the net cash exposure if everyone left today. Excel export for the accountant.',
        workflow: [
          'Filter vested / vesting / all, or by department. Nothing here writes — the actual payout happens in Final Settlement.',
        ],
        fields: [
          { label: 'Vested', desc: 'Twelve months of service or more. Under twelve, gratuity is accruing but not yet owed on exit.' },
          { label: 'SSF offset', desc: 'For SSF-enrolled staff, a slice of the employer\'s 20% already funds the SSF gratuity scheme — that portion is not a cash liability again.' },
        ],
        formulas: [
          'Accrual = basic ÷ 12 per month of service (one month\'s basic per year, 8.33%/yr). Total accrued = basic ÷ 12 × service months.',
          'SSF covered = 3.33% of min(basic, 100,000) per enrolled month. Net cash liability = max(0, accrued − SSF covered).',
        ],
        gotchas: [
          'Daily and hourly staff are excluded entirely — there is no fixed monthly basic to accrue on — and the page states how many were skipped rather than silently shrinking the roster.',
        ],
        connections: 'Final Settlement computes the individual payout with the same accrual-minus-SSF arithmetic. Basic comes from Pay Setup; service months from the join date on Employees.',
      },
      {
        id: 'settlement',
        title: 'Final Settlement',
        route: '/hr/settlement',
        plan: 'Manager only',
        summary:
          'Computes AND records a leaver\'s full and final payout — partial month, leave encashment, gratuity, festival pro-ration, less unserved notice, outstanding advances and TDS. Finalize closes the recovered advances, stamps the employee, blocks their Crest Staff login and locks the document; an admin can Reopen to reverse all of it.',
        workflow: [
          'Select the employee and inputs; the memo derives earnings (partial month, leave encashment, gratuity, festival pro-ration), deductions (notice shortfall, advances, lump-sum TDS) and the net figure, all itemized.',
        ],
        fields: [
          { label: 'Notice deduction', desc: 'Only when notice was NOT served: (basic ÷ 26) × the notice days owed — the mirror image of leave encashment\'s divisor.' },
        ],
        formulas: [
          'Partial-month salary = (basic ÷ days in the last BS month) × the last working day.',
          'Leave encashment = (basic ÷ 26) × unused leave days — the Labour Act\'s 26-working-day divisor.',
          'Gratuity (only if ≥ 12 months served) = max(0, basic ÷ 12 × service months − SSF-covered portion) — same netting as the Gratuity page.',
          'Festival pro-ration (only if not yet paid this FY) = basic × months into the FY ÷ 12.',
          'Advances: every advance\'s full outstanding is deducted.',
          'TDS = marginal lump-sum tax on (gratuity + leave encashment + festival pro-ration).',
        ],
        gotchas: [
          'The settlement TDS uses an explicit approximation for the year\'s income — basic × 12 with standard SSF assumptions — rather than reading real finalized payslips the way Festival does. For a leaver with unusual YTD income, review the TDS line by hand.',
          'The employee picker filters on status — which is exactly why blocking a leaver\'s Self-Service login must never touch status, or they vanish from this page before their own settlement is run.',
        
          'Run the settlement BEFORE marking anyone resigned/inactive. Every payroll and settlement picker filters status IN (active, probation), so deactivating first removes them from the page built for leavers.',
          'Finalize refuses on three states rather than warning: payroll already paid that final month (which would pay it ~1.5 times), a prior settlement overlaps this employment spell (which would pay gratuity twice for the same years), or the same settlement was finalized in another tab.',
          'A settlement that nets negative does NOT close the advances — recovery is capped at what the payout actually covers, and the remainder stays an open advance because the money has not been repaid.',
          'Finalized means computed and locked, not paid. Mark paid separately when the money leaves.',
        ],
        connections: 'Reads Pay Setup (basic), Employees (join date, status), Advances (outstanding), and the same tax tables as payroll. The printed memo is the exit document.',
      },
    ],
  },

  // ───────────────────────────── Admin ─────────────────────────────
  {
    key: 'hr-admin',
    label: 'Admin',
    sections: [
      {
        id: 'hr-staff',
        title: 'HR Staff & the role system',
        route: '/hr/staff',
        plan: 'Manager only',
        summary:
          'Creates real email + password logins for the people who ADMINISTER HR — run payroll, approve leave, edit pay setup. Three access levels (staff < supervisor < manager) behind client-renamable job titles. Not to be confused with Self-Service, which is an employee\'s own PIN portal enabled from Employees.',
        workflow: [
          'Add a staff login: name, email, password, job title (which carries a level). Or assign an HR role to an account that already exists for this client — that path skips account creation and just grants the role.',
          'Rename the three levels to whatever titles the business uses; changing a title\'s level cascades to every account holding it.',
        ],
        fields: [
          { label: 'Access levels', desc: 'Staff: view-only pages like the Holiday Calendar. Supervisor: attendance, leave, overtime, roster, TADA approvals, the HR Dashboard. Manager: everything — payroll, pay setup, employees, reports, this page.' },
        ],
        formulas: [],
        gotchas: [
          'Never assign an HR role to the OWNER\'s own login — Owner status is the absence of staff roles, so doing that demotes them to exactly that rank\'s access and nothing more (Suite features included). Staff rows are for staff.',
          'On load the page silently repairs any account whose stored rank disagrees with its job title\'s configured level, so a title-level edit can never leave stragglers.',
          'HR staff share the main /login with the owner and IMS staff — they are separated by role, not by entrance. Only POS and Self-Service have PIN entrances.',
        ],
        connections: 'Same pattern as IMS Staff and POS Staff — one account can hold roles in several modules independently. All account writes go through the admin Edge Function; the login list comes from a names RPC because raw profile reads are limited to the caller\'s own row.',
      },
      {
        id: 'self-service',
        title: 'HR Self-Service (employee portal)',
        route: '/hr/self-service',
        plan: 'Employees with Self-Service enabled',
        summary:
          'The employee\'s own app: today\'s shift, their published roster, leave and TADA requests, and their payslips — behind a name-picker + 4-6 digit PIN on one shared per-company link. It installs to a phone\'s home screen as "Crest Staff" with its own icon, opening full-screen on the shift they came to check.',
        workflow: [
          'The manager enables Self-Service for an employee (sets the PIN) and shares the company\'s one login link or QR. The employee opens it, taps their own name, enters the PIN.',
          'Four destinations on a bottom bar: Home (today\'s shift, the next working shift, swaps waiting on them, latest payslip), Roster (their own Sun-Sat week + swap requests), Requests (Leave and TADA, each opening as a bottom sheet), Pay (own finalized payslips, same layout as the printed one).',
          'Tell employees to add it to their home screen — on Android the account sheet offers a button, on iPhone it is Share → Add to Home Screen. On iPhone that step is also what makes notifications possible at all: iOS never gives push to a browser tab.',
        ],
        fields: [
          { label: 'PIN', desc: '4-6 digits. It is never the account\'s real password — the server verifies a peppered fingerprint of it, and the login completes server-side so the account\'s email never reaches the browser.' },
          { label: 'Lockout', desc: 'Five failed attempts locks the PIN for a period, enforced entirely server-side inside the login call — so it cannot be skipped, and a fat-fingered employee is never double-counted.' },
        ],
        formulas: [],
        gotchas: [
          'There is no "reset PIN" for Self-Service — re-enable (re-enrol) the employee from Employees instead, which sets a fresh PIN.',
          'A blocked employee (bulk Deactivate on Employees) gets the same generic "Invalid credentials" as a wrong PIN — the portal never confirms to a leaver that their account exists.',
          'The Roster tab shows PUBLISHED days only — but an unpublished day now SAYS "Not published yet" instead of looking like a day with no shift. Those two are identical in the data and mean opposite things to someone deciding whether to come in.',
          'Notifications only offer a button where pressing one can actually do something — on an iPhone opened from a chat app it explains the Home Screen step instead, because a tab on iOS has no push at all.',
          'Light or dark follows the phone\'s own setting. Employees cannot reach Settings → Appearance, so a fixed theme was the only one they could ever have.',
          'Every screen surfaces a failed load as an error rather than an empty list — "no payslips" always means no payslips, never a swallowed network failure.',
        ],
        connections: 'Payslips come from finalized Payroll Runs; leave requests land in Leave Management\'s queue; TADA claims in TADA\'s queue; roster from published Roster days; swap requests into the Roster\'s swap panel. Login enablement and blocking live on Employees.',
      },
    ],
  },
]
