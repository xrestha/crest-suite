import { useEffect, useState, useRef } from 'react'
import { useAuth } from '../../context/AuthContext'
import { useTheme } from '../../context/ThemeContext'
import { useSettings } from '../../context/SettingsContext'
import { fcThresholds } from '../../shared/imsFormulas'
import { supabase } from '../../supabaseClient'
import { useScopedDb } from '../../shared/hooks/useScopedDb'
import { fetchAllRows } from '../../shared/fetchAllRows'
import { useNavigate, useLocation } from 'react-router-dom'
import {
  ResponsiveContainer, PieChart, Pie, Cell, Tooltip,
  LineChart, Line, ComposedChart, Area, XAxis, YAxis, CartesianGrid, ReferenceLine,
  BarChart, Bar
} from 'recharts'
import { chartMotion } from '../../shared/chartMotion'
import { ArrowDown, Lock, TriangleAlert, Clock, LayoutGrid, ChevronDown } from 'lucide-react'
import Tip from '../../components/Tip'
import ChartCard from '../../components/ChartCard'
import StatPill from '../../components/StatPill'
import ConfirmModal from '../../components/ConfirmModal'
import { getBsToday, BS_MONTHS, BS_MONTHS_SHORT, daysInBsMonth, bsToAd } from '../../utils/bsCalendar'
import { getSubStatus } from '../../utils/subscription'
import { explodeRecipeIngredients } from '../../utils/recipeCost'
import { useHrApprovalCounts } from '../../modules/hr/dashboard/useHrApprovalCounts'
import SalesPivot from '../../modules/dashboard/SalesPivot'
import { useFoodBeverageSplit } from '../../modules/dashboard/useFoodBeverageSplit'
import { readDashboardCache, writeDashboardCache } from './dashboardCache'
const CHART_COLORS = ['#c9a84c', '#34d399', '#60a5fa', '#f87171', '#8b5cf6', '#ea580c', '#22d3ee', '#f472b6']

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
    <div className="tab-bar" role="tablist" aria-label={label} style={{ marginBottom: 6 }} onKeyDown={onKeyDown}>
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
  purchases: '#c9a84c', // gold — ties to the Food Cost card and the FC% trend line
  sales:     '#34d399', // green
  purchTarget: '#fb923c', // orange — frozen Purch. Target, deliberately not gold
  salesTarget: '#60a5fa', // blue — frozen Sales Target, deliberately not green
}

// Sunday-first, one letter each, exactly as asked for — S/M/T/W/T/F/S. Tue and Thu (and Sun/Sat)
// share a letter; that ambiguity is accepted on purpose rather than solved with two-letter codes,
// matching the plain single-glyph weekday row this was modeled on. Index matches JS Date.getDay().
const WEEKDAY_INITIALS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

// Least-squares trend on a day→value map, extended to monthEndDay — shared by both the Sales and
// Purchases month-end projections on the Daily Purchases vs Sales chart. Dampened so a steep slope
// fitted to a few volatile early days can't run away: each projected day is clamped to
// [0, 1.25 × recent (up-to-7-day) peak]. Needs ≥5 data points to bother projecting at all.
//
// Returns slope/intercept/cap alongside the usual projDays/projectedTotal so a caller can freeze
// this exact fit (see the sales/purch_projection_snapshot capture in loadStats) and reconstruct a
// static full-month line from it later via targetLineValue() below — projDays alone only covers
// days after the last actual, which is enough for the live forward tail but not for a frozen
// month-long reference line.
function projectTrend(dayNums, valueMap, monthEndDay) {
  if (dayNums.length < 5) return null
  const xs = dayNums, ys = xs.map(d => valueMap[d]), n = xs.length
  const sumX = xs.reduce((a, b) => a + b, 0), sumY = ys.reduce((a, b) => a + b, 0)
  const sumXY = xs.reduce((a, x, i) => a + x * ys[i], 0), sumXX = xs.reduce((a, x) => a + x * x, 0)
  const denom = n * sumXX - sumX * sumX
  const slope = denom !== 0 ? (n * sumXY - sumX * sumY) / denom : 0
  const intercept = (sumY - slope * sumX) / n
  const recentYs = xs.slice(-7).map(d => valueMap[d]) // last up-to-7 days
  const cap = Math.round(Math.max(...recentYs) * 1.25)
  const lastActual = xs[xs.length - 1]
  const projDays = {}
  let projSum = 0
  for (let d = lastActual + 1; d <= monthEndDay; d++) {
    const v = Math.min(cap, Math.max(0, Math.round(slope * d + intercept)))
    projDays[d] = v; projSum += v
  }
  return { projDays, projectedTotal: Math.round(sumY + projSum), lastActual, slope, intercept, cap }
}

// Reconstructs one day's value on a frozen projection snapshot ({slope, intercept, cap} captured
// once by loadStats — see sales/purch_projection_snapshot below), using the same clamp
// projectTrend() applies to its own live projected days. Unlike projDays (only future-of-capture
// days), this is called for every day 1..monthEndDay so the frozen line spans the whole period.
function targetLineValue(snap, day) {
  if (!snap) return null
  return Math.min(snap.cap, Math.max(0, Math.round(snap.slope * day + snap.intercept)))
}

