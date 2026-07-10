import { useState, useEffect, useMemo } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import Tip from '../../../components/Tip'
import { bsToAd, daysInBsMonth, getBsToday } from '../../../utils/bsCalendar'
import { computeBonusTds, fiscalYearOf } from '../payroll/tds'
import { printWithTitle } from '../../../utils/printTitle'

const fmt = n => Math.round(n || 0).toLocaleString('en-NP')

// Difference in whole months between two AD dates (from, to)
function monthsBetween(fromAdStr, toAdDate) {
  if (!fromAdStr) return 0
  const from = new Date(fromAdStr + 'T00:00:00')
  if (isNaN(from)) return 0
  return Math.max(0, (toAdDate.getFullYear() - from.getFullYear()) * 12 + (toAdDate.getMonth() - from.getMonth()))
}

// Format service as "X yr Y mo"
function fmtService(months) {
  const y = Math.floor(months / 12)
  const m = months % 12
  if (y === 0) return `${m} mo`
  if (m === 0) return `${y} yr`
  return `${y} yr ${m} mo`
}

const BS_MONTH_NAMES = [
  'Baisakh', 'Jestha', 'Ashadh', 'Shrawan', 'Bhadra', 'Ashwin',
  'Kartik', 'Mangsir', 'Poush', 'Magh', 'Falgun', 'Chaitra'
]

function BsDateSelect({ label, year, month, day, onChange, tip }) {
  const daysInMonth = daysInBsMonth(year, month)
  const yearRange = []
  for (let y = 2075; y <= 2090; y++) yearRange.push(y)

  const set = obj => onChange({ year, month, day, ...obj })

  return (
    <div>
      <label style={{ display: 'block', fontSize: 12, color: '#9ca3af', marginBottom: 5 }}>
        {tip ? <Tip text={tip} width={260}>{label}</Tip> : label}
      </label>
      <div style={{ display: 'flex', gap: 6 }}>
        <select className="form-select" value={year}  onChange={e => set({ year: +e.target.value })}>
          {yearRange.map(y => <option key={y} value={y}>{y}</option>)}
        </select>
        <select className="form-select" value={month} onChange={e => set({ month: +e.target.value })}>
          {BS_MONTH_NAMES.map((n, i) => <option key={i+1} value={i+1}>{n}</option>)}
        </select>
        <select className="form-select" value={Math.min(day, daysInMonth)} onChange={e => set({ day: +e.target.value })}>
          {Array.from({ length: daysInMonth }, (_, i) => i + 1).map(d => <option key={d} value={d}>{d}</option>)}
        </select>
      </div>
    </div>
  )
}

const today = getBsToday()

