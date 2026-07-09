import { useState, useEffect } from 'react'
import { useScopedDb } from './useScopedDb'

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

  useEffect(() => {
    if (!clientId || !hrVisible) { setHrPending(0); return }
    let cancelled = false
    async function load() {
      const [{ count: leaveCount }, { count: otCount }] = await Promise.all([
        scopedFrom('hr_leave_requests', 'id', { count: 'exact', head: true }).eq('status', 'pending'),
        scopedFrom('hr_overtime_entries', 'id', { count: 'exact', head: true }).eq('status', 'pending'),
      ])
      if (!cancelled) setHrPending((leaveCount || 0) + (otCount || 0))
    }
    load()
    const id = setInterval(load, POLL_MS)
    return () => { cancelled = true; clearInterval(id) }
  }, [clientId, hrVisible, scopedFrom])

  useEffect(() => {
    if (!clientId || !posVisible) { setPosPending(0); return }
    let cancelled = false
    async function load() {
      const { data } = await scopedFrom('pos_orders', 'id, pos_order_items(sent_to_kot)').eq('status', 'open')
      if (cancelled) return
      const total = (data || []).reduce((s, o) => s + (o.pos_order_items || []).filter(i => !i.sent_to_kot).length, 0)
      setPosPending(total)
    }
    load()
    const id = setInterval(load, POLL_MS)
    return () => { cancelled = true; clearInterval(id) }
  }, [clientId, posVisible, scopedFrom])

  return { hrPending, posPending }
}
