import { useEffect, useState, useCallback } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { supabase } from '../../supabaseClient'
import SuiteGate from '../../components/SuiteGate'
import Tip from '../../components/Tip'
import ReportLoadError from '../../components/ReportLoadError'
import { useLatestRequest } from '../../shared/hooks/useLatestRequest'
import { errorText } from '../../shared/errorText'
import OutletAccessPanel from './OutletAccessPanel'
import MasterPushPanel from './MasterPushPanel'
import { BS_MONTHS, getBsToday, bsToAd, daysInBsMonth, formatAd } from '../../utils/bsCalendar'

// Multi-Outlet Group Console — every branch in the group on one screen.
//
// Figures come from get_group_summary(), which returns RAW aggregates per outlet (revenue, net
// purchases, payroll, covers) rather than percentages. The percentages are derived here so this
// page does not become a fourth independent definition of food cost % / labour cost % alongside
// OwnerDashboard.jsx, computeMonthlyReport.js and ClientDashboard.jsx.
//
// Two things the RPC deliberately does that shape this UI:
//   - Outlets without Crest Suite Pro come back is_included = false with NULL figures. The
//     filter is server-side, so an unpaid outlet's revenue never reaches the browser at all.
//     They are named below instead of silently dropped, or the group total would under-report
//     with nothing on screen to say so.
//   - Outlets are matched on (bs_year, bs_month), never period_id — monthly_periods is
//     UNIQUE(client_id, bs_year, bs_month) with one open period each, so two outlets genuinely
//     sit in different months. has_period = false is surfaced rather than shown as zero.

// While a month is loading, `rows` still holds the PREVIOUS month's outlets — the four totals
// below are derived from it, so they rendered last month's group revenue under this month's
// label until the table beneath them caught up. A figure the page has not computed for the
// period it names is the failure ReportPage's own contract exists to prevent.
const StatSkeleton = () => <span className="skeleton" style={{ display: 'inline-block', width: '3.5em', height: '0.8em', verticalAlign: 'middle' }} />

const fmtNpr = n => n == null ? '—' : `NPR ${Math.round(n).toLocaleString('en-NP')}`
const fmtPct = n => n == null || !isFinite(n) ? '—' : `${n.toFixed(1)}%`

// Every percentage on this page is TEXT, so these are the -text variants, not the base tokens.
// The base signal colours are tuned as fills and dots; used as type on a light preset
// they measure as low as 2.05:1, well under AA.
function pctColor(v, good, warn) {
  if (v == null || !isFinite(v)) return 'var(--theme-text3)'
  if (v <= good) return 'var(--theme-green-text)'
  if (v <= warn) return 'var(--theme-amber-text)'
  return 'var(--theme-red-text)'
}

