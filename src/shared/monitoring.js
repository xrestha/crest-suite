// Crash reports to Sentry (S872, DOCS-REMEDIATION T6 item 2). Before this, a till that threw at 8pm
// on a Friday was found out when the client phoned; AppErrorBoundary told the person in front of the
// screen and nobody else.
//
// Owner decisions (2026-11-03, asked in plain words): Sentry's free plan, errors only. No session
// replay (it records the screen, bills and names included), no tracing (every database address can
// carry a phone number in its query string), no logs, no session pings. So NOTHING leaves the
// browser unless something breaks. Privacy Policy v1.1 lists Sentry as a sub-processor and §4 makes
// two promises this file keeps: a report is not a recording of the screen or of what was typed, and
// email addresses and phone numbers are removed before it leaves the device.
//
// The SDK is a dynamic import after `load`, never part of the main bundle (IMS_TODO PERF-8: the main
// file is already ~1.2 s on Fast 3G). Errors thrown before it arrives wait in a short queue.
//
// The DSN is not a secret: it can only SEND events to this one project, and every browser that loads
// the app can read it. Its host is the only Sentry origin in vercel.json's connect-src; a wildcard
// there would let any Sentry account receive data from our pages (security-headers.md).

import { isChunkLoadError } from './chunkReload'
import { APP_VERSION } from './appVersion'

const DSN = 'https://15a6b38c612d890b9e3d938f49a063e3@o4512367726166016.ingest.de.sentry.io/4512367750283344'

// Errors caught before the SDK has loaded. A crash loop must not grow it without bound.
const EARLY_LIMIT = 10

let sentry = null
let loading = false
let early = []
let identity = null

/** Only the deployed app reports: never `npm start`, never Jest, never a local `serve build`. */
export function monitoringEnabled() {
  if (process.env.NODE_ENV !== 'production') return false
  if (typeof window === 'undefined') return false
  const host = window.location.hostname
  return host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]' && host !== ''
}

// ── Scrubbing ───────────────────────────────────────────────────────────────────────────────────
//
// Pure and exported, so monitoring.test.js holds the privacy promise rather than a read-through.

const JWT_RE = /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g

/**
 * Removes what Privacy §4 says never leaves the device, plus anything credential-shaped. Broad on
 * purpose: a false positive costs a digit in a report, a miss costs a promise. Dates (2083-07-17),
 * amounts and line numbers survive, because a run of seven digits is where a phone or PAN starts.
 */
export function scrubText(text) {
  if (typeof text !== 'string') return text
  return text
    .replace(/[^\s@"'`()<>[\]{},;:]+@[^\s@"'`()<>[\]{},;:]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/\b(pin|password|token|secret|key|bearer)\b\s*[:=]\s*\S+/gi, '$1: [redacted]')
    .replace(JWT_RE, '[redacted]')
    .replace(/\b[A-Za-z0-9+/]{40,}={0,2}/g, '[redacted]')
    .replace(/\b9[678]\d[\s-]?\d{3}[\s-]?\d{4}\b/g, '[phone]')
    .replace(/\b\d{7,}\b/g, '[number]')
}

/** Walks an object's strings through scrubText. Depth-limited: an `extra` is rarely deep. */
function scrubDeep(value, depth = 0) {
  if (typeof value === 'string') return scrubText(value)
  if (!value || typeof value !== 'object' || depth > 4) return value
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, depth + 1))
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubDeep(v, depth + 1)]))
}

/**
 * An address with its query string and fragment removed. PostgREST puts every filter in the query
 * (`?phone=eq.98…`), and a storage path names the file, so a storage URL keeps only its bucket.
 */
