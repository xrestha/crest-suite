-- ════════════════════════════════════════════════════════════════════════════════════════════
-- S822, POS stage 5, slice 5b, step 1 of 3: a throwaway header probe. Dropped by 20261012160100
-- about a minute after this is applied; nothing else calls it.
--
--   Two questions that only a real call through Supabase's gateway can answer:
--     (1) A2: submit_reservation_request keys its per-connection booking limit on the FIRST hop of
--         x-forwarded-for, which the caller can set. What does the gateway do to a caller's own
--         x-forwarded-for (keep it, append to it, replace it), and is there an address it sets that a
--         caller cannot (x-real-ip, cf-connecting-ip, ...)? That decides 5b's rate-limit key.
--     (2) S809 1b: does x-crest-build reach request.headers? pos_till_build_gate reads it, but the
--         floor has been NULL since 1b, so no live call has ever shown it arriving. That decides
--         whether 5c raises pos_min_till_build().
--
--   crest_header_probe_s822() returns the names of the headers on the call that reached it, and the
--   values of every one except authorization, apikey, cookie and anything named like a key, token,
--   secret or auth. A caller sees only what its own request carried. anon only (the booking page's
--   role), called over /rest/v1/rpc/ with curl: once plain, once with a made-up x-forwarded-for and
--   x-crest-build, once with a made-up two-address chain plus a made-up x-real-ip and cf-connecting-ip.
--   The made-up addresses are from the documentation ranges (198.51.100.0/24, 203.0.113.0/24).
--
-- No table, policy or existing function is touched. To undo: 20261012160100 (DROP FUNCTION).
-- ════════════════════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.crest_header_probe_s822()
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
           'role',   current_user,
           'names',  (SELECT jsonb_agg(k ORDER BY k) FROM json_object_keys(s.h) k),
           'values', (SELECT jsonb_object_agg(e.key, e.value)
                        FROM json_each_text(s.h) e
                       WHERE e.key !~ '(authorization|apikey|cookie|key|token|secret|auth)'))
    FROM (SELECT NULLIF(current_setting('request.headers', true), '')::json AS h) s
$$;

COMMENT ON FUNCTION public.crest_header_probe_s822() IS
  'S822 5b throwaway: echoes the caller''s own request headers (secrets left out). Dropped by 20261012160100.';

REVOKE ALL ON FUNCTION public.crest_header_probe_s822() FROM PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION public.crest_header_probe_s822() TO anon;

NOTIFY pgrst, 'reload schema';

-- ── Prove it before any call: the secrets stay out, the rest comes back ────────────────────────
DO $$
DECLARE
  v jsonb;
BEGIN
  PERFORM set_config('request.headers',
    '{"x-forwarded-for":"198.51.100.7","x-crest-build":"crest-v999","authorization":"Bearer x","apikey":"y","cookie":"z"}', true);
  v := public.crest_header_probe_s822();
  PERFORM set_config('request.headers', '', true);
  IF v->'values'->>'x-forwarded-for' IS DISTINCT FROM '198.51.100.7'
     OR v->'values'->>'x-crest-build' IS DISTINCT FROM 'crest-v999' THEN
    RAISE EXCEPTION 'S822 probe: the echo lost a header: %', v;
  END IF;
  IF v->'values' ?| ARRAY['authorization', 'apikey', 'cookie'] THEN
    RAISE EXCEPTION 'S822 probe: the echo returned a secret header';
  END IF;
  IF NOT has_function_privilege('anon', 'public.crest_header_probe_s822()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.crest_header_probe_s822()', 'EXECUTE') THEN
    RAISE EXCEPTION 'S822 probe: grants are not anon-only';
  END IF;
END;
$$;

SELECT has_function_privilege('anon', 'public.crest_header_probe_s822()', 'EXECUTE') AS anon_can_call,
       has_function_privilege('authenticated', 'public.crest_header_probe_s822()', 'EXECUTE') AS authenticated_can_call;
