// Wall-clock guard for any promise — most importantly a Supabase/PostgREST call.
//
// Why this exists rather than just `.abortSignal()` (S453 → S454): supabase-js does NOT hand the
// request straight to fetch. Every call goes through `fetchWithAuth` (node_modules/@supabase/
// supabase-js/src/lib/fetch.ts), which does:
//
//     const accessToken = (await getAccessToken()) ?? supabaseKey   // line 43
//     ...
//     return fetch(input, { ...init, headers })                     // line 70
//
// `getAccessToken()` calls `auth.getSession()`, which can itself hang (a stalled token-refresh
// request, or one of the known GoTrue init/lock deadlocks — see the comment in supabaseClient.js
// about the navigator.locks bug we already work around). When it hangs, line 70 is never reached,
// so the AbortController signal we passed via `.abortSignal()` is attached to nothing and firing
// it does literally nothing. The promise never resolves AND never rejects, so any `finally` that
// resets a "saving" flag never runs and the button stays disabled forever.
//
// A `Promise.race` against a timer is immune to where the hang is, because it doesn't depend on
// the hung promise ever settling. Keep using `.abortSignal()` alongside this — that's still what
// actually cancels a genuinely in-flight fetch; this is the backstop for everything before it.
export function withTimeout(promise, ms = 20000, label = 'Request') {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s — check your connection and try again.`)),
      ms
    )
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}
