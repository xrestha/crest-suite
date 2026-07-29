-- get_client_profile_names(p_client_id) only ever returned rows WHERE profiles.client_id =
-- p_client_id. Admin accounts have client_id = NULL (they're not scoped to any one client), so
-- whenever admin performed an action while "viewing as" a client — closing a POS shift, voiding/
-- comping an order, issuing a parking slip or credit note, sending a KOT — the profile id stamped
-- into opened_by/closed_by/comped_by/sent_by/issued_by could never resolve to a name through this
-- function, even though the admin caller already passed the authorization check below. Every such
-- column across Shifts, Exceptions, KOT Log, Parking Slips, Credit Notes, and Sales Report rendered
-- "—" for admin-performed actions. Same signature/return shape as the original — CREATE OR REPLACE
-- is safe here (see CLAUDE.md: only DROP FUNCTION first when the return columns themselves change).
CREATE OR REPLACE FUNCTION public.get_client_profile_names(p_client_id uuid) RETURNS TABLE(id uuid, full_name text)
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
      SELECT p.id, p.full_name FROM profiles p WHERE p.client_id = p_client_id OR p.id = auth.uid();
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
