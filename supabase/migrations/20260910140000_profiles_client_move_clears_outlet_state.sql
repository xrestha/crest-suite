-- A login moved to another client must not keep its old outlet selection (S736).
--
-- profiles.active_client_id is privilege-bearing: my_client_id() is coalesce(active_client_id,
-- client_id), so it decides which tenant EVERY row-level policy resolves to, and AuthContext
-- resolves it the same way before client_id. It is cleared in exactly three places today --
-- set_active_outlet() itself, clear_stale_active_outlet() when a clients.group_id changes, and
-- set_outlet_access() when reach is revoked. Nothing clears it when profiles.client_id itself
-- changes, which is what Admin -> Clients -> "Create User" does when the email already has a login
-- ("Move it to this client?"). A grouped Owner who had switched to a sibling outlet and was then
-- moved to an unrelated client kept reading and writing that sibling outlet under the new client's
-- login: RLS and the app agreed with each other, and both were pointed at the wrong tenant.
--
-- The browser write now nulls the column in the same upsert; this trigger is the layer that does
-- not depend on every future caller remembering to. It also drops the login's profile_outlet_access
-- rows: reach was granted relative to the old home outlet, and an allowlist that outlives the move
-- would re-open those outlets the moment the new home happens to share their group. Re-granting is
-- one call to set_outlet_access().
--
-- BEFORE UPDATE OF client_id, so it fires only on an actual move and never on the per-page-load
-- last_seen_at write. SECURITY INVOKER (no clause) like guard_profiles_privileged_columns: the
-- writer here is the admin session or the service role, both of which already pass RLS on the
-- table this touches.

CREATE OR REPLACE FUNCTION public.profiles_client_move_clears_outlet_state()
RETURNS trigger
LANGUAGE plpgsql
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

DROP TRIGGER IF EXISTS profiles_client_move_clears_outlet_state ON public.profiles;
CREATE TRIGGER profiles_client_move_clears_outlet_state
  BEFORE UPDATE OF client_id ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.profiles_client_move_clears_outlet_state();

-- ── Verification (run separately) ─────────────────────────────────────────────────────────────
--   SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid = 'public.profiles'::regclass
--    AND tgname = 'profiles_client_move_clears_outlet_state';
--   -- expect one row, tgenabled = 'O'
--
-- And, as admin, against a throwaway login that has active_client_id set:
--   UPDATE profiles SET client_id = '<other client uuid>' WHERE id = '<login uuid>'
--     RETURNING client_id, active_client_id;
--   -- expect active_client_id NULL
