-- ════════════════════════════════════════════════════════════════════════════════════════════
-- MEDIUM x2: both of the app's per-client secrets were readable by every authenticated account
-- of that client -- including a POS PIN waiter and an HR self-service employee.
--
--   clients.pos_device_secret   clients_select is `id = my_client_id() OR is_admin()` with no
--                               staff restriction, and this is a plain column. Any staff account
--                               could read it and then call get_pos_staff() with it, which is
--                               precisely the cross-tenant leak S372 (20260713010859) added the
--                               secret to prevent -- the secret closed the door to outsiders and
--                               left it open to everyone inside.
--
--   settings.pos_webhook_secret settings_select is `client_id IS NULL OR client_id =
--                               my_client_id() OR is_admin()`, and S316's restrictive staff
--                               policies on settings cover INSERT/UPDATE/DELETE only -- never
--                               SELECT. So any staff account could read the HMAC key that
--                               pos-payment-webhook verifies against, forge a payment
--                               confirmation, and have PosOrders.jsx's poll pick it up and close
--                               the bill as digitally paid. That is a cash-skimming path: take
--                               cash, forge the "QR paid" confirmation, pocket the difference.
--                               Worse, settings WRITES are open to POS/IMS/HR staff too (only
--                               hr_self_service is blocked), so a staff account could also rotate
--                               the secret to one it chose.
--
-- Why a new table rather than column-level GRANTs: Postgres has no column-level RLS, and the
-- REVOKE-then-GRANT-per-column form breaks `select('*')`, which both tables have real callers for
-- (SettingsContext.js:69 on settings, AdminClients.js:71 on clients). It would also fail closed
-- on every column added afterwards -- silently, as a permission error on an unrelated feature.
--
-- ── THIS MIGRATION IS PURELY ADDITIVE, AND THAT IS THE POINT ─────────────────────────────────
-- It creates the new table, copies both values into it, and adds the accessor. It deliberately
-- does NOT drop the old columns and does NOT change get_pos_staff's shape. Those are the two
-- changes that break a still-deployed old frontend (old PosLogin.jsx needs pos_email from
-- get_pos_staff to sign in; old Pos.js reads clients.pos_device_secret to activate a device; old
-- ClientDrawer.js reads/writes settings.pos_webhook_secret), and they live in
-- 20260810180000_retire_pos_email_and_secret_columns.sql, to be run AFTER the new frontend ships.
--
-- The result is a genuine zero-downtime cutover, which matters because POS PIN login is the front
-- door of a live restaurant floor:
--   OLD frontend after this migration: still works -- every column it reads still exists.
--   NEW frontend after this migration: works fully -- client_secrets exists, so pos-staff-login
--                                      and pos-payment-webhook resolve, Pos.js's
--                                      get_pos_device_secret resolves, and ClientDrawer's
--                                      client_secrets read/write resolves.
-- Both bundles are simultaneously correct in this window, which is what lets the frontend deploy
-- happen on its own schedule instead of racing the SQL.
-- ════════════════════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.client_secrets (
  client_id          uuid PRIMARY KEY REFERENCES public.clients(id) ON DELETE CASCADE,
  pos_device_secret  uuid NOT NULL DEFAULT gen_random_uuid(),
  pos_webhook_secret text,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Carry both existing values across before anything starts reading the new table, so no device
-- needs re-activating and no configured webhook stops verifying. Copies the CURRENT
-- clients.pos_device_secret rather than minting a new one -- every already-activated POS device
-- has that exact value in localStorage and must keep validating against it.
INSERT INTO public.client_secrets (client_id, pos_device_secret, pos_webhook_secret)
SELECT c.id, c.pos_device_secret, s.pos_webhook_secret
FROM public.clients c
LEFT JOIN public.settings s ON s.client_id = c.id
ON CONFLICT (client_id) DO NOTHING;

ALTER TABLE public.client_secrets ENABLE ROW LEVEL SECURITY;

-- Admin only, full stop. No same-client branch: an Owner never needs to see either value (the POS
-- device secret is delivered by get_pos_device_secret() below, and the webhook secret is only ever
-- set from Admin -> Clients -> Manage). Deliberately no restrictive no_*_staff policies either --
-- those exist to carve staff out of an otherwise same-client-readable table, and there is nothing
-- to carve out of admin-only.
DROP POLICY IF EXISTS client_secrets_admin ON public.client_secrets;
CREATE POLICY client_secrets_admin ON public.client_secrets
  FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

-- Raw-SQL tables get no role grants in this project (see the Supabase-grants note in CLAUDE.md);
-- `authenticated` needs the base grant for the admin UI to reach it at all, with the policy above
-- doing the actual narrowing. anon gets nothing.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.client_secrets TO authenticated, service_role;

-- Deliberately NOT audited. log_audit() stores full to_jsonb(OLD)/to_jsonb(NEW) row snapshots, so
-- attaching the trigger here would copy both secrets into audit_logs in plaintext -- the exact
-- thing 20260804040000 had to special-case for clients.pos_device_secret.

-- ── get_pos_device_secret ────────────────────────────────────────────────────────────────────
-- Replaces Pos.js's direct `clients.select('pos_device_secret')` read. The rank test mirrors the
-- UI gate that was already on the Activate button (Pos.js: canManage = hasPosAccess('manager'),
-- which admin and Owner both resolve to) -- the difference is that it is now enforced on the
-- server, where a staff-rank account can't simply skip the button and issue the query itself.
CREATE OR REPLACE FUNCTION public.get_pos_device_secret(p_client_id uuid) RETURNS uuid
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  caller_client_id uuid;
  caller_pos_role  text;
  v_secret         uuid;
BEGIN
  IF public.is_admin() THEN
    SELECT pos_device_secret INTO v_secret FROM client_secrets WHERE client_id = p_client_id;
    RETURN v_secret;
  END IF;

  SELECT p.client_id, p.pos_role INTO caller_client_id, caller_pos_role
  FROM profiles p WHERE p.id = auth.uid();

  IF caller_client_id IS DISTINCT FROM p_client_id THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  IF NOT (public.is_client_owner() OR caller_pos_role = 'manager') THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  SELECT pos_device_secret INTO v_secret FROM client_secrets WHERE client_id = p_client_id;
  RETURN v_secret;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_pos_device_secret(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_pos_device_secret(uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

-- ── Verification ─────────────────────────────────────────────────────────────────────────────
--   SELECT count(*) AS clients, (SELECT count(*) FROM client_secrets) AS secrets FROM clients;
--   -- expect: the two counts match, one secrets row per client
--
--   SELECT count(*) AS mismatched FROM clients c
--   JOIN client_secrets cs ON cs.client_id = c.id
--   WHERE cs.pos_device_secret IS DISTINCT FROM c.pos_device_secret;
--   -- expect: 0 -- every activated POS device's stored secret still validates
--
-- Signed in as a POS staff-rank (non-manager) account:
--   await supabase.from('client_secrets').select('*')
--   -- expect: [] (RLS -- admin-only, and an RLS-filtered SELECT returns empty, not an error)
--   await supabase.rpc('get_pos_device_secret', { p_client_id: '<own client>' })
--   -- expect: error "not authorized"
--
-- Note for the Danger Zone checklist (CLAUDE.md step 7): client_secrets deliberately is NOT added
-- to clearModuleData/deleteClientData. Its FK is ON DELETE CASCADE, so "Delete Client" cleans it
-- up automatically with no FK violation, and it is account configuration rather than transaction
-- data -- same treatment `settings` already gets.
