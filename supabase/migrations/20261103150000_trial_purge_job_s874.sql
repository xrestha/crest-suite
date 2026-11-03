-- The expired-trial purge job, made able to run (S874; filed S828 in POS_TODO.md S809.3).
--
-- crest-purge-expired-trials (20260903150000) has failed every night since it was scheduled: 61 runs
-- to 2026-11-02, all "function extensions.http_post(url => text, headers => jsonb, body => jsonb) does
-- not exist". pg_net's function is net.http_post. Behind that first fault sat a second: the job built
-- its request from app.settings.functions_url and app.settings.anon_key, which were never set (read
-- live 2026-11-03: both NULL), so with the name fixed it would still have posted to a NULL URL.
-- No trial has ever been purged, and Terms 4.3 / 7.6 and Privacy Policy 9 say one is.
--
-- What changes:
--   * request_trial_purge(p_dry_run) builds the request. It reads the functions URL and the anon key
--     from Supabase Vault (the two names below) and refuses, by name, when either is missing, rather
--     than posting nowhere. Both values are public (the anon key ships in every browser bundle), so
--     Vault is for keeping them out of this file and out of git, not for secrecy; x-purge-secret is
--     still the thing that authenticates the call. dry_run defaults TRUE, as in admin-user-ops.
--   * The job calls request_trial_purge(false) at the same time, 19:20 UTC (01:05 Nepal).
--   * The job is left SWITCHED OFF. Owner decision (2026-11-03): nothing is deleted until the owner
--     has read the list of trials the purge would delete. The steps after applying, in order:
--       1. SELECT vault.create_secret('https://<ref>.supabase.co/functions/v1', 'crest_functions_url',
--            'Edge Functions base URL for the trial purge job (S874)');
--          SELECT vault.create_secret('<legacy anon key, eyJ...>', 'crest_anon_key',
--            'Anon JWT the trial purge job presents to the functions gateway (S874)');
--       2. SELECT client_name, trial_purge_at, blocked_reason FROM public.trials_due_for_purge()
--            ORDER BY blocked_reason NULLS FIRST;   -- read every name with the owner
--       3. SELECT public.request_trial_purge(true);  -- end to end, deletes nothing; then read
--          SELECT status_code, content FROM net._http_response WHERE id = <the id it returned>;
--       4. Only on the owner's word:
--          SELECT cron.alter_job(jobid, active := true) FROM cron.job WHERE jobname = 'crest-purge-expired-trials';
--
-- pg_net is asynchronous: the job "succeeds" when the request is queued, so cron.job_run_details no
-- longer shows a failed delete. What the purge did is trial_purge_log (purged / skipped / failed per
-- trial, written by admin-user-ops); net._http_response keeps the HTTP answer for about six hours.
-- The timeout is 145 s, inside the Edge Function's 150 s wall clock, because pg_net's default (5 s)
-- would hang up on a purge that deletes more than one trial's data.
--
-- request_trial_purge runs as the caller: the cron job's owner (postgres) or an operator in the SQL
-- editor. No API role may execute it. A trigger of the purge from the browser would still need
-- x-purge-secret, but there is no reason to offer the call at all.
--
-- Reverse: SELECT cron.unschedule('crest-purge-expired-trials'); DROP FUNCTION
-- public.request_trial_purge(boolean); and, if wanted, delete the two Vault secrets by name.


-- ══ 1. The request ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.request_trial_purge(p_dry_run boolean DEFAULT true)
RETURNS bigint
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_url    text;
  v_key    text;
  v_secret text;
BEGIN
  SELECT s.decrypted_secret INTO v_url FROM vault.decrypted_secrets s WHERE s.name = 'crest_functions_url';
  SELECT s.decrypted_secret INTO v_key FROM vault.decrypted_secrets s WHERE s.name = 'crest_anon_key';
  SELECT a.purge_secret INTO v_secret FROM public.app_secrets a WHERE a.id = 1;
  IF COALESCE(btrim(v_url), '') = '' OR COALESCE(btrim(v_key), '') = '' THEN
    RAISE EXCEPTION 'trial purge: the Vault secrets crest_functions_url and crest_anon_key must both be set (20261103150000)'
      USING HINT = 'trial_purge_not_set_up';
  END IF;
  IF COALESCE(v_secret, '') = '' THEN
    RAISE EXCEPTION 'trial purge: app_secrets.purge_secret is empty'
      USING HINT = 'trial_purge_not_set_up';
  END IF;

  RETURN net.http_post(
    url                  := rtrim(v_url, '/') || '/admin-user-ops',
    headers              := jsonb_build_object(
                              'Content-Type',   'application/json',
                              'Authorization',  'Bearer ' || v_key,
                              'apikey',         v_key,
                              'x-purge-secret', v_secret),
    body                 := jsonb_build_object('action', 'purge_due_trials', 'dry_run', COALESCE(p_dry_run, true)),
    timeout_milliseconds := 145000
  );
END;
$$;

REVOKE ALL ON FUNCTION public.request_trial_purge(boolean) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.request_trial_purge(boolean) IS
  'Queues the purge_due_trials call to admin-user-ops through pg_net and returns the request id. dry_run defaults true. Reads crest_functions_url and crest_anon_key from Vault and refuses when either is missing. Called nightly by the crest-purge-expired-trials cron job (S874).';


-- ══ 2. The job, rescheduled and left off ═════════════════════════════════════════════════════════

SELECT cron.unschedule('crest-purge-expired-trials')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'crest-purge-expired-trials');

SELECT cron.alter_job(
  cron.schedule('crest-purge-expired-trials', '20 19 * * *', 'SELECT public.request_trial_purge(false);'),
  active := false
);


-- ══ 3. Checks ════════════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_job record;
BEGIN
  SELECT schedule, command, active INTO v_job FROM cron.job WHERE jobname = 'crest-purge-expired-trials';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'S874: the purge job is missing';
  END IF;
  IF v_job.active OR v_job.schedule <> '20 19 * * *'
     OR v_job.command <> 'SELECT public.request_trial_purge(false);' THEN
    RAISE EXCEPTION 'S874: the purge job is % / % / active=%', v_job.schedule, v_job.command, v_job.active;
  END IF;
  IF (SELECT count(*) FROM cron.job WHERE jobname = 'crest-purge-expired-trials') <> 1 THEN
    RAISE EXCEPTION 'S874: more than one purge job';
  END IF;
  IF has_function_privilege('anon', 'public.request_trial_purge(boolean)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.request_trial_purge(boolean)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.request_trial_purge(boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'S874: an API role can execute request_trial_purge';
  END IF;
  IF to_regprocedure('net.http_post(text, jsonb, jsonb, jsonb, integer)') IS NULL THEN
    RAISE EXCEPTION 'S874: net.http_post(url, body, params, headers, timeout_milliseconds) is not installed';
  END IF;
END;
$$;


-- ══ 4. What it acts on, live (the last statement, so `db query` prints it) ═══════════════════════
SELECT
  (SELECT active FROM cron.job WHERE jobname = 'crest-purge-expired-trials') AS job_active,
  (SELECT count(*) FROM vault.secrets WHERE name IN ('crest_functions_url', 'crest_anon_key')) AS vault_secrets_set,
  (SELECT count(*) FROM public.trial_purge_log) AS purge_log_rows;
