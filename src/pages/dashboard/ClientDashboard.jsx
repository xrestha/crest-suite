import { useEffect, useState, useRef } from 'react'
import { useAuth } from '../../context/AuthContext'
import { useTheme } from '../../context/ThemeContext'
import { useSettings } from '../../context/SettingsContext'
import { fcBand, fcThresholds, recipeCostOf } from '../../shared/imsFormulas'
import { nmBand, descendingBand, bandFigure } from '../../shared/operatingBands'
import { supabase } from '../../supabaseClient'
import { useScopedDb } from '../../shared/hooks/useScopedDb'
import { fetchAllRows } from '../../shared/fetchAllRows'
import { firstError } from '../../shared/queryError'
import {
  dailySalesMap, dailyPurchaseMap, historyWindowDays, baseFromHistory, baseFromMonth,
  projectMonth, makeSnapshot, isCurrentSnapshot, staleSnapshotFilter, targetValue, splitAtToday,
  monthFestivals, salesFestivalFactor, salesFestivalJudged, purchFestivalJudged, targetTotal, dayRanges, canCaptureTarget,
  festivalLearnRuns,
} from '../../modules/dashboard/dailyForecast'
import { holidaysByKeyOf } from '../../utils/demandForecastMath'
import {
  adDateOf, adDateBack, rainPctValue, rainFactorForMonth, rainAhead, measuredRainEffect,
  WEATHER_HORIZON_DAYS, RAIN_MM, MIN_MEASURE_DAYS,
} from '../../modules/dashboard/weatherEffect'
import { useWeatherStrip } from '../../modules/dashboard/useWeatherStrip'
import { isPayrollFenced, resolveOutletLabour, outletLabourNotes, labourNotJudgedText, splitOverheadBuckets } from '../../modules/dashboard/labourSource'
import { loadOutletLabour } from '../../modules/dashboard/loadOutletLabour'
import { mtdClock, nepalBsToday, countedDaysText, prorate } from '../../modules/dashboard/mtdClock'
import { revenueOf, netSpendOf, operatingFigures } from '../../modules/dashboard/ownerDashboardData'
import { readPeriodTransfers, transferValueByItem } from '../../modules/ims/transfers/transferFlows'
import { loadDeliveryCommission, bsMonthWindow } from '../../shared/deliveryCommission'
import { settleWithin } from '../../utils/withTimeout'
import { fcTrendView, MIN_COMPARED_MONTHS } from '../../modules/dashboard/fcTrendMath'
import { useNavigate, useLocation, Navigate, Link } from 'react-router-dom'
import {
  ResponsiveContainer, PieChart, Pie, Cell, Tooltip,
  LineChart, Line, ComposedChart, Area, XAxis, YAxis, CartesianGrid, ReferenceLine,
  BarChart, Bar, Dot, ErrorBar
} from 'recharts'
import { chartMotion } from '../../shared/chartMotion'
import { TOOLTIP_CHROME } from '../../shared/tooltipChrome'
import { ArrowDown, Lock, TriangleAlert, Clock, LayoutGrid, ArrowRight } from 'lucide-react'
import Tip from '../../components/Tip'
import ChartCard from '../../components/ChartCard'
import StatPill from '../../components/StatPill'
import ConfirmModal from '../../components/ConfirmModal'
import { closingCountPreflight, payrollPreflight, payrollNote, performPeriodClose, closeFailuresText, closerMakesReport, deferredReportNote, nextBsMonth, tillWaitingPreflight, tillWaitingNote } from '../periods/closePeriod'
import { backfillLeaveText } from '../../modules/hr/leave/backfillApprovedLeave'
import { closingCountNote } from '../periods/closingCountNote'
import CloseConfirmBody from '../periods/CloseConfirmBody'
import { BS_MONTHS, BS_MONTHS_SHORT, daysInBsMonth, bsToAd, formatAd, bsDayBoundaryIso } from '../../utils/bsCalendar'
import { nepalBs, nepalCivilDate, serviceDayStartIso } from '../../shared/nepalTime'
import { carryOverFrom, stillInPlay } from '../../modules/pos/reservations/reservationStatus'
import { getSubStatus } from '../../utils/subscription'
import { explodeRecipeIngredients, getSuggestedPrice } from '../../utils/recipeCost'
import { buildStockRows, buildUsageMap, transferNetQtyMap } from '../../modules/ims/stockcount/stockReportCalc'
import { loadDeltaExplosion } from '../../utils/orderLineIngredients'
import { allocateBillDiscounts, returnCostValue } from '../../modules/ims/reports/supplierAttribution'
import { valuePeriods, periodWastageValue, WASTAGE_VALUE_SELECT } from '../../modules/ims/reports/periodCost'
import { FOOD_COST_LABEL, SPEND_SO_FAR_LABEL, SPEND_SO_FAR_TIP } from '../../modules/ims/reports/foodCostBasis'
import { FEATURE_TIER } from '../../shared/featureCatalog'
import { useHrApprovalCounts } from '../../modules/hr/dashboard/useHrApprovalCounts'
import SalesPivot from '../../modules/dashboard/SalesPivot'
import { useFoodBeverageSplit } from '../../modules/dashboard/useFoodBeverageSplit'
import { readDashboardCache, writeDashboardCache } from './dashboardCache'
import SetupGuideCard from '../../components/SetupGuideCard'
import HomeAttention from './HomeAttention'
import ImsPriceMovers from '../../modules/ims/dashboard/ImsPriceMovers'
import SupportContactLine from '../../components/SupportContactLine'
import WeatherHeaderSlot from './WeatherHeaderSlot'
import { CHART_COLORS, COST_BREAKDOWN_COLORS, costSliceColor } from '../../shared/chartColors'
import { dashboardModules, IMS_DASHBOARD_PATH } from '../../shared/dashboardHome'
import { npr } from '../../shared/nepalMoney'
import { KDS_LATE_MS } from '../../modules/pos/posSignals'
import { KOT_CHANGE_ITEMS } from '../../modules/pos/kitchenNotes'
import { summariseBills, returnsOf } from '../../modules/pos/dashboard/posDashboardMath'
import { HOME_POS_READS, HOME_KITCHEN_READS, anyReadFailed, keepLastGood, readUnavailable } from './homePosStats'
import { waitingRequests } from '../../shared/reservationSeen'
// 'growth' → 'Growth', for an upsell naming the plan a feature is sold on (FEATURE_TIER).
const tierLabel = t => (t ? t[0].toUpperCase() + t.slice(1) : '')

// Today's BS date as Kathmandu reads it (S792, PLANNING-9) is `nepalBsToday`, which moved to
// mtdClock.js in S849 (OWNER-DASHBOARD-17) so the Owner Dashboard reads the same "today".

// Roving-tabindex tab row for in-card view switches — completes the tablist contract the bare
// role="tablist"/"tab" markup used to promise without delivering (aria-controls, roving tabIndex,
// arrow keys; dashboard critique P2, S569). idBase must be unique per rendered INSTANCE: a
// ChartCard's compact card and its expanded modal render concurrently, so callers suffix idBase
// with the render size (`big`/`small`) to keep DOM ids unique.
function ChartTabs({ idBase, label, tabs, active, onChange }) {
  const onKeyDown = e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const idx = tabs.findIndex(t => t.key === active)
    const next = tabs[(idx + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]
    onChange(next.key)
    // Focus follows selection after the re-render flips the roving tabIndex
    requestAnimationFrame(() => document.getElementById(`${idBase}-tab-${next.key}`)?.focus())
  }
  return (
    <div className="tab-bar" role="tablist" aria-label={label} style={{ marginBottom: 8 }} onKeyDown={onKeyDown}>
      {tabs.map(t => (
        <button
          key={t.key} type="button" role="tab"
          id={`${idBase}-tab-${t.key}`}
          aria-selected={active === t.key}
          aria-controls={`${idBase}-panel`}
          tabIndex={active === t.key ? 0 : -1}
          className={`tab-btn${active === t.key ? ' tab-btn--active' : ''}`}
          onClick={() => onChange(t.key)}
        >{t.label}</button>
      ))}
    </div>
  )
}

// Daily Purchases vs Sales — fixed hex for the same reason COST_BREAKDOWN_COLORS is (see the long
// note at its definition): CSS var() does not resolve in Recharts SVG props, and the semantic
// token set is five roles rather than five distinguishable hues.
//
// The shape matters more than the values here. This chart draws a metric and its month-end
// PROJECTION, and those were four unrelated hues — purchases gold, its projection red; sales
// green, its projection violet. So the projection of purchases rendered in the one colour this
// dashboard uses to mean "over threshold", and neither dashed line shared a hue with the solid
// line it extends. A projection is the same measure, less certain: same hue, dash carries the
// distinction. That drops the chart from four hues to two and makes the legend self-evident.
//
// The frozen Target line (added alongside the live projection) breaks that rule on purpose: with
// three series per metric — actual, live projection, frozen target — two of them sharing both hue
// AND a dash/dot stroke read as near-duplicates at compact-card size. Target gets its own hue per
// metric, reusing two colours already in this file's own CHART_COLORS palette (so nothing foreign
// enters the page), and keeps the dotted glyph on top of that so it's told apart two ways at once.
const DAILY_TREND_COLORS = {
  purchases: '#c9a84c', // gold — one identity for Food Cost across every surface that draws it
  sales:     '#34d399', // green
  purchTarget: '#fb923c', // orange — frozen Purch. Target, deliberately not gold
  salesTarget: '#60a5fa', // blue — frozen Sales Target, deliberately not green
}

// Which actual series each dashed projection extends. The tooltip suppresses a projection row on
// any day its actual is present (the anchor day), and projActiveDot suppresses the projection's
// anchor-day dot for the same reason — the pairing lives here once so the two consumers can't
// drift, and a third metric pair is one entry here plus its columns in the trend build.
const PROJ_ACTUAL_KEY = { salesProj: 'sales', purchProj: 'purchases' }

// Which frozen Target line each actual series is measured against, and which direction off that
// line is the GOOD one (+1 = above is good, -1 = below is good). Selling more than the pace you
// locked in is a win; spending more than it is not. Keyed by dataKey so a third metric pair is one
// entry here, the same way PROJ_ACTUAL_KEY above works.
const TARGET_KEY = { sales: 'salesTarget', purchases: 'purchTarget', salesToday: 'salesTarget', purchToday: 'purchTarget' }
const GOOD_DIRECTION = { sales: 1, purchases: -1 }

// How far off target still counts as ON target. Without a dead zone every single day earns a
// verdict — NPR 3,115 against a NPR 3,112 target painted red — and a chart where all thirty days
// are lit green or red has stopped saying anything at all. The band is what makes a colour mean
// "this day actually moved" rather than "this day exists".
//
// TWO thresholds, whichever is more forgiving, because one is wrong at each end of the range: 2%
// of a NPR 3,000 delivery day is NPR 60 and fairly ignored, but on a quiet Sunday with a NPR 200
// target even a 10% swing is NPR 20 and means nothing. Same shape as the delivery-partner
// commission check in POS, which needed a percentage AND a rupee tolerance before it stopped
// raising false alarms on per-bill rounding.
const TARGET_TOLERANCE_PCT = 2
const TARGET_TOLERANCE_NPR = 100

// Custom tooltip for Daily Purchases vs Sales, at module scope so React sees one stable component
// type (an inline arrow is a brand-new type every parent render, remounting the tooltip subtree —
// same hoisted shape as MenuEngineering's ScatterTooltipContent). Recharts clones this element
// with { active, payload, label }; `big` comes from the render site.
//
// Why custom content rather than contentStyle/formatter: the dashed projection series anchor at
// the last actual day so the line connects (see the trend build in loadStats), and Recharts'
// default tooltip can't tell an anchor from a forecast — on that one day it listed "Sales
// Projection: NPR 13,721" right under an identical "Sales: NPR 13,721", restating the actual
// under a label that claims it was computed. A projection row is only shown on days that have no
// actual for the same metric. Rows are sorted by value, highest first, so the tooltip reads in
// the same top-to-bottom order as the lines it describes at that day. Each row keeps its series
// hue as a ● swatch while the text takes --theme-text1 — a chart hex as 11px body text measures
// ~1.9:1 on a light card (the S550 rule), and this is a plain <div>, so the CSS variable resolves
// natively (no useTheme-resolved hex needed, unlike Recharts SVG props); whiteSpace keeps a long
// NPR row from wrapping the way Recharts' own container never does.
function TrendTooltipContent({ active, payload, label, big }) {
  if (!active || !payload?.length) return null
  const row = payload[0]?.payload || {}
  const shown = payload.filter(en => {
    if (en.value == null) return false
    const actualKey = PROJ_ACTUAL_KEY[en.dataKey]
    // Today (S792 PLANNING-2) keeps both rows: what it has sold so far, and what the whole day is
    // forecast to reach. There the projection is not an anchor restating the actual.
    if (actualKey && row[actualKey] != null && !row.inProgress) return false
    return true
  }).sort((a, b) => Number(b.value) - Number(a.value))
  if (!shown.length) return null
  return (
    <div style={{ ...TOOLTIP_CHROME, ...(big && { fontSize: 12 }), color: 'var(--theme-text1)', padding: '8px 16px', whiteSpace: 'nowrap' }}>
      <p style={{ margin: 0, fontWeight: 600 }}>{label}</p>
      {/* S850: a festival's day says which festival, and what it does to the sales lines. */}
      {row.festival && (
        <p style={{ margin: '2px 0 0', color: 'var(--theme-text3)', fontSize: big ? 11 : 10 }}>
          {row.festival.name} · {row.festival.multiplier != null
            ? `Demand Multiplier ×${row.festival.multiplier} on sales`
            : row.festLearned
              ? `sales forecast ${row.festLearned.pct}% of a usual day, from Day ${dayRanges(row.festLearned.from)}`
              : 'no Demand Multiplier set in Holiday Calendar'}
        </p>
      )}
      {shown.map(en => {
        // Actual-vs-target gap on the two actual rows; the target rows themselves carry none, and
        // nothing renders until that metric's Target line has been captured.
        //
        // SHAPE IS THE FACT, COLOUR IS THE VERDICT. ▲/▼ stays literal — it has to agree with the
        // line you can see sitting above or below the dotted target two pixels away — while the
        // colour asks whether that is the good direction for THIS metric (GOOD_DIRECTION above).
        // This reverses the original call, which coloured both rows ▲ green / ▼ red on the
        // reasoning that a tooltip glyph states a position rather than passing a verdict. Reported
        // live and the report was right: a red ▼ on "Purchases : NPR 2,295" against a NPR 3,112
        // target reads as a problem when it is the opposite — the one row on the chart where
        // under-running the pace is exactly what you wanted.
        const targetKey = TARGET_KEY[en.dataKey]
        // Today's actual is a part-day: labelled "so far" and given no verdict, because a
        // morning's takings under a whole day's Target is not a day that ran below it.
        const soFar = !!(targetKey && row.inProgress)
        const target = targetKey && !soFar ? row[targetKey] : null
        const value = Number(en.value)
        const gap = target == null ? null : value - target
        // Percent of target, not rupees: the row already prints one NPR figure and the Target row
        // prints the other, so the ratio is the thing neither of them gives you — and it reads the
        // same on a quiet Sunday as on a delivery day. Guarded against a zero target.
        const gapPct = gap && target ? Math.abs(gap / target) * 100 : null
        // Inside the band the DIRECTION is noise, so the glyph goes neutral too — ≈ rather than a
        // ▲/▼ nobody should read anything into. The percentage still prints, in grey: saying
        // "≈ 1.2%" is more honest than hiding the number, because it shows the reader what we are
        // calling on target rather than asking them to trust it.
        const onTarget = gap != null && target != null &&
          Math.abs(gap) <= Math.max(Math.abs(target) * (TARGET_TOLERANCE_PCT / 100), TARGET_TOLERANCE_NPR)
        const good = gap == null || gap === 0 || onTarget ? null : Math.sign(gap) === GOOD_DIRECTION[en.dataKey]
        const mark = gap == null ? null
          : onTarget ? { glyph: '≈', color: 'var(--theme-text3)' }
          : { glyph: gap > 0 ? '▲' : '▼', color: good ? 'var(--theme-green-text)' : 'var(--theme-red-text)' }
        return (
          <p key={en.dataKey} style={{ margin: '4px 0 0' }}>
            <span style={{ color: en.color }}>{soFar ? '○' : '●'}</span> {en.name}{soFar && ' so far'} : NPR {Math.round(value).toLocaleString('en-IN')}
            {mark && (
              <span style={{ color: mark.color }}>
                {' '}{mark.glyph}{gapPct != null && ` ${gapPct < 1 ? gapPct.toFixed(1) : Math.round(gapPct)}%`}
              </span>
            )}
            {/* S784: why this forecast day sits lower (or higher) than its weekday usually does. */}
            {en.dataKey === 'salesProj' && row.rainMm != null && (
              <span style={{ display: 'block', color: 'var(--theme-text3)', fontSize: big ? 11 : 10 }}>
                Rain expected ({row.rainMm} mm) · forecast × {row.rainPct}%
              </span>
            )}
          </p>
        )
      })}
    </div>
  )
}

