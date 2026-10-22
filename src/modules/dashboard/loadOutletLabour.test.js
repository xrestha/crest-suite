import { loadOutletLabour, loadLabourEstimateInputs, loadLabourMasters, loadGroupLabourInputs, groupRowInputs } from './loadOutletLabour'
import { resolveOutletLabour } from './labourSource'
import { estimateLabour } from './labourEstimate'

const KARTIK = { id: 'p7', bs_year: 2083, bs_month: 7 }

// A builder that records every filter, answers `.range()` (fetchAllRows) and a bare await alike.
function mockFrom(tables, { fail = {}, calls = [] } = {}) {
  return (table, columns) => {
    const call = { table, columns, filters: [], ordered: [], ranged: false }
    calls.push(call)
    const answer = () => (fail[table] ? { data: null, error: { message: `${table} failed`, code: 'XX000' } } : { data: tables[table] || [], error: null })
    const b = {
      eq: (c, v) => { call.filters.push(['eq', c, v]); return b },
      lte: (c, v) => { call.filters.push(['lte', c, v]); return b },
      in: (c, v) => { call.filters.push(['in', c, v]); return b },
      order: c => { call.ordered.push(c); return b },
      range: () => { call.ranged = true; return Promise.resolve(answer()) },
      then: (res, rej) => Promise.resolve(answer()).then(res, rej),
    }
    return b
  }
}

const staff = [{ id: 'e1', full_name: 'Ram', status: 'active', basic_salary: 30000, pay_basis: 'monthly', ssf_enrolled: false, ssf_no: null, join_date: '2020-01-01', end_date: null }]

describe('loadLabourEstimateInputs', () => {
  test('five reads, every one paged with a unique tiebreaker (OWNER-DASHBOARD-14)', async () => {
    const calls = []
    const { inputs, error } = await loadLabourEstimateInputs(mockFrom({ hr_employees: staff }, { calls }), KARTIK)
    expect(error).toBeNull()
    expect(inputs.employees).toEqual(staff)
    expect(calls.map(c => c.table).sort()).toEqual(['hr_attendance', 'hr_employees', 'hr_final_settlements', 'hr_overtime_entries', 'hr_salary_components'])
    for (const c of calls) {
      expect(c.ranged).toBe(true)
      expect(c.ordered).toContain('id')
    }
    const ot = calls.find(c => c.table === 'hr_overtime_entries')
    expect(ot.filters).toEqual(expect.arrayContaining([['eq', 'status', 'approved'], ['eq', 'bs_year', 2083], ['eq', 'bs_month', 7]]))
    expect(calls.find(c => c.table === 'hr_attendance').filters).toContainEqual(['eq', 'period_id', 'p7'])
    expect(calls.find(c => c.table === 'hr_final_settlements').filters).toContainEqual(['eq', 'status', 'finalized'])
  })
  test('one failed read fails the inputs', async () => {
    const r = await loadLabourEstimateInputs(mockFrom({}, { fail: { hr_attendance: true } }), KARTIK)
    expect(r.inputs).toBeNull()
    expect(r.error.message).toMatch(/hr_attendance/)
  })
})

