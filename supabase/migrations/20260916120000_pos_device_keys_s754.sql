-- S754 — a key per POS tablet, replacing the one shared device secret per client.
--
-- Owner decision (Aashish, 2026-09-14): every till gets its own key, a manager can see which
-- tablets are set up and revoke one, and the restaurant-wide shared secret is retired.
--
-- WHY. `client_secrets.pos_device_secret` is ONE value per client, copied into the localStorage of
-- every tablet ever activated. So a single lost, sold or stolen tablet held a credential that could
-- only be withdrawn by rotating it for the whole floor, nothing recorded which tablets held it, and
-- nobody could see when one was last used. `pos_devices` is one row per tablet, holding only a hash.
--
-- Sections:
--   (1) pos_devices: the table, locked to every client role — reached only through the functions below
--   (2) helpers: the secret hash, the caller test, the key test, the hand-written audit row
--   (3) register_pos_device / list_pos_devices / revoke_pos_device: Owner, admin or POS manager
--   (4) get_pos_device_staff: the PIN picker for a per-device key (anon, like get_pos_staff)
--   (5) verify_pos_device / verify_pos_legacy_device: the device gate inside pos-staff-login
--   (6) the shared key's retirement: status, an explicit switch-off that ROTATES it, and
--       get_pos_device_secret refusing to hand it out afterwards
--
-- DEPLOY ORDER: after 20260916110000_pos_rank_guards_s754.sql (it CREATE OR REPLACEs
-- get_pos_device_secret, which (6) redefines — applied the other way round, the retirement check
-- would be silently overwritten), then pos-staff-login, then the frontend.
--
-- ── Decisions ──────────────────────────────────────────────────────────────────────────────────
-- * THE SECRET IS HASHED WITH PLAIN SHA-256, NOT THE PIN PEPPER. A pepper (HMAC under
--   app_secrets.pin_pepper) exists for 4–6 digit PINs, whose whole keyspace can be hashed in a
--   second by anyone who reads the table. A device secret is two v4 UUIDs of CSPRNG output (244
--   bits, the app_secrets pattern), so its hash cannot be inverted or guessed — a pepper would add
--   nothing but a dependency. sha256() is core Postgres (11+) in pg_catalog, so it resolves under
--   `SET search_path TO 'public'`; pgcrypto's digest() lives in `extensions` and would not
--   (20260812110000 lines 51-56). The raw secret is returned ONCE by register_pos_device and exists
--   nowhere on the server after that call.
-- * NO CLIENT GRANTS ON THE TABLE, AND THEREFORE NO RLS POLICIES OR STAFF FENCES. Postgres has no
--   column-level RLS, so any SELECT policy an Owner could use would also show secret_hash. Every
--   read and write goes through SECURITY DEFINER functions that carry their own caller check. With
--   no permissive policy and no grant there is nothing for the restrictive no_*_staff families to
--   narrow — client_secrets (20260810140000) made the same call for the same reason. RLS is still
--   enabled so a grant added by mistake later opens nothing on its own.
-- * NOT AUDITED BY log_audit(). It snapshots whole rows, which would put secret_hash into
--   audit_logs. The three write functions insert their own audit row, with the hash removed, using
--   the trigger's own INSERT/UPDATE vocabulary so the Audit Log page renders it without a new label.
-- * THE SHARED KEY IS RETIRED EXPLICITLY, NOT AUTOMATICALLY WHEN THE FIRST TABLET REGISTERS. An
--   outlet with three tills that re-activates one of them would otherwise lose the other two in the
--   middle of service. Instead pos-staff-login stamps pos_legacy_key_last_used_at on every legacy
--   sign-in, POS Setup shows that stamp, and a manager switches the shared key off once the tablets
--   are moved over. Switching it off ROTATES client_secrets.pos_device_secret to a value no tablet
--   holds, so every path that still compares against it (get_pos_staff, a stale pos-staff-login)
--   stops matching at once, without get_pos_staff having to be redefined here.
-- * NOT EXPORTED, NOT RESTORED. A backup is a file on someone's disk; a device credential must not
--   be restorable into a working state, and a restored client re-activates its tablets in one tap
--   each. pos_devices is not in CLIENT_SCOPED_TABLES, so exportClientData never reads it, and it is
--   not in RESTORE_ORDER. Danger Zone: client_id is ON DELETE CASCADE, so Delete Client removes the
--   rows with no FK violation (client_secrets' precedent); created_by/revoked_by are ON DELETE SET
--   NULL, so deleting the client's auth users first cannot be refused by this table.

-- ── (1) pos_devices ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pos_devices (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id    uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  -- Lowercase hex SHA-256 of the raw secret. UNIQUE so two rows can never share a key.
  secret_hash  text NOT NULL UNIQUE CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
  created_by   uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- Stamped by pos-staff-login each time this tablet presents its key at the device gate.
  last_used_at timestamptz,
  revoked_at   timestamptz,
  revoked_by   uuid REFERENCES public.profiles(id) ON DELETE SET NULL
);

-- list_pos_devices and the active-device cap both filter by client.
CREATE INDEX IF NOT EXISTS pos_devices_client_id_idx ON public.pos_devices (client_id);

ALTER TABLE public.pos_devices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pos_devices FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pos_devices TO service_role;

-- The shared key's retirement state, beside the key itself.
ALTER TABLE public.client_secrets ADD COLUMN IF NOT EXISTS pos_legacy_key_retired_at   timestamptz;
ALTER TABLE public.client_secrets ADD COLUMN IF NOT EXISTS pos_legacy_key_last_used_at timestamptz;

-- ── (2) helpers ─────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.pos_device_secret_hash(p_secret text)
RETURNS text
LANGUAGE sql STABLE STRICT
SET search_path TO 'public'
AS $$
  SELECT encode(sha256(convert_to(p_secret, 'UTF8')), 'hex')
$$;
REVOKE ALL ON FUNCTION public.pos_device_secret_hash(text) FROM PUBLIC;

-- Admin, or the Owner / a POS manager of THIS client (outlet-aware, as get_pos_device_secret is),
-- whose login has not been blocked by a Final Settlement. The same people who could activate a
-- tablet before. Every operand is COALESCE'd: pos_role is NULL for every non-POS account and
-- is_admin() is NULL for a caller with no profile, and in an `IF NOT` either one falls OPEN (S630).
CREATE OR REPLACE FUNCTION public.pos_device_caller_may_manage(p_client_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE(public.is_admin(), false)
      OR COALESCE((
           SELECT COALESCE(p.active_client_id, p.client_id) = p_client_id
              AND p.settlement_blocked_by IS NULL
              AND (COALESCE(public.is_client_owner(), false) OR COALESCE(p.pos_role = 'manager', false))
             FROM profiles p
            WHERE p.id = (select auth.uid())), false)
$$;
REVOKE ALL ON FUNCTION public.pos_device_caller_may_manage(uuid) FROM PUBLIC;

-- Is this a live key for this client? One definition, read by the picker and by the login gate.
CREATE OR REPLACE FUNCTION public.pos_device_key_valid(p_client_id uuid, p_device_id uuid, p_secret text)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path TO 'public'
AS $$
  SELECT COALESCE(
    p_client_id IS NOT NULL AND p_device_id IS NOT NULL AND p_secret IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM pos_devices d
       WHERE d.id = p_device_id
         AND d.client_id = p_client_id
         AND d.revoked_at IS NULL
         AND d.secret_hash = public.pos_device_secret_hash(p_secret)
    ), false)
$$;
REVOKE ALL ON FUNCTION public.pos_device_key_valid(uuid, uuid, text) FROM PUBLIC;

-- The audit row log_audit() would have written, minus the hash.
CREATE OR REPLACE FUNCTION public.pos_devices_audit(p_action text, p_old public.pos_devices, p_new public.pos_devices)
RETURNS void
LANGUAGE sql VOLATILE
SET search_path TO 'public'
AS $$
  INSERT INTO audit_logs (client_id, client_name, user_id, user_name, table_name, action, record_id, old_data, new_data)
  SELECT c.id, c.name, (select auth.uid()),
         (SELECT pr.full_name FROM profiles pr WHERE pr.id = (select auth.uid())),
         'pos_devices', p_action, COALESCE(p_new.id, p_old.id),
         CASE WHEN p_old.id IS NULL THEN NULL ELSE to_jsonb(p_old) - 'secret_hash' END,
         CASE WHEN p_new.id IS NULL THEN NULL ELSE to_jsonb(p_new) - 'secret_hash' END
    FROM clients c
   WHERE c.id = COALESCE(p_new.client_id, p_old.client_id)
$$;
REVOKE ALL ON FUNCTION public.pos_devices_audit(text, public.pos_devices, public.pos_devices) FROM PUBLIC;

-- ── (3) register / list / revoke ────────────────────────────────────────────────────────────────
--
-- p_client_id rather than my_client_id(): admin activates a tablet while "viewing as" a client,
-- which is a frontend selection, not active_client_id. The caller test ties every other caller to
-- their own (selected) outlet.
CREATE OR REPLACE FUNCTION public.register_pos_device(p_client_id uuid, p_name text)
RETURNS TABLE(device_id uuid, device_secret text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_name   text := btrim(COALESCE(p_name, ''));
  v_secret text;
  v_row    pos_devices;
BEGIN
  IF p_client_id IS NULL OR NOT public.pos_device_caller_may_manage(p_client_id) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  IF char_length(v_name) NOT BETWEEN 1 AND 60 THEN
    RAISE EXCEPTION 'pos_device_name_invalid' USING ERRCODE = '22023',
      HINT = 'Give the tablet a name of 1 to 60 characters, e.g. "Front counter".';
  END IF;
  -- A ceiling no real floor reaches; it bounds what a compromised manager session can mint.
  IF (SELECT count(*) FROM pos_devices WHERE client_id = p_client_id AND revoked_at IS NULL) >= 100 THEN
    RAISE EXCEPTION 'pos_device_limit' USING ERRCODE = '54000',
      HINT = 'This restaurant already has 100 active tablets. Revoke one that is no longer used.';
  END IF;

  -- 244 bits of CSPRNG output (gen_random_uuid is pg_strong_random on PG 13+), the app_secrets pattern.
  v_secret := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');

  INSERT INTO pos_devices (client_id, name, secret_hash, created_by)
  VALUES (p_client_id, v_name, public.pos_device_secret_hash(v_secret), (select auth.uid()))
  RETURNING * INTO v_row;

  PERFORM public.pos_devices_audit('INSERT', NULL::pos_devices, v_row);

  RETURN QUERY SELECT v_row.id, v_secret;
END;
$$;
REVOKE ALL ON FUNCTION public.register_pos_device(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.register_pos_device(uuid, text) TO authenticated, service_role;

-- Metadata only. secret_hash is not a column of the result, so no caller of any rank ever sees it.
CREATE OR REPLACE FUNCTION public.list_pos_devices(p_client_id uuid)
RETURNS TABLE(id uuid, name text, created_at timestamptz, created_by_name text,
              last_used_at timestamptz, revoked_at timestamptz, revoked_by_name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF p_client_id IS NULL OR NOT public.pos_device_caller_may_manage(p_client_id) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  -- Cast every column to the declared type: RETURN QUERY compares type OIDs exactly (S737).
  RETURN QUERY
    SELECT d.id::uuid, d.name::text, d.created_at::timestamptz, cb.full_name::text,
           d.last_used_at::timestamptz, d.revoked_at::timestamptz, rb.full_name::text
      FROM pos_devices d
      LEFT JOIN profiles cb ON cb.id = d.created_by
      LEFT JOIN profiles rb ON rb.id = d.revoked_by
     WHERE d.client_id = p_client_id
     ORDER BY (d.revoked_at IS NOT NULL), d.created_at DESC, d.id;
END;
$$;
REVOKE ALL ON FUNCTION public.list_pos_devices(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_pos_devices(uuid) TO authenticated, service_role;

-- Idempotent: revoking an already-revoked tablet changes nothing and is not an error, so a
-- double-tap or a retry after a lost response cannot fail. A revoked key cannot be un-revoked —
-- the tablet is activated again, which issues a new key.
CREATE OR REPLACE FUNCTION public.revoke_pos_device(p_device_id uuid)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_old pos_devices;
  v_new pos_devices;
BEGIN
  SELECT * INTO v_old FROM pos_devices WHERE id = p_device_id FOR UPDATE;
  -- Absent and not-yours read the same, so the refusal is not an oracle for another client's ids.
  IF NOT FOUND OR NOT public.pos_device_caller_may_manage(v_old.client_id) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  IF v_old.revoked_at IS NOT NULL THEN
    RETURN;
  END IF;

  UPDATE pos_devices
     SET revoked_at = now(), revoked_by = (select auth.uid())
   WHERE id = p_device_id
  RETURNING * INTO v_new;

  PERFORM public.pos_devices_audit('UPDATE', v_old, v_new);
END;
$$;
REVOKE ALL ON FUNCTION public.revoke_pos_device(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.revoke_pos_device(uuid) TO authenticated, service_role;

-- ── (4) The PIN picker for a per-device key ─────────────────────────────────────────────────────
--
-- Same row filter as get_pos_staff (20260916110000 section 7), gated on the device key instead of
-- the shared secret. A dead key RAISES rather than returning an empty set, so the tablet can say
-- "activate this till again" instead of "no staff accounts found", which sends a manager to the
-- wrong page. A separate name rather than a third get_pos_staff argument: an appended parameter
-- forks the function (supabase-sql.md), and the legacy two-argument form must keep serving tablets
-- activated before this migration until the shared key is retired.
CREATE OR REPLACE FUNCTION public.get_pos_device_staff(p_client_id uuid, p_device_id uuid, p_device_secret text)
RETURNS TABLE(id uuid, full_name text, pos_role text, pos_job_title text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT public.pos_device_key_valid(p_client_id, p_device_id, p_device_secret) THEN
    RAISE EXCEPTION 'pos_device_not_active' USING ERRCODE = '28000',
      HINT = 'This till needs to be activated again by a manager.';
  END IF;

  RETURN QUERY
    SELECT p.id::uuid, p.full_name::text, p.pos_role::text, p.pos_job_title::text
      FROM profiles p
     WHERE p.client_id = p_client_id
       AND p.pos_role IS NOT NULL
       AND p.pos_email IS NOT NULL
       AND p.settlement_blocked_by IS NULL
     ORDER BY p.full_name;
END;
$$;
-- Anon-callable by design: the picker runs before anyone has signed in. The key is the gate.
REVOKE ALL ON FUNCTION public.get_pos_device_staff(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_pos_device_staff(uuid, uuid, text) TO anon, authenticated, service_role;

-- ── (5) The device gate inside pos-staff-login ──────────────────────────────────────────────────
--
-- service_role only: the Edge Function is the one caller. Each is one UPDATE, so "is the key live"
-- and "stamp that it was used" cannot disagree. A browser that could call these could reset
-- nothing and learn nothing it cannot learn from get_pos_device_staff — but a call that moved to
-- the server takes its grant with it (supabase-sql.md, S532).
CREATE OR REPLACE FUNCTION public.verify_pos_device(p_client_id uuid, p_device_id uuid, p_device_secret text)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_ok boolean;
BEGIN
  IF p_client_id IS NULL OR p_device_id IS NULL OR p_device_secret IS NULL THEN
    RETURN false;
  END IF;
  UPDATE pos_devices
     SET last_used_at = now()
   WHERE id = p_device_id
     AND client_id = p_client_id
     AND revoked_at IS NULL
     AND secret_hash = public.pos_device_secret_hash(p_device_secret)
  RETURNING true INTO v_ok;
  RETURN COALESCE(v_ok, false);
END;
$$;
REVOKE ALL ON FUNCTION public.verify_pos_device(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_pos_device(uuid, uuid, text) TO service_role;

-- The shared key, for tablets activated before this migration. Compared as text so a malformed
-- value is a plain mismatch rather than a uuid cast error.
CREATE OR REPLACE FUNCTION public.verify_pos_legacy_device(p_client_id uuid, p_device_secret text)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_ok boolean;
BEGIN
  IF p_client_id IS NULL OR p_device_secret IS NULL THEN
    RETURN false;
  END IF;
  UPDATE client_secrets
     SET pos_legacy_key_last_used_at = now()
   WHERE client_id = p_client_id
     AND pos_legacy_key_retired_at IS NULL
     AND pos_device_secret::text = lower(p_device_secret)
  RETURNING true INTO v_ok;
  RETURN COALESCE(v_ok, false);
END;
$$;
REVOKE ALL ON FUNCTION public.verify_pos_legacy_device(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_pos_legacy_device(uuid, text) TO service_role;

-- ── (6) Retiring the shared key ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.pos_legacy_device_key_status(p_client_id uuid)
RETURNS TABLE(retired_at timestamptz, last_used_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF p_client_id IS NULL OR NOT public.pos_device_caller_may_manage(p_client_id) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  -- No client_secrets row means there has never been a shared key to retire: zero rows.
  RETURN QUERY
    SELECT cs.pos_legacy_key_retired_at::timestamptz, cs.pos_legacy_key_last_used_at::timestamptz
      FROM client_secrets cs
     WHERE cs.client_id = p_client_id;
END;
$$;
REVOKE ALL ON FUNCTION public.pos_legacy_device_key_status(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pos_legacy_device_key_status(uuid) TO authenticated, service_role;

-- Rotate, then mark. Rotation is what actually ends it: every comparison against the old value —
-- get_pos_staff, verify_pos_legacy_device, and a pos-staff-login still running the pre-S754 body —
-- stops matching in the same statement. Idempotent; a second call changes nothing.
CREATE OR REPLACE FUNCTION public.retire_pos_legacy_device_key(p_client_id uuid)
RETURNS timestamptz
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_at timestamptz;
BEGIN
  IF p_client_id IS NULL OR NOT public.pos_device_caller_may_manage(p_client_id) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  UPDATE client_secrets
     SET pos_device_secret = gen_random_uuid(),
         pos_legacy_key_retired_at = now(),
         updated_at = now()
   WHERE client_id = p_client_id
     AND pos_legacy_key_retired_at IS NULL
  RETURNING pos_legacy_key_retired_at INTO v_at;

  IF v_at IS NULL THEN
    SELECT pos_legacy_key_retired_at INTO v_at FROM client_secrets WHERE client_id = p_client_id;
    RETURN v_at;
  END IF;

  -- client_secrets is deliberately unaudited (its snapshot would carry both secrets), so the
  -- switch-off writes one row of its own naming only the timestamp.
  INSERT INTO audit_logs (client_id, client_name, user_id, user_name, table_name, action, record_id, old_data, new_data)
  SELECT c.id, c.name, (select auth.uid()),
         (SELECT pr.full_name FROM profiles pr WHERE pr.id = (select auth.uid())),
         'client_secrets', 'UPDATE', c.id,
         jsonb_build_object('pos_legacy_key_retired_at', NULL),
         jsonb_build_object('pos_legacy_key_retired_at', v_at)
    FROM clients c WHERE c.id = p_client_id;

  RETURN v_at;
END;
$$;
REVOKE ALL ON FUNCTION public.retire_pos_legacy_device_key(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.retire_pos_legacy_device_key(uuid) TO authenticated, service_role;

-- 20260916110000's body (COALESCE'd manager test), plus: once the shared key is retired nobody —
-- admin included — is handed it, so a tablet still running a pre-S754 bundle cannot mint a new
-- legacy-keyed till. The rotated value is known to no one and should stay that way.
CREATE OR REPLACE FUNCTION public.get_pos_device_secret(p_client_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  caller_client_id uuid;
  caller_pos_role  text;
  v_secret         uuid;
  v_retired        timestamptz;
BEGIN
  IF NOT COALESCE(public.is_admin(), false) THEN
    SELECT COALESCE(p.active_client_id, p.client_id), p.pos_role INTO caller_client_id, caller_pos_role
    FROM profiles p WHERE p.id = auth.uid();

    IF caller_client_id IS DISTINCT FROM p_client_id THEN
      RAISE EXCEPTION 'not authorized';
    END IF;
    IF NOT COALESCE(public.is_client_owner() OR caller_pos_role = 'manager', false) THEN
      RAISE EXCEPTION 'not authorized';
    END IF;
  END IF;

  SELECT pos_device_secret, pos_legacy_key_retired_at INTO v_secret, v_retired
    FROM client_secrets WHERE client_id = p_client_id;
  IF v_retired IS NOT NULL THEN
    RAISE EXCEPTION 'pos_legacy_device_key_retired' USING ERRCODE = '42501',
      HINT = 'This restaurant uses a key per tablet now. Reload the page to get the current version of POS Setup.';
  END IF;
  RETURN v_secret;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.get_pos_device_secret(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_pos_device_secret(uuid) TO authenticated, service_role;

-- ── Assertions ──────────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_fn text;
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.pos_devices'::regclass) THEN
    RAISE EXCEPTION 'S754 keys: RLS is not enabled on pos_devices';
  END IF;
  IF has_table_privilege('anon', 'public.pos_devices', 'SELECT')
     OR has_table_privilege('authenticated', 'public.pos_devices', 'SELECT')
     OR has_table_privilege('authenticated', 'public.pos_devices', 'INSERT')
     OR has_table_privilege('authenticated', 'public.pos_devices', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.pos_devices', 'DELETE') THEN
    RAISE EXCEPTION 'S754 keys: a client role holds a privilege on pos_devices';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.pos_devices', 'SELECT') THEN
    RAISE EXCEPTION 'S754 keys: service_role cannot read pos_devices';
  END IF;

  -- Callable by nobody through the API.
  FOREACH v_fn IN ARRAY ARRAY['public.pos_device_secret_hash(text)', 'public.pos_device_caller_may_manage(uuid)',
                              'public.pos_device_key_valid(uuid, uuid, text)',
                              'public.pos_devices_audit(text, public.pos_devices, public.pos_devices)'] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'S754 keys: internal helper % is API-callable', v_fn;
    END IF;
  END LOOP;
  -- Signed-in managers only.
  FOREACH v_fn IN ARRAY ARRAY['public.register_pos_device(uuid, text)', 'public.list_pos_devices(uuid)',
                              'public.revoke_pos_device(uuid)', 'public.pos_legacy_device_key_status(uuid)',
                              'public.retire_pos_legacy_device_key(uuid)', 'public.get_pos_device_secret(uuid)'] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'S754 keys: % must be authenticated-only', v_fn;
    END IF;
  END LOOP;
  -- The Edge Function only.
  FOREACH v_fn IN ARRAY ARRAY['public.verify_pos_device(uuid, uuid, text)', 'public.verify_pos_legacy_device(uuid, text)'] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE')
       OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'S754 keys: % must be service_role-only', v_fn;
    END IF;
  END LOOP;
  -- The pre-login picker.
  IF NOT has_function_privilege('anon', 'public.get_pos_device_staff(uuid, uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'S754 keys: anon cannot reach the PIN picker';
  END IF;
  IF (SELECT count(*) FROM pg_proc WHERE proname = 'get_pos_device_staff' AND pronamespace = 'public'::regnamespace) <> 1 THEN
    RAISE EXCEPTION 'S754 keys: get_pos_device_staff has more than one signature';
  END IF;

  -- Every entry point that bypasses RLS must be DEFINER, and the key test and hash must not be.
  FOREACH v_fn IN ARRAY ARRAY['public.register_pos_device(uuid, text)', 'public.list_pos_devices(uuid)',
                              'public.revoke_pos_device(uuid)', 'public.get_pos_device_staff(uuid, uuid, text)',
                              'public.verify_pos_device(uuid, uuid, text)', 'public.verify_pos_legacy_device(uuid, text)',
                              'public.pos_legacy_device_key_status(uuid)', 'public.retire_pos_legacy_device_key(uuid)',
                              'public.pos_device_caller_may_manage(uuid)'] LOOP
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_fn::regprocedure) THEN
      RAISE EXCEPTION 'S754 keys: % must be SECURITY DEFINER', v_fn;
    END IF;
  END LOOP;

  -- The hash is what the Edge Function and the table agree on; pin its shape.
  IF public.pos_device_secret_hash('abc') <> 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' THEN
    RAISE EXCEPTION 'S754 keys: pos_device_secret_hash is not lowercase-hex SHA-256';
  END IF;

  -- No trigger may snapshot the hash into audit_logs.
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.pos_devices'::regclass AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'S754 keys: pos_devices must carry no trigger (log_audit would copy secret_hash)';
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
