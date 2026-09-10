-- ════════════════════════════════════════════════════════════════════════════════════════════
-- Assigned stock counting (S737): attribution, section scope, and PIN login for counters.
--
-- ── The problem ─────────────────────────────────────────────────────────────────────────────
-- A manager could not hand a closing count to a staff member in any real sense. The only
-- mechanism was access: IMS Staff creates an email+password account at ims_role='staff', and
-- Stock.js then shows that person EVERY item in the client. Three consequences, all live:
--
--   1. Two people counting at once overwrite each other in silence. The write is an upsert on
--      (period_id, item_id) -- last write wins, no evidence either way.
--   2. Nobody knows who entered a figure. closing_stock.counted_by has existed since the
--      baseline schema and NOTHING has ever written it (counted_at is written; the name is not).
--   3. A kitchen store-keeper needs an email address and an 8-character password to open a
--      tablet, while the till two metres away takes a 4-digit PIN.
--
-- ── What this migration adds ────────────────────────────────────────────────────────────────
--   A. counted_by as a real uuid + a name snapshot, and a BEFORE UPDATE/DELETE trigger so a
--      staff-rank account cannot overwrite someone else's count.
--   B. ims_count_assignments (staff x category) and RESTRICTIVE policies on closing_stock
--      WRITES, so "only their sections" is enforced by Postgres and not by the screen.
--   C. PIN login for counters: profiles.ims_email + the lockout pair, get_ims_count_staff,
--      and QR enrolment via a short-lived token on client_secrets.
--
-- Every one of the three client settings defaults to OFF (or NULL), so an existing client
-- behaves exactly as it does today until a manager opens Stock Count -> Settings and opts in.
--
-- ── The guard rules this follows ────────────────────────────────────────────────────────────
-- Invariant #3 (S531): a check the browser can skip is advisory. The recount guard is therefore
-- a TRIGGER and the section scope is a POLICY -- an RPC would protect only the callers that
-- choose to call it, and closing_stock is writable over REST by any IMS account's JWT.
--
-- Every authorisation condition is wrapped in COALESCE(..., false). is_admin() returns NULL for
-- a session with no profiles row, is_client_owner() the same, and ims_role is NULL for most
-- accounts -- so the natural spelling of each check below falls OPEN for exactly the callers it
-- exists to stop. See supabase-sql.md's is_admin()-returns-NULL note.
-- ════════════════════════════════════════════════════════════════════════════════════════════

-- ── 0. Feature key + client settings ────────────────────────────────────────────────────────
-- The feature_flags COLUMN, without which every other flag save for every other client fails
-- (new-feature-checklist step 1). Growth tier: Stock Count itself stays Starter -- deciding and
-- policing who counts what is Control, per access-control.md's placement thesis.
ALTER TABLE public.feature_flags ADD COLUMN IF NOT EXISTS stock_count_assignment boolean DEFAULT false;

-- All three OFF by default. ims_count_blind is a DISPLAY rule (the figures still reach the
-- browser); the other two are enforced below by a policy and a trigger respectively.
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS ims_count_scope_enforced boolean DEFAULT false;
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS ims_count_blind boolean DEFAULT false;
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS require_count_attribution boolean DEFAULT false;

-- ── 1. Attribution on closing_stock ─────────────────────────────────────────────────────────
-- counted_by has been `text` and unwritten since the baseline. The USING clause is deliberately
-- self-checking rather than `USING NULL`: if any row anywhere ever held a non-uuid string, this
-- statement fails loudly instead of quietly discarding it.
-- Guarded so the migration stays safe to re-paste after a partially failed run: on a second pass
-- the column is already uuid, and nullif(uuid, '') would then be the thing that errors.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'closing_stock'
      AND column_name = 'counted_by' AND data_type = 'text'
  ) THEN
    ALTER TABLE public.closing_stock
      ALTER COLUMN counted_by TYPE uuid USING (nullif(counted_by, '')::uuid);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'closing_stock_counted_by_fkey'
  ) THEN
    ALTER TABLE public.closing_stock
      ADD CONSTRAINT closing_stock_counted_by_fkey
      FOREIGN KEY (counted_by) REFERENCES public.profiles(id) ON DELETE SET NULL;
  END IF;
