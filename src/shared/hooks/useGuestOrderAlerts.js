import { useState, useEffect, useRef, useCallback } from 'react'
import { useScopedDb } from './useScopedDb'

// How often the whole app asks whether a guest has ordered. 15 s, not the 60 s the rail badges use
// and not the 5 s PosOrders runs on its own floor: this poll runs from EVERY page for every signed-in
// session with POS visible, so it is the one badge query whose cost is paid app-wide — but a guest
// sitting at a table having tapped Send is not a number on a chip, and a minute of silence is the
// bug this exists to fix (S763).
const POLL_MS = 15000

// A guest order that nobody has accepted is food nobody is cooking. The alert therefore re-sounds
// on this cadence for as long as one is pending, rather than chiming once into an empty room.
export const REPEAT_MS = 20000

// Past this, the banner turns red and the chime hardens. Three minutes is the point at which a
// guest who tapped Send has stopped assuming the kitchen has it.
export const ESCALATE_MS = 180000

// Muting silences the sound. It deliberately does NOT hide the banner — the order is still waiting,
// and a control that makes the evidence disappear is how this gets missed a second time.
export const MUTE_MS = 300000

/**
 * Pending guest QR orders, polled app-wide so the alert does not depend on which page is open.
 *
 * Deliberately NOT folded into useNavBadgeCounts: that hook is a 60 s count for a chip, this one
 * needs the rows (table name, how long each has waited) and a quarter of the interval. Merging them
 * would either make the badges four times as chatty or make this alert four times as slow.
 *
 * `enabled` is Layout's own posVisible — POS switched on for this client AND this login able to see
 * it. Note the second gate is enforced under it anyway: pos_guest_order_requests carries the
 * staff-isolation RESTRICTIVE policies, so an IMS- or HR-only staff account reads an empty list
 * rather than being alerted about a table it cannot touch.
 */
export function useGuestOrderAlerts(enabled) {
  const { scopedFrom, clientId } = useScopedDb()
  const [requests, setRequests] = useState([])
  const [mutedUntil, setMutedUntil] = useState(0)
  // Wall clock, ticked once a second while something is pending, so "waiting 2 min" and the
  // escalation threshold move without waiting for the next poll.
  const [now, setNow] = useState(() => Date.now())

  const mute = useCallback(() => setMutedUntil(Date.now() + MUTE_MS), [])

  // Ids already seen, so a poll that comes back identical does not restart anything. A ref, not
  // state: it is read inside the poll that would otherwise depend on it.
  const seenIds = useRef(new Set())

  useEffect(() => {
    if (!clientId || !enabled) {
      setRequests([])
      seenIds.current = new Set()
      return
    }
    let cancelled = false
    async function load() {
      // Guest ordering only ever happens online.
      if (!navigator.onLine) return
      const { data, error } = await scopedFrom(
        'pos_guest_order_requests',
        'id, table_id, created_at, pos_tables(name)',
      ).eq('status', 'pending').order('created_at')
      if (cancelled) return
      // A failed poll keeps the last known list. Writing the empty result would clear the banner
      // and silence the alert, which a reader takes as "someone accepted it" — the one meaning a
      // dropped read must never be allowed to have (CLAUDE.md: a failed poll that writes its empty
      // result blanks live state).
      if (error) { console.error('useGuestOrderAlerts poll failed, keeping the last known requests:', error); return }
      const rows = (data || []).map(r => ({
        id: r.id,
        tableId: r.table_id,
        tableName: r.pos_tables?.name || 'a table',
        createdAt: r.created_at,
      }))
      // Only re-render when the SET of pending ids moved. Every 15 s from every page, and the
      // answer is almost always the same one; a request row is immutable once created (Accept or
      // Dismiss changes its status, which takes it out of this query), so the ids are the state.
      const sig = rows.map(r => r.id).join(',')
      if (sig === [...seenIds.current].join(',')) return
      seenIds.current = new Set(rows.map(r => r.id))
      setRequests(rows)
    }
    load()
    const id = setInterval(load, POLL_MS)
    return () => { cancelled = true; clearInterval(id) }
  }, [clientId, enabled, scopedFrom])

  useEffect(() => {
    if (requests.length === 0) return
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(tick)
  }, [requests.length])

  const oldest = requests.length > 0 ? Math.min(...requests.map(r => new Date(r.createdAt).getTime())) : null
  const waitedMs = oldest == null ? 0 : Math.max(0, now - oldest)

  return {
    requests,
    waitedMs,
    urgent: waitedMs >= ESCALATE_MS,
    muted: mutedUntil > now,
    mute,
  }
}
