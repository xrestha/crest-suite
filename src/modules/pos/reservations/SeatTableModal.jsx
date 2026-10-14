import { useState, useEffect, useCallback, useRef } from 'react'
import Modal from '../../../components/Modal'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'
import { firstError } from '../../../shared/queryError'
import { setIfChanged, rowsSignature } from '../../../shared/setIfChanged'
import { settleWithin } from '../../../utils/withTimeout'
import { nepalTime } from '../../../shared/nepalTime'
import { tableIdsOf } from './reservationStatus'

// The pos_tables columns the book and this dialog read. One list, because the picked row is the one
// handed to Order Taking (pos_orders.table_name is snapshotted from it).
export const SEAT_TABLE_SELECT = 'id, name, section, capacity, status'
// S835: the dialog re-reads which tables are in use while it is open, as often as the floor does.
const SEAT_POLL_MS = 15000
const SEAT_READ_MS = 10000
const tablesSig = l => rowsSignature(l, ['id', 'name', 'section', 'capacity', 'status'])
const idsSig = set => [...set].sort().join(',')

// "Seat <name> ×<party>" → pick the table. Tapping one hands the booking to Order Taking, which
// opens the order with covers already filled in and writes the link back (see PosOrders.jsx's
// seatReservation handoff). Tables the host pre-assigned come first; a table that already has an
// open order is shown but not tappable — opening it would attach this booking to somebody else's
// bill.
//
// S835: the busy marks are the dialog's own. The page's list poll stops while a dialog is open, so
// marks taken from it were as old as the page's last read and a table freed (or taken) since showed
// wrong for as long as the host looked at the grid. It paints from the page's last read at once,
// reads the outlet's tables and open orders as it opens and every SEAT_POLL_MS after, and a read that
// fails keeps the last marks it had and says so. Order Taking still refuses a table that has an open
// order by the time it is tapped (seatRefusedText), so a mark a few seconds old is never a wrong seat.
export default function SeatTableModal({ reservation, tables: pageTables, openTableIds: pageOpenIds, onClose, onPick }) {
  const { clientId, scopedFrom } = useScopedDb()
  const seatReq = useLatestRequest()
  const readSeq = useRef(0)
  const [tables, setTables] = useState(() => pageTables || [])
  const [openTableIds, setOpenTableIds] = useState(() => pageOpenIds || new Set())
  const [checkedAt, setCheckedAt] = useState(null)   // when the dialog's own read last answered
  const [refreshFailed, setRefreshFailed] = useState(false)

  const refresh = useCallback(async () => {
    if (!clientId) return
    // A counter, not a period id: every read here is the same question, so the newest one asked wins
    // and a slow earlier answer landing after it is dropped.
    const key = seatReq.begin(`${clientId}:${++readSeq.current}`)
    const results = await Promise.all([
      settleWithin(scopedFrom('pos_tables', SEAT_TABLE_SELECT).order('sort_order').order('name'), SEAT_READ_MS, 'Table list'),
      settleWithin(scopedFrom('pos_orders', 'id, table_id').eq('status', 'open'), SEAT_READ_MS, 'Open orders'),
    ])
    if (!seatReq.isCurrent(key)) return
    // A failed read is not "every table is free": keep the last marks and say they may be old.
    const failed = firstError(results)
    if (failed) { console.error('seat dialog: table refresh failed, keeping last known:', failed); setRefreshFailed(true); return }
    const [{ data: tbls }, { data: open }] = results
    setIfChanged(setTables, tbls || [], tablesSig)
    setIfChanged(setOpenTableIds, new Set((open || []).map(o => o.table_id).filter(Boolean)), idsSig)
    setCheckedAt(Date.now())
    setRefreshFailed(false)
  }, [clientId, scopedFrom, seatReq])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, SEAT_POLL_MS)
    return () => clearInterval(id)
  }, [refresh])

  const held = new Set(tableIdsOf(reservation))
  const usable = (tables || []).filter(t => t.status !== 'inactive')
  // S818 RESERVATIONS-11: a held table taken out of service cannot be picked, so it is named here
  // rather than simply missing from the grid.
  const heldInactive = (tables || []).filter(t => t.status === 'inactive' && held.has(t.id))
  const sorted = [...usable].sort((a, b) => (held.has(b.id) ? 1 : 0) - (held.has(a.id) ? 1 : 0))
  const sections = Array.from(new Set(sorted.map(t => t.section || '')))

  const isBusy = t => openTableIds?.has(t.id) || t.status === 'occupied'

  return (
    <Modal title={`Seat ${reservation.customer_name} ×${reservation.party_size}`} onClose={onClose} maxWidth={560}>
      <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.6 }}>
        Tap the table they are sitting at. The order opens with {reservation.party_size} cover{reservation.party_size === 1 ? '' : 's'} filled in
        and this booking is marked Seated. A table with a running order cannot be picked — it belongs to another party.
      </p>
      {refreshFailed && (
        <p role="status" style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--theme-amber-text)', lineHeight: 1.6 }}>
          △ Couldn't refresh which tables are in use{checkedAt ? ` — last checked at ${nepalTime(checkedAt)}` : ''}, so the marks below may be out of date. Trying again every 15 seconds.
        </p>
      )}
      {heldInactive.length > 0 && (
        <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--theme-amber-text)', lineHeight: 1.6 }}>
          △ {heldInactive.map(t => t.name).join(', ')} {heldInactive.length === 1 ? 'was held for them but is' : 'were held for them but are'} out of service — pick another table.
        </p>
      )}
      {usable.length === 0 ? (
        <p style={{ fontSize: 13, color: 'var(--theme-text3)' }}>No tables set up yet.</p>
      ) : sections.map(sec => (
        <div key={sec || '__none'} style={{ marginBottom: 16 }}>
          {sections.length > 1 && (
            // The data-table th eyebrow's values (11px / 500 / 0.08em / text2) — a second eyebrow with its
            // own weight and a unitless letterSpacing (0.4 = 0.4px) is how one product grows two.
            <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>
              {sec || 'No section'}
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 8 }}>
            {sorted.filter(t => (t.section || '') === sec).map(t => {
              const busy = isBusy(t)
              const wasHeld = held.has(t.id)
              return (
                <button
                  key={t.id}
                  type="button"
                  className="btn btn-ghost"
                  disabled={busy}
                  onClick={() => onPick(t)}
                  title={busy ? `${t.name} has a running order` : `Seat at ${t.name}`}
                  style={{
                    justifyContent: 'space-between', gap: 8, padding: '10px 12px',
                    ...(wasHeld ? { borderColor: 'var(--theme-accent)' } : {}),
                  }}
                >
                  <span style={{ fontWeight: 700 }}>{t.name}</span>
                  <span style={{ fontSize: 11, color: 'var(--theme-text3)', whiteSpace: 'nowrap' }}>
                    {busy ? 'in use' : wasHeld ? 'held' : `${t.capacity ?? '—'} seats`}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      ))}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  )
}
