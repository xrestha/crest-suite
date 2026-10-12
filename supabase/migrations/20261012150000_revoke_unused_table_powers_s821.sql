-- ════════════════════════════════════════════════════════════════════════════════════════════
-- S821, POS stage 5, slice 5a: the browser logins lose the table powers no screen uses, and a new
-- table no longer starts with them.
--
--   S782 grants (S809.4 1k, 1l, 3b, 3k; owner Q28 (a), 2026-10-12: every table, and new tables start
--   without them). postgres's default ACL for tables in public reads
--   {postgres=arwdDxtm, anon=Dxtm, authenticated=Dxtm, service_role=arwdDxtm} (read 2026-10-12), so
--   every table made in raw SQL is handed TRUNCATE, REFERENCES, TRIGGER and MAINTAIN for both browser
--   roles. Migrations have revoked them table by table since S782, and every table made before that
--   line, or without it, kept them. Live on 2026-10-12, read with has_table_privilege:
--     * TRUNCATE / REFERENCES / TRIGGER: 19 tables, 31 role-table pairs. Both roles on app_secrets,
--       client_groups, client_secrets, legal_acceptances, pos_cash_movements, pos_loyalty_ledger,
--       pos_loyalty_schemes, pos_reservation_request_attempts, profile_outlet_access,
--       staff_pin_vault, trial_purge_log and trial_signup_attempts; authenticated only on
--       pos_option_groups, pos_option_ingredients, pos_options, pos_order_item_options,
--       pos_recipe_option_groups, pos_reservations and pos_reservation_tables.
--     * MAINTAIN: 83 of the 103 public relations, 159 pairs, among them pos_parking_slips,
--       pos_payment_confirmations, pos_guest_order_requests and the view inventory_summary. The
--       other 20 had it revoked by name since S782.
--   TRUNCATE empties a table with no RLS and no row triggers. MAINTAIN can LOCK, VACUUM, ANALYZE,
--   CLUSTER or REINDEX it. REFERENCES and TRIGGER let a role hang a foreign key or a trigger on it.
--   None of the four is reachable through PostgREST, so the app never opened them; this closes the
--   layer under it.
--
--   Nothing uses them. No function in public mentions TRUNCATE, LOCK TABLE, REFRESH MATERIALIZED
--   VIEW, VACUUM or REINDEX (0 of 287, read 2026-10-12). The Edge Functions and pg_cron run as
--   service_role or postgres, which keep all eight. A browser role never creates a foreign key or a
--   trigger. SELECT, INSERT, UPDATE and DELETE are not touched for any role (98 browser SELECT pairs
--   and 262 browser write pairs before; section 3 proves the same set after).
--
--   1. REVOKE the four ON ALL TABLES IN SCHEMA public (102 tables and the one view) FROM anon,
--      authenticated and PUBLIC.
--   2. ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public: a new table starts without them,
--      so the "REVOKE those in the same migration" line in apply-migration becomes a backstop. Every
--      public relation is owned by postgres. supabase_admin's own default ACL on public still hands
--      out everything; it owns no public relation, and this role cannot change its defaults.
--
--   Everything runs inside one DO block, so a failed check undoes the REVOKE and the default change
--   together, however `supabase db query -f` sends the file. The probe in section 3 creates a
--   scratch table in public inside a sub-block and rolls it back.
--
--   Reversal (not expected): GRANT TRUNCATE, REFERENCES, TRIGGER ON <table> TO <role> for the 31
--   pairs above; GRANT MAINTAIN ON ALL TABLES IN SCHEMA public TO anon, authenticated, then REVOKE it
--   from the 20 relations that did not hold it (S782's per-table REVOKEs name them); and
--   ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
--     GRANT TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLES TO anon, authenticated.
-- ════════════════════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_n           integer;
  v_bad         text;
  v_kept_before text;
  v_kept_after  text;
BEGIN
  -- ── 0. Pre-flight ─────────────────────────────────────────────────────────────────────────
  -- A REVOKE by a role that cannot act for the owner does nothing and raises no error (the
  -- 20260712210000 lesson), so refuse rather than report a sweep that did not happen.
  IF NOT COALESCE(pg_has_role(current_user, 'postgres', 'MEMBER'), false) THEN
    RAISE EXCEPTION 'S821 5a pre-flight: % cannot act for postgres, so neither the REVOKE nor the default change would land', current_user;
  END IF;

  SELECT count(*) INTO v_n
    FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace
     AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
     AND c.relowner <> 'postgres'::regrole;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'S821 5a pre-flight: % public relation(s) are not owned by postgres; look at them before sweeping', v_n;
  END IF;

  -- What must not move: SELECT, INSERT, UPDATE and DELETE for the browser roles, and all eight
  -- for service_role. Computed by Postgres, never parsed from relacl text (S630).
  SELECT md5(string_agg(format('%s:%s:%s', c.relname, r.rol, p.priv), ',' ORDER BY c.relname, r.rol, p.priv))
    INTO v_kept_before
    FROM pg_class c
    CROSS JOIN (VALUES ('anon'), ('authenticated'), ('service_role')) r(rol)
    CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'),
                       ('TRUNCATE'), ('REFERENCES'), ('TRIGGER'), ('MAINTAIN')) p(priv)
   WHERE c.relnamespace = 'public'::regnamespace
     AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
     AND (r.rol = 'service_role' OR p.priv IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE'))
     AND has_table_privilege(r.rol, c.oid, p.priv);

  -- ── 1. Every public table and view ────────────────────────────────────────────────────────
  REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON ALL TABLES IN SCHEMA public FROM anon, authenticated, PUBLIC;

  -- ── 2. Every table made later ─────────────────────────────────────────────────────────────
  ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
    REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLES FROM anon, authenticated, PUBLIC;

  -- ── 3. Self-check ─────────────────────────────────────────────────────────────────────────
  -- anon's effective privileges include PUBLIC's, so testing the two roles covers all three.
  SELECT count(*), string_agg(DISTINCT c.relname, ', ')
    INTO v_n, v_bad
    FROM pg_class c
    CROSS JOIN (VALUES ('anon'), ('authenticated')) r(rol)
    CROSS JOIN (VALUES ('TRUNCATE'), ('REFERENCES'), ('TRIGGER'), ('MAINTAIN')) p(priv)
   WHERE c.relnamespace = 'public'::regnamespace
     AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
     AND has_table_privilege(r.rol, c.oid, p.priv);
  IF v_n > 0 THEN
    RAISE EXCEPTION 'S821 5a: % role-table pair(s) still hold a removed power: %', v_n, v_bad;
  END IF;

  SELECT md5(string_agg(format('%s:%s:%s', c.relname, r.rol, p.priv), ',' ORDER BY c.relname, r.rol, p.priv))
    INTO v_kept_after
    FROM pg_class c
    CROSS JOIN (VALUES ('anon'), ('authenticated'), ('service_role')) r(rol)
    CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'),
                       ('TRUNCATE'), ('REFERENCES'), ('TRIGGER'), ('MAINTAIN')) p(priv)
   WHERE c.relnamespace = 'public'::regnamespace
     AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
     AND (r.rol = 'service_role' OR p.priv IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE'))
     AND has_table_privilege(r.rol, c.oid, p.priv);
  IF v_kept_after IS DISTINCT FROM v_kept_before THEN
    RAISE EXCEPTION 'S821 5a: a privilege this file must not touch changed (% before, % after)', v_kept_before, v_kept_after;
  END IF;

  SELECT count(*) INTO v_n
    FROM pg_default_acl d, aclexplode(d.defaclacl) a
   WHERE d.defaclrole = 'postgres'::regrole
     AND d.defaclnamespace = 'public'::regnamespace
     AND d.defaclobjtype = 'r'
     AND a.grantee IN ('anon'::regrole::oid, 'authenticated'::regrole::oid, 0::oid)
     AND a.privilege_type IN ('TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN');
  IF v_n > 0 THEN
    RAISE EXCEPTION 'S821 5a: the default for new tables still hands out % removed power(s)', v_n;
  END IF;

  SELECT count(*) INTO v_n
    FROM pg_default_acl d, aclexplode(d.defaclacl) a
   WHERE d.defaclrole = 'postgres'::regrole
     AND d.defaclnamespace = 'public'::regnamespace
     AND d.defaclobjtype = 'r'
     AND a.grantee = 'service_role'::regrole::oid;
  IF v_n <> 8 THEN
    RAISE EXCEPTION 'S821 5a: the default for new tables gives service_role % of its 8 privileges', v_n;
  END IF;

  -- Behaviour, not just the catalog row: a table made now, as a migration makes one, starts with
  -- nothing for the browser roles and everything for service_role. Rolled back.
  BEGIN
    CREATE TABLE public.s821_default_probe (id integer);

    SELECT count(*) INTO v_n
      FROM (VALUES ('anon'), ('authenticated')) r(rol)
      CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'),
                         ('TRUNCATE'), ('REFERENCES'), ('TRIGGER'), ('MAINTAIN')) p(priv)
     WHERE has_table_privilege(r.rol, 'public.s821_default_probe', p.priv);
    IF v_n > 0 THEN
      RAISE EXCEPTION 'S821 5a probe: a new table gives the browser roles % privilege(s)', v_n;
    END IF;

    SELECT count(*) INTO v_n
      FROM (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'),
                   ('TRUNCATE'), ('REFERENCES'), ('TRIGGER'), ('MAINTAIN')) p(priv)
     WHERE has_table_privilege('service_role', 'public.s821_default_probe', p.priv);
    IF v_n <> 8 THEN
      RAISE EXCEPTION 'S821 5a probe: a new table gives service_role % of its 8 privileges', v_n;
    END IF;

    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 's821_5a_probe_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 's821_5a_probe_rollback' THEN RAISE; END IF;
  END;
