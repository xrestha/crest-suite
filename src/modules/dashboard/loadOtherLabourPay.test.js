import { loadOtherLabourPay, otherLabourFor, loadMonthOtherLabour } from './loadOtherLabourPay'

// A fake client-scoped builder: records the filters each read asked for and hands back that table's
// rows (or an error) when fetchAllRows calls .range().
function fakeFrom(tables, calls = []) {
  return (table, columns) => {
    const q = { table, columns, filters: [] }
    calls.push(q)
    const b = {
      eq: (c, v) => { q.filters.push(['eq', c, v]); return b },
      in: (c, v) => { q.filters.push(['in', c, v]); return b },
      order: (c) => { q.filters.push(['order', c]); return b },
      range: (from, to) => {
        const t = tables[table]
        if (t?.error) return Promise.resolve({ data: null, error: t.error })
        return Promise.resolve({ data: (t || []).slice(from, to + 1), error: null })
      },
    }
    return b
  }
}

describe('loadOtherLabourPay (S798 3c)', () => {
  const tables = {
    hr_festival_allowances: [
      { id: 'f1', bs_year: 2083, bs_month: 6, festival_name: 'Dashain', amount: '17300' },
      { id: 'f2', bs_year: 2083, bs_month: 6, festival_name: 'Dashain', amount: '17300' },
      // Baisakh 2082 is inside the crossed year × month lists but was not asked for.
      { id: 'f3', bs_year: 2082, bs_month: 1, festival_name: 'New Year', amount: '999' },
    ],
    hr_incentives: [{ id: 'i1', bs_year: 2082, bs_month: 12, amount: '5000' }],
    hr_final_settlements: [
      { id: 's1', settle_bs_year: 2083, settle_bs_month: 1, partial_salary: '10000', month_ssf_employer: '2000', leave_encashment: 0, festival_pro: 0, notice_pay: 0, gratuity: '3000', notice_deduction: 0 },
    ],
  }

  test('finalized rows only, paged with a tiebreaker, grouped by their own month', async () => {
    const calls = []
    const months = [{ bsYear: 2082, bsMonth: 12 }, { bsYear: 2083, bsMonth: 1 }, { bsYear: 2083, bsMonth: 6 }]
    const { byKey, error } = await loadOtherLabourPay(fakeFrom(tables, calls), months)
    expect(error).toBeNull()
    for (const q of calls) {
      expect(q.filters).toContainEqual(['eq', 'status', 'finalized'])
      expect(q.filters).toContainEqual(['order', 'id'])
    }
    expect(calls.find(q => q.table === 'hr_final_settlements').filters).toContainEqual(['in', 'settle_bs_year', [2082, 2083]])
    expect(otherLabourFor(byKey, 2083, 6)).toMatchObject({ festival: 34600, festivalName: 'Dashain', total: 34600 })
    expect(otherLabourFor(byKey, 2082, 12)).toMatchObject({ incentive: 5000, total: 5000 })
    expect(otherLabourFor(byKey, 2083, 1)).toMatchObject({ settlement: 15000, settlementCount: 1, total: 15000 })
    // Asked-for months only: Baisakh 2082's row is dropped, and an unasked month reads as nothing.
    expect(byKey.has(208201)).toBe(false)
    expect(otherLabourFor(byKey, 2082, 1).total).toBe(0)
  })

  test('a failed read is an error and no totals — never "nothing paid"', async () => {
    const err = { code: '42501', message: 'denied' }
    const r = await loadOtherLabourPay(fakeFrom({ ...tables, hr_incentives: { error: err } }), [{ bsYear: 2083, bsMonth: 6 }])
    expect(r).toEqual({ byKey: null, error: err })
    const one = await loadMonthOtherLabour(fakeFrom({ ...tables, hr_final_settlements: { error: err } }), 2083, 6)
    expect(one).toEqual({ other: null, error: err })
  })

  test('the one-month form, and no months at all', async () => {
    const { other, error } = await loadMonthOtherLabour(fakeFrom(tables), 2083, 6)
    expect(error).toBeNull()
    expect(other.total).toBe(34600)
    const calls = []
    expect((await loadOtherLabourPay(fakeFrom(tables, calls), [])).byKey.size).toBe(0)
    expect(calls).toHaveLength(0)
  })
})
