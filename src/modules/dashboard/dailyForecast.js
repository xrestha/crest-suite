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
//
// FESTIVALS (S850, owner decisions): every day in the Holiday Calendar, optional ones included, the
// set Demand Forecast uses. Dashain is not evidence about an ordinary week, so a festival day is
// never a sample of a usual weekday, for either metric. On the festival itself:
//   - SALES: a festival with a Demand Multiplier is a usual day × that figure, on the Target line
//     and the forecast alike, and judges the pace against that lowered (or raised) expectation; one
//     with no multiplier is drawn as a usual day and does not judge the pace, so a quiet Dashain
//     week does not pull the forecast down for the rest of Kartik.
//   - PURCHASES: never scaled (a kitchen stocks up before a festival as often as it buys less on
//     it), and no festival day judges their pace either.
// The snapshot keeps the usual week; festivals are applied when the line is drawn, so a multiplier
// set after the Target was captured still shows on its day.
import { bsToAd, daysInBsMonth } from '../../utils/bsCalendar'
import { holidayKey } from '../../utils/demandForecastMath'
import { returnCostValue } from '../ims/reports/supplierAttribution'

// Per kind, because the purchase snapshot changed shape after the sales one (S783: flat daily
// average → per weekday). A stored snapshot of an older model is treated as absent and replaced
// once; bumping one kind never disturbs the other's frozen Target. S850 bumped both (festival days
// left out of the history). Since S849 (DATABASE-8) the database guard (ims_monthly_periods_guard)
// accepts exactly these models, so a bump changes its two literals in the same commit
// (snapshotModelGuard.test.js compares them).
export const SNAPSHOT_MODEL = { sales: 3, purch: 4 }
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