END;
$$;


-- ── 4. What this slice left, live (the last statement, so `db query` prints it) ─────────────
-- Expect removed_powers_left 0, browser_select_pairs 98, browser_write_pairs 262, probe_table_left
-- false, and new_table_default {postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres}.
SELECT
  (SELECT count(*)
     FROM pg_class c
     CROSS JOIN (VALUES ('anon'), ('authenticated')) r(rol)
     CROSS JOIN (VALUES ('TRUNCATE'), ('REFERENCES'), ('TRIGGER'), ('MAINTAIN')) p(priv)
    WHERE c.relnamespace = 'public'::regnamespace
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND has_table_privilege(r.rol, c.oid, p.priv)) AS removed_powers_left,
  (SELECT count(*)
     FROM pg_class c
     CROSS JOIN (VALUES ('anon'), ('authenticated')) r(rol)
    WHERE c.relnamespace = 'public'::regnamespace
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND has_table_privilege(r.rol, c.oid, 'SELECT')) AS browser_select_pairs,
  (SELECT count(*)
     FROM pg_class c
     CROSS JOIN (VALUES ('anon'), ('authenticated')) r(rol)
     CROSS JOIN (VALUES ('INSERT'), ('UPDATE'), ('DELETE')) p(priv)
    WHERE c.relnamespace = 'public'::regnamespace
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND has_table_privilege(r.rol, c.oid, p.priv)) AS browser_write_pairs,
  (to_regclass('public.s821_default_probe') IS NOT NULL) AS probe_table_left,
  (SELECT d.defaclacl::text
     FROM pg_default_acl d
    WHERE d.defaclrole = 'postgres'::regrole
      AND d.defaclnamespace = 'public'::regnamespace
      AND d.defaclobjtype = 'r') AS new_table_default;

-- Read back after applying (one statement per call):
--   SELECT has_table_privilege('anon', 'public.pos_loyalty_ledger', 'TRUNCATE'),
--          has_table_privilege('authenticated', 'public.pos_cash_movements', 'TRUNCATE'),
--          has_table_privilege('authenticated', 'public.pos_guest_order_requests', 'MAINTAIN'),
--          has_table_privilege('authenticated', 'public.pos_guest_order_requests', 'UPDATE'),
--          has_table_privilege('service_role', 'public.pos_loyalty_ledger', 'TRUNCATE');
--     expect f, f, f, t, t.
