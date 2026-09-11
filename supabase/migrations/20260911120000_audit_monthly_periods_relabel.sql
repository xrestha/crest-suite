-- S738: audit a period RENAME, not only a status flip.
--
-- log_audit() returned NULL for every monthly_periods UPDATE where OLD.status = NEW.status, on
-- the reasoning that "only a status transition is audit-worthy". A change to bs_year/bs_month is
-- the opposite of noise: thirteen tables hang off monthly_periods by period_id, so relabelling
-- Bhadra to Ashwin moves that month's every purchase, sale, stock count, overhead, requisition and
-- attendance row into a different reporting month in one write — and it was the one write on the
-- Periods page that left no trace, while the benign open/closed flip was logged. The page now
-- confirms it; this makes it visible after the fact.
--
-- Full body reproduced from 20260910120000 (CREATE OR REPLACE cannot patch one line); the ONLY
-- change is the monthly_periods block, which now compares (status, bs_year, bs_month).

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

-- ── Verification ────────────────────────────────────────────────────────────────────────────
-- A plpgsql body is not validated at CREATE time, and this one ends in EXCEPTION WHEN OTHERS
-- THEN RETURN NULL -- so a typing error in the new comparison would not raise anywhere; it
-- would silently stop EVERY table's audit rows. The only test that tells the two apart is a real
-- UPDATE that must produce exactly one audit row. Done inside a savepoint (the inner BEGIN block)
-- and rolled back by a deliberate RAISE, so the period comes out unchanged. bs_year 9999 cannot
-- collide with monthly_periods_client_id_bs_year_bs_month_key. Skipped on an empty table.
DO $$
DECLARE
  v_id uuid;
  v_before bigint;
  v_after bigint;
BEGIN
  SELECT id INTO v_id FROM public.monthly_periods LIMIT 1;
  IF v_id IS NULL THEN RETURN; END IF;

  SELECT count(*) INTO v_before FROM public.audit_logs WHERE table_name = 'monthly_periods' AND record_id = v_id;
  BEGIN
    UPDATE public.monthly_periods SET bs_year = 9999 WHERE id = v_id;
    SELECT count(*) INTO v_after FROM public.audit_logs WHERE table_name = 'monthly_periods' AND record_id = v_id;
    IF v_after <> v_before + 1 THEN
      RAISE EXCEPTION 'log_audit did not record a monthly_periods relabel (before %, after %)', v_before, v_after;
    END IF;
    -- A same-label update must still be skipped, or every projection write floods the log.
    UPDATE public.monthly_periods SET bs_year = 9999 WHERE id = v_id;
    SELECT count(*) INTO v_after FROM public.audit_logs WHERE table_name = 'monthly_periods' AND record_id = v_id;
    IF v_after <> v_before + 1 THEN
      RAISE EXCEPTION 'log_audit recorded a no-op monthly_periods update';
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 's738_probe_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 's738_probe_rollback' THEN RAISE; END IF;
  END;
END $$;

NOTIFY pgrst, 'reload schema';

-- Run by hand after applying, and read the result -- rename an OPEN period on Periods, then:
--
--   SELECT action, old_data->>'bs_month', new_data->>'bs_month', created_at
--   FROM public.audit_logs WHERE table_name = 'monthly_periods' ORDER BY created_at DESC LIMIT 3;
--   -- expect: the rename as an UPDATE row with the two months differing
