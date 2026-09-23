// The Dashboard header's weather strip (S785): today and the next three days for the outlet's city,
// each as a picture, the high and low over opening hours, and the rain in a plain word. A day the
// rain is moving the sales forecast carries a "×N%" tag, explained once under the strip ("×60% =
// rainy-day sales forecast") and in full in the day's Tip, so the dip in the dashed line has its
// reason in view without reading the chart footer. Each day is two lines beside its picture, so the
// strip stands about as tall as the title beside it.
//
// The words and the thresholds are weatherEffect.js's (weatherLook), so a tagged day can never read
// as light rain or dry. The detail — the BS date, the rain in mm, whether today's figure covers the
// whole day — is in each tile's Tip rather than on the tile: the tile is a glance, and four of them
// have to fit beside the page title.
//
// It renders nothing it has not read: placeholder tiles while the first answer is on its way, one
// quiet sentence when there is no answer, and a dash for a figure a row does not carry (a row
// written before S785 has rain and no temperature). MET Norway's CC BY credit is always shown with
// the weather, as dashboards.md requires wherever weather appears.
import {
  Sun, CloudSun, Cloud, CloudDrizzle, CloudRain, CloudRainWind, CloudLightning,
} from 'lucide-react'
import Tip from '../../components/Tip'
import { weatherLook, datesFrom, STRIP_DAYS } from '../../modules/dashboard/weatherEffect'
import { adToBsSafe, formatBsDay } from '../../utils/bsCalendar'
import { nepalTime } from '../../shared/nepalTime'

const ICON = {
  clear: Sun, partly: CloudSun, cloudy: Cloud, dry: CloudSun,
  light_rain: CloudDrizzle, rain: CloudRain, heavy_rain: CloudRainWind, thunder: CloudLightning,
}
const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

// A calendar date from its parts, never Date.parse: 'YYYY-MM-DD' parses as UTC midnight, which
// west of UTC is the day before.
function localDate(iso) {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d)
}

const deg = n => `${Math.round(n)}°`

// The Tip for one day, as plain sentences. Exported for its test.
export function dayTip({ iso, isToday, w, look, tagPct }) {
  const date = localDate(iso)
  const bs = adToBsSafe(date)
  const name = `${WEEKDAY_LONG[date.getDay()]}, ${bs ? formatBsDay(bs.day, bs.month) : iso}`
  if (!w) return `${name}. The forecast does not reach this day yet.`
  const mm = Number(w.precip_mm) || 0
  const parts = [
    `${name}: ${look.word.toLowerCase()}.`,
    mm > 0
      ? `${Math.round(mm * 10) / 10} mm of rain between 5:45 am and 11:45 pm.`
      : 'No rain forecast between 5:45 am and 11:45 pm.',
    // No promise of when a missing temperature arrives: a row stored before temperatures were
    // kept only gains one when the function next rewrites or refreshes that day.
    w.temp_max != null && w.temp_min != null
      ? `High ${deg(w.temp_max)}, low ${deg(w.temp_min)} over the same hours.`
      : 'No temperature in this forecast yet.',
  ]
  if (!w.complete) {
    parts.push(isToday
      ? 'The forecast was fetched after the day began, so this covers the rest of today.'
      : 'The forecast reaches only part of this day so far.')
  } else if (isToday) {
    // The Edge Function keeps today's rain and high/low from the forecast made before opening and
    // refreshes only the sky and thunder, so say which part is which under "updated HH:MM".
    parts.push('The rain and the high/low are from the forecast made before the day began, the one the sales forecast uses; the sky picture follows the latest update.')
  }
  if (tagPct != null) {
    // The Owner's figure runs 30–150, so rain can raise a forecast as well as lower it.
    parts.push(tagPct < 100
      ? `Rain is lowering this day's sales forecast to ${tagPct}% of a usual day, the figure set in Settings → Weather.`
      : tagPct > 100
        ? `Rain is raising this day's sales forecast to ${tagPct}% of a usual day, the figure set in Settings → Weather.`
        : 'Rain leaves this day\'s sales forecast at a usual day\'s level (100%, the figure set in Settings → Weather).')
  }
  return parts.join(' ')
}

