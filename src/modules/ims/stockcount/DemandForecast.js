import { nprOrDash, npr } from '../../../shared/nepalMoney'
import { useState, useEffect, useCallback, useMemo, Fragment } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'
import { supabase } from '../../../supabaseClient'
import { firstError } from '../../../shared/queryError'
import { fetchAllRows, fetchAllRowsChunked } from '../../../shared/fetchAllRows'
import { useBizInfo } from '../../../shared/hooks/useBizInfo'
import { sheetWithLetterhead } from '../../../shared/excelLetterhead'
import { nepalBs, nepalBsLong, nepalCivilDate } from '../../../shared/nepalTime'
import Tip from '../../../components/Tip'
import ReportLoadError from '../../../components/ReportLoadError'
import { BS_MONTHS, bsToAd, getBsToday, formatAd, daysInBsMonth } from '../../../utils/bsCalendar'
import { runForecast } from '../../../utils/demandForecastData'
import { splitDishList, totalQtyByRecipe, aggregateIngredientDemand, ingredientBuyList, scaleForecastDays, usualSupplierByItem, SAMPLES_PER_WEEKDAY, OCCASIONAL_THRESHOLD } from '../../../utils/demandForecastMath'
import { packsFor, packText } from './reorderPacks'
import { useSettings } from '../../../context/SettingsContext'
import { useWeatherStrip } from '../../dashboard/useWeatherStrip'
import { rainFactorForMonth, rainPctValue } from '../../dashboard/weatherEffect'
import { buildStockRows } from './stockReportCalc'
import { explodeRecipeIngredients } from '../../../utils/recipeCost'
import { loadDeltaExplosion } from '../../../utils/orderLineIngredients'
import { printWithTitle } from '../../../utils/printTitle'
import { errorText } from '../../../shared/errorText'
import SuiteGate from '../../../components/SuiteGate'
import { Navigate, useNavigate } from 'react-router-dom'
import { FilterChips } from '../../../components/Tabs'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const WEEKDAYS_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const fmtNpr = nprOrDash
const PREVIEW_COUNT = 8

// Base-unit quantities span "0.25 kg" and "1,250 gm" — two decimals below 100, whole above.
function fmtQty(q) {
  if (q == null || !isFinite(q)) return '—'
  if (Math.abs(q) >= 100) return Math.round(q).toLocaleString('en-IN')
  return parseFloat(q.toFixed(2)).toLocaleString('en-IN', { maximumFractionDigits: 2 })
}

const dayOf = f => bsToAd(f.bs.year, f.bs.month, f.bs.day).getDay()
const bsLabel = f => `${f.bs.day} ${BS_MONTHS[f.bs.month - 1]} ${f.bs.year}`
const bsKey = bs => bs.year * 10000 + bs.month * 100 + bs.day

// One stored run, the newest (S792 PLANNING-1). A Recompute whose clear-up failed leaves two runs
// side by side, and the reshape below would keep whichever copy of each day it met last. Since
// S792.4 a Recompute also leaves any NEWER run alone (runForecast clears only older ones, so two at
// once can no longer empty the horizon) — which makes "newest" the rule both sides share. A run is
// its run_id; rows from before that column have none but were written by one INSERT, so they share
// generated_at (the statement's now()), which stands in for it.
function newestRunOnly(rows) {
  if (rows.length === 0) return rows
  const runOf = r => r.run_id ?? `at:${r.generated_at}`
  const newest = rows.reduce((a, b) => (new Date(b.generated_at) > new Date(a.generated_at) ? b : a))
  const keep = runOf(newest)
  return rows.filter(r => runOf(r) === keep)
}

// What stands behind "In store": the one on-hand calculation (buildStockRows, S696), for the open
// period or else the latest — never a local copy of opening + purchases − usage (S756, D21).
// Throws on any failed read; the caller turns that into its own notice rather than an empty shelf.
// Returns `{ onHandById: null, period: null }` when the client has no period at all.
async function loadOnHand(scopedFrom, items) {
  const { data: periods, error: pErr } = await scopedFrom('monthly_periods', 'id, bs_year, bs_month, status')
    .order('bs_year', { ascending: false }).order('bs_month', { ascending: false })
  if (pErr) throw pErr
  const period = (periods || []).find(p => p.status === 'open') || (periods || [])[0]
  if (!period) return { onHandById: null, period: null, parById: null, periods: periods || [] }
  const itemIds = items.map(i => i.id)
  if (itemIds.length === 0) return { onHandById: {}, period, parById: {}, periods }
  // Per-item tables narrowed to the forecast's ingredients (chunked: the id list is a URL, and
  // each is one row per item per period or more). Sales stay whole-period and paged, because
  // usage of these items can come from any dish sold, not only the forecast ones.
  const byItems = (table, cols, scoped) => fetchAllRowsChunked(itemIds, ids =>
    (scoped ? scopedFrom(table, cols) : supabase.from(table).select(cols))
      .eq('period_id', period.id).in('item_id', ids).order('id'))
  const results = await Promise.all([
    byItems('opening_stock', 'item_id, qty'),
    byItems('closing_stock', 'item_id, physical_qty'),
    byItems('purchase_entries', 'item_id, qty'),
    byItems('vendor_returns', 'item_id, qty', true),
    byItems('wastages', 'item_id, qty'),
    byItems('staff_meals', 'item_id, qty'),
    // bs_day + source feed the POS-supersedes-manual rule inside buildStockRows; ingredient_deltas
    // because a customized plate also consumes its options' stock lines (S758).
    fetchAllRows(() => supabase.from('sales_entries').select('recipe_id, qty_sold, bs_day, source, ingredient_deltas').eq('period_id', period.id).order('id')),
    // Safety stock (S800): each item's par — one row per item per client, so chunked by item.
    fetchAllRowsChunked(itemIds, ids => scopedFrom('par_levels', 'id, item_id, par_qty').in('item_id', ids).order('id')),
  ])
  const failed = firstError(results)
  if (failed) throw failed
  const [{ data: opening }, { data: closing }, { data: purchases }, { data: returns }, { data: wastages }, { data: staffMeals }, { data: sales }, { data: pars }] = results
  const soldIds = [...new Set((sales || []).map(s => s.recipe_id).filter(Boolean))]
  // Both walks throw on a failed read, which the caller already turns into its own notice (S758).
  const [breakdown, explosion] = await Promise.all([
    soldIds.length > 0 ? explodeRecipeIngredients(supabase, soldIds) : {},
    loadDeltaExplosion(supabase, (sales || []).map(s => s.ingredient_deltas)),
  ])
  const rows = buildStockRows({ items, opening, closing, purchases, returns, wastages, staffMeals, sales, breakdown, explosion })
  return {
    onHandById: Object.fromEntries(rows.map(r => [r.item.id, r.onHand])),
    period,
    periods,
    countedIds: new Set(rows.filter(r => r.stockSource === 'closing').map(r => r.item.id)),
    parById: Object.fromEntries((pars || []).map(p => [p.item_id, Number(p.par_qty) || 0])),
  }
}

