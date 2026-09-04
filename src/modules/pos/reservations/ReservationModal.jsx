import { useState, useEffect } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import Modal from '../../../components/Modal'
import Tip from '../../../components/Tip'
import BsCalendarPicker from '../../../components/BsCalendarPicker'
import FieldError, { fieldAria } from '../../../components/FieldError'
import ActionError, { asActionError } from '../../../components/ActionError'
import { formatAd } from '../../../utils/bsCalendar'
import { nepalCivilDate, nepalTime24 } from '../../../shared/nepalTime'
import { normalizePhone } from '../../../utils/phone'
import { SOURCES, OCCASIONS, tableIdsOf } from './reservationStatus'
import { durationFor } from './reservationSettings'

const fmtNpr = n => `NPR ${Math.round(n).toLocaleString()}`

// The instant a booking is for, from the BS-picked day (which the picker hands back as an AD
// 'YYYY-MM-DD') and an 'HH:MM' clock time. Pinned to +05:45 explicitly: this is the bsDayBoundaryIso
// rule — never `.toISOString()` a Date built from a picked day, and never let the runtime's
// timezone decide what "7:30 PM" means for a restaurant in Kathmandu.
function instantOf(dateIso, hm) {
  return `${dateIso}T${hm}:00+05:45`
}

/**
 * Add / edit one booking. Phone blur looks the guest up in the data the product already has —
 * the customer book, their bills, unsettled credit, prior no-shows — because the customer book
 * is the memory (design principle 6): nothing here asks staff to type what a bill already said.
 */
