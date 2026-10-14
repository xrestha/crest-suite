'use strict'
// The three print-device functions (docs/kitchen-printers.md), called as PostgREST RPCs with the
// anon key. Every call has its own 8 s timeout, covering the answer's body as well.

const CALL_TIMEOUT_MS = 8000

class ApiError extends Error {
  /** kind: 'network' (no answer), 'http' (an error status), 'bad_response' (not the JSON we expect). */
  constructor(kind, message, status) {
    super(message)
    this.name = 'ApiError'
    this.kind = kind
    this.status = status
  }
}

// Baked in by build/build.mjs (esbuild define); from source they come from the environment.
/* global __CREST_SUPABASE_URL__, __CREST_SUPABASE_ANON_KEY__ */
const BAKED_URL = typeof __CREST_SUPABASE_URL__ !== 'undefined' ? __CREST_SUPABASE_URL__ : ''
const BAKED_KEY = typeof __CREST_SUPABASE_ANON_KEY__ !== 'undefined' ? __CREST_SUPABASE_ANON_KEY__ : ''

/** Where Crest is: runtime overrides first (for tests), then the build's values. */
function crestEndpoint(env = process.env) {
  const url = env.CREST_SUPABASE_URL || BAKED_URL || env.REACT_APP_SUPABASE_URL || ''
  const key = env.CREST_SUPABASE_ANON_KEY || BAKED_KEY || env.REACT_APP_SUPABASE_ANON_KEY || ''
  return { url: url.replace(/\/+$/, ''), key }
}

function createApi({ url, key, fetchImpl = globalThis.fetch, timeoutMs = CALL_TIMEOUT_MS }) {
  async function rpc(fn, params) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      let res
      try {
        res = await fetchImpl(`${url}/rest/v1/rpc/${fn}`, {
          method: 'POST',
          headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(params),
          signal: ctrl.signal,
        })
      } catch (e) {
        throw new ApiError('network', ctrl.signal.aborted ? `${fn}: no answer in ${timeoutMs / 1000} s` : `${fn}: ${e && e.cause ? e.cause.code || e.cause.message : e.message}`)
      }
      let body
      try {
        body = await res.text()
      } catch (e) {
        throw new ApiError('network', `${fn}: the answer was cut off (${ctrl.signal.aborted ? 'timeout' : e.message})`)
      }
      if (!res.ok) throw new ApiError('http', `${fn}: HTTP ${res.status} ${body.slice(0, 300)}`, res.status)
      let json
      try { json = JSON.parse(body) } catch { throw new ApiError('bad_response', `${fn}: answer is not JSON`, res.status) }
      if (!json || typeof json !== 'object' || Array.isArray(json)) throw new ApiError('bad_response', `${fn}: answer is not an object`, res.status)
      return json
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    pair: (code, info) => rpc('pos_print_device_pair', { p_code: code, p_info: info }),
    poll: (deviceId, secret, info) => rpc('pos_print_device_poll', { p_device_id: deviceId, p_secret: secret, p_info: info }),
    report: (deviceId, secret, printed, failed) => rpc('pos_print_device_report', { p_device_id: deviceId, p_secret: secret, p_printed: printed, p_failed: failed }),
  }
}

module.exports = { createApi, crestEndpoint, ApiError, CALL_TIMEOUT_MS }
