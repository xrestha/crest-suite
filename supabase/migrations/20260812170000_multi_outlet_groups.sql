-- Multi-Outlet: group several clients under one owner, let them switch between outlets from a
-- single login, and roll the group up on one screen. Gated by Crest Suite Pro (multi_outlet).
--
-- ARCHITECTURE — selected-outlet indirection, NOT policy rewriting.
--
-- my_client_id() appears in ~151 places across 18 migrations. Rewriting those to a set-returning
-- my_client_ids() would touch every policy on ~50 tables AND permanently widen RLS from "one
-- client" to "any client in my group", removing RLS as the backstop behind scopedDb's filter.
--
-- Instead: add profiles.active_client_id and redefine ONLY my_client_id() to prefer it. Every
-- policy keeps its exact shape and simply resolves to the selected outlet. The frontend gets the
-- same win free — useScopedDb binds clientId straight from AuthContext, so one value re-scopes
-- ~200 call sites and all 65 CLIENT_SCOPED_TABLES with no per-page edits.
--
-- BACKWARD COMPATIBILITY: both new columns default NULL, so the COALESCE below returns
-- client_id — byte-identical to today for every ungrouped client. No policy is rewritten, so all
-- 151 call sites keep their current SEMANTICS, not merely their current results.
--
-- Group-spanning reads deliberately CANNOT go through scoped queries. The group console uses
-- get_group_summary() below, which does its own caller check — the established pattern of
-- get_client_profile_names / get_guest_menu.

