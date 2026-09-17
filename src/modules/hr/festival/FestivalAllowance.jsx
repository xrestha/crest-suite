import { nprInt } from '../../../shared/nepalMoney'
import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import Tip from '../../../components/Tip'
import RunStatusBadge from '../payroll/RunStatusBadge'
import ReportLoadError from '../../../components/ReportLoadError'
import { BS_MONTHS, bsToAd, daysInBsMonth, formatAd, getBsToday } from '../../../utils/bsCalendar'
import { fiscalYearOf } from '../payroll/tds'
import { employedInPeriod } from '../payroll/payrollCompute'
import { groupByEmployee, sliceFor } from '../payroll/payrollData'
import {
  DEFAULT_BONUS_MONTH, completedServiceMonths, computeRunBonusTds, fetchFinalizedBonuses,
  otherBonusesForFy, payslipYtdForFy,
} from '../payroll/bonusTax'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import { errorLine } from '../../../shared/errorText'
import { useConfirm } from '../../../shared/hooks/useConfirm'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'


const fmt = nprInt
const TABLE = 'hr_festival_allowances'
const NONE = []

const inp = {
  background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)', borderRadius: 0,
  padding: '6px 8px', fontSize: 13, color: 'var(--theme-text1)', outline: 'none', fontFamily: 'inherit',
}

// The amber banner shape PayrollRun's stale-draft card set (S570) — whole border tinted, 8% fill.
const amberBanner = {
  marginBottom: 14, padding: '12px 16px',
  borderColor: 'color-mix(in srgb, var(--theme-amber) 35%, transparent)',
  background: 'color-mix(in srgb, var(--theme-amber) 8%, transparent)',
}

// Every employee the client has, not just today's active list (S751). A stored run names people
// who have since left, and a leaver still on the payroll in the pay month is owed a share — so the
// eligibility test runs here, against the pay month, rather than in the query. `end_date` is
// load-bearing: it is how a leaver is recognised at all.
const EMP_COLS = 'id, full_name, employee_code, department, pay_basis, basic_salary, join_date, end_date, bank_name, bank_account_no, status, marital_status, ssf_enrolled, ssf_no, life_insurance_premium, health_insurance_premium'

// The name is typed, and every committed change re-reads the year. Committing per keystroke let
// the empty result for "Tih" land after the real one and offer Generate over a finalized "Tihar"
// run (S751), so the box commits after a pause, on blur or on Enter — and the load is guarded.
const NAME_DEBOUNCE_MS = 400

// A person deliberately taken out of a run keeps their row at 0 carrying this note, rather than
// being deleted (S751 review): a deleted row made them "missing staff" again, and Add missing staff
// put them straight back at 0 and re-blocked Finalize. The row is the record of the decision.
const EXCLUDED_NOTE = 'Excluded from this run'
const isExcluded = r => String(r.note || '').trim() === EXCLUDED_NOTE

// Status writes go out in id chunks: the ids are spelled out in the URL.
const ID_CHUNK = 150

const ON_PAYROLL = new Set(['active', 'probation'])
// "Dashain", "dashain" and "Dash ain" are one festival to a reader and three runs to the database.
const normName = s => String(s || '').toLowerCase().replace(/\s+/g, '')
const monthOf  = r => r.bs_month || DEFAULT_BONUS_MONTH

function payMonthBounds(bsYear, bsMonth) {
  return {
    start:   formatAd(bsToAd(bsYear, bsMonth, 1)),
    end:     formatAd(bsToAd(bsYear, bsMonth, daysInBsMonth(bsYear, bsMonth))),
    // Months of service are counted to the 15th of the pay month (decision 9).
    payDate: formatAd(bsToAd(bsYear, bsMonth, 15)),
  }
}

function fyAdBounds(fyStart) {
  return {
    start: formatAd(bsToAd(fyStart, 4, 1)),
    end:   formatAd(bsToAd(fyStart + 1, 3, daysInBsMonth(fyStart + 1, 3))),
  }
}

const fyLabel = fyStart => `${fyStart}/${String(fyStart + 1).slice(-2)}`

// On the payroll in the pay month: active/probation, or a leaver whose last day is on/after the
// month's first day — and actually employed on at least one day of it (fetchPayrollEmployees' rule).
function onPayrollInMonth(emp, bounds) {
  const end = emp.end_date ? String(emp.end_date).slice(0, 10) : null
  const current = ON_PAYROLL.has(emp.status) || (end && end >= bounds.start)
  return !!current && employedInPeriod(emp, bounds.start, bounds.end)
}

// '' is 0; a negative, NaN or non-numeric amount is refused (the database refuses it too).
function parseMoney(raw) {
  const s = String(raw ?? '').trim()
  if (s === '') return 0
  const n = Number(s)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.round(n * 100) / 100
}
const sameMoney = (a, b) => Math.abs((parseFloat(a) || 0) - (parseFloat(b) || 0)) < 0.005
const moneyText = v => ((parseFloat(v) || 0) ? String(v) : '')

// A money box keyed on the ROW, holding its own text and following the stored value when that
// changes. Keyed on the value instead, the income-tax box remounted the moment Gross was blurred
// (which recomputes the tax) — so tabbing from Gross into it and typing lost the typing.
function MoneyInput({ value, onCommit, ...rest }) {
  const [text, setText] = useState(moneyText(value))
  useEffect(() => { setText(moneyText(value)) }, [value])
  return (
    <input
      type="number" min="0" placeholder="0" {...rest}
      value={text}
      onChange={e => setText(e.target.value)}
      onBlur={() => onCommit(text, () => setText(moneyText(value)))}
    />
  )
}

