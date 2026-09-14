import { useState } from 'react'
import { supabase } from '../../../supabaseClient'
import Modal from '../../../components/Modal'
import { errorLine } from '../../../shared/errorText'

const inp = {
  background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)',
  borderRadius: 0, padding: '7px 10px', fontSize: 13, color: 'var(--theme-text1)',
  outline: 'none', fontFamily: 'inherit',
}
const lbl = { fontSize: 11, color: 'var(--theme-text3)', marginBottom: 4, display: 'block' }
const sectionLbl = { ...lbl, fontWeight: 700, fontSize: 12, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.06em' }
const VEHICLE_TYPES = [
  { key: '2w', label: '2-Wheeler' },
  { key: '4w', label: '4-Wheeler' },
  { key: 'ev', label: 'EV' },
]

// Shared chip-list editor for both Purpose Options and Start Points — same add/remove UI,
// just a different label/hint/placeholder and backing state.
function OptionListEditor({ label, hint, placeholder, addLabel, options, setOptions }) {
  const [newOption, setNewOption] = useState('')

  function add() {
    const v = newOption.trim()
    if (!v || options.includes(v)) { setNewOption(''); return }
    setOptions(prev => [...prev, v])
    setNewOption('')
  }
  function remove(v) { setOptions(prev => prev.filter(x => x !== v)) }

  return (
    <div>
      {/* A heading over the chip list, not a control label — the add field carries its own
          aria-label instead, since one <label> can't name both the list and the input. */}
      <div style={sectionLbl}>{label}</div>
      <p style={{ margin: '2px 0 10px', fontSize: 12, color: 'var(--theme-text3)' }}>{hint}</p>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <input
          aria-label={addLabel}
          style={{ ...inp, flex: 1 }}
          value={newOption}
          onChange={e => setNewOption(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && add()}
          placeholder={placeholder}
        />
        <button className="btn btn-ghost" onClick={add}>+ Add</button>
      </div>
      {options.length === 0 ? (
        <div style={{ padding: 16, textAlign: 'center', color: 'var(--theme-text3)', fontSize: 12, border: '1px dashed var(--theme-border)', borderRadius: 0 }}>
          None yet — add common ones above.
        </div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {options.map(o => (
            <span key={o} style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '5px 8px 5px 12px', borderRadius: 0, fontSize: 12,
              background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)',
              color: 'var(--theme-text1)',
            }}>
              {o}
              <button onClick={() => remove(o)} title="Remove" aria-label={`Remove ${o}`} style={{ background: 'none', border: 'none', color: 'var(--theme-text3)', cursor: 'pointer', fontSize: 14, padding: 0, lineHeight: 1 }}>×</button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

// Admin/owner-only settings for TADA Claims — vehicle rates (used by the Transport line's
// auto-fill), Purpose preset options, and Start Point preset options (both used by the New
// Claim form's dropdowns, on the manager form and the Self-Service TADA tab). Edits are staged
// locally and written in one explicit Save, same convention as Table Management's Discount
// Reasons/Quick Notes tabs, rather than auto-saving per keystroke.
export default function TadaSettingsModal({ clientId, vehicleRates, purposeOptions, startPoints, onClose, onSaved }) {
  const [rates, setRates] = useState({
    '2w': vehicleRates['2w'] != null ? String(vehicleRates['2w']) : '',
    '4w': vehicleRates['4w'] != null ? String(vehicleRates['4w']) : '',
    ev:   vehicleRates.ev   != null ? String(vehicleRates.ev)   : '',
  })
  const [options, setOptions] = useState(purposeOptions)
  const [points, setPoints] = useState(startPoints)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  async function handleSave() {
    if (!clientId) return
    setSaving(true); setMsg('')
    const nextRates = {
      '2w': rates['2w'] === '' ? null : parseFloat(rates['2w']),
      '4w': rates['4w'] === '' ? null : parseFloat(rates['4w']),
      ev:   rates.ev   === '' ? null : parseFloat(rates.ev),
    }
    // A negative or unreadable rate would auto-fill a negative Transport amount on every claim.
    if (Object.values(nextRates).some(r => r != null && !(Number.isFinite(r) && r >= 0))) {
      setSaving(false); setMsg('error:A rate per km must be a number of 0 or more — or leave it blank.'); return
    }
    // settings is ONE row per client, read by nine pages (S730). The lookup's error used to be
    // dropped (S751), so a failed read looked like "no row yet" and INSERTed a second one — after
    // which every `.maybeSingle()` settings read in the product fails on "multiple rows". So: a
    // failed read refuses to save, a found row is updated, and only a read that succeeded with no
    // row inserts. A duplicate that already exists surfaces here as that same read error.
    const { data: existing, error: readErr } = await supabase.from('settings').select('id').eq('client_id', clientId).maybeSingle()
    if (readErr) {
      setSaving(false)
      setMsg('error:The settings were not saved — the existing settings could not be read, and saving blind could split them in two. ' + errorLine(readErr))
      return
    }
    const payload = { tada_vehicle_rates: nextRates, tada_purpose_options: options, tada_start_points: points }
    // `.select('id')` on the update: a write RLS filters out is 0 rows with no error, which would
    // otherwise close the dialog as saved.
    const { data: written, error } = existing
      ? await supabase.from('settings').update(payload).eq('id', existing.id).select('id')
      : await supabase.from('settings').insert({ client_id: clientId, ...payload }).select('id')
    setSaving(false)
    if (error) { setMsg('error:The settings were not saved. ' + errorLine(error)); return }
    if (!written?.length) { setMsg('error:The settings were not saved — this login is not allowed to change them. Ask the Owner.'); return }
    onSaved(nextRates, options, points)
  }

  return (
    <Modal onClose={onClose} title="TADA Settings" maxWidth={460}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div>
          <div style={sectionLbl}>Rate / KM by Vehicle</div>
          <p style={{ margin: '2px 0 10px', fontSize: 12, color: 'var(--theme-text3)' }}>
            Used by the Transport line's auto-fill — Amount = Distance × the selected vehicle's rate.
          </p>
          <div style={{ display: 'flex', gap: 10 }}>
            {VEHICLE_TYPES.map(v => (
              <div key={v.key} style={{ flex: 1 }}>
                <label style={lbl} htmlFor={`tada-rate-${v.key}`}>{v.label} (NPR)</label>
                <input
                  id={`tada-rate-${v.key}`}
                  style={{ ...inp, width: '100%' }} type="number" min="0" step="0.5" placeholder="—"
                  value={rates[v.key]} onChange={e => setRates(r => ({ ...r, [v.key]: e.target.value }))}
                />
              </div>
            ))}
          </div>
        </div>

        <OptionListEditor
          label="Purpose Options"
          hint={'Preset choices for the New Claim form\'s Purpose dropdown. "Other" is always available for a one-off trip.'}
          placeholder="e.g. Vendor site visit"
          addLabel="Add a purpose option"
          options={options} setOptions={setOptions}
        />

        <OptionListEditor
          label="Start Points"
          hint={'Preset choices for the New Claim form\'s Start Point dropdown (where the trip began). "Other" is always available.'}
          placeholder="e.g. Head Office"
          addLabel="Add a start point"
          options={points} setOptions={setPoints}
        />

        {msg && (
          <p role={msg.startsWith('ok') ? 'status' : 'alert'}
            style={{ margin: 0, fontSize: 12, color: msg.startsWith('ok:') ? 'var(--theme-green-text)' : 'var(--theme-red-text)' }}>
            {msg.replace(/^(ok|error):/, '')}
          </p>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save Settings'}</button>
        </div>
      </div>
    </Modal>
  )
}