// The Food Cost % trend's hover box (S826). Custom because the chart draws each point through up
// to four series (solid, faded, the dashed bridge and the markers), and Recharts' own box would list
// the same figure once per series. Everything reads off the row fcTrendMath.js built. A plain <div>,
// so the band colour is the CSS variable itself, with its ✓/△/▲ so the verdict is not colour-only.
function FcTrendTooltipContent({ active, payload, big, bander, warn }) {
  if (!active || !payload?.length) return null
  const p = payload[0]?.payload
  if (!p || p.fc == null) return null
  const line = { margin: '4px 0 0' }
  const sub = { margin: '4px 0 0', color: 'var(--theme-text2)' }
  const signed = n => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(Math.abs(n) < 10 ? 1 : 0)}%`
  const since = p.change && p.change.salesPct != null && (
    <p style={sub}>
      Since {p.change.prevLabel}: revenue {signed(p.change.salesPct)}
      {p.change.usedPct != null && ` · stock used ${signed(p.change.usedPct)}`}
    </p>
  )
  const fig = bandFigure(p.fc, bander)
  return (
    <div style={{ ...TOOLTIP_CHROME, ...(big && { fontSize: 12 }), color: 'var(--theme-text1)', padding: '8px 16px', maxWidth: 320 }}>
      <p style={{ margin: 0, fontWeight: 600 }}>{p.label}</p>
      {p.open ? (
        <>
          <p style={line}>{SPEND_SO_FAR_LABEL}: {p.fc}% · part-month</p>
          {p.purchases != null && <p style={sub}>Spent so far: {npr(p.purchases)}</p>}
          {p.revenue != null && <p style={sub}>Revenue so far: {npr(p.revenue)}</p>}
        </>
      ) : p.unjudged ? (
        <>
          <p style={line}>{FOOD_COST_LABEL}: {p.fc}% · not judged: stock count incomplete</p>
          <p style={sub}>Stock used: {npr(p.cogs)} · Revenue: {npr(p.revenue)}</p>
          {p.uncountedCount > 0 && p.uncountedValue > 0 && (
            <p style={sub}>
              {p.uncountedCount} item{p.uncountedCount === 1 ? '' : 's'} with stock had no closing count
              ({npr(p.uncountedValue)}), so all of it counts as used.
            </p>
          )}
          {p.lowFc != null && <p style={line}>Real figure: somewhere between {p.lowFc}% and {p.fc}%</p>}
          {since}
        </>
      ) : (
        <>
          <p style={line}>{FOOD_COST_LABEL}: <span style={fig.style} title={fig.title}>{fig.text}</span></p>
          <p style={sub}>Stock used: {npr(p.cogs)} · Revenue: {npr(p.revenue)}</p>
          {p.aboveGood != null && (
            <p style={sub}>{npr(Math.abs(p.aboveGood))} {p.aboveGood >= 0 ? 'above' : 'under'} the {warn}% Good line</p>
          )}
          {since}
        </>
      )}
    </div>
  )
}

// Sunday-first, one letter each, exactly as asked for — S/M/T/W/T/F/S. Tue and Thu (and Sun/Sat)
// share a letter; that ambiguity is accepted on purpose rather than solved with two-letter codes,
// matching the plain single-glyph weekday row this was modeled on. Index matches JS Date.getDay().
const WEEKDAY_INITIALS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

// The Daily Purchases vs Sales history read: the open month's two predecessors, for the 28-day
// window dailyForecast.js learns the weekday pattern from. Two months because a BS month can be
// shorter than the window's reach on a boundary; historyWindowDays() keeps only the days inside
// it. Returns raw rows plus the first error, and never throws: a failed read must reach the
// caller as a failure, not as an empty history (see the trend build in loadStats).
//
// It also reads the Holiday Calendar over those months and this one (S850), through the DEFINER
// get_forecast_holidays: the table reads EMPTY, not failed, for an IMS staff or till login, and
// whichever Owner, operator or IMS login opens the dashboard first captures the month's Target
// (canCaptureTarget, S849). A failed holiday read is a
// failed history read, so no Target is captured from a calendar that could not be read.
async function loadForecastHistory(scopedFrom, period, clientId) {
  const prev = k => {
    const m = period.bs_month - k
    return m >= 1 ? { y: period.bs_year, m } : { y: period.bs_year - 1, m: m + 12 }
  }
  const wanted = [prev(1), prev(2)]
  const [{ data: periodRows, error: periodErr }, { data: holidayRows, error: holidayErr }] = await Promise.all([
    scopedFrom('monthly_periods', 'id, bs_year, bs_month')
      .lte('bs_year', period.bs_year)
      .order('bs_year', { ascending: false }).order('bs_month', { ascending: false })
      .limit(6),
    // A few dozen rows across three months: no paging needed.
    supabase.rpc('get_forecast_holidays', {
      p_client_id: clientId, p_from_year: prev(2).y, p_from_month: prev(2).m,
      p_to_year: period.bs_year, p_to_month: period.bs_month,
    }),
  ])
  if (periodErr) return { error: periodErr }
  if (holidayErr) return { error: holidayErr }
  const holidays = holidaysByKeyOf(holidayRows)
  const periods = (periodRows || []).filter(p => wanted.some(w => w.y === p.bs_year && w.m === p.bs_month))
  if (!periods.length) return { periods: [], sales: [], purchases: [], returns: [], holidays, error: null }
  const ids = periods.map(p => p.id)
  const results = await Promise.all([
    fetchAllRows(() => supabase.from('sales_entries').select('period_id, recipe_id, qty_sold, bs_day, unit_price, discount, source').in('period_id', ids).order('id')),
    fetchAllRows(() => supabase.from('purchase_entries').select('period_id, qty, rate, bs_day, discount_amount, purchase_group_id, vendor_id, invoice_ref, vat_inclusive, vat_is_cost').in('period_id', ids).order('id')),
    fetchAllRows(() => supabase.from('vendor_returns').select('period_id, qty, rate, bs_day, purchase_entries(vat_inclusive, vat_is_cost)').in('period_id', ids).order('id')),
  ])
  const error = firstError(results)
  if (error) return { error }
  return { periods, sales: results[0].data || [], purchases: results[1].data || [], returns: results[2].data || [], holidays, error: null }
}

// `scope` (S800): 'home' is /dashboard, every module's headline cards; 'ims' is /ims/dashboard, the
// Inventory Dashboard, which is this same page with the HR and POS sections switched off. The IMS
// charts, reference cards and manual sales table moved there for a client with two or more
// modules, so each module tab opens a dashboard of its own. One component, so no card or chart has
// a second copy to drift.
export default function ClientDashboard({ scope = 'home' }) {
  const imsScope = scope === 'ims'
  const { profile, clientId, isAdmin, isOwner, clientModules, hasFeature, hasImsAccess, hasHrAccess, hasPosAccess, posTeam, loading: authLoading, adminViewClientName } = useAuth()
  // 'kitchen'/'bar' pos_team accounts (S431) get kitchen-ops KPIs (open/late tickets, prep time)
  // instead of the front-of-house Revenue/Covers/Avg Check/Tables Occupied cards — they have no
  // more use for revenue figures on their landing dashboard than a POS-only staffer has for IMS's.
  const posIsStationTeam = posTeam === 'kitchen' || posTeam === 'bar'
  const { colors } = useTheme()
  const { settings, settingsLoadError } = useSettings()
  const effectiveClientId = clientId || profile?.client_id
  const { scopedFrom, scopedUpdate } = useScopedDb()
  const hrApprovals = useHrApprovalCounts() // shared with HrDashboard.jsx's own Approvals row
  const navigate = useNavigate()
  const location = useLocation()
  // Seed initial state from a short-lived per-tab cache (dashboardCache.js) so navigating back to
  // this page shows the last-known figures instantly instead of a blank skeleton while it
  // re-fetches — the cache holds nothing this component doesn't already compute itself; it's
  // pure storage, no new calculation. setAndCache below writes to it alongside every existing
  // setter, at the same call sites, with no change to any of the values being computed.
  const [cachedStats] = useState(() => readDashboardCache('stats', effectiveClientId))
  const [stats, setStats]               = useState(cachedStats ?? null)
  const [activePeriod, setActivePeriod] = useState(() => readDashboardCache('activePeriod', effectiveClientId))
  const [loading, setLoading]           = useState(!cachedStats)
  const [topVariance, setTopVariance]   = useState(() => readDashboardCache('topVariance', effectiveClientId) ?? [])
  const [categorySpend, setCategorySpend] = useState(() => readDashboardCache('categorySpend', effectiveClientId) ?? [])
  const [dailyTrend, setDailyTrend]     = useState(() => readDashboardCache('dailyTrend', effectiveClientId) ?? [])
  const [hasDailySales, setHasDailySales] = useState(() => readDashboardCache('hasDailySales', effectiveClientId) ?? false)
  const [salesProjection, setSalesProjection] = useState(() => readDashboardCache('salesProjection', effectiveClientId)) // { projectedMonthEnd } | null
  const [purchProjection, setPurchProjection] = useState(() => readDashboardCache('purchProjection', effectiveClientId)) // { projectedMonthEnd } | null
  // Frozen Target, captured once per period (dailyForecast.js makeSnapshot) and never recalculated,
  // so it can be compared against as the period plays out instead of moving with every new day of
  // actuals the way salesProjection/purchProjection do.
  const [salesTargetSnap, setSalesTargetSnap] = useState(() => readDashboardCache('salesTargetSnap', effectiveClientId)) // { model: 2, source, byWeekday[7], sampleDays, capturedDay, projectedMonthEnd } | null
  const [purchTargetSnap, setPurchTargetSnap] = useState(() => readDashboardCache('purchTargetSnap', effectiveClientId)) // same shape
  // The history read failed AND it cost the chart something (a Target that could not be set).
  const [forecastHistoryFailed, setForecastHistoryFailed] = useState(() => readDashboardCache('forecastHistoryFailed', effectiveClientId) ?? false)
  // The history or Holiday Calendar read failed, so this month's festivals are drawn as usual days
  // (S850). Separate from the flag above: a Target captured earlier still draws, without them.
  const [festivalsUnread, setFestivalsUnread] = useState(() => readDashboardCache('festivalsUnread', effectiveClientId) ?? false)
  // The sales Target's month total with each festival at its Demand Multiplier (S850).
  const [salesTargetTotal, setSalesTargetTotal] = useState(() => readDashboardCache('salesTargetTotal', effectiveClientId) ?? null)
  // What the rain adjustment (S784) re-runs the sales forecast from at render time, so the weather,
  // which arrives on its own, never has to wait for or re-run loadStats. salesDayLog is the days the
  // outlet's own rainy-day effect is measured over: the Target's history window plus this month.
  const [salesForecastInputs, setSalesForecastInputs] = useState(() => readDashboardCache('salesForecastInputs', effectiveClientId))
  const [salesDayLog, setSalesDayLog] = useState(() => readDashboardCache('salesDayLog', effectiveClientId) ?? [])
  const [topItemSpend, setTopItemSpend] = useState(() => readDashboardCache('topItemSpend', effectiveClientId) ?? [])
  const [reorderItems, setReorderItems]   = useState(() => readDashboardCache('reorderItems', effectiveClientId) ?? [])
  // Every item below par, not just the five the panel lists — Home's Needs-attention row counts it (S800).
  const [reorderCount, setReorderCount]   = useState(() => readDashboardCache('reorderCount', effectiveClientId) ?? null)
  // Σ stock value over the same rows (S800 stage F): the Stock Report's figure for active items.
  const [stockOnHand, setStockOnHand]     = useState(() => readDashboardCache('stockOnHand', effectiveClientId) ?? null)
  // A closed month cached before S792 carries a purchases ÷ sales figure; it is dropped rather than
  // drawn as a Food Cost % (D30) until the reload underneath repaints it on the used basis.
  const [fcTrend, setFcTrend]             = useState(() => (readDashboardCache('fcTrend', effectiveClientId) ?? []).filter(p => p.open || p.basis === 'cogs'))
  const [hrStats, setHrStats]             = useState(() => readDashboardCache('hrStats', effectiveClientId) ?? null)
  const [posStats, setPosStats]           = useState(() => readDashboardCache('posStats', effectiveClientId) ?? null)
  // Which visual the merged Spend by Category / Top Items card is showing — plain UI state, not
  // page data, so it isn't seeded from or written to dashboardCache like the state above; it
  // resets to the default tab on remount the same way ChartCard's own `expanded` does.
  const [spendView, setSpendView]         = useState('category') // 'category' | 'items'
  // Same treatment for the merged Revenue vs Cost Breakdown / Sales Mix card below (S557) — plain
  // UI state, not persisted, resets to 'cost' on remount.
  const [costCardView, setCostCardView]   = useState('cost') // 'cost' | 'mix'
  // The "Show 6 more" disclosure over IMS's reference cards went in S800: those cards, the charts
  // and the manual sales table now live on the Inventory Dashboard, where they render in full, so
  // a multi-module Home has nothing left to fold away.
  // Wraps a normal setState call to also persist the same value to the cache above, under the
  // given section key. Only ever called from inside loadStats/loadHrStats/loadPosStats/
  // loadKitchenPosStats/loadFcTrend, all of which already check `loadIdRef.current !== myId`
  // before reaching their setState calls — so by the time this runs, effectiveClientId in this
  // closure is guaranteed to match the load that's actually completing, and a client switch
  // (admin "view as") can never write one client's numbers under another client's cache key.
  function setAndCache(setter, section, value) {
    setter(value)
    writeDashboardCache(section, effectiveClientId, value)
  }
  // Guards against a stale response overwriting the current view — none of loadStats/loadHrStats/
  // loadPosStats/loadFcTrend had a cancellation check, so switching "view as" client (or the
  // module flags changing) while a slower request for the PREVIOUS client was still in flight
  // could let that older response land last and silently repaint the screen with the wrong
  // tenant's numbers. Each load call captures the id current at its own start and checks it's
  // still current before committing any setState.
  const loadIdRef = useRef(0)
  // Labour on this page follows Overheads' rule (S756, D22): a finalized payroll run supersedes the
  // typed Labor bucket. `hr_payroll_runs`/`hr_payslips` carry the rank-blind RESTRICTIVE
  // `no_ims_staff` policy, so an IMS login reads both as `[]` with no error — which would look
  // exactly like "no finalized run" and quietly fall back to the bucket. Such a login does not ask.
  // S849 (GAPS-4, SU11 (a)): labour on an HR outlet is the finalized run, else the HR wage estimate
  // (loadOutletLabour); the Labor tab is named "not counted". A fenced login does not ask and gets no
  // labour figure ('unreadable'), never the Labor tab in its place.
  const hrOn = !!clientModules.hr
  const payrollFenced = isPayrollFenced({ hrOn, isAdmin, isOwner, imsRole: profile?.ims_role })
  // The till tables carry the RESTRICTIVE no_ims_staff and no_hr_role_staff policies, so an IMS or HR
  // login reads pos_orders as `[]` with no error: the delivery commission is not readable there and
  // is not asked for (PNL-1 parity).
  const posOn = !!clientModules.pos
  const posFenced = posOn && !isAdmin && !isOwner && (!!profile?.ims_role || !!profile?.hr_role)
  // Who may write this month's frozen Target: exactly the logins the database guard accepts (DATABASE-8).
  const canCapture = canCaptureTarget({ isAdmin, isOwner, hasImsAccess, profile })
  const [advancingPeriod, setAdvancingPeriod] = useState(false)
  // The close's outcome sentence, or null. `neutral` when nothing went wrong on this press: the
  // month had already been ended by someone else (S792, STOCK-8) and nothing was written.
  const [periodCloseNotice, setPeriodCloseNotice] = useState(null)   // { text, neutral } | null
  const [confirmPeriodClose, setConfirmPeriodClose] = useState(false)
  const [closeNotes, setCloseNotes] = useState([])       // the two preflights' sentences, for the dialog
  const [checkingClose, setCheckingClose] = useState(false)
  // Every load function used to destructure only { data } from each Supabase call and silently
  // discard { error } — a failed query either zeroed out a KPI (indistinguishable from "this
  // client genuinely has none") or, for the period fetch specifically, showed the misleading
  // "No open period" banner even when one was open, with no indication anything had actually gone
  // wrong. Keyed per section so IMS/HR/POS/the FC trend chart can each surface (and clear) their
  // own failure independently without one clobbering another's message.
  const [loadErrors, setLoadErrors] = useState({})

  function retryLoad(section) {
    const myId = ++loadIdRef.current
    if (section === 'ims') loadStats(myId)
    else if (section === 'hr') loadHrStats(myId)
    // A kitchen or bar login's POS section is its station card (S809 3n): Retry reloads that, not
    // the front-of-house figures, which would replace the station card with tiles it cannot show.
    else if (section === 'pos') { posIsStationTeam ? loadKitchenPosStats(myId) : loadPosStats(myId) }
    else if (section === 'fcTrend') loadFcTrend(activePeriod, myId)
  }

  useEffect(() => {
    if (authLoading) return
    if (!effectiveClientId) return
    const myId = ++loadIdRef.current
    // Load only the modules the displayed client actually subscribes to (clientModules from
    // AuthContext already resolves real-client vs admin "view as client").
    // The Inventory Dashboard shows no HR or POS section, so it reads neither.
    if (clientModules.ims) loadStats(myId); else setLoading(false)
    if (clientModules.hr && !imsScope) loadHrStats(myId); else setHrStats(null)
    if (clientModules.pos && !imsScope) { posIsStationTeam ? loadKitchenPosStats(myId) : loadPosStats(myId) } else setPosStats(null)
  }, [authLoading, effectiveClientId, clientModules.ims, clientModules.hr, clientModules.pos, posIsStationTeam, payrollFenced, location.key, imsScope]) // eslint-disable-line react-hooks/exhaustive-deps

  // A close's outcome sentence names one outlet's month; it must not follow an outlet switch.
  useEffect(() => { setPeriodCloseNotice(null) }, [effectiveClientId])

  const canSales    = hasFeature('sales_entry')
  const canVariance = hasFeature('variance_report')
  const canRecipes  = hasFeature('recipe_costing')
  const canMenuReprice = hasFeature('menu_repricing')
  const canReorder  = hasFeature('reorder_report')
  const canOverheads = hasFeature('overheads')

  async function loadStats(myId) {
    // Only show the skeleton when there's nothing cached to display yet — a revisit within the
    // cache window keeps showing last-known figures while this reloads quietly underneath.
    if (stats === null) setLoading(true)

    // These eight don't touch period_id at all (item/vendor/recipe counts, recipe/item/par_levels
    // reference data) — fired immediately instead of sitting inside the same Promise.all as the
    // seven period-scoped queries below, which used to make all fifteen wait on the period lookup
    // even though most of them had no reason to.
    const independentPromise = Promise.all([
      scopedFrom('items', '*', { count: 'exact', head: true }).eq('is_active', true).eq('is_sub_recipe', false),
      scopedFrom('vendors', '*', { count: 'exact', head: true }).eq('is_active', true),
      // NULL-safe (S714): .neq drops NULL-category rows, which undercounted the menu.
      scopedFrom('recipes', '*', { count: 'exact', head: true }).eq('is_active', true).or('category.is.null,category.neq.Sub-Recipe'),
      scopedFrom('recipes', '*', { count: 'exact', head: true }).eq('is_active', true).eq('category', 'Sub-Recipe'),
      // THE FOUR MASTER-DATA READS BELOW ARE PAGED (S734), AND THEY ARE THE PRODUCERS.
      //
      // The three transaction reads in the batch below were paged long ago; these were not,
      // because master data "is small". It is not small at a hotel, and every one of these is a
      // MAP the transaction rows are looked up in — so a truncation here does not shorten a
      // list, it silently deletes rows from figures built out of a full transaction set:
      //
      //   `recipes`      → currentPriceMap (a sold dish past the cut falls back to price 0, so
      //                    REVENUE is understated) and dashRecipeIds (its ingredients never enter
      //                    theoretical usage at all).
      //   `items`        → the Variance top-5 and, via buildStockRows, Items to Reorder.
      //   `par_levels`   → a par past the cut reads as "no par set", so the item can never
      //                    surface as below par.
      //   `allItems`     → itemRateMap, which values Menu Health and Top Items by Spend; an
      //                    item past the cut is valued at RATE 0 rather than dropped, which is
      //                    the quietest failure of the four. (Wastage Value reads its rate
      //                    through its own row's join since S792 — see the wastages read.)
      //
      // Same producer-and-consumer rule S706 found on Items and S708 on Vendors: the consumer
      // was paged and the read that feeds it was not. `.order('id')` is the unique tiebreaker.
      fetchAllRows(() => scopedFrom('recipes', 'id, name, selling_price, category, is_active, target_fc_pct, cost_price, vat_rate').order('id')),
      fetchAllRows(() => scopedFrom('items', 'id, name, uom, per_uom_rate, yield_pct, categories(name)').eq('is_active', true).eq('is_sub_recipe', false).order('id')),
      fetchAllRows(() => scopedFrom('par_levels', 'item_id, par_qty').order('id')),
      // Unfiltered by is_active — an item deactivated mid-period still has real purchase/wastage
      // history for that period. Used for Top Items by Spend and itemRateMap below so those don't
      // silently drop/zero-cost that history, unlike the active-only `items` fetch above (which
      // still correctly limits Variance/Reorder/the item COUNT to currently-active stock items).
      fetchAllRows(() => scopedFrom('items', 'id, name, per_uom_rate').eq('is_sub_recipe', false).order('id')),
    ])

    // .single() reports error.code 'PGRST116' when the result set isn't exactly one row — for
    // this query that just means "no open period right now," a normal, common state, not a
    // failure. Only anything else is a genuine fetch failure worth surfacing.
    const { data: period, error: periodErr } = await scopedFrom('monthly_periods')
      .eq('status', 'open')
      .order('bs_year', { ascending: false }).order('bs_month', { ascending: false })
      .limit(1).single()
    if (loadIdRef.current !== myId) return // superseded by a newer client switch

    const periodFailed = !!(periodErr && periodErr.code !== 'PGRST116')
    // A failed period read is not cached (S849, OWNER-DASHBOARD-2): the next visit asks again.
    if (periodFailed) setActivePeriod(period)
    else setAndCache(setActivePeriod, 'activePeriod', period)
    // The month-to-date clock (S849): ratios count the days already finished, and whole-month fixed
    // costs are counted for those days. Fixed for this load, and kept in `stats` with its figures.
    const clock = mtdClock(period)

    // Fired here (as soon as `period` is known) rather than after this whole function finishes —
    // it used to run only once loadStats had computed Food Cost % from its own big batch below,
    // which meant the FC Trend chart's own (separate, ~11-period) query never even started until
    // everything else on the page was already done, guaranteeing it was the last thing to render.
    // It now derives the open period's own point from its own query batch instead of being handed
    // a precomputed figure, so it has everything it needs up front and can run fully alongside the
    // Promise.all below instead of after it. Not awaited — same fire-and-forget shape it always had.
    loadFcTrend(period, myId)

    // The 28 days before this month began, for the Daily Purchases vs Sales forecast and Target.
    // Only the month in progress forecasts anything, so only then is it read. Its own error slot:
    // a failed history degrades one chart, it does not make the page's figures incomplete.
    const bsNow = nepalBsToday()
    const periodIsThisMonth = !!period && period.bs_year === bsNow.year && period.bs_month === bsNow.month
    const historyPromise = periodIsThisMonth
      ? loadForecastHistory(scopedFrom, period, effectiveClientId).catch(err => ({ error: err?.message || String(err) }))
      : Promise.resolve(null)

    const dependentPromise = Promise.all([
      // `discount_amount` + the bill-key columns (`purchase_group_id`, and the vendor/invoice/day
      // fallback for bills written before grouping existed) feed allocateBillDiscounts() below —
      // the same read ConsolidatedPnl and MonthlySummary make, so Net Purchases, Food Cost % and
      // Est. Net Margin % on this page agree with those two for the same month.
      period ? fetchAllRows(() => supabase.from('purchase_entries').select('item_id, qty, rate, bs_day, discount_amount, purchase_group_id, vendor_id, invoice_ref, vat_inclusive, vat_is_cost').eq('period_id', period.id).order('id')) : { data: [] },
      // Paged (S734). Returns are usually few — but "usually small" is not a decision, and this
      // one is SUBTRACTED from Net Purchases and from every daily bar on the trend chart, so a
      // truncation overstates spend and Food Cost % rather than understating a list. Same call
      // S722 made on the two statutory reports, which paged purchases and left returns bare.
      period ? fetchAllRows(() => supabase.from('vendor_returns').select('item_id, qty, rate, bs_day, purchase_entries(vat_inclusive, vat_is_cost)').eq('period_id', period.id).order('id')) : { data: [] },
      // Fetches every source (including 'pos_comp') — revenue figures below filter comps out
      // client-side, but theoreticalMap (Reorder + Variance widgets) needs every source counted,
      // matching every other consumption-facing report (ReorderReport, Variance, ShrinkageReport
      // etc. per PosOrders.jsx's own source-taxonomy comment) — a comped dish still used real
      // stock even though it collected no revenue.
      // ingredient_deltas: a customized plate also consumes its options' stock lines (S758).
      period ? fetchAllRows(() => supabase.from('sales_entries').select('recipe_id, qty_sold, bs_day, unit_price, discount, source, ingredient_deltas').eq('period_id', period.id).order('id')) : { data: [] },
      // Both paged (S734): one row per item per period, so they cross the cap at the same item
      // count the master-data reads above do. An opening or closing row past the cut reads as
      // ZERO on that item — which flows straight into the Variance top-5 (actual usage comes out
      // as opening + purchases, i.e. a large false over-consumption) and into on-hand, where a
      // missing closing count makes the item look freshly restocked. S720's precedent.
      period ? fetchAllRows(() => supabase.from('opening_stock').select('item_id, qty').eq('period_id', period.id).order('id')) : { data: [] },
      period ? fetchAllRows(() => supabase.from('closing_stock').select('item_id, physical_qty').eq('period_id', period.id).order('id')) : { data: [] },
      // `bucket` is selected (not just `amount`) because the Overheads page splits fixed costs
      // into three buckets — overhead / labor / tax_fees — and the Revenue vs Cost Breakdown pie
      // needs them apart. The KPI cards still use the all-bucket sum; see overheadBuckets below.
      // Deliberately NOT paged: this is one row per named fixed cost per period — rent, wifi,
      // a few salary lines — so it is tens of rows for a client with a hundred of them, not
      // hundreds. Written down rather than assumed, per the S722 rule that a read is exempt
      // because someone decided its rows-per-what, not because its table is usually small.
      period ? supabase.from('overheads').select('amount, bucket').eq('period_id', period.id) : { data: [] },
      // The item's rate rides on each row (WASTAGE_VALUE_SELECT) so Wastage Value counts every
      // item — prep and hidden ones too — as the Wastage Report does (S792, FIGURES-5). The same
      // rows feed the on-hand calculation below, which reads only item_id and qty.
      period ? fetchAllRows(() => supabase.from('wastages').select(WASTAGE_VALUE_SELECT).eq('period_id', period.id).order('id')) : { data: [] },
      // Staff meals come off the shelf in the shared on-hand calculation (S696) — the Items to
      // Reorder panel used to deduct neither wastage nor staff meals, so it disagreed with the
      // Reorder Report it links to.
      // Paged for the same reason `wastages` directly above it is (S734): one row per item per
      // day, so a 40-item kitchen crosses 1000 rows inside a single month — and an under-read
      // here UNDER-deducts staff meals, which makes on-hand look higher than it is and quietly
      // drops items off the "below par" list this tile exists to show.
      period ? fetchAllRows(() => supabase.from('staff_meals').select('item_id, qty').eq('period_id', period.id).order('id')) : { data: [] },
      // Stock received from / sent to the group's other outlets (S849, PNL-8): in adds like a
      // purchase, out comes off like a return, at the sender's frozen value — in Net Purchases, Spend %
      // so far, Est. Net Margin %, the cost pie and on-hand. A failed read fails the figures.
      period ? readPeriodTransfers(scopedFrom, [period.id]) : { data: [] },
    ])
    // Labour by the one rule (S849, GAPS-4): finalized payroll, else the HR wage estimate accrued to
    // yesterday; no HR read at all without HR or on a fenced login. Its own promise beside the batch.
    const labourPromise = period
      ? loadOutletLabour((t, c) => scopedFrom(t, c), {
          period, hrOn, fenced: payrollFenced, throughDay: clock.countedDays, scale: clock.fraction,
        })
      : Promise.resolve(null)
    // Delivery-partner commission on bills SOLD in the counted days (PNL-1 parity): a profit figure
    // takes it off. Only for a POS outlet, only for a login that can read the till.
    const commissionPromise = !period || !posOn ? Promise.resolve({ status: 'none', amount: 0, unsettledBills: 0 })
      : posFenced ? Promise.resolve({ status: 'unreadable', amount: null, unsettledBills: null })
      : clock.firstDay ? Promise.resolve({ status: 'ok', amount: 0, unsettledBills: 0 })
      : settleWithin(loadDeliveryCommission({ scopedFrom }, {
          startIso: bsDayBoundaryIso(period.bs_year, period.bs_month, 1, false),
          endIso: clock.running ? bsDayBoundaryIso(period.bs_year, period.bs_month, clock.countedDays + 1, false) : bsMonthWindow(period.bs_year, period.bs_month).endIso,
          posEnabled: true,
        }), 20000, 'Delivery commission').then(r => (r.error
          ? { status: 'failed', amount: null, unsettledBills: null, error: r.error }
          : { status: 'ok', amount: r.amount || 0, unsettledBills: r.unsettledBills || 0 }))

    const independentResults = await independentPromise
    const [
      { count: itemCount },
      { count: vendorCount },
      { count: recipeCount },
      { count: subRecipeCount },
      { data: recipes },
      { data: items },
      { data: parLevels },
      { data: allItems }
    ] = independentResults

    // recipe_ingredients has no client_id — must be scoped by this client's recipe IDs.
    // explodeRecipeIngredients recurses through sub-recipe ingredients and applies yield_pct — the
    // previous direct recipe_ingredients read (removed) only picked up rows with a direct item_id,
    // silently dropping any ingredient that was itself a sub-recipe, and the Menu Health cost map
    // didn't apply yield_pct at all. One call now feeds both theoreticalMap (item usage) and
    // recipeCostMap (recipe cost) below. It only needs `recipes` (just resolved above), nothing
    // from dependentPromise, so it's kicked off now and runs alongside the period-scoped batch
    // rather than waiting for that too.
    const dashRecipeIds = (recipes || []).map(r => r.id)
    // The recipe walk throws on a failed read (S695); null here means "could not be computed"
    // and is folded into hadRealError below, the same way a failed read in either batch is.
    const ingredientBreakdownPromise = dashRecipeIds.length > 0
      ? explodeRecipeIngredients(supabase, dashRecipeIds).catch(err => { console.error('Dashboard: recipe walk failed', err); return null })
      : Promise.resolve({})

    const [dependentResults, rawBreakdown, forecastHistory, labourResult, commission] = await Promise.all([dependentPromise, ingredientBreakdownPromise, historyPromise, labourPromise, commissionPromise])
    if (loadIdRef.current !== myId) return // superseded again after these more awaits
    const ingredientBreakdown = rawBreakdown || {}

    const [
      { data: purchases },
      { data: returns },
      { data: salesData },
      { data: opening },
      { data: closing },
      { data: overheadsData },
      { data: wastagesData },
      { data: staffMealsData },
      { data: transfersData },
    ] = dependentResults

    // What customized plates used beyond their recipes (S758). Throws on a failed read, like the
    // recipe walk above, and is folded into hadRealError the same way — null = not computed.
    const deltaExplosion = await loadDeltaExplosion(supabase, (salesData || []).map(s => s.ingredient_deltas))
      .catch(err => { console.error('Dashboard: option stock-line walk failed', err); return null })
    if (loadIdRef.current !== myId) return // superseded during the option stock-line read

    const labourFailed = labourResult?.labour?.source === 'failed'
    const hadRealError = periodFailed
      || independentResults.some(r => r.error) || dependentResults.some(r => r.error)
      || rawBreakdown === null || deltaExplosion === null || labourFailed || commission.status === 'failed'
    setLoadErrors(prev => ({ ...prev, ims: hadRealError ? 'Inventory data failed to load — figures below may be incomplete or stale.' : '' }))
    // A load with any failed read is shown but never cached (S849, OWNER-DASHBOARD-2): a cached
    // partial load would outlive the failure as a confident figure on the next visit.
    const put = hadRealError ? (setter, _section, value) => setter(value) : setAndCache
    // The reads every money figure and ratio on the page is built from. One of them missing is a dash
    // on those tiles, never a figure computed without it.
    const figuresFailed = periodFailed || !!independentResults[4]?.error
      || [0, 1, 2, 5, 8].some(i => !!dependentResults[i]?.error)

    // purchaseTotal = purchases NET of bill discounts − returns. `discount_amount` is a BILL-level
    // figure repeated on every line, so a raw Σ qty × rate charged the undiscounted price into
    // Net Purchases, Food Cost % and Est. Net Margin % — while Consolidated P&L and Monthly Summary
    // took the same bills net of the discount, and the same month read two ways on two pages.
    // allocateBillDiscounts() spreads each bill's one discount across its own lines (S601/S720);
    // every purchase figure below (per-item spend, the daily bars) reads that `lineCost` too, so
    // Spend by Category can never add up to more than the Net Purchases tile beside it. Returns
    // stay at their list value, exactly as those two pages take them. Both on the COST basis since
    // S792 (D32): `lineCost`, and each return at its line's basis, so a PAN-bill outlet's supplier
    // VAT is spend here as on Monthly Summary. Since S849 the tile and the ratios add stock received
    // from other outlets and take off stock sent (netSpendOf), and the ratios count finished days.
    const allocatedPurchases = allocateBillDiscounts(purchases || [])
    const spend = netSpendOf({ purchases, returns, transfers: transfersData, clock })
    const purchaseTotal = spend.all

    const currentPriceMap = {}
    ;(recipes || []).forEach(r => { currentPriceMap[r.id] = parseFloat(r.selling_price) || 0 })
    // unit_price captured on the row (price actually charged) used per-row when present, else
    // falls back to the recipe's current price — previously always used the current price, so
    // this period's revenue silently reflected today's menu price rather than what was charged.
    // soldMap/revenueMap (comp-excluded) drive every revenue-facing figure on this page —
    // Revenue, daily trend, projections, Menu Health opportunity. Consumption (theoreticalMap
    // below) is built from every source instead, since a comped dish still consumed real stock
    // even though it collected no revenue — see the query comment above.
    const soldMap = {}, revenueMap = {}
    ;(salesData || []).forEach(s => {
      const qty = parseFloat(s.qty_sold)
      if (s.source === 'pos_comp') return
      const price = s.unit_price != null ? parseFloat(s.unit_price) : (currentPriceMap[s.recipe_id] || 0)
      soldMap[s.recipe_id] = (soldMap[s.recipe_id] || 0) + qty
      revenueMap[s.recipe_id] = (revenueMap[s.recipe_id] || 0) + qty * price - (parseFloat(s.discount) || 0)
    })
    const revenueTotal = Object.values(revenueMap).reduce((s, v) => s + v, 0)
    // The same revenue over the counted days (finished days only, a Bulk row counted): what every
    // ratio divides by (OWNER-DASHBOARD-8). The Revenue tile keeps showing everything so far.
    const revenueCounted = revenueOf(salesData, currentPriceMap, clock).counted

    // theoreticalMap: item-level usage this period, through the ONE depletion rule every stock
    // page applies (S696) — POS supersedes a manual row for the same recipe and day, a credit note
    // never puts stock back. This page used to sum every row raw, so a day sold in both POS and
    // manual entry consumed its ingredients twice on the Variance widget and the Reorder panel.
    // deltaExplosion adds each customized plate's option stock lines (S758).
    const theoreticalMap = buildUsageMap(salesData, ingredientBreakdown, deltaExplosion)

    // itemRateMap built from allItems (unfiltered by is_active) — an item deactivated mid-period
    // still has real wastage/recipe-cost history for that period; it shouldn't zero-cost to 0.
    const itemRateMap = {}; (allItems || []).forEach(i => { itemRateMap[i.id] = parseFloat(i.per_uom_rate || 0) })

    // Menu Health — dishes priced below their target FC% (mirrors the Menu Repricing report).
    // Gated on canMenuReprice (Growth+) — this used to compute unconditionally and stash the
    // result in `stats`/component state regardless of plan, so a Starter client's browser held
    // the real Growth-tier Menu Health numbers even though only the UpsellCard was rendered; the
    // gate was render-only, not a data gate. Same issue for Variance (below) and Reorder (below).
    let underpricedCount = 0, costedPricedCount = 0, menuOpportunityTotal = 0
    if (canMenuReprice) {
      // Previously read only direct item_id ingredients with no yield_pct division at all — any
      // dish built on a sub-recipe (sauces, batters, prepped components) was costed at zero here,
      // and every dish understated cost by ignoring trim/prep loss.
      const recipeCostMap = {}
      Object.entries(ingredientBreakdown).forEach(([recipeId, rows]) => {
        recipeCostMap[recipeId] = rows.reduce((s, { item_id, qty }) => s + qty * (itemRateMap[item_id] || 0), 0)
      })
      ;(recipes || []).forEach(r => {
        const price = parseFloat(r.selling_price) || 0
        if (r.category === 'Sub-Recipe' || r.is_active === false || price <= 0) return
        // The tile reads "3 of 47" — underpriced of costed-and-priced — and a dish with no food
        // cost used to land in the DENOMINATOR while being mathematically unable to reach the
        // numerator: cost 0 makes FC% 0, and 0 is never above target. So the tile read *healthier*
        // the more uncosted dishes a client had (S724). It also had no `cost_price` fallback,
        // unlike the Menu Repricing report it says it mirrors, so a hand-costed dish disagreed
        // between the tile and the page it links to. `recipeCostOf` is the one shared decision.
        const cost = recipeCostOf(recipeCostMap, r)
        if (cost == null) return
        costedPricedCount++
        const targetPct = parseFloat(r.target_fc_pct) || 30
        const currentFcPct = (cost / price) * 100
        if (currentFcPct > targetPct) {
          underpricedCount++
          // Measured against the rounded, VAT-inclusive price Menu Repricing actually suggests,
          // taken back to ex-VAT — so the tile's opportunity and the report's agree to the rupee.
          const vat = (r.vat_rate === null || r.vat_rate === undefined) ? 0.13 : parseFloat(r.vat_rate)
          const suggestedExVat = getSuggestedPrice(cost, vat, targetPct / 100) / (1 + vat)
          menuOpportunityTotal += Math.max(0, suggestedExVat - price) * (soldMap[r.id] || 0)
        }
      })
    }

    // PATCHED: purchMap net of returns
    const purchMap = {}
    const purchValueMap = {}
    ;allocatedPurchases.forEach(p => {
      purchMap[p.item_id] = (purchMap[p.item_id] || 0) + parseFloat(p.qty || 0)
      // Net of the bill discount (see purchaseTotal above); qty is untouched — a discount changes
      // what was paid, not what arrived.
      purchValueMap[p.item_id] = (purchValueMap[p.item_id] || 0) + p.lineCost
    })
    ;(returns || []).forEach(r => {
      purchMap[r.item_id] = (purchMap[r.item_id] || 0) - parseFloat(r.qty || 0)
      purchValueMap[r.item_id] = (purchValueMap[r.item_id] || 0) - returnCostValue(r)
    })
    // Stock moved between the group's outlets (S849, PNL-8) moves the shelf like a purchase and a
    // return, so Top Variance agrees with the Variance page, and received stock is this outlet's
    // spend in Spend by Category and Top Items (sent stock is not).
    Object.entries(transferNetQtyMap(transfersData)).forEach(([id, q]) => { purchMap[id] = (purchMap[id] || 0) + q })
    const tVal = transferValueByItem(transfersData)
    Object.entries(tVal.in).forEach(([id, v]) => { purchValueMap[id] = (purchValueMap[id] || 0) + v })
    Object.entries(tVal.out).forEach(([id, v]) => { purchValueMap[id] = (purchValueMap[id] || 0) - v })

    const openMap = {}; (opening || []).forEach(r => { openMap[r.item_id] = parseFloat(r.qty) })
    const closeMap = {}; (closing || []).forEach(r => { closeMap[r.item_id] = parseFloat(r.physical_qty) })

    // Variance top 5 — gated on canVariance (Growth+); see Menu Health comment above for why
    // this needs a data gate, not just a render gate.
    if (canVariance) {
      const varRows = (items || []).map(item => {
        const actual = (openMap[item.id] || 0) + (purchMap[item.id] || 0) - (closeMap[item.id] || 0)
        const theoretical = theoreticalMap[item.id] || 0
        const variance = actual - theoretical
        const value = variance * parseFloat(item.per_uom_rate || 0)
        return { name: item.name, variance, value, uom: item.uom, category: item.categories?.name }
      }).filter(r => r.value > 0).sort((a, b) => b.value - a.value).slice(0, 5)
      put(setTopVariance, 'topVariance', varRows)
    } else {
      put(setTopVariance, 'topVariance', [])
    }

    // Category spend (net)
    const itemMap = {}; (items || []).forEach(i => { itemMap[i.id] = i })
    const catSpendMap = {}
    Object.entries(purchValueMap).forEach(([itemId, val]) => {
      if (val <= 0) return
      const cat = itemMap[itemId]?.categories?.name || 'Uncategorized'
      catSpendMap[cat] = (catSpendMap[cat] || 0) + val
    })
    put(setCategorySpend, 'categorySpend',
      Object.entries(catSpendMap)
        .map(([name, value]) => ({ name, value: Math.round(value) }))
        .filter(r => r.value > 0)
        .sort((a, b) => b.value - a.value)
    )

    // ── Daily trend: purchases (actual, net) + daily sales revenue, month-end forecast, frozen Target ──
    // One definition of a day's net purchases (net of bill discounts, so the daily points sum to
    // the Net Purchases tile) and of a day's revenue (day-attributed entries only, comps excluded,
    // the row's unit_price before the recipe's current one). The history window below is built
    // from the same two functions, so last month and this month are measured the same way.
    const dayPurchMap = dailyPurchaseMap(allocatedPurchases, returns)
    const daySalesMap = dailySalesMap(salesData, currentPriceMap)
    const salesDayNums = Object.keys(daySalesMap).map(Number).sort((a, b) => a - b)
    const dailySalesOn = salesDayNums.length > 0
    put(setHasDailySales, 'hasDailySales', dailySalesOn)
    const purchDayNums = Object.keys(dayPurchMap).map(Number).sort((a, b) => a - b)

    // Forecast and Target: the month in progress only. Past months show actuals only. How each
    // works, and why neither is a slope, is at the top of dailyForecast.js.
    // Nepal's today, not the viewer's (S792, PLANNING-9): it decides isCurrentMonth, today's day
    // and the day a Target is captured on (capturedDay below).
    const bsToday = nepalBsToday()
    const isCurrentMonth = !!period && period.bs_year === bsToday.year && period.bs_month === bsToday.month
    const monthEndDay = period ? daysInBsMonth(period.bs_year, period.bs_month) : 31
    const weekdayOf = d => (period ? bsToAd(period.bs_year, period.bs_month, d).getDay() : 0)
    const lastActualSalesDay = salesDayNums.length ? salesDayNums[salesDayNums.length - 1] : null
    const lastActualPurchDay = purchDayNums.length ? purchDayNums[purchDayNums.length - 1] : null
    // Days elapsed = the latest day holding either kind of entry. Purchases are judged over every
    // one of them, a day with no bill counting as zero; sales over the days with an entry.
    const elapsedDay = Math.max(lastActualSalesDay || 0, lastActualPurchDay || 0)
    // S792 PLANNING-2/3: today is still trading, so it is never a sample — not in the pace, not in
    // a Target built from this month, not in the rain log — and the forecast starts at today, drawn
    // beside what today has sold so far (splitAtToday, dailyForecast.js).
    const todayDay = isCurrentMonth ? bsToday.day : null
    const { salesDone, purchElapsed, salesFrom, purchFrom } = splitAtToday({ salesDayNums, elapsedDay, today: todayDay })
    // The dashed line joins the actual line at the last finished day with an entry.
    const salesAnchorDay = salesDone.length ? salesDone[salesDone.length - 1] : null
    const purchAnchorDay = purchDayNums.filter(d => d < purchFrom).pop() ?? null

    // The 28 days before this month began. A FAILED history read is not an empty history: taking
    // it as one would lock a new-client Target from one week of this month when four weeks were
    // there to read, and that Target could never be corrected. So a failure captures nothing.
    const historyFailed = isCurrentMonth && !!forecastHistory?.error
    let historyBase = { sales: null, purch: null }
    let historyDays = []
    // This month's festivals (S850, dailyForecast.js header). Empty when the calendar could not be
    // read, which the footer says (festivalsUnread), rather than drawing festivals as usual days in
    // silence.
    let festivals = {}
    if (isCurrentMonth && forecastHistory && !historyFailed) {
      const inPeriod = (rows, id) => rows.filter(r => r.period_id === id)
      historyDays = historyWindowDays(period.bs_year, period.bs_month,
        forecastHistory.periods.map(p => ({
          bs_year: p.bs_year,
          bs_month: p.bs_month,
          salesMap: dailySalesMap(inPeriod(forecastHistory.sales, p.id), currentPriceMap),
          // Per period. No longer required: since S792 the legacy bill key carries period_id
          // (supplierAttribution.js allocationBillKey), so a whole-batch pass would agree.
          purchMap: dailyPurchaseMap(allocateBillDiscounts(inPeriod(forecastHistory.purchases, p.id)), inPeriod(forecastHistory.returns, p.id)),
        })), forecastHistory.holidays)
      historyBase = baseFromHistory(historyDays)
      festivals = monthFestivals(forecastHistory.holidays, period.bs_year, period.bs_month, monthEndDay)
    }
    const isFestival = d => !!festivals[d]
    const salesFactorOf = salesFestivalFactor(festivals)
    put(setFestivalsUnread, 'festivalsUnread', historyFailed)

    // The frozen Target: captured once per period, never recalculated, so a later visit can judge
    // the month against what was expected of it. A snapshot of an older model (a pre-S780 slope
    // fit that ran to zero mid-month, or S780's flat purchase line) is treated as absent and
    // replaced once; staleSnapshotFilter() matches an empty column or an older model and nothing
    // else. It stays a best-effort write: a failed save just means the next visit captures it,
    // and a second tab racing this one cannot overwrite the snapshot the first has just written.
    let nextSalesTargetSnap = isCurrentSnapshot('sales', period?.sales_projection_snapshot) ? period.sales_projection_snapshot : null
    let nextPurchTargetSnap = isCurrentSnapshot('purch', period?.purch_projection_snapshot) ? period.purch_projection_snapshot : null
    if (period && isCurrentMonth && !historyFailed && canCapture) {
      const capture = (kind, column, base) => {
        const snap = makeSnapshot(kind, base, { monthEndDay, weekdayOf, capturedDay: bsToday.day })
        scopedUpdate('monthly_periods', { [column]: snap })
          .eq('id', period.id).or(staleSnapshotFilter(kind, column))
          .then(({ error }) => { if (error) console.error(`Failed to save ${column}`, error) })
        return snap
      }
      // Finished days only (PLANNING-3): the Target is frozen for the month, so a morning's partial
      // takings captured here would stand as that weekday's usual until the month ends.
      if (!nextSalesTargetSnap) {
        const base = historyBase.sales || baseFromMonth({ kind: 'sales', valueMap: daySalesMap, dayNums: salesDone, weekdayOf, isFestival })
        if (base) nextSalesTargetSnap = capture('sales', 'sales_projection_snapshot', base)
      }
      if (!nextPurchTargetSnap) {
        // No bill at all on a finished day means a client not recording purchases here, not a
        // month of zero spend, so it gets no purchase target from its own days.
        const base = historyBase.purch
          || (purchDayNums.some(d => d <= purchElapsed) ? baseFromMonth({ kind: 'purch', valueMap: dayPurchMap, elapsed: purchElapsed, weekdayOf, isFestival }) : null)
        if (base) nextPurchTargetSnap = capture('purch', 'purch_projection_snapshot', base)
      }
    }
    put(setSalesTargetSnap, 'salesTargetSnap', nextSalesTargetSnap)
    put(setPurchTargetSnap, 'purchTargetSnap', nextPurchTargetSnap)
    put(setForecastHistoryFailed, 'forecastHistoryFailed', historyFailed && (!nextSalesTargetSnap || !nextPurchTargetSnap))
    // The sales Target's month total with each festival at its multiplier (S850); the stored
    // projectedMonthEnd is the usual week's. Purchases are never scaled, so theirs is the stored one.
    put(setSalesTargetTotal, 'salesTargetTotal', nextSalesTargetSnap
      ? targetTotal(nextSalesTargetSnap.byWeekday, { monthEndDay, weekdayOf, dayFactor: salesFactorOf })
      : null)

    // The live forecast leans on the Target's weekday pattern (or, before one exists, the history
    // base), scaled to how this month is running against it.
    const salesTrend = (dailySalesOn && isCurrentMonth)
      ? projectMonth({
          base: nextSalesTargetSnap || historyBase.sales, valueMap: daySalesMap, expectDays: salesDone, fromDay: salesFrom, monthEndDay, weekdayOf,
          dayFactor: salesFactorOf, judged: salesFestivalJudged(festivals), learnRuns: festivalLearnRuns(festivals),
        })
      : null
    // The same call's inputs, kept for the rain adjustment to re-run at render (S784). Sales only:
    // purchases follow restock days, whatever the weather. `festivals` rides along so the re-run
    // keeps each festival's multiplier beside the rain (S850).
    const salesBase = nextSalesTargetSnap || historyBase.sales
    put(setSalesForecastInputs, 'salesForecastInputs', salesTrend ? {
      base: salesBase ? { byWeekday: salesBase.byWeekday } : null,
      valueMap: daySalesMap, expectDays: salesDone, fromDay: salesFrom,
      monthEndDay, bsYear: period.bs_year, bsMonth: period.bs_month, lastActualSalesDay, festivals,
    } : null)
    // The measured rain effect's samples: finished days only, like the pace, and no festival day,
    // whose sales say nothing about what rain does to a usual one (S850).
    put(setSalesDayLog, 'salesDayLog', isCurrentMonth ? [
      ...historyDays.filter(x => x.sales != null && !x.holiday).map(x => ({ ad: adDateBack(period.bs_year, period.bs_month, x.back), dow: x.dow, sales: x.sales })),
      ...salesDone.filter(d => !isFestival(d)).map(d => ({ ad: adDateOf(period.bs_year, period.bs_month, d), dow: weekdayOf(d), sales: daySalesMap[d] })),
    ] : [])
    const purchTrend = (isCurrentMonth && elapsedDay > 0)
      ? projectMonth({
          base: nextPurchTargetSnap || historyBase.purch, valueMap: dayPurchMap, expectDays: Array.from({ length: purchElapsed }, (_, i) => i + 1), fromDay: purchFrom, monthEndDay, weekdayOf,
          judged: purchFestivalJudged(festivals),
        })
      : null
    const projDays = salesTrend?.projDays || {}
    const purchProjDays = purchTrend?.projDays || {}
    put(setSalesProjection, 'salesProjection', salesTrend ? { projectedMonthEnd: salesTrend.projectedTotal, learned: salesTrend.learned } : null)
    put(setPurchProjection, 'purchProjection', purchTrend ? { projectedMonthEnd: purchTrend.projectedTotal } : null)

    // Build the unified day axis, full month (Day 1 → month end for the current month; full actual
    // range for past months). The compact card slices this down to a 10-day window (6 days back →
    // 3 days ahead) at render time — see `dailyTrendWindowed` below — while the expanded modal shows
    // this whole-month array so the full trend is visible there.
    const baseDays = [...purchDayNums, ...salesDayNums].filter(d => d > 0)
    const hasProj = Object.keys(projDays).length > 0
    const hasPurchProj = Object.keys(purchProjDays).length > 0
    const startDay = isCurrentMonth ? 1 : (baseDays.length ? Math.min(...baseDays) : 1)
    const lastDay  = isCurrentMonth ? monthEndDay : (baseDays.length ? Math.max(...baseDays) : 0)
    const trend = []
    for (let d = startDay; d <= lastDay; d++) {
      const isProj = projDays[d] != null
      const isPurchProj = purchProjDays[d] != null
      const today = d === todayDay
      trend.push({
        day: `Day ${d}`,
        // Today, still trading (S792 PLANNING-2): its actual is sold-so-far, drawn beside its
        // forecast rather than replacing it. Since S851 it is its own key, drawn as a hollow dot
        // apart from the actual line, so a part-day never reads as the line falling. The tooltip
        // and the projection's dot key off inProgress.
        purchases: !today && dayPurchMap[d] != null ? dayPurchMap[d] : null,
        sales: !today && dailySalesOn && daySalesMap[d] != null ? daySalesMap[d] : null,
        ...(today && {
          purchToday: dayPurchMap[d] ?? null,
          salesToday: dailySalesOn ? daySalesMap[d] ?? null : null,
        }),
        inProgress: today,
        // dashed line: anchor at the last finished day with an entry so it connects, then the
        // forecast days (today's included)
        salesProj: isProj ? projDays[d]
          : (d === salesAnchorDay && hasProj ? daySalesMap[d] : null),
        purchProj: isPurchProj ? purchProjDays[d]
          : (d === purchAnchorDay && hasPurchProj ? dayPurchMap[d] : null),
        // Frozen full-month line, unlike salesProj/purchProj above — non-null for every day in
        // range (not just from the last actual onward) so it's a static reference the actual line
        // can be compared against retroactively, not just a forward-looking tail.
        // A festival's multiplier scales its day on the sales Target (S850); purchases never.
        salesTarget: targetValue('sales', nextSalesTargetSnap, weekdayOf(d), salesFactorOf(d)),
        purchTarget: targetValue('purch', nextPurchTargetSnap, weekdayOf(d)),
        // For the tooltip and the footer: { name, multiplier } on a festival, else absent.
        ...(festivals[d] && { festival: festivals[d] }),
      })
    }
    put(setDailyTrend, 'dailyTrend', trend)

    // Top items by net spend — built from allItems (unfiltered by is_active), not the
    // active-only `items` list, so an item deactivated mid-period after being purchased still
    // shows up here instead of silently vanishing while "Net Purchases" and "Spend by Category"
    // on the same screen still include its value.
    const itemSpendRows = (allItems || [])
      .filter(i => (purchValueMap[i.id] || 0) > 0)
      .map(i => ({
        name: i.name.length > 18 ? i.name.slice(0, 17) + '…' : i.name,
        fullName: i.name,
        value: Math.round(purchValueMap[i.id] || 0)
      }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 10)
    put(setTopItemSpend, 'topItemSpend', itemSpendRows)

    // Reorder — the same on-hand and below-par calculation the Reorder Report this panel links
    // to uses (S696; this used to be its own copy that deducted neither wastage nor staff meals,
    // so the tile could say 3 and the report 7). Gated on canReorder (Growth+); see Menu Health
    // comment above for why this needs a data gate, not just a render gate.
    if (canReorder) {
      const stockRows = buildStockRows({
        items, opening, closing, purchases, returns, wastages: wastagesData, staffMeals: staffMealsData,
        sales: salesData, breakdown: ingredientBreakdown, pars: parLevels, explosion: deltaExplosion,
        transfers: transfersData,
      })
      put(setStockOnHand, 'stockOnHand', Math.round(stockRows.reduce((t, r) => t + r.stockValue, 0)))
      const reorderRows = stockRows
        .filter(r => r.needsReorder)
        .map(r => ({
          name: r.item.name, uom: r.item.uom, currentStock: Math.round(r.onHand * 100) / 100,
          par: r.par, shortfall: Math.round(r.shortfall * 100) / 100,
          estValue: Math.round(r.shortfallValue), needsReorder: true,
          source: r.stockSource === 'closing' ? 'Physical' : "Calc'd"
        }))
        .sort((a, b) => b.estValue - a.estValue)
      put(setReorderCount, 'reorderCount', reorderRows.length)
      reorderRows.splice(5)
      put(setReorderItems, 'reorderItems', reorderRows)
    } else {
      put(setReorderItems, 'reorderItems', [])
      put(setReorderCount, 'reorderCount', null)
      put(setStockOnHand, 'stockOnHand', null)
    }

    // Every bucket, split (splitOverheadBuckets, labourSource.js): Overheads (and a row with no
    // bucket), the Labor tab and Tax & Fees. `overheadBuckets` keeps the WHOLE-MONTH amounts as typed;
    // the ratios count them for the finished days (prorate, S849). The Labor tab is labour only for an
    // outlet without Crest HR; with HR it is named "not counted" (resolveOutletLabour).
    const split = splitOverheadBuckets(overheadsData)
    const overheadBuckets = { overhead: split.overhead, labor: split.labor, tax_fees: split.taxFees }
    const overheadTotal = overheadBuckets.overhead + overheadBuckets.labor + overheadBuckets.tax_fees

    // The Wastage Report's own total: every item, prep and hidden ones included (S792, FIGURES-5).
    // It used itemRateMap, which holds raw items only, so wasted prep was valued at 0 here while the
    // Owner Dashboard and the report the tile links to counted it. Informational: COGS elsewhere
    // takes off only raw-item wastage, since prep is costed through its raw ingredients.
    const wastageValueTotal = periodWastageValue(wastagesData)

    // `overheadTotal` stays the raw all-bucket sum of what was TYPED; the labour actually counted is
    // resolved at render (resolveOutletLabour) from `labourParts` and the Labor tab, so an unsaved
    // view of either never needs a reload. `statsVersion: 2` (S849): a stats object cached before the
    // one labour rule renders its labour and ratios as loading, never as the old Labor-tab figure,
    // until this reload lands.
    put(setStats, 'stats', {
      statsVersion: 2, clock,
      itemCount, vendorCount, recipeCount, subRecipeCount,
      purchaseTotal, purchaseCounted: spend.counted, transfers: spend.transfers,
      revenueTotal, revenueCounted, overheadTotal, overheadBuckets, figuresFailed,
      labourParts: labourResult?.parts ?? null,
      commission: { status: commission.status, amount: commission.amount, unsettledBills: commission.unsettledBills },
      wastageValueTotal, underpricedCount, costedPricedCount, menuOpportunityTotal,
    })
    setLoading(false)
  }

  async function loadHrStats(myId) {
    // HR staff rank cannot read employee or pay records (S750, migration 20260914200000). The read
    // would come back EMPTY, not failed — and "0 employees · NPR 0 payroll" is the kind of zero this
    // page must never paint. So the tiles are not loaded or shown below supervisor rank at all.
    if (!hasHrAccess('supervisor')) { setHrStats(null); return }
    const { data: employees, error } = await scopedFrom('hr_employees', 'status, basic_salary, pay_basis')
    if (loadIdRef.current !== myId) return // superseded by a newer client switch
    setLoadErrors(prev => ({ ...prev, hr: error ? 'HR data failed to load — figures below may be incomplete or stale.' : '' }))
    const total     = employees?.length || 0
    const active    = employees?.filter(e => e.status === 'active').length || 0
    const probation = employees?.filter(e => e.status === 'probation').length || 0
    // Monthly-paid staff only: a daily or hourly employee's basic_salary is a RATE, and adding it
    // to a monthly total means nothing (the Employees page's tile had the same fault, S748).
    const payroll   = (employees || [])
      .filter(e => (e.status === 'active' || e.status === 'probation') && (e.pay_basis || 'monthly') === 'monthly')
      .reduce((s, e) => s + parseFloat(e.basic_salary || 0), 0)
    setAndCache(setHrStats, 'hrStats', { total, active, probation, payroll })
  }

  // POS figures — Revenue/Covers/Avg Check for the current open BS period (matching the IMS
  // section's "this period" cadence), plus a live Tables Occupied snapshot. pos_orders.paid_amount
  // is already the final net amount (subEx − discount + VAT, per posBillingMath.js's
  // computeOrderAmounts) computed and stored at close time, so this reads it directly rather than
  // re-deriving VAT from pos_order_items — same shortcut Sales/Covers Report don't take only
  // because they need a per-category/per-item breakdown; a dashboard tile doesn't.
  // bsToAd builds a Date from local Y/M/D components with no timezone conversion, so its local
  // getters always reproduce the same Nepal calendar day the caller asked for regardless of the
  // runtime's own timezone. But calling .toISOString() on it converts using the RUNTIME's local
  // offset, not Nepal's fixed +05:45 — for a viewer (e.g. an admin) outside Nepal, that silently
  // shifts the day boundary compared against `closed_at` (a genuine UTC timestamptz), mis-
  // bucketing orders near the start/end of the month. Build the boundary explicitly with Nepal's
  // own offset instead of trusting the runtime's: the shared bsDayBoundaryIso (bsCalendar.js) does
  // exactly that (S835; this page kept its own copy). It answers null for a date it cannot build,
  // where the copy built "NaN-NaN-NaN…", which the server refused as a failed read and the bookings
  // window threw on. A null boundary is a failed read here too, never a query sent without one.

  async function loadPosStats(myId) {
    // See loadStats' identical .single() comment above — PGRST116 (no open period) is expected,
    // not a failure.
    const { data: period, error: periodErr } = await scopedFrom('monthly_periods')
      .eq('status', 'open')
      .order('bs_year', { ascending: false }).order('bs_month', { ascending: false })
      .limit(1).single()

    let ordersErr = null, notesErr = null
    let summary = summariseBills([])
    const fromTs = period ? bsDayBoundaryIso(period.bs_year, period.bs_month, 1, false) : null
    const toTs = period ? bsDayBoundaryIso(period.bs_year, period.bs_month, daysInBsMonth(period.bs_year, period.bs_month), true) : null
    if (period && !(fromTs && toTs)) ordersErr = { message: `No calendar dates for BS ${period.bs_year}-${period.bs_month}` }
    if (fromTs && toTs) {
      // Paged (S734). This is one row per BILL for a whole month: a restaurant closing 40 bills a
      // day crosses PostgREST's 1000-row cap inside one period, and a bare .select() returns the
      // first 1000 with no error and nothing in the data to say so — so Revenue, Covers, Bills and
      // Avg Check would all quietly stop growing partway through a busy month while still reading
      // as real figures. Both reports these tiles link to (SalesReport.jsx, CoversReport.jsx)
      // already page the same table; the dashboard was the one surface that did not, so it would
      // have disagreed with them without either screen saying why. `.order('id')` is the unique
      // tiebreaker fetchAllRows requires.
      //
      // S814 4d (REPORTS-5, owner Q22 a): the Sales Report's rule. Every paid bill closed in the
      // month counts in full, a since-credit-noted one included, and every credit note ISSUED in the
      // month comes off (the notes are paged too: their window is the same month). The note brings
      // the bill it credits, which may have closed last month, for the dine-in side of Avg per cover.
      // Both carry `part_of_order_id` beside `table_id` (S836): a part bill has no table but is
      // dine-in (coversMath.isDineIn), so without it its guests would fall out of Covers Served.
      const [bills, notes] = await Promise.all([
        fetchAllRows(() =>
          scopedFrom('pos_orders', 'id, table_id, part_of_order_id, covers, paid_amount, discount_amount, close_type, closed_at')
            .eq('close_type', 'paid')
            .gte('closed_at', fromTs).lte('closed_at', toTs)
            .order('id')),
        fetchAllRows(() =>
          scopedFrom('pos_credit_notes', 'id, order_id, net_amount, created_at, pos_orders!pos_credit_notes_order_id_fkey(id, table_id, part_of_order_id, covers)')
            .gte('created_at', fromTs).lte('created_at', toTs)
            .order('id')),
      ])
      ordersErr = bills.error
      notesErr = notes.error
      // Covers Served is the Covers Report's count, which it links to (S809 3n, REPORTS-3): guests
      // seated at tables only, and a credit-noted bill keeps its guests (summariseBills, through
      // coversMath). One arithmetic with the POS Dashboard's tiles.
      if (!ordersErr && !notesErr) summary = summariseBills(bills.data, returnsOf(notes.data))
    }

    const revenueTotal = summary.sales
    const billCount     = summary.bills
    const coversTotal   = summary.covers
    const dineInBills   = summary.dineInBills
    const avgCheck      = summary.avgBill ?? 0

    // Tonight's bookings (S677): the same window the Orders floor uses — today's BS day plus six
    // hours past midnight, so a 12:15 AM booking belongs to tonight's service, and since S818
    // (RESERVATIONS-8) a booking from the evening before while its booked window is still open. "Still
    // to come" is the covers not yet seated; a seated party is already inside Tables Occupied.
    // Requests are public-page bookings waiting for a staff Accept, whatever day they are for.
    const todayBs = nepalBs(new Date())
    let bookings = [], bookingsErr = null, requestsPending = 0, requestsErr = null
    const dayStart = todayBs ? bsDayBoundaryIso(todayBs.year, todayBs.month, todayBs.day, false) : null
    const dayEndBoundary = todayBs ? bsDayBoundaryIso(todayBs.year, todayBs.month, todayBs.day, true) : null
    if (todayBs && !(dayStart && dayEndBoundary)) bookingsErr = { message: `No calendar dates for BS ${todayBs.year}-${todayBs.month}-${todayBs.day}` }
    if (dayStart && dayEndBoundary) {
      const dayEnd = new Date(new Date(dayEndBoundary).getTime() + 6 * 3600000).toISOString()
      const [b, r] = await Promise.all([
        scopedFrom('pos_reservations', 'status, party_size, reserved_for, duration_minutes')
          .in('status', ['booked', 'confirmed', 'arrived', 'seated'])
          .gte('reserved_for', carryOverFrom(dayStart)).lte('reserved_for', dayEnd),
        // S834: a request whose time has passed is not counted (reservationSeen.js, as the nav chip).
        waitingRequests(scopedFrom('pos_reservations', 'id', { count: 'exact', head: true })),
      ])
      const dayStartMs = new Date(dayStart).getTime()
      bookings = (b.data || []).filter(x => stillInPlay(x, dayStartMs, Date.now())); bookingsErr = b.error
      requestsPending = r.count || 0; requestsErr = r.error
    }

    const { data: tables, error: tablesErr } = await scopedFrom('pos_tables', 'status').neq('status', 'inactive')
    if (loadIdRef.current !== myId) return // superseded by a newer client switch
    const tablesOccupied = (tables || []).filter(t => t.status === 'occupied').length
    const tablesTotal    = (tables || []).length
    const bookingsTonight = bookings.length
    const coversToCome    = bookings.filter(b => b.status !== 'seated').reduce((s, b) => s + (b.party_size || 0), 0)

    const hadRealError = (periodErr && periodErr.code !== 'PGRST116') || ordersErr || notesErr || tablesErr || bookingsErr || requestsErr
    setLoadErrors(prev => ({ ...prev, pos: hadRealError ? 'POS data failed to load — figures below may be incomplete or stale.' : '' }))

    // S809 3n (REPORTS-8): a failed read is not an empty period. Its tiles keep the last good figures
    // (or show "—" when there are none), and nothing from a failed load is cached.
    // Stamped with the outlet (S849, GAPS-3): keepLastGood never carries another outlet's figures.
    const fresh = { clientId: effectiveClientId, revenueTotal, coversTotal, dineInBills, billCount, avgCheck, tablesOccupied, tablesTotal, bookingsTonight, coversToCome, requestsPending }
    // A failed credit-note read fails the sales tiles too: without the notes, Revenue would read as
    // the bills alone, a figure the page did not compute.
    const failed = { sales: !!((periodErr && periodErr.code !== 'PGRST116') || ordersErr || notesErr), tables: !!tablesErr, bookings: !!(bookingsErr || requestsErr) }
    if (anyReadFailed(failed)) setPosStats(prev => keepLastGood(prev, fresh, failed, HOME_POS_READS))
    else setAndCache(setPosStats, 'posStats', fresh)
  }

  // Kitchen/bar-team variant (S431) — today's pos_kot_log activity for just this team's own
  // queue (KOT for kitchen, BOT for bar), never the other station's. Thresholds/formulas match
  // KitchenDisplay.jsx exactly (LATE_MS=15min) so a card here and the live board never disagree.
  async function loadKitchenPosStats(myId) {
    const kdsStation = posTeam === 'bar' ? 'BOT' : 'KOT'

    // The Kitchen Display's own window (S814 4d, REPORTS-11): this service, from midnight and rolling
    // over at 6 AM (serviceDayStartIso), with no upper bound — a ticket sent at 11:50 PM is still on
    // the board at 12:30 AM, so it is still on this card. Paged: one row per send per station, and a
    // long service at a busy outlet can pass 1,000 (the KDS pages the same read).
    const { data, error } = await fetchAllRows(() => scopedFrom('pos_kot_log', 'id, status, sent_at, started_at, ready_at')
      .eq('station', kdsStation)
      .neq('status', 'cancelled')
      .not('items', 'cs', KOT_CHANGE_ITEMS) // a CHANGE ticket (S809 3a) is not a dish made or waiting
      .gte('sent_at', serviceDayStartIso())
      .order('id'))
    if (loadIdRef.current !== myId) return // superseded by a newer client switch

    const rows = data || []
    const nowMs = Date.now()
    const LATE_MS = KDS_LATE_MS // the Kitchen Display's own line (posSignals.js)
    const READY_WAITING_MS = 20 * 60 * 1000 // "ready & still waiting for pickup", not all-day ready count

    const openNow = rows.filter(r => r.status === 'new' || r.status === 'in_progress').length
    // S754: 'served' is a finished ticket (the floor has taken Ready food to the table). Counting
    // anything not 'ready' as late would call every served ticket over 15 minutes old late.
    const finished = r => r.status === 'ready' || r.status === 'served'
    const lateCount = rows.filter(r => !finished(r) && (nowMs - new Date(r.sent_at).getTime()) > LATE_MS).length
    // Still waiting at the pass means Ready and NOT yet served; prep time and completed-today count
    // every ticket that reached Ready, served or not.
    const readyRows = rows.filter(finished)
    const readyWaiting = readyRows.filter(r => r.status === 'ready' && r.ready_at && (nowMs - new Date(r.ready_at).getTime()) < READY_WAITING_MS).length
    const prepDurationsMin = readyRows
      .filter(r => r.started_at && r.ready_at)
      .map(r => (new Date(r.ready_at).getTime() - new Date(r.started_at).getTime()) / 60000)
    const avgPrepMin = prepDurationsMin.length
      ? Math.round(prepDurationsMin.reduce((s, v) => s + v, 0) / prepDurationsMin.length)
      : null
    const completedToday = readyRows.length

    setLoadErrors(prev => ({ ...prev, pos: error ? `${kdsStation === 'BOT' ? 'Bar' : 'Kitchen'} data failed to load — figures below may be incomplete or stale.` : '' }))
    // S809 3n (REPORTS-8): a failed read never says "0 open, 0 late"; it keeps the last good tickets
    // (or shows "—") and is not cached.
    const fresh = { clientId: effectiveClientId, kitchen: true, station: kdsStation, openNow, lateCount, readyWaiting, avgPrepMin, completedToday }
    if (error) setPosStats(prev => keepLastGood(prev, fresh, { tickets: true }, HOME_KITCHEN_READS))
    else setAndCache(setPosStats, 'posStats', fresh)
  }

  // The ASK half of period close: run both preflights, then open the ConfirmModal below with
  // their sentences. The COMMIT half is performPeriodClose(), shared with Periods.js since S683.
  // Until then this button updated the status and inserted the next row and did nothing else —
  // no opening-stock carry-forward, no frozen report — under a dialog promising all three; the
  // IMS module guide had noticed and taught "always close from Periods" instead of the fix.
  async function askPeriodClose() {
    if (!activePeriod || !effectiveClientId || checkingClose || advancingPeriod) return
    setCheckingClose(true)
    setPeriodCloseNotice(null)
    const hrOn = !!clientModules?.hr
    const monthLabel = `${BS_MONTHS[activePeriod.bs_month - 1]} ${activePeriod.bs_year}`
    // Only admin and the Owner can write the frozen report (D42, closerMakesReport). For anyone
    // else the payroll note is about a report this close does not make — and their RLS view of
    // hr_payroll_runs is empty, so it would say "not finalized" of a finalized month. They get the
    // sentence saying when the report WILL be made instead.
    const makesReport = closerMakesReport({ isAdmin, isOwner })
    const askPayroll = hrOn && makesReport
    // With POS on, how many of the month's till bills still wait for Inventory (S809 4e, D4: warns,
    // never blocks), worded for who is closing. Not without Inventory (D6: its bills stay unposted).
    const askTill = !!clientModules?.pos && !!clientModules?.ims
    const [count, payroll, waiting] = await Promise.all([
      closingCountPreflight(activePeriod.id, effectiveClientId),
      askPayroll ? payrollPreflight(activePeriod.id, effectiveClientId) : Promise.resolve(undefined),
      askTill ? tillWaitingPreflight(activePeriod.id, effectiveClientId) : Promise.resolve(undefined),
    ])
    setCloseNotes([
      closingCountNote(count),
      askPayroll ? payrollNote(payroll, monthLabel) : null,
      askTill ? tillWaitingNote(waiting, monthLabel, { closerPosts: makesReport }) : null,
      makesReport ? null : deferredReportNote(monthLabel),
    ])
    setCheckingClose(false)
    setConfirmPeriodClose(true)
  }

  async function closeAndAdvancePeriod() {
    if (!activePeriod || !effectiveClientId || advancingPeriod) return
    setAdvancingPeriod(true)
    setPeriodCloseNotice(null)
    try {
      const result = await performPeriodClose({
        clientId: effectiveClientId, period: activePeriod, openNext: true, actorId: profile?.id,
        // A supervisor's close leaves the report to the Owner's first view (D42): its insert would
        // only be refused, and reported as a failure.
        makeReport: closerMakesReport({ isAdmin, isOwner }),
      })
      const failed = closeFailuresText({ failures: result.failures, period: activePeriod, isAdmin })
      if (failed) {
        result.failures.forEach(f => console.error('Period close:', f.stage, f.error))
        // Consequence sentences, never err.message — what state the month is in now, and what to
        // do — one for EVERY failed stage (S798 4b, LABOUR-FIGURES-10). `already_closed` is not a
        // failure of this press: someone else ended the month first and nothing was written, so on
        // its own it reads as information, not as an error (STOCK-8).
        setPeriodCloseNotice({ text: failed.text, neutral: failed.neutral })
      } else if (result.leaveFill) {
        // A clean close says nothing — except that opening the next month marked leave approved
        // earlier for it (S741). Periods.js always said so; this close, the one IMS supervisors use,
        // did not, and since S798 its back-fill is the one that actually marks the days.
        const next = nextBsMonth(activePeriod)
        const leave = backfillLeaveText(result.leaveFill, `${BS_MONTHS[next.bs_month - 1]} ${next.bs_year}`)
        if (leave) setPeriodCloseNotice({ text: leave, neutral: true })
      }
      if (result.closed) loadStats(loadIdRef.current)
    } finally {
      setAdvancingPeriod(false)
      setConfirmPeriodClose(false)
    }
  }

  async function loadFcTrend(currentPeriod, myId) {
    const { data: closedPeriods, error: closedErr } = await scopedFrom('monthly_periods', 'id, bs_year, bs_month')
      .eq('status', 'closed')
      .order('bs_year', { ascending: false })
      .order('bs_month', { ascending: false })
      .limit(11)

    const closed = closedPeriods || []
    // The open period's own id is folded into the same query batch (rather than this function
    // being handed a Food Cost % that loadStats' own, much heavier pipeline had to finish
    // computing first) so this whole function can run concurrently with loadStats instead of
    // waiting on it — see the call site's comment. Costs one extra period's worth of duplicate
    // purchase/sales rows (loadStats' own Promise.all fetches the open period too); worth it to
    // decouple the two pipelines.
    const periodIds = [...closed.map(p => p.id), ...(currentPeriod ? [currentPeriod.id] : [])]
    const closedIds = closed.map(p => p.id)

    const trendResults = await Promise.all([
      // Bill-key columns + `discount_amount` for allocateBillDiscounts(), as in loadStats — this
      // chart's open-period point must equal the Spend % so far tile, and every closed month must
      // equal the Food Cost % Consolidated P&L / Monthly Summary charge for it. `item_id` because
      // a closed month is valued per item (below), over Monthly Summary's item set.
      periodIds.length ? fetchAllRows(() => supabase.from('purchase_entries').select('period_id, item_id, qty, rate, discount_amount, purchase_group_id, vendor_id, invoice_ref, bs_day, vat_inclusive, vat_is_cost').in('period_id', periodIds).order('id')) : { data: [] },
      periodIds.length ? fetchAllRows(() => supabase.from('vendor_returns').select('period_id, item_id, qty, rate, bs_day, purchase_entries(vat_inclusive, vat_is_cost)').in('period_id', periodIds).order('id')) : { data: [] },
      // Revenue excludes comps (source='pos_comp') — a comped dish was never paid for — but the
      // filter is applied in JS below, NOT as `.neq('source','pos_comp')`. `sales_entries.source`
      // is nullable (DEFAULT 'manual', no NOT NULL), and in SQL `NULL <> 'pos_comp'` is NULL, so
      // the server-side form silently dropped every null-source row from REVENUE ONLY — leaving
      // this chart's denominator short against a full numerator, and disagreeing with loadStats'
      // own revenue for the very same month, which has always filtered client-side.
      //
      // fetchAllRows for the same reason: this is ~12 periods of one row per recipe per day, so a
      // bare .select() truncates at PostgREST's 1000-row cap with no error — and because only the
      // denominator was truncated, every Food Cost % on the chart failed HIGH. A believable wrong
      // number, on the figure the product is sold on.
      periodIds.length ? fetchAllRows(() => supabase.from('sales_entries').select('period_id, recipe_id, qty_sold, unit_price, discount, source, bs_day').in('period_id', periodIds).order('id')) : { data: [] },
      // Paged (S734): this map is the price fallback for any sales row with no `unit_price`, so
      // a recipe past the cut prices its sales at 0 — and this chart's whole subject is the
      // RATIO, so a short denominator makes every month's Food Cost % fail HIGH. Exactly the
      // failure the comment two entries above describes for the `.neq` that used to sit there.
      fetchAllRows(() => scopedFrom('recipes', 'id, selling_price').order('id')),
      // A CLOSED month plots Food Cost % = what was USED ÷ sales (S792, owner decision D30), the
      // figure Monthly Summary and the P&L give the same month; it used to plot purchases ÷ sales
      // under the same title, so the two charts named "Food Cost % … Trend" disagreed about every
      // closed month. That needs the stock side for the closed months only — the open month has no
      // count and plots Spend % so far. One row per item per period (per item per DAY for wastage
      // and staff meals) across up to eleven months, so every read is paged (S720's multiplier).
      // Items: every non-sub-recipe item, hidden ones included (D29), Monthly Summary's set.
      closedIds.length ? fetchAllRows(() => scopedFrom('items', 'id, name, per_uom_rate, is_active').eq('is_sub_recipe', false).order('id')) : { data: [] },
      closedIds.length ? fetchAllRows(() => supabase.from('opening_stock').select('period_id, item_id, qty').in('period_id', closedIds).order('id')) : { data: [] },
      closedIds.length ? fetchAllRows(() => supabase.from('closing_stock').select('period_id, item_id, physical_qty').in('period_id', closedIds).order('id')) : { data: [] },
      closedIds.length ? fetchAllRows(() => supabase.from('wastages').select('period_id, item_id, qty').in('period_id', closedIds).order('id')) : { data: [] },
      closedIds.length ? fetchAllRows(() => supabase.from('staff_meals').select('period_id, item_id, qty').in('period_id', closedIds).order('id')) : { data: [] },
      // Stock moved between the group's outlets (S849, PNL-8): in adds like a purchase, out comes off
      // like a return, in a closed month's COGS (valuePeriods) and the open month's spend alike.
      readPeriodTransfers(scopedFrom, periodIds),
    ])
    const [
      { data: allPurch }, { data: allRet }, { data: allSales }, { data: recipeData },
      { data: trendItems }, { data: allOpening }, { data: allClosing }, { data: allWaste }, { data: allStaff },
      { data: allTransfers },
    ] = trendResults
    if (loadIdRef.current !== myId) return // superseded by a newer client switch

    const hadRealError = closedErr || trendResults.some(r => r.error)
    setLoadErrors(prev => ({ ...prev, fcTrend: hadRealError ? 'Food Cost % trend failed to load.' : '' }))
    // A failed read draws nothing (S792). With the stock side in the arithmetic, a closed month
    // whose closing read failed would plot every shelf as used — a believable, alarming Food Cost %
    // — and the banner above cannot say which point is wrong. Not cached, so a reload retries.
    if (hadRealError) { setFcTrend([]); return }

    const priceMap = {}
    ;(recipeData || []).forEach(r => { priceMap[r.id] = parseFloat(r.selling_price || 0) })

    // Grouped by period_id in one pass each, instead of re-filtering the full purchases/returns/
    // sales arrays once per period below (O(periods × rows) → O(rows)) — bounded by the .limit(11)
    // above so it never ran away, but scales with purchase/sales volume across those 11 months.
    const revMap = {}
    // The open month's purchases, by period: its spend is allocated over its own bills (netSpendOf).
    // Closed months are valued through valuePeriods below, which groups by period itself.
    const purchByPeriod = {}
    ;(allPurch || []).forEach(e => { (purchByPeriod[e.period_id] = purchByPeriod[e.period_id] || []).push(e) })
    // unit_price captured on the row when present, else falls back to the recipe's current
    // price — this 11-month trend is exactly where always using today's price hurt most,
    // since a single menu price change would retroactively distort every past month's Food
    // Cost % line on the chart.
    ;(allSales || []).forEach(e => {
      if (e.source === 'pos_comp') return
      const price = e.unit_price != null ? parseFloat(e.unit_price) : (priceMap[e.recipe_id] || 0)
      revMap[e.period_id] = (revMap[e.period_id] || 0) + parseFloat(e.qty_sold) * price - (parseFloat(e.discount) || 0)
    })

    // Closed months: Food Cost % = COGS ÷ revenue, through periodCost.js's valuePeriods() — the same
    // valuePeriodItems() Monthly Summary and the P&L call, over the same items, each month's bill
    // discounts allocated on their own. `unjudged` is S756's D6 rule: a month closed with a material
    // share of its stock uncounted plots its figure without a verdict colour, and takes no part in
    // Best / Highest month, as on Monthly Summary, Annual Summary and Period Comparison.
    // (The purchase and return rows include the open month's too; valuePeriods reads only the ids
    // it is given.)
    const valued = valuePeriods({
      periodIds: closedIds, items: trendItems, opening: allOpening, closing: allClosing,
      purchases: allPurch, returns: allRet, wastages: allWaste, staffMeals: allStaff, transfers: allTransfers,
    })
    const points = closed.map(p => {
      const v = valued[p.id]
      const rev = revMap[p.id] || 0
      const fc  = rev > 0 && v ? parseFloat(((v.cogsVal / rev) * 100).toFixed(1)) : null
      return {
        label: `${BS_MONTHS_SHORT[p.bs_month - 1]} ${p.bs_year}`, fc, basis: 'cogs',
        cogs: v ? Math.round(v.cogsVal) : null, revenue: Math.round(rev), open: false,
        unjudged: !!v?.gap?.material,
        // What the missing count could be hiding (S826): the uncounted items' opening + purchase
        // value, which COGS reads as used. fcTrendMath turns it into the grey month's range.
        uncountedValue: v?.gap ? Math.round(v.gap.uncountedValue) : null,
        uncountedCount: v?.gap?.uncountedCount ?? null,
      }
    }).reverse()

    if (currentPeriod) {
      // The open month's point is the Spend % so far tile's own figure (S849): the same helpers, the
      // same finished days, stock transfers included.
      const clock = mtdClock(currentPeriod)
      const inOpen = rows => (rows || []).filter(r => r.period_id === currentPeriod.id)
      const net = netSpendOf({ purchases: purchByPeriod[currentPeriod.id] || [], returns: inOpen(allRet), transfers: inOpen(allTransfers), clock }).counted
      const rev = revenueOf(inOpen(allSales), priceMap, clock).counted
      const fc  = rev > 0 && !clock.firstDay ? parseFloat(((net / rev) * 100).toFixed(1)) : null
      if (fc != null) {
        // Purchases/revenue were withheld here (null) so the tooltip would omit them, which left
        // the one point most likely to look alarming as the only one you could not interrogate.
        // They are carried now; `open` is what the tooltip and the dot key off to say "so far".
        // `basis: 'spend'` (D30): this point is Spend % so far — the tile's figure — not a Food
        // Cost %, and the tooltip names it so.
        points.push({
          label: `${BS_MONTHS_SHORT[currentPeriod.bs_month - 1]} ${currentPeriod.bs_year}`,
          fc, basis: 'spend', purchases: Math.round(net), revenue: Math.round(rev), open: true
        })
      }
    }

    setAndCache(setFcTrend, 'fcTrend', points.filter(p => p.fc !== null))
  }

  const bsToday      = nepalBsToday()
  // Who may end the month (S756, decided with the owner): the Owner, an IMS supervisor or manager,
  // or admin — the Periods page's own guard. This banner used to offer the close to ANY login that
  // reached the dashboard, so a storekeeper could freeze the month's report before counting. The
  // database refuses the same writes (migration 20260918100000); this only stops offering them.
  const canClosePeriod = isOwner || hasImsAccess('supervisor')
  const periodExpired = activePeriod && (
    activePeriod.bs_year < bsToday.year ||
    (activePeriod.bs_year === bsToday.year && activePeriod.bs_month < bsToday.month)
  )
  const nextAdvMonth = activePeriod ? (activePeriod.bs_month === 12 ? 1 : activePeriod.bs_month + 1) : null

  const periodLabel = activePeriod ? `${BS_MONTHS[activePeriod.bs_month - 1]} ${activePeriod.bs_year}` : '—'

  // How far into the period we are.
  //
  // Food Cost % and Net Margin % divide a numerator that arrives in LUMPS (a bulk restock) by a
  // denominator that accrues DAILY (sales). Early in a month those are wildly out of step: a
  // restaurant three days in, having just bought a month of rice, reads a Food Cost % in the
  // hundreds and gets painted red under a tooltip saying "investigate immediately" — then reads a
  // healthy 33% green by day 30 with nothing having changed. Nothing on the card said the figure
  // was partial.
  //
  // The formula is NOT changed — this is the deliberate periodic-inventory model. What changes is
  // that an unsettled figure no longer wears a verdict colour it hasn't earned.
  const bsNow = nepalBsToday()
  const isCurrentPeriod = !!activePeriod && activePeriod.bs_year === bsNow.year && activePeriod.bs_month === bsNow.month
  const periodDays = activePeriod ? daysInBsMonth(activePeriod.bs_year, activePeriod.bs_month) : 30
  const dayOfPeriod = isCurrentPeriod ? bsNow.day : periodDays
  // Ten days is roughly where a single bulk purchase stops dominating a month's sales base. Before
  // that the ratio is arithmetic, not a signal.
  const SETTLE_DAY = 10
  const periodTooEarly = isCurrentPeriod && dayOfPeriod < SETTLE_DAY
  // S849 (OWNER-DASHBOARD-1/8): the ratios count the days already finished, and rent, Tax & Fees and
  // a whole-month labour figure are counted for those days, so Fixed Costs % is no longer lumpy and
  // keeps its band; Spend % so far and Est. Net Margin % keep the settle guard for stock purchases.
  // `stats.clock` is the clock the figures were computed on (one load, one clock).
  const statsCurrent = stats?.statsVersion === 2
  const sClock = statsCurrent ? stats.clock : null
  const daysText = countedDaysText(sClock)
  const firstDayNote = 'Ratios start after today — the first full day'
  // Grey, not green/amber/red, while the ratio is still meaningless. A neutral number that says
  // "not yet meaningful" is more trustworthy than a red one that isn't true.
  //
  // Returns the whole figure rather than just a colour (S734), for two reasons. The three ratio
  // cards on this page — Food Cost %, Fixed Costs %, Est. Net Margin % — each carried their
  // verdict in HUE ALONE, while the identical metrics on the Owner Dashboard, the Group Console
  // and the Monthly Owner Report all carry the ✓/△/▲ shape mark beside the number. A band
  // carried by colour alone fails WCAG 1.4.1, and green/accent-ink measured close enough under
  // deuteranopia that Healthy and Watch were one colour for roughly 1 in 12 men (S608) — which
  // is why `bandFigure` appends the mark rather than leaving it to each call site to remember.
  //
  // And the mark is withheld with the colour before SETTLE_DAY, not kept alongside a grey number:
  // a ✓ on a day-4 food cost is the same claim in a quieter voice.
  //
  // `withhold` (S756): the same neutral rendering for a figure that may be MISSING a cost rather than
  // merely unsettled — labour this login cannot read. A ✓ on a margin that might not include the
  // wage bill is the flattering half of the D22 defect in a quieter voice.
  // `settle` false (S849): Fixed Costs % is prorated and no longer needs the settle guard.
  const verdictFigure = (value, bander, withhold = false, settle = true) => {
    const f = bandFigure(value, bander)
    if (value == null) return { color: 'var(--theme-text2)', title: undefined, text: f.text }
    if ((settle && periodTooEarly) || withhold) return { color: 'var(--theme-text1)', title: undefined, text: `${value.toFixed(1)}%` }
    return { color: f.style.color, title: f.title, text: f.text }
  }

  // ── Labour: the one rule (S849, GAPS-4 / SU11 (a)) ───────────────────────────────────────────────
  //
  // An outlet with Crest HR: the finalized payroll run (scaled to the finished days while the month
  // runs), else the HR wage estimate accrued to yesterday, plus the month's festival / incentive /
  // settlement pay. The Overheads Labor tab is NAMED "not counted", never added and never a stand-in;
  // a login that cannot read payroll gets no labour figure. An outlet without HR: the Labor tab. Until
  // S849 an HR outlet with no finalized run took the Labor tab here while the Owner Dashboard and the
  // Owner Report took an estimate, so one month carried two labour figures.
  const ohBuckets = statsCurrent ? stats.overheadBuckets : null
  const labour = statsCurrent && stats.labourParts && sClock
    ? resolveOutletLabour({ ...stats.labourParts, labourBucket: ohBuckets?.labor || 0, scale: sClock.fraction })
    : null
  const labourNotes = outletLabourNotes(labour)
  // A lump (festival, incentive, settlement) paid in the running month sits over part of its sales.
  const labourWithheld = !!labour?.verdictWithheld || (!!labour?.other && !!sClock?.running)
  // Named on both ratio tiles when there are two possible sources (HR on), or none at all.
  const labourLabel = labour && (hrOn || labour.source === 'none')
    ? labourNotes.short.charAt(0).toUpperCase() + labourNotes.short.slice(1)
    : ''
  // Delivery commission: 0 without POS; null when unreadable on this login or failed (no margin).
  const commission = statsCurrent ? stats.commission : null
  const commissionAmt = !posOn ? 0 : commission?.status === 'ok' ? commission.amount : null
  const commissionUnreadable = posOn && commission?.status === 'unreadable'
  const figs = statsCurrent && !stats.figuresFailed && sClock
    ? operatingFigures({
        revenue: stats.revenueCounted, spend: stats.purchaseCounted, labour: labour?.amount ?? null,
        overhead: ohBuckets?.overhead || 0, taxFees: ohBuckets?.tax_fees || 0, commission: commissionAmt, clock: sClock,
      })
    : null
  const fixedMissing = !!figs?.fixedMissing
  // Fixed costs counted for the finished days, labour included: the figure both tiles and the pie use.
  const fixedCostTotal = figs && labour?.amount != null ? figs.fixedCounted + labour.amount : null

  // Spend % so far, NOT Food Cost % (S792, D30). This page only ever shows the OPEN month, which has
  // no closing count, so what it can divide by sales is what was BOUGHT. The name `fcPct` is kept: it
  // still bands on the food-cost thresholds.
  const fcPct = figs?.spendPct ?? null
  const ohPct = fixedCostTotal > 0 ? figs.fixedCostsPct : null
  const netMarginPct = figs?.marginPct ?? null
  const marginWithhold = labourWithheld || commissionUnreadable || fixedMissing
  const transfersLine = statsCurrent && !stats.figuresFailed && (stats.transfers?.inAll || stats.transfers?.outAll)
    ? `includes transfers in ${npr(stats.transfers.inAll)} · out ${npr(stats.transfers.outAll)}`
    : ''
  // Computed once per render instead of inside the pie-legend .map() below, where every row was
  // redundantly re-reducing the same, unchanging total.
  const categorySpendTotal = categorySpend.reduce((s, r) => s + r.value, 0)

  // Screen-reader-only chart summaries — the 4 charts below have no text alternative today;
  // a non-sighted user gets zero information from a trend/proportion a sighted user reads at a
  // glance. Rendered via ChartCard's `footer` slot (inside the same card, so it doesn't add an
  // extra grid item the way a sibling element would).
  const categorySpendSummary = categorySpend.length === 0
    ? 'No purchase data for this period.'
    : `Top spend category: ${categorySpend[0].name} at NPR ${categorySpend[0].value.toLocaleString('en-IN')}${categorySpendTotal > 0 ? ` (${Math.round((categorySpend[0].value / categorySpendTotal) * 100)}% of total purchases)` : ''}.`
  // ── Rain adjustment on the live SALES forecast (S784) ───────────────────────────────────────
  // weatherEffect.js holds the reasoning. The weather arrives from its own hook and is applied here
  // by re-running projectMonth with a per-day factor, so loadStats never waits for it. Sales only,
  // the next WEATHER_HORIZON_DAYS only, never the Target, and the measured effect is shown, never
  // applied: the Owner's percentage is the one that moves the line.
  // `weatherFeature` gates the rain-adjusted SALES forecast only (IMS Growth or the admin flag). The
  // weather itself — the header strip and the city behind it — is hasWeather, which also comes with
  // the POS and HR modules (S786), and is derived once for both dashboards in useWeatherStrip. The
  // chart's rain adjustment below needs the client's IMS data (salesForecastInputs); its "×N%" tags
  // in the strip also need THIS viewer to see that chart.
  const weatherFeature = hasFeature('weather_forecast')
  const weatherStrip = useWeatherStrip({ refreshKey: location.key })
  const { weather, weatherError, weatherByAd, own: weatherSettingsOwn, located: weatherLocated } = weatherStrip
  const rainPct = weatherSettingsOwn ? rainPctValue(settings.rain_sales_pct) : null
  const weatherTodayAd = weather?.today || formatAd(nepalCivilDate(Date.now()))
  // The Nepal date the forecast was fetched: a stale forecast steers only the days it was made for.
  const weatherForecastAd = weather?.fetched_at ? formatAd(nepalCivilDate(weather.fetched_at)) : null
  // weatherFeature is not optional here (S786 review): the weather now loads for any client with
  // POS or HR, so without it an IMS-Starter client carrying an old rain_sales_pct would get the
  // Growth adjustment (and its ×N% tags) for free.
  const rainAdj = weatherFeature && salesForecastInputs && weatherByAd
    ? rainFactorForMonth({
        rainPct, weatherByAd, todayAd: weatherTodayAd, forecastAd: weatherForecastAd,
        bsYear: salesForecastInputs.bsYear, bsMonth: salesForecastInputs.bsMonth, monthEndDay: salesForecastInputs.monthEndDay,
      })
    : null
  const rainAheadView = weatherByAd ? rainAhead({ weatherByAd, todayAd: weatherTodayAd, forecastAd: weatherForecastAd }) : null
  // A festival's multiplier stays on its day beside the rain (S850): the two multiply. An input
  // cached before S850 has no `festivals`, which reads as none.
  const inputFestivals = salesForecastInputs?.festivals || {}
  const rainTrend = rainAdj
    ? projectMonth({
        ...salesForecastInputs,
        weekdayOf: d => bsToAd(salesForecastInputs.bsYear, salesForecastInputs.bsMonth, d).getDay(),
        dayFactor: d => rainAdj.factorOf(d) * salesFestivalFactor(inputFestivals)(d),
        judged: salesFestivalJudged(inputFestivals),
        learnRuns: festivalLearnRuns(inputFestivals),
      })
    : null
  // The days AHEAD the rain moved, for the footer. A rainy day already gone only corrected the pace.
  const rainForecastDays = rainTrend
    ? Object.keys(rainAdj.byDay).map(Number).filter(d => rainTrend.projDays[d] != null).sort((a, b) => a - b)
    : []
  const salesProjectionView = rainTrend ? { projectedMonthEnd: rainTrend.projectedTotal, learned: rainTrend.learned } : salesProjection
  // S851: festivals whose sales forecast follows their own finished days, for the footer and the
  // tooltip. A projection cached before S851 has no `learned`, which reads as none.
  const festivalLearned = salesProjectionView?.learned || []
  const learnedByDay = Object.fromEntries(festivalLearned.flatMap(l => l.days.map(d => [d, l])))
  const dailyTrendView = rainTrend || festivalLearned.length
    ? dailyTrend.map(row => {
        const d = parseInt(String(row.day).replace('Day ', ''), 10)
        const withLearned = learnedByDay[d] ? { ...row, festLearned: learnedByDay[d] } : row
        if (rainTrend?.projDays[d] == null) return withLearned
        const rain = rainAdj.byDay[d]
        return { ...withLearned, salesProj: rainTrend.projDays[d], ...(rain && { rainMm: rain.mm, rainPct: rainAdj.pct }) }
      })
    : dailyTrend
  const measuredRain = weatherByAd && salesForecastInputs?.base
    ? measuredRainEffect({ dayLog: salesDayLog, byWeekday: salesForecastInputs.base.byWeekday, weatherByAd })
    : null
  // The MET Norway credit's links. An <a> with no colour of its own is the browser's default blue,
  // which is near-unreadable on the dark presets. text2 plus an underline reads as a link without
  // spending the accent on an attribution.
  const weatherCreditLink = { color: 'var(--theme-text2)', textDecoration: 'underline', textUnderlineOffset: 2 }

  // ── The header's weather strip (S785) ───────────────────────────────────────────────────────
  // A day the chart's forecast actually moved gets a "×N%" tag: exactly rainForecastDays,
  // the same days the chart footer names, so the two can never disagree about which days dip.
  // Only for a viewer who sees that chart (showIms's test, below): a POS PIN login on an IMS+POS
  // client would otherwise read about a sales forecast it is never shown.
  const rainTagByAd = rainTrend && clientModules.ims && hasImsAccess('staff')
    ? Object.fromEntries(rainForecastDays.map(d => [adDateOf(salesForecastInputs.bsYear, salesForecastInputs.bsMonth, d), rainAdj.pct]))
    : null

  // Compact card window — 6 days back → 3 days ahead of today, sliced out of the full-month
  // `dailyTrend` array so the small glanceable card stays readable; the expanded modal (`big`
  // in renderChart below) uses the full `dailyTrend` array instead.
  const dailyTrendWindowed = (() => {
    if (dailyTrendView.length <= 10) return dailyTrendView
    const bsToday = nepalBsToday()
    const todayIdx = dailyTrendView.findIndex(d => d.day === `Day ${bsToday.day}`)
    if (todayIdx === -1) return dailyTrendView.slice(-10)
    return dailyTrendView.slice(Math.max(0, todayIdx - 6), todayIdx + 4)
  })()
  // Today's sold-so-far rides on its own key (S851), and is part of "so far".
  const dailyTrendPurchTotal = dailyTrend.reduce((s, d) => s + (d.purchases ?? d.purchToday ?? 0), 0)
  const dailyTrendSalesTotal = dailyTrend.reduce((s, d) => s + (d.sales ?? d.salesToday ?? 0), 0)
  // The dashed forecast exactly on the dotted Target on every day it forecasts: the footer says so
  // (S851), since one line then sits on the other. Anchor days (an actual beside the dashed point,
  // not today) are not forecasts. Before S851 a cached row held today in `sales`, which only
  // skips today here until the next load.
  const forecastOnTarget = (projKey, targetKey) => {
    const days = dailyTrendView.filter(r => r[projKey] != null && r[PROJ_ACTUAL_KEY[projKey]] == null)
    return days.length > 0 && days.every(r => r[projKey] === r[targetKey])
  }
  const salesOnTarget = !!salesProjectionView && forecastOnTarget('salesProj', 'salesTarget')
  const purchOnTarget = !!purchProjection && forecastOnTarget('purchProj', 'purchTarget')
  // Only a current-model Target is drawn: a pre-S780 one can still be sitting in dashboardCache
  // for the moment before loadStats replaces it, and its slope fit is exactly what S780 removed.
  const salesTarget = isCurrentSnapshot('sales', salesTargetSnap) ? salesTargetSnap : null
  const purchTarget = isCurrentSnapshot('purch', purchTargetSnap) ? purchTargetSnap : null
  // What the sales Target line adds up to, festivals at their multipliers (S850). The stored figure
  // is the usual week's, and stands in only until loadStats has worked the month out.
  const salesTargetMonthEnd = salesTarget ? (salesTargetTotal ?? salesTarget.projectedMonthEnd) : null
  // This month's festivals, off the chart's own rows, for the footer: which days, and how many of
  // them carry no Demand Multiplier: usual days on the Target, learning on the forecast (S851).
  const festivalRows = dailyTrend.filter(r => r.festival)
  const festivalDayNums = festivalRows.map(r => parseInt(String(r.day).replace('Day ', ''), 10))
  const festivalsUnset = festivalRows.filter(r => r.festival.multiplier == null).length
  // Where a Target came from, in the words the footer and the screen-reader summary use.
  const targetBasis = snap => (snap.source === 'history'
    ? "last 4 weeks' pace"
    : `set on Day ${snap.capturedDay} from this month's first ${snap.sampleDays} days`)
  const dailyTrendSummary = dailyTrend.length === 0
    ? 'No purchase or sales data for this period.'
    : `Purchases and sales trend, ${periodLabel}. Purchases shown so far total NPR ${dailyTrendPurchTotal.toLocaleString('en-IN')}.${hasDailySales ? ` Sales shown so far total NPR ${dailyTrendSalesTotal.toLocaleString('en-IN')}.` : ''}${salesProjectionView ? ` Projected month-end revenue: NPR ${salesProjectionView.projectedMonthEnd.toLocaleString('en-IN')}.` : ''}${rainForecastDays.length ? ` The sales forecast allows for rain on day ${rainForecastDays.join(', ')}.` : ''}${purchProjection ? ` Projected month-end purchases: NPR ${purchProjection.projectedMonthEnd.toLocaleString('en-IN')}.` : ''}${salesTarget ? ` Sales target (${targetBasis(salesTarget)}): NPR ${salesTargetMonthEnd.toLocaleString('en-IN')}.` : ''}${purchTarget ? ` Purchase target (${targetBasis(purchTarget)}): NPR ${purchTarget.projectedMonthEnd.toLocaleString('en-IN')}.` : ''}${festivalDayNums.length ? ` Festival days from Holiday Calendar: day ${dayRanges(festivalDayNums)}.` : ''}${festivalLearned.map(l => ` The sales forecast for day ${dayRanges(l.days)} is ${l.pct}% of a usual day, from how day ${dayRanges(l.from)} sold.`).join('')}`
  const topItemSpendSummary = topItemSpend.length === 0
    ? 'No purchase data for this period.'
    : `Top items by spend: ${topItemSpend.slice(0, 3).map(i => `${i.fullName} at NPR ${i.value.toLocaleString('en-IN')}`).join(', ')}.`
  // ── Food Cost % trend: an unfinished month is not a data point ──────────────────────────────
  //
  // The KPI card above refuses to paint a verdict colour on the open period before SETTLE_DAY,
  // because purchases arrive in lumps and sales accrue daily (see the long note at `periodTooEarly`).
  // The chart 200px below it used to ignore that entirely: a day-6 period whose owner had just
  // bought the month's stock plotted at 391.8%, took the "Highest month" pill, dragged an unweighted
  // mean to 173.5%, and compressed every settled month into the bottom eighth of the y-axis — so the
  // one chart built to show whether food cost is drifting became unreadable for exactly that.
  //
  // Same rule, same threshold: before SETTLE_DAY the open month is withheld and NAMED (silently
  // dropping it would be its own lie); after it, the point is drawn but stays out of every
  // superlative and out of the average, since a part-month can neither win nor lose a month.
  const fcOpenPoint    = fcTrend.find(p => p.open) || null
  const fcOpenTooEarly = !!fcOpenPoint && periodTooEarly
  const fcChartData    = fcOpenTooEarly ? fcTrend.filter(p => !p.open) : fcTrend
  const fcBands        = fcThresholds(settings)
  // The Average, Best / Highest month, the rupee pills and the line's solid / faded / dashed
  // stretches all come from fcTrendMath.js (S826), and all are made from FULLY COUNTED closed
  // months. A month closed with a material share of its stock uncounted (D6) reads high by an amount
  // nobody knows, so it is drawn, faded and given its range, but never averaged or ranked — the
  // Average used to blend it in, and with one counted month left, Best and Highest named the same
  // month. The Average is blended (Σ COGS ÷ Σ sales); the open Spend % point is in none of it.
  const fcView         = fcTrendView(fcChartData, { warnPct: fcBands.warn })
  const fcAvg          = fcView.average
  const fcGreyCount    = fcView.closedCount - fcView.countedCount
  // The three KPI ratios' banders, resolved once. Food cost reads the client's own Settings
  // thresholds; net margin is `nmBand`'s published ≥20 / ≥10 rather than a second copy of the
  // same two numbers (they were written out inline here, which is exactly the drift
  // operatingBands.js was created to stop — identical today, and nothing kept them so).
  //
  // Fixed Costs % has no shared bander because no other surface prints it, so it keeps its own
  // 50/65 ladder — but through `descendingBand`, which supplies the mark and the band name and
  // yields byte-identical colours to the inline ternary it replaces.
  const fcCardBand = pct => fcBand(pct, settings)
  const FIXED_COST_WARN = 50, FIXED_COST_CRITICAL = 65
  const ohCardBand = pct => descendingBand(pct, FIXED_COST_WARN, FIXED_COST_CRITICAL)
  // fcBand() returns CSS var() strings, which do not resolve inside an SVG fill — so the bands come
  // from the client's own thresholds while the colours come from the resolved theme palette.
  const fcDotColor = pct => pct == null ? colors.text3
    : pct <= fcBands.warn     ? colors.greenText
    : pct <= fcBands.critical ? colors.amberText
    : colors.redText
  const fcTrendSummary = fcChartData.length === 0
    ? 'No food cost history yet.'
    : `Food cost percentage over the last ${fcChartData.length} month${fcChartData.length === 1 ? '' : 's'}: ${fcView.rows.map(p => `${p.label} ${p.fc}%${p.open ? ' spent so far (spend ÷ sales, month still open)' : p.unjudged ? ` (not judged: stock count incomplete${p.lowFc != null ? `; really between ${p.lowFc}% and ${p.fc}%` : ''})` : ''}`).join(', ')}.${fcAvg ? ` Average across ${fcAvg.months} fully counted month${fcAvg.months === 1 ? '' : 's'}: ${fcAvg.pct.toFixed(1)}%.` : fcView.closedCount ? ' No closed month is fully counted yet, so there is no average.' : ''}${fcView.above ? ` That is ${npr(Math.abs(fcView.above.npr))} ${fcView.above.npr >= 0 ? 'above' : 'under'} the ${fcBands.warn}% Good line.` : ''}${fcOpenTooEarly ? ` ${fcOpenPoint.label} is only ${dayOfPeriod} days in and is not shown yet.` : ''}`

  // Revenue vs Cost Breakdown pie — a "P&L at a glance" composition of exactly the figures behind
  // the Est. Net Margin % card (revenue minus food cost and overheads), in the standard restaurant
  // P&L order: Food Cost → Labor → Overheads → Tax & Fees → what's left.
  //
  // Labor is `labour.amount` (S849, the one rule): with Crest HR the finalized payroll run or, until it
  // is finalized, the HR wage estimate; without HR the Overheads page's own `labor` bucket — never
  // both. Since S849 every slice is over the days already finished: food over the counted days'
  // purchases, rent and Tax & Fees counted for those days, so the pie is the tiles' own figures.
  // Until S526 this
  // chart drew `stats.overheadTotal` (which is all three buckets summed, labor included) as one
  // "Overheads" slice AND added `hrStats.payroll` on top as a separate "Labor (basic)" slice — so
  // every rupee of labor was counted twice and the pie's own total came out well above the total
  // cost the net-margin figure beside it was computed from (found live: NPR 454k of slices against
  // a 401k cost base, with the -57.2% margin correctly reflecting only the 401k). OwnerDashboard
  // already avoids this by querying `.eq('bucket','overhead')` before subtracting HR payroll
  // separately; this page keeps all three buckets (its KPI cards mean the combined figure) and
  // splits them for display instead, so the slices always sum to exactly the cost base behind the
  // margin. Gated on canOverheads (Growth) same as netMarginCard.
  //
  // Net Margin only joins the slices when positive — a negative-value pie slice renders as a
  // misleading sliver rather than "costs exceeded revenue," so a negative margin is surfaced via
  // the footer callout below instead of forced into the chart.
  // Fixed hex, not theme tokens — same rule as CHART_COLORS above (CSS var() doesn't resolve
  // inside Recharts' SVG fill), and the legend swatches must match the slices they label.
  //
  // These were `colors.accent/purple/red/amber/green` until S527, which was a genuine
  // indistinguishability bug rather than a taste call: the semantic token set was never designed
  // as a categorical palette. `accent` and `purple` are literally the same hex in three presets
  // (Dracula #bd93f9, Mocha #cba6f7, Latte #8839ef), and accent sits beside amber in Dark
  // (#c9a84c vs #fbbf24) and Warm — so the pie drew near-identical slices in 5 of the 10 themes.
  // Measured on the Dark card surface: Tax & Fees↔Food Cost came out at ΔE 10.6 for normal
  // vision (floor is 15) and Overheads↔Food Cost at ΔE 5.1 under deuteranopia (floor is 8).
  //
  // The replacement was brute-forced against those two floors across five card surfaces (three
  // dark presets, two light) rather than picked by eye: worst pair is now ΔE 16.8 normal / 8.6
  // deutan. Tritan lands at 7.7, inside the 6–8 band that's only acceptable with secondary
  // encoding — satisfied here by the 2px paddingAngle gaps, the percent-on-slice labels in the
  // expanded view, and the name+NPR+% legend under every size.
  //
  // Red is deliberately gone: on this dashboard red means "over threshold" (FC% > 45%, negative
  // margin), so spending it on a slice that merely means "Overheads" was overloading a status
  // color. The four cost slices are now plainly categorical and only Net Margin keeps a semantic
  // hue. #60a5fa here is NOT the undocumented accent S521 removed from AdminClients/SuiteGate —
  // that was UI chrome, where the one-accent rule applies; this is a chart series hue, the same
  // exemption CHART_COLORS already relies on. The map itself lives in shared/chartColors.js since
  // S796, so Overheads' cost stack and bucket bars draw the same slots.
  // Falls back to one combined slice for a `stats` object restored from a pre-S526 session cache,
  // which has overheadTotal but no overheadBuckets — still correct, just less broken out.
  const costBreakdown = figs ? [
    { name: 'Food Cost', value: Math.max(0, stats.purchaseCounted || 0) },
    { name: 'Labor',      value: Math.max(0, labour?.amount || 0) },
    { name: 'Overheads',  value: Math.max(0, prorate(ohBuckets?.overhead || 0, sClock) || 0) },
    { name: 'Tax & Fees', value: Math.max(0, prorate(ohBuckets?.tax_fees || 0, sClock) || 0) },
    ...(netMarginPct != null && netMarginPct > 0
      ? [{ name: 'Net Margin', value: Math.max(0, stats.revenueCounted * netMarginPct / 100) }]
      : []),
  ].filter(r => r.value > 0) : []
  const costBreakdownTotal = costBreakdown.reduce((s, r) => s + r.value, 0)
  // One colour per slice for the pie AND its legend swatch (S796): a withheld margin draws its slice
  // grey, as the footer below withholds, instead of a green "profit" slice. Withheld for the same two
  // reasons the Est. Net Margin tile withholds (S797): labour that may be missing, and a month not yet
  // SETTLE_DAY days old, where one bulk purchase decides the sign. The pill, slice and footer all read
  // `marginWithheld`, so the card cannot judge a figure the tile beside it does not.
  const marginWithheld = marginWithhold || periodTooEarly
  const costSliceFill = name => costSliceColor(name, { withheld: marginWithheld })
  // The sentence for whichever labour branch the page took (S683's rule: a branch the page knows
  // about is said out loud). Before S756 this only fired for "Labor tab empty but HR has basic
  // salaries" — the page now reads the finalized run itself, so what is left to say is: payroll
  // superseded a typed figure (named, with its amount), there is no labour anywhere yet, or this
  // login could not see payroll. Null when labour came from exactly one source with nothing to add.
  const npr0 = n => `NPR ${Math.round(n).toLocaleString('en-IN')}`
  const labourNote = !labour ? null
    : labour.ignoredBucket > 0 && labour.amount != null
      ? `Labor is ${labour.source === 'payroll' ? 'your finalized payroll run' : 'the HR wage estimate (payroll is not finalized yet)'} (${npr0(labour.amount)}). The ${npr0(labour.ignoredBucket)} on the Overheads Labor tab is not added — with Crest HR, payroll is the labour figure.`
    : labour.source === 'estimate'
      ? 'Labor is the HR wage estimate — payroll is not finalized yet.'
    : labour.source === 'unreadable'
      ? 'Payroll cannot be read on this login, so labour is not in these figures and the margin is not shown. The account owner sees the full figure.'
    : labour.source === 'failed'
      ? 'Labour could not be loaded, so the margin is not shown. Retry from the notice at the top of the page.'
    : null
  const labourNoteIsWarning = labourWithheld || labour?.source === 'unreadable' || labour?.source === 'failed'
  const costBreakdownSummary = costBreakdown.length === 0
    ? 'No cost data for this period.'
    : `Revenue breakdown this period: ${costBreakdown.map(r => `${r.name} NPR ${Math.round(r.value).toLocaleString('en-IN')}`).join(', ')}. Net margin: ${netMarginPct != null ? `${netMarginPct.toFixed(1)}%` : '—'}.${labourNote ? ` ${labourNote}` : ''}`

  // Shared mini card style + a11y — returns a spreadable props object so every KPI card gets
  // keyboard support (role/tabIndex/onKeyDown) and a visible focus ring for free, instead of each
  // clickable div being mouse-only. Non-interactive cards (onClick == null) get style only.
  // .stat-card --compact, not a fourth hand-rolled copy of the same box. This file, OwnerDashboard
  // and AdminDashboardOverview each typed .stat-card's five box properties out inline and then
  // drifted on the one thing that shows — 10x14 here, 14x16 there, 12x14 there, against the
  // class's own 20 — so a KPI card meant nothing in particular across the four dashboards. The
  // --compact tier is for a strip with a REAL gap (these sit in .stat-grid--compact): shadow kept,
  // seam pull dropped. Only cursor and the interaction props are this call site's business.
  const kpiCard = (onClick) => ({
    className: onClick ? 'stat-card stat-card--compact interactive-card' : 'stat-card stat-card--compact',
    ...(onClick ? {
      style: { cursor: 'pointer' },
      onClick,
      role: 'button',
      tabIndex: 0,
      onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } }
    } : {})
  })
  // Shared KPI text styles — single source of truth for label/value/subtext sizing across every
  // KPI grid section (IMS Row 1/2, HR, POS), so a future re-tune is a 3-line edit, not a sweep of
  // 15+ inline style objects. kpiValueStyle keeps the hero (bigger/bolder) vs secondary two-tier
  // hierarchy explicit via its params, rather than one flattened size for every card.
  const kpiLabelStyle = { fontSize: 10, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }
  const kpiSubtextStyle = { fontSize: 11, color: 'var(--theme-text3)', marginTop: 4 }

  const kpiValueStyle = (size, weight = 700) => ({ fontSize: size, fontWeight: weight, lineHeight: 1.1 })

  // Compact upsell card for a locked feature → links to /pricing. Only render when the
  // feature is locked; an admin grant flips hasFeature(...) → real KPI shows instead.
  // Uses var(--theme-purple) (the rationed 4th-color token) instead of a hardcoded indigo —
  // the old #818cf8/rgba(129,140,248,*) literal was unconditional across all 10 theme presets
  // (a Bright-preset-only exception, retired with that preset in S612) and an unaudited contrast risk on light presets.
  const UpsellCard = ({ label, tier, blurb }) => (
    <div
      onClick={() => navigate('/pricing')}
      role="button"
      tabIndex={0}
      className="stat-card stat-card--compact interactive-card"
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate('/pricing') } }}
      // The same box as the KPI tiles it sits beside — it occupies one of their slots and must
      // measure like one — minus the shadow, because a dashed ghost tile is not a figure and
      // should sit back from the cards that are.
      style={{
        background: 'color-mix(in srgb, var(--theme-purple) 8%, transparent)',
        border: '1px dashed color-mix(in srgb, var(--theme-purple) 40%, transparent)',
        boxShadow: 'none', cursor: 'pointer'
      }}
    >
      <div style={{ ...kpiLabelStyle, marginBottom: 4, display: 'flex', justifyContent: 'space-between' }}>
        <span>{label}</span><Lock size={12} aria-hidden="true" />
      </div>
      <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--theme-purple-text)', lineHeight: 1.2 }}>Unlock with {tier}</div>
      <div style={kpiSubtextStyle}>{blurb} · View plans →</div>
    </div>
  )

  // Module-composable: show a section header per module only when 2+ modules are active.
  // Dashboard sections reflect the displayed client's actual subscription (clientModules),
  // not the admin route-access bypass — so admin "view as client" previews accurately.
  // Also requires the viewer's own ims_role grant (hasImsAccess) — every IMS page redirects
  // an ims_role-less staffer (POS-only/HR-only login) here on denial, so this fallback must not
  // itself leak the Food Cost%/margin/spend data those pages are gated to protect.
  // POS the same way (S750 browser check): an HR-only login's pos_orders read comes back
  // RLS-empty, and the section rendered it as Revenue NPR 0 / 0 bills / 0 tables beside the
  // Owner's real NPR 1,680 — a zero nobody computed, not a quiet day. The test lives in
  // shared/dashboardHome.js since S800, because Layout reads the same answer to decide whether
  // the top bar carries a Home tab.
  const dashMods = dashboardModules({ clientModules, hasImsAccess, hasHrAccess, hasPosAccess })
  const showIms = dashMods.ims
  const showHr  = dashMods.hr && !imsScope
  const showPos = dashMods.pos && !imsScope
  const moduleCount = [showIms, showHr, showPos].filter(Boolean).length
  const showStockOnHand = showIms && canReorder && hasFeature('stock_report') && hasImsAccess('supervisor')
  const showPriceMovers = showIms && !!activePeriod && hasFeature('price_tracker') && hasImsAccess('manager')
  // A Home of two or more modules is called Home, the word on its tab — admin included, since the
  // subtitle names the client being viewed. Admin's own overview is AdminDashboardOverview.
  const dashTitle = imsScope ? 'Inventory Dashboard'
    : moduleCount > 1 ? 'Home'
    : isAdmin ? 'Admin Dashboard'
    : showIms ? 'Inventory Dashboard'
    // Not 'HR Dashboard' — that's the title of the real, richer page at /hr/dashboard
    // (HrDashboard.jsx: headcount, leave/OT queues, SSF, advances). This is a lighter summary
    // on the universal route; an identical title on two different pages was confusing.
    : showHr  ? 'HR Overview'
    : showPos ? 'POS Overview' // the POS Dashboard is /pos/dashboard (S800); one name per page
    : 'Dashboard'
  const showModuleHeaders = moduleCount >= 2
  // A real <h2> (not a styled div) so screen-reader users can navigate the page's module
  // sections (Inventory/Human Resources/Point of Sale) by heading, same as any other landmark.
  // margin/fontWeight explicitly reset since a bare <h2> otherwise renders bold with browser
  // default margins — visual size/weight is unchanged from the div it replaces.
  // Single-module clients get the same <h2>s visually hidden (.sr-only) rather than nothing —
  // without them the page jumps h1 → h3 (ChartCard titles) with no level in between, which
  // breaks heading navigation for screen-reader users (dashboard critique P2, S569).
  const moduleHeader = (text) => showModuleHeaders
    ? <h2 style={{ fontSize: 11, fontWeight: 400, margin: '0 0 8px', color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{text}</h2>
    : <h2 className="sr-only">{text}</h2>

  // Equal-width 3-column layout — only kicks in at 2+ modules, matching showModuleHeaders. A
  // 1-module client keeps today's full-width single-column render untouched. Named classes (not
  // a computed inline gridTemplateColumns) specifically so Layout.css's mobile media-query
  // collapse can win at narrow widths — an inline style would always beat a class's rule
  // regardless of viewport.
  const dashColsClass = !showModuleHeaders ? ''
    : (showIms && showHr && showPos) ? 'dash-3col-all'
    : (showHr && showPos) ? 'dash-3col-hr-pos'
    : 'dash-3col-ims-plus' // IMS+HR or IMS+POS

  // Sales Mix (S557) — used to be its own card (FoodBeverageSplit.jsx, deleted) living only in the
  // Sales Breakdown section below, 2+ modules only. Now folded into a second tab on the Revenue vs
  // Cost Breakdown card further down, so it (a) reaches single-module IMS clients too — they always
  // had the revenue data for it, just no card showing it — and (b) frees a whole column in the
  // Sales Breakdown row for the sales pivot table(s) to grow into. Own hook, own effect,
  // independent of loadStats' load cycle — unchanged from when FoodBeverageSplit.jsx owned this.
  const salesMixIncludeManual = showIms && canSales
  const salesMixIncludePos = showPos && !posIsStationTeam
  // The card renders only on a page with one module (the Inventory Dashboard, or a single-module
  // /dashboard: imsChartsAndTables sits in the `!showModuleHeaders` branch), so the read is asked for
  // only then (S814 4d). Home of 2+ modules used to read a month of sales for a card it never drew.
  const { buckets: salesMixBuckets, loading: salesMixLoading } = useFoodBeverageSplit({
    activePeriod,
    includeManual: !showModuleHeaders && salesMixIncludeManual,
    includePos: !showModuleHeaders && salesMixIncludePos,
  })
  const salesMixCategories = Object.keys(salesMixBuckets).filter(c => salesMixBuckets[c] > 0).sort((a, b) => salesMixBuckets[b] - salesMixBuckets[a])
  const salesMixTotal = salesMixCategories.reduce((s, c) => s + salesMixBuckets[c], 0)
  // Food/Beverage keep the fixed semantic colors FoodBeverageSplit.jsx always gave them; any other
  // category rotates through CHART_COLORS (the page's own categorical palette) rather than a
  // second, duplicated fallback array — FoodBeverageSplit.jsx used to duplicate this exact set
  // locally specifically because it lived outside the page file; now that this logic lives here,
  // that duplication is gone.
  const salesMixColorOf = (() => {
    let nextFallback = 0
    const assigned = {}
    return (cat) => {
      if (assigned[cat]) return assigned[cat]
      if (cat === 'Food') return (assigned[cat] = colors.green)
      if (cat === 'Beverage') return (assigned[cat] = colors.purple)
      return (assigned[cat] = CHART_COLORS[nextFallback++ % CHART_COLORS.length])
    }
  })()
  const salesMixSummary = salesMixTotal <= 0
    ? 'No sales data for this period.'
    : `Sales mix this period: ${salesMixCategories.map(c => `${c} NPR ${Math.round(salesMixBuckets[c]).toLocaleString('en-IN')} (${((salesMixBuckets[c] / salesMixTotal) * 100).toFixed(0)}%)`).join(', ')}.`
  // Whether each half of the merged card has anything to offer at all — "available" means
  // entitled/configured to see that view, not "has data this period" (an empty period still gets
  // the tab, with its own inline empty state, same as the Spend by Category / Top Items tabs).
  const costTabAvailable = canOverheads
  const mixTabAvailable = salesMixIncludeManual || salesMixIncludePos
  const costCardEffectiveView = (costTabAvailable && mixTabAvailable) ? costCardView : (costTabAvailable ? 'cost' : 'mix')

  // ── IMS card content, extracted into variables so the same JSX composes into two different
  // shapes below: the full single-page layout when IMS is the only module, or a trimmed top-pill
  // row (card count matched to HR/POS) plus a full-width "details" section when 2+ modules share
  // the page. Gating/upsell logic per card is unchanged from before this split.
  const netPurchasesCard = (
    <div {...kpiCard(() => navigate('/purchases'))}>
      <div style={kpiLabelStyle}>Net Purchases</div>
      <div style={{ ...kpiValueStyle(18), color: 'var(--theme-accent-ink)' }}>
        {loading || (stats && !statsCurrent) ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : stats?.figuresFailed ? '—' : `NPR ${(stats?.purchaseTotal || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`}
      </div>
      <div style={kpiSubtextStyle}>{stats?.figuresFailed ? "Couldn't load — see the notice above" : <>After bill discounts &amp; returns · {periodLabel} →</>}</div>
      {/* Stock moved between the group's outlets is in this figure (S849, PNL-8), so it is named. */}
      {!loading && transfersLine && <div style={kpiSubtextStyle}>{transfersLine}</div>}
    </div>
  )

  // TWO CARDS ON THIS PAGE ARE CALLED "REVENUE" AND THEY ARE NOT THE SAME FIGURE (S734).
  //
  // This one sums `sales_entries` — which for a POS client ALREADY CONTAINS the POS rows, since
  // PosOrders stamps one per closed bill — at the ex-VAT, post-discount `unit_price`. The POS
  // section's own Revenue tile sums `pos_orders.paid_amount`, which is the final tendered amount
  // WITH VAT. So an IMS+POS client sees the same trade twice, roughly 13% apart, under one word,
  // in two columns of the same screen, with nothing anywhere saying which is which. Neither
  // figure is wrong and neither should change — every ratio on this page divides by the ex-VAT
  // base, and a till total that excluded VAT would not tie to the cash drawer. What was missing
  // is the sentence, so each card now names its own basis in its subtext.
  const revenueCard = canSales ? (
    <div {...kpiCard(() => navigate('/sales'))}>
      <div style={kpiLabelStyle}>
        <Tip text="Sales recorded for this period, before VAT and after discounts. For a POS client this already includes every bill the till closed — the POS section's own Revenue tile is the same trade counted WITH VAT, which is why the two figures differ by roughly the VAT rate." width={280}>Revenue</Tip>
      </div>
      <div style={{ ...kpiValueStyle(18), color: 'var(--theme-green-text)' }}>
        {loading || (stats && !statsCurrent) ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : stats?.figuresFailed ? '—' : `NPR ${(stats?.revenueTotal || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`}
      </div>
      <div style={kpiSubtextStyle}>Sales entries, excl. VAT →</div>
    </div>
  ) : null

  const foodCostCard = canSales ? (
    <div {...kpiCard(() => navigate(canVariance ? '/variance' : '/summary'))}>
      <div style={kpiLabelStyle}>
        {/* "Spend % so far", not "Food Cost %" (S792, owner decision D30). This tile divides what
            was BOUGHT by sales and never reads a count; Monthly Summary, the P&L and every closed
            month now call only what was USED Food Cost %, so one name carries one formula. The
            product-wide call this comment used to defer was made: the literal name won. */}
        <Tip text={SPEND_SO_FAR_TIP} width={280}>{SPEND_SO_FAR_LABEL}</Tip>
      </div>
      {/* Client-configured thresholds, not a fourth hardcoded copy of 35/45 — Settings offers
          fc_warning_pct/fc_critical_pct and this card is the headline they were added for. */}
      <div style={{ ...kpiValueStyle(22, 800), color: verdictFigure(fcPct, fcCardBand).color }} title={verdictFigure(fcPct, fcCardBand).title}>
        {loading || (stats && !statsCurrent) ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : verdictFigure(fcPct, fcCardBand).text}
      </div>
      <div style={kpiSubtextStyle}>
        {figs?.firstDay ? firstDayNote
          : stats?.figuresFailed ? "Couldn't load — see the notice above"
          : daysText
          ? `${daysText} · stock transfers included`
          : <><Tip text={`Coloured against your food cost target from Settings → Thresholds (watch above ${fcBands.warn}%, too high above ${fcBands.critical}%) as a guide: over a whole month what you buy is close to what you use, unless stock is building up or running down.`} width={260}>Food cost target ≤{fcBands.warn}%</Tip> →</>}
      </div>
    </div>
  ) : null

  const fixedCostsCard = canOverheads ? (
    <div {...kpiCard(() => navigate('/overheads'))}>
      <div style={kpiLabelStyle}>
        {/* The tip used to say "Target: under 60% combined" while the colours banded at 50 and
            65 — so a 58% read amber under a sentence calling it on target. The card states the
            ladder it actually paints (S734). */}
        <Tip text={`All fixed costs (rent, utilities, labor, tax & fees) as a % of revenue, over the days already finished. For the month in progress, rent and other fixed costs are counted for the days that have passed (the month's amount × days passed ÷ days in the month). With Crest HR, labour is the month's finalized payroll run or, until it is finalized, the HR wage estimate from your staff list and attendance sheet; the Overheads Labor tab is then not counted and is named under the figure. Without Crest HR, labour is what is typed on the Labor tab. Healthy up to ${FIXED_COST_WARN}%, worth watching to ${FIXED_COST_CRITICAL}%, too high above that. See the Overheads page for the full breakdown.`} width={300}>Fixed Costs % of Revenue</Tip>
      </div>
      {/* S849: fixed costs are counted for the finished days, so this ratio is no longer lumpy and
          keeps its band from day 2 (no settle guard). Withheld (grey, no mark) when labour may be
          missing or is not judged — a fenced login, a failed read, pay not set for some staff. */}
      <div style={{ ...kpiValueStyle(22, 800), color: verdictFigure(ohPct, ohCardBand, labourWithheld, false).color }} title={verdictFigure(ohPct, ohCardBand, labourWithheld, false).title}>
        {loading || (stats && !statsCurrent) ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : figs?.firstDay ? '—' : verdictFigure(ohPct, ohCardBand, labourWithheld, false).text}
      </div>
      <div style={kpiSubtextStyle}>
        {figs?.firstDay ? firstDayNote
          : stats?.figuresFailed ? "Couldn't load — see the notice above"
          : labour && labour.amount == null ? `Not shown — ${labourNotes.short}`
          : fixedCostTotal ? `${daysText ? `Fixed costs for ${daysText.replace(/^Days?/, m => m.toLowerCase())} · ` : ''}NPR ${fixedCostTotal.toLocaleString('en-IN', { maximumFractionDigits: 0 })} →`
          : 'No overhead data'}
      </div>
      {!loading && statsCurrent && labourLabel && (
        <div style={{ ...kpiSubtextStyle, color: labourWithheld ? 'var(--theme-amber-text)' : kpiSubtextStyle.color }}>{labourLabel}</div>
      )}
      {!loading && statsCurrent && labourNotes.long.map((line, i) => <div key={i} style={kpiSubtextStyle}>{line}</div>)}
    </div>
  ) : (
    // The tier is read from the feature catalog, not typed: this said "Pro" while Overheads has
    // always been sold on Growth (GROWTH_KEYS, and `minPlan="growth"` on its route), so a Starter
    // client was pointed at a plan two steps up for a feature one step up.
    <UpsellCard label="Fixed Costs & Net Margin" tier={tierLabel(FEATURE_TIER.overheads)} blurb="See true profit after rent, labor & tax" />
  )

  const netMarginCard = canOverheads ? (
    <div {...kpiCard(null)}>
      <div style={kpiLabelStyle}>
        <Tip text={`Revenue minus what you have SPENT on stock so far this month (net purchases — not food cost, which needs the month-end stock count to know what was used — with stock received from your other outlets added and stock sent to them taken off), labor, overheads and tax & fees${posOn ? ', and delivery-partner commission (Foodmandu, Pathao) on bills sold this month' : ''}, as a % of revenue, over the days already finished — what the business keeps. For the month in progress, rent and other fixed costs are counted for the days that have passed. Buying a month of stock in one go lowers it; cooking from last month's stock raises it. With Crest HR, labor is the finalized payroll run or, until it is finalized, the HR wage estimate; without it, the Overheads Labor tab — never both. The line under the figure says which one was used. Healthy Nepal F&B target: ≥20%.`} width={300}>Est. Net Margin %</Tip>
      </div>
      <div style={{ ...kpiValueStyle(22, 800), color: verdictFigure(netMarginPct, nmBand, marginWithhold).color }} title={verdictFigure(netMarginPct, nmBand, marginWithhold).title}>
        {loading || (stats && !statsCurrent) ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : figs?.firstDay ? '—' : verdictFigure(netMarginPct, nmBand, marginWithhold).text}
      </div>
      {/* Inherits Spend's lumpiness through the purchases, so it keeps the settle guard. */}
      <div style={kpiSubtextStyle}>
        {figs?.firstDay ? firstDayNote
          : stats?.figuresFailed ? "Couldn't load — see the notice above"
          : labour && labour.amount == null ? `Not shown — ${labourNotes.short}`
          : commission?.status === 'failed' ? 'Not shown — delivery commission could not be loaded'
          : fixedMissing ? `Not judged — no fixed costs entered for ${activePeriod ? BS_MONTHS[activePeriod.bs_month - 1] : 'this month'} yet · Overheads →`
          : labourWithheld && labour?.verdictWithheld ? `${labourNotJudgedText(labour)} · target ≥20%`
          : daysText ? `Fixed costs for ${daysText.replace(/^Days?/, m => m.toLowerCase())} · target ≥20%`
          : 'After stock bought & overheads · target ≥20%'}
      </div>
      {/* The labour source is named ON the tile, not only in a hover (S756, D22) — a screenshot of
          this card loses the Tip, and which wage figure a margin contains is what makes it true. */}
      {!loading && statsCurrent && labourLabel && (
        <div style={{ ...kpiSubtextStyle, color: labourWithheld ? 'var(--theme-amber-text)' : kpiSubtextStyle.color }}>{labourLabel}</div>
      )}
      {!loading && statsCurrent && commissionUnreadable && (
        <div style={{ ...kpiSubtextStyle, color: 'var(--theme-amber-text)' }}>Delivery commission not readable on this login · not judged</div>
      )}
      {!loading && statsCurrent && commission?.status === 'ok' && (commission.amount > 0 || commission.unsettledBills > 0) && (
        <div style={kpiSubtextStyle}>after delivery commission {npr(commission.amount)}{commission.unsettledBills > 0 ? ` · ${commission.unsettledBills} delivery bill${commission.unsettledBills === 1 ? '' : 's'} not settled yet` : ''}</div>
      )}
    </div>
  ) : null

  const activePeriodCard = (
    <div {...kpiCard(null)}>
      <div style={kpiLabelStyle}>Active Period</div>
      <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--theme-text1)' }}>{loading ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : periodLabel}</div>
      <div style={{ ...kpiSubtextStyle, color: activePeriod ? 'var(--theme-green-text)' : 'var(--theme-red-text)' }}>
        {activePeriod ? '● Open' : '● No open period'}
      </div>
    </div>
  )

  const itemsCard = (
    <div {...kpiCard(() => navigate('/items'))}>
      <div style={kpiLabelStyle}>Items in Master</div>
      <div style={kpiValueStyle(18)}>{loading ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : stats?.itemCount}</div>
      <div style={kpiSubtextStyle}>Active ingredients →</div>
    </div>
  )

  const vendorsCard = (
    <div {...kpiCard(() => navigate('/vendors'))}>
      <div style={kpiLabelStyle}>Vendors</div>
      <div style={kpiValueStyle(18)}>{loading ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : stats?.vendorCount}</div>
      <div style={kpiSubtextStyle}>Active suppliers →</div>
    </div>
  )

  const recipesCard = canRecipes ? (
    <div {...kpiCard(() => navigate('/recipes'))}>
      <div style={kpiLabelStyle}>Costed Recipes</div>
      <div style={kpiValueStyle(18)}>{loading ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : stats?.recipeCount}</div>
      <div style={kpiSubtextStyle}>
        {stats?.subRecipeCount > 0 ? `+ ${stats.subRecipeCount} sub-recipes →` : 'Active menu items →'}
      </div>
    </div>
  ) : (
    <UpsellCard label="Costed Recipes" tier="Growth" blurb="Cost every dish & protect margins" />
  )

  const menuHealthCard = canMenuReprice ? (
    <div {...kpiCard(() => navigate('/menu-repricing'))}>
      <div style={kpiLabelStyle}>
        <Tip text="Dishes whose current food-cost % is above their target — priced too low to hit the margin you set. Open the Menu Repricing report for the prices to charge." width={300}>Menu Health</Tip>
      </div>
      <div style={{ ...kpiValueStyle(18), color: stats?.underpricedCount > 0 ? 'var(--theme-red-text)' : 'var(--theme-green-text)' }}>
        {loading ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : `${stats?.underpricedCount || 0} of ${stats?.costedPricedCount || 0}`}
      </div>
      <div style={{ ...kpiSubtextStyle, color: stats?.menuOpportunityTotal > 0 ? 'var(--theme-accent-ink)' : 'var(--theme-text3)' }}>
        {loading ? 'under target →'
          : stats?.menuOpportunityTotal > 0
            ? `NPR ${Math.round(stats.menuOpportunityTotal).toLocaleString('en-IN')}/mo opportunity →`
            : 'dishes under target →'}
      </div>
    </div>
  ) : (
    <UpsellCard label="Menu Health" tier="Growth" blurb="Spot underpriced dishes & lost margin" />
  )

  const wastageCard = (
    <div {...kpiCard(() => navigate('/wastage-report'))}>
      <div style={kpiLabelStyle}>
        <Tip text="Everything logged as waste this period, valued at each item's rate: raw items, prep (sub-recipes) and hidden items alike — the same total as the Wastage Report." width={260}>Wastage Value</Tip>
      </div>
      <div style={{ ...kpiValueStyle(18), color: stats?.wastageValueTotal > 0 ? 'var(--theme-red-text)' : 'var(--theme-text1)' }}>
        {loading ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : `NPR ${Math.round(stats?.wastageValueTotal || 0).toLocaleString('en-IN')}`}
      </div>
      <div style={kpiSubtextStyle}>This period →</div>
    </div>
  )

  // ── HR/POS card content, extracted the same way as the IMS cards above (S558 dashboard density
  // fix) — one "headline" card per section, sized/positioned as the section's focal point but
  // (after reconsidering against real dashboard UX guidance — a dashboard's job is a 5-second
  // at-a-glance read of the business, and hiding numbers people check daily is the most common
  // way to break that) never hidden. Everything below still renders unconditionally; only the
  // headline card gets extra visual weight in the 2+ module layout.
  // A failed count read is not an empty queue (S734) — the hook reports it now, and a zero that
  // nobody computed must not render as one. `0 · 0 Leave · 0 OT …` is the most reassuring thing
  // this tile can say, and it was exactly what a refused or dropped read produced.
  const hrHeadlineCard = (
    <div {...kpiCard(() => navigate('/hr/dashboard'))}>
      <div style={kpiLabelStyle}>Pending Approvals</div>
      <div style={{ ...kpiValueStyle(22, 800), color: hrApprovals.error ? 'var(--theme-text2)' : hrApprovals.total > 0 ? 'var(--theme-amber-text)' : 'var(--theme-text1)' }}>
        {hrApprovals.loading ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : hrApprovals.error ? '—' : hrApprovals.total}
      </div>
      <div style={kpiSubtextStyle}>
        {hrApprovals.loading ? 'Loading…'
          : hrApprovals.error ? 'Count unavailable — open HR Dashboard →'
          : `${hrApprovals.leave} Leave · ${hrApprovals.ot} OT · ${hrApprovals.tada} TADA · ${hrApprovals.swap} Swap →`}
      </div>
    </div>
  )

  // Employee counts and payroll are supervisor-and-up figures (see loadHrStats).
  const hrSecondaryCards = !hasHrAccess('supervisor') ? null : (
    <>
      <div {...kpiCard(() => navigate('/hr/employees'))}>
        <div style={kpiLabelStyle}>Total Employees</div>
        <div style={{ ...kpiValueStyle(22, 800), color: 'var(--theme-text1)' }}>
          {!hrStats ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : hrStats.total}
        </div>
        <div style={kpiSubtextStyle}>All statuses →</div>
      </div>
      <div {...kpiCard(() => navigate('/hr/employees'))}>
        <div style={kpiLabelStyle}>Active</div>
        <div style={{ ...kpiValueStyle(22, 800), color: 'var(--theme-green-text)' }}>
          {!hrStats ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : hrStats.active}
        </div>
        {hrStats && hrStats.probation > 0 && (
          <div style={{ ...kpiSubtextStyle, color: 'var(--theme-accent-ink)' }}>{hrStats.probation} on probation</div>
        )}
      </div>
      <div {...kpiCard(null)}>
        <div style={kpiLabelStyle}>
          <Tip text="Sum of monthly basic salary for active and probation employees paid monthly (daily and hourly rates are left out). Full payroll with allowances, SSF and TDS is computed during payroll run." width={260}>Basic Payroll / Month</Tip>
        </div>
        <div style={{ ...kpiValueStyle(18, 800), color: 'var(--theme-accent-ink)' }}>
          {!hrStats
            ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} />
            : `NPR ${Math.round(hrStats.payroll).toLocaleString('en-IN')}`}
        </div>
        <div style={kpiSubtextStyle}>Basic salary only</div>
      </div>
    </>
  )

  // A tile whose own read failed with no last good figure to keep (S809 3n, REPORTS-8, homePosStats.js)
  // shows "—" and says so: a zero here would read as a quiet night or an empty pass.
  const posGone = read => readUnavailable(posStats, read)
  const posKitchenHeadlineCard = (
    <div {...kpiCard(() => navigate('/pos/kds'))}>
      <div style={kpiLabelStyle}>Open Tickets</div>
      <div style={{ ...kpiValueStyle(22, 800), ...(posGone('tickets') ? { color: 'var(--theme-text2)' } : null) }}>
        {!posStats ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : posGone('tickets') ? '—' : posStats.openNow}
      </div>
      <div style={kpiSubtextStyle}>
        {!posStats
          ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} />
          : posGone('tickets') ? <>Couldn&apos;t load — open the Kitchen Display →</>
          : <>New + In Progress →</>}
      </div>
    </div>
  )

  const posKitchenSecondaryCards = (
    <>
      <div {...kpiCard(() => navigate('/pos/kds'))}>
        <div style={kpiLabelStyle}>
          <Tip text="Open tickets sent more than 15 minutes ago — same threshold the ticket display itself flags." width={220}>Late</Tip>
        </div>
        <div style={{ ...kpiValueStyle(18), color: posGone('tickets') ? 'var(--theme-text2)' : posStats?.lateCount > 0 ? 'var(--theme-red-text)' : 'var(--theme-text1)' }}>
          {!posStats ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : posGone('tickets') ? '—' : posStats.lateCount}
        </div>
        <div style={kpiSubtextStyle}>{posGone('tickets') ? <>Couldn&apos;t load →</> : <>&gt; 15 min →</>}</div>
      </div>
      <div {...kpiCard(() => navigate('/pos/kds'))}>
        <div style={kpiLabelStyle}>Ready &amp; Waiting</div>
        <div style={{ ...kpiValueStyle(18), ...(posGone('tickets') ? { color: 'var(--theme-text2)' } : null) }}>
          {!posStats ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : posGone('tickets') ? '—' : posStats.readyWaiting}
        </div>
        <div style={kpiSubtextStyle}>{posGone('tickets') ? <>Couldn&apos;t load →</> : <>Last 20 min →</>}</div>
      </div>
      <div {...kpiCard(null)}>
        <div style={kpiLabelStyle}>
          <Tip text="Average minutes from Start to Ready for this station's tickets, and how many reached Ready, this service (from midnight, rolling over at 6 AM) — the Kitchen Display's own window, so a ticket sent just before midnight still counts after it." width={240}>Avg Prep Time</Tip>
        </div>
        <div style={kpiValueStyle(18)}>
          {!posStats
            ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} />
            : posStats.avgPrepMin != null ? `${posStats.avgPrepMin} min` : '—'}
        </div>
        <div style={kpiSubtextStyle}>
          {!posStats
            ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} />
            : posGone('tickets') ? <>Couldn&apos;t load</>
            : <>{posStats.completedToday} completed this service</>}
        </div>
      </div>
    </>
  )

  // See the note on `revenueCard` above: this is `pos_orders.paid_amount`, the amount actually
  // tendered, VAT included — the IMS Revenue tile beside it is the same trade before VAT.
  const posFrontHeadlineCard = (
    <div {...kpiCard(() => navigate('/pos/sales-report'))}>
      <div style={kpiLabelStyle}>
        <Tip text="Billed incl. VAT on this period's paid bills, less credit notes issued this period — the Sales Report's rule: a credited bill stays on the day it was sold; its note comes off the day it is issued. The Inventory section's Revenue tile counts the same sales before VAT, so the two will not match." width={280}>Revenue</Tip>
      </div>
      <div style={{ ...kpiValueStyle(22, 800), color: posGone('sales') ? 'var(--theme-text2)' : 'var(--theme-green-text)' }}>
        {!posStats ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : posGone('sales') ? '—' : `NPR ${Math.round(posStats.revenueTotal).toLocaleString('en-IN')}`}
      </div>
      <div style={kpiSubtextStyle}>{posGone('sales') ? <>Couldn&apos;t load — open the Sales Report →</> : <>{periodLabel} · billed, incl. VAT →</>}</div>
    </div>
  )

  const posFrontSecondaryCards = (
    <>
      <div {...kpiCard(() => navigate('/pos/covers-report'))}>
        <div style={kpiLabelStyle}>
          <Tip text="Guests seated at tables on paid bills closed this period: the Covers Report's count. Takeaway and delivery bills seat no guests, so they are not counted here; a bill later credit-noted still counts its guests." width={260}>Covers Served</Tip>
        </div>
        <div style={{ ...kpiValueStyle(18), ...(posGone('sales') ? { color: 'var(--theme-text2)' } : null) }}>
          {!posStats ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : posGone('sales') ? '—' : posStats.coversTotal}
        </div>
        <div style={kpiSubtextStyle}>
          {!posStats
            ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} />
            : posGone('sales') ? <>Couldn&apos;t load — open the Covers Report →</>
            : posStats.dineInBills != null ? <>{posStats.dineInBills} dine-in bill{posStats.dineInBills === 1 ? '' : 's'} →</>
            : <>{posStats.billCount} bill{posStats.billCount === 1 ? '' : 's'} →</>}
        </div>
      </div>
      <div {...kpiCard(null)}>
        <div style={kpiLabelStyle}>
          <Tip text="Revenue (after this period's credit notes) ÷ every paid bill closed this period, a credited one included." width={240}>Avg Check</Tip>
        </div>
        <div style={{ ...kpiValueStyle(18), ...(posGone('sales') ? { color: 'var(--theme-text2)' } : null) }}>
          {!posStats ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : posGone('sales') ? '—' : `NPR ${Math.round(posStats.avgCheck).toLocaleString('en-IN')}`}
        </div>
        <div style={kpiSubtextStyle}>{posGone('sales') ? <>Couldn&apos;t load</> : 'Revenue ÷ bills'}</div>
      </div>
      <div {...kpiCard(hasPosAccess('manager') ? () => navigate('/pos/tables') : null)}>
        <div style={kpiLabelStyle}>Tables Occupied</div>
        <div style={{ ...kpiValueStyle(18), color: posGone('tables') ? 'var(--theme-text2)' : posStats?.tablesOccupied > 0 ? 'var(--theme-accent-ink)' : 'var(--theme-text1)' }}>
          {!posStats ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : posGone('tables') ? '—' : `${posStats.tablesOccupied} / ${posStats.tablesTotal}`}
        </div>
        <div style={kpiSubtextStyle}>{posGone('tables') ? <>Couldn&apos;t load</> : hasPosAccess('manager') ? 'Right now →' : 'Right now'}</div>
      </div>
      {/* Tonight's bookings (S677) — what is still walking through the door, beside what has
          already been served. Amber only when public requests are waiting on a staff Accept:
          that is the one state here that is waiting on a person (posSignals.js). A cached
          posStats from before this tile existed lacks the fields, hence the `?? 0`. */}
      <div {...kpiCard(() => navigate('/pos/reservations'))}>
        <div style={kpiLabelStyle}>
          <Tip text="Bookings for tonight's service that are still expected or already seated, from the Reservations page. 'To come' is the guest count not yet seated — the covers the floor should be ready for on top of what is already served." width={280}>Bookings Tonight</Tip>
        </div>
        <div style={{ ...kpiValueStyle(18), color: posGone('bookings') ? 'var(--theme-text2)' : (posStats?.requestsPending ?? 0) > 0 ? 'var(--theme-amber-text)' : 'var(--theme-text1)' }}>
          {!posStats ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : posGone('bookings') ? '—' : (posStats.bookingsTonight ?? 0)}
        </div>
        <div style={kpiSubtextStyle}>
          {!posStats
            ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} />
            : posGone('bookings') ? <>Couldn&apos;t load — open Reservations →</>
            : (posStats.requestsPending ?? 0) > 0
              ? <>{posStats.requestsPending} request{posStats.requestsPending === 1 ? '' : 's'} to accept →</>
              : <>{posStats.coversToCome ?? 0} cover{(posStats.coversToCome ?? 0) === 1 ? '' : 's'} to come →</>}
        </div>
      </div>
    </>
  )

  // Charts + FC trend + Variance/Reorder — identical regardless of module count. Pre-S438 this
  // only ever rendered full-width; S438 added a showModuleHeaders-conditional squeeze (1-col
  // stack, bumped smallHeight) to cope with living inside a narrow weighted column. Now that
  // multi-module IMS content renders in its own full-width details section below the pill grid
  // (never squeezed into a column), that conditional no longer applies — this is unconditionally
  // full-width in both layouts.
  const imsChartsAndTables = !loading && activePeriod && (
    <>
      <div className="dash-spend-purchases-row dash-row">

        {/* Pie — Category Spend, and Bar — Top Items, combined behind a tab so Daily Purchases vs
            Sales (genuinely the more information-dense chart of the three, especially once the
            Target lines shipped) could take the reclaimed column instead of the row splitting
            evenly three ways — see .dash-spend-purchases-row in Layout.css for the width side. */}
        <ChartCard
          title={spendView === 'category' ? 'Spend by Category' : 'Top Items by Spend'}
          // 140 was the original single-purpose card's height — folding the tab row in on top of
          // that budget left only 114px for a 120px-diameter donut (38/60 inner/outer radius),
          // clipping it top and bottom. +32 buys back that room and then some, so the donut below
          // could also grow a little rather than just stop clipping.
          smallHeight={172}
          footer={<>
            <p className="sr-only">{categorySpendSummary}</p>
            <p className="sr-only">{topItemSpendSummary}</p>
          </>}
          renderChart={h => {
            const big = h > 200
            // 26px for the tab row itself, same figure regardless of card size — .tab-btn is a
            // fixed ~24px pill, not something that scales with `big` the way the rest of this
            // chart's chrome does.
            const contentH = h - 26
            const idBase = `spend-${big ? 'big' : 'small'}`
            const tabs = (
              <ChartTabs
                idBase={idBase} label="Spend breakdown views" active={spendView} onChange={setSpendView}
                tabs={[{ key: 'category', label: 'By Category' }, { key: 'items', label: 'Top Items' }]}
              />
            )
            // Every branch below returns <>{tabs}{panel(…)}</> so the tablist's aria-controls
            // always points at a real tabpanel wrapping the active view's content.
            const panel = kids => (
              <div role="tabpanel" id={`${idBase}-panel`} aria-labelledby={`${idBase}-tab-${spendView}`}>{kids}</div>
            )
            if (spendView === 'category') {
              if (categorySpend.length === 0) return (
                <>
                  {tabs}
                  {panel(
                    <div style={{ height: contentH, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <p style={{ color: 'var(--theme-text3)', fontSize: 12 }}>No purchase data</p>
                    </div>
                  )}
                </>
              )
              return (
                <>
                  {tabs}
                  {panel(<>
                  {big && (
                    <div className="chart-stat-strip" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
                      <StatPill label="Total spend" value={`NPR ${categorySpendTotal.toLocaleString('en-IN')}`} />
                      <StatPill label="Top category" value={`${categorySpend[0].name} (${((categorySpend[0].value / categorySpendTotal) * 100).toFixed(0)}%)`} color={CHART_COLORS[0]} />
                      <StatPill label="Categories" value={categorySpend.length} />
                    </div>
                  )}
                  <ResponsiveContainer width="100%" height={big ? contentH - 60 : contentH}>
                    <PieChart margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
                      <Pie
                        {...chartMotion()}
                        data={categorySpend} dataKey="value" nameKey="name"
                        cx="50%" cy="50%"
                        innerRadius={big ? 80 : 42} outerRadius={big ? 140 : 66}
                        paddingAngle={2}
                        {...(big ? {
                          label: ({ percent }) => `${(percent * 100).toFixed(0)}%`,
                          labelLine: { stroke: colors.text3, strokeWidth: 1 },
                        } : {})}
                      >
                        {categorySpend.map((entry, i) => <Cell key={entry.name} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                      </Pie>
                      <Tooltip
                        contentStyle={TOOLTIP_CHROME}
                        formatter={(v, name) => [`NPR ${Number(v).toLocaleString('en-IN')} (${((v / categorySpendTotal) * 100).toFixed(1)}%)`, name]}
                        labelFormatter={name => name}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px', marginTop: 8 }}>
                    {categorySpend.map((entry, i) => {
                      return (
                        <div key={entry.name} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <div style={{ width: 8, height: 8, borderRadius: 'var(--radius-full)', background: CHART_COLORS[i % CHART_COLORS.length], flexShrink: 0 }} />
                          <span style={{ fontSize: 11, color: 'var(--theme-text2)' }}>{entry.name}</span>
                          {big && <span style={{ fontSize: 11, color: 'var(--theme-text1)', fontWeight: 600 }}>NPR {entry.value.toLocaleString('en-IN')}</span>}
                          <span style={{ fontSize: 11, color: 'var(--theme-text2)' }}>{categorySpendTotal > 0 ? `${((entry.value / categorySpendTotal) * 100).toFixed(0)}%` : ''}</span>
                        </div>
                      )
                    })}
                  </div>
                  </>)}
                </>
              )
            }
            // spendView === 'items'
            const count = big ? topItemSpend.length : 6
            if (topItemSpend.length === 0) return (
              <>
                {tabs}
                {panel(
                  <div style={{ height: contentH, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <p style={{ color: 'var(--theme-text3)', fontSize: 12 }}>No purchase data</p>
                  </div>
                )}
              </>
            )
            const shown = topItemSpend.slice(0, count)
            const shownTotal = shown.reduce((s, r) => s + r.value, 0)
            const purchaseTotal = stats?.purchaseTotal || 0
            return (
              <>
                {tabs}
                {panel(<>
                {big && (
                  <div className="chart-stat-strip" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
                    <StatPill label={`Top ${shown.length} total`} value={`NPR ${shownTotal.toLocaleString('en-IN')}`} color={colors.accent} />
                    <StatPill label="Top item" value={shown[0].fullName || shown[0].name} color={CHART_COLORS[0]} />
                    {purchaseTotal > 0 && <StatPill label="Share of net purchases" value={`${((shownTotal / purchaseTotal) * 100).toFixed(0)}%`} />}
                  </div>
                )}
                <ResponsiveContainer width="100%" height={big ? contentH - 60 : contentH}>
                  <BarChart data={shown} layout="vertical" margin={{ top: 0, right: 8, bottom: 0, left: 0 }}>
                    <XAxis type="number" hide />
                    <YAxis type="category" dataKey="name" tick={{ fill: colors.text3, fontSize: big ? 11 : 9 }} tickLine={false} axisLine={false} width={big ? 130 : 90} />
                    <Tooltip
                      contentStyle={TOOLTIP_CHROME}
                      formatter={(v, n, p) => [`NPR ${Number(v).toLocaleString('en-IN')}${purchaseTotal > 0 ? ` (${((v / purchaseTotal) * 100).toFixed(1)}% of purchases)` : ''}`, p.payload.fullName || n]}
                      labelFormatter={() => ''}
                    />
                    <Bar dataKey="value" fill={colors.accent} radius={[0, 3, 3, 0]} barSize={big ? 18 : 10} {...chartMotion()}>
                      {shown.map((entry, i) => (
                        <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
                </>)}
              </>
            )
          }}
        />

        {/* Line — Daily Purchases vs Sales */}
        {/* minWidth:0 lets this grid column hold its 1/3 share — without it the inner
            scroll div's large minWidth forces the track wide and squeezes the other cards. */}
        <ChartCard
          title="Daily Purchases vs Sales"
          // Taller than ChartCard's 160 default because this is the one chart with a TWO-line
          // X-axis (day number over weekday initial). Recharts places tick text at
          // axisY + tickSize(6) + tickMargin(2) regardless of tickLine={false}, so the second
          // line's baseline sat at 162px inside a 160px SVG and the initials were clipped away by
          // the SVG edge — invisible, not merely tight. The axis band below is widened to 34 to
          // hold both lines, and this height is raised by the same amount so the plotted area
          // keeps (slightly more than) the room it had.
          smallHeight={184}
          // This card's modal carries more chrome than most ChartCard users — 6 legend chips, 6
          // stat pills, a 2-line X-axis (day + weekday) and a 2-line-wrapping footer — so the
          // default 440px chart plus all of that no longer fits inside a typical viewport without
          // scrolling to see the X-axis. Shrinking just this instance's plotted chart area (via
          // ChartCard's modalHeight prop, default 440 unchanged for every other chart) buys back
          // the room instead of shrinking the modal's own maxHeight, which would just move the
          // scroll requirement rather than remove it.
          modalHeight={340}
          cardStyle={{ minWidth: 0 }}
          legend={<>
            {/* A legend swatch must equal the series it labels, so these take the chart's own
                fixed hex rather than a theme token — the label text beside each carries the
                readable contrast. The live projections repeat their metric's hue and are told
                apart by the dashed glyph, exactly as the lines are. The frozen Target chips break
                from that: their own hue (see DAILY_TREND_COLORS) plus a dotted glyph, so three
                same-metric series never reduce to "dash pattern soup" at compact-card size. */}
            <span style={{ color: 'var(--theme-text2)' }}><span style={{ color: DAILY_TREND_COLORS.purchases }}>●</span> Purchases</span>
            {hasDailySales && <span style={{ color: 'var(--theme-text2)' }}><span style={{ color: DAILY_TREND_COLORS.sales }}>●</span> Sales</span>}
            {salesProjection && <span style={{ color: 'var(--theme-text2)' }}><span style={{ color: DAILY_TREND_COLORS.sales, letterSpacing: '-2px' }}>┄</span> Sales Proj.</span>}
            {purchProjection && <span style={{ color: 'var(--theme-text2)' }}><span style={{ color: DAILY_TREND_COLORS.purchases, letterSpacing: '-2px' }}>┄</span> Purch. Proj.</span>}
            {salesTarget && (
              <span style={{ color: 'var(--theme-text2)' }}>
                <span style={{ color: DAILY_TREND_COLORS.salesTarget, letterSpacing: '-2px' }}>⋯</span>{' '}
                <Tip text={`${salesTarget.source === 'history'
                  ? `What a usual day sells, from the 4 weeks before ${periodLabel} began.`
                  : `What a usual day sells, from this month's first ${salesTarget.sampleDays} days of sales (there weren't 4 weeks of daily sales before ${periodLabel} to learn from).`} Each weekday has its own figure, so a busy Saturday sits higher than a quiet Monday. Festival days in Holiday Calendar are left out of that usual week, and a festival with a Demand Multiplier sits at the usual day × that multiplier. It stays fixed for the rest of ${periodLabel}: compare your actual sales line against it to see whether you're ahead of or behind your usual trade. Sales Proj. is different: it updates every day. Hover any day: the tooltip shows how far that day ran off target, in green when it went your way. A grey ≈ means the day was close enough to count as on target.`}>Sales Target</Tip>
              </span>
            )}
            {purchTarget && (
              <span style={{ color: 'var(--theme-text2)' }}>
                <span style={{ color: DAILY_TREND_COLORS.purchTarget, letterSpacing: '-2px' }}>⋯</span>{' '}
                <Tip text={`${purchTarget.source === 'history'
                  ? `What you usually spend on each weekday, from the 4 weeks before ${periodLabel} began.`
                  : `What you usually spend on each weekday, from this month's first ${purchTarget.sampleDays} days (there weren't 4 weeks of purchases before ${periodLabel} to learn from).`} A weekday you bought nothing on counts as zero, so your usual restock day sits high and your quiet buying days sit low. Festival days in Holiday Calendar are left out of that usual week, and the purchase target is never scaled for a festival. It stays fixed for the rest of ${periodLabel}. Hover any day: here green means UNDER the target, because spending less than usual is the win. A grey ≈ means the day was close enough to count as on target.`}>Purch. Target</Tip>
              </span>
            )}
            {!hasDailySales && <span style={{ color: 'var(--theme-text3)' }}>Enter daily sales to see the sales trend</span>}
          </>}
          footer={<>
            {(salesProjection || purchProjection || salesTarget || purchTarget || forecastHistoryFailed || festivalsUnread) && (
              <div style={{ marginTop: 8, fontSize: 11, color: 'var(--theme-text2)', display: 'flex', flexWrap: 'wrap', gap: '4px 16px' }}>
                {/* S851: each figure is led by its line's own glyph and hue, as in the legend, and
                    the figure itself is plain text1. It was purple for sales and red for purchases:
                    neither is a line on this chart, and red reads as a warning (DESIGN.md, The One
                    Signal Meaning Rule). */}
                {salesProjection && (
                  <span>
                    <span style={{ color: DAILY_TREND_COLORS.sales, letterSpacing: '-2px' }}>┄</span>{' '}
                    Projected month-end revenue: <strong style={{ color: 'var(--theme-text1)' }}>NPR {salesProjectionView.projectedMonthEnd.toLocaleString('en-IN')}</strong>
                  </span>
                )}
                {purchProjection && (
                  <span>
                    <span style={{ color: DAILY_TREND_COLORS.purchases, letterSpacing: '-2px' }}>┄</span>{' '}
                    Projected month-end purchases: <strong style={{ color: 'var(--theme-text1)' }}>NPR {purchProjection.projectedMonthEnd.toLocaleString('en-IN')}</strong>
                  </span>
                )}
                {salesTarget && (
                  <span>
                    <span style={{ color: DAILY_TREND_COLORS.salesTarget, letterSpacing: '-2px' }}>⋯</span>{' '}
                    Sales target ({targetBasis(salesTarget)}): <strong style={{ color: 'var(--theme-text1)' }}>NPR {salesTargetMonthEnd.toLocaleString('en-IN')}</strong>
                  </span>
                )}
                {purchTarget && (
                  <span>
                    <span style={{ color: DAILY_TREND_COLORS.purchTarget, letterSpacing: '-2px' }}>⋯</span>{' '}
                    Purchase target ({targetBasis(purchTarget)}): <strong style={{ color: 'var(--theme-text1)' }}>NPR {purchTarget.projectedMonthEnd.toLocaleString('en-IN')}</strong>
                  </span>
                )}
                {/* S850: printed, not only hovered, so a screenshot keeps which days are festivals. */}
                {festivalDayNums.length > 0 && (
                  <span>
                    <Tip text={`Festival days come from Holiday Calendar. They are left out when working out a usual weekday, so a festival last month does not raise or lower this month's target. On a festival with a Demand Multiplier set, the sales target and sales forecast for that day are a usual day × that multiplier. A festival with none set is a usual day on the sales target. On the sales forecast it is a usual day until one of its days is over; from then on, the rest of that festival is forecast at the rate its finished days sold against a usual day (festival days back to back count as one festival). How a festival sells never changes the forecast for ordinary days. Purchases are never scaled on festivals: a kitchen often stocks up before one rather than buying less on it.`}>
                      Festival days
                    </Tip>: Day {dayRanges(festivalDayNums)}
                    {festivalsUnset > 0 && (
                      <span style={{ color: 'var(--theme-text3)' }}>
                        {' '}· {festivalsUnset} with no Demand Multiplier: usual days on the target, and the forecast follows how the days of each festival sell
                      </span>
                    )}
                  </span>
                )}
                {/* S851: printed, so a screenshot keeps why a festival's dashed line sits off the target. */}
                {festivalLearned.map(l => (
                  <span key={l.days[0]}>
                    Sales forecast for Day {dayRanges(l.days)}: {l.pct}% of a usual day, from how Day {dayRanges(l.from)} sold
                  </span>
                ))}
                {/* S851: said in words because the two lines are one line here, dotted over dashed. */}
                {(salesOnTarget || purchOnTarget) && (
                  <span style={{ color: 'var(--theme-text3)' }}>
                    <Tip text="The dashed forecast and the dotted target are the same line so far. The forecast starts from your usual week and moves away from it once a usual day this month (not a festival) is over and shows whether trade is running above or below usual.">
                      {salesOnTarget && purchOnTarget ? 'Both forecasts are' : salesOnTarget ? 'The sales forecast is' : 'The purchase forecast is'}
                    </Tip>{' '}on the target line so far
                  </span>
                )}
                {forecastHistoryFailed ? (
                  <span style={{ color: 'var(--theme-amber-text)' }}>
                    Past months or the holiday calendar could not be read, so the forecast uses this month only. A target will be set once they load.
                  </span>
                ) : festivalsUnread ? (
                  <span style={{ color: 'var(--theme-amber-text)' }}>
                    Past months or the holiday calendar could not be read, so festival days are drawn as usual days.
                  </span>
                ) : (salesProjection || purchProjection) && (
                  <span style={{ color: 'var(--theme-text3)' }}>
                    · {salesTarget || purchTarget ? "forecast = your usual weekday pattern, adjusted to this month's pace" : "forecast = this month's daily average"}
                    {/* S792 PLANNING-2: said in the footer, not only the tooltip, so a screenshot
                        keeps why today's point sits below its dashed line. S851: and which point it is. */}
                    {' '}(today so far is the hollow dot, and counts once the day is over)
                  </span>
                )}
              </div>
            )}
            {/* S784: the rain adjustment's own lines. Printed in the footer rather than only in a
                hover, so a screenshot or a print keeps which days were adjusted and by how much. */}
            {salesForecastInputs && (weatherFeature ? (weatherLocated ? (
              <div style={{ marginTop: 4, fontSize: 11, color: 'var(--theme-text2)', display: 'flex', flexWrap: 'wrap', gap: '4px 16px' }}>
                {rainForecastDays.length > 0 ? (
                  <span>
                    <Tip text={`On a day the weather forecast calls rainy (${RAIN_MM} mm or more between 5:45 am and 11:45 pm), that day's sales forecast is ${rainAdj.pct}% of a usual day: the figure set in Settings → Weather. Only days up to ${WEATHER_HORIZON_DAYS} days ahead are scaled, because a forecast further out is not reliable. A rainy day already gone this month is not counted as a slow day either, so the rest of the month's forecast can move a little too. Purchases and the dotted targets never change with the weather.`}>
                      Forecast allows for rain
                    </Tip>: Day {rainForecastDays.join(', ')} (sales × {rainAdj.pct}%)
                  </span>
                ) : rainPct == null ? (
                  isOwner && <span style={{ color: 'var(--theme-text3)' }}>Rain is not adjusting this forecast: set how rain affects your sales in Settings → Weather.</span>
                ) : rainAheadView && rainAheadView.rainy.length === 0 && rainAheadView.through >= 1 && (
                  <span style={{ color: 'var(--theme-text3)' }}>
                    No rain forecast in the next {rainAheadView.through} day{rainAheadView.through === 1 ? '' : 's'}.
                  </span>
                )}
                {measuredRain && (
                  <span style={{ color: 'var(--theme-text3)' }}>
                    <Tip text={`Worked out from your own sales: each day's sales against its weekday's usual, on rainy days against dry ones, over the 4 weeks before ${periodLabel} and this month so far. It needs ${MIN_MEASURE_DAYS} rainy and ${MIN_MEASURE_DAYS} dry days, and the weather is only recorded from the day this was switched on. It is shown to help you set your own figure; only your figure changes the forecast.`}>
                      Measured
                    </Tip>: {measuredRain.pct != null
                      ? `your rainy days sold about ${measuredRain.pct}% of a usual day (${measuredRain.rainyDays} rainy days)`
                      : measuredRain.rainyDays < MIN_MEASURE_DAYS
                        ? `not enough rainy days recorded yet (${measuredRain.rainyDays} of ${MIN_MEASURE_DAYS})`
                        : measuredRain.dryDays < MIN_MEASURE_DAYS
                          ? `not enough dry days recorded yet (${measuredRain.dryDays} of ${MIN_MEASURE_DAYS})`
                          : 'no dry-day sales to compare against yet'}
                  </span>
                )}
                {weather?.reason === 'not_configured' ? (
                  <span style={{ color: 'var(--theme-amber-text)' }}>
                    The weather service is not set up yet, so this forecast does not allow for rain.{isAdmin && ' Set the MET_USER_AGENT Edge Function secret.'}
                  </span>
                ) : (weatherError && !weather) || (weather && !weatherByAd && (weather.stale || weather.reason)) ? (
                  <span style={{ color: 'var(--theme-amber-text)' }}>The weather forecast could not be read, so this forecast does not allow for rain.</span>
                ) : weather?.stale && (
                  <span style={{ color: 'var(--theme-amber-text)' }}>The weather forecast is more than 12 hours old.</span>
                )}
                {weatherByAd && (
                  <span style={{ color: 'var(--theme-text3)' }}>
                    Weather: <a href="https://www.met.no/en" target="_blank" rel="noreferrer" style={weatherCreditLink}>MET Norway</a>
                    {' '}(<a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer" style={weatherCreditLink}>CC BY 4.0</a>)
                  </span>
                )}
              </div>
            ) : settingsLoadError ? (
              // A failed settings read has no city in it, which is not the same as no city set.
              <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--theme-amber-text)' }}>
                Your settings could not be read, so this forecast does not allow for rain.
              </p>
            ) : isOwner && (
              <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--theme-text3)' }}>
                Set your city in Settings → Weather to let rain adjust the sales forecast.
              </p>
            )) : isOwner && (
              <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--theme-text3)' }}>
                A forecast that allows for rain comes with the {tierLabel(FEATURE_TIER.weather_forecast)} plan.
              </p>
            ))}
            <p className="sr-only">{dailyTrendSummary}</p>
          </>}
          renderChart={h => {
            if (dailyTrend.length === 0) return (
              <div style={{ height: h, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <p style={{ color: 'var(--theme-text3)', fontSize: 12 }}>No purchase or sales data</p>
              </div>
            )
            const big = h > 200
            const chartData = big ? dailyTrendView : dailyTrendWindowed
            // Two-line X-axis tick: the BS day number, and below it the day-of-week initial —
            // needs activePeriod's bs_year/bs_month to convert each day to an AD date for
            // .getDay(). Recharts passes the RAW "Day N" axis value via payload.value to a custom
            // tick function (tickFormatter is not auto-applied — verified against the installed
            // recharts source), so the "Day " prefix is stripped here rather than via tickFormatter.
            const dayAxisTick = ({ x, y, payload }) => {
              const dayNum = parseInt(String(payload.value).replace('Day ', ''), 10)
              const dow = activePeriod ? WEEKDAY_INITIALS[bsToAd(activePeriod.bs_year, activePeriod.bs_month, dayNum).getDay()] : ''
              return (
                <g transform={`translate(${x},${y})`}>
                  <text x={0} y={0} dy={big ? 12 : 10} textAnchor="middle" fill={colors.text3} fontSize={big ? 11 : 9}>{dayNum}</text>
                  {/* colors.text1 (the theme's brightest text token, resolved per-preset — not a
                      literal #fff, which would go invisible on every light preset's white card)
                      rather than the dim text3 this used originally: reported as too hard to read
                      against text3's tertiary contrast, full opacity to match. */}
                  {dow && <text x={0} y={0} dy={big ? 24 : 20} textAnchor="middle" fill={colors.text1} fontSize={big ? 9 : 8}>{dow}</text>}
                </g>
              )
            }
            // The projection series carry a synthetic anchor point on the last actual day so the
            // dashed line connects (see the trend build) — but the actual series draws its own
            // activeDot at that exact coordinate, so without this the seam day rendered two
            // concentric white-ringed dots as a small bullseye. Suppress the projection's dot on
            // any day its actual is present; elsewhere reproduce the old config on Recharts' Dot.
            // Takes the projection's own dataKey and resolves the actual via PROJ_ACTUAL_KEY, the
            // same map the tooltip's suppression reads.
            // Today is the exception (S792): its actual is a part-day and its forecast a whole one,
            // two different points, so both dots show.
            const projActiveDot = projKey => props => {
              const actualKey = PROJ_ACTUAL_KEY[projKey]
              return props.payload?.[actualKey] != null && !props.payload?.inProgress
                ? null
                : <Dot {...props} r={big ? 4 : 3} fill={DAILY_TREND_COLORS[actualKey]} />
            }
            const chart = (
              <ResponsiveContainer width="100%" height={h}>
                <ComposedChart data={chartData} margin={{ top: big ? 8 : 4, right: big ? 16 : 8, bottom: big ? 4 : 0, left: big ? 8 : 0 }}>
                  {big && (
                    <defs>
                      <linearGradient id="dtPurchasesFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={DAILY_TREND_COLORS.purchases} stopOpacity={0.28} />
                        <stop offset="100%" stopColor={DAILY_TREND_COLORS.purchases} stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="dtSalesFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={DAILY_TREND_COLORS.sales} stopOpacity={0.28} />
                        <stop offset="100%" stopColor={DAILY_TREND_COLORS.sales} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                  )}
                  <CartesianGrid stroke={colors.border} strokeDasharray="3 3" vertical={false} />
                  {/* Small height must clear the tick's own 8px offset plus the second line's
                      dy=20 and its descender, or the weekday initial renders past the SVG's
                      bottom edge and is clipped (see smallHeight above). */}
                  <XAxis dataKey="day" tick={dayAxisTick} height={big ? 32 : 34} tickLine={false} axisLine={false} interval={0} />
                  <YAxis tick={{ fill: colors.text3, fontSize: big ? 11 : 9 }} tickLine={false} axisLine={false} tickFormatter={v => `${(v / 1000).toFixed(0)}k`} width={big ? 40 : 32} />
                  {/* See TrendTooltipContent at module scope for why this chart needs custom
                      content (anchor-day suppression, value-sorted rows, the target arrows). */}
                  <Tooltip content={<TrendTooltipContent big={big} />} />
                  {/* Paint order, bottom to top: the dashed forecasts, the dotted Targets, the actuals,
                      today's hollow dots. The Targets used to go first, under everything, and on a
                      month where the forecast equals the Target (no usual day over yet) the dashed
                      line covered the dotted one completely, so the Target looked like it stopped
                      (S851). Above the forecast both stay visible; the actuals stay on top. */}
                  {salesProjection && <Line type="monotone" dataKey="salesProj" name="Sales Projection" stroke={DAILY_TREND_COLORS.sales} strokeWidth={2} strokeDasharray="5 4" strokeOpacity={0.85} connectNulls dot={false} activeDot={projActiveDot('salesProj')} {...chartMotion()} />}
                  {purchProjection && <Line type="monotone" dataKey="purchProj" name="Purchases Projection" stroke={DAILY_TREND_COLORS.purchases} strokeWidth={2} strokeDasharray="5 4" strokeOpacity={0.85} connectNulls dot={false} activeDot={projActiveDot('purchProj')} {...chartMotion()} />}
                  {/* Frozen full-month reference lines — thin, dotted, and each in its own hue
                      (DAILY_TREND_COLORS.salesTarget/purchTarget) rather than reusing Purchases/Sales'
                      gold/green, so it doesn't collapse into a same-colour dash variant of the line
                      already sharing this metric's hue. Never moves once captured; see
                      dailyForecast.js for why that's the point. */}
                  {salesTarget && <Line type="monotone" dataKey="salesTarget" name="Sales Target" stroke={DAILY_TREND_COLORS.salesTarget} strokeWidth={1.5} strokeDasharray="2 3" strokeOpacity={0.75} connectNulls dot={false} {...chartMotion()} />}
                  {purchTarget && <Line type="monotone" dataKey="purchTarget" name="Purchases Target" stroke={DAILY_TREND_COLORS.purchTarget} strokeWidth={1.5} strokeDasharray="2 3" strokeOpacity={0.75} connectNulls dot={false} {...chartMotion()} />}
                  {big ? (
                    <Area type="monotone" dataKey="purchases" name="Purchases" stroke={DAILY_TREND_COLORS.purchases} strokeWidth={2.5} fill="url(#dtPurchasesFill)" connectNulls dot={{ r: 3, fill: DAILY_TREND_COLORS.purchases, strokeWidth: 0 }} activeDot={{ r: 5, fill: DAILY_TREND_COLORS.purchases }} {...chartMotion()} />
                  ) : (
                    <Line type="monotone" dataKey="purchases" name="Purchases" stroke={DAILY_TREND_COLORS.purchases} strokeWidth={2} connectNulls dot={{ r: 2, fill: DAILY_TREND_COLORS.purchases, strokeWidth: 0 }} activeDot={{ r: 4, fill: DAILY_TREND_COLORS.purchases }} {...chartMotion()} />
                  )}
                  {hasDailySales && (big ? (
                    <Area type="monotone" dataKey="sales" name="Sales" stroke={DAILY_TREND_COLORS.sales} strokeWidth={2.5} fill="url(#dtSalesFill)" connectNulls dot={{ r: 3, fill: DAILY_TREND_COLORS.sales, strokeWidth: 0 }} activeDot={{ r: 5, fill: DAILY_TREND_COLORS.sales }} {...chartMotion()} />
                  ) : (
                    <Line type="monotone" dataKey="sales" name="Sales" stroke={DAILY_TREND_COLORS.sales} strokeWidth={2} connectNulls dot={{ r: 2, fill: DAILY_TREND_COLORS.sales, strokeWidth: 0 }} activeDot={{ r: 4, fill: DAILY_TREND_COLORS.sales }} {...chartMotion()} />
                  ))}
                  {/* Today's sold-so-far (S851): a hollow dot in the metric's hue, filled with the card
                      so a line behind it does not show through, and joined to nothing. One point, so
                      the stroke draws no segment; it is the hue the tooltip's swatch reads. */}
                  <Line dataKey="purchToday" name="Purchases" stroke={DAILY_TREND_COLORS.purchases} legendType="none" dot={{ r: big ? 4 : 3, fill: colors.card, stroke: DAILY_TREND_COLORS.purchases, strokeWidth: 2 }} activeDot={{ r: big ? 5 : 4, fill: colors.card, stroke: DAILY_TREND_COLORS.purchases, strokeWidth: 2 }} {...chartMotion()} />
                  {hasDailySales && <Line dataKey="salesToday" name="Sales" stroke={DAILY_TREND_COLORS.sales} legendType="none" dot={{ r: big ? 4 : 3, fill: colors.card, stroke: DAILY_TREND_COLORS.sales, strokeWidth: 2 }} activeDot={{ r: big ? 5 : 4, fill: colors.card, stroke: DAILY_TREND_COLORS.sales, strokeWidth: 2 }} {...chartMotion()} />}
                </ComposedChart>
              </ResponsiveContainer>
            )
            return (
              <>
                {big && (
                  <div className="chart-stat-strip" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
                    <StatPill label="Purchases so far" value={`NPR ${dailyTrendPurchTotal.toLocaleString('en-IN')}`} color={DAILY_TREND_COLORS.purchases} />
                    {hasDailySales && <StatPill label="Sales so far" value={`NPR ${dailyTrendSalesTotal.toLocaleString('en-IN')}`} color={DAILY_TREND_COLORS.sales} />}
                    {salesProjectionView && <StatPill label="Projected sales" value={`NPR ${salesProjectionView.projectedMonthEnd.toLocaleString('en-IN')}`} color={DAILY_TREND_COLORS.sales} />}
                    {purchProjection && <StatPill label="Projected purchases" value={`NPR ${purchProjection.projectedMonthEnd.toLocaleString('en-IN')}`} color={DAILY_TREND_COLORS.purchases} />}
                    {salesTarget && <StatPill label="Sales target" value={`NPR ${salesTargetMonthEnd.toLocaleString('en-IN')}`} color={DAILY_TREND_COLORS.salesTarget} />}
                    {purchTarget && <StatPill label="Purchase target" value={`NPR ${purchTarget.projectedMonthEnd.toLocaleString('en-IN')}`} color={DAILY_TREND_COLORS.purchTarget} />}
                    <StatPill label="Period" value={periodLabel} />
                  </div>
                )}
                {big ? chart : (
                  <div style={{ overflowX: 'auto', overflowY: 'hidden' }}>
                    <div style={{ minWidth: Math.max(0, dailyTrendWindowed.length * 44), height: h }}>{chart}</div>
                  </div>
                )}
              </>
            )
          }}
        />

      </div>

      {/* ── FC% Trend + Cost Breakdown/Sales Mix, side by side ── */}
      {((fcTrend.length >= 2 && canSales) || costTabAvailable || mixTabAvailable) && (
        <div className="dash-row" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>

          {fcTrend.length >= 2 && canSales && (
            <ChartCard
              title="Food Cost % — Monthly Trend"
              footer={<>
                <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 11, flexWrap: 'wrap' }}>
                  <span style={{ color: 'var(--theme-green-text)' }}>● ≤{fcBands.warn}% Good</span>
                  <span style={{ color: 'var(--theme-amber-text)' }}>● {fcBands.warn}–{fcBands.critical}% Watch</span>
                  <span style={{ color: 'var(--theme-red-text)' }}>● &gt;{fcBands.critical}% High</span>
                  {!fcOpenTooEarly && fcOpenPoint && <span style={{ marginLeft: 'auto', color: 'var(--theme-text2)' }}>⊙ and dashed line = this month so far: {SPEND_SO_FAR_LABEL}</span>}
                </div>
                {/* Two bases on one line, said out loud (S792, D30): closed months are what was
                    USED ÷ sales, the running month what was SPENT, because it has no count yet. */}
                <div style={{ fontSize: 11, marginTop: 6, color: 'var(--theme-text2)' }}>
                  Closed months: {FOOD_COST_LABEL} — stock used ÷ sales, the figure Monthly Summary shows.
                  {fcOpenPoint ? ' This month: spend ÷ sales until its stock count closes it.' : ''}
                  {fcGreyCount > 0 ? ` A grey dot is a closed month whose stock count was incomplete: it reads high, so it is not judged and its line is faded${fcView.rows.some(r => r.lowFc != null) ? ', and the bar under it reaches as low as it could really be' : ''}.` : ''}
                </div>
                {/* A withheld month is stated, not silently dropped — otherwise the chart quietly
                    claims the current month has no figure at all. */}
                {fcOpenTooEarly && (
                  <div style={{ fontSize: 11, marginTop: 8, color: 'var(--theme-text2)' }}>
                    {fcOpenPoint.label} in progress — Day {dayOfPeriod} of {periodDays}. A part-month
                    usually buys stock for the whole month, so its ratio is arithmetic rather than a
                    signal; it joins the line from Day {SETTLE_DAY}.
                  </div>
                )}
                <p className="sr-only">{fcTrendSummary}</p>
              </>}
              renderChart={h => {
                const big = h > 200
                return (
                <div style={{ overflowX: 'auto', overflowY: 'hidden' }}>
                  {big && fcView.closedCount > 0 && (
                    <div className="chart-stat-strip" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
                      {fcAvg
                        ? <StatPill label={`Average · ${fcAvg.months} fully counted month${fcAvg.months === 1 ? '' : 's'}${fcAvg.leftOut ? ` · ${fcAvg.leftOut} left out` : ''}`} value={`${fcAvg.pct.toFixed(1)}%`} color={colors.text2} />
                        : <StatPill label="Average" value="No month fully counted yet" color={colors.text2} />}
                      {/* One counted month would be both Best and Highest (S826), so neither is named
                          until there are two to compare. */}
                      {fcView.best
                        ? <>
                            <StatPill label="Best month" value={`${fcView.best.label} (${fcView.best.fc}%)`} color={colors.greenText} textColor={colors.greenText} />
                            <StatPill label="Highest month" value={`${fcView.highest.label} (${fcView.highest.fc}%)`} color={colors.redText} textColor={colors.redText} />
                          </>
                        : <StatPill label="Best / Highest month" value={`After ${MIN_COMPARED_MONTHS} fully counted months`} />}
                      {fcView.above && (
                        <StatPill
                          label={<Tip text={`What the fully counted months' stock really cost, minus what it would have cost at exactly your Good line (${fcBands.warn}% of their sales, set in Settings → Thresholds). Each point of Food Cost % is 1% of a month's sales. Months whose count was incomplete are left out, because they read high.`}>{fcView.above.npr >= 0 ? 'Above' : 'Under'} the {fcBands.warn}% line · {fcView.above.months} month{fcView.above.months === 1 ? '' : 's'}</Tip>}
                          value={npr(Math.abs(fcView.above.npr))}
                          color={colors.greenText}
                        />
                      )}
                      {fcView.pointValue != null && (
                        <StatPill
                          label={<Tip text="1% of an average closed month's sales: what each point of Food Cost % costs or saves you in a month. Every closed month counts here, even one with an incomplete count, because a missing count does not change sales.">1 point of food cost</Tip>}
                          value={`≈ ${npr(fcView.pointValue)} a month`}
                        />
                      )}
                    </div>
                  )}
                  <div style={{ minWidth: Math.max(0, fcChartData.length * 64), height: big ? h - 60 : h }}>
                    <ResponsiveContainer width="100%" height={big ? h - 60 : h}>
                      <LineChart data={fcView.rows} margin={{ top: 8, right: 48, bottom: 0, left: 0 }}>
                        <CartesianGrid stroke={colors.border} strokeDasharray="3 3" vertical={false} />
                        <XAxis dataKey="label" tick={{ fill: colors.text3, fontSize: 10 }} tickLine={false} axisLine={false} interval={0} />
                        <YAxis tick={{ fill: colors.text3, fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={v => `${v}%`} domain={['auto', 'auto']} width={36} />
                        {/* extendDomain (S826): with every month above 42%, the auto domain left the
                            Good line off the chart and Recharts dropped it without a word, so the one
                            line saying where "good" is never showed on the chart that needed it. */}
                        <ReferenceLine y={fcBands.warn} ifOverflow="extendDomain" stroke={colors.greenText} strokeDasharray="4 3" strokeOpacity={0.5} label={{ value: `${fcBands.warn}%`, fill: colors.greenText, fontSize: 9, position: 'right' }} />
                        <ReferenceLine y={fcBands.critical} ifOverflow="extendDomain" stroke={colors.redText} strokeDasharray="4 3" strokeOpacity={0.5} label={{ value: `${fcBands.critical}%`, fill: colors.redText, fontSize: 9, position: 'right' }} />
                        {big && fcAvg && <ReferenceLine y={fcAvg.pct} stroke={colors.text2} strokeDasharray="2 3" strokeOpacity={0.85} label={{ value: `avg ${fcAvg.pct.toFixed(1)}%`, fill: colors.text2, fontSize: 9, position: 'insideBottomRight' }} />}
                        <Tooltip content={<FcTrendTooltipContent big={big} bander={fcCardBand} warn={fcBands.warn} />} />
                        {/* The line in three pieces (S826, fcTrendMath.js): faint wherever it touches
                            a grey month, solid between fully counted months, dashed into the open
                            month, which is a different measure. Linear, not monotone: the pieces
                            are separate series, and three curves fitted through different point
                            sets would not meet where they overlap. */}
                        <Line type="linear" dataKey="faded" stroke={colors.accentInk} strokeWidth={2} strokeOpacity={0.35} dot={false} activeDot={false} connectNulls={false} {...chartMotion()} />
                        <Line type="linear" dataKey="solid" stroke={colors.accentInk} strokeWidth={2} dot={false} activeDot={false} connectNulls={false} {...chartMotion()} />
                        <Line type="linear" dataKey="bridge" stroke={colors.accentInk} strokeWidth={2} strokeDasharray="5 4" strokeOpacity={0.8} dot={false} activeDot={false} connectNulls={false} {...chartMotion()} />
                        {/* Markers only: no stroke of its own, the dots, and each grey month's range
                            down to its lowest possible figure. */}
                        <Line type="linear" dataKey="fc" stroke="none" {...chartMotion()}
                          dot={(props) => {
                            const { cx, cy, payload } = props
                            // An unfinished month wears no verdict colour — same rule as the KPI
                            // card above, which greys out rather than painting a part-month red.
                            // Neither does a closed month whose count was incomplete (D6, S792).
                            const col = payload.open || payload.unjudged ? colors.text2 : fcDotColor(payload.fc)
                            return <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={payload.open ? 5 : 4} fill={col} stroke={payload.open ? colors.text1 : 'none'} strokeWidth={1.5} />
                          }}
                          activeDot={{ r: 6, fill: colors.accentInk }}
                        >
                          <ErrorBar dataKey="range" direction="y" width={6} strokeWidth={1.5} stroke={colors.text2} {...chartMotion()} />
                        </Line>
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>
                )
              }}
            />
          )}

          {/* Pie — Revenue vs Cost Breakdown, tabbed with Sales Mix (S557 — see the note above
              costTabAvailable/mixTabAvailable). Cost Breakdown stays gated on canOverheads (Growth) since
              overheads, the biggest lever in the split, are a Growth figure — same gate as the
              Est. Net Margin % KPI card that view is a composition of; Sales Mix has no tier gate,
              only a data-source one, matching what FoodBeverageSplit.jsx always did. */}
          {(costTabAvailable || mixTabAvailable) && (
            <ChartCard
              title={costCardEffectiveView === 'cost' ? 'Revenue vs Cost Breakdown' : 'Sales Mix'}
              // 140 was each single-purpose card's own height; +32 buys back the tab row's ~26px
              // the same way the Spend by Category / Top Items merge did — only when both tabs
              // actually exist, so a client with just one view keeps that view's original height.
              smallHeight={costTabAvailable && mixTabAvailable ? 172 : 140}
              footer={costCardEffectiveView === 'cost' ? (
                <>
                  <div style={{ fontSize: 11, marginTop: 8, color: netMarginPct == null || marginWithheld ? 'var(--theme-text2)' : netMarginPct >= 0 ? 'var(--theme-green-text)' : 'var(--theme-red-text)' }}>
                    Net margin: {netMarginPct != null ? `${netMarginPct.toFixed(1)}%` : '—'}
                    {netMarginPct != null && netMarginPct < 0 && ' — costs exceeded revenue this period'}
                  </div>
                  {periodTooEarly && netMarginPct != null && (
                    <div style={{ fontSize: 11, marginTop: 4, color: 'var(--theme-text3)' }}>
                      Day {dayOfPeriod} of {periodDays} · too early in the month to judge; judged from day {SETTLE_DAY}
                    </div>
                  )}
                  {daysText && (
                    <div style={{ fontSize: 11, marginTop: 4, color: 'var(--theme-text3)' }}>
                      {daysText} · fixed costs counted for those days
                    </div>
                  )}
                  {/* Percentages below the slices are a share of whatever the pie actually contains,
                      which flips with the sign of the margin — say which, rather than leaving a bare
                      "23.4%" to be read against the wrong denominator. */}
                  <div style={{ fontSize: 11, marginTop: 4, color: 'var(--theme-text3)' }}>
                    {netMarginPct != null && netMarginPct > 0 ? '% of revenue' : '% of total cost'} · {labour?.source === 'payroll' ? 'labor from finalized payroll, the rest from Overheads' : labour?.source === 'estimate' ? 'labor is the HR wage estimate, the rest from Overheads' : 'from Overheads page buckets'}
                  </div>
                  {labourNote && (
                    <div style={{ fontSize: 11, marginTop: 4, color: labourNoteIsWarning ? 'var(--theme-amber-text)' : 'var(--theme-text2)' }}>
                      {labourNote}
                    </div>
                  )}
                  <p className="sr-only">{costBreakdownSummary}</p>
                </>
              ) : (
                <p className="sr-only">{salesMixSummary}</p>
              )}
              renderChart={h => {
                const big = h > 200
                const showTabs = costTabAvailable && mixTabAvailable
                const contentH = showTabs ? h - 26 : h
                const idBase = `costmix-${big ? 'big' : 'small'}`
                const tabs = showTabs && (
                  <ChartTabs
                    idBase={idBase} label="Revenue breakdown views" active={costCardView} onChange={setCostCardView}
                    tabs={[{ key: 'cost', label: 'Cost Breakdown' }, { key: 'mix', label: 'Sales Mix' }]}
                  />
                )
                // A tabpanel only exists when the tablist does — with one available view there
                // are no tabs, and the content renders unwrapped.
                const panel = kids => showTabs
                  ? <div role="tabpanel" id={`${idBase}-panel`} aria-labelledby={`${idBase}-tab-${costCardView}`}>{kids}</div>
                  : kids

                if (costCardEffectiveView === 'cost') {
                  if (costBreakdown.length === 0) return (
                    <>
                      {tabs}
                      {panel(
                        <div style={{ height: contentH, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <p style={{ color: 'var(--theme-text3)', fontSize: 12 }}>No cost data</p>
                        </div>
                      )}
                    </>
                  )
                  return (
                    <>
                      {tabs}
                      {panel(<>
                      {big && (
                        <div className="chart-stat-strip" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
                          {/* The pie is over the finished days (S849), so its revenue is too. */}
                          <StatPill label={daysText ? 'Revenue, finished days' : 'Revenue'} value={`NPR ${(stats?.revenueCounted ?? stats?.revenueTotal ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`} />
                          {/* Matches the Food Cost slice, not colors.accent — on a preset where accent
                              isn't gold the pill would otherwise disagree with the slice it summarizes. */}
                          {/* The tile's figure, so the tile's name (S792, D30): purchases ÷ sales. */}
                          {fcPct != null && <StatPill label={SPEND_SO_FAR_LABEL} value={`${fcPct.toFixed(1)}%`} color={COST_BREAKDOWN_COLORS['Food Cost']} />}
                          {/* No verdict dot while the margin is withheld (labour missing, or before SETTLE_DAY), matching the footer and the tile. */}
                          <StatPill label="Net margin" value={netMarginPct != null ? `${netMarginPct.toFixed(1)}%` : '—'} color={netMarginPct == null || marginWithheld ? undefined : netMarginPct >= 0 ? colors.green : colors.red} />
                        </div>
                      )}
                      <ResponsiveContainer width="100%" height={big ? contentH - 60 : contentH}>
                        <PieChart margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
                          <Pie
                            {...chartMotion()}
                            data={costBreakdown} dataKey="value" nameKey="name"
                            cx="50%" cy="50%"
                            innerRadius={big ? 80 : 38} outerRadius={big ? 140 : 60}
                            paddingAngle={2}
                            // Percent-on-slice labels only in the expanded view — at dashboard-tile
                            // size (h ≤ 200) the label lines would overlap the small donut, so the
                            // legend below (which carries NPR + %) is the only detail there.
                            {...(big ? {
                              label: ({ percent }) => `${(percent * 100).toFixed(0)}%`,
                              labelLine: { stroke: colors.text3, strokeWidth: 1 },
                            } : {})}
                          >
                            {costBreakdown.map(entry => <Cell key={entry.name} fill={costSliceFill(entry.name)} />)}
                          </Pie>
                          <Tooltip
                            contentStyle={TOOLTIP_CHROME}
                            formatter={(v, name) => [`NPR ${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 0 })} (${(v / costBreakdownTotal * 100).toFixed(1)}%)`, name]}
                          />
                        </PieChart>
                      </ResponsiveContainer>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 16px', marginTop: 8 }}>
                        {costBreakdown.map(entry => (
                          <div key={entry.name} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <div style={{ width: 8, height: 8, borderRadius: 'var(--radius-full)', background: costSliceFill(entry.name), flexShrink: 0 }} />
                            <span style={{ fontSize: 11, color: 'var(--theme-text2)' }}>
                              {entry.name} <span style={{ color: 'var(--theme-text1)', fontWeight: 600 }}>NPR {entry.value.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</span>
                              {' '}<span style={{ color: 'var(--theme-text3)' }}>({(entry.value / costBreakdownTotal * 100).toFixed(1)}%)</span>
                            </span>
                          </div>
                        ))}
                      </div>
                      </>)}
                    </>
                  )
                }

                // costCardEffectiveView === 'mix'
                if (salesMixLoading) return (
                  <>
                    {tabs}
                    {panel(
                      <span className="skeleton" style={{ display: 'inline-block', width: '100%', height: '4em' }} />
                    )}
                  </>
                )
                if (salesMixTotal <= 0) return (
                  <>
                    {tabs}
                    {panel(
                      <div style={{ height: contentH, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <p style={{ color: 'var(--theme-text3)', fontSize: 12 }}>No sales data</p>
                      </div>
                    )}
                  </>
                )
                const mixPieData = salesMixCategories.map(c => ({ name: c, value: salesMixBuckets[c] }))
                return (
                  <>
                    {tabs}
                    {panel(<>
                    {big && (
                      <div className="chart-stat-strip" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
                        <StatPill label="Total revenue" value={`NPR ${Math.round(salesMixTotal).toLocaleString('en-IN')}`} />
                        <StatPill label="Top category" value={`${salesMixCategories[0]} (${((salesMixBuckets[salesMixCategories[0]] / salesMixTotal) * 100).toFixed(0)}%)`} color={salesMixColorOf(salesMixCategories[0])} />
                        <StatPill label="Categories" value={salesMixCategories.length} />
                      </div>
                    )}
                    <ResponsiveContainer width="100%" height={big ? contentH - 60 : contentH}>
                      <PieChart margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
                        <Pie
                          {...chartMotion()}
                          data={mixPieData} dataKey="value" nameKey="name"
                          cx="50%" cy="50%"
                          innerRadius={big ? 80 : 38} outerRadius={big ? 140 : 60}
                          paddingAngle={2}
                          {...(big ? {
                            label: ({ percent }) => `${(percent * 100).toFixed(0)}%`,
                            labelLine: { stroke: colors.text3, strokeWidth: 1 },
                          } : {})}
                        >
                          {mixPieData.map(entry => <Cell key={entry.name} fill={salesMixColorOf(entry.name)} />)}
                        </Pie>
                        <Tooltip
                          contentStyle={TOOLTIP_CHROME}
                          formatter={(v, name) => [`NPR ${Math.round(v).toLocaleString('en-IN')} (${((v / salesMixTotal) * 100).toFixed(1)}%)`, name]}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
                      {salesMixCategories.map(cat => {
                        const amount = salesMixBuckets[cat]
                        const pct = (amount / salesMixTotal) * 100
                        return (
                          <div key={cat} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12 }}>
                            <span style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--theme-text1)' }}>
                              <span style={{ width: 8, height: 8, borderRadius: 0, background: salesMixColorOf(cat), flexShrink: 0 }} />
                              {cat}
                            </span>
                            <span style={{ color: 'var(--theme-text2)' }}>NPR {Math.round(amount).toLocaleString('en-IN')} · {pct.toFixed(0)}%</span>
                          </div>
                        )
                      })}
                    </div>
                    </>)}
                  </>
                )
              }}
            />
          )}
        </div>
      )}

      {/* ── Bottom: Variance + Reorder side by side ── */}
      {<div className="dash-row" style={{ display: 'grid', gridTemplateColumns: canReorder ? 'repeat(auto-fit, minmax(320px, 1fr))' : '1fr', gap: 16 }}>

        {/* Variance table */}
        {canVariance ? (
          <div className="card card--compact">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <h3 style={{ fontSize: 12, fontWeight: 600, margin: 0, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Top Variance Items</h3>
              <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => navigate('/variance')}>Full Report →</button>
            </div>
            {topVariance.length === 0 ? (
              <p style={{ color: 'var(--theme-text3)', fontSize: 12, margin: '16px 0' }}>
                Complete stock count + add sales to see variance.
              </p>
            ) : (
              <div className="table-wrap">
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr>
                    <th scope="col" style={{ color: 'var(--theme-text2)', fontWeight: 500, textAlign: 'left', paddingBottom: 8, borderBottom: '1px solid var(--theme-border)' }}>Item</th>
                    <th scope="col" style={{ color: 'var(--theme-text2)', fontWeight: 500, textAlign: 'right', paddingBottom: 8, borderBottom: '1px solid var(--theme-border)' }}>
                      <Tip text="Qty used above what recipes predict — indicates waste, theft, or over-portioning.">Over-used</Tip>
                    </th>
                    <th scope="col" style={{ color: 'var(--theme-text2)', fontWeight: 500, textAlign: 'right', paddingBottom: 8, borderBottom: '1px solid var(--theme-border)' }}>
                      <Tip text="Over-used qty × item rate. The NPR cost of unaccounted usage this period." width={200}>Value at Risk</Tip>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {topVariance.map((row, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid var(--theme-bg)' }}>
                      <td style={{ padding: '4px 0', fontWeight: 600, color: 'var(--theme-text1)' }}>{row.name}</td>
                      <td style={{ padding: '4px 0', textAlign: 'right', color: 'var(--theme-red-text)' }}>+{Number(row.variance.toFixed(1)).toLocaleString('en-IN')} {row.uom}</td>
                      <td style={{ padding: '4px 0', textAlign: 'right', fontWeight: 700, color: 'var(--theme-red-text)' }}>NPR {Number(row.value.toFixed(0)).toLocaleString('en-IN')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )}
          </div>
        ) : (
          <UpsellCard label="Variance & Shrinkage" tier="Growth" blurb="Catch waste, theft & over-portioning" />
        )}

        {/* Reorder panel */}
        {canReorder ? (
          <div className="card card--compact">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <h3 style={{ fontSize: 12, fontWeight: 600, margin: 0, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Items to Reorder</h3>
              <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => navigate('/reorder')}>Full Report →</button>
            </div>
            {reorderItems.length === 0 ? (
              <p style={{ color: 'var(--theme-text3)', fontSize: 12, margin: '16px 0' }}>
                No items below par.{' '}
                <button
                  onClick={() => navigate('/reorder')} className="interactive-card"
                  style={{ background: 'none', border: 'none', padding: '4px 6px', margin: '-4px -6px', font: 'inherit', color: 'var(--theme-accent-ink)', cursor: 'pointer' }}
                >Set par levels →</button>
              </p>
            ) : (
              <div>
                {reorderItems.map((item, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0', borderBottom: i < reorderItems.length - 1 ? '1px solid var(--theme-bg)' : 'none' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--theme-text1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.name}</div>
                      <div style={{ fontSize: 11, color: 'var(--theme-text2)' }}>Stock: {item.currentStock} · Par: {item.par} {item.uom}</div>
                    </div>
                    <div style={{ textAlign: 'right', marginLeft: 12, flexShrink: 0 }}>
                      <div style={{ fontSize: 11, color: 'var(--theme-red-text)', fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4 }}><ArrowDown size={11} aria-hidden="true" /> {item.shortfall} {item.uom}</div>
                      <div style={{ fontSize: 11, color: 'var(--theme-text3)' }}>NPR {item.estValue.toLocaleString('en-IN')}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : null}
      </div>}
    </>
  )

  // The Inventory Dashboard is IMS's own page, so a login without IMS goes Home rather than
  // seeing an empty IMS page. After every hook; ProtectedRoute has already resolved the profile.
  if (imsScope && !showIms) return <Navigate to="/dashboard" replace />

  return (
    <div>
      {/* Screen-reader-only announcement — the visible loading state is a shimmering skeleton
          per KPI, which on its own gives no indication to a screen reader that the page is still
          loading, or when it's finished. */}
      <div role="status" aria-live="polite" className="sr-only">
        {loading ? 'Loading dashboard data…' : 'Dashboard data loaded'}
      </div>
      {/* ── Header ── */}
      {/* S785: the weather sits on the right, so the header becomes a split one only when there
          is something to put there — a title-only header takes .page-header alone. S786: the slot
          is shared with the HR Dashboard, and with no city it offers "Set your city" to a login
          that may set one, in any module. */}
      <div className={weatherStrip.visible ? 'page-header page-header--split' : 'page-header'}>
        <div>
          <h1 className="page-title">{dashTitle}</h1>
          <p className="page-subtitle">
            {isAdmin ? (adminViewClientName || '— Select a property from the sidebar —') : (profile?.clients?.name || '')}
            {activePeriod && ` · ${periodLabel} · Open`}
          </p>
        </div>
        <WeatherHeaderSlot strip={weatherStrip} rainTagByAd={rainTagByAd} />
      </div>

      {/* A load failure used to be indistinguishable from "this client genuinely has no data" —
          every section here silently discarded Supabase's error field. Each section sets its own
          key in loadErrors and clears it on a successful (re)load, so a real fetch failure now
          shows a dismissible, retry-able banner instead of a wrong-looking zero. */}
      {Object.entries(loadErrors).filter(([, msg]) => msg).map(([section, msg]) => (
        // role="alert" so a screen-reader user hears the failure when the banner appears —
        // this page's loading region already announces politely; a fetch failure should not
        // be the one async state that stays silent (dashboard critique P2, S569).
        <div key={section} role="alert" className="card dash-row" style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16,
          borderColor: 'color-mix(in srgb, var(--theme-red) 25%, transparent)',
          background: 'color-mix(in srgb, var(--theme-red) 8%, transparent)',
        }}>
          <p style={{ color: 'var(--theme-red-text)', margin: 0, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
            <TriangleAlert size={14} aria-hidden="true" /> {msg}
          </p>
          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => retryLoad(section)}>Retry</button>
            <button
              className="btn btn-ghost" style={{ fontSize: 12 }}
              onClick={() => setLoadErrors(prev => ({ ...prev, [section]: '' }))} aria-label="Dismiss"
            >×</button>
          </div>
        </div>
      ))}

      {/* Home's, not the Inventory Dashboard's: a renewal reminder on every dashboard is a nag. */}
      {!isAdmin && !imsScope && (() => {
        const s = getSubStatus(profile?.clients)
        if (!s.label || s.days === null || s.days > 7) return null
        const isExpired = s.days < 0
        return (
          <div className="card dash-row" role="status" aria-live="polite" style={{ borderColor: s.border, background: s.bg }}>
            <p style={{ color: s.color, margin: 0, fontSize: 14, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
              <TriangleAlert size={16} aria-hidden="true" />
              {isExpired ? 'Your subscription has expired' : `Your ${s.label.startsWith('Trial') ? 'trial' : 'subscription'} expires in ${s.days} day${s.days !== 1 ? 's' : ''}`}
            </p>
            <p style={{ color: 'var(--theme-text2)', margin: '4px 0 0', fontSize: 12 }}>
              Contact your consultant to renew and keep your data accessible.
            </p>
          </div>
        )
      })()}

      {/* Only Crest opens a month from nothing ('+ New Period' is admin-only, S790), so the old
          "Click here to create one in Periods →" sent every client to a page where they could not. */}
      {showIms && !activePeriod && !loading && (isAdmin ? (
        <div
          className="card interactive-card dash-row" style={{ cursor: 'pointer', borderColor: 'color-mix(in srgb, var(--theme-accent) 30%, transparent)' }}
          onClick={() => navigate('/periods')} role="button" tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate('/periods') } }}
        >
          <p style={{ color: 'var(--theme-accent-ink)', margin: 0, fontSize: 14, display: 'flex', alignItems: 'center', gap: 6 }}><TriangleAlert size={15} aria-hidden="true" /> No open period. Click here to create one in Periods →</p>
        </div>
      ) : (
        <div className="card dash-row" role="status" style={{ borderColor: 'color-mix(in srgb, var(--theme-accent) 30%, transparent)' }}>
          <p style={{ color: 'var(--theme-text1)', margin: 0, fontSize: 14, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
            <TriangleAlert size={15} aria-hidden="true" /> No month is open yet
          </p>
          <p style={{ color: 'var(--theme-text2)', margin: '4px 0 0', fontSize: 13 }}>
            Crest opens your first month for you, and each next month opens when you close the one before. Contact us and we'll open it: <SupportContactLine variant="inline" />
          </p>
        </div>
      ))}

      {/* First run: the setup guide (S790). It decides for itself whether to render — a new
          client's Owner or email-login manager, in its first weeks, for whichever modules the client
          has — so it sits here unconditionally, including for POS-only and HR-only clients, which
          GettingStartedCard (gated on showIms) never reached. Rules: src/shared/onboarding/. */}
      {!imsScope && <SetupGuideCard surface="dashboard" />}

      {periodExpired && !loading && (
        <div className="card dash-row" style={{ borderColor: 'color-mix(in srgb, var(--theme-amber) 15%, transparent)', background: 'color-mix(in srgb, var(--theme-amber) 5%, transparent)' }}>
          {/* wrap: at 375px the message and its action button cannot share a row. */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            <div>
              <p style={{ color: 'var(--theme-amber-text)', margin: 0, fontSize: 14, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                <Clock size={15} aria-hidden="true" /> {BS_MONTHS[activePeriod.bs_month - 1]} {activePeriod.bs_year} has ended
              </p>
              <p style={{ color: 'var(--theme-text2)', margin: '4px 0 0', fontSize: 12 }}>
                {isAdmin
                  ? `Viewing as admin — go to Periods to close and advance for this property.`
                  : canClosePeriod
                    ? `Finish your month-end stock count, then close this period and open ${BS_MONTHS[nextAdvMonth - 1]}.`
                    : `Your manager or the account owner closes the month once the stock count is finished.`}
              </p>
            </div>
            {isAdmin ? (
              <button className="amber-action-btn" onClick={() => navigate('/periods')}>
                Go to Periods →
              </button>
            ) : canClosePeriod && (
              <button className="amber-action-btn" onClick={askPeriodClose} disabled={advancingPeriod || checkingClose}>
                {checkingClose ? 'Checking…' : advancingPeriod ? 'Closing…' : `End ${BS_MONTHS[activePeriod.bs_month - 1]} & Start ${BS_MONTHS[nextAdvMonth - 1]} →`}
              </button>
            )}
          </div>
          {confirmPeriodClose && (
            <ConfirmModal
              title={`Close ${BS_MONTHS[activePeriod.bs_month - 1]} ${activePeriod.bs_year} and open ${BS_MONTHS[nextAdvMonth - 1]} ${nextAdvMonth === 1 ? activePeriod.bs_year + 1 : activePeriod.bs_year}?`}
              confirmLabel={`Close ${BS_MONTHS[activePeriod.bs_month - 1]} ${activePeriod.bs_year}`}
              busy={advancingPeriod}
              busyLabel="Closing…"
              danger={closeNotes.some(n => n?.danger)}
              onConfirm={closeAndAdvancePeriod}
              onCancel={() => setConfirmPeriodClose(false)}
            >
              <CloseConfirmBody notes={closeNotes}>
                <p style={{ margin: '0 0 8px' }}>Closing the month is how its figures become final:</p>
                <ul style={{ margin: '0 0 8px', paddingLeft: 18 }}>
                  {/* HR is deliberately NOT locked by the close — payroll is finalized after the
                      stock month closes — so the sentence names exactly what locks. And it must name
                      ALL of it: eight IMS surfaces carry the lock (grep `periodClosed|isLocked` under
                      src/modules/ims) while this list said four, so a team told the month was
                      read-only could still raise a requisition or receive a PO into it (S710). */}
                  <li>Purchases and Returns, Sales, Stock Count, Overheads, Requisitions and Purchase Orders for {BS_MONTHS[activePeriod.bs_month - 1]} become read-only for your team (Crest admin can still correct figures later).{clientModules?.hr ? ' HR pages stay open — Payroll Run locks itself once finalized.' : ''}</li>
                  <li>Closing stock carries forward as {BS_MONTHS[nextAdvMonth - 1]}&apos;s opening stock.</li>
                  {/* Only when this close makes it (D42). For a supervisor the report waits for the
                      Owner's first view, and deferredReportNote above says so instead. */}
                  {closerMakesReport({ isAdmin, isOwner }) && (
                    <li>The Monthly Owner Report snapshot is captured from the figures as they stand now.</li>
                  )}
                </ul>
                <p style={{ margin: 0 }}>
                  Make sure the month-end stock count is saved first — COGS, Variance and the frozen report all read it.
                </p>
              </CloseConfirmBody>
            </ConfirmModal>
          )}
        </div>
      )}

      {/* The close's outcome sentence lives OUTSIDE the "has ended" banner (S792). A close that did
          close — or found the month already closed by someone else (STOCK-8) — reloads the figures,
          the next month becomes the open one, and the banner unmounts. Inside it, the sentence
          naming what still needs doing (carry the count forward, open the next month, the report,
          or "someone else closed it") vanished a second after it appeared. It stays until
          dismissed or the next close attempt clears it. "Someone else closed it" is neutral: that
          press changed nothing and nothing is wrong. */}
      {periodCloseNotice && (
        <div role={periodCloseNotice.neutral ? 'status' : 'alert'} className="card dash-row" style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16,
          ...(periodCloseNotice.neutral ? {} : {
            borderColor: 'color-mix(in srgb, var(--theme-red) 25%, transparent)',
            background: 'color-mix(in srgb, var(--theme-red) 8%, transparent)',
          }),
        }}>
          <p style={{ color: periodCloseNotice.neutral ? 'var(--theme-text2)' : 'var(--theme-red-text)', margin: 0, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
            {periodCloseNotice.neutral
              ? <Clock size={14} aria-hidden="true" style={{ flexShrink: 0 }} />
              : <TriangleAlert size={14} aria-hidden="true" style={{ flexShrink: 0 }} />}
            {periodCloseNotice.text}
          </p>
          <button
            className="btn btn-ghost" style={{ fontSize: 12, flexShrink: 0 }}
            onClick={() => setPeriodCloseNotice(null)} aria-label="Dismiss"
          >×</button>
        </div>
      )}

      {/* ── No modules enabled ── */}
      {!showIms && !showHr && !showPos && (
        <div className="card" style={{ textAlign: 'center', padding: '48px 24px' }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }} aria-hidden="true"><LayoutGrid size={32} strokeWidth={1.5} /></div>
          <p style={{ fontSize: 15, color: 'var(--theme-text1)', fontWeight: 600, margin: '0 0 8px' }}>No modules enabled</p>
          <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: 0 }}>Contact your consultant to activate Crest IMS, Crest HR, or Crest POS.</p>
        </div>
      )}

      {/* Home's first answer is what needs a person (S800 stage C), then each module's headline cards. */}
      {!imsScope && showModuleHeaders && (
        <HomeAttention
          clientId={effectiveClientId}
          showIms={showIms} showHr={showHr} showPos={showPos} posIsStationTeam={posIsStationTeam}
          // Who is shown waiting till bills (S809 3j): the Owner and the operator, who post them from
          // Periods, and an IMS supervisor, who is told who posts them (HomeAttention).
          canSeeImsPosting={isAdmin || isOwner || hasImsAccess('supervisor')}
          canHrApprove={hasHrAccess('supervisor')}
          hrApprovals={hrApprovals}
          reorderCount={reorderCount} canReorder={canReorder}
          bookingRequests={posStats && !posStats.kitchen ? (posStats.requestsPending ?? 0) : 0}
        />
      )}

      {/* dash-section so the module block keeps the page's rhythm below it whether it renders as
          the 2/3-column grid or, for a single-module client, one plain full-width block. */}
      <div className={`dash-section ${dashColsClass}`.trim()}>
      {/* ── IMS KPIs ── */}
      {showIms && <div>
      {moduleHeader('Inventory')}
      {/* The Inventory Dashboard opens on what needs doing (S800 stage F), as Home does. */}
      {!showModuleHeaders && activePeriod && (
        <HomeAttention
          mode="ims"
          clientId={effectiveClientId}
          showIms={showIms} showHr={false} showPos={dashMods.pos} posIsStationTeam={posIsStationTeam}
          canSeeImsPosting={isAdmin || isOwner || hasImsAccess('supervisor')}
          reorderCount={reorderCount} canReorder={canReorder}
          activePeriod={activePeriod} periodExpired={periodExpired}
        />
      )}
      {showModuleHeaders ? (
        /* Trimmed top-pill row — card count matched to HR/POS (5, vs their 4) — the "money"
           numbers. Food Cost % spans 2 columns as this row's headline tile (dashboard density
           critique, 2026-08-14, P1) rather than sitting at identical weight to its four
           siblings — it's the one figure with its own health-verdict color, so it's the natural
           focal point. Everything else (reference cards, charts, tables) renders full-width
           below the equal-width grid instead, in the imsDetails section further down. */
        <div className="stat-grid stat-grid--compact">
          <div style={{ gridColumn: 'span 2' }}>{foodCostCard}</div>
          {netPurchasesCard}{revenueCard}{netMarginCard}{wastageCard}
        </div>
      ) : (
        <>
          <div className="stat-grid stat-grid--compact dash-row">
            {netPurchasesCard}{revenueCard}{foodCostCard}{fixedCostsCard}{netMarginCard}
          </div>
          <div className="stat-grid stat-grid--compact dash-row">
            {activePeriodCard}{itemsCard}{vendorsCard}{recipesCard}{menuHealthCard}{wastageCard}
          </div>
          {/* "What changed" (S800 stage F): what is on the shelf, and which prices moved. Each carries
              the gate of the report it summarises — Stock Report (Growth, supervisor) and Price
              Tracker (Pro, manager) — so the tile never shows what its own report would refuse. */}
          {(showStockOnHand || showPriceMovers) && (
            <div className="dash-card-grid dash-row">
              {showStockOnHand && (
                <div className="card card--compact">
                  <h3 className="dash-card-title">
                    <Tip text="What the stock on your shelves is worth now, at each item's current rate: the closing count where one has been entered, otherwise opening + purchases − what recipes used − wastage and staff meals. Active items only — the Stock Report adds any item hidden this month that still had stock." width={300}>
                      Stock on hand — active items
                    </Tip>
                  </h3>
                  <div className="stat-value">{stockOnHand == null ? '—' : npr(stockOnHand)}</div>
                  <div className="stat-sub">{periodLabel}, estimated until the closing count</div>
                  <Link to="/stock-report" className="dash-tile-link">Stock Report →</Link>
                </div>
              )}
              {showPriceMovers && <ImsPriceMovers activePeriod={activePeriod} />}
            </div>
          )}
          {imsChartsAndTables}
          {/* No top margin of its own: the block above carries the gap, and .dash-row:last-child
              means that block carries it only while something actually follows it. */}
          {canSales && <div><SalesPivot activePeriod={activePeriod} posEnabled={false} /></div>}
        </>
      )}
      </div>}

      {/* ── HR KPIs (below Inventory) ── */}
      {/* Previously two entirely separate blocks — a full "Loading HR data…" text card while
          !hrStats, then the real KPI grid once loaded — inconsistent with how the IMS/POS
          sections above handle their own loading state (a skeleton bar per KPI value, same grid
          shape throughout). Now one block, matching that pattern. */}
      {showHr && (
        /* No margins of its own, and neither has POS below. These are GRID CHILDREN of
           .dash-3col-*: the 6px top was written when the three module blocks stacked vertically,
           and once S438/S439 made them columns it stopped being a separator and became a column
           OFFSET — HR and POS started 6px lower than Inventory, so the three module headings did
           not sit on one line. The 14px bottom compounded the other way on the phone, where the
           grid collapses to one column and its own 16px row-gap is the separator: 14 + 16 + 6 =
           36px between modules against 14 everywhere else on the page. The grid's gap is the only
           thing that should be spacing these. */
        <div>
          {moduleHeader('Human Resources')}
          {/* A dashboard's whole job is a 5-second "state of things" glance — headcount, active
              staff and payroll are exactly that for HR, not reference data, so every card here
              stays visible always (reversed from an earlier pass that hid them behind a click;
              hiding numbers people check daily is the #1 progressive-disclosure failure mode).
              Pending Approvals is still the section's headline — spans 2 columns for visual
              weight, same instinct as IMS's Food Cost % above — but "headline" means "biggest,"
              not "only thing shown." */}
          <div className="stat-grid stat-grid--compact dash-row">
            {showModuleHeaders && <div style={{ gridColumn: 'span 2' }}>{hrHeadlineCard}</div>}
            {hrSecondaryCards}
          </div>
          {!showModuleHeaders && <div>{hrHeadlineCard}</div>}
        </div>
      )}

      {/* ── POS KPIs ── */}
      {showPos && (
        /* Same as HR above — the grid gap spaces the columns, this block does not. */
        <div>
          {moduleHeader(posTeam === 'bar' ? 'Bar' : posTeam === 'kitchen' ? 'Kitchen' : 'Point of Sale')}
          {/* Same reversal as HR above — Covers Served/Avg Check/Tables Occupied (or Late/Ready &
              Waiting/Avg Prep for a kitchen/bar station) are exactly what a mid-rush glance needs,
              not occasional reference data, so they stay visible. Revenue/Open Tickets is still
              the headline via size + position, not via hiding its siblings. */}
          <div className="stat-grid stat-grid--compact dash-row">
            {showModuleHeaders && <div style={{ gridColumn: 'span 2' }}>{posIsStationTeam ? posKitchenHeadlineCard : posFrontHeadlineCard}</div>}
            {posIsStationTeam
              ? <>{!showModuleHeaders && posKitchenHeadlineCard}{posKitchenSecondaryCards}</>
              : <>{!showModuleHeaders && posFrontHeadlineCard}{posFrontSecondaryCards}</>}
          </div>

          {/* POS-sourced sales pivot — kitchen/bar station accounts have no use for a revenue
              breakdown (they get kitchen-ops KPIs above instead), so this is front-of-house only.
              Its figures are money, so Supervisor and above only, as on the POS Dashboard (owner D2,
              S814). Single-module (POS-only) clients keep it right here; once 2+ modules
              share the page it lives on the POS Dashboard instead (S800), with the rest of POS. */}
          {!showModuleHeaders && !posIsStationTeam && hasPosAccess('supervisor') && <div><SalesPivot activePeriod={activePeriod} posEnabled={true} /></div>}
        </div>
      )}
      </div>

      {/* ── Where each module's charts went (Home of 2+ modules, S800). The IMS reference cards, every
          IMS chart and the manual sales table are on the Inventory Dashboard; the POS sales table and
          today-vs-last-week figures are on the POS Dashboard. Each module tab opens its own, so Home
          stays a one-screen read of every module's headline cards. A plain-fact banner, not a card:
          it points somewhere, it is not a figure. ── */}
      {showModuleHeaders && (showIms || (showPos && !posIsStationTeam)) && (
        <div className="note-banner dash-section" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <span>
            <strong>Charts and tables are on each module's own dashboard</strong>
            {showIms && <> — Daily Purchases vs Sales, the food-cost trend and spend by category on the Inventory Dashboard</>}
            {showPos && !posIsStationTeam && <>{showIms ? ';' : ' —'} sales by hour and the POS sales table on the POS Dashboard</>}.
          </span>
          <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {showIms && <Link to={IMS_DASHBOARD_PATH} className="btn btn-ghost btn-sm">Inventory Dashboard <ArrowRight size={13} aria-hidden="true" /></Link>}
            {showPos && !posIsStationTeam && <Link to="/pos/dashboard" className="btn btn-ghost btn-sm">POS Dashboard <ArrowRight size={13} aria-hidden="true" /></Link>}
          </span>
        </div>
      )}
    </div>
  )
}
