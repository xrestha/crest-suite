// The setup guide (S790): which first-weeks steps a viewer is shown, how each one ticks, and what
// the dashboard card should look like. Pure data plus one pure builder, so every rule below is
// asserted in setupSteps.test.js without a database.
//
// Four decisions from the owner shape it (S790, asked in plain words):
//   * A box ticks when the job is really DONE (the first bill is saved), never because a page was
//     opened. Opening a page from the guide records "Started, not saved yet" and nothing more. The
//     research behind it: looking at a screen feels like learning without being learning.
//   * Every step can be skipped ("we don't need this"), the card can be hidden to one line, and
//     both are remembered on the person's login (onboarding_progress), so phone and counter PC agree.
//   * A client with several modules is first asked what to set up first; only that part opens.
//   * New clients only: a trial, or the first WINDOW_DAYS after Crest approved them. Anyone can
//     bring it back from Help ("reopened").
//
// Step keys are stored in onboarding_progress.step_key, so a key is permanent once shipped:
// renaming one silently resets that step for every client. Change the label, never the key.

export const WINDOW_DAYS = 60
// The month-end steps appear this many days before the first month ends (BS months run 29–32 days,
// so this is counted back from daysInBsMonth, never from a fixed 30).
export const MONTH_END_LEAD_DAYS = 5

const RANK = { staff: 1, supervisor: 2, manager: 3 }

export const GROUPS = [
  { key: 'start', title: 'Start here' },
  { key: 'ims', module: 'ims', title: 'Stock & costing', pick: 'Stock & costing',
    pickHint: 'Your items, suppliers, bills and food cost',
    habit: 'Enter every supplier bill on the day it arrives.' },
  { key: 'pos', module: 'pos', title: 'Till & bills', pick: 'Till & bills',
    pickHint: 'Your menu prices, tables and your first bill',
    habit: 'Close the shift every night and count the cash.' },
  { key: 'hr', module: 'hr', title: 'Staff & payroll', pick: 'Staff & payroll',
    pickHint: 'Your employees, their pay and attendance',
    habit: 'Mark attendance every day — payroll pays from it.' },
  { key: 'monthend', title: 'Your first month-end' },
]

export const MODULE_GROUP_KEYS = ['ims', 'pos', 'hr']

export const DEFAULT_SKIP = "Skip — we don't need this"

// tick:  'data'   — done when `signal` reads true (the saved thing exists)
//        'manual' — done when the person presses `doneLabel` (things Crest cannot see)
//        'visit'  — done once opened from the guide (a "just look at it" step)
// access: who may be shown the step. Owner and Crest admin see everything the client has; a
//         manager sees only steps whose page their rank opens (the page guards, not the nav).
// strip: what to press on the page the step opens — shown in the "Setup step N of M" strip there.
// note:  a caution that is true for THIS step; steps that are easy to undo get REASSURE instead.
export const REASSURE = 'You can change or delete this later.'

