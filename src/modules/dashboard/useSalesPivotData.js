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
import { fetchAllRows, fetchAllRowsChunked } from '../../shared/fetchAllRows'
import { supabase } from '../../supabaseClient'
import { firstError } from '../../shared/queryError'
import { errorLine } from '../../shared/errorText'
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

export async function loadFromSalesEntries(period, scopedFrom) {
  const results = await Promise.all([
    // Excludes both pos_comp (never billed) and pos (already counted by the POS-sourced pivot —
    // PosOrders.jsx stamps a source:'pos' row per bill at close) so this "manual" pivot and the
    // POS pivot can render side by side without double-counting the same revenue.
    //
    // FILTERED IN JS, never as `.neq('source', …)` (S734). `sales_entries.source` is nullable
    // (DEFAULT 'manual', no NOT NULL) and in SQL `NULL <> 'pos_comp'` is NULL rather than true,
    // so the two chained `.neq`s dropped every legacy row written before that column had a
    // default — i.e. exactly the hand-entered rows this pivot is titled "Manual Sales by
    // Category" to show. An older client's manual pivot could come back empty under a card that
    // reads as fact. Third instance of this defect on the dashboards; see the rule in
    // `.claude/rules/dashboards.md`.
    fetchAllRows(() => supabase.from('sales_entries').select('recipe_id, bs_day, qty_sold, unit_price, discount, source').eq('period_id', period.id).order('id')),
    scopedFrom('recipes', 'id, category, selling_price'),
  ])
  // Same rule as loadFromPos below: a failed read here would render as "No sales recorded yet
  // this period" on a card an owner reads as fact (S682).
  const failed = firstError(results)
  if (failed) throw new Error(failed)
  const [{ data: sales }, { data: recipes }] = results
  const priceMap = {}, catMap = {}
  ;(recipes || []).forEach(r => { priceMap[r.id] = parseFloat(r.selling_price) || 0; catMap[r.id] = r.category || 'Uncategorized' })
  const agg = {}
  ;(sales || []).forEach(s => {
    if (s.source === 'pos_comp' || s.source === 'pos') return // see the read above
    const day = parseInt(s.bs_day) || 0
    const price = s.unit_price != null ? parseFloat(s.unit_price) : (priceMap[s.recipe_id] || 0)
    const amount = (parseFloat(s.qty_sold) || 0) * price - (parseFloat(s.discount) || 0)
    const cat = catMap[s.recipe_id] || 'Uncategorized'
    const key = `${cat}|${day}`
    agg[key] = (agg[key] || 0) + amount
  })
  return Object.entries(agg).map(([key, amount]) => {
    const [category, day] = key.split('|')
    return { category, day: parseInt(day), amount }
  })
}

export async function loadFromPos(period, scopedFrom) {
  const fromTs = bsDayBoundaryIso(period.bs_year, period.bs_month, 1, false)
  const lastDay = daysInBsMonth(period.bs_year, period.bs_month)
  const toTs = bsDayBoundaryIso(period.bs_year, period.bs_month, lastDay, true)
  // Same exclusions as SalesReport.jsx/computePosSection — credit-noted bills' revenue
  // correction posts on the day the Credit Note is issued, not retroactively here.
  // Paged (S734), for the same reason the line list below it already is: this is one row per
  // BILL for a whole month, so a till closing 40 a day crosses PostgREST's 1000-row cap inside
  // one period — and a truncated ORDER list silently shortens the very `orderIds` the paged
  // item read filters on, so paging the child while leaving the parent bare buys nothing. The
  // producer-and-consumer rule (S706/S708) pointing at a read that had the consumer half right.
  const { data: orders, error: ordersErr } = await fetchAllRows(() =>
    scopedFrom('pos_orders', 'id, closed_at, credit_note_id')
      .eq('close_type', 'paid').gte('closed_at', fromTs).lte('closed_at', toTs)
      .order('id'))
  // A failed read must not render as "No sales recorded yet this period" — that is the silent-zero
  // shape on the dashboard card an owner glances at between services (S682). Throw so the hook can
  // say the figure could not be built.
  if (ordersErr) throw new Error(errorLine(ordersErr))
  const validOrders = (orders || []).filter(o => !o.credit_note_id)
  if (validOrders.length === 0) return []
  const orderDayMap = {}
  validOrders.forEach(o => { orderDayMap[o.id] = adToBs(new Date(o.closed_at)).day })
  const orderIds = validOrders.map(o => o.id)
  // Paged AND chunked: a month of bill lines runs to thousands, past PostgREST's silent 1000-row
  // cap, which would quietly shrink the dashboard's POS Sales by Category pivot to a fraction of
  // the month while still reading as a complete one (S529) — and the `.in()` list is spelled out
  // in the request URL at ~37 characters per uuid, so a month's worth of order ids is a 414
  // before the row cap is even reached (S629, applied here S734).
  const { data: items, error: itemsErr } = await fetchAllRowsChunked(orderIds, ids => scopedFrom('pos_order_items', 'order_id, category, qty, unit_price, comped').in('order_id', ids).order('id'))
  if (itemsErr) throw new Error(errorLine(itemsErr))
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

// Returns { rows, loading, error } where rows is a flat [{ category, day, amount }] — the caller pivots
// this into whatever top-N/last-N-days shape it wants to display (SalesPivot.jsx).
export function useSalesPivotData({ activePeriod, posEnabled }) {
  const { clientId } = useAuth()
  const { scopedFrom } = useScopedDb()
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const loadIdRef = useRef(0)

  useEffect(() => {
    if (!clientId || !activePeriod) { setRows([]); setLoading(false); return }
    const myId = ++loadIdRef.current
    setLoading(true)
    setError(null)
    const loader = posEnabled ? loadFromPos(activePeriod, scopedFrom) : loadFromSalesEntries(activePeriod, scopedFrom)
    loader.then(flatRows => {
      if (loadIdRef.current !== myId) return // superseded by a newer client switch
      setRows(flatRows)
      setLoading(false)
    }).catch(e => {
      if (loadIdRef.current !== myId) return
      setError(e?.message || 'Could not load the sales breakdown.')
      setRows([])
      setLoading(false)
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, activePeriod?.id, posEnabled])

  return { rows, loading, error }
}
