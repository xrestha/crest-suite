import { nprInt } from '../../../shared/nepalMoney'
import { useState, useEffect, useCallback, useMemo } from 'react'
import { Navigate } from 'react-router-dom'
import { Lock } from 'lucide-react'
import { supabase } from '../../../supabaseClient'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import Tip from '../../../components/Tip'
import Modal from '../../../components/Modal'
import ConfirmModal from '../../../components/ConfirmModal'
import ReportLoadError from '../../../components/ReportLoadError'
import SearchableSelect from '../../../components/SearchableSelect'
import BsCalendarPicker from '../../../components/BsCalendarPicker'
import FieldError, { fieldAria } from '../../../components/FieldError'
import { invalidStyle } from '../../../shared/inlineFieldState'
import { adToBsSafe, BS_MONTHS, formatAdAsBs } from '../../../utils/bsCalendar'
import { nepalBsLong } from '../../../shared/nepalTime'
import { firstRecoveryMonth } from '../payroll/payrollData'
import ActionError, { asActionError } from '../../../components/ActionError'
import { errorLine } from '../../../shared/errorText'
import { useConfirm } from '../../../shared/hooks/useConfirm'

const fmt = nprInt
const fmtD = iso => {
  if (!iso) return '—'
  const bs = adToBsSafe(new Date(iso + 'T00:00:00'))
  // Out of the BS table's range: show the AD date, marked, never a confident wrong BS date (S753).
  if (!bs) return `${iso} (AD)`
  return `${bs.year}-${String(bs.month).padStart(2,'0')}-${String(bs.day).padStart(2,'0')}`
}
const round2 = n => Math.round(n * 100) / 100
// A paisa of tolerance on every "is anything still owed" test — the same 0.01 the database's
// hr_advance_repayments_guard and sync trigger use, so the page and the refusal cannot disagree.
const OWED_EPS = 0.01

const monthKey = m => `${m.bs_year}-${m.bs_month}`
const monthLabel = m => `${BS_MONTHS[m.bs_month - 1]} ${m.bs_year}`
const nextMonth = m => (m.bs_month === 12 ? { bs_year: m.bs_year + 1, bs_month: 1 } : { bs_year: m.bs_year, bs_month: m.bs_month + 1 })

// The payroll that will ACTUALLY take an advance's first (or next) cut (S751, stated default). An
// advance is due from the month after it was issued — payrollData's firstRecoveryMonth(), the rule
// Payroll Run deducts by — but a FINALIZED run cannot take a new deduction. So a back-dated advance
// issued in Bhadra when Ashwin is already paid is first cut in Kartik, and the form used to promise
// Ashwin. Skipping finalized months alone is not enough: a back-dated advance whose first month
// simply never HAD a payroll run would still name that past month. So the walk starts at the LATER of
// the first recovery month and the month after this client's latest finalized run, then keeps
// stepping past any finalized month.
const monthIdx = m => m.bs_year * 12 + (m.bs_month - 1)
function realFirstCut(issuedIso, finalizedKeys, latestFinalized) {
  const first = firstRecoveryMonth(issuedIso)
  if (!first) return null
  let m = first
  if (latestFinalized) {
    const after = nextMonth(latestFinalized)
    if (monthIdx(after) > monthIdx(m)) m = after
  }
  for (let i = 0; i < 600 && finalizedKeys.has(monthKey(m)); i++) m = nextMonth(m)
  return { first, cut: m, moved: monthKey(m) !== monthKey(first) }
}

// Type is a LABEL, not a schedule (S751 stated default): payroll cuts `installment_amount` a month
// whichever type it is, and the whole balance when there is none. The words say what happens.
const TYPE_LABEL = { advance: 'One-time', loan: 'In instalments' }

// HR's one status vocabulary (payrollConstants' HR_REQUEST_STATUS, S660): brass = decided but the
// money has not moved yet (an active advance is owed, not overdue — nothing is wrong), green =
// closed good, grey = closed void. Amber is deliberately absent: nothing here waits on a decision.
const ADVANCE_STATUS = {
  active:      { label: 'Active',      badge: 'badge-yellow' },
  settled:     { label: 'Settled',     badge: 'badge-green' },
  written_off: { label: 'Written off', badge: 'badge-gray' },
}

// Where a repayment row came from. Payroll and Final Settlement tag their own rows so their Reopen
// can undo exactly what they wrote (S600); a row carrying neither was typed on this page.
const sourceOf = r => (r.payroll_run_id ? 'payroll' : r.final_settlement_id ? 'settlement' : 'manual')
const SOURCE_LABEL = { payroll: 'Payroll', settlement: 'Final Settlement', manual: 'Manual' }

const inp = {
  background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)',
  borderRadius: 0, padding: '7px 10px', fontSize: 13, color: 'var(--theme-text1)',
  outline: 'none', width: '100%', fontFamily: 'inherit',
}
const lbl = { fontSize: 11, color: 'var(--theme-text3)', marginBottom: 4, display: 'block' }
const hint = { fontSize: 12, color: 'var(--theme-text3)', marginTop: 4 }

const EMPTY_ADD = {
  employee_id: '', type: 'advance', issued_date: '', amount: '',
  installment_amount: '', purpose: '', notes: '',
}
const EMPTY_REPAY = { repaid_date: '', amount: '', notes: '' }

