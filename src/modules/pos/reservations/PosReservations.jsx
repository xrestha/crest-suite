import { Fragment, useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { supabase } from '../../../supabaseClient'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'
import { useBizInfo } from '../../../shared/hooks/useBizInfo'
import { firstError } from '../../../shared/queryError'
import { setIfChanged, rowsSignature } from '../../../shared/setIfChanged'
import ReportLoadError from '../../../components/ReportLoadError'
import ActionError, { asActionError } from '../../../components/ActionError'
import ConfirmModal from '../../../components/ConfirmModal'
import Modal from '../../../components/Modal'
import BsCalendarPicker from '../../../components/BsCalendarPicker'
import Fab from '../../../components/Fab'
import Tip from '../../../components/Tip'
import RowDisclosure from '../../../components/RowDisclosure'
import RowMenu from '../../../components/RowMenu'
import { adToBs, bsDayBoundaryIso, formatAd, formatBsDay } from '../../../utils/bsCalendar'
import { normalizePhone } from '../../../utils/phone'
import { nepalTime, nepalCivilDate, nepalBs, nepalDateLong } from '../../../shared/nepalTime'
import { RESERVATION_STATUS_BADGE, IDENTITY_BADGE } from '../posSignals'
import { playChime } from '../posChime'
import {
  STATUS_LABEL, LIVE_STATUSES, canTransition, canRevive, stampFor, isLate, waitingMinutes, tableIdsOf,
  RESERVATION_SELECT, SOURCE_LABEL, CANCEL_REASONS, DECLINE_REASONS,
} from './reservationStatus'
import { normalizeReservationSettings, DEFAULT_RESERVATION_SETTINGS } from './reservationSettings'
import { bookedCoversByHour, overSeatsHours } from './reservationCapacity'
import { fillTemplate, openWhatsApp } from './whatsappLink'
import ReservationModal from './ReservationModal'
import SeatTableModal from './SeatTableModal'

const REQUEST_POLL_MS = 15000
// The day list refreshes on its own too, so a colleague's "Arrived" on the door phone reaches the
// till without anyone acting here. Less often than requests: nothing chimes for it.
const LIST_POLL_MS = 30000
const NOTICE_MS = 8000
const NOTE_PREVIEW = 60

const todayIso = () => formatAd(nepalCivilDate(new Date()))
const plusDaysIso = (iso, n) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return formatAd(d) }
// The BS day a picked AD day names, as the pair of instants that bound it in Nepal.
function dayBoundsOf(iso) {
  const bs = adToBs(new Date(iso + 'T00:00:00'))
  return { bs, start: bsDayBoundaryIso(bs.year, bs.month, bs.day, false), end: bsDayBoundaryIso(bs.year, bs.month, bs.day, true) }
}
const bsLabelOf = bs => (bs ? `${formatBsDay(bs.day, bs.month)} ${bs.year}` : '')
const hourLabel = h => h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`
const parseHour = s => { const m = /^(\d{1,2}):(\d{2})$/.exec(s || ''); return m ? Number(m[1]) : null }
// The Nepal civil day a booking falls on, as the same 'YYYY-MM-DD' the day picker speaks.
const rowDayIso = r => { const d = nepalCivilDate(r.reserved_for); return d ? formatAd(d) : null }
// One shape for every phone in the column — the book stores what was typed ("9841-234567",
// "+977 98…"), and three shapes for one thing read as three things.
const displayPhone = p => normalizePhone(p) || p || ''

// The signature the two polls compare against. Every field the row DRAWS is here (frontend-
// performance.md: one omitted field is a stale render that never repaints). Table assignment is
// nested, so it is folded in by hand.
const rowsSig = rows => rowsSignature(rows, [
  'id', 'status', 'reserved_for', 'party_size', 'customer_name', 'phone', 'notes', 'occasion',
  'duration_minutes', 'cancel_reason', 'source', 'arrived_at', 'order_id',
]) + '#' + (rows || []).map(r => tableIdsOf(r).join('+')).join(',')
const idsSig = set => [...set].sort().join(',')

// What the status line says a move did. Seated is not here: it leaves the page.
const VERB = { confirmed: 'confirmed', arrived: 'marked arrived', completed: 'marked done', no_show: 'marked no-show', booked: 'reinstated' }

/**
 * The reservations book. Staff-operated but read at a desk between services, so it wears the
 * product shell (page-header, stat-grid, tab-bar, data-table) rather than the till idiom — the
 * S613 boundary: a POS page is a report unless it is operated mid-service. Seating a party hands
 * off to Order Taking, which is the mid-service screen.
 *
 * Row actions (S681): ONE next step, the WhatsApp button, and a ⋯ menu for everything else. A
 * booked row used to carry six identical pills with the irreversible moves mixed among the routine
 * ones; twenty rows on a Saturday was a wall. The next step is the most likely legal move
 * (Confirm → Arrived → Seat); No-show, Cancel, Done and the same-day reversals live in the menu.
 */
export default function PosReservations() {
  const { clientId, hasPosAccess } = useAuth()
  const { scopedFrom, scopedUpdate } = useScopedDb()
  const navigate = useNavigate()
  const biz = useBizInfo()
  const dayReq = useLatestRequest()

  const [dayIso,   setDayIso]   = useState(todayIso)
  const [filter,   setFilter]   = useState('day') // 'day' | 'unconfirmed' | 'upcoming'
  const [rows,     setRows]     = useState([])
  const [requests, setRequests] = useState([])
  const [tables,   setTables]   = useState([])
  const [openTableIds, setOpenTableIds] = useState(() => new Set())
  const [settings, setSettings] = useState(DEFAULT_RESERVATION_SETTINGS)
  const [hours,    setHours]    = useState({ open: '', close: '' })
  const [loading,  setLoading]  = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [actionError, setActionError] = useState(null)
  const [notice,   setNotice]   = useState(null)   // { text, jumpIso } — what the last move did
  const [busyId,   setBusyId]   = useState(null)
  const [modal,    setModal]    = useState(null)   // { row } — row null for a new booking
  const [seatTarget,   setSeatTarget]   = useState(null)
  const [cancelTarget, setCancelTarget] = useState(null)
  const [cancelReason, setCancelReason] = useState('')
  const [noShowTarget, setNoShowTarget] = useState(null)
  const [doneTarget,   setDoneTarget]   = useState(null)
  const [reviveTarget, setReviveTarget] = useState(null)
  const [expandedId, setExpandedId] = useState(null)
  const [now, setNow] = useState(() => Date.now())
  const seenRequestIds = useRef(new Set())
  const requestsLoadedOnce = useRef(false)

  // The request band chimes once per genuinely new arrival, never on a re-poll of one already
  // seen — the loadPendingGuestOrders pattern. A failed poll keeps the last good list.
  const commitRequests = useCallback((list) => {
    if (requestsLoadedOnce.current && list.some(r => !seenRequestIds.current.has(r.id))) playChime()
    seenRequestIds.current = new Set(list.map(r => r.id))
    requestsLoadedOnce.current = true
    setIfChanged(setRequests, list, l => rowsSignature(l, ['id', 'status', 'reserved_for', 'party_size']))
  }, [])

  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!clientId) return
    const key = `${dayIso}|${filter}`
    dayReq.begin(key)
    if (!quiet) { setLoading(true); setLoadError(null) }
    const from = filter === 'upcoming' ? dayBoundsOf(todayIso()) : dayBoundsOf(dayIso)
    const to   = filter === 'upcoming' ? dayBoundsOf(plusDaysIso(todayIso(), 7)) : from
    const results = await Promise.all([
      // Bounded to one day (or seven), so deliberately not paged: a single outlet's bookings for
      // a week cannot approach the 1000-row cap. Requests are excluded here and read below.
      scopedFrom('pos_reservations', RESERVATION_SELECT)
        .neq('status', 'requested')
        .gte('reserved_for', from.start).lte('reserved_for', to.end)
        .order('reserved_for').order('id'),
      scopedFrom('pos_reservations', RESERVATION_SELECT).eq('status', 'requested').order('reserved_for').order('id'),
      scopedFrom('pos_tables', 'id, name, section, capacity, status').order('sort_order').order('name'),
      scopedFrom('pos_orders', 'id, table_id').eq('status', 'open'),
      supabase.from('settings').select('pos_reservation_settings, pos_open_time, pos_close_time').eq('client_id', clientId).maybeSingle(),
    ])
    if (!dayReq.isCurrent(key)) return
    // A failed read is not an empty day, and must never render as one (S594). A failed QUIET
    // refresh keeps the last good page rather than replacing it with the error card.
    const failed = firstError(results)
    if (failed) {
      if (quiet) { console.error('reservation list refresh failed, keeping last known:', failed); return }
      setLoadError(failed); setLoading(false); return
    }
    const [{ data: dayRows }, { data: reqRows }, { data: tbls }, { data: open }, { data: s }] = results
    // setIfChanged throughout: this runs on a 30 s timer for as long as the book is open, and the
    // usual answer is "nothing moved" — a bare setter would re-render the whole table each tick.
    setIfChanged(setRows, dayRows || [], rowsSig)
    commitRequests(reqRows || [])
    setIfChanged(setTables, tbls || [], l => rowsSignature(l, ['id', 'name', 'section', 'capacity', 'status']))
    setIfChanged(setOpenTableIds, new Set((open || []).map(o => o.table_id).filter(Boolean)), idsSig)
    setIfChanged(setSettings, normalizeReservationSettings(s?.pos_reservation_settings), v => JSON.stringify(v))
    setIfChanged(setHours, { open: s?.pos_open_time || '', close: s?.pos_close_time || '' }, v => `${v.open}|${v.close}`)
    setLoading(false)
  }, [clientId, dayIso, filter, scopedFrom, commitRequests]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load() }, [load])

  // Public requests arrive on their own clock. Polled, not realtime — nothing in this app is.
  useEffect(() => {
    if (!clientId) return
    const poll = async () => {
      if (!navigator.onLine) return
      const { data, error } = await scopedFrom('pos_reservations', RESERVATION_SELECT).eq('status', 'requested').order('reserved_for').order('id')
      if (error) { console.error('reservation request poll failed, keeping last known:', error); return }
      commitRequests(data || [])
    }
    const id = setInterval(poll, REQUEST_POLL_MS)
    return () => clearInterval(id)
  }, [clientId, scopedFrom, commitRequests])

  // The day list too — see LIST_POLL_MS. Skipped while a dialog is open so a refresh cannot
  // pull a row out from under a decision being made about it.
  const dialogOpen = !!(modal || seatTarget || cancelTarget || noShowTarget || doneTarget || reviveTarget)
  useEffect(() => {
    if (!clientId || dialogOpen) return
    const id = setInterval(() => { if (navigator.onLine) load({ quiet: true }) }, LIST_POLL_MS)
    return () => clearInterval(id)
  }, [clientId, dialogOpen, load])

  // Late/due flags move with the clock, not with the data.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60000)
    return () => clearInterval(t)
  }, [])

  // The status line clears itself; the next move replaces it.
  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), NOTICE_MS)
    return () => clearTimeout(t)
  }, [notice])

  const liveRows = useMemo(() => rows.filter(r => LIVE_STATUSES.includes(r.status)), [rows])
  const visibleRows = useMemo(() => (filter === 'unconfirmed' ? rows.filter(r => r.status === 'booked') : rows), [rows, filter])
  const tableName = useMemo(() => Object.fromEntries(tables.map(t => [t.id, t.name])), [tables])
  const totalSeats = useMemo(() => tables.filter(t => t.status !== 'inactive').reduce((s, t) => s + (Number(t.capacity) || 0), 0), [tables])

  const stats = useMemo(() => ({
    bookings:    liveRows.length,
    covers:      liveRows.reduce((s, r) => s + (Number(r.party_size) || 0), 0),
    unconfirmed: rows.filter(r => r.status === 'booked').length,
    waiting:     rows.filter(r => r.status === 'arrived').length,
  }), [rows, liveRows])

  // Guests expected per hour against the room, for a single day.
  const capacity = useMemo(() => {
    if (filter === 'upcoming') return null
    const buckets = bookedCoversByHour(liveRows)
    const over = new Set(overSeatsHours(buckets, totalSeats))
    let first = parseHour(hours.open) ?? 10
    let last  = parseHour(hours.close) ?? 22
    if (last < first) last = 23 // overnight hours: show through midnight
    for (const b of buckets) if (b.covers > 0) { first = Math.min(first, b.hour); last = Math.max(last, b.hour) }
    return { cells: buckets.slice(first, last + 1), over }
  }, [liveRows, totalSeats, hours, filter])

  // The week view cannot sum hours across days, so it answers the one question the strip is for:
  // which days have an hour over seats. Empty list = none; null = not the week view.
  const weekOver = useMemo(() => {
    if (filter !== 'upcoming' || !(totalSeats > 0)) return null
    const byDay = new Map()
    for (const r of liveRows) { const k = rowDayIso(r); if (k) (byDay.get(k) || byDay.set(k, []).get(k)).push(r) }
    const out = []
    for (const [iso, list] of [...byDay.entries()].sort()) {
      const over = overSeatsHours(bookedCoversByHour(list), totalSeats)
      if (over.length) out.push({ iso, label: bsLabelOf(dayBoundsOf(iso).bs), hours: over.map(hourLabel) })
    }
    return out
  }, [liveRows, totalSeats, filter])

  if (!hasPosAccess('staff')) return <Navigate to="/pos" replace />

  // Every status move goes through here. The `.eq('status', row.status)` guard means a stale
  // screen cannot overwrite a newer decision made on another device: zero rows updated is
  // reported and the list refreshed, never treated as success.
  async function transition(row, to, extra = {}) {
    if (!canTransition(row.status, to)) return false
    if (busyId != null) return false // a second press while one is in flight — the busy row's buttons stay enabled
    setBusyId(row.id); setActionError(null); setNotice(null)
    const { data, error } = await scopedUpdate('pos_reservations', { ...stampFor(to, undefined, row.status), ...extra })
      .eq('id', row.id).eq('status', row.status).select('id')
    setBusyId(null)
    if (error) { setActionError(asActionError(error, 'staff')); return false }
    if (!data || data.length === 0) {
      setActionError({ text: `${row.customer_name}'s booking was changed on another device — the list has been refreshed.` })
      await load({ quiet: true })
      return false
    }
    await load({ quiet: true })
    // Say what happened. When the row belongs to a day other than the one on screen — an accepted
    // request usually does — the row has just left the page, so the line says where it went.
    const verb = to === 'cancelled' ? (row.status === 'requested' ? 'declined' : 'cancelled') : VERB[to]
    if (verb) {
      const iso = rowDayIso(row)
      const elsewhere = to !== 'cancelled' && to !== 'no_show' && iso && (filter === 'upcoming' ? false : iso !== dayIso)
      setNotice({
        text: `${row.customer_name} ×${row.party_size} ${verb}${elsewhere ? ` — ${bsLabelOf(dayBoundsOf(iso).bs)} at ${nepalTime(row.reserved_for)}` : ''}.`,
        jumpIso: elsewhere ? iso : null,
      })
    }
    return true
  }

  function whatsappVars(r) {
    const bs = nepalBs(r.reserved_for)
    return {
      name: r.customer_name, party: r.party_size, outlet: biz.name,
      date: bs ? `${bsLabelOf(bs)} (${nepalDateLong(r.reserved_for)})` : nepalDateLong(r.reserved_for),
      time: nepalTime(r.reserved_for),
    }
  }
  const sendWhatsApp = r => openWhatsApp(r.phone, fillTemplate(settings.whatsapp_template, whatsappVars(r)))

  function seatFromPick(r, table) {
    setSeatTarget(null)
    // The FULL pos_tables row travels with the handoff: pos_orders.table_name is snapshotted from
    // it at first save and prints on every KOT and bill.
    navigate('/pos/orders', { state: { seatReservation: { reservation: r, table } } })
  }

  async function confirmCancel() {
    if (!cancelTarget || !cancelReason) return
    const ok = await transition(cancelTarget, 'cancelled', { cancel_reason: cancelReason })
    if (ok) { setCancelTarget(null); setCancelReason('') }
  }

  async function confirmNoShow() {
    if (!noShowTarget) return
    const ok = await transition(noShowTarget, 'no_show')
    if (ok) setNoShowTarget(null)
  }

  async function confirmDone() {
    if (!doneTarget) return
    const ok = await transition(doneTarget, 'completed')
    if (ok) setDoneTarget(null)
  }

  // The two same-day reversals: a no-show who turned up goes back to Arrived, a cancelled booking
  // goes back to Booked. stampFor clears the mark the row is leaving (no_show_at, or cancelled_at
  // + cancel_reason), so the Covers Report and the customer's no-show count forget it too.
  async function confirmRevive() {
    if (!reviveTarget) return
    const to = reviveTarget.status === 'no_show' ? 'arrived' : 'booked'
    const ok = await transition(reviveTarget, to)
    if (ok) setReviveTarget(null)
  }

  const dayBs = dayBoundsOf(dayIso).bs
  const isToday = dayIso === todayIso()
  const scopeLabel = filter === 'upcoming' ? 'Next 7 days' : `${bsLabelOf(dayBs)}${isToday ? ' (today)' : ''}`

  // The ONE inline step for a row. The busy row's buttons stay ENABLED and wear aria-busy:
  // disabling the one the keyboard user just pressed drops focus to <body>, and the transition()
  // guard already ignores a second press. Other rows' buttons are disabled so one write is in
  // flight at a time.
  const stepBtn = (row, label, onClick, { danger = false, tip = '' } = {}) => {
    const mine = busyId === row.id
    const btn = (
      <button key={label} type="button" className={`btn btn-sm ${danger ? 'btn-danger' : 'btn-ghost'}`}
        onClick={onClick} disabled={busyId != null && !mine} aria-busy={mine || undefined}>{label}</button>
    )
    return tip ? <Tip key={label} text={tip} width={240}>{btn}</Tip> : btn
  }

  function rowActions(r) {
    const live = LIVE_STATUSES.includes(r.status)
    // WhatsApp on live rows only. The template is the booking confirmation, and "your table is
    // booked for…" sent to a guest who has eaten, been turned away or cancelled is nonsense.
    const contact = live ? (
      <Tip key="wa" text="Opens WhatsApp with the confirmation message filled in — sent from this device's WhatsApp." width={240}>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => sendWhatsApp(r)} aria-label={`WhatsApp ${r.customer_name}`}>💬</button>
      </Tip>
    ) : null

    if (r.status === 'requested') {
      return [
        contact,
        stepBtn(r, 'Accept', () => transition(r, 'confirmed'), { tip: 'Confirms the booking — the guest\'s phone shows it as confirmed within a few seconds.' }),
        stepBtn(r, 'Decline', () => { setCancelTarget(r); setCancelReason('') }, { danger: true }),
      ]
    }

    let step = null
    if (r.status === 'booked')    step = stepBtn(r, 'Confirm', () => transition(r, 'confirmed'), { tip: 'The guest has confirmed they are coming.' })
    if (r.status === 'confirmed') step = stepBtn(r, 'Arrived', () => transition(r, 'arrived'), { tip: 'The party is here and waiting for a table.' })
    if (r.status === 'arrived')   step = stepBtn(r, 'Seat', () => setSeatTarget(r), { tip: 'Pick the table — opens the order with the party size as covers.' })

    const revivable = canRevive(r, now)
    const menu = (
      <RowMenu key="more" label={`More for ${r.customer_name}`} disabled={busyId != null && busyId !== r.id} busy={busyId === r.id}
        items={[
          r.status === 'booked' && canTransition(r.status, 'arrived') && { key: 'arrived', label: 'Arrived', onSelect: () => transition(r, 'arrived') },
          r.status !== 'arrived' && canTransition(r.status, 'seated') && { key: 'seat', label: 'Seat…', onSelect: () => setSeatTarget(r) },
          canTransition(r.status, 'completed') && r.status !== 'seated' && { key: 'done', label: 'Mark done…', onSelect: () => setDoneTarget(r) },
          '-',
          canTransition(r.status, 'no_show') && { key: 'noshow', label: 'No-show…', danger: true, onSelect: () => setNoShowTarget(r) },
          canTransition(r.status, 'cancelled') && { key: 'cancel', label: 'Cancel booking…', danger: true, onSelect: () => { setCancelTarget(r); setCancelReason('') } },
          r.status === 'no_show' && { key: 'revive', label: 'They turned up…', disabled: !revivable, hint: 'Only on the booking\'s own day', onSelect: () => setReviveTarget(r) },
          r.status === 'cancelled' && { key: 'revive', label: 'Reinstate booking…', disabled: !revivable, hint: 'Only on the booking\'s own day', onSelect: () => setReviveTarget(r) },
        ]} />
    )
    return [contact, step, menu]
  }

  const statusChip = r => (
    <span className={`badge ${RESERVATION_STATUS_BADGE[r.status] || 'badge-gray'}`}>{STATUS_LABEL[r.status] || r.status}</span>
  )

  const tablesOf = r => {
    const names = tableIdsOf(r).map(id => tableName[id]).filter(Boolean)
    return names.length ? names.join(', ') : <span style={{ color: 'var(--theme-text3)' }}>—</span>
  }

  const notePreview = notes => {
    const s = String(notes || '').replace(/\s+/g, ' ').trim()
    return s.length > NOTE_PREVIEW ? s.slice(0, NOTE_PREVIEW - 1).trimEnd() + '…' : s
  }

  const tablesLink = <Link to="/pos/tables" className="btn-linklike">Tables → Reservations</Link>

  return (
    <div>
      <div className="page-header page-header--split">
        <div>
          <h1 className="page-title">
            Reservations <Tip text="The booking book. A booking shows on its table's tile on the Orders floor. Seating it opens the order with the party size filled in." width={300}>ⓘ</Tip>
          </h1>
          <p className="page-subtitle">{scopeLabel} · Tap a name to edit.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDayIso(d => plusDaysIso(d, -1))} aria-label="Previous day" disabled={filter === 'upcoming'}>‹</button>
          <BsCalendarPicker id="resv-day" value={dayIso} onChange={v => { setDayIso(v); if (filter === 'upcoming') setFilter('day') }} ariaLabel="Day" disabled={filter === 'upcoming'} />
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDayIso(d => plusDaysIso(d, 1))} aria-label="Next day" disabled={filter === 'upcoming'}>›</button>
          {!isToday && filter !== 'upcoming' && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDayIso(todayIso())}>Today</button>
          )}
        </div>
      </div>

      <div className="tab-bar" style={{ marginBottom: 16 }}>
        <button type="button" className={`tab-btn${filter === 'day' ? ' tab-btn--active' : ''}`} aria-pressed={filter === 'day'} onClick={() => setFilter('day')}>Day</button>
        <button type="button" className={`tab-btn${filter === 'unconfirmed' ? ' tab-btn--active' : ''}`} aria-pressed={filter === 'unconfirmed'} onClick={() => setFilter('unconfirmed')}>Unconfirmed</button>
        <button type="button" className={`tab-btn${filter === 'upcoming' ? ' tab-btn--active' : ''}`} aria-pressed={filter === 'upcoming'} onClick={() => setFilter('upcoming')}>Next 7 days</button>
      </div>

      {/* Public booking requests — an outlet with the link switched off never sees this band. A queue,
          not a notice: the amber lives on the badge, and the card is a plain card. */}
      {requests.length > 0 && (
        <div className="card" style={{ padding: 16, marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
            <span className="badge badge-amber">🔔 {requests.length} booking request{requests.length === 1 ? '' : 's'}</span>
            <span style={{ fontSize: 12, color: 'var(--theme-text2)' }}>
              Sent from the booking link. Accept or decline — the guest's phone updates either way.
            </span>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr><th>For</th><th>Guest</th><th style={{ textAlign: 'right' }}>Party</th><th>Note</th><th><span className="visually-hidden">Actions</span></th></tr>
              </thead>
              <tbody>
                {requests.map(r => {
                  const bs = nepalBs(r.reserved_for)
                  return (
                    <tr key={r.id}>
                      <td style={{ whiteSpace: 'nowrap' }}>{bsLabelOf(bs)} · {nepalTime(r.reserved_for)}</td>
                      <td>
                        <span style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{r.customer_name}</span>
                        <span className="cell-sub">{displayPhone(r.phone)}</span>
                      </td>
                      <td style={{ textAlign: 'right' }}>×{r.party_size}</td>
                      <td style={{ fontSize: 12, color: 'var(--theme-text2)', whiteSpace: 'normal', maxWidth: 260 }}>
                        {[r.occasion, r.notes].filter(Boolean).join(' · ') || <span style={{ color: 'var(--theme-text3)' }}>—</span>}
                      </td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <div style={{ display: 'inline-flex', gap: 8 }}>{rowActions(r)}</div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <ActionError error={actionError} className="action-error--top" />
      {notice && (
        <p role="status" className="resv-notice">
          ✓ {notice.text}
          {notice.jumpIso && (
            <>{' '}<button type="button" className="btn-linklike" onClick={() => { setFilter('day'); setDayIso(notice.jumpIso); setNotice(null) }}>Show that day</button></>
          )}
        </p>
      )}

      {loading ? (
        <p role="status" style={{ color: 'var(--theme-text3)', fontSize: 13 }}>Loading…</p>
      ) : loadError ? (
        <ReportLoadError error={loadError} />
      ) : (
        <>
          <div className="stat-grid" style={{ marginBottom: 16 }}>
            <div className="stat-card">
              <div className="stat-label">Bookings</div>
              <div className="stat-value">{stats.bookings}</div>
              <div className="stat-sub">{scopeLabel}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Guests expected <Tip text="Party sizes added up, across bookings still expected or seated." width={220}>ⓘ</Tip></div>
              <div className="stat-value">{stats.covers}</div>
              <div className="stat-sub">{totalSeats > 0 ? `${totalSeats} seats in the room` : <>set table capacity under <Link to="/pos/tables" className="btn-linklike">Tables</Link></>}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Unconfirmed <Tip text="Booked but the guest has not confirmed. The 💬 button sends the confirmation message." width={220}>ⓘ</Tip></div>
              <div className="stat-value">{stats.unconfirmed}</div>
              <div className="stat-sub">{stats.unconfirmed > 0 ? 'worth a message' : 'all confirmed'}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Waiting to be seated</div>
              <div className="stat-value">{stats.waiting}</div>
              <div className="stat-sub">{stats.waiting > 0 ? 'arrived, no table yet' : 'nobody waiting'}</div>
            </div>
          </div>

          {capacity && capacity.cells.some(c => c.covers > 0) && (
            <div className="card" style={{ padding: '12px 16px', marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--theme-text2)' }}>Guests expected by hour</span>
                <Tip text="Each cell is how many booked guests are expected to be sitting during that hour (a 7:30 booking for 90 minutes counts in both 7 and 8), against the room's total seats. A warning here never blocks a booking — it is for taking the next one knowingly." width={300}>ⓘ</Tip>
                {capacity.over.size > 0 && <span className="badge badge-amber">⚠ over seats at {[...capacity.over].map(hourLabel).join(', ')}</span>}
              </div>
              <div style={{ display: 'flex', gap: 4, overflowX: 'auto' }}>
                {capacity.cells.map(c => (
                  <div key={c.hour} style={{
                    minWidth: 52, textAlign: 'center', padding: '6px 4px', borderRadius: 'var(--radius-sm)',
                    border: `1px solid ${capacity.over.has(c.hour) ? 'var(--theme-amber)' : 'var(--theme-border)'}`,
                    background: capacity.over.has(c.hour) ? 'color-mix(in srgb, var(--theme-amber) 12%, transparent)' : 'transparent',
                  }}>
                    <div style={{ fontSize: 10, color: 'var(--theme-text3)' }}>{hourLabel(c.hour)}</div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: capacity.over.has(c.hour) ? 'var(--theme-amber-text)' : 'var(--theme-text1)' }}>
                      {c.covers}
                    </div>
                    {totalSeats > 0 && <div style={{ fontSize: 10, color: 'var(--theme-text3)' }}>/ {totalSeats}</div>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {weekOver && liveRows.length > 0 && (
            <div className="card" style={{ padding: '12px 16px', marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--theme-text2)' }}>Hours over seats this week</span>
                <Tip text={`Each day's booked guests per hour against the room's ${totalSeats} seats. Pick a day to see its hour-by-hour strip. A warning never blocks a booking.`} width={280}>ⓘ</Tip>
                {weekOver.length === 0
                  ? <span style={{ fontSize: 12, color: 'var(--theme-text3)' }}>none in the next 7 days</span>
                  : weekOver.map(d => (
                    <button key={d.iso} type="button" className="badge badge-amber badge-sentence" style={{ border: 'none', fontFamily: 'inherit', cursor: 'pointer' }}
                      onClick={() => { setFilter('day'); setDayIso(d.iso) }} title={`Open ${d.label}`}>
                      ⚠ {d.label}: {d.hours.join(', ')}
                    </button>
                  ))}
              </div>
            </div>
          )}

          {visibleRows.length === 0 ? (
            <div className="card empty-state">
              <div className="empty-state-icon" aria-hidden="true">🕗</div>
              <div className="empty-state-text">
                {filter === 'unconfirmed' ? 'Nothing waiting on a confirmation.' : `No bookings — ${scopeLabel}.`}
              </div>
              {filter !== 'unconfirmed' && (
                <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: '10px auto 0', maxWidth: 440, lineHeight: 1.6 }}>
                  Add one with <strong>+ New booking</strong>.{' '}
                  {settings.public_booking_enabled
                    ? 'Requests from your booking link appear at the top of this page.'
                    : <>Or switch on the booking link under {tablesLink}, so guests can ask from their phone.</>}
                </p>
              )}
            </div>
          ) : (
            <div className="table-wrap table-wrap--fab-clear">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Guest</th>
                    <th style={{ textAlign: 'right' }}>Party</th>
                    <th>Tables <Tip text="Tables held for this party. Empty means the host will pick one at seating." width={220}>ⓘ</Tip></th>
                    <th>Status <Tip text="Booked → Confirmed → Arrived → Seated → Completed. No-show and Cancelled end it, and can be undone from the ⋯ menu on the booking's own day. Seated means the order is open; Completed means the bill closed." width={280}>ⓘ</Tip></th>
                    <th>Booked by</th>
                    <th><span className="visually-hidden">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map(r => {
                    const bs = filter === 'upcoming' ? nepalBs(r.reserved_for) : null
                    const late = isLate(r, now, settings.arrival_grace_minutes)
                    const waiting = waitingMinutes(r, now)
                    const preview = notePreview(r.notes)
                    // The disclosure only exists when there is more than the row already shows.
                    const hasMore = !!(r.cancel_reason || (r.notes && preview !== String(r.notes).replace(/\s+/g, ' ').trim()))
                    const open = expandedId === r.id
                    return (
                      <Fragment key={r.id}>
                        <tr>
                          <td style={{ whiteSpace: 'nowrap', fontWeight: 600, color: 'var(--theme-text1)' }}>
                            {nepalTime(r.reserved_for)}
                            <span className="cell-sub" style={{ fontWeight: 400 }}>{bs ? `${bsLabelOf(bs)} · ` : ''}{r.duration_minutes} min</span>
                          </td>
                          <td>
                            {hasMore && (
                              <><RowDisclosure expanded={open} onToggle={() => setExpandedId(open ? null : r.id)} label={`More about ${r.customer_name}'s booking`} />{' '}</>
                            )}
                            <button type="button" className="btn-linklike" onClick={e => { e.stopPropagation(); setModal({ row: r }) }}>
                              {r.customer_name}
                            </button>
                            {r.occasion && <> <span className={`badge ${IDENTITY_BADGE}`}>{r.occasion}</span></>}
                            {late && <> <Tip text={`More than ${settings.arrival_grace_minutes} minutes past the booked time and not marked arrived.`} width={220}><span className="badge badge-amber">△ late</span></Tip></>}
                            {waiting != null && waiting >= settings.arrival_grace_minutes && (
                              <> <Tip text="Marked arrived this long ago and still not seated." width={200}><span className="badge badge-amber">△ waiting {waiting} min</span></Tip></>
                            )}
                            <span className="cell-sub">{displayPhone(r.phone)}{preview ? ` · ${preview}` : ''}</span>
                          </td>
                          <td style={{ textAlign: 'right' }}>×{r.party_size}</td>
                          <td>{tablesOf(r)}</td>
                          <td>{statusChip(r)}</td>
                          <td><span className={`badge ${IDENTITY_BADGE}`}>{SOURCE_LABEL[r.source] || r.source}</span></td>
                          <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                            <div style={{ display: 'inline-flex', gap: 8, alignItems: 'center', justifyContent: 'flex-end' }}>{rowActions(r)}</div>
                          </td>
                        </tr>
                        {open && hasMore && (
                          <tr>
                            <td colSpan={7} style={{ background: 'var(--theme-table-hover)', fontSize: 12, color: 'var(--theme-text2)', whiteSpace: 'normal' }}>
                              {r.notes && <div><strong>Notes:</strong> {r.notes}</div>}
                              {r.cancel_reason && <div><strong>{r.source === 'website' && r.status === 'cancelled' ? 'Declined' : 'Cancelled'}:</strong> {r.cancel_reason}</div>}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {modal && (
        <ReservationModal
          row={modal.row}
          tables={tables}
          settings={settings}
          dayIso={filter === 'upcoming' ? todayIso() : dayIso}
          onClose={() => setModal(null)}
          onSaved={({ partial } = {}) => { if (!partial) setModal(null); load({ quiet: true }) }}
        />
      )}

      {seatTarget && (
        <SeatTableModal
          reservation={seatTarget}
          tables={tables}
          openTableIds={openTableIds}
          onClose={() => setSeatTarget(null)}
          onPick={table => seatFromPick(seatTarget, table)}
        />
      )}

      {cancelTarget && (() => {
        // A request is DECLINED and the reason is shown on the guest's phone; a booking is
        // CANCELLED and the reason is for the book. Two lists, because "Guest cancelled" shown to
        // a guest who asked and was refused is false.
        const declining = cancelTarget.status === 'requested'
        const reasons = declining ? DECLINE_REASONS : CANCEL_REASONS
        return (
          <Modal title={declining ? `Decline — ${cancelTarget.customer_name}` : `Cancel booking — ${cancelTarget.customer_name}`}
            onClose={busyId ? () => {} : () => setCancelTarget(null)} maxWidth={440}>
            <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.6 }}>
              {declining
                ? 'The guest\'s phone will show the request as declined, with this reason.'
                : 'The booking leaves the floor and its tables are released. It stays on record as cancelled, and can be reinstated from the ⋯ menu until the end of its day.'}
            </p>
            <div className="form-field">
              <label htmlFor="resv-cancel-reason">Reason</label>
              <select id="resv-cancel-reason" className="form-select" value={cancelReason} onChange={e => setCancelReason(e.target.value)}>
                <option value="">— pick one —</option>
                {reasons.map(x => <option key={x} value={x}>{x}</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
              <button type="button" className="btn btn-ghost" onClick={() => setCancelTarget(null)} disabled={busyId != null}>Keep it</button>
              <button type="button" className="btn btn-danger" onClick={confirmCancel} disabled={!cancelReason || busyId != null}>
                {busyId ? 'Working…' : declining ? 'Decline' : 'Cancel booking'}
              </button>
            </div>
          </Modal>
        )
      })()}

      {noShowTarget && (
        <ConfirmModal
          title={`No-show — ${noShowTarget.customer_name}`}
          confirmLabel="Mark no-show"
          danger
          busy={busyId != null}
          onConfirm={confirmNoShow}
          onCancel={() => setNoShowTarget(null)}
        >
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            <li>Counts against this phone number: the next booking from {displayPhone(noShowTarget.phone)} shows the no-show on its form.</li>
            <li>Releases any held tables and drops the booking from the floor.</li>
            <li>Feeds the no-show rate on the Covers Report.</li>
            <li>If they turn up later today, undo it from the ⋯ menu — <em>They turned up</em>.</li>
          </ul>
        </ConfirmModal>
      )}

      {doneTarget && (
        <ConfirmModal
          title={`Mark done — ${doneTarget.customer_name}`}
          confirmLabel="Mark done"
          busy={busyId != null}
          onConfirm={confirmDone}
          onCancel={() => setDoneTarget(null)}
        >
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            <li>Records the visit as kept, with no order linked: it counts as a kept booking on the Covers Report but adds no covers.</li>
            <li>For a party seated by hand or while the till was offline. If their order is open on the floor, close the bill instead — that completes the booking on its own.</li>
            <li>This cannot be undone.</li>
          </ul>
        </ConfirmModal>
      )}

      {reviveTarget && (reviveTarget.status === 'no_show' ? (
        <ConfirmModal
          title={`They turned up — ${reviveTarget.customer_name}`}
          confirmLabel="Mark arrived"
          busy={busyId != null}
          onConfirm={confirmRevive}
          onCancel={() => setReviveTarget(null)}
        >
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            <li>Removes the no-show from {displayPhone(reviveTarget.phone)}'s record — the next booking from this number will not show it.</li>
            <li>Puts the party back on the floor as Arrived, waiting for a table.</li>
          </ul>
        </ConfirmModal>
      ) : (
        <ConfirmModal
          title={`Reinstate booking — ${reviveTarget.customer_name}`}
          confirmLabel="Reinstate"
          busy={busyId != null}
          onConfirm={confirmRevive}
          onCancel={() => setReviveTarget(null)}
        >
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            <li>The booking returns to the book as Booked, {bsLabelOf(nepalBs(reviveTarget.reserved_for))} at {nepalTime(reviveTarget.reserved_for)}.</li>
            <li>Its held tables are held again, and the cancellation reason is cleared.</li>
          </ul>
        </ConfirmModal>
      ))}

      <Fab label="+ New booking" onClick={() => setModal({ row: null })} show={!modal && !seatTarget} />
    </div>
  )
}
