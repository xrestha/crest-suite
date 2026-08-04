// The payslip document itself — letterhead, earnings, deductions, reimbursement, net pay.
// Shared deliberately: it backs the owner's Payroll → Payslip modal, that modal's print view,
// AND the employee's own copy in HR Self-Service. Those last two used to be different renderers,
// and the employee's showed strictly fewer lines than the owner's — a payslip whose Net Pay
// couldn't be derived from anything on it (see migration 20260720140000). One component means
// they cannot drift apart again; anything added here shows up on both copies at once.
//
// `slip` needs the full hr_payslips shape and `emp` the employee identity fields — for the
// self-service caller both arrive together from the get_my_hr_payslips RPC, since those accounts
// are fenced off hr_employees directly by the S316 restrictive policies.
export default function PayslipBody({ slip, emp, periodLabel, bizInfo, forPrint }) {
  const c1 = forPrint ? '#000' : 'var(--theme-text3)'
  const c2 = forPrint ? '#000' : 'var(--theme-text1)'
  const fmtn = n => `NPR ${Math.round(n || 0).toLocaleString('en-NP')}`
  const Row = ({ label, value, strong, neg }) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', fontSize: 13, fontWeight: strong ? 700 : 400 }}>
      <span style={{ color: strong ? c2 : c1 }}>{label}</span>
      <span style={{ color: strong ? (forPrint ? '#000' : 'var(--theme-accent)') : (neg ? 'var(--theme-red)' : c2) }}>{neg ? '− ' : ''}{fmtn(value)}</span>
    </div>
  )
  const isMonthly = slip.pay_basis === 'monthly'
  const ssfLine = emp.ssf_enrolled && emp.ssf_no ? `SSF ${emp.ssf_no}` : null
  return (
    <div>
      {/* Letterhead — a payslip with no employer identity on it is missing the single most
          basic thing a pay document is expected to have. bizInfo is best-effort: an client that
          hasn't filled in Settings → Property Address/PAN just gets a shorter header, not a
          broken one. */}
      {bizInfo?.name && (
        <div style={{ marginBottom: 12, paddingBottom: 10, borderBottom: `2px solid ${forPrint ? '#000' : 'var(--theme-accent)'}` }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: c2 }}>{bizInfo.name}</div>
          {bizInfo.address && <div style={{ fontSize: 11, color: c1 }}>{bizInfo.address}</div>}
          {bizInfo.vatNumber && <div style={{ fontSize: 11, color: c1 }}>PAN: {bizInfo.vatNumber}</div>}
          <div style={{ fontSize: 10, color: c1, marginTop: 4, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Payslip</div>
        </div>
      )}

      <div style={{ marginBottom: 12, paddingBottom: 12, borderBottom: `1px solid ${forPrint ? '#ccc' : 'var(--theme-border)'}` }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: c2 }}>{emp.full_name}</div>
        <div style={{ fontSize: 12, color: c1 }}>
          {[emp.employee_code, emp.department, `${slip.pay_basis} pay`, ssfLine].filter(Boolean).join(' · ')} — {periodLabel}
        </div>
      </div>

      <div style={{ fontSize: 10, color: c1, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>Earnings</div>
      <Row label={isMonthly ? 'Basic Salary' : `Wage (${slip.pay_basis})`} value={slip.basic} />
      {isMonthly && slip.allowances > 0 && <Row label="Allowances (incl. Dearness)" value={slip.allowances} />}
      {!isMonthly && <Row label={slip.pay_basis === 'hourly' ? `Hours worked (${(slip.hours_worked || 0).toFixed(1)})` : `Days worked (${(slip.worked_days || 0).toFixed(1)})`} value={slip.gross} />}
      {slip.ot_amount > 0 && <Row label={`Overtime (${(slip.ot_hours || 0).toFixed(1)} hrs)`} value={slip.ot_amount} />}
      <Row label="Gross Earnings" value={slip.gross + slip.ot_amount} strong />

      <div style={{ fontSize: 10, color: c1, textTransform: 'uppercase', letterSpacing: '0.08em', margin: '12px 0 4px' }}>Deductions</div>
      {/* The day count, not just the amount, is what lets an employee actually check a dock —
          "paid for 22 of 30 days" is auditable against their own memory; a bare rupee figure
          isn't. Only shown when there IS a dock, so a clean month stays uncluttered. */}
      {slip.absence_deduction > 0 && (
        <Row
          label={slip.absent_days > 0 ? `Absence / Unpaid Leave (${(slip.absent_days || 0).toFixed(1)} days)` : 'Absence / Unpaid Leave'}
          value={slip.absence_deduction}
          neg
        />
      )}
      {slip.ssf_employee > 0 && <Row label="SSF — Social Security Fund (11%)" value={slip.ssf_employee} neg />}
      {slip.other_deductions > 0 && <Row label="Other Deductions" value={slip.other_deductions} neg />}
      {(slip.advance_deduction || 0) > 0 && <Row label="Advance / Loan Recovery" value={slip.advance_deduction} neg />}
      {slip.tds > 0 && <Row label="TDS (income tax)" value={slip.tds} neg />}
      {(slip.absence_deduction + slip.ssf_employee + slip.other_deductions + (slip.advance_deduction || 0) + slip.tds) === 0 && (
        <div style={{ fontSize: 12, color: c1, padding: '5px 0' }}>None</div>
      )}

      {(slip.tada_amount || 0) > 0 && (
        <>
          <div style={{ fontSize: 10, color: c1, textTransform: 'uppercase', letterSpacing: '0.08em', margin: '12px 0 4px' }}>Reimbursement</div>
          <Row label="TADA — Travel & Daily Allowance (non-taxable)" value={slip.tada_amount} />
        </>
      )}

      <div style={{
        marginTop: 12, paddingTop: 12, borderTop: `2px solid ${forPrint ? '#000' : 'var(--theme-border)'}`,
        // Background tint only on screen — light fills are unreliable on B&W printers and the
        // bold border + accent-colored figure already carry the emphasis on paper.
        background: forPrint ? 'transparent' : 'color-mix(in srgb, var(--theme-accent) 8%, transparent)',
        borderRadius: forPrint ? 0 : 6, padding: forPrint ? '12px 0 0' : '10px 10px 6px',
        marginLeft: forPrint ? 0 : -10, marginRight: forPrint ? 0 : -10,
      }}>
        <Row label="Net Pay" value={slip.net_pay} strong />
      </div>
      {slip.ssf_employer > 0 && (
        <div style={{ marginTop: 8, fontSize: 11, color: c1 }}>
          Employer SSF — Social Security Fund (20%, paid by company): {fmtn(slip.ssf_employer)}
        </div>
      )}
    </div>
  )
}
