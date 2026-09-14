-- S745: Audit Log re-analysed. Two server-side defects, one of them destructive.
--
-- ── 1. "Clear Logs" deleted the NEWEST entries ────────────────────────────────────────────────
-- admin_clear_audit_logs(p_client_id, p_table_name, p_cutoff) deleted `created_at >= p_cutoff`,
-- and the page passed its time filter as that cutoff. So "Last 7 days" + Clear Logs erased the
-- most recent week of the trail -- precisely the window someone covering a change would want gone
-- -- while leaving the old entries a retention clear exists to remove. "All time" erased every
-- tenant's history in one call. The clear itself left no trace, and it could take the PIN-reveal
-- rows admin-user-ops writes (table_name 'staff_pin_vault', action 'VIEW') with it.
--
-- Decision (Aashish, 2026-09-14): old entries only. admin_purge_audit_logs(p_older_than_days,
-- p_client_id) deletes rows OLDER than a window of at least 90 days, the cutoff is computed HERE
-- from now() so no caller can hand in a recent one, and every purge writes its own audit row
-- (who, scope, cutoff, how many) in the same transaction. The old function is DROPPED, not
-- revoked: a cached bundle still calling it should fail loudly rather than reach a body that
-- deletes recent history.
--
-- ── 2. Deleting a client was never recorded ───────────────────────────────────────────────────
-- log_audit() is an AFTER trigger, and on `DELETE FROM clients` it inserted an audit row whose
-- client_id is the row just deleted. audit_logs.client_id REFERENCES clients(id), a non-deferred
-- FK, so the insert failed -- and the body ends in EXCEPTION WHEN OTHERS THEN RETURN NULL, so the
-- failure vanished. The same happens to any child row removed by a cascade after its client is
-- gone. Admin -> Clients -> Delete, the trial purge job and every such cascade left no entry, on
-- the one screen whose help table promised "Client Account: Add · Edit · Delete".
--
-- Fix: resolve the client once; if the row no longer exists, write client_id NULL and keep the
-- name (clients carries it on OLD; record_id still names the deleted client's id). Full body
-- reproduced from 20260911120000 -- CREATE OR REPLACE cannot patch one block -- and the ONLY change
-- is that lookup, which replaces the old `IF _client_id IS NOT NULL AND _client_name IS NULL`.

CREATE OR REPLACE FUNCTION public.log_audit() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'auth'
    AS $$
DECLARE
  _client_id uuid; _client_name text; _user_id uuid; _user_name text; _record_id uuid;
  _old jsonb; _new jsonb; _found_name text;
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

  -- monthly_periods: a status transition (open/closed) OR a relabel (bs_year/bs_month) is
  -- audit-worthy; a rename moves every period-scoped row into a different reporting month (S738).
  -- Anything else on the row (created_at, projection columns) is not.
  IF TG_TABLE_NAME = 'monthly_periods' AND TG_OP = 'UPDATE' THEN
    IF (OLD.status, OLD.bs_year, OLD.bs_month) IS NOT DISTINCT FROM (NEW.status, NEW.bs_year, NEW.bs_month)
    THEN RETURN NULL; END IF;
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

  -- S745: the client may already be gone -- this is an AFTER trigger, so on DELETE FROM clients
  -- (and on any cascade that follows it) the referenced row no longer exists, audit_logs'
  -- client_id FK refuses the insert, and the handler below swallows that. Keep the entry: NULL
  -- the reference, keep whatever name is known.
  IF _client_id IS NOT NULL THEN
    SELECT name INTO _found_name FROM clients WHERE id = _client_id;
    IF NOT FOUND THEN
      _client_id := NULL;
    ELSIF _client_name IS NULL THEN
      _client_name := _found_name;
    END IF;
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

-- ── The purge ─────────────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.admin_clear_audit_logs(uuid, text, timestamp with time zone);

CREATE OR REPLACE FUNCTION public.admin_purge_audit_logs(
    p_older_than_days integer,
    p_client_id uuid DEFAULT NULL::uuid
) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_cutoff timestamptz;
  v_deleted integer;
  v_user uuid := auth.uid();
  v_user_name text;
  v_client_name text;
  v_client_ref uuid;
BEGIN
  -- COALESCE: is_admin() is NULL for a session with no profiles row, and IF NOT NULL never fires (S630).
  IF NOT COALESCE(public.is_admin(), false) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  -- The floor is the whole point of this function. NULL is refused explicitly: `NULL < 90` is NULL
  -- and would slip past a bare comparison.
  IF p_older_than_days IS NULL OR p_older_than_days < 90 THEN
    RAISE EXCEPTION 'audit_purge_window_too_short' USING HINT = 'Only entries older than 90 days can be deleted.';
  END IF;

  v_cutoff := now() - make_interval(days => p_older_than_days);

  DELETE FROM audit_logs
  WHERE created_at < v_cutoff
    AND (p_client_id IS NULL OR client_id = p_client_id);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  -- The purge records itself, in the same transaction, so a deletion from the trail is never
  -- invisible on the trail. Its own row is newer than any cutoff, so no later purge within the
  -- window can remove it.
  SELECT full_name INTO v_user_name FROM profiles WHERE id = v_user;
  SELECT id, name INTO v_client_ref, v_client_name FROM clients WHERE id = p_client_id;

  INSERT INTO audit_logs (client_id, client_name, user_id, user_name, table_name, action, record_id, old_data, new_data)
  VALUES (v_client_ref, v_client_name, v_user, v_user_name, 'audit_logs', 'PURGE', NULL, NULL,
          jsonb_build_object(
            'older_than_days', p_older_than_days,
            'cutoff',          v_cutoff,
            'scope',           CASE WHEN p_client_id IS NULL THEN 'all clients' ELSE coalesce(v_client_name, p_client_id::text) END,
            'deleted',         v_deleted));

  RETURN v_deleted;
END;
$$;

-- anon named as well as PUBLIC: a revoke from PUBLIC does nothing to a role holding its own grant,
-- and Supabase's default privileges can hand one to anon on a new function.
REVOKE ALL ON FUNCTION public.admin_purge_audit_logs(integer, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_purge_audit_logs(integer, uuid) TO authenticated, service_role;

-- ── Verification ────────────────────────────────────────────────────────────────────────────
-- log_audit() ends in EXCEPTION WHEN OTHERS THEN RETURN NULL, so a fault in the new lookup would
-- silently stop EVERY table's audit rows. Only real writes tell the two apart. Everything below
-- runs inside a subtransaction rolled back by a deliberate RAISE, so nothing persists.
DO $$
DECLARE
  v_probe uuid;
  v_row record;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'admin_clear_audit_logs' AND pronamespace = 'public'::regnamespace) THEN
    RAISE EXCEPTION 'admin_clear_audit_logs still exists';
  END IF;
  IF has_function_privilege('anon', 'public.admin_purge_audit_logs(integer, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute admin_purge_audit_logs';
  END IF;

  BEGIN
    -- A client created and deleted: both writes must leave a row, and the DELETE row must carry
    -- the name with a NULL reference (the FK would refuse anything else).
    INSERT INTO public.clients (name) VALUES ('s745 audit probe') RETURNING id INTO v_probe;
    DELETE FROM public.clients WHERE id = v_probe;

    SELECT * INTO v_row FROM public.audit_logs
     WHERE table_name = 'clients' AND action = 'DELETE' AND record_id = v_probe;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'log_audit did not record a client DELETE';
    END IF;
    IF v_row.client_id IS NOT NULL OR v_row.client_name IS DISTINCT FROM 's745 audit probe' THEN
      RAISE EXCEPTION 'client DELETE row has client_id %, client_name %', v_row.client_id, v_row.client_name;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.audit_logs WHERE table_name = 'clients' AND action = 'INSERT' AND record_id = v_probe) THEN
      RAISE EXCEPTION 'log_audit did not record a client INSERT (the ordinary path is broken)';
    END IF;

    -- The purge must refuse a caller with no admin profile (the migration runs with auth.uid() NULL),
    -- and must refuse a short window even before that matters to anyone reading this.
    BEGIN
      PERFORM public.admin_purge_audit_logs(365, NULL);
      RAISE EXCEPTION 's745_purge_guard_open';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM = 's745_purge_guard_open' THEN RAISE EXCEPTION 'admin_purge_audit_logs ran for a caller with no profile'; END IF;
    END;

    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 's745_probe_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 's745_probe_rollback' THEN RAISE; END IF;
  END;
END $$;

NOTIFY pgrst, 'reload schema';
