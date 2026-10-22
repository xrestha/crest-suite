import { nprOrDash, npr } from '../../../shared/nepalMoney'
import { useState, useEffect, useCallback, useMemo, Fragment } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'
import { supabase } from '../../../supabaseClient'
import { firstError } from '../../../shared/queryError'
import { fetchAllRowsParallel } from '../../../shared/fetchAllRows'
import { usePeriodList } from '../../../shared/hooks/usePeriodList'
import { useBizInfo } from '../../../shared/hooks/useBizInfo'
import { sheetWithLetterhead } from '../../../shared/excelLetterhead'
import { nepalBs, nepalBsLong, nepalCivilDate, nepalTime } from '../../../shared/nepalTime'
import Tip from '../../../components/Tip'
import ReportLoadError from '../../../components/ReportLoadError'
import { BS_MONTHS, bsToAd, getBsToday, formatAd, daysInBsMonth } from '../../../utils/bsCalendar'
import { runForecast } from '../../../utils/demandForecastData'
import { splitDishList, totalQtyByRecipe, aggregateIngredientDemand, ingredientBuyList, scaleForecastDays, addDemand, SAMPLES_PER_WEEKDAY, OCCASIONAL_THRESHOLD } from '../../../utils/demandForecastMath'
import { packsFor, packText } from './reorderPacks'
import { useSettings } from '../../../context/SettingsContext'
import { useWeatherStrip } from '../../dashboard/useWeatherStrip'
import { rainFactorForMonth, rainPctValue, isRainyDay } from '../../dashboard/weatherEffect'
import { readPeriodTransfers } from '../transfers/transferFlows'
import { loadRecipeBook } from '../../../utils/recipeCost'
import { startBuyingListReads, loadBuyingList, countUndatedRows, SUPPLIER_LOOKBACK } from './demandForecastLoad'
import { printWithTitle } from '../../../utils/printTitle'
import { errorText, isNetworkError } from '../../../shared/errorText'
import { withTimeout, settleWithin, isTimeout } from '../../../utils/withTimeout'
import SuiteGate, { SUITE_PAGES } from '../../../components/SuiteGate'
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

// "18 Bhadra 2083, 9:14 AM": every time on this page, by Nepal's calendar and clock (S849, FORECAST-8).
function whenText(ts) {
  const d = nepalBsLong(ts)
  const t = nepalTime(ts)
  return d && t ? `${d}, ${t}` : (d || t || '')
}

// What stood behind a day's numbers — shown under the weekday and on every dish's hover, so a
// forecast averaged over one week and one over eight no longer look identical (S694).
// `undated` (S849): Bulk monthly rows in the window — the reason a weekday can have no samples.
function evidenceText(f, { undated = 0 } = {}) {
  const weekday = WEEKDAYS_FULL[dayOf(f)]
  if (f.sampleCount == null) return null // written before sample_count existed — say nothing rather than guess
  if (f.sampleCount === 0) {
    return undated > 0
      ? `no dated sales on ${weekday}s in the last 12 weeks — monthly Bulk totals carry no day`
      : `no ${weekday}s in the last 12 weeks had sales`
  }
  return `from the last ${f.sampleCount} ${weekday}${f.sampleCount === 1 ? '' : 's'}${f.sampleCount >= SAMPLES_PER_WEEKDAY ? '' : ' with sales'}`
}

// The page behind its two gates (S849, ACCESS's Suite-page pattern, the render-prop form). The body
// below holds every read and the weather hook, and SuiteGate calls it only once the page is open,
// so nothing is read behind the upsell card (it used to load the whole forecast, the buying list's
// stock reads and the weather there). The rank check stays here, before anything mounts.
export default function DemandForecast() {
  const { hasImsAccess } = useAuth()
  if (!hasImsAccess('supervisor')) return <Navigate to="/dashboard" replace />
  return (
    <SuiteGate page={SUITE_PAGES.demandForecast}>
      {() => <DemandForecastBody />}
    </SuiteGate>
  )
}