export default function GroupDashboard() {
  const { groupId, clientId, canSwitchOutlet, switchOutlet, isAdmin, isOwner } = useAuth()
  const [switching, setSwitching] = useState(null)
  const today = getBsToday()
  const [bsYear, setBsYear] = useState(today.year)
  const [bsMonth, setBsMonth] = useState(today.month)
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // Changing the month re-runs `load` through its own useCallback dep, so arrowing the closed
  // <select> starts one get_group_summary per keypress and the last to LAND wins the figures —
  // while the two <select>s show whatever was picked last. S601's shape exactly, on a page that
  // compares outlets' money across months. The key is composite because the selection is
  // (year, month), not one id; it still fails open, so a missed begin() only degrades to the old
  // behaviour rather than blanking the page.
  const monthReq = useLatestRequest()

  const load = useCallback(async () => {
    const key = `${bsYear}-${bsMonth}`
    monthReq.begin(key)
    setLoading(true)
    setError('')
    // pos_orders has no period_id or BS columns — only AD closed_at — so the BS month is
    // converted here and passed through, matching SalesReport.jsx's own convention.
    //
    // formatAd, NOT .toISOString(). bsToAd returns a Date at local midnight; .toISOString() then
    // converts using the runtime's offset, which at Nepal's +05:45 lands on the PREVIOUS day and
    // shifted both bounds back one day for every user in the country. formatAd reads the Date's
    // local getters, so the calendar day survives. get_group_summary declares both parameters as
    // `date`, so a bare YYYY-MM-DD is the right shape here — see bsDayBoundaryIso in bsCalendar.js
    // for the offset-carrying form used where a timestamptz column is filtered directly.
    const start = bsToAd(bsYear, bsMonth, 1)
    const end = bsToAd(bsYear, bsMonth, daysInBsMonth(bsYear, bsMonth))
    const iso = d => d instanceof Date && !isNaN(d) ? formatAd(d) : null
    const { data, error: err } = await supabase.rpc('get_group_summary', {
      p_bs_year: bsYear,
      p_bs_month: bsMonth,
      p_ad_start: iso(start),
      p_ad_end: iso(end),
    })
    if (!monthReq.isCurrent(key)) return
    // errorText, not err.message: this reader is the Owner, and supabase-js hands back a bare
    // `TypeError: Failed to fetch` for any dead connection.
    if (err) { setError(errorText(err, 'operator')); setRows([]) }
    else setRows(data || [])
    setLoading(false)
  }, [bsYear, bsMonth]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (groupId) load() }, [groupId, load])

  // Placed after every hook, and relying on ProtectedRoute having already resolved `profile`.
  // This page had NO role guard at all until S617 — not at the route in App.js, not here — while
  // the sidebar showed it to isAdmin || isOwner only. MonthlyOwnerReport has carried this exact
  // line since it shipped; /pnl and /owner-dashboard were given it in S601; this is the fourth
  // page behind an owner-only nav entry and the last one missing it. Group figures cross tenant
  // boundaries, so the altitude test is the whole point (S601's rule).
  if (!isAdmin && !isOwner) return <Navigate to="/dashboard" replace />

  async function handleGoToOutlet(targetId) {
    setSwitching(targetId)
    setError('')
    const { error: err } = await switchOutlet(targetId)
    setSwitching(null)
    // switchOutlet refuses while the offline queue is non-empty, so this is a real message the
    // reader needs, not a generic failure.
    if (err) setError(err.message || 'Could not switch outlet.') // a switchOutlet refusal is already a written sentence
  }

  const included = rows.filter(r => r.is_included)
  const excluded = rows.filter(r => !r.is_included)
  const noPeriod = included.filter(r => !r.has_period)

  const sum = key => included.reduce((t, r) => t + (Number(r[key]) || 0), 0)
  const groupRevenue = sum('revenue')
  const groupPurchases = sum('net_purchases')
  const groupPayroll = sum('payroll')
  const groupCovers = sum('covers')
  const groupFc = groupRevenue > 0 ? (groupPurchases / groupRevenue) * 100 : null
  const groupLabour = groupRevenue > 0 ? (groupPayroll / groupRevenue) * 100 : null

  const years = [today.year - 1, today.year, today.year + 1]

  return (
    <div>
      <div className="page-header no-print">
        <div>
          <h1 className="page-title">Group Console</h1>
          <p className="page-subtitle">Every outlet in your group, side by side for one BS month</p>
        </div>
      </div>

      <SuiteGate featureKey="multi_outlet" featureLabel="Multi-Outlet Group Console" requireModules={['ims']}>
        {!groupId ? (
          <div className="card" style={{ textAlign: 'center', padding: '48px 24px' }}>
            <p style={{ fontSize: 15, fontWeight: 600, color: 'var(--theme-text1)', margin: '0 0 8px' }}>
              This outlet isn’t part of a group yet
            </p>
            <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: 0 }}>
              Contact your consultant to link your outlets together — then they all appear here.
            </p>
          </div>
        ) : (
          <>
            {/* flex-end, not center: the two labelled fields are taller than the button, and
                centring would float the button halfway up their labels. */}
            <div className="card no-print" style={{ marginBottom: 16, display: 'flex', gap: 16, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div className="form-field" style={{ margin: 0 }}>
                <label htmlFor="group-bs-month">Month</label>
                <select id="group-bs-month" className="form-select" style={{ maxWidth: 140 }} value={bsMonth} onChange={e => setBsMonth(Number(e.target.value))}>
                  {BS_MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                </select>
              </div>
              <div className="form-field" style={{ margin: 0 }}>
                <label htmlFor="group-bs-year">Year</label>
                <select id="group-bs-year" className="form-select" style={{ maxWidth: 120 }} value={bsYear} onChange={e => setBsYear(Number(e.target.value))}>
                  {years.map(y => <option key={y} value={y}>{y}</option>)}
                </select>
              </div>
              <button className="btn btn-ghost" onClick={load} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button>
            </div>

            {error && <div style={{ marginBottom: 16 }}><ReportLoadError error={error} /></div>}

            {/* Coverage first, not as a footnote. A group total that silently omits an outlet is
                worse than no total, so the reader is told what this figure covers before they
                read it. */}
            {!loading && !error && (excluded.length > 0 || noPeriod.length > 0) && (
              <div className="card" style={{ marginBottom: 16, background: 'rgba(251,191,36,0.06)', border: '1px solid rgba(251,191,36,0.3)' }}>
                <p style={{ margin: 0, fontSize: 12, fontWeight: 700, color: 'var(--theme-amber-text)' }}>
                  Showing {included.length} of {rows.length} outlets
                </p>
                {excluded.length > 0 && (
                  <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--theme-text2)', lineHeight: 1.5 }}>
                    {excluded.map(r => r.client_name).join(', ')} {excluded.length === 1 ? 'is' : 'are'} not on Crest Suite Pro —
                    add it there to include {excluded.length === 1 ? 'its' : 'their'} revenue in these totals.
                  </p>
                )}
                {noPeriod.length > 0 && (
                  <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--theme-text2)', lineHeight: 1.5 }}>
                    {noPeriod.map(r => r.client_name).join(', ')} {noPeriod.length === 1 ? 'has' : 'have'} no period open for
                    {' '}{BS_MONTHS[bsMonth - 1]} {bsYear} yet, so {noPeriod.length === 1 ? 'it counts' : 'they count'} as zero.
                  </p>
                )}
              </div>
            )}

            {!error && <div className="stat-grid">
              <div className="card">
                <div className="stat-label"><Tip text="Sum of every included outlet's revenue for this BS month. For a POS-enabled outlet this already includes POS revenue, since PosOrders stamps a sales_entries row per closed bill.">Group Revenue</Tip></div>
                <div className="stat-value">{loading ? <StatSkeleton /> : fmtNpr(groupRevenue)}</div>
              </div>
              <div className="card">
                <div className="stat-label"><Tip text="Group net purchases ÷ group revenue. Computed on the group totals, not as an average of each outlet's percentage — a small outlet must not swing the group figure as hard as a large one.">Group Food Cost %</Tip></div>
                <div className="stat-value" style={{ color: loading ? undefined : pctColor(groupFc, 35, 45) }}>{loading ? <StatSkeleton /> : fmtPct(groupFc)}</div>
              </div>
              <div className="card">
                <div className="stat-label"><Tip text="Finalized payroll (gross + employer SSF) ÷ revenue, across included outlets. Only payroll runs marked finalized count — an unfinalized month reads as zero rather than as an estimate.">Group Labour %</Tip></div>
                <div className="stat-value" style={{ color: loading ? undefined : pctColor(groupLabour, 25, 35) }}>{loading ? <StatSkeleton /> : fmtPct(groupLabour)}</div>
              </div>
              <div className="card">
                <div className="stat-label"><Tip text="Covers across included outlets, from paid POS bills closed within this BS month's AD date range. Outlets without POS contribute zero.">Group Covers</Tip></div>
                <div className="stat-value">{loading ? <StatSkeleton /> : groupCovers ? groupCovers.toLocaleString('en-NP') : '—'}</div>
              </div>
            </div>}

            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Outlet</th>
                    <th style={{ textAlign: 'right' }}>Revenue</th>
                    <th style={{ textAlign: 'right' }}>Net Purchases</th>
                    <th style={{ textAlign: 'right' }}><Tip text="Net purchases ÷ revenue for this outlet alone.">Food Cost %</Tip></th>
                    <th style={{ textAlign: 'right' }}>Payroll</th>
                    <th style={{ textAlign: 'right' }}><Tip text="Finalized payroll ÷ revenue for this outlet alone.">Labour %</Tip></th>
                    <th style={{ textAlign: 'right' }}>Covers</th>
                  </tr>
                </thead>
                <tbody>
                  {loading && <tr><td colSpan={7} style={{ color: 'var(--theme-text2)' }}>Loading…</td></tr>}
                  {!loading && rows.length === 0 && <tr><td colSpan={7} style={{ color: 'var(--theme-text2)' }}>No outlets in this group.</td></tr>}
                  {!loading && rows.map(r => {
                    const rev = Number(r.revenue) || 0
                    const fc = r.is_included && rev > 0 ? (Number(r.net_purchases) / rev) * 100 : null
                    const lab = r.is_included && rev > 0 ? (Number(r.payroll) / rev) * 100 : null
                    // No opacity dimming on excluded rows. It read as de-emphasis but multiplies
                    // straight through the text colour — text2 at 0.55 measured under 3:1 — and the
                    // "No Suite Pro" badge plus a row of em-dashes already says the same thing
                    // without costing anyone legibility.
                    return (
                      <tr key={r.client_id}>
                        <td>
                          {/* The point of spotting a bad outlet here is to go into it. Without this
                              the reader has to leave, find the sidebar switcher and re-pick by name. */}
                          {canSwitchOutlet && r.client_id !== clientId ? (
                            <button
                              className="btn-linklike"
                              onClick={() => handleGoToOutlet(r.client_id)}
                              disabled={switching === r.client_id}
                            >
                              {switching === r.client_id ? 'Switching…' : r.client_name}
                            </button>
                          ) : r.client_name}
                          {r.client_id === clientId && <span className="badge-yellow" style={{ marginLeft: 6 }}>Viewing</span>}
                          {!r.is_included && <span className="badge-gray" style={{ marginLeft: 6 }}>No Suite Pro</span>}
                          {r.is_included && !r.has_period && <span className="badge-amber" style={{ marginLeft: 6 }}>No period</span>}
                        </td>
                        <td style={{ textAlign: 'right' }}>{r.is_included ? fmtNpr(r.revenue) : '—'}</td>
                        <td style={{ textAlign: 'right' }}>{r.is_included ? fmtNpr(r.net_purchases) : '—'}</td>
                        <td style={{ textAlign: 'right', color: pctColor(fc, 35, 45) }}>{fmtPct(fc)}</td>
                        <td style={{ textAlign: 'right' }}>{r.is_included ? fmtNpr(r.payroll) : '—'}</td>
                        <td style={{ textAlign: 'right', color: pctColor(lab, 25, 35) }}>{fmtPct(lab)}</td>
                        <td style={{ textAlign: 'right' }}>{r.is_included ? (Number(r.covers) || 0).toLocaleString('en-NP') : '—'}</td>
                      </tr>
                    )
                  })}
                </tbody>
                {/* The four cards above ARE these totals, but they sit a screen-scroll away from
                    the rows they total. A tfoot puts the sum where the eye already is. */}
                {!loading && included.length > 0 && (
                  <tfoot>
                    <tr style={{ fontWeight: 700 }}>
                      <td>Group total ({included.length} outlet{included.length === 1 ? '' : 's'})</td>
                      <td style={{ textAlign: 'right' }}>{fmtNpr(groupRevenue)}</td>
                      <td style={{ textAlign: 'right' }}>{fmtNpr(groupPurchases)}</td>
                      <td style={{ textAlign: 'right', color: pctColor(groupFc, 35, 45) }}>{fmtPct(groupFc)}</td>
                      <td style={{ textAlign: 'right' }}>{fmtNpr(groupPayroll)}</td>
                      <td style={{ textAlign: 'right', color: pctColor(groupLabour, 25, 35) }}>{fmtPct(groupLabour)}</td>
                      <td style={{ textAlign: 'right' }}>{groupCovers ? groupCovers.toLocaleString('en-NP') : '—'}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>

            {/* Rendered from `rows`, not from AuthContext's `outlets`: this matrix must list every
                outlet in the group, including ones excluded from the figures above for want of
                Suite Pro. Access is about where someone may work, not about what the group is
                billed for — omitting an unpaid outlet would silently make it un-staffable. */}
            <OutletAccessPanel outlets={rows.map(r => ({ id: r.client_id, name: r.client_name }))} />
            <MasterPushPanel outlets={rows.map(r => ({ id: r.client_id, name: r.client_name }))} groupId={groupId} />
          </>
        )}
      </SuiteGate>
    </div>
  )
}