export const STEPS = [
  // ── Start here (Owner only) ──
  { key: 'start.account', group: 'start', phase: 'setup', tick: 'data', signal: 'periodsAny',
    access: { owner: true }, skip: false,
    label: 'Your Crest account is ready',
    hint: 'Crest has opened your first month for you, so this one is already done.',
    hintWhenNotDone: "Your first month isn't open yet. Call or message us and we'll open it for you." },
  { key: 'start.call', group: 'start', phase: 'setup', tick: 'manual', doneLabel: "We've had the call",
    access: { owner: true }, skip: "No thanks — we'll set up ourselves", contact: true,
    label: 'Have a 20-minute setup call with Crest',
    hint: "We'll help you get started and answer your questions. Send us a photo or an Excel file of the things you buy, and we'll enter your items for you — units included." },

  // ── Stock & costing ──
  { key: 'ims.items', group: 'ims', phase: 'setup', tick: 'data', signal: 'items', module: 'ims',
    access: { ims: 'supervisor' }, route: '/items', where: 'IMS → Operations → Item Master',
    label: 'Add the things you buy',
    hint: 'Start with your 10 most-used. Choose the unit you cook with: Chicken in GM, Cooking oil in ML, Eggs in PCS. Only know the pack price? Use the "Bought a pack?" line and Crest works out the price per unit.',
    note: "An item's unit can't be changed once it has been bought or counted, so pick it carefully.",
    strip: 'Press + Add Item (bottom right). Give it a name, a unit and a price, then save.' },
  { key: 'ims.vendors', group: 'ims', phase: 'setup', tick: 'data', signal: 'vendors', module: 'ims',
    access: { ims: 'supervisor' }, route: '/vendors', where: 'IMS → Operations → Vendors',
    label: 'Add your suppliers',
    hint: 'The shops and wholesalers you buy from, e.g. your chicken supplier. Add their PAN if they give you VAT bills.',
    note: REASSURE,
    strip: "Press + Add Vendor (bottom right), type the supplier's name and save." },
  { key: 'ims.opening', group: 'ims', phase: 'setup', tick: 'data', signal: 'openingStock', module: 'ims',
    access: { ims: 'staff' }, route: '/stock', where: 'IMS → Operations → Stock Count',
    label: "Count what's in your store today",
    hint: 'Type how much of each item you have right now, so Crest knows what you started with.',
    note: "Skip it and your first month's cost of what you used (Monthly Summary) reads too low.",
    skip: 'Skip — start from the month-end count instead',
    strip: 'Stay on the Opening Stock tab, type how much of each item you have, then press Save All.' },
  { key: 'ims.purchase', group: 'ims', phase: 'setup', tick: 'data', signal: 'purchase', module: 'ims',
    access: { ims: 'staff' }, route: '/purchases', where: 'IMS → Operations → Purchases',
    label: 'Enter your first supplier bill',
    hint: "Type in a bill you were given today: pick the supplier and the date, then add each item with its quantity and price. Quantities are in each item's own unit (GM, ML, PCS).",
    note: REASSURE,
    strip: 'Press + Add Purchase (bottom right), fill in the bill and save.' },
  { key: 'ims.menu', group: 'ims', phase: 'next', tick: 'data', signal: 'menuPriced', module: 'ims',
    when: ctx => !ctx.modules.pos, feature: 'menu_pricing',
    access: { menuPricing: true }, route: '/menu-pricing', where: 'IMS → Costing → Menu Pricing',
    label: 'Put your dishes and prices on the menu',
    hint: 'Every dish you sell with its price, e.g. Chicken Momo NPR 250. Your daily sales are entered against this list.',
    note: REASSURE,
    strip: 'Press + Add Item at the top, type the dish and its price, then save.' },
  { key: 'ims.sales', group: 'ims', phase: 'next', tick: 'data', signal: 'sales', module: 'ims',
    when: ctx => !ctx.modules.pos, feature: 'sales_entry',
    access: { ims: 'staff' }, route: '/sales', where: 'IMS → Operations → Sales Entry',
    label: "Enter one day's sales",
    hint: 'How many of each dish you sold, from your bill book. Every % in Crest is measured against your sales.',
    note: REASSURE,
    strip: 'Pick the day, type how many of each dish you sold, then press Save Day.' },
  { key: 'ims.recipes', group: 'ims', phase: 'next', tick: 'data', signal: 'recipesCosted', module: 'ims',
    feature: 'recipe_costing',
    access: { ims: 'supervisor' }, route: '/recipes', where: 'IMS → Costing → Recipe Costing',
    label: 'Cost your 5 best-selling dishes',
    hint: 'Tell Crest what goes into one plate — e.g. Chicken Momo: 120 GM chicken, 80 GM flour — and it works out what that plate costs you.',
    note: REASSURE,
    strip: 'Press + New Recipe (bottom right), then add each ingredient and how much one plate uses.' },

  // ── Till & bills ──
  { key: 'pos.menu', group: 'pos', phase: 'setup', tick: 'data', signal: 'menuPriced', module: 'pos',
    feature: 'menu_pricing',
    access: { menuPricing: true }, route: '/menu-pricing', where: 'POS → Menu → Menu Pricing',
    label: 'Put your dishes and prices on the menu',
    hint: "Every dish you sell with its price, e.g. Chicken Momo NPR 250. Keep 'On POS' ticked so it shows on the till.",
    note: REASSURE,
    strip: "Press + Add Item at the top, type the dish and its price, and keep On POS ticked." },
  { key: 'pos.bill', group: 'pos', phase: 'setup', tick: 'manual', doneLabel: 'My bill details are right',
    module: 'pos', access: { owner: true }, skip: false, billDetails: true,
    label: 'Check what your bill will say',
    hint: 'Your shop name, address, PAN or VAT number and bill number code print on every bill. Crest sets these for you, so check them before your first customer and tell us if anything is wrong.' },
  { key: 'pos.tables', group: 'pos', phase: 'setup', tick: 'data', signal: 'tables', module: 'pos',
    access: { pos: 'manager' }, route: '/pos/tables', where: 'POS → Admin → POS Setup',
    label: 'Set up your tables',
    hint: 'So every order belongs to a table. Quick Setup makes Table 1 to Table 10 in one press.',
    note: REASSURE,
    skip: "We don't have tables (takeaway or counter only)",
    strip: 'Press ⚡ Quick Setup and choose how many tables you have.' },
  { key: 'pos.device', group: 'pos', phase: 'setup', tick: 'data', signal: 'devices', module: 'pos',
    access: { pos: 'manager' }, route: '/pos', where: 'POS → Admin → Till Devices',
    label: 'Switch on the till tablet',
    hint: 'Do this on the tablet or computer you bill from: sign in there with your own email, open Till Devices, give it a name like "Front counter" and press Activate. Then press Open POS Login Screen so staff sign in with their PIN.',
    skip: 'Skip — I bill from this computer with my own login',
    strip: 'On the till tablet: type a name like Front counter, press Activate, then press Open POS Login Screen.' },
  { key: 'pos.firstbill', group: 'pos', phase: 'setup', tick: 'data', signal: 'paidBill', module: 'pos',
    access: { pos: 'supervisor' }, route: '/pos/shifts', where: 'POS → Floor → Shifts, then Orders',
    label: 'Bill your first real customer',
    hint: 'First open the shift and count the cash in the drawer. Then go to POS → Floor → Orders: pick a table, add the dishes, send the order, and take the payment. The bill prints.',
    note: "A real bill can't be deleted. If you make a mistake, a supervisor presses Void.",
    skip: false,
    strip: 'Press Open Shift and count the cash in the drawer. Then go to POS → Floor → Orders.' },
  { key: 'pos.pins', group: 'pos', phase: 'next', tick: 'data', signal: 'posStaff', module: 'pos',
    access: { pos: 'manager' }, route: '/pos/staff', where: 'POS → Admin → POS Staff',
    label: 'Give your cashier a PIN',
    hint: 'Each person gets their own PIN to sign in on the till, so every bill shows who made it.',
    note: REASSURE,
    skip: 'Skip — I bill myself',
    strip: 'Press + Add Staff, type their name and choose a PIN.' },
  { key: 'pos.closeday', group: 'pos', phase: 'next', tick: 'data', signal: 'shiftClosed', module: 'pos',
    access: { pos: 'supervisor' }, route: '/pos/shifts', where: 'POS → Floor → Shifts',
    label: 'Close the day and count the cash',
    hint: 'At closing time, close the shift and count the drawer. Crest shows if the cash is short or over.',
    strip: 'Press Close Shift & Count Cash and type what is in the drawer.' },
  { key: 'pos.salesreport', group: 'pos', phase: 'next', tick: 'visit', module: 'pos',
    access: { pos: 'manager' }, route: '/pos/sales-report', where: 'POS → Reports → Sales Report',
    label: "Check today's sales",
    hint: 'See what sold today and how you were paid — cash, QR or card.',
    strip: "This is your Sales Report. Today's total and each way you were paid are at the top." },

  // ── Staff & payroll ──
  { key: 'hr.employees', group: 'hr', phase: 'setup', tick: 'data', signal: 'employees', module: 'hr',
    access: { hr: 'manager' }, route: '/hr/employees', where: 'HR → People → Employees',
    label: 'Add your staff',
    hint: 'Everyone you pay, e.g. Sita, cook, joined 1 Baisakh. Start with the name and joining date; the rest can wait.',
    note: REASSURE,
    strip: 'Press + Add Employee (bottom right). Name and joining date are enough to start.' },
  { key: 'hr.pay', group: 'hr', phase: 'setup', tick: 'data', signal: 'paySet', module: 'hr',
    access: { hr: 'manager' }, route: '/hr/pay-setup', where: 'HR → People → Pay Setup',
    label: "Set each person's pay",
    hint: 'A monthly salary, or a daily or hourly rate, and SSF if they are enrolled. Payroll uses this every month.',
    note: REASSURE,
    strip: "Click a person's row to set their pay, then save." },
  { key: 'hr.holidays', group: 'hr', phase: 'setup', tick: 'data', signal: 'holidays', module: 'hr',
    access: { hr: 'supervisor' }, route: '/hr/holidays', where: 'HR → People → Holiday Calendar',
    label: "Load this year's public holidays",
    hint: 'One press fills in Dashain, Tihar and the rest of this year. Holidays change overtime pay.',
    note: REASSURE,
    strip: 'Press Seed (top of the page) to fill in this year from the Nepal Gazette.' },
  { key: 'hr.attendance', group: 'hr', phase: 'setup', tick: 'data', signal: 'attendance', module: 'hr',
    access: { hr: 'supervisor' }, route: '/hr/attendance', where: 'HR → Attendance → Attendance',
    label: 'Mark attendance for one day',
    hint: 'Mark who came in today. Payroll pays from this sheet, so an unmarked day pays daily-rate staff nothing.',
    note: REASSURE,
    strip: 'Pick today, press All Present, change anyone who was off, then press Save Day.' },
  { key: 'hr.selfservice', group: 'hr', phase: 'next', tick: 'data', signal: 'selfService', module: 'hr',
    access: { hr: 'manager' }, route: '/hr/employees', where: 'HR → People → Employees',
    label: 'Give staff the Crest Staff phone app',
    hint: 'Staff see their payslips and ask for leave on their own phone.',
    strip: "Press Enable Self-Service on a person's row, then Copy Self-Service Link and send it to them on Viber." },

  // ── Your first month-end (shown only near the end of the first month) ──
  { key: 'monthend.count', group: 'monthend', phase: 'monthend', tick: 'data', signal: 'closingStock', module: 'ims',
    access: { ims: 'staff' }, route: '/stock', where: 'IMS → Operations → Stock Count',
    label: 'Count your store on the last day',
    hint: "On the last day of the month, count what's left, before the next delivery arrives.",
    strip: "Open the Closing Stock tab, type what's left of each item, then press Save All." },
  { key: 'monthend.close', group: 'monthend', phase: 'monthend', tick: 'data', signal: 'periodClosed',
    access: { closeMonth: true }, route: '/periods', where: 'Periods',
    label: 'Close the month',
    hint: 'Once the month has ended, close it. Crest locks its figures and opens the next month for you.',
    note: 'This locks the month. Do the month-end count first.',
    skip: false,
    strip: "Once the month has ended, a banner at the top of this page offers to close it — press it and confirm Close & Start Next." },
  { key: 'monthend.payroll', group: 'monthend', phase: 'monthend', tick: 'data', signal: 'payrollFinalized', module: 'hr',
    access: { hr: 'manager' }, route: '/hr/payroll', where: 'HR → Payroll → Payroll',
    label: 'Run your first payroll',
    hint: 'Check the month\'s attendance, then generate the payroll, look it over and finalize it. Payslips go to the Crest Staff app.',
    strip: 'Press Generate Payroll, check each person, then press Finalize.' },
]

