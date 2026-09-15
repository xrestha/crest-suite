-- S758: Crest Customization — a fourth paid module (meal customization: sizes, add-ons, removals,
-- spice/prep choices) sold as a flat add-on on top of Crest POS.
--
-- This migration is the ENTITLEMENT half only. The option tables, the order-line snapshot and the
-- RPC changes come in their own migrations (20260919110000 onwards) so this one can be applied and
-- read back on its own.
--
-- Three rules, each enforced here rather than in the admin screen alone:
--
--   1. clients.customization_enabled + customization_ends_at follow the hr_/pos_ pair exactly, so
--      clientMrr.js, billing-export, subscription.js and the trial purge treat it like any module.
--   2. Customization cannot be on without POS. It changes what is on a POS bill, so with POS off
--      there is nothing for it to do — and pos_enabled is the only gate on the public guest menu
--      (S632), so a module that reaches the guest menu must sit behind that same gate. A BEFORE
--      trigger refuses the on-without-POS write, and switching POS OFF takes Customization with it
--      (the drawer mirrors this, but the drawer is one writer of several).
--   3. customization_live(client) is the ONE server-side test every option-accepting RPC calls.
--      It reads the flag AND pos_enabled, so a stale flag on a client whose POS lapsed grants
--      nothing.

-- ── 1. Columns ─────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS customization_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS customization_ends_at timestamptz;

COMMENT ON COLUMN public.clients.customization_enabled IS
  'Crest Customization module (S758). Requires pos_enabled — clients_customization_requires_pos enforces it.';
COMMENT ON COLUMN public.clients.customization_ends_at IS
  'Paid-through date for Crest Customization; same semantics as pos_ends_at.';

-- ── 2. Requires POS ────────────────────────────────────────────────────────────────────────────
-- SECURITY INVOKER with no role seam on purpose: this is a data invariant, not a privilege check,
-- so it applies to the service role and to a restore exactly as it does to the admin drawer.
CREATE OR REPLACE FUNCTION public.clients_customization_requires_pos()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path TO 'public'
AS $fn$
BEGIN
  IF COALESCE(NEW.customization_enabled, false) AND NOT COALESCE(NEW.pos_enabled, false) THEN
    -- POS being switched OFF on a client that already had Customization: take it down with POS
    -- rather than refusing the POS change. Any other way of reaching "on without POS" is refused.
    IF TG_OP = 'UPDATE'
       AND COALESCE(OLD.pos_enabled, false)
       AND OLD.customization_enabled IS NOT DISTINCT FROM NEW.customization_enabled THEN
      NEW.customization_enabled := false;
    ELSE
      RAISE EXCEPTION 'Crest Customization needs Crest POS switched on for this client'
        USING ERRCODE = 'check_violation', HINT = 'customization_requires_pos';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.clients_customization_requires_pos() FROM PUBLIC;

DROP TRIGGER IF EXISTS clients_customization_requires_pos ON public.clients;
CREATE TRIGGER clients_customization_requires_pos
  BEFORE INSERT OR UPDATE ON public.clients
  FOR EACH ROW EXECUTE FUNCTION public.clients_customization_requires_pos();

-- ── 3. The one entitlement test ────────────────────────────────────────────────────────────────
-- DEFINER so a POS PIN session inside save_pos_order_items can ask it without a clients read of its
-- own; it returns one boolean about the caller's own client and nothing else. NULL-safe: a missing
-- client is false, not NULL (the S630 fail-open shape).
CREATE OR REPLACE FUNCTION public.customization_live(p_client_id uuid)
  RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path TO 'public'
AS $fn$
  SELECT COALESCE(
    (SELECT c.customization_enabled AND COALESCE(c.pos_enabled, false)
       FROM public.clients c WHERE c.id = p_client_id),
    false)
