// How long a POS report's reads may run before the page gives up and says so (S842).
//
// The four POS report pages awaited every read with no limit, so a hung call (a stalled token
// refresh, a dropped connection mid-page — see utils/withTimeout.js) left "Loading…" on screen for
// good, with nothing to press. Bounded, a hung read answers `{ data: null, error }` with a
// TimeoutError, and the page's own firstError → ReportLoadError path reports it like any refused
// read. The limit is a hang detector, not a speed target: a read cut off while it is still
// answering cannot be fixed by retrying, so it is generous and grows with the range.
import { settleWithin } from '../../../utils/withTimeout'

// One quarter of range. A busy outlet's three months is ~27,000 bills: 27 sequential 1000-row
// pages of bills plus their lines, a few seconds at 150–500 ms a round trip, an order of magnitude
// under this.
export const REPORT_READ_MS = 60000
// A whole fiscal year (the 1L+ tab, and the ceiling for a long picked range): up to 2,00,000 bills
// in 1000-row pages, then ~730 line chunks six at a time.
export const YEAR_READ_MS = 300000

const DAY_MS = 24 * 60 * 60 * 1000

/** The limit for a range read: 60 s per 92 days picked, at most a fiscal year's. */
export function rangeReadMs(fromIso, toIso) {
  const days = Math.round((Date.parse(toIso) - Date.parse(fromIso)) / DAY_MS) + 1
  const quarters = Number.isFinite(days) && days > 0 ? Math.ceil(days / 92) : 1
  return Math.min(REPORT_READ_MS * quarters, YEAR_READ_MS)
}

/**
 * A batch of `{ data, error }` reads, each bounded by `ms`. The reads run together, so the batch is
 * bounded by `ms` too. Never rejects: a timeout (or a read that threw) becomes that read's `error`,
 * so `firstError(results)` over the answer handles a hung read exactly as it handles a refused one.
 */
export function settleAll(reads, ms = REPORT_READ_MS, label = 'Loading this report') {
  return Promise.all(reads.map(read => settleWithin(read, ms, label)))
}
