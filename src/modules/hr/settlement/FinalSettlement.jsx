import { nprInt, npr2 } from '../../../shared/nepalMoney'
import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'
import Modal from '../../../components/Modal'
import ConfirmModal from '../../../components/ConfirmModal'
import ReportLoadError from '../../../components/ReportLoadError'
import { BS_MONTHS, bsToAd, daysInBsMonth, getBsToday, formatAd, adToBs } from '../../../utils/bsCalendar'
import { fiscalYearOf } from '../payroll/tds'
import { printWithTitle } from '../../../utils/printTitle'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import { fetchSsfContributions } from '../gratuity/ssfEnrolment'
import { leaveUsed, leaveEncashed } from '../leave/leaveBalance'
import { fetchYtdMap } from '../payroll/payrollData'
import { bonusFiscalYear } from '../payroll/bonusTax'
import { firstError } from '../../../shared/queryError'
import { errorLine } from '../../../shared/errorText'
import { nepalDateAd } from '../../../shared/nepalTime'
import { computeSettlement, earnedLeaveBalance, noticeDirection, settlementColumns, LEAVE_DAY_DIVISOR, NOTICE_DAY_DIVISOR } from './settlementCompute'

const fmt = nprInt
const EMPLOYEE_COLUMNS = 'id, full_name, employee_code, join_date, basic_salary, pay_basis, ssf_enrolled, ssf_no, marital_status, life_insurance_premium, health_insurance_premium, department, status, end_date, access_blocked'
const STATUS_AFTER = { resignation: 'resigned', mutual: 'resigned', termination: 'terminated', retirement: 'inactive' }

const amberBanner = {
  marginBottom: 12, padding: '10px 16px', fontSize: 12, lineHeight: 1.7, color: 'var(--theme-text2)',
  borderColor: 'color-mix(in srgb, var(--theme-amber) 35%, transparent)',
  background: 'color-mix(in srgb, var(--theme-amber) 8%, transparent)',
}

// Format service as "X yr Y mo"
function fmtService(months) {
  const y = Math.floor(months / 12)
  const m = months % 12
  if (y === 0) return `${m} mo`
  if (m === 0) return `${y} yr`
  return `${y} yr ${m} mo`
}

function BsDateSelect({ id, label, year, month, day, onChange, tip, disabled }) {
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
        <select id={`${id}-year`} className="form-select" value={year} disabled={disabled} onChange={e => set({ year: +e.target.value })}>
          {yearRange.map(y => <option key={y} value={y}>{y}</option>)}
        </select>
        <select id={`${id}-month`} aria-label={`${label} — month`} className="form-select" value={month} disabled={disabled} onChange={e => set({ month: +e.target.value })}>
          {BS_MONTHS.map((n, i) => <option key={i+1} value={i+1}>{n}</option>)}
        </select>
        <select id={`${id}-day`} aria-label={`${label} — day`} className="form-select" value={Math.min(day, daysInMonth)} disabled={disabled} onChange={e => set({ day: +e.target.value })}>
          {Array.from({ length: daysInMonth }, (_, i) => i + 1).map(d => <option key={d} value={d}>{d}</option>)}
        </select>
      </div>
    </div>
  )
}

// ── The statement, from ONE row shape ─────────────────────────────────────────────────────────
// A live calculation is turned into exactly the columns a saved row stores (settlementColumns), so a
// draft on screen, a finalized settlement and its reprint all render through this one function. It
// used to recompute an opened settlement from today's data: a finalized one reprinted with advance
// recovery 0 (those advances were now settled by it) and today's salary beside the old net figure.
function statementOf(row, { advances = null, tadaClaims = null } = {}) {
  const n = k => parseFloat(row?.[k]) || 0
  const v2 = (row?.calc_version || 1) >= 2
  const basic = n('basic_salary')
  const earnings = []
  const deductions = []
  if (v2) {
    const unpaid = n('month_unpaid_days')
    earnings.push({
      key: 'month', label: 'Final month salary',
      tip: 'Basic plus allowances for the final month, as payroll computes it: days after the last working day, absences and unpaid leave are taken off.',
      formula: `${fmt(n('month_gross'))}${unpaid > 0 ? ` − ${fmt(n('month_absence_deduction'))} (${Math.round(unpaid * 10) / 10} unpaid days)` : ''}`,
      amount: n('month_gross') - n('month_absence_deduction'),
    })
    if (n('month_ot_amount') > 0) {
      earnings.push({ key: 'ot', label: `Overtime (${Math.round(n('month_ot_hours') * 10) / 10} h)`, tip: 'Approved overtime and attendance-sheet overtime up to the last working day, at the payroll rates.', formula: 'final month', amount: n('month_ot_amount') })
    }
  } else if (n('partial_salary') > 0) {
    earnings.push({ key: 'month', label: 'Partial month salary', tip: 'Calculated before S752: gross pay over the month\'s days, with no overtime, SSF or tax on the month.', formula: '', amount: n('partial_salary') })
  }
  if (n('tada_amount') > 0) {
    const claims = tadaClaims && tadaClaims.length > 0 ? tadaClaims.map(c => c.trip_purpose || 'trip').join(', ') : ''
    earnings.push({ key: 'tada', label: 'Travel claims (TADA)', tip: 'Approved travel and allowance claims not yet paid. The settlement pays them and marks them paid.', formula: claims, amount: n('tada_amount') })
  }
  if (n('leave_encashment') > 0) {
    earnings.push({ key: 'leave', label: `Leave encashment (${n('leave_days_encashed')} days)`, tip: `Unused leave earned this year, paid at basic ÷ ${row.day_divisor || LEAVE_DAY_DIVISOR} per day.`, formula: `${fmt(basic)} ÷ ${row.day_divisor || LEAVE_DAY_DIVISOR} × ${n('leave_days_encashed')}`, amount: n('leave_encashment') })
  }
  if (n('gratuity') > 0) {
    earnings.push({
      key: 'gratuity', label: `Gratuity (${fmtService(parseInt(row.service_months, 10) || 0)})${n('gratuity_ssf_covered') > 0 ? ' — net of SSF-funded' : ''}`,
      tip: n('gratuity_ssf_covered') > 0
        ? 'One month\'s basic per year of service, minus the gratuity share of the employer SSF actually contributed during this spell — so it is not paid twice.'
        : 'One month\'s basic per year of completed service (basic ÷ 12 × months).',
      formula: n('gratuity_ssf_covered') > 0
        ? `${fmt(n('gratuity_accrued'))} − ${fmt(n('gratuity_ssf_covered'))} (SSF, ${parseInt(row.gratuity_ssf_months, 10) || 0} mo)`
        : `${fmt(basic)} ÷ 12 × ${parseInt(row.service_months, 10) || 0}`,
      amount: n('gratuity'),
    })
  }
  if (n('festival_pro') > 0) {
    earnings.push({
      key: 'festival', label: 'Festival allowance share',
      tip: 'Festival (Dashain) allowance not yet paid this fiscal year: basic × completed months worked this fiscal year ÷ 12.',
      formula: row.festival_months != null ? `${fmt(basic)} × ${row.festival_months} ÷ 12` : '',
      amount: n('festival_pro'),
    })
  }
  if (n('notice_pay') > 0) {
    earnings.push({ key: 'notice_pay', label: `Notice pay owed (${n('notice_days')} days)`, tip: 'The employment was ended without the notice period being given, so the employer pays it: basic ÷ 30 per calendar day of notice.', formula: `${fmt(basic)} ÷ ${row.notice_divisor || NOTICE_DAY_DIVISOR} × ${n('notice_days')}`, amount: n('notice_pay') })
  }

  if (n('month_ssf_employee') > 0) deductions.push({ key: 'ssf', label: 'SSF — employee 11%', tip: 'The employee\'s Social Security Fund contribution on the final month\'s basic, capped.', formula: 'final month', amount: n('month_ssf_employee') })
  if (n('month_other_deductions') > 0) deductions.push({ key: 'other', label: 'Salary deductions (CIT, etc.)', tip: 'The fixed deductions set up in Pay Setup for this employee, for the final month.', formula: n('month_retirement_contribution') > 0 ? `incl. ${fmt(n('month_retirement_contribution'))} retirement fund` : 'final month', amount: n('month_other_deductions') })
  if (n('month_tds') > 0) deductions.push({ key: 'tds_month', label: 'TDS on final month salary', tip: 'The year\'s income is no longer a projection, so tax is trued up to what was actually earned this fiscal year, less what was already withheld.', formula: 'year to date', amount: n('month_tds') })
  if (n('lump_tds') > 0) deductions.push({ key: 'tds_lump', label: 'TDS on exit payments', tip: 'Tax on gratuity, leave encashment, festival share and notice pay, at the marginal rate above this year\'s actual taxable income.', formula: 'marginal rate', amount: n('lump_tds') })
  if (n('notice_deduction') > 0) deductions.push({ key: 'notice', label: `Notice not served (${n('notice_days')} days)`, tip: 'The employee resigned without serving the notice period: basic ÷ 30 per calendar day of notice.', formula: `${fmt(basic)} ÷ ${row.notice_divisor || NOTICE_DAY_DIVISOR} × ${n('notice_days')}`, amount: n('notice_deduction') })
  if (n('advance_deduction') > 0) {
    if (advances && advances.length > 0) {
      for (const a of advances) {
        deductions.push({ key: `adv-${a.id}`, label: `Advance recovery — ${a.purpose || 'Advance'}`, tip: `Issued ${a.issued_date || '—'}. Outstanding balance recovered from the final payment.`, formula: `${fmt(a.amount)} − repaid`, amount: parseFloat(a.outstanding) || 0 })
      }
    } else {
      deductions.push({ key: 'adv', label: 'Advance recovery', tip: 'Outstanding advances recovered from the final payment.', formula: '', amount: n('advance_deduction') })
    }
  }
  const totalDeductions = deductions.reduce((a, d) => a + d.amount, 0)
  return { earnings, deductions, gross: n('gross_payout'), totalDeductions, net: n('net_payout'), employerSsf: n('month_ssf_employer') }
}

