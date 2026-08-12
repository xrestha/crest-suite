-- ════════════════════════════════════════════════════════════════════════════════════════════
-- Admin-recoverable staff PINs, and the end of "PIN_PEPPER must never be lost".
--
-- S538 (20260812, _shared/pinPassword.ts) stopped storing POS / HR Self-Service PINs as raw auth
-- passwords -- the stored value became HMAC-SHA256(PIN_PEPPER, "<email>:<pin>"). That closed a
-- real hole (the PIN *was* the password, so anyone with an account's email could brute-force
-- GoTrue's /token endpoint directly with the anon key, a path the Edge Function lockout is not
-- on), but it carried an operational cost that is not acceptable at this project's scale:
-- PINs were stored nowhere, so losing the pepper meant hand-resetting every POS and
-- Self-Service account across every client, and the pepper could never be rotated at all.
--
-- This migration adds the two tables that fix that. The PIN vault's PRIMARY purpose is disaster
-- recovery: with plaintext PINs recoverable, a lost or rotated pepper becomes a bulk
-- re-derivation (admin-user-ops' `rederive_pin_passwords`) instead of a mass reset. Letting an
-- admin view one PIN is the secondary capability.
--
-- ── WHY BOTH SECRETS LIVE IN THE DATABASE ───────────────────────────────────────────────────
-- A vault encrypted with a key you must not lose merely renames the problem: you would trade
-- "don't lose PIN_PEPPER" for "don't lose PIN_VAULT_KEY" at zero net gain. So both live here, in
-- an admin-only singleton that self-generates, and are therefore covered by the project's normal
-- Supabase backups with nothing to paste into a password manager.
--
-- This does NOT weaken the pepper against the attack it exists to stop. That attacker is an
-- anonymous caller holding only the anon key; app_secrets is admin-only RLS with no anon grant,
-- so the pepper stays uncomputable off-server and direct /token brute force remains impossible.
-- The pepper is only reachable by someone who already holds an admin session or the service-role
-- key -- and such an attacker can call reset_pos_pin outright, so the pepper was never what was
-- standing in their way.
--
-- ── THE DELIBERATE WEAKENING, STATED PLAINLY ────────────────────────────────────────────────
-- Staff PINs stop being one-way. A compromised admin session now yields every staff PIN, where
-- before it yielded only the ability to reset them. That is a real trade, accepted because these
-- are employer-assigned 4-6 digit till codes that the assigning manager already knows and types
-- themselves (PosStaff.jsx has always been a plain input, never a generator) -- not user-chosen
-- passwords. Mitigations: admin-only RLS, AES-GCM at rest under a separate key, and an audit_logs
-- row per reveal.
--
-- SCOPE IS PINs ONLY. create_ims_staff / create_hr_staff passwords are user-chosen, 8+ chars, and
-- very likely reused on other services; making those recoverable would be a genuine breach risk
-- with no matching justification. They stay one-way. Never add them to this vault.
-- ════════════════════════════════════════════════════════════════════════════════════════════

-- ── app_secrets ─────────────────────────────────────────────────────────────────────────────
-- Singleton. RLS shape, grants and the no-audit decision all mirror client_secrets
-- (20260810140000) -- same class of data, same reasoning.
CREATE TABLE IF NOT EXISTS public.app_secrets (
  id            int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  -- Generated here rather than by a human running openssl, so there is no step anyone can skip
  -- or fat-finger.
  --
  -- Built from gen_random_uuid() rather than the more obvious encode(gen_random_bytes(32),
  -- 'base64'): gen_random_bytes is pgcrypto, which Supabase installs into the `extensions`
  -- schema, so an unqualified call inside a column DEFAULT can fail at INSERT time depending on
  -- the executing session's search_path -- and it would fail at the moment a POS account is
  -- created, not here where it would be noticed. gen_random_uuid() is core Postgres (13+) and is
  -- already used unqualified elsewhere in this schema, so it carries no extension dependency.
  -- Two v4 UUIDs, hyphens stripped, is 64 hex chars / 244 bits of entropy -- ample for both an
  -- HMAC key and an AES-256 key, the latter being derived from these 32 bytes in the Edge
  -- Function rather than used raw.
  pin_pepper    text NOT NULL DEFAULT replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  pin_vault_key text NOT NULL DEFAULT replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.app_secrets (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.app_secrets ENABLE ROW LEVEL SECURITY;

-- Admin only, full stop -- no same-client branch, because this is app-wide infrastructure rather
-- than per-client configuration. No Owner has any reason to see either value.
DROP POLICY IF EXISTS app_secrets_admin ON public.app_secrets;
CREATE POLICY app_secrets_admin ON public.app_secrets
  FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

-- Raw-SQL tables get no role grants in this project (CLAUDE.md's Supabase-grants note). anon gets
-- nothing -- that is what keeps the pepper off the anonymous brute-force path.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.app_secrets TO authenticated, service_role;

-- ── staff_pin_vault ─────────────────────────────────────────────────────────────────────────
-- References profiles(id) rather than auth.users(id): deleting the auth user cascades to the
-- profile, which cascades here, and it keeps every FK in this migration inside the public schema.
CREATE TABLE IF NOT EXISTS public.staff_pin_vault (
  user_id    uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  client_id  uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('pos', 'hr_self_service')),
  -- AES-GCM, base64, 12-byte IV prepended to the ciphertext. Encrypted and decrypted in the Edge
  -- Function (_shared/pinPassword.ts) with WebCrypto rather than pgcrypto, so the key never has
  -- to be passed into SQL where it could land in a query log.
  pin_cipher text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_staff_pin_vault_client ON public.staff_pin_vault (client_id);

ALTER TABLE public.staff_pin_vault ENABLE ROW LEVEL SECURITY;

-- Admin only. Deliberately no same-client branch and no restrictive no_*_staff policies: those
-- exist to carve staff out of an otherwise same-client-readable table, and there is nothing to
-- carve out of admin-only. An Owner recovering a forgotten PIN uses Reset PIN, as before.
DROP POLICY IF EXISTS staff_pin_vault_admin ON public.staff_pin_vault;
CREATE POLICY staff_pin_vault_admin ON public.staff_pin_vault
  FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.staff_pin_vault TO authenticated, service_role;

-- Neither table is audited by log_audit(): it stores full to_jsonb(OLD)/to_jsonb(NEW) row
-- snapshots, which would copy both app secrets AND every PIN ciphertext into audit_logs -- the
-- same reason client_secrets is exempt (20260810140000) and clients.pos_device_secret is stripped
-- (20260804040000). Reveals ARE audited, but as a purpose-built row written by view_staff_pin,
-- which records that a PIN was viewed and by whom without recording the PIN itself.

NOTIFY pgrst, 'reload schema';

-- ── Verification ────────────────────────────────────────────────────────────────────────────
--   SELECT count(*) FROM public.app_secrets;                        -- expect exactly 1
--   SELECT length(pin_pepper) > 0 AND length(pin_vault_key) > 0 FROM public.app_secrets; -- true
--
--   SELECT has_table_privilege('anon', 'public.app_secrets',    'SELECT'),
--          has_table_privilege('anon', 'public.staff_pin_vault','SELECT');
--   -- expect: false, false. Do not trust "Success. No rows returned" from the statements above;
--   -- this project has been bitten by grants that reported success and changed nothing.
--
-- Signed in as any non-admin account (Owner, POS manager, IMS staff):
--   await supabase.from('app_secrets').select('*')      -- expect [] (RLS filters, not errors)
--   await supabase.from('staff_pin_vault').select('*')  -- expect []
--
-- Danger Zone (CLAUDE.md step 7): both tables cascade from clients/profiles, so "Delete Client"
-- cleans them up with no FK violation. staff_pin_vault is still added to deleteClientData in
-- admin-user-ops for the explicitness the checklist asks for; app_secrets is app-wide and must
-- NEVER be touched by any per-client clear/delete path.
