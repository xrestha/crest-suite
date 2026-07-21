// Sales pivot data for the dashboard — Category × Day, the one dimension pair that generalizes
// across both possible sales sources: `sales_entries` (manual entry, every IMS client) and
// `pos_order_items` (POS-enabled clients). A Category × Payment-Method pivot would only work for
// POS, and gets complicated by split-tender orders needing an allocation rule — Category × Day
// works identically for both, via `recipes.category` (a plain text column, not a FK table).
// Scoped to the CURRENTLY OPEN period (this is the live dashboard, matching every other figure
// already on this page) — not the frozen-report convention used elsewhere in this codebase.
import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../../context/AuthContext'
import { useScopedDb } from '../../shared/hooks/useScopedDb'
import { supabase } from '../../supabaseClient'
import { bsToAd, adToBs, daysInBsMonth } from '../../utils/bsCalendar'

// Same Nepal-offset boundary construction as ClientDashboard.jsx's own bsDayBoundaryIso — bsToAd
// gives local Y/M/D components with no timezone conversion, but .toISOString() would convert
// using the RUNTIME's offset, not Nepal's fixed +05:45, silently shifting the day boundary for a
// viewer outside Nepal. Duplicated here (not imported) since the original is a small unexported
// local function inside a page component, not a shared util.
function bsDayBoundaryIso(bsYear, bsMonth, bsDay, endOfDay) {
  const d = bsToAd(bsYear, bsMonth, bsDay)
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0')
  return endOfDay ? `${y}-${m}-${dd}T23:59:59.999+05:45` : `${y}-${m}-${dd}T00:00:00.000+05:45`
}

async function loadFromSalesEntries(period, scopedFrom) {
  const [{ data: sales }, { data: recipes }] = await Promise.all([
    supabase.from('sales_entries').select('recipe_id, bs_day, qty_sold, unit_price').eq('period_id', period.id).neq('source', 'pos_comp'),
    scopedFrom('recipes', 'id, category, selling_price'),
  ])
  const priceMap = {}, catMap = {}
  ;(recipes || []).forEach(r => { priceMap[r.id] = parseFloat(r.selling_price) || 0; catMap[r.id] = r.category || 'Uncategorized' })
  const agg = {}
  ;(sales || []).forEach(s => {
    const day = parseInt(s.bs_day) || 0
    const price = s.unit_price != null ? parseFloat(s.unit_price) : (priceMap[s.recipe_id] || 0)
    const amount = (parseFloat(s.qty_sold) || 0) * price
    const cat = catMap[s.recipe_id] || 'Uncategorized'
    const key = `${cat}|${day}`
    agg[key] = (agg[key] || 0) + amount
  })
  return Object.entries(agg).map(([key, amount]) => {
    const [category, day] = key.split('|')
    return { category, day: parseInt(day), amount }
  })
}

async function loadFromPos(period, scopedFrom) {
  const fromTs = bsDayBoundaryIso(period.bs_year, period.bs_month, 1, false)
  const lastDay = daysInBsMonth(period.bs_year, period.bs_month)
  const toTs = bsDayBoundaryIso(period.bs_year, period.bs_month, lastDay, true)
  // Same exclusions as SalesReport.jsx/computePosSection — credit-noted bills' revenue
  // correction posts on the day the Credit Note is issued, not retroactively here.
  const { data: orders } = await scopedFrom('pos_orders', 'id, closed_at, credit_note_id')
    .eq('close_type', 'paid').gte('closed_at', fromTs).lte('closed_at', toTs)
  const validOrders = (orders || []).filter(o => !o.credit_note_id)
  if (validOrders.length === 0) return []
  const orderDayMap = {}
  validOrders.forEach(o => { orderDayMap[o.id] = adToBs(new Date(o.closed_at)).day })
  const orderIds = validOrders.map(o => o.id)
  const { data: items } = await scopedFrom('pos_order_items', 'order_id, category, qty, unit_price, comped').in('order_id', orderIds)
  const agg = {}
  ;(items || []).forEach(i => {
    if (i.comped) return // never billed at menu price — excluded from revenue, same as every POS report
    const day = orderDayMap[i.order_id]
    if (!day) return
    const cat = i.category || 'Uncategorized'
    const amount = (parseFloat(i.qty) || 0) * (parseFloat(i.unit_price) || 0)
    const key = `${cat}|${day}`
    agg[key] = (agg[key] || 0) + amount
  })
  return Object.entries(agg).map(([key, amount]) => {
    const [category, day] = key.split('|')
    return { category, day: parseInt(day), amount }
  })
}

// Returns { rows, loading } where rows is a flat [{ category, day, amount }] — the caller pivots
// this into whatever top-N/last-N-days shape it wants to display (SalesPivot.jsx).
export function useSalesPivotData({ activePeriod, posEnabled }) {
  const { clientId } = useAuth()
  const { scopedFrom } = useScopedDb()
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const loadIdRef = useRef(0)

  useEffect(() => {
    if (!clientId || !activePeriod) { setRows([]); setLoading(false); return }
    const myId = ++loadIdRef.current
    setLoading(true)
    const loader = posEnabled ? loadFromPos(activePeriod, scopedFrom) : loadFromSalesEntries(activePeriod, scopedFrom)
    loader.then(flatRows => {
      if (loadIdRef.current !== myId) return // superseded by a newer client switch
      setRows(flatRows)
      setLoading(false)
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, activePeriod?.id, posEnabled])

  return { rows, loading }
}
