import { Fragment, useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
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
import { adToBs, bsDayBoundaryIso, formatAd, formatBsDay } from '../../../utils/bsCalendar'
import { nepalTime, nepalCivilDate, nepalBs, nepalDateLong } from '../../../shared/nepalTime'
import { RESERVATION_STATUS_BADGE, IDENTITY_BADGE } from '../posSignals'
import { playChime } from '../posChime'
import {
  STATUS_LABEL, LIVE_STATUSES, canTransition, stampFor, isLate, tableIdsOf,
  RESERVATION_SELECT, SOURCE_LABEL, CANCEL_REASONS,
} from './reservationStatus'
import { normalizeReservationSettings, DEFAULT_RESERVATION_SETTINGS } from './reservationSettings'
import { bookedCoversByHour, overSeatsHours } from './reservationCapacity'
import { fillTemplate, openWhatsApp } from './whatsappLink'
import ReservationModal from './ReservationModal'
import SeatTableModal from './SeatTableModal'

const REQUEST_POLL_MS = 15000

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

/**
 * The reservations book. Staff-operated but read at a desk between services, so it wears the
 * product shell (page-header, stat-grid, tab-bar, data-table) rather than the till idiom — the
 * S613 boundary: a POS page is a report unless it is operated mid-service. Seating a party hands
 * off to Order Taking, which is the mid-service screen.
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
  const [busyId,   setBusyId]   = useState(null)
  const [modal,    setModal]    = useState(null)   // { row } — row null for a new booking
  const [seatTarget,   setSeatTarget]   = useState(null)
  const [cancelTarget, setCancelTarget] = useState(null)
  const [cancelReason, setCancelReason] = useState('')
  const [noShowTarget, setNoShowTarget] = useState(null)
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
    // A failed read is not an empty day, and must never render as one (S594).
    const failed = firstError(results)
    if (failed) { setLoadError(failed); setLoading(false); return }
    const [{ data: dayRows }, { data: reqRows }, { data: tbls }, { data: open }, { data: s }] = results
    setRows(dayRows || [])
    commitRequests(reqRows || [])
    setTables(tbls || [])
    setOpenTableIds(new Set((open || []).map(o => o.table_id).filter(Boolean)))
    setSettings(normalizeReservationSettings(s?.pos_reservation_settings))
    setHours({ open: s?.pos_open_time || '', close: s?.pos_close_time || '' })
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

  // Late/due flags move with the clock, not with the data.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60000)
    return () => clearInterval(t)
  }, [])

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

  // Booked covers per hour against the room, for a single day only.
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

  if (!hasPosAccess('staff')) return <Navigate to="/pos" replace />

  // Every status move goes through here. The `.eq('status', row.status)` guard means a stale
  // screen cannot overwrite a newer decision made on another device: zero rows updated is
  // reported and the list refreshed, never treated as success.
  async function transition(row, to, extra = {}) {
    if (!canTransition(row.status, to)) return false
    if (busyId != null) return false // a second press while one is in flight — the buttons are not disabled, see actionBtn
    setBusyId(row.id); setActionError(null)
    const { data, error } = await scopedUpdate('pos_reservations', { ...stampFor(to), ...extra })
      .eq('id', row.id).eq('status', row.status).select('id')
    setBusyId(null)
    if (error) { setActionError(asActionError(error, 'staff')); return false }
    if (!data || data.length === 0) {
      setActionError({ text: `${row.customer_name}'s booking was changed on another device — the list has been refreshed.` })
      await load({ quiet: true })
      return false
    }
    await load({ quiet: true })
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

  const dayBs = dayBoundsOf(dayIso).bs
  const isToday = dayIso === todayIso()
  const scopeLabel = filter === 'upcoming' ? 'Next 7 days' : `${bsLabelOf(dayBs)}${isToday ? ' (today)' : ''}`

  // The busy row's buttons stay ENABLED and wear aria-busy: disabling the one the keyboard user
  // just pressed drops focus to <body>, and the transition() guard already ignores a second press.
  // Other rows' buttons are disabled as before, so only one write can be in flight.
  const actionBtn = (row, label, onClick, { danger = false, tip = '' } = {}, key) => {
    const mine = busyId === row.id
    const btn = (
      <button key={key || label} type="button" className={`btn btn-ghost btn-sm${danger ? ' btn-danger' : ''}`}
        onClick={onClick} disabled={busyId != null && !mine} aria-busy={mine || undefined}>{label}</button>
    )
    return tip ? <Tip key={key || label} text={tip} width={240}>{btn}</Tip> : btn
  }

  function rowActions(r) {
    const out = []
    // WhatsApp only. A tel: button was here too and was removed at review: the book is worked
    // from a till or a desk, where a dial link does nothing, and the number is printed on the
    // row for anyone holding a phone.
    const contact = [
      <Tip key="wa" text="Opens WhatsApp with the confirmation message filled in — sent from this device's WhatsApp." width={240}>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => sendWhatsApp(r)} aria-label={`WhatsApp ${r.customer_name}`}>💬</button>
      </Tip>,
    ]
    if (r.status === 'requested') {
      out.push(actionBtn(r, 'Accept', () => transition(r, 'confirmed'), { tip: 'Confirms the booking — the guest\'s phone shows it as confirmed within a few seconds.' }, 'accept'))
      out.push(actionBtn(r, 'Decline', () => { setCancelTarget(r); setCancelReason('') }, { danger: true }, 'decline'))
      return [...contact, ...out]
    }
    if (r.status === 'booked') out.push(actionBtn(r, 'Confirm', () => transition(r, 'confirmed'), { tip: 'The guest has confirmed they are coming.' }, 'confirm'))
    if (canTransition(r.status, 'arrived')) out.push(actionBtn(r, 'Arrived', () => transition(r, 'arrived'), { tip: 'The party is here and waiting for a table.' }, 'arrived'))
    if (canTransition(r.status, 'seated'))  out.push(actionBtn(r, 'Seat', () => setSeatTarget(r), { tip: 'Pick the table — opens the order with covers filled in.' }, 'seat'))
    if (r.status === 'arrived')             out.push(actionBtn(r, 'Done', () => transition(r, 'completed'), { tip: 'The visit happened without the order being opened from here (seated by hand, or while offline).' }, 'done'))
    if (canTransition(r.status, 'no_show')) out.push(actionBtn(r, 'No-show', () => setNoShowTarget(r), { danger: true }, 'noshow'))
    if (canTransition(r.status, 'cancelled')) out.push(actionBtn(r, 'Cancel', () => { setCancelTarget(r); setCancelReason('') }, {}, 'cancel'))
    if (out.length === 0) return contact
    return [...contact, ...out]
  }

  const statusChip = r => (
    <span className={`badge ${RESERVATION_STATUS_BADGE[r.status] || 'badge-gray'}`}>{STATUS_LABEL[r.status] || r.status}</span>
  )

  const tablesOf = r => {
    const names = tableIdsOf(r).map(id => tableName[id]).filter(Boolean)
    return names.length ? names.join(', ') : <span style={{ color: 'var(--theme-text3)' }}>—</span>
  }

  return (
    <div>
      <div className="page-header page-header--split">
        <div>
          <h1 className="page-title">
            Reservations <Tip text="The booking book. A booking is a promise about a future table: it shows on that table's tile on the Orders floor, and seating it from here or from the floor opens the order with the party size already filled in." width={320}>ⓘ</Tip>
          </h1>
          <p className="page-subtitle">{scopeLabel} · tap a name to edit · Seat opens the order with covers filled in.</p>
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

      {/* Public booking requests — an outlet with the link switched off never sees this band. */}
      {requests.length > 0 && (
        <div className="card" style={{ padding: 16, marginBottom: 16, borderColor: 'var(--theme-amber)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span className="badge badge-amber">🔔 {requests.length} booking request{requests.length === 1 ? '' : 's'}</span>
            <span style={{ fontSize: 12, color: 'var(--theme-text2)' }}>
              Sent from the booking link. Accept to confirm, or decline with a reason — the guest's phone updates either way.
            </span>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr><th>For</th><th>Guest</th><th style={{ textAlign: 'right' }}>Guests</th><th>Note</th><th><span className="visually-hidden">Actions</span></th></tr>
              </thead>
              <tbody>
                {requests.map(r => {
                  const bs = nepalBs(r.reserved_for)
                  return (
                    <tr key={r.id}>
                      <td style={{ whiteSpace: 'nowrap' }}>{bsLabelOf(bs)} · {nepalTime(r.reserved_for)}</td>
                      <td>
                        <span style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{r.customer_name}</span>
                        <div style={{ fontSize: 12, color: 'var(--theme-text3)' }}>{r.phone}</div>
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
              <div className="stat-label">Covers booked <Tip text="Sum of party sizes across bookings still expected or seated." width={220}>ⓘ</Tip></div>
              <div className="stat-value">{stats.covers}</div>
              <div className="stat-sub">{totalSeats > 0 ? `${totalSeats} seats in the room` : 'set table capacity in Tables'}</div>
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
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--theme-text2)' }}>Booked covers by hour</span>
                <Tip text="Each cell is how many booked guests are expected to be sitting during that hour (a 7:30 booking for 90 minutes counts in both 7 and 8). Against the room's total seats. A warning here never blocks a booking — it is for taking the next one knowingly." width={300}>ⓘ</Tip>
                {capacity.over.size > 0 && <span className="badge badge-amber">⚠ over seats at {[...capacity.over].map(hourLabel).join(', ')}</span>}
              </div>
              <div style={{ display: 'flex', gap: 4, overflowX: 'auto', paddingBottom: 2 }}>
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

          {visibleRows.length === 0 ? (
            <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text3)', fontSize: 13 }}>
              {filter === 'unconfirmed' ? 'Nothing waiting on a confirmation.' : `No bookings — ${scopeLabel}.`}
            </div>
          ) : (
            <div className="table-wrap table-wrap--fab-clear">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Guest</th>
                    <th style={{ textAlign: 'right' }}>Guests</th>
                    <th><Tip text="Tables held for this party. Empty means the host will pick one at seating." width={220}>Tables</Tip></th>
                    <th><Tip text="Booked → Confirmed → Arrived → Seated → Completed. No-show and Cancelled end it. Seated means the order is open; Completed means the bill closed." width={280}>Status</Tip></th>
                    <th>Via</th>
                    <th><span className="visually-hidden">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map(r => {
                    const bs = filter === 'upcoming' ? nepalBs(r.reserved_for) : null
                    const late = isLate(r, now, settings.arrival_grace_minutes)
                    const hasDetail = !!(r.notes || r.occasion || r.cancel_reason)
                    const open = expandedId === r.id
                    return (
                      <Fragment key={r.id}>
                        <tr>
                          <td style={{ whiteSpace: 'nowrap', fontWeight: 600, color: 'var(--theme-text1)' }}>
                            {bs && <div style={{ fontSize: 11, color: 'var(--theme-text3)', fontWeight: 400 }}>{bsLabelOf(bs)}</div>}
                            {nepalTime(r.reserved_for)}
                            <div style={{ fontSize: 10, color: 'var(--theme-text3)', fontWeight: 400 }}>{r.duration_minutes} min</div>
                          </td>
                          <td>
                            {hasDetail && (
                              <RowDisclosure expanded={open} onToggle={() => setExpandedId(open ? null : r.id)} label={`Notes for ${r.customer_name}`} />
                            )}{' '}
                            <button type="button" className="btn-linklike" onClick={e => { e.stopPropagation(); setModal({ row: r }) }}>
                              {r.customer_name}
                            </button>
                            {late && <> <Tip text={`More than ${settings.arrival_grace_minutes} minutes past the booked time and not marked arrived.`} width={220}><span className="badge badge-amber">△ late</span></Tip></>}
                            <div style={{ fontSize: 12, color: 'var(--theme-text3)' }}>{r.phone}</div>
                          </td>
                          <td style={{ textAlign: 'right' }}>×{r.party_size}</td>
                          <td>{tablesOf(r)}</td>
                          <td>{statusChip(r)}</td>
                          <td><span className={`badge ${IDENTITY_BADGE}`}>{SOURCE_LABEL[r.source] || r.source}</span></td>
                          <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                            <div style={{ display: 'inline-flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>{rowActions(r)}</div>
                          </td>
                        </tr>
                        {open && hasDetail && (
                          <tr>
                            <td colSpan={7} style={{ background: 'var(--theme-table-hover)', fontSize: 12, color: 'var(--theme-text2)', whiteSpace: 'normal' }}>
                              {r.occasion && <div><strong>Occasion:</strong> {r.occasion}</div>}
                              {r.notes && <div><strong>Notes:</strong> {r.notes}</div>}
                              {r.cancel_reason && <div><strong>Cancelled:</strong> {r.cancel_reason}</div>}
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

      {cancelTarget && (
        <Modal title={cancelTarget.status === 'requested' ? `Decline — ${cancelTarget.customer_name}` : `Cancel booking — ${cancelTarget.customer_name}`}
          onClose={busyId ? () => {} : () => setCancelTarget(null)} maxWidth={440}>
          <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.6 }}>
            {cancelTarget.status === 'requested'
              ? 'The guest\'s phone will show the booking as declined with this reason. Their held tables are released.'
              : 'The booking leaves the floor and its tables are released. It stays on record as cancelled.'}
          </p>
          <div className="form-field">
            <label htmlFor="resv-cancel-reason">Reason</label>
            <select id="resv-cancel-reason" className="form-select" value={cancelReason} onChange={e => setCancelReason(e.target.value)}>
              <option value="">— pick one —</option>
              {CANCEL_REASONS.map(x => <option key={x} value={x}>{x}</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
            <button type="button" className="btn btn-ghost" onClick={() => setCancelTarget(null)} disabled={busyId != null}>Keep it</button>
            <button type="button" className="btn btn-danger" onClick={confirmCancel} disabled={!cancelReason || busyId != null}>
              {busyId ? 'Working…' : cancelTarget.status === 'requested' ? 'Decline' : 'Cancel booking'}
            </button>
          </div>
        </Modal>
      )}

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
            <li>Counts against this phone number: the next booking from {noShowTarget.phone} shows the no-show on its form.</li>
            <li>Releases any held tables and drops the booking from the floor.</li>
            <li>Feeds the no-show rate on the Covers Report.</li>
          </ul>
        </ConfirmModal>
      )}

      <Fab label="+ New booking" onClick={() => setModal({ row: null })} show={!modal && !seatTarget} />
    </div>
  )
}
