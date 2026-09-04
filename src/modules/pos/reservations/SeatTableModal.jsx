import Modal from '../../../components/Modal'
import { tableIdsOf } from './reservationStatus'

// "Seat <name> ×<party>" → pick the table. Tapping one hands the booking to Order Taking, which
// opens the order with covers already filled in and writes the link back (see PosOrders.jsx's
// seatReservation handoff). Tables the host pre-assigned come first; a table that already has an
// open order is shown but not tappable — opening it would attach this booking to somebody else's
// bill.
export default function SeatTableModal({ reservation, tables, openTableIds, onClose, onPick }) {
  const held = new Set(tableIdsOf(reservation))
  const usable = (tables || []).filter(t => t.status !== 'inactive')
  const sorted = [...usable].sort((a, b) => (held.has(b.id) ? 1 : 0) - (held.has(a.id) ? 1 : 0))
  const sections = Array.from(new Set(sorted.map(t => t.section || '')))

  const isBusy = t => openTableIds?.has(t.id) || t.status === 'occupied'

  return (
    <Modal title={`Seat ${reservation.customer_name} ×${reservation.party_size}`} onClose={onClose} maxWidth={560}>
      <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.6 }}>
        Tap the table they are sitting at. The order opens with {reservation.party_size} cover{reservation.party_size === 1 ? '' : 's'} filled in
        and this booking is marked Seated. A table with a running order cannot be picked — it belongs to another party.
      </p>
      {usable.length === 0 ? (
        <p style={{ fontSize: 13, color: 'var(--theme-text3)' }}>No tables set up yet.</p>
      ) : sections.map(sec => (
        <div key={sec || '__none'} style={{ marginBottom: 14 }}>
          {sections.length > 1 && (
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 }}>
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
