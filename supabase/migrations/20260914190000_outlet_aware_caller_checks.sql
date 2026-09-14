-- S750 — a switched outlet is the caller's client in every caller check, and the IMS staff list is
-- manager-only again.
--
-- (1) OUTLET. Ten SECURITY DEFINER functions decided "is the caller in this client?" by comparing
-- p_client_id with profiles.client_id — the caller's HOME outlet. Every RLS policy, scopedDb and
-- AuthContext resolve it through my_client_id() = COALESCE(active_client_id, client_id) (S548), so a
-- grouped Owner (or an allowlisted manager) switched to a sibling outlet could read and write that
-- outlet's rows everywhere EXCEPT these: its HR / IMS / POS Staff pages listed nobody, a comp could
-- not be applied, the comp-slip number and the device secret were refused, and the name lookups
-- behind "closed by" / "comped by" came back empty. admin-user-ops had the same home-only rule on
-- every staff action (S748 open item); it is fixed in the same change.
--
-- Each body below is the LIVE definition (pg_get_functiondef, 2026-09-14) with only the one
-- expression changed, so nothing else in these functions moves. active_client_id is
-- privilege-bearing and written only by set_active_outlet(), which checks group membership and
-- profile_outlet_access; a revoke clears it — trusting it here grants no reach RLS does not already.
--
-- (2) RANK. get_ims_staff_list is manager-or-Owner again — see the comment inside it.
--
-- CREATE OR REPLACE with an unchanged signature and return type keeps each function's existing
-- privileges; the grants are re-asserted anyway, byte-identical to what was live (authenticated and
-- service_role, never anon).

