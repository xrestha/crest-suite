import { useEffect, useState } from 'react'
import { useAuth } from '../../context/AuthContext'
import { supabase } from '../../supabaseClient'
import { useScopedDb } from '../../shared/hooks/useScopedDb'
import { useNavigate, useLocation } from 'react-router-dom'
import {
  ResponsiveContainer, PieChart, Pie, Cell, Tooltip,
  LineChart, Line, XAxis, YAxis, CartesianGrid, ReferenceLine,
  BarChart, Bar
} from 'recharts'
import Tip from '../../components/Tip'
import ChartCard from '../../components/ChartCard'
import { getBsToday, BS_MONTHS, daysInBsMonth } from '../../utils/bsCalendar'
import { getSubStatus } from '../../utils/subscription'
const CHART_COLORS = ['#c9a84c', '#34d399', '#60a5fa', '#f87171', '#a78bfa', '#fb923c', '#22d3ee', '#f472b6']

export default function ClientDashboard() {
  const { profile, clientId, isAdmin, clientModules, hasFeature, loading: authLoading, adminViewClientName } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const { scopedFrom, scopedInsert, scopedUpdate } = useScopedDb()
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

  useEffect(() => {
    if (authLoading) return
    if (!effectiveClientId) return
    // Load only the modules the displayed client actually subscribes to (clientModules from
    // AuthContext already resolves real-client vs admin "view as client").
    if (clientModules.ims) loadStats(); else setLoading(false)
    if (clientModules.hr) loadHrStats(); else setHrStats(null)
  }, [authLoading, effectiveClientId, clientModules.ims, clientModules.hr, location.key]) // eslint-disable-line react-hooks/exhaustive-deps

  const canSales    = hasFeature('sales_entry')
  const canVariance = hasFeature('variance_report')
  const canRecipes  = hasFeature('recipe_costing')
  const canMenuReprice = hasFeature('menu_repricing')
  const canReorder  = hasFeature('reorder_report')
  const canOverheads = hasFeature('overheads')

  async function loadStats() {
    setLoading(true)

    const { data: period } = await scopedFrom('monthly_periods')
      .eq('status', 'open')
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
      scopedFrom('items', '*', { count: 'exact', head: true }).eq('is_active', true).eq('is_sub_recipe', false),
      scopedFrom('vendors', '*', { count: 'exact', head: true }).eq('is_active', true),
      scopedFrom('recipes', '*', { count: 'exact', head: true }).eq('is_active', true).neq('category', 'Sub-Recipe'),
      scopedFrom('recipes', '*', { count: 'exact', head: true }).eq('is_active', true).eq('category', 'Sub-Recipe'),
      period ? supabase.from('purchase_entries').select('item_id, qty, rate, bs_day').eq('period_id', period.id) : { data: [] },
      period ? supabase.from('vendor_returns').select('item_id, qty, rate, bs_day').eq('period_id', period.id) : { data: [] },
      period ? supabase.from('sales_entries').select('recipe_id, qty_sold, bs_day').eq('period_id', period.id) : { data: [] },
      scopedFrom('recipes', 'id, name, selling_price, category, is_active, target_fc_pct'),
      period ? supabase.from('opening_stock').select('item_id, qty').eq('period_id', period.id) : { data: [] },
      period ? supabase.from('closing_stock').select('item_id, physical_qty').eq('period_id', period.id) : { data: [] },
      scopedFrom('items', 'id, name, uom, per_uom_rate, yield_pct, categories(name)').eq('is_active', true).eq('is_sub_recipe', false),
      scopedFrom('par_levels', 'item_id, par_qty'),
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
    const { data: employees } = await scopedFrom('hr_employees', 'status, basic_salary')
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
    await scopedUpdate('monthly_periods', { status: 'closed' }).eq('id', activePeriod.id)
    await scopedInsert('monthly_periods', {
      bs_year: nextYear,
      bs_month: nextMonth,
      status: 'open'
    })
    loadStats()
  }

  async function loadFcTrend(currentPeriod, currentFcPct) {
    const { data: closedPeriods } = await scopedFrom('monthly_periods', 'id, bs_year, bs_month')
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
      scopedFrom('recipes', 'id, selling_price'),
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