// state: 'loading' | 'ready' | 'unavailable'. `onChangeCity` (S786) is set only for a login that
// may change the city; it puts a "Change city" button in the line under the days.
export default function WeatherStrip({ state, weatherByAd, todayAd, cityName, fetchedAt, stale, rainTagByAd, onChangeCity }) {
  const dates = datesFrom(todayAd, STRIP_DAYS)
  const label = cityName ? `Weather for ${cityName}` : 'Weather'
  const changeCity = onChangeCity && (
    <> · <button type="button" className="weather-strip__change" onClick={onChangeCity}>Change city</button></>
  )

  if (state === 'unavailable') {
    return (
      <section className="weather-strip no-print" aria-label={label}>
        <p className="weather-strip__note">{cityName ? `${cityName} · ` : ''}Weather unavailable right now.{changeCity}</p>
      </section>
    )
  }

  if (state === 'loading' || !dates.length) {
    return (
      <section className="weather-strip no-print" aria-label={label} aria-busy="true">
        <ul className="weather-strip__days">
          {Array.from({ length: STRIP_DAYS }, (_, i) => (
            <li key={i} className="weather-strip__day">
              <span className="skeleton weather-strip__skeleton" aria-hidden="true" />
            </li>
          ))}
        </ul>
        <p className="weather-strip__credit">{cityName ? `${cityName} · ` : ''}Loading the weather…</p>
      </section>
    )
  }

  // The tag on a day is only "×60%", to keep the strip two lines tall; the line underneath says once
  // what it means (every tag carries the same Settings figure), and each day's Tip says it in full.
  const legendPct = rainTagByAd ? dates.map(iso => rainTagByAd[iso]).find(p => p != null) ?? null : null

  return (
    <section className="weather-strip no-print" aria-label={label}>
      <ul className="weather-strip__days">
        {dates.map((iso, i) => {
          const w = weatherByAd ? weatherByAd[iso] : null
          const look = weatherLook(w)
          const Icon = look ? ICON[look.kind] : null
          const tagPct = rainTagByAd && rainTagByAd[iso] != null ? rainTagByAd[iso] : null
          const dayLabel = i === 0 ? 'Today' : WEEKDAY_SHORT[localDate(iso).getDay()]
          const hasTemp = w && w.temp_max != null && w.temp_min != null
          return (
            <li key={iso} className="weather-strip__day">
              <Tip
                text={dayTip({ iso, isToday: i === 0, w, look, tagPct })}
                width={240}
                style={{ display: 'block', width: '100%', borderBottom: 'none', cursor: 'default' }}
              >
                {/* Two lines beside the picture, so the strip stands no taller than the title:
                    the day and its high/low, then the word and the sales tag. */}
                <span className="weather-strip__cell">
                  {Icon
                    ? <Icon className="weather-strip__icon" size={18} strokeWidth={1.75} aria-hidden="true" />
                    : <span className="weather-strip__icon weather-strip__icon--none" aria-hidden="true">—</span>}
                  <span className="weather-strip__line weather-strip__line--top">
                    <span className="weather-strip__label">{dayLabel}</span>
                    <span className="weather-strip__temp">
                      {hasTemp ? (
                        <>
                          <span aria-hidden="true">{deg(w.temp_max)} / {deg(w.temp_min)}</span>
                          <span className="sr-only">high {deg(w.temp_max)}, low {deg(w.temp_min)}</span>
                        </>
                      ) : '—'}
                    </span>
                  </span>
                  <span className="weather-strip__line">
                    <span className="weather-strip__word">{look ? look.word : 'No forecast'}</span>
                    {tagPct != null && (
                      <span className="badge-gray weather-strip__tag">
                        <span className="sr-only">sales forecast </span>×{tagPct}%
                      </span>
                    )}
                  </span>
                </span>
              </Tip>
            </li>
          )
        })}
      </ul>
      <p className="weather-strip__credit">
        {cityName && <>{cityName} · </>}
        {legendPct != null && <>×{legendPct}% = rainy-day sales forecast · </>}
        <a href="https://www.met.no/en" target="_blank" rel="noreferrer">MET Norway</a>
        {' '}(<a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a>)
        {fetchedAt && (stale
          ? <span className="weather-strip__stale"> · over 12 hours old</span>
          : <> · updated {nepalTime(fetchedAt)}</>)}
        {changeCity}
      </p>
    </section>
  )
}
