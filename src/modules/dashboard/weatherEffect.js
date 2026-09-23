// The rain adjustment for the Daily Purchases vs Sales chart's live SALES forecast (S784).
//
// The Owner says what a rainy day does to their trade ("a rainy day sells about 85% of a normal
// day", settings.rain_sales_pct). On a day the weather forecast calls rainy, the forecast for that
// day is scaled by it — for the next WEATHER_HORIZON_DAYS only, because a forecast further out is
// not worth steering by. It scales the days of this month already gone too, from the weather
// recorded for them, so the pace factor is not dragged down by a rainy week and then the rain
// counted again on the days ahead (dailyForecast.js projectMonth's `dayFactor`). The pace feeds
// every remaining day, so a rainy day already gone moves the whole rest of the month a little:
// the horizon limits which days are SCALED, not how far the line moves.
//
// The app also MEASURES the effect from the outlet's own sales and shows it beside the Owner's
// figure. It never applies it: a figure learned from a handful of rainy days is a hint, and the
// Owner decides.
//
// Purchases are never adjusted: a kitchen buys on its restock days whatever the weather. The frozen
// Target is never adjusted either; it is a target precisely because it does not follow anything.
//
// "Rainy" is RAIN_MM or more between 05:45 and 23:45 Nepal time (the weather-forecast Edge
// Function sums only that window: monsoon rain that falls overnight keeps nobody away from
// dinner). Only COMPLETE days count: a row written by a fetch made after the day began covers part
// of it, and a part-day total undercounts the rain.
import { bsToAd, formatAd } from '../../utils/bsCalendar'

export const RAIN_MM = 5
export const WEATHER_HORIZON_DAYS = 7
export const MIN_MEASURE_DAYS = 5
export const RAIN_PCT_MIN = 30
export const RAIN_PCT_MAX = 150

const mean = xs => xs.reduce((s, v) => s + v, 0) / xs.length

// 'YYYY-MM-DD' → a UTC day number, so a difference is whole days whatever the viewer's timezone.
function dayNumber(iso) {
  const [y, m, d] = String(iso).split('-').map(Number)
  return Math.round(Date.UTC(y, m - 1, d) / 86400000)
}
const isoOfDayNumber = n => new Date(n * 86400000).toISOString().slice(0, 10)

// A day from today on is steered by only while it is within WEATHER_HORIZON_DAYS of when the
// forecast was MADE, not of today: a forecast last fetched four days ago is an eleven-day forecast
// by the end of the week. No fetch date means no forecast worth steering by.
const withinForecastReach = (dayNo, forecastAd) =>
  !!forecastAd && dayNo - dayNumber(forecastAd) <= WEATHER_HORIZON_DAYS

// The AD date of BS day `d`, as 'YYYY-MM-DD'. formatAd, never toISOString: bsToAd is local
// midnight, which UTC+05:45 turns into the previous day.
export const adDateOf = (bsYear, bsMonth, d) => formatAd(bsToAd(bsYear, bsMonth, d))

// The AD date `back` days before day 1 of a BS month (historyWindowDays' `back`).
export function adDateBack(bsYear, bsMonth, back) {
  const s = bsToAd(bsYear, bsMonth, 1)
  return formatAd(new Date(s.getFullYear(), s.getMonth(), s.getDate() - back))
}

const numOrNull = v => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// The Edge Function's rows, keyed by date. The four S785 figures are null on a row written before
// the function kept them, and on a day MET gave no instant for; the strip shows a dash, never 0°.
export function weatherIndex(days) {
  const map = {}
  ;(days || []).forEach(r => {
    if (r && r.date) map[r.date] = {
      precip_mm: Number(r.precip_mm) || 0,
      complete: !!r.complete,
      temp_max: numOrNull(r.temp_max),
      temp_min: numOrNull(r.temp_min),
      cloud_pct: numOrNull(r.cloud_pct),
      thunder: r.thunder === null || r.thunder === undefined ? null : !!r.thunder,
    }
  })
  return map
}

// ── The Dashboard header's weather strip (S785) ──────────────────────────────────────────────

export const LIGHT_RAIN_MM = 1
export const HEAVY_RAIN_MM = 20
export const STRIP_DAYS = 4

// The picture and the plain word for one day. The rain words start where the forecast does:
// "Rain" begins at RAIN_MM, so a day the sales forecast scales reads Rain, Heavy rain or
// Storms, never Light rain or a dry word. Below LIGHT_RAIN_MM the sky decides; a row with
// no cloud figure (written before S785) says "Dry" rather than guessing sun or cloud.
export function weatherLook(w) {
  if (!w) return null
  const mm = Number(w.precip_mm) || 0
  if (w.thunder) return { kind: 'thunder', word: 'Storms' }
  if (mm >= HEAVY_RAIN_MM) return { kind: 'heavy_rain', word: 'Heavy rain' }
  if (mm >= RAIN_MM) return { kind: 'rain', word: 'Rain' }
  if (mm >= LIGHT_RAIN_MM) return { kind: 'light_rain', word: 'Light rain' }
  if (w.cloud_pct === null || w.cloud_pct === undefined) return { kind: 'dry', word: 'Dry' }
  if (w.cloud_pct >= 70) return { kind: 'cloudy', word: 'Cloudy' }
  if (w.cloud_pct >= 30) return { kind: 'partly', word: 'Partly cloudy' }
  return { kind: 'clear', word: 'Sunny' }
}

