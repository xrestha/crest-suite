import { useState, useEffect, Fragment } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import Tip from '../../../components/Tip'
import { BS_MONTHS, daysInBsMonth } from '../../../utils/bsCalendar'
import { computePayslip, calcAmount } from './payrollCompute'
import { computeMonthlyTdsBreakdown } from './tds'
import { fetchYtdMap, fetchApprovedTadaMap, buildAdvanceMap } from './payrollData'
import { ATTENDANCE_STATUSES, OT_MULTIPLIER } from '../payrollConstants'
import { printWithTitle } from '../../../utils/printTitle'

const fmt = n => Math.round(n || 0).toLocaleString('en-NP')

function Section({ title, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--theme-accent)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>{title}</div>
      {children}
    </div>
  )
}

// No Tip/hover here on purpose — this panel is also what gets printed, and a hover tooltip
// never renders on paper. Any number that needs explaining gets its own visible row instead
// (an `op` operator prefix like "×"/"÷"/"+" reads as a step in a running calculation) or a
// small always-visible `hint` caption underneath.
function Line({ label, value, op, hint, strong, color }) {
  return (
    <div style={{ padding: '3px 0', borderBottom: '1px dotted var(--theme-border-lt)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12.5 }}>
        <span style={{ color: 'var(--theme-text2)' }}>{op ? `${op} ${label}` : label}</span>
        <span style={{ color: color || 'var(--theme-text1)', fontWeight: strong ? 700 : 400, whiteSpace: 'nowrap' }}>{value}</span>
      </div>
      {hint && <div style={{ fontSize: 10, color: 'var(--theme-text3)' }}>{hint}</div>}
    </div>
  )
}

function CalcDetail({ row, monthDays, advances }) {
  const { emp, comps, slip, tdsBreakdown, advDed, tada, tadaAmount, netPay } = row
  const b = slip.breakdown
  const t = b.tally
  const empAdvances = advances.filter(a => a.employee_id === emp.id && a.status === 'active')
  const fyLabel = `${tdsBreakdown.fyStart % 100}/${(tdsBreakdown.fyStart + 1) % 100}`
  const earningComps = comps.filter(c => c.type === 'earning')

  return (
    <div style={{ padding: '18px 22px', background: 'var(--theme-bg)', borderTop: '1px solid var(--theme-border)', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 36px' }}>
      <div>
        <Section title="Attendance Tally">
          {ATTENDANCE_STATUSES.map(s => (
            <Line key={s.key} label={s.label} value={t[s.key] || 0} />
          ))}
          <Line label="Hours Worked" value={(t.sumHours || 0).toFixed(1)} />
        </Section>

        {b.basis === 'monthly' && (
          <Section title="Gross Salary">
            <Line label="Basic Salary" value={`NPR ${fmt(emp.basic_salary)}`} />
            {earningComps.map(c => (
              <Line key={c.id} label={c.name || 'Allowance'} op="+" value={`NPR ${fmt(calcAmount(c, emp.basic_salary))}`} />
            ))}
            <Line label="Gross" op="=" value={`NPR ${fmt(slip.gross)}`} strong color="var(--theme-accent)" />
          </Section>
        )}
        {b.basis === 'daily' && (
          <Section title="Gross (Daily)">
            <Line label="Present Days" value={t.present || 0} />
            <Line label="Half-day × 0.5" op="+" value={((t.half_day || 0) * 0.5).toFixed(2)} />
            <Line label="Paid Leave Days" op="+" value={t.paid_leave || 0} />
            <Line label="Half-day Paid Leave × 0.5" op="+" value={((t.half_paid_leave || 0) * 0.5).toFixed(2)} />
            <Line label="Worked Days" op="=" value={`${b.workedDays.toFixed(2)} days`} strong />
            <Line label="Daily Rate" value={`NPR ${fmt(b.dailyRate)}`} />
            <Line label="Worked Days" op="×" value={`${b.workedDays.toFixed(2)} days`} />
            <Line label="Gross" op="=" value={`NPR ${fmt(slip.gross)}`} strong color="var(--theme-accent)" />
          </Section>
        )}
        {b.basis === 'hourly' && (
          <Section title="Gross (Hourly)">
            <Line label="Hours Worked" value={(t.sumHours || 0).toFixed(2)} />
            <Line label="Paid Leave × 8h" op="+" value={((t.paid_leave || 0) * 8).toFixed(2)} />
            <Line label="Half-day Paid Leave × 4h" op="+" value={((t.half_paid_leave || 0) * 4).toFixed(2)} />
            <Line label="Paid Hours" op="=" value={`${b.paidHours.toFixed(2)} hrs`} strong />
            <Line label="Hourly Rate" value={`NPR ${fmt(b.hourlyRate)}`} />
            <Line label="Paid Hours" op="×" value={`${b.paidHours.toFixed(2)} hrs`} />
            <Line label="Gross" op="=" value={`NPR ${fmt(slip.gross)}`} strong color="var(--theme-accent)" />
          </Section>
        )}

        {b.basis === 'monthly' && (
          <Section title="Absence Deduction">
            <Line label="Absent Days" value={t.absent || 0} />
            <Line label="Unpaid Leave Days" op="+" value={t.unpaid_leave || 0} />
            <Line label="Half-day × 0.5" op="+" value={((t.half_day || 0) * 0.5).toFixed(2)} />
            <Line label="Half-day Unpaid Leave × 0.5" op="+" value={((t.half_unpaid_leave || 0) * 0.5).toFixed(2)} />
            <Line label="Unpaid Days" op="=" value={`${b.unpaidDays.toFixed(2)} days`} strong />
            <Line label="Gross" value={`NPR ${fmt(b.gross)}`} />
            <Line label="Days in Month" op="÷" value={monthDays} />
            <Line label="Per-Day Rate" op="=" value={`NPR ${fmt(b.perDay)}`} strong />
            <Line label="Per-Day Rate" value={`NPR ${fmt(b.perDay)}`} />
            <Line label="Unpaid Days" op="×" value={`${b.unpaidDays.toFixed(2)} days`} />
            <Line label="Absence Deduction" op="=" value={`− NPR ${fmt(slip.absence_deduction)}`} strong color="var(--theme-red)" />
          </Section>
        )}

        <Section title="Overtime — Attendance Sheet">
          <Line label="Attendance OT Hours" value={`${(b.otAttendanceHrs || 0).toFixed(1)}h`} />
          <Line label="Hourly Rate" op="×" value={`NPR ${fmt(b.hourlyRate)}`} />
          <Line label="OT Multiplier" op="×" value={`${OT_MULTIPLIER}×`} />
          <Line label="Attendance OT Amount" op="=" value={`NPR ${fmt(b.otAttendanceAmt)}`} strong color="var(--theme-green)" />
        </Section>

        <Section title="Overtime — Approved Entries (Overtime module)">
          <Line label="Approved OT Hours" value={`${(b.otApprovedHrs || 0).toFixed(1)}h`} hint="From the Overtime module's approval workflow — a separate source from the Attendance sheet's OT column." />
          <Line label="Approved OT Amount" op="=" value={`NPR ${fmt(b.otApprovedAmt)}`} strong color="var(--theme-green)" />
          {b.otDoubleCountRisk && (
            <div style={{ fontSize: 11, color: 'var(--theme-amber)', marginTop: 4 }}>
              ⚠ Both sources have hours this period — the same OT may be paid twice. Zero out one source.
            </div>
          )}
          <Line label="Total OT (both sources)" value={`${((b.otAttendanceHrs || 0) + (b.otApprovedHrs || 0)).toFixed(1)}h → NPR ${fmt(slip.ot_amount)}`} strong color="var(--theme-green)" />
        </Section>
      </div>

      <div>
        {!!emp.ssf_enrolled && (
          <Section title="SSF">
            {b.basis === 'monthly' && (
              <>
                <Line label="Basic Salary" value={`NPR ${fmt(emp.basic_salary)}`} />
                <Line label="Paid Fraction" op="×" value={`${(b.paidFraction * 100).toFixed(1)}%`} hint="1 − (Unpaid Days ÷ Days in Month)" />
              </>
            )}
            <Line label="SSF Base" op={b.basis === 'monthly' ? '=' : undefined} value={`NPR ${fmt(b.ssfBase)}`} hint="Capped at NPR 100,000" />
            <Line label="Employee Rate" op="×" value="11%" />
            <Line label="Employee SSF" op="=" value={`− NPR ${fmt(slip.ssf_employee)}`} strong color="var(--theme-red)" />
            <Line label="Employer SSF (20%)" value={`NPR ${fmt(slip.ssf_employer)}`} color="var(--theme-text2)" />
          </Section>
        )}

        <Section title={`TDS — FY ${fyLabel}, month ${tdsBreakdown.monthInFy} of 12`}>
          <Line label="YTD Gross (prior finalized months)" value={`NPR ${fmt(tdsBreakdown.ytdGross)}`} />
          <Line label="This Month's Gross" op="+" value={`NPR ${fmt(slip.gross)} × ${tdsBreakdown.monthsAtCurrent} remaining month(s)`} />
          <Line label="Projected Annual Gross" op="=" value={`NPR ${fmt(tdsBreakdown.annualGross)}`} strong />
          <Line label="SSF Deduction" op="−" value={`NPR ${fmt(tdsBreakdown.ssfDeduction)}`} />
          <Line label="Insurance Deduction" op="−" value={`NPR ${fmt(tdsBreakdown.insuranceDeduction)}`} />
          <Line label="Annual Taxable" op="=" value={`NPR ${fmt(tdsBreakdown.annualTaxable)}`} strong />
          <Line label="Annual Tax (FY slabs)" value={`NPR ${fmt(tdsBreakdown.annualTax)}`} />
          <Line label="Cumulative Due" value={`NPR ${fmt(tdsBreakdown.cumulativeDue)}`} hint={`Annual Tax ÷ 12 × month ${tdsBreakdown.monthInFy}`} />
          <Line label="Already Withheld YTD" op="−" value={`NPR ${fmt(tdsBreakdown.ytdWithheld)}`} />
          <Line label="This Month's TDS" op="=" value={`− NPR ${fmt(tdsBreakdown.tds)}`} strong color="var(--theme-red)" />
        </Section>

        <Section title="Advance & TADA">
          <Line label="Active Advances" value={empAdvances.length} />
          <Line label="Advance Deduction" value={`− NPR ${fmt(advDed)}`} color="var(--theme-red)" />
          <Line label="Approved TADA Claims" value={tada.ids.length} />
          <Line label="TADA Reimbursement" value={`+ NPR ${fmt(tadaAmount)}`} color="var(--theme-green)" />
        </Section>

        <Section title="Net Pay">
          <Line label="Gross" value={`NPR ${fmt(slip.gross)}`} />
          <Line label="OT" op="+" value={`NPR ${fmt(slip.ot_amount)}`} color="var(--theme-green)" />
          <Line label="Absence" op="−" value={`NPR ${fmt(slip.absence_deduction)}`} color="var(--theme-red)" />
          <Line label="SSF" op="−" value={`NPR ${fmt(slip.ssf_employee)}`} color="var(--theme-red)" />
          <Line label="Other Deductions" op="−" value={`NPR ${fmt(slip.other_deductions)}`} color="var(--theme-red)" />
          <Line label="TDS" op="−" value={`NPR ${fmt(tdsBreakdown.tds)}`} color="var(--theme-red)" />
          <Line label="Advance" op="−" value={`NPR ${fmt(advDed)}`} color="var(--theme-red)" />
          <Line label="TADA" op="+" value={`NPR ${fmt(tadaAmount)}`} color="var(--theme-green)" />
          <Line label="Net Pay" op="=" value={`NPR ${fmt(netPay)}`} strong color="var(--theme-accent)" />
        </Section>
      </div>
    </div>
  )
}

export default function PayrollCalculation() {
  const { clientId } = useAuth()
  const { scopedFrom } = useScopedDb()
  const [periods,    setPeriods]    = useState([])
  const [period,     setPeriod]     = useState(null)
  const [employees,  setEmployees]  = useState([])
  const [components, setComponents] = useState([])
  const [attendance, setAttendance] = useState([])
  const [otEntries,  setOtEntries]  = useState([])
  const [advances,   setAdvances]   = useState([])
  const [repayments, setRepayments] = useState([])
  const [ytdMap,     setYtdMap]     = useState({})
  const [tadaMap,    setTadaMap]    = useState({})
  const [run,        setRun]        = useState(null)
  const [payslips,   setPayslips]   = useState([])
  const [loading,    setLoading]    = useState(true)
  const [expandedId, setExpandedId] = useState(null)
  const [printRow,   setPrintRow]   = useState(null)

  useEffect(() => {
    if (!clientId) return
    async function init() {
      setLoading(true)
      const { data: p } = await scopedFrom('monthly_periods')
        .order('bs_year', { ascending: false }).order('bs_month', { ascending: false })
      setPeriods(p || [])
      const open = (p || []).find(x => x.status === 'open') || (p || [])[0]
      if (open) { setPeriod(open); await loadAll(open) }
      setLoading(false)
    }
    init()
  }, [clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Read-only — this page never writes to hr_payroll_runs/hr_payslips. Every number below is
  // live-computed from CURRENT Attendance/Roster/Overtime/Advances data via the exact same
  // computePayslip()/computeMonthlyTdsBreakdown() functions Payroll Run itself uses, so it always
  // reflects what Payroll SHOULD show right now — including if something changed since the last
  // Generate/Regenerate and the stored Payroll snapshot has gone stale (flagged per row below).
  async function loadAll(p) {
    const [
      { data: emps }, { data: comps }, { data: att }, { data: ot },
      { data: advs }, { data: reps }, { data: runRow },
    ] = await Promise.all([
      scopedFrom('hr_employees', 'id, full_name, employee_code, pay_basis, basic_salary, ssf_no, ssf_enrolled, life_insurance_premium, health_insurance_premium, marital_status, department, status')
        .in('status', ['active', 'probation']).order('full_name'),
      scopedFrom('hr_salary_components'),
      scopedFrom('hr_attendance').eq('period_id', p.id),
      scopedFrom('hr_overtime_entries', 'employee_id, ot_hours, ot_type')
        .eq('bs_year', p.bs_year).eq('bs_month', p.bs_month).eq('status', 'approved'),
      scopedFrom('hr_advances').order('issued_date'),
      scopedFrom('hr_advance_repayments'),
      scopedFrom('hr_payroll_runs').eq('period_id', p.id).maybeSingle(),
    ])
    setEmployees(emps || [])
    setComponents(comps || [])
    setAttendance(att || [])
    setOtEntries(ot || [])
    setAdvances(advs || [])
    setRepayments(reps || [])
    setRun(runRow || null)
    if (runRow) {
      const { data: slips } = await scopedFrom('hr_payslips').eq('run_id', runRow.id)
      setPayslips(slips || [])
    } else {
      setPayslips([])
    }
    const [ytd, tada] = await Promise.all([fetchYtdMap(scopedFrom, p), fetchApprovedTadaMap(scopedFrom, p)])
    setYtdMap(ytd)
    setTadaMap(tada)
  }

  async function handlePeriodChange(id) {
    const p = periods.find(x => x.id === id); if (!p) return
    setPeriod(p); setExpandedId(null); setLoading(true)
    await loadAll(p); setLoading(false)
  }

  const periodLabel = period ? `${BS_MONTHS[period.bs_month - 1]} ${period.bs_year}` : '—'
  const monthDays = period ? daysInBsMonth(period.bs_year, period.bs_month) : 0
  const advMap = buildAdvanceMap(advances, repayments)
  const payslipByEmp = Object.fromEntries(payslips.map(s => [s.employee_id, s]))

  const rows = period ? employees.map(emp => {
    const comps        = components.filter(c => c.employee_id === emp.id)
    const att           = attendance.filter(a => a.employee_id === emp.id)
    const empOtEntries = otEntries.filter(e => e.employee_id === emp.id)
    const advDed        = Math.round(advMap[emp.id] || 0)
    const slip           = computePayslip(emp, comps, att, period, 0, empOtEntries, advDed)
    const ytd             = ytdMap[emp.id] || { gross: 0, ssf: 0, withheld: 0 }
    const tdsBreakdown = computeMonthlyTdsBreakdown({
      period,
      monthlyGross: slip.gross,
      monthlySsf:   slip.ssf_employee,
      ytdGross:     ytd.gross,
      ytdSsf:       ytd.ssf,
      ytdWithheld:  ytd.withheld,
      isSsf:        !!emp.ssf_enrolled,
      isMarried:    emp.marital_status === 'married',
      annualLifeInsurance:   parseFloat(emp.life_insurance_premium) || 0,
      annualHealthInsurance: parseFloat(emp.health_insurance_premium) || 0,
    })
    const tada = tadaMap[emp.id] || { total: 0, ids: [] }
    const tadaAmount = Math.round(tada.total)
    const netPay = slip.net_pay - tdsBreakdown.tds + tadaAmount
    const stored = payslipByEmp[emp.id]
    const stale = stored && Math.round(stored.net_pay) !== Math.round(netPay)
    return { emp, comps, slip, tdsBreakdown, advDed, tada, tadaAmount, netPay, stored, stale }
  }) : []

  const flaggedCount = rows.filter(r => r.slip.breakdown.otDoubleCountRisk || r.stale).length
  const totalGross = rows.reduce((s, r) => s + r.slip.gross, 0)
  const totalNet   = rows.reduce((s, r) => s + r.netPay, 0)
  const runStatusLabel = !run ? 'No Payroll run yet' : run.status === 'finalized' ? 'Finalized' : (flaggedCount > 0 ? `Draft — review before finalizing` : 'Draft — matches this calculation')

  function handlePrint(row) {
    setPrintRow(row)
    setTimeout(() => { printWithTitle(`Payroll Calculation - ${row.emp.full_name} - ${periodLabel}`); setPrintRow(null) }, 60)
  }

  return (
    <div>
      <div className={printRow ? 'no-print' : ''}>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">Payroll Calculation</h1>
          <p className="page-subtitle">Verify the numbers behind Payroll, one employee at a time — {periodLabel}</p>
        </div>
        <select className="form-select" value={period?.id || ''} onChange={e => handlePeriodChange(e.target.value)}>
          {periods.map(p => <option key={p.id} value={p.id}>{BS_MONTHS[p.bs_month - 1]} {p.bs_year} {p.status === 'open' ? '(open)' : ''}</option>)}
        </select>
      </div>

      <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginBottom: 16, lineHeight: 1.6 }}>
        Every number here is computed live from current Attendance, Roster, Overtime and Advances data — the same functions Payroll Run uses. It never writes anything; use it to check the math (or find out whether the actual Payroll page has gone stale) before you Generate/Regenerate/Finalize.
      </div>

      {loading ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text2)' }}>Loading…</div>
      ) : employees.length === 0 ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text2)' }}>No active employees. Add employees in HR → Employees first.</div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
            {[
              { label: 'Total Gross',       value: `NPR ${fmt(totalGross)}`, color: 'var(--theme-accent)', tip: 'Sum of live-computed gross across all employees this period.' },
              { label: 'Total Net Pay',     value: `NPR ${fmt(totalNet)}`,   color: 'var(--theme-green)',  tip: 'Sum of live-computed net pay — compare against Payroll Run\'s Net Payable.' },
              { label: 'Flagged for Review', value: flaggedCount, color: flaggedCount > 0 ? 'var(--theme-amber)' : 'var(--theme-text2)', tip: 'Employees with an OT-in-two-places risk, or whose stored Payroll payslip no longer matches this live calculation.' },
              { label: 'Payroll Run Status', value: runStatusLabel, color: 'var(--theme-text1)', tip: 'Whether a Payroll run exists for this period, and whether it still matches what\'s computed here.' },
            ].map(s => (
              <div key={s.label} className="card" style={{ padding: '16px 18px' }}>
                <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                  <Tip text={s.tip} width={260}>{s.label}</Tip>
                </div>
                <div style={{ fontSize: 17, fontWeight: 700, color: s.color }}>{s.value}</div>
              </div>
            ))}
          </div>

          <div className="card" style={{ padding: 0 }}>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th style={{ width: 32 }} />
                    <th>Employee</th>
                    <th style={{ textAlign: 'right' }}>Gross</th>
                    <th style={{ textAlign: 'right' }}>OT</th>
                    <th style={{ textAlign: 'right' }}>Absence</th>
                    <th style={{ textAlign: 'right' }}>SSF</th>
                    <th style={{ textAlign: 'right' }}>TDS</th>
                    <th style={{ textAlign: 'right' }}>Advance</th>
                    <th style={{ textAlign: 'right' }}>TADA</th>
                    <th style={{ textAlign: 'right', color: 'var(--theme-accent)' }}>Net Pay (live)</th>
                    <th>Payroll Page</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(row => {
                    const { emp, slip, tdsBreakdown, advDed, tadaAmount, netPay, stored, stale } = row
                    const expanded = expandedId === emp.id
                    return (
                      <Fragment key={emp.id}>
                        <tr style={{ cursor: 'pointer' }} onClick={() => setExpandedId(expanded ? null : emp.id)}>
                          <td style={{ color: 'var(--theme-text3)', textAlign: 'center' }}>{expanded ? '▾' : '▸'}</td>
                          <td>
                            <div style={{ fontWeight: 600, color: 'var(--theme-text1)', fontSize: 13 }}>{emp.full_name}</div>
                            <div style={{ display: 'flex', gap: 6, marginTop: 2, alignItems: 'center' }}>
                              {emp.employee_code && <span style={{ fontSize: 10, color: 'var(--theme-text2)' }}>{emp.employee_code}</span>}
                              {slip.breakdown.otDoubleCountRisk && (
                                <Tip text="OT recorded in TWO places for this employee — attendance sheet AND approved Overtime entries. Both are paid." width={280}>
                                  <span style={{ fontSize: 10, fontWeight: 700, color: '#f59e0b', background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.3)', borderRadius: 8, padding: '1px 6px', cursor: 'help' }}>⚠ OT ×2?</span>
                                </Tip>
                              )}
                              {stale && (
                                <Tip text={`Payroll's stored net pay (NPR ${fmt(stored.net_pay)}) no longer matches this live calculation (NPR ${fmt(netPay)}) — something changed since the run was last Generated/Regenerated.`} width={290}>
                                  <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--theme-red)', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 8, padding: '1px 6px', cursor: 'help' }}>⚠ Stale</span>
                                </Tip>
                              )}
                            </div>
                          </td>
                          <td style={{ textAlign: 'right' }}>{fmt(slip.gross)}</td>
                          <td style={{ textAlign: 'right', color: slip.ot_amount > 0 ? 'var(--theme-green)' : 'var(--theme-text2)' }}>{slip.ot_amount > 0 ? `+${fmt(slip.ot_amount)}` : '—'}</td>
                          <td style={{ textAlign: 'right', color: slip.absence_deduction > 0 ? 'var(--theme-red)' : 'var(--theme-text2)' }}>{slip.absence_deduction > 0 ? `−${fmt(slip.absence_deduction)}` : '—'}</td>
                          <td style={{ textAlign: 'right', color: slip.ssf_employee > 0 ? 'var(--theme-red)' : 'var(--theme-text2)' }}>{slip.ssf_employee > 0 ? `−${fmt(slip.ssf_employee)}` : '—'}</td>
                          <td style={{ textAlign: 'right', color: tdsBreakdown.tds > 0 ? 'var(--theme-red)' : 'var(--theme-text2)' }}>{tdsBreakdown.tds > 0 ? `−${fmt(tdsBreakdown.tds)}` : '—'}</td>
                          <td style={{ textAlign: 'right', color: advDed > 0 ? '#fb923c' : 'var(--theme-text2)' }}>{advDed > 0 ? `−${fmt(advDed)}` : '—'}</td>
                          <td style={{ textAlign: 'right', color: tadaAmount > 0 ? 'var(--theme-green)' : 'var(--theme-text2)' }}>{tadaAmount > 0 ? `+${fmt(tadaAmount)}` : '—'}</td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-accent)', fontWeight: 700 }}>{fmt(netPay)}</td>
                          <td style={{ fontSize: 11, color: stored ? 'var(--theme-text2)' : 'var(--theme-text3)' }}>{stored ? `NPR ${fmt(stored.net_pay)}` : 'not generated'}</td>
                        </tr>
                        {expanded && (
                          <tr>
                            <td colSpan={10} style={{ padding: 0 }}>
                              <div style={{ padding: '10px 22px 0', background: 'var(--theme-bg)', borderTop: '1px solid var(--theme-border)', display: 'flex', justifyContent: 'flex-end' }}>
                                <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => handlePrint(row)}>🖨 Print</button>
                              </div>
                              <CalcDetail row={row} monthDays={monthDays} advances={advances} />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
      </div>

      {printRow && (
        <div className="print-only">
          <h1 style={{ fontSize: 20, marginBottom: 2 }}>Payroll Calculation</h1>
          <div style={{ fontSize: 13, marginBottom: 2 }}>{printRow.emp.full_name}{printRow.emp.employee_code ? ` (${printRow.emp.employee_code})` : ''}</div>
          <div style={{ fontSize: 12, color: '#555', marginBottom: 14 }}>{periodLabel} — generated {new Date().toLocaleDateString('en-NP')}</div>
          <CalcDetail row={printRow} monthDays={monthDays} advances={advances} />
        </div>
      )}
    </div>
  )
}
