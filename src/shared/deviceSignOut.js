// Signing out of THIS device, whatever the network does (S798 SELF-SERVICE-1).
//
// supabase.auth.signOut() sends /logout first, and when that request fails (a weak connection, or
// the 15-second auth cutoff in authFetchTimeout.js) it returns { error } and leaves the stored
// session where it was. Both sign-outs ignored the result, so on a phone two employees share, the
// next person to open Crest Staff landed on the last one's payslips and could file leave in their
// name. A shared till or counting tablet had the same hole through AuthContext.signOut.
import { supabase } from '../supabaseClient'
import { withTimeout } from '../utils/withTimeout'

// How long sign-out waits on the network before this device clears its own session. Shorter than
// the auth client's 15 s: someone handing over a phone does not wait that long, and walking away
// mid-wait is how the session was left behind.
export const SIGN_OUT_WAIT_MS = 6000

// supabase-js keeps the session in localStorage as `sb-<project ref>-auth-token`, with
// `-code-verifier` / `-user` siblings in some versions. Returns how many keys it removed.
export function clearStoredAuthSession(storage = window.localStorage) {
  const keys = []
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i)
    if (k && /^sb-.+-auth-token/.test(k)) keys.push(k)
  }
  keys.forEach(k => storage.removeItem(k))
  return keys.length
}

// True when the library signed out normally. False means the session was cleared by hand: the
// in-memory client still holds it, so the caller must leave with a full page load
// (`window.location.replace`), never a router navigate, or the next screen reads it back.
//
// `scope: 'local'` ends this device's session only (S809 ACCESS-1): /logout?scope=local revokes
// the refresh token of the session this device holds and nothing else. With no scope, supabase-js
// uses its documented default, 'global', which revokes every session of the login, so its phone and
// laptop drop to the sign-in page within the hour. A till lock passes 'local' too (S809 ACCESS-7, owner
// decision Q18 a, Layout.js), so a waiter's other tills stay signed in; a lost tablet is cut off by
// revoking it, which ends the sessions opened on it. The Owner's own Sign out still uses the default.
export async function signOutThisDevice({ scope } = {}) {
  try {
    const request = scope === 'local' ? supabase.auth.signOut({ scope: 'local' }) : supabase.auth.signOut()
    const { error } = await withTimeout(request, SIGN_OUT_WAIT_MS, 'Sign out')
    if (!error) return true
    console.error('Sign-out did not reach the server; clearing this device instead.', error)
  } catch (e) {
    console.error('Sign-out did not finish; clearing this device instead.', e)
  }
  try { clearStoredAuthSession() } catch { /* storage blocked, so nothing was stored to clear */ }
  return false
}