export const STEP_BY_KEY = Object.fromEntries(STEPS.map(s => [s.key, s]))

// Who gets a guide lives in its own small file so the eager Layout can read it (setupViewer.js).
export { viewerOf } from './setupViewer'

function rankAtLeast(viewer, module, min) {
  return viewer.module === module && (RANK[viewer.rank] || 0) >= (RANK[min] || 0)
}

export function canSeeStep(step, viewer) {
  if (!viewer) return false
  if (viewer.kind === 'admin' || viewer.kind === 'owner') return true
  const a = step.access || {}
  if (a.owner || a.pos) return false
  if (a.ims) return rankAtLeast(viewer, 'ims', a.ims)
  if (a.hr) return rankAtLeast(viewer, 'hr', a.hr)
  if (a.menuPricing) return rankAtLeast(viewer, 'ims', 'manager')
  if (a.closeMonth) return rankAtLeast(viewer, 'ims', 'supervisor')
  return false
}

/** Every step this viewer could be shown for this client, month-end included (ignoring the window). */
export function stepsForViewer({ viewer, modules, hasFeature }) {
  if (!viewer) return []
  const ctx = { modules }
  return STEPS.filter(s =>
    (!s.module || modules[s.module]) &&
    (!s.feature || hasFeature(s.feature)) &&
    (!s.when || s.when(ctx)) &&
    canSeeStep(s, viewer))
}

