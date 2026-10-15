import { memo, useCallback, useDeferredValue, useMemo, useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { useConfirm } from '../../../shared/hooks/useConfirm'
import Modal from '../../../components/Modal'
import Tip from '../../../components/Tip'
import RowMenu from '../../../components/RowMenu'
import { FilterChips } from '../../../components/Tabs'
import ReportLoadError from '../../../components/ReportLoadError'
import ActionError, { asActionError } from '../../../components/ActionError'
import FieldError, { fieldAria } from '../../../components/FieldError'
import { formatAdAsBs } from '../../../utils/bsCalendar'
import { settleWithin, isTimeout } from '../../../utils/withTimeout'
import { isNetworkError } from '../../../shared/errorText'
import { npr } from '../../../shared/nepalMoney'
import { phoneMatchesSearch } from '../../../utils/phone'
import { memberStatus, pctText, todayNepalIso } from '../orders/memberDiscount'
import { TYPE_COLUMNS } from './useMembershipTypes'
import { occasionDatesOf, storedDateLabel, upcomingOccasions } from './occasions'
import OccasionsList from './OccasionsList'
import CustomerEditModal from './CustomerEditModal'

// Customers → Membership (S843): the outlet's membership card types, who holds a card, and the
// birthdays and anniversaries coming up.
//
// It reads nothing of the customer book itself: PosCustomers already holds the whole book (every
// column, paged) and the card types (useMembershipTypes), and passes both in, so one read feeds the
// book's badges, this tab and the edit dialog alike. A save here updates the page's copy of the row.
//
// Who may do what is the database's: card types, cards and credit limits are a POS manager's or the
// Owner's (`canManage`; guard_pos_membership_types, pos_customers_guard_loyalty); birthdays,
// anniversaries and the customer's agreement are a supervisor's and up, which is everyone who can
// open this page. A type a customer holds cannot be deleted (membership_type_in_use); it is switched
// off instead, and while it is off the till gives its holders no card discount (memberDiscount.js),
// which the switch says before it is pressed.

const WRITE_MS = 20000
const SHOW_MAX = 200
const NO_ROWS = []
const DAY_OPTIONS = [{ key: '7', label: 'Next 7 days' }, { key: '30', label: 'Next 30 days' }]

// A card as the till sees it today (memberDiscount.memberStatus), as a chip. Category is badge-yellow
// in POS; an expired card is a warning; a switched-off type gives nothing, so it reads as inert.
export function CardBadge({ customer, typesById, todayIso }) {
  if (!customer.membership_type_id) return <span style={{ color: 'var(--theme-text3)' }}>—</span>
  const type = typesById[customer.membership_type_id]
  if (!type) return <span className="badge-yellow">Card</span>
  const s = memberStatus({ ...customer, pos_membership_types: type }, todayIso)
  if (s.kind === 'expired') return <span className="badge-amber" title="Past its expiry date: the till gives no card discount">{type.name} · expired</span>
  if (s.kind === 'inactive') return <span className="badge-gray" title="This card type is switched off: the till gives no card discount">{type.name} · switched off</span>
  return <span className="badge-yellow">{type.name}</span>
}

function DatesCell({ customer }) {
  const dates = occasionDatesOf(customer)
  if (!dates.length) return <span style={{ color: 'var(--theme-text3)' }}>—</span>
  return (
    <span style={{ fontSize: 12, color: 'var(--theme-text2)' }}>
      {dates.map(d => (
        <span key={d.kind} style={{ display: 'block', whiteSpace: 'nowrap' }}>
          <span aria-hidden="true">{d.kind === 'birthday' ? '🎂' : '💍'} </span>
          <span className="sr-only">{d.kind === 'birthday' ? 'Birthday' : 'Anniversary'}: </span>
          {storedDateLabel(d)}
        </span>
      ))}
    </span>
  )
}

const MemberRows = memo(function MemberRows({ rows, typesById, todayIso, onEdit }) {
  return rows.map(c => (
    <tr key={c.id}>
      <td>
        <div style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{c.name}</div>
        <div style={{ fontSize: 12, color: 'var(--theme-text2)', whiteSpace: 'nowrap' }}>{c.phone}</div>
      </td>
      <td><CardBadge customer={c} typesById={typesById} todayIso={todayIso} /></td>
      <td style={{ whiteSpace: 'nowrap' }}>{c.card_no || '—'}</td>
      <td style={{ whiteSpace: 'nowrap' }}>{c.membership_type_id ? (c.card_expires_on ? formatAdAsBs(c.card_expires_on) : 'Never') : '—'}</td>
      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{c.credit_limit == null ? '—' : npr(c.credit_limit)}</td>
      <td><DatesCell customer={c} /></td>
      <td style={{ textAlign: 'right' }}>
        <button type="button" className="btn btn-ghost" onClick={() => onEdit(c)} aria-label={`Edit ${c.name}`}>Edit</button>
      </td>
    </tr>
  ))
})

// Add or change a card type. Writes nothing until Save; the tab asks first when a changed discount
// reaches customers who already hold the card.
function TypeModal({ type, types, holding = 0, onClose, onSave }) {
  const [name, setName] = useState(type?.name || '')
  const [pct, setPct] = useState(type ? pctText(type.discount_pct) : '')
  const [months, setMonths] = useState(type?.valid_months == null ? '' : String(type.valid_months))
  const [showErrors, setShowErrors] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  // A changed discount reaches every holder from their next bill, so the first Save says that and the
  // second one saves (no hidden dialog to cancel out of).
  const [warnedPct, setWarnedPct] = useState(null)

  const trimmed = name.trim()
  const clash = types.find(t => t.id !== type?.id && t.name.trim().toLowerCase() === trimmed.toLowerCase())
  const pctNum = Number(pct)
  const errs = {
    name: !trimmed ? 'Type a name for the card, for example Gold.'
      : trimmed.length > 40 ? 'A card type name is at most 40 characters.'
        : clash ? `There is already a card type called ${clash.name}.` : '',
    pct: pct.trim() === '' || !Number.isFinite(pctNum) || pctNum <= 0 || pctNum > 100
      ? 'Type the discount as a percent above 0 and up to 100, for example 10.'
      : !/^\d+(\.\d{1,2})?$/.test(pct.trim()) ? 'Use at most two decimal places, for example 12.5.' : '',
    months: months.trim() !== '' && !(/^\d+$/.test(months.trim()) && Number(months) >= 1 && Number(months) <= 120)
      ? 'Type whole months from 1 to 120, or leave it empty for a card that never expires.' : '',
  }
  const shown = showErrors ? errs : {}
  const warning = !!type && warnedPct != null && warnedPct === Math.round(pctNum * 100) / 100
  const dirty = name !== (type?.name || '') || pct !== (type ? pctText(type.discount_pct) : '') || months !== (type?.valid_months == null ? '' : String(type.valid_months))

  async function save() {
    if (busy) return
    setShowErrors(true)
    setError(null)
    const first = ['name', 'pct', 'months'].find(k => errs[k])
    if (first) { document.getElementById(`mt-${first}`)?.focus(); return }
    const discount = Math.round(pctNum * 100) / 100
    if (type && holding > 0 && discount !== Number(type.discount_pct) && warnedPct !== discount) { setWarnedPct(discount); return }
    setBusy(true)
    const failure = await onSave({ name: trimmed, discount_pct: discount, valid_months: months.trim() === '' ? null : Number(months) })
    setBusy(false)
    if (failure) setError(failure)
  }

  return (
    <Modal title={type ? `Change the ${type.name} card type` : 'Add a card type'} maxWidth={560} dirty={dirty}
      onClose={() => { if (!busy) onClose() }}>
      <fieldset disabled={busy} style={{ border: 'none', padding: 0, margin: 0, minWidth: 0 }}>
        <div className="field-grid">
          <div className="form-field">
            <label htmlFor="mt-name">Name</label>
            <input id="mt-name" className="form-input" autoComplete="off" maxLength={60} value={name} placeholder="Gold"
              onChange={e => setName(e.target.value)} {...fieldAria('mt-name', shown.name)} />
            <FieldError id="mt-name" message={shown.name} />
          </div>
          <div className="form-field">
            <label htmlFor="mt-pct">
              <Tip text="Taken off a member's bill as an ordinary bill discount, filled in by itself at the till. A cashier's own discount limit still applies." width={280}>
                Discount %
              </Tip>
            </label>
            <input id="mt-pct" className="form-input" inputMode="decimal" autoComplete="off" value={pct} placeholder="10"
              onChange={e => setPct(e.target.value)} {...fieldAria('mt-pct', shown.pct)} />
            <FieldError id="mt-pct" message={shown.pct} />
          </div>
          <div className="form-field">
            <label htmlFor="mt-months">
              <Tip text="How long a card of this type lasts from the day it is given; it fills in the card's expiry date. Leave it empty for a card that never expires. Changing it later does not change cards already given." width={300}>
                Lasts (months)
              </Tip>
            </label>
            <input id="mt-months" className="form-input" inputMode="numeric" autoComplete="off" value={months} placeholder="Never expires"
              onChange={e => setMonths(e.target.value)} {...fieldAria('mt-months', shown.months)} />
            <FieldError id="mt-months" message={shown.months} />
          </div>
        </div>
      </fieldset>
      {warning && (
        <div className="note-banner" role="status" style={{ marginTop: 12 }}>
          <strong>{holding} customer{holding === 1 ? ' holds' : 's hold'} a {type.name} card.</strong> From their next bill the
          till gives them {pctText(warnedPct)}% off instead of {pctText(type.discount_pct)}%. Bills already closed keep the
          discount they were given. Press the button again to change it.
        </div>
      )}
      <ActionError error={error} />
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap', margin: '12px 0 4px' }}>
        <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={save} disabled={busy} aria-busy={busy || undefined}>
          {busy ? 'Saving…' : warning ? `Change the discount for ${holding} customer${holding === 1 ? '' : 's'}` : type ? 'Save' : 'Add card type'}
        </button>
      </div>
    </Modal>
  )
}

// A write's failure in words: no answer is "not known", never "not saved".
function writeFailure(err, lead) {
  const info = asActionError(err, 'operator')
  if (isTimeout(err) || isNetworkError(err)) {
    return { text: `No answer came back, so it is not known whether ${lead}. Reload the page to see what is stored before trying again.`, detail: info.detail }
  }
  return info
}

export default function MembershipTab({ book, typesState, canManage = false, onCustomerSaved }) {
  const { isAdmin, adminViewClientName, profile } = useAuth()
  const { scopedInsert, scopedUpdate, scopedDelete } = useScopedDb()
  const { ask: askConfirm, confirmEl } = useConfirm()
  const outletName = (isAdmin ? adminViewClientName : profile?.clients?.name) || ''

  const [days, setDays] = useState('7')
  const [view, setView] = useState(null) // 'holders' | 'all'; null = holders when anyone holds a card
  const [search, setSearch] = useState('')
  const deferredSearch = useDeferredValue(search)
  const [editing, setEditing] = useState(null)
  const [typeDialog, setTypeDialog] = useState(null) // { type } (null type = add)
  const [msg, setMsg] = useState(null)               // { kind: 'ok'|'error', text, detail, offerOff }
  const onEdit = useCallback(c => { setMsg(null); setEditing(c) }, [])

  const rows = book.rows || NO_ROWS
  const { types, byId: typesById } = typesState
  const todayIso = todayNepalIso()

  const holdersByType = useMemo(() => {
    const by = {}
    for (const c of rows) if (c.membership_type_id) by[c.membership_type_id] = (by[c.membership_type_id] || 0) + 1
    return by
  }, [rows])
  const holders = useMemo(() => rows.filter(c => c.membership_type_id), [rows])
  const occasions = useMemo(() => upcomingOccasions(rows, Number(days)), [rows, days])
  const withDates = useMemo(() => rows.filter(c => occasionDatesOf(c).length > 0).length, [rows])

  const activeView = view || (holders.length > 0 ? 'holders' : 'all')
  const q = deferredSearch.trim().toLowerCase()
  const listed = useMemo(() => {
    const base = activeView === 'holders' ? holders : rows
    if (!q) return base
    const upper = q.toUpperCase()
    return base.filter(c => String(c.name || '').toLowerCase().includes(q) || phoneMatchesSearch(c.phone, q)
      || String(c.card_no || '').includes(upper))
  }, [activeView, holders, rows, q])
  const shownRows = listed.length > SHOW_MAX ? listed.slice(0, SHOW_MAX) : listed

  const bookLoading = book.loading
  const bookError = book.error

  // ── Card type writes ──
  // Returns null when it saved, else what to say in the dialog (which stays open with the form).
  async function saveType(type, values) {
    const lead = type ? `the ${type.name} card type was changed` : 'the card type was added'
    const write = type
      ? scopedUpdate('pos_membership_types', values).eq('id', type.id).select(TYPE_COLUMNS)
      : scopedInsert('pos_membership_types', values)
    const { data, error } = await settleWithin(write, WRITE_MS, 'Saving the card type')
    if (error) return writeFailure(error, lead)
    if (!data?.length) return 'Nothing was saved: this login could not change card types, or the type is gone. Reload the page to see what is stored.'
    setTypeDialog(null)
    setMsg({ kind: 'ok', text: type ? `${values.name} saved.` : `${values.name} added. Give it to a customer with Edit on their row.` })
    typesState.reload()
    return null
  }

  async function setActive(type, on) {
    setMsg(null)
    const { data, error } = await settleWithin(
      scopedUpdate('pos_membership_types', { is_active: on }).eq('id', type.id).select('id'),
      WRITE_MS, 'Switching the card type',
    )
    if (error) {
      const f = writeFailure(error, `${type.name} was switched ${on ? 'on' : 'off'}`)
      setMsg({ kind: 'error', ...(typeof f === 'string' ? { text: f } : f) })
      return
    }
    if (!data?.length) { setMsg({ kind: 'error', text: `${type.name} was not switched ${on ? 'on' : 'off'}: this login could not change it, or it is gone. Reload the page.` }); return }
    setMsg({ kind: 'ok', text: on ? `${type.name} is switched on: it can be given, and its holders get its discount again.` : `${type.name} is switched off.` })
    typesState.reload()
  }

  function offBody(type, holding) {
    return (
      <p style={{ margin: 0 }}>
        Nobody new can be given a {type.name} card.
        {holding > 0
          ? <> {holding === 1 ? 'The 1 customer who holds one keeps' : `The ${holding} customers who hold one keep`} their card, but while it is switched off the till gives them <strong>no card discount</strong>. Switch it back on to give it again.</>
          : ' No customer holds one now.'}
      </p>
    )
  }

  function askSwitchOff(type) {
    const holding = holdersByType[type.id] || 0
    if (holding === 0 && !bookError) { setActive(type, false); return }
    askConfirm({
      title: `Switch off ${type.name}?`, confirmLabel: 'Switch it off', busyLabel: 'Switching…',
      body: offBody(type, holding), run: () => setActive(type, false),
    })
  }

  function askDelete(type) {
    setMsg(null)
    const holding = holdersByType[type.id] || 0
    if (holding > 0 && !type.is_active) {
      setMsg({ kind: 'error', text: `${type.name} cannot be deleted: ${holding} customer${holding === 1 ? ' holds' : 's hold'} a card of this type, so it stays on record. It is already switched off, so nobody new can be given one. To delete it, take the card away from each holder first (Edit on their row).` })
      return
    }
    if (holding > 0) {
      askConfirm({
        title: `${type.name} cannot be deleted`,
        confirmLabel: 'Switch it off instead', busyLabel: 'Switching…',
        body: (
          <>
            <p style={{ margin: '0 0 8px' }}>
              {holding} customer{holding === 1 ? ' holds' : 's hold'} a {type.name} card, so the type stays on record.
              You can switch it off instead.
            </p>
            {offBody(type, holding)}
          </>
        ),
        run: () => setActive(type, false),
      })
      return
    }
    askConfirm({
      title: `Delete the ${type.name} card type?`, confirmLabel: 'Delete card type', danger: true, busyLabel: 'Deleting…',
      body: <p style={{ margin: 0 }}>{bookError ? 'The customer book could not be read, so whether anyone holds it is checked when you delete.' : 'No customer holds it.'} This cannot be undone.</p>,
      run: async () => {
        const { data, error } = await settleWithin(scopedDelete('pos_membership_types').eq('id', type.id).select('id'), WRITE_MS, 'Deleting the card type')
        if (error) {
          const inUse = /membership_type_in_use/.test(`${error.hint || ''} ${error.message || ''}`)
          const f = writeFailure(error, `${type.name} was deleted`)
          setMsg({ kind: 'error', ...(typeof f === 'string' ? { text: f } : f), offerOff: inUse && type.is_active ? type : null })
          return
        }
        if (!data?.length) { setMsg({ kind: 'error', text: `${type.name} was not deleted: this login could not delete it, or it was already gone. Reload the page.` }); return }
        setMsg({ kind: 'ok', text: `${type.name} deleted.` })
        typesState.reload()
      },
    })
  }

  // ── Render ──
  const typeSection = (
    <div className="card" style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <div>
          <h2 style={{ margin: '0 0 4px', fontSize: 14, fontWeight: 700, color: 'var(--theme-text1)' }}>Card types</h2>
          <p style={{ margin: 0, fontSize: 12, color: 'var(--theme-text2)' }}>The kinds of membership card this outlet gives, and the discount each one takes off a bill.</p>
        </div>
        {canManage && Array.isArray(types) && (
          <button type="button" className="btn btn-primary" onClick={() => { setMsg(null); setTypeDialog({ type: null }) }}>+ Add card type</button>
        )}
      </div>
      {typesState.loading ? (
        <p role="status" style={{ margin: 0, fontSize: 13, color: 'var(--theme-text2)' }}>Loading card types…</p>
      ) : typesState.error ? (
        <ReportLoadError error={typesState.error} />
      ) : (
        <>
          {typesState.stale && (() => {
            const why = asActionError(typesState.stale, 'operator')
            return <ActionError error={{ text: `The card types could not be read again, so this is the list as it was last read. Reload the page to try again. ${why.text}`, detail: why.detail }} />
          })()}
          {types.length === 0 ? (
            <p style={{ margin: 0, fontSize: 13, color: 'var(--theme-text2)' }}>
              No card types yet.{canManage ? ' Add one to start giving membership cards.' : ' A POS manager or the Owner adds them.'}
            </p>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Card type</th>
                    <th style={{ textAlign: 'right' }}>Discount</th>
                    <th><Tip text="How long a card lasts from the day it is given. Changing it does not change cards already given." width={260}>Lasts</Tip></th>
                    <th style={{ textAlign: 'right' }}><Tip text="Customers holding this card now, from the customer book on this page." width={240}>Holders</Tip></th>
                    <th><Tip text="Only a switched-on type can be given, and only its holders get its discount at the till." width={260}>Status</Tip></th>
                    {canManage && <th><span className="sr-only">Actions</span></th>}
                  </tr>
                </thead>
                <tbody>
                  {types.map(t => (
                    <tr key={t.id}>
                      <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{t.name}</td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{pctText(t.discount_pct)}%</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{t.valid_months ? `${t.valid_months} month${t.valid_months === 1 ? '' : 's'}` : 'Never expires'}</td>
                      <td style={{ textAlign: 'right' }}>{bookError ? '—' : (holdersByType[t.id] || 0)}</td>
                      <td>{t.is_active ? <span className="badge-green">On</span> : <span className="badge-gray">Switched off</span>}</td>
                      {canManage && (
                        <td style={{ textAlign: 'right' }}>
                          <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                            {t.is_active
                              ? <button type="button" className="btn btn-ghost" onClick={() => { setMsg(null); askSwitchOff(t) }} aria-label={`Switch off ${t.name}`}>Switch off</button>
                              : <button type="button" className="btn btn-ghost" onClick={() => setActive(t, true)} aria-label={`Switch on ${t.name}`}>Switch on</button>}
                            <RowMenu label={`More for ${t.name}`} items={[
                              { key: 'edit', label: 'Change name, discount or length…', onSelect: () => { setMsg(null); setTypeDialog({ type: t }) } },
                              '-',
                              { key: 'delete', label: 'Delete…', danger: true, onSelect: () => askDelete(t) },
                            ]} />
                          </span>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )

  return (
    <div>
      {msg && (msg.kind === 'ok'
        ? <p role="status" style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--theme-green-text)' }}>✓ {msg.text}</p>
        : (
          <div style={{ marginBottom: 12 }}>
            <ActionError error={{ text: msg.text, detail: msg.detail }} className="action-error--top" />
            {msg.offerOff && (
              <button type="button" className="btn btn-ghost" onClick={() => askSwitchOff(msg.offerOff)}>
                Switch {msg.offerOff.name} off instead
              </button>
            )}
          </div>
        ))}

      {!canManage && (
        <p role="note" style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--theme-text2)' }}>
          Card types, membership cards and credit limits are set by a POS manager or the Owner. You can record a
          customer&apos;s birthday and anniversary with Edit on their row.
        </p>
      )}

      {bookLoading ? (
        <p role="status" style={{ fontSize: 13, color: 'var(--theme-text2)' }}>Loading the customer book…</p>
      ) : bookError ? (
        <ReportLoadError error={bookError} />
      ) : (
        <>
          {book.stale && (() => {
            const why = asActionError(book.stale, 'operator')
            return <ActionError error={{ text: `The customer book could not be read again, so the lists below are as they were last read. Reload the page to try again. ${why.text}`, detail: why.detail }} />
          })()}

          {/* ── Birthdays and anniversaries ── */}
          <div className="card" style={{ marginBottom: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
              <div>
                <h2 style={{ margin: '0 0 4px', fontSize: 14, fontWeight: 700, color: 'var(--theme-text1)' }}>Birthdays &amp; anniversaries</h2>
                <p style={{ margin: 0, fontSize: 12, color: 'var(--theme-text2)' }}>
                  Only customers who agreed to keep their dates. WhatsApp opens a wish to send from your own phone.
                </p>
              </div>
              <FilterChips label="How far ahead" options={DAY_OPTIONS} active={days} onChange={setDays} />
            </div>
            {occasions.length === 0 ? (
              <p style={{ margin: 0, fontSize: 13, color: 'var(--theme-text2)' }}>
                No birthdays or anniversaries in the next {days} days.
                {withDates === 0 && ' No customer has a date recorded yet: add one with Edit on their row below, once they agree.'}
              </p>
            ) : (
              <OccasionsList items={occasions} outletName={outletName} variant="table" />
            )}
          </div>

          {/* ── Members ── */}
          <div className="card" style={{ marginBottom: 20 }}>
            <h2 style={{ margin: '0 0 4px', fontSize: 14, fontWeight: 700, color: 'var(--theme-text1)' }}>Members</h2>
            <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--theme-text2)' }}>
              {canManage
                ? 'Give a card, set a credit limit, or record a birthday or anniversary with Edit. To give someone a card, show Everyone and find them.'
                : 'Record a birthday or anniversary with Edit.'}
            </p>
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 10 }}>
              <FilterChips label="Which customers" active={activeView} onChange={setView} options={[
                { key: 'holders', label: `Card holders (${holders.length})` },
                { key: 'all', label: `Everyone (${rows.length})` },
              ]} />
              <div className="form-field" style={{ margin: 0, flex: '1 1 220px', maxWidth: 320 }}>
                <label htmlFor="membership-search">Find a customer</label>
                <input id="membership-search" type="search" className="form-input" autoComplete="off" value={search}
                  placeholder="Name, phone or card number" onChange={e => setSearch(e.target.value)} />
              </div>
            </div>
            {(q || listed.length > SHOW_MAX) && listed.length > 0 && (
              <p role="status" style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--theme-text2)' }}>
                {listed.length > SHOW_MAX
                  ? `Showing the first ${SHOW_MAX} of ${listed.length}. Search by name, phone or card number to find others.`
                  : `Showing ${listed.length} of ${activeView === 'holders' ? holders.length : rows.length}.`}
              </p>
            )}
            {listed.length === 0 ? (
              <p style={{ margin: 0, fontSize: 13, color: 'var(--theme-text2)' }}>
                {q ? 'No customer matches.'
                  : activeView === 'holders'
                    ? `No customer holds a card yet.${canManage ? ' Show Everyone to give one.' : ''}`
                    : 'No customers yet — the book fills itself from any bill closed with a name and phone.'}
              </p>
            ) : (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Customer</th>
                      <th><Tip text="The card as the till sees it today. Expired: past its expiry date. Switched off: its type is off. Neither gets the card discount." width={300}>Card</Tip></th>
                      <th>Card no.</th>
                      <th>Expires</th>
                      <th style={{ textAlign: 'right' }}><Tip text="The most this customer may owe on Credit bills. The till warns past it; it does not refuse the bill." width={260}>Credit limit</Tip></th>
                      <th><Tip text="Birthday and anniversary, kept only with the customer's agreement. (BS) is the Nepali calendar, (AD) the English one." width={280}>Dates</Tip></th>
                      <th><span className="sr-only">Edit</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    <MemberRows rows={shownRows} typesById={typesById} todayIso={todayIso} onEdit={onEdit} />
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {typeSection}

      {editing && (
        <CustomerEditModal
          customer={editing}
          types={types}
          typesError={typesState.error}
          canManage={canManage}
          onClose={() => setEditing(null)}
          onSaved={row => {
            setEditing(null)
            onCustomerSaved(row)
            setMsg({ kind: 'ok', text: `${editing.name}'s details saved.` })
          }}
        />
      )}
      {typeDialog && (
        <TypeModal type={typeDialog.type} types={types || []} holding={typeDialog.type ? (holdersByType[typeDialog.type.id] || 0) : 0}
          onClose={() => setTypeDialog(null)}
          onSave={values => saveType(typeDialog.type, values)} />
      )}
      {confirmEl}
    </div>
  )
}
