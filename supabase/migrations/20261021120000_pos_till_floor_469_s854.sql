-- ════════════════════════════════════════════════════════════════════════════════════════════
-- S854 step 2: the till floor is crest-v469.
--
-- A till before crest-v469 does not know booking deposits (20261021110000). Its payment window never
-- shows the Deposit line, and its close path treats any payment line already on a bill that is not a
-- points line as "the legs already landed", so a Split bill another till put a Deposit line on would
-- close short of its other legs. pos_min_till_build() returning 469 makes every older till reload
-- before its next write (pos_till_build_gate, S809 1b).
--
-- Apply only once Vercel reports crest-v469 deployed: raised first, every till is refused with nothing
-- newer to load. Section 0 refuses unless step 1 (20261021110000) is live.
--
-- Built on the live body, md5(prosrc), as 20261014170000 left it: pos_min_till_build
-- a3a7c481ad91503d3c9006ce6bd20d8c (455). The second hash is this file own body (469), so a re-run
-- passes. Signature, return type and grants are unchanged, so CREATE OR REPLACE keeps them.
--
-- To undo: re-run pos_min_till_build from 20261014170000 (455).
-- ════════════════════════════════════════════════════════════════════════════════════════════


-- ── 0. Pre-flight ──────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.pos_min_till_build()'::regprocedure;
  IF v_md5 IS NULL OR v_md5 NOT IN ('a3a7c481ad91503d3c9006ce6bd20d8c', 'f98f56f2646eb0b9394169eb3551d678') THEN
    RAISE EXCEPTION 'S854 step 2 pre-flight: pos_min_till_build changed since this was written (md5 %).', v_md5;
  END IF;
  IF to_regprocedure('public.apply_booking_deposit(uuid, numeric)') IS NULL
     OR to_regclass('public.pos_booking_deposits') IS NULL THEN
    RAISE EXCEPTION 'S854 step 2 pre-flight: 20261021110000 is not live — apply it (and deploy crest-v469) first';
  END IF;
END;
$$;


-- ── 1. The till floor: crest-v469 ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.pos_min_till_build()
RETURNS integer
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT 469
$$;


-- ── 2. What this file changed, live (the last statement, so `db query` prints it) ────────────
SELECT public.pos_min_till_build() AS till_floor;
