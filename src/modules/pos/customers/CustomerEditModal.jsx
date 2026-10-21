import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../../../supabaseClient'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { useConfirm } from '../../../shared/hooks/useConfirm'
import Modal from '../../../components/Modal'
import Tip from '../../../components/Tip'
import BsCalendarPicker from '../../../components/BsCalendarPicker'
import FieldError, { fieldAria } from '../../../components/FieldError'
import ActionError, { asActionError } from '../../../components/ActionError'
import { BS_MONTHS, formatAdAsBs } from '../../../utils/bsCalendar'
import { settleWithin, isTimeout } from '../../../utils/withTimeout'
import { isNetworkError } from '../../../shared/errorText'
import { npr } from '../../../shared/nepalMoney'
import { nepalBsLong, nepalDateAd } from '../../../shared/nepalTime'
import { loadProfileNames } from '../../../shared/profileNames'
import { todayNepalAdIso, todayNepalBs } from '../reports/reportRange'
import { pctText } from '../orders/memberDiscount'
import { AD_MONTHS, CALENDAR_LABELS, maxDayOf, storedDateLabel } from './occasions'
import {
  CUSTOMER_EDIT_COLUMNS, buildCustomerPatch, cardExpiryIso, dateIsSet, formFromCustomer, normaliseCardNo,
  takesCardAway, validateCustomerForm,
} from './membershipForm'

// One customer's membership card, credit limit, birthday and anniversary (S843). Opened from a row
// of the customer book (Customers tab) and from the Membership tab.
//
// Who changes what is the database's (pos_customers_guard_loyalty), mirrored here so nothing is
// offered that would be refused: the card and the credit limit are a POS manager's or the Owner's
// (`canManage`); the dates and the customer's agreement are a supervisor's and up. A supervisor sees
// the card read-only. A save sends only what changed and what this login may change
// (membershipForm.js), reads the row back, and treats zero rows as not saved (a refused RLS update is
// no error). The phone is never edited: it is what the customer's points and bills belong to.
//
// Nepal's Privacy Act: no date is kept without the customer's agreement. The tick is required before
// any date is saved; the server stamps when and who. Taking the agreement back removes both dates in
// the same save, and the form says so before it is pressed.

const SAVE_MS = 20000
const NAMES_MS = 15000
const FIELD_IDS = { cardNo: 'ce-card-no', expiresOn: 'ce-expires', creditLimit: 'ce-limit', birth: 'ce-birth-month', anniv: 'ce-anniv-month', agreed: 'ce-agreed' }
const FIELD_ORDER = ['agreed', 'birth', 'anniv', 'cardNo', 'expiresOn', 'creditLimit']

function typeLabel(t) {
  const lasts = t.valid_months ? `${t.valid_months} month${t.valid_months === 1 ? '' : 's'}` : 'no expiry'
  return `${t.name} — ${pctText(t.discount_pct)}% off, ${lasts}${t.is_active ? '' : ' (switched off)'}`
}

function bsOfTs(ts) {
  return nepalBsLong(ts) || `${nepalDateAd(ts)} (AD)`
}

