import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import PayrollApprovalSheet from './PayrollApprovalSheet'
import { payrollCashCost } from './payrollData'

// The Bhadra 2083 register the sheet was asked for from (CASA ACAI CAFE, S777), as stored payslips.
const period = { id: 'p5', bs_year: 2083, bs_month: 5 }
const slip = (id, employee_id, f) => ({
  id, employee_id, pay_basis: 'monthly', gross: 0, ot_amount: 0, absence_deduction: 0, ssf_employee: 0,
  other_deductions: 0, advance_deduction: 0, tds: 0, tada_amount: 0, net_pay: 0, ssf_employer: 0, tds_overridden: false, ...f,
})
const payslips = [
  slip('s1', 'e1', { gross: 27000, ot_amount: 3067, tds: 328, tada_amount: 224, net_pay: 29963 }),
  slip('s2', 'e2', { gross: 20000, ot_amount: 839, absence_deduction: 645, tds: 193, net_pay: 20001 }),
  slip('s3', 'e3', { gross: 25000, ot_amount: 1943, tds: 287, tada_amount: 41, net_pay: 26697 }),
]
const empMap = {
  e1: { id: 'e1', full_name: 'RONISH DANGOL', ssf_enrolled: false },
  e2: { id: 'e2', full_name: 'SARITA BISHWOKARMA', ssf_enrolled: false },
  e3: { id: 'e3', full_name: 'ANANDA BHUSAL', ssf_enrolled: false },
}
const totalsOf = slips => slips.reduce((a, s) => {
  a.gross += s.gross; a.ot += s.ot_amount; a.absence += s.absence_deduction; a.ssfEmp += s.ssf_employee
  a.other += s.other_deductions; a.advDed += s.advance_deduction; a.tds += s.tds; a.tada += s.tada_amount
  a.net += s.net_pay; a.ssfEmpr += s.ssf_employer
  return a
}, { gross: 0, ot: 0, absence: 0, ssfEmp: 0, other: 0, advDed: 0, tds: 0, tada: 0, net: 0, ssfEmpr: 0 })

const renderSheet = (props = {}) => {
  const slips = props.payslips || payslips
  return render(
    <PayrollApprovalSheet
      period={period} periodLabel="Bhadra 2083" run={{ id: 'r1', status: 'draft' }} payslips={slips}
      empMap={props.empMap || empMap} nameOf={() => '(employee record not found)'}
      totals={totalsOf(slips)} cost={payrollCashCost(slips)} bizInfo={{ name: 'CASA ACAI CAFE', address: '', vatNumber: '' }}
      {...props}
    />,
  )
}

test('binds the signature to the headcount and net total, and lists staff by name', () => {
  const { container } = renderSheet()
  expect(screen.getByText('Draft — for approval')).toBeInTheDocument()
  const approval = screen.getByText(/I have checked the Bhadra 2083 payroll above/)
  expect(approval).toHaveTextContent('3 employees, total net pay NPR 76,661, and approve it to be finalized and paid.')
  const names = [...container.querySelectorAll('tbody tr td:nth-child(2) > div:first-child')].map(d => d.textContent)
  expect(names).toEqual(['ANANDA BHUSAL', 'RONISH DANGOL', 'SARITA BISHWOKARMA'])
  // Cost to business is pay earned plus employer SSF, the page's own payrollCashCost.
  expect(screen.getByText('Cost to business').parentElement.parentElement).toHaveTextContent('NPR 77,204')
})

test('a finalized month prints as paid, and names what the Owner should check', () => {
  const flagged = payslips.map(s => (s.id === 's2' ? { ...s, tds_overridden: true } : s))
  renderSheet({
    run: { id: 'r1', status: 'finalized', finalized_at: null },
    payslips: flagged,
    empMap: { ...empMap, e3: { ...empMap.e3, ssf_enrolled: true, ssf_no: '' } },
  })
  expect(screen.getByText('Finalized')).toBeInTheDocument()
  expect(screen.getByText(/approve it for payment/)).toBeInTheDocument()
  expect(screen.getByText('Income tax was typed by hand, not calculated, for SARITA BISHWOKARMA.')).toBeInTheDocument()
  expect(screen.getByText('Marked SSF-enrolled but with no SSF number, so no SSF is deducted: ANANDA BHUSAL.')).toBeInTheDocument()
  expect(screen.queryByText(/^Nothing flagged/)).not.toBeInTheDocument()
})

test('says nothing is flagged rather than printing an empty list', () => {
  renderSheet({ run: { id: 'r1', status: 'finalized' } })
  expect(screen.getByText(/^Nothing flagged/)).toBeInTheDocument()
})

test('a draft names who a Final Settlement already paid, and a month still running', () => {
  renderSheet({ settled: [{ id: 'e9', full_name: 'HARI KC' }], progress: { left: 4 } })
  expect(screen.getByText('Left out because their Final Settlement already paid Bhadra: HARI KC.')).toBeInTheDocument()
  expect(screen.getByText(/Bhadra is not over yet \(4 days left\)/)).toBeInTheDocument()
})