/** The signals a set of steps needs read. Only these are ever queried (S750: never read a table the viewer is fenced from). */
export function signalsNeeded(steps) {
  const out = new Set()
  for (const s of steps) if (s.tick === 'data' && s.signal) out.add(s.signal)
  return out
}

/**
 * A step's state for display and for counting.
 *   done     — the thing exists (data), was confirmed by hand (manual), or was opened (visit)
 *   skipped  — "we don't need this"; counts as complete
 *   started  — opened from the guide but nothing saved yet; NOT complete
 *   unknown  — its check could not run; neither done nor to-do, and it blocks "all done"
 *   todo
 * A data step that is done stays done even if it was once skipped.
 */
export function stepStatus(step, { signals, progress }) {
  const p = progress[step.key]
  if (step.tick === 'data') {
    const v = signals[step.signal]
    if (v === true) return 'done'
    if (p === 'skipped') return 'skipped'
    if (v === false) return p === 'opened' ? 'started' : 'todo'
    return 'unknown'
  }
  if (p === 'skipped') return 'skipped'
  if (step.tick === 'manual') return p === 'done' ? 'done' : p === 'opened' ? 'started' : 'todo'
  // visit
  return p === 'opened' || p === 'done' ? 'done' : 'todo'
}

const COMPLETE = new Set(['done', 'skipped'])

