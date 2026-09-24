import { nprInt } from '../../../shared/nepalMoney'
import { useState, useEffect, useMemo, useRef, Fragment } from 'react'
import { Navigate, Link } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'
import RunStatusBadge from './RunStatusBadge'
import Modal from '../../../components/Modal'
import ConfirmModal from '../../../components/ConfirmModal'
import ReportLoadError from '../../../components/ReportLoadError'
import { BS_MONTHS, daysInBsMonth, formatAd, formatAdAsBs } from '../../../utils/bsCalendar'
import { nepalBs, nepalCivilDate, nepalBsLong, nepalDateLong } from '../../../shared/nepalTime'
import {
  fetchYtdMap, fetchApprovedTadaMap, payslipDrift, periodAdBounds, dueAdvances,
  fetchPayrollEmployees, fetchEmployeesByIds, buildPayrollRows, allocateAdvanceRepayments, payrollCashCost,
} from './payrollData'
import PayslipBody from './PayslipBody'
import PayrollApprovalSheet from './PayrollApprovalSheet'
import { CalcDetail, StoredDetail, FINALIZED_INTRO, driftParts, orphanIntro } from './PayslipCalculation'
import RowDisclosure from '../../../components/RowDisclosure'
import RowMenu from '../../../components/RowMenu'
import PayrollMonthStatus from './PayrollMonthStatus'
import { fetchRunPayments, runPaymentSummary, methodLabel } from './salaryPayments'
import { MarkPaidDialog, UndoPaymentDialog } from './SalaryPaymentDialogs'
import { printWithTitle } from '../../../utils/printTitle'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'
import { useConfirm } from '../../../shared/hooks/useConfirm'
import { errorText, errorLine } from '../../../shared/errorText'

const fmt = nprInt
const num = v => parseFloat(v) || 0

// The error OBJECT of the first failed result, not firstError()'s message string — errorText's table
// matches on the Postgres code as well as the message, and the code is what a string loses.
const errorOf = results => ((results || []).find(r => r && r.error) || {}).error || null

const isRunFinalizedError = err => /hr_run_finalized/i.test(typeof err === 'string' ? err : (err?.message || ''))

const listNames = (ids, nameOf, max = 4) =>
  ids.slice(0, max).map(nameOf).join(', ') + (ids.length > max ? `, +${ids.length - max} more` : '')

const FRESH = { live: null, stale: [], missing: [], departed: [], overridden: [], ok: true, reason: null, empty: false }

// Draft vs live — the ONE assessment (S751). The amber banner, the Finalize button and finalize()'s
// own re-check all go through it; finalize() runs it over data re-read at the moment of committing,
// because the page's copy can be minutes old and Finalize locks whatever it is shown.
//
// Four ways a draft is not finalizable, and every one of them blocks:
//   stale     — a computed input moved since Generate (payslipDrift — inputs, never net_pay)
//   missing   — someone on this month's payroll list has no payslip. A run with NO payslips (Generate's
//               payslip insert failed) counts everyone as missing, so it can never be finalized empty.
//   departed  — a stored payslip for someone NOT on the list: already paid by a finalized Final
//               Settlement, or not employed that month at all. S600 made this bucket non-blocking,
//               because Regenerate used to destroy a leaver's legitimate payslip. It cannot any more —
//               fetchPayrollEmployees keeps a leaver on the list to their last day — so what is left
//               in this bucket is exactly the payslips this run must not pay, and Regenerate removes them.
//   reason    — the comparison itself could not run. A check that could not run has not passed; it
//               used to `catch { return ok: true }`.
function assessDraft(storedSlips, buildLive) {
  const out = { live: null, stale: [], missing: [], departed: [], overridden: [], ok: false, reason: null }
  try {
    out.live = buildLive() || []
  } catch (e) {
    out.reason = 'This draft could not be checked against current salary, attendance and overtime data'
      + (e?.message ? ` (${e.message})` : '') + ', so it cannot be finalized until it can.'
    return out
  }
  const stored = storedSlips || []
  if (stored.length === 0) {
    out.missing = out.live.map(r => r.payslip.employee_id)
    // No payslips AND nobody on the list: Regenerate would build nothing, Finalize would refuse, and the
    // banner used to send the reader round that loop for ever. The page offers to delete the run instead.
    out.empty = out.live.length === 0
    out.reason = out.empty
      ? "Nobody is on this month's payroll, and this run has no payslips — there is nothing for it to pay."
      : 'This run has no payslips — they were never written, so there is nothing to finalize. Press Regenerate to build them.'
    return out
  }
  const storedByEmp = new Map(stored.map(s => [s.employee_id, s]))
  out.live.forEach(({ payslip }) => {
    const s = storedByEmp.get(payslip.employee_id)
    if (!s) { out.missing.push(payslip.employee_id); return }
    const drift = payslipDrift(s, payslip)
    if (drift === 'moved') out.stale.push(payslip.employee_id)
    else if (drift === 'overridden') out.overridden.push(payslip.employee_id)
  })
  const liveIds = new Set(out.live.map(r => r.payslip.employee_id))
  out.departed = stored.filter(s => !liveIds.has(s.employee_id)).map(s => s.employee_id)
  out.ok = out.stale.length === 0 && out.missing.length === 0 && out.departed.length === 0
  return out
}

// Where today sits against the payroll month, in Nepal — for the Finalize confirm (decision 5:
// finalizing early is allowed, but the confirm says so). null once the month is over.
function monthProgress(period) {
  const today = nepalBs(new Date())
  if (!today || !period) return null
  const t = today.year * 12 + today.month
  const p = period.bs_year * 12 + period.bs_month
  if (t > p) return null
  if (t < p) return { future: true }
  return { left: Math.max(0, daysInBsMonth(period.bs_year, period.bs_month) - today.day) }
}

