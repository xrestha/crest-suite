-- ════════════════════════════════════════════════════════════════════════════════════════════
-- S843 follow-up: pos_credit_party_key runs as its owner.
--
-- Found by the post-apply probe of 20261015120000 (a rolled-back DO block acting as BLOOM CAFE's
-- Owner): pos_credit_open_bills and pos_credit_party_events are SECURITY INVOKER, they call
-- pos_credit_party_key, and that calls pos_phone_canonical — which has NO client grant
-- (20261010110000 revoked it from PUBLIC, anon, authenticated and service_role, because until now
-- only DEFINER bodies and a generated column called it). So every signed-in read of what a customer
-- owes failed with 42501 "permission denied for function pos_phone_canonical". No screen calls the
-- two readers yet (the S843 frontend is not deployed), so nothing a user saw was affected.
--
-- The fix keeps pos_phone_canonical exactly as it is and makes the key function SECURITY DEFINER:
-- it is a pure function of its three arguments (IMMUTABLE, search_path pinned), reads no table, and
-- already has EXECUTE only for authenticated and service_role (anon and PUBLIC revoked), so running
-- as its owner widens nothing. ALTER FUNCTION keeps its grants and body.
--
-- To undo: ALTER FUNCTION public.pos_credit_party_key(text, text, text) SECURITY INVOKER; (the two
-- readers then fail for every login again).
-- ════════════════════════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF to_regprocedure('public.pos_credit_party_key(text, text, text)') IS NULL THEN
    RAISE EXCEPTION 'S843 follow-up pre-flight: pos_credit_party_key is missing — apply 20261015120000 first';
  END IF;
END;
$$;

ALTER FUNCTION public.pos_credit_party_key(text, text, text) SECURITY DEFINER;

DO $$
BEGIN
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.pos_credit_party_key(text, text, text)'::regprocedure)
     OR (SELECT provolatile FROM pg_proc WHERE oid = 'public.pos_credit_party_key(text, text, text)'::regprocedure) <> 'i'
     OR has_function_privilege('anon', 'public.pos_credit_party_key(text, text, text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.pos_credit_party_key(text, text, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.pos_phone_canonical(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'S843 follow-up assert: pos_credit_party_key or pos_phone_canonical is not as intended';
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';

SELECT prosecdef AS party_key_definer FROM pg_proc WHERE oid = 'public.pos_credit_party_key(text, text, text)'::regprocedure;
