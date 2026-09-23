// Rain per day for the dashboard's weather-adjusted sales forecast (S784), from the weather-forecast
// Edge Function. Its own hook with its own effect and load id, like useFoodBeverageSplit: the
// weather is an enhancement to one chart line, so it never holds up loadStats and the rest of the
// dashboard (dashboards.md: never queue a chart's load behind a load it does not need).
//
// Best-effort by design. A failure keeps the last good answer rather than blanking it, and the
// chart simply draws its unadjusted forecast and says the weather could not be read.
import { useEffect, useRef, useState } from 'react'
import { supabase } from '../../supabaseClient'
import { withTimeout } from '../../utils/withTimeout'
import { readPageCache, writePageCache } from '../../shared/sessionDataCache'

// `refreshKey` re-asks without a remount (S785): the dashboard passes its location key, so opening
// Dashboard again from the nav while it is already mounted fetches again instead of keeping a reply
// from the day before. The Edge Function's own cache is what keeps that cheap for MET.
export function useWeatherDays({ clientId, enabled, locationKey, refreshKey }) {
  // Seeded from the page cache for an instant revisit, but only for the same outlet AND the same
  // city: a city changed in Settings must not come back as the old city's rain.
  const [weather, setWeather] = useState(() => {
    if (!enabled || !clientId) return null
    const cached = readPageCache('dashboard', 'weather', clientId)
    return cached && cached.locationKey === locationKey ? cached : null
  })
  const [error, setError] = useState(null)
  const loadIdRef = useRef(0)

  useEffect(() => {
    const myId = ++loadIdRef.current
    if (!enabled || !clientId) {
      setWeather(null)
      setError(null)
      return
    }
    // Another outlet's or another city's rain is never "the last good answer" for this one.
    setWeather(prev => (prev && prev.clientId === clientId && prev.locationKey === locationKey ? prev : null))
    withTimeout(
      supabase.functions.invoke('weather-forecast', { body: { client_id: clientId } }),
      15000, 'Weather forecast',
    ).then(({ data, error: fnError }) => {
      if (loadIdRef.current !== myId) return
      if (fnError || !data || data.error) {
        setError(fnError || new Error(data?.error || 'No weather came back.'))
        return
      }
      const next = { ...data, clientId, locationKey }
      setWeather(next)
      setError(null)
      writePageCache('dashboard', 'weather', clientId, next)
    }, err => {
      if (loadIdRef.current !== myId) return
      setError(err)
    })
  }, [clientId, enabled, locationKey, refreshKey])

  return { weather: weather && weather.clientId === clientId ? weather : null, error }
}
