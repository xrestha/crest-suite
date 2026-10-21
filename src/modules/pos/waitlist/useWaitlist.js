import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'
import { setIfChanged, rowsSignature } from '../../../shared/setIfChanged'
import {
  loadLiveWaitlist, liveEntries, addWaitlistEntry, notifyWaitlistEntry, markWaitlistLeft,
  cancelWaitlistEntry, markWaitlistSeated,
} from './waitlistApi'

// The floor polls the waitlist this often while the screen is visible (S854).
export const WAITLIST_POLL_MS = 30000
// The panel re-renders this often so "waited 23 of 30 min" moves and a row turns amber within
// 15 seconds of running over. It lives in the PANEL (useWaitClock), never in useWaitlist: the hook
// is mounted by the floor, the largest component in the product, and a per-minute state there
// would re-render the whole floor all service for a number only the open panel shows.
export const WAIT_TICK_MS = 15000

// Every field the button and the panel draw. A field left out here is a row that never repaints
// (setIfChanged.js), so add it when the panel starts showing one.
const ENTRY_FIELDS = ['id', 'customer_name', 'phone', 'party_size', 'quoted_minutes', 'status', 'notified_at', 'notes', 'created_at']
const entriesSig = rows => rowsSignature(rows, ENTRY_FIELDS)
const errorSig = e => (e ? `${e.code || ''}|${e.message || ''}` : '')

/**
 * The outlet's live waitlist for the floor: this service day's parties still waiting or told.
 *
 *   const waitlist = useWaitlist({ enabled: posEnabled && view === 'floor' })
 *   waitlist.liveCount  // the number on the "Waitlist (n)" button
 *
 * Polls every 30 s while `enabled` and the document is visible, and once more as it comes back
 * into view. A failed poll keeps the last good list and sets `error` (a failed read is not an empty
 * list); `loading` is true only until the first answer. Overlapping reads cannot land out of order
 * (useLatestRequest), and every action re-reads afterwards, which also retires any poll that
 * started before the write.
 *
 * Actions resolve `{ error, ... }` and never throw: `add(draft, { id })` → `{ error, row, duplicate }`,
 * `notify(entry)` / `markLeft(entry)` / `cancel(entry)` → `{ error, count, row }` (count 0: another
 * device moved the party first), `markSeated(entryId, orderId)` → markWaitlistSeated's answer.
 */
export function useWaitlist({ enabled = true, pollMs = WAITLIST_POLL_MS } = {}) {
  const db = useScopedDb()
  const { clientId } = db
  const req = useLatestRequest()
  const seq = useRef(0)
  const [entries, setEntries] = useState([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState(null)
  const live = !!enabled && !!clientId

  // Another outlet's list is not this one's: a switch starts from empty, not from the last outlet.
  useEffect(() => {
    setEntries(prev => (prev.length ? [] : prev))
    setLoaded(false)
    setError(null)
  }, [clientId])

  const refresh = useCallback(async () => {
    if (!enabled || !clientId) return { error: null }
    // A counter, not a period id: every read is the same question, so the newest one asked wins.
    const key = req.begin(`${clientId}:${++seq.current}`)
    let res
    try {
      res = await loadLiveWaitlist(db)
    } catch (err) {
      res = { data: null, error: err }
    }
    if (!req.isCurrent(key)) return { error: res.error || null, stale: true }
    if (res.error) {
      // Keep the last good list: a dropped read is not "nobody is waiting".
      console.error('waitlist: read failed, keeping the last list:', res.error)
      setIfChanged(setError, res.error, errorSig)
      return { error: res.error }
    }
    setIfChanged(setEntries, liveEntries(res.data), entriesSig)
    setError(null)
    setLoaded(true)
    return { error: null }
  }, [enabled, clientId, db, req])

  useEffect(() => {
    if (!live) return undefined
    const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden'
    const tick = () => { if (visible()) void refresh() }
    tick()
    const id = setInterval(tick, pollMs)
    const onVisibility = () => { if (visible()) void refresh() }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [live, refresh, pollMs])

  const add = useCallback(async (draft, opts) => {
    const res = await addWaitlistEntry(db, draft, opts)
    if (res.error) return res
    if (res.row) setEntries(prev => liveEntries([...prev.filter(e => e.id !== res.row.id), res.row]))
    void refresh()
    return res
  }, [db, refresh])

  const notify = useCallback(async entry => {
    if (!entry || entry.status !== 'waiting') return { error: null, count: 0, row: null, skipped: true }
    const res = await notifyWaitlistEntry(db, entry.id)
    if (res.error) return res
    if (res.row) setEntries(prev => liveEntries(prev.map(e => (e.id === res.row.id ? res.row : e))))
    void refresh()
    return res
  }, [db, refresh])

  const closeWith = useCallback(async (entry, write) => {
    const res = await write(db, entry.id)
    if (res.error) return res
    if (res.count > 0) setEntries(prev => prev.filter(e => e.id !== entry.id))
    void refresh()
    return res
  }, [db, refresh])

  const markLeft = useCallback(entry => closeWith(entry, markWaitlistLeft), [closeWith])
  const cancel = useCallback(entry => closeWith(entry, cancelWaitlistEntry), [closeWith])

  const markSeated = useCallback(async (entryId, orderId, opts) => {
    const res = await markWaitlistSeated(db, entryId, orderId, opts)
    if (res.error) return res
    if (res.count > 0) setEntries(prev => prev.filter(e => e.id !== entryId))
    void refresh()
    return res
  }, [db, refresh])

  const loading = live && !loaded && !error

  return useMemo(() => ({
    entries, liveCount: entries.length, loading, loaded, error,
    refresh, add, notify, markLeft, cancel, markSeated,
  }), [entries, loading, loaded, error, refresh, add, notify, markLeft, cancel, markSeated])
}

/** Now, as a number that moves every `everyMs` while `active` (the open panel). */
export function useWaitClock(active = true, everyMs = WAIT_TICK_MS) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return undefined
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(id)
  }, [active, everyMs])
  return now
}
