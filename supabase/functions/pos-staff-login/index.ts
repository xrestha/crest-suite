import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

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
// authenticates the caller here is the per-client device secret, verified server-side below
// against client_secrets.pos_device_secret exactly as get_pos_staff does.
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

    // Service-role client only to verify the device and resolve staff_id -> pos_email. Neither the
    // secret nor the email is ever echoed back to the caller in any response.
    const admin = createClient(url, svc, { auth: { autoRefreshToken: false, persistSession: false } })

    // Device gate first — an unactivated/forged device gets nothing, not even a lock-state oracle.
    // The secret lives in the admin-only client_secrets table (migration 20260810140000), not on
    // the clients row, where every staff account of the client could read it.
    const { data: deviceRow } = await admin
      .from('client_secrets').select('client_id')
      .eq('client_id', client_id).eq('pos_device_secret', device_secret).maybeSingle()
    if (!deviceRow) return json({ error: 'This device is not activated' }, 401)

    // Checked before the sign-in attempt so an already-locked account doesn't burn a real auth
    // attempt. Same ordering as hr-selfservice-login.
    //
    // Both lockout RPCs FAIL OPEN, deliberately: a null result reads as "not locked" and the login
    // proceeds. Locking every staff member out of a live restaurant floor because of a transient DB
    // error would be worse than the brute-force risk of one unguarded request. But fail-open must be
    // LOUD, or the lockout can silently stop working and every symptom still looks like a normal,
    // healthy sign-in — which is the exact failure the whole server-side move was meant to end.
    // These console.error lines are the only thing that would surface it, in the function logs.
    const { data: lockData, error: lockErr } = await admin.rpc('check_pos_pin_lock', { p_staff_id: staff_id })
    if (lockErr) console.error('[pos-staff-login] check_pos_pin_lock FAILED — lockout not enforced on this request:', lockErr.message)
    if (lockData?.[0]?.locked) {
      return json({ error: 'Too many incorrect attempts', locked: true, locked_until: lockData[0].locked_until }, 423)
    }

    // Same filter as get_pos_staff — a real PIN account (pos_role AND pos_email both set) that
    // belongs to THIS device's client, so a valid device secret for one client can't be pointed at
    // another client's staff_id.
    const { data: staff } = await admin
      .from('profiles').select('pos_email')
      .eq('id', staff_id).eq('client_id', client_id)
      .not('pos_role', 'is', null).not('pos_email', 'is', null)
      .maybeSingle()

    // Generic message shared with the wrong-PIN path below, and deliberately no recorded attempt:
    // there is no account to lock, and recording one would let anyone drive an arbitrary uuid's
    // counter.
    if (!staff?.pos_email) return json({ error: 'Invalid credentials' }, 401)

    const authClient = createClient(url, anon, { auth: { autoRefreshToken: false, persistSession: false } })
    const { data: signInData, error: signInErr } = await authClient.auth.signInWithPassword({
      email: staff.pos_email,
      password: pin,
    })

    const succeeded = !signInErr && !!signInData?.session
    const { data: attemptData, error: attemptErr } = await admin.rpc('record_pos_pin_attempt', {
      p_staff_id: staff_id, p_success: succeeded,
    })
    // The more dangerous of the two to lose silently: if this stops recording, the counter never
    // advances and NO account can ever lock, however many wrong PINs are tried.
    if (attemptErr) console.error('[pos-staff-login] record_pos_pin_attempt FAILED — this attempt was NOT counted toward lockout:', attemptErr.message)

    if (!succeeded) {
      const after = attemptData?.[0]
      return json({
        error: after?.locked ? 'Too many incorrect attempts' : 'Invalid credentials',
        locked: !!after?.locked,
        locked_until: after?.locked_until ?? null,
      }, after?.locked ? 423 : 401)
    }

    return json({
      access_token: signInData.session.access_token,
      refresh_token: signInData.session.refresh_token,
    })
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'Unexpected error' }, 500)
  }
})
