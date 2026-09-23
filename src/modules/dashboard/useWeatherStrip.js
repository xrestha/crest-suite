// Everything a dashboard header needs to show the weather (S786), so the main Dashboard and the HR
// Dashboard derive it one way. Before this, ClientDashboard held the whole derivation inline and a
// second dashboard would have been a second copy of the S785 review's fixes.
//
// The weather loads for any client that has it (hasWeather: IMS Growth, or the POS or HR module)
// and has a city. The rain-adjusted sales forecast is NOT decided here — ClientDashboard keeps that
// on hasFeature('weather_forecast'), and reads `weather`/`weatherByAd` from this hook to do it.
import { useAuth } from '../../context/AuthContext'
import { useSettings } from '../../context/SettingsContext'
import { useWeatherDays } from './useWeatherDays'
import { weatherIndex, stripHasForecast } from './weatherEffect'
import { canEditWeatherCity } from './weatherSettings'
import { cityByKey } from '../../shared/nepalCities'
import { formatAd } from '../../utils/bsCalendar'
import { nepalCivilDate } from '../../shared/nepalTime'

export function useWeatherStrip({ refreshKey } = {}) {
  const { clientId, profile, isAdmin, isOwner, hasWeather } = useAuth()
  const { settings, settingsLoadError, settingsClientId } = useSettings()
  const effectiveClientId = clientId || profile?.client_id || null

  const own = !!effectiveClientId && !!settings && settings.client_id === effectiveClientId
  const located = own && settings.weather_lat != null && settings.weather_lon != null
  const { weather, error: weatherError } = useWeatherDays({
    clientId: effectiveClientId,
    enabled: hasWeather && located,
    locationKey: located ? `${settings.weather_lat},${settings.weather_lon}` : null,
    refreshKey,
  })
  const weatherByAd = weather?.days?.length ? weatherIndex(weather.days) : null

  // The strip's "Today" is the viewer's Nepal date, not the reply's: a reply can be from before
  // midnight, and its rows are keyed by date, so the right days are in it either way.
  const stripToday = formatAd(nepalCivilDate(Date.now()))
  // Ready only when one of the strip's OWN days has a row (the reply also carries 60 past days);
  // a reply with no such row is no weather, the same as a failed call. A failed REFRESH keeps the
  // last good answer, which useWeatherDays holds on to.
  const stripState = !hasWeather || !located ? null
    : stripHasForecast(weatherByAd, stripToday) ? 'ready'
    : weather || weatherError ? 'unavailable'
    : 'loading'

  const cityName = own ? (cityByKey(settings.weather_city)?.name || settings.weather_city || '') : ''
  const canEditCity = canEditWeatherCity({ isAdmin, isOwner, profile })
  // "No city" is something the page knows only once THIS client's settings have been read: not
  // before, not during a client switch, not after a failed read.
  const showSetCity = hasWeather && !located && canEditCity
    && !!effectiveClientId && settingsClientId === effectiveClientId && !settingsLoadError

  return {
    clientId: effectiveClientId,
    weather, weatherError, weatherByAd,
    own, located, stripState, stripToday, cityName,
    fetchedAt: weather?.fetched_at || null,
    stale: !!weather?.stale,
    canEditCity, showSetCity,
    visible: !!stripState || showSetCity,
  }
}
