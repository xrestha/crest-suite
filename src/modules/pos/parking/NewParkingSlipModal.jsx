import { useState, useEffect } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import Modal from '../../../components/Modal'
import Tip from '../../../components/Tip'
import SearchableSelect from '../../../components/SearchableSelect'
import { getBsToday, BS_MONTHS } from '../../../utils/bsCalendar'
import { printParkingSlip } from './parkingSlipHtml'

const VEHICLE_TYPES = ['Two Wheeler', 'Four Wheeler']

// Issue+auto-print a new customer vehicle parking token. Standalone — not tied to any order/table,
// so a walk-in who hasn't ordered yet can still get one. Only entry point is PosParkingSlips.jsx,
// which already gates the "+ New Parking Slip" Fab behind hasPosAccess('supervisor'); this modal
// re-checks the same gate internally as defense-in-depth, same double-gate pattern as
// IssueCreditNoteModal.jsx.
export default function NewParkingSlipModal({ outletName, propertyAddress, onClose, onIssued }) {
  const { clientId, profile, hasPosAccess } = useAuth()
  const { scopedFrom, scopedInsert } = useScopedDb()

  const [vehicleNumber, setVehicleNumber] = useState('')
  const [vehicleType, setVehicleType]     = useState('')
  const [customerName, setCustomerName]   = useState('')
  const [notes, setNotes] = useState('')
  const [billOrderId, setBillOrderId] = useState('')
  const [todaysBills, setTodaysBills] = useState([])
  const [billsLoading, setBillsLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState('')

  const bsToday = getBsToday()
  const dateLabel = `${bsToday.day} ${BS_MONTHS[bsToday.month - 1]} ${bsToday.year}`

  // Only today's billed orders — a slip is issued the same moment a customer is parked, so a bill
  // from a past day is never the right link (and would just be noise in the dropdown).
  useEffect(() => {
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0)
    scopedFrom('pos_orders', 'id, order_no, invoice_no, table_name, buyer_name, paid_amount')
      .eq('status', 'billed')
      .not('invoice_no', 'is', null)
      .gte('closed_at', startOfDay.toISOString())
      .order('closed_at', { ascending: false })
      .then(({ data }) => { setTodaysBills(data || []); setBillsLoading(false) })
  }, [scopedFrom])

  if (!hasPosAccess('supervisor')) {
    return (
      <Modal onClose={onClose} title="Parking Slip" maxWidth={420}>
        <p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Issuing a Parking Slip requires Supervisor access or above.</p>
        <div className="form-actions" style={{ justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </Modal>
    )
  }

  const billOptions = todaysBills.map(o => ({
    value: o.id,
    label: `Bill #${o.invoice_no} — ${o.table_name || o.buyer_name || 'Takeaway'} — NPR ${Math.round(o.paid_amount || 0).toLocaleString()}`,
  }))

  async function handleSave() {
    if (!vehicleNumber.trim()) { setError('Vehicle number is required.'); return }
    setSaving(true); setError('')
    const linkedBill = todaysBills.find(o => o.id === billOrderId)
    const { data: slip, error: insErr } = await scopedInsert('pos_parking_slips', {
      vehicle_number: vehicleNumber.trim().toUpperCase(),
      vehicle_type:   vehicleType || null,
      customer_name:  customerName.trim() || null,
      notes:          notes.trim() || null,
      order_id:       billOrderId || null,
      bill_invoice_no: linkedBill?.invoice_no || null,
      issued_by:      profile?.id || null,
    }, { single: true })
    if (insErr) { setError(insErr.message); setSaving(false); return }
    setSaving(false)
    printParkingSlip(clientId, slip, outletName, propertyAddress, profile?.full_name)
    onIssued()
  }

  return (
    <Modal onClose={onClose} title="New Parking Slip" maxWidth={420}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="form-field">
          <label>Date</label>
          <div style={{
            background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)',
            borderRadius: 6, padding: '8px 12px', fontSize: 13, color: 'var(--theme-text2)',
          }}>
            {dateLabel}
          </div>
        </div>
        <div className="form-field">
          <label>Vehicle Number *</label>
          <input
            value={vehicleNumber}
            onChange={e => setVehicleNumber(e.target.value)}
            placeholder="e.g. BA 2 KHA 1234"
            autoFocus
          />
        </div>
        <div className="form-field">
          <label><Tip text="Optional">Vehicle Type</Tip></label>
          <div style={{ display: 'flex', gap: 8 }}>
            {VEHICLE_TYPES.map(t => (
              <button
                key={t} type="button"
                className={`tab-btn${vehicleType === t ? ' tab-btn--active' : ''}`}
                style={{ flex: 1 }}
                onClick={() => setVehicleType(v => v === t ? '' : t)}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
        <div className="form-field">
          <label>Customer Name</label>
          <input
            value={customerName}
            onChange={e => setCustomerName(e.target.value)}
            placeholder="Optional"
          />
        </div>
        <div className="form-field">
          <label><Tip text="Link this slip to a bill already issued today — e.g. to honor a 'free parking with purchase' policy. Only today's bills are listed." width={280}>Bill Number</Tip></label>
          <SearchableSelect
            value={billOrderId}
            onChange={setBillOrderId}
            options={billOptions}
            placeholder={billsLoading ? 'Loading…' : todaysBills.length === 0 ? 'No bills issued today yet' : '— None —'}
          />
        </div>
        <div className="form-field">
          <label>Notes</label>
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Optional"
            rows={2}
            style={{
              width: '100%', resize: 'vertical', borderRadius: 6, boxSizing: 'border-box',
              border: '1px solid var(--theme-border)', background: 'var(--theme-input-bg)',
              color: 'var(--theme-text1)', padding: '8px 10px', fontSize: 13,
            }}
          />
        </div>
      </div>
      {error && <p style={{ color: 'var(--theme-red)', fontSize: 13, margin: '12px 0 0' }}>{error}</p>}
      <div className="form-actions" style={{ justifyContent: 'flex-end' }}>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : 'Issue & Print'}
        </button>
      </div>
    </Modal>
  )
}
