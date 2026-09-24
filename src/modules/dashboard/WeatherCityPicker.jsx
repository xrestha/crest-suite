// The outlet's weather city, one picker for every screen that sets it (S786): POS Setup → Weather,
// and the "Set your city" / "Change city" box on both dashboards. Settings → Weather keeps its own
// form (it also holds the Owner's rainy-day figure) but writes the city through the same cityPatch.
//
// It saves through useSettings().saveSettings with only the three city columns, never the row
// (settings-row.md), and that call re-reads the row into the context, so the dashboard strip picks
// the new city up at once. A raw supabase write — POS Setup's other tabs' shape — would leave the
// context stale until a reload.
//
// It reads the row only once the context says the row on screen was read for THIS client
// (settingsClientId), so an admin switching client never sees one outlet's city offered for the
// next. Untouched, it follows the stored value; touched, it holds the draft until Save or Cancel.
import { useState } from 'react'
import { useAuth } from '../../context/AuthContext'
import { useSettings } from '../../context/SettingsContext'
import { NEPAL_CITIES, cityByKey } from '../../shared/nepalCities'
import { withTimeout } from '../../utils/withTimeout'
import Tip from '../../components/Tip'
import ActionError, { asActionError } from '../../components/ActionError'
import { cityPatch, canEditWeatherCity } from './weatherSettings'

const SAVE_TIMEOUT_MS = 20000

export default function WeatherCityPicker({ clientId, idBase = 'weather', onSaved, onCancel }) {
  const { isAdmin, isOwner, profile } = useAuth()
  const { settings, settingsLoadError, settingsClientId, saveSettings } = useSettings()
  const canEdit = canEditWeatherCity({ isAdmin, isOwner, profile })

  const [draft, setDraft] = useState(null)   // null = untouched, follow the stored city
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [saved, setSaved] = useState(false)

  if (!clientId) {
    return <p className="weather-picker__note">The weather is set per outlet. Choose a client from the top bar first.</p>
  }
  const ready = settingsClientId === clientId
  if (ready && settingsLoadError) {
    return (
      <p className="weather-picker__note weather-picker__note--warn" role="alert">
        This outlet&apos;s settings could not be read, so the city cannot be changed right now. Reload the page to try again.
      </p>
    )
  }
  if (!ready) return <p className="weather-picker__note">Loading…</p>

  // A client with no settings row reads as DEFAULT_SETTINGS, which carries no client_id: no city.
  const stored = settings?.client_id === clientId ? (settings.weather_city || '') : ''
  const value = draft ?? stored
  const storedName = cityByKey(stored)?.name || stored

  if (!canEdit) {
    return (
      <div>
        <p className="weather-picker__current">{storedName ? `City: ${storedName}` : 'No city is set yet.'}</p>
        <p className="weather-picker__note">Only the Owner or a manager can change the city.</p>
      </div>
    )
  }

  const unchanged = value === stored

  // The button stays pressable in both of its waiting states (DESIGN.md → Buttons): disabling the
  // button a keyboard user just pressed drops focus to <body>. In flight it wears aria-busy and a
  // second press does nothing; with nothing to save it wears aria-disabled and a press says why.
  async function save() {
    if (busy) return
    if (unchanged) {
      setSaved(false)
      setError(stored ? 'Pick a different city first. This one is already saved.' : 'Pick a city first.')
      return
    }
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      await withTimeout(saveSettings(cityPatch(value)), SAVE_TIMEOUT_MS, 'Saving the city')
      setDraft(null)
      setSaved(true)
      if (onSaved) onSaved(value)
    } catch (e) {
      // The city on screen is still the one typed, so pressing Save again is the recovery.
      setError(asActionError(e))
    } finally {
      setBusy(false)
    }
  }

  const id = `${idBase}-city`
  return (
    <div>
      <div className="form-field">
        <label htmlFor={id}>
          <Tip text="The weather forecast is read for this town, not your street, which is as close as a forecast gets anyway. Pick the nearest one. 'Not set' turns the weather off for this outlet." width={280}>City</Tip>
        </label>
        <select id={id} className="form-select" value={value} disabled={busy}
          onChange={e => { setDraft(e.target.value); setSaved(false); setError(null) }}>
          <option value="">Not set: no weather</option>
          {NEPAL_CITIES.map(c => <option key={c.key} value={c.key}>{c.name}</option>)}
        </select>
        <span className="weather-picker__hint">Weather data from MET Norway. It shows at the top of the Dashboard.</span>
      </div>
      <div className="weather-picker__actions">
        <button type="button" className="btn btn-primary btn-sm" onClick={save}
          aria-disabled={(!busy && unchanged) || undefined} aria-busy={busy || undefined}>
          {busy ? 'Saving…' : 'Save city'}
        </button>
        {onCancel && <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel} disabled={busy}>Cancel</button>}
        {saved && !busy && <span className="weather-picker__saved" role="status">✓ Saved</span>}
      </div>
      <ActionError error={error} />
    </div>
  )
}
