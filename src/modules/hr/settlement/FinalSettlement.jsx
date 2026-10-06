import { nprInt, npr2, nprPaisa } from '../../../shared/nepalMoney'
import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'
import Modal from '../../../components/Modal'
import ConfirmModal from '../../../components/ConfirmModal'
import ReportLoadError from '../../../components/ReportLoadError'
import { BS_MONTHS, bsToAd, daysInBsMonth, getBsToday, formatAd, adToBs, adToBsSafe, formatAdAsBs, formatBsDay, BS_YEAR_MIN, BS_YEAR_MAX } from '../../../utils/bsCalendar'
import { fiscalYearOf } from '../payroll/tds'
import { printWithTitle } from '../../../utils/printTitle'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import { fetchSsfContributions } from '../gratuity/ssfEnrolment'
import { leaveUsed, leaveEncashed } from '../leave/leaveBalance'
import { fetchYtdMap } from '../payroll/payrollData'
import { bonusFiscalYear } from '../payroll/bonusTax'
import { firstError } from '../../../shared/queryError'
import { errorLine, isNetworkError } from '../../../shared/errorText'
import { settleWithin, isTimeout } from '../../../utils/withTimeout'
import { nepalDateAd } from '../../../shared/nepalTime'
import { attendanceSignature, computeSettlement, earnedLeaveBalance, isEarlierSpell, noticeDirection, settlementColumns, LEAVE_DAY_DIVISOR, NOTICE_DAY_DIVISOR } from './settlementCompute'
import { settlementAdjustments, settlementPaymentState } from './settlementPayment'
import { splitPlan, loginLabel, moveLine, removeLine, finalizedLoginNote, reopenLoginLines, notUndoneLines } from './settlementLogins'

// The longest a settlement write is waited on (S803). Finalize, Reopen, Mark paid and Record difference
// were bare awaits: a request that never answered left every button disabled with no message, the hang
// S798 PAYROLL-8 bounded on Payroll Run and not here.
const WRITE_MS = 25000
// A dropped connection or a timeout proves nothing about the write: the reply can be lost after the
// database committed. Only a refusal FROM the database says the transaction did not happen.
const outcomeUnknown = err => isTimeout(err) || isNetworkError(err)

const fmt = nprInt

// "15 Poush" for an AD date string, parsed as a local date (a bare YYYY-MM-DD parses as UTC midnight).
function bsDayOf(ad) {
  if (!ad) return '—'
  const [y, m, d] = String(ad).slice(0, 10).split('-').map(Number)
  const bs = adToBs(new Date(y, m - 1, d))
  return formatBsDay(bs.day, bs.month)
}
// "2 Poush 2083 BS (2026-12-17 AD)" for the printed statement, or the AD date alone, marked, outside the
// BS table — never a confident wrong BS date (S798 SETTLEMENT-7).
function bsWithAd(ad) {
  if (!ad) return '—'
  const iso = String(ad).slice(0, 10)
  const [y, m, d] = iso.split('-').map(Number)
  const bs = adToBsSafe(new Date(y, m - 1, d))
  return bs ? `${bs.day} ${BS_MONTHS[bs.month - 1]} ${bs.year} BS (${iso} AD)` : `${iso} (AD)`
}
const bsMonthLabel = r => `${BS_MONTHS[r.bs_month - 1]} ${r.bs_year}`
const PRIOR_STATE = { draft: 'still a draft', not_run: 'not run yet', missing: 'finalized without them' }

// How a settlement was paid, in words: the first payment, then each recorded top-up or money handed
// back (S798 3b). paid_amount already includes the adjustments, so the first payment is the remainder.
function paidLine(row) {
  const pay = settlementPaymentState(row)
  if (!pay.recorded) return ''
  const adj = settlementAdjustments(row)
  const first = Math.round((pay.paid - adj.reduce((s, a) => s + a.amount, 0)) * 100) / 100
  const parts = [`Paid NPR ${fmt(first)} by ${String(row.paid_method || '').toLowerCase()} on ${nepalDateAd(row.paid_at)}`]
  for (const a of adj) {
    parts.push(a.amount >= 0
      ? `NPR ${fmt(a.amount)} more by ${a.method.toLowerCase()}${a.at ? ` on ${nepalDateAd(a.at)}` : ''}`
      : `NPR ${fmt(-a.amount)} handed back (${a.method.toLowerCase()})${a.at ? ` on ${nepalDateAd(a.at)}` : ''}`)
  }
  return parts.join('; ')
}

// The still-to-pay / overpaid sentence for a finalized settlement whose net moved after it was paid.
function differenceLine(row) {
  const pay = settlementPaymentState(row)
  if (pay.state === 'short') return `NPR ${fmt(pay.due)} still to pay — it was finalized again at NPR ${fmt(pay.net)} after NPR ${fmt(pay.paid)} had been paid.`
  if (pay.state === 'over') return `NPR ${fmt(-pay.due)} overpaid — it was finalized again at NPR ${fmt(pay.net)} after NPR ${fmt(pay.paid)} had been paid.`
  return ''
}

// One chip for where a settlement's money stands, on the statement and in the history (S798 3b).
// Amber: something is still required of someone. Brass: decided, money not moved. Green: closed.
function PaymentBadge({ row }) {
  const pay = settlementPaymentState(row)
  if (pay.state === 'short') return <span className="badge-amber">△ NPR {fmt(pay.due)} still to pay</span>
  if (pay.state === 'over') return <span className="badge-amber">△ NPR {fmt(-pay.due)} overpaid</span>
  if (pay.state === 'paid') return <span className="badge-green">Paid</span>
  if (pay.state === 'unpaid') return <span className="badge-yellow">Finalized</span>
  return <span className="badge-gray">Draft{row?.reopened_at ? ' · reopened' : ''}</span>
}

