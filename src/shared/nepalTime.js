import { adToBsSafe } from '../utils/bsCalendar'

/**
 * Clock times, pinned to Nepal.
 *
 * WHY (S670): eighteen call sites across POS and IMS had independently written the byte-identical
 * `toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })`, and every one of them
 * renders in the RUNTIME's timezone. On a till or an owner's laptop in Kathmandu that is correct
 * by accident. For an operator viewing a client's data from anywhere else, every time on the
 * screen is off by 5h45m — and `Asia/Kathmandu` appeared nowhere in the codebase.
 *
 * The repo already knows this class of bug: `bsDayBoundaryIso()` in bsCalendar.js pins `+05:45`
 * explicitly and its comment explains why. But that is DATE-BOUNDARY CONSTRUCTION; nothing had
 * ever pinned DISPLAY.
 *
 * This lives here rather than in bsCalendar.js because that file is shared byte-for-byte with
 * hss-suite (docs/CROSS-REPO.md) and every change to it costs a cross-repo filing. Same reasoning
 * as operatingBands.js and staffLevelBadge.js: the third copy of a decision becomes a file.
 */

const ZONE = 'Asia/Kathmandu'

// Constructed once. Intl.DateTimeFormat is expensive enough that building one per table row is
// visible on a 1000-row Bill Register.
const timeFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONE, hour: '2-digit', minute: '2-digit',
})

const partsFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
})

const hourFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONE, hour: 'numeric', hourCycle: 'h23',
})

const adFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONE, day: '2-digit', month: '2-digit', year: 'numeric',
})

const hm24Fmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})

function toDate(ts) {
  if (ts == null || ts === '') return null
  const d = ts instanceof Date ? ts : new Date(ts)
  return isNaN(d.getTime()) ? null : d
}

/**
 * A timestamptz as the clock time it showed in Nepal — "7:42 PM".
 *
 * Returns '' for null/invalid rather than throwing or printing "Invalid Date": `closed_at` is
 * nullable on a still-open order and `credit_settled_at` is absent on most bills, and both reach
 * this from table cells that must still render.
 */
export function nepalTime(ts) {
  const d = toDate(ts)
  return d ? timeFmt.format(d) : ''
}

/**
 * The calendar day a timestamp fell on IN NEPAL, as a Date at the runtime's local midnight.
 *
 * This exists because `adToBs()` reads a Date's LOCAL getters. Pin the time without pinning the
 * date and a bill closed 00:15 in Kathmandu renders as "20 Bhadra · 12:15 AM" for a viewer in
 * UTC — the time from one day, the date from another, on the same line. Handing this Date to
 * adToBs/adToBsSafe makes the two agree because the local getters now read Nepal's Y/M/D.
 */
export function nepalCivilDate(ts) {
  const d = toDate(ts)
  if (!d) return null
  // en-CA gives YYYY-MM-DD, so the parts are unambiguous without inspecting types.
  const [y, m, dd] = partsFmt.format(d).split('-').map(Number)
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(dd)) return null
  return new Date(y, m - 1, dd)
}

/**
 * The BS date a timestamp fell on in Nepal, or null outside the verified table.
 *
 * Deliberately adToBsSafe, not adToBs — a display site that reaches past BS_YEAR_MAX gets null and
 * can fall back to the AD date, instead of the confident wrong date adToBs would return.
 * docs/CROSS-REPO.md carries that as an open audit across 65 existing call sites; new ones should
 * not add to it.
 */
export function nepalBs(ts) {
  const d = nepalCivilDate(ts)
  return d ? adToBsSafe(d) : null
}

/**
 * The hour (0-23) a timestamp fell in, in Nepal — for bucketing, not display.
 *
 * `new Date(ts).getHours()` is the runtime's hour, so an Hourly chart built from it puts a
 * client's dinner rush in the afternoon for an operator viewing from abroad, and disagrees with
 * the pinned clock time on the Bill Register one tab away.
 *
 * Returns null for the absent and the malformed — a caller bucketing into a fixed 24-slot array
 * must skip those rather than write to `buckets[NaN]`.
 */
export function nepalHour(ts) {
  const d = toDate(ts)
  if (!d) return null
  // hourCycle h23 so midnight is 0 rather than the 24 that hour12:false yields in some ICU builds.
  const n = Number(hourFmt.format(d))
  return Number.isFinite(n) ? n : null
}

/**
 * The AD calendar date as read in Nepal — "21/08/2026".
 *
 * Deliberately en-US, matching the exact locale the printed bills used before they were pinned,
 * so this change moves the date's VALUE and its timezone and nothing else. That means MM/DD/YYYY:
 * Nepal writes DD/MM/YYYY and en-GB would give it, but flipping the date order on a Tax Invoice is
 * a separate decision from fixing which day it names, and it is not one to make silently.
 */
export function nepalDateAd(ts) {
  const d = toDate(ts)
  return d ? adFmt.format(d) : ''
}

const longFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: ZONE, day: 'numeric', month: 'long', year: 'numeric',
})

/**
 * The AD calendar date as read in Nepal, with the month NAMED — "4 September 2026".
 *
 * For surfaces where the date is itself the fact on record. `nepalDateAd` above is "09/04/2026",
 * which a reader who writes DD/MM (Nepal does) takes as 9 April; that ambiguity is tolerable on a
 * bill whose format S670 chose not to change silently, and not on an acceptance ledger, where a
 * misread date is a misread contract. This is also the form the legal registry already uses for
 * its effective dates (`effectiveAdLabel`), so the two dates on the same panel finally agree.
 *
 * `month: 'long'` on purpose: en-GB's SHORT September is "Sept" in current ICU, which is the kind
 * of thing that reads as a typo in a legal record.
 */
export function nepalDateLong(ts) {
  const d = toDate(ts)
  return d ? longFmt.format(d) : ''
}

/**
 * The 24-hour clock time in Nepal — "19:45". For spreadsheet cells only.
 *
 * A sheet column gets sorted and filtered; "06:50 PM" sorts before "11:30 AM" as text, so the
 * screen's 12-hour form would silently mis-order any workbook a reader sorts by time. The screen
 * keeps 12-hour because that is how the house reads a clock.
 */
export function nepalTime24(ts) {
  const d = toDate(ts)
  return d ? hm24Fmt.format(d) : ''
}
