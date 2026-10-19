-- STATUS: complete (draft for review; apply only on the owner's "apply")
-- ════════════════════════════════════════════════════════════════════════════════════════════
-- S849 ACCESS cluster: who may open what, what the account's dates hold open, the login link, and
-- the audit / same-client hygiene behind the Suite tables.
-- Proposed file name: supabase/migrations/2026101612xxxx_suite_access_s849.sql
--
-- Findings: DATABASE-2 (P1), ACCESS-2, ACCESS-1's SQL twin, ACCESS-4 item 5 + DATABASE-9 (CHECK),
--           the demo outlets (S848.2 found item, owner (a)), DATABASE-5, DATABASE-3 (forecast link
--           only), DATABASE-9 (policies). Built on the LATEST definitions in
--           supabase/migrations/ (live matched the migrations on 2026-10-15, S848.2).
--
-- Objects, and how to roll each back:
--   §0 Pre-flight (no object): refuses the file unless the live log_audit() is the body §5(b) was
--        built on (md5 pin, 2026-10-19). Nothing to roll back.
--   §1 public.profiles_client_move_clears_outlet_state()  REPLACED: same body, now SECURITY DEFINER,
--        PUBLIC execute revoked. Rollback: CREATE OR REPLACE from 20260910140000 (INVOKER) —
--        which re-breaks Admin → Clients Create User / Move login.
--   §2 public.client_suite_live(uuid)                      CREATED: SQL twin of suiteState(c).live
--        (src/utils/subscription.js). Called by GROUP's / PNL's group roll-ups. No client role may
--        execute it. Rollback: DROP FUNCTION public.client_suite_live(uuid) — only after the group
--        roll-ups stop calling it.
--   §3 public.client_access_open(uuid)                     REPLACED: the Suite and Customization end
--        dates no longer hold the outlet open (SU5 (a)). Rollback: CREATE OR REPLACE from
--        20261009140000 (the six-date GREATEST).
--   §4 clients_suite_plan_check                            REPLACED: NULL | 'pro' only (was
--        starter|growth|pro). Rollback: DROP CONSTRAINT, ADD the 20260708140000 CHECK.
--   §4b clients.is_internal                                ADDED column: boolean NOT NULL DEFAULT
--        false, "demo, not a customer" (owner answer (a), 2026-10-16). Audited through the existing
--        audit_clients trigger. Rollback: DROP COLUMN, only after the app and billing-export stop
--        selecting it (billing-export would 500 on a missing column).
--   §5 profile_outlet_access.id                            ADDED column (uuid, default random).
--        public.log_audit()                                REPLACED: one new branch for
--        client_groups (no client_id column); otherwise the live body, which is 20260915090000
--        + S754 §12's in-place 'items_version' noise-skip (20260916100000) + S840 §5's in-place
--        strip removal (20261015100000); no later migration touches it. §0 refuses the file
--        unless live md5(prosrc) is that body's (1016da31…), and §9 checks the new body's md5.
--        Rebuild/diff tool: .s849/tools/logaudit_live.py. Rollback: CREATE OR REPLACE from the
--        live body read back before apply (pg_get_functiondef), or 20260915090000 with S754 §12
--        and S840 §5 re-run, in that order.
--        TRIGGERS audit_profile_outlet_access, audit_assets_repair_expenses,
--        audit_assets_categories, audit_client_groups  CREATED. Rollback: DROP TRIGGER … each.
--        (The column can stay; dropping it after the trigger is gone is harmless.)
--   §6 public.suite_same_client()                          CREATED (trigger function, DEFINER).
--        TRIGGER suite_same_client_recipe_id on demand_forecast_daily(recipe_id) CREATED.
--        (Lead, S849 merge: monthly_owner_reports.period_id is covered by the OR migration's
--        owner_report_1_same_client, and the four asset tables' links by the ASSETS migration's
--        assets_same_client, so they are not repeated here.) Rollback: DROP TRIGGER, then
--        DROP FUNCTION public.suite_same_client().
--   §7 ALTER POLICY ×11: the eight assets_*_client policies, demand_forecast_daily.client_own,
--        demand_forecast_run_log.client_own (inline admin test → is_admin(); asset policies
--        TO authenticated), profile_outlet_access_select (helpers wrapped as initplans).
--        Expression-only. Rollback: ALTER POLICY back to the 20260909180000 / 20260929110000 /
--        20260909160000 / 20260827130000 expressions (and TO public for the seven asset ones).
--   §8 Probe, rolled back. §9 Catalog read-back.
--   §10 DATA: is_internal = true on exactly 'BLOOM CAFE' and 'BLOOM CAFE - PKR' (asserted: 2 rows).
--        Rollback: UPDATE public.clients SET is_internal = false WHERE name IN (those two).
--        This is the only data this migration changes.
--
-- Order: apply this file BEFORE OD / GROUP / PNL (they call client_suite_live), and redeploy
-- billing-export only AFTER it (the function selects clients.is_internal).
--
-- Not here, on purpose (other clusters own them; see plan-ACCESS.md CROSS):
--   monthly_owner_reports_all (OR rewrites it for OWNER-REPORT-4), push_master_data /
--   set_outlet_access / client_groups HQ-membership trigger (GROUP), the group roll-ups (GROUP/PNL),
--   asset numbering (ASSETS), the owner-report and asset same-client links (OR, ASSETS), the group
--   read RPCs' p_group_id support-view parameter (GROUP, PNL, OD).
-- ════════════════════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── §0 Pre-flight: the log_audit body §5(b) is built on is the one live ──────────────────────
-- §5(b) replaces log_audit() whole, so a live body that moved since this file was written (a later
-- in-place patch) would be silently undone. 1016da318fe630c36d8c19bdf346674a is md5(prosrc) of the
-- S753 body with S754 §12's replace() and S840 §5's patch applied (computed by
-- .s849/tools/logaudit_live.py, which also asserts the intermediate post-S754 md5 equals the
-- ce02b83b… S840 §0 itself pinned). If this raises, rebuild §5(b) from pg_get_functiondef and re-pin.
DO $$
BEGIN
  IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = 'public.log_audit()'::regprocedure)
     IS DISTINCT FROM '1016da318fe630c36d8c19bdf346674a' THEN
    RAISE EXCEPTION 'S849 §0: public.log_audit() changed since this file was written; rebuild §5(b) from the live body';
  END IF;
