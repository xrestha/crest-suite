import { useState, useEffect, useRef } from 'react'
import { useNavigate, Navigate } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import Tip from '../../../components/Tip'
import { BS_MONTHS } from '../../../utils/bsCalendar'
import { useHrApprovalCounts } from './useHrApprovalCounts'

const fmt  = n => Math.round(n || 0).toLocaleString('en-NP')
const fmtD = iso => iso ? new Date(iso).toLocaleDateString('en-NP', { day: 'numeric', month: 'short' }) : '—'

function nextMonthLabel(bs_year, bs_month) {
  if (!bs_year || !bs_month) return '—'
  const nm = bs_month === 12 ? 1   : bs_month + 1
  const ny = bs_month === 12 ? bs_year + 1 : bs_year
  return `${BS_MONTHS[nm - 1]} 15, ${ny}`
}

// Clickable KPI card — role/tabIndex/onKeyDown + .interactive-card give keyboard users the same
// access mouse users already had; this one shared component fixes every KCard instance at once.
function KCard({ label, value, sub, color = 'var(--theme-text1)', tip, onClick, alert }) {
  return (
    <div
      className={onClick ? 'stat-card interactive-card' : 'stat-card'}
      onClick={onClick}
      style={onClick ? { cursor: 'pointer' } : undefined}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } }) : undefined}
    >
      <div className="stat-label">
        {tip ? <Tip text={tip} width={260}>{label}</Tip> : label}
      </div>
      <div className="stat-value" style={{ color, fontSize: typeof value === 'string' && value.length > 8 ? 16 : undefined }}>
        {value}
      </div>
      {sub && <div className="stat-sub" style={alert ? { color: 'var(--theme-red)' } : undefined}>{sub}</div>}
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
  const [payInfo,     setPayInfo]     = useState(null)
  const [advOutstanding, setAdvOutstanding] = useState(0)
  const [empMap,      setEmpMap]      = useState({})
  const [typeMap,     setTypeMap]     = useState({})
  const pendingCounts = useHrApprovalCounts() // shared with ClientDashboard.jsx's HR column
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
    load(++loadIdRef.current)
  }, [clientId]) // eslint-disable-line

  async function load(myId) {
    setLoading(true)

    const results = await Promise.all([
      scopedFrom('hr_employees', 'id, full_name, status, retirement_date, basic_salary'),
      scopedFrom('hr_leave_types', 'id, name'),
      scopedFrom('hr_leave_requests', 'id, employee_id, leave_type_id, status, start_date, end_date, created_at')
        .eq('status', 'pending')
        .order('created_at', { ascending: false }).limit(8),
      scopedFrom('hr_overtime_entries', 'id, employee_id, bs_year, bs_month, bs_day, ot_hours, ot_type, created_at')
        .eq('status', 'pending')
        .order('created_at', { ascending: false }).limit(8),
      scopedFrom('hr_tada_claims', 'id, employee_id, trip_purpose, destination, total_amount, start_date, end_date, created_at')
        .eq('status', 'pending')
        .order('created_at', { ascending: false }).limit(8),
      // Only pending_admin needs a manager action — pending_target is still waiting on the
      // coworker's own accept/decline, same filter SwapRequestsPanel.jsx uses.
      scopedFrom('hr_shift_swap_requests', 'id, requester_employee_id, target_employee_id, bs_year, bs_month, requester_bs_day, target_bs_day, created_at')
        .eq('status', 'pending_admin')
        .order('created_at', { ascending: false }).limit(8),
      scopedFrom('hr_payroll_runs', 'id, monthly_periods(bs_year, bs_month)')
        .eq('status', 'finalized')
        .order('created_at', { ascending: false }).limit(1),
      scopedFrom('hr_advances', 'id, amount').eq('status', 'active'),
      scopedFrom('hr_advance_repayments', 'advance_id, amount'),
    ])
    if (loadIdRef.current !== myId) return // superseded by a newer client switch

    const [
      { data: emps },
      { data: ltypes },
      { data: leaves },
      { data: otPending },
      { data: tadaPending },
      { data: swapPending },
      { data: runs },
      { data: advs },
      { data: reps },
    ] = results
    let hadRealError = results.some(r => r.error)

    // ── Employee stats ─────────────────────────────────────────────────────────
    const todayMs = new Date().setHours(0, 0, 0, 0)
    const RETIRE_DAYS = 180
    let payrollBase = 0, retiringSoon = 0
    ;(emps || []).forEach(e => {
      if (e.status === 'active' || e.status === 'probation') payrollBase += parseFloat(e.basic_salary || 0)
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
    setEmpStats({
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
    setLeaveList(leaves || [])
    setOtList(otPending || [])
    setTadaList(tadaPending || [])
    setSwapList(swapPending || [])

    // ── Advances outstanding ───────────────────────────────────────────────────
    const repMap = {}
    ;(reps || []).forEach(r => { repMap[r.advance_id] = (repMap[r.advance_id] || 0) + parseFloat(r.amount || 0) })
    const outstanding = (advs || []).reduce((s, a) => s + Math.max(0, parseFloat(a.amount || 0) - (repMap[a.id] || 0)), 0)
    setAdvOutstanding(outstanding)

    // ── Last finalized payroll ─────────────────────────────────────────────────
    const lastRun = runs?.[0]
    if (lastRun) {
      const { data: slips, error: slipsErr } = await scopedFrom('hr_payslips', 'net_pay, ssf_employee, ssf_employer')
        .eq('run_id', lastRun.id)
      if (loadIdRef.current !== myId) return // superseded again after this extra await
      hadRealError = hadRealError || slipsErr
      const mp = lastRun.monthly_periods
      setPayInfo({
        periodLabel:  mp ? `${BS_MONTHS[mp.bs_month - 1]} ${mp.bs_year}` : '—',
        netPay:       (slips || []).reduce((s, x) => s + (x.net_pay       || 0), 0),
        ssfEmployee:  (slips || []).reduce((s, x) => s + (x.ssf_employee  || 0), 0),
        ssfEmployer:  (slips || []).reduce((s, x) => s + (x.ssf_employer  || 0), 0),
        bsYear:       mp?.bs_year,
        bsMonth:      mp?.bs_month,
        count:        (slips || []).length,
      })
    }

    setLoadError(hadRealError ? 'Some dashboard data failed to load — figures below may be incomplete or stale.' : '')
    setLoading(false)
  }

  // A skeleton mirroring the page's real layout (header + 3 stat-grid rows) instead of a plain
  // "Loading…" text block — consistent with the per-KPI skeleton pattern used elsewhere on the
  // client and owner dashboards.
  if (loading) return (
    <div>
      {/* Screen-reader-only announcement — the visible loading state is a shimmering skeleton,
          which on its own gives no indication to a screen reader that the page is still loading. */}
      <div role="status" aria-live="polite" className="sr-only">Loading dashboard data…</div>
      <div style={{ marginBottom: 20 }}>
        <h1 className="page-title">HR Dashboard</h1>
        <p className="page-subtitle">Headcount · Payroll · Approval queues · SSF · Advances at a glance</p>
      </div>
      {[0, 1, 2].map(row => (
        <div key={row} className="stat-grid" style={{ marginBottom: 20 }}>
          {[0, 1, 2, 3].map(card => (
            <div key={card} className="stat-card">
              <span className="skeleton" style={{ display: 'block', width: '60%', height: 11, marginBottom: 10 }} />
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

  if (!hasHrAccess('supervisor')) return <Navigate to="/dashboard" replace />

  return (
    <div>
      <div role="status" aria-live="polite" className="sr-only">Dashboard data loaded</div>
      <div style={{ marginBottom: 20 }}>
        <h1 className="page-title">HR Dashboard</h1>
        <p className="page-subtitle">Headcount · Payroll · Approval queues · SSF · Advances at a glance</p>
      </div>

      {/* A load failure used to be indistinguishable from "this client genuinely has no data" —
          every query above silently discarded Supabase's error field. */}
      {loadError && (
        <div className="card" style={{
          marginBottom: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
          borderColor: 'color-mix(in srgb, var(--theme-red) 25%, transparent)',
          background: 'color-mix(in srgb, var(--theme-red) 8%, transparent)',
        }}>
          <p style={{ color: 'var(--theme-red)', margin: 0, fontSize: 13 }}>
            <span aria-hidden="true">⚠</span> {loadError}
          </p>
          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px' }} onClick={() => load(++loadIdRef.current)}>Retry</button>
            <button
              className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px' }}
              onClick={() => setLoadError('')} aria-label="Dismiss"
            >×</button>
          </div>
        </div>
      )}

      {/* ── KPI Row 1 — Approvals (everything a staff submission needs a manager to act on) ── */}
      <h2 style={{ fontSize: 11, fontWeight: 700, margin: '0 0 8px', color: 'var(--theme-text3)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
        Approvals {pendingTotal > 0 && <span style={{ color: 'var(--theme-accent)' }}>({pendingTotal} pending)</span>}
      </h2>
      <div className="stat-grid" style={{ marginBottom: 20 }}>
        <KCard
          label="Leave Pending"
          value={pendingLeave}
          sub={pendingLeave > 0 ? 'awaiting approval' : 'all clear'}
          color={pendingLeave > 0 ? 'var(--theme-accent)' : 'var(--theme-green)'}
          tip="Leave requests with status Pending — click to go to the Leave page and approve or reject."
          onClick={() => navigate('/hr/leave')}
          alert={pendingLeave > 0}
        />
        <KCard
          label="OT Pending"
          value={pendingOt}
          sub={pendingOt > 0 ? 'awaiting approval' : 'all clear'}
          color={pendingOt > 0 ? 'var(--theme-accent)' : 'var(--theme-green)'}
          tip="Overtime entries not yet approved. Only approved OT feeds into payroll — approve before running payroll."
          onClick={() => navigate('/hr/overtime')}
          alert={pendingOt > 0}
        />
        <KCard
          label="TADA Pending"
          value={pendingTada}
          sub={pendingTada > 0 ? 'awaiting approval' : 'all clear'}
          color={pendingTada > 0 ? 'var(--theme-accent)' : 'var(--theme-green)'}
          tip="TADA (travel/daily allowance) claims with status Pending, whether entered by a manager or submitted by the employee themselves via Self-Service — click to go to TADA Claims and approve or reject."
          onClick={() => navigate('/hr/tada')}
          alert={pendingTada > 0}
        />
        <KCard
          label="Swap Pending"
          value={pendingSwap}
          sub={pendingSwap > 0 ? 'awaiting your approval' : 'all clear'}
          color={pendingSwap > 0 ? 'var(--theme-accent)' : 'var(--theme-green)'}
          tip="Shift swap requests where the coworker has already accepted and it's now waiting on manager approval (requests still waiting on the coworker aren't shown here — nothing for a manager to do yet)."
          onClick={() => navigate('/hr/roster')}
          alert={pendingSwap > 0}
        />
      </div>

      {/* ── KPI Row 2 — Headcount ───────────────────────────────────────────── */}
      <h2 style={{ fontSize: 11, fontWeight: 700, margin: '0 0 8px', color: 'var(--theme-text3)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Headcount</h2>
      <div className="stat-grid" style={{ marginBottom: 20 }}>
        <KCard
          label="Active Staff"
          value={empStats?.active ?? '—'}
          sub={empStats?.probation > 0 ? `+ ${empStats.probation} on probation` : 'no probation'}
          color="var(--theme-green)"
          tip="Active employees only. Probation shown separately — both are included in payroll."
          onClick={() => navigate('/hr/employees')}
        />
        <KCard
          label="Basic Payroll / Month"
          value={`NPR ${fmt(empStats?.payrollBase)}`}
          sub="active + probation, basic only"
          color="var(--theme-accent)"
          tip="Sum of basic salary for active and probation employees. Full payroll (allowances, SSF, TDS) is computed during the payroll run."
          onClick={() => navigate('/hr/payroll')}
        />
        <KCard
          label="Advances Outstanding"
          value={`NPR ${fmt(advOutstanding)}`}
          sub="active advance & loan balances"
          tip="Total remaining balance across all active (unsettled) advances and loans."
          onClick={() => navigate('/hr/advances')}
        />
        <KCard
          label="Retiring Soon"
          value={empStats?.retiringSoon ?? 0}
          sub="within 180 days"
          color={empStats?.retiringSoon > 0 ? 'var(--theme-accent)' : 'var(--theme-green)'}
          tip="Active or probation employees whose retirement date (DOB + 60 years) falls within the next 180 days."
          onClick={() => navigate('/hr/employees')}
          alert={empStats?.retiringSoon > 0}
        />
      </div>

      {/* ── Payroll + SSF ───────────────────────────────────────────────────── */}
      {payInfo && (
        <>
          <h2 style={{ fontSize: 11, fontWeight: 700, margin: '0 0 8px', color: 'var(--theme-text3)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
            Last Finalized Payroll — {payInfo.periodLabel} ({payInfo.count} employees)
          </h2>
          <div className="stat-grid" style={{ marginBottom: 20 }}>
            <KCard
              label="Net Payable"
              value={`NPR ${fmt(payInfo.netPay)}`}
              sub={`${payInfo.periodLabel} take-home total`}
              color="var(--theme-green)"
              tip="Total net pay disbursed to all employees in the last finalized payroll run."
              onClick={() => navigate('/hr/payroll')}
            />
            <KCard
              label="SSF — Employee (11%)"
              value={`NPR ${fmt(payInfo.ssfEmployee)}`}
              sub="deducted from payslips"
              tip="Total employee SSF contributions (11% of capped basic) deducted across all enrolled employees."
            />
            <KCard
              label="SSF — Employer (20%)"
              value={`NPR ${fmt(payInfo.ssfEmployer)}`}
              sub="company contribution"
              tip="Total employer SSF contribution (20% of capped basic) — paid by the company on top of net pay."
            />
            <KCard
              label="SSF Total to Deposit"
              value={`NPR ${fmt(payInfo.ssfEmployee + payInfo.ssfEmployer)}`}
              sub={`Deposit by ${nextMonthLabel(payInfo.bsYear, payInfo.bsMonth)}`}
              color="var(--theme-accent)"
              tip={`SSF challan (employee 11% + employer 20%) for ${payInfo.periodLabel}. Deposit with SSF by the 15th of the following month. Go to HR Reports → SSF Challan for the per-employee breakdown.`}
              onClick={() => navigate('/hr/reports')}
              alert
            />
          </div>
        </>
      )}

      {!payInfo && (
        <div className="card" style={{ padding: '14px 18px', marginBottom: 20, fontSize: 13, color: 'var(--theme-text2)' }}>
          No finalized payroll yet. Generate and finalize a payroll run to see net pay and SSF summary here.
        </div>
      )}

      {/* ── Pending queues ───────────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16, marginTop: 4 }}>

        {/* Leave queue */}
        <div>
          <h3 style={{ fontSize: 11, fontWeight: 700, margin: '0 0 8px', color: 'var(--theme-text3)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
            Pending Leave Requests {pendingLeave > 0 && <span style={{ color: 'var(--theme-accent)' }}>({pendingLeave})</span>}
          </h3>
          <div className="card" style={{ padding: 0 }}>
            {leaveList.length === 0 ? (
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
                    <tr
                      key={r.id} className="interactive-row" style={{ cursor: 'pointer' }}
                      onClick={() => navigate('/hr/leave')} role="button" tabIndex={0}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate('/hr/leave') } }}
                    >
                      <td style={{ fontWeight: 600, fontSize: 12, color: 'var(--theme-text1)' }}>{empMap[r.employee_id] || '—'}</td>
                      <td style={{ fontSize: 12, color: 'var(--theme-text2)' }}>{typeMap[r.leave_type_id] || '—'}</td>
                      <td style={{ fontSize: 12, color: 'var(--theme-text3)' }}>{fmtD(r.start_date)}</td>
                      <td style={{ fontSize: 12, color: 'var(--theme-text3)' }}>{fmtD(r.end_date)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )}
          </div>
          {pendingLeave > 0 && (
            <button className="btn btn-ghost" style={{ fontSize: 11, marginTop: 8 }} onClick={() => navigate('/hr/leave')}>
              Go to Leave → approve / reject
            </button>
          )}
        </div>

        {/* OT queue */}
        <div>
          <h3 style={{ fontSize: 11, fontWeight: 700, margin: '0 0 8px', color: 'var(--theme-text3)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
            Pending OT Entries {pendingOt > 0 && <span style={{ color: 'var(--theme-accent)' }}>({pendingOt})</span>}
          </h3>
          <div className="card" style={{ padding: 0 }}>
            {otList.length === 0 ? (
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
                    <tr
                      key={e.id} className="interactive-row" style={{ cursor: 'pointer' }}
                      onClick={() => navigate('/hr/overtime')} role="button" tabIndex={0}
                      onKeyDown={(e2) => { if (e2.key === 'Enter' || e2.key === ' ') { e2.preventDefault(); navigate('/hr/overtime') } }}
                    >
                      <td style={{ fontWeight: 600, fontSize: 12, color: 'var(--theme-text1)' }}>{empMap[e.employee_id] || '—'}</td>
                      <td style={{ textAlign: 'center', fontSize: 12, color: 'var(--theme-text3)' }}>
                        {BS_MONTHS[e.bs_month - 1]} {e.bs_day}
                      </td>
                      <td style={{ textAlign: 'center', fontWeight: 600, color: 'var(--theme-green)', fontSize: 12 }}>{e.ot_hours}h</td>
                      <td>
                        <span className={e.ot_type === 'holiday' ? 'badge-amber' : 'badge-gray'} style={{ fontSize: 10 }}>
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
            <button className="btn btn-ghost" style={{ fontSize: 11, marginTop: 8 }} onClick={() => navigate('/hr/overtime')}>
              Go to Overtime → approve / reject
            </button>
          )}
        </div>

        {/* TADA queue */}
        <div>
          <h3 style={{ fontSize: 11, fontWeight: 700, margin: '0 0 8px', color: 'var(--theme-text3)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
            Pending TADA Claims {pendingTada > 0 && <span style={{ color: 'var(--theme-accent)' }}>({pendingTada})</span>}
          </h3>
          <div className="card" style={{ padding: 0 }}>
            {tadaList.length === 0 ? (
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
                    <tr
                      key={c.id} className="interactive-row" style={{ cursor: 'pointer' }}
                      onClick={() => navigate('/hr/tada')} role="button" tabIndex={0}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate('/hr/tada') } }}
                    >
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
            <button className="btn btn-ghost" style={{ fontSize: 11, marginTop: 8 }} onClick={() => navigate('/hr/tada')}>
              Go to TADA Claims → approve / reject
            </button>
          )}
        </div>

        {/* Shift swap queue */}
        <div>
          <h3 style={{ fontSize: 11, fontWeight: 700, margin: '0 0 8px', color: 'var(--theme-text3)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
            Pending Shift Swaps {pendingSwap > 0 && <span style={{ color: 'var(--theme-accent)' }}>({pendingSwap})</span>}
          </h3>
          <div className="card" style={{ padding: 0 }}>
            {swapList.length === 0 ? (
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
                    <tr
                      key={s.id} className="interactive-row" style={{ cursor: 'pointer' }}
                      onClick={() => navigate('/hr/roster')} role="button" tabIndex={0}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate('/hr/roster') } }}
                    >
                      <td style={{ fontSize: 12, color: 'var(--theme-text2)' }}>
                        <span style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{empMap[s.requester_employee_id] || '—'}</span>
                        {' ⇄ '}
                        <span style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{empMap[s.target_employee_id] || '—'}</span>
                      </td>
                      <td style={{ textAlign: 'center', fontSize: 12, color: 'var(--theme-text3)' }}>
                        {BS_MONTHS[s.bs_month - 1]} {s.requester_bs_day} ⇄ {s.target_bs_day}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )}
          </div>
          {pendingSwap > 0 && (
            <button className="btn btn-ghost" style={{ fontSize: 11, marginTop: 8 }} onClick={() => navigate('/hr/roster')}>
              Go to Roster → approve / reject
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
