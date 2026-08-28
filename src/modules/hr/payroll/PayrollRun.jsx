import { useState, useEffect } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'
import Modal from '../../../components/Modal'
import ConfirmModal from '../../../components/ConfirmModal'
import { BS_MONTHS } from '../../../utils/bsCalendar'
import { computePayslip } from './payrollCompute'
import { computeMonthlyTds } from './tds'
import { fetchYtdMap, fetchApprovedTadaMap, buildAdvanceMap, payslipDrift } from './payrollData'
import PayslipBody from './PayslipBody'
import { printWithTitle } from '../../../utils/printTitle'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'
import { firstError } from '../../../shared/queryError'
import { errorText } from '../../../shared/errorText'

const fmt = n => Math.round(n || 0).toLocaleString('en-NP')

const inp = {
  background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)', borderRadius: 6,
  padding: '6px 8px', fontSize: 13, color: 'var(--theme-text1)', outline: 'none', fontFamily: 'inherit',
}

export default function PayrollRun() {
  const { clientId, hasHrAccess } = useAuth()
  const { scopedFrom, scopedInsert, scopedUpdate, scopedDelete } = useScopedDb()
  const periodReq = useLatestRequest()
  const [periods,    setPeriods]    = useState([])
  const [period,     setPeriod]     = useState(null)
  const [run,        setRun]        = useState(null)
  const [payslips,   setPayslips]   = useState([])
  const [employees,  setEmployees]  = useState([])
  const [components, setComponents] = useState([])
  const [attendance, setAttendance] = useState([])
  const [otEntries,  setOtEntries]  = useState([])
  const [advances,   setAdvances]   = useState([])
  const [repayments, setRepayments] = useState([])
  const [loading,    setLoading]    = useState(true)
  const [busy,       setBusy]       = useState(false)
  const [msg,        setMsg]        = useState('')
  // Which consequential action is awaiting its ConfirmModal: null | 'regenerate' | 'finalize'
  // | 'reopen'. These three all write to other ledgers (payslips, advance repayments, TADA), so
  // their confirms carry consequence copy in the product's own Modal, not window.confirm (S575).
  const [confirmAction, setConfirmAction] = useState(null)
  // Loaded on every page load, not just inside generate()/regenerate(), so the draft on screen can
  // be compared against a live recomputation. Without them this page could only ever show what was
  // stored at Generate time and had no way to know it had since gone stale.
  const [ytdMap,     setYtdMap]     = useState({})
  const [tadaMap,    setTadaMap]    = useState({})
  const [viewSlip,   setViewSlip]   = useState(null)
  const [printSlip,  setPrintSlip]  = useState(null)
  // Company letterhead for the payslip — a payslip with no employer identity on it at all is
  // missing the single most basic thing a pay document is expected to have. Same source fields
  // Tax Invoice already prints (settings.vat_number is Nepal's PAN, reused as-is — not a new ID).
  const [bizInfo, setBizInfo] = useState({ name: '', address: '', vatNumber: '' })

  const empMap = Object.fromEntries(employees.map(e => [e.id, e]))

  useEffect(() => {
    if (!clientId) return
    Promise.all([
      supabase.from('clients').select('name').eq('id', clientId).single(),
      supabase.from('settings').select('property_address, vat_number').eq('client_id', clientId).maybeSingle(),
    ]).then(([{ data: client }, { data: settings }]) => {
      setBizInfo({ name: client?.name || '', address: settings?.property_address || '', vatNumber: settings?.vat_number || '' })
    })
  }, [clientId])

  useEffect(() => {
    if (!clientId) return
    async function init() {
      setLoading(true)
      const { data: p } = await scopedFrom('monthly_periods')
        .order('bs_year', { ascending: false }).order('bs_month', { ascending: false })
      setPeriods(p || [])
      const open = (p || []).find(x => x.status === 'open') || (p || [])[0]
      if (open) { setPeriod(open); await loadAll(open.id, open.bs_year, open.bs_month) }
      setLoading(false)
    }
    init()
  }, [clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function loadAll(periodId, bsYear, bsMonth) {
    const results = await Promise.all([
      scopedFrom('hr_payroll_runs').eq('period_id', periodId).maybeSingle(),
      scopedFrom('hr_employees', 'id, full_name, employee_code, pay_basis, basic_salary, ssf_no, ssf_enrolled, life_insurance_premium, health_insurance_premium, marital_status, department, status, join_date, end_date')
        .in('status', ['active', 'probation']).order('full_name'),
      scopedFrom('hr_salary_components'),
      // Paged: hr_attendance is one row per employee PER DAY, so a period holds staff × ~30 rows
      // and crosses PostgREST's silent 1000-row cap at ~34 staff. A truncated read here doesn't
      // fail loudly — it just makes the employees past the cutoff look like they have no
      // attendance at all, which pays daily/hourly staff ZERO and pays monthly staff a full month
      // with no absence deduction. The old query had no ORDER BY either, so which employees got
      // cut was arbitrary and could differ between two runs of the same period (S529).
      fetchAllRows(() => scopedFrom('hr_attendance').eq('period_id', periodId).order('id')),
      // bs_day is load-bearing, not display data: computePayslip uses it to suppress
      // attendance-sheet OT on days an approved entry already covers (approved supersedes).
      scopedFrom('hr_overtime_entries', 'employee_id, bs_day, ot_hours, ot_type')
        .eq('bs_year', bsYear).eq('bs_month', bsMonth).eq('status', 'approved'),
      // Paged. Both are UNFILTERED lifetime ledgers — every advance the client has ever issued
      // and every repayment ever recorded against one — so unlike the period-scoped reads above
      // they grow without bound and cross the silent 1000-row cap on their own. buildAdvanceMap
      // derives outstanding as (amount − repaid), so a truncated repayments read makes advances
      // look LESS repaid than they are and over-deducts from take-home pay; a truncated advances
      // read drops the deduction entirely. `.order('issued_date')` is not unique — several
      // advances share a date — so `.order('id')` is appended as the tiebreaker fetchAllRows
      // requires, or paging repeats rows on one page and skips them on the next.
      fetchAllRows(() => scopedFrom('hr_advances').order('issued_date').order('id')),
      fetchAllRows(() => scopedFrom('hr_advance_repayments').order('id')),
    ])
    if (!periodReq.isCurrent(periodId)) return   // superseded by a newer period selection
    // A failed read is not an empty month. Every one of these feeds pay: no attendance rows pays
    // daily/hourly staff zero and monthly staff a full month with no absence deduction, and no
    // advances/repayments drops or inflates a deduction — all of it looking like a complete,
    // ordinary payroll. Surfaced and abandoned rather than rendered (S594's rule).
    const failed = firstError(results)
    if (failed) {
      setMsg('error:' + errorText(failed, 'operator'))
      setEmployees([]); setPayslips([]); setRun(null)
      return
    }
    const [
      { data: runRow }, { data: emps }, { data: comps }, { data: att }, { data: ot },
      { data: advs },   { data: reps },
    ] = results
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
      // Only a saved run needs the freshness comparison; with no run there is nothing to be
      // stale against, and these two are the page's only extra round trips.
      const periodObj = { id: periodId, bs_year: bsYear, bs_month: bsMonth }
      const maps = await Promise.all([
        fetchYtdMap(scopedFrom, periodObj),
        fetchApprovedTadaMap(scopedFrom, periodObj),
      ])
      if (!periodReq.isCurrent(periodId)) return   // superseded by a newer period selection
      // These two drive the freshness comparison. Falling back to empty maps would recompute every
      // employee's TDS as if this were month 1 of the fiscal year, so the live figures would differ
      // from the stored ones and the whole run would report itself stale — a false Regenerate
      // prompt whose fix would then write those wrong figures in.
      const mapsFailed = firstError(maps)
      if (mapsFailed) { setMsg('error:' + errorText(mapsFailed, 'operator')); return }
      setYtdMap(maps[0].data); setTadaMap(maps[1].data)
    } else {
      setPayslips([])
      setYtdMap({}); setTadaMap({})
    }
  }

  async function handlePeriodChange(id) {
    periodReq.begin(id)   // claim the page before any await
    const p = periods.find(x => x.id === id); if (!p) return
    setPeriod(p); setMsg(''); setLoading(true)
    await loadAll(id, p.bs_year, p.bs_month); setLoading(false)
  }

  function buildRows(runId, ytdMap, tadaMap) {
    const advMap = buildAdvanceMap(advances, repayments)
    return employees.map(emp => {
      const comps        = components.filter(c => c.employee_id === emp.id)
      const att          = attendance.filter(a => a.employee_id === emp.id)
      const empOtEntries = otEntries.filter(e => e.employee_id === emp.id)
      const advDed       = Math.round(advMap[emp.id] || 0)
      // `breakdown` is Calculation-page-only (not a hr_payslips column) — dropped before insert.
      const { breakdown, ...slip } = computePayslip(emp, comps, att, period, 0, empOtEntries, advDed)
      // Same gate computePayslip applies: no registration number means no SSF contribution, so
      // this employee is not an SSF contributor for tax purposes either and the 1% first-slab
      // waiver must not apply. Letting the two disagree would tax against a deduction never made.
      const isSsf    = !!(emp.ssf_enrolled && String(emp.ssf_no || '').trim())
      const isMarried = emp.marital_status === 'married'
      const ytd   = ytdMap[emp.id] || { gross: 0, ssf: 0, withheld: 0, count: 0 }
      const tds   = computeMonthlyTds({
        period,
        // Actual income earned this month, not contractual gross — Nepal's Income Tax Act
        // withholds TDS on remuneration actually paid, and absence_deduction is exactly the
        // portion of gross this employee never received (forfeited unpaid days). SSF just below
        // already uses the same absence-adjusted base (ssfBase); TDS previously didn't (S365).
        // OT pay is taxable remuneration too and must be included, not just added post-tax.
        monthlyGross:          slip.gross - slip.absence_deduction + slip.ot_amount,
        monthlySsf:            slip.ssf_employee,
        ytdGross:              ytd.gross,
        ytdSsf:                ytd.ssf,
        ytdWithheld:           ytd.withheld,
        // Actual count of prior finalized months this FY — lets a mid-year joiner's tax spread
        // over the months they'll actually work instead of being front-loaded (see tds.js).
        ytdMonths:             ytd.count,
        isSsf,
        isMarried,
        annualLifeInsurance:   parseFloat(emp.life_insurance_premium) || 0,
        annualHealthInsurance: parseFloat(emp.health_insurance_premium) || 0,
      })
      const tada = tadaMap[emp.id] || { total: 0, ids: [] }
      const tadaAmount = Math.round(tada.total)
      const net = slip.net_pay - tds + tadaAmount
      return { run_id: runId, employee_id: emp.id, ...slip, tds, tada_amount: tadaAmount, tada_claim_ids: tada.ids, net_pay: net }
    })
  }

  // Live-vs-stored freshness check. The draft on this page is a snapshot taken at Generate time,
  // so approving overtime, editing attendance or approving a TADA claim afterwards leaves it
  // quietly wrong — and Finalize locks whatever is on screen. `/hr/calculation` has always
  // detected this; the detection just lived on a page nobody has to visit before finalizing.
  // Deliberately reuses buildRows (the same function Generate persists from) rather than
  // reimplementing the arithmetic — a second copy could drift and report false confidence.
  const freshness = (() => {
    if (!run || run.status === 'finalized' || employees.length === 0 || payslips.length === 0) {
      return { stale: [], missing: [], departed: [], overridden: [], ok: true }
    }
    let live
    try { live = buildRows(run.id, ytdMap, tadaMap) } catch { return { stale: [], missing: [], departed: [], overridden: [], ok: true } }
    const storedByEmp = Object.fromEntries(payslips.map(s => [s.employee_id, s]))
    const stale = [], missing = [], overridden = []
    live.forEach(row => {
      const stored = storedByEmp[row.employee_id]
      if (!stored) { missing.push(row.employee_id); return }
      // Compares the INPUTS, not net_pay — see payslipDrift's header for why the old net_pay
      // comparison made an intended TDS override indistinguishable from real staleness, and
      // deadlocked Finalize against Regenerate. An override is reported, never blocking.
      const drift = payslipDrift(stored, row)
      if (drift === 'moved') { stale.push(row.employee_id); return }
      if (drift === 'overridden') overridden.push(row.employee_id)
    })
    // A third bucket: a payslip that exists in this run for someone who is no longer live.
    //
    // `live` only contains active/probation employees, so a stored payslip for someone since
    // settled or deactivated matched nothing above and the run reported itself fresh — while
    // Regenerate hard-deletes every payslip and re-inserts only the live ones, destroying an
    // already-issued payslip with no warning. Final Settlement stamping an employee on Finalize
    // is exactly what creates this state (S600).
    const liveIds = new Set(live.map(r => r.employee_id))
    const departed = payslips.filter(s => !liveIds.has(s.employee_id)).map(s => s.employee_id)
    // Deliberately NOT part of `ok`. A departed employee's payslip is legitimate — they worked
    // part of the month — so finalizing the run WITH it is the correct outcome. Blocking finalize
    // on it would strand the run: Regenerate destroys the payslip, Finalize refuses, and there is
    // no third move. It gates Regenerate instead, below.
    return { stale, missing, departed, overridden, ok: stale.length === 0 && missing.length === 0 }
  })()

  const nameOf = id => empMap[id]?.full_name || 'Unknown'

  async function generate() {
    if (!period || employees.length === 0) return
    setBusy(true); setMsg('')
    // Checked BEFORE anything is written. These maps decide the TDS on every payslip this inserts,
    // and an empty YTD map is a legitimate-looking value (a fiscal year's first month), so a failed
    // read here does not fail — it persists under-withheld tax that nothing later recomputes.
    const maps = await Promise.all([fetchYtdMap(scopedFrom, period), fetchApprovedTadaMap(scopedFrom, period)])
    const mapsFailed = firstError(maps)
    if (mapsFailed) { setMsg('error:' + errorText(mapsFailed, 'operator')); setBusy(false); return }
    const [{ data: ytdMap }, { data: tadaMap }] = maps
    const { data: runRow, error: rErr } = await scopedInsert('hr_payroll_runs', { period_id: period.id, status: 'draft' }, { single: true })
    if (rErr) { setMsg('error:' + rErr.message); setBusy(false); return }
    const { error: pErr } = await scopedInsert('hr_payslips', buildRows(runRow.id, ytdMap, tadaMap))
    if (pErr) { setMsg('error:' + pErr.message); setBusy(false); return }
    await loadAll(period.id, period.bs_year, period.bs_month)
    setMsg('ok:Payroll generated'); setBusy(false)
  }

  async function regenerate() {
    if (!run || run.status === 'finalized') return
    // The departed-payslip warning lives in the regenerate ConfirmModal's own body below (S612) —
    // it used to be a second window.confirm raised on top of that modal's confirm, so the same
    // action asked twice through two different kinds of dialog.
    setConfirmAction(null)
    setBusy(true); setMsg('')
    // Checked before the DELETE below, not after. Regenerate hard-deletes every payslip in the run
    // and re-inserts from these maps, so a failed read reached after the delete would leave the run
    // rebuilt on empty YTD — or, if the insert then also failed, emptied outright.
    const maps = await Promise.all([fetchYtdMap(scopedFrom, period), fetchApprovedTadaMap(scopedFrom, period)])
    const mapsFailed = firstError(maps)
    if (mapsFailed) { setMsg('error:' + errorText(mapsFailed, 'operator')); setBusy(false); return }
    const [{ data: ytdMap }, { data: tadaMap }] = maps
    await scopedDelete('hr_payslips').eq('run_id', run.id)
    const { error } = await scopedInsert('hr_payslips', buildRows(run.id, ytdMap, tadaMap))
    if (error) { setMsg('error:' + error.message); setBusy(false); return }
    await loadAll(period.id, period.bs_year, period.bs_month)
    setMsg('ok:Recomputed'); setBusy(false)
  }

  async function updateTds(slip, value) {
    if (run?.status === 'finalized') return
    const tds = parseFloat(value) || 0
    const net = slip.gross + slip.ot_amount - slip.absence_deduction - slip.ssf_employee - slip.other_deductions - (slip.advance_deduction || 0) - tds + (slip.tada_amount || 0)
    setPayslips(ps => ps.map(s => s.id === slip.id ? { ...s, tds, net_pay: net } : s))
    await scopedUpdate('hr_payslips', { tds, net_pay: net }).eq('id', slip.id)
  }

  // TADA (travel/daily allowance) is a non-taxable reimbursement — added after TDS,
  // not run through gross/tax computation like the rest of the payslip.
  async function updateTada(slip, value) {
    if (run?.status === 'finalized') return
    const tada = parseFloat(value) || 0
    const net = slip.gross + slip.ot_amount - slip.absence_deduction - slip.ssf_employee - slip.other_deductions - (slip.advance_deduction || 0) - slip.tds + tada
    setPayslips(ps => ps.map(s => s.id === slip.id ? { ...s, tada_amount: tada, net_pay: net } : s))
    await scopedUpdate('hr_payslips', { tada_amount: tada, net_pay: net }).eq('id', slip.id)
  }

  // The ask half of Finalize. When the draft is stale, finalize()'s own refusal path runs
  // immediately (it alerts with the named employees and returns before any write); otherwise the
  // ConfirmModal opens with the consequence summary and its onConfirm calls finalize().
  function requestFinalize() {
    if (!run) return
    if (!freshness.ok) { finalize(); return }
    setConfirmAction('finalize')
  }

  async function finalize() {
    if (!run) return

    // Refuse outright while the draft disagrees with a live recomputation. This is the one
    // irreversible action in the module (Reopen exists, but payslips have been issued by then),
    // and the failure it prevents is silent: the numbers look complete and are simply out of date.
    // Regenerate is one click away and non-destructive, so there is no reason to allow the
    // override that a "proceed anyway" branch would offer.
    if (!freshness.ok) {
      const staleNames   = freshness.stale.map(nameOf)
      const missingNames = freshness.missing.map(nameOf)
      const lines = [
        'This payroll cannot be finalized yet — it no longer matches the current attendance, overtime and TADA data.',
        '',
        staleNames.length   ? `Figures changed since Generate (${staleNames.length}): ${staleNames.slice(0, 8).join(', ')}${staleNames.length > 8 ? `, +${staleNames.length - 8} more` : ''}` : '',
        missingNames.length ? `Employees with no payslip in this run (${missingNames.length}): ${missingNames.slice(0, 8).join(', ')}${missingNames.length > 8 ? `, +${missingNames.length - 8} more` : ''}` : '',
        '',
        'Click Regenerate to rebuild the draft from current data, then finalize.',
      ].filter(Boolean)
      window.alert(lines.join('\n'))
      return
    }

    // The consequence summary (payslip count, net total, ledger side-effects) lives in the
    // ConfirmModal rendered below — those are real writes to other ledgers, so the ask is a
    // proper dialog, not window.confirm. This function is only ever reached from its onConfirm
    // (requestFinalize gates the button), so it commits directly.
    setConfirmAction(null)
    setBusy(true)

    // Build per-advance repaid totals, excluding any prior auto-entries for this run
    // (idempotent: on re-finalize after reopen, exclude stale rows we're about to replace)
    const repaidMap = {}
    repayments.filter(r => r.payroll_run_id !== run.id).forEach(r => {
      repaidMap[r.advance_id] = (repaidMap[r.advance_id] || 0) + (parseFloat(r.amount) || 0)
    })

    // Build auto-repayment rows and track which advances become fully settled
    const repayRows = []
    const settleIds = []
    const today = new Date().toISOString().split('T')[0]
    const monthLabel = `${BS_MONTHS[period.bs_month - 1]} ${period.bs_year} payroll`

    for (const slip of payslips) {
      if (!slip.advance_deduction || slip.advance_deduction <= 0) continue
      const empAdvs = advances.filter(a => a.employee_id === slip.employee_id && a.status === 'active')
      let remaining = slip.advance_deduction

      for (const adv of empAdvs) {
        if (remaining <= 0) break
        const repaid = repaidMap[adv.id] || 0
        const outstanding = Math.max(0, parseFloat(adv.amount) - repaid)
        if (outstanding <= 0) continue
        const installment = parseFloat(adv.installment_amount) || outstanding
        const thisPayment = Math.min(Math.min(installment, outstanding), remaining)
        repayRows.push({
          advance_id: adv.id,
          employee_id: slip.employee_id,
          repaid_date: today,
          amount: thisPayment,
          notes: monthLabel,
          payroll_run_id: run.id,
        })
        if (repaid + thisPayment >= parseFloat(adv.amount) - 0.01) settleIds.push(adv.id)
        remaining -= thisPayment
      }
    }

    // TADA claims auto-filled into a payslip get marked Paid so the same trip is never
    // reimbursed both through TADA Claims and through this payroll run. Skipped for any
    // payslip where the clerk zeroed TADA back out — those claims stay Approved, unpaid.
    const tadaClaimIds = []
    payslips.forEach(s => {
      if ((s.tada_amount || 0) > 0 && Array.isArray(s.tada_claim_ids)) tadaClaimIds.push(...s.tada_claim_ids)
    })

    await scopedUpdate('hr_payroll_runs', { status: 'finalized', finalized_at: new Date().toISOString() }).eq('id', run.id)
    // Idempotent: delete prior auto-repayments for this run, then re-insert
    await scopedDelete('hr_advance_repayments').eq('payroll_run_id', run.id)
    if (repayRows.length > 0) {
      await scopedInsert('hr_advance_repayments', repayRows)
    }
    if (settleIds.length > 0) {
      await scopedUpdate('hr_advances', { status: 'settled' }).in('id', settleIds)
    }
    if (tadaClaimIds.length > 0) {
      await scopedUpdate('hr_tada_claims', { status: 'paid', paid_at: new Date().toISOString(), paid_method: 'Payroll' })
        .in('id', tadaClaimIds).eq('status', 'approved')
    }

    await loadAll(period.id, period.bs_year, period.bs_month)
    const suffix = repayRows.length > 0 ? ` — ${repayRows.length} advance repayment(s) auto-recorded` : ''
    setMsg('ok:Finalized' + suffix)
    setBusy(false)
  }

  async function reopen() {
    if (!run) return
    setConfirmAction(null)
    setBusy(true)

    // Which advances did THIS run touch? Read them off its own tagged rows before deleting them —
    // this is the only record of what it settled.
    //
    // The reactivation below used to consider every settled advance in the client, filtered only
    // on "has an outstanding balance now". That was survivable while payroll was the sole writer
    // of repayment rows. It stopped being safe once Final Settlement began writing them too
    // (S600): reopening a payroll run could reactivate an advance a settlement had closed and
    // already deducted in full, handing a departed employee a live loan and silently invalidating
    // the settlement's frozen figure. Scoped to this run's own advances, that cannot happen.
    const { data: ownReps } = await scopedFrom('hr_advance_repayments', 'advance_id').eq('payroll_run_id', run.id)
    const touchedIds = [...new Set((ownReps || []).map(r => r.advance_id))]

    await scopedDelete('hr_advance_repayments').eq('payroll_run_id', run.id)

    if (touchedIds.length > 0) {
      const { data: updatedReps } = await scopedFrom('hr_advance_repayments', 'advance_id, amount').in('advance_id', touchedIds)
      const updatedRepaidMap = {}
      ;(updatedReps || []).forEach(r => {
        updatedRepaidMap[r.advance_id] = (updatedRepaidMap[r.advance_id] || 0) + (parseFloat(r.amount) || 0)
      })
      const reactivateIds = advances
        .filter(a => touchedIds.includes(a.id) && a.status === 'settled')
        .filter(a => Math.max(0, parseFloat(a.amount) - (updatedRepaidMap[a.id] || 0)) > 0.01)
        .map(a => a.id)
      if (reactivateIds.length > 0) {
        await scopedUpdate('hr_advances', { status: 'active' }).in('id', reactivateIds)
      }
    }

    // Revert TADA claims this run auto-marked Paid — but only ones marked paid BY payroll,
    // never a claim a manager separately paid by hand via TADA Claims.
    const tadaClaimIds = []
    payslips.forEach(s => {
      if (Array.isArray(s.tada_claim_ids) && s.tada_claim_ids.length > 0) tadaClaimIds.push(...s.tada_claim_ids)
    })
    if (tadaClaimIds.length > 0) {
      await scopedUpdate('hr_tada_claims', { status: 'approved', paid_at: null, paid_method: null })
        .in('id', tadaClaimIds).eq('paid_method', 'Payroll')
    }

    await scopedUpdate('hr_payroll_runs', { status: 'draft', finalized_at: null }).eq('id', run.id)
    await loadAll(period.id, period.bs_year, period.bs_month)
    setMsg('ok:Reopened'); setBusy(false)
  }

  function printPayslip(slip, emp) {
    setPrintSlip({ slip, emp })
    setTimeout(() => { printWithTitle(`Payslip - ${emp.full_name} - ${periodLabel}`); setPrintSlip(null) }, 60)
  }

  async function exportExcel() {
    const XLSX = await import('xlsx')
    const rows = payslips.map(s => {
      const emp = empMap[s.employee_id] || {}
      return {
        'Employee': emp.full_name || '', 'Code': emp.employee_code || '', 'Pay Basis': s.pay_basis,
        'Basic/Rate': s.basic, 'Allowances': s.allowances, 'Gross': s.gross,
        'Present Days': s.present_days, 'Absent Days': s.absent_days,
        'OT Hours': s.ot_hours, 'OT Amount': s.ot_amount,
        'Absence Ded': s.absence_deduction, 'SSF Employee': s.ssf_employee,
        'Other Ded': s.other_deductions, 'Advance Ded': s.advance_deduction || 0,
        'TDS': s.tds, 'TADA': s.tada_amount || 0, 'Net Pay': s.net_pay,
        'SSF Employer': s.ssf_employer,
      }
    })
    const ws = XLSX.utils.json_to_sheet(rows)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Payroll')
    const label = period ? `${BS_MONTHS[period.bs_month - 1]}-${period.bs_year}` : ''
    XLSX.writeFile(wb, `payroll_${label}.xlsx`)
  }

  const periodLabel = period ? `${BS_MONTHS[period.bs_month - 1]} ${period.bs_year}` : '—'
  const finalized = run?.status === 'finalized'
  const totals = payslips.reduce((a, s) => {
    a.gross  += s.gross; a.ot += s.ot_amount; a.ssfEmp += s.ssf_employee; a.ssfEmpr += s.ssf_employer
    a.advDed += s.advance_deduction || 0
    a.ded    += s.absence_deduction + s.other_deductions
    a.tds    += s.tds || 0
    a.tada   += s.tada_amount || 0
    a.net    += s.net_pay
    return a
  }, { gross: 0, ot: 0, ssfEmp: 0, ssfEmpr: 0, ded: 0, advDed: 0, tds: 0, tada: 0, net: 0 })

  if (!hasHrAccess('manager')) return <Navigate to="/dashboard" replace />

  return (
    <div>
      <div className={printSlip ? 'no-print' : ''}>
        <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <h1 className="page-title">Payroll</h1>
            <p className="page-subtitle">
              Monthly payroll run — {periodLabel}
              {run && <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 700, color: finalized ? 'var(--theme-green-text)' : 'var(--theme-accent-ink)', background: `color-mix(in srgb, ${finalized ? 'var(--theme-green)' : 'var(--theme-accent)'} 10%, transparent)`, border: `1px solid color-mix(in srgb, ${finalized ? 'var(--theme-green)' : 'var(--theme-accent)'} 20%, transparent)`, padding: '2px 8px', borderRadius: 10 }}>{finalized ? 'Finalized' : 'Draft'}</span>}
            </p>
          </div>
          <div style={{ display: 'flex', gap: 20, alignItems: 'center', flexWrap: 'wrap' }}>
            <select aria-label="Period" className="form-select" value={period?.id || ''} onChange={e => handlePeriodChange(e.target.value)}>
              {periods.map(p => <option key={p.id} value={p.id}>{BS_MONTHS[p.bs_month - 1]} {p.bs_year} {p.status === 'open' ? '(open)' : ''}</option>)}
            </select>
            {run && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button className="btn btn-ghost" onClick={exportExcel} style={{ fontSize: 12 }}>⬇ Export</button>
                {!finalized && <button className="btn btn-ghost" onClick={() => setConfirmAction('regenerate')} disabled={busy} style={{ fontSize: 12 }}>↻ Regenerate</button>}
                {!finalized && <button className="btn btn-primary" onClick={requestFinalize} disabled={busy} style={{ fontSize: 12 }}>Finalize</button>}
                {/* hasHrAccess('manager'), not isAdmin: `isAdmin` is the Crest platform OPERATOR, while
                    the tenant's own Owner is `isOwner`; both resolve hrRole to 'manager'. Gating on
                    isAdmin therefore locked the one person accountable for this payroll out of
                    reopening it, for a correction they would have to phone support to get. The page
                    is already manager-gated and the confirmation below states what reopening
                    reverses (advance repayments, TADA closures). Same change in FestivalAllowance
                    and IncentiveRun. */}
                {finalized && hasHrAccess('manager') && <button className="btn btn-ghost" onClick={() => setConfirmAction('reopen')} disabled={busy} style={{ fontSize: 12 }}>Reopen</button>}
              </div>
            )}
            {msg && <span role={msg.startsWith('ok') ? 'status' : 'alert'} style={{ fontSize: 12, color: msg.startsWith('ok') ? 'var(--theme-green-text)' : 'var(--theme-red-text)', marginLeft: 'auto' }}>{msg.split(':').slice(1).join(':')}</span>}
          </div>
        </div>

        {/* Stale-draft warning. Finalize refuses while this is showing, but the refusal alone
            would only be discovered at the moment of committing — this states the problem, names
            who it affects and points at the one-click fix beforehand. */}
        {!loading && (!freshness.ok || freshness.departed?.length > 0) && (
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
              ⚠ This draft is out of date — Regenerate before finalizing
            </p>
            <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--theme-text2)' }}>
              {freshness.stale.length > 0 && (
                <>Attendance, overtime or TADA changed since this run was generated, so{' '}
                  <strong style={{ color: 'var(--theme-text1)' }}>{freshness.stale.length}</strong>{' '}
                  employee{freshness.stale.length === 1 ? "'s figures no longer match" : "s' figures no longer match"}
                  {' '}({freshness.stale.slice(0, 4).map(nameOf).join(', ')}{freshness.stale.length > 4 ? `, +${freshness.stale.length - 4} more` : ''}).{' '}
                </>
              )}
              {freshness.missing.length > 0 && (
                <><strong style={{ color: 'var(--theme-text1)' }}>{freshness.missing.length}</strong>{' '}
                  employee{freshness.missing.length === 1 ? ' was' : 's were'} added after this run and {freshness.missing.length === 1 ? 'has' : 'have'} no payslip in it
                  {' '}({freshness.missing.slice(0, 4).map(nameOf).join(', ')}{freshness.missing.length > 4 ? `, +${freshness.missing.length - 4} more` : ''}).{' '}
                </>
              )}
              {freshness.departed?.length > 0 && (
                <><strong style={{ color: 'var(--theme-text1)' }}>{freshness.departed.length}</strong>{' '}
                  employee{freshness.departed.length === 1 ? ' has a payslip' : 's have payslips'} here but {freshness.departed.length === 1 ? 'is' : 'are'} no longer active
                  {' '}({freshness.departed.slice(0, 4).map(nameOf).join(', ')}{freshness.departed.length > 4 ? `, +${freshness.departed.length - 4} more` : ''}) —
                  {' '}Regenerate would delete {freshness.departed.length === 1 ? 'it' : 'them'}.{' '}
                </>
              )}
              Regenerate rebuilds the draft from current data; manual TDS and TADA edits are reset.
            </p>
          </div>
        )}

        {loading ? (
          <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text2)' }}>Loading…</div>
        ) : employees.length === 0 ? (
          <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text2)' }}>No active employees. Add employees in HR → Employees first.</div>
        ) : !run ? (
          <div className="card" style={{ padding: 40, textAlign: 'center' }}>
            <div style={{ fontSize: 28, marginBottom: 12 }}>💵</div>
            <div style={{ fontSize: 14, color: 'var(--theme-text1)', marginBottom: 6 }}>No payroll run for {periodLabel} yet</div>
            <div style={{ fontSize: 12, color: 'var(--theme-text2)', marginBottom: 18 }}>Generates a draft from each employee's salary structure and {periodLabel} attendance. You can review and edit before finalizing.</div>
            <button className="btn btn-primary" onClick={generate} disabled={busy}>{busy ? 'Generating…' : 'Generate Payroll'}</button>
          </div>
        ) : (
          <>
            {/* Stat cards */}
            <div className="stat-grid">
              {[
                { label: 'Total Gross',  value: totals.gross, color: 'var(--theme-accent-ink)', tip: 'Sum of gross earnings (basic + allowances, or earned wage) across all payslips.' },
                { label: 'Deductions',   value: totals.ded + totals.ssfEmp + totals.advDed, color: 'var(--theme-red-text)', tip: 'SSF employee + absence deductions + other deductions + advance recovery + TDS.' },
                { label: 'Net Payable',  value: totals.net, color: 'var(--theme-green-text)', tip: 'Total take-home pay to disburse this period.' },
                { label: 'Employer SSF', value: totals.ssfEmpr, color: 'var(--theme-text2)', tip: '20% SSF the company pays on top — not part of net payable.' },
              ].map(s => (
                <div key={s.label} className="card" style={{ padding: '16px 18px' }}>
                  <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    <Tip text={s.tip} width={260}>{s.label}</Tip>
                  </div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: s.color }}>NPR {fmt(s.value)}</div>
                  <div style={{ fontSize: 10, color: 'var(--theme-text2)', marginTop: 3 }}>{payslips.length} employees</div>
                </div>
              ))}
            </div>

            {/* Register */}
            <div className="card" style={{ padding: 0 }}>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Employee</th>
                      <th style={{ textAlign: 'right' }}><Tip text="Gross earnings: basic + allowances (monthly) or earned wage (daily/hourly)." width={250}>Gross</Tip></th>
                      <th style={{ textAlign: 'right' }}><Tip text="Overtime pay at 1.5× the hourly rate." width={200}>OT</Tip></th>
                      <th style={{ textAlign: 'right' }}><Tip text="Pay deducted for unpaid days — absences, unpaid leave, and half-days (gross ÷ days in month × unpaid days, allowances included)." width={270}>Absence</Tip></th>
                      <th style={{ textAlign: 'right' }}><Tip text="11% SSF — only for employees with an SSF number on file." width={230}>SSF</Tip></th>
                      <th style={{ textAlign: 'right' }}><Tip text="All configured deductions except SSF — CIT/PF, etc." width={250}>Other Ded</Tip></th>
                      <th style={{ textAlign: 'right' }}><Tip text="Advance or loan installment auto-recovered this period from active advances in the Advances & Loans ledger. Repayment rows are written on Finalize." width={290}>Advance</Tip></th>
                      <th style={{ textAlign: 'right' }}><Tip text="Income tax, computed automatically from FY tax slabs using year-to-date projection. Editable while draft if you need to override." width={270}>TDS</Tip></th>
                      <th style={{ textAlign: 'right' }}><Tip text="Travel/Daily Allowance reimbursement — a non-taxable amount added after TDS, not part of the taxable gross. Editable while draft." width={290}>TADA</Tip></th>
                      <th style={{ textAlign: 'right', color: 'var(--theme-accent-ink)' }}>Net Pay</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {payslips.map(s => {
                      const emp = empMap[s.employee_id] || {}
                      const isMonthly = s.pay_basis === 'monthly'
                      const advDed = s.advance_deduction || 0
                      // Overtime recorded in BOTH the attendance sheet's OT column AND approved
                      // Overtime entries pays twice — flag it so the payroll runner can fix the source.
                      const attOtHrs = attendance.filter(a => a.employee_id === s.employee_id)
                        .reduce((sum, a) => sum + (parseFloat(a.ot_hours) || 0), 0)
                      const otBothSources = attOtHrs > 0 && otEntries.some(e => e.employee_id === s.employee_id)
                      return (
                        <tr key={s.id}>
                          <td>
                            <div style={{ fontWeight: 600, color: 'var(--theme-text1)', fontSize: 13 }}>{emp.full_name || '—'}</div>
                            <div style={{ display: 'flex', gap: 6, marginTop: 2, alignItems: 'center' }}>
                              {emp.employee_code && <span style={{ fontSize: 10, color: 'var(--theme-text2)' }}>{emp.employee_code}</span>}
                              {!isMonthly && <span className="badge badge-gray" style={{ fontSize: 10, fontWeight: 700 }}>{s.pay_basis}</span>}
                              {!emp.ssf_enrolled && <span style={{ fontSize: 10, color: 'var(--theme-text2)' }}>no SSF</span>}
                              {/* Enrolled but no registration number: SSF is deliberately NOT deducted
                                  (it would never reach the challan), and this is the only place that
                                  otherwise looks identical to a correctly-contributing employee. */}
                              {emp.ssf_enrolled && !String(emp.ssf_no || '').trim() && (
                                <Tip text="This employee is marked SSF-enrolled but has no SSF registration number, so no 11% contribution is being deducted — a contribution with no number can't be filed on the SSF challan. Add the number in Pay Setup, then Regenerate." width={290}>
                                  <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--theme-amber-text)', background: 'color-mix(in srgb, var(--theme-amber) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-amber) 30%, transparent)', borderRadius: 8, padding: '1px 6px', cursor: 'help' }}>⚠ SSF no. missing</span>
                                </Tip>
                              )}
                              {otBothSources && (
                                <Tip text={`This employee has OT in both places for this period — ${attOtHrs.toFixed(1)} hr on the attendance sheet and approved Overtime entries. They are no longer added together: on any day an approved entry exists, it supersedes the attendance sheet's hours for that day, so nothing is paid twice. Days with no approved entry still pay their attendance OT at 1.5×.`} width={300}>
                                  <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--theme-text2)', background: 'color-mix(in srgb, var(--theme-text2) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-text2) 25%, transparent)', borderRadius: 8, padding: '1px 6px', cursor: 'help' }}>OT: 2 sources</span>
                                </Tip>
                              )}
                            </div>
                          </td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-text1)' }}>{fmt(s.gross)}</td>
                          <td style={{ textAlign: 'right', color: s.ot_amount > 0 ? 'var(--theme-green-text)' : 'var(--theme-text2)' }}>{s.ot_amount > 0 ? `+${fmt(s.ot_amount)}` : '—'}</td>
                          <td style={{ textAlign: 'right', color: s.absence_deduction > 0 ? 'var(--theme-red-text)' : 'var(--theme-text2)' }}>{s.absence_deduction > 0 ? `−${fmt(s.absence_deduction)}` : '—'}</td>
                          <td style={{ textAlign: 'right', color: s.ssf_employee > 0 ? 'var(--theme-red-text)' : 'var(--theme-text2)' }}>{s.ssf_employee > 0 ? `−${fmt(s.ssf_employee)}` : '—'}</td>
                          <td style={{ textAlign: 'right', color: s.other_deductions > 0 ? 'var(--theme-red-text)' : 'var(--theme-text2)' }}>{s.other_deductions > 0 ? `−${fmt(s.other_deductions)}` : '—'}</td>
                          <td style={{ textAlign: 'right', color: advDed > 0 ? 'var(--theme-purple-text)' : 'var(--theme-text2)' }}>{advDed > 0 ? `−${fmt(advDed)}` : '—'}</td>
                          <td style={{ textAlign: 'right' }}>
                            {finalized
                              ? <span style={{ color: s.tds > 0 ? 'var(--theme-red-text)' : 'var(--theme-text2)' }}>{s.tds > 0 ? `−${fmt(s.tds)}` : '—'}</span>
                              : <input type="number" min="0" defaultValue={s.tds || ''} onBlur={e => updateTds(s, e.target.value)} placeholder="0" style={{ ...inp, width: 80, textAlign: 'right' }} />}
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            <div style={{ display: 'flex', gap: 4, alignItems: 'center', justifyContent: 'flex-end' }}>
                              {(s.tada_claim_ids || []).length > 0 && (
                                <Tip text={finalized
                                  ? `Auto-paid from ${s.tada_claim_ids.length} approved TADA claim(s) for this period — marked Paid in TADA Claims when this run was finalized.`
                                  : `Auto-filled from ${s.tada_claim_ids.length} approved TADA claim(s) for this period. Finalizing will mark them Paid — clear this to 0 to skip paying them via payroll.`} width={280}>
                                  <span style={{ fontSize: 10, cursor: 'help' }}>🔗</span>
                                </Tip>
                              )}
                              {finalized
                                ? <span style={{ color: (s.tada_amount || 0) > 0 ? 'var(--theme-green-text)' : 'var(--theme-text2)' }}>{(s.tada_amount || 0) > 0 ? `+${fmt(s.tada_amount)}` : '—'}</span>
                                : <input type="number" min="0" defaultValue={s.tada_amount || ''} onBlur={e => updateTada(s, e.target.value)} placeholder="0" style={{ ...inp, width: 80, textAlign: 'right' }} />}
                            </div>
                          </td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-accent-ink)', fontWeight: 700, fontSize: 14 }}>{fmt(s.net_pay)}</td>
                          <td style={{ textAlign: 'right' }}>
                            <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => setViewSlip({ slip: s, emp })}>Payslip</button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                  <tfoot>
                    <tr style={{ fontWeight: 700, borderTop: '2px solid var(--theme-border)' }}>
                      <td style={{ color: 'var(--theme-text2)', fontSize: 12 }}>Total — {payslips.length}</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-text1)' }}>{fmt(totals.gross)}</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-green-text)' }}>{totals.ot > 0 ? `+${fmt(totals.ot)}` : '—'}</td>
                      <td colSpan={4} style={{ textAlign: 'right', color: 'var(--theme-red-text)' }}>
                        {(totals.ded + totals.ssfEmp + totals.advDed) > 0 ? `−${fmt(totals.ded + totals.ssfEmp + totals.advDed)}` : '—'}
                      </td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-red-text)' }}>{totals.tds > 0 ? `−${fmt(totals.tds)}` : '—'}</td>
                      <td style={{ textAlign: 'right', color: totals.tada > 0 ? 'var(--theme-green-text)' : 'var(--theme-text2)' }}>{totals.tada > 0 ? `+${fmt(totals.tada)}` : '—'}</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-accent-ink)', fontSize: 15 }}>{fmt(totals.net)}</td>
                      <td></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
            {/* One topic per line, not a 180-word wall (S613) — the reader is looking up ONE of
                these rules mid-payroll, never reading all four. The stray \' this block used to
                render on screen went with it (JSX text takes a plain apostrophe). */}
            <div style={{ marginTop: 12, fontSize: 11, color: 'var(--theme-text2)', lineHeight: 1.6 }}>
              <p style={{ margin: 0, fontWeight: 600 }}>
                {finalized ? 'This payroll is finalized — payslips are locked as a permanent record.' : 'Draft — Regenerate to pull the latest salary, attendance & tax, then Finalize to lock. You can override any TDS value inline.'}
              </p>
              <ul style={{ margin: '6px 0 0', paddingLeft: 16 }}>
                <li><strong>SSF</strong> deducts only for employees marked SSF-enrolled AND holding an SSF number — an enrolled employee with no number is flagged in the list and contributes nothing, since a contribution with no number cannot be filed on the challan.</li>
                <li><strong>TDS</strong> comes from the fiscal-year tax slabs by year-to-date projection — finalize earlier months first so each month's tax builds on the last.</li>
                <li><strong>TADA</strong> (travel/daily allowance) auto-fills from this period's Approved TADA Claims (🔗 marks a claim-linked amount) and is added after TDS as a non-taxable reimbursement — hand-edit or clear it freely. Finalize marks linked claims Paid; Reopen reverts them to Approved.</li>
                <li><strong>Advances</strong>: active installments are auto-deducted, and repayment rows are written to Advances &amp; Loans on Finalize.</li>
              </ul>
            </div>
          </>
        )}
      </div>

      {/* On-screen payslip modal */}
      {viewSlip && (
        <PayslipModal data={viewSlip} period={period} periodLabel={periodLabel} bizInfo={bizInfo} onClose={() => setViewSlip(null)} onPrint={() => printPayslip(viewSlip.slip, viewSlip.emp)} />
      )}

      {/* Print-only payslip — explicit padding (margin off the paper edge, unlike the on-screen
          modal which sits inside its own bordered card) and a max-width, or the Row/space-between
          layout below stretches across the full A4 width and shoves label/value to opposite
          edges of the page with a wide dead gap between them. */}
      {printSlip && (
        <div className="print-only" style={{ padding: '28px 36px' }}>
          <div style={{ maxWidth: 420 }}>
            <PayslipBody slip={printSlip.slip} emp={printSlip.emp} periodLabel={periodLabel} bizInfo={bizInfo} forPrint />
          </div>
        </div>
      )}

      {confirmAction === 'regenerate' && (() => {
        // Regenerate rebuilds from LIVE employees, so a payslip belonging to someone since settled
        // or deactivated is deleted and never re-inserted. That payslip is real — they worked part
        // of the month — and losing it is silent, which is why the modal names them (S600 gate;
        // folded in here from a second window.confirm that used to stack on top of this one, S612).
        const departedNames = (freshness.departed || []).map(nameOf)
        return (
          <ConfirmModal
            title="Regenerate this payroll draft?"
            confirmLabel="Regenerate"
            danger={departedNames.length > 0}
            busy={busy} busyLabel="Recomputing…"
            onConfirm={regenerate}
            onCancel={() => setConfirmAction(null)}
          >
            <p style={{ margin: 0 }}>
              Every payslip is recomputed from current salary, attendance, overtime and tax data.
              Manual TDS and TADA overrides are reset — TADA re-fills from the claims currently
              Approved for this period. Nothing is finalized by this step.
            </p>
            {departedNames.length > 0 && (
              <p style={{ margin: '10px 0 0', color: 'var(--theme-red-text)' }}>
                {departedNames.slice(0, 8).join(', ')}{departedNames.length > 8 ? `, +${departedNames.length - 8} more` : ''}{' '}
                {departedNames.length === 1 ? 'has a payslip' : 'have payslips'} in this run but{' '}
                {departedNames.length === 1 ? 'is' : 'are'} no longer active (settled or deactivated) —{' '}
                {departedNames.length === 1 ? 'that payslip' : 'those payslips'} will be deleted and not restored.
              </p>
            )}
          </ConfirmModal>
        )
      })()}
      {confirmAction === 'finalize' && period && (() => {
        const netTotal  = payslips.reduce((s, p) => s + (p.net_pay || 0), 0)
        const tadaCount = payslips.reduce((n, p) => n + ((p.tada_amount || 0) > 0 && Array.isArray(p.tada_claim_ids) ? p.tada_claim_ids.length : 0), 0)
        const advCount  = payslips.filter(p => (p.advance_deduction || 0) > 0).length
        return (
          <ConfirmModal
            title={`Finalize ${BS_MONTHS[period.bs_month - 1]} ${period.bs_year} payroll?`}
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
              {/* Manually adjusted TDS/TADA no longer blocks Finalize (it is an intended edit, not
                  staleness — see `freshness`), so this is the one place it gets stated. It belongs
                  here rather than in the amber stale banner: nothing is wrong, but locking a
                  hand-set figure as a permanent record is worth seeing at the moment you do it. */}
              {freshness.overridden.length > 0 && (
                <li>
                  <strong>{freshness.overridden.length}</strong> payslip{freshness.overridden.length === 1 ? ' has' : 's have'}{' '}
                  a manually adjusted TDS or TADA figure ({freshness.overridden.slice(0, 4).map(nameOf).join(', ')}
                  {freshness.overridden.length > 4 ? `, +${freshness.overridden.length - 4} more` : ''}) — locked as entered, not recomputed
                </li>
              )}
            </ul>
            <p style={{ margin: 0 }}>Payslips are locked as a permanent record. This can be undone with Reopen.</p>
          </ConfirmModal>
        )
      })()}
      {confirmAction === 'reopen' && (
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
        </ConfirmModal>
      )}
    </div>
  )
}

function PayslipModal({ data, periodLabel, bizInfo, onClose, onPrint }) {
  const { slip, emp } = data
  return (
    // The shared Modal, not a hand-rolled overlay: this dialog shows an employee's pay document,
    // so it needs the focus trap and Escape that Modal provides. Printing is a separate path
    // (the `printSlip` render below), which is why Modal's own `no-print` overlay is fine here.
    <Modal onClose={onClose} title="Payslip" maxWidth={460}>
      <PayslipBody slip={slip} emp={emp} periodLabel={periodLabel} bizInfo={bizInfo} />
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 18 }}>
        <button className="btn btn-ghost" onClick={onClose}>Close</button>
        <button className="btn btn-primary" onClick={onPrint}>🖨 Print</button>
      </div>
    </Modal>
  )
}

