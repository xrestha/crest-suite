-- A gate pass is fixed once issued, the parking slip's rule (S874; filed S809 1k in POS_TODO.md S809.3).
--
-- ims_gate_pass_void_guard (S756, S792) stamped who issued, let out and voided a pass, and left
-- three holes any IMS login of the outlet could reach over REST. The page sends none of them, so
-- nothing on screen changes:
--   * pass_no. trg_assign_ims_gate_pass_no numbers a pass only when pass_no IS NULL, and nothing
--     cleared a number the browser sent, so a caller could issue a second G-7 or skip ahead.
--   * Nothing behind it: no UNIQUE (client_id, pass_no).
--   * After issue the vendor, driver, vehicle number, purpose, notes, time in and print count all
--     stayed editable, so a printed pass could be made to say something else and the count set to
--     anything.
-- pos_parking_slips_guard closed the same three on the till (S814, S819 4k); this copies its rule.
--
-- Insert: the number, the times, the status and the print count come from the server, never the
-- tablet; the issuer is the signed-in login (S792). The operator's restore (restoreClientData)
-- re-inserts a pass as exported, dated when it was issued, so an admin insert dated in the past keeps
-- every column; one made from the issue screen is dated now() by the default and meets every rule.
-- BEFORE INSERT triggers fire in name order, so this guard clears pass_no before
-- trg_assign_ims_gate_pass_no numbers it.
--
-- Update: after issue a pass is only printed again (the count goes up by one, whatever the tablet
-- sent), marked exited or auto-closed (the server's time, the signed-in login or none), or voided
-- (supervisor+, as before; the server's time and login). A closed pass stays closed and its first
-- close stands; a voided pass stays as voided. A wrong detail is fixed the way the Void dialog already
-- says: void the pass and issue the next one. The operator meets these rules too; it keeps only the
-- rank exemption ims_caller_has_rank grants it.
--
-- Body: 20260928140000 (S792), md5 06049d97f207ae8b96b9bc4ccf75e244 (computed from that file; block 0
-- refuses to run if the live body differs). The whole file runs as one transaction.
--
-- Reverse: restore ims_gate_pass_void_guard from 20260928140000 and
-- ALTER TABLE public.ims_gate_passes DROP CONSTRAINT ims_gate_passes_client_pass_no_key.


-- ══ 0. The live body this was written against ═══════════════════════════════════════════════════

DO $$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.ims_gate_pass_void_guard()'::regprocedure;
  IF v_md5 IS DISTINCT FROM '06049d97f207ae8b96b9bc4ccf75e244' THEN
    RAISE EXCEPTION 'S874: ims_gate_pass_void_guard changed since this migration was written (live md5 %) — rebuild it from the live body', v_md5;
  END IF;
END;
$$;


-- ══ 1. One number per pass ══════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_dupes bigint;
BEGIN
  SELECT count(*) INTO v_dupes FROM (
    SELECT client_id, pass_no FROM public.ims_gate_passes
     WHERE pass_no IS NOT NULL GROUP BY client_id, pass_no HAVING count(*) > 1
  ) d;
  IF v_dupes > 0 THEN
    RAISE EXCEPTION 'S874: % gate pass numbers are used twice; settle them before the unique key', v_dupes;
  END IF;
  IF EXISTS (SELECT 1 FROM public.ims_gate_passes WHERE pass_no IS NULL) THEN
    RAISE EXCEPTION 'S874: a gate pass has no number';
  END IF;
END;
$$;

ALTER TABLE public.ims_gate_passes DROP CONSTRAINT IF EXISTS ims_gate_passes_client_pass_no_key;
ALTER TABLE public.ims_gate_passes ADD CONSTRAINT ims_gate_passes_client_pass_no_key UNIQUE (client_id, pass_no);


-- ══ 2. The guard ════════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.ims_gate_pass_void_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- The operator's restore, and nothing else it sends (the parking slip's S819 4k rule).
    IF COALESCE(public.is_admin(), false) AND COALESCE(NEW.created_at < now(), false) THEN
      RETURN NEW;
    END IF;
    -- Attribution the subject can choose is not attribution, and neither is a number.
    NEW.pass_no     := NULL;          -- numbered next by trg_assign_ims_gate_pass_no
    NEW.issued_by   := (select auth.uid());
    NEW.time_in     := now();
    NEW.created_at  := now();
    NEW.status      := 'open';
    NEW.time_out    := NULL;
    NEW.exited_by   := NULL;
    NEW.auto_closed := false;
    NEW.print_count := 0;
    NEW.voided_by   := NULL;
    NEW.voided_at   := NULL;
    NEW.void_reason := NULL;
    RETURN NEW;
  END IF;

  IF OLD.status = 'voided' THEN
    RAISE EXCEPTION 'ims_gate_passes: a voided gate pass cannot be changed'
      USING ERRCODE = '42501', HINT = 'ims_rank';
  END IF;
  -- After issue a pass is only printed again, marked exited or voided.
  IF (to_jsonb(NEW) - ARRAY['print_count', 'status', 'time_out', 'exited_by', 'auto_closed', 'voided_by', 'voided_at', 'void_reason'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['print_count', 'status', 'time_out', 'exited_by', 'auto_closed', 'voided_by', 'voided_at', 'void_reason']) THEN
    RAISE EXCEPTION 'ims_gate_passes: an issued gate pass cannot be rewritten; it can only be printed again, marked exited or voided'
      USING ERRCODE = '42501', HINT = 'ims_gate_pass_locked';
  END IF;
  IF NEW.status = 'voided' AND NOT COALESCE(public.ims_caller_has_rank('supervisor'), false) THEN
    RAISE EXCEPTION 'ims_gate_passes: voiding a gate pass needs an IMS supervisor, a manager or the account owner'
      USING ERRCODE = '42501', HINT = 'ims_rank';
  END IF;
  IF OLD.status = 'closed' AND NEW.status = 'open' THEN
    RAISE EXCEPTION 'ims_gate_passes: a closed gate pass stays closed'
      USING ERRCODE = '42501', HINT = 'ims_gate_pass_locked';
  END IF;

  -- A print is one more copy, whatever count the tablet last saw. It never goes back down.
  IF NEW.print_count IS DISTINCT FROM OLD.print_count THEN
    NEW.print_count := OLD.print_count + 1;
  END IF;

  IF NEW.status = 'voided' THEN
    NEW.voided_by := (select auth.uid());
    NEW.voided_at := now();
  ELSE
    NEW.voided_by   := OLD.voided_by;
    NEW.voided_at   := OLD.voided_at;
    NEW.void_reason := OLD.void_reason;
  END IF;

  IF OLD.status = 'open' AND NEW.status = 'closed' THEN
    NEW.time_out  := now();
    NEW.exited_by := CASE WHEN COALESCE(NEW.auto_closed, false) THEN NULL ELSE (select auth.uid()) END;
  ELSE
    -- No close yet, or the first close stands (a void keeps it).
    NEW.time_out    := OLD.time_out;
    NEW.exited_by   := OLD.exited_by;
    NEW.auto_closed := OLD.auto_closed;
  END IF;
  RETURN NEW;
END;
$$;


-- ══ 3. Probe: each rule acted out as the Owner and as the operator, rolled back ═════════════════

DO $$
DECLARE
  v_client uuid;
  v_owner  uuid;
  v_admin  uuid;
  v_next   integer;
  v_pass   uuid;
  v_row    record;
  v_refused boolean;
BEGIN
  SELECT c.id, p.id INTO v_client, v_owner
    FROM public.clients c JOIN public.profiles p ON p.client_id = c.id
   WHERE c.ims_enabled AND COALESCE(p.active_client_id, p.client_id) = c.id
     AND p.role = 'client' AND p.pos_role IS NULL AND p.pos_email IS NULL AND p.ims_role IS NULL
     AND p.ims_email IS NULL AND p.hr_role IS NULL AND NOT COALESCE(p.hr_self_service, false)
     AND p.settlement_blocked_by IS NULL
   ORDER BY (c.name = 'BLOOM CAFE') DESC, c.name, p.id LIMIT 1;
  SELECT p.id INTO v_admin FROM public.profiles p WHERE p.role = 'admin' ORDER BY p.id LIMIT 1;
  IF v_client IS NULL OR v_admin IS NULL THEN
    RAISE EXCEPTION 'S874 probe: no IMS outlet with an Owner, or no operator';
  END IF;
  SELECT COALESCE(max(pass_no), 0) + 1 INTO v_next FROM public.ims_gate_passes WHERE client_id = v_client;

  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_owner)::text, true);
    SET LOCAL ROLE authenticated;

    -- Issue: a sent number, status, times, count and issuer are all replaced.
    INSERT INTO public.ims_gate_passes
      (client_id, pass_no, vendor_name, driver_name, vehicle_number, purpose, status, time_in, print_count, issued_by)
    VALUES (v_client, 999999, 'S874 probe', 'Probe', 'PROBE 1', 'other', 'closed', '2001-01-01', 5, gen_random_uuid())
    RETURNING id INTO v_pass;
    SELECT pass_no, status, time_in, print_count, issued_by INTO v_row FROM public.ims_gate_passes WHERE id = v_pass;
    IF v_row.pass_no IS DISTINCT FROM v_next OR v_row.status IS DISTINCT FROM 'open' OR v_row.time_in IS DISTINCT FROM now()
       OR v_row.print_count <> 0 OR v_row.issued_by IS DISTINCT FROM v_owner THEN
      RAISE EXCEPTION 'S874 probe: an issued pass was kept as % / % / % / % / %',
        v_row.pass_no, v_row.status, v_row.time_in, v_row.print_count, v_row.issued_by;
    END IF;

    -- A detail cannot be rewritten.
    v_refused := false;
    BEGIN
      UPDATE public.ims_gate_passes SET vehicle_number = 'CHANGED' WHERE id = v_pass;
    EXCEPTION WHEN insufficient_privilege THEN v_refused := true;
    END;
    IF NOT v_refused THEN
      RAISE EXCEPTION 'S874 probe: a printed pass''s vehicle number was rewritten';
    END IF;

    -- A reprint counts one, whatever was sent.
    UPDATE public.ims_gate_passes SET print_count = 40 WHERE id = v_pass;
    SELECT print_count INTO v_row FROM public.ims_gate_passes WHERE id = v_pass;
    IF v_row.print_count <> 1 THEN
      RAISE EXCEPTION 'S874 probe: a reprint set the count to %', v_row.print_count;
    END IF;

    -- Marked exited: the server's time and the signed-in login.
    UPDATE public.ims_gate_passes SET status = 'closed', time_out = '2001-01-01', exited_by = gen_random_uuid() WHERE id = v_pass;
    SELECT status, time_out, exited_by INTO v_row FROM public.ims_gate_passes WHERE id = v_pass;
    IF v_row.status IS DISTINCT FROM 'closed' OR v_row.time_out IS DISTINCT FROM now() OR v_row.exited_by IS DISTINCT FROM v_owner THEN
      RAISE EXCEPTION 'S874 probe: the exit was kept as % / % / %', v_row.status, v_row.time_out, v_row.exited_by;
    END IF;

    -- A closed pass stays closed.
    v_refused := false;
    BEGIN
      UPDATE public.ims_gate_passes SET status = 'open' WHERE id = v_pass;
    EXCEPTION WHEN insufficient_privilege THEN v_refused := true;
    END;
    IF NOT v_refused THEN
      RAISE EXCEPTION 'S874 probe: a closed pass was reopened';
    END IF;

    -- Voided by the Owner: the server's time and login, the close kept.
    UPDATE public.ims_gate_passes
       SET status = 'voided', voided_at = '2001-01-01', voided_by = gen_random_uuid(), void_reason = 'S874 probe'
     WHERE id = v_pass;
    SELECT status, voided_at, voided_by, void_reason, time_out INTO v_row FROM public.ims_gate_passes WHERE id = v_pass;
    IF v_row.status IS DISTINCT FROM 'voided' OR v_row.voided_at IS DISTINCT FROM now() OR v_row.voided_by IS DISTINCT FROM v_owner
       OR v_row.void_reason IS DISTINCT FROM 'S874 probe' OR v_row.time_out IS DISTINCT FROM now() THEN
      RAISE EXCEPTION 'S874 probe: the void was kept as % / % / % / % / %',
        v_row.status, v_row.voided_at, v_row.voided_by, v_row.void_reason, v_row.time_out;
    END IF;
    v_refused := false;
    BEGIN
      UPDATE public.ims_gate_passes SET print_count = 2 WHERE id = v_pass;
    EXCEPTION WHEN insufficient_privilege THEN v_refused := true;
    END;
    IF NOT v_refused THEN
      RAISE EXCEPTION 'S874 probe: a voided pass was changed';
    END IF;

    -- The operator's restore keeps a pass as exported; the same number twice is refused.
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_admin)::text, true);
    INSERT INTO public.ims_gate_passes
      (client_id, pass_no, vendor_name, driver_name, vehicle_number, purpose, status, time_in, time_out, print_count, created_at)
    VALUES (v_client, 999998, 'S874 probe', 'Probe', 'PROBE 2', 'other', 'closed', now() - interval '10 days',
            now() - interval '10 days', 2, now() - interval '10 days')
    RETURNING id INTO v_pass;
    SELECT pass_no, status, print_count INTO v_row FROM public.ims_gate_passes WHERE id = v_pass;
    IF v_row.pass_no IS DISTINCT FROM 999998 OR v_row.status IS DISTINCT FROM 'closed' OR v_row.print_count <> 2 THEN
      RAISE EXCEPTION 'S874 probe: a restored pass came back as % / % / %', v_row.pass_no, v_row.status, v_row.print_count;
    END IF;
    v_refused := false;
    BEGIN
      INSERT INTO public.ims_gate_passes
        (client_id, pass_no, vendor_name, driver_name, vehicle_number, purpose, created_at)
      VALUES (v_client, 999998, 'S874 probe', 'Probe', 'PROBE 3', 'other', now() - interval '10 days');
    EXCEPTION WHEN unique_violation THEN v_refused := true;
    END;
    IF NOT v_refused THEN
      RAISE EXCEPTION 'S874 probe: two passes were saved under one number';
    END IF;
    PERFORM set_config('request.jwt.claims', '', true);

    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 's874_gate_probe_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 's874_gate_probe_rollback' THEN RAISE; END IF;
  END;
END;
$$;


-- ══ 4. What it acts on, live (the last statement, so `db query` prints it) ═══════════════════════
SELECT
  (SELECT count(*) FROM public.ims_gate_passes) AS gate_passes,
  (SELECT count(*) FROM public.ims_gate_passes WHERE status = 'open') AS open_passes,
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.ims_gate_pass_void_guard()'::regprocedure) AS guard_md5,
  (SELECT count(*) FROM pg_constraint WHERE conname = 'ims_gate_passes_client_pass_no_key' AND contype = 'u') AS unique_key;
