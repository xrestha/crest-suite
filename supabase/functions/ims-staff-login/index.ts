import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { derivePinPassword, getAppSecrets } from '../_shared/pinPassword.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Completes IMS stock-count PIN login server-side (S737). Structural mirror of pos-staff-login,
// and it exists in this shape from the start rather than being retrofitted, because both of the
// reasons that function was rewritten for apply here identically:
//
// 1. THE LOCKOUT MUST BE ON THE AUTH PATH. If the browser called check_ims_pin_lock before and
//    record_ims_pin_attempt after, both are simply skippable — and the PIN is four digits. Both
//    run here, on the same request that signs in, and neither RPC is granted to anon or
//    authenticated at all (migration 20260910120000 grants service_role only).
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
    const { data: deviceRow } = await admin
      .from('client_secrets').select('client_id')
      .eq('client_id', client_id).eq('ims_device_secret', device_secret).maybeSingle()
    if (!deviceRow) return json({ error: 'This device is not set up' }, 401)

    // Checked before the sign-in attempt so an already-locked account doesn't burn a real auth
    // attempt. Same ordering as pos-staff-login.
    //
    // Both lockout RPCs FAIL OPEN, deliberately: a null result reads as "not locked" and the login
    // proceeds. Locking every counter out on the night of a stock take because of a transient DB
    // error would be worse than the brute-force risk of one unguarded request. But fail-open must
    // be LOUD, or the lockout can silently stop working while every symptom still looks like a
    // healthy sign-in. These console.error lines are the only thing that would surface it.
    const { data: lockData, error: lockErr } = await admin.rpc('check_ims_pin_lock', { p_staff_id: staff_id })
    if (lockErr) console.error('[ims-staff-login] check_ims_pin_lock FAILED — lockout not enforced on this request:', lockErr.message)
    if (lockData?.[0]?.locked) {
      return json({ error: 'Too many incorrect attempts', locked: true, locked_until: lockData[0].locked_until }, 423)
    }

    // Same filter as get_ims_count_staff — a real PIN account (ims_role AND ims_email both set)
    // belonging to THIS device's client, so a valid device secret for one client cannot be pointed
    // at another client's staff_id.
    const { data: staff } = await admin
      .from('profiles').select('ims_email')
      .eq('id', staff_id).eq('client_id', client_id)
      .not('ims_role', 'is', null).not('ims_email', 'is', null)
      .maybeSingle()

    // Generic message shared with the wrong-PIN path below, and deliberately no recorded attempt:
    // there is no account to lock, and recording one would let anyone drive an arbitrary uuid's
    // counter.
    if (!staff?.ims_email) return json({ error: 'Invalid credentials' }, 401)

    const authClient = createClient(url, anon, { auth: { autoRefreshToken: false, persistSession: false } })

    const { pepper } = await getAppSecrets(admin)
    const derived = await derivePinPassword(staff.ims_email, pin, pepper)
    const { data: signInData } = await authClient.auth.signInWithPassword({
      email: staff.ims_email, password: derived,
    })

    const succeeded = !!signInData?.session
    const { data: attemptData, error: attemptErr } = await admin.rpc('record_ims_pin_attempt', {
      p_staff_id: staff_id, p_success: succeeded,
    })
    // The more dangerous of the two to lose silently: if this stops recording, the counter never
    // advances and NO account can ever lock, however many wrong PINs are tried.
    if (attemptErr) console.error('[ims-staff-login] record_ims_pin_attempt FAILED — this attempt was NOT counted toward lockout:', attemptErr.message)

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
