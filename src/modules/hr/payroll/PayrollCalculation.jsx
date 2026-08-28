import { useState, useEffect, Fragment } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import Tip from '../../../components/Tip'
import { BS_MONTHS, daysInBsMonth } from '../../../utils/bsCalendar'
import { computePayslip, calcAmount } from './payrollCompute'
import { computeMonthlyTdsBreakdown } from './tds'
import { fetchYtdMap, fetchApprovedTadaMap, buildAdvanceMap, payslipDrift } from './payrollData'
import { ATTENDANCE_STATUSES, OT_MULTIPLIER } from '../payrollConstants'
import { printWithTitle } from '../../../utils/printTitle'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'
import { firstError } from '../../../shared/queryError'
import ReportLoadError from '../../../components/ReportLoadError'

const fmt = n => Math.round(n || 0).toLocaleString('en-NP')

function Section({ title, children }) {
  return (
    <div className="calc-section" style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--theme-accent-ink)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>{title}</div>
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
    <div className="calc-line" style={{ padding: '3px 0', borderBottom: '1px dotted var(--theme-border-lt)' }}>
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
    <div className="calc-detail-grid" style={{ padding: '18px 22px', background: 'var(--theme-bg)', borderTop: '1px solid var(--theme-border)', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 36px' }}>
      <div>
        <Section title="Attendance Tally">
          {ATTENDANCE_STATUSES.map(s => (
            <Line key={s.key} label={s.label} value={t[s.key] || 0} />
          ))}
          <Line label="Total Days" value={ATTENDANCE_STATUSES.reduce((sum, s) => sum + (t[s.key] || 0), 0)} strong />
          <Line label="Hours Worked" value={(t.sumHours || 0).toFixed(1)} />
        </Section>

        {b.basis === 'monthly' && (
          <Section title="Gross Salary">
            <Line label="Basic Salary" value={`NPR ${fmt(emp.basic_salary)}`} />
            {earningComps.map(c => (
              <Line key={c.id} label={c.name || 'Allowance'} op="+" value={`NPR ${fmt(calcAmount(c, emp.basic_salary))}`} />
            ))}
            <Line label="Gross" op="=" value={`NPR ${fmt(slip.gross)}`} strong color="var(--theme-accent-ink)" />
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
            <Line label="Gross" op="=" value={`NPR ${fmt(slip.gross)}`} strong color="var(--theme-accent-ink)" />
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
            <Line label="Gross" op="=" value={`NPR ${fmt(slip.gross)}`} strong color="var(--theme-accent-ink)" />
          </Section>
        )}

        {b.basis === 'monthly' && (
          <Section title="Absence Deduction">
            <Line label="Absent Days" value={t.absent || 0} />
            <Line label="Unpaid Leave Days" op="+" value={t.unpaid_leave || 0} />
            <Line label="Half-day × 0.5" op="+" value={((t.half_day || 0) * 0.5).toFixed(2)} />
            <Line label="Half-day Unpaid Leave × 0.5" op="+" value={((t.half_unpaid_leave || 0) * 0.5).toFixed(2)} />
            {b.preJoinDays > 0 && <Line label="Not Yet Joined Days" op="+" value={b.preJoinDays} hint="Days this period before the employee's join date" />}
            <Line label="Unpaid Days" op="=" value={`${b.unpaidDays.toFixed(2)} days`} strong />
            <Line label="Gross" value={`NPR ${fmt(b.gross)}`} />
            <Line label="Days in Month" op="÷" value={monthDays} />
            <Line label="Per-Day Rate" op="=" value={`NPR ${fmt(b.perDay)}`} strong />
            <Line label="Per-Day Rate" value={`NPR ${fmt(b.perDay)}`} />
            <Line label="Unpaid Days" op="×" value={`${b.unpaidDays.toFixed(2)} days`} />
            <Line label="Absence Deduction" op="=" value={`− NPR ${fmt(slip.absence_deduction)}`} strong color="var(--theme-red-text)" />
          </Section>
        )}

        <Section title="Overtime — Attendance Sheet">
          <Line label="Attendance OT Hours (paid)" value={`${(b.otAttendanceHrs || 0).toFixed(1)}h`} />
          {(b.otSupersededHrs || 0) > 0 && (
            <Line
              label="Not paid — superseded"
              value={`${b.otSupersededHrs.toFixed(1)}h`}
              hint="Typed on the attendance sheet for days that also have an approved Overtime entry. The approved entry is what gets paid for those days, so these hours are excluded rather than added."
            />
          )}
          <Line label="Hourly Rate" op="×" value={`NPR ${fmt(b.hourlyRate)}`} />
          <Line label="OT Multiplier" op="×" value={`${OT_MULTIPLIER}×`} />
          <Line label="Attendance OT Amount" op="=" value={`NPR ${fmt(b.otAttendanceAmt)}`} strong color="var(--theme-green-text)" />
        </Section>

        <Section title="Overtime — Approved Entries (Overtime module)">
          <Line label="Approved OT Hours" value={`${(b.otApprovedHrs || 0).toFixed(1)}h`} hint="From the Overtime module's approval workflow. Where a day appears in both places this is the figure that gets paid, and it is the only route to the holiday 2× rate." />
          <Line label="Approved OT Amount" op="=" value={`NPR ${fmt(b.otApprovedAmt)}`} strong color="var(--theme-green-text)" />
          <Line label="Total OT paid" value={`${((b.otAttendanceHrs || 0) + (b.otApprovedHrs || 0)).toFixed(1)}h → NPR ${fmt(slip.ot_amount)}`} strong color="var(--theme-green-text)" />
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
            <Line label="Employee SSF" op="=" value={`− NPR ${fmt(slip.ssf_employee)}`} strong color="var(--theme-red-text)" />
            <Line label="Employer SSF (20%)" value={`NPR ${fmt(slip.ssf_employer)}`} color="var(--theme-text2)" />
          </Section>
        )}

        <Section title={`TDS — FY ${fyLabel}, month ${tdsBreakdown.monthInFy} of 12`}>
          <Line label="Gross" value={`NPR ${fmt(slip.gross)}`} />
          <Line label="Overtime" op="+" value={`NPR ${fmt(slip.ot_amount)}`} hint="OT pay is taxable remuneration too" />
          <Line label="Absence Deduction" op="−" value={`NPR ${fmt(slip.absence_deduction)}`} hint="TDS is withheld on income actually paid, not contractual salary" />
          <Line label="This Month's Actual Gross" op="=" value={`NPR ${fmt(slip.gross + slip.ot_amount - slip.absence_deduction)}`} strong />
          <Line label="YTD Gross (prior finalized months)" value={`NPR ${fmt(tdsBreakdown.ytdGross)}`} />
          <Line label="This Month's Actual Gross" op="+" value={`NPR ${fmt(slip.gross + slip.ot_amount - slip.absence_deduction)} × ${tdsBreakdown.monthsAtCurrent} remaining month(s)`} />
          <Line label="Projected Annual Gross" op="=" value={`NPR ${fmt(tdsBreakdown.annualGross)}`} strong />
          <Line label="SSF Deduction" op="−" value={`NPR ${fmt(tdsBreakdown.ssfDeduction)}`} />
          <Line label="Insurance Deduction" op="−" value={`NPR ${fmt(tdsBreakdown.insuranceDeduction)}`} />
          <Line label="Annual Taxable" op="=" value={`NPR ${fmt(tdsBreakdown.annualTaxable)}`} strong />
          <Line label="Annual Tax (FY slabs)" value={`NPR ${fmt(tdsBreakdown.annualTax)}`} />
          <Line label="Cumulative Due" value={`NPR ${fmt(tdsBreakdown.cumulativeDue)}`} hint={`Annual Tax × month ${tdsBreakdown.monthsEmployedSoFar} of ${tdsBreakdown.monthsEmployedTotal} employed this FY`} />
          <Line label="Already Withheld YTD" op="−" value={`NPR ${fmt(tdsBreakdown.ytdWithheld)}`} />
          <Line label="This Month's TDS" op="=" value={`− NPR ${fmt(tdsBreakdown.tds)}`} strong color="var(--theme-red-text)" />
        </Section>

        <Section title="Advance & TADA">
          <Line label="Active Advances" value={empAdvances.length} />
          <Line label="Advance Deduction" value={`− NPR ${fmt(advDed)}`} color="var(--theme-red-text)" />
          <Line label="Approved TADA Claims" value={tada.ids.length} />
          <Line label="TADA Reimbursement" value={`+ NPR ${fmt(tadaAmount)}`} color="var(--theme-green-text)" />
        </Section>

        <Section title="Net Pay">
          <Line label="Gross" value={`NPR ${fmt(slip.gross)}`} />
          <Line label="OT" op="+" value={`NPR ${fmt(slip.ot_amount)}`} color="var(--theme-green-text)" />
          <Line label="Absence" op="−" value={`NPR ${fmt(slip.absence_deduction)}`} color="var(--theme-red-text)" />
          <Line label="SSF" op="−" value={`NPR ${fmt(slip.ssf_employee)}`} color="var(--theme-red-text)" />
          <Line label="Other Deductions" op="−" value={`NPR ${fmt(slip.other_deductions)}`} color="var(--theme-red-text)" />
          <Line label="TDS" op="−" value={`NPR ${fmt(tdsBreakdown.tds)}`} color="var(--theme-red-text)" />
          <Line label="Advance" op="−" value={`NPR ${fmt(advDed)}`} color="var(--theme-red-text)" />
          <Line label="TADA" op="+" value={`NPR ${fmt(tadaAmount)}`} color="var(--theme-green-text)" />
          <Line label="Net Pay" op="=" value={`NPR ${fmt(netPay)}`} strong color="var(--theme-accent-ink)" />
        </Section>
      </div>
    </div>
  )
}

