// Demand Forecast arithmetic — pure, no Supabase import, so every claim here is testable
// (demandForecastMath.test.js). demandForecastData.js does the reads and writes around it.
//
// The model is a recency-weighted day-of-week average: for each coming day, take the last
// SAMPLES_PER_WEEKDAY historical days that fell on the same weekday, weight the most recent
// heaviest (n, n-1, … 1), and average. Deliberately simple and auditable — an owner can be shown
// exactly which eight Wednesdays produced a number — while still tracking a café that is growing
// or shrinking within a few weeks, which a plain mean could not (S694).
import { bsToAd, adToBs } from './bsCalendar'

export const LOOKBACK_DAYS = 84 // 12 weeks — enough same-weekday samples for the average
export const SAMPLES_PER_WEEKDAY = 8 // cap how many historical same-weekday points feed the average

// A dish forecast under this many per day is "occasional" — listed, but not as a plate to prep.
// 0.5 is where rounding up starts to over-prep more days than it saves: below it, "1" would be
// wrong on most days; at or above it, "1" is right on most days.
export const OCCASIONAL_THRESHOLD = 0.5

const dayKeyOf = date => date.toDateString()
const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate())

// ── History ────────────────────────────────────────────────────────────────

// Collapses raw pos_orders + their items into one row per calendar day: total covers, total
// ex-VAT revenue, and qty sold per recipe. Orders with a credit_note_id are excluded — the same
// rule SalesReport.jsx's dailyRows uses, since a credit-noted bill's revenue correction is posted
// as a new entry on the day it's issued, not retroactively.
//
// Revenue is gross less discount, BEFORE VAT — the figure every other "Revenue" in the product
// means (Owner Dashboard, Sales Entries, the Labor Forecast's learned sales per labour hour).
// It used to be the VAT-inclusive amount payable, with VAT registration hard-coded true, so a
// VAT-registered outlet's forecast ran ~13% above the basis its required hours were divided by.
export function buildDailyHistory(orders, itemsByOrder, computeOrderAmounts) {
  const byDay = {}
  for (const o of orders) {
    if (o.credit_note_id) continue
    const d = new Date(o.closed_at)
    const key = dayKeyOf(d)
    const items = itemsByOrder[o.id] || []
    // Revenue excludes item-level comps (never billed at menu price — see PosOrders.jsx); the
    // qtyByRecipe loop below still counts them, since a comped dish was still prepared/consumed
    // and demand planning cares about that regardless of what it billed for.
    const amounts = computeOrderAmounts(o, items.filter(i => !i.comped), false)
    const row = byDay[key] = byDay[key] || { date: startOfDay(d), weekday: d.getDay(), covers: 0, revenue: 0, qtyByRecipe: {}, basis: 'pos' }
    row.covers += o.covers || 1
    row.revenue += amounts.grossAmt - amounts.discount
    for (const i of items) {
      if (!i.recipe_id) continue
      row.qtyByRecipe[i.recipe_id] = (row.qtyByRecipe[i.recipe_id] || 0) + i.qty
    }
  }
  return Object.values(byDay).sort((a, b) => a.date - b.date)
}

// Merges manual sales_entries history for days NOT already covered by POS history (`coveredKeys`
// is the set of toDateString() keys the POS rows produced). bs_day=0 is a bulk-entry sentinel
// (Sales.js) and MUST be excluded, or a whole month's lump quantity lands on a single fabricated
// "day", corrupting the weekday average. A day present in both sources used to become two samples
// with the day's quantity split between them, halving that day's weight.
export function buildManualDailyHistory(salesEntries, periodsById, coveredKeys = new Set()) {
  const byDay = {}
  for (const e of salesEntries) {
    if (e.bs_day === 0) continue
    const period = periodsById[e.period_id]
    if (!period) continue
    const ad = bsToAd(period.bs_year, period.bs_month, e.bs_day)
    const key = dayKeyOf(ad)
    if (coveredKeys.has(key)) continue
    const row = byDay[key] = byDay[key] || { date: ad, weekday: ad.getDay(), covers: 0, revenue: 0, qtyByRecipe: {}, basis: 'manual' }
    row.qtyByRecipe[e.recipe_id] = (row.qtyByRecipe[e.recipe_id] || 0) + (parseFloat(e.qty_sold) || 0)
    // manual entries carry no covers signal at all — basis:'manual' lets forecastByWeekday exclude
    // these rows from the covers/revenue average instead of silently averaging in a false zero
  }
  return Object.values(byDay)
}

// Which monthly_periods can hold a day inside the lookback window. sales_entries has no date of
// its own, only period + bs_day, so the manual read is bounded by period rather than by date —
// it used to fetch every period the client ever had to use at most eight days per weekday.
export function periodsInLookback(periods, lookbackStart) {
  const start = adToBs(lookbackStart)
  const startKey = start.year * 100 + start.month
  return (periods || []).filter(p => p.bs_year * 100 + p.bs_month >= startKey)
}

// ── Model ──────────────────────────────────────────────────────────────────

// Recency-weighted mean of `values`, which must be ordered most recent first. Weights n…1, so the
// latest of eight samples counts eight times the oldest. n = 0 → null (no signal is not zero).
export function weightedMean(values) {
  const n = values.length
  if (n === 0) return null
  let num = 0, den = 0
  values.forEach((v, idx) => { const w = n - idx; num += w * v; den += w })
  return num / den
}