/**
 * True from MONTH_END_LEAD_DAYS before the first month ends, until the month is closed. `firstPeriod`
 * is the client's earliest monthly_periods row; `today` is getBsToday(); `daysIn` is daysInBsMonth.
 */
export function monthEndWindow({ firstPeriod, today, daysIn }) {
  if (!firstPeriod || !today) return false
  if (firstPeriod.status === 'closed') return false
  const { bs_year: y, bs_month: m } = firstPeriod
  if (today.year > y || (today.year === y && today.month > m)) return true
  if (today.year === y && today.month === m) return today.day > daysIn(y, m) - MONTH_END_LEAD_DAYS
  return false
}

/**
 * Whether the dashboard should offer the guide at all: a started trial, the first WINDOW_DAYS
 * after approval (trial_approved_at, else created_at — a self-service signup's created_at is the
 * signup day, not the day it started), or a person who asked for it back from Help.
 * `null` when the client row could not be read — the caller shows nothing new rather than guess.
 */
export function eligibleFor({ clientRow, now, reopened }) {
  if (reopened) return true
  if (!clientRow) return null
  if (clientRow.is_trial) return !!clientRow.trial_approved_at
  const anchor = clientRow.trial_approved_at || clientRow.created_at
  if (!anchor) return false
  const days = (now - new Date(anchor)) / 86400000
  return days >= 0 && days <= WINDOW_DAYS
}

