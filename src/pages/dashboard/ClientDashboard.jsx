import { useEffect, useState, useRef } from 'react'
import { useAuth } from '../../context/AuthContext'
import { useTheme } from '../../context/ThemeContext'
import { supabase } from '../../supabaseClient'
import { useScopedDb } from '../../shared/hooks/useScopedDb'
import { useNavigate, useLocation } from 'react-router-dom'
import {
  ResponsiveContainer, PieChart, Pie, Cell, Tooltip,
  LineChart, Line, XAxis, YAxis, CartesianGrid, ReferenceLine,
  BarChart, Bar
} from 'recharts'
import { ArrowDown, ArrowUp, Percent, Receipt, Target, Lock, TriangleAlert, Clock, LayoutGrid } from 'lucide-react'
import Tip from '../../components/Tip'
import ChartCard from '../../components/ChartCard'
import { getBsToday, BS_MONTHS, daysInBsMonth, bsToAd } from '../../utils/bsCalendar'
import { getSubStatus } from '../../utils/subscription'
import { explodeRecipeIngredients } from '../../utils/recipeCost'
import { useHrApprovalCounts } from '../../modules/hr/dashboard/useHrApprovalCounts'
const CHART_COLORS = ['#c9a84c', '#34d399', '#60a5fa', '#f87171', '#a78bfa', '#fb923c', '#22d3ee', '#f472b6']

