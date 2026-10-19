// Demand Forecast arithmetic — pure, no Supabase import, so every claim here is testable
// (demandForecastMath.test.js). demandForecastData.js does the reads and writes around it.
//
// The model is a recency-weighted day-of-week average: for each coming day, take the last
// SAMPLES_PER_WEEKDAY historical days that fell on the same weekday, weight the most recent
// heaviest (n, n-1, … 1), and average. Deliberately simple and auditable — an owner can be shown
// exactly which eight Wednesdays produced a number — while still tracking a café that is growing
// or shrinking within a few weeks, which a plain mean could not (S694).
import { bsToAd, adToBs } from './bsCalendar'
import { isPosSource } from '../modules/ims/sales/salesDepletion'

export const LOOKBACK_DAYS = 84 // 12 weeks — enough same-weekday samples for the average
export const SAMPLES_PER_WEEKDAY = 8 // cap how many historical same-weekday points feed the average

// A dish forecast under this many per day is "occasional" — listed, but not as a plate to prep.
// 0.5 is where rounding up starts to over-prep more days than it saves: below it, "1" would be
// wrong on most days; at or above it, "1" is right on most days.
export const OCCASIONAL_THRESHOLD = 0.5

const dayKeyOf = date => date.toDateString()
const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate())

// ── History ────────────────────────────────────────────────────────────────

// 'YYYY-MM-DD' (a Nepal calendar date, as the server sends it) → that date at the RUNTIME's local
// midnight (S849, FORECAST-5). getDay() and adToBs() read a Date's local getters, so a Date built
// this way names the same weekday and the same BS day in Kathmandu, Sydney or London. `new
// Date('2026-10-16')` would be UTC midnight, which is the previous evening west of Greenwich.
export function dateOfIso(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''))
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null
}

// The till's history as demand_forecast_history returns it (S849, FORECAST-1/-2/-5): one object
// per Nepal day with a paid bill — bills, covers, revenue, and plates per dish — into the per-day
// rows forecastByWeekday averages. The server does every rule a bill row used to need here:
// revenue is Σ qty × unit_price over the lines that were not comped, less the bill discount, before
// VAT (the Revenue every other screen means, and what the S830 post nets into sales_entries);
// credit-noted bills are left out; comped lines and Complimentary bills add plates, never revenue
// or covers; and a day belongs to Nepal's calendar, never the device's. So nothing here computes
// money — it only reshapes.
export function historyFromDailyTotals(days) {
  const out = []
  for (const d of days || []) {
    const date = dateOfIso(d?.date)
    if (!date) continue
    const qtyByRecipe = {}
    for (const [recipeId, q] of Object.entries(d.qty || {})) {
      const n = Number(q)
      if (Number.isFinite(n) && n !== 0) qtyByRecipe[recipeId] = n
    }
    out.push({
      date, weekday: date.getDay(),
      bills: Number(d.bills) || 0,
      covers: Number(d.covers) || 0,
      revenue: Number(d.revenue) || 0,
      qtyByRecipe, basis: 'pos',
    })
  }
  return out.sort((a, b) => a.date - b.date)
}

