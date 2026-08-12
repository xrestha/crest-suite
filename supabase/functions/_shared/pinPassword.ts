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
// ── Where the pepper lives, and why it is no longer a thing you can lose ────────────────────
// It is a column in the admin-only `app_secrets` singleton (migration 20260812110000), generated
// by the database itself, NOT an Edge Function env var. There is no `supabase secrets set` step
// and nothing to copy into a password manager -- the project's normal Supabase backups cover it.
//
// The first draft of this file did use an env secret and warned that it was neither recoverable
// nor rotatable in place: PINs were stored nowhere, so losing it meant hand-resetting every POS
// and Self-Service account across every client. That was correct and it was unacceptable, which
// is what `staff_pin_vault` (same migration) exists to fix. With the plaintext PINs recoverable,
// a lost or rotated pepper is a bulk re-derivation (admin-user-ops' `rederive_pin_passwords`)
// rather than a mass reset -- so the pepper IS now rotatable in place.
//
// Storing it in the database does not weaken it against the attack it exists to stop: that
// attacker holds only the anon key, and app_secrets has no anon grant. See getAppSecrets() below.
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
export async function derivePinPassword(email: string, pin: string, pepper: string): Promise<string> {
  if (!pepper) {
    // Fail CLOSED. A silent fallback to the raw PIN would write a brute-forceable password to a
    // real account and look completely healthy doing it; a throw breaks login loudly and gets
    // fixed in minutes. Never "helpfully" catch this and retry with the bare pin.
    throw new Error('No PIN pepper available - refusing to derive a PIN account password')
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

// ── App secrets ─────────────────────────────────────────────────────────────────────────────
// Both the pepper and the vault key live in the admin-only `app_secrets` singleton
// (20260812110000) rather than in Edge Function env vars. A vault encrypted with a key you must
// not lose merely renames the problem, so neither is something a human has to back up: the
// project's normal Supabase backups cover both.
//
// This does not weaken the pepper against the attack it exists to stop. That attacker holds only
// the anon key, and app_secrets has no anon grant - so the pepper is still uncomputable
// off-server and direct /token brute force is still impossible. It is reachable only by someone
// who already has an admin session or the service-role key, who could call reset_pos_pin anyway.
//
// Cached in module scope so it costs one query per warm instance rather than one per login --
// but with a SHORT TTL rather than forever, and that TTL is load-bearing. `rederive_pin_passwords`
// can rotate the pepper, and every other warm Edge Function instance (pos-staff-login,
// hr-selfservice-login) holds its own independent copy of this cache. Caching indefinitely would
// leave those instances deriving with the old pepper until they happened to recycle, so a
// rotation would break logins for an unbounded and unpredictable stretch. 60s bounds that to a
// minute. Do not raise it without re-reading this.
const SECRETS_TTL_MS = 60_000
let cachedSecrets: { pepper: string; vaultKey: string } | null = null
let cachedAt = 0

/** Drops the cache immediately. Called by rederive_pin_passwords in the instance doing the rotation. */
export function resetAppSecretsCache(): void {
  cachedSecrets = null
  cachedAt = 0
}

export async function getAppSecrets(
  admin: { from: (t: string) => any },
): Promise<{ pepper: string; vaultKey: string }> {
  if (cachedSecrets && Date.now() - cachedAt < SECRETS_TTL_MS) return cachedSecrets

  // Env override exists only so an environment that already deployed S538's
  // `supabase secrets set PIN_PEPPER` keeps deriving the same passwords for accounts created
  // under it. The intended end state is NOT to set it at all and let the DB value be canonical.
  // If it is ever unset after accounts exist under it, that is exactly the scenario
  // rederive_pin_passwords handles - the vault makes it recoverable instead of terminal.
  const envPepper = Deno.env.get('PIN_PEPPER') || ''

  const { data, error } = await admin
    .from('app_secrets').select('pin_pepper, pin_vault_key').eq('id', 1).maybeSingle()

  if (error || !data) {
    if (envPepper) {
      console.error('[pinPassword] app_secrets unreadable, falling back to PIN_PEPPER env:', error?.message)
      return { pepper: envPepper, vaultKey: '' }
    }
    throw new Error(
      'app_secrets is unreadable and no PIN_PEPPER env fallback is set - ' +
      'PIN account passwords cannot be derived. Has migration 20260812110000 been applied?',
    )
  }

  cachedSecrets = { pepper: envPepper || data.pin_pepper, vaultKey: data.pin_vault_key }
  cachedAt = Date.now()
  return cachedSecrets
}

// ── PIN vault encryption ────────────────────────────────────────────────────────────────────
// AES-GCM via WebCrypto rather than pgcrypto, so the key never has to be passed into SQL where
// it could end up in a query log. The 12-byte IV is random per write and prepended to the
// ciphertext, so re-encrypting the same PIN twice never produces the same string.

// SHA-256 of the stored secret, so the column's textual format is completely decoupled from
// AES-256's hard 32-byte key-size requirement. Importing the raw text would make the two
// coupled and brittle: app_secrets.pin_vault_key is 64 hex chars, which base64-decodes to 48
// bytes, which importKey rejects outright -- and because every vault write is best-effort
// (logged, never fatal), that would have surfaced as PINs silently not being stored while
// everything looked healthy. Hashing removes the class of bug, not just this instance.
async function importVaultKey(keySecret: string, usage: KeyUsage[]): Promise<CryptoKey> {
  if (!keySecret) throw new Error('No PIN vault key available')
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(keySecret))
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, usage)
}

export async function encryptPin(pin: string, keyB64: string): Promise<string> {
  const key = await importVaultKey(keyB64, ['encrypt'])
  const iv  = crypto.getRandomValues(new Uint8Array(12))
  const ct  = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(pin))

  const out = new Uint8Array(iv.length + ct.byteLength)
  out.set(iv, 0)
  out.set(new Uint8Array(ct), iv.length)
  return btoa(String.fromCharCode(...out))
}

export async function decryptPin(cipherB64: string, keyB64: string): Promise<string> {
  const key = await importVaultKey(keyB64, ['decrypt'])
  const raw = Uint8Array.from(atob(cipherB64), c => c.charCodeAt(0))
  const pt  = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: raw.slice(0, 12) }, key, raw.slice(12),
  )
  return new TextDecoder().decode(pt)
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