export default function ClientDashboard() {
  const { profile, clientId, isAdmin, clientModules, hasFeature, hasImsAccess, hasHrAccess, hasPosAccess, posTeam, loading: authLoading, adminViewClientName } = useAuth()
  // 'kitchen'/'bar' pos_team accounts (S431) get kitchen-ops KPIs (open/late tickets, prep time)
  // instead of the front-of-house Revenue/Covers/Avg Check/Tables Occupied cards — they have no
  // more use for revenue figures on their landing dashboard than a POS-only staffer has for IMS's.
  const posIsStationTeam = posTeam === 'kitchen' || posTeam === 'bar'
  const { colors, themeKey } = useTheme()
  const effectiveClientId = clientId || profile?.client_id
  const { scopedFrom, scopedInsert, scopedUpdate } = useScopedDb()
  const hrApprovals = useHrApprovalCounts() // shared with HrDashboard.jsx's own Approvals row
  const navigate = useNavigate()
  const location = useLocation()
  const [stats, setStats]               = useState(null)
  const [activePeriod, setActivePeriod] = useState(null)
  const [loading, setLoading]           = useState(true)
  const [topVariance, setTopVariance]   = useState([])
  const [categorySpend, setCategorySpend] = useState([])
  const [dailyTrend, setDailyTrend]     = useState([])
  const [hasDailySales, setHasDailySales] = useState(false)
  const [salesProjection, setSalesProjection] = useState(null) // { projectedMonthEnd } | null
  const [topItemSpend, setTopItemSpend] = useState([])
  const [reorderItems, setReorderItems]   = useState([])
  const [fcTrend, setFcTrend]             = useState([])
  const [hrStats, setHrStats]             = useState(null)
  const [posStats, setPosStats]           = useState(null)
  // Guards against a stale response overwriting the current view — none of loadStats/loadHrStats/
  // loadPosStats/loadFcTrend had a cancellation check, so switching "view as" client (or the
  // module flags changing) while a slower request for the PREVIOUS client was still in flight
  // could let that older response land last and silently repaint the screen with the wrong
  // tenant's numbers. Each load call captures the id current at its own start and checks it's
  // still current before committing any setState.
  const loadIdRef = useRef(0)
  const [advancingPeriod, setAdvancingPeriod] = useState(false)
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
    else if (section === 'fcTrend') loadFcTrend(activePeriod, stats?.revenueTotal > 0 ? (stats.purchaseTotal / stats.revenueTotal) * 100 : null, myId)
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
    setLoading(true)

    // .single() reports error.code 'PGRST116' when the result set isn't exactly one row — for
    // this query that just means "no open period right now," a normal, common state, not a
    // failure. Only anything else is a genuine fetch failure worth surfacing.
    const { data: period, error: periodErr } = await scopedFrom('monthly_periods')
      .eq('status', 'open')
      .order('bs_year', { ascending: false }).order('bs_month', { ascending: false })
      .limit(1).single()
    if (loadIdRef.current !== myId) return // superseded by a newer client switch

    setActivePeriod(period)

    const results = await Promise.all([
      scopedFrom('items', '*', { count: 'exact', head: true }).eq('is_active', true).eq('is_sub_recipe', false),
      scopedFrom('vendors', '*', { count: 'exact', head: true }).eq('is_active', true),
      scopedFrom('recipes', '*', { count: 'exact', head: true }).eq('is_active', true).neq('category', 'Sub-Recipe'),
      scopedFrom('recipes', '*', { count: 'exact', head: true }).eq('is_active', true).eq('category', 'Sub-Recipe'),
      period ? supabase.from('purchase_entries').select('item_id, qty, rate, bs_day').eq('period_id', period.id) : { data: [] },
      period ? supabase.from('vendor_returns').select('item_id, qty, rate, bs_day').eq('period_id', period.id) : { data: [] },
      // Revenue (and the daily revenue trend below) excludes comps (source='pos_comp') — a
      // comped dish was never paid for.
      period ? supabase.from('sales_entries').select('recipe_id, qty_sold, bs_day, unit_price').eq('period_id', period.id).neq('source', 'pos_comp') : { data: [] },
      scopedFrom('recipes', 'id, name, selling_price, category, is_active, target_fc_pct'),
      period ? supabase.from('opening_stock').select('item_id, qty').eq('period_id', period.id) : { data: [] },
      period ? supabase.from('closing_stock').select('item_id, physical_qty').eq('period_id', period.id) : { data: [] },
      scopedFrom('items', 'id, name, uom, per_uom_rate, yield_pct, categories(name)').eq('is_active', true).eq('is_sub_recipe', false),
      scopedFrom('par_levels', 'item_id, par_qty'),
      period ? supabase.from('overheads').select('amount').eq('period_id', period.id) : { data: [] },
      period ? supabase.from('wastages').select('item_id, qty').eq('period_id', period.id) : { data: [] },
      // Unfiltered by is_active — an item deactivated mid-period still has real purchase/wastage
      // history for that period. Used for Top Items by Spend and itemRateMap below so those don't
      // silently drop/zero-cost that history, unlike the active-only `items` fetch above (which
      // still correctly limits Variance/Reorder/the item COUNT to currently-active stock items).
      scopedFrom('items', 'id, name, per_uom_rate').eq('is_sub_recipe', false),
    ])
    const hadRealError = (periodErr && periodErr.code !== 'PGRST116') || results.some(r => r.error)
    setLoadErrors(prev => ({ ...prev, ims: hadRealError ? 'Inventory data failed to load — figures below may be incomplete or stale.' : '' }))

    const [
      { count: itemCount },
      { count: vendorCount },
      { count: recipeCount },
      { count: subRecipeCount },
      { data: purchases },
      { data: returns },
      { data: salesData },
      { data: recipes },
      { data: opening },
      { data: closing },
      { data: items },
      { data: parLevels },
      { data: overheadsData },
      { data: wastagesData },
      { data: allItems }
    ] = results

    // recipe_ingredients has no client_id — must be scoped by this client's recipe IDs
    const dashRecipeIds = (recipes || []).map(r => r.id)
    // explodeRecipeIngredients recurses through sub-recipe ingredients and applies yield_pct —
    // the previous direct recipe_ingredients read (below, now removed) only picked up rows with
    // a direct item_id, silently dropping any ingredient that was itself a sub-recipe, and the
    // Menu Health cost map didn't apply yield_pct at all. One call now feeds both theoreticalMap
    // (item usage) and recipeCostMap (recipe cost) below.
    const ingredientBreakdown = dashRecipeIds.length > 0 ? await explodeRecipeIngredients(supabase, dashRecipeIds) : {}
    if (loadIdRef.current !== myId) return // superseded again after these two more awaits

    // PATCHED: purchaseTotal = gross − returns
    const grossTotal  = (purchases || []).reduce((s, p) => s + p.qty * p.rate, 0)
    const returnTotal = (returns || []).reduce((s, r) => s + r.qty * r.rate, 0)
    const purchaseTotal = grossTotal - returnTotal

    const currentPriceMap = {}
    ;(recipes || []).forEach(r => { currentPriceMap[r.id] = parseFloat(r.selling_price) || 0 })
    // unit_price captured on the row (price actually charged) used per-row when present, else
    // falls back to the recipe's current price — previously always used the current price, so
    // this period's revenue silently reflected today's menu price rather than what was charged.
    const soldMap = {}, revenueMap = {}
    ;(salesData || []).forEach(s => {
      const qty = parseFloat(s.qty_sold)
      const price = s.unit_price != null ? parseFloat(s.unit_price) : (currentPriceMap[s.recipe_id] || 0)
      soldMap[s.recipe_id] = (soldMap[s.recipe_id] || 0) + qty
      revenueMap[s.recipe_id] = (revenueMap[s.recipe_id] || 0) + qty * price
    })
    const revenueTotal = Object.values(revenueMap).reduce((s, v) => s + v, 0)

    // theoreticalMap: item-level usage this period. ingredientBreakdown rows are already
    // recursed through sub-recipe nesting and yield_pct-adjusted per one portion — just scale by
    // how many portions actually sold.
    const theoreticalMap = {}
    Object.entries(ingredientBreakdown).forEach(([recipeId, rows]) => {
      const sold = soldMap[recipeId] || 0
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
      setTopVariance(varRows)
    } else {
      setTopVariance([])
    }

    // Category spend (net)
    const itemMap = {}; (items || []).forEach(i => { itemMap[i.id] = i })
    const catSpendMap = {}
    Object.entries(purchValueMap).forEach(([itemId, val]) => {
      if (val <= 0) return
      const cat = itemMap[itemId]?.categories?.name || 'Uncategorized'
      catSpendMap[cat] = (catSpendMap[cat] || 0) + val
    })
    setCategorySpend(
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
      const d = parseInt(s.bs_day)
      if (!d || d <= 0) return
      const price = s.unit_price != null ? parseFloat(s.unit_price) : (currentPriceMap[s.recipe_id] || 0)
      daySalesMap[d] = (daySalesMap[d] || 0) + parseFloat(s.qty_sold || 0) * price
    })
    Object.keys(daySalesMap).forEach(d => { daySalesMap[d] = Math.round(daySalesMap[d]) }) // whole NPR (no ugly decimals)
    const salesDayNums = Object.keys(daySalesMap).map(Number).sort((a, b) => a - b)
    const dailySalesOn = salesDayNums.length > 0
    setHasDailySales(dailySalesOn)

    // Projection: current open month + ≥5 sales days only. Least-squares trend on daily revenue,
    // extended to the last day of the BS month — but DAMPENED so a steep slope fitted to a few
    // volatile early days can't run away: each projected day is clamped to [0, 1.25 × recent peak].
    // Past/closed months show actuals only.
    const bsToday = getBsToday()
    const isCurrentMonth = !!period && period.bs_year === bsToday.year && period.bs_month === bsToday.month
    const monthEndDay = period ? daysInBsMonth(period.bs_year, period.bs_month) : 31
    const projDays = {}
    let projectedMonthEnd = null
    if (dailySalesOn && isCurrentMonth && salesDayNums.length >= 5) {
      const xs = salesDayNums, ys = xs.map(d => daySalesMap[d]), n = xs.length
      const sumX = xs.reduce((a, b) => a + b, 0), sumY = ys.reduce((a, b) => a + b, 0)
      const sumXY = xs.reduce((a, x, i) => a + x * ys[i], 0), sumXX = xs.reduce((a, x) => a + x * x, 0)
      const denom = n * sumXX - sumX * sumX
      const slope = denom !== 0 ? (n * sumXY - sumX * sumY) / denom : 0
      const intercept = (sumY - slope * sumX) / n
      const recentYs = salesDayNums.slice(-7).map(d => daySalesMap[d]) // last up-to-7 days
      const cap = Math.round(Math.max(...recentYs) * 1.25)
      const lastActual = salesDayNums[salesDayNums.length - 1]
      let projSum = 0
      for (let d = lastActual + 1; d <= monthEndDay; d++) {
        const v = Math.min(cap, Math.max(0, Math.round(slope * d + intercept)))
        projDays[d] = v; projSum += v
      }
      projectedMonthEnd = Math.round(sumY + projSum)
    }
    setSalesProjection(projectedMonthEnd != null ? { projectedMonthEnd } : null)

    // Build the unified day axis. Current month: 6 days back → 3 days ahead (10-day window).
    // Past months: show full actuals only.
    const purchDayNums = Object.keys(dayPurchMap).map(Number)
    const baseDays = [...purchDayNums, ...salesDayNums].filter(d => d > 0)
    const lastActualSalesDay = salesDayNums.length ? salesDayNums[salesDayNums.length - 1] : null
    const hasProj = Object.keys(projDays).length > 0
    const startDay = isCurrentMonth ? Math.max(1, bsToday.day - 6) : (baseDays.length ? Math.min(...baseDays) : 1)
    const lastDay  = isCurrentMonth ? Math.min(monthEndDay, bsToday.day + 3) : (baseDays.length ? Math.max(...baseDays) : 0)
    const trend = []
    for (let d = startDay; d <= lastDay; d++) {
      const isProj = projDays[d] != null
      trend.push({
        day: `Day ${d}`,
        purchases: dayPurchMap[d] != null ? dayPurchMap[d] : null,
        sales: dailySalesOn && daySalesMap[d] != null ? daySalesMap[d] : null,
        // dashed line: anchor at the last actual sales day so it connects, then projected days
        salesProj: isProj ? projDays[d]
          : (d === lastActualSalesDay && hasProj ? daySalesMap[d] : null),
      })
    }
    setDailyTrend(trend)

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
    setTopItemSpend(itemSpendRows)

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
        .slice(0, 8)
      setReorderItems(reorderRows)
    } else {
      setReorderItems([])
    }

    const overheadTotal = (overheadsData || []).reduce((s, o) => s + parseFloat(o.amount || 0), 0)

    // itemRateMap already built above (for recipeCostMap) — same items(id, per_uom_rate) shape.
    const wastageValueTotal = (wastagesData || []).reduce((s, w) => s + parseFloat(w.qty || 0) * (itemRateMap[w.item_id] || 0), 0)

    setStats({ itemCount, vendorCount, recipeCount, subRecipeCount, purchaseTotal, revenueTotal, overheadTotal, wastageValueTotal, underpricedCount, costedPricedCount, menuOpportunityTotal })
    setLoading(false)
    const fcPctNow = revenueTotal > 0 ? (purchaseTotal / revenueTotal) * 100 : null
    loadFcTrend(period, fcPctNow, myId)
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
    setHrStats({ total, active, probation, payroll })
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

    setPosStats({ revenueTotal, coversTotal, billCount, avgCheck, tablesOccupied, tablesTotal })
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
    setPosStats({ kitchen: true, station: kdsStation, openNow, lateCount, readyWaiting, avgPrepMin, completedToday })
  }

  async function closeAndAdvancePeriod() {
    if (!activePeriod || !effectiveClientId || advancingPeriod) return
    setAdvancingPeriod(true)
    const nextMonth = activePeriod.bs_month === 12 ? 1 : activePeriod.bs_month + 1
    const nextYear  = activePeriod.bs_month === 12 ? activePeriod.bs_year + 1 : activePeriod.bs_year
    await scopedUpdate('monthly_periods', { status: 'closed' }).eq('id', activePeriod.id)
    await scopedInsert('monthly_periods', {
      bs_year: nextYear,
      bs_month: nextMonth,
      status: 'open'
    })
    setAdvancingPeriod(false)
    loadStats(loadIdRef.current)
  }

  async function loadFcTrend(currentPeriod, currentFcPct, myId) {
    const { data: closedPeriods, error: closedErr } = await scopedFrom('monthly_periods', 'id, bs_year, bs_month')
      .eq('status', 'closed')
      .order('bs_year', { ascending: false })
      .order('bs_month', { ascending: false })
      .limit(11)

    const closed = closedPeriods || []
    const periodIds = closed.map(p => p.id)

    const trendResults = await Promise.all([
      periodIds.length ? supabase.from('purchase_entries').select('period_id, qty, rate').in('period_id', periodIds) : { data: [] },
      periodIds.length ? supabase.from('vendor_returns').select('period_id, qty, rate').in('period_id', periodIds)   : { data: [] },
      // Revenue excludes comps (source='pos_comp') — a comped dish was never paid for.
      periodIds.length ? supabase.from('sales_entries').select('period_id, recipe_id, qty_sold, unit_price').in('period_id', periodIds).neq('source', 'pos_comp') : { data: [] },
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
      const price = e.unit_price != null ? parseFloat(e.unit_price) : (priceMap[e.recipe_id] || 0)
      revMap[e.period_id] = (revMap[e.period_id] || 0) + parseFloat(e.qty_sold) * price
    })

    const points = closed.map(p => {
      const net = (grossMap[p.id] || 0) - (retMap[p.id] || 0)
      const rev = revMap[p.id] || 0
      const fc  = rev > 0 ? parseFloat(((net / rev) * 100).toFixed(1)) : null
      return { label: `${BS_MONTHS[p.bs_month - 1].slice(0, 3)} ${p.bs_year}`, fc, purchases: Math.round(net), revenue: Math.round(rev), open: false }
    }).reverse()

    if (currentPeriod && currentFcPct != null) {
      points.push({
        label: `${BS_MONTHS[currentPeriod.bs_month - 1].slice(0, 3)} ${currentPeriod.bs_year}`,
        fc: parseFloat(currentFcPct.toFixed(1)),
        purchases: null, revenue: null, open: true
      })
    }

    setFcTrend(points.filter(p => p.fc !== null))
  }

  const bsToday      = getBsToday()
  const periodExpired = activePeriod && (
    activePeriod.bs_year < bsToday.year ||
    (activePeriod.bs_year === bsToday.year && activePeriod.bs_month < bsToday.month)
  )
  const nextAdvMonth = activePeriod ? (activePeriod.bs_month === 12 ? 1 : activePeriod.bs_month + 1) : null

  const periodLabel = activePeriod ? `${BS_MONTHS[activePeriod.bs_month - 1]} ${activePeriod.bs_year}` : '—'
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
  const dailyTrendPurchTotal = dailyTrend.reduce((s, d) => s + (d.purchases || 0), 0)
  const dailyTrendSalesTotal = dailyTrend.reduce((s, d) => s + (d.sales || 0), 0)
  const dailyTrendSummary = dailyTrend.length === 0
    ? 'No purchase or sales data for this period.'
    : `Purchases and sales trend, ${periodLabel}. Purchases shown so far total NPR ${dailyTrendPurchTotal.toLocaleString('en-NP')}.${hasDailySales ? ` Sales shown so far total NPR ${dailyTrendSalesTotal.toLocaleString('en-NP')}.` : ''}${salesProjection ? ` Projected month-end revenue: NPR ${salesProjection.projectedMonthEnd.toLocaleString('en-NP')}.` : ''}`
  const topItemSpendSummary = topItemSpend.length === 0
    ? 'No purchase data for this period.'
    : `Top items by spend: ${topItemSpend.slice(0, 3).map(i => `${i.fullName} at NPR ${i.value.toLocaleString('en-NP')}`).join(', ')}.`
  const fcTrendSummary = fcTrend.length === 0
    ? 'No food cost history yet.'
    : `Food cost percentage over the last ${fcTrend.length} month${fcTrend.length === 1 ? '' : 's'}: ${fcTrend.map(p => `${p.label} ${p.fc}%`).join(', ')}.`

  // Shared mini card style + a11y — returns a spreadable props object so every KPI card gets
  // keyboard support (role/tabIndex/onKeyDown) and a visible focus ring for free, instead of each
  // clickable div being mouse-only. Non-interactive cards (onClick == null) get style only.
  const kpiCard = (onClick) => ({
    style: {
      background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-lg)',
      boxShadow: 'var(--theme-card-shadow)',
      padding: '10px 14px', cursor: onClick ? 'pointer' : 'default',
      transition: 'border-color 0.15s'
    },
    ...(onClick ? {
      onClick,
      role: 'button',
      tabIndex: 0,
      className: 'interactive-card',
      onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } }
    } : {})
  })
  // Shared KPI text styles — single source of truth for label/value/subtext sizing across every
  // KPI grid section (IMS Row 1/2, HR, POS), so a future re-tune is a 3-line edit, not a sweep of
  // 15+ inline style objects. kpiValueStyle keeps the hero (bigger/bolder) vs secondary two-tier
  // hierarchy explicit via its params, rather than one flattened size for every card.
  const kpiLabelStyle = { fontSize: 10, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }
  const kpiSubtextStyle = { fontSize: 10, color: 'var(--theme-text3)', marginTop: 4 }

  // Colorful per-category icon badge on a headline KPI card — a deliberate exception to the One
  // Accent Rule, scoped to the Bright preset only (see DESIGN.md's exception note). Every other
  // preset keeps plain text-only stat cards, same as today. Not applied to every stat card on
  // every page — just this dashboard's primary IMS row, matching what was actually mocked up.
  function kpiIcon(Icon, hue) {
    if (themeKey !== 'bright') return null
    const hues = {
      blue:  { bg: 'rgba(58,109,240,0.12)', fg: colors.accent },
      green: { bg: 'rgba(22,163,74,0.12)',  fg: colors.green },
      amber: { bg: 'rgba(217,119,6,0.12)',  fg: colors.amber },
    }
    const h = hues[hue] || hues.blue
    return (
      <div aria-hidden="true" style={{
        width: 30, height: 30, borderRadius: 'var(--radius-md)', display: 'flex',
        alignItems: 'center', justifyContent: 'center', marginBottom: 10,
        background: h.bg, color: h.fg,
      }}><Icon size={16} strokeWidth={2.25} /></div>
    )
  }
  const kpiValueStyle = (size, weight = 700) => ({ fontSize: size, fontWeight: weight, lineHeight: 1.1 })

  // Compact upsell card for a locked feature → links to /pricing. Only render when the
  // feature is locked; an admin grant flips hasFeature(...) → real KPI shows instead.
  // Uses var(--theme-purple) (the rationed 4th-color token) instead of a hardcoded indigo —
  // the old #818cf8/rgba(129,140,248,*) literal was unconditional across all 10 theme presets
  // (unlike kpiIcon's bright-only hues above) and an unaudited contrast risk on light presets.
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
        borderRadius: 'var(--radius-lg)', padding: '10px 14px', cursor: 'pointer', transition: 'border-color 0.15s'
      }}
    >
      <div style={{ ...kpiLabelStyle, marginBottom: 4, display: 'flex', justifyContent: 'space-between' }}>
        <span>{label}</span><Lock size={12} aria-hidden="true" />
      </div>
      <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--theme-purple)', lineHeight: 1.2 }}>Unlock with {tier}</div>
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
  const moduleHeader = (text) => showModuleHeaders
    ? <h2 style={{ fontSize: 11, fontWeight: 400, margin: '0 0 10px', color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{text}</h2>
    : null

  // Weighted 3-column layout (IMS wider than HR/POS, not equal thirds — forced equal-weighting
  // dilutes attention per dashboard-IA research; IMS stays widest as the most decision-dense
  // module) — only kicks in at 2+ modules, matching showModuleHeaders. A 1-module client keeps
  // today's full-width single-column render untouched. Named classes (not a computed inline
  // gridTemplateColumns) specifically so Layout.css's mobile media-query collapse can win at
  // narrow widths — an inline style would always beat a class's rule regardless of viewport.
  const dashColsClass = !showModuleHeaders ? ''
    : (showIms && showHr && showPos) ? 'dash-3col-all'
    : (showHr && showPos) ? 'dash-3col-hr-pos'
    : 'dash-3col-ims-plus' // IMS+HR or IMS+POS — both get the same 1.5fr/1fr split

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
        <div key={section} className="card" style={{
          marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
          borderColor: 'color-mix(in srgb, var(--theme-red) 25%, transparent)',
          background: 'color-mix(in srgb, var(--theme-red) 8%, transparent)',
        }}>
          <p style={{ color: 'var(--theme-red)', margin: 0, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
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
          <div className="card" style={{ marginBottom: 20, borderColor: s.border, background: s.bg }}>
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
          <p style={{ color: 'var(--theme-accent)', margin: 0, fontSize: 14, display: 'flex', alignItems: 'center', gap: 6 }}><TriangleAlert size={15} aria-hidden="true" /> No open period. Click here to create one in Periods →</p>
        </div>
      )}

      {periodExpired && !loading && (
        <div className="card" style={{ marginBottom: 20, borderColor: 'color-mix(in srgb, var(--theme-amber) 15%, transparent)', background: 'color-mix(in srgb, var(--theme-amber) 5%, transparent)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
            <div>
              <p style={{ color: 'var(--theme-amber)', margin: 0, fontSize: 14, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
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
              <button className="amber-action-btn" onClick={closeAndAdvancePeriod} disabled={advancingPeriod}>
                {advancingPeriod ? 'Closing…' : `End ${BS_MONTHS[activePeriod.bs_month - 1]} & Start ${BS_MONTHS[nextAdvMonth - 1]} →`}
              </button>
            )}
          </div>
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
      {showIms && <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10, marginBottom: 14 }}>

        {/* Net Purchases */}
        <div {...kpiCard(() => navigate('/purchases'))}>
          {kpiIcon(ArrowDown, 'blue')}
          <div style={kpiLabelStyle}>Net Purchases</div>
          <div style={{ ...kpiValueStyle(18), color: 'var(--theme-accent)' }}>
            {loading ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : `NPR ${(stats?.purchaseTotal || 0).toLocaleString('en-NP', { maximumFractionDigits: 0 })}`}
          </div>
          <div style={kpiSubtextStyle}>Gross − returns · {periodLabel} →</div>
        </div>

        {/* Revenue */}
        {canSales ? (
          <div {...kpiCard(() => navigate('/sales'))}>
            {kpiIcon(ArrowUp, 'green')}
            <div style={kpiLabelStyle}>Revenue</div>
            <div style={{ ...kpiValueStyle(18), color: 'var(--theme-green)' }}>
              {loading ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : `NPR ${(stats?.revenueTotal || 0).toLocaleString('en-NP', { maximumFractionDigits: 0 })}`}
            </div>
            <div style={kpiSubtextStyle}>From sales entries →</div>
          </div>
        ) : null}

        {/* Food Cost % — computable from purchases ÷ revenue, so any sales client sees it */}
        {canSales ? (
          <div {...kpiCard(() => navigate(canVariance ? '/variance' : '/summary'))}>
            {kpiIcon(Percent, 'amber')}
            <div style={kpiLabelStyle}>
              <Tip text="Net purchases ÷ revenue × 100. Shows what portion of sales goes to ingredient cost. Healthy range: 28–35% for Nepal F&B." width={240}>Food Cost %</Tip>
            </div>
            <div style={{
              ...kpiValueStyle(22, 800),
              color: fcPct == null ? 'var(--theme-text2)' : fcPct <= 35 ? 'var(--theme-green)' : fcPct <= 45 ? 'var(--theme-accent)' : 'var(--theme-red)'
            }}>
              {loading ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : fcPct != null ? `${fcPct.toFixed(1)}%` : '—'}
            </div>
            <div style={kpiSubtextStyle}>
              <Tip text="Industry benchmark for Nepal cafes & restaurants. Green = healthy, yellow = watch, red = investigate immediately." width={240}>Target 28–35%</Tip> →
            </div>
          </div>
        ) : null}

        {/* Fixed Costs % (Pro — needs overhead data) */}
        {canOverheads ? (
          <div {...kpiCard(() => navigate('/overheads'))}>
            {kpiIcon(Receipt, 'blue')}
            <div style={kpiLabelStyle}>
              <Tip text="All fixed costs (rent, utilities, labor, tax & fees) as a % of revenue. Target: under 60% combined. See Overheads page for the full breakdown." width={250}>Fixed Costs % of Revenue</Tip>
            </div>
            <div style={{
              ...kpiValueStyle(22, 800),
              color: ohPct == null ? 'var(--theme-text2)' : ohPct <= 50 ? 'var(--theme-green)' : ohPct <= 65 ? 'var(--theme-accent)' : 'var(--theme-red)'
            }}>
              {loading ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : ohPct != null ? `${ohPct.toFixed(1)}%` : '—'}
            </div>
            <div style={kpiSubtextStyle}>
              {stats?.overheadTotal ? `NPR ${stats.overheadTotal.toLocaleString('en-NP', { maximumFractionDigits: 0 })} total →` : 'No overhead data'}
            </div>
          </div>
        ) : (
          <UpsellCard label="Fixed Costs & Net Margin" tier="Pro" blurb="See true profit after rent, labor & tax" />
        )}

        {/* Est. Net Margin % (Pro — only meaningful with overhead data) */}
        {canOverheads && (
          <div {...kpiCard(null)}>
            {kpiIcon(Target, 'green')}
            <div style={kpiLabelStyle}>
              <Tip text="Revenue minus food cost and overheads, as a % of revenue. This is what the business keeps after ingredient and fixed costs. Healthy Nepal F&B target: ≥20%." width={260}>Est. Net Margin %</Tip>
            </div>
            <div style={{
              ...kpiValueStyle(22, 800),
              color: netMarginPct == null ? 'var(--theme-text2)' : netMarginPct >= 20 ? 'var(--theme-green)' : netMarginPct >= 10 ? 'var(--theme-accent)' : 'var(--theme-red)'
            }}>
              {loading ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : netMarginPct != null ? `${netMarginPct.toFixed(1)}%` : '—'}
            </div>
            <div style={kpiSubtextStyle}>After food & overheads · target ≥20%</div>
          </div>
        )}
      </div>}

      {/* ── IMS Row 2 + Charts ── */}
      {showIms && <><div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10, marginBottom: 14 }}>

        <div {...kpiCard(null)}>
          <div style={kpiLabelStyle}>Active Period</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--theme-text1)' }}>{loading ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : periodLabel}</div>
          <div style={{ ...kpiSubtextStyle, color: activePeriod ? 'var(--theme-green)' : 'var(--theme-red)' }}>
            {activePeriod ? '● Open' : '● No open period'}
          </div>
        </div>

        <div {...kpiCard(() => navigate('/items'))}>
          <div style={kpiLabelStyle}>Items in Master</div>
          <div style={kpiValueStyle(18)}>{loading ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : stats?.itemCount}</div>
          <div style={kpiSubtextStyle}>Active ingredients →</div>
        </div>

        <div {...kpiCard(() => navigate('/vendors'))}>
          <div style={kpiLabelStyle}>Vendors</div>
          <div style={kpiValueStyle(18)}>{loading ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : stats?.vendorCount}</div>
          <div style={kpiSubtextStyle}>Active suppliers →</div>
        </div>

        {canRecipes ? (
          <div {...kpiCard(() => navigate('/recipes'))}>
            <div style={kpiLabelStyle}>Costed Recipes</div>
            <div style={kpiValueStyle(18)}>{loading ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : stats?.recipeCount}</div>
            <div style={kpiSubtextStyle}>
              {stats?.subRecipeCount > 0 ? `+ ${stats.subRecipeCount} sub-recipes →` : 'Active menu items →'}
            </div>
          </div>
        ) : (
          <UpsellCard label="Costed Recipes" tier="Growth" blurb="Cost every dish & protect margins" />
        )}

        {canMenuReprice ? (
          <div {...kpiCard(() => navigate('/menu-repricing'))}>
            <div style={kpiLabelStyle}>
              <Tip text="Dishes whose current food-cost % is above their target — priced too low to hit the margin you set. Open the Menu Repricing report for the prices to charge." width={300}>Menu Health</Tip>
            </div>
            <div style={{ ...kpiValueStyle(18), color: stats?.underpricedCount > 0 ? 'var(--theme-red)' : 'var(--theme-green)' }}>
              {loading ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : `${stats?.underpricedCount || 0} of ${stats?.costedPricedCount || 0}`}
            </div>
            <div style={{ ...kpiSubtextStyle, color: stats?.menuOpportunityTotal > 0 ? 'var(--theme-accent)' : 'var(--theme-text3)' }}>
              {loading ? 'under target →'
                : stats?.menuOpportunityTotal > 0
                  ? `NPR ${Math.round(stats.menuOpportunityTotal).toLocaleString('en-NP')}/mo opportunity →`
                  : 'dishes under target →'}
            </div>
          </div>
        ) : (
          <UpsellCard label="Menu Health" tier="Growth" blurb="Spot underpriced dishes & lost margin" />
        )}

        <div {...kpiCard(() => navigate('/wastage-report'))}>
          <div style={kpiLabelStyle}>
            <Tip text="Total NPR value of wastage recorded this period — qty wasted × unit rate per item." width={220}>Wastage Value</Tip>
          </div>
          <div style={{ ...kpiValueStyle(18), color: stats?.wastageValueTotal > 0 ? 'var(--theme-red)' : 'var(--theme-text1)' }}>
            {loading ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : `NPR ${Math.round(stats?.wastageValueTotal || 0).toLocaleString('en-NP')}`}
          </div>
          <div style={kpiSubtextStyle}>This period →</div>
        </div>
      </div>

      {/* ── Charts Row ── */}
      {!loading && activePeriod && (
        <>
          {/* Restacks to a single vertical column when the page is in the weighted 3-column
              layout (IMS's own column is narrower than a full page width there) — the
              3-across desktop spread only makes sense when IMS has the whole page to itself. */}
          <div style={{ display: 'grid', gridTemplateColumns: showModuleHeaders ? '1fr' : 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14, marginBottom: 14 }}>

            {/* Pie — Category Spend */}
            <ChartCard
              title="Spend by Category"
              /* Bumped from 140 when the page is in the 3-column layout — these charts use
                 height as their only signal for "full desktop spread vs squeezed" (h > 200 =
                 big), so a stacked-but-still-short card needs to clear that threshold too, or
                 it silently keeps the cramped small-width font/tick sizing forever. */
              smallHeight={showModuleHeaders ? 220 : 140}
              footer={<p className="sr-only">{categorySpendSummary}</p>}
              renderChart={h => categorySpend.length === 0 ? (
                <div style={{ height: h, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <p style={{ color: 'var(--theme-text3)', fontSize: 12 }}>No purchase data</p>
                </div>
              ) : (
                <>
                  <ResponsiveContainer width="100%" height={h}>
                    <PieChart margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
                      <Pie
                        data={categorySpend} dataKey="value" nameKey="name"
                        cx="50%" cy="50%"
                        innerRadius={h > 200 ? 80 : 38} outerRadius={h > 200 ? 140 : 60}
                        paddingAngle={2}
                      >
                        {categorySpend.map((entry, i) => <Cell key={entry.name} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                      </Pie>
                      <Tooltip
                        contentStyle={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 6, fontSize: 11 }}
                        formatter={v => [`NPR ${Number(v).toLocaleString()}`, '']}
                        labelFormatter={name => name}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px', marginTop: 6 }}>
                    {categorySpend.map((entry, i) => {
                      return (
                        <div key={entry.name} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                          <div style={{ width: 8, height: 8, borderRadius: 2, background: CHART_COLORS[i % CHART_COLORS.length], flexShrink: 0 }} />
                          <span style={{ fontSize: 10, color: 'var(--theme-text2)' }}>{entry.name}</span>
                          <span style={{ fontSize: 10, color: 'var(--theme-text2)' }}>{categorySpendTotal > 0 ? `${((entry.value / categorySpendTotal) * 100).toFixed(0)}%` : ''}</span>
                        </div>
                      )
                    })}
                  </div>
                </>
              )}
            />

            {/* Line — Daily Purchases vs Sales */}
            {/* minWidth:0 lets this grid column hold its 1/3 share — without it the inner
                scroll div's large minWidth forces the track wide and squeezes the other cards. */}
            <ChartCard
              title="Daily Purchases vs Sales"
              smallHeight={showModuleHeaders ? 220 : 160}
              cardStyle={{ minWidth: 0 }}
              legend={<>
                <span style={{ color: 'var(--theme-text2)' }}><span style={{ color: 'var(--theme-accent)' }}>●</span> Purchases</span>
                {hasDailySales && <span style={{ color: 'var(--theme-text2)' }}><span style={{ color: 'var(--theme-green)' }}>●</span> Sales</span>}
                {salesProjection && <span style={{ color: 'var(--theme-text2)' }}><span style={{ color: 'var(--theme-green)', letterSpacing: '-2px' }}>┄</span> Projection</span>}
                {!hasDailySales && <span style={{ color: 'var(--theme-text3)' }}>Enter daily sales to see the sales trend</span>}
              </>}
              footer={<>
                {salesProjection && (
                  <div style={{ marginTop: 8, fontSize: 11, color: 'var(--theme-text2)' }}>
                    Projected month-end revenue: <strong style={{ color: 'var(--theme-green)' }}>NPR {salesProjection.projectedMonthEnd.toLocaleString()}</strong>
                    <span style={{ color: 'var(--theme-text3)' }}> · trend estimate</span>
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
                const chart = (
                  <ResponsiveContainer width="100%" height={h}>
                    <LineChart data={dailyTrend} margin={{ top: big ? 8 : 4, right: big ? 16 : 8, bottom: big ? 4 : 0, left: big ? 8 : 0 }}>
                      <CartesianGrid stroke={colors.border} strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="day" tick={{ fill: colors.text3, fontSize: big ? 11 : 9 }} tickLine={false} axisLine={false} interval={0} tickFormatter={v => v.replace('Day ', '')} />
                      <YAxis tick={{ fill: colors.text3, fontSize: big ? 11 : 9 }} tickLine={false} axisLine={false} tickFormatter={v => `${(v / 1000).toFixed(0)}k`} width={big ? 40 : 32} />
                      <Tooltip
                        contentStyle={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 6, fontSize: big ? 12 : 11 }}
                        labelStyle={{ color: colors.text1 }}
                        formatter={(value, name) => [`NPR ${Math.round(Number(value)).toLocaleString()}`, name]}
                        labelFormatter={l => l}
                      />
                      <Line type="monotone" dataKey="purchases" name="Purchases" stroke={colors.accent} strokeWidth={big ? 2.5 : 2} connectNulls dot={{ r: big ? 3 : 2, fill: colors.accent, strokeWidth: 0 }} activeDot={{ r: big ? 5 : 4, fill: colors.accent }} />
                      {hasDailySales && <Line type="monotone" dataKey="sales" name="Sales" stroke={colors.green} strokeWidth={big ? 2.5 : 2} connectNulls dot={{ r: big ? 3 : 2, fill: colors.green, strokeWidth: 0 }} activeDot={{ r: big ? 5 : 4, fill: colors.green }} />}
                      {salesProjection && <Line type="monotone" dataKey="salesProj" name="Projection" stroke={colors.green} strokeWidth={2} strokeDasharray="5 4" strokeOpacity={0.65} connectNulls dot={false} activeDot={{ r: big ? 4 : 3, fill: colors.green }} />}
                    </LineChart>
                  </ResponsiveContainer>
                )
                return big ? chart : (
                  <div style={{ overflowX: 'auto', overflowY: 'hidden' }}>
                    <div style={{ minWidth: Math.max(0, dailyTrend.length * 44), height: h }}>{chart}</div>
                  </div>
                )
              }}
            />

            {/* Bar — Top Items */}
            <ChartCard
              title="Top Items by Spend"
              smallHeight={showModuleHeaders ? 220 : 160}
              footer={<p className="sr-only">{topItemSpendSummary}</p>}
              renderChart={h => {
                const big = h > 200
                const count = big ? topItemSpend.length : 6
                return topItemSpend.length === 0 ? (
                  <div style={{ height: h, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <p style={{ color: 'var(--theme-text3)', fontSize: 12 }}>No purchase data</p>
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height={h}>
                    <BarChart data={topItemSpend.slice(0, count)} layout="vertical" margin={{ top: 0, right: 8, bottom: 0, left: 0 }}>
                      <XAxis type="number" hide />
                      <YAxis type="category" dataKey="name" tick={{ fill: colors.text3, fontSize: big ? 11 : 9 }} tickLine={false} axisLine={false} width={big ? 130 : 90} />
                      <Tooltip
                        contentStyle={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 6, fontSize: 11 }}
                        formatter={(v, n, p) => [`NPR ${Number(v).toLocaleString()}`, p.payload.fullName || n]}
                        labelFormatter={() => ''}
                      />
                      <Bar dataKey="value" fill={colors.accent} radius={[0, 3, 3, 0]} barSize={big ? 18 : 10}>
                        {topItemSpend.slice(0, count).map((entry, i) => (
                          <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                )
              }}
            />
          </div>

          {/* ── FC% Trend ── */}
          {fcTrend.length >= 2 && canSales && (
            <ChartCard
              title="Food Cost % — Monthly Trend"
              cardStyle={{ marginBottom: 14 }}
              footer={<>
                <div style={{ display: 'flex', gap: 16, marginTop: 6, fontSize: 10 }}>
                  <span style={{ color: 'var(--theme-green)' }}>● ≤35% Good</span>
                  <span style={{ color: 'var(--theme-accent)' }}>● 35–45% Watch</span>
                  <span style={{ color: 'var(--theme-red)' }}>● &gt;45% High</span>
                  <span style={{ marginLeft: 'auto', color: 'var(--theme-text2)' }}>⊙ = current open period</span>
                </div>
                <p className="sr-only">{fcTrendSummary}</p>
              </>}
              renderChart={h => (
                <div style={{ overflowX: 'auto', overflowY: 'hidden' }}>
                  <div style={{ minWidth: Math.max(0, fcTrend.length * 64), height: h }}>
                    <ResponsiveContainer width="100%" height={h}>
                      <LineChart data={fcTrend} margin={{ top: 8, right: 48, bottom: 0, left: 0 }}>
                        <CartesianGrid stroke={colors.border} strokeDasharray="3 3" vertical={false} />
                        <XAxis dataKey="label" tick={{ fill: colors.text3, fontSize: 10 }} tickLine={false} axisLine={false} interval={0} />
                        <YAxis tick={{ fill: colors.text3, fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={v => `${v}%`} domain={['auto', 'auto']} width={36} />
                        <ReferenceLine y={35} stroke={colors.green} strokeDasharray="4 3" strokeOpacity={0.5} label={{ value: '35%', fill: colors.green, fontSize: 9, position: 'right' }} />
                        <ReferenceLine y={45} stroke={colors.red} strokeDasharray="4 3" strokeOpacity={0.5} label={{ value: '45%', fill: colors.red, fontSize: 9, position: 'right' }} />
                        <Tooltip
                          contentStyle={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 6, fontSize: 11, color: 'var(--theme-text1)' }}
                          labelStyle={{ color: 'var(--theme-text1)' }}
                          itemStyle={{ color: 'var(--theme-text1)' }}
                          formatter={(v, _n, props) => {
                            const p = props.payload
                            const lines = [`${v}%`]
                            if (p.purchases != null) lines.push(`Purchases: NPR ${p.purchases.toLocaleString('en-NP')}`)
                            if (p.revenue != null)   lines.push(`Revenue: NPR ${p.revenue.toLocaleString('en-NP')}`)
                            return [lines.join(' · '), 'Food Cost %']
                          }}
                        />
                        <Line type="monotone" dataKey="fc" strokeWidth={2} stroke={colors.accent} connectNulls={false}
                          dot={(props) => {
                            const { cx, cy, payload } = props
                            const col = payload.fc <= 35 ? colors.green : payload.fc <= 45 ? colors.accent : colors.red
                            return <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={payload.open ? 5 : 3} fill={col} stroke={payload.open ? colors.text1 : 'none'} strokeWidth={1.5} />
                          }}
                          activeDot={{ r: 5, fill: colors.accent }}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}
            />
          )}

          {/* ── Bottom: Variance + Reorder side by side ── */}
          {/* Same restack-when-columned rule as the charts row above. */}
          {<div style={{ display: 'grid', gridTemplateColumns: (!showModuleHeaders && canReorder) ? 'repeat(auto-fit, minmax(320px, 1fr))' : '1fr', gap: 14, marginBottom: 20 }}>

            {/* Variance table */}
            {canVariance ? (
              <div className="card" style={{ padding: '14px 16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <h3 style={{ fontSize: 12, fontWeight: 600, margin: 0, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Top Variance Items</h3>
                  <button className="btn btn-ghost" style={{ fontSize: 10, padding: '9px 12px' }} onClick={() => navigate('/variance')}>Full Report →</button>
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
                          <td style={{ padding: '5px 0', textAlign: 'right', color: 'var(--theme-red)' }}>+{Number(row.variance.toFixed(1)).toLocaleString()} {row.uom}</td>
                          <td style={{ padding: '5px 0', textAlign: 'right', fontWeight: 700, color: 'var(--theme-red)' }}>NPR {Number(row.value.toFixed(0)).toLocaleString()}</td>
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
                  <button className="btn btn-ghost" style={{ fontSize: 10, padding: '9px 12px' }} onClick={() => navigate('/reorder')}>Full Report →</button>
                </div>
                {reorderItems.length === 0 ? (
                  <p style={{ color: 'var(--theme-text3)', fontSize: 12, margin: '16px 0' }}>
                    No items below par.{' '}
                    <button
                      onClick={() => navigate('/reorder')} className="interactive-card"
                      style={{ background: 'none', border: 'none', padding: '4px 6px', margin: '-4px -6px', font: 'inherit', color: 'var(--theme-accent)', cursor: 'pointer' }}
                    >Set par levels →</button>
                  </p>
                ) : (
                  <div>
                    {reorderItems.map((item, i) => (
                      <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0', borderBottom: i < reorderItems.length - 1 ? '1px solid var(--theme-bg)' : 'none' }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--theme-text1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.name}</div>
                          <div style={{ fontSize: 10, color: 'var(--theme-text2)' }}>Stock: {item.currentStock} · Par: {item.par} {item.uom}</div>
                        </div>
                        <div style={{ textAlign: 'right', marginLeft: 12, flexShrink: 0 }}>
                          <div style={{ fontSize: 11, color: 'var(--theme-red)', fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 2 }}><ArrowDown size={11} aria-hidden="true" /> {item.shortfall} {item.uom}</div>
                          <div style={{ fontSize: 10, color: 'var(--theme-text3)' }}>NPR {item.estValue.toLocaleString()}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : null}
          </div>}
        </>
      )}
      </>}
      </div>}

      {/* ── HR KPIs (below Inventory) ── */}
      {/* Previously two entirely separate blocks — a full "Loading HR data…" text card while
          !hrStats, then the real KPI grid once loaded — inconsistent with how the IMS/POS
          sections above handle their own loading state (a skeleton bar per KPI value, same grid
          shape throughout). Now one block, matching that pattern. */}
      {showHr && (
        <div style={{ marginBottom: 14, marginTop: showIms ? 6 : 0 }}>
          {moduleHeader('Human Resources')}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
            <div {...kpiCard(() => navigate('/hr/employees'))}>
              <div style={kpiLabelStyle}>Total Employees</div>
              <div style={{ ...kpiValueStyle(22, 800), color: 'var(--theme-text1)' }}>
                {!hrStats ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : hrStats.total}
              </div>
              <div style={kpiSubtextStyle}>All statuses →</div>
            </div>
            <div {...kpiCard(() => navigate('/hr/employees'))}>
              <div style={kpiLabelStyle}>Active</div>
              <div style={{ ...kpiValueStyle(22, 800), color: 'var(--theme-green)' }}>
                {!hrStats ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : hrStats.active}
              </div>
              {hrStats && hrStats.probation > 0 && (
                <div style={{ ...kpiSubtextStyle, color: 'var(--theme-accent)' }}>{hrStats.probation} on probation</div>
              )}
            </div>
            <div {...kpiCard(null)}>
              <div style={kpiLabelStyle}>
                <Tip text="Sum of basic salary for active and probation employees. Full payroll with allowances, SSF and TDS is computed during payroll run." width={260}>Basic Payroll / Month</Tip>
              </div>
              <div style={{ ...kpiValueStyle(18, 800), color: 'var(--theme-accent)' }}>
                {!hrStats
                  ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} />
                  : `NPR ${Math.round(hrStats.payroll).toLocaleString('en-NP')}`}
              </div>
              <div style={kpiSubtextStyle}>Basic salary only</div>
            </div>
          </div>

          {/* Approvals-lite — same counts HrDashboard.jsx's own Approvals row shows (shared via
              useHrApprovalCounts), just compact for this narrower column. Always shown (even at
              zero) so "nothing pending" is a visible, confirmed state, not an absent one. */}
          {(() => {
            const approvalsCardProps = kpiCard(() => navigate('/hr/dashboard'))
            return (
          <div {...approvalsCardProps} style={{ ...approvalsCardProps.style, marginTop: 10 }}>
            <div style={kpiLabelStyle}>Pending Approvals</div>
            <div style={{ ...kpiValueStyle(18, 800), color: hrApprovals.total > 0 ? 'var(--theme-amber)' : 'var(--theme-text1)' }}>
              {hrApprovals.loading ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : hrApprovals.total}
            </div>
            <div style={kpiSubtextStyle}>
              {hrApprovals.loading ? 'Loading…' : `${hrApprovals.leave} Leave · ${hrApprovals.ot} OT · ${hrApprovals.tada} TADA · ${hrApprovals.swap} Swap →`}
            </div>
          </div>
            )
          })()}
        </div>
      )}

      {/* ── POS KPIs ── */}
      {showPos && (
        <div style={{ marginBottom: 14, marginTop: (showIms || showHr) ? 6 : 0 }}>
          {moduleHeader(posTeam === 'bar' ? 'Bar' : posTeam === 'kitchen' ? 'Kitchen' : 'Point of Sale')}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
            {posIsStationTeam ? (
              <>
                <div {...kpiCard(() => navigate('/pos/kds'))}>
                  <div style={kpiLabelStyle}>Open Tickets</div>
                  <div style={kpiValueStyle(18)}>
                    {!posStats ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : posStats.openNow}
                  </div>
                  <div style={kpiSubtextStyle}>
                    {!posStats
                      ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} />
                      : <>New + In Progress →</>}
                  </div>
                </div>
                <div {...kpiCard(() => navigate('/pos/kds'))}>
                  <div style={kpiLabelStyle}>
                    <Tip text="Open tickets sent more than 15 minutes ago — same threshold the ticket display itself flags." width={220}>Late</Tip>
                  </div>
                  <div style={{ ...kpiValueStyle(18), color: posStats?.lateCount > 0 ? 'var(--theme-red)' : 'var(--theme-text1)' }}>
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
            ) : (
              <>
                <div {...kpiCard(() => navigate('/pos/sales-report'))}>
                  <div style={kpiLabelStyle}>Revenue</div>
                  <div style={{ ...kpiValueStyle(18), color: 'var(--theme-green)' }}>
                    {!posStats ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : `NPR ${Math.round(posStats.revenueTotal).toLocaleString('en-NP')}`}
                  </div>
                  <div style={kpiSubtextStyle}>{periodLabel} · billed →</div>
                </div>
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
                {/* Tables page became Manager-only (S430 follow-up) — a Staff/Supervisor viewer
                    would just get redirected away, so only link through when they can actually
                    open it; the card itself still shows the live count either way. */}
                <div {...kpiCard(hasPosAccess('manager') ? () => navigate('/pos/tables') : null)}>
                  <div style={kpiLabelStyle}>Tables Occupied</div>
                  <div style={{ ...kpiValueStyle(18), color: posStats?.tablesOccupied > 0 ? 'var(--theme-accent)' : 'var(--theme-text1)' }}>
                    {!posStats ? <span className="skeleton" style={{ display: 'inline-block', width: '3em', height: '0.85em', verticalAlign: 'middle' }} /> : `${posStats.tablesOccupied} / ${posStats.tablesTotal}`}
                  </div>
                  <div style={kpiSubtextStyle}>{hasPosAccess('manager') ? 'Right now →' : 'Right now'}</div>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      </div>
    </div>
  )
}
