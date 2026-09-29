import { useState } from 'react'
import Modal from '../../../components/Modal'
import Tip from '../../../components/Tip'
import QtyInput from '../../../components/QtyInput'
import SearchableSelect from '../../../components/SearchableSelect'
import FieldError, { fieldAria } from '../../../components/FieldError'
import ActionError, { asActionError } from '../../../components/ActionError'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { useConfirm } from '../../../shared/hooks/useConfirm'
import { withTimeout } from '../../../utils/withTimeout'
import { formatAdAsBs } from '../../../utils/bsCalendar'
import { nprInt } from '../../../shared/nepalMoney'
import { POOL_LABELS, POOL_EXAMPLES } from './taxPoolConstants'
import { bookPositionsByAsset, depreciationInputChanges } from './depreciationCompute'
import { fiscalYearOfAdDate } from './taxPoolCompute'

// S792 (COSTS-8, the D5 precedent): what an edit to the figures depreciation is worked out from
// does to an asset that already has depreciation posted, as the paragraphs of a confirm dialog.
// `posted` is { charged, runs } from the asset's posted schedule, or { unknown: true } when that
// read failed — a check that could not run has not passed, so the dialog still appears and says
// it could not count. Posted runs are immutable, so none of this rewrites them; what moves is the
// book value (cost less posted charges, everywhere it is shown, past valuation dates included), the
// next run's charge, and which fiscal year the Tax Depreciation tab counts the asset in.
function editConsequences({ asset, changes, posted, taxPool }) {
  const npr = v => `NPR ${nprInt(v)}`
  const p = []
  p.push(posted.unknown
    ? 'Crest could not check whether depreciation has been posted for this asset, so it cannot say how much has already been charged. Posted runs are locked and keep their figures either way.'
    : `${npr(posted.charged)} of depreciation is already posted for this asset, in ${posted.runs} run${posted.runs === 1 ? '' : 's'}. Those runs are locked and keep their figures.`)
  if (changes.cost) {
    p.push(`Cost goes from ${npr(changes.cost.from)} to ${npr(changes.cost.to)}. ` + (posted.unknown
      ? 'Its book value becomes the new cost less whatever depreciation is posted'
      : `Its book value becomes ${npr(changes.cost.to - posted.charged)} (the new cost less the depreciation already posted)`)
      + ' on the Register, the Asset Card and the Valuation report, including for dates already valued.')
  }
  if (changes.acquired) {
    p.push(`Acquisition date goes from ${formatAdAsBs(changes.acquired.from)} to ${formatAdAsBs(changes.acquired.to)}. Posted runs are not re-dated; the next run, or a disposal, counts the days held from the new date.`)
  }
  if (changes.opening || changes.openingAsOf) {
    const from = changes.opening ? changes.opening.from : parseFloat(asset.opening_accumulated_depreciation) || 0
    const to = changes.opening ? changes.opening.to : from
    const asOf = changes.openingAsOf ? changes.openingAsOf.to : asset.opening_as_of
    p.push(`Depreciation already taken before Crest goes from ${npr(from)}${asset.opening_as_of ? ` (to ${formatAdAsBs(asset.opening_as_of)})` : ''} to ${npr(to)}${to > 0 && asOf ? ` (to ${formatAdAsBs(asOf)})` : ''}. `
      + 'Its book value moves by the difference on the Register, the Asset Card and the Valuation report. Posted runs are not re-worked, so if they already charged days now covered by the new date, those days are charged twice — reverse that run on the Depreciation Runs tab (Adjustment) to take them back out. The next run charges from the day after the new date.')
  }
  if (Math.abs(changes.annual.from - changes.annual.to) > 0.005) {
    p.push(`Runs from now on charge ${npr(changes.annual.to)} a year instead of ${npr(changes.annual.from)}${changes.salvage ? `, and never take it below the new salvage value of ${npr(changes.salvage.to)}` : ''}.`)
  }
  if (taxPool && (changes.cost || changes.acquired)) {
    const oldFy = fiscalYearOfAdDate(asset.acquisition_date)
    const newFy = changes.acquired ? fiscalYearOfAdDate(changes.acquired.to) : oldFy
    p.push(oldFy !== newFy
      ? `Tax Depreciation counts it as bought in FY ${newFy} instead of FY ${oldFy}. A schedule already posted keeps it as it was, so if FY ${oldFy} is posted, check that FY ${newFy} does not count it a second time.`
      : `Tax Depreciation counts it at the new cost only in FY ${oldFy}, the year it was bought, and only if that year's schedule is not posted yet; a posted schedule keeps the old figures.`)
  }
  return p.map((t, i) => <p key={i} style={{ margin: i === p.length - 1 ? 0 : '0 0 8px' }}>{t}</p>)
}