export default function ClientDashboard() {
  const { profile, clientId, isAdmin, clientModules, hasFeature, hasImsAccess, hasHrAccess, hasPosAccess, posTeam, loading: authLoading, adminViewClientName } = useAuth()
  // 'kitchen'/'bar' pos_team accounts (S431) get kitchen-ops KPIs (open/late tickets, prep time)
  // instead of the front-of-house Revenue/Covers/Avg Check/Tables Occupied cards — they have no
  // more use for revenue figures on their landing dashboard than a POS-only staffer has for IMS's.
  const posIsStationTeam = posTeam === 'kitchen' || posTeam === 'bar'
  const { colors } = useTheme()
  const { settings } = useSettings()
  const effectiveClientId = clientId || profile?.client_id
  const { scopedFrom, scopedInsert, scopedUpdate } = useScopedDb()
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
  // Frozen, never-recalculated trend fit — captured once by loadStats the first time each metric
  // crosses the 5-point threshold, so it can be compared against as the period plays out instead of
  // silently moving with every new day of actuals the way salesProjection/purchProjection do.
  const [salesTargetSnap, setSalesTargetSnap] = useState(() => readDashboardCache('salesTargetSnap', effectiveClientId)) // { slope, intercept, cap, capturedDay, projectedMonthEnd } | null
  const [purchTargetSnap, setPurchTargetSnap] = useState(() => readDashboardCache('purchTargetSnap', effectiveClientId)) // { slope, intercept, cap, capturedDay, projectedMonthEnd } | null
  const [topItemSpend, setTopItemSpend] = useState(() => readDashboardCache('topItemSpend', effectiveClientId) ?? [])
  const [reorderItems, setReorderItems]   = useState(() => readDashboardCache('reorderItems', effectiveClientId) ?? [])
  const [fcTrend, setFcTrend]             = useState(() => readDashboardCache('fcTrend', effectiveClientId) ?? [])
  const [hrStats, setHrStats]             = useState(() => readDashboardCache('hrStats', effectiveClientId) ?? null)
  const [posStats, setPosStats]           = useState(() => readDashboardCache('posStats', effectiveClientId) ?? null)
  // Which visual the merged Spend by Category / Top Items card is showing — plain UI state, not
  // page data, so it isn't seeded from or written to dashboardCache like the state above; it
  // resets to the default tab on remount the same way ChartCard's own `expanded` does.
  const [spendView, setSpendView]         = useState('category') // 'category' | 'items'
  // Same treatment for the merged Revenue vs Cost Breakdown / Sales Mix card below (S557) — plain
  // UI state, not persisted, resets to 'cost' on remount.
  const [costCardView, setCostCardView]   = useState('cost') // 'cost' | 'mix'
  // Progressive disclosure, IMS's reference-card row only (dashboard density critique,
  // 2026-08-14, P1) — Active Period/Items/Vendors/Recipes/Menu Health/Fixed Costs% are genuinely
  // low-frequency reference data (S439 already treated them as a secondary tier below the "money"
  // row). HR and POS's cards are NOT behind this: headcount, covers, avg check and tables occupied
  // are exactly what a mid-shift glance needs, so hiding them would defeat the dashboard's own
  // purpose — reversed after checking that against real dashboard UX guidance (a KPI dashboard's
  // job is a 5-second read of business state; hiding daily-checked numbers is the most common way
  // progressive disclosure breaks that). Plain UI state, same treatment as spendView/costCardView
  // above — resets closed on remount.
  const [openDetails, setOpenDetails] = useState({ ims: false })
  const toggleDetails = (key) => setOpenDetails(prev => ({ ...prev, [key]: !prev[key] }))
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
  const [advancingPeriod, setAdvancingPeriod] = useState(false)
  const [periodCloseError, setPeriodCloseError] = useState('')
  const [confirmPeriodClose, setConfirmPeriodClose] = useState(false)
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
    else if (section === 'pos') loadPosStats(myId)
    else if (section === 'fcTrend') loadFcTrend(activePeriod, myId)
  }

  useEffect(() => {
    if (authLoading) return
    if (!effectiveClientId) return
    const myId = ++loadIdRef.current
    // Load only the modules the displayed client actually subscribes to (clientModules from
    // AuthContext already resolves real-client vs admin "view as client").
    if (clientModules.ims) loadStats(myId); else setLoading(false)
    if (clientModules.hr) loadHrStats(myId); else setHrStats(null)
    if (clientModules.pos) { posIsStationTeam ? loadKitchenPosStats(myId) : loadPosStats(myId) } else setPosStats(null)
  }, [authLoading, effectiveClientId, clientModules.ims, clientModules.hr, clientModules.pos, posIsStationTeam, location.key]) // eslint-disable-line react-hooks/exhaustive-deps

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
      scopedFrom('recipes', '*', { count: 'exact', head: true }).eq('is_active', true).neq('category', 'Sub-Recipe'),
      scopedFrom('recipes', '*', { count: 'exact', head: true }).eq('is_active', true).eq('category', 'Sub-Recipe'),
      scopedFrom('recipes', 'id, name, selling_price, category, is_active, target_fc_pct'),
      scopedFrom('items', 'id, name, uom, per_uom_rate, yield_pct, categories(name)').eq('is_active', true).eq('is_sub_recipe', false),
      scopedFrom('par_levels', 'item_id, par_qty'),
      // Unfiltered by is_active — an item deactivated mid-period still has real purchase/wastage
      // history for that period. Used for Top Items by Spend and itemRateMap below so those don't
      // silently drop/zero-cost that history, unlike the active-only `items` fetch above (which
      // still correctly limits Variance/Reorder/the item COUNT to currently-active stock items).
      scopedFrom('items', 'id, name, per_uom_rate').eq('is_sub_recipe', false),
    ])

    // .single() reports error.code 'PGRST116' when the result set isn't exactly one row — for
    // this query that just means "no open period right now," a normal, common state, not a
    // failure. Only anything else is a genuine fetch failure worth surfacing.
    const { data: period, error: periodErr } = await scopedFrom('monthly_periods')
      .eq('status', 'open')
      .order('bs_year', { ascending: false }).order('bs_month', { ascending: false })
      .limit(1).single()
    if (loadIdRef.current !== myId) return // superseded by a newer client switch

    setAndCache(setActivePeriod, 'activePeriod', period)

    // Fired here (as soon as `period` is known) rather than after this whole function finishes —
    // it used to run only once loadStats had computed Food Cost % from its own big batch below,
    // which meant the FC Trend chart's own (separate, ~11-period) query never even started until
    // everything else on the page was already done, guaranteeing it was the last thing to render.
    // It now derives the open period's own point from its own query batch instead of being handed
    // a precomputed figure, so it has everything it needs up front and can run fully alongside the
    // Promise.all below instead of after it. Not awaited — same fire-and-forget shape it always had.
    loadFcTrend(period, myId)

    const dependentPromise = Promise.all([
      period ? fetchAllRows(() => supabase.from('purchase_entries').select('item_id, qty, rate, bs_day').eq('period_id', period.id).order('id')) : { data: [] },
      period ? supabase.from('vendor_returns').select('item_id, qty, rate, bs_day').eq('period_id', period.id) : { data: [] },
      // Fetches every source (including 'pos_comp') — revenue figures below filter comps out
      // client-side, but theoreticalMap (Reorder + Variance widgets) needs every source counted,
      // matching every other consumption-facing report (ReorderReport, Variance, ShrinkageReport
      // etc. per PosOrders.jsx's own source-taxonomy comment) — a comped dish still used real
      // stock even though it collected no revenue.
      period ? fetchAllRows(() => supabase.from('sales_entries').select('recipe_id, qty_sold, bs_day, unit_price, discount, source').eq('period_id', period.id).order('id')) : { data: [] },
      period ? supabase.from('opening_stock').select('item_id, qty').eq('period_id', period.id) : { data: [] },
      period ? supabase.from('closing_stock').select('item_id, physical_qty').eq('period_id', period.id) : { data: [] },
      // `bucket` is selected (not just `amount`) because the Overheads page splits fixed costs
      // into three buckets — overhead / labor / tax_fees — and the Revenue vs Cost Breakdown pie
      // needs them apart. The KPI cards still use the all-bucket sum; see overheadBuckets below.
      period ? supabase.from('overheads').select('amount, bucket').eq('period_id', period.id) : { data: [] },
      period ? fetchAllRows(() => supabase.from('wastages').select('item_id, qty').eq('period_id', period.id).order('id')) : { data: [] },
    ])

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
    const ingredientBreakdownPromise = dashRecipeIds.length > 0
      ? explodeRecipeIngredients(supabase, dashRecipeIds)
      : Promise.resolve({})

    const [dependentResults, ingredientBreakdown] = await Promise.all([dependentPromise, ingredientBreakdownPromise])
    if (loadIdRef.current !== myId) return // superseded again after these more awaits

    const [
      { data: purchases },
      { data: returns },
      { data: salesData },
      { data: opening },
      { data: closing },
      { data: overheadsData },
      { data: wastagesData }
    ] = dependentResults

    const hadRealError = (periodErr && periodErr.code !== 'PGRST116')
      || independentResults.some(r => r.error) || dependentResults.some(r => r.error)
    setLoadErrors(prev => ({ ...prev, ims: hadRealError ? 'Inventory data failed to load — figures below may be incomplete or stale.' : '' }))

    // PATCHED: purchaseTotal = gross − returns
    const grossTotal  = (purchases || []).reduce((s, p) => s + p.qty * p.rate, 0)
    const returnTotal = (returns || []).reduce((s, r) => s + r.qty * r.rate, 0)
    const purchaseTotal = grossTotal - returnTotal

    const currentPriceMap = {}
    ;(recipes || []).forEach(r => { currentPriceMap[r.id] = parseFloat(r.selling_price) || 0 })
    // unit_price captured on the row (price actually charged) used per-row when present, else
    // falls back to the recipe's current price — previously always used the current price, so
    // this period's revenue silently reflected today's menu price rather than what was charged.
    // soldMap/revenueMap (comp-excluded) drive every revenue-facing figure on this page —
    // Revenue, daily trend, projections, Menu Health opportunity. soldMapAll (every source,
    // including 'pos_comp') feeds theoreticalMap below instead, since a comped dish still
    // consumed real stock even though it collected no revenue — see the query comment above.
    const soldMap = {}, soldMapAll = {}, revenueMap = {}
    ;(salesData || []).forEach(s => {
      const qty = parseFloat(s.qty_sold)
      soldMapAll[s.recipe_id] = (soldMapAll[s.recipe_id] || 0) + qty
      if (s.source === 'pos_comp') return
      const price = s.unit_price != null ? parseFloat(s.unit_price) : (currentPriceMap[s.recipe_id] || 0)
      soldMap[s.recipe_id] = (soldMap[s.recipe_id] || 0) + qty
      revenueMap[s.recipe_id] = (revenueMap[s.recipe_id] || 0) + qty * price - (parseFloat(s.discount) || 0)
    })
    const revenueTotal = Object.values(revenueMap).reduce((s, v) => s + v, 0)

    // theoreticalMap: item-level usage this period. ingredientBreakdown rows are already
    // recursed through sub-recipe nesting and yield_pct-adjusted per one portion — just scale by
    // how many portions actually sold. Uses soldMapAll (comps included) — see comment above.
    const theoreticalMap = {}
    Object.entries(ingredientBreakdown).forEach(([recipeId, rows]) => {
      const sold = soldMapAll[recipeId] || 0
      if (sold <= 0) return
      rows.forEach(({ item_id, qty }) => { theoreticalMap[item_id] = (theoreticalMap[item_id] || 0) + sold * qty })
    })

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
        costedPricedCount++
        const cost = recipeCostMap[r.id] || 0
        const targetPct = parseFloat(r.target_fc_pct) || 30
        const currentFcPct = (cost / price) * 100
        if (currentFcPct > targetPct) {
          underpricedCount++
          const suggestedExVat = targetPct > 0 ? cost / (targetPct / 100) : 0
          menuOpportunityTotal += Math.max(0, suggestedExVat - price) * (soldMap[r.id] || 0)
        }
      })
    }

    // PATCHED: purchMap net of returns
    const purchMap = {}
    const purchValueMap = {}
    ;(purchases || []).forEach(p => {
      purchMap[p.item_id] = (purchMap[p.item_id] || 0) + parseFloat(p.qty || 0)
      purchValueMap[p.item_id] = (purchValueMap[p.item_id] || 0) + parseFloat(p.qty || 0) * parseFloat(p.rate || 0)
    })
    ;(returns || []).forEach(r => {
      purchMap[r.item_id] = (purchMap[r.item_id] || 0) - parseFloat(r.qty || 0)
      purchValueMap[r.item_id] = (purchValueMap[r.item_id] || 0) - parseFloat(r.qty || 0) * parseFloat(r.rate || 0)
    })

    const openMap = {}; (opening || []).forEach(r => { openMap[r.item_id] = parseFloat(r.qty) })
    const closeMap = {}; (closing || []).forEach(r => { closeMap[r.item_id] = parseFloat(r.physical_qty) })
    const parMap = {}; (parLevels || []).forEach(p => { parMap[p.item_id] = parseFloat(p.par_qty) || 0 })

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
      setAndCache(setTopVariance, 'topVariance', varRows)
    } else {
      setAndCache(setTopVariance, 'topVariance', [])
    }

    // Category spend (net)
    const itemMap = {}; (items || []).forEach(i => { itemMap[i.id] = i })
    const catSpendMap = {}
    Object.entries(purchValueMap).forEach(([itemId, val]) => {
      if (val <= 0) return
      const cat = itemMap[itemId]?.categories?.name || 'Uncategorized'
      catSpendMap[cat] = (catSpendMap[cat] || 0) + val
    })
    setAndCache(setCategorySpend, 'categorySpend',
      Object.entries(catSpendMap)
        .map(([name, value]) => ({ name, value: Math.round(value) }))
        .filter(r => r.value > 0)
        .sort((a, b) => b.value - a.value)
    )

    // ── Daily trend: purchases (actual, net) + daily sales revenue + month-end sales projection ──
    const dayGrossMap = {}
    const dayReturnMap = {}
    ;(purchases || []).forEach(p => { dayGrossMap[p.bs_day] = (dayGrossMap[p.bs_day] || 0) + parseFloat(p.qty || 0) * parseFloat(p.rate || 0) })
    ;(returns || []).forEach(r => { dayReturnMap[r.bs_day] = (dayReturnMap[r.bs_day] || 0) + parseFloat(r.qty || 0) * parseFloat(r.rate || 0) })
    const dayPurchMap = {}
    new Set([...Object.keys(dayGrossMap), ...Object.keys(dayReturnMap)]).forEach(d => {
      dayPurchMap[d] = Math.round((dayGrossMap[d] || 0) - (dayReturnMap[d] || 0))
    })

    // Daily sales revenue — ONLY from day-attributed entries (bs_day > 0). Bulk monthly entries
    // (bs_day = 0) have no daily breakdown and are skipped. This map is the single source the chart
    // reads; when the POS ships it can feed this same shape (day → revenue) with no chart change.
    // unit_price captured on the row used per-row when present, else falls back to the recipe's
    // current price (see revenueTotal above for why).
    const daySalesMap = {}
    ;(salesData || []).forEach(s => {
      if (s.source === 'pos_comp') return
      const d = parseInt(s.bs_day)
      if (!d || d <= 0) return
      const price = s.unit_price != null ? parseFloat(s.unit_price) : (currentPriceMap[s.recipe_id] || 0)
      daySalesMap[d] = (daySalesMap[d] || 0) + parseFloat(s.qty_sold || 0) * price - (parseFloat(s.discount) || 0)
    })
    Object.keys(daySalesMap).forEach(d => { daySalesMap[d] = Math.round(daySalesMap[d]) }) // whole NPR (no ugly decimals)
    const salesDayNums = Object.keys(daySalesMap).map(Number).sort((a, b) => a - b)
    const dailySalesOn = salesDayNums.length > 0
    setAndCache(setHasDailySales, 'hasDailySales', dailySalesOn)
    const purchDayNums = Object.keys(dayPurchMap).map(Number).sort((a, b) => a - b)

    // Projections: current open month only, via the shared projectTrend() helper (≥5 data points,
    // dampened cap) — Sales and Purchases each get their own independent trend line. Past/closed
    // months show actuals only. Purchases are inherently lumpier than sales (a bulk restock lands
    // in one day rather than accruing steadily with daily covers), so its projection is expected to
    // be noisier — the same dampening cap that guards Sales keeps one big purchase day from
    // blowing up the forecast here too.
    const bsToday = getBsToday()
    const isCurrentMonth = !!period && period.bs_year === bsToday.year && period.bs_month === bsToday.month
    const monthEndDay = period ? daysInBsMonth(period.bs_year, period.bs_month) : 31
    const salesTrend = (dailySalesOn && isCurrentMonth) ? projectTrend(salesDayNums, daySalesMap, monthEndDay) : null
    const purchTrend = isCurrentMonth ? projectTrend(purchDayNums, dayPurchMap, monthEndDay) : null
    const projDays = salesTrend?.projDays || {}
    const purchProjDays = purchTrend?.projDays || {}
    setAndCache(setSalesProjection, 'salesProjection', salesTrend ? { projectedMonthEnd: salesTrend.projectedTotal } : null)
    setAndCache(setPurchProjection, 'purchProjection', purchTrend ? { projectedMonthEnd: purchTrend.projectedTotal } : null)

    // Freeze a one-time "Target" snapshot the first time each metric crosses projectTrend()'s
    // 5-point threshold, so a later visit can compare actual performance against what was
    // projected EARLY in the period — salesTrend/purchTrend above are intentionally live and
    // refit to all actuals on every load, so without a frozen copy there is no way to look back at
    // an earlier forecast; it has already moved on by the time you'd check it. Read whatever
    // snapshot already exists on the period row first (arrives for free once the migration lands,
    // scopedFrom selects '*'); only capture a new one when none exists yet — never overwritten
    // automatically afterward, matching the Monthly Owner Report's own frozen-snapshot precedent.
    let nextSalesTargetSnap = period?.sales_projection_snapshot || null
    let nextPurchTargetSnap = period?.purch_projection_snapshot || null
    if (period && isCurrentMonth) {
      if (!nextSalesTargetSnap && salesTrend) {
        nextSalesTargetSnap = {
          slope: salesTrend.slope, intercept: salesTrend.intercept, cap: salesTrend.cap,
          capturedDay: salesTrend.lastActual, capturedAt: new Date().toISOString(),
          projectedMonthEnd: salesTrend.projectedTotal,
        }
        // Best-effort: a failed save just means this loads uncaptured again next visit, and the
        // .is(...) guard means a second tab racing this same capture can't stomp a snapshot the
        // other just wrote (both would compute the same numbers from the same data anyway).
        scopedUpdate('monthly_periods', { sales_projection_snapshot: nextSalesTargetSnap })
          .eq('id', period.id).is('sales_projection_snapshot', null)
          .then(({ error }) => { if (error) console.error('Failed to save sales target snapshot', error) })
      }
      if (!nextPurchTargetSnap && purchTrend) {
        nextPurchTargetSnap = {
          slope: purchTrend.slope, intercept: purchTrend.intercept, cap: purchTrend.cap,
          capturedDay: purchTrend.lastActual, capturedAt: new Date().toISOString(),
          projectedMonthEnd: purchTrend.projectedTotal,
        }
        scopedUpdate('monthly_periods', { purch_projection_snapshot: nextPurchTargetSnap })
          .eq('id', period.id).is('purch_projection_snapshot', null)
          .then(({ error }) => { if (error) console.error('Failed to save purchase target snapshot', error) })
      }
    }
    setAndCache(setSalesTargetSnap, 'salesTargetSnap', nextSalesTargetSnap)
    setAndCache(setPurchTargetSnap, 'purchTargetSnap', nextPurchTargetSnap)

    // Build the unified day axis, full month (Day 1 → month end for the current month; full actual
    // range for past months). The compact card slices this down to a 10-day window (6 days back →
    // 3 days ahead) at render time — see `dailyTrendWindowed` below — while the expanded modal shows
    // this whole-month array so the full trend is visible there.
    const baseDays = [...purchDayNums, ...salesDayNums].filter(d => d > 0)
    const lastActualSalesDay = salesDayNums.length ? salesDayNums[salesDayNums.length - 1] : null
    const lastActualPurchDay = purchDayNums.length ? purchDayNums[purchDayNums.length - 1] : null
    const hasProj = Object.keys(projDays).length > 0
    const hasPurchProj = Object.keys(purchProjDays).length > 0
    const startDay = isCurrentMonth ? 1 : (baseDays.length ? Math.min(...baseDays) : 1)
    const lastDay  = isCurrentMonth ? monthEndDay : (baseDays.length ? Math.max(...baseDays) : 0)
    const trend = []
    for (let d = startDay; d <= lastDay; d++) {
      const isProj = projDays[d] != null
      const isPurchProj = purchProjDays[d] != null
      trend.push({
        day: `Day ${d}`,
        purchases: dayPurchMap[d] != null ? dayPurchMap[d] : null,
        sales: dailySalesOn && daySalesMap[d] != null ? daySalesMap[d] : null,
        // dashed line: anchor at the last actual sales day so it connects, then projected days
        salesProj: isProj ? projDays[d]
          : (d === lastActualSalesDay && hasProj ? daySalesMap[d] : null),
        purchProj: isPurchProj ? purchProjDays[d]
          : (d === lastActualPurchDay && hasPurchProj ? dayPurchMap[d] : null),
        // Frozen full-month line, unlike salesProj/purchProj above — non-null for every day in
        // range (not just from the last actual onward) so it's a static reference the actual line
        // can be compared against retroactively, not just a forward-looking tail.
        salesTarget: targetLineValue(nextSalesTargetSnap, d),
        purchTarget: targetLineValue(nextPurchTargetSnap, d),
      })
    }
    setAndCache(setDailyTrend, 'dailyTrend', trend)

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
    setAndCache(setTopItemSpend, 'topItemSpend', itemSpendRows)

    // Reorder — use net purchMap for theoretical stock. Gated on canReorder (Growth+); see Menu
    // Health comment above for why this needs a data gate, not just a render gate.
    if (canReorder) {
      const reorderRows = (items || [])
        .filter(i => parMap[i.id] > 0)
        .map(i => {
          const hasPhysical = closeMap[i.id] !== undefined
          // `|| 0` guard: a closing_stock row can exist with a NULL physical_qty (a partial count
          // save), which parses to NaN. Without the guard, NaN !== undefined so hasPhysical was
          // still true, and NaN downstream (shortfall, needsReorder = NaN > 0 = false) silently
          // dropped the item from the list entirely instead of flagging it — even if critically low.
          const currentStock = hasPhysical
            ? (closeMap[i.id] || 0)
            : Math.max(0, (openMap[i.id] || 0) + (purchMap[i.id] || 0) - (theoreticalMap[i.id] || 0))
          const par = parMap[i.id]
          const shortfall = par - currentStock
          const estValue = shortfall > 0 ? shortfall * parseFloat(i.per_uom_rate || 0) : 0
          return {
            name: i.name, uom: i.uom, currentStock: Math.round(currentStock * 100) / 100,
            par, shortfall: Math.round(shortfall * 100) / 100,
            estValue: Math.round(estValue), needsReorder: shortfall > 0,
            source: hasPhysical ? 'Physical' : "Calc'd"
          }
        })
        .filter(r => r.needsReorder)
        .sort((a, b) => b.estValue - a.estValue)
        .slice(0, 5)
      setAndCache(setReorderItems, 'reorderItems', reorderRows)
    } else {
      setAndCache(setReorderItems, 'reorderItems', [])
    }

    // Two shapes of the same figure, deliberately: `overheadTotal` is every bucket combined (what
    // the Fixed Costs % and Est. Net Margin % cards have always meant by "overheads"), while
    // `overheadBuckets` keeps the split so the cost pie can show Labor as its own slice without
    // inventing a second, overlapping labor number. Rows with a NULL bucket fall back to
    // 'overhead', matching Overheads.js's own `r.bucket || 'overhead'` grouping.
    const overheadBuckets = { overhead: 0, labor: 0, tax_fees: 0 }
    ;(overheadsData || []).forEach(o => {
      const b = overheadBuckets[o.bucket] !== undefined ? o.bucket : 'overhead'
      overheadBuckets[b] += parseFloat(o.amount || 0)
    })
    const overheadTotal = overheadBuckets.overhead + overheadBuckets.labor + overheadBuckets.tax_fees

    // itemRateMap already built above (for recipeCostMap) — same items(id, per_uom_rate) shape.
    const wastageValueTotal = (wastagesData || []).reduce((s, w) => s + parseFloat(w.qty || 0) * (itemRateMap[w.item_id] || 0), 0)

    setAndCache(setStats, 'stats', { itemCount, vendorCount, recipeCount, subRecipeCount, purchaseTotal, revenueTotal, overheadTotal, overheadBuckets, wastageValueTotal, underpricedCount, costedPricedCount, menuOpportunityTotal })
    setLoading(false)
  }

  async function loadHrStats(myId) {
    const { data: employees, error } = await scopedFrom('hr_employees', 'status, basic_salary')
    if (loadIdRef.current !== myId) return // superseded by a newer client switch
    setLoadErrors(prev => ({ ...prev, hr: error ? 'HR data failed to load — figures below may be incomplete or stale.' : '' }))
    const total     = employees?.length || 0
    const active    = employees?.filter(e => e.status === 'active').length || 0
    const probation = employees?.filter(e => e.status === 'probation').length || 0
    const payroll   = (employees || [])
      .filter(e => e.status === 'active' || e.status === 'probation')
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
  // own offset instead of trusting the runtime's.
  function bsDayBoundaryIso(bsYear, bsMonth, bsDay, endOfDay) {
    const d = bsToAd(bsYear, bsMonth, bsDay)
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0')
    return endOfDay ? `${y}-${m}-${dd}T23:59:59.999+05:45` : `${y}-${m}-${dd}T00:00:00.000+05:45`
  }

  async function loadPosStats(myId) {
    // See loadStats' identical .single() comment above — PGRST116 (no open period) is expected,
    // not a failure.
    const { data: period, error: periodErr } = await scopedFrom('monthly_periods')
      .eq('status', 'open')
      .order('bs_year', { ascending: false }).order('bs_month', { ascending: false })
      .limit(1).single()

    let orders = [], ordersErr = null
    if (period) {
      const fromTs = bsDayBoundaryIso(period.bs_year, period.bs_month, 1, false)
      const lastDay = daysInBsMonth(period.bs_year, period.bs_month)
      const toTs = bsDayBoundaryIso(period.bs_year, period.bs_month, lastDay, true)
      const { data, error } = await scopedFrom('pos_orders', 'id, covers, paid_amount, credit_note_id, close_type, closed_at')
        .eq('close_type', 'paid')
        .gte('closed_at', fromTs).lte('closed_at', toTs)
      ordersErr = error
      // Same exclusion as Sales/Covers Report — a since-Credit-Noted bill's revenue correction
      // posts on the day the Credit Note is issued, not retroactively here.
      orders = (data || []).filter(o => !o.credit_note_id)
    }

    const revenueTotal = orders.reduce((s, o) => s + (parseFloat(o.paid_amount) || 0), 0)
    const coversTotal   = orders.reduce((s, o) => s + (o.covers || 0), 0)
    const billCount     = orders.length
    const avgCheck      = billCount > 0 ? revenueTotal / billCount : 0

    const { data: tables, error: tablesErr } = await scopedFrom('pos_tables', 'status').neq('status', 'inactive')
    if (loadIdRef.current !== myId) return // superseded by a newer client switch
    const tablesOccupied = (tables || []).filter(t => t.status === 'occupied').length
    const tablesTotal    = (tables || []).length

    const hadRealError = (periodErr && periodErr.code !== 'PGRST116') || ordersErr || tablesErr
    setLoadErrors(prev => ({ ...prev, pos: hadRealError ? 'POS data failed to load — figures below may be incomplete or stale.' : '' }))

    setAndCache(setPosStats, 'posStats', { revenueTotal, coversTotal, billCount, avgCheck, tablesOccupied, tablesTotal })
  }

  // Kitchen/bar-team variant (S431) — today's pos_kot_log activity for just this team's own
  // queue (KOT for kitchen, BOT for bar), never the other station's. Thresholds/formulas match
  // KitchenDisplay.jsx exactly (LATE_MS=15min) so a card here and the live board never disagree.
  async function loadKitchenPosStats(myId) {
    const today = getBsToday()
    const fromTs = bsDayBoundaryIso(today.year, today.month, today.day, false)
    const toTs   = bsDayBoundaryIso(today.year, today.month, today.day, true)
    const kdsStation = posTeam === 'bar' ? 'BOT' : 'KOT'

    const { data, error } = await scopedFrom('pos_kot_log', 'status, sent_at, started_at, ready_at')
      .eq('station', kdsStation)
      .neq('status', 'cancelled')
      .gte('sent_at', fromTs).lte('sent_at', toTs)
    if (loadIdRef.current !== myId) return // superseded by a newer client switch

    const rows = data || []
    const nowMs = Date.now()
    const LATE_MS = 15 * 60 * 1000 // matches KitchenDisplay.jsx's own convention
    const READY_WAITING_MS = 20 * 60 * 1000 // "ready & still waiting for pickup", not all-day ready count

    const openNow = rows.filter(r => r.status === 'new' || r.status === 'in_progress').length
    const lateCount = rows.filter(r => r.status !== 'ready' && (nowMs - new Date(r.sent_at).getTime()) > LATE_MS).length
    const readyRows = rows.filter(r => r.status === 'ready')
    const readyWaiting = readyRows.filter(r => r.ready_at && (nowMs - new Date(r.ready_at).getTime()) < READY_WAITING_MS).length
    const prepDurationsMin = readyRows
      .filter(r => r.started_at && r.ready_at)
      .map(r => (new Date(r.ready_at).getTime() - new Date(r.started_at).getTime()) / 60000)
    const avgPrepMin = prepDurationsMin.length
      ? Math.round(prepDurationsMin.reduce((s, v) => s + v, 0) / prepDurationsMin.length)
      : null
    const completedToday = readyRows.length

    setLoadErrors(prev => ({ ...prev, pos: error ? `${kdsStation === 'BOT' ? 'Bar' : 'Kitchen'} data failed to load — figures below may be incomplete or stale.` : '' }))
    setAndCache(setPosStats, 'posStats', { kitchen: true, station: kdsStation, openNow, lateCount, readyWaiting, avgPrepMin, completedToday })
  }

  // The commit half of period close — the ConfirmModal below (rendered next to the button) is
  // the ask, with the consequences spelled out; window.confirm's OS chrome used to carry this
  // sentence and stated none of them (S575).
  async function closeAndAdvancePeriod() {
    if (!activePeriod || !effectiveClientId || advancingPeriod) return
    const nextMonth = activePeriod.bs_month === 12 ? 1 : activePeriod.bs_month + 1
    const nextYear  = activePeriod.bs_month === 12 ? activePeriod.bs_year + 1 : activePeriod.bs_year
    setAdvancingPeriod(true)
    setPeriodCloseError('')
    try {
      const { error: closeError } = await scopedUpdate('monthly_periods', { status: 'closed' }).eq('id', activePeriod.id)
      if (closeError) throw closeError
      const { error: insertError } = await scopedInsert('monthly_periods', {
        bs_year: nextYear,
        bs_month: nextMonth,
        status: 'open'
      })
      // A duplicate here means the next period already exists (e.g. a retried click after a
      // slow response) — the close above still succeeded, so this isn't a real failure.
      if (insertError && insertError.code !== '23505' && !insertError.message?.includes('unique')) throw insertError
      loadStats(loadIdRef.current)
    } catch (err) {
      console.error('Failed to close period:', err)
      setPeriodCloseError(err?.message || 'Something went wrong closing the period. Please try again.')
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

    const trendResults = await Promise.all([
      periodIds.length ? fetchAllRows(() => supabase.from('purchase_entries').select('period_id, qty, rate').in('period_id', periodIds).order('id')) : { data: [] },
      periodIds.length ? fetchAllRows(() => supabase.from('vendor_returns').select('period_id, qty, rate').in('period_id', periodIds).order('id')) : { data: [] },
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
      periodIds.length ? fetchAllRows(() => supabase.from('sales_entries').select('period_id, recipe_id, qty_sold, unit_price, discount, source').in('period_id', periodIds).order('id')) : { data: [] },
      scopedFrom('recipes', 'id, selling_price'),
    ])
    const [{ data: allPurch }, { data: allRet }, { data: allSales }, { data: recipeData }] = trendResults
    if (loadIdRef.current !== myId) return // superseded by a newer client switch

    const hadRealError = closedErr || trendResults.some(r => r.error)
    setLoadErrors(prev => ({ ...prev, fcTrend: hadRealError ? 'Food Cost % trend failed to load.' : '' }))

    const priceMap = {}
    ;(recipeData || []).forEach(r => { priceMap[r.id] = parseFloat(r.selling_price || 0) })

    // Grouped by period_id in one pass each, instead of re-filtering the full purchases/returns/
    // sales arrays once per period below (O(periods × rows) → O(rows)) — bounded by the .limit(11)
    // above so it never ran away, but scales with purchase/sales volume across those 11 months.
    const grossMap = {}, retMap = {}, revMap = {}
    ;(allPurch || []).forEach(e => { grossMap[e.period_id] = (grossMap[e.period_id] || 0) + parseFloat(e.qty) * parseFloat(e.rate) })
    ;(allRet   || []).forEach(e => { retMap[e.period_id]   = (retMap[e.period_id]   || 0) + parseFloat(e.qty) * parseFloat(e.rate) })
    // unit_price captured on the row when present, else falls back to the recipe's current
    // price — this 11-month trend is exactly where always using today's price hurt most,
    // since a single menu price change would retroactively distort every past month's Food
    // Cost % line on the chart.
    ;(allSales || []).forEach(e => {
      if (e.source === 'pos_comp') return
      const price = e.unit_price != null ? parseFloat(e.unit_price) : (priceMap[e.recipe_id] || 0)
      revMap[e.period_id] = (revMap[e.period_id] || 0) + parseFloat(e.qty_sold) * price - (parseFloat(e.discount) || 0)
    })

    const points = closed.map(p => {
      const net = (grossMap[p.id] || 0) - (retMap[p.id] || 0)
      const rev = revMap[p.id] || 0
      const fc  = rev > 0 ? parseFloat(((net / rev) * 100).toFixed(1)) : null
      return { label: `${BS_MONTHS_SHORT[p.bs_month - 1]} ${p.bs_year}`, fc, purchases: Math.round(net), revenue: Math.round(rev), open: false }
    }).reverse()

    if (currentPeriod) {
      const net = (grossMap[currentPeriod.id] || 0) - (retMap[currentPeriod.id] || 0)
      const rev = revMap[currentPeriod.id] || 0
      const fc  = rev > 0 ? parseFloat(((net / rev) * 100).toFixed(1)) : null
      if (fc != null) {
        // Purchases/revenue were withheld here (null) so the tooltip would omit them, which left
        // the one point most likely to look alarming as the only one you could not interrogate.
        // They are carried now; `open` is what the tooltip and the dot key off to say "so far".
        points.push({
          label: `${BS_MONTHS_SHORT[currentPeriod.bs_month - 1]} ${currentPeriod.bs_year}`,
          fc, purchases: Math.round(net), revenue: Math.round(rev), open: true
        })
      }
    }

    setAndCache(setFcTrend, 'fcTrend', points.filter(p => p.fc !== null))
  }

  const bsToday      = getBsToday()
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
  const bsNow = getBsToday()
  const isCurrentPeriod = !!activePeriod && activePeriod.bs_year === bsNow.year && activePeriod.bs_month === bsNow.month
  const periodDays = activePeriod ? daysInBsMonth(activePeriod.bs_year, activePeriod.bs_month) : 30
  const dayOfPeriod = isCurrentPeriod ? bsNow.day : periodDays
  // Ten days is roughly where a single bulk purchase stops dominating a month's sales base. Before
  // that the ratio is arithmetic, not a signal.
  const SETTLE_DAY = 10
  const periodTooEarly = isCurrentPeriod && dayOfPeriod < SETTLE_DAY
  const partialNote = isCurrentPeriod ? `Day ${dayOfPeriod} of ${periodDays} · settles at month end` : null
  // Grey, not green/amber/red, while the ratio is still meaningless. A neutral number that says
  // "not yet meaningful" is more trustworthy than a red one that isn't true.
  const verdict = (value, bands) => {
    if (value == null) return 'var(--theme-text2)'
    if (periodTooEarly) return 'var(--theme-text1)'
    return bands(value)
  }

  const fcPct = stats?.revenueTotal > 0 ? (stats.purchaseTotal / stats.revenueTotal) * 100 : null
  const ohPct = stats?.revenueTotal > 0 && stats?.overheadTotal > 0 ? (stats.overheadTotal / stats.revenueTotal) * 100 : null
  const netMarginPct = stats?.revenueTotal > 0
    ? ((stats.revenueTotal - stats.purchaseTotal - (stats.overheadTotal || 0)) / stats.revenueTotal) * 100
    : null
  // Computed once per render instead of inside the pie-legend .map() below, where every row was
  // redundantly re-reducing the same, unchanging total.
  const categorySpendTotal = categorySpend.reduce((s, r) => s + r.value, 0)

  // Screen-reader-only chart summaries — the 4 charts below have no text alternative today;
  // a non-sighted user gets zero information from a trend/proportion a sighted user reads at a
  // glance. Rendered via ChartCard's `footer` slot (inside the same card, so it doesn't add an
  // extra grid item the way a sibling element would).
  const categorySpendSummary = categorySpend.length === 0
    ? 'No purchase data for this period.'
    : `Top spend category: ${categorySpend[0].name} at NPR ${categorySpend[0].value.toLocaleString('en-NP')}${categorySpendTotal > 0 ? ` (${Math.round((categorySpend[0].value / categorySpendTotal) * 100)}% of total purchases)` : ''}.`
  // Compact card window — 6 days back → 3 days ahead of today, sliced out of the full-month
  // `dailyTrend` array so the small glanceable card stays readable; the expanded modal (`big`
  // in renderChart below) uses the full `dailyTrend` array instead.
  const dailyTrendWindowed = (() => {
    if (dailyTrend.length <= 10) return dailyTrend
    const bsToday = getBsToday()
    const todayIdx = dailyTrend.findIndex(d => d.day === `Day ${bsToday.day}`)
    if (todayIdx === -1) return dailyTrend.slice(-10)
    return dailyTrend.slice(Math.max(0, todayIdx - 6), todayIdx + 4)
  })()
  const dailyTrendPurchTotal = dailyTrend.reduce((s, d) => s + (d.purchases || 0), 0)
  const dailyTrendSalesTotal = dailyTrend.reduce((s, d) => s + (d.sales || 0), 0)
  const dailyTrendSummary = dailyTrend.length === 0
    ? 'No purchase or sales data for this period.'
    : `Purchases and sales trend, ${periodLabel}. Purchases shown so far total NPR ${dailyTrendPurchTotal.toLocaleString('en-NP')}.${hasDailySales ? ` Sales shown so far total NPR ${dailyTrendSalesTotal.toLocaleString('en-NP')}.` : ''}${salesProjection ? ` Projected month-end revenue: NPR ${salesProjection.projectedMonthEnd.toLocaleString('en-NP')}.` : ''}${purchProjection ? ` Projected month-end purchases: NPR ${purchProjection.projectedMonthEnd.toLocaleString('en-NP')}.` : ''}${salesTargetSnap ? ` Sales target locked on Day ${salesTargetSnap.capturedDay}: NPR ${salesTargetSnap.projectedMonthEnd.toLocaleString('en-NP')}.` : ''}${purchTargetSnap ? ` Purchase target locked on Day ${purchTargetSnap.capturedDay}: NPR ${purchTargetSnap.projectedMonthEnd.toLocaleString('en-NP')}.` : ''}`
  const topItemSpendSummary = topItemSpend.length === 0
    ? 'No purchase data for this period.'
    : `Top items by spend: ${topItemSpend.slice(0, 3).map(i => `${i.fullName} at NPR ${i.value.toLocaleString('en-NP')}`).join(', ')}.`
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
  const fcSettled      = fcTrend.filter(p => !p.open)
  // Blended (total purchases ÷ total revenue), not the mean of the monthly ratios: a mean weights a
  // quiet month equally with a busy one and is not a food cost % of anything.
  const fcSettledRev   = fcSettled.reduce((sum, p) => sum + (p.revenue || 0), 0)
  const fcSettledPurch = fcSettled.reduce((sum, p) => sum + (p.purchases || 0), 0)
  const fcTrendAvg     = fcSettledRev > 0 ? (fcSettledPurch / fcSettledRev) * 100 : null
  const fcTrendBest    = fcSettled.length > 0 ? fcSettled.reduce((best, p) => p.fc < best.fc ? p : best) : null
  const fcTrendWorst   = fcSettled.length > 0 ? fcSettled.reduce((worst, p) => p.fc > worst.fc ? p : worst) : null
  const fcBands        = fcThresholds(settings)
  // fcBand() returns CSS var() strings, which do not resolve inside an SVG fill — so the bands come
  // from the client's own thresholds while the colours come from the resolved theme palette.
  const fcDotColor = pct => pct == null ? colors.text3
    : pct <= fcBands.warn     ? colors.greenText
    : pct <= fcBands.critical ? colors.amberText
    : colors.redText
  const fcTrendSummary = fcChartData.length === 0
    ? 'No food cost history yet.'
    : `Food cost percentage over the last ${fcChartData.length} month${fcChartData.length === 1 ? '' : 's'}: ${fcChartData.map(p => `${p.label} ${p.fc}%${p.open ? ' so far, month still open' : ''}`).join(', ')}.${fcTrendAvg != null ? ` Average across completed months: ${fcTrendAvg.toFixed(1)}%.` : ''}${fcOpenTooEarly ? ` ${fcOpenPoint.label} is only ${dayOfPeriod} days in and is not shown yet.` : ''}`

  // Revenue vs Cost Breakdown pie — a "P&L at a glance" composition of exactly the figures behind
  // the Est. Net Margin % card (revenue minus food cost and overheads), in the standard restaurant
  // P&L order: Food Cost → Labor → Overheads → Tax & Fees → what's left.
  //
  // Labor comes from the Overheads page's own `labor` bucket, NOT from HR payroll. Until S526 this
  // chart drew `stats.overheadTotal` (which is all three buckets summed, labor included) as one
  // "Overheads" slice AND added `hrStats.payroll` on top as a separate "Labor (basic)" slice — so
  // every rupee of labor was counted twice and the pie's own total came out well above the total
  // cost the net-margin figure beside it was computed from (found live: NPR 454k of slices against
  // a 401k cost base, with the -57.2% margin correctly reflecting only the 401k). OwnerDashboard
  // already avoids this by querying `.eq('bucket','overhead')` before subtracting HR payroll
  // separately; this page keeps all three buckets (its KPI cards mean the combined figure) and
  // splits them for display instead, so the slices always sum to exactly the cost base behind the
  // margin. Pro-gated same as netMarginCard since overheads are a Pro-only figure.
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
  // exemption CHART_COLORS already relies on.
  const COST_BREAKDOWN_COLORS = {
    'Food Cost':  '#c9a84c', // gold — kept, so the slice ties to the Food Cost % card/trend line
    'Labor':      '#60a5fa', // blue
    'Overheads':  '#8b5cf6', // violet
    'Tax & Fees': '#ec4899', // pink
    'Net Margin': '#34d399', // green — the one slice that stays semantic (profit reads as good)
  }
  // Falls back to one combined slice for a `stats` object restored from a pre-S526 session cache,
  // which has overheadTotal but no overheadBuckets — still correct, just less broken out.
  const ohBuckets = stats?.overheadBuckets
  const costBreakdown = [
    { name: 'Food Cost', value: Math.max(0, stats?.purchaseTotal || 0) },
    ...(ohBuckets
      ? [
          { name: 'Labor',      value: Math.max(0, ohBuckets.labor || 0) },
          { name: 'Overheads',  value: Math.max(0, ohBuckets.overhead || 0) },
          { name: 'Tax & Fees', value: Math.max(0, ohBuckets.tax_fees || 0) },
        ]
      : [{ name: 'Overheads', value: Math.max(0, stats?.overheadTotal || 0) }]),
    ...(netMarginPct != null && netMarginPct > 0
      ? [{ name: 'Net Margin', value: Math.max(0, (stats.revenueTotal || 0) - (stats.purchaseTotal || 0) - (stats.overheadTotal || 0)) }]
      : []),
  ].filter(r => r.value > 0)
  const costBreakdownTotal = costBreakdown.reduce((s, r) => s + r.value, 0)
  // HR is running real payroll but nobody has filled the Overheads page's Labor bucket for this
  // period — so labor is genuinely missing from the split above rather than double-counted. Say so
  // instead of quietly substituting the payroll figure, which would no longer tie to Est. Net
  // Margin % (that card, and this pie, are both driven by the Overheads page's numbers).
  const laborBucketMissing = clientModules.hr && hrStats?.payroll > 0 && ohBuckets && !(ohBuckets.labor > 0)
  const costBreakdownSummary = costBreakdown.length === 0
    ? 'No cost data for this period.'
    : `Revenue breakdown this period: ${costBreakdown.map(r => `${r.name} NPR ${Math.round(r.value).toLocaleString('en-NP')}`).join(', ')}. Net margin: ${netMarginPct != null ? `${netMarginPct.toFixed(1)}%` : '—'}.${laborBucketMissing ? ` Labor is not included — the Overheads page's Labor bucket is empty for this period, though HR payroll is NPR ${Math.round(hrStats.payroll).toLocaleString('en-NP')}.` : ''}`

  // Shared mini card style + a11y — returns a spreadable props object so every KPI card gets
  // keyboard support (role/tabIndex/onKeyDown) and a visible focus ring for free, instead of each
  // clickable div being mouse-only. Non-interactive cards (onClick == null) get style only.
  const kpiCard = (onClick) => ({
    style: {
      background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-lg)',
      boxShadow: 'var(--theme-card-shadow)',
      padding: '10px 14px', cursor: onClick ? 'pointer' : 'default',
      transition: 'border-color var(--motion-fast) var(--ease-standard)'
    },
    ...(onClick ? {
      onClick,
      role: 'button',
      tabIndex: 0,
      className: 'interactive-card',
      onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } }
    } : {})
  })
  // The "N more" disclosure button — currently only IMS's reference-card row uses this (see the
  // openDetails note above for why HR/POS don't), kept generic on (key, count, panelId) in case a
  // genuinely reference-only row shows up in another section later.
  const detailsToggle = (key, count, panelId) => (
    <button
      type="button"
      onClick={() => toggleDetails(key)}
      aria-expanded={openDetails[key]}
      aria-controls={panelId}
      className="btn btn-ghost"
      style={{ fontSize: 11, padding: '4px 10px', marginTop: 10, display: 'inline-flex', alignItems: 'center', gap: 4 }}
    >
      {openDetails[key] ? 'Hide details' : `Show ${count} more`}
      <ChevronDown size={12} aria-hidden="true" style={{ transform: openDetails[key] ? 'rotate(180deg)' : 'none', transition: 'transform var(--motion-fast) var(--ease-standard)' }} />
    </button>
  )
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
      className="interactive-card"
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate('/pricing') } }}
      style={{
        background: 'color-mix(in srgb, var(--theme-purple) 8%, transparent)',
        border: '1px dashed color-mix(in srgb, var(--theme-purple) 40%, transparent)',
        borderRadius: 'var(--radius-lg)', padding: '10px 14px', cursor: 'pointer', transition: 'border-color var(--motion-fast) var(--ease-standard)'
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
  const showIms = clientModules.ims && hasImsAccess('staff')
  const showHr  = clientModules.hr && hasHrAccess('staff')
  const showPos = clientModules.pos
  const moduleCount = [showIms, showHr, showPos].filter(Boolean).length
  const dashTitle = isAdmin
    ? 'Admin Dashboard'
    : moduleCount > 1 ? 'Dashboard'
    : showIms ? 'Inventory Dashboard'
    // Not 'HR Dashboard' — that's the title of the real, richer page at /hr/dashboard
    // (HrDashboard.jsx: headcount, leave/OT queues, SSF, advances). This is a lighter summary
    // on the universal route; an identical title on two different pages was confusing.
    : showHr  ? 'HR Overview'
    : showPos ? 'POS Dashboard'
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
    ? <h2 style={{ fontSize: 11, fontWeight: 400, margin: '0 0 10px', color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{text}</h2>
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
  const { buckets: salesMixBuckets, loading: salesMixLoading } = useFoodBeverageSplit({
    activePeriod, includeManual: salesMixIncludeManual, includePos: salesMixIncludePos,
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
    : `Sales mix this period: ${salesMixCategories.map(c => `${c} NPR ${Math.round(salesMixBuckets[c]).toLocaleString('en-NP')} (${((salesMixBuckets[c] / salesMixTotal) * 100).toFixed(0)}%)`).join(', ')}.`
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
        {loading ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : `NPR ${(stats?.purchaseTotal || 0).toLocaleString('en-NP', { maximumFractionDigits: 0 })}`}
      </div>
      <div style={kpiSubtextStyle}>Gross − returns · {periodLabel} →</div>
    </div>
  )

  const revenueCard = canSales ? (
    <div {...kpiCard(() => navigate('/sales'))}>
      <div style={kpiLabelStyle}>Revenue</div>
      <div style={{ ...kpiValueStyle(18), color: 'var(--theme-green-text)' }}>
        {loading ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : `NPR ${(stats?.revenueTotal || 0).toLocaleString('en-NP', { maximumFractionDigits: 0 })}`}
      </div>
      <div style={kpiSubtextStyle}>From sales entries →</div>
    </div>
  ) : null

  const foodCostCard = canSales ? (
    <div {...kpiCard(() => navigate(canVariance ? '/variance' : '/summary'))}>
      <div style={kpiLabelStyle}>
        {/* Keeps the industry label — Owner Dashboard, the Group Console, the Monthly Owner Report,
            Period Comparison and Help's glossary all call this Food Cost %, and renaming it on one
            page out of six would trade a small precision gain for a real consistency loss. What is
            fixed is the DESCRIPTION: this figure divides purchases by sales and ignores opening and
            closing stock entirely (the deliberate periodic model), so "what portion of sales goes to
            ingredient cost" was telling a non-accountant owner something the number does not say.
            Whether the whole product should adopt a more literal name is a product-wide call. */}
        <Tip text="What you spent on stock this period, against what you sold. Buy a month of rice in one go and this spikes — it settles once you finish the month-end stock count. Healthy range once settled: 28–35% for Nepal F&B." width={260}>Food Cost %</Tip>
      </div>
      <div style={{
        ...kpiValueStyle(22, 800),
        // Client-configured thresholds, not a fourth hardcoded copy of 35/45 — Settings offers
        // fc_warning_pct/fc_critical_pct and this card is the headline they were added for.
        color: verdict(fcPct, v => v <= fcBands.warn ? 'var(--theme-green-text)' : v <= fcBands.critical ? 'var(--theme-amber-text)' : 'var(--theme-red-text)')
      }}>
        {loading ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : fcPct != null ? `${fcPct.toFixed(1)}%` : '—'}
      </div>
      <div style={kpiSubtextStyle}>
        {partialNote
          ? partialNote
          : <><Tip text="Industry benchmark for Nepal cafes & restaurants. Green = healthy, yellow = watch, red = investigate immediately." width={240}>Target 28–35%</Tip> →</>}
      </div>
    </div>
  ) : null

  const fixedCostsCard = canOverheads ? (
    <div {...kpiCard(() => navigate('/overheads'))}>
      <div style={kpiLabelStyle}>
        <Tip text="All fixed costs (rent, utilities, labor, tax & fees) as a % of revenue. Target: under 60% combined. See Overheads page for the full breakdown." width={250}>Fixed Costs % of Revenue</Tip>
      </div>
      <div style={{
        ...kpiValueStyle(22, 800),
        color: ohPct == null ? 'var(--theme-text2)' : ohPct <= 50 ? 'var(--theme-green-text)' : ohPct <= 65 ? 'var(--theme-accent-ink)' : 'var(--theme-red-text)'
      }}>
        {loading ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : ohPct != null ? `${ohPct.toFixed(1)}%` : '—'}
      </div>
      <div style={kpiSubtextStyle}>
        {stats?.overheadTotal ? `NPR ${stats.overheadTotal.toLocaleString('en-NP', { maximumFractionDigits: 0 })} total →` : 'No overhead data'}
      </div>
    </div>
  ) : (
    <UpsellCard label="Fixed Costs & Net Margin" tier="Pro" blurb="See true profit after rent, labor & tax" />
  )

  const netMarginCard = canOverheads ? (
    <div {...kpiCard(null)}>
      <div style={kpiLabelStyle}>
        <Tip text="Revenue minus food cost and every overhead bucket — including labor and tax & fees — as a % of revenue. This is what the business keeps after ingredient and fixed costs. Healthy Nepal F&B target: ≥20%." width={260}>Est. Net Margin %</Tip>
      </div>
      <div style={{
        ...kpiValueStyle(22, 800),
        color: verdict(netMarginPct, v => v >= 20 ? 'var(--theme-green-text)' : v >= 10 ? 'var(--theme-accent-ink)' : 'var(--theme-red-text)')
      }}>
        {loading ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : netMarginPct != null ? `${netMarginPct.toFixed(1)}%` : '—'}
      </div>
      {/* Inherits Food Cost's lumpiness through purchaseTotal, so it carries the same caveat. */}
      <div style={kpiSubtextStyle}>{partialNote || 'After food & overheads · target ≥20%'}</div>
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
            ? `NPR ${Math.round(stats.menuOpportunityTotal).toLocaleString('en-NP')}/mo opportunity →`
            : 'dishes under target →'}
      </div>
    </div>
  ) : (
    <UpsellCard label="Menu Health" tier="Growth" blurb="Spot underpriced dishes & lost margin" />
  )

  const wastageCard = (
    <div {...kpiCard(() => navigate('/wastage-report'))}>
      <div style={kpiLabelStyle}>
        <Tip text="Total NPR value of wastage recorded this period — qty wasted × unit rate per item." width={220}>Wastage Value</Tip>
      </div>
      <div style={{ ...kpiValueStyle(18), color: stats?.wastageValueTotal > 0 ? 'var(--theme-red-text)' : 'var(--theme-text1)' }}>
        {loading ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : `NPR ${Math.round(stats?.wastageValueTotal || 0).toLocaleString('en-NP')}`}
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
  const hrHeadlineCard = (
    <div {...kpiCard(() => navigate('/hr/dashboard'))}>
      <div style={kpiLabelStyle}>Pending Approvals</div>
      <div style={{ ...kpiValueStyle(22, 800), color: hrApprovals.total > 0 ? 'var(--theme-amber-text)' : 'var(--theme-text1)' }}>
        {hrApprovals.loading ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : hrApprovals.total}
      </div>
      <div style={kpiSubtextStyle}>
        {hrApprovals.loading ? 'Loading…' : `${hrApprovals.leave} Leave · ${hrApprovals.ot} OT · ${hrApprovals.tada} TADA · ${hrApprovals.swap} Swap →`}
      </div>
    </div>
  )

  const hrSecondaryCards = (
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
          <Tip text="Sum of basic salary for active and probation employees. Full payroll with allowances, SSF and TDS is computed during payroll run." width={260}>Basic Payroll / Month</Tip>
        </div>
        <div style={{ ...kpiValueStyle(18, 800), color: 'var(--theme-accent-ink)' }}>
          {!hrStats
            ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} />
            : `NPR ${Math.round(hrStats.payroll).toLocaleString('en-NP')}`}
        </div>
        <div style={kpiSubtextStyle}>Basic salary only</div>
      </div>
    </>
  )

  const posKitchenHeadlineCard = (
    <div {...kpiCard(() => navigate('/pos/kds'))}>
      <div style={kpiLabelStyle}>Open Tickets</div>
      <div style={kpiValueStyle(22, 800)}>
        {!posStats ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : posStats.openNow}
      </div>
      <div style={kpiSubtextStyle}>
        {!posStats
          ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} />
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
        <div style={{ ...kpiValueStyle(18), color: posStats?.lateCount > 0 ? 'var(--theme-red-text)' : 'var(--theme-text1)' }}>
          {!posStats ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : posStats.lateCount}
        </div>
        <div style={kpiSubtextStyle}>&gt; 15 min →</div>
      </div>
      <div {...kpiCard(() => navigate('/pos/kds'))}>
        <div style={kpiLabelStyle}>Ready &amp; Waiting</div>
        <div style={kpiValueStyle(18)}>
          {!posStats ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : posStats.readyWaiting}
        </div>
        <div style={kpiSubtextStyle}>Last 20 min →</div>
      </div>
      <div {...kpiCard(null)}>
        <div style={kpiLabelStyle}>Avg Prep Time</div>
        <div style={kpiValueStyle(18)}>
          {!posStats
            ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} />
            : posStats.avgPrepMin != null ? `${posStats.avgPrepMin} min` : '—'}
        </div>
        <div style={kpiSubtextStyle}>
          {!posStats
            ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} />
            : <>{posStats.completedToday} completed today</>}
        </div>
      </div>
    </>
  )

  const posFrontHeadlineCard = (
    <div {...kpiCard(() => navigate('/pos/sales-report'))}>
      <div style={kpiLabelStyle}>Revenue</div>
      <div style={{ ...kpiValueStyle(22, 800), color: 'var(--theme-green-text)' }}>
        {!posStats ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : `NPR ${Math.round(posStats.revenueTotal).toLocaleString('en-NP')}`}
      </div>
      <div style={kpiSubtextStyle}>{periodLabel} · billed →</div>
    </div>
  )

  const posFrontSecondaryCards = (
    <>
      <div {...kpiCard(() => navigate('/pos/covers-report'))}>
        <div style={kpiLabelStyle}>
          <Tip text="Total covers (guests) served across all billed orders this period." width={220}>Covers Served</Tip>
        </div>
        <div style={kpiValueStyle(18)}>
          {!posStats ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : posStats.coversTotal}
        </div>
        <div style={kpiSubtextStyle}>
          {!posStats
            ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} />
            : <>{posStats.billCount} bill{posStats.billCount === 1 ? '' : 's'} →</>}
        </div>
      </div>
      <div {...kpiCard(null)}>
        <div style={kpiLabelStyle}>Avg Check</div>
        <div style={kpiValueStyle(18)}>
          {!posStats ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : `NPR ${Math.round(posStats.avgCheck).toLocaleString('en-NP')}`}
        </div>
        <div style={kpiSubtextStyle}>Revenue ÷ bills</div>
      </div>
      <div {...kpiCard(hasPosAccess('manager') ? () => navigate('/pos/tables') : null)}>
        <div style={kpiLabelStyle}>Tables Occupied</div>
        <div style={{ ...kpiValueStyle(18), color: posStats?.tablesOccupied > 0 ? 'var(--theme-accent-ink)' : 'var(--theme-text1)' }}>
          {!posStats ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : `${posStats.tablesOccupied} / ${posStats.tablesTotal}`}
        </div>
        <div style={kpiSubtextStyle}>{hasPosAccess('manager') ? 'Right now →' : 'Right now'}</div>
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
      <div className="dash-spend-purchases-row" style={{ marginBottom: 14 }}>

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
                    <div className="chart-stat-strip" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
                      <StatPill label="Total spend" value={`NPR ${categorySpendTotal.toLocaleString()}`} />
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
                        contentStyle={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', fontSize: 11 }}
                        formatter={(v, name) => [`NPR ${Number(v).toLocaleString()} (${((v / categorySpendTotal) * 100).toFixed(1)}%)`, name]}
                        labelFormatter={name => name}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px', marginTop: 6 }}>
                    {categorySpend.map((entry, i) => {
                      return (
                        <div key={entry.name} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                          <div style={{ width: 8, height: 8, borderRadius: 'var(--radius-full)', background: CHART_COLORS[i % CHART_COLORS.length], flexShrink: 0 }} />
                          <span style={{ fontSize: 11, color: 'var(--theme-text2)' }}>{entry.name}</span>
                          {big && <span style={{ fontSize: 11, color: 'var(--theme-text1)', fontWeight: 600 }}>NPR {entry.value.toLocaleString()}</span>}
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
                  <div className="chart-stat-strip" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
                    <StatPill label={`Top ${shown.length} total`} value={`NPR ${shownTotal.toLocaleString()}`} color={colors.accent} />
                    <StatPill label="Top item" value={shown[0].fullName || shown[0].name} color={CHART_COLORS[0]} />
                    {purchaseTotal > 0 && <StatPill label="Share of net purchases" value={`${((shownTotal / purchaseTotal) * 100).toFixed(0)}%`} />}
                  </div>
                )}
                <ResponsiveContainer width="100%" height={big ? contentH - 60 : contentH}>
                  <BarChart data={shown} layout="vertical" margin={{ top: 0, right: 8, bottom: 0, left: 0 }}>
                    <XAxis type="number" hide />
                    <YAxis type="category" dataKey="name" tick={{ fill: colors.text3, fontSize: big ? 11 : 9 }} tickLine={false} axisLine={false} width={big ? 130 : 90} />
                    <Tooltip
                      contentStyle={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', fontSize: 11 }}
                      formatter={(v, n, p) => [`NPR ${Number(v).toLocaleString()}${purchaseTotal > 0 ? ` (${((v / purchaseTotal) * 100).toFixed(1)}% of purchases)` : ''}`, p.payload.fullName || n]}
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
          smallHeight={160}
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
            {salesTargetSnap && (
              <span style={{ color: 'var(--theme-text2)' }}>
                <span style={{ color: DAILY_TREND_COLORS.salesTarget, letterSpacing: '-2px' }}>⋯</span>{' '}
                <Tip text={`Locked in on Day ${salesTargetSnap.capturedDay} from your first few days' pace, and never changes for the rest of ${periodLabel}. Compare your actual sales line against it to see if you're ahead or behind pace — unlike Sales Proj. above, which updates every day to reflect today's pace instead.`}>Sales Target</Tip>
              </span>
            )}
            {purchTargetSnap && (
              <span style={{ color: 'var(--theme-text2)' }}>
                <span style={{ color: DAILY_TREND_COLORS.purchTarget, letterSpacing: '-2px' }}>⋯</span>{' '}
                <Tip text={`Locked in on Day ${purchTargetSnap.capturedDay} from your first few days' pace, and never changes for the rest of ${periodLabel}. Compare your actual purchases line against it to see if you're ahead or behind pace — unlike Purch. Proj. above, which updates every day to reflect today's pace instead.`}>Purch. Target</Tip>
              </span>
            )}
            {!hasDailySales && <span style={{ color: 'var(--theme-text3)' }}>Enter daily sales to see the sales trend</span>}
          </>}
          footer={<>
            {(salesProjection || purchProjection || salesTargetSnap || purchTargetSnap) && (
              <div style={{ marginTop: 8, fontSize: 11, color: 'var(--theme-text2)', display: 'flex', flexWrap: 'wrap', gap: '2px 16px' }}>
                {salesProjection && (
                  <span>
                    Projected month-end revenue: <strong style={{ color: 'var(--theme-purple-text)' }}>NPR {salesProjection.projectedMonthEnd.toLocaleString()}</strong>
                  </span>
                )}
                {purchProjection && (
                  <span>
                    Projected month-end purchases: <strong style={{ color: 'var(--theme-red-text)' }}>NPR {purchProjection.projectedMonthEnd.toLocaleString()}</strong>
                  </span>
                )}
                {salesTargetSnap && (
                  <span>
                    Sales target (locked Day {salesTargetSnap.capturedDay}): <strong style={{ color: 'var(--theme-purple-text)' }}>NPR {salesTargetSnap.projectedMonthEnd.toLocaleString()}</strong>
                  </span>
                )}
                {purchTargetSnap && (
                  <span>
                    Purchase target (locked Day {purchTargetSnap.capturedDay}): <strong style={{ color: 'var(--theme-red-text)' }}>NPR {purchTargetSnap.projectedMonthEnd.toLocaleString()}</strong>
                  </span>
                )}
                <span style={{ color: 'var(--theme-text3)' }}>· trend estimate</span>
              </div>
            )}
            <p className="sr-only">{dailyTrendSummary}</p>
          </>}
          renderChart={h => {
            if (dailyTrend.length === 0) return (
              <div style={{ height: h, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <p style={{ color: 'var(--theme-text3)', fontSize: 12 }}>No purchase or sales data</p>
              </div>
            )
            const big = h > 200
            const chartData = big ? dailyTrend : dailyTrendWindowed
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
                  <XAxis dataKey="day" tick={dayAxisTick} height={big ? 32 : 26} tickLine={false} axisLine={false} interval={0} />
                  <YAxis tick={{ fill: colors.text3, fontSize: big ? 11 : 9 }} tickLine={false} axisLine={false} tickFormatter={v => `${(v / 1000).toFixed(0)}k`} width={big ? 40 : 32} />
                  {/* Custom content rather than contentStyle/formatter: the dashed projection
                      series anchor at the last actual day so the line connects (see the trend
                      build above), and Recharts' default tooltip can't tell an anchor from a
                      forecast — on that one day it listed "Sales Projection: NPR 13,721" right
                      under an identical "Sales: NPR 13,721", restating the actual under a label
                      that claims it was computed. A projection row is only shown on days that
                      have no actual for the same metric. */}
                  <Tooltip
                    content={({ active, payload, label }) => {
                      if (!active || !payload?.length) return null
                      const row = payload[0]?.payload || {}
                      const shown = payload.filter(en => {
                        if (en.value == null) return false
                        if (en.dataKey === 'salesProj' && row.sales != null) return false
                        if (en.dataKey === 'purchProj' && row.purchases != null) return false
                        return true
                      })
                      if (!shown.length) return null
                      return (
                        <div style={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', fontSize: big ? 12 : 11, padding: '8px 12px' }}>
                          <p style={{ color: colors.text1, margin: 0, fontWeight: 600 }}>{label}</p>
                          {shown.map(en => (
                            <p key={en.dataKey} style={{ color: en.color, margin: '4px 0 0' }}>
                              {en.name} : NPR {Math.round(Number(en.value)).toLocaleString()}
                            </p>
                          ))}
                        </div>
                      )
                    }}
                  />
                  {/* Frozen full-month reference lines, drawn first (so they sit BEHIND the more
                      prominent actual/adaptive-projection lines below) — thin, dotted, and each in
                      its own hue (DAILY_TREND_COLORS.salesTarget/purchTarget) rather than reusing
                      Purchases/Sales' gold/green, so it doesn't collapse into a same-colour dash
                      variant of the line already sharing this metric's hue. Never moves once
                      captured; see targetLineValue()/salesTargetSnap above for why that's the point. */}
                  {salesTargetSnap && <Line type="monotone" dataKey="salesTarget" name="Sales Target" stroke={DAILY_TREND_COLORS.salesTarget} strokeWidth={1.5} strokeDasharray="2 3" strokeOpacity={0.75} connectNulls dot={false} {...chartMotion()} />}
                  {purchTargetSnap && <Line type="monotone" dataKey="purchTarget" name="Purchases Target" stroke={DAILY_TREND_COLORS.purchTarget} strokeWidth={1.5} strokeDasharray="2 3" strokeOpacity={0.75} connectNulls dot={false} {...chartMotion()} />}
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
                  {salesProjection && <Line type="monotone" dataKey="salesProj" name="Sales Projection" stroke={DAILY_TREND_COLORS.sales} strokeWidth={2} strokeDasharray="5 4" strokeOpacity={0.85} connectNulls dot={false} activeDot={{ r: big ? 4 : 3, fill: DAILY_TREND_COLORS.sales }} {...chartMotion()} />}
                  {purchProjection && <Line type="monotone" dataKey="purchProj" name="Purchases Projection" stroke={DAILY_TREND_COLORS.purchases} strokeWidth={2} strokeDasharray="5 4" strokeOpacity={0.85} connectNulls dot={false} activeDot={{ r: big ? 4 : 3, fill: DAILY_TREND_COLORS.purchases }} {...chartMotion()} />}
                </ComposedChart>
              </ResponsiveContainer>
            )
            return (
              <>
                {big && (
                  <div className="chart-stat-strip" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
                    <StatPill label="Purchases so far" value={`NPR ${dailyTrendPurchTotal.toLocaleString()}`} color={DAILY_TREND_COLORS.purchases} />
                    {hasDailySales && <StatPill label="Sales so far" value={`NPR ${dailyTrendSalesTotal.toLocaleString()}`} color={DAILY_TREND_COLORS.sales} />}
                    {salesProjection && <StatPill label="Projected sales" value={`NPR ${salesProjection.projectedMonthEnd.toLocaleString()}`} color={DAILY_TREND_COLORS.sales} />}
                    {purchProjection && <StatPill label="Projected purchases" value={`NPR ${purchProjection.projectedMonthEnd.toLocaleString()}`} color={DAILY_TREND_COLORS.purchases} />}
                    {salesTargetSnap && <StatPill label="Sales target" value={`NPR ${salesTargetSnap.projectedMonthEnd.toLocaleString()}`} color={DAILY_TREND_COLORS.salesTarget} />}
                    {purchTargetSnap && <StatPill label="Purchase target" value={`NPR ${purchTargetSnap.projectedMonthEnd.toLocaleString()}`} color={DAILY_TREND_COLORS.purchTarget} />}
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
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14, marginBottom: 14 }}>

          {fcTrend.length >= 2 && canSales && (
            <ChartCard
              title="Food Cost % — Monthly Trend"
              footer={<>
                <div style={{ display: 'flex', gap: 16, marginTop: 6, fontSize: 11, flexWrap: 'wrap' }}>
                  <span style={{ color: 'var(--theme-green-text)' }}>● ≤{fcBands.warn}% Good</span>
                  <span style={{ color: 'var(--theme-amber-text)' }}>● {fcBands.warn}–{fcBands.critical}% Watch</span>
                  <span style={{ color: 'var(--theme-red-text)' }}>● &gt;{fcBands.critical}% High</span>
                  {!fcOpenTooEarly && <span style={{ marginLeft: 'auto', color: 'var(--theme-text2)' }}>⊙ = current open period, part-month</span>}
                </div>
                {/* A withheld month is stated, not silently dropped — otherwise the chart quietly
                    claims the current month has no figure at all. */}
                {fcOpenTooEarly && (
                  <div style={{ fontSize: 11, marginTop: 6, color: 'var(--theme-text2)' }}>
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
                  {big && fcTrendAvg != null && (
                    <div className="chart-stat-strip" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
                      <StatPill label={`Average · ${fcSettled.length} completed month${fcSettled.length === 1 ? '' : 's'}`} value={`${fcTrendAvg.toFixed(1)}%`} color={colors.text2} />
                      <StatPill label="Best month" value={`${fcTrendBest.label} (${fcTrendBest.fc}%)`} color={colors.greenText} textColor={colors.greenText} />
                      <StatPill label="Highest month" value={`${fcTrendWorst.label} (${fcTrendWorst.fc}%)`} color={colors.redText} textColor={colors.redText} />
                    </div>
                  )}
                  <div style={{ minWidth: Math.max(0, fcChartData.length * 64), height: big ? h - 60 : h }}>
                    <ResponsiveContainer width="100%" height={big ? h - 60 : h}>
                      <LineChart data={fcChartData} margin={{ top: 8, right: 48, bottom: 0, left: 0 }}>
                        <CartesianGrid stroke={colors.border} strokeDasharray="3 3" vertical={false} />
                        <XAxis dataKey="label" tick={{ fill: colors.text3, fontSize: 10 }} tickLine={false} axisLine={false} interval={0} />
                        <YAxis tick={{ fill: colors.text3, fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={v => `${v}%`} domain={['auto', 'auto']} width={36} />
                        <ReferenceLine y={fcBands.warn} stroke={colors.greenText} strokeDasharray="4 3" strokeOpacity={0.5} label={{ value: `${fcBands.warn}%`, fill: colors.greenText, fontSize: 9, position: 'right' }} />
                        <ReferenceLine y={fcBands.critical} stroke={colors.redText} strokeDasharray="4 3" strokeOpacity={0.5} label={{ value: `${fcBands.critical}%`, fill: colors.redText, fontSize: 9, position: 'right' }} />
                        {big && fcTrendAvg != null && <ReferenceLine y={fcTrendAvg} stroke={colors.text2} strokeDasharray="2 3" strokeOpacity={0.85} label={{ value: `avg ${fcTrendAvg.toFixed(1)}%`, fill: colors.text2, fontSize: 9, position: 'insideBottomRight' }} />}
                        <Tooltip
                          contentStyle={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', fontSize: 11, color: 'var(--theme-text1)' }}
                          labelStyle={{ color: 'var(--theme-text1)' }}
                          itemStyle={{ color: 'var(--theme-text1)' }}
                          formatter={(v, _n, props) => {
                            const p = props.payload
                            const so = p.open ? ' so far' : ''
                            const lines = [`${v}%${p.open ? ' · part-month' : ''}`]
                            if (p.purchases != null) lines.push(`Purchases${so}: NPR ${p.purchases.toLocaleString('en-NP')}`)
                            if (p.revenue != null)   lines.push(`Revenue${so}: NPR ${p.revenue.toLocaleString('en-NP')}`)
                            return [lines.join(' · '), 'Food Cost %']
                          }}
                        />
                        <Line type="monotone" dataKey="fc" strokeWidth={2} stroke={colors.accentInk} connectNulls={false} {...chartMotion()}
                          dot={(props) => {
                            const { cx, cy, payload } = props
                            // An unfinished month wears no verdict colour — same rule as the KPI
                            // card above, which greys out rather than painting a part-month red.
                            const col = payload.open ? colors.text2 : fcDotColor(payload.fc)
                            return <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={payload.open ? 5 : 3} fill={col} stroke={payload.open ? colors.text1 : 'none'} strokeWidth={1.5} />
                          }}
                          activeDot={{ r: 5, fill: colors.accentInk }}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>
                )
              }}
            />
          )}

          {/* Pie — Revenue vs Cost Breakdown, tabbed with Sales Mix (S557 — see the note above
              costTabAvailable/mixTabAvailable). Cost Breakdown stays Pro-gated (canOverheads) since
              overheads, the biggest lever in the split, are a Pro-only figure — same gate as the
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
                  <div style={{ fontSize: 11, marginTop: 6, color: netMarginPct == null ? 'var(--theme-text2)' : netMarginPct >= 0 ? 'var(--theme-green-text)' : 'var(--theme-red-text)' }}>
                    Net margin: {netMarginPct != null ? `${netMarginPct.toFixed(1)}%` : '—'}
                    {netMarginPct != null && netMarginPct < 0 && ' — costs exceeded revenue this period'}
                  </div>
                  {/* Percentages below the slices are a share of whatever the pie actually contains,
                      which flips with the sign of the margin — say which, rather than leaving a bare
                      "23.4%" to be read against the wrong denominator. */}
                  <div style={{ fontSize: 11, marginTop: 2, color: 'var(--theme-text3)' }}>
                    {netMarginPct != null && netMarginPct > 0 ? '% of revenue' : '% of total cost'} · from Overheads page buckets
                  </div>
                  {laborBucketMissing && (
                    <div style={{ fontSize: 11, marginTop: 4, color: 'var(--theme-amber-text)' }}>
                      Labor not included — the Labor bucket on Overheads is empty this period, but HR payroll is NPR {Math.round(hrStats.payroll).toLocaleString('en-NP')}.
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
                        <div className="chart-stat-strip" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
                          <StatPill label="Revenue" value={`NPR ${(stats?.revenueTotal || 0).toLocaleString('en-NP', { maximumFractionDigits: 0 })}`} />
                          {/* Matches the Food Cost slice, not colors.accent — on a preset where accent
                              isn't gold the pill would otherwise disagree with the slice it summarizes. */}
                          {fcPct != null && <StatPill label="Food cost %" value={`${fcPct.toFixed(1)}%`} color={COST_BREAKDOWN_COLORS['Food Cost']} />}
                          <StatPill label="Net margin" value={netMarginPct != null ? `${netMarginPct.toFixed(1)}%` : '—'} color={netMarginPct == null ? undefined : netMarginPct >= 0 ? colors.green : colors.red} />
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
                            {costBreakdown.map(entry => <Cell key={entry.name} fill={COST_BREAKDOWN_COLORS[entry.name] || colors.text3} />)}
                          </Pie>
                          <Tooltip
                            contentStyle={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', fontSize: 11 }}
                            formatter={(v, name) => [`NPR ${Number(v).toLocaleString('en-NP', { maximumFractionDigits: 0 })} (${(v / costBreakdownTotal * 100).toFixed(1)}%)`, name]}
                          />
                        </PieChart>
                      </ResponsiveContainer>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 14px', marginTop: 6 }}>
                        {costBreakdown.map(entry => (
                          <div key={entry.name} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                            <div style={{ width: 8, height: 8, borderRadius: 'var(--radius-full)', background: COST_BREAKDOWN_COLORS[entry.name] || colors.text3, flexShrink: 0 }} />
                            <span style={{ fontSize: 11, color: 'var(--theme-text2)' }}>
                              {entry.name} <span style={{ color: 'var(--theme-text1)', fontWeight: 600 }}>NPR {entry.value.toLocaleString('en-NP', { maximumFractionDigits: 0 })}</span>
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
                      <div className="chart-stat-strip" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
                        <StatPill label="Total revenue" value={`NPR ${Math.round(salesMixTotal).toLocaleString('en-NP')}`} />
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
                          contentStyle={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', fontSize: 11 }}
                          formatter={(v, name) => [`NPR ${Math.round(v).toLocaleString('en-NP')} (${((v / salesMixTotal) * 100).toFixed(1)}%)`, name]}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 6 }}>
                      {salesMixCategories.map(cat => {
                        const amount = salesMixBuckets[cat]
                        const pct = (amount / salesMixTotal) * 100
                        return (
                          <div key={cat} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12.5 }}>
                            <span style={{ display: 'flex', alignItems: 'center', gap: 7, color: 'var(--theme-text1)' }}>
                              <span style={{ width: 8, height: 8, borderRadius: '50%', background: salesMixColorOf(cat), flexShrink: 0 }} />
                              {cat}
                            </span>
                            <span style={{ color: 'var(--theme-text2)' }}>NPR {Math.round(amount).toLocaleString('en-NP')} · {pct.toFixed(0)}%</span>
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
      {<div style={{ display: 'grid', gridTemplateColumns: canReorder ? 'repeat(auto-fit, minmax(320px, 1fr))' : '1fr', gap: 14, marginBottom: 20 }}>

        {/* Variance table */}
        {canVariance ? (
          <div className="card" style={{ padding: '14px 16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <h3 style={{ fontSize: 12, fontWeight: 600, margin: 0, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Top Variance Items</h3>
              <button className="btn btn-ghost" style={{ fontSize: 11, padding: '9px 12px' }} onClick={() => navigate('/variance')}>Full Report →</button>
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
                    <th scope="col" style={{ color: 'var(--theme-text2)', fontWeight: 500, textAlign: 'left', paddingBottom: 6, borderBottom: '1px solid var(--theme-border)' }}>Item</th>
                    <th scope="col" style={{ color: 'var(--theme-text2)', fontWeight: 500, textAlign: 'right', paddingBottom: 6, borderBottom: '1px solid var(--theme-border)' }}>
                      <Tip text="Qty used above what recipes predict — indicates waste, theft, or over-portioning.">Over-used</Tip>
                    </th>
                    <th scope="col" style={{ color: 'var(--theme-text2)', fontWeight: 500, textAlign: 'right', paddingBottom: 6, borderBottom: '1px solid var(--theme-border)' }}>
                      <Tip text="Over-used qty × item rate. The NPR cost of unaccounted usage this period." width={200}>Value at Risk</Tip>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {topVariance.map((row, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid var(--theme-bg)' }}>
                      <td style={{ padding: '5px 0', fontWeight: 600, color: 'var(--theme-text1)' }}>{row.name}</td>
                      <td style={{ padding: '5px 0', textAlign: 'right', color: 'var(--theme-red-text)' }}>+{Number(row.variance.toFixed(1)).toLocaleString()} {row.uom}</td>
                      <td style={{ padding: '5px 0', textAlign: 'right', fontWeight: 700, color: 'var(--theme-red-text)' }}>NPR {Number(row.value.toFixed(0)).toLocaleString()}</td>
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
          <div className="card" style={{ padding: '14px 16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <h3 style={{ fontSize: 12, fontWeight: 600, margin: 0, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Items to Reorder</h3>
              <button className="btn btn-ghost" style={{ fontSize: 11, padding: '9px 12px' }} onClick={() => navigate('/reorder')}>Full Report →</button>
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
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0', borderBottom: i < reorderItems.length - 1 ? '1px solid var(--theme-bg)' : 'none' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--theme-text1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.name}</div>
                      <div style={{ fontSize: 11, color: 'var(--theme-text2)' }}>Stock: {item.currentStock} · Par: {item.par} {item.uom}</div>
                    </div>
                    <div style={{ textAlign: 'right', marginLeft: 12, flexShrink: 0 }}>
                      <div style={{ fontSize: 11, color: 'var(--theme-red-text)', fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 2 }}><ArrowDown size={11} aria-hidden="true" /> {item.shortfall} {item.uom}</div>
                      <div style={{ fontSize: 11, color: 'var(--theme-text3)' }}>NPR {item.estValue.toLocaleString()}</div>
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

  return (
    <div>
      {/* Screen-reader-only announcement — the visible loading state is a shimmering skeleton
          per KPI, which on its own gives no indication to a screen reader that the page is still
          loading, or when it's finished. */}
      <div role="status" aria-live="polite" className="sr-only">
        {loading ? 'Loading dashboard data…' : 'Dashboard data loaded'}
      </div>
      {/* ── Header ── */}
      <div className="page-header">
        <h1 className="page-title">{dashTitle}</h1>
        <p className="page-subtitle">
          {isAdmin ? (adminViewClientName || '— Select a property from the sidebar —') : (profile?.clients?.name || '')}
          {activePeriod && ` · ${periodLabel} · Open`}
        </p>
      </div>

      {/* A load failure used to be indistinguishable from "this client genuinely has no data" —
          every section here silently discarded Supabase's error field. Each section sets its own
          key in loadErrors and clears it on a successful (re)load, so a real fetch failure now
          shows a dismissible, retry-able banner instead of a wrong-looking zero. */}
      {Object.entries(loadErrors).filter(([, msg]) => msg).map(([section, msg]) => (
        // role="alert" so a screen-reader user hears the failure when the banner appears —
        // this page's loading region already announces politely; a fetch failure should not
        // be the one async state that stays silent (dashboard critique P2, S569).
        <div key={section} role="alert" className="card" style={{
          marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
          borderColor: 'color-mix(in srgb, var(--theme-red) 25%, transparent)',
          background: 'color-mix(in srgb, var(--theme-red) 8%, transparent)',
        }}>
          <p style={{ color: 'var(--theme-red-text)', margin: 0, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
            <TriangleAlert size={14} aria-hidden="true" /> {msg}
          </p>
          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            <button className="btn btn-ghost" style={{ fontSize: 12, padding: '8px 12px' }} onClick={() => retryLoad(section)}>Retry</button>
            <button
              className="btn btn-ghost" style={{ fontSize: 12, padding: '8px 12px' }}
              onClick={() => setLoadErrors(prev => ({ ...prev, [section]: '' }))} aria-label="Dismiss"
            >×</button>
          </div>
        </div>
      ))}

      {!isAdmin && (() => {
        const s = getSubStatus(profile?.clients)
        if (!s.label || s.days === null || s.days > 7) return null
        const isExpired = s.days < 0
        return (
          <div className="card" role="status" aria-live="polite" style={{ marginBottom: 20, borderColor: s.border, background: s.bg }}>
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

      {showIms && !activePeriod && !loading && (
        <div
          className="card interactive-card" style={{ marginBottom: 20, cursor: 'pointer', borderColor: 'color-mix(in srgb, var(--theme-accent) 30%, transparent)' }}
          onClick={() => navigate('/periods')} role="button" tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate('/periods') } }}
        >
          <p style={{ color: 'var(--theme-accent-ink)', margin: 0, fontSize: 14, display: 'flex', alignItems: 'center', gap: 6 }}><TriangleAlert size={15} aria-hidden="true" /> No open period. Click here to create one in Periods →</p>
        </div>
      )}

      {/* First run.
          A brand-new client with a period but no data saw eleven KPI cards reading NPR 0 / — / 0,
          three charts saying "no data", and a reorder panel saying "No items below par" — which is
          true and reads as GOOD NEWS when the real state is "you have no items". The per-panel
          empty strings are individually well written and collectively unreadable as guidance,
          because they appear in whatever order the data happens to load. This gives the sequence
          once, at the top, and disappears the moment any step is done. */}
      {showIms && activePeriod && !loading && stats && stats.itemCount === 0 && stats.purchaseTotal === 0 && (
        <div className="card" style={{ marginBottom: 20, borderColor: 'color-mix(in srgb, var(--theme-accent) 30%, transparent)' }}>
          <p style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 700, color: 'var(--theme-text1)' }}>Let’s get {periodLabel} set up</p>
          <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.6 }}>
            Your figures below stay at zero until there’s something to count. Four steps, in order —
            each one feeds the next.
          </p>
          <ol style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'grid', gap: 8 }}>
            {[
              { n: 1, label: 'Add your items', hint: 'Everything you buy — ingredients, drinks, supplies', to: '/items', done: stats.itemCount > 0 },
              { n: 2, label: 'Record your purchases', hint: 'Bills from your vendors for this period', to: '/purchases', done: stats.purchaseTotal > 0 },
              { n: 3, label: 'Build your recipes', hint: 'What each dish uses — this is what costs it', to: '/recipes', done: stats.recipeCount > 0 },
              { n: 4, label: 'Enter your sales', hint: 'Daily or bulk — this is the base every % is measured against', to: '/sales', done: stats.revenueTotal > 0 },
            ].map(s => (
              <li key={s.n}>
                <button
                  className="btn btn-ghost"
                  style={{ width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px' }}
                  onClick={() => navigate(s.to)}
                >
                  <span style={{
                    flexShrink: 0, width: 22, height: 22, borderRadius: 'var(--radius-full)',
                    display: 'inline-grid', placeItems: 'center', fontSize: 11, fontWeight: 800,
                    background: s.done ? 'color-mix(in srgb, var(--theme-green) 18%, transparent)' : 'var(--theme-input-bg)',
                    color: s.done ? 'var(--theme-green-text)' : 'var(--theme-text2)',
                    border: '1px solid var(--theme-border)',
                  }}>{s.done ? '✓' : s.n}</span>
                  <span style={{ display: 'grid', gap: 1 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text1)' }}>{s.label}</span>
                    <span style={{ fontSize: 11, color: 'var(--theme-text3)' }}>{s.hint}</span>
                  </span>
                  <span style={{ marginLeft: 'auto', color: 'var(--theme-text3)' }} aria-hidden="true">→</span>
                </button>
              </li>
            ))}
          </ol>
        </div>
      )}

      {periodExpired && !loading && (
        <div className="card" style={{ marginBottom: 20, borderColor: 'color-mix(in srgb, var(--theme-amber) 15%, transparent)', background: 'color-mix(in srgb, var(--theme-amber) 5%, transparent)' }}>
          {/* wrap: at 375px the message and its action button cannot share a row. */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            <div>
              <p style={{ color: 'var(--theme-amber-text)', margin: 0, fontSize: 14, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                <Clock size={15} aria-hidden="true" /> {BS_MONTHS[activePeriod.bs_month - 1]} {activePeriod.bs_year} has ended
              </p>
              <p style={{ color: 'var(--theme-text2)', margin: '4px 0 0', fontSize: 12 }}>
                {isAdmin
                  ? `Viewing as admin — go to Periods to close and advance for this property.`
                  : `Finish your month-end stock count, then close this period and open ${BS_MONTHS[nextAdvMonth - 1]}.`}
              </p>
            </div>
            {isAdmin ? (
              <button className="amber-action-btn" onClick={() => navigate('/periods')}>
                Go to Periods →
              </button>
            ) : (
              <button className="amber-action-btn" onClick={() => setConfirmPeriodClose(true)} disabled={advancingPeriod}>
                {advancingPeriod ? 'Closing…' : `End ${BS_MONTHS[activePeriod.bs_month - 1]} & Start ${BS_MONTHS[nextAdvMonth - 1]} →`}
              </button>
            )}
          </div>
          {periodCloseError && (
            <p role="alert" style={{ color: 'var(--theme-red-text)', margin: '10px 0 0', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
              <TriangleAlert size={13} aria-hidden="true" /> {periodCloseError}
            </p>
          )}
          {confirmPeriodClose && (
            <ConfirmModal
              title={`Close ${BS_MONTHS[activePeriod.bs_month - 1]} ${activePeriod.bs_year} and open ${BS_MONTHS[nextAdvMonth - 1]} ${nextAdvMonth === 1 ? activePeriod.bs_year + 1 : activePeriod.bs_year}?`}
              confirmLabel={`Close ${BS_MONTHS[activePeriod.bs_month - 1]} ${activePeriod.bs_year}`}
              busy={advancingPeriod}
              busyLabel="Closing…"
              onConfirm={closeAndAdvancePeriod}
              onCancel={() => setConfirmPeriodClose(false)}
            >
              <p style={{ margin: '0 0 10px' }}>Closing the month is how its figures become final:</p>
              <ul style={{ margin: '0 0 10px', paddingLeft: 18 }}>
                <li>Entry pages for {BS_MONTHS[activePeriod.bs_month - 1]} become read-only for your team (Crest admin can still correct figures later).</li>
                <li>Closing stock carries forward as {BS_MONTHS[nextAdvMonth - 1]}&apos;s opening stock.</li>
                <li>The Monthly Owner Report snapshot is captured from the figures as they stand now.</li>
              </ul>
              <p style={{ margin: 0 }}>
                Make sure the month-end stock count is saved first — COGS, Variance and the frozen report all read it.
              </p>
            </ConfirmModal>
          )}
        </div>
      )}

      {/* ── No modules enabled ── */}
      {!showIms && !showHr && !showPos && (
        <div className="card" style={{ textAlign: 'center', padding: '48px 24px' }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }} aria-hidden="true"><LayoutGrid size={32} strokeWidth={1.5} /></div>
          <p style={{ fontSize: 15, color: 'var(--theme-text1)', fontWeight: 600, margin: '0 0 8px' }}>No modules enabled</p>
          <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: 0 }}>Contact your consultant to activate Crest IMS, Crest HR, or Crest POS.</p>
        </div>
      )}

      <div className={dashColsClass}>
      {/* ── IMS KPIs ── */}
      {showIms && <div>
      {moduleHeader('Inventory')}
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
          <div className="stat-grid stat-grid--compact" style={{ marginBottom: 14 }}>
            {netPurchasesCard}{revenueCard}{foodCostCard}{fixedCostsCard}{netMarginCard}
          </div>
          <div className="stat-grid stat-grid--compact" style={{ marginBottom: 14 }}>
            {activePeriodCard}{itemsCard}{vendorsCard}{recipesCard}{menuHealthCard}{wastageCard}
          </div>
          {imsChartsAndTables}
          {canSales && <div style={{ marginTop: 14 }}><SalesPivot activePeriod={activePeriod} posEnabled={false} /></div>}
        </>
      )}
      </div>}

      {/* ── HR KPIs (below Inventory) ── */}
      {/* Previously two entirely separate blocks — a full "Loading HR data…" text card while
          !hrStats, then the real KPI grid once loaded — inconsistent with how the IMS/POS
          sections above handle their own loading state (a skeleton bar per KPI value, same grid
          shape throughout). Now one block, matching that pattern. */}
      {showHr && (
        <div style={{ marginBottom: 14, marginTop: showIms ? 6 : 0 }}>
          {moduleHeader('Human Resources')}
          {/* A dashboard's whole job is a 5-second "state of things" glance — headcount, active
              staff and payroll are exactly that for HR, not reference data, so every card here
              stays visible always (reversed from an earlier pass that hid them behind a click;
              hiding numbers people check daily is the #1 progressive-disclosure failure mode).
              Pending Approvals is still the section's headline — spans 2 columns for visual
              weight, same instinct as IMS's Food Cost % above — but "headline" means "biggest,"
              not "only thing shown." */}
          <div className="stat-grid stat-grid--compact">
            {showModuleHeaders && <div style={{ gridColumn: 'span 2' }}>{hrHeadlineCard}</div>}
            {hrSecondaryCards}
          </div>
          {!showModuleHeaders && <div style={{ marginTop: 10 }}>{hrHeadlineCard}</div>}
        </div>
      )}

      {/* ── POS KPIs ── */}
      {showPos && (
        <div style={{ marginBottom: 14, marginTop: (showIms || showHr) ? 6 : 0 }}>
          {moduleHeader(posTeam === 'bar' ? 'Bar' : posTeam === 'kitchen' ? 'Kitchen' : 'Point of Sale')}
          {/* Same reversal as HR above — Covers Served/Avg Check/Tables Occupied (or Late/Ready &
              Waiting/Avg Prep for a kitchen/bar station) are exactly what a mid-rush glance needs,
              not occasional reference data, so they stay visible. Revenue/Open Tickets is still
              the headline via size + position, not via hiding its siblings. */}
          <div className="stat-grid stat-grid--compact">
            {showModuleHeaders && <div style={{ gridColumn: 'span 2' }}>{posIsStationTeam ? posKitchenHeadlineCard : posFrontHeadlineCard}</div>}
            {posIsStationTeam
              ? <>{!showModuleHeaders && posKitchenHeadlineCard}{posKitchenSecondaryCards}</>
              : <>{!showModuleHeaders && posFrontHeadlineCard}{posFrontSecondaryCards}</>}
          </div>

          {/* POS-sourced sales pivot — kitchen/bar station accounts have no use for a revenue
              breakdown (they get kitchen-ops KPIs above instead), so this is front-of-house only.
              Single-module (POS-only) clients keep it right here, unchanged; once 2+ modules
              share the page it moves into the shared Sales Breakdown section below instead, so it
              can sit next to the manual-sales pivot rather than fight IMS for column space. */}
          {!showModuleHeaders && !posIsStationTeam && <div style={{ marginTop: 14 }}><SalesPivot activePeriod={activePeriod} posEnabled={true} /></div>}
        </div>
      )}
      </div>

      {/* ── IMS details (2+ modules only) — reference cards + charts + tables, full-width below
          the equal-width pill grid instead of squeezed into IMS's own narrower column. The
          reference-card row is behind a disclosure (dashboard density critique, 2026-08-14, P1)
          — it's status/master-data, not a daily figure, so it doesn't need to cost default
          scroll length; charts stay visible, they already have their own ChartCard compact/
          expand pattern for progressive disclosure at the individual-chart level. ── */}
      {showIms && showModuleHeaders && (
        <div style={{ marginBottom: 14 }}>
          {detailsToggle('ims', 6, 'ims-details-panel')}
          {openDetails.ims && (
            <div id="ims-details-panel" className="stat-grid stat-grid--compact" style={{ marginTop: 10, marginBottom: 14 }}>
              {activePeriodCard}{itemsCard}{vendorsCard}{recipesCard}{menuHealthCard}{fixedCostsCard}
            </div>
          )}
          {imsChartsAndTables}
        </div>
      )}

      {/* ── Sales Breakdown (2+ modules only) — manual + POS pivots side by side (never mutually
          exclusive — a client can carry real revenue on both). The Food/Beverage split used to
          share this row as a third card; S557 folded it into a tab on Revenue vs Cost Breakdown
          above instead, so the pivot table(s) here now get the whole row to themselves — with one
          fewer card competing for width, the same auto-fit grid gives each pivot more room on its
          own, which is what actually widens "Manual Sales by Category" now that it's not sharing
          the row three ways. ── */}
      {showModuleHeaders && ((showIms && canSales) || (showPos && !posIsStationTeam)) && (
        <div style={{ marginBottom: 20 }}>
          {moduleHeader('Sales Breakdown')}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14 }}>
            {showIms && canSales && <SalesPivot activePeriod={activePeriod} posEnabled={false} title="Manual Sales by Category" />}
            {showPos && !posIsStationTeam && <SalesPivot activePeriod={activePeriod} posEnabled={true} title="POS Sales by Category" />}
          </div>
        </div>
      )}
    </div>
  )
}