export default function PayrollRun() {
  const { clientId, hasHrAccess, profile, isAdmin, isOwner } = useAuth()
  const { scopedFrom, scopedInsert, scopedUpdate, scopedDelete } = useScopedDb()
  const periodReq = useLatestRequest()
  const { ask: askConfirm, confirmEl } = useConfirm()
  const [periods,    setPeriods]    = useState([])
  const [period,     setPeriod]     = useState(null)
  const [run,        setRun]        = useState(null)
  const [payslips,   setPayslips]   = useState([])
  const [employees,  setEmployees]  = useState([])
  // Left out of this month because a finalized Final Settlement already paid it — named on screen.
  const [settled,    setSettled]    = useState([])
  // People a stored payslip belongs to who are on neither list above (settled since, or not employed
  // this month) — read by id so a banner, a row, a payslip or the workbook never says "Unknown".
  const [extraEmps,  setExtraEmps]  = useState([])
  const [components, setComponents] = useState([])
  const [attendance, setAttendance] = useState([])
  const [otEntries,  setOtEntries]  = useState([])
  const [advances,   setAdvances]   = useState([])
  const [repayments, setRepayments] = useState([])
  const [ytdMap,     setYtdMap]     = useState({})
  const [tadaMap,    setTadaMap]    = useState({})
  const [loading,    setLoading]    = useState(true)
  // A failed read — periods, any payroll input, the run, its payslips, or the names they need. Renders
  // the error card INSTEAD of the register and hides every action: nothing below it is a real figure,
  // and "No active employees. Add employees…" over a failed read sent an owner to re-enter staff.
  const [loadError,  setLoadError]  = useState(null)
  // Salary payments recorded against this run (S782), undone ones included. A failed read is its own
  // state, never an empty list: "nobody is paid" over a read that failed would invite paying twice.
  // It does not take the register down with it — the figures are still right; only "who is paid"
  // is unknown, and the page says exactly that.
  const [payments,   setPayments]   = useState([])
  const [paymentsError, setPaymentsError] = useState(null)
  // null | [{ employee_id, name, due }] — the Mark paid dialog; null | { payment, name } — Undo.
  const [markPaid,   setMarkPaid]   = useState(null)
  const [undoPay,    setUndoPay]    = useState(null)
  const [busy,       setBusy]       = useState(false)
  const [msg,        setMsg]        = useState('')
  // Which consequential action is awaiting its ConfirmModal: null | 'regenerate' | 'finalize'
  // | 'reopen'. These three all write to other ledgers (payslips, advance repayments, TADA), so
  // their confirms carry consequence copy in the product's own Modal, not window.confirm (S575).
  const [confirmAction, setConfirmAction] = useState(null)
  // Pending leave/overtime for the Finalize confirm, read when it opens: { loading } | { leave, ot, failed }.
  const [pending,    setPending]    = useState(null)
  const pendingReq = useRef(0)
  // The TDS box is controlled: a typed value lives here until blur, then the box shows what is stored.
  // With `defaultValue` a refused save left the refused figure sitting in the box looking saved.
  const [tdsDraft,   setTdsDraft]   = useState({})
  const [viewSlip,   setViewSlip]   = useState(null)
  const [printSlip,  setPrintSlip]  = useState(null)
  // The row whose working is open, and the working being printed. This page absorbed the separate
  // Payroll Calculation page (S768): the explanation of a figure belongs beside the figure.
  const [expandedId, setExpandedId] = useState(null)
  const [printCalc,  setPrintCalc]  = useState(null)
  // The month's approval sheet for the Owner to sign (S777) — printed, or saved as PDF from the dialog.
  const [printApproval, setPrintApproval] = useState(false)
  // Company letterhead for the payslip — a payslip with no employer identity on it at all is
  // missing the single most basic thing a pay document is expected to have. Same source fields
  // Tax Invoice already prints (settings.vat_number is Nepal's PAN, reused as-is — not a new ID).
  const [bizInfo, setBizInfo] = useState({ name: '', address: '', vatNumber: '' })
  const [bizInfoFailed, setBizInfoFailed] = useState(false)

  const empMap = useMemo(
    () => Object.fromEntries([...extraEmps, ...settled, ...employees].map(e => [e.id, e])),
    [employees, settled, extraEmps],
  )
  const nameOf = id => empMap[id]?.full_name || '(employee record not found)'

  useEffect(() => {
    if (!clientId) return
    // A response for the client this page showed BEFORE an admin switched is ignored, or one outlet's
    // name would print on another outlet's payslips. A failed read still lets a payslip print — just
    // without its letterhead, which the payslip dialog now says (S751).
    let current = true
    setBizInfo({ name: '', address: '', vatNumber: '' }); setBizInfoFailed(false)
    Promise.all([
      supabase.from('clients').select('name').eq('id', clientId).single(),
      supabase.from('settings').select('property_address, vat_number').eq('client_id', clientId).maybeSingle(),
    ]).then(([client, settings]) => {
      if (!current) return
      if (client.error || settings.error) setBizInfoFailed(true)
      setBizInfo({ name: client.data?.name || '', address: settings.data?.property_address || '', vatNumber: settings.data?.vat_number || '' })
    })
    return () => { current = false }
  }, [clientId])

  useEffect(() => {
    if (!clientId) return
    async function init() {
      // Claimed BEFORE the first await (S751, the S721 shape). Without it, once the period had been
      // changed even once the guard's key stayed on that period, so after an outlet/client switch this
      // init's own load failed isCurrent and every setter was skipped — the new outlet's month label
      // over the old outlet's register, and Generate inserting the old outlet's payslips under the
      // new client. The claim is re-keyed to the period id once it is known.
      const claim = periodReq.begin(`init:${clientId}`)
      // Everything the previous client showed is dropped before the first await, so no label, list or
      // name from one outlet can sit over another's while this loads (S751 review).
      setLoading(true); setMsg(''); setLoadError(null); setRun(null); setPayslips([])
      setPayments([]); setPaymentsError(null); setMarkPaid(null); setUndoPay(null)
      setPeriods([]); setPeriod(null); setEmployees([]); setSettled([]); setExtraEmps([]); setConfirmAction(null)
      const { data: p, error: pErr } = await scopedFrom('monthly_periods')
        .order('bs_year', { ascending: false }).order('bs_month', { ascending: false })
      if (!periodReq.isCurrent(claim)) return
      if (pErr) { setPeriods([]); setPeriod(null); setLoadError(pErr); setLoading(false); return }
      setPeriods(p || [])
      const open = (p || []).find(x => x.status === 'open') || (p || [])[0] || null
      setPeriod(open)
      if (!open) { setLoading(false); return }
      periodReq.begin(open.id)
      await loadAll(open)
      if (periodReq.isCurrent(open.id)) setLoading(false)
    }
    init()
  }, [clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Everything a month's payslips are computed from, read together. Used by the page load AND by
  // Generate, Regenerate and Finalize, so every write is computed from data read for that write — not
  // from whatever was on screen when the page opened.
  async function readInputs(p) {
    const results = await Promise.all([
      // Who this month covers (decisions 4 and 14): active/probation plus anyone whose last day falls
      // in or after it, minus anyone already paid by a finalized Final Settlement (returned as `settled`).
      fetchPayrollEmployees(scopedFrom, p),
      // Paged: a few rows per employee, so a large staff crosses the 1000-row cap, and a truncated read
      // silently drops allowances and deductions from pay.
      fetchAllRows(() => scopedFrom('hr_salary_components').order('id')),
      // Paged: hr_attendance is one row per employee PER DAY and crosses the silent 1000-row cap at
      // ~34 staff — employees past the cutoff look like they have no attendance at all (S529).
      fetchAllRows(() => scopedFrom('hr_attendance').eq('period_id', p.id).order('id')),
      // bs_day is load-bearing, not display data: approved entries supersede attendance OT per day.
      scopedFrom('hr_overtime_entries', 'employee_id, bs_day, ot_hours, ot_type')
        .eq('bs_year', p.bs_year).eq('bs_month', p.bs_month).eq('status', 'approved'),
      // Paged. Both are UNFILTERED lifetime ledgers that grow without bound; a truncated repayments
      // read makes advances look less repaid than they are and over-deducts. `.order('id')` is the
      // unique tiebreaker fetchAllRows needs — issued_date is not unique.
      fetchAllRows(() => scopedFrom('hr_advances').order('issued_date').order('id')),
      fetchAllRows(() => scopedFrom('hr_advance_repayments').order('id')),
      // An empty YTD map is a legitimate value (the fiscal year's first month), so a failed read here
      // does not look like one — it under-withholds tax. Both return { data, error }.
      fetchYtdMap(scopedFrom, p),
      fetchApprovedTadaMap(scopedFrom, p),
    ])
    const error = errorOf(results)
    if (error) return { data: null, error }
    const [emps, comps, att, ot, advs, reps, ytd, tada] = results
    return {
      data: {
        employees: emps.data.employees, settled: emps.data.settled,
        components: comps.data || [], attendance: att.data || [], otEntries: ot.data || [],
        advances: advs.data || [], repayments: reps.data || [],
        ytdMap: ytd.data || {}, tadaMap: tada.data || {},
      },
      error: null,
    }
  }

  async function loadAll(p) {
    const [inputs, runRes] = await Promise.all([
      readInputs(p),
      scopedFrom('hr_payroll_runs').eq('period_id', p.id).maybeSingle(),
    ])
    let error = inputs.error || runRes.error
    let slips = []
    let extra = []
    let pays = []
    let payErr = null
    const runRow = runRes.data || null
    if (!error && runRow) {
      const [slipRes, payRes] = await Promise.all([
        scopedFrom('hr_payslips').eq('run_id', runRow.id),
        fetchRunPayments(scopedFrom, runRow.id),
      ])
      if (payRes.error) payErr = payRes.error
      else pays = payRes.data || []
      if (slipRes.error) error = slipRes.error
      else {
        slips = slipRes.data || []
        const known = new Set([...inputs.data.employees, ...inputs.data.settled].map(e => e.id))
        // Payments too (S788): someone paid and then regenerated out of the month has no payslip, and
        // their row must carry a name rather than "(employee record not found)".
        const wanted = [...new Set([...slips, ...pays].map(r => r.employee_id))]
        const names = await fetchEmployeesByIds(scopedFrom, wanted.filter(id => !known.has(id)))
        if (names.error) error = names.error
        else extra = names.data || []
      }
    }
    if (!periodReq.isCurrent(p.id)) return   // superseded by a newer period selection
    // A failed read is not an empty month, and a failed PAYSLIP read under a saved run is not a run
    // with no payslips: either used to render as one — an empty register, a "No active employees"
    // card, or a stale-draft comparison run against nothing. All of it is refused as a whole.
    if (error) {
      setLoadError(error)
      setRun(null); setPayslips([]); setEmployees([]); setSettled([]); setExtraEmps([])
      setPayments([]); setPaymentsError(null)
      return
    }
    const d = inputs.data
    setLoadError(null)
    setEmployees(d.employees); setSettled(d.settled); setExtraEmps(extra)
    setComponents(d.components); setAttendance(d.attendance); setOtEntries(d.otEntries)
    setAdvances(d.advances); setRepayments(d.repayments)
    setYtdMap(d.ytdMap); setTadaMap(d.tadaMap)
    setRun(runRow); setPayslips(slips); setTdsDraft({})
    setPayments(pays); setPaymentsError(payErr)
  }

  async function handlePeriodChange(id) {
    periodReq.begin(id)   // claim the page before any await
    const p = periods.find(x => x.id === id); if (!p) return
    setPeriod(p); setMsg(''); setLoading(true); setConfirmAction(null); setExpandedId(null)
    setMarkPaid(null); setUndoPay(null)
    await loadAll(p)
    if (periodReq.isCurrent(id)) setLoading(false)
  }

  // The live recomputation from the loaded data — one buildPayrollRows (payrollData.js), the same
  // function Generate inserts from and each row's working shows, never a second copy of the arithmetic.
  // Memoized: it runs computePayslip plus a TDS slab walk for every employee, and none of the page's
  // cheap state (a message, a busy flag, a TDS keystroke, an open confirm) moves any of its inputs.
  const liveRows = useMemo(() => {
    // Only a saved run reads it (freshness, the OT badge, ↺); with no run there is nothing to compare.
    if (loading || loadError || !period || !run) return { rows: [], error: null }
    try {
      return { rows: buildPayrollRows({ runId: null, period, employees, components, attendance, otEntries, advances, repayments, ytdMap, tadaMap }), error: null }
    } catch (e) {
      return { rows: null, error: e }
    }
  }, [loading, loadError, period, run, employees, components, attendance, otEntries, advances, repayments, ytdMap, tadaMap])

  const liveByEmp = useMemo(() => new Map((liveRows.rows || []).map(r => [r.payslip.employee_id, r])), [liveRows])
  // The advances this month is recovering, through the same dueAdvances() filter the deduction came
  // from, so a row's working cannot count an advance the run is not cutting.
  const dueNow = useMemo(() => (period ? dueAdvances(advances, period) : []), [advances, period])

  // Live-vs-stored freshness. The draft is a snapshot taken at Generate time, so approving overtime,
  // editing attendance or approving a TADA claim afterwards leaves it quietly wrong — and Finalize
  // locks whatever is on screen. Only a draft has anything to be stale against.
  const freshness = useMemo(() => {
    if (loading || loadError || !run || run.status === 'finalized') return FRESH
    return assessDraft(payslips, () => { if (liveRows.error) throw liveRows.error; return liveRows.rows })
  }, [loading, loadError, run, payslips, liveRows])

  async function generate() {
    if (!period || busy) return
    const p = period
    setBusy(true); setMsg('')
    // Read for this write, and checked BEFORE anything is written: these inputs decide every payslip
    // it inserts, and a failed YTD read persists under-withheld tax that nothing later recomputes.
    const inputs = await readInputs(p)
    if (inputs.error) { setMsg('error:The payroll run was not created — nothing has changed. The data it is built from could not be read. ' + errorLine(inputs.error)); setBusy(false); return }
    if (inputs.data.employees.length === 0) {
      await loadAll(p)
      setMsg('error:The payroll run was not created — nobody is on the payroll for this month.'); setBusy(false); return
    }
    let rows
    try { rows = buildPayrollRows({ runId: null, period: p, ...inputs.data }) } catch (e) {
      setMsg('error:The payroll run was not created — the payslips could not be calculated. ' + errorLine(e)); setBusy(false); return
    }
    const { data: runRow, error: rErr } = await scopedInsert('hr_payroll_runs', { period_id: p.id, status: 'draft' }, { single: true })
    if (rErr) {
      // (client_id, period_id) is unique: another tab or another manager created this month's run
      // between this page loading and this click. Show that run — "nothing has changed" was false,
      // and leaving the Generate card up invited a second click into the same refusal.
      if (rErr.code === '23505') {
        await loadAll(p)
        setMsg('error:A payroll run for this month was created a moment ago somewhere else (another tab, or another manager), so this click created nothing. That run is shown below — Regenerate it if it needs the latest data.')
        setBusy(false); return
      }
      setMsg('error:The payroll run was not created — nothing has changed. ' + errorLine(rErr)); setBusy(false); return
    }
    const { error: pErr } = await scopedInsert('hr_payslips', rows.map(r => ({ ...r.payslip, run_id: runRow.id })))
    if (pErr) {
      // The run row is committed at this point; it has no payslips, which blocks Finalize until
      // Regenerate builds them.
      await loadAll(p)
      setMsg('error:The run was created but its payslips were not — press Regenerate to build them. ' + errorLine(pErr)); setBusy(false); return
    }
    await loadAll(p)
    setMsg('ok:Payroll generated'); setBusy(false)
  }

  async function regenerate() {
    if (!run || run.status === 'finalized' || !period) return
    const p = period
    const runId = run.id
    // The departed-payslip warning lives in the regenerate ConfirmModal's own body below (S612).
    setConfirmAction(null)
    setBusy(true); setMsg('')
    // Read before the DELETE below, not after: a failed read reached after the delete would leave the
    // run rebuilt on empty YTD — or, if the insert then also failed, emptied outright.
    const inputs = await readInputs(p)
    if (inputs.error) { setMsg('error:The run was not recomputed — its payslips are unchanged. The data it is rebuilt from could not be read. ' + errorLine(inputs.error)); setBusy(false); return }
    let rows
    try { rows = buildPayrollRows({ runId, period: p, ...inputs.data }) } catch (e) {
      setMsg('error:The run was not recomputed — its payslips are unchanged. The payslips could not be calculated. ' + errorLine(e)); setBusy(false); return
    }
    // Delete-then-insert: once the delete has landed the run has NO payslips until the insert does,
    // so each half names the state it leaves behind (S682). A run finalized in another tab is refused
    // by the database (hr_run_finalized) — reload, so this tab stops offering a draft's buttons on it.
    const { error: delErr } = await scopedDelete('hr_payslips').eq('run_id', runId)
    if (delErr) { await loadAll(p); setMsg('error:The run was not recomputed — its payslips are unchanged. ' + errorLine(delErr)); setBusy(false); return }
    if (rows.length > 0) {
      const { error } = await scopedInsert('hr_payslips', rows.map(r => r.payslip))
      if (error) {
        await loadAll(p)
        setMsg(isRunFinalizedError(error)
          ? 'error:The run was finalized somewhere else while this was recomputing, so its payslips were not rebuilt. The page has been reloaded to show it. ' + errorLine(error)
          : 'error:The run\'s payslips were cleared but could not be rebuilt — press Regenerate again now. ' + errorLine(error))
        setBusy(false); return
      }
    }
    await loadAll(p)
    setMsg('ok:Recomputed from current data'); setBusy(false)
  }

  // One write path for a hand-typed income tax and for putting the calculated one back. Optimistic;
  // a refused write reloads so the controlled box shows what is stored, and the message names who.
  // A draft run with no payslips over a month nobody is on (S751 review) — everyone on it was settled,
  // or the only employee's dates moved out of the month. Regenerate builds nothing and Finalize refuses,
  // so the one move left is to remove the empty run.
  function requestDeleteEmptyRun() {
    if (!run || run.status !== 'draft' || busy) return
    askConfirm({
      title: 'Delete this empty draft run?',
      body: (
        <p style={{ margin: 0 }}>
          The {periodLabel} payroll run has no payslips, and nobody is on this month's payroll, so there is
          nothing for it to pay. Deleting it removes only the empty draft. If someone is added to {monthName} later,
          Generate Payroll makes a new run.
        </p>
      ),
      confirmLabel: 'Delete empty run', danger: true, busyLabel: 'Deleting…',
      run: deleteEmptyRun,
    })
  }

  async function deleteEmptyRun() {
    if (!run || !period) return
    const p = period
    const runId = run.id
    setBusy(true); setMsg('')
    // Re-checked, because deleting a run cascades to its payslips: a run another tab has just generated
    // payslips into must not be deleted from a screen that showed it empty.
    const { count, error: countErr } = await scopedFrom('hr_payslips', 'id', { count: 'exact', head: true }).eq('run_id', runId)
    if (countErr || count == null) { await loadAll(p); setMsg('error:The run was not deleted — could not confirm it still has no payslips. ' + errorLine(countErr)); setBusy(false); return }
    if (count > 0) { await loadAll(p); setMsg(`error:The run was not deleted — it has ${count} payslip${count === 1 ? '' : 's'} now (generated in another tab). The page has been reloaded.`); setBusy(false); return }
    const { data, error } = await scopedDelete('hr_payroll_runs').eq('id', runId).eq('status', 'draft').select('id')
    if (error) { await loadAll(p); setMsg('error:The run was not deleted. ' + errorLine(error)); setBusy(false); return }
    if (!data || data.length === 0) { await loadAll(p); setMsg('error:The run was not deleted — it is no longer a draft (finalized in another tab), or this account may not delete payroll runs. The page has been reloaded.'); setBusy(false); return }
    await loadAll(p)
    setMsg('ok:Empty draft run deleted'); setBusy(false)
  }

  async function writeTds(slip, tds, overridden, okText) {
    const who = nameOf(slip.employee_id)
    const beforeTds = num(slip.gross) + num(slip.ot_amount) - num(slip.absence_deduction) - num(slip.ssf_employee) - num(slip.other_deductions)
    const advance = num(slip.advance_deduction)
    // The advance cut on this payslip was sized against the CALCULATED tax, and it is a freshness
    // input, so a typed tax cannot resize it. A figure that would take take-home pay below zero is
    // refused instead — the same floor the engine keeps (decision 2).
    const room = Math.max(0, beforeTds - advance)
    if (tds > room + 0.5) {
      setMsg(`error:Income tax for ${who} was not changed — NPR ${fmt(tds)} is more than the pay left to take it from (NPR ${fmt(room)}), so take-home pay would go below zero.`)
      return
    }
    const net = beforeTds - advance - tds + num(slip.tada_amount)
    const p = period
    setPayslips(ps => ps.map(s => s.id === slip.id ? { ...s, tds, tds_overridden: overridden, net_pay: net } : s))
    // .select('id'): a write RLS refuses is 0 rows with no error, which used to read as saved.
    const { data, error } = await scopedUpdate('hr_payslips', { tds, tds_overridden: overridden, net_pay: net }).eq('id', slip.id).select('id')
    if (error || !data || data.length === 0) {
      await loadAll(p)
      setMsg(`error:Income tax for ${who} was not saved — the register shows what is stored. `
        + (error ? errorLine(error) : 'The payslip was not updated: the run may have been finalized in another tab, or this account may not change payroll.'))
      return
    }
    setMsg('ok:' + okText)
  }

  async function commitTds(slip, raw) {
    setTdsDraft(d => { const n = { ...d }; delete n[slip.id]; return n })
    if (!run || run.status !== 'draft' || busy) return
    const text = String(raw ?? '').trim()
    if (text === '') return   // an emptied box puts the stored figure back; type 0 to withhold nothing
    const tds = Number(text)
    const who = nameOf(slip.employee_id)
    if (!Number.isFinite(tds) || tds < 0) {
      setMsg(`error:Income tax for ${who} was not changed — "${text}" is not an amount. Type rupees, 0 or more.`)
      return
    }
    if (Math.abs(tds - num(slip.tds)) < 0.005) return   // unchanged — nothing to write
    await writeTds(slip, tds, true, `Income tax for ${who} set to NPR ${fmt(tds)} — kept as typed when you Finalize`)
  }

  async function resetTds(slip) {
    const live = liveByEmp.get(slip.employee_id)
    if (!live || busy) return
    const who = nameOf(slip.employee_id)
    await writeTds(slip, live.payslip.tds, false, `Income tax for ${who} put back to the calculated NPR ${fmt(live.payslip.tds)}`)
  }

  // Pending leave and overtime touching the month, for the Finalize confirm (decision 5). A failed
  // count says "could not check", never 0 — zero is the reassuring answer.
  async function loadPendingCounts(p) {
    const token = ++pendingReq.current
    setPending({ loading: true })
    const { start, end } = periodAdBounds(p)
    const [leave, ot] = await Promise.all([
      scopedFrom('hr_leave_requests', 'id', { count: 'exact', head: true })
        .eq('status', 'pending').lte('start_date', end).gte('end_date', start),
      scopedFrom('hr_overtime_entries', 'id', { count: 'exact', head: true })
        .eq('status', 'pending').eq('bs_year', p.bs_year).eq('bs_month', p.bs_month),
    ])
    if (token !== pendingReq.current) return
    const failed = !!(leave.error || ot.error || leave.count == null || ot.count == null)
    setPending({ loading: false, failed, leave: leave.count || 0, ot: ot.count || 0 })
  }

  // The ask half of Finalize. When the draft is not finalizable the refusal is stated at once;
  // otherwise the ConfirmModal opens with the consequence summary and its onConfirm calls finalize(),
  // which checks everything again against freshly read data before its first write.
  function requestFinalize() {
    if (!run || !period || busy || loading) return
    if (!freshness.ok) {
      const lines = [
        'Not finalized. ' + (freshness.reason || 'This draft no longer matches current salary, attendance, overtime and TADA data.'),
        freshness.stale.length ? `${freshness.stale.length} changed since Generate` : '',
        freshness.missing.length && payslips.length ? `${freshness.missing.length} with no payslip` : '',
        freshness.departed.length ? `${freshness.departed.length} who should not be paid by this run` : '',
        freshness.live && !freshness.empty ? 'Press Regenerate, then Finalize.' : '',
      ].filter(Boolean)
      setMsg('error:' + lines.join(' · '))
      return
    }
    setConfirmAction('finalize')
    loadPendingCounts(period)
  }

  async function finalize() {
    if (!run || !period) return
    const p = period
    const runId = run.id
    setConfirmAction(null)
    setBusy(true); setMsg('')
    const stop = async text => { await loadAll(p); setMsg('error:' + text); setBusy(false) }

    // Re-read EVERYTHING before the first write (S751). This used to finalize from data loaded when
    // the page opened: overtime approved, a claim approved or an employee settled in the meantime was
    // simply locked in wrong, and the freshness gate it relied on was computed from the same old copy.
    const [inputs, runRes, slipRes] = await Promise.all([
      readInputs(p),
      scopedFrom('hr_payroll_runs', 'id, status').eq('id', runId).maybeSingle(),
      scopedFrom('hr_payslips').eq('run_id', runId),
    ])
    const readErr = inputs.error || runRes.error || slipRes.error
    if (readErr) { await stop('Payroll was NOT finalized — nothing has changed. The latest salary, attendance, overtime, advance and TADA data could not be re-read, and a check that could not run has not passed. ' + errorText(readErr, 'operator')); return }
    if (!runRes.data) { await stop('Payroll was NOT finalized — this run no longer exists. The page has been reloaded.'); return }
    if (runRes.data.status !== 'draft') { await stop('Nothing was changed by this click — this run is already finalized, most likely in another tab. The page has been reloaded to show it.'); return }

    const fresh = inputs.data
    const slips = slipRes.data || []
    const freshNames = new Map([...fresh.employees, ...fresh.settled].map(e => [e.id, e.full_name]))
    const nameFresh = id => freshNames.get(id) || nameOf(id)
    const check = assessDraft(slips, () => buildPayrollRows({ runId, period: p, ...fresh }))
    if (!check.ok) {
      const parts = [
        check.stale.length ? `changed since Generate: ${listNames(check.stale, nameFresh)}` : '',
        check.missing.length && slips.length ? `no payslip: ${listNames(check.missing, nameFresh)}` : '',
        check.departed.length ? `should not be paid by this run: ${listNames(check.departed, nameFresh)}` : '',
      ].filter(Boolean)
      await stop('Payroll was NOT finalized — nothing has changed. '
        + (check.reason || 'Checked against current data just now, this draft is out of date.')
        + (parts.length ? ' ' + parts.join(' · ') + '.' : '')
        + (check.live && !check.empty ? ' Press Regenerate, then Finalize.' : ''))
      return
    }

    // The advance allocation runs over the FRESH ledgers, through the same dueAdvances() filter the
    // deduction came from. formatAd over Nepal's civil date: the UTC slice is YESTERDAY between 00:00
    // and 05:45 Nepal time, and a viewer abroad would stamp their own calendar's day.
    const { repayRows } = allocateAdvanceRepayments({
      payslips: slips, advances: fresh.advances, repayments: fresh.repayments, period: p, runId,
      repaidDate: formatAd(nepalCivilDate(new Date()) || new Date()),
      note: `${BS_MONTHS[p.bs_month - 1]} ${p.bs_year} payroll`,
    })

    // ONE transaction since S753 (finalize_payroll_run). It was five browser writes — flip the run,
    // mark TADA paid, delete and re-insert repayments, settle advances — with a payslip RECOUNT after
    // the flip standing in for "nobody regenerated in between". The function takes the payroll lock,
    // refuses unless the stored payslips are exactly the ids checked above, re-checks the repayments
    // add up to each payslip's advance cut, and writes every ledger or none. The advance allocation
    // stays here: the JS engine owns that arithmetic, and the function validates it.
    const { data: result, error: finErr } = await supabase.rpc('finalize_payroll_run', {
      p_run_id: runId,
      p_payslip_ids: slips.map(s => s.id),
      p_repayments: repayRows.map(r => ({
        advance_id: r.advance_id, employee_id: r.employee_id, amount: r.amount,
        repaid_date: r.repaid_date, notes: r.notes,
      })),
    })
    if (finErr) { await stop('Payroll was NOT finalized — nothing has changed. ' + errorText(finErr, 'operator')); return }

    await loadAll(p)
    const n = result?.repayments || 0
    const t = result?.tada_claims || 0
    setMsg('ok:Finalized' + (n > 0 ? ` — ${n} advance repayment(s) recorded` : '') + (t > 0 ? ` — ${t} TADA claim(s) marked Paid` : ''))
    setBusy(false)
  }

  async function reopen() {
    if (!run || !period) return
    const p = period
    const runId = run.id
    setConfirmAction(null)
    setBusy(true); setMsg('')

    // ONE transaction since S753 (reopen_payroll_run): the repayments this run wrote are deleted (the
    // status trigger reactivates anything that owes again), the TADA claims IT marked Paid go back to
    // Approved, and the run returns to draft — all or nothing, under the payroll lock. It used to be
    // five browser writes, each able to stop half-way with its own recovery message.
    const { data: result, error: reErr } = await supabase.rpc('reopen_payroll_run', { p_run_id: runId })
    await loadAll(p)
    if (reErr) { setMsg('error:Nothing was changed — the run was not reopened. ' + errorText(reErr, 'operator')); setBusy(false); return }
    const notes = []
    if (result?.written_off) {
      notes.push(`${result.written_off} ${result.written_off.includes(',') ? 'have advances' : 'has an advance'} that ${result.written_off.includes(',') ? 'are' : 'is'} written off — the write-off does not change, so check Advances & Loans.`)
    }
    if ((result?.tada_claims || 0) > (result?.tada_reverted || 0)) {
      const left = result.tada_claims - result.tada_reverted
      notes.push(`Only ${result.tada_reverted} of the ${result.tada_claims} TADA claims this run paid went back to Approved — the other ${left} ${left === 1 ? 'is' : 'are'} no longer marked paid by payroll (changed in TADA Claims). Check TADA Claims before regenerating, or a claim may be paid twice or not at all.`)
    }
    setMsg(notes.length > 0 ? 'error:Reopened — but: ' + notes.join(' ') : 'ok:Reopened'); setBusy(false)
  }

  const periodLabel = period ? `${BS_MONTHS[period.bs_month - 1]} ${period.bs_year}` : '—'
  const monthName = period ? BS_MONTHS[period.bs_month - 1] : 'this month'
  const finalized = run?.status === 'finalized'

  // Who has been paid (S782). One summary from the page's own payslips and payments, so the Paid
  // column, "Mark everyone paid", the status strip and the Reopen warning cannot disagree.
  const paySummary = useMemo(() => runPaymentSummary(payslips, payments), [payslips, payments])
  const activePayments = payments.filter(p => !p.voided_at)
  // Shown on a finalized run, and on a reopened draft that already has payments — whoever is fixing
  // the month needs to see who already has their money.
  const showPaid = !!run && (finalized || payments.length > 0)
  const canMarkPaid = finalized && !paymentsError

  function openMarkPaid(employeeIds) {
    const people = employeeIds
      .map(id => ({ employee_id: id, name: nameOf(id), due: paySummary.byEmployee.get(id)?.due || 0 }))
      .filter(p => p.due > 0)
    if (people.length > 0) { setMsg(''); setMarkPaid(people) }
  }

  async function afterPaymentChange(text) {
    setMarkPaid(null); setUndoPay(null)
    if (period) await loadAll(period)
    setMsg('ok:' + text)
  }

  // The Paid cell. A mark and words for every state, never colour alone; amber only where someone
  // must act (a difference still owed, or an overpayment after a Reopen).
  function renderPaidCell(s, emp) {
    if (paymentsError) {
      return (
        <Tip text="The salary payments for this month could not be read, so whether this person has been paid is unknown. Reload the page before marking anyone paid." width={260}>
          <span style={{ fontSize: 12, color: 'var(--theme-text2)', whiteSpace: 'nowrap' }}>not checked</span>
        </Tip>
      )
    }
    const st = paySummary.byEmployee.get(s.employee_id)
    if (!st || st.state === 'none') return <span style={{ color: 'var(--theme-text2)' }}>—</span>
    const undoItems = st.active.map(p => ({
      key: p.id,
      label: `Undo NPR ${fmt(p.amount)} paid ${formatAdAsBs(p.paid_on)}…`,
      onSelect: () => { setMsg(''); setUndoPay({ payment: p, name: emp.full_name }) },
      danger: true,
    }))
    const last = st.last
    const payBtn = label => canMarkPaid && (
      <button className="btn btn-ghost btn-sm" onClick={() => openMarkPaid([s.employee_id])} disabled={busy}
        aria-label={`${label} — ${emp.full_name}`}>{label}</button>
    )
    let body
    if (st.state === 'paid') {
      body = (
        <Tip text={`NPR ${fmt(st.paid)} recorded as paid${st.active.length > 1 ? ` in ${st.active.length} payments` : ''}, last on ${formatAdAsBs(last.paid_on)} by ${methodLabel(last.method).toLowerCase()}${last.reference ? ` (ref. ${last.reference})` : ''}.`} width={260}>
          <span style={{ fontSize: 12, color: 'var(--theme-text1)', whiteSpace: 'nowrap' }}>
            <span aria-hidden="true" style={{ color: 'var(--theme-green-text)' }}>✓</span> {formatAdAsBs(last.paid_on)} · {methodLabel(last.method)}
          </span>
        </Tip>
      )
    } else if (st.state === 'unpaid') {
      body = payBtn('Mark paid') || <span style={{ fontSize: 12, color: 'var(--theme-text2)', whiteSpace: 'nowrap' }}>Not paid</span>
    } else if (st.state === 'short') {
      body = (
        <>
          <Tip text={`NPR ${fmt(st.paid)} was recorded as paid, but this payslip now comes to NPR ${fmt(st.net)} — the month was reopened and its figures changed. NPR ${fmt(st.due)} is still owed.`} width={270}>
            <span style={{ fontSize: 12, color: 'var(--theme-amber-text)', whiteSpace: 'nowrap' }}>△ NPR {fmt(st.due)} still to pay</span>
          </Tip>
          {payBtn('Pay difference')}
        </>
      )
    } else {
      // No payslip at all (S788): the month was reopened and Regenerate left this person out after
      // they had been paid, so the whole amount stands against nothing.
      const gone = paySummary.noPayslip.includes(s.employee_id)
      body = (
        <Tip text={gone
          ? `NPR ${fmt(st.paid)} was recorded as paid, but this person no longer has a payslip in ${monthName} — the month was reopened and Regenerate left them out. The whole amount was paid too much; recover it by hand, or undo a payment that was recorded by mistake.`
          : `NPR ${fmt(st.paid)} was recorded as paid, but this payslip now comes to NPR ${fmt(st.net)} — the month was reopened and its figures went down. NPR ${fmt(-st.due)} was paid too much; recover it by hand or from next month's pay, or undo a payment that was recorded by mistake.`} width={290}>
          <span style={{ fontSize: 12, color: 'var(--theme-amber-text)', whiteSpace: 'nowrap' }}>△ Overpaid NPR {fmt(-st.due)}</span>
        </Tip>
      )
    }
    return (
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', justifyContent: 'flex-end' }}>
        {body}
        {undoItems.length > 0 && <RowMenu label={`More for ${emp.full_name}'s payment`} items={undoItems} disabled={busy} />}
      </div>
    )
  }

  // A row's working. A finalized month is explained as it was PAID and never recomputed (decision 12,
  // S751); a draft is the live working from the same buildPayrollRows() the register was generated
  // from — and when this payslip has drifted from it, the panel says so first, naming what moved,
  // because the figures below it are then not the ones in the row above.
  function renderWorking(s) {
    if (finalized) return <StoredDetail slip={s} intro={FINALIZED_INTRO} />
    const live = liveByEmp.get(s.employee_id)
    if (!live) return <StoredDetail slip={s} intro={orphanIntro(settled.some(e => e.id === s.employee_id))} />
    const moved = payslipDrift(s, live.payslip) === 'moved' ? driftParts(s, live.payslip) : []
    return (
      <>
        {moved.length > 0 && (
          <div role="note" style={{ padding: '10px 22px 0', background: 'var(--theme-bg)', fontSize: 12, lineHeight: 1.6, color: 'var(--theme-amber-text)' }}>
            △ This payslip is out of date — the working below is from current data, not the stored figures in the row above.
            Changed since Generate: {moved.join('; ')}. Regenerate to update it.
          </div>
        )}
        <CalcDetail row={{ ...live.detail, slip: live.payslip }} monthDays={period ? daysInBsMonth(period.bs_year, period.bs_month) : 0} advances={dueNow} ytd={ytdMap[s.employee_id]} />
      </>
    )
  }

  function printWorking(slip, emp) {
    setPrintCalc({ slip, emp })
    setTimeout(() => { printWithTitle(`Payroll Calculation - ${emp.full_name} - ${periodLabel}${finalized ? '' : ' (DRAFT)'}`); setPrintCalc(null) }, 60)
  }

  function printPayslip(slip, emp) {
    setPrintSlip({ slip, emp })
    setTimeout(() => { printWithTitle(`Payslip - ${emp.full_name} - ${periodLabel}${finalized ? '' : ' (DRAFT)'}`); setPrintSlip(null) }, 60)
  }

  // The Owner signs what this prints, so a draft Finalize would refuse is not printed: the signature
  // would approve figures that are about to change. A finalized month always prints, as paid.
  function printApprovalSheet() {
    if (!run || busy || loading || payslips.length === 0) return
    if (!finalized && !freshness.ok) {
      setMsg('error:The approval sheet was not printed — this draft cannot be finalized as it stands, so the Owner would be signing figures that are about to change. '
        + (freshness.reason || 'Press Regenerate, then print it.'))
      return
    }
    setPrintApproval(true)
    setTimeout(() => { printWithTitle(`Payroll Approval - ${periodLabel}${finalized ? '' : ' (DRAFT)'}`); setPrintApproval(false) }, 60)
  }

  async function exportExcel() {
    const XLSX = await import('xlsx')
    const status = finalized ? 'Finalized' : 'Draft'
    const rows = payslips.map(s => {
      const emp = empMap[s.employee_id] || {}
      return {
        'Employee': emp.full_name || nameOf(s.employee_id), 'Code': emp.employee_code || '', 'Department': emp.department || '',
        'Status': status, 'Pay Basis': s.pay_basis,
        'Basic/Rate': s.basic, 'Allowances': s.allowances, 'Gross': s.gross,
        'Present Days': s.present_days, 'Absent Days': s.absent_days,
        'Unpaid Days': s.unpaid_days ?? '', 'Worked Days': s.worked_days ?? '', 'Hours Worked': s.hours_worked ?? '',
        'OT Hours': s.ot_hours, 'OT Amount': s.ot_amount,
        'Absence Ded': s.absence_deduction, 'SSF Employee': s.ssf_employee,
        'Other Ded': s.other_deductions, 'Retirement (CIT)': s.retirement_contribution || 0,
        'Advance Ded': s.advance_deduction || 0,
        'TDS': s.tds, 'TADA': s.tada_amount || 0, 'Net Pay': s.net_pay,
        'SSF Employer': s.ssf_employer,
        // What was recorded as paid (S782) — blank when payments could not be read, never 0.
        ...(showPaid && !paymentsError ? (() => {
          const st = paySummary.byEmployee.get(s.employee_id)
          return {
            'Paid (NPR)': st ? st.paid : 0,
            'Paid On (BS)': st?.last ? formatAdAsBs(st.last.paid_on) : '',
            'Paid By': st?.last ? methodLabel(st.last.method) : '',
          }
        })() : {}),
      }
    })
    const ws = XLSX.utils.json_to_sheet(rows)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, finalized ? 'Payroll' : 'Payroll DRAFT')
    const label = period ? `${BS_MONTHS[period.bs_month - 1]}-${period.bs_year}` : ''
    XLSX.writeFile(wb, `payroll_${label}${finalized ? '' : '_DRAFT'}.xlsx`)
  }

  const totals = payslips.reduce((a, s) => {
    a.gross   += num(s.gross); a.ot += num(s.ot_amount)
    a.absence += num(s.absence_deduction); a.ssfEmp += num(s.ssf_employee); a.other += num(s.other_deductions)
    a.advDed  += num(s.advance_deduction); a.tds += num(s.tds); a.tada += num(s.tada_amount)
    a.net     += num(s.net_pay); a.ssfEmpr += num(s.ssf_employer)
    return a
  }, { gross: 0, ot: 0, absence: 0, ssfEmp: 0, other: 0, advDed: 0, tds: 0, tada: 0, net: 0, ssfEmpr: 0 })
  const totalDeductions = totals.absence + totals.ssfEmp + totals.other + totals.advDed + totals.tds
  const cost = payrollCashCost(payslips)

  if (!hasHrAccess('manager')) return <Navigate to="/dashboard" replace />

  const showActions = run && !loading && !loadError
  // A deduction is a correct figure, not a problem, so it is printed in the ink every other figure
  // uses and the − sign carries the direction (S768). Red here spent the product's "something is
  // wrong" colour up to five times per row, and the one real warning on the page — ⚠ SSF no.
  // missing, in the name cell — was lost among them. Colour on this register is for flags only.
  const moneyCell = (v, sign) => <td style={{ textAlign: 'right', color: v > 0 ? 'var(--theme-text1)' : 'var(--theme-text2)' }}>{v > 0 ? `${sign}${fmt(v)}` : '—'}</td>
  const negCell = v => moneyCell(v, '−')

  return (
    <div>
      <div className={printSlip || printCalc || printApproval ? 'no-print' : ''}>
        <div className="page-header page-header--split">
          <div>
            <h1 className="page-title">Payroll</h1>
            <p className="page-subtitle">
              Monthly payroll run — {periodLabel}
              {run && !loading && <RunStatusBadge finalized={finalized} />}
            </p>
          </div>
          <div style={{ display: 'flex', gap: 20, alignItems: 'center', flexWrap: 'wrap' }}>
            <select aria-label="Period" className="form-select" value={period?.id || ''} onChange={e => handlePeriodChange(e.target.value)} disabled={loading}>
              {periods.map(p => <option key={p.id} value={p.id}>{BS_MONTHS[p.bs_month - 1]} {p.bs_year} {p.status === 'open' ? '(open)' : ''}</option>)}
            </select>
            {/* Hidden while loading and after a failed read (S751): a click then would act on a run and
                payslips the page could not show — the old outlet's, after a client switch. */}
            {showActions && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button className="btn btn-ghost" onClick={exportExcel} disabled={busy}>⬇ Export</button>
                {payslips.length > 0 && (
                  <Tip text={`The ${periodLabel} payroll on one sheet — totals, each employee's pay, anything to check, and signature lines — for the Owner to approve. Print it, or choose Save as PDF in the print dialog. A draft prints marked DRAFT; a draft that is out of date must be regenerated first.`} width={300}>
                    <button className="btn btn-ghost" onClick={printApprovalSheet} disabled={busy} aria-disabled={!finalized && !freshness.ok}>🖨 Approval PDF</button>
                  </Tip>
                )}
                {!finalized && !freshness.empty && <button className="btn btn-ghost" onClick={() => setConfirmAction('regenerate')} disabled={busy}>↻ Regenerate</button>}
                {!finalized && !freshness.empty && <button className="btn btn-primary" onClick={requestFinalize} disabled={busy}>Finalize</button>}
                {/* hasHrAccess('manager'), not isAdmin: `isAdmin` is the Crest platform OPERATOR, while
                    the tenant's own Owner is `isOwner`; both resolve hrRole to 'manager' (S620). */}
                {finalized && hasHrAccess('manager') && <button className="btn btn-ghost" onClick={() => setConfirmAction('reopen')} disabled={busy}>Reopen</button>}
              </div>
            )}
            {msg && <span role={msg.startsWith('ok') ? 'status' : 'alert'} style={{ fontSize: 12, color: msg.startsWith('ok') ? 'var(--theme-green-text)' : 'var(--theme-red-text)', marginLeft: 'auto' }}>{msg.split(':').slice(1).join(':')}</span>}
          </div>
        </div>

        {!loading && !loadError && period && (
          <PayrollMonthStatus
            period={period} employees={employees} attendance={attendance} run={run} payslips={payslips}
            payments={payments} paymentsError={paymentsError}
            runStale={!!run && !finalized && !freshness.ok} onPayrollPage
            refreshKey={`${run?.id || ''}:${run?.status || ''}:${payslips.length}:${attendance.length}`}
          />
        )}

        {/* After Finalize the month is not done — it has to be paid and filed. These are the three
            documents that do that, opened on this month (S768); the success message used to be a
            12px span and nothing said where to go next. */}
        {!loading && !loadError && period && finalized && (
          <div className="card" role="note" style={{ marginBottom: 12, padding: '10px 16px', display: 'flex', gap: '6px 18px', flexWrap: 'wrap', alignItems: 'center', fontSize: 13 }}>
            <strong style={{ color: 'var(--theme-text1)' }}>Next for {monthName}:</strong>
            <Link className="month-status__link" to={`/hr/reports?tab=bank&period=${period.id}`}>Pay staff — bank transfer sheet</Link>
            {/* Then record it (S782). Finalize pays nobody; this is the record that the money went out. */}
            {paymentsError ? (
              <span style={{ color: 'var(--theme-amber-text)' }}>△ Salary payments could not be read — reload before marking anyone paid.</span>
            ) : paySummary.toPay.length > 0 ? (
              <Tip text={`Records that the salaries were paid, with the date and how (bank, cash, eSewa/Khalti or cheque). It does not send any money — pay first, then record it. Staff see the date in the Crest Staff app. ${paySummary.paid} of ${paySummary.owed} marked paid so far.`} width={300}>
                <button className="btn btn-ghost btn-sm" onClick={() => openMarkPaid(paySummary.toPay)} disabled={busy}>
                  {paySummary.toPay.length === paySummary.owed ? 'Mark everyone paid…' : `Mark the other ${paySummary.toPay.length} paid…`}
                </button>
              </Tip>
            ) : paySummary.owed > 0 && (
              <span style={{ color: 'var(--theme-text1)' }}><span aria-hidden="true" style={{ color: 'var(--theme-green-text)' }}>✓</span> All {paySummary.owed} marked paid</span>
            )}
            <Link className="month-status__link" to={`/hr/reports?tab=ssf&period=${period.id}`}>Deposit SSF — challan</Link>
            <Link className="month-status__link" to={`/hr/reports?tab=tds&period=${period.id}`}>Deposit income tax — TDS report</Link>
            <span style={{ color: 'var(--theme-text2)' }}>Staff see their own payslips in the Crest Staff app.</span>
          </div>
        )}

        {/* Stale-draft warning. Finalize refuses while this is showing, but the refusal alone would
            only be discovered at the moment of committing — this states the problem, names who it
            affects and points at the one-click fix beforehand. */}
        {!loading && !loadError && run && !finalized && !freshness.ok && (
          <div
            role="alert"
            className="card"
            style={{
              marginBottom: 12, padding: '12px 16px',
              borderColor: 'color-mix(in srgb, var(--theme-amber) 35%, transparent)',
              background: 'color-mix(in srgb, var(--theme-amber) 8%, transparent)',
            }}
          >
            <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: 'var(--theme-amber-text)' }}>
              {freshness.empty
                ? `⚠ Nobody is on the ${monthName} payroll`
                : freshness.live ? '⚠ This draft is out of date — Regenerate before finalizing' : '⚠ This draft could not be checked, so it cannot be finalized'}
            </p>
            <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--theme-text2)' }}>
              {freshness.reason && <>{freshness.reason}{' '}</>}
              {freshness.stale.length > 0 && (
                <>Attendance, overtime, pay setup, advances or TADA changed since this run was generated, so{' '}
                  <strong style={{ color: 'var(--theme-text1)' }}>{freshness.stale.length}</strong>{' '}
                  employee{freshness.stale.length === 1 ? "'s figures no longer match" : "s' figures no longer match"}
                  {' '}({listNames(freshness.stale, nameOf)}).{' '}
                </>
              )}
              {freshness.missing.length > 0 && payslips.length > 0 && (
                <><strong style={{ color: 'var(--theme-text1)' }}>{freshness.missing.length}</strong>{' '}
                  employee{freshness.missing.length === 1 ? ' is' : 's are'} on the {monthName} payroll with no payslip in this run
                  {' '}({listNames(freshness.missing, nameOf)}).{' '}
                </>
              )}
              {freshness.departed.length > 0 && (
                <><strong style={{ color: 'var(--theme-text1)' }}>{freshness.departed.length}</strong>{' '}
                  payslip{freshness.departed.length === 1 ? ' here belongs to someone who' : 's here belong to people who'} should not be paid by this run
                  {' '}({listNames(freshness.departed, nameOf)}) — already paid by a Final Settlement, or not employed in {monthName}. Regenerate removes {freshness.departed.length === 1 ? 'it' : 'them'}.{' '}
                </>
              )}
              {freshness.live && !freshness.empty && 'Regenerate rebuilds the draft from current data; income tax typed by hand is reset.'}
            </p>
            {freshness.empty && (
              <button className="btn btn-danger btn-sm" style={{ marginTop: 8 }} onClick={requestDeleteEmptyRun} disabled={busy}>
                Delete this empty draft run
              </button>
            )}
          </div>
        )}

        {/* Leavers whose Final Settlement already paid this month are left out on purpose (decision 4).
            Neutral, not a warning — nothing is wrong — but named, so a missing waiter reads as a decision. */}
        {!loading && !loadError && period && !finalized && settled.length > 0 && (
          <div className="card" role="note" style={{ marginBottom: 12, padding: '10px 16px', fontSize: 12, color: 'var(--theme-text2)' }}>
            <Tip text="A finalized Final Settlement pays the last month's salary itself, so a payslip here as well would pay those days twice. Reopening the settlement brings them back onto this payroll." width={290}>
              <strong style={{ color: 'var(--theme-text1)' }}>Left out — already paid by Final Settlement:</strong>
            </Tip>{' '}
            {settled.map(e => e.full_name).join(', ')}
          </div>
        )}

        {loading ? (
          <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text2)' }}>Loading…</div>
        ) : loadError ? (
          // Before every empty state, deliberately: a failed read leaves the lists empty, and this page
          // used to answer that by telling an owner to go and add the employees they already have.
          <ReportLoadError error={loadError} />
        ) : !period ? (
          <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text2)' }}>
            {/* Only Crest creates a month from nothing (Periods' '+ New Period' is admin-only), so a
                client is told who opens it rather than sent to a page where they cannot (S790). */}
            {isAdmin
              ? 'No months yet. Create a period in Periods first — payroll runs one month at a time.'
              : 'No month is open yet — payroll runs one month at a time. Crest opens your first month for you, so contact Crest support if it is missing.'}
          </div>
        ) : !run ? (
          employees.length === 0 ? (
            <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text2)' }}>
              Nobody is on the payroll for {periodLabel}. It covers active and probation staff, and anyone whose last working day falls in or after this month. Add employees in HR → Employees.
            </div>
          ) : (
            <div className="card" style={{ padding: 40, textAlign: 'center' }}>
              <div aria-hidden="true" style={{ fontSize: 24, marginBottom: 12 }}>💵</div>
              <div style={{ fontSize: 14, color: 'var(--theme-text1)', marginBottom: 6 }}>No payroll run for {periodLabel} yet</div>
              <div style={{ fontSize: 12, color: 'var(--theme-text2)', marginBottom: 18 }}>Generates a draft for {employees.length} employee{employees.length === 1 ? '' : 's'} from each one's salary structure and {periodLabel} attendance. You can review it before finalizing.</div>
              <button className="btn btn-primary" onClick={generate} disabled={busy}>{busy ? 'Generating…' : 'Generate Payroll'}</button>
            </div>
          )
        ) : (
          <>
            {/* Stat cards */}
            <div className="stat-grid">
              {[
                { label: 'Total Gross',  value: totals.gross, color: 'var(--theme-text1)', tip: 'Sum of gross earnings (basic + allowances, or earned wage) across all payslips.' },
                { label: 'Deductions',   value: totalDeductions, color: 'var(--theme-text1)', tip: 'Everything taken off pay: unpaid days, SSF (11%), other deductions such as CIT, advance recovery, and income tax (TDS).' },
                {
                  label: 'Net Payable', value: totals.net, color: 'var(--theme-text1)', tip: 'Total take-home pay to disburse this period, TADA reimbursements included.',
                  sub: finalized && !paymentsError && paySummary.owed > 0
                    ? `${payslips.length} payslip${payslips.length === 1 ? '' : 's'} · ${paySummary.paid} of ${paySummary.owed} marked paid`
                    : undefined,
                },
                { label: 'Employer SSF', value: totals.ssfEmpr, color: 'var(--theme-text2)', tip: '20% SSF the company pays on top — not part of net payable.' },
                {
                  label: 'Cost to Business', value: cost.total, color: 'var(--theme-text1)',
                  tip: 'What this month\'s payroll costs the business: pay earned (gross, less unpaid days, plus overtime) plus the employer\'s 20% SSF. It is more than Net Payable because the employee SSF, CIT and income tax withheld are still paid by the business — to the SSF fund and the tax office instead of to staff. Travel claims are reimbursements, not pay, and are shown underneath.',
                  sub: `NPR ${fmt(cost.earned)} pay + NPR ${fmt(cost.employerSsf)} employer SSF${cost.tada > 0 ? ` · plus NPR ${fmt(cost.tada)} travel claims` : ''}`,
                },
              ].map(s => (
                <div key={s.label} className="card" style={{ padding: '16px 18px' }}>
                  <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    <Tip text={s.tip} width={260}>{s.label}</Tip>
                  </div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: s.color }}>NPR {fmt(s.value)}</div>
                  <div style={{ fontSize: 10, color: 'var(--theme-text2)', marginTop: 3 }}>{s.sub || `${payslips.length} payslip${payslips.length === 1 ? '' : 's'}`}</div>
                </div>
              ))}
            </div>

            {/* Register */}
            <div className="card" style={{ padding: 0 }}>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th style={{ width: 36 }}><span className="sr-only">Working</span></th>
                      <th>Employee</th>
                      <th style={{ textAlign: 'right' }}><Tip text="Gross earnings: basic + allowances (monthly) or earned wage (daily/hourly)." width={250}>Gross</Tip></th>
                      <th style={{ textAlign: 'right' }}><Tip text="Overtime pay: 1.5× the hourly rate on ordinary days, 2× on public holidays (the holiday rate comes from approved Overtime entries)." width={260}>OT</Tip></th>
                      <th style={{ textAlign: 'right' }}><Tip text="Pay deducted for unpaid days — absences, unpaid leave, and half-days (gross ÷ days in month × unpaid days, allowances included)." width={270}>Absence</Tip></th>
                      <th style={{ textAlign: 'right' }}><Tip text="11% SSF — only for employees with an SSF number on file." width={230}>SSF</Tip></th>
                      <th style={{ textAlign: 'right' }}><Tip text="All configured deductions except SSF — CIT/PF, etc. Never more than the month earned: someone who joined on the 28th has it cut to what they were paid." width={270}>Other Ded</Tip></th>
                      <th style={{ textAlign: 'right' }}><Tip text="Advance or loan instalment recovered this month from Advances & Loans. Recovery starts with the payroll of the month after an advance was issued, and never takes pay below zero — whatever this month cannot cover stays owed. Repayment rows are written on Finalize." width={300}>Advance</Tip></th>
                      <th style={{ textAlign: 'right' }}><Tip text="Income tax, worked out from the fiscal-year tax slabs. You can type over it while this is a draft — a typed figure is kept when you Finalize, and ↺ puts back the calculated one." width={280}>TDS</Tip></th>
                      <th style={{ textAlign: 'right' }}><Tip text="Travel/Daily Allowance reimbursement — the total of approved claims whose trip was over by the end of the month. Added after income tax and not taxed. To change it, change the claim in TADA Claims." width={290}>TADA</Tip></th>
                      <th style={{ textAlign: 'right' }}>Net Pay</th>
                      {showPaid && (
                        <th style={{ textAlign: 'right' }}>
                          <Tip text="Whether this salary has been paid out, and when. Finalizing pays nobody — Mark paid records the date and how it was paid, and staff see it in the Crest Staff app. If the month is reopened and a figure changes, this shows what is still owed or what was paid too much." width={290}>Paid</Tip>
                        </th>
                      )}
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {payslips.map(s => {
                      const emp = empMap[s.employee_id] || { id: s.employee_id, full_name: nameOf(s.employee_id) }
                      const isMonthly = s.pay_basis === 'monthly'
                      const advDed = num(s.advance_deduction)
                      const tada = num(s.tada_amount)
                      const claimCount = Array.isArray(s.tada_claim_ids) ? s.tada_claim_ids.length : 0
                      const live = liveByEmp.get(s.employee_id)
                      // Approved overtime and the attendance sheet's OT column on the SAME day — the
                      // approved entry supersedes, so nothing is paid twice, but the difference needs
                      // explaining. Read from the engine's own breakdown (S751) rather than re-scanning
                      // the whole attendance array per row per render, which also flagged any employee
                      // with OT in both places on DIFFERENT days, where nothing was superseded at all.
                      const supersededHrs = num(live?.detail?.breakdown?.otSupersededHrs)
                      const open = expandedId === s.id
                      return (
                        <Fragment key={s.id}>
                        <tr>
                          <td style={{ textAlign: 'center' }}>
                            <RowDisclosure expanded={open} onToggle={() => setExpandedId(open ? null : s.id)}
                              label={`${open ? 'Hide' : 'Show'} how ${emp.full_name}'s pay was worked out`} controls={`working-${s.id}`} />
                          </td>
                          <td>
                            <div style={{ fontWeight: 600, color: 'var(--theme-text1)', fontSize: 13 }}>{emp.full_name}</div>
                            <div style={{ display: 'flex', gap: 6, marginTop: 2, alignItems: 'center', flexWrap: 'wrap' }}>
                              {emp.employee_code && <span style={{ fontSize: 10, color: 'var(--theme-text2)' }}>{emp.employee_code}</span>}
                              {!isMonthly && <span className="badge badge-gray" style={{ fontSize: 10, fontWeight: 700 }}>{s.pay_basis}</span>}
                              {'ssf_enrolled' in emp && !emp.ssf_enrolled && <span style={{ fontSize: 10, color: 'var(--theme-text2)' }}>no SSF</span>}
                              {/* Enrolled but no registration number: SSF is deliberately NOT deducted
                                  (it would never reach the challan), and this is the only place that
                                  otherwise looks identical to a correctly-contributing employee. */}
                              {emp.ssf_enrolled && !String(emp.ssf_no || '').trim() && (
                                <Tip text="This employee is marked SSF-enrolled but has no SSF registration number, so no 11% contribution is being deducted — a contribution with no number can't be filed on the SSF challan. Add the number in Pay Setup, then Regenerate." width={290}>
                                  <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--theme-amber-text)', background: 'color-mix(in srgb, var(--theme-amber) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-amber) 30%, transparent)', borderRadius: 0, padding: '1px 6px', cursor: 'help' }}>⚠ SSF no. missing</span>
                                </Tip>
                              )}
                              {supersededHrs > 0 && (
                                <Tip text={`This employee has OT in both places on the same day. ${supersededHrs.toFixed(1)} hr typed on the attendance sheet was replaced by an approved Overtime entry for that day and is not paid, so nothing is paid twice. Payroll Calculation shows the split.`} width={300}>
                                  <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--theme-text2)', background: 'color-mix(in srgb, var(--theme-text2) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-text2) 25%, transparent)', borderRadius: 0, padding: '1px 6px', cursor: 'help' }}>OT: 2 sources</span>
                                </Tip>
                              )}
                            </div>
                          </td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-text1)' }}>{fmt(s.gross)}</td>
                          {moneyCell(num(s.ot_amount), '+')}
                          {negCell(num(s.absence_deduction))}
                          {negCell(num(s.ssf_employee))}
                          {negCell(num(s.other_deductions))}
                          {negCell(advDed)}
                          <td style={{ textAlign: 'right' }}>
                            {finalized ? (
                              <span style={{ color: s.tds > 0 ? 'var(--theme-text1)' : 'var(--theme-text2)' }}>{s.tds > 0 ? `−${fmt(s.tds)}` : '—'}</span>
                            ) : (
                              <div style={{ display: 'flex', gap: 4, alignItems: 'center', justifyContent: 'flex-end' }}>
                                {s.tds_overridden && live && (
                                  <Tip text={`Typed by hand. The calculated figure from current data is NPR ${fmt(live.payslip.tds)} — press ↺ to put it back.`} width={260}>
                                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => resetTds(s)} disabled={busy}
                                      aria-label={`Put income tax for ${emp.full_name} back to the calculated NPR ${fmt(live.payslip.tds)}`}
                                      style={{ padding: '0 6px' }}>↺</button>
                                  </Tip>
                                )}
                                <input
                                  type="number" min="0" step="any" inputMode="decimal"
                                  className="form-input form-input--auto"
                                  value={tdsDraft[s.id] ?? String(s.tds ?? 0)}
                                  onChange={e => { const v = e.target.value; setTdsDraft(d => ({ ...d, [s.id]: v })) }}
                                  onBlur={e => commitTds(s, e.target.value)}
                                  onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
                                  disabled={busy}
                                  aria-label={`Income tax (TDS) for ${emp.full_name}`}
                                  style={{ width: 84, textAlign: 'right', padding: '6px 8px', fontSize: 13 }}
                                />
                              </div>
                            )}
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            {/* Read-only (decision 6): TADA always equals its approved claims' total. It
                                used to be a free-typed box, and a typed amount paid a figure no claim
                                backed while Finalize still marked the claims Paid. */}
                            <div style={{ display: 'flex', gap: 4, alignItems: 'center', justifyContent: 'flex-end' }}>
                              {claimCount > 0 && (
                                <Tip text={finalized
                                  ? `Paid from ${claimCount} approved TADA claim${claimCount === 1 ? '' : 's'} — marked Paid in TADA Claims when this run was finalized.`
                                  : `The total of ${claimCount} approved TADA claim${claimCount === 1 ? '' : 's'} whose trip was over by the end of ${monthName}. Finalizing marks ${claimCount === 1 ? 'it' : 'them'} Paid. To change the amount, change the claim in TADA Claims, then Regenerate.`} width={290}>
                                  <span style={{ fontSize: 10, cursor: 'help' }}>🔗</span>
                                </Tip>
                              )}
                              <span style={{ color: tada > 0 ? 'var(--theme-text1)' : 'var(--theme-text2)' }}>{tada > 0 ? `+${fmt(tada)}` : '—'}</span>
                            </div>
                          </td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-text1)', fontWeight: 700, fontSize: 14 }}>{fmt(s.net_pay)}</td>
                          {showPaid && <td style={{ textAlign: 'right' }}>{renderPaidCell(s, emp)}</td>}
                          <td style={{ textAlign: 'right' }}>
                            <button className="btn btn-ghost btn-sm" onClick={() => setViewSlip({ slip: s, emp })} aria-label={`Payslip for ${emp.full_name}`}>Payslip</button>
                          </td>
                        </tr>
                        {open && (
                          <tr>
                            <td colSpan={showPaid ? 13 : 12} style={{ padding: 0 }}>
                              <div id={`working-${s.id}`} style={{ borderTop: '1px solid var(--theme-border)' }}>
                                <div style={{ padding: '10px 22px 0', background: 'var(--theme-bg)', display: 'flex', justifyContent: 'flex-end' }}>
                                  <button className="btn btn-ghost btn-sm" onClick={() => printWorking(s, emp)}>🖨 Print working</button>
                                </div>
                                {renderWorking(s)}
                              </div>
                            </td>
                          </tr>
                        )}
                        </Fragment>
                      )
                    })}
                    {/* Paid, then regenerated out of the month (S788): no payslip row exists to hang the
                        payment on, so it gets its own — otherwise the money is on the ledger and in
                        the strip's "paid more than their payslip" count but nowhere on this page, and
                        its Undo is unreachable. Only while the Paid column shows, and never on a
                        failed payments read. */}
                    {showPaid && !paymentsError && paySummary.noPayslip.map(id => {
                      const emp = empMap[id] || { id, full_name: nameOf(id) }
                      return (
                        <tr key={`no-payslip-${id}`}>
                          <td />
                          <td>
                            <div style={{ fontWeight: 600, color: 'var(--theme-text1)', fontSize: 13 }}>{emp.full_name}</div>
                            {emp.employee_code && <div style={{ fontSize: 10, color: 'var(--theme-text2)', marginTop: 2 }}>{emp.employee_code}</div>}
                          </td>
                          <td colSpan={9} style={{ fontSize: 12, color: 'var(--theme-text2)' }}>
                            No payslip in {monthName} any more — paid, then left out when the month was regenerated.
                          </td>
                          <td style={{ textAlign: 'right' }}>{renderPaidCell({ employee_id: id }, emp)}</td>
                          <td />
                        </tr>
                      )
                    })}
                  </tbody>
                  <tfoot>
                    {/* One total per column (S751). A single figure spanning Absence→Advance sat right-
                        aligned under Advance and read as the month's advance recovery. */}
                    <tr style={{ fontWeight: 700, borderTop: '2px solid var(--theme-border)' }}>
                      <td />
                      <td style={{ color: 'var(--theme-text2)', fontSize: 12 }}>Total — {payslips.length}</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-text1)' }}>{fmt(totals.gross)}</td>
                      {moneyCell(totals.ot, '+')}
                      {negCell(totals.absence)}
                      {negCell(totals.ssfEmp)}
                      {negCell(totals.other)}
                      {negCell(totals.advDed)}
                      {negCell(totals.tds)}
                      {moneyCell(totals.tada, '+')}
                      <td style={{ textAlign: 'right', color: 'var(--theme-text1)', fontSize: 15 }}>{fmt(totals.net)}</td>
                      {showPaid && (
                        <td style={{ textAlign: 'right', color: 'var(--theme-text2)', fontSize: 12, fontWeight: 400, whiteSpace: 'nowrap' }}>
                          {paymentsError ? '' : `${paySummary.paid} of ${paySummary.owed} paid`}
                        </td>
                      )}
                      <td></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
            {/* One topic per line, not a 180-word wall (S613) — the reader is looking up ONE of these
                rules mid-payroll, never reading all of them. */}
            <div style={{ marginTop: 12, fontSize: 11, color: 'var(--theme-text2)', lineHeight: 1.6 }}>
              <p style={{ margin: 0, fontWeight: 600 }}>
                {finalized ? 'This payroll is finalized — payslips are locked as a permanent record.' : 'Draft — Regenerate to pull the latest salary, attendance & tax, then Finalize to lock. You can type over any income tax (TDS) figure.'}
              </p>
              <ul style={{ margin: '6px 0 0', paddingLeft: 16 }}>
                <li><strong>How a figure was worked out</strong>: open the ▸ beside a name. A draft shows the full working from current data — attendance tally, gross, absence, overtime, SSF, the income tax bands, advance cut and TADA — and says first if that payslip has drifted from it. A finalized month shows each figure as it was paid, never recalculated. Either prints as a sheet to hand to the employee.</li>
                <li><strong>Paid</strong>: finalizing pays nobody. Once the money has gone out, Mark paid (one person) or Mark everyone paid records the date and how — bank transfer, cash, eSewa/Khalti or cheque — and staff see it in the Crest Staff app. A mark made by mistake is undone from the ⋯ beside it, with a reason; the record is kept, marked undone. If the month is reopened and a figure changes, the Paid column shows what is still owed, or what was paid too much.</li>
                <li><strong>Who is paid</strong>: active and probation staff, and anyone who left during the month — paid up to their last working day. Someone whose Final Settlement already paid the month is left out and named above.</li>
                <li><strong>SSF</strong> deducts only for employees marked SSF-enrolled AND holding an SSF number — an enrolled employee with no number is flagged in the list and contributes nothing, since a contribution with no number cannot be filed on the challan.</li>
                <li><strong>TDS</strong> (income tax) comes from the fiscal-year tax slabs by year-to-date projection — finalize earlier months first so each month's tax builds on the last.</li>
                <li><strong>TADA</strong> (travel/daily allowance) is paid by the first payroll after a claim is Approved and its trip is over — a trip from 30 Bhadra to 2 Ashwin is paid in the Ashwin payroll, and never twice. It is added after income tax and is not taxed. The amount is always the claims' own total (🔗 shows how many); to change it, change the claim in TADA Claims and Regenerate. Finalize marks those claims Paid; Reopen puts them back to Approved.</li>
                <li><strong>Advances</strong>: instalments are deducted starting with the payroll of the month <em>after</em> the advance was issued (an advance given any day in Bhadra is first cut in the Ashwin payroll). A cut never takes pay below zero — if this month's pay is less than the instalment, only what was earned is taken and the rest stays owed for the next payroll. Repayment rows are written to Advances &amp; Loans on Finalize.</li>
              </ul>
            </div>
          </>
        )}
      </div>

      {/* On-screen payslip modal */}
      {viewSlip && (
        <PayslipModal data={viewSlip} periodLabel={periodLabel} bizInfo={bizInfo} bizInfoFailed={bizInfoFailed} draft={!finalized} onClose={() => setViewSlip(null)} onPrint={() => printPayslip(viewSlip.slip, viewSlip.emp)} />
      )}

      {/* Print-only payslip — explicit padding (margin off the paper edge, unlike the on-screen
          modal which sits inside its own bordered card) and a max-width, or the Row/space-between
          layout below stretches across the full A4 width and shoves label/value to opposite
          edges of the page with a wide dead gap between them. */}
      {printSlip && (
        <div className="print-only" style={{ padding: '28px 36px' }}>
          <div style={{ maxWidth: 420 }}>
            <PayslipBody slip={printSlip.slip} emp={printSlip.emp} periodLabel={periodLabel} bizInfo={bizInfo} draft={!finalized} forPrint />
          </div>
        </div>
      )}

      {printCalc && (
        // Explicit padding: @media print zeroes .main-content's padding so print-only content controls
        // its own margins. No hover tooltips inside — hovers do not print, so every explanation in the
        // working is a visible row or caption.
        <div className="print-only" style={{ padding: '28px 36px' }}>
          <h1 style={{ fontSize: 20, marginBottom: 2 }}>Payroll Calculation</h1>
          <div style={{ fontSize: 13, marginBottom: 2 }}>{printCalc.emp.full_name}{printCalc.emp.employee_code ? ` (${printCalc.emp.employee_code})` : ''}</div>
          <div style={{ fontSize: 12, color: '#555', marginBottom: 14 }}>
            {periodLabel}{finalized ? ' — as paid' : ' — draft'} — printed {nepalBsLong(new Date()) || nepalDateLong(new Date())}
          </div>
          {renderWorking(printCalc.slip)}
        </div>
      )}

      {printApproval && run && period && (
        <div className="print-only">
          <PayrollApprovalSheet
            period={period} periodLabel={periodLabel} run={run} payslips={payslips}
            empMap={empMap} nameOf={nameOf} totals={totals} cost={cost} bizInfo={bizInfo}
            settled={settled} progress={finalized ? null : monthProgress(period)}
            // The Crest operator and the Owner are not the tenant's payroll preparer, so their
            // names are left for the preparer to write in rather than printed as if they were.
            preparedBy={!isAdmin && !isOwner && profile?.full_name ? { name: profile.full_name, role: profile.hr_job_title || '' } : null}
          />
        </div>
      )}

      {confirmAction === 'regenerate' && (() => {
        // Regenerate rebuilds from this month's payroll list, so a payslip for someone not on it —
        // already paid by a Final Settlement, or not employed this month — is deleted and not
        // re-inserted. That is the right outcome now (S751), and the modal still names them.
        const departedNames = freshness.departed.map(nameOf)
        return (
          <ConfirmModal
            title="Regenerate this payroll draft?"
            confirmLabel="Regenerate"
            busy={busy} busyLabel="Recomputing…"
            onConfirm={regenerate}
            onCancel={() => setConfirmAction(null)}
          >
            <p style={{ margin: 0 }}>
              Every payslip is recomputed from current salary, attendance, overtime and tax data.
              Income tax typed by hand is reset to the calculated figure, and TADA is re-read from
              claims that are Approved with the trip over by the end of {monthName}. Nothing is
              finalized by this step.
            </p>
            {departedNames.length > 0 && (
              <p style={{ margin: '10px 0 0' }}>
                {departedNames.slice(0, 8).join(', ')}{departedNames.length > 8 ? `, +${departedNames.length - 8} more` : ''}{' '}
                {departedNames.length === 1 ? 'has a payslip' : 'have payslips'} in this run but{' '}
                {departedNames.length === 1 ? 'is' : 'are'} not on the {monthName} payroll (already paid by a Final Settlement, or not employed this month) —{' '}
                {departedNames.length === 1 ? 'that payslip' : 'those payslips'} will be removed.
              </p>
            )}
          </ConfirmModal>
        )
      })()}
      {confirmAction === 'finalize' && period && (() => {
        const netTotal  = totals.net
        const tadaCount = new Set(payslips.flatMap(p => (Array.isArray(p.tada_claim_ids) ? p.tada_claim_ids : []))).size
        const advCount  = payslips.filter(p => num(p.advance_deduction) > 0).length
        const progress  = monthProgress(period)
        return (
          <ConfirmModal
            title={`Finalize ${periodLabel} payroll?`}
            confirmLabel="Finalize Payroll"
            busy={busy} busyLabel="Finalizing…"
            onConfirm={finalize}
            onCancel={() => setConfirmAction(null)}
          >
            {/* A summary of what finalizing actually does, rather than "are you sure?" — the
                advance recoveries and TADA closures are real writes to other ledgers. */}
            <ul style={{ margin: '0 0 10px', paddingLeft: 18 }}>
              <li><strong>{payslips.length}</strong> payslip{payslips.length === 1 ? '' : 's'}, NPR <strong>{fmt(netTotal)}</strong> total net pay</li>
              {advCount > 0 && <li>{advCount} advance/loan recover{advCount === 1 ? 'y' : 'ies'} will be recorded in Advances &amp; Loans</li>}
              {tadaCount > 0 && <li>{tadaCount} TADA claim{tadaCount === 1 ? '' : 's'} will be marked Paid</li>}
              {/* A typed income tax does not block Finalize (it is an intended edit, not staleness), so
                  this is the one place it gets stated: locking a hand-set figure is worth seeing. */}
              {freshness.overridden.length > 0 && (
                <li>
                  <strong>{freshness.overridden.length}</strong> payslip{freshness.overridden.length === 1 ? ' has' : 's have'}{' '}
                  income tax typed by hand ({listNames(freshness.overridden, nameOf)}) — locked as entered, not recomputed
                </li>
              )}
              {/* Finalizing early is allowed (decision 5); the confirm says what that means. */}
              {progress?.future && <li><strong>{monthName} hasn't started yet</strong> — attendance, leave and overtime for it can still change pay after you finalize.</li>}
              {progress && !progress.future && (
                <li>
                  <strong>{monthName} isn't over yet</strong> — {progress.left === 0 ? 'today is its last day' : `${progress.left} day${progress.left === 1 ? '' : 's'} left after today`}. Attendance, leave or overtime still to come would need a Reopen.
                </li>
              )}
              {pending?.loading && <li style={{ color: 'var(--theme-text2)' }}>Checking for leave and overtime still waiting for a decision…</li>}
              {pending && !pending.loading && pending.failed && (
                <li style={{ color: 'var(--theme-amber-text)' }}>Could not check for pending leave or overtime requests — look in Leave and Overtime before finalizing.</li>
              )}
              {pending && !pending.loading && !pending.failed && pending.leave > 0 && (
                <li style={{ color: 'var(--theme-amber-text)' }}><strong>{pending.leave}</strong> leave request{pending.leave === 1 ? '' : 's'} touching {monthName} {pending.leave === 1 ? 'is' : 'are'} still pending — deciding {pending.leave === 1 ? 'it' : 'them'} later can change pay, and then needs a Reopen.</li>
              )}
              {pending && !pending.loading && !pending.failed && pending.ot > 0 && (
                <li style={{ color: 'var(--theme-amber-text)' }}><strong>{pending.ot}</strong> overtime entr{pending.ot === 1 ? 'y' : 'ies'} for {monthName} {pending.ot === 1 ? 'is' : 'are'} still pending and will not be paid by this run.</li>
              )}
              {pending && !pending.loading && !pending.failed && pending.leave === 0 && pending.ot === 0 && (
                <li>No leave or overtime requests for {monthName} are waiting for a decision.</li>
              )}
            </ul>
            <p style={{ margin: 0 }}>Everything is checked once more against current data before anything is written. Payslips are then locked as a permanent record; this can be undone with Reopen.</p>
          </ConfirmModal>
        )
      })()}
      {confirmAction === 'reopen' && (() => {
        // Advances this run recovered that have since been written off: the reopen removes the recovery
        // but cannot reopen the loan, so they are named before anyone presses it (S751 review).
        const ownAdvanceIds = new Set(repayments.filter(r => r.payroll_run_id === run?.id).map(r => r.advance_id))
        const writtenOff = advances.filter(a => ownAdvanceIds.has(a.id) && a.status === 'written_off')
        return (
          <ConfirmModal
            title="Reopen this payroll for editing?"
            confirmLabel="Reopen Payroll"
            busy={busy} busyLabel="Reopening…"
            onConfirm={reopen}
            onCancel={() => setConfirmAction(null)}
          >
            <p style={{ margin: 0 }}>
              The run returns to draft: advance repayments auto-recorded by this run are reversed,
              and TADA claims it auto-marked Paid revert to Approved. Payslips already handed to
              staff will no longer match until you finalize again.
            </p>
            {writtenOff.length > 0 && (
              <p style={{ margin: '10px 0 0', color: 'var(--theme-amber-text)' }}>
                {writtenOff.map(a => `${nameOf(a.employee_id)}'s advance of NPR ${fmt(a.amount)}`).join(', ')}{' '}
                {writtenOff.length === 1 ? 'has' : 'have'} since been written off — {writtenOff.length === 1 ? 'its write-off does' : 'their write-offs do'} not
                change when this run's recovery is removed, so check {writtenOff.length === 1 ? 'it' : 'them'} in Advances &amp; Loans afterwards.
              </p>
            )}
            {/* Reopen stays allowed after payment (decided 2026-09-23), with this warning. The payment
                records survive the reopen and any Regenerate; the Paid column then names a difference. */}
            {activePayments.length > 0 && (() => {
              const paidPeople = new Set(activePayments.map(p => p.employee_id)).size
              return (
                <p style={{ margin: '10px 0 0', color: 'var(--theme-amber-text)' }}>
                  △ {paidPeople === 1 ? '1 person is' : `${paidPeople} staff are`} already marked paid for {monthName} (NPR {fmt(paySummary.paidTotal)}).
                  Those payment records are kept. If you change any figures and finalize again, the Paid column shows anyone still owed a
                  difference, or paid too much — nothing is taken back or paid automatically.
                </p>
              )
            })()}
            {paymentsError && (
              <p style={{ margin: '10px 0 0', color: 'var(--theme-amber-text)' }}>
                △ The salary payments for {monthName} could not be read, so this cannot say whether anyone has already been paid.
              </p>
            )}
          </ConfirmModal>
        )
      })()}
      {markPaid && run && (
        <MarkPaidDialog
          people={markPaid} periodLabel={periodLabel} runId={run.id}
          onClose={() => setMarkPaid(null)}
          onDone={res => afterPaymentChange(`Recorded NPR ${fmt(res?.total || 0)} paid to ${res?.payments || 0} ${(res?.payments || 0) === 1 ? 'person' : 'staff'}`)}
        />
      )}
      {undoPay && (
        <UndoPaymentDialog
          payment={undoPay.payment} name={undoPay.name}
          onClose={() => setUndoPay(null)}
          onDone={() => afterPaymentChange(`Undone — ${undoPay.name}'s NPR ${fmt(undoPay.payment.amount)} is no longer counted as paid`)}
        />
      )}
      {confirmEl}
    </div>
  )
}

function PayslipModal({ data, periodLabel, bizInfo, bizInfoFailed, draft, onClose, onPrint }) {
  const { slip, emp } = data
  return (
    // The shared Modal, not a hand-rolled overlay: this dialog shows an employee's pay document,
    // so it needs the focus trap and Escape that Modal provides. Printing is a separate path
    // (the `printSlip` render above), which is why Modal's own `no-print` overlay is fine here.
    <Modal onClose={onClose} title="Payslip" maxWidth={460}>
      {bizInfoFailed && (
        <p role="note" style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--theme-amber-text)' }}>
          The company name, address and PAN could not be loaded, so this payslip will print without its letterhead. Reload the page to try again.
        </p>
      )}
      <PayslipBody slip={slip} emp={emp} periodLabel={periodLabel} bizInfo={bizInfo} draft={draft} />
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 18 }}>
        <button className="btn btn-ghost" onClick={onClose}>Close</button>
        <button className="btn btn-primary" onClick={onPrint}>🖨 Print</button>
      </div>
    </Modal>
  )
}
