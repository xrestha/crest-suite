import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { derivePinPassword, getAppSecrets } from '../_shared/pinPassword.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// The 503 when the attempt cannot be counted. SelfServiceLogin reads any 5xx as "couldn't reach the
// server" and keeps the typed PIN, so this string is for the logs and any other caller.
const ERR_UNAVAILABLE = 'Sign-in is unavailable right now. Try again in a minute.'

// Completes HR Self-Service PIN login without the browser ever holding the account's real
// email. Added 2026-07-28 after a Security Advisor review found get_hr_self_service_staff(...)
// (the pre-login "who are you" picker) returned every enrolled employee's full_name AND
// hr_self_service_email to a fully anonymous caller — the RPC had no auth.uid() check, no
// client match, nothing. That alone would already be a leak, but it's worse here than the
// structurally similar get_pos_staff issue S372 fixed for POS: that one needed a value pulled
// out of a device's localStorage, whereas this client_id comes from a URL an admin hands out
// as a QR code / link to their ENTIRE staff by design (SelfServiceLogin.jsx's own comment) — the
// "secret" is deliberately mass-distributed, so anyone who has ever seen that link, or a
// screenshot/forward of it, could pull every employee's login email with zero auth.
//
// SelfServiceLogin.jsx's picker no longer requests or holds hr_self_service_email at all — the
// staff list (get_hr_self_service_staff) now returns only id + full_name, which is the minimum a
// "tap your name" UI needs and materially less sensitive than a working sign-in identifier.
// Signing in still needs a real email since that's what auth.users actually keys on, but that
// lookup now happens HERE, server-side with the service role, and the email is never
// serialized back to the browser at all — only the resulting session tokens are.
//
// ── PIN lockout moved server-side (2026-08-10 security review) ───────────────────────────────
// It used to live entirely in the browser: SelfServiceLogin.jsx called check_hr_pin_lock before
// this function and record_hr_pin_attempt after it. Nothing on the server consulted or
// incremented either one, so the lockout was advisory — skip the two RPCs and it simply did not
// exist. That mattered more here than anywhere else in the app because every input an attacker
// needs is public by design:
//
//   - get_hr_self_service_staff(client_id) is anon-callable and returns every enrolled
//     employee's staff_id, and
//   - that client_id comes from a URL an admin hands out to their entire staff as a QR code,
//
// so anyone who has ever seen that link could POST { staff_id, pin } straight at this function
// in a loop and walk the whole 4-digit keyspace — 10,000 candidates, lockout never firing,
// because record_hr_pin_attempt was simply never called. Supabase's own [auth.rate_limit] does
// not help: sign-in happens here, so every attempt arrives from this function's egress IP rather
// than the attacker's, and per-IP limits would throttle real staff before the attacker.
//
// Both RPCs moved HERE, on the service-role client, on the same request that does the sign-in —
// so they cannot be skipped. The frontend calls neither (a second record_hr_pin_attempt from the
// browser would double-count every failure and lock a fat-fingered employee out in 3 real attempts
// instead of 5); it just renders whatever locked/locked_until this function returns.
//
// ── The attempt is counted BEFORE the sign-in (S791) ─────────────────────────────────────────────
// Check-then-record still left a gap: every request of a parallel burst passed check_hr_pin_lock
// before the 5th failure was recorded, so a burst got as many guesses as it had requests in flight
// (found in hss-suite, batch 4 re-analysis #37, docs/CROSS-REPO.md there). The order is now
//
//   look up the account → reserve_hr_pin_attempt → signInWithPassword → record_hr_pin_attempt(true)
//
// reserve_hr_pin_attempt (migration 20260928120000) counts the attempt as a FAILURE up front, in one
// UPDATE that refuses while the account is locked. The row lock makes concurrent reservations queue,
// so the 6th request of a burst finds the lock the 5th set and never signs in. A correct PIN resets
// through record_hr_pin_attempt(true); a wrong one needs no second write, it was counted already.
//
// The reservation FAILS CLOSED (503), unlike the fail-open check it replaced: a lockout that lapses
// whenever the database hiccups is the same gap again. The one exception is PGRST202 (the function
// is not in the schema cache, i.e. this deployed ahead of the migration), which falls back to the
// old check-then-record path, so a deploy-order slip does not lock every employee out.
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })

  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  try {
    const { staff_id, pin } = await req.json()
    if (!staff_id || !pin) return json({ error: 'staff_id and pin are required' }, 400)

    const url  = Deno.env.get('SUPABASE_URL')!
    const anon = Deno.env.get('SUPABASE_ANON_KEY')!
    const svc  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

    // Service-role client purely to resolve staff_id -> email server-side. Never exposed to the
    // caller in any response — that's the entire point of moving this step off the browser.
    const admin = createClient(url, svc, { auth: { autoRefreshToken: false, persistSession: false } })

    const { data: profile, error: profileErr } = await admin
      .from('profiles')
      // client_id is selected only so the vault backfill below can stamp it. It is never returned
      // to the caller — this function's response is still tokens or an error, nothing else.
      // hr_employees(access_blocked) is embedded via profiles.hr_employee_id — a dedicated column,
      // independent of hr_employees.status (S561/S562: status also drives Payroll Run/Calculation/
      // Final Settlement's employee pickers, so gating login on status silently dropped a resigned
      // employee from their own final payroll the moment they were deactivated for login purposes;
      // access_blocked is the decoupled fix, toggled only from Employees' bulk Activate/Deactivate).
      .select('hr_self_service_email, client_id, hr_employees(access_blocked)')
      .eq('id', staff_id)
      .eq('hr_self_service', true)
      .maybeSingle()

    // Same generic message for "no such staff_id", "wrong pin" and "access blocked" below (an
    // invalid staff_id is not itself sensitive here, but there's no reason to let a caller
    // distinguish these paths via response shape/timing either). Deliberately does NOT count an
    // attempt for any of these — they return before the reservation below: there is no account to
    // lock, and counting would let anyone lock an arbitrary uuid's counter.
    if (profileErr || !profile?.hr_self_service_email) {
      return json({ error: 'Invalid credentials' }, 401)
    }
    // `!profile.hr_employees` refuses a login whose employee record is gone. profiles.hr_employee_id
    // is ON DELETE SET NULL, so an employee deleted before S748's delete guard left the login with
    // no employee — and `undefined?.access_blocked` is falsy, so that PIN kept signing in to an app
    // with nobody behind it. A login is only as valid as the employee it belongs to.
    if (!profile.hr_employees || profile.hr_employees.access_blocked) {
      return json({ error: 'Invalid credentials' }, 401)
    }

    // Reserve the attempt BEFORE signing in (S791, header). A locked account is refused here without
    // burning a real auth attempt, as the old check did.
    const lockedResponse = (lockedUntil: string | null) =>
      json({ error: 'Too many incorrect attempts', locked: true, locked_until: lockedUntil }, 423)
    let reserved = true              // false only on the PGRST202 fallback (check-then-record)
    let reservationLockedUntil: string | null = null
    const { data: resData, error: resErr } = await admin.rpc('reserve_hr_pin_attempt', { p_staff_id: staff_id })
    if (resErr) {
      if (resErr.code !== 'PGRST202') {
        console.error('[hr-selfservice-login] reserve_hr_pin_attempt FAILED — refusing the sign-in:', resErr.code, resErr.message)
        return json({ error: ERR_UNAVAILABLE }, 503)
      }
      // The pre-S791 path, kept only for a deploy that ran ahead of 20260928120000. Its check fails
      // OPEN, as it always did, and loudly: this line is the only thing that would surface it.
      console.error('[hr-selfservice-login] reserve_hr_pin_attempt missing — migration 20260928120000 not applied; using the pre-S791 check-then-record lockout')
      reserved = false
      const { data: lockData, error: lockErr } = await admin.rpc('check_hr_pin_lock', { p_staff_id: staff_id })
      if (lockErr) console.error('[hr-selfservice-login] check_hr_pin_lock FAILED — lockout not enforced on this request:', lockErr.message)
      if (lockData?.[0]?.locked) return lockedResponse(lockData[0].locked_until)
    } else {
      const r = Array.isArray(resData) ? resData[0] : resData
      if (r?.outcome === 'locked') return lockedResponse(r.locked_until ?? null)
      // The account stopped being a Self-Service login between the lookup and here.
      if (r?.outcome === 'reject') return json({ error: 'Invalid credentials' }, 401)
      if (r?.outcome !== 'reserved') {
        console.error('[hr-selfservice-login] reserve_hr_pin_attempt returned no outcome — refusing the sign-in:', JSON.stringify(resData))
        return json({ error: ERR_UNAVAILABLE }, 503)
      }
      // Set only when THIS attempt locked the account (it was the 5th).
      reservationLockedUntil = r.locked_until ?? null
    }

    // The actual auth check runs through the normal anon-keyed path — identical to what the
    // browser used to do directly with signInWithPassword, just relocated here so the email
    // argument never has to travel to the client first.
    const authClient = createClient(url, anon, { auth: { autoRefreshToken: false, persistSession: false } })

    // The PIN is no longer the stored password — see _shared/pinPassword.ts. This matters more
    // here than anywhere else in the app: the header above notes that Supabase's own rate limits
    // can't help because attempts arrive from this function's egress IP, and that the lockout was
    // therefore the only control. But the lockout only ever governed THIS path — a caller could
    // always skip it by pointing signInWithPassword straight at GoTrue, needing just an email and
    // 10,000 guesses. With a peppered derivation that route stops working entirely, because the
    // password can no longer be computed from the PIN off-server.
    const { pepper } = await getAppSecrets(admin)
    const derived = await derivePinPassword(profile.hr_self_service_email, pin, pepper)
    const { data: signInData } = await authClient.auth.signInWithPassword({
      email: profile.hr_self_service_email, password: derived,
    })
    // The raw-PIN legacy fallback (lazy password upgrade + vault backfill) that used to live here
    // was removed 2026-08-18 (S569) after a live vault-coverage check showed zero accounts left on
    // a raw-PIN password — every remaining account signs in with the derived value only, so the
    // direct-brute-force route this file's header describes is now closed for every account.

    const succeeded = !!signInData?.session

    if (!succeeded) {
      let after: { locked?: boolean, locked_until?: string | null } | undefined
      if (reserved) {
        // Counted by the reservation already, so no second write here.
        after = { locked: !!reservationLockedUntil, locked_until: reservationLockedUntil }
      } else {
        const { data: attemptData, error: attemptErr } = await admin.rpc('record_hr_pin_attempt', {
          p_staff_id: staff_id, p_success: false,
        })
        // The more dangerous of the two to lose silently: if this stops recording, the counter never
        // advances and NO account can ever lock, however many wrong PINs are tried.
        if (attemptErr) console.error('[hr-selfservice-login] record_hr_pin_attempt FAILED — this attempt was NOT counted toward lockout:', attemptErr.message)
        after = attemptData?.[0]
      }
      return json({
        error: after?.locked ? 'Too many incorrect attempts' : 'Invalid credentials',
        locked: !!after?.locked,
        locked_until: after?.locked_until ?? null,
      }, after?.locked ? 423 : 401)
    }

    // A correct PIN resets the counter (and any lock this very attempt's reservation set). Fails
    // open: the employee is signed in either way, and the log line is what would surface it.
    const { error: resetErr } = await admin.rpc('record_hr_pin_attempt', { p_staff_id: staff_id, p_success: true })
    if (resetErr) console.error(`[hr-selfservice-login] record_hr_pin_attempt(success) FAILED — the failed-attempt counter was not reset${reserved ? ' and this sign-in still counts as a failure' : ''}:`, resetErr.message)

    return json({
      access_token: signInData.session.access_token,
      refresh_token: signInData.session.refresh_token,
    })
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'Unexpected error' }, 500)
  }
})
