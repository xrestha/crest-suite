// ════════════════════════════════════════════════════════════════════════════════════════════
// Shared password helpers for the PIN-backed account types (POS staff, HR Self-Service).
//
// ── Why this file exists ────────────────────────────────────────────────────────────────────
// Until now the PIN *was* the Supabase Auth password: create_pos_staff and
// create_hr_self_service_login both called createUser({ password: pin }) with a raw 4-6 digit
// string. Two independent problems came out of that, and this module fixes both at once.
//
// 1. BRUTE FORCE AROUND THE LOCKOUT. pos-staff-login's own header comment already names it:
//    "anyone holding a pos_email could call supabase.auth.signInWithPassword() directly in a
//    loop and walk the 4-digit keyspace with the lockout never firing". S531 moved the lockout
//    server-side and S532 revoked the leftover grants, but neither closed this, because the
//    attack does not go through our Edge Functions at all — it goes straight at GoTrue's
//    /token endpoint with the anon key, where our lockout RPCs are simply not on the path.
//    Hiding pos_email (20260810180000) raised the cost of *starting* but changed nothing about
//    the mechanism.
//
//    A peppered derivation ends it structurally. The stored password is now
//    HMAC-SHA256(PIN_PEPPER, "<email>:<pin>") — so an attacker who has the email and guesses
//    the correct PIN still cannot produce the string GoTrue wants, because PIN_PEPPER never
//    leaves the Edge Function environment. Direct signInWithPassword brute force stops being
//    possible rather than merely being throttled, and the ONLY route to a session is through
//    pos-staff-login / hr-selfservice-login, which do enforce the lockout.
//
// 2. LEAKED PASSWORD PROTECTION. Supabase's HIBP check (Auth -> Password settings) cannot be
//    turned on while PINs are raw passwords: every one of the 10,000 four-digit strings is in
//    the Pwned Passwords corpus, as is effectively every six-digit numeric. Verified against
//    the GoTrue source, the breakage is asymmetric and therefore confusing rather than obvious:
//    adminUserCreate does NOT call checkPasswordStrength (so create_pos_staff keeps working)
//    while adminUserUpdate DOES (so reset_pos_pin fails on every possible PIN). A derived
//    password is 43 chars of base64url and passes trivially, which is what makes enabling the
//    toggle safe.
//
// ── PIN_PEPPER ──────────────────────────────────────────────────────────────────────────────
// Set with:  supabase secrets set PIN_PEPPER="$(openssl rand -base64 48)"
//
// THIS SECRET IS NOT RECOVERABLE AND NOT ROTATABLE IN PLACE. Every PIN account's stored
// password is derived from it, and the PINs themselves are not stored anywhere, so there is
// nothing to re-derive from. Losing or changing it means every POS and Self-Service account
// must have its PIN reset by hand. Back it up wherever the VAPID private key is kept.
//
// derivePinPassword() throws rather than falling back when it is missing. That is deliberate
// and fail-CLOSED, which is the opposite of the lockout RPCs' documented fail-open stance --
// the reasoning differs because the failure modes differ. A silent fallback to the raw PIN
// would write a brute-forceable password to a real account and look completely healthy while
// doing it; an outright throw breaks login loudly and immediately, which gets noticed and
// fixed in minutes. Never "helpfully" catch this and retry with the bare pin.
// ════════════════════════════════════════════════════════════════════════════════════════════

const encoder = new TextEncoder()

/**
 * Deterministic auth password for a PIN account.
 *
 * Salted with the account's own generated email so the same PIN on two accounts never yields
 * the same password, and keyed with PIN_PEPPER so the result is not computable off-server.
 * Both callers have the email: it is generated alongside the account at creation, and resolved
 * from profiles.pos_email / profiles.hr_self_service_email at login.
 *
 * Output is 43 chars of base64url — comfortably under bcrypt's 72-byte truncation point, so
 * the whole value contributes to the hash.
 */
export async function derivePinPassword(email: string, pin: string): Promise<string> {
  const pepper = Deno.env.get('PIN_PEPPER')
  if (!pepper) {
    throw new Error(
      'PIN_PEPPER is not set. PIN account passwords cannot be derived. ' +
      'Run: supabase secrets set PIN_PEPPER="$(openssl rand -base64 48)"',
    )
  }

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(pepper),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(`${email}:${pin}`))

  // base64url, unpadded — avoids any downstream quoting/encoding surprises that '+' and '/'
  // can cause in transit, and keeps the value URL-safe if it is ever logged or diffed.
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * HaveIBeenPwned k-anonymity lookup.
 *
 * Needed because Supabase's own leaked-password protection does NOT apply here: GoTrue's
 * adminUserCreate never calls checkPasswordStrength, so every account this project creates
 * through auth.admin.createUser() — including register_trial, the public signup form and the
 * single most important password in the app — bypasses the dashboard toggle entirely. The
 * toggle covers adminUserUpdate and the user-facing /user endpoint (so ResetPassword.js and
 * the IMS/HR password resets are genuinely covered by it); this function covers the hole it
 * structurally cannot reach.
 *
 * Only the first 5 hex chars of the SHA-1 travel to the API, which returns every suffix
 * sharing that prefix for us to match locally — the password, the full hash, and the identity
 * of the user all stay here.
 *
 * NOTE ON CSP: this runs in Deno on the server, so vercel.json's `connect-src` allow-list does
 * not apply and needs no new entry. That rule binds browser fetches only. Adding this same
 * check to any *frontend* path WOULD require adding api.pwnedpasswords.com there, or it fails
 * silently in production while working fine in dev (see CLAUDE.md).
 *
 * @returns true = breached, false = clean, null = check could not be completed.
 */
export async function isPasswordPwned(password: string): Promise<boolean | null> {
  try {
    const digest = await crypto.subtle.digest('SHA-1', encoder.encode(password))
    const hash = Array.from(new Uint8Array(digest))
      .map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase()

    const prefix = hash.slice(0, 5)
    const suffix = hash.slice(5)

    const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      // Add-Padding makes every response a uniform size, so the length of the reply can't be
      // used to narrow down which prefix was queried. Padded filler rows carry count 0, which
      // is why the match below tests the count rather than just the suffix.
      headers: { 'Add-Padding': 'true', 'User-Agent': 'crest-suite-auth' },
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return null

    for (const line of (await res.text()).split('\n')) {
      const [suf, count] = line.trim().split(':')
      if (suf === suffix && Number(count) > 0) return true
    }
    return false
  } catch {
    // Network failure, DNS, timeout. Returning null lets the caller decide; every caller in
    // this project treats null as fail-open-but-logged, matching the lockout RPCs' stance --
    // a HIBP outage should not take the signup form down.
    return null
  }
}
