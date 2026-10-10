import { useState, useEffect, useRef } from 'react'
import { useScopedDb } from './useScopedDb'
import { supabase } from '../../supabaseClient'
import { GUEST_ALERT_MUTE_MS, useGuestAlertMute } from '../guestAlertBridge'

// How often the whole app asks whether a guest has ordered. 15 s, not the 60 s the rail badges use
// and not the 5 s PosOrders runs on its own floor: this poll runs from EVERY page for every signed-in
// session with POS visible, so it is the one badge query whose cost is paid app-wide — but a guest
// sitting at a table having tapped Send is not a number on a chip, and a minute of silence is the
// bug this exists to fix (S763). The PIN screen asks on the same cadence (S809 3c), so a tablet costs
// the same whether it is signed in or locked: it is one or the other, never both.
const POLL_MS = 15000

// A guest order that nobody has accepted is food nobody is cooking. The alert therefore re-sounds
// on this cadence for as long as one is pending, rather than chiming once into an empty room.
export const REPEAT_MS = 20000

// Past this, the banner turns red and the chime hardens. Three minutes is the point at which a
// guest who tapped Send has stopped assuming the kitchen has it.
export const ESCALATE_MS = 180000

// Muting silences the sound. It deliberately does NOT hide the banner — the order is still waiting,
// and a control that makes the evidence disappear is how this gets missed a second time. One Mute
// for every guest-order alert on the device since S809 3c (guestAlertBridge.js).
export const MUTE_MS = GUEST_ALERT_MUTE_MS

const NO_IDS = new Set()

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
 *
 * S809 3c:
 *   `heldIds` — waiting orders this till already holds (accepted into its cart, not saved yet). They
 *   are left out of the list, the wait and the escalation: Accept is the answer, and the request
 *   waits in the database only until the save marks it.
 *   `device` — `{ clientId, deviceId, deviceSecret }` from an activated tablet's storage. The PIN
 *   screen has no signed-in login, so it asks through the tablet's own key
 *   (get_pos_device_guest_alerts) and gets table names and times only. A refused key (revoked in Till
 *   Devices) stops the asking: a revoked tablet announces nothing.
 */
export function useGuestOrderAlerts(enabled, { heldIds = null, device = null } = {}) {
  const { scopedFrom, clientId } = useScopedDb()
  const [requests, setRequests] = useState([])
  const { muted: muteOn, mutedUntil, mute } = useGuestAlertMute()
  // Wall clock, ticked once a second while something is pending, so "waiting 2 min" and the
  // escalation threshold move without waiting for the next poll.
  const [now, setNow] = useState(() => Date.now())

  const devClientId = device?.clientId || null
  const devId = device?.deviceId || null
  const devSecret = device?.deviceSecret || null
  const viaDevice = !!(devClientId && devId && devSecret)
  // A caller that passes `device` never falls back to the session's own read: an incomplete key asks
  // nothing at all.
  const source = device ? (viaDevice ? `device:${devClientId}:${devId}` : null) : clientId

  // Ids already seen, so a poll that comes back identical does not restart anything. A ref, not
  // state: it is read inside the poll that would otherwise depend on it.
  const seenIds = useRef(new Set())

  useEffect(() => {
    if (!source || !enabled) {
      setRequests([])
      seenIds.current = new Set()
      return
    }
    let cancelled = false
    let stopped = false
    // An answer that arrives after a newer one is dropped, so a slow poll cannot put back a list
    // the next poll has already replaced.
    let latest = 0
    async function load() {
      // Guest ordering only ever happens online.
      if (stopped || !navigator.onLine) return
      const mine = ++latest
      const { data, error } = viaDevice
        ? await supabase.rpc('get_pos_device_guest_alerts', {
            p_client_id: devClientId, p_device_id: devId, p_device_secret: devSecret,
          })
        : await scopedFrom(
            'pos_guest_order_requests',
            'id, table_id, created_at, pos_tables(name)',
          ).eq('status', 'pending').order('created_at')
      if (cancelled || mine !== latest) return
      if (error) {
        // The tablet's key was refused: revoked in Till Devices, or never registered. Nothing it
        // could announce is its business any more, and asking every 15 s changes nothing.
        if (viaDevice && String(error.message || '').includes('pos_device_not_active')) {
          stopped = true
          seenIds.current = new Set()
          setRequests([])
          return
        }
        // A failed poll keeps the last known list. Writing the empty result would clear the banner
        // and silence the alert, which a reader takes as "someone accepted it" — the one meaning a
        // dropped read must never be allowed to have (CLAUDE.md: a failed poll that writes its empty
        // result blanks live state).
        console.error('useGuestOrderAlerts poll failed, keeping the last known requests:', error)
        return
      }
      const rows = (data || []).map(r => (viaDevice
        // No request id reaches the PIN screen (it is the guest's tracker key); the table and the
        // time it was sent are the row's identity here, one waiting order per table being the rule.
        ? { id: `${r.table_name || ''}|${r.waiting_since}`, tableId: null, tableName: r.table_name || 'a table', createdAt: r.waiting_since }
        : { id: r.id, tableId: r.table_id, tableName: r.pos_tables?.name || 'a table', createdAt: r.created_at }))
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
  }, [source, enabled, viaDevice, devClientId, devId, devSecret, scopedFrom])

  const held = heldIds && heldIds.size > 0 ? heldIds : NO_IDS
  const waiting = held === NO_IDS ? requests : requests.filter(r => !held.has(r.id))

  useEffect(() => {
    if (waiting.length === 0) return
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(tick)
  }, [waiting.length])

  const oldest = waiting.length > 0 ? Math.min(...waiting.map(r => new Date(r.createdAt).getTime())) : null
  const waitedMs = oldest == null ? 0 : Math.max(0, now - oldest)

  return {
    requests: waiting,
    waitedMs,
    urgent: waitedMs >= ESCALATE_MS,
    muted: muteOn && mutedUntil > now,
    mute,
  }
}
