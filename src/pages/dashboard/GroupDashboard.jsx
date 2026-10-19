import { nprOrDash } from '../../shared/nepalMoney'
import { useEffect, useState, useCallback, useRef } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { supabase } from '../../supabaseClient'
import SuiteGate, { SUITE_PAGES, useSuiteAccess } from '../../components/SuiteGate'
import Tip from '../../components/Tip'
import ReportLoadError from '../../components/ReportLoadError'
import ActionError from '../../components/ActionError'
import { useLatestRequest } from '../../shared/hooks/useLatestRequest'
import { settleWithin } from '../../utils/withTimeout'
import { suiteLive } from '../../utils/subscription'
import OutletAccessPanel from './OutletAccessPanel'
import MasterPushPanel from './MasterPushPanel'
import GroupItemPrices from './GroupItemPrices'
import { BS_MONTHS, bsToAd, daysInBsMonth, formatAd } from '../../utils/bsCalendar'
import { useSettings } from '../../context/SettingsContext'
import { fcBand } from '../../shared/imsFormulas'
import { lcBand, bandFigure } from '../../shared/operatingBands'
import {
  withGroupCogs, fcBasisOf,
  FOOD_COST_LABEL, SPEND_SO_FAR_LABEL, FOOD_COST_TIP, SPEND_SO_FAR_TIP,
} from '../../modules/ims/reports/foodCostBasis'
import { groupOutletLabour, groupLabourRatio, outletLabourNotes } from '../../modules/dashboard/labourSource'
import { loadGroupLabourInputs } from '../../modules/dashboard/loadOutletLabour'
import { mtdClock, nepalBsToday, countedDaysText } from '../../modules/dashboard/mtdClock'
import {
  SETTLE_DAY, FIRST_DAY_TEXT, rowFigure, ratioPair, rowCostRatio, groupRatioOf, costBandWithheld,
  rowLabourPct, labourWithheld, labourBandWithheld, revenueChange, rankMarks,
} from './groupVerdicts'

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
//   - Outlets whose own Crest Suite Pro is not live (S849 ACCESS-1: client_suite_live, the browser
//     gate's rule) come back is_included = false with NULL figures. The filter is server-side, so an
//     unpaid outlet's revenue never reaches the browser at all. They are named below instead of
//     silently dropped, or the group total would under-report with nothing on screen to say so.
//   - Outlets are matched on (bs_year, bs_month), never period_id — monthly_periods is
//     UNIQUE(client_id, bs_year, bs_month) with one open period each, so two outlets genuinely
//     sit in different months. has_period = false is surfaced rather than shown as zero: its row
//     shows dashes and it counts as zero in the totals (S849 DOCS-9).
//
// Labour (S849 GAPS-4/5): OD's one labour rule through `groupOutletLabour` — on an outlet with Crest
// HR its finalized payroll, else the HR wage estimate from get_group_labour_inputs, plus festival /
// incentive / settlement pay finalized for the month; on an outlet without HR its Overheads Labor tab.
// Never get_group_summary's `payroll`, which is NPR 0 for "no finalized run".
//
// The month still running (S849 GROUP-4, GAPS-5): one clock, OD's `mtdClock` (Nepal "today",
// finished days only). Every RATIO divides the finished days (revenue_counted / net_purchases_counted,
// asked for with p_through_day), labour arrives prorated / accrued to the same days, and the money
// columns keep showing everything so far. The per-row rules are groupVerdicts.js.
//
// Crest support (S849 ACCESS-8): the operator reads a viewed client's group by naming it
// (p_group_id = viewGroupId on every read); the push and the access matrix stay the Owner's, so both
// panels are read-only for support.

// While a month is loading, `rows` still holds the PREVIOUS month's outlets — the four totals
// below are derived from it, so they rendered last month's group revenue under this month's
// label until the table beneath them caught up. A figure the page has not computed for the
// period it names is the failure ReportPage's own contract exists to prevent.
const StatSkeleton = () => <span className="skeleton" style={{ display: 'inline-block', width: '3.5em', height: '0.8em', verticalAlign: 'middle' }} />

const fmtNpr = nprOrDash

const READ_TIMEOUT_MS = 20000

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

// The labour notes a row owes the reader (Labor tab not counted, pay not set, the bonus line …),
// for its hover. Their "· Pay Setup →" link hints point at another outlet's page, so they are dropped.
const labourHover = labour => outletLabourNotes(labour).long.map(s => s.replace(/ · [^·]*→$/, ''))