export default function FestivalAllowance() {
  const { clientId, hasHrAccess } = useAuth()
  const { scopedFrom, scopedInsert, scopedUpdate } = useScopedDb()
  const { ask: askConfirm, confirmEl } = useConfirm()
  const baseReq = useLatestRequest()
  const runReq  = useLatestRequest()
  const today = getBsToday()

  const [bsYear,      setBsYear]      = useState(today.year)
  // The pay month for a run not generated yet. An existing run's month is read off its rows.
  const [draftMonth,  setDraftMonth]  = useState(DEFAULT_BONUS_MONTH)
  const [nameInput,   setNameInput]   = useState('Dashain')
  const [festival,    setFestival]    = useState('Dashain')   // the committed, trimmed name
  // Client-wide inputs to the tax: every employee, finalized payslips, finalized bonuses, components.
  const [base,        setBase]        = useState(null)
  const [baseError,   setBaseError]   = useState(null)
  const [baseLoading, setBaseLoading] = useState(true)
  // The selected BS year: every festival row that year (the run on screen and the others), plus
  // the finalized settlements that already paid someone's festival share.
  const [run,         setRun]         = useState(null)
  const [runError,    setRunError]    = useState(null)
  const [runLoading,  setRunLoading]  = useState(true)
  const [busy,        setBusy]        = useState(false)
  const [msg,         setMsg]         = useState('')

  // A write's reload must read the year and name on screen NOW, not the ones captured by the render
  // the write started in — a stale pair was a load key `shown` never matched: stuck on Loading.
  const current = useRef({ year: bsYear, name: festival })
  current.current = { year: bsYear, name: festival }

  const loadBase = useCallback(async ({ quiet = false } = {}) => {
    if (!clientId) return
    const key = baseReq.begin(clientId)
    if (!quiet) setBaseLoading(true)
    const results = await Promise.all([
      fetchAllRows(() => scopedFrom('hr_employees', EMP_COLS).order('full_name').order('id')),
      // Paged: every finalized payslip the client has ever had; the fiscal year is picked in JS.
      fetchAllRows(() =>
        scopedFrom('hr_payslips', 'employee_id, gross, ot_amount, ssf_employee, retirement_contribution, hr_payroll_runs!inner(status, monthly_periods!inner(bs_year, bs_month))')
          .eq('hr_payroll_runs.status', 'finalized')
          .order('id')),
      fetchFinalizedBonuses(scopedFrom),
      // ALL components, not only retirement ones: the months still to come are projected at basic
      // plus earning components (projectedMonthlyGross), and CIT relief reads the deductions.
      fetchAllRows(() => scopedFrom('hr_salary_components', 'employee_id, type, calc_type, value, retirement_fund').order('id')),
    ])
    if (!baseReq.isCurrent(key)) return
    // A failed read is not an empty one. Every figure here becomes an amount or a tax this page
    // SAVES: no payslips reads as the tax year's first month, no bonuses as none paid (S750).
    const failed = results.find(r => r && r.error)
    if (failed) { setBaseError(failed.error); setBaseLoading(false); return }
    const [emps, slips, bonuses, comps] = results
    setBase({ employees: emps.data || [], payslips: slips.data || [], bonuses: bonuses.data || [], components: comps.data || [] })
    setBaseError(null); setBaseLoading(false)
  }, [clientId, scopedFrom, baseReq])

  const loadRun = useCallback(async (year, name, { quiet = false } = {}) => {
    if (!clientId) return
    // Claimed before the first await, keyed on the EXACT trimmed name `shown` compares against —
    // a lower-cased key let "dashain" → "Dashain" match the key and never match `shown` (S751 review).
    const key = runReq.begin(`${clientId}:${year}:${name}`)
    if (!quiet) { setRunLoading(true); setMsg('') }
    // A pay month in BS `year` sits in the tax year starting year-1 (Baisakh–Ashadh) or year.
    const lo = fyAdBounds(year - 1).start, hi = fyAdBounds(year).end
    const results = await Promise.all([
      fetchAllRows(() => scopedFrom(TABLE).eq('bs_year', year).order('id')),
      scopedFrom('hr_final_settlements', 'employee_id, last_working_date, festival_pro')
        .eq('status', 'finalized').gt('festival_pro', 0)
        .gte('last_working_date', lo).lte('last_working_date', hi),
    ])
    if (!runReq.isCurrent(key)) return
    const failed = results.find(r => r && r.error)
    if (failed) { setRunError(failed.error); setRunLoading(false); return }
    setRun({ year, name, yearRows: results[0].data || [], settlements: results[1].data || [] })
    setRunError(null); setRunLoading(false)
  }, [clientId, scopedFrom, runReq])

  useEffect(() => { loadBase() }, [loadBase])
  useEffect(() => { loadRun(bsYear, festival) }, [loadRun, bsYear, festival])
  useEffect(() => {
    const t = setTimeout(() => setFestival(nameInput.trim()), NAME_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [nameInput])
  const commitName = () => setFestival(nameInput.trim())
  const pickRun = name => { setNameInput(name); setFestival(name) }
  const reloadRun = () => loadRun(current.current.year, current.current.name, { quiet: true })

  // ── Derived ────────────────────────────────────────────────────────────────────────────────
  const employees = base?.employees || NONE
  const empMap    = useMemo(() => new Map(employees.map(e => [e.id, e])), [employees])
  const compsIdx  = useMemo(() => groupByEmployee(base?.components || NONE), [base])
  const shown     = !!run && run.year === bsYear && run.name === festival
  const rows      = useMemo(() => (shown ? run.yearRows.filter(r => r.festival_name === run.name) : NONE), [run, shown])

  // Every row of a run carries the same pay month — unless an older write left them split. The
  // month shown is the one most rows carry, never simply rows[0]'s.
  const monthCounts = useMemo(() => {
    const m = new Map()
    rows.forEach(r => m.set(monthOf(r), (m.get(monthOf(r)) || 0) + 1))
    return m
  }, [rows])
  const rowMonths  = [...monthCounts.keys()].sort((a, b) => a - b)
  const splitMonth = rowMonths.length > 1
  const payMonth   = rows.length ? rowMonths.reduce((best, k) => (monthCounts.get(k) > monthCounts.get(best) ? k : best), rowMonths[0]) : draftMonth

  const bounds    = useMemo(() => payMonthBounds(bsYear, payMonth), [bsYear, payMonth])
  const { fyStart } = fiscalYearOf(bsYear, payMonth)
  // The run's key in bonusTax.js: the exact trimmed name, case kept.
  const runKey    = `festival:${bsYear}:${festival}`
  const ytdMap    = useMemo(() => payslipYtdForFy(base?.payslips, fyStart), [base, fyStart])
  // Only bonuses paid EARLIER in the tax year than this run's pay month count on top of it.
  const others    = useMemo(() => otherBonusesForFy(base?.bonuses, fyStart, runKey, { bs_year: bsYear, bs_month: payMonth }), [base, fyStart, runKey, bsYear, payMonth])

  // A finalized settlement in this tax year that paid a festival share has paid this festival.
  const settledIds = useMemo(() => {
    const fy = fyAdBounds(fyStart)
    return new Set((run?.settlements || NONE)
      .filter(s => { const d = String(s.last_working_date || '').slice(0, 10); return d >= fy.start && d <= fy.end })
      .map(s => s.employee_id))
  }, [run, fyStart])
  const eligible    = useMemo(() => employees.filter(e => onPayrollInMonth(e, bounds) && !settledIds.has(e.id)), [employees, bounds, settledIds])
  const eligibleIds = useMemo(() => new Set(eligible.map(e => e.id)), [eligible])
  const missing     = useMemo(() => { const have = new Set(rows.map(r => r.employee_id)); return eligible.filter(e => !have.has(e.id)) }, [rows, eligible])

  const yearRuns = useMemo(() => {
    if (!run || run.year !== bsYear) return NONE
    const m = new Map()
    for (const r of run.yearRows) {
      const g = m.get(r.festival_name) || { name: r.festival_name, count: 0, finalized: 0, bs_month: monthOf(r) }
      g.count += 1
      if (r.status === 'finalized') g.finalized += 1
      m.set(r.festival_name, g)
    }
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [run, bsYear])
  const lookalikes = yearRuns.filter(g => g.name !== festival && normName(g.name) === normName(festival))
  const otherRuns  = yearRuns.filter(g => normName(g.name) !== normName(festival))

  const nameOf = empId => empMap.get(empId)?.full_name || `Employee ${String(empId).slice(0, 8)}`
  const taxWith = (emp, amount, fy, ytd, oth) => (emp ? computeRunBonusTds({
    employee: emp, components: sliceFor(compsIdx, emp.id), amount,
    ytd: ytd[emp.id], otherBonuses: oth[emp.id] || 0, fyStart: fy,
  }) : 0)
  const taxFor = (emp, amount) => taxWith(emp, amount, fyStart, ytdMap, others)

  // Why a stored row's person is not in today's eligible list — or null when they are.
  function reasonFor(row) {
    if (settledIds.has(row.employee_id)) return 'Paid by Final Settlement'
    const e = empMap.get(row.employee_id)
    if (!e) return 'Employee record not found'
    if (eligibleIds.has(e.id)) return null
    const end = e.end_date ? String(e.end_date).slice(0, 10) : null
    if (end && end < bounds.start) return 'Left before this run'
    if (e.join_date && String(e.join_date).slice(0, 10) > bounds.end) return 'Joins after the pay month'
    return 'No longer on the payroll'
  }

  const sortedRows   = useMemo(() => [...rows].sort((a, b) => nameOf(a.employee_id).localeCompare(nameOf(b.employee_id))), [rows, empMap]) // eslint-disable-line react-hooks/exhaustive-deps
  const flagged      = sortedRows.filter(r => !isExcluded(r) && reasonFor(r))
  const amountNeeded = sortedRows.filter(r => !isExcluded(r) && (r.pay_basis || 'monthly') !== 'monthly' && !(parseFloat(r.amount) > 0) && !reasonFor(r))
  const excludedRows = sortedRows.filter(isExcluded)
  const finalized    = rows.length > 0 && rows.every(r => r.status === 'finalized')
  const anyFinalized = rows.some(r => r.status === 'finalized')
  const drafts       = useMemo(() => rows.filter(r => r.status === 'draft'), [rows])
  const ready       = shown && !!base && !baseError && !runError && !baseLoading && !runLoading
  const typing       = nameInput.trim() !== festival
  const monthName    = BS_MONTHS[payMonth - 1]
  const years        = Array.from({ length: 6 }, (_, i) => today.year - 3 + i)

  // Draft rows whose stored tax no longer matches what the tax works out to now — a payroll month
  // finalized, an earlier bonus finalized, a raise. Finalize must not lock that silently (S751 review).
  const taxCheck = useMemo(() => (ready ? drafts.flatMap(r => {
    const emp = empMap.get(r.employee_id)
    if (!emp) return []
    const fresh = taxFor(emp, parseFloat(r.amount) || 0)
    return Math.abs(fresh - (parseFloat(r.tds) || 0)) >= 1 ? [{ row: r, fresh, kept: !!r.tds_overridden }] : []
  }) : NONE), [ready, drafts, empMap, compsIdx, ytdMap, others, fyStart]) // eslint-disable-line react-hooks/exhaustive-deps
  // A row whose tax a person typed or kept (tds_overridden, S753) is not stale — it is listed in the
  // Finalize confirmation instead. Before S753 "keep" was a page-session acknowledgement that a
  // reload forgot.
  const staleTax = useMemo(() => taxCheck.filter(t => !t.kept), [taxCheck])
  const keptTax  = useMemo(() => taxCheck.filter(t => t.kept), [taxCheck])

  // The month the split rows can be moved to: any month while nothing is finalized, otherwise only
  // the one month every finalized row already carries (a finalized row cannot move).
  const finalMonths  = [...new Set(rows.filter(r => r.status === 'finalized').map(monthOf))]
  const moveOptions  = anyFinalized ? (finalMonths.length === 1 ? finalMonths : NONE) : rowMonths

  const payRows  = rows.filter(r => !isExcluded(r))
  const total    = rows.reduce((a, r) => a + (parseFloat(r.amount) || 0), 0)
  const totalTds = rows.reduce((a, r) => a + (parseFloat(r.tds) || 0), 0)

  function buildRow(emp) {
    const basis  = emp.pay_basis || 'monthly'
    const basic  = parseFloat(emp.basic_salary) || 0
    const months = completedServiceMonths(emp, bounds.payDate)
    // Daily/hourly staff have no contractual month to take a share of — typed by hand (decision 10).
    const amount = basis === 'monthly' ? Math.round(basic * months / 12) : 0
    return {
      employee_id: emp.id, bs_year: bsYear, bs_month: payMonth, festival_name: festival,
      pay_basis: basis, basic, months_worked: months, amount, tds: taxFor(emp, amount), tds_overridden: false, status: 'draft',
    }
  }

  const patchLocal = (id, patch) => setRun(prev => (prev ? { ...prev, yearRows: prev.yearRows.map(r => (r.id === id ? { ...r, ...patch } : r)) } : prev))
  const rowsFailed = (results, count, what) => {
    const bad = results.filter(x => !x.skipped && (x.error || !x.data?.length))
    if (!bad.length) return false
    const err = bad.find(x => x.error)?.error
    setMsg(`error:${bad.length} of ${count} rows ${what} — the register shows what is stored. ` + (err ? errorLine(err) : 'The run may have been finalized or changed in another tab.'))
    return true
  }

  // ── Writes ─────────────────────────────────────────────────────────────────────────────────
  // Generate and Add missing staff are one INSERT of the rows that do not exist yet — never an
  // upsert. The upsert this replaced rewrote every existing row: from a stale tab it reset a
  // finalized run to draft with recomputed amounts, and on a draft it wiped hand-typed amounts.
  // A row another tab inserted first is refused by the unique key instead of overwritten.
  async function insertMissing(verb) {
    if (!clientId) { setMsg('error:No client selected'); return }
    const name = nameInput.trim()
    if (!name) { setMsg('error:Name the festival first — for example "Dashain" or "Tihar".'); return }
    if (name !== festival) { commitName(); return }
    if (!ready || missing.length === 0 || splitMonth) return
    setBusy(true); setMsg('')
    const { error } = await scopedInsert(TABLE, missing.map(buildRow))
    await reloadRun()
    setBusy(false)
    if (error) { setMsg(`error:${verb === 'generate' ? 'The allowance was not generated' : 'The missing staff were not added'} — the register shows what is stored. ` + errorLine(error)); return }
    setMsg(`ok:${verb === 'generate' ? 'Generated' : `Added ${missing.length}`}`)
  }

  // Recompute is an explicit UPDATE of draft rows only. Excluded rows stay excluded.
  function regenerate() {
    if (finalized || drafts.length === 0) return
    const targets = drafts.filter(r => !isExcluded(r))
    askConfirm({
      title: `Recompute the ${festival} ${bsYear} allowance?`,
      confirmLabel: 'Recompute', danger: true, busyLabel: 'Recomputing…',
      body: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <p style={{ margin: 0 }}>Monthly staff: months worked are counted again up to 15 {monthName} and the amount is worked out again from today's basic salary — any amount you typed for them is replaced.</p>
          <p style={{ margin: 0 }}>Daily and hourly staff keep the amounts you entered, and excluded staff stay excluded.</p>
          <p style={{ margin: 0 }}>Income tax is worked out again on every row, replacing any tax you typed by hand. Finalized rows are not touched.</p>
        </div>
      ),
      run: async () => {
        setBusy(true); setMsg('')
        const results = await Promise.all(targets.map(r => {
          const emp = empMap.get(r.employee_id)
          if (!emp) return Promise.resolve({ data: [], error: null, skipped: true })
          const built = buildRow(emp)
          const amount = built.pay_basis !== 'monthly' ? (parseFloat(r.amount) || 0) : built.amount
          const patch = {
            pay_basis: built.pay_basis, basic: built.basic, months_worked: built.months_worked,
            amount, tds: taxFor(emp, amount), tds_overridden: false,
          }
          return scopedUpdate(TABLE, patch).eq('id', r.id).eq('status', 'draft').select('id')
        }))
        await reloadRun()
        setBusy(false)
        if (rowsFailed(results, targets.length, 'were not recomputed')) return
        setMsg('ok:Recomputed')
      },
    })
  }

  // Tax only, amounts kept — the answer to the stale-tax banner.
  async function recomputeTaxNow() {
    if (!ready || busy || staleTax.length === 0) return
    const targets = staleTax
    setBusy(true); setMsg('')
    const results = await Promise.all(targets.map(({ row, fresh }) =>
      scopedUpdate(TABLE, { tds: fresh, tds_overridden: false }).eq('id', row.id).eq('status', 'draft').select('id')))
    await reloadRun()
    setBusy(false)
    if (rowsFailed(results, targets.length, 'did not get the new income tax')) return
    setMsg('ok:Income tax brought up to date')
  }

  // "Keep the tax as entered" (S753): stored on each row, so it survives a reload and a second tab
  // sees it. A later Recompute, amount change or pay-month move clears it again.
  async function keepTaxAsEntered() {
    if (!ready || busy || staleTax.length === 0) return
    const targets = staleTax
    setBusy(true); setMsg('')
    const results = await Promise.all(targets.map(({ row }) =>
      scopedUpdate(TABLE, { tds_overridden: true }).eq('id', row.id).eq('status', 'draft').select('id')))
    await reloadRun()
    setBusy(false)
    if (rowsFailed(results, targets.length, 'were not marked as kept')) return
    setMsg('ok:Income tax kept as entered')
  }

  // Inline edits are optimistic; a refused write — an error, or an RLS refusal that returns 0 rows
  // with no error — reloads so the register shows what is actually stored.
  async function inlineWrite(row, patch, what) {
    const { data, error } = await scopedUpdate(TABLE, patch).eq('id', row.id).select('id')
    if (error || !data?.length) {
      setMsg(`error:${what} for ${nameOf(row.employee_id)} was not saved — the register shows what is stored. ` + (error ? errorLine(error) : 'The run may have been finalized or changed in another tab.'))
      await reloadRun()
    }
  }

  async function updateAmount(row, raw, reset) {
    if (row.status !== 'draft' || isExcluded(row)) return
    const amount = parseMoney(raw)
    if (amount === null) { reset(); setMsg(`error:The amount for ${nameOf(row.employee_id)} must be 0 or more.`); return }
    // Blurring without a change must not recompute — that overwrote a hand-typed tax (S751).
    if (sameMoney(amount, row.amount)) return
    const tds = taxFor(empMap.get(row.employee_id), amount)
    patchLocal(row.id, { amount, tds, tds_overridden: false })
    await inlineWrite(row, { amount, tds, tds_overridden: false }, 'The amount')
  }

  async function updateTds(row, raw, reset) {
    if (row.status !== 'draft' || isExcluded(row)) return
    const tds = parseMoney(raw)
    if (tds === null) { reset(); setMsg(`error:The income tax for ${nameOf(row.employee_id)} must be 0 or more.`); return }
    if (sameMoney(tds, row.tds)) return
    // Stored as typed (S753): a figure that differs from the calculation is flagged, so a later change
    // to the calculation does not hold up Finalize, and the flag survives a reload.
    const calculated = taxFor(empMap.get(row.employee_id), parseFloat(row.amount) || 0)
    const tds_overridden = Math.abs(tds - calculated) >= 1
    patchLocal(row.id, { tds, tds_overridden })
    await inlineWrite(row, { tds, tds_overridden }, 'The income tax')
  }

  async function updateNote(row, value) {
    if (row.status !== 'draft' || isExcluded(row)) return
    const note = value.trim() || null
    if (note === (row.note || null)) return
    if (note === EXCLUDED_NOTE) { setMsg('error:Use “Remove from this run” to exclude someone — that note is reserved for it.'); await reloadRun(); return }
    patchLocal(row.id, { note })
    await inlineWrite(row, { note }, 'The note')
  }

  function excludeRow(row) {
    const reason = reasonFor(row)
    askConfirm({
      title: `Remove ${nameOf(row.employee_id)} from this run?`,
      confirmLabel: 'Remove', danger: true, busyLabel: 'Removing…',
      body: <p style={{ margin: 0 }}>They are paid nothing from the {festival} {bsYear} allowance{reason ? ` (${reason.toLowerCase()})` : ''}. Their row stays, marked Excluded at 0, so they are not offered again as missing staff and do not hold up Finalize. “Include again” undoes it.</p>,
      run: async () => {
        setBusy(true); setMsg('')
        const { data, error } = await scopedUpdate(TABLE, { amount: 0, tds: 0, tds_overridden: false, note: EXCLUDED_NOTE }).eq('id', row.id).eq('status', 'draft').select('id')
        await reloadRun()
        setBusy(false)
        if (error || !data?.length) { setMsg(`error:${nameOf(row.employee_id)} was not removed — the register shows what is stored. ` + (error ? errorLine(error) : 'The run may have been finalized in another tab.')); return }
        setMsg('ok:Excluded')
      },
    })
  }

  async function includeRow(row) {
    if (row.status !== 'draft' || busy) return
    const emp = empMap.get(row.employee_id)
    const built = emp ? buildRow(emp) : null
    const patch = built
      ? { pay_basis: built.pay_basis, basic: built.basic, months_worked: built.months_worked, amount: built.amount, tds: built.tds, tds_overridden: false, note: null }
      : { amount: 0, tds: 0, tds_overridden: false, note: null }
    setBusy(true); setMsg('')
    const { data, error } = await scopedUpdate(TABLE, patch).eq('id', row.id).eq('status', 'draft').select('id')
    await reloadRun()
    setBusy(false)
    if (error || !data?.length) { setMsg(`error:${nameOf(row.employee_id)} was not included again — the register shows what is stored. ` + (error ? errorLine(error) : 'The run may have been finalized in another tab.')); return }
    setMsg('ok:Included again')
  }

  // Moving a draft run to one pay month. Income tax is worked out again on every draft row: the
  // month decides the tax year AND which other bonuses count as paid before this one.
  function changeMonth(m) {
    if (rows.length === 0) { setDraftMonth(m); return }
    if (!ready || busy) return
    if (!splitMonth && m === payMonth) return
    if (rows.some(r => r.status === 'finalized' && monthOf(r) !== m)) {
      setMsg(`error:Finalized rows of this run are paid in ${BS_MONTHS[finalMonths[0] - 1]}, so the run cannot move to ${BS_MONTHS[m - 1]}. Reopen it first.`)
      return
    }
    const newFy = fiscalYearOf(bsYear, m).fyStart
    const targets = drafts
    askConfirm({
      title: `Pay the ${festival} ${bsYear} allowance in ${BS_MONTHS[m - 1]}?`,
      confirmLabel: 'Change pay month', busyLabel: 'Saving…',
      body: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <p style={{ margin: 0 }}>Every draft row moves to {BS_MONTHS[m - 1]} {bsYear} ({fyLabel(newFy)} tax year). Income tax on each is worked out again for that month — it counts only bonuses paid before it — replacing any tax you typed by hand.</p>
          <p style={{ margin: 0 }}>Amounts and months worked stay as they are. Press Recompute afterwards if months of service should be counted to 15 {BS_MONTHS[m - 1]} instead.</p>
        </div>
      ),
      run: async () => {
        setBusy(true); setMsg('')
        const ytdNew = payslipYtdForFy(base.payslips, newFy)
        const othersNew = otherBonusesForFy(base.bonuses, newFy, runKey, { bs_year: bsYear, bs_month: m })
        const results = await Promise.all(targets.map(r => {
          const emp = empMap.get(r.employee_id)
          const patch = isExcluded(r) || !emp
            ? { bs_month: m }
            : { bs_month: m, tds: taxWith(emp, parseFloat(r.amount) || 0, newFy, ytdNew, othersNew), tds_overridden: false }
          return scopedUpdate(TABLE, patch).eq('id', r.id).eq('status', 'draft').select('id')
        }))
        await reloadRun()
        setBusy(false)
        if (rowsFailed(results, targets.length, `did not move to ${BS_MONTHS[m - 1]}`)) return
        setDraftMonth(m)
        setMsg(`ok:Pay month set to ${BS_MONTHS[m - 1]}`)
      },
    })
  }

  // Status writes are scoped to the ids on screen, so a row another tab added is never locked
  // unseen, and each chunk's returned rows are counted (a refused RLS update is 0 rows, no error).
  async function writeStatus(ids, status, fromStatus) {
    let n = 0
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      const { data, error } = await scopedUpdate(TABLE, { status })
        .eq('bs_year', bsYear).eq('festival_name', festival).eq('status', fromStatus)
        .in('id', ids.slice(i, i + ID_CHUNK))
        .select('id')
      if (error) return { n, error }
      n += data?.length || 0
    }
    return { n, error: null }
  }

  function setStatus(status) {
    const toFinal = status === 'finalized'
    if (toFinal && (flagged.length || amountNeeded.length || splitMonth || drafts.length === 0 || staleTax.length)) return
    const ids = rows.filter(r => r.status === (toFinal ? 'draft' : 'finalized')).map(r => r.id)
    const verb = toFinal ? 'finalized' : 'reopened'
    const kept = toFinal ? keptTax : NONE
    askConfirm({
      title: `${toFinal ? 'Finalize' : 'Reopen'} the ${festival} ${bsYear} allowance?`,
      confirmLabel: `${toFinal ? 'Finalize' : 'Reopen'} Allowance`, busyLabel: `${toFinal ? 'Finalizing' : 'Reopening'}…`,
      danger: !toFinal,
      body: toFinal
        ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <p style={{ margin: 0 }}>{payRows.length} allowance{payRows.length === 1 ? '' : 's'}, NPR {fmt(total)} gross and NPR {fmt(total - totalTds)} to transfer, lock as a permanent record paid in {monthName} {bsYear}. From then on monthly payroll and Final Settlement count it as paid. This can be undone with Reopen.</p>
            {excludedRows.length > 0 && <p style={{ margin: 0 }}>Excluded, paid nothing: {excludedRows.map(r => nameOf(r.employee_id)).join(', ')}.</p>}
            {kept.length > 0 && <p style={{ margin: 0 }}>Income tax kept as entered, not as it works out now: {kept.map(s => `${nameOf(s.row.employee_id)} (NPR ${fmt(s.row.tds)}, works out to NPR ${fmt(s.fresh)})`).join(', ')}.</p>}
          </div>
        )
        : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <p style={{ margin: 0 }}>The allowance goes back to draft: amounts and income tax become editable again.</p>
            <p style={{ margin: 0 }}>Until it is finalized again it counts as <strong>not paid</strong>. Final Settlement will give a festival share to anyone settled while it is reopened — on top of this allowance once you finalize it again — and monthly payroll's income tax stops counting it as a bonus already paid this year.</p>
          </div>
        ),
      run: async () => {
        setBusy(true); setMsg('')
        const { n, error } = await writeStatus(ids, status, toFinal ? 'draft' : 'finalized')
        await Promise.all([loadBase({ quiet: true }), reloadRun()])
        setBusy(false)
        if (error) {
          setMsg(`error:The allowance was not fully ${verb} — ${n} of ${ids.length} rows were ${verb} before it stopped. The register shows what is stored; ${toFinal ? 'Finalize' : 'Reopen'} again to finish. ` + errorLine(error))
          return
        }
        if (n < ids.length) {
          setMsg(`error:${ids.length - n} of the ${ids.length} rows on screen were not ${verb} — the run was changed in another tab (a row edited, removed or already ${verb}). The register now shows what is stored; check it and ${toFinal ? 'finalize' : 'reopen'} again.`)
          return
        }
            setMsg(`ok:${toFinal ? 'Finalized' : 'Reopened'}`)
      },
    })
  }

  async function exportSheet(data, name, ext = 'xlsx') {
    const XLSX = await import('xlsx')
    const ws = XLSX.utils.json_to_sheet(data)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, name)
    const safe = festival.replace(/[^\w-]+/g, '_')
    XLSX.writeFile(wb, `${name.replace(/\s+/g, '_').toLowerCase()}_${safe}_${bsYear}.${ext}`, ext === 'csv' ? { bookType: 'csv' } : undefined)
  }
  function exportRegister() {
    exportSheet(sortedRows.map(r => {
      const e = empMap.get(r.employee_id) || {}
      return {
        Employee: nameOf(r.employee_id), Code: e.employee_code || '', 'Pay Basis': r.pay_basis,
        'Paid In': `${BS_MONTHS[monthOf(r) - 1]} ${bsYear}`,
        Basic: r.basic, 'Months Worked': r.months_worked,
        'Gross Amount': r.amount, 'Income Tax (TDS)': r.tds || 0,
        'Net Amount': (r.amount || 0) - (r.tds || 0),
        Flag: isExcluded(r) ? 'Excluded' : (reasonFor(r) || ''),
      }
    }), 'Festival Allowance')
  }
  function exportBank(ext) {
    // Nobody is transferred 0, and a row with no bank details says so in the file itself — a blank
    // account column is how a transfer silently goes nowhere.
    const payable = sortedRows.filter(r => (parseFloat(r.amount) || 0) - (parseFloat(r.tds) || 0) > 0)
    if (payable.length === 0) { setMsg('error:Nothing to transfer — every amount is 0.'); return }
    exportSheet(payable.map(r => {
      const e = empMap.get(r.employee_id) || {}
      const hasBank = !!(e.bank_name && e.bank_account_no)
      return {
        Name: nameOf(r.employee_id),
        Bank: hasBank ? e.bank_name : 'MISSING BANK DETAILS',
        'Account No': hasBank ? e.bank_account_no : 'MISSING BANK DETAILS',
        Gross: r.amount, 'Income Tax (TDS)': r.tds || 0, 'Net Transfer': (r.amount || 0) - (r.tds || 0),
      }
    }), 'Festival Bank Transfer', ext)
  }

  if (!hasHrAccess('manager')) return <Navigate to="/dashboard" replace />

  const loadError = baseError || runError
  const loading   = !loadError && !ready
  const taxBlocks = staleTax.length > 0
  const canFinalize = ready && !busy && !typing && drafts.length > 0 && flagged.length === 0 && amountNeeded.length === 0 && !splitMonth && !taxBlocks
  const statusChip = g => (g.finalized === g.count ? { label: 'Finalized', cls: 'badge-green' } : g.finalized === 0 ? { label: 'Draft', cls: 'badge-amber' } : { label: 'Part finalized', cls: 'badge-amber' })

  return (
    <div>
      <div className="page-header page-header--split">
        <div>
          <h1 className="page-title">Festival Allowance</h1>
          <p className="page-subtitle">
            Dashain allowance (चाडपर्व खर्च) — {festival || 'unnamed'} {bsYear}, paid in {monthName}
            {rows.length > 0 && (
              <RunStatusBadge finalized={finalized} />
            )}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }} className="no-print">
          <input
            aria-label="Festival name" style={{ ...inp, width: 130 }} value={nameInput} placeholder="Festival name"
            disabled={busy}
            onChange={e => setNameInput(e.target.value)} onBlur={commitName}
            onKeyDown={e => { if (e.key === 'Enter') commitName() }}
          />
          <select className="form-select" aria-label="BS year" value={bsYear} disabled={busy} onChange={e => setBsYear(parseInt(e.target.value, 10))}>
            {years.map(y => <option key={y} value={y}>BS {y}</option>)}
          </select>
          <Tip text="The month the allowance is paid. It decides the tax year (a bonus paid Baisakh–Ashadh belongs to the tax year that began the Shrawan before), which other bonuses count as paid before it, and the date months of service are counted up to (the 15th). Locked once the run is finalized." width={300}>
            <span style={{ fontSize: 12, color: 'var(--theme-text2)' }}>Paid in</span>
          </Tip>
          <select
            className="form-select" aria-label="Paid in (BS month)" value={payMonth}
            disabled={busy || anyFinalized || (rows.length > 0 && !ready)}
            onChange={e => changeMonth(parseInt(e.target.value, 10))}
          >
            {BS_MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
          </select>
          {msg && <span role={msg.startsWith('ok') ? 'status' : 'alert'} style={{ fontSize: 12, color: msg.startsWith('ok') ? 'var(--theme-green-text)' : 'var(--theme-red-text)', marginLeft: 'auto' }}>{msg.split(':').slice(1).join(':')}</span>}
        </div>
      </div>

      {/* Runs that already exist this year — so a past run is found by clicking, not by retyping its name exactly. */}
      {ready && yearRuns.length > 0 && (
        <div className="no-print" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }} role="group" aria-label={`Festival runs in BS ${bsYear}`}>
          <span style={{ fontSize: 12, color: 'var(--theme-text2)' }}>Runs in BS {bsYear}:</span>
          {yearRuns.map(g => {
            const chip = statusChip(g)
            const isCurrent = g.name === festival
            return (
              <button key={g.name} type="button" className="btn btn-ghost btn-sm" aria-pressed={isCurrent} onClick={() => pickRun(g.name)} disabled={busy}
                style={isCurrent ? { borderColor: 'var(--theme-accent)' } : undefined}>
                {g.name} · {BS_MONTHS[g.bs_month - 1]} · {g.count} staff
                <span className={`badge ${chip.cls}`} style={{ marginLeft: 6 }}>{chip.label}</span>
              </button>
            )
          })}
        </div>
      )}

      {loadError ? (
        <ReportLoadError error={loadError} />
      ) : loading ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text2)' }}>Loading…</div>
      ) : !festival ? (
        <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--theme-text2)' }}>
          Name the festival above (for example Dashain or Tihar){yearRuns.length > 0 ? ', or pick one of this year’s runs' : ''}.
        </div>
      ) : rows.length === 0 ? (
        <>
          {lookalikes.length > 0 && (
            <div role="alert" className="card" style={{ ...amberBanner, fontSize: 12, color: 'var(--theme-text2)', lineHeight: 1.6 }}>
              <div style={{ color: 'var(--theme-amber-text)', fontWeight: 600 }}>“{festival}” differs from the existing “{lookalikes[0].name}” run only by capital letters or spaces.</div>
              Generating would create a second, separate allowance for the same festival. Open the existing one instead:{' '}
              {lookalikes.map(g => <button key={g.name} type="button" className="btn btn-ghost btn-sm" onClick={() => pickRun(g.name)}>{g.name}</button>)}
            </div>
          )}
          {otherRuns.length > 0 && (
            <div role="alert" className="card" style={{ ...amberBanner, fontSize: 12, color: 'var(--theme-text2)', lineHeight: 1.6 }}>
              <div style={{ color: 'var(--theme-amber-text)', fontWeight: 600 }}>
                {otherRuns.length === 1
                  ? `A ${otherRuns[0].name} allowance already exists for BS ${bsYear} — this would be a second one.`
                  : `${otherRuns.length} festival allowances already exist for BS ${bsYear} (${otherRuns.map(g => g.name).join(', ')}) — this would be another one.`}
              </div>
              That is allowed. Each run is taxed on top of the bonuses paid before it that tax year, so its income tax can be higher.
            </div>
          )}
          {eligible.length === 0 ? (
            <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text2)' }}>
              No one is on the payroll in {monthName} {bsYear}{settledIds.size > 0 ? ' (staff already paid a festival share by Final Settlement are left out)' : ''}. Add employees in HR → Employees, or pick a different pay month.
            </div>
          ) : (
            <div className="card" style={{ padding: 40, textAlign: 'center' }}>
              <div aria-hidden="true" style={{ fontSize: 24, marginBottom: 12 }}>🎉</div>
              <div style={{ fontSize: 14, color: 'var(--theme-text1)', marginBottom: 6 }}>No {festival} allowance for BS {bsYear} yet</div>
              <div style={{ fontSize: 12, color: 'var(--theme-text2)', marginBottom: 18, lineHeight: 1.6, maxWidth: 560, marginInline: 'auto' }}>
                {eligible.length} staff on the payroll in {monthName}. Monthly staff get basic × completed months worked up to 15 {monthName} ÷ 12 — a full year's service is one month's basic.
                Daily and hourly staff start at 0, marked “amount needed”: type their amounts before you finalize.
              </div>
              <button className="btn btn-primary" onClick={() => insertMissing('generate')} disabled={busy || typing || !nameInput.trim()}>
                {busy ? 'Generating…' : 'Generate Allowance'}
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          {/* KPI cards */}
          <div className="stat-grid">
            {[
              { label: 'Gross Payout',     value: fmt(total),            color: 'var(--theme-text1)', tip: 'Total festival allowance before income tax is taken off.' },
              { label: 'Income Tax (TDS)', value: fmt(totalTds),         color: 'var(--theme-text1)',   tip: 'Income tax held back from the allowance and paid to the tax office. Tax is worked out on the whole year: this year’s salary so far, the salary still to come, and other bonuses already paid — so the allowance is taxed at the rate the employee actually falls in.' },
              { label: 'Net Payout',       value: fmt(total - totalTds), color: 'var(--theme-text1)', tip: 'What actually reaches staff bank accounts: gross minus income tax.' },
              { label: 'Employees',        value: payRows.length,        color: 'var(--theme-text1)',      tip: 'People in this run, not counting anyone marked Excluded.' },
              { label: 'Average Gross',    value: fmt(payRows.length ? total / payRows.length : 0), color: 'var(--theme-text3)', tip: 'Gross payout ÷ people in the run (excluded staff not counted).' },
            ].map(s => (
              <div key={s.label} className="card" style={{ padding: '16px 18px' }}>
                <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                  <Tip text={s.tip} width={280}>{s.label}</Tip>
                </div>
                <div style={{ fontSize: 18, fontWeight: 700, color: s.color }}>
                  {s.label === 'Employees' ? s.value : `NPR ${s.value}`}
                </div>
              </div>
            ))}
          </div>

          {splitMonth && (
            <div role="alert" className="card" style={{ ...amberBanner, fontSize: 12, color: 'var(--theme-text2)', lineHeight: 1.6 }}>
              <div style={{ color: 'var(--theme-amber-text)', fontWeight: 600 }}>This run is split across pay months</div>
              {rowMonths.map(k => `${BS_MONTHS[k - 1]} (${monthCounts.get(k)})`).join(', ')}. One allowance is paid in one month, and the month decides its income tax — so Finalize and Add missing staff wait until every row carries the same month.
              {' '}
              {moveOptions.length > 0
                ? moveOptions.map(k => <button key={k} type="button" className="btn btn-ghost btn-sm" style={{ marginLeft: 6 }} onClick={() => changeMonth(k)} disabled={busy}>Move all to {BS_MONTHS[k - 1]}</button>)
                : 'The finalized rows themselves carry different months — reopen the run to fix it.'}
            </div>
          )}

          {/* What stops Finalize, named. */}
          {!finalized && (flagged.length > 0 || amountNeeded.length > 0) && (
            <div role="alert" className="card" style={{ ...amberBanner, fontSize: 12, color: 'var(--theme-text2)', lineHeight: 1.6 }}>
              <div style={{ color: 'var(--theme-amber-text)', fontWeight: 600 }}>Finalize is blocked</div>
              {flagged.length > 0 && (
                <div>Not on the payroll in {monthName} {bsYear} — remove them from this run: {flagged.map(r => `${nameOf(r.employee_id)} (${reasonFor(r).toLowerCase()})`).join(', ')}.</div>
              )}
              {amountNeeded.length > 0 && (
                <div>Daily/hourly staff still at 0 — type an amount, or remove them if they get nothing: {amountNeeded.map(r => nameOf(r.employee_id)).join(', ')}.</div>
              )}
            </div>
          )}

          {!finalized && staleTax.length > 0 && (
            <div role="alert" className="card" style={{ ...amberBanner, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 12, color: 'var(--theme-text2)', lineHeight: 1.6, flex: '1 1 320px' }}>
                <div style={{ color: 'var(--theme-amber-text)', fontWeight: 600 }}>
                  {`Income tax is out of date on ${staleTax.length} row${staleTax.length === 1 ? '' : 's'}`}
                </div>
                {staleTax.map(s => `${nameOf(s.row.employee_id)} (NPR ${fmt(s.row.tds)} saved, works out to NPR ${fmt(s.fresh)} now)`).join(', ')}.
                {' '}A payroll month or another bonus finalized since, a raise, or a tax you typed by hand all do this. Finalize waits until you bring the tax up to date or say the typed figures stay.
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn btn-primary btn-sm" onClick={recomputeTaxNow} disabled={busy}>Recompute tax now</button>
                <button className="btn btn-ghost btn-sm" onClick={keepTaxAsEntered} disabled={busy}>Keep the tax as entered</button>
              </div>
            </div>
          )}

          {missing.length > 0 && (
            <div role="alert" className="card" style={{ ...amberBanner, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 12, color: 'var(--theme-text2)', lineHeight: 1.6, flex: '1 1 320px' }}>
                <div style={{ color: 'var(--theme-amber-text)', fontWeight: 600 }}>{missing.length} staff not in this run</div>
                {missing.map(e => e.full_name).join(', ')} — on the payroll in {monthName} but with no row in this run.
                {finalized && ' Reopen the run to add them.'}
              </div>
              {!finalized && (
                <button className="btn btn-ghost btn-sm" onClick={() => insertMissing('add')} disabled={busy || typing || splitMonth}>Add missing staff</button>
              )}
            </div>
          )}

          {/* Action bar */}
          <div className="card no-print" style={{ marginBottom: 14, display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <button className="btn btn-ghost" onClick={exportRegister} disabled={busy}>⬇ Register</button>
            <button className="btn btn-ghost" onClick={() => exportBank('xlsx')} disabled={busy}>⬇ Bank Excel</button>
            <button className="btn btn-ghost" onClick={() => exportBank('csv')} disabled={busy}>⬇ Bank CSV</button>
            {!finalized && <button className="btn btn-ghost" onClick={regenerate} disabled={busy || typing}>↻ Recompute</button>}
            {!finalized && <button className="btn btn-primary" onClick={() => setStatus('finalized')} disabled={!canFinalize}>Finalize</button>}
            {/* hasHrAccess('manager'), not isAdmin: `isAdmin` is the Crest platform operator, while
                the tenant's own Owner is `isOwner` — both resolve hrRole to 'manager'. Gating this on
                isAdmin made a client contact support to reopen their own finalized run. */}
            {anyFinalized && hasHrAccess('manager') && <button className="btn btn-ghost" onClick={() => setStatus('draft')} disabled={busy || typing}>Reopen</button>}
          </div>

          {/* Table */}
          <div className="card" style={{ padding: 0 }}>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th style={{ textAlign: 'right' }}>
                      <Tip text="Monthly basic salary, or the daily/hourly rate for wage staff — as it was when the run was generated or last recomputed." width={250}>Basic / Rate</Tip>
                    </th>
                    <th style={{ textAlign: 'right' }}>
                      <Tip text={`Completed months worked up to the festival (15 ${monthName}, max 12). Allowance = basic × months ÷ 12 for monthly staff — someone who joined 6 months before gets half a month's basic.`} width={290}>Months</Tip>
                    </th>
                    <th style={{ textAlign: 'right' }}>
                      <Tip text="The festival allowance before tax. Editable while draft. Daily and hourly staff have no monthly basic to share out, so type their amount by hand." width={260}>Gross</Tip>
                    </th>
                    <th style={{ textAlign: 'right' }}>
                      <Tip text="Income tax held back from this allowance. Tax is worked out on the whole year: this year’s salary so far, the salary still to come, and other bonuses already paid — so a cook who already earns into a higher band pays that band's rate on the allowance too. Worked out again when you change the amount; you can also type it while draft." width={320}>Income tax (TDS)</Tip>
                    </th>
                    <th style={{ textAlign: 'right' }}>
                      <Tip text="Net amount to transfer (gross − income tax). This is the bank transfer amount." width={240}>Net</Tip>
                    </th>
                    <th>Note</th>
                    {!finalized && <th className="no-print"><span className="sr-only">Actions</span></th>}
                  </tr>
                </thead>
                <tbody>
                  {sortedRows.map(r => {
                    const e           = empMap.get(r.employee_id) || {}
                    const excluded    = isExcluded(r)
                    const editable    = r.status === 'draft' && !excluded
                    const isMonthly   = (r.pay_basis || 'monthly') === 'monthly'
                    const missingBank = !e.bank_name || !e.bank_account_no
                    const net         = (parseFloat(r.amount) || 0) - (parseFloat(r.tds) || 0)
                    const reason      = excluded ? null : reasonFor(r)
                    const needsAmount = !excluded && !isMonthly && !(parseFloat(r.amount) > 0)
                    const estimate    = (parseFloat(r.amount) || 0) > 0 && !(ytdMap[r.employee_id]?.months > 0)
                    return (
                      <tr key={r.id}>
                        <td>
                          <div style={{ fontWeight: 600, color: excluded ? 'var(--theme-text2)' : 'var(--theme-text1)', fontSize: 13, whiteSpace: 'nowrap' }}>{nameOf(r.employee_id)}</div>
                          <div style={{ display: 'flex', gap: 6, marginTop: 2, alignItems: 'center', flexWrap: 'wrap' }}>
                            {e.employee_code && <span style={{ fontSize: 10, color: 'var(--theme-text2)' }}>{e.employee_code}</span>}
                            {!isMonthly && <span className="badge badge-gray" style={{ fontSize: 10, fontWeight: 700 }}>{r.pay_basis}</span>}
                            {excluded && (
                              <Tip text="Taken out of this run on purpose: paid nothing from it, not offered again as missing staff, and it does not hold up Finalize." width={260} style={{ display: 'inline-flex', borderBottom: 'none', cursor: 'default' }}>
                                <span className="badge badge-gray" style={{ fontSize: 10 }}>Excluded</span>
                              </Tip>
                            )}
                            {reason && <span className="badge badge-amber" style={{ fontSize: 10 }}>{reason}</span>}
                            {needsAmount && !reason && <span className="badge badge-amber" style={{ fontSize: 10 }}>amount needed</span>}
                            {missingBank && !excluded && <span style={{ fontSize: 10, color: 'var(--theme-amber-text)' }}>⚠ no bank</span>}
                          </div>
                        </td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>{fmt(r.basic)}</td>
                        <td style={{ textAlign: 'right', color: r.months_worked < 12 ? 'var(--theme-text1)' : 'var(--theme-text3)', fontWeight: r.months_worked < 12 ? 600 : 400 }}>{r.months_worked}</td>
                        <td style={{ textAlign: 'right' }}>
                          {!editable
                            ? <span style={{ color: excluded ? 'var(--theme-text3)' : 'var(--theme-text1)', fontWeight: 700 }}>{excluded ? '—' : fmt(r.amount)}</span>
                            : <MoneyInput key={`${r.id}:amount`} aria-label={`Gross festival allowance for ${nameOf(r.employee_id)}`} value={r.amount} onCommit={(raw, reset) => updateAmount(r, raw, reset)} disabled={busy} style={{ ...inp, width: 110, textAlign: 'right', fontWeight: 600 }} />}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          {!editable
                            ? <span style={{ color: r.tds > 0 ? 'var(--theme-text1)' : 'var(--theme-text2)' }}>{r.tds > 0 ? fmt(r.tds) : '—'}</span>
                            : <MoneyInput key={`${r.id}:tds`} aria-label={`Income tax for ${nameOf(r.employee_id)}`} value={r.tds} onCommit={(raw, reset) => updateTds(r, raw, reset)} disabled={busy} style={{ ...inp, width: 90, textAlign: 'right' }} />}
                          {estimate && (
                            <div style={{ fontSize: 10, color: 'var(--theme-text3)', marginTop: 2 }}>
                              <Tip text="No payroll month has been finalized for this person yet this tax year, so their tax is worked out from salary alone. It is flagged for an update once payroll months are finalized." width={280}>estimate</Tip>
                            </div>
                          )}
                        </td>
                        <td style={{ textAlign: 'right', color: net > 0 ? 'var(--theme-text1)' : 'var(--theme-text3)', fontWeight: 600 }}>
                          {net > 0 ? fmt(net) : '—'}
                        </td>
                        <td>
                          {!editable
                            ? <span style={{ color: 'var(--theme-text2)', fontSize: 12 }}>{excluded ? '—' : (r.note || '—')}</span>
                            : <input key={`${r.id}:note`} aria-label={`Note for ${nameOf(r.employee_id)}`} defaultValue={r.note || ''} onBlur={ev => updateNote(r, ev.target.value)} placeholder="—" disabled={busy} style={{ ...inp, width: '100%' }} />}
                        </td>
                        {!finalized && (
                          <td className="no-print" style={{ textAlign: 'right' }}>
                            {r.status === 'draft' && excluded && (
                              <button className="btn btn-ghost btn-sm" onClick={() => includeRow(r)} disabled={busy}>Include again</button>
                            )}
                            {editable && (reason || needsAmount) && (
                              <button className="btn btn-ghost btn-sm" onClick={() => excludeRow(r)} disabled={busy}>Remove from this run</button>
                            )}
                          </td>
                        )}
                      </tr>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr style={{ fontWeight: 700, borderTop: '2px solid var(--theme-border)' }}>
                    <td colSpan={3} style={{ color: 'var(--theme-text2)' }}>Total — {payRows.length}{excludedRows.length ? ` (+${excludedRows.length} excluded)` : ''}</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-text1)', fontSize: 15 }}>{fmt(total)}</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-text1)', fontSize: 15 }}>{totalTds > 0 ? fmt(totalTds) : '—'}</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-text1)', fontSize: 15 }}>{fmt(total - totalTds)}</td>
                    <td></td>
                    {!finalized && <td className="no-print"></td>}
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
          <div style={{ marginTop: 12, fontSize: 11, color: 'var(--theme-text2)', lineHeight: 1.6 }}>
            Monthly staff get basic × completed months worked up to 15 {monthName} ÷ 12. Daily/hourly staff are typed by hand.
            Income tax is worked out for the {fyLabel(fyStart)} tax year, counting salary already paid, salary still to come and other bonuses finalized for earlier months of the year.
            Press Recompute after a raise; it keeps daily/hourly amounts and excluded staff.
          </div>
        </>
      )}
      {confirmEl}
    </div>
  )
}
