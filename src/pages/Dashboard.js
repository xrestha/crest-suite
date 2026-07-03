import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../supabaseClient'
import { useNavigate, useLocation } from 'react-router-dom'
import {
  ResponsiveContainer, PieChart, Pie, Cell, Tooltip,
  LineChart, Line, XAxis, YAxis, CartesianGrid, ReferenceLine,
  BarChart, Bar
} from 'recharts'
import Tip from '../components/Tip'
import ChartCard from '../components/ChartCard'
import { getBsToday, BS_MONTHS, adToBs, daysInBsMonth } from '../utils/bsCalendar'
import { getSubStatus } from '../utils/subscription'
const CHART_COLORS = ['#c9a84c', '#34d399', '#60a5fa', '#f87171', '#a78bfa', '#fb923c', '#22d3ee', '#f472b6']


export default function Dashboard() {
  const { profile, clientId, isAdmin, clientModules, hasFeature, loading: authLoading, adminViewClientId, adminViewClientName, switchAdminClient } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const showAdminDash = isAdmin && !adminViewClientId
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
  const [adminClients, setAdminClients]   = useState([])
  const [clientPeriods, setClientPeriods] = useState({})
  const [adminLoading, setAdminLoading]   = useState(true)
  const [activeTodayClients, setActiveTodayClients] = useState([])

  useEffect(() => {
    if (authLoading) return
    if (showAdminDash) { loadAdminStats(); return }
    if (!effectiveClientId) return
    // Load only the modules the displayed client actually subscribes to (clientModules from
    // AuthContext already resolves real-client vs admin "view as client").
    if (clientModules.ims) loadStats(); else setLoading(false)
    if (clientModules.hr) loadHrStats(); else setHrStats(null)
  }, [authLoading, showAdminDash, effectiveClientId, clientModules.ims, clientModules.hr, location.key]) // eslint-disable-line react-hooks/exhaustive-deps

  const canSales    = hasFeature('sales_entry')
  const canVariance = hasFeature('variance_report')
  const canRecipes  = hasFeature('recipe_costing')
  const canMenuReprice = hasFeature('menu_repricing')
  const canReorder  = hasFeature('reorder_report')
  const canOverheads = hasFeature('overheads')

  async function loadStats() {
    setLoading(true)

    const { data: period } = await supabase
      .from('monthly_periods').select('*')
      .eq('client_id', effectiveClientId).eq('status', 'open')
      .order('bs_year', { ascending: false }).order('bs_month', { ascending: false })
      .limit(1).single()

    setActivePeriod(period)

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
      { data: wastagesData }
    ] = await Promise.all([
      supabase.from('items').select('*', { count: 'exact', head: true }).eq('client_id', effectiveClientId).eq('is_active', true).eq('is_sub_recipe', false),
      supabase.from('vendors').select('*', { count: 'exact', head: true }).eq('client_id', effectiveClientId).eq('is_active', true),
      supabase.from('recipes').select('*', { count: 'exact', head: true }).eq('client_id', effectiveClientId).eq('is_active', true).neq('category', 'Sub-Recipe'),
      supabase.from('recipes').select('*', { count: 'exact', head: true }).eq('client_id', effectiveClientId).eq('is_active', true).eq('category', 'Sub-Recipe'),
      period ? supabase.from('purchase_entries').select('item_id, qty, rate, bs_day').eq('period_id', period.id) : { data: [] },
      period ? supabase.from('vendor_returns').select('item_id, qty, rate, bs_day').eq('period_id', period.id) : { data: [] },
      period ? supabase.from('sales_entries').select('recipe_id, qty_sold, bs_day').eq('period_id', period.id) : { data: [] },
      supabase.from('recipes').select('id, name, selling_price, category, is_active, target_fc_pct').eq('client_id', effectiveClientId),
      period ? supabase.from('opening_stock').select('item_id, qty').eq('period_id', period.id) : { data: [] },
      period ? supabase.from('closing_stock').select('item_id, physical_qty').eq('period_id', period.id) : { data: [] },
      supabase.from('items').select('id, name, uom, per_uom_rate, yield_pct, categories(name)').eq('client_id', effectiveClientId).eq('is_active', true).eq('is_sub_recipe', false),
      supabase.from('par_levels').select('item_id, par_qty').eq('client_id', effectiveClientId),
      period ? supabase.from('overheads').select('amount').eq('period_id', period.id) : { data: [] },
      period ? supabase.from('wastages').select('item_id, qty').eq('period_id', period.id) : { data: [] }
    ])

    // recipe_ingredients has no client_id — must be scoped by this client's recipe IDs
    const dashRecipeIds = (recipes || []).map(r => r.id)
    const { data: recipeIngs } = dashRecipeIds.length
      ? await supabase.from('recipe_ingredients').select('recipe_id, item_id, qty_per_portion, items(per_uom_rate)').in('recipe_id', dashRecipeIds)
      : { data: [] }

    // PATCHED: purchaseTotal = gross − returns
    const grossTotal  = (purchases || []).reduce((s, p) => s + p.qty * p.rate, 0)
    const returnTotal = (returns || []).reduce((s, r) => s + r.qty * r.rate, 0)
    const purchaseTotal = grossTotal - returnTotal

    const soldMap = {}
    ;(salesData || []).forEach(s => { soldMap[s.recipe_id] = (soldMap[s.recipe_id] || 0) + parseFloat(s.qty_sold) })
    const revenueTotal = (recipes || []).reduce((s, r) => s + (soldMap[r.id] || 0) * (parseFloat(r.selling_price) || 0), 0)

    const yieldMap = {}
    ;(items || []).forEach(i => { yieldMap[i.id] = (parseFloat(i.yield_pct) || 100) / 100 })

    const clientRecipeIdSet = new Set((recipes || []).map(r => r.id))
    const theoreticalMap = {}
    ;(recipeIngs || []).filter(ri => clientRecipeIdSet.has(ri.recipe_id)).forEach(ri => {
      if (!ri.item_id) return
      const sold = soldMap[ri.recipe_id] || 0
      const yieldFactor = yieldMap[ri.item_id] || 1
      if (sold > 0) theoreticalMap[ri.item_id] = (theoreticalMap[ri.item_id] || 0) + sold * parseFloat(ri.qty_per_portion) / yieldFactor
    })

    // Menu Health — dishes priced below their target FC% (mirrors the Menu Repricing report).
    const recipeCostMap = {}
    ;(recipeIngs || []).filter(ri => clientRecipeIdSet.has(ri.recipe_id)).forEach(ri => {
      const c = parseFloat(ri.qty_per_portion || 0) * parseFloat(ri.items?.per_uom_rate || 0)
      recipeCostMap[ri.recipe_id] = (recipeCostMap[ri.recipe_id] || 0) + c
    })
    let underpricedCount = 0, costedPricedCount = 0, menuOpportunityTotal = 0
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

    // Variance top 5
    const varRows = (items || []).map(item => {
      const actual = (openMap[item.id] || 0) + (purchMap[item.id] || 0) - (closeMap[item.id] || 0)
      const theoretical = theoreticalMap[item.id] || 0
      const variance = actual - theoretical
      const value = variance * parseFloat(item.per_uom_rate || 0)
      return { name: item.name, variance, value, uom: item.uom, category: item.categories?.name }
    }).filter(r => r.value > 0).sort((a, b) => b.value - a.value).slice(0, 5)
    setTopVariance(varRows)

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
    const priceMap = {}; (recipes || []).forEach(r => { priceMap[r.id] = parseFloat(r.selling_price) || 0 })
    const daySalesMap = {}
    ;(salesData || []).forEach(s => {
      const d = parseInt(s.bs_day)
      if (!d || d <= 0) return
      daySalesMap[d] = (daySalesMap[d] || 0) + parseFloat(s.qty_sold || 0) * (priceMap[s.recipe_id] || 0)
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

    // Top items by net spend
    const itemSpendRows = (items || [])
      .filter(i => (purchValueMap[i.id] || 0) > 0)
      .map(i => ({
        name: i.name.length > 18 ? i.name.slice(0, 17) + '…' : i.name,
        fullName: i.name,
        value: Math.round(purchValueMap[i.id] || 0)
      }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 10)
    setTopItemSpend(itemSpendRows)

    // Reorder — use net purchMap for theoretical stock
    const reorderRows = (items || [])
      .filter(i => parMap[i.id] > 0)
      .map(i => {
        const hasPhysical = closeMap[i.id] !== undefined
        const currentStock = hasPhysical
          ? closeMap[i.id]
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

    const overheadTotal = (overheadsData || []).reduce((s, o) => s + parseFloat(o.amount || 0), 0)

    const itemRateMap = {}
    ;(items || []).forEach(i => { itemRateMap[i.id] = parseFloat(i.per_uom_rate || 0) })
    const wastageValueTotal = (wastagesData || []).reduce((s, w) => s + parseFloat(w.qty || 0) * (itemRateMap[w.item_id] || 0), 0)

    setStats({ itemCount, vendorCount, recipeCount, subRecipeCount, purchaseTotal, revenueTotal, overheadTotal, wastageValueTotal, underpricedCount, costedPricedCount, menuOpportunityTotal })
    setLoading(false)
    const fcPctNow = revenueTotal > 0 ? (purchaseTotal / revenueTotal) * 100 : null
    loadFcTrend(period, fcPctNow)
  }

  async function loadHrStats() {
    const { data: employees } = await supabase
      .from('hr_employees')
      .select('status, basic_salary')
      .eq('client_id', effectiveClientId)
    const total     = employees?.length || 0
    const active    = employees?.filter(e => e.status === 'active').length || 0
    const probation = employees?.filter(e => e.status === 'probation').length || 0
    const payroll   = (employees || [])
      .filter(e => e.status === 'active' || e.status === 'probation')
      .reduce((s, e) => s + parseFloat(e.basic_salary || 0), 0)
    setHrStats({ total, active, probation, payroll })
  }

  async function closeAndAdvancePeriod() {
    if (!activePeriod || !effectiveClientId) return
    const nextMonth = activePeriod.bs_month === 12 ? 1 : activePeriod.bs_month + 1
    const nextYear  = activePeriod.bs_month === 12 ? activePeriod.bs_year + 1 : activePeriod.bs_year
    await supabase.from('monthly_periods').update({ status: 'closed' }).eq('id', activePeriod.id)
    await supabase.from('monthly_periods').insert({
      client_id: effectiveClientId,
      bs_year: nextYear,
      bs_month: nextMonth,
      status: 'open'
    })
    loadStats()
  }

  async function loadFcTrend(currentPeriod, currentFcPct) {
    const { data: closedPeriods } = await supabase
      .from('monthly_periods')
      .select('id, bs_year, bs_month')
      .eq('client_id', effectiveClientId)
      .eq('status', 'closed')
      .order('bs_year', { ascending: false })
      .order('bs_month', { ascending: false })
      .limit(11)

    const closed = closedPeriods || []
    const periodIds = closed.map(p => p.id)

    const [{ data: allPurch }, { data: allRet }, { data: allSales }, { data: recipeData }] = await Promise.all([
      periodIds.length ? supabase.from('purchase_entries').select('period_id, qty, rate').in('period_id', periodIds) : { data: [] },
      periodIds.length ? supabase.from('vendor_returns').select('period_id, qty, rate').in('period_id', periodIds)   : { data: [] },
      periodIds.length ? supabase.from('sales_entries').select('period_id, recipe_id, qty_sold').in('period_id', periodIds) : { data: [] },
      supabase.from('recipes').select('id, selling_price').eq('client_id', effectiveClientId),
    ])

    const priceMap = {}
    ;(recipeData || []).forEach(r => { priceMap[r.id] = parseFloat(r.selling_price || 0) })

    const points = closed.map(p => {
      const gross = (allPurch || []).filter(e => e.period_id === p.id).reduce((s, e) => s + parseFloat(e.qty) * parseFloat(e.rate), 0)
      const ret   = (allRet   || []).filter(e => e.period_id === p.id).reduce((s, e) => s + parseFloat(e.qty) * parseFloat(e.rate), 0)
      const net   = gross - ret
      const rev   = (allSales || []).filter(e => e.period_id === p.id).reduce((s, e) => s + parseFloat(e.qty_sold) * (priceMap[e.recipe_id] || 0), 0)
      const fc    = rev > 0 ? parseFloat(((net / rev) * 100).toFixed(1)) : null
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

  async function loadAdminStats() {
    setAdminLoading(true)
    const since24h = new Date(Date.now() - 86400000).toISOString()
    const [{ data: clients }, { data: periods }, { data: recentProfiles }] = await Promise.all([
      supabase.from('clients')
        .select('id, name, plan, hr_plan, pos_plan, is_active, trial_ends_at, subscription_ends_at, ims_ends_at, hr_ends_at, pos_ends_at, billing_cycle, location, ims_enabled, hr_enabled, pos_enabled, is_trial, subscribe_requested, trial_expires_at')
        .order('name'),
      supabase.from('monthly_periods')
        .select('client_id, bs_year, bs_month, status')
        .order('bs_year', { ascending: false })
        .order('bs_month', { ascending: false }),
      supabase.from('profiles')
        .select('client_id')
        .not('client_id', 'is', null)
        .gte('last_seen_at', since24h),
    ])
    const openMap = {}, latestMap = {}
    ;(periods || []).forEach(p => {
      if (p.status === 'open') openMap[p.client_id] = p
      if (!latestMap[p.client_id]) latestMap[p.client_id] = p
    })
    const pMap = {}
    ;(clients || []).forEach(c => { pMap[c.id] = openMap[c.id] || latestMap[c.id] || null })
    const activeClientIds = new Set((recentProfiles || []).map(p => p.client_id))
    const activeToday = (clients || []).filter(c => activeClientIds.has(c.id))
    setAdminClients(clients || [])
    setClientPeriods(pMap)
    setActiveTodayClients(activeToday)
    setAdminLoading(false)
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

  // ── Admin platform overview ───────────────────────────────────────────────
  if (showAdminDash) {
    const active   = adminClients.filter(c => c.is_active)
    const inactive = adminClients.filter(c => !c.is_active)

    // Module adoption counts
    const imsCount = active.filter(c => c.ims_enabled !== false).length
    const hrCount  = active.filter(c => c.hr_enabled).length
    const posCount = active.filter(c => c.pos_enabled).length

    // Subscription health buckets
    const expiring30  = active.filter(c => { const s = getSubStatus(c); return s.days !== null && s.days >= 0 && s.days <= 30 })
    const churnRisk   = active.filter(c => {
      const endDate = c.ims_ends_at || c.subscription_ends_at
      if (!endDate) return false
      const s = getSubStatus(c)
      return s.days !== null && s.days <= 7
    })
    const noPeriod     = active.filter(c => !clientPeriods[c.id] || clientPeriods[c.id].status !== 'open')
    const trialSignups = adminClients.filter(c => c.is_trial)
    const wantToSub    = trialSignups.filter(c => c.subscribe_requested)
    const activeClientIds = new Set(activeTodayClients.map(c => c.id))

    // MRR: IMS + HR + POS combined (same plan price table for all three modules)
    const PLAN_MRR = { starter: 5000, growth: 8000, pro: 12000 }
    function clientMRR(c) {
      let val = 0
      const imsEnd = c.ims_ends_at || c.subscription_ends_at
      if (imsEnd && Math.ceil((new Date(imsEnd) - Date.now()) / 86400000) > 0) val += PLAN_MRR[c.plan] || 0
      if (c.hr_ends_at && Math.ceil((new Date(c.hr_ends_at) - Date.now()) / 86400000) > 0) val += PLAN_MRR[c.hr_plan] || 0
      if (c.pos_ends_at && Math.ceil((new Date(c.pos_ends_at) - Date.now()) / 86400000) > 0) val += PLAN_MRR[c.pos_plan] || 0
      return val
    }
    const estMRR = active.reduce((sum, c) => sum + clientMRR(c), 0)
    const estARR  = estMRR * 12
    const payingCount = active.filter(c => clientMRR(c) > 0).length

    // Sort: needs-attention first, then healthy active, then inactive
    const needsAttention = new Set(
      active.filter(c => {
        const s = getSubStatus(c)
        return (s.days !== null && s.days <= 30) || !clientPeriods[c.id] || clientPeriods[c.id].status !== 'open'
      }).map(c => c.id)
    )
    const sorted = [
      ...active.filter(c => needsAttention.has(c.id)),
      ...active.filter(c => !needsAttention.has(c.id)),
      ...inactive,
    ]

    const statCard = (borderColor) => ({
      background: 'var(--theme-card)', border: `1px solid ${borderColor || 'var(--theme-border)'}`,
      borderRadius: 10, padding: '16px 18px'
    })
    const planBadge = (plan) => ({
      fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 4,
      color:       plan === 'pro' ? 'var(--theme-accent)'  : plan === 'growth' ? 'var(--theme-green)'               : 'var(--theme-text2)',
      background:  plan === 'pro' ? 'rgba(201,168,76,0.12)': plan === 'growth' ? 'rgba(52,211,153,0.10)'            : 'rgba(120,113,108,0.10)',
      border: `1px solid ${plan === 'pro' ? 'rgba(201,168,76,0.25)' : plan === 'growth' ? 'rgba(52,211,153,0.20)' : 'rgba(120,113,108,0.20)'}`,
    })

    return (
      <div>
        <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <h1 className="page-title">Admin Dashboard</h1>
            <p className="page-subtitle">{active.length} active · {inactive.length} inactive · {adminClients.length} total properties</p>
          </div>
          <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => navigate('/admin/clients')}>Manage Clients →</button>
        </div>

        {adminLoading ? <p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Loading…</p> : (
          <>
            {/* ── 5 KPI cards ── */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6,1fr)', gap: 14, marginBottom: 20 }}>

              {/* 1 — Active Properties + module adoption */}
              <div style={statCard()}>
                <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>Active Properties</div>
                <div style={{ fontSize: 32, fontWeight: 800, color: 'var(--theme-text1)', lineHeight: 1.1 }}>{active.length}</div>
                <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 5 }}>{inactive.length} inactive · {adminClients.length} total</div>
                <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--theme-border)', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 3, background: 'rgba(96,165,250,0.10)', color: '#60a5fa', border: '1px solid rgba(96,165,250,0.2)' }}>IMS {imsCount}</span>
                  <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 3, background: 'rgba(52,211,153,0.08)', color: '#34d399', border: '1px solid rgba(52,211,153,0.18)' }}>HR {hrCount}</span>
                  <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 3, background: 'rgba(167,139,250,0.10)', color: '#a78bfa', border: '1px solid rgba(167,139,250,0.2)' }}>POS {posCount}</span>
                </div>
              </div>

              {/* 2 — Active Today */}
              <div style={statCard(activeTodayClients.length > 0 ? 'rgba(52,211,153,0.25)' : undefined)}>
                <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: activeTodayClients.length > 0 ? '#34d399' : '#374151', flexShrink: 0 }} />
                  Active Today
                </div>
                <div style={{ fontSize: 32, fontWeight: 800, color: activeTodayClients.length > 0 ? 'var(--theme-green)' : 'var(--theme-text2)', lineHeight: 1.1 }}>
                  {activeTodayClients.length}
                </div>
                <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 5, lineHeight: 1.7 }}>
                  {activeTodayClients.length === 0
                    ? 'No logins in last 24 h'
                    : activeTodayClients.map(c => <div key={c.id}>· {c.name}</div>)}
                </div>
              </div>

              {/* 3 — Expiring ≤30 days + churn risk sub-count */}
              <div style={statCard(churnRisk.length > 0 ? 'rgba(248,113,113,0.30)' : expiring30.length > 0 ? 'rgba(217,119,6,0.15)' : undefined)}>
                <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>Expiring ≤30 Days</div>
                <div style={{ fontSize: 32, fontWeight: 800, color: churnRisk.length > 0 ? 'var(--theme-red)' : expiring30.length > 0 ? 'var(--theme-amber)' : 'var(--theme-green)', lineHeight: 1.1 }}>
                  {expiring30.length}
                </div>
                {churnRisk.length > 0 ? (
                  <div style={{ fontSize: 11, color: 'var(--theme-red)', fontWeight: 700, marginTop: 5 }}>⚠ {churnRisk.length} critical ≤7 days</div>
                ) : (
                  <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 5 }}>Within 30 days</div>
                )}
              </div>

              {/* 4 — No Open Period */}
              <div style={statCard(noPeriod.length > 0 ? 'rgba(248,113,113,0.35)' : undefined)}>
                <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>No Open Period</div>
                <div style={{ fontSize: 32, fontWeight: 800, color: noPeriod.length > 0 ? 'var(--theme-red)' : 'var(--theme-green)', lineHeight: 1.1 }}>{noPeriod.length}</div>
                <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 5 }}>Active clients — need setup</div>
              </div>

              {/* 5 — MRR + ARR */}
              <div style={statCard()}>
                <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>Est. Monthly Revenue</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--theme-accent)', lineHeight: 1.1 }}>
                  NPR {estMRR.toLocaleString('en-NP')}
                </div>
                <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 5 }}>
                  {payingCount} paying · ARR{' '}
                  <span style={{ color: 'var(--theme-accent)', fontWeight: 700 }}>NPR {estARR.toLocaleString('en-NP')}</span>
                </div>
              </div>

              {/* 6 — Trial Signups */}
              <div
                style={{ ...statCard(wantToSub.length > 0 ? 'rgba(248,113,113,0.5)' : trialSignups.length > 0 ? 'rgba(201,168,76,0.25)' : undefined), cursor: 'pointer' }}
                onClick={() => navigate('/admin/clients')}
              >
                <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>Trial Signups</div>
                <div style={{ fontSize: 32, fontWeight: 800, color: trialSignups.length > 0 ? 'var(--theme-accent)' : 'var(--theme-text2)', lineHeight: 1.1 }}>
                  {trialSignups.length}
                </div>
                {wantToSub.length > 0 ? (
                  <div style={{ fontSize: 11, color: 'var(--theme-red)', fontWeight: 700, marginTop: 5, display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#f87171', flexShrink: 0 }} />
                    {wantToSub.length} want{wantToSub.length === 1 ? 's' : ''} to subscribe
                  </div>
                ) : (
                  <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 5 }}>
                    {trialSignups.length === 0 ? 'No active trials' : '7-day free · Starter'} · View →
                  </div>
                )}
              </div>
            </div>

            {/* ── Single merged "All Properties" table ── */}
            <div className="card" style={{ padding: 0 }}>
              <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--theme-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>All Properties</span>
                <span style={{ fontSize: 12, color: 'var(--theme-text3)' }}>
                  MRR: <span style={{ color: 'var(--theme-accent)', fontWeight: 700 }}>NPR {estMRR.toLocaleString('en-NP')}</span>
                  {' '}· {payingCount} paying
                </span>
              </div>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Property</th>
                      <th>Modules</th>
                      <th>Plan</th>
                      <th style={{ textAlign: 'right' }}>Monthly Value</th>
                      <th>Billing</th>
                      <th>Expires (BS)</th>
                      <th>
                        <Tip text="IMS subscription countdown. HR expiry shown in the Billing column if different." width={220}>Sub Status</Tip>
                      </th>
                      <th>Period</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map(c => {
                      const sub     = getSubStatus(c)
                      const mrr     = clientMRR(c)
                      const endDate = c.ims_ends_at || c.subscription_ends_at
                      const isPaying = endDate && sub.days !== null && sub.days > 0
                      const isTrial  = !endDate && c.trial_ends_at
                      const isActiveToday = activeClientIds.has(c.id)

                      const expiryIso = endDate || c.trial_ends_at
                      let expiryBs = null
                      if (expiryIso) {
                        const bs = adToBs(new Date(expiryIso))
                        expiryBs = `${BS_MONTHS[bs.month - 1]} ${bs.year}`
                      }

                      let typeLabel, typeColor
                      if (!c.is_active)       { typeLabel = 'Inactive';     typeColor = 'var(--theme-text3)' }
                      else if (isPaying)      { typeLabel = 'Subscription'; typeColor = 'var(--theme-green)' }
                      else if (isTrial)       { typeLabel = 'Trial';        typeColor = 'var(--theme-accent)' }
                      else if (sub.days !== null && sub.days < 0) { typeLabel = 'Expired'; typeColor = 'var(--theme-red)' }
                      else                    { typeLabel = 'No billing';   typeColor = 'var(--theme-text3)' }

                      const period = clientPeriods[c.id]
                      const isOpen = period?.status === 'open'

                      // HR sub status if different from IMS
                      const hrDays = c.hr_ends_at ? Math.ceil((new Date(c.hr_ends_at) - Date.now()) / 86400000) : null
                      const hrExpiring = hrDays !== null && hrDays <= 30 && hrDays >= 0

                      return (
                        <tr key={c.id} style={{ opacity: c.is_active ? 1 : 0.45, cursor: 'pointer' }}
                          onClick={() => switchAdminClient(c.id, c.name)}>

                          {/* Property + active-today dot */}
                          <td>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                              {isActiveToday && (
                                <span title="Active today" style={{ width: 7, height: 7, borderRadius: '50%', background: '#34d399', flexShrink: 0 }} />
                              )}
                              <div>
                                <div style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{c.name}</div>
                                {c.location && <div style={{ fontSize: 11, color: 'var(--theme-text3)' }}>{c.location}</div>}
                              </div>
                            </div>
                          </td>

                          {/* Module pills */}
                          <td>
                            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                              {c.ims_enabled !== false && (
                                <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 3, background: 'rgba(96,165,250,0.10)', color: '#60a5fa', border: '1px solid rgba(96,165,250,0.2)' }}>IMS</span>
                              )}
                              {c.hr_enabled && (
                                <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 3, background: 'rgba(52,211,153,0.08)', color: '#34d399', border: '1px solid rgba(52,211,153,0.18)' }}>HR</span>
                              )}
                              {c.pos_enabled && (
                                <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 3, background: 'rgba(167,139,250,0.10)', color: '#a78bfa', border: '1px solid rgba(167,139,250,0.2)' }}>POS</span>
                              )}
                            </div>
                          </td>

                          {/* Plan badge(s) */}
                          <td>
                            <span style={planBadge(c.plan)}>
                              {c.plan === 'pro' ? 'Pro' : c.plan === 'growth' ? 'Growth' : 'Starter'}
                            </span>
                            {c.hr_enabled && c.hr_plan && c.hr_plan !== c.plan && (
                              <span style={{ fontSize: 10, color: 'var(--theme-text3)', marginLeft: 5 }}>HR: {c.hr_plan}</span>
                            )}
                            {c.pos_enabled && c.pos_plan && c.pos_plan !== c.plan && (
                              <span style={{ fontSize: 10, color: 'var(--theme-text3)', marginLeft: 5 }}>POS: {c.pos_plan}</span>
                            )}
                          </td>

                          {/* Monthly Value (IMS + HR + POS) */}
                          <td style={{ textAlign: 'right', fontWeight: mrr > 0 ? 700 : 400, color: mrr > 0 ? 'var(--theme-accent)' : 'var(--theme-text3)' }}>
                            {mrr > 0 ? `NPR ${mrr.toLocaleString('en-NP')}` : '—'}
                          </td>

                          {/* Billing type */}
                          <td>
                            <div>
                              <span style={{ fontSize: 12, color: typeColor }}>{typeLabel}</span>
                              {hrExpiring && c.hr_enabled && (
                                <div style={{ fontSize: 10, color: 'var(--theme-amber)', marginTop: 2 }}>HR exp. {hrDays}d</div>
                              )}
                            </div>
                          </td>

                          {/* Expiry date */}
                          <td style={{ color: 'var(--theme-text2)', fontSize: 12 }}>
                            {expiryBs || <span style={{ color: 'var(--theme-text3)' }}>—</span>}
                          </td>

                          {/* Subscription badge */}
                          <td>
                            {sub.label
                              ? <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 4, color: sub.color, background: sub.bg, border: `1px solid ${sub.border}` }}>{sub.label}</span>
                              : <span style={{ color: 'var(--theme-text3)', fontSize: 12 }}>—</span>}
                          </td>

                          {/* Current Period */}
                          <td>
                            {isOpen ? (
                              <span style={{ fontSize: 12, color: 'var(--theme-text1)' }}>
                                {BS_MONTHS[period.bs_month - 1]} {period.bs_year}
                                {' '}<span style={{ fontSize: 10, color: 'var(--theme-green)' }}>● Open</span>
                              </span>
                            ) : period ? (
                              <span style={{ fontSize: 12, color: 'var(--theme-text2)' }}>
                                {BS_MONTHS[period.bs_month - 1]} {period.bs_year}
                                {' '}<span style={{ fontSize: 10, color: 'var(--theme-text3)' }}>● Closed</span>
                              </span>
                            ) : (
                              <span style={{ fontSize: 11, color: 'var(--theme-red)', fontWeight: 600 }}>⚠ No period</span>
                            )}
                          </td>

                          {/* Actions */}
                          <td style={{ textAlign: 'right' }} onClick={e => e.stopPropagation()}>
                            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                              <button className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }}
                                onClick={() => { switchAdminClient(c.id, c.name); navigate('/periods') }}>
                                Periods
                              </button>
                              <button className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 10px', color: 'var(--theme-accent)', borderColor: 'rgba(201,168,76,0.3)' }}
                                onClick={() => navigate('/admin/clients')}>
                                Manage →
                              </button>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                  <tfoot>
                    <tr style={{ borderTop: '2px solid var(--theme-border)' }}>
                      <td colSpan={3} style={{ padding: '10px 12px', fontWeight: 600, color: 'var(--theme-text2)', fontSize: 12 }}>
                        Total — {payingCount} paying · {active.length - payingCount} non-paying
                      </td>
                      <td style={{ textAlign: 'right', padding: '10px 12px', fontWeight: 800, color: 'var(--theme-accent)', fontSize: 15 }}>
                        NPR {estMRR.toLocaleString('en-NP')}
                      </td>
                      <td colSpan={5} />
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          </>
        )}
      </div>
    )
  }

  // ── Client financial dashboard ────────────────────────────────────────────
  // Shared mini card style
  const kpiCard = (onClick) => ({
    background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 10,
    padding: '14px 16px', cursor: onClick ? 'pointer' : 'default',
    transition: 'border-color 0.15s'
  })

  // Compact upsell card for a locked feature → links to /pricing. Only render when the
  // feature is locked; an admin grant flips hasFeature(...) → real KPI shows instead.
  const UpsellCard = ({ label, tier, blurb }) => (
    <div
      onClick={() => navigate('/pricing')}
      style={{
        background: 'rgba(129,140,248,0.05)', border: '1px dashed rgba(129,140,248,0.4)',
        borderRadius: 10, padding: '14px 16px', cursor: 'pointer', transition: 'border-color 0.15s'
      }}
    >
      <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6, display: 'flex', justifyContent: 'space-between' }}>
        <span>{label}</span><span>🔒</span>
      </div>
      <div style={{ fontSize: 15, fontWeight: 700, color: '#818cf8', lineHeight: 1.2 }}>Unlock with {tier}</div>
      <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 5 }}>{blurb} · View plans →</div>
    </div>
  )

  // Module-composable: show a section header per module only when 2+ modules are active.
  // Dashboard sections reflect the displayed client's actual subscription (clientModules),
  // not the admin route-access bypass — so admin "view as client" previews accurately.
  const showIms = clientModules.ims
  const showHr  = clientModules.hr
  const showPos = clientModules.pos
  const moduleCount = [showIms, showHr, showPos].filter(Boolean).length
  const dashTitle = isAdmin
    ? 'Admin Dashboard'
    : moduleCount > 1 ? 'Dashboard'
    : showIms ? 'Inventory Dashboard'
    : showHr  ? 'HR Dashboard'
    : showPos ? 'POS Dashboard'
    : 'Dashboard'
  const showModuleHeaders = moduleCount >= 2
  const moduleHeader = (text) => showModuleHeaders
    ? <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>{text}</div>
    : null

  return (
    <div>
      {/* ── Header ── */}
      <div className="page-header">
        <h1 className="page-title">{dashTitle}</h1>
        <p className="page-subtitle">
          {isAdmin ? (adminViewClientName || '— Select a property from the sidebar —') : (profile?.clients?.name || '')}
          {activePeriod && ` · ${periodLabel} · Open`}
        </p>
      </div>

      {!isAdmin && (() => {
        const s = getSubStatus(profile?.clients)
        if (!s.label || s.days === null || s.days > 7) return null
        const isExpired = s.days < 0
        return (
          <div className="card" style={{ marginBottom: 20, borderColor: s.border, background: s.bg }}>
            <p style={{ color: s.color, margin: 0, fontSize: 14, fontWeight: 600 }}>
              {isExpired ? '⚠ Your subscription has expired' : `⚠ Your ${s.label.startsWith('Trial') ? 'trial' : 'subscription'} expires in ${s.days} day${s.days !== 1 ? 's' : ''}`}
            </p>
            <p style={{ color: 'var(--theme-text2)', margin: '4px 0 0', fontSize: 12 }}>
              Contact your consultant to renew and keep your data accessible.
            </p>
          </div>
        )
      })()}

      {clientModules.ims && !activePeriod && !loading && (
        <div className="card" style={{ marginBottom: 20, cursor: 'pointer', borderColor: 'rgba(201,168,76,0.3)' }} onClick={() => navigate('/periods')}>
          <p style={{ color: 'var(--theme-accent)', margin: 0, fontSize: 14 }}>⚠ No open period. Click here to create one in Periods →</p>
        </div>
      )}

      {periodExpired && !loading && (
        <div className="card" style={{ marginBottom: 20, borderColor: 'rgba(217,119,6,0.15)', background: 'rgba(217,119,6,0.05)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
            <div>
              <p style={{ color: 'var(--theme-amber)', margin: 0, fontSize: 14, fontWeight: 600 }}>
                ◷ {BS_MONTHS[activePeriod.bs_month - 1]} {activePeriod.bs_year} has ended
              </p>
              <p style={{ color: 'var(--theme-text2)', margin: '4px 0 0', fontSize: 12 }}>
                {isAdmin
                  ? `Viewing as admin — go to Periods to close and advance for this property.`
                  : `Finish your month-end stock count, then close this period and open ${BS_MONTHS[nextAdvMonth - 1]}.`}
              </p>
            </div>
            {isAdmin ? (
              <button
                onClick={() => navigate('/periods')}
                style={{
                  flexShrink: 0, background: 'rgba(251,191,36,0.12)',
                  border: '1px solid rgba(251,191,36,0.4)', color: 'var(--theme-amber)',
                  borderRadius: 6, padding: '8px 18px', cursor: 'pointer',
                  fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap'
                }}
              >
                Go to Periods →
              </button>
            ) : (
              <button
                onClick={closeAndAdvancePeriod}
                style={{
                  flexShrink: 0, background: 'rgba(251,191,36,0.12)',
                  border: '1px solid rgba(251,191,36,0.4)', color: 'var(--theme-amber)',
                  borderRadius: 6, padding: '8px 18px', cursor: 'pointer',
                  fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap'
                }}
              >
                End {BS_MONTHS[activePeriod.bs_month - 1]} & Start {BS_MONTHS[nextAdvMonth - 1]} →
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── No modules enabled ── */}
      {!showIms && !showHr && !showPos && (
        <div className="card" style={{ textAlign: 'center', padding: '48px 24px' }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>⊛</div>
          <p style={{ fontSize: 15, color: 'var(--theme-text1)', fontWeight: 600, margin: '0 0 8px' }}>No modules enabled</p>
          <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: 0 }}>Contact your consultant to activate Crest IMS, Crest HR, or Crest POS.</p>
        </div>
      )}

      {/* ── IMS KPIs ── */}
      {showIms && moduleHeader('Inventory')}
      {showIms && <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 14, marginBottom: 14 }}>

        {/* Net Purchases */}
        <div style={kpiCard(() => navigate('/purchases'))} onClick={() => navigate('/purchases')}>
          <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>Net Purchases</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--theme-accent)', lineHeight: 1.1 }}>
            {loading ? '—' : `NPR ${(stats?.purchaseTotal || 0).toLocaleString('en-NP', { maximumFractionDigits: 0 })}`}
          </div>
          <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 5 }}>Gross − returns · {periodLabel} →</div>
        </div>

        {/* Revenue */}
        {canSales ? (
          <div style={kpiCard(() => navigate('/sales'))} onClick={() => navigate('/sales')}>
            <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>Revenue</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--theme-green)', lineHeight: 1.1 }}>
              {loading ? '—' : `NPR ${(stats?.revenueTotal || 0).toLocaleString('en-NP', { maximumFractionDigits: 0 })}`}
            </div>
            <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 5 }}>From sales entries →</div>
          </div>
        ) : null}

        {/* Food Cost % — computable from purchases ÷ revenue, so any sales client sees it */}
        {canSales ? (
          <div style={kpiCard(() => navigate(canVariance ? '/variance' : '/summary'))} onClick={() => navigate(canVariance ? '/variance' : '/summary')}>
            <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>
              <Tip text="Net purchases ÷ revenue × 100. Shows what portion of sales goes to ingredient cost. Healthy range: 28–35% for Nepal F&B." width={240}>Food Cost %</Tip>
            </div>
            <div style={{
              fontSize: 28, fontWeight: 800, lineHeight: 1.1,
              color: fcPct == null ? 'var(--theme-text2)' : fcPct <= 35 ? 'var(--theme-green)' : fcPct <= 45 ? 'var(--theme-accent)' : 'var(--theme-red)'
            }}>
              {loading ? '—' : fcPct != null ? `${fcPct.toFixed(1)}%` : '—'}
            </div>
            <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 5 }}>
              <Tip text="Industry benchmark for Nepal cafes & restaurants. Green = healthy, yellow = watch, red = investigate immediately." width={240}>Target 28–35%</Tip> →
            </div>
          </div>
        ) : null}

        {/* Fixed Costs % (Pro — needs overhead data) */}
        {canOverheads ? (
          <div style={kpiCard(() => navigate('/overheads'))} onClick={() => navigate('/overheads')}>
            <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>
              <Tip text="All fixed costs (rent, utilities, labor, tax & fees) as a % of revenue. Target: under 60% combined. See Overheads page for the full breakdown." width={250}>Fixed Costs % of Revenue</Tip>
            </div>
            <div style={{
              fontSize: 28, fontWeight: 800, lineHeight: 1.1,
              color: ohPct == null ? 'var(--theme-text2)' : ohPct <= 50 ? 'var(--theme-green)' : ohPct <= 65 ? 'var(--theme-accent)' : 'var(--theme-red)'
            }}>
              {loading ? '—' : ohPct != null ? `${ohPct.toFixed(1)}%` : '—'}
            </div>
            <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 5 }}>
              {stats?.overheadTotal ? `NPR ${stats.overheadTotal.toLocaleString('en-NP', { maximumFractionDigits: 0 })} total →` : 'No overhead data'}
            </div>
          </div>
        ) : (
          <UpsellCard label="Fixed Costs & Net Margin" tier="Pro" blurb="See true profit after rent, labor & tax" />
        )}

        {/* Est. Net Margin % (Pro — only meaningful with overhead data) */}
        {canOverheads && (
          <div style={kpiCard(null)}>
            <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>
              <Tip text="Revenue minus food cost and overheads, as a % of revenue. This is what the business keeps after ingredient and fixed costs. Healthy Nepal F&B target: ≥20%." width={260}>Est. Net Margin %</Tip>
            </div>
            <div style={{
              fontSize: 28, fontWeight: 800, lineHeight: 1.1,
              color: netMarginPct == null ? 'var(--theme-text2)' : netMarginPct >= 20 ? 'var(--theme-green)' : netMarginPct >= 10 ? 'var(--theme-accent)' : 'var(--theme-red)'
            }}>
              {loading ? '—' : netMarginPct != null ? `${netMarginPct.toFixed(1)}%` : '—'}
            </div>
            <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 5 }}>After food & overheads · target ≥20%</div>
          </div>
        )}
      </div>}

      {/* ── IMS Row 2 + Charts ── */}
      {showIms && <><div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 14, marginBottom: 20 }}>

        <div style={kpiCard(null)}>
          <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>Active Period</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--theme-text1)' }}>{loading ? '—' : periodLabel}</div>
          <div style={{ fontSize: 11, marginTop: 4, color: activePeriod ? 'var(--theme-green)' : 'var(--theme-red)' }}>
            {activePeriod ? '● Open' : '● No open period'}
          </div>
        </div>

        <div style={kpiCard(() => navigate('/items'))} onClick={() => navigate('/items')}>
          <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>Items in Master</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--theme-text1)' }}>{loading ? '—' : stats?.itemCount}</div>
          <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 4 }}>Active ingredients →</div>
        </div>

        <div style={kpiCard(() => navigate('/vendors'))} onClick={() => navigate('/vendors')}>
          <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>Vendors</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--theme-text1)' }}>{loading ? '—' : stats?.vendorCount}</div>
          <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 4 }}>Active suppliers →</div>
        </div>

        {canRecipes ? (
          <div style={kpiCard(() => navigate('/recipes'))} onClick={() => navigate('/recipes')}>
            <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>Costed Recipes</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--theme-text1)' }}>{loading ? '—' : stats?.recipeCount}</div>
            <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 4 }}>
              {stats?.subRecipeCount > 0 ? `+ ${stats.subRecipeCount} sub-recipes →` : 'Active menu items →'}
            </div>
          </div>
        ) : (
          <UpsellCard label="Costed Recipes" tier="Growth" blurb="Cost every dish & protect margins" />
        )}

        {canMenuReprice ? (
          <div style={kpiCard(() => navigate('/menu-repricing'))} onClick={() => navigate('/menu-repricing')}>
            <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>
              <Tip text="Dishes whose current food-cost % is above their target — priced too low to hit the margin you set. Open the Menu Repricing report for the prices to charge." width={300}>Menu Health</Tip>
            </div>
            <div style={{ fontSize: 22, fontWeight: 700, color: stats?.underpricedCount > 0 ? 'var(--theme-red)' : 'var(--theme-green)' }}>
              {loading ? '—' : `${stats?.underpricedCount || 0} of ${stats?.costedPricedCount || 0}`}
            </div>
            <div style={{ fontSize: 11, color: stats?.menuOpportunityTotal > 0 ? 'var(--theme-accent)' : 'var(--theme-text3)', marginTop: 4 }}>
              {loading ? 'under target →'
                : stats?.menuOpportunityTotal > 0
                  ? `NPR ${Math.round(stats.menuOpportunityTotal).toLocaleString('en-NP')}/mo opportunity →`
                  : 'dishes under target →'}
            </div>
          </div>
        ) : (
          <UpsellCard label="Menu Health" tier="Growth" blurb="Spot underpriced dishes & lost margin" />
        )}

        <div style={kpiCard(() => navigate('/wastage-report'))} onClick={() => navigate('/wastage-report')}>
          <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>
            <Tip text="Total NPR value of wastage recorded this period — qty wasted × unit rate per item." width={220}>Wastage Value</Tip>
          </div>
          <div style={{ fontSize: 22, fontWeight: 700, color: stats?.wastageValueTotal > 0 ? 'var(--theme-red)' : 'var(--theme-text1)' }}>
            {loading ? '—' : `NPR ${Math.round(stats?.wastageValueTotal || 0).toLocaleString('en-NP')}`}
          </div>
          <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 4 }}>This period →</div>
        </div>
      </div>

      {/* ── Charts Row ── */}
      {!loading && activePeriod && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.6fr 1fr', gap: 14, marginBottom: 14 }}>

            {/* Pie — Category Spend */}
            <ChartCard
              title="Spend by Category"
              smallHeight={140}
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
                      const total = categorySpend.reduce((s, r) => s + r.value, 0)
                      return (
                        <div key={entry.name} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                          <div style={{ width: 8, height: 8, borderRadius: 2, background: CHART_COLORS[i % CHART_COLORS.length], flexShrink: 0 }} />
                          <span style={{ fontSize: 10, color: 'var(--theme-text2)' }}>{entry.name}</span>
                          <span style={{ fontSize: 10, color: 'var(--theme-text2)' }}>{total > 0 ? `${((entry.value / total) * 100).toFixed(0)}%` : ''}</span>
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
              cardStyle={{ minWidth: 0 }}
              legend={<>
                <span style={{ color: 'var(--theme-text2)' }}><span style={{ color: '#c9a84c' }}>●</span> Purchases</span>
                {hasDailySales && <span style={{ color: 'var(--theme-text2)' }}><span style={{ color: '#34d399' }}>●</span> Sales</span>}
                {salesProjection && <span style={{ color: 'var(--theme-text2)' }}><span style={{ color: '#34d399', letterSpacing: '-2px' }}>┄</span> Projection</span>}
                {!hasDailySales && <span style={{ color: 'var(--theme-text3)' }}>Enter daily sales to see the sales trend</span>}
              </>}
              footer={salesProjection && (
                <div style={{ marginTop: 8, fontSize: 11, color: 'var(--theme-text2)' }}>
                  Projected month-end revenue: <strong style={{ color: 'var(--theme-green)' }}>NPR {salesProjection.projectedMonthEnd.toLocaleString()}</strong>
                  <span style={{ color: 'var(--theme-text3)' }}> · trend estimate</span>
                </div>
              )}
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
                      <CartesianGrid stroke="#2a2f3d" strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="day" tick={{ fill: '#9ca3af', fontSize: big ? 11 : 9 }} tickLine={false} axisLine={false} interval={0} tickFormatter={v => v.replace('Day ', '')} />
                      <YAxis tick={{ fill: '#9ca3af', fontSize: big ? 11 : 9 }} tickLine={false} axisLine={false} tickFormatter={v => `${(v / 1000).toFixed(0)}k`} width={big ? 40 : 32} />
                      <Tooltip
                        contentStyle={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 6, fontSize: big ? 12 : 11 }}
                        labelStyle={{ color: '#fff' }}
                        formatter={(value, name) => [`NPR ${Math.round(Number(value)).toLocaleString()}`, name]}
                        labelFormatter={l => l}
                      />
                      <Line type="monotone" dataKey="purchases" name="Purchases" stroke="#c9a84c" strokeWidth={big ? 2.5 : 2} connectNulls dot={{ r: big ? 3 : 2, fill: '#c9a84c', strokeWidth: 0 }} activeDot={{ r: big ? 5 : 4, fill: '#c9a84c' }} />
                      {hasDailySales && <Line type="monotone" dataKey="sales" name="Sales" stroke="#34d399" strokeWidth={big ? 2.5 : 2} connectNulls dot={{ r: big ? 3 : 2, fill: '#34d399', strokeWidth: 0 }} activeDot={{ r: big ? 5 : 4, fill: '#34d399' }} />}
                      {salesProjection && <Line type="monotone" dataKey="salesProj" name="Projection" stroke="#34d399" strokeWidth={2} strokeDasharray="5 4" strokeOpacity={0.65} connectNulls dot={false} activeDot={{ r: big ? 4 : 3, fill: '#34d399' }} />}
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
                      <YAxis type="category" dataKey="name" tick={{ fill: '#9ca3af', fontSize: big ? 11 : 9 }} tickLine={false} axisLine={false} width={big ? 130 : 90} />
                      <Tooltip
                        contentStyle={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 6, fontSize: 11 }}
                        formatter={(v, n, p) => [`NPR ${Number(v).toLocaleString()}`, p.payload.fullName || n]}
                        labelFormatter={() => ''}
                      />
                      <Bar dataKey="value" fill="#c9a84c" radius={[0, 3, 3, 0]} barSize={big ? 18 : 10}>
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
              footer={
                <div style={{ display: 'flex', gap: 16, marginTop: 6, fontSize: 10 }}>
                  <span style={{ color: 'var(--theme-green)' }}>● ≤35% Good</span>
                  <span style={{ color: 'var(--theme-accent)' }}>● 35–45% Watch</span>
                  <span style={{ color: 'var(--theme-red)' }}>● &gt;45% High</span>
                  <span style={{ marginLeft: 'auto', color: 'var(--theme-text2)' }}>⊙ = current open period</span>
                </div>
              }
              renderChart={h => (
                <div style={{ overflowX: 'auto', overflowY: 'hidden' }}>
                  <div style={{ minWidth: Math.max(0, fcTrend.length * 64), height: h }}>
                    <ResponsiveContainer width="100%" height={h}>
                      <LineChart data={fcTrend} margin={{ top: 8, right: 48, bottom: 0, left: 0 }}>
                        <CartesianGrid stroke="#2a2f3d" strokeDasharray="3 3" vertical={false} />
                        <XAxis dataKey="label" tick={{ fill: '#9ca3af', fontSize: 10 }} tickLine={false} axisLine={false} interval={0} />
                        <YAxis tick={{ fill: '#9ca3af', fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={v => `${v}%`} domain={['auto', 'auto']} width={36} />
                        <ReferenceLine y={35} stroke="#34d399" strokeDasharray="4 3" strokeOpacity={0.5} label={{ value: '35%', fill: '#34d399', fontSize: 9, position: 'right' }} />
                        <ReferenceLine y={45} stroke="#f87171" strokeDasharray="4 3" strokeOpacity={0.5} label={{ value: '45%', fill: '#f87171', fontSize: 9, position: 'right' }} />
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
                        <Line type="monotone" dataKey="fc" strokeWidth={2} stroke="#c9a84c" connectNulls={false}
                          dot={(props) => {
                            const { cx, cy, payload } = props
                            const col = payload.fc <= 35 ? '#34d399' : payload.fc <= 45 ? '#c9a84c' : '#f87171'
                            return <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={payload.open ? 5 : 3} fill={col} stroke={payload.open ? '#e8e0d0' : 'none'} strokeWidth={1.5} />
                          }}
                          activeDot={{ r: 5, fill: '#c9a84c' }}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}
            />
          )}

          {/* ── Bottom: Variance + Reorder side by side ── */}
          {<div style={{ display: 'grid', gridTemplateColumns: canReorder ? '1fr 1fr' : '1fr', gap: 14, marginBottom: 20 }}>

            {/* Variance table */}
            {canVariance ? (
              <div className="card" style={{ padding: '14px 16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Top Variance Items</div>
                  <button className="btn btn-ghost" style={{ fontSize: 10, padding: '3px 8px' }} onClick={() => navigate('/variance')}>Full Report →</button>
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
                        <th style={{ color: 'var(--theme-text2)', fontWeight: 500, textAlign: 'left', paddingBottom: 6, borderBottom: '1px solid var(--theme-border)' }}>Item</th>
                        <th style={{ color: 'var(--theme-text2)', fontWeight: 500, textAlign: 'right', paddingBottom: 6, borderBottom: '1px solid var(--theme-border)' }}>
                          <Tip text="Qty used above what recipes predict — indicates waste, theft, or over-portioning.">Over-used</Tip>
                        </th>
                        <th style={{ color: 'var(--theme-text2)', fontWeight: 500, textAlign: 'right', paddingBottom: 6, borderBottom: '1px solid var(--theme-border)' }}>
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
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Items to Reorder</div>
                  <button className="btn btn-ghost" style={{ fontSize: 10, padding: '3px 8px' }} onClick={() => navigate('/reorder')}>Full Report →</button>
                </div>
                {reorderItems.length === 0 ? (
                  <p style={{ color: 'var(--theme-text3)', fontSize: 12, margin: '16px 0' }}>
                    No items below par.{' '}
                    <span style={{ color: 'var(--theme-accent)', cursor: 'pointer' }} onClick={() => navigate('/reorder')}>Set par levels →</span>
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
                          <div style={{ fontSize: 11, color: 'var(--theme-red)', fontWeight: 700 }}>↓ {item.shortfall} {item.uom}</div>
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

      {/* ── HR KPIs (below Inventory) ── */}
      {showHr && hrStats && (
        <div style={{ marginBottom: 20, marginTop: showIms ? 6 : 0 }}>
          {moduleHeader('Human Resources')}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 14 }}>
            <div style={kpiCard(() => navigate('/hr/employees'))} onClick={() => navigate('/hr/employees')}>
              <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>Total Employees</div>
              <div style={{ fontSize: 28, fontWeight: 800, color: 'var(--theme-text1)', lineHeight: 1.1 }}>{hrStats.total}</div>
              <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 5 }}>All statuses →</div>
            </div>
            <div style={kpiCard(() => navigate('/hr/employees'))} onClick={() => navigate('/hr/employees')}>
              <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>Active</div>
              <div style={{ fontSize: 28, fontWeight: 800, color: 'var(--theme-green)', lineHeight: 1.1 }}>{hrStats.active}</div>
              {hrStats.probation > 0 && (
                <div style={{ fontSize: 11, color: 'var(--theme-accent)', marginTop: 5 }}>{hrStats.probation} on probation</div>
              )}
            </div>
            <div style={kpiCard(null)}>
              <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>
                <Tip text="Sum of basic salary for active and probation employees. Full payroll with allowances, SSF and TDS is computed during payroll run." width={260}>Basic Payroll / Month</Tip>
              </div>
              <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--theme-accent)', lineHeight: 1.1 }}>
                NPR {Math.round(hrStats.payroll).toLocaleString('en-NP')}
              </div>
              <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 5 }}>Basic salary only</div>
            </div>
          </div>
        </div>
      )}

      {showHr && !hrStats && (
        <div style={{ marginBottom: 20 }}>
          {moduleHeader('Human Resources')}
          <div className="card"><p style={{ color: 'var(--theme-text2)', fontSize: 13, margin: 0 }}>Loading HR data…</p></div>
        </div>
      )}

      {/* ── POS (module slot — Crest POS not yet built) ── */}
      {showPos && (
        <div style={{ marginBottom: 20, marginTop: (showIms || showHr) ? 6 : 0 }}>
          {moduleHeader('Point of Sale')}
          <div className="card" style={{ textAlign: 'center', padding: '28px 24px' }}>
            <div style={{ fontSize: 26, marginBottom: 8 }}>🧾</div>
            <p style={{ fontSize: 14, color: 'var(--theme-text1)', fontWeight: 600, margin: '0 0 4px' }}>Crest POS — coming soon</p>
            <p style={{ fontSize: 12, color: 'var(--theme-text2)', margin: 0 }}>Your POS module is enabled. Live sales, table & billing dashboards will appear here once it launches.</p>
          </div>
        </div>
      )}
    </div>
  )
}
