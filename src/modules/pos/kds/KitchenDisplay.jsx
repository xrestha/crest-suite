import { useState, useEffect, useCallback } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import Tip from '../../../components/Tip'

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

// On-screen ticket board that runs ALONGSIDE the existing printed KOT/BOT tickets — sending a
// KOT/BOT from Order Taking still prints exactly as before (see PosOrders.jsx); this just gives
// the kitchen/bar a live view of the same send events, with a tap-to-advance status per ticket.
// Each pos_kot_log row already IS one physical ticket (one send event — an addition to an order
// gets its own row, matching how a second small paper ticket prints for just the new items), so
// this maps 1:1 onto existing rows rather than a new ticket concept.
export default function KitchenDisplay() {
  const { profile, hasPosAccess } = useAuth()
  const { scopedFrom, scopedUpdate } = useScopedDb()

  const [station, setStation] = useState(() => localStorage.getItem('pos_kds_station') || 'KOT')
  const [tickets, setTickets] = useState([])
  const [loading, setLoading] = useState(true)
  const [now, setNow] = useState(() => Date.now()) // ticks every 30s to redraw elapsed-time labels/colors

  const load = useCallback(async () => {
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0)
    const { data } = await scopedFrom('pos_kot_log', 'id, order_id, order_no, table_name, station, items, sent_at, status, started_at, ready_at')
      .eq('station', station)
      .gte('sent_at', startOfDay.toISOString())
      .order('sent_at', { ascending: true })
    setTickets(data || [])
    setLoading(false)
  }, [scopedFrom, station])

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
    localStorage.setItem('pos_kds_station', s)
  }

  async function advance(ticket, nextStatus) {
    // Optimistic — the next poll (≤4s) reconciles with the server either way.
    setTickets(prev => prev.map(t => t.id === ticket.id ? { ...t, status: nextStatus } : t))
    const patch = { status: nextStatus, status_updated_by: profile?.id || null }
    if (nextStatus === 'in_progress') patch.started_at = new Date().toISOString()
    if (nextStatus === 'ready') patch.ready_at = new Date().toISOString()
    await scopedUpdate('pos_kot_log', patch).eq('id', ticket.id)
  }

  if (!hasPosAccess('staff')) return <Navigate to="/pos" replace />

  const visible = tickets.filter(t => {
    if (t.status !== 'ready') return true
    const readyAt = t.ready_at ? new Date(t.ready_at).getTime() : new Date(t.sent_at).getTime()
    return now - readyAt < READY_VISIBLE_MS
  })

  return (
    <div style={{ padding: '20px 24px', maxWidth: 1400 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2 style={{ margin: 0, color: 'var(--theme-text1)', fontSize: 20 }}>Kitchen Display</h2>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--theme-text3)' }}>
            Live view of today's {station === 'KOT' ? 'kitchen' : 'bar'} tickets — printing still happens as normal, this just mirrors it on screen.
          </p>
        </div>
        <div className="tab-bar">
          {STATIONS.map(s => (
            <button key={s} className={`tab-btn${station === s ? ' tab-btn--active' : ''}`} onClick={() => selectStation(s)}>
              {s === 'KOT' ? 'Kitchen (KOT)' : 'Bar (BOT)'}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <p style={{ color: 'var(--theme-text3)', fontSize: 13 }}>Loading…</p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
          {COLUMNS.map(col => {
            const colTickets = visible.filter(t => t.status === col.status)
            return (
              <div key={col.status}>
                <h3 style={{
                  fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em',
                  color: 'var(--theme-text2)', margin: '0 0 10px',
                }}>
                  {col.label} <span style={{ color: 'var(--theme-text3)', fontWeight: 400 }}>({colTickets.length})</span>
                </h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {colTickets.length === 0 && (
                    <div className="card" style={{ padding: 20, textAlign: 'center', color: 'var(--theme-text3)', fontSize: 12 }}>—</div>
                  )}
                  {colTickets.map(t => (
                    <TicketCard key={t.id} ticket={t} now={now} onAdvance={advance} action={col.action} next={col.next} />
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function TicketCard({ ticket, now, onAdvance, action, next }) {
  const sentMs = new Date(ticket.sent_at).getTime()
  const elapsedMin = Math.max(0, Math.round((now - sentMs) / 60000))
  const isLate = ticket.status !== 'ready' && (now - sentMs) > LATE_MS
  const isWarn = ticket.status !== 'ready' && !isLate && (now - sentMs) > WARN_MS
  const borderColor = isLate ? 'var(--theme-red)' : isWarn ? 'var(--theme-amber)' : 'var(--theme-border)'

  return (
    <div className="card" style={{ padding: 14, borderColor, borderWidth: isLate || isWarn ? 2 : 1 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
        <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--theme-text1)' }}>{ticket.table_name || 'Takeaway'}</span>
        <span style={{ fontSize: 11, color: 'var(--theme-text3)' }}>#{ticket.order_no}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginBottom: 10 }}>
        {(ticket.items || []).map((i, idx) => (
          <div key={idx} style={{ fontSize: 13, color: 'var(--theme-text2)' }}>{i.qty} × {i.name}</div>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Tip text="Time since this ticket was sent">
          <span style={{ fontSize: 11, color: isLate ? 'var(--theme-red)' : isWarn ? 'var(--theme-amber)' : 'var(--theme-text3)', fontWeight: isLate || isWarn ? 700 : 400 }}>
            {elapsedMin} min ago
          </span>
        </Tip>
        {action && (
          <button className="btn btn-primary" style={{ fontSize: 12, padding: '5px 12px' }} onClick={() => onAdvance(ticket, next)}>
            {action}
          </button>
        )}
      </div>
    </div>
  )
}
