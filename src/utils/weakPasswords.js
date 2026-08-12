// NIST SP 800-63B-4 (final, July 2025) drops composition rules ("must contain a symbol") in favour
// of length plus screening a chosen password against a blocklist of known-bad values. The full
// version of that control is a breached-password API lookup (HIBP's k-anonymity range endpoint);
// this is deliberately the offline subset of it — no network call on the signup critical path, no
// new `connect-src` origin in vercel.json, nothing to fail silently in production.
//
// It therefore catches the passwords people actually pick under time pressure, not every breached
// one. If a real breach-list lookup is ever added, it belongs *alongside* this, not instead of it:
// this half also catches the context-derived passwords (business name, email local-part) that no
// breach list can know about.

// The one source of truth for the password floor, read by the trial signup form, the password
// reset page and (independently, since it can't import from the bundle) the `register_trial` Edge
// Function. These three used to disagree — the two client-side checks said 6 and the server said
// 8, so a 7-character password passed the form, contradicted its own placeholder, and was rejected
// by the server. 8 is NIST SP 800-63B-4's minimum; the same document recommends 15 for a
// single-factor system, which is a policy decision to make separately from fixing the mismatch.
export const MIN_PASSWORD_LENGTH = 8

// Lowercased. Keep it short and high-yield rather than exhaustive — a long list here is a bundle
// cost on a page that must paint fast, and the top entries cover the overwhelming majority of
// real-world guesses.
const COMMON = new Set([
  '123456', '123456789', '12345678', '1234567890', '1234567', '12345',
  'password', 'password1', 'password123', 'passw0rd', 'p@ssword', 'p@ssw0rd',
  'qwerty', 'qwerty123', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1q2w3e4r', '1qaz2wsx',
  'abc123', 'abcd1234', 'a1b2c3d4', 'iloveyou', 'admin123', 'welcome1', 'welcome123',
  'letmein', 'monkey', 'dragon', 'sunshine', 'princess', 'football', 'baseball',
  'trustno1', 'superman', 'starwars', 'whatever', 'freedom', 'shadow', 'master',
  'administrator', 'restaurant', 'restaurant1', 'restaurant123', 'kitchen1', 'hotel123',
  'nepal123', 'kathmandu', 'kathmandu1', 'namaste123', 'everest123',
])

// "aaaaaaaa", "11111111"
function isSingleRepeatedChar(s) {
  return s.length > 0 && [...s].every(c => c === s[0])
}

// "12345678", "abcdefgh" and their reverses
function isRunOfSequentialChars(s) {
  if (s.length < 4) return false
  let ascending = true
  let descending = true
  for (let i = 1; i < s.length; i++) {
    const step = s.charCodeAt(i) - s.charCodeAt(i - 1)
    if (step !== 1) ascending = false
    if (step !== -1) descending = false
  }
  return ascending || descending
}

/**
 * Screen a chosen password. Returns a user-facing reason string, or null if it passes.
 *
 * `context` carries the values this specific signup already knows about the person — a password
 * that is just the business name is guessable by anyone who can read the sign on the door, which
 * no generic strength meter would flag.
 */
export function weakPasswordReason(password, context = {}) {
  const pw = String(password || '')
  if (!pw) return null  // "required" is a different message, owned by the caller

  const lower = pw.toLowerCase()

  if (COMMON.has(lower)) {
    return 'That password is one of the most commonly used ones. Please choose something harder to guess.'
  }
  if (isSingleRepeatedChar(lower)) {
    return 'That password is the same character repeated. Please choose something harder to guess.'
  }
  if (isRunOfSequentialChars(lower)) {
    return 'That password is a simple sequence. Please choose something harder to guess.'
  }

  // Strip anything that isn't a letter or digit before comparing, so "Sunrise-Cafe-2026" is still
  // recognised as being built out of the business name.
  const squash = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  const squashedPw = squash(pw)

  const emailLocal = String(context.email || '').split('@')[0]
  const derivedFrom = [
    { value: context.businessName, label: 'your business name' },
    { value: emailLocal,           label: 'your email address' },
  ]

  for (const { value, label } of derivedFrom) {
    const squashedValue = squash(value)
    // Only meaningful for a value long enough to carry information — a 3-letter business name
    // appearing inside a password is coincidence, not derivation.
    if (squashedValue.length >= 4 && squashedPw.includes(squashedValue)) {
      return `Please choose a password that isn't based on ${label}.`
    }
  }

  return null
}
