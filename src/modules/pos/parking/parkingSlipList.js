// Pure helpers behind POS → Parking Slips (S814, POS stage 4f). No React, no Supabase, so each rule
// is tested on its own (parkingSlipList.test.js).
//
// The page used to read every slip the outlet had ever issued, on open and again after every Mark
// Exited and every issue, and filter it in the browser (CUSTOMERS-PARKING-15). It now reads the
// Open list (status = 'open', what the partial index pos_parking_slips_open_idx covers) and, only
// when the All tab is open, the slips issued in a From/To range (owner decision D9). What changes
// between reads — a slip issued, marked exited or swept closed here — is applied to whichever list
// holds it with patchSlip, from the row the server answered with.

import { formatAd, formatBsDay } from '../../../utils/bsCalendar'
import {
  nepalBs, nepalDateAd, nepalTime, parseAdDateLocal, serviceDayStartIso, SERVICE_DAY_ROLLOVER_MS,
} from '../../../shared/nepalTime'
import { isNetworkError } from '../../../shared/errorText'
import { isTimeout } from '../../../utils/withTimeout'
import { nepalDayStartTs } from '../reports/reportRange'

// ── The day's sweep ──────────────────────────────────────────────────────────────────────────────

/**
 * The instant today's parking day began: 6 AM Nepal (S756, owner decision). A slip still open from
 * before it is auto-closed when the page next opens; pos_parking_slips_guard refuses an auto-close
 * of anything newer. An instant, not a bsToAd date, so `.toISOString()` is safe here.
 */
export function sweepCutoffIso(nowMs = Date.now()) {
  return new Date(Date.parse(serviceDayStartIso(nowMs)) + SERVICE_DAY_ROLLOVER_MS).toISOString()
}

/** The open slips the sweep would close: issued before `cutoffIso`. */
export function staleOpenSlips(rows, cutoffIso) {
  const cut = Date.parse(cutoffIso)
  return (rows || []).filter(s => s.status === 'open' && Date.parse(s.time_in) < cut)
}

// ── The All tab's date range ─────────────────────────────────────────────────────────────────────

/** The AD day after an AD `YYYY-MM-DD`, built from local getters (never `.toISOString()`). */
export function nextAdIso(adIso) {
  const d = parseAdDateLocal(adIso)
  return formatAd(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1))
}

/**
 * The `time_in` bounds for a From/To pick, as Nepal-pinned instants: From's midnight, inclusive, to
 * the midnight after To, exclusive. The pickers hand back AD strings, so these are the reports'
 * `nepalDayStartTs` boundaries (reportRange.js), the same instants `bsDayBoundaryIso()` builds for a
 * BS day — a slip issued 00:15 Kathmandu belongs to that day for a viewer anywhere.
 */
export function slipRangeBounds(fromIso, toIso) {
  return { startIso: nepalDayStartTs(fromIso), endIso: nepalDayStartTs(nextAdIso(toIso)) }
}

/** Whether a slip issued at `timeIn` belongs on the All list for `range` ({ from, to }, AD strings). */
export function inSlipRange(timeIn, range) {
  if (!range?.from || !range?.to || !timeIn) return false
  const t = Date.parse(timeIn)
  if (!Number.isFinite(t)) return false
  const { startIso, endIso } = slipRangeBounds(range.from, range.to)
  return t >= Date.parse(startIso) && t < Date.parse(endIso)
}

// ── Keeping a list current without re-reading it ─────────────────────────────────────────────────

const bySlipNoDesc = (a, b) => (Number(b.slip_no) || 0) - (Number(a.slip_no) || 0)
  || String(a.id).localeCompare(String(b.id))

/**
 * Apply one row the server answered with to a list.
 *
 * - A slip already on the list takes the new fields. On the Open list (`openOnly`) a slip that is no
 *   longer open leaves it.
 * - A slip not on the list joins it only when it is a whole row (an issue's answer carries
 *   `slip_no`; a Mark Exited answer does not), and only where it belongs: open, for the Open list;
 *   issued inside `range`, for the All list. Newest number first, like the reads.
 */
