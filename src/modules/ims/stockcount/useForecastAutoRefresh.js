import { useEffect, useRef, useState } from 'react'
import { scopedFrom } from '../../../shared/scopedDb'
import { runForecast } from '../../../utils/demandForecastData'
import { withTimeout } from '../../../utils/withTimeout'
import { forecastFreshness, AUTO_HORIZON } from './forecastFreshness'

const CHECK_MS = 15000
const RUN_MS = 60000

// One attempt per outlet per browser tab (S888). Module-level, so the Roster and Demand Forecast
// cannot both run it on one visit and React's doubled effect cannot start it twice; a page opened
// while a run is in flight waits for that run instead of starting another. A failed attempt is not
// retried until the page is reloaded. Two people at once is runForecast's own case: the newest run
// stands and clears the older one (S792.4).
const attempts = new Map() // clientId -> { promise, settled }

// The outlet's newest stored run and the furthest day any run reaches, outlet-level rows only.
async function readFreshness(clientId) {
  const base = () => scopedFrom('demand_forecast_daily', clientId, 'bs_year, bs_month, bs_day, generated_at').is('recipe_id', null)
  const [newest, last] = await Promise.all([
    withTimeout(base().order('generated_at', { ascending: false }).limit(1), CHECK_MS, 'Checking the forecast'),
    withTimeout(base().order('bs_year', { ascending: false }).order('bs_month', { ascending: false })
      .order('bs_day', { ascending: false }).limit(1), CHECK_MS, 'Checking the forecast'),
  ])
  if (newest.error || last.error) throw newest.error || last.error
  const n = newest.data?.[0]
  const l = last.data?.[0]
  return forecastFreshness({
    newestRunAt: n?.generated_at ?? null,
    lastDay: l ? { year: l.bs_year, month: l.bs_month, day: l.bs_day } : null,
  })
}

/**
 * Checks the stored forecast when a page opens and, for a login allowed to, rebuilds the 30-day
 * forecast once it is a week old or runs out within a week. onRefreshed(result, fresh) and
 * onFailed(error, fresh) are read at call time, so a page passes plain inline functions.
 *
 * status: 'off' | 'checking' | 'fresh' | 'stale' (old, and this login does not refresh it) |
 *   'waiting' (for the weather) | 'refreshing' | 'refreshed' | 'no_history' | 'failed' | 'unknown'
 *   (the check itself could not be read, so nothing is claimed).
 *
 * @param {{ clientId: ?string, enabled: boolean, canRun: boolean, sampleFactorOf: ?Function,
 *   weatherPending: boolean, onRefreshed?: Function, onFailed?: Function }} a
 */
export function useForecastAutoRefresh({ clientId, enabled, canRun, sampleFactorOf, weatherPending, onRefreshed, onFailed }) {
  const [state, setState] = useState({ status: 'off', fresh: null, result: null, error: null })
  // Read at run time, not effect inputs: the weather landing must not restart a check.
  const factorRef = useRef(sampleFactorOf)
  factorRef.current = sampleFactorOf
  const refreshedRef = useRef(onRefreshed)
  refreshedRef.current = onRefreshed
  const failedRef = useRef(onFailed)
  failedRef.current = onFailed

  useEffect(() => {
    if (!clientId || !enabled) { setState({ status: 'off', fresh: null, result: null, error: null }); return undefined }
    let live = true
    const set = next => { if (live) setState(next) }
    ;(async () => {
      set({ status: 'checking', fresh: null, result: null, error: null })
      let fresh
      try { fresh = await readFreshness(clientId) } catch (err) {
        console.error('[forecast] freshness check', err)
        set({ status: 'unknown', fresh: null, result: null, error: err })
        return
      }
      if (!fresh.stale) { set({ status: 'fresh', fresh, result: null, error: null }); return }
      if (!canRun) { set({ status: 'stale', fresh, result: null, error: null }); return }
      const prior = attempts.get(clientId)
      if (prior?.settled) { set({ status: 'stale', fresh, result: null, error: null }); return }
      if (!prior && weatherPending) { set({ status: 'waiting', fresh, result: null, error: null }); return }
      set({ status: 'refreshing', fresh, result: null, error: null })
      let entry = prior
      if (!entry) {
        entry = { settled: false, promise: null }
        entry.promise = withTimeout(runForecast(clientId, AUTO_HORIZON, { sampleFactorOf: factorRef.current }), RUN_MS, 'Refreshing the forecast')
          .finally(() => { entry.settled = true })
        attempts.set(clientId, entry)
      }
      try {
        const res = await entry.promise
        if (res?.refused === 'no_history') { set({ status: 'no_history', fresh, result: res, error: null }); return }
        set({ status: 'refreshed', fresh, result: res, error: null })
        if (live) refreshedRef.current?.(res, fresh)
      } catch (err) {
        console.error('[forecast] automatic refresh', err)
        set({ status: 'failed', fresh, result: null, error: err })
        if (live) failedRef.current?.(err, fresh)
      }
    })()
    return () => { live = false }
  }, [clientId, enabled, canRun, weatherPending])

  return state
}

// For tests: forget the attempts made in this tab.
export function resetForecastAutoRefreshForTests() { attempts.clear() }