// `n` consecutive 'YYYY-MM-DD' dates from `todayAd`, by UTC day arithmetic so no timezone moves them.
export function datesFrom(todayAd, n) {
  if (!todayAd) return []
  const today = dayNumber(todayAd)
  return Array.from({ length: n }, (_, i) => isoOfDayNumber(today + i))
}

// Whether the strip has anything to show: a forecast row for at least one of ITS days. The reply
// also carries 60 days of past rows (the measured effect reads them), so "any row" would call a
// long outage ready and draw four "No forecast" days instead of saying the weather is unavailable.
export const stripHasForecast = (weatherByAd, todayAd) =>
  !!weatherByAd && datesFrom(todayAd, STRIP_DAYS).some(d => !!weatherByAd[d])

export const isRainyDay = w => !!w && w.complete && Number(w.precip_mm) >= RAIN_MM

// The stored percentage as a number, or null for "no adjustment".
export function rainPctValue(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isInteger(n) && n >= RAIN_PCT_MIN && n <= RAIN_PCT_MAX ? n : null
}

// The Settings box. A blank box is allowed (no adjustment); 0 is refused rather than read as
// "unset", which settings-row.md's `|| default` rule is about. Plain digits only: the save parses
// with parseInt, which reads "0.85e2" as 0 where Number() reads 85, so the two must never be asked
// about anything but digits.
export function validateRainPct(v) {
  if (v === null || v === undefined || String(v).trim() === '') return null
  const s = String(v).trim()
  if (!/^\d+$/.test(s)) return 'Enter a whole number, like 85.'
  const n = Number(s)
  if (n < RAIN_PCT_MIN || n > RAIN_PCT_MAX) return `Enter a number from ${RAIN_PCT_MIN} to ${RAIN_PCT_MAX}, or leave it blank for no adjustment.`
  return null
}

// The per-day factor for one BS month, or null when there is nothing to apply (no percentage, or
// no rainy day in reach). `byDay[d]` = { mm, factor, ahead } for each adjusted day, ahead < 0 for a
// day already gone. A day from today on is adjusted only within WEATHER_HORIZON_DAYS of today AND
// of `forecastAd`, the Nepal date the forecast was fetched (withinForecastReach).
export function rainFactorForMonth({ rainPct, weatherByAd, todayAd, forecastAd, bsYear, bsMonth, monthEndDay }) {
  const pct = rainPctValue(rainPct)
  if (pct == null || !weatherByAd || !todayAd) return null
  const today = dayNumber(todayAd)
  const byDay = {}
  for (let d = 1; d <= monthEndDay; d++) {
    const ad = adDateOf(bsYear, bsMonth, d)
    const ahead = dayNumber(ad) - today
    if (ahead > WEATHER_HORIZON_DAYS) continue
    if (ahead >= 0 && !withinForecastReach(dayNumber(ad), forecastAd)) continue
    const w = weatherByAd[ad]
    if (!isRainyDay(w)) continue
    byDay[d] = { mm: Number(w.precip_mm), factor: pct / 100, ahead }
  }
  if (!Object.keys(byDay).length) return null
  return { pct, byDay, factorOf: d => (byDay[d] ? byDay[d].factor : 1) }
}

// The rainy days from today to WEATHER_HORIZON_DAYS ahead, whichever month they fall in, and
// `through`: how many days ahead the forecast reaches without a gap (-1 when not even today). The
// footer's "no rain forecast" line is a claim about the days ahead, not about this month's
// projection, and must not be made about days the forecast does not cover.
export function rainAhead({ weatherByAd, todayAd, forecastAd }) {
  if (!weatherByAd || !todayAd) return null
  const today = dayNumber(todayAd)
  const rainy = []
  let through = -1
  for (let ahead = 0; ahead <= WEATHER_HORIZON_DAYS; ahead++) {
    const iso = isoOfDayNumber(today + ahead)
    const w = weatherByAd[iso]
    if (!w || !withinForecastReach(today + ahead, forecastAd)) break
    through = ahead
    if (isRainyDay(w)) rainy.push(iso)
  }
  return { rainy, through }
}

// The outlet's own rainy-day effect: over days with a sales entry and a complete weather record,
// each day's sales as a share of its weekday's usual, averaged on rainy days and on dry days.
// `pct` is null until there are MIN_MEASURE_DAYS of each. A weekday whose usual is 0 (shut) says
// nothing and is skipped.
//
// dayLog: [{ ad, dow, sales }] — the Target's history window plus this month.
export function measuredRainEffect({ dayLog, byWeekday, weatherByAd }) {
  const rainy = [], dry = []
  ;(dayLog || []).forEach(({ ad, dow, sales }) => {
    const usual = byWeekday ? byWeekday[dow] : 0
    if (!(usual > 0) || sales == null) return
    const w = weatherByAd ? weatherByAd[ad] : null
    if (!w || !w.complete) return
    ;(Number(w.precip_mm) >= RAIN_MM ? rainy : dry).push(sales / usual)
  })
  const enough = rainy.length >= MIN_MEASURE_DAYS && dry.length >= MIN_MEASURE_DAYS
  const dryMean = dry.length ? mean(dry) : 0
  return {
    rainyDays: rainy.length,
    dryDays: dry.length,
    pct: enough && dryMean > 0 ? Math.round((mean(rainy) / dryMean) * 100) : null,
  }
}
