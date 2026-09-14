import { useState } from 'react'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import Modal from '../../../components/Modal'
import Tip from '../../../components/Tip'
import FieldError, { fieldAria } from '../../../components/FieldError'
import { invalidStyle } from '../../../shared/inlineFieldState'
import { errorLine } from '../../../shared/errorText'

const inp = {
  background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)',
  borderRadius: 0, padding: '7px 10px', fontSize: 13, color: 'var(--theme-text1)',
  outline: 'none', width: '100%', fontFamily: 'inherit',
}
const lbl = { fontSize: 11, color: 'var(--theme-text3)', marginBottom: 4, display: 'block' }
const EMPTY = { id: null, name: '', calc_type: 'manual', default_value: '', prorate_by_service: false, active: true }

const CALC_LABEL = { fixed: 'Fixed amount', percent_of_basic: '% of monthly basic', manual: 'Typed by hand each run' }

const PRORATE_TIP = 'The bonus is multiplied by completed months worked up to the 15th of the month it is paid, ÷ 12 (a full year counts as 12). Example: a NPR 6,000 bonus for a cook who joined 4 months before pays NPR 2,000; someone with a year or more gets the full NPR 6,000.'

// "Manage Incentive Types" modal — add/edit/(de)activate/delete on hr_incentive_configs, the reusable
// bonus TYPES an owner defines once ("Sales Bonus", "Attendance Bonus"). IncentiveRun.jsx seeds a
// run's amounts from one, and a generated run keeps its type (config_id), so editing a type here
// changes what Recompute writes on a DRAFT run that uses it — never a finalized one.
export default function IncentiveConfigs({ configs, onClose, onChanged }) {
  const { scopedInsert, scopedUpdate, scopedDelete } = useScopedDb()
  const [form, setForm] = useState(EMPTY)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  // Per-field validation; `error` above stays the form-level channel for a rejected write (S603).
  const [nameErr, setNameErr] = useState('')
  const [valueErr, setValueErr] = useState('')

  const editing = !!form.id

  function set(f, v) {
    if (f === 'name') setNameErr('')
    if (f === 'default_value' || f === 'calc_type') setValueErr('')
    setForm(p => ({ ...p, [f]: v }))
  }

  function startEdit(cfg) {
    setError(''); setNameErr(''); setValueErr('')
    setForm({
      id: cfg.id, name: cfg.name || '', calc_type: cfg.calc_type || 'manual',
      default_value: cfg.calc_type === 'manual' ? '' : String(cfg.default_value ?? ''),
      prorate_by_service: !!cfg.prorate_by_service, active: cfg.active !== false,
    })
  }
  function cancelEdit() { setForm(EMPTY); setError(''); setNameErr(''); setValueErr('') }

  // A negative or non-numeric value is refused here as well as by the database; a percentage above
  // 100 would pay more than a whole month's basic, which is never what "% of basic" was meant to do.
  function validate() {
    let ok = true
    if (!form.name.trim()) { setNameErr('Enter a name.'); ok = false }
    let value = 0
    if (form.calc_type !== 'manual') {
      const raw = String(form.default_value).trim()
      const n = raw === '' ? NaN : Number(raw)
      if (!Number.isFinite(n) || n < 0) { setValueErr(form.calc_type === 'fixed' ? 'Enter an amount of 0 or more.' : 'Enter a percentage of 0 or more.'); ok = false }
      else if (form.calc_type === 'percent_of_basic' && n > 100) { setValueErr('Above 100% pays more than a whole month’s basic — enter 100 or less.'); ok = false }
      else value = Math.round(n * 100) / 100
    }
    return ok ? value : null
  }

  async function handleSave() {
    const value = validate()
    if (value === null) return
    setError(''); setSaving(true)
    const payload = {
      name: form.name.trim(), calc_type: form.calc_type, default_value: value,
      prorate_by_service: !!form.prorate_by_service,
    }
    if (editing) {
      // A refused RLS update returns 0 rows and no error, so the count is checked (S751).
      const { data, error: err } = await scopedUpdate('hr_incentive_configs', { ...payload, active: !!form.active }).eq('id', form.id).select('id')
      setSaving(false)
      if (err || !data?.length) { setError(`"${payload.name}" was not saved. ` + (err ? errorLine(err) : 'It may have been deleted in another tab, or this login cannot change bonus types.')); onChanged(); return }
    } else {
      const { error: err } = await scopedInsert('hr_incentive_configs', payload)
      setSaving(false)
      if (err) { setError('The incentive type was not added. ' + errorLine(err)); return }
    }
    setForm(EMPTY); onChanged()
  }

  async function toggleActive(cfg) {
    setError('')
    const { data, error: err } = await scopedUpdate('hr_incentive_configs', { active: !cfg.active }).eq('id', cfg.id).select('id')
    if (err || !data?.length) { setError(`"${cfg.name}" was not ${cfg.active ? 'deactivated' : 'activated'}. ` + (err ? errorLine(err) : 'It may have been deleted in another tab, or this login cannot change bonus types.')); onChanged(); return }
    onChanged()
  }

  async function handleDelete(cfg) {
    // Routine single-row delete, so the native confirm stays — but it says what really happens: a
    // run keeps its amounts, and loses its type (config_id is SET NULL), so Recompute on a draft
    // run then keeps the amounts and only re-works tax.
    if (!window.confirm(`Delete "${cfg.name}"? Runs generated with it keep their amounts but lose their type, so Recompute on a draft run will no longer re-seed amounts from it. Deactivate instead to hide it from new runs.`)) return
    setError('')
    const { data, error: err } = await scopedDelete('hr_incentive_configs').eq('id', cfg.id).select('id')
    if (err || !data?.length) { setError(`"${cfg.name}" was not deleted. ` + (err ? errorLine(err) : 'It may already have been deleted, or this login cannot change bonus types.')); onChanged(); return }
    if (form.id === cfg.id) setForm(EMPTY)
    onChanged()
  }

  return (
    <Modal onClose={onClose} title="Manage Incentive Types" maxWidth={540}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {configs.length === 0 && <p style={{ fontSize: 13, color: 'var(--theme-text3)' }}>No incentive types yet — add one below.</p>}
          {configs.map(cfg => (
            <div key={cfg.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', background: 'var(--theme-input-bg)', borderRadius: 0, opacity: cfg.active ? 1 : 0.6, outline: form.id === cfg.id ? '1px solid var(--theme-accent)' : 'none' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text1)' }}>{cfg.name}{!cfg.active && <span style={{ fontWeight: 400, color: 'var(--theme-text3)' }}> · inactive</span>}</div>
                <div style={{ fontSize: 11, color: 'var(--theme-text3)' }}>
                  {CALC_LABEL[cfg.calc_type]}{cfg.calc_type !== 'manual' && ` — ${cfg.calc_type === 'percent_of_basic' ? `${cfg.default_value}%` : `NPR ${cfg.default_value}`}`}
                  {cfg.prorate_by_service && ' · reduced for months worked'}
                </div>
              </div>
              <button className="btn btn-ghost btn-sm" onClick={() => startEdit(cfg)} disabled={saving}>Edit</button>
              <button className="btn btn-ghost btn-sm" onClick={() => toggleActive(cfg)} disabled={saving}>
                {cfg.active ? 'Deactivate' : 'Activate'}
              </button>
              <button className="btn btn-danger btn-sm" onClick={() => handleDelete(cfg)} disabled={saving}>Delete</button>
            </div>
          ))}
        </div>

        <div style={{ borderTop: '1px solid var(--theme-border)', paddingTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label style={lbl} htmlFor="inccfg-name">{editing ? 'Edit Incentive Type' : 'New Incentive Type'}</label>
          <input id="inccfg-name" style={invalidStyle(inp, nameErr)} placeholder="e.g. Sales Bonus" value={form.name} onChange={e => set('name', e.target.value)} {...fieldAria('inccfg-name', nameErr)} />
          <FieldError id="inccfg-name" message={nameErr} />
          <div style={{ display: 'flex', gap: 10 }}>
            <select aria-label="How this incentive is calculated" className="form-select" style={{ flex: 1 }} value={form.calc_type} onChange={e => set('calc_type', e.target.value)}>
              <option value="manual">{CALC_LABEL.manual}</option>
              <option value="fixed">{CALC_LABEL.fixed}</option>
              <option value="percent_of_basic">{CALC_LABEL.percent_of_basic}</option>
            </select>
            {form.calc_type !== 'manual' && (
              <input id="inccfg-value" style={{ ...invalidStyle(inp, valueErr), width: 120 }} type="number" min="0" max={form.calc_type === 'percent_of_basic' ? 100 : undefined}
                aria-label={form.calc_type === 'percent_of_basic' ? 'Percent of monthly basic' : 'Amount in NPR'}
                placeholder={form.calc_type === 'percent_of_basic' ? '%' : 'NPR'}
                value={form.default_value} onChange={e => set('default_value', e.target.value)} {...fieldAria('inccfg-value', valueErr)} />
            )}
          </div>
          {form.calc_type !== 'manual' && <FieldError id="inccfg-value" message={valueErr} />}
          {form.calc_type === 'percent_of_basic' && (
            <div style={{ fontSize: 11, color: 'var(--theme-text3)', lineHeight: 1.5 }}>
              A share of a monthly salary. Daily and hourly staff have a day or hour rate instead, so their rows start at 0 and are typed by hand.
            </div>
          )}
          {form.calc_type !== 'manual' && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--theme-text1)' }}>
              <input type="checkbox" checked={form.prorate_by_service} onChange={e => set('prorate_by_service', e.target.checked)} />
              <Tip text={PRORATE_TIP} width={320}>Reduce for months worked</Tip>
            </label>
          )}
          {editing && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--theme-text1)' }}>
              <input type="checkbox" checked={form.active} onChange={e => set('active', e.target.checked)} />
              Active (offered for new runs)
            </label>
          )}
          {editing && (
            <div style={{ fontSize: 11, color: 'var(--theme-text3)', lineHeight: 1.5 }}>
              Runs already generated keep their amounts. Recompute on a draft run that uses this type will use the new setting; finalized runs never change.
            </div>
          )}
          {error && <div role="alert" style={{ fontSize: 12, color: 'var(--theme-red-text)' }}>{error}</div>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            {editing && <button className="btn btn-ghost" onClick={cancelEdit} disabled={saving}>Cancel</button>}
            <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : editing ? 'Save Changes' : '+ Add Type'}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
