import { useEffect, useRef } from 'react'

// Minutes of no input before a POS till locks itself back to the PIN screen.
//
// Chosen for a SHARED till (confirmed with the product owner 2026-08-18): every closed_by,
// sent_by, comped_by and discount_reason attribution in the module — and the whole "By Staff
// Member" table in the Sales Exceptions report — records whoever last typed a PIN. Without a
// lock, that is only as accurate as a habit, so the report that exists to spot an outlier staff
// member is reporting on whoever happened to still be signed in.
//
// Three minutes rather than the 30–60s a bank terminal would use: a waiter legitimately walks
// away from a till mid-service, and locking so aggressively that staff start propping the screen
// awake (or sharing one PIN to avoid the friction) would defeat the point. Long enough not to
// interrupt normal service, short enough that an unattended till isn't open all evening.
export const POS_IDLE_LOCK_MS = 3 * 60 * 1000

// Warn shortly before locking, so a lock is never a surprise mid-task.
export const POS_IDLE_WARN_MS = 20 * 1000

// ── The last real input survives a page load (S809 ACCESS-6) ──────────────────────────────────────
// The idle clock lived only in memory, so any new page load started a fresh period: a tablet left
// signed in at night whose browser was killed, or that restarted, or a till taking a release (S809
// 1b), came back inside the absent waiter's session with three new minutes that every tap renewed.
// Now the time of the last real input is kept on this device beside the session it belongs to, and a
// page load measures from it. A new sign-in is a new session, so it starts a full period.
export const IDLE_INPUT_KEY = 'crest_idle_last_input'

// pointerdown/keydown/touchstart rather than mousemove: see the lock's own listener below.
const INPUT_EVENTS = ['pointerdown', 'keydown', 'touchstart', 'wheel']

/** The session an access token belongs to: its `session_id` claim (auth.sessions.id), or null. */
export function sessionIdFromToken(accessToken) {
  try {
    const part = String(accessToken || '').split('.')[1]
    if (!part) return null
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=')
    const sid = JSON.parse(atob(b64))?.session_id
    return typeof sid === 'string' && sid ? sid : null
  } catch (_) {
    return null
  }
}

/** When this session last had real input on this device (epoch ms), or null if not known here. */
export function readLastInput(sessionKey, storage) {
  if (!sessionKey) return null
  try {
    const v = JSON.parse((storage || window.localStorage).getItem(IDLE_INPUT_KEY) || 'null')
    const at = Number(v?.at)
    return v?.session === sessionKey && Number.isFinite(at) && at > 0 ? at : null
  } catch (_) {
    return null
  }
}

export function writeLastInput(sessionKey, at, storage) {
  if (!sessionKey) return
  // Blocked storage: a page load restarts the period, as it did before.
  try { (storage || window.localStorage).setItem(IDLE_INPUT_KEY, JSON.stringify({ session: sessionKey, at })) } catch (_) { /* see above */ }
}

/**
 * Whether the till idle lock runs for this login, here. One test, read by Layout (which runs the lock)
 * and by the Kitchen Display (which says so).
 *
 * Every input is about the LOGIN's raw columns, never the resolved rank, which is 'manager' for admin
 * and the Owner (S583): `pinStaff` is !!profile.pos_role, `stationTeam` a 'kitchen'/'bar' pos_team.
 * Admin and Owner sessions never lock. The Kitchen Display exemption belongs to a Kitchen or Bar team
 * login only (S809 ACCESS-2, owner decision Q4 a): keyed on the path alone, a Front of House PIN left
 * on the KDS never locked, and the KDS's Exit opened the till as that login.
 *
 * @param {{ pinStaff: boolean, boundTablet: boolean, stationTeam: boolean, path: string }} who
 */
export function posIdleLockApplies({ pinStaff, boundTablet, stationTeam, path }) {
  if (!pinStaff || !boundTablet) return false
  return !(stationTeam && String(path || '').startsWith('/pos/kds'))
}

/**
 * Locks a POS till back to its PIN screen after a period of no input.
 *
 * Deliberately does nothing unless `enabled` — the caller decides, so a Kitchen or Bar team login on
 * the Kitchen Display (a screen meant to stay awake and untouched on a wall) and the PIN screen
 * itself never lock. A Front of House login on the Kitchen Display does (S809 ACCESS-2, Layout.js).
 *
 * Also drives the counting tablet's lock (S792, D39), which passes its own, longer `lockMs`; the
 * mechanics — real input only, idle measured from the last touch across a sleep — are the same.
 *
 * @param {boolean}  enabled
 * @param {Function} onWarn  called with seconds remaining, then null when the user returns
 * @param {Function} onLock  called once when the idle period elapses
 * @param {number}   [lockMs] idle period; the till's POS_IDLE_LOCK_MS by default
 * @param {string}   [sessionKey] the signed-in session's id (sessionIdFromToken). Given, the last real
 *   input is kept on this device, even while the lock is off (a Kitchen login's taps on the KDS), and
 *   a page load measures from it (S809 ACCESS-6). Without it the clock lives in memory, as before.
 */