// One date: its calendar, month, day and an optional year. Every control carries the date's name in
// its accessible name, because the birthday's and the anniversary's boxes sit side by side.
function DateField({ idBase, label, value, onChange, disabled, error }) {
  const months = value.calendar === 'AD' ? AD_MONTHS : BS_MONTHS
  const max = Math.max(maxDayOf(value.calendar, value.month, value.year || null), Number(value.day) || 0)
  const set = patch => onChange({ ...value, ...patch })
  const lower = label.toLowerCase()
  return (
    <div style={{ marginBottom: 12 }}>
      <div className="field-grid">
        <div className="form-field">
          <label htmlFor={`${idBase}-cal`}>
            <Tip text="The calendar the customer gave the date in. Nepali (BS) dates come round on the same BS day each year, English (AD) ones on the same AD day." width={280}>
              {label} calendar
            </Tip>
          </label>
          {/* Another calendar is another date: the month and day are cleared with it. */}
          <select id={`${idBase}-cal`} className="form-select" value={value.calendar} disabled={disabled}
            onChange={e => onChange({ calendar: e.target.value, month: '', day: '', year: '' })}>
            <option value="BS">{CALENDAR_LABELS.BS}</option>
            <option value="AD">{CALENDAR_LABELS.AD}</option>
          </select>
        </div>
        <div className="form-field">
          <label htmlFor={`${idBase}-month`}>{label} month</label>
          <select id={`${idBase}-month`} className="form-select" value={value.month} disabled={disabled}
            onChange={e => set({ month: e.target.value })} {...fieldAria(`${idBase}-month`, error)}>
            <option value="">—</option>
            {months.map((m, i) => <option key={m} value={String(i + 1)}>{m}</option>)}
          </select>
        </div>
        <div className="form-field">
          <label htmlFor={`${idBase}-day`}>{label} day</label>
          <select id={`${idBase}-day`} className="form-select" value={value.day} disabled={disabled}
            onChange={e => set({ day: e.target.value })}>
            <option value="">—</option>
            {Array.from({ length: max }, (_, i) => String(i + 1)).map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>
        <div className="form-field">
          <label htmlFor={`${idBase}-year`}>
            <Tip text={`Optional. With the year, the list shows ${lower === 'birthday' ? 'the age they turn' : 'how many years it is'}. Type it in the same calendar as the date.`} width={260}>
              {label} year (optional)
            </Tip>
          </label>
          <input id={`${idBase}-year`} className="form-input" inputMode="numeric" maxLength={4} autoComplete="off"
            placeholder={value.calendar === 'AD' ? 'e.g. 1993' : 'e.g. 2050'} value={value.year} disabled={disabled}
            onChange={e => set({ year: e.target.value.replace(/[^\d]/g, '') })} />
        </div>
      </div>
      <FieldError id={`${idBase}-month`} message={error} />
      {dateIsSet(value) && !disabled && (
        // The button leaves with the date it clears, so focus moves to the month it emptied (S852).
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => {
          onChange({ calendar: value.calendar, month: '', day: '', year: '' })
          document.getElementById(`${idBase}-month`)?.focus()
        }}>
          Clear the {lower}
        </button>
      )}
    </div>
  )
}

