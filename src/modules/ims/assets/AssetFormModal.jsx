import { useState } from 'react'
import Modal from '../../../components/Modal'
import Tip from '../../../components/Tip'
import QtyInput from '../../../components/QtyInput'
import SearchableSelect from '../../../components/SearchableSelect'
import FieldError, { fieldAria } from '../../../components/FieldError'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { POOL_LABELS, POOL_EXAMPLES } from './taxPoolConstants'

function emptyForm() {
  return {
    category_id: '', name: '', description: '', location: '',
    quantity: '1', unit_cost: '', acquisition_date: '', useful_life_years: '',
    salvage_value: '0', tax_pool: '', personal_use_percent: '0', department: '', notes: '',
  }
}

function formFromAsset(asset) {
  return {
    category_id: asset.category_id || '',
    name: asset.name || '',
    description: asset.description || '',
    location: asset.location || '',
    quantity: String(asset.quantity ?? 1),
    unit_cost: String(asset.unit_cost ?? ''),
    acquisition_date: asset.acquisition_date || '',
    useful_life_years: String(asset.useful_life_years ?? ''),
    salvage_value: String(asset.salvage_value ?? 0),
    tax_pool: asset.tax_pool || '',
    personal_use_percent: String(asset.personal_use_percent ?? 0),
    department: asset.department || '',
    notes: asset.notes || '',
  }
}

