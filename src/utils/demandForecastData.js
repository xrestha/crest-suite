import { supabase } from '../supabaseClient'
import { scopedFrom, scopedInsert, scopedDelete } from '../shared/scopedDb'
import { fetchAllRows, fetchAllRowsChunked, runChunkedByIds } from '../shared/fetchAllRows'
import { computeOrderAmounts } from './posBillingMath'
import { randomUUID } from './uuid'
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
function isMissingColumn(err, pattern) {
  const text = `${err?.message || ''} ${err?.details || ''}`
  return (err?.code === 'PGRST204' || err?.code === '42703') && pattern.test(text)
}

// Insert one run's rows. A database behind on migration 20260908120000 has no evidence columns;
// the forecast is still correct without them, so it is written without them rather than refused —
// the page simply omits the "from the last N Wednesdays" line until the migration lands.
async function insertForecastRows(clientId, rows) {
  const res = await scopedInsert('demand_forecast_daily', clientId, rows)
  if (!res.error || !isMissingColumn(res.error, /sample_count/)) return res
  console.warn('demand_forecast_daily has no sample_count columns yet — apply migration 20260908120000. Writing the forecast without them.')
  return scopedInsert('demand_forecast_daily', clientId, rows.map(({ sample_count, pos_sample_count, ...rest }) => rest))
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
      // Paged (S792 PLANNING-1): one row per bill over LOOKBACK_DAYS, so any till doing more than
      // ~12 bills a day passed 1,000 — and with no ORDER BY the rows kept were roughly the OLDEST,
      // so the forecast averaged a few weeks from two months ago, fell short of history, and said
      // nothing. pos_order_items below was already paged; this, its parent, was not.
      fetchAllRows(() => scopedFrom('pos_orders', clientId, 'id, covers, closed_at, credit_note_id')
        .eq('status', 'billed').eq('close_type', 'paid')
        .gte('closed_at', lookbackStart.toISOString())
        .lt('closed_at', todayStart.toISOString())
        .order('id')),
      scopedFrom('monthly_periods', clientId, 'id, bs_year, bs_month'),
      // A removed holiday (removed_at, S748) is remembered for Seed, not observed — no multiplier.
      scopedFrom('hr_holiday_calendar', clientId, 'bs_year, bs_month, bs_day, name, holiday_type, demand_multiplier').is('removed_at', null),
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

    // One entry per date, and several dates carry two holidays (Krishna Janmashtami and Gaura Parva
    // on one day, Bhai Tika and Falgunanda Jayanti on another). Object.fromEntries kept whichever row
    // PostgREST returned LAST, so a multiplier set on one of them could silently vanish. The row that
    // carries a multiplier wins, then a public holiday over an optional one (S748).
    const holidaysByKey = {}
    for (const h of holidays || []) {
      const key = `${h.bs_year}:${h.bs_month}:${h.bs_day}`
      const next = { name: h.name, holiday_type: h.holiday_type, demand_multiplier: h.demand_multiplier }
      const prev = holidaysByKey[key]
      const rank = x => (x.demand_multiplier != null ? 2 : 0) + (x.holiday_type === 'public' ? 1 : 0)
      if (!prev || rank(next) > rank(prev)) holidaysByKey[key] = next
    }

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
    // (recipe-level rows share a date), so every row carries this run's id and the old rows are
    // cleared as "this horizon, any other run" afterward — every recompute click would otherwise
    // stack duplicate day-rows. The delete's error is checked: a refused delete used to leave both
    // runs in place while the run log recorded a success.
    //
    // S792 PLANNING-1: the clear used to be `id NOT IN (<every new id>)` — ~1,230 uuids (~45 KB)
    // in the URL on a 30-day, 40-dish run, which the gateway refuses, so the old run stayed and
    // each Recompute added another. `run_id IS NULL` is part of the filter on purpose: rows from
    // before the column (and from an older cached bundle) have none, and `<>` alone drops NULLs.
    if (rows.length > 0) {
      const runId = randomUUID()
      let { error: insErr } = await insertForecastRows(clientId, rows.map(r => ({ ...r, run_id: runId })))
      if (insErr && isMissingColumn(insErr, /run_id/)) {
        // Migration 20260928160100 not applied yet on this database. Write the run without its id
        // and clear the previous one by ITS ids — read before the insert lands, deleted in chunks
        // so no request carries more than a URL's worth of them. Once the column exists this
        // branch never runs.
        console.warn('demand_forecast_daily has no run_id column yet — apply migration 20260928160100. Clearing the previous run by id.')
        const { data: oldRows, error: oldErr } = await fetchAllRows(() => scopedFrom('demand_forecast_daily', clientId, 'id')
          .eq('horizon_days', horizonDays).order('id'))
        if (oldErr) throw oldErr
        ;({ error: insErr } = await insertForecastRows(clientId, rows))
        if (insErr) throw insErr
        const { error: delErr } = await runChunkedByIds((oldRows || []).map(r => r.id), ids =>
          scopedDelete('demand_forecast_daily', clientId).in('id', ids))
        if (delErr) throw delErr
      } else {
        if (insErr) throw insErr
        // Clear only runs OLDER than this one (S792.4). "Any run but mine" was right for one
        // Recompute at a time and wrong for two: A inserts, B inserts, A clears everything that is
        // not A (B's run), B clears everything that is not B (A's run), and the horizon is empty.
        // Two tabs, or the Owner and a manager each pressing Recompute, is enough. Each run now
        // deletes only rows stamped before its own, so whichever run is newest survives both
        // clears — and the page already shows only the newest run (newestRunOnly in
        // DemandForecast.js), so an older run a clear missed is never what anyone reads.
        //
        // "Older" is the server's clock, never this device's: generated_at is DEFAULT now(), one
        // value for the whole INSERT (never NULL — no writer sets it, so `.lt` strands nothing),
        // and it is what the page's reader ranks runs by too. So it is read back rather than
        // guessed. The run_id arm stays: it keeps this run's own rows out of its own clear even if
        // two runs ever shared a timestamp.
        const { data: mine, error: mineErr } = await scopedFrom('demand_forecast_daily', clientId, 'generated_at')
          .eq('run_id', runId).limit(1)
        const stampedAt = mine?.[0]?.generated_at
        if (mineErr) {
          // The new run is in; the old one simply stays until the next Recompute clears it, and
          // the page reads the newest either way. Not worth failing a forecast that was written.
          console.error('demand forecast: could not read back this run\'s timestamp, so the previous run was left for the next Recompute to clear:', mineErr)
        } else if (stampedAt) {
          const { error: delErr } = await scopedDelete('demand_forecast_daily', clientId)
            .eq('horizon_days', horizonDays).or(`run_id.is.null,run_id.neq.${runId}`)
            .lt('generated_at', stampedAt)
          if (delErr) throw delErr
        }
        // No rows back: a newer Recompute has already cleared this one as older than itself,
        // which leaves exactly what this clear would have left.
      }
    } else {
      // A run with no rows at all. forecastByWeekday returns one row per horizon day even with no
      // history, so a 7- or 30-day Recompute never lands here; it stays as the plain clear it was
      // rather than taking the narrowed form above, which needs a row of its own to read back.
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