export default function CustomerEditModal({ customer, types, typesError = null, canManage = false, canSupervise = true, onClose, onSaved }) {
  const { clientId, scopedUpdate } = useScopedDb()
  const { ask: askConfirm, confirmEl } = useConfirm()
  const initial = useMemo(() => formFromCustomer(customer), [customer])
  const [form, setForm] = useState(initial)
  const [showErrors, setShowErrors] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [recordedBy, setRecordedBy] = useState({ loading: !!customer.consent_by, name: null, failed: false })
  const expiryTouched = useRef(false)
  // Withdraw and Keep replace each other, so the pressed button leaves with its press and focus fell
  // to the page behind the dialog. The one that takes its place is focused instead (S852).
  const agreementFocus = useRef(null)
  useEffect(() => {
    const id = agreementFocus.current
    if (!id) return
    agreementFocus.current = null
    document.getElementById(id)?.focus()
  }, [form.withdraw])

  const typesById = useMemo(() => Object.fromEntries((types || []).map(t => [t.id, t])), [types])
  const canEditCard = canManage && Array.isArray(types)
  const todayBs = useMemo(() => todayNepalBs(), [])
  const todayIso = useMemo(() => todayNepalAdIso(), [])
  const errors = validateCustomerForm(form, {
    customer, canEditCard, canEditDates: canSupervise, todayBs, todayAdYear: Number(todayIso.slice(0, 4)),
  })
  const shown = showErrors ? errors : {}
  const dirty = JSON.stringify(form) !== JSON.stringify(initial)

  // Who recorded the agreement: profiles are self-or-admin, so names come from the RPC. A failed read
  // says so rather than leaving the name off as if nobody had.
  useEffect(() => {
    if (!customer.consent_by || !clientId) return undefined
    let gone = false
    loadProfileNames(supabase, clientId, [customer.consent_by], { ms: NAMES_MS, label: 'Reading who recorded the agreement' })
      .then(({ map, error: err }) => {
        if (gone) return
        if (err) console.error('consent recorder name read failed:', err)
        setRecordedBy({ loading: false, name: err ? null : (map[customer.consent_by] || null), failed: !!err })
      })
    return () => { gone = true }
  }, [customer.consent_by, clientId])

  const autoExpiry = form.typeId ? cardExpiryIso(form.issuedOn || todayIso, typesById[form.typeId]?.valid_months) : ''

  function pickType(id) {
    setForm(f => {
      const next = { ...f, typeId: id }
      if (id && !f.issuedOn) next.issuedOn = todayIso
      if (id && !expiryTouched.current) next.expiresOn = cardExpiryIso(next.issuedOn, typesById[id]?.valid_months)
      return next
    })
  }
  function pickIssued(iso) {
    setForm(f => {
      const next = { ...f, issuedOn: iso }
      if (f.typeId && !expiryTouched.current) next.expiresOn = cardExpiryIso(iso, typesById[f.typeId]?.valid_months)
      return next
    })
  }

  function focusFirst(errs) {
    const first = FIELD_ORDER.find(k => errs[k])
    if (first) document.getElementById(FIELD_IDS[first])?.focus()
  }

  function save() {
    if (busy) return
    setError(null)
    setShowErrors(true)
    if (Object.keys(errors).length) { focusFirst(errors); return }
    const patch = buildCustomerPatch(customer, form, { canEditCard, canEditDates: canSupervise, nowIso: new Date().toISOString() })
    if (Object.keys(patch).length === 0) { onClose(); return }
    if (takesCardAway(customer, form, canEditCard)) {
      const t = typesById[customer.membership_type_id]
      askConfirm({
        title: `Take ${customer.name}'s ${t?.name || 'membership'} card away?`,
        confirmLabel: 'Take the card away', danger: true, busyLabel: 'Saving…', zIndex: 300,
        body: (
          <p style={{ margin: 0 }}>
            From their next bill the till gives {customer.name} no {t ? `${pctText(t.discount_pct)}% ` : ''}card discount,
            and their card number{customer.card_no ? ` (${customer.card_no})` : ''} is free to give to someone else. Their
            bills and points are not touched.
          </p>
        ),
        run: () => write(patch),
      })
      return
    }
    write(patch)
  }

  async function write(patch) {
    setBusy(true)
    const { data, error: err } = await settleWithin(
      scopedUpdate('pos_customers', patch).eq('id', customer.id).select(CUSTOMER_EDIT_COLUMNS),
      SAVE_MS, 'Saving the customer',
    )
    setBusy(false)
    if (err) { setError(saveFailure(err, patch)); return }
    // A refused RLS update, or a customer gone from the book, changes no row and says nothing.
    if (!data?.length) {
      setError('Nothing was saved: this login could not change this customer, or they are no longer in the customer book. Your changes are still in this form; close it and reload the page to see what is stored.')
      return
    }
    onSaved(data[0])
  }

  function saveFailure(err, patch) {
    const info = asActionError(err, 'operator')
    if (isTimeout(err) || isNetworkError(err)) {
      return { text: 'No answer came back, so it is not known whether this saved. Your changes are still in this form: close it and open the customer again to see what is stored, then save again if needed.', detail: info.detail }
    }
    if (/pos_customers_client_card_no_key/i.test(`${err.message || ''} ${err.details || ''}`) || (err.code === '23505' && /card_no/i.test(err.message || ''))) {
      const card = patch.card_no || normaliseCardNo(form.cardNo)
      return { text: `Another customer already holds card ${card}, so nothing was saved. Check the number on the card; if the card moved to ${customer.name}, take it off the other customer first.`, detail: info.detail }
    }
    return { text: `${info.text} Your changes are still in this form.`, detail: info.detail }
  }

  const heldType = typesById[customer.membership_type_id]
  const typeOptions = (types || []).filter(t => t.is_active || t.id === customer.membership_type_id)
  const datesOff = form.withdraw

  return (
    <Modal title={`${customer.name} — card, credit limit and dates`} maxWidth={760} dirty={dirty}
      onClose={() => { if (!busy) onClose() }}>
      <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--theme-text2)' }}>
        <span style={{ whiteSpace: 'nowrap' }}>{customer.phone}</span>
      </p>

      <fieldset disabled={busy} style={{ border: 'none', padding: 0, margin: 0, minWidth: 0 }}>
        {/* ── Membership card and credit limit ── */}
        <h4 style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 700, color: 'var(--theme-text1)' }}>Membership card and credit limit</h4>
        {canEditCard ? (
          <div className="field-grid" style={{ marginBottom: 8 }}>
            <div className="form-field">
              <label htmlFor="ce-type">
                <Tip text="The kind of card this customer holds. Its discount fills in by itself at the till when their phone or card number is entered. Only card types that are switched on can be given." width={300}>
                  Card type
                </Tip>
              </label>
              <select id="ce-type" className="form-select" value={form.typeId} onChange={e => pickType(e.target.value)}>
                <option value="">No card</option>
                {typeOptions.map(t => <option key={t.id} value={t.id}>{typeLabel(t)}</option>)}
              </select>
              {types.length === 0 && (
                <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--theme-text2)' }}>No card types yet: add one in Customers → Membership.</p>
              )}
            </div>
            {form.typeId && (
              <>
                <div className="form-field">
                  <label htmlFor="ce-card-no">
                    <Tip text="The number printed on the card. Optional. It is kept in capitals, and no two customers can hold the same number." width={260}>
                      Card number
                    </Tip>
                  </label>
                  <input id="ce-card-no" className="form-input" autoComplete="off" maxLength={40} value={form.cardNo}
                    placeholder="e.g. GOLD-0042" onChange={e => setForm(f => ({ ...f, cardNo: e.target.value }))}
                    {...fieldAria('ce-card-no', shown.cardNo)} />
                  <FieldError id="ce-card-no" message={shown.cardNo} />
                </div>
                <div className="form-field">
                  <label htmlFor="ce-issued">Given on</label>
                  <BsCalendarPicker id="ce-issued" ariaLabel="Card given on" value={form.issuedOn} clearable onChange={pickIssued} />
                </div>
                <div className="form-field">
                  <label htmlFor="ce-expires">
                    <Tip text="Worked out from the card type: the same date, that many months after the card was given. Change it if needed; clear it for a card that never expires. After this date the till gives no card discount." width={300}>
                      Expires on
                    </Tip>
                  </label>
                  <BsCalendarPicker id="ce-expires" ariaLabel="Card expires on" value={form.expiresOn} clearable
                    placeholder="Never expires" invalid={shown.expiresOn}
                    onChange={iso => { expiryTouched.current = true; setForm(f => ({ ...f, expiresOn: iso })) }} />
                  <FieldError id="ce-expires" message={shown.expiresOn} />
                  {autoExpiry && autoExpiry !== form.expiresOn && (
                    <button type="button" className="btn btn-ghost btn-sm" style={{ marginTop: 6 }}
                      onClick={() => {
                        expiryTouched.current = false
                        setForm(f => ({ ...f, expiresOn: autoExpiry }))
                        document.getElementById('ce-expires')?.focus() // it goes once used (S852)
                      }}>
                      Use {formatAdAsBs(autoExpiry)} (from the card type)
                    </button>
                  )}
                </div>
              </>
            )}
            <div className="form-field">
              <label htmlFor="ce-limit">
                <Tip text="The most this customer may owe on Credit bills, in rupees. The till warns when a Credit bill would take them past it, but does not refuse the bill. Leave it empty for no limit." width={300}>
                  Credit limit (NPR)
                </Tip>
              </label>
              <input id="ce-limit" className="form-input" inputMode="decimal" autoComplete="off" value={form.creditLimit}
                placeholder="No limit" onChange={e => setForm(f => ({ ...f, creditLimit: e.target.value }))}
                {...fieldAria('ce-limit', shown.creditLimit)} />
              <FieldError id="ce-limit" message={shown.creditLimit} />
            </div>
          </div>
        ) : (
          <div style={{ marginBottom: 16 }}>
            <p style={{ margin: '0 0 6px', fontSize: 13, color: 'var(--theme-text1)' }}>
              {customer.membership_type_id
                ? <>
                    <span className="badge-gray">{heldType?.name || 'Member'}</span>
                    {customer.card_no && <> · card <span style={{ whiteSpace: 'nowrap' }}>{customer.card_no}</span></>}
                    {customer.card_expires_on ? <> · expires {formatAdAsBs(customer.card_expires_on)}</> : ' · never expires'}
                  </>
                : 'No membership card.'}
              {' · '}Credit limit: {customer.credit_limit == null ? 'none' : npr(customer.credit_limit)}
            </p>
            {canManage && typesError ? (
              <ActionError error={{ ...asActionError(typesError, 'operator'), text: `The card types could not be read, so the card and credit limit cannot be changed here. Reload the page to try again. ${asActionError(typesError, 'operator').text}` }} />
            ) : canManage ? (
              <p role="status" style={{ margin: 0, fontSize: 12, color: 'var(--theme-text2)' }}>Reading the card types…</p>
            ) : (
              <p style={{ margin: 0, fontSize: 12, color: 'var(--theme-text2)' }}>
                A POS manager or the Owner gives cards and sets credit limits.
              </p>
            )}
          </div>
        )}

        {/* ── Birthday and anniversary ── */}
        {canSupervise && (
          <>
            <h4 style={{ margin: '16px 0 8px', fontSize: 13, fontWeight: 700, color: 'var(--theme-text1)' }}>Birthday and anniversary</h4>
            {customer.consent_at ? (
              form.withdraw ? (
                <div className="note-banner" role="status" style={{ marginBottom: 12 }}>
                  <strong>Saving takes back their agreement and removes both dates.</strong>{' '}
                  <button id="ce-keep-agreement" type="button" className="btn btn-ghost btn-sm"
                    onClick={() => { agreementFocus.current = 'ce-withdraw-agreement'; setForm(f => ({ ...f, withdraw: false })) }}>
                    Keep their agreement
                  </button>
                </div>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
                  <p style={{ margin: 0, fontSize: 13, color: 'var(--theme-text2)' }}>
                    <span aria-hidden="true">✓ </span>Agreed on {bsOfTs(customer.consent_at)}
                    {customer.consent_by && (
                      recordedBy.loading ? ', recorded by …'
                        : recordedBy.name ? `, recorded by ${recordedBy.name}`
                          : recordedBy.failed ? ' (who recorded it could not be read)' : ''
                    )}.
                  </p>
                  <button id="ce-withdraw-agreement" type="button" className="btn btn-ghost btn-sm"
                    onClick={() => { agreementFocus.current = 'ce-keep-agreement'; setShowErrors(false); setForm(f => ({ ...f, withdraw: true })) }}>
                    Withdraw agreement — this removes both dates
                  </button>
                </div>
              )
            ) : (
              <div className="form-field" style={{ marginBottom: 12 }}>
                <label htmlFor="ce-agreed" style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer' }}>
                  <input id="ce-agreed" type="checkbox" checked={form.agreed}
                    onChange={e => setForm(f => ({ ...f, agreed: e.target.checked }))}
                    {...fieldAria('ce-agreed', shown.agreed)} style={{ marginTop: 3 }} />
                  <span>Customer agreed that we keep their birthday and anniversary to send wishes and offers</span>
                </label>
                <FieldError id="ce-agreed" message={shown.agreed} />
              </div>
            )}
            {datesOff ? (
              <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--theme-text2)' }}>
                Now kept: {[
                  customer.birth_month != null && `birthday ${storedDateLabel({ calendar: customer.birth_calendar, month: customer.birth_month, day: customer.birth_day, year: customer.birth_year })}`,
                  customer.anniv_month != null && `anniversary ${storedDateLabel({ calendar: customer.anniv_calendar, month: customer.anniv_month, day: customer.anniv_day, year: customer.anniv_year })}`,
                ].filter(Boolean).join(', ') || 'no dates'}. Both go when you save.
              </p>
            ) : (
              <>
                <DateField idBase="ce-birth" label="Birthday" value={form.birth} error={shown.birth}
                  onChange={v => setForm(f => ({ ...f, birth: v }))} />
                <DateField idBase="ce-anniv" label="Anniversary" value={form.anniv} error={shown.anniv}
                  onChange={v => setForm(f => ({ ...f, anniv: v }))} />
              </>
            )}
          </>
        )}
      </fieldset>

      <ActionError error={error} />

      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap', margin: '12px 0 4px' }}>
        <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={save} aria-busy={busy || undefined} disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
      {confirmEl}
    </Modal>
  )
}
