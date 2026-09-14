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

/**
 * Locks a POS till back to its PIN screen after a period of no input.
 *
 * Deliberately does nothing unless `enabled` — the caller decides, so the Kitchen Display (a
 * screen meant to stay awake and untouched on a wall) and the PIN screen itself never lock.
 *
 * @param {boolean}  enabled
 * @param {Function} onWarn  called with seconds remaining, then null when the user returns
 * @param {Function} onLock  called once when the idle period elapses
 */
export function usePosIdleLock(enabled, onWarn, onLock) {
  const warnRef = useRef(null)
  const lockRef = useRef(null)
  const onWarnRef = useRef(onWarn)
  const onLockRef = useRef(onLock)
  // When someone last actually touched the till. Only real input moves it — never a tab becoming
  // visible again (S754).
  const lastActivityRef = useRef(Date.now())
  onWarnRef.current = onWarn
  onLockRef.current = onLock

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
      lastActivityRef.current = Date.now()
      arm(POS_IDLE_LOCK_MS)
    }

    // pointerdown/keydown/touchstart rather than mousemove: a mouse nudged by a passing tray, or
    // a cable brushing a touchscreen, should not count as someone being present. Every one of
    // these requires a deliberate act.
    const EVENTS = ['pointerdown', 'keydown', 'touchstart', 'wheel']
    EVENTS.forEach(e => window.addEventListener(e, onActivity, { passive: true }))

    // S754: returning to the tab used to call a full reset, so a tablet that slept for an hour
    // (timers do not run while it sleeps) handed whoever woke it three more minutes of the absent
    // waiter's session — under that waiter's name on every bill. The idle time is measured from
    // the last real input instead: past the lock period it locks at once, since the grace period
    // was already spent while nobody was there; otherwise only what is left of it is re-armed.
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || locked) return
      const remaining = POS_IDLE_LOCK_MS - (Date.now() - lastActivityRef.current)
      if (remaining <= 0) lock()
      else arm(remaining)
    }
    document.addEventListener('visibilitychange', onVisible)

    lastActivityRef.current = Date.now()
    arm(POS_IDLE_LOCK_MS)
    return () => {
      clearAll()
      EVENTS.forEach(e => window.removeEventListener(e, onActivity))
      document.removeEventListener('visibilitychange', onVisible)
      onWarnRef.current?.(null)
    }
  }, [enabled])
}
