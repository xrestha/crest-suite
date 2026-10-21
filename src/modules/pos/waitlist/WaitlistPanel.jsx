import { useId, useRef, useState } from 'react'
import { MessageCircle, Phone, Minus, Plus } from 'lucide-react'
import Modal from '../../../components/Modal'
import Tip from '../../../components/Tip'
import RowMenu from '../../../components/RowMenu'
import ActionError, { asActionError } from '../../../components/ActionError'
import FieldError, { fieldAria } from '../../../components/FieldError'
import { useConfirm } from '../../../shared/hooks/useConfirm'
import { nepalTime } from '../../../shared/nepalTime'
import { moveRovingFocus, rovingTabIndex } from '../../../shared/rovingFocus'
import { randomUUID } from '../../../utils/uuid'
import { openWhatsApp, telLink } from '../reservations/whatsappLink'
import {
  QUOTE_CHOICES, DEFAULT_QUOTE, MAX_PARTY, MAX_NAME, MAX_PHONE, liveEntries, waitedMinutes, isOverdue,
  minutesOver, readyMessage, validateWaitlistDraft,
} from './waitlistApi'
import { useWaitClock } from './useWaitlist'

// The walk-in waitlist, opened from the floor's "Waitlist (n)" button (S854). Add a party at the
// top; the list below is oldest first, and a row turns amber (with a △ and the minutes over, never
// colour alone) once the party has waited longer than it was quoted. When a table frees up: WhatsApp
// or Call (either marks the party as told), then Seat, which hands the entry to the floor through
// `onSeat(entry)`. Left and Cancel sit in the row menu; Cancel asks first.
//
// Props: `waitlist` is useWaitlist()'s result (the panel never reads the database itself),
// `onClose`, `onSeat(entry)` (the floor picks the table and opens the order), `outletName` for the
// WhatsApp message, and `zIndex` when it opens over a full-screen till layer.

const DEFAULT_PARTY = '2'
const FIELD_ORDER = ['name', 'phone', 'party', 'quote']

function newDraftId() {
  try { return randomUUID() } catch { return undefined }
}

// The hook's actions answer `{ error }` and do not throw; a throw here would be a bug (a table
// missing from CLIENT_SCOPED_TABLES), and it must not leave a button on "Adding…" for good.
async function settle(run) {
  try {
    return (await run()) || { error: { message: 'No answer from the waitlist.' } }
  } catch (err) {
    console.error('waitlist action failed:', err)
    return { error: err }
  }
}

// The consequence first, the error table's sentence and the technical detail after it.
function consequenceError(consequence, err) {
  const info = asActionError(err, 'staff')
  return { text: `${consequence} ${info.text}`, detail: info.detail }
}

const mutedLine = { margin: '0 0 12px', fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.6 }

