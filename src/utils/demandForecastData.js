import { supabase } from '../supabaseClient'
import { scopedFrom, scopedInsert, scopedDelete } from '../shared/scopedDb'
import { fetchAllRowsChunked } from '../shared/fetchAllRows'
import { settleWithin } from './withTimeout'
import { randomUUID } from './uuid'
import {
  LOOKBACK_DAYS, historyFromDailyTotals, mergeManualHistory, periodsInLookback, forecastByWeekday,
  holidaysByKeyOf, hasForecastEvidence, dateOfIso,
} from './demandForecastMath'

// The arithmetic lives in demandForecastMath.js (pure, tested); this file is the Supabase
// orchestration around it. Re-exported so older imports keep resolving.
export { historyFromDailyTotals, mergeManualHistory, forecastByWeekday } from './demandForecastMath'

export const FORECAST_METHOD = 'weekday_weighted_average'

// How long the training read may take before the run gives up on it. It is one server read over
// 84 days of bills, so it is slower than a page read, and a Recompute is a deliberate wait.
const HISTORY_TIMEOUT_MS = 30000

// The run log row (GAPS-13, FORECAST-8). No run_at and no run_by: the stamp trigger
// (demand_forecast_run_log_stamp) writes both from the server's clock and the signed-in login,
// whatever a browser sends. A refused run (no history) is rows_written 0 with no error; a written
// run always has at least one row per day, so the two never look alike. Its error is checked
// and logged — the forecast it describes stands either way.
async function logRun(clientId, { horizonDays, rowsWritten, runId = null, error = null }) {
  const { error: logErr } = await scopedInsert('demand_forecast_run_log', clientId, {
    method: FORECAST_METHOD, rows_written: rowsWritten, error,
    horizon_days: horizonDays, run_id: runId,
  })
  if (logErr) console.error('demand forecast: the run log row could not be written:', logErr)
}

