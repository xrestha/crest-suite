-- ════════════════════════════════════════════════════════════════════════════════════════════
-- S839 step 2: the till floor is crest-v455.
--
-- A till before crest-v455 does not know combos (20261014160000): it reads a combo dish's selection
-- key, which ends '@<combo_line_id>/<combo_group_id>', as option ids, and saves a bill holding a combo
-- without the combo's tag, so the server would price its dishes as new plain lines. It also spreads a
-- bill discount over a combo's dishes, which the close now refuses. pos_min_till_build() returning 455
-- makes every older till reload before its next write (pos_till_build_gate, S809 1b).
--
-- Apply only once Vercel reports crest-v455 deployed: raised first, every till is refused with nothing
-- newer to load. Section 0 refuses unless step 1 (20261014160000) is live.
--
-- Built on the live body, md5(prosrc), read 2026-10-14: pos_min_till_build
-- b4d6b2c0b89b5756c577aa9a4bcefd19 (20261014130000, 452). Signature, return type and grants are
-- unchanged, so CREATE OR REPLACE keeps them.
--
-- To undo: re-run pos_min_till_build from 20261014130000 (452).
-- ════════════════════════════════════════════════════════════════════════════════════════════


-- ── 0. Pre-flight ──────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.pos_min_till_build()'::regprocedure;
  IF v_md5 IS NULL OR v_md5 <> 'b4d6b2c0b89b5756c577aa9a4bcefd19' THEN
    RAISE EXCEPTION 'S839 step 2 pre-flight: pos_min_till_build changed since this was written (md5 %).', v_md5;
  END IF;
  IF to_regprocedure('public.save_pos_combo(jsonb)') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'pos_order_items' AND column_name = 'combo_line_id') THEN
    RAISE EXCEPTION 'S839 step 2 pre-flight: 20261014160000 is not live — apply it (and deploy crest-v455) first';
  END IF;
END;
$$;


-- ── 1. The till floor: crest-v455 ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.pos_min_till_build()
RETURNS integer
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT 455
$$;


-- ── 2. What this file changed, live (the last statement, so `db query` prints it) ────────────
SELECT public.pos_min_till_build() AS till_floor;
