-- S837 — kitchen and bar printers: a ticket for a station prints on a print device at the restaurant
-- instead of the till's own print window, whenever one is online for that station.
--
-- Owner decision (Aashish, 2026-10-14): both a "print station page" (Chrome on the counter PC prints
-- through Windows) and a "Crest Print Helper" program (sends tickets straight to network printers),
-- on one ticket queue. Every POS client gets it; reprints, VOID and MOVE slips go to the station's
-- printer too; the till prints itself whenever no device is online. The contract the till, the page
-- and the helper are written to is docs/kitchen-printers.md.
--
-- Sections:
--   (1) pos_print_devices, pos_print_jobs, pos_print_pair_attempts: locked to every client role
--   (2) helpers: the pairing code, the audit row, input cleaning, the job state, the till caller test
--   (3) manager: create / update / pair code / remove / test print / the two lists
--   (4) till: routes / queue / status / Print here
--   (5) print device (anon): pair / poll / report
--   (6) the nightly purge
--   (7) catalog assertions
--   (8) the probe, rolled back
--
-- DEPLOY ORDER: this file, then admin-user-ops (Danger Zone clears the new tables, Archive switches
-- print devices off), then the frontend. A till on the new release whose database lacks these
-- functions reads "no printer computer" and prints itself, so the order is safe either way round.
--
-- ── Decisions ──────────────────────────────────────────────────────────────────────────────────
-- * THE pos_devices SHAPE, ON PURPOSE. A device secret is 244 bits of CSPRNG output hashed with plain
--   SHA-256 (pos_device_secret_hash, 20260916120000 explains why no pepper); the raw secret is
--   returned once, by the pairing, and exists nowhere on the server after it. Neither table has a
--   client grant or a policy: Postgres has no column-level RLS, so an Owner's SELECT policy would
--   show secret_hash. Every read and write goes through the functions below, each with its own caller
--   test. RLS is still on, so a grant added by mistake opens nothing.
-- * PAIRING BY A ONE-TIME CODE, NOT BY A MANAGER SIGNING IN ON THE COUNTER PC. A manager's session
--   left open on a shared computer is a manager's session; a print device holds a credential that
--   can do exactly three things: collect its own station's tickets, say they printed, and say why
--   one failed. The code is 8 characters from a 32-letter alphabet (40 bits), good for 15 minutes,
--   single use, and a pairing address gets 10 tries per 15 minutes (the S822 trusted-hop rule).
-- * THE TILL BUILDS THE PAPER; THE DEVICE ONLY RENDERS IT. A job carries the slip as a document
--   (docs/kitchen-printers.md), so the kitchen gets exactly what the till would have printed — the
--   "+1", the "↓1 (now 2)", a CHANGE line — none of which pos_kot_log records. The content is the
--   till's to choose, as it always was on the till's own printer; any POS login of the outlet could
--   print anything there before this release. The table bounds its size (300 lines, 32 KB).
-- * NO CHANGE TO pos_kot_log OR ITS GUARD. The queue is its own table, so the KDS, the KOT Register
--   and every count of tickets are untouched, and a till on an older release (which never queues)
--   keeps printing itself. No till floor raise.
-- * WHO PRINTED IS SETTLED BY THE ROW, NOT BY THE CLIENTS. A device claims jobs FOR UPDATE SKIP
--   LOCKED, a claim lapses after 60 s (a device that died mid-job), the till's Print here marks the
--   job printed in one statement or is told a device has it, and a job queued over 15 minutes ago is
--   never printed automatically. Five failures stop the retries; the till's banner offers Print here.
-- * pos_print_jobs.created_by AND printed_by_till HOLD A LOGIN'S ID WITH NO FOREIGN KEY. The queue is
--   purged after 7 days and never shows who queued a job, so a key would only make every waiter's
--   login "a login with records" (pos_login_reference_columns counts every key to a login) for a
--   week. pos_print_devices keeps real keys (ON DELETE SET NULL, worded in admin-user-ops).
-- * NOT EXPORTED, NOT RESTORED (pos_devices' precedent): a device credential must not be restorable
--   into a working state, and the queue is minutes-long. Delete Client cascades both tables; Danger
--   Zone's POS clear deletes the jobs; Archive revokes the devices (admin-user-ops).

-- ── (1) Tables ─────────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.pos_print_devices (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id            uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  name                 text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  kind                 text NOT NULL CHECK (kind IN ('page', 'helper')),
  stations             text[] NOT NULL DEFAULT '{}' CHECK (stations <@ ARRAY['KOT', 'BOT']::text[]),
  -- The helper's printers, one per station ({station, host, port, width}); '[]' for a page.
  printers             jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(printers) = 'array'),
  -- Lowercase hex SHA-256 of the raw secret; NULL until the first pairing. UNIQUE so no two share one.
  secret_hash          text UNIQUE CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
  pair_code_hash       text UNIQUE CHECK (pair_code_hash ~ '^[0-9a-f]{64}$'),
  pair_code_expires_at timestamptz,
  paired_at            timestamptz,
  -- Stamped by the poll at most every 5 s; online = within 20 s.
  last_seen_at         timestamptz,
  app_version          text CHECK (char_length(app_version) <= 40),
  status               jsonb,
  last_error           text CHECK (char_length(last_error) <= 200),
  last_error_at        timestamptz,
  created_by           uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  revoked_at           timestamptz,
  revoked_by           uuid REFERENCES public.profiles(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS pos_print_devices_client_idx ON public.pos_print_devices (client_id) WHERE revoked_at IS NULL;

ALTER TABLE public.pos_print_devices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pos_print_devices FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pos_print_devices TO service_role;

CREATE TABLE IF NOT EXISTS public.pos_print_jobs (
  -- Minted by the till, so a queue call retried after a lost answer cannot queue twice.
  id                uuid PRIMARY KEY,
  client_id         uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  station           text NOT NULL CHECK (station IN ('KOT', 'BOT')),
  kind              text NOT NULL CHECK (kind IN ('ticket', 'reprint', 'void', 'move', 'test')),
  doc               jsonb NOT NULL CHECK (CASE WHEN jsonb_typeof(doc) = 'object' AND jsonb_typeof(doc -> 'lines') = 'array'
                                               THEN jsonb_array_length(doc -> 'lines') <= 300 AND octet_length(doc::text) <= 32768
                                               ELSE false END),
  label             text CHECK (char_length(label) <= 80),
  target_device_id  uuid REFERENCES public.pos_print_devices(id) ON DELETE CASCADE,
  created_by        uuid,   -- a login's id, no key (see Decisions)
  created_at        timestamptz NOT NULL DEFAULT now(),
  claimed_by        uuid REFERENCES public.pos_print_devices(id) ON DELETE SET NULL,
  claimed_at        timestamptz,
  printed_at        timestamptz,
  printed_via       text CHECK (printed_via IN ('device', 'till')),
  printed_by_device uuid REFERENCES public.pos_print_devices(id) ON DELETE SET NULL,
  printed_by_till   uuid,   -- a login's id, no key (see Decisions)
  fail_count        integer NOT NULL DEFAULT 0 CHECK (fail_count >= 0),
  fail_reason       text CHECK (char_length(fail_reason) <= 200),
  failed_at         timestamptz,
  CONSTRAINT pos_print_jobs_printed_pair CHECK (COALESCE((printed_at IS NULL) = (printed_via IS NULL), false))
);
-- The poll's claim and the waiting count read unprinted jobs by outlet and age; the lists read the newest.
CREATE INDEX IF NOT EXISTS pos_print_jobs_waiting_idx ON public.pos_print_jobs (client_id, created_at) WHERE printed_at IS NULL;
CREATE INDEX IF NOT EXISTS pos_print_jobs_recent_idx  ON public.pos_print_jobs (client_id, created_at DESC);

ALTER TABLE public.pos_print_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pos_print_jobs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pos_print_jobs TO service_role;

CREATE TABLE IF NOT EXISTS public.pos_print_pair_attempts (
  id         bigserial PRIMARY KEY,
  ip         text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pos_print_pair_attempts_ip_idx ON public.pos_print_pair_attempts (ip, created_at);

ALTER TABLE public.pos_print_pair_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pos_print_pair_attempts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.pos_print_pair_attempts TO service_role;

-- ── (2) Helpers ────────────────────────────────────────────────────────────────────────────────

-- 8 characters from a 32-letter alphabet with no I, O, 0 or 1. uuid_send gives 16 CSPRNG bytes
-- (gen_random_uuid is pg_strong_random on PG 13+); bytes 6 and 8 carry the version and variant bits,
-- so the code is drawn from others. 256 is a multiple of 32, so every letter is equally likely.
CREATE OR REPLACE FUNCTION public.pos_print_new_code()
RETURNS text
LANGUAGE plpgsql VOLATILE
SET search_path TO 'public'
AS $$
DECLARE
  v_alpha text  := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_bytes bytea := uuid_send(gen_random_uuid());
  v_code  text  := '';
  i       integer;
BEGIN
  FOREACH i IN ARRAY ARRAY[0, 1, 2, 3, 4, 5, 9, 10] LOOP
    v_code := v_code || substr(v_alpha, (get_byte(v_bytes, i) % 32) + 1, 1);
  END LOOP;
  RETURN v_code;
END;
$$;
REVOKE ALL ON FUNCTION public.pos_print_new_code() FROM PUBLIC, anon, authenticated;

-- What a person typed, as the code was drawn: spaces, dashes and case ignored.
CREATE OR REPLACE FUNCTION public.pos_print_code_clean(p_code text)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path TO 'public'
AS $$
  SELECT upper(regexp_replace(COALESCE(p_code, ''), '[^A-Za-z0-9]', '', 'g'))
$$;
REVOKE ALL ON FUNCTION public.pos_print_code_clean(text) FROM PUBLIC, anon, authenticated;

-- The audit row log_audit() would have written, minus both hashes (pos_devices_audit's shape).
CREATE OR REPLACE FUNCTION public.pos_print_devices_audit(p_action text, p_old public.pos_print_devices, p_new public.pos_print_devices)
RETURNS void
LANGUAGE sql VOLATILE
SET search_path TO 'public'
AS $$
  INSERT INTO audit_logs (client_id, client_name, user_id, user_name, table_name, action, record_id, old_data, new_data)
  SELECT c.id, c.name, (select auth.uid()),
         (SELECT pr.full_name FROM profiles pr WHERE pr.id = (select auth.uid())),
         'pos_print_devices', p_action, COALESCE(p_new.id, p_old.id),
         CASE WHEN p_old.id IS NULL THEN NULL ELSE to_jsonb(p_old) - 'secret_hash' - 'pair_code_hash' - 'status' END,
         CASE WHEN p_new.id IS NULL THEN NULL ELSE to_jsonb(p_new) - 'secret_hash' - 'pair_code_hash' - 'status' END
    FROM clients c
   WHERE c.id = COALESCE(p_new.client_id, p_old.client_id)
$$;
REVOKE ALL ON FUNCTION public.pos_print_devices_audit(text, public.pos_print_devices, public.pos_print_devices) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.pos_print_clean_stations(p_stations text[])
RETURNS text[]
LANGUAGE plpgsql IMMUTABLE
SET search_path TO 'public'
AS $$
DECLARE
  v text[];
BEGIN
  SELECT COALESCE(array_agg(DISTINCT s ORDER BY s DESC), '{}') INTO v FROM unnest(COALESCE(p_stations, '{}')) s;
  IF cardinality(v) = 0 OR NOT (v <@ ARRAY['KOT', 'BOT']::text[]) THEN
    RAISE EXCEPTION 'pos_print_stations_invalid' USING ERRCODE = '22023',
      HINT = 'Choose Kitchen, Bar or both.';
  END IF;
  RETURN v;
END;
$$;
REVOKE ALL ON FUNCTION public.pos_print_clean_stations(text[]) FROM PUBLIC, anon, authenticated;

-- A helper's printers: one per station it prints, at a private IPv4 address. A helper sends bytes to
-- whatever address this names, so it is held to the restaurant's own network. A page has none.
CREATE OR REPLACE FUNCTION public.pos_print_clean_printers(p_kind text, p_stations text[], p_printers jsonb)
RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE
SET search_path TO 'public'
AS $$
DECLARE
  e         jsonb;
  v_out     jsonb  := '[]'::jsonb;
  v_seen    text[] := '{}';
  v_station text;
  v_host    text;
  v_ip      inet;
  v_port    integer;
  v_width   integer;
BEGIN
  IF p_kind = 'page' THEN
    RETURN '[]'::jsonb;
  END IF;
  IF p_printers IS NULL OR jsonb_typeof(p_printers) <> 'array' OR jsonb_array_length(p_printers) > 2 THEN
    RAISE EXCEPTION 'pos_print_printers_invalid' USING ERRCODE = '22023',
      HINT = 'Give one printer address for each station this helper prints.';
  END IF;
  FOR e IN SELECT x FROM jsonb_array_elements(p_printers) x LOOP
    v_station := CASE WHEN jsonb_typeof(e) = 'object' THEN e ->> 'station' END;
    IF v_station IS NULL OR NOT (v_station = ANY (p_stations)) OR v_station = ANY (v_seen) THEN
      RAISE EXCEPTION 'pos_print_printers_invalid' USING ERRCODE = '22023',
        HINT = 'Give one printer address for each station this helper prints.';
    END IF;
    v_host := btrim(COALESCE(e ->> 'host', ''));
    v_ip := NULL;
    IF v_host ~ '^[0-9]{1,3}(\.[0-9]{1,3}){3}$' THEN
      BEGIN
        v_ip := v_host::inet;
      EXCEPTION WHEN OTHERS THEN
        v_ip := NULL;
      END;
    END IF;
    IF NOT COALESCE(v_ip <<= '10.0.0.0/8'::inet OR v_ip <<= '172.16.0.0/12'::inet OR v_ip <<= '192.168.0.0/16'::inet, false) THEN
      RAISE EXCEPTION 'pos_print_printer_address_invalid' USING ERRCODE = '22023',
        HINT = 'A printer''s address on the restaurant network looks like 192.168.1.50. Its self-test page shows it.';
    END IF;
    v_port := CASE WHEN COALESCE(e ->> 'port', '') = '' THEN 9100
                   WHEN e ->> 'port' ~ '^[0-9]{1,5}$' THEN (e ->> 'port')::integer
                   ELSE 0 END;
    IF v_port NOT BETWEEN 1 AND 65535 THEN
      RAISE EXCEPTION 'pos_print_printer_port_invalid' USING ERRCODE = '22023',
        HINT = 'A receipt printer''s port is usually 9100.';
    END IF;
    v_width := CASE WHEN COALESCE(e ->> 'width', '') = '' THEN 80
                    WHEN e ->> 'width' ~ '^[0-9]{2}$' THEN (e ->> 'width')::integer
                    ELSE 0 END;
    IF v_width NOT IN (58, 80) THEN
      RAISE EXCEPTION 'pos_print_printer_width_invalid' USING ERRCODE = '22023',
        HINT = 'Receipt paper is 80 mm or 58 mm wide.';
    END IF;
    v_seen := v_seen || v_station;
    v_out := v_out || jsonb_build_array(jsonb_build_object('station', v_station, 'host', host(v_ip), 'port', v_port, 'width', v_width));
  END LOOP;
  IF NOT (p_stations <@ v_seen) THEN
    RAISE EXCEPTION 'pos_print_printers_invalid' USING ERRCODE = '22023',
      HINT = 'Give one printer address for each station this helper prints.';
  END IF;
  RETURN v_out;
END;
$$;
REVOKE ALL ON FUNCTION public.pos_print_clean_printers(text, text[], jsonb) FROM PUBLIC, anon, authenticated;

-- The table's own doc rule, as a test a function can ask before inserting, so a refusal is worded.
CREATE OR REPLACE FUNCTION public.pos_print_doc_ok(p_doc jsonb)
RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path TO 'public'
AS $$
  SELECT CASE WHEN jsonb_typeof(p_doc) = 'object' AND jsonb_typeof(p_doc -> 'lines') = 'array'
              THEN jsonb_array_length(p_doc -> 'lines') <= 300 AND octet_length(p_doc::text) <= 32768
              ELSE false END
$$;
REVOKE ALL ON FUNCTION public.pos_print_doc_ok(jsonb) FROM PUBLIC, anon, authenticated;

-- docs/kitchen-printers.md "Job state", in that order.
CREATE OR REPLACE FUNCTION public.pos_print_job_state(j public.pos_print_jobs)
RETURNS text
LANGUAGE sql STABLE
SET search_path TO 'public'
AS $$
  SELECT CASE
           WHEN j.printed_at IS NOT NULL THEN 'printed'
           WHEN j.claimed_by IS NOT NULL AND j.claimed_at > now() - interval '60 seconds' THEN 'printing'
           WHEN j.fail_count >= 5 THEN 'failed'
           WHEN j.created_at < now() - interval '15 minutes' THEN 'expired'
           WHEN j.fail_count > 0 THEN 'retrying'
           ELSE 'waiting'
         END
$$;
REVOKE ALL ON FUNCTION public.pos_print_job_state(public.pos_print_jobs) FROM PUBLIC, anon, authenticated;

-- A till of this outlet: admin, or a login of THIS client (outlet-aware) holding a POS rank, which
-- covers the Owner and leaves out a settlement-blocked or POS-blocked login (pos_caller_has_rank).
-- Every operand COALESCE'd, so a profile-less caller is refused rather than let through (S630).
CREATE OR REPLACE FUNCTION public.pos_print_caller_is_till(p_client_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE(public.is_admin(), false)
      OR COALESCE(p_client_id IS NOT NULL AND p_client_id = public.my_client_id() AND public.pos_caller_has_rank('staff'), false)
$$;
REVOKE ALL ON FUNCTION public.pos_print_caller_is_till(uuid) FROM PUBLIC, anon, authenticated;

-- A live, paired device for this id and secret, or nothing.
CREATE OR REPLACE FUNCTION public.pos_print_device_by_key(p_device_id uuid, p_secret text)
RETURNS SETOF public.pos_print_devices
LANGUAGE sql STABLE
SET search_path TO 'public'
AS $$
  SELECT d.*
    FROM pos_print_devices d
   WHERE p_device_id IS NOT NULL AND p_secret IS NOT NULL
     AND d.id = p_device_id
     AND d.revoked_at IS NULL
     AND d.secret_hash IS NOT NULL
     AND d.secret_hash = public.pos_device_secret_hash(p_secret)
$$;
REVOKE ALL ON FUNCTION public.pos_print_device_by_key(uuid, text) FROM PUBLIC, anon, authenticated;

-- ── (3) Manager: Owner, admin, or a POS manager of the outlet (pos_device_caller_may_manage) ──

CREATE OR REPLACE FUNCTION public.create_pos_print_device(p_client_id uuid, p_name text, p_kind text, p_stations text[], p_printers jsonb)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_name     text := btrim(COALESCE(p_name, ''));
  v_stations text[];
  v_printers jsonb;
  v_code     text;
  v_row      pos_print_devices;
  v_try      integer := 0;
BEGIN
  IF p_client_id IS NULL OR NOT public.pos_device_caller_may_manage(p_client_id) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  IF char_length(v_name) NOT BETWEEN 1 AND 60 THEN
    RAISE EXCEPTION 'pos_print_device_name_invalid' USING ERRCODE = '22023',
      HINT = 'Give the printer computer a name of 1 to 60 characters, e.g. "Counter PC".';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('page', 'helper') THEN
    RAISE EXCEPTION 'pos_print_device_kind_invalid' USING ERRCODE = '22023',
      HINT = 'Choose the print station page or the Crest Print Helper.';
  END IF;
  v_stations := public.pos_print_clean_stations(p_stations);
  v_printers := public.pos_print_clean_printers(p_kind, v_stations, p_printers);
  -- A ceiling no real restaurant reaches; it bounds what a compromised manager session can mint.
  IF (SELECT count(*) FROM pos_print_devices WHERE client_id = p_client_id AND revoked_at IS NULL) >= 20 THEN
    RAISE EXCEPTION 'pos_print_device_limit' USING ERRCODE = '54000',
      HINT = 'This restaurant already has 20 printer computers. Remove one that is no longer used.';
  END IF;

  LOOP
    v_try  := v_try + 1;
    v_code := public.pos_print_new_code();
    BEGIN
      INSERT INTO pos_print_devices (client_id, name, kind, stations, printers, pair_code_hash, pair_code_expires_at, created_by)
      VALUES (p_client_id, v_name, p_kind, v_stations, v_printers, public.pos_device_secret_hash(v_code),
              now() + interval '15 minutes', (select auth.uid()))
      RETURNING * INTO v_row;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      -- Another device holds the same code (1 in 2^40 per pair): draw again.
      IF v_try >= 5 THEN RAISE; END IF;
    END;
  END LOOP;

  PERFORM public.pos_print_devices_audit('INSERT', NULL::pos_print_devices, v_row);
  RETURN jsonb_build_object('device_id', v_row.id, 'pair_code', v_code, 'pair_code_expires_at', v_row.pair_code_expires_at);
END;
$$;
REVOKE ALL ON FUNCTION public.create_pos_print_device(uuid, text, text, text[], jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_pos_print_device(uuid, text, text, text[], jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.update_pos_print_device(p_device_id uuid, p_name text, p_stations text[], p_printers jsonb)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_old  pos_print_devices;
  v_new  pos_print_devices;
  v_name text := btrim(COALESCE(p_name, ''));
  v_stations text[];
BEGIN
  SELECT * INTO v_old FROM pos_print_devices WHERE id = p_device_id FOR UPDATE;
  -- Absent and not-yours read the same, so the refusal is not an oracle for another client's ids.
  IF NOT FOUND OR NOT public.pos_device_caller_may_manage(v_old.client_id) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  IF v_old.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'pos_print_device_removed' USING ERRCODE = '22023',
      HINT = 'This printer computer was removed. Add it again.';
  END IF;
  IF char_length(v_name) NOT BETWEEN 1 AND 60 THEN
    RAISE EXCEPTION 'pos_print_device_name_invalid' USING ERRCODE = '22023',
      HINT = 'Give the printer computer a name of 1 to 60 characters, e.g. "Counter PC".';
  END IF;
  v_stations := public.pos_print_clean_stations(p_stations);

  UPDATE pos_print_devices
     SET name = v_name,
         stations = v_stations,
         printers = public.pos_print_clean_printers(v_old.kind, v_stations, p_printers)
   WHERE id = p_device_id
  RETURNING * INTO v_new;

  -- A station taken off this device: the jobs it holds for it go back to waiting for another one.
  UPDATE pos_print_jobs
     SET claimed_by = NULL, claimed_at = NULL
   WHERE claimed_by = p_device_id AND printed_at IS NULL AND NOT (station = ANY (v_stations)) AND target_device_id IS NULL;

  PERFORM public.pos_print_devices_audit('UPDATE', v_old, v_new);
END;
$$;
REVOKE ALL ON FUNCTION public.update_pos_print_device(uuid, text, text[], jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_pos_print_device(uuid, text, text[], jsonb) TO authenticated, service_role;

-- A fresh code for a device: its first pairing, or moving it to another computer. The current
-- pairing keeps printing until the new code is used, so issuing one mid-service changes nothing.
CREATE OR REPLACE FUNCTION public.issue_pos_print_pair_code(p_device_id uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_old  pos_print_devices;
  v_new  pos_print_devices;
  v_code text;
  v_try  integer := 0;
BEGIN
  SELECT * INTO v_old FROM pos_print_devices WHERE id = p_device_id FOR UPDATE;
  IF NOT FOUND OR NOT public.pos_device_caller_may_manage(v_old.client_id) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  IF v_old.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'pos_print_device_removed' USING ERRCODE = '22023',
      HINT = 'This printer computer was removed. Add it again.';
  END IF;

  LOOP
    v_try  := v_try + 1;
    v_code := public.pos_print_new_code();
    BEGIN
      UPDATE pos_print_devices
         SET pair_code_hash = public.pos_device_secret_hash(v_code),
             pair_code_expires_at = now() + interval '15 minutes'
       WHERE id = p_device_id
      RETURNING * INTO v_new;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      IF v_try >= 5 THEN RAISE; END IF;
    END;
  END LOOP;

  PERFORM public.pos_print_devices_audit('UPDATE', v_old, v_new);
  RETURN jsonb_build_object('pair_code', v_code, 'pair_code_expires_at', v_new.pair_code_expires_at);
END;
$$;
REVOKE ALL ON FUNCTION public.issue_pos_print_pair_code(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.issue_pos_print_pair_code(uuid) TO authenticated, service_role;

-- Idempotent, like revoke_pos_device. A removed device cannot be brought back: it is added again,
-- which issues a new code. Its claimed jobs go back to waiting, so another device or the till's
-- Print here takes them.
CREATE OR REPLACE FUNCTION public.remove_pos_print_device(p_device_id uuid)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_old pos_print_devices;
  v_new pos_print_devices;
BEGIN
  SELECT * INTO v_old FROM pos_print_devices WHERE id = p_device_id FOR UPDATE;
  IF NOT FOUND OR NOT public.pos_device_caller_may_manage(v_old.client_id) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  IF v_old.revoked_at IS NOT NULL THEN
    RETURN;
  END IF;

  UPDATE pos_print_devices
     SET revoked_at = now(), revoked_by = (select auth.uid()),
         pair_code_hash = NULL, pair_code_expires_at = NULL
   WHERE id = p_device_id
  RETURNING * INTO v_new;

  UPDATE pos_print_jobs
     SET claimed_by = NULL, claimed_at = NULL
   WHERE claimed_by = p_device_id AND printed_at IS NULL;

  PERFORM public.pos_print_devices_audit('UPDATE', v_old, v_new);
END;
$$;
REVOKE ALL ON FUNCTION public.remove_pos_print_device(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remove_pos_print_device(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.send_pos_print_test(p_device_id uuid, p_station text, p_doc jsonb)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_dev pos_print_devices;
  v_id  uuid := gen_random_uuid();
BEGIN
  SELECT * INTO v_dev FROM pos_print_devices WHERE id = p_device_id;
  IF NOT FOUND OR NOT public.pos_device_caller_may_manage(v_dev.client_id) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  IF v_dev.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'pos_print_device_removed' USING ERRCODE = '22023',
      HINT = 'This printer computer was removed. Add it again.';
  END IF;
  IF p_station IS NULL OR NOT (p_station = ANY (v_dev.stations)) THEN
    RAISE EXCEPTION 'pos_print_stations_invalid' USING ERRCODE = '22023',
      HINT = 'Choose a station this printer computer prints.';
  END IF;
  IF NOT public.pos_print_doc_ok(p_doc) THEN
    RAISE EXCEPTION 'pos_print_doc_invalid' USING ERRCODE = '22023',
      HINT = 'The test ticket could not be read.';
  END IF;

  INSERT INTO pos_print_jobs (id, client_id, station, kind, doc, label, target_device_id, created_by)
  VALUES (v_id, v_dev.client_id, p_station, 'test', p_doc, 'Test print', v_dev.id, (select auth.uid()));
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.send_pos_print_test(uuid, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.send_pos_print_test(uuid, text, jsonb) TO authenticated, service_role;

-- Metadata only: neither hash is part of the answer, and a pairing code is never readable again
-- after the call that issued it (only whether one is waiting, and until when).
CREATE OR REPLACE FUNCTION public.list_pos_print_devices(p_client_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v jsonb;
BEGIN
  IF p_client_id IS NULL OR NOT public.pos_device_caller_may_manage(p_client_id) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', d.id, 'name', d.name, 'kind', d.kind, 'stations', to_jsonb(d.stations), 'printers', d.printers,
           'paired', d.secret_hash IS NOT NULL,
           'pair_code_expires_at', CASE WHEN d.pair_code_hash IS NOT NULL AND d.pair_code_expires_at > now() THEN d.pair_code_expires_at END,
           'paired_at', d.paired_at, 'last_seen_at', d.last_seen_at,
           'online', COALESCE(d.secret_hash IS NOT NULL AND d.last_seen_at > now() - interval '20 seconds', false),
           'app_version', d.app_version, 'status', d.status, 'last_error', d.last_error, 'last_error_at', d.last_error_at,
           'created_at', d.created_at, 'created_by_name', cb.full_name)
           ORDER BY d.created_at, d.id), '[]'::jsonb)
    INTO v
    FROM pos_print_devices d
    LEFT JOIN profiles cb ON cb.id = d.created_by
   WHERE d.client_id = p_client_id AND d.revoked_at IS NULL;
  RETURN v;
END;
$$;
REVOKE ALL ON FUNCTION public.list_pos_print_devices(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_pos_print_devices(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.list_pos_print_jobs(p_client_id uuid, p_limit integer DEFAULT 50)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v jsonb;
BEGIN
  IF p_client_id IS NULL OR NOT public.pos_device_caller_may_manage(p_client_id) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  SELECT COALESCE(jsonb_agg(x.o ORDER BY x.created_at DESC, x.id DESC), '[]'::jsonb)
    INTO v
    FROM (
      SELECT j.id, j.created_at, jsonb_build_object(
               'id', j.id, 'station', j.station, 'kind', j.kind, 'label', j.label,
               'state', public.pos_print_job_state(j), 'created_at', j.created_at,
               'printed_at', j.printed_at, 'printed_via', j.printed_via,
               'device_name', COALESCE(pd.name, cd.name), 'fail_reason', j.fail_reason, 'fail_count', j.fail_count) AS o
        FROM pos_print_jobs j
        LEFT JOIN pos_print_devices pd ON pd.id = j.printed_by_device
        LEFT JOIN pos_print_devices cd ON cd.id = j.claimed_by
       WHERE j.client_id = p_client_id
       ORDER BY j.created_at DESC, j.id DESC
       LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200)
    ) x;
  RETURN v;
END;
$$;
REVOKE ALL ON FUNCTION public.list_pos_print_jobs(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_pos_print_jobs(uuid, integer) TO authenticated, service_role;

-- ── (4) Till: admin, or a POS login of the outlet (pos_print_caller_is_till) ─────────────────

-- The device covering each station, an online one first. A till reads this with its settings and
-- every 15 s; a station with no online device prints on the till at once.
CREATE OR REPLACE FUNCTION public.get_pos_print_routes(p_client_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v jsonb := '{}'::jsonb;
  s text;
BEGIN
  IF NOT public.pos_print_caller_is_till(p_client_id) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  FOREACH s IN ARRAY ARRAY['KOT', 'BOT'] LOOP
    v := v || jsonb_build_object(s, (
      SELECT jsonb_build_object('device_id', d.id, 'device_name', d.name,
                                'online', COALESCE(d.last_seen_at > now() - interval '20 seconds', false))
        FROM pos_print_devices d
       WHERE d.client_id = p_client_id AND d.revoked_at IS NULL AND d.secret_hash IS NOT NULL
         AND s = ANY (d.stations)
       ORDER BY COALESCE(d.last_seen_at > now() - interval '20 seconds', false) DESC, d.last_seen_at DESC NULLS LAST, d.id
       LIMIT 1));
  END LOOP;
  RETURN v;
END;
$$;
REVOKE ALL ON FUNCTION public.get_pos_print_routes(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_pos_print_routes(uuid) TO authenticated, service_role;

-- One job as the till sent it, checked; NULL when it is not a job the till may queue.
CREATE OR REPLACE FUNCTION public.pos_print_job_from_till(p_job jsonb)
RETURNS TABLE(id uuid, station text, kind text, doc jsonb, label text)
LANGUAGE plpgsql IMMUTABLE
SET search_path TO 'public'
AS $$
BEGIN
  IF jsonb_typeof(p_job) <> 'object'
     OR COALESCE(p_job ->> 'id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR COALESCE(p_job ->> 'station', '') NOT IN ('KOT', 'BOT')
     OR COALESCE(p_job ->> 'kind', '') NOT IN ('ticket', 'reprint', 'void', 'move')
     OR NOT public.pos_print_doc_ok(p_job -> 'doc') THEN
    RAISE EXCEPTION 'pos_print_job_invalid' USING ERRCODE = '22023',
      HINT = 'A kitchen or bar ticket could not be queued for its printer.';
  END IF;
  RETURN QUERY SELECT (p_job ->> 'id')::uuid, (p_job ->> 'station')::text, (p_job ->> 'kind')::text,
                      (p_job -> 'doc')::jsonb, left(NULLIF(btrim(COALESCE(p_job ->> 'label', '')), ''), 80)::text;
END;
$$;
REVOKE ALL ON FUNCTION public.pos_print_job_from_till(jsonb) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.queue_pos_print_jobs(p_client_id uuid, p_jobs jsonb)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  e   jsonb;
  j   record;
  v_n integer := 0;
  v_k integer;
BEGIN
  IF NOT public.pos_print_caller_is_till(p_client_id) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_jobs) IS DISTINCT FROM 'array' OR jsonb_array_length(p_jobs) NOT BETWEEN 1 AND 20 THEN
    RAISE EXCEPTION 'pos_print_job_invalid' USING ERRCODE = '22023',
      HINT = 'A kitchen or bar ticket could not be queued for its printer.';
  END IF;
  FOR e IN SELECT x FROM jsonb_array_elements(p_jobs) x LOOP
    SELECT * INTO j FROM public.pos_print_job_from_till(e);
    -- An id already queued (a retry after a lost answer) is skipped, not refused. An id another
    -- outlet holds is skipped too: ids are minted at random by each till, so that never happens.
    INSERT INTO pos_print_jobs (id, client_id, station, kind, doc, label, created_by)
    VALUES (j.id, p_client_id, j.station, j.kind, j.doc, j.label, (select auth.uid()))
    ON CONFLICT (id) DO NOTHING;
    GET DIAGNOSTICS v_k = ROW_COUNT;
    v_n := v_n + v_k;
  END LOOP;
  RETURN jsonb_build_object('queued', v_n);
END;
$$;
REVOKE ALL ON FUNCTION public.queue_pos_print_jobs(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.queue_pos_print_jobs(uuid, jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_pos_print_job_status(p_client_id uuid, p_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v jsonb;
BEGIN
  IF NOT public.pos_print_caller_is_till(p_client_id) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  IF COALESCE(cardinality(p_ids), 0) > 100 THEN
    RAISE EXCEPTION 'pos_print_job_invalid' USING ERRCODE = '22023',
      HINT = 'Ask about at most 100 tickets at a time.';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', j.id, 'state', public.pos_print_job_state(j),
           'device_name', COALESCE(pd.name, cd.name), 'fail_reason', j.fail_reason,
           'printed_at', j.printed_at, 'printed_via', j.printed_via)), '[]'::jsonb)
    INTO v
    FROM pos_print_jobs j
    LEFT JOIN pos_print_devices pd ON pd.id = j.printed_by_device
    LEFT JOIN pos_print_devices cd ON cd.id = j.claimed_by
   WHERE j.client_id = p_client_id AND j.id = ANY (COALESCE(p_ids, '{}'));
  RETURN v;
END;
$$;
REVOKE ALL ON FUNCTION public.get_pos_print_job_status(uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_pos_print_job_status(uuid, uuid[]) TO authenticated, service_role;

-- The waiter's Print here. ok: true means print it on this till now, and the job is already marked
-- as printed by this login (inserted first if the queue call never landed), so no device can take
-- it afterwards. ok: false means a device has printed it or is printing it.
CREATE OR REPLACE FUNCTION public.claim_pos_print_job_for_till(p_client_id uuid, p_job jsonb)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_new  record;
  v_row  pos_print_jobs;
  v_name text;
  v_k    integer;
BEGIN
  IF NOT public.pos_print_caller_is_till(p_client_id) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_new FROM public.pos_print_job_from_till(p_job);

  SELECT * INTO v_row FROM pos_print_jobs WHERE id = v_new.id FOR UPDATE;
  IF FOUND THEN
    IF v_row.client_id <> p_client_id THEN
      RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
    END IF;
    SELECT name INTO v_name FROM pos_print_devices WHERE id = COALESCE(v_row.printed_by_device, v_row.claimed_by);
    IF v_row.printed_at IS NOT NULL THEN
      RETURN jsonb_build_object('ok', false, 'state', 'printed', 'printed_via', v_row.printed_via, 'device_name', v_name);
    END IF;
    IF v_row.claimed_by IS NOT NULL AND v_row.claimed_at > now() - interval '60 seconds' THEN
      RETURN jsonb_build_object('ok', false, 'state', 'printing', 'device_name', v_name);
    END IF;
    UPDATE pos_print_jobs
       SET printed_at = now(), printed_via = 'till', printed_by_till = (select auth.uid()),
           claimed_by = NULL, claimed_at = NULL
     WHERE id = v_row.id;
    RETURN jsonb_build_object('ok', true, 'state', 'printed', 'printed_via', 'till');
  END IF;

  INSERT INTO pos_print_jobs (id, client_id, station, kind, doc, label, created_by, printed_at, printed_via, printed_by_till)
  VALUES (v_new.id, p_client_id, v_new.station, v_new.kind, v_new.doc, v_new.label, (select auth.uid()),
          now(), 'till', (select auth.uid()))
  ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS v_k = ROW_COUNT;
  IF v_k = 0 THEN
    -- The queue call landed between the read above and this insert: ask again, once.
    RETURN jsonb_build_object('ok', false, 'state', 'printing', 'device_name', NULL);
  END IF;
  RETURN jsonb_build_object('ok', true, 'state', 'printed', 'printed_via', 'till');
END;
$$;
REVOKE ALL ON FUNCTION public.claim_pos_print_job_for_till(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_pos_print_job_for_till(uuid, jsonb) TO authenticated, service_role;

-- ── (5) Print device: anon, keyed by the device's own id and secret ─────────────────────────
--
-- These answer { ok: false, code, message } rather than raising, so a refused pairing keeps the
-- attempt row it wrote, and a device can tell a dead key from a network fault.

CREATE OR REPLACE FUNCTION public.pos_print_device_pair(p_code text, p_info jsonb)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_hdr     json;
  v_ip      text;
  v_n       integer;
  v_code    text := public.pos_print_code_clean(p_code);
  v_old     pos_print_devices;
  v_new     pos_print_devices;
  v_secret  text;
  v_client  record;
BEGIN
  -- The connection is the address Cloudflare saw, never one the caller wrote (S822 5b): cf-connecting-ip,
  -- else the LAST hop of x-forwarded-for; an IPv6 line counts as its /64.
  BEGIN
    v_hdr := NULLIF(current_setting('request.headers', true), '')::json;
  EXCEPTION WHEN OTHERS THEN
    v_hdr := NULL;
  END;
  v_ip := NULLIF(btrim(COALESCE(v_hdr ->> 'cf-connecting-ip', '')), '');
  IF v_ip IS NULL THEN
    v_ip := NULLIF(btrim(regexp_replace(COALESCE(v_hdr ->> 'x-forwarded-for', ''), '^.*,', '')), '');
  END IF;
  IF v_ip LIKE '%:%' THEN
    BEGIN
      v_ip := network(set_masklen(v_ip::inet, 64))::text;
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END IF;
  v_ip := left(COALESCE(v_ip, 'unknown'), 64);

  -- Recorded before the check, so a failing loop spends its own quota (register_trial's rule).
  INSERT INTO pos_print_pair_attempts (ip) VALUES (v_ip);
  SELECT count(*) INTO v_n FROM pos_print_pair_attempts WHERE ip = v_ip AND created_at > now() - interval '15 minutes';
  IF v_n > 10 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'too_many_attempts',
      'message', 'Too many tries from this network. Wait 15 minutes, then type the code again.');
  END IF;

  SELECT * INTO v_old FROM pos_print_devices
   WHERE char_length(v_code) = 8
     AND pair_code_hash = public.pos_device_secret_hash(v_code)
     AND pair_code_expires_at > now()
     AND revoked_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'pair_code_invalid',
      'message', 'That code is not right, or it has expired. Make a new one in POS Setup → Printers.');
  END IF;
  -- The code is left unused for the right kind of device to take.
  IF (p_info ->> 'kind') IS DISTINCT FROM v_old.kind THEN
    RETURN jsonb_build_object('ok', false, 'code', 'wrong_kind',
      'message', CASE v_old.kind
                   WHEN 'helper' THEN 'This code is for the Crest Print Helper program, not the print station page.'
                   ELSE 'This code is for the print station page in Chrome, not the Crest Print Helper.'
                 END);
  END IF;
  SELECT c.name, c.pos_enabled INTO v_client FROM clients c WHERE c.id = v_old.client_id;
  IF NOT COALESCE(v_client.pos_enabled, false) OR NOT COALESCE(public.client_access_open(v_old.client_id), false) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'pos_off',
      'message', 'POS is switched off for this restaurant, so nothing can print yet.');
  END IF;

  -- 244 bits of CSPRNG output, the pos_devices pattern. A new pairing replaces the old secret, so a
  -- device moved to another computer stops printing on the first one.
  v_secret := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  UPDATE pos_print_devices
     SET secret_hash = public.pos_device_secret_hash(v_secret),
         pair_code_hash = NULL, pair_code_expires_at = NULL,
         paired_at = now(), last_seen_at = now(),
         app_version = left(NULLIF(btrim(COALESCE(p_info ->> 'app_version', '')), ''), 40),
         status = NULL, last_error = NULL, last_error_at = NULL
   WHERE id = v_old.id
  RETURNING * INTO v_new;

  UPDATE pos_print_jobs SET claimed_by = NULL, claimed_at = NULL
   WHERE claimed_by = v_old.id AND printed_at IS NULL;

  PERFORM public.pos_print_devices_audit('UPDATE', v_old, v_new);

  RETURN jsonb_build_object('ok', true, 'device_id', v_new.id, 'secret', v_secret,
                            'device_name', v_new.name, 'kind', v_new.kind, 'client_name', v_client.name);
END;
$$;
REVOKE ALL ON FUNCTION public.pos_print_device_pair(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pos_print_device_pair(text, jsonb) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.pos_print_device_poll(p_device_id uuid, p_secret text, p_info jsonb)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_dev     pos_print_devices;
  v_client  record;
  v_status  jsonb;
  v_err     text;
  v_device  jsonb;
  v_jobs    jsonb;
BEGIN
  SELECT * INTO v_dev FROM public.pos_print_device_by_key(p_device_id, p_secret);
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'device_not_active',
      'message', 'This printer computer was removed or paired again elsewhere. Make a new code in POS Setup → Printers.');
  END IF;

  -- What the device says about its printers, bounded: at most 4, each a station, ok and an error.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'station', left(COALESCE(x ->> 'station', ''), 3),
           'ok', COALESCE(x -> 'ok' = 'true'::jsonb, false),
           'error', left(NULLIF(btrim(COALESCE(x ->> 'error', '')), ''), 200))), '[]'::jsonb),
         (array_agg(left(NULLIF(btrim(COALESCE(x ->> 'error', '')), ''), 200)) FILTER (WHERE NOT COALESCE(x -> 'ok' = 'true'::jsonb, false)))[1]
    INTO v_status, v_err
    FROM (SELECT x FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_info -> 'printers') = 'array' THEN p_info -> 'printers' ELSE '[]'::jsonb END) x LIMIT 4) s;

  -- The heartbeat, at most every 5 s unless what the printers say has changed.
  UPDATE pos_print_devices
     SET last_seen_at = now(),
         app_version = COALESCE(left(NULLIF(btrim(COALESCE(p_info ->> 'app_version', '')), ''), 40), app_version),
         status = jsonb_build_object('printers', v_status),
         last_error = COALESCE(v_err, last_error),
         last_error_at = CASE WHEN v_err IS NOT NULL THEN now() ELSE last_error_at END
   WHERE id = v_dev.id
     AND (last_seen_at IS NULL OR last_seen_at < now() - interval '5 seconds'
          OR status IS DISTINCT FROM jsonb_build_object('printers', v_status));

  v_device := jsonb_build_object('id', v_dev.id, 'name', v_dev.name, 'kind', v_dev.kind,
                                 'stations', to_jsonb(v_dev.stations), 'printers', v_dev.printers);
  SELECT c.name, c.pos_enabled INTO v_client FROM clients c WHERE c.id = v_dev.client_id;
  IF NOT COALESCE(v_client.pos_enabled, false) OR NOT COALESCE(public.client_access_open(v_dev.client_id), false) THEN
    RETURN jsonb_build_object('ok', true, 'paused', 'pos_off', 'device', v_device, 'client_name', v_client.name,
                              'server_time', now(), 'jobs', '[]'::jsonb);
  END IF;

  -- Claim at most 10, oldest first. SKIP LOCKED: two devices on one station never wait on, or take,
  -- the same job. A claim older than 60 s is a device that died mid-job, and is taken over.
  WITH picked AS (
    SELECT j.id
      FROM pos_print_jobs j
     WHERE j.client_id = v_dev.client_id
       AND j.printed_at IS NULL
       AND j.fail_count < 5
       AND j.created_at > now() - interval '15 minutes'
       AND (j.claimed_by IS NULL OR j.claimed_at < now() - interval '60 seconds')
       AND (j.target_device_id = v_dev.id OR (j.target_device_id IS NULL AND j.station = ANY (v_dev.stations)))
     ORDER BY j.created_at, j.id
     LIMIT 10
       FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE pos_print_jobs j
       SET claimed_by = v_dev.id, claimed_at = now()
      FROM picked
     WHERE j.id = picked.id
    RETURNING j.id, j.station, j.kind, j.doc, j.label, j.created_at
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', c.id, 'station', c.station, 'kind', c.kind, 'doc', c.doc, 'label', c.label,
           'created_at', c.created_at, 'late', c.created_at < now() - interval '2 minutes')
           ORDER BY c.created_at, c.id), '[]'::jsonb)
    INTO v_jobs
    FROM claimed c;

  RETURN jsonb_build_object('ok', true, 'device', v_device, 'client_name', v_client.name,
                            'server_time', now(), 'jobs', v_jobs);
END;
$$;
REVOKE ALL ON FUNCTION public.pos_print_device_poll(uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pos_print_device_poll(uuid, text, jsonb) TO anon, authenticated, service_role;

-- Printed: any unprinted job of this outlet the device could have taken (its station, or a test
-- aimed at it), even if its claim lapsed meanwhile — it IS on paper, and marking it stops a second
-- device printing it again. Failed: only a job this device still holds goes back to waiting.
CREATE OR REPLACE FUNCTION public.pos_print_device_report(p_device_id uuid, p_secret text, p_printed uuid[], p_failed jsonb)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_dev  pos_print_devices;
  f      jsonb;
  v_last text;
  v_k    integer;
BEGIN
  SELECT * INTO v_dev FROM public.pos_print_device_by_key(p_device_id, p_secret);
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'device_not_active',
      'message', 'This printer computer was removed or paired again elsewhere. Make a new code in POS Setup → Printers.');
  END IF;
  IF COALESCE(cardinality(p_printed), 0) > 50
     OR (p_failed IS NOT NULL AND (jsonb_typeof(p_failed) <> 'array' OR jsonb_array_length(p_failed) > 50)) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'report_invalid', 'message', 'Report at most 50 tickets at a time.');
  END IF;

  IF COALESCE(cardinality(p_printed), 0) > 0 THEN
    UPDATE pos_print_jobs j
       SET printed_at = now(), printed_via = 'device', printed_by_device = v_dev.id
     WHERE j.id = ANY (p_printed)
       AND j.client_id = v_dev.client_id
       AND j.printed_at IS NULL
       AND (j.target_device_id = v_dev.id OR (j.target_device_id IS NULL AND j.station = ANY (v_dev.stations)));
  END IF;

  FOR f IN SELECT x FROM jsonb_array_elements(COALESCE(p_failed, '[]'::jsonb)) x LOOP
    CONTINUE WHEN COALESCE(f ->> 'id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
    UPDATE pos_print_jobs j
       SET claimed_by = NULL, claimed_at = NULL,
           fail_count = j.fail_count + 1,
           fail_reason = COALESCE(left(NULLIF(btrim(COALESCE(f ->> 'reason', '')), ''), 200), 'The printer did not print it.'),
           failed_at = now()
     WHERE j.id = (f ->> 'id')::uuid
       AND j.client_id = v_dev.client_id
       AND j.claimed_by = v_dev.id
       AND j.printed_at IS NULL;
    GET DIAGNOSTICS v_k = ROW_COUNT;
    IF v_k > 0 THEN
      v_last := COALESCE(left(NULLIF(btrim(COALESCE(f ->> 'reason', '')), ''), 200), 'The printer did not print it.');
    END IF;
  END LOOP;

  IF v_last IS NOT NULL THEN
    UPDATE pos_print_devices SET last_error = v_last, last_error_at = now() WHERE id = v_dev.id;
  END IF;
  RETURN jsonb_build_object('ok', true);
END;
$$;
REVOKE ALL ON FUNCTION public.pos_print_device_report(uuid, text, uuid[], jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pos_print_device_report(uuid, text, uuid[], jsonb) TO anon, authenticated, service_role;

-- ── (6) The nightly purge ──────────────────────────────────────────────────────────────────────
-- Plain SQL, so it needs nothing the expired-trial job's http_post does. 21:40 UTC is 03:25 in Nepal,
-- when no till is open. Unscheduled first, so re-running this file replaces rather than duplicates it.
SELECT cron.unschedule('crest-purge-print-jobs')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'crest-purge-print-jobs');

SELECT cron.schedule(
  'crest-purge-print-jobs',
  '40 21 * * *',
  $job$
  WITH tries AS (DELETE FROM public.pos_print_pair_attempts WHERE created_at < now() - interval '1 day')
  DELETE FROM public.pos_print_jobs WHERE created_at < now() - interval '7 days';
  $job$
);

-- ── (6b) Where the Crest Print Helper is downloaded from ──────────────────────────────────────
-- A public bucket: POS Setup → Printers links to downloads/CrestPrintHelper.zip, and a restaurant
-- downloads it without signing in. No policy on storage.objects names it, so only the service role
-- (the Supabase CLI, from this machine) can put a file there. Zip files only, up to 100 MB. DO NOTHING
-- on conflict, as dish-photos does: an existing bucket is corrected in the Dashboard, and the
-- assertion below refuses to pass until it matches.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('downloads', 'downloads', true, 104857600, ARRAY['application/zip', 'application/x-zip-compressed'])
ON CONFLICT (id) DO NOTHING;

NOTIFY pgrst, 'reload schema';

-- ── (7) Catalog assertions ─────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  t text;
  f text;
  r text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pos_print_devices', 'pos_print_jobs', 'pos_print_pair_attempts'] LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || t)::regclass) THEN
      RAISE EXCEPTION 'S837: RLS is off on %', t;
    END IF;
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF has_table_privilege(r, 'public.' || t, 'SELECT') OR has_table_privilege(r, 'public.' || t, 'INSERT')
         OR has_table_privilege(r, 'public.' || t, 'UPDATE') OR has_table_privilege(r, 'public.' || t, 'DELETE')
         OR has_table_privilege(r, 'public.' || t, 'TRUNCATE') OR has_table_privilege(r, 'public.' || t, 'REFERENCES')
         OR has_table_privilege(r, 'public.' || t, 'TRIGGER') THEN
        RAISE EXCEPTION 'S837: % holds a privilege on %', r, t;
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t) THEN
      RAISE EXCEPTION 'S837: % has a policy; it is reached only through functions', t;
    END IF;
  END LOOP;

  -- The device functions: anon may call them.
  FOREACH f IN ARRAY ARRAY['public.pos_print_device_pair(text, jsonb)', 'public.pos_print_device_poll(uuid, text, jsonb)',
                           'public.pos_print_device_report(uuid, text, uuid[], jsonb)'] LOOP
    IF NOT has_function_privilege('anon', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'S837: anon cannot call %', f;
    END IF;
  END LOOP;

  -- The manager and till functions: a signed-in caller only, never anon or PUBLIC.
  FOREACH f IN ARRAY ARRAY['public.create_pos_print_device(uuid, text, text, text[], jsonb)',
                           'public.update_pos_print_device(uuid, text, text[], jsonb)',
                           'public.issue_pos_print_pair_code(uuid)', 'public.remove_pos_print_device(uuid)',
                           'public.send_pos_print_test(uuid, text, jsonb)', 'public.list_pos_print_devices(uuid)',
                           'public.list_pos_print_jobs(uuid, integer)', 'public.get_pos_print_routes(uuid)',
                           'public.queue_pos_print_jobs(uuid, jsonb)', 'public.get_pos_print_job_status(uuid, uuid[])',
                           'public.claim_pos_print_job_for_till(uuid, jsonb)'] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') OR NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'S837: % has the wrong grants', f;
    END IF;
  END LOOP;

  -- The helpers: no client role at all.
  FOREACH f IN ARRAY ARRAY['public.pos_print_new_code()', 'public.pos_print_code_clean(text)',
                           'public.pos_print_clean_stations(text[])', 'public.pos_print_clean_printers(text, text[], jsonb)',
                           'public.pos_print_doc_ok(jsonb)', 'public.pos_print_job_state(public.pos_print_jobs)',
                           'public.pos_print_caller_is_till(uuid)', 'public.pos_print_device_by_key(uuid, text)',
                           'public.pos_print_job_from_till(jsonb)',
                           'public.pos_print_devices_audit(text, public.pos_print_devices, public.pos_print_devices)'] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'S837: helper % is callable by a client role', f;
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'crest-purge-print-jobs') THEN
    RAISE EXCEPTION 'S837: the nightly purge is not scheduled';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'downloads' AND public) THEN
    RAISE EXCEPTION 'S837: the downloads bucket is missing or not public — correct it in the Dashboard';
  END IF;
END;
$$;

-- ── (8) The probe, rolled back ─────────────────────────────────────────────────────────────────
-- At BLOOM CAFE (or the first POS outlet with an unblocked POS till login), as a stand-in login
-- whose rank the probe sets, and as an anonymous device from a test address. Everything it writes
-- is undone by the sentinel at the end.
DO $$
DECLARE
  v_client uuid; v_other uuid; v_staff uuid;
  v_r jsonb; v_code text; v_code2 text; v_dev uuid; v_dev2 uuid; v_secret text;
  v_job uuid := gen_random_uuid(); v_job2 uuid := gen_random_uuid(); v_job3 uuid := gen_random_uuid();
  v_doc jsonb := '{"v":1,"title":"KOT","lines":[{"k":"text","t":"S837 probe","align":"center","size":"lg"},{"k":"hr"}]}'::jsonb;
  v_hint text; v_state text; v_i integer;
BEGIN
  SELECT c.id INTO v_client
    FROM public.clients c
   WHERE c.pos_enabled AND COALESCE(public.client_access_open(c.id), false)
     AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.client_id = c.id AND p.active_client_id IS NULL
                    AND p.pos_role IS NOT NULL AND p.pos_email IS NOT NULL
                    AND p.settlement_blocked_by IS NULL AND p.pos_blocked_at IS NULL)
   ORDER BY (c.name = 'BLOOM CAFE') DESC, c.name LIMIT 1;
  IF v_client IS NULL THEN
    RAISE EXCEPTION 'S837 probe: no POS outlet with an unblocked POS till login';
  END IF;
  SELECT p.id INTO v_staff FROM public.profiles p
   WHERE p.client_id = v_client AND p.active_client_id IS NULL AND p.pos_role IS NOT NULL AND p.pos_email IS NOT NULL
     AND p.settlement_blocked_by IS NULL AND p.pos_blocked_at IS NULL
   ORDER BY (p.pos_role = 'staff') DESC, p.id LIMIT 1;
  SELECT c.id INTO v_other FROM public.clients c WHERE c.id <> v_client ORDER BY c.id LIMIT 1;

  BEGIN
    -- ── A Staff-rank till login may not manage printers ────────────────────────────────────────
    UPDATE public.profiles SET pos_role = 'staff', ims_role = NULL, hr_role = NULL, hr_self_service = false WHERE id = v_staff;
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_staff)::text, true);
    BEGIN
      PERFORM public.create_pos_print_device(v_client, 'S837 probe', 'page', ARRAY['KOT'], '[]'::jsonb);
      RAISE EXCEPTION 'S837 probe: a Staff-rank login added a printer computer';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;

    -- ── A POS manager adds a page and a helper ─────────────────────────────────────────────────
    PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
    UPDATE public.profiles SET pos_role = 'manager' WHERE id = v_staff;
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_staff)::text, true);
    v_r := public.create_pos_print_device(v_client, '  S837 counter  ', 'page', ARRAY['KOT', 'KOT'], NULL);
    v_dev := (v_r ->> 'device_id')::uuid; v_code := v_r ->> 'pair_code';
    IF v_code !~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$' THEN RAISE EXCEPTION 'S837 probe: pairing code %', v_code; END IF;
    BEGIN
      PERFORM public.create_pos_print_device(v_client, 'S837 helper', 'helper', ARRAY['BOT'],
        '[{"station":"BOT","host":"8.8.8.8","port":9100,"width":80}]'::jsonb);
      RAISE EXCEPTION 'S837 probe: a public printer address was accepted';
    EXCEPTION WHEN invalid_parameter_value THEN
      GET STACKED DIAGNOSTICS v_hint = MESSAGE_TEXT;
      IF v_hint <> 'pos_print_printer_address_invalid' THEN RAISE EXCEPTION 'S837 probe: public address answered %', v_hint; END IF;
    END;
    v_r := public.create_pos_print_device(v_client, 'S837 helper', 'helper', ARRAY['BOT'],
      '[{"station":"BOT","host":"192.168.1.50","port":"9100","width":58}]'::jsonb);
    v_dev2 := (v_r ->> 'device_id')::uuid; v_code2 := v_r ->> 'pair_code';
    IF (SELECT printers FROM public.pos_print_devices WHERE id = v_dev2)
       <> '[{"station":"BOT","host":"192.168.1.50","port":9100,"width":58}]'::jsonb THEN
      RAISE EXCEPTION 'S837 probe: printers stored as %', (SELECT printers FROM public.pos_print_devices WHERE id = v_dev2);
    END IF;
    IF (SELECT name FROM public.pos_print_devices WHERE id = v_dev) <> 'S837 counter' THEN
      RAISE EXCEPTION 'S837 probe: name not trimmed';
    END IF;
    IF jsonb_array_length(public.list_pos_print_devices(v_client)) < 2
       OR public.list_pos_print_devices(v_client)::text LIKE '%secret%' OR public.list_pos_print_devices(v_client)::text LIKE '%' || v_code || '%' THEN
      RAISE EXCEPTION 'S837 probe: the device list is wrong or leaks a secret or code';
    END IF;

    -- ── An anonymous device pairs ──────────────────────────────────────────────────────────────
    PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
    PERFORM set_config('request.headers', '{"cf-connecting-ip":"203.0.113.237"}', true);
    v_r := public.pos_print_device_pair('WRONG123', '{"kind":"page"}');
    IF v_r ->> 'code' IS DISTINCT FROM 'pair_code_invalid' THEN RAISE EXCEPTION 'S837 probe: a wrong code answered %', v_r; END IF;
    v_r := public.pos_print_device_pair(v_code, '{"kind":"helper"}');
    IF v_r ->> 'code' IS DISTINCT FROM 'wrong_kind' THEN RAISE EXCEPTION 'S837 probe: the wrong kind answered %', v_r; END IF;
    v_r := public.pos_print_device_pair(lower(substr(v_code, 1, 4) || '-' || substr(v_code, 5)), '{"kind":"page","app_version":"crest-v453"}');
    IF NOT COALESCE((v_r ->> 'ok')::boolean, false) OR (v_r ->> 'device_id')::uuid <> v_dev THEN
      RAISE EXCEPTION 'S837 probe: pairing answered %', v_r;
    END IF;
    v_secret := v_r ->> 'secret';
    v_r := public.pos_print_device_pair(v_code, '{"kind":"page"}');
    IF v_r ->> 'code' IS DISTINCT FROM 'pair_code_invalid' THEN RAISE EXCEPTION 'S837 probe: a used code paired again: %', v_r; END IF;

    -- ── The till sees the route, queues a ticket, and a retry queues nothing ───────────────────
    PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
    UPDATE public.profiles SET pos_role = 'staff' WHERE id = v_staff;
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_staff)::text, true);
    v_r := public.get_pos_print_routes(v_client);
    IF (v_r -> 'KOT' ->> 'device_id')::uuid IS DISTINCT FROM v_dev OR NOT COALESCE((v_r -> 'KOT' ->> 'online')::boolean, false) THEN
      RAISE EXCEPTION 'S837 probe: routes answered %', v_r;
    END IF;
    v_r := public.queue_pos_print_jobs(v_client, jsonb_build_array(jsonb_build_object(
             'id', v_job, 'station', 'KOT', 'kind', 'ticket', 'doc', v_doc, 'label', 'Table 4 · #23')));
    IF (v_r ->> 'queued')::int <> 1 THEN RAISE EXCEPTION 'S837 probe: queue answered %', v_r; END IF;
    v_r := public.queue_pos_print_jobs(v_client, jsonb_build_array(jsonb_build_object(
             'id', v_job, 'station', 'KOT', 'kind', 'ticket', 'doc', v_doc)));
    IF (v_r ->> 'queued')::int <> 0 THEN RAISE EXCEPTION 'S837 probe: a retry queued twice'; END IF;
    BEGIN
      PERFORM public.get_pos_print_job_status(v_other, ARRAY[v_job]);
      RAISE EXCEPTION 'S837 probe: a till read another outlet''s print status';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
      PERFORM public.queue_pos_print_jobs(v_client, jsonb_build_array(jsonb_build_object(
                'id', v_job2, 'station', 'KOT', 'kind', 'test', 'doc', v_doc)));
      RAISE EXCEPTION 'S837 probe: a till queued a test job';
    EXCEPTION WHEN invalid_parameter_value THEN NULL;
    END;

    -- ── The device claims it, fails once, takes it again and prints it ─────────────────────────
    PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
    v_r := public.pos_print_device_poll(v_dev, v_secret, '{"app_version":"crest-v453","printers":[]}');
    IF jsonb_array_length(v_r -> 'jobs') <> 1 OR (v_r -> 'jobs' -> 0 ->> 'id')::uuid <> v_job THEN
      RAISE EXCEPTION 'S837 probe: the poll answered %', v_r;
    END IF;
    v_r := public.pos_print_device_poll(v_dev, v_secret, '{}');
    IF jsonb_array_length(v_r -> 'jobs') <> 0 THEN RAISE EXCEPTION 'S837 probe: a claimed job was handed out twice'; END IF;
    IF public.pos_print_device_poll(v_dev, 'not-the-secret', '{}') ->> 'code' IS DISTINCT FROM 'device_not_active' THEN
      RAISE EXCEPTION 'S837 probe: a wrong secret polled';
    END IF;
    PERFORM public.pos_print_device_report(v_dev, v_secret, NULL, jsonb_build_array(jsonb_build_object('id', v_job, 'reason', 'Out of paper')));
    SELECT public.pos_print_job_state(j) INTO v_state FROM public.pos_print_jobs j WHERE id = v_job;
    IF v_state <> 'retrying' THEN RAISE EXCEPTION 'S837 probe: after a failure the job is %', v_state; END IF;
    v_r := public.pos_print_device_poll(v_dev, v_secret, '{}');
    IF jsonb_array_length(v_r -> 'jobs') <> 1 THEN RAISE EXCEPTION 'S837 probe: a failed job was not retried'; END IF;
    PERFORM public.pos_print_device_report(v_dev, v_secret, ARRAY[v_job], NULL);

    -- ── Print here: refused for a printed job, granted for one that never arrived ──────────────
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_staff)::text, true);
    v_r := public.get_pos_print_job_status(v_client, ARRAY[v_job]);
    IF v_r -> 0 ->> 'state' <> 'printed' OR v_r -> 0 ->> 'device_name' <> 'S837 counter' THEN
      RAISE EXCEPTION 'S837 probe: status answered %', v_r;
    END IF;
    v_r := public.claim_pos_print_job_for_till(v_client, jsonb_build_object('id', v_job, 'station', 'KOT', 'kind', 'ticket', 'doc', v_doc));
    IF COALESCE((v_r ->> 'ok')::boolean, true) OR v_r ->> 'state' <> 'printed' THEN
      RAISE EXCEPTION 'S837 probe: Print here on a printed job answered %', v_r;
    END IF;
    v_r := public.claim_pos_print_job_for_till(v_client, jsonb_build_object('id', v_job3, 'station', 'KOT', 'kind', 'ticket', 'doc', v_doc));
    IF NOT COALESCE((v_r ->> 'ok')::boolean, false) THEN RAISE EXCEPTION 'S837 probe: Print here on a lost job answered %', v_r; END IF;
    PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
    IF jsonb_array_length(public.pos_print_device_poll(v_dev, v_secret, '{}') -> 'jobs') <> 0 THEN
      RAISE EXCEPTION 'S837 probe: a job the till printed was handed to the device';
    END IF;

    -- ── A test print reaches only its own device; removal stops the device ─────────────────────
    PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
    UPDATE public.profiles SET pos_role = 'manager' WHERE id = v_staff;
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_staff)::text, true);
    PERFORM public.send_pos_print_test(v_dev, 'KOT', v_doc);
    -- Every row here shares the transaction's now(), so the newest-first order is a tie: find by kind.
    IF jsonb_array_length(public.list_pos_print_jobs(v_client, 10)) < 3
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(public.list_pos_print_jobs(v_client, 10)) e
                       WHERE e ->> 'kind' = 'test' AND e ->> 'state' = 'waiting' AND e ->> 'label' = 'Test print') THEN
      RAISE EXCEPTION 'S837 probe: the recent-prints list answered %', public.list_pos_print_jobs(v_client, 10);
    END IF;
    v_r := public.issue_pos_print_pair_code(v_dev2);
    IF v_r ->> 'pair_code' = v_code2 THEN RAISE EXCEPTION 'S837 probe: a new pairing code repeated the old one'; END IF;
    v_code2 := v_r ->> 'pair_code';
    PERFORM public.update_pos_print_device(v_dev2, 'S837 bar helper', ARRAY['BOT', 'KOT'],
      '[{"station":"BOT","host":"192.168.1.50"},{"station":"KOT","host":"10.0.0.7","port":9101,"width":80}]'::jsonb);
    IF (SELECT stations FROM public.pos_print_devices WHERE id = v_dev2) <> ARRAY['KOT', 'BOT']
       OR (SELECT printers -> 1 ->> 'port' FROM public.pos_print_devices WHERE id = v_dev2) <> '9101' THEN
      RAISE EXCEPTION 'S837 probe: the edit stored %', (SELECT printers FROM public.pos_print_devices WHERE id = v_dev2);
    END IF;
    BEGIN
      PERFORM public.update_pos_print_device(v_dev2, 'S837 bar helper', ARRAY['BOT', 'KOT'], '[{"station":"BOT","host":"192.168.1.50"}]'::jsonb);
      RAISE EXCEPTION 'S837 probe: a helper station with no printer was accepted';
    EXCEPTION WHEN invalid_parameter_value THEN NULL;
    END;
    PERFORM public.remove_pos_print_device(v_dev);
    PERFORM public.remove_pos_print_device(v_dev);   -- idempotent
    PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
    IF public.pos_print_device_poll(v_dev, v_secret, '{}') ->> 'code' IS DISTINCT FROM 'device_not_active' THEN
      RAISE EXCEPTION 'S837 probe: a removed device still polls';
    END IF;

    -- ── The pairing address runs out of tries ───────────────────────────────────────────────────
    FOR v_i IN 1..8 LOOP
      PERFORM public.pos_print_device_pair('ZZZZZZZZ', '{"kind":"page"}');
    END LOOP;
    v_r := public.pos_print_device_pair(v_code2, '{"kind":"helper"}');
    IF v_r ->> 'code' IS DISTINCT FROM 'too_many_attempts' THEN RAISE EXCEPTION 'S837 probe: the 13th try answered %', v_r; END IF;

    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 's837_probe_rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 's837_probe_rollback' THEN RAISE; END IF;
  END;
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.headers', '', true);
END;
$$;