// Net purchases per BS day: `allocatedPurchases` is allocateBillDiscounts() output (lineCost —
// the COST basis, S792 D32), less returns at list value on their line's basis, which is how the
// Net Purchases tile takes them. Read returns with `purchase_entries(vat_inclusive, vat_is_cost)`.
export function dailyPurchaseMap(allocatedPurchases, returns) {
  const net = {}, ret = {}
  ;(allocatedPurchases || []).forEach(p => { net[p.bs_day] = (net[p.bs_day] || 0) + p.lineCost })
  ;(returns || []).forEach(r => { ret[r.bs_day] = (ret[r.bs_day] || 0) + returnCostValue(r) })
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
// holidays: holidaysByKeyOf() output. A festival day stays in the window (it is a day the client
// traded, or chose not to) and is marked, so the bases below can leave it out.
export function historyWindowDays(openYear, openMonth, periods, holidays = {}) {
  const start = bsToAd(openYear, openMonth, 1)
  const days = []
  ;(periods || []).forEach(p => {
    const n = daysInBsMonth(p.bs_year, p.bs_month)
    for (let d = 1; d <= n; d++) {
      const ad = bsToAd(p.bs_year, p.bs_month, d)
      const back = Math.round((start - ad) / DAY_MS)
      if (back < 1 || back > HISTORY_DAYS) continue
      days.push({
        back, dow: ad.getDay(), sales: p.salesMap?.[d] ?? null, purch: p.purchMap?.[d] ?? null,
        holiday: !!holidays?.[holidayKey(p.bs_year, p.bs_month, d)],
      })
    }
  })
  const active = days.filter(x => x.sales != null || x.purch != null)
  if (!active.length) return []
  const earliest = Math.max(...active.map(x => x.back))
  return days.filter(x => x.back <= earliest).sort((a, b) => b.back - a.back)
}

// Average per weekday. A weekday with no samples takes `fallback(dow)`: 0 for sales history (four
// weeks without one Saturday entry means the place is shut on Saturdays), the overall mean
// wherever a weekday simply has not come round yet.
function weekdayAverages(samples, fallback) {
  const fallbackOf = typeof fallback === 'function' ? fallback : () => fallback
  const tot = Array(7).fill(0), cnt = Array(7).fill(0)
  samples.forEach(({ dow, v }) => { tot[dow] += v; cnt[dow]++ })
  return tot.map((t, i) => Math.round(cnt[i] ? t / cnt[i] : fallbackOf(i)))
}

const meanOf = samples => (samples.length ? sum(samples.map(s => s.v)) / samples.length : 0)

// { sales, purch } bases from the history window, each null when history is too thin to judge.
// Purchases take every window day as a sample, a day without a bill at 0. Festival days are not
// samples of either (S850), and "too thin" counts the usual days only.
export function baseFromHistory(days) {
  const all = days || []
  const usual = all.filter(x => !x.holiday)
  const salesDays = usual.filter(x => x.sales != null)
  const salesSamples = salesDays.map(x => ({ dow: x.dow, v: x.sales }))
  // A weekday whose only sales in the window fell on festivals was trading, not shut: it takes the
  // usual-day mean, never the 0 that "no entry at all" means.
  const festivalOnly = new Set(all.filter(x => x.holiday && x.sales != null).map(x => x.dow))
  salesDays.forEach(x => festivalOnly.delete(x.dow))
  const salesMean = meanOf(salesSamples)
  const sales = salesDays.length >= MIN_HISTORY_DAYS
    ? { source: 'history', byWeekday: weekdayAverages(salesSamples, dow => (festivalOnly.has(dow) ? salesMean : 0)), sampleDays: salesDays.length }
    : null
  const purchSamples = usual.map(x => ({ dow: x.dow, v: x.purch || 0 }))
  const purch = purchSamples.length >= MIN_HISTORY_DAYS && all.some(x => x.purch != null)
    ? { source: 'history', byWeekday: weekdayAverages(purchSamples, meanOf(purchSamples)), sampleDays: purchSamples.length }
    : null
  return { sales, purch }
}

// A new client's base from its own open month, once there is a week of it, per weekday.
//   sales: the days WITH an entry.
//   purch: every calendar day up to `elapsed`, a day without a bill counting as zero.
// Finished days only: the caller passes splitAtToday's salesDone / purchElapsed, never today.
// A festival day (`isFestival`) is no sample here either, and does not count toward the week.
export function baseFromMonth({ kind, valueMap, dayNums, elapsed, weekdayOf, isFestival = () => false }) {
  let samples
  if (kind === 'sales') {
    const days = dayNums.filter(d => !isFestival(d))
    if (days.length < MIN_MONTH_DAYS_FOR_TARGET) return null
    samples = days.map(d => ({ dow: weekdayOf(d), v: valueMap[d] }))
  } else {
    const days = Array.from({ length: elapsed || 0 }, (_, i) => i + 1).filter(d => !isFestival(d))
    if (days.length < MIN_MONTH_DAYS_FOR_TARGET) return null
    samples = days.map(d => ({ dow: weekdayOf(d), v: valueMap[d] || 0 }))
  }
  return { source: 'month', byWeekday: weekdayAverages(samples, meanOf(samples)), sampleDays: samples.length }
}

// The open month's festivals, as the chart uses them: { [day]: { name, multiplier } }, where
// multiplier is the Demand Multiplier set in Holiday Calendar, or null when none is set (or it is
// not a usable number). `holidays` is holidaysByKeyOf() output.
export function monthFestivals(holidays, bsYear, bsMonth, monthEndDay) {
  const out = {}
  for (let d = 1; d <= monthEndDay; d++) {
    const h = holidays?.[holidayKey(bsYear, bsMonth, d)]
    if (!h) continue
    const m = h.demand_multiplier == null ? NaN : parseFloat(h.demand_multiplier)
    out[d] = { name: h.name, multiplier: Number.isFinite(m) && m >= 0 ? m : null }
  }
  return out
}

// Day numbers as runs, for a footer that has to fit a festival month: [1,2,3,5,22,23] → "1–3, 5, 22–23".
export function dayRanges(days) {
  const sorted = [...new Set(days)].sort((a, b) => a - b)
  const runs = []
  sorted.forEach(d => {
    const last = runs[runs.length - 1]
    if (last && d === last[1] + 1) last[1] = d
    else runs.push([d, d])
  })
  return runs.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(', ')
}

// What a festival does to each metric's line (see the header): sales scale by the multiplier and
// judge the pace only where one is set; purchases never scale and no festival judges their pace.
export const salesFestivalFactor = festivals => d => festivals?.[d]?.multiplier ?? 1
export const salesFestivalJudged = festivals => d => !(festivals?.[d] && festivals[d].multiplier == null)
export const purchFestivalJudged = festivals => d => !festivals?.[d]

// The day in progress is never a sample (S792 PLANNING-2/3; the rule Demand Forecast has kept since
// S694). POS stamps sales_entries.bs_day with today at every bill close, so from the morning's first
// bill today used to read as a finished day: at 10 a.m. a 30,000-a-day outlet's 2,000 was judged as
// a whole day's trade (day 1: every remaining day forecast 23% low), today's remaining trade was
// never forecast, today was a zero-purchase day until the restock bill was typed, and a new
// client's Target could freeze that 2,000 as the weekday's usual for the whole month.
//
// So only days before `today` are judged, and forecast days start at today at the latest, so today
// is drawn as sold-so-far beside its forecast. `today` null means no day is in progress (a past
// month): nothing is dropped and the forecast starts after the last entry, as before.
//   salesDone:     the days with a sales entry that are over — the pace sample, the Target's days.
//   purchElapsed:  the purchase days that are over, each counting (a day with no bill is a zero).
//   salesFrom / purchFrom: the first forecast day.
export function splitAtToday({ salesDayNums, elapsedDay, today }) {
  const lastSales = salesDayNums.length ? salesDayNums[salesDayNums.length - 1] : 0
  const upTo = from => (today == null ? from : Math.min(from, today))
  return {
    salesDone: today == null ? salesDayNums : salesDayNums.filter(d => d < today),
    purchElapsed: today == null ? elapsedDay : Math.max(0, Math.min(elapsedDay, today - 1)),
    salesFrom: upTo(lastSales + 1),
    purchFrom: upTo(elapsedDay + 1),
  }
}

// The live month-end forecast. `expectDays` are the days this month's pace is judged over (sales:
// days with an entry; purchases: every day up to `elapsed`), and forecast days run from `fromDay`.
// A forecast day that already holds an entry is today, still trading (splitAtToday): it counts in
// the month-end total at the larger of what it has sold and its forecast, never both, because a
// day ends at no less than it has already taken.
// With a base, each future day is its weekday's base × a pace factor that leans toward this
// month as days accrue; without one, it is this month's plain average once MIN_DAYS_FOR_FORECAST
// days exist. Never a slope, so it cannot run to zero; never a ceiling, so it cannot pin to one.
//
// `dayFactor(d)` scales one day's expectation (S784: the rain adjustment, weatherEffect.js). It
// applies to the elapsed days as well as the future ones, so a rainy week already past is judged
// against a rain-lowered expectation and does not drag the pace down, only for the rain to be
// counted a second time on the days ahead. With every factor 1 the arithmetic is unchanged. A
// festival's Demand Multiplier rides the same factor (S850).
//
// `judged(d)` says whether an elapsed day may judge the pace (S850: a festival with no multiplier
// may not, for sales; no festival may, for purchases). A day not judged still counts in the
// month-end total at what it actually took. With every day judged the arithmetic is unchanged; with
// none judged yet, a base is taken at face value.
export function projectMonth({ base, valueMap, expectDays, fromDay, monthEndDay, weekdayOf, dayFactor = () => 1, judged = () => true }) {
  if (expectDays.length === 0) return null
  const paceDays = expectDays.filter(d => judged(d))
  const n = paceDays.length
  const actual = sum(paceDays.map(d => valueMap[d] || 0))
  let perDay, paceFactor = null
  if (base) {
    const expected = sum(paceDays.map(d => base.byWeekday[weekdayOf(d)] * dayFactor(d)))
    const ratio = expected > 0 ? actual / expected : 1
    const w = n / (n + PACE_DAMPING)
    paceFactor = Math.max(0, 1 + w * (ratio - 1))
    perDay = d => base.byWeekday[weekdayOf(d)] * paceFactor * dayFactor(d)
  } else {
    if (n < MIN_DAYS_FOR_FORECAST) return null
    const weight = sum(paceDays.map(d => dayFactor(d)))
    const perNormalDay = weight > 0 ? actual / weight : actual / n
    perDay = d => perNormalDay * dayFactor(d)
  }
  const projDays = {}
  let projSum = 0
  for (let d = fromDay; d <= monthEndDay; d++) {
    const v = Math.round(perDay(d))
    projDays[d] = v
    projSum += valueMap[d] == null ? v : Math.max(v, Number(valueMap[d]))
  }
  const actualBefore = sum(Object.entries(valueMap).filter(([d]) => Number(d) < fromDay).map(([, v]) => Number(v)))
  return { projDays, projectedTotal: Math.round(actualBefore + projSum), paceFactor }
}

// A usual week laid over the month, each day × `dayFactor(d)`: the Target's month total. With no
// factor it is the stored projectedMonthEnd; the sales line passes its festival factor (S850).
export function targetTotal(byWeekday, { monthEndDay, weekdayOf, dayFactor = () => 1 }) {
  let total = 0
  for (let d = 1; d <= monthEndDay; d++) total += byWeekday[weekdayOf(d)] * dayFactor(d)
  return Math.round(total)
}

// The frozen Target, as stored in monthly_periods.sales/purch_projection_snapshot. It holds the
// usual week only; festivals are applied where it is drawn (targetValue, targetTotal).
//
// S849 (DATABASE-8): a weekday below zero is stored as 0. A weekday average goes negative only when
// refunds outweigh that weekday's trade in the sample (a POS credit note posts a NEGATIVE qty_sold;
// a return-only day nets purchases below zero), and four samples per weekday is few enough for one
// big refund to do it. A negative "usual day" is not a target, and the database guard refuses one,
// so without the clamp such a month would be refused on every visit and never get a Target. A NaN
// would serialise as null, which the guard refuses too. The bases stay unclamped.
export function makeSnapshot(kind, base, { monthEndDay, weekdayOf, capturedDay }) {
  const byWeekday = (base.byWeekday || []).map(v => (Number.isFinite(v) && v > 0 ? v : 0))
  return {
    model: SNAPSHOT_MODEL[kind],
    source: base.source,
    byWeekday,
    sampleDays: base.sampleDays,
    capturedDay,
    capturedAt: new Date().toISOString(),
    projectedMonthEnd: targetTotal(byWeekday, { monthEndDay, weekdayOf }),
  }
}

// Who may capture the month's Target: exactly the logins the database guard accepts
// (`ims_caller_has_rank('staff')`: the operator, the Owner, an IMS login of staff rank or above that
// is not a count PIN and is not settlement-blocked). `hasImsAccess('staff')` alone is not the mirror:
// a count PIN's rank is 'staff' and its `ims_email` is what marks it (AuthContext imsCountOnly). A
// till PIN or an HR-only login would be refused with only a console line, on every visit, so it does
// not try (DATABASE-8). Nothing visible changes for them: none of them reaches the chart.
export function canCaptureTarget({ isAdmin, isOwner, hasImsAccess, profile } = {}) {
  if (isAdmin || isOwner) return true
  const staffPlus = typeof hasImsAccess === 'function' && hasImsAccess('staff') === true
  return staffPlus && !profile?.ims_email && !profile?.settlement_blocked_by
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

// The Target on one day: its weekday's usual × `factor` (a sales festival's Demand Multiplier).
export const targetValue = (kind, snap, dow, factor = 1) =>
  (isCurrentSnapshot(kind, snap) ? Math.round(snap.byWeekday[dow] * factor) : null)
