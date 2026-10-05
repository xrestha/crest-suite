// What a PIN sign-in's GoTrue answer means for the lockout (S798, SELF-SERVICE-6). Shared by
// hr-selfservice-login, pos-staff-login and ims-staff-login, because this is the one decision that
// must not drift between them.
//
// Each function reserves the attempt as a FAILURE before signing in (S791). Until S798 the sign-in
// error was dropped and any missing session went down the wrong-PIN path, so a 429 or 5xx from
// GoTrue at a busy shift change stayed counted, the phone said "Incorrect PIN", and five of them
// locked out an employee typing the correct PIN for 15 minutes.
//
// Only an answer about the ACCOUNT keeps the reservation:
//   invalid_credentials  a wrong PIN (GoTrue answers the same for a missing user or no password).
//   user_banned          a settled leaver's till or stock login (Final Settlement bans it). GoTrue
//                        tests the ban before the password, so it says nothing about the PIN.
// Everything else (429, 5xx, a dropped connection, a reply with no session) never judged the PIN:
// the attempt is given back through release_*_pin_attempt and the caller gets a 503.
//
// FAILS OPEN IF THE CODE STOPS MATCHING. If GoTrue ever answered a wrong password without
// `invalid_credentials`, every wrong PIN would be given back and the lockout would never fire. The
// bare-400 branch below covers GoTrue from before error codes (2024); the 503 log line carries the
// status and code, which is what would surface a new shape.

export type SignInVerdict =
  | { kind: 'ok' }
  | { kind: 'refused' }
  | { kind: 'unavailable'; detail: string }

type AuthErrorLike = { name?: string; status?: number; code?: string; message?: string } | null

export function signInVerdict(data: { session?: unknown } | null, error: AuthErrorLike): SignInVerdict {
  if (data?.session) return { kind: 'ok' }
  const code = error?.code
  if (code === 'invalid_credentials' || code === 'user_banned') return { kind: 'refused' }
  if (!code && error?.status === 400 && /invalid login credentials/i.test(error?.message ?? '')) {
    return { kind: 'refused' }
  }
  return {
    kind: 'unavailable',
    detail: error
      ? `${error.name ?? 'Error'} status=${error.status ?? '?'} code=${code ?? '?'}: ${error.message ?? ''}`
      : 'no session and no error',
  }
}

// Gives back the attempt reserve_<kind>_pin_attempt counted. lockedUntil is the stamp the
// reservation returned (set only when that attempt locked the account), so the release lifts that
// lock and no other. Fails open with a log line: the attempt then stays counted, as before S798.
export async function releasePinAttempt(
  admin: { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ error: { code?: string; message: string } | null }> },
  kind: 'hr' | 'pos' | 'ims',
  staffId: string,
  lockedUntil: string | null,
  tag: string,
): Promise<void> {
  const { error } = await admin.rpc(`release_${kind}_pin_attempt`, {
    p_staff_id: staffId, p_locked_until: lockedUntil,
  })
  if (error) {
    console.error(`[${tag}] release_${kind}_pin_attempt FAILED — this attempt stays counted as a wrong PIN:`, error.code, error.message)
  }
}