-- ── Schema ───────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.client_groups (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  hq_client_id  uuid REFERENCES public.clients(id) ON DELETE SET NULL,
  created_at    timestamptz DEFAULT now()
);

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS group_id uuid REFERENCES public.client_groups(id) ON DELETE SET NULL;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS active_client_id uuid REFERENCES public.clients(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_clients_group_id ON public.clients(group_id) WHERE group_id IS NOT NULL;

ALTER TABLE public.client_groups ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON public.client_groups TO authenticated;
GRANT ALL    ON public.client_groups TO service_role;

-- ── Helpers ──────────────────────────────────────────────────────────────────────────────────
-- The caller's group, resolved from their HOME client (profiles.client_id), never from the
-- selected outlet — otherwise switching outlets could walk from one group into another.
CREATE OR REPLACE FUNCTION public.my_group_id() RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path TO 'public'
  AS $$
  select c.group_id
    from profiles p
    join clients c on c.id = p.client_id
   where p.id = (select auth.uid())
$$;

-- Redefined, same signature and same STABLE/SECURITY DEFINER contract as before. Deliberately a
-- plain COALESCE with no membership join: this runs per row across ~120 policies, and adding a
-- join here would be felt everywhere. Membership is validated at WRITE time in
-- set_active_outlet() instead, and a stale selection is cleared by the trigger below.
CREATE OR REPLACE FUNCTION public.my_client_id() RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path TO 'public'
  AS $$
  select coalesce(active_client_id, client_id) from profiles where id = (select auth.uid())
$$;

-- ── Switching outlets ────────────────────────────────────────────────────────────────────────
-- active_client_id must never be user-writable. S531 invariant #1 restricts client writes on
-- profiles to full_name/last_seen_at via guard_profiles_privileged_columns(), and this column is
-- deliberately NOT added to that allow-list — it is a privilege-bearing column, since it decides
-- which tenant's rows every RLS policy resolves to.
--
-- This function is the only write path. Under SECURITY DEFINER, current_user is the function
-- owner rather than 'authenticated', so the guard trigger passes it through — the same mechanism
-- record_pos_pin_attempt already relies on.
CREATE OR REPLACE FUNCTION public.set_active_outlet(p_client_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'public'
  AS $$
DECLARE
  v_home_group uuid;
  v_target_group uuid;
BEGIN
  -- NULL = go back to my own outlet. Always allowed.
  IF p_client_id IS NULL THEN
    UPDATE profiles SET active_client_id = NULL WHERE id = (select auth.uid());
    RETURN;
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
$$;

-- A regrouping must not leave anyone pointed at an outlet they can no longer reach. This is the
-- other half of keeping my_client_id() join-free.
CREATE OR REPLACE FUNCTION public.clear_stale_active_outlet() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'public'
  AS $$
BEGIN
  IF NEW.group_id IS DISTINCT FROM OLD.group_id THEN
    UPDATE profiles SET active_client_id = NULL
     WHERE active_client_id = NEW.id OR client_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_clear_stale_active_outlet ON public.clients;
CREATE TRIGGER trg_clear_stale_active_outlet
  AFTER UPDATE OF group_id ON public.clients
  FOR EACH ROW EXECUTE FUNCTION public.clear_stale_active_outlet();

-- ── RLS ──────────────────────────────────────────────────────────────────────────────────────
-- The ONE policy that must change: the switcher has to list sibling outlets, and clients_select
-- was id = my_client_id() OR is_admin() — so a customer could not read that a sibling exists.
-- Note my_client_id() now resolves to the SELECTED outlet, so the group clause is also what
-- keeps the home outlet readable after switching away from it.
ALTER POLICY clients_select ON public.clients
  USING (
    id = (select public.my_client_id())
    OR (group_id IS NOT NULL AND group_id = (select public.my_group_id()))
    OR (select public.is_admin())
  );

-- Members read their own group row; only admin writes.
DROP POLICY IF EXISTS client_groups_select ON public.client_groups;
CREATE POLICY client_groups_select ON public.client_groups FOR SELECT
  USING (id = (select public.my_group_id()) OR (select public.is_admin()));

DROP POLICY IF EXISTS client_groups_write ON public.client_groups;
CREATE POLICY client_groups_write ON public.client_groups FOR ALL
  USING ((select public.is_admin())) WITH CHECK ((select public.is_admin()));

-- ── Group rollup ─────────────────────────────────────────────────────────────────────────────
-- Returns one row per outlet in the caller's group. Outlets WITHOUT Crest Suite Pro come back
-- with is_included = false and NULL figures, so the page can state its coverage instead of
-- silently under-reporting the group total. The suite_plan filter is server-side on purpose: a
-- client-side filter would ship an unpaid outlet's revenue to the browser and then hide it.
--
-- Aligned on (bs_year, bs_month), never period_id — monthly_periods is UNIQUE(client_id, bs_year,
-- bs_month) with one open period per client, so two outlets legitimately sit in different months.
-- An outlet with no period for the month returns has_period = false rather than a silent zero.
--
-- p_ad_start/p_ad_end exist because pos_orders has NO period_id or BS columns at all — only AD
-- closed_at — and the BS->AD conversion lives in JS (bsCalendar.js), not in SQL. The caller
-- converts the same BS month with bsToAd() and passes the range, matching SalesReport.jsx's own
-- convention. Covers come back 0 rather than wrong if the range is omitted.
--
-- Raw aggregates only; the page derives food cost % and labour cost %. That keeps this function
-- from becoming a fourth independent definition of those formulas.
CREATE OR REPLACE FUNCTION public.get_group_summary(
  p_bs_year integer,
  p_bs_month integer,
  p_ad_start date DEFAULT NULL,
  p_ad_end   date DEFAULT NULL
)
RETURNS TABLE (
  client_id     uuid,
  client_name   text,
  is_included   boolean,
  has_period    boolean,
  revenue       numeric,
  net_purchases numeric,
  payroll       numeric,
  covers        bigint
)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path TO 'public'
  AS $$
DECLARE
  v_group uuid;
BEGIN
  v_group := public.my_group_id();
  IF v_group IS NULL THEN
    RAISE EXCEPTION 'Not permitted: you are not part of an outlet group.';
  END IF;

  RETURN QUERY
  WITH outlets AS (
    SELECT c.id, c.name, (c.suite_plan = 'pro') AS included
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
    CASE WHEN o.included THEN COALESCE((
      SELECT sum(se.qty_sold * COALESCE(r.selling_price, 0))
        FROM sales_entries se JOIN recipes r ON r.id = se.recipe_id
       WHERE se.period_id = per.period_id
    ), 0) END,
    CASE WHEN o.included THEN COALESCE((
      SELECT sum(pe.qty * pe.rate) - COALESCE(sum(pe.discount_amount), 0)
        FROM purchase_entries pe
       WHERE pe.period_id = per.period_id
    ), 0) END,
    CASE WHEN o.included THEN COALESCE((
      SELECT sum(ps.gross + COALESCE(ps.ssf_employer, 0))
        FROM hr_payslips ps JOIN hr_payroll_runs pr ON pr.id = ps.run_id
       WHERE pr.client_id = o.id AND pr.period_id = per.period_id AND pr.status = 'finalized'
    ), 0) END,
    CASE WHEN o.included AND p_ad_start IS NOT NULL AND p_ad_end IS NOT NULL THEN COALESCE((
      SELECT sum(po.covers)::bigint FROM pos_orders po
       WHERE po.client_id = o.id
         AND po.close_type = 'paid'
         AND po.closed_at >= p_ad_start::timestamptz
         AND po.closed_at <  (p_ad_end + 1)::timestamptz
    ), 0) ELSE 0 END
  FROM outlets o JOIN per ON per.cid = o.id
  ORDER BY o.name;
END;
$$;

-- ── Grants ───────────────────────────────────────────────────────────────────────────────────
-- REVOKE FROM anon alone is a silent no-op while PUBLIC still holds the grant (S532/postgres
-- ACLs are additive). Revoke from PUBLIC, then grant explicitly — service_role is NOT a
-- superuser in this project and needs its own grant.
REVOKE EXECUTE ON FUNCTION public.set_active_outlet(uuid)          FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_group_summary(integer, integer, date, date) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.my_group_id()                    FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.set_active_outlet(uuid)          TO authenticated, service_role;
GRANT  EXECUTE ON FUNCTION public.get_group_summary(integer, integer, date, date) TO authenticated, service_role;
GRANT  EXECUTE ON FUNCTION public.my_group_id()                    TO authenticated, service_role;

-- ── Verification (do not trust "Success. No rows returned.") ─────────────────────────────────
--   SELECT has_function_privilege('anon','public.set_active_outlet(uuid)','EXECUTE');          -- false
--   SELECT has_function_privilege('anon','public.get_group_summary(integer,integer,date,date)','EXECUTE'); -- false
--   SELECT has_function_privilege('anon','public.my_group_id()','EXECUTE');                     -- false
-- is_admin()/my_client_id() must stay anon-executable — revoking either blanks the app name for
-- every signed-out visitor via settings_select (see CLAUDE.md):
--   SELECT has_function_privilege('anon','public.my_client_id()','EXECUTE');                    -- true
--   SELECT has_function_privilege('anon','public.is_admin()','EXECUTE');                        -- true
-- Ungrouped clients unchanged (expect 0 rows):
--   SELECT count(*) FROM profiles WHERE active_client_id IS NOT NULL;
