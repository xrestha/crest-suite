import { nprInt } from '../../../shared/nepalMoney'
import { useState, useEffect, useRef } from 'react'
import { useNavigate, Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import Tip from '../../../components/Tip'
import { BS_MONTHS, formatBsDay, bsDayOrdinal, getBsToday, adToBsSafe } from '../../../utils/bsCalendar'
import { parseAdDateLocal } from '../../../shared/nepalTime'
import { useHrApprovalCounts } from './useHrApprovalCounts'
import { SSF_DEPOSIT_DAY } from '../payrollConstants'
import PayrollMonthStatus from '../payroll/PayrollMonthStatus'
import { ssfDeadline } from '../payroll/monthStatus'
import { fetchMonthDepositExtras, monthDeposit } from '../payroll/monthDeposit'
import { useWeatherStrip } from '../../dashboard/useWeatherStrip'
import WeatherHeaderSlot from '../../../pages/dashboard/WeatherHeaderSlot'
import HrLabourPanel from './HrLabourPanel'
import { settleWithin } from '../../../utils/withTimeout'

// Each read is bounded on its own (S803): the page's two Promise.all batches had no limit, so one
// request that never answered left the skeleton and "Loading dashboard data…" up for ever, with no
// Retry, while the labour panel below already bounded its own. A timed-out read comes back as that
// read's own `error`, so every tile's existing "unavailable" rendering and the Retry banner handle it.
const READ_MS = 20000
const bounded = q => settleWithin(q, READ_MS, 'Loading the HR dashboard')

const fmt = nprInt
// A leave day in BS, as the Leave page prints it — "17 Ashwin 2083" (S798 REPORTS-9; this queue
// printed "3 Oct" while the page it links to said Ashwin). A stored date is read as a LOCAL day.
function fmtBsDate(iso) {
  if (!iso) return '—'
  const bs = adToBsSafe(parseAdDateLocal(iso))
  return bs ? `${bs.day} ${BS_MONTHS[bs.month - 1]} ${bs.year}` : `${String(iso).slice(0, 10)} (AD)`
}

function nextMonthLabel(bs_year, bs_month) {
  if (!bs_year || !bs_month) return '—'
  const nm = bs_month === 12 ? 1   : bs_month + 1
  const ny = bs_month === 12 ? bs_year + 1 : bs_year
  return `${BS_MONTHS[nm - 1]} ${SSF_DEPOSIT_DAY}, ${ny}`
}

// SSF is due by the 25th of the month following the payroll period (SSF_DEPOSIT_DAY — it was the
// 15th until the July 2025 amendment, and this card said 15 until S748). Returns how that deadline
// stands relative to today, so the card can be quiet when there is nothing to do — it used to
// render red unconditionally, which meant a healthy account with weeks of runway showed the same
// colour as one that had missed the deposit. Callers must also gate this on the deposit amount
// being > 0 — a client with no SSF-enrolled staff has nothing to deposit, so a passed due day is not
// a missed deadline, just an inapplicable one.
// A passed date is `passed`, never red (S798 REPORTS-6): Crest does not record deposits, so a date
// gone by proves nothing, and red here every month from the 26th taught the owner to ignore the
// one card that could flag a missed deposit. The month strip says it the same way (S768).
function ssfDeadlineState(bs_year, bs_month) {
  if (!bs_year || !bs_month) return {}
  // One definition of the deadline, shared with the payroll month strip (monthStatus.js, S768).
  const d = ssfDeadline(bs_year, bs_month)
  if (d.overdue) return { passed: true }
  // Same month as the deadline, on or before the due day: it is now the live task.
  if (d.dueThisMonth) return { alert: true }
  return {}
}

// Days left to the SSF deposit while it is the live task (the due month, on or before the due day).
function ssfDaysLeftText(today = getBsToday()) {
  const left = SSF_DEPOSIT_DAY - today.day
  return left <= 0 ? 'due today' : `${left} day${left === 1 ? '' : 's'} left`
}

// Clickable KPI card — role/tabIndex/onKeyDown + .interactive-card give keyboard users the same
// access mouse users already had; this one shared component fixes every KCard instance at once.
// `alert` means "needs attention", which in this design system is AMBER — red means overdue or
// failed. Every pending-approval card passes it, and a queue waiting on a manager is not an error
// state; painting them red alongside genuinely-late things trains the reader to discount red.
// Every group on this page is announced by one of these, so the label and the 8px it holds above
// the group it names are a single decision rather than seven copies of a six-property style
// object. The page's cadence is 8px from a label to its own content, 28px from one group to the
// next (.stat-grid's own margin) - a 3.5x contrast, which is what makes the groups separate when
// the page is squinted at. All seven are h2: they are peer sections of the page, not subsections
// of one another, and the four queue panels were h3 with no h2 anywhere above them to hang off.
function SectionLabel({ children }) {
  return (
    <h2 style={{
      fontSize: 11, fontWeight: 700, margin: '0 0 8px', color: 'var(--theme-text3)',
      letterSpacing: '0.08em', textTransform: 'uppercase',
    }}>{children}</h2>
  )
}

// A card that opens a page holds a Tip, which is a control of its own, so the card cannot be
// role="button" (S803; page-layout.md: a card that holds controls puts the affordance on its
// children). The card keeps the mouse click; the figure is the real button, named "<label>: <value>",
// which is the keyboard and screen-reader way in.
function KCard({ label, value, sub, color = 'var(--theme-text1)', tip, onClick, alert }) {
  const valueStyle = { color, fontSize: typeof value === 'string' && value.length > 8 ? 16 : undefined }
  return (
    <div
      className={onClick ? 'stat-card interactive-card' : 'stat-card'}
      onClick={onClick}
      style={onClick ? { cursor: 'pointer' } : undefined}
    >
      <div className="stat-label">
        {tip ? <Tip text={tip} width={260}>{label}</Tip> : label}
      </div>
      {onClick ? (
        <button type="button" className="stat-card__open" onClick={e => { e.stopPropagation(); onClick() }}>
          <span className="sr-only">{label}: </span>
          <span className="stat-value" style={valueStyle}>{value}</span>
        </button>
      ) : (
        <div className="stat-value" style={valueStyle}>{value}</div>
      )}
      {sub && <div className="stat-sub" style={alert ? { color: 'var(--theme-amber-text)' } : undefined}>{sub}</div>}
    </div>
  )
}

export default function HrDashboard() {
  const { clientId, hasHrAccess } = useAuth()
  const { scopedFrom } = useScopedDb()
  const navigate     = useNavigate()
  const [loading, setLoading] = useState(true)

  const [empStats,    setEmpStats]    = useState(null)
  const [leaveList,   setLeaveList]   = useState([])
  const [otList,      setOtList]      = useState([])
  const [tadaList,    setTadaList]    = useState([])
  const [swapList,    setSwapList]    = useState([])
  // Which preview lists could not be read (S768). Each rendered "No pending … ✓" over a failed read —
  // the queue a manager most needs to open, telling them it is clear.
  const [listErrors,  setListErrors]  = useState({})
  const [payInfo,     setPayInfo]     = useState(null)
  // The last-run read itself failed (S798 REPORTS-5) — not "no run yet", which is a claim about the
  // client. The section shows its cards unread instead of the empty-state card.
  const [payRunFailed, setPayRunFailed] = useState(false)
  const [advOutstanding, setAdvOutstanding] = useState(0)
  const [empMap,      setEmpMap]      = useState({})
  const [typeMap,     setTypeMap]     = useState({})
  const pendingCounts = useHrApprovalCounts() // shared with ClientDashboard.jsx's HR column
  // The weather strip (S786, owner decision): rain changes how many staff a shift needs, and this is
  // the page staffing is run from. Same hook and slot as the main Dashboard, without the sales
  // chart's "×N%" tags, which belong to that chart.
  const location = useLocation()
  const weatherStrip = useWeatherStrip({ refreshKey: location.key })
  // Guards against a stale response overwriting the current view — load() had no cancellation
  // check, so switching "view as" client rapidly enough could let a slower response for the
  // PREVIOUS client land last and silently repaint this screen with the wrong tenant's approval
  // counts/SSF figures — exactly the numbers an admin acts on directly from this page.
  const loadIdRef = useRef(0)
  // load() used to destructure only { data } from every query and silently discard { error } — a
  // failed query just zeroed out its stat/emptied its list, indistinguishable from "this client
  // genuinely has none," with no indication anything had actually gone wrong.
  const [loadError, setLoadError] = useState('')

  useEffect(() => {
    if (!clientId) { setLoading(false); return }
    // Rank check BEFORE the fetch, not just before the final render. load() pulls basic_salary,
    // payslip net pay, employer SSF and named pending requests — so an hr_role='staff' account
    // used to trigger the entire query set and see the header and skeleton, and was only bounced
    // once loading finished. Same shape as the S430 leak, inverted: the guard existed but sat
    // downstream of the thing it was guarding.
    if (!hasHrAccess('supervisor')) { setLoading(false); return }
    load(++loadIdRef.current)
  }, [clientId]) // eslint-disable-line

  async function load(myId) {
    setLoading(true)

    const results = await Promise.all([
      bounded(scopedFrom('hr_employees', 'id, full_name, status, retirement_date, basic_salary, pay_basis')),
      bounded(scopedFrom('hr_leave_types', 'id, name')),
      bounded(scopedFrom('hr_leave_requests', 'id, employee_id, leave_type_id, status, start_date, end_date, created_at')
        .eq('status', 'pending')
        .order('created_at', { ascending: false }).limit(8)),
      bounded(scopedFrom('hr_overtime_entries', 'id, employee_id, bs_year, bs_month, bs_day, ot_hours, ot_type, created_at')
        .eq('status', 'pending')
        .order('created_at', { ascending: false }).limit(8)),
      bounded(scopedFrom('hr_tada_claims', 'id, employee_id, trip_purpose, destination, total_amount, start_date, end_date, created_at')
        .eq('status', 'pending')
        .order('created_at', { ascending: false }).limit(8)),
      // Only pending_admin needs a manager action — pending_target is still waiting on the
      // coworker's own accept/decline, same filter SwapRequestsPanel.jsx uses.
      bounded(scopedFrom('hr_shift_swap_requests', 'id, requester_employee_id, target_employee_id, bs_year, bs_month, requester_bs_day, target_bs_day, created_at')
        .eq('status', 'pending_admin')
        .order('created_at', { ascending: false }).limit(8)),
      bounded(scopedFrom('hr_payroll_runs', 'id, period_id, monthly_periods(bs_year, bs_month)')
        .eq('status', 'finalized')
        .order('created_at', { ascending: false }).limit(1)),
      // Both sides of the Advances Outstanding KPI are paged. `hr_advance_repayments` is an
      // unfiltered lifetime ledger — one row per advance per payroll month — so it crosses the
      // 1000-row cap first, and because outstanding is `amount − repaid`, truncating the
      // repayments side alone makes the dashboard OVERSTATE what staff still owe. `.order('id')`
      // is the unique tiebreaker fetchAllRows requires.
      bounded(fetchAllRows(() => scopedFrom('hr_advances', 'id, amount').eq('status', 'active').order('id'))),
      bounded(fetchAllRows(() => scopedFrom('hr_advance_repayments', 'advance_id, amount').order('id'))),
    ])
    if (loadIdRef.current !== myId) return // superseded by a newer client switch

    const [
      { data: emps, error: empsErr },
      { data: ltypes },
      { data: leaves, error: leavesErr },
      { data: otPending, error: otErr },
      { data: tadaPending, error: tadaErr },
      { data: swapPending, error: swapErr },
      { data: runs, error: runsErr },
      { data: advs, error: advsErr },
      { data: reps, error: repsErr },
    ] = results
    let hadRealError = results.some(r => r.error)

    // ── Employee stats ─────────────────────────────────────────────────────────
    const todayMs = new Date().setHours(0, 0, 0, 0)
    const RETIRE_DAYS = 180
    let payrollBase = 0, retiringSoon = 0
    ;(emps || []).forEach(e => {
      // Monthly-paid only — a daily/hourly basic_salary is a rate, not a month's pay (S750).
      if ((e.status === 'active' || e.status === 'probation') && (e.pay_basis || 'monthly') === 'monthly') payrollBase += parseFloat(e.basic_salary || 0)
      if (e.retirement_date && (e.status === 'active' || e.status === 'probation')) {
        // retirement_date is a bare YYYY-MM-DD — `new Date(...)` on that parses as UTC midnight,
        // while todayMs above is LOCAL midnight. In Nepal (UTC+5:45) that's a ~5h45m mismatch,
        // which can flip `days` across the 180-day threshold for someone retiring right around
        // it. Parse the Y-M-D components directly into a LOCAL date instead, matching todayMs.
        const [ry, rm, rd] = e.retirement_date.split('-').map(Number)
        const retireMs = new Date(ry, rm - 1, rd).getTime()
        const days = Math.round((retireMs - todayMs) / 86400000)
        if (days >= 0 && days <= RETIRE_DAYS) retiringSoon++
      }
    })
    // A failed employee read leaves empStats NULL rather than a set of zeros (S734). The KCards
    // below already render `—` for a null and had no way to reach it: `emps` comes back null on
    // a refusal, every `(emps || [])` collapsed to an empty array, and the Headcount row then
    // asserted "Active Staff 0" in GREEN over "no probation", plus "Basic Payroll / Month
    // NPR 0". The page banner said a read had failed; the tiles said the business had no staff
    // and no wage bill, in the vocabulary this page reserves for good news. Same shape as the
    // approval counts above — an unread figure must not borrow a settled one's colour.
    setEmpStats(empsErr ? null : {
      total:      (emps || []).length,
      active:     (emps || []).filter(e => e.status === 'active').length,
      probation:  (emps || []).filter(e => e.status === 'probation').length,
      payrollBase,
      retiringSoon,
    })

    // ── Lookup maps ────────────────────────────────────────────────────────────
    const eMap = Object.fromEntries((emps || []).map(e => [e.id, e.full_name]))
    const tMap = Object.fromEntries((ltypes || []).map(t => [t.id, t.name]))
    setEmpMap(eMap)
    setTypeMap(tMap)

    // ── Leave + OT + TADA + Swap queues ────────────────────────────────────────
    setListErrors({ leave: !!leavesErr, ot: !!otErr, tada: !!tadaErr, swap: !!swapErr })
    setLeaveList(leaves || [])
    setOtList(otPending || [])
    setTadaList(tadaPending || [])
    setSwapList(swapPending || [])

    // ── Advances outstanding ───────────────────────────────────────────────────
    const repMap = {}
    ;(reps || []).forEach(r => { repMap[r.advance_id] = (repMap[r.advance_id] || 0) + parseFloat(r.amount || 0) })
    const outstanding = (advs || []).reduce((s, a) => s + Math.max(0, parseFloat(a.amount || 0) - (repMap[a.id] || 0)), 0)
    // NULL on a failed read of EITHER side, never a figure (S751). A failed advances read summed
    // nothing and printed "NPR 0" — the one value on this tile that tells a manager nobody owes the
    // company anything. A failed repayments read is the opposite lie: every active advance counted
    // as fully owed. `.eq('status','active')` above already leaves written-off and settled out.
    setAdvOutstanding(advsErr || repsErr ? null : outstanding)

    // ── Last finalized payroll ─────────────────────────────────────────────────
    setPayRunFailed(!!runsErr)
    if (runsErr) setPayInfo(null)
    const lastRun = runsErr ? null : runs?.[0]
    if (lastRun) {
      const mp = lastRun.monthly_periods
      // The SSF cards are the month's deposit (S798 REPORTS-2): a leaver settled in the month is not
      // on the run, but their Final Settlement deducted the final month's SSF, and the SSF challan
      // these cards link to adds it. A failed read of either half shows no figure, as below.
      const [{ data: slips, error: slipsErr }, extras] = await Promise.all([
        bounded(scopedFrom('hr_payslips', 'net_pay, ssf_employee, ssf_employer').eq('run_id', lastRun.id)),
        mp ? bounded(fetchMonthDepositExtras(scopedFrom, mp)) : { data: { settlements: [], bonuses: [] }, error: null },
      ])
      if (loadIdRef.current !== myId) return // superseded again after this extra await
      hadRealError = hadRealError || slipsErr || extras.error
      const ssf = slipsErr || extras.error ? null : monthDeposit({ payslips: slips, ...extras.data }).ssf
      setPayInfo({
        // A failed payslip read is not a run that paid nothing (S768): the four cards below used to
        // total an empty list and say "no staff enrolled in SSF this period" over real deductions.
        failed:       !!slipsErr,
        ssfFailed:    !ssf,
        periodId:     lastRun.period_id,
        periodLabel:  mp ? `${BS_MONTHS[mp.bs_month - 1]} ${mp.bs_year}` : '—',
        netPay:       (slips || []).reduce((s, x) => s + (x.net_pay       || 0), 0),
        ssfEmployee:  ssf?.employee || 0,
        ssfEmployer:  ssf?.employer || 0,
        ssfSettled:   ssf?.settledNames || [],
        bsYear:       mp?.bs_year,
        bsMonth:      mp?.bs_month,
        count:        (slips || []).length,
      })
    }

    setLoadError(hadRealError ? 'Some dashboard data failed to load — figures below may be incomplete or stale.' : '')
    setLoading(false)
  }

  // Redirect first, above the loading return — otherwise an ineligible account renders the page
  // header and skeleton for the duration of a fetch that should never have started.
  if (!hasHrAccess('supervisor')) return <Navigate to="/dashboard" replace />

  // A skeleton mirroring the page's real layout (header + 3 stat-grid rows) instead of a plain
  // "Loading…" text block — consistent with the per-KPI skeleton pattern used elsewhere on the
  // client and owner dashboards.
  if (loading) return (
    <div>
      {/* Screen-reader-only announcement — the visible loading state is a shimmering skeleton,
          which on its own gives no indication to a screen reader that the page is still loading. */}
      <div role="status" aria-live="polite" className="sr-only">Loading dashboard data…</div>
      {/* Both returns carry the weather slot, so the header does not jump when the data lands. */}
      <div className={weatherStrip.visible ? 'page-header page-header--split' : 'page-header'}>
        <div>
          <h1 className="page-title">HR Dashboard</h1>
          <p className="page-subtitle">Headcount · Payroll · Approval queues · SSF · Advances at a glance</p>
        </div>
        <WeatherHeaderSlot strip={weatherStrip} />
      </div>
      {[0, 1, 2].map(row => (
        <div key={row} className="stat-grid dash-section">
          {[0, 1, 2, 3].map(card => (
            <div key={card} className="stat-card">
              <span className="skeleton" style={{ display: 'block', width: '60%', height: 11, marginBottom: 8 }} />
              <span className="skeleton" style={{ display: 'block', width: '40%', height: 24 }} />
            </div>
          ))}
        </div>
      ))}
    </div>
  )

  const pendingLeave = pendingCounts.leave
  const pendingOt    = pendingCounts.ot
  const pendingTada  = pendingCounts.tada
  const pendingSwap  = pendingCounts.swap
  const pendingTotal = pendingLeave + pendingOt + pendingTada + pendingSwap
  // A failed count read is not an empty queue (S734). The hook now says so instead of handing
  // back a zero, and these four cards must not spend the word "all clear" or the colour green on
  // a number nobody computed — that is the reassurance a manager acts on by NOT opening the page.
  const approvalsFailed = pendingCounts.error
  // The three parts of a pending-approval card that all turn on the same question, stated once so
  // the four call sites below can only differ where a difference is meant.
  const approvalCard = (n, clearSub) => approvalsFailed
    ? { value: '—', sub: 'count unavailable — open the page', color: 'var(--theme-text2)', alert: false }
    : { value: n, sub: n > 0 ? clearSub : 'all clear', color: n > 0 ? 'var(--theme-amber-text)' : 'var(--theme-green-text)', alert: n > 0 }

  return (
    <div>
      {/* Says so when a read failed (S803): it announced "loaded" over a partial page. */}
      <div role="status" aria-live="polite" className="sr-only">{loadError ? 'Dashboard loaded with errors — some figures could not be read' : 'Dashboard data loaded'}</div>
      {/* Both returns carry the weather slot, so the header does not jump when the data lands. */}
      <div className={weatherStrip.visible ? 'page-header page-header--split' : 'page-header'}>
        <div>
          <h1 className="page-title">HR Dashboard</h1>
          <p className="page-subtitle">Headcount · Payroll · Approval queues · SSF · Advances at a glance</p>
        </div>
        <WeatherHeaderSlot strip={weatherStrip} />
      </div>

      {/* A load failure used to be indistinguishable from "this client genuinely has no data" —
          every query above silently discarded Supabase's error field. */}
      {loadError && (
        // role="alert" (dashboards.md: the load-error banner carries it) — a screen reader was told
        // nothing about a partial page (S803).
        <div role="alert" className="card dash-section" style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16,
          borderColor: 'color-mix(in srgb, var(--theme-red) 25%, transparent)',
          background: 'color-mix(in srgb, var(--theme-red) 8%, transparent)',
        }}>
          <p style={{ color: 'var(--theme-red-text)', margin: 0, fontSize: 13 }}>
            <span aria-hidden="true">⚠</span> {loadError}
          </p>
          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => load(++loadIdRef.current)}>Retry</button>
            <button
              className="btn btn-ghost" style={{ fontSize: 12 }}
              onClick={() => setLoadError('')} aria-label="Dismiss"
            >×</button>
          </div>
        </div>
      )}

      {/* Where the live payroll month stands, as linked steps (S768). Managers only, because every
          step links to a manager page. Not a read fence: manager rank fences payroll WRITES, and a
          supervisor reads runs and payslips by the S750 decision (REPORTS-10). */}
      {hasHrAccess('manager') && <PayrollMonthStatus auto />}

      {/* ── KPI Row 1 — Approvals (everything a staff submission needs a manager to act on) ── */}
      <SectionLabel>
        Approvals {approvalsFailed
          ? <span style={{ color: 'var(--theme-red-text)' }}>(counts unavailable)</span>
          : pendingTotal > 0 && <span style={{ color: 'var(--theme-amber-text)' }}>({pendingTotal} pending)</span>}
      </SectionLabel>
      <div className="stat-grid dash-section">
        <KCard
          label="Leave Pending"
          {...approvalCard(pendingLeave, 'awaiting approval')}
          tip="Leave requests with status Pending — click to go to the Leave page and approve or reject."
          onClick={() => navigate('/hr/leave')}
        />
        <KCard
          label="OT Pending"
          {...approvalCard(pendingOt, 'awaiting approval')}
          tip="Overtime entries not yet approved. Only approved OT feeds into payroll — approve before running payroll."
          onClick={() => navigate('/hr/overtime')}
        />
        <KCard
          label="TADA Pending"
          {...approvalCard(pendingTada, 'awaiting approval')}
          tip="TADA (travel/daily allowance) claims with status Pending, whether entered by a manager or submitted by the employee themselves via Self-Service — click to go to TADA Claims and approve or reject."
          onClick={() => navigate('/hr/tada')}
        />
        <KCard
          label="Swap Pending"
          {...approvalCard(pendingSwap, 'awaiting your approval')}
          tip="Shift swap requests where the coworker has already accepted and it's now waiting on manager approval (requests still waiting on the coworker aren't shown here — nothing for a manager to do yet)."
          onClick={() => navigate('/hr/roster')}
        />
      </div>

      {/* ── KPI Row 2 — Headcount ───────────────────────────────────────────── */}
      <SectionLabel>Headcount</SectionLabel>
      <div className="stat-grid dash-section">
        <KCard
          label="Active Staff"
          value={empStats?.active ?? '—'}
          sub={!empStats ? 'headcount unavailable' : empStats.probation > 0 ? `+ ${empStats.probation} on probation` : 'no probation'}
          color={empStats ? 'var(--theme-green-text)' : 'var(--theme-text2)'}
          tip="Active employees only. Probation shown separately — both are included in payroll."
          onClick={() => navigate('/hr/employees')}
        />
        <KCard
          label="Basic Payroll / Month"
          value={empStats ? `NPR ${fmt(empStats.payrollBase)}` : '—'}
          sub={empStats ? 'monthly-paid staff, basic only' : 'could not be read'}
          color={empStats ? 'var(--theme-accent-ink)' : 'var(--theme-text2)'}
          tip="Sum of basic salary for active and probation employees paid monthly. Daily and hourly staff are left out: their rate is not a month's pay. Full payroll (allowances, SSF, TDS) is computed during the payroll run."
          onClick={() => navigate('/hr/payroll')}
        />
        <KCard
          label="Advances Outstanding"
          value={advOutstanding == null ? '—' : `NPR ${fmt(advOutstanding)}`}
          sub={advOutstanding == null ? 'count unavailable — open the page' : 'active advance & loan balances'}
          color={advOutstanding == null ? 'var(--theme-text2)' : undefined}
          tip="What staff still owe on advances and loans that are being recovered from salary. Written-off balances are not counted."
          onClick={() => navigate('/hr/advances')}
        />
        <KCard
          label="Retiring Soon"
          value={empStats?.retiringSoon ?? '—'}
          sub={empStats ? 'within 180 days' : 'could not be read'}
          color={!empStats ? 'var(--theme-text2)' : empStats.retiringSoon > 0 ? 'var(--theme-accent-ink)' : 'var(--theme-green-text)'}
          tip="Active or probation employees whose retirement date (DOB + 60 years) falls within the next 180 days."
          onClick={() => navigate('/hr/employees')}
          alert={empStats?.retiringSoon > 0}
        />
      </div>

      {/* ── Payroll + SSF ───────────────────────────────────────────────────── */}
      {payInfo && (() => {
        // The SSF cards are the month's deposit: payslips plus that month's Final Settlements. Either
        // read failing shows no SSF figure rather than the payslips-only one (S798 REPORTS-2).
        const ssfUnread = payInfo.failed || payInfo.ssfFailed
        const settledSsf = payInfo.ssfSettled.length > 0
        return (
        <>
          <SectionLabel>
            Last Finalized Payroll — {payInfo.periodLabel} ({payInfo.count} employees)
          </SectionLabel>
          <div className="stat-grid dash-section">
            <KCard
              label="Net Payable"
              value={payInfo.failed ? '—' : `NPR ${fmt(payInfo.netPay)}`}
              sub={payInfo.failed ? 'payslips could not be read' : `${payInfo.periodLabel} take-home total`}
              color={payInfo.failed ? 'var(--theme-text2)' : undefined}
              tip="Total net pay disbursed to all employees in the last finalized payroll run."
              onClick={() => navigate('/hr/payroll')}
            />
            <KCard
              label="SSF — Employee (11%)"
              value={ssfUnread ? '—' : `NPR ${fmt(payInfo.ssfEmployee)}`}
              sub={ssfUnread ? 'could not be read' : settledSsf ? 'deducted from pay, incl. a Final Settlement' : 'deducted from payslips'}
              tip="Total employee SSF contributions (11% of capped basic) deducted this month — from the payslips, and from the final month of anyone whose Final Settlement was in this month."
            />
            <KCard
              label="SSF — Employer (20%)"
              value={ssfUnread ? '—' : `NPR ${fmt(payInfo.ssfEmployer)}`}
              sub={ssfUnread ? 'could not be read' : 'company contribution'}
              tip="Total employer SSF contribution (20% of capped basic) — paid by the company on top of net pay, including a leaver's final month paid by Final Settlement."
            />
            {(() => {
              const ssfTotal = payInfo.ssfEmployee + payInfo.ssfEmployer
              // Nothing owed (no SSF-enrolled staff this run) means a passed due day isn't a missed
              // deadline — stay neutral instead of painting a NPR 0 deposit red.
              const deadline = ssfTotal > 0 && !ssfUnread ? ssfDeadlineState(payInfo.bsYear, payInfo.bsMonth) : {}
              return (
                <KCard
                  label="SSF Total to Deposit"
                  value={ssfUnread ? '—' : `NPR ${fmt(ssfTotal)}`}
                  sub={ssfUnread ? `due by ${nextMonthLabel(payInfo.bsYear, payInfo.bsMonth)} — amount could not be read` : ssfTotal === 0
                    ? 'no staff or leavers in SSF this period'
                    : deadline.passed
                      ? `Was due by ${nextMonthLabel(payInfo.bsYear, payInfo.bsMonth)}`
                      // The countdown (S800): only in the month it falls due, and never "missed" —
                      // deposits are not recorded, so a passed date is not proof of anything.
                      : deadline.alert
                        ? `Deposit by ${nextMonthLabel(payInfo.bsYear, payInfo.bsMonth)} — ${ssfDaysLeftText()}`
                        : `Deposit by ${nextMonthLabel(payInfo.bsYear, payInfo.bsMonth)}`}
                  tip={`SSF challan (employee 11% + employer 20%) for ${payInfo.periodLabel}: the payslips plus the final month of anyone whose Final Settlement was in ${payInfo.periodLabel}${settledSsf ? ` (${payInfo.ssfSettled.join(', ')})` : ''}. Deposit with SSF by the ${SSF_DEPOSIT_DAY}th of the following month — late deposits attract 10% interest.${deadline.passed ? ' Crest does not record SSF deposits, so a date that has passed does not mean the deposit was missed.' : ''} Go to HR Reports → SSF Challan for the per-employee breakdown.`}
                  onClick={() => navigate(`/hr/reports?tab=ssf${payInfo.periodId ? `&period=${payInfo.periodId}` : ''}`)}
                  alert={deadline.alert}
                />
              )
            })()}
          </div>
        </>
        )
      })()}

      {payRunFailed && (
        <>
          <SectionLabel>Last Finalized Payroll</SectionLabel>
          <div className="stat-grid dash-section">
            {['Net Payable', 'SSF — Employee (11%)', 'SSF — Employer (20%)', 'SSF Total to Deposit'].map(label => (
              <KCard key={label} label={label} value="—" sub="last finalized payroll could not be read" color="var(--theme-text2)" />
            ))}
          </div>
        </>
      )}

      {!payInfo && !payRunFailed && (
        <div className="card card--compact dash-section" style={{ fontSize: 13, color: 'var(--theme-text2)' }}>
          No finalized payroll yet. Generate and finalize a payroll run to see net pay and SSF summary here.
        </div>
      )}

      {/* Labour against sales (S800): the hospitality half of an HR home — what each finalized month
          of labour cost, and what share of that month's sales it was. Below the queues' summary
          rows, above the queues themselves. */}
      <HrLabourPanel />

      {/* ── Pending queues ───────────────────────────────────────────────────── */}
      <div className="panel-grid">

        {/* Leave queue */}
        <div>
          <SectionLabel>
            Pending Leave Requests {pendingLeave > 0 && <span style={{ color: 'var(--theme-amber-text)' }}>({pendingLeave})</span>}
          </SectionLabel>
          <div className="card" style={{ padding: 0 }}>
            {listErrors.leave ? (
              <div role="alert" style={{ padding: '18px 16px', fontSize: 13, color: 'var(--theme-text2)' }}>This list could not be loaded — open the page to see what is waiting.</div>
            ) : leaveList.length === 0 ? (
              <div style={{ padding: '18px 16px', fontSize: 13, color: 'var(--theme-text3)' }}>No pending leave requests ✓</div>
            ) : (
              <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Type</th>
                    <th>From</th>
                    <th>To</th>
                  </tr>
                </thead>
                <tbody>
                  {leaveList.map(r => (
                    <tr key={r.id}>
                      <td style={{ fontWeight: 600, fontSize: 12, color: 'var(--theme-text1)' }}>{empMap[r.employee_id] || '—'}</td>
                      <td style={{ fontSize: 12, color: 'var(--theme-text2)' }}>{typeMap[r.leave_type_id] || '—'}</td>
                      <td style={{ fontSize: 12, color: 'var(--theme-text3)', whiteSpace: 'nowrap' }}>{fmtBsDate(r.start_date)}</td>
                      <td style={{ fontSize: 12, color: 'var(--theme-text3)', whiteSpace: 'nowrap' }}>{fmtBsDate(r.end_date)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )}
          </div>
          {pendingLeave > 0 && (
            <button className="btn btn-ghost btn-sm" style={{ marginTop: 8 }} onClick={() => navigate('/hr/leave')}>
              Go to Leave → approve / reject
            </button>
          )}
        </div>

        {/* OT queue */}
        <div>
          <SectionLabel>
            Pending OT Entries {pendingOt > 0 && <span style={{ color: 'var(--theme-amber-text)' }}>({pendingOt})</span>}
          </SectionLabel>
          <div className="card" style={{ padding: 0 }}>
            {listErrors.ot ? (
              <div role="alert" style={{ padding: '18px 16px', fontSize: 13, color: 'var(--theme-text2)' }}>This list could not be loaded — open the page to see what is waiting.</div>
            ) : otList.length === 0 ? (
              <div style={{ padding: '18px 16px', fontSize: 13, color: 'var(--theme-text3)' }}>No pending OT entries ✓</div>
            ) : (
              <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th style={{ textAlign: 'center' }}>Date</th>
                    <th style={{ textAlign: 'center' }}>Hours</th>
                    <th>Type</th>
                  </tr>
                </thead>
                <tbody>
                  {otList.map(e => (
                    <tr key={e.id}>
                      <td style={{ fontWeight: 600, fontSize: 12, color: 'var(--theme-text1)' }}>{empMap[e.employee_id] || '—'}</td>
                      <td style={{ textAlign: 'center', fontSize: 12, color: 'var(--theme-text3)' }}>
                        {formatBsDay(e.bs_day, e.bs_month)}
                      </td>
                      <td style={{ textAlign: 'center', fontWeight: 600, color: 'var(--theme-green-text)', fontSize: 12 }}>{e.ot_hours}h</td>
                      <td>
                        {/* Which multiplier applies is a CATEGORY, not a status — brass, so amber can keep
                            meaning "this is waiting on you" in the Status column beside it. */}
                        <span className={e.ot_type === 'holiday' ? 'badge-yellow' : 'badge-gray'} style={{ fontSize: 10 }}>
                          {e.ot_type === 'holiday' ? 'Holiday 2×' : 'Weekday 1.5×'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )}
          </div>
          {pendingOt > 0 && (
            <button className="btn btn-ghost btn-sm" style={{ marginTop: 8 }} onClick={() => navigate('/hr/overtime')}>
              Go to Overtime → approve / reject
            </button>
          )}
        </div>

        {/* TADA queue */}
        <div>
          <SectionLabel>
            Pending TADA Claims {pendingTada > 0 && <span style={{ color: 'var(--theme-amber-text)' }}>({pendingTada})</span>}
          </SectionLabel>
          <div className="card" style={{ padding: 0 }}>
            {listErrors.tada ? (
              <div role="alert" style={{ padding: '18px 16px', fontSize: 13, color: 'var(--theme-text2)' }}>This list could not be loaded — open the page to see what is waiting.</div>
            ) : tadaList.length === 0 ? (
              <div style={{ padding: '18px 16px', fontSize: 13, color: 'var(--theme-text3)' }}>No pending TADA claims ✓</div>
            ) : (
              <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Trip</th>
                    <th style={{ textAlign: 'right' }}>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {tadaList.map(c => (
                    <tr key={c.id}>
                      <td style={{ fontWeight: 600, fontSize: 12, color: 'var(--theme-text1)' }}>{empMap[c.employee_id] || '—'}</td>
                      <td style={{ fontSize: 12, color: 'var(--theme-text2)' }}>{c.destination || c.trip_purpose || '—'}</td>
                      <td style={{ textAlign: 'right', fontWeight: 600, fontSize: 12, color: 'var(--theme-text1)' }}>{fmt(c.total_amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )}
          </div>
          {pendingTada > 0 && (
            <button className="btn btn-ghost btn-sm" style={{ marginTop: 8 }} onClick={() => navigate('/hr/tada')}>
              Go to TADA Claims → approve / reject
            </button>
          )}
        </div>

        {/* Shift swap queue */}
        <div>
          <SectionLabel>
            Pending Shift Swaps {pendingSwap > 0 && <span style={{ color: 'var(--theme-amber-text)' }}>({pendingSwap})</span>}
          </SectionLabel>
          <div className="card" style={{ padding: 0 }}>
            {listErrors.swap ? (
              <div role="alert" style={{ padding: '18px 16px', fontSize: 13, color: 'var(--theme-text2)' }}>This list could not be loaded — open the page to see what is waiting.</div>
            ) : swapList.length === 0 ? (
              <div style={{ padding: '18px 16px', fontSize: 13, color: 'var(--theme-text3)' }}>No pending shift swaps ✓</div>
            ) : (
              <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Requester ⇄ Target</th>
                    <th style={{ textAlign: 'center' }}>Days</th>
                  </tr>
                </thead>
                <tbody>
                  {swapList.map(s => (
                    <tr key={s.id}>
                      <td style={{ fontSize: 12, color: 'var(--theme-text2)' }}>
                        <span style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{empMap[s.requester_employee_id] || '—'}</span>
                        {' ⇄ '}
                        <span style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{empMap[s.target_employee_id] || '—'}</span>
                      </td>
                      <td style={{ textAlign: 'center', fontSize: 12, color: 'var(--theme-text3)' }}>
                        {bsDayOrdinal(s.requester_bs_day)} ⇄ {formatBsDay(s.target_bs_day, s.bs_month)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )}
          </div>
          {pendingSwap > 0 && (
            <button className="btn btn-ghost btn-sm" style={{ marginTop: 8 }} onClick={() => navigate('/hr/roster')}>
              Go to Roster → approve / reject
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
