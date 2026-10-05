import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { derivePinPassword, getAppSecrets } from '../_shared/pinPassword.ts'
import { releasePinAttempt, signInVerdict } from '../_shared/pinSignIn.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Completes IMS stock-count PIN login server-side (S737). Structural mirror of pos-staff-login,
// and it exists in this shape from the start rather than being retrofitted, because both of the
// reasons that function was rewritten for apply here identically:
//
// 1. THE LOCKOUT MUST BE ON THE AUTH PATH. If the browser called check_ims_pin_lock before and
//    record_ims_pin_attempt after, both are simply skippable — and the PIN is four digits. The
//    lockout runs here, on the same request that signs in, and none of its RPCs is granted to
//    anon or authenticated at all (service_role only).
//
//    And it counts the attempt BEFORE the sign-in (S791). Check-then-record let every request of a
//    parallel burst pass the check before the 5th failure was recorded, so a burst got as many
//    guesses as it had requests in flight (found in hss-suite, batch 4 re-analysis #37,
//    docs/CROSS-REPO.md there). The order is now
//
//      device gate → look up the account → reserve_ims_pin_attempt → signInWithPassword
//                                                                  → record_ims_pin_attempt(true)
//
//    reserve_ims_pin_attempt (migration 20260928120000) counts the attempt as a FAILURE up front,
//    in one UPDATE that refuses while the account is locked; the row lock makes concurrent
//    reservations queue, so the 6th request of a burst finds the lock the 5th set and never signs
//    in. A correct PIN resets through record_ims_pin_attempt(true); a wrong one needs no second
//    write. The reservation FAILS CLOSED with a 503, except on PGRST202 (deployed ahead of the
//    migration), which falls back to the old check-then-record path so counting tablets keep
//    working.
//
// 2. ims_email NEVER REACHES THE BROWSER. get_ims_count_staff returns id, name and job title —
//    enough to draw a tile, nothing that logs anyone in. The synthetic email is resolved here with
//    the service role and is never echoed back in any response.
//
// The password is HMAC(pepper, "<email>:<pin>"), derived by the shared helper — never the raw PIN.
// That is what makes hammering GoTrue's /token endpoint directly useless: an attacker holding the
// email and guessing the right PIN still cannot construct the string GoTrue expects, so every path
// to a session runs through here, where the lockout is enforced.
//
// verify_jwt is off for this function (supabase/config.toml) — it runs BEFORE authentication, so
// the caller has no session to present. What authenticates the caller is the per-client device
// secret, verified below against client_secrets.ims_device_secret exactly as get_ims_count_staff
// does. That secret reaches a tablet only by redeeming a short-lived enrolment token off the QR a
// manager displays in Stock Count -> Settings.
//
// 3. ONLY AN ANSWER ABOUT THE PIN STAYS COUNTED (S798, SELF-SERVICE-6). The sign-in error used to
//    be dropped, so a 429 or 5xx from GoTrue stayed counted as a wrong PIN; five locked out a
//    counter typing the correct one. The password is now derived before the reservation (no
//    pepper → 503, nothing counted), and _shared/pinSignIn.ts's signInVerdict keeps the attempt
//    counted only for invalid_credentials / user_banned. Anything else gives it back
//    (release_ims_pin_attempt, migration 20261005140000) and answers 503. The catch-all sends fixed
//    text, never err.message.
const ERR_UNAVAILABLE ='Sign-in is unavailable right now. Try again in a minute.'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })

  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  try {
    const { client_id, device_secret, staff_id, pin } = await req.json()
    if (!client_id || !device_secret || !staff_id || !pin) {
      return json({ error: 'client_id, device_secret, staff_id and pin are required' }, 400)
    }

    const url  = Deno.env.get('SUPABASE_URL')!
    const anon = Deno.env.get('SUPABASE_ANON_KEY')!
    const svc  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

    // Service-role client only to verify the device and resolve staff_id -> ims_email. Neither the
    // secret nor the email is ever echoed back to the caller in any response.
    const admin = createClient(url, svc, { auth: { autoRefreshToken: false, persistSession: false } })

    // Device gate first — an unenrolled or forged device gets nothing, not even a lock-state
    // oracle. The secret lives in the admin-only client_secrets table, never on the clients row
    // where every staff account of the client could read it.
    //
    // The read's `error` is checked (S792, MASTER-7). Dropped, a database blip returned 401 "not set
    // up", and ImsCountLogin answers exactly that by erasing the tablet's own setup — so a storekeeper
    // mid-count needed a manager to show the QR again. A read that did not happen is a 503, which the
    // tablet treats as "couldn't reach the server" and keeps its key (pos-staff-login's shape).
    const { data: deviceRow, error: deviceErr } = await admin
      .from('client_secrets').select('client_id')
      .eq('client_id', client_id).eq('ims_device_secret', device_secret).maybeSingle()
    if (deviceErr) {
      console.error('[ims-staff-login] device check FAILED — refusing the sign-in:', deviceErr.code, deviceErr.message)
      return json({ error: ERR_UNAVAILABLE }, 503)
    }
    if (!deviceRow) return json({ error: 'This device is not set up' }, 401)

    // Same filter as get_ims_count_staff — a real PIN account (ims_role AND ims_email both set)
    // belonging to THIS device's client, so a valid device secret for one client cannot be pointed
    // at another client's staff_id.
    const { data: staff, error: staffErr } = await admin
      .from('profiles').select('ims_email')
      .eq('id', staff_id).eq('client_id', client_id)
      .not('ims_role', 'is', null).not('ims_email', 'is', null)
      // A leaver whose Final Settlement blocked their logins is off the picker (S756, as S754 did
      // for POS) and must not sign in by a remembered staff_id either.
      .is('settlement_blocked_by', null)
      .maybeSingle()

    // Generic message shared with the wrong-PIN path below, and deliberately no counted attempt (this
    // returns before the reservation): there is no account to lock, and counting one would let
    // anyone drive an arbitrary uuid's counter.
    // A failed read is not a wrong PIN (S792): saying "Invalid credentials" sent the counter
    // re-typing a correct PIN into a server that could not answer.
    if (staffErr) {
      console.error('[ims-staff-login] staff lookup FAILED — refusing the sign-in:', staffErr.code, staffErr.message)
      return json({ error: ERR_UNAVAILABLE }, 503)
    }
    if (!staff?.ims_email) return json({ error: 'Invalid credentials' }, 401)

    // Derived BEFORE the reservation (S798, header point 3): an unreadable pepper is the server's
    // fault, so it must not cost the counter an attempt.
    let derived: string
    try {
      const { pepper } = await getAppSecrets(admin)
      derived = await derivePinPassword(staff.ims_email, pin, pepper)
    } catch (e) {
      console.error('[ims-staff-login] could not derive the PIN password — refusing the sign-in, nothing counted:', e instanceof Error ? e.message : e)
      return json({ error: ERR_UNAVAILABLE }, 503)
    }

    // Reserve the attempt BEFORE signing in (S791, header point 1). A locked account is refused here
    // without burning a real auth attempt, as the old check did.
    const lockedResponse = (lockedUntil: string | null) =>
      json({ error: 'Too many incorrect attempts', locked: true, locked_until: lockedUntil }, 423)
    let reserved = true              // false only on the PGRST202 fallback (check-then-record)
    let reservationLockedUntil: string | null = null
    const { data: resData, error: resErr } = await admin.rpc('reserve_ims_pin_attempt', { p_staff_id: staff_id })
    if (resErr) {
      if (resErr.code !== 'PGRST202') {
        console.error('[ims-staff-login] reserve_ims_pin_attempt FAILED — refusing the sign-in:', resErr.code, resErr.message)
        return json({ error: ERR_UNAVAILABLE }, 503)
      }
      // The pre-S791 path, kept only for a deploy that ran ahead of 20260928120000. Its check fails
      // OPEN, as it always did, and loudly: this line is the only thing that would surface it.
      console.error('[ims-staff-login] reserve_ims_pin_attempt missing — migration 20260928120000 not applied; using the pre-S791 check-then-record lockout')
      reserved = false
      const { data: lockData, error: lockErr } = await admin.rpc('check_ims_pin_lock', { p_staff_id: staff_id })
      if (lockErr) console.error('[ims-staff-login] check_ims_pin_lock FAILED — lockout not enforced on this request:', lockErr.message)
      if (lockData?.[0]?.locked) return lockedResponse(lockData[0].locked_until)
    } else {
      const r = Array.isArray(resData) ? resData[0] : resData
      if (r?.outcome === 'locked') return lockedResponse(r.locked_until ?? null)
      // The account stopped being a count PIN login between the lookup and here.
      if (r?.outcome === 'reject') return json({ error: 'Invalid credentials' }, 401)
      if (r?.outcome !== 'reserved') {
        console.error('[ims-staff-login] reserve_ims_pin_attempt returned no outcome — refusing the sign-in:', JSON.stringify(resData))
        return json({ error: ERR_UNAVAILABLE }, 503)
      }
      // Set only when THIS attempt locked the account (it was the 5th).
      reservationLockedUntil = r.locked_until ?? null
    }

    const authClient = createClient(url, anon, { auth: { autoRefreshToken: false, persistSession: false } })

    const { data: signInData, error: signInErr } = await authClient.auth.signInWithPassword({
      email: staff.ims_email, password: derived,
    })

    const verdict = signInVerdict(signInData, signInErr)

    // GoTrue never judged the PIN (S798, header point 3): give the attempt back and say the server
    // could not be reached. On the PGRST202 fallback nothing was counted yet, so nothing to give back.
    if (verdict.kind === 'unavailable') {
      console.error('[ims-staff-login] sign-in got no answer about the PIN — giving the attempt back:', verdict.detail)
      if (reserved) await releasePinAttempt(admin, 'ims', staff_id, reservationLockedUntil, 'ims-staff-login')
      return json({ error: ERR_UNAVAILABLE }, 503)
    }

    if (verdict.kind === 'refused') {
      let after: { locked?: boolean, locked_until?: string | null } | undefined
      if (reserved) {
        // Counted by the reservation already, so no second write here.
        after = { locked: !!reservationLockedUntil, locked_until: reservationLockedUntil }
      } else {
        const { data: attemptData, error: attemptErr } = await admin.rpc('record_ims_pin_attempt', {
          p_staff_id: staff_id, p_success: false,
        })
        // The more dangerous of the two to lose silently: if this stops recording, the counter never
        // advances and NO account can ever lock, however many wrong PINs are tried.
        if (attemptErr) console.error('[ims-staff-login] record_ims_pin_attempt FAILED — this attempt was NOT counted toward lockout:', attemptErr.message)
        after = attemptData?.[0]
      }
      return json({
        error: after?.locked ? 'Too many incorrect attempts' : 'Invalid credentials',
        locked: !!after?.locked,
        locked_until: after?.locked_until ?? null,
      }, after?.locked ? 423 : 401)
    }

    // A correct PIN resets the counter (and any lock this very attempt's reservation set). Fails
    // open: the counter is signed in either way, and the log line is what would surface it.
    const { error: resetErr } = await admin.rpc('record_ims_pin_attempt', { p_staff_id: staff_id, p_success: true })
    if (resetErr) console.error(`[ims-staff-login] record_ims_pin_attempt(success) FAILED — the failed-attempt counter was not reset${reserved ? ' and this sign-in still counts as a failure' : ''}:`, resetErr.message)

    return json({
      access_token: signInData.session!.access_token,
      refresh_token: signInData.session!.refresh_token,
    })
  } catch (err) {
    // Fixed text (S798): the message is for the log, never for a caller holding only a device key.
    console.error('[ims-staff-login] unexpected error:', err instanceof Error ? err.message : err)
    return json({ error: ERR_UNAVAILABLE }, 500)
  }
})
