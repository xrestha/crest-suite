-- Security Advisor review (2026-07-28) found get_hr_self_service_staff(p_client_id uuid) had NO
-- caller check at all -- not even the "is this an unguessable id" mitigation the 20260712210000
-- hardening pass believed applied. It returned every hr_self_service employee's full_name AND
-- hr_self_service_email to a fully anonymous caller for ANY p_client_id.
--
-- That 20260712210000 migration reviewed this function and get_pos_staff together and left both
-- alone, reasoning the client_id was "unguessable." One day later, 20260713010859 found that
-- reasoning FALSE for get_pos_staff specifically -- pos_device_client_id sits in a device's
-- localStorage, readable by anyone with devtools access to that terminal -- and fixed it by
-- requiring a real per-client secret (pos_device_secret) as a second parameter, verified
-- server-side. get_hr_self_service_staff was never revisited.
--
-- It is actually WORSE here than the original get_pos_staff bug: SelfServiceLogin.jsx's own
-- comment says the client_id comes from a URL the admin hands their ENTIRE STAFF as a QR code
-- or link, by design -- the "secret" is deliberately mass-distributed, not something requiring
-- any technical extraction. Anyone who has ever seen that link, or a forward/screenshot of it,
-- could call this RPC with zero login and pull back every enrolled employee's name and, worse,
-- their actual sign-in email -- confirmed to be transmitted even though the picker UI
-- (SelfServiceLogin.jsx) never displays it; the email is fetched purely so the OLD client-side
-- flow could pass it straight into supabase.auth.signInWithPassword().
--
-- Two fixes, paired with the new hr-selfservice-login Edge Function (moves the actual sign-in
-- server-side so the email never has to reach the browser at all):
--
-- 1. Drop hr_self_service_email from this function's return entirely. What remains (id,
--    full_name) is the same risk class the project already accepts for get_guest_menu/
--    get_pos_staff-style pre-auth pickers -- a name is not a working credential. Deliberately NOT
--    adding a get_pos_staff-style secondary secret: that mechanism works for POS because a
--    device is activated once and the secret then stays private to that one terminal, but HR
--    self-service links are mass-distributed to a whole staff by design -- a shared "self-service
--    secret" would face the exact same distribution problem the client_id already has, so it
--    would not meaningfully raise the bar. The actual fix is removing the sensitive column at
--    the source, not gating access to it.
-- 2. Move it off the default PUBLIC execute grant onto an explicit anon/authenticated grant,
--    matching every other hardened function in this project (REVOKE FROM PUBLIC is the only
--    reliable form -- REVOKE FROM a specific role silently no-ops while PUBLIC still holds it,
--    S-2026-07-20).

CREATE OR REPLACE FUNCTION public.get_hr_self_service_staff(p_client_id uuid) RETURNS TABLE(
    id uuid, full_name text
) LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT id, full_name
  FROM profiles
  WHERE client_id = p_client_id AND hr_self_service = true AND hr_self_service_email IS NOT NULL
  ORDER BY full_name;
$$;

REVOKE EXECUTE ON FUNCTION public.get_hr_self_service_staff(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_hr_self_service_staff(uuid) TO anon, authenticated, service_role;

-- Verify the revoke actually took (a silent no-op here is exactly the failure this project has
-- hit before -- S-2026-07-20). Expect PUBLIC's default gone; anon/authenticated/service_role
-- explicitly present.
DO $$
BEGIN
  IF has_function_privilege('anon', 'public.get_hr_self_service_staff(uuid)', 'EXECUTE') IS NOT TRUE THEN
    RAISE EXCEPTION 'anon lost EXECUTE on get_hr_self_service_staff -- the pre-login staff picker would break';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
