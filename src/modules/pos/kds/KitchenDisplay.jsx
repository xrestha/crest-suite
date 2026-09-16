import { useState, useEffect, useCallback, useRef } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import { setIfChanged, rowsSignature } from '../../../shared/setIfChanged'
import Tip from '../../../components/Tip'
import EstimateTimeModal from './EstimateTimeModal'
import { ticketStripColor } from '../posSignals'
import { playGuestAlert } from '../posChime'
import ArrivalAlert from '../../../components/ArrivalAlert'
import { REPEAT_MS, MUTE_MS } from '../../../shared/hooks/useGuestOrderAlerts'
import { errorText, errorLine } from '../../../shared/errorText'
import { nepalTime, serviceDayStartIso } from '../../../shared/nepalTime'

const STATIONS = ['KOT', 'BOT']
const POLL_MS = 4000
// S754: the board's day is the SERVICE day, not the device's calendar day. It used to start at the
// device's local midnight, recomputed every poll, so a ticket sent at 11:52 PM vanished at 00:00
// while the kitchen was still cooking it and could no longer be marked Ready. Same six hours past
// midnight the floor's reservation window uses (PosOrders.jsx), pinned to Nepal rather than to the
// runtime's timezone. The helper lives in shared/nepalTime.js since S756, shared with POS parking and
// gate passes — this file carried its own copy until then.

// Kitchen notes typed on the order line ("no onion"). Tickets written before notes were copied
// onto pos_kot_log.items carry no key at all, and render nothing (S754).
function itemNote(i) {
  return typeof i?.notes === 'string' ? i.notes.trim() : ''
}
// A line's choices as the kitchen reads them (S758): "+ Extra cheese", "NO onion" in red.
function ItemOptions({ options }) {
  if (!options?.length) return null
  return (
    <div style={{ paddingLeft: 16, fontSize: 15, lineHeight: 1.35 }}>
      {options.map((o, n) => o.is_removal
        ? <div key={n} style={{ color: 'var(--theme-red-text)', fontWeight: 700 }}>NO {String(o.kitchen || '').replace(/^no\s+/i, '')}</div>
        : <div key={n} style={{ color: 'var(--theme-text1)' }}>+ {o.kitchen}</div>)}
    </div>
  )
}
// S754 (owner decision): a pulled or reduced line shows on the ticket that sent it, so the kitchen
// stops cooking it. pos_kot_removals (written inside save_pos_order_items, migration 20260819130000)
// carries order, recipe, name, quantity, reason and time — but NOT the station or the ticket, so the
// attribution is made here:
//   - candidates are lines on this board's tickets for the same order whose recipe matches (by
//     recipe_id when both sides have one, by name otherwise), sent at or before the removal;
//     if none were sent before it (clock skew), every matching line is a candidate;
//   - one candidate is the confident case and takes the whole removal;
//   - several: the quantity is taken from the LATEST ticket first, capped at what that ticket
//     sent, spilling to earlier ones — so a removal that fits the latest ticket lands entirely on
//     it (the owner's stated fallback), and a removal larger than one ticket's line is not shown
//     as "1 → 0" with the rest silently dropped. Anything still left over stays on the latest.
// Removals are processed oldest first so each one sees what earlier ones already took. A removal
// whose recipe was sent to the OTHER station has no candidate on this board and shows nothing here.
function attachRemovals(tickets, removals) {
  const onBoard = new Set(tickets.map(t => t.order_id))
  const byTicket = new Map()   // ticket id -> { [lineIdx]: [{ qty, removed_at, reason }] }
  const remaining = new Map()  // `${ticketId}:${lineIdx}` -> qty not yet taken by a removal
  // A customized line (S758) is its recipe AND its choices: pulling "Momo, extra cheese" must not strike
  // the plain Momo on the same ticket. Rows written before either side carried a selection compare as ''.
  const sameLine = (r, i) => (r.recipe_id && i.recipe_id)
    ? r.recipe_id === i.recipe_id && (r.selection_key || '') === (i.selection_key || '')
    : (i.name || '') === (r.item_name || '')
  const ordered = (removals || [])
    .filter(r => onBoard.has(r.order_id) && Number(r.qty_removed) > 0)
    .sort((a, b) => (new Date(a.removed_at) - new Date(b.removed_at)) || String(a.id).localeCompare(String(b.id)))
  for (const r of ordered) {
    const removedMs = new Date(r.removed_at).getTime()
    const matches = []
    for (const t of tickets) {
      if (t.order_id !== r.order_id) continue
      ;(t.items || []).forEach((i, idx) => { if (sameLine(r, i)) matches.push({ t, idx, qty: Number(i.qty) || 0 }) })
    }
    if (matches.length === 0) continue
    const before = matches.filter(m => new Date(m.t.sent_at).getTime() <= removedMs)
    const candidates = (before.length > 0 ? before : matches)
      .sort((a, b) => (new Date(b.t.sent_at) - new Date(a.t.sent_at)) || String(b.t.id).localeCompare(String(a.t.id)))
    const add = (m, qty) => {
      const lines = byTicket.get(m.t.id) || {}
      ;(lines[m.idx] = lines[m.idx] || []).push({ qty, removed_at: r.removed_at, reason: r.reason })
      byTicket.set(m.t.id, lines)
    }
    let left = Number(r.qty_removed)
    for (const m of candidates) {
      if (left <= 0) break
      const key = `${m.t.id}:${m.idx}`
      const cap = remaining.has(key) ? remaining.get(key) : m.qty
      const take = Math.min(cap, left)
      if (take <= 0) continue
      add(m, take)
      remaining.set(key, cap - take)
      left -= take
    }
    if (left > 0) add(candidates[0], left)
  }
  return tickets.map(t => {
    const lines = byTicket.get(t.id) || null
    // A plain string the poll signature can compare, so a new cancellation repaints the board.
    const sig = lines
      ? Object.keys(lines).sort().map(k => `${k}:${lines[k].map(e => `${e.qty}@${e.removed_at}@${e.reason || ''}`).join(',')}`).join(';')
      : ''
    return { ...t, removals: lines, removalSig: sig }
  })
}