-- ── get_client_profile_names ──────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_client_profile_names(p_client_id uuid)
 RETURNS TABLE(id uuid, full_name text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  caller_client_id uuid;
  caller_role text;
BEGIN
  SELECT COALESCE(p.active_client_id, p.client_id), p.role INTO caller_client_id, caller_role FROM profiles p WHERE p.id = auth.uid();
  IF caller_role = 'admin' OR caller_client_id = p_client_id THEN
    RETURN QUERY
      SELECT p.id, p.full_name FROM profiles p WHERE p.client_id = p_client_id OR p.id = auth.uid();
  END IF;
END;
$function$;

-- ── get_hr_role_eligible_users ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_hr_role_eligible_users(p_client_id uuid)
 RETURNS TABLE(id uuid, full_name text, email text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  caller_client_id uuid;
BEGIN
  SELECT COALESCE(p.active_client_id, p.client_id) INTO caller_client_id FROM profiles p WHERE p.id = auth.uid();

  IF public.is_admin() OR (public.is_client_owner() AND caller_client_id = p_client_id) THEN
    RETURN QUERY
      SELECT p.id, p.full_name, u.email::text
      FROM profiles p
      JOIN auth.users u ON u.id = p.id
      WHERE p.client_id = p_client_id
        AND p.role = 'client'
        AND p.pos_role IS NULL
        AND p.hr_self_service = false
        AND p.ims_role IS NULL
        AND p.hr_role IS NULL
        AND p.id != auth.uid()
      ORDER BY p.full_name;
  END IF;
END;
$function$;

-- ── get_hr_role_staff_list ────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_hr_role_staff_list(p_client_id uuid)
 RETURNS TABLE(id uuid, full_name text, email text, hr_role text, hr_job_title text, last_seen_at timestamp with time zone, hr_employee_id uuid, employee_code text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  caller_client_id uuid;
  caller_hr_role   text;
BEGIN
  SELECT COALESCE(p.active_client_id, p.client_id), p.hr_role INTO caller_client_id, caller_hr_role
  FROM profiles p WHERE p.id = auth.uid();

  IF COALESCE(
       public.is_admin()
       OR (caller_client_id = p_client_id
           AND (public.is_client_owner() OR caller_hr_role = 'manager')),
       false)
  THEN
    RETURN QUERY
      SELECT p.id, p.full_name, u.email::text, p.hr_role, p.hr_job_title, p.last_seen_at, p.hr_employee_id, e.employee_code
      FROM profiles p
      JOIN auth.users u ON u.id = p.id
      LEFT JOIN hr_employees e ON e.id = p.hr_employee_id
      WHERE p.client_id = p_client_id
        AND p.role = 'client'
        AND p.hr_role IS NOT NULL
      ORDER BY p.full_name;
  END IF;
END;
$function$;

-- ── get_ims_eligible_users ────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_ims_eligible_users(p_client_id uuid)
 RETURNS TABLE(id uuid, full_name text, email text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  caller_client_id uuid;
BEGIN
  SELECT COALESCE(p.active_client_id, p.client_id) INTO caller_client_id FROM profiles p WHERE p.id = auth.uid();

  IF public.is_admin() OR (public.is_client_owner() AND caller_client_id = p_client_id) THEN
    RETURN QUERY
      SELECT p.id, p.full_name, u.email::text
      FROM profiles p
      JOIN auth.users u ON u.id = p.id
      WHERE p.client_id = p_client_id
        AND p.role = 'client'
        AND p.pos_role IS NULL
        AND p.hr_self_service = false
        AND p.ims_role IS NULL
        AND p.hr_role IS NULL
        AND p.id != auth.uid()
      ORDER BY p.full_name;
  END IF;
END;
$function$;

-- ── get_pos_device_secret ─────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_pos_device_secret(p_client_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  caller_client_id uuid;
  caller_pos_role  text;
  v_secret         uuid;
BEGIN
  IF public.is_admin() THEN
    SELECT pos_device_secret INTO v_secret FROM client_secrets WHERE client_id = p_client_id;
    RETURN v_secret;
  END IF;

  SELECT COALESCE(p.active_client_id, p.client_id), p.pos_role INTO caller_client_id, caller_pos_role
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
$function$;

-- ── get_pos_staff_list ────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_pos_staff_list(p_client_id uuid)
 RETURNS TABLE(id uuid, full_name text, pos_role text, pos_job_title text, pos_team text, last_seen_at timestamp with time zone, hr_employee_id uuid, employee_code text, pos_discount_limit numeric, pos_allow_void boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  caller_client_id uuid;
  caller_role text;
BEGIN
  SELECT COALESCE(p.active_client_id, p.client_id), p.role INTO caller_client_id, caller_role
  FROM profiles p WHERE p.id = auth.uid();

  IF caller_role = 'admin' OR caller_client_id = p_client_id THEN
    RETURN QUERY
      SELECT p.id, p.full_name, p.pos_role, p.pos_job_title, p.pos_team, p.last_seen_at,
             p.hr_employee_id, e.employee_code, p.pos_discount_limit, p.pos_allow_void
      FROM profiles p
      LEFT JOIN hr_employees e ON e.id = p.hr_employee_id
      WHERE p.client_id = p_client_id
        AND p.role = 'client'
        AND p.pos_email IS NOT NULL
      ORDER BY p.full_name;
  END IF;
END;
$function$;

-- ── get_ims_staff_list ────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_ims_staff_list(p_client_id uuid)
 RETURNS TABLE(id uuid, full_name text, email text, ims_role text, ims_job_title text, last_seen_at timestamp with time zone, hr_employee_id uuid, employee_code text, has_pin boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  caller_client_id uuid;
  caller_ims_role  text;
BEGIN
  SELECT COALESCE(p.active_client_id, p.client_id), p.ims_role INTO caller_client_id, caller_ims_role
  FROM profiles p WHERE p.id = auth.uid();

  -- Admin, the client Owner, or an IMS MANAGER of that client — the S729 rule (20260910120000):
  -- this list returns every IMS login's real sign-in email. 20260910150000 (S737) re-created the
  -- function to fix its result types and lost the rank check in the copy, so from 2026-09-10 until
  -- this migration any account of the client (a POS PIN waiter, a Self-Service employee) could read
  -- them again. COALESCE: is_admin() / is_client_owner() are NULL for a profile-less session.
  IF COALESCE(
       public.is_admin()
       OR (caller_client_id = p_client_id
           AND (public.is_client_owner() OR caller_ims_role = 'manager')),
       false)
  THEN
    RETURN QUERY
      SELECT p.id::uuid,
             p.full_name::text,
             -- NULL for a PIN account: nobody types the synthetic address, and it is half a
             -- credential, so it has no reason to leave the server.
             (CASE WHEN p.ims_email IS NULL THEN u.email ELSE NULL END)::text,
             p.ims_role::text,
             p.ims_job_title::text,
             p.last_seen_at::timestamptz,
             p.hr_employee_id::uuid,
             e.employee_code::text,
             (p.ims_email IS NOT NULL)::boolean
      FROM profiles p
      JOIN auth.users u ON u.id = p.id
      LEFT JOIN hr_employees e ON e.id = p.hr_employee_id
      WHERE p.client_id = p_client_id
        AND p.role = 'client'
        AND p.ims_role IS NOT NULL
      ORDER BY p.full_name;
  END IF;
END;
$function$;

-- ── get_cooccurrence ──────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_cooccurrence(p_client_id uuid, p_recipe_id uuid, p_days integer DEFAULT 90)
 RETURNS TABLE(paired_recipe_id uuid, co_count bigint, anchor_bills bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_since timestamptz := NOW() - (GREATEST(COALESCE(p_days, 90), 1) || ' days')::INTERVAL;
  v_anchor_bills bigint;
BEGIN
  -- COALESCE(..., false): is_admin() can return NULL, and `NULL OR false` is NULL, which an
  -- `IF NOT` never fires on — the fail-open shape 20260829120000 wrapped this guard for.
  IF NOT COALESCE(
    public.is_admin() OR p_client_id = public.my_client_id(),
    false
  ) THEN
    RAISE EXCEPTION 'not authorized for this client';
  END IF;

  SELECT COUNT(DISTINCT a.order_id) INTO v_anchor_bills
  FROM pos_order_items a
  JOIN pos_orders o ON o.id = a.order_id
  WHERE a.client_id = p_client_id
    AND a.recipe_id = p_recipe_id
    AND o.close_type = 'paid'
    AND o.closed_at >= v_since;

  RETURN QUERY
    SELECT b.recipe_id AS paired_recipe_id,
           COUNT(DISTINCT a.order_id) AS co_count,
           v_anchor_bills AS anchor_bills
    FROM pos_order_items a
    JOIN pos_order_items b ON a.order_id = b.order_id AND a.recipe_id != b.recipe_id
    JOIN pos_orders o ON o.id = a.order_id
    WHERE a.client_id = p_client_id
      AND a.recipe_id = p_recipe_id
      AND o.close_type = 'paid'
      AND o.closed_at >= v_since
    GROUP BY b.recipe_id
    ORDER BY co_count DESC
    LIMIT 10;
END;
$function$;

-- ── get_next_pos_comp_slip_no ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_next_pos_comp_slip_no(p_client_id uuid, p_fy text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  next_no integer;
BEGIN
  IF NOT (
    public.is_admin() OR p_client_id = public.my_client_id()
  ) THEN
    RAISE EXCEPTION 'not authorized for this client';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('pos_comp_slip_no:' || p_client_id::text || ':' || p_fy));
  SELECT COALESCE(MAX(n), 0) + 1 INTO next_no FROM (
    SELECT invoice_no AS n FROM pos_orders WHERE client_id = p_client_id AND invoice_fy = p_fy AND close_type = 'writeoff'
    UNION ALL
    SELECT comp_no AS n FROM pos_order_items WHERE client_id = p_client_id AND comp_fy = p_fy
  ) combined;
  RETURN next_no;
END;
$function$;

-- ── apply_pos_item_comps ──────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.apply_pos_item_comps(p_order_id uuid, p_client_id uuid, p_fy text, p_comp_reason text, p_comped_by uuid, p_full_recipe_ids uuid[], p_partial jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_comp_no integer;
  v_now timestamptz := now();
  v_item jsonb;
  v_order_client uuid;
  v_caller uuid := (SELECT auth.uid());
  v_pos_role text;
  v_comped_by uuid;
BEGIN
  SELECT client_id INTO v_order_client FROM pos_orders WHERE id = p_order_id;
  IF v_order_client IS NULL OR v_order_client <> p_client_id THEN
    RAISE EXCEPTION 'order does not belong to this client';
  END IF;
  -- COALESCE(..., false) is not decoration. A caller with no profiles row makes both operands NULL,
  -- `NULL OR NULL` is NULL, and `IF NOT NULL THEN` does not fire — so the original form of this
  -- check FELL OPEN for exactly the caller it was least sure about. Same trap the codebase already
  -- documents for is_admin() returning NULL.
  IF NOT COALESCE(
    (SELECT role FROM profiles WHERE id = v_caller) = 'admin'
    OR p_client_id = public.my_client_id()
  , false) THEN
    RAISE EXCEPTION 'not authorized for this client';
  END IF;

  -- Rank, mirroring hasPosAccess('supervisor') — the gate the Charge screen's comp panel already
  -- applies in React and the server did not. Admin and the Owner resolve to manager on every axis
  -- (the Owner being the ABSENCE of staff markers, hence is_client_owner()), which is what the
  -- frontend assumes too.
  -- Wrapped for the same reason, and here it matters more: pos_role is NULL for every account with
  -- no POS access at all, and `NULL IN ('supervisor','manager')` is NULL, not false. Without the
  -- COALESCE this rank check would wave through precisely the accounts that have no POS rank.
  SELECT pos_role INTO v_pos_role FROM profiles WHERE id = v_caller;
  IF NOT COALESCE(
    (SELECT role FROM profiles WHERE id = v_caller) = 'admin'
    OR public.is_client_owner()
    OR v_pos_role IN ('supervisor', 'manager')
  , false) THEN
    RAISE EXCEPTION
      'complimentary items require Supervisor access or above'
      USING ERRCODE = '42501';
  END IF;

  -- WHO comped is derived, never accepted. p_comped_by is retained in the signature so an older
  -- bundle still binds to this function, and is deliberately ignored: it feeds comped_by, which is
  -- what the Sales Exception Report ranks staff by, so a caller able to choose it could comp items
  -- under a colleague's name. Admin keeps the parameter, because an admin acting on a client's
  -- behalf is legitimately recording someone else as the comping staff member.
  v_comped_by := CASE
    WHEN COALESCE((SELECT role FROM profiles WHERE id = v_caller) = 'admin', false)
      THEN COALESCE(p_comped_by, v_caller)
    ELSE v_caller
  END;

  PERFORM pg_advisory_xact_lock(hashtext('pos_comp_slip_no:' || p_client_id::text || ':' || p_fy));

  SELECT COALESCE(MAX(n), 0) + 1 INTO v_comp_no FROM (
    SELECT invoice_no AS n FROM pos_orders WHERE client_id = p_client_id AND invoice_fy = p_fy AND close_type = 'writeoff'
    UNION ALL
    SELECT comp_no AS n FROM pos_order_items WHERE client_id = p_client_id AND comp_fy = p_fy
  ) combined;

  -- A fully-comped line (compQty === the line's whole qty) just gets marked comped in place.
  IF p_full_recipe_ids IS NOT NULL AND array_length(p_full_recipe_ids, 1) > 0 THEN
    UPDATE pos_order_items
    SET comped = true, comp_reason = p_comp_reason, comped_by = v_comped_by,
        comped_at = v_now, comp_fy = p_fy, comp_no = v_comp_no
    WHERE order_id = p_order_id AND recipe_id = ANY(p_full_recipe_ids);
  END IF;

  -- A partially-comped line (e.g. 1 of 3) needs splitting: shrink the existing row to the paid
  -- remainder, and insert a new row for the comped portion.
  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_partial, '[]'::jsonb))
  LOOP
    UPDATE pos_order_items
    SET qty = qty - (v_item->>'comp_qty')::integer
    WHERE order_id = p_order_id AND recipe_id = (v_item->>'recipe_id')::uuid;

    INSERT INTO pos_order_items (
      order_id, client_id, recipe_id, name, category, qty, unit_price, vat_rate, sent_to_kot,
      comped, comp_reason, comped_by, comped_at, comp_fy, comp_no
    ) VALUES (
      p_order_id, p_client_id, (v_item->>'recipe_id')::uuid, v_item->>'name', v_item->>'category',
      (v_item->>'comp_qty')::integer, (v_item->>'unit_price')::numeric, (v_item->>'vat_rate')::numeric,
      COALESCE((v_item->>'sent_to_kot')::boolean, false),
      true, p_comp_reason, v_comped_by, v_now, p_fy, v_comp_no
    );
  END LOOP;

  RETURN v_comp_no;
END;
$function$;

-- ── Grants (unchanged) ──────────────────────────────────────────────────────────────────────

REVOKE EXECUTE ON FUNCTION public.get_client_profile_names(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_client_profile_names(uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_hr_role_eligible_users(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_hr_role_eligible_users(uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_hr_role_staff_list(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_hr_role_staff_list(uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_ims_eligible_users(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_ims_eligible_users(uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_pos_device_secret(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_pos_device_secret(uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_pos_staff_list(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_pos_staff_list(uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_ims_staff_list(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_ims_staff_list(uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_cooccurrence(uuid, uuid, integer) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_cooccurrence(uuid, uuid, integer) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_next_pos_comp_slip_no(uuid, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_next_pos_comp_slip_no(uuid, text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.apply_pos_item_comps(uuid, uuid, text, text, uuid, uuid[], jsonb) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.apply_pos_item_comps(uuid, uuid, text, text, uuid, uuid[], jsonb) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
