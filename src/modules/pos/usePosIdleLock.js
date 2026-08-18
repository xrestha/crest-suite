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
  onWarnRef.current = onWarn
  onLockRef.current = onLock

  useEffect(() => {
    if (!enabled) return

    let countdown = null

    const clearAll = () => {
      clearTimeout(warnRef.current)
      clearTimeout(lockRef.current)
      clearInterval(countdown)
    }

    const reset = () => {
      clearAll()
      onWarnRef.current?.(null)
      warnRef.current = setTimeout(() => {
        let left = Math.round(POS_IDLE_WARN_MS / 1000)
        onWarnRef.current?.(left)
        countdown = setInterval(() => {
          left -= 1
          onWarnRef.current?.(left > 0 ? left : 0)
        }, 1000)
      }, POS_IDLE_LOCK_MS - POS_IDLE_WARN_MS)
      lockRef.current = setTimeout(() => {
        clearAll()
        onLockRef.current?.()
      }, POS_IDLE_LOCK_MS)
    }

    // pointerdown/keydown/touchstart rather than mousemove: a mouse nudged by a passing tray, or
    // a cable brushing a touchscreen, should not count as someone being present. Every one of
    // these requires a deliberate act. `visibilitychange` resets on return so switching to the
    // KOT window and back doesn't burn the timer.
    const EVENTS = ['pointerdown', 'keydown', 'touchstart', 'wheel']
    EVENTS.forEach(e => window.addEventListener(e, reset, { passive: true }))
    const onVisible = () => { if (document.visibilityState === 'visible') reset() }
    document.addEventListener('visibilitychange', onVisible)

    reset()
    return () => {
      clearAll()
      EVENTS.forEach(e => window.removeEventListener(e, reset))
      document.removeEventListener('visibilitychange', onVisible)
      onWarnRef.current?.(null)
    }
  }, [enabled])
}
