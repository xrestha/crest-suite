-- ════════════════════════════════════════════════════════════════════════════════════════════
-- client_groups: one permissive policy per command (Performance Advisor 0006)
--
-- 20260812170000 created the pair the advisor is reporting:
--
--     client_groups_select  FOR SELECT  USING (id = my_group_id() OR is_admin())
--     client_groups_write   FOR ALL     USING (is_admin()) WITH CHECK (is_admin())
--
-- `FOR ALL` includes SELECT, so every read of client_groups evaluates BOTH policies and ORs the
-- results -- and the second one is a strict subset of the first (an admin already passes the
-- is_admin() arm of client_groups_select). Pure overhead, on every role, which is why the export
-- lists the same finding six times: the policies carry no TO clause, so they are TO public and
-- the advisor counts the overlap once per role that inherits it.
--
-- The fix is per-command rather than the single `<x>_all` the house rule prefers, because this
-- table has two different audiences: members READ their own group row, only admin WRITES. A
-- single FOR ALL policy would have to put the member's read clause in USING -- and DELETE is
-- checked against USING with no WITH CHECK to hold it back, so collapsing the two would let any
-- member of a group delete the group row. Three write policies keep the read clause out of the
-- delete path.
--
-- Semantics are otherwise unchanged: INSERT/UPDATE/DELETE stay admin-only, reads stay
-- own-group-or-admin. is_admin() returning NULL for a non-admin fails CLOSED inside a policy
-- (USING NULL => row not visible), which is the safe direction of that trap.
-- ════════════════════════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS client_groups_write ON public.client_groups;

DROP POLICY IF EXISTS client_groups_insert ON public.client_groups;
CREATE POLICY client_groups_insert ON public.client_groups FOR INSERT
  WITH CHECK ((select public.is_admin()));

DROP POLICY IF EXISTS client_groups_update ON public.client_groups;
CREATE POLICY client_groups_update ON public.client_groups FOR UPDATE
  USING ((select public.is_admin())) WITH CHECK ((select public.is_admin()));

DROP POLICY IF EXISTS client_groups_delete ON public.client_groups;
CREATE POLICY client_groups_delete ON public.client_groups FOR DELETE
  USING ((select public.is_admin()));

-- ── The grant the write policy was never reachable through ──────────────────────────────────
-- 20260812170000 granted `authenticated` SELECT only, while ClientDrawer.js's "Create group"
-- inserts into client_groups straight from an admin's browser session -- i.e. as `authenticated`,
-- not service_role. Whether that INSERT works today depends on whether Supabase's default
-- privileges had already granted it, which cannot be read from the migration history; this makes
-- it explicit either way. The grant is not the gate -- client_groups_insert still requires
-- is_admin(), so a non-admin session holding INSERT can write nothing.
GRANT INSERT, UPDATE, DELETE ON public.client_groups TO authenticated;

DO $$
BEGIN
  IF (SELECT count(*) FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'client_groups'
        AND permissive = 'PERMISSIVE' AND cmd IN ('ALL', 'SELECT')) <> 1 THEN
    RAISE EXCEPTION 'client_groups still has more than one permissive SELECT policy';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.client_groups', 'INSERT') THEN
    RAISE EXCEPTION 'authenticated cannot INSERT client_groups -- Create group would fail';
  END IF;
END $$;
