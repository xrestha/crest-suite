import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { derivePinPassword, getAppSecrets } from '../_shared/pinPassword.ts'
import { releasePinAttempt, signInVerdict } from '../_shared/pinSignIn.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Completes POS staff PIN login server-side. Structural mirror of hr-selfservice-login, added by
// the 2026-08-10 security review for the same two reasons, both of which applied to POS as well:
//
// 1. THE LOCKOUT WAS ADVISORY. PosLogin.jsx called check_pos_pin_lock before signing in and
//    record_pos_pin_attempt after, and nothing on the server consulted or incremented either.
//    Since the PIN literally IS the Supabase Auth password, anyone holding a pos_email could call
//    supabase.auth.signInWithPassword() directly in a loop and walk the 4-digit keyspace with the
//    lockout never firing — the two RPCs are simply not on that path. 20260707240000's own comment
//    presents that lockout as *the* mitigation for PIN-as-password, which is what made the gap
//    matter rather than just being untidy.
//
// 2. pos_email SHOULD NEVER HAVE REACHED THE BROWSER. It was returned by get_pos_staff purely so
//    the frontend could pass it into signInWithPassword. Now that the sign-in happens here, it
//    doesn't need to leave the server at all, and the companion migration
//    (20260810180000_retire_pos_email_and_secret_columns.sql) drops the column from that function's
//    return — exactly the fix S464 applied to get_hr_self_service_staff for the same reason.
//    That also defuses the downstream half of the pos_device_secret exposure: clients_select lets
//    any staff account of the client read clients.pos_device_secret, so "attacker has the device
//    secret" is a realistic starting point, and the secret alone no longer yields a set of working
//    login identifiers.
//
// verify_jwt is off for this function (supabase/config.toml) — it runs BEFORE authentication, so
// the caller has no session to present, same as pos-payment-webhook and billing-export. What
// authenticates the caller here is the tablet's device key, verified server-side below.
//
// ONE KIND OF DEVICE KEY (S754, migration 20260916120000): { device_id, device_secret }, a key per
// tablet, issued by register_pos_device and checked by verify_pos_device against pos_devices (hash
// only, not revoked, same client). A revoked tablet stops at this gate on its very next sign-in.
// The client's shared key from before S754 ({ device_secret } alone) was switched off at every client
// (S809 1j) and its branch, with the PGRST202 fallback that let this function run ahead of
// 20260916120000, is gone (S809 3h): a request with no device_id gets the dead-key 401, the same
// string as a revoked key, because which half failed is not something to tell a caller holding a key
// that does not work.
//
// EACH SESSION IS RECORDED AGAINST ITS TABLET (S809 3h, ACCESS-7, owner decision Q18 a). A till lock
// now ends only that tablet's session (scope 'local'), so the old global sign-out no longer cuts off
// a lost tablet's session as a side effect. Instead pos_record_device_session (20261010180000, service
// role only) files the new session's id under the tablet that opened it, and revoke_pos_device ends
// those sessions. The record is made BEFORE the tokens leave this function and FAILS CLOSED: a
// session that cannot be recorded is never handed out (a 503, attempt given back), and one the tablet
// was revoked under in the meantime is ended by the function itself (the dead-key 401).
//
// A LOGIN THAT IS SWITCHED OFF GETS ITS OWN ANSWER (S809 3h). A login POS Staff blocked
// (pos_blocked_at, S809 3i) or a leaver's after Final Settlement (settlement_blocked_by) is off the
// till's picker, but a till that read the list before the block still shows the name. It used to get
// "Invalid credentials" (read as a wrong PIN) and each try counted toward the lockout. Now it gets a
// 403 with switched_off, before the PIN is judged or anything is counted.
//
// THE LOCKOUT COUNTS THE ATTEMPT BEFORE THE SIGN-IN (S791). Point 1 above moved check_pos_pin_lock
// and record_pos_pin_attempt here, but as check-then-record: every request of a parallel burst
// passed the check before the 5th failure was recorded, so a burst got as many guesses as it had
// requests in flight (found in hss-suite, batch 4 re-analysis #37, docs/CROSS-REPO.md there). The
// order is now
//
//   device gate → look up the account → reserve_pos_pin_attempt → signInWithPassword
//                                                               → record_pos_pin_attempt(true)
//
// reserve_pos_pin_attempt (migration 20260928120000) counts the attempt as a FAILURE up front, in
// one UPDATE that refuses while the account is locked; the row lock makes concurrent reservations
// queue, so the 6th request of a burst finds the lock the 5th set and never signs in. A correct PIN
// resets through record_pos_pin_attempt(true); a wrong one needs no second write. The reservation
// FAILS CLOSED with a 503, like the device gate, except on PGRST202 (deployed ahead of the
// migration), which falls back to the old check-then-record path so tills keep working.
//
// ONLY AN ANSWER ABOUT THE PIN STAYS COUNTED (S798, SELF-SERVICE-6). The sign-in error used to be
// dropped, so a 429 or 5xx from GoTrue at a busy shift change stayed counted as a wrong PIN and said
// "Incorrect PIN"; five locked out a waiter typing the correct one. The password is now derived
// before the reservation (no pepper → 503, nothing counted), and _shared/pinSignIn.ts's
// signInVerdict keeps the attempt counted only for invalid_credentials / user_banned. Anything else
// gives it back (release_pos_pin_attempt, migration 20261005140000) and answers 503. A failed staff
// lookup is a 503 too, and the catch-all sends fixed text, never err.message.
const ERR_DEVICE ='This device is not activated'
const ERR_UNAVAILABLE = 'Sign-in is unavailable right now. Try again in a minute.'
// Worded to read inside a crest-v427 till's fallback, "Couldn't sign in (…). Ask your manager."
const ERR_SWITCHED_OFF = 'This login is switched off'

