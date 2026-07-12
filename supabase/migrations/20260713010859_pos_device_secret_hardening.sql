-- get_pos_staff(p_client_id) was callable by anon with zero authorization check, and the
-- frontend's only "credential" for calling it was the raw client_id sitting in plain
-- localStorage (set by Pos.js activate() from an authenticated session, but never verified
-- again after that). Anyone who set localStorage['pos_device_client_id'] to a guessed/obtained
-- client UUID and loaded /pos/login got that client's full POS staff roster (names + emails) —
-- a cross-tenant PII leak with no auth boundary at all.
--
-- Fix: give each client an unguessable per-client secret. Device activation (an authenticated
-- action) fetches and stores it; PosLogin must present it to get_pos_staff, which now verifies
-- it server-side before returning any rows.

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS pos_device_secret uuid NOT NULL DEFAULT gen_random_uuid();

DROP FUNCTION IF EXISTS public.get_pos_staff(uuid);

CREATE FUNCTION public.get_pos_staff(p_client_id uuid, p_device_secret uuid)
    RETURNS TABLE(id uuid, full_name text, pos_role text, pos_email text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT p.id, p.full_name, p.pos_role, p.pos_email
  FROM profiles p
  WHERE p.client_id = p_client_id
    AND p.pos_role IS NOT NULL
    AND p.pos_email IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM clients c
      WHERE c.id = p_client_id AND c.pos_device_secret = p_device_secret
    )
  ORDER BY p.full_name;
$$;

GRANT EXECUTE ON FUNCTION public.get_pos_staff(uuid, uuid) TO anon, authenticated;
