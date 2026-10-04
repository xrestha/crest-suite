import { useState, useEffect } from 'react'
import { useScopedDb } from './useScopedDb'
import { readSeenStamp } from '../reservationSeen'

const POLL_MS = 60000

// Rail badge counts for the HR and POS module icons — reuses the exact same "pending" filters
// HrDashboard.jsx and PosOrders.jsx already query for their own KPI cards/floor-view banner, just
// as lightweight count-only (HR) / minimal-column (POS) polls so a rail dot can show up without
// duplicating those pages' full data loads. Only polls while the caller says the module is
// visible to this user — no point querying HR pending counts for a POS-only client.
export function useNavBadgeCounts(hrVisible, posVisible) {
  const { scopedFrom, clientId } = useScopedDb()
  const [hrPending, setHrPending] = useState(0)
  const [posPending, setPosPending] = useState(0)
  // Online booking requests waiting for a staff Accept. Counted separately from posPending so the
  // Reservations nav row can carry its own number: a request that only showed on the Reservations
  // page (amber band + chime) and the dashboard tile was reported as "no notification" by an
  // owner sitting on the IMS dashboard (S686).
  const [posRequests, setPosRequests] = useState(0)
  // Bookings changed since this device last opened the Reservations page (S687) — the same count
  // that page's Activity tab shows, from the same per-device stamp. No stamp = nothing counted.
  const [posNew, setPosNew] = useState(0)

  // Each effect starts from 0 because a client switch re-runs it: one client's count must never
  // show on another's rail. After that, a failed poll keeps the last good value (S798 REPORTS-7) —
  // a dot that vanishes on a dropped poll reads as "handled", and one failed table of four would
  // undercount the rest. Same rule as posRequests/posNew below.
  useEffect(() => {
    setHrPending(0)
    if (!clientId || !hrVisible) return
    let cancelled = false
    async function load() {
      const results = await Promise.all([
        scopedFrom('hr_leave_requests', 'id', { count: 'exact', head: true }).eq('status', 'pending'),
        scopedFrom('hr_overtime_entries', 'id', { count: 'exact', head: true }).eq('status', 'pending'),
        scopedFrom('hr_tada_claims', 'id', { count: 'exact', head: true }).eq('status', 'pending'),
        // pending_admin only — pending_target is still waiting on the coworker, not a manager action
        scopedFrom('hr_shift_swap_requests', 'id', { count: 'exact', head: true }).eq('status', 'pending_admin'),
      ])
      if (cancelled || results.some(r => r.error || typeof r.count !== 'number')) return
      setHrPending(results.reduce((s, r) => s + r.count, 0))
    }
    load()
    const id = setInterval(load, POLL_MS)
    return () => { cancelled = true; clearInterval(id) }
  }, [clientId, hrVisible, scopedFrom])

  useEffect(() => {
    setPosPending(0); setPosRequests(0); setPosNew(0)
    if (!clientId || !posVisible) return
    let cancelled = false
    async function load() {
      const stamp = readSeenStamp(clientId)
      const [{ data, error: ordersErr }, { count, error: reqErr }, { count: changed, error: newErr }] = await Promise.all([
        scopedFrom('pos_orders', 'id, pos_order_items(sent_to_kot)').eq('status', 'open'),
        scopedFrom('pos_reservations', 'id', { count: 'exact', head: true }).eq('status', 'requested'),
        stamp
          ? scopedFrom('pos_reservations', 'id', { count: 'exact', head: true }).neq('status', 'requested').gt('updated_at', stamp)
          : Promise.resolve({ count: 0, error: null }),
      ])
      if (cancelled) return
      // A failed count keeps the last value — a badge that vanishes on a dropped poll reads as
      // "the request was handled", not as a failed read. posPending too (S798 REPORTS-7).
      if (!ordersErr) setPosPending((data || []).reduce((s, o) => s + (o.pos_order_items || []).filter(i => !i.sent_to_kot).length, 0))
      if (!reqErr) setPosRequests(count || 0)
      if (!newErr) setPosNew(changed || 0)
    }
    load()
    const id = setInterval(load, POLL_MS)
    return () => { cancelled = true; clearInterval(id) }
  }, [clientId, posVisible, scopedFrom])

  return { hrPending, posPending, posRequests, posNew }
}
