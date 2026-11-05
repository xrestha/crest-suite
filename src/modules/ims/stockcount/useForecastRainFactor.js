import { useMemo } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useSettings } from '../../../context/SettingsContext'
import { useWeatherStrip } from '../../dashboard/useWeatherStrip'
import { rainPctValue, isRainyDay } from '../../dashboard/weatherEffect'
import { formatAd } from '../../../utils/bsCalendar'

// The rain allowance a forecast run learns from (moved out of DemandForecast.js in S888, so the
// Roster's automatic refresh builds exactly what Recompute builds).
//
// Rainy days (S800, owner decision): the dashboard's own rule — the Growth weather feature, the
// Owner's rain percentage, a city (S849, FORECAST-4). A run then learns how rainy each day's samples
// were, and waits for the weather while it is still loading, so a run made a second too early does
// not store "unknown" for a wet fortnight. One sample day's factor is the Owner's % on a recorded
// rainy day, else 1; a day older than the weather store's 60 days has no row, so it counts as dry.
export function useForecastRainFactor() {
  const { hasFeature } = useAuth()
  const { settings } = useSettings()
  const weatherFeature = hasFeature('weather_forecast')
  const strip = useWeatherStrip({})
  const { weatherByAd, own, located, stripState } = strip
  const rainPct = own ? rainPctValue(settings?.rain_sales_pct) : null
  const rainApplies = weatherFeature && rainPct != null && located
  const weatherPending = rainApplies && stripState === 'loading'
  const sampleFactorOf = useMemo(() => (
    rainApplies && weatherByAd
      ? sample => (isRainyDay(weatherByAd[formatAd(sample.date)]) ? rainPct / 100 : 1)
      : null
  ), [rainApplies, weatherByAd, rainPct])
  return { ...strip, weatherFeature, rainPct, rainApplies, weatherPending, sampleFactorOf }
}
