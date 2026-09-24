import {
  STEPS, STEP_BY_KEY, viewerOf, canSeeStep, stepsForViewer, signalsNeeded, stepStatus,
  monthEndWindow, eligibleFor, buildSetupGuide, dashboardMode, WINDOW_DAYS,
} from './setupSteps'

const ALL = { ims: true, hr: true, pos: true }
const growth = key => key !== 'nothing'
const starter = key => key !== 'recipe_costing'
const owner = { kind: 'owner' }
const admin = { kind: 'admin' }
const keysOf = steps => steps.map(s => s.key)

// Every data step reads true.
function allSignals() {
  const out = {}
  for (const s of STEPS) if (s.signal) out[s.signal] = true
  return out
}

describe('step catalogue', () => {
  test('keys are unique and fit the database CHECK', () => {
    const keys = STEPS.map(s => s.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const k of keys) expect(k).toMatch(/^[a-z0-9][a-z0-9_.:-]{0,63}$/)
  })
  test('every data step names a signal, every manual step a done label', () => {
    for (const s of STEPS) {
      if (s.tick === 'data') expect(s.signal).toBeTruthy()
      if (s.tick === 'manual') expect(s.doneLabel).toBeTruthy()
    }
  })
  test('a step that opens a page says what to press there', () => {
    for (const s of STEPS) if (s.route) expect(s.strip).toBeTruthy()
  })
  test('no step promises "change it later" where that is untrue', () => {
    for (const k of ['pos.firstbill', 'monthend.close']) {
      expect(STEP_BY_KEY[k].note).not.toMatch(/change or delete/i)
    }
  })
})

describe('viewerOf', () => {
  const base = { role: 'client' }
  test('owner and admin', () => {
    expect(viewerOf({ isAdmin: true })).toEqual({ kind: 'admin' })
    expect(viewerOf({ isOwner: true, profile: base })).toEqual({ kind: 'owner' })
  })
  test('an email manager or supervisor in ONE module', () => {
    expect(viewerOf({ profile: { ...base, ims_role: 'supervisor' } })).toEqual({ kind: 'manager', module: 'ims', rank: 'supervisor' })
    expect(viewerOf({ profile: { ...base, hr_role: 'manager' } })).toEqual({ kind: 'manager', module: 'hr', rank: 'manager' })
  })
  test('staff rank, PIN logins, self-service and two-module logins get no guide', () => {
    expect(viewerOf({ profile: { ...base, ims_role: 'staff' } })).toBeNull()
    expect(viewerOf({ profile: { ...base, pos_role: 'manager', pos_email: 'x' } })).toBeNull()
    expect(viewerOf({ profile: { ...base, ims_role: 'staff', ims_email: 'x' } })).toBeNull()
    expect(viewerOf({ profile: { ...base, hr_self_service: true } })).toBeNull()
    expect(viewerOf({ profile: { ...base, ims_role: 'manager', hr_role: 'manager' } })).toBeNull()
  })
})

describe('who sees which step', () => {
  test('owner sees every module step, and Start here', () => {
    const keys = keysOf(stepsForViewer({ viewer: owner, modules: ALL, hasFeature: growth }))
    expect(keys).toContain('start.call')
    expect(keys).toContain('pos.firstbill')
    expect(keys).toContain('hr.pay')
  })
  test('an IMS supervisor sees only the IMS pages it can open', () => {
    const v = { kind: 'manager', module: 'ims', rank: 'supervisor' }
    const keys = keysOf(stepsForViewer({ viewer: v, modules: { ims: true, hr: true, pos: false }, hasFeature: growth }))
    expect(keys).toEqual(expect.arrayContaining(['ims.items', 'ims.vendors', 'ims.opening', 'ims.purchase', 'ims.recipes', 'ims.sales', 'monthend.count', 'monthend.close']))
    expect(keys).not.toContain('start.call')
    expect(keys).not.toContain('hr.employees')
    expect(keys).not.toContain('ims.menu') // Menu Pricing needs IMS manager
  })
  test('an HR supervisor gets holidays and attendance, not employees or pay', () => {
    const v = { kind: 'manager', module: 'hr', rank: 'supervisor' }
    const keys = keysOf(stepsForViewer({ viewer: v, modules: ALL, hasFeature: growth }))
    expect(keys.sort()).toEqual(['hr.attendance', 'hr.holidays'])
  })
  test('no POS step is shown to a manager — POS managers sign in with a PIN', () => {
    const v = { kind: 'manager', module: 'ims', rank: 'supervisor' }
    for (const s of STEPS.filter(s => s.access?.pos)) expect(canSeeStep(s, v)).toBe(false)
  })
})

