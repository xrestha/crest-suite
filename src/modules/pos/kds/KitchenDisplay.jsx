import { useState, useEffect, useCallback, useRef } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import { setIfChanged, rowsSignature } from '../../../shared/setIfChanged'
import Tip from '../../../components/Tip'
import { FilterChips } from '../../../components/Tabs'
import EstimateTimeModal, { DEFAULT_START_MINUTES } from './EstimateTimeModal'
import { ticketStripColor, ticketAllPulled, KDS_WARN_MS, KDS_LATE_MS } from '../posSignals'
import { isChangeLine, isChangeTicket, changeNoteText } from '../kitchenNotes'
import { POS_IDLE_LOCK_MS, posIdleLockApplies } from '../usePosIdleLock'
import { playGuestAlert, soundBlocked, unlockAudio, primeAudio } from '../posChime'
import { voidColumn, visibleVoids, VOID_READ_WINDOW_MS } from './voidedTickets'
import ArrivalAlert from '../../../components/ArrivalAlert'
import { REPEAT_MS, MUTE_MS } from '../../../shared/hooks/useGuestOrderAlerts'
import { errorText, errorInfo } from '../../../shared/errorText'
import { nepalTime, serviceDayStartIso } from '../../../shared/nepalTime'
import { useReleaseReload } from '../../../shared/releaseWatch'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'
import { settleWithin } from '../../../utils/withTimeout'
import { tapMiss } from './tapAnswer'
import { ticketTableLabel } from './ticketStage'
import './kitchenDisplay.css'

const KDS_RELEASE_IDLE_MS = 60 * 1000

// The board's amber banner, PayrollRun's stale-draft card (S741): "this works, but it is not the usual
// case". One object for both banners that wear it, the Owner-on-a-till notice and sound-off (S835).
const AMBER_BANNER = {
  display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
  background: 'color-mix(in srgb, var(--theme-amber) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-amber) 35%, transparent)',
  borderRadius: 'var(--radius-sm)', padding: '12px 16px', marginBottom: 16, fontSize: 14, color: 'var(--theme-text2)',
}

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
// Combos (S839, docs/pos-combos.md): a combo's dish comes to its own station like any dish, with the
// combo it belongs to under it, small and quiet, so the pass can put the plate together. The till logs
// it on the ticket item as `combo_name`; a ticket written before combos, or any other dish, has none.
function ItemCombo({ item }) {
  const name = typeof item?.combo_name === 'string' ? item.combo_name.trim() : ''
  if (!name) return null
  return <div style={{ paddingLeft: 16, fontSize: 16, lineHeight: 1.35, color: 'var(--theme-text3)' }}>↳ {name}</div>
}
// A line's choices as the kitchen reads them (S758): "+ Extra cheese", "NO onion" in red.
function ItemOptions({ options }) {
  if (!options?.length) return null
  return (
    <div style={{ paddingLeft: 16, fontSize: 17, lineHeight: 1.35 }}>
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
      // A CHANGE line (S809 3a) is an instruction, not food sent, so a pull never lands on it.
      ;(t.items || []).forEach((i, idx) => { if (!isChangeLine(i) && sameLine(r, i)) matches.push({ t, idx, qty: Number(i.qty) || 0 }) })
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
    // FLOOR-KITCHEN-2 (S809 3d): nothing left on it to make, so its one button is Clear. Derived from
    // `removals`, so `removalSig` already repaints it.
    return { ...t, removals: lines, removalSig: sig, allPulled: ticketAllPulled(t.items, lines) }
  })
}

// S836: a bill can move to another table, and a join hands the joined table's tickets to the bill that
// stays, while each ticket row keeps the table it was printed for. The board's reads embed the bill's
// table now (`pos_orders(table_name)`), and this puts it on the ticket flat (ticketTableLabel,
// ticketStage.js) so the poll signatures can see it: a move changes the bill, not the ticket row, and a
// signature without these would leave the card on the old table until something else changed.
function withTableLabel(t) {
  const { name, was } = ticketTableLabel(t)
  return { ...t, tableNow: name, tableWas: was }
}

// A ticket sitting in Ready for longer than this drops off the board (still in the DB, still
// counted by KOT Register/Reconciliation — this is display-only decluttering, not a delete).
// FLOOR-KITCHEN-5 (S809 3d): and the board marks it served as it drops it (see load), or the floor
// went on calling the table's food "Ready" for the rest of the meal.
const READY_VISIBLE_MS = 10 * 60 * 1000
// FLOOR-KITCHEN-6 (S809 3d): how long a board read or a tap may take before the board stops waiting
// for it. One stalled request on kitchen Wi-Fi froze that ticket's button until the page was reloaded.
const KDS_READ_MS = 15000
const KDS_TAP_MS = 15000
// S846: how long after a one-tap Start another Start is ignored (see startNow). A double tap lands well
// inside it; a cook starting two tickets on purpose moves a hand between them, which takes longer.
const START_SETTLE_MS = 500
// Elapsed-time flag thresholds, matching the "flag the outlier" pattern used elsewhere in POS
// (Sales Exceptions, KOT Reconciliation) — a ticket sitting too long gets visually called out.
const WARN_MS = KDS_WARN_MS
const LATE_MS = KDS_LATE_MS

// The column dot is the stage progression — inert → working → done. It deliberately does not reuse
// the card strip's colours: those mean lateness now, and a legend keyed to a retired encoding is
// worse than no legend. S846 (owner decision, the accent pass IMS and HR had): the working dot is
// ink, not the brass accent, which is kept for what is pressed or current; a stage is neither.
//
// Ready → Served (S754, migration 20260916110000): the runner taps Served when the food has left the
// pass, and the ticket leaves the board. There is no fourth column — a served ticket has nothing left
// for the kitchen to do, the same reason a cancelled one is not shown.
const COLUMNS = [
  { status: 'new',         label: 'New',         action: 'Start',  next: 'in_progress', dot: 'var(--theme-text3)' },
  { status: 'in_progress', label: 'In Progress',  action: 'Ready',  next: 'ready',       dot: 'var(--theme-text1)' },
  { status: 'ready',       label: 'Ready',        action: 'Served', next: 'served',      dot: 'var(--theme-green)' },
]
// The stages the board shows. Read with `.in(...)` rather than "not cancelled", so a served ticket
// is not fetched, paged and then filtered out every 4 seconds for the rest of the service day.
const BOARD_STATUSES = COLUMNS.map(c => c.status)

