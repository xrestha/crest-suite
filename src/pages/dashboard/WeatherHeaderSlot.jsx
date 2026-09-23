// The right-hand side of a dashboard header when the outlet has the weather (S786): the four-day
// strip, or — with no city yet — a "Set your city" button, and the small dialog both open. Shared
// by the main Dashboard and the HR Dashboard so the two headers cannot drift; the parent decides
// whether the header is split from `strip.visible`, and passes the chart's "×N%" tags where it has
// them (only the main Dashboard does).
//
// The buttons show only to a login that may change the city (canEditWeatherCity — the Owner, admin
// or a manager of any module, which is what the database enforces); everyone else sees the strip
// alone, or nothing.
import { useState } from 'react'
import { CloudSun } from 'lucide-react'
import Modal from '../../components/Modal'
import WeatherStrip from './WeatherStrip'
import WeatherCityPicker from '../../modules/dashboard/WeatherCityPicker'

export default function WeatherHeaderSlot({ strip, rainTagByAd = null }) {
  const [open, setOpen] = useState(false)
  if (!strip.visible) return null

  return (
    <>
      {strip.stripState ? (
        <WeatherStrip
          state={strip.stripState}
          weatherByAd={strip.weatherByAd}
          todayAd={strip.stripToday}
          cityName={strip.cityName}
          fetchedAt={strip.fetchedAt}
          stale={strip.stale}
          rainTagByAd={rainTagByAd}
          onChangeCity={strip.canEditCity ? () => setOpen(true) : null}
        />
      ) : (
        <button type="button" className="btn btn-ghost btn-sm no-print weather-set-city" onClick={() => setOpen(true)}>
          <CloudSun size={16} strokeWidth={1.75} aria-hidden="true" />
          Set your city for the weather
        </button>
      )}
      {open && (
        <Modal title="Weather city" onClose={() => setOpen(false)} maxWidth={420}>
          <p className="weather-picker__lead">
            Pick the town nearest the outlet. Today&apos;s and the next three days&apos; weather then shows at the top of the Dashboard.
          </p>
          <WeatherCityPicker
            clientId={strip.clientId}
            idBase="dash-weather"
            onSaved={() => setOpen(false)}
            onCancel={() => setOpen(false)}
          />
        </Modal>
      )}
    </>
  )
}