function emptyForm() {
  return {
    category_id: '', name: '', description: '', location: '',
    quantity: '1', unit_cost: '', acquisition_date: '', useful_life_years: '',
    salvage_value: '0', tax_pool: '', personal_use_percent: '0', department: '', notes: '',
    opening_accumulated_depreciation: '0', opening_as_of: '',
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
    opening_accumulated_depreciation: String(asset.opening_accumulated_depreciation ?? 0),
    opening_as_of: asset.opening_as_of || '',
  }
}

// Add/Edit a fixed asset. Category picker seeds useful_life_years/tax_pool from the category's
// own defaults on select, then leaves both freely editable — never re-locked — exact shape of
// PurchaseBillForm.jsx's item_id handler (seed once, no further coupling to the source field).
export default function AssetFormModal({ categories, asset, onClose, onSaved }) {
  const { scopedFrom, scopedInsert, scopedUpdate } = useScopedDb()
  const { ask: askConfirm, confirmEl } = useConfirm()
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
    // D40: the same bounds the database's CHECKs hold, said against the box that breaks them.
    const openingAmt = parseFloat(form.opening_accumulated_depreciation) || 0
    const cost = (parseFloat(form.quantity) || 0) * (parseFloat(form.unit_cost) || 0)
    const salvage = parseFloat(form.salvage_value) || 0
    if (openingAmt < 0) fe.opening_accumulated_depreciation = 'Enter 0 or more.'
    else if (openingAmt > 0 && openingAmt + salvage > cost + 0.005) {
      fe.opening_accumulated_depreciation = `At most NPR ${nprInt(Math.max(0, cost - salvage))} — more would take the asset below its salvage value.`
    }
    if (openingAmt > 0 && !form.opening_as_of) fe.opening_as_of = 'Say which date that figure runs to.'
    else if (openingAmt > 0 && form.acquisition_date && form.opening_as_of < form.acquisition_date) fe.opening_as_of = 'This date is before the acquisition date.'
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
      // D40: the date means nothing without an amount, so a 0 clears it.
      opening_accumulated_depreciation: openingAmt > 0 ? openingAmt : 0,
      opening_as_of: openingAmt > 0 ? form.opening_as_of : null,
    }

    // S792 (COSTS-8, D5): an edit to cost, dates, life or salvage on an asset with posted
    // depreciation re-values it without touching the locked runs — so it is a decision, named
    // before it lands. The posted schedule is read here rather than on open, so the answer is
    // current at the moment of saving.
    const changes = asset ? depreciationInputChanges(asset, payload) : null
    if (changes) {
      let posted
      try {
        const { data, error: readErr } = await withTimeout(scopedFrom('assets_depreciation_schedule', 'id, asset_id, period_start, period_end, depreciation_amount, override_amount')
          .eq('asset_id', asset.id).eq('is_posted', true).order('id'), 20000, 'Checking posted depreciation')
        const position = readErr ? null : bookPositionsByAsset(data)[asset.id]
        posted = readErr ? { unknown: true } : { charged: position?.charged || 0, runs: position?.rows || 0 }
      } catch (_) {
        posted = { unknown: true }
      }
      if (posted.unknown || posted.runs > 0) {
        setSaving(false)
        askConfirm({
          title: 'Change the figures this asset is depreciated from?',
          body: editConsequences({ asset, changes, posted, taxPool: payload.tax_pool || asset.tax_pool }),
          confirmLabel: 'Save changes',
          busyLabel: 'Saving…',
          run: () => write(payload),
        })
        return
      }
    }
    await write(payload)
  }

  async function write(payload) {
    setSaving(true); setError('')
    const { error: err } = asset
      ? await scopedUpdate('assets_register', { ...payload, updated_at: new Date().toISOString() }).eq('id', asset.id)
      : await scopedInsert('assets_register', payload)

    setSaving(false)
    if (err) { setError(asActionError(err)); return }
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
          <input id="assetf-f6" className="form-input" value={totalCost.toLocaleString('en-IN')} disabled />
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

        {/* D40: an asset the business already owned before Crest has depreciation on last year's
            books. Without this it would depreciate from full cost a second time. */}
        <div className="form-field" style={{ gridColumn: '1 / -1', marginTop: 4 }}>
          <h4 style={{ margin: 0, fontSize: 12, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            <Tip text="Only for something you owned before you started using Crest. Copy its accumulated depreciation from last year's books (your accountant's fixed-asset schedule), so Crest carries on from there instead of depreciating it from full cost again. Leave it at 0 for anything bought since." width={320}>Already in use before Crest?</Tip>
          </h4>
        </div>
        <div className="form-field">
          <label htmlFor="assetf-f15"><Tip text="Book depreciation already charged on this asset before Crest, up to the date beside it. Its book value becomes cost less this, less what Crest posts. It is not an expense of any period here, so the Overheads depreciation line does not count it." width={300}>Depreciation already taken (NPR)</Tip></label>
          <QtyInput id="assetf-f15" value={form.opening_accumulated_depreciation} onChange={v => set('opening_accumulated_depreciation', v)} className="form-input" style={{ width: '100%' }} {...fieldAria('assetf-f15', fieldErr.opening_accumulated_depreciation)} />
          <FieldError id="assetf-f15" message={fieldErr.opening_accumulated_depreciation} />
        </div>
        <div className="form-field">
          <label htmlFor="assetf-f16"><Tip text="The date that figure runs to — usually the last day of the fiscal year your books were closed for (end of Ashadh). Crest's depreciation runs charge from the day after it." width={280}>As of</Tip></label>
          <input id="assetf-f16" type="date" className="form-input" value={form.opening_as_of} onChange={e => set('opening_as_of', e.target.value)} {...fieldAria('assetf-f16', fieldErr.opening_as_of)} />
          <FieldError id="assetf-f16" message={fieldErr.opening_as_of} />
          {form.opening_as_of && <p style={{ fontSize: 11, color: 'var(--theme-text3)', margin: '4px 0 0' }}>{formatAdAsBs(form.opening_as_of)}</p>}
        </div>
        <div className="form-field" aria-hidden="true" />

        <div className="form-field" style={{ gridColumn: '1 / -1' }}>
          <label htmlFor="assetf-f13">Description</label>
          <input id="assetf-f13" className="form-input" value={form.description} onChange={e => set('description', e.target.value)} style={{ width: '100%' }} />
        </div>
        <div className="form-field" style={{ gridColumn: '1 / -1' }}>
          <label htmlFor="assetf-f14">Notes</label>
          <textarea id="assetf-f14" className="form-input" value={form.notes} onChange={e => set('notes', e.target.value)} rows={2} style={{ width: '100%', resize: 'vertical' }} />
        </div>
      </div>

      <ActionError error={error} />
      <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginTop: 16 }}>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
      {confirmEl}
    </Modal>
  )
}
