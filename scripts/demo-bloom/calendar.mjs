// The days the demo covers, Shrawan 1 → the cut-off day, with their AD dates and weekdays.
import { bsToAd, daysInBsMonth, formatAd, BS_MONTHS } from '../../src/utils/bsCalendar.js'
import { BS_YEAR, MONTHS } from './config.mjs'
import { weekdayOf } from './lib.mjs'

export { BS_MONTHS }
export const adOf = (m, d) => formatAd(bsToAd(BS_YEAR, m, d))
export const monthDays = m => daysInBsMonth(BS_YEAR, m)

// untilAd: the last AD day to include ('YYYY-MM-DD').
export function buildDays(untilAd) {
  const days = []
  for (const m of MONTHS) {
    const n = daysInBsMonth(BS_YEAR, m)
    for (let d = 1; d <= n; d++) {
      const ad = adOf(m, d)
      if (ad > untilAd) return days
      days.push({ m, d, ad, wd: weekdayOf(ad), idx: days.length, key: `${m}-${d}` })
    }
  }
  return days
}

// Public holidays inside the demo window that change trade (from the 2083 gazette table).
export const TRADE_HOLIDAYS = {
  '5-12': 1.15,   // Janai Purnima
  '5-19': 1.12,   // Krishna Janmashtami
  '6-3': 1.10,    // Constitution Day
}
// Dashain and Tihar, per branch: Kathmandu empties out as people go home; Pokhara fills with
// domestic tourists. Only days after the first build's cut-off, so loaded days never change.
const FESTIVAL_TRADE = { ktm: {}, pkr: {} }
const setFest = (keys, k, p) => keys.forEach(key => { FESTIVAL_TRADE.ktm[key] = k; FESTIVAL_TRADE.pkr[key] = p })
setFest(['6-25'], 1.05, 1.15)
setFest(['6-31'], 0.9, 1.2)
setFest(['7-1', '7-2', '7-3', '7-4', '7-5', '7-6'], 0.6, 1.3)
setFest(['7-22', '7-23', '7-24', '7-25', '7-26'], 0.8, 1.15)
export const tradeFactor = (o, key) => TRADE_HOLIDAYS[key] || FESTIVAL_TRADE[o]?.[key] || 1
