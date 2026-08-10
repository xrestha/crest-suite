-- ════════════════════════════════════════════════════════════════════════════════════════════
-- CRITICAL: any authenticated user could promote themselves to system admin.
--
-- `profiles_update` has always been `USING (id = auth.uid() OR is_admin()) WITH CHECK (same)`,
-- with no column restriction and no guard trigger. Every privilege decision in this codebase
-- reads a column on that row, and the row's own owner could rewrite all of them:
--
--   role = 'admin'                      -> is_admin() turns true -> read/write EVERY tenant's
--                                          data, AdminClients, Danger Zone (deleteClientData on
--                                          any client), admin_clear_audit_logs,
--                                          client_user_emails, find_user_id_by_email
--   client_id = '<other tenant>'        -> cross-tenant access without even needing admin
--   pos_role/ims_role/hr_role/          -> sheds every no_pos_pin_staff / no_ims_staff /
--     hr_self_service = null/false         no_hr_role_staff / no_self_service_accounts
--                                          RESTRICTIVE policy at once, AND passes the negative
--                                          isOwner test in AuthContext.js -> becomes Owner
--   pos_allow_void / pos_discount_limit -> bypasses the S517 per-staff POS controls
--
-- Reachable from ANY account type, including a POS PIN waiter and an HR self-service employee.
-- `authenticated` demonstrably holds UPDATE on this table -- AuthContext.js:147 performs exactly
-- this PATCH shape for last_seen_at on every page load; swapping the body for {"role":"admin"}
-- was the entire exploit. Every other guard in the app (ModuleGate, PremiumGate, hasImsAccess,
-- the four restrictive isolation policy families, scopedDb) sits downstream of this row, so this
-- one policy voided all of them.
--
-- Fixed with a BEFORE UPDATE trigger rather than column-level GRANTs, because admin writes also
-- arrive through PostgREST as the `authenticated` role (AdminClients -> ClientDrawer.js:222
-- upserts a full profile row) and a column GRANT cannot tell an admin apart from a waiter.
--
-- The guard is an ALLOW-LIST of the two columns a client session has any business changing, not
-- a deny-list of the privileged ones. A deny-list silently reopens the hole the next time a
-- column is added to this table -- which is the same failure mode that has already bitten this
-- project repeatedly (S431's pos_team, S517's pos_discount_limit/pos_allow_void, both of which
-- had to be retrofitted into admin-user-ops' conditional-write list after the fact). Uses the
-- `to_jsonb(OLD) - ARRAY[...]` idiom log_audit() already uses in this schema.
-- ════════════════════════════════════════════════════════════════════════════════════════════

-- ── 1. The guard ─────────────────────────────────────────────────────────────────────────────
-- Deliberately SECURITY INVOKER (the default -- note the absence of SECURITY DEFINER): the
-- function must observe the role actually executing the UPDATE. Under SECURITY DEFINER,
-- current_user would be the function owner in every case and the check below would never fire.
--
-- current_user is the seam that lets legitimate privileged writers straight through:
--   'authenticated'/'anon'  a direct PostgREST write from a browser session   -> GUARDED
--   'service_role'          the admin-user-ops / hr-push Edge Functions       -> allowed
--   'postgres'              the body of any SECURITY DEFINER function, e.g.
--                           record_pos_pin_attempt / record_hr_pin_attempt
--                           writing *_pin_failed_attempts / *_pin_locked_until
--                           for a *different* user during an anonymous PIN
--                           login, and handle_new_user                        -> allowed
CREATE OR REPLACE FUNCTION public.guard_profiles_privileged_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;

  -- is_admin() returns NULL when the caller has no profile row; `IF NULL THEN` is not true, so
  -- an unknown caller falls through to the guard rather than past it.
  IF public.is_admin() THEN
    RETURN NEW;
  END IF;

  IF (to_jsonb(NEW) - ARRAY['full_name', 'last_seen_at'])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['full_name', 'last_seen_at']) THEN
    RAISE EXCEPTION
      'profiles: a client session may only change full_name and last_seen_at; role, client_id and every staff-permission column are administered through the admin-user-ops Edge Function'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_profiles_privileged_columns ON public.profiles;
CREATE TRIGGER guard_profiles_privileged_columns
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_profiles_privileged_columns();

-- ── 2. Remove the three manager-update policies ──────────────────────────────────────────────
-- These are a second, independent escalation path, and worse than profiles_update because they
-- reach OTHER people's rows: each grants a module *manager* UPDATE on every same-client profile,
-- with a WITH CHECK that only pins client_id -- so a POS/IMS/HR manager could set role='admin'
-- (or clear the Owner's staff markers) on any colleague's row, or their own.
--
-- Safe to drop outright: nothing in the app has ever used them. A full grep of src/ finds exactly
-- three direct profiles writes -- AuthContext.js:147 (self last_seen_at, still allowed by
-- profiles_update + the trigger above) and ClientDrawer.js:222/253 (admin-only page). Both
-- ims/hr policies even say so in their own migration comments ("everything in the app actually
-- writes ims_role via the admin-user-ops Edge Function (service role, bypasses RLS)"). They were
-- added as defense-in-depth mirrors of the POS one; they are the opposite of that.
DROP POLICY IF EXISTS profiles_pos_role_manager_update ON public.profiles;
DROP POLICY IF EXISTS profiles_ims_role_manager_update ON public.profiles;
DROP POLICY IF EXISTS profiles_hr_role_manager_update ON public.profiles;

NOTIFY pgrst, 'reload schema';

-- ── Verification (run separately; do NOT trust "Success. No rows returned") ───────────────────
-- As a non-admin client login, from the browser console on a logged-in tab:
--
--   await supabase.from('profiles').update({ role: 'admin' }).eq('id', (await supabase.auth.getUser()).data.user.id)
--   -- expect: error 42501, "a client session may only change full_name and last_seen_at"
--
--   await supabase.from('profiles').update({ last_seen_at: new Date().toISOString() }).eq('id', (await supabase.auth.getUser()).data.user.id)
--   -- expect: no error (this is the call AuthContext.js makes on every page load)
--
-- And confirm the policies are actually gone, rather than assuming the DROP took:
--   SELECT policyname FROM pg_policies WHERE tablename = 'profiles' ORDER BY policyname;
--   -- expect: profiles_delete, profiles_insert, profiles_select, profiles_update  (4 rows)
