import { useState, useEffect } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import Modal from '../../../components/Modal'
import Tip from '../../../components/Tip'
import SearchableSelect from '../../../components/SearchableSelect'
import FieldError, { fieldAria } from '../../../components/FieldError'
import ActionError, { asActionError } from '../../../components/ActionError'
import { BS_MONTHS, bsDayBoundaryIso, formatAd } from '../../../utils/bsCalendar'
import { nepalBs, nepalCivilDate, nepalDateAd } from '../../../shared/nepalTime'
import { printParkingSlip } from './parkingSlipHtml'

const VEHICLE_TYPES = ['Two Wheeler', 'Four Wheeler']

// S754 (owner decision): parking's "day" is the SERVICE day — it starts at Nepal midnight of the BS
// day that (now − 6h) falls on, so it rolls over at 6 AM Nepal time rather than at the device's
// midnight. Same shape as serviceDayStartIso() in kds/KitchenDisplay.jsx; used both for the
// auto-close sweep (PosParkingSlips) and for "today's bills" below, so the two cannot disagree.
const SERVICE_DAY_ROLLOVER_MS = 6 * 60 * 60 * 1000
export function serviceDayStartIso(nowMs = Date.now()) {
  const anchor = nowMs - SERVICE_DAY_ROLLOVER_MS
  const bs = nepalBs(anchor)
  const iso = bs ? bsDayBoundaryIso(bs.year, bs.month, bs.day) : null
  if (iso) return iso
  // Outside the verified BS table: the same Nepal civil day, built from the AD date directly.
  return `${formatAd(nepalCivilDate(anchor))}T00:00:00.000+05:45`
}

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
  const [billsError, setBillsError] = useState(false) // a failed read is not "no bills today"
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState('')
  // Per-field validation; `error` above stays the form-level channel for a rejected write (S603).
  const [vehicleErr, setVehicleErr] = useState('')

  // S754: the same Nepal day the printed token will carry (parkingSlipHtml.js), not the runtime's —
  // getBsToday() reads local getters, so a till off Nepal time showed a different day from the slip.
  // nepalBs is null outside the verified BS table; fall back to the AD date rather than a wrong BS one.
  const now = new Date()
  const bsToday = nepalBs(now)
  const dateLabel = bsToday ? `${bsToday.day} ${BS_MONTHS[bsToday.month - 1]} ${bsToday.year}` : nepalDateAd(now)

  // Only today's billed orders — a slip is issued the same moment a customer is parked, so a bill
  // from a past day is never the right link (and would just be noise in the dropdown).
  useEffect(() => {
    // S754: the service day (6 AM Nepal rollover), not the device's midnight — see serviceDayStartIso.
    scopedFrom('pos_orders', 'id, order_no, invoice_no, table_name, buyer_name, paid_amount')
      .eq('status', 'billed')
      .not('invoice_no', 'is', null)
      .gte('closed_at', serviceDayStartIso())
      .order('closed_at', { ascending: false })
      .then(({ data, error }) => { setBillsError(!!error); setTodaysBills(data || []); setBillsLoading(false) })
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
    label: `Bill #${o.invoice_no} — ${o.table_name || o.buyer_name || 'Takeaway'} — NPR ${Math.round(o.paid_amount || 0).toLocaleString('en-IN')}`,
  }))

  async function handleSave() {
    if (!vehicleNumber.trim()) { setVehicleErr('Vehicle number is required.'); return }
    setVehicleErr('')
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
    // S754: the sentence, not Postgres' raw message; the detail rides along as fine print.
    if (insErr) {
      const { text, detail } = asActionError(insErr, 'staff')
      setError({ text: `No slip was printed. ${text}`, detail })
      setSaving(false); return
    }
    setSaving(false)
    printParkingSlip(clientId, slip, outletName, propertyAddress, profile?.full_name)
    onIssued()
  }

  return (
    <Modal onClose={onClose} title="New Parking Slip" maxWidth={420}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="form-field">
          <span className="field-label">Date</span>
          <div style={{
            background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)',
            borderRadius: 'var(--radius-sm)', padding: '8px 12px', fontSize: 13, color: 'var(--theme-text2)',
          }}>
            {dateLabel}
          </div>
        </div>
        <div className="form-field">
          <label htmlFor="park-vehicle-number">Vehicle Number *</label>
          <input
            id="park-vehicle-number"
            value={vehicleNumber}
            onChange={e => { setVehicleErr(''); setVehicleNumber(e.target.value) }}
            placeholder="e.g. BA 2 KHA 1234"
            autoFocus
            {...fieldAria('park-vehicle-number', vehicleErr)}
          />
          <FieldError id="park-vehicle-number" message={vehicleErr} />
        </div>
        <div className="form-field">
          <span className="field-label" id="park-vehicle-type-label"><Tip text="Optional">Vehicle Type</Tip></span>
          <div role="group" aria-labelledby="park-vehicle-type-label" style={{ display: 'flex', gap: 8 }}>
            {VEHICLE_TYPES.map(t => (
              <button
                key={t} type="button"
                className={`tab-btn${vehicleType === t ? ' tab-btn--active' : ''}`}
                aria-pressed={vehicleType === t}
                style={{ flex: 1 }}
                onClick={() => setVehicleType(v => v === t ? '' : t)}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
        <div className="form-field">
          <label htmlFor="park-customer-name">Customer Name</label>
          <input
            id="park-customer-name"
            value={customerName}
            onChange={e => setCustomerName(e.target.value)}
            placeholder="Optional"
          />
        </div>
        <div className="form-field">
          <label htmlFor="park-bill-number"><Tip text="Link this slip to a bill already issued today — e.g. to honor a 'free parking with purchase' policy. Only today's bills are listed." width={280}>Bill Number</Tip></label>
          <SearchableSelect
            id="park-bill-number"
            value={billOrderId}
            onChange={setBillOrderId}
            options={billOptions}
            placeholder={billsLoading ? 'Loading…' : billsError ? 'Could not load today\'s bills — close and reopen to retry' : todaysBills.length === 0 ? 'No bills issued today yet' : '— None —'}
          />
        </div>
        <div className="form-field">
          <label htmlFor="park-notes">Notes</label>
          <textarea
            id="park-notes"
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Optional"
            rows={2}
            style={{
              width: '100%', resize: 'vertical', borderRadius: 'var(--radius-sm)', boxSizing: 'border-box',
              border: '1px solid var(--theme-border)', background: 'var(--theme-input-bg)',
              color: 'var(--theme-text1)', padding: '8px 10px', fontSize: 13,
            }}
          />
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