export function usePosIdleLock(enabled, onWarn, onLock, lockMs = POS_IDLE_LOCK_MS, sessionKey = null) {
  const warnRef = useRef(null)
  const lockRef = useRef(null)
  const onWarnRef = useRef(onWarn)
  const onLockRef = useRef(onLock)
  // When someone last actually touched the till. Only real input moves it — never a tab becoming
  // visible again (S754).
  const lastActivityRef = useRef(Date.now())
  onWarnRef.current = onWarn
  onLockRef.current = onLock

  // S809 ACCESS-6: every real input of this session is noted on the device, whether or not the lock is
  // running, so the period a page load resumes is measured from the last time someone was there.
  useEffect(() => {
    if (!sessionKey) return
    const note = () => writeLastInput(sessionKey, Date.now())
    INPUT_EVENTS.forEach(e => window.addEventListener(e, note, { passive: true }))
    return () => INPUT_EVENTS.forEach(e => window.removeEventListener(e, note))
  }, [sessionKey])

  useEffect(() => {
    if (!enabled) return

    let countdown = null
    let locked = false

    const clearAll = () => {
      clearTimeout(warnRef.current)
      clearTimeout(lockRef.current)
      clearInterval(countdown)
    }

    const lock = () => {
      if (locked) return
      locked = true
      clearAll()
      onLockRef.current?.()
    }

    // Arms the warning and the lock for `remainingMs` from now. The countdown reads a deadline
    // rather than decrementing a counter, so re-arming with less than the full warning window left
    // shows the true seconds remaining.
    const arm = (remainingMs) => {
      clearAll()
      onWarnRef.current?.(null)
      const deadline = Date.now() + remainingMs
      const secsLeft = () => Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
      warnRef.current = setTimeout(() => {
        onWarnRef.current?.(secsLeft())
        countdown = setInterval(() => onWarnRef.current?.(secsLeft()), 1000)
      }, Math.max(0, remainingMs - POS_IDLE_WARN_MS))
      lockRef.current = setTimeout(lock, remainingMs)
    }

    const onActivity = () => {
      if (locked) return
      // S809 ACCESS-2: a touch that arrives after the whole period has passed locks instead of
      // renewing it. While timers are held back (a sleeping machine whose tab never went hidden), the
      // overdue lock can run AFTER the first tap, and that tap used to buy three more minutes: on the
      // Kitchen Display it was the tap on Exit, which opened the till as the absent login.
      if (Date.now() - lastActivityRef.current >= lockMs) { lock(); return }
      lastActivityRef.current = Date.now()
      arm(lockMs)
    }

    // pointerdown/keydown/touchstart rather than mousemove: a mouse nudged by a passing tray, or
    // a cable brushing a touchscreen, should not count as someone being present. Every one of
    // these requires a deliberate act.
    const EVENTS = INPUT_EVENTS
    EVENTS.forEach(e => window.addEventListener(e, onActivity, { passive: true }))

    // S754: returning to the tab used to call a full reset, so a tablet that slept for an hour
    // (timers do not run while it sleeps) handed whoever woke it three more minutes of the absent
    // waiter's session — under that waiter's name on every bill. The idle time is measured from
    // the last real input instead: past the lock period it locks at once, since the grace period
    // was already spent while nobody was there; otherwise only what is left of it is re-armed.
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || locked) return
      const remaining = lockMs - (Date.now() - lastActivityRef.current)
      if (remaining <= 0) lock()
      else arm(remaining)
    }
    document.addEventListener('visibilitychange', onVisible)

    // S809 ACCESS-6: a page load inside a session that already had input here (a killed tab, a
    // restart, a release reload) resumes from that input, the S754 rule across a reload: past the
    // period it locks at once, otherwise only what is left is armed. A new session, or no record of
    // this one, starts a full period from now.
    const now = Date.now()
    const stored = readLastInput(sessionKey)
    lastActivityRef.current = stored != null ? Math.min(stored, now) : now
    if (stored == null) writeLastInput(sessionKey, now)
    const remaining = lockMs - (now - lastActivityRef.current)
    if (remaining <= 0) lock()
    else arm(remaining)
    return () => {
      clearAll()
      EVENTS.forEach(e => window.removeEventListener(e, onActivity))
      document.removeEventListener('visibilitychange', onVisible)
      onWarnRef.current?.(null)
    }
  }, [enabled, lockMs, sessionKey])
}
