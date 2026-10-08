import { useState, useEffect, useMemo } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import Tip from '../../../components/Tip'
import Tabs from '../../../components/Tabs'
import Fab from '../../../components/Fab'
import Modal from '../../../components/Modal'
import BsCalendarPicker from '../../../components/BsCalendarPicker'
import { adToBs, adToBsSafe, BS_MONTHS } from '../../../utils/bsCalendar'
import { DEFAULT_LEAVE_TYPES, LEAVE_STATUSES, DAY_TYPES, workingDaysInRange, leaveDayCount, publicHolidayKeys } from './leaveConstants'
import { leaveBalance } from './leaveBalance'
import { findOverlappingRequest, finalizedMonthsFor, quotaOverrun, leaveDaysByPeriod, monthsWithoutPeriod, planLeaveRevert, LEAVE_MARK_STATUSES } from './leaveRules'
import { backfillApprovedLeave, findApprovedLeaveGaps } from './backfillApprovedLeave'
import { disabledStyle } from '../../../shared/inlineFieldState'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import { errorText, errorLine } from '../../../shared/errorText'
import { useConfirm, CONFIRM_TIMEOUT_MS, CONFIRM_TIMEOUT_TEXT } from '../../../shared/hooks/useConfirm'
import { DecisionButtons, BulkApproveBar, decideEach, OwnRecordNote } from '../ApprovalControls'
import { useIsOwnEmployee } from '../ownRecord'
import { HR_REQUEST_STATUS } from '../payrollConstants'
import { NOTHING_CHANGED, changedNothing } from '../nothingChanged'

const fmt = n => Math.round((n || 0) * 10) / 10

// A leave type's colour is a CATEGORICAL palette (seeded in leaveConstants.js, editable per
// client), so it is only trustworthy as a FILL. Two things it got wrong as written:
//   • the seeds mix literal hexes with `var(--theme-green)`/`var(--theme-text3)`, and the tint was
//     built by string concatenation (`${t.color}1a`) — which yields `var(--theme-green)1a`, invalid
//     CSS, so those types silently rendered no tint or border at all;
//   • several seeds are light pastels (#60a5fa, #a78bfa, #f472b6, #22d3ee) set as 11px/700 TEXT,
//     which fails contrast on the light presets.
// typeTint() does the alpha through color-mix (works for a hex and a var() alike) and typeText()
// mixes the hue toward the page's own text colour, so the type stays distinguishable while staying
// legible on every theme — the same fill-vs-text split StatPill/Overheads use. The seed values
// themselves are deliberately untouched.
const typeFill = c => c || 'var(--theme-text2)'
const typeTint = (c, pct) => `color-mix(in srgb, ${typeFill(c)} ${pct}%, transparent)`
const typeText = c => `color-mix(in srgb, ${typeFill(c)} 45%, var(--theme-text1))`


// The product's amber banner, byte-for-byte what PayrollRun's stale-draft card uses: the whole
// border tinted and an 8% fill, never a thick rule down one side. The first draft of the gap
// banner below invented the side-tab version and was the only instance of it in the codebase —
// a shape nothing else here wears reads as a different product, not as emphasis.
const amberBanner = {
  marginBottom: 14, padding: '12px 16px',
  borderColor: 'color-mix(in srgb, var(--theme-amber) 35%, transparent)',
  background: 'color-mix(in srgb, var(--theme-amber) 8%, transparent)',
}

// "12 Baisakh 2082" from an ISO/AD date string.
function bsLabel(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d)) return '—'
  const bs = adToBsSafe(d)
  return bs ? `${bs.day} ${BS_MONTHS[bs.month - 1]} ${bs.year}` : `${String(iso).slice(0, 10)} (AD)`
}