// Hand-entered daily Sales Entries merged into the till's history (S849, FORECAST-6). Always, not
// only when the till's history is thin: an outlet that switches its till off is forecast from its
// new hand entries at once, instead of from old bills for six weeks.
//
// The rule is the stock rule (posSupersedesManual), per (day, dish): a hand-entered dish counts
// unless the till sold that dish that day. On a till day without that dish its quantity joins the
// till day — one day, one sample; covers and revenue stay the till's. On a day with no till bill it
// makes a manual-basis day, which forecastByWeekday keeps out of the covers and revenue average (a
// manual day carries no covers signal, which is not the same as zero covers).
//
// bs_day 0 is a Bulk monthly total (Sales.js): it has no day, so it is never a sample — a whole
// month's lump on one fabricated day would wreck that weekday. Those rows are counted
// (`undatedRows`) so the page can say why a weekday has no samples. `from` / `today` are the
// server's window (local-midnight Dates from dateOfIso): a row outside [from, today) drops.
export function mergeManualHistory(tillHistory, entries, periodsById, { from = null, today = null } = {}) {
  const byKey = new Map()
  const tillDishes = new Map() // day → the dishes the till sold that day
  for (const t of tillHistory || []) {
    const key = dayKeyOf(t.date)
    byKey.set(key, t)
    tillDishes.set(key, new Set(Object.keys(t.qtyByRecipe || {})))
  }
  const cloned = new Set() // till days copied before a manual quantity is added, so the input is never changed
  const manualKeys = new Set()
  let undatedRows = 0
  for (const e of entries || []) {
    const period = periodsById?.[e.period_id]
    if (!period) continue
    const day = Number(e.bs_day) || 0
    if (day <= 0) { undatedRows += 1; continue }
    const ad = bsToAd(period.bs_year, period.bs_month, day)
    if (!ad || (from && ad < from) || (today && ad >= today)) continue
    const qty = parseFloat(e.qty_sold) || 0
    if (!e.recipe_id || qty === 0) continue
    const key = dayKeyOf(ad)
    let row = byKey.get(key)
    if (tillDishes.has(key)) {
      // The till sold this dish this day: the till's figure stands (the stock rule).
      if (tillDishes.get(key).has(e.recipe_id)) continue
      if (!cloned.has(key)) {
        row = { ...row, qtyByRecipe: { ...row.qtyByRecipe } }
        byKey.set(key, row)
        cloned.add(key)
      }
    } else if (!row) {
      row = { date: ad, weekday: ad.getDay(), covers: 0, revenue: 0, qtyByRecipe: {}, basis: 'manual' }
      byKey.set(key, row)
      manualKeys.add(key)
    }
    row.qtyByRecipe[e.recipe_id] = (row.qtyByRecipe[e.recipe_id] || 0) + qty
  }
  const history = [...byKey.values()].sort((a, b) => a.date - b.date)
  return { history, manualDays: manualKeys.size, undatedRows }
}