export default function Advances() {
  const { clientId, hasHrAccess } = useAuth()
  const { scopedFrom, scopedInsert, scopedUpdate, scopedDelete } = useScopedDb()
  const { ask: askConfirm, confirmEl } = useConfirm()
  // A page-level action failure (settle, delete, write-off) — the modal-scoped `error` cannot show it.
  const [pageError, setPageError] = useState(null)
  const [pageNotice, setPageNotice] = useState('')
  const [employees,  setEmployees]  = useState([])
  const [advances,   setAdvances]   = useState([])
  const [repayments, setRepayments] = useState([])
  const [loading,    setLoading]    = useState(true)
  // A failed read is not an empty ledger (S751). All three reads used to drop `error`: a failed
  // advances read printed "No records found" under Total Outstanding NPR 0, a failed repayments read
  // showed every advance as wholly owed, and a failed employees read emptied the Issue form. Now the
  // page renders the error card and nothing below it, and every write stays disabled.
  const [loadError,  setLoadError]  = useState(null)
  // The client whose ledger is on screen. `loading` alone cannot say it, because a reload after a
  // save keeps the previous (same-client) figures visible while an admin client switch must not.
  const [loadedFor,  setLoadedFor]  = useState(null)
  // Months whose payroll is finalized — only for the "first salary cut" hint. A failed read degrades
  // the hint to a caveat rather than blocking the ledger, because nothing is computed from it.
  const [finalizedMonths, setFinalizedMonths] = useState(() => new Set())
  const [latestFinalized, setLatestFinalized] = useState(null) // { bs_year, bs_month } | null
  const [runsError,  setRunsError]  = useState(null)
  const [profileNames, setProfileNames] = useState({})
  const [filterType,   setFilterType]   = useState('all')    // all | advance | loan
  const [filterStatus, setFilterStatus] = useState('active') // active | settled | written_off | all
  const [selected,   setSelected]   = useState(null)  // advance id for detail panel
  const [showAdd,    setShowAdd]    = useState(false)
  const [showRepay,  setShowRepay]  = useState(false)
  const [addForm,    setAddForm]    = useState(EMPTY_ADD)
  const [repayForm,  setRepayForm]  = useState(EMPTY_REPAY)
  const [saving,     setSaving]     = useState(false)
  const [error,      setError]      = useState('')
  // Per-field validation, keyed by control id so the two modals on this page (Add advance, Record
  // repayment) can share one map without colliding. `error` above stays the form-level channel for
  // a rejected write (S603).
  const [fieldErr, setFieldErr] = useState({})
  // Write-off keeps its own dialog rather than useConfirm(): its reason is REQUIRED, so a blank
  // Confirm must keep the dialog open with the message under the box, and useConfirm closes on run.
  const [writeOff, setWriteOff] = useState(null) // { adv, reason, err, busy }

  // Keyed on the client (S751). An admin switching "view as" mid-load let the previous client's
  // ledger land last and render under the new client's name. begin() runs before the first await,
  // on the first load too — the S721 rule: once any load has claimed, isCurrent stops failing open.
  const loadReq = useLatestRequest()

  const load = useCallback(async () => {
    if (!clientId) return
    const key = loadReq.begin(clientId)
    setLoading(true)
    const [emps, advs, reps, runs] = await Promise.all([
      scopedFrom('hr_employees', 'id, full_name, employee_code, status').order('full_name'),
      // Both are unfiltered lifetime ledgers — every advance and every repayment the client has
      // ever recorded — so they page, for the same reason PayrollRun and PayrollCalculation page
      // them (S620). Outstanding is derived as `amount − repaid`, so truncating the REPAYMENTS
      // side alone overstates what every employee still owes. `.order('id')` is the unique
      // tiebreaker: `issued_date`/`repaid_date` are not unique (several advances share a date), and
      // paging on a non-unique sort repeats a row on one page and skips it on the next.
      fetchAllRows(() => scopedFrom('hr_advances').order('issued_date', { ascending: false }).order('id')),
      fetchAllRows(() => scopedFrom('hr_advance_repayments').order('repaid_date').order('id')),
      // One row per payroll month — twelve a year — so deliberately not paged.
      scopedFrom('hr_payroll_runs', 'id, monthly_periods!inner(bs_year, bs_month)').eq('status', 'finalized'),
    ])
    if (!loadReq.isCurrent(key)) return
    const err = emps.error || advs.error || reps.error
    if (err) {
      setLoadError(err)
      setEmployees([]); setAdvances([]); setRepayments([])
      setLoadedFor(null)
      setLoading(false)
      return
    }
    setLoadError(null)
    setEmployees(emps.data || [])
    setAdvances(advs.data || [])
    setRepayments(reps.data || [])
    setRunsError(runs.error || null)
    const runMonths = (runs.data || []).map(r => r.monthly_periods).filter(Boolean)
    setFinalizedMonths(new Set(runMonths.map(monthKey)))
    setLatestFinalized(runMonths.reduce((best, m) => (!best || monthIdx(m) > monthIdx(best) ? m : best), null))
    setLoadedFor(clientId)
    setLoading(false)

    // Who wrote each advance off. `profiles` RLS is self-or-admin, so another manager's name needs
    // the SECURITY DEFINER RPC. Best-effort: a failure leaves the date without a name, never a wrong one.
    if ((advs.data || []).some(a => a.status === 'written_off' && a.written_off_by)) {
      supabase.rpc('get_client_profile_names', { p_client_id: clientId }).then(({ data, error: nameErr }) => {
        if (!loadReq.isCurrent(key) || nameErr) return
        setProfileNames(Object.fromEntries((data || []).map(p => [p.id, p.full_name])))
      }, () => {})
    }
  }, [clientId, scopedFrom, loadReq])

  useEffect(() => { setSelected(null); setPageError(null); setPageNotice('') }, [clientId])
  useEffect(() => { load() }, [load])

  // Memoized: the Add Advance and Record Repayment forms are controlled inputs on this component,
  // so every keystroke rebuilt the employee index and the whole repayment ledger index, then made
  // four more passes for the KPI strip — none of which the form can change.
  const empMap = useMemo(
    () => Object.fromEntries((employees || []).map(e => [e.id, e])), [employees])

  // Per-advance repayment totals and rows
  const repayMap = useMemo(() => {
    const m = {}
    ;(repayments || []).forEach(r => {
      if (!m[r.advance_id]) m[r.advance_id] = { total: 0, rows: [] }
      m[r.advance_id].total += parseFloat(r.amount) || 0
      m[r.advance_id].rows.push(r)
    })
    return m
  }, [repayments])

  const filtered = useMemo(() => (advances || []).filter(a => {
    if (filterType !== 'all' && a.type !== filterType) return false
    if (filterStatus !== 'all' && a.status !== filterStatus) return false
    return true
  }), [advances, filterType, filterStatus])

  // Summary stats — one pass. Total Outstanding is ACTIVE balances only: a written-off balance is
  // money the company decided not to recover, and counting it as owed is the figure that made
  // Write-off necessary in the first place. It gets its own figure instead.
  const { totalOutstanding, totalWrittenOff, employeesWithActive, advanceCount, loanCount } = useMemo(() => {
    let totalOutstanding = 0, totalWrittenOff = 0, advanceCount = 0, loanCount = 0
    const empIds = new Set()
    for (const a of advances) {
      // Derived from the ledger, not the stored `write_off_amount`: a payroll or settlement Reopen
      // can delete repayments on a written-off advance, and the stamp does not move with them.
      if (a.status === 'written_off') { totalWrittenOff += Math.max(0, parseFloat(a.amount) - (repayMap[a.id]?.total || 0)); continue }
      if (a.status !== 'active') continue
      totalOutstanding += Math.max(0, parseFloat(a.amount) - (repayMap[a.id]?.total || 0))
      empIds.add(a.employee_id)
      if (a.type === 'advance') advanceCount++
      else if (a.type === 'loan') loanCount++
    }
    return { totalOutstanding, totalWrittenOff, employeesWithActive: empIds.size, advanceCount, loanCount }
  }, [advances, repayMap])

  // Every write on this page acts on the ledger shown; none may run over a failed, stale or
  // still-arriving read.
  const ready = !loading && !loadError && loadedFor === clientId

  // The one call shape for realFirstCut: a failed runs read contributes nothing rather than a guess.
  const cutFor = iso => realFirstCut(iso, runsError ? new Set() : finalizedMonths, runsError ? null : latestFinalized)

  // "First salary cut: Kartik 2083 payroll." — or why it is not the month the rule alone would say.
  function recoveryHint(iso) {
    const r = cutFor(iso)
    if (!r) return 'Salary cuts start from the payroll of the month after this date.'
    if (runsError) return `First salary cut: ${monthLabel(r.first)} payroll — unless payroll for that month is already finalized (the list of finalized payrolls could not be read).`
    if (!r.moved) return `First salary cut: ${monthLabel(r.first)} payroll.`
    return `Payroll is already finalized up to ${monthLabel(latestFinalized)}, so the first cut will be ${monthLabel(r.cut)} — not ${monthLabel(r.first)}.`
  }

  // Both setters clear the edited field's own error: a border still red under a corrected box
  // teaches the user these messages are stale and worth ignoring.
  // Field name → the control id its message is keyed on. Deriving it as `adv-${field}` cleared
  // `adv-employee_id` while the message sat on `adv-employee`, so a corrected box stayed red.
  const ADD_FIELD_ID = { employee_id: 'adv-employee', issued_date: 'adv-issued-date', amount: 'adv-amount', installment_amount: 'adv-installment', type: 'adv-installment' }
  const REPAY_FIELD_ID = { repaid_date: 'adv-repay-date', amount: 'adv-repay-amount' }
  function clearFieldErr(id) { if (id) setFieldErr(e => (e[id] ? { ...e, [id]: '' } : e)) }
  function setAdd(f, v) { clearFieldErr(ADD_FIELD_ID[f]); setAddForm(p => ({ ...p, [f]: v })) }
  function setRepay(f, v) { clearFieldErr(REPAY_FIELD_ID[f]); setRepayForm(p => ({ ...p, [f]: v })) }

  async function handleAdd() {
    if (!clientId || !ready) return
    const amount = parseFloat(addForm.amount)
    const instRaw = String(addForm.installment_amount ?? '').trim()
    const inst = instRaw === '' ? null : parseFloat(instRaw)
    const fe = {}
    if (!addForm.employee_id) fe['adv-employee'] = 'Select an employee.'
    if (!addForm.issued_date) fe['adv-issued-date'] = 'Set the issued date.'
    if (!(amount > 0)) fe['adv-amount'] = 'Enter a valid amount.'
    // The monthly cut is money payroll TAKES (S751). A loan with none would have its whole balance
    // come off the next payslip — not what "in instalments" means — so a loan must say how much.
    if (addForm.type === 'loan' && inst === null) fe['adv-installment'] = 'A loan is repaid in instalments — enter how much comes off each salary.'
    else if (inst !== null && !(inst > 0)) fe['adv-installment'] = 'Enter an amount above zero, or leave it blank for a one-time advance.'
    else if (inst !== null && amount > 0 && inst > amount) fe['adv-installment'] = 'The monthly cut cannot be more than the amount issued.'
    setFieldErr(fe)
    if (Object.keys(fe).length) return
    setError(''); setSaving(true)
    const { error: err } = await scopedInsert('hr_advances', {
      employee_id:        addForm.employee_id,
      type:               addForm.type,
      issued_date:        addForm.issued_date,
      amount,
      installment_amount: inst,
      purpose:            addForm.purpose || null,
      notes:              addForm.notes || null,
    })
    setSaving(false)
    if (err) { setError(errorLine(err)); return }
    setShowAdd(false); setAddForm(EMPTY_ADD); load()
  }

  function openRepay(adv, outstanding) {
    // Pre-filled with what payroll would cut, never more than is owed — a typed 50,000 against a
    // 5,000 balance used to close the loan for good (the database refuses it now too).
    const inst = parseFloat(adv.installment_amount) || outstanding
    setRepayForm({ ...EMPTY_REPAY, amount: outstanding > 0 ? String(round2(Math.min(inst, outstanding))) : '' })
    setFieldErr({}); setError(''); setShowRepay(true)
  }

  async function handleRepay() {
    if (!clientId || !selected || !ready) return
    const adv = advances.find(a => a.id === selected)
    if (!adv) return
    const outstanding = Math.max(0, parseFloat(adv.amount) - (repayMap[adv.id]?.total || 0))
    const amt = parseFloat(repayForm.amount)
    const fe = {}
    if (!repayForm.repaid_date) fe['adv-repay-date'] = 'Set the repayment date.'
    if (!(amt > 0)) fe['adv-repay-amount'] = 'Enter a valid amount.'
    else if (amt > outstanding + OWED_EPS) fe['adv-repay-amount'] = `Only NPR ${fmt(outstanding)} is still owed on this ${adv.type === 'loan' ? 'loan' : 'advance'}.`
    setFieldErr(fe)
    if (Object.keys(fe).length) return
    setError(''); setSaving(true)
    const { error: err } = await scopedInsert('hr_advance_repayments', {
      advance_id:  selected,
      employee_id: adv.employee_id,
      repaid_date: repayForm.repaid_date,
      amount:      amt,
      notes:       repayForm.notes || null,
    })
    setSaving(false)
    if (err) { setError(errorLine(err)); return }
    setShowRepay(false); setRepayForm(EMPTY_REPAY)
    // The database settles an advance the moment nothing is owed (hr_advance_repayments_sync_status),
    // so the reload shows it Settled — say so, or it reads as having vanished from the Active tab.
    setPageError(null)
    setPageNotice(amt >= outstanding - OWED_EPS ? 'Fully repaid — marked settled.' : `Repayment of NPR ${fmt(amt)} recorded.`)
    load()
  }

  // Only reachable once nothing is owed — the database refuses otherwise (advance_not_repaid), and
  // with its sync trigger an advance normally settles itself. Kept for rows that predate the trigger.
  async function handleSettle(adv) {
    setPageError(null); setPageNotice('')
    const { data, error: err } = await scopedUpdate('hr_advances', { status: 'settled' })
      .eq('id', adv.id).eq('status', 'active').select('id')
    if (err) { setPageError(asActionError(err)); load(); return }
    // A write RLS or the status filter refused is 0 rows with no error.
    if (!data?.length) { setPageError('It was not marked settled — it is no longer active, or this login cannot change advances. The page has been reloaded to show its real state.'); load(); return }
    setPageNotice('Marked settled.')
    load()
  }

  function openWriteOff(adv) {
    setPageError(null); setPageNotice('')
    setWriteOff({ adv, reason: '', err: '', busy: false })
  }

  async function confirmWriteOff() {
    if (!writeOff || writeOff.busy) return
    const reason = writeOff.reason.trim()
    if (!reason) { setWriteOff(w => ({ ...w, err: 'Say why this balance will not be repaid — the reason is kept with the write-off.' })); return }
    const adv = writeOff.adv
    setWriteOff(w => ({ ...w, busy: true, err: '' }))
    // The amount, who and when are stamped by the database (hr_advances_guard), never sent from here.
    const { data, error: err } = await scopedUpdate('hr_advances', { status: 'written_off', write_off_reason: reason })
      .eq('id', adv.id).eq('status', 'active').select('id')
    setWriteOff(null)
    if (err) { setPageError(asActionError(err)); load(); return }
    if (!data?.length) { setPageError('Nothing was written off — the advance is no longer active, or this login cannot change advances. The page has been reloaded to show its real state.'); load(); return }
    setPageNotice('Written off. Payroll will no longer cut it.')
    load()
  }

  function handleReactivate(adv, balance) {
    const emp = empMap[adv.employee_id]
    const r = cutFor(adv.issued_date)
    askConfirm({
      title: `Reactivate this ${adv.type === 'loan' ? 'loan' : 'advance'}?`,
      confirmLabel: 'Reactivate', busyLabel: 'Reactivating…',
      body: (
        <p style={{ margin: 0 }}>
          NPR {fmt(balance)} becomes owed again{emp ? ` by ${emp.full_name}` : ''}, and payroll resumes cutting it from
          salary{r ? ` from the ${monthLabel(r.cut)} payroll` : ''}. Final Settlement will recover it if they leave. The
          write-off reason is cleared; the change is logged.
        </p>
      ),
      run: async () => {
        setPageError(null); setPageNotice('')
        const { data, error: err } = await scopedUpdate('hr_advances', { status: 'active' })
          .eq('id', adv.id).eq('status', 'written_off').select('id')
        if (err) { setPageError(asActionError(err)); load(); return }
        if (!data?.length) { setPageError('It was not reactivated — it is no longer written off, or this login cannot change advances. The page has been reloaded to show its real state.'); load(); return }
        setPageNotice('Reactivated. Payroll will cut it again.')
        load()
      },
    })
  }

  // A loan ledger row: the confirm names the amount and the date rather than asking "are you
  // sure?" (S682; was window.confirm). Offered only when the repayments read succeeded and shows
  // none — the database refuses the rest (advance_has_repayments), since payslips point at them.
  function handleDelete(advId) {
    const hasReps = (repayMap[advId]?.rows || []).length > 0
    if (hasReps || !ready) return
    const adv = advances.find(a => a.id === advId)
    const emp = adv ? empMap[adv.employee_id] : null
    askConfirm({
      title: `Delete this ${adv?.type === 'loan' ? 'loan' : 'advance'}?`,
      confirmLabel: 'Delete', danger: true, busyLabel: 'Deleting…',
      body: (
        <p style={{ margin: 0 }}>
          NPR {fmt(adv?.amount)}{emp ? ` issued to ${emp.full_name}` : ''}{adv?.issued_date ? ` on ${formatAdAsBs(adv.issued_date)}` : ''} is removed from the
          ledger, and the payroll deduction it drives stops. This cannot be undone.
        </p>
      ),
      run: async () => {
        setPageError(null); setPageNotice('')
        const { data, error: err } = await scopedDelete('hr_advances').eq('id', advId).select('id')
        if (err) { setPageError(asActionError(err)); load(); return }
        if (!data?.length) { setPageError('Nothing was deleted — this login cannot delete advances, or it was already removed. The page has been reloaded to show its real state.'); load(); return }
        if (selected === advId) setSelected(null)
        load()
      },
    })
  }

  // Decision 13 (S751): a hand-entered repayment can be deleted; payroll's and Final Settlement's
  // cannot, because their own Reopen is what undoes them. The `.is()` filters make that true at the
  // write, not only in which button renders, and the row count says whether it landed.
  function handleDeleteRepayment(adv, r, outstanding) {
    const back = round2(outstanding + (parseFloat(r.amount) || 0))
    askConfirm({
      title: 'Delete this repayment?',
      confirmLabel: 'Delete repayment', danger: true, busyLabel: 'Deleting…',
      body: (
        <p style={{ margin: 0 }}>
          NPR {fmt(r.amount)} recorded on {formatAdAsBs(r.repaid_date)} is removed, and the {adv.type === 'loan' ? 'loan' : 'advance'} goes
          back to owing NPR {fmt(back)}.
          {adv.status === 'settled' ? ' It was settled, so it becomes active again and payroll resumes cutting it from salary.' : ''}
          {' '}The deletion is logged.
        </p>
      ),
      run: async () => {
        setPageError(null); setPageNotice('')
        const { data, error: err } = await scopedDelete('hr_advance_repayments')
          .eq('id', r.id).is('payroll_run_id', null).is('final_settlement_id', null).select('id')
        if (err) { setPageError(asActionError(err)); load(); return }
        if (!data?.length) { setPageError('Nothing was deleted — the repayment is already gone, belongs to payroll or a settlement, or this login cannot change it. The page has been reloaded to show its real state.'); load(); return }
        setPageNotice(`Repayment deleted — NPR ${fmt(back)} is owed again.`)
        load()
      },
    })
  }

  // Not gated on `ready`: a same-client reload keeps the panel (its buttons are what go inert), and
  // a failed or other-client load never reaches the render below.
  const selectedAdv = selected ? advances.find(a => a.id === selected) : null
  const selectedReps = selectedAdv ? (repayMap[selected]?.rows || []) : []
  const selectedRepaid = selectedAdv ? (repayMap[selected]?.total || 0) : 0
  const selectedOutstanding = selectedAdv ? Math.max(0, parseFloat(selectedAdv.amount) - selectedRepaid) : 0
  const selectedNextCut = selectedAdv?.status === 'active' ? cutFor(selectedAdv.issued_date) : null

  const tabBtn = (val, cur, set, label) => (
    <button className={`tab-btn${cur === val ? ' tab-btn--active' : ''}`}
      onClick={() => set(val)}>{label}</button>
  )

  if (!hasHrAccess('manager')) return <Navigate to="/dashboard" replace />
  if (!loadError && loadedFor !== clientId) return <div style={{ padding: 32, color: 'var(--theme-text3)' }}>Loading…</div>

  const header = (
    <div className="page-header page-header--split">
      <div>
        <h1 className="page-title">Advances &amp; Loans</h1>
        <p className="page-subtitle">Track salary advances and employee loans</p>
      </div>
      <button className="btn btn-primary" disabled={!ready}
        onClick={() => { setAddForm(EMPTY_ADD); setFieldErr({}); setError(''); setShowAdd(true) }}>
        + Issue Advance / Loan
      </button>
    </div>
  )

  if (loadError) return (
    <div>
      {header}
      <ReportLoadError error={loadError} />
    </div>
  )

  const addAmount = parseFloat(addForm.amount)
  const addInstBlank = String(addForm.installment_amount ?? '').trim() === ''

  return (
    <div>
      {header}

      <ActionError error={pageError} />
      {pageNotice && !pageError && (
        <div role="status" style={{ fontSize: 13, color: 'var(--theme-green-text)', marginBottom: 12 }}>{pageNotice}</div>
      )}

      {/* Summary cards */}
      <div className="stat-grid">
        {[
          { label: 'Total Outstanding', value: `NPR ${fmt(totalOutstanding)}`, tip: 'What staff still owe on active advances and loans — the money payroll is still cutting from salaries. Written-off balances are not included.' },
          { label: 'Written Off', value: `NPR ${fmt(totalWrittenOff)}`, tip: 'Balances the business decided not to recover. Payroll no longer cuts them and Final Settlement will not take them back. Reactivate one if the money does come back.' },
          { label: 'Employees Affected', value: employeesWithActive, tip: 'Number of employees with at least one active advance or loan.' },
          { label: 'Active Advances', value: advanceCount, tip: 'One-time advances still being recovered. Unless a monthly cut was set, the whole balance comes off the next salary — never more than that month\'s pay; anything left waits for the one after.' },
          { label: 'Active Loans', value: loanCount, tip: 'Loans being repaid in instalments: the set amount comes off each salary until nothing is owed. There is no fixed end date — a month with too little pay takes less, and the loan simply runs a month longer.' },
        ].map(c => (
          <div key={c.label} className="card" style={{ padding: '14px 16px' }}>
            <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginBottom: 4 }}>
              <Tip text={c.tip} width={260}>{c.label}</Tip>
            </div>
            <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--theme-text1)' }}>{c.value}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <div className="tab-bar">
          {tabBtn('all',     filterType,   setFilterType,   'All')}
          {tabBtn('advance', filterType,   setFilterType,   'One-time')}
          {tabBtn('loan',    filterType,   setFilterType,   'In instalments')}
        </div>
        <div className="tab-bar">
          {tabBtn('active',      filterStatus, setFilterStatus, 'Active')}
          {tabBtn('settled',     filterStatus, setFilterStatus, 'Settled')}
          {tabBtn('written_off', filterStatus, setFilterStatus, 'Written off')}
          {tabBtn('all',         filterStatus, setFilterStatus, 'All')}
        </div>
      </div>

      {/* Main table */}
      <div className="table-wrap" style={{ marginBottom: selected ? 12 : 0 }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>Employee</th>
              <th><Tip text="One-time: the whole amount comes off the next salary. In instalments: a set amount comes off each salary until it is repaid. Either way, cuts start with the payroll of the month after it was issued." width={260}>Type</Tip></th>
              <th>Issued (BS)</th>
              <th style={{ textAlign: 'right' }}><Tip text="Original amount issued.">Amount</Tip></th>
              <th style={{ textAlign: 'right' }}><Tip text="How much payroll cuts from this person's salary each month. Example: NPR 20,000 at NPR 5,000 a month comes off four salaries. A dash means the whole balance comes off the next salary. Never more than that month's pay — anything left waits for the next one." width={280}>Installment/Mo</Tip></th>
              <th style={{ textAlign: 'right' }}><Tip text="Total paid back so far — salary cuts recorded by payroll, recovery at Final Settlement, and cash repayments entered here.">Repaid</Tip></th>
              <th style={{ textAlign: 'right' }}><Tip text="What is still owed: the amount issued minus everything repaid. A written-off row shows a dash — that balance is no longer being recovered." width={260}>Outstanding</Tip></th>
              <th>Purpose</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={9} style={{ textAlign: 'center', color: 'var(--theme-text3)', padding: 32 }}>
                No records found.
              </td></tr>
            )}
            {filtered.map(a => {
              const emp      = empMap[a.employee_id] || {}
              const repaid   = repayMap[a.id]?.total || 0
              const outstanding = Math.max(0, parseFloat(a.amount) - repaid)
              const st       = ADVANCE_STATUS[a.status] || { label: a.status, badge: 'badge-gray' }
              const isSel    = selected === a.id
              return (
                <tr key={a.id}
                  onClick={() => setSelected(isSel ? null : a.id)}
                  style={{ cursor: 'pointer', background: isSel ? 'color-mix(in srgb, var(--theme-accent) 7%, transparent)' : undefined }}
                >
                  <td>
                    <div style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{emp.full_name || '—'}</div>
                    {emp.employee_code && <div style={{ fontSize: 11, color: 'var(--theme-text3)' }}>{emp.employee_code}</div>}
                  </td>
                  <td style={{ color: 'var(--theme-text2)', fontSize: 13 }}>{TYPE_LABEL[a.type] || a.type}</td>
                  <td style={{ color: 'var(--theme-text2)', fontSize: 13 }}>{fmtD(a.issued_date)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600, color: 'var(--theme-text1)' }}>{fmt(a.amount)}</td>
                  <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>
                    {a.installment_amount ? fmt(a.installment_amount) : <span style={{ color: 'var(--theme-text3)' }}>—</span>}
                  </td>
                  <td style={{ textAlign: 'right', color: 'var(--theme-green-text)' }}>{fmt(repaid)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600, color: outstanding > OWED_EPS ? 'var(--theme-text1)' : 'var(--theme-text3)' }}>
                    {a.status === 'written_off' ? '—' : fmt(outstanding)}
                  </td>
                  <td style={{ color: 'var(--theme-text3)', fontSize: 12, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {a.purpose || '—'}
                  </td>
                  <td>
                    <span className={st.badge}>{st.label}</span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p style={{ fontSize: 12, color: 'var(--theme-text3)', margin: '8px 0 16px' }}>
        No interest is charged — what is issued is exactly what is recovered.
      </p>

      {/* Detail panel */}
      {selectedAdv && (
        <div className="card" style={{ padding: 20, marginBottom: 24 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--theme-text1)' }}>
                {empMap[selectedAdv.employee_id]?.full_name} — {selectedAdv.type === 'loan' ? 'Loan' : 'Advance'} of NPR {fmt(selectedAdv.amount)}
              </div>
              <div style={{ fontSize: 12, color: 'var(--theme-text3)', marginTop: 3 }}>
                Issued {fmtD(selectedAdv.issued_date)}
                {selectedAdv.purpose && ` · ${selectedAdv.purpose}`}
                {selectedAdv.installment_amount
                  ? ` · NPR ${fmt(selectedAdv.installment_amount)} cut from each salary`
                  : selectedAdv.status === 'active' ? ' · whole balance comes off the next salary' : ''}
                {selectedNextCut && selectedOutstanding > OWED_EPS && ` · Next salary cut: ${monthLabel(selectedNextCut.cut)} payroll`}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {selectedAdv.status === 'active' && selectedOutstanding > OWED_EPS && (
                <>
                  <button className="btn btn-ghost" style={{ fontSize: 12 }} disabled={!ready}
                    onClick={() => openRepay(selectedAdv, selectedOutstanding)}>
                    + Record Repayment
                  </button>
                  <Tip text="Forgive what is still owed. Payroll stops cutting it and Final Settlement will not recover it. Needs a reason, is logged, and can be reactivated." width={260}>
                    <button className="btn btn-ghost" style={{ fontSize: 12 }} disabled={!ready}
                      onClick={() => openWriteOff(selectedAdv)}>
                      Write off NPR {fmt(selectedOutstanding)}
                    </button>
                  </Tip>
                </>
              )}
              {selectedAdv.status === 'active' && selectedOutstanding <= OWED_EPS && (
                <Tip text="Nothing is owed, so this can be closed. Normally this happens on its own the moment the last repayment is recorded." width={240}>
                  <button className="btn btn-ghost" style={{ fontSize: 12, color: 'var(--theme-green-text)' }} disabled={!ready}
                    onClick={() => handleSettle(selectedAdv)}>
                    ✓ Settle
                  </button>
                </Tip>
              )}
              {selectedAdv.status === 'written_off' && (
                <button className="btn btn-ghost" style={{ fontSize: 12 }} disabled={!ready}
                  onClick={() => handleReactivate(selectedAdv, selectedOutstanding)}>
                  Reactivate
                </button>
              )}
              {/* Not on a written-off advance: its copy says the delete stops payroll deductions, which
                  are already stopped there — reactivate first. */}
              {ready && selectedReps.length === 0 && selectedAdv.status !== 'written_off' && (
                <button className="btn btn-ghost" style={{ fontSize: 12, color: 'var(--theme-red-text)' }}
                  onClick={() => handleDelete(selectedAdv.id)}>
                  Delete
                </button>
              )}
            </div>
          </div>

          {selectedAdv.status === 'written_off' && (
            <div style={{ fontSize: 13, color: 'var(--theme-text2)', marginBottom: 16, lineHeight: 1.6 }}>
              <span className="badge-gray" style={{ marginRight: 8 }}>Written off</span>
              {/* The balance is derived from the ledger; the stamped amount is shown only when a
                  Reopen has since moved the repayments under it, so the two cannot silently disagree. */}
              NPR {fmt(selectedOutstanding)} written off
              {selectedAdv.written_off_at ? ` on ${nepalBsLong(selectedAdv.written_off_at)}` : ''}
              {selectedAdv.written_off_by && profileNames[selectedAdv.written_off_by] ? ` by ${profileNames[selectedAdv.written_off_by]}` : ''}
              {selectedAdv.write_off_amount != null && Math.abs((parseFloat(selectedAdv.write_off_amount) || 0) - selectedOutstanding) > OWED_EPS
                ? ` (NPR ${fmt(selectedAdv.write_off_amount)} at the time of write-off)` : ''}.
              {selectedAdv.write_off_reason && <div style={{ color: 'var(--theme-text3)' }}>Reason: {selectedAdv.write_off_reason}</div>}
            </div>
          )}

          {/* Balance bar */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--theme-text3)', marginBottom: 4 }}>
              <span>Repaid: NPR {fmt(selectedRepaid)}</span>
              <span>{selectedAdv.status === 'written_off' ? 'Written off' : 'Outstanding'}: NPR {fmt(selectedOutstanding)}</span>
            </div>
            <div style={{ height: 6, borderRadius: 'var(--radius-full)', background: 'var(--theme-border)', overflow: 'hidden' }}>
              <div style={{
                width: '100%', height: '100%', borderRadius: 'var(--radius-full)',
                transform: `scaleX(${Math.min(100, (selectedRepaid / parseFloat(selectedAdv.amount)) * 100) / 100})`,
                transformOrigin: 'left',
                background: selectedOutstanding <= OWED_EPS ? 'var(--theme-green)' : 'var(--theme-accent)',
                transition: 'transform 0.3s',
              }} />
            </div>
          </div>

          {/* Repayment history */}
          {selectedReps.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--theme-text3)', padding: '8px 0' }}>No repayments recorded yet.</div>
          ) : (
            <div className="table-wrap">
              <table className="data-table" style={{ fontSize: 12 }}>
                <thead>
                  <tr>
                    <th>Date (BS)</th>
                    <th style={{ textAlign: 'right' }}>Amount</th>
                    <th><Tip text="Payroll: cut from a finalized payslip. Final Settlement: recovered when the employee left. Manual: entered on this page (cash or bank returned by the employee)." width={260}>Source</Tip></th>
                    <th>Notes</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {selectedReps.map(r => {
                    const src = sourceOf(r)
                    return (
                      <tr key={r.id}>
                        <td style={{ whiteSpace: 'nowrap' }}>{fmtD(r.repaid_date)}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-green-text)', fontWeight: 600, whiteSpace: 'nowrap' }}>NPR {fmt(r.amount)}</td>
                        <td style={{ color: 'var(--theme-text2)', whiteSpace: 'nowrap' }}>{SOURCE_LABEL[src]}</td>
                        <td style={{ color: 'var(--theme-text3)' }}>{r.notes || '—'}</td>
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                          {src === 'manual' ? (
                            selectedAdv.status === 'written_off' ? (
                              <Tip text="Reactivate the advance first — a written-off balance cannot change." width={220}>
                                <span style={{ color: 'var(--theme-text3)' }}><Lock size={13} aria-hidden="true" /></span>
                              </Tip>
                            ) : (
                              <button className="btn btn-ghost btn-sm" style={{ color: 'var(--theme-red-text)' }} disabled={!ready}
                                onClick={() => handleDeleteRepayment(selectedAdv, r, selectedOutstanding)}>
                                Delete
                              </button>
                            )
                          ) : (
                            <Tip text={src === 'payroll'
                              ? 'Recorded by payroll — reopen that payroll run to undo.'
                              : 'Recorded by Final Settlement — reopen that settlement to undo.'} width={220}>
                              <span style={{ color: 'var(--theme-text3)' }}><Lock size={13} aria-label="Locked" /></span>
                            </Tip>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Add Advance/Loan modal */}
      {showAdd && (
        <Modal onClose={() => { setShowAdd(false); setError('') }} title="Issue Advance / Loan" maxWidth={480}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

            <div>
              <label style={lbl} htmlFor="adv-employee">Employee</label>
              <SearchableSelect
                id="adv-employee"
                options={employees.filter(e => e.status === 'active' || e.status === 'probation').map(e => ({ value: e.id, label: `${e.full_name}${e.employee_code ? ` (${e.employee_code})` : ''}` }))}
                value={addForm.employee_id}
                onChange={v => setAdd('employee_id', v)}
                placeholder="Select employee…"
                invalid={fieldErr['adv-employee']}
              />
              <FieldError id="adv-employee" message={fieldErr['adv-employee']} />
            </div>

            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 180 }}>
                <label style={lbl} htmlFor="adv-type">Type</label>
                <select id="adv-type" className="form-select" value={addForm.type} onChange={e => setAdd('type', e.target.value)}>
                  <option value="advance">One-time advance</option>
                  <option value="loan">Loan, in instalments</option>
                </select>
              </div>
              <div style={{ flex: 1, minWidth: 180 }}>
                <label style={lbl} htmlFor="adv-issued-date">Issued Date (BS)</label>
                <BsCalendarPicker id="adv-issued-date" value={addForm.issued_date} onChange={v => setAdd('issued_date', v)} placeholder="Select date" clearable invalid={fieldErr['adv-issued-date']} />
                <FieldError id="adv-issued-date" message={fieldErr['adv-issued-date']} />
                <div style={hint}>{recoveryHint(addForm.issued_date)}</div>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 180 }}>
                <label style={lbl} htmlFor="adv-amount"><Tip text="Total amount issued to the employee." width={200}>Amount (NPR)</Tip></label>
                <input id="adv-amount" style={invalidStyle(inp, fieldErr['adv-amount'])} type="number" min="1" placeholder="e.g. 20000" value={addForm.amount} onChange={e => setAdd('amount', e.target.value)} {...fieldAria('adv-amount', fieldErr['adv-amount'])} />
                <FieldError id="adv-amount" message={fieldErr['adv-amount']} />
              </div>
              <div style={{ flex: 1, minWidth: 180 }}>
                <label style={lbl} htmlFor="adv-installment">
                  <Tip text="How much payroll CUTS from this person's salary each month until it is paid back — it is a real deduction, not a reminder. Example: NPR 20,000 at NPR 5,000 a month comes off four salaries. Never more than that month's pay; anything left waits for the next salary." width={280}>
                    Installment / Month (NPR){addForm.type === 'loan' ? '' : ' — optional'}
                  </Tip>
                </label>
                <input id="adv-installment" style={invalidStyle(inp, fieldErr['adv-installment'])} type="number" min="1" placeholder="e.g. 5000" value={addForm.installment_amount} onChange={e => setAdd('installment_amount', e.target.value)} {...fieldAria('adv-installment', fieldErr['adv-installment'])} />
                <FieldError id="adv-installment" message={fieldErr['adv-installment']} />
                {!fieldErr['adv-installment'] && addInstBlank && addForm.type === 'advance' && (
                  <div style={hint}>
                    Left blank, the whole {addAmount > 0 ? `NPR ${fmt(addAmount)}` : 'amount'} comes off the next salary (never more than the pay that month; the rest waits).
                  </div>
                )}
              </div>
            </div>

            <div>
              <label style={lbl} htmlFor="adv-purpose">Purpose</label>
              <input id="adv-purpose" style={inp} placeholder="e.g. Medical emergency, festival advance…" value={addForm.purpose} onChange={e => setAdd('purpose', e.target.value)} />
            </div>

            <div>
              <label style={lbl} htmlFor="adv-notes">Notes</label>
              <textarea id="adv-notes" style={{ ...inp, height: 60, resize: 'vertical' }} placeholder="Optional internal notes" value={addForm.notes} onChange={e => setAdd('notes', e.target.value)} />
            </div>

            {error && <div role="alert" style={{ fontSize: 12, color: 'var(--theme-red-text)' }}>{error}</div>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => { setShowAdd(false); setError('') }}>Cancel</button>
              <button className="btn btn-primary" onClick={handleAdd} disabled={saving || !ready}>{saving ? 'Saving…' : 'Issue'}</button>
            </div>
          </div>
        </Modal>
      )}

      {/* Record Repayment modal */}
      {showRepay && selectedAdv && (
        <Modal onClose={() => { setShowRepay(false); setError('') }} title="Record Repayment" maxWidth={400}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ fontSize: 13, color: 'var(--theme-text3)' }}>
              {empMap[selectedAdv.employee_id]?.full_name} · Outstanding: NPR {fmt(selectedOutstanding)}
            </div>
            <div style={{ fontSize: 12, color: 'var(--theme-text2)' }}>
              Salary cuts are recorded automatically when payroll is finalized — don&apos;t enter them here.
              Use this for money the employee paid back in cash or by bank.
            </div>

            <div>
              <label style={lbl} htmlFor="adv-repay-date">Repayment Date (BS)</label>
              <BsCalendarPicker id="adv-repay-date" value={repayForm.repaid_date} onChange={v => setRepay('repaid_date', v)} placeholder="Select date" clearable invalid={fieldErr['adv-repay-date']} />
              <FieldError id="adv-repay-date" message={fieldErr['adv-repay-date']} />
            </div>

            <div>
              <label style={lbl} htmlFor="adv-repay-amount"><Tip text="Up to what is still owed. Paying it all marks the advance settled." width={220}>Amount (NPR)</Tip></label>
              <input id="adv-repay-amount" style={invalidStyle(inp, fieldErr['adv-repay-amount'])} type="number" min="1" max={selectedOutstanding} placeholder={`Up to ${fmt(selectedOutstanding)}`} value={repayForm.amount} onChange={e => setRepay('amount', e.target.value)} {...fieldAria('adv-repay-amount', fieldErr['adv-repay-amount'])} />
              <FieldError id="adv-repay-amount" message={fieldErr['adv-repay-amount']} />
            </div>

            <div>
              <label style={lbl} htmlFor="adv-repay-notes">Notes</label>
              <input id="adv-repay-notes" style={inp} placeholder="e.g. Cash returned by employee" value={repayForm.notes} onChange={e => setRepay('notes', e.target.value)} />
            </div>

            {error && <div role="alert" style={{ fontSize: 12, color: 'var(--theme-red-text)' }}>{error}</div>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => { setShowRepay(false); setError('') }}>Cancel</button>
              <button className="btn btn-primary" onClick={handleRepay} disabled={saving || !ready}>{saving ? 'Saving…' : 'Record'}</button>
            </div>
          </div>
        </Modal>
      )}

      {/* Write-off confirmation */}
      {writeOff && (() => {
        const adv = writeOff.adv
        const emp = empMap[adv.employee_id]
        const owed = Math.max(0, parseFloat(adv.amount) - (repayMap[adv.id]?.total || 0))
        return (
          <ConfirmModal
            title={`Write off NPR ${fmt(owed)}?`}
            confirmLabel={`Write off NPR ${fmt(owed)}`} danger busy={writeOff.busy} busyLabel="Writing off…"
            onConfirm={confirmWriteOff}
            onCancel={() => setWriteOff(null)}
          >
            <p style={{ margin: '0 0 12px' }}>
              {emp ? `${emp.full_name} will no longer owe` : 'The employee will no longer owe'} the NPR {fmt(owed)} left on
              this {adv.type === 'loan' ? 'loan' : 'advance'}. Payroll stops cutting it from salary, Final Settlement will not
              recover it when they leave, and the write-off is logged with your name and the reason. You can reactivate it
              later if the money does come back.
            </p>
            <label style={lbl} htmlFor="adv-writeoff-reason">Reason (required)</label>
            <textarea id="adv-writeoff-reason" style={{ ...invalidStyle(inp, writeOff.err), height: 70, resize: 'vertical' }}
              placeholder="e.g. Employee left without notice; balance agreed as a hardship grant"
              value={writeOff.reason} disabled={writeOff.busy}
              onChange={e => { const v = e.target.value; setWriteOff(w => ({ ...w, reason: v, err: '' })) }}
              {...fieldAria('adv-writeoff-reason', writeOff.err)} />
            <FieldError id="adv-writeoff-reason" message={writeOff.err} />
          </ConfirmModal>
        )
      })()}
      {confirmEl}
    </div>
  )
}
