-- STATUS: complete (draft for review; NOT applied — apply only on the owner's "apply")
-- S849 GROUP cluster — the Group Console and the multi-outlet machinery (Suite review S848).
-- Findings: GROUP-1 (+DATABASE-1), GROUP-2, GROUP-3, GROUP-5 (+DOCS-2), GROUP-6, GROUP-7, GROUP-9,
-- GROUP-12, GROUP-15 (+DATABASE-6), GROUP-16 (revoke_outlet_access, the free-line rule SU22),
-- ACCESS-1 (+PNL-9; get_group_summary and get_group_item_prices only — get_group_pnl is PNL's).
-- Owner decisions: SU2 (a), SU8 (a), SU22; S849 answers: a new dish with a missing ingredient is added
-- and the missing line named; Crest support gets a read-only view of a client's group (ACCESS-8).
-- Support-view contract, the same in every group READ function (PNL: get_group_pnl, OD:
-- get_group_labour_inputs): a last parameter p_group_id uuid DEFAULT NULL; NOT NULL → the caller must be
-- COALESCE(is_admin(), false) (else 42501) and the group is p_group_id; NULL → my_group_id() as before.
-- Plan and plain words: .s849/plan-GROUP.md.
--
-- DEPENDS ON the ACCESS migration (public.client_suite_live(uuid)) and the PNL migration §1
-- (public.ims_stock_transfer_lines): both must be applied first, so the order is … → PNL → GROUP
-- (pre-flight 0 refuses otherwise). Apply this BEFORE the frontend that reads push_master_data's new shape and
-- get_group_outlet_access's login_kind deploys (an older bundle keeps working on both, see below).
--
-- Objects, and how to reverse each (every "previous body" is in the migration named):
--   public.profile_is_owner(profiles)            NEW. Reverse: restore is_client_owner first (below), then
--                                                DROP FUNCTION public.profile_is_owner(public.profiles);
--   public.is_client_owner()                     REPLACED with the same test, now through profile_is_owner (one SQL
--                                                copy); same signature, STABLE SECURITY DEFINER, grants kept, and §1b
--                                                proves old and new agree on every profile. Reverse: the body from
--                                                20260914230000_hr_staff_settlement_gratuity.sql (CREATE OR REPLACE).
--   public.clear_stale_active_outlet()           REPLACED (trigger fn on clients.group_id; also clears an HQ that left,
--                                                and grants / employee links that now cross groups).
--                                                Reverse: body from 20260812170000_multi_outlet_groups.sql.
--   public.set_active_outlet(uuid)               REPLACED (a count PIN stays home). Reverse: 20261013150000_pos_hardening_5e_s829.sql.
--   public.set_outlet_access(uuid, uuid[])       REPLACED (count PIN / Self-Service refused; a stale grant is dropped,
--                                                not refused). Reverse: 20261009130000_pos_till_outlet_pin_s809.sql.
--   public.revoke_outlet_access(uuid, uuid)      REPLACED (the subject must be in the group too).
--                                                Reverse: 20261003160000_hr_login_links_s798.sql.
--   public.get_outlet_reaching_logins(uuid)      REPLACED (only logins whose home is in the outlet's group).
--                                                Reverse: 20261003160000_hr_login_links_s798.sql.
--   public.get_group_outlet_access()             DROPPED; CREATED as get_group_outlet_access(p_group_id uuid DEFAULT NULL)
--                                                (support view, read only; new column login_kind; is_owner = the Owner
--                                                test; no Self-Service rows; grants only inside the group).
--                                                Reverse: DROP the 1-arg form, then the CREATE from
--                                                20260827130000_profile_outlet_access.sql + its grants.
--   public.get_group_summary(int,int,date,date)  DROPPED; CREATED as get_group_summary(int,int,date,date,int,uuid) with
--                                                p_through_day DEFAULT NULL, p_group_id DEFAULT NULL (support view) and two
--                                                new columns revenue_counted, net_purchases_counted (live Suite filter;
--                                                net purchases on the cost basis; stock transfers; finished-days pair).
--                                                Reverse: DROP the 6-arg form, CREATE the 20261010170000 body with the
--                                                S836 part-bill line (pg_get_functiondef before applying; md5
--                                                dc7e1fd26ce0186a282c10d144f5c407) + its REVOKE/GRANT.
--   public.get_group_item_prices(int,int)        DROPPED; CREATED as get_group_item_prices(int,int,uuid) with p_group_id
--                                                DEFAULT NULL (support view; live Suite filter; free lines left out).
--                                                Reverse: DROP the 3-arg form, then 20261002120000_group_item_prices_s800.sql.
--   public.push_master_data(uuid[],text[],bool)  DROPPED + CREATED (new return shape: row_no, row_kind, …, row_n).
--                                                Reverse: DROP, then the CREATE from 20261015100000_pos_leftovers_s840.sql
--                                                + REVOKE ALL FROM PUBLIC, anon + GRANT EXECUTE TO authenticated, service_role.
--   Data (section 11): stray rows removed — an HQ outside its group, count-PIN and Self-Service grants and
--   employee links, grants and links that cross groups. Live 2026-10-15: 0 rows in every case. Not
--   reversible from here, but traced: log_audit records every profiles, profile_employee_links,
--   profile_outlet_access and client_groups row it touches (the last two through the audit triggers
--   ACCESS §5 adds for DATABASE-5; ACCESS applies first).
--
-- An older cached bundle against this database: the push panel reads target_client_name/entity/action/
-- record_name/detail, which are all still returned, so it keeps working and shows the new total/count
-- rows as blank-named rows until the new bundle loads; Outlet Access ignores the added column.
-- Rule followed: every function rebuilt from its LATEST migration body (pre-flight 0 checks the live
-- md5 still matches), COALESCE on every authorisation test, SET search_path, REVOKE from PUBLIC + anon,
-- explicit GRANTs, DROP before a return-shape change, NOTIFY at the end.

BEGIN;

-- ── 0. Pre-flight ─────────────────────────────────────────────────────────────────────────────
DO $pre$
DECLARE
  r record;
  v_md5 text;
  v_md5_lf text;
BEGIN
  IF to_regprocedure('public.client_suite_live(uuid)') IS NULL THEN
    RAISE EXCEPTION 'S849 GROUP: public.client_suite_live(uuid) is missing — apply the ACCESS migration first';
  END IF;
  IF to_regclass('public.ims_stock_transfer_lines') IS NULL THEN
    RAISE EXCEPTION 'S849 GROUP: public.ims_stock_transfer_lines is missing — apply the PNL migration (§1, stock transfers) first';
  END IF;

  -- get_group_summary gains p_through_day (DROP + CREATE), so a re-run finds the 5-argument form.
  IF to_regprocedure('public.get_group_summary(integer,integer,date,date)') IS NOT NULL THEN
    SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.get_group_summary(integer,integer,date,date)'::regprocedure;
    IF v_md5 IS DISTINCT FROM 'dc7e1fd26ce0186a282c10d144f5c407' THEN
      RAISE EXCEPTION 'S849 GROUP pre-flight: get_group_summary is not the S836 body this file was built on (live md5 %). Rebuild from the live body.', v_md5;
    END IF;
  ELSIF to_regprocedure('public.get_group_summary(integer,integer,date,date,integer,uuid)') IS NOT NULL THEN
    SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.get_group_summary(integer,integer,date,date,integer,uuid)'::regprocedure;
    IF v_md5 IS DISTINCT FROM '8819d5244a94c38f467d47995ddce839' THEN
      RAISE EXCEPTION 'S849 GROUP pre-flight: get_group_summary(…, p_group_id) is not this file''s body (live md5 %).', v_md5;
    END IF;
  ELSE
    RAISE EXCEPTION 'S849 GROUP pre-flight: get_group_summary is missing';
  END IF;

  -- get_group_item_prices and get_group_outlet_access gain p_group_id (DROP + CREATE) the same way.
  IF to_regprocedure('public.get_group_item_prices(integer,integer)') IS NOT NULL THEN
    SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.get_group_item_prices(integer,integer)'::regprocedure;
    IF v_md5 IS DISTINCT FROM '98377603041bfb22cdad9caf8252475e' THEN
      RAISE EXCEPTION 'S849 GROUP pre-flight: get_group_item_prices is not the S800 body (live md5 %). Rebuild from the live body.', v_md5;
    END IF;
  ELSIF to_regprocedure('public.get_group_item_prices(integer,integer,uuid)') IS NOT NULL THEN
    SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.get_group_item_prices(integer,integer,uuid)'::regprocedure;
    -- Review 2 (2026-10-19): 5a726c38… is the body WITH the M4 comment; the earlier 747f11b3… was the
    -- body before that comment was added, so a re-run would have refused this file's own body.
    IF v_md5 IS DISTINCT FROM '5a726c384a503e02cffd2cebe92e6b58' THEN
      RAISE EXCEPTION 'S849 GROUP pre-flight: get_group_item_prices(…, p_group_id) is not this file''s body (live md5 %).', v_md5;
    END IF;
  ELSE
    RAISE EXCEPTION 'S849 GROUP pre-flight: get_group_item_prices is missing';
  END IF;

  IF to_regprocedure('public.get_group_outlet_access()') IS NOT NULL THEN
    -- Live bodies applied from Windows carry CRLF line ends: compare with the CRs removed as well.
    SELECT md5(prosrc), md5(replace(prosrc, E'\r', '')) INTO v_md5, v_md5_lf
      FROM pg_proc WHERE oid = 'public.get_group_outlet_access()'::regprocedure;
    IF 'c34ade35d9e512d2159aff606f0f90fd' NOT IN (v_md5, v_md5_lf) THEN
      RAISE EXCEPTION 'S849 GROUP pre-flight: get_group_outlet_access is not the S617 body (live md5 %). Rebuild from the live body.', v_md5;
    END IF;
  ELSIF to_regprocedure('public.get_group_outlet_access(uuid)') IS NOT NULL THEN
    SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.get_group_outlet_access(uuid)'::regprocedure;
    IF v_md5 IS DISTINCT FROM 'f749f16961e99caf4958ea1ca03b1134' THEN
      RAISE EXCEPTION 'S849 GROUP pre-flight: get_group_outlet_access(p_group_id) is not this file''s body (live md5 %).', v_md5;
    END IF;
  ELSE
    RAISE EXCEPTION 'S849 GROUP pre-flight: get_group_outlet_access is missing';
  END IF;

  -- Each body this file rebuilds must be the one it was written from (its last migration), or
  -- already this file's own (a re-run). Otherwise stop and rebuild from pg_get_functiondef.
  FOR r IN SELECT * FROM (VALUES
      ('public.push_master_data(uuid[],text[],boolean)',               'da8bb5715c431dfbef42340fb049e781', '23d9260aaeb024f79d979a2e90c0c7e8'),
      ('public.set_active_outlet(uuid)',                               '304222c3d89b63397040297ff395a28d', '0e273d549da7a455df796e3b905be3c0'),
      ('public.set_outlet_access(uuid,uuid[])',                        '88be08fc24fb12ff46a6b64c528c8328', 'e43b80eaf5dc8b05a615c843dda56f28'),
      ('public.revoke_outlet_access(uuid,uuid)',                       '73d6a98a80b0ae97419c258e25018023', '1922de8d1fbe1d73c6d7dc24ffad3387'),
      ('public.get_outlet_reaching_logins(uuid)',                      '0c863db20291a5e6f36c8901c2414ed2', '128843e75e23b374d1b50fdb5a881197'),
      ('public.is_client_owner()',                                     'bc4def4bff553cd31cf0071cdef6b1d4', 'b2674d9211c9e43bc72cd64ed8b58f4c'),
      ('public.clear_stale_active_outlet()',                           '2ae25e1bd357096cc358bdae3c42cd34', '1ef1141f52978909cfae713ed8d57ad7')
    ) AS t(sig, before_md5, after_md5)
  LOOP
    SELECT md5(p.prosrc), md5(replace(p.prosrc, E'\r', '')) INTO v_md5, v_md5_lf
      FROM pg_proc p WHERE p.oid = to_regprocedure(r.sig);
    IF v_md5 IS NULL OR NOT (v_md5 IN (r.before_md5, r.after_md5) OR v_md5_lf IN (r.before_md5, r.after_md5)) THEN
      RAISE EXCEPTION 'S849 GROUP pre-flight: % is not the body this file was built on (live md5 %). Rebuild from the live body.', r.sig, v_md5;
    END IF;
  END LOOP;

  -- One signature each, so no stale overload keeps an old body reachable (supabase-sql.md).
  FOR r IN SELECT proname, count(*) AS n FROM pg_proc
            WHERE pronamespace = 'public'::regnamespace
              AND proname IN ('push_master_data', 'get_group_summary', 'get_group_item_prices', 'set_active_outlet',
                              'set_outlet_access', 'revoke_outlet_access', 'get_outlet_reaching_logins',
                              'get_group_outlet_access', 'clear_stale_active_outlet', 'is_client_owner')
            GROUP BY proname
  LOOP
    IF r.n <> 1 THEN
      RAISE EXCEPTION 'S849 GROUP pre-flight: % has % signatures (want 1)', r.proname, r.n;
    END IF;
  END LOOP;
END;
$pre$;


-- ── 1. The Owner test on a profile row (GROUP-15, DATABASE-6) ─────────────────────────────────
-- is_client_owner()'s exact test, on any profile row: the Outlet Access matrix had a fourth hand-kept
-- copy without pos_email, so a till login whose rank was cleared read "Owner — all". It is the very
-- expression is_client_owner() evaluates, three-valued as that one is (a NULL role gives NULL, which
-- every caller COALESCEs), so §1b can prove the two agree. ims_email implies ims_role and is not tested.
CREATE OR REPLACE FUNCTION public.profile_is_owner(p public.profiles)
RETURNS boolean
LANGUAGE sql
IMMUTABLE PARALLEL SAFE
SET search_path TO 'public'
AS $$
  SELECT p.role = 'client'
     AND p.pos_role IS NULL
     AND p.pos_email IS NULL
     AND p.ims_role IS NULL
     AND p.hr_role IS NULL
     AND COALESCE(p.hr_self_service, false) = false
$$;
REVOKE ALL ON FUNCTION public.profile_is_owner(public.profiles) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.profile_is_owner(public.profiles) TO authenticated, service_role;

-- ── 1b. is_client_owner() through the one copy (GROUP-15 / DATABASE-6) ─────────────────────────
-- Before replacing it: for EVERY profile, its current expression and profile_is_owner(p) must agree
-- (NULL-aware). Otherwise the migration stops. The grants are recorded and compared afterwards.
DO $same$
DECLARE
  v_n bigint;
BEGIN
  SELECT count(*) INTO v_n
    FROM profiles p
   WHERE (p.role = 'client'
          AND p.pos_role IS NULL
          AND p.pos_email IS NULL
          AND p.ims_role IS NULL
          AND p.hr_role IS NULL
          AND COALESCE(p.hr_self_service, false) = false)
         IS DISTINCT FROM public.profile_is_owner(p);
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'S849 GROUP: profile_is_owner disagrees with is_client_owner''s test on % profile(s)', v_n;
  END IF;
END;
$same$;

CREATE TEMP TABLE s849_group_ico_acl ON COMMIT DROP AS
  SELECT proacl, provolatile, prosecdef, proconfig
    FROM pg_proc WHERE oid = 'public.is_client_owner()'::regprocedure;

-- Same signature, CREATE OR REPLACE (keeps the S531 grants: PUBLIC revoked, authenticated and
-- service_role granted, 20260810130000), STABLE SECURITY DEFINER as today. A caller with no profile
-- row still gets NULL (no row), and every existing caller COALESCEs it. One nested call per use;
-- the profiles lookup it already did is the cost that matters.
CREATE OR REPLACE FUNCTION public.is_client_owner()
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT public.profile_is_owner(p) FROM profiles p WHERE p.id = auth.uid()
$$;

DO $same2$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc f, s849_group_ico_acl o
              WHERE f.oid = 'public.is_client_owner()'::regprocedure
                AND (f.proacl IS DISTINCT FROM o.proacl OR f.provolatile IS DISTINCT FROM o.provolatile
                     OR f.prosecdef IS DISTINCT FROM o.prosecdef OR f.proconfig IS DISTINCT FROM o.proconfig)) THEN
    RAISE EXCEPTION 'S849 GROUP: is_client_owner() changed its grants, volatility, security or search_path';
  END IF;
  -- And, per profile, the function as a caller sees it agrees with the expression (a JWT per row
  -- would be slow; sampled on up to 200 profiles of every kind).
  DECLARE
    r record;
    v_old boolean;
  BEGIN
    FOR r IN SELECT p.* FROM profiles p ORDER BY p.role, p.id LIMIT 200 LOOP
      PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', r.id)::text, true);
      v_old := (r.role = 'client' AND r.pos_role IS NULL AND r.pos_email IS NULL AND r.ims_role IS NULL
                AND r.hr_role IS NULL AND COALESCE(r.hr_self_service, false) = false);
      IF public.is_client_owner() IS DISTINCT FROM v_old THEN
        RAISE EXCEPTION 'S849 GROUP: is_client_owner() changed its answer for profile %', r.id;
      END IF;
    END LOOP;
    PERFORM set_config('request.jwt.claims', '', true);
  END;
END;
$same2$;


-- ── 2. The clients.group_id trigger (GROUP-1, GROUP-9) ────────────────────────────────────────
-- AFTER UPDATE OF group_id, also on the FK's SET NULL when a group is deleted. SECURITY DEFINER, so
-- its writes pass the admin-only client_groups policies and the write-policy-less access table.
CREATE OR REPLACE FUNCTION public.clear_stale_active_outlet() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'public'
  AS $$
BEGIN
  IF NEW.group_id IS DISTINCT FROM OLD.group_id THEN
    UPDATE profiles SET active_client_id = NULL
     WHERE active_client_id = NEW.id OR client_id = NEW.id;

    -- S849 GROUP-1: an outlet that leaves the group it is HQ of (moved, sold, or made the HQ of a new
    -- group by Create & Assign) stops being that group's HQ. push_master_data copied from it into the
    -- outlets left behind; it now refuses an HQ outside the group as well.
    UPDATE client_groups SET hq_client_id = NULL
     WHERE hq_client_id = NEW.id AND id IS DISTINCT FROM NEW.group_id;

    -- S849 GROUP-9: a grant or an employee link that now crosses groups is not reach (set_active_outlet
    -- needs both outlets in one group), but it stayed: it blocked that person's row in Outlet Access,
    -- listed a stranger on the old outlet's HR Staff, and came back if the outlets regrouped. Both
    -- directions: logins homed here reaching other outlets, and other logins reaching this one.
    DELETE FROM profile_outlet_access a
     USING profiles p, clients hc, clients tc
     WHERE p.id = a.profile_id AND hc.id = p.client_id AND tc.id = a.client_id
       AND (a.client_id = NEW.id OR p.client_id = NEW.id)
       AND NOT COALESCE(hc.group_id = tc.group_id, false);

    DELETE FROM profile_employee_links l
     USING profiles p, clients hc, clients tc
     WHERE p.id = l.profile_id AND hc.id = p.client_id AND tc.id = l.client_id
       AND (l.client_id = NEW.id OR p.client_id = NEW.id)
       AND NOT COALESCE(hc.group_id = tc.group_id, false);
  END IF;
  RETURN NEW;
END;
$$;
-- A trigger function needs no grant (supabase-sql.md); CREATE OR REPLACE keeps the S630 revoke.
REVOKE ALL ON FUNCTION public.clear_stale_active_outlet() FROM PUBLIC, anon, authenticated;


-- ── 3. set_active_outlet: a stock-count PIN stays at its own outlet (GROUP-3) ─────────────────
CREATE OR REPLACE FUNCTION public.set_active_outlet(p_client_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_home_group uuid;
  v_target_group uuid;
  v_allowed boolean;
  v_home uuid;
  v_pin boolean;
  v_count_pin boolean;
BEGIN
  -- Resetting to your OWN outlet stays open to everyone, and must come BEFORE the checks below:
  -- assigning any staff marker demotes an account out of Owner, so an Owner who had switched and
  -- was then given a role would otherwise be stranded at a sibling outlet with no way back.
  IF p_client_id IS NULL THEN
    UPDATE profiles SET active_client_id = NULL WHERE id = (select auth.uid());
    RETURN;
  END IF;

  SELECT p.client_id, p.pos_email IS NOT NULL, p.ims_email IS NOT NULL INTO v_home, v_pin, v_count_pin
    FROM profiles p
   WHERE p.id = (select auth.uid());

  -- S829 5e (S809.4 1g): asking for your home outlet BY ID is the same reset, for every login.
  -- Outlet Access stores no home row, so an allowlisted non-Owner picking home in the switcher was
  -- refused below. NULL is stored, as the reset above stores. A caller with no profile row has a
  -- NULL v_home, so the test is NULL and it falls through to the checks below, which refuse it.
  IF p_client_id = v_home THEN
    UPDATE profiles SET active_client_id = NULL WHERE id = (select auth.uid());
    RETURN;
  END IF;

  -- S809 ACCESS-4: a till PIN login works only at its home outlet, the only one whose tablets can
  -- sign it in. Asking for home is the reset above; any other outlet is refused, even with an
  -- Outlet Access row an older build may have written.
  IF COALESCE(v_pin, false) THEN
    RAISE EXCEPTION 'pos_pin_outlet_pinned: a till PIN login works only at its own outlet, so it cannot switch to another'
      USING ERRCODE = '42501', HINT = 'pos_pin_outlet_pinned';
  END IF;

  -- S849 GROUP-3: a stock-count PIN the same. Its store-room tablet signs it in at home
  -- (ims-staff-login), and a switch stayed on the login, so every later count on that tablet went
  -- into the other outlet's month.
  IF COALESCE(v_count_pin, false) THEN
    RAISE EXCEPTION 'ims_count_pin_outlet_pinned: a stock-count PIN login works only at its own outlet, so it cannot switch to another'
      USING ERRCODE = '42501', HINT = 'ims_count_pin_outlet_pinned';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM profile_outlet_access
     WHERE profile_id = (select auth.uid()) AND client_id = p_client_id
  ) INTO v_allowed;

  -- COALESCE on both identity tests: each reads a profiles row and returns NULL -- not false --
  -- when the caller has none, and IF NOT NULL THEN never fires, so the unwrapped form falls
  -- OPEN for exactly the accounts that could not be identified (S579).
  IF NOT (COALESCE(public.is_admin(), false)
          OR COALESCE(public.is_client_owner(), false)
          OR COALESCE(v_allowed, false)) THEN
    RAISE EXCEPTION 'Not permitted: you do not have access to that outlet.';
  END IF;

  SELECT c.group_id INTO v_home_group
    FROM profiles p JOIN clients c ON c.id = p.client_id
   WHERE p.id = (select auth.uid());

  SELECT group_id INTO v_target_group FROM clients WHERE id = p_client_id;

  -- Fails closed on every ambiguous case: no group, target ungrouped, or different group.
  IF v_home_group IS NULL OR v_target_group IS NULL OR v_home_group <> v_target_group THEN
    RAISE EXCEPTION 'Not permitted: that outlet is not in your group.';
  END IF;

  UPDATE profiles SET active_client_id = p_client_id WHERE id = (select auth.uid());
END;
$function$;
REVOKE ALL ON FUNCTION public.set_active_outlet(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_active_outlet(uuid) TO authenticated, service_role;


-- ── 4. set_outlet_access (GROUP-3, GROUP-9, GROUP-15) ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_outlet_access(p_profile_id uuid, p_client_ids uuid[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_group  uuid;
  v_target_group uuid;
  v_ids    uuid[] := COALESCE(p_client_ids, ARRAY[]::uuid[]);
BEGIN
  IF NOT (COALESCE(public.is_admin(), false) OR COALESCE(public.is_client_owner(), false)) THEN
    RAISE EXCEPTION 'Not permitted.';
  END IF;

  v_group := public.my_group_id();
  IF v_group IS NULL THEN
    RAISE EXCEPTION 'Not permitted: you are not part of an outlet group.';
  END IF;

  -- The SUBJECT must be in my group...
  SELECT c.group_id INTO v_target_group
    FROM profiles p JOIN clients c ON c.id = p.client_id
   WHERE p.id = p_profile_id;
  IF v_target_group IS DISTINCT FROM v_group THEN
    RAISE EXCEPTION 'Not permitted: that account is not in your group.';
  END IF;

  -- S809 ACCESS-4: a till PIN login works only at its own outlet (set_active_outlet refuses it any
  -- other), so a grant would be a reach the matrix shows and nothing honours. An empty list still
  -- passes: it is how a row an older build wrote is cleared.
  IF cardinality(v_ids) > 0
     AND EXISTS (SELECT 1 FROM profiles p WHERE p.id = p_profile_id AND p.pos_email IS NOT NULL) THEN
    RAISE EXCEPTION 'outlet_access_pin_login: a till PIN login works only at its own outlet, so it cannot be given another'
      USING ERRCODE = '42501', HINT = 'outlet_access_pin_login';
  END IF;

  -- S849 GROUP-3: a stock-count PIN the same (set_active_outlet refuses it any other outlet too).
  IF cardinality(v_ids) > 0
     AND EXISTS (SELECT 1 FROM profiles p WHERE p.id = p_profile_id AND p.ims_email IS NOT NULL) THEN
    RAISE EXCEPTION 'outlet_access_count_pin: a stock-count PIN login works only on its own outlet''s tablets, so it cannot be given another'
      USING ERRCODE = '42501', HINT = 'outlet_access_count_pin';
  END IF;

  -- S849 GROUP-15: a Crest Staff (Self-Service) login reads only its own record, and its functions
  -- resolve the outlet from its home, so a grant changes nothing. The matrix no longer lists them.
  IF cardinality(v_ids) > 0
     AND EXISTS (SELECT 1 FROM profiles p WHERE p.id = p_profile_id AND COALESCE(p.hr_self_service, false)) THEN
    RAISE EXCEPTION 'outlet_access_self_service: a Crest Staff self-service login works only at its own outlet, so it cannot be given another'
      USING ERRCODE = '42501', HINT = 'outlet_access_self_service';
  END IF;

  -- ...and so must every outlet being granted. Checked as a set: one stray id fails the whole
  -- call rather than being silently dropped, so the UI can never report a grant that did not
  -- happen. S849 GROUP-9: an outlet this person ALREADY holds but which has since left the group is
  -- not a new grant, so it no longer refuses the row (the matrix could neither show nor untick it);
  -- it is dropped below with every other out-of-group row.
  IF EXISTS (
    SELECT 1 FROM unnest(v_ids) AS want(id)
     WHERE want.id NOT IN (SELECT c2.id FROM clients c2 WHERE c2.group_id = v_group)
       AND NOT EXISTS (SELECT 1 FROM profile_outlet_access a
                        WHERE a.profile_id = p_profile_id AND a.client_id = want.id)
  ) THEN
    RAISE EXCEPTION 'Not permitted: one or more outlets are not in your group.';
  END IF;

  v_ids := ARRAY(SELECT DISTINCT want.id FROM unnest(v_ids) AS want(id)
                  WHERE want.id IN (SELECT c2.id FROM clients c2 WHERE c2.group_id = v_group));

  -- S849 (ACCESS's audit trigger on this table, DATABASE-5): change only what changed. Deleting and
  -- re-inserting the whole list logged every unchanged grant as removed and given again on each Save,
  -- and reset who granted it and when. A grant kept keeps its row.
  DELETE FROM profile_outlet_access a
   WHERE a.profile_id = p_profile_id
     AND a.client_id <> ALL (v_ids);

  INSERT INTO profile_outlet_access (profile_id, client_id, granted_by)
  SELECT p_profile_id, want.id, (select auth.uid()) FROM unnest(v_ids) AS want(id)
  ON CONFLICT (profile_id, client_id) DO NOTHING;

  -- S798 3f-1: a login's employee link at an outlet lives only while the login can open that outlet,
  -- so an untick takes the link with it. Home links (profiles.hr_employee_id) are not in that table.
  DELETE FROM profile_employee_links l
   WHERE l.profile_id = p_profile_id
     AND l.client_id <> ALL (v_ids);

  -- A revoke must EVICT, not merely deny the next switch. Without this, an account already
  -- sitting in an outlet whose access was just removed keeps my_client_id() resolving there
  -- until they happen to switch again -- the same staleness clear_stale_active_outlet() handles
  -- for regrouping.
  UPDATE profiles
     SET active_client_id = NULL
   WHERE id = p_profile_id
     AND active_client_id IS NOT NULL
     AND active_client_id <> client_id
     AND active_client_id <> ALL (v_ids);
END;
$fn$;
REVOKE ALL ON FUNCTION public.set_outlet_access(uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_outlet_access(uuid, uuid[]) TO authenticated, service_role;


-- ── 5. revoke_outlet_access: the subject's group too (GROUP-16, with GROUP-9) ─────────────────
CREATE OR REPLACE FUNCTION public.revoke_outlet_access(p_profile_id uuid, p_client_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_group uuid;
  v_target_group uuid;
  v_subject_group uuid;
BEGIN
  -- set_outlet_access's test: the operator, or an Owner whose group holds the outlet.
  IF NOT (COALESCE(public.is_admin(), false) OR COALESCE(public.is_client_owner(), false)) THEN
    RAISE EXCEPTION 'Not permitted: only the Owner removes a login''s access to an outlet.' USING ERRCODE = '42501';
  END IF;
  IF NOT COALESCE(public.is_admin(), false) THEN
    v_group := public.my_group_id();
    SELECT c.group_id INTO v_target_group FROM clients c WHERE c.id = p_client_id;
    IF v_group IS NULL OR v_target_group IS DISTINCT FROM v_group THEN
      RAISE EXCEPTION 'Not permitted: that outlet is not in your group.' USING ERRCODE = '42501';
    END IF;
    -- S849 GROUP-16: and the login must be one of the group's, as set_outlet_access asks. A grant to
    -- a login of another group cannot exist any more (the clients.group_id trigger removes it).
    SELECT c.group_id INTO v_subject_group
      FROM profiles p JOIN clients c ON c.id = p.client_id
     WHERE p.id = p_profile_id;
    IF v_subject_group IS DISTINCT FROM v_group THEN
      RAISE EXCEPTION 'Not permitted: that account is not in your group.' USING ERRCODE = '42501';
    END IF;
  END IF;

  DELETE FROM profile_outlet_access a WHERE a.profile_id = p_profile_id AND a.client_id = p_client_id;
  DELETE FROM profile_employee_links l WHERE l.profile_id = p_profile_id AND l.client_id = p_client_id;
  -- A revoke evicts, as set_outlet_access does: a window sitting in the outlet stops resolving there.
  UPDATE profiles
     SET active_client_id = NULL
   WHERE id = p_profile_id
     AND active_client_id = p_client_id
     AND active_client_id <> client_id;
END;
$function$;
REVOKE ALL ON FUNCTION public.revoke_outlet_access(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revoke_outlet_access(uuid, uuid) TO authenticated, service_role;


-- ── 6. get_outlet_reaching_logins: the group's logins only (GROUP-9) ──────────────────────────
CREATE OR REPLACE FUNCTION public.get_outlet_reaching_logins(p_client_id uuid)
 RETURNS TABLE(profile_id uuid, full_name text, home_client_name text, hr_role text, ims_role text, pos_role text,
               linked_employee_id uuid, linked_employee_name text, linked_employee_code text, email_employee_name text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- HR Staff's readers: the operator, the Owner or an HR manager, at this outlet.
  IF NOT COALESCE(public.is_admin() OR (p_client_id = public.my_client_id() AND public.hr_is_manager_rank()), false) THEN
    RAISE EXCEPTION 'Not permitted: only the Owner or an HR manager of this outlet sees who can open it.' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT p.id,
         p.full_name::text,
         hc.name::text,
         p.hr_role::text,
         p.ims_role::text,
         p.pos_role::text,
         le.id,
         le.full_name::text,
         le.employee_code::text,
         (SELECT em.full_name FROM hr_employees em
           WHERE em.client_id = p_client_id
             AND NULLIF(btrim(em.email), '') IS NOT NULL
             AND lower(btrim(em.email)) = lower(u.email::text)
           ORDER BY em.full_name LIMIT 1)::text
    FROM profile_outlet_access a
    JOIN profiles p ON p.id = a.profile_id
    JOIN clients hc ON hc.id = p.client_id
    JOIN clients tc ON tc.id = p_client_id
    LEFT JOIN auth.users u ON u.id = p.id
    LEFT JOIN profile_employee_links l ON l.profile_id = p.id AND l.client_id = p_client_id
    LEFT JOIN hr_employees le ON le.id = l.employee_id
   WHERE a.client_id = p_client_id
     AND p.client_id <> p_client_id
     AND p.role = 'client'
     -- S849 GROUP-9: a grant from another group is not reach (set_active_outlet needs one group), and
     -- listed a stranger's name, home outlet and ranks on this outlet's HR Staff.
     AND COALESCE(hc.group_id = tc.group_id, false)
   ORDER BY p.full_name;
END;
$function$;
REVOKE ALL ON FUNCTION public.get_outlet_reaching_logins(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_outlet_reaching_logins(uuid) TO authenticated, service_role;


-- ── 7. get_group_outlet_access: the Owner test, the kind of login, the group's grants ─────────
-- (GROUP-15 + DATABASE-6, GROUP-3, GROUP-9.) A new column, so DROP + CREATE (42P13).
DROP FUNCTION IF EXISTS public.get_group_outlet_access();
DROP FUNCTION IF EXISTS public.get_group_outlet_access(uuid);
CREATE FUNCTION public.get_group_outlet_access(p_group_id uuid DEFAULT NULL::uuid)
  RETURNS TABLE (
    profile_id         uuid,
    full_name          text,
    home_client_id     uuid,
    home_client_name   text,
    pos_role           text,
    ims_role           text,
    hr_role            text,
    is_owner           boolean,
    login_kind         text,
    allowed_client_ids uuid[]
  )
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path TO 'public'
  AS $fn$
DECLARE
  v_group uuid;
BEGIN
  -- S849 ACCESS-8: Crest support reads a client's matrix by naming its group (read only — the
  -- writes, set_outlet_access and revoke_outlet_access, stay the Owner's and resolve the group from
  -- the caller's own home client). COALESCE'd: is_admin() is NULL for a caller with no profile.
  IF p_group_id IS NOT NULL THEN
    IF NOT COALESCE(public.is_admin(), false) THEN
      RAISE EXCEPTION 'Not permitted: only Crest support can read a group by its id.' USING ERRCODE = '42501';
    END IF;
    v_group := p_group_id;
  ELSE
    IF NOT (COALESCE(public.is_admin(), false) OR COALESCE(public.is_client_owner(), false)) THEN
      RAISE EXCEPTION 'Not permitted.';
    END IF;
    v_group := public.my_group_id();
  END IF;
  IF v_group IS NULL THEN RETURN; END IF;   -- ungrouped: an empty matrix, not an error

  -- S849: is_owner is is_client_owner()'s own test (profile_is_owner), not a fourth copy without the
  -- till-PIN marker. login_kind tells the matrix which logins can be given an outlet at all:
  -- 'owner' (reaches every outlet), 'till_pin' and 'count_pin' (their own outlet's tablets only),
  -- 'staff' (an email login of any rank). Crest Staff (Self-Service) logins are left out: a tick there
  -- granted nothing. allowed_client_ids holds only outlets in the group, so a stale grant cannot
  -- block the row's Save.
  RETURN QUERY
  SELECT p.id,
         p.full_name,
         p.client_id,
         c.name,
         p.pos_role,
         p.ims_role,
         p.hr_role,
         public.profile_is_owner(p),
         CASE WHEN public.profile_is_owner(p) THEN 'owner'
              WHEN p.pos_email IS NOT NULL THEN 'till_pin'
              WHEN p.ims_email IS NOT NULL THEN 'count_pin'
              ELSE 'staff' END,
         COALESCE(ARRAY(SELECT a.client_id
                          FROM profile_outlet_access a
                          JOIN clients ac ON ac.id = a.client_id
                         WHERE a.profile_id = p.id AND ac.group_id = v_group
                         ORDER BY a.client_id),
                  ARRAY[]::uuid[])
    FROM profiles p
    JOIN clients c ON c.id = p.client_id
   WHERE c.group_id = v_group
     AND p.role = 'client'
     AND NOT COALESCE(p.hr_self_service, false)
   ORDER BY c.name, p.full_name;
END;
$fn$;
REVOKE ALL ON FUNCTION public.get_group_outlet_access(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_group_outlet_access(uuid) TO authenticated, service_role;


-- ── 8. get_group_summary (ACCESS-1 + PNL-9, GROUP-5 + DOCS-2, PNL-8 transfers, GAPS-5 / OD-8) ──
-- Rebuilt from the LIVE body: 20261010170000's with the S836 part-bill patch (20261014120000).
-- Two new parameters (p_through_day, p_group_id, both DEFAULT NULL) and two new columns, so DROP +
-- CREATE. The old 4-argument form is dropped, not kept: a 4-key call (an older cached bundle) resolves
-- to this one through the defaults, which is strictly better than reaching the old body (supabase-sql.md).
-- No overload is left: the 4-arg live form, any 5-arg form, and (on a re-run) this 6-arg one are
-- dropped first. A call with 4 or 5 keys resolves to the 6-arg form through its defaults.
DROP FUNCTION IF EXISTS public.get_group_summary(integer, integer, date, date);
DROP FUNCTION IF EXISTS public.get_group_summary(integer, integer, date, date, integer);
DROP FUNCTION IF EXISTS public.get_group_summary(integer, integer, date, date, integer, uuid);
CREATE FUNCTION public.get_group_summary(p_bs_year integer, p_bs_month integer, p_ad_start date DEFAULT NULL::date, p_ad_end date DEFAULT NULL::date, p_through_day integer DEFAULT NULL::integer, p_group_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(client_id uuid, client_name text, is_included boolean, has_period boolean, revenue numeric, net_purchases numeric, payroll numeric, covers bigint, revenue_counted numeric, net_purchases_counted numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_group uuid;
  v_from  timestamptz;
  v_to    timestamptz;
BEGIN
  -- COALESCE on both: each reads a profiles row and returns NULL rather than false when the
  -- caller has none, and NULL OR NULL is NULL, which NOT() leaves NULL, which never fires the
  -- branch -- the fail-open shape S579 documents. Group figures are owner-altitude by
  -- definition: this is the one screen in the product that crosses tenants.
  -- S849 ACCESS-8 (owner decision: build a support view). p_group_id names the group to read, and
  -- only Crest support may name one; it is COALESCE'd, because is_admin() is NULL for a caller with
  -- no profile (S630). Everyone else reads the group of their own HOME client, as before, so neither
  -- an outlet switch nor this parameter walks an Owner into another group. Reads only: every write
  -- (push_master_data, set_outlet_access, revoke_outlet_access) stays the Owner's.
  IF p_group_id IS NOT NULL THEN
    IF NOT COALESCE(public.is_admin(), false) THEN
      RAISE EXCEPTION 'Not permitted: only Crest support can read a group by its id.' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM client_groups g WHERE g.id = p_group_id) THEN
      RAISE EXCEPTION 'That outlet group does not exist.' USING ERRCODE = 'P0002';
    END IF;
    v_group := p_group_id;
  ELSE
    IF NOT (COALESCE(public.is_admin(), false) OR COALESCE(public.is_client_owner(), false)) THEN
      RAISE EXCEPTION 'Not permitted: only an owner can see group figures.';
    END IF;

    v_group := public.my_group_id();
    IF v_group IS NULL THEN
      RAISE EXCEPTION 'Not permitted: you are not part of an outlet group.';
    END IF;
  END IF;

  -- S809 3n (GAP-OUTLETS-3): the month's guests are cut at Nepal's midnight, not the server's.
  -- `date::timestamptz` runs under the server's TimeZone (UTC), so the old bounds began and ended
  -- the BS month at 05:45 Nepal time. The month's AD days come from bs_months, so the guests and
  -- the revenue (the period) are always the same BS month; the page's p_ad_start / p_ad_end are
  -- used only for a month bs_months does not hold (outside BS 2000-2087), as the page's own
  -- conversion, cut at Nepal's midnight too.
  SELECT bm.ad_start::timestamp AT TIME ZONE 'Asia/Kathmandu',
         (bm.ad_start + bm.days)::timestamp AT TIME ZONE 'Asia/Kathmandu'
    INTO v_from, v_to
    FROM bs_months bm
   WHERE bm.bs_year = p_bs_year AND bm.bs_month = p_bs_month;
  IF v_from IS NULL AND p_ad_start IS NOT NULL AND p_ad_end IS NOT NULL THEN
    v_from := p_ad_start::timestamp AT TIME ZONE 'Asia/Kathmandu';
    v_to   := (p_ad_end + 1)::timestamp AT TIME ZONE 'Asia/Kathmandu';
  END IF;

  -- S849, rebuilt from the live body (20261010170000 + the S836 part-bill line):
  --   ACCESS-1 (+ PNL-9): an outlet is in the figures while its Crest Suite Pro is LIVE — the browser
  --     gate's rule (suiteLive), through its SQL twin client_suite_live (ACCESS). suite_plan = 'pro'
  --     alone kept a lapsed outlet's revenue in the group totals for good. NULL is excluded.
  --   GROUP-5 (+ DOCS-2): net purchases on the outlet's own Owner Dashboard basis (D32): each line less
  --     its share of its bill's ONE discount, × 1.13 on a VAT-ticked line of a vat_is_cost bill (the VAT
  --     a PAN-only outlet cannot claim); returns on the basis of the line they went back against (an
  --     unlinked return stays ex-VAT) — allocateBillDiscounts' lineCost and returnCostValue.
  --   PNL-8 (SU10 a): stock transferred in from a sister outlet is the receiver's food spend and stock
  --     sent out is not the sender's, at the transfer's own frozen value — get_group_pnl's rule. A
  --     transfer line exists only while it counts for its outlet (the branch's 'in' leg is written when
  --     it confirms receipt, in its own month; a cancellation writes reversing legs), so summing the
  --     rows by direction is the whole rule.
  --   GAPS-5 / OD-8: p_through_day (the running month's last FINISHED day, mtdClock.countedDays) gives
  --     revenue_counted / net_purchases_counted over those days only, so a ratio never divides a part-
  --     month by today's half-day. A row with no day (a Bulk sales row, bs_day 0, or an undated return)
  --     always counts, as inCountedDays does. NULL = every day (a past month).
  RETURN QUERY
  WITH outlets AS (
    SELECT c.id, c.name, COALESCE(public.client_suite_live(c.id), false) AS included
      FROM clients c
     WHERE c.group_id = v_group
  ),
  per AS (
    SELECT o.id AS cid, mp.id AS period_id
      FROM outlets o
      LEFT JOIN monthly_periods mp
        ON mp.client_id = o.id AND mp.bs_year = p_bs_year AND mp.bs_month = p_bs_month
  )
  SELECT
    o.id,
    o.name,
    o.included,
    (per.period_id IS NOT NULL),
    CASE WHEN o.included THEN COALESCE(rv.full_amt, 0) END,
    CASE WHEN o.included THEN COALESCE(pu.full_amt, 0) - COALESCE(rt.full_amt, 0) + COALESCE(tr.full_amt, 0) END,
    CASE WHEN o.included THEN COALESCE((
      -- S798 3c (H19): pay EARNED — gross less the absence deduction — as payrollLabourTotal.
      SELECT sum(ps.gross - COALESCE(ps.absence_deduction, 0) + COALESCE(ps.ot_amount, 0) + COALESCE(ps.ssf_employer, 0))
        FROM hr_payslips ps JOIN hr_payroll_runs pr ON pr.id = ps.run_id
       WHERE pr.client_id = o.id AND pr.period_id = per.period_id AND pr.status = 'finalized'
    ), 0) END,
    -- S809 3n (GAP-OUTLETS-3, REPORTS-3): guests SEATED, the Covers Report's count
    -- (coversMath.seatedCovers, owner decision S754): a paid bill served at a table. A takeaway or
    -- delivery bill has no table and its "covers" is the till's default; a bill later credit-noted
    -- keeps its guests.
    CASE WHEN o.included AND v_from IS NOT NULL THEN COALESCE((
      SELECT sum(po.covers)::bigint FROM pos_orders po
       WHERE po.client_id = o.id
         AND po.close_type = 'paid'
         -- S836: a part bill (pay part now) was served at a table too, though it has none of its own.
         AND (po.table_id IS NOT NULL OR po.part_of_order_id IS NOT NULL)
         AND po.closed_at >= v_from
         AND po.closed_at <  v_to
    ), 0) ELSE 0 END,
    CASE WHEN o.included THEN COALESCE(rv.counted_amt, 0) END,
    CASE WHEN o.included THEN COALESCE(pu.counted_amt, 0) - COALESCE(rt.counted_amt, 0) + COALESCE(tr.counted_amt, 0) END
  FROM outlets o
  JOIN per ON per.cid = o.id
  -- Revenue: qty × the price charged (else the recipe's) − the row's discount, comps out NULL-safely.
  LEFT JOIN LATERAL (
    SELECT sum(x.amt) AS full_amt,
           sum(x.amt) FILTER (WHERE p_through_day IS NULL OR COALESCE(x.bs_day, 0) = 0 OR x.bs_day <= p_through_day) AS counted_amt
      FROM (
        SELECT se.qty_sold * COALESCE(se.unit_price, r.selling_price, 0) - COALESCE(se.discount, 0) AS amt, se.bs_day
          FROM sales_entries se JOIN recipes r ON r.id = se.recipe_id
         WHERE se.period_id = per.period_id AND se.source IS DISTINCT FROM 'pos_comp'
      ) x
  ) rv ON o.included
  -- Purchases on the cost basis: one row per line with its bill's one discount shared by line value.
  LEFT JOIN LATERAL (
    SELECT sum(x.cost) AS full_amt,
           sum(x.cost) FILTER (WHERE p_through_day IS NULL OR x.bs_day <= p_through_day) AS counted_amt
      FROM (
        SELECT (l.line - COALESCE(b.discount, 0) * l.line / NULLIF(b.gross, 0)) * l.factor AS cost, l.bs_day
          FROM (
            SELECT pe.qty * pe.rate AS line,
                   CASE WHEN COALESCE(pe.vat_inclusive, false) AND pe.vat_is_cost THEN 1.13 ELSE 1 END AS factor,  -- D32
                   pe.bs_day,
                   COALESCE(
                     pe.purchase_group_id::text,
                     COALESCE(pe.vendor_id::text, '') || '|' ||
                     COALESCE(pe.invoice_ref, '')     || '|' ||
                     COALESCE(pe.bs_day::text, ''))   AS bill_key
              FROM purchase_entries pe
             WHERE pe.period_id = per.period_id
          ) l
          JOIN (
            -- One row per bill: its gross over all lines and its ONE discount (max, not sum -- the
            -- value is repeated on every line). Bill identity mirrors billKeyOf().
            SELECT COALESCE(
                     pe.purchase_group_id::text,
                     COALESCE(pe.vendor_id::text, '') || '|' ||
                     COALESCE(pe.invoice_ref, '')     || '|' ||
                     COALESCE(pe.bs_day::text, ''))   AS bill_key,
                   sum(pe.qty * pe.rate)                AS gross,
                   max(COALESCE(pe.discount_amount, 0)) AS discount
              FROM purchase_entries pe
             WHERE pe.period_id = per.period_id
             GROUP BY 1
          ) b ON b.bill_key = l.bill_key
      ) x
  ) pu ON o.included
  -- Returns at list value × their line's basis (D32); an unlinked return stays ex-VAT.
  LEFT JOIN LATERAL (
    SELECT sum(x.val) AS full_amt,
           sum(x.val) FILTER (WHERE p_through_day IS NULL OR COALESCE(x.bs_day, 0) = 0 OR x.bs_day <= p_through_day) AS counted_amt
      FROM (
        SELECT vr.qty * vr.rate
                 * CASE WHEN COALESCE(lp.vat_inclusive, false) AND COALESCE(lp.vat_is_cost, false) THEN 1.13 ELSE 1 END AS val,  -- D32
               vr.bs_day
          FROM vendor_returns vr
          LEFT JOIN purchase_entries lp ON lp.id = vr.purchase_entry_id
         WHERE vr.period_id = per.period_id
      ) x
  ) rt ON o.included
  -- Stock transfers between sister outlets (PNL-8): in adds, out takes off, at the frozen value.
  LEFT JOIN LATERAL (
    SELECT sum(x.val) AS full_amt,
           sum(x.val) FILTER (WHERE p_through_day IS NULL OR x.bs_day <= p_through_day) AS counted_amt
      FROM (
        SELECT CASE WHEN tl.direction = 'in' THEN tl.value ELSE -tl.value END AS val, tl.bs_day
          FROM ims_stock_transfer_lines tl
         WHERE tl.period_id = per.period_id
      ) x
  ) tr ON o.included
  ORDER BY o.name;
END;
$function$;
REVOKE ALL ON FUNCTION public.get_group_summary(integer, integer, date, date, integer, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_group_summary(integer, integer, date, date, integer, uuid) TO authenticated, service_role;


-- ── 9. get_group_item_prices (ACCESS-1, GROUP-16 / SU22) ──────────────────────────────────────
-- p_group_id (support view) changes the signature: DROP + CREATE, no overload left.
DROP FUNCTION IF EXISTS public.get_group_item_prices(integer, integer);
DROP FUNCTION IF EXISTS public.get_group_item_prices(integer, integer, uuid);
CREATE FUNCTION public.get_group_item_prices(p_bs_year integer, p_bs_month integer, p_group_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(item_key uuid, client_id uuid, client_name text, item_name text, uom text, qty numeric, net_value numeric, lines integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_group uuid;
BEGIN
  -- S849 ACCESS-8 (owner decision: build a support view). p_group_id names the group to read, and
  -- only Crest support may name one; it is COALESCE'd, because is_admin() is NULL for a caller with
  -- no profile (S630). Everyone else reads the group of their own HOME client, as before, so neither
  -- an outlet switch nor this parameter walks an Owner into another group. Reads only: every write
  -- (push_master_data, set_outlet_access, revoke_outlet_access) stays the Owner's.
  IF p_group_id IS NOT NULL THEN
    IF NOT COALESCE(public.is_admin(), false) THEN
      RAISE EXCEPTION 'Not permitted: only Crest support can read a group by its id.' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM client_groups g WHERE g.id = p_group_id) THEN
      RAISE EXCEPTION 'That outlet group does not exist.' USING ERRCODE = 'P0002';
    END IF;
    v_group := p_group_id;
  ELSE
    IF NOT (COALESCE(public.is_admin(), false) OR COALESCE(public.is_client_owner(), false)) THEN
      RAISE EXCEPTION 'Not permitted: only an owner can see group figures.';
    END IF;

    v_group := public.my_group_id();
    IF v_group IS NULL THEN
      RAISE EXCEPTION 'Not permitted: you are not part of an outlet group.';
    END IF;
  END IF;
  -- S849 ACCESS-1: an outlet is compared while its Crest Suite Pro is LIVE (client_suite_live, the
  -- browser gate's rule), not merely while suite_plan says 'pro'.
  -- S849 SU22 (GROUP-16): a free line (rate 0, a sample or a "buy 10 get 1") is not a price. It was
  -- averaged in, so an outlet given 5 kg free read cheapest and charged its sister "above the lowest".
  RETURN QUERY
  WITH per AS (
    SELECT c.id AS cid, c.name AS cname, mp.id AS period_id
      FROM clients c
      JOIN monthly_periods mp
        ON mp.client_id = c.id AND mp.bs_year = p_bs_year AND mp.bs_month = p_bs_month
     WHERE c.group_id = v_group
       AND COALESCE(public.client_suite_live(c.id), false)
  ),
  -- One row per bill per period: its single discount, and its gross over ALL lines (get_group_pnl's).
  bill AS (
    SELECT pe.period_id,
           COALESCE(
             pe.purchase_group_id::text,
             COALESCE(pe.vendor_id::text, '') || '|' ||
             COALESCE(pe.invoice_ref, '')     || '|' ||
             COALESCE(pe.bs_day::text, '')
           )                                    AS bill_key,
           max(COALESCE(pe.discount_amount, 0)) AS discount,
           sum(pe.qty * pe.rate)                AS gross
      FROM purchase_entries pe
      JOIN per ON per.period_id = pe.period_id
     GROUP BY 1, 2
  ),
  line AS (
    SELECT COALESCE(i.master_id, i.id) AS k,
           per.cid,
           per.cname,
           i.name AS iname,
           i.uom  AS iuom,
           pe.qty AS q,
           pe.qty * pe.rate
             - COALESCE(b.discount, 0) * (pe.qty * pe.rate) / NULLIF(b.gross, 0) AS v
      FROM per
      JOIN purchase_entries pe ON pe.period_id = per.period_id
      JOIN items i ON i.id = pe.item_id AND NOT i.is_sub_recipe
      LEFT JOIN bill b
        ON b.period_id = pe.period_id
       AND b.bill_key  = COALESCE(
             pe.purchase_group_id::text,
             COALESCE(pe.vendor_id::text, '') || '|' ||
             COALESCE(pe.invoice_ref, '')     || '|' ||
             COALESCE(pe.bs_day::text, '')
           )
     WHERE pe.qty > 0
       AND pe.rate > 0
  ),
  agg AS (
    SELECT l.k, l.cid, l.cname, l.iuom,
           min(l.iname)    AS iname,
           sum(l.q)        AS q,
           sum(l.v)        AS v,
           count(*)::integer AS n
      FROM line l
     GROUP BY l.k, l.cid, l.cname, l.iuom
  ),
  shared AS (
    SELECT a.k FROM agg a GROUP BY a.k HAVING count(DISTINCT a.cid) >= 2
  )
  SELECT a.k,
         a.cid,
         a.cname::text,
         a.iname::text,
         a.iuom::text,
         a.q::numeric,
         a.v::numeric,
         a.n
    FROM agg a
    JOIN shared s ON s.k = a.k
   -- Lead, S849 merge (review M4): by outlet id, not name, on purpose: GROUP-6 pages this read with
   -- fetchAllRows on (item_key, client_id, uom), and a name is not unique.
   ORDER BY a.k, a.cid, a.iuom;
END;
$function$;
REVOKE ALL ON FUNCTION public.get_group_item_prices(integer, integer, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_group_item_prices(integer, integer, uuid) TO authenticated, service_role;


-- ── 10. push_master_data (GROUP-1, GROUP-2, GROUP-6, GROUP-7, GROUP-12) ───────────────────────
-- Rebuilt from the S840 body (20261015100000), every edit marked "S849". The return shape changes
-- (GROUP-6), so DROP + CREATE, and the grants are re-issued.
DROP FUNCTION IF EXISTS public.push_master_data(uuid[], text[], boolean);
CREATE FUNCTION public.push_master_data(p_target_client_ids uuid[], p_entities text[], p_dry_run boolean DEFAULT true)
 RETURNS TABLE(row_no bigint, row_kind text, target_client_id uuid, target_client_name text, entity text, action text, record_name text, detail text, row_n integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- The apply loops read _plan by bare column names (entity, action, target_client_id) that are also
-- this function's RETURNS TABLE columns, so every non-dry-run push raised 42702 "column reference
-- is ambiguous" — since 20260827150000; only the preview ever ran. Every such name means the
-- column: the OUT columns are only ever filled by RETURN QUERY (S792 stage 3 dry run).
#variable_conflict use_column
-- S849 (Suite review S848): GROUP-1 the HQ must still be in the group; GROUP-2 (owner SU2 a) a dish
-- whose HQ ingredient has no match at the branch is kept whole and listed as skipped, planned in the
-- preview, and no list is ever shortened; GROUP-6 the result is a total row, one count row per
-- branch × entity × action, then the rows (every row on a preview, the ones needing a look after a
-- push) with row_no to page by; GROUP-7 duplicate dish names, a dish code held elsewhere, and
-- categories differing only in capitals are planned as conflicts; GROUP-12 (owner SU8 a) the Veg /
-- Egg / Non-veg mark follows HQ, each change named, and a new dish takes HQ's description.
DECLARE
  v_group  uuid;
  v_hq     uuid;
  v_target uuid;
  v_tname  text;
  v_do_cat boolean := 'categories' = ANY (p_entities);
  v_do_itm boolean := 'items'      = ANY (p_entities);
  v_do_rec boolean := 'recipes'    = ANY (p_entities);
  v_do_prc boolean := 'prices'     = ANY (p_entities);
  -- S838: Crest Customization's choices, with the dishes they belong to.
  v_do_opt boolean := 'options'    = ANY (p_entities);
  r        record;
  v_dst    uuid;
  v_item   uuid;
  v_cat    uuid;
  v_lines  integer;
  v_skipped integer;
  v_cleared integer;
  v_grp    uuid;
  v_opt    uuid;
  -- S840: combos
  v_cmb    uuid;
  v_bg     uuid;
  v_sg     record;
  -- The sub-recipe mirror's name, and the branch item already holding it (S707).
  v_mname    text;
  v_conflict text;
  -- Whether HQ and this branch bill VAT (S792 stage 3). The till reads a missing or NULL flag as
  -- VAT-registered (menuPriceVat.js vatModeOf), so this does too.
  v_hq_vat      boolean;
  v_t_vat       boolean;
  v_vat_differs boolean;
  v_vat_why     text;
BEGIN
  -- Same owner-altitude test as get_group_summary: this writes across tenant boundaries, which is
  -- the most privileged thing any non-admin action in this product does. COALESCE because both
  -- helpers return NULL rather than false for a caller with no profiles row (S579).
  IF NOT (COALESCE(public.is_admin(), false) OR COALESCE(public.is_client_owner(), false)) THEN
    RAISE EXCEPTION 'Not permitted: only an owner can push master data.';
  END IF;

  v_group := public.my_group_id();
  IF v_group IS NULL THEN
    RAISE EXCEPTION 'Not permitted: you are not part of an outlet group.';
  END IF;

  SELECT hq_client_id INTO v_hq FROM client_groups WHERE id = v_group;
  IF v_hq IS NULL THEN
    RAISE EXCEPTION 'This group has no HQ outlet set, so there is nothing to push from.';
  END IF;

  -- S849 GROUP-1: hq_client_id is only ever tested for NULL above, so an HQ outlet that left the
  -- group (sold, moved, or Create & Assign'd into a new group) stayed the source of every push into
  -- the outlets left behind: another business's items, purchase rates, recipes and prices. The
  -- clients.group_id trigger now clears such an HQ; this refuses one that is still recorded.
  IF NOT COALESCE((SELECT c.group_id = v_group FROM clients c WHERE c.id = v_hq), false) THEN
    RAISE EXCEPTION 'group_hq_outside: this group''s HQ outlet is no longer in the group, so there is nothing to push from. Ask Crest support to set a new HQ outlet.'
      USING ERRCODE = '42501', HINT = 'group_hq_outside';
  END IF;

  -- S838: a choice group means nothing without the dishes it sits on, and a stock line nothing
  -- without the sub-recipe it names.
  IF v_do_opt AND NOT v_do_rec THEN
    RAISE EXCEPTION 'Choices are pushed with their dishes: tick Recipes as well.';
  END IF;

  -- Every target must be in my group and must not be the HQ itself. Checked as a set so one bad
  -- id fails the whole call rather than being silently dropped (same rule as set_outlet_access).
  IF EXISTS (
    SELECT 1 FROM unnest(COALESCE(p_target_client_ids, ARRAY[]::uuid[])) AS t(id)
     WHERE t.id = v_hq
        OR t.id NOT IN (SELECT c.id FROM clients c WHERE c.group_id = v_group)
  ) THEN
    RAISE EXCEPTION 'Not permitted: one or more targets are not branches of your group.';
  END IF;

  v_hq_vat := COALESCE((SELECT s.is_vat_registered FROM settings s WHERE s.client_id = v_hq), true);
  v_vat_why := CASE WHEN v_hq_vat
                    THEN 'HQ adds VAT to its menu prices and this branch issues PAN bills without VAT'
                    ELSE 'HQ issues PAN bills without VAT and this branch adds VAT to its menu prices' END;

  -- vat_differs (S792 stage 3) is set on recipe rows and, since S838, choice rows: whether this
  -- price must stay the branch's own. The other entities leave it NULL.
  -- S835: dropped first. ON COMMIT DROP keeps it until the transaction ends, so a second call in
  -- one transaction failed with 42P07.
  DROP TABLE IF EXISTS pg_temp._plan;
  CREATE TEMP TABLE _plan (
    target_client_id uuid, target_client_name text,
    entity text, action text, record_name text, detail text,
    src_id uuid, dst_id uuid, vat_differs boolean,
    -- S849 GROUP-2: the HQ ingredient (or choice stock) lines with no counterpart at this branch.
    missing text
  ) ON COMMIT DROP;

  ----------------------------------------------------------------------------------------------
  -- PLAN. Pure SELECTs -- nothing below writes. The preview an operator approves IS this plan,
  -- so what they read and what applies cannot diverge into two implementations.
  ----------------------------------------------------------------------------------------------
  FOREACH v_target IN ARRAY COALESCE(p_target_client_ids, ARRAY[]::uuid[]) LOOP
    SELECT name INTO v_tname FROM clients WHERE id = v_target;
    v_t_vat := COALESCE((SELECT s.is_vat_registered FROM settings s WHERE s.client_id = v_target), true);
    v_vat_differs := v_t_vat IS DISTINCT FROM v_hq_vat;

    IF v_do_cat THEN
      -- S849 GROUP-7: categories_client_name_unique is case-sensitive while the adopt match is not, so
      -- two branch categories differing only in capitals both matched, and the second write raised
      -- 23505 and rolled back the whole push. `a` now counts the matches and adopts only a single one;
      -- `x` is any OTHER branch category already holding HQ's exact name, which the write would collide
      -- with. Either is a conflict, reported and skipped like an item's.
      INSERT INTO _plan
      SELECT v_target, v_tname, 'categories',
             CASE WHEN x.name IS NOT NULL OR (d.id IS NULL AND a.n > 1) THEN 'conflict'
                  WHEN d.id IS NOT NULL THEN 'update'
                  WHEN a.n = 1 THEN 'adopt'
                  ELSE 'create' END,
             s.name,
             CASE WHEN d.id IS NULL AND a.n > 1
                    THEN 'skipped - this branch has ' || a.n || ' categories called "' || a.names ||
                         '" (they differ only in capitals), so Crest cannot tell which one is HQ''s. Rename or merge them, then push again.'
                  WHEN x.name IS NOT NULL
                    THEN 'skipped - this branch already has a different category called "' || x.name ||
                         '". Rename one of them, then push again.'
                  WHEN d.id IS NULL AND a.n = 1 THEN 'matched an existing category of the same name' END,
             s.id,
             CASE WHEN x.name IS NOT NULL OR (d.id IS NULL AND a.n > 1) THEN NULL
                  ELSE COALESCE(d.id, CASE WHEN a.n = 1 THEN a.id END) END
        FROM categories s
        LEFT JOIN categories d ON d.client_id = v_target AND d.master_id = s.id
        LEFT JOIN LATERAL (
          SELECT count(*)::integer AS n,
                 (array_agg(c.id ORDER BY c.id))[1] AS id,
                 string_agg(c.name, '", "' ORDER BY c.name) AS names
            FROM categories c
           WHERE d.id IS NULL AND c.client_id = v_target AND c.master_id IS NULL
             AND lower(c.name) = lower(s.name)
        ) a ON true
        LEFT JOIN LATERAL (
          SELECT c.name
            FROM categories c
           WHERE c.client_id = v_target AND c.name = s.name
             AND c.id IS DISTINCT FROM COALESCE(d.id, CASE WHEN a.n = 1 THEN a.id END)
           LIMIT 1
        ) x ON true
       WHERE s.client_id = v_hq;
    END IF;

    IF v_do_itm THEN
      -- is_sub_recipe rows are excluded: they are mirrors owned by the recipe machinery, created
      -- at the branch by the recipes pass below. Pushing them as ordinary items would race that.
      -- `x` is any OTHER branch row already holding this name -- neither the master-linked row we
      -- would update nor the unlinked row we would adopt. Its existence means writing s.name into
      -- this branch violates items_client_name_key, so the row is planned as 'conflict' and the
      -- apply pass below skips it. LATERAL rather than a fourth LEFT JOIN because the predicate
      -- has to reference d.id and a.id, which a plain join cannot.
      -- `u` (S792) is the branch row we would update or adopt when its unit differs from HQ's and
      -- it has recorded history: writing HQ's unit would re-read that history (D5), so it too is a
      -- 'conflict'.
      INSERT INTO _plan
      SELECT v_target, v_tname, 'items',
             CASE WHEN x.id IS NOT NULL THEN 'conflict'
                  WHEN u.uom IS NOT NULL THEN 'conflict'
                  WHEN d.id IS NOT NULL THEN 'update'
                  WHEN a.id IS NOT NULL THEN 'adopt'
                  ELSE 'create' END,
             s.name,
             CASE WHEN x.id IS NOT NULL
                    THEN 'skipped - this branch already has a different ' ||
                         CASE WHEN COALESCE(x.is_sub_recipe, false) THEN 'sub-recipe' ELSE 'item' END ||
                         ' called "' || x.name || '". Rename one of them, then push again.'
                  WHEN u.uom IS NOT NULL
                    THEN 'skipped - this branch records it in ' || u.uom || ' and HQ uses ' || COALESCE(s.uom, 'no unit') ||
                         '. Changing the unit would re-read every count and bill already recorded at this branch. ' ||
                         'Keep the branch item as it is, or create a separate item for the new unit.'
                  WHEN a.id IS NOT NULL AND d.id IS NULL THEN 'matched an existing item of the same name'
                  WHEN d.id IS NOT NULL THEN 'definition only - this branch keeps its own rate' END,
             s.id, COALESCE(d.id, a.id)
        FROM items s
        LEFT JOIN items d ON d.client_id = v_target AND d.master_id = s.id
        LEFT JOIN items a ON a.client_id = v_target AND a.master_id IS NULL
                         AND COALESCE(a.is_sub_recipe, false) = false AND lower(a.name) = lower(s.name)
        LEFT JOIN LATERAL (
          SELECT c.id, c.name, c.is_sub_recipe
            FROM items c
           WHERE c.client_id = v_target
             AND lower(c.name) = lower(s.name)
             AND (d.id IS NULL OR c.id <> d.id)
             AND (a.id IS NULL OR c.id <> a.id)
           LIMIT 1
        ) x ON true
        LEFT JOIN LATERAL (
          SELECT b.uom
            FROM items b
           WHERE b.id = COALESCE(d.id, a.id)
             AND b.uom IS DISTINCT FROM s.uom
             AND public.item_has_references(b.id)
        ) u ON true
       WHERE s.client_id = v_hq AND COALESCE(s.is_sub_recipe, false) = false;
    END IF;

    IF v_do_rec THEN
      -- recipe_code is uniquely indexed per client, so it is tried before name: adopting by name
      -- while a DIFFERENT branch recipe already holds the incoming code would fail the insert.
      -- A branch whose VAT status differs from HQ's (S792 stage 3) keeps its own price and VAT
      -- rate on every dish it already has, and gets new dishes off the till with no price: HQ's
      -- stored price is a different guest price there. A sub-recipe is never sold, so it is exempt.
      INSERT INTO _plan
      SELECT v_target, v_tname, 'recipes',
             CASE WHEN t.conflict IS NOT NULL THEN 'conflict'
                  WHEN d.id IS NOT NULL THEN 'update'
                  WHEN t.tid IS NOT NULL THEN 'adopt'
                  ELSE 'create' END,
             s.name,
             CASE WHEN t.conflict IS NOT NULL THEN t.conflict ELSE
             concat_ws('; ',
               -- S835: the match is said on its own, and the price clause after it follows a matched
               -- dish too: the apply writes HQ's price over the branch's own when prices are pushed,
               -- and the preview used to stop at the match.
               CASE WHEN d.id IS NULL AND c.id IS NOT NULL THEN 'matched an existing recipe with the same code'
                    WHEN d.id IS NULL AND t.nid IS NOT NULL THEN 'matched an existing recipe of the same name' END,
               CASE WHEN v_vat_differs AND s.category IS DISTINCT FROM 'Sub-Recipe' THEN NULL
                    -- S809 2h: what a NEW dish arrives as (the INSERT below copies HQ's price
                    -- whether or not prices were asked for), and a price push never blanks a
                    -- branch's price with one HQ does not have.
                    WHEN t.tid IS NULL AND s.category IS DISTINCT FROM 'Sub-Recipe'
                         AND NOT COALESCE(s.selling_price > 0, false)
                      THEN 'added OFF the till with no price: HQ has not priced it yet. Set its price at this branch, then switch it On POS'
                    WHEN t.tid IS NULL AND s.category IS DISTINCT FROM 'Sub-Recipe'
                      THEN 'added at HQ''s price, ' ||
                           CASE WHEN s.pos_enabled IS NOT DISTINCT FROM false THEN 'off the till' ELSE 'on the till' END ||
                           ' as it is at HQ'
                    WHEN v_do_prc AND s.category IS DISTINCT FROM 'Sub-Recipe'
                         AND NOT COALESCE(s.selling_price > 0, false)
                      THEN 'selling price left as the branch has it: HQ has no price for it'
                    WHEN v_do_prc AND d.id IS NULL AND COALESCE(s.selling_price > 0, false)
                      THEN 'its selling price is replaced with HQ''s'
                    WHEN v_do_prc THEN 'selling price included'
                    ELSE 'selling price left as the branch has it' END,
               CASE WHEN NOT v_vat_differs OR s.category IS NOT DISTINCT FROM 'Sub-Recipe' THEN NULL
                    WHEN t.tid IS NULL
                      THEN 'added OFF the till with no price: ' || v_vat_why ||
                           ', so HQ''s price would charge guests a different amount here. Set its price at this branch, then switch it On POS'
                    ELSE 'price and VAT rate left as this branch has them: ' || v_vat_why ||
                         ', so HQ''s price would charge guests a different amount here' END) END,
             s.id, CASE WHEN t.conflict IS NOT NULL THEN NULL ELSE t.tid END,
             v_vat_differs AND s.category IS DISTINCT FROM 'Sub-Recipe'
        FROM recipes s
        LEFT JOIN recipes d ON d.client_id = v_target AND d.master_id = s.id
        -- The code match only matters when the dish is not linked yet; a linked dish whose code
        -- another branch dish holds is caught by `x` below.
        LEFT JOIN recipes c ON d.id IS NULL AND c.client_id = v_target AND c.master_id IS NULL
                           AND s.recipe_code IS NOT NULL AND c.recipe_code = s.recipe_code
        -- S849 GROUP-7: recipe names are not unique, so the name match is counted, never joined: a
        -- branch holding two "Chicken Momo"s used to yield two adopt rows, the second write broke
        -- recipes_client_master_key and the whole push rolled back with a constraint name.
        LEFT JOIN LATERAL (
          SELECT count(*)::integer AS n, (array_agg(b.id ORDER BY b.id))[1] AS id,
                 string_agg(COALESCE(b.category, 'no category'), ', ' ORDER BY b.id) AS cats
            FROM recipes b
           WHERE d.id IS NULL AND c.id IS NULL AND b.client_id = v_target AND b.master_id IS NULL
             AND lower(b.name) = lower(s.name)
        ) n ON true
        -- HQ's own dishes of that name: two of them cannot both be the branch's one.
        LEFT JOIN LATERAL (
          SELECT count(*)::integer AS n FROM recipes h
           WHERE h.client_id = v_hq AND lower(h.name) = lower(s.name)
        ) hn ON true
        CROSS JOIN LATERAL (
          SELECT CASE WHEN d.id IS NULL AND c.id IS NULL AND n.n = 1 AND hn.n = 1 THEN n.id END AS nid
        ) nm
        -- recipes_client_recipe_code_key: any OTHER branch dish already holding HQ's code would make
        -- the write fail (HQ swapping two dishes' codes is enough).
        LEFT JOIN LATERAL (
          SELECT b.name
            FROM recipes b
           WHERE s.recipe_code IS NOT NULL AND b.client_id = v_target AND b.recipe_code = s.recipe_code
             AND b.id IS DISTINCT FROM COALESCE(d.id, c.id, nm.nid)
           LIMIT 1
        ) x ON true
        CROSS JOIN LATERAL (
          SELECT COALESCE(d.id, c.id, nm.nid) AS tid,
                 nm.nid,
                 CASE WHEN x.name IS NOT NULL
                        THEN 'skipped - this branch''s dish "' || x.name || '" already uses HQ''s recipe code ' ||
                             s.recipe_code || '. Change one of the two codes, then push again.'
                      WHEN d.id IS NULL AND c.id IS NULL AND n.n > 1
                        THEN 'skipped - this branch has ' || n.n || ' dishes called "' || s.name ||
                             '" (' || COALESCE(n.cats, 'no category') || '), so Crest cannot tell which one is HQ''s. Rename all but one, or give HQ''s dish a recipe code one of them carries, then push again.'
                      WHEN d.id IS NULL AND c.id IS NULL AND n.n = 1 AND hn.n > 1
                        THEN 'skipped - HQ has ' || hn.n || ' dishes called "' || s.name ||
                             '" and this branch has one, so Crest cannot tell which it is. Give HQ''s dishes different names or recipe codes, then push again.'
                 END AS conflict
        ) t
       WHERE s.client_id = v_hq;

      -- S849 GROUP-7: one branch dish matched by two HQ dishes (one by code, another by name) would be
      -- written twice and linked to both. Neither is adopted.
      UPDATE _plan p
         SET action = 'conflict', dst_id = NULL,
             detail = 'skipped - this branch''s dish "' || COALESCE((SELECT b.name FROM recipes b WHERE b.id = p.dst_id), '') ||
                      '" matches more than one HQ dish (by name or recipe code). Give them different names or codes, then push again.'
       WHERE p.target_client_id = v_target AND p.entity = 'recipes' AND p.action = 'adopt'
         AND EXISTS (SELECT 1 FROM _plan q
                      WHERE q.target_client_id = v_target AND q.entity = 'recipes'
                        AND q.dst_id = p.dst_id AND q.src_id <> p.src_id);

      -- S849 GROUP-2 (owner SU2 a). Which of HQ's ingredient lines would have no counterpart here: an
      -- item that is neither linked already nor created, adopted or updated by this push (a conflict
      -- is not linked), or a sub-recipe in the same position. The apply pass maps lines by master_id
      -- after the items and recipes passes, so this is exactly what it would find.
      UPDATE _plan p
         SET missing = (
               SELECT string_agg(DISTINCT COALESCE(hi.name, hr.name, 'an unnamed line'), ', ')
                 FROM recipe_ingredients ri
                 LEFT JOIN items hi ON hi.id = ri.item_id
                 LEFT JOIN recipes hr ON hr.id = ri.sub_recipe_id
                WHERE ri.recipe_id = p.src_id
                  AND ((ri.item_id IS NOT NULL
                        AND NOT EXISTS (SELECT 1 FROM items b WHERE b.client_id = v_target AND b.master_id = ri.item_id)
                        AND NOT EXISTS (SELECT 1 FROM _plan q
                                         WHERE q.target_client_id = v_target AND q.entity = 'items'
                                           AND q.src_id = ri.item_id AND q.action IN ('create', 'adopt', 'update')))
                    OR (ri.sub_recipe_id IS NOT NULL
                        AND NOT EXISTS (SELECT 1 FROM recipes b WHERE b.client_id = v_target AND b.master_id = ri.sub_recipe_id)
                        AND NOT EXISTS (SELECT 1 FROM _plan q
                                         WHERE q.target_client_id = v_target AND q.entity = 'recipes'
                                           AND q.src_id = ri.sub_recipe_id AND q.action IN ('create', 'adopt', 'update')))))
       WHERE p.target_client_id = v_target AND p.entity = 'recipes' AND p.action IN ('create', 'adopt', 'update');

      -- A dish the branch already has keeps everything it has: its lines, its yield, its price and its
      -- marks. Writing HQ's list without the missing line would cost the dish too low and stop the till
      -- taking that stock, and the branch's own line could not be brought back. An adopt is only linked,
      -- so the next push matches it (and a sub-recipe stays usable by the dishes that name it).
      UPDATE _plan p
         SET action = 'skipped',
             detail = 'kept exactly as this branch has it: HQ''s recipe uses ' || p.missing ||
                      ', which this branch does not have yet, and HQ''s list without it would cost the dish too low and stop the till taking that stock. ' ||
                      'Tick Items & categories too, or add ' ||
                      CASE WHEN position(', ' IN p.missing) > 0 THEN 'them' ELSE 'it' END || ' at this branch, then push again' ||
                      CASE WHEN p.action = 'adopt' THEN '. It is linked to HQ''s dish, so the next push matches it' ELSE '' END
       WHERE p.target_client_id = v_target AND p.entity = 'recipes' AND p.action IN ('adopt', 'update')
         AND p.missing IS NOT NULL;

      -- A dish new to the branch has nothing to lose: it is added with the lines that match, and the
      -- preview says which are left out before anything is written.
      INSERT INTO _plan (target_client_id, target_client_name, entity, action, record_name, detail, src_id)
      SELECT v_target, v_tname, 'ingredients', 'partial', p.record_name,
             'a new dish here, added with only the lines this branch can match: ' || p.missing ||
             ' is not at this branch yet, so it is left out of the dish''s cost and of what the till takes from stock. Add it here (or tick Items & categories), then push again',
             p.src_id
        FROM _plan p
       WHERE p.target_client_id = v_target AND p.entity = 'recipes' AND p.action = 'create'
         AND p.missing IS NOT NULL;

      -- S849 GROUP-12 (owner SU8 a): the Veg / Egg / Non-veg mark follows HQ, because the ingredient
      -- list does. Each change is named before it is written (one read rule: DietMark.jsx dietOfDish).
      INSERT INTO _plan (target_client_id, target_client_name, entity, action, record_name, detail, src_id, dst_id)
      SELECT v_target, v_tname, 'food marks', 'change', p.record_name,
             'marked ' || fm.b || ' here until now; HQ marks it ' || fm.h ||
             ', and this push gives the branch HQ''s recipe, so the guest menu and the till show ' || fm.h || ' here',
             p.src_id, p.dst_id
        FROM _plan p
        JOIN recipes s ON s.id = p.src_id
        JOIN recipes e ON e.id = p.dst_id
        CROSS JOIN LATERAL (SELECT CASE WHEN s.is_veg THEN 'Veg' WHEN s.is_veg = false AND COALESCE(s.is_egg, false) THEN 'Egg' WHEN s.is_veg = false THEN 'Non-veg' ELSE 'not stated' END AS h,
                                   CASE WHEN e.is_veg THEN 'Veg' WHEN e.is_veg = false AND COALESCE(e.is_egg, false) THEN 'Egg' WHEN e.is_veg = false THEN 'Non-veg' ELSE 'not stated' END AS b) fm
       WHERE p.target_client_id = v_target AND p.entity = 'recipes' AND p.action IN ('adopt', 'update')
         AND s.category IS DISTINCT FROM 'Sub-Recipe'
         AND fm.h IS DISTINCT FROM fm.b;
    END IF;

    IF v_do_opt THEN
      -- S838: the copy still lands where Customization is off, ready for the day it is switched on;
      -- until then the till, the guest menu and the costing screens ignore it.
      IF NOT COALESCE(public.customization_live(v_target), false)
         AND EXISTS (SELECT 1 FROM pos_option_groups s WHERE s.client_id = v_hq) THEN
        INSERT INTO _plan (target_client_id, target_client_name, entity, action, record_name, detail)
        VALUES (v_target, v_tname, 'choice groups', 'note', 'Crest Customization',
                'switched off at this branch: the choices are copied, and stay unused until it is switched on here');
      END IF;

      -- Groups. The name is unique per client, so `x` is any OTHER branch group holding it (the
      -- items pass's conflict, with the adopt join kept off a linked row: a renamed HQ group whose
      -- new name an unlinked branch group holds is a conflict, not a second match). `k` is a kind
      -- change the branch's OWN choices in the group would refuse (guard_pos_option_edit: a Size
      -- holds no "No ..." choice, and only a Size carries a portion size); the copies of HQ's
      -- choices are made to fit in the apply pass.
      INSERT INTO _plan
      SELECT v_target, v_tname, 'choice groups',
             CASE WHEN x.id IS NOT NULL OR k.opt_name IS NOT NULL THEN 'conflict'
                  WHEN d.id IS NOT NULL THEN 'update'
                  WHEN a.id IS NOT NULL THEN 'adopt'
                  ELSE 'create' END,
             s.name,
             CASE WHEN x.id IS NOT NULL
                    THEN 'skipped - this branch already has a different choice group called "' || x.name ||
                         '". Rename one of them, then push again.'
                  WHEN k.opt_name IS NOT NULL
                    THEN 'skipped - HQ changed what kind of group this is, and this branch''s own choice "' || k.opt_name ||
                         '" in it does not fit the new kind. Change or delete that choice here, then push again.'
                  WHEN a.id IS NOT NULL THEN 'matched an existing choice group of the same name'
                  WHEN d.id IS NULL AND NOT s.is_active THEN 'added switched off, as it is at HQ' END,
             s.id, COALESCE(d.id, a.id)
        FROM pos_option_groups s
        LEFT JOIN pos_option_groups d ON d.client_id = v_target AND d.master_id = s.id
        LEFT JOIN pos_option_groups a ON d.id IS NULL AND a.client_id = v_target AND a.master_id IS NULL
                                     AND lower(btrim(a.name)) = lower(btrim(s.name))
        LEFT JOIN LATERAL (
          SELECT c.id, c.name
            FROM pos_option_groups c
           WHERE c.client_id = v_target
             AND lower(btrim(c.name)) = lower(btrim(s.name))
             AND c.id IS DISTINCT FROM COALESCE(d.id, a.id)
           LIMIT 1
        ) x ON true
        LEFT JOIN LATERAL (
          SELECT o.name AS opt_name
            FROM pos_option_groups b
            JOIN pos_options o ON o.group_id = b.id
           WHERE b.id = COALESCE(d.id, a.id)
             AND b.kind IS DISTINCT FROM s.kind
             AND ((s.kind = 'size' AND o.is_removal) OR (b.kind = 'size' AND o.portion_factor IS NOT NULL))
             AND NOT EXISTS (SELECT 1 FROM pos_options so
                              WHERE so.group_id = s.id
                                AND (so.id = o.master_id
                                     OR (o.master_id IS NULL AND lower(btrim(so.name)) = lower(btrim(o.name)))))
           LIMIT 1
        ) k ON true
       WHERE s.client_id = v_hq;

      -- A group HQ has deleted: switched off here, never deleted (owner 2026-10-14).
      INSERT INTO _plan (target_client_id, target_client_name, entity, action, record_name, detail, dst_id)
      SELECT v_target, v_tname, 'choice groups', 'hide', d.name,
             'HQ no longer has this group, so it is switched off here; past bills keep its name', d.id
        FROM pos_option_groups d
       WHERE d.client_id = v_target AND d.master_id IS NOT NULL AND d.is_active
         AND NOT EXISTS (SELECT 1 FROM pos_option_groups s WHERE s.id = d.master_id AND s.client_id = v_hq);

      -- Choices. Adopted by name only inside the branch group their HQ group matched, which is
      -- where pos_options_group_name_key would refuse a second one. `e` is the branch row either
      -- way, for the price clause. A new choice arrives at HQ's price even without "Selling
      -- prices", as a new dish does; one with a price on a branch whose VAT status differs arrives
      -- switched off at no charge.
      INSERT INTO _plan
      SELECT v_target, v_tname, 'choices',
             CASE WHEN g.action = 'conflict' OR x.id IS NOT NULL THEN 'conflict'
                  WHEN d.id IS NOT NULL THEN 'update'
                  WHEN a.id IS NOT NULL THEN 'adopt'
                  ELSE 'create' END,
             sg.name || ' › ' || s.name,
             CASE WHEN g.action = 'conflict'
                    THEN 'skipped - its group was not pushed (see the group''s row)'
                  WHEN x.id IS NOT NULL
                    THEN 'skipped - this branch''s group already has a different choice called "' || x.name ||
                         '". Rename one of them, then push again.'
                  ELSE concat_ws('; ',
                    CASE WHEN a.id IS NOT NULL THEN 'matched an existing choice of the same name' END,
                    CASE WHEN e.id IS NULL AND v_vat_differs AND s.price_delta <> 0
                           THEN 'added switched OFF at no charge: ' || v_vat_why ||
                                ', so HQ''s price would charge guests a different amount here. Set its price at this branch, then switch it on'
                         WHEN e.id IS NULL AND NOT s.is_active THEN 'added switched off, as it is at HQ'
                         WHEN e.id IS NULL OR s.is_removal OR e.price_delta = s.price_delta THEN NULL
                         WHEN v_vat_differs
                           THEN 'price left as this branch has it: ' || v_vat_why ||
                                ', so HQ''s price would charge guests a different amount here'
                         WHEN v_do_prc THEN 'its price is replaced with HQ''s'
                         ELSE 'price left as the branch has it' END) END,
             s.id, COALESCE(d.id, a.id), v_vat_differs
        FROM pos_options s
        JOIN pos_option_groups sg ON sg.id = s.group_id
        JOIN _plan g ON g.target_client_id = v_target AND g.entity = 'choice groups' AND g.src_id = s.group_id
        LEFT JOIN pos_options d ON d.client_id = v_target AND d.master_id = s.id
        LEFT JOIN pos_options a ON d.id IS NULL AND g.dst_id IS NOT NULL AND a.group_id = g.dst_id
                               AND a.master_id IS NULL AND lower(btrim(a.name)) = lower(btrim(s.name))
        LEFT JOIN pos_options e ON e.id = COALESCE(d.id, a.id)
        LEFT JOIN LATERAL (
          SELECT c.id, c.name
            FROM pos_options c
           WHERE g.dst_id IS NOT NULL AND c.group_id = g.dst_id
             AND lower(btrim(c.name)) = lower(btrim(s.name))
             AND c.id IS DISTINCT FROM COALESCE(d.id, a.id)
           LIMIT 1
        ) x ON true
       WHERE s.client_id = v_hq;

      -- S849 GROUP-2: a choice's stock lines follow the ingredients rule. A choice the branch already
      -- has keeps its own stock lines when one of HQ's has no counterpart here; a new one is added with
      -- the lines that match. Said before anything is written.
      UPDATE _plan p
         SET missing = (
               SELECT string_agg(DISTINCT COALESCE(hi.name, hr.name, 'an unnamed line'), ', ')
                 FROM pos_option_ingredients oi
                 LEFT JOIN items hi ON hi.id = oi.item_id
                 LEFT JOIN recipes hr ON hr.id = oi.sub_recipe_id
                WHERE oi.option_id = p.src_id
                  AND ((oi.item_id IS NOT NULL
                        AND NOT EXISTS (SELECT 1 FROM items b WHERE b.client_id = v_target AND b.master_id = oi.item_id)
                        AND NOT EXISTS (SELECT 1 FROM _plan q
                                         WHERE q.target_client_id = v_target AND q.entity = 'items'
                                           AND q.src_id = oi.item_id AND q.action IN ('create', 'adopt', 'update')))
                    OR (oi.sub_recipe_id IS NOT NULL
                        AND NOT EXISTS (SELECT 1 FROM recipes b WHERE b.client_id = v_target AND b.master_id = oi.sub_recipe_id)
                        AND NOT EXISTS (SELECT 1 FROM _plan q
                                         WHERE q.target_client_id = v_target AND q.entity = 'recipes'
                                           AND q.src_id = oi.sub_recipe_id AND q.action IN ('create', 'adopt', 'update')))))
       WHERE p.target_client_id = v_target AND p.entity = 'choices' AND p.action IN ('create', 'adopt', 'update');

      INSERT INTO _plan (target_client_id, target_client_name, entity, action, record_name, detail, src_id)
      SELECT v_target, v_tname, 'choice stock lines',
             CASE WHEN p.action = 'create' THEN 'partial' ELSE 'skipped' END, p.record_name,
             CASE WHEN p.action = 'create'
                  THEN 'a new choice here, added with only the stock lines this branch can match: ' || p.missing ||
                       ' is not at this branch yet, so the till does not take it from stock. Add it here, then push again'
                  ELSE 'stock lines kept as this branch has them: HQ''s use ' || p.missing ||
                       ', which this branch does not have yet. Add it here (or tick Items & categories), then push again' END,
             p.src_id
        FROM _plan p
       WHERE p.target_client_id = v_target AND p.entity = 'choices' AND p.action IN ('create', 'adopt', 'update')
         AND p.missing IS NOT NULL;

      -- A choice HQ has deleted: switched off here, never deleted (owner 2026-10-14).
      INSERT INTO _plan (target_client_id, target_client_name, entity, action, record_name, detail, dst_id)
      SELECT v_target, v_tname, 'choices', 'hide', bg.name || ' › ' || d.name,
             'HQ no longer has this choice, so it is switched off here; past bills keep its name', d.id
        FROM pos_options d
        JOIN pos_option_groups bg ON bg.id = d.group_id
       WHERE d.client_id = v_target AND d.master_id IS NOT NULL AND d.is_active
         AND NOT EXISTS (SELECT 1 FROM pos_options s WHERE s.id = d.master_id AND s.client_id = v_hq);

      -- Each pushed dish's groups, as HQ has them.
      INSERT INTO _plan (target_client_id, target_client_name, entity, action, record_name, detail, src_id, dst_id)
      SELECT v_target, v_tname, 'dish choices', 'replaced', rp.record_name,
             concat_ws('; ',
               CASE WHEN hq.names IS NOT NULL THEN 'choice groups: ' || hq.names END,
               CASE WHEN br.names IS NOT NULL THEN 'taken off this dish, as at HQ: ' || br.names END,
               CASE WHEN rs.is_build_your_own THEN 'build-your-own' END),
             rp.src_id, rp.dst_id
        FROM _plan rp
        JOIN recipes rs ON rs.id = rp.src_id
        LEFT JOIN LATERAL (
          SELECT string_agg(sg.name, ', ' ORDER BY l.sort, sg.name) AS names
            FROM pos_recipe_option_groups l
            JOIN pos_option_groups sg ON sg.id = l.group_id
           WHERE l.recipe_id = rp.src_id
        ) hq ON true
        -- The branch's groups on this dish that are HQ's (linked already, or taken over by name in
        -- this push) and that HQ's dish does not carry: the apply takes them off.
        LEFT JOIN LATERAL (
          SELECT string_agg(bg.name, ', ' ORDER BY bg.name) AS names
            FROM pos_recipe_option_groups l
            JOIN pos_option_groups bg ON bg.id = l.group_id
            LEFT JOIN _plan ad ON ad.target_client_id = v_target AND ad.entity = 'choice groups'
                              AND ad.action = 'adopt' AND ad.dst_id = bg.id
           WHERE rp.dst_id IS NOT NULL AND l.recipe_id = rp.dst_id
             AND COALESCE(bg.master_id, ad.src_id) IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM pos_recipe_option_groups h
                              WHERE h.recipe_id = rp.src_id AND h.group_id = COALESCE(bg.master_id, ad.src_id))
        ) br ON true
       WHERE rp.target_client_id = v_target AND rp.entity = 'recipes'
         AND rp.action IN ('create', 'adopt', 'update')  -- S849: a skipped or conflicting dish is left as it is
         AND (hq.names IS NOT NULL OR br.names IS NOT NULL OR rs.is_build_your_own);

      -- The till refuses a plate priced below zero (S816), so say so before the push, from the
      -- prices each side will hold after it. A group with free picks is left out: which choices
      -- are free depends on the plate. One row per dish, its most negative choice.
      INSERT INTO _plan (target_client_id, target_client_name, entity, action, record_name, detail)
      SELECT DISTINCT ON (rp.src_id)
             v_target, v_tname, 'dish choices', 'warning', rp.record_name,
             '"' || so.name || '" (' || to_char(nd.delta, 'FM999999990.00') || ') would take this dish below zero here (NPR ' ||
             to_char(np.price, 'FM999999990.00') || '): the till refuses that plate until the dish''s price or the choice''s price is changed at this branch'
        FROM _plan rp
        JOIN recipes rs ON rs.id = rp.src_id
        LEFT JOIN recipes rd ON rd.id = rp.dst_id
        JOIN pos_recipe_option_groups l ON l.recipe_id = rp.src_id
        JOIN pos_option_groups sg ON sg.id = l.group_id AND sg.included_count = 0
        JOIN pos_options so ON so.group_id = sg.id
        LEFT JOIN _plan op ON op.target_client_id = v_target AND op.entity = 'choices' AND op.src_id = so.id
        LEFT JOIN pos_options od ON od.id = op.dst_id
        CROSS JOIN LATERAL (
          SELECT CASE WHEN rd.id IS NULL THEN CASE WHEN COALESCE(rp.vat_differs, false) THEN NULL ELSE rs.selling_price END
                      WHEN v_do_prc AND NOT COALESCE(rp.vat_differs, false) AND COALESCE(rs.selling_price > 0, false)
                        THEN rs.selling_price
                      ELSE rd.selling_price END AS price
        ) np
        CROSS JOIN LATERAL (
          SELECT CASE WHEN od.id IS NULL THEN CASE WHEN v_vat_differs AND so.price_delta <> 0 THEN 0 ELSE so.price_delta END
                      WHEN v_do_prc AND NOT v_vat_differs THEN so.price_delta
                      ELSE od.price_delta END AS delta,
                 CASE WHEN od.id IS NULL THEN so.is_active AND NOT (v_vat_differs AND so.price_delta <> 0)
                      ELSE od.is_active END AS on_menu
        ) nd
       WHERE rp.target_client_id = v_target AND rp.entity = 'recipes'
         AND rp.action IN ('create', 'adopt', 'update')  -- S849
         AND op.action IS DISTINCT FROM 'conflict'
         AND nd.on_menu
         AND np.price IS NOT NULL AND nd.delta < 0 AND np.price + nd.delta < 0
       ORDER BY rp.src_id, nd.delta;

      -- S840 (docs/pos-combos.md): combos ride with the choices. Adopted by name once; a name another
      -- branch combo holds is a conflict. Choices needs Recipes, so every HQ dish reaches the branch in
      -- this push and a missing dish is rare; a NEW combo missing one arrives switched off (owner
      -- decision 2026-10-15) and the preview names the dish. A combo's price is what the guest pays,
      -- so a branch of another VAT status takes it as it is.
      INSERT INTO _plan
      SELECT v_target, v_tname, 'combos',
             CASE WHEN x.id IS NOT NULL THEN 'conflict'
                  WHEN d.id IS NOT NULL THEN 'update'
                  WHEN a.id IS NOT NULL THEN 'adopt'
                  ELSE 'create' END,
             s.name,
             CASE WHEN x.id IS NOT NULL
                    THEN 'skipped - this branch already has a different combo called "' || x.name ||
                         '". Rename one of them, then push again.'
                  ELSE concat_ws('; ',
                    CASE WHEN a.id IS NOT NULL THEN 'matched an existing combo of the same name' END,
                    'picks: ' || COALESCE(pk.names, 'none'),
                    CASE WHEN m.missing IS NOT NULL AND e.id IS NULL
                           THEN 'added switched OFF: ' || m.missing || ' is not at this branch yet. Add it here, then push again'
                         WHEN m.missing IS NOT NULL
                           THEN m.missing || ' is not at this branch yet, so it is left out of its pick. Add it here, then push again'
                         WHEN e.id IS NULL AND NOT s.is_active THEN 'added switched off, as it is at HQ' END,
                    CASE WHEN e.id IS NOT NULL AND e.guest_price <> s.guest_price
                           THEN CASE WHEN v_do_prc THEN 'its price is replaced with HQ''s' ELSE 'price left as the branch has it' END END) END,
             s.id, COALESCE(d.id, a.id)
        FROM pos_combos s
        LEFT JOIN pos_combos d ON d.client_id = v_target AND d.master_id = s.id
        LEFT JOIN pos_combos a ON d.id IS NULL AND a.client_id = v_target AND a.master_id IS NULL
                              AND lower(btrim(a.name)) = lower(btrim(s.name))
        LEFT JOIN pos_combos e ON e.id = COALESCE(d.id, a.id)
        LEFT JOIN LATERAL (
          SELECT c.id, c.name
            FROM pos_combos c
           WHERE c.client_id = v_target AND lower(btrim(c.name)) = lower(btrim(s.name))
             AND c.id IS DISTINCT FROM COALESCE(d.id, a.id)
           LIMIT 1
        ) x ON true
        LEFT JOIN LATERAL (
          SELECT string_agg(g.name, ', ' ORDER BY g.sort, g.id) AS names
            FROM pos_combo_groups g WHERE g.combo_id = s.id
        ) pk ON true
        LEFT JOIN LATERAL (
          SELECT string_agg(DISTINCT r.name, ', ') AS missing
            FROM pos_combo_groups g
            JOIN pos_combo_items it ON it.group_id = g.id
            JOIN recipes r ON r.id = it.recipe_id
           WHERE g.combo_id = s.id
             AND NOT EXISTS (SELECT 1 FROM recipes br WHERE br.client_id = v_target AND br.master_id = it.recipe_id)
             AND NOT EXISTS (SELECT 1 FROM _plan rq
                              WHERE rq.target_client_id = v_target AND rq.entity = 'recipes' AND rq.src_id = it.recipe_id
                                -- S849: a conflicting dish is not linked, so it is not at the branch; a skipped one is.
                                AND rq.action IN ('create', 'adopt', 'update', 'skipped'))
        ) m ON true
       WHERE s.client_id = v_hq;

      -- A combo HQ has deleted: switched off here, never deleted (as a choice is).
      INSERT INTO _plan (target_client_id, target_client_name, entity, action, record_name, detail, dst_id)
      SELECT v_target, v_tname, 'combos', 'hide', d.name,
             'HQ no longer has this combo, so it is switched off here; past bills keep its name', d.id
        FROM pos_combos d
       WHERE d.client_id = v_target AND d.master_id IS NOT NULL AND d.is_active
         AND NOT EXISTS (SELECT 1 FROM pos_combos s WHERE s.id = d.master_id AND s.client_id = v_hq);
    END IF;
  END LOOP;

  IF p_dry_run THEN
    -- S849 GROUP-6: a set-returning call is cut at 1,000 rows (max_rows), so the page reads a preview
    -- in pages by row_no. A preview writes nothing, so reading it again is safe; a push is never
    -- called twice, which is why its reply lists only what needs a look.
    RETURN QUERY
      WITH listed AS (
             -- A preview lists every row; after a push, the rows that need a look (a routine create,
             -- update or replaced list is in the counts).
             SELECT p.* FROM _plan p
              WHERE p_dry_run OR p.action NOT IN ('create', 'update', 'replaced')
           ),
           counted AS (
             SELECT p.target_client_id AS tid, p.target_client_name AS tname, p.entity AS ent, p.action AS act,
                    count(*)::integer AS cnt
               FROM _plan p
              GROUP BY p.target_client_id, p.target_client_name, p.entity, p.action
           ),
           out_rows AS (
             -- The total comes first, so a reply cut short still says how many rows there were.
             SELECT 0 AS grp, 'total'::text AS k, NULL::uuid AS tid, NULL::text AS tname, NULL::text AS ent,
                    NULL::text AS act, NULL::text AS rec, NULL::text AS det,
                    (SELECT count(*) FROM listed)::integer AS cnt
             UNION ALL
             SELECT 1, 'summary', c.tid, c.tname, c.ent, c.act, NULL, NULL, c.cnt FROM counted c
             UNION ALL
             SELECT 2, 'row', l.target_client_id, l.target_client_name, l.entity, l.action, l.record_name, l.detail, NULL
               FROM listed l
           )
      SELECT (row_number() OVER (ORDER BY o.grp, o.tname, o.ent, o.act, o.rec, o.det, o.tid) - 1)::bigint,
             o.k, o.tid, o.tname, o.ent, o.act, o.rec, o.det, o.cnt
        FROM out_rows o
       ORDER BY 1;
    RETURN;
  END IF;

  ----------------------------------------------------------------------------------------------
  -- APPLY, strictly in dependency order: categories, then items (which reference a category),
  -- then recipes, then each recipe's ingredient list (which references both items and recipes),
  -- then the choices (S838: groups, choices, their stock lines, then each dish's groups).
  ----------------------------------------------------------------------------------------------
  -- S849 GROUP-7: a planned category conflict is reported, never written.
  FOR r IN SELECT * FROM _plan WHERE entity = 'categories' AND action <> 'conflict' ORDER BY target_client_id LOOP
    IF r.dst_id IS NULL THEN
      INSERT INTO categories (client_id, name, sort_order, master_id)
      SELECT r.target_client_id, s.name, s.sort_order, s.id FROM categories s WHERE s.id = r.src_id;
    ELSE
      UPDATE categories d
         SET name = s.name, sort_order = s.sort_order, master_id = s.id
        FROM categories s WHERE s.id = r.src_id AND d.id = r.dst_id;
    END IF;
  END LOOP;

  -- `action <> 'conflict'`: a planned conflict is REPORTED, never written. It stays in _plan so
  -- the operator reads it in the returned rows exactly as the dry run showed it.
  FOR r IN SELECT * FROM _plan WHERE entity = 'items' AND action <> 'conflict' ORDER BY target_client_id LOOP
    -- The branch's own copy of the source item's category, if that category was ever pushed.
    SELECT d.id INTO v_cat
      FROM categories s JOIN categories d ON d.client_id = r.target_client_id AND d.master_id = s.id
     WHERE s.id = (SELECT category_id FROM items WHERE id = r.src_id);

    IF r.dst_id IS NULL THEN
      -- per_uom_rate is GENERATED and must never appear in an INSERT. purchase_qty carries a
      -- CHECK (= 1) since S597, so it is copied rather than derived.
      INSERT INTO items (client_id, master_id, category_id, name, uom, purchase_qty, rate,
                         is_active, purchase_unit, base_unit, conversion_factor, item_code,
                         yield_pct, is_sub_recipe, nutrition)
      SELECT r.target_client_id, s.id, v_cat, s.name, s.uom, s.purchase_qty, s.rate,
             s.is_active, s.purchase_unit, s.base_unit, s.conversion_factor, s.item_code,
             s.yield_pct, false, s.nutrition
        FROM items s WHERE s.id = r.src_id;
    ELSE
      -- rate is deliberately absent: see the header. This is the branch's own supplier price.
      -- is_active too (S792): whether the branch still stocks an item is the branch's own fact.
      UPDATE items d
         SET master_id = s.id, category_id = v_cat, name = s.name, uom = s.uom,
             purchase_qty = s.purchase_qty,
             purchase_unit = s.purchase_unit, base_unit = s.base_unit,
             conversion_factor = s.conversion_factor, item_code = s.item_code,
             yield_pct = s.yield_pct, nutrition = s.nutrition
        FROM items s WHERE s.id = r.src_id AND d.id = r.dst_id;
    END IF;
  END LOOP;

  FOR r IN SELECT * FROM _plan WHERE entity = 'recipes' ORDER BY target_client_id LOOP
    -- S849 GROUP-7: a conflict is reported, never written. GROUP-2 (SU2 a): a skipped dish keeps
    -- everything it has; one that was being adopted is linked and nothing else, so the next push
    -- matches it and the dishes naming it as a sub-recipe find it.
    IF r.action = 'conflict' THEN
      CONTINUE;
    END IF;
    IF r.action = 'skipped' THEN
      UPDATE recipes SET master_id = r.src_id WHERE id = r.dst_id AND master_id IS NULL;
      CONTINUE;
    END IF;

    IF r.dst_id IS NULL THEN
      -- A branch whose VAT status differs (S792 stage 3): no price, the BRANCH's VAT rate (PAN
      -- stores 0, D31; VAT-registered takes the column default 0.13), and off the till until the
      -- owner prices it there — the till bills a NULL price as NPR 0.
      -- S838: the build-your-own mark travels only with the choices it is built from; without
      -- them a marked dish would open an empty choice window on the till.
      -- S849 GROUP-12: the food mark and the description travel with a new dish. The photo does not:
      -- it is a file in HQ's own folder, so the branch adds its own.
      INSERT INTO recipes (client_id, master_id, name, category, selling_price, vat_rate,
                           is_active, yield_qty, yield_uom, target_fc_pct, recipe_code,
                           pos_enabled, hsc_code, is_build_your_own, is_veg, is_egg, description)
      SELECT r.target_client_id, s.id, s.name, s.category,
             CASE WHEN COALESCE(r.vat_differs, false) THEN NULL ELSE s.selling_price END,
             CASE WHEN COALESCE(r.vat_differs, false) THEN CASE WHEN v_hq_vat THEN 0 ELSE 0.13 END
                  ELSE s.vat_rate END,
             s.is_active, s.yield_qty, s.yield_uom, s.target_fc_pct, s.recipe_code,
             -- S809 2h (GAP-OUTLETS-2): one HQ has not priced arrives off the till too, for
             -- the same reason. Otherwise HQ's switch is the new dish's starting point.
             CASE WHEN COALESCE(r.vat_differs, false) THEN false
                  WHEN s.category IS DISTINCT FROM 'Sub-Recipe' AND NOT COALESCE(s.selling_price > 0, false) THEN false
                  ELSE s.pos_enabled END,
             s.hsc_code,
             v_do_opt AND s.is_build_your_own,
             s.is_veg, COALESCE(s.is_egg, false), s.description
        FROM recipes s WHERE s.id = r.src_id
      RETURNING id INTO v_dst;
      UPDATE _plan SET dst_id = v_dst WHERE src_id = r.src_id AND target_client_id = r.target_client_id AND entity = 'recipes';
    ELSE
      -- selling_price only when 'prices' was asked for: a branch may legitimately price above or
      -- below HQ, so it is opt-in rather than swept along with the recipe definition. Neither it
      -- nor vat_rate is written on a branch whose VAT status differs (S792 stage 3).
      -- S809 2h (GAP-OUTLETS-2; owner decision Q25 a, 2026-10-09): is_active and pos_enabled are
      -- the BRANCH's own and are not written. Every push used to copy HQ's, so a dish a branch had
      -- taken off its till (no tandoor there) came back on it, and a dish that arrived off the till
      -- with no price came back on at NPR 0. An item's is_active has been the branch's own since
      -- S792. And a price push never writes a price HQ does not have (NULL or not above 0) over the
      -- branch's own.
      UPDATE recipes d
         SET master_id = s.id, name = s.name, category = s.category,
             vat_rate = CASE WHEN COALESCE(r.vat_differs, false) THEN d.vat_rate ELSE s.vat_rate END,
             yield_qty = s.yield_qty, yield_uom = s.yield_uom,
             target_fc_pct = s.target_fc_pct, recipe_code = s.recipe_code,
             hsc_code = s.hsc_code,
             -- S849 GROUP-12 (SU8 a): the mark describes the ingredient list, which is HQ's after this.
             is_veg = s.is_veg, is_egg = COALESCE(s.is_egg, false),
             selling_price = CASE WHEN v_do_prc AND NOT COALESCE(r.vat_differs, false)
                                       AND COALESCE(s.selling_price > 0, false)
                                  THEN s.selling_price ELSE d.selling_price END,
             is_build_your_own = CASE WHEN v_do_opt THEN s.is_build_your_own ELSE d.is_build_your_own END
        FROM recipes s WHERE s.id = r.src_id AND d.id = r.dst_id;
      v_dst := r.dst_id;
    END IF;

    -- Sub-recipe mirror item, reproducing Recipes.js's own payload. Created if absent, linked
    -- either way; its rate is a cost computed at HQ prices, so it is seeded and then left alone.
    IF (SELECT category FROM recipes WHERE id = r.src_id) = 'Sub-Recipe' THEN
      IF (SELECT linked_item_id FROM recipes WHERE id = v_dst) IS NULL THEN
        -- The mirror is an `items` row like any other, so items_client_name_key applies to it and
        -- this INSERT is the third way the push could raise 23505. Checked rather than caught: a
        -- reported conflict leaves the rest of the push intact, and the ingredient lines that
        -- needed this mirror are then skipped and counted by the 'partial' machinery below, which
        -- is already the honest answer for an ingredient with no counterpart at the branch.
        SELECT upper(s.name) INTO v_mname FROM recipes s WHERE s.id = r.src_id;
        SELECT c.name INTO v_conflict
          FROM items c
         WHERE c.client_id = r.target_client_id AND lower(c.name) = lower(v_mname)
         LIMIT 1;

        IF v_conflict IS NOT NULL THEN
          INSERT INTO _plan (target_client_id, target_client_name, entity, action, record_name, detail)
          VALUES (r.target_client_id, r.target_client_name, 'sub-recipe item', 'conflict', v_mname,
                  'skipped - this branch already has an item called "' || v_conflict ||
                  '", so the stock-counted mirror for this sub-recipe was not created and any '
                  || 'recipe line using it is skipped too. Rename one of them, then push again.');
        ELSE
          SELECT id INTO v_cat FROM categories
           WHERE client_id = r.target_client_id AND lower(name) = 'sub-recipes' LIMIT 1;
          IF v_cat IS NULL THEN
            INSERT INTO categories (client_id, name, sort_order)
            VALUES (r.target_client_id, 'Sub-Recipes', 999) RETURNING id INTO v_cat;
          END IF;
          INSERT INTO items (client_id, category_id, name, uom, purchase_qty, rate, is_active,
                             is_sub_recipe, item_code)
          SELECT r.target_client_id, v_cat, v_mname, COALESCE(s.yield_uom, 'portion'), 1,
                 COALESCE((SELECT i.rate FROM items i WHERE i.id = s.linked_item_id), 0),
                 true, true, s.recipe_code
            FROM recipes s WHERE s.id = r.src_id
          RETURNING id INTO v_item;
          -- v_item, NOT v_dst: v_dst still holds the RECIPE id this mirror belongs to, and reusing
          -- one variable for both would link the recipe to itself.
          UPDATE recipes SET linked_item_id = v_item WHERE id = v_dst;
        END IF;
      END IF;
    END IF;
  END LOOP;

  -- Ingredients last, and replaced wholesale per recipe -- "HQ wins" applied to a list means the
  -- list, not a merge of two lists. An ingredient whose item or sub-recipe has no counterpart at
  -- the branch is REPORTED, never silently dropped: a recipe costed from an incomplete ingredient
  -- list is the silent-wrong-number shape this codebase keeps finding.
  IF v_do_rec THEN
    -- Materialised into its own table first: the loop body INSERTs 'ingredients' rows into _plan,
    -- and mutating the relation a FOR cursor is reading is the kind of thing that works until the
    -- planner picks a different scan. S838: dropped first, as _plan is.
    DROP TABLE IF EXISTS pg_temp._rec_todo;
    CREATE TEMP TABLE _rec_todo ON COMMIT DROP AS
      SELECT * FROM _plan WHERE entity = 'recipes' AND action IN ('create', 'adopt', 'update') AND dst_id IS NOT NULL;
    FOR r IN SELECT * FROM _rec_todo ORDER BY target_client_id LOOP
      SELECT count(*) INTO v_skipped
        FROM recipe_ingredients ri
        LEFT JOIN items di ON di.client_id = r.target_client_id AND di.master_id = ri.item_id
        LEFT JOIN recipes dr ON dr.client_id = r.target_client_id AND dr.master_id = ri.sub_recipe_id
       WHERE ri.recipe_id = r.src_id
         AND ((ri.item_id IS NOT NULL AND di.id IS NULL) OR (ri.sub_recipe_id IS NOT NULL AND dr.id IS NULL));

      -- S849 GROUP-2 (SU2 a): a branch's list is never shortened. The plan already skipped every dish
      -- with a line that cannot be matched; this is the backstop should the two ever disagree.
      IF v_skipped > 0 AND r.action <> 'create' THEN
        INSERT INTO _plan (target_client_id, target_client_name, entity, action, record_name, detail, src_id)
        VALUES (r.target_client_id, r.target_client_name, 'ingredients', 'skipped', r.record_name,
                'kept as this branch has it: ' || v_skipped || ' of HQ''s line(s) have no match here, so nothing was removed',
                r.src_id);
        CONTINUE;
      END IF;

      DELETE FROM recipe_ingredients WHERE recipe_id = r.dst_id;

      INSERT INTO recipe_ingredients (recipe_id, item_id, sub_recipe_id, qty_per_portion)
      SELECT r.dst_id, di.id, dr.id, ri.qty_per_portion
        FROM recipe_ingredients ri
        LEFT JOIN items di ON di.client_id = r.target_client_id AND di.master_id = ri.item_id
        LEFT JOIN recipes dr ON dr.client_id = r.target_client_id AND dr.master_id = ri.sub_recipe_id
       WHERE ri.recipe_id = r.src_id
         AND ((ri.item_id IS NOT NULL AND di.id IS NOT NULL) OR (ri.sub_recipe_id IS NOT NULL AND dr.id IS NOT NULL));

      GET DIAGNOSTICS v_lines = ROW_COUNT;
      IF v_skipped > 0 THEN
        -- A new dish: the preview's own partial row gains the count, so it is not listed twice.
        UPDATE _plan SET detail = v_lines || ' line(s) written; ' || detail
         WHERE target_client_id = r.target_client_id AND entity = 'ingredients' AND action = 'partial'
           AND src_id = r.src_id;
        IF NOT FOUND THEN
          INSERT INTO _plan (target_client_id, target_client_name, entity, action, record_name, detail, src_id)
          VALUES (r.target_client_id, r.target_client_name, 'ingredients', 'partial', r.record_name,
                  v_lines || ' line(s) written, ' || v_skipped || ' left out - ingredient not present at this branch',
                  r.src_id);
        END IF;
      ELSE
        INSERT INTO _plan (target_client_id, target_client_name, entity, action, record_name, detail)
        VALUES (r.target_client_id, r.target_client_name, 'ingredients', 'replaced', r.record_name,
                v_lines || ' line(s) written');
      END IF;
    END LOOP;
  END IF;

  -- S838: the choices. This function is SECURITY DEFINER, so guard_pos_option_edit lets these
  -- writes past its rank and Customization-on tests (current_user is the owner) and still checks
  -- that every item, sub-recipe, dish and default named is the branch's own.
  IF v_do_opt THEN
    FOR r IN SELECT * FROM _plan WHERE entity = 'choice groups' AND action IN ('create', 'adopt', 'update')
              ORDER BY target_client_id LOOP
      IF r.dst_id IS NULL THEN
        -- A new group starts switched on or off as it is at HQ; after that the switch is the
        -- branch's own.
        INSERT INTO pos_option_groups (client_id, master_id, name, kitchen_name, kind, min_select, max_select,
                                       included_count, sort, is_active, size_scaling)
        SELECT r.target_client_id, s.id, s.name, s.kitchen_name, s.kind, s.min_select, s.max_select,
               s.included_count, s.sort, s.is_active, s.size_scaling
          FROM pos_option_groups s WHERE s.id = r.src_id
        RETURNING id INTO v_grp;
        UPDATE _plan SET dst_id = v_grp
         WHERE entity = 'choice groups' AND src_id = r.src_id AND target_client_id = r.target_client_id;
      ELSE
        -- A group changing kind: the copies of HQ's choices in it are made to fit first (a Size
        -- holds no "No ..." choice, and only a Size carries a portion size), and take HQ's own
        -- values in the choices pass below. The branch's own choices were checked in the plan.
        IF (SELECT kind FROM pos_option_groups WHERE id = r.dst_id)
           IS DISTINCT FROM (SELECT kind FROM pos_option_groups WHERE id = r.src_id) THEN
          UPDATE pos_options o
             SET is_removal = false, portion_factor = NULL
           WHERE o.group_id = r.dst_id
             AND (o.is_removal OR o.portion_factor IS NOT NULL)
             AND EXISTS (SELECT 1 FROM _plan p
                          WHERE p.entity = 'choices' AND p.target_client_id = r.target_client_id
                            AND p.dst_id = o.id AND p.action IN ('adopt', 'update'));
        END IF;
        UPDATE pos_option_groups d
           SET master_id = s.id, name = s.name, kitchen_name = s.kitchen_name, kind = s.kind,
               min_select = s.min_select, max_select = s.max_select, included_count = s.included_count,
               sort = s.sort, size_scaling = s.size_scaling
          FROM pos_option_groups s WHERE s.id = r.src_id AND d.id = r.dst_id;
      END IF;
    END LOOP;

    UPDATE pos_option_groups d SET is_active = false
      FROM _plan p
     WHERE p.entity = 'choice groups' AND p.action = 'hide' AND d.id = p.dst_id;

    FOR r IN SELECT * FROM _plan WHERE entity = 'choices' AND action IN ('create', 'adopt', 'update')
              ORDER BY target_client_id LOOP
      -- The branch's copy of the choice's HQ group, written just above.
      SELECT d.id INTO v_grp
        FROM pos_options s
        JOIN pos_option_groups d ON d.client_id = r.target_client_id AND d.master_id = s.group_id
       WHERE s.id = r.src_id;
      CONTINUE WHEN v_grp IS NULL;

      IF r.dst_id IS NULL THEN
        INSERT INTO pos_options (client_id, master_id, group_id, name, kitchen_name, price_delta, is_removal,
                                 is_default, diet, allergens, sort, is_active, portion_factor)
        SELECT r.target_client_id, s.id, v_grp, s.name, s.kitchen_name,
               CASE WHEN COALESCE(r.vat_differs, false) THEN 0 ELSE s.price_delta END,
               s.is_removal, s.is_default, s.diet, s.allergens, s.sort,
               CASE WHEN COALESCE(r.vat_differs, false) AND s.price_delta <> 0 THEN false ELSE s.is_active END,
               s.portion_factor
          FROM pos_options s WHERE s.id = r.src_id
        RETURNING id INTO v_opt;
        UPDATE _plan SET dst_id = v_opt
         WHERE entity = 'choices' AND src_id = r.src_id AND target_client_id = r.target_client_id;
      ELSE
        -- is_active is the branch's own (owner 2026-10-14). A "No ..." choice is always free
        -- (pos_options_removal_is_free), whatever the branch had charged for it before.
        UPDATE pos_options d
           SET master_id = s.id, group_id = v_grp, name = s.name, kitchen_name = s.kitchen_name,
               price_delta = CASE WHEN s.is_removal THEN 0
                                  WHEN v_do_prc AND NOT COALESCE(r.vat_differs, false) THEN s.price_delta
                                  ELSE d.price_delta END,
               is_removal = s.is_removal, is_default = s.is_default, diet = s.diet, allergens = s.allergens,
               sort = s.sort, portion_factor = s.portion_factor
          FROM pos_options s WHERE s.id = r.src_id AND d.id = r.dst_id;
      END IF;
    END LOOP;

    UPDATE pos_options d SET is_active = false
      FROM _plan p
     WHERE p.entity = 'choices' AND p.action = 'hide' AND d.id = p.dst_id;

    -- A choice's stock lines: HQ's list, replaced wholesale and remapped, the ingredients rule.
    -- Already scaled lines are not a concern here: the size factor applies at order time.
    DROP TABLE IF EXISTS pg_temp._opt_todo;
    CREATE TEMP TABLE _opt_todo ON COMMIT DROP AS
      SELECT * FROM _plan WHERE entity = 'choices' AND action IN ('create', 'adopt', 'update') AND dst_id IS NOT NULL;
    FOR r IN SELECT * FROM _opt_todo ORDER BY target_client_id LOOP
      SELECT count(*) INTO v_skipped
        FROM pos_option_ingredients oi
        LEFT JOIN items di ON di.client_id = r.target_client_id AND di.master_id = oi.item_id
        LEFT JOIN recipes dr ON dr.client_id = r.target_client_id AND dr.master_id = oi.sub_recipe_id
       WHERE oi.option_id = r.src_id
         AND ((oi.item_id IS NOT NULL AND di.id IS NULL) OR (oi.sub_recipe_id IS NOT NULL AND dr.id IS NULL));

      -- S849 GROUP-2: the ingredients rule. The plan already named this choice; nothing is removed.
      IF v_skipped > 0 AND r.action <> 'create' THEN
        IF NOT EXISTS (SELECT 1 FROM _plan p
                        WHERE p.target_client_id = r.target_client_id AND p.entity = 'choice stock lines'
                          AND p.action = 'skipped' AND p.src_id = r.src_id) THEN
          INSERT INTO _plan (target_client_id, target_client_name, entity, action, record_name, detail, src_id)
          VALUES (r.target_client_id, r.target_client_name, 'choice stock lines', 'skipped', r.record_name,
                  'kept as this branch has them: ' || v_skipped || ' of HQ''s stock line(s) have no match here, so nothing was removed',
                  r.src_id);
        END IF;
        CONTINUE;
      END IF;

      DELETE FROM pos_option_ingredients WHERE option_id = r.dst_id;
      GET DIAGNOSTICS v_cleared = ROW_COUNT;

      INSERT INTO pos_option_ingredients (client_id, option_id, item_id, sub_recipe_id, qty_per_portion)
      SELECT r.target_client_id, r.dst_id, di.id, dr.id, oi.qty_per_portion
        FROM pos_option_ingredients oi
        LEFT JOIN items di ON di.client_id = r.target_client_id AND di.master_id = oi.item_id
        LEFT JOIN recipes dr ON dr.client_id = r.target_client_id AND dr.master_id = oi.sub_recipe_id
       WHERE oi.option_id = r.src_id
         AND ((oi.item_id IS NOT NULL AND di.id IS NOT NULL) OR (oi.sub_recipe_id IS NOT NULL AND dr.id IS NOT NULL));
      GET DIAGNOSTICS v_lines = ROW_COUNT;

      -- A choice with no stock lines on either side says nothing, or Spice: Mild would fill the
      -- preview.
      IF v_skipped > 0 THEN
        UPDATE _plan SET detail = v_lines || ' line(s) written; ' || detail
         WHERE target_client_id = r.target_client_id AND entity = 'choice stock lines' AND action = 'partial'
           AND src_id = r.src_id;
        IF NOT FOUND THEN
          INSERT INTO _plan (target_client_id, target_client_name, entity, action, record_name, detail, src_id)
          VALUES (r.target_client_id, r.target_client_name, 'choice stock lines', 'partial', r.record_name,
                  v_lines || ' line(s) written, ' || v_skipped || ' left out - stock item not present at this branch',
                  r.src_id);
        END IF;
      ELSIF v_lines + v_cleared > 0 THEN
        INSERT INTO _plan (target_client_id, target_client_name, entity, action, record_name, detail)
        VALUES (r.target_client_id, r.target_client_name, 'choice stock lines', 'replaced', r.record_name,
                v_lines || ' line(s) written');
      END IF;
    END LOOP;

    -- Each pushed dish's groups: HQ's, in HQ's order and with its per-dish rules and default. A
    -- group from HQ that HQ has taken off the dish comes off it here; one the branch made itself
    -- and put on the dish stays. Upserted on (recipe_id, group_id), so a link keeps its row.
    DELETE FROM pos_recipe_option_groups b
     USING _plan rp, pos_option_groups bg
     WHERE rp.entity = 'recipes' AND rp.dst_id IS NOT NULL
       AND rp.action IN ('create', 'adopt', 'update')  -- S849: a skipped dish keeps its own groups
       AND b.recipe_id = rp.dst_id
       AND bg.id = b.group_id AND bg.master_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM pos_recipe_option_groups h
                        WHERE h.recipe_id = rp.src_id AND h.group_id = bg.master_id);

    INSERT INTO pos_recipe_option_groups (client_id, recipe_id, group_id, min_override, max_override,
                                          default_option_id, sort)
    SELECT rp.target_client_id, rp.dst_id, dg.id, l.min_override, l.max_override, dopt.id, l.sort
      FROM _plan rp
      JOIN pos_recipe_option_groups l ON l.recipe_id = rp.src_id
      JOIN pos_option_groups dg ON dg.client_id = rp.target_client_id AND dg.master_id = l.group_id
      LEFT JOIN pos_options dopt ON dopt.client_id = rp.target_client_id AND dopt.master_id = l.default_option_id
                                AND dopt.group_id = dg.id
     WHERE rp.entity = 'recipes' AND rp.dst_id IS NOT NULL
       AND rp.action IN ('create', 'adopt', 'update')  -- S849
    ON CONFLICT (recipe_id, group_id) DO UPDATE
       SET min_override = EXCLUDED.min_override, max_override = EXCLUDED.max_override,
           default_option_id = EXCLUDED.default_option_id, sort = EXCLUDED.sort;

    -- S840: combos. A new one starts switched on or off as at HQ, and off when one of its dishes is
    -- not at the branch; after that both switches are the branch's own. Its price and each dish's
    -- extra charge follow "Selling prices" once they exist here. Its picks are HQ's list (a branch
    -- pick of the same name is linked once; any other goes), and each pick's dishes HQ's, by the
    -- branch's copy of each. guard_pos_combo_edit still checks every dish is the branch's own.
    FOR r IN SELECT * FROM _plan WHERE entity = 'combos' AND action IN ('create', 'adopt', 'update')
              ORDER BY target_client_id LOOP
      IF r.dst_id IS NULL THEN
        INSERT INTO pos_combos (client_id, master_id, name, guest_price, description, is_active, on_guest_menu, sort)
        SELECT r.target_client_id, s.id, s.name, s.guest_price, s.description,
               s.is_active AND NOT EXISTS (
                 SELECT 1 FROM pos_combo_groups g JOIN pos_combo_items it ON it.group_id = g.id
                  WHERE g.combo_id = s.id
                    AND NOT EXISTS (SELECT 1 FROM recipes br
                                     WHERE br.client_id = r.target_client_id AND br.master_id = it.recipe_id)),
               s.on_guest_menu, s.sort
          FROM pos_combos s WHERE s.id = r.src_id
        RETURNING id INTO v_cmb;
      ELSE
        UPDATE pos_combos d
           SET master_id = s.id, name = s.name, description = s.description, sort = s.sort,
               guest_price = CASE WHEN v_do_prc THEN s.guest_price ELSE d.guest_price END
          FROM pos_combos s WHERE s.id = r.src_id AND d.id = r.dst_id;
        v_cmb := r.dst_id;
      END IF;

      UPDATE pos_combo_groups bg SET master_id = sg.id
        FROM pos_combo_groups sg
       WHERE bg.combo_id = v_cmb AND bg.master_id IS NULL
         AND sg.combo_id = r.src_id AND lower(btrim(sg.name)) = lower(btrim(bg.name))
         AND NOT EXISTS (SELECT 1 FROM pos_combo_groups b2
                          WHERE b2.client_id = r.target_client_id AND b2.master_id = sg.id);
      DELETE FROM pos_combo_groups bg
       WHERE bg.combo_id = v_cmb
         AND NOT EXISTS (SELECT 1 FROM pos_combo_groups sg WHERE sg.combo_id = r.src_id AND sg.id = bg.master_id);
      -- Names parked first, so two picks can swap names in one push.
      UPDATE pos_combo_groups SET name = id::text WHERE combo_id = v_cmb;
      FOR v_sg IN SELECT * FROM pos_combo_groups WHERE combo_id = r.src_id ORDER BY sort, id LOOP
        v_bg := NULL;
        UPDATE pos_combo_groups SET name = v_sg.name, sort = v_sg.sort
         WHERE combo_id = v_cmb AND master_id = v_sg.id
        RETURNING id INTO v_bg;
        IF v_bg IS NULL THEN
          INSERT INTO pos_combo_groups (client_id, combo_id, master_id, name, sort)
          VALUES (r.target_client_id, v_cmb, v_sg.id, v_sg.name, v_sg.sort)
          RETURNING id INTO v_bg;
        END IF;
        DELETE FROM pos_combo_items bi
         WHERE bi.group_id = v_bg
           AND NOT EXISTS (SELECT 1 FROM pos_combo_items si
                             JOIN recipes br ON br.master_id = si.recipe_id AND br.client_id = r.target_client_id
                            WHERE si.group_id = v_sg.id AND br.id = bi.recipe_id);
        UPDATE pos_combo_items SET is_default = false WHERE group_id = v_bg AND is_default;
        INSERT INTO pos_combo_items (client_id, group_id, recipe_id, extra_price, is_default, sort)
        SELECT r.target_client_id, v_bg, br.id, si.extra_price, si.is_default, si.sort
          FROM pos_combo_items si
          JOIN recipes br ON br.client_id = r.target_client_id AND br.master_id = si.recipe_id
         WHERE si.group_id = v_sg.id
        ON CONFLICT (group_id, recipe_id) DO UPDATE
           SET extra_price = CASE WHEN v_do_prc THEN EXCLUDED.extra_price ELSE pos_combo_items.extra_price END,
               is_default = EXCLUDED.is_default, sort = EXCLUDED.sort;
      END LOOP;
    END LOOP;

    UPDATE pos_combos d SET is_active = false
      FROM _plan p
     WHERE p.entity = 'combos' AND p.action = 'hide' AND d.id = p.dst_id;
  END IF;

  RETURN QUERY
      WITH listed AS (
             -- A preview lists every row; after a push, the rows that need a look (a routine create,
             -- update or replaced list is in the counts).
             SELECT p.* FROM _plan p
              WHERE p_dry_run OR p.action NOT IN ('create', 'update', 'replaced')
           ),
           counted AS (
             SELECT p.target_client_id AS tid, p.target_client_name AS tname, p.entity AS ent, p.action AS act,
                    count(*)::integer AS cnt
               FROM _plan p
              GROUP BY p.target_client_id, p.target_client_name, p.entity, p.action
           ),
           out_rows AS (
             -- The total comes first, so a reply cut short still says how many rows there were.
             SELECT 0 AS grp, 'total'::text AS k, NULL::uuid AS tid, NULL::text AS tname, NULL::text AS ent,
                    NULL::text AS act, NULL::text AS rec, NULL::text AS det,
                    (SELECT count(*) FROM listed)::integer AS cnt
             UNION ALL
             SELECT 1, 'summary', c.tid, c.tname, c.ent, c.act, NULL, NULL, c.cnt FROM counted c
             UNION ALL
             SELECT 2, 'row', l.target_client_id, l.target_client_name, l.entity, l.action, l.record_name, l.detail, NULL
               FROM listed l
           )
      SELECT (row_number() OVER (ORDER BY o.grp, o.tname, o.ent, o.act, o.rec, o.det, o.tid) - 1)::bigint,
             o.k, o.tid, o.tname, o.ent, o.act, o.rec, o.det, o.cnt
        FROM out_rows o
       ORDER BY 1;
END;
$function$;
REVOKE ALL ON FUNCTION public.push_master_data(uuid[], text[], boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.push_master_data(uuid[], text[], boolean) TO authenticated, service_role;


-- ── 11. DATA CLEAN-UP: stray rows (live 2026-10-15: 0 rows in every statement) ─────────────────
-- Run as the migration's role, which guard_profiles_privileged_columns lets through; log_audit records
-- the profiles, profile_employee_links, profile_outlet_access and client_groups rows these change (the
-- last two through ACCESS §5's triggers, applied before this file).

-- (a) GROUP-1: a group whose recorded HQ is no longer one of its outlets has no HQ.
UPDATE public.client_groups g
   SET hq_client_id = NULL
 WHERE g.hq_client_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.clients c WHERE c.id = g.hq_client_id AND c.group_id = g.id);

-- (b) GROUP-3: every stock-count PIN login starts at home, with no other outlet and no employee link
--     at another outlet (as 20261009130000 section 3 did for till PINs).
UPDATE public.profiles
   SET active_client_id = NULL
 WHERE ims_email IS NOT NULL
   AND active_client_id IS NOT NULL;

DELETE FROM public.profile_employee_links l
 USING public.profiles p
 WHERE p.id = l.profile_id
   AND p.ims_email IS NOT NULL;

DELETE FROM public.profile_outlet_access a
 USING public.profiles p
 WHERE p.id = a.profile_id
   -- Lead, S849 merge (review M2): till PINs too, so the closing assert cannot trip on a stray grant
   -- left from before 20261009130000 section 3 (0 rows live 2026-10-15).
   AND (p.ims_email IS NOT NULL OR p.pos_email IS NOT NULL);

-- (c) GROUP-15: a Crest Staff (Self-Service) login holds no other outlet.
DELETE FROM public.profile_outlet_access a
 USING public.profiles p
 WHERE p.id = a.profile_id
   AND COALESCE(p.hr_self_service, false);

-- (d) GROUP-9: grants and employee links whose login's home and outlet are not in one group.
DELETE FROM public.profile_outlet_access a
 USING public.profiles p, public.clients hc, public.clients tc
 WHERE p.id = a.profile_id AND hc.id = p.client_id AND tc.id = a.client_id
   AND NOT COALESCE(hc.group_id = tc.group_id, false);

DELETE FROM public.profile_employee_links l
 USING public.profiles p, public.clients hc, public.clients tc
 WHERE p.id = l.profile_id AND hc.id = p.client_id AND tc.id = l.client_id
   AND NOT COALESCE(hc.group_id = tc.group_id, false);


-- ── 12. Catalog assertions (values Postgres computes, never formatted text) ───────────────────
DO $assert$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('public.push_master_data(uuid[],text[],boolean)', true),
      ('public.get_group_summary(integer,integer,date,date,integer,uuid)', true),
      ('public.get_group_item_prices(integer,integer,uuid)', true),
      ('public.is_client_owner()', true),
      ('public.set_active_outlet(uuid)', true),
      ('public.set_outlet_access(uuid,uuid[])', true),
      ('public.revoke_outlet_access(uuid,uuid)', true),
      ('public.get_outlet_reaching_logins(uuid)', true),
      ('public.get_group_outlet_access(uuid)', true),
      ('public.profile_is_owner(public.profiles)', false)
    ) AS t(sig, definer)
  LOOP
    IF to_regprocedure(r.sig) IS NULL THEN
      RAISE EXCEPTION 'S849 GROUP: % is missing', r.sig;
    END IF;
    IF (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure(r.sig)) IS DISTINCT FROM r.definer THEN
      RAISE EXCEPTION 'S849 GROUP: % SECURITY DEFINER is not %', r.sig, r.definer;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = to_regprocedure(r.sig)
                    AND proconfig @> ARRAY['search_path=public']) THEN
      RAISE EXCEPTION 'S849 GROUP: % lost its search_path', r.sig;
    END IF;
    IF has_function_privilege('anon', r.sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'S849 GROUP: anon can execute %', r.sig;
    END IF;
    IF NOT has_function_privilege('authenticated', r.sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'S849 GROUP: authenticated cannot execute %', r.sig;
    END IF;
  END LOOP;

  IF has_function_privilege('authenticated', 'public.clear_stale_active_outlet()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.clear_stale_active_outlet()', 'EXECUTE') THEN
    RAISE EXCEPTION 'S849 GROUP: a browser role can execute clear_stale_active_outlet()';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'public.clients'::regclass AND NOT tgisinternal
                    AND tgfoid = 'public.clear_stale_active_outlet()'::regprocedure) THEN
    RAISE EXCEPTION 'S849 GROUP: clear_stale_active_outlet is no longer attached to clients';
  END IF;

  -- The new return shapes, by catalog column (pronargs / proallargtypes), not by text.
  IF (SELECT array_length(proallargtypes, 1) FROM pg_proc
       WHERE oid = 'public.push_master_data(uuid[],text[],boolean)'::regprocedure) <> 12 THEN
    RAISE EXCEPTION 'S849 GROUP: push_master_data does not return the nine S849 columns';
  END IF;
  IF (SELECT array_length(proallargtypes, 1) FROM pg_proc
       WHERE oid = 'public.get_group_summary(integer,integer,date,date,integer,uuid)'::regprocedure) <> 16 THEN
    RAISE EXCEPTION 'S849 GROUP: get_group_summary does not take six arguments and return the ten S849 columns';
  END IF;
  IF (SELECT array_length(proallargtypes, 1) FROM pg_proc
       WHERE oid = 'public.get_group_item_prices(integer,integer,uuid)'::regprocedure) <> 11 THEN
    RAISE EXCEPTION 'S849 GROUP: get_group_item_prices does not take p_group_id';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace
              AND proname IN ('get_group_summary', 'get_group_item_prices', 'get_group_outlet_access')
              GROUP BY proname HAVING count(*) <> 1) THEN
    RAISE EXCEPTION 'S849 GROUP: an old overload of a group read function survived';
  END IF;
  IF (SELECT array_length(proallargtypes, 1) FROM pg_proc
       WHERE oid = 'public.get_group_outlet_access(uuid)'::regprocedure) <> 11 THEN
    RAISE EXCEPTION 'S849 GROUP: get_group_outlet_access does not return login_kind';
  END IF;
  -- The directive the write pass depends on (multi-outlet.md: without it every real push raised 42702).
  IF position('#variable_conflict use_column' IN
       (SELECT prosrc FROM pg_proc WHERE oid = 'public.push_master_data(uuid[],text[],boolean)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'S849 GROUP: push_master_data lost #variable_conflict use_column';
  END IF;

  -- Nothing left over from the clean-up.
  IF EXISTS (SELECT 1 FROM public.client_groups g
              WHERE g.hq_client_id IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM public.clients c WHERE c.id = g.hq_client_id AND c.group_id = g.id))
     OR EXISTS (SELECT 1 FROM public.profile_outlet_access a JOIN public.profiles p ON p.id = a.profile_id
                 WHERE p.ims_email IS NOT NULL OR p.pos_email IS NOT NULL OR COALESCE(p.hr_self_service, false)) THEN
    RAISE EXCEPTION 'S849 GROUP: a stray HQ or grant survived the clean-up';
  END IF;
END;
$assert$;

COMMIT;

NOTIFY pgrst, 'reload schema';