END;
$$;


-- ── §1 DATABASE-2 (P1, SU20): a moved or newly linked login no longer fails ──────────────────
-- Since 20260910140000 this trigger ran as the caller. The operator's browser session holds only
-- SELECT on profile_outlet_access (S848.2 live: ACL authenticated=r, and no DELETE policy), so the
-- DELETE below raised 42501 at statement start, even with no rows to delete, and rolled back the
-- whole Create User / Move login upsert.
--
-- DEFINER is safe here: the function touches only the moved login's own rows, has no
-- current_user test that DEFINER would change, and a client session never reaches it because
-- guard_profiles_privileged_columns (alphabetically first BEFORE UPDATE trigger) refuses any
-- non-admin client_id change and aborts the statement. Moving the link into admin-user-ops is the
-- later step SU20 names; this is the one-line fix.
CREATE OR REPLACE FUNCTION public.profiles_client_move_clears_outlet_state()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.client_id IS DISTINCT FROM OLD.client_id THEN
    NEW.active_client_id := NULL;
    DELETE FROM public.profile_outlet_access WHERE profile_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION public.profiles_client_move_clears_outlet_state() IS
  'S736/S849: a login moved to another client loses its selected outlet and its outlet allowlist. SECURITY DEFINER since S849 (DATABASE-2): the operator''s browser session has no DELETE on profile_outlet_access.';
-- A trigger function needs no grant (EXECUTE is checked at CREATE TRIGGER time).
REVOKE ALL ON FUNCTION public.profiles_client_move_clears_outlet_state() FROM PUBLIC;


