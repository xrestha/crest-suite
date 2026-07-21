import { useState, useEffect, useCallback, useRef } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import Tip from '../../../components/Tip'
import EstimateTimeModal from './EstimateTimeModal'

const STATIONS = ['KOT', 'BOT']
const POLL_MS = 4000
// A ticket sitting in Ready for longer than this drops off the board (still in the DB, still
// counted by KOT Register/Reconciliation — this is display-only decluttering, not a delete).
const READY_VISIBLE_MS = 10 * 60 * 1000
// Elapsed-time flag thresholds, matching the "flag the outlier" pattern used elsewhere in POS
// (Sales Exceptions, KOT Reconciliation) — a ticket sitting too long gets visually called out.
const WARN_MS = 8 * 60 * 1000
const LATE_MS = 15 * 60 * 1000

const COLUMNS = [
  { status: 'new',         label: 'New',         action: 'Start',  next: 'in_progress' },
  { status: 'in_progress', label: 'In Progress',  action: 'Ready',  next: 'ready' },
  { status: 'ready',       label: 'Ready',        action: null,     next: null },
]

// Stage color, independent of the elapsed-time lateness border below — a ticket can be both
// "New" (red stage) AND late (red lateness border) at once; that's a stronger, not conflicting, signal.
const STATUS_COLOR = { new: 'var(--theme-red)', in_progress: 'var(--theme-amber)', ready: 'var(--theme-green)' }

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
  // Ticket ids with an advance() write in flight — a rapid double-tap on greasy kitchen
  // touchscreens could otherwise fire two overlapping updates whose responses arrive out of
  // order, leaving the row reverted to an earlier stage than what was actually tapped.
  const [advancing, setAdvancing] = useState(() => new Set())
  // advance() previously never checked the write's result, so a failed update (RLS denial,
  // network blip) left the optimistic status showing on screen for up to POLL_MS with no
  // indication the DB write never landed — a busy kitchen could believe a ticket was done when
  // it wasn't. Now reverted immediately below on error, with a dismissible reason shown here.
  const [kdsError, setKdsError] = useState('')
  // Ticket awaiting an estimated prep time before it can advance to In Progress — see
  // requestEstimate/confirmStart below and EstimateTimeModal.jsx.
  const [estimateTicket, setEstimateTicket] = useState(null)
  // New-ticket chime bookkeeping — same "skip the very first load, chime only on a genuinely new
  // arrival" pattern as PosOrders.jsx's playGuestOrderChime, reset per-station since switching the
  // KOT/BOT toggle is a real station change, not a fresh arrival on the previous station.
  const seenTicketIds = useRef(new Set())
  const loadedOnce = useRef(false)

  const load = useCallback(async () => {
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0)
    // 'cancelled' (set by PosOrders.jsx's closeOrder when the parent order is voided) is excluded
    // entirely rather than shown as a 4th column — there's nothing left for kitchen/bar to do
    // with a ticket whose order no longer exists.
    const { data } = await scopedFrom('pos_kot_log', 'id, order_id, order_no, table_name, station, items, sent_at, status, started_at, ready_at, estimated_prep_minutes')
      .eq('station', station)
      .neq('status', 'cancelled')
      .gte('sent_at', startOfDay.toISOString())
      .order('sent_at', { ascending: true })
    const rows = data || []
    const newTickets = rows.filter(t => t.status === 'new')
    if (loadedOnce.current && newTickets.some(t => !seenTicketIds.current.has(t.id))) {
      playNewTicketChime()
    }
    seenTicketIds.current = new Set(newTickets.map(t => t.id))
    loadedOnce.current = true
    setTickets(rows)
    setLoading(false)
  }, [scopedFrom, station])

  // A wall-mounted KDS screen is the one place in POS most likely to not be looked at
  // continuously — the same two-tone Web Audio beep PosOrders.jsx/GuestMenu.jsx already use for
  // their own new-arrival events, so a new ticket doesn't rely on someone glancing at the board.
  function playNewTicketChime() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext
      if (!Ctx) return
      const ctx = new Ctx()
      const now = ctx.currentTime
      ;[880, 660].forEach((freq, i) => {
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.type = 'sine'
        osc.frequency.value = freq
        gain.gain.setValueAtTime(0.0001, now + i * 0.18)
        gain.gain.exponentialRampToValueAtTime(0.3, now + i * 0.18 + 0.02)
        gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.18 + 0.16)
        osc.connect(gain); gain.connect(ctx.destination)
        osc.start(now + i * 0.18)
        osc.stop(now + i * 0.18 + 0.18)
      })
    } catch (_) { /* audio blocked or unsupported — visual board still shows the new ticket */ }
  }

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
    const { error } = await scopedUpdate('pos_kot_log', patch).eq('id', ticket.id)
    if (error) {
      setTickets(prev => prev.map(t => t.id === ticket.id ? { ...t, status: prevStatus } : t))
      setKdsError(`Could not update ${ticket.table_name || 'this ticket'} — ${error.message}`)
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
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 12, flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          {/* '/pos/orders' was every POS staffer's home before kitchen/bar teams (S431) existed —
              a locked-team account doesn't have Orders in its sidebar at all, so exiting there
              would land on a page that isn't theirs. Dashboard is the one destination every team
              always has. */}
          <button onClick={() => navigate(isTeamLocked ? '/dashboard' : '/pos/orders')} className="btn btn-ghost" style={{ fontSize: 13 }}>
            ← Exit
          </button>
          <div>
            <h2 style={{ margin: 0, color: 'var(--theme-text1)', fontSize: 26 }}>
              {isTeamLocked ? (station === 'KOT' ? 'Kitchen Display' : 'Bar Display') : 'Kitchen Display'}
            </h2>
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

      {kdsError && (
        <div role="alert" style={{
          background: 'color-mix(in srgb, var(--theme-red) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-red) 25%, transparent)',
          borderRadius: 8, padding: '12px 16px', marginBottom: 16, fontSize: 13,
          color: 'var(--theme-red)', cursor: 'pointer',
        }} onClick={() => setKdsError('')}>
          {kdsError} <span style={{ opacity: 0.7 }}>(tap to dismiss)</span>
        </div>
      )}

      {loading ? (
        <p style={{ color: 'var(--theme-text3)', fontSize: 13 }}>Loading…</p>
      ) : (
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
                  <span style={{ width: 11, height: 11, borderRadius: '50%', background: STATUS_COLOR[col.status], flexShrink: 0 }} />
                  {col.label} <span style={{ color: 'var(--theme-text3)', fontWeight: 400 }}>({colTickets.length})</span>
                </h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {colTickets.length === 0 && (
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
  const stageColor = STATUS_COLOR[ticket.status] || 'var(--theme-border)'

  // Estimated-vs-actual readout, shown once a ticket has an estimate on it (set via the Start
  // popup) — a live "time left" while in progress, then a settled comparison once Ready.
  let etaNode = null
  if (ticket.status === 'in_progress' && ticket.started_at && ticket.estimated_prep_minutes) {
    const startedMs = new Date(ticket.started_at).getTime()
    const remainingMin = Math.round((startedMs + ticket.estimated_prep_minutes * 60000 - now) / 60000)
    const over = remainingMin < 0
    etaNode = (
      <span style={{ fontSize: 12, color: over ? 'var(--theme-red)' : 'var(--theme-text3)', fontWeight: over ? 700 : 400 }}>
        {over ? `${Math.abs(remainingMin)} min over est.` : `~${remainingMin} min left`}
      </span>
    )
  } else if (ticket.status === 'ready' && ticket.started_at && ticket.ready_at && ticket.estimated_prep_minutes) {
    const actualMin = Math.round((new Date(ticket.ready_at).getTime() - new Date(ticket.started_at).getTime()) / 60000)
    const overEst = actualMin > ticket.estimated_prep_minutes
    etaNode = (
      <span style={{ fontSize: 12, color: overEst ? 'var(--theme-red)' : 'var(--theme-green)' }}>
        Done in {actualMin}m (est. {ticket.estimated_prep_minutes}m)
      </span>
    )
  }

  return (
    <div className="card" style={{ padding: 16, borderColor, borderWidth: isLate || isWarn ? 2 : 1, overflow: 'hidden' }}>
      <div style={{ margin: '-16px -16px 12px', height: 7, background: stageColor }} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
        <span style={{ fontWeight: 700, fontSize: 16, color: 'var(--theme-text1)' }}>{ticket.table_name || 'Takeaway'}</span>
        <span style={{ fontSize: 12, color: 'var(--theme-text3)' }}>#{ticket.order_no}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 12 }}>
        {(ticket.items || []).map((i, idx) => (
          <div key={idx} style={{ fontSize: 16, color: 'var(--theme-text2)' }}>{i.qty} × {i.name}</div>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <Tip text="Time since this ticket was sent">
            <span style={{ fontSize: 13, color: isLate ? 'var(--theme-red)' : isWarn ? 'var(--theme-amber)' : 'var(--theme-text3)', fontWeight: isLate || isWarn ? 700 : 400 }}>
              {elapsedMin} min ago
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
