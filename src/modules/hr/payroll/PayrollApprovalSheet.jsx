import { nprInt } from '../../../shared/nepalMoney'
import { BS_MONTHS } from '../../../utils/bsCalendar'
import { nepalBsLong, nepalDateLong, nepalTime } from '../../../shared/nepalTime'
import { isSsfContributor } from './payrollCompute'
import { ssfDeadline } from './monthStatus'

// The payroll approval sheet (S777): the document the HR manager hands the Owner, who checks the
// month's pay and signs it off. Print-only, the same shape as the payslip and the working —
// PayrollRun renders it into a `.print-only` block and calls printWithTitle, so "Save as PDF" in
// the print dialog is the PDF, named after the month.
//
// It prints the STORED payslips, the figures Finalize locks, never a live recomputation. PayrollRun
// refuses to print a draft Finalize would refuse, so the Owner is never asked to sign figures that
// are about to change. And the approval line repeats the headcount and the net total: a draft
// regenerated after it was signed no longer matches the sheet the signature is on.
//
// Paper only, so black ink and no hover tooltips — every explanation is a visible line.
const fmt = nprInt
const num = v => parseFloat(v) || 0
const INK = '#000'
const SOFT = '#444'
const RULE = '#999'

const byName = (a, b) => a.name.localeCompare(b.name)