-- ── §2 ACCESS-1's twin: "is Crest Suite Pro live for this outlet" ─────────────────────────────
-- suiteState(client).live in src/utils/subscription.js, rule for rule, in its order:
--   suite_plan is not 'pro'                          → not live (NULL, and any retired tier)
--   ims_enabled is false                             → not live (Suite needs Crest IMS; ACCESS-3)
--   no Suite date, no IMS date, no legacy date       → LIVE (fails open, SU12; operator screens
--                                                       mark it "No end date")
--   else the first of suite / IMS / legacy end date  → live while ceil(days left) >= -7 (GRACE_DAYS)
-- A client id that does not exist is not live. clientSuiteLive.test.js holds the two copies
-- together, and checks that every group roll-up reads this rather than suite_plan alone.
--
-- SECURITY INVOKER and no client role may call it, like client_access_open: every caller is a
-- SECURITY DEFINER group roll-up owned by postgres, and a browser asking it directly would learn
-- another outlet's billing state.
CREATE OR REPLACE FUNCTION public.client_suite_live(p_client_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $fn$
  SELECT COALESCE((
    SELECT CASE
             WHEN c.suite_plan IS DISTINCT FROM 'pro' THEN false
             WHEN c.ims_enabled IS FALSE THEN false
             WHEN e.suite_end IS NULL THEN true
             ELSE ceil(extract(epoch FROM (e.suite_end - now())) / 86400.0) >= -7
           END
      FROM public.clients c
      CROSS JOIN LATERAL (
        SELECT COALESCE(c.suite_ends_at, c.ims_ends_at, c.subscription_ends_at) AS suite_end
      ) e
     WHERE c.id = p_client_id
  ), false);
$fn$;
COMMENT ON FUNCTION public.client_suite_live(uuid) IS
  'S849: the SQL twin of suiteState(client).live (src/utils/subscription.js). The group roll-ups count an outlet only when this is true. No client role may execute it.';
REVOKE ALL ON FUNCTION public.client_suite_live(uuid) FROM PUBLIC, anon, authenticated;


-- ── §3 ACCESS-2 (SU5 (a)): only the main modules' dates keep an outlet open ──────────────────
-- getAccessState(client), rule for rule, in its order:
--   is_active = false                                   → locked ('deactivated'; Archive sets it too)
--   is_trial and trial_approved_at IS NULL              → locked ('pending'), before any date
--   is_trial and trial_expires_at has passed            → locked ('trial'), no grace
--   no end date on IMS, HR, POS or the legacy column    → OPEN (fails open, like the app)
--   the farthest of those four end dates, in whole days → open while ceil(days left) >= -7
--                                                          (7 = GRACE_DAYS)
-- The Suite and Customization dates are left out on purpose (owner decision SU5 (a), S849): a
-- prepaid add-on never keeps the account it sits on open. They still decide the add-on itself
-- (suiteState / client_suite_live; Customization's own window in clientMrr).
-- A NULL is_active or is_trial reads as the app reads it: not false, not a trial. A client id
-- that does not exist is not open.
--
-- SECURITY INVOKER, and no client role may call it (unchanged from S809).
CREATE OR REPLACE FUNCTION public.client_access_open(p_client_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $fn$
  SELECT COALESCE((
    SELECT CASE
             WHEN c.is_active IS FALSE THEN false
             WHEN COALESCE(c.is_trial, false) AND c.trial_approved_at IS NULL THEN false
             WHEN COALESCE(c.is_trial, false) AND c.trial_expires_at < now() THEN false
             WHEN e.last_end IS NULL THEN true
             ELSE ceil(extract(epoch FROM (e.last_end - now())) / 86400.0) >= -7
           END
      FROM public.clients c
      CROSS JOIN LATERAL (
        SELECT GREATEST(c.ims_ends_at, c.hr_ends_at, c.pos_ends_at, c.subscription_ends_at) AS last_end
      ) e
     WHERE c.id = p_client_id
  ), false);
$fn$;
COMMENT ON FUNCTION public.client_access_open(uuid) IS
  'S809/S849: the SQL twin of getAccessState(client).locked === false (src/utils/subscription.js). Weighs the IMS, HR, POS and legacy end dates only: an add-on date never holds an outlet open (SU5 a). Called beside the pos_enabled gate by every public guest-menu and booking function. No client role may execute it.';
REVOKE ALL ON FUNCTION public.client_access_open(uuid) FROM PUBLIC, anon, authenticated;


-- ── §4 ACCESS-4 item 5 / DATABASE-9: the Suite column holds NULL or 'pro', nothing else ───────
-- 20260708140000 created clients_suite_plan_check admitting starter|growth|pro, and
-- 20260812160000:22 wrongly says the column has no CHECK. Live 2026-10-15: 3 'pro', 1 NULL, so the
-- tighter CHECK passes today. The guard below names any row that would block it instead of
-- leaving a bare 23514.
DO $$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(name || ' (' || suite_plan || ')', ', ') INTO v_bad
    FROM public.clients WHERE suite_plan IS NOT NULL AND suite_plan <> 'pro';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'S849 §4: these clients carry a retired Suite tier; set them to pro or NULL first: %', v_bad;
  END IF;
END;
$$;
ALTER TABLE public.clients DROP CONSTRAINT IF EXISTS clients_suite_plan_check;
ALTER TABLE public.clients ADD CONSTRAINT clients_suite_plan_check
  CHECK (suite_plan IS NULL OR suite_plan = 'pro');


-- ── §4b S848.2 found item, owner answer (a): "demo, not a customer" ──────────────────────────
-- The two BLOOM outlets (the S810 prospect demo built on Crest's own practice account) are not
-- trials and carry paid-through dates, so Crest's own MRR counted them and billing-export marked
-- them billable. A trial flag cannot be used: is_trial without trial_approved_at locks the account
-- (getAccessState 'pending'). This switch changes NOTHING about access: no lock, gate, RLS policy or
-- SQL function reads it. clientMrr.js and billing-export read it (income 0, billable false).
--
-- NOT NULL DEFAULT false: every existing and future row is a customer unless the operator says
-- otherwise; NULL never means "maybe". Only the operator can set it: clients UPDATE is is_admin()
-- only (clients_update, baseline :3702), and no RPC writes it. Audit: clients already carries
-- audit_clients (log_audit, whole-row snapshot), so every switch of it is in the Audit Log with
-- who and when; §9 asserts that trigger is still there. Rollback: ALTER TABLE public.clients DROP
-- COLUMN is_internal (after billing-export and the app stop selecting it).
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS is_internal boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.clients.is_internal IS
  'S849: Crest''s own demo or practice outlet, not a customer. Works exactly like any outlet; never counted in MRR (clientMrr.js) and sent to hss-suite as billable = false (billing-export). Operator-only (clients_update is is_admin()).';


-- ── §5 DATABASE-5: Outlet Access grants, repair costs, asset categories and the group's HQ
--       leave an Audit Log trace ────────────────────────────────────────────────────────────────
-- (a) profile_outlet_access had no id, and log_audit() records OLD.id / NEW.id: without the
--     column every audit write would fail into log_audit's handler and record nothing (the same
--     reason profile_employee_links got one, 20261003160000). A volatile default fills each
--     existing row with its own value. Every writer names its columns, so none is affected.
ALTER TABLE public.profile_outlet_access ADD COLUMN IF NOT EXISTS id uuid NOT NULL DEFAULT gen_random_uuid();

-- (b) log_audit(): the live body (§0 pins it; pos_orders' noise-skip keeps S754's 'items_version'),
--     plus a client_groups branch, the ONLY difference (tools/logaudit_live.py diffs it).
--     client_groups has no client_id column, so the ELSE branch's NEW.client_id raised "record has
--     no field client_id", the outer
--     handler swallowed it, and a bare trigger there would record nothing (DATABASE-5's warning).
--     A group belongs to no one client: the row is written with no client and the group's name.
CREATE OR REPLACE FUNCTION public.log_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $$
DECLARE
  _client_id uuid; _client_name text; _user_id uuid; _user_name text; _record_id uuid;
  _old jsonb; _new jsonb; _found_name text;
BEGIN
  _user_id := auth.uid();
  IF _user_id IS NULL AND COALESCE(auth.role(), '') = 'service_role' THEN
    BEGIN
      _user_id := NULLIF(current_setting('request.headers', true)::json->>'x-crest-actor', '')::uuid;
    EXCEPTION WHEN OTHERS THEN
      _user_id := NULL;
    END;
  END IF;
  SELECT full_name INTO _user_name FROM profiles WHERE id = _user_id;

  IF TG_OP = 'DELETE' THEN
    _record_id := OLD.id;
    IF TG_TABLE_NAME IN ('purchase_entries','opening_stock','closing_stock','wastages') THEN
      SELECT client_id INTO _client_id FROM monthly_periods WHERE id = OLD.period_id;
    ELSIF TG_TABLE_NAME = 'clients' THEN
      _client_id := OLD.id; _client_name := OLD.name;
    ELSIF TG_TABLE_NAME = 'client_groups' THEN
      -- S849 (DATABASE-5): an outlet group is a platform row, not one client's.
      _client_id := NULL; _client_name := 'Outlet group: ' || OLD.name;
    ELSE _client_id := OLD.client_id; END IF;
  ELSE
    _record_id := NEW.id;
    IF TG_TABLE_NAME IN ('purchase_entries','opening_stock','closing_stock','wastages') THEN
      SELECT client_id INTO _client_id FROM monthly_periods WHERE id = NEW.period_id;
    ELSIF TG_TABLE_NAME = 'clients' THEN
      _client_id := NEW.id; _client_name := NEW.name;
    ELSIF TG_TABLE_NAME = 'client_groups' THEN
      _client_id := NULL; _client_name := 'Outlet group: ' || NEW.name;
    ELSE _client_id := NEW.client_id; END IF;
  END IF;

  IF TG_TABLE_NAME = 'monthly_periods' AND TG_OP = 'UPDATE' THEN
    IF (OLD.status, OLD.bs_year, OLD.bs_month) IS NOT DISTINCT FROM (NEW.status, NEW.bs_year, NEW.bs_month)
    THEN RETURN NULL; END IF;
  END IF;

  IF TG_TABLE_NAME = 'profiles' AND TG_OP = 'UPDATE' THEN
    IF (to_jsonb(OLD) - ARRAY['pos_pin_failed_attempts','pos_pin_locked_until','hr_pin_failed_attempts','hr_pin_locked_until','ims_pin_failed_attempts','ims_pin_locked_until','last_seen_at'])
       = (to_jsonb(NEW) - ARRAY['pos_pin_failed_attempts','pos_pin_locked_until','hr_pin_failed_attempts','hr_pin_locked_until','ims_pin_failed_attempts','ims_pin_locked_until','last_seen_at'])
    THEN RETURN NULL; END IF;
  END IF;

  IF TG_TABLE_NAME = 'pos_orders' AND TG_OP = 'UPDATE' THEN
    IF (to_jsonb(OLD) - ARRAY['covers','print_count','comp_print_count','notes','items_version'])
       = (to_jsonb(NEW) - ARRAY['covers','print_count','comp_print_count','notes','items_version'])
    THEN RETURN NULL; END IF;
  END IF;

  IF _client_id IS NOT NULL THEN
    SELECT name INTO _found_name FROM clients WHERE id = _client_id;
    IF NOT FOUND THEN
      _client_id := NULL;
    ELSIF _client_name IS NULL THEN
      _client_name := _found_name;
    END IF;
  END IF;

  _old := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END;
  _new := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END;

  -- S840: the pos_device_secret strip on clients snapshots went: the column left clients in S531
  -- (client_secrets), so there was nothing left to strip.

  INSERT INTO audit_logs (client_id, client_name, user_id, user_name, table_name, action, record_id, old_data, new_data)
  VALUES (_client_id, _client_name, _user_id, _user_name, TG_TABLE_NAME, TG_OP, _record_id, _old, _new);
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$;

-- (c) The four triggers. Outlet Access rows are filed under the outlet granted (its client_id),
--     so that outlet's history shows who was given it, by whom (auth.uid() inside the DEFINER
--     RPCs is still the caller), and when it was taken away. The Owner Report's own trail is
--     OWNER-REPORT-4's (OR cluster).
CREATE OR REPLACE TRIGGER audit_profile_outlet_access
  AFTER INSERT OR DELETE OR UPDATE ON public.profile_outlet_access
  FOR EACH ROW EXECUTE FUNCTION public.log_audit();
CREATE OR REPLACE TRIGGER audit_assets_repair_expenses
  AFTER INSERT OR DELETE OR UPDATE ON public.assets_repair_expenses
  FOR EACH ROW EXECUTE FUNCTION public.log_audit();
CREATE OR REPLACE TRIGGER audit_assets_categories
  AFTER INSERT OR DELETE OR UPDATE ON public.assets_categories
  FOR EACH ROW EXECUTE FUNCTION public.log_audit();
CREATE OR REPLACE TRIGGER audit_client_groups
  AFTER INSERT OR DELETE OR UPDATE ON public.client_groups
  FOR EACH ROW EXECUTE FUNCTION public.log_audit();


-- ── §6 DATABASE-3: a Suite row may point only at its own client's parent row ──────────────────
-- The S792 DATABASE-11 check (ims_item_same_client) covers item_id on eleven IMS tables and none
-- of these columns, and RLS checks only the row's own client_id. A planted foreign id on a NO
-- ACTION column (owner reports → months, register → categories, schedule → assets) then stops
-- the OTHER client's Danger Zone, Archive, Clear IMS or trial purge partway; on a CASCADE / SET
-- NULL column the planted row silently goes with the other client's parent.
--
-- TG_ARGV[0] is the referencing column, TG_ARGV[1] the parent table; both are fixed when the
-- trigger is created below, never taken from a row. The column is read through to_jsonb(NEW), so
-- one function serves every table without naming a field the table may lack. SECURITY DEFINER,
-- like ims_item_same_client: the planted parent is exactly the row the caller's RLS hides, and an
-- INVOKER lookup would find nothing and let it through. A parent that cannot be found is left to
-- the foreign key. The app never sends a cross-client id, so no screen meets this error.
CREATE OR REPLACE FUNCTION public.suite_same_client()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_ref   uuid;
  v_owner uuid;
BEGIN
  v_ref := (to_jsonb(NEW) ->> TG_ARGV[0])::uuid;
  IF v_ref IS NULL THEN RETURN NEW; END IF;
  EXECUTE format('SELECT client_id FROM public.%I WHERE id = $1', TG_ARGV[1]) INTO v_owner USING v_ref;
  IF v_owner IS NOT NULL AND v_owner IS DISTINCT FROM NEW.client_id THEN
    RAISE EXCEPTION 'suite_other_client: that % belongs to another business', TG_ARGV[0]
      USING ERRCODE = '23503', HINT = 'suite_other_client';
  END IF;
  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION public.suite_same_client() FROM PUBLIC;

DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT * FROM (VALUES
    -- Lead, S849 merge: the owner-report and asset links are checked by the OR and ASSETS
    -- migrations' own triggers; only the forecast's dish link is left to this one.
    ('demand_forecast_daily',        'recipe_id',   'recipes')
  ) AS v(tbl, col, parent) LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', 'suite_same_client_' || t.col, t.tbl);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT OR UPDATE OF %I, client_id ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.suite_same_client(%L, %L)',
      'suite_same_client_' || t.col, t.col, t.tbl, t.col, t.parent);
  END LOOP;
END;
$$;


-- ── §7 DATABASE-9: the Suite policies call is_admin() instead of re-deriving it ───────────────
-- Expression-only ALTER POLICY (supabase-sql.md): command lists untouched. The inline
-- (SELECT role FROM profiles …) = 'admin' is hoisted as an InitPlan already, so this is about one
-- definition of "admin" (supabase-sql.md:22), not cost; the wrapped helpers in
-- profile_outlet_access_select are the per-row cost DATABASE-9 names. The seven older asset
-- policies were created with no TO clause ({public}); anon holds no grant on these tables, so
-- TO authenticated changes no answer and matches openings.
ALTER POLICY assets_categories_client ON public.assets_categories TO authenticated
  USING ( COALESCE((select public.is_admin()), false) OR client_id = (select public.my_client_id()) )
  WITH CHECK ( COALESCE((select public.is_admin()), false) OR client_id = (select public.my_client_id()) );
ALTER POLICY assets_depreciation_runs_client ON public.assets_depreciation_runs TO authenticated
  USING ( COALESCE((select public.is_admin()), false) OR client_id = (select public.my_client_id()) )
  WITH CHECK ( COALESCE((select public.is_admin()), false) OR client_id = (select public.my_client_id()) );
ALTER POLICY assets_depreciation_schedule_client ON public.assets_depreciation_schedule TO authenticated
  USING ( COALESCE((select public.is_admin()), false) OR client_id = (select public.my_client_id()) )
  WITH CHECK ( COALESCE((select public.is_admin()), false) OR client_id = (select public.my_client_id()) );
ALTER POLICY assets_register_client ON public.assets_register TO authenticated
  USING ( COALESCE((select public.is_admin()), false) OR client_id = (select public.my_client_id()) )
  WITH CHECK ( COALESCE((select public.is_admin()), false) OR client_id = (select public.my_client_id()) );
ALTER POLICY assets_repair_expenses_client ON public.assets_repair_expenses TO authenticated
  USING ( COALESCE((select public.is_admin()), false) OR client_id = (select public.my_client_id()) )
  WITH CHECK ( COALESCE((select public.is_admin()), false) OR client_id = (select public.my_client_id()) );
ALTER POLICY assets_tax_pool_lines_client ON public.assets_tax_pool_lines TO authenticated
  USING ( COALESCE((select public.is_admin()), false) OR client_id = (select public.my_client_id()) )
  WITH CHECK ( COALESCE((select public.is_admin()), false) OR client_id = (select public.my_client_id()) );
ALTER POLICY assets_tax_pool_runs_client ON public.assets_tax_pool_runs TO authenticated
  USING ( COALESCE((select public.is_admin()), false) OR client_id = (select public.my_client_id()) )
  WITH CHECK ( COALESCE((select public.is_admin()), false) OR client_id = (select public.my_client_id()) );
ALTER POLICY assets_tax_pool_openings_client ON public.assets_tax_pool_openings
  USING ( COALESCE((select public.is_admin()), false) OR client_id = (select public.my_client_id()) )
  WITH CHECK ( COALESCE((select public.is_admin()), false) OR client_id = (select public.my_client_id()) );
ALTER POLICY client_own ON public.demand_forecast_daily
  USING ( client_id = (select public.my_client_id()) OR COALESCE((select public.is_admin()), false) )
  WITH CHECK ( client_id = (select public.my_client_id()) OR COALESCE((select public.is_admin()), false) );
ALTER POLICY client_own ON public.demand_forecast_run_log
  USING ( client_id = (select public.my_client_id()) OR COALESCE((select public.is_admin()), false) )
  WITH CHECK ( client_id = (select public.my_client_id()) OR COALESCE((select public.is_admin()), false) );
ALTER POLICY profile_outlet_access_select ON public.profile_outlet_access
  USING (
    profile_id = (select auth.uid())
    OR COALESCE((select public.is_admin()), false)
    OR (
      COALESCE((select public.is_client_owner()), false)
      AND (select public.my_group_id()) IS NOT NULL
      AND client_id IN (SELECT id FROM public.clients WHERE group_id = (select public.my_group_id()))
    )
  );


-- ── §8 Probe, rolled back. Any failure fails the whole migration and nothing above lands. ─────
-- (a) the two date rules, at the edges the browser tests use; (b) DATABASE-2: the drawer's own
-- upsert as the operator under the browser role; (c) the four new audit trails, and an old one
-- still writing; (e) the CHECK. There is no (d) any more. The asset same-client refusal it tested
-- moved with its trigger into the ASSETS migration (assets_same_client) and is exercised only by
-- .s849/verify-ASSETS.sql probe (l), a read-only rolled-back block run by hand AFTER the ASSETS
-- migration, so nothing tests it while this file applies. The one link this file still adds (§6, the
-- forecast's dish) is read back in §9 (trigger present) and exercised by verify-ACCESS.sql's last block.
DO $probe$
DECLARE
  v_a uuid; v_b uuid; v_admin uuid; v_login uuid; v_name text;
  v_group uuid; v_poa uuid; v_cat_a uuid; v_cat_b uuid; v_rep uuid; v_asset uuid;
  v_n integer; v_state text; v_got boolean; v_want boolean; v_hint text; v_code text;
BEGIN
  SELECT id INTO v_a FROM public.clients ORDER BY name LIMIT 1;
  SELECT id INTO v_b FROM public.clients WHERE id <> v_a ORDER BY name LIMIT 1;
  SELECT id INTO v_admin FROM public.profiles WHERE role = 'admin' ORDER BY id LIMIT 1;
  -- An Owner-shaped login of some client other than v_b: the drawer's Move login case.
  SELECT p.id, p.full_name INTO v_login, v_name FROM public.profiles p
   WHERE p.role = 'client' AND p.client_id IS NOT NULL AND p.client_id <> v_b
     AND p.pos_role IS NULL AND p.pos_email IS NULL AND p.ims_role IS NULL AND p.ims_email IS NULL
     AND p.hr_role IS NULL AND COALESCE(p.hr_self_service, false) = false
   ORDER BY p.id LIMIT 1;
  IF v_a IS NULL OR v_b IS NULL OR v_admin IS NULL OR v_login IS NULL THEN
    RAISE EXCEPTION 'S849 ACCESS probe: needs two clients, an admin and an Owner login';
  END IF;

  BEGIN
    -- ── (a) client_access_open / client_suite_live ──
    FOREACH v_state IN ARRAY ARRAY[
      'open_no_dates', 'open_farthest_base', 'locked_suite_only', 'locked_customization_only',
      'open_grace_edge', 'locked_past_grace', 'open_addon_dates_only',
      'suite_off', 'suite_no_date', 'suite_dated', 'suite_grace_edge', 'suite_past_grace',
      'suite_ims_fallback_live', 'suite_ims_fallback_lapsed', 'suite_legacy_lapsed',
      'suite_date_preferred', 'suite_ims_off']
    LOOP
      UPDATE public.clients SET
          is_active = true, is_trial = false, trial_approved_at = NULL, trial_expires_at = NULL,
          suite_plan = CASE WHEN v_state LIKE 'suite\_%' AND v_state <> 'suite_off' THEN 'pro' END,
          ims_enabled = (v_state <> 'suite_ims_off'),
          ims_ends_at = CASE v_state
                          WHEN 'open_farthest_base'        THEN now() - interval '60 days'
                          WHEN 'locked_suite_only'         THEN now() - interval '60 days'
                          WHEN 'open_grace_edge'           THEN now() - interval '7 days 23 hours'
                          WHEN 'locked_past_grace'         THEN now() - interval '8 days 1 minute'
                          WHEN 'suite_ims_fallback_live'   THEN now() + interval '30 days'
                          WHEN 'suite_ims_fallback_lapsed' THEN now() - interval '60 days'
                          WHEN 'suite_date_preferred'      THEN now() + interval '60 days'
                        END,
          hr_ends_at  = CASE v_state WHEN 'open_farthest_base' THEN now() + interval '10 days' END,
          pos_ends_at = CASE v_state WHEN 'locked_customization_only' THEN now() - interval '60 days' END,
          customization_ends_at = CASE v_state
                          WHEN 'locked_customization_only' THEN now() + interval '300 days'
                          WHEN 'open_addon_dates_only'     THEN now() + interval '300 days'
                        END,
          suite_ends_at = CASE v_state
                          WHEN 'locked_suite_only'     THEN now() + interval '300 days'
                          WHEN 'open_addon_dates_only' THEN now() + interval '300 days'
                          WHEN 'suite_off'             THEN now() + interval '30 days'
                          WHEN 'suite_dated'           THEN now() + interval '30 days'
                          WHEN 'suite_grace_edge'      THEN now() - interval '7 days 23 hours'
                          WHEN 'suite_past_grace'      THEN now() - interval '8 days 1 minute'
                          WHEN 'suite_date_preferred'  THEN now() - interval '60 days'
                          WHEN 'suite_ims_off'         THEN now() + interval '30 days'
                        END,
          subscription_ends_at = CASE v_state WHEN 'suite_legacy_lapsed' THEN now() - interval '60 days' END
       WHERE id = v_a;

      IF v_state LIKE 'suite\_%' THEN
        v_got  := public.client_suite_live(v_a);
        v_want := v_state IN ('suite_no_date', 'suite_dated', 'suite_grace_edge', 'suite_ims_fallback_live');
      ELSE
        v_got  := public.client_access_open(v_a);
        v_want := v_state LIKE 'open\_%';
      END IF;
      IF v_got IS DISTINCT FROM v_want THEN
        RAISE EXCEPTION 'S849 probe (a): % gave %, expected %', v_state, v_got, v_want;
      END IF;
    END LOOP;
    IF public.client_suite_live(gen_random_uuid()) IS DISTINCT FROM false
       OR public.client_access_open(gen_random_uuid()) IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'S849 probe (a): a client that does not exist reads as open or Suite-live';
    END IF;
    -- The clients writes above still reached the Audit Log: the old branches still run.
    SELECT count(*) INTO v_n FROM public.audit_logs
     WHERE table_name = 'clients' AND record_id = v_a AND created_at = now();
    IF v_n = 0 THEN RAISE EXCEPTION 'S849 probe (c): log_audit no longer records a clients update'; END IF;

    -- ── (b) DATABASE-2: Admin → Clients "Move login", exactly as the drawer sends it ──
    INSERT INTO public.profile_outlet_access (profile_id, client_id, granted_by) VALUES (v_login, v_b, v_admin)
      ON CONFLICT DO NOTHING;
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_admin)::text, true);
    SET LOCAL ROLE authenticated;
    INSERT INTO public.profiles (id, client_id, full_name, role) VALUES (v_login, v_b, v_name, 'client')
      ON CONFLICT (id) DO UPDATE SET client_id = EXCLUDED.client_id, full_name = EXCLUDED.full_name, role = EXCLUDED.role;
    RESET ROLE;
    PERFORM set_config('request.jwt.claims', '', true);
    IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_login AND client_id = v_b AND active_client_id IS NULL) THEN
      RAISE EXCEPTION 'S849 probe (b): the operator''s move did not land';
    END IF;
    IF EXISTS (SELECT 1 FROM public.profile_outlet_access WHERE profile_id = v_login) THEN
      RAISE EXCEPTION 'S849 probe (b): the moved login kept its outlet allowlist';
    END IF;
    -- The login itself still cannot move itself (guard_profiles_privileged_columns, unchanged).
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_login)::text, true);
    SET LOCAL ROLE authenticated;
    BEGIN
      UPDATE public.profiles SET client_id = v_a WHERE id = v_login;
      v_code := 'none';
    EXCEPTION WHEN OTHERS THEN
      v_code := SQLSTATE;
    END;
    RESET ROLE;
    PERFORM set_config('request.jwt.claims', '', true);
    IF v_code = 'none' AND EXISTS (SELECT 1 FROM public.profiles WHERE id = v_login AND client_id = v_a) THEN
      RAISE EXCEPTION 'S849 probe (b): a client login moved itself to another client';
    END IF;

    -- ── (c) the four new audit trails ──
    INSERT INTO public.client_groups (name) VALUES ('S849 probe group') RETURNING id INTO v_group;
    UPDATE public.client_groups SET name = 'S849 probe group renamed' WHERE id = v_group;
    DELETE FROM public.client_groups WHERE id = v_group;
    SELECT count(*) INTO v_n FROM public.audit_logs
     WHERE table_name = 'client_groups' AND record_id = v_group AND client_id IS NULL
       AND client_name LIKE 'Outlet group: S849 probe group%';
    IF v_n <> 3 THEN RAISE EXCEPTION 'S849 probe (c): client_groups wrote % audit rows, expected 3', v_n; END IF;

    INSERT INTO public.profile_outlet_access (profile_id, client_id, granted_by) VALUES (v_login, v_a, v_admin)
      RETURNING id INTO v_poa;
    IF NOT EXISTS (SELECT 1 FROM public.audit_logs WHERE table_name = 'profile_outlet_access'
                    AND record_id = v_poa AND action = 'INSERT' AND client_id = v_a) THEN
      RAISE EXCEPTION 'S849 probe (c): an Outlet Access grant left no audit row';
    END IF;

    INSERT INTO public.assets_categories (client_id, name) VALUES (v_a, 'S849 probe category') RETURNING id INTO v_cat_a;
    INSERT INTO public.assets_categories (client_id, name) VALUES (v_b, 'S849 probe category') RETURNING id INTO v_cat_b;
    INSERT INTO public.assets_repair_expenses (client_id, pool, fiscal_year, expense_date, amount, description)
      VALUES (v_a, 'B', '70/71', current_date, 100, 'S849 probe') RETURNING id INTO v_rep;
    SELECT count(*) INTO v_n FROM public.audit_logs
     WHERE (table_name = 'assets_categories' AND record_id IN (v_cat_a, v_cat_b))
        OR (table_name = 'assets_repair_expenses' AND record_id = v_rep);
    IF v_n <> 3 THEN RAISE EXCEPTION 'S849 probe (c): categories/repairs wrote % audit rows, expected 3', v_n; END IF;

    -- ── (e) the Suite CHECK ──
    BEGIN
      UPDATE public.clients SET suite_plan = 'starter' WHERE id = v_a;
      v_code := 'accepted';
    EXCEPTION WHEN check_violation THEN
      v_code := 'refused';
    END;
    IF v_code <> 'refused' THEN RAISE EXCEPTION 'S849 probe (e): suite_plan accepted a retired tier'; END IF;

    RAISE EXCEPTION 'S849 ACCESS probe ok';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'S849 ACCESS probe ok' THEN RAISE; END IF;
  END;

  PERFORM set_config('request.jwt.claims', '', true);
  IF EXISTS (SELECT 1 FROM public.client_groups WHERE name LIKE 'S849 probe%')
     OR EXISTS (SELECT 1 FROM public.assets_categories WHERE name = 'S849 probe category')
     OR EXISTS (SELECT 1 FROM public.profiles WHERE id = v_login AND client_id = v_b) THEN
    RAISE EXCEPTION 'S849 ACCESS probe: its fixtures were not rolled back';
  END IF;
  RAISE NOTICE 'S849 ACCESS probe: passed and rolled back';
