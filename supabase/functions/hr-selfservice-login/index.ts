import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

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
// Both RPCs now run HERE, on the service-role client, on the same request that does the sign-in —
// so they cannot be skipped. The frontend no longer calls either one (a second
// record_hr_pin_attempt from the browser would double-count every failure and lock a
// fat-fingered employee out in 3 real attempts instead of 5); it just renders whatever
// locked/locked_until this function returns.
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

    // Checked BEFORE the sign-in attempt so an already-locked account can't burn real auth
    // attempts (and can't be used to keep Supabase's own sign-in rate limit warm).
    const { data: lockData } = await admin.rpc('check_hr_pin_lock', { p_staff_id: staff_id })
    if (lockData?.[0]?.locked) {
      return json({ error: 'Too many incorrect attempts', locked: true, locked_until: lockData[0].locked_until }, 423)
    }

    const { data: profile, error: profileErr } = await admin
      .from('profiles')
      .select('hr_self_service_email')
      .eq('id', staff_id)
      .eq('hr_self_service', true)
      .maybeSingle()

    // Same generic message for "no such staff_id" and "wrong pin" below (an invalid staff_id is
    // not itself sensitive here, but there's no reason to let a caller distinguish the two paths
    // via response shape/timing either). Deliberately does NOT record a failed attempt — there is
    // no account to lock, and doing so would let anyone lock an arbitrary uuid's counter.
    if (profileErr || !profile?.hr_self_service_email) {
      return json({ error: 'Invalid credentials' }, 401)
    }

    // The actual auth check runs through the normal anon-keyed path — identical to what the
    // browser used to do directly with signInWithPassword, just relocated here so the email
    // argument never has to travel to the client first.
    const authClient = createClient(url, anon, { auth: { autoRefreshToken: false, persistSession: false } })
    const { data: signInData, error: signInErr } = await authClient.auth.signInWithPassword({
      email: profile.hr_self_service_email,
      password: pin,
    })

    const succeeded = !signInErr && !!signInData?.session
    const { data: attemptData } = await admin.rpc('record_hr_pin_attempt', {
      p_staff_id: staff_id, p_success: succeeded,
    })

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
