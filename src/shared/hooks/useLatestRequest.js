import { useRef } from 'react'

/**
 * Guards a page against its own overlapping loads.
 *
 * WHY THIS EXISTS (S601)
 *
 * Every period-scoped page in this codebase has the same handler:
 *
 *     async function handlePeriodChange(periodId) {
 *       setSelectedPeriod(periods.find(x => x.id === periodId))
 *       setLoading(true)
 *       await buildReport(periodId)     // ends in setReport(...)
 *       setLoading(false)
 *     }
 *
 * Nothing in it identifies which load is current, and `buildReport` sets its data whenever it
 * resolves. A closed native `<select>` fires `change` on every arrow keypress, so arrowing through
 * a 12-period list starts twelve concurrent loads — each of which is a `Promise.all` of eight to
 * eleven queries. They resolve in arbitrary order, so **the last response to land wins the figures
 * while `selectedPeriod` is whatever was clicked last**. The two need not agree.
 *
 * On a report that is only read on screen, that is a confusing flicker. On Consolidated P&L it is
 * worse: `selectedPeriod` drives the page subtitle, the print title, the Excel `scopeLine` AND the
 * downloaded filename, so one month's figures get exported inside a workbook named and captioned
 * for another. That is a wrong number leaving the building with a label vouching for it.
 *
 * HOW TO USE IT
 *
 *     const periodReq = useLatestRequest()
 *
 *     async function handlePeriodChange(periodId) {
 *       periodReq.begin(periodId)            // synchronous — claims the page before any await
 *       ...
 *       await buildReport(periodId)
 *     }
 *
 *     async function buildReport(periodId) {
 *       const [...] = await Promise.all([...])
 *       if (!periodReq.isCurrent(periodId)) return   // superseded — a newer period is in flight
 *       setReport(...)
 *     }
 *
 * Place the check after the last `await` and before the first setter. Anything that auto-selects a
 * period (a page's own `init()`) must call `begin()` too.
 *
 * THE KEY IS THE PERIOD ID, NOT A COUNTER, and that is deliberate. These load functions are also
 * called from elsewhere — after a save, after a period is closed, on a manual refresh — and those
 * callers never go through `handlePeriodChange`. A monotonic counter would treat every one of them
 * as stale and silently discard a legitimate reload. The question that actually matters is "is the
 * period this load was started for still the selected one", which is exactly what this asks, and a
 * reload of the current period always passes it.
 *
 * IT FAILS OPEN. Before any `begin()` the ref is null and `isCurrent()` returns true, so a page
 * that adopts the check but forgets the `begin()` degrades to the old racy behaviour rather than
 * rendering permanently blank. Cancelling a load is a UI nicety; never showing data is a broken
 * page, and of the two possible mistakes only one is recoverable by the user.
 */
export function useLatestRequest() {
  const ref = useRef(null)
  // The returned object is itself held in a ref, not rebuilt per render: several of these loaders
  // are useCallback(...) with dependency arrays, and a fresh object each render would invalidate
  // them on every render and defeat the memoisation they were written for.
  const api = useRef(null)
  if (api.current === null) {
    api.current = {
      /** Claim the page for `key`. Call this synchronously, before the first await. */
      begin(key) { ref.current = key; return key },
      /** False once a newer `begin()` has superseded `key`. True until anything has claimed. */
      isCurrent(key) { return ref.current === null || ref.current === key },
    }
  }
  return api.current
}
