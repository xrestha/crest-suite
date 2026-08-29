import { groupByEmployee, sliceFor } from './payrollData'

// `buildRows` in PayrollRun.jsx and `rows` in PayrollCalculation.jsx replaced a per-employee
// `rows.filter(r => r.employee_id === emp.id)` with one pass through groupByEmployee. Both feed
// computePayslip on a path that WRITES payslips, so the slices have to be exactly what the filter
// produced — same members, same order — not merely the same set.
describe('groupByEmployee', () => {
  const rows = [
    { id: 1, employee_id: 'b', bs_day: 3 },
    { id: 2, employee_id: 'a', bs_day: 1 },
    { id: 3, employee_id: 'b', bs_day: 1 },
    { id: 4, employee_id: 'a', bs_day: 2 },
    { id: 5, employee_id: 'c', bs_day: 9 },
  ]

  it('produces the same slice a .filter() would, in the same order', () => {
    const index = groupByEmployee(rows)
    for (const id of ['a', 'b', 'c']) {
      expect(sliceFor(index, id)).toEqual(rows.filter(r => r.employee_id === id))
    }
  })

  it('returns an empty slice for an employee with no rows', () => {
    // A mid-month joiner with no attendance yet is ordinary, not an edge case — computePayslip
    // must receive [], never undefined.
    expect(sliceFor(groupByEmployee(rows), 'nobody')).toEqual([])
  })

  it('tolerates a null/undefined result set', () => {
    expect(sliceFor(groupByEmployee(null), 'a')).toEqual([])
    expect(sliceFor(groupByEmployee(undefined), 'a')).toEqual([])
  })

  it('keeps rows whose key is null in their own bucket rather than dropping them', () => {
    // A dropped row would silently remove someone's attendance from a payslip.
    const withNull = [...rows, { id: 6, employee_id: null }]
    const index = groupByEmployee(withNull)
    expect(sliceFor(index, null)).toEqual([{ id: 6, employee_id: null }])
    expect([...index.values()].flat()).toHaveLength(withNull.length)
  })

  it('accepts a different key column', () => {
    expect(sliceFor(groupByEmployee(rows, 'bs_day'), 1)).toEqual(rows.filter(r => r.bs_day === 1))
  })
})
