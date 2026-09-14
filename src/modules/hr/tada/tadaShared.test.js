import { tadaLineAmount, tadaItemsTotal, acceptTadaAmount, tadaDatesError, findLookAlikeClaim, recomputeTadaAmount } from './tadaShared'

describe('TADA form arithmetic (S751)', () => {
  it('counts only positive, finite lines — the total shown is the total saved', () => {
    expect(tadaItemsTotal([{ amount: '500' }, { amount: '-200' }, { amount: '' }, { amount: 'NaN' }, { amount: '120.5' }])).toBe(620.5)
    expect(tadaLineAmount({ amount: '0' })).toBe(0)
  })

  it('refuses a negative or unreadable amount as typed, accepts blank and zero', () => {
    expect(acceptTadaAmount('')).toBe(true)
    expect(acceptTadaAmount('0')).toBe(true)
    expect(acceptTadaAmount('12.5')).toBe(true)
    expect(acceptTadaAmount('-1')).toBe(false)
    expect(acceptTadaAmount('abc')).toBe(false)
  })

  it('refuses a trip that ends before it starts', () => {
    expect(tadaDatesError('2026-09-10', '2026-09-09')).toMatch(/ends before it starts/)
    expect(tadaDatesError('2026-09-10', '2026-09-10')).toBe('')
    expect(tadaDatesError('', '2026-09-10')).toMatch(/Set the trip dates/)
  })

  it('never auto-fills from a negative rate', () => {
    expect(recomputeTadaAmount({ amount: '40' }, '10', '2w', { '2w': -5 })).toBe('40')
    expect(recomputeTadaAmount({ amount: '' }, '10', '2w', { '2w': 5 })).toBe('50')
  })

  it('flags a look-alike claim, but not a rejected one or a different total', () => {
    const claims = [
      { id: 'a', employee_id: 'e1', start_date: '2026-09-01', end_date: '2026-09-02', total_amount: '1200.00', status: 'rejected' },
      { id: 'b', employee_id: 'e1', start_date: '2026-09-01', end_date: '2026-09-02', total_amount: '1200.00', status: 'paid' },
    ]
    const q = { employeeId: 'e1', startDate: '2026-09-01', endDate: '2026-09-02', total: 1200 }
    expect(findLookAlikeClaim(claims, q)?.id).toBe('b')
    expect(findLookAlikeClaim(claims.slice(0, 1), q)).toBeNull()
    expect(findLookAlikeClaim(claims, { ...q, total: 1300 })).toBeNull()
  })
})