export function cleanUrl(url) {
  if (typeof url !== 'string' || !url) return url
  if (/^(data|blob):/i.test(url)) return `${url.slice(0, url.indexOf(':') + 1)}…`
  return url
    .split(/[?#]/)[0]
    .replace(/(\/storage\/v1\/object\/(?:public\/|sign\/|authenticated\/)?[^/]+)\/.+$/, '$1/…')
}

/** The first path segment: `pos`, `hr`, `admin`, `items`. IMS pages sit at the top level. */
export function areaOfPath(path) {
  const first = String(path || '').split('/').filter(Boolean)[0]
  return first || 'home'
}

const KEPT_BREADCRUMBS = new Set(['navigation', 'fetch', 'xhr'])

/**
 * Which steps before a crash travel with it. Pages visited and requests made, by address only (no
 * bodies, no responses). Clicks and console lines never: a click's breadcrumb names the element by
 * its title, which can be a person, and console lines carry whatever the code logged.
 */
export function keepBreadcrumb(crumb) {
  if (!crumb || !KEPT_BREADCRUMBS.has(crumb.category)) return null
  const data = crumb.data || {}
  if (crumb.category === 'navigation') {
    return { ...crumb, data: { from: cleanUrl(data.from), to: cleanUrl(data.to) } }
  }
  return { ...crumb, data: { method: data.method, url: cleanUrl(data.url), status_code: data.status_code } }
}

/** The last look at every event before it is sent. Returns null to drop it. */
export function scrubEvent(event, hint) {
  const values = (event.exception && event.exception.values) || []
  // A stale-deploy chunk failure is a DEPLOY, not a crash, and chunkReload.js already reloads for
  // it (DOCS-REMEDIATION T6): reported, it would be most of the first week's reports.
  if (isChunkLoadError(hint && hint.originalException)) return null
  if (values.some((v) => isChunkLoadError({ name: v.type, message: v.value }))) return null

  const path = typeof window !== 'undefined' ? window.location.pathname : ''
  const ua = event.request && event.request.headers && event.request.headers['User-Agent']
  event.request = {
    url: cleanUrl((event.request && event.request.url) || ''),
    ...(ua ? { headers: { 'User-Agent': ua } } : {}),
  }
  event.user = event.user && event.user.id ? { id: event.user.id } : undefined
  event.tags = { ...(event.tags || {}), area: areaOfPath(path), route: cleanUrl(path) || '/' }
  if (typeof event.message === 'string') event.message = scrubText(event.message)
  for (const v of values) {
    if (v.value) v.value = scrubText(v.value)
    for (const f of (v.stacktrace && v.stacktrace.frames) || []) {
      if (f.filename) f.filename = cleanUrl(f.filename)
    }
  }
  if (event.breadcrumbs) event.breadcrumbs = event.breadcrumbs.map(keepBreadcrumb).filter(Boolean)
  if (event.extra) event.extra = scrubDeep(event.extra)
  return event
}

// ── Who and where ──────────────────────────────────────────────────────────────────────────────

function applyIdentity(S) {
  const id = identity || {}
  // The profile's random id, never an email or a name: enough to count how many people one fault
  // reached, and meaningless outside Crest's own database.
  S.setUser(id.userId ? { id: id.userId } : null)
  S.setTags({
    client_id: id.clientId || 'none',
    role: id.role || 'signed-out',
    pos_role: id.posRole || 'none',
    ims_role: id.imsRole || 'none',
    hr_role: id.hrRole || 'none',
  })
}

/** Called from App.js whenever the signed-in profile or the active outlet changes. */
export function setMonitoringIdentity(next) {
  identity = next
  if (sentry) applyIdentity(sentry)
}

// ── Sending ────────────────────────────────────────────────────────────────────────────────────

function queueEarly(error, componentStack) {
  if (early.length < EARLY_LIMIT) early.push({ error, componentStack })
}

function onEarlyError(e) { queueEarly(e.error || new Error(e.message)) }
function onEarlyRejection(e) { queueEarly(e.reason) }

function send(S, error, componentStack) {
  S.captureException(error, componentStack ? { contexts: { react: { componentStack } } } : undefined)
}

/**
 * A render crash AppErrorBoundary caught. React 19 hands a caught error to the boundary only (it
 * no longer reaches window.onerror), so without this call a page crash would never be reported.
 */
export function reportCrash(error, componentStack) {
  if (!monitoringEnabled() || isChunkLoadError(error)) return
  if (sentry) send(sentry, error, componentStack)
  else queueEarly(error, componentStack)
}

function start(S) {
  S.init({
    dsn: DSN,
    release: APP_VERSION,
    // Vercel exposes VERCEL_ENV to a CRA build as REACT_APP_VERCEL_ENV; a preview deploy says so.
    environment: process.env.REACT_APP_VERCEL_ENV || 'production',
    sendDefaultPii: false,
    sendClientReports: false,
    maxBreadcrumbs: 30,
    integrations: (defaults) => [
      ...defaults.filter((i) => i.name !== 'BrowserSession' && i.name !== 'Breadcrumbs'),
      S.breadcrumbsIntegration({ console: false, dom: false }),
    ],
    // Our own scripts only: a browser extension's error is not ours to fix.
    allowUrls: [window.location.origin],
    ignoreErrors: [/ResizeObserver loop/],
    beforeBreadcrumb: keepBreadcrumb,
    beforeSend: scrubEvent,
  })
  sentry = S
  window.removeEventListener('error', onEarlyError)
  window.removeEventListener('unhandledrejection', onEarlyRejection)
  applyIdentity(S)
  const queued = early
  early = []
  queued.forEach(({ error, componentStack }) => send(S, error, componentStack))
}

function load() {
  if (sentry || loading) return
  loading = true
  import('@sentry/browser')
    .then(start)
    .catch(() => {
      // Offline before the chunk was ever cached. Try again once the device is back online; caught
      // here so chunkReload.js never sees an unhandled rejection and reloads the page for it.
      loading = false
      window.addEventListener('online', load, { once: true })
    })
}

/** Called once from src/index.js, before the first render. */
export function initMonitoring() {
  if (!monitoringEnabled()) return
  window.addEventListener('error', onEarlyError)
  window.addEventListener('unhandledrejection', onEarlyRejection)
  // The after-deploy check: `crestTestCrash()` in the browser console. It throws from a timer in this
  // file, so the report's source is our own script and passes allowUrls; a throw typed straight
  // into the console has no source and is filtered out.
  window.crestTestCrash = () => {
    setTimeout(() => { throw new Error('Crest test crash (deliberate, from crestTestCrash)') })
  }
  if (document.readyState === 'complete') load()
  else window.addEventListener('load', load, { once: true })
}
