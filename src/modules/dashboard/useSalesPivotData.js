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
import { errorLine } from '../../shared/errorText'
import { daysInBsMonth, bsDayBoundaryIso } from '../../utils/bsCalendar'
import { nepalBs } from '../../shared/nepalTime'
import { isManualSource } from '../ims/sales/salesDepletion'
import { buildCategoryDayRows } from '../pos/reports/salesReportMath'

// A failed read must not render as "No sales recorded yet this period" — that is the silent-zero
// shape on the dashboard card an owner glances at between services (S682). Throw so the hook can
// say the figure could not be built.
function throwIfFailed(results) {
  const bad = (results || []).find(r => r && r.error)
  if (bad) throw new Error(errorLine(bad.error))
}

/**
 * Category × Day from `sales_entries`, the IMS revenue rows, at the price each row was charged
 * (`unit_price`, after discount, before VAT) less its own discount.
 *
 * `sources` decides which rows (S814 4d, REPORTS-9 / IMS-HANDOFF-7):
 *   'manual'   (the default, the Manual pivot) only hand-entered rows: `source` NULL or 'manual'
 *              (salesDepletion.isManualSource). Everything the till wrote is left out, the credit
 *              notes' `pos_credit` / `pos_credit_restock` reversals included — they reverse a till
 *              bill this pivot never showed, so subtracting them here took a till return off
 *              hand-entered sales (BLOOM CAFE's −450 / −160 on Ashwin 18).
 *   'revenue'  every row except `pos_comp`, the periodRevenue rule (periodCost.js): the Inventory
 *              Revenue tile's population, so Sales Mix built from it splits that same figure by
 *              category and a credit note comes off once.
 *
 * FILTERED IN JS, never as `.neq('source', …)` (S734): `sales_entries.source` is nullable and
 * `NULL <> 'pos'` is NULL in SQL, which dropped exactly the legacy hand-entered rows.
 */
