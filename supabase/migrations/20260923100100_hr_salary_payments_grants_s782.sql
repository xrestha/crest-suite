-- S782 follow-up — hr_salary_payments carried TRUNCATE / REFERENCES / TRIGGER / MAINTAIN for
-- `authenticated`, which 20260923100000 never granted.
--
-- They come from the schema's DEFAULT privileges: tables created by `postgres` in `public` are
-- born with `anon=Dxtm` and `authenticated=Dxtm` (pg_default_acl, read live 2026-09-23). The
-- "raw-SQL tables get no role grants" note in supabase-sql.md is true of SELECT/INSERT/UPDATE/
-- DELETE and false of these four. 20260720160000 stripped exactly these from every table that
-- existed then; every table created since has them back. TRUNCATE bypasses RLS and row triggers,
-- so on a money ledger whose whole design is "written only by two functions" it is the one
-- privilege that walks round both. PostgREST exposes no TRUNCATE, so nothing was reachable over
-- the API — this is the hardening, not an incident. The same gap on the other tables, and the
-- default ACL itself, are left for a separate decision.
REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON public.hr_salary_payments FROM authenticated, anon, PUBLIC;

DO $$
BEGIN
  IF has_table_privilege('authenticated', 'public.hr_salary_payments', 'TRUNCATE')
     OR has_table_privilege('authenticated', 'public.hr_salary_payments', 'REFERENCES')
     OR has_table_privilege('authenticated', 'public.hr_salary_payments', 'TRIGGER')
     OR has_table_privilege('anon', 'public.hr_salary_payments', 'TRUNCATE') THEN
    RAISE EXCEPTION 'S782: hr_salary_payments still grants TRUNCATE/REFERENCES/TRIGGER to a client role';
  END IF;
  IF NOT (has_table_privilege('authenticated', 'public.hr_salary_payments', 'SELECT')
          AND has_table_privilege('authenticated', 'public.hr_salary_payments', 'INSERT')) THEN
    RAISE EXCEPTION 'S782: the revoke took the ordinary grants with it — the page could no longer read payments';
  END IF;
END;
$$;
