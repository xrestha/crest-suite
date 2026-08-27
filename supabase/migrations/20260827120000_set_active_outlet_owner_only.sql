-- set_active_outlet(): enforce Owner-only switching in the FUNCTION, not just in React.
--
-- WHY (S617). The multi-outlet design has always been "only an Owner switches outlets" —
-- AuthContext.js says so in a comment that names the exact attack:
--
--     "A POS till, an IMS storekeeper or an HR clerk belongs to one physical outlet; handing
--      them a switcher would let a waiter re-point their whole session at a sibling branch."
--
-- But that restriction was `canSwitchOutlet = isOwner && outlets.length > 1` and nothing else.
-- The RPC itself validated only that the target outlet shares the caller's home group, so any
-- account in a grouped client could call it directly and re-point active_client_id — and
-- my_client_id() is `coalesce(active_client_id, client_id)`, so that one write re-scopes ~120
-- RLS policies and every scoped query in the app to the sibling outlet, at whatever rank the
-- caller already holds.
--
-- This is S531 invariant #3 in a third guise, after the POS PIN lockout (S531) and the POS close
-- guard (S577): a check the client can simply decline to make is not a check. The RESTRICTIVE
-- staff-isolation families still fence each ACCOUNT TYPE out of the tables it never had, so this
-- is not a cross-tenant leak — but an IMS storekeeper reading a sibling branch's stock,
-- purchases and vendor pricing is precisely what the design intended to prevent.
--
-- Body-only change: same signature, same RETURNS void, so plain CREATE OR REPLACE is correct and
-- the existing REVOKE-from-PUBLIC / GRANT-to-authenticated ACL from 20260812170000 survives
-- untouched (a DROP would discard it — S532's grant trap).

CREATE OR REPLACE FUNCTION public.set_active_outlet(p_client_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'public'
  AS $$
DECLARE
  v_home_group uuid;
  v_target_group uuid;
BEGIN
  -- Resetting to your OWN outlet stays open to everyone, deliberately, and this branch must come
  -- BEFORE the owner check. Assigning any staff marker to a profile demotes it out of Owner (the
  -- Owner test is the absence of markers), so an Owner who had switched outlets and was then
  -- given, say, an ims_role would otherwise be stranded pointing at a sibling outlet with no way
  -- to clear it. Clearing a privilege is never the dangerous direction.
  IF p_client_id IS NULL THEN
    UPDATE profiles SET active_client_id = NULL WHERE id = (select auth.uid());
    RETURN;
  END IF;

  -- COALESCE on both: is_admin() and is_client_owner() each read a profiles row and return NULL
  -- when the caller has none, NOT false. `IF NOT NULL THEN` never fires, so the unwrapped form
  -- falls OPEN for exactly the accounts that could not be identified. Same trap as
  -- apply_pos_item_comps' original client check (S579).
  IF NOT (COALESCE(public.is_admin(), false) OR COALESCE(public.is_client_owner(), false)) THEN
    RAISE EXCEPTION 'Not permitted: only an owner can switch outlets.';
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

-- ── Verification ─────────────────────────────────────────────────────────────────────────────
-- Run these after applying. Check 1 proves the ACL survived the replace (a DROP would have eaten
-- it); check 2 proves the new guard is actually in the deployed body, not just in this file.
--
--   SELECT has_function_privilege('authenticated','public.set_active_outlet(uuid)','EXECUTE');  -- true
--   SELECT has_function_privilege('anon','public.set_active_outlet(uuid)','EXECUTE');           -- false
--   SELECT pg_get_functiondef('public.set_active_outlet(uuid)'::regprocedure) LIKE '%is_client_owner%';  -- true
--
-- The definitive test is not the UI — the UI never offered the switcher to staff in the first
-- place. Sign in as a POS or IMS staff account on a GROUPED client and POST the RPC directly with
-- that session's own token:
--
--   fetch('<url>/rest/v1/rpc/set_active_outlet', { method:'POST',
--     headers:{ apikey:<anon>, Authorization:'Bearer '+<staff access_token>,
--               'Content-Type':'application/json' },
--     body: JSON.stringify({ p_client_id: '<sibling outlet uuid>' }) })
--
-- Expect 4xx with "only an owner can switch outlets". Include the control that must still pass:
-- the same call as the Owner returns 204, and `{"p_client_id": null}` succeeds for BOTH.
