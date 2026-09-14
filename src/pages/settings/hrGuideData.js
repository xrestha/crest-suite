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
          'Downstream pages read the payslips: HR Reports shows the month\'s run whether it is a draft or finalized (a draft carries a "still a draft" warning — only the TDS Certificate is finalized-only), while Festival/Incentive tax projections, the HR Dashboard\'s SSF card and each employee\'s own Self-Service payslip tab read finalized payslips.',
        ],
        fields: [
          { label: 'Two kinds of login', desc: 'HR STAFF (people who administer HR — run payroll, approve leave) sign in with email + password at the main /login, created from HR Staff. EMPLOYEES use Self-Service — a public per-company link with a 4-6 digit PIN — to see their own payslips, leave, TADA and roster. An owner uses neither: they already resolve to Manager rank on everything.' },
          { label: 'The rank axis (hr_role)', desc: 'staff < supervisor < manager, NULL = no HR access at all. Each page states its minimum below. Assigning an hr_role to the OWNER\'s own login demotes them out of Owner-level access entirely — staff roles are for staff accounts, never the owner\'s.' },
          { label: 'status vs access_blocked — the distinction that matters most', desc: 'hr_employees.status (active / probation / inactive / resigned / terminated) is PAYROLL ELIGIBILITY — only active and probation staff are picked up — Payroll Run, Payroll Calculation and Final Settlement all filter their pickers on it. access_blocked is the SELF-SERVICE LOGIN gate. Two different columns, two different Deactivate buttons (Edit form vs Employees\' bulk bar). Conflating them once dropped a resigned employee out of their own final payroll run.' },
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
          'Amber means "a queue is waiting", red is reserved for genuinely overdue — a pending approval pile is normal operations, not an error state. This is now the rule across all five HR queues and the employee app, not just this page: amber = open, brass = decided but the money has not moved, green = closed and good, red = refused, grey = withdrawn.',
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
          '"🖨 Print Joining Form" in the page header opens a BLANK joining form to print and have a new hire fill in by hand for the paper personnel file — it is not filled from any employee\'s record.',
        ],
        fields: [
          { label: 'Status (active / probation / inactive / resigned / terminated)', desc: 'Payroll eligibility. Payroll Run, Payroll Calculation and Final Settlement include active + probation only; the other three all drop out. The Edit form\'s Deactivate button (shown on an active employee) sets Inactive and its Activate button (shown on an inactive one) sets Active; Resigned and Terminated are picked from the Status list, and Final Settlement sets them itself when it is finalized.' },
          { label: 'Bulk Deactivate / Activate (access_blocked)', desc: 'Blocks or restores Self-Service LOGIN only — status is never touched, so blocking a leaver\'s login can never remove them from their own final payroll. A blocked employee sees the same "Incorrect PIN. Try again." as someone who typed a wrong PIN.' },
          { label: 'Remove Self-Service', desc: 'Deletes the login account outright (different from blocking, which suspends it). The employee record, payslips and leave history all survive either way. It is also how a forgotten PIN is replaced: there is no reset button, so Remove the login and then press Enable Self-Service again with a new PIN. (A blocked employee shows no Remove button — Activate them first.)' },
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
          '"Seed FY …" fills the whole year from the Nepal Gazette — seven fixed national days (New Year 1 Baishakh, Republic Day 15 Jestha, Constitution Day 3 Ashwin, Prithvi Jayanti 27 Poush, Maghe Sankranti 1 Magh, Martyrs\' Day 16 Magh, Democracy Day 7 Falgun) plus every gazetted movable holiday held for that BS year: Dashain, Tihar, Chhath, Shivaratri, the three Lhosars, Holi and the rest.',
          'Pressing Seed again is safe — it only adds holidays that are missing, never overrules a movable holiday you entered or edited, and reports what it could not cover. The one thing it will change: one of the seven FIXED national days found on the wrong date (e.g. Martyrs\' Day at Magh 5 instead of Magh 16) or under an old name is corrected in place, and the result lists each correction.',
        ],
        fields: [
          { label: 'Public vs Optional', desc: 'Public (gazetted) entries are what the Overtime module reads to auto-suggest the 2× holiday OT rate. Optional holidays are informational.' },
          { label: 'Demand multiplier', desc: 'Feeds the Suite Demand Forecast and the Roster\'s forecast overlay — a way to encode "Dashain week runs hot" once.' },
        ],
        formulas: [
          'Fiscal-year day resolution: a month ≥ Shrawan (month 4) belongs to the FY\'s starting BS year; Baisakh–Ashadh belong to the following BS year — which is why Republic Day (15 Jestha) lands a year later than the FY label suggests.',
        ],
        gotchas: [
          'If this calendar is left empty, Overtime never auto-selects the 2× holiday rate — every new entry starts as Weekday (1.5×). The Holiday (2×) option can still be picked by hand on each entry, but nothing reminds anyone to, so in practice holiday work gets paid at 1.5×.',
          'Days are validated against the real BS month length (28-32 days) — there is no 30-day assumption anywhere in the module.',
          'Movable dates are TRANSCRIBED per BS year from the gazette, never computed — Nepal publishes them only in Falgun of the preceding year, so the last quarter of the current fiscal year (Baishakh–Ashadh) carries fixed-date holidays only until that gazette exists. Seed says so on screen rather than looking complete.',
          'Eid al-Fitr, Eid al-Adha, Mohammad Jayanti, Guru Nanak Jayanti and Bhoto Jatra have no gazetted date at all and are never seeded — add them by hand each year.',
          'Holi is seeded twice, for Hill (7 Chaitra) and Terai (8 Chaitra) districts — delete whichever does not apply to the outlet, or it pays 2× OT on a day that is not its holiday.',
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
          'Define shift types once (name, start/end, colour, and Normal hours for a long shift — a 12-hour Full Day with 9 normal hours carries 3 hours of overtime) in the shift settings panel; assign them to cells by click or drag-select (touch devices get an explicit tap-first/tap-last "Select range" mode).',
          'Publish when a stretch is ready — publishing is per DAY, and only scheduled staff on those days are notified (web push where enabled).',
          '"Suggest" ranks unscheduled employees by fewest hours already scheduled this period, within whatever the Department filter shows.',
          '"⧉ Copy to Next Week" (weekly view) stamps the whole visible week onto the following week, same weekday to same weekday, then lands on it so the exceptions get edited on a real board.',
          'Approve or reject employee-initiated shift swaps from the Shift Swaps tab once the target coworker has consented; the tab button carries an amber count while any are waiting.',
        ],
        fields: [
          { label: 'OFF DAY vs Clear (Unassign)', desc: 'OFF DAY writes a real zero-hour row — the day shows on the board, in Generate-from-Roster, and in the employee\'s own Self-Service view. Clear deletes the row entirely (an unplanned blank). They are not the same thing.' },
          { label: 'Publish state (per day)', desc: 'Self-Service only ever returns PUBLISHED days — employees can never see a draft, and un-published edits stay invisible to them.' },
        ],
        formulas: [
          'Planned labor cost per day = Σ over scheduled employees of normal shift hours × their LOADED hourly rate — basic plus earning allowances plus the employer\'s 20% SSF share (only for staff with SSF enrolment and an SSF number), spread over the month\'s hours. A shift\'s hours beyond its Normal hours are priced at basic hourly × 1.5, as payroll pays them.',
        ],
        gotchas: [
          'Assigning a shift on a day with APPROVED leave prompts a confirm (override allowed — someone has to cover Dashain); clearing a cell never prompts.',
          'Off days are per employee, not a company-wide weekday — there is no global "Saturday off" switch anywhere in the module.',
          'Copy to Next Week MIRRORS: a cell that is empty this week is cleared next week, so the two weeks end up identical rather than merged. The confirm dialog counts what will be replaced and cleared first, and warns if the target week is already published (staff saw the old version — Re-Publish + Notify afterwards) or if anyone has approved leave on a day being filled.',
          'It copies only what the Department filter is showing. With a filter on, the other departments\' next week is left exactly as it was.',
          'Swap History spans every month, not the week or month the board is showing — it is a permanent record, so it is on its own tab rather than under the board\'s period controls.',
        ],
        connections: 'Shift length feeds Attendance\'s OT auto-calculation and Generate-from-Roster. Published days feed Self-Service\'s Roster tab. The labor forecast prices scheduled hours from Pay Setup — basic, earning allowances and the employer SSF share, the same labour-cost definition as Owner Dashboard — and counts only on-duty shifts as staff; for days already past it reads Attendance, Sales Entries and closed POS bills instead of the forecast; it also learns the sales per labour hour this outlet itself runs from the last 120 days to say how many hours each day needs, which is what lets a non-POS outlet get a Recommended Staff figure; the demand overlay reads Holiday Calendar multipliers and the Suite Demand Forecast.',
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
          'Enter start/end times and the sheet derives hours and suggests OT — both stay editable. If the day\'s rostered shift has Normal hours set, OT is the Start-to-End time beyond those Normal hours (Break does not reduce it); otherwise it is hours worked beyond the shift\'s length, or beyond 8h if the day is not rostered.',
          'Clear Day / Clear Employee-Month / Clear Month (Month Summary tab) genuinely delete rows, for redoing a botched stretch. Clear Month deletes only the listed (active/probation) staff\'s rows — a leaver\'s days stay for Final Settlement — and refuses once the month\'s payroll is finalized, or when that check cannot be read. Approved leave days go too; Leave → Mark approved leave restores them.',
        ],
        fields: [
          { label: 'Statuses', desc: 'present, half_day, absent, paid_leave, unpaid_leave, half_paid_leave, half_unpaid_leave, weekly_off ("Off"), holiday. The half-leave pair exists so a half-day leave request lands as exactly half a day\'s pay effect.' },
          { label: 'Time shorthand', desc: 'Time boxes accept colon-free entry — 0800, 800 or 08 all read as 08:00 — and tolerate the seconds the database echoes back. An incomplete time never reaches the record.' },
          { label: 'OT hours', desc: 'Auto-calculated as a SEED, then editable: beyond the shift\'s Normal hours measured on clock time when the shift has them, otherwise beyond the shift\'s length (or 8h if unrostered) after Break. Attendance OT always pays 1.5× — the 2× holiday rate only exists in the Overtime module.' },
        ],
        formulas: [
          'Hours = (End − Start) − break minutes, floored at 0.',
          'OT suggestion, shift WITH Normal hours = max(0, (End − Start) − Normal hours) — Break is not taken off.',
          'OT suggestion, shift WITHOUT Normal hours = max(0, hours worked − rostered shift hours), or − 8 when the day is not rostered.',
        ],
        gotchas: [
          'Untouched cells stay EMPTY, never auto-Present — Save writes only cells someone actually touched, so nobody gets paid for a day nobody marked. "— Not marked —" plus the row-delete button is the honest blank state.',
          'Generate from Roster fills GAPS only and never overwrites a manual entry: a shift with hours becomes Present, with its hours beyond Normal hours as OT; a zero-hour shift is read by name — "PAID LEAVE" → Paid Leave, any other "LEAVE" → Unpaid Leave, "Holiday" → Holiday, "OFF DAY" → Off, anything else → Holiday; and a day with no roster row is left blank for manual entry.',
          'On a shift with Normal hours set, punched Start/End overtime is clock time beyond those hours, lunch included, so Break does not reduce it. On a shift without, OT is hours worked (after Break) beyond the shift\'s length, as before.',
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
          'Leave types, requests and balances. Types are auto-seeded to Labour Act 2074 defaults on first visit: Home/Annual 18 days, Sick 12, Bereavement/Kiriya 13, Maternity 98, Paternity 15, and uncapped Unpaid. Home and Sick are ticked "Carry Fwd", but that tick is stored for reference only — unused days do not roll into the next year automatically.',
        workflow: [
          'Requests arrive from Self-Service (or are entered here on behalf of an employee) and sit pending until a supervisor approves or rejects.',
          'Approving writes the matching attendance rows for every day in the range, using the leave type\'s paid/unpaid nature.',
          'Balances show quota, used and remaining per employee per type for ONE BS calendar year (Baisakh–Chaitra) — not the Shrawan-start fiscal year payroll uses, and with no carry-over from last year. Remaining also takes off any days already paid out as leave encashment on a finalized Final Settlement.',
          'A rejected or cancelled request is not a dead end: Reopen (manager rank and above) returns it to Pending with its original dates, reason and history, ready to be approved again.',
          'Leave approved for a month that has no period yet cannot be written to an attendance sheet that does not exist. It is approved anyway, and those days are marked automatically the moment that month is created — a banner on the page counts anything still outstanding.',
        ],
        fields: [
          { label: 'Half day', desc: 'Counts 0.5 and is only offered on a single-day request — a multi-day range is forced back to full days. First/second half is record-keeping only; pay only distinguishes full vs half.' },
          { label: 'Quota 0 = uncapped', desc: 'The Unpaid type ships with quota 0, meaning no cap — it reduces pay, so it needs no rationing.' },
        ],
        formulas: [
          'Days = every calendar day in the inclusive range. No weekday is assumed off — off days are explicit per employee on the roster, so a "Saturday" inside a leave range is a real leave day unless that employee\'s roster says otherwise.',
          'Used = Σ approved request days for the employee + type whose start date falls in the BS year (a leave crossing into the next year counts entirely in the year it starts).',
          'Remaining = annual quota − used − days encashed on a finalized Final Settlement in that year.',
        ],
        gotchas: [
          'Un-approving DELETES the attendance rows the approval wrote rather than guessing a prior status back — the pre-leave state was never recorded, so a blank "needs manual entry" day is the only honest result.',
          'Deciding a request re-reads its current status from the database first, so two supervisors working the same queue can\'t double-process one request.',
          'Reopen goes to Pending, never straight back to Approved — approval is the only thing that writes attendance rows, so a request restored as Approved would sit over an attendance sheet with those days blank and payroll would treat a paid leave as unworked. Approve it again after reopening.',
          'Reopen is manager-only by design: a supervisor can decide a request, but undoing a decision that has already cleared attendance days and moved a balance is a rank up. Owner and admin both resolve to manager here.',
          'An approval is only half the write: the other half is the hr_attendance rows, which is what payroll actually reads. A client may have ONE open period at a time, so leave approved months ahead has nowhere to write — until S741 those days were simply never marked, and an approved unpaid leave was silently PAID when its month came round. Creating the period now back-fills them (backfillApprovedLeave), and a day that already carries a mark is never overwritten.',
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
          'Anyone who can open the page (supervisor rank and up) approves or rejects a pending entry; the estimated amount previews what payroll will pay.',
          'Undo puts an approved or rejected entry back to Pending, so a mis-click can be decided again. It has no confirmation, and an entry undone after payroll was generated only changes pay once the draft is regenerated.',
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
          'Generate builds a draft from current Attendance, approved Overtime, Advances already due for recovery (issued in an EARLIER BS month — see Advances & Loans) and approved TADA. Review the rows; edit TDS or TADA where judgment is needed.',
          'Finalize shows a consequence summary — payslip count, total net pay, advance recoveries to be recorded, TADA claims to be closed — because these are real writes to other ledgers, then locks the run.',
          'Reopen (HR manager and above, S620) reverses exactly what Finalize wrote: deletes its advance-repayment rows (reactivating anything with balance again), and un-pays only TADA claims IT marked paid — never one a manager settled by hand.',
          'Regenerate rebuilds the draft from scratch — and resets any manual TDS/TADA edits, with an explicit confirm.',
        ],
        fields: [
          { label: '⚠ SSF no. missing', desc: 'Flags an SSF-enrolled employee with no registration number — payroll deducts nothing for them (the recoverable direction) until the number is entered in Pay Setup.' },
          { label: 'TADA column', desc: 'Auto-filled from approved claims whose trip dates fall in the month, added AFTER tax — TADA is a reimbursement, never taxable income. Zeroing it out here leaves the claim open for cash settlement instead.' },
        ],
        formulas: [
          'On Finalize: payslips lock; each payslip\'s advance deduction is recorded as repayment rows against that employee\'s advances that are due this month, oldest first — idempotent, so a Reopen + re-Finalize never doubles them; advances reaching zero auto-settle; auto-filled TADA claims are marked paid via payroll.',
        ],
        gotchas: [
          'Finalize is BLOCKED outright while the draft is stale — the page recomputes every employee live through the same code that generated the draft. Any employee whose figures MOVED, or who was added since Generate, names itself in an amber banner pointing at Regenerate. There is deliberately no "finalize anyway": a stale draft pays wrong money.',
          'Staleness compares the six figures NOBODY CAN TYPE INTO — gross, OT amount, absence deduction, SSF employee, other deductions, advance deduction — plus the set of TADA claim IDs. Never net pay. TDS and TADA are deliberately hand-editable while a run is a draft and every edit rewrites net pay, so a net-pay comparison could not tell an intended override from real drift; before S620 that was a deadlock, because Finalize refused while stale and the only escape (Regenerate) reset the very edit that caused it.',
          'A hand-adjusted TDS or TADA is reported, never blocking: an amber line names those payslips and says they are locked as entered rather than recomputed, and the Finalize confirmation repeats it. Only genuine movement blocks.',
          'A third bucket exists and deliberately does NOT block: a stored payslip whose employee is no longer active (settled or deactivated mid-month). Blocking would strand the run with no legal move — instead Regenerate is gated behind a confirm, because Regenerate hard-deletes payslips and re-inserts only live employees, which would silently destroy a leaver\'s issued payslip.',
          'A draft generated before the advance-timing rule (S747) may have cut an advance in the same month it was issued. The advance deduction is one of the figures the staleness check compares, so such a draft now shows as stale and must be Regenerated before it can be finalized.',
          'Once finalized, the run is the permanent record — Payroll Calculation\'s badges comparing it against live data are a prompt to investigate, not proof the payslip is wrong (the live data may have changed after a legitimate close).',
        ],
        connections: 'Reads Attendance, Overtime (approved, per-day supersede), Pay Setup, Advances, TADA Claims. HR Reports shows the run while it is still a draft (with a warning) as well as once finalized; finalized payslips feed Festival/Incentive tax projections, Self-Service payslips, and the Dashboard\'s SSF-deadline card.',
      },
      {
        id: 'payroll-calculation',
        title: 'Calculation (Payroll Review)',
        route: '/hr/calculation',
        plan: 'Manager only',
        summary:
          'The read-only companion to Payroll Run: it never writes anything. It recomputes every figure live from current Attendance/Roster/Overtime/Advances through the identical engine, shows the complete working step by step (printable), and compares the result against the stored payslip.',
        workflow: [
          'Pick the month and an employee to see every intermediate: gross build-up, unpaid days, SSF base, YTD tax figures, projected annual tax, the resulting TDS, and how many "Advances in recovery this month" the advance deduction comes from (an advance issued this month is not counted yet) — the page to open when someone asks "why is my pay this number?".',
          'Print the working panel as the explanation sheet to hand over.',
        ],
        fields: [
          { label: '⚠ Stale (red)', desc: 'One of the six COMPUTED figures moved since Generate — gross, OT amount, absence deduction, SSF employee, other deductions, advance deduction — or the set of TADA claims changed. Real upstream drift: attendance, overtime, pay setup or an advance instalment. The fix lives on Payroll Run: Regenerate.' },
          { label: 'Adjusted (neutral)', desc: 'Someone hand-edited TDS or TADA on the draft and the payslip is otherwise a perfect match. Deliberately NOT the red ⚠ Stale it used to show: an intended override is not drift, and flagging it as such put a red warning against a correct payslip.' },
          { label: 'Not generated', desc: 'A run exists for the month but never picked this employee up (typically added after Generate) — distinct from both of the above.' },
          { label: 'OT superseded', desc: 'Shows attendance OT withheld because an approved Overtime entry covers the same day — so a figure that differs from the attendance sheet is explained rather than mysterious.' },
        ],
        formulas: [
          'Identical arithmetic to Payroll Run by construction — both call the same pure compute functions, so this page can never "disagree" with a fresh draft.',
        ],
        gotchas: [
          'The live Total Gross and Total Net Pay cards and the table\'s footer totals always show, because they are computed here. Only the stored-net total (the sum of Payroll Run\'s saved payslips) is held back as "—" until EVERY row has a stored payslip — a partial sum would read as the month\'s total.',
          'The printable working uses no hover tooltips on purpose: hovers don\'t print, so every explanation is a visible row or caption.',
        ],
        connections: 'Same inputs as Payroll Run, through the same shared comparison — the two pages call one payslipDrift(), so this page can never disagree with the banner on the other. The Stale badge is the review-side of Payroll Run\'s finalize-block: one detects drift, the other refuses to lock it in.',
      },
      {
        id: 'pay-engine',
        title: 'How pay is calculated',
        route: null,
        plan: 'Reference — applies to every payroll figure',
        summary:
          'The payroll engine is a set of pure functions — no screen edits its rules. Three pay bases, SSF, join-date proration and Nepal income tax (TDS) in one place, so Payroll Run, Calculation, and the Roster\'s cost forecast all mean the same thing by "a day\'s pay".',
        workflow: [
          'MONTHLY: gross = basic + allowances. Unpaid days = absences + unpaid leave + half of each half-day + days before the join date. Absence deduction = (gross ÷ days in the BS month) × unpaid days — allowances are forfeited too, not just basic. SSF base = min(basic × paid fraction, 100,000). Net = gross + OT − absence − SSF 11% − other deductions − TDS − advance recovery (only advances issued in an earlier BS month) + TADA.',
          'DAILY: paid days = present + half days × 0.5 + paid leave (paid leave IS paid for daily staff) + half paid leave × 0.5. Earned = daily basic × paid days. No absence deduction, no allowances. OT at (basic ÷ 8) × 1.5.',
          'HOURLY: paid hours = (hours worked − the OT hours inside them) + paid leave × 8 + half paid leave × 4. Earned = hourly basic × paid hours. OT at basic × 1.5 — so an overtime hour pays 1.5× in total, not the ordinary rate plus 1.5× on top (the pre-S742 figure, 2.5×).',
        ],
        fields: [
          { label: 'SSF (Social Security Fund)', desc: 'Employee 11%, employer 20% (31% total on the challan), on a base capped at NPR 100,000 — for monthly staff the basic actually earned (basic × the share of the month paid), for daily/hourly staff the wage earned. Deducted only when enrolment AND the registration number are both present. SSF contributors also get the 1% first tax slab (Social Security Tax) waived entirely. That same test — enrolled AND an SSF number — also decides the 1% waiver and the SSF tax relief on Festival Allowance and Incentive runs (since S747; before that those two used the enrolment tick alone).' },
          { label: 'Join-date proration', desc: 'Days of the month before an employee\'s join date count as unpaid days, so a mid-month hire is paid from their join date — and because SSF and TDS derive from the absence-adjusted figure, both follow automatically.' },
          { label: 'End-date proration', desc: 'The mirror image, added S600: days strictly AFTER an employee\'s last working day are unpaid days too, so a leaver draws a partial month. Without it the monthly run paid a full contractual month and Final Settlement added its own partial month on top — the same month paid roughly 1.5×. It is deliberately NOT implemented by writing absent rows for post-exit days: absent_days is a reported figure, and that would misreport a departure as absenteeism.' },
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
          'TDS = the marginal lump-sum method: project annual gross from YTD finalized payslips + basic × remaining months, apply the standard deduction caps, then tax(taxable + bonus) − tax(taxable). SSF relief and the 1% first-slab waiver apply only to staff with SSF enrolment AND an SSF number — the same test payroll uses.',
        ],
        gotchas: [
          'Regenerate resets every manual edit (explicit confirm). Once every row is finalized the whole page locks.',
          'Daily and hourly staff are seeded at 0, but their amount can be typed in by hand before Finalize.',
          'A draft generated before S747 (14 Sep 2026) may carry TDS worked out with the old SSF test (enrolment tick alone), which under-taxed an enrolled employee with no SSF number. Its stored TDS stays as it was until you Regenerate, or edit that row\'s amount (which recomputes its TDS).',
        ],
        connections: 'Reads finalized payslips for the YTD tax base. Final Settlement pro-rates an unpaid festival allowance using the same basic × months ÷ 12 idea.',
      },
      {
        id: 'incentives',
        title: 'Incentives / Bonus',
        route: '/hr/incentives',
        plan: 'Manager only',
        summary:
          'Ad-hoc bonus runs, optionally built from reusable incentive types ("Sales Bonus", "Attendance Bonus") defined once — a type seeds a flat amount, a percentage of basic, or nothing (manual entry). A run is keyed by BS year + a label you choose, so several can coexist in one year.',
        workflow: [
          'Define types in the config modal (name + how it is calculated). Start a run: name the run (required before Generate), optionally pick a type — leaving it on "Ad-hoc (manual)" starts everyone at 0 — then Generate, adjust amounts, Finalize.',
        ],
        fields: [
          { label: 'Calc type', desc: 'Three choices. manual (the default for a new type) = every employee starts at 0 and you type each amount; fixed = the type\'s default flat NPR value per employee; percent_of_basic = round(basic × value ÷ 100). Every seeded amount stays editable per row.' },
        ],
        formulas: [
          'TDS = the same YTD-marginal lump-sum method Festival Allowance uses, including its SSF test: relief and the 1% waiver only for staff with SSF enrolment AND an SSF number.',
        ],
        gotchas: [
          'A draft generated before S747 (14 Sep 2026) may carry TDS worked out with the old SSF test (enrolment tick alone). Its stored TDS stays as it was until you Regenerate, or edit that row\'s amount (which recomputes its TDS).',
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
          'Issue: employee, type, amount, date, optional installment amount, purpose. Under the date the form shows "First salary cut: <month> payroll" so you can tell the employee when the money starts coming back. The detail panel shows the repayment history, derived balance and the payroll recovery starts from.',
          'Repayments arrive two ways — recorded manually here, or written automatically by Payroll Run\'s Finalize. Both live in the same repayment history.',
        ],
        fields: [
          { label: 'When payroll starts recovering', desc: 'The payroll of the BS month AFTER the month the advance was issued. The day does not matter: an advance given on 1 Bhadra and one given on 28 Bhadra are both first cut in the Ashwin payroll. An advance issued in Chaitra is first cut in Baisakh of the next year. Payroll Calculation\'s working panel counts the "Advances in recovery this month".' },
          { label: 'Installment', desc: 'The per-month payroll recovery. LEFT BLANK, the FULL outstanding balance is recovered in the first payroll the advance is due in — the one-time-advance behaviour. Set it for loans meant to amortize.' },
        ],
        formulas: [
          'Outstanding is always DERIVED — amount − Σ repayments. There is no stored balance column to drift out of sync.',
          'Payroll deduction per active advance that is due this month = min(installment, outstanding); multiple due advances for one employee sum. An advance issued this month adds nothing yet.',
        ],
        gotchas: [
          'Finalize auto-settles an advance the moment its balance reaches zero; Reopen deletes payroll\'s own repayment rows and reactivates anything that regains a balance — manual repayments are never touched by either.',
          'The start-next-month rule is new (S747, 14 Sep 2026). An open payroll draft generated before it that cut an advance in its issue month now shows as stale on Payroll Run — press Regenerate before Finalize.',
          'Final Settlement ignores the timing rule: a leaver has no later payroll, so every outstanding advance is recovered, however recently it was issued.',
        ],
        connections: 'Payroll Run reads active advances that are due for the deduction and writes repayments on Finalize. Final Settlement deducts every advance\'s full outstanding, whenever it was issued. The Dashboard shows total outstanding.',
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
          { label: 'Status ladder', desc: 'pending (amber — waiting on a decision) → approved (brass — money owed, not yet disbursed) → paid (green). It is a ladder, not tags: a claim never skips approved. Pending used to be grey here and approved amber, which read as the opposite of every other HR queue.' },
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
          'Pick the month (or FY for the certificate). The Directory loads independently of any payroll run. Payroll Summary, SSF Challan, Bank Transfer and TDS Report show whatever run the month has — a DRAFT included, under a "This payroll is still a draft — figures may change" warning. Only the TDS Certificate is limited to finalized payslips. Finalize in Payroll Run before filing or paying from these sheets.',
          'SSF Challan is the deposit sheet: per employee with SSF enrolment and an SSF number, an "SSF Basic" column and the 11% + 20% split. Bank Transfer lists net pay against each employee\'s bank details from Pay Setup.',
        ],
        fields: [
          { label: 'TDS Certificate', desc: 'Per employee, per fiscal year — YTD withholding evidence. The company PAN in its header comes from the VAT/PAN number in Settings (Nepal uses one number for both); it prints a blank line only when genuinely unset.' },
        ],
        formulas: [
          'SSF challan row: the 11% and 20% columns are the figures stored on the payslip, which payroll worked out on min(basic actually earned, 100,000) — for monthly staff that is basic × the share of the month paid. Total 31% = the two added together.',
          'SSF challan "SSF Basic" column = min(basic salary, 100,000), printed fresh from the payslip\'s basic — NOT the base the contributions were taken on. For anyone with unpaid days (absence, unpaid leave, a mid-month join or exit), and for daily/hourly staff whose "basic" is a day or hour rate, it will not equal the 11%/20% columns ÷ 0.11 / 0.20.',
          'Employer cost (Payroll Summary) = gross + OT + employer SSF 20%.',
          'Total deductions = absence + SSF employee share + other deductions + TDS.',
        ],
        gotchas: [
          'The challan filters on enrolment AND registration number (as they are in Pay Setup now) and says "N employees without an SSF number excluded". That N is EVERY payslip in the run not on the challan — staff who were never enrolled in SSF count too — so a non-zero figure is normal for an outlet with non-SSF staff. It only means a missing number if the person should be enrolled.',
          'The page tells you to type each row\'s SSF No and SSF Basic into SOSYS (SSF\'s portal), whose own calculation "should match" Total 31%. For a staff member with unpaid days that match cannot hold, because SSF Basic is the full capped basic while the 11% + 20% were taken on less — check those rows by hand rather than assuming the sheet and SOSYS agree.',
        ],
        connections: 'Payroll Summary, SSF Challan, Bank Transfer and TDS Report read the month\'s payroll run from Payroll Run, draft or finalized; the TDS Certificate reads finalized payslips only; the Directory reads Employees. Bank details come from Pay Setup; the PAN from Settings.',
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
          { label: 'SSF offset', desc: 'For SSF-enrolled staff, a slice of the employer\'s 20% already funds the SSF gratuity scheme — that portion is not a cash liability again. It is netted off only for the months contributions were ACTUALLY made, never across the whole service (see gotchas).' },
        ],
        formulas: [
          'Accrual = basic ÷ 12 per month of service (one month\'s basic per year, 8.33%/yr). Total accrued = basic ÷ 12 × service months.',
          'SSF covered = 3.33% of min(basic, 100,000) × the number of months SSF was actually contributed, capped at months served. Net cash liability = max(0, accrued − SSF covered).',
          'The SSF gate is enrolment AND registration number, matching payroll — a flagged employee with a blank SSF number had nothing contributed on their behalf, so netting an SSF-funded share off their gratuity would underpay them.',
        ],
        gotchas: [
          'Daily and hourly staff are excluded entirely — there is no fixed monthly basic to accrue on — and the page states how many were skipped rather than silently shrinking the roster.',
          'WHEN SSF started is not in the schema — hr_employees.ssf_enrolled is a bare boolean with no date — so it is derived from evidence: the first finalized payslip that actually carries an SSF deduction. SSF only began in 2075/76 and most clients enrolled later, so "enrolled since they joined" is close to never true; multiplying the offset across an entire service cost a ten-year employee enrolled two years ago roughly NPR 320,000 (fixed S600).',
          'No evidence means NO offset, never a guess. An employee with no SSF-bearing payslip on record is treated as unknown coverage and the full accrual is paid — because the wrong guess in the other direction silently reduces what a leaver receives once, with nothing to catch it.',
        ],
        connections: 'Final Settlement computes the individual payout with the same accrual-minus-SSF arithmetic. Basic comes from Pay Setup; service months from the join date on Employees.',
      },
      {
        id: 'settlement',
        title: 'Final Settlement',
        route: '/hr/settlement',
        plan: 'Manager only',
        summary:
          'Computes AND records a leaver\'s full and final payout — partial month, leave encashment, gratuity, festival pro-ration, less unserved notice, outstanding advances and TDS. Finalize closes the recovered advances, stamps the employee (status Resigned, Terminated or — for retirement — Inactive, plus their end date), blocks their Crest Staff login and locks the document; an admin can Reopen to reverse all of it.',
        workflow: [
          'Select the employee and inputs; the memo derives earnings (partial month, leave encashment, gratuity, festival pro-ration), deductions (notice shortfall, advances, lump-sum TDS) and the net figure, all itemized.',
        ],
        fields: [
          { label: 'Notice deduction', desc: 'Only when notice was NOT served: (basic ÷ 26) × the notice days owed — the mirror image of leave encashment\'s divisor.' },
        ],
        formulas: [
          'Partial-month salary = (gross ÷ days in the last BS month) × paid days, where gross = basic + earning allowances (the same gross payroll pays) and paid days = the last working day\'s date − absences − unpaid leave − half of each half day / half unpaid leave marked on Attendance up to that day. With no attendance marked for the month it is a plain calendar proration, and the page says which it used.',
          'Leave encashment = (basic ÷ 26) × unused leave days — the Labour Act\'s 26-working-day divisor.',
          'Gratuity (only if ≥ 12 months served) = max(0, basic ÷ 12 × service months − SSF-covered portion) — same netting as the Gratuity page.',
          'Festival pro-ration (only if not yet paid this FY) = basic × months into the FY ÷ 12.',
          'Advances: every advance\'s full outstanding is deducted — including one issued this month, since there is no later payroll to recover it from.',
          'TDS = marginal lump-sum tax on (gratuity + leave encashment + festival pro-ration), measured on top of the leaver\'s REAL income for the year: gross from this fiscal year\'s finalized payslips plus the final partial month, less SSF relief (the SSF actually deducted on those payslips plus this month\'s, capped at the lower of NPR 500,000 and a third of that income) and the insurance deductions.',
        ],
        gotchas: [
          'The TDS base stops at the last working day — it does not project income for months the leaver will not work. So it is only as complete as Payroll Run: a month worked this fiscal year whose run was never finalized is missing from the base and the lump-sum TDS comes out low. Finalize those months first.',
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
          'HR staff share the main /login with the owner and IMS staff — they are separated by role, not by entrance. There are three PIN entrances, none of them for HR staff: POS (/pos/login), employee Self-Service (/hr/self-service), and the IMS stock-count login (/ims/count).',
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
          'There is no "reset PIN" and no re-enable button for an existing login. To give an employee a new PIN, go to Employees, press Remove on their Self-Service login, then press Enable Self-Service and set the new PIN. (If their login is blocked, Activate it first — a blocked row shows no Remove button.)',
          'A blocked employee (bulk Deactivate on Employees) sees exactly what a wrong PIN shows — "Incorrect PIN. Try again." — so the portal never confirms to a leaver that their account still exists. Only a PIN locked after too many failed attempts gets a different message, telling them when to try again.',
          'The Roster tab shows PUBLISHED days only — but an unpublished day now SAYS "Not published yet" instead of looking like a day with no shift. Those two are identical in the data and mean opposite things to someone deciding whether to come in.',
          'Notifications only offer a button where pressing one can actually do something — on an iPhone opened from a chat app it explains the Home Screen step instead, because a tab on iOS has no push at all.',
          'Light or dark follows the phone\'s own setting — the "Follow device" option the main app\'s Settings → Theme tab also offers since S730. Employees cannot reach that tab, so following the device is the only theme they can have.',
          'Every screen surfaces a failed load as an error rather than an empty list — "no payslips" always means no payslips, never a swallowed network failure.',
        ],
        connections: 'Payslips come from finalized Payroll Runs; leave requests land in Leave Management\'s queue; TADA claims in TADA\'s queue; roster from published Roster days; swap requests into the Roster\'s Shift Swaps tab. Login enablement and blocking live on Employees.',
      },
    ],
  },
]
