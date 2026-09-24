// The right-hand side of a dashboard header when the outlet has the weather (S786): the four-day
// strip, or — with no city yet — a "Set your city" button, and the small dialog both open. Shared
// by the main Dashboard and the HR Dashboard so the two headers cannot drift; the parent decides
// whether the header is split from `strip.visible`, and passes the chart's "×N%" tags where it has
// them (only the main Dashboard does).
//
// The buttons show only to a login that may change the city (canEditWeatherCity — the Owner, admin
// or a manager of any module, which is what the database enforces); everyone else sees the strip
// alone, or nothing.
import { useEffect, useRef, useState } from 'react'
import { CloudSun } from 'lucide-react'
import Modal from '../../components/Modal'
import WeatherStrip from './WeatherStrip'
import WeatherCityPicker from '../../modules/dashboard/WeatherCityPicker'

export default function WeatherHeaderSlot({ strip, rainTagByAd = null }) {
  const [open, setOpen] = useState(false)
  // Focus after a save (S786 review). Modal hands focus back to the control that opened it, and a
  // save removes that control: "Set your city" gives way to the strip, and "Change city" to the
  // strip's loading state while the new city's weather comes in. Focus would fall to <body>, and a
  // keyboard user would start again from the top of the page. So after a save it goes to the strip
  // (a tabIndex -1 section), or back to "Set your city" if the city was cleared.
  const [refocus, setRefocus] = useState(false)
  const stripRef = useRef(null)
  const setCityRef = useRef(null)
  useEffect(() => {
    if (!refocus || open) return
    const target = stripRef.current || setCityRef.current
    if (target) target.focus()
    setRefocus(false)
  }, [refocus, open, strip.stripState])
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
          sectionRef={stripRef}
        />
      ) : (
        <button ref={setCityRef} type="button" className="btn btn-ghost btn-sm no-print weather-set-city" onClick={() => setOpen(true)}>
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
            onSaved={() => { setRefocus(true); setOpen(false) }}
            onCancel={() => setOpen(false)}
          />
        </Modal>
      )}
    </>
  )
}
