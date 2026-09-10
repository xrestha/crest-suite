-- ════════════════════════════════════════════════════════════════════════════════════════════
-- Fix: get_ims_staff_list raised 42804 for every caller (S737 follow-up).
--
-- S737 rebuilt this function to add `has_pin` and to return NULL instead of the synthetic
-- *.ims.internal address for a PIN account. It shipped raising
--
--     42804 · structure of query does not match function result type
--
-- on every call — so IMS → IMS Staff and Stock Count → Settings both rendered their failed-read
-- card instead of the staff list. Nothing was lost and nothing was written; the page could not
-- read.
--
-- ── The cause: plpgsql compares the tuple descriptors by EXACT type OID ──────────────────────
-- RETURN QUERY runs the result through tupledesc_match(), which raises 42804 when an attribute's
-- type OID differs from the declared one — even where the two are binary-coercible, as
-- character varying and text are. `auth.users.email` is varchar, and wrapping it in
-- `CASE ... THEN u.email ELSE NULL END` is enough to change how that column presents. Rather than
-- depend on which way any one column resolves, every column is now cast explicitly to the type
-- the signature declares. That is a property of the statement rather than of the schema
-- underneath it, so it cannot come back if GoTrue changes a column type.
--
-- ── The real lesson: the S737 verification block PASSED, and could not have failed ───────────
-- That migration ended in a DO block that called each new function once, precisely so a body that
-- does not type-check aborts the migration instead of surfacing on a live page. It called this
-- one too. It passed — because in the SQL editor auth.uid() is NULL, so the caller check inside
-- the function was false and RETURN QUERY NEVER RAN. The block proved the function could be
-- entered, not that its body works.
--
-- **A guarded function is not exercised by calling it as a caller the guard rejects.** That is
-- the S735 trap ("a plpgsql body is not validated at CREATE time") one layer along: S735 is about
-- CREATE not checking the body, this is about a CALL not reaching it. Where the body is behind an
-- authorisation check, the verification has to run the body some other way — below, a scratch
-- function holding the identical SELECT and the identical RETURNS TABLE, called and dropped in
-- the same transaction. If the types disagree, THIS migration fails, which is what the last one
-- was supposed to do.
-- ════════════════════════════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS public.get_ims_staff_list(uuid);

CREATE FUNCTION public.get_ims_staff_list(p_client_id uuid) RETURNS TABLE(
    id uuid, full_name text, email text, ims_role text, ims_job_title text,
    last_seen_at timestamp with time zone, hr_employee_id uuid, employee_code text,
    has_pin boolean
) LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  caller_client_id uuid;
  caller_role text;
BEGIN
  SELECT p.client_id, p.role INTO caller_client_id, caller_role
  FROM profiles p WHERE p.id = auth.uid();

  IF COALESCE(caller_role = 'admin' OR caller_client_id = p_client_id, false) THEN
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
$$;

REVOKE EXECUTE ON FUNCTION public.get_ims_staff_list(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_ims_staff_list(uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

-- ── Verification that actually reaches the body ─────────────────────────────────────────────
-- Same RETURNS TABLE, same SELECT, no caller check — so RETURN QUERY really executes and the
-- tuple descriptors really are compared. Dropped immediately; it exists only for this assertion.
DO $$
DECLARE
  n integer;
  t text;
BEGIN
  -- Print the SOURCE types first. On a pass this records the ground truth for the next reader; on
  -- a failure it is the diagnosis, since plpgsql's 42804 names no column.
  SELECT string_agg(format('%s.%s = %s', table_schema, column_name, data_type), ', ' ORDER BY column_name)
    INTO t
  FROM information_schema.columns
  WHERE (table_schema = 'auth'   AND table_name = 'users'        AND column_name = 'email')
     OR (table_schema = 'public' AND table_name = 'profiles'     AND column_name IN ('full_name','ims_role','ims_job_title','ims_email'))
     OR (table_schema = 'public' AND table_name = 'hr_employees' AND column_name = 'employee_code');
  RAISE NOTICE 'get_ims_staff_list source column types: %', t;

  CREATE FUNCTION pg_temp.assert_ims_staff_list_types() RETURNS TABLE(
      id uuid, full_name text, email text, ims_role text, ims_job_title text,
      last_seen_at timestamp with time zone, hr_employee_id uuid, employee_code text,
      has_pin boolean
  ) LANGUAGE plpgsql
      SET search_path TO 'public'
      AS $inner$
  BEGIN
    RETURN QUERY
      SELECT p.id::uuid,
             p.full_name::text,
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
      WHERE p.role = 'client'
        AND p.ims_role IS NOT NULL
      ORDER BY p.full_name;
  END;
  $inner$;

  -- Runs over EVERY client's IMS staff, so it fails on real rows rather than on an empty set.
  -- A count of 0 is still a pass: the tuple descriptor is checked when the query is executed,
  -- not when a row is returned.
  SELECT count(*) INTO n FROM pg_temp.assert_ims_staff_list_types();
  RAISE NOTICE 'get_ims_staff_list type check OK over % IMS staff row(s)', n;

  DROP FUNCTION pg_temp.assert_ims_staff_list_types();
END $$;

-- After applying, confirm the real function answers rather than raising. Signed in as an Owner or
-- an admin in the app, IMS -> IMS Staff must list the team; from the SQL editor the guard is false
-- (auth.uid() is NULL there) so it correctly returns zero rows, which is why the block above
-- exists at all:
--
--   SELECT count(*) FROM public.get_ims_staff_list('<a real client uuid>');  -- expect 0 here, no error
