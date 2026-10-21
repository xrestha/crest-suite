import { useCallback } from 'react'
import { useAuth } from '../../context/AuthContext'
import { cachedPeriodList, readPeriodList } from '../periodList'

// The shared month list for the page's client (S855, PERF-2; `src/shared/periodList.js` explains
// the guess-then-confirm load). Returns a function for `initPeriodLoad`'s `periodList`: each call
// hands back the list already in memory (`cached`, null on the first visit) and a fresh read
// (`fresh`, `{ data, error }`), started at once and shared with any read already in flight.
// Keyed on the client the scoped reads are bound to, as `useRecipeBook` is.
export function usePeriodList() {
  const { clientId } = useAuth()
  return useCallback(() => ({
    cached: cachedPeriodList(clientId),
    fresh: readPeriodList(clientId),
  }), [clientId])
}