// The id of the session an access token belongs to: its `session_id` claim, which is auth.sessions.id.
// The token was issued to this function a moment ago by GoTrue, so it is read, not verified.
function sessionIdOf(accessToken: string): string | null {
  try {
    const part = accessToken.split('.')[1] ?? ''
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=')
    const claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))))
    return typeof claims?.session_id === 'string' && claims.session_id ? claims.session_id : null
  } catch {
    return null
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })

  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  try {
    const { client_id, device_id, device_secret, staff_id, pin } = await req.json()
    if (!client_id || !device_secret || !staff_id || !pin) {
      return json({ error: 'client_id, device_secret, staff_id and pin are required' }, 400)
    }

    const url  = Deno.env.get('SUPABASE_URL')!
    const anon = Deno.env.get('SUPABASE_ANON_KEY')!
    const svc  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

    // Service-role client only to verify the device and resolve staff_id -> pos_email. Neither the
    // secret nor the email is ever echoed back to the caller in any response.
    const admin = createClient(url, svc, { auth: { autoRefreshToken: false, persistSession: false } })

    // Device gate first — an unactivated, revoked or forged device gets nothing, not even a
    // lock-state oracle. The check is one UPDATE inside the database (match + stamp last use),
    // service_role-only, so the definition of "a live key" exists once, beside get_pos_device_staff.
    // No device_id: a tablet still on the pre-S754 shared key, which is off everywhere (header).
    //
    // FAILS CLOSED, as the lockout reservation below does: a read error here is a refusal, because
    // the alternative is signing a PIN in on a device nobody has verified. But it is a 503, not the
    // 401: PosLogin reads a 5xx as "couldn't reach the server" and keeps the PIN, where the 401
    // would tell the floor the till needs re-activating over what may be a transient blip.
    if (!device_id) return json({ error: ERR_DEVICE }, 401)
    const { data: ok, error: devErr } = await admin.rpc('verify_pos_device', {
      p_client_id: client_id, p_device_id: device_id, p_device_secret: String(device_secret),
    })
    if (devErr) {
      console.error('[pos-staff-login] verify_pos_device FAILED — refusing the device:', devErr.code, devErr.message)
      return json({ error: 'Could not verify this device' }, 503)
    }
    if (ok !== true) return json({ error: ERR_DEVICE }, 401)

    // Same filter as get_pos_device_staff — a real PIN account (pos_role AND pos_email both set) that
    // belongs to THIS device's client, so a valid device secret for one client can't be pointed at
    // another client's staff_id. The two block markers are read so a switched-off login gets its own
    // answer below rather than looking absent.
    const { data: staff, error: staffErr } = await admin
      .from('profiles').select('pos_email, pos_blocked_at, settlement_blocked_by')
      .eq('id', staff_id).eq('client_id', client_id)
      .not('pos_role', 'is', null).not('pos_email', 'is', null)
      .maybeSingle()

    // Generic message shared with the wrong-PIN path below, and deliberately no counted attempt (this
    // returns before the reservation): there is no account to lock, and counting one would let
    // anyone drive an arbitrary uuid's counter.
    // A failed read is not a wrong PIN (S798, as ims-staff-login since S792): PosLogin reads the 503
    // as "couldn't reach the server" and keeps the PIN.
    if (staffErr) {
      console.error('[pos-staff-login] staff lookup FAILED — refusing the sign-in:', staffErr.code, staffErr.message)
      return json({ error: ERR_UNAVAILABLE }, 503)
    }
    if (!staff?.pos_email) return json({ error: 'Invalid credentials' }, 401)

    // Switched off (header): answered before the PIN is judged, and before the reservation, so the
    // try is not counted. GoTrue would refuse it anyway (both blocks ban the auth user).
    if (staff.pos_blocked_at || staff.settlement_blocked_by) {
      return json({ error: ERR_SWITCHED_OFF, switched_off: true }, 403)
    }

    // The PIN is no longer the password — the stored value is HMAC(PIN_PEPPER, email + ':' + pin).
    // That is what finally closes the hole described in point 1 of this file's header: an attacker
    // who has the email and guesses the right PIN still cannot construct the string GoTrue expects,
    // so hammering /token directly with the anon key is no longer a route to a session at all.
    // Every path to a POS session now runs through this function, where the lockout is enforced.
    //
    // Derived BEFORE the reservation (S798): an unreadable pepper is the server's fault, so it must
    // not cost the waiter an attempt.
    let derived: string
    try {
      const { pepper } = await getAppSecrets(admin)
      derived = await derivePinPassword(staff.pos_email, pin, pepper)
    } catch (e) {
      console.error('[pos-staff-login] could not derive the PIN password — refusing the sign-in, nothing counted:', e instanceof Error ? e.message : e)
      return json({ error: ERR_UNAVAILABLE }, 503)
    }

    // Reserve the attempt BEFORE signing in (S791, header). A locked account is refused here without
    // burning a real auth attempt, as the old check did.
    const lockedResponse = (lockedUntil: string | null) =>
      json({ error: 'Too many incorrect attempts', locked: true, locked_until: lockedUntil }, 423)
    let reserved = true              // false only on the PGRST202 fallback (check-then-record)
    let reservationLockedUntil: string | null = null
    const { data: resData, error: resErr } = await admin.rpc('reserve_pos_pin_attempt', { p_staff_id: staff_id })
    if (resErr) {
      if (resErr.code !== 'PGRST202') {
        console.error('[pos-staff-login] reserve_pos_pin_attempt FAILED — refusing the sign-in:', resErr.code, resErr.message)
        return json({ error: ERR_UNAVAILABLE }, 503)
      }
      // The pre-S791 path, kept only for a deploy that ran ahead of 20260928120000. Its check fails
      // OPEN, as it always did, and loudly: this line is the only thing that would surface it.
      console.error('[pos-staff-login] reserve_pos_pin_attempt missing — migration 20260928120000 not applied; using the pre-S791 check-then-record lockout')
      reserved = false
      const { data: lockData, error: lockErr } = await admin.rpc('check_pos_pin_lock', { p_staff_id: staff_id })
      if (lockErr) console.error('[pos-staff-login] check_pos_pin_lock FAILED — lockout not enforced on this request:', lockErr.message)
      if (lockData?.[0]?.locked) return lockedResponse(lockData[0].locked_until)
    } else {
      const r = Array.isArray(resData) ? resData[0] : resData
      if (r?.outcome === 'locked') return lockedResponse(r.locked_until ?? null)
      // The account stopped being a POS PIN login between the lookup and here.
      if (r?.outcome === 'reject') return json({ error: 'Invalid credentials' }, 401)
      if (r?.outcome !== 'reserved') {
        console.error('[pos-staff-login] reserve_pos_pin_attempt returned no outcome — refusing the sign-in:', JSON.stringify(resData))
        return json({ error: ERR_UNAVAILABLE }, 503)
      }
      // Set only when THIS attempt locked the account (it was the 5th).
      reservationLockedUntil = r.locked_until ?? null
    }

    const authClient = createClient(url, anon, { auth: { autoRefreshToken: false, persistSession: false } })

    const { data: signInData, error: signInErr } = await authClient.auth.signInWithPassword({
      email: staff.pos_email, password: derived,
    })
    // The raw-PIN legacy fallback (lazy password upgrade + vault backfill) that used to live here
    // was removed 2026-08-18 (S569) after a live vault-coverage check showed zero accounts left on
    // a raw-PIN password — every remaining account signs in with the derived value only, so the
    // direct-brute-force window that fallback documented is now fully closed.

    const verdict = signInVerdict(signInData, signInErr)

    // GoTrue never judged the PIN (S798, header): give the attempt back and say the server could not
    // be reached. On the PGRST202 fallback nothing was counted yet, so there is nothing to give back.
    if (verdict.kind === 'unavailable') {
      console.error('[pos-staff-login] sign-in got no answer about the PIN — giving the attempt back:', verdict.detail)
      if (reserved) await releasePinAttempt(admin, 'pos', staff_id, reservationLockedUntil, 'pos-staff-login')
      return json({ error: ERR_UNAVAILABLE }, 503)
    }

    if (verdict.kind === 'refused') {
      let after: { locked?: boolean, locked_until?: string | null } | undefined
      if (reserved) {
        // Counted by the reservation already, so no second write here.
        after = { locked: !!reservationLockedUntil, locked_until: reservationLockedUntil }
      } else {
        const { data: attemptData, error: attemptErr } = await admin.rpc('record_pos_pin_attempt', {
          p_staff_id: staff_id, p_success: false,
        })
        // The more dangerous of the two to lose silently: if this stops recording, the counter never
        // advances and NO account can ever lock, however many wrong PINs are tried.
        if (attemptErr) console.error('[pos-staff-login] record_pos_pin_attempt FAILED — this attempt was NOT counted toward lockout:', attemptErr.message)
        after = attemptData?.[0]
      }
      return json({
        error: after?.locked ? 'Too many incorrect attempts' : 'Invalid credentials',
        locked: !!after?.locked,
        locked_until: after?.locked_until ?? null,
      }, after?.locked ? 423 : 401)
    }

    // The new session is filed under this tablet before its tokens leave (header), so revoking the
    // tablet ends it. Fails closed: never hand out a session a revoke could not reach.
    const session = signInData.session!
    const sessionId = sessionIdOf(session.access_token)
    let recorded = false
    let recordFault: string | null = null
    if (!sessionId) {
      recordFault = 'the access token carries no session_id claim'
    } else {
      const { data: rec, error: recErr } = await admin.rpc('pos_record_device_session', {
        p_client_id: client_id, p_device_id: device_id, p_session_id: sessionId,
      })
      if (recErr) recordFault = `${recErr.code ?? '?'}: ${recErr.message}`
      else recorded = rec === true
    }
    if (!recorded) {
      // Not an answer about the PIN either way, so the attempt is given back.
      if (reserved) await releasePinAttempt(admin, 'pos', staff_id, reservationLockedUntil, 'pos-staff-login')
      if (recordFault === null) {
        // false: the tablet was revoked between the gate and now (the function ended the session).
        return json({ error: ERR_DEVICE }, 401)
      }
      console.error('[pos-staff-login] could not file the session under its tablet — not handing it out:', recordFault)
      // Nobody holds its tokens; end it anyway so it does not sit in auth.sessions.
      const { error: outErr } = await admin.auth.admin.signOut(session.access_token, 'local')
      if (outErr) console.error('[pos-staff-login] could not end the unfiled session:', outErr.message)
      return json({ error: ERR_UNAVAILABLE }, 503)
    }

    // A correct PIN resets the counter (and any lock this very attempt's reservation set). Fails
    // open: the waiter is signed in either way, and the log line is what would surface it.
    const { error: resetErr } = await admin.rpc('record_pos_pin_attempt', { p_staff_id: staff_id, p_success: true })
    if (resetErr) console.error(`[pos-staff-login] record_pos_pin_attempt(success) FAILED — the failed-attempt counter was not reset${reserved ? ' and this sign-in still counts as a failure' : ''}:`, resetErr.message)

    return json({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
    })
  } catch (err) {
    // Fixed text (S798): the message is for the log, never for a caller holding only a device key.
    console.error('[pos-staff-login] unexpected error:', err instanceof Error ? err.message : err)
    return json({ error: ERR_UNAVAILABLE }, 500)
  }
})
