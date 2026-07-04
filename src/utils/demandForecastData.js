import { supabase } from '../supabaseClient'
import { bsToAd, adToBs } from './bsCalendar'
import { computeOrderAmounts } from './posBillingMath'

const LOOKBACK_DAYS = 84 // 12 weeks — enough same-weekday samples for a moving average
const SAMPLES_PER_WEEKDAY = 8 // cap how many historical same-weekday points feed the average

// ── Pure data-shaping (no Supabase) — testable in isolation ────────────────

// Collapses raw pos_orders + their items into one row per calendar day: total covers,
// total net revenue, and qty sold per recipe. Orders with a credit_note_id are excluded —
// the same rule SalesReport.jsx's dailyRows uses, since a credit-noted bill's revenue
// correction is posted as a new entry on the day it's issued, not retroactively.
export function buildDailyHistory(orders, itemsByOrder, computeOrderAmounts) {
  const byDay = {}
  for (const o of orders) {
    if (o.credit_note_id) continue
    const d = new Date(o.closed_at)
    const key = d.toDateString()
    const items = itemsByOrder[o.id] || []
    const amounts = computeOrderAmounts(o, items, true)
    const row = byDay[key] = byDay[key] || { date: new Date(d.getFullYear(), d.getMonth(), d.getDate()), weekday: d.getDay(), covers: 0, revenue: 0, qtyByRecipe: {}, basis: 'pos' }
    row.covers += o.covers || 1
    row.revenue += amounts.net
    for (const i of items) {
      if (!i.recipe_id) continue
      row.qtyByRecipe[i.recipe_id] = (row.qtyByRecipe[i.recipe_id] || 0) + i.qty
    }
  }
  return Object.values(byDay).sort((a, b) => a.date - b.date)
}

// Merges sales_entries (source='manual') history for days not already covered by POS
// history — bs_day=0 is a bulk-entry sentinel (Sales.js) and MUST be excluded, or a whole
// month's lump quantity lands on a single fabricated "day", corrupting the weekday average.
export function buildManualDailyHistory(salesEntries, periodsById) {
  const byDay = {}
  for (const e of salesEntries) {
    if (e.bs_day === 0) continue
    const period = periodsById[e.period_id]
    if (!period) continue
    const ad = bsToAd(period.bs_year, period.bs_month, e.bs_day)
    const key = ad.toDateString()
    const row = byDay[key] = byDay[key] || { date: ad, weekday: ad.getDay(), covers: 0, revenue: 0, qtyByRecipe: {}, basis: 'manual' }
    row.qtyByRecipe[e.recipe_id] = (row.qtyByRecipe[e.recipe_id] || 0) + e.qty_sold
    // manual entries carry no covers/revenue signal at all — basis:'manual' lets
    // forecastByWeekday exclude these rows from the covers/revenue average instead of
    // silently averaging in a false zero
  }
  return Object.values(byDay)
}

// Day-of-week moving average: for each of the next `horizonDays` calendar days, average the
// last up-to-SAMPLES_PER_WEEKDAY historical days that fall on the same weekday. Deliberately
// simple/auditable over a trained model — see plan tradeoff note.
export function forecastByWeekday(dailyHistory, horizonDays, holidaysByKey = {}) {
  const byWeekday = Array.from({ length: 7 }, () => [])
  for (const row of dailyHistory) byWeekday[row.weekday].push(row)
  for (const rows of byWeekday) rows.sort((a, b) => b.date - a.date) // most recent first

  const results = []
  const today = new Date()
  for (let i = 1; i <= horizonDays; i++) {
    const target = new Date(today)
    target.setDate(today.getDate() + i)
    const weekday = target.getDay()
    const samples = byWeekday[weekday].slice(0, SAMPLES_PER_WEEKDAY)
    const n = samples.length
    const bs = adToBs(target)
    const holidayKey = `${bs.year}:${bs.month}:${bs.day}`
    const holiday = holidaysByKey[holidayKey] || null

    // Qty averages over every sample (manual-basis rows carry real qty signal, that's their
    // whole purpose). Covers/revenue average ONLY over pos-basis samples — a manual-basis row
    // structurally has covers=revenue=0 (never tracked), so mixing it in would silently
    // average toward a false zero instead of reflecting "no signal available".
    const posSamples = samples.filter(s => s.basis === 'pos')

    const qtyByRecipe = {}
    for (const s of samples) {
      for (const [recipeId, qty] of Object.entries(s.qtyByRecipe)) {
        qtyByRecipe[recipeId] = (qtyByRecipe[recipeId] || 0) + qty / (n || 1)
      }
    }

    results.push({
      date: target, bs, weekday,
      sampleCount: n, posSampleCount: posSamples.length,
      forecastCovers: posSamples.length > 0 ? posSamples.reduce((s, r) => s + r.covers, 0) / posSamples.length : null,
      forecastRevenue: posSamples.length > 0 ? posSamples.reduce((s, r) => s + r.revenue, 0) / posSamples.length : null,
      forecastQtyByRecipe: qtyByRecipe,
      holiday, // { name, holiday_type } if this date matches hr_holiday_calendar, else null — model does NOT auto-adjust for it
    })
  }
  return results
}

