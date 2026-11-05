import { bsToAd, BS_MONTHS } from '../../../utils/bsCalendar'
import { nepalCivilDate } from '../../../shared/nepalTime'

// When the Demand Forecast refreshes itself (S888, owner decision 2026-11-05): once it is a week
// old, or once it runs out within the next week; from the Roster and Demand Forecast only; for the
// Owner and an inventory supervisor or manager, never for Crest support viewing an outlet.
//
// It always rebuilds the 30-day forecast. The Roster reads it, and a 7-day run is "running out
// within a week" the day after it is made, so judging that one would rebuild it every day.
export const AUTO_REFRESH_DAYS = 7
export const AUTO_HORIZON = 30
const DAY_MS = 86400000

/**
 * Whether the outlet's stored forecast needs a refresh. Both inputs are read across every horizon
 * (the Roster takes the newest row of either for a day): the newest run's server time, and the
 * furthest day any stored run reaches.
 *
 * @param {{ newestRunAt: ?string, lastDay: ?{ year: number, month: number, day: number }, now?: number }} a
 * @returns {{ stale: boolean, reason: 'none'|'old'|'running_out'|null, lastDay: ?object, daysLeft: ?number }}
 *   daysLeft: whole days from today (Nepal) to the last forecast day; negative once it has passed.
 */
export function forecastFreshness({ newestRunAt, lastDay, now = Date.now() }) {
  if (!newestRunAt || !lastDay) return { stale: true, reason: 'none', lastDay: null, daysLeft: null }
  const today = nepalCivilDate(now)
  const lastAd = bsToAd(lastDay.year, lastDay.month, lastDay.day)
  // Both are local midnights; rounding absorbs a daylight-saving hour on a viewer abroad.
  const daysLeft = Math.round((lastAd - today) / DAY_MS)
  if (daysLeft < AUTO_REFRESH_DAYS) return { stale: true, reason: 'running_out', lastDay, daysLeft }
  if (now - Date.parse(newestRunAt) >= AUTO_REFRESH_DAYS * DAY_MS) return { stale: true, reason: 'old', lastDay, daysLeft }
  return { stale: false, reason: null, lastDay, daysLeft }
}

// Who may trigger it: the people allowed to press Recompute (the Owner resolves to an inventory
// manager), on an outlet that has Demand Forecast, and never the operator viewing an outlet.
export function canAutoRefresh({ isAdmin, imsSupervisor, forecastAllowed }) {
  return !isAdmin && !!imsSupervisor && !!forecastAllowed
}

// The Roster line for someone who cannot refresh it, shown only while recommendations are missing
// or about to be (an old forecast that still reaches a week ahead says nothing).
export function staffingForecastNote(fresh) {
  if (!fresh || !fresh.stale || fresh.reason === 'old') return null
  const how = 'The Owner or an inventory supervisor or manager refreshes it by opening this Roster or Demand Forecast.'
  if (fresh.reason === 'none') return `Staffing recommendations come from the Demand Forecast, and it has not been run for this outlet yet. ${how}`
  const d = fresh.lastDay
  return `Staffing recommendations come from the Demand Forecast, which only covers days up to ${d.day} ${BS_MONTHS[d.month - 1]}. ${how}`
}