export async function loadFromSalesEntries(period, scopedFrom, { sources = 'manual' } = {}) {
  const keep = sources === 'revenue' ? s => s.source !== 'pos_comp' : s => isManualSource(s.source)
  const results = await Promise.all([
    fetchAllRows(() => supabase.from('sales_entries').select('recipe_id, bs_day, qty_sold, unit_price, discount, source').eq('period_id', period.id).order('id')),
    // Paged like every master-data map on the dashboards (S734): a recipe past the cut would price
    // its sales at 0 and file them under Uncategorized.
    fetchAllRows(() => scopedFrom('recipes', 'id, category, selling_price').order('id')),
  ])
  throwIfFailed(results)
  const [{ data: sales }, { data: recipes }] = results
  const priceMap = {}, catMap = {}
  ;(recipes || []).forEach(r => { priceMap[r.id] = parseFloat(r.selling_price) || 0; catMap[r.id] = r.category || 'Uncategorized' })
  const agg = {}
  ;(sales || []).forEach(s => {
    if (!keep(s)) return
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

// `vat_registered` (S809 2c): each bill is valued under the tax status it was issued with.
const PIVOT_ORDER_COLUMNS = 'id, closed_at, discount_amount, vat_registered'

/**
 * Category × Day from the till, on the Sales Report's rule (S814 4d, REPORTS-9): every paid bill
 * closed in the period at full value on its own day, a since-credited one included, and every credit
 * note issued in the period a minus on the day it was issued, whichever month its bill closed in
 * (salesReportMath.buildCategoryDayRows). The day is Nepal's (nepalBs), never the viewer's clock: a
 * bill closed at 23:59 in Kathmandu is that day's for an admin abroad too.
 *
 * Rows carry `billed` (after discount, VAT included, what the pivot shows, as `amount`) and `exVat`.
 */
export async function loadFromPos(period, scopedFrom, clientId) {
  const fromTs = bsDayBoundaryIso(period.bs_year, period.bs_month, 1, false)
  const toTs = bsDayBoundaryIso(period.bs_year, period.bs_month, daysInBsMonth(period.bs_year, period.bs_month), true)
  // Paged (S734): one row per BILL (and per note) for a whole month, past PostgREST's silent 1000-row
  // cap at a busy till, and a truncated bill list silently shortens the id list the line read uses.
  const results = await Promise.all([
    fetchAllRows(() => scopedFrom('pos_orders', PIVOT_ORDER_COLUMNS)
      .eq('close_type', 'paid').gte('closed_at', fromTs).lte('closed_at', toTs).order('id')),
    fetchAllRows(() => scopedFrom('pos_credit_notes', 'id, order_id, created_at')
      .gte('created_at', fromTs).lte('created_at', toTs).order('id')),
    // Today's flag decides only a bill with no stamp (billVatRegistered); `?? true` as the Sales Report.
    supabase.from('settings').select('is_vat_registered').eq('client_id', clientId).maybeSingle(),
  ])
  throwIfFailed(results)
  const [{ data: orderData }, { data: noteData }, { data: settings }] = results
  const orders = orderData || []
  const creditNotes = noteData || []
  if (orders.length === 0 && creditNotes.length === 0) return []

  // The bills this period's notes credit that closed in an earlier month: their lines are what the
  // note returns. Chunked, since the ids ride in the URL.
  const inPeriod = new Set(orders.map(o => o.id))
  const earlierIds = [...new Set(creditNotes.map(n => n.order_id).filter(id => id && !inPeriod.has(id)))]
  const earlier = await fetchAllRowsChunked(earlierIds, ids => scopedFrom('pos_orders', PIVOT_ORDER_COLUMNS).in('id', ids).order('id'))
  throwIfFailed([earlier])
  const allOrders = [...orders, ...(earlier.data || [])]
  const orderById = Object.fromEntries(allOrders.map(o => [o.id, o]))

  // Paged AND chunked: a month of bill lines runs to thousands, past the 1000-row cap (S529), and a
  // month of order ids in one `.in()` is a 414 before the row cap is reached (S629, S734).
  // selection_key marks a combo's dish ('@'), which takes none of the bill discount (S839, isComboItem).
  const items = await fetchAllRowsChunked(allOrders.map(o => o.id),
    ids => scopedFrom('pos_order_items', 'order_id, category, qty, unit_price, vat_rate, comped, selection_key').in('order_id', ids).order('id'))
  throwIfFailed([items])
  const itemsByOrder = {}
  for (const i of items.data || []) {
    if (i.comped) continue // never billed at menu price — excluded from revenue, as on every POS report
    ;(itemsByOrder[i.order_id] = itemsByOrder[i.order_id] || []).push(i)
  }

  const dayOf = ts => {
    const bs = nepalBs(ts)
    return bs && bs.year === period.bs_year && bs.month === period.bs_month ? bs.day : null
  }
  return buildCategoryDayRows({
    orders, creditNotes, orderById, itemsByOrder, vatReg: settings?.is_vat_registered ?? true, dayOf,
  }).map(r => ({ ...r, amount: r.billed }))
}

/**
 * Returns { rows, loading, error, asOf, refreshError } where rows is a flat [{ category, day, amount }]
 * — the caller pivots it into whatever top-N/last-N-days shape it wants (SalesPivot.jsx).
 *
 * `refreshKey`: bump it to re-read the same period (the POS Dashboard's Refresh, and its tick once
 * the last read is five minutes old). A failed REFRESH keeps the last good rows on screen and says
 * so (`refreshError`), the POS Dashboard's own rule; only a failed first read of a period is `error`.
 */
export function useSalesPivotData({ activePeriod, posEnabled, refreshKey = 0 }) {
  const { clientId } = useAuth()
  const { scopedFrom } = useScopedDb()
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [refreshError, setRefreshError] = useState(null)
  const [asOf, setAsOf] = useState(null)
  const loadIdRef = useRef(0)
  const shownKeyRef = useRef(null) // whose rows are on screen: client, period and source

  useEffect(() => {
    if (!clientId || !activePeriod) { shownKeyRef.current = null; setRows([]); setLoading(false); return }
    const myId = ++loadIdRef.current
    const key = `${clientId}:${activePeriod.id}:${posEnabled ? 'pos' : 'manual'}`
    const refreshing = shownKeyRef.current === key
    if (!refreshing) { setLoading(true); setError(null) }
    const loader = posEnabled ? loadFromPos(activePeriod, scopedFrom, clientId) : loadFromSalesEntries(activePeriod, scopedFrom)
    loader.then(flatRows => {
      if (loadIdRef.current !== myId) return // superseded by a newer client switch
      shownKeyRef.current = key
      setRows(flatRows)
      setError(null)
      setRefreshError(null)
      setAsOf(Date.now())
      setLoading(false)
    }).catch(e => {
      if (loadIdRef.current !== myId) return
      const message = e?.message || 'Could not load the sales breakdown.'
      if (refreshing) { setRefreshError(message); return } // the last good rows stay
      shownKeyRef.current = null
      setError(message)
      setRows([])
      setLoading(false)
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, activePeriod?.id, posEnabled, refreshKey])

  return { rows, loading, error, asOf, refreshError }
}