export default function GroupDashboard() {
  const { groupId, viewGroupId, clientId, outlets, canSwitchOutlet, switchOutlet, isAdmin, isOwner } = useAuth()
  // The client's own fc_warning_pct/fc_critical_pct, so the Group Console bands food cost on the
  // same scale as every per-outlet page instead of a hardcoded 35/45.
  const { settings } = useSettings()
  const fcBandOf = pct => fcBand(pct, settings)
  // One banded right-aligned cell: colour, the band name as a title, and the figure with its
  // shape mark. Stated once so a row and the tfoot beneath it cannot drift. `withhold` keeps the
  // figure and drops both the colour and the mark (the dashboards' settledFigure shape).
  const bandCell = (pct, band, withhold = false) => {
    const f = bandFigure(pct, band)
    if (withhold && pct != null) {
      return { style: { textAlign: 'right', color: 'var(--theme-text1)' }, title: undefined, children: `${pct.toFixed(1)}%` }
    }
    return { style: { textAlign: 'right', color: f.style.color }, title: f.title, children: f.text }
  }

  // S849 ACCESS-8 / GAPS-6: Crest support names the VIEWED client's group on every read; an Owner's is
  // resolved by the server from their own home outlet (p_group_id null). AuthContext's groupId is
  // already the viewed group for the operator, never the operator's own row.
  const readGroupId = isAdmin ? (viewGroupId || null) : null
  // S849 ACCESS-7 (SU15): the console opens from any outlet of the group once one outlet has a live
  // Suite; the figures stay per outlet (the RPC includes only outlets whose own Suite is live).
  const groupSuiteLive = (outlets || []).some(o => suiteLive(o))
  const suite = useSuiteAccess(SUITE_PAGES.groupConsole, { entitled: groupSuiteLive })
  // Data loads only once the gate passes (ACCESS's C3 pattern), for an Owner or the operator, in a group.
  const canLoad = suite.allowed && (isAdmin || isOwner) && !!groupId

  const [switching, setSwitching] = useState(null)
  const [switchError, setSwitchError] = useState('')
  const today = nepalBsToday()
  const [bsYear, setBsYear] = useState(today.year)
  const [bsMonth, setBsMonth] = useState(today.month)
  const [rows, setRows] = useState([])
  // The clock the rows were computed on, kept with them so a figure and its rules cannot disagree.
  const [clock, setClock] = useState(() => mtdClock({ bs_year: today.year, bs_month: today.month }, today))
  const [labourError, setLabourError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  // S849 GROUP-8: the last good outlet list, so the two admin panels stay mounted (and keep their
  // unsaved ticks) across a month change, a Refresh or a failed month read. Null until the first
  // successful read: an empty list must never render as "nobody may work anywhere".
  const [outletList, setOutletList] = useState(null)
  const [refreshKey, setRefreshKey] = useState(0)
  // Changing the month re-runs `load` through its own useCallback dep, so arrowing the closed
  // <select> starts one get_group_summary per keypress and the last to LAND wins the figures —
  // while the two <select>s show whatever was picked last. S601's shape exactly, on a page that
  // compares outlets' money across months. The key carries a counter, so a Refresh of the same
  // month supersedes the read before it; it still fails open, so a missed begin() only degrades to
  // the old behaviour rather than blanking the page.
  const monthReq = useLatestRequest()
  const loadSeq = useRef(0)

  const load = useCallback(async () => {
    if (!canLoad) return
    const key = `${bsYear}-${bsMonth}-${readGroupId || 'own'}-${++loadSeq.current}`
    monthReq.begin(key)
    setLoading(true)
    setError(null)
    // Nepal's "today", taken at each load so a Refresh after midnight moves the clock on.
    const c = mtdClock({ bs_year: bsYear, bs_month: bsMonth })
    // pos_orders has no period_id or BS columns — only AD closed_at — so the BS month is
    // converted here and passed through, matching SalesReport.jsx's own convention. Since S809 3n
    // the server takes the month's days from its own bs_months and cuts them at Nepal's midnight;
    // these dates are used only for a month bs_months does not hold.
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
    // Every read for the same (bs_year, bs_month), side by side under the one monthReq key, so a
    // stale month can win none. get_group_pnl carries each outlet's period status, its COGS
    // components (S792, D30) and its payroll / Labor tab / other labour; it checks the same
    // Owner/admin rule get_group_summary does. Each read is bounded (S849 GROUP-16): a hung one is
    // the page's read error, and Refresh works again.
    // S800: last month's summary too, for each outlet's revenue against it. Best-effort: a failure
    // here costs the comparison only, and the cells say so, never the page.
    const prevY = bsMonth === 1 ? bsYear - 1 : bsYear
    const prevM = bsMonth === 1 ? 12 : bsMonth - 1
    const prevStart = bsToAd(prevY, prevM, 1)
    const prevEnd = bsToAd(prevY, prevM, daysInBsMonth(prevY, prevM))
    const [summary, pnl, hrFlags, prevSummary, labourIn] = await Promise.all([
      settleWithin(supabase.rpc('get_group_summary', {
        p_bs_year: bsYear,
        p_bs_month: bsMonth,
        p_ad_start: iso(start),
        p_ad_end: iso(end),
        // The running month's finished days, for the counted pair every ratio divides (null = all).
        p_through_day: c.running ? c.countedDays : null,
        p_group_id: readGroupId,
      }), READ_TIMEOUT_MS, 'Group figures'),
      settleWithin(supabase.rpc('get_group_pnl', { p_bs_year: bsYear, p_bs_month: bsMonth, p_group_id: readGroupId }),
        READ_TIMEOUT_MS, 'Group cost of sales'),
      // Which outlets run Crest HR (the labour rule's first question). `clients` is read raw
      // (clients_select allows same-group rows, and every row for the operator).
      settleWithin(supabase.from('clients').select('id, hr_enabled').eq('group_id', groupId),
        READ_TIMEOUT_MS, 'Outlet modules'),
      settleWithin(supabase.rpc('get_group_summary', {
        p_bs_year: prevY, p_bs_month: prevM, p_ad_start: iso(prevStart), p_ad_end: iso(prevEnd), p_group_id: readGroupId,
      }), READ_TIMEOUT_MS, 'Last month'),
      // The HR wage estimate's inputs for outlets with no finalized run (OD's get_group_labour_inputs).
      loadGroupLabourInputs((name, args) => supabase.rpc(name, args), {
        bsYear, bsMonth, groupId: readGroupId, timeoutMs: READ_TIMEOUT_MS,
      }),
    ])
    if (!monthReq.isCurrent(key)) return
    // A failure of any of the first three reads is the page's error. Without get_group_pnl a closed
    // month has no COGS and no status, so every row would fall back to Spend % so far — a quiet
    // relabelling of the figure the owner came to compare, which is worse than saying the read
    // failed. The error OBJECT goes to ReportLoadError, which words it and keeps the code (S682).
    const err = summary.error || pnl.error || hrFlags.error
    if (err) { setError(err); setRows([]) }
    else {
      // has_closing rides along for the "closed with no count" mark on the row — Consolidated P&L's
      // own warning, for the same rows: such a month's COGS counts the whole shelf as used.
      const pnlById = new Map((pnl.data || []).map(p => [p.client_id, p]))
      const hrById = new Map((hrFlags.data || []).map(x => [x.id, !!x.hr_enabled]))
      // undefined = the comparison read failed; null = that outlet had no month to compare.
      const prevById = prevSummary.error ? null
        : new Map((prevSummary.data || []).map(p => [p.client_id, p.is_included && p.has_period !== false ? Number(p.revenue) || 0 : null]))
      const period = { bs_year: bsYear, bs_month: bsMonth }
      // S849 GAPS-5: a run or a Labor tab is counted for the finished days (scale), the HR estimate
      // accrued through them (throughDay); a closed or past month is the whole month.
      const labourOpts = { period, throughDay: c.countedDays, scale: c.fraction }
      setRows(withGroupCogs(summary.data || [], pnl.data || [])
        .map(r => ({
          ...r,
          has_closing: pnlById.get(r.client_id)?.has_closing ?? null,
          labour: r.is_included
            ? groupOutletLabour(pnlById.get(r.client_id), hrById.get(r.client_id), {
              ...labourOpts, inputs: labourIn.byClient?.get(r.client_id)?.inputs ?? null,
            })
            : null,
          prevRevenue: prevById ? (prevById.get(r.client_id) ?? null) : undefined,
        })))
      setOutletList((summary.data || []).map(r => ({ id: r.client_id, name: r.client_name })))
    }
    setLabourError(labourIn.error || null)
    setClock(c)
    setLoading(false)
  }, [bsYear, bsMonth, groupId, readGroupId, canLoad]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (canLoad) load() }, [canLoad, load])

  // A new group (the operator moving to another client) starts its panels from nothing.
  useEffect(() => { setOutletList(null) }, [groupId])

  // Placed after every hook, and relying on ProtectedRoute having already resolved `profile`.
  // This page had NO role guard at all until S617 — not at the route in App.js, not here — while
  // the sidebar showed it to isAdmin || isOwner only. MonthlyOwnerReport has carried this exact
  // line since it shipped; /pnl and /owner-dashboard were given it in S601; this is the fourth
  // page behind an owner-only nav entry and the last one missing it. Group figures cross tenant
  // boundaries, so the altitude test is the whole point (S601's rule).
  if (!isAdmin && !isOwner) return <Navigate to="/dashboard" replace />

  async function handleGoToOutlet(targetId) {
    setSwitching(targetId)
    setSwitchError('')
    const { error: err } = await switchOutlet(targetId)
    setSwitching(null)
    // S849 GROUP-13: a refused switch is its own message, above the table; the month's figures and
    // the page's read error are untouched. switchOutlet refuses while the offline queue is non-empty
    // or another switch runs, and its refusal is already a written sentence.
    if (err) setSwitchError(err.message || 'Could not switch outlet.')
  }

  function refresh() {
    load()
    setRefreshKey(k => k + 1)
  }

  const prevLabel = BS_MONTHS[(bsMonth === 1 ? 12 : bsMonth - 1) - 1]
  const monthLabel = `${BS_MONTHS[bsMonth - 1]} ${bsYear}`

  const included = rows.filter(r => r.is_included)
  const excluded = rows.filter(r => !r.is_included)
  const noPeriod = included.filter(r => r.has_period === false)
  const inScope = included.filter(r => r.has_period !== false)

  // The money totals show everything so far (a no-period outlet adds zero); every ratio below
  // divides the clock's pair (groupVerdicts.ratioPair).
  const sum = key => included.reduce((t, r) => t + (Number(r[key]) || 0), 0)
  const groupRevenue = sum('revenue')
  const groupPurchases = sum('net_purchases')
  const groupCovers = sum('covers')
  // Labour % only when every outlet in scope has a labour figure (groupLabourRatio), the way
  // groupCostRatio treats food cost; otherwise the outlets without one are named on the card.
  const groupLab = groupLabourRatio(inScope.map(r => ({ name: r.client_name, revenue: ratioPair(r, clock).revenue, labour: r.labour })))
  const groupLabour = clock.firstDay ? null : groupLab.pct
  const groupLabourMissing = groupLab.missing
  // One outlet whose labour is not judged (a lump ahead of revenue, pay not set) leaves the group's
  // Labour % unbanded too.
  const groupLabourWithheld = inScope.some(r => labourBandWithheld(r.labour, clock))
  const lumpRows = inScope.filter(r => labourWithheld(r.labour, clock))

  // Food Cost % or Spend % so far (S792, D30). Each outlet's own figure follows its own month: COGS
  // once it has closed, what it has spent while it is still running. The group's is a Food Cost %
  // only when EVERY included outlet has closed the month (groupCostRatio) — a total built from one
  // branch's COGS and another's purchases would be neither figure. Computed on the group totals, as
  // before, never as an average of the outlets' percentages.
  const groupRatio = groupRatioOf(rows, clock)
  const groupFc = groupRatio.pct
  const groupCostWithheld = costBandWithheld(groupRatio, clock)
  const ratioOf = r => rowCostRatio(r, clock)
  // Which of the two figures the column holds. When outlets stand differently the heading names
  // both and every cell names its own, so no cell can be read under the other's name.
  const shownBases = new Set(inScope.map(r => fcBasisOf(r.period_status)))
  const mixedBases = shownBases.size > 1
  const columnBasis = mixedBases ? 'mixed' : (shownBases.has('cogs') ? 'cogs' : 'spend')
  // Lowest / highest marks (S800): the outlet to learn from and the one to look at, per ratio
  // column — MarginEdge's "your own best outlet as the benchmark". Only with three or more outlets
  // carrying a figure, never across two bases (a Spend % beside a Food Cost % is not a ranking), and
  // never on a figure whose verdict is withheld (S849: before day 10, or labour with a lump ahead).
  const costMarks = mixedBases ? {} : rankMarks(inScope.map(r => {
    const ratio = ratioOf(r)
    return { id: r.client_id, pct: costBandWithheld(ratio, clock) ? null : ratio?.pct ?? null }
  }))
  const labourMarks = rankMarks(inScope.map(r => ({
    id: r.client_id, pct: labourBandWithheld(r.labour, clock) ? null : rowLabourPct(r, clock),
  })))
  const markOf = (marks, id) => marks.low === id ? 'Lowest' : marks.high === id ? 'Highest' : null
  const columnLabel = columnBasis === 'mixed' ? `${FOOD_COST_LABEL} / ${SPEND_SO_FAR_LABEL}`
    : columnBasis === 'cogs' ? FOOD_COST_LABEL : SPEND_SO_FAR_LABEL
  const runningNote = clock.running
    ? ` On the month still running a ${SPEND_SO_FAR_LABEL} counts the finished days only (today counts once it is over), and carries no colour or mark before day ${SETTLE_DAY}, as on each outlet's own dashboard.`
    : ''
  const columnTip = (columnBasis === 'mixed'
    ? `Each outlet's own figure, for this outlet alone — the line under it says which. An outlet that has closed ${BS_MONTHS[bsMonth - 1]} shows its ${FOOD_COST_LABEL}: ${FOOD_COST_TIP} One still in the month shows its ${SPEND_SO_FAR_LABEL}: ${SPEND_SO_FAR_TIP}`
    : `${columnBasis === 'cogs' ? FOOD_COST_TIP : SPEND_SO_FAR_TIP} For this outlet alone.`) + runningNote
  const groupTip = `${groupRatio.basis === 'cogs' ? FOOD_COST_TIP : SPEND_SO_FAR_TIP} ` +
    (groupRatio.basis === 'cogs'
      ? 'Every included outlet has closed this month, so this is the group’s Food Cost %: all outlets’ stock used ÷ all outlets’ revenue.'
      : mixedBases
        ? 'Some outlets have closed this month and some have not, so the group figure is Spend % so far over all of them — a total mixing one outlet’s stock used with another’s purchases would be neither figure. Each outlet’s own figure is in the table.'
        : 'The group figure: all outlets’ net purchases ÷ all outlets’ revenue.') +
    ` Computed on the group totals, not as an average of each outlet's percentage — a small outlet must not swing the group figure as hard as a large one. Coloured against your own Settings food cost thresholds as a guide: watch above ${fcBandOf(groupFc).warn}%, too high above ${fcBandOf(groupFc).critical}%.` +
    runningNote
  // One cost-ratio cell: bandCell's figure and colour, the ratio's own name under it when the
  // column holds both kinds, and — for a Food Cost % — the COGS it came from on hover, since the
  // Net Purchases column beside it is not what it divides.
  const ratioCell = (ratio, cogs) => {
    const c = bandCell(ratio?.pct ?? null, fcBandOf, costBandWithheld(ratio, clock))
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
    ? inScope.reduce((t, r) => t + (Number(r.cogs) || 0), 0)
    : null
  const daysText = countedDaysText(clock)
  const costSub = !clock.running ? null
    : clock.firstDay ? FIRST_DAY_TEXT
    : [daysText, groupCostWithheld ? `no colour before day ${SETTLE_DAY}` : null].filter(Boolean).join(' · ')

  const years = [today.year - 1, today.year, today.year + 1]

  // The no-group card says the next step for whoever is reading: the Owner asks their consultant;
  // Crest support sets groups up itself (never "contact your consultant" to the consultant).
  const noGroupCard = (
    <div className="card" style={{ textAlign: 'center', padding: '48px 24px' }}>
      <p style={{ fontSize: 15, fontWeight: 600, color: 'var(--theme-text1)', margin: '0 0 8px' }}>
        {isAdmin ? 'This client’s outlet is not in a group' : 'This outlet isn’t part of a group yet'}
      </p>
      <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: 0 }}>
        {isAdmin
          ? 'Groups are set up in Admin → Clients → the client’s Billing tab.'
          : 'Contact your consultant to link your outlets together — then they all appear here.'}
      </p>
    </div>
  )

  const body = () => (!groupId ? noGroupCard : (
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
        <button className="btn btn-ghost" onClick={refresh} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button>
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
              {excluded.map(r => r.client_name).join(', ')} {excluded.length === 1 ? 'is not on Crest Suite Pro, or its Suite Pro has' : 'are not on Crest Suite Pro, or their Suite Pro has'} lapsed —
              add it there to include {excluded.length === 1 ? 'its' : 'their'} revenue in these totals.
            </p>
          )}
          {noPeriod.length > 0 && (
            <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--theme-text2)', lineHeight: 1.5 }}>
              {noPeriod.map(r => r.client_name).join(', ')} {noPeriod.length === 1 ? 'has' : 'have'} no period open for
              {' '}{monthLabel} yet, so {noPeriod.length === 1 ? 'its row shows' : 'their rows show'} dashes
              and {noPeriod.length === 1 ? 'it counts' : 'they count'} as zero in the totals above — any till bills
              {noPeriod.length === 1 ? ' it' : ' they'} took are waiting for a period.
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
          <div className="stat-label"><Tip text="Sum of every included outlet's Inventory sales for this BS month: before VAT, after discounts, complimentary dishes left out, credit notes taken off once they reach Inventory. A till bill is in it once it has been posted to Inventory, which happens as it is paid while the month is open there. A bill still waiting to be posted (the till floor's Post to Inventory, or Periods → Post POS bills to Inventory) is not in it yet. On the month still running it is everything so far, today included." width={300}>Group Revenue</Tip></div>
          <div className="stat-value">{loading ? <StatSkeleton /> : fmtNpr(groupRevenue)}</div>
          {!loading && clock.running && <div className="stat-sub">so far, today included</div>}
        </div>
        <div className="stat-card">
          {/* The label follows the figure (S792, D30): "Group Spend % so far" until every
              included outlet has closed the month, "Group Food Cost %" once they all have.
              Held at the neutral label while loading, when neither is known yet. */}
          <div className="stat-label"><Tip text={groupTip} width={300}>{loading ? 'Group Food Cost / Spend %' : `Group ${groupRatio.label}`}</Tip></div>
          {(() => {
            const c = bandCell(groupFc, fcBandOf, groupCostWithheld)
            return <div className="stat-value" style={{ color: loading ? undefined : c.style.color }} title={loading ? undefined : c.title}>{loading ? <StatSkeleton /> : c.children}</div>
          })()}
          {!loading && costSub && <div className="stat-sub">{costSub}</div>}
        </div>
        <div className="stat-card">
          <div className="stat-label"><Tip text="All outlets' labour ÷ all outlets' revenue. Each outlet's labour: on an outlet with Crest HR, its finalized payroll (pay earned + overtime + employer SSF), or until payroll is finalized the HR wage estimate through the last finished day, plus festival allowance, incentives and final settlements finalized for the month; on an outlet without Crest HR, what was typed on its Overheads Labor tab. On the month still running, a finalized run or a Labor tab is counted for the finished days only, and a festival allowance, incentive or final settlement paid in it leaves the figure without a colour, because it is not spread over the month. Shown only when every outlet has a labour figure, so an outlet without one cannot make the group look cheaper to staff than it is. Banded on the product's published 25–30% target, the same scale the Owner Dashboard and the Monthly Owner Report use." width={300}>Group Labour %</Tip></div>
          {(() => {
            const c = bandCell(groupLabour, lcBand, groupLabourWithheld)
            return <div className="stat-value" style={{ color: loading ? undefined : c.style.color }} title={loading ? undefined : c.title}>{loading ? <StatSkeleton /> : c.children}</div>
          })()}
          {!loading && clock.firstDay && <div className="stat-sub">{FIRST_DAY_TEXT}</div>}
          {!loading && !clock.firstDay && groupLabourMissing.length > 0 && (
            <div className="stat-sub">No labour figure yet: {groupLabourMissing.join(', ')}</div>
          )}
          {!loading && !clock.firstDay && groupLabourMissing.length === 0 && lumpRows.length > 0 && (
            <div className="stat-sub">Not judged yet: bonus or final pay in {lumpRows.map(r => r.client_name).join(', ')}</div>
          )}
          {!loading && labourError && (
            <div className="stat-sub">HR wage estimates could not be loaded — Refresh to try again.</div>
          )}
        </div>
        <div className="stat-card">
          <div className="stat-label"><Tip text="Guests seated at tables across included outlets, from paid POS bills closed within this BS month, Nepal time: each outlet's Covers Report count. Takeaway and delivery bills seat no guests, so they are not counted; a bill later credit-noted still counts its guests. Outlets without POS contribute zero." width={300}>Group Covers</Tip></div>
          {/* Zero covers is a COUNT, not a missing figure — an em-dash here says "we could not
              work this out" about a group whose outlets simply took no POS bills, on a page
              whose coverage banner above already explains any real gap (S734). */}
          <div className="stat-value">{loading ? <StatSkeleton /> : groupCovers.toLocaleString('en-IN')}</div>
        </div>
      </div>}

      {switchError && <div style={{ marginBottom: 12 }}><ActionError error={switchError} /></div>}

      {/* Same gate as the KPI strip. Without it a failed read rendered ReportLoadError —
          "nothing here is a real figure" — directly above a table body reading "No outlets
          in this group" (rows is [] on failure), two contradictory sentences (S683). */}
      {!error && <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Outlet</th>
              <th style={{ textAlign: 'right' }}><Tip text="This outlet's Inventory sales for the month, before VAT. On the month still running it is everything so far, today included; the line under it compares it with last month's whole month." width={280}>Revenue</Tip></th>
              <th style={{ textAlign: 'right' }}>Net Purchases</th>
              {/* Neutral while loading: `rows` still holds the previous month, whose outlets may stand differently. */}
              <th style={{ textAlign: 'right' }}><Tip text={columnTip} width={300}>{loading ? 'Food Cost / Spend %' : columnLabel}</Tip></th>
              <th style={{ textAlign: 'right' }}><Tip text="This outlet's labour for the month. With Crest HR: its finalized payroll (pay earned + overtime + employer SSF), or until payroll is finalized the HR wage estimate (“estimate”), plus festival allowance, incentives and leavers' final settlements finalized for the month (hover the note for the amounts). Without Crest HR: what was typed on its Overheads Labor tab (“Labor tab”); “none entered” means nothing is there. “not loaded” means its labour could not be read. On the month still running, a run or a Labor tab is counted for the finished days only." width={300}>Labour</Tip></th>
              <th style={{ textAlign: 'right' }}><Tip text="Labour ÷ revenue for this outlet alone, on the same days. No band while the outlet has no labour figure, while its pay is not fully set, or while a bonus or final pay paid this month sits over part of a month's sales.">Labour %</Tip></th>
              <th style={{ textAlign: 'right' }}>Covers</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={7} style={{ color: 'var(--theme-text2)' }}>Loading…</td></tr>}
            {!loading && rows.length === 0 && <tr><td colSpan={7} style={{ color: 'var(--theme-text2)' }}>No outlets in this group.</td></tr>}
            {!loading && rows.map(r => {
              const fcRatio = ratioOf(r)
              const labPct = rowLabourPct(r, clock)
              const labWithheld = labourBandWithheld(r.labour, clock)
              const lump = labourWithheld(r.labour, clock)
              const change = revenueChange(r, clock, prevLabel)
              const hover = r.labour ? labourHover(r.labour) : []
              if (lump) hover.push('Paid in a month still running and not spread over it, so this row is not judged until the month ends')
              const labourNote = r.labour?.note
                ? [r.labour.note, daysText && r.labour.hasFigure ? daysText : null].filter(Boolean).join(' · ')
                : null
              const canGo = !isAdmin && canSwitchOutlet && r.client_id !== clientId
              // No opacity dimming on excluded rows. It read as de-emphasis but multiplies
              // straight through the text colour — text2 at 0.55 measured under 3:1 — and the
              // "No Suite Pro" badge plus a row of em-dashes already says the same thing
              // without costing anyone legibility.
              return (
                <tr key={r.client_id}>
                  <td>
                    {/* The point of spotting a bad outlet here is to go into it. Without this
                        the reader has to leave, find the sidebar switcher and re-pick by name.
                        S849 GROUP-14: every link waits while any switch is in flight. Crest
                        support reads names only: view-as is changed from Admin → Clients. */}
                    {canGo ? (
                      <button
                        className="btn-linklike"
                        onClick={() => handleGoToOutlet(r.client_id)}
                        disabled={!!switching}
                      >
                        {switching === r.client_id ? 'Switching…' : r.client_name}
                      </button>
                    ) : r.client_name}
                    {r.client_id === clientId && <span className="badge-yellow" style={{ marginLeft: 6 }}>Viewing</span>}
                    {!r.is_included && <span className="badge-gray" style={{ marginLeft: 6 }}>No Suite Pro</span>}
                    {r.is_included && r.has_period === false && <span className="badge-amber" style={{ marginLeft: 6 }}>No period</span>}
                    {r.is_included && r.period_status === 'closed' && r.has_closing === false && (
                      <Tip text={`This outlet closed ${BS_MONTHS[bsMonth - 1]} without a closing stock count, so its Food Cost % counts everything on the shelf as used and reads high. Enter the count in that outlet's Stock Count, then Resync Opening Stock in Periods.`} width={280}
                        style={{ display: 'inline-flex', borderBottom: 'none', cursor: 'default', marginLeft: 6 }}>
                        <span className="badge-amber">No count</span>
                      </Tip>
                    )}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {fmtNpr(rowFigure(r, 'revenue'))}
                    {change && (
                      <div style={{ fontSize: 11, fontWeight: 400, whiteSpace: 'nowrap', color: change.good == null ? 'var(--theme-text3)' : change.good ? 'var(--theme-green-text)' : 'var(--theme-red-text)' }}>
                        {change.text}
                      </div>
                    )}
                  </td>
                  <td style={{ textAlign: 'right' }}>{fmtNpr(rowFigure(r, 'net_purchases'))}</td>
                  <td {...withMark(ratioCell(fcRatio, r.cogs), markOf(costMarks, r.client_id))} />
                  <td style={{ textAlign: 'right' }}>
                    {!r.is_included || r.has_period === false ? '—' : r.labour?.hasFigure ? fmtNpr(r.labour.amount) : '—'}
                    {r.is_included && r.has_period !== false && labourNote && (
                      <div style={{ fontSize: 11, fontWeight: 400, color: r.labour.hasFigure && !lump ? 'var(--theme-text2)' : 'var(--theme-amber-text)', whiteSpace: 'nowrap' }}>
                        {/* S798 3c / S849: the short note inline, every sentence the row owes in the Tip. */}
                        {hover.length > 0
                          ? <Tip text={hover.map(t => `${t[0].toUpperCase()}${t.slice(1)}.`).join(' ')} width={280}>{labourNote}</Tip>
                          : labourNote}
                      </div>
                    )}
                  </td>
                  <td {...withMark(bandCell(labPct, lcBand, labWithheld), markOf(labourMarks, r.client_id))} />
                  <td style={{ textAlign: 'right' }}>{rowFigure(r, 'covers') == null ? '—' : rowFigure(r, 'covers').toLocaleString('en-IN')}</td>
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
                <td {...bandCell(groupLabour, lcBand, groupLabourWithheld)} />
                <td style={{ textAlign: 'right' }}>{groupCovers.toLocaleString('en-IN')}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>}

      {/* S800: its own read, started with the month's other reads rather than after them, so
          it waits only on the page-level error (one failure card, not two). */}
      {!error && <GroupItemPrices bsYear={bsYear} bsMonth={bsMonth} readGroupId={readGroupId} refreshKey={refreshKey} />}

      {/* Rendered from the summary's outlets, not from AuthContext's `outlets`: this matrix must
          list every outlet in the group, including ones excluded from the figures above for want
          of Suite Pro. Access is about where someone may work, not about what the group is billed
          for — omitting an unpaid outlet would silently make it un-staffable.
          S849 GROUP-8: from the LAST GOOD outlet list, so both stay mounted (with their unsaved
          ticks) across a month change, a Refresh or a failed month read; they have their own reads.
          The first render still waits for a successful read: an outlet list built from a failed one
          is empty, and an empty access matrix reads as "nobody may work anywhere". */}
      {outletList && <>
        <OutletAccessPanel outlets={outletList} readGroupId={readGroupId} readOnly={isAdmin} />
        <MasterPushPanel outlets={outletList} groupId={groupId} readOnly={isAdmin} />
      </>}
    </>
  ))

  return (
    <div>
      <div className="page-header no-print">
        <div>
          <h1 className="page-title">Group Console</h1>
          <p className="page-subtitle">Every outlet in the group, side by side for one BS month</p>
        </div>
      </div>

      {/* The render prop: nothing inside runs behind the card (ACCESS's C3 pattern), and the gate
          answers exactly what `canLoad` asked (the same page and the same group-wide entitlement). */}
      <SuiteGate page={SUITE_PAGES.groupConsole} entitled={groupSuiteLive}>
        {body}
      </SuiteGate>
    </div>
  )
}