// Who each item is usually bought from (S800): the vendor on its latest purchase line over the last
// SUPPLIER_LOOKBACK periods. purchase_entries is period-scoped, so it is read through the client's
// own period ids. Throws on a failed read; the caller shows the list ungrouped and says why.
const SUPPLIER_LOOKBACK = 6
async function loadUsualSuppliers(scopedFrom, itemIds, periods) {
  const ordinal = p => p.bs_year * 100 + p.bs_month
  const recent = [...(periods || [])].sort((a, b) => ordinal(b) - ordinal(a)).slice(0, SUPPLIER_LOOKBACK)
  if (recent.length === 0 || itemIds.length === 0) return { byItem: {}, names: {} }
  const rankById = Object.fromEntries(recent.map(p => [p.id, ordinal(p)]))
  const recentIds = recent.map(p => p.id)
  const [linesRes, vendorsRes] = await Promise.all([
    fetchAllRowsChunked(itemIds, ids => supabase.from('purchase_entries')
      .select('id, item_id, vendor_id, period_id, bs_day, created_at')
      .in('period_id', recentIds).in('item_id', ids).not('vendor_id', 'is', null).order('id')),
    fetchAllRows(() => scopedFrom('vendors', 'id, name, is_active').order('id')),
  ])
  const failed = firstError([linesRes, vendorsRes])
  if (failed) throw failed
  return {
    byItem: usualSupplierByItem(linesRes.data, rankById),
    names: Object.fromEntries((vendorsRes.data || []).map(v => [v.id, v.name])),
    active: new Set((vendorsRes.data || []).filter(v => v.is_active !== false).map(v => v.id)),
  }
}

// What stood behind a day's numbers — shown under the weekday and on every dish's hover, so a
// forecast averaged over one week and one over eight no longer look identical (S694).
function evidenceText(f) {
  const weekday = WEEKDAYS_FULL[dayOf(f)]
  if (f.sampleCount == null) return null // written before sample_count existed — say nothing rather than guess
  if (f.sampleCount === 0) return `no ${weekday}s in the last 12 weeks had sales`
  return `from the last ${f.sampleCount} ${weekday}${f.sampleCount === 1 ? '' : 's'}${f.sampleCount >= SAMPLES_PER_WEEKDAY ? '' : ' with sales'}`
}