export function patchSlip(list, row, { openOnly = false, range = null } = {}) {
  const rows = list || []
  if (!row?.id) return rows
  const i = rows.findIndex(s => s.id === row.id)
  if (i >= 0) {
    const merged = { ...rows[i], ...row }
    if (openOnly && merged.status !== 'open') return rows.filter((_, j) => j !== i)
    const next = rows.slice()
    next[i] = merged
    return next
  }
  if (row.slip_no == null) return rows
  if (openOnly ? row.status !== 'open' : (range && !inSlipRange(row.time_in, range))) return rows
  return [...rows, row].sort(bySlipNoDesc)
}

/** patchSlip for several rows, in order. */
export function patchSlips(list, rows, options) {
  return (rows || []).reduce((acc, row) => patchSlip(acc, row, options), list || [])
}

// ── What the page says ───────────────────────────────────────────────────────────────────────────

/** A reload that failed while the page still holds an earlier answer. */
export const LIST_STALE_TEXT = 'Could not refresh the list — it shows what was last loaded.'

/** True when a write got no answer (timed out, or the connection dropped), so it may have landed. */
export function noAnswer(error) {
  return isTimeout(error) || isNetworkError(error)
}

/**
 * Which notice a print result needs, or null when it printed and was counted. `issuing` is the
 * first print, from New Parking Slip.
 */
export function printNoticeKind(print, { issuing = false } = {}) {
  if (!print) return null
  if (!print.printed) {
    if (print.closed) return issuing ? 'issue-closed' : 'reprint-closed'
    return issuing ? 'issue-blocked' : 'reprint-blocked'
  }
  if (print.countError) return noAnswer(print.countError) ? 'count-timeout' : 'count-refused'
  return null
}

/**
 * The sentence for each thing the page has to tell the user about a slip. `slip` is the row
 * (`slip_no`, `vehicle_number`); `count` is the copy number that printed, for the count notices;
 * `vehicle` stands in when there is no row yet (an issue whose answer never came).
 */
export function parkingSlipNotice(kind, { slip = {}, count = null, vehicle = '' } = {}) {
  const n = `P-${slip.slip_no}`
  const v = slip.vehicle_number || vehicle || 'this vehicle'
  // A first print whose count did not save printed as the original, and so will the next one.
  const original = count != null && count <= 1
  switch (kind) {
    case 'issue-blocked':
      return `${n} (${v}) is saved, but its token did not print: the browser blocked the print window. Allow pop-ups for this site, then press Reprint on ${n}. It prints as the original, because nothing has printed yet.`
    case 'reprint-blocked':
      return `Nothing printed for ${n}: the browser blocked the print window. Allow pop-ups for this site, then press Reprint again.`
    case 'issue-closed':
      return `${n} (${v}) is saved, but its token did not print: the print window was closed before the token went into it. Press Reprint on ${n} to print it.`
    case 'reprint-closed':
      return `Nothing printed for ${n}: the print window was closed before the token went into it. Press Reprint again.`
    case 'count-refused':
      return original
        ? `${n} printed, but its print count could not be saved, so a reprint will also print as the original.`
        : `${n} printed, but its print count could not be saved, so the next reprint will carry the same copy label as this one.`
    case 'count-timeout':
      return original
        ? `${n} printed, but saving its print count did not answer in time, so a reprint may also print as the original.`
        : `${n} printed, but saving its print count did not answer in time, so the next reprint may carry the same copy label as this one.`
    case 'issue-unknown':
      return `It is not known whether the slip for ${v} was saved: the answer did not arrive, and nothing printed. Check the Open list for ${v} before issuing it again — if it is there, press Reprint on it.`
    case 'exit-unknown':
      return `It is not known whether ${v} (${n}) was marked exited: the answer did not arrive. The list has been refreshed; if it is still there, press Mark Exited again — a slip closes only once.`
    default:
      return null
  }
}

/** A slip's Time In with its day: "5th Bhadra 2083, 11:30 PM". The All tab spans many days, and an
 *  open slip from before midnight is still on the Open tab after it. */
export function slipTimeIn(ts) {
  if (!ts) return ''
  const bs = nepalBs(ts)
  const day = bs ? `${formatBsDay(bs.day, bs.month)} ${bs.year}` : nepalDateAd(ts)
  return `${day}, ${nepalTime(ts)}`
}
