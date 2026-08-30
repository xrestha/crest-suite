import { useState, useEffect, useMemo, useCallback } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import Tip from '../../../components/Tip'
import ConfirmModal from '../../../components/ConfirmModal'
import { BS_MONTHS, bsToAd, daysInBsMonth, getBsToday, formatAd, adToBs } from '../../../utils/bsCalendar'
import { computeBonusTds, fiscalYearOf } from '../payroll/tds'
import { printWithTitle } from '../../../utils/printTitle'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import { calcGratuity } from '../gratuity/gratuityCompute'
import { fetchSsfStartMap, ssfMonthsFrom } from '../gratuity/ssfEnrolment'
import { leaveBalance } from '../leave/leaveBalance'
import { tallyAttendance, calcAmount } from '../payroll/payrollCompute'
import { fetchYtdMap } from '../payroll/payrollData'
import { firstError } from '../../../shared/queryError'
import { errorText } from '../../../shared/errorText'
import { SSF_CAP, SSF_GRATUITY_PCT, GRATUITY_VESTING_MONTHS, SSF_EMPLOYEE_PCT } from '../payrollConstants'

const fmt = n => Math.round(n || 0).toLocaleString('en-NP')

// Labour Act convention: leave encashment and notice pay are both a day-rate of basic ÷ 26,
// deliberately NOT the calendar length of the month (which is what partial salary divides by).
const DAY_DIVISOR = 26

// Format service as "X yr Y mo"
function fmtService(months) {
  const y = Math.floor(months / 12)
  const m = months % 12
  if (y === 0) return `${m} mo`
  if (m === 0) return `${y} yr`
  return `${y} yr ${m} mo`
}

function BsDateSelect({ id, label, year, month, day, onChange, tip }) {
  const daysInMonth = daysInBsMonth(year, month)
  const yearRange = []
  for (let y = 2075; y <= 2090; y++) yearRange.push(y)

  const set = obj => onChange({ year, month, day, ...obj })

  return (
    <div>
      {/* One <label> can only name one control, so it names the year select and the month/day
          selects carry their own aria-label rather than being announced unnamed. */}
      <label htmlFor={`${id}-year`} style={{ display: 'block', fontSize: 12, color: 'var(--theme-text3)', marginBottom: 5 }}>
        {tip ? <Tip text={tip} width={260}>{label}</Tip> : label}
      </label>
      <div style={{ display: 'flex', gap: 6 }}>
        <select id={`${id}-year`} className="form-select" value={year}  onChange={e => set({ year: +e.target.value })}>
          {yearRange.map(y => <option key={y} value={y}>{y}</option>)}
        </select>
        <select id={`${id}-month`} aria-label={`${label} — month`} className="form-select" value={month} onChange={e => set({ month: +e.target.value })}>
          {BS_MONTHS.map((n, i) => <option key={i+1} value={i+1}>{n}</option>)}
        </select>
        <select id={`${id}-day`} aria-label={`${label} — day`} className="form-select" value={Math.min(day, daysInMonth)} onChange={e => set({ day: +e.target.value })}>
          {Array.from({ length: daysInMonth }, (_, i) => i + 1).map(d => <option key={d} value={d}>{d}</option>)}
        </select>
      </div>
    </div>
  )
}

const today = getBsToday()