END $$;

-- The display snapshot. Without it, deleting a staff account erases the attribution entirely --
-- ON DELETE SET NULL keeps the count and loses the person. Same reasoning as owner-report.md's
-- "resolve FK display values at generation time".
ALTER TABLE public.closing_stock ADD COLUMN IF NOT EXISTS counted_by_name text;

-- Deliberately NOT indexed. No *_by column in this schema is ever filtered on (supabase-sql.md's
-- index note); this one is read as a display value on rows already fetched by period.

-- ── 2. Section assignment ───────────────────────────────────────────────────────────────────
-- Categories are the only grouping items has -- there is no storage-location column -- so the
-- assignment axis is staff x category. An item with no category cannot be assigned and is
-- therefore invisible to a scoped counter; StockCountSettings.jsx warns when any exist.
CREATE TABLE IF NOT EXISTS public.ims_count_assignments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  profile_id  uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES public.categories(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (profile_id, category_id)
);

-- Both are filtered on: the scope helper reads by profile_id, the settings grid by client_id.
CREATE INDEX IF NOT EXISTS idx_ims_count_assignments_client ON public.ims_count_assignments (client_id);
CREATE INDEX IF NOT EXISTS idx_ims_count_assignments_category ON public.ims_count_assignments (category_id);

ALTER TABLE public.ims_count_assignments ENABLE ROW LEVEL SECURITY;

