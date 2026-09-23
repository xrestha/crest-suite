// Month-end forecast and frozen Target for the Daily Purchases vs Sales chart (S780).
//
// Replaces a least-squares line through the open month's first five days, extended to month end.
// On CASA ACAI CAFE, Ashwin 2083, a Saturday on day 3 and a quiet Monday on day 5 made that line
// point downhill, so the frozen Target reached zero on day 14 and read NPR 92,144 for a month
// that had sold 73,846 by day 6. The live forecast swung 92,144 → 4,33,926 on one good day, and its
// 1.25 × best-day ceiling became the forecast for every remaining purchase day (NPR 2,40,207
// purchases against 92,144 sales). This module has no slope and no ceiling:
//
//   - The BASE is an expected value per weekday, from the 28 days before the month began (4 of
//     each weekday). A new client with too little history gets one from its own first week.
//   - The TARGET is that base, frozen once on the period row. It is the same whichever day it is
//     captured on, because the window ends at day 1, not today.
//   - The live FORECAST is the base scaled by how this month is running against it, weighted
//     n / (n + 3) toward this month, so a real change in trade shows within a week.
//
// Both metrics are shaped by weekday, each by its OWN week: sales peak when the dining room is
// full, purchases on the restock day (CASA: Saturday sells most and buys least, Sunday buys five
// times a Monday). They differ on one point: a day with no sales ENTRY is unknown (closed, or not
// yet entered), but a day with no purchase is a real zero, because a kitchen buys on some days
// and not others. So a purchase weekday is averaged over every such day in the window, never only
// over the days a bill landed.
import { bsToAd, daysInBsMonth } from '../../utils/bsCalendar'

// Per kind, because the purchase snapshot changed shape after the sales one (S783: flat daily
// average → per weekday). A stored snapshot of an older model is treated as absent and replaced
// once; bumping one kind never disturbs the other's frozen Target.
export const SNAPSHOT_MODEL = { sales: 2, purch: 3 }
export const HISTORY_DAYS = 28
export const MIN_HISTORY_DAYS = 14
export const MIN_MONTH_DAYS_FOR_TARGET = 7
export const MIN_DAYS_FOR_FORECAST = 3
const PACE_DAMPING = 3
const DAY_MS = 86400000

const sum = xs => xs.reduce((s, v) => s + v, 0)

// Revenue per BS day, comps excluded: the one definition the open month and its history share.
// Bulk entries (bs_day 0) have no day and are skipped. unit_price captured on the row wins over
// the recipe's current price, as for the Revenue tile.
export function dailySalesMap(salesRows, currentPriceMap) {
  const map = {}
  ;(salesRows || []).forEach(s => {
    if (s.source === 'pos_comp') return
    const d = parseInt(s.bs_day)
    if (!d || d <= 0) return
    const price = s.unit_price != null ? parseFloat(s.unit_price) : (currentPriceMap[s.recipe_id] || 0)
    map[d] = (map[d] || 0) + parseFloat(s.qty_sold || 0) * price - (parseFloat(s.discount) || 0)
  })
  Object.keys(map).forEach(d => { map[d] = Math.round(map[d]) })
  return map
}

// Net purchases per BS day: `allocatedPurchases` is allocateBillDiscounts() output (lineNet),
// less returns at list value, which is how the Net Purchases tile takes them.
export function dailyPurchaseMap(allocatedPurchases, returns) {
  const net = {}, ret = {}
  ;(allocatedPurchases || []).forEach(p => { net[p.bs_day] = (net[p.bs_day] || 0) + p.lineNet })
  ;(returns || []).forEach(r => { ret[r.bs_day] = (ret[r.bs_day] || 0) + parseFloat(r.qty || 0) * parseFloat(r.rate || 0) })
  const map = {}
  new Set([...Object.keys(net), ...Object.keys(ret)]).forEach(d => {
    map[d] = Math.round((net[d] || 0) - (ret[d] || 0))
  })
  return map
}

// The history window's days, oldest first: every day in the HISTORY_DAYS before day 1 of the open
// month that falls inside a period the client actually has. A skipped month shortens the window
// rather than shifting it. Coverage starts at the first day holding any entry, so a period row
// minted before anyone used the app does not read as a run of zero days.
//
// periods: [{ bs_year, bs_month, salesMap, purchMap }] — the maps as built by the two helpers above.
export function historyWindowDays(openYear, openMonth, periods) {
  const start = bsToAd(openYear, openMonth, 1)
  const days = []
  ;(periods || []).forEach(p => {
    const n = daysInBsMonth(p.bs_year, p.bs_month)
    for (let d = 1; d <= n; d++) {
      const ad = bsToAd(p.bs_year, p.bs_month, d)
      const back = Math.round((start - ad) / DAY_MS)
      if (back < 1 || back > HISTORY_DAYS) continue
      days.push({ back, dow: ad.getDay(), sales: p.salesMap?.[d] ?? null, purch: p.purchMap?.[d] ?? null })
    }
  })
  const active = days.filter(x => x.sales != null || x.purch != null)
  if (!active.length) return []
  const earliest = Math.max(...active.map(x => x.back))
  return days.filter(x => x.back <= earliest).sort((a, b) => b.back - a.back)
}

// Average per weekday. A weekday with no samples takes `fallback`: 0 for sales history (four
// weeks without one Saturday entry means the place is shut on Saturdays), the overall mean
// wherever a weekday simply has not come round yet.
function weekdayAverages(samples, fallback) {
  const tot = Array(7).fill(0), cnt = Array(7).fill(0)
  samples.forEach(({ dow, v }) => { tot[dow] += v; cnt[dow]++ })
  return tot.map((t, i) => Math.round(cnt[i] ? t / cnt[i] : fallback))
}

