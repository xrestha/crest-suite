import { useState } from 'react'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import Modal from '../../../components/Modal'
import FieldError, { fieldAria } from '../../../components/FieldError'
import { invalidStyle } from '../../../shared/inlineFieldState'

const inp = {
  background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)',
  borderRadius: 6, padding: '7px 10px', fontSize: 13, color: 'var(--theme-text1)',
  outline: 'none', width: '100%', fontFamily: 'inherit',
}
const lbl = { fontSize: 11, color: 'var(--theme-text3)', marginBottom: 4, display: 'block' }
const EMPTY = { name: '', calc_type: 'manual', default_value: '' }

const CALC_LABEL = { fixed: 'Fixed amount', percent_of_basic: '% of basic', manual: 'Manual entry each run' }

// "Manage Incentive Types" modal — CRUD on hr_incentive_configs (the reusable bonus TYPES an
// admin defines once, e.g. "Sales Bonus", "Attendance Bonus"). IncentiveRun.jsx picks one of
// these per run to seed draft amounts; this modal never touches hr_incentives itself.
export default function IncentiveConfigs({ configs, onClose, onChanged }) {
  const { scopedInsert, scopedUpdate, scopedDelete } = useScopedDb()
  const [form, setForm] = useState(EMPTY)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  // Per-field validation; `error` above stays the form-level channel for a rejected write (S603).
  const [nameErr, setNameErr] = useState('')

  function set(f, v) {
    if (f === 'name') setNameErr('')
    setForm(p => ({ ...p, [f]: v }))
  }

  async function handleAdd() {
    if (!form.name.trim()) { setNameErr('Enter a name.'); return }
    setNameErr('')
    setError(''); setSaving(true)
    const { error: err } = await scopedInsert('hr_incentive_configs', {
      name: form.name.trim(), calc_type: form.calc_type,
      default_value: parseFloat(form.default_value) || 0,
    })
    setSaving(false)
    if (err) { setError(err.message); return }
    setForm(EMPTY); onChanged()
  }

  async function toggleActive(cfg) {
    await scopedUpdate('hr_incentive_configs', { active: !cfg.active }).eq('id', cfg.id)
    onChanged()
  }

  async function handleDelete(cfg) {
    if (!window.confirm(`Delete "${cfg.name}"? Past runs using it keep their own snapshot and are unaffected.`)) return
    await scopedDelete('hr_incentive_configs').eq('id', cfg.id)
    onChanged()
  }

  return (
    <Modal onClose={onClose} title="Manage Incentive Types" maxWidth={520}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {configs.length === 0 && <p style={{ fontSize: 13, color: 'var(--theme-text3)' }}>No incentive types yet — add one below.</p>}
          {configs.map(cfg => (
            <div key={cfg.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', background: 'var(--theme-input-bg)', borderRadius: 6, opacity: cfg.active ? 1 : 0.5 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text1)' }}>{cfg.name}</div>
                <div style={{ fontSize: 11, color: 'var(--theme-text3)' }}>
                  {CALC_LABEL[cfg.calc_type]}{cfg.calc_type !== 'manual' && ` — ${cfg.default_value}${cfg.calc_type === 'percent_of_basic' ? '%' : ' NPR'}`}
                </div>
              </div>
              <button className="btn btn-ghost" style={{ fontSize: 11, padding: '3px 8px' }} onClick={() => toggleActive(cfg)}>
                {cfg.active ? 'Deactivate' : 'Activate'}
              </button>
              <button style={{ background: 'none', border: 'none', color: 'var(--theme-red-text)', cursor: 'pointer', fontSize: 12 }} onClick={() => handleDelete(cfg)}>Delete</button>
            </div>
          ))}
        </div>

        <div style={{ borderTop: '1px solid var(--theme-border)', paddingTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label style={lbl} htmlFor="inccfg-name">New Incentive Type</label>
          <input id="inccfg-name" style={invalidStyle(inp, nameErr)} placeholder="e.g. Sales Bonus" value={form.name} onChange={e => set('name', e.target.value)} {...fieldAria('inccfg-name', nameErr)} />
          <FieldError id="inccfg-name" message={nameErr} />
          <div style={{ display: 'flex', gap: 10 }}>
            <select aria-label="How this incentive is calculated" className="form-select" style={{ flex: 1 }} value={form.calc_type} onChange={e => set('calc_type', e.target.value)}>
              <option value="manual">Manual entry each run</option>
              <option value="fixed">Fixed amount</option>
              <option value="percent_of_basic">% of basic</option>
            </select>
            {form.calc_type !== 'manual' && (
              <input style={{ ...inp, width: 120 }} type="number" min="0"
                aria-label={form.calc_type === 'percent_of_basic' ? 'Default percent of basic' : 'Default amount in NPR'}
                placeholder={form.calc_type === 'percent_of_basic' ? '%' : 'NPR'}
                value={form.default_value} onChange={e => set('default_value', e.target.value)} />
            )}
          </div>
          {error && <div role="alert" style={{ fontSize: 12, color: 'var(--theme-red-text)' }}>{error}</div>}
          <button className="btn btn-primary" style={{ alignSelf: 'flex-end' }} onClick={handleAdd} disabled={saving}>
            {saving ? 'Adding…' : '+ Add Type'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
