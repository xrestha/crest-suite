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
import { getBsToday, BS_MONTHS, adToBs } from '../utils/bsCalendar'
import { getSubStatus } from '../utils/subscription'
const CHART_COLORS = ['#c9a84c', '#34d399', '#60a5fa', '#f87171', '#a78bfa', '#fb923c', '#22d3ee', '#f472b6']


export default function Dashboard() {
  const { profile, clientId, isAdmin, imsEnabled, hrEnabled, hasFeature, loading: authLoading, adminViewClientId, adminViewClientName, switchAdminClient } = useAuth()
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
    if (effectiveClientId) {
      if (imsEnabled) loadStats()
      else setLoading(false)
      if (hrEnabled) loadHrStats()
    }
  }, [authLoading, showAdminDash, effectiveClientId, imsEnabled, hrEnabled, location.key]) // eslint-disable-line react-hooks/exhaustive-deps

  const canSales    = hasFeature('sales_entry')
  const canVariance = hasFeature('variance_report')
  const canRecipes  = hasFeature('recipe_costing')
  const canReorder  = hasFeature('reorder_report')

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
      { data: recipeIngs },
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
      period ? supabase.from('sales_entries').select('recipe_id, qty_sold').eq('period_id', period.id) : { data: [] },
      supabase.from('recipes').select('id, name, selling_price').eq('client_id', effectiveClientId),
      supabase.from('recipe_ingredients').select('recipe_id, item_id, qty_per_portion'),
      period ? supabase.from('opening_stock').select('item_id, qty').eq('period_id', period.id) : { data: [] },
      period ? supabase.from('closing_stock').select('item_id, physical_qty').eq('period_id', period.id) : { data: [] },
      supabase.from('items').select('id, name, uom, per_uom_rate, yield_pct, categories(name)').eq('client_id', effectiveClientId).eq('is_active', true).eq('is_sub_recipe', false),
      supabase.from('par_levels').select('item_id, par_qty').eq('client_id', effectiveClientId),
      period ? supabase.from('overheads').select('amount').eq('period_id', period.id) : { data: [] },
      period ? supabase.from('wastages').select('item_id, qty').eq('period_id', period.id) : { data: [] }
    ])

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

    // Daily trend (net)
    const dayGrossMap = {}
    const dayReturnMap = {}
    ;(purchases || []).forEach(p => { dayGrossMap[p.bs_day] = (dayGrossMap[p.bs_day] || 0) + parseFloat(p.qty || 0) * parseFloat(p.rate || 0) })
    ;(returns || []).forEach(r => { dayReturnMap[r.bs_day] = (dayReturnMap[r.bs_day] || 0) + parseFloat(r.qty || 0) * parseFloat(r.rate || 0) })
    const allDays = new Set([...Object.keys(dayGrossMap), ...Object.keys(dayReturnMap)])
    setDailyTrend(
      [...allDays]
        .map(day => ({ day: `Day ${day}`, value: Math.round((dayGrossMap[day] || 0) - (dayReturnMap[day] || 0)) }))
        .sort((a, b) => parseInt(a.day.replace('Day ', '')) - parseInt(b.day.replace('Day ', '')))
    )

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

    setStats({ itemCount, vendorCount, recipeCount, subRecipeCount, purchaseTotal, revenueTotal, overheadTotal, wastageValueTotal })
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
    if (!activePeriod) return
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
        .select('id, name, plan, is_active, trial_ends_at, subscription_ends_at, location')
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
    const expiring = active.filter(c => { const s = getSubStatus(c); return s.days !== null && s.days >= 0 && s.days <= 30 })
    const noPeriod = active.filter(c => !clientPeriods[c.id] || clientPeriods[c.id].status !== 'open')
    const PLAN_MRR = { starter: 8000, growth: 18000, pro: 25000 }
    const estMRR   = active.reduce((sum, c) => {
      if (!c.subscription_ends_at) return sum
      const s = getSubStatus(c)
      return sum + (s.days > 0 ? (PLAN_MRR[c.plan] || 0) : 0)
    }, 0)

    const sorted = [
      ...active.filter(c => {
        const s = getSubStatus(c)
        return (s.days !== null && s.days <= 30) || !clientPeriods[c.id] || clientPeriods[c.id].status !== 'open'
      }),
      ...active.filter(c => {
        const s = getSubStatus(c)
        return !(s.days !== null && s.days <= 30) && clientPeriods[c.id] && clientPeriods[c.id].status === 'open'
      }),
      ...inactive,
    ]

    const statCard = (borderColor) => ({
      background: '#181c27', border: `1px solid ${borderColor || '#2a2f3d'}`,
      borderRadius: 10, padding: '16px 18px'
    })

    return (
      <div>
        <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <h1 className="page-title">Dashboard</h1>
            <p className="page-subtitle">{active.length} active · {inactive.length} inactive · {adminClients.length} total properties</p>
          </div>
          <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => navigate('/admin/clients')}>Manage Clients →</button>
        </div>

        {adminLoading ? <p style={{ color: '#6b7280', fontSize: 13 }}>Loading…</p> : (
          <>
            {/* Platform KPIs */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14, marginBottom: 20 }}>
              <div style={statCard()}>
                <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>Active Properties</div>
                <div style={{ fontSize: 32, fontWeight: 800, color: '#e8e0d0', lineHeight: 1.1 }}>{active.length}</div>
                <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 5 }}>{inactive.length} inactive · {adminClients.length} total</div>
                <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid #2a2f3d' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: activeTodayClients.length > 0 ? 5 : 0 }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: activeTodayClients.length > 0 ? '#34d399' : '#374151', flexShrink: 0 }} />
                    <span style={{ fontSize: 11, color: activeTodayClients.length > 0 ? '#34d399' : '#6b7280', fontWeight: activeTodayClients.length > 0 ? 700 : 400 }}>
                      {activeTodayClients.length} active today
                    </span>
                  </div>
                  {activeTodayClients.map(c => (
                    <div key={c.id} style={{ fontSize: 11, color: '#9ca3af', paddingLeft: 11, lineHeight: 1.7 }}>· {c.name}</div>
                  ))}
                </div>
              </div>

              <div style={statCard(expiring.length > 0 ? 'rgba(217,119,6,0.15)' : undefined)}>
                <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>Expiring Soon</div>
                <div style={{ fontSize: 32, fontWeight: 800, color: expiring.length > 0 ? '#fbbf24' : '#34d399', lineHeight: 1.1 }}>{expiring.length}</div>
                <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 5 }}>Within 30 days</div>
              </div>

              <div style={statCard(noPeriod.length > 0 ? 'rgba(248,113,113,0.35)' : undefined)}>
                <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>No Open Period</div>
                <div style={{ fontSize: 32, fontWeight: 800, color: noPeriod.length > 0 ? '#f87171' : '#34d399', lineHeight: 1.1 }}>{noPeriod.length}</div>
                <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 5 }}>Active clients — need setup</div>
              </div>

              <div style={statCard()}>
                <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>Est. Monthly Revenue</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: '#c9a84c', lineHeight: 1.1 }}>
                  NPR {estMRR.toLocaleString('en-NP')}
                </div>
                <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 5 }}>Paying clients only</div>
              </div>
            </div>

            {/* Revenue & Billing table */}
            <div className="card" style={{ padding: 0, marginBottom: 20 }}>
              <div style={{ padding: '14px 20px', borderBottom: '1px solid #2a2f3d', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Revenue & Billing</span>
                <span style={{ fontSize: 12, color: '#9ca3af' }}>
                  MRR: <span style={{ color: '#c9a84c', fontWeight: 700 }}>NPR {estMRR.toLocaleString('en-NP')}</span>
                  {' '}· {active.filter(c => { const s = getSubStatus(c); return s.days !== null && s.days > 0 && c.subscription_ends_at }).length} paying
                </span>
              </div>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Property</th>
                      <th>Plan</th>
                      <th>Monthly Value</th>
                      <th>Billing Type</th>
                      <th>Expires (BS)</th>
                      <th>Subscription</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map(c => {
                      const sub = getSubStatus(c)
                      const monthlyVal = PLAN_MRR[c.plan] || 0
                      const isPaying = c.subscription_ends_at && sub.days !== null && sub.days > 0
                      const isTrial  = !c.subscription_ends_at && c.trial_ends_at

                      const expiryIso = c.subscription_ends_at || c.trial_ends_at
                      let expiryBs = null
                      if (expiryIso) {
                        const bs = adToBs(new Date(expiryIso))
                        expiryBs = `${BS_MONTHS[bs.month - 1]} ${bs.year}`
                      }

                      let typeLabel, typeColor
                      if (!c.is_active)      { typeLabel = 'Inactive';     typeColor = '#9ca3af' }
                      else if (isPaying)     { typeLabel = 'Subscription'; typeColor = '#34d399' }
                      else if (isTrial)      { typeLabel = 'Trial';        typeColor = '#c9a84c' }
                      else if (sub.days !== null && sub.days < 0) { typeLabel = 'Expired'; typeColor = '#f87171' }
                      else                   { typeLabel = 'No billing';   typeColor = '#9ca3af' }

                      return (
                        <tr key={c.id} style={{ opacity: c.is_active ? 1 : 0.45, cursor: 'pointer' }}
                          onClick={() => switchAdminClient(c.id, c.name)}>
                          <td>
                            <div style={{ fontWeight: 600, color: '#e8e0d0' }}>{c.name}</div>
                            {c.location && <div style={{ fontSize: 11, color: '#9ca3af' }}>{c.location}</div>}
                          </td>
                          <td>
                            <span style={{
                              fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 4,
                              color: c.plan === 'pro' ? '#c9a84c' : c.plan === 'growth' ? '#34d399' : '#6b7280',
                              background: c.plan === 'pro' ? 'rgba(201,168,76,0.12)' : c.plan === 'growth' ? 'rgba(52,211,153,0.10)' : 'rgba(120,113,108,0.10)',
                              border: `1px solid ${c.plan === 'pro' ? 'rgba(201,168,76,0.25)' : c.plan === 'growth' ? 'rgba(52,211,153,0.20)' : 'rgba(120,113,108,0.20)'}`,
                            }}>
                              {c.plan === 'pro' ? 'Pro' : c.plan === 'growth' ? 'Growth' : 'Starter'}
                            </span>
                          </td>
                          <td style={{ fontWeight: isPaying ? 700 : 400, color: isPaying ? '#c9a84c' : '#9ca3af' }}>
                            {isPaying ? `NPR ${monthlyVal.toLocaleString('en-NP')}` : '—'}
                          </td>
                          <td>
                            <span style={{ fontSize: 12, color: typeColor }}>{typeLabel}</span>
                          </td>
                          <td style={{ color: '#6b7280', fontSize: 12 }}>
                            {expiryBs || <span style={{ color: '#9ca3af' }}>—</span>}
                          </td>
                          <td>
                            {sub.label
                              ? <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 4, color: sub.color, background: sub.bg, border: `1px solid ${sub.border}` }}>{sub.label}</span>
                              : <span style={{ color: '#9ca3af', fontSize: 12 }}>—</span>}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                  <tfoot>
                    <tr style={{ borderTop: '2px solid #2a2f3d' }}>
                      <td colSpan={2} style={{ padding: '10px 12px', fontWeight: 600, color: '#6b7280', fontSize: 12 }}>
                        Total ({active.filter(c => { const s = getSubStatus(c); return s.days !== null && s.days > 0 && c.subscription_ends_at }).length} paying clients)
                      </td>
                      <td style={{ padding: '10px 12px', fontWeight: 800, color: '#c9a84c', fontSize: 15 }}>
                        NPR {estMRR.toLocaleString('en-NP')}
                      </td>
                      <td colSpan={3} />
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>

            {/* Client health table */}
            <div className="card" style={{ padding: 0 }}>
              <div style={{ padding: '14px 20px', borderBottom: '1px solid #2a2f3d' }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                  Client Health
                </span>
              </div>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Property</th>
                      <th>Plan</th>
                      <th>Subscription</th>
                      <th>Current Period</th>
                      <th>Status</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map(c => {
                      const sub    = getSubStatus(c)
                      const period = clientPeriods[c.id]
                      const isOpen = period?.status === 'open'
                      return (
                        <tr key={c.id} style={{ cursor: 'pointer', opacity: c.is_active ? 1 : 0.45 }}
                          onClick={() => switchAdminClient(c.id, c.name)}>
                          <td>
                            <div style={{ fontWeight: 600, color: '#e8e0d0' }}>{c.name}</div>
                            {c.location && <div style={{ fontSize: 11, color: '#9ca3af' }}>{c.location}</div>}
                          </td>
                          <td>
                            <span style={{
                              fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 4,
                              color: c.plan === 'pro' ? '#c9a84c' : c.plan === 'growth' ? '#34d399' : '#6b7280',
                              background: c.plan === 'pro' ? 'rgba(201,168,76,0.12)' : c.plan === 'growth' ? 'rgba(52,211,153,0.10)' : 'rgba(120,113,108,0.10)',
                              border: `1px solid ${c.plan === 'pro' ? 'rgba(201,168,76,0.25)' : c.plan === 'growth' ? 'rgba(52,211,153,0.20)' : 'rgba(120,113,108,0.20)'}`,
                            }}>
                              {c.plan === 'pro' ? 'Pro' : c.plan === 'growth' ? 'Growth' : 'Starter'}
                            </span>
                          </td>
                          <td>
                            {sub.label
                              ? <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 4, color: sub.color, background: sub.bg, border: `1px solid ${sub.border}` }}>{sub.label}</span>
                              : <span style={{ color: '#9ca3af', fontSize: 12 }}>—</span>}
                          </td>
                          <td>
                            {isOpen ? (
                              <span style={{ fontSize: 13, color: '#e8e0d0' }}>
                                {BS_MONTHS[period.bs_month - 1]} {period.bs_year}
                                {' '}<span style={{ fontSize: 11, color: '#34d399', fontWeight: 600 }}>● Open</span>
                              </span>
                            ) : period ? (
                              <span style={{ fontSize: 13, color: '#6b7280' }}>
                                {BS_MONTHS[period.bs_month - 1]} {period.bs_year}
                                {' '}<span style={{ fontSize: 11, color: '#6b7280' }}>● Closed</span>
                              </span>
                            ) : (
                              <span style={{ fontSize: 12, color: '#f87171', fontWeight: 600 }}>⚠ No period yet</span>
                            )}
                          </td>
                          <td>
                            <span className={`badge ${c.is_active ? 'badge-green' : 'badge-gray'}`}>
                              {c.is_active ? 'Active' : 'Inactive'}
                            </span>
                          </td>
                          <td style={{ textAlign: 'right' }} onClick={e => e.stopPropagation()}>
                            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                              <button
                                className="btn btn-ghost"
                                style={{ fontSize: 11, padding: '4px 10px' }}
                                onClick={() => { switchAdminClient(c.id, c.name); navigate('/periods') }}
                              >
                                Periods
                              </button>
                              <button
                                className="btn btn-ghost"
                                style={{ fontSize: 11, padding: '4px 10px', color: '#c9a84c', borderColor: 'rgba(201,168,76,0.3)' }}
                                onClick={() => navigate('/admin/clients')}
                              >
                                Manage →
                              </button>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
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
    background: '#181c27', border: '1px solid #2a2f3d', borderRadius: 10,
    padding: '14px 16px', cursor: onClick ? 'pointer' : 'default',
    transition: 'border-color 0.15s'
  })

  return (
    <div>
      {/* ── Header ── */}
      <div className="page-header">
        <h1 className="page-title">Dashboard</h1>
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
            <p style={{ color: '#6b7280', margin: '4px 0 0', fontSize: 12 }}>
              Contact your consultant to renew and keep your data accessible.
            </p>
          </div>
        )
      })()}

      {!activePeriod && !loading && (
        <div className="card" style={{ marginBottom: 20, cursor: 'pointer', borderColor: 'rgba(201,168,76,0.3)' }} onClick={() => navigate('/periods')}>
          <p style={{ color: '#c9a84c', margin: 0, fontSize: 14 }}>⚠ No open period. Click here to create one in Periods →</p>
        </div>
      )}

      {periodExpired && !loading && (
        <div className="card" style={{ marginBottom: 20, borderColor: 'rgba(217,119,6,0.15)', background: 'rgba(217,119,6,0.05)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
            <div>
              <p style={{ color: '#fbbf24', margin: 0, fontSize: 14, fontWeight: 600 }}>
                ◷ {BS_MONTHS[activePeriod.bs_month - 1]} {activePeriod.bs_year} has ended
              </p>
              <p style={{ color: '#6b7280', margin: '4px 0 0', fontSize: 12 }}>
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
                  border: '1px solid rgba(251,191,36,0.4)', color: '#fbbf24',
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
                  border: '1px solid rgba(251,191,36,0.4)', color: '#fbbf24',
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
      {!imsEnabled && !hrEnabled && (
        <div className="card" style={{ textAlign: 'center', padding: '48px 24px' }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>⊛</div>
          <p style={{ fontSize: 15, color: '#e8e0d0', fontWeight: 600, margin: '0 0 8px' }}>No modules enabled</p>
          <p style={{ fontSize: 13, color: '#6b7280', margin: 0 }}>Contact your consultant to activate Crest IMS, Crest HR, or Crest POS.</p>
        </div>
      )}

      {/* ── HR KPIs ── */}
      {hrEnabled && hrStats && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>
            Human Resources
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 14 }}>
            <div style={kpiCard(() => navigate('/hr/employees'))} onClick={() => navigate('/hr/employees')}>
              <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>Total Employees</div>
              <div style={{ fontSize: 28, fontWeight: 800, color: '#e8e0d0', lineHeight: 1.1 }}>{hrStats.total}</div>
              <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 5 }}>All statuses →</div>
            </div>
            <div style={kpiCard(() => navigate('/hr/employees'))} onClick={() => navigate('/hr/employees')}>
              <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>Active</div>
              <div style={{ fontSize: 28, fontWeight: 800, color: '#34d399', lineHeight: 1.1 }}>{hrStats.active}</div>
              {hrStats.probation > 0 && (
                <div style={{ fontSize: 11, color: '#c9a84c', marginTop: 5 }}>{hrStats.probation} on probation</div>
              )}
            </div>
            <div style={kpiCard(null)}>
              <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>
                <Tip text="Sum of basic salary for active and probation employees. Full payroll with allowances, SSF and TDS is computed during payroll run." width={260}>Basic Payroll / Month</Tip>
              </div>
              <div style={{ fontSize: 20, fontWeight: 800, color: '#c9a84c', lineHeight: 1.1 }}>
                NPR {Math.round(hrStats.payroll).toLocaleString('en-NP')}
              </div>
              <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 5 }}>Basic salary only</div>
            </div>
          </div>
        </div>
      )}

      {hrEnabled && !hrStats && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>Human Resources</div>
          <div className="card"><p style={{ color: '#6b7280', fontSize: 13, margin: 0 }}>Loading HR data…</p></div>
        </div>
      )}

      {/* ── IMS KPIs ── */}
      {imsEnabled && <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 14, marginBottom: 14 }}>

        {/* Net Purchases */}
        <div style={kpiCard(() => navigate('/purchases'))} onClick={() => navigate('/purchases')}>
          <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>Net Purchases</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: '#c9a84c', lineHeight: 1.1 }}>
            {loading ? '—' : `NPR ${(stats?.purchaseTotal || 0).toLocaleString('en-NP', { maximumFractionDigits: 0 })}`}
          </div>
          <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 5 }}>Gross − returns · {periodLabel} →</div>
        </div>

        {/* Revenue */}
        {canSales ? (
          <div style={kpiCard(() => navigate('/sales'))} onClick={() => navigate('/sales')}>
            <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>Revenue</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: '#34d399', lineHeight: 1.1 }}>
              {loading ? '—' : `NPR ${(stats?.revenueTotal || 0).toLocaleString('en-NP', { maximumFractionDigits: 0 })}`}
            </div>
            <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 5 }}>From sales entries →</div>
          </div>
        ) : null}

        {/* Food Cost % */}
        {(canSales && canVariance) ? (
          <div style={kpiCard(() => navigate('/variance'))} onClick={() => navigate('/variance')}>
            <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>
              <Tip text="Net purchases ÷ revenue × 100. Shows what portion of sales goes to ingredient cost. Healthy range: 28–35% for Nepal F&B." width={240}>Food Cost %</Tip>
            </div>
            <div style={{
              fontSize: 28, fontWeight: 800, lineHeight: 1.1,
              color: fcPct == null ? '#6b7280' : fcPct <= 35 ? '#34d399' : fcPct <= 45 ? '#c9a84c' : '#f87171'
            }}>
              {loading ? '—' : fcPct != null ? `${fcPct.toFixed(1)}%` : '—'}
            </div>
            <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 5 }}>
              <Tip text="Industry benchmark for Nepal cafes & restaurants. Green = healthy, yellow = watch, red = investigate immediately." width={240}>Target 28–35%</Tip> →
            </div>
          </div>
        ) : null}

        {/* Fixed Costs % */}
        <div style={kpiCard(() => navigate('/overheads'))} onClick={() => navigate('/overheads')}>
          <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>
            <Tip text="All fixed costs (rent, utilities, labor, tax & fees) as a % of revenue. Target: under 60% combined. See Overheads page for the full breakdown." width={250}>Fixed Costs % of Revenue</Tip>
          </div>
          <div style={{
            fontSize: 28, fontWeight: 800, lineHeight: 1.1,
            color: ohPct == null ? '#6b7280' : ohPct <= 50 ? '#34d399' : ohPct <= 65 ? '#c9a84c' : '#f87171'
          }}>
            {loading ? '—' : ohPct != null ? `${ohPct.toFixed(1)}%` : '—'}
          </div>
          <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 5 }}>
            {stats?.overheadTotal ? `NPR ${stats.overheadTotal.toLocaleString('en-NP', { maximumFractionDigits: 0 })} total →` : 'No overhead data'}
          </div>
        </div>

        {/* Est. Net Margin % */}
        {canSales && (
          <div style={kpiCard(null)}>
            <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>
              <Tip text="Revenue minus food cost and overheads, as a % of revenue. This is what the business keeps after ingredient and fixed costs. Healthy Nepal F&B target: ≥20%." width={260}>Est. Net Margin %</Tip>
            </div>
            <div style={{
              fontSize: 28, fontWeight: 800, lineHeight: 1.1,
              color: netMarginPct == null ? '#6b7280' : netMarginPct >= 20 ? '#34d399' : netMarginPct >= 10 ? '#c9a84c' : '#f87171'
            }}>
              {loading ? '—' : netMarginPct != null ? `${netMarginPct.toFixed(1)}%` : '—'}
            </div>
            <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 5 }}>After food & overheads · target ≥20%</div>
          </div>
        )}
      </div>}

      {/* ── IMS Row 2 + Charts ── */}
      {imsEnabled && <><div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 14, marginBottom: 20 }}>

        <div style={kpiCard(null)}>
          <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>Active Period</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#e8e0d0' }}>{loading ? '—' : periodLabel}</div>
          <div style={{ fontSize: 11, marginTop: 4, color: activePeriod ? '#34d399' : '#f87171' }}>
            {activePeriod ? '● Open' : '● No open period'}
          </div>
        </div>

        <div style={kpiCard(() => navigate('/items'))} onClick={() => navigate('/items')}>
          <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>Items in Master</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: '#e8e0d0' }}>{loading ? '—' : stats?.itemCount}</div>
          <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>Active ingredients →</div>
        </div>

        <div style={kpiCard(() => navigate('/vendors'))} onClick={() => navigate('/vendors')}>
          <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>Vendors</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: '#e8e0d0' }}>{loading ? '—' : stats?.vendorCount}</div>
          <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>Active suppliers →</div>
        </div>

        {canRecipes ? (
          <div style={kpiCard(() => navigate('/recipes'))} onClick={() => navigate('/recipes')}>
            <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>Costed Recipes</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: '#e8e0d0' }}>{loading ? '—' : stats?.recipeCount}</div>
            <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>
              {stats?.subRecipeCount > 0 ? `+ ${stats.subRecipeCount} sub-recipes →` : 'Active menu items →'}
            </div>
          </div>
        ) : null}

        <div style={kpiCard(() => navigate('/wastage-report'))} onClick={() => navigate('/wastage-report')}>
          <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>
            <Tip text="Total NPR value of wastage recorded this period — qty wasted × unit rate per item." width={220}>Wastage Value</Tip>
          </div>
          <div style={{ fontSize: 22, fontWeight: 700, color: stats?.wastageValueTotal > 0 ? '#f87171' : '#e8e0d0' }}>
            {loading ? '—' : `NPR ${Math.round(stats?.wastageValueTotal || 0).toLocaleString('en-NP')}`}
          </div>
          <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>This period →</div>
        </div>
      </div>

      {/* ── Charts Row ── */}
      {!loading && activePeriod && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14, marginBottom: 14 }}>

            {/* Pie — Category Spend */}
            <div className="card" style={{ padding: '14px 16px' }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Spend by Category
              </div>
              {categorySpend.length === 0 ? (
                <div style={{ height: 160, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <p style={{ color: '#9ca3af', fontSize: 12 }}>No purchase data</p>
                </div>
              ) : (
                <>
                  <ResponsiveContainer width="100%" height={140}>
                    <PieChart margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
                      <Pie
                        data={categorySpend} dataKey="value" nameKey="name"
                        cx="50%" cy="50%" innerRadius={38} outerRadius={60}
                        paddingAngle={2}
                      >
                        {categorySpend.map((entry, i) => <Cell key={entry.name} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                      </Pie>
                      <Tooltip
                        contentStyle={{ background: '#181c27', border: '1px solid #2a2f3d', borderRadius: 6, fontSize: 11 }}
                        formatter={v => [`NPR ${Number(v).toLocaleString()}`, '']}
                        labelFormatter={name => name}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                  {/* Legend */}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px', marginTop: 6 }}>
                    {categorySpend.map((entry, i) => {
                      const total = categorySpend.reduce((s, r) => s + r.value, 0)
                      return (
                        <div key={entry.name} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                          <div style={{ width: 8, height: 8, borderRadius: 2, background: CHART_COLORS[i % CHART_COLORS.length], flexShrink: 0 }} />
                          <span style={{ fontSize: 10, color: '#6b7280' }}>{entry.name}</span>
                          <span style={{ fontSize: 10, color: '#6b7280' }}>{total > 0 ? `${((entry.value / total) * 100).toFixed(0)}%` : ''}</span>
                        </div>
                      )
                    })}
                  </div>
                </>
              )}
            </div>

            {/* Line — Daily Trend */}
            <div className="card" style={{ padding: '14px 16px' }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Daily Purchase Trend
              </div>
              {dailyTrend.length === 0 ? (
                <div style={{ height: 160, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <p style={{ color: '#9ca3af', fontSize: 12 }}>No purchase data</p>
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={160}>
                  <LineChart data={dailyTrend} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                    <CartesianGrid stroke="#2a2f3d" strokeDasharray="3 3" vertical={false} />
                    <XAxis
                      dataKey="day" tick={{ fill: '#9ca3af', fontSize: 9 }}
                      tickLine={false} axisLine={false}
                      interval={Math.ceil(dailyTrend.length / 6)}
                      tickFormatter={v => v.replace('Day ', '')}
                    />
                    <YAxis
                      tick={{ fill: '#9ca3af', fontSize: 9 }} tickLine={false} axisLine={false}
                      tickFormatter={v => `${(v / 1000).toFixed(0)}k`} width={32}
                    />
                    <Tooltip
                      contentStyle={{ background: '#181c27', border: '1px solid #2a2f3d', borderRadius: 6, fontSize: 11 }}
                      formatter={v => [`NPR ${Number(v).toLocaleString()}`, 'Net']}
                      labelFormatter={l => l}
                    />
                    <Line type="monotone" dataKey="value" stroke="#c9a84c" strokeWidth={2}
                      dot={{ r: 2, fill: '#c9a84c', strokeWidth: 0 }}
                      activeDot={{ r: 4, fill: '#c9a84c' }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>

            {/* Bar — Top Items */}
            <div className="card" style={{ padding: '14px 16px' }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Top Items by Spend
              </div>
              {topItemSpend.length === 0 ? (
                <div style={{ height: 160, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <p style={{ color: '#9ca3af', fontSize: 12 }}>No purchase data</p>
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={160}>
                  <BarChart
                    data={topItemSpend.slice(0, 6)} layout="vertical"
                    margin={{ top: 0, right: 8, bottom: 0, left: 0 }}
                  >
                    <XAxis type="number" hide />
                    <YAxis
                      type="category" dataKey="name"
                      tick={{ fill: '#6b7280', fontSize: 9 }} tickLine={false} axisLine={false}
                      width={90}
                    />
                    <Tooltip
                      contentStyle={{ background: '#181c27', border: '1px solid #2a2f3d', borderRadius: 6, fontSize: 11 }}
                      formatter={(v, n, p) => [`NPR ${Number(v).toLocaleString()}`, p.payload.fullName || n]}
                      labelFormatter={() => ''}
                    />
                    <Bar dataKey="value" fill="#c9a84c" radius={[0, 3, 3, 0]} barSize={10}>
                      {topItemSpend.slice(0, 6).map((entry, i) => (
                        <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          {/* ── FC% Trend ── */}
          {fcTrend.length >= 2 && canSales && (
            <div className="card" style={{ padding: '14px 16px', marginBottom: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Food Cost % — Monthly Trend
              </div>
              <ResponsiveContainer width="100%" height={160}>
                <LineChart data={fcTrend} margin={{ top: 8, right: 48, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke="#2a2f3d" strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="label" tick={{ fill: '#9ca3af', fontSize: 10 }} tickLine={false} axisLine={false} />
                  <YAxis
                    tick={{ fill: '#9ca3af', fontSize: 10 }} tickLine={false} axisLine={false}
                    tickFormatter={v => `${v}%`} domain={['auto', 'auto']} width={36}
                  />
                  <ReferenceLine y={35} stroke="#34d399" strokeDasharray="4 3" strokeOpacity={0.5}
                    label={{ value: '35%', fill: '#34d399', fontSize: 9, position: 'right' }} />
                  <ReferenceLine y={45} stroke="#f87171" strokeDasharray="4 3" strokeOpacity={0.5}
                    label={{ value: '45%', fill: '#f87171', fontSize: 9, position: 'right' }} />
                  <Tooltip
                    contentStyle={{ background: '#181c27', border: '1px solid #2a2f3d', borderRadius: 6, fontSize: 11, color: '#e8e0d0' }}
                    labelStyle={{ color: '#e8e0d0' }}
                    itemStyle={{ color: '#e8e0d0' }}
                    formatter={(v, _n, props) => {
                      const p = props.payload
                      const lines = [`${v}%`]
                      if (p.purchases != null) lines.push(`Purchases: NPR ${p.purchases.toLocaleString('en-NP')}`)
                      if (p.revenue != null)   lines.push(`Revenue: NPR ${p.revenue.toLocaleString('en-NP')}`)
                      return [lines.join(' · '), 'Food Cost %']
                    }}
                  />
                  <Line
                    type="monotone" dataKey="fc" strokeWidth={2} stroke="#c9a84c"
                    connectNulls={false}
                    dot={(props) => {
                      const { cx, cy, payload } = props
                      const col = payload.fc <= 35 ? '#34d399' : payload.fc <= 45 ? '#c9a84c' : '#f87171'
                      return <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={payload.open ? 5 : 3} fill={col} stroke={payload.open ? '#e8e0d0' : 'none'} strokeWidth={1.5} />
                    }}
                    activeDot={{ r: 5, fill: '#c9a84c' }}
                  />
                </LineChart>
              </ResponsiveContainer>
              <div style={{ display: 'flex', gap: 16, marginTop: 6, fontSize: 10 }}>
                <span style={{ color: '#34d399' }}>● ≤35% Good</span>
                <span style={{ color: '#c9a84c' }}>● 35–45% Watch</span>
                <span style={{ color: '#f87171' }}>● &gt;45% High</span>
                <span style={{ marginLeft: 'auto', color: '#6b7280' }}>⊙ = current open period</span>
              </div>
            </div>
          )}

          {/* ── Bottom: Variance + Reorder side by side ── */}
          {(canVariance || canReorder) && <div style={{ display: 'grid', gridTemplateColumns: canVariance && canReorder ? '1fr 1fr' : '1fr', gap: 14, marginBottom: 20 }}>

            {/* Variance table */}
            {canVariance ? (
              <div className="card" style={{ padding: '14px 16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Top Variance Items</div>
                  <button className="btn btn-ghost" style={{ fontSize: 10, padding: '3px 8px' }} onClick={() => navigate('/variance')}>Full Report →</button>
                </div>
                {topVariance.length === 0 ? (
                  <p style={{ color: '#9ca3af', fontSize: 12, margin: '16px 0' }}>
                    Complete stock count + add sales to see variance.
                  </p>
                ) : (
                  <div className="table-wrap">
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                      <tr>
                        <th style={{ color: '#6b7280', fontWeight: 500, textAlign: 'left', paddingBottom: 6, borderBottom: '1px solid #2a2f3d' }}>Item</th>
                        <th style={{ color: '#6b7280', fontWeight: 500, textAlign: 'right', paddingBottom: 6, borderBottom: '1px solid #2a2f3d' }}>
                          <Tip text="Qty used above what recipes predict — indicates waste, theft, or over-portioning.">Over-used</Tip>
                        </th>
                        <th style={{ color: '#6b7280', fontWeight: 500, textAlign: 'right', paddingBottom: 6, borderBottom: '1px solid #2a2f3d' }}>
                          <Tip text="Over-used qty × item rate. The NPR cost of unaccounted usage this period." width={200}>Value at Risk</Tip>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {topVariance.map((row, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid #0f1117' }}>
                          <td style={{ padding: '5px 0', fontWeight: 600, color: '#e8e0d0' }}>{row.name}</td>
                          <td style={{ padding: '5px 0', textAlign: 'right', color: '#f87171' }}>+{Number(row.variance.toFixed(1)).toLocaleString()} {row.uom}</td>
                          <td style={{ padding: '5px 0', textAlign: 'right', fontWeight: 700, color: '#f87171' }}>NPR {Number(row.value.toFixed(0)).toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </div>
                )}
              </div>
            ) : null}

            {/* Reorder panel */}
            {canReorder ? (
              <div className="card" style={{ padding: '14px 16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Items to Reorder</div>
                  <button className="btn btn-ghost" style={{ fontSize: 10, padding: '3px 8px' }} onClick={() => navigate('/reorder')}>Full Report →</button>
                </div>
                {reorderItems.length === 0 ? (
                  <p style={{ color: '#9ca3af', fontSize: 12, margin: '16px 0' }}>
                    No items below par.{' '}
                    <span style={{ color: '#c9a84c', cursor: 'pointer' }} onClick={() => navigate('/reorder')}>Set par levels →</span>
                  </p>
                ) : (
                  <div>
                    {reorderItems.map((item, i) => (
                      <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0', borderBottom: i < reorderItems.length - 1 ? '1px solid #0f1117' : 'none' }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 12, fontWeight: 600, color: '#e8e0d0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.name}</div>
                          <div style={{ fontSize: 10, color: '#6b7280' }}>Stock: {item.currentStock} · Par: {item.par} {item.uom}</div>
                        </div>
                        <div style={{ textAlign: 'right', marginLeft: 12, flexShrink: 0 }}>
                          <div style={{ fontSize: 11, color: '#f87171', fontWeight: 700 }}>↓ {item.shortfall} {item.uom}</div>
                          <div style={{ fontSize: 10, color: '#9ca3af' }}>NPR {item.estValue.toLocaleString()}</div>
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
    </div>
  )
}