describe('loadOutletLabour', () => {
  test('no finalized run → the estimate', async () => {
    const { labour, parts, error } = await loadOutletLabour(mockFrom({ hr_employees: staff }), { period: KARTIK, hrOn: true, labourBucket: 250000 })
    expect(error).toBeNull()
    expect(labour).toMatchObject({ source: 'estimate', ignoredBucket: 250000 })
    expect(labour.amount).toBeCloseTo(30000, 6)
    expect(parts.payroll).toBeNull()
  })

  // S859: the payslips ride on the run read, so a finalized month costs no second round trip.
  test('a finalized run → payroll from the payslips embedded in its read, with no payslip read after it', async () => {
    const calls = []
    const tables = {
      hr_employees: staff,
      hr_payroll_runs: [{ id: 'run1', hr_payslips: [{ gross: '30000', absence_deduction: '0', ot_amount: '500', ssf_employer: '0' }] }],
    }
    const { labour } = await loadOutletLabour(mockFrom(tables, { calls }), { period: KARTIK, hrOn: true })
    expect(labour).toMatchObject({ source: 'payroll', amount: 30500 })
    expect(calls.map(c => c.table)).not.toContain('hr_payslips')
    const runs = calls.find(c => c.table === 'hr_payroll_runs')
    expect(runs.columns).toBe('id, hr_payslips(gross, absence_deduction, ot_amount, ssf_employer)')
    expect(runs.filters).toEqual(expect.arrayContaining([['eq', 'period_id', 'p7'], ['eq', 'status', 'finalized']]))
    // The run, then its payslips, each on the unique id: the order the paged payslip read summed in.
    expect(runs.ordered).toEqual(['id', 'id'])
  })

  test('a finalized run with no payslips is a payroll of 0, never "no run"; a failed other-pay read keeps no figure', async () => {
    const empty = await loadOutletLabour(mockFrom({ hr_employees: staff, hr_payroll_runs: [{ id: 'run1', hr_payslips: [] }] }), { period: KARTIK, hrOn: true })
    expect(empty.parts.payroll).toBe(0)
    const tables = { hr_payroll_runs: [{ id: 'run1', hr_payslips: [{ gross: 1000, absence_deduction: 0, ot_amount: 0, ssf_employer: 0 }] }] }
    const failed = await loadOutletLabour(mockFrom(tables, { fail: { hr_incentives: true } }), { period: KARTIK, hrOn: true })
    expect(failed.parts.payroll).toBeNull()
    expect(failed.parts.payrollReadFailed).toBe(true)
  })

  test('one failed read → failed, no figure, the error kept for the banner', async () => {
    for (const table of ['hr_payroll_runs', 'hr_festival_allowances', 'hr_employees']) {
      const { labour, error } = await loadOutletLabour(mockFrom({ hr_employees: staff }, { fail: { [table]: true } }), { period: KARTIK, hrOn: true })
      expect(labour).toMatchObject({ source: 'failed', amount: null, verdictWithheld: true })
      expect(error.message).toMatch(table)
    }
  })

  test('a failed estimate read beside a finalized run is not a failure', async () => {
    const tables = { hr_payroll_runs: [{ id: 'run1', hr_payslips: [{ gross: 1000, absence_deduction: 0, ot_amount: 0, ssf_employer: 0 }] }] }
    const { labour, error } = await loadOutletLabour(mockFrom(tables, { fail: { hr_attendance: true } }), { period: KARTIK, hrOn: true })
    expect(labour.source).toBe('payroll')
    expect(error).toBeNull()
  })

  test('fenced or no HR: no HR read at all', async () => {
    const calls = []
    const fenced = await loadOutletLabour(mockFrom({}, { calls }), { period: KARTIK, hrOn: true, fenced: true, labourBucket: 9 })
    expect(fenced.labour).toMatchObject({ source: 'unreadable', amount: null })
    const noHr = await loadOutletLabour(mockFrom({}, { calls }), { period: KARTIK, hrOn: false, labourBucket: 90000, scale: 0.5 })
    expect(noHr.labour).toMatchObject({ source: 'overheads', amount: 45000 })
    expect(calls).toEqual([])
  })

  test('parts round-trip: re-resolving with a live Labor tab gives the same figure and names the new tab', async () => {
    const { labour, parts } = await loadOutletLabour(mockFrom({ hr_employees: staff }), { period: KARTIK, hrOn: true, labourBucket: 0 })
    const live = resolveOutletLabour({ ...parts, labourBucket: 120000 })
    expect(live.amount).toBe(labour.amount)
    expect(live.ignoredBucket).toBe(120000)
  })

  test('the estimate accrues to throughDay', async () => {
    const { labour } = await loadOutletLabour(mockFrom({ hr_employees: staff }), { period: KARTIK, hrOn: true, throughDay: 11 })
    expect(labour.amount).toBeCloseTo(11000, 6)
  })
})