END;
$probe$;


-- ── §9 Read back from the catalog ─────────────────────────────────────────────────────────────
DO $$
DECLARE v_n integer;
BEGIN
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.profiles_client_move_clears_outlet_state()'::regprocedure)
     OR has_function_privilege('anon', 'public.profiles_client_move_clears_outlet_state()', 'EXECUTE') THEN
    RAISE EXCEPTION 'S849 §1: the move trigger is not DEFINER, or PUBLIC still executes it';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'public.client_suite_live(uuid)'::regprocedure
                  AND NOT prosecdef AND provolatile = 's')
     OR has_function_privilege('anon', 'public.client_suite_live(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.client_suite_live(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'S849 §2: client_suite_live is missing, DEFINER, not STABLE, or a client role can execute it';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.client_access_open(uuid)'::regprocedure) ~ '(suite|customization)_ends_at'
     OR has_function_privilege('authenticated', 'public.client_access_open(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'S849 §3: client_access_open still weighs an add-on date, or a client role can execute it';
  END IF;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint
       WHERE conrelid = 'public.clients'::regclass AND conname = 'clients_suite_plan_check') ~ '(starter|growth)' THEN
    RAISE EXCEPTION 'S849 §4: the Suite CHECK still admits a retired tier';
  END IF;
  SELECT count(*) INTO v_n FROM pg_trigger
   WHERE NOT tgisinternal AND tgfoid = 'public.log_audit()'::regprocedure
     AND tgrelid IN ('public.profile_outlet_access'::regclass, 'public.assets_repair_expenses'::regclass,
                     'public.assets_categories'::regclass, 'public.client_groups'::regclass);
  IF v_n <> 4 THEN RAISE EXCEPTION 'S849 §5: % of the 4 audit triggers exist', v_n; END IF;
  -- 892dd6a8… = md5 of §5(b)'s body as written here (live body + the client_groups branch only).
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.log_audit()'::regprocedure)
     IS DISTINCT FROM '892dd6a887d63cffe98d68ee138e5728' THEN
    RAISE EXCEPTION 'S849 §5: log_audit''s body is not the one §5(b) wrote';
  END IF;
  SELECT count(*) INTO v_n FROM pg_trigger
   WHERE NOT tgisinternal AND tgfoid = 'public.suite_same_client()'::regprocedure;
  IF v_n <> 1 THEN RAISE EXCEPTION 'S849 §6: % of the 1 same-client trigger exist', v_n; END IF;
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename IN ('assets_categories','assets_depreciation_runs','assets_depreciation_schedule','assets_register',
                       'assets_repair_expenses','assets_tax_pool_lines','assets_tax_pool_runs','assets_tax_pool_openings',
                       'demand_forecast_daily','demand_forecast_run_log','profile_outlet_access')
     AND (position('profiles.role' IN COALESCE(qual, '') || COALESCE(with_check, '')) > 0
          OR (permissive = 'PERMISSIVE' AND roles::text = '{public}'));
  IF v_n <> 0 THEN RAISE EXCEPTION 'S849 §7: % Suite policies still spell the admin test inline or apply to public', v_n; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                  WHERE a.attrelid = 'public.clients'::regclass AND a.attname = 'is_internal' AND NOT a.attisdropped
                    AND a.atttypid = 'boolean'::regtype AND a.attnotnull
                    AND pg_get_expr(d.adbin, d.adrelid) = 'false') THEN
    RAISE EXCEPTION 'S849 §4b: clients.is_internal is missing, nullable, or not DEFAULT false';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgname = 'audit_clients'
                  AND tgrelid = 'public.clients'::regclass AND tgfoid = 'public.log_audit()'::regprocedure
                  AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'S849 §4b: clients is no longer audited, so the demo switch would leave no trace';
  END IF;
