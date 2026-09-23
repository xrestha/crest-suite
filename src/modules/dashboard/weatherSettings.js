// The outlet's weather city, as every screen that sets it writes it (S786). Settings → Weather,
// POS Setup → Weather and the dashboards' "Set your city" box all go through here, so the three
// editors of these columns cannot come to disagree (settings-row.md's second-editor trap).
import { cityByKey } from '../../shared/nepalCities'

// The three columns a city is. The picker writes them together, so the name and the coordinates the
// weather is read for can never disagree; blank clears all three (no city, no weather).
export const WEATHER_CITY_FIELDS = ['weather_city', 'weather_lat', 'weather_lon']

export function cityPatch(key) {
  const c = cityByKey(key)
  return { weather_city: c ? c.key : null, weather_lat: c ? c.lat : null, weather_lon: c ? c.lon : null }
}

// Whether an outlet has the weather on its dashboards (owner decision, S786): it comes WITH the POS
// and HR modules, flat like guest ordering, and with IMS through the Growth key `weather_forecast`
// (passed in resolved, so the plan and admin-flag rules stay in hasFeature). This is not the
// rain-adjusted sales forecast, which stays on the Growth key alone.
export const weatherEntitled = ({ growthWeather, posEnabled, hrEnabled }) =>
  !!(growthWeather || posEnabled || hrEnabled)

// Who may change the city: the Owner, admin, or a MANAGER of any module (owner decision, S786).
// This is the browser's copy of settings_guard_staff_roles' weather_city_rank (migration
// 20260923130000) and must say exactly what it says: the RAW role columns, never the resolved
// hasXAccess ranks (which also need the module on, and resolve the Owner to manager), and an IMS
// count PIN (ims_email) is never a manager. The rainy-day figure is the Owner's alone and is not
// asked here.
export function canEditWeatherCity({ isAdmin, isOwner, profile }) {
  if (isAdmin || isOwner) return true
  if (!profile) return false
  return profile.pos_role === 'manager'
    || (profile.ims_role === 'manager' && !profile.ims_email)
    || profile.hr_role === 'manager'
}