// S853 (OWNER-DASHBOARD-9): the Owner Dashboard starts the staff reads beside its month read and hands
// them in. Every other caller passes nothing and reads them inside, as before.
describe('the staff reads, started early (masters)', () => {
  test('loadLabourMasters: both reads, paged with a unique tiebreaker; a failure is an answer, not a throw', async () => {
    const calls = []
    const m = await loadLabourMasters(mockFrom({ hr_employees: staff }, { calls }))
    expect(m).toEqual({ employees: staff, components: [], error: null })
    expect(calls.map(c => c.table)).toEqual(['hr_employees', 'hr_salary_components'])
    for (const c of calls) { expect(c.ranged).toBe(true); expect(c.ordered).toContain('id') }
    expect(calls[1].filters).toContainEqual(['eq', 'type', 'earning'])
    const failed = await loadLabourMasters(mockFrom({}, { fail: { hr_salary_components: true } }))
    expect(failed).toMatchObject({ employees: null, components: null, error: { message: 'hr_salary_components failed' } })
    const thrown = await loadLabourMasters(() => { throw new Error('no outlet') })
    expect(thrown.error.message).toBe('no outlet')
  })

  test('handed in, they are not read again, and the figure is the same', async () => {
    const calls = []
    const from = mockFrom({ hr_employees: staff }, { calls })
    const masters = loadLabourMasters(from)
    const before = calls.length
    const withMasters = await loadOutletLabour(from, { period: KARTIK, hrOn: true, throughDay: 11, masters })
    const tables = calls.slice(before).map(c => c.table)
    expect(tables).not.toContain('hr_employees')
    expect(tables).not.toContain('hr_salary_components')
    expect(tables).toEqual(expect.arrayContaining(['hr_payroll_runs', 'hr_overtime_entries', 'hr_attendance', 'hr_final_settlements']))
    const without = await loadOutletLabour(mockFrom({ hr_employees: staff }), { period: KARTIK, hrOn: true, throughDay: 11 })
    expect(withMasters.labour).toEqual(without.labour)
    expect(withMasters.labour.amount).toBeCloseTo(11000, 6)
  })

  test('a failed staff read handed in fails the estimate exactly as a failed read inside does', async () => {
    const masters = Promise.resolve({ employees: null, components: null, error: { message: 'hr_employees failed', code: 'XX000' } })
    const handed = await loadOutletLabour(mockFrom({}), { period: KARTIK, hrOn: true, masters })
    const inside = await loadOutletLabour(mockFrom({}, { fail: { hr_employees: true } }), { period: KARTIK, hrOn: true })
    expect(handed.labour).toEqual(inside.labour)
    expect(handed.labour.source).toBe('failed')
    expect(handed.error).toEqual(inside.error)
    // Beside a finalized run the estimate is not needed, so its failure is not one.
    const tables = { hr_payroll_runs: [{ id: 'run1', hr_payslips: [{ gross: 1000, absence_deduction: 0, ot_amount: 0, ssf_employer: 0 }] }] }
    const run = await loadOutletLabour(mockFrom(tables), { period: KARTIK, hrOn: true, masters })
    expect(run.labour.source).toBe('payroll')
  })

  test('loadLabourEstimateInputs with masters reads only the three month reads', async () => {
    const calls = []
    const masters = { employees: staff, components: [], error: null }
    const { inputs, error } = await loadLabourEstimateInputs(mockFrom({}, { calls }), KARTIK, { masters })
    expect(error).toBeNull()
    expect(inputs.employees).toEqual(staff)
    expect(calls.map(c => c.table).sort()).toEqual(['hr_attendance', 'hr_final_settlements', 'hr_overtime_entries'])
  })
})

describe('loadGroupLabourInputs', () => {
  test('calls the RPC with the month and the group, and maps each row', async () => {
    const seen = []
    const rpc = (name, args) => { seen.push([name, args]); return Promise.resolve({ data: [
      { client_id: 'c1', is_included: true, hr_enabled: true, period_id: 'p', period_status: 'open', has_finalized_run: false,
        employees: [{ id: 'e1', status: 'active', basic_salary: 30000, pay_basis: 'monthly', ssf_contributor: true, join_date: '2020-01-01', end_date: null }],
        components: [], ot_entries: [], attendance: [], settlements: [] },
      { client_id: 'c2', is_included: true, hr_enabled: true, period_id: 'q', period_status: 'open', has_finalized_run: true,
        employees: null, components: null, ot_entries: null, attendance: null, settlements: null },
    ], error: null }) }
    const { byClient, error } = await loadGroupLabourInputs(rpc, { bsYear: 2083, bsMonth: 7 })
    expect(error).toBeNull()
    expect(seen).toEqual([['get_group_labour_inputs', { p_bs_year: 2083, p_bs_month: 7, p_group_id: null }]])
    const c1 = byClient.get('c1')
    expect(c1).toMatchObject({ included: true, hrEnabled: true, hasFinalizedRun: false })
    expect(c1.inputs.employees[0]).toMatchObject({ ssf_enrolled: true, ssf_no: 'on file' })
    expect(byClient.get('c2').inputs).toBeNull()
    // The mapped rows run the estimate unchanged, SSF included.
    const e = estimateLabour({ ...c1.inputs, period: KARTIK })
    expect(e.ssfEmployer).toBeGreaterThan(0)
  })
  test('the support view passes the group id; a failed RPC returns its error', async () => {
    const seen = []
    const rpc = (name, args) => { seen.push(args); return Promise.resolve({ data: null, error: { code: '42501', message: 'Not permitted' } }) }
    const r = await loadGroupLabourInputs(rpc, { bsYear: 2083, bsMonth: 7, groupId: 'g1' })
    expect(seen[0].p_group_id).toBe('g1')
    expect(r).toEqual({ byClient: null, error: { code: '42501', message: 'Not permitted' } })
  })
  test('groupRowInputs: a row with no arrays ships nothing', () => {
    expect(groupRowInputs({ employees: null })).toBeNull()
    expect(groupRowInputs(null)).toBeNull()
  })
})