const today = getBsToday()

export default function FinalSettlement() {
  const { clientId, hasHrAccess } = useAuth()
  const { scopedFrom, scopedInsert, scopedUpdate, scopedDelete } = useScopedDb()

  const [employees,  setEmployees]  = useState([])
  const [empListError, setEmpListError] = useState(null)
  const [empId,      setEmpId]      = useState('')
  const [reason,     setReason]     = useState('resignation')
  const [lastDate,   setLastDate]   = useState({ year: today.year, month: today.month, day: today.day })
  const [noticeDays, setNoticeDays] = useState(30)
  const [noticeServed, setNoticeServed] = useState(true)
  const [leaveDays,  setLeaveDays]  = useState('0')
  const [leaveTypeId, setLeaveTypeId] = useState('')
  const [festPaid,   setFestPaid]   = useState(true)

  // Client-wide inputs: salary components, leave types, SSF contributions, the settlement register.
  const [clientData, setClientData] = useState({ status: 'loading', error: null, components: [], leaveTypes: [], ssf: {}, settlements: [] })
  // This employee's inputs for the month they leave in.
  const [empData, setEmpData] = useState({ key: null, status: 'idle', error: null })
  const [reloadTick, setReloadTick] = useState(0)

  const [current,  setCurrent]  = useState(null) // the saved row being viewed, draft or finalized
  const [busy,     setBusy]     = useState(false)
  const [msg,      setMsg]      = useState('')
  const [confirmOpen, setConfirmOpen] = useState(false)
  // The leaver's HR / IMS / POS staff logins Finalize will block (S753). null = still reading, and
  // { error } when the read failed — the dialog says so rather than implying there are none.
  const [linkedLogins, setLinkedLogins] = useState(null)
  const [reopenTarget, setReopenTarget] = useState(null)
  const [reopenReason, setReopenReason] = useState('')

  const clientReq = useLatestRequest()
  const empReq = useLatestRequest()
  // Which prefills have run, so reopening a saved draft keeps its own leave days and festival tick.
  const prefilled = useRef({ leave: null, fest: null })

  const loadEmployees = useCallback(async () => {
    const { data, error } = await scopedFrom('hr_employees', EMPLOYEE_COLUMNS)
      .in('status', ['active', 'probation'])
      .order('full_name')
    if (error) { setEmpListError(error); return }
    setEmpListError(null)
    setEmployees(prev => {
      // Keep a leaver who was added to open their settlement — Finalize takes them off this list.
      const extra = prev.filter(p => !(data || []).some(d => d.id === p.id) && p.id === empId)
      return [...(data || []), ...extra]
    })
  }, [scopedFrom, empId])

  const loadClientData = useCallback(async forClient => {
    clientReq.begin(forClient)
    setClientData(d => ({ ...d, status: 'loading' }))
    const [comps, types, ssf, setts] = await Promise.all([
      // Paged: one row per component per employee, client-wide.
      fetchAllRows(() => scopedFrom('hr_salary_components').order('id')),
      scopedFrom('hr_leave_types').eq('active', true).order('sort_order'),
      fetchSsfContributions(scopedFrom),
      scopedFrom('hr_final_settlements', '*').order('last_working_date', { ascending: false }),
    ])
    if (!clientReq.isCurrent(forClient)) return
    // Every one of these is money on the statement or a guard on it: components are the allowances
    // and CIT, leave types and the register decide the encashable balance, SSF contributions net off
    // gratuity. A failed read here is a failed settlement, never a smaller one (S613/S750).
    const error = firstError([comps, types, ssf, setts])
    if (error) {
      setClientData({ status: 'failed', error, components: [], leaveTypes: [], ssf: {}, settlements: [] })
      return
    }
    const leaveTypes = types.data || []
    setClientData({ status: 'ok', error: null, components: comps.data || [], leaveTypes, ssf: ssf.data || {}, settlements: setts.data || [] })
    setLeaveTypeId(prev => prev || (leaveTypes.find(t => (parseFloat(t.annual_quota) || 0) > 0) || leaveTypes[0])?.id || '')
  }, [scopedFrom]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!clientId) return
    // A client switch must not leave the previous client's employee or settlement on screen.
    setEmpId(''); setCurrent(null); setMsg(''); setLeaveTypeId('')
    loadEmployees()
    loadClientData(clientId)
  }, [clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  const currentKey = clientId && empId ? `${clientId}:${empId}:${lastDate.year}-${lastDate.month}` : null

  // Everything that depends on WHO leaves and in WHICH month.
  useEffect(() => {
    if (!currentKey) { setEmpData({ key: null, status: 'idle', error: null }); return }
    const key = currentKey
    empReq.begin(key)
    setEmpData({ key, status: 'loading', error: null })
    ;(async () => {
      const period = { bs_year: lastDate.year, bs_month: lastDate.month }
      const { fyStart } = fiscalYearOf(lastDate.year, lastDate.month)
      const results = await Promise.all([
        scopedFrom('hr_advances', 'id, amount, purpose, issued_date, status').eq('employee_id', empId).eq('status', 'active'),
        scopedFrom('hr_advance_repayments', 'advance_id, amount').eq('employee_id', empId),
        scopedFrom('hr_leave_requests', 'employee_id, leave_type_id, status, days, start_date').eq('employee_id', empId),
        // Festival rows carry the PAY month (S751); one paid Baisakh–Ashadh sits in bs_year = fyStart + 1.
        scopedFrom('hr_festival_allowances', 'id, festival_name, bs_year, bs_month, amount, tds, status')
          .eq('employee_id', empId).in('bs_year', [fyStart, fyStart + 1]),
        fetchYtdMap(scopedFrom, period).catch(err => ({ data: null, error: err })),
        scopedFrom('monthly_periods', 'id').eq('bs_year', lastDate.year).eq('bs_month', lastDate.month).maybeSingle(),
        scopedFrom('hr_overtime_entries', 'employee_id, bs_day, ot_hours, ot_type')
          .eq('employee_id', empId).eq('bs_year', lastDate.year).eq('bs_month', lastDate.month).eq('status', 'approved'),
        // Every approved, unpaid claim: no later payroll will ever include a leaver (S752, decided).
        scopedFrom('hr_tada_claims', 'id, total_amount, trip_purpose, start_date, end_date')
          .eq('employee_id', empId).eq('status', 'approved').order('id'),
      ])
      if (!empReq.isCurrent(key)) return
      const err = firstError(results)
      if (err) { setEmpData({ key, status: 'failed', error: err }); return }
      const [adv, reps, leave, fest, ytd, per, ot, tada] = results
      let attendance = []
      if (per.data?.id) {
        // One row per employee per day, paged — a truncated read would quietly pay a full month.
        const att = await fetchAllRows(() => scopedFrom('hr_attendance', 'bs_day, status, hours_worked, ot_hours')
          .eq('employee_id', empId).eq('period_id', per.data.id).order('id'))
        if (!empReq.isCurrent(key)) return
        // A failed attendance read is not "nothing marked": it blocks, rather than paying every day.
        if (att.error) { setEmpData({ key, status: 'failed', error: att.error }); return }
        attendance = att.data || []
      }
      const repaid = {}
      ;(reps.data || []).forEach(r => { repaid[r.advance_id] = (repaid[r.advance_id] || 0) + (parseFloat(r.amount) || 0) })
      const advances = (adv.data || [])
        .map(a => ({ ...a, outstanding: Math.max(0, Math.round(((parseFloat(a.amount) || 0) - (repaid[a.id] || 0)) * 100) / 100) }))
        .filter(a => a.outstanding > 0)
      const claims = tada.data || []
      setEmpData({
        key, status: 'ok', error: null,
        advances,
        leaveReqs: leave.data || [],
        festRows: (fest.data || []).filter(f => bonusFiscalYear(f).fyStart === fyStart),
        ytd: (ytd.data || {})[empId] || null,
        attendance,
        attendanceKnown: attendance.length > 0,
        otEntries: ot.data || [],
        tadaClaims: claims,
        tada: { total: claims.reduce((a, c) => a + (parseFloat(c.total_amount) || 0), 0), ids: claims.map(c => c.id) },
      })
    })()
  }, [currentKey, reloadTick]) // eslint-disable-line react-hooks/exhaustive-deps

  const emp = employees.find(e => e.id === empId) || null
  const frozen = current?.status === 'finalized' ? current : null
  const ready = !frozen && !!emp && clientData.status === 'ok' && empData.status === 'ok' && empData.key === currentKey

  // ── Leave: earned this BS year, less taken and already encashed (S752) ──
  const selectedLeaveType = clientData.leaveTypes.find(t => t.id === leaveTypeId) || null
  const encashable = selectedLeaveType ? selectedLeaveType.paid !== false : true
  const leaveBal = useMemo(() => {
    if (!ready || !selectedLeaveType) return null
    const used = leaveUsed(empData.leaveReqs, { employeeId: emp.id, leaveTypeId: selectedLeaveType.id, bsYear: lastDate.year })
    const encashed = leaveEncashed(clientData.settlements.filter(s => s.id !== current?.id),
      { employeeId: emp.id, leaveTypeId: selectedLeaveType.id, bsYear: lastDate.year })
    return earnedLeaveBalance({ quota: selectedLeaveType.annual_quota, used, encashed, joinDate: emp.join_date, lastDate })
  }, [ready, selectedLeaveType, empData, emp, lastDate, clientData.settlements, current])

  // "Paid" means a FINALIZED festival run carrying a real amount — a draft is not a payment.
  const festivalAlreadyPaid = ready && (empData.festRows || []).some(f => f.status === 'finalized' && (parseFloat(f.amount) || 0) > 0)

  // Prefill once per employee/month/leave type — AFTER this employee's leave has loaded. It used to
  // run in the same render the leave read started, so it filled the box from the previous state
  // (nothing taken) and never refreshed: the hint showed the right balance while the box, which is
  // what gets paid, held the whole quota.
  useEffect(() => {
    if (!ready) return
    const leaveKey = `${currentKey}:${leaveTypeId}:${lastDate.day}`
    if (prefilled.current.leave !== leaveKey) {
      prefilled.current.leave = leaveKey
      setLeaveDays(encashable && leaveBal?.capped ? String(leaveBal.remaining) : '0')
    }
    if (prefilled.current.fest !== currentKey) {
      prefilled.current.fest = currentKey
      setFestPaid(festivalAlreadyPaid)
    }
  }, [ready, currentKey, leaveTypeId, lastDate.day, leaveBal, encashable, festivalAlreadyPaid])

  // ── The calculation ──
  const calc = useMemo(() => {
    if (!ready) return null
    const empComponents = clientData.components.filter(c => c.employee_id === emp.id)
    return computeSettlement({
      emp, lastDate, reason, noticeDays, noticeServed,
      leaveDays: encashable ? leaveDays : 0,
      festivalPaid: festPaid,
      components: empComponents,
      attendance: empData.attendance,
      otEntries: empData.otEntries,
      ytd: empData.ytd,
      tada: empData.tada,
      advances: empData.advances,
      ssfRows: clientData.ssf[emp.id] || [],
    })
  }, [ready, clientData, emp, lastDate, reason, noticeDays, noticeServed, leaveDays, encashable, festPaid, empData])

  const liveRow = useMemo(() => calc ? settlementColumns(calc, {
    emp, reason, noticeDays, noticeServed, leaveDays: encashable ? leaveDays : 0, leaveTypeId, festivalPaid: festPaid,
    leaveDaysEarned: leaveBal?.capped ? Math.round(leaveBal.earned * 100) / 100 : null,
  }) : null, [calc, emp, reason, noticeDays, noticeServed, leaveDays, encashable, leaveTypeId, festPaid, leaveBal])

  const shownRow = frozen || liveRow
  const statement = useMemo(() => shownRow ? statementOf(shownRow, frozen ? {} : { advances: empData.advances, tadaClaims: empData.tadaClaims }) : null,
    [shownRow, frozen, empData])

  const direction = noticeDirection(reason)

  // ── Writes ────────────────────────────────────────────────────────────────────────────────────
  // Only a DRAFT is ever written from here. The database refuses anything else (S752), and the
  // `.eq('status', 'draft')` plus the row check make a refusal from a stale tab say so.
  async function writeDraft() {
    const row = { ...liveRow, status: 'draft' }
    if (current && current.status === 'draft' && current.employee_id === emp.id) {
      const { data, error } = await scopedUpdate('hr_final_settlements', row)
        .eq('id', current.id).eq('status', 'draft').select().maybeSingle()
      if (error) { setMsg('error:The draft was not saved. ' + errorLine(error)); return null }
      if (!data) {
        setMsg('error:The draft was not saved — this settlement is no longer a draft on the server (it was finalized or deleted on another screen). Reload the page to see it.')
        return null
      }
      return data
    }
    const { data, error } = await scopedInsert('hr_final_settlements', row, { single: true })
    if (error) { setMsg('error:The draft was not saved. ' + errorLine(error)); return null }
    return data
  }

  async function saveDraft() {
    if (!liveRow) return
    setBusy(true); setMsg('')
    const saved = await writeDraft()
    setBusy(false)
    if (!saved) return
    setCurrent(saved)
    await loadClientData(clientId)
    setMsg('ok:Draft saved.')
  }

  // Finalize is ONE database transaction (finalize_final_settlement). It re-reads the advances, the
  // travel claims, payroll for the month and any other finalized settlement, refuses if anything
  // moved since this screen calculated, and writes every ledger — or nothing.
  const confirmEmpId = confirmOpen ? liveRow?.employee_id : null
  useEffect(() => {
    if (!confirmEmpId) { setLinkedLogins(null); return }
    let live = true
    setLinkedLogins(null)
    supabase.rpc('settlement_linked_logins', { p_employee_id: confirmEmpId }).then(({ data, error }) => {
      if (live) setLinkedLogins(error ? { error } : (data || []))
    })
    return () => { live = false }
  }, [confirmEmpId])

  async function finalize() {
    if (!liveRow) return
    setConfirmOpen(false)
    setBusy(true); setMsg('')
    const saved = await writeDraft()
    if (!saved) { setBusy(false); return }
    setCurrent(saved)
    const { data, error } = await supabase.rpc('finalize_final_settlement', { p_settlement_id: saved.id })
    if (error) {
      setBusy(false)
      setMsg('error:' + errorLine(error) + ' The figures are saved as a draft; nothing else was written.')
      await loadClientData(clientId)
      return
    }
    setCurrent(data)
    await Promise.all([loadClientData(clientId), loadEmployees()])
    setReloadTick(t => t + 1)
    setBusy(false)
    setMsg('ok:Settlement finalized. ' + (data.employee_name || emp.full_name) + ' is now ' + (STATUS_AFTER[data.separation_reason] || 'resigned')
      + '; advances recovered: NPR ' + fmt(data.advance_recovered)
      + ((data.tada_claim_ids || []).length > 0 ? '; ' + data.tada_claim_ids.length + ' travel claim(s) marked paid' : '')
      + ((data.blocked_logins || []).length > 0 ? '; staff login blocked: ' + data.blocked_logins.join(', ') : '') + '.')
  }

  async function reopen() {
    const row = reopenTarget
    if (!row || !reopenReason.trim()) return
    setBusy(true); setMsg('')
    const { data, error } = await supabase.rpc('reopen_final_settlement', { p_settlement_id: row.id, p_reason: reopenReason.trim() })
    setBusy(false)
    if (error) { setMsg('error:' + errorLine(error)); return }
    setReopenTarget(null); setReopenReason('')
    setCurrent(data)
    await loadClientData(clientId)
    setReloadTick(t => t + 1)
    setMsg('ok:Settlement reopened as a draft — its advance recoveries and travel-claim payments were undone. ' + (data.employee_name || 'The employee') + ' is still marked as left; change their status in Employees if they are not leaving after all.')
  }

  async function deleteDraft(row) {
    // A routine single-row delete of a draft, which claims nothing and moved no money.
    if (!window.confirm(`Delete the draft settlement for ${row.employee_name || 'this employee'}? It has not moved any money.`)) return
    setBusy(true); setMsg('')
    const { data, error } = await scopedDelete('hr_final_settlements').eq('id', row.id).eq('status', 'draft').select('id')
    setBusy(false)
    if (error) { setMsg('error:The draft was not deleted. ' + errorLine(error)); return }
    if (!data?.length) { setMsg('error:The draft was not deleted — it is no longer a draft on the server (it may have been finalized on another screen). Reload the page.'); return }
    if (current?.id === row.id) setCurrent(null)
    await loadClientData(clientId)
    setMsg('ok:Draft deleted.')
  }

  async function markPaid(row, method) {
    setBusy(true); setMsg('')
    const { data, error } = await scopedUpdate('hr_final_settlements', { paid_at: new Date().toISOString(), paid_method: method })
      .eq('id', row.id).eq('status', 'finalized').is('paid_at', null).select()
    setBusy(false)
    if (error) { setMsg('error:The settlement was not marked as paid — it still shows as owed. ' + errorLine(error)); return }
    if (!data?.length) { setMsg('error:Nothing was changed — this settlement is already recorded as paid, or was reopened, on another screen. Reload the page.'); return }
    setCurrent(data[0])
    await loadClientData(clientId)
    setMsg('ok:Marked as paid by ' + method.toLowerCase() + '.')
  }

  async function openSettlement(row) {
    if (!employees.some(e => e.id === row.employee_id)) {
      const { data, error } = await scopedFrom('hr_employees', EMPLOYEE_COLUMNS).eq('id', row.employee_id).maybeSingle()
      if (error) { setMsg('error:Could not load this employee\'s record, so the settlement cannot be opened — try again. ' + errorLine(error)); return }
      if (data) setEmployees(prev => prev.some(e => e.id === data.id) ? prev : [...prev, data])
    }
    const [y, m, d] = String(row.last_working_date).split('-').map(Number)
    const bs = adToBs(new Date(y, m - 1, d))
    const key = `${clientId}:${row.employee_id}:${bs.year}-${bs.month}`
    // A saved draft keeps the leave days and festival tick it was saved with.
    prefilled.current = { leave: `${key}:${row.leave_type_id || leaveTypeId}:${bs.day}`, fest: key }
    setEmpId(row.employee_id)
    setReason(row.separation_reason || 'resignation')
    setLastDate({ year: bs.year, month: bs.month, day: bs.day })
    setNoticeDays(row.notice_days ?? 30)
    setNoticeServed(!!row.notice_served)
    setLeaveDays(String(row.leave_days_encashed ?? 0))
    if (row.leave_type_id) setLeaveTypeId(row.leave_type_id)
    setFestPaid(!!row.festival_paid)
    setCurrent(row)
    setMsg('')
    // The app shell owns the scrollport (.layout-root), not the window.
    document.querySelector('.layout-root')?.scrollTo({ top: 0, behavior: 'smooth' })
  }

  function pickEmployee(id) {
    setMsg('')
    // Picking someone else never carries the previous settlement along: "Update draft" used to
    // rewrite whatever row was open, finalized ones included, with the new person's figures.
    const draft = clientData.settlements.find(x => x.employee_id === id && x.status === 'draft')
    if (draft) { openSettlement(draft); return }
    setCurrent(null)
    setEmpId(id)
  }

  function handlePrint() {
    const name = shownRow?.employee_name || emp?.full_name || 'employee'
    printWithTitle(`Final Settlement - ${name}${frozen ? '' : ' (DRAFT)'}`)
  }

  if (!hasHrAccess('manager')) return <Navigate to="/dashboard" replace />

  const inputsBlocked = clientData.status !== 'ok' || (empId && !frozen && empData.status !== 'ok')
  const loadFailure = clientData.status === 'failed' ? clientData.error : (empId && empData.status === 'failed' ? empData.error : null)
  const lastAdLabel = formatAd(bsToAd(lastDate.year, lastDate.month, lastDate.day))

  return (
    <div>
      <div className="page-header page-header--split no-print">
        <div>
          <h1 className="page-title">Final Settlement</h1>
          <p className="page-subtitle">Resignation / termination payout: the final month, exit payments and recoveries</p>
        </div>
        {statement && (
          <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={handlePrint}>🖨 Print</button>
        )}
      </div>

      {empListError && (
        <div className="no-print" style={{ marginBottom: 12 }}>
          <ReportLoadError error={empListError} />
        </div>
      )}

      {/* ── Inputs ────────────────────────────────────────── */}
      <div className="card no-print" style={{ padding: 20, marginBottom: 20 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 16 }}>

          <div>
            <label style={{ display: 'block', fontSize: 12, color: 'var(--theme-text3)', marginBottom: 5 }} htmlFor="settle-employee">Employee</label>
            <select id="settle-employee" className="form-select" value={empId} disabled={busy} onChange={e => pickEmployee(e.target.value)}>
              <option value="">— Select employee —</option>
              {employees.filter(e => (e.pay_basis || 'monthly') === 'monthly' || e.id === empId).map(e => (
                <option key={e.id} value={e.id}>{e.full_name}{e.employee_code ? ` (${e.employee_code})` : ''}</option>
              ))}
            </select>
            <p style={{ margin: '5px 0 0', fontSize: 11, color: 'var(--theme-text3)', lineHeight: 1.6 }}>
              Monthly-salaried employees only — settlement for daily and hourly staff isn't supported yet.
              {' '}Someone already marked resigned, terminated or inactive is not listed: settle them first,
              {' '}and Finalize sets that status for you. If they were marked by hand already, set them back to
              {' '}Probation in HR → Employees to settle them.
            </p>
          </div>

          <div>
            <label style={{ display: 'block', fontSize: 12, color: 'var(--theme-text3)', marginBottom: 5 }} htmlFor="settle-reason">Separation Reason</label>
            <select id="settle-reason" className="form-select" value={reason} disabled={!!frozen} onChange={e => setReason(e.target.value)}>
              <option value="resignation">Resignation</option>
              <option value="termination">Termination</option>
              <option value="retirement">Retirement</option>
              <option value="mutual">Mutual Separation</option>
            </select>
          </div>

          <div style={{ gridColumn: 'span 2' }}>
            <BsDateSelect
              id="settle-last-date"
              label="Last Working Date (BS)"
              tip="The last day the employee worked, in full. The final month is paid to this day, and service is counted to the end of it."
              year={lastDate.year} month={lastDate.month} day={lastDate.day}
              onChange={setLastDate}
              disabled={!!frozen}
            />
          </div>

          <div>
            <label style={{ display: 'block', fontSize: 12, color: 'var(--theme-text3)', marginBottom: 5 }} htmlFor="settle-leave-days">
              <Tip text={`Unused leave to pay out, at basic ÷ ${LEAVE_DAY_DIVISOR} per day. Filled in with the leave EARNED this BS year — the yearly quota × completed months worked ÷ 12 — less days taken and already paid out.`} width={280}>Unused Leave Days</Tip>
            </label>
            <input id="settle-leave-days" type="number" className="form-input form-input--auto" min={0} max={365}
              value={leaveDays} disabled={!encashable || !!frozen}
              onChange={e => setLeaveDays(e.target.value)} />
            {clientData.leaveTypes.length > 0 && (
              <select aria-label="Leave type being encashed" className="form-select" style={{ width: '100%', marginTop: 6 }}
                value={leaveTypeId} disabled={!!frozen} onChange={e => setLeaveTypeId(e.target.value)}>
                {clientData.leaveTypes.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            )}
            {!frozen && ready && (!encashable ? (
              <p style={{ margin: '5px 0 0', fontSize: 11, color: 'var(--theme-amber-text)', lineHeight: 1.6 }}>
                {selectedLeaveType?.name} is unpaid leave — there is no accrued value to buy back, so nothing is encashed.
              </p>
            ) : leaveBal?.capped ? (
              <p style={{ margin: '5px 0 0', fontSize: 11, color: 'var(--theme-text3)', lineHeight: 1.6 }}>
                BS {lastDate.year}: {fmt(leaveBal.quota)} a year × {leaveBal.monthsWorked} of 12 months worked = {Math.round(leaveBal.earned * 10) / 10} earned
                {' '}− {leaveBal.used} taken{leaveBal.encashed > 0 ? ` − ${leaveBal.encashed} already paid out` : ''} = <strong>{leaveBal.remaining} days</strong>.
                {' '}Carry-forward from earlier years is not included — the app does not track it.
              </p>
            ) : (
              <p style={{ margin: '5px 0 0', fontSize: 11, color: 'var(--theme-text3)', lineHeight: 1.6 }}>
                {selectedLeaveType?.name} has no annual quota, so there is no balance to encash from — enter the days yourself if this type is genuinely being paid out.
              </p>
            ))}
          </div>

          <div>
            <label style={{ display: 'block', fontSize: 12, color: 'var(--theme-text3)', marginBottom: 5 }} htmlFor="settle-notice-days">
              <Tip text="The notice period in the employment contract, in calendar days. Notice pay is basic ÷ 30 per day." width={280}>Notice Period (days)</Tip>
            </label>
            <input id="settle-notice-days" type="number" className="form-input form-input--auto" min={0} max={90}
              value={noticeDays} disabled={!direction || !!frozen} onChange={e => setNoticeDays(e.target.value)} />
            <p style={{ margin: '5px 0 0', fontSize: 11, color: 'var(--theme-text3)', lineHeight: 1.6 }}>
              {direction === 'deduct' ? 'Resigned without serving notice: the employee owes it, and it is deducted.'
                : direction === 'add' ? 'Terminated without notice: the employer owes it, and it is added.'
                : 'No notice pay either way for a mutual separation or a retirement.'}
            </p>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, justifyContent: 'flex-end', paddingBottom: 2 }}>
            {direction && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--theme-text1)', cursor: 'pointer' }}>
                <input type="checkbox" checked={noticeServed} disabled={!!frozen} onChange={e => setNoticeServed(e.target.checked)} />
                <Tip text={direction === 'deduct'
                  ? 'Tick if the employee worked their full notice period. Untick and the notice period is deducted from the settlement.'
                  : 'Tick if the employee was given their full notice period. Untick and the employer pays the notice period in the settlement.'} width={280}>
                  {direction === 'deduct' ? 'Notice period served' : 'Notice period given'}
                </Tip>
              </label>
            )}
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--theme-text1)', cursor: 'pointer' }}>
              <input type="checkbox" checked={festPaid} disabled={!!frozen} onChange={e => setFestPaid(e.target.checked)} />
              <Tip text="Tick if the employee has already received their festival (Dashain) allowance this fiscal year. Untick and a share for the completed months worked this fiscal year is paid." width={300}>Festival allowance paid this FY</Tip>
            </label>
          </div>
        </div>
      </div>

      {/* ── Result ────────────────────────────────────────── */}
      {!empId && !loadFailure && (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text2)' }}>
          Select an employee to calculate their final settlement.
        </div>
      )}

      {/* A failed read is not a smaller settlement: nothing below is shown or saved until it loads. */}
      {loadFailure && !frozen && (
        <div className="no-print" style={{ marginBottom: 16 }}>
          <ReportLoadError error={loadFailure} />
          <p style={{ fontSize: 12, color: 'var(--theme-text2)', margin: '8px 0 0' }}>
            Until this loads the settlement cannot be calculated, saved or finalized — a missing salary component, advance,
            leave record or SSF contribution would change what the leaver is paid. Reload the page to try again.
          </p>
        </div>
      )}

      {empId && !frozen && !loadFailure && !ready && (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text2)' }}>Loading this employee's pay, leave, advances and claims…</div>
      )}

      {shownRow && statement && (
        <div>
          {!frozen && calc && !empData.attendanceKnown && (
            <div role="alert" className="card no-print" style={amberBanner}>
              <strong style={{ color: 'var(--theme-amber-text)' }}>No attendance is marked for {BS_MONTHS[lastDate.month - 1]} {lastDate.year}</strong>
              <div>The final month is paid for every day up to the last working day — any absence or unpaid leave in it is not deducted.
              Mark it in HR → Attendance first if it matters: once this settlement is finalized {emp?.full_name} leaves the attendance sheet.</div>
            </div>
          )}
          {current?.reopened_at && current.status === 'draft' && (
            <div className="card no-print" style={amberBanner}>
              <strong style={{ color: 'var(--theme-amber-text)' }}>Reopened {nepalDateAd(current.reopened_at)}</strong>
              <div>Reason: {current.reopen_reason}. {current.paid_at ? `It had been recorded as paid (NPR ${fmt(current.paid_amount)} by ${String(current.paid_method || '').toLowerCase()}) — that record is kept.` : ''}</div>
            </div>
          )}

          {/* Print header (hidden on screen). A draft says so on paper. */}
          <div className="print-only" style={{ marginBottom: 24 }}>
            <h2 style={{ margin: 0 }}>Final Settlement Statement{frozen ? '' : ' — DRAFT'}</h2>
            <div style={{ fontSize: 13, marginTop: 4 }}>
              {shownRow.employee_name}{shownRow.employee_code ? ` · ${shownRow.employee_code}` : ''}{shownRow.department ? ` · ${shownRow.department}` : ''}
            </div>
            <div style={{ fontSize: 12, marginTop: 2 }}>
              Last working date: {shownRow.last_working_date} ({frozen ? '' : `${lastDate.day} ${BS_MONTHS[lastDate.month - 1]} ${lastDate.year} BS · `}AD) ·
              {' '}Service: {fmtService(parseInt(shownRow.service_months, 10) || 0)} ·
              {' '}Reason: {String(shownRow.separation_reason || '').charAt(0).toUpperCase() + String(shownRow.separation_reason || '').slice(1)}
            </div>
            <div style={{ fontSize: 12, marginTop: 2 }}>
              {frozen
                ? `Finalized ${nepalDateAd(frozen.finalized_at)}${frozen.paid_at ? ` · Paid NPR ${fmt(frozen.paid_amount ?? frozen.net_payout)} by ${String(frozen.paid_method || '').toLowerCase()} on ${nepalDateAd(frozen.paid_at)}` : ' · Not yet paid'}`
                : current ? 'Draft — not finalized. These figures are not a payment record.' : 'Not saved — a calculation only.'}
            </div>
          </div>

          <div className="card no-print" style={{ padding: '14px 18px', marginBottom: 16, display: 'flex', gap: 24, flexWrap: 'wrap', fontSize: 13 }}>
            <div><span style={{ color: 'var(--theme-text2)' }}>Employee: </span><strong>{shownRow.employee_name}</strong></div>
            <div><span style={{ color: 'var(--theme-text2)' }}>Basic: </span><strong>NPR {fmt(shownRow.basic_salary)}</strong></div>
            <div><span style={{ color: 'var(--theme-text2)' }}>Service: </span><strong>{fmtService(parseInt(shownRow.service_months, 10) || 0)}</strong></div>
            <div><span style={{ color: 'var(--theme-text2)' }}>Gratuity: </span>
              <Tip text={`The ${shownRow.vesting_months || 12}-month threshold is a commonly applied assumption, not something confirmed in the current Labour Act 2074 text — Sections 52/53 read as accruing monthly from day 1. Service counts completed months only. Verify with an accountant before finalizing a settlement for anyone close to the threshold.`} width={340}>
                {(parseInt(shownRow.service_months, 10) || 0) >= (shownRow.vesting_months || 12)
                  ? <span className="badge-green">Vested</span>
                  : <span className="badge-amber">Not vested ({parseInt(shownRow.service_months, 10) || 0} / {shownRow.vesting_months || 12} mo)</span>}
              </Tip>
            </div>
            <div>
              <span style={{ color: 'var(--theme-text2)' }}>Status: </span>
              {frozen
                ? (frozen.paid_at ? <span className="badge-green">Paid</span> : <span className="badge-yellow">Finalized</span>)
                : current ? <span className="badge-gray">Draft</span> : <span className="badge-gray">Not saved</span>}
            </div>
          </div>

          <StatementTable title="Payments" lines={statement.earnings} totalLabel="Gross Payout" total={statement.gross} tone="green" />
          {statement.deductions.length > 0 && (
            <StatementTable title="Deductions" lines={statement.deductions} totalLabel="Total Deductions" total={statement.totalDeductions} tone="red" />
          )}

          <div className="card" style={{ padding: '18px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: 12, color: 'var(--theme-text2)', marginBottom: 4 }}>NET SETTLEMENT AMOUNT</div>
              <div style={{ fontSize: 11, color: 'var(--theme-text2)' }}>Gross NPR {fmt(statement.gross)} − Deductions NPR {fmt(statement.totalDeductions)}</div>
            </div>
            <div style={{ fontSize: 24, fontWeight: 800, color: statement.net >= 0 ? 'var(--theme-green-text)' : 'var(--theme-red-text)' }}>
              NPR {npr2(Math.abs(statement.net))}
              {statement.net < 0 && <span style={{ fontSize: 13, marginLeft: 8, color: 'var(--theme-red-text)' }}>(owed by the employee)</span>}
            </div>
          </div>

          {statement.employerSsf > 0 && (
            <p style={{ margin: '10px 0 0', fontSize: 12, color: 'var(--theme-text2)' }}>
              Employer SSF (20%) for the final month, not paid to the employee: <strong>NPR {fmt(statement.employerSsf)}</strong> — deposit it with the employee's 11% (it appears on HR Reports → SSF Challan for {BS_MONTHS[(shownRow.settle_bs_month || lastDate.month) - 1]}).
            </p>
          )}
          {!frozen && calc && calc.advanceShortfall > 0.01 && (
            <p style={{ margin: '10px 0 0', fontSize: 12, color: 'var(--theme-amber-text)' }}>
              △ The payout covers NPR {fmt(calc.advanceRecovered)} of the NPR {fmt(calc.advanceDeduction)} advances owed. The other NPR {fmt(calc.advanceShortfall)} stays owed on the advance after Finalize.
            </p>
          )}

          <div style={{ marginTop: 12, fontSize: 11, color: 'var(--theme-text2)', lineHeight: 1.7 }} className="no-print">
            <strong style={{ color: 'var(--theme-text2)' }}>Notes:</strong>
            {' '}The final month is computed the way payroll computes a month — allowances, overtime, SSF, salary deductions — and
            {' '}its tax is trued up to what was actually earned this fiscal year. Exit payments are taxed at the marginal rate above that.
            {' '}Tax on retirement and gratuity payments can have special treatment; consult your CA before disbursing.
          </div>

          {/* ── Actions ── */}
          <div className="card no-print" style={{ marginTop: 16, padding: '14px 18px' }}>
            {frozen ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ fontSize: 13, color: 'var(--theme-text2)' }}>
                  Finalized {nepalDateAd(frozen.finalized_at)}.{' '}
                  {frozen.paid_at
                    ? <>Paid NPR {fmt(frozen.paid_amount ?? frozen.net_payout)} by {String(frozen.paid_method || '').toLowerCase()} on {nepalDateAd(frozen.paid_at)}.</>
                    : <>Not yet recorded as paid.</>}
                  {parseFloat(frozen.advance_recovered) > 0 && <> NPR {fmt(frozen.advance_recovered)} of advances recovered.</>}
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {!frozen.paid_at && (
                    <>
                      <button className="btn btn-ghost" disabled={busy} onClick={() => markPaid(frozen, 'Cash')}>Mark paid — Cash</button>
                      <button className="btn btn-ghost" disabled={busy} onClick={() => markPaid(frozen, 'Bank')}>Mark paid — Bank</button>
                    </>
                  )}
                  <button className="btn btn-danger" disabled={busy} onClick={() => { setReopenReason(''); setReopenTarget(frozen) }}>Reopen</button>
                </div>
              </div>
            ) : (
              <>
                <p style={{ margin: '0 0 10px', fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.7 }}>
                  Finalizing records this settlement and, in one step: recovers the outstanding advances, marks the travel claims paid,
                  marks {shownRow.employee_name} as {STATUS_AFTER[reason]} with their last working date, and blocks new sign-ins to Crest Staff.
                </p>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button className="btn btn-ghost" disabled={busy || inputsBlocked || !liveRow} onClick={saveDraft}>{current ? 'Update draft' : 'Save draft'}</button>
                  <button className="btn btn-primary" disabled={busy || inputsBlocked || !liveRow} onClick={() => setConfirmOpen(true)}>
                    {busy ? 'Working…' : 'Finalize settlement'}
                  </button>
                  {current?.status === 'draft' && (
                    <button className="btn btn-ghost" disabled={busy} onClick={() => deleteDraft(current)}>Delete draft</button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {msg && (
        <p role={msg.startsWith('error') ? 'alert' : 'status'} className="no-print" style={{
          margin: '12px 0 0', fontSize: 13, lineHeight: 1.6,
          color: msg.startsWith('error') ? 'var(--theme-red-text)' : 'var(--theme-green-text)',
        }}>{msg.replace(/^(ok|error):/, '')}</p>
      )}

      {/* ── Settlement history ── */}
      {clientData.settlements.length > 0 && (
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
                {clientData.settlements.map(x => (
                  <tr key={x.id}>
                    <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>
                      {x.employee_name || '—'}
                      {x.employee_code ? <span style={{ color: 'var(--theme-text3)' }}> · {x.employee_code}</span> : null}
                    </td>
                    <td className="num" style={{ whiteSpace: 'nowrap' }}>{x.last_working_date}</td>
                    <td style={{ textTransform: 'capitalize' }}>{x.separation_reason}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }} className="num">{fmt(x.net_payout)}</td>
                    <td>
                      {x.status === 'finalized'
                        ? (x.paid_at ? <span className="badge-green">Paid</span> : <span className="badge-yellow">Finalized</span>)
                        : <span className="badge-gray">Draft{x.reopened_at ? ' · reopened' : ''}</span>}
                    </td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => openSettlement(x)}>Open</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {confirmOpen && liveRow && statement && (
        <ConfirmModal
          title={'Finalize ' + liveRow.employee_name + "'s settlement?"}
          confirmLabel="Finalize"
          busyLabel="Finalizing…"
          busy={busy}
          danger
          onConfirm={finalize}
          onCancel={() => setConfirmOpen(false)}
        >
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            <li><strong>NPR {npr2(statement.net)}</strong> net payable{statement.net < 0 ? ' — owed BY the employee' : ''}.</li>
            {calc?.advanceRecovered > 0 && (
              <li><strong>NPR {fmt(calc.advanceRecovered)}</strong> recovered against outstanding advances{calc.advanceShortfall > 0.01 ? `; NPR ${fmt(calc.advanceShortfall)} stays owed` : ', which then close'}.</li>
            )}
            {(liveRow.tada_claim_ids || []).length > 0 && (
              <li>{liveRow.tada_claim_ids.length} approved travel claim(s), NPR {fmt(liveRow.tada_amount)}, are paid here and marked paid.</li>
            )}
            <li>
              {liveRow.employee_name} becomes <strong>{STATUS_AFTER[reason]}</strong> with an end date of {lastAdLabel}, and leaves every payroll, roster and attendance screen.
            </li>
            <li>Their Crest Staff app access is turned off, and a phone already signed in is signed out.</li>
            <li>
              {linkedLogins === null
                ? 'Checking for an HR, IMS or POS staff login…'
                : linkedLogins.error
                  ? 'Could not check for an HR, IMS or POS staff login — any linked to this employee are still blocked.'
                  : linkedLogins.length === 0
                    ? 'No HR, IMS or POS staff login is linked to this employee. A login created without linking it to their employee record is not found — check the Staff pages.'
                    : <>Their staff login{linkedLogins.length === 1 ? '' : 's'} {linkedLogins.map(l => `${l.full_name} (${l.modules})`).join(', ')} {linkedLogins.length === 1 ? 'is' : 'are'} <strong>blocked</strong> — not deleted, so their name stays on everything they recorded. Reopen unblocks {linkedLogins.length === 1 ? 'it' : 'them'}.</>}
            </li>
            {parseFloat(liveRow.leave_days_encashed) > 0 && <li>{liveRow.leave_days_encashed} leave day(s) are recorded as paid out and come off their balance.</li>}
            <li>If anything changed since this screen calculated — an advance, a claim, payroll for the month — nothing is finalized and you are told what.</li>
          </ul>
        </ConfirmModal>
      )}

      {reopenTarget && (
        <Modal title="Reopen this settlement?" onClose={busy ? () => {} : () => setReopenTarget(null)} maxWidth={480}>
          <ul style={{ margin: '0 0 14px', paddingLeft: 18, fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.6 }}>
            <li>The advance recoveries it made are removed, so those advances are owed again.</li>
            <li>The travel claims it paid go back to Approved.</li>
            <li>{reopenTarget.employee_name} stays marked as left. If they are not leaving after all, change their status in Employees.</li>
            {(reopenTarget.blocked_logins || []).length > 0 && <li>The staff login{reopenTarget.blocked_logins.length === 1 ? '' : 's'} it blocked ({reopenTarget.blocked_logins.join(', ')}) can sign in again.</li>}
            {reopenTarget.paid_at && <li>It was recorded as paid (NPR {fmt(reopenTarget.paid_amount ?? reopenTarget.net_payout)}); that record is kept.</li>}
            <li>The settlement becomes a draft. A printed copy no longer matches it until it is finalized again.</li>
          </ul>
          <label htmlFor="settle-reopen-reason" style={{ display: 'block', fontSize: 12, color: 'var(--theme-text3)', marginBottom: 5 }}>Why is it being reopened? (kept on the record)</label>
          <textarea id="settle-reopen-reason" className="form-input" rows={3} value={reopenReason} onChange={e => setReopenReason(e.target.value)} disabled={busy} />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
            <button type="button" className="btn btn-ghost" onClick={() => setReopenTarget(null)} disabled={busy}>Cancel</button>
            <button type="button" className="btn btn-danger" onClick={reopen} disabled={busy || !reopenReason.trim()}>{busy ? 'Reopening…' : 'Reopen'}</button>
          </div>
        </Modal>
      )}
    </div>
  )
}

function StatementTable({ title, lines, totalLabel, total, tone }) {
  return (
    <div className="card" style={{ padding: 0, marginBottom: 12 }}>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--theme-border)', fontWeight: 600, fontSize: 13 }}>{title}</div>
      <div className="table-wrap">
        <table className="data-table" style={{ tableLayout: 'fixed' }}>
          <colgroup>
            <col style={{ width: '50%' }} />
            <col style={{ width: '30%' }} />
            <col style={{ width: '20%' }} />
          </colgroup>
          <thead>
            <tr>
              <th>Component</th>
              <th style={{ textAlign: 'right' }}>Working</th>
              <th style={{ textAlign: 'right' }}>Amount (NPR)</th>
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 && (
              <tr><td colSpan={3} style={{ color: 'var(--theme-text2)' }}>Nothing.</td></tr>
            )}
            {lines.map(l => (
              <tr key={l.key}>
                <td><Tip text={l.tip} width={300}>{l.label}</Tip></td>
                <td style={{ textAlign: 'right', color: 'var(--theme-text2)', fontSize: 12 }}>{l.formula}</td>
                <td style={{ textAlign: 'right', fontWeight: 600, color: tone === 'red' ? 'var(--theme-red-text)' : undefined }}>{fmt(l.amount)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td>{totalLabel}</td>
              <td></td>
              <td style={{ textAlign: 'right', fontSize: 15, color: tone === 'red' ? 'var(--theme-red-text)' : 'var(--theme-green-text)' }}>{fmt(total)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  )
}