// ── Supabase orchestration ──────────────────────────────────────────────────

export async function runForecast(clientId, horizonDays = 7) {
  const runStartedAt = new Date().toISOString()
  const lookbackStart = new Date()
  lookbackStart.setDate(lookbackStart.getDate() - LOOKBACK_DAYS)

  try {
    const [{ data: orders }, { data: periods }, { data: holidays }] = await Promise.all([
      supabase.from('pos_orders')
        .select('id, covers, closed_at, credit_note_id')
        .eq('client_id', clientId).eq('status', 'billed').eq('close_type', 'paid')
        .gte('closed_at', lookbackStart.toISOString()),
      supabase.from('monthly_periods').select('id, bs_year, bs_month').eq('client_id', clientId),
      supabase.from('hr_holiday_calendar').select('bs_year, bs_month, bs_day, name, holiday_type').eq('client_id', clientId),
    ])
    const orderList = orders || []

    let itemsByOrder = {}
    if (orderList.length > 0) {
      const { data: items } = await supabase.from('pos_order_items')
        .select('order_id, recipe_id, qty, unit_price, vat_rate')
        .in('order_id', orderList.map(o => o.id))
      itemsByOrder = (items || []).reduce((acc, i) => {
        ;(acc[i.order_id] = acc[i.order_id] || []).push(i)
        return acc
      }, {})
    }

    let history = buildDailyHistory(orderList, itemsByOrder, computeOrderAmounts)

    // Fallback to manual sales_entries only if POS history is sparse (new POS client / pre-POS periods)
    if (history.length < LOOKBACK_DAYS / 2) {
      const periodsById = Object.fromEntries((periods || []).map(p => [p.id, p]))
      const periodIds = (periods || []).map(p => p.id)
      if (periodIds.length > 0) {
        const { data: manualEntries } = await supabase.from('sales_entries')
          .select('period_id, recipe_id, bs_day, qty_sold, source')
          .in('period_id', periodIds).eq('source', 'manual')
        history = history.concat(buildManualDailyHistory(manualEntries || [], periodsById))
      }
    }

    const holidaysByKey = Object.fromEntries(
      (holidays || []).map(h => [`${h.bs_year}:${h.bs_month}:${h.bs_day}`, { name: h.name, holiday_type: h.holiday_type }])
    )

    const forecast = forecastByWeekday(history, horizonDays, holidaysByKey)

    // When no pos-basis samples exist for a weekday, forecastRevenue is null even though we
    // may still have a real qty forecast (from manual sales_entries) — estimate revenue from
    // forecasted qty × menu price instead of showing a bare "0", and mark it clearly as such.
    const allRecipeIds = [...new Set(forecast.flatMap(f => Object.keys(f.forecastQtyByRecipe)))]
    let priceByRecipe = {}
    if (allRecipeIds.length > 0) {
      const { data: recs } = await supabase.from('recipes').select('id, selling_price').in('id', allRecipeIds)
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
        client_id: clientId, recipe_id: null,
        bs_year: f.bs.year, bs_month: f.bs.month, bs_day: f.bs.day,
        forecast_covers: f.forecastCovers, forecast_qty: null, forecast_revenue: revenue,
        revenue_estimated: revenueEstimated,
        model_basis: hasPosSignal ? 'pos' : 'manual', horizon_days: horizonDays,
      })
      for (const [recipeId, qty] of Object.entries(f.forecastQtyByRecipe)) {
        rows.push({
          client_id: clientId, recipe_id: recipeId,
          bs_year: f.bs.year, bs_month: f.bs.month, bs_day: f.bs.day,
          forecast_covers: null, forecast_qty: qty, forecast_revenue: null,
          revenue_estimated: false,
          model_basis: hasPosSignal ? 'pos' : 'manual', horizon_days: horizonDays,
        })
      }
    }

    // Clear this client+horizon's previous run before writing the new one — demand_forecast_daily
    // has no natural upsert key (recipe-level rows share a date), so without this, every recompute
    // click stacks duplicate day-rows and loadStored's read-back non-deterministically picks
    // between old and new values instead of always showing the latest run.
    await supabase.from('demand_forecast_daily').delete().eq('client_id', clientId).eq('horizon_days', horizonDays)
    if (rows.length > 0) {
      await supabase.from('demand_forecast_daily').insert(rows)
    }
    await supabase.from('demand_forecast_run_log').insert({
      client_id: clientId, run_at: runStartedAt, method: 'weekday_moving_average',
      rows_written: rows.length, error: null,
    })

    return { forecast, rowsWritten: rows.length }
  } catch (err) {
    await supabase.from('demand_forecast_run_log').insert({
      client_id: clientId, run_at: runStartedAt, method: 'weekday_moving_average',
      rows_written: 0, error: err.message || String(err),
    })
    throw err
  }
}
