-- ════════════════════════════════════════════════════════════════════════════════════════════
-- S829, POS stage 5, slice 5e (part 2 of 2): the shared tablet key's last three columns go.
--
-- The client's shared POS key from before S754 was switched off at every client in S809 1j
-- (20261009160000), its app code and pos-staff-login branch went in 3h, and its four functions were
-- dropped by 20261010190500. Three client_secrets columns stayed, read by nothing:
--   pos_device_secret            (NOT NULL, default gen_random_uuid())
--   pos_legacy_key_retired_at    (default now(), so a new row was born switched off)
--   pos_legacy_key_last_used_at  (written only by the dropped verify_pos_legacy_device)
-- Checked 2026-10-13: no function body, view or policy reads them, the app and the export do not,
-- and no audit row holds pos_device_secret. The one writer was admin-user-ops' revokeClientTablets
-- (Archive, Clear Client Data, Delete Client, the trial purge), which rotated and stamped the key.
--
-- Deploy order: AFTER admin-user-ops is deployed without that write (S829). Applied before it, every
-- Archive / Clear / Delete would fail at "Failed to switch off this client's shared POS key".
--
-- Not changed: log_audit() still strips a 'pos_device_secret' key from clients snapshots. The column
-- left clients in S531, so the strip is dead and harmless; that function is not rebuilt for it.
-- The tablets' own key (pos_devices, a hash per tablet) and the localStorage entry that happens to be
-- named pos_device_secret are a different thing and are untouched.
--
-- To undo: ALTER TABLE public.client_secrets ADD COLUMN pos_device_secret uuid NOT NULL DEFAULT
-- gen_random_uuid(), ADD COLUMN pos_legacy_key_retired_at timestamptz DEFAULT now(), ADD COLUMN
-- pos_legacy_key_last_used_at timestamptz. The values are not recoverable, and nothing needs them.
-- ════════════════════════════════════════════════════════════════════════════════════════════


-- ── 0. Pre-flight: nothing in the database reads the columns ─────────────────────────────────
DO $$
DECLARE
  v_found text;
BEGIN
  -- Function bodies. log_audit's jsonb key strip and the pos_device_secret_hash() function name are
  -- not the column; anything else is.
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO v_found
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND (p.prosrc ~ 'pos_legacy_key'
          OR (regexp_replace(p.prosrc, 'pos_device_secret_hash', '', 'g') ~ 'pos_device_secret' AND p.proname <> 'log_audit'));
  IF v_found IS NOT NULL THEN
    RAISE EXCEPTION 'S829 5e pre-flight: these functions still name a shared-key column: %', v_found;
  END IF;

  SELECT string_agg(viewname, ', ') INTO v_found FROM pg_views
   WHERE schemaname = 'public' AND (definition ~ 'pos_legacy_key' OR definition ~ 'pos_device_secret');
  IF v_found IS NOT NULL THEN
    RAISE EXCEPTION 'S829 5e pre-flight: these views name a shared-key column: %', v_found;
  END IF;

  SELECT string_agg(tablename || '.' || policyname, ', ') INTO v_found FROM pg_policies
   WHERE schemaname = 'public'
     AND (COALESCE(qual, '') || COALESCE(with_check, '')) ~ '(pos_legacy_key|pos_device_secret)';
  IF v_found IS NOT NULL THEN
    RAISE EXCEPTION 'S829 5e pre-flight: these policies name a shared-key column: %', v_found;
  END IF;
END;
$$;


-- ── 1. Drop them ──────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.client_secrets
  DROP COLUMN IF EXISTS pos_device_secret,
  DROP COLUMN IF EXISTS pos_legacy_key_retired_at,
  DROP COLUMN IF EXISTS pos_legacy_key_last_used_at;

NOTIFY pgrst, 'reload schema';


-- ── 2. What is left (the last statement, so `db query` prints it) ─────────────────────────────
SELECT string_agg(column_name, ', ' ORDER BY ordinal_position) AS client_secrets_columns
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'client_secrets';
-- expect: client_id, pos_webhook_secret, updated_at, ims_device_secret, ims_enrol_token,
--         ims_enrol_token_expires_at