END;
$$;


-- ── §10 DATA (owner answer (a), 2026-10-16): the two BLOOM demo outlets are not customers ──────
-- Changes exactly two rows of clients, matched by name: is_internal → true on 'BLOOM CAFE' and
-- 'BLOOM CAFE - PKR' (S848.2: the S810 prospect demo on Crest's own practice account, not trials,
-- Suite and modules to 2027-07-03). No date, switch, plan or group changes, so both outlets keep
-- working exactly as they do; their MRR line and billing-export amount read 0 once the app and the
-- redeployed billing-export read the flag. Recorded in the Audit Log by audit_clients (no actor:
-- the migration). Anything other than exactly these two rows raises and nothing in this file lands.
-- Rollback: UPDATE public.clients SET is_internal = false WHERE name IN ('BLOOM CAFE', 'BLOOM CAFE - PKR');
DO $$
DECLARE v_n integer; v_all integer;
BEGIN
  UPDATE public.clients SET is_internal = true WHERE name IN ('BLOOM CAFE', 'BLOOM CAFE - PKR');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'S849 §10: expected exactly 2 BLOOM outlets to mark as demo, matched % (check the names)', v_n;
  END IF;
  SELECT count(*) INTO v_all FROM public.clients WHERE is_internal;
  IF v_all <> 2 THEN
    RAISE EXCEPTION 'S849 §10: % clients are marked demo, expected exactly the two BLOOM outlets', v_all;
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;
