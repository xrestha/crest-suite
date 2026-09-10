import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'

// Pending-approval counts (Leave/OT/TADA/Swap) — extracted from HrDashboard.jsx's own Approvals
// KPI row so both the real HR console and the lighter dashboard-column summary read the exact
// same numbers via one query, rather than two independently-drifting copies. head:true skips
// fetching rows entirely (this is a count only, never a preview list — HrDashboard.jsx's own
// capped-at-8 preview queries stay local to that page, they're a different, heavier concern).
export function useHrApprovalCounts() {
  const { clientId } = useAuth()
  const { scopedFrom } = useScopedDb()
  const [counts, setCounts] = useState({ leave: 0, ot: 0, tada: 0, swap: 0, total: 0 })
  const [loading, setLoading] = useState(true)
  // A FAILED READ IS NOT AN EMPTY QUEUE (S734). Every one of these four destructured `{ count }`
  // and discarded `{ error }`, and on a refusal or a dropped connection `count` comes back null —
  // which fell through `|| 0` into a zero. Both consumers then painted that zero as the GOOD
  // state: HrDashboard's four cards read "0 · all clear" in green, and ClientDashboard's Pending
  // Approvals headline read 0 in neutral text. So the one failure mode where a manager most needs
  // to look at the queue is the one that told them there was nothing in it. Carried out to the
  // callers rather than swallowed here, because only they can decide how to say so.
  const [error, setError] = useState(false)
  const loadIdRef = useRef(0)

  useEffect(() => {
    if (!clientId) { setLoading(false); return }
    const myId = ++loadIdRef.current
    setLoading(true)
    Promise.all([
      scopedFrom('hr_leave_requests', 'id', { count: 'exact', head: true }).eq('status', 'pending'),
      scopedFrom('hr_overtime_entries', 'id', { count: 'exact', head: true }).eq('status', 'pending'),
      scopedFrom('hr_tada_claims', 'id', { count: 'exact', head: true }).eq('status', 'pending'),
      // Only pending_admin needs a manager action — pending_target is still waiting on the
      // coworker's own accept/decline, same filter SwapRequestsPanel.jsx uses.
      scopedFrom('hr_shift_swap_requests', 'id', { count: 'exact', head: true }).eq('status', 'pending_admin'),
    ]).then(results => {
      if (loadIdRef.current !== myId) return // superseded by a newer client switch
      const [{ count: leave }, { count: ot }, { count: tada }, { count: swap }] = results
      const failed = results.some(r => r.error)
      if (failed) console.error('HR approval counts failed to load', results.find(r => r.error).error)
      const l = leave || 0, o = ot || 0, t = tada || 0, s = swap || 0
      setError(failed)
      setCounts({ leave: l, ot: o, tada: t, swap: s, total: l + o + t + s })
      setLoading(false)
    }, err => {
      // supabase-js resolves with { data, error } rather than throwing, so this only fires on a
      // genuine rejection — but without it `loading` would stay true forever and both consumers
      // would sit on a skeleton with no way out.
      if (loadIdRef.current !== myId) return
      console.error('HR approval counts failed to load', err)
      setError(true)
      setLoading(false)
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId])

  return { ...counts, loading, error }
}
