-- ════════════════════════════════════════════════════════════════════════════════════════════
-- ⚠️  RUN THIS ONLY AFTER THE NEW FRONTEND BUNDLE IS DEPLOYED AND VERIFIED.  ⚠️
--
-- This is the destructive half of the 2026-08-10 security pass, deliberately separated from
-- 20260810140000_client_secrets_table.sql (which was purely additive and safe to run at any
-- time). Everything here removes something a PREVIOUS frontend bundle still depends on:
--
--   get_pos_staff loses pos_email    -> old PosLogin.jsx passes it to signInWithPassword; without
--                                       it, every POS PIN login fails
--   clients.pos_device_secret        -> old Pos.js activate() selects this column directly
--   settings.pos_webhook_secret      -> old ClientDrawer.js reads and writes this column
--
-- Run it too early and POS PIN login breaks on a live restaurant floor until the new bundle
-- lands. Run it after, and there is no window at all: the new bundle reads none of the three.
--
-- Confirm before running:
--   1. `npm run build` output is deployed and serving (check the app loads and a POS device can
--      still reach the PIN pad).
--   2. A POS staff member has successfully signed in on the NEW bundle at least once -- that
--      proves pos-staff-login + client_secrets are working end to end, which is the whole
--      precondition for pos_email being safe to remove.
--
-- HIGH severity, and this is the fix's real payload. pos_email is not an identifier -- it IS half
-- of a working credential, because PosLogin.jsx passed it straight into
-- supabase.auth.signInWithPassword({ email: pos_email, password: pin }), making the PIN the full
-- Supabase Auth password. The lockout added for exactly that reason
-- (20260707240000_pos_pin_lockout.sql, whose own header calls itself "the standard mitigation for
-- low-entropy credentials") lived entirely in the frontend: check_pos_pin_lock before the call,
-- record_pos_pin_attempt after. Neither is on the auth path. Skip both, loop signInWithPassword,
-- and a 4-digit PIN falls in at most 10,000 tries with nothing ever locking. The sign-in now
-- happens server-side in the pos-staff-login Edge Function, which enforces the lockout on the
-- same request, so pos_email has no remaining reason to leave the server -- mirroring S464's
-- get_hr_self_service_staff fix exactly.
--
-- The device secret (20260713010859) narrowed WHO could obtain pos_email but did not fix it:
-- clients_select allowed `id = my_client_id()` with no staff restriction, so any staff account
-- could read pos_device_secret off the clients row and call get_pos_staff with it. That column
-- goes here too, now that 20260810140000 has moved the live copy into client_secrets.
-- ════════════════════════════════════════════════════════════════════════════════════════════

-- ── 1. get_pos_staff: drop pos_email, verify against client_secrets ──────────────────────────
-- DROP + CREATE rather than CREATE OR REPLACE: this changes the RETURNS TABLE column list, which
-- CREATE OR REPLACE cannot do (Postgres 42P13, "cannot change return type of existing function").
-- IF EXISTS keeps the migration safe to re-paste after a partially failed run.
DROP FUNCTION IF EXISTS public.get_pos_staff(uuid, uuid);

CREATE FUNCTION public.get_pos_staff(p_client_id uuid, p_device_secret uuid)
    RETURNS TABLE(id uuid, full_name text, pos_role text, pos_job_title text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT p.id, p.full_name, p.pos_role, p.pos_job_title
  FROM profiles p
  WHERE p.client_id = p_client_id
    AND p.pos_role IS NOT NULL
    AND p.pos_email IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM client_secrets cs
      WHERE cs.client_id = p_client_id AND cs.pos_device_secret = p_device_secret
    )
  ORDER BY p.full_name;
$$;

-- Still anon-callable by design -- this is the pre-login "who are you" picker on a public page, so
-- there is no session to check. It now returns the same low-sensitivity shape already accepted for
-- get_hr_self_service_staff and get_guest_menu: enough to draw a tile, nothing that logs anyone in.
-- pos_job_title is listed because the picker already rendered it (PosLogin.jsx:206) and it came
-- along inside the row before; it is not new exposure.
GRANT EXECUTE ON FUNCTION public.get_pos_staff(uuid, uuid) TO anon, authenticated;

-- ── 2. Retire the old secret columns ─────────────────────────────────────────────────────────
-- Both values were copied into client_secrets by 20260810140000. Re-check that before dropping,
-- since a DROP COLUMN is the one step here with no undo:
--   SELECT count(*) FROM clients c JOIN client_secrets cs ON cs.client_id = c.id
--   WHERE cs.pos_device_secret IS DISTINCT FROM c.pos_device_secret;   -- must be 0
ALTER TABLE public.clients  DROP COLUMN IF EXISTS pos_device_secret;
ALTER TABLE public.settings DROP COLUMN IF EXISTS pos_webhook_secret;

NOTIFY pgrst, 'reload schema';

-- ── Verification ─────────────────────────────────────────────────────────────────────────────
--   SELECT * FROM get_pos_staff('<client id>', '<device secret from client_secrets>');
--   -- expect columns: id, full_name, pos_role, pos_job_title   (NO pos_email)
--
-- On a real POS device, against the new bundle:
--   - the staff picker still lists everyone
--   - a correct PIN signs in
--   - five wrong PINs produce "Try again in 15 minutes", and a sixth POST straight at
--     /functions/v1/pos-staff-login keeps returning 423 instead of attempting the sign-in
--     (that last one is the actual point of the whole change -- the lockout is no longer
--     something the client can skip by not calling it)