export default function DemandForecast() {
  const { clientId, hasImsAccess, clientModules, hasFeature } = useAuth()
  const { settings } = useSettings()
  const navigate = useNavigate()
  const { scopedFrom } = useScopedDb()
  const horizonReq = useLatestRequest()
  const [horizon, setHorizon] = useState(7)
  const [forecast, setForecast] = useState([])
  const [recipeNames, setRecipeNames] = useState({})
  const [expandedIdx, setExpandedIdx] = useState(null) // which day's dish list is showing everything instead of the top plates
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [recomputing, setRecomputing] = useState(false)
  const [msg, setMsg] = useState('')
  const [lastRun, setLastRun] = useState(null)
  // The letterhead (S756): the hand-rolled clients + settings read dropped both errors, so a failed
  // read printed and exported a nameless sheet. useBizInfo carries `error`, and Print/Export wait on it.
  const biz = useBizInfo()
  // The recipe-name read's own error slot (S756). It dropped `error`, and every dish then rendered
  // as its raw UUID on screen, on the printed sheet and in the workbook.
  const [namesError, setNamesError] = useState(null)
  // How many of the stored forecast's days had already passed when it was loaded (S756). The
  // forecast only runs when someone presses Recompute, so coming back eleven days later showed
  // "Next 7 Days" listing last week and an ingredient list for a week that was over.
  const [stale, setStale] = useState({ dropped: 0, total: 0 })
  // Ingredient demand for the horizon — loads after the day table, independently, so a slow
  // recipe walk never holds the forecast itself hostage, and its failure is its own message.
  // `stockError`/`stockPeriod` are the in-store half (S756, D21), which fails on its own too: a
  // shelf that could not be read leaves forecast use on screen and blanks only In store / To buy.
  // S800: the loaded pieces, not the finished list. The list is derived below from these and the
  // forecast scaled for rain, so the weather arriving after the reads re-works it instead of re-reading.
  const EMPTY_ING = { loading: false, error: null, exploded: {}, items: [], stock: null, stockError: null, suppliers: null, supplierError: null }
  const [ingredients, setIngredients] = useState(EMPTY_ING)
  const [showCovered, setShowCovered] = useState(false)

  // Covers exist only where POS does: manual Sales Entries carry none. Keyed on the viewed
  // client's real subscription, not the session's `posEnabled`, which is true for every admin
  // (the S693 Roster fix, applied here for the same reason).
  const hasPos = !!clientModules?.pos

  const loadIngredients = useCallback(async (list, reqKey) => {
    const totals = totalQtyByRecipe(list)
    const recipeIds = Object.keys(totals).filter(id => totals[id] > 0)
    if (recipeIds.length === 0) { setIngredients(EMPTY_ING); return }
    setIngredients(s => ({ ...s, loading: true, error: null }))
    try {
      // Same walk the Reorder Report uses for theoretical usage: leaf items only, sub-recipes
      // resolved through their yield, item yield_pct applied.
      const exploded = await explodeRecipeIngredients(supabase, recipeIds)
      const itemIds = Object.keys(aggregateIngredientDemand(totals, exploded))
      let items = []
      if (itemIds.length > 0) {
        const { data, error } = await fetchAllRowsChunked(itemIds, ids =>
          scopedFrom('items', 'id, name, uom, per_uom_rate, is_active, purchase_unit, conversion_factor, categories(name)').in('id', ids).order('id'))
        if (error) throw error
        items = data || []
      }
      if (!horizonReq.isCurrent(reqKey)) return

      // In store (S756, D21). Its own try: a failed stock read must not take forecast use with it,
      // and must not read as an empty shelf either — ingredientBuyList carries it as unknown.
      let stock = { onHandById: null, period: null, periods: [], countedIds: new Set(), parById: null }
      let stockError = null
      try {
        stock = await loadOnHand(scopedFrom, items)
      } catch (err) {
        stockError = err
      }
      // Usual suppliers (S800), likewise on their own: without them the list is one ungrouped table.
      let suppliers = null
      let supplierError = null
      try {
        let periods = stock.periods
        if (!periods?.length) {
          const { data, error } = await scopedFrom('monthly_periods', 'id, bs_year, bs_month')
          if (error) throw error
          periods = data || []
        }
        suppliers = await loadUsualSuppliers(scopedFrom, items.map(i => i.id), periods)
      } catch (err) {
        supplierError = err
      }
      if (!horizonReq.isCurrent(reqKey)) return
      setIngredients({ loading: false, error: null, exploded, items, stock, stockError, suppliers, supplierError })
    } catch (err) {
      if (!horizonReq.isCurrent(reqKey)) return
      setIngredients({ ...EMPTY_ING, error: err })
    }
  }, [scopedFrom, horizonReq]) // eslint-disable-line react-hooks/exhaustive-deps

  const loadStored = useCallback(async () => {
    if (!clientId) return
    const reqKey = `${clientId}:${horizon}`
    horizonReq.begin(reqKey)
    setLoading(true)
    setLoadError(null)
    setExpandedIdx(null)
    const results = await Promise.all([
      // Paged (S792 PLANNING-1): one row per day plus one per dish forecast that day, so a 30-day
      // run on a 40-dish menu is ~1,230 rows, and past 1,000 the later days lost their dishes and
      // "Ingredients to buy" under-read with no error. `id` is the unique tiebreak paging needs.
      fetchAllRows(() => scopedFrom('demand_forecast_daily')
        .eq('horizon_days', horizon)
        .order('bs_year').order('bs_month').order('bs_day').order('id')),
      scopedFrom('demand_forecast_run_log')
        .order('run_at', { ascending: false }).limit(1),
    ])
    if (!horizonReq.isCurrent(reqKey)) return
    // A failed read must not wear the "no forecast yet — click Recompute" empty state (S612).
    const failed = firstError(results)
    if (failed) { setLoadError(failed); setForecast([]); setLoading(false); return }
    const [{ data: rows }, { data: runs }] = results
    setLastRun(runs?.[0] || null)

    // Reshape stored rows (one covers-level row + N recipe-level rows per day) back into the
    // same per-day shape the recompute path already produces, so the table renders identically
    // whether its data came from a fresh run or a prior one.
    const byDay = {}
    for (const r of newestRunOnly(rows || [])) {
      const key = `${r.bs_year}:${r.bs_month}:${r.bs_day}`
      const day = byDay[key] = byDay[key] || {
        bs: { year: r.bs_year, month: r.bs_month, day: r.bs_day },
        forecastCovers: null, forecastRevenue: null, revenueEstimated: false, forecastQtyByRecipe: {}, holiday: null,
        sampleCount: null, posSampleCount: null,
      }
      if (r.recipe_id) day.forecastQtyByRecipe[r.recipe_id] = parseFloat(r.forecast_qty) || 0
      else {
        day.forecastCovers = r.forecast_covers; day.forecastRevenue = r.forecast_revenue; day.revenueEstimated = r.revenue_estimated
        day.holiday = r.holiday_name ? { name: r.holiday_name, multiplier: r.holiday_multiplier } : null
        day.sampleCount = r.sample_count ?? null; day.posSampleCount = r.pos_sample_count ?? null
      }
    }
    const all = Object.values(byDay).sort((a, b) => a.bs.year - b.bs.year || a.bs.month - b.bs.month || a.bs.day - b.bs.day)
    // Only today onward, today being NEPAL's date (S756). A forecast day that has passed is not a
    // forecast, and its dishes must not reach "Ingredients to buy" — those are for days to come.
    const today = nepalBs(new Date()) || getBsToday()
    const list = all.filter(d => bsKey(d.bs) >= bsKey(today))
    setStale({ dropped: all.length - list.length, total: all.length })
    setForecast(list)

    setNamesError(null)
    const recipeIds = [...new Set(list.flatMap(d => Object.keys(d.forecastQtyByRecipe)))]
    if (recipeIds.length > 0) {
      const { data: recs, error: recErr } = await fetchAllRowsChunked(recipeIds, ids => scopedFrom('recipes', 'id, name').in('id', ids).order('id'))
      if (!horizonReq.isCurrent(reqKey)) return
      if (recErr) { setNamesError(recErr); setRecipeNames({}) }
      else setRecipeNames(Object.fromEntries((recs || []).map(r => [r.id, r.name])))
    }
    setLoading(false)
    loadIngredients(list, reqKey)
  }, [clientId, horizon, scopedFrom, horizonReq, loadIngredients])

  useEffect(() => { loadStored() }, [loadStored])

  // Rainy days (S800, owner decision): the dashboard's own rule — the Growth weather feature, the
  // Owner's rain percentage, rain forecast within the next seven days (rainFactorForMonth). A day it
  // touches has its expected dishes scaled before the list is worked out.
  const weatherFeature = hasFeature('weather_forecast')
  const { weather, weatherByAd, own: weatherOwn } = useWeatherStrip({})
  const rainPct = weatherOwn ? rainPctValue(settings?.rain_sales_pct) : null
  const rainByMonth = useMemo(() => {
    if (!weatherFeature || !weatherByAd || rainPct == null || forecast.length === 0) return null
    const todayAd = weather?.today || formatAd(nepalCivilDate(Date.now()))
    const forecastAd = weather?.fetched_at ? formatAd(nepalCivilDate(weather.fetched_at)) : null
    const out = {}
    for (const d of forecast) {
      const key = `${d.bs.year}:${d.bs.month}`
      if (key in out) continue
      out[key] = rainFactorForMonth({ rainPct, weatherByAd, todayAd, forecastAd, bsYear: d.bs.year, bsMonth: d.bs.month, monthEndDay: daysInBsMonth(d.bs.year, d.bs.month) })
    }
    return out
  }, [weatherFeature, weatherByAd, rainPct, forecast, weather])
  const listForecast = useMemo(() => scaleForecastDays(forecast, d => rainByMonth?.[`${d.bs.year}:${d.bs.month}`]?.factorOf(d.bs.day) ?? 1), [forecast, rainByMonth])
  const rainDays = listForecast.filter(d => d.rainFactor)

  // The buying list, derived (S800): forecast use (rain applied) + the par to keep − in store,
  // rounded up to the pack it is bought in, grouped by the supplier it is usually bought from.
  const buy = useMemo(() => {
    const ing = ingredients
    const known = ing.stock?.onHandById != null
    const byItem = aggregateIngredientDemand(totalQtyByRecipe(listForecast), ing.exploded || {})
    const itemById = Object.fromEntries((ing.items || []).map(i => [i.id, i]))
    let unpriced = 0
    const rows = ingredientBuyList(byItem, ing.stock?.onHandById ?? null, ing.stock?.parById ?? null).map(b => {
      const item = itemById[b.id]
      const rate = parseFloat(item?.per_uom_rate) || 0
      if (!rate) unpriced += 1
      const pack = item && b.toBuy > 0 ? packsFor(b.toBuy, item) : null
      // What will actually arrive: whole packs where the item has a pack size, else the exact need.
      // Nobody orders 14.37 eggs or 1,057.8 g of honey: with no pack size the need is rounded up to a
      // whole base unit, so the Order column, the value and the purchase order all carry one figure.
      const buyQty = b.toBuy == null ? null : pack ? pack.packedQty : (b.toBuy > 0 ? Math.ceil(b.toBuy - 1e-9) : 0)
      const supplierId = ing.suppliers?.byItem?.[b.id] || null
      return {
        id: b.id, item, name: item?.name || 'Unknown item', uom: item?.uom || '', category: item?.categories?.name || 'Uncategorised',
        inactive: item ? item.is_active === false : false,
        qty: b.use, par: b.par, inStore: b.inStore, toBuy: b.toBuy, buyQty, pack,
        packLabel: item && b.toBuy > 0 ? packText(b.toBuy, item) : '',
        orderLabel: b.toBuy > 0 ? (item && packText(b.toBuy, item)) || `${fmtQty(Math.ceil(b.toBuy - 1e-9))} ${item?.uom || ''}`.trim() : '',
        counted: ing.stock?.countedIds?.has(b.id) || false,
        rate, value: known && rate && buyQty != null ? buyQty * rate : null,
        supplierId, supplierName: supplierId ? (ing.suppliers?.names?.[supplierId] || 'Supplier') : null,
      }
    }).sort((a, b) => (b.value ?? 0) - (a.value ?? 0) || (b.toBuy ?? b.qty) - (a.toBuy ?? a.qty) || a.name.localeCompare(b.name))
    // One group per usual supplier, biggest spend first; items with no supplier on record last.
    const groupMap = new Map()
    // Items the shelf already covers go in one group of their own at the end, so each supplier's
    // group holds only what to order from it. An unknown shelf keeps every row in its supplier group.
    const covered = rows.filter(r => r.toBuy === 0)
    for (const r of rows) {
      if (r.toBuy === 0) continue
      const key = r.supplierId || '__none__'
      const g = groupMap.get(key) || { key, supplierId: r.supplierId, name: r.supplierName || 'No supplier on record', rows: [], value: 0, active: !!r.supplierId && !!ing.suppliers?.active?.has(r.supplierId) }
      g.rows.push(r)
      g.value += r.value || 0
      groupMap.set(key, g)
    }
    const groups = [...groupMap.values()].sort((a, b) => (a.supplierId ? 0 : 1) - (b.supplierId ? 0 : 1) || b.value - a.value || a.name.localeCompare(b.name))
    return {
      rows, groups, covered, unpriced,
      totalValue: known ? rows.reduce((t, r) => t + (r.value || 0), 0) : null,
      stockError: ing.stockError, stockPeriod: ing.stock?.period || null,
      hasPars: rows.some(r => r.par > 0),
    }
  }, [ingredients, listForecast])

  // A purchase order per supplier (S800): Purchase Orders opens its New PO form pre-filled with this
  // supplier's lines — the quantity that will arrive and the Item Master rate — and the user reviews
  // and saves it there. Nothing is written from here.
  const canRaisePo = hasFeature('purchase_orders') && hasImsAccess('supervisor')
  function raisePo(group) {
    const lines = group.rows.filter(r => r.buyQty > 0 && r.item && r.item.is_active !== false)
      .map(r => ({ item_id: r.id, qty_ordered: Math.round(r.buyQty * 1000) / 1000, unit_price: r.rate || '' }))
    if (!group.supplierId || lines.length === 0) return
    navigate('/purchase-orders', { state: { poPrefill: { vendorId: group.supplierId, lines, note: `From the Demand Forecast buying list (${horizonLabel.toLowerCase()})` } } })
  }

  if (!hasImsAccess('supervisor')) return <Navigate to="/dashboard" replace />

  const horizonLabel = horizon === 7 ? 'Next 7 Days' : 'Next 30 Days'
  // A dish id with no name is never shown as a UUID (S756): unavailable when the read failed,
  // unnamed when it succeeded without it.
  const dishName = id => recipeNames[id] || (namesError ? 'Dish name unavailable' : 'Unnamed dish')
  const lastRunLabel = lastRun ? (nepalBsLong(lastRun.run_at) || new Date(lastRun.run_at).toLocaleString()) : null
  const stockPeriodLabel = buy.stockPeriod
    ? `${BS_MONTHS[buy.stockPeriod.bs_month - 1]} ${buy.stockPeriod.bs_year}${buy.stockPeriod.status === 'open' ? '' : ' (closed)'}`
    : null
  const inStoreKnown = !buy.stockError && !!buy.stockPeriod
  // What a printed or exported copy covers, in one line (the S594 scope rule).
  const scopeLine = forecast.length > 0
    ? `${horizonLabel} · ${bsLabel(forecast[0])} – ${bsLabel(forecast[forecast.length - 1])} (${forecast.length} day${forecast.length === 1 ? '' : 's'})`
      + (lastRunLabel ? ` · forecast run ${lastRunLabel}` : '')
      + (inStoreKnown ? ` · in store as at ${stockPeriodLabel}` : ' · in store not available')
    : horizonLabel
  // Print and Export carry the figures, the dish names and the letterhead, so they wait on all
  // three (the S728 rule: a control that emits a file is where a stale or partial render sticks).
  const emitBlocked = loading || !!loadError || forecast.length === 0 || ingredients.loading || !!biz.error || !!namesError

  function handlePrint() {
    printWithTitle(`${biz.name ? biz.name + ' - ' : ''}Demand Forecast - ${horizonLabel}`)
  }

  async function handleRecompute() {
    setRecomputing(true); setMsg('')
    try {
      await runForecast(clientId, horizon)
      setMsg('ok:Forecast rebuilt from your sales history.')
      await loadStored()
    } catch (err) {
      setMsg('error:' + errorText(err, 'operator') + ' The figures below are from the last forecast that ran, not a new one.')
    }
    setRecomputing(false)
  }

  async function handleExport() {
    const XLSX = await import('xlsx')
    const wb = XLSX.utils.book_new()
    // Letterhead + scope line on both sheets (S756) — a bare json_to_sheet named no client, no date
    // range and no run, so a mailed copy could not be matched to anything a week later.
    const ingRows = buy.groups.flatMap(g => g.rows.map(r => ({
      'Supplier': g.supplierId ? g.name : 'No supplier on record',
      'Item': r.name, 'Category': r.category, 'Unit': r.uom,
      [`Forecast use (${horizonLabel.toLowerCase()})`]: parseFloat(r.qty.toFixed(3)),
      'In store': r.inStore == null ? '' : parseFloat(r.inStore.toFixed(3)),
      'Keep on shelf (par)': r.par ? parseFloat(r.par.toFixed(3)) : '',
      'To buy': r.toBuy == null ? '' : parseFloat(r.toBuy.toFixed(3)),
      'Order': r.orderLabel,
      'Will arrive': r.buyQty == null ? '' : parseFloat(r.buyQty.toFixed(3)),
      'Unit Rate (NPR)': r.rate || '',
      'Value (NPR)': r.value == null ? '' : Math.round(r.value),
      'Status': r.inactive ? 'Inactive item' : '',
    })))
    const wsIng = sheetWithLetterhead(XLSX, {
      title: 'Demand Forecast — Ingredients to buy', biz, scopeLine, rows: ingRows,
      notes: [
        inStoreKnown
          ? `In store is the Stock Report on-hand figure for ${stockPeriodLabel}: the closing count where entered, otherwise opening + net purchases − usage − wastage − staff meals. To buy = forecast use + the par to keep − in store, never below zero; Will arrive rounds it up to whole packs, and the value is of what will arrive.`
          : 'In store could not be worked out, so In store, To buy and the value are blank — this sheet is forecast use only.',
        ...(rainDays.length ? [`Rain forecast lowered expected sales on ${rainDays.map(bsLabel).join(', ')} (× ${Math.round(rainDays[0].rainFactor * 100)}%, your rainy-day setting).`] : []),
      ],
    })
    wsIng['!cols'] = [22, 26, 16, 8, 18, 12, 14, 12, 24, 12, 14, 12, 14].map(w => ({ wch: w }))
    XLSX.utils.book_append_sheet(wb, wsIng, 'Ingredients')
    const dishRows = []
    for (const f of forecast) {
      const { plates, occasional } = splitDishList(Object.entries(f.forecastQtyByRecipe))
      for (const p of plates) dishRows.push({ 'Date (BS)': bsLabel(f), 'Day': WEEKDAYS[dayOf(f)], 'Dish': dishName(p.recipeId), 'Plates': p.plates, 'Average / day': parseFloat(p.qty.toFixed(2)), 'Occasional': '' })
      for (const o of occasional) dishRows.push({ 'Date (BS)': bsLabel(f), 'Day': WEEKDAYS[dayOf(f)], 'Dish': dishName(o.recipeId), 'Plates': '', 'Average / day': parseFloat(o.qty.toFixed(2)), 'Occasional': 'yes' })
    }
    const wsDish = sheetWithLetterhead(XLSX, { title: 'Demand Forecast — Dishes by day', biz, scopeLine, rows: dishRows })
    wsDish['!cols'] = [16, 6, 30, 8, 14, 10].map(w => ({ wch: w }))
    XLSX.utils.book_append_sheet(wb, wsDish, 'Dishes by Day')
    XLSX.writeFile(wb, `Demand_Forecast_${horizon}d.xlsx`)
  }

  const coversHeader = hasPos
    ? <Tip text="Average covers on this weekday, from closed POS bills. Scaled by the holiday multiplier where one is set." width={260}>Forecast Covers</Tip>
    : null

  return (
    <div>
      <SuiteGate featureKey="demand_forecast" featureLabel="Demand Forecast" requireModules={['ims']}>
      <style>{`
        @media print {
          @page { margin: 14mm 12mm; }
        }
      `}</style>

      {/* Print-only letterhead — replaces the app-navigation header/subtitle on the printed sheet */}
      <div className="print-only" style={{ marginBottom: 16 }}>
        <div style={{ fontWeight: 700, fontSize: 16 }}>{biz.name}</div>
        {biz.address && <div style={{ fontSize: 12 }}>{biz.address}</div>}
        <div style={{ fontWeight: 700, fontSize: 14, marginTop: 8 }}>Demand Forecast — {horizonLabel}</div>
        <div style={{ fontSize: 11 }}>{scopeLine}</div>
        <div style={{ fontSize: 11 }}>Generated: {new Date().toLocaleString()}</div>
      </div>

      <div className="page-header no-print">
        <h1 className="page-title">
          Demand Forecast <Tip text="Predicts per-dish plates, revenue and (with POS) covers for the days ahead, from the last 8 same-weekday days in your sales history, weighted so recent weeks count more. A simple, auditable model — not a trained AI — so you can see exactly why a number was predicted. Below the days, the same forecast is exploded into the raw ingredients it will consume." width={340}>ⓘ</Tip>
        </h1>
        <p className="page-subtitle">
          What each day ahead will sell, and what to buy for it — for prep and purchasing.
        </p>
      </div>

      <div className="no-print" style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center', marginBottom: 12 }}>
        {/* Off while recomputing (S756): handleRecompute runs the horizon it started with and
            then reloads through the NEW horizon's loader, so a switch mid-run showed the other
            horizon's stored rows under a "Forecast rebuilt" message about this one. */}
        <FilterChips
          label="Forecast horizon"
          options={[
            { key: 7, label: 'Next 7 Days', disabled: recomputing },
            { key: 30, label: 'Next 30 Days', disabled: recomputing },
          ]}
          active={horizon}
          onChange={setHorizon}
        />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Tip text="Rebuilds the forecast from your latest sales data. Run this whenever you want an up-to-date prediction — it does not run automatically.">
            <button className="btn btn-primary" onClick={handleRecompute} disabled={recomputing}>
              {recomputing ? 'Recomputing…' : '↻ Recompute Forecast'}
            </button>
          </Tip>
          <button className="btn btn-ghost" onClick={handleExport} disabled={emitBlocked || !!ingredients.error}>📊 Export Excel</button>
          <button className="btn btn-ghost" onClick={handlePrint} disabled={emitBlocked}>🖨 Print</button>
        </div>
        {lastRun && (
          <span style={{ fontSize: 11, color: 'var(--theme-text3)', marginLeft: 'auto' }}>
            Last run: {new Date(lastRun.run_at).toLocaleString()}
            {lastRun.error ? <span style={{ color: 'var(--theme-red-text)' }}> — failed: {lastRun.error}</span> : ` (${lastRun.rows_written} rows)`}
          </span>
        )}
      </div>

      <p className="no-print" style={{ fontSize: 12, color: 'var(--theme-text3)', margin: '0 0 20px' }}>
        {horizon === 30
          ? 'Days 8–30 repeat the weekly pattern learned from the last 8 weeks; only holiday multipliers differ between one Wednesday and the next. '
          : ''}
        {!hasPos && 'Covers are counted from POS bills. This outlet has no Crest POS, so the forecast is dishes and revenue only, with revenue priced at the current menu rather than measured.'}
      </p>

      {msg && <p className="no-print" style={{ color: msg.startsWith('error:') ? 'var(--theme-red-text)' : 'var(--theme-green-text)', fontSize: 13, marginBottom: 12 }}>{msg.replace(/^(error|ok):/, '')}</p>}

      {biz.error && (
        <p role="alert" className="no-print" style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--theme-amber-text)' }}>
          This outlet's name could not be loaded, so Print and Excel are switched off rather than producing a sheet
          with a blank letterhead. The forecast below is unaffected. Reload the page to try again.
        </p>
      )}
      {!loading && !loadError && namesError && (
        <p role="alert" className="no-print" style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--theme-amber-text)' }}>
          The dish names could not be loaded, so dishes below read "Dish name unavailable" and Print and Excel are
          switched off. The quantities are unaffected. Reload the page to try again.
        </p>
      )}
      {/* The stored forecast is older than the days it covers (S756). Nothing re-runs it on its own,
          so say how much of it has gone by and what that does to the ingredient list. */}
      {!loading && !loadError && stale.dropped > 0 && forecast.length > 0 && (
        <p role="alert" className="no-print" style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--theme-amber-text)' }}>
          △ This forecast was last run{lastRunLabel ? ` on ${lastRunLabel}` : ''}, and {stale.dropped} of its {stale.total} days
          have already passed. Only the {forecast.length} day{forecast.length === 1 ? '' : 's'} from today {forecast.length === 1 ? 'is' : 'are'} shown,
          and Ingredients to buy covers only {forecast.length === 1 ? 'that day' : 'those'}. Click Recompute Forecast for a full {horizonLabel.toLowerCase()}.
        </p>
      )}

      {loading ? (
        <div className="card"><p style={{ color: 'var(--theme-text2)', fontSize: 13, margin: 0 }}>Loading…</p></div>
      ) : loadError ? (
        <ReportLoadError error={loadError} />
      ) : forecast.length === 0 ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text3)', fontSize: 13 }}>
          {stale.dropped > 0
            ? `Every day in the last forecast for this horizon has already passed${lastRunLabel ? ` — it was run on ${lastRunLabel}` : ''}. Click "Recompute Forecast" to forecast the days ahead.`
            : 'No forecast yet for this horizon — click "Recompute Forecast" to generate one.'}
        </div>
      ) : (
        <>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Date (BS)</th><th>Day</th>
                {hasPos && <th style={{ textAlign: 'right' }}>{coversHeader}</th>}
                <th style={{ textAlign: 'right' }}><Tip text="Before VAT — the same Revenue figure Owner Dashboard and Sales Entries use, so it can be compared with them and with the Labor Forecast's cost %." width={260}>Forecast Revenue</Tip></th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {forecast.map((f, idx) => {
                const weekday = dayOf(f)
                const { plates, occasional } = splitDishList(Object.entries(f.forecastQtyByRecipe))
                const showingAll = expandedIdx === idx
                const visiblePlates = showingAll ? plates : plates.slice(0, PREVIEW_COUNT)
                const hiddenPlates = plates.length - visiblePlates.length
                const evidence = evidenceText(f)
                const nameOf = dishName
                const avgTip = qty => `${qty.toFixed(1)} a day on average${evidence ? ', ' + evidence : ''}, recent weeks weighted more`
                const colSpan = hasPos ? 5 : 4
                return (
                  <Fragment key={idx}>
                    <tr>
                      <td style={{ fontWeight: 600, color: 'var(--theme-text1)', whiteSpace: 'nowrap' }}>{bsLabel(f)}</td>
                      <td>
                        {WEEKDAYS[weekday]}
                        {evidence && <div style={{ fontSize: 10, color: 'var(--theme-text3)', whiteSpace: 'nowrap' }}>{evidence}</div>}
                      </td>
                      {hasPos && (
                        <td style={{ textAlign: 'right' }}>
                          {f.forecastCovers != null ? Math.round(f.forecastCovers)
                            : <Tip text="No closed POS bills on this weekday in the last 12 weeks — the dishes came from manual Sales Entries, which carry no covers.">—</Tip>}
                        </td>
                      )}
                      <td style={{ textAlign: 'right', fontWeight: 700 }}>
                        {f.revenueEstimated
                          ? <Tip text="Estimated: forecast dishes × current menu price, before VAT. This weekday's history has no POS bills to measure revenue from, so it is priced rather than measured." width={260}>≈ {fmtNpr(f.forecastRevenue)}</Tip>
                          : fmtNpr(f.forecastRevenue)}
                      </td>
                      <td>{f.holiday && (
                        f.holiday.multiplier != null
                          ? <Tip text={`Adjusted ×${f.holiday.multiplier} for ${f.holiday.name} — set in Holiday Calendar. Covers, revenue, and item quantities above already reflect this.`}><span className="badge badge-gray">{f.holiday.name} ×{f.holiday.multiplier}</span></Tip>
                          : <Tip text={`No demand multiplier set for ${f.holiday.name} in Holiday Calendar — this forecast is NOT adjusted for it. Treat it as a floor, not a ceiling, on a festival day.`}><span className="badge badge-amber">⚠ {f.holiday.name}</span></Tip>
                      )}</td>
                    </tr>
                    {(plates.length > 0 || occasional.length > 0) && (
                      <tr>
                        <td colSpan={colSpan} style={{ padding: '2px 12px 10px', borderTop: 'none' }}>
                          {/* Whole plates to prep. The raw average sits on hover — 0.8 was being read as a
                              portion size, and nobody makes 0.8 of a toast (S694). */}
                          <div className="no-print" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, fontSize: 11, color: 'var(--theme-text3)', alignItems: 'baseline' }}>
                            {visiblePlates.map(p => (
                              <Tip key={p.recipeId} text={avgTip(p.qty)} width={240}>
                                <span>{nameOf(p.recipeId)}: <strong style={{ color: 'var(--theme-text2)' }}>{p.plates}</strong></span>
                              </Tip>
                            ))}
                            {!showingAll && (hiddenPlates > 0 || occasional.length > 0) && (
                              <button type="button" className="btn-linklike" onClick={() => setExpandedIdx(idx)}>
                                {hiddenPlates > 0 ? `+${hiddenPlates} more dish${hiddenPlates === 1 ? '' : 'es'}` : ''}
                                {hiddenPlates > 0 && occasional.length > 0 ? ' · ' : ''}
                                {occasional.length > 0 ? `${occasional.length} occasional` : ''}
                              </button>
                            )}
                            {showingAll && (
                              <button type="button" className="btn-linklike" onClick={() => setExpandedIdx(null)}>show less</button>
                            )}
                          </div>
                          {showingAll && occasional.length > 0 && (
                            <div className="no-print" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, fontSize: 11, color: 'var(--theme-text3)', marginTop: 6, alignItems: 'baseline' }}>
                              <Tip text={`Sold on fewer than one ${WEEKDAYS_FULL[weekday]} in two — under ${OCCASIONAL_THRESHOLD} a day on average. Worth having the ingredients for, not worth prepping a plate of.`} width={260}>
                                <span style={{ fontStyle: 'italic' }}>Occasional:</span>
                              </Tip>
                              {occasional.map(o => (
                                <Tip key={o.recipeId} text={avgTip(o.qty)} width={240}>
                                  <span>{nameOf(o.recipeId)} <span style={{ opacity: 0.8 }}>({o.qty.toFixed(1)}/day)</span></span>
                                </Tip>
                              ))}
                            </div>
                          )}
                          {/* Print always shows the complete list regardless of on-screen expand state —
                              a printed sheet is a static snapshot, not an interactive session. */}
                          {/* Global .print-only forces display:block!important on print, so flex-gap
                              won't apply here — spans get their own right-margin as a fallback. */}
                          <div className="print-only" style={{ fontSize: 11 }}>
                            {plates.map(p => (
                              <span key={p.recipeId} style={{ marginRight: 14 }}>{nameOf(p.recipeId)}: <strong>{p.plates}</strong> <span style={{ opacity: 0.7 }}>({p.qty.toFixed(1)})</span></span>
                            ))}
                            {occasional.length > 0 && (
                              <div style={{ marginTop: 4 }}>
                                <em>Occasional:</em>{' '}
                                {occasional.map(o => (
                                  <span key={o.recipeId} style={{ marginRight: 14 }}>{nameOf(o.recipeId)} ({o.qty.toFixed(1)})</span>
                                ))}
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>

        <div style={{ marginTop: 32 }}>
          <h2 style={{ margin: '0 0 2px', fontSize: 18, color: 'var(--theme-text1)' }}>
            Ingredients to buy — {horizonLabel.toLowerCase()}{' '}
            <Tip text="Every dish above, multiplied through its recipe (and any sub-recipes, adjusted for yield) at the per-portion quantities in Recipe Costing, then summed per raw item for the days shown. In store is the same on-hand figure Stock Report and Reorder Report show; Keep is the item's par level from the Reorder Report, the minimum you want left on the shelf; To buy covers the forecast and keeps that par." width={340}>ⓘ</Tip>
          </h2>
          <p style={{ fontSize: 12, color: 'var(--theme-text3)', margin: '0 0 12px' }}>
            In each item's base unit. To buy = forecast use + the par to keep − in store, never below zero, rounded up to whole packs where the item has a pack size, and grouped by the supplier you last bought it from. The value is of what will arrive, at the Item Master rate. Occasional dishes are included at their average, so a rarely-sold dish still puts a little of its ingredients on the list.
            {!ingredients.loading && !ingredients.error && inStoreKnown && ` In store is as at ${stockPeriodLabel}.`}
          </p>
          {rainDays.length > 0 && (
            <p className="note-banner" role="status" style={{ margin: '0 0 12px', fontSize: 12 }}>
              <strong>Rain lowered the list.</strong> Rain is forecast on {rainDays.map(d => `${WEEKDAYS[dayOf(d)]} ${d.bs.day} ${BS_MONTHS[d.bs.month - 1]}`).join(', ')}, so expected sales on {rainDays.length === 1 ? 'that day are' : 'those days are'} taken at {Math.round(rainDays[0].rainFactor * 100)}% — your rainy-day setting. The dish table above still shows the usual numbers.
            </p>
          )}
          {!ingredients.loading && !ingredients.error && buy.rows.length > 0 && !inStoreKnown && (
            <p role="alert" style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--theme-amber-text)' }}>
              {buy.stockError
                ? 'What is in store could not be read, so In store and To buy are blank rather than assuming the shelf is empty. Forecast use below is unaffected. Reload the page to try again.'
                : 'There is no stock period yet, so what is in store cannot be worked out — In store and To buy are blank. Forecast use below is unaffected.'}
            </p>
          )}
          {!ingredients.loading && !ingredients.error && ingredients.supplierError && (
            <p role="status" style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--theme-text2)' }}>
              Who you usually buy each item from could not be read, so the list is not grouped by supplier and no purchase order can be started from it. The quantities are unaffected. Reload the page to try again.
            </p>
          )}
          {ingredients.loading ? (
            <div className="card"><p style={{ color: 'var(--theme-text2)', fontSize: 13, margin: 0 }}>Working out ingredients…</p></div>
          ) : ingredients.error ? (
            <ReportLoadError error={ingredients.error} />
          ) : buy.rows.length === 0 ? (
            <div className="card" style={{ padding: 24, textAlign: 'center', color: 'var(--theme-text3)', fontSize: 13 }}>
              None of the forecast dishes has ingredients in Recipe Costing yet, so there is nothing to explode.
            </div>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Item</th><th>Category</th>
                    <th style={{ textAlign: 'right' }}><Tip text={`Total the forecast will use over the ${forecast.length} day${forecast.length === 1 ? '' : 's'} shown, in the item's base unit${rainDays.length ? ', lowered on the rainy days named above' : ''}.`}>Forecast use</Tip></th>
                    <th style={{ textAlign: 'right' }}><Tip text={`What is on the shelf now — the same figure as Stock Report's On-hand${stockPeriodLabel ? ` for ${stockPeriodLabel}` : ''}: the closing count where one is entered, otherwise opening + net purchases − usage − wastage − staff meals. A dash means it could not be worked out.`} width={300}>In store</Tip></th>
                    <th style={{ textAlign: 'right' }}><Tip text="The item's par level — the least you want left on the shelf — set on the Reorder Report. The list buys enough to keep it. A dash means no par is set." width={260}>Keep</Tip></th>
                    <th style={{ textAlign: 'right' }}><Tip text="Forecast use + Keep − In store, never below zero. Zero means what is on the shelf already covers the forecast and the par." width={240}>To buy</Tip></th>
                    <th><Tip text="What to order: whole packs where Item Master has a pack size (for example a 25 kg sack), otherwise To buy rounded up to a whole unit. This is what a purchase order started from here asks for, and what the value is worked out on." width={280}>Order</Tip></th>
                    <th>Unit</th>
                    <th style={{ textAlign: 'right' }}><Tip text="What will arrive (the whole packs, or To buy where there is no pack size) × the item's current per-unit rate from Item Master. A dash means the item has no rate yet, or what is in store is unknown." width={280}>≈ Value</Tip></th>
                  </tr>
                </thead>
                <tbody>
                  {buy.groups.map(g => (
                    <Fragment key={g.key}>
                      <tr className="row-tinted">
                        <td colSpan={8} style={{ fontWeight: 700, color: 'var(--theme-text1)' }}>
                          {g.supplierId ? g.name : (ingredients.supplierError ? 'All items' : 'No supplier on record')}
                          {!g.supplierId && !ingredients.supplierError && (
                            <span style={{ fontWeight: 400, color: 'var(--theme-text3)', fontSize: 12 }}> · never bought with a supplier named in the last {SUPPLIER_LOOKBACK} months</span>
                          )}
                          {canRaisePo && g.supplierId && g.active && g.rows.some(r => r.buyQty > 0) && (
                            <Tip text={`Opens a new purchase order for ${g.name} with these items and quantities filled in. You check it and save it on Purchase Orders — nothing is ordered from here.`} width={280}>
                              <button type="button" className="btn btn-ghost btn-sm no-print" style={{ marginLeft: 12 }} onClick={() => raisePo(g)}>
                                Create purchase order
                              </button>
                            </Tip>
                          )}
                          {canRaisePo && g.supplierId && !g.active && (
                            <span style={{ fontWeight: 400, color: 'var(--theme-text3)', fontSize: 12 }}> · this supplier is hidden in Vendors, so no purchase order can be started for it</span>
                          )}
                        </td>
                        <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-text1)' }}>{g.value ? npr(g.value) : '—'}</td>
                      </tr>
                      {g.rows.map(r => (
                        <tr key={r.id}>
                          <td style={{ color: 'var(--theme-text1)' }}>
                            <span style={{ whiteSpace: 'nowrap' }}>{r.name}</span>
                            {r.inactive && <Tip text="This item is inactive in Item Master but a forecast dish still uses it — reactivate it or update the recipe."><span className="badge badge-amber" style={{ marginLeft: 6 }}>inactive</span></Tip>}
                          </td>
                          <td style={{ color: 'var(--theme-text2)' }}>{r.category}</td>
                          <td style={{ textAlign: 'right' }}>{fmtQty(r.qty)}</td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>{fmtQty(r.inStore)}</td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>{r.par > 0 ? fmtQty(r.par) : '—'}</td>
                          <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmtQty(r.toBuy)}</td>
                          <td style={{ color: 'var(--theme-text1)', whiteSpace: 'nowrap' }}>{r.orderLabel || '—'}</td>
                          <td style={{ color: 'var(--theme-text2)' }}>{r.uom}</td>
                          <td style={{ textAlign: 'right' }}>{r.value != null ? npr(r.value) : '—'}</td>
                        </tr>
                      ))}
                    </Fragment>
                  ))}
                  {buy.covered.length > 0 && (
                    <>
                      <tr className="row-tinted">
                        <td colSpan={9} style={{ color: 'var(--theme-text1)' }}>
                          <strong>Already covered by what is in store</strong>
                          <span style={{ color: 'var(--theme-text3)', fontSize: 12 }}> · {buy.covered.length} item{buy.covered.length === 1 ? '' : 's'}, nothing to buy</span>
                          <button type="button" className="btn btn-ghost btn-sm no-print" style={{ marginLeft: 12 }}
                            aria-expanded={showCovered} onClick={() => setShowCovered(v => !v)}>
                            {showCovered ? 'Hide' : 'Show'}
                          </button>
                        </td>
                      </tr>
                      {showCovered && buy.covered.map(r => (
                        <tr key={r.id}>
                          <td style={{ color: 'var(--theme-text1)' }}><span style={{ whiteSpace: 'nowrap' }}>{r.name}</span></td>
                          <td style={{ color: 'var(--theme-text2)' }}>{r.category}</td>
                          <td style={{ textAlign: 'right' }}>{fmtQty(r.qty)}</td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>{fmtQty(r.inStore)}</td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>{r.par > 0 ? fmtQty(r.par) : '—'}</td>
                          <td style={{ textAlign: 'right' }}>0</td>
                          <td style={{ color: 'var(--theme-text2)' }}>—</td>
                          <td style={{ color: 'var(--theme-text2)' }}>{r.uom}</td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>—</td>
                        </tr>
                      ))}
                    </>
                  )}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={8} style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>
                      {buy.rows.length - buy.covered.length} item{buy.rows.length - buy.covered.length === 1 ? '' : 's'} to buy
                      {buy.covered.length > 0 && <span style={{ fontWeight: 400, color: 'var(--theme-text3)' }}> · {buy.covered.length} already covered</span>}
                      {buy.unpriced > 0 && <span style={{ fontWeight: 400, color: 'var(--theme-text3)' }}> · {buy.unpriced} without a rate, not in the total</span>}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-text1)' }}>{buy.totalValue != null ? npr(buy.totalValue) : '—'}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
        </>
      )}
      </SuiteGate>
    </div>
  )
}