export default function LeaveManagement() {
  const { clientId, hasHrAccess } = useAuth()
  const { scopedFrom, scopedInsert, scopedUpsert, scopedUpdate, scopedDelete } = useScopedDb()
  // A busy confirm cannot be cancelled, so it is released after a time limit and the page says it
  // could not confirm (S803).
  const { ask: askConfirm, confirmEl } = useConfirm({ timeoutMs: CONFIRM_TIMEOUT_MS, onTimeout: () => setMsg('error:' + CONFIRM_TIMEOUT_TEXT) })
  const today = adToBs(new Date())
  const [bsYear,    setBsYear]    = useState(today.year)
  const [tab,       setTab]       = useState('requests')
  const [types,     setTypes]     = useState([])
  const [employees, setEmployees] = useState([])
  const [periods,   setPeriods]   = useState([])
  const [requests,  setRequests]  = useState([])
  // Finalized settlements, so an encashed day stops reading as still-available. Loaded here
  // rather than derived, because the Balances tab is the only screen that shows a balance at all.
  const [settlements, setSettlements] = useState([])
  // Periods whose payroll run is FINALIZED. Approving or cancelling leave in one of those months
  // would rewrite attendance under issued payslips, so the page refuses it (decided 2026-09-14);
  // hr_attendance_guard_finalized refuses it too.
  const [finalizedPeriodIds, setFinalizedPeriodIds] = useState(() => new Set())
  // Public holidays (Holiday Calendar, public, not removed) as `y:m:d` keys. A public holiday inside
  // a leave is not charged and is marked Holiday on attendance (decided 2026-09-14).
  const [holidayKeys, setHolidayKeys] = useState(() => new Set())
  // Someone settled or deactivated vanishes from every HR picker by design — but their balance is
  // exactly what you want to check when a final settlement is being questioned, so the Balances
  // tab can opt them back in.
  const [showSeparated, setShowSeparated] = useState(false)
  // Approved leave that has not reached an attendance sheet (S741). Null until the check runs;
  // its `error` is a real state — a failed check must not read as "nothing is missing".
  const [gaps,      setGaps]      = useState(null)
  const [filling,   setFilling]   = useState(false)
  const [loading,   setLoading]   = useState(true)
  const [busy,      setBusy]      = useState(false)
  const [msg,       setMsg]       = useState('')

  // New-request form. It lives in a dialog behind "+ Record leave" (S805): it used to open the page
  // above the queue, so at 30 staff the requests waiting on a decision sat below the fold, ~600px
  // down on a phone, under a form the manager fills in far less often than they decide one.
  const [formOpen, setFormOpen] = useState(false)
  const [fEmp,     setFEmp]     = useState('')
  const [fType,    setFType]    = useState('')
  const [fStart,   setFStart]   = useState('')
  const [fEnd,     setFEnd]     = useState('')
  const [fReason,  setFReason]  = useState('')
  const [fDayType, setFDayType] = useState('full')
  const isSingleDay = fStart && fEnd && fStart === fEnd

  const empMap  = Object.fromEntries(employees.map(e => [e.id, e]))
  // Your own request (S752, S798): the database refuses you approving or rejecting it, and cancelling
  // it once approved (H8) — so neither is offered, and the batch leaves it out by name.
  const isOwnEmployee = useIsOwnEmployee(empMap)
  const typeMap = Object.fromEntries(types.map(t => [t.id, t]))
  const activeTypes = types.filter(t => t.active)
  // Reopening a decided request is manager-and-above; the page itself opens at supervisor.
  const canReopen = hasHrAccess('manager')
  const years = Array.from({ length: 6 }, (_, i) => today.year - 3 + i)

  useEffect(() => { if (clientId) load() }, [clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Half-day only makes sense for a single-day request — force back to Full Day otherwise.
  useEffect(() => { if (!isSingleDay) setFDayType('full') }, [isSingleDay])

  async function load() {
    setLoading(true); setMsg('')
    // A failed read is not an empty list (S682): every read here carries its error, and the page
    // keeps whatever it last loaded rather than painting "no requests" and a full-quota balance.
    const loadFailed = (what, error) => {
      setMsg(`error:Could not load ${what} — the figures on this page are from the last successful load. ` + errorText(error, 'operator'))
      setLoading(false)
    }
    // The leave types are read WITH everything else (S808): none of the reads below uses them, and
    // reading them first cost every visit a round trip so that the first visit ever could seed.
    const [ltRes, ...results] = await Promise.all([
      scopedFrom('hr_leave_types').order('sort_order'),
      // Every status, not just active/probation — the Balances tab filters in JS so it can show a
      // leaver on request, while every other tab here still works from the active list below.
      // `email`: the second half of the own-record test (useIsOwnEmployee). `join_date`: the gap
      // check's settled-leaver test, which tells a rehire from the leaver they were.
      scopedFrom('hr_employees', 'id, full_name, employee_code, department, status, email, join_date').order('full_name'),
      scopedFrom('monthly_periods', 'id, bs_year, bs_month, status'),
      // Paged: this is the client's ENTIRE request history and the source of the Balances tab, so
      // the silent 1000-row cap would quietly overstate an employee's remaining leave once the
      // table crossed it (~1–2 years for a 40-person outlet). `.order('id')` is the tiebreaker
      // paging needs.
      fetchAllRows(() => scopedFrom('hr_leave_requests').order('start_date', { ascending: false }).order('id')),
      scopedFrom('hr_final_settlements', 'employee_id, leave_type_id, leave_days_encashed, last_working_date, status')
        .eq('status', 'finalized'),
      // One row per payroll run — a handful per year. Its failure fails the load, because the
      // finalized-month lock below cannot be checked without it.
      scopedFrom('hr_payroll_runs', 'period_id, status').eq('status', 'finalized'),
      // Its failure fails the load too: without it every count and every approval would treat a
      // public holiday as a leave day.
      scopedFrom('hr_holiday_calendar', 'bs_year, bs_month, bs_day, holiday_type, removed_at').eq('holiday_type', 'public').is('removed_at', null),
    ])
    // Seed default leave types on first visit. The error check comes FIRST: a failed read used to
    // look exactly like "no types yet" and seeded a duplicate set on every retry.
    let { data: lt, error: ltErr } = ltRes
    if (ltErr) { loadFailed('leave types', ltErr); return }
    if (!lt || lt.length === 0) {
      const { error: seedErr } = await scopedInsert('hr_leave_types', DEFAULT_LEAVE_TYPES)
      if (seedErr) { loadFailed('the default leave types', seedErr); return }
      const r = await scopedFrom('hr_leave_types').order('sort_order')
      if (r.error) { loadFailed('leave types', r.error); return }
      lt = r.data || []
    }
    const failed = results.find(r => r && r.error)
    if (failed) { loadFailed('leave data', failed.error); return }
    const [{ data: emps }, { data: pr }, { data: reqs }, { data: setl }, { data: runs }, { data: hols }] = results
    setTypes(lt); setEmployees(emps || []); setPeriods(pr || []); setRequests(reqs || [])
    setSettlements(setl || [])
    setFinalizedPeriodIds(new Set((runs || []).map(r => r.period_id)))
    setHolidayKeys(publicHolidayKeys(hols))
    setLoading(false)
    // After the page is usable, not before it: this is a reconciliation, and a slow extra read
    // must not hold up the queue someone opened the page to work through.
    setGaps(await findApprovedLeaveGaps({ clientId, requests: reqs || [], periods: pr || [], settlements: setl || [], employees: emps || [] }))
  }

  // Write the days for every month that HAS a period and is still missing them. Only reachable
  // from the banner below, which only appears when there is something to write.
  async function fillUnmarked() {
    // A month whose payroll is finalized is not written — its payslips are issued (S749). Those
    // are named in the banner with the way through instead.
    const open = (gaps?.unmarked || []).filter(u => !finalizedPeriodIds.has(u.period.id))
    if (!open.length) return
    setFilling(true); setMsg('')
    let filled = 0, skipped = 0, settled = 0
    for (const u of open) {
      const r = await backfillApprovedLeave({ clientId, period: u.period })
      if (r.error) {
        setMsg(`error:${filled ? `${filled} day${filled === 1 ? '' : 's'} were marked, but t` : 'T'}he rest could not be — try again. ` + errorText(r.error, 'operator'))
        setFilling(false); await load(); return
      }
      filled += r.filled; skipped += r.skipped; settled += r.settled
    }
    await load()
    // A settled leaver's days are left out by the back-fill (S791) and named, never passed off as
    // "already marked" (S798, LEAVE-OT-HOLIDAYS-7): they have no row on the sheet at all.
    const left = settled ? ` ${settled} day${settled === 1 ? '' : 's'} of leave belonging to staff whose Final Settlement already paid that month ${settled === 1 ? 'was' : 'were'} left out — nothing pays them, so there is nothing to mark.` : ''
    const kept = skipped ? `${skipped} day${skipped === 1 ? '' : 's'} already had a mark and ${skipped === 1 ? 'was' : 'were'} left alone.` : ''
    setMsg(filled
      ? `ok:${filled} day${filled === 1 ? '' : 's'} marked on the attendance sheet.${kept ? ` ${kept}` : ''}${left}`
      : `ok:Nothing was marked.${kept ? ` ${kept}` : ''}${left}`)
    setFilling(false)
  }

  // ── New request ───────────────────────────────────────────────────────────
  const previewDays = workingDaysInRange(fStart, fEnd)
  // What the request charges: public holidays inside the range are not counted, and a half day is
  // 0.5. The database derives the stored figure the same way.
  const preview = leaveDayCount(fStart, fEnd, isSingleDay ? fDayType : 'full', holidayKeys)
  const previewDaysCount = preview.days
  async function submitRequest() {
    if (!clientId) { setMsg('error:No client selected'); return }
    if (!fEmp || !fType || !fStart || !fEnd) { setMsg('error:Fill employee, type and dates'); return }
    if (previewDays.length === 0) { setMsg('error:No days in that range (end date is before start date)'); return }
    if (preview.days === 0) { setMsg('error:Every day in that range is a public holiday, so there is no leave to take — nothing was submitted.'); return }
    // Overlapping requests are refused (decided 2026-09-14) — named here, before the trigger does.
    const clash = findOverlappingRequest(requests, { employeeId: fEmp, startDate: fStart, endDate: fEnd })
    if (clash) {
      setMsg(`error:${empMap[fEmp]?.full_name || 'This employee'} already has a ${clash.status} request for ${bsLabel(clash.start_date)} → ${bsLabel(clash.end_date)}, which shares days with this one. Nothing was submitted — cancel or reject that request first.`)
      return
    }
    setBusy(true); setMsg('')
    const { error } = await scopedInsert('hr_leave_requests', {
      employee_id: fEmp, leave_type_id: fType,
      start_date: fStart.slice(0, 10), end_date: fEnd.slice(0, 10),
      days: previewDaysCount, reason: fReason || null, status: 'pending', day_type: fDayType,
    })
    if (error) { setMsg('error:The request was not submitted. ' + errorLine(error)); setBusy(false); return }
    setFEmp(''); setFType(''); setFStart(''); setFEnd(''); setFReason(''); setFDayType('full')
    setFormOpen(false)
    await load(); setMsg('ok:Request submitted — it is waiting at the top of the list'); setBusy(false)
  }

  // ── Attendance sync ───────────────────────────────────────────────────────
  // Write (or revert) the hr_attendance rows for a request's working days. `status` already
  // reflects half- vs full-day (the caller resolves that) — a half-day request is always a
  // single day, so this naturally writes just the one row.
  async function syncAttendance(req, status, periodList) {
    const periodMap = {}
    periodList.forEach(p => { periodMap[`${p.bs_year}:${p.bs_month}`] = p })
    const days = workingDaysInRange(req.start_date, req.end_date)
    const rows = []
    const missing = []
    const fullDay = status === 'paid_leave' || status === 'unpaid_leave'
    days.forEach(d => {
      const p = periodMap[`${d.bsYear}:${d.bsMonth}`]
      if (!p) { missing.push(`${d.bsDay} ${BS_MONTHS[d.bsMonth - 1]} ${d.bsYear}`); return }
      // A public holiday inside the leave is not a leave day (decided 2026-09-14): it is marked
      // Holiday, which is what it is. A half day on a holiday never gets here — it is refused.
      const dayStatus = holidayKeys.has(`${d.bsYear}:${d.bsMonth}:${d.bsDay}`) ? 'holiday' : status
      // A full day of leave (or a holiday) was not worked, so the upsert also clears any times,
      // hours and overtime the day carried — payroll pays OT from every row whatever its status
      // (S749). A half day keeps them: half of it was worked. Every row in one request has the
      // same keys either way, which a bulk upsert needs.
      rows.push(fullDay
        ? { employee_id: req.employee_id, period_id: p.id, bs_day: d.bsDay, status: dayStatus,
            hours_worked: 0, ot_hours: 0, start_time: null, end_time: null, break_minutes: null }
        : { employee_id: req.employee_id, period_id: p.id, bs_day: d.bsDay, status: dayStatus })
    })
    if (rows.length) {
      const { error } = await scopedUpsert('hr_attendance', rows, { onConflict: 'employee_id,period_id,bs_day' })
      if (error) return { missing, error }
    }
    return { missing, error: null }
  }

  // Undo an approved request's attendance marks by deleting those hr_attendance rows, rather
  // than overwriting them with a guessed status. We never recorded what a day's attendance was
  // BEFORE the leave was approved (e.g. it may have been 'absent'), so forcing it back to
  // 'present' silently fabricated an attendance record. Deleting leaves the day blank — the same
  // "no signal, needs manual entry" state AttendanceSheet.jsx already uses for un-rostered days —
  // so an admin can correct it instead of payroll silently trusting a wrong guess.
  //
  // Only a day still marked as leave is touched (S798, LEAVE-OT-HOLIDAYS-4, `planLeaveRevert`): a day
  // that is a public holiday NOW becomes Holiday (a holiday added after the approval used to keep its
  // leave mark and dock the day), and a day re-marked by hand keeps that mark.
  async function revertAttendance(req) {
    // One write per PERIOD, not per day. This used to await a delete inside the day loop, so
    // rejecting a two-week leave cost 14 sequential round trips (a month's medical leave, 22+) —
    // seconds of spinner on a button whose work is a single set operation. Grouping by period_id
    // and passing the days as an `.in()` makes it one request per BS month the leave spans, which
    // is almost always one.
    const writes = []
    for (const { periodId, clear, toHoliday } of planLeaveRevert(req, periods, holidayKeys)) {
      if (clear.length) writes.push(scopedDelete('hr_attendance')
        .eq('employee_id', req.employee_id).eq('period_id', periodId).in('bs_day', clear).in('status', LEAVE_MARK_STATUSES))
      // A holiday is a non-working day, so it carries no clock (S749) — the row syncAttendance writes.
      if (toHoliday.length) writes.push(scopedUpdate('hr_attendance', { status: 'holiday', hours_worked: 0, ot_hours: 0, start_time: null, end_time: null, break_minutes: null })
        .eq('employee_id', req.employee_id).eq('period_id', periodId).in('bs_day', toHoliday).in('status', LEAVE_MARK_STATUSES))
    }
    const results = await Promise.all(writes)
    return results.find(r => r && r.error)?.error || null
  }

  // What a request's days hold before its approval writes them (S798, LEAVE-OT-HOLIDAYS-3), so a refused
  // approval can put them back. The columns are the ones syncAttendance writes. One employee's days
  // in at most a year's periods: a few hundred rows, under the 1000-row cap.
  const LEAVE_DAY_COLS = 'period_id, bs_day, status, hours_worked, ot_hours, start_time, end_time, break_minutes'
  async function readLeaveDays(req, periodList) {
    const groups = leaveDaysByPeriod(req, periodList)
    const results = await Promise.all(groups.map(({ periodId, days }) =>
      scopedFrom('hr_attendance', LEAVE_DAY_COLS)
        .eq('employee_id', req.employee_id).eq('period_id', periodId).in('bs_day', days.map(d => d.bsDay))))
    const error = results.find(r => r.error)?.error
    if (error) return { error }
    return { groups, rows: results.flatMap(r => r.data || []) }
  }

  // Puts a request's days back as `before` read them: a day that had a row gets it back, a day that
  // had none loses the mark the approval wrote (and only that — a leave or holiday mark).
  async function putLeaveDaysBack(req, before) {
    const had = new Set(before.rows.map(r => `${r.period_id}:${r.bs_day}`))
    const writes = []
    if (before.rows.length) {
      writes.push(scopedUpsert('hr_attendance', before.rows.map(r => ({ employee_id: req.employee_id, ...r })), { onConflict: 'employee_id,period_id,bs_day' }))
    }
    for (const { periodId, days } of before.groups) {
      const blank = days.map(d => d.bsDay).filter(d => !had.has(`${periodId}:${d}`))
      if (blank.length) writes.push(scopedDelete('hr_attendance')
        .eq('employee_id', req.employee_id).eq('period_id', periodId).in('bs_day', blank).in('status', [...LEAVE_MARK_STATUSES, 'holiday']))
    }
    const results = await Promise.all(writes)
    return results.find(r => r && r.error)?.error || null
  }

  // The months a request touches whose payroll is finalized, as words — or '' when none are.
  function lockedMonthsLabel(req) {
    return finalizedMonthsFor(req, periods, finalizedPeriodIds)
      .map(m => `${BS_MONTHS[m.bsMonth - 1]} ${m.bsYear}`).join(', ')
  }

  function approveRequest(req) {
    if (!clientId) { setMsg('error:No client selected'); return }
    const type = typeMap[req.leave_type_id]
    if (!type) { setMsg('error:Leave type missing'); return }
    const locked = lockedMonthsLabel(req)
    if (locked) {
      setMsg(`error:Payroll for ${locked} is already finalized, so this leave cannot be approved — it would change attendance under payslips that have been issued. Reopen that payroll run first, or reject the request.`)
      return
    }
    // Over the yearly quota: warn and let the manager decide (decided 2026-09-14). It used to
    // approve silently and only turn the balance red.
    const overrun = quotaOverrun({ requests, settlements, leaveType: type, request: req })
    if (overrun) {
      const emp = empMap[req.employee_id]
      askConfirm({
        title: 'Approve leave over the yearly quota?',
        confirmLabel: 'Approve Anyway', busyLabel: 'Approving…',
        body: (
          <p style={{ margin: 0 }}>
            Approving this puts {emp?.full_name || 'the employee'} at <strong>{fmt(overrun.after)} days</strong> of {type.name} for BS {overrun.bsYear} —{' '}
            <strong>{fmt(overrun.over)} day{overrun.over === 1 ? '' : 's'} over</strong> the {fmt(overrun.quota)}-day quota.
            {type.paid ? ' Every day of it is marked as paid leave. To pay only the days within the quota, reject this and file the extra days as Unpaid Leave.' : ''}
          </p>
        ),
        run: async () => { await approveRequestNow(req, type) },
      })
      return
    }
    approveRequestNow(req, type)
  }

  // The approval itself, without the page's busy flag, message or reload — so a batch can run it per
  // request and reload once (S768). Resolves to { ok: true, missing } or { ok: false, text, reload }.
  async function approveCore(req, type) {
    // Re-read the request's status first, the decide path's guard mirrored: approving off a stale
    // 'pending' would mark attendance for a request someone else has since rejected or cancelled.
    const { data: fresh, error: freshErr } = await scopedFrom('hr_leave_requests', 'status').eq('id', req.id).maybeSingle()
    if (freshErr) return { ok: false, text: 'Could not check this request\'s current status, so nothing was changed — try again. ' + errorText(freshErr, 'operator') }
    if (fresh?.status !== 'pending') {
      return { ok: false, reload: true, text: `${fresh ? `Someone else changed this request first — it now shows ${LEAVE_STATUSES[fresh.status]?.label || fresh.status}` : 'That request no longer exists'}, so it was not approved. The list has been refreshed.` }
    }
    const isHalf = req.day_type && req.day_type !== 'full'
    const status = type.paid
      ? (isHalf ? 'half_paid_leave' : 'paid_leave')
      : (isHalf ? 'half_unpaid_leave' : 'unpaid_leave')
    // A month this page has no period for may have been created since it loaded (S798,
    // LEAVE-OT-HOLIDAYS-6): at month end a close opens the next month while approvals go on. Its
    // back-fill has already run, so these days would be written by nothing, under a message saying
    // there was nothing to do. Re-read before deciding they must wait; the list feeds the snapshot,
    // the write and the put-back alike.
    let periodList = periods
    if (monthsWithoutPeriod(req, periods).length > 0) {
      const { data: pr, error: prErr } = await scopedFrom('monthly_periods', 'id, bs_year, bs_month, status')
      if (prErr) return { ok: false, text: 'Could not check which months exist yet, so nothing was changed — try again. ' + errorLine(prErr) }
      periodList = pr || []
    }
    // What the days hold now, so a refused approval can put them back (S798, LEAVE-OT-HOLIDAYS-3).
    const before = await readLeaveDays(req, periodList)
    if (before.error) return { ok: false, text: 'Could not read the attendance days this leave covers, so nothing was changed — try again. ' + errorLine(before.error) }
    const { missing, error: syncErr } = await syncAttendance(req, status, periodList)
    if (syncErr) return { ok: false, text: 'The leave days could not be marked on the attendance sheet, so the request was NOT approved. Try again. ' + errorLine(syncErr) }
    const { data: apprRows, error: apprErr } = await scopedUpdate('hr_leave_requests', { status: 'approved', decided_at: new Date().toISOString() }).eq('id', req.id).select('id')
    if (apprErr || changedNothing(apprRows, apprErr)) {
      // The days are written and the request did not move — unless the update landed and only its
      // answer was lost. Ask before undoing anything: putting the days back under an approved
      // request would pay an unpaid leave. A 0-row update (S798) takes the same path.
      const reason = apprErr ? errorText(apprErr, 'operator') : NOTHING_CHANGED
      const { data: after, error: afterErr } = await scopedFrom('hr_leave_requests', 'status').eq('id', req.id).maybeSingle()
      if (!afterErr && after?.status === 'approved') return { ok: true, missing }
      if (afterErr) {
        return { ok: false, reload: true, text: 'The leave days were marked on the attendance sheet, but whether the approval went through could not be checked. Reload: if this request still shows Pending, approve it again — if it is refused again, its days are put back. ' + reason }
      }
      const putErr = await putLeaveDaysBack(req, before)
      if (putErr) {
        return { ok: false, reload: true, text: `This request could not be approved, and the leave already marked on the attendance sheet for ${bsLabel(req.start_date)} → ${bsLabel(req.end_date)} could not be put back. Correct those days on the Attendance Sheet, or approve again once the reason below is dealt with. ` + reason + ' ' + errorLine(putErr) }
      }
      return { ok: false, reload: true, text: 'This request could not be approved, so its days on the attendance sheet were put back as they were. ' + reason }
    }
    return { ok: true, missing }
  }

  async function approveRequestNow(req, type) {
    setBusy(true); setMsg('')
    const result = await approveCore(req, type)
    if (!result.ok) {
      if (result.reload) await load()
      setMsg('error:' + result.text)
      setBusy(false); return
    }
    const { missing } = result
    await load()
    // The old sentence here read "Create the period(s), then re-approve to mark those days" — and
    // neither half was possible (S741). The period cannot be opened early (one open period per
    // client), and an approved row has no Approve button to press again. The days are written
    // automatically now, when the month is created, so say that instead of asking for it.
    setMsg(missing.length
      ? `ok:Approved. ${missing.join(', ')} ${missing.length === 1 ? 'has' : 'have'} no period yet, so those days will be marked on the attendance sheet automatically when that month is created — nothing to do now.`
      : 'ok:Approved — attendance marked')
    setBusy(false)
  }

  // Every pending request for the year on screen that can be approved WITHOUT a question: one over
  // its yearly quota needs the manager's own decision (it warns, and that warning is the point), and
  // one in a finalized month cannot be approved at all — both are left out and named. Quota is
  // checked as if the batch's earlier requests were already approved, so two requests that each fit
  // but together overrun are not approved blind (S768).
  function requestBulkApprove() {
    const pending = filteredRequests.filter(r => r.status === 'pending')
    if (pending.length < 2) return
    const ready = [], skipped = []
    let simulated = requests
    for (const req of pending) {
      const type = typeMap[req.leave_type_id]
      const name = empMap[req.employee_id]?.full_name || 'A request'
      if (isOwnEmployee(req.employee_id)) { skipped.push(`${name} — your own request, so another manager or the Owner decides it`); continue }
      if (!type) { skipped.push(`${name} — leave type missing`); continue }
      const locked = lockedMonthsLabel(req)
      if (locked) { skipped.push(`${name} — payroll for ${locked} is finalized`); continue }
      if (quotaOverrun({ requests: simulated, settlements, leaveType: type, request: req })) { skipped.push(`${name} — over the yearly ${type.name} quota`); continue }
      ready.push({ req, type })
      simulated = simulated.map(r => (r.id === req.id ? { ...r, status: 'approved' } : r))
    }
    if (ready.length === 0) {
      setMsg(`error:None of the ${pending.length} pending requests can be approved together — ${skipped.join('; ')}. Decide them one at a time.`)
      return
    }
    const days = ready.reduce((s, x) => s + (parseFloat(x.req.days) || 0), 0)
    askConfirm({
      title: `Approve ${ready.length} leave request${ready.length === 1 ? '' : 's'}?`,
      confirmLabel: `Approve ${ready.length}`, busyLabel: 'Approving…',
      body: (
        <>
          <p style={{ margin: skipped.length ? '0 0 10px' : 0 }}>
            {fmt(days)} day{days === 1 ? '' : 's'} in all. Each request's days are marked on the attendance sheet as paid or unpaid
            leave by its type, so payroll deducts the unpaid ones — exactly as approving it on its own does.
          </p>
          {skipped.length > 0 && <p style={{ margin: 0 }}>Left for you to decide one at a time: {skipped.join('; ')}.</p>}
        </>
      ),
      run: async () => {
        setBusy(true); setMsg('')
        const missingMonths = new Set()
        const { done, failed } = await decideEach(ready, async ({ req, type }) => {
          const r = await approveCore(req, type)
          if (!r.ok) return r.text
          ;(r.missing || []).forEach(m => missingMonths.add(m))
          return true
        })
        await load()
        const later = missingMonths.size ? ` ${[...missingMonths].join(', ')} ${missingMonths.size === 1 ? 'has' : 'have'} no period yet — those days are marked automatically when the month is created.` : ''
        setMsg(failed.length === 0
          ? `ok:Approved ${done.length} leave request${done.length === 1 ? '' : 's'} — attendance marked.${later}`
          : `error:Approved ${done.length} of ${ready.length}. Not approved — ${failed.map(f => `${empMap[f.item.req.employee_id]?.full_name || 'a request'}: ${f.reason}`).join(' · ')}${later}`)
        setBusy(false)
      },
    })
  }

  async function decideRequest(req, newStatus) {
    if (!clientId) { setMsg('error:No client selected'); return }
    const verb = newStatus === 'rejected' ? 'Reject' : 'Cancel'
    const emp = empMap[req.employee_id]
    // Cancelling an APPROVED request deletes its attendance days; in a finalized month those days
    // are what the issued payslip was built from (S749). A pending request touches no attendance.
    const locked = req.status === 'approved' ? lockedMonthsLabel(req) : ''
    if (locked) {
      setMsg(`error:Payroll for ${locked} is already finalized, so this approved leave cannot be ${verb.toLowerCase()}ed — its days are on payslips that have been issued. Reopen that payroll run first.`)
      return
    }
    // Deciding an APPROVED request reverts its attendance marks — pay for daily staff — so the
    // ask names that (S682; was window.confirm).
    askConfirm({
      title: `${verb} this leave request?`,
      confirmLabel: `${verb} Request`, danger: true, busyLabel: `${verb === 'Reject' ? 'Rejecting' : 'Cancelling'}…`,
      body: (
        <p style={{ margin: 0 }}>
          {emp?.full_name || 'The employee'}'s {fmt(req.days)} day{req.days === 1 ? '' : 's'} from {bsLabel(req.start_date)} to {bsLabel(req.end_date)}{' '}
          {req.status === 'approved'
            ? 'are already approved and marked on the attendance sheet. Each day still marked as leave goes back to unmarked — or to Holiday, if it has since become a public holiday — and the leave balance is restored. A day someone has re-marked by hand keeps its mark.'
            : 'are marked ' + verb.toLowerCase() + 'ed and the balance is untouched.'}
        </p>
      ),
      run: async () => { await decideRequestNow(req, newStatus, verb) },
    })
  }

  async function decideRequestNow(req, newStatus, verb) {
    setBusy(true); setMsg('')
    // Re-check the request's current status from the DB rather than trusting the client-cached
    // `req` — another admin session may have approved/decided it since our last load(), and
    // deciding off a stale 'pending' would skip reverting attendance a concurrent approval wrote.
    // A guard that drops its read error passes vacuously: on a failed read `fresh` was null,
    // the revert was skipped, and the request was rejected while its paid-leave days stayed
    // marked (and paid). Refuse before writing anything.
    const { data: fresh, error: freshErr } = await scopedFrom('hr_leave_requests', 'status').eq('id', req.id).maybeSingle()
    if (freshErr) { setMsg('error:Could not check this request\'s current status, so nothing was changed — try again. ' + errorText(freshErr, 'operator')); setBusy(false); return }
    if (fresh?.status === 'approved') {
      const revErr = await revertAttendance(req)
      if (revErr) { setMsg(`error:The attendance days could not be reverted, so the request was not ${verb.toLowerCase()}ed — it is still approved. Try again. ` + errorLine(revErr)); setBusy(false); return }
    }
    const { data: decRows, error: decErr } = await scopedUpdate('hr_leave_requests', { status: newStatus, decided_at: new Date().toISOString() }).eq('id', req.id).select('id')
    if (decErr) {
      await load()
      setMsg(`error:${fresh?.status === 'approved' ? 'The attendance days were reverted, but ' : ''}the request still shows ${fresh?.status || 'its previous status'} — ${verb.toLowerCase()} it again. ` + errorText(decErr, 'operator'))
      setBusy(false)
      return
    }
    // Matched nothing (S798): no retry offered, since the same window gets the same answer.
    if (changedNothing(decRows, decErr)) {
      await load()
      setMsg(`error:${fresh?.status === 'approved' ? 'The attendance days were reverted, but the request was not ' : 'The request was not '}${verb.toLowerCase()}ed. ` + NOTHING_CHANGED)
      setBusy(false)
      return
    }
    await load(); setMsg(`ok:${verb}ed`); setBusy(false)
  }

  // Reopen a rejected or cancelled request — MANAGER rank, not supervisor.
  //
  // Cancel is one unguarded click on the same row as Approve, and until this existed a mis-click
  // was terminal: 'rejected'/'cancelled' were the two statuses with no action at all, so the only
  // way back was re-typing the request and losing its dates, reason, created_at and audit trail.
  //
  // It reopens to PENDING, never straight to 'approved'. approveRequest() is the one place that
  // writes the hr_attendance rows, and a restore that jumped it would show Approved over an
  // attendance sheet with those days blank — payroll would then treat a paid leave as unworked.
  // Two clicks, one consistent state.
  //
  // Rank: a supervisor may decide a request; undoing a decision that has already moved a balance
  // and cleared attendance days is the rank above. Admin and Owner resolve to 'manager' on the HR
  // axis, so both pass.
  function reopenRequest(req) {
    const emp = empMap[req.employee_id]
    // Back to Pending is an open request again, so it may not share days with another one.
    const clash = findOverlappingRequest(requests, { employeeId: req.employee_id, startDate: req.start_date, endDate: req.end_date, excludeId: req.id })
    if (clash) {
      setMsg(`error:${emp?.full_name || 'This employee'} now has a ${clash.status} request for ${bsLabel(clash.start_date)} → ${bsLabel(clash.end_date)}, which shares days with this one, so it cannot be reopened. Cancel or reject that request first.`)
      return
    }
    askConfirm({
      title: 'Reopen this leave request?',
      confirmLabel: 'Reopen Request', busyLabel: 'Reopening…',
      body: (
        <p style={{ margin: 0 }}>
          {emp?.full_name || 'The employee'}'s {fmt(req.days)} day{req.days === 1 ? '' : 's'} from {bsLabel(req.start_date)} to {bsLabel(req.end_date)} go back to <strong>Pending</strong>.
          Nothing is marked on the attendance sheet and no balance moves until you approve it again.
        </p>
      ),
      run: async () => { await reopenRequestNow(req) },
    })
  }

  async function reopenRequestNow(req) {
    setBusy(true); setMsg('')
    // The same stale-row re-read decideRequestNow does, for the opposite reason: if another
    // session has already reopened AND approved this request, writing 'pending' over it would
    // silently un-approve a leave whose attendance days stay marked and paid.
    const { data: fresh, error: freshErr } = await scopedFrom('hr_leave_requests', 'status').eq('id', req.id).maybeSingle()
    if (freshErr) { setMsg('error:Could not check this request\'s current status, so nothing was changed — try again. ' + errorText(freshErr, 'operator')); setBusy(false); return }
    if (!fresh) { await load(); setMsg('error:That request no longer exists — the list has been refreshed.'); setBusy(false); return }
    if (fresh.status !== 'rejected' && fresh.status !== 'cancelled') {
      await load()
      setMsg(`error:Someone else changed this request first — it now shows ${LEAVE_STATUSES[fresh.status]?.label || fresh.status}, so it was not reopened.`)
      setBusy(false); return
    }
    const { data: reopened, error } = await scopedUpdate('hr_leave_requests', { status: 'pending', decided_at: null }).eq('id', req.id).select('id')
    if (error) {
      await load()
      setMsg(`error:The request still shows ${LEAVE_STATUSES[fresh.status]?.label || fresh.status} — reopen it again. ` + errorText(error, 'operator'))
      setBusy(false); return
    }
    if (changedNothing(reopened, error)) {
      await load()
      setMsg('error:The request was not reopened. ' + NOTHING_CHANGED)
      setBusy(false); return
    }
    await load(); setMsg('ok:Reopened — approve it to mark the attendance days'); setBusy(false)
  }

  // ── Balances ──────────────────────────────────────────────────────────────
  // The arithmetic lives in leaveBalance.js so Final Settlement can pre-fill the days it encashes
  // from the same figure this tab shows, instead of asking an operator to work it out (S600).
  const balanceFor = (empId, type) =>
    leaveBalance({ requests, settlements, leaveType: type, employeeId: empId, bsYear })
  const usedFor = (empId, typeId) => balanceFor(empId, types.find(t => t.id === typeId)).used

  // Every tab except Balances works from currently-employed staff, exactly as before.
  const activeEmployees = employees.filter(e => e.status === 'active' || e.status === 'probation')
  const balanceEmployees = showSeparated ? employees : activeEmployees
  const separatedCount = employees.length - activeEmployees.length

  async function exportBalances() {
    const XLSX = await import('xlsx')
    const rows = balanceEmployees.map(e => {
      const row = { Employee: e.full_name, Code: e.employee_code || '', Status: e.status }
      activeTypes.forEach(t => {
        const used = usedFor(e.id, t.id)
        row[t.name] = t.annual_quota > 0 ? `${fmt(used)} / ${fmt(t.annual_quota)}` : fmt(used)
      })
      return row
    })
    const ws = XLSX.utils.json_to_sheet(rows)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Leave Balances')
    XLSX.writeFile(wb, `leave_balances_BS${bsYear}.xlsx`)
  }

  // ── Leave types editing ───────────────────────────────────────────────────
  async function updateType(id, patch) {
    setTypes(ts => ts.map(t => t.id === id ? { ...t, ...patch } : t))
    const { data: saved, error } = await scopedUpdate('hr_leave_types', patch).eq('id', id).select('id')
    // Optimistic; a refused write reloads the stored value and says so — a quota or paid flag
    // that looks saved and is not changes what payroll pays.
    if (error) { setMsg('error:That leave-type change was not saved — the table shows what is stored. ' + errorLine(error)); await load() }
    else if (changedNothing(saved, error)) { setMsg('error:That leave-type change was not saved. ' + NOTHING_CHANGED); await load() }
  }
  async function addType() {
    if (!clientId) { setMsg('error:No client selected'); return }
    setBusy(true)
    const { error } = await scopedInsert('hr_leave_types', {
      name: 'New Leave Type', code: `custom_${Date.now().toString(36)}`,
      paid: true, annual_quota: 0, carry_forward: false, sort_order: (types.length + 1) * 10,
    })
    await load(); setBusy(false)
    if (error) setMsg('error:The leave type was not added. ' + errorLine(error))
  }

  // Waiting requests first, the oldest start first: the one whose days arrive soonest is the one to
  // decide (S805). Then everything decided, newest first as read. Approve all walks this order too,
  // so the earliest leave is the one that uses the balance first when a quota runs short.
  const filteredRequests = useMemo(() => {
    const inYear = requests.filter(r => adToBs(new Date(r.start_date)).year === bsYear)
    const waiting = inYear.filter(r => r.status === 'pending').reverse()
    return [...waiting, ...inYear.filter(r => r.status !== 'pending')]
  }, [requests, bsYear])
  const waitingCount = filteredRequests.filter(r => r.status === 'pending').length
  const openRecord = () => { setMsg(''); setFormOpen(true) }
  // The draft stays for next time; a message about it does not outlive the dialog.
  const closeRecord = () => { setFormOpen(false); setMsg('') }

  // What can be done to a request, for the table's Actions cell and the phone card alike; null when
  // nothing can (the table prints a dash, the card leaves the row out).
  const requestActions = (req, e) => {
    const who = `${e.full_name || 'this request'}, ${bsLabel(req.start_date)}`
    const own = isOwnEmployee(req.employee_id)
    if (req.status === 'pending' || req.status === 'approved') return (
      <>
        {req.status === 'pending' && (own ? (
          <OwnRecordNote label="Your own request"
            tip="This leave is yours, so someone else approves or rejects it — another supervisor, a manager or the Owner. You can still cancel it while it waits." />
        ) : (
          <DecisionButtons who={who} disabled={busy}
            approveTip="Marks these days on the attendance sheet as paid or unpaid leave, by the leave type, so payroll deducts the unpaid ones. Public holidays in the range are marked Holiday and not charged."
            onApprove={() => approveRequest(req)} onReject={() => decideRequest(req, 'rejected')} />
        ))}
        {/* Withdrawing your own pending request moves no pay or balance; cancelling your
            own APPROVED leave puts the days back on the balance, so someone else does it (H8). */}
        {req.status === 'approved' && own ? (
          <OwnRecordNote label="Yours, approved"
            tip="Your own approved leave can only be cancelled by someone else — another supervisor, a manager or the Owner." />
        ) : (
          <button className="btn btn-ghost btn-sm" aria-label={`Cancel the leave for ${who}`} onClick={() => decideRequest(req, 'cancelled')} disabled={busy}>Cancel leave</button>
        )}
      </>
    )
    if ((req.status === 'rejected' || req.status === 'cancelled') && canReopen) return (
      <Tip text="For a reject or cancel made by mistake. Puts the request back to Pending with its original dates and reason — approve it again to re-mark the attendance days." width={270}>
        <button className="btn btn-ghost btn-sm" aria-label={`Reopen the leave for ${who}`} onClick={() => reopenRequest(req)} disabled={busy}>Reopen</button>
      </Tip>
    )
    return null
  }

  if (!hasHrAccess('supervisor')) return <Navigate to="/dashboard" replace />

  return (
    <div>
      <div className="page-header page-header--split">
        <div>
          <h1 className="page-title">Leave</h1>
          <p className="page-subtitle">Leave entitlements, requests, and balances — BS {bsYear}</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {/* While the dialog is open its own copy speaks, so the message is not announced twice. */}
          {msg && !formOpen && <span role={msg.startsWith('ok') ? 'status' : 'alert'} style={{ fontSize: 12, color: msg.startsWith('ok') ? 'var(--theme-green-text)' : 'var(--theme-red-text)', maxWidth: 360 }}>{msg.split(':').slice(1).join(':')}</span>}
          <select className="form-select" aria-label="BS year" value={bsYear} onChange={e => setBsYear(parseInt(e.target.value, 10))}>
            {years.map(y => <option key={y} value={y}>BS {y}</option>)}
          </select>
          <Fab onClick={openRecord} label="+ Record leave" show={tab === 'requests' && !loading && activeEmployees.length > 0} />
        </div>
      </div>

      {/* Approved leave that is not on an attendance sheet (S741). Payroll reads the sheet, not
          this page, so a request can read Approved here while its unpaid days are quietly being
          paid. Two states, two sentences: one is nobody's to act on, the other has a button. */}
      {gaps?.error ? (
        <div role="alert" className="card" style={{ ...amberBanner, fontSize: 12, color: 'var(--theme-text2)', lineHeight: 1.6 }}>
          Could not check whether approved leave has reached the attendance sheets — this page cannot
          confirm that it has. Reload to try again.
        </div>
      ) : (gaps?.unmarked?.length || gaps?.waiting?.length) ? (() => {
        // A month whose payroll is finalized cannot be written (S749), so its missing days get
        // their own sentence naming the way through, and the button acts on the rest only.
        const unmarkedOpen = gaps.unmarked.filter(u => !finalizedPeriodIds.has(u.period.id))
        const unmarkedPaid = gaps.unmarked.filter(u => finalizedPeriodIds.has(u.period.id))
        const sum = list => list.reduce((a, u) => a + u.days, 0)
        const months = list => list.map(u => `${BS_MONTHS[u.period.bs_month - 1]} ${u.period.bs_year}`).join(', ')
        const n = sum(unmarkedOpen), paid = sum(unmarkedPaid)
        return (
        <div role="alert" className="card" style={{ ...amberBanner, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 12, color: 'var(--theme-text2)', lineHeight: 1.6, flex: '1 1 320px' }}>
            {unmarkedOpen.length > 0 && (
              <div>
                <strong style={{ color: 'var(--theme-amber-text)' }}>
                  {n} day{n === 1 ? '' : 's'} of approved leave {n === 1 ? 'is' : 'are'} not on the attendance sheet
                </strong>{' '}
                ({months(unmarkedOpen)}).
                Payroll reads the sheet, so unpaid leave on those days is not being deducted.
              </div>
            )}
            {unmarkedPaid.length > 0 && (
              <div style={{ marginTop: unmarkedOpen.length ? 6 : 0 }}>
                <strong style={{ color: 'var(--theme-amber-text)' }}>
                  {paid} day{paid === 1 ? '' : 's'} of approved leave {paid === 1 ? 'is' : 'are'} missing from {months(unmarkedPaid)}, whose payroll is already finalized
                </strong>{' '}
                — those payslips were issued without them. Reopen that payroll run, then press Mark approved leave, then finalize again.
              </div>
            )}
            {gaps.waiting.length > 0 && (
              <div style={{ marginTop: gaps.unmarked.length ? 6 : 0 }}>
                {gaps.waiting.reduce((a, w) => a + w.days, 0)} day{gaps.waiting.reduce((a, w) => a + w.days, 0) === 1 ? '' : 's'} approved for {gaps.waiting.map(w => `${BS_MONTHS[w.bsMonth - 1]} ${w.bsYear}`).join(', ')} {gaps.waiting.length === 1 ? 'is' : 'are'} waiting for that month to exist — nothing to do, {gaps.waiting.length === 1 ? 'it is' : 'they are'} marked automatically when the period is created.
              </div>
            )}
          </div>
          {unmarkedOpen.length > 0 && (
            <Tip text="Writes the approved leave days onto those months' attendance sheets. A day that already carries a mark is left exactly as it is. A month whose payroll is finalized is not touched." width={260}>
              <button className="btn btn-primary btn-sm" onClick={fillUnmarked} disabled={filling || busy}>
                {filling ? 'Marking…' : 'Mark approved leave'}
              </button>
            </Tip>
          )}
        </div>
        )
      })() : null}

      <Tabs idBase="leave" label="Leave views" active={tab} onChange={setTab} style={{ marginBottom: 18 }}
        tabs={[{ key: 'requests', label: 'Requests' }, { key: 'balances', label: 'Balances' }, { key: 'types', label: 'Leave Types' }]} />

      {loading ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text2)' }}>Loading…</div>
      ) : activeEmployees.length === 0 ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text2)' }}>No active employees. Add employees in HR → Employees first.</div>
      ) : tab === 'requests' ? (
        /* ── REQUESTS ── */
        <div>
          <div className="card" style={{ padding: 0 }}>
            <BulkApproveBar count={waitingCount} noun="leave requests"
              detail={`${fmt(filteredRequests.slice(0, waitingCount).reduce((s, r) => s + (parseFloat(r.days) || 0), 0))} days`}
              onApprove={requestBulkApprove} disabled={busy} />
            {/* Below 600px each request is one card and the table hides (S805, the S796 pattern): the
                days on the first line, the decision last, the waiting ones under their own heading. */}
            <div className="phone-only" style={{ padding: '0 16px' }}>
              {filteredRequests.length === 0 ? (
                <p style={{ textAlign: 'center', color: 'var(--theme-text2)', padding: '28px 0 116px', margin: 0 }}>No requests for BS {bsYear} yet.</p>
              ) : (
                <ul className="phone-cards" aria-label="Leave requests">
                  {[['Waiting for a decision', filteredRequests.slice(0, waitingCount)], ['Decided', filteredRequests.slice(waitingCount)]]
                    .filter(([, list]) => list.length > 0).map(([heading, list]) => (
                      <li key={heading}>
                        <div className="phone-cards__day">{heading} · {list.length}</div>
                        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                          {list.map(req => {
                            const e = empMap[req.employee_id] || {}
                            const t = typeMap[req.leave_type_id]
                            const quota = t?.annual_quota || 0
                            const remaining = quota > 0 ? quota - usedFor(req.employee_id, req.leave_type_id) : null
                            const days = fmt(req.days)
                            const actions = requestActions(req, e)
                            return (
                              <li key={req.id} className="phone-card">
                                <div className="phone-card__top">
                                  <span className="phone-card__title">{e.full_name || '—'}</span>
                                  <span className="phone-card__figure">{days} day{days === 1 ? '' : 's'}</span>
                                </div>
                                <div className="phone-card__meta">
                                  {t?.name || 'Unknown'}{t && !t.paid ? ' · unpaid' : ''} · {bsLabel(req.start_date)} → {bsLabel(req.end_date)}
                                </div>
                                <div className="phone-card__meta">
                                  <span className={`badge ${HR_REQUEST_STATUS[req.status]?.badge || 'badge-gray'}`}>{LEAVE_STATUSES[req.status]?.label || req.status}</span>
                                  {remaining != null && (remaining < 0
                                    ? <span style={{ color: 'var(--theme-red-text)' }}> · {fmt(-remaining)} over the {fmt(quota)}-day quota</span>
                                    : <> · {fmt(remaining)} of {fmt(quota)} days left</>)}
                                  {req.reason ? ` · ${req.reason}` : ''}
                                </div>
                                {actions && <div className="phone-card__actions">{actions}</div>}
                              </li>
                            )
                          })}
                        </ul>
                      </li>
                    ))}
                </ul>
              )}
            </div>
            <div className="table-wrap phone-hide">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Type</th>
                    <th>Dates (BS)</th>
                    <th>Reason</th>
                    <th style={{ textAlign: 'right' }}>
                      <Tip text="Days charged — every calendar day in the range except public holidays; half-day requests show 0.5." width={240}>Days</Tip>
                    </th>
                    <th style={{ textAlign: 'right' }}>
                      <Tip text="Remaining balance for this leave type after approved leave this BS year." width={250}>Balance</Tip>
                    </th>
                    <th>Status</th>
                    <th style={{ textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRequests.length === 0 ? (
                    <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--theme-text2)', padding: 28 }}>No requests for BS {bsYear} yet.</td></tr>
                  ) : filteredRequests.map(req => {
                    const e = empMap[req.employee_id] || {}
                    const t = typeMap[req.leave_type_id]
                    const sc = LEAVE_STATUSES[req.status] || {}
                    const quota = t?.annual_quota || 0
                    const remaining = quota > 0 ? quota - usedFor(req.employee_id, req.leave_type_id) : null
                    return (
                      <tr key={req.id}>
                        <td>
                          <div style={{ fontWeight: 600, color: 'var(--theme-text1)', fontSize: 13 }}>{e.full_name || '—'}</div>
                          {e.employee_code && <div style={{ fontSize: 10, color: 'var(--theme-text2)' }}>{e.employee_code}</div>}
                        </td>
                        <td>
                          <span style={{ fontSize: 11, fontWeight: 700, color: typeText(t?.color), background: typeTint(t?.color, 10), border: `1px solid ${typeTint(t?.color, 20)}`, borderRadius: 0, padding: '2px 8px' }}>
                            {t?.name || 'Unknown'}{t && !t.paid ? ' · unpaid' : ''}
                          </span>
                        </td>
                        <td style={{ fontSize: 12, color: 'var(--theme-text3)', whiteSpace: 'nowrap' }}>
                          {bsLabel(req.start_date)} → {bsLabel(req.end_date)}
                        </td>
                        <td style={{ fontSize: 12, color: 'var(--theme-text3)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={req.reason || ''}>
                          {req.reason || '—'}
                        </td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-text1)', fontWeight: 600 }}>{fmt(req.days)}</td>
                        <td style={{ textAlign: 'right', color: remaining == null ? 'var(--theme-text2)' : remaining < 0 ? 'var(--theme-red-text)' : 'var(--theme-text3)' }}>
                          {remaining == null ? '—' : `${fmt(remaining)} / ${fmt(quota)}`}
                        </td>
                        <td><span style={{ fontSize: 11, fontWeight: 700, color: sc.color }}>{sc.label}</span></td>
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                          {requestActions(req, e) ?? <span style={{ fontSize: 11, color: 'var(--theme-text2)' }}>—</span>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
          {/* Two sentences (S805). Its other rules moved to where they apply: Approve's Tip, the cancel
              and Reopen confirms, the form's day count, the waiting-month banner, and Help. */}
          <p className="page-footnote">
            Approving marks the days on the attendance sheet, so payroll deducts unpaid leave by itself. Cancelling an
            approved request clears those days back to blank, not to Present: re-mark them in Attendance if the person did work.
          </p>
        </div>
      ) : tab === 'balances' ? (
        /* ── BALANCES ── */
        <div>
          <div className="card no-print" style={{ marginBottom: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            {/* Every other HR screen hides separated staff, correctly — but a balance is most
                often questioned AFTER someone leaves, when their final settlement encashed some
                of it. Hiding them here made the encashment invisible on the one screen that
                shows balances at all. */}
            {separatedCount > 0 ? (
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--theme-text2)', cursor: 'pointer' }}>
                <input type="checkbox" checked={showSeparated} onChange={e => setShowSeparated(e.target.checked)} />
                Include separated staff ({separatedCount})
              </label>
            ) : <span />}
            <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={exportBalances}>⬇ Export Excel</button>
          </div>
          <div className="card" style={{ padding: 0 }}>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th style={{ position: 'sticky', left: 0, background: 'var(--theme-card)', zIndex: 1 }}>Employee</th>
                    {activeTypes.map(t => (
                      <th key={t.id} style={{ textAlign: 'right', color: typeText(t.color) }}>
                        <Tip text={`${t.name}: ${t.annual_quota > 0 ? t.annual_quota + ' days/year' : 'uncapped'}${t.paid ? '' : ', unpaid'}. ${t.annual_quota > 0 ? 'Shows used / quota.' : 'Shows the days taken.'}`} width={240}>{t.name}</Tip>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {balanceEmployees.map(e => (
                    <tr key={e.id}>
                      <td style={{ position: 'sticky', left: 0, background: 'var(--theme-card)', zIndex: 1, fontWeight: 600, color: 'var(--theme-text1)', whiteSpace: 'nowrap' }}>
                        {e.full_name}
                        {e.status !== 'active' && e.status !== 'probation' && (
                          <span className="badge-gray" style={{ marginLeft: 8, fontSize: 10, textTransform: 'capitalize' }}>{e.status}</span>
                        )}
                      </td>
                      {activeTypes.map(t => {
                        const bal = balanceFor(e.id, t)
                        const used = bal.used + bal.encashed
                        const remaining = bal.remaining
                        const over = bal.capped && remaining < 0
                        return (
                          <td key={t.id} style={{ textAlign: 'right', color: over ? 'var(--theme-red-text)' : used > 0 ? 'var(--theme-text1)' : 'var(--theme-text2)' }}>
                            {t.annual_quota > 0
                              ? <span><b>{fmt(used)}</b> <span style={{ color: 'var(--theme-text2)' }}>/ {fmt(t.annual_quota)}</span></span>
                              : (used > 0 ? <b>{fmt(used)}</b> : '—')}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <p className="page-footnote">
            Used is approved requests plus any days encashed on a finalized settlement, since both are already paid for.
            Balances run on the BS calendar year {bsYear}, not the Shrawan fiscal year that payroll and festival allowance use.
          </p>
        </div>
      ) : (
        /* ── LEAVE TYPES (admin) ── */
        <div>
          <div className="card no-print" style={{ marginBottom: 14, display: 'flex', justifyContent: 'flex-end' }}>
            <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={addType} disabled={busy}>+ Add Type</button>
          </div>
          <div className="card" style={{ padding: 0 }}>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th style={{ textAlign: 'center' }}>
                      <Tip text="Paid leave marks Attendance as Paid Leave; unpaid marks Unpaid Leave (which Payroll deducts)." width={260}>Paid</Tip>
                    </th>
                    <th style={{ textAlign: 'right' }}>
                      <Tip text="Days allowed per year, as one flat figure: it does not build up month by month. 0 = uncapped (e.g. unpaid leave)." width={240}>Annual Quota</Tip>
                    </th>
                    <th style={{ textAlign: 'center' }}>
                      <Tip text="Whether unused days carry into next year. Stored for reference — roll-over is not yet automatic." width={260}>Carry Fwd</Tip>
                    </th>
                    <th style={{ textAlign: 'center' }}>
                      <Tip text="Inactive types are hidden from new requests but kept for history." width={240}>Active</Tip>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {types.map(t => (
                    <tr key={t.id}>
                      <td>
                        <input aria-label={`Name — ${t.name}`} defaultValue={t.name}
                          onBlur={e => {
                            const name = e.target.value.trim()
                            if (name === t.name) return
                            if (!name) { e.target.value = t.name; setMsg('error:A leave type needs a name — it was put back.'); return }
                            updateType(t.id, { name })
                          }}
                          className="form-input" style={{ color: typeText(t.color), fontWeight: 600 }} />
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <input aria-label={`Paid — ${t.name}`} type="checkbox" checked={t.paid} onChange={e => updateType(t.id, { paid: e.target.checked })} />
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <input aria-label={`Annual quota — ${t.name}`} type="number" min="0" step="0.5" defaultValue={t.annual_quota}
                          onBlur={e => {
                            // Blank means 0 (uncapped), as the tip says. Anything that is not a
                            // number of days is put back — it used to become 0, i.e. UNCAPPED.
                            const raw = e.target.value.trim()
                            const n = raw === '' ? 0 : Number(raw)
                            if (!Number.isFinite(n) || n < 0) { e.target.value = t.annual_quota; setMsg('error:Annual Quota must be a number of days, 0 or more (0 means uncapped) — it was put back.'); return }
                            if (n === parseFloat(t.annual_quota)) return
                            updateType(t.id, { annual_quota: n })
                          }}
                          className="form-input" style={{ width: 90, textAlign: 'right' }} />
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <input aria-label={`Carry forward — ${t.name}`} type="checkbox" checked={t.carry_forward} onChange={e => updateType(t.id, { carry_forward: e.target.checked })} />
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <input aria-label={`Active — ${t.name}`} type="checkbox" checked={t.active} onChange={e => updateType(t.id, { active: e.target.checked })} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <p className="page-footnote">
            Defaults follow Nepal's Labour Act 2074, and Maternity (98 days) and Paternity (15) are per birth, not per year. Edits save automatically.
          </p>
        </div>
      )}
      {/* Record leave (S805): the form behind the header's + Record leave, so the queue opens the page.
          The button stays mounted while this is open (the overlay covers it), so closing returns focus
          to it rather than to the top of the page. */}
      {formOpen && (
        <Modal onClose={closeRecord} title="Record leave" maxWidth={600}>
          <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.5 }}>
            It joins the list as Pending. Approving it there is what marks the days on the attendance sheet.
          </p>
          <div className="field-grid" style={{ alignItems: 'start' }}>
            <div>
              <label style={lbl} htmlFor="leave-employee">Employee</label>
              <select id="leave-employee" className="form-select" style={{ width: '100%' }} value={fEmp} onChange={e => setFEmp(e.target.value)}>
                <option value="">— Select —</option>
                {activeEmployees.map(e => <option key={e.id} value={e.id}>{e.full_name}</option>)}
              </select>
            </div>
            <div>
              <label style={lbl} htmlFor="leave-type">Leave Type</label>
              <select id="leave-type" className="form-select" style={{ width: '100%' }} value={fType} onChange={e => setFType(e.target.value)}>
                <option value="">— Select —</option>
                {activeTypes.map(t => <option key={t.id} value={t.id}>{t.name}{t.paid ? '' : ' (unpaid)'}</option>)}
              </select>
            </div>
            <div>
              <label style={lbl} htmlFor="leave-start-date">Start Date</label>
              <BsCalendarPicker id="leave-start-date" value={fStart} onChange={setFStart} placeholder="Pick start date" />
            </div>
            <div>
              <label style={lbl} htmlFor="leave-end-date">End Date</label>
              <BsCalendarPicker id="leave-end-date" value={fEnd} onChange={setFEnd} placeholder="Pick end date" />
            </div>
            <div>
              <label style={lbl} htmlFor="leave-day-type">
                <Tip text="Only applies to a single-day request — pick the same Start and End date." width={240}>Day Type</Tip>
              </label>
              <select id="leave-day-type" className="form-select" style={disabledStyle({ width: '100%' }, !isSingleDay)} value={fDayType} disabled={!isSingleDay} onChange={e => setFDayType(e.target.value)}>
                {DAY_TYPES.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
              </select>
            </div>
            <div>
              <label style={lbl} htmlFor="leave-reason">Reason</label>
              <input id="leave-reason" className="form-input" value={fReason} onChange={e => setFReason(e.target.value)} placeholder="Optional" />
            </div>
          </div>
          <div style={{ marginTop: 14, fontSize: 12, color: 'var(--theme-text2)' }}>
            <Tip text="Every day in the picked range counts against the balance except public holidays from the Holiday Calendar, which are marked Holiday instead. Rostered days off still count — adjust the dates if the employee has one within this range." width={260}>
              {fStart && fEnd
                ? `${fmt(previewDaysCount)} day${previewDaysCount === 1 ? '' : 's'}${preview.holidayDays.length ? ` · ${preview.holidayDays.length} public holiday${preview.holidayDays.length === 1 ? '' : 's'} not counted` : ''}`
                : 'Pick a date range'}
            </Tip>
          </div>
          {msg && <div role={msg.startsWith('ok') ? 'status' : 'alert'} style={{ marginTop: 12, fontSize: 12, color: msg.startsWith('ok') ? 'var(--theme-green-text)' : 'var(--theme-red-text)' }}>{msg.split(':').slice(1).join(':')}</div>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
            <button type="button" className="btn btn-ghost" onClick={closeRecord}>Cancel</button>
            <button type="button" className="btn btn-primary" onClick={submitRequest} disabled={busy}>{busy ? 'Saving…' : 'Submit Request'}</button>
          </div>
        </Modal>
      )}
      {confirmEl}
    </div>
  )
}

const lbl = { display: 'block', fontSize: 12, color: 'var(--theme-text2)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.05em' }
