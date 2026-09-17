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
          'At month end: Payroll Run generates a draft, the manager reviews per-employee pay and TDS, and Finalize locks it — writing advance repayments and closing payroll-paid TADA claims in the same act.',
          'Downstream pages read the payslips: HR Reports shows the month\'s run whether it is a draft or finalized (a draft carries a "still a draft" warning — only the TDS Certificate is finalized-only), while Festival/Incentive tax projections, the HR Dashboard\'s SSF card and each employee\'s own Self-Service payslip tab read finalized payslips.',
        ],
        fields: [
          { label: 'Two kinds of login', desc: 'HR STAFF (people who administer HR — run payroll, approve leave) sign in with email + password at the main /login, created from HR Staff. EMPLOYEES use Self-Service — a public per-company link with a 4-6 digit PIN — to see their own payslips, leave, TADA and roster. An owner uses neither: they already resolve to Manager rank on everything.' },
          { label: 'The rank axis (hr_role)', desc: 'staff < supervisor < manager, NULL = no HR access at all. Each page states its minimum below. Assigning an hr_role to the OWNER\'s own login demotes them out of Owner-level access entirely — staff roles are for staff accounts, never the owner\'s.' },
          { label: 'status vs access_blocked — the distinction that matters most', desc: 'hr_employees.status (active / probation / inactive / resigned / terminated) is PAYROLL ELIGIBILITY — active and probation staff are picked up, and since S751 Payroll Run (and each row\'s working) also picks up anyone whose end_date falls in or after the month (paid to their last day) unless a finalized Final Settlement already paid it; the Final Settlement picker still filters on status. access_blocked is the SELF-SERVICE LOGIN gate. Two different columns, two different Deactivate buttons (Edit form vs Employees\' bulk bar). Conflating them once dropped a resigned employee out of their own final payroll run.' },
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
          'The SSF card tracks the statutory deposit deadline — the 25th of the month FOLLOWING the payroll month (25 days after the month ends; it was 15 until the July 2025 amendment) — and shows overdue / due-soon / upcoming state relative to today.',
          'Retiring-soon surfaces employees within 180 days of their retirement date.',
        ],
        fields: [
          { label: 'Pending swap count', desc: 'Counts only swaps at pending_admin — a swap still waiting on the target coworker\'s consent (pending_target) is not yet HR\'s to action, so it does not inflate the queue.' },
        ],
        formulas: [
          'SSF deposit deadline = 25th of the month after the payroll month, from the last finalized run.',
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
          'The employee master: every person on the books, with search and filters (status, supervisor, retiring-only), an add/edit form (Personal, Employment, Address and Family tabs), a printable Employee Joining Form, and the controls for employee Self-Service logins — enable with a PIN, bulk block/unblock, or remove. Salary, pay basis, bank and SSF are not on this form; they live in Pay Setup.',
        workflow: [
          'Add employees here first — every other HR page keys off this record. Department, supervisor, join date, retirement date and status all matter downstream. The employee code is optional and typed by hand — nothing generates one. Join and retirement dates on the list show in BS.',
          'Saving the Edit form writes only the fields you changed, so it never overwrites pay, bank or SSF set in Pay Setup, a Final Settlement, or a login block made elsewhere.',
          'Enable Self-Service per employee: set a 4-6 digit PIN, then share the ONE login link ("Copy Self-Service Link" — there is no QR code on this page) the whole company uses — each employee picks their own name on it. Employees log in from their own phones; there is no device setup. Enable and Remove are open to the Owner, an HR Manager and Crest admin.',
          'The checkbox column + bulk bar Deactivate (block login) / Activate (allow login) toggles Self-Service LOGIN access (access_blocked) for many employees at once. It acts only on ticked rows still visible under the current filter.',
          '"🖨 Print Joining Form" in the page header opens a BLANK joining form to print and have a new hire fill in by hand for the paper personnel file — it is not filled from any employee\'s record. Its status choices are Active / Probation, and Designation is not a required field.',
        ],
        fields: [
          { label: 'Status (active / probation / inactive / resigned / terminated)', desc: 'Payroll eligibility. Payroll Run and Final Settlement include active + probation only; the other three all drop out. The Edit form\'s Deactivate button (shown on an active OR probation employee) sets Inactive — taking them off Payroll Run, Final Settlement, the Roster and Attendance, without blocking their Self-Service login — and its confirm says to run Final Settlement first for a leaver. Its Activate button (shown on an inactive one) sets Active; Resigned and Terminated are picked from the Status list, and Final Settlement sets them itself when it is finalized.' },
          { label: 'End Date', desc: 'Shown for Contract / Part-time staff, and on any employee who already has an end date. Payroll pays a monthly employee nothing for days after it; Final Settlement sets it when someone leaves. An amber warning appears if the date has passed while the employee is still active or on probation.' },
          { label: 'Bulk Deactivate / Activate (access_blocked)', desc: 'Blocks or restores Self-Service LOGIN only — status is never touched, so blocking a leaver\'s login can never remove them from their own final payroll. A blocked employee sees the same "Incorrect PIN. Try again." as someone who typed a wrong PIN.' },
          { label: 'Remove Self-Service', desc: 'Deletes the login account outright (different from blocking, which suspends it). The employee record, payslips and leave history all survive either way. It is also how a forgotten PIN is replaced: each employee can have only one login and Enable is refused while one exists, so Remove the login and then press Enable Self-Service again with a new PIN. (A blocked employee shows no Remove button — Activate them first.) A login whose employee record no longer exists cannot sign in.' },
          { label: 'Retirement date / retiring filter', desc: 'The retiring-only filter and the Dashboard card both use a 180-day window. The Retiring Soon stat card filters the list when clicked.' },
        ],
        formulas: [
          'Active stat = active employees only; probation staff are counted on the "N on probation" line beneath it.',
          'Basic Payroll / Month sums basic salary over active + probation employees paid MONTHLY only — a daily or hourly rate is not a month\'s pay and is left out.',
        ],
        gotchas: [
          'Delete is refused — by the database, not just the page — for anyone with finalized payslips, a finalized Final Settlement, finalized festival allowances, any advance or loan, a Self-Service login, or TADA claims / incentives / shift-swap requests. Use Deactivate instead, exactly like Item Master\'s Hide-vs-Delete rule in IMS. An employee with none of those (added by mistake, say) can still be deleted.',
          'Self-Service status per employee is read through a dedicated RPC because the profiles table\'s security only lets an account read its own row — a raw query would show every employee as having no login.',
        ],
        connections: 'Feeds every HR page. status → Payroll Run / Settlement pickers; access_blocked → Self-Service login only; join date → payroll proration; retirement date → Dashboard; department/supervisor → Roster and filters.',
      },
      {
        id: 'pay-setup',
        title: 'Pay Setup',
        route: '/hr/pay-setup',
        plan: 'Manager only',
        summary:
          'Per-employee salary structure: pay basis (monthly / daily / hourly), basic salary, Dearness Allowance and other allowance/deduction components, SSF enrolment plus the SSF registration number, and bank details for the transfer sheet. Excel export included. This page decides what every payroll figure means.',
        workflow: [
          'Pick a tab — "On payroll" (active + probation, the default), "All", or "Not on payroll" (inactive, resigned, terminated). The totals follow the tab.',
          'Click a row to open the pay drawer. Set the basis first — it changes what "basic" means (per month, per day, or per hour).',
          'Add salary components: each is a flat NPR amount or a percentage of basic; allowances add to gross, deductions subtract from net. If the employee\'s existing allowances fail to load, Save is switched off, because saving would erase them.',
          'For SSF staff, switch on enrolment AND enter the SSF registration number — this is the only place the number is ever entered, and payroll refuses to deduct SSF without it.',
        ],
        fields: [
          { label: 'Pay basis', desc: 'Monthly staff get gross = basic + allowances with absence deductions; daily staff are paid per day worked; hourly staff per hour worked. Daily/hourly rows show only the rate plus an estimate (rate × 26 days, or × 8h × 26) and are excluded from the page totals.' },
          { label: 'SSF enrolment + SSF No.', desc: 'Both are required before payroll deducts the employee\'s 11% (and the employer\'s 20%) — the same rule Pay Setup\'s own figures use. With the switch on and no number, payroll deducts no SSF and charges the 1% social security tax, and Pay Setup shows an amber "⚠ SSF no. missing" chip and warnings. A flag with no number used to withhold money the SSF challan sheet never claimed. Deducting nothing is the recoverable direction.' },
          { label: 'Retirement fund tick box (deductions)', desc: 'Each deduction row carries "Retirement fund — reduces taxable income"; the CIT / Provident Fund chip arrives ticked. Payroll takes ticked deductions off taxable income together with SSF, inside one shared cap of NPR 5,00,000 a year or a third of annual income, whichever is lower — for monthly TDS, Final Settlement\'s lump-sum tax, and the tax on Festival Allowance and Incentive runs.' },
          { label: 'Dearness Allowance', desc: 'A named statutory component: Nepal\'s full-time monthly minimum wage of NPR 19,550 is defined as 12,170 basic + 7,380 dearness, so the form treats it separately from other allowances.' },
        ],
        formulas: [
          'Component amount = flat value, or basic × percent for percent-of-basic components.',
          'Monthly preview: gross = basic + allowances; SSF base = min(basic, 100,000) when enrolled AND an SSF No. is entered, otherwise 0; employee 11%, employer 20%; net before income tax = gross − SSF employee share − other deductions.',
        ],
        gotchas: [
          '"Net before income tax" is a full month before TDS — not what the employee takes home. Payroll works out income tax, absences, overtime, advance recovery and TADA, so the payslip\'s take-home figure differs.',
          'The form warns — without blocking — when pay falls below the legal floors: monthly basic under 12,170, the per-basis minimum wage (daily 754, hourly 101, part-time hourly 107, monthly 19,550 all-in), or basic under 60% of gross (a Labour Act rule: benefits are computed on basic, so a low basic quietly undercuts leave encashment, gratuity and festival allowance). The minimum-wage panel (labelled FY 2083/84) appears only when a check fails; otherwise it is a single ✓ line.',
          'Minimum wages were last fixed from Shrawan 1, 2082 under the Labour Act 2074 and are reviewed every two years — next review Shrawan 2084. The constants live in one payroll-constants file when they change.',
        ],
        connections: 'Basic, basis, components, SSF fields and join date drive Payroll Run (and its per-row working), Gratuity, Festival Allowance, Final Settlement and the Roster\'s labor-cost forecast. Bank details feed HR Reports\' Bank Transfer tab.',
      },
      {
        id: 'holidays',
        title: 'Holiday Calendar',
        route: '/hr/holidays',
        plan: 'Staff+ to view; Supervisor+ to edit',
        summary:
          'The per-fiscal-year list of company holidays, typed Public (gazetted — banks closed, statutory) or Optional (gazetted only for part of the country or a community, such as Teej, Gai Jatra or Christmas, plus any floating day you add), each with an optional demand multiplier for forecasting. The only HR page open to staff rank, so anyone can check what is coming — but adding, editing, deleting and seeding are for HR Supervisors and Managers, the Owner and Crest admin. Staff see it read-only, and the database enforces that.',
        workflow: [
          'Pick the BS fiscal year, add holidays with month/day, type, and (optionally) a demand multiplier — e.g. 1.5 for a day you expect 50% more covers. The same holiday twice (same date and name) is refused.',
          '"Seed FY …" fills the whole year from the Nepal Gazette — seven fixed national days (New Year 1 Baishakh, Republic Day 15 Jestha, Constitution Day 3 Ashwin, Prithvi Jayanti 27 Poush, Maghe Sankranti 1 Magh, Martyrs\' Day 16 Magh, Democracy Day 7 Falgun) plus every gazetted movable holiday held for that fiscal year\'s two BS years: Dashain, Tihar, Chhath, Shivaratri, the three Lhosars, Holi and the rest. It reports any BS year with no gazette yet. Seed is off if the calendar failed to load.',
          'Pressing Seed again only adds holidays that are missing, never changes the date or type of a holiday you entered or edited, and reports what it could not cover. Two things it will change: one of the seven FIXED national days found on the wrong date (e.g. Martyrs\' Day at Magh 5 instead of Magh 16) or under an old name is corrected in place, and the result lists each correction; and a holiday you REMOVED is never added back — the result names any it left out for that reason.',
        ],
        fields: [
          { label: 'Public vs Optional', desc: 'Overtime entered in the Overtime module for a Public (gazetted) date is suggested at the 2× holiday rate. Each overtime entry keeps the rate it was entered at, so editing or deleting a holiday later does not reprice overtime already entered. Optional holidays are gazetted for part of the country or a community and are suggested at the weekday rate.' },
          { label: 'Demand multiplier', desc: 'Feeds the Suite Demand Forecast and the Roster\'s forecast overlay — a way to encode "Dashain week runs hot" once.' },
        ],
        formulas: [
          'Fiscal-year day resolution: a month ≥ Shrawan (month 4) belongs to the FY\'s starting BS year; Baisakh–Ashadh belong to the following BS year — which is why Republic Day (15 Jestha) lands a year later than the FY label suggests.',
        ],
        gotchas: [
          'If this calendar is left empty, Overtime never auto-selects the 2× holiday rate — every new entry starts as Weekday (1.5×). The Holiday (2×) option can still be picked by hand on each entry, but nothing reminds anyone to, so in practice holiday work gets paid at 1.5×.',
          'Days are validated against the real BS month length (28-32 days) — there is no 30-day assumption anywhere in the module.',
          'Movable dates are TRANSCRIBED per BS year from the gazette, never computed — Nepal publishes them only in Falgun of the preceding year, so the last quarter of the current fiscal year (Baishakh–Ashadh) carries fixed-date holidays only until that gazette exists. Seed says so on screen rather than looking complete.',
          'Eid al-Fitr, Eid al-Adha, Mohammad Jayanti, Guru Nanak Jayanti and Bhoto Jatra have no gazetted date at all and are never seeded — they are the only holidays that always need adding by hand each year.',
          'Holi is seeded twice, for Hill (7 Chaitra) and Terai (8 Chaitra) districts — remove whichever does not apply to the outlet, or it suggests 2× OT on a day that is not its holiday. Removed holidays move to a Removed list under the calendar (Put back / Delete for good); Seed never adds a removed one back, but Delete for good forgets it, so a gazetted holiday deleted that way comes back on the next Seed.',
          'Every holiday added, changed or deleted is recorded in the Audit Log.',
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
          'Approving a swap is one database transaction (approve_shift_swap). It refuses, changing nothing, when the request was withdrawn or already decided, when either day no longer carries the shift that was agreed, or when one of the two already works the other day. A same-day swap trades the two shifts; a two-day swap trades who works each day.',
          'Shift-type names are unique per client, and a shift type used on the roster cannot be deleted — hr_roster.shift_type_id is ON DELETE SET NULL, so the delete blanked those days and Generate from Roster then wrote Off. Untick Active instead. (The page used to delete duplicate-named shift types on every load, which did exactly that.)',
          'Writes on the roster, shift types, swaps and publish state need HR supervisor rank in the database, not only on the page.',
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
          'Generate from Roster fills GAPS only and never overwrites a manual entry: a shift with hours becomes Present, with its hours beyond Normal hours as OT; a zero-hour shift is read by name — "PAID LEAVE" → Paid Leave, any other "LEAVE" → Unpaid Leave, "Holiday" → Holiday, "OFF DAY" → Off, anything else → Off (it was Holiday until S749; a Holiday day now pays daily and hourly staff, so only a shift named Holiday may produce one); and a day with no roster row is left blank for manual entry.',
          'On a shift with Normal hours set, punched Start/End overtime is clock time beyond those hours, lunch included, so Break does not reduce it. On a shift without, OT is hours worked (after Break) beyond the shift\'s length, as before.',
          'Working fewer hours than rostered is a visible shortfall nudge, never an automatic pay deduction — Nepal\'s Labour Act defines only full-day absence deductions, and inventing an hourly proration would be making up law.',
          'Attendance is one row per employee per day, so a month\'s sheet crosses the database\'s silent 1,000-row page size at roughly 34 staff — every read here is paged for that reason. A truncated read once paid daily staff zero and monthly staff a full month with no deductions.',
          'A month whose payroll run is FINALIZED is read-only — the page locks and a database trigger refuses every insert, edit and delete. Reopen the payroll run to correct it. A failed check of the run locks the sheet too.',
          'Absent, Paid/Unpaid Leave, Off and Holiday carry no times, hours or OT: choosing one clears them and switches the boxes off, and a save writes zeros. Payroll adds OT from every row whatever its status, so a day switched from Present to Absent used to keep paying its overtime.',
          'The bulk buttons (All Present / Off / Holiday) fill blank cells only — they used to overwrite approved leave with Present.',
          'Clear Day, like Clear Month, deletes only the listed staff\'s rows.',
        ],
        connections: 'The direct input to Payroll Run and its per-row working (statuses, hours, OT). Written by Leave approvals (and deleted by un-approvals). Seeded by the Roster. Approved Overtime entries supersede this sheet\'s OT on their days.',
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
          'Days = every calendar day in the inclusive range MINUS public holidays in the Holiday Calendar (public, not removed) — decided 2026-09-14; those days are marked Holiday on attendance, not leave. No weekday is assumed off, so a rostered "Saturday" off inside a leave range still counts. Derived by the database (hr_leave_requests_validate over bs_months); a half day is 0.5, and a request with no non-holiday day is refused.',
          'Used = Σ approved request days for the employee + type whose start date falls in the BS year (a leave crossing into the next year counts entirely in the year it starts).',
          'Remaining = annual quota − used − days encashed on a finalized Final Settlement in that year.',
        ],
        gotchas: [
          'Un-approving DELETES the attendance rows the approval wrote rather than guessing a prior status back — the pre-leave state was never recorded, so a blank "needs manual entry" day is the only honest result.',
          'Deciding a request re-reads its current status from the database first, so two supervisors working the same queue can\'t double-process one request.',
          'Reopen goes to Pending, never straight back to Approved — approval is the only thing that writes attendance rows, so a request restored as Approved would sit over an attendance sheet with those days blank and payroll would treat a paid leave as unworked. Approve it again after reopening.',
          'Reopen is manager-only by design: a supervisor can decide a request, but undoing a decision that has already cleared attendance days and moved a balance is a rank up. Owner and admin both resolve to manager here.',
          'Two pending or approved requests for one employee may not share a day (a database trigger, which also covers the Staff app). Both used to count against the balance, and cancelling one deleted attendance days the other still covered.',
          'days is derived from the dates by the database — the Staff app used to send its own figure, so ten days could be filed as half a day against the balance.',
          'Approving past the annual quota asks first and names how far over it goes; it is never blocked.',
          'Approve and cancel are refused for leave touching a month whose payroll is finalized. Approving a full day of leave also clears any hours and OT that day carried.',
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
          'Editing an entry keeps its existing status (decided 2026-09-14); only new entries start pending. The day field is validated against the real BS month length.',
          'One entry per employee per day (hr_overtime_entries_employee_day_key) — every approved entry is paid, so a second one paid the day twice.',
          'A month whose payroll is finalized is locked: approve, reject, undo, edit and delete are off, a new entry for that month is refused, and the database refuses it too. Entries are audited.',
        ],
        connections: 'Reads the Holiday Calendar (gazetted days → 2× suggestion). Approved entries flow into Payroll Run per day, superseding attendance OT. Pending count surfaces on the HR Dashboard.',
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
          'The transactional payroll page: Generate a draft for the BS month, review each employee\'s row (income tax is the one figure you can type over), Finalize to lock it, and Reopen to unwind. Generate, Finalize, Reopen and every payroll edit need HR manager rank or the owner — enforced by the database on every money table (S751), not just by the page. Payslips print with the company letterhead (a draft prints stamped "Draft — not final"); the run exports to Excel (a draft\'s file name ends _DRAFT).',
        workflow: [
          'Generate builds a draft for everyone the month\'s payroll covers (fetchPayrollEmployees): active/probation staff PLUS anyone whose end date falls on or after the month start, whatever their status — a leaver is paid to their last working day. Left out, and named on the page: anyone whose FINALIZED Final Settlement has its last working day inside the month. Nobody gets a payslip for a month they were not employed on any day. Inputs: current Attendance, approved Overtime, Advances already due for recovery (issued in an EARLIER BS month — see Advances & Loans) and Approved TADA claims whose trip has ended.',
          'Finalize re-reads everything first and REFUSES if the draft is out of date, if any employee is missing a payslip, or if a stored payslip belongs to someone this run should not pay (Regenerate removes those). The confirmation is a consequence summary — payslip count, total net pay, advance recoveries to be recorded, TADA claims to be closed — plus how many days of the month are left if it is not over yet, and how many leave / overtime requests are still pending. Finalizing early is allowed.',
          'Reopen (HR manager and above) is reopen_payroll_run() since S753 — ONE transaction under hr_pay_lock: deletes the repayment rows this run wrote (the status trigger reactivates anything owed again), puts the TADA claims IT marked Paid (Payroll) back to Approved — never one a manager settled by hand — and returns the run to draft. A written-off advance keeps its write-off and is named.',
          'Regenerate rebuilds the draft from scratch — resets any typed TDS to the calculated figure, re-reads TADA, and deletes payslips for anyone no longer on the month\'s list — behind an explicit confirm that names them.',
        ],
        fields: [
          { label: '⚠ SSF no. missing', desc: 'Flags an SSF-enrolled employee with no registration number — payroll deducts nothing for them (the recoverable direction) until the number is entered in Pay Setup.' },
          { label: 'TADA column', desc: 'Read-only (S751). Always equals the total of the claims it pays: status Approved AND end date on or before the month end, so one payroll pays a claim, ever — a 30 Bhadra–2 Ashwin trip lands in Ashwin. Added AFTER tax — TADA is a reimbursement, never taxable income. To change it, change or reject the claim in TADA Claims, then Regenerate.' },
          { label: 'TDS box and ↺', desc: 'Typing a TDS sets hr_payslips.tds_overridden. The typed figure is kept on Finalize as a deliberate override, and ↺ restores the calculated one. A TDS that would take net pay below zero is refused.' },
          { label: 'Excel export', desc: 'Carries Department, Status, Unpaid Days, Worked Days, Hours Worked and Retirement (CIT) columns. A draft export is named payroll_<month>_DRAFT.xlsx.' },
        ],
        formulas: [
          'Order of the money (buildPayrollRows() in payrollData.js, which each row\'s working also shows): computePayslip → TDS (capped at what is left) → advance cut (capped at what is left after TDS — take-home never goes below zero; the rest stays owed and later cuts take it, so a shortfall lengthens the loan rather than creating arrears) → TADA on top. computePayslip itself cuts a fixed deduction such as CIT before take-home goes negative in a part month, and retirement_contribution follows the cut so the tax relief follows the money.',
          'On Finalize (finalize_payroll_run, S753 — one transaction under hr_pay_lock): the page re-reads everything, re-checks the draft and computes the advance allocation (oldest due advance first); the function then refuses unless the stored payslips are exactly the ids checked (payroll_run_stale), refuses a run paying a settled leaver, checks the repayments add up to each payslip\'s advance cut and that each advance is active and owed that much, then flips the run, marks the TADA claims Paid (Payroll) — refusing if any is no longer Approved — and writes the repayments. All or nothing; the old post-flip payslip recount is gone. Repayments carrying payroll_run_id or final_settlement_id can only be written by these functions (hr_advance_repayments_guard_ledger).',
        ],
        gotchas: [
          'Finalize is BLOCKED outright while the draft is stale — the page recomputes every employee live through the same builder that generated the draft. Any employee whose figures MOVED, or who was added since Generate, names itself in an amber banner pointing at Regenerate. There is deliberately no "finalize anyway": a stale draft pays wrong money.',
          'Staleness compares the figures NOBODY CAN TYPE INTO — gross, OT amount, absence deduction, SSF employee, other deductions, advance deduction, retirement contribution — plus the set of TADA claim IDs, and TDS unless tds_overridden is true. Never net pay. Before S751 any TDS difference counted as an override; now an earlier month finalized late, an insurance premium or a festival/bonus payment that moves TDS without anyone typing makes the draft stale → Regenerate.',
          'A typed TDS is reported, never blocking: an amber line names those payslips and says they are locked as entered rather than recomputed, and the Finalize confirmation repeats it. Only genuine movement blocks.',
          'A stored payslip for someone NOT on the month\'s list (already paid by a finalized Final Settlement, or not employed in the month) now BLOCKS Finalize (S751). It used to be a non-blocking third bucket, and a draft payslip for a settled leaver was finalized on top of the settlement that had already paid that month. Regenerate removes it.',
          'A draft generated before the advance-timing rule (S747) may have cut an advance in the same month it was issued. The advance deduction is one of the figures the staleness check compares, so such a draft now shows as stale and must be Regenerated before it can be finalized.',
          'Once finalized, the run and its payslips are locked by database triggers (hr_run_finalized), not just the page — Reopen first. A finalized run cannot be deleted, and a period with finalized payroll cannot be deleted from Periods (period_has_finalized_payroll). A finalized month\'s per-row working shows each payslip as stored, never recomputed.',
        ],
        connections: 'Reads Attendance, Overtime (approved, per-day supersede), Pay Setup, Advances, TADA Claims (Approved, trip ended by month end), finalized Final Settlements (to leave their month out) and finalized festival/incentive rows (the YTD tax base). HR Reports shows the run while it is still a draft (with a warning) as well as once finalized; finalized payslips feed Festival/Incentive tax projections, Self-Service payslips, and the Dashboard\'s SSF-deadline card.',
      },
      {
        id: 'payroll-calculation',
        title: 'Calculation — the working inside Payroll',
        route: '/hr/payroll',
        plan: 'Manager only',
        summary:
          'How each figure on a payslip was worked out, opened from the ▸ beside an employee on the Payroll register. It was its own page (/hr/calculation) until S768; that page recomputed the same register Payroll already showed, through the same builder, so the explanation of a number lived one route away from the number. The old path now opens Payroll. On a DRAFT month the working is computed live from current Attendance/Roster/Overtime/Advances through buildPayrollRows(); on a FINALIZED month nothing is recomputed — every figure is the stored payslip "as paid", explained in plain words, so a raise given later can never make a paid month look wrong. The panel writes nothing.',
        workflow: [
          'On Payroll, open ▸ beside a name to see every intermediate: attendance tally, gross build-up, unpaid days, SSF base, the income tax panel, the advance cut due against the cut taken and how many "Advances in recovery this month" it comes from (an advance issued this month is not counted yet), TADA, and the net pay reconciliation — the place to go when someone asks "why is my pay this number?".',
          'Press 🖨 Print working on the open row to print that one employee\'s sheet. A finalized month prints "— as paid", a draft "— draft".',
        ],
        fields: [
          { label: '△ This payslip is out of date', desc: 'Draft months only, at the top of the working. A computed figure moved since Generate — gross, OT amount, absence deduction, SSF employee, other deductions, advance cut, retirement contribution, or a TDS nobody typed — or the TADA claims changed. The note names what moved, old → new (e.g. "Overtime NPR 1,200 → 1,800"), and warns that the working below is current data rather than the stored row above it. The fix is Regenerate; the page\'s amber banner names every such employee as well.' },
          { label: 'Not on this month\'s payroll any more', desc: 'A stored draft payslip for someone outside the month\'s payroll list (fetchPayrollEmployees) shows the stored figures, not a calculation, and says Regenerate will remove it.' },
          { label: 'Income tax panel', desc: 'A per-band table ("first NPR 10,00,000 at 1% — waived because SSF"), the months left in the tax year, "Tax due by this month", and earlier months\' income — which includes finalized festival allowances and bonuses. Tax that could not be withheld because pay was too low is picked up by later months.' },
          { label: 'Attendance tally', desc: 'Counts marked days only. An unmarked day is PAID for monthly staff (only absences, unpaid leave and half days deduct) and pays nothing for daily/hourly staff.' },
          { label: 'Overtime — two sources', desc: 'Attendance-sheet OT and approved Overtime entries are shown separately, with any attendance OT withheld because an approved entry covers the same day.' },
          { label: 'Travel claims paid by this payroll', desc: 'Approved claims whose trip ended by the month end — the same rule the TADA column uses, so each claim is counted in exactly one month.' },
        ],
        formulas: [
          'Identical arithmetic to the register by construction — the working is buildPayrollRows()\'s own `detail`, the same call Generate inserts from.',
        ],
        gotchas: [
          'A draft\'s working is LIVE, so on an out-of-date payslip it deliberately disagrees with the row above it — that disagreement is what the △ note is for. A finalized month shows no out-of-date note at all.',
          'The printed working uses no hover tooltips on purpose: hovers don\'t print, so every explanation is a visible row or caption.',
        ],
        connections: 'Lives on Payroll Run and reads the same loaded data: one buildPayrollRows(), one payslipDrift(), so the working can never disagree with the stale-draft banner above it.',
      },
      {
        id: 'pay-engine',
        title: 'How pay is calculated',
        route: null,
        plan: 'Reference — applies to every payroll figure',
        summary:
          'The payroll engine is a set of pure functions — no screen edits its rules. Three pay bases, SSF, join-date proration and Nepal income tax (TDS) in one place, so Payroll Run, its per-row working, and the Roster\'s cost forecast all mean the same thing by "a day\'s pay".',
        workflow: [
          'MONTHLY: gross = basic + allowances. Unpaid days = absences + unpaid leave + half of each half-day + days before the join date. Absence deduction = (gross ÷ days in the BS month) × unpaid days — allowances are forfeited too, not just basic. SSF base = min(basic × paid fraction, 100,000). Net = gross + OT − absence − SSF 11% − other deductions − TDS − advance recovery (only advances issued in an earlier BS month) + TADA. TDS and then the advance cut are each capped at what is left, so take-home never goes below zero (S751).',
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
        connections: 'Payroll Run (and its per-row working) calls these functions directly; the Roster\'s labor forecast reuses the hourly-rate rule; Festival, Incentives and Final Settlement use the marginal lump-sum tax method on top of the same slab tables.',
      },
      {
        id: 'festival',
        title: 'Festival Allowance',
        route: '/hr/festival',
        plan: 'Manager only',
        summary:
          'The statutory festival allowance run (default Dashain, paid in Ashwin): Generate seeds each employee\'s amount, amounts and TDS are editable inline, Finalize locks the run. Keyed by BS year + festival name, so several runs a year are allowed (Dashain and Tihar, say) — with a warning.',
        workflow: [
          'Name the festival, pick the BS year and the "Paid in" month (default Ashwin), then Generate. This year\'s existing runs show as clickable chips (name · month · staff · status), so a past run is opened by clicking rather than by retyping its exact name. Starting another run in the same year gets a warning, and a name differing only by case or spaces ("Dashain" / "dashain") gets its own.',
          'Adjust amounts (an amount edit recomputes that row\'s TDS; typing TDS directly overrides it), type an amount for every daily/hourly row, remove any row flagged with a chip, then Finalize.',
          '"Add missing staff" INSERTs rows only for people on the month\'s payroll who are not in the run — never an upsert, so typed amounts are untouched. ↻ Recompute is an explicit UPDATE of draft rows: monthly staff get months and amount worked out again from today\'s basic (a typed monthly amount is replaced), daily/hourly amounts are kept, and TDS is worked out again on every row (a typed TDS is replaced).',
        ],
        fields: [
          { label: 'Paid in', desc: 'Stored as bs_month. Decides the fiscal year the allowance is taxed in (a Baisakh–Ashadh payment belongs to the FY that began the Shrawan before) and the service reference date, the 15th of that month. Locked once finalized. Moving a draft\'s month re-works TDS only if the fiscal year changes.' },
          { label: 'Months-worked proration', desc: 'completedServiceMonths(): COMPLETED BS months from the join date to the 15th of the Paid in month, max 12. A leaver stops counting at their last working day. It used to subtract AD calendar months regardless of the day, always to 15 Ashwin.' },
          { label: 'Row chips', desc: '"Paid by Final Settlement", "Left before this run", "Joins after the pay month", "No longer on the payroll" — the row must go via "Remove from this run" before Finalize. "amount needed" marks a daily/hourly row still at 0, which also blocks Finalize.' },
        ],
        formulas: [
          'Amount = round(basic × completed months ÷ 12) for monthly staff. Daily/hourly staff are seeded at 0 — there is no fixed monthly basic to share out — and must be typed by hand.',
          'A tax typed over, or kept with "Keep the tax as entered", is stored as tds_overridden on the row (S753) — it no longer blocks Finalize when the calculation moves, and it is listed in the Finalize confirmation. Recompute, an amount change or a pay-month move clears the flag. Before S753 the keep was a page-session acknowledgement a reload forgot.',
          'TDS = computeRunBonusTds() in bonusTax.js, shared with Incentives: the whole-year marginal method. Base = YTD finalized payslip gross for the FY (overtime included) + the employed months left projected at basic + earning components + every OTHER finalized bonus that FY, less retirement relief and the insurance caps; TDS = tax(base + this allowance) − tax(base). SSF relief and the 1% first-slab waiver apply only to staff with SSF enrolment AND an SSF number — the same test payroll uses.',
        ],
        gotchas: [
          'Reopen sets status back to draft and nothing else: amounts become editable, but the run counts as NOT paid until it is finalized again — a leaver settled in the meantime gets a festival share in Final Settlement, and monthly payroll tax stops counting it.',
          'A finalized row is locked by a database trigger (bonus_finalized); Reopen is the only update it allows. Before S751 a Generate from a stale tab could upsert a paid run back to draft.',
          'Bank Excel/CSV skip rows with nothing to transfer, and write MISSING BANK DETAILS in the bank and account columns where they are blank — a blank account column is how a transfer silently goes nowhere.',
          'A draft generated before S747 (14 Sep 2026) may carry TDS worked out with the old SSF test (enrolment tick alone), which under-taxed an enrolled employee with no SSF number. Its stored TDS stays as it was until you Recompute, or edit that row\'s amount (which recomputes its TDS).',
        ],
        connections: 'Reads finalized payslips and every other finalized festival/incentive row for the tax base (fetchFinalizedBonuses). Finalized rows feed HR Reports\' TDS Report (in their Paid in month) and TDS Certificate, and fetchYtdMap adds them to later months\' payroll YTD gross and withheld. Final Settlement pro-rates an unpaid festival allowance using the same basic × months ÷ 12 idea.',
      },
      {
        id: 'incentives',
        title: 'Incentives / Bonus',
        route: '/hr/incentives',
        plan: 'Manager only',
        summary:
          'Ad-hoc bonus runs, optionally built from reusable incentive types ("Sales Bonus", "Attendance Bonus") defined once — a type seeds a flat amount, a percentage of monthly basic, or nothing (typed by hand each run). A run is keyed by BS year + a label you choose, so several can coexist in one year, each with its own "Paid in" month.',
        workflow: [
          'Define types in ⚙ Manage Types (name, how it is calculated, value, "Reduce for months worked"). Start a run: name it (required before Generate Run), optionally pick a type — "No type: type each amount" starts everyone at 0 — choose the Paid in month, then Generate Run, adjust amounts, Finalize.',
          'A generated run KEEPS its type (config_id on its rows) and restores it on every visit. Before S751 the dropdown reset to "no type" on each visit, and Recompute then wrote 0 over every amount of a fixed or %-of-basic run.',
          'Run chips, the second-run and near-identical-name warnings, row chips with "Remove from this run", "Add missing staff" (insert only), bank-file markers and Reopen all behave exactly as on Festival Allowance.',
        ],
        fields: [
          { label: 'Calc type', desc: 'Three choices. manual (the default for a new type) = every employee starts at 0 and you type each amount; fixed = the type\'s flat NPR value per employee, daily/hourly staff included; percent_of_basic = round(basic × value ÷ 100), capped at 100% — daily/hourly rows start at 0 marked "amount needed" and block Finalize for that type. Every seeded amount stays editable per row.' },
          { label: 'Reduce for months worked', desc: 'prorate_by_service: amount × completed BS months worked up to the 15th of the Paid in month ÷ 12. A NPR 6,000 bonus for someone who joined 4 months before pays NPR 2,000.' },
          { label: 'Editing a type', desc: 'Name, calculation, value and Active can all be edited. Runs already generated keep their amounts; Recompute on a DRAFT run using the type applies the new setting; finalized runs never change. Deleting a type leaves its runs\' amounts but removes their type (SET NULL).' },
          { label: '↻ Recompute', desc: 'Names the run\'s type in its confirm. A fixed or % type re-seeds every amount from today\'s salaries (typed amounts replaced, except daily/hourly amounts on a % type); a typed-by-hand run or a run with no type keeps every amount. TDS is worked out again on every row either way.' },
        ],
        formulas: [
          'TDS = computeRunBonusTds() in bonusTax.js — the same whole-year marginal method and SSF test as Festival Allowance, because it is the same code: YTD gross with overtime, the months left projected at basic + earning components, and every other finalized bonus that fiscal year, with relief and the 1% waiver only for staff with SSF enrolment AND an SSF number.',
        ],
        gotchas: [
          'A draft generated before S747 (14 Sep 2026) may carry TDS worked out with the old SSF test (enrolment tick alone). Its stored TDS stays as it was until you Recompute, or edit that row\'s amount (which recomputes its TDS).',
          'Festival Allowance and Incentives share ONE tax calculation, src/modules/hr/payroll/bonusTax.js (S751). It replaced two copies that had each got the pay month, the projection, other bonuses and overtime wrong. A tax-rule change is made once, there — and a new bonus-like table must join fetchFinalizedBonuses or it is taxed as though it were never paid.',
        ],
        connections: 'Reads finalized payslips and every other finalized festival/incentive row for the tax base, like Festival. Finalized rows feed the TDS Report, TDS Certificate and later months\' payroll YTD. Types are reusable across runs and years.',
      },
      {
        id: 'advances',
        title: 'Advances & Loans',
        route: '/hr/advances',
        plan: 'Manager only',
        summary:
          'The advance/loan ledger: issue a One-time advance or an In instalments loan (no interest is charged), record cash repayments, forgive a balance with Write off, and watch payroll recover the rest automatically. Filters by type and by status.',
        workflow: [
          'Issue: employee, type, amount, date, monthly instalment, purpose. Under the date the form shows "First salary cut: <month> payroll" so you can tell the employee when the money starts coming back — or, for a back-dated advance, which months are already finalized and where the first cut lands instead. The detail panel shows the repayment history (with a Source column), derived balance and the next salary cut.',
          'Repayments arrive three ways — written by Payroll Run\'s Finalize, written by Final Settlement, or recorded here by hand for cash or bank money the employee returned. Salary cuts must NOT be entered by hand; the Record Repayment modal says so.',
          'Write off NPR <owed> forgives the balance: a reason is required, the amount / who / when are stamped server-side, the advance gets a grey Written off badge and can be Reactivated. Payroll stops cutting it and Final Settlement will not recover it.',
        ],
        fields: [
          { label: 'When payroll starts recovering', desc: 'The payroll of the BS month AFTER the month the advance was issued. The day does not matter: an advance given on 1 Bhadra and one given on 28 Bhadra are both first cut in the Ashwin payroll. An advance issued in Chaitra is first cut in Baisakh of the next year. A back-dated advance whose first month\'s payroll is already finalized is first cut in the first month without finalized payroll. Payroll\'s per-row working counts the "Advances in recovery this month".' },
          { label: 'Installment / Month', desc: 'A real salary cut, not a reminder. REQUIRED for a loan. LEFT BLANK on a one-time advance, the FULL outstanding balance comes off the first payroll the advance is due in — never more than that month\'s pay; the rest waits for the next.' },
          { label: 'Source (repayment history)', desc: 'Payroll / Final Settlement / Manual. Only a Manual row can be deleted here (logged; the advance goes back to owing and reactivates). Payroll and Final Settlement rows show a lock — undone only by reopening that run or settlement.' },
          { label: 'Status', desc: 'Active = brass/gold (owed, not overdue — nothing is wrong), Settled = green, Written off = grey. Total Outstanding excludes written-off balances; a separate Written Off card shows their total.' },
        ],
        formulas: [
          'Outstanding is always DERIVED — amount − Σ repayments. There is no stored balance column to drift out of sync.',
          'Payroll deduction per active advance that is due this month = min(installment, outstanding); multiple due advances for one employee sum. An advance issued this month adds nothing yet. The total cut is then capped at the pay left after TDS — take-home never goes below zero, and whatever is not taken stays owed (a shortfall lengthens the loan; there are no arrears).',
        ],
        gotchas: [
          'The database now owns the ledger\'s rules (S751): a repayment may not exceed what is owed or land on a non-active advance; an AFTER trigger keeps status in step with the balance (repaid → settled, a repayment removed → active); Settle is refused while anything is owed; an advance with repayments cannot be deleted — write it off instead.',
          'Finalize settles an advance the moment its balance reaches zero; Reopen deletes payroll\'s own repayment rows and reactivates anything that regains a balance — manual repayments are never touched by either.',
          'HR Dashboard\'s Advances Outstanding tile shows "—" when its reads fail, never NPR 0.',
          'The start-next-month rule is new (S747, 14 Sep 2026). An open payroll draft generated before it that cut an advance in its issue month now shows as stale on Payroll Run — press Regenerate before Finalize.',
          'Final Settlement ignores the timing rule: a leaver has no later payroll, so every outstanding advance is recovered, however recently it was issued.',
        ],
        connections: 'Payroll Run reads active advances that are due for the deduction and writes repayments on Finalize. Final Settlement deducts every active advance\'s full outstanding, whenever it was issued — but never a written-off one. The Dashboard shows total outstanding.',
      },
      {
        id: 'tada',
        title: 'TADA Claims',
        route: '/hr/tada',
        plan: 'Supervisor+ (Mark Paid and settings: Manager)',
        summary:
          'Travel & Daily Allowance claims — money staff spent on work trips (a bus fare to collect supplies, say), repaid to them: an employee (or the office, on their behalf) files a trip with line items, it climbs an approval ladder — pending → approved → paid — and an approved claim is paid by the first payroll after approval once the trip is over, as a non-taxable reimbursement. A settings modal holds purpose options, start points and per-vehicle km rates.',
        workflow: [
          'File a claim: trip dates, purpose, start point, line items (travel legs with vehicle type and km, plus other expenses). A supervisor-or-above entry goes through create_tada_claim (one transaction); an employee\'s goes through submit_my_tada_claim from Self-Service.',
          'A supervisor or above approves or rejects it — never their own claim (matched on profiles.hr_employee_id or the employee record\'s email; the row says "Your own claim"). approved_by is set server-side.',
          'An Approved claim is then paid ONE way: automatically by the first payroll whose month end is on or after the trip\'s end date (finalizing that payroll marks it Paid (Payroll)), or by an HR manager with Mark Paid for cash/bank. Each approved row says which: "In the <Month> payroll draft" or "Will be paid by the next payroll".',
        ],
        fields: [
          { label: 'Per-vehicle km rates', desc: 'Three fixed vehicle categories — 2-wheeler, 4-wheeler, EV — each with its own NPR/km rate set in the settings modal. Only the rates are editable, not the categories.' },
          { label: 'Status ladder', desc: 'pending (amber — waiting on a decision) → approved (brass — money owed, not yet disbursed) → paid (green). It is a ladder, not tags: a claim never skips approved. Pending used to be grey here and approved amber, which read as the opposite of every other HR queue.' },
          { label: 'Tabs and the month filter', desc: 'Pending and Approved show every OPEN claim from any month — a pending claim from last month\'s trip used to be invisible on the Pending tab while the Dashboard counted it. The month filter narrows only Paid, Rejected and All, which are history.' },
          { label: 'Mark Paid', desc: 'Paid in cash or by bank OUTSIDE payroll; needs an HR manager and a method. If the claim is already inside a payroll draft, the page asks first: paying by hand takes it out of that payroll, and that payroll must be Regenerated before it is finalized or the draft still carries the amount.' },
        ],
        formulas: [
          'Travel line = km × the vehicle type\'s rate; claim total = travel lines + other expense lines.',
          'Paid by payroll month M ⇔ status = approved AND end_date ≤ last day of M. One claim, one payroll — a trip crossing a month end is paid in the month it ends.',
        ],
        gotchas: [
          'The ladder is enforced by trigger (S751): pending → approved/rejected (never your own); approved → paid needs a manager and a method; paid (Payroll) → approved only through a payroll Reopen. A decided claim\'s employee, dates and total are frozen, and only a pending claim can be deleted.',
          'TADA is NOT month-scoped like the rest of HR — claims live on plain AD trip dates with no BS period attached; the month filter buckets them by converting the start date. A claim belongs to a payroll only by the end-date rule above.',
          'A trip cannot end before it starts and amounts cannot be negative (numeric accepts \'NaN\' and NaN > 0 is true, so the CHECK spells out <> \'NaN\'). A manager-entered claim matching another on employee, dates and total gets a duplicate warning; submit_my_tada_claim refuses an identical claim outright.',
          'Payroll adds TADA AFTER tax — it is a reimbursement of the employee\'s own money, never taxable income. The payslip\'s TADA amount is not editable; change or reject the claim instead.',
        ],
        connections: 'Approved claims whose trip has ended fill Payroll Run\'s read-only TADA column (and are marked Paid (Payroll) by its Finalize; Reopen puts them back to Approved). Payroll\'s per-row working counts them as "Travel claims paid by this payroll". Employees file their own claims from Self-Service\'s TADA tab. Pending count surfaces on the HR Dashboard.',
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
          'Six statutory and operational outputs in one page: Employee Directory, Payroll Summary, SSF Challan, Bank Transfer sheet, TDS Report, and a per-employee printable TDS Certificate for a fiscal year. The two TDS outputs include finalized Festival Allowances and Incentives as well as payslips (S751).',
        workflow: [
          'Pick the month (or FY for the certificate). The Directory loads independently of any payroll run. Payroll Summary, SSF Challan, Bank Transfer and TDS Report show whatever run the month has — a DRAFT included, under a "This payroll is still a draft — figures may change" warning. Only the TDS Certificate is limited to finalized payslips. Finalize in Payroll Run before filing or paying from these sheets.',
          'SSF Challan is the deposit sheet: per employee with SSF enrolment and an SSF number, an "SSF Basic" column and the 11% + 20% split. Bank Transfer lists net pay against each employee\'s bank details from Pay Setup.',
        ],
        fields: [
          { label: 'TDS Certificate', desc: 'Per employee, per fiscal year — YTD withholding evidence. Lists festival allowances and incentives in their own table (by their Paid in month) and includes them in total income and total tax withheld. Insurance relief uses the premiums stored on the latest payslip or settlement of that year (S753) — the employee record only for a year paid before payslips kept them, and the line says so. The company PAN in its header comes from the VAT/PAN number in Settings (Nepal uses one number for both); it prints a blank line only when genuinely unset.' },
          { label: 'TDS Report', desc: 'One row per employee paid salary OR a finalized bonus this month. Festival allowances and incentives are included when finalized with this month as their pay month (bs_month); "Total to deposit" = salary tax + that bonus tax. The sheet still renders for a month with bonuses but no payroll run. A failed bonus read blocks the sheet rather than printing a smaller deposit.' },
          { label: 'Withheld this year', desc: 'Finalized payslips + finalized bonuses from Shrawan up to this month — plus a DRAFT month\'s own salary tax when the selected run is still a draft.' },
        ],
        formulas: [
          'SSF challan row: the 11% and 20% columns are the figures stored on the payslip, which payroll worked out on min(basic actually earned, 100,000) — for monthly staff that is basic × the share of the month paid. Total 31% = the two added together.',
          'SSF challan rows come from the contributions actually stored — the month\'s payslips plus any finalized Final Settlement whose final month it is — and "SSF Basic" is derived from them ((11% + 20%) ÷ 31%), so it always agrees with the two columns beside it. An enrolled employee with no SSF number and nothing deducted is counted separately.',
          'TDS Report and TDS Certificate include a settlement\'s final-month salary and tax, and its exit payments (gratuity, leave, festival share, notice pay) with their lump-sum tax as their own rows (S752).',
          'Employer cost (Payroll Summary) = gross + OT + employer SSF 20%.',
          'Total deductions = absence + SSF employee share + other deductions + TDS.',
        ],
        gotchas: [
          'The challan filters on enrolment AND registration number (as they are in Pay Setup now) and says "N employees without an SSF number excluded". That N is EVERY payslip in the run not on the challan — staff who were never enrolled in SSF count too — so a non-zero figure is normal for an outlet with non-SSF staff. It only means a missing number if the person should be enrolled.',
          'The page tells you to type each row\'s SSF No and SSF Basic into SOSYS (SSF\'s portal), whose own calculation "should match" Total 31%. For a staff member with unpaid days that match cannot hold, because SSF Basic is the full capped basic while the 11% + 20% were taken on less — check those rows by hand rather than assuming the sheet and SOSYS agree.',
        ],
        connections: 'Payroll Summary, SSF Challan, Bank Transfer and TDS Report read the month\'s payroll run from Payroll Run, draft or finalized; SSF Challan, TDS Report and TDS Certificate also read finalized Final Settlements (month_* and lump-sum columns); the TDS Report and TDS Certificate also read finalized Festival Allowance and Incentive rows (fetchFinalizedBonuses); the TDS Certificate reads finalized payslips only; the Directory reads Employees. Bank details come from Pay Setup; the PAN from Settings.',
      },
      {
        id: 'gratuity',
        title: 'Gratuity',
        route: '/hr/gratuity',
        plan: 'Manager only',
        summary:
          'A read-only view of the gratuity owed across active and probation monthly staff if everyone left today — who has vested, what has built up, how much the employer has already paid into the SSF gratuity fund for them, and the cash still exposed. Excel export for the accountant.',
        workflow: [
          'Filter vested / vesting / all, or by department. Nothing here writes — the actual payout happens in Final Settlement. A banner names any finalized settlement not yet marked paid.',
        ],
        fields: [
          { label: 'Vested', desc: 'Twelve COMPLETED months of service or more (S752). A month is completed on the same day of the month as the join date — joined 15 Shrawan 2082, 11 months on 14 Shrawan 2083, 12 on the 15th. The 12-month rule is Crest\'s reading of the Labour Act; the page carries an accountant caveat.' },
          { label: 'SSF funded', desc: 'The employer SSF actually recorded for this person — on finalized payslips and finalized settlements — times the gratuity share of it (3.33 of every 20). Shows the months it covers, or "No contributions yet". It is never inferred from an enrolment flag or a start date.' },
        ],
        formulas: [
          'Accrual = basic ÷ 12 per COMPLETED month of service (completedMonths walks BS anniversaries, clamping the day to the month\'s length). Total accrued = basic ÷ 12 × completed months.',
          'SSF funded = Σ stored employer SSF × (SSF_GRATUITY_PCT ÷ SSF_EMPLOYER_PCT), capped at what has accrued. Net cash liability = accrued − SSF funded.',
          'Enrolled for display = isSsfContributor (enrolment AND an SSF number), the payroll rule.',
        ],
        gotchas: [
          'Daily and hourly staff are excluded — there is no fixed monthly basic to accrue on — and the page says how many were skipped.',
          'S600 derived an SSF START from the first SSF-bearing payslip and multiplied 3.33% of capped basic by the months since. S752 replaced it with the money itself: a month on unpaid leave, a mid-month join, or a gap in enrolment contributed less or nothing, and the start-date method still offset it.',
          'No contributions recorded means NO offset, never a guess — the wrong guess silently reduces what a leaver is paid once.',
          'A failed read of employees, contributions or settlements shows an error, never a table of zeros.',
        ],
        connections: 'Final Settlement uses the same gratuityCompute.js, passing the leaver\'s stored contributions plus the final month\'s own employer SSF. Basic comes from Pay Setup; service from the join date on Employees.',
      },
      {
        id: 'settlement',
        title: 'Final Settlement',
        route: '/hr/settlement',
        plan: 'Manager only',
        summary:
          'Computes AND records a leaver\'s full and final payout: the final month run through the payroll engine, unpaid approved travel claims, leave encashment, gratuity, the festival share, notice pay, less advances and tax. Draft first; Finalize (one database transaction) records the advance repayments, marks the travel claims paid, marks the employee left and blocks their Staff app login. A finalized settlement is locked and shown exactly as stored.',
        workflow: [
          'Pick the employee and the last working day (BS). The page loads that month\'s attendance and approved overtime, the year\'s finalized pay for tax, the SSF contributions, advances, approved TADA claims, leave taken and festival payments. Any failed read blocks saving.',
          'Check leave days, notice and festival, then Save draft. Finalize saves the draft and calls finalize_final_settlement, which re-checks everything that can have moved.',
          'Reopen (Owner or HR manager, reason required) calls reopen_final_settlement: advance repayments it wrote are deleted, travel claims it paid go back to Approved, the row returns to draft. The employee stays marked as left — change status in Employees to cancel the leaving.',
          'Mark paid once the money leaves; that is the only change a finalized row accepts.',
        ],
        fields: [
          { label: 'Final month', desc: 'computePayslip with end_date = the last working day, attendance and overtime cut at that day: gross, allowances, absence, OT, SSF 11%/20%, CIT and other deductions — stored as month_* columns. No payroll run pays this month for this employee.' },
          { label: 'Notice', desc: 'basic ÷ 30 per calendar day. Resigned without serving it → the missing days are DEDUCTED (notice_deduction). Terminated without notice → the missing days are PAID (notice_pay). Mutual separation or retirement → none.' },
          { label: 'Leave encashment', desc: 'Days earned so far this BS year = quota × completed months worked this year ÷ 12, minus days taken and days already encashed; paid at basic ÷ 26 per day (the ÷26 divisor is unconfirmed with an accountant).' },
          { label: 'Travel (TADA)', desc: 'Every Approved claim not yet paid, stored as tada_amount + tada_claim_ids and marked Paid (Final Settlement) on Finalize.' },
        ],
        formulas: [
          'Month TDS = computeFinalMonthTds: the year\'s tax on actual income (finalized payslips + this month, retirement relief on SSF + CIT in one cap, insurance) minus tax already withheld, capped at the month\'s net.',
          'Lump-sum TDS = computeBonusTds on (gratuity + leave encashment + festival share + notice pay), on top of that year\'s taxable income.',
          'Gratuity (vested only) = calcGratuity with ssfFunded = prior stored employer SSF + this month\'s own.',
          'Festival share (only if not paid this FY) = basic × completed months from max(FY start, join) ÷ 12.',
          'Net = month income + TADA + lump sums − (SSF + other deductions + month TDS + lump TDS + notice deduction + advances). Advance recovery is capped at what the payout covers.',
        ],
        gotchas: [
          'Finalize refuses (settlement_stale*, settlement_month_paid, settlement_overlap) when the advances or approved TADA set changed since the draft was saved, a finalized payroll run already pays this month or later, or another finalized settlement covers this spell. It runs under hr_pay_lock — the lock payroll Finalize takes too, which is what stops the two paying one month in two tabs.',
          'Payroll Finalize refuses a run holding a payslip for a month a finalized settlement paid (run_has_settled_employee).',
          'hr_final_settlements_guard: an insert must be a draft, a draft cannot be flipped to finalized by UPDATE, a finalized row cannot be deleted or edited — only marked paid once. A stale tab\'s Update draft on a finalized row is refused.',
          'A draft saved before S752 (calc_version 1) must be opened and saved again before Finalize; an old finalized row still renders its partial-month statement.',
          'Run the settlement BEFORE marking anyone resigned — the picker lists active and probation staff.',
          'Finalize BLOCKS the leaver\'s HR, IMS or POS staff logins linked through hr_employee_id (auth ban + sessions revoked, profiles.settlement_blocked_by, names in blocked_logins) — never deletes them, because a deleted login nulls closed_by / sent_by on every bill, KOT and shift it recorded (decided, S753). Reopen unbans exactly the logins its own settlement banned. A login never linked to the employee record is not found. Nobody below the Owner finalizes or reopens their own settlement (hr_own_request).',
          'access_blocked now ends Staff-app access outright (S753): the sessions are revoked by trigger, and every Staff-app RPC calls hr_self_service_assert_active() first, so an access token still valid for up to an hour is refused too.',
        ],
        connections: 'Writes hr_advance_repayments (final_settlement_id), hr_tada_claims (paid, final_settlement_id) and hr_employees (status, end_date, access_blocked). Its month_* and lump figures feed HR Reports\' SSF Challan, TDS Report and TDS Certificate, Gratuity\'s SSF history, and payroll\'s employee list (a settled month is left out).',
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
          { label: 'Access levels', desc: 'Staff: view-only pages like the Holiday Calendar. Supervisor: attendance, leave, overtime, roster, TADA approvals (other people\'s claims, never their own), the HR Dashboard, and adding or editing holidays. Manager: everything — payroll, pay setup, employees, reports, marking TADA claims Paid, this page. Since S751 the money tables (payroll runs, payslips, salary components, settlements, advances and repayments, festival allowances, incentives and incentive types) are manager-only at the database level, and TADA claims need supervisor rank or above, so a lower rank is refused over the REST API too, not just hidden in the nav.' },
        ],
        formulas: [],
        gotchas: [
          'Never assign an HR role to the OWNER\'s own login — Owner status is the absence of staff roles, so doing that demotes them to exactly that rank\'s access and nothing more (Suite features included). Staff rows are for staff.',
          'Nothing re-ranks on page load any more (S752). The old silent repair meant a role-list edit — which any same-client login could make — promoted everyone holding that title the next time a manager opened the page. A mismatch now shows an amber banner, and moves only through Apply with a confirm naming who moves. The role lists in settings are writable only by the Owner or that module\'s manager (settings_guard_staff_roles).',
          'There is no "No Access" option: a login with no rank matched every Owner test, so taking access away means deleting the login, and admin-user-ops refuses a create or role change with no rank.',
          'Only the Owner or admin grants Manager, acts on a manager\'s login, or uses Existing User mode. A manager never resets or deletes their own row or a peer manager\'s. A role people hold cannot be removed, and the first custom role is added beside Staff / Supervisor / Manager.',
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
          'The Owner or an HR Manager enables Self-Service for an employee (sets the PIN) and shares the company\'s one login link from Employees → Copy Self-Service Link. The employee opens it, taps their own name, enters the PIN.',
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
