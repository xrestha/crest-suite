-- Per-account outlet allowlist: which sibling outlets an account may switch into.
--
-- WHY (S617). Until now switching was all-or-nothing and Owner-only: the Owner reaches every
-- outlet in the group, everyone else is pinned to their home outlet. The real case that breaks
-- is a manager who genuinely covers two branches -- today the only way to give them the second
-- one is to make them an Owner, which hands them every outlet in the group and, because the
-- Owner test is the ABSENCE of staff markers, means stripping their ims_role/pos_role/hr_role
-- and with it every rank check the product makes about them.
--
-- DELIBERATELY NOT a per-outlet role matrix. Rank stays a single global property of the person:
-- a manager at home is a manager at any outlet they are allowed into. Making ims_role/pos_role/
-- hr_role per-outlet would push a second rank rule into AuthContext, all three hasXAccess
-- helpers and is_client_owner() -- three places the S531 notes already warn must be kept in sync.
-- This table answers only "may they go there", never "what are they when they arrive".

CREATE TABLE IF NOT EXISTS public.profile_outlet_access (
  profile_id  uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  client_id   uuid NOT NULL REFERENCES public.clients(id)  ON DELETE CASCADE,
  granted_by  uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, client_id)
);

-- The PK indexes (profile_id, client_id), which serves every read this table has. The extra
-- index is for the FK on client_id: without it, deleting a client sequential-scans this table.
CREATE INDEX IF NOT EXISTS idx_profile_outlet_access_client ON public.profile_outlet_access(client_id);

ALTER TABLE public.profile_outlet_access ENABLE ROW LEVEL SECURITY;

-- Raw-SQL tables get NO role grants in this project -- a missing GRANT is a 401 that looks like
-- an RLS failure. See the standing note in .claude/rules/supabase-sql.md.
GRANT SELECT ON public.profile_outlet_access TO authenticated;
GRANT ALL    ON public.profile_outlet_access TO service_role;

-- RLS -----------------------------------------------------------------------------------------
-- SELECT: your own rows (the frontend needs its own allowlist to build the switcher), plus the
-- whole group's rows for an Owner, plus admin. Writes go exclusively through set_outlet_access()
-- below -- there is deliberately no INSERT/UPDATE/DELETE policy at all, so the RPC is the only
-- path and cannot be walked around with a direct PATCH the way the POS close guard was (S577).
DROP POLICY IF EXISTS profile_outlet_access_select ON public.profile_outlet_access;
CREATE POLICY profile_outlet_access_select ON public.profile_outlet_access
  FOR SELECT TO authenticated
  USING (
    profile_id = (select auth.uid())
    OR COALESCE(public.is_admin(), false)
    OR (
      COALESCE(public.is_client_owner(), false)
      AND public.my_group_id() IS NOT NULL
      AND client_id IN (SELECT id FROM public.clients WHERE group_id = public.my_group_id())
    )
  );

