-- Multiple reports (Sales Report, Sales Exceptions, Shift History, KOT Log, Credit Notes, the
-- viewPosBill drill-down) need to resolve a closed_by/comped_by/sent_by/opened_by profile id to
-- a display name. They were all doing this with a raw `supabase.from('profiles').eq('client_id',
-- ...)` query — but profiles_select RLS only allows `id = auth.uid() OR is_admin()`, so for any
-- real (non-admin) client login, that query silently returned rows for nobody but the caller's
-- own profile. Every other staff member's name rendered as "—".
--
-- get_pos_staff_list() already exists as a SECURITY DEFINER escape hatch, but it deliberately
-- filters to `pos_email IS NOT NULL` (PIN-based POS staff only) for the Staff Management page —
-- an Owner logs in with a normal email/password, not a generated pos_email, so they'd still be
-- missing from that list. This is a broader, unfiltered version for name-resolution purposes.
CREATE FUNCTION public.get_client_profile_names(p_client_id uuid) RETURNS TABLE(id uuid, full_name text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  caller_client_id uuid;
  caller_role text;
BEGIN
  SELECT p.client_id, p.role INTO caller_client_id, caller_role FROM profiles p WHERE p.id = auth.uid();
  IF caller_role = 'admin' OR caller_client_id = p_client_id THEN
    RETURN QUERY
      SELECT p.id, p.full_name FROM profiles p WHERE p.client_id = p_client_id;
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