// A ticket sitting in Ready for longer than this drops off the board (still in the DB, still
// counted by KOT Register/Reconciliation — this is display-only decluttering, not a delete).
const READY_VISIBLE_MS = 10 * 60 * 1000
// Elapsed-time flag thresholds, matching the "flag the outlier" pattern used elsewhere in POS
// (Sales Exceptions, KOT Reconciliation) — a ticket sitting too long gets visually called out.
const WARN_MS = 8 * 60 * 1000
const LATE_MS = 15 * 60 * 1000

// The column dot is the module's shared three-stage progression — inert → working → done, the
// same grey/brass/green KOT_STATUS_BADGE puts on a floor tile. It deliberately does not reuse the
// card strip's colours: those mean lateness now, and a legend keyed to a retired encoding is
// worse than no legend.
//
// Ready → Served (S754, migration 20260916110000): the runner taps Served when the food has left the
// pass, and the ticket leaves the board. There is no fourth column — a served ticket has nothing left
// for the kitchen to do, the same reason a cancelled one is not shown.
const COLUMNS = [
  { status: 'new',         label: 'New',         action: 'Start',  next: 'in_progress', dot: 'var(--theme-text3)' },
  { status: 'in_progress', label: 'In Progress',  action: 'Ready',  next: 'ready',       dot: 'var(--theme-accent)' },
  { status: 'ready',       label: 'Ready',        action: 'Served', next: 'served',      dot: 'var(--theme-green)' },
]
// The stages the board shows. Read with `.in(...)` rather than "not cancelled", so a served ticket
// is not fetched, paged and then filtered out every 4 seconds for the rest of the service day.
const BOARD_STATUSES = COLUMNS.map(c => c.status)

// The card's colour strip carries LATENESS, not stage — see ticketStripColor in ../posSignals.js.
// It used to be a stage colour (new red / in progress amber / ready green), which was the loudest
// mark on the card and carried nothing: the board already sorts every ticket into a labelled
// column by that exact stage and puts the next action on its own button. Worse, it spent red and
// amber on it, so an on-time New ticket and a twenty-minute-late one wore the same red band and
// differed only by a 2px border. The strip is now quiet until a cook is actually needed.

