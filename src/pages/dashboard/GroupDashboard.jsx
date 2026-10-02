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
import {
  withGroupCogs, periodCostRatio, groupCostRatio, fcBasisOf,
  FOOD_COST_LABEL, SPEND_SO_FAR_LABEL, FOOD_COST_TIP, SPEND_SO_FAR_TIP,
} from '../../modules/ims/reports/foodCostBasis'
import { groupOutletLabour, groupLabourRatio } from '../../modules/dashboard/labourSource'
import { compareFigures } from '../../shared/compareFigures'

// Multi-Outlet Group Console — every branch in the group on one screen.
//
// Figures come from get_group_summary(), which returns RAW aggregates per outlet (revenue, net
// purchases, payroll, covers) rather than percentages. The percentages are derived here so this
// page does not become a fourth independent definition of food cost % / labour cost % alongside
// OwnerDashboard.jsx, computeMonthlyReport.js and ClientDashboard.jsx.
//
// A closed month's Food Cost % is COGS ÷ revenue (S792, owner decision D30), and a month still
// running shows "Spend % so far" (net purchases ÷ revenue) under that name instead — the rule and
// both names live in foodCostBasis.js. Outlets keep independent periods, so one row can be a closed
// month and the next a running one; each row names which figure it is. COGS comes from
// get_group_pnl(), the same rows Consolidated P&L builds its statement from, joined on client_id —
// so the group's COGS has one SQL definition, not a second copy inside get_group_summary.
//
// Two things the RPC deliberately does that shape this UI:
//   - Outlets without Crest Suite Pro come back is_included = false with NULL figures. The
//     filter is server-side, so an unpaid outlet's revenue never reaches the browser at all.
//     They are named below instead of silently dropped, or the group total would under-report
//     with nothing on screen to say so.
//   - Outlets are matched on (bs_year, bs_month), never period_id — monthly_periods is
//     UNIQUE(client_id, bs_year, bs_month) with one open period each, so two outlets genuinely
//     sit in different months. has_period = false is surfaced rather than shown as zero.
//
// Labour comes from get_group_pnl too (S798 2e, LABOUR-FIGURES-2), through `groupOutletLabour`:
// finalized payroll, else the outlet's Overheads Labor tab — Consolidated P&L's rule. Before, it
// was get_group_summary's `payroll`, which is NPR 0 for "no finalized run", so every outlet of the
// running month (the month this page opens on) read Labour "0.0% ✓ Healthy", and a past month with
// one outlet finalized read the group at half its true figure, still green. An outlet with no
// labour figure now says why ("not finalized" on an HR outlet, "none entered" on an IMS-only one)
// with no band, and the group Labour % waits until every outlet has one.

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
    // Both RPCs for the same (bs_year, bs_month), side by side under the one monthReq key, so a
    // stale month can win neither. get_group_pnl carries each outlet's period status and its COGS
    // components (S792, D30); it checks the same Owner/admin rule get_group_summary does.
    // S800: last month's summary too, for each outlet's revenue against it. Best-effort: a failure
    // here costs the comparison only, and the cells say so, never the page.
    const prevY = bsMonth === 1 ? bsYear - 1 : bsYear
    const prevM = bsMonth === 1 ? 12 : bsMonth - 1
    const prevStart = bsToAd(prevY, prevM, 1)
    const prevEnd = bsToAd(prevY, prevM, daysInBsMonth(prevY, prevM))
    const [summary, pnl, hrFlags, prevSummary] = await Promise.all([
      supabase.rpc('get_group_summary', {
        p_bs_year: bsYear,
        p_bs_month: bsMonth,
        p_ad_start: iso(start),
        p_ad_end: iso(end),
      }),
      supabase.rpc('get_group_pnl', { p_bs_year: bsYear, p_bs_month: bsMonth }),
      // Which outlets run Crest HR: "no finalized payroll" means "not finalized" there and "none
      // entered" on an IMS-only outlet. `clients` is read raw (clients_select allows same-group rows).
      supabase.from('clients').select('id, hr_enabled').eq('group_id', groupId),
      supabase.rpc('get_group_summary', { p_bs_year: prevY, p_bs_month: prevM, p_ad_start: iso(prevStart), p_ad_end: iso(prevEnd) }),
    ])
    if (!monthReq.isCurrent(key)) return
    // A failure of EITHER read is the page's error. Without get_group_pnl a closed month has no
    // COGS and no status, so every row would fall back to Spend % so far — a quiet relabelling of
    // the figure the owner came to compare, which is worse than saying the read failed.
    // errorText, not err.message: this reader is the Owner, and supabase-js hands back a bare
    // `TypeError: Failed to fetch` for any dead connection.
    const err = summary.error || pnl.error || hrFlags.error
    if (err) { setError(errorText(err, 'operator')); setRows([]) }
    else {
      // has_closing rides along for the "closed with no count" mark on the row — Consolidated P&L's
      // own warning, for the same rows: such a month's COGS counts the whole shelf as used.
      const pnlById = new Map((pnl.data || []).map(p => [p.client_id, p]))
      const hrById = new Map((hrFlags.data || []).map(c => [c.id, !!c.hr_enabled]))
      // undefined = the comparison read failed; null = that outlet had no month to compare.
      const prevById = prevSummary.error ? null
        : new Map((prevSummary.data || []).map(p => [p.client_id, p.is_included && p.has_period !== false ? Number(p.revenue) || 0 : null]))
      setRows(withGroupCogs(summary.data || [], pnl.data || [])
        .map(r => ({
          ...r,
          has_closing: pnlById.get(r.client_id)?.has_closing ?? null,
          labour: r.is_included ? groupOutletLabour(pnlById.get(r.client_id), hrById.get(r.client_id)) : null,
          prevRevenue: prevById ? (prevById.get(r.client_id) ?? null) : undefined,
        })))
    }
    setLoading(false)
  }, [bsYear, bsMonth, groupId]) // eslint-disable-line react-hooks/exhaustive-deps

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
  const groupCovers = sum('covers')
  // Labour % only when every outlet in scope has a labour figure (groupLabourRatio), the way
  // groupCostRatio treats food cost; otherwise the outlets without one are named on the card.
  const groupLab = groupLabourRatio(included.filter(r => r.has_period !== false)
    .map(r => ({ name: r.client_name, revenue: r.revenue, labour: r.labour })))
  const groupLabour = groupLab.pct
  const groupLabourMissing = groupLab.missing

  // Food Cost % or Spend % so far (S792, D30). Each outlet's own figure follows its own month: COGS
  // once it has closed, what it has spent while it is still running. The group's is a Food Cost %
  // only when EVERY included outlet has closed the month (groupCostRatio) — a total built from one
  // branch's COGS and another's purchases would be neither figure. Computed on the group totals, as
  // before, never as an average of the outlets' percentages.
  const groupRatio = groupCostRatio(rows)
  const groupFc = groupRatio.pct
  const ratioOf = r => (r.is_included
    ? periodCostRatio({ status: r.period_status, revenue: r.revenue, cogs: r.cogs, netPurchases: r.net_purchases })
    : null)
  // Which of the two figures the column holds. When outlets stand differently the heading names
  // both and every cell names its own, so no cell can be read under the other's name.
  const shownBases = new Set(included.filter(r => r.has_period !== false).map(r => fcBasisOf(r.period_status)))
  const mixedBases = shownBases.size > 1
  const columnBasis = mixedBases ? 'mixed' : (shownBases.has('cogs') ? 'cogs' : 'spend')
  // Lowest / highest marks (S800): the outlet to learn from and the one to look at, per ratio
  // column — MarginEdge's "your own best outlet as the benchmark". Only with three or more outlets
  // carrying a figure, and never across two bases (a Spend % beside a Food Cost % is not a ranking).
  const prevLabel = `${BS_MONTHS[(bsMonth === 1 ? 12 : bsMonth - 1) - 1]}`
  const labPctOf = r => { const rev = Number(r.revenue) || 0; return r.labour?.hasFigure && rev > 0 ? (r.labour.amount / rev) * 100 : null }
  const extremes = values => {
    const xs = values.filter(v => v.pct != null)
    if (xs.length < 3) return {}
    const sorted = [...xs].sort((a, b) => a.pct - b.pct)
    return sorted[0].pct === sorted[sorted.length - 1].pct ? {} : { low: sorted[0].id, high: sorted[sorted.length - 1].id }
  }
  const costMarks = mixedBases ? {} : extremes(included.filter(r => r.has_period !== false).map(r => ({ id: r.client_id, pct: ratioOf(r)?.pct ?? null })))
  const labourMarks = extremes(included.filter(r => r.has_period !== false).map(r => ({ id: r.client_id, pct: labPctOf(r) })))
  const markOf = (marks, id) => marks.low === id ? 'Lowest' : marks.high === id ? 'Highest' : null
  const columnLabel = columnBasis === 'mixed' ? `${FOOD_COST_LABEL} / ${SPEND_SO_FAR_LABEL}`
    : columnBasis === 'cogs' ? FOOD_COST_LABEL : SPEND_SO_FAR_LABEL
  const columnTip = columnBasis === 'mixed'
    ? `Each outlet's own figure, for this outlet alone — the line under it says which. An outlet that has closed ${BS_MONTHS[bsMonth - 1]} shows its ${FOOD_COST_LABEL}: ${FOOD_COST_TIP} One still in the month shows its ${SPEND_SO_FAR_LABEL}: ${SPEND_SO_FAR_TIP}`
    : `${columnBasis === 'cogs' ? FOOD_COST_TIP : SPEND_SO_FAR_TIP} For this outlet alone.`
  const groupTip = `${groupRatio.basis === 'cogs' ? FOOD_COST_TIP : SPEND_SO_FAR_TIP} ` +
    (groupRatio.basis === 'cogs'
      ? 'Every included outlet has closed this month, so this is the group’s Food Cost %: all outlets’ stock used ÷ all outlets’ revenue.'
      : mixedBases
        ? 'Some outlets have closed this month and some have not, so the group figure is Spend % so far over all of them — a total mixing one outlet’s stock used with another’s purchases would be neither figure. Each outlet’s own figure is in the table.'
        : 'The group figure: all outlets’ net purchases ÷ all outlets’ revenue.') +
    ` Computed on the group totals, not as an average of each outlet's percentage — a small outlet must not swing the group figure as hard as a large one. Coloured against your own Settings food cost thresholds as a guide: watch above ${fcBandOf(groupFc).warn}%, too high above ${fcBandOf(groupFc).critical}%.`
  // One cost-ratio cell: bandCell's figure and colour, the ratio's own name under it when the
  // column holds both kinds, and — for a Food Cost % — the COGS it came from on hover, since the
  // Net Purchases column beside it is not what it divides.
  const ratioCell = (ratio, cogs) => {
    const c = bandCell(ratio?.pct ?? null, fcBandOf)
    const title = ratio?.basis === 'cogs' && cogs != null
      ? [c.title, `Stock used (COGS) ${fmtNpr(cogs)}`].filter(Boolean).join(' · ')
      : c.title
    if (!mixedBases || !ratio) return { ...c, title }
    return {
      ...c,
      title,
      children: <>{c.children}<div style={{ fontSize: 11, fontWeight: 400, color: 'var(--theme-text2)', whiteSpace: 'nowrap' }}>{ratio.label}</div></>,
    }
  }
  // A neutral chip under the figure: the band already carries the verdict, this only ranks.
  const withMark = (cell, mark) => (mark
    ? { ...cell, children: <>{cell.children}<div><span className="badge-gray" style={{ fontSize: 10 }}>{mark}</span></div></> }
    : cell)
  const groupCogs = groupRatio.basis === 'cogs'
    ? included.filter(r => r.has_period !== false).reduce((t, r) => t + (Number(r.cogs) || 0), 0)
    : null

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
                {/* The label follows the figure (S792, D30): "Group Spend % so far" until every
                    included outlet has closed the month, "Group Food Cost %" once they all have.
                    Held at the neutral label while loading, when neither is known yet. */}
                <div className="stat-label"><Tip text={groupTip} width={300}>{loading ? 'Group Food Cost / Spend %' : `Group ${groupRatio.label}`}</Tip></div>
                <div className="stat-value" style={{ color: loading ? undefined : fcBandOf(groupFc).color }} title={loading ? undefined : bandFigure(groupFc, fcBandOf).title}>{loading ? <StatSkeleton /> : bandFigure(groupFc, fcBandOf).text}</div>
              </div>
              <div className="stat-card">
                <div className="stat-label"><Tip text="All outlets' labour ÷ all outlets' revenue. Each outlet's labour is its finalized payroll (gross + overtime + employer SSF), or, with none, what was typed on its Overheads Labor tab — the rule Consolidated P&L uses. Shown only when every outlet has a labour figure: an outlet whose payroll is not finalized yet would otherwise count as zero and make the group look cheaper to staff than it is. Banded on the product's published 25–30% target, the same scale the Owner Dashboard and the Monthly Owner Report use." width={300}>Group Labour %</Tip></div>
                <div className="stat-value" style={{ color: loading ? undefined : lcBand(groupLabour).color }} title={loading ? undefined : bandFigure(groupLabour, lcBand).title}>{loading ? <StatSkeleton /> : bandFigure(groupLabour, lcBand).text}</div>
                {!loading && groupLabourMissing.length > 0 && (
                  <div className="stat-sub">No labour figure yet: {groupLabourMissing.join(', ')}</div>
                )}
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
                    {/* Neutral while loading: `rows` still holds the previous month, whose outlets may stand differently. */}
                    <th style={{ textAlign: 'right' }}><Tip text={columnTip} width={300}>{loading ? 'Food Cost / Spend %' : columnLabel}</Tip></th>
                    <th style={{ textAlign: 'right' }}><Tip text="This outlet's labour for the month: its finalized payroll (gross + overtime + employer SSF), or, with none, what was typed on its Overheads Labor tab, marked as such. “Not finalized” means the outlet runs Crest HR and its payroll for this month is not finalized yet; “none entered” means an outlet without Crest HR has nothing on its Labor tab." width={300}>Labour</Tip></th>
                    <th style={{ textAlign: 'right' }}><Tip text="Labour ÷ revenue for this outlet alone. No band while the outlet has no labour figure.">Labour %</Tip></th>
                    <th style={{ textAlign: 'right' }}>Covers</th>
                  </tr>
                </thead>
                <tbody>
                  {loading && <tr><td colSpan={7} style={{ color: 'var(--theme-text2)' }}>Loading…</td></tr>}
                  {!loading && rows.length === 0 && <tr><td colSpan={7} style={{ color: 'var(--theme-text2)' }}>No outlets in this group.</td></tr>}
                  {!loading && rows.map(r => {
                    const rev = Number(r.revenue) || 0
                    const fcRatio = ratioOf(r)
                    const lab = r.labour?.hasFigure && rev > 0 ? (r.labour.amount / rev) * 100 : null
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
                          {r.is_included && r.period_status === 'closed' && r.has_closing === false && (
                            <Tip text={`This outlet closed ${BS_MONTHS[bsMonth - 1]} without a closing stock count, so its Food Cost % counts everything on the shelf as used and reads high. Enter the count in that outlet's Stock Count, then Resync Opening Stock in Periods.`} width={280}
                              style={{ display: 'inline-flex', borderBottom: 'none', cursor: 'default', marginLeft: 6 }}>
                              <span className="badge-amber">No count</span>
                            </Tip>
                          )}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          {r.is_included ? fmtNpr(r.revenue) : '—'}
                          {r.is_included && r.has_period !== false && (() => {
                            if (r.prevRevenue === undefined) return <div style={{ fontSize: 11, color: 'var(--theme-text3)', whiteSpace: 'nowrap' }}>vs {prevLabel}: couldn&apos;t check</div>
                            const cmp = compareFigures(Number(r.revenue) || 0, r.prevRevenue, { floor: 1000 })
                            if (!cmp) return null
                            const color = cmp.good == null ? 'var(--theme-text3)' : cmp.good ? 'var(--theme-green-text)' : 'var(--theme-red-text)'
                            return <div style={{ fontSize: 11, fontWeight: 400, whiteSpace: 'nowrap', color }}>{cmp.glyph} {Math.round(cmp.gapPct)}% vs {prevLabel}</div>
                          })()}
                        </td>
                        <td style={{ textAlign: 'right' }}>{r.is_included ? fmtNpr(r.net_purchases) : '—'}</td>
                        <td {...withMark(ratioCell(fcRatio, r.cogs), markOf(costMarks, r.client_id))} />
                        <td style={{ textAlign: 'right' }}>
                          {!r.is_included || r.has_period === false ? '—' : r.labour?.hasFigure ? fmtNpr(r.labour.amount) : '—'}
                          {r.is_included && r.has_period !== false && r.labour?.note && (
                            <div style={{ fontSize: 11, fontWeight: 400, color: r.labour.hasFigure ? 'var(--theme-text2)' : 'var(--theme-amber-text)', whiteSpace: 'nowrap' }}>{r.labour.note}</div>
                          )}
                        </td>
                        <td {...withMark(bandCell(lab, lcBand), markOf(labourMarks, r.client_id))} />
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
                      <td {...ratioCell(groupRatio, groupCogs)} />
                      <td style={{ textAlign: 'right' }}>{fmtNpr(groupLab.labour)}</td>
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
