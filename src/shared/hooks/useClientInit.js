import { useEffect, useRef } from 'react'

// A page's first load: once per outlet, as soon as the sign-in has finished loading (S890).
//
// 26 pages gated their first load by hand, `useEffect(() => { if (!authLoading && effectiveClientId)
// init() }, …)`, in two forms that each broke. ProtectedRoute shows a page while a profile RE-fetch
// runs (AuthContext's `loading` is true again with a profile already in hand: a SIGNED_IN event when
// the tab wakes, an outlet check).
// - Keyed on `[clientId]` (18 pages): a page opened in that moment skipped init, and nothing ran it
//   once loading ended, because clientId had not changed. It sat on its loading skeleton.
// - Keyed on `[clientId, authLoading]` (8 pages): every re-fetch re-ran init, which put the month,
//   year or filters the person had picked back to the defaults.
// So init runs once per outlet (any non-empty key works), and once per `key` for a page that loads
// one record (a bill id). It always calls the init of the latest render.
export function useClientInit(clientId, authLoading, init, key = '') {
  const initRef = useRef(init)
  initRef.current = init
  const doneFor = useRef(null)
  useEffect(() => {
    if (authLoading || !clientId) return
    const token = `${clientId}|${key ?? ''}`
    if (doneFor.current === token) return
    doneFor.current = token
    initRef.current()
  }, [clientId, authLoading, key])
}