export default function WaitlistPanel({ waitlist, onClose, onSeat, outletName = '', zIndex = 100 }) {
  const uid = useId()
  const idFor = key => `${uid}-${key}`
  const nameRef = useRef(null)
  const phoneRef = useRef(null)
  const partyRef = useRef(null)
  const quoteRef = useRef(null)
  const draftIdRef = useRef(null)
  if (draftIdRef.current === null) draftIdRef.current = newDraftId() || ''

  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [party, setParty] = useState(DEFAULT_PARTY)
  const [quote, setQuote] = useState(DEFAULT_QUOTE)
  const [errors, setErrors] = useState({})
  const [submitting, setSubmitting] = useState(false)
  const [actionError, setActionError] = useState(null)
  const [notice, setNotice] = useState('')
  const [busyId, setBusyId] = useState(null)
  const { ask, confirmEl } = useConfirm()
  const now = useWaitClock(true)

  const wl = waitlist || {}
  const rows = liveEntries(wl.entries)
  const partyNum = Number(party)
  const dirty = !!(name.trim() || phone.trim()) || party !== DEFAULT_PARTY || quote !== DEFAULT_QUOTE
  const overZ = zIndex + 20
  const menuZ = zIndex >= 290 ? overZ : null

  const stepParty = delta => {
    const base = Number.isInteger(partyNum) ? partyNum : Number(DEFAULT_PARTY)
    setParty(String(Math.min(MAX_PARTY, Math.max(1, base + delta))))
    setErrors(prev => ({ ...prev, party: undefined }))
  }

  async function submit(e) {
    e.preventDefault()
    if (submitting) return
    const draft = { name, phone, partySize: partyNum, quotedMinutes: quote }
    const found = validateWaitlistDraft(draft)
    setErrors(found)
    const first = FIELD_ORDER.find(k => found[k])
    if (first) {
      const ref = { name: nameRef, phone: phoneRef, party: partyRef, quote: quoteRef }[first]
      ref.current?.focus?.()
      return
    }
    setSubmitting(true)
    setActionError(null)
    setNotice('')
    const res = await settle(() => wl.add(draft, { id: draftIdRef.current || undefined }))
    setSubmitting(false)
    if (res.error) {
      setActionError(consequenceError(`${name.trim()} is not on the list yet. Your entry is still in the form, so press Add again.`, res.error))
      return
    }
    setNotice(`${name.trim()} ×${partyNum} added, quoted ${quote} min.`)
    draftIdRef.current = newDraftId() || ''
    setName('')
    setPhone('')
    setParty(DEFAULT_PARTY)
    setQuote(DEFAULT_QUOTE)
    setErrors({})
  }

  // WhatsApp and Call both mean the party has been told. The message or the call has already gone
  // by the time this runs, so a failure says only that the mark did not land.
  async function markTold(entry) {
    if (entry.status !== 'waiting' || busyId) return
    setBusyId(entry.id)
    setActionError(null)
    const res = await settle(() => wl.notify(entry))
    setBusyId(null)
    if (res.error) {
      setActionError(consequenceError(`${entry.customer_name} was contacted, but the row could not be marked as told, so it still shows waiting.`, res.error))
    }
  }

  function sendWhatsApp(entry) {
    openWhatsApp(entry.phone, readyMessage(entry, outletName))
    void markTold(entry)
  }

  async function closeEntry(entry, how) {
    setBusyId(entry.id)
    setActionError(null)
    setNotice('')
    const res = await settle(() => (how === 'left' ? wl.markLeft(entry) : wl.cancel(entry)))
    setBusyId(null)
    if (res.error) {
      setActionError(consequenceError(`${entry.customer_name} is still on the list.`, res.error))
      return
    }
    if (res.count === 0) {
      setNotice(`${entry.customer_name} had already left the list on another device.`)
      return
    }
    setNotice(how === 'left'
      ? `${entry.customer_name} ×${entry.party_size} marked as left.`
      : `${entry.customer_name} ×${entry.party_size} taken off the list.`)
  }

  function askCancel(entry) {
    ask({
      title: `Cancel ${entry.customer_name} ×${entry.party_size}?`,
      body: (
        <p style={{ margin: 0 }}>
          This takes the party off the waitlist for good. Use it for an entry made by mistake, or a party that
          called to say they are not coming. A party that walked away is marked Left instead.
        </p>
      ),
      confirmLabel: 'Cancel entry',
      cancelLabel: 'Keep on list',
      busyLabel: 'Cancelling…',
      danger: true,
      zIndex: overZ,
      run: () => closeEntry(entry, 'cancelled'),
    })
  }

  const quoteKeys = e => {
    const el = moveRovingFocus(e, '[role="radio"]')
    if (el) el.click()
  }

  let listBody
  if (wl.loading) {
    listBody = <p role="status" style={mutedLine}>Loading the waitlist…</p>
  } else if (!wl.loaded && wl.error) {
    listBody = (
      <div>
        <ActionError error={consequenceError('Could not load the waitlist, so this is not the real list.', wl.error)} />
        <button type="button" className="btn btn-ghost btn-sm till-hit--row" onClick={() => wl.refresh?.()}>Try again</button>
      </div>
    )
  } else if (rows.length === 0) {
    listBody = (
      <p style={mutedLine}>
        Nobody is waiting. When every table is full, add the party above and seat them from here when a table frees up.
      </p>
    )
  } else {
    listBody = (
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {rows.map(entry => {
          const waited = waitedMinutes(entry, now)
          const over = isOverdue(entry, now)
          const busy = busyId === entry.id
          const others = busyId != null && !busy
          return (
            <li key={entry.id} data-overdue={over ? 'true' : undefined}
              style={{ padding: '12px 0', borderTop: '1px solid var(--theme-border)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--theme-text1)', overflowWrap: 'anywhere' }}>
                  {entry.customer_name} <span style={{ whiteSpace: 'nowrap' }}>×{entry.party_size}</span>
                </span>
                {entry.status === 'notified' && (
                  <span className="badge badge-gray" style={{ whiteSpace: 'nowrap' }}>Told at {nepalTime(entry.notified_at)}</span>
                )}
              </div>
              <div style={{ fontSize: 13, marginTop: 2, color: over ? 'var(--theme-amber-text)' : 'var(--theme-text2)', fontWeight: over ? 600 : 400 }}>
                {over && <span aria-hidden="true">△ </span>}
                Waited {waited} of {entry.quoted_minutes} min
                {over && <span>, {minutesOver(entry, now)} over</span>}
              </div>
              {entry.phone && (
                <div style={{ fontSize: 12, color: 'var(--theme-text2)', whiteSpace: 'nowrap' }}>{entry.phone}</div>
              )}
              {entry.notes && (
                <div style={{ fontSize: 12, color: 'var(--theme-text2)', overflowWrap: 'anywhere' }}>{entry.notes}</div>
              )}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                {entry.phone && (
                  <Tip text="Opens WhatsApp on this device with a table-ready message filled in, and marks the party as told." width={240}>
                    <button type="button" className="btn btn-ghost btn-sm till-hit--row" disabled={others}
                      aria-busy={busy || undefined} aria-label={`WhatsApp ${entry.customer_name}`} onClick={() => sendWhatsApp(entry)}>
                      <MessageCircle size={14} aria-hidden="true" /> WhatsApp
                    </button>
                  </Tip>
                )}
                {entry.phone && (
                  <a className="btn btn-ghost btn-sm till-hit--row" href={telLink(entry.phone)}
                    aria-label={`Call ${entry.customer_name}`} onClick={() => { void markTold(entry) }}>
                    <Phone size={14} aria-hidden="true" /> Call
                  </a>
                )}
                <Tip text="Pick the table. The order opens with the party size as covers and the name and phone filled in." width={240}>
                  <button type="button" className="btn btn-primary btn-sm till-hit--row" disabled={others}
                    aria-label={`Seat ${entry.customer_name}`} onClick={() => onSeat?.(entry)}>
                    Seat
                  </button>
                </Tip>
                <RowMenu
                  label={`More for ${entry.customer_name}`}
                  className="till-hit--row"
                  zIndex={menuZ}
                  disabled={others}
                  busy={busy}
                  items={[
                    { key: 'left', label: 'Left without a table', onSelect: () => closeEntry(entry, 'left') },
                    '-',
                    { key: 'cancel', label: 'Cancel entry…', danger: true, onSelect: () => askCancel(entry) },
                  ]}
                />
              </div>
            </li>
          )
        })}
      </ul>
    )
  }

  return (
    <Modal title="Waitlist" onClose={onClose} maxWidth={640} zIndex={zIndex} dirty={dirty}>
      <form onSubmit={submit} noValidate>
        <div className="field-grid">
          <div className="form-field">
            <label htmlFor={idFor('name')}>Name</label>
            <input id={idFor('name')} ref={nameRef} value={name} maxLength={MAX_NAME} autoComplete="off"
              onChange={e => { setName(e.target.value); if (errors.name) setErrors(prev => ({ ...prev, name: undefined })) }}
              {...fieldAria(idFor('name'), errors.name)} />
            <FieldError id={idFor('name')} message={errors.name} />
          </div>
          <div className="form-field">
            <label htmlFor={idFor('phone')}>
              Phone (optional) <Tip text="For the WhatsApp message or a call when the table is ready. Leave it empty for a party waiting at the door." width={260}>ⓘ</Tip>
            </label>
            <input id={idFor('phone')} ref={phoneRef} type="tel" inputMode="tel" value={phone} maxLength={MAX_PHONE} autoComplete="off"
              onChange={e => { setPhone(e.target.value); if (errors.phone) setErrors(prev => ({ ...prev, phone: undefined })) }}
              {...fieldAria(idFor('phone'), errors.phone)} />
            <FieldError id={idFor('phone')} message={errors.phone} />
          </div>
          <div className="form-field">
            <label htmlFor={idFor('party')}>
              Party size <Tip text="How many people. It becomes the covers count on the order when the party is seated." width={240}>ⓘ</Tip>
            </label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button type="button" className="btn btn-ghost till-hit" aria-label="One person fewer"
                onClick={() => stepParty(-1)} disabled={Number.isInteger(partyNum) && partyNum <= 1}>
                <Minus size={16} aria-hidden="true" />
              </button>
              <input id={idFor('party')} ref={partyRef} type="number" inputMode="numeric" min={1} max={MAX_PARTY}
                value={party} style={{ width: 72, textAlign: 'center' }}
                onChange={e => { setParty(e.target.value); if (errors.party) setErrors(prev => ({ ...prev, party: undefined })) }}
                {...fieldAria(idFor('party'), errors.party)} />
              <button type="button" className="btn btn-ghost till-hit" aria-label="One person more"
                onClick={() => stepParty(1)} disabled={Number.isInteger(partyNum) && partyNum >= MAX_PARTY}>
                <Plus size={16} aria-hidden="true" />
              </button>
            </div>
            <FieldError id={idFor('party')} message={errors.party} />
          </div>
        </div>

        <div className="form-field" style={{ marginTop: 16 }}>
          <span className="field-label" id={idFor('quote-label')}>
            Quoted wait <Tip text="The wait you told the party. Their row turns amber once they have waited longer than this, so you can see who to check on first." width={260}>ⓘ</Tip>
          </span>
          <div role="radiogroup" aria-labelledby={idFor('quote-label')} onKeyDown={quoteKeys}
            style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {QUOTE_CHOICES.map(m => (
              <button key={m} type="button" role="radio" className="choice-chip" aria-checked={quote === m}
                ref={quote === m ? quoteRef : undefined}
                tabIndex={rovingTabIndex(quote === m)}
                onClick={() => setQuote(m)}
                style={{ minWidth: 72, alignItems: 'center' }}>
                <span className="choice-chip__name">{m} min</span>
              </button>
            ))}
          </div>
          <FieldError id={idFor('quote')} message={errors.quote} />
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <button type="submit" className="btn btn-primary till-hit--row" aria-busy={submitting || undefined}>
            {submitting ? 'Adding…' : 'Add to waitlist'}
          </button>
        </div>
      </form>

      <ActionError error={actionError} />
      {notice && <p role="status" style={{ ...mutedLine, margin: '12px 0 0' }}>{notice}</p>}

      <section aria-labelledby={idFor('list-heading')} style={{ marginTop: 20 }}>
        <h4 id={idFor('list-heading')} style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 600, color: 'var(--theme-text1)' }}>
          Waiting now{wl.loaded ? ` (${rows.length})` : ''}
        </h4>
        {wl.loaded && wl.error && (
          <p role="status" style={{ ...mutedLine, color: 'var(--theme-amber-text)' }}>
            △ Could not refresh the list just now, so it may be out of date. Trying again every 30 seconds.
          </p>
        )}
        {listBody}
      </section>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
        <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>
      </div>
      {confirmEl}
    </Modal>
  )
}