// What finalize_final_settlement would refuse, said before the button is pressed (S798 3b): each with
// what it would cost and where it is fixed. The database checks every one again at Finalize.
function FinalizeBlockers({ name, lastDate, pendingLeave, pendingOt, pendingTada, priorOpen, managerLogins, checkFailures, checks, onRecheck, busy }) {
  const month = BS_MONTHS[lastDate.month - 1]
  const failed = { leave: 'pending leave', ot: 'pending overtime', tada: 'pending travel claims', prior: 'earlier payroll months', logins: 'staff logins' }
  return (
    <div role="status" className="card" style={{ ...amberBanner, marginBottom: 12 }}>
      <strong style={{ color: 'var(--theme-amber-text)' }}>Before this settlement can be finalized</strong>
      <ul style={{ margin: '4px 0 8px', paddingLeft: 18 }}>
        {pendingLeave.length > 0 && (
          <li>
            {pendingLeave.length} leave request{pendingLeave.length === 1 ? '' : 's'} still waiting for a decision
            {' '}({pendingLeave.map(r => r.end_date && r.end_date !== r.start_date ? `${bsDayOf(r.start_date)} – ${bsDayOf(r.end_date)}` : bsDayOf(r.start_date)).join(', ')}).
            {' '}Undecided, those days are paid as worked and paid out again as unused leave, and once the settlement is
            {' '}finalized they can no longer be approved. Approve or reject {pendingLeave.length === 1 ? 'it' : 'each'} in <Link to="/hr/leave">Leave</Link>.
          </li>
        )}
        {pendingOt.length > 0 && (
          <li>
            {pendingOt.length} overtime entr{pendingOt.length === 1 ? 'y' : 'ies'} in {month} still waiting for a decision
            {' '}({pendingOt.map(o => o.bs_day ? formatBsDay(o.bs_day, lastDate.month) : month).join(', ')}).
            {' '}Payroll never includes a leaver again, so overtime approved after the settlement is paid by nobody.
            {' '}Decide {pendingOt.length === 1 ? 'it' : 'each'} in <Link to="/hr/overtime">Overtime</Link>.
          </li>
        )}
        {pendingTada.length > 0 && (
          <li>
            {pendingTada.length} travel claim{pendingTada.length === 1 ? '' : 's'} still waiting for a decision
            {' '}(NPR {fmt(pendingTada.reduce((s, c) => s + (parseFloat(c.total_amount) || 0), 0))}:
            {' '}{pendingTada.map(c => c.trip_purpose || c.destination || 'trip').join(', ')}).
            {' '}The settlement pays approved claims only, so one approved afterwards is paid by nobody.
            {' '}Decide {pendingTada.length === 1 ? 'it' : 'each'} in <Link to="/hr/tada">TADA Claims</Link>.
          </li>
        )}
        {priorOpen.length > 0 && (
          <li>
            Payroll for {priorOpen.map(r => `${bsMonthLabel(r)} (${PRIOR_STATE[r.state] || r.state})`).join(', ')} is not final.
            {' '}The settlement works out the year's tax and the gratuity from finalized months only, so that month would be
            {' '}taxed apart and its gratuity paid twice. Finalize it in <Link to="/hr/payroll">Payroll</Link> first — a month
            {' '}finalized without {name} needs Reopen and Regenerate.
          </li>
        )}
        {managerLogins.length > 0 && (
          <li>
            {managerLogins.map(l => l.full_name).join(', ')} {managerLogins.length === 1 ? 'is an HR Manager login' : 'are HR Manager logins'}, and
            {' '}finalizing blocks {managerLogins.length === 1 ? 'it' : 'them'}. Only the Owner changes an HR manager's login, so only the
            {' '}Owner can finalize this settlement: save the draft and ask them.
          </li>
        )}
        {checkFailures.length > 0 && (
          <li>
            Could not check {checkFailures.map(k => failed[k]).join(', ')}, so Finalize waits until it can
            {' '}({errorLine(checks[checkFailures[0]].error)}).
          </li>
        )}
      </ul>
      <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={onRecheck}>Check again and recalculate</button>
    </div>
  )
}
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
  // Ten years back to a year ahead, inside the calendar table (S768). It was a fixed 2075–2090, which
  // offered three years the table cannot convert and would have gone stale; a stored year outside the
  // window is still listed so an old settlement shows its own date.
  const thisYear = getBsToday().year
  const yearRange = []
  for (let y = Math.max(BS_YEAR_MIN, thisYear - 10); y <= Math.min(BS_YEAR_MAX, thisYear + 1); y++) yearRange.push(y)
  if (year && !yearRange.includes(year)) yearRange.push(year)
  yearRange.sort((a, b) => a - b)

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
  const { clientId, hasHrAccess, isOwner, isAdmin, outlets } = useAuth()
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
  // A saved draft that paid a festival share, opened after a festival run was finalized for this
  // person (S798 GAP-PAY-STATE-3): the share is taken off and the note says why.
  const [festPaidSince, setFestPaidSince] = useState(null)

  // Client-wide inputs: salary components, leave types, SSF contributions, the settlement register.
  const [clientData, setClientData] = useState({ status: 'loading', error: null, components: [], leaveTypes: [], ssf: {}, settlements: [] })
  // This employee's inputs for the month they leave in.
  const [empData, setEmpData] = useState({ key: null, status: 'idle', error: null })
  const [reloadTick, setReloadTick] = useState(0)

  const [current,  setCurrent]  = useState(null) // the saved row being viewed, draft or finalized
  const [busy,     setBusy]     = useState(false)
  const [msg,      setMsg]      = useState('')
  const [confirmOpen, setConfirmOpen] = useState(false)
  // What Finalize would refuse, read before the button is pressed and again when the confirm opens
  // (S798 3b): leave, overtime and travel claims still waiting for a decision (H11), earlier payroll
  // months that are not final (H15), and the leaver's HR / IMS / POS staff logins Finalize will block
  // (S753), with whether one is an HR Manager login (H20). Each part is its rows or { error }.
  const [checks, setChecks] = useState({ key: null })
  // Finalized payroll months that left this person out because the settlement was paying them (S798
  // 3b, H5), for the Reopen dialog and a reopened draft. { key, months } or { key, error }.
  const [skipped, setSkipped] = useState({ key: null })
  // Salary payments recorded for the last month or a later one (S791): the settlement pays that
  // month itself, so Finalize refuses while one stands. null = checking, { error } = could not check.
  const [paidMonths, setPaidMonths] = useState(null)
  // The final month's attendance re-read when the Finalize confirm opens (S798 SETTLEMENT-3).
  // null = checking, { error } = could not check, { moved } = whether it differs from this screen's.
  const [attCheck, setAttCheck] = useState(null)
  const [reopenTarget, setReopenTarget] = useState(null)
  const [reopenReason, setReopenReason] = useState('')

  const clientReq = useLatestRequest()
  const empReq = useLatestRequest()
  // Which prefills have run, so reopening a saved draft keeps its own leave days and festival tick.
  const prefilled = useRef({ leave: null, fest: null, festSync: null })

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
        // end_date bounds a request to this employment and the last working day (S798 ENGINE-3).
        scopedFrom('hr_leave_requests', 'employee_id, leave_type_id, status, days, start_date, end_date').eq('employee_id', empId),
        // Festival rows carry the PAY month (S751); one paid Baisakh–Ashadh sits in bs_year = fyStart + 1.
        scopedFrom('hr_festival_allowances', 'id, festival_name, bs_year, bs_month, amount, tds, status')
          .eq('employee_id', empId).in('bs_year', [fyStart, fyStart + 1]),
        // A festival allowance or incentive paid in the last month counts (S798 BONUS-LEDGERS-4): the
        // settlement trues the year up to actual income, and it is the leaver's last chance.
        fetchYtdMap(scopedFrom, period, { includeSameMonthBonuses: true }).catch(err => ({ data: null, error: err })),
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
  // A settlement from before a rehire (S798 H26) is shown as it was stored, never recomputed: the
  // page computes from the CURRENT record, which zeroes the earlier spell. The database refuses to
  // reopen or finalize it (settlement_rehired); a correction to it is paid by hand.
  const earlierSpell = !!current && isEarlierSpell(current, emp)
  const stored = frozen || (earlierSpell ? current : null)
  const ready = !stored && !!emp && clientData.status === 'ok' && empData.status === 'ok' && empData.key === currentKey

  // ── Leave: earned this BS year, less taken and already encashed (S752) ──
  // Both bounded to this employment and the last working day (S798 ENGINE-3): leave approved for
  // after they leave, and an earlier spell's leave or payout, are not this employment's.
  const selectedLeaveType = clientData.leaveTypes.find(t => t.id === leaveTypeId) || null
  const encashable = selectedLeaveType ? selectedLeaveType.paid !== false : true
  const leaveBal = useMemo(() => {
    if (!ready || !selectedLeaveType) return null
    const lastAd = formatAd(bsToAd(lastDate.year, lastDate.month, lastDate.day))
    const used = leaveUsed(empData.leaveReqs, { employeeId: emp.id, leaveTypeId: selectedLeaveType.id, bsYear: lastDate.year, from: emp.join_date, until: lastAd })
    const encashed = leaveEncashed(clientData.settlements.filter(s => s.id !== current?.id),
      { employeeId: emp.id, leaveTypeId: selectedLeaveType.id, bsYear: lastDate.year, from: emp.join_date })
    return earnedLeaveBalance({ quota: selectedLeaveType.annual_quota, used, encashed, joinDate: emp.join_date, lastDate })
  }, [ready, selectedLeaveType, empData, emp, lastDate, clientData.settlements, current])

  // "Paid" means a FINALIZED festival run carrying a real amount — a draft is not a payment.
  const festivalPaidRow = ready ? (empData.festRows || []).find(f => f.status === 'finalized' && (parseFloat(f.amount) || 0) > 0) || null : null
  const festivalAlreadyPaid = !!festivalPaidRow

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
    // A saved draft keeps its tick (openSettlement), except in the one direction that pays twice:
    // it paid a share and a festival run has been finalized for this person since (S798
    // GAP-PAY-STATE-3). finalize_final_settlement refuses that draft anyway (settlement_festival_paid).
    if (prefilled.current.festSync !== currentKey) {
      prefilled.current.festSync = currentKey
      if (current?.status === 'draft' && !current.festival_paid && festivalPaidRow) {
        setFestPaid(true)
        setFestPaidSince(festivalPaidRow)
      }
    }
  }, [ready, currentKey, leaveTypeId, lastDate.day, leaveBal, encashable, festivalAlreadyPaid, festivalPaidRow, current])

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

  const shownRow = stored || liveRow
  const statement = useMemo(() => shownRow ? statementOf(shownRow, stored ? {} : { advances: empData.advances, tadaClaims: empData.tadaClaims }) : null,
    [shownRow, stored, empData])

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

  // S798 3b: what finalize_final_settlement would refuse, read up front so the button can say so, and
  // read again when the confirm opens or after a recalculation. finalize checks every one again.
  const checkKey = !stored && currentKey && emp ? `${currentKey}:${lastDate.day}` : null
  useEffect(() => {
    if (!checkKey) { setChecks({ key: null }); return }
    let live = true
    setChecks({ key: checkKey, loading: true })
    const lastAd = formatAd(bsToAd(lastDate.year, lastDate.month, lastDate.day))
    const joinDate = emp?.join_date || null
    ;(async () => {
      const [leave, ot, tada, prior, logins] = await Promise.all([
        scopedFrom('hr_leave_requests', 'id, start_date, end_date, days, day_type')
          .eq('employee_id', empId).eq('status', 'pending').lte('start_date', lastAd).order('start_date'),
        scopedFrom('hr_overtime_entries', 'id, bs_day, ot_hours, ot_type')
          .eq('employee_id', empId).eq('bs_year', lastDate.year).eq('bs_month', lastDate.month).eq('status', 'pending').order('bs_day'),
        scopedFrom('hr_tada_claims', 'id, total_amount, trip_purpose, destination, start_date')
          .eq('employee_id', empId).eq('status', 'pending').order('start_date'),
        supabase.rpc('settlement_open_prior_months', { p_employee_id: empId, p_last_working_date: lastAd }),
        supabase.rpc('settlement_linked_logins', { p_employee_id: empId }),
      ])
      if (!live) return
      setChecks({
        key: checkKey, loading: false,
        // An earlier employment's request is not this one's (the database bounds it the same way).
        leave: leave.error ? { error: leave.error } : (leave.data || []).filter(r => !joinDate || !r.end_date || r.end_date >= joinDate),
        ot: ot.error ? { error: ot.error } : (ot.data || []).filter(o => o.bs_day == null || o.bs_day <= lastDate.day),
        tada: tada.error ? { error: tada.error } : (tada.data || []),
        prior: prior.error ? { error: prior.error } : (prior.data || []),
        logins: logins.error ? { error: logins.error } : (logins.data || []),
      })
    })()
    return () => { live = false }
  }, [checkKey, reloadTick, confirmOpen]) // eslint-disable-line react-hooks/exhaustive-deps

  // S798 3b (H5): the payroll months finalized without this person, for the Reopen dialog (a finalized
  // settlement) and a reopened draft. Never for an earlier employment, which cannot be reopened.
  const skipRow = reopenTarget || (current?.status === 'draft' && current.reopened_at && !earlierSpell ? current : null)
  const skipKey = skipRow ? `${skipRow.id}:${skipRow.last_working_date}:${reloadTick}` : null
  useEffect(() => {
    if (!skipKey) { setSkipped({ key: null }); return }
    let live = true
    setSkipped({ key: skipKey, loading: true })
    supabase.rpc('settlement_skipped_payroll_months', { p_employee_id: skipRow.employee_id, p_last_working_date: skipRow.last_working_date })
      .then(({ data, error }) => {
        if (live) setSkipped(error ? { key: skipKey, error } : { key: skipKey, months: data || [] })
      })
    return () => { live = false }
  }, [skipKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const skippedMonths = skipped.key === skipKey && Array.isArray(skipped.months) ? skipped.months : []
  const skippedText = skippedMonths.map(bsMonthLabel).join(', ')

  // The parts of the checks, once they are in for the employee and day on screen.
  const checksIn = !!checkKey && checks.key === checkKey && !checks.loading
  const listOf = part => (checksIn && Array.isArray(checks[part]) ? checks[part] : [])
  const pendingLeave = listOf('leave')
  const pendingOt = listOf('ot')
  const pendingTada = listOf('tada')
  const priorOpen = listOf('prior')
  const checkFailures = checksIn ? ['leave', 'ot', 'tada', 'prior', 'logins'].filter(k => checks[k]?.error) : []
  const linkedLogins = !checksIn ? null : checks.logins?.error ? { error: checks.logins.error } : listOf('logins')
  const exempt = isOwner || isAdmin
  const managerLogins = Array.isArray(linkedLogins) ? linkedLogins.filter(l => l.hr_manager) : []
  // S798 3f-2 (H22): blocked, moved to the other outlet they work at, or losing this outlet only.
  const loginPlan = splitPlan(Array.isArray(linkedLogins) ? linkedLogins : [])
  const grouped = (outlets || []).length > 1
  const managerBlock = managerLogins.length > 0 && !exempt
  const finalizeBlockers = !checksIn ? ['the checks that are still loading'] : [
    pendingLeave.length > 0 && 'leave waiting for a decision',
    pendingOt.length > 0 && 'overtime waiting for a decision',
    pendingTada.length > 0 && 'a travel claim waiting for a decision',
    priorOpen.length > 0 && 'an earlier payroll month that is not final',
    managerBlock && 'an HR Manager login, which only the Owner can settle',
    checkFailures.length > 0 && 'a check that could not be read',
  ].filter(Boolean)

  // S791: a salary payment for the last month or later is refused by finalize_final_settlement
  // (settlement_salary_paid). Said here first, by month, so the owner undoes it before pressing.
  useEffect(() => {
    if (!confirmEmpId) { setPaidMonths(null); return }
    let live = true
    setPaidMonths(null)
    const lastIdx = lastDate.year * 12 + lastDate.month
    scopedFrom('hr_salary_payments', 'amount, paid_on, hr_payroll_runs!inner(monthly_periods!inner(bs_year, bs_month))')
      .eq('employee_id', confirmEmpId).is('voided_at', null)
      .then(({ data, error }) => {
        if (!live) return
        if (error) { setPaidMonths({ error }); return }
        setPaidMonths((data || [])
          .map(p => ({ amount: p.amount, paidOn: p.paid_on, ...p.hr_payroll_runs?.monthly_periods }))
          .filter(p => p.bs_year * 12 + p.bs_month >= lastIdx))
      })
    return () => { live = false }
  }, [confirmEmpId, lastDate.year, lastDate.month, scopedFrom])

  // S798 SETTLEMENT-3: the final month's attendance, re-read when the confirm opens. A day marked
  // absent on another screen after this one loaded was paid, and the month then locked with nothing
  // to say the two disagreed. finalize_final_settlement now refuses that (settlement_stale_attendance);
  // this says so first and offers the recalculation.
  const shownAttendance = empData.status === 'ok' ? empData.attendance : null
  useEffect(() => {
    if (!confirmEmpId || !shownAttendance) { setAttCheck(null); return }
    let live = true
    setAttCheck(null)
    ;(async () => {
      const per = await scopedFrom('monthly_periods', 'id').eq('bs_year', lastDate.year).eq('bs_month', lastDate.month).maybeSingle()
      if (!live) return
      if (per.error) { setAttCheck({ error: per.error }); return }
      let rows = []
      if (per.data?.id) {
        const att = await fetchAllRows(() => scopedFrom('hr_attendance', 'bs_day, status, hours_worked, ot_hours')
          .eq('employee_id', confirmEmpId).eq('period_id', per.data.id).order('id'))
        if (!live) return
        if (att.error) { setAttCheck({ error: att.error }); return }
        rows = att.data || []
      }
      setAttCheck({ moved: attendanceSignature(rows, lastDate.day) !== attendanceSignature(shownAttendance, lastDate.day) })
    })()
    return () => { live = false }
  }, [confirmEmpId, shownAttendance, lastDate.year, lastDate.month, lastDate.day, scopedFrom])

  function recalculate() {
    setConfirmOpen(false)
    setReloadTick(t => t + 1)
    setMsg('ok:Recalculated with the attendance, overtime, advances and claims as they are now. Check the statement, then finalize.')
  }

  async function finalize() {
    if (!liveRow) return
    setConfirmOpen(false)
    setBusy(true); setMsg('')
    const saved = await writeDraft()
    if (!saved) { setBusy(false); return }
    setCurrent(saved)
    const { data, error } = await settleWithin(supabase.rpc('finalize_final_settlement', { p_settlement_id: saved.id }), WRITE_MS, 'Finalizing the settlement')
    if (error) {
      setBusy(false)
      if (outcomeUnknown(error)) {
        await Promise.all([loadClientData(clientId), loadEmployees()])
        setReloadTick(t => t + 1)
        setMsg('error:Could not confirm whether the settlement was finalized — the server did not answer. The page has been reloaded to show what is stored: if it shows Finalized, it went through (logins blocked, advances recovered); if it is still a draft, finalize again. ' + errorLine(error))
        return
      }
      // A refusal from the database: finalize is one transaction, so nothing but the draft was written.
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
      + finalizedLoginNote(data) + '.')
  }

  async function reopen() {
    const row = reopenTarget
    if (!row || !reopenReason.trim()) return
    setBusy(true); setMsg('')
    const { data, error } = await settleWithin(supabase.rpc('reopen_final_settlement', { p_settlement_id: row.id, p_reason: reopenReason.trim() }), WRITE_MS, 'Reopening the settlement')
    setBusy(false)
    if (error && outcomeUnknown(error)) {
      setReopenTarget(null)
      await loadClientData(clientId)
      setReloadTick(t => t + 1)
      setMsg('error:Could not confirm whether the settlement was reopened — the server did not answer. The page has been reloaded to show what is stored: if it is a draft again, the reopen went through. ' + errorLine(error))
      return
    }
    if (error) { setMsg('error:The settlement was not reopened — it is still finalized. ' + errorLine(error)); return }
    setReopenTarget(null); setReopenReason('')
    setCurrent(data)
    await loadClientData(clientId)
    setReloadTick(t => t + 1)
    const notBack = notUndoneLines(data)
    setMsg('ok:Settlement reopened as a draft — its advance recoveries and travel-claim payments were undone. ' + (data.employee_name || 'The employee') + ' is still marked as left; change their status in Employees if they are not leaving after all, and check any payroll month named above that was finalized without them.'
      + (notBack.length > 0 ? ' Not put back: ' + notBack.join(' ') : ''))
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
    const { data, error } = await settleWithin(scopedUpdate('hr_final_settlements', { paid_at: new Date().toISOString(), paid_method: method })
      .eq('id', row.id).eq('status', 'finalized').is('paid_at', null).select(), WRITE_MS, 'Marking the settlement paid')
    setBusy(false)
    if (error && outcomeUnknown(error)) {
      await loadClientData(clientId)
      setMsg('error:Could not confirm the payment was recorded — the server did not answer. The page has been reloaded: if the settlement shows as paid, it went through; if not, mark it paid again. ' + errorLine(error))
      return
    }
    if (error) { setMsg('error:The settlement was not marked as paid — it still shows as owed. ' + errorLine(error)); return }
    if (!data?.length) { setMsg('error:Nothing was changed — this settlement is already recorded as paid, or was reopened, on another screen. Reload the page.'); return }
    setCurrent(data[0])
    await loadClientData(clientId)
    setMsg('ok:Marked as paid by ' + method.toLowerCase() + '.')
  }

  // S798 3b (H4): a settlement paid, reopened and finalized again at a different net. The database works
  // out the amount (net less what was paid) and keeps the entry beside the first payment.
  async function recordDifference(row, method) {
    setBusy(true); setMsg('')
    const { data, error } = await settleWithin(supabase.rpc('record_settlement_difference', { p_settlement_id: row.id, p_method: method }), WRITE_MS, 'Recording the difference')
    setBusy(false)
    if (error && outcomeUnknown(error)) {
      await loadClientData(clientId)
      setMsg('error:Could not confirm the difference was recorded — the server did not answer. The page has been reloaded: if what was paid now matches the settlement, it went through. Recording it again is refused once it has. ' + errorLine(error))
      return
    }
    if (error) { setMsg('error:The difference was not recorded. ' + errorLine(error)); return }
    setCurrent(data)
    await loadClientData(clientId)
    const last = settlementAdjustments(data).slice(-1)[0]
    setMsg('ok:' + (last && last.amount < 0
      ? `Recorded NPR ${fmt(-last.amount)} handed back by ${method.toLowerCase()}.`
      : `Recorded the NPR ${fmt(last?.amount)} top-up paid by ${method.toLowerCase()}.`)
      + ' What was paid now matches the settlement.')
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
    // A saved draft keeps the leave days and festival tick it was saved with — except a share paid
    // since by a festival run, which the prefill effect takes off (festSync).
    prefilled.current = { leave: `${key}:${row.leave_type_id || leaveTypeId}:${bs.day}`, fest: key, festSync: null }
    setFestPaidSince(null)
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
    // Never an earlier employment's draft (S798 H26): that one belongs to a spell this person has
    // since been rehired out of, and the new settlement is the one being started.
    const pickedEmp = employees.find(e => e.id === id) || null
    const draft = clientData.settlements.find(x => x.employee_id === id && x.status === 'draft' && !isEarlierSpell(x, pickedEmp))
    if (draft) { openSettlement(draft); return }
    setCurrent(null)
    setFestPaidSince(null)
    setEmpId(id)
  }

  function handlePrint() {
    const name = shownRow?.employee_name || emp?.full_name || 'employee'
    printWithTitle(`Final Settlement - ${name}${frozen ? '' : ' (DRAFT)'}`)
  }

  if (!hasHrAccess('manager')) return <Navigate to="/dashboard" replace />

  const inputsBlocked = clientData.status !== 'ok' || (empId && !stored && empData.status !== 'ok')
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
        <div className="field-grid">

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
            <select id="settle-reason" className="form-select" value={reason} disabled={!!stored} onChange={e => setReason(e.target.value)}>
              <option value="resignation">Resignation</option>
              <option value="termination">Termination</option>
              <option value="retirement">Retirement</option>
              <option value="mutual">Mutual Separation</option>
            </select>
          </div>

          <div className="field-grid__wide">
            <BsDateSelect
              id="settle-last-date"
              label="Last Working Date (BS)"
              tip="The last day the employee worked, in full. The final month is paid to this day, and service is counted to the end of it."
              year={lastDate.year} month={lastDate.month} day={lastDate.day}
              onChange={setLastDate}
              disabled={!!stored}
            />
          </div>

          <div>
            <label style={{ display: 'block', fontSize: 12, color: 'var(--theme-text3)', marginBottom: 5 }} htmlFor="settle-leave-days">
              <Tip text={`Unused leave to pay out, at basic ÷ ${LEAVE_DAY_DIVISOR} per day. Filled in with the leave EARNED this BS year — the yearly quota × completed months worked ÷ 12 — less days taken and already paid out.`} width={280}>Unused Leave Days</Tip>
            </label>
            <input id="settle-leave-days" type="number" className="form-input form-input--auto" min={0} max={365}
              value={leaveDays} disabled={!encashable || !!stored}
              onChange={e => setLeaveDays(e.target.value)} />
            {clientData.leaveTypes.length > 0 && (
              <select aria-label="Leave type being encashed" className="form-select" style={{ width: '100%', marginTop: 6 }}
                value={leaveTypeId} disabled={!!stored} onChange={e => setLeaveTypeId(e.target.value)}>
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
                {(parseFloat(leaveDays) || 0) > leaveBal.remaining + 0.01 && (
                  <span role="alert" style={{ display: 'block', marginTop: 4, color: 'var(--theme-amber-text)', fontWeight: 600 }}>
                    {current?.status === 'draft' && Math.abs((parseFloat(current.leave_days_encashed) || 0) - (parseFloat(leaveDays) || 0)) < 0.01
                      // S798 3b (GAP-PAY-STATE-2): a saved draft keeps its days, and leave approved since it was
                      // saved would otherwise be paid out as well as taken.
                      ? <>△ This draft was saved paying out {parseFloat(leaveDays)} days, and the balance is now {leaveBal.remaining} — leave was taken or paid out since it was saved. </>
                      : <>△ {parseFloat(leaveDays)} days is more than the {leaveBal.remaining} earned — the extra is paid only if you leave it. Keep it only for carry-forward you are sure of. </>}
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setLeaveDays(String(leaveBal.remaining))}>Use {leaveBal.remaining} days</button>
                  </span>
                )}
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
              value={noticeDays} disabled={!direction || !!stored} onChange={e => setNoticeDays(e.target.value)} />
            <p style={{ margin: '5px 0 0', fontSize: 11, color: 'var(--theme-text3)', lineHeight: 1.6 }}>
              {direction === 'deduct' ? 'Resigned without serving notice: the employee owes it, and it is deducted.'
                : direction === 'add' ? 'Terminated without notice: the employer owes it, and it is added.'
                : 'No notice pay either way for a mutual separation or a retirement.'}
            </p>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, justifyContent: 'flex-end', paddingBottom: 2 }}>
            {direction && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--theme-text1)', cursor: 'pointer' }}>
                <input type="checkbox" checked={noticeServed} disabled={!!stored} onChange={e => setNoticeServed(e.target.checked)} />
                <Tip text={direction === 'deduct'
                  ? 'Tick if the employee worked their full notice period. Untick and the notice period is deducted from the settlement.'
                  : 'Tick if the employee was given their full notice period. Untick and the employer pays the notice period in the settlement.'} width={280}>
                  {direction === 'deduct' ? 'Notice period served' : 'Notice period given'}
                </Tip>
              </label>
            )}
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--theme-text1)', cursor: 'pointer' }}>
              <input type="checkbox" checked={festPaid} disabled={!!stored} onChange={e => setFestPaid(e.target.checked)} />
              <Tip text="Tick if the employee has already received their festival (Dashain) allowance this fiscal year. Untick and a share for the completed months worked this fiscal year is paid." width={300}>Festival allowance paid this FY</Tip>
            </label>
            {festPaidSince && !stored && festPaid && (
              <p role="status" style={{ margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--theme-amber-text)', maxWidth: 320 }}>
                △ Paid since this draft was saved: the {festPaidSince.festival_name} allowance (NPR {fmt(festPaidSince.amount)}) was finalized, so the festival share is taken off. Save the draft to keep this.
              </p>
            )}
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
      {loadFailure && !stored && (
        <div className="no-print" style={{ marginBottom: 16 }}>
          <ReportLoadError error={loadFailure} />
          <p style={{ fontSize: 12, color: 'var(--theme-text2)', margin: '8px 0 0' }}>
            Until this loads the settlement cannot be calculated, saved or finalized — a missing salary component, advance,
            leave record or SSF contribution would change what the leaver is paid. Reload the page to try again.
          </p>
        </div>
      )}

      {empId && !stored && !loadFailure && !ready && (
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
          {earlierSpell && (
            <div className="note-banner no-print" style={{ marginBottom: 12 }}>
              <strong>From an earlier employment.</strong>{' '}
              {shownRow.employee_name} was taken back on {emp?.join_date}, after this settlement's last working day. It is shown exactly as it was
              saved and cannot be {frozen ? 'reopened' : 'finalized'} — reworking it would use the new employment's dates and mark them as left again.
              Pay any correction by hand and keep a note of it.
            </div>
          )}
          {current?.reopened_at && current.status === 'draft' && (
            <div className="card no-print" style={amberBanner}>
              <strong style={{ color: 'var(--theme-amber-text)' }}>Reopened {nepalDateAd(current.reopened_at)}</strong>
              <div>Reason: {current.reopen_reason}. {current.paid_at ? `${paidLine(current)} — that record is kept, so this draft cannot be deleted, and once it is finalized again any difference shows as still to pay or overpaid.` : ''}</div>
              {skippedMonths.length > 0 && (
                <div style={{ marginTop: 4 }}>
                  △ Payroll for {skippedText} was finalized without {current.employee_name}, because this settlement was paying {skippedMonths.length === 1 ? 'it' : 'them'}.
                  {' '}If they are staying, reopen that payroll and Regenerate so they are paid there; if they are leaving, finalize this settlement again.
                  {' '}Until one of the two is done, this draft cannot be deleted.
                </div>
              )}
              {skipped.key === skipKey && skipped.error && (
                <div style={{ marginTop: 4 }}>△ Could not check which payroll months were finalized without them — {errorLine(skipped.error)}</div>
              )}
              {notUndoneLines(current).map(line => (
                <div key={line} style={{ marginTop: 4 }}>△ Not put back by the reopen: {line}</div>
              ))}
            </div>
          )}

          {/* Print header (hidden on screen). A draft says so on paper. */}
          <div className="print-only" style={{ marginBottom: 24 }}>
            <h2 style={{ margin: 0 }}>Final Settlement Statement{frozen ? '' : ' — DRAFT'}</h2>
            <div style={{ fontSize: 13, marginTop: 4 }}>
              {shownRow.employee_name}{shownRow.employee_code ? ` · ${shownRow.employee_code}` : ''}{shownRow.department ? ` · ${shownRow.department}` : ''}
            </div>
            <div style={{ fontSize: 12, marginTop: 2 }}>
              {/* BS first, the calendar the leaver reads, on a draft and a finalized statement alike
                  (S798 SETTLEMENT-7): the finalized one printed the AD date alone. Both halves come
                  from the one stored date, so they cannot disagree. */}
              Last working date: {bsWithAd(shownRow.last_working_date)} ·
              {' '}Service: {fmtService(parseInt(shownRow.service_months, 10) || 0)} ·
              {' '}Reason: {String(shownRow.separation_reason || '').charAt(0).toUpperCase() + String(shownRow.separation_reason || '').slice(1)}
            </div>
            <div style={{ fontSize: 12, marginTop: 2 }}>
              {frozen
                ? `Finalized ${nepalDateAd(frozen.finalized_at)}${frozen.paid_at ? ` · ${paidLine(frozen)}${differenceLine(frozen) ? ` · ${differenceLine(frozen)}` : ''}` : ' · Not yet paid'}`
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
                ? <PaymentBadge row={frozen} />
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
            {/* A payout is a figure, so it takes the ink. The one state that asks something of someone —
                the employee owing the business — is amber with a mark and words, never colour alone (S768). */}
            <div style={{ fontSize: 24, fontWeight: 800, color: statement.net >= 0 ? 'var(--theme-text1)' : 'var(--theme-amber-text)' }}>
              NPR {npr2(Math.abs(statement.net))}
              {statement.net < 0 && <span style={{ fontSize: 13, marginLeft: 8, color: 'var(--theme-amber-text)' }}>△ owed by the employee</span>}
            </div>
          </div>

          {statement.employerSsf > 0 && (
            <p style={{ margin: '10px 0 0', fontSize: 12, color: 'var(--theme-text2)' }}>
              Employer SSF (20%) for the final month, not paid to the employee: <strong>NPR {fmt(statement.employerSsf)}</strong> — deposit it with the employee's 11% (it appears on HR Reports → SSF Challan for {BS_MONTHS[(shownRow.settle_bs_month || lastDate.month) - 1]}).
            </p>
          )}
          {/* > 0.005, not 0.01 (S791): one paisa still owed is owed, and the advance stays active. */}
          {!frozen && calc && calc.advanceShortfall > 0.005 && (
            <p style={{ margin: '10px 0 0', fontSize: 12, color: 'var(--theme-amber-text)' }}>
              △ The payout covers NPR {nprPaisa(calc.advanceRecovered)} of the NPR {nprPaisa(calc.advanceDeduction)} advances owed. The other NPR {nprPaisa(calc.advanceShortfall)} stays owed on the advance after Finalize.
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
                  {frozen.paid_at ? <>{paidLine(frozen)}.</> : <>Not yet recorded as paid.</>}
                  {parseFloat(frozen.advance_recovered) > 0 && <> NPR {fmt(frozen.advance_recovered)} of advances recovered.</>}
                  {differenceLine(frozen) && (
                    <div role="status" style={{ marginTop: 4, color: 'var(--theme-amber-text)', fontWeight: 600 }}>
                      △ {differenceLine(frozen)}{' '}
                      <Tip text="Reopen keeps the first payment, so a correction that changed the net leaves a difference. Record it when the money is handed over (or handed back) — the amount is worked out for you, and both payments stay on the record." width={300}>
                        <span>What is this?</span>
                      </Tip>
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {!frozen.paid_at && (
                    <>
                      <button className="btn btn-ghost" disabled={busy} onClick={() => markPaid(frozen, 'Cash')}>Mark paid — Cash</button>
                      <button className="btn btn-ghost" disabled={busy} onClick={() => markPaid(frozen, 'Bank')}>Mark paid — Bank</button>
                    </>
                  )}
                  {(() => {
                    const pay = settlementPaymentState(frozen)
                    if (pay.state !== 'short' && pay.state !== 'over') return null
                    const verb = pay.state === 'short' ? `Record NPR ${fmt(pay.due)} paid` : `Record NPR ${fmt(-pay.due)} returned`
                    return (
                      <>
                        <button className="btn btn-ghost" disabled={busy} onClick={() => recordDifference(frozen, 'Cash')}>{verb} — Cash</button>
                        <button className="btn btn-ghost" disabled={busy} onClick={() => recordDifference(frozen, 'Bank')}>{verb} — Bank</button>
                      </>
                    )
                  })()}
                  {!earlierSpell && (
                    <button className="btn btn-danger" disabled={busy} onClick={() => { setReopenReason(''); setReopenTarget(frozen) }}>Reopen</button>
                  )}
                </div>
              </div>
            ) : earlierSpell ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ fontSize: 13, color: 'var(--theme-text2)' }}>
                  A draft from the earlier employment. It cannot be finalized{current.reopened_at ? '; it was finalized once and reopened, so it is kept as the record of that payment' : ''}.
                </div>
                {!current.reopened_at && !current.paid_at && (
                  <button className="btn btn-ghost" disabled={busy} onClick={() => deleteDraft(current)}>Delete draft</button>
                )}
              </div>
            ) : (
              <>
                <p style={{ margin: '0 0 10px', fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.7 }}>
                  Finalizing records this settlement and, in one step: recovers the outstanding advances, marks the travel claims paid,
                  marks {shownRow.employee_name} as {STATUS_AFTER[reason]} with their last working date, turns off their Crest Staff app access, and blocks any HR, IMS or POS staff login linked to them.
                </p>
                {checksIn && finalizeBlockers.length > 0 && (
                  <FinalizeBlockers
                    name={shownRow.employee_name} lastDate={lastDate}
                    pendingLeave={pendingLeave} pendingOt={pendingOt} pendingTada={pendingTada} priorOpen={priorOpen}
                    managerLogins={managerBlock ? managerLogins : []} checkFailures={checkFailures} checks={checks}
                    onRecheck={recalculate} busy={busy}
                  />
                )}
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button className="btn btn-ghost" disabled={busy || inputsBlocked || !liveRow} onClick={saveDraft}>{current ? 'Update draft' : 'Save draft'}</button>
                  {/* A precondition is aria-disabled plus a press that says what is missing, never disabled alone. */}
                  <button className="btn btn-primary" disabled={busy || inputsBlocked || !liveRow}
                    aria-disabled={finalizeBlockers.length > 0}
                    onClick={() => {
                      if (!checksIn) { setMsg('error:Still checking for pending requests and open payroll months — try again in a moment.'); return }
                      if (finalizeBlockers.length > 0) {
                        setMsg('error:Finalize is waiting on ' + finalizeBlockers.join(', ') + ' — see the list above the buttons.')
                        return
                      }
                      setConfirmOpen(true)
                    }}>
                    {busy ? 'Working…' : 'Finalize settlement'}
                  </button>
                  {current?.status === 'draft' && !current.paid_at && skippedMonths.length === 0 && (
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
                    <td className="num" style={{ whiteSpace: 'nowrap' }} title={`${x.last_working_date} AD`}>{formatAdAsBs(x.last_working_date)}</td>
                    <td style={{ textTransform: 'capitalize' }}>{x.separation_reason}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }} className="num">{fmt(x.net_payout)}</td>
                    <td><PaymentBadge row={x} /></td>
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
              <li><strong>NPR {nprPaisa(calc.advanceRecovered)}</strong> recovered against outstanding advances{calc.advanceShortfall > 0.005 ? `; NPR ${nprPaisa(calc.advanceShortfall)} stays owed` : ', which then close'}.</li>
            )}
            {(liveRow.tada_claim_ids || []).length > 0 && (
              <li>{liveRow.tada_claim_ids.length} approved travel claim(s), NPR {fmt(liveRow.tada_amount)}, are paid here and marked paid.</li>
            )}
            <li>
              {liveRow.employee_name} becomes <strong>{STATUS_AFTER[reason]}</strong> with an end date of {lastAdLabel}, and leaves every payroll, roster and attendance screen.
            </li>
            <li>Their Crest Staff app access is turned off, and a phone already signed in is signed out.</li>
            {(!Array.isArray(linkedLogins) || linkedLogins.length === 0 || loginPlan.block.length > 0) && (
              <li>
                {linkedLogins === null
                  ? 'Checking for an HR, IMS or POS staff login…'
                  : linkedLogins.error
                    ? 'Could not check for an HR, IMS or POS staff login — Finalize still deals with any linked to this employee: it blocks it, or moves it to another of your outlets they still work at.'
                    : linkedLogins.length === 0
                      ? 'No HR, IMS or POS staff login is linked to this employee, so none is blocked. If they have one that is not linked, link it on HR Staff (the Owner presses Link…) before finalizing, or delete it there.'
                      : <>Their staff login{loginPlan.block.length === 1 ? '' : 's'} {loginPlan.block.map(loginLabel).join(', ')} {loginPlan.block.length === 1 ? 'is' : 'are'} <strong>blocked</strong> — not deleted, so their name stays on everything they recorded. Reopen unblocks {loginPlan.block.length === 1 ? 'it' : 'them'}, and so does taking them back later with a new join date.
                          {grouped && ' If they still work at another of your outlets, link the login to their record there on HR Staff first, and it moves there instead of being blocked.'}</>}
              </li>
            )}
            {loginPlan.move.map(l => <li key={'move:' + l.full_name}>{moveLine(l)}</li>)}
            {loginPlan.remove.map(l => <li key={'remove:' + l.full_name}>{removeLine(l)}</li>)}
            {parseFloat(liveRow.leave_days_encashed) > 0 && <li>{liveRow.leave_days_encashed} leave day(s) are recorded as paid out and come off their balance.</li>}
            {paidMonths?.error && (
              <li style={{ color: 'var(--theme-amber-text)' }}>△ Could not check whether their salary for {BS_MONTHS[lastDate.month - 1]} is already recorded as paid — Finalize checks again and refuses if it is.</li>
            )}
            {Array.isArray(paidMonths) && paidMonths.length > 0 && (
              <li style={{ color: 'var(--theme-amber-text)' }}>
                △ Their salary for {paidMonths.map(p => `${BS_MONTHS[p.bs_month - 1]} ${p.bs_year} (NPR ${fmt(p.amount)}, paid ${p.paidOn})`).join(', ')} is
                recorded as paid. This settlement pays the last month itself, so Finalize will refuse until that payment is undone on the
                Payroll page (Undo payment) — otherwise the month is paid twice.
              </li>
            )}
            <li>
              {attCheck === null
                ? `Checking the attendance sheet for ${BS_MONTHS[lastDate.month - 1]} again…`
                : attCheck.error
                  ? `△ Could not re-check the attendance sheet for ${BS_MONTHS[lastDate.month - 1]} — Finalize checks it again and refuses if it changed.`
                  : attCheck.moved
                    ? <span style={{ color: 'var(--theme-amber-text)' }}>△ Attendance for {BS_MONTHS[lastDate.month - 1]} changed on another screen after this one loaded, so these figures are out of date and Finalize will refuse.{' '}
                        <button type="button" className="btn btn-ghost btn-sm" onClick={recalculate}>Recalculate now</button></span>
                    : `The attendance sheet for ${BS_MONTHS[lastDate.month - 1]} matches what this settlement pays.`}
            </li>
            <li>If anything changed since this screen calculated — attendance, an advance, a claim, overtime, a festival allowance, a salary payment, payroll for this month or an earlier one, a request still waiting for a decision — nothing is finalized and you are told what.</li>
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
            {reopenLoginLines(reopenTarget).map(line => <li key={line}>{line}</li>)}
            {reopenTarget.paid_at && <li>{paidLine(reopenTarget)}. That record is kept: once it is finalized again, any change to the net shows as still to pay or overpaid, and while reopened it cannot be deleted.</li>}
            {skipped.key === skipKey && skipped.loading && <li>Checking which payroll months were finalized without them…</li>}
            {skipped.key === skipKey && skipped.error && <li style={{ color: 'var(--theme-amber-text)' }}>△ Could not check which payroll months were finalized without them ({errorLine(skipped.error)}).</li>}
            {skippedMonths.length > 0 && (
              <li style={{ color: 'var(--theme-amber-text)' }}>
                △ Payroll for {skippedText} was finalized without {reopenTarget.employee_name}, because this settlement was paying {skippedMonths.length === 1 ? 'it' : 'them'}.
                {' '}If they are not leaving after all, that pay is owed by nobody until you reopen that payroll and Regenerate. If they are leaving, finalize this settlement again.
              </li>
            )}
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
                <td style={{ textAlign: 'right', fontWeight: 600 }}>{tone === 'red' ? '− ' : ''}{fmt(l.amount)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td>{totalLabel}</td>
              <td></td>
              <td style={{ textAlign: 'right', fontSize: 15 }}>{tone === 'red' ? '− ' : ''}{fmt(total)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  )
}
