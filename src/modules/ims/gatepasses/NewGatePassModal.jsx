import { useState, useMemo } from 'react'
import Modal from '../../../components/Modal'
import Tip from '../../../components/Tip'
import SearchableSelect from '../../../components/SearchableSelect'
import FieldError, { fieldAria } from '../../../components/FieldError'
import ActionError, { asActionError } from '../../../components/ActionError'

const PURPOSES = [
  { value: 'delivery', label: 'Delivery' },
  { value: 'pickup', label: 'Pickup' },
  { value: 'maintenance', label: 'Maintenance' },
  { value: 'other', label: 'Other' },
]

// Reports back via onSaved(payload) — GatePasses.jsx owns the actual insert+print, same
// "form reports back, parent commits" split as Purchases.js/PurchaseBillForm.jsx.
export default function NewGatePassModal({ vendors, onClose, onSaved }) {
  const [useExisting, setUseExisting] = useState(true)
  const [vendorId, setVendorId]       = useState('')
  const [vendorName, setVendorName]   = useState('')
  const [driverName, setDriverName]   = useState('')
  const [vehicleNumber, setVehicleNumber] = useState('')
  const [purpose, setPurpose]         = useState('delivery')
  const [notes, setNotes]             = useState('')
  const [saving, setSaving]           = useState(false)
  const [error, setError]             = useState(null)
  // Per-field validation; `error` above stays the form-level channel for a rejected write (S603).
  const [fieldErr, setFieldErr] = useState({})

  const vendorOptions = useMemo(() => vendors.map(v => ({ value: v.id, label: v.name })), [vendors])
  const selectedVendor = vendors.find(v => v.id === vendorId)

  async function handleSave() {
    const finalVendorName = useExisting ? (selectedVendor?.name || '') : vendorName.trim()
    const fe = {}
    if (!finalVendorName) fe.vendor = useExisting ? 'Select a vendor.' : 'Enter a company name.'
    if (!driverName.trim()) fe.driver = 'Driver name is required.'
    if (!vehicleNumber.trim()) fe.vehicle = 'Vehicle number is required.'
    setFieldErr(fe)
    if (Object.keys(fe).length) return
    setSaving(true); setError(null)
    const result = await onSaved({
      vendor_id: useExisting ? (vendorId || null) : null,
      vendor_name: finalVendorName,
      driver_name: driverName.trim(),
      vehicle_number: vehicleNumber.trim().toUpperCase(),
      purpose,
      notes: notes.trim() || null,
    })
    setSaving(false)
    if (result?.error) setError(asActionError(result.error))
  }

  return (
    <Modal onClose={onClose} title="New Gate Pass" maxWidth={480}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="form-field">
          <label htmlFor="newgat-f5">
            <Tip text="Link to an existing vendor, or type a company name for a one-off visitor" width={280}>
              Vendor / Company
            </Tip>
          </label>
          <div className="tab-bar" style={{ marginBottom: 8 }}>
            <button type="button" className={`tab-btn${useExisting ? ' tab-btn--active' : ''}`} onClick={() => setUseExisting(true)}>Existing Vendor</button>
            <button type="button" className={`tab-btn${!useExisting ? ' tab-btn--active' : ''}`} onClick={() => setUseExisting(false)}>Other / Company Name</button>
          </div>
          {useExisting ? (
            <SearchableSelect id="newgat-f5" value={vendorId} onChange={v => { setFieldErr(f => ({ ...f, vendor: '' })); setVendorId(v) }} options={vendorOptions} placeholder="— Select vendor —" />
          ) : (
            <input id="newgat-f5" value={vendorName} onChange={e => { setFieldErr(f => ({ ...f, vendor: '' })); setVendorName(e.target.value) }} placeholder="e.g. ABC Courier" {...fieldAria('newgat-f5', fieldErr.vendor)} />
          )}
          {/* One message for both branches: the two controls share `newgat-f5` (only one is ever
              mounted), so it sits outside the ternary rather than being written twice. */}
          <FieldError id="newgat-f5" message={fieldErr.vendor} />
        </div>
        <div className="form-field">
          <label htmlFor="newgat-f1">Driver Name *</label>
          <input id="newgat-f1" value={driverName} onChange={e => { setFieldErr(f => ({ ...f, driver: '' })); setDriverName(e.target.value) }} placeholder="Driver's name" {...fieldAria('newgat-f1', fieldErr.driver)} />
          <FieldError id="newgat-f1" message={fieldErr.driver} />
        </div>
        <div className="form-field">
          <label htmlFor="newgat-f2">Vehicle Number *</label>
          <input id="newgat-f2" value={vehicleNumber} onChange={e => { setFieldErr(f => ({ ...f, vehicle: '' })); setVehicleNumber(e.target.value) }} placeholder="e.g. BA 5 KHA 5678" {...fieldAria('newgat-f2', fieldErr.vehicle)} />
          <FieldError id="newgat-f2" message={fieldErr.vehicle} />
        </div>
        <div className="form-field">
          <label htmlFor="newgat-f3"><Tip text="Reason for this vehicle's visit — printed on the gate pass." width={240}>Purpose</Tip></label>
          <select id="newgat-f3" className="form-select" value={purpose} onChange={e => setPurpose(e.target.value)}>
            {PURPOSES.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </div>
        <div className="form-field">
          <label htmlFor="newgat-f4">Notes</label>
          <textarea id="newgat-f4" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional" rows={2}
            style={{ background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', padding: '7px 10px', fontSize: 13, color: 'var(--theme-text1)', outline: 'none', width: '100%', boxSizing: 'border-box', resize: 'vertical', fontFamily: 'inherit' }} />
        </div>
      </div>
      <ActionError error={error} />
      <div className="form-actions" style={{ justifyContent: 'flex-end' }}>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : 'Issue & Print'}
        </button>
      </div>
    </Modal>
  )
}
