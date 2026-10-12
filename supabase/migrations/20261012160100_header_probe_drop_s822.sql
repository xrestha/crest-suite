-- ════════════════════════════════════════════════════════════════════════════════════════════
-- S822, POS stage 5, slice 5b, step 2 of 3: drop the header probe 20261012160000 created, once its
-- curl calls are read. What it showed is recorded in 20261012170000's header and the S822 CHANGELOG
-- entry (the shape of each header, never a real address).
-- ════════════════════════════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS public.crest_header_probe_s822();

NOTIFY pgrst, 'reload schema';

DO $$
BEGIN
  IF to_regprocedure('public.crest_header_probe_s822()') IS NOT NULL THEN
    RAISE EXCEPTION 'S822 probe: crest_header_probe_s822() is still there';
  END IF;
END;
$$;

SELECT to_regprocedure('public.crest_header_probe_s822()') IS NULL AS probe_gone;