-- Who may go where ----------------------------------------------------------------------------
-- Extends 20260827120000's owner-only rule to "owner, admin, or explicitly allowlisted". The
-- group check below still applies to everyone, so an allowlist row for an outlet outside the
-- caller's group grants nothing -- two independent conditions, not one.
CREATE OR REPLACE FUNCTION public.set_active_outlet(p_client_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'public'
  AS $fn$
DECLARE
  v_home_group uuid;
  v_target_group uuid;
  v_allowed boolean;
BEGIN
  -- Resetting to your OWN outlet stays open to everyone, and must come BEFORE the checks below:
  -- assigning any staff marker demotes an account out of Owner, so an Owner who had switched and
  -- was then given a role would otherwise be stranded at a sibling outlet with no way back.
  IF p_client_id IS NULL THEN
    UPDATE profiles SET active_client_id = NULL WHERE id = (select auth.uid());
    RETURN;
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
$fn$;

-- The Group Console matrix --------------------------------------------------------------------
-- profiles_select RLS is self-or-admin only, so an Owner cannot read a sibling outlet's staff
-- rows at all -- the same reason get_client_profile_names() exists. This is that function's
-- group-wide sibling, and like it, it returns names and never emails.
DROP FUNCTION IF EXISTS public.get_group_outlet_access();
CREATE FUNCTION public.get_group_outlet_access()
  RETURNS TABLE (
    profile_id         uuid,
    full_name          text,
    home_client_id     uuid,
    home_client_name   text,
    pos_role           text,
    ims_role           text,
    hr_role            text,
    is_owner           boolean,
    allowed_client_ids uuid[]
  )
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path TO 'public'
  AS $fn$
DECLARE
  v_group uuid;
BEGIN
  IF NOT (COALESCE(public.is_admin(), false) OR COALESCE(public.is_client_owner(), false)) THEN
    RAISE EXCEPTION 'Not permitted.';
  END IF;

  v_group := public.my_group_id();
  IF v_group IS NULL THEN RETURN; END IF;   -- ungrouped: an empty matrix, not an error

  RETURN QUERY
  SELECT p.id,
         p.full_name,
         p.client_id,
         c.name,
         p.pos_role,
         p.ims_role,
         p.hr_role,
         (p.role = 'client'
            AND p.pos_role IS NULL AND p.ims_role IS NULL AND p.hr_role IS NULL
            AND COALESCE(p.hr_self_service, false) = false),
         COALESCE(ARRAY(SELECT a.client_id FROM profile_outlet_access a WHERE a.profile_id = p.id),
                  ARRAY[]::uuid[])
    FROM profiles p
    JOIN clients c ON c.id = p.client_id
   WHERE c.group_id = v_group
     AND p.role = 'client'
   ORDER BY c.name, p.full_name;
END;
$fn$;

-- Replaces one account's whole allowlist in a single transaction -- the same replace-wholesale
-- shape as save_pos_order_items, so a caller can never leave a half-applied set behind.
DROP FUNCTION IF EXISTS public.set_outlet_access(uuid, uuid[]);
CREATE FUNCTION public.set_outlet_access(p_profile_id uuid, p_client_ids uuid[]) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
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

  -- ...and so must every outlet being granted. Checked as a set: one stray id fails the whole
  -- call rather than being silently dropped, so the UI can never report a grant that did not
  -- happen.
  IF EXISTS (
    SELECT 1 FROM unnest(v_ids) AS want(id)
     WHERE want.id NOT IN (SELECT c2.id FROM clients c2 WHERE c2.group_id = v_group)
  ) THEN
    RAISE EXCEPTION 'Not permitted: one or more outlets are not in your group.';
  END IF;

  DELETE FROM profile_outlet_access WHERE profile_id = p_profile_id;

  INSERT INTO profile_outlet_access (profile_id, client_id, granted_by)
  SELECT p_profile_id, want.id, (select auth.uid()) FROM unnest(v_ids) AS want(id);

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

-- Grants ---------------------------------------------------------------------------------------
-- REVOKE FROM anon alone is a silent no-op while PUBLIC still holds the grant, and a fresh
-- function carries Postgres's default GRANT EXECUTE TO PUBLIC (S532 / postgres_public_grant trap).
REVOKE EXECUTE ON FUNCTION public.get_group_outlet_access()       FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.set_outlet_access(uuid, uuid[]) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_group_outlet_access()       TO authenticated, service_role;
GRANT  EXECUTE ON FUNCTION public.set_outlet_access(uuid, uuid[]) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

-- Verification ---------------------------------------------------------------------------------
--   SELECT has_function_privilege('anon','public.set_outlet_access(uuid,uuid[])','EXECUTE');      -- false
--   SELECT has_function_privilege('authenticated','public.get_group_outlet_access()','EXECUTE');  -- true
--   SELECT relrowsecurity FROM pg_class WHERE oid = 'public.profile_outlet_access'::regclass;     -- true
--   -- No write policy exists, so even an Owner's direct INSERT must fail with 42501:
--   INSERT INTO profile_outlet_access(profile_id, client_id) VALUES (auth.uid(), '<uuid>');
