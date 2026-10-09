import { APP_VERSION } from '../shared/appVersion'
import { noteTillTooOld } from '../shared/releaseWatch'

// Every call to the database carries the build this tab runs (S809 slice 1b, GAP-RELEASE-1), so a
// migration can refuse a page too old for the rules it writes under instead of letting it write
// under them: pos_till_build_gate (20261009100000) reads this header against pos_min_till_build().
//
// Only /rest/v1/. Auth, Storage and the Edge Functions each answer CORS for themselves, and an Edge
// Function's corsHeaders list refuses the preflight for any header it does not name, so a header on
// those calls would break them. The REST gateway allows it (preflight checked 2026-10-09).
//
// A Request object passes through untouched: fetch(request, { headers }) would REPLACE its headers.
// supabase-js hands PostgREST a URL string.

export const BUILD_HEADER = 'x-crest-build'
export const TILL_TOO_OLD_CODE = 'pos_till_build_too_old'
const REST_PATH = '/rest/v1/'

function withHeader(headers, name, value) {
  if (headers && typeof headers.set === 'function' && typeof headers.forEach === 'function') {
    const out = new headers.constructor(headers)
    out.set(name, value)
    return out
  }
  if (Array.isArray(headers)) return [...headers.filter(([k]) => String(k).toLowerCase() !== name), [name, value]]
  return { ...(headers || {}), [name]: value }
}

export function makeBuildHeaderFetch(baseFetch, build = APP_VERSION, onTooOld = noteTillTooOld) {
  return function buildHeaderFetch(input, init = {}) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : null
    if (!url || !url.includes(REST_PATH)) return baseFetch(input, init)

    return baseFetch(input, { ...init, headers: withHeader(init.headers, BUILD_HEADER, build) }).then(res => {
      // The gate raises before any write, as a 400. Read a copy, so the caller's body is untouched.
      if (res && res.status >= 400 && res.status < 500 && typeof res.clone === 'function') {
        res.clone().text().then(body => {
          if (String(body).includes(TILL_TOO_OLD_CODE)) onTooOld()
        }, () => {})
      }
      return res
    })
  }
}