describe('module and plan filtering', () => {
  test('POS-only client: Start here + Till & bills, and no month-end stock or payroll', () => {
    const keys = keysOf(stepsForViewer({ viewer: owner, modules: { ims: false, hr: false, pos: true }, hasFeature: growth }))
    expect(keys.every(k => k.startsWith('start.') || k.startsWith('pos.') || k === 'monthend.close')).toBe(true)
    expect(keys).toContain('pos.menu')
  })
  test('HR-only client: Start here + Staff & payroll + payroll month-end', () => {
    const keys = keysOf(stepsForViewer({ viewer: owner, modules: { ims: false, hr: true, pos: false }, hasFeature: growth }))
    expect(keys.every(k => k.startsWith('start.') || k.startsWith('hr.') || k.startsWith('monthend.'))).toBe(true)
    expect(keys).toContain('monthend.payroll')
    expect(keys).not.toContain('monthend.count')
  })
  test('IMS + POS drops Sales entry (the till posts sales) and the IMS copy of Menu Pricing', () => {
    const keys = keysOf(stepsForViewer({ viewer: owner, modules: { ims: true, hr: false, pos: true }, hasFeature: growth }))
    expect(keys).not.toContain('ims.sales')
    expect(keys).not.toContain('ims.menu')
    expect(keys).toContain('pos.menu')
  })
  test('an IMS manager on a client with POS gets the menu step under Stock & costing, not a Till & bills part', () => {
    const v = { kind: 'manager', module: 'ims', rank: 'manager' }
    const modules = { ims: true, hr: false, pos: true }
    const keys = keysOf(stepsForViewer({ viewer: v, modules, hasFeature: growth }))
    expect(keys).toContain('ims.menu')
    expect(keys).not.toContain('pos.menu')
    const g = buildSetupGuide({ viewer: v, modules, hasFeature: growth, signals: {} })
    expect(g.groups.find(x => x.key === 'pos')).toBeUndefined()
    const menu = stepsForViewer({ viewer: v, modules, hasFeature: growth }).find(s => s.key === 'ims.menu')
    expect(menu.hint).toMatch(/On POS/) // the POS wording, since the till reads this menu
  })
  test('closing the month names no Periods menu item for a client without IMS', () => {
    const noIms = stepsForViewer({ viewer: owner, modules: { ims: false, hr: true, pos: false }, hasFeature: growth })
      .find(s => s.key === 'monthend.close')
    expect(noIms.where).not.toBe('Periods')
    expect(noIms.note).not.toMatch(/count/i)
    const withIms = stepsForViewer({ viewer: owner, modules: ALL, hasFeature: growth }).find(s => s.key === 'monthend.close')
    expect(withIms.where).toBe('Periods')
  })
  test('Starter never sends anyone to a Growth page', () => {
    const keys = keysOf(stepsForViewer({ viewer: owner, modules: ALL, hasFeature: starter }))
    expect(keys).not.toContain('ims.recipes')
  })
  test('signals are only read for steps the viewer is shown', () => {
    const v = { kind: 'manager', module: 'hr', rank: 'supervisor' }
    const needed = signalsNeeded(stepsForViewer({ viewer: v, modules: ALL, hasFeature: growth }))
    expect([...needed].sort()).toEqual(['attendance', 'holidays'])
  })
})

