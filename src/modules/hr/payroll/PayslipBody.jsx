import { npr } from '../../../shared/nepalMoney'
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
//
// `draft` (S751): the run this payslip belongs to is not finalized. A draft used to print exactly
// like a final one, so a figure that Regenerate was about to change could be handed to an employee
// as their pay. The employee's own copy never passes it — Self-Service only lists finalized payslips.
const num = v => parseFloat(v) || 0
const qty = n => String(Math.round(n * 100) / 100)

// `phone` (S768): the employee's own copy in Crest Staff. The same document, read at arm's length
// on a small screen — its section heads and meta lines were 10–11px, sized for a desktop dialog.
export default function PayslipBody({ slip, emp, periodLabel, bizInfo, forPrint, draft = false, phone = false }) {
  const c1 = forPrint ? '#000' : phone ? 'var(--theme-text2)' : 'var(--theme-text3)'
  const c2 = forPrint ? '#000' : 'var(--theme-text1)'
  const fmtn = npr
  const small = phone ? 13 : 11
  const head = phone ? 12 : 10
  const Row = ({ label, value, strong, neg }) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: phone ? '7px 0' : '5px 0', fontSize: phone ? 15 : 13, fontWeight: strong ? 700 : 400 }}>
      <span style={{ color: strong ? c2 : c1 }}>{label}</span>
      {/* One ink for every figure (S768): SSF and income tax are required by law, and a red line on
          the employee's own payslip reads as a penalty. The − sign says it is taken off. */}
      <span style={{ color: c2 }}>{neg ? '− ' : ''}{fmtn(value)}</span>
    </div>
  )
  const isMonthly = slip.pay_basis === 'monthly'
  const ssfLine = emp.ssf_enrolled && emp.ssf_no ? `SSF ${emp.ssf_no}` : null

  // Daily/hourly wages as ONE line: rate × paid units = earned (S751). It used to print the rate as
  // if it were an earning, then "Hours worked (N)" beside the gross — where N included overtime hours
  // and left out paid-leave and holiday hours, so rate × N never came to the amount printed.
  // The units are what computePayslip pays: daily → worked_days (present, paid leave and holidays);
  // hourly → hours_worked − ot_hours. The multiplication is printed only when it actually reproduces
  // the gross; otherwise (paid leave or holiday hours, an approved overtime entry, a payslip written
  // before these columns) it shows the rate and the amount, and no sum that does not add up.
  let wageLabel = null
  if (!isMonthly) {
    const hourly = slip.pay_basis === 'hourly'
    const rate = num(slip.basic)
    const stored = hourly ? slip.hours_worked : slip.worked_days
    const units = hourly ? num(slip.hours_worked) - num(slip.ot_hours) : num(stored)
    const adds = stored != null && units > 0 && rate > 0 && Math.round(rate * units) === Math.round(num(slip.gross))
    wageLabel = adds
      ? `Wages — ${fmtn(rate)} × ${qty(units)} paid ${hourly ? 'hours' : 'days'}`
      : `Wages earned (${hourly ? 'hourly' : 'daily'} rate ${fmtn(rate)})`
  }
  const retirement = num(slip.retirement_contribution)

  return (
    <div>
      {draft && (
        // Plain black border on paper, amber on screen — the stamp must survive a B&W printer.
        <div role="note" style={{
          marginBottom: 12, padding: '6px 10px', textAlign: 'center',
          border: `2px solid ${forPrint ? '#000' : 'var(--theme-amber)'}`,
          background: forPrint ? 'transparent' : 'color-mix(in srgb, var(--theme-amber) 8%, transparent)',
          color: forPrint ? '#000' : 'var(--theme-amber-text)',
        }}>
          <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Draft — not final</div>
          <div style={{ fontSize: 11, marginTop: 2 }}>Payroll for this month is not finalized yet, so these figures can still change.</div>
        </div>
      )}

      {/* Letterhead — a payslip with no employer identity on it is missing the single most
          basic thing a pay document is expected to have. bizInfo is best-effort: an client that
          hasn't filled in Settings → Property Address/PAN just gets a shorter header, not a
          broken one. */}
      {bizInfo?.name && (
        <div style={{ marginBottom: 12, paddingBottom: 10, borderBottom: `2px solid ${forPrint ? '#000' : 'var(--theme-accent)'}` }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: c2 }}>{bizInfo.name}</div>
          {bizInfo.address && <div style={{ fontSize: small, color: c1 }}>{bizInfo.address}</div>}
          {bizInfo.vatNumber && <div style={{ fontSize: small, color: c1 }}>PAN: {bizInfo.vatNumber}</div>}
          <div style={{ fontSize: head, color: c1, marginTop: 4, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Payslip</div>
        </div>
      )}

      <div style={{ marginBottom: 12, paddingBottom: 12, borderBottom: `1px solid ${forPrint ? '#ccc' : 'var(--theme-border)'}` }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: c2 }}>{emp.full_name}</div>
        <div style={{ fontSize: phone ? 13 : 12, color: c1 }}>
          {[emp.employee_code, emp.department, `${slip.pay_basis} pay`, ssfLine].filter(Boolean).join(' · ')} — {periodLabel}
        </div>
      </div>

      <div style={{ fontSize: head, color: c1, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>Earnings</div>
      {isMonthly && <Row label="Basic Salary" value={slip.basic} />}
      {isMonthly && slip.allowances > 0 && <Row label="Allowances" value={slip.allowances} />}
      {!isMonthly && <Row label={wageLabel} value={slip.gross} />}
      {slip.ot_amount > 0 && <Row label={`Overtime (${(slip.ot_hours || 0).toFixed(1)} hrs)`} value={slip.ot_amount} />}
      <Row label="Gross Earnings" value={slip.gross + slip.ot_amount} strong />

      <div style={{ fontSize: head, color: c1, textTransform: 'uppercase', letterSpacing: '0.08em', margin: '12px 0 4px' }}>Deductions</div>
      {/* The day count, not just the amount, is what lets an employee actually check a dock —
          "paid for 22 of 30 days" is auditable against their own memory; a bare rupee figure
          isn't. Only shown when there IS a dock, so a clean month stays uncluttered. */}
      {/* `unpaid_days`, not `absent_days`: this dock covers absences AND unpaid leave, half days
          and pre-join days, while `absent_days` counts only literal absences (Payroll Run's Excel
          column depends on that narrower meaning). Printing the narrow figure here understated
          the count on the one line whose whole purpose is being checkable — an employee with one
          absence and three unpaid-leave days read "(1.0 days)" against four days of money. Older
          payslips written before the column existed have no value, and correctly print no count
          rather than a wrong one. */}
      {slip.absence_deduction > 0 && (
        <Row
          label={slip.unpaid_days > 0 ? `Absence / Unpaid Leave (${(slip.unpaid_days || 0).toFixed(1)} days)` : 'Absence / Unpaid Leave'}
          value={slip.absence_deduction}
          neg
        />
      )}
      {slip.ssf_employee > 0 && <Row label="SSF — Social Security Fund (11%)" value={slip.ssf_employee} neg />}
      {/* The CIT / retirement-fund part is named (S751): it is the part that also lowers income tax,
          and an employee checking their CIT statement needs the figure, not a lump. */}
      {slip.other_deductions > 0 && (
        <Row label={retirement > 0 ? `Other Deductions (incl. CIT ${fmtn(retirement)})` : 'Other Deductions'} value={slip.other_deductions} neg />
      )}
      {(slip.advance_deduction || 0) > 0 && <Row label="Advance / Loan Recovery" value={slip.advance_deduction} neg />}
      {slip.tds > 0 && <Row label="TDS (income tax)" value={slip.tds} neg />}
      {(slip.absence_deduction + slip.ssf_employee + slip.other_deductions + (slip.advance_deduction || 0) + slip.tds) === 0 && (
        <div style={{ fontSize: 12, color: c1, padding: '5px 0' }}>None</div>
      )}

      {(slip.tada_amount || 0) > 0 && (
        <>
          <div style={{ fontSize: head, color: c1, textTransform: 'uppercase', letterSpacing: '0.08em', margin: '12px 0 4px' }}>Reimbursement</div>
          <Row label="TADA — Travel & Daily Allowance (non-taxable)" value={slip.tada_amount} />
        </>
      )}

      <div style={{
        marginTop: 12, paddingTop: 12, borderTop: `2px solid ${forPrint ? '#000' : 'var(--theme-border)'}`,
        // Background tint only on screen — light fills are unreliable on B&W printers and the
        // bold border + accent-colored figure already carry the emphasis on paper.
        background: forPrint ? 'transparent' : 'color-mix(in srgb, var(--theme-accent) 8%, transparent)',
        borderRadius: 0, padding: forPrint ? '12px 0 0' : '10px 10px 6px',
        marginLeft: forPrint ? 0 : -10, marginRight: forPrint ? 0 : -10,
      }}>
        <Row label="Net Pay" value={slip.net_pay} strong />
      </div>
      {slip.ssf_employer > 0 && (
        <div style={{ marginTop: 8, fontSize: small, color: c1 }}>
          Employer SSF — Social Security Fund (20%, paid by company): {fmtn(slip.ssf_employer)}
        </div>
      )}
    </div>
  )
}
