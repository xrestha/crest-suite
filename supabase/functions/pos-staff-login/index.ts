import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { derivePinPassword, getAppSecrets } from '../_shared/pinPassword.ts'

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
// TWO KINDS OF DEVICE KEY (S754, migration 20260916120000):
//   * { device_id, device_secret } — a key per tablet, issued by register_pos_device and checked by
//     verify_pos_device against pos_devices (hash only, not revoked, same client). A revoked tablet
//     stops at this gate on its very next sign-in.
//   * { device_secret } alone — the client's shared key from before S754, still accepted so every
//     tablet already on a restaurant floor keeps working the moment this deploys. It stops working
//     when a manager switches it off in POS Setup (retire_pos_legacy_device_key rotates it), and
//     each use stamps client_secrets.pos_legacy_key_last_used_at so POS Setup can show whether any
//     tablet still depends on it. Delete the legacy branch once every client has retired it.
// Both refusals return the SAME 401 string: which half failed is not something to tell a caller
// holding a key that does not work.
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
const ERR_DEVICE = 'This device is not activated'
const ERR_UNAVAILABLE = 'Sign-in is unavailable right now. Try again in a minute.'

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
    // lock-state oracle. Both checks are one UPDATE inside the database (match + stamp last use),
    // service_role-only, so the definition of "a live key" exists once, beside get_pos_device_staff.
    //
    // FAILS CLOSED, as the lockout reservation below does: a read error here is a refusal, because
    // the alternative is signing a PIN in on a device nobody has verified. But it is a 503, not the
    // 401: PosLogin reads a 5xx as "couldn't reach the server" and keeps the PIN, where the 401
    // would tell the floor the till needs re-activating over what may be a transient blip.
    if (device_id) {
      const { data: ok, error: devErr } = await admin.rpc('verify_pos_device', {
        p_client_id: client_id, p_device_id: device_id, p_device_secret: String(device_secret),
      })
      if (devErr) {
        console.error('[pos-staff-login] verify_pos_device FAILED — refusing the device:', devErr.code, devErr.message)
        return json({ error: 'Could not verify this device' }, 503)
      }
      if (ok !== true) return json({ error: ERR_DEVICE }, 401)
    } else {
      const { data: ok, error: legacyErr } = await admin.rpc('verify_pos_legacy_device', {
        p_client_id: client_id, p_device_secret: String(device_secret),
      })
      if (legacyErr) {
        // PGRST202 = the function is not in the schema cache, i.e. this deployed ahead of
        // 20260916120000. Only for that case, fall back to the pre-S754 check so tablets already
        // on the floor are not locked out by a deploy-order slip. Any other error refuses.
        if (legacyErr.code !== 'PGRST202') {
          console.error('[pos-staff-login] verify_pos_legacy_device FAILED — refusing the device:', legacyErr.code, legacyErr.message)
          return json({ error: 'Could not verify this device' }, 503)
        }
        console.error('[pos-staff-login] verify_pos_legacy_device missing — migration 20260916120000 not applied; using the pre-S754 check')
        const { data: deviceRow } = await admin
          .from('client_secrets').select('client_id')
          .eq('client_id', client_id).eq('pos_device_secret', device_secret).maybeSingle()
        if (!deviceRow) return json({ error: ERR_DEVICE }, 401)
      } else if (ok !== true) {
        return json({ error: ERR_DEVICE }, 401)
      }
    }

    // Same filter as get_pos_staff — a real PIN account (pos_role AND pos_email both set) that
    // belongs to THIS device's client, so a valid device secret for one client can't be pointed at
    // another client's staff_id.
    const { data: staff } = await admin
      .from('profiles').select('pos_email')
      .eq('id', staff_id).eq('client_id', client_id)
      .not('pos_role', 'is', null).not('pos_email', 'is', null)
      .maybeSingle()

    // Generic message shared with the wrong-PIN path below, and deliberately no counted attempt (this
    // returns before the reservation): there is no account to lock, and counting one would let
    // anyone drive an arbitrary uuid's counter.
    if (!staff?.pos_email) return json({ error: 'Invalid credentials' }, 401)

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

    // The PIN is no longer the password — the stored value is HMAC(PIN_PEPPER, email + ':' + pin).
    // That is what finally closes the hole described in point 1 of this file's header: an attacker
    // who has the email and guesses the right PIN still cannot construct the string GoTrue expects,
    // so hammering /token directly with the anon key is no longer a route to a session at all.
    // Every path to a POS session now runs through this function, where the lockout is enforced.
    const { pepper } = await getAppSecrets(admin)
    const derived = await derivePinPassword(staff.pos_email, pin, pepper)
    const { data: signInData } = await authClient.auth.signInWithPassword({
      email: staff.pos_email, password: derived,
    })
    // The raw-PIN legacy fallback (lazy password upgrade + vault backfill) that used to live here
    // was removed 2026-08-18 (S569) after a live vault-coverage check showed zero accounts left on
    // a raw-PIN password — every remaining account signs in with the derived value only, so the
    // direct-brute-force window that fallback documented is now fully closed.

    const succeeded = !!signInData?.session

    if (!succeeded) {
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

    // A correct PIN resets the counter (and any lock this very attempt's reservation set). Fails
    // open: the waiter is signed in either way, and the log line is what would surface it.
    const { error: resetErr } = await admin.rpc('record_pos_pin_attempt', { p_staff_id: staff_id, p_success: true })
    if (resetErr) console.error(`[pos-staff-login] record_pos_pin_attempt(success) FAILED — the failed-attempt counter was not reset${reserved ? ' and this sign-in still counts as a failure' : ''}:`, resetErr.message)

    return json({
      access_token: signInData.session.access_token,
      refresh_token: signInData.session.refresh_token,
    })
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'Unexpected error' }, 500)
  }
})