$fn$;
REVOKE ALL ON FUNCTION public.customization_live(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.customization_live(uuid) TO authenticated, service_role;

-- ── 4. The trial purge's "any paid window open" guard learns the new date ──────────────────────
-- Rebuilt from the LIVE body (pg_get_functiondef), not from 20260903150000's text, so an
-- out-of-band change is not silently reverted (the S756 stage-4 rule). Idempotent.
DO $do$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef('public.trials_due_for_purge()'::regprocedure) INTO v_def;
  IF v_def LIKE '%customization_ends_at%' THEN
    RETURN;
  END IF;
  v_def := regexp_replace(
    v_def,
    '(COALESCE\(c\.pos_ends_at,\s*''-infinity''::timestamptz\),)',
    E'\\1\n             COALESCE(c.customization_ends_at, ''-infinity''::timestamptz),'
  );
  IF v_def NOT LIKE '%customization_ends_at%' THEN
    RAISE EXCEPTION 'S758: could not find the pos_ends_at line in the live trials_due_for_purge body';
  END IF;
  EXECUTE v_def;
END
$do$;

-- ── 5. Verification, rolled back ───────────────────────────────────────────────────────────────
-- The inner BEGIN/EXCEPTION is a sub-transaction: everything it writes is undone when the sentinel
-- exception is caught. Any OTHER error propagates and fails the migration, which is the point.
DO $do$
BEGIN
  BEGIN
    DECLARE
      v_id   uuid;
      v_cust boolean;
      v_src  text;
    BEGIN
      INSERT INTO public.clients (name, pos_enabled) VALUES ('__s758_verify', false) RETURNING id INTO v_id;

      -- (a) on without POS is refused
      BEGIN
        UPDATE public.clients SET customization_enabled = true WHERE id = v_id;
        RAISE EXCEPTION 'S758 verify: customization on with POS off was NOT refused';
      EXCEPTION WHEN check_violation THEN
        NULL;
      END;
      -- (b) an insert arriving on-without-POS is refused too
      BEGIN
        INSERT INTO public.clients (name, pos_enabled, customization_enabled) VALUES ('__s758_verify2', false, true);
        RAISE EXCEPTION 'S758 verify: insert on-without-POS was NOT refused';
      EXCEPTION WHEN check_violation THEN
        NULL;
      END;
      -- (c) on with POS is fine, and customization_live agrees
      UPDATE public.clients SET pos_enabled = true WHERE id = v_id;
      UPDATE public.clients SET customization_enabled = true WHERE id = v_id;
      IF NOT public.customization_live(v_id) THEN
        RAISE EXCEPTION 'S758 verify: customization_live false after enabling';
      END IF;
      -- (d) POS off takes Customization with it
      UPDATE public.clients SET pos_enabled = false WHERE id = v_id;
      SELECT customization_enabled INTO v_cust FROM public.clients WHERE id = v_id;
      IF v_cust THEN
        RAISE EXCEPTION 'S758 verify: switching POS off left Customization on';
      END IF;
      IF public.customization_live(v_id) THEN
        RAISE EXCEPTION 'S758 verify: customization_live true with POS off';
      END IF;
      -- (e) an unknown client is false, never NULL
      IF public.customization_live(gen_random_uuid()) IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'S758 verify: customization_live not false for an unknown client';
      END IF;
      -- (f) the purge guard names the new date
      SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.trials_due_for_purge()'::regprocedure;
      IF v_src NOT LIKE '%customization_ends_at%' THEN
        RAISE EXCEPTION 'S758 verify: trials_due_for_purge does not read customization_ends_at';
      END IF;
      -- (g) grants: anon must not hold EXECUTE on the DEFINER helper
      IF has_function_privilege('anon', 'public.customization_live(uuid)', 'EXECUTE') THEN
        RAISE EXCEPTION 'S758 verify: anon can execute customization_live';
      END IF;
      IF NOT has_function_privilege('authenticated', 'public.customization_live(uuid)', 'EXECUTE') THEN
        RAISE EXCEPTION 'S758 verify: authenticated cannot execute customization_live';
      END IF;

      RAISE EXCEPTION 's758_rollback' USING ERRCODE = 'P0758';
    END;
  EXCEPTION WHEN SQLSTATE 'P0758' THEN
    NULL; -- verification passed; the test rows are gone with the sub-transaction
  END;
END
$do$;