describe('stepStatus', () => {
  const items = STEP_BY_KEY['ims.items']
  const call = STEP_BY_KEY['start.call']
  const report = STEP_BY_KEY['pos.salesreport']
  test('opening a page is "started", never done', () => {
    expect(stepStatus(items, { signals: { items: false }, progress: { 'ims.items': 'opened' } })).toBe('started')
  })
  test('a failed check is unknown, not to-do and not done', () => {
    expect(stepStatus(items, { signals: {}, progress: {} })).toBe('unknown')
    expect(stepStatus(items, { signals: { items: null }, progress: {} })).toBe('unknown')
  })
  test('real data wins over a skip', () => {
    expect(stepStatus(items, { signals: { items: true }, progress: { 'ims.items': 'skipped' } })).toBe('done')
    expect(stepStatus(items, { signals: { items: false }, progress: { 'ims.items': 'skipped' } })).toBe('skipped')
  })
  test('manual and visit steps', () => {
    expect(stepStatus(call, { signals: {}, progress: {} })).toBe('todo')
    expect(stepStatus(call, { signals: {}, progress: { 'start.call': 'done' } })).toBe('done')
    expect(stepStatus(report, { signals: {}, progress: { 'pos.salesreport': 'opened' } })).toBe('done')
  })
})

describe('monthEndWindow', () => {
  // Shrawan 2083 has 31 days? Use a stub so the test does not depend on the calendar table.
  const daysIn = (y, m) => (m === 4 ? 32 : 30)
  const first = { bs_year: 2083, bs_month: 4, status: 'open' }
  test('opens MONTH_END_LEAD_DAYS before the end of a 32-day month, not a 30-day one', () => {
    expect(monthEndWindow({ firstPeriod: first, today: { year: 2083, month: 4, day: 27 }, daysIn })).toBe(false)
    expect(monthEndWindow({ firstPeriod: first, today: { year: 2083, month: 4, day: 28 }, daysIn })).toBe(true)
  })
  test('stays open after the month ends until it is closed', () => {
    expect(monthEndWindow({ firstPeriod: first, today: { year: 2083, month: 5, day: 3 }, daysIn })).toBe(true)
    expect(monthEndWindow({ firstPeriod: { ...first, status: 'closed' }, today: { year: 2083, month: 5, day: 3 }, daysIn })).toBe(false)
  })
  test('no period, no window', () => {
    expect(monthEndWindow({ firstPeriod: null, today: { year: 2083, month: 5, day: 3 }, daysIn })).toBe(false)
  })
})

describe('eligibleFor', () => {
  const now = new Date('2026-09-24T06:00:00Z')
  const daysAgo = n => new Date(now - n * 86400000).toISOString()
  test('a client in its first WINDOW_DAYS after approval', () => {
    expect(eligibleFor({ clientRow: { created_at: daysAgo(400), trial_approved_at: daysAgo(10) }, now })).toBe(true)
    expect(eligibleFor({ clientRow: { created_at: daysAgo(WINDOW_DAYS + 1) }, now })).toBe(false)
  })
  test('the anchor is the approval day, not the signup day', () => {
    expect(eligibleFor({ clientRow: { created_at: daysAgo(90), trial_approved_at: daysAgo(5) }, now })).toBe(true)
  })
  test('a started trial is always eligible; a pending one is not', () => {
    expect(eligibleFor({ clientRow: { is_trial: true, trial_approved_at: daysAgo(3), created_at: daysAgo(3) }, now })).toBe(true)
    expect(eligibleFor({ clientRow: { is_trial: true, trial_approved_at: null, created_at: daysAgo(1) }, now })).toBe(false)
  })
  test('reopened from Help overrides the window; an unreadable row is null, not false', () => {
    expect(eligibleFor({ clientRow: { created_at: daysAgo(999) }, now, reopened: true })).toBe(true)
    expect(eligibleFor({ clientRow: null, now })).toBeNull()
  })
})