export default function FinalSettlement() {
  const { clientId, hasHrAccess, isAdmin } = useAuth()
  const { scopedFrom, scopedInsert, scopedUpdate, scopedDelete } = useScopedDb()

  const [employees,  setEmployees]  = useState([])
  const [empId,      setEmpId]      = useState('')
  const [reason,     setReason]     = useState('resignation')
  const [lastDate,   setLastDate]   = useState({ year: today.year, month: today.month, day: today.day })
  const [noticeDays, setNoticeDays] = useState(30)    // notice period per contract (calendar days)
  const [noticeServed, setNoticeServed] = useState(true)
  const [leaveDays,  setLeaveDays]  = useState(0)
  const [festPaid,   setFestPaid]   = useState(true)  // was festival allowance paid this FY?
  const [advances,   setAdvances]   = useState([])

  // ── The sources that used to be typed in by hand ──
  const [components,  setComponents]  = useState([])   // hr_salary_components → allowances
  const [leaveTypes,  setLeaveTypes]  = useState([])
  const [leaveReqs,   setLeaveReqs]   = useState([])
  const [leaveTypeId, setLeaveTypeId] = useState('')
  const [festRows,    setFestRows]    = useState([])
  const [ssfStart,    setSsfStart]    = useState({})
  const [ytdMap,      setYtdMap]      = useState({})
  const [attendance,  setAttendance]  = useState(null) // null = not looked up yet for this month
  const [attendanceKnown, setAttendanceKnown] = useState(false)

  // ── The record ──
  const [settlements, setSettlements] = useState([])   // every settlement for this client
  const [current,     setCurrent]     = useState(null) // the row being viewed/edited, if saved
  const [busy,        setBusy]        = useState(false)
  const [msg,         setMsg]         = useState('')
  // A failed YTD read is not an employee with no prior payslips — see the load effect below.
  const [ytdFailed,   setYtdFailed]   = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [refusal,     setRefusal]     = useState(null) // why Finalize refused
  const [reopenTarget, setReopenTarget] = useState(null)
  // Load employee list.
  // ssf_no is selected because the gratuity SSF gate is `ssf_enrolled AND ssf_no`, matching
  // payroll; status/end_date/access_blocked because Finalize stamps all three and Reopen has to
  // put back exactly what was there.
  const loadEmployees = useCallback(async () => {
    const { data } = await scopedFrom('hr_employees', 'id, full_name, employee_code, join_date, basic_salary, pay_basis, ssf_enrolled, ssf_no, marital_status, life_insurance_premium, health_insurance_premium, department, status, end_date, access_blocked')
      .in('status', ['active', 'probation'])
      .order('full_name')
    setEmployees(data || [])
  }, [scopedFrom])

  useEffect(() => { if (clientId) loadEmployees() }, [clientId, loadEmployees])

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

  // Salary components carry the allowances that make up gross pay. The settlement used to divide
  // BASIC for its partial month while payroll divides GROSS, so every allowance silently vanished
  // from a leaver's final month.
  useEffect(() => {
    if (!clientId) return
    scopedFrom('hr_salary_components').then(({ data }) => setComponents(data || []))
    scopedFrom('hr_leave_types').eq('active', true).order('sort_order').then(({ data }) => {
      const rows = data || []
      setLeaveTypes(rows)
      // Default to the first capped type — "annual leave" has no guaranteed code, because type
      // codes are user-editable and custom types mint their own.
      if (!leaveTypeId) setLeaveTypeId((rows.find(t => (parseFloat(t.annual_quota) || 0) > 0) || rows[0])?.id || '')
    })
    fetchSsfStartMap(scopedFrom).then(setSsfStart).catch(() => setSsfStart({}))
    loadSettlements()
  }, [clientId])  // eslint-disable-line react-hooks/exhaustive-deps

  const loadSettlements = useCallback(async () => {
    const { data, error } = await scopedFrom('hr_final_settlements', '*').order('last_working_date', { ascending: false })
    // The table ships in a migration applied by hand, so a deployed frontend can genuinely arrive
    // first. Degrade to "history unavailable" rather than white-screening the calculator.
    if (error) { setSettlements([]); return }
    setSettlements(data || [])
  }, [scopedFrom])

  // Leave requests for the selected employee — the balance is bucketed client-side by BS year,
  // exactly as the Balances tab does.
  useEffect(() => {
    if (!clientId || !empId) { setLeaveReqs([]); return }
    scopedFrom('hr_leave_requests', 'employee_id, leave_type_id, status, days, start_date')
      .eq('employee_id', empId)
      .then(({ data }) => setLeaveReqs(data || []))
  }, [clientId, empId, scopedFrom])

  // Everything that depends on WHICH month the employee left in: festival allowance for that
  // fiscal year, the year-to-date tax base, and the final month's attendance.
  useEffect(() => {
    if (!clientId || !empId) { setFestRows([]); setYtdMap({}); setAttendance(null); setAttendanceKnown(false); return }
    let cancelled = false
    const period = { bs_year: lastDate.year, bs_month: lastDate.month }

    ;(async () => {
      // Festival is keyed on bs_year = the FISCAL year start, not the calendar year of the last
      // working date — Dashain falls in Ashwin, so for a Baisakh–Ashadh leaver fyStart is the
      // previous BS year and filtering on lastDate.year would read the wrong one entirely.
      const { fyStart } = fiscalYearOf(lastDate.year, lastDate.month)
      const [fest, ytd, per] = await Promise.all([
        // Deliberately not filtered by festival_name: it is free text and clients run Tihar too.
        scopedFrom('hr_festival_allowances', 'id, festival_name, bs_year, amount, tds, status')
          .eq('employee_id', empId).eq('bs_year', fyStart),
        fetchYtdMap(scopedFrom, period).catch(err => ({ data: null, error: err })),
        scopedFrom('monthly_periods', 'id')
          .eq('bs_year', lastDate.year).eq('bs_month', lastDate.month).maybeSingle(),
      ])
      if (cancelled) return
      // This used to be `.catch(() => ({}))` — a failed YTD read degraded to an empty map, which
      // is a REAL and ordinary value here (an employee finalized in the fiscal year's first month
      // genuinely has no prior payslips). So the settlement would compute this person's tax as
      // though they had earned nothing all year, withhold too little, and finalize that figure as
      // a permanent record — with nothing on screen having gone wrong. The write actions are
      // blocked while this is set, because an error nobody can act on is not a guard.
      const loadFailed = firstError([fest, ytd, per])
      if (loadFailed) {
        setYtdFailed(true)
        setMsg('error:' + errorText(loadFailed, 'operator') + " Until this loads, the tax on this settlement cannot be calculated, so it can't be saved or finalized.")
        setAttendance([]); setAttendanceKnown(false)
        return
      }
      setYtdFailed(false)
      setFestRows(fest.data || [])
      setYtdMap(ytd.data || {})

      // Attendance for the final month. One row per employee per day, so it is paged — a
      // truncated read here would quietly pay a full month.
      if (!per.data?.id) { setAttendance([]); setAttendanceKnown(false); return }
      const { data: att } = await fetchAllRows(() => scopedFrom('hr_attendance', 'bs_day, status, hours_worked, ot_hours')
        .eq('employee_id', empId).eq('period_id', per.data.id).order('id'))
      if (cancelled) return
      setAttendance(att || [])
      // MISSING ATTENDANCE IS NOT ZERO ATTENDANCE. With no rows marked we fall back to calendar
      // proration and say so, rather than deducting a month nobody recorded or silently assuming
      // the employee worked every day.
      setAttendanceKnown((att || []).length > 0)
    })()

    return () => { cancelled = true }
  }, [clientId, empId, lastDate.year, lastDate.month, scopedFrom])

  const emp = employees.find(e => e.id === empId)

  // ── What the database already knows ──────────────────────────
  // Leave is bucketed by BS CALENDAR year (Baisakh–Chaitra) — deliberately not the Shrawan-start
  // fiscal year the festival and TDS figures on this same page use. Two year definitions, one
  // screen; the field's hint says which is which rather than leaving it to be inferred.
  const leaveYear = lastDate.year
  const selectedLeaveType = leaveTypes.find(t => t.id === leaveTypeId) || null
  const balance = useMemo(() => (
    emp && selectedLeaveType
      ? leaveBalance({ requests: leaveReqs, settlements, leaveType: selectedLeaveType, employeeId: emp.id, bsYear: leaveYear })
      : null
  ), [emp, selectedLeaveType, leaveReqs, settlements, leaveYear])

  // Unpaid leave has no accrued value to buy back, so encashing it is a category error rather
  // than an unusual choice. `paid` is the discriminator, not the quota: a client can create an
  // uncapped type that is still paid, and quota-only logic would treat those two the same.
  const encashable = selectedLeaveType ? selectedLeaveType.paid !== false : true

  // Prefill on selection, and ALWAYS write something — the first version returned early for any
  // type with no quota, which left the previous type's day count sitting in the box. Switching
  // from Bereavement (13 days) to Unpaid therefore kept 13 and happily costed it, paying real
  // money for leave that has none. Found on a real settlement screen, not by reading the code.
  useEffect(() => {
    if (!balance) return
    setLeaveDays(encashable && balance.capped
      ? String(Math.max(0, Math.round(balance.remaining * 10) / 10))
      : '0')
  }, [empId, leaveTypeId, leaveYear, encashable])  // eslint-disable-line react-hooks/exhaustive-deps

  // "Paid" means a FINALIZED run carrying a real amount — a 0-value row legitimately exists for
  // wage staff, and a draft run is not a payment.
  const festivalAlreadyPaid = festRows.some(f => f.status === 'finalized' && (parseFloat(f.amount) || 0) > 0)
  useEffect(() => { setFestPaid(festivalAlreadyPaid) }, [empId, festivalAlreadyPaid])

  // ── Core computation ─────────────────────────────────────────
  const result = useMemo(() => {
    if (!emp) return null

    const basic      = parseFloat(emp.basic_salary) || 0
    const lastAdDate = bsToAd(lastDate.year, lastDate.month, lastDate.day)

    // Gross, not basic. Payroll pays `basic + allowances` and prorates THAT; this page divided
    // basic alone, so every allowance an employee had silently vanished from their final month.
    const empComponents = components.filter(c => c.employee_id === emp.id)
    const allowances    = empComponents.filter(c => c.type === 'earning').reduce((a, c) => a + calcAmount(c, basic), 0)
    const gross         = basic + allowances

    // ── Partial month ──
    const totalDaysInLastMonth = daysInBsMonth(lastDate.year, lastDate.month)
    const workedThrough        = lastDate.day
    // Days actually not worked, from the attendance that was marked up to the last working day.
    // With nothing marked, `unpaidInMonth` stays 0 and this is a plain calendar proration — the
    // page says which of the two it did rather than presenting them identically.
    const attUpToExit = (attendance || []).filter(a => a.bs_day <= workedThrough)
    const t           = tallyAttendance(attUpToExit)
    const unpaidInMonth = attendanceKnown
      ? t.absent + t.unpaid_leave + t.half_day * 0.5 + t.half_unpaid_leave * 0.5
      : 0
    const paidDays      = Math.max(0, workedThrough - unpaidInMonth)
    const partialSalary = (gross / totalDaysInLastMonth) * paidDays

    // ── Leave encashment (Labour Act: basic ÷ 26 per day) ──
    const leaveEncashment = (basic / DAY_DIVISOR) * (parseFloat(leaveDays) || 0)

    // ── Gratuity ──
    // One shared implementation with the Gratuity Tracker, and the SSF offset counted only from
    // the month contributions actually began (see ssfEnrolment.js) rather than from the join date.
    const g = calcGratuity(emp, { asOf: lastAdDate, ssfMonths: ssfMonthsFrom(ssfStart[emp.id], lastAdDate) })
    const serviceMonths = g.months
    const vested        = g.vested

    // ── Festival pro-ration (if not yet paid this FY) ──
    const { fyStart, monthInFy: curMonthInFy } = fiscalYearOf(lastDate.year, lastDate.month)
    const festivalPro = !festPaid ? basic * (curMonthInFy / 12) : 0

    // ── Notice pay deduction (if notice not served) ──
    const noticeDeduction = noticeServed ? 0 : (basic / DAY_DIVISOR) * (parseFloat(noticeDays) || 0)

    // ── Outstanding advances ──
    const advanceDeduction = advances.reduce((a, x) => a + (x.outstanding || 0), 0)

    // ── TDS on the lump-sum components ──
    // The annual base is the employee's REAL year-to-date earnings from finalized payslips plus
    // this final month — not `basic × 12`. A leaver has no remaining months of the fiscal year, so
    // projecting a full year of income over them put the lump in a higher marginal band and
    // systematically over-withheld. computeBonusTds taxes the lump at the margin above this base.
    const ytd         = ytdMap[emp.id] || { gross: 0, ssf: 0 }
    const ytdGross    = parseFloat(ytd.gross) || 0
    const ytdSsf      = parseFloat(ytd.ssf) || 0
    const annualBasis = ytdGross + partialSalary
    // SSF relief for the year: what was actually contributed, plus this month's, capped by the
    // statutory ⅓-of-income / NPR 500,000 ceiling.
    const thisMonthSsf = g.enrolled ? Math.min(basic, SSF_CAP) * SSF_EMPLOYEE_PCT : 0
    const ssfDeduction = Math.min(ytdSsf + thisMonthSsf, Math.min(500000, annualBasis / 3))
    const lifeIns      = Math.min(parseFloat(emp.life_insurance_premium) || 0, 40000)
    const healthIns    = Math.min(parseFloat(emp.health_insurance_premium) || 0, 20000)
    const annualTaxable = Math.max(0, annualBasis - ssfDeduction - lifeIns - healthIns)

    const lumpSum = g.payable + leaveEncashment + festivalPro
    const lumpTds = computeBonusTds({
      annualTaxable, bonusAmount: lumpSum,
      isSsf: g.enrolled, isMarried: emp.marital_status === 'married', fyStart,
    })

    // ── Summary ──
    const grossPayout     = partialSalary + leaveEncashment + g.payable + festivalPro
    const totalDeductions = noticeDeduction + advanceDeduction + lumpTds
    const netPayout       = grossPayout - totalDeductions

    // What the payout can actually cover of the outstanding advances. A settlement that nets
    // negative has NOT recovered the full balance, so Finalize must not mark those advances
    // settled — there is no receivable ledger to move the shortfall into.
    const advanceRecovered = Math.max(0, Math.min(advanceDeduction, grossPayout - noticeDeduction - lumpTds))
    const advanceShortfall = advanceDeduction - advanceRecovered

    return {
      basic, gross, allowances, serviceMonths, vested,
      totalDaysInLastMonth, daysWorked: paidDays, workedThrough, unpaidInMonth, attendanceKnown,
      leaveEncashment,
      gratuity: g.payable, gratuityAccrued: g.totalAccrued, gratuitySsfCovered: g.ssfCovered,
      ssfCoverageKnown: g.coverageKnown, ssfCoveredMonths: g.coveredMonths, ssfEnrolled: g.enrolled,
      partialSalary, festivalPro,
      noticeDeduction, advanceDeduction, advanceRecovered, advanceShortfall, lumpTds,
      grossPayout, totalDeductions, netPayout,
      annualTaxable, lumpSum, fyStart, ytdMonths: ytd.count || 0,
    }
  }, [emp, lastDate, leaveDays, festPaid, noticeServed, noticeDays, advances,
      components, attendance, attendanceKnown, ssfStart, ytdMap])

  // ── The record ───────────────────────────────────────────────
  // Settlements for the selected employee. Never .maybeSingle(): an employee can be rehired and
  // settled again, and a second row is a legitimate state rather than a data error.
  const empSettlements = settlements.filter(x => x.employee_id === empId)
  const finalized = empSettlements.find(x => x.status === 'finalized') || null

  const snapshot = () => ({
    employee_id: emp.id,
    separation_reason: reason,
    last_working_date: formatAd(bsToAd(lastDate.year, lastDate.month, lastDate.day)),
    notice_days: parseFloat(noticeDays) || 0,
    notice_served: noticeServed,
    leave_days_encashed: parseFloat(leaveDays) || 0,
    leave_type_id: leaveTypeId || null,
    festival_paid: festPaid,
    // Frozen context. A reprint must never re-derive these from the live employee record, or the
    // workings printed beside each figure stop matching the figure itself the first time someone
    // gets a raise.
    employee_name: emp.full_name,
    employee_code: emp.employee_code || null,
    department: emp.department || null,
    basic_salary: result.basic,
    join_date: emp.join_date || null,
    ssf_enrolled: !!emp.ssf_enrolled,
    ssf_no: emp.ssf_no || null,
    ssf_cap: SSF_CAP,
    ssf_gratuity_pct: SSF_GRATUITY_PCT,
    vesting_months: GRATUITY_VESTING_MONTHS,
    day_divisor: DAY_DIVISOR,
    // Frozen figures
    service_months: result.serviceMonths,
    partial_salary: result.partialSalary,
    leave_encashment: result.leaveEncashment,
    gratuity_accrued: result.gratuityAccrued,
    gratuity_ssf_covered: result.gratuitySsfCovered,
    gratuity: result.gratuity,
    festival_pro: result.festivalPro,
    notice_deduction: result.noticeDeduction,
    advance_deduction: result.advanceDeduction,
    lump_tds: result.lumpTds,
    gross_payout: result.grossPayout,
    net_payout: result.netPayout,
  })

  async function saveDraft() {
    if (!emp || !result) return
    setBusy(true); setMsg('')
    const row = { ...snapshot(), status: 'draft' }
    const { data, error } = current
      ? await scopedUpdate('hr_final_settlements', row).eq('id', current.id).select().single()
      : await scopedInsert('hr_final_settlements', row, { single: true })
    setBusy(false)
    if (error) { setMsg('error:' + error.message); return }
    setCurrent(data)
    await loadSettlements()
    setMsg('ok:Draft saved.')
  }

  // Everything that would make finalizing wrong, checked BEFORE anything is written.
  async function checkRefusals() {
    const out = []

    // 1. Already settled for this spell. A rehired employee may legitimately have an older
    //    settlement, so this refuses only one overlapping the CURRENT join date — where service
    //    months would span both spells and pay gratuity twice for the same years.
    const overlapping = settlements.find(x => x.employee_id === empId && x.status === 'finalized'
      && (!emp.join_date || x.last_working_date >= emp.join_date))
    if (overlapping) {
      out.push(emp.full_name + ' already has a finalized settlement dated ' + overlapping.last_working_date
        + ', covering service that overlaps their current join date. Settling again would pay gratuity twice for the same years.'
        + ' Reopen that settlement instead, or add a new employee record for the new spell.')
    }

    // 2. The final month already paid by payroll — otherwise that month is paid about 1.5 times:
    //    once in full by the run, and again as partial salary here.
    // Every read in this gate REFUSES when it cannot run (S613): these guards used to drop their
    // errors, so a failed payslips read meant "no payroll covers this month" — the gate passing
    // vacuously on exactly the double-payment it exists to block. Unverifiable ≠ clear.
    const { data: per, error: perErr } = await scopedFrom('monthly_periods', 'id')
      .eq('bs_year', lastDate.year).eq('bs_month', lastDate.month).maybeSingle()
    if (perErr) {
      out.push('Could not verify whether payroll already covers the final month (' + perErr.message + '). Try again — finalizing without this check could pay that month twice.')
    }
    if (per?.id) {
      const { data: slips, error: slipsErr } = await scopedFrom('hr_payslips', 'id, hr_payroll_runs!inner(status, period_id)')
        .eq('employee_id', empId)
        .eq('hr_payroll_runs.period_id', per.id)
        .eq('hr_payroll_runs.status', 'finalized')
      if (slipsErr) {
        out.push('Could not verify whether payroll already covers the final month (' + slipsErr.message + '). Try again — finalizing without this check could pay that month twice.')
      }
      if ((slips || []).length > 0) {
        out.push('A finalized payroll run already covers ' + BS_MONTHS[lastDate.month - 1] + ' ' + lastDate.year
          + ' for ' + emp.full_name + ', so their pay for that month has been issued once already.'
          + ' Reopen that payroll run (it now prorates for the end date), or set the last working date to a month payroll has not run.')
      }
    }

    // 3. Concurrent finalize — `busy` guards one tab, not two.
    if (current?.id) {
      const { data: fresh, error: freshErr } = await scopedFrom('hr_final_settlements', 'status').eq('id', current.id).maybeSingle()
      if (freshErr) {
        out.push('Could not verify this settlement\'s current status (' + freshErr.message + '). Try again before finalizing.')
      }
      if (fresh?.status === 'finalized') {
        out.push('This settlement was finalized somewhere else while it was open here. Reload the page to see it.')
      }
    }
    return out
  }

  async function requestFinalize() {
    if (!emp || !result) return
    setBusy(true); setMsg('')
    const refusals = await checkRefusals()
    setBusy(false)
    if (refusals.length > 0) { setRefusal(refusals); return }
    setConfirmOpen(true)
  }

  // The order IS the design. The settlement row goes in as a DRAFT first so every later step has
  // an id to tag itself with, and only becomes authoritative once the ledgers have actually been
  // written. A crash part-way therefore leaves a draft — which closes nothing and claims nothing —
  // rather than a finalized document asserting money moved that never did.
  async function finalize() {
    if (!emp || !result) return
    setConfirmOpen(false)
    setBusy(true); setMsg('')

    const fail = (where, error) => {
      setBusy(false)
      setMsg('error:Stopped at ' + where + ': ' + error.message
        + '. The settlement is saved as a draft and nothing after that point was written — fix the problem and finalize again.')
      loadSettlements()
    }

    // 1. The row, as a draft.
    const row = {
      ...snapshot(),
      status: 'draft',
      prior_status: emp.status,
      prior_end_date: emp.end_date || null,
      prior_access_blocked: !!emp.access_blocked,
    }
    const { data: saved, error: sErr } = current
      ? await scopedUpdate('hr_final_settlements', row).eq('id', current.id).select().single()
      : await scopedInsert('hr_final_settlements', row, { single: true })
    if (sErr) return fail('saving the settlement', sErr)
    setCurrent(saved)

    // 2. Clear anything a previous attempt tagged with this settlement, so re-running recovers
    //    once rather than twice.
    const { error: dErr } = await scopedDelete('hr_advance_repayments').eq('final_settlement_id', saved.id)
    if (dErr) return fail('clearing previous advance recovery', dErr)

    // 3. Recover the advances, capped at what the payout actually covers. A zero-amount row would
    //    fail the table's amount > 0 CHECK and take the whole batch with it, so it is filtered out.
    let remaining = result.advanceRecovered
    const repayRows = []
    const settledIds = []
    for (const adv of advances) {
      if (remaining <= 0.005) break
      const take = Math.min(adv.outstanding, remaining)
      if (take > 0.005) {
        repayRows.push({
          advance_id: adv.id,
          employee_id: emp.id,
          repaid_date: row.last_working_date,
          amount: Math.round(take * 100) / 100,
          notes: 'Final settlement',
          final_settlement_id: saved.id,
        })
        // Only a fully recovered advance is settled. A partly recovered one stays active with a
        // real outstanding balance, because that money genuinely has not been repaid.
        if (take >= adv.outstanding - 0.01) settledIds.push(adv.id)
        remaining -= take
      }
    }
    if (repayRows.length > 0) {
      const { error } = await scopedInsert('hr_advance_repayments', repayRows)
      if (error) return fail('recording advance recovery', error)
    }
    if (settledIds.length > 0) {
      const { error } = await scopedUpdate('hr_advances', { status: 'settled' }).in('id', settledIds)
      if (error) return fail('closing the recovered advances', error)
    }

    // 4. Stamp the employee. access_blocked is a separate column from status by design (S561/S563),
    //    so ending their app login cannot remove them from a payroll picker.
    const statusFor = { resignation: 'resigned', mutual: 'resigned', termination: 'terminated', retirement: 'inactive' }
    const newStatus = statusFor[reason] || 'resigned'
    const { error: eErr } = await scopedUpdate('hr_employees', {
      status: newStatus,
      end_date: row.last_working_date,
      access_blocked: true,
    }).eq('id', emp.id)
    if (eErr) return fail('updating the employee record', eErr)

    // 5. Only now is the document authoritative.
    const { error: fErr } = await scopedUpdate('hr_final_settlements', {
      status: 'finalized', finalized_at: new Date().toISOString(),
    }).eq('id', saved.id)
    if (fErr) return fail('finalizing', fErr)

    await Promise.all([loadSettlements(), loadEmployees()])
    // Keep the employee we just settled on screen. loadEmployees() only returns active/probation
    // staff, so finalizing removes the very person whose settlement you are looking at — the form
    // and its Mark-paid/Reopen buttons emptied out the instant the action succeeded, and the only
    // way back was through the history list. Found by running a real settlement end to end.
    setEmployees(prev => prev.some(e => e.id === emp.id)
      ? prev
      : [...prev, { ...emp, status: newStatus, end_date: row.last_working_date, access_blocked: true }])
    setBusy(false)
    setMsg('ok:Settlement finalized. '
      + (settledIds.length > 0 ? settledIds.length + ' advance(s) closed. ' : '')
      + emp.full_name + ' is now ' + newStatus + ' and their Crest Staff login is blocked.')
  }

  // The exact reverse, scoped to what THIS settlement wrote — never a hand-entered repayment, and
  // never an advance another process closed.
  async function reopen(row) {
    setBusy(true); setMsg('')
    // Refuse on a failed read (S613): dropping this error meant the reopen proceeded WITHOUT
    // reactivating the advances this settlement had closed — the ledgers silently diverge.
    const { data: ownReps, error: repsErr } = await scopedFrom('hr_advance_repayments', 'advance_id').eq('final_settlement_id', row.id)
    if (repsErr) { setBusy(false); setMsg('error:Could not read this settlement\'s advance recoveries (' + repsErr.message + '). Nothing was changed — try again.'); return }
    const touched = [...new Set((ownReps || []).map(r => r.advance_id))]

    const { error: delErr } = await scopedDelete('hr_advance_repayments').eq('final_settlement_id', row.id)
    if (delErr) { setBusy(false); setMsg('error:Could not remove the settlement\'s advance recoveries (' + delErr.message + '). Nothing else was changed — try again.'); return }

    if (touched.length > 0) {
      const [{ data: advs }, { data: reps }] = await Promise.all([
        scopedFrom('hr_advances', 'id, amount, status').in('id', touched),
        scopedFrom('hr_advance_repayments', 'advance_id, amount').in('advance_id', touched),
      ])
      const repaid = {}
      ;(reps || []).forEach(r => { repaid[r.advance_id] = (repaid[r.advance_id] || 0) + (parseFloat(r.amount) || 0) })
      const reactivate = (advs || [])
        .filter(a => a.status === 'settled' && Math.max(0, parseFloat(a.amount) - (repaid[a.id] || 0)) > 0.01)
        .map(a => a.id)
      if (reactivate.length > 0) await scopedUpdate('hr_advances', { status: 'active' }).in('id', reactivate)
    }

    // Put the employee back exactly as they were, including an end date or a login block someone
    // may have set by hand before the settlement overwrote it.
    await scopedUpdate('hr_employees', {
      status: row.prior_status || 'active',
      end_date: row.prior_end_date || null,
      access_blocked: !!row.prior_access_blocked,
    }).eq('id', row.employee_id)

    await scopedUpdate('hr_final_settlements', {
      status: 'draft', finalized_at: null, paid_at: null, paid_method: null,
    }).eq('id', row.id)

    await Promise.all([loadSettlements(), loadEmployees()])
    setBusy(false)
    setMsg('ok:Settlement reopened — advances reactivated and the employee record restored.')
  }

  async function openSettlement(row) {
    // The picker only lists active/probation staff, so the employee this settlement belongs to is
    // almost certainly not in it — Finalize is what removed them. Fetch that one row and add it,
    // or opening a past settlement would resolve to no employee and render nothing.
    if (!employees.some(e => e.id === row.employee_id)) {
      const { data } = await scopedFrom('hr_employees', 'id, full_name, employee_code, join_date, basic_salary, pay_basis, ssf_enrolled, ssf_no, marital_status, life_insurance_premium, health_insurance_premium, department, status, end_date, access_blocked')
        .eq('id', row.employee_id).maybeSingle()
      if (data) setEmployees(prev => [...prev, data])
    }
    const [y, m, d] = String(row.last_working_date).split('-').map(Number)
    const bs = adToBs(new Date(y, m - 1, d))
    setEmpId(row.employee_id)
    setReason(row.separation_reason || 'resignation')
    setLastDate({ year: bs.year, month: bs.month, day: bs.day })
    setNoticeDays(row.notice_days ?? 30)
    setNoticeServed(!!row.notice_served)
    setLeaveDays(String(row.leave_days_encashed ?? 0))
    setLeaveTypeId(row.leave_type_id || '')
    setFestPaid(!!row.festival_paid)
    setCurrent(row)
    setMsg('')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  async function markPaid(row, method) {
    setBusy(true)
    await scopedUpdate('hr_final_settlements', { paid_at: new Date().toISOString(), paid_method: method }).eq('id', row.id)
    await loadSettlements()
    setBusy(false)
    setMsg('ok:Marked as paid.')
  }

  function handlePrint() { printWithTitle(`Final Settlement - ${emp.full_name}`) }

  if (!hasHrAccess('manager')) return <Navigate to="/dashboard" replace />

  return (
    <div>
      <div className="page-header page-header--split no-print">
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
            <label style={{ display: 'block', fontSize: 12, color: 'var(--theme-text3)', marginBottom: 5 }} htmlFor="settle-employee">Employee</label>
            <select id="settle-employee" className="form-select" value={empId} onChange={e => setEmpId(e.target.value)}>
              <option value="">— Select employee —</option>
              {employees.filter(e => (e.pay_basis || 'monthly') === 'monthly').map(e => (
                <option key={e.id} value={e.id}>{e.full_name}{e.employee_code ? ` (${e.employee_code})` : ''}</option>
              ))}
            </select>
            {/* The filter above is silent otherwise: a daily-wage cook simply isn't in the list,
                with nothing saying why — while Gratuity Tracker tells users wage-worker gratuity
                "is computed at final settlement". Stating the gap beats an unexplained absence. */}
            <p style={{ margin: '5px 0 0', fontSize: 11, color: 'var(--theme-text3)', lineHeight: 1.6 }}>
              Monthly-salaried employees only — settlement for daily and hourly staff isn't supported yet.
              {' '}Someone already marked resigned, terminated or inactive is not listed: settle them first,
              {' '}and Finalize sets that status for you. If they were marked by hand already, set them back to
              {' '}Probation in HR → Employees to settle them.
            </p>
          </div>

          {/* Reason */}
          <div>
            <label style={{ display: 'block', fontSize: 12, color: 'var(--theme-text3)', marginBottom: 5 }} htmlFor="settle-reason">Separation Reason</label>
            <select id="settle-reason" className="form-select" value={reason} onChange={e => setReason(e.target.value)}>
              <option value="resignation">Resignation</option>
              <option value="termination">Termination</option>
              <option value="retirement">Retirement</option>
              <option value="mutual">Mutual Separation</option>
            </select>
          </div>

          {/* Last working date */}
          <div style={{ gridColumn: 'span 2' }}>
            <BsDateSelect
              id="settle-last-date"
              label="Last Working Date (BS)"
              tip="The last day the employee worked. Used to calculate partial-month salary and total service months."
              year={lastDate.year} month={lastDate.month} day={lastDate.day}
              onChange={setLastDate}
            />
          </div>

          {/* Unused leave days */}
          <div>
            <label style={{ display: 'block', fontSize: 12, color: 'var(--theme-text3)', marginBottom: 5 }} htmlFor="settle-leave-days">
              <Tip text="Number of unused annual leave days to encash. Nepal Labour Act rate: basic ÷ 26 per day." width={260}>Unused Leave Days</Tip>
            </label>
            <input id="settle-leave-days" type="number" className="form-input form-input--auto" min={0} max={365}
              value={leaveDays} disabled={!encashable}
              onChange={e => setLeaveDays(e.target.value)} />
            {leaveTypes.length > 0 && (
              <select
                aria-label="Leave type being encashed"
                className="form-select"
                style={{ width: '100%', marginTop: 6 }}
                value={leaveTypeId}
                onChange={e => setLeaveTypeId(e.target.value)}
              >
                {leaveTypes.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            )}
            {/* Where the prefilled number came from. Leave is bucketed by BS CALENDAR year, while
                the festival and TDS figures on this same page use the Shrawan-start fiscal year —
                so the year is stated rather than left to be assumed. */}
            {!encashable ? (
              <p style={{ margin: '5px 0 0', fontSize: 11, color: 'var(--theme-amber-text)', lineHeight: 1.6 }}>
                {selectedLeaveType?.name} is unpaid leave — there is no accrued value to buy back, so nothing is encashed.
              </p>
            ) : balance && balance.capped ? (
              <p style={{ margin: '5px 0 0', fontSize: 11, color: 'var(--theme-text3)', lineHeight: 1.6 }}>
                Balance for BS {leaveYear}: {fmt(balance.quota)} quota − {balance.used} taken
                {balance.encashed > 0 ? ` − ${balance.encashed} already encashed` : ''} = <strong>{Math.round(balance.remaining * 10) / 10} days</strong>.
                {' '}Carry-forward from earlier years is not included — the app does not track it.
              </p>
            ) : (
              <p style={{ margin: '5px 0 0', fontSize: 11, color: 'var(--theme-text3)', lineHeight: 1.6 }}>
                {selectedLeaveType?.name} has no annual quota, so there is no balance to encash from — enter the days yourself if this type is genuinely being paid out.
              </p>
            )}
          </div>

          {/* Notice period */}
          <div>
            <label style={{ display: 'block', fontSize: 12, color: 'var(--theme-text3)', marginBottom: 5 }} htmlFor="settle-notice-days">
              <Tip text="Required notice period per employment contract (in calendar days). If notice was not served, this amount is deducted from final pay." width={280}>Notice Period (days)</Tip>
            </label>
            <input id="settle-notice-days" type="number" className="form-input form-input--auto" min={0} max={90} value={noticeDays} onChange={e => setNoticeDays(e.target.value)} />
          </div>

          {/* Checkboxes */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, justifyContent: 'flex-end', paddingBottom: 2 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--theme-text1)', cursor: 'pointer' }}>
              <input type="checkbox" checked={noticeServed} onChange={e => setNoticeServed(e.target.checked)} />
              <Tip text="Check if the employee served their full notice period. If unchecked, notice-period pay will be deducted from the settlement." width={280}>Notice period served</Tip>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--theme-text1)', cursor: 'pointer' }}>
              <input type="checkbox" checked={festPaid} onChange={e => setFestPaid(e.target.checked)} />
              <Tip text="Check if the employee has already received their festival (Dashain) allowance this fiscal year. If unchecked, a pro-rated festival amount is included in the payout." width={300}>Festival allowance paid this FY</Tip>
            </label>
          </div>
        </div>
      </div>

      {/* ── Result ────────────────────────────────────────── */}
      {!empId && (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text2)' }}>
          Select an employee to calculate final settlement.
        </div>
      )}

      {emp && result && (
        <div>
          {/* Missing attendance is not zero attendance. Saying which of the two prorations was
              used is the difference between a figure someone can check and one they must trust. */}
          {!result.attendanceKnown && (
            <div className="card no-print" style={{ marginBottom: 12, padding: '10px 16px', fontSize: 12, lineHeight: 1.7, color: 'var(--theme-text2)', borderColor: 'color-mix(in srgb, var(--theme-amber) 30%, transparent)', background: 'color-mix(in srgb, var(--theme-amber) 6%, transparent)' }}>
              No attendance is marked for {BS_MONTHS[lastDate.month - 1]} {lastDate.year}, so the partial month is prorated on
              calendar days alone — any absence or unpaid leave in that month is not deducted. Mark it in HR → Attendance first if it
              matters, because after this settlement is finalized {emp.full_name} leaves the attendance sheet and it can no longer be entered.
            </div>
          )}
          {result.ssfEnrolled && !result.ssfCoverageKnown && (
            <div className="card no-print" style={{ marginBottom: 12, padding: '10px 16px', fontSize: 12, lineHeight: 1.7, color: 'var(--theme-text2)', borderColor: 'color-mix(in srgb, var(--theme-amber) 30%, transparent)', background: 'color-mix(in srgb, var(--theme-amber) 6%, transparent)' }}>
              {emp.full_name} is marked SSF-enrolled but no finalized payslip carries an SSF deduction, so there is no evidence of when
              contributions began. No SSF-funded portion is netted off their gratuity — the full Labour Act accrual is being paid.
            </div>
          )}
          {/* Print header (hidden on screen) */}
          <div className="print-only" style={{ marginBottom: 24 }}>
            <h2 style={{ margin: 0 }}>Final Settlement Statement</h2>
            <div style={{ fontSize: 13, marginTop: 4 }}>
              {emp.full_name}{emp.employee_code ? ` · ${emp.employee_code}` : ''} · {emp.department || ''}
            </div>
            <div style={{ fontSize: 12, color: 'var(--theme-text2)', marginTop: 2 }}>
              Last working date: {lastDate.day} {BS_MONTHS[lastDate.month - 1]} {lastDate.year} BS ·
              Service: {fmtService(result.serviceMonths)} ·
              Reason: {reason.charAt(0).toUpperCase() + reason.slice(1)}
            </div>
          </div>

          {/* Employee summary */}
          <div className="card no-print" style={{ padding: '14px 18px', marginBottom: 16, display: 'flex', gap: 24, flexWrap: 'wrap', fontSize: 13 }}>
            <div><span style={{ color: 'var(--theme-text2)' }}>Employee: </span><strong>{emp.full_name}</strong></div>
            <div><span style={{ color: 'var(--theme-text2)' }}>Basic: </span><strong>NPR {fmt(result.basic)}</strong></div>
            <div><span style={{ color: 'var(--theme-text2)' }}>Service: </span><strong>{fmtService(result.serviceMonths)}</strong></div>
            <div><span style={{ color: 'var(--theme-text2)' }}>Gratuity: </span>
              <Tip text="The 12-month vesting cliff used here is a commonly applied assumption, not something confirmed in the current Labour Act 2074 text — Sections 52/53 read as accruing monthly from day 1 with no explicit tenure threshold found. Other sources still cite 1-year or 5-year thresholds. Verify with an accountant before finalizing a settlement for anyone close to the 1-year mark." width={340}>
                {result.vested
                  ? <span className="badge-green">Vested</span>
                  : <span className="badge-amber">Not vested ({result.serviceMonths} / 12 mo)</span>}
              </Tip>
            </div>
          </div>

          {/* Earnings table */}
          <div className="card" style={{ padding: 0, marginBottom: 12 }}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--theme-border)', fontWeight: 600, fontSize: 13 }}>Earnings</div>
            <div className="table-wrap">
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
                      <Tip text="Gross pay (basic plus allowances, the same figure payroll prorates) divided by the days in the last BS month, times the days actually worked. Unpaid days marked on the attendance sheet up to the last working day are excluded." width={320}>Partial Month Salary</Tip>
                      {result.unpaidInMonth > 0 && (
                        <span style={{ display: 'block', fontSize: 11, color: 'var(--theme-text3)' }}>
                          {result.workedThrough} days to the last working day, less {result.unpaidInMonth} unpaid from attendance
                        </span>
                      )}
                    </td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-text2)', fontSize: 12 }}>
                      {fmt(result.gross)} ÷ {result.totalDaysInLastMonth} × {result.daysWorked}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmt(result.partialSalary)}</td>
                  </tr>
                  {parseFloat(leaveDays) > 0 && (
                    <tr>
                      <td>
                        <Tip text="Encashment of unused annual leave at the rate of basic ÷ 26 per day (Nepal Labour Act)." width={260}>Leave Encashment ({leaveDays} days)</Tip>
                      </td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-text2)', fontSize: 12 }}>
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
                      <td style={{ textAlign: 'right', color: 'var(--theme-text2)', fontSize: 12 }}>
                        {result.gratuitySsfCovered > 0
                          ? `${fmt(result.gratuityAccrued)} − ${fmt(result.gratuitySsfCovered)} (SSF, ${result.ssfCoveredMonths} mo)`
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
                      <td style={{ textAlign: 'right', color: 'var(--theme-text2)', fontSize: 12 }}>
                        {fmt(result.basic)} × {result.lumpSum > 0 ? Math.round((result.festivalPro / result.basic) * 100) / 100 : '—'}
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmt(result.festivalPro)}</td>
                    </tr>
                  )}
                </tbody>
                <tfoot>
                  <tr style={{ fontWeight: 700, borderTop: '2px solid var(--theme-border)' }}>
                    <td>Gross Payout</td>
                    <td></td>
                    <td style={{ textAlign: 'right', fontSize: 15, color: 'var(--theme-green-text)' }}>{fmt(result.grossPayout)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          {/* Deductions table */}
          {result.totalDeductions > 0 && (
            <div className="card" style={{ padding: 0, marginBottom: 12 }}>
              <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--theme-border)', fontWeight: 600, fontSize: 13 }}>Deductions</div>
              <div className="table-wrap">
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
                        <td style={{ textAlign: 'right', color: 'var(--theme-text2)', fontSize: 12 }}>
                          {fmt(result.basic)} ÷ 26 × {noticeDays}
                        </td>
                        <td style={{ textAlign: 'right', fontWeight: 600, color: 'var(--theme-red-text)' }}>{fmt(result.noticeDeduction)}</td>
                      </tr>
                    )}
                    {result.lumpTds > 0 && (
                      <tr>
                        <td>
                          <Tip text="TDS on lump-sum components (gratuity + leave encashment + festival pro-ration) computed at the marginal income tax rate using the incremental method." width={300}>TDS on Lump Sum</Tip>
                        </td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-text2)', fontSize: 12 }}>Marginal rate on NPR {fmt(result.lumpSum)}</td>
                        <td style={{ textAlign: 'right', fontWeight: 600, color: 'var(--theme-red-text)' }}>{fmt(result.lumpTds)}</td>
                      </tr>
                    )}
                    {advances.map(adv => (
                      <tr key={adv.id}>
                        <td>
                          <Tip text={`Advance issued on ${adv.issued_date || '—'}. Outstanding balance (amount minus repayments recorded in Advances & Loans) recovered from final pay.`} width={270}>
                            Advance Recovery — {adv.purpose || 'Advance'}
                          </Tip>
                        </td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-text2)', fontSize: 12 }}>{fmt(adv.amount)} − repaid</td>
                        <td style={{ textAlign: 'right', fontWeight: 600, color: 'var(--theme-red-text)' }}>{fmt(adv.outstanding)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr style={{ fontWeight: 700, borderTop: '2px solid var(--theme-border)' }}>
                      <td>Total Deductions</td>
                      <td></td>
                      <td style={{ textAlign: 'right', fontSize: 15, color: 'var(--theme-red-text)' }}>{fmt(result.totalDeductions)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          )}

          {/* Net payout */}
          <div className="card" style={{ padding: '18px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: 12, color: 'var(--theme-text2)', marginBottom: 4 }}>NET SETTLEMENT AMOUNT</div>
              <div style={{ fontSize: 11, color: 'var(--theme-text2)' }}>Gross NPR {fmt(result.grossPayout)} − Deductions NPR {fmt(result.totalDeductions)}</div>
            </div>
            <div style={{ fontSize: 28, fontWeight: 800, color: result.netPayout >= 0 ? 'var(--theme-green-text)' : 'var(--theme-red-text)' }}>
              NPR {fmt(Math.abs(result.netPayout))}
              {result.netPayout < 0 && <span style={{ fontSize: 13, marginLeft: 8, color: 'var(--theme-red-text)' }}>(recoverable)</span>}
            </div>
          </div>

          <div style={{ marginTop: 12, fontSize: 11, color: 'var(--theme-text2)', lineHeight: 1.7 }} className="no-print">
            <strong style={{ color: 'var(--theme-text2)' }}>Notes:</strong>
            {' '}Partial salary is gross pay (basic plus allowances, as payroll computes it) over the BS month day count
            {' '}({result.totalDaysInLastMonth} days for {BS_MONTHS[lastDate.month-1]} {lastDate.year})
            {result.attendanceKnown ? ', less unpaid days marked on the attendance sheet' : ', prorated on calendar days as no attendance is marked'}.
            {' '}Leave encashment at basic ÷ {DAY_DIVISOR} per day (Nepal Labour Act).
            {' '}TDS on the lump sum is the marginal rate above this employee's actual year-to-date earnings
            {result.ytdMonths > 0 ? ` (${result.ytdMonths} finalized month${result.ytdMonths === 1 ? '' : 's'} this fiscal year)` : ' (no finalized payroll yet this fiscal year)'} —
            {' '}final liability still depends on their total annual income.
            {!result.vested && ' Gratuity is not included as service is under 1 year (this 1-year threshold is a common assumption, not confirmed in the current Labour Act text — verify with an accountant if this employee is close to the boundary).'}
            {result.gratuitySsfCovered > 0 && ' Gratuity is shown net of the portion already funded through employer SSF contributions.'}
            {' '}Consult your CA before disbursing.
          </div>

          {/* The amber "3 things this page does not do for you" checklist that stood here is gone:
              Finalize now does all three. What replaces it is a statement of what will actually
              happen, in front of the button that does it. */}
          <div className="card no-print" style={{ marginTop: 16, padding: '14px 18px' }}>
            {finalized ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ fontSize: 13, color: 'var(--theme-text2)' }}>
                  <span className="badge-green" style={{ marginRight: 8 }}>Finalized</span>
                  {finalized.paid_at
                    ? <>Paid{finalized.paid_method ? ' via ' + finalized.paid_method : ''} on {String(finalized.paid_at).slice(0, 10)}.</>
                    : <>Not yet recorded as paid.</>}
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {!finalized.paid_at && (
                    <>
                      <button className="btn btn-ghost" disabled={busy} onClick={() => markPaid(finalized, 'Cash')}>Mark paid — Cash</button>
                      <button className="btn btn-ghost" disabled={busy} onClick={() => markPaid(finalized, 'Bank')}>Mark paid — Bank</button>
                    </>
                  )}
                  {isAdmin && (
                    <button className="btn btn-danger" disabled={busy} onClick={() => setReopenTarget(finalized)}>Reopen</button>
                  )}
                </div>
              </div>
            ) : (
              <>
                <p style={{ margin: '0 0 10px', fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.7 }}>
                  Finalizing records this settlement and does the three things that used to be left to you:
                  it closes {result.advanceRecovered > 0 ? 'the recovered advances' : 'any recovered advances'},
                  marks {emp.full_name} as {reason === 'termination' ? 'terminated' : reason === 'retirement' ? 'inactive' : 'resigned'} with
                  their last working date, and blocks their Crest Staff login.
                </p>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button className="btn btn-ghost" disabled={busy || ytdFailed} onClick={saveDraft}>{current ? 'Update draft' : 'Save draft'}</button>
                  <button className="btn btn-primary" disabled={busy || ytdFailed} onClick={requestFinalize}>
                    {busy ? 'Working…' : 'Finalize settlement'}
                  </button>
                </div>
              </>
            )}
            {msg && (
              <p role={msg.startsWith('error') ? 'alert' : 'status'} style={{
                margin: '10px 0 0', fontSize: 13, lineHeight: 1.6,
                color: msg.startsWith('error') ? 'var(--theme-red-text)' : 'var(--theme-green-text)',
              }}>{msg.replace(/^(ok|error):/, '')}</p>
            )}
          </div>
        </div>
      )}

      {/* ── Settlement history ─────────────────────────────────────
          The artefact the feature exists to produce. Without it a settlement was a printout and
          nothing else — "what did we pay them, and how was gratuity worked out?" had no answer
          inside the system. */}
      {settlements.length > 0 && (
        <div className="card no-print" style={{ padding: 0, marginTop: 20 }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--theme-border)', fontWeight: 600, fontSize: 13 }}>
            Settlement history
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Last working day</th>
                  <th>Reason</th>
                  <th style={{ textAlign: 'right' }}>Net payout (NPR)</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {settlements.map(x => (
                  <tr key={x.id}>
                    {/* The frozen name, not a live lookup — the employee row may since have been
                        edited or deleted, and this document should still read correctly. */}
                    <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>
                      {x.employee_name || '—'}
                      {x.employee_code ? <span style={{ color: 'var(--theme-text3)' }}> · {x.employee_code}</span> : null}
                    </td>
                    <td className="num">{x.last_working_date}</td>
                    <td style={{ textTransform: 'capitalize' }}>{x.separation_reason}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }} className="num">{fmt(x.net_payout)}</td>
                    <td>
                      {x.status === 'finalized'
                        ? (x.paid_at ? <span className="badge-green">Paid</span> : <span className="badge-yellow">Finalized</span>)
                        : <span className="badge-gray">Draft</span>}
                    </td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button className="btn btn-ghost btn-sm" onClick={() => openSettlement(x)}>Open</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Refusals are shown as a dialog rather than an inline warning: each one means money would
          be paid twice, and the operator has to read it before doing anything else. */}
      {refusal && (
        <ConfirmModal
          title="This settlement cannot be finalized"
          confirmLabel="I understand"
          cancelLabel="Close"
          onConfirm={() => setRefusal(null)}
          onCancel={() => setRefusal(null)}
        >
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {refusal.map((r, i) => <li key={i} style={{ marginBottom: 8 }}>{r}</li>)}
          </ul>
        </ConfirmModal>
      )}

      {confirmOpen && emp && result && (
        <ConfirmModal
          title={'Finalize ' + emp.full_name + "'s settlement?"}
          confirmLabel="Finalize"
          busyLabel="Finalizing…"
          busy={busy}
          danger
          onConfirm={finalize}
          onCancel={() => setConfirmOpen(false)}
        >
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            <li><strong>NPR {fmt(result.netPayout)}</strong> net payable{result.netPayout < 0 ? ' (recoverable from the employee)' : ''}.</li>
            {result.advanceRecovered > 0 && (
              <li>
                <strong>NPR {fmt(result.advanceRecovered)}</strong> recovered against outstanding advances, which are then closed
                so the next payroll run cannot deduct them again.
              </li>
            )}
            {result.advanceShortfall > 0.01 && (
              <li style={{ color: 'var(--theme-amber-text)' }}>
                <strong>NPR {fmt(result.advanceShortfall)}</strong> of advance is NOT covered by this payout, so that advance stays
                active and open — the money has not been repaid.
              </li>
            )}
            <li>
              {emp.full_name} becomes <strong>{reason === 'termination' ? 'terminated' : reason === 'retirement' ? 'inactive' : 'resigned'}</strong>,
              with an end date of {formatAd(bsToAd(lastDate.year, lastDate.month, lastDate.day))}. They leave every payroll, roster and attendance screen.
            </li>
            <li>Their Crest Staff login is blocked.</li>
            {parseFloat(leaveDays) > 0 && (
              <li>{leaveDays} leave day(s) are recorded as encashed and come off their balance.</li>
            )}
          </ul>
        </ConfirmModal>
      )}

      {reopenTarget && (
        <ConfirmModal
          title="Reopen this settlement?"
          confirmLabel="Reopen"
          busyLabel="Reopening…"
          busy={busy}
          danger
          onConfirm={() => reopen(reopenTarget)}
          onCancel={() => setReopenTarget(null)}
        >
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            <li>The advances this settlement recovered are reactivated with their balances restored.</li>
            <li>
              {reopenTarget.employee_name} goes back to <strong>{reopenTarget.prior_status || 'active'}</strong>, with their
              previous end date and login access.
            </li>
            <li>The settlement becomes a draft again. The document you printed will no longer match it until you re-finalize.</li>
          </ul>
        </ConfirmModal>
      )}
    </div>
  )
}