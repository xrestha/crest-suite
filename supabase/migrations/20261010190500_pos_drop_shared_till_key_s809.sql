-- ════════════════════════════════════════════════════════════════════════════════════════════
-- S809 stage 3, slice 3h (second file): the restaurant-wide shared till key's four functions go.
--
--   POS_TODO A2 / S809.4 (1j). Before per-tablet keys (S754) every till of a client held one value,
--   client_secrets.pos_device_secret. S809 1j (20261009160000, owner decision Q7 a) switched it off at
--   every client; no tablet had signed in with it since its use stamp began (2026-09-14). Slice 3h
--   removed every caller: pos-staff-login's shared-key branch and its PGRST202 fallback, the PIN
--   screen's shared-key picker, Pos.js's shared-key notice and Till Devices' shared-key panel (status
--   and Switch off). What is left is dead code, two pieces of it callable: get_pos_staff is anon-
--   callable (PUBLIC holds EXECUTE) and still lists a POS-blocked login (S809 3i's note), and
--   retire_pos_legacy_device_key / pos_legacy_device_key_status are authenticated-callable. Dropped, in
--   the order auth-and-pins.md gives:
--     get_pos_staff(uuid, uuid)                   2a028deda2633faa541580bf14ad819b
--     verify_pos_legacy_device(uuid, text)        0d740ac5914ad4f7d6cf6a29468ec70e
--     retire_pos_legacy_device_key(uuid)          03bffc7f69bf49312fc954a1cebb8a29
--     pos_legacy_device_key_status(uuid)          a010ad6ebb5f718d187e0de7776dc64d
--   (md5(prosrc) of the live bodies, read 2026-10-10.) Nothing else in the database names them (no
--   function body, no view; pg_depend has no row), and no Edge Function calls them: admin-user-ops
--   names retire_pos_legacy_device_key only in a comment (its revokeClientTablets writes the same
--   client_secrets columns itself, with the service role) and hr-selfservice-login names get_pos_staff
--   only in a history comment.
--
--   Kept: client_secrets.pos_device_secret, pos_legacy_key_retired_at and pos_legacy_key_last_used_at.
--   Nothing reads them any more, but admin-user-ops' revokeClientTablets still writes the first two,
--   and a column drop is its own decision.
--
-- APPLY ONLY AFTER, in this order: 20261010180000, the pos-staff-login deploy (the deployed function
-- before it calls verify_pos_legacy_device for a request with no device_id), the admin-user-ops
-- deploy, and the app release, plus a day: a crest-v427 Till Devices page still open on a laptop reads
-- pos_legacy_device_key_status beside the tablet list in one Promise.all, so after this file its whole
-- tablet list reads "Couldn't load the tablet list" until that page is reloaded; a crest-v427 tablet
-- still holding only the shared key calls get_pos_staff and reads "Couldn't reach the server" instead
-- of "No staff accounts found" (it could sign nobody in either way).
--
-- Section 0 refuses to run while any client's shared key is still on, or while anything in the
-- database still calls one of the four. Section 2 proves they are gone.
-- ════════════════════════════════════════════════════════════════════════════════════════════


-- ── 0. Pre-flight ──────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_names text;
BEGIN
  IF EXISTS (SELECT 1 FROM public.client_secrets WHERE pos_legacy_key_retired_at IS NULL) THEN
    RAISE EXCEPTION 'S809 3h: a client''s shared till key is still switched on; switch it off before dropping its functions';
  END IF;
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_names
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname NOT IN ('get_pos_staff', 'verify_pos_legacy_device', 'retire_pos_legacy_device_key', 'pos_legacy_device_key_status')
     AND (p.prosrc ~ 'get_pos_staff\s*\(' OR p.prosrc LIKE '%verify_pos_legacy_device%'
          OR p.prosrc LIKE '%retire_pos_legacy_device_key%' OR p.prosrc LIKE '%pos_legacy_device_key_status%');
  IF v_names IS NOT NULL THEN
    RAISE EXCEPTION 'S809 3h: % still call(s) a shared-key function', v_names;
  END IF;
END;
$$;


-- ── 1. Drop ────────────────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.get_pos_staff(uuid, uuid);
DROP FUNCTION IF EXISTS public.verify_pos_legacy_device(uuid, text);
DROP FUNCTION IF EXISTS public.retire_pos_legacy_device_key(uuid);
DROP FUNCTION IF EXISTS public.pos_legacy_device_key_status(uuid);


-- ── 2. Prove it: no overload of any of the four survives, and the per-tablet functions stand ─────
DO $$
DECLARE
  v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace
     AND proname IN ('get_pos_staff', 'verify_pos_legacy_device', 'retire_pos_legacy_device_key', 'pos_legacy_device_key_status');
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'S809 3h: % shared-key function(s) survived the drop', v_n;
  END IF;
  IF to_regprocedure('public.get_pos_device_staff(uuid,uuid,text)') IS NULL
     OR to_regprocedure('public.verify_pos_device(uuid,uuid,text)') IS NULL
     OR to_regprocedure('public.pos_record_device_session(uuid,uuid,uuid)') IS NULL
     OR to_regprocedure('public.get_pos_staff_list(uuid)') IS NULL THEN
    RAISE EXCEPTION 'S809 3h: a per-tablet till function is missing (is 20261010180000 applied?)';
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';

-- Read back after applying:
--   SELECT proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace
--      AND proname IN ('get_pos_staff', 'verify_pos_legacy_device', 'retire_pos_legacy_device_key', 'pos_legacy_device_key_status');
--     expect no rows.