export default function PayrollApprovalSheet({
  period, periodLabel, run, payslips, empMap, nameOf, totals, cost, bizInfo, settled = [], preparedBy, progress,
}) {
  const finalized = run?.status === 'finalized'
  const monthName = BS_MONTHS[period.bs_month - 1]
  const now = new Date()
  const printedOn = `${nepalBsLong(now) || nepalDateLong(now)}, ${nepalTime(now)}`
  const finalizedOn = finalized && run.finalized_at ? (nepalBsLong(run.finalized_at) || nepalDateLong(run.finalized_at)) : ''

  const rows = payslips
    .map(s => ({ slip: s, emp: empMap[s.employee_id] || null, name: empMap[s.employee_id]?.full_name || nameOf(s.employee_id) }))
    .sort(byName)

  const deductions = totals.absence + totals.ssfEmp + totals.other + totals.advDed + totals.tds
  const deductionParts = [
    [totals.absence, 'unpaid days'], [totals.ssfEmp, 'employee SSF'], [totals.other, 'other deductions'],
    [totals.advDed, 'advance recovery'], [totals.tds, 'income tax'],
  ].filter(([v]) => v > 0).map(([v, label]) => `${label} ${fmt(v)}`)
  const ssfDeposit = totals.ssfEmp + totals.ssfEmpr
  const due = ssfDeadline(period.bs_year, period.bs_month)

  // What the Owner should know before signing, and nothing when there is nothing.
  const typedTax = rows.filter(r => r.slip.tds_overridden).map(r => r.name)
  const ssfNoNumber = rows.filter(r => r.emp?.ssf_enrolled && !String(r.emp.ssf_no || '').trim()).map(r => r.name)
  const noTakeHome = rows.filter(r => num(r.slip.net_pay) <= 0).map(r => r.name)
  const checks = [
    typedTax.length > 0 && `Income tax was typed by hand, not calculated, for ${typedTax.join(', ')}.`,
    ssfNoNumber.length > 0 && `Marked SSF-enrolled but with no SSF number, so no SSF is deducted: ${ssfNoNumber.join(', ')}.`,
    noTakeHome.length > 0 && `No take-home pay this month: ${noTakeHome.join(', ')}.`,
    !finalized && settled.length > 0 && `Left out because their Final Settlement already paid ${monthName}: ${settled.map(e => e.full_name).join(', ')}.`,
    !finalized && progress?.future && `${monthName} has not started yet, so attendance, leave and overtime can still change this pay.`,
    !finalized && progress && !progress.future && `${monthName} is not over yet (${progress.left === 0 ? 'today is its last day' : `${progress.left} day${progress.left === 1 ? '' : 's'} left`}), so attendance, leave and overtime can still change this pay.`,
  ].filter(Boolean)

  const label = { fontSize: 10, color: SOFT, textTransform: 'uppercase', letterSpacing: '0.08em' }
  const Line = ({ name, value, sub, strong }) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, padding: '2px 0', borderBottom: `1px solid ${strong ? INK : '#ddd'}`, fontWeight: strong ? 700 : 400 }}>
      <span>
        {name}
        {sub && <span style={{ display: 'block', fontSize: 10, color: SOFT, fontWeight: 400 }}>{sub}</span>}
      </span>
      <span style={{ whiteSpace: 'nowrap' }}>{value}</span>
    </div>
  )
  const money = (v, sign = '') => (v > 0 ? `${sign}${fmt(v)}` : '—')
  // A deposit of nothing is a fact the Owner can act on, so it is said in words rather than a dash.
  const deposit = v => (v > 0 ? fmt(v) : 'none')
  const SignBox = ({ title, role, name }) => (
    <div style={{ flex: 1, border: `1px solid ${RULE}`, padding: '8px 14px 10px' }}>
      <div style={{ ...label, color: INK, fontWeight: 700 }}>
        {title}{role && <span style={{ fontWeight: 400, color: SOFT, textTransform: 'none', letterSpacing: 0 }}> — {role}</span>}
      </div>
      {[['Name', name], ['Signature', ''], ['Date', '']].map(([k, v]) => (
        <div key={k} style={{ display: 'flex', alignItems: 'flex-end', gap: 8, marginTop: k === 'Signature' ? 22 : 12 }}>
          <span style={{ fontSize: 11, color: SOFT, width: 62 }}>{k}</span>
          <span style={{ flex: 1, borderBottom: `1px solid ${INK}`, fontSize: 12, lineHeight: '16px', height: 17 }}>{v}</span>
        </div>
      ))}
    </div>
  )

  return (
    <div className="payroll-approval" style={{ padding: '6px 10px', color: INK, fontSize: 12 }}>
      <style>{`
        @media print {
          @page { size: A4 landscape; margin: 10mm 12mm; }
          .payroll-approval th, .payroll-approval td { padding: 4px 6px !important; font-size: 11px !important; border-color: ${RULE} !important; }
          .payroll-approval thead { display: table-header-group; }
          /* Printed once, after the last row. Chrome repeats a tfoot on every page, so a sheet running
             to two pages put the whole month's total under page one's rows, reading as their subtotal. */
          .payroll-approval tfoot { display: table-row-group; }
          .payroll-approval tr, .payroll-approval .pa-keep { break-inside: avoid; page-break-inside: avoid; }
        }
      `}</style>

      {/* Letterhead and status */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 24, paddingBottom: 8, marginBottom: 10, borderBottom: `2px solid ${INK}` }}>
        <div>
          {bizInfo?.name && <div style={{ fontSize: 16, fontWeight: 800 }}>{bizInfo.name}</div>}
          {(bizInfo?.address || bizInfo?.vatNumber) && (
            <div style={{ fontSize: 11, color: SOFT }}>{[bizInfo.address, bizInfo.vatNumber && `PAN: ${bizInfo.vatNumber}`].filter(Boolean).join(' · ')}</div>
          )}
          <h1 style={{ fontSize: 18, margin: '4px 0 0', color: INK }}>Payroll Approval — {periodLabel}</h1>
          <div style={{ fontSize: 11, color: SOFT, marginTop: 2 }}>
            Prepared for the Owner to check and sign · {rows.length} employee{rows.length === 1 ? '' : 's'} · all figures in NPR
          </div>
        </div>
        {/* A bordered stamp, not a colour: it has to survive a black-and-white printer. */}
        <div style={{ border: `2px solid ${INK}`, padding: '6px 12px', textAlign: 'center', minWidth: 190 }}>
          <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
            {finalized ? 'Finalized' : 'Draft — for approval'}
          </div>
          <div style={{ fontSize: 10, marginTop: 2 }}>
            {finalized
              ? (finalizedOn ? `Locked on ${finalizedOn}, as paid` : 'Locked, as paid')
              : 'Not finalized yet'}
          </div>
        </div>
      </div>

      {/* Summary */}
      <div className="pa-keep" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 28, marginBottom: 10 }}>
        <div>
          <div style={{ ...label, marginBottom: 4 }}>This month's pay</div>
          <Line name="Gross pay" value={fmt(totals.gross)} />
          <Line name="Overtime" value={money(totals.ot, '+')} />
          <Line name="Deductions" value={money(deductions, '−')} sub={deductionParts.join(' · ') || null} />
          <Line name="Travel claims (TADA), not taxed" value={money(totals.tada, '+')} />
          <Line name="Net pay to staff" value={`NPR ${fmt(totals.net)}`} strong />
        </div>
        <div>
          <div style={{ ...label, marginBottom: 4 }}>What it costs, and what goes to the government</div>
          <Line name="Employer SSF (20%, paid on top of pay)" value={deposit(totals.ssfEmpr)} />
          <Line
            name="Cost to business" value={`NPR ${fmt(cost.total)}`} strong
            sub={`pay earned ${fmt(cost.earned)} + employer SSF ${fmt(cost.employerSsf)}${cost.tada > 0 ? ` · travel claims ${fmt(cost.tada)} on top` : ''}`}
          />
          <Line
            name="SSF to deposit (employee 11% + employer 20%)" value={deposit(ssfDeposit)}
            sub={ssfDeposit > 0 ? `due by ${due.day} ${BS_MONTHS[due.month - 1]} ${due.year}` : null}
          />
          <Line name="Income tax (TDS) to deposit" value={deposit(totals.tds)} />
        </div>
      </div>

      {/* Register — the same columns, in the same order, as the Payroll screen. */}
      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 10 }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'right', width: 28 }}>#</th>
            <th style={{ textAlign: 'left' }}>Employee</th>
            <th style={{ textAlign: 'right' }}>Gross</th>
            <th style={{ textAlign: 'right' }}>OT</th>
            <th style={{ textAlign: 'right' }}>Absence</th>
            <th style={{ textAlign: 'right' }}>SSF</th>
            <th style={{ textAlign: 'right' }}>Other ded.</th>
            <th style={{ textAlign: 'right' }}>Advance</th>
            <th style={{ textAlign: 'right' }}>Income tax</th>
            <th style={{ textAlign: 'right' }}>TADA</th>
            <th style={{ textAlign: 'right' }}>Net pay</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ slip: s, emp, name }, i) => (
            <tr key={s.id}>
              <td style={{ textAlign: 'right' }}>{i + 1}</td>
              <td>
                <div style={{ fontWeight: 600 }}>{name}</div>
                <div style={{ fontSize: 10, color: SOFT }}>
                  {[
                    emp?.employee_code, emp?.department,
                    s.pay_basis !== 'monthly' && `${s.pay_basis} pay`,
                    emp && (isSsfContributor(emp) ? 'SSF' : 'no SSF'),
                    s.tds_overridden && 'tax typed by hand',
                  ].filter(Boolean).join(' · ')}
                </div>
              </td>
              <td style={{ textAlign: 'right' }}>{fmt(s.gross)}</td>
              <td style={{ textAlign: 'right' }}>{money(num(s.ot_amount), '+')}</td>
              <td style={{ textAlign: 'right' }}>{money(num(s.absence_deduction), '−')}</td>
              <td style={{ textAlign: 'right' }}>{money(num(s.ssf_employee), '−')}</td>
              <td style={{ textAlign: 'right' }}>{money(num(s.other_deductions), '−')}</td>
              <td style={{ textAlign: 'right' }}>{money(num(s.advance_deduction), '−')}</td>
              <td style={{ textAlign: 'right' }}>{money(num(s.tds), '−')}</td>
              <td style={{ textAlign: 'right' }}>{money(num(s.tada_amount), '+')}</td>
              <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmt(s.net_pay)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr style={{ fontWeight: 700 }}>
            <td />
            <td>Total — {rows.length}</td>
            <td style={{ textAlign: 'right' }}>{fmt(totals.gross)}</td>
            <td style={{ textAlign: 'right' }}>{money(totals.ot, '+')}</td>
            <td style={{ textAlign: 'right' }}>{money(totals.absence, '−')}</td>
            <td style={{ textAlign: 'right' }}>{money(totals.ssfEmp, '−')}</td>
            <td style={{ textAlign: 'right' }}>{money(totals.other, '−')}</td>
            <td style={{ textAlign: 'right' }}>{money(totals.advDed, '−')}</td>
            <td style={{ textAlign: 'right' }}>{money(totals.tds, '−')}</td>
            <td style={{ textAlign: 'right' }}>{money(totals.tada, '+')}</td>
            <td style={{ textAlign: 'right' }}>{fmt(totals.net)}</td>
          </tr>
        </tfoot>
      </table>

      <div className="pa-keep" style={{ marginBottom: 10 }}>
        <div style={{ ...label, marginBottom: 4 }}>Check before signing</div>
        {checks.length > 0 ? (
          <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.5 }}>
            {checks.map(c => <li key={c}>{c}</li>)}
          </ul>
        ) : (
          <div style={{ lineHeight: 1.5 }}>Nothing flagged: no income tax typed by hand, no missing SSF numbers, and nobody with zero take-home pay.</div>
        )}
      </div>

      {/* The signature binds to the figures it names. */}
      <div className="pa-keep">
        <p style={{ margin: '0 0 8px', fontSize: 12, lineHeight: 1.5 }}>
          I have checked the {periodLabel} payroll above: <strong>{rows.length} employee{rows.length === 1 ? '' : 's'}</strong>,
          total net pay <strong>NPR {fmt(totals.net)}</strong>, and approve it {finalized ? 'for payment' : 'to be finalized and paid'}.
        </p>
        <div style={{ display: 'flex', gap: 20 }}>
          <SignBox title="Prepared by" role={preparedBy?.role || ''} name={preparedBy?.name || ''} />
          <SignBox title="Approved by" role="Owner" name="" />
        </div>
        <div style={{ marginTop: 8, display: 'flex', alignItems: 'flex-end', gap: 8 }}>
          <span style={{ fontSize: 11, color: SOFT, whiteSpace: 'nowrap' }}>Owner's remarks</span>
          <span style={{ flex: 1, borderBottom: `1px solid ${RULE}`, height: 18 }} />
        </div>
        <div style={{ borderBottom: `1px solid ${RULE}`, height: 22 }} />
        <div style={{ marginTop: 8, fontSize: 10, color: SOFT, display: 'flex', justifyContent: 'space-between', gap: 12 }}>
          <span>Printed {printedOn} from Crest HR → Payroll.</span>
          <span>{finalized ? 'Figures as paid.' : 'Draft: if payroll is regenerated after this is signed, print and sign a new sheet.'}</span>
        </div>
      </div>
    </div>
  )
}
