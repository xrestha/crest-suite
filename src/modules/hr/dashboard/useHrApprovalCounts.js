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
    ]).then(([{ count: leave }, { count: ot }, { count: tada }, { count: swap }]) => {
      if (loadIdRef.current !== myId) return // superseded by a newer client switch
      const l = leave || 0, o = ot || 0, t = tada || 0, s = swap || 0
      setCounts({ leave: l, ot: o, tada: t, swap: s, total: l + o + t + s })
      setLoading(false)
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId])

  return { ...counts, loading }
}