export default function FinalSettlement() {
  const { clientId } = useAuth()
  const { scopedFrom } = useScopedDb()

  const [employees,  setEmployees]  = useState([])
  const [empId,      setEmpId]      = useState('')
  const [reason,     setReason]     = useState('resignation')
  const [lastDate,   setLastDate]   = useState({ year: today.year, month: today.month, day: today.day })
  const [noticeDays, setNoticeDays] = useState(30)    // notice period per contract (calendar days)
  const [noticeServed, setNoticeServed] = useState(true)
  const [leaveDays,  setLeaveDays]  = useState(0)
  const [festPaid,   setFestPaid]   = useState(true)  // was festival allowance paid this FY?
  const [advances,   setAdvances]   = useState([])
  // Load employee list
  useEffect(() => {
    if (!clientId) return
    scopedFrom('hr_employees', 'id, full_name, employee_code, join_date, basic_salary, pay_basis, ssf_enrolled, marital_status, life_insurance_premium, health_insurance_premium, department')
      .in('status', ['active', 'probation'])
      .order('full_name')
      .then(({ data }) => setEmployees(data || []))
  }, [clientId, scopedFrom])

  // Load outstanding advances when employee changes. There is no stored balance column —
  // outstanding is always derived as amount − SUM(repayments), same as PayrollRun's advance map.
  useEffect(() => {
    if (!clientId || !empId) { setAdvances([]); return }
    Promise.all([
      scopedFrom('hr_advances', 'id, amount, purpose, issued_date, status')
        .eq('employee_id', empId).eq('status', 'active'),
      scopedFrom('hr_advance_repayments', 'advance_id, amount')
        .eq('employee_id', empId),
    ]).then(([{ data: advs }, { data: reps }]) => {
      const repaid = {}
      ;(reps || []).forEach(r => { repaid[r.advance_id] = (repaid[r.advance_id] || 0) + (parseFloat(r.amount) || 0) })
      const enriched = (advs || [])
        .map(a => ({ ...a, outstanding: Math.max(0, (parseFloat(a.amount) || 0) - (repaid[a.id] || 0)) }))
        .filter(a => a.outstanding > 0)
      setAdvances(enriched)
    })
  }, [clientId, empId, scopedFrom])

  const emp = employees.find(e => e.id === empId)

  // ── Core computation ─────────────────────────────────────────
  const result = useMemo(() => {
    if (!emp) return null

    const basic         = parseFloat(emp.basic_salary) || 0
    const lastAdDate    = bsToAd(lastDate.year, lastDate.month, lastDate.day)
    const serviceMonths = monthsBetween(emp.join_date, lastAdDate)
    const vested        = serviceMonths >= 12

    // ── Partial-month salary (last month, from 1st to lastDate.day) ──
    const totalDaysInLastMonth = daysInBsMonth(lastDate.year, lastDate.month)
    const daysWorked           = lastDate.day  // from day 1 to last working day (inclusive)
    const partialSalary        = (basic / totalDaysInLastMonth) * daysWorked

    // ── Leave encashment (Labour Act: basic / 26 per day) ──
    const leaveEncashment = (basic / 26) * (parseFloat(leaveDays) || 0)

    // ── Gratuity (if vested) ──
    // Accrual: 1 month basic per year of service (8.33%). For SSF-enrolled staff the employer's
    // monthly SSF contribution already funds gratuity (3.33% of capped basic goes to the SSF
    // gratuity fund) — net that out so it isn't paid twice, matching GratuityTracker's model.
    const gratuityAccrued    = vested ? (basic / 12) * serviceMonths : 0
    const gratuitySsfCovered = vested && emp.ssf_enrolled ? Math.min(basic, 100000) * 0.0333 * serviceMonths : 0
    const gratuity           = Math.max(0, gratuityAccrued - gratuitySsfCovered)

    // ── Festival pro-ration (if not yet paid this FY) ──
    // Nepal convention: full basic as festival allowance once a year (around Dashain).
    // If the employee leaves mid-year before it's paid, pro-rate by months in this FY.
    const { fyStart, monthInFy: curMonthInFy } = fiscalYearOf(lastDate.year, lastDate.month)
    // Convention: pro-rated if not paid. Basic × (months since Shrawan / 12)
    const festivalPro = !festPaid ? basic * (curMonthInFy / 12) : 0

    // ── Notice pay deduction (if notice not served) ──
    // Deduct for unserved notice: (basic / 26) × noticeDays
    const noticeDeduction = noticeServed ? 0 : (basic / 26) * (parseFloat(noticeDays) || 0)

    // ── Outstanding advance deductions ──
    const advanceDeduction = advances.reduce((a, x) => a + (x.outstanding || 0), 0)

    // ── TDS on lump-sum components ──
    // Taxable lump: gratuity + leave encashment (festival pro-ration is also income)
    // Use annual basic as the YTD baseline (approximation — no YTD payroll data here)
    const annualBasic   = basic * 12
    const annualSsf     = emp.ssf_enrolled ? Math.min(basic, 100000) * 0.11 * 12 : 0
    const ssfDeduction  = Math.min(annualSsf, Math.min(500000, annualBasic / 3))
    const lifeIns       = Math.min(parseFloat(emp.life_insurance_premium) || 0, 40000)
    const healthIns     = Math.min(parseFloat(emp.health_insurance_premium) || 0, 20000)
    const annualTaxable = Math.max(0, annualBasic - ssfDeduction - lifeIns - healthIns)

    const lumpSum       = gratuity + leaveEncashment + festivalPro
    const lumpTds       = computeBonusTds({
      annualTaxable, bonusAmount: lumpSum,
      isSsf: !!emp.ssf_enrolled, isMarried: emp.marital_status === 'married', fyStart,
    })

    // ── Summary ──
    const grossPayout   = partialSalary + leaveEncashment + gratuity + festivalPro
    const totalDeductions = noticeDeduction + advanceDeduction + lumpTds
    const netPayout     = grossPayout - totalDeductions

    return {
      basic, serviceMonths, vested,
      totalDaysInLastMonth, daysWorked, partialSalary,
      leaveEncashment, gratuity, gratuityAccrued, gratuitySsfCovered, festivalPro,
      noticeDeduction, advanceDeduction, lumpTds,
      grossPayout, totalDeductions, netPayout,
      annualTaxable, lumpSum, fyStart,
    }
  }, [emp, lastDate, leaveDays, festPaid, noticeServed, noticeDays, advances])

  function handlePrint() { printWithTitle(`Final Settlement - ${emp.full_name}`) }

  return (
    <div>
      <div className="page-header no-print" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">Final Settlement</h1>
          <p className="page-subtitle">Resignation / termination payout calculator</p>
        </div>
        {result && (
          <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={handlePrint}>🖨 Print</button>
        )}
      </div>

      {/* ── Inputs ────────────────────────────────────────── */}
      <div className="card no-print" style={{ padding: 20, marginBottom: 20 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 16 }}>

          {/* Employee */}
          <div>
            <label style={{ display: 'block', fontSize: 12, color: '#9ca3af', marginBottom: 5 }}>Employee</label>
            <select className="form-select" value={empId} onChange={e => setEmpId(e.target.value)}>
              <option value="">— Select employee —</option>
              {employees.filter(e => (e.pay_basis || 'monthly') === 'monthly').map(e => (
                <option key={e.id} value={e.id}>{e.full_name}{e.employee_code ? ` (${e.employee_code})` : ''}</option>
              ))}
            </select>
          </div>

          {/* Reason */}
          <div>
            <label style={{ display: 'block', fontSize: 12, color: '#9ca3af', marginBottom: 5 }}>Separation Reason</label>
            <select className="form-select" value={reason} onChange={e => setReason(e.target.value)}>
              <option value="resignation">Resignation</option>
              <option value="termination">Termination</option>
              <option value="retirement">Retirement</option>
              <option value="mutual">Mutual Separation</option>
            </select>
          </div>

          {/* Last working date */}
          <div style={{ gridColumn: 'span 2' }}>
            <BsDateSelect
              label="Last Working Date (BS)"
              tip="The last day the employee worked. Used to calculate partial-month salary and total service months."
              year={lastDate.year} month={lastDate.month} day={lastDate.day}
              onChange={setLastDate}
            />
          </div>

          {/* Unused leave days */}
          <div>
            <label style={{ display: 'block', fontSize: 12, color: '#9ca3af', marginBottom: 5 }}>
              <Tip text="Number of unused annual leave days to encash. Nepal Labour Act rate: basic ÷ 26 per day." width={260}>Unused Leave Days</Tip>
            </label>
            <input type="number" className="form-select" min={0} max={365} value={leaveDays} onChange={e => setLeaveDays(e.target.value)} />
          </div>

          {/* Notice period */}
          <div>
            <label style={{ display: 'block', fontSize: 12, color: '#9ca3af', marginBottom: 5 }}>
              <Tip text="Required notice period per employment contract (in calendar days). If notice was not served, this amount is deducted from final pay." width={280}>Notice Period (days)</Tip>
            </label>
            <input type="number" className="form-select" min={0} max={90} value={noticeDays} onChange={e => setNoticeDays(e.target.value)} />
          </div>

          {/* Checkboxes */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, justifyContent: 'flex-end', paddingBottom: 2 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#e8e0d0', cursor: 'pointer' }}>
              <input type="checkbox" checked={noticeServed} onChange={e => setNoticeServed(e.target.checked)} />
              <Tip text="Check if the employee served their full notice period. If unchecked, notice-period pay will be deducted from the settlement." width={280}>Notice period served</Tip>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#e8e0d0', cursor: 'pointer' }}>
              <input type="checkbox" checked={festPaid} onChange={e => setFestPaid(e.target.checked)} />
              <Tip text="Check if the employee has already received their festival (Dashain) allowance this fiscal year. If unchecked, a pro-rated festival amount is included in the payout." width={300}>Festival allowance paid this FY</Tip>
            </label>
          </div>
        </div>
      </div>

      {/* ── Result ────────────────────────────────────────── */}
      {!empId && (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: '#4b5563' }}>
          Select an employee to calculate final settlement.
        </div>
      )}

      {emp && result && (
        <div>
          {/* Print header (hidden on screen) */}
          <div className="print-only" style={{ marginBottom: 24 }}>
            <h2 style={{ margin: 0 }}>Final Settlement Statement</h2>
            <div style={{ fontSize: 13, marginTop: 4 }}>
              {emp.full_name}{emp.employee_code ? ` · ${emp.employee_code}` : ''} · {emp.department || ''}
            </div>
            <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
              Last working date: {lastDate.day} {BS_MONTH_NAMES[lastDate.month - 1]} {lastDate.year} BS ·
              Service: {fmtService(result.serviceMonths)} ·
              Reason: {reason.charAt(0).toUpperCase() + reason.slice(1)}
            </div>
          </div>

          {/* Employee summary */}
          <div className="card no-print" style={{ padding: '14px 18px', marginBottom: 16, display: 'flex', gap: 24, flexWrap: 'wrap', fontSize: 13 }}>
            <div><span style={{ color: '#6b7280' }}>Employee: </span><strong>{emp.full_name}</strong></div>
            <div><span style={{ color: '#6b7280' }}>Basic: </span><strong>NPR {fmt(result.basic)}</strong></div>
            <div><span style={{ color: '#6b7280' }}>Service: </span><strong>{fmtService(result.serviceMonths)}</strong></div>
            <div><span style={{ color: '#6b7280' }}>Gratuity: </span>
              <Tip text="The 12-month vesting cliff used here is a commonly applied assumption, not something confirmed in the current Labour Act 2074 text — Sections 52/53 read as accruing monthly from day 1 with no explicit tenure threshold found. Other sources still cite 1-year or 5-year thresholds. Verify with an accountant before finalizing a settlement for anyone close to the 1-year mark." width={340}>
                {result.vested
                  ? <span className="badge-green">Vested</span>
                  : <span className="badge-amber">Not vested ({result.serviceMonths} / 12 mo)</span>}
              </Tip>
            </div>
          </div>

          {/* Earnings table */}
          <div className="card" style={{ padding: 0, marginBottom: 12 }}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid #2a2f3d', fontWeight: 600, fontSize: 13 }}>Earnings</div>
            <table className="data-table" style={{ tableLayout: 'fixed' }}>
              <colgroup>
                <col style={{ width: '55%' }} />
                <col style={{ width: '25%' }} />
                <col style={{ width: '20%' }} />
              </colgroup>
              <thead>
                <tr>
                  <th>Component</th>
                  <th style={{ textAlign: 'right' }}>Formula</th>
                  <th style={{ textAlign: 'right' }}>Amount (NPR)</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    <Tip text="Basic salary pro-rated for days worked in the last BS month. Formula: basic ÷ total days in month × days worked." width={280}>Partial Month Salary</Tip>
                  </td>
                  <td style={{ textAlign: 'right', color: '#6b7280', fontSize: 12 }}>
                    {fmt(result.basic)} ÷ {result.totalDaysInLastMonth} × {result.daysWorked}
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmt(result.partialSalary)}</td>
                </tr>
                {parseFloat(leaveDays) > 0 && (
                  <tr>
                    <td>
                      <Tip text="Encashment of unused annual leave at the rate of basic ÷ 26 per day (Nepal Labour Act)." width={260}>Leave Encashment ({leaveDays} days)</Tip>
                    </td>
                    <td style={{ textAlign: 'right', color: '#6b7280', fontSize: 12 }}>
                      {fmt(result.basic)} ÷ 26 × {leaveDays}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmt(result.leaveEncashment)}</td>
                  </tr>
                )}
                {result.vested && result.gratuity > 0 && (
                  <tr>
                    <td>
                      <Tip text={result.gratuitySsfCovered > 0
                        ? 'Gratuity accrual (1 month basic per year of service) minus the portion already funded through the employer’s monthly SSF contribution (3.33% of capped basic goes to the SSF gratuity fund) — so it isn’t paid twice.'
                        : 'Gratuity under Nepal Labour Act: 1 month basic per year of service. Formula: basic ÷ 12 × total months of service.'} width={300}>
                        Gratuity ({fmtService(result.serviceMonths)}){result.gratuitySsfCovered > 0 ? ' — net of SSF-funded' : ''}
                      </Tip>
                    </td>
                    <td style={{ textAlign: 'right', color: '#6b7280', fontSize: 12 }}>
                      {result.gratuitySsfCovered > 0
                        ? `${fmt(result.gratuityAccrued)} − ${fmt(result.gratuitySsfCovered)} (SSF)`
                        : `${fmt(result.basic)} ÷ 12 × ${result.serviceMonths}`}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmt(result.gratuity)}</td>
                  </tr>
                )}
                {result.festivalPro > 0 && (
                  <tr>
                    <td>
                      <Tip text="Pro-rated festival (Dashain) allowance for months worked since Shrawan of this fiscal year, since full allowance has not yet been paid." width={300}>Festival Pro-ration ({result.fyStart})</Tip>
                    </td>
                    <td style={{ textAlign: 'right', color: '#6b7280', fontSize: 12 }}>
                      {fmt(result.basic)} × {result.lumpSum > 0 ? Math.round((result.festivalPro / result.basic) * 100) / 100 : '—'}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmt(result.festivalPro)}</td>
                  </tr>
                )}
              </tbody>
              <tfoot>
                <tr style={{ fontWeight: 700, borderTop: '2px solid #2a2f3d' }}>
                  <td>Gross Payout</td>
                  <td></td>
                  <td style={{ textAlign: 'right', fontSize: 15, color: '#34d399' }}>{fmt(result.grossPayout)}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Deductions table */}
          {result.totalDeductions > 0 && (
            <div className="card" style={{ padding: 0, marginBottom: 12 }}>
              <div style={{ padding: '12px 16px', borderBottom: '1px solid #2a2f3d', fontWeight: 600, fontSize: 13 }}>Deductions</div>
              <table className="data-table" style={{ tableLayout: 'fixed' }}>
                <colgroup>
                  <col style={{ width: '55%' }} />
                  <col style={{ width: '25%' }} />
                  <col style={{ width: '20%' }} />
                </colgroup>
                <thead>
                  <tr>
                    <th>Component</th>
                    <th style={{ textAlign: 'right' }}>Formula</th>
                    <th style={{ textAlign: 'right' }}>Amount (NPR)</th>
                  </tr>
                </thead>
                <tbody>
                  {!noticeServed && result.noticeDeduction > 0 && (
                    <tr>
                      <td>
                        <Tip text="Pay in lieu of notice: deducted when the employee does not serve the required notice period. Rate: basic ÷ 26 per day." width={280}>Notice Pay Deduction ({noticeDays} days unserved)</Tip>
                      </td>
                      <td style={{ textAlign: 'right', color: '#6b7280', fontSize: 12 }}>
                        {fmt(result.basic)} ÷ 26 × {noticeDays}
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 600, color: '#f87171' }}>{fmt(result.noticeDeduction)}</td>
                    </tr>
                  )}
                  {result.lumpTds > 0 && (
                    <tr>
                      <td>
                        <Tip text="TDS on lump-sum components (gratuity + leave encashment + festival pro-ration) computed at the marginal income tax rate using the incremental method." width={300}>TDS on Lump Sum</Tip>
                      </td>
                      <td style={{ textAlign: 'right', color: '#6b7280', fontSize: 12 }}>Marginal rate on NPR {fmt(result.lumpSum)}</td>
                      <td style={{ textAlign: 'right', fontWeight: 600, color: '#f87171' }}>{fmt(result.lumpTds)}</td>
                    </tr>
                  )}
                  {advances.map(adv => (
                    <tr key={adv.id}>
                      <td>
                        <Tip text={`Advance issued on ${adv.issued_date || '—'}. Outstanding balance (amount minus repayments recorded in Advances & Loans) recovered from final pay.`} width={270}>
                          Advance Recovery — {adv.purpose || 'Advance'}
                        </Tip>
                      </td>
                      <td style={{ textAlign: 'right', color: '#6b7280', fontSize: 12 }}>{fmt(adv.amount)} − repaid</td>
                      <td style={{ textAlign: 'right', fontWeight: 600, color: '#f87171' }}>{fmt(adv.outstanding)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr style={{ fontWeight: 700, borderTop: '2px solid #2a2f3d' }}>
                    <td>Total Deductions</td>
                    <td></td>
                    <td style={{ textAlign: 'right', fontSize: 15, color: '#f87171' }}>{fmt(result.totalDeductions)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          {/* Net payout */}
          <div className="card" style={{ padding: '18px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>NET SETTLEMENT AMOUNT</div>
              <div style={{ fontSize: 11, color: '#4b5563' }}>Gross NPR {fmt(result.grossPayout)} − Deductions NPR {fmt(result.totalDeductions)}</div>
            </div>
            <div style={{ fontSize: 28, fontWeight: 800, color: result.netPayout >= 0 ? '#34d399' : '#f87171' }}>
              NPR {fmt(Math.abs(result.netPayout))}
              {result.netPayout < 0 && <span style={{ fontSize: 13, marginLeft: 8, color: '#f87171' }}>(recoverable)</span>}
            </div>
          </div>

          <div style={{ marginTop: 12, fontSize: 11, color: '#4b5563', lineHeight: 1.7 }} className="no-print">
            <strong style={{ color: '#6b7280' }}>Notes:</strong>
            {' '}Partial salary uses BS month day count ({result.totalDaysInLastMonth} days for {BS_MONTH_NAMES[lastDate.month-1]} {lastDate.year}).
            {' '}Leave encashment at basic ÷ 26 per day (Nepal Labour Act).
            {' '}TDS on lump sum is estimated at the marginal rate — final tax liability depends on total annual income for the year.
            {!result.vested && ' Gratuity is not included as service is under 1 year (this 1-year threshold is a common assumption, not confirmed in the current Labour Act text — verify with an accountant if this employee is close to the boundary).'}
            {result.gratuitySsfCovered > 0 && ' Gratuity is shown net of the portion already funded through employer SSF contributions.'}
            {' '}Consult your CA before disbursing.
          </div>
        </div>
      )}
    </div>
  )
}
