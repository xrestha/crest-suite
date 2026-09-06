-- ═════════════════════════════════════════════════
-- Admin-editable platform support contact (S683).
--
-- Crest's own support line — the number on the crash page, the login footer, the offline banners
-- and Help → Support — was a hardcoded constant in src/shared/supportContact.js, and it shipped as
-- an unfilled [[NEEDS VALUE]] marker for three days because the only way to set it was a commit.
-- This makes it data the admin edits in Settings → Support, on the one row that already has the
-- right shape:
--
--   • settings WHERE client_id IS NULL is the PLATFORM row (App Branding, Plan Prices live there).
--   • settings_select already lets EVERY reader — including anon on /login — SELECT that row, and
--     settings_update lets only is_admin() UPDATE it. No policy changes here, and that is the
--     point: a support number is public by design (it is printed on the login page), and the
--     write side is already the operator's alone.
--
-- The column is jsonb rather than six columns because it belongs to ONE row and the per-client
-- rows must not grow six nullable platform fields they will never carry. Shape and defaults are
-- owned by DEFAULT_SUPPORT_CONTACT in supportContact.js; the frontend fails soft to its constants
-- if this column is absent, so applying this migration late costs nothing but the edit screen.
-- ═════════════════════════════════════════════════

BEGIN;

ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS support_contact jsonb;

COMMENT ON COLUMN public.settings.support_contact IS
  'Platform support contact (S683). Meaningful ONLY on the client_id IS NULL row. Shape: '
  '{mobile, landline, whatsapp, viber, email, website, anydesk, hours, emergency_enabled, emergency_channel}. '
  'Edited in Settings → Support; read by resolveSupportContact() in src/shared/supportContact.js.';

-- The read path this feature depends on: the platform row must stay readable by anon, because
-- the login footer renders it before anyone has signed in. Assert rather than assume — a future
-- RLS tightening that drops the `client_id IS NULL` arm would silently blank six surfaces.
DO $$
DECLARE
  q text;
BEGIN
  SELECT pg_get_expr(polqual, polrelid) INTO q
    FROM pg_policy
   WHERE polrelid = 'public.settings'::regclass AND polname = 'settings_select';
  IF q IS NULL OR q NOT ILIKE '%client_id IS NULL%' THEN
    RAISE EXCEPTION 'settings_select no longer lets the platform row (client_id IS NULL) through — the support contact would vanish from /login and the crash page';
  END IF;
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';