// Add/Edit a fixed asset. Category picker seeds useful_life_years/tax_pool from the category's
// own defaults on select, then leaves both freely editable — never re-locked — exact shape of
// PurchaseBillModal.jsx's item_id handler (seed once, no further coupling to the source field).
export default function AssetFormModal({ categories, asset, onClose, onSaved }) {
  const { scopedInsert, scopedUpdate } = useScopedDb()
  const [form, setForm] = useState(() => asset ? formFromAsset(asset) : emptyForm())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  // Per-field validation; `error` above stays the form-level channel for a rejected write (S603).
  const [fieldErr, setFieldErr] = useState({})

  const categoryOptions = categories.map(c => ({ value: c.id, label: c.name }))

  function set(field, value) {
    // Editing a field clears its own error — a border still red under a corrected box teaches the
    // user that these messages are stale and worth ignoring.
    setFieldErr(e => (e[field] ? { ...e, [field]: '' } : e))
    setForm(f => {
      const next = { ...f, [field]: value }
      if (field === 'category_id') {
        const cat = categories.find(c => c.id === value)
        if (cat?.default_useful_life_years != null && !f.useful_life_years) {
          next.useful_life_years = String(cat.default_useful_life_years)
        }
        if (cat?.tax_pool_hint && !f.tax_pool) next.tax_pool = cat.tax_pool_hint
      }
      return next
    })
  }

  async function save() {
    const fe = {}
    if (!form.name.trim()) fe.name = 'Name is required.'
    if (!form.acquisition_date) fe.acquisition_date = 'Acquisition date is required.'
    if (!form.useful_life_years || parseFloat(form.useful_life_years) <= 0) fe.useful_life_years = 'Useful life must be greater than 0.'
    setFieldErr(fe)
    if (Object.keys(fe).length) return

    setSaving(true); setError('')
    const payload = {
      category_id: form.category_id || null,
      name: form.name.trim(),
      description: form.description.trim() || null,
      location: form.location.trim() || null,
      quantity: parseFloat(form.quantity) || 1,
      unit_cost: parseFloat(form.unit_cost) || 0,
      acquisition_date: form.acquisition_date,
      useful_life_years: parseFloat(form.useful_life_years),
      salvage_value: parseFloat(form.salvage_value) || 0,
      tax_pool: form.tax_pool || null,
      personal_use_percent: parseFloat(form.personal_use_percent) || 0,
      department: form.department.trim() || null,
      notes: form.notes.trim() || null,
    }

    const { error: err } = asset
      ? await scopedUpdate('assets_register', { ...payload, updated_at: new Date().toISOString() }).eq('id', asset.id)
      : await scopedInsert('assets_register', payload)

    setSaving(false)
    if (err) { setError(err.message); return }
    onSaved()
  }

  const totalCost = (parseFloat(form.quantity) || 0) * (parseFloat(form.unit_cost) || 0)

  return (
    <Modal onClose={onClose} title={asset ? `Edit ${asset.asset_code || 'Asset'}` : 'Add Asset'} maxWidth={720}>
      <div className="form-grid form-grid-3">
        <div className="form-field">
          <label htmlFor="assetf-f1">Category</label>
          <SearchableSelect id="assetf-f1" value={form.category_id} onChange={v => set('category_id', v)} options={categoryOptions} placeholder="— No category —" />
        </div>
        <div className="form-field">
          <label htmlFor="assetf-f2">Name</label>
          <input id="assetf-f2" className="form-input" value={form.name} onChange={e => set('name', e.target.value)} placeholder="e.g. Commercial Refrigerator" {...fieldAria('assetf-f2', fieldErr.name)} />
          <FieldError id="assetf-f2" message={fieldErr.name} />
        </div>
        <div className="form-field">
          <label htmlFor="assetf-f3"><Tip text="Which physical station or area this asset lives — e.g. Kitchen, Front of House, Storage." width={230}>Location</Tip></label>
          <input id="assetf-f3" className="form-input" value={form.location} onChange={e => set('location', e.target.value)} placeholder="e.g. Kitchen" />
        </div>

        <div className="form-field">
          <label htmlFor="assetf-f4">Quantity</label>
          <QtyInput id="assetf-f4" value={form.quantity} onChange={v => set('quantity', v)} className="form-input" style={{ width: '100%' }} />
        </div>
        <div className="form-field">
          <label htmlFor="assetf-f5">Unit Cost (NPR)</label>
          <QtyInput id="assetf-f5" value={form.unit_cost} onChange={v => set('unit_cost', v)} className="form-input" style={{ width: '100%' }} />
        </div>
        <div className="form-field">
          <label htmlFor="assetf-f6">Total Cost (NPR)</label>
          {/* A computed figure, never typed into. The inline `color: text2` this used to carry was a
              per-site guess at a disabled treatment that did not exist; `.form-select:disabled` in
              Layout.css owns it now, and keeps the number readable rather than dimming it. */}
          <input id="assetf-f6" className="form-input" value={totalCost.toLocaleString('en-NP')} disabled />
        </div>

        <div className="form-field">
          <label htmlFor="assetf-f7">Acquisition Date</label>
          <input id="assetf-f7" type="date" className="form-input" value={form.acquisition_date} onChange={e => set('acquisition_date', e.target.value)} {...fieldAria('assetf-f7', fieldErr.acquisition_date)} />
          <FieldError id="assetf-f7" message={fieldErr.acquisition_date} />
        </div>
        <div className="form-field">
          <label htmlFor="assetf-f8"><Tip text="Auto-fills from the category's default when you pick one — still editable per asset." width={250}>Useful Life (years)</Tip></label>
          <QtyInput id="assetf-f8" value={form.useful_life_years} onChange={v => set('useful_life_years', v)} className="form-input" style={{ width: '100%' }} {...fieldAria('assetf-f8', fieldErr.useful_life_years)} />
          <FieldError id="assetf-f8" message={fieldErr.useful_life_years} />
        </div>
        <div className="form-field">
          <label htmlFor="assetf-f9"><Tip text="Estimated value at the end of its useful life — depreciation never brings NBV below this." width={250}>Salvage Value (NPR)</Tip></label>
          <QtyInput id="assetf-f9" value={form.salvage_value} onChange={v => set('salvage_value', v)} className="form-input" style={{ width: '100%' }} />
        </div>

        <div className="form-field">
          <label htmlFor="assetf-f10"><Tip text="For the annual tax filing on the Tax Depreciation (IRD) tab — not used for the Depreciation Runs tab. Nepal groups assets into 5 pools by type rather than depreciating each item separately. Auto-fills from the category, still editable per asset. Not sure which one? Pick '— Not tracked —' and ask your accountant later; nothing else on this page is affected." width={320}>Tax Pool</Tip></label>
          <select id="assetf-f10" className="form-select" value={form.tax_pool} onChange={e => set('tax_pool', e.target.value)}>
            <option value="">— Not tracked —</option>
            {['A', 'B', 'C', 'D', 'E'].map(p => <option key={p} value={p}>{POOL_LABELS[p]}</option>)}
          </select>
          {form.tax_pool && (
            <p style={{ fontSize: 11, color: 'var(--theme-text3)', margin: '4px 0 0', fontStyle: 'italic' }}>
              e.g. {POOL_EXAMPLES[form.tax_pool]}
            </p>
          )}
        </div>
        <div className="form-field">
          <label htmlFor="assetf-f11"><Tip text="Percentage of this asset's use that's personal rather than business. Reports default to filtering this to 0% — apportioned depreciation for a non-zero value isn't calculated in v1." width={300}>Personal Use %</Tip></label>
          <QtyInput id="assetf-f11" value={form.personal_use_percent} onChange={v => set('personal_use_percent', v)} className="form-input" style={{ width: '100%' }} />
        </div>
        <div className="form-field">
          <label htmlFor="assetf-f12">Department / Cost Center</label>
          <input id="assetf-f12" className="form-input" value={form.department} onChange={e => set('department', e.target.value)} placeholder="e.g. Kitchen" />
        </div>

        <div className="form-field" style={{ gridColumn: '1 / -1' }}>
          <label htmlFor="assetf-f13">Description</label>
          <input id="assetf-f13" className="form-input" value={form.description} onChange={e => set('description', e.target.value)} style={{ width: '100%' }} />
        </div>
        <div className="form-field" style={{ gridColumn: '1 / -1' }}>
          <label htmlFor="assetf-f14">Notes</label>
          <textarea id="assetf-f14" className="form-input" value={form.notes} onChange={e => set('notes', e.target.value)} rows={2} style={{ width: '100%', resize: 'vertical' }} />
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16 }}>
        {error && <span style={{ color: 'var(--theme-red-text)', fontSize: 12 }}>{error}</span>}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </Modal>
  )
}