// One forecast row per coming day. `now` is injectable for tests; the day it falls on is never a
// sample — a recompute at 8 AM used to feed one hour of trade into next week as a whole day.
export function forecastByWeekday(dailyHistory, horizonDays, holidaysByKey = {}, now = new Date()) {
  const todayStart = startOfDay(now)
  const byWeekday = Array.from({ length: 7 }, () => [])
  for (const row of dailyHistory) {
    if (row.date >= todayStart) continue
    byWeekday[row.weekday].push(row)
  }
  for (const rows of byWeekday) rows.sort((a, b) => b.date - a.date) // most recent first

  const results = []
  for (let i = 1; i <= horizonDays; i++) {
    const target = new Date(todayStart)
    target.setDate(todayStart.getDate() + i)
    const weekday = target.getDay()
    const samples = byWeekday[weekday].slice(0, SAMPLES_PER_WEEKDAY)
    const n = samples.length
    const bs = adToBs(target)
    const holidayKey = `${bs.year}:${bs.month}:${bs.day}`
    const holiday = holidaysByKey[holidayKey] || null
    // Nepal holiday footfall swings both directions depending on the specific festival and the
    // business (some restaurants close for Dashain Tika, others get slammed the week after), so
    // the multiplier is owner-set per holiday occurrence in Holiday Calendar rather than guessed
    // here — a holiday with no multiplier configured is still flagged (via `holiday` below) but
    // left unadjusted, same as before.
    const multiplier = holiday && holiday.demand_multiplier != null ? parseFloat(holiday.demand_multiplier) : null

    // Qty averages over every sample (manual-basis rows carry real qty signal, that's their
    // whole purpose); a dish absent from a sample sold zero that day and weighs in as zero.
    // Covers/revenue average ONLY over pos-basis samples — a manual-basis row structurally has
    // covers=revenue=0 (never tracked), so mixing it in would silently average toward a false
    // zero instead of reflecting "no signal available".
    const posSamples = samples.filter(s => s.basis === 'pos')

    const recipeIds = new Set()
    for (const s of samples) for (const id of Object.keys(s.qtyByRecipe)) recipeIds.add(id)
    const qtyByRecipe = {}
    for (const recipeId of recipeIds) {
      const v = weightedMean(samples.map(s => s.qtyByRecipe[recipeId] || 0))
      qtyByRecipe[recipeId] = multiplier != null ? v * multiplier : v
    }

    const rawCovers = weightedMean(posSamples.map(s => s.covers))
    const rawRevenue = weightedMean(posSamples.map(s => s.revenue))

    results.push({
      date: target, bs, weekday,
      sampleCount: n, posSampleCount: posSamples.length,
      forecastCovers: rawCovers != null && multiplier != null ? rawCovers * multiplier : rawCovers,
      forecastRevenue: rawRevenue != null && multiplier != null ? rawRevenue * multiplier : rawRevenue,
      forecastQtyByRecipe: qtyByRecipe,
      holiday, // { name, holiday_type, demand_multiplier } if this date matches hr_holiday_calendar, else null
    })
  }
  return results
}

// ── Presentation ───────────────────────────────────────────────────────────

// Whole plates to prep from a per-day average. 0.8 → 1, 2.8 → 3: the kitchen makes plates, and
// under-prepping a dish that sells on most days costs more than one spare portion.
export function platesOf(qty) {
  return Math.ceil(qty - 1e-9)
}

// Splits a day's [recipeId, qty] pairs into dishes worth prepping and the occasional tail. Both
// halves keep the raw average — the page shows it on hover — and stay sorted highest first.
export function splitDishList(entries) {
  const sorted = [...entries].sort((a, b) => b[1] - a[1])
  const plates = [], occasional = []
  for (const [recipeId, qty] of sorted) {
    if (qty >= OCCASIONAL_THRESHOLD) plates.push({ recipeId, qty, plates: platesOf(qty) })
    else if (qty > 0) occasional.push({ recipeId, qty })
  }
  return { plates, occasional }
}

// Total forecast quantity per recipe across every day of the horizon — the figure the ingredient
// explosion multiplies through.
export function totalQtyByRecipe(forecastDays) {
  const totals = {}
  for (const day of forecastDays) {
    for (const [recipeId, qty] of Object.entries(day.forecastQtyByRecipe || {})) {
      totals[recipeId] = (totals[recipeId] || 0) + qty
    }
  }
  return totals
}

// Raw-item demand for the horizon: Σ over dishes of (forecast dishes × per-portion item qty).
// `explodedByRecipe` is explodeRecipeIngredients()'s output — leaf items only, sub-recipes already
// walked through and yield-adjusted, so no sub-recipe mirror item can appear here.
export function aggregateIngredientDemand(totalsByRecipe, explodedByRecipe) {
  const byItem = {}
  for (const [recipeId, dishes] of Object.entries(totalsByRecipe)) {
    if (!(dishes > 0)) continue
    for (const { item_id, qty } of (explodedByRecipe[recipeId] || [])) {
      byItem[item_id] = (byItem[item_id] || 0) + qty * dishes
    }
  }
  return byItem
}