// On-screen ticket board that runs ALONGSIDE the existing printed KOT/BOT tickets — sending a
// KOT/BOT from Order Taking still prints exactly as before (see PosOrders.jsx); this just gives
// the kitchen/bar a live view of the same send events, with a tap-to-advance status per ticket.
// Each pos_kot_log row already IS one physical ticket (one send event — an addition to an order
// gets its own row, matching how a second small paper ticket prints for just the new items), so
// this maps 1:1 onto existing rows rather than a new ticket concept.
export default function KitchenDisplay() {
  const { profile, hasPosAccess, posTeam } = useAuth()
  const { scopedFrom, scopedUpdate } = useScopedDb()
  const navigate = useNavigate()

  // A 'kitchen'/'bar' pos_team account (S431) is locked to its own queue — no toggle, so there's
  // no tab left on the wrong station to forget about. 'foh' (and admin/owner, who always resolve
  // to 'foh') keeps today's manual toggle, remembered per-browser via localStorage.
  const isTeamLocked = posTeam === 'kitchen' || posTeam === 'bar'
  const lockedStation = posTeam === 'bar' ? 'BOT' : 'KOT'
  const [station, setStation] = useState(() => isTeamLocked ? lockedStation : (localStorage.getItem('pos_kds_station') || 'KOT'))
  const [tickets, setTickets] = useState([])
  const [loading, setLoading] = useState(true)
  const [now, setNow] = useState(() => Date.now()) // ticks every 30s to redraw elapsed-time labels/colors
  // Silences the standing alert for five minutes. The banner stays — the tickets are still
  // unstarted, and a control that removes the evidence is how this gets missed a second time.
  const [alertMutedUntil, setAlertMutedUntil] = useState(0)
  // Ticket ids with an advance() write in flight — a rapid double-tap on greasy kitchen
  // touchscreens could otherwise fire two overlapping updates whose responses arrive out of
  // order, leaving the row reverted to an earlier stage than what was actually tapped.
  const [advancing, setAdvancing] = useState(() => new Set())
  // advance() previously never checked the write's result, so a failed update (RLS denial,
  // network blip) left the optimistic status showing on screen for up to POLL_MS with no
  // indication the DB write never landed — a busy kitchen could believe a ticket was done when
  // it wasn't. Now reverted immediately below on error, with a dismissible reason shown here.
  const [kdsError, setKdsError] = useState('')
  // A failed POLL, kept apart from a failed ticket update: it clears itself on the next good
  // poll, and while it shows the board is the last successful read, not an empty kitchen.
  const [pollError, setPollError] = useState('')
  // Ticket awaiting an estimated prep time before it can advance to In Progress — see
  // requestEstimate/confirmStart below and EstimateTimeModal.jsx.
  const [estimateTicket, setEstimateTicket] = useState(null)
  // New-ticket chime bookkeeping — same "skip the very first load, chime only on a genuinely new
  // arrival" pattern as PosOrders.jsx's playGuestOrderChime, reset per-station since switching the
  // KOT/BOT toggle is a real station change, not a fresh arrival on the previous station.
  const seenTicketIds = useRef(new Set())
  const loadedOnce = useRef(false)
  // S754: the last cancellations read that succeeded. A failed read keeps these (a line the kitchen
  // was told is cancelled must not quietly become uncancelled) and says the list may be stale.
  const lastRemovals = useRef([])
  const [removalsError, setRemovalsError] = useState('')

  const load = useCallback(async () => {
    const serviceDayStart = serviceDayStartIso()
    // 'cancelled' (set by PosOrders.jsx's closeOrder when the parent order is voided) and 'served'
    // (S754) are excluded entirely rather than shown as a 4th column — there's nothing left for
    // kitchen/bar to do with a ticket whose order no longer exists or whose food is at the table.
    // Paged. pos_kot_log is one row per send per station, so a long service at a busy outlet can
    // cross the 1000-row cap inside a single day — and this query is sorted OLDEST first, so a
    // truncated read drops the newest tickets: precisely the ones the kitchen is waiting on, with
    // no error to say anything was dropped. `.order('id')` is the unique tiebreaker paging needs.
    const [{ data, error }, removalsRes] = await Promise.all([
      fetchAllRows(() => scopedFrom('pos_kot_log', 'id, order_id, order_no, table_name, station, items, sent_at, status, started_at, ready_at, estimated_prep_minutes')
        .eq('station', station)
        .in('status', BOARD_STATUSES)
        .gte('sent_at', serviceDayStart)
        .order('sent_at', { ascending: true }).order('id')),
      // S754: today's pulled/reduced lines, over the same service-day window as the tickets. Read by
      // window rather than `.in(order_id, …)` — the board's order list would ride in the URL — and
      // narrowed to the orders on the board in attachRemovals. Paged: one row per pulled line.
      fetchAllRows(() => scopedFrom('pos_kot_removals', 'id, order_id, recipe_id, item_name, qty_removed, reason, removed_at, selection_key')
        .gte('removed_at', serviceDayStart)
        .order('removed_at', { ascending: true }).order('id')),
    ])
    if (removalsRes.error) {
      setRemovalsError('Could not check for cancelled items — cancellations shown are from the last successful check, and newer ones may be missing. ' + errorText(removalsRes.error, 'staff'))
    } else {
      setRemovalsError('')
      lastRemovals.current = removalsRes.data || []
    }
    if (error) {
      // One failed poll must not write its empty result (the S654 rule, found here in S682): it
      // erased every New/Cooking/Ready ticket from the wall — the kitchen reads "nothing to cook"
      // — and rebuilt `seenTicketIds` from the empty set, so the next good poll re-chimed for
      // every ticket already on the board. Keep the last-good tickets and say the board is stale.
      setPollError('Could not refresh the board — the tickets shown are from the last successful check. ' + errorText(error, 'staff'))
      setLoading(false)
      return
    }
    setPollError('')
    const rows = attachRemovals(data || [], lastRemovals.current)
    const newTickets = rows.filter(t => t.status === 'new')
    if (loadedOnce.current && newTickets.some(t => !seenTicketIds.current.has(t.id))) {
      playNewTicketChime()
    }
    seenTicketIds.current = new Set(newTickets.map(t => t.id))
    loadedOnce.current = true
    // A wall-mounted board polls all day and the answer is usually unchanged; without the
    // bail-out the whole board re-rendered on every tick. `items` is not in the signature because
    // a pos_kot_log row's lines are immutable once written (see PosOrders' own ticket poll), so
    // any real change to what a ticket holds arrives as a different id. That still holds for the
    // per-line `notes` (S754): they are written with the row at insert, never patched afterwards.
    // The cancellations ARE drawn and DO change without the ticket changing, so their derived
    // `removalSig` is in the signature — without it a pulled line would never repaint (S754).
    setIfChanged(setTickets, rows,
      rs => rowsSignature(rs, ['id', 'status', 'started_at', 'ready_at', 'estimated_prep_minutes', 'removalSig']))
    setLoading(false)
  }, [scopedFrom, station])

  // A wall-mounted KDS screen is the one place in POS most likely to not be looked at
  // continuously, and until S763 it said so with one quiet two-tone beep — the same beep the floor
  // and the guest menu use for events a person is already sitting in front of. It is
  // `playGuestAlert` now: three rising notes, played twice, at roughly double the gain.
  //
  // The inline copy this replaces also built a NEW AudioContext per ticket and never closed one.
  // Chrome caps a document at ~6, and this board is opened once and left running for a whole
  // service — so on a busy night the seventh ticket onward made no sound at all, on the screen
  // furthest from anyone who would notice. The shared context in posChime.js is the fix.
  function playNewTicketChime() { playGuestAlert() }

  // Switching stations is a real context switch, not a fresh arrival on the station just left —
  // without this, the first load after toggling KOT→BOT would chime for every ticket already
  // sitting in BOT's New column, not just a genuinely new one.
  useEffect(() => { loadedOnce.current = false; seenTicketIds.current = new Set() }, [station])
  useEffect(() => { setLoading(true); load() }, [load])
  useEffect(() => {
    const poll = setInterval(load, POLL_MS)
    return () => clearInterval(poll)
  }, [load])
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 30000)
    return () => clearInterval(tick)
  }, [])

  function selectStation(s) {
    setStation(s)
    setKdsError('')
    localStorage.setItem('pos_kds_station', s)
  }

  async function advance(ticket, nextStatus, estimatedMinutes) {
    if (advancing.has(ticket.id)) return
    setAdvancing(prev => new Set(prev).add(ticket.id))
    const prevStatus = ticket.status
    // Optimistic — reverted below if the write actually fails; otherwise the next poll (≤4s)
    // reconciles with the server as before.
    setTickets(prev => prev.map(t => t.id === ticket.id
      ? { ...t, status: nextStatus, ...(nextStatus === 'in_progress' ? { estimated_prep_minutes: estimatedMinutes } : {}) }
      : t))
    const patch = { status: nextStatus, status_updated_by: profile?.id || null }
    if (nextStatus === 'in_progress') { patch.started_at = new Date().toISOString(); patch.estimated_prep_minutes = estimatedMinutes }
    if (nextStatus === 'ready') patch.ready_at = new Date().toISOString()
    if (nextStatus === 'served') patch.served_at = new Date().toISOString()
    // S754: conditional on the status this screen last saw. Unconditional, a Ready tap resurrected
    // a ticket whose order had been voided (closeOrder sets 'cancelled') and two screens advancing
    // the same ticket silently overwrote each other. `.select('id')` because a write whose filter
    // matches nothing returns no error — only the empty result says it did not land.
    const { data: moved, error } = await scopedUpdate('pos_kot_log', patch)
      .eq('id', ticket.id).eq('status', prevStatus).select('id')
    const revert = () => setTickets(prev => prev.map(t => t.id === ticket.id
      ? { ...t, status: prevStatus, estimated_prep_minutes: ticket.estimated_prep_minutes }
      : t))
    if (error) {
      revert()
      // errorLine, not error.message: the reader is a cook, and "Failed to fetch" is not a
      // sentence they can act on (S683). The ticket is back where it was; say so.
      setKdsError(`${ticket.table_name || 'This ticket'} was not moved — it is back where it was. ${errorLine(error, 'staff')}`)
    } else if (!moved?.length) {
      revert()
      setKdsError('This ticket was already moved, served from the floor, or cancelled')
      load()
    }
    setAdvancing(prev => { const next = new Set(prev); next.delete(ticket.id); return next })
  }

  // Start requires an estimate first — opens EstimateTimeModal instead of advancing directly;
  // Ready has no such requirement and still advances immediately (see TicketCard's onClick below).
  function requestEstimate(ticket) { setEstimateTicket(ticket) }
  function confirmStart(minutes) {
    const ticket = estimateTicket
    setEstimateTicket(null)
    advance(ticket, 'in_progress', minutes)
  }

  // The STANDING alert (S763). It is up for as long as ANY ticket sits in New — owner decision,
  // revised the same session: the first build only raised it past the 8-minute warn mark, on the
  // reasoning that a kitchen working a queue always has tickets in New and a banner up all service
  // gets muted on the first night. Aashish sent a real ticket through, looked for the alert and
  // found nothing, and chose arrival. A kitchen that has not yet touched a ticket is the state
  // worth shouting about, and the cost of shouting early is a banner a busy kitchen sees a lot of.
  //
  // WARN_MS/LATE_MS did not go away — they now drive the ESCALATION rather than the trigger, so the
  // banner still hardens on the same two marks the card strip and the ▲/△ readout use and the two
  // cannot disagree.
  const newTickets = tickets
    .filter(t => t.status === 'new')
    .sort((a, b) => new Date(a.sent_at).getTime() - new Date(b.sent_at).getTime())
  const oldestNewMs = newTickets.length > 0 ? Math.max(0, now - new Date(newTickets[0].sent_at).getTime()) : 0
  const alertWarn = oldestNewMs > WARN_MS
  const alertUrgent = oldestNewMs > LATE_MS
  const alertMuted = alertMutedUntil > now
  const alertOn = newTickets.length > 0

  // The REPEAT. A genuinely new arrival is chimed by playNewTicketChime inside load(), which is
  // what knows an id it has not seen before — so this one deliberately does NOT sound immediately,
  // or every arrival would double-chime. It is the "still nobody has pressed Start" reminder, and
  // it stops the moment the last New ticket is started.
  useEffect(() => {
    if (!alertOn || alertMuted) return
    const id = setInterval(() => playGuestAlert({ urgent: alertUrgent }), REPEAT_MS)
    return () => clearInterval(id)
  }, [alertOn, alertMuted, alertUrgent])

  if (!hasPosAccess('staff')) return <Navigate to="/pos" replace />

  const visible = tickets.filter(t => {
    if (t.status !== 'ready') return true
    const readyAt = t.ready_at ? new Date(t.ready_at).getTime() : new Date(t.sent_at).getTime()
    return now - readyAt < READY_VISIBLE_MS
  })

  return (
    // A wall-mounted, no-keyboard screen viewed from several feet away is a genuinely different
    // device profile than the admin sidebar shell every other POS page shares — same reasoning
    // PosOrders.jsx already uses to escape the shell for its own full-screen order-taking view.
    // Full-bleed (no maxWidth cap) so a wide kitchen monitor shows more of the board, not a
    // centered column with wasted space on either side.
    <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'var(--theme-bg)', display: 'flex', flexDirection: 'column', padding: '20px 28px', overflowY: 'auto' }}>
      {/* ArrivalAlert is position: fixed at z-index 3000, so it paints OVER this 1000 layer rather
          than inside it — the board keeps its full height and nothing below shifts. The padding
          here is what stops the Exit button sitting underneath it. */}
      {/* The elapsed figure below is Math.ROUND, matching the card's own `elapsedMin` — at 3.5
          minutes a banner saying 3 over a card saying 4 is two answers to one question on one
          screen, and this banner's whole claim is that it agrees with the board underneath it. */}
      {alertOn && (
        <ArrivalAlert
          icon={alertUrgent ? '▲' : alertWarn ? '△' : '🔔'}
          urgent={alertUrgent}
          muted={alertMuted}
          onMute={() => setAlertMutedUntil(Date.now() + MUTE_MS)}
          title={newTickets.length === 1
            ? `New ticket — #${newTickets[0].order_no}${newTickets[0].table_name ? ` · ${newTickets[0].table_name}` : ''}`
            : `${newTickets.length} tickets waiting to start`}
          detail={oldestNewMs < 30000
            ? 'Just in. Tap Start on the card to take it.'
            : `Oldest sent ${Math.round(oldestNewMs / 60000)} min ago. Tap Start on the card to take it.`}
        />
      )}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 12, flexShrink: 0, paddingTop: alertOn ? 76 : 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          {/* '/pos/orders' was every POS staffer's home before kitchen/bar teams (S431) existed —
              a locked-team account doesn't have Orders in its sidebar at all, so exiting there
              would land on a page that isn't theirs. Dashboard is the one destination every team
              always has. */}
          <button onClick={() => navigate(isTeamLocked ? '/dashboard' : '/pos/orders')} className="btn btn-ghost" style={{ fontSize: 13 }}>
            ← Exit
          </button>
          <div>
            {/* The page's one h1, on the title step — it was an h2 at 26px, off the ramp, with
                no h1 anywhere on the board (S682). */}
            <h1 className="page-title" style={{ margin: 0 }}>
              {isTeamLocked ? (station === 'KOT' ? 'Kitchen Display' : 'Bar Display') : 'Kitchen Display'}
            </h1>
            <p style={{ margin: '4px 0 0', fontSize: 14, color: 'var(--theme-text3)' }}>
              Live view of today's {station === 'KOT' ? 'kitchen' : 'bar'} tickets — printing still happens as normal, this just mirrors it on screen.
            </p>
          </div>
        </div>
        {!isTeamLocked && (
          <div className="tab-bar" style={{ fontSize: 15 }}>
            {STATIONS.map(s => (
              <button key={s} className={`tab-btn${station === s ? ' tab-btn--active' : ''}`} onClick={() => selectStation(s)}>
                {s === 'KOT' ? 'Kitchen (KOT)' : 'Bar (BOT)'}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* A real Dismiss button, not a "(tap to dismiss)" div: role="alert" is not an interactive
          role, and the div had no tabIndex or key handler — mouse and touch only. */}
      {[pollError && ['poll', pollError, () => setPollError('')], removalsError && ['removals', removalsError, () => setRemovalsError('')], kdsError && ['kds', kdsError, () => setKdsError('')]]
        .filter(Boolean).map(([key, text, dismiss]) => (
        <div key={key} role="alert" style={{
          display: 'flex', alignItems: 'center', gap: 12,
          background: 'color-mix(in srgb, var(--theme-red) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-red) 25%, transparent)',
          borderRadius: 'var(--radius-sm)', padding: '12px 16px', marginBottom: 16, fontSize: 13,
          color: 'var(--theme-red-text)',
        }}>
          <span style={{ flex: 1 }}>{text}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={dismiss}>Dismiss</button>
        </div>
      ))}

      {loading ? (
        <p style={{ color: 'var(--theme-text3)', fontSize: 13 }}>Loading…</p>
      ) : (
        <>
        {/* An empty board had no state of its own — three columns each holding a bare "—", which
            on a wall screen reads as "is this thing on?". Say what an empty board means (S683). */}
        {visible.length === 0 && (
          <div className="card" style={{ padding: '20px 24px', textAlign: 'center', color: 'var(--theme-text2)', fontSize: 14, marginBottom: 16 }}>
            Nothing on the board right now. Tickets appear here the moment a waiter sends an order — no refresh needed.
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
          {COLUMNS.map(col => {
            const colTickets = visible.filter(t => t.status === col.status)
            return (
              <div key={col.status}>
                <h3 style={{
                  fontSize: 14, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em',
                  color: 'var(--theme-text2)', margin: '0 0 10px',
                  display: 'flex', alignItems: 'center', gap: 8,
                }}>
                  <span style={{ width: 11, height: 11, borderRadius: 0, background: col.dot, flexShrink: 0 }} />
                  {col.label} <span style={{ color: 'var(--theme-text3)', fontWeight: 400 }}>({colTickets.length})</span>
                </h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {/* A single quiet column keeps its dash; a wholly empty board says so once, above. */}
                  {colTickets.length === 0 && visible.length > 0 && (
                    <div className="card" style={{ padding: 20, textAlign: 'center', color: 'var(--theme-text3)', fontSize: 12 }}>—</div>
                  )}
                  {colTickets.map(t => (
                    <TicketCard
                      key={t.id} ticket={t} now={now} onAdvance={advance} onRequestEstimate={requestEstimate}
                      action={col.action} next={col.next} isStartAction={col.status === 'new'} advancing={advancing.has(t.id)}
                    />
                  ))}
                </div>
              </div>
            )
          })}
        </div>
        </>
      )}

      {estimateTicket && (
        <EstimateTimeModal ticket={estimateTicket} onClose={() => setEstimateTicket(null)} onConfirm={confirmStart} />
      )}
    </div>
  )
}

function TicketCard({ ticket, now, onAdvance, onRequestEstimate, action, next, isStartAction, advancing }) {
  const sentMs = new Date(ticket.sent_at).getTime()
  const elapsedMin = Math.max(0, Math.round((now - sentMs) / 60000))
  const isLate = ticket.status !== 'ready' && (now - sentMs) > LATE_MS
  const isWarn = ticket.status !== 'ready' && !isLate && (now - sentMs) > WARN_MS
  const borderColor = isLate ? 'var(--theme-red)' : isWarn ? 'var(--theme-amber)' : 'var(--theme-border)'
  // Strip and border encode the same fact deliberately — redundant reinforcement of the one thing
  // on this card that needs someone, not two different facts competing for the same two hues.
  const stripColor = ticketStripColor({ status: ticket.status, isLate, isWarn })

  // Estimated-vs-actual readout, shown once a ticket has an estimate on it (set via the Start
  // popup) — a live "time left" while in progress, then a settled comparison once Ready.
  let etaNode = null
  if (ticket.status === 'in_progress' && ticket.started_at && ticket.estimated_prep_minutes) {
    const startedMs = new Date(ticket.started_at).getTime()
    const remainingMin = Math.round((startedMs + ticket.estimated_prep_minutes * 60000 - now) / 60000)
    const over = remainingMin < 0
    etaNode = (
      <span style={{ fontSize: 12, color: over ? 'var(--theme-red-text)' : 'var(--theme-text3)', fontWeight: over ? 700 : 400 }}>
        {over ? `${Math.abs(remainingMin)} min over est.` : `~${remainingMin} min left`}
      </span>
    )
  } else if (ticket.status === 'ready' && ticket.started_at && ticket.ready_at && ticket.estimated_prep_minutes) {
    const actualMin = Math.round((new Date(ticket.ready_at).getTime() - new Date(ticket.started_at).getTime()) / 60000)
    const overEst = actualMin > ticket.estimated_prep_minutes
    etaNode = (
      <span style={{ fontSize: 12, color: overEst ? 'var(--theme-red-text)' : 'var(--theme-green-text)' }}>
        Done in {actualMin}m (est. {ticket.estimated_prep_minutes}m)
      </span>
    )
  }

  return (
    <div className="card" style={{ padding: 16, borderColor, borderWidth: isLate || isWarn ? 2 : 1, overflow: 'hidden' }}>
      <div style={{ margin: '-16px -16px 12px', height: 7, background: stripColor }} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
        <span style={{ fontWeight: 700, fontSize: 16, color: 'var(--theme-text1)' }}>{ticket.table_name || 'Takeaway'}</span>
        <span style={{ fontSize: 12, color: 'var(--theme-text3)' }}>#{ticket.order_no}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 12 }}>
        {(ticket.items || []).map((i, idx) => {
          const note = itemNote(i)
          // S754: a line pulled or reduced after this ticket was sent. The strike-through and the
          // word "cancelled" carry it, not only the red — the kitchen must stop cooking it.
          const pulled = ticket.removals?.[idx]
          if (pulled?.length) {
            const removedQty = pulled.reduce((n, e) => n + e.qty, 0)
            const nowQty = Math.max(0, (Number(i.qty) || 0) - removedQty)
            const last = pulled.reduce((a, e) => (new Date(e.removed_at) > new Date(a.removed_at) ? e : a))
            const reasons = [...new Set(pulled.map(e => (e.reason || '').trim()).filter(Boolean))].join(' / ')
            return (
              <div key={idx} style={{ fontSize: 16, color: 'var(--theme-text2)' }}>
                {nowQty === 0 ? (
                  <s style={{ color: 'var(--theme-text3)' }}>{i.qty} × {i.name}</s>
                ) : (
                  <span><s style={{ color: 'var(--theme-text3)' }}>{i.qty}</s> → {nowQty} × {i.name}</span>
                )}
                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--theme-red-text)', paddingLeft: 16 }}>
                  {nowQty === 0 ? 'Cancelled' : `${removedQty} cancelled`} {nepalTime(last.removed_at)} · {reasons || 'no reason given'}
                </div>
                {nowQty > 0 && <ItemOptions options={i.options} />}
                {nowQty > 0 && note && <div style={{ fontSize: 16, color: 'var(--theme-text1)', paddingLeft: 16 }}>↳ {note}</div>}
              </div>
            )
          }
          return (
            <div key={idx} style={{ fontSize: 16, color: 'var(--theme-text2)' }}>
              {i.qty} × {i.name}
              <ItemOptions options={i.options} />
              {note && <div style={{ fontSize: 16, color: 'var(--theme-text1)', paddingLeft: 16 }}>↳ {note}</div>}
            </div>
          )
        })}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <Tip text={`Time since this ticket was sent. △ means it is approaching the ${Math.round(WARN_MS / 60000)}-minute mark, ▲ that it is past ${Math.round(LATE_MS / 60000)} minutes.`}>
            <span style={{ fontSize: 13, color: isLate ? 'var(--theme-red-text)' : isWarn ? 'var(--theme-amber-text)' : 'var(--theme-text3)', fontWeight: isLate || isWarn ? 700 : 400 }}>
              {/* The mark, not the colour, is what makes late and going-late distinguishable.
                  Measured on Light, --theme-red and --theme-amber sit at ΔE 3.1 under
                  deuteranopia — the exact collision S608 retuned redText/amberText out of, still
                  present in the base tokens the strip and border are filled from. Same ▲/△
                  vocabulary fcBand() uses (filled = act, hollow = watch), so it survives
                  greyscale and the kitchen's own printout of the board. */}
              {isLate ? '▲ ' : isWarn ? '△ ' : ''}{elapsedMin} min ago
            </span>
          </Tip>
          {etaNode}
        </div>
        {action && (
          <button
            className="btn btn-primary" style={{ fontSize: 14, padding: '8px 16px' }} disabled={advancing}
            onClick={() => isStartAction ? onRequestEstimate(ticket) : onAdvance(ticket, next)}
          >
            {advancing ? '…' : action}
          </button>
        )}
      </div>
    </div>
  )
}
