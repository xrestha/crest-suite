import { CLOSE_TYPE_BADGE } from '../posSignals'

// A ticket's kitchen stage as the KOT Log's Register (reports/KotLog.jsx) words it (S754). 'served' is
// new: the floor marks a Ready ticket as delivered so its Ready clears. Not posSignals' KOT_STATUS_LABEL,
// which is the till's live-floor vocabulary ('Sent' / 'Started') and does not know served or cancelled.
// Served and Ready are both finished food, so both take the done verdict; the label tells them apart.
const KOT_STAGE = {
  new:         { label: 'Sent',      badge: 'badge-gray' },
  in_progress: { label: 'Started',   badge: 'badge-yellow' },
  ready:       { label: 'Ready',     badge: 'badge-green' },
  served:      { label: 'Served',    badge: 'badge-green' },
  cancelled:   { label: 'Cancelled', badge: 'badge-gray' },
}

// S833 (POS_TODO S809.4 3d): 'cancelled' is two different things. The kitchen CLEARS a ticket whose
// every dish was taken off the order (S809 3d), and a void cancels the bill's tickets still in the
// kitchen (S817). The ticket's own ORDER tells them apart: voided reads Voided, in the red a void wears
// everywhere in POS (statusBadge on the KOT Log's other tabs); any other order reads Cleared. With no
// order status to go on (the read did not embed it, or RLS hid the order) it stays the plain
// "Cancelled" rather than a guess. A ticket the kitchen cleared before the bill was voided reads
// Voided: the void is the bigger fact about that bill. It lives here, not beside KotLog.jsx, because
// this clone's .git/info/exclude ignores every new file under a reports/ folder.
export function kotStage(ticket) {
  const status = ticket?.status
  if (status === 'cancelled') {
    const orderStatus = ticket?.pos_orders?.status
    if (orderStatus === 'voided') return { label: 'Voided', badge: CLOSE_TYPE_BADGE.void }
    if (orderStatus) return { label: 'Cleared', badge: 'badge-gray' }
  }
  return KOT_STAGE[status] || { label: status || '—', badge: 'badge-gray' }
}
