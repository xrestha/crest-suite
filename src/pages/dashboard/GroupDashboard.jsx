import { nprOrDash } from '../../shared/nepalMoney'
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
import { useSettings } from '../../context/SettingsContext'
import { fcBand } from '../../shared/imsFormulas'
import { lcBand, bandFigure } from '../../shared/operatingBands'

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

const fmtNpr = nprOrDash

// FOOD COST AND LABOUR BAND THROUGH THE SHARED DEFINITIONS, NOT A LOCAL LADDER (S734).
//
// This page had its own `pctColor(v, good, warn)`, called with `(35, 45)` for food cost and
// `(25, 35)` for labour — the FOURTH copy of a decision `operatingBands.js` exists to end, and
// unlike the three that file names, this one disagreed on the numbers. An outlet at 26% labour
// read AMBER here and healthy green on the Owner Dashboard and in the Monthly Owner Report; 36%
// read red here and "watch" there. Two owner-altitude screens, one metric, opposite verdicts —
// on the screen an owner uses to decide which branch to go and look at.
//
// The food-cost ladder was worse than merely different: 35/45 are only the DEFAULTS behind
// `fc_warning_pct`/`fc_critical_pct`, so a client who had tuned their own thresholds in Settings
// had them honoured on every per-outlet surface and ignored on the one that compares outlets.
//
// `bandFigure` rather than `band(pct).color`, so the ✓/△/▲ arrives with the colour. That mark
// is what carries the verdict for a reader who cannot separate the hues (S608), and every figure
// here is a number a person reads and acts on rather than a chart axis.
//
// One judgement call worth stating: `settings` is the SELECTED outlet's row, so a group whose
// branches carry different thresholds is banded against whichever one the owner is currently
// inside. That is the same row every other figure in this session reads, and it is strictly
// better than a hardcoded pair matching no outlet at all.

export default function GroupDashboard() {
  const { groupId, clientId, canSwitchOutlet, switchOutlet, isAdmin, isOwner } = useAuth()
  // The client's own fc_warning_pct/fc_critical_pct, so the Group Console bands food cost on the
  // same scale as every per-outlet page instead of a hardcoded 35/45.
  const { settings } = useSettings()
  const fcBandOf = pct => fcBand(pct, settings)
  // One banded right-aligned cell: colour, the band name as a title, and the figure with its
  // shape mark. Stated once so a row and the tfoot beneath it cannot drift.
  const bandCell = (pct, band) => {
    const f = bandFigure(pct, band)
    return { style: { textAlign: 'right', color: f.style.color }, title: f.title, children: f.text }
  }
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
              <div className="card" style={{ marginBottom: 16, background: 'color-mix(in srgb, var(--theme-amber) 6%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-amber) 30%, transparent)' }}>
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

            {/* .stat-card, not .card: .stat-grid is gap:0 and the seam only works because .stat-card
                zeroes its shadow and pulls -1px margins so each pair of adjacent borders draws as
                ONE line (see Layout.css). Four .cards in it butted their 1px borders into 2px
                double rules with their shadows overlapping at every join -- the exact two-depth-
                models-arguing the class comment warns about. dash-section for the mobile rhythm. */}
            {!error && <div className="stat-grid dash-section">
              <div className="stat-card">
                <div className="stat-label"><Tip text="Sum of every included outlet's revenue for this BS month. For a POS-enabled outlet this already includes POS revenue, since PosOrders stamps a sales_entries row per closed bill.">Group Revenue</Tip></div>
                <div className="stat-value">{loading ? <StatSkeleton /> : fmtNpr(groupRevenue)}</div>
              </div>
              <div className="stat-card">
                <div className="stat-label"><Tip text={`Group net purchases ÷ group revenue. Computed on the group totals, not as an average of each outlet's percentage — a small outlet must not swing the group figure as hard as a large one. Banded against your own Settings thresholds: watch above ${fcBandOf(groupFc).warn}%, too high above ${fcBandOf(groupFc).critical}%.`}>Group Food Cost %</Tip></div>
                <div className="stat-value" style={{ color: loading ? undefined : fcBandOf(groupFc).color }} title={loading ? undefined : bandFigure(groupFc, fcBandOf).title}>{loading ? <StatSkeleton /> : bandFigure(groupFc, fcBandOf).text}</div>
              </div>
              <div className="stat-card">
                <div className="stat-label"><Tip text="Finalized payroll (gross + employer SSF) ÷ revenue, across included outlets. Only payroll runs marked finalized count — an unfinalized month reads as zero rather than as an estimate. Banded on the product's published 25–30% target, the same scale the Owner Dashboard and the Monthly Owner Report use.">Group Labour %</Tip></div>
                <div className="stat-value" style={{ color: loading ? undefined : lcBand(groupLabour).color }} title={loading ? undefined : bandFigure(groupLabour, lcBand).title}>{loading ? <StatSkeleton /> : bandFigure(groupLabour, lcBand).text}</div>
              </div>
              <div className="stat-card">
                <div className="stat-label"><Tip text="Covers across included outlets, from paid POS bills closed within this BS month's AD date range. Outlets without POS contribute zero.">Group Covers</Tip></div>
                {/* Zero covers is a COUNT, not a missing figure — an em-dash here says "we could not
                    work this out" about a group whose outlets simply took no POS bills, on a page
                    whose coverage banner above already explains any real gap (S734). */}
                <div className="stat-value">{loading ? <StatSkeleton /> : groupCovers.toLocaleString('en-IN')}</div>
              </div>
            </div>}

            {/* Same gate as the KPI strip. Without it a failed read rendered ReportLoadError —
                "nothing here is a real figure" — directly above a table body reading "No outlets
                in this group" (rows is [] on failure), two contradictory sentences (S683). */}
            {!error && <div className="table-wrap">
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
                        <td {...bandCell(fc, fcBandOf)} />
                        <td style={{ textAlign: 'right' }}>{r.is_included ? fmtNpr(r.payroll) : '—'}</td>
                        <td {...bandCell(lab, lcBand)} />
                        <td style={{ textAlign: 'right' }}>{r.is_included ? (Number(r.covers) || 0).toLocaleString('en-IN') : '—'}</td>
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
                      <td {...bandCell(groupFc, fcBandOf)} />
                      <td style={{ textAlign: 'right' }}>{fmtNpr(groupPayroll)}</td>
                      <td {...bandCell(groupLabour, lcBand)} />
                      <td style={{ textAlign: 'right' }}>{groupCovers.toLocaleString('en-IN')}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>}

            {/* Rendered from `rows`, not from AuthContext's `outlets`: this matrix must list every
                outlet in the group, including ones excluded from the figures above for want of
                Suite Pro. Access is about where someone may work, not about what the group is
                billed for — omitting an unpaid outlet would silently make it un-staffable.
                Both wait for a successful read: an outlet list built from a failed one is empty,
                and an empty access matrix reads as "nobody may work anywhere". */}
            {!loading && !error && <>
              <OutletAccessPanel outlets={rows.map(r => ({ id: r.client_id, name: r.client_name }))} />
              <MasterPushPanel outlets={rows.map(r => ({ id: r.client_id, name: r.client_name }))} groupId={groupId} />
            </>}
          </>
        )}
      </SuiteGate>
    </div>
  )
}
