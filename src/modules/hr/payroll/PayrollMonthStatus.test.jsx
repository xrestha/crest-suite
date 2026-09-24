import { render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { MemoryRouter } from 'react-router-dom'
import PayrollMonthStatus from './PayrollMonthStatus'
import { getBsToday } from '../../../utils/bsCalendar'

// The strip reads through useScopedDb; each test decides what every table answers. A supabase-js
// builder is a thenable that chains, so the fake is one object whose filters return itself.
let mockAnswers = {}
function mockBuilder(table, opts) {
  const b = {
    eq: () => b, lte: () => b, gte: () => b, in: () => b, or: () => b, order: () => b, limit: () => b, range: () => b,
    maybeSingle: () => b,
    then: (ok, err) => Promise.resolve(mockAnswers[table]?.(opts) ?? { data: [], error: null, count: 0 }).then(ok, err),
  }
  return b
}
jest.mock('../../../context/AuthContext', () => ({ useAuth: () => ({ clientId: 'c1' }) }))
jest.mock('../../../shared/hooks/useScopedDb', () => ({ useScopedDb: () => ({ scopedFrom: (t, _c, o) => mockBuilder(t, o) }) }))
jest.mock('../../../utils/bsCalendar', () => {
  const actual = jest.requireActual('../../../utils/bsCalendar')
  return { ...actual, getBsToday: jest.fn() }
})

const period = { id: 'p5', bs_year: 2083, bs_month: 5 }
const renderStrip = props => render(<MemoryRouter><PayrollMonthStatus period={period} {...props} /></MemoryRouter>)
const step = name => screen.getByText(name).closest('li')

beforeEach(() => {
  getBsToday.mockReturnValue({ year: 2083, month: 6, day: 3 })
  mockAnswers = {
    hr_leave_requests: () => ({ data: null, error: null, count: 2 }),
    hr_overtime_entries: () => ({ data: null, error: null, count: 0 }),
    hr_tada_claims: () => ({ data: null, error: null, count: 1 }),
  }
})

describe('PayrollMonthStatus', () => {
  it('names the month and walks the five steps in order', async () => {
    renderStrip({ employees: [], attendance: [], run: null, payslips: [] })
    expect(await screen.findByRole('navigation', { name: /Bhadra 2083 payroll/ })).toBeInTheDocument()
    expect([...document.querySelectorAll('.month-status__label')].map(n => n.textContent)).toEqual(['Attendance', 'Approvals', 'Payroll', 'Staff paid', 'SSF deposit'])
    expect(await within(step('Staff paid')).findByText(/After Finalize — finalizing pays nobody/)).toBeInTheDocument()
  })

  // S782. Finalize pays nobody, so the step between the run and the SSF deposit is whether the
  // money actually went out — and a failed read of that is never a reassuring answer.
  describe('Staff paid', () => {
    const finalized = { id: 'r', status: 'finalized' }
    const payslips = [{ employee_id: 'a', net_pay: 29963 }, { employee_id: 'b', net_pay: 26697 }]
    const paid = id => ({ employee_id: id, amount: id === 'a' ? 29963 : 26697, paid_on: '2026-09-20', voided_at: null })

    it("says how many are still to be paid, from the page's own payments", async () => {
      renderStrip({ employees: [], attendance: [], run: finalized, payslips, payments: [paid('a')] })
      expect(await within(step('Staff paid')).findByText(/1 of 2 marked paid — NPR 26,697 still to pay/)).toBeInTheDocument()
    })

    it('ticks only when everyone is paid', async () => {
      renderStrip({ employees: [], attendance: [], run: finalized, payslips, payments: [paid('a'), paid('b')] })
      expect(await within(step('Staff paid')).findByText('All 2 marked paid')).toBeInTheDocument()
      expect(within(step('Staff paid')).getByText('✓')).toBeInTheDocument()
    })

    it('does not count an undone payment', async () => {
      renderStrip({ employees: [], attendance: [], run: finalized, payslips, payments: [paid('a'), { ...paid('b'), voided_at: '2026-09-21T00:00:00Z' }] })
      expect(await within(step('Staff paid')).findByText(/1 of 2 marked paid/)).toBeInTheDocument()
    })

    it('never turns a failed payments read into "not paid" or a tick', async () => {
      renderStrip({ employees: [], attendance: [], run: finalized, payslips, payments: [], paymentsError: { message: 'refused' } })
      expect(await within(step('Staff paid')).findByText('Could not check')).toBeInTheDocument()
      expect(within(step('Staff paid')).queryByText('✓')).toBeNull()
    })

    // S788: someone paid and then regenerated out of the month is in `over` but not `owed`. When
    // every payslip still in the run nets 0, owed is 0 — and the strip must still warn, not tick.
    it('warns about a payment with no payslip even when nothing else is owed', async () => {
      renderStrip({ employees: [], attendance: [], run: finalized, payslips: [{ employee_id: 'c', net_pay: 0 }],
        payments: [{ employee_id: 'gone', amount: 5000, paid_on: '2026-09-20', voided_at: null }] })
      expect(await within(step('Staff paid')).findByText(/1 paid more than their payslip — check Payroll/)).toBeInTheDocument()
      expect(within(step('Staff paid')).queryByText('✓')).toBeNull()
    })

    it('still says "Nothing to pay" when no payslip nets anything and nobody was paid', async () => {
      renderStrip({ employees: [], attendance: [], run: finalized, payslips: [{ employee_id: 'c', net_pay: 0 }], payments: [] })
      expect(await within(step('Staff paid')).findByText('Nothing to pay')).toBeInTheDocument()
    })

    it('reads the payments itself when the page does not pass them', async () => {
      mockAnswers.hr_salary_payments = () => ({ data: [paid('a'), paid('b')], error: null })
      renderStrip({ employees: [], attendance: [], run: finalized, payslips })
      expect(await within(step('Staff paid')).findByText('All 2 marked paid')).toBeInTheDocument()
    })
  })

  it('counts unpaid unmarked days for daily staff, and links the queues that are waiting', async () => {
    renderStrip({ employees: [{ id: 'd', pay_basis: 'daily' }], attendance: [], run: { id: 'r', status: 'draft' }, payslips: [], runStale: true, onPayrollPage: true })
    expect(await within(step('Attendance')).findByText(/unmarked days for 1 daily\/hourly staff/)).toBeInTheDocument()
    expect(within(step('Approvals')).getByText('3 waiting for a decision')).toBeInTheDocument()
    expect(within(step('Approvals')).getByRole('link', { name: 'Leave 2' })).toHaveAttribute('href', '/hr/leave')
    expect(within(step('Approvals')).queryByRole('link', { name: /Overtime/ })).toBeNull()
    expect(within(step('Payroll')).getByText(/out of date, Regenerate/)).toBeInTheDocument()
    // On the Payroll page the Payroll step does not link to itself.
    expect(within(step('Payroll')).queryByRole('link')).toBeNull()
  })

  it('never turns a failed count into a reassuring tick', async () => {
    mockAnswers.hr_overtime_entries = () => ({ data: null, error: { message: 'refused' }, count: null })
    renderStrip({ employees: [], attendance: [], run: null, payslips: [] })
    expect(await within(step('Approvals')).findByText(/Could not check/)).toBeInTheDocument()
    expect(within(step('Approvals')).queryByText('✓')).toBeNull()
  })

  it('states the SSF amount and date once finalized, without calling a passed date a missed deposit', async () => {
    const payslips = [{ ssf_employee: 1100, ssf_employer: 2000 }]
    renderStrip({ employees: [], attendance: [], run: { id: 'r', status: 'finalized' }, payslips })
    expect(await within(step('SSF deposit')).findByText(/Deposit NPR 3,100 by 25 Ashwin/)).toBeInTheDocument()
    expect(within(step('SSF deposit')).getByRole('link', { name: 'SSF challan' })).toHaveAttribute('href', '/hr/reports?tab=ssf&period=p5')

    getBsToday.mockReturnValue({ year: 2083, month: 7, day: 1 })
    renderStrip({ employees: [], attendance: [], run: { id: 'r', status: 'finalized' }, payslips })
    expect((await screen.findAllByText(/NPR 3,100 was due by 25 Ashwin/)).length).toBe(1)
  })
})