// The board is opened once and reloads only when a release arrives, so an id set it keeps grew all
// day (POS audit, 2026-10-15). load() forgets an id once a read that answered no longer has it, and
// this drops those ids from a Set or Map. It hands back the same one when none of them is in it, so a
// state updater with nothing to drop does not repaint the board.
export function withoutIds(ids, gone) {
  let out = null
  for (const id of gone) {
    if (!ids.has(id)) continue
    if (!out) out = ids instanceof Map ? new Map(ids) : new Set(ids)
    out.delete(id)
  }
  return out || ids
}

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
  const { profile, hasPosAccess, posTeam, isAdmin, isOwner, signOut } = useAuth()
  const { scopedFrom, scopedUpdate } = useScopedDb()
  const navigate = useNavigate()

  // A 'kitchen'/'bar' pos_team account (S431) is locked to its own queue — no toggle, so there's
  // no tab left on the wrong station to forget about. 'foh' (and admin/owner, who always resolve
  // to 'foh') keeps today's manual toggle, remembered per-browser via localStorage.
  const isTeamLocked = posTeam === 'kitchen' || posTeam === 'bar'
  const lockedStation = posTeam === 'bar' ? 'BOT' : 'KOT'

  // S835, D38: the Owner or the Crest operator left signed in on a wall screen. Neither ever idle-locks
  // (no raw pos_role, posIdleLockApplies), and Exit opened the till as them. On an ACTIVATED till tablet,
  // the place a KDS hangs on a wall, the board now says so and Exit signs this tablet out to its PIN
  // screen, the code path of Till Devices' "Sign out and open the PIN screen" (Pos.js openPinScreen).
  // Activated means the tablet's own key is stored, the test PosLogin asks before it announces guest
  // orders. On any other browser (the Owner's own laptop) Exit is unchanged.
  const ownerOnTill = !profile?.pos_role && !!(isAdmin || isOwner) &&
    !!(localStorage.getItem('pos_device_client_id') && localStorage.getItem('pos_device_id') && localStorage.getItem('pos_device_secret'))
  const [leaving, setLeaving] = useState(false)
  async function exitBoard() {
    // '/pos/orders' was every POS staffer's home before kitchen/bar teams (S431) existed — a
    // locked-team account doesn't have Orders in its sidebar at all, so exiting there would land on
    // a page that isn't theirs. Dashboard is the one destination every team always has.
    if (!ownerOnTill) { navigate(isTeamLocked ? '/dashboard' : '/pos/orders'); return }
    if (leaving) return
    setLeaving(true)
    // This tablet only ('local'), so the Owner's phone and laptop stay signed in. false: the network
    // sign-out failed, and AuthContext cleared this tablet and is reloading it to the PIN screen itself.
    if (!(await signOut({ to: '/pos/login', scope: 'local' }))) return
    navigate('/pos/login', { replace: true })
  }
  const [station, setStation] = useState(() => isTeamLocked ? lockedStation : (localStorage.getItem('pos_kds_station') || 'KOT'))
  const [tickets, setTickets] = useState([])
  // S842: the station the tickets on screen were read for, set by each read that is applied and
  // cleared with the tickets on a station switch. Until it equals `station` nothing has loaded for the
  // board on screen: the first read failing showed "Nothing on the board" under a banner citing a
  // "last successful check" there never was, and a failed BOT read after KOT left the kitchen's
  // tickets under "Bar (BOT)" with live buttons. A client switch remounts this page (Layout keys its
  // Outlet on the client, TillOutletGate stops a till), so the station is the whole key.
  const [loadedStation, setLoadedStation] = useState(null)
  const [now, setNow] = useState(() => Date.now()) // ticks every 30s to redraw elapsed-time labels/colors
  // Silences the standing alert for five minutes. The banner stays — the tickets are still
  // unstarted, and a control that removes the evidence is how this gets missed a second time.
  const [alertMutedUntil, setAlertMutedUntil] = useState(0)
  // Ticket ids with an advance() write in flight — a rapid double-tap on greasy kitchen
  // touchscreens could otherwise fire two overlapping updates whose responses arrive out of
  // order, leaving the row reverted to an earlier stage than what was actually tapped.
  const [advancing, setAdvancing] = useState(() => new Set())
  // A wall screen is never reloaded by hand, so it takes a new release by itself once nobody has
  // touched it for a minute and no ticket is mid-update (S809 1b).
  useReleaseReload(advancing.size === 0, KDS_RELEASE_IDLE_MS)
  // advance() previously never checked the write's result, so a failed update (RLS denial,
  // network blip) left the optimistic status showing on screen for up to POLL_MS with no
  // indication the DB write never landed — a busy kitchen could believe a ticket was done when
  // it wasn't. Now reverted immediately below on error, with a dismissible reason shown here.
  const [kdsError, setKdsError] = useState('')
  // A failed POLL, kept apart from a failed ticket update: it clears itself on the next good
  // poll, and while it shows the board is the last successful read, not an empty kitchen.
  // S842: `{ text, detail }` (errorInfo, staff), worded where it renders: a banner over the last good
  // board, or the error card when nothing has loaded for this station yet.
  const [pollError, setPollError] = useState(null)
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
  // FLOOR-KITCHEN-6 (S809 3d). On slow kitchen Wi-Fi a poll that left before a Start landed came back
  // after it and put the card back in New (and rang for it), and one for the station just left painted
  // its tickets under the new heading. So: a read for another station is dropped (stationReq), a read
  // older than one already shown is dropped (loadSeq/appliedSeq), a tick is skipped while a read is
  // out (loadsInFlight), and a ticket this screen moved keeps the stage it was moved to over any read
  // that left before the move was confirmed (localMoves: id → { status, est, at, gen }; gen Infinity while
  // the write is in flight, then the boardGen it was confirmed at).
  const stationReq = useLatestRequest()
  const loadSeq = useRef(0)
  const appliedSeq = useRef(0)
  const loadsInFlight = useRef(0)
  const boardGen = useRef(0)
  const localMoves = useRef(new Map())
  // FLOOR-KITCHEN-5 (S809 3d): Ready tickets this screen has asked the server to mark served as they
  // left the board, so each is asked once (again only after a failure); and when this screen first
  // saw each Ready ticket (id → Date.now()), which is what the 10 minutes are counted from.
  const autoServing = useRef(new Set())
  const readySince = useRef(new Map())
  // S817 4i (FLOOR-KITCHEN-4, D18): a voided order's tickets this station had live, read for the last
  // few minutes (voidedTickets.js). firstSeen counts the ten minutes by this screen's clock; dismissed
  // holds the ones a cook tapped OK on here. The first read after opening or a station switch does not
  // ring, like the new-ticket chime.
  const [voids, setVoids] = useState([])
  const [voidDismissed, setVoidDismissed] = useState(() => new Set())
  const voidFirstSeen = useRef(new Map())
  // The station each of those was read for (id → 'KOT' | 'BOT'), so a read forgets only its own
  // station's voids: a switch to the other station and back must not show again one a cook tapped OK on.
  const voidStationOf = useRef(new Map())
  const voidsLoadedOnce = useRef(false)
  // S817 4i (FLOOR-KITCHEN-9): the browser is holding this screen's sound until someone touches it.
  const [soundOff, setSoundOff] = useState(false)

  const load = useCallback(async () => {
    const seq = ++loadSeq.current
    const gen = boardGen.current
    loadsInFlight.current += 1
    const serviceDayStart = serviceDayStartIso()
    // 'cancelled' and 'served' (S754) are left out of this read rather than shown as a 4th column —
    // there's nothing left for kitchen/bar to do with them. A voided order's cancelled tickets come
    // back for a few minutes through the third read below, as "VOIDED — stop" (S817 4i).
    // Paged. pos_kot_log is one row per send per station, so a long service at a busy outlet can
    // cross the 1000-row cap inside a single day — and this query is sorted OLDEST first, so a
    // truncated read drops the newest tickets: precisely the ones the kitchen is waiting on, with
    // no error to say anything was dropped. `.order('id')` is the unique tiebreaker paging needs.
    // S836: the bill's table now, for a bill moved or joined since the ticket printed. Not !inner: a
    // ticket whose bill this login cannot read still shows, under the table it was printed for.
    const [{ data, error }, removalsRes, voidsRes] = await Promise.all([
      settleWithin(fetchAllRows(() => scopedFrom('pos_kot_log', 'id, order_id, order_no, table_name, station, items, sent_at, status, started_at, ready_at, estimated_prep_minutes, pos_orders(table_name)')
        .eq('station', station)
        .in('status', BOARD_STATUSES)
        .gte('sent_at', serviceDayStart)
        .order('sent_at', { ascending: true }).order('id')), KDS_READ_MS, 'Refreshing the board'),
      // S754: today's pulled/reduced lines, over the same service-day window as the tickets. Read by
      // window rather than `.in(order_id, …)` — the board's order list would ride in the URL — and
      // narrowed to the orders on the board in attachRemovals. Paged: one row per pulled line.
      settleWithin(fetchAllRows(() => scopedFrom('pos_kot_removals', 'id, order_id, recipe_id, item_name, qty_removed, reason, removed_at, selection_key')
        .gte('removed_at', serviceDayStart)
        .order('removed_at', { ascending: true }).order('id')), KDS_READ_MS, 'Checking for cancelled dishes'),
      // S817 4i (FLOOR-KITCHEN-4): this station's tickets of a VOIDED order cancelled in the last few
      // minutes (the server cancels them in the void and stamps cancelled_at). A ticket the kitchen
      // cleared itself, or one cancelled for any other reason, belongs to an order that is not voided
      // and is left out. A handful of rows at most, so no paging.
      settleWithin(scopedFrom('pos_kot_log', 'id, order_id, order_no, table_name, station, items, sent_at, started_at, ready_at, cancelled_at, pos_orders!inner(status, table_name)')
        .eq('station', station)
        .eq('status', 'cancelled')
        .eq('pos_orders.status', 'voided')
        .gte('cancelled_at', new Date(Date.now() - VOID_READ_WINDOW_MS).toISOString())
        .order('cancelled_at', { ascending: true }).order('id')
        .limit(200), KDS_READ_MS, 'Checking for voided orders'),
    ]).finally(() => { loadsInFlight.current -= 1 })
    // FLOOR-KITCHEN-6 (S809 3d): an answer for the station this board has left, or older than one
    // already on screen, is dropped before it touches anything; the next poll is at most 4 s away.
    if (!stationReq.isCurrent(station) || seq < appliedSeq.current) return
    if (removalsRes.error) {
      setRemovalsError('Could not check for cancelled items — cancellations shown are from the last successful check, and newer ones may be missing. ' + errorText(removalsRes.error, 'staff'))
    } else {
      setRemovalsError('')
      lastRemovals.current = removalsRes.data || []
    }
    // S817 4i: a failed read keeps the voided cards already up (a cook told to stop must not see the
    // card quietly vanish); it says nothing more, since the board's own poll error covers a dead link.
    let chimed = false
    if (voidsRes.error) {
      console.error('KDS could not read voided orders, keeping the cards already shown:', voidsRes.error)
    } else {
      const vrows = (voidsRes.data || []).map(withTableLabel)
      const seenAt = Date.now()
      let arrived = false
      for (const t of vrows) {
        if (!voidFirstSeen.current.has(t.id)) {
          voidFirstSeen.current.set(t.id, seenAt); voidStationOf.current.set(t.id, station); arrived = true
        }
      }
      if (arrived && voidsLoadedOnce.current) { playNewTicketChime(); chimed = true }
      voidsLoadedOnce.current = true
      // POS audit 2026-10-15: a void this station's read no longer has is past the read window and
      // does not come back (its cancelled_at is fixed and the window only moves on), so this screen
      // forgets when it first saw it and whether a cook tapped OK. One still in the read keeps both,
      // so it is never shown again once dismissed or past its ten minutes.
      const present = new Set(vrows.map(t => t.id))
      const gone = [...voidFirstSeen.current.keys()]
        .filter(id => !present.has(id) && voidStationOf.current.get(id) === station)
      if (gone.length > 0) {
        for (const id of gone) { voidFirstSeen.current.delete(id); voidStationOf.current.delete(id) }
        setVoidDismissed(prev => withoutIds(prev, gone))
      }
      // A voided bill no longer moves, but the card draws its table, so the signature carries it (S836).
      setIfChanged(setVoids, vrows, rs => rowsSignature(rs, ['id', 'cancelled_at', 'tableNow', 'tableWas']))
    }
    setSoundOff(soundBlocked())
    if (error) {
      // One failed poll must not write its empty result (the S654 rule, found here in S682): it
      // erased every New/Cooking/Ready ticket from the wall — the kitchen reads "nothing to cook"
      // — and rebuilt `seenTicketIds` from the empty set, so the next good poll re-chimed for
      // every ticket already on the board. Keep the last-good tickets and say the board is stale.
      // The same failure on every poll keeps the same object, so a dead link does not repaint every 4 s.
      const info = errorInfo(error, 'staff')
      setPollError(prev => (prev && prev.text === info.text && prev.detail === info.detail ? prev : info))
      return
    }
    setPollError(null)
    appliedSeq.current = seq
    // FLOOR-KITCHEN-6 (S809 3d): a move this screen made after this read left wins over what the read
    // says; once a read that left after the move was confirmed lands, the server's answer is the truth.
    for (const [id, m] of localMoves.current) if (m.gen <= gen) localMoves.current.delete(id)
    const read = (data || []).map(t => {
      const m = localMoves.current.get(t.id)
      return m ? {
        ...t, status: m.status,
        ...(m.status === 'in_progress' ? { estimated_prep_minutes: m.est } : {}),
        ...(m.status === 'ready' && !t.ready_at ? { ready_at: m.at } : {}),
      } : t
    }).filter(t => BOARD_STATUSES.includes(t.status))
    const rows = attachRemovals(read, lastRemovals.current).map(withTableLabel)
    const newTickets = rows.filter(t => t.status === 'new')
    if (!chimed && loadedOnce.current && newTickets.some(t => !seenTicketIds.current.has(t.id))) {
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
    // The table is drawn and changes without the ticket changing too (a move or a join, S836), so
    // `tableNow` and `tableWas` are in it as well.
    setIfChanged(setTickets, rows,
      rs => rowsSignature(rs, ['id', 'status', 'started_at', 'ready_at', 'estimated_prep_minutes', 'removalSig', 'tableNow', 'tableWas']))
    setLoadedStation(station) // S842: these tickets are this station's (the read above was dropped otherwise)

    // FLOOR-KITCHEN-5 (S809 3d): a ticket left in Ready for 10 minutes (when the board stops showing it)
    // is marked served, the step a runner skipped, so the floor stops calling that table's food "Ready". Conditional on 'ready', so
    // a ticket served or cleared meanwhile is left alone; the server stamps the time and this login.
    // A ticket whose dishes were all taken off stays up for its Clear instead (see `visible`). Only a
    // Ready the server has confirmed counts, never one this screen has just moved, and the 10 minutes
    // are measured by this screen watching it (readySince), not by comparing the server's ready time
    // with the tablet's clock: a tablet whose clock runs fast must not mark food served within seconds.
    const nowMs = Date.now()
    const readyIds = new Set(rows.filter(t => t.status === 'ready').map(t => t.id))
    for (const id of readySince.current.keys()) if (!readyIds.has(id)) readySince.current.delete(id)
    for (const id of readyIds) if (!readySince.current.has(id)) readySince.current.set(id, nowMs)
    // POS audit 2026-10-15: a ticket asked about is forgotten once it has left Ready (served here or
    // elsewhere). A ticket only moves forward, so it cannot come back to be asked again; one still in
    // Ready stays remembered, so a read that left before the serve landed never asks twice.
    for (const id of autoServing.current) if (!readyIds.has(id)) autoServing.current.delete(id)
    const dropIds = rows
      .filter(t => t.status === 'ready' && t.ready_at && !t.allPulled
        && !autoServing.current.has(t.id) && !localMoves.current.has(t.id)
        && nowMs - readySince.current.get(t.id) >= READY_VISIBLE_MS)
      .map(t => t.id)
    if (dropIds.length > 0) {
      dropIds.forEach(id => autoServing.current.add(id))
      void settleWithin(scopedUpdate('pos_kot_log', { status: 'served', served_at: new Date().toISOString() })
        .in('id', dropIds).eq('status', 'ready').select('id'), KDS_TAP_MS, 'Marking Ready tickets served')
        .then(({ error: serveErr }) => {
          if (!serveErr) return
          // Asked again on a later poll. Nothing on screen depends on it: the board already hides them.
          dropIds.forEach(id => autoServing.current.delete(id))
          console.error('KDS could not mark Ready tickets served, will try again:', serveErr)
        })
    }
  }, [scopedFrom, scopedUpdate, station, stationReq])

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
  useEffect(() => {
    loadedOnce.current = false; seenTicketIds.current = new Set()
    // S817 4i: the other station's voided cards are not this one's.
    voidsLoadedOnce.current = false; setVoids([])
  }, [station])
  // S817 4i (FLOOR-KITCHEN-9): a board the browser reopened by itself (a crash, a power cut, a restored
  // tab) plays nothing until someone touches it. Make the sound context now, so the board can say so
  // before the first ticket rings into nothing, and let any tap or key start it.
  useEffect(() => {
    primeAudio()
    const check = setTimeout(() => setSoundOff(soundBlocked()), 1000)
    let recheck = null
    const onInput = () => {
      unlockAudio()
      clearTimeout(recheck)
      recheck = setTimeout(() => setSoundOff(soundBlocked()), 300)
    }
    window.addEventListener('pointerdown', onInput)
    window.addEventListener('keydown', onInput)
    return () => {
      clearTimeout(check); clearTimeout(recheck)
      window.removeEventListener('pointerdown', onInput)
      window.removeEventListener('keydown', onInput)
    }
  }, [])
  useEffect(() => { load() }, [load])
  useEffect(() => {
    // S809 3d (FLOOR-KITCHEN-6): a tick waits while a read is still out, so a slow link never piles
    // reads up behind each other. A station switch and a refused tap still read at once.
    const poll = setInterval(() => { if (loadsInFlight.current === 0) load() }, POLL_MS)
    return () => clearInterval(poll)
  }, [load])
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 30000)
    return () => clearInterval(tick)
  }, [])

  function selectStation(s) {
    if (s === station) return // FilterChips calls back for the chip already on; nothing to switch
    stationReq.begin(s) // S809 3d: a read still out for the station being left is dropped when it lands
    setStation(s)
    // S842: in the same render as the switch, so the station left never stands under the new heading,
    // and its poll error is not this station's.
    setTickets([])
    setLoadedStation(null)
    setPollError(null)
    setKdsError('')
    localStorage.setItem('pos_kds_station', s)
  }

  async function advance(ticket, nextStatus, estimatedMinutes) {
    if (advancing.has(ticket.id)) return
    setAdvancing(prev => new Set(prev).add(ticket.id))
    const prevStatus = ticket.status
    // S809 3d (FLOOR-KITCHEN-6): no read can put this ticket back while the write is out (see load).
    // `at` stands in for the server's ready time until a read brings it, so a ticket sent more than
    // 10 minutes ago does not vanish from Ready the instant it is tapped (the filter fell back to sent_at).
    const at = new Date().toISOString()
    localMoves.current.set(ticket.id, { status: nextStatus, est: estimatedMinutes, at, gen: Infinity })
    // Optimistic — reverted below if the write actually fails; otherwise the next poll (≤4s)
    // reconciles with the server as before.
    setTickets(prev => prev.map(t => t.id === ticket.id
      ? { ...t, status: nextStatus, ...(nextStatus === 'in_progress' ? { estimated_prep_minutes: estimatedMinutes } : {}), ...(nextStatus === 'ready' ? { ready_at: at } : {}) }
      : t))
    // The stage times sent here are only for a database older than S809 3d: guard_pos_kot_log now
    // stamps each one with the server's clock when the ticket enters that stage and ignores these.
    const patch = { status: nextStatus, status_updated_by: profile?.id || null }
    if (nextStatus === 'in_progress') { patch.started_at = new Date().toISOString(); patch.estimated_prep_minutes = estimatedMinutes }
    if (nextStatus === 'ready') patch.ready_at = new Date().toISOString()
    if (nextStatus === 'served') patch.served_at = new Date().toISOString()
    // S754: conditional on the status this screen last saw. Unconditional, a Ready tap resurrected
    // a ticket whose order had been voided (the void cancels it) and two screens advancing
    // the same ticket silently overwrote each other. `.select('id')` because a write whose filter
    // matches nothing returns no error — only the empty result says it did not land.
    // S809 3d: time-limited, so a stalled request frees the button instead of freezing it ("…") until
    // the page is reloaded. A late landing is harmless: the write is conditional on the old stage.
    const res = await settleWithin(scopedUpdate('pos_kot_log', patch)
      .eq('id', ticket.id).eq('status', prevStatus).select('id'), KDS_TAP_MS, 'Moving the ticket')
    // S833: tapMiss (tapAnswer.js) words a refusal, a ticket already moved, and no answer at all (a
    // timeout, a dropped connection, a gateway error). With no answer the move may have landed, so the
    // card goes back to the stage the server last confirmed and the board reads itself again at once,
    // which shows where the ticket really is; only a refusal says it is back where it was.
    const miss = tapMiss(res, { tableName: ticket.tableNow, nextStatus })
    if (miss) {
      localMoves.current.delete(ticket.id)
      setTickets(prev => prev.map(t => t.id === ticket.id
        ? { ...t, status: prevStatus, estimated_prep_minutes: ticket.estimated_prep_minutes, ready_at: ticket.ready_at }
        : t))
      setKdsError(miss.text)
      if (miss.reread) load()
    } else {
      // Confirmed: kept over any read that left before now (load drops it once a newer read lands).
      localMoves.current.set(ticket.id, { status: nextStatus, est: estimatedMinutes, at, gen: ++boardGen.current })
    }
    setAdvancing(prev => { const next = new Set(prev); next.delete(ticket.id); return next })
  }

  // S846 (owner decision): Start takes DEFAULT_START_MINUTES in one tap; the card's Other time opens
  // EstimateTimeModal for any other figure. Both go through advance(), so the alert clearing, the
  // optimistic move and tapMiss's revert are the same for each.
  //
  // A double tap. The popup used to take the second tap; now nothing sits between the finger and the
  // board. A second tap on the SAME card does nothing: advance() refuses a ticket already in
  // `advancing`, and the button is disabled ("…") until the write answers. But the card leaves New the
  // moment it is tapped, so the next ticket's Start can slide up under the same finger: a Start within
  // START_SETTLE_MS of the last one is ignored, on any card.
  const lastStartAt = useRef(0)
  function startNow(ticket) {
    const at = Date.now()
    if (at - lastStartAt.current < START_SETTLE_MS) return
    lastStartAt.current = at
    advance(ticket, 'in_progress', DEFAULT_START_MINUTES)
  }
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
  // FLOOR-KITCHEN-2 (S809 3d): a ticket whose every dish was taken off holds the alert until someone
  // taps Clear, as a CHANGE card does until Seen (the kitchen has to see that the food is off), but it
  // is not food running late, so it never turns the banner amber or red.
  const newFood = newTickets.filter(t => !t.allPulled)
  const oldestFoodMs = newFood.length > 0 ? Math.max(0, now - new Date(newFood[0].sent_at).getTime()) : 0
  const alertWarn = oldestFoodMs > WARN_MS
  const alertUrgent = oldestFoodMs > LATE_MS
  const alertMuted = alertMutedUntil > now
  const alertOn = newTickets.length > 0
  // A CHANGE card (S809 3a, ORDER-FLOW-9) holds the alert like any New ticket: a changed instruction
  // is often an allergy, the last thing to leave unread. Its one button, Seen, clears it, so it is loud
  // until someone has read it and never after.
  const newChanges = newTickets.filter(isChangeTicket).length
  const newPulled = newTickets.length - newFood.length
  const takeHint = newPulled > 0 && newPulled === newTickets.length
    ? (newPulled === 1 ? 'Every dish on it was taken off the order — tap Clear on the card.' : 'Every dish on them was taken off the order — tap Clear on each card.')
    : newPulled > 0 ? 'Tap Start on a new ticket, Seen on a change, or Clear on one whose dishes were taken off.'
    : newChanges === 0 ? 'Tap Start on the card to take it.'
    : newChanges === newTickets.length ? 'Read the change, then tap Seen on the card.'
    : 'Tap Start on a new ticket, or Seen once you have read a change.'

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

  // S817 4i (D18): the voided cards still up on this screen.
  const shownVoids = visibleVoids(voids, { firstSeen: voidFirstSeen.current, dismissed: voidDismissed, now })
  const dismissVoid = id => setVoidDismissed(prev => new Set(prev).add(id))

  const boardReady = loadedStation === station // S842: see loadedStation
  const visible = tickets.filter(t => {
    // S809 3d: a Ready ticket whose dishes were all taken off stays up until it is cleared.
    if (t.status !== 'ready' || t.allPulled) return true
    const readyAt = t.ready_at ? new Date(t.ready_at).getTime() : new Date(t.sent_at).getTime()
    return now - readyAt < READY_VISIBLE_MS
  })

  return (
    // A wall-mounted, no-keyboard screen viewed from several feet away is a genuinely different
    // device profile than the admin sidebar shell every other POS page shares — same reasoning
    // PosOrders.jsx already uses to escape the shell for its own full-screen order-taking view.
    // Full-bleed (no maxWidth cap) so a wide kitchen monitor shows more of the board, not a
    // centered column with wasted space on either side.
    // The top and bottom insets clear an installed iPhone's or iPad's status and home bars (env() is
    // 0 in a browser tab, S797). While the arrival alert is up it covers the status bar itself and
    // pads for it, and the header below already pads by its height, so the top inset is left out.
    // S842: the left and right insets too, for a tablet on its side with a notch or rounded corners.
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000, background: 'var(--theme-bg)', display: 'flex', flexDirection: 'column', overflowY: 'auto',
      padding: `${alertOn ? '20px' : 'calc(20px + env(safe-area-inset-top, 0px))'} calc(28px + env(safe-area-inset-right, 0px)) calc(20px + env(safe-area-inset-bottom, 0px)) calc(28px + env(safe-area-inset-left, 0px))`,
    }}>
      {/* ArrivalAlert is position: fixed at z-index 3000, so it paints OVER this 1000 layer rather
          than inside it — the board keeps its full height and nothing below shifts. The padding
          here is what stops the Exit button sitting underneath it. */}
      {/* The elapsed figure below is Math.ROUND, matching the card's own `elapsedMin` — at 3.5
          minutes a banner saying 3 over a card saying 4 is two answers to one question on one
          screen, and this banner's whole claim is that it agrees with the board underneath it. */}
      {alertOn && (
        // reserveSpace (S776): the header below used to pad a hard-coded 76px, and the banner wraps to
        // two lines on a narrower screen. The shell's own guest-order banner is suppressed on /pos/kds
        // (Layout.js), so this is the one mounted instance that may publish --arrival-alert-h here.
        <ArrivalAlert
          reserveSpace
          icon={alertUrgent ? '▲' : alertWarn ? '△' : '🔔'}
          urgent={alertUrgent}
          muted={alertMuted}
          onMute={() => setAlertMutedUntil(Date.now() + MUTE_MS)}
          title={newTickets.length === 1
            ? `${newChanges ? 'Changed instruction' : newPulled ? 'Dishes taken off' : 'New ticket'} — #${newTickets[0].order_no}${newTickets[0].tableNow ? ` · ${newTickets[0].tableNow}` : ''}`
            : `${newTickets.length} tickets waiting${newChanges ? ` — ${newChanges} with a changed instruction` : newPulled ? ` — ${newPulled} with every dish taken off` : ' to start'}`}
          detail={(oldestNewMs < 30000
            ? `Just in. ${takeHint}`
            : `Oldest sent ${Math.round(oldestNewMs / 60000)} min ago. ${takeHint}`)
            + (soundOff ? ' The sound is off on this screen until someone taps it.' : '')}
        />
      )}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 12, flexShrink: 0, paddingTop: alertOn ? 'var(--arrival-alert-h, 76px)' : 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          {/* Where Exit goes, and when it signs out, is exitBoard's (S835, D38). */}
          <button onClick={exitBoard} disabled={leaving} className="btn btn-ghost" style={{ fontSize: 13 }}>
            {leaving ? 'Signing out…' : '← Exit'}
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
            {/* S809 ACCESS-2 (owner decision Q4 a): only a Kitchen or Bar login stays signed in here.
                A Front of House PIN locks like a till (Layout.js), so say why before the board
                goes back to the PIN screen. The same test Layout runs the lock on. */}
            {posIdleLockApplies({
              pinStaff: !!profile?.pos_role,
              boundTablet: !!localStorage.getItem('pos_device_client_id'),
              stationTeam: isTeamLocked,
              path: '/pos/kds',
            }) && (
              <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--theme-text3)' }}>
                You are signed in with a Front of House login, so this screen locks after {Math.round(POS_IDLE_LOCK_MS / 60000)} minutes
                without a touch. To keep it on, sign in with a Kitchen or Bar login (POS Staff → Team).
              </p>
            )}
          </div>
        </div>
        {!isTeamLocked && (
          // Which board is showing — a filter over one board, so aria-pressed (S776); the chips said it by colour only.
          // S841: 15px and the 44px touch floor on each chip (kitchenDisplay.css, .till-hit--row).
          <FilterChips label="Station" active={station} onChange={selectStation}
            options={STATIONS.map(s => ({ key: s, label: s === 'KOT' ? 'Kitchen (KOT)' : 'Bar (BOT)', className: 'kds-chip till-hit--row' }))} />
        )}
      </div>

      {/* S835, D38: an Owner or operator login on an activated till tablet. Amber, not red: the board
          works, but this is not how a wall screen should be signed in. */}
      {ownerOnTill && (
        <div role="note" style={AMBER_BANNER}>
          <span style={{ flex: 1, minWidth: 220 }}>
            <strong style={{ color: 'var(--theme-amber-text)' }}>You're signed in as {isOwner ? 'the Owner' : 'Crest support'}.</strong>{' '}
            A wall screen should use a Kitchen or Bar login (POS Staff → Team) — anyone here can leave this screen as you.
            Exit signs you out on this tablet and opens the PIN screen.
          </span>
        </div>
      )}

      {/* S817 4i (FLOOR-KITCHEN-9): the browser is holding the sound. The amber banner's shape
          (PayrollRun's stale-draft card): the board still works, but nothing will ring. */}
      {soundOff && (
        <div role="alert" style={AMBER_BANNER}>
          <span style={{ flex: 1, minWidth: 220 }}>
            <strong style={{ color: 'var(--theme-amber-text)' }}>🔇 Sound is off on this screen.</strong>{' '}
            The browser holds it until someone touches the screen, so new tickets will not ring. Tap anywhere to turn it on.
          </span>
          <button type="button" className="btn btn-ghost btn-sm till-hit--row" onClick={() => { unlockAudio(); setTimeout(() => setSoundOff(soundBlocked()), 300) }}>
            Turn sound on
          </button>
        </div>
      )}

      {/* A real Dismiss button, not a "(tap to dismiss)" div: role="alert" is not an interactive
          role, and the div had no tabIndex or key handler — mouse and touch only. */}
      {/* S842: the two stale-board banners only over a board this station's read filled; before that
          the error card below takes the board's place, and there are no cancellations on screen. */}
      {[pollError && boardReady && ['poll', 'Could not refresh the board — the tickets shown are from the last successful check. ' + pollError.text, () => setPollError(null)], removalsError && boardReady && ['removals', removalsError, () => setRemovalsError('')], kdsError && ['kds', kdsError, () => setKdsError('')]]
        .filter(Boolean).map(([key, text, dismiss]) => (
        <div key={key} role="alert" style={{
          display: 'flex', alignItems: 'center', gap: 12,
          background: 'color-mix(in srgb, var(--theme-red) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-red) 25%, transparent)',
          borderRadius: 'var(--radius-sm)', padding: '12px 16px', marginBottom: 16, fontSize: 13,
          color: 'var(--theme-red-text)',
        }}>
          <span style={{ flex: 1 }}>{text}</span>
          <button type="button" className="btn btn-ghost btn-sm till-hit--row" onClick={dismiss}>Dismiss</button>
        </div>
      ))}

      {!boardReady ? (
        pollError ? (
          // S842: nothing has loaded for this station, so there is no board to show: not the empty
          // state, not three "(0)" columns, not the station just left. The poll keeps asking.
          <>
          <div className="card report-error" role="alert" style={{ marginBottom: 16 }}>
            <div className="report-error-title" style={{ fontSize: 18 }}>Could not load the {station === 'KOT' ? 'kitchen' : 'bar'} tickets</div>
            <p className="report-error-body" style={{ fontSize: 15 }}>{pollError.text}</p>
            <p className="report-error-hint" style={{ fontSize: 14 }}>
              This is not an empty {station === 'KOT' ? 'kitchen' : 'bar'}: no ticket can show here until this screen reads them, so work from the
              printed tickets for now. It tries again every few seconds by itself.
            </p>
            {pollError.detail && <p className="action-error-detail">{pollError.detail}</p>}
          </div>
          {/* A voided order's stop still shows: its own read answered (S817 4i). */}
          {shownVoids.length > 0 && (
            <div className="kds-board">
              {shownVoids.map(t => <VoidedCard key={`void-${t.id}`} ticket={t} onDismiss={dismissVoid} />)}
            </div>
          )}
          </>
        ) : (
          <p style={{ color: 'var(--theme-text3)', fontSize: 13 }}>Loading…</p>
        )
      ) : (
        <>
        {/* An empty board had no state of its own — three columns each holding a bare "—", which
            on a wall screen reads as "is this thing on?". Say what an empty board means (S683). */}
        {visible.length === 0 && shownVoids.length === 0 && (
          <div className="card" style={{ padding: '20px 24px', textAlign: 'center', color: 'var(--theme-text2)', fontSize: 14, marginBottom: 16 }}>
            Nothing on the board right now. Tickets appear here the moment a waiter sends an order — no refresh needed.
          </div>
        )}
        {/* S842: three columns that stack on a phone, and never wider than the screen (kitchenDisplay.css). */}
        <div className="kds-board">
          {COLUMNS.map(col => {
            const colTickets = visible.filter(t => t.status === col.status)
            const colVoids = shownVoids.filter(t => voidColumn(t) === col.status)
            return (
              <div key={col.status}>
                <h3 style={{
                  fontSize: 16, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em',
                  color: 'var(--theme-text2)', margin: '0 0 10px',
                  display: 'flex', alignItems: 'center', gap: 8,
                }}>
                  <span style={{ width: 11, height: 11, borderRadius: 0, background: col.dot, flexShrink: 0 }} />
                  {col.label} <span style={{ color: 'var(--theme-text3)', fontWeight: 400 }}>({colTickets.length})</span>
                </h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {/* A single quiet column keeps its dash; a wholly empty board says so once, above. */}
                  {colTickets.length === 0 && colVoids.length === 0 && (visible.length > 0 || shownVoids.length > 0) && (
                    <div className="card" style={{ padding: 20, textAlign: 'center', color: 'var(--theme-text3)', fontSize: 12 }}>—</div>
                  )}
                  {colVoids.map(t => (
                    <VoidedCard key={`void-${t.id}`} ticket={t} onDismiss={dismissVoid} />
                  ))}
                  {colTickets.map(t => (
                    <TicketCard
                      key={t.id} ticket={t} now={now} onAdvance={advance} onStart={startNow} onRequestEstimate={requestEstimate}
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

// A card's top line: the table the food goes to, and the order number. S836: the table is the bill's
// table now (withTableLabel); when the ticket printed for another, that one follows small, in the order
// number's type, so a cook can match the card to the paper without reading it as where to walk.
function TicketHead({ ticket }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
      <span>
        <span style={{ fontWeight: 700, fontSize: 22, color: 'var(--theme-text1)' }}>{ticket.tableNow || 'Takeaway'}</span>
        {ticket.tableWas && (
          <Tip text={`This ticket was printed for ${ticket.tableWas}. Its food is on the bill at ${ticket.tableNow} now (the bill moved table, or the two tables were joined), so it goes to ${ticket.tableNow}.`}>
            <span style={{ marginLeft: 8, fontSize: 14, color: 'var(--theme-text3)' }}>was {ticket.tableWas}</span>
          </Tip>
        )}
      </span>
      <span style={{ fontSize: 14, color: 'var(--theme-text3)' }}>#{ticket.order_no}</span>
    </div>
  )
}

// S817 4i (FLOOR-KITCHEN-4, D18): a ticket whose order was voided, kept up in the column it was in so
// a cook mid-cook sees the stop rather than an empty column. Dressed like a ticket whose dishes were all
// taken off (red-text label, struck lines, quiet strip): the same instruction, "do not make this".
// OK takes it off this screen only; every other screen keeps it for its own ten minutes.
function VoidedCard({ ticket, onDismiss }) {
  return (
    <div className="card" style={{ padding: 16, overflow: 'hidden' }}>
      <div style={{ margin: '-16px -16px 12px', height: 7, background: ticketStripColor({ status: null, isLate: false, isWarn: false }) }} />
      <TicketHead ticket={ticket} />
      <div style={{ fontSize: 16, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--theme-red-text)', marginBottom: 6 }}>
        <Tip text="This order's bill was voided on the till, so nothing on this ticket is wanted any more. A VOID slip printed with the dishes to stop. OK takes the card off this screen; it also leaves by itself after ten minutes.">
          <span>Voided{ticket.cancelled_at ? ` ${nepalTime(ticket.cancelled_at)}` : ''} — stop, do not make</span>
        </Tip>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 12 }}>
        {(ticket.items || []).map((i, idx) => (
          <div key={idx} style={{ fontSize: 20, color: 'var(--theme-text3)' }}>
            <s>{isChangeLine(i) ? i.name : `${i.qty} × ${i.name}`}</s>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button type="button" className="btn btn-ghost" style={{ fontSize: 16, padding: '10px 20px' }} onClick={() => onDismiss(ticket.id)}
          aria-label={`OK, take the voided ticket for ${ticket.tableNow || 'Takeaway'} #${ticket.order_no} off this screen`}>
          OK
        </button>
      </div>
    </div>
  )
}

function TicketCard({ ticket, now, onAdvance, onStart, onRequestEstimate, action, next, isStartAction, advancing }) {
  const sentMs = new Date(ticket.sent_at).getTime()
  const elapsedMin = Math.max(0, Math.round((now - sentMs) / 60000))
  // FLOOR-KITCHEN-2 (S809 3d): every dish on it was taken off the order, so there is nothing to make
  // and nothing to be late with. Its one button is Clear (→ cancelled), never Start/Ready/Served.
  const pulledAll = !!ticket.allPulled
  const isLate = !pulledAll && ticket.status !== 'ready' && (now - sentMs) > LATE_MS
  const isWarn = !pulledAll && ticket.status !== 'ready' && !isLate && (now - sentMs) > WARN_MS
  const borderColor = isLate ? 'var(--theme-red)' : isWarn ? 'var(--theme-amber)' : 'var(--theme-border)'
  // Strip and border encode the same fact deliberately — redundant reinforcement of the one thing
  // on this card that needs someone, not two different facts competing for the same two hues.
  const stripColor = ticketStripColor({ status: pulledAll ? null : ticket.status, isLate, isWarn }) // S809 3d: never "ready" green
  // ORDER-FLOW-9 (S809 3a): a CHANGE card. A waiter changed the instruction on a dish this station
  // already has, so there is nothing new to cook: its one button, Seen, moves it straight to served
  // (guard_pos_kot_log allows any forward move) and it leaves the board.
  const change = isChangeTicket(ticket)
  // S846: a New ticket with food on it starts in one tap at DEFAULT_START_MINUTES, with Other time
  // beside it. A Clear or Seen card in New keeps its one button.
  const oneTapStart = isStartAction && !pulledAll && !change
  const cardName = `${ticket.tableNow || 'Takeaway'} #${ticket.order_no}`

  // Estimated-vs-actual readout, shown once a ticket has an estimate on it (set on Start, 10 minutes
  // unless Other time chose another) — a live "time left" while in progress, then a settled
  // comparison once Ready.
  let etaNode = null
  if (!pulledAll && ticket.status === 'in_progress' && ticket.started_at && ticket.estimated_prep_minutes) {
    const startedMs = new Date(ticket.started_at).getTime()
    const remainingMin = Math.round((startedMs + ticket.estimated_prep_minutes * 60000 - now) / 60000)
    const over = remainingMin < 0
    etaNode = (
      <span style={{ fontSize: 14, color: over ? 'var(--theme-red-text)' : 'var(--theme-text3)', fontWeight: over ? 700 : 400 }}>
        {over ? `${Math.abs(remainingMin)} min over est.` : `~${remainingMin} min left`}
      </span>
    )
  } else if (ticket.status === 'ready' && ticket.started_at && ticket.ready_at && ticket.estimated_prep_minutes) {
    const actualMin = Math.round((new Date(ticket.ready_at).getTime() - new Date(ticket.started_at).getTime()) / 60000)
    const overEst = actualMin > ticket.estimated_prep_minutes
    etaNode = (
      <span style={{ fontSize: 14, color: overEst ? 'var(--theme-red-text)' : 'var(--theme-green-text)' }}>
        Done in {actualMin}m (est. {ticket.estimated_prep_minutes}m)
      </span>
    )
  }

  return (
    <div className="card" style={{ padding: 16, borderColor, borderWidth: isLate || isWarn ? 2 : 1, overflow: 'hidden' }}>
      <div style={{ margin: '-16px -16px 12px', height: 7, background: stripColor }} />
      <TicketHead ticket={ticket} />
      {change && (
        <div style={{ fontSize: 16, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--theme-text1)', marginBottom: 6 }}>
          Changed instruction — nothing new to cook
        </div>
      )}
      {pulledAll && (
        <div style={{ fontSize: 16, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--theme-red-text)', marginBottom: 6 }}>
          <Tip text="Every dish on this ticket was taken off the order on the till, with the reason shown under it. Clear takes the ticket off the board without marking anything as cooked, so the floor stops showing it.">
            <span>Taken off the order — do not make</span>
          </Tip>
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 12 }}>
        {(ticket.items || []).map((i, idx) => {
          const note = itemNote(i)
          if (isChangeLine(i)) {
            return (
              <div key={idx} style={{ fontSize: 20, color: 'var(--theme-text2)' }}>
                {i.name}
                <ItemCombo item={i} />
                <ItemOptions options={i.options} />
                <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--theme-text1)', paddingLeft: 16 }}>Now: {changeNoteText(i)}</div>
              </div>
            )
          }
          // S754: a line pulled or reduced after this ticket was sent. The strike-through and the
          // word "cancelled" carry it, not only the red — the kitchen must stop cooking it.
          const pulled = ticket.removals?.[idx]
          if (pulled?.length) {
            const removedQty = pulled.reduce((n, e) => n + e.qty, 0)
            const nowQty = Math.max(0, (Number(i.qty) || 0) - removedQty)
            const last = pulled.reduce((a, e) => (new Date(e.removed_at) > new Date(a.removed_at) ? e : a))
            const reasons = [...new Set(pulled.map(e => (e.reason || '').trim()).filter(Boolean))].join(' / ')
            return (
              <div key={idx} style={{ fontSize: 20, color: 'var(--theme-text2)' }}>
                {nowQty === 0 ? (
                  <s style={{ color: 'var(--theme-text3)' }}>{i.qty} × {i.name}</s>
                ) : (
                  <span><s style={{ color: 'var(--theme-text3)' }}>{i.qty}</s> → {nowQty} × {i.name}</span>
                )}
                <ItemCombo item={i} />
                <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--theme-red-text)', paddingLeft: 16 }}>
                  {nowQty === 0 ? 'Cancelled' : `${removedQty} cancelled`} {nepalTime(last.removed_at)} · {reasons || 'no reason given'}
                </div>
                {nowQty > 0 && <ItemOptions options={i.options} />}
                {nowQty > 0 && note && <div style={{ fontSize: 18, color: 'var(--theme-text1)', paddingLeft: 16 }}>↳ {note}</div>}
              </div>
            )
          }
          return (
            <div key={idx} style={{ fontSize: 20, color: 'var(--theme-text2)' }}>
              {i.qty} × {i.name}
              <ItemCombo item={i} />
              <ItemOptions options={i.options} />
              {note && <div style={{ fontSize: 18, color: 'var(--theme-text1)', paddingLeft: 16 }}>↳ {note}</div>}
            </div>
          )
        })}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <Tip text={`Time since this ticket was sent. △ means it is approaching the ${Math.round(WARN_MS / 60000)}-minute mark, ▲ that it is past ${Math.round(LATE_MS / 60000)} minutes.`}>
            <span style={{ fontSize: 16, color: isLate ? 'var(--theme-red-text)' : isWarn ? 'var(--theme-amber-text)' : 'var(--theme-text3)', fontWeight: isLate || isWarn ? 700 : 400 }}>
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
        {/* S846 (owner decision, the accent pass): the card's action is ghost on every stage. The accent
            had filled one button on every card, so it marked nothing; it stays for what is pressed. */}
        {action && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
            {oneTapStart && (
              <button
                type="button" className="btn btn-ghost till-hit--row" style={{ fontSize: 14, padding: '8px 12px' }} disabled={advancing}
                onClick={() => onRequestEstimate(ticket)}
                aria-label={`Other time: choose the prep estimate and start ${cardName}`}
              >
                Other time
              </button>
            )}
            <button
              type="button" className="btn btn-ghost till-hit--row" style={{ fontSize: 16, padding: '10px 20px' }} disabled={advancing}
              onClick={() => pulledAll ? onAdvance(ticket, 'cancelled') : change ? onAdvance(ticket, 'served') : oneTapStart ? onStart(ticket) : onAdvance(ticket, next)}
              aria-label={oneTapStart && !advancing ? `Start ${cardName} with a ${DEFAULT_START_MINUTES}-minute estimate` : undefined}
            >
              {advancing ? '…' : pulledAll ? 'Clear' : change ? 'Seen' : oneTapStart ? `Start · ${DEFAULT_START_MINUTES}m` : action}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
