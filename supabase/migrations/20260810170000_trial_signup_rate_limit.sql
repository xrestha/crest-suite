-- ════════════════════════════════════════════════════════════════════════════════════════════
-- MEDIUM: admin-user-ops' `register_trial` action is deliberately unauthenticated (it is the
-- public trial-signup form) and had no rate limit, no captcha, and no cap of any kind. A loop
-- against it creates unbounded auth.users AND clients rows -- each of which then gets a profile,
-- and each of which sits in Admin -> Clients until trial_purge_at, 22 days out. That is resource
-- exhaustion plus an admin console nobody can read any more.
--
-- This table is the counter behind a per-IP and a global hourly cap enforced in the function.
-- Attempts are recorded BEFORE user creation is attempted, so a failing loop (duplicate email,
-- weak password) consumes quota exactly like a succeeding one -- otherwise the cheapest attack is
-- simply to keep failing.
--
-- Not client-scoped, so it is correctly exempt from the scopedDb allowlist and from the Danger
-- Zone clearModuleData/deleteClientData checklist -- there is no client_id to cascade from, and
-- rows are pruned by age rather than by tenant.
-- ════════════════════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.trial_signup_attempts (
  id         bigserial PRIMARY KEY,
  ip         text,
  email      text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trial_signup_attempts_created ON public.trial_signup_attempts (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trial_signup_attempts_ip      ON public.trial_signup_attempts (ip, created_at DESC);

ALTER TABLE public.trial_signup_attempts ENABLE ROW LEVEL SECURITY;

-- No policies at all, and no grants to anon/authenticated: the only reader/writer is the
-- service-role client inside the Edge Function, which bypasses RLS. A browser cannot see this
-- table, which matters because it holds the IP and the email of everyone who tried to sign up.
GRANT SELECT, INSERT, DELETE ON public.trial_signup_attempts TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.trial_signup_attempts_id_seq TO service_role;

NOTIFY pgrst, 'reload schema';

-- ── Housekeeping ─────────────────────────────────────────────────────────────────────────────
-- Only the last hour is ever consulted. There is no cron in this project, so rather than add one,
-- run this occasionally (or wire it into whatever maintenance pass gets built later):
--   DELETE FROM public.trial_signup_attempts WHERE created_at < now() - interval '7 days';
--
-- ── Verification ─────────────────────────────────────────────────────────────────────────────
-- Submit the trial signup form 4 times in a row from one browser: the 4th must come back with
-- "Too many signup attempts from this network" and create no auth user. Then:
--   SELECT ip, count(*) FROM trial_signup_attempts
--   WHERE created_at > now() - interval '1 hour' GROUP BY ip;
--   -- expect: 4 recorded attempts, and only 3 corresponding rows in public.clients