export default function PayrollCalculation() {
  const { clientId, hasHrAccess } = useAuth()
  const { scopedFrom } = useScopedDb()
  const periodReq = useLatestRequest()
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
  const [loadError,  setLoadError]  = useState(null)

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
    const results = await Promise.all([
      scopedFrom('hr_employees', 'id, full_name, employee_code, pay_basis, basic_salary, ssf_no, ssf_enrolled, life_insurance_premium, health_insurance_premium, marital_status, department, status, join_date, end_date')
        .in('status', ['active', 'probation']).order('full_name'),
      scopedFrom('hr_salary_components'),
      // Paged — same reason as PayrollRun.jsx: one row per employee per day crosses the silent
      // 1000-row cap at ~34 staff, and a truncated read silently zeroes daily/hourly pay (S529).
      fetchAllRows(() => scopedFrom('hr_attendance').eq('period_id', p.id).order('id')),
      // bs_day is load-bearing, not display data: computePayslip uses it to suppress
      // attendance-sheet OT on days an approved entry already covers (approved supersedes).
      scopedFrom('hr_overtime_entries', 'employee_id, bs_day, ot_hours, ot_type')
        .eq('bs_year', p.bs_year).eq('bs_month', p.bs_month).eq('status', 'approved'),
      // Paged — same reason as PayrollRun.jsx: both are unfiltered lifetime ledgers that grow
      // without bound, and a truncated repayments read makes advances look less repaid than they
      // are, over-deducting from net pay. `.order('id')` is the unique tiebreaker (issued_date
      // is not unique).
      fetchAllRows(() => scopedFrom('hr_advances').order('issued_date').order('id')),
      fetchAllRows(() => scopedFrom('hr_advance_repayments').order('id')),
      scopedFrom('hr_payroll_runs').eq('period_id', p.id).maybeSingle(),
    ])
    if (!periodReq.isCurrent(p.id)) return   // superseded by a newer period selection
    // This page exists to be trusted against Payroll Run before someone Generates or Finalizes,
    // which makes a silently-empty read worse here than almost anywhere: it would show confident
    // live figures computed from nothing AND judge every stored payslip against them, so a real
    // run would be labelled Stale — or a genuinely stale one cleared — on the strength of a
    // failed request. Nothing is rendered until the reads are known good.
    const failed = firstError(results)
    if (failed) { setLoadError(failed); setEmployees([]); setPayslips([]); setRun(null); return }
    setLoadError(null)
    const [
      { data: emps }, { data: comps }, { data: att }, { data: ot },
      { data: advs }, { data: reps }, { data: runRow },
    ] = results
    setEmployees(emps || [])
    setComponents(comps || [])
    setAttendance(att || [])
    setOtEntries(ot || [])
    setAdvances(advs || [])
    setRepayments(reps || [])
    setRun(runRow || null)
    if (runRow) {
      const { data: slips, error: slipErr } = await scopedFrom('hr_payslips').eq('run_id', runRow.id)
      if (slipErr) { setLoadError(slipErr.message || String(slipErr)); setPayslips([]); return }
      setPayslips(slips || [])
    } else {
      setPayslips([])
    }
    const maps = await Promise.all([fetchYtdMap(scopedFrom, p), fetchApprovedTadaMap(scopedFrom, p)])
    if (!periodReq.isCurrent(p.id)) return   // superseded by a newer period selection
    // An empty YTD map is a legitimate value — the fiscal year's first month — so a failed read
    // here does not look like a failure: every employee's TDS is simply recomputed as a fresh
    // starter's, low, and then compared against the stored run, which duly reports itself stale.
    const mapsFailed = firstError(maps)
    if (mapsFailed) { setLoadError(mapsFailed); return }
    setYtdMap(maps[0].data)
    setTadaMap(maps[1].data)
  }

  async function handlePeriodChange(id) {
    periodReq.begin(id)   // claim the page before any await
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
    const ytd             = ytdMap[emp.id] || { gross: 0, ssf: 0, withheld: 0, count: 0 }
    const tdsBreakdown = computeMonthlyTdsBreakdown({
      period,
      // Actual income earned this month, not contractual gross — see the matching comment in
      // PayrollRun.jsx's buildRows (S365). Must stay identical between the two files.
      monthlyGross: slip.gross - slip.absence_deduction + slip.ot_amount,
      monthlySsf:   slip.ssf_employee,
      ytdGross:     ytd.gross,
      ytdSsf:       ytd.ssf,
      ytdWithheld:  ytd.withheld,
      ytdMonths:    ytd.count,
      // Mirrors PayrollRun's gate exactly — these two must agree or every SSF-enrolled employee
      // with a blank number shows a permanent false Stale flag against a correct payslip.
      isSsf:        !!(emp.ssf_enrolled && String(emp.ssf_no || '').trim()),
      isMarried:    emp.marital_status === 'married',
      annualLifeInsurance:   parseFloat(emp.life_insurance_premium) || 0,
      annualHealthInsurance: parseFloat(emp.health_insurance_premium) || 0,
    })
    const tada = tadaMap[emp.id] || { total: 0, ids: [] }
    const tadaAmount = Math.round(tada.total)
    const netPay = slip.net_pay - tdsBreakdown.tds + tadaAmount
    const stored = payslipByEmp[emp.id]
    // Distinct from `stale` below — a run exists but never picked up this employee at all (added
    // after the last Generate/Regenerate). Gated on `run` so "no run yet" doesn't itself flag every
    // employee as missing; that case is its own runStatusLabel branch.
    const missing = !!run && !stored
    // Same comparison Payroll Run's Finalize gate uses, from the same function, so the badge here
    // and the block there can never disagree. It used to be `stored.net_pay !== netPay`, which
    // flagged every hand-adjusted TDS/TADA as Stale — a red warning against a payslip that was
    // correct and deliberate. `live` is assembled in buildRows' exact shape.
    const live = { ...slip, tds: tdsBreakdown.tds, tada_amount: tadaAmount, tada_claim_ids: tada.ids }
    const drift = payslipDrift(stored, live)
    const stale = drift === 'moved'
    const overridden = drift === 'overridden'
    return { emp, comps, slip, tdsBreakdown, advDed, tada, tadaAmount, netPay, stored, stale, overridden, missing }
  }) : []

  // otDoubleCountRisk is gone: approved OT entries now supersede attendance-sheet OT per day
  // (S570), so two sources can no longer double-pay and there is nothing to flag. Only a genuine
  // mismatch against the stored run, or an employee missing from it, is worth counting here.
  const flaggedCount = rows.filter(r => r.stale || r.missing).length
  const totalGross = rows.reduce((s, r) => s + r.slip.gross, 0)
  const totalNet   = rows.reduce((s, r) => s + r.netPay, 0)
  const totals = rows.reduce((a, r) => {
    a.ot       += r.slip.ot_amount
    a.absence  += r.slip.absence_deduction
    a.ssf      += r.slip.ssf_employee
    a.tds      += r.tdsBreakdown.tds
    a.advance  += r.advDed
    a.tada     += r.tadaAmount
    return a
  }, { ot: 0, absence: 0, ssf: 0, tds: 0, advance: 0, tada: 0 })
  // Only meaningful if every row has a stored payslip to sum — a partial sum (some employees
  // "not generated") would silently read as a total, not a warning that the run is incomplete.
  const totalStored = rows.length > 0 && rows.every(r => r.stored)
    ? rows.reduce((s, r) => s + r.stored.net_pay, 0)
    : null
  const runStatusLabel = !run ? 'No Payroll run yet' : run.status === 'finalized' ? 'Finalized' : (flaggedCount > 0 ? `Draft — review before finalizing` : 'Draft — matches this calculation')

  function handlePrint(row) {
    setPrintRow(row)
    setTimeout(() => { printWithTitle(`Payroll Calculation - ${row.emp.full_name} - ${periodLabel}`); setPrintRow(null) }, 60)
  }

  if (!hasHrAccess('manager')) return <Navigate to="/dashboard" replace />

  return (
    <div>
      <div className={printRow ? 'no-print' : ''}>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">Payroll Calculation</h1>
          <p className="page-subtitle">Verify the numbers behind Payroll, one employee at a time — {periodLabel}</p>
        </div>
        <select aria-label="Period" className="form-select" value={period?.id || ''} onChange={e => handlePeriodChange(e.target.value)}>
          {periods.map(p => <option key={p.id} value={p.id}>{BS_MONTHS[p.bs_month - 1]} {p.bs_year} {p.status === 'open' ? '(open)' : ''}</option>)}
        </select>
      </div>

      <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginBottom: 16, lineHeight: 1.6 }}>
        Every number here is computed live from current Attendance, Roster, Overtime and Advances data — the same functions Payroll Run uses. It never writes anything; use it to check the math (or find out whether the actual Payroll page has gone stale) before you Generate/Regenerate/Finalize.
      </div>

      {loading ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text2)' }}>Loading…</div>
      ) : loadError ? (
        /* Before the "No active employees" branch, deliberately. A failed read leaves `employees`
           empty, so without this the page would tell an operator to go add employees they already
           have — and the figures above would have been computed from nothing. */
        <ReportLoadError error={loadError} />
      ) : employees.length === 0 ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text2)' }}>No active employees. Add employees in HR → Employees first.</div>
      ) : (
        <>
          <div className="stat-grid">
            {[
              { label: 'Total Gross',       value: `NPR ${fmt(totalGross)}`, color: 'var(--theme-accent-ink)', tip: 'Sum of live-computed gross across all employees this period.' },
              { label: 'Total Net Pay',     value: `NPR ${fmt(totalNet)}`,   color: 'var(--theme-green-text)',  tip: 'Sum of live-computed net pay — compare against Payroll Run\'s Net Payable.' },
              { label: 'Flagged for Review', value: flaggedCount, color: flaggedCount > 0 ? 'var(--theme-amber-text)' : 'var(--theme-text2)', tip: 'Employees with an OT-in-two-places risk, whose stored Payroll payslip no longer matches this live calculation, or who have no payslip in the run at all.' },
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
                    <th style={{ textAlign: 'right' }}><Tip text="Overtime pay this period — from the attendance sheet plus approved Overtime entries combined." width={260}>OT</Tip></th>
                    <th style={{ textAlign: 'right' }}>Absence</th>
                    <th style={{ textAlign: 'right' }}><Tip text="Social Security Fund — the employee's 11% mandatory contribution, deducted from pay." width={260}>SSF</Tip></th>
                    <th style={{ textAlign: 'right' }}><Tip text="Tax Deducted at Source — income tax withheld this month based on the employee's projected yearly earnings." width={280}>TDS</Tip></th>
                    <th style={{ textAlign: 'right' }}>Advance</th>
                    <th style={{ textAlign: 'right' }}><Tip text="Travel & Daily Allowance — non-taxable trip expense reimbursement added to this payslip." width={270}>TADA</Tip></th>
                    <th style={{ textAlign: 'right', color: 'var(--theme-accent-ink)' }}>Net Pay (live)</th>
                    <th>Payroll Page</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(row => {
                    const { emp, slip, tdsBreakdown, advDed, tadaAmount, netPay, stored, stale, overridden, missing } = row
                    const expanded = expandedId === emp.id
                    return (
                      <Fragment key={emp.id}>
                        <tr style={{ cursor: 'pointer' }} onClick={() => setExpandedId(expanded ? null : emp.id)}>
                          <td style={{ color: 'var(--theme-text3)', textAlign: 'center' }}>{expanded ? '▾' : '▸'}</td>
                          <td>
                            <div style={{ fontWeight: 600, color: 'var(--theme-text1)', fontSize: 13 }}>{emp.full_name}</div>
                            <div style={{ display: 'flex', gap: 6, marginTop: 2, alignItems: 'center' }}>
                              {emp.employee_code && <span style={{ fontSize: 10, color: 'var(--theme-text2)' }}>{emp.employee_code}</span>}
                              {(slip.breakdown.otSupersededHrs || 0) > 0 && (
                                <Tip text={`This employee has OT in both places. ${slip.breakdown.otSupersededHrs.toFixed(1)} hr typed on the attendance sheet was superseded by an approved Overtime entry for the same day and is not paid — expand the row to see the split.`} width={300}>
                                  <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--theme-text2)', background: 'color-mix(in srgb, var(--theme-text2) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-text2) 25%, transparent)', borderRadius: 8, padding: '1px 6px', cursor: 'help' }}>OT superseded</span>
                                </Tip>
                              )}
{missing && (
                                <Tip text="This employee has no payslip in the current Payroll run for this period — Regenerate to include them before finalizing." width={280}>
                                  <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--theme-red-text)', background: 'color-mix(in srgb, var(--theme-red) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-red) 30%, transparent)', borderRadius: 8, padding: '1px 6px', cursor: 'help' }}>⚠ Missing</span>
                                </Tip>
                              )}
                              {stale && (
                                <Tip text={`Payroll's stored net pay (NPR ${fmt(stored.net_pay)}) no longer matches this live calculation (NPR ${fmt(netPay)}) — something changed since the run was last Generated/Regenerated.`} width={290}>
                                  <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--theme-red-text)', background: 'color-mix(in srgb, var(--theme-red) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-red) 30%, transparent)', borderRadius: 8, padding: '1px 6px', cursor: 'help' }}>⚠ Stale</span>
                                </Tip>
                              )}
                              {/* Not a warning. The stored figure differs only because someone
                                  set TDS or TADA by hand on the Payroll page, which is a supported
                                  edit — this says so plainly rather than showing the red ⚠ Stale
                                  it used to, which accused a correct payslip of being out of date. */}
                              {overridden && (
                                <Tip text={`Payroll's stored payslip matches this calculation on every computed figure, but its TDS or TADA was adjusted by hand (stored net NPR ${fmt(stored.net_pay)} vs NPR ${fmt(netPay)} computed). That is a deliberate edit, not stale data.`} width={300}>
                                  <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--theme-text2)', background: 'color-mix(in srgb, var(--theme-text2) 10%, transparent)', border: '1px solid var(--theme-border)', borderRadius: 8, padding: '1px 6px', cursor: 'help' }}>Adjusted</span>
                                </Tip>
                              )}
                            </div>
                          </td>
                          <td style={{ textAlign: 'right' }}>{fmt(slip.gross)}</td>
                          <td style={{ textAlign: 'right', color: slip.ot_amount > 0 ? 'var(--theme-green-text)' : 'var(--theme-text2)' }}>{slip.ot_amount > 0 ? `+${fmt(slip.ot_amount)}` : '—'}</td>
                          <td style={{ textAlign: 'right', color: slip.absence_deduction > 0 ? 'var(--theme-red-text)' : 'var(--theme-text2)' }}>{slip.absence_deduction > 0 ? `−${fmt(slip.absence_deduction)}` : '—'}</td>
                          <td style={{ textAlign: 'right', color: slip.ssf_employee > 0 ? 'var(--theme-red-text)' : 'var(--theme-text2)' }}>{slip.ssf_employee > 0 ? `−${fmt(slip.ssf_employee)}` : '—'}</td>
                          <td style={{ textAlign: 'right', color: tdsBreakdown.tds > 0 ? 'var(--theme-red-text)' : 'var(--theme-text2)' }}>{tdsBreakdown.tds > 0 ? `−${fmt(tdsBreakdown.tds)}` : '—'}</td>
                          <td style={{ textAlign: 'right', color: advDed > 0 ? 'var(--theme-purple-text)' : 'var(--theme-text2)' }}>{advDed > 0 ? `−${fmt(advDed)}` : '—'}</td>
                          <td style={{ textAlign: 'right', color: tadaAmount > 0 ? 'var(--theme-green-text)' : 'var(--theme-text2)' }}>{tadaAmount > 0 ? `+${fmt(tadaAmount)}` : '—'}</td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-accent-ink)', fontWeight: 700 }}>{fmt(netPay)}</td>
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
                <tfoot>
                  <tr style={{ fontWeight: 700, borderTop: '2px solid var(--theme-border)' }}>
                    <td />
                    <td style={{ color: 'var(--theme-text2)', fontSize: 12 }}>Total — {rows.length}</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-text1)' }}>{fmt(totalGross)}</td>
                    <td style={{ textAlign: 'right', color: totals.ot > 0 ? 'var(--theme-green-text)' : 'var(--theme-text2)' }}>{totals.ot > 0 ? `+${fmt(totals.ot)}` : '—'}</td>
                    <td style={{ textAlign: 'right', color: totals.absence > 0 ? 'var(--theme-red-text)' : 'var(--theme-text2)' }}>{totals.absence > 0 ? `−${fmt(totals.absence)}` : '—'}</td>
                    <td style={{ textAlign: 'right', color: totals.ssf > 0 ? 'var(--theme-red-text)' : 'var(--theme-text2)' }}>{totals.ssf > 0 ? `−${fmt(totals.ssf)}` : '—'}</td>
                    <td style={{ textAlign: 'right', color: totals.tds > 0 ? 'var(--theme-red-text)' : 'var(--theme-text2)' }}>{totals.tds > 0 ? `−${fmt(totals.tds)}` : '—'}</td>
                    <td style={{ textAlign: 'right', color: totals.advance > 0 ? 'var(--theme-purple-text)' : 'var(--theme-text2)' }}>{totals.advance > 0 ? `−${fmt(totals.advance)}` : '—'}</td>
                    <td style={{ textAlign: 'right', color: totals.tada > 0 ? 'var(--theme-green-text)' : 'var(--theme-text2)' }}>{totals.tada > 0 ? `+${fmt(totals.tada)}` : '—'}</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-accent-ink)', fontSize: 15 }}>{fmt(totalNet)}</td>
                    <td style={{ fontSize: 11, color: 'var(--theme-text2)' }}>{totalStored !== null ? `NPR ${fmt(totalStored)}` : '—'}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </>
      )}
      </div>

      {printRow && (
        // Explicit padding here, not relying on the app's normal page padding — @media print
        // zeroes .main-content's padding (Layout.css) so other pages can control their own
        // print margins precisely, which otherwise leaves print-only content flush to the edge.
        <div className="print-only" style={{ padding: '28px 36px' }}>
          <h1 style={{ fontSize: 20, marginBottom: 2 }}>Payroll Calculation</h1>
          <div style={{ fontSize: 13, marginBottom: 2 }}>{printRow.emp.full_name}{printRow.emp.employee_code ? ` (${printRow.emp.employee_code})` : ''}</div>
          <div style={{ fontSize: 12, color: '#555', marginBottom: 14 }}>{periodLabel} — generated {new Date().toLocaleDateString('en-NP')}</div>
          <CalcDetail row={printRow} monthDays={monthDays} advances={advances} />
        </div>
      )}
    </div>
  )
}