const meanOf = samples => (samples.length ? sum(samples.map(s => s.v)) / samples.length : 0)

// { sales, purch } bases from the history window, each null when history is too thin to judge.
// Purchases take every window day as a sample, a day without a bill at 0.
export function baseFromHistory(days) {
  const salesDays = (days || []).filter(x => x.sales != null)
  const sales = salesDays.length >= MIN_HISTORY_DAYS
    ? { source: 'history', byWeekday: weekdayAverages(salesDays.map(x => ({ dow: x.dow, v: x.sales })), 0), sampleDays: salesDays.length }
    : null
  const purchSamples = (days || []).map(x => ({ dow: x.dow, v: x.purch || 0 }))
  const purch = purchSamples.length >= MIN_HISTORY_DAYS && days.some(x => x.purch != null)
    ? { source: 'history', byWeekday: weekdayAverages(purchSamples, meanOf(purchSamples)), sampleDays: purchSamples.length }
    : null
  return { sales, purch }
}

// A new client's base from its own open month, once there is a week of it, per weekday.
//   sales: the days WITH an entry.
//   purch: every calendar day up to `elapsed`, a day without a bill counting as zero.
export function baseFromMonth({ kind, valueMap, dayNums, elapsed, weekdayOf }) {
  let samples
  if (kind === 'sales') {
    if (dayNums.length < MIN_MONTH_DAYS_FOR_TARGET) return null
    samples = dayNums.map(d => ({ dow: weekdayOf(d), v: valueMap[d] }))
  } else {
    if (!elapsed || elapsed < MIN_MONTH_DAYS_FOR_TARGET) return null
    samples = Array.from({ length: elapsed }, (_, i) => ({ dow: weekdayOf(i + 1), v: valueMap[i + 1] || 0 }))
  }
  return { source: 'month', byWeekday: weekdayAverages(samples, meanOf(samples)), sampleDays: samples.length }
}

// The live month-end forecast. `expectDays` are the days this month's pace is judged over (sales:
// days with an entry; purchases: every day up to `elapsed`), and forecast days run from `fromDay`.
// With a base, each future day is its weekday's base × a pace factor that leans toward this
// month as days accrue; without one, it is this month's plain average once MIN_DAYS_FOR_FORECAST
// days exist. Never a slope, so it cannot run to zero; never a ceiling, so it cannot pin to one.
//
// `dayFactor(d)` scales one day's expectation (S784: the rain adjustment, weatherEffect.js). It
// applies to the elapsed days as well as the future ones, so a rainy week already past is judged
// against a rain-lowered expectation and does not drag the pace down, only for the rain to be
// counted a second time on the days ahead. With every factor 1 the arithmetic is unchanged.
export function projectMonth({ base, valueMap, expectDays, fromDay, monthEndDay, weekdayOf, dayFactor = () => 1 }) {
  const n = expectDays.length
  if (n === 0) return null
  const actual = sum(expectDays.map(d => valueMap[d] || 0))
  let perDay, paceFactor = null
  if (base) {
    const expected = sum(expectDays.map(d => base.byWeekday[weekdayOf(d)] * dayFactor(d)))
    const ratio = expected > 0 ? actual / expected : 1
    const w = n / (n + PACE_DAMPING)
    paceFactor = Math.max(0, 1 + w * (ratio - 1))
    perDay = d => base.byWeekday[weekdayOf(d)] * paceFactor * dayFactor(d)
  } else {
    if (n < MIN_DAYS_FOR_FORECAST) return null
    const weight = sum(expectDays.map(d => dayFactor(d)))
    const perNormalDay = weight > 0 ? actual / weight : actual / n
    perDay = d => perNormalDay * dayFactor(d)
  }
  const projDays = {}
  let projSum = 0
  for (let d = fromDay; d <= monthEndDay; d++) {
    const v = Math.round(perDay(d))
    projDays[d] = v; projSum += v
  }
  const monthActual = sum(Object.values(valueMap).map(Number))
  return { projDays, projectedTotal: Math.round(monthActual + projSum), paceFactor }
}

// The frozen Target, as stored in monthly_periods.sales/purch_projection_snapshot.
export function makeSnapshot(kind, base, { monthEndDay, weekdayOf, capturedDay }) {
  let total = 0
  for (let d = 1; d <= monthEndDay; d++) total += base.byWeekday[weekdayOf(d)]
  return {
    model: SNAPSHOT_MODEL[kind],
    source: base.source,
    byWeekday: base.byWeekday,
    sampleDays: base.sampleDays,
    capturedDay,
    capturedAt: new Date().toISOString(),
    projectedMonthEnd: Math.round(total),
  }
}

// A snapshot of an older model (a pre-S780 slope fit, or S780's flat purchase line) is treated as
// absent, so it gets recaptured once.
export const isCurrentSnapshot = (kind, snap) =>
  !!snap && snap.model === SNAPSHOT_MODEL[kind] && Array.isArray(snap.byWeekday) && snap.byWeekday.length === 7

// The PostgREST `or` filter that lets exactly that recapture through: an empty column, or one
// holding an older model. The `is.null` arm is load-bearing, not tidiness: a `neq` alone drops
// every row whose value is NULL, which is the pre-S780 rows and the never-captured ones.
export const staleSnapshotFilter = (kind, column) =>
  `${column}->>model.is.null,${column}->>model.neq.${SNAPSHOT_MODEL[kind]}`

export const targetValue = (kind, snap, dow) => (isCurrentSnapshot(kind, snap) ? snap.byWeekday[dow] : null)
