import { supabase } from '../supabaseClient'
import { scopedFrom, scopedInsert, scopedDelete } from '../shared/scopedDb'
import { fetchAllRowsChunked } from '../shared/fetchAllRows'
import { computeOrderAmounts } from './posBillingMath'
import {
  LOOKBACK_DAYS, buildDailyHistory, buildManualDailyHistory, periodsInLookback, forecastByWeekday,
} from './demandForecastMath'

// The arithmetic lives in demandForecastMath.js (pure, tested); this file is the Supabase
// orchestration around it. Re-exported so older imports keep resolving.
export { buildDailyHistory, buildManualDailyHistory, forecastByWeekday } from './demandForecastMath'

export const FORECAST_METHOD = 'weekday_weighted_average'

// PostgREST reports an unknown column as PGRST204 ("Could not find the 'x' column …") from its
// schema cache; Postgres itself would say 42703. Either way, only the two evidence columns are
// new enough to be missing.
function isMissingSampleColumns(err) {
  const text = `${err?.message || ''} ${err?.details || ''}`
  return (err?.code === 'PGRST204' || err?.code === '42703') && /sample_count/.test(text)
}

export async function runForecast(clientId, horizonDays = 7) {
  const now = new Date()
  const runStartedAt = now.toISOString()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const lookbackStart = new Date(todayStart)
  lookbackStart.setDate(todayStart.getDate() - LOOKBACK_DAYS)

  try {
    const [ordersRes, periodsRes, holidaysRes] = await Promise.all([
      // Bounded at both ends: today's bills are a partial day and must not stand in for a whole
      // one (forecastByWeekday drops them too — this just avoids fetching them).
      scopedFrom('pos_orders', clientId, 'id, covers, closed_at, credit_note_id')
        .eq('status', 'billed').eq('close_type', 'paid')
        .gte('closed_at', lookbackStart.toISOString())
        .lt('closed_at', todayStart.toISOString()),
      scopedFrom('monthly_periods', clientId, 'id, bs_year, bs_month'),
      scopedFrom('hr_holiday_calendar', clientId, 'bs_year, bs_month, bs_day, name, holiday_type, demand_multiplier'),
    ])
    // A failed read is not "no history": every read in this run used to drop its error, so a dead
    // connection trained the forecast on nothing and wrote a confident zero for every day (S683).
    // Each throws into the catch below, which records the failure on the run row and rethrows.
    const readErr = ordersRes.error || periodsRes.error || holidaysRes.error
    if (readErr) throw readErr
    const orders = ordersRes.data, periods = periodsRes.data, holidays = holidaysRes.data
    const orderList = orders || []

    let itemsByOrder = {}
    if (orderList.length > 0) {
      // Paged: the forecast reads a long history of bills, so this is the largest pos_order_items
      // read in the app — truncation would silently train the forecast on a fraction of it (S529).
      // Chunked as well as paged: LOOKBACK_DAYS of bills is hundreds of order ids, and an `.in()`
      // list is a URL before it is a row count.
      const { data: items, error: itemsErr } = await fetchAllRowsChunked(orderList.map(o => o.id), ids =>
        scopedFrom('pos_order_items', clientId, 'order_id, recipe_id, qty, unit_price, vat_rate, comped')
          .in('order_id', ids).order('id'))
      if (itemsErr) throw itemsErr
      itemsByOrder = (items || []).reduce((acc, i) => {
        ;(acc[i.order_id] = acc[i.order_id] || []).push(i)
        return acc
      }, {})
    }

    let history = buildDailyHistory(orderList, itemsByOrder, computeOrderAmounts)

    // Fallback to manual sales_entries only if POS history is sparse (new POS client / pre-POS periods)
    if (history.length < LOOKBACK_DAYS / 2) {
      const windowPeriods = periodsInLookback(periods, lookbackStart)
      const periodsById = Object.fromEntries(windowPeriods.map(p => [p.id, p]))
      const periodIds = windowPeriods.map(p => p.id)
      if (periodIds.length > 0) {
        // Chunked and paged: a period set of a few months still crosses 1000 rows on a long menu
        // (S683). `source` is DEFAULT 'manual' but nullable, and rows predating the default read
        // as NULL — the same predicate persistSalesDay.js uses, or those days vanish from the
        // forecast while still counting as revenue everywhere else.
        const { data: manualEntries, error: manualErr } = await fetchAllRowsChunked(periodIds, ids =>
          supabase.from('sales_entries').select('period_id, recipe_id, bs_day, qty_sold, source')
            .in('period_id', ids).or('source.is.null,source.eq.manual').order('id'))
        if (manualErr) throw manualErr
        const coveredKeys = new Set(history.map(h => h.date.toDateString()))
        history = history.concat(buildManualDailyHistory(manualEntries || [], periodsById, coveredKeys))
      }
    }

    const holidaysByKey = Object.fromEntries(
      (holidays || []).map(h => [`${h.bs_year}:${h.bs_month}:${h.bs_day}`, { name: h.name, holiday_type: h.holiday_type, demand_multiplier: h.demand_multiplier }])
    )

    const forecast = forecastByWeekday(history, horizonDays, holidaysByKey, now)

    // When no pos-basis samples exist for a weekday, forecastRevenue is null even though we
    // may still have a real qty forecast (from manual sales_entries) — estimate revenue from
    // forecasted qty × current ex-VAT menu price instead of showing a bare "0", and mark it
    // clearly as such. selling_price is ex-VAT (MenuPricing.js), so both bases agree.
    const allRecipeIds = [...new Set(forecast.flatMap(f => Object.keys(f.forecastQtyByRecipe)))]
    let priceByRecipe = {}
    if (allRecipeIds.length > 0) {
      const { data: recs, error: recsErr } = await fetchAllRowsChunked(allRecipeIds, ids =>
        scopedFrom('recipes', clientId, 'id, selling_price').in('id', ids).order('id'))
      if (recsErr) throw recsErr
      priceByRecipe = Object.fromEntries((recs || []).map(r => [r.id, r.selling_price || 0]))
    }

    const rows = []
    for (const f of forecast) {
      const hasPosSignal = f.posSampleCount > 0
      let revenue = f.forecastRevenue
      let revenueEstimated = false
      if (revenue == null && Object.keys(f.forecastQtyByRecipe).length > 0) {
        revenue = Object.entries(f.forecastQtyByRecipe).reduce((s, [recipeId, qty]) => s + qty * (priceByRecipe[recipeId] || 0), 0)
        revenueEstimated = true
      }
      rows.push({
        recipe_id: null,
        bs_year: f.bs.year, bs_month: f.bs.month, bs_day: f.bs.day,
        forecast_covers: f.forecastCovers, forecast_qty: null, forecast_revenue: revenue,
        revenue_estimated: revenueEstimated,
        model_basis: hasPosSignal ? 'pos' : 'manual', horizon_days: horizonDays,
        holiday_name: f.holiday?.name || null,
        holiday_multiplier: f.holiday?.demand_multiplier ?? null,
        // How much evidence stood behind the day — a forecast averaged over one week and one over
        // eight used to look identical on the page (S694; migration 20260908120000).
        sample_count: f.sampleCount,
        pos_sample_count: f.posSampleCount,
      })
      for (const [recipeId, qty] of Object.entries(f.forecastQtyByRecipe)) {
        rows.push({
          recipe_id: recipeId,
          bs_year: f.bs.year, bs_month: f.bs.month, bs_day: f.bs.day,
          forecast_covers: null, forecast_qty: qty, forecast_revenue: null,
          revenue_estimated: false,
          model_basis: hasPosSignal ? 'pos' : 'manual', horizon_days: horizonDays,
        })
      }
    }

    // Write the new run's rows BEFORE clearing the previous one (not delete-then-insert) — if the
    // insert fails partway (network drop, RLS hiccup), the prior run's rows stay intact instead of
    // being wiped with nothing to replace them (the UI would otherwise fall back to "No forecast
    // yet" instead of the last good run). demand_forecast_daily has no natural upsert key
    // (recipe-level rows share a date), so old rows are still cleared by id exclusion afterward —
    // every recompute click would otherwise stack duplicate day-rows and loadStored's read-back
    // would non-deterministically pick between old and new values. Which is exactly why the
    // delete's error is checked: a refused delete used to leave both runs in place while the run
    // log recorded a success.
    if (rows.length > 0) {
      let { data: inserted, error: insErr } = await scopedInsert('demand_forecast_daily', clientId, rows)
      if (insErr && isMissingSampleColumns(insErr)) {
        // Migration 20260908120000 not applied yet on this database. The forecast is still
        // correct without its evidence columns, so write it without them rather than refuse —
        // the page simply omits the "from the last N Wednesdays" line until the migration lands.
        console.warn('demand_forecast_daily has no sample_count columns yet — apply migration 20260908120000. Writing the forecast without them.')
        const stripped = rows.map(({ sample_count, pos_sample_count, ...rest }) => rest)
        ;({ data: inserted, error: insErr } = await scopedInsert('demand_forecast_daily', clientId, stripped))
      }
      if (insErr) throw insErr
      const newIds = (inserted || []).map(r => r.id)
      if (newIds.length > 0) {
        const { error: delErr } = await scopedDelete('demand_forecast_daily', clientId).eq('horizon_days', horizonDays).not('id', 'in', `(${newIds.join(',')})`)
        if (delErr) throw delErr
      }
    } else {
      const { error: delErr } = await scopedDelete('demand_forecast_daily', clientId).eq('horizon_days', horizonDays)
      if (delErr) throw delErr
    }
    await scopedInsert('demand_forecast_run_log', clientId, {
      run_at: runStartedAt, method: FORECAST_METHOD,
      rows_written: rows.length, error: null,
    })

    return { forecast, rowsWritten: rows.length }
  } catch (err) {
    await scopedInsert('demand_forecast_run_log', clientId, {
      run_at: runStartedAt, method: FORECAST_METHOD,
      rows_written: 0, error: err.message || String(err),
    })
    throw err
  }
}