/**
 * Build the whole guide. Inputs are plain values so the test can drive every branch.
 *   viewer        viewerOf(...)
 *   modules       { ims, hr, pos } — the client's real subscription (clientModules)
 *   hasFeature    (key) => bool, for the CLIENT's plan (admin's own bypass must not leak in)
 *   signals       { [signal]: true | false | null }  — null/absent = could not check
 *   progress      { [step_key]: state } for this person (admin: the union across the client's logins)
 *   focus         'ims' | 'pos' | 'hr' | null — what they chose to set up first
 *   monthEndOpen  monthEndWindow(...)
 */
export function buildSetupGuide({ viewer, modules, hasFeature, signals = {}, progress = {}, focus = null, monthEndOpen = false }) {
  const all = stepsForViewer({ viewer, modules, hasFeature })
  const withStatus = all.map(s => ({ ...s, status: stepStatus(s, { signals, progress }) }))

  const groups = []
  for (const g of GROUPS) {
    const steps = withStatus.filter(s => s.group === g.key)
    if (!steps.length) continue
    if (g.key === 'monthend' && !monthEndOpen) continue
    const setup = steps.filter(s => s.phase !== 'next')
    const next = steps.filter(s => s.phase === 'next')
    const setupComplete = setup.every(s => COMPLETE.has(s.status))
    const shown = setupComplete ? [...setup, ...next] : setup
    const done = steps.filter(s => COMPLETE.has(s.status)).length
    const complete = done === steps.length
    // The step the card opens by default: the first one still to do. An unknown step is not
    // "to do" (its check failed), so it is never the one the card points at.
    const current = shown.find(s => s.status === 'todo' || s.status === 'started') || null
    groups.push({
      ...g,
      steps: shown.map((s, i) => ({ ...s, number: i + 1 })),
      hiddenNext: setupComplete ? 0 : next.length,
      done, total: steps.length, complete,
      unknown: steps.some(s => s.status === 'unknown'),
      currentKey: current?.key || null,
    })
  }

  const counted = groups.filter(g => g.key !== 'monthend')
  const done = counted.reduce((n, g) => n + g.done, 0)
  const total = counted.reduce((n, g) => n + g.total, 0)
  const anyUnknown = counted.some(g => g.unknown)
  const allDone = total > 0 && done === total && !anyUnknown
  const monthEnd = groups.find(g => g.key === 'monthend') || null
  const monthEndPending = !!monthEnd && !monthEnd.complete

  // Which module part is open. Asked first when more than one module still has steps to do; once
  // the chosen part is finished the next unfinished one opens by itself, without asking again.
  const moduleGroups = groups.filter(g => MODULE_GROUP_KEYS.includes(g.key))
  const open = moduleGroups.filter(g => !g.complete)
  let expandedKey = null
  let needsChoice = false
  if (focus && open.some(g => g.key === focus)) expandedKey = focus
  else if (open.length === 1) expandedKey = open[0].key
  else if (open.length > 1) {
    if (focus) expandedKey = open[0].key          // chosen part finished → next one, no second question
    else needsChoice = true
  }

  return { groups, done, total, anyUnknown, allDone, monthEndPending, expandedKey, needsChoice, moduleGroups }
}

/**
 * What the dashboard renders:
 *   'none'      nothing
 *   'full'      the card
 *   'slim'      one line ("Getting started: 4 of 12 done · Continue")
 *   'celebrate' everything done — a short well-done, then 'finished' is stored when they close it
 * `progressOk` false (their saved choices could not be read) never produces 'full': the card might
 * be one they hid, and popping it back open is worse than a slim line.
 */
export function dashboardMode({ viewer, eligible, cardState, progressOk, guide }) {
  if (!viewer || !guide || guide.total === 0) return 'none'
  const reopened = cardState === 'reopened'
  if (!eligible && !reopened) return 'none'
  if (viewer.kind === 'admin') return 'slim'
  if (!progressOk) return 'slim'
  if (cardState === 'dismissed') return 'none'
  if (cardState === 'finished') return guide.monthEndPending ? 'slim' : 'none'
  if (cardState === 'hidden') return 'slim'
  if (guide.allDone && !guide.monthEndPending) return 'celebrate'
  return 'full'
}
