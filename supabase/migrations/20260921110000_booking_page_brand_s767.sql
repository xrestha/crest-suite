-- S767 (follow-up, owner decision 2026-09-16) — the public booking page shows the restaurant's own
-- name and logo, as the guest QR menu does since 20260921100000.
--
-- get_booking_page gains two output columns, menu_name and logo_url, read from the same
-- settings.guest_menu_name / guest_menu_logo_url the Owner sets in POS Setup → Guest Menu. Nothing
-- else changes: the body below is the LIVE definition (pg_get_functiondef, read 2026-09-16) with the
-- two columns added. Adding output columns is not CREATE OR REPLACE-compatible (42P13), hence DROP +
-- CREATE, and DROP discards grants — the function is anon-callable by design (a guest has no
-- session), so they are restated and asserted below.
--
-- The page falls back to the account name (tidied from capitals) when menu_name is NULL, and to no
-- logo, so a frontend that deploys before this migration keeps working (the hot-path rule).

DROP FUNCTION IF EXISTS public.get_booking_page(uuid);

CREATE FUNCTION public.get_booking_page(p_client_id uuid)
 RETURNS TABLE(outlet_name text, open_time text, close_time text, max_party_online integer, min_lead_minutes integer, max_days_ahead integer, total_seats integer, duration_by_band jsonb, closed_weekdays integer[], walk_in_weekdays integer[], closed_dates text[], page_notice text,
               menu_name text, logo_url text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_pos_enabled boolean;
  v_name text;
  v_settings jsonb;
  v_open text;
  v_close text;
  v_seats integer;
  v_menu_name text;
  v_logo_url text;
BEGIN
  SELECT c.pos_enabled, c.name INTO v_pos_enabled, v_name FROM clients c WHERE c.id = p_client_id;
  IF NOT COALESCE(v_pos_enabled, false) THEN RETURN; END IF;

  SELECT s.pos_reservation_settings, s.pos_open_time, s.pos_close_time,
         NULLIF(btrim(s.guest_menu_name), ''), NULLIF(btrim(s.guest_menu_logo_url), '')
    INTO v_settings, v_open, v_close, v_menu_name, v_logo_url
  FROM settings s WHERE s.client_id = p_client_id LIMIT 1;
  IF NOT COALESCE((v_settings->>'public_booking_enabled')::boolean, false) THEN RETURN; END IF;

  SELECT COALESCE(sum(t.capacity), 0)::integer INTO v_seats
  FROM pos_tables t WHERE t.client_id = p_client_id AND COALESCE(t.status, '') <> 'inactive';

  RETURN QUERY SELECT
    v_name, v_open, v_close,
    COALESCE((v_settings->>'max_party_online')::integer, 20),
    COALESCE((v_settings->>'min_lead_minutes')::integer, 60),
    14,
    v_seats,
    COALESCE(v_settings->'duration_by_band', '{}'::jsonb),
    CASE WHEN jsonb_typeof(v_settings->'closed_weekdays') = 'array'
         THEN COALESCE((SELECT array_agg(x::integer) FROM jsonb_array_elements_text(v_settings->'closed_weekdays') x), '{}'::integer[])
         ELSE '{}'::integer[] END,
    CASE WHEN jsonb_typeof(v_settings->'walk_in_weekdays') = 'array'
         THEN COALESCE((SELECT array_agg(x::integer) FROM jsonb_array_elements_text(v_settings->'walk_in_weekdays') x), '{}'::integer[])
         ELSE '{}'::integer[] END,
    CASE WHEN jsonb_typeof(v_settings->'closed_dates') = 'array'
         THEN COALESCE((SELECT array_agg(x) FROM jsonb_array_elements_text(v_settings->'closed_dates') x), '{}'::text[])
         ELSE '{}'::text[] END,
    NULLIF(btrim(COALESCE(v_settings->>'page_notice', '')), ''),
    v_menu_name,
    v_logo_url;
END;
$function$;
REVOKE ALL ON FUNCTION public.get_booking_page(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_booking_page(uuid) TO anon, authenticated, service_role;

DO $$
DECLARE
  v_client uuid;
  r RECORD;
BEGIN
  IF NOT has_function_privilege('anon', 'public.get_booking_page(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'S767: anon cannot execute get_booking_page — every booking link would say booking is unavailable';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'get_booking_page') <> 1 THEN
    RAISE EXCEPTION 'S767: more than one get_booking_page signature';
  END IF;
  -- RETURN QUERY compares result types exactly and a plpgsql body is only checked when it runs
  -- (S735/S737), so call it for a client whose booking page is ON — for any other client the body
  -- returns before the RETURN QUERY and proves nothing.
  SELECT c.id INTO v_client
    FROM clients c JOIN settings s ON s.client_id = c.id
   WHERE c.pos_enabled AND COALESCE((s.pos_reservation_settings->>'public_booking_enabled')::boolean, false)
   LIMIT 1;
  IF v_client IS NOT NULL THEN
    SELECT * INTO r FROM public.get_booking_page(v_client);
    IF r.outlet_name IS NULL THEN
      RAISE EXCEPTION 'S767: get_booking_page returned no row for a client with booking on';
    END IF;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
