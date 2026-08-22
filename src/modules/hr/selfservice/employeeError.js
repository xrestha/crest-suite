// Turns a Supabase/Postgres error into something the person holding the phone can act on.
//
// The portal has one shared `dataError` string for every read across four tabs, and the failures
// that matter never reach it at all: a failed `get_my_hr_payslips` renders as "No finalized
// payslips yet." That is the S594 rule — a failed read is not an empty period, and it must never
// render as one — unlearned in the one place where the reader has no way to check the figure
// against anything else.
//
// Two rules this follows:
//   * Never claim more than we know. Only genuinely recognisable shapes get a specific message;
//     everything else gets an honest generic one rather than a confident guess.
//   * Never destroy the technical detail — an owner or admin still has to diagnose it. It is
//     returned alongside as `detail`, for a title attribute or a fine-print line, never the
//     headline. "PGRST202: Could not find the function public.get_my_hr_payslips in the schema
//     cache" is precise and completely useless to a waiter who just tapped Submit.

const rules = [
  // Offline / DNS / CORS — supabase-js surfaces these as a bare TypeError from fetch.
  { test: e => /failed to fetch|networkerror|load failed/i.test(e.message || ''),
    text: "You're offline, or the connection dropped. Check your signal and try again." },

  // A function or column the deployed frontend expects but the database does not have yet — i.e.
  // an unapplied migration. This project applies migrations by hand, so it is a real state.
  // Nothing the employee can do; someone else has to fix it.
  { test: e => e.code === 'PGRST202' || e.code === '42883' || e.code === '42703'
      || /schema cache/i.test(e.message || ''),
    text: "This part of the app isn't ready yet. Tell your manager — there's nothing you can do from here." },

  // Session gone (expired JWT, signed out elsewhere).
  { test: e => e.code === 'PGRST301' || /jwt|token is expired|invalid claim/i.test(e.message || ''),
    text: 'Your session has ended. Sign in again to continue.' },

  // The submit_my_* RPCs raise this literal when profiles.hr_self_service is off or unlinked.
  { test: e => /not authorized/i.test(e.message || ''),
    text: "Your self-service access isn't set up. Ask your manager to check it." },

  // RLS refused, or EXECUTE was never granted on a new function signature.
  { test: e => e.code === '42501' || /permission denied|row-level security|violates row-level/i.test(e.message || ''),
    text: "You're not allowed to do that. If that seems wrong, tell your manager." },

  // A CHECK or NOT NULL the form should have caught first — worth its own message, because
  // "try again" is exactly the wrong advice when the same input will fail the same way.
  { test: e => e.code === '23514' || e.code === '23502' || e.code === '22P02',
    text: 'Something in the form was not accepted. Check the dates and amounts and try again.' },
]

const FALLBACK = "That didn't work. Try again — and tell your manager if it keeps happening."

// → { text, detail }. `text` is always safe to show; `detail` may be empty.
export function employeeError(err) {
  if (!err) return { text: FALLBACK, detail: '' }
  const e = typeof err === 'string' ? { message: err } : err
  const detail = [e.code, e.message].filter(Boolean).join(' · ')
  const hit = rules.find(r => r.test(e))
  return { text: hit ? hit.text : FALLBACK, detail }
}

// Convenience for the call sites that only have room for one string.
export const employeeErrorText = err => employeeError(err).text
