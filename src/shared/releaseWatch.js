import { useEffect, useRef } from 'react'

// A till takes a new release by itself (S809 slice 1b, GAP-RELEASE-1, owner decision Q27 c).
//
// A till is one long-lived page. The idle lock, a PIN sign-in and the Kitchen Display all move by
// navigate(), never by a page load, so a tablet switched on at 10 am ran the 10 am code until someone
// happened to reload it, while fixes and changed database rules moved on without it. The service
// worker is cache-first, and a CACHE_NAME bump replaces its cache, never the page already running.
//
// So a till screen asks the browser to re-check the worker (registration.update(), which fetches
// /service-worker.js past both the worker and the HTTP cache) when it opens and every 10 minutes while
// it stays open. A bumped CACHE_NAME makes the script differ: the new worker installs, skips waiting
// and claims this page, and `controllerchange` says a release is here. The screen then reloads at its
// next safe moment (the PIN screen, an idle floor, an idle Kitchen Display), never under someone's
// hands.
//
// The database half is pos_till_build_gate (migration 20261009100000). It refuses a bill write from a
// page older than pos_min_till_build(). buildHeaderFetch spots that refusal and calls noteTillTooOld,
// and the till reloads in a few seconds whatever it is doing, because nothing was written. The order
// screen keeps its unsent cart first.

const CHECK_EVERY_MS = 10 * 60 * 1000
const MIN_CHECK_GAP_MS = 60 * 1000
// Long enough to read why the save was refused before the page goes.
export const FORCED_RELOAD_DELAY_MS = 3000
// A floor raised past the build actually deployed would refuse the reloaded page too. One forced
// reload per window, so that mistake shows its message instead of reloading the till in a loop.
const FORCED_KEY = 'crest_release_forced_reload_at'
const FORCED_GAP_MS = 3 * 60 * 1000

const swOn = () =>
  typeof navigator !== 'undefined' && 'serviceWorker' in navigator && process.env.NODE_ENV === 'production'

let started = false
let ready = false
let tooOld = false
let lastInputAt = Date.now()
let lastCheckAt = 0
const listeners = new Set()

function notify() {
  listeners.forEach(fn => {
    try { fn() } catch (e) { console.error('release watch listener failed:', e) }
  })
}

/** Called once at boot (index.js), before the worker registers. */
export function initReleaseWatch() {
  if (started || typeof window === 'undefined') return
  started = true
  const onInput = () => { lastInputAt = Date.now() }
  for (const ev of ['pointerdown', 'keydown', 'touchstart', 'wheel']) {
    window.addEventListener(ev, onInput, { passive: true, capture: true })
  }
  if (!swOn()) return
  // A first visit's worker also claims this page when it activates. That is an install, not a release.
  let hadController = !!navigator.serviceWorker.controller
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) { hadController = true; return }
    ready = true
    notify()
  })
}

/** Asks the browser to re-check the worker. At most once a minute; offline it simply fails. */
export function checkForRelease(now = Date.now()) {
  if (!started || !swOn() || now - lastCheckAt < MIN_CHECK_GAP_MS) return
  lastCheckAt = now
  navigator.serviceWorker.getRegistration()
    .then(reg => reg?.update())
    .catch(() => {})
}

/** The database refused this page as too old (pos_till_build_too_old). */
export function noteTillTooOld() {
  if (tooOld) return
  tooOld = true
  notify()
}

function forcedReloadAllowed(now) {
  try {
    const last = Number(sessionStorage.getItem(FORCED_KEY)) || 0
    if (now - last < FORCED_GAP_MS) return false
    sessionStorage.setItem(FORCED_KEY, String(now))
  } catch (_) {
    // No session storage: allow it. A loop needs a floor set past the deployed build as well.
  }
  return true
}

/**
 * Reloads this till screen for a new release at a safe moment.
 *
 * @param {boolean}  safe          nothing on screen would be lost by a reload now
 * @param {number}   idleMs        how long nobody must have touched the screen first
 * @param {Function} [beforeReload] keeps what a reload would lose (the order screen's unsent cart);
 *                                  may return a promise, which is awaited
 */
export function useReleaseReload(safe, idleMs, beforeReload) {
  const safeRef = useRef(safe)
  const beforeRef = useRef(beforeReload)
  safeRef.current = safe
  beforeRef.current = beforeReload

  useEffect(() => {
    let done = false
    let forcedTimer = null

    const reload = async () => {
      if (done) return
      done = true
      try {
        await beforeRef.current?.()
      } catch (e) {
        console.error('could not keep the screen\'s work before the update; reloading anyway:', e)
      }
      window.location.reload()
    }

    const tick = () => {
      if (done || navigator.onLine === false) return
      if (tooOld) {
        if (!forcedTimer && forcedReloadAllowed(Date.now())) forcedTimer = setTimeout(reload, FORCED_RELOAD_DELAY_MS)
        return
      }
      if (!ready || !safeRef.current) return
      if (Date.now() - lastInputAt < idleMs) return
      if (document.querySelector('[role="dialog"]')) return
      reload()
    }

    listeners.add(tick)
    checkForRelease()
    const poll = setInterval(tick, 5000)
    const check = setInterval(() => checkForRelease(), CHECK_EVERY_MS)
    tick()
    return () => {
      listeners.delete(tick)
      clearInterval(poll)
      clearInterval(check)
      clearTimeout(forcedTimer)
    }
  }, [idleMs])
}