function DemandForecastBody() {
  const { clientId, hasImsAccess, clientModules, hasFeature, customizationEnabled } = useAuth()
  const { settings } = useSettings()
  const navigate = useNavigate()
  const { scopedFrom } = useScopedDb()
  const horizonReq = useLatestRequest()
  const periodList = usePeriodList()
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
  // read printed and exported a nameless sheet. Print/Export wait on useBizInfo's `ready`.
  const biz = useBizInfo()
  // The recipe-name read's own error slot (S756). It dropped `error`, and every dish then rendered
  // as its raw UUID on screen, on the printed sheet and in the workbook.
  const [namesError, setNamesError] = useState(null)
  // How many of the stored forecast's days had already passed when it was loaded (S756). The
  // forecast only runs when someone presses Recompute, so coming back eleven days later showed
  // "Next 7 Days" listing last week and an ingredient list for a week that was over.
  const [stale, setStale] = useState({ dropped: 0, total: 0 })
  // When the shown run was made (S849, FORECAST-8): its own newest generated_at, the server's
  // clock. The stale banner, the all-passed state and the print/Excel scope line say this, not the
  // run log, whose newest row may be a refused or failed run of the same horizon.
  const [runAt, setRunAt] = useState(null)
  // Bulk monthly Sales Entries in the run's window (FORECAST-10c); null = not counted.
  const [undatedRows, setUndatedRows] = useState(null)
  // Ingredient demand for the horizon — loads after the day table, independently, so a slow
  // recipe walk never holds the forecast itself hostage, and its failure is its own message.
  // `stockError`/`stockPeriod` are the in-store half (S756, D21), which fails on its own too: a
  // shelf that could not be read leaves forecast use on screen and blanks only In store / To buy.
  // S800: the loaded pieces, not the finished list. The list is derived below from these and the
  // forecast scaled for rain, so the weather arriving after the reads re-works it instead of re-reading.
  // S849: `choicePerPlate` is the guests' usual choices per plate (FORECAST-3), with its own error
  // slot, so a failed choice read leaves the recipe half of the list standing.
  const EMPTY_ING = { loading: false, error: null, exploded: {}, choicePerPlate: {}, choiceError: null, items: [], stock: null, stockError: null, suppliers: null, supplierError: null }
  const [ingredients, setIngredients] = useState(EMPTY_ING)
  const [showCovered, setShowCovered] = useState(false)

  // Covers exist only where POS does: manual Sales Entries carry none. Keyed on the viewed
  // client's real subscription, not the session's `posEnabled`, which is true for every admin
  // (the S693 Roster fix, applied here for the same reason).
  const hasPos = !!clientModules?.pos

  // `reads` are the buying list's reads loadStored started beside the forecast (S859,
  // demandForecastLoad.js): the walks run over the recipe book in memory, and nothing here sends a
  // request that waits on another. The halves keep their own error slots, as before.
  const loadIngredients = useCallback(async (list, reqKey, { reads, runAt: madeAt }) => {
    const totals = totalQtyByRecipe(list)
    const recipeIds = Object.keys(totals).filter(id => totals[id] > 0)
    if (recipeIds.length === 0) { setIngredients(EMPTY_ING); return }
    setIngredients(s => ({ ...s, loading: true, error: null }))
    try {
      const loaded = await loadBuyingList({ supabase, reads, totals, recipeIds, runAt: madeAt, customization: customizationEnabled })
      if (!horizonReq.isCurrent(reqKey)) return
      setIngredients({ loading: false, error: null, ...loaded })
    } catch (err) {
      if (!horizonReq.isCurrent(reqKey)) return
      setIngredients({ ...EMPTY_ING, error: err })
    }
  }, [horizonReq, customizationEnabled]) // eslint-disable-line react-hooks/exhaustive-deps

  const loadStored = useCallback(async () => {
    if (!clientId) return
    const reqKey = `${clientId}:${horizon}`
    horizonReq.begin(reqKey)
    setLoading(true)
    setLoadError(null)
    setExpandedIdx(null)
    // Everything the page reads starts here, beside the forecast (S859). It was 13 serial round trips
    // on Fast 3G (14-24 s): the dish names after the forecast, the month list three times, and the
    // buying list as a chain whose recipe walks cost one round trip per sub-recipe level.
    //   - The client's months come from the shared list (S855, periodList.js), read once for the
    //     in-store month, the suppliers, the guests' choices and the Bulk-row count. Never part of
    //     the forecast's own error: each of those fails on its own.
    //   - The recipe book (one request) feeds the dish names and both recipe walks, in memory. Read
    //     on every load rather than once a visit, so a Recompute or a horizon switch sees the recipes
    //     as they are now, as the per-level reads did; it costs no round trip, being beside the forecast.
    //   - The buying list's other reads start too (startBuyingListReads); none waits on another.
    const periodsP = settleWithin(periodList().fresh, 20000, 'Loading the months')
    const bookP = settleWithin(loadRecipeBook(scopedFrom).then(book => ({ data: book, error: null }), error => ({ data: null, error })), 30000, 'Loading the recipes')
    const reads = startBuyingListReads({ supabase, scopedFrom, periodsP, bookP, readTransfers: readPeriodTransfers })
    // The dish names keep their own bound and their own error slot (S756), now as a wait on the book.
    const namesP = settleWithin(bookP, 20000, 'Loading the dish names')
    // Bounded (S849, FORECAST-10a): a hung read becomes the read's own error, so the page shows
    // ReportLoadError instead of "Loading…" for ever.
    const results = await Promise.all([
      // Paged (S792 PLANNING-1): one row per day plus one per dish forecast that day, so a 30-day
      // run on a 40-dish menu is ~1,230 rows, and past 1,000 the later days lost their dishes and
      // "Ingredients to buy" under-read with no error. `id` is the unique tiebreak paging needs.
      // The pages after the first are asked for together (S859).
      settleWithin(fetchAllRowsParallel(opts => scopedFrom('demand_forecast_daily', '*', opts)
        .eq('horizon_days', horizon)
        .order('bs_year').order('bs_month').order('bs_day').order('id')), 20000, 'Loading the forecast'),
      // This horizon's own last run (FORECAST-8): a 30-day Recompute is not the 7-day forecast's
      // news. Rows written before S849 carry no horizon and are simply not shown.
      settleWithin(scopedFrom('demand_forecast_run_log')
        .eq('horizon_days', horizon)
        .order('run_at', { ascending: false }).limit(1), 20000, 'Loading the forecast'),
    ])
    if (!horizonReq.isCurrent(reqKey)) return
    // A failed read must not wear the "no forecast yet — click Recompute" empty state (S612).
    const failed = firstError(results)
    if (failed) { setLoadError(failed); setForecast([]); setRunAt(null); setLoading(false); return }
    const [{ data: rows }, { data: runs }] = results
    setLastRun(runs?.[0] || null)

    // Reshape stored rows (one covers-level row + N recipe-level rows per day) back into the
    // same per-day shape the recompute path already produces, so the table renders identically
    // whether its data came from a fresh run or a prior one.
    const byDay = {}
    const shown = newestRunOnly(rows || [])
    const madeAt = shown.reduce((a, r) => (!a || new Date(r.generated_at) > new Date(a) ? r.generated_at : a), null)
    for (const r of shown) {
      const key = `${r.bs_year}:${r.bs_month}:${r.bs_day}`
      const day = byDay[key] = byDay[key] || {
        bs: { year: r.bs_year, month: r.bs_month, day: r.bs_day },
        forecastCovers: null, forecastRevenue: null, revenueEstimated: false, forecastQtyByRecipe: {}, holiday: null,
        sampleCount: null, posSampleCount: null, sampleRainFactor: null, rainySampleCount: null,
      }
      if (r.recipe_id) day.forecastQtyByRecipe[r.recipe_id] = parseFloat(r.forecast_qty) || 0
      else {
        day.forecastCovers = r.forecast_covers; day.forecastRevenue = r.forecast_revenue; day.revenueEstimated = r.revenue_estimated
        day.holiday = r.holiday_name ? { name: r.holiday_name, multiplier: r.holiday_multiplier } : null
        day.sampleCount = r.sample_count ?? null; day.posSampleCount = r.pos_sample_count ?? null
        // How rainy the days it learned from were (FORECAST-4); null on a run with no rain setting
        // or no weather, and on every row written before S849.
        day.sampleRainFactor = r.sample_rain_factor != null ? Number(r.sample_rain_factor) : null
        day.rainySampleCount = r.rainy_sample_count ?? null
      }
    }
    const all = Object.values(byDay).sort((a, b) => a.bs.year - b.bs.year || a.bs.month - b.bs.month || a.bs.day - b.bs.day)
    // Only today onward, today being NEPAL's date (S756). A forecast day that has passed is not a
    // forecast, and its dishes must not reach "Ingredients to buy" — those are for days to come.
    const today = nepalBs(new Date()) || getBsToday()
    const list = all.filter(d => bsKey(d.bs) >= bsKey(today))
    setStale({ dropped: all.length - list.length, total: all.length })
    setRunAt(madeAt)
    setForecast(list)
    setUndatedRows(null)

    setNamesError(null)
    const recipeIds = [...new Set(list.flatMap(d => Object.keys(d.forecastQtyByRecipe)))]
    if (recipeIds.length > 0) {
      const { data: book, error: recErr } = await namesP
      if (!horizonReq.isCurrent(reqKey)) return
      if (recErr) { setNamesError(recErr); setRecipeNames({}) }
      else setRecipeNames(Object.fromEntries(recipeIds.filter(id => book.recipes.has(id)).map(id => [id, book.recipes.get(id).name])))
    }
    setLoading(false)
    loadIngredients(list, reqKey, { reads, runAt: madeAt })
    // Only when some day shown has no samples: then whether the outlet enters monthly Bulk totals
    // is the difference between "no sales" and "no dated sales". Best-effort; a failure says nothing.
    if (list.some(d => d.sampleCount === 0)) {
      countUndatedRows(supabase, periodsP, madeAt).then(
        n => { if (horizonReq.isCurrent(reqKey)) setUndatedRows(n) },
        err => console.error('demand forecast: could not count the Bulk sales entries in the window:', err))
    }
  }, [clientId, horizon, scopedFrom, horizonReq, loadIngredients, periodList])

  useEffect(() => { loadStored() }, [loadStored])

  // Rainy days (S800, owner decision): the dashboard's own rule — the Growth weather feature, the
  // Owner's rain percentage, rain forecast within the next seven days (rainFactorForMonth). A day it
  // touches has its expected dishes scaled before the list is worked out.
  const weatherFeature = hasFeature('weather_forecast')
  const { weather, weatherByAd, own: weatherOwn, located: weatherLocated, stripState } = useWeatherStrip({})
  const rainPct = weatherOwn ? rainPctValue(settings?.rain_sales_pct) : null
  // The rain setting applies (S849, FORECAST-4): the Growth weather feature, a percentage, a city.
  // Then a Recompute learns how rainy each day's samples were, and waits for the weather while it
  // is still loading, so a run made a second too early does not store "unknown" for a wet fortnight.
  const rainApplies = weatherFeature && rainPct != null && weatherLocated
  const weatherPending = rainApplies && stripState === 'loading'
  // One sample day's rain factor: the Owner's % on a recorded rainy day, else 1. A day older than
  // the weather store's 60 days has no row, so it counts as dry, which is the finding's own answer.
  const sampleFactorOf = useMemo(() => (
    rainApplies && weatherByAd
      ? sample => (isRainyDay(weatherByAd[formatAd(sample.date)]) ? rainPct / 100 : 1)
      : null
  ), [rainApplies, weatherByAd, rainPct])
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
  // Each day's list factor (S849, FORECAST-4): the rain ahead (the Owner's % on a rainy day, else 1)
  // ÷ how rainy the days it learned from were (the stored sampleRainFactor). A rainy day ahead is
  // bought at the Owner's % of a DRY day, and a dry day after a wet fortnight at a dry day's level —
  // the average already held that rain, and multiplying it by the % again counted it twice (~37%
  // short at 50% in the monsoon). Only while the rain setting applies: without it, rain moves
  // nothing (S800). The dish table and the Roster keep the observed average.
  const rain = useMemo(() => {
    const forwardOf = d => rainByMonth?.[`${d.bs.year}:${d.bs.month}`]?.factorOf(d.bs.day) ?? 1
    const historyOf = d => (rainApplies && d.sampleRainFactor > 0 ? d.sampleRainFactor : 1)
    const listForecast = scaleForecastDays(forecast, d => forwardOf(d) / historyOf(d))
    const rainDays = forecast.filter(d => forwardOf(d) !== 1)
    // One line per weekday whose samples were rainy: a 30-day run repeats each weekday's samples.
    const seen = new Set()
    const wetHistory = []
    for (const d of forecast) {
      if (historyOf(d) === 1 || !(d.rainySampleCount > 0)) continue
      const w = dayOf(d)
      if (seen.has(w)) continue
      seen.add(w)
      wetHistory.push({ weekday: WEEKDAYS_FULL[w], rainy: d.rainySampleCount, of: d.sampleCount })
    }
    return { listForecast, rainDays, wetHistory }
  }, [forecast, rainByMonth, rainApplies])
  const { listForecast, rainDays, wetHistory } = rain
  const rainAheadText = rainDays.length > 0
    ? `Rain is forecast on ${rainDays.map(d => `${WEEKDAYS[dayOf(d)]} ${d.bs.day} ${BS_MONTHS[d.bs.month - 1]}`).join(', ')}, so ${rainDays.length === 1 ? 'that day is' : 'those days are'} bought at ${rainPct}% of a dry day (your rainy-day setting).`
    : ''
  const wetHistoryText = wetHistory.length === 0 ? ''
    : wetHistory.length === 1
      ? `${wetHistory[0].rainy} of the ${wetHistory[0].of} ${wetHistory[0].weekday}s the forecast learned from ${wetHistory[0].rainy === 1 ? 'was' : 'were'} rainy, so the list is worked out from a dry day's level rather than counting that rain again.`
      : `Some of the days the forecast learned from were rainy (${wetHistory.map(w => `${w.rainy} of the ${w.of} ${w.weekday}s`).join(', ')}), so the list is worked out from a dry day's level rather than counting that rain again.`
  const rainChangedList = !!(rainAheadText || wetHistoryText)

  // The buying list, derived (S800): forecast use (rain applied) + the par to keep − in store,
  // rounded up to the pack it is bought in, grouped by the supplier it is usually bought from.
  // Forecast use is the recipes plus the guests' usual choices (S849, FORECAST-3); rain and the
  // horizon apply to both halves.
  const buy = useMemo(() => {
    const ing = ingredients
    const known = ing.stock?.onHandById != null
    const totals = totalQtyByRecipe(listForecast)
    const recipeDemand = aggregateIngredientDemand(totals, ing.exploded || {})
    const choiceDemand = aggregateIngredientDemand(totals, ing.choicePerPlate || {})
    // An item reached only by choices that leave it OUT ("no onion" on a dish with no onion) is not
    // used by the forecast at all, so it is not a line on the list.
    const byItem = Object.fromEntries(Object.entries(addDemand(recipeDemand, choiceDemand))
      .filter(([id]) => id in recipeDemand || choiceDemand[id] > 0))
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
        fromRecipes: recipeDemand[b.id] || 0, fromChoices: choiceDemand[b.id] || 0,
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

  const horizonLabel = horizon === 7 ? 'Next 7 Days' : 'Next 30 Days'
  // A dish id with no name is never shown as a UUID (S756): unavailable when the read failed,
  // unnamed when it succeeded without it.
  const dishName = id => recipeNames[id] || (namesError ? 'Dish name unavailable' : 'Unnamed dish')
  // When the SHOWN forecast was made (FORECAST-8) — its own rows' server stamp, not the run log.
  const madeLabel = runAt ? whenText(runAt) : null
  const stockPeriodLabel = buy.stockPeriod
    ? `${BS_MONTHS[buy.stockPeriod.bs_month - 1]} ${buy.stockPeriod.bs_year}${buy.stockPeriod.status === 'open' ? '' : ' (closed)'}`
    : null
  const inStoreKnown = !buy.stockError && !!buy.stockPeriod
  // What a printed or exported copy covers, in one line (the S594 scope rule).
  const scopeLine = forecast.length > 0
    ? `${horizonLabel} · ${bsLabel(forecast[0])} – ${bsLabel(forecast[forecast.length - 1])} (${forecast.length} day${forecast.length === 1 ? '' : 's'})`
      + (madeLabel ? ` · forecast made ${madeLabel}` : '')
      + (inStoreKnown ? ` · in store as at ${stockPeriodLabel}` : ' · in store not available')
    : horizonLabel
  // Print and Export carry the figures, the dish names and the letterhead, so they wait on all
  // three (the S728 rule: a control that emits a file is where a stale or partial render sticks).
  const emitBlocked = loading || !!loadError || forecast.length === 0 || ingredients.loading || !biz.ready || !!namesError
  // Whether the forecast has any dish to buy for (FORECAST-10d): the empty list says which case it is.
  const forecastHasDishes = forecast.some(d => Object.values(d.forecastQtyByRecipe).some(q => q > 0))

  function handlePrint() {
    printWithTitle(`${biz.name ? biz.name + ' - ' : ''}Demand Forecast - ${horizonLabel}`)
  }

  // Says what the rebuild learned from, and only says "rebuilt" when it was (FORECAST-1).
  function rebuiltText(res) {
    const days = n => `${n} day${n === 1 ? '' : 's'}`
    const parts = []
    if (res.tillDays > 0) parts.push(`${days(res.tillDays)} of till bills`)
    if (res.manualDays > 0) parts.push(`${days(res.manualDays)} of hand-entered sales`)
    let text = `Forecast rebuilt from ${parts.join(' and ') || 'your sales history'} in the last 12 weeks.`
    if (rainApplies && !sampleFactorOf) text += ' Rain in the history was not allowed for: the weather could not be read.'
    if (res.leftover) text += ' An older copy could not be cleared; it is not shown, and the next Recompute removes it.'
    return text
  }

  async function handleRecompute() {
    setRecomputing(true); setMsg('')
    try {
      // Bounded (FORECAST-10a). A run is a server read, a write and a clear; a hang must end.
      const res = await withTimeout(runForecast(clientId, horizon, { sampleFactorOf }), 60000, 'Rebuilding the forecast')
      if (res.refused === 'no_history') {
        setMsg('warn:There are no sales in the last 12 weeks to forecast from, so nothing was rebuilt; the forecast below is unchanged.')
      } else {
        setMsg('ok:' + rebuiltText(res))
      }
      await loadStored()
    } catch (err) {
      // A timed-out or dropped rebuild may still have landed after the clock ran out: say so, and
      // never claim the old figures are the newest (error-messages.md).
      if (isTimeout(err)) {
        setMsg('error:The rebuild took too long to answer, so it is not known whether a new forecast was saved. Reload the page to see which forecast is stored.')
      } else if (isNetworkError(err)) {
        setMsg('error:' + errorText(err, 'operator') + ' It is not known whether a new forecast was saved. Reload the page to see which forecast is stored.')
      } else {
        setMsg('error:' + errorText(err, 'operator') + ' The figures below are from the last forecast that ran, not a new one.')
      }
    } finally {
      // The horizon chips re-enable here, whatever happened.
      setRecomputing(false)
    }
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
        // One sentence for both rain adjustments (S849, FORECAST-4).
        ...(rainChangedList ? [`Rain changed the list: ${[
          rainDays.length ? `${rainDays.map(bsLabel).join(', ')} ${rainDays.length === 1 ? 'is' : 'are'} bought at ${rainPct}% of a dry day (your rainy-day setting)` : '',
          wetHistory.length ? `the rainy days in the forecast's history (${wetHistory.map(w => `${w.rainy} of ${w.of} ${w.weekday}s`).join(', ')}) are worked back to a dry day's level first, so that rain is not counted twice` : '',
        ].filter(Boolean).join('; ')}.`] : []),
        ...(Object.keys(ingredients.choicePerPlate || {}).length ? ['Forecast use includes the choices guests usually make on each dish (Crest Customization), learned per plate from the till sales of the 12 weeks the forecast learned from.'] : []),
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

  // What a cover counts (S835, owner decision D43): the same sentence as Roster.jsx's
  // COVERS_COUNT_TIP, on the staffing screens that read this figure. Change both together.
  const coversHeader = hasPos
    ? <Tip text="Average covers on this weekday from closed POS bills, with any holiday multiplier. Covers: Seated guests on dine-in bills, and each takeaway or delivery order as one. The Owner Report's Guests Seated counts dine-in guests only." width={280}>Forecast Covers</Tip>
    : null

  // A Forecast use figure, with the guests' choices named on hover where they are part of it
  // (S849, FORECAST-3). Both halves are already scaled for rain and the horizon.
  const forecastUseCell = r => {
    if (!r.fromChoices) return fmtQty(r.qty)
    const q = n => `${fmtQty(n)}${r.uom ? ` ${r.uom}` : ''}`
    const text = r.fromChoices > 0
      ? `${q(r.qty)} in all, of which ${q(r.fromChoices)} from the choices guests usually make (Crest Customization).`
      : `The recipes use ${q(r.fromRecipes)}; the choices guests usually make take ${q(-r.fromChoices)} off it (choices that leave it out)${r.qty > 0 ? '.' : ', so forecast use is 0, never below.'}`
    return <Tip text={text} width={260}>{fmtQty(r.qty)}</Tip>
  }

  return (
    <div>
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
        <div style={{ fontSize: 11 }}>Printed: {whenText(new Date())}</div>
      </div>

      <div className="page-header no-print">
        {/* The Tip sits beside the heading, not in it, so the heading's name is only its text (S852). */}
        <div className="page-title-row">
          <h1 className="page-title">Demand Forecast</h1>
          <Tip text="Predicts each day ahead: plates per dish, revenue and, with Crest POS, covers. It uses the same weekday in your recent sales, recent weeks counting more." width={300}>
            <span aria-hidden="true">ⓘ</span><span className="sr-only">About Demand Forecast</span>
          </Tip>
        </div>
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
          <Tip text={weatherPending
            ? 'Waiting for the weather, so the rebuild can allow for the rainy days in your sales history. It takes a moment.'
            : 'Rebuilds the forecast from your latest sales data. Run this whenever you want an up-to-date prediction — it does not run automatically. The Owner and an inventory supervisor or manager can run it.'}>
            <button className="btn btn-primary" onClick={handleRecompute} disabled={recomputing || weatherPending}>
              {recomputing ? 'Recomputing…' : weatherPending ? 'Loading weather…' : 'Recompute Forecast'}
            </button>
          </Tip>
          <button className="btn btn-ghost" onClick={handleExport} disabled={emitBlocked || !!ingredients.error}>Export Excel</button>
          <button className="btn btn-ghost" onClick={handlePrint} disabled={emitBlocked}>Print</button>
        </div>
        {/* This horizon's latest Recompute (FORECAST-8, GAPS-13): when by the server's clock, who
            (the stamp trigger writes the name; "Crest support" for the operator), and what it did. */}
        {lastRun && (
          <span style={{ fontSize: 11, color: 'var(--theme-text3)', marginLeft: 'auto' }}>
            Last run {whenText(lastRun.run_at)}{lastRun.run_by_name ? ` by ${lastRun.run_by_name}` : ''}
            {lastRun.error
              ? <span style={{ color: 'var(--theme-red-text)' }}> — failed: {errorText({ message: lastRun.error }, 'operator')}</span>
              : lastRun.rows_written === 0
                ? ' — found no sales history, so nothing was replaced'
                : ` (${lastRun.rows_written} rows)`}
          </span>
        )}
      </div>

      {/* S857: the one note that changes how the table reads; the longer explanation is in Help.
          It was a 12px paragraph above three more notes, all before the first figure. */}
      {(horizon === 30 || !hasPos) && (
        <div className="note-banner no-print">
          {horizon === 30 && 'Days 8 to 30 repeat the weekly pattern; only holidays change one week from the next. '}
          {!hasPos && 'No Crest POS here, so there are no covers and revenue is priced at the current menu.'}
        </div>
      )}

      {msg && (
        <p role={msg.startsWith('ok:') ? 'status' : 'alert'} className="no-print" style={{
          color: msg.startsWith('error:') ? 'var(--theme-red-text)' : msg.startsWith('warn:') ? 'var(--theme-amber-text)' : 'var(--theme-green-text)',
          fontSize: 13, marginBottom: 12,
        }}>{msg.replace(/^(error|warn|ok):/, '')}</p>
      )}

      {/* Two failed reads with one consequence, so one banner (S857). */}
      {(biz.error || (!loading && !loadError && namesError)) && (
        <div role="alert" className="amber-banner no-print">
          <strong>△ Print and Excel are off.</strong>{' '}
          {biz.error ? 'The outlet name could not be loaded. ' : ''}
          {!loading && !loadError && namesError ? 'The dish names could not be loaded, so dishes read "Dish name unavailable". ' : ''}
          Reload the page to try again.
        </div>
      )}
      {/* The stored forecast is older than the days it covers (S756). Nothing re-runs it on its own,
          so say how much of it has gone by and what that does to the ingredient list. */}
      {!loading && !loadError && stale.dropped > 0 && forecast.length > 0 && (
        <div role="alert" className="amber-banner no-print">
          <strong>△ {stale.dropped} of the {stale.total} days in this forecast have passed.</strong>{' '}
          {madeLabel ? `It was made on ${madeLabel}. ` : ''}Only the days from today are shown, and the buying list covers only those.
          Press Recompute Forecast for a full {horizonLabel.toLowerCase()}.
        </div>
      )}

      {loading ? (
        <div className="card"><p style={{ color: 'var(--theme-text2)', fontSize: 13, margin: 0 }}>Loading…</p></div>
      ) : loadError ? (
        <ReportLoadError error={loadError} />
      ) : forecast.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <p className="empty-state-text">
              {stale.dropped > 0
                ? `Every day in the last forecast for this horizon has already passed${madeLabel ? ` — it was made on ${madeLabel}` : ''}. Click "Recompute Forecast" to forecast the days ahead.`
                : 'No forecast yet for this horizon — click "Recompute Forecast" to generate one.'}
            </p>
          </div>
        </div>
      ) : (
        <>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Date (BS)</th><th>Day</th>
                {hasPos && <th style={{ textAlign: 'right' }}>{coversHeader}</th>}
                <th style={{ textAlign: 'right' }}><Tip text="Before VAT and after bill discounts — the same Revenue figure Owner Dashboard and Sales Entries use, so it can be compared with them and with the Labor Forecast's cost %." width={260}>Forecast Revenue</Tip></th>
                <th><span className="sr-only">Holiday</span></th>
              </tr>
            </thead>
            <tbody>
              {forecast.map((f, idx) => {
                const weekday = dayOf(f)
                const { plates, occasional } = splitDishList(Object.entries(f.forecastQtyByRecipe))
                const showingAll = expandedIdx === idx
                const visiblePlates = showingAll ? plates : plates.slice(0, PREVIEW_COUNT)
                const hiddenPlates = plates.length - visiblePlates.length
                const evidence = evidenceText(f, { undated: undatedRows || 0 })
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
                            : <Tip text={f.sampleCount === 0
                              ? 'No closed till bills on this weekday in the last 12 weeks.'
                              : 'No closed POS bills on this weekday in the last 12 weeks — the dishes came from manual Sales Entries, which carry no covers.'}>—</Tip>}
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
                          : <Tip text={`No demand multiplier set for ${f.holiday.name} in Holiday Calendar — this forecast is NOT adjusted for it. Treat it as a floor, not a ceiling, on a festival day.`}><span className="badge badge-amber">△ {f.holiday.name}</span></Tip>
                      )}</td>
                    </tr>
                    {(plates.length > 0 || occasional.length > 0) && (
                      <tr>
                        <td colSpan={colSpan} style={{ padding: '2px 12px 10px', borderTop: 'none' }}>
                          {/* Whole plates to prep. The raw average sits on hover — 0.8 was being read as a
                              portion size, and nobody makes 0.8 of a toast (S694). S858: each count is
                              plain text with its average in a `title`; a Tip on every dish was a Tab stop
                              each, about 180 of them on a 30-day forecast before the buying list. ONE Tip
                              per day leads the line and says what the counts are, for the keyboard. */}
                          <div className="no-print" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, fontSize: 11, color: 'var(--theme-text3)', alignItems: 'baseline' }}>
                            {plates.length > 0 && (
                              <Tip text={`Whole plates to prep, rounded up from the daily average${evidence ? ` (${evidence}, recent weeks weighted more)` : ''}. Hover a dish for its average.`} width={260}>
                                <span style={{ fontStyle: 'italic' }}>Plates to prep:</span>
                              </Tip>
                            )}
                            {visiblePlates.map(p => (
                              <span key={p.recipeId} title={avgTip(p.qty)}>{nameOf(p.recipeId)}: <strong style={{ color: 'var(--theme-text2)' }}>{p.plates}</strong></span>
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
                              {/* S858: the same shape as the plates line, one Tip for the list and a
                                  `title` per dish rather than a Tab stop each. */}
                              <Tip text={`Sold on fewer than one ${WEEKDAYS_FULL[weekday]} in two — under ${OCCASIONAL_THRESHOLD} a day on average. Worth having the ingredients for, not worth prepping a plate of. Hover a dish for the weeks behind its average.`} width={260}>
                                <span style={{ fontStyle: 'italic' }}>Occasional:</span>
                              </Tip>
                              {occasional.map(o => (
                                <span key={o.recipeId} title={avgTip(o.qty)}>{nameOf(o.recipeId)} <span style={{ opacity: 0.8 }}>({o.qty.toFixed(1)}/day)</span></span>
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
          <div className="page-title-row" style={{ margin: '0 0 2px' }}>
            <h2 style={{ margin: 0, fontSize: 18, color: 'var(--theme-text1)' }}>
              Ingredients to buy — {horizonLabel.toLowerCase()}
            </h2>
            <Tip text="Every dish above, worked through its recipe (sub-recipes and yields included) and added up per raw item for the days shown. With Crest Customization it adds the choices guests usually make." width={300}>
              <span aria-hidden="true">ⓘ</span><span className="sr-only">About the ingredients to buy</span>
            </Tip>
          </div>
          <p style={{ fontSize: 12, color: 'var(--theme-text3)', margin: '0 0 12px' }}>
            In each item's base unit. To buy = forecast use + the par to keep − in store, never below zero, rounded up to whole packs where the item has a pack size, and grouped by the supplier you last bought it from. The value is of what will arrive, at the Item Master rate. Occasional dishes are included at their average, so a rarely-sold dish still puts a little of its ingredients on the list.
            {!ingredients.loading && !ingredients.error && inStoreKnown && ` In store is as at ${stockPeriodLabel}.`}
          </p>
          {/* S849 FORECAST-4: both halves of the rain rule, the rain ahead and the rain already
              inside the weekday average, so neither is counted twice and both are named. */}
          {rainChangedList && (
            <p className="note-banner" role="status" style={{ margin: '0 0 12px', fontSize: 12 }}>
              <strong>Rain changed the list.</strong> {[rainAheadText, wetHistoryText].filter(Boolean).join(' ')} The dish table above still shows the usual numbers.
            </p>
          )}
          {!ingredients.loading && !ingredients.error && ingredients.choiceError && (
            <p role="status" style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--theme-amber-text)' }}>
              The guests' usual choices could not be read, so the list covers the recipes only. Reload to try again.
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
              {forecastHasDishes
                ? 'None of the forecast dishes has ingredients in Recipe Costing, or guest choices with stock lines, yet, so there is nothing to explode.'
                : 'This forecast has no dishes, so there is nothing to buy for it.'}
            </div>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Item</th><th>Category</th>
                    <th style={{ textAlign: 'right' }}><Tip text={`What the forecast will use over the ${forecast.length} day${forecast.length === 1 ? '' : 's'} shown, in the base unit: recipes plus usual guest choices (hover a figure for that part). Never below zero.${rainChangedList ? ' Rain is allowed for as the note above says.' : ''}`} width={300}>Forecast use</Tip></th>
                    <th style={{ textAlign: 'right' }}><Tip text={`On the shelf now (Stock Report On-hand${stockPeriodLabel ? `, ${stockPeriodLabel}` : ''}): the closing count if entered, else opening + net purchases − usage − wastage − staff meals. A dash: not known.`} width={300}>In store</Tip></th>
                    <th style={{ textAlign: 'right' }}><Tip text="The item's par level — the least you want left on the shelf — set on the Reorder Report. The list buys enough to keep it. A dash means no par is set." width={260}>Keep</Tip></th>
                    <th style={{ textAlign: 'right' }}><Tip text="Forecast use + Keep − In store, never below zero. Zero means what is on the shelf already covers the forecast and the par." width={240}>To buy</Tip></th>
                    <th><Tip text="What to order: whole packs where Item Master has a pack size (such as a 25 kg sack), else To buy rounded up to a whole unit. A purchase order started here asks for this." width={280}>Order</Tip></th>
                    <th>Unit</th>
                    <th style={{ textAlign: 'right' }}><Tip text="What will arrive, times the current per-unit rate in Item Master. A dash means the item has no rate yet, or what is in store is unknown." width={280}>≈ Value</Tip></th>
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
                              <button type="button" className="btn btn-ghost btn-sm no-print" style={{ marginLeft: 12 }} onClick={() => raisePo(g)} aria-label={`Create purchase order for ${g.name}`}>
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
                          <td style={{ textAlign: 'right' }}>{forecastUseCell(r)}</td>
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
                          <td style={{ textAlign: 'right' }}>{forecastUseCell(r)}</td>
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
    </div>
  )
}