-- Raw-SQL tables get no role grants in this project (CLAUDE.md's Supabase-grants note).
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ims_count_assignments TO authenticated, service_role;

-- ── 3. Who may manage counting, and whether scope is switched on ────────────────────────────
CREATE OR REPLACE FUNCTION public.ims_can_manage_counts() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT COALESCE(
    public.is_admin()
    OR public.is_client_owner()
    OR (SELECT p.ims_role FROM profiles p WHERE p.id = (select auth.uid())) = 'manager',
  false)
$$;

REVOKE EXECUTE ON FUNCTION public.ims_can_manage_counts() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.ims_can_manage_counts() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.ims_count_scope_on() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT COALESCE(
    (SELECT s.ims_count_scope_enforced FROM settings s WHERE s.client_id = public.my_client_id()),
  false)
$$;

REVOKE EXECUTE ON FUNCTION public.ims_count_scope_on() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.ims_count_scope_on() TO authenticated, service_role;

-- The lock itself. Reads as a list of ways to pass, and the ONLY failing case is a staff-rank
-- account, at a client with scoping on, writing an item outside its assigned categories.
--
-- Fail CLOSED: a staff account with scoping on and no assignments at all writes nothing. That is
-- the intended reading of "only their sections" -- the Settings tab says so where the manager
-- turns it on, because otherwise the first support call is "my new counter cannot save".
CREATE OR REPLACE FUNCTION public.ims_count_scope_allows(p_item_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT COALESCE(
    public.is_admin()
    -- Owner (ims_role NULL), supervisor and manager all pass; only 'staff' is scoped.
    OR COALESCE((SELECT p.ims_role FROM profiles p WHERE p.id = (select auth.uid())), '') <> 'staff'
    OR NOT public.ims_count_scope_on()
    OR EXISTS (
      SELECT 1
      FROM items i
      JOIN ims_count_assignments a ON a.category_id = i.category_id
      WHERE i.id = p_item_id AND a.profile_id = (select auth.uid())
    ),
  false)
$$;

REVOKE EXECUTE ON FUNCTION public.ims_count_scope_allows(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.ims_count_scope_allows(uuid) TO authenticated, service_role;

-- ── 4. Policies on ims_count_assignments ────────────────────────────────────────────────────
-- Split per command deliberately, the client_groups exception rather than the <x>_all rule
-- (supabase-sql.md): a staff account must READ its own assignments to know what it is counting,
-- and must never WRITE one -- an account that can insert its own row has defeated the feature.
-- A single FOR ALL would have to carry the read clause in USING, and DELETE is checked against
-- USING with no WITH CHECK behind it.
DROP POLICY IF EXISTS ims_count_assignments_select ON public.ims_count_assignments;
CREATE POLICY ims_count_assignments_select ON public.ims_count_assignments
  FOR SELECT TO authenticated
  USING (COALESCE(public.is_admin() OR client_id = public.my_client_id(), false));

DROP POLICY IF EXISTS ims_count_assignments_insert ON public.ims_count_assignments;
CREATE POLICY ims_count_assignments_insert ON public.ims_count_assignments
  FOR INSERT TO authenticated
  WITH CHECK (
    COALESCE(public.is_admin() OR (client_id = public.my_client_id() AND public.ims_can_manage_counts()), false)
  );

DROP POLICY IF EXISTS ims_count_assignments_update ON public.ims_count_assignments;
CREATE POLICY ims_count_assignments_update ON public.ims_count_assignments
  FOR UPDATE TO authenticated
  USING (
    COALESCE(public.is_admin() OR (client_id = public.my_client_id() AND public.ims_can_manage_counts()), false)
  )
  WITH CHECK (
    COALESCE(public.is_admin() OR (client_id = public.my_client_id() AND public.ims_can_manage_counts()), false)
  );

DROP POLICY IF EXISTS ims_count_assignments_delete ON public.ims_count_assignments;
CREATE POLICY ims_count_assignments_delete ON public.ims_count_assignments
  FOR DELETE TO authenticated
  USING (
    COALESCE(public.is_admin() OR (client_id = public.my_client_id() AND public.ims_can_manage_counts()), false)
  );

-- RESTRICTIVE staff-isolation families. A new business table inherits none of them, and a bare
-- same-client policy re-opens the hole for whichever staff-account type's JWT touches it
-- (supabase-sql.md). Three of the four apply here; no_ims_staff deliberately does NOT -- an IMS
-- staff account is the whole point of this table and must read its own rows.
DROP POLICY IF EXISTS no_self_service_accounts ON public.ims_count_assignments;
CREATE POLICY no_self_service_accounts ON public.ims_count_assignments AS RESTRICTIVE FOR ALL
  USING (NOT public.is_hr_self_service()) WITH CHECK (NOT public.is_hr_self_service());
DROP POLICY IF EXISTS no_pos_pin_staff ON public.ims_count_assignments;
CREATE POLICY no_pos_pin_staff ON public.ims_count_assignments AS RESTRICTIVE FOR ALL
  USING (NOT public.is_pos_pin_staff()) WITH CHECK (NOT public.is_pos_pin_staff());
DROP POLICY IF EXISTS no_hr_role_staff ON public.ims_count_assignments;
CREATE POLICY no_hr_role_staff ON public.ims_count_assignments AS RESTRICTIVE FOR ALL
  USING (NOT public.is_hr_role_staff()) WITH CHECK (NOT public.is_hr_role_staff());

-- ── 5. The lock on closing_stock ────────────────────────────────────────────────────────────
-- WRITES only, deliberately not SELECT. These are the client's own rows and hiding them from a
-- counter buys nothing real, while a per-row subquery on every read would be paid on a 1,000-item
-- count sheet every time the page loads. RESTRICTIVE policies AND with the existing permissive
-- closing_stock_all, so nothing here can widen access.
DROP POLICY IF EXISTS ims_count_scope_insert ON public.closing_stock;
CREATE POLICY ims_count_scope_insert ON public.closing_stock AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (public.ims_count_scope_allows(item_id));

DROP POLICY IF EXISTS ims_count_scope_update ON public.closing_stock;
CREATE POLICY ims_count_scope_update ON public.closing_stock AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (public.ims_count_scope_allows(item_id))
  WITH CHECK (public.ims_count_scope_allows(item_id));

DROP POLICY IF EXISTS ims_count_scope_delete ON public.closing_stock;
CREATE POLICY ims_count_scope_delete ON public.closing_stock AS RESTRICTIVE FOR DELETE TO authenticated
  USING (public.ims_count_scope_allows(item_id));

-- ── 6. The recount guard ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ims_recount_guard_on() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT COALESCE(
    (SELECT s.require_count_attribution FROM settings s WHERE s.client_id = public.my_client_id()),
  false)
$$;

REVOKE EXECUTE ON FUNCTION public.ims_recount_guard_on() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.ims_recount_guard_on() TO authenticated, service_role;

-- Deliberately SECURITY INVOKER (note the absence of SECURITY DEFINER), for the same reason
-- guard_profiles_privileged_columns() is: current_user is the seam that lets the service role and
-- every SECURITY DEFINER body straight through. Under DEFINER current_user would be the owner on
-- every call and the check would never fire.
--
-- Only a 'staff' rank is blocked. A supervisor, manager, Owner or admin correcting a count is the
-- sanctioned way through -- there is no force-path RPC because the lossless state change already
-- exists (vendors.md's variation on the same pattern).
CREATE OR REPLACE FUNCTION public.closing_stock_guard_recount() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN RETURN COALESCE(NEW, OLD); END IF;
  IF NOT public.ims_recount_guard_on() THEN RETURN COALESCE(NEW, OLD); END IF;

  -- Nobody has claimed this row yet, or the claimant is the person writing now.
  IF OLD.counted_by IS NULL OR OLD.counted_by = (select auth.uid()) THEN RETURN COALESCE(NEW, OLD); END IF;

  IF COALESCE((SELECT p.ims_role FROM profiles p WHERE p.id = (select auth.uid())), '') <> 'staff' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Named so errorText.js can turn it into a sentence that says what state the record is in and
  -- how to get out of it, rather than printing a constraint (S619).
  RAISE EXCEPTION 'closing_count_locked: counted by %', COALESCE(OLD.counted_by_name, 'another staff member');
END;
$$;

DROP TRIGGER IF EXISTS closing_stock_recount_guard ON public.closing_stock;
CREATE TRIGGER closing_stock_recount_guard
  BEFORE UPDATE OR DELETE ON public.closing_stock
  FOR EACH ROW EXECUTE FUNCTION public.closing_stock_guard_recount();

-- ── 7. PIN login for counters ───────────────────────────────────────────────────────────────
-- Structural mirror of the POS PIN account: a synthetic email that NEVER leaves the server, a
-- password derived off-server as HMAC(pepper, email:pin), and the lockout enforced on the same
-- request that signs in. See supabase/functions/ims-staff-login/index.ts.
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS ims_email text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS ims_pin_failed_attempts integer DEFAULT 0 NOT NULL;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS ims_pin_locked_until timestamp with time zone;

CREATE UNIQUE INDEX IF NOT EXISTS profiles_ims_email_key
  ON public.profiles (ims_email) WHERE (ims_email IS NOT NULL);

-- None of the three goes on guard_profiles_privileged_columns()'s allow-list. That list is an
-- ALLOW-list precisely so a new column is privileged by default, which is correct here: ims_email
-- is half a credential and the lockout pair is the credential's only throttle.

-- Mirrors check_pos_pin_lock / record_pos_pin_attempt exactly, filtered to real PIN count
-- accounts (ims_role AND ims_email both set) so neither can ever be pointed at an Owner's
-- email+password login.
CREATE OR REPLACE FUNCTION public.check_ims_pin_lock(p_staff_id uuid) RETURNS TABLE(
    locked boolean, locked_until timestamp with time zone
) LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT (ims_pin_locked_until IS NOT NULL AND ims_pin_locked_until > now()), ims_pin_locked_until
  FROM profiles
  WHERE id = p_staff_id AND ims_role IS NOT NULL AND ims_email IS NOT NULL;
$$;

CREATE OR REPLACE FUNCTION public.record_ims_pin_attempt(p_staff_id uuid, p_success boolean) RETURNS TABLE(
    locked boolean, locked_until timestamp with time zone
) LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF p_success THEN
    UPDATE profiles SET ims_pin_failed_attempts = 0, ims_pin_locked_until = NULL
    WHERE id = p_staff_id AND ims_role IS NOT NULL AND ims_email IS NOT NULL;
  ELSE
    UPDATE profiles
    SET ims_pin_failed_attempts = CASE
          WHEN ims_pin_locked_until IS NOT NULL AND ims_pin_locked_until <= now() THEN 1
          ELSE ims_pin_failed_attempts + 1
        END,
        ims_pin_locked_until = CASE
          WHEN (CASE WHEN ims_pin_locked_until IS NOT NULL AND ims_pin_locked_until <= now() THEN 1
                     ELSE ims_pin_failed_attempts + 1 END) >= 5
          THEN now() + interval '15 minutes'
          ELSE ims_pin_locked_until
        END
    WHERE id = p_staff_id AND ims_role IS NOT NULL AND ims_email IS NOT NULL;
  END IF;

  RETURN QUERY
    SELECT (ims_pin_locked_until IS NOT NULL AND ims_pin_locked_until > now()), ims_pin_locked_until
    FROM profiles
    WHERE id = p_staff_id AND ims_role IS NOT NULL AND ims_email IS NOT NULL;
END;
$$;

-- service_role ONLY. Both are called exclusively from inside ims-staff-login, and 20260810190000
-- is the precedent: leaving the browser's old grant in place after a call moves to the server is
-- the exact surface the move existed to close -- an anonymous POST to record_ims_pin_attempt with
-- p_success = true would reset an arbitrary staff member's lockout counter.
REVOKE EXECUTE ON FUNCTION public.check_ims_pin_lock(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.record_ims_pin_attempt(uuid, boolean) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.check_ims_pin_lock(uuid) TO service_role;
GRANT  EXECUTE ON FUNCTION public.record_ims_pin_attempt(uuid, boolean) TO service_role;

-- PIN vault: recoverable plaintext PINs are what make a lost or rotated pepper a re-derivation
-- rather than a mass reset across every client (20260812110000's header).
ALTER TABLE public.staff_pin_vault DROP CONSTRAINT IF EXISTS staff_pin_vault_kind_check;
ALTER TABLE public.staff_pin_vault ADD CONSTRAINT staff_pin_vault_kind_check
  CHECK (kind IN ('pos', 'hr_self_service', 'ims_count'));

-- ── 8. Device enrolment by QR ───────────────────────────────────────────────────────────────
-- POS activates a device by pressing a button ON that device while signed in as a manager. A
-- store-room tablet has no such session, so enrolment here runs the other way: the manager
-- displays a QR from Stock Count -> Settings and the tablet scans it.
--
-- The QR carries a SHORT-LIVED TOKEN, never ims_device_secret itself. The secret is long-lived
-- and gates the anonymous roster read; a QR is displayed in a room with people in it and is
-- trivially photographed off a manager's screen.
ALTER TABLE public.client_secrets ADD COLUMN IF NOT EXISTS ims_device_secret uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE public.client_secrets ADD COLUMN IF NOT EXISTS ims_enrol_token text;
ALTER TABLE public.client_secrets ADD COLUMN IF NOT EXISTS ims_enrol_token_expires_at timestamptz;

-- Redeemable any number of times until it expires, rather than once. A manager enrolling the
-- store tablet and their own phone in one go is the normal case, and forcing a fresh QR per
-- device buys nothing against an attacker who can already see the screen the QR is on.
-- "Hide QR" clears it immediately, so the window is the manager's to close.
CREATE OR REPLACE FUNCTION public.issue_ims_enrol_token(p_client_id uuid)
    RETURNS TABLE(token text, expires_at timestamptz)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_token   text;
  v_expires timestamptz;
BEGIN
  IF NOT COALESCE(
       public.is_admin() OR (p_client_id = public.my_client_id() AND public.ims_can_manage_counts()),
     false) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- 32 hex chars off gen_random_uuid() -- 122 bits, and no pgcrypto dependency.
  v_token   := replace(gen_random_uuid()::text, '-', '');
  v_expires := now() + interval '15 minutes';

  INSERT INTO client_secrets (client_id, ims_enrol_token, ims_enrol_token_expires_at)
  VALUES (p_client_id, v_token, v_expires)
  ON CONFLICT (client_id) DO UPDATE
    SET ims_enrol_token = EXCLUDED.ims_enrol_token,
        ims_enrol_token_expires_at = EXCLUDED.ims_enrol_token_expires_at,
        updated_at = now();

  RETURN QUERY SELECT v_token, v_expires;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.issue_ims_enrol_token(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.issue_ims_enrol_token(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.revoke_ims_enrol_token(p_client_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NOT COALESCE(
       public.is_admin() OR (p_client_id = public.my_client_id() AND public.ims_can_manage_counts()),
     false) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE client_secrets
  SET ims_enrol_token = NULL, ims_enrol_token_expires_at = NULL, updated_at = now()
  WHERE client_id = p_client_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.revoke_ims_enrol_token(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.revoke_ims_enrol_token(uuid) TO authenticated, service_role;

-- Anonymous by design: this runs on the count tablet before anyone has signed in. It returns the
-- device secret, so the token is the entire authorisation -- hence the expiry, the ims_enabled
-- check, and nothing else in the return but what the login screen must draw.
CREATE OR REPLACE FUNCTION public.redeem_ims_enrol_token(p_token text)
    RETURNS TABLE(client_id uuid, client_name text, device_secret uuid)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT cs.client_id, c.name, cs.ims_device_secret
  FROM client_secrets cs
  JOIN clients c ON c.id = cs.client_id
  WHERE cs.ims_enrol_token = p_token
    AND cs.ims_enrol_token_expires_at IS NOT NULL
    AND cs.ims_enrol_token_expires_at > now()
    AND COALESCE(c.ims_enabled, false);
$$;

REVOKE EXECUTE ON FUNCTION public.redeem_ims_enrol_token(text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.redeem_ims_enrol_token(text) TO anon, authenticated, service_role;

-- The roster. Structural mirror of get_pos_staff after S531 stripped pos_email from it: enough to
-- draw a tile, nothing that logs anyone in. The device secret is verified inside the function, so
-- a guessed client_id alone yields nothing (S372).
DROP FUNCTION IF EXISTS public.get_ims_count_staff(uuid, uuid);
CREATE FUNCTION public.get_ims_count_staff(p_client_id uuid, p_device_secret uuid)
    RETURNS TABLE(id uuid, full_name text, ims_job_title text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT p.id, p.full_name, p.ims_job_title
  FROM profiles p
  WHERE p.client_id = p_client_id
    AND p.ims_role IS NOT NULL
    AND p.ims_email IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM client_secrets cs
      WHERE cs.client_id = p_client_id AND cs.ims_device_secret = p_device_secret
    )
  ORDER BY p.full_name;
$$;

REVOKE EXECUTE ON FUNCTION public.get_ims_count_staff(uuid, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_ims_count_staff(uuid, uuid) TO anon, authenticated, service_role;

-- ── 8b. The IMS Staff screen has to be able to tell the two account types apart ─────────────
-- get_ims_staff_list feeds IMS → IMS Staff, and that screen now offers Reset PIN or Reset
-- Password depending on which kind of login the row is. DROP + CREATE rather than CREATE OR
-- REPLACE: this changes the RETURNS TABLE column list, which CREATE OR REPLACE cannot do
-- (Postgres 42P13). The signature is unchanged, so a stale bundle keeps working — it simply
-- ignores the new column.
--
-- `email` is NULL for a PIN account rather than carrying the synthetic address. There is nothing
-- for a manager to share (nobody types it) and it is half of a credential, so it has no reason to
-- leave the server — the same call get_pos_staff makes.
DROP FUNCTION IF EXISTS public.get_ims_staff_list(uuid);

CREATE FUNCTION public.get_ims_staff_list(p_client_id uuid) RETURNS TABLE(
    id uuid, full_name text, email text, ims_role text, ims_job_title text,
    last_seen_at timestamp with time zone, hr_employee_id uuid, employee_code text,
    has_pin boolean
) LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  caller_client_id uuid;
  caller_role text;
BEGIN
  SELECT p.client_id, p.role INTO caller_client_id, caller_role
  FROM profiles p WHERE p.id = auth.uid();

  IF COALESCE(caller_role = 'admin' OR caller_client_id = p_client_id, false) THEN
    RETURN QUERY
      SELECT p.id, p.full_name,
             CASE WHEN p.ims_email IS NULL THEN u.email ELSE NULL END,
             p.ims_role, p.ims_job_title, p.last_seen_at, p.hr_employee_id, e.employee_code,
             (p.ims_email IS NOT NULL)
      FROM profiles p
      JOIN auth.users u ON u.id = p.id
      LEFT JOIN hr_employees e ON e.id = p.hr_employee_id
      WHERE p.client_id = p_client_id
        AND p.role = 'client'
        AND p.ims_role IS NOT NULL
      ORDER BY p.full_name;
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_ims_staff_list(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_ims_staff_list(uuid) TO authenticated, service_role;

-- ── 9. Keep the audit log readable ──────────────────────────────────────────────────────────
-- The new lockout counters churn on every PIN attempt exactly as the POS and HR pairs do. Without
-- adding them to the noise-skip list, every wrong PIN writes a zero-content row into audit_logs.
-- Full body reproduced from 20260804040000 (CREATE OR REPLACE cannot patch one line); the ONLY
-- change is the two ARRAY literals in the profiles block.
CREATE OR REPLACE FUNCTION public.log_audit() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'auth'
    AS $$
DECLARE
  _client_id uuid; _client_name text; _user_id uuid; _user_name text; _record_id uuid;
  _old jsonb; _new jsonb;
BEGIN
  _user_id := auth.uid();
  SELECT full_name INTO _user_name FROM profiles WHERE id = _user_id;

  IF TG_OP = 'DELETE' THEN
    _record_id := OLD.id;
    IF TG_TABLE_NAME IN ('purchase_entries','opening_stock','closing_stock','wastages') THEN
      SELECT client_id INTO _client_id FROM monthly_periods WHERE id = OLD.period_id;
    ELSIF TG_TABLE_NAME = 'clients' THEN
      -- the clients table has no client_id column -- the row's own id IS the client, and its
      -- name must come off OLD directly since a re-SELECT after a DELETE would find nothing
      _client_id := OLD.id; _client_name := OLD.name;
    ELSE _client_id := OLD.client_id; END IF;
  ELSE
    _record_id := NEW.id;
    IF TG_TABLE_NAME IN ('purchase_entries','opening_stock','closing_stock','wastages') THEN
      SELECT client_id INTO _client_id FROM monthly_periods WHERE id = NEW.period_id;
    ELSIF TG_TABLE_NAME = 'clients' THEN
      _client_id := NEW.id; _client_name := NEW.name;
    ELSE _client_id := NEW.client_id; END IF;
  END IF;

  -- monthly_periods: only a status transition (open/closed) is audit-worthy
  IF TG_TABLE_NAME = 'monthly_periods' AND TG_OP = 'UPDATE' THEN
    IF OLD.status = NEW.status THEN RETURN NULL; END IF;
  END IF;

  -- profiles: PIN-lockout counters and last_seen_at churn on every login attempt / page load
  -- (record_pos_pin_attempt, record_hr_pin_attempt, record_ims_pin_attempt, session keep-alive)
  -- -- not audit signal, and left unfiltered would flood the table with zero-content rows on
  -- every failed PIN entry
  IF TG_TABLE_NAME = 'profiles' AND TG_OP = 'UPDATE' THEN
    IF (to_jsonb(OLD) - ARRAY['pos_pin_failed_attempts','pos_pin_locked_until','hr_pin_failed_attempts','hr_pin_locked_until','ims_pin_failed_attempts','ims_pin_locked_until','last_seen_at'])
       = (to_jsonb(NEW) - ARRAY['pos_pin_failed_attempts','pos_pin_locked_until','hr_pin_failed_attempts','hr_pin_locked_until','ims_pin_failed_attempts','ims_pin_locked_until','last_seen_at'])
    THEN RETURN NULL; END IF;
  END IF;

  -- pos_orders: covers/print_count/comp_print_count/notes change on nearly every item edit or
  -- bill reprint during a live order -- only real state transitions (status, close_type,
  -- discount, void, payment, invoice_no, credit settlement) are audit-worthy
  IF TG_TABLE_NAME = 'pos_orders' AND TG_OP = 'UPDATE' THEN
    IF (to_jsonb(OLD) - ARRAY['covers','print_count','comp_print_count','notes'])
       = (to_jsonb(NEW) - ARRAY['covers','print_count','comp_print_count','notes'])
    THEN RETURN NULL; END IF;
  END IF;

  IF _client_id IS NOT NULL AND _client_name IS NULL THEN
    SELECT name INTO _client_name FROM clients WHERE id = _client_id;
  END IF;

  _old := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END;
  _new := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END;

  -- pos_device_secret is the unguessable per-client secret that gates the anonymous
  -- get_pos_staff RPC (S372) -- never let it reach the audit trail, admin-only viewer or not
  IF TG_TABLE_NAME = 'clients' THEN
    IF _old IS NOT NULL THEN _old := _old - 'pos_device_secret'; END IF;
    IF _new IS NOT NULL THEN _new := _new - 'pos_device_secret'; END IF;
  END IF;

  INSERT INTO audit_logs (client_id, client_name, user_id, user_name, table_name, action, record_id, old_data, new_data)
  VALUES (_client_id, _client_name, _user_id, _user_name, TG_TABLE_NAME, TG_OP, _record_id, _old, _new);
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$;

NOTIFY pgrst, 'reload schema';

-- ── Verification ────────────────────────────────────────────────────────────────────────────
-- A plpgsql body is NOT validated at CREATE time -- every SQL expression inside is resolved the
-- first time that statement runs, which is how S735 shipped a max() over a uuid that applied
-- green and failed on every bill edit for weeks. So CALL each new function once, here, where a
-- typing error aborts the migration instead of surfacing on a store-room tablet.
--
-- insufficient_privilege is the expected outcome for the two manager-gated ones when this runs as
-- postgres with no profiles row (is_admin() returns NULL -> COALESCE false -> raise). Anything
-- else propagates and rolls the migration back, which is the point.
DO $$
DECLARE
  v_ok boolean;
BEGIN
  v_ok := public.ims_can_manage_counts();
  v_ok := public.ims_count_scope_on();
  v_ok := public.ims_recount_guard_on();
  v_ok := public.ims_count_scope_allows(gen_random_uuid());
  PERFORM * FROM public.check_ims_pin_lock(gen_random_uuid());
  PERFORM * FROM public.record_ims_pin_attempt(gen_random_uuid(), false);
  PERFORM * FROM public.redeem_ims_enrol_token('no-such-token');
  PERFORM * FROM public.get_ims_count_staff(gen_random_uuid(), gen_random_uuid());
  PERFORM * FROM public.get_ims_staff_list(gen_random_uuid());

  BEGIN
    PERFORM * FROM public.issue_ims_enrol_token(gen_random_uuid());
    RAISE EXCEPTION 'issue_ims_enrol_token did not refuse an unauthorised caller';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    PERFORM public.revoke_ims_enrol_token(gen_random_uuid());
    RAISE EXCEPTION 'revoke_ims_enrol_token did not refuse an unauthorised caller';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

-- Run these by hand after applying, and read the results -- this project has been bitten by
-- revokes that reported success and changed nothing:
--
--   SELECT has_function_privilege('anon', 'public.record_ims_pin_attempt(uuid, boolean)', 'EXECUTE'),
--          has_function_privilege('anon', 'public.check_ims_pin_lock(uuid)', 'EXECUTE'),
--          has_function_privilege('anon', 'public.issue_ims_enrol_token(uuid)', 'EXECUTE');
--   -- expect: false, false, false
--
--   SELECT has_function_privilege('anon', 'public.get_ims_count_staff(uuid, uuid)', 'EXECUTE'),
--          has_function_privilege('anon', 'public.redeem_ims_enrol_token(text)', 'EXECUTE');
--   -- expect: true, true  (both run before there is a session)
--
--   SELECT count(*) FROM public.closing_stock WHERE counted_by IS NOT NULL;  -- 0 before any count
--
-- Signed in as an ims_role='staff' account at a client with ims_count_scope_enforced = true and
-- no assignment rows, writing closing_stock over REST directly with that JWT: expect a refusal.
-- That is the only test that tells the lock apart from a screen that merely hides things.