export default function ReservationModal({ row, tables, settings, dayIso, onClose, onSaved }) {
  const { profile } = useAuth()
  const { scopedFrom, scopedInsert, scopedUpdate, scopedDelete } = useScopedDb()

  const [name,     setName]     = useState(row?.customer_name || '')
  const [phone,    setPhone]    = useState(row?.phone || '')
  const [party,    setParty]    = useState(row ? String(row.party_size) : '2')
  const [dateIso,  setDateIso]  = useState(row ? formatAd(nepalCivilDate(row.reserved_for)) : dayIso)
  const [time,     setTime]     = useState(row ? nepalTime24(row.reserved_for) : '')
  const [duration, setDuration] = useState(row ? String(row.duration_minutes) : String(durationFor(2, settings)))
  const [durationTouched, setDurationTouched] = useState(!!row)
  const [tableIds, setTableIds] = useState(() => new Set(row ? tableIdsOf(row) : []))
  const [source,   setSource]   = useState(row?.source || 'phone')
  const [occasion, setOccasion] = useState(row?.occasion || '')
  const [notes,    setNotes]    = useState(row?.notes || '')
  const [errors,   setErrors]   = useState({})
  const [saving,   setSaving]   = useState(false)
  const [saveError, setSaveError] = useState(null)
  // null = nothing looked up yet; { loading } | { error } | { name, visits, credit, noShows }
  const [lookup,   setLookup]   = useState(null)

  // Party size drives the expected sitting length until the host overrides it by hand.
  useEffect(() => {
    if (durationTouched) return
    const n = parseInt(party, 10)
    if (Number.isFinite(n) && n > 0) setDuration(String(durationFor(n, settings)))
  }, [party, settings, durationTouched])

  // On edit, show what the book knows about this guest without waiting for a blur.
  useEffect(() => { if (row?.phone) lookupPhone(row.phone) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function lookupPhone(raw) {
    const canonical = normalizePhone(raw)
    if (!canonical) { setLookup(null); return }
    setLookup({ loading: true })
    const trimmed = String(raw).trim()
    const [cust, visits, credit, noShows] = await Promise.all([
      scopedFrom('pos_customers', 'id, name').eq('phone_canonical', canonical).limit(1),
      scopedFrom('pos_orders', 'id', { count: 'exact', head: true }).eq('status', 'billed').eq('buyer_phone', trimmed),
      scopedFrom('pos_orders', 'paid_amount').eq('payment_method', 'Credit').eq('status', 'billed').is('credit_settled_at', null).eq('buyer_phone', trimmed),
      scopedFrom('pos_reservations', 'id', { count: 'exact', head: true }).eq('phone_canonical', canonical).eq('status', 'no_show'),
    ])
    // A failed lookup must not render as "new guest, no history" — that is the vacuous-guard shape.
    if (cust.error || visits.error || credit.error || noShows.error) { setLookup({ error: true }); return }
    const known = cust.data?.[0]?.name || ''
    setLookup({
      name: known,
      visits: visits.count || 0,
      credit: (credit.data || []).reduce((s, o) => s + (Number(o.paid_amount) || 0), 0),
      noShows: noShows.count || 0,
    })
    if (known && !name.trim()) setName(known)
  }

  function toggleTable(id) {
    setTableIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }

  function validate() {
    const e = {}
    if (!name.trim()) e.name = 'Who is the booking for?'
    if (!normalizePhone(phone)) e.phone = 'Enter a phone number with at least 7 digits.'
    const n = parseInt(party, 10)
    if (!Number.isFinite(n) || n < 1 || n > 99) e.party = 'Party size is 1 to 99.'
    if (!dateIso) e.date = 'Pick the day.'
    if (!/^\d{2}:\d{2}$/.test(time)) e.time = 'Pick the time.'
    const d = parseInt(duration, 10)
    if (!Number.isFinite(d) || d < 15 || d > 720) e.duration = 'Between 15 minutes and 12 hours.'
    if (!e.date && !e.time) {
      const when = new Date(instantOf(dateIso, time)).getTime()
      if (!Number.isFinite(when)) e.time = 'That is not a valid time.'
      // An hour of slack: a host logging a walk-in party that sat down a few minutes ago is a
      // real case; a booking for yesterday is a typo.
      else if (when < Date.now() - 60 * 60000) e.time = 'That time has already passed.'
    }
    setErrors(e)
    return Object.keys(e).length === 0
  }

  async function save() {
    if (!validate()) return
    setSaving(true); setSaveError(null)
    const payload = {
      customer_name: name.trim(),
      phone: phone.trim(),
      party_size: parseInt(party, 10),
      reserved_for: instantOf(dateIso, time),
      duration_minutes: parseInt(duration, 10),
      source,
      occasion: occasion || null,
      notes: notes.trim() || null,
    }
    let id = row?.id
    if (row) {
      const { data, error } = await scopedUpdate('pos_reservations', payload).eq('id', row.id).select('id')
      if (error) { setSaving(false); setSaveError(asActionError(error, 'staff')); return }
      if (!data || data.length === 0) {
        setSaving(false)
        setSaveError({ text: 'This booking no longer exists — it may have been removed on another device. Close and refresh the list.' })
        return
      }
    } else {
      const { data, error } = await scopedInsert('pos_reservations', {
        ...payload, status: 'booked', created_by: profile?.id || null,
      }, { single: true })
      if (error || !data) { setSaving(false); setSaveError(asActionError(error || { message: 'No row returned' }, 'staff')); return }
      id = data.id
    }

    // Table assignment: replace the join rows. Two writes rather than one RPC on purpose — a
    // half-applied assignment is visible on the row and re-editable, unlike order lines, where
    // the same shape cost real data (S573). The sentence below names the consequence, not the
    // constraint, because the booking itself has already been saved.
    const { error: delErr } = await scopedDelete('pos_reservation_tables').eq('reservation_id', id)
    let insErr = null
    if (!delErr && tableIds.size > 0) {
      ;({ error: insErr } = await scopedInsert('pos_reservation_tables', [...tableIds].map(table_id => ({ reservation_id: id, table_id }))))
    }
    setSaving(false)
    if (delErr || insErr) {
      const err = delErr || insErr
      setSaveError({
        text: `The booking for ${payload.customer_name} was saved, but its table assignment was not — open it again and set the tables.`,
        detail: `${err.code || ''} · ${err.message || ''}`.replace(/^ · /, ''),
      })
      onSaved({ partial: true })
      return
    }
    onSaved()
  }

  const usableTables = (tables || []).filter(t => t.status !== 'inactive')
  const sections = Array.from(new Set(usableTables.map(t => t.section || '')))
  const idFor = k => `resv-${k}`

  return (
    <Modal title={row ? `Edit booking — ${row.customer_name}` : 'New booking'} onClose={saving ? () => {} : onClose} maxWidth={640}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px 16px' }}>
        <div className="form-field">
          <label htmlFor={idFor('name')}>Guest name</label>
          <input id={idFor('name')} value={name} onChange={e => setName(e.target.value)} {...fieldAria(idFor('name'), errors.name)} autoComplete="off" />
          <FieldError id={idFor('name')} message={errors.name} />
        </div>
        <div className="form-field">
          <label htmlFor={idFor('phone')}>
            Phone <Tip text="The booking's key. On blur the guest is looked up in the customer book — visits, unsettled credit and past no-shows show below. The WhatsApp button on the list uses this number." width={280}>ⓘ</Tip>
          </label>
          <input
            id={idFor('phone')} value={phone} inputMode="tel" autoComplete="off"
            onChange={e => setPhone(e.target.value)}
            onBlur={e => lookupPhone(e.target.value)}
            {...fieldAria(idFor('phone'), errors.phone)}
          />
          <FieldError id={idFor('phone')} message={errors.phone} />
          {lookup?.loading && <span style={{ fontSize: 11, color: 'var(--theme-text3)' }}>Looking up…</span>}
          {lookup?.error && <span style={{ fontSize: 11, color: 'var(--theme-amber-text)' }}>Could not check the customer book just now.</span>}
          {lookup && !lookup.loading && !lookup.error && (
            <span style={{ fontSize: 11, color: 'var(--theme-text2)', display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
              <span>{lookup.visits > 0 ? `${lookup.visits} visit${lookup.visits === 1 ? '' : 's'}` : 'New guest'}</span>
              {lookup.credit > 0 && <span className="badge badge-amber">Owes {fmtNpr(lookup.credit)}</span>}
              {lookup.noShows > 0 && <span className="badge badge-red">{lookup.noShows} no-show{lookup.noShows === 1 ? '' : 's'}</span>}
            </span>
          )}
        </div>
        <div className="form-field">
          <label htmlFor={idFor('party')}>
            Guests <Tip text="Party size. Becomes the covers count on the order when the party is seated, and sets the expected sitting length below." width={260}>ⓘ</Tip>
          </label>
          <input id={idFor('party')} type="number" min={1} max={99} inputMode="numeric" value={party} onChange={e => setParty(e.target.value)} {...fieldAria(idFor('party'), errors.party)} />
          <FieldError id={idFor('party')} message={errors.party} />
        </div>
        <div className="form-field">
          <label htmlFor={idFor('duration')}>
            Expected sitting (min) <Tip text="Prefilled per party size from Table Management → Reservations, where the outlet's own measured turn times are shown. Change it for a booking that will run long." width={280}>ⓘ</Tip>
          </label>
          <input id={idFor('duration')} type="number" min={15} max={720} step={15} inputMode="numeric" value={duration}
            onChange={e => { setDurationTouched(true); setDuration(e.target.value) }} {...fieldAria(idFor('duration'), errors.duration)} />
          <FieldError id={idFor('duration')} message={errors.duration} />
        </div>
        <div className="form-field">
          <label htmlFor={idFor('date')}>Date (BS)</label>
          <BsCalendarPicker id={idFor('date')} value={dateIso} onChange={setDateIso} invalid={errors.date} />
          <FieldError id={idFor('date')} message={errors.date} />
        </div>
        <div className="form-field">
          <label htmlFor={idFor('time')}>Time</label>
          <input id={idFor('time')} type="time" step={900} value={time} onChange={e => setTime(e.target.value)} {...fieldAria(idFor('time'), errors.time)} />
          <FieldError id={idFor('time')} message={errors.time} />
        </div>
        <div className="form-field">
          <label htmlFor={idFor('source')}>
            How they booked <Tip text="Where the booking came from. The Covers Report's Reservations tab splits bookings and no-shows by this." width={240}>ⓘ</Tip>
          </label>
          <select id={idFor('source')} className="form-select" value={source} onChange={e => setSource(e.target.value)}>
            {SOURCES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </div>
        <div className="form-field">
          <label htmlFor={idFor('occasion')}>Occasion</label>
          <select id={idFor('occasion')} className="form-select" value={occasion} onChange={e => setOccasion(e.target.value)}>
            <option value="">—</option>
            {OCCASIONS.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </div>
      </div>

      <div className="form-field" style={{ marginTop: 12 }}>
        <span className="field-label" id={idFor('tables-label')}>
          Tables <Tip text="Optional. Holding a table shows the booking on that tile on the Orders floor and preselects it at seating. A party can hold several." width={260}>ⓘ</Tip>
        </span>
        {usableTables.length === 0 ? (
          <span style={{ fontSize: 12, color: 'var(--theme-text3)' }}>No tables set up yet.</span>
        ) : (
          <div role="group" aria-labelledby={idFor('tables-label')} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {sections.map(sec => (
              <div key={sec || '__none'} style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                {sections.length > 1 && <span style={{ fontSize: 11, color: 'var(--theme-text3)', minWidth: 70 }}>{sec || 'No section'}</span>}
                {usableTables.filter(t => (t.section || '') === sec).map(t => {
                  const on = tableIds.has(t.id)
                  return (
                    <button
                      key={t.id} type="button"
                      className={`tab-btn${on ? ' tab-btn--active' : ''}`}
                      aria-pressed={on}
                      onClick={() => toggleTable(t.id)}
                      title={`${t.name} · ${t.capacity ?? '—'} seats`}
                    >
                      {t.name}
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="form-field" style={{ marginTop: 12 }}>
        <label htmlFor={idFor('notes')}>Notes</label>
        <textarea id={idFor('notes')} rows={2} value={notes} onChange={e => setNotes(e.target.value)} placeholder="Window seat, cake at 8, wheelchair access…" />
      </div>

      <ActionError error={saveError} />

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
        <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : row ? 'Save changes' : 'Add booking'}
        </button>
      </div>
    </Modal>
  )
}