// Rebuilds the stored forecast for one horizon.
//
// The till and the holidays are read through ONE caller-checked server read,
// demand_forecast_history (S849, FORECAST-1, owner decision SU1 a), for every caller — Owner,
// operator, IMS supervisor or manager. pos_orders, pos_order_items and hr_holiday_calendar carry
// the restrictive no_ims_staff policy, so an IMS login's own reads came back EMPTY with no error,
// and its Recompute replaced the Owner's forecast with an empty one and said "rebuilt". The read
// hands back daily totals only (bills, covers, ex-VAT revenue net of the bill discount, plates per
// dish), Nepal's today by the server's clock, the window start, and the non-removed holidays.
//
// Hand-entered daily Sales Entries are read here in the browser (an IMS login reads them) and
// always merged per (day, dish) — FORECAST-6.
//
// `sampleFactorOf(sample)` is the page's rain factor of one sample day (FORECAST-4); this file
// knows nothing about weather. Without it the run stores no history rain factor.
//
// Returns { forecast, rowsWritten, refused, tillDays, manualDays, undatedRows, leftover }:
// refused 'no_history' = nothing at all to learn from, so nothing was written or cleared (the
// stored forecast stands); leftover = the new run was written but the older copy could not be
// cleared (the page reads only the newest run, and the next Recompute clears it).
export async function runForecast(clientId, horizonDays = 7, { sampleFactorOf = null } = {}) {
  try {
    const [historyRes, periodsRes] = await Promise.all([
      settleWithin(
        supabase.rpc('demand_forecast_history', { p_client_id: clientId, p_lookback_days: LOOKBACK_DAYS }),
        HISTORY_TIMEOUT_MS, 'Reading the sales history'),
      scopedFrom('monthly_periods', clientId, 'id, bs_year, bs_month'),
    ])
    // A failed read is not "no history": a dead connection used to train the forecast on nothing
    // and write a confident zero for every day (S683). Each throws into the catch below, which
    // records the failure on the run log and rethrows.
    if (historyRes.error) throw historyRes.error
    if (periodsRes.error) throw periodsRes.error
    const h = historyRes.data || {}
    // The window by the SERVER's Nepal date (FORECAST-5): today is never a sample, and a Recompute
    // from abroad files each day's dinner under its own day.
    const today = dateOfIso(h.today)
    const from = dateOfIso(h.from)
    if (!today || !from) throw new Error('The sales history came back without its dates.')
    const tillHistory = historyFromDailyTotals(h.days)

    const windowPeriods = periodsInLookback(periodsRes.data, from, today)
    const periodsById = Object.fromEntries(windowPeriods.map(p => [p.id, p]))
    const periodIds = windowPeriods.map(p => p.id)
    let manualEntries = []
    if (periodIds.length > 0) {
      // Chunked and paged: a period set of a few months still crosses 1000 rows on a long menu
      // (S683). `source` is DEFAULT 'manual' but nullable, and rows predating the default read
      // as NULL — the same predicate persistSalesDay.js uses, or those days vanish from the
      // forecast while still counting as revenue everywhere else.
      const { data, error: manualErr } = await fetchAllRowsChunked(periodIds, ids =>
        supabase.from('sales_entries').select('period_id, recipe_id, bs_day, qty_sold, source')
          .in('period_id', ids).or('source.is.null,source.eq.manual').order('id'))
      if (manualErr) throw manualErr
      manualEntries = data || []
    }
    const { history, manualDays, undatedRows } = mergeManualHistory(tillHistory, manualEntries, periodsById, { from, today })

    // One entry per date; which row wins when a date carries two holidays is holidaysByKeyOf's rule.
    const holidaysByKey = holidaysByKeyOf(h.holidays)

    const forecast = forecastByWeekday(history, horizonDays, holidaysByKey, today, { sampleFactorOf })
    const evidence = { tillDays: tillHistory.length, manualDays, undatedRows }

    // Never replace a forecast with an empty one (FORECAST-1). Nothing is written and nothing is
    // cleared; the run log says it was refused, not that it failed.
    if (!hasForecastEvidence(forecast)) {
      await logRun(clientId, { horizonDays, rowsWritten: 0 })
      return { forecast, rowsWritten: 0, refused: 'no_history', leftover: false, ...evidence }
    }

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

    const runId = randomUUID()
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
        run_id: runId,
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
        // How rainy those samples were (FORECAST-4, S849): the buying list divides by it. Rounded
        // to four places and held inside the column's CHECK (the Owner's % is 30–150).
        sample_rain_factor: f.sampleRainFactor == null ? null
          : Math.min(1.5, Math.max(0.3, Math.round(f.sampleRainFactor * 10000) / 10000)),
        rainy_sample_count: f.rainySampleCount,
      })
      for (const [recipeId, qty] of Object.entries(f.forecastQtyByRecipe)) {
        rows.push({
          run_id: runId,
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
    // being wiped with nothing to replace them. demand_forecast_daily has no natural upsert key
    // (recipe-level rows share a date), so every row carries this run's id and the old rows are
    // cleared as "this horizon, any other run" afterward (S792 PLANNING-1: never `id NOT IN
    // (<every new id>)`, which put ~45 KB of uuids in the URL). `run_id IS NULL` is part of the
    // filter on purpose: rows from before the column have none, and `<>` alone drops NULLs.
    const { error: insErr } = await scopedInsert('demand_forecast_daily', clientId, rows)
    if (insErr) throw insErr

    // Clear only runs OLDER than this one (S792.4). "Any run but mine" was right for one
    // Recompute at a time and wrong for two: A inserts, B inserts, A clears B's run, B clears A's,
    // and the horizon is empty. Each run deletes only rows stamped before its own, so whichever is
    // newest survives both clears — and the page shows only the newest run (newestRunOnly).
    // "Older" is the server's clock: generated_at is DEFAULT now(), one value per INSERT, read back
    // rather than guessed. The run_id arm keeps this run's own rows out of its own clear.
    let leftover = false
    const { data: mine, error: mineErr } = await scopedFrom('demand_forecast_daily', clientId, 'generated_at')
      .eq('run_id', runId).limit(1)
    const stampedAt = mine?.[0]?.generated_at
    if (mineErr) {
      // The new run is in; the old one simply stays until the next Recompute clears it, and the
      // page reads the newest either way. Not worth failing a forecast that was written.
      console.error('demand forecast: could not read back this run\'s timestamp, so the previous run was left for the next Recompute to clear:', mineErr)
    } else if (stampedAt) {
      const { error: delErr } = await scopedDelete('demand_forecast_daily', clientId)
        .eq('horizon_days', horizonDays).or(`run_id.is.null,run_id.neq.${runId}`)
        .lt('generated_at', stampedAt)
      if (delErr) {
        // FORECAST-8: the new run landed, so this run is a success with an older copy left behind
        // — never "no forecast was made". The page reads only the newest run; the next Recompute
        // removes the older one.
        console.error('demand forecast: the new run was written but the older one could not be cleared:', delErr)
        leftover = true
      }
    }
    // No rows back: a newer Recompute has already cleared this one as older than itself, which
    // leaves exactly what this clear would have left.

    await logRun(clientId, { horizonDays, rowsWritten: rows.length, runId })
    return { forecast, rowsWritten: rows.length, refused: null, leftover, ...evidence }
  } catch (err) {
    await logRun(clientId, { horizonDays, rowsWritten: 0, error: err?.message || String(err) })
    throw err
  }
}