// Which monthly_periods can hold a day inside the lookback window. sales_entries has no date of
// its own, only period + bs_day, so the manual read is bounded by period rather than by date —
// it used to fetch every period the client ever had to use at most eight days per weekday.
// `lookbackEnd` (optional) drops periods that start after the window, for a window in the past.
export function periodsInLookback(periods, lookbackStart, lookbackEnd = null) {
  const start = adToBs(lookbackStart)
  const startKey = start.year * 100 + start.month
  const end = lookbackEnd ? adToBs(lookbackEnd) : null
  const endKey = end ? end.year * 100 + end.month : Infinity
  return (periods || []).filter(p => {
    const k = p.bs_year * 100 + p.bs_month
    return k >= startKey && k <= endKey
  })
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

// ── Holidays ───────────────────────────────────────────────────────────────

export const holidayKey = (y, m, d) => `${y}:${m}:${d}`

// Holiday Calendar rows → one entry per BS date. Several dates carry two holidays (Krishna
// Janmashtami and Gaura Parva on one day, Bhai Tika and Falgunanda Jayanti on another), and keeping
// whichever row arrived last let a multiplier set on one of them silently vanish. The row that
// carries a multiplier wins, then a public holiday over an optional one (S748). Shared by Demand
// Forecast and the dashboard's Daily Purchases vs Sales chart (S850), so the two agree on which
// festival a day is and what it does to trade.
export function holidaysByKeyOf(rows) {
  const byKey = {}
  const rank = x => (x.demand_multiplier != null ? 2 : 0) + (x.holiday_type === 'public' ? 1 : 0)
  for (const h of rows || []) {
    const key = holidayKey(h.bs_year, h.bs_month, h.bs_day)
    const next = { name: h.name, holiday_type: h.holiday_type, demand_multiplier: h.demand_multiplier }
    const prev = byKey[key]
    if (!prev || rank(next) > rank(prev)) byKey[key] = next
  }
  return byKey
}

// One forecast row per coming day. `now` is injectable for tests; the day it falls on is never a
// sample — a recompute at 8 AM used to feed one hour of trade into next week as a whole day.
//
// A PAST holiday is never a sample either (S756, D21 — decided with Aashish). `holidaysByKey` is the
// Holiday Calendar the forecast already reads for future multipliers, and it covers past dates too.
// A Dashain Tika Wednesday that sold three times the usual (or closed and sold nothing) is not
// evidence about an ordinary Wednesday; averaged in, it inflated or flattened the next eight weeks
// of that weekday, and the multiplier on the holiday itself then counted the festival twice. The
// next-most-recent ordinary day of that weekday takes its place.
//
// `now` is the server's Nepal date since S849 (FORECAST-5), handed in by runForecast as a
// local-midnight Date, so the horizon starts at Nepal's tomorrow whatever the device's clock says.
//
// `sampleFactorOf(sample)` (S849, FORECAST-4) is the rain factor of one sample day: the Owner's
// rainy-day % / 100 on a recorded rainy day, else 1. With it, each day also carries
// `sampleRainFactor` — the recency-weighted mean of its samples' factors, with the SAME weights as
// the quantity average, so it is exactly the share of rain inside that average — and
// `rainySampleCount` (samples whose factor is not 1). The buying list divides by the first, so a
// rainy day ahead is bought at the Owner's % of a DRY day rather than of a wet fortnight's average.
// The averages themselves are unchanged: the dish table and the Roster show what was observed.
// No sampler: both fields are null (no rain setting, or no weather when the forecast ran).
export function forecastByWeekday(dailyHistory, horizonDays, holidaysByKey = {}, now = new Date(), { sampleFactorOf = null } = {}) {
  const todayStart = startOfDay(now)
  const byWeekday = Array.from({ length: 7 }, () => [])
  const hasHolidays = Object.keys(holidaysByKey || {}).length > 0
  for (const row of dailyHistory) {
    if (row.date >= todayStart) continue
    if (hasHolidays) {
      const bs = adToBs(row.date)
      if (holidaysByKey[`${bs.year}:${bs.month}:${bs.day}`]) continue
    }
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

    let sampleRainFactor = null, rainySampleCount = null
    if (typeof sampleFactorOf === 'function') {
      const factors = samples.map(s => {
        const f = Number(sampleFactorOf(s))
        return Number.isFinite(f) && f > 0 ? f : 1
      })
      sampleRainFactor = weightedMean(factors)
      rainySampleCount = factors.filter(f => f !== 1).length
    }

    results.push({
      date: target, bs, weekday,
      sampleCount: n, posSampleCount: posSamples.length,
      sampleRainFactor, rainySampleCount,
      forecastCovers: rawCovers != null && multiplier != null ? rawCovers * multiplier : rawCovers,
      forecastRevenue: rawRevenue != null && multiplier != null ? rawRevenue * multiplier : rawRevenue,
      forecastQtyByRecipe: qtyByRecipe,
      holiday, // { name, holiday_type, demand_multiplier } if this date matches hr_holiday_calendar, else null
    })
  }
  return results
}

// Is there anything at all behind this forecast (S849, FORECAST-1)? A run whose every day has no
// sample learned from nothing, and writing it would replace a good forecast with an empty one —
// which is what an IMS supervisor's Recompute did while the till read came back empty under RLS.
export function hasForecastEvidence(forecast) {
  return (forecast || []).some(f => (f.sampleCount || 0) > 0)
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

// Two per-item demand maps summed (S849, FORECAST-3): the recipes' half and the guests' choices'.
export function addDemand(a, b) {
  const out = { ...(a || {}) }
  for (const [id, q] of Object.entries(b || {})) out[id] = (out[id] || 0) + q
  return out
}

// The guests' usual choices on each dish, per plate (S849, FORECAST-3, owner decision SU13 a).
// A Crest Customization sale stores its choices' stock lines on the sales row as signed per-plate
// deltas (`ingredient_deltas`, already scaled by size — S760); a till plate with no choice carries
// none. So the average per plate is Σ (deltas × plates) ÷ Σ plates over EVERY till plate of the
// dish, a plate with no choice counting as none — 40 of 60 bowls with +30 g banana is 20 g a plate.
//
// Only till rows count (`isPosSource`: 'pos' and 'pos_comp' — the one definition of "a till sale"),
// sold (qty_sold > 0), and dated (bs_day > 0) inside [from, to): a hand-entered row has no choices,
// a credit row is not a plate, and a Bulk row has no day. Lines stay in the shape they were stored
// in — `{ item_id, qty }` or `{ sub_recipe_id, qty }` — and keep their sign ("no onion" is minus),
// so the page runs them through the one conversion (orderLineIngredients' deltaItems), exactly as
// stock does. Returns { recipeId: [{ item_id | sub_recipe_id, qty }] }; a dish with no choice
// lines at all is absent.
export function averageChoicesPerPlate(rows, { periodsById = {}, from = null, to = null } = {}) {
  const plates = {}
  const sums = {}
  for (const r of rows || []) {
    if (!isPosSource(r.source) || !r.recipe_id) continue
    const n = Number(r.qty_sold) || 0
    const day = Number(r.bs_day) || 0
    if (!(n > 0) || day <= 0) continue
    const period = periodsById[r.period_id]
    if (!period) continue
    const ad = bsToAd(period.bs_year, period.bs_month, day)
    if (!ad || (from && ad < from) || (to && ad >= to)) continue
    plates[r.recipe_id] = (plates[r.recipe_id] || 0) + n
    for (const d of r.ingredient_deltas || []) {
      const q = Number(d?.qty) || 0
      if (!q) continue
      const key = d.item_id ? `i:${d.item_id}` : d.sub_recipe_id ? `s:${d.sub_recipe_id}` : null
      if (!key) continue
      const bucket = sums[r.recipe_id] || (sums[r.recipe_id] = {})
      bucket[key] = (bucket[key] || 0) + q * n
    }
  }
  const out = {}
  for (const [recipeId, bucket] of Object.entries(sums)) {
    const p = plates[recipeId]
    const lines = Object.entries(bucket)
      .map(([key, total]) => {
        const id = key.slice(2)
        return key.startsWith('i:') ? { item_id: id, qty: total / p } : { sub_recipe_id: id, qty: total / p }
      })
      .filter(l => Math.abs(l.qty) > 1e-12)
    if (lines.length) out[recipeId] = lines
  }
  return out
}

// What to buy for the horizon: forecast use, what is in store, and the difference (S756, D21).
//
// `onHandById` comes from `buildStockRows()` (stockReportCalc.js) — the one on-hand calculation,
// never a local copy. Pass null when that read could not run: every row then carries
// `inStore: null, toBuy: null`, because "we could not look at the shelf" must not read as "the shelf
// is empty, buy all of it". An item the stock read has no row for is 0 in store — buildStockRows
// returns a row for every item it is handed, so an absent one genuinely has nothing recorded.
// To buy never goes negative: surplus stock is not a purchase.
//
// Safety stock (S800, owner decision): `parById` is each item's par level — the minimum the owner
// wants left on the shelf — and the list buys enough to cover the forecast AND keep it, so the days
// ahead do not end on an empty shelf. No par (or null) is 0, which is the list as it was.
//
// Use is never below zero (S849, FORECAST-3): the guests' choices are signed, and an item whose
// "no onion" average outweighs the recipes' onion would otherwise make a purchase negative.
export function ingredientBuyList(demandByItem, onHandById, parById = null) {
  const known = onHandById != null
  return Object.entries(demandByItem || {}).map(([id, rawUse]) => {
    const use = rawUse > 0 ? rawUse : 0
    const par = parById ? Math.max(0, Number(parById[id]) || 0) : 0
    if (!known) return { id, use, par, inStore: null, toBuy: null }
    const inStore = Math.max(0, Number(onHandById[id]) || 0)
    const gap = use + par - inStore
    return { id, use, par, inStore, toBuy: gap > 1e-9 ? gap : 0 }
  })
}

// Rainy days (S800, owner decision): each forecast day's dishes scaled by `factorOfDay(day)` — the
// Owner's rain percentage on a day with rain forecast, 1 otherwise (rainFactorForMonth decides
// which, the rule the dashboard's sales forecast uses). A scaled day carries `rainFactor` so the
// page can say which days it lowered. Days at 1 are returned as they were. Since S849 (FORECAST-4)
// the page's factor is that rain % ÷ the day's stored `sampleRainFactor`, so the rain already
// inside the weekday average is not counted a second time.
export function scaleForecastDays(days, factorOfDay) {
  return (days || []).map(d => {
    const f = factorOfDay(d)
    if (!(f > 0) || f === 1) return d
    const scaled = {}
    for (const [id, q] of Object.entries(d.forecastQtyByRecipe || {})) scaled[id] = q * f
    return { ...d, forecastQtyByRecipe: scaled, rainFactor: f }
  })
}

// Who each item is usually bought from (S800): the vendor on its most recent purchase line that
// names one. Items carry no supplier of their own — a supplier exists in Crest only on a purchase
// line — so "most recent" is ordered by the period (`periodRankById`, higher = later), then the
// day, then when the line was written. An item never bought with a vendor is absent.
export function usualSupplierByItem(entries, periodRankById) {
  const best = {}
  const later = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
  for (const e of entries || []) {
    if (!e.item_id || !e.vendor_id) continue
    const key = [periodRankById?.[e.period_id] ?? -1, Number(e.bs_day) || 0, Date.parse(e.created_at) || 0]
    const cur = best[e.item_id]
    if (!cur || later(key, cur.key) > 0) best[e.item_id] = { key, vendorId: e.vendor_id }
  }
  return Object.fromEntries(Object.entries(best).map(([id, v]) => [id, v.vendorId]))
}