describe('buildSetupGuide', () => {
  test('a three-module trial asks what to set up first, then opens only that part', () => {
    const g = buildSetupGuide({ viewer: owner, modules: ALL, hasFeature: growth, signals: { periodsAny: true } })
    expect(g.needsChoice).toBe(true)
    expect(g.expandedKey).toBeNull()
    const chosen = buildSetupGuide({ viewer: owner, modules: ALL, hasFeature: growth, signals: { periodsAny: true }, focus: 'pos' })
    expect(chosen.needsChoice).toBe(false)
    expect(chosen.expandedKey).toBe('pos')
  })
  test('once the chosen part is finished the next one opens without asking again', () => {
    const signals = { ...allSignals(), items: false, employees: false }
    const progress = { 'pos.bill': 'done', 'pos.salesreport': 'opened' }
    const g = buildSetupGuide({ viewer: owner, modules: ALL, hasFeature: growth, signals, progress, focus: 'pos' })
    expect(g.groups.find(x => x.key === 'pos').complete).toBe(true)
    expect(g.needsChoice).toBe(false)
    expect(g.expandedKey).toBe('ims')
  })
  test('a single-module client is never asked', () => {
    const g = buildSetupGuide({ viewer: owner, modules: { ims: false, hr: false, pos: true }, hasFeature: growth, signals: {} })
    expect(g.needsChoice).toBe(false)
    expect(g.expandedKey).toBe('pos')
  })
  test('"Next" steps appear only after the set-up-once steps are done or skipped, but count from the start', () => {
    const modules = { ims: true, hr: false, pos: false }
    const before = buildSetupGuide({ viewer: owner, modules, hasFeature: growth, signals: { items: false } })
    const ims = before.groups.find(x => x.key === 'ims')
    expect(ims.steps.map(s => s.key)).not.toContain('ims.recipes')
    const totalBefore = ims.total
    const after = buildSetupGuide({ viewer: owner, modules, hasFeature: growth,
      signals: { items: true, vendors: true, openingStock: false, purchase: true }, progress: { 'ims.opening': 'skipped' } })
    const ims2 = after.groups.find(x => x.key === 'ims')
    expect(ims2.steps.map(s => s.key)).toContain('ims.recipes')
    expect(ims2.total).toBe(totalBefore) // the count never goes backwards when "Next" opens
  })
  test('skipped counts as complete; an unknown step blocks "all done"', () => {
    const modules = { ims: false, hr: false, pos: true }
    const signals = allSignals()
    const progress = { 'start.call': 'skipped', 'pos.bill': 'done', 'pos.salesreport': 'opened' }
    expect(buildSetupGuide({ viewer: owner, modules, hasFeature: growth, signals, progress }).allDone).toBe(true)
    const withUnknown = { ...signals, tables: null }
    const g = buildSetupGuide({ viewer: owner, modules, hasFeature: growth, signals: withUnknown, progress })
    expect(g.allDone).toBe(false)
    expect(g.anyUnknown).toBe(true)
  })
  test('month-end steps show only inside the window and are not counted in the main total', () => {
    const modules = { ims: false, hr: true, pos: false }
    const out = buildSetupGuide({ viewer: owner, modules, hasFeature: growth, signals: {} })
    expect(out.groups.find(x => x.key === 'monthend')).toBeUndefined()
    const inWin = buildSetupGuide({ viewer: owner, modules, hasFeature: growth, signals: {}, monthEndOpen: true })
    expect(inWin.groups.find(x => x.key === 'monthend')).toBeDefined()
    expect(inWin.total).toBe(out.total)
  })
})

describe('dashboardMode', () => {
  const guide = { total: 5, allDone: false, monthEndPending: false }
  const base = { viewer: owner, eligible: true, cardState: null, progressOk: true, guide }
  test('nothing for a viewer with no guide, or outside the window', () => {
    expect(dashboardMode({ ...base, viewer: null })).toBe('none')
    expect(dashboardMode({ ...base, eligible: false })).toBe('none')
    expect(dashboardMode({ ...base, eligible: null })).toBe('none')
  })
  test('reopened from Help shows it outside the window', () => {
    expect(dashboardMode({ ...base, eligible: false, cardState: 'reopened' })).toBe('full')
  })
  test('hidden is one line, dismissed and finished are gone', () => {
    expect(dashboardMode({ ...base, cardState: 'hidden' })).toBe('slim')
    expect(dashboardMode({ ...base, cardState: 'dismissed' })).toBe('none')
    expect(dashboardMode({ ...base, cardState: 'finished' })).toBe('none')
  })
  test('finished comes back as one line for the first month-end', () => {
    expect(dashboardMode({ ...base, cardState: 'finished', guide: { ...guide, monthEndPending: true } })).toBe('slim')
  })
  test('an unreadable progress row never pops the full card back open', () => {
    expect(dashboardMode({ ...base, progressOk: false })).toBe('slim')
  })
  test('all done celebrates; an unknown step does not', () => {
    expect(dashboardMode({ ...base, guide: { ...guide, allDone: true } })).toBe('celebrate')
  })
  test('Crest admin gets the one-line, read-only view', () => {
    expect(dashboardMode({ ...base, viewer: admin })).toBe('slim')
  })
})
