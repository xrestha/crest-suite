-- ════════════════════════════════════════════════════════════════════════════════════════════
-- S836 step 2: the till floor is crest-v452.
--
-- A till before crest-v452 frees the table on its own screen when it closes a bill. Since
-- 20261014120000 a bill can move to another table on another till, so that table may now be another
-- party's: the database frees the right tables itself (pos_orders_release_tables), and crest-v452 no
-- longer frees any. An older page also shows a moved bill under its old table and cannot open a
-- joined table's bill. pos_min_till_build() returning 452 makes every older till reload before its
-- next write (pos_till_build_gate, S809 1b).
--
-- Apply only once Vercel reports crest-v452 deployed: raised first, every till is refused with nothing
-- newer to load. Section 0 refuses unless step 1 (20261014120000) is live.
--
-- Built on the live body, md5(prosrc), read 2026-10-14: pos_min_till_build
-- ba2522796b17071a3162b60457f28191 (20261013210000, 448). Signature, return type and grants are
-- unchanged, so CREATE OR REPLACE keeps them.
--
-- To undo: re-run pos_min_till_build from 20261013210000 (448).
-- ════════════════════════════════════════════════════════════════════════════════════════════


-- ── 0. Pre-flight ──────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.pos_min_till_build()'::regprocedure;
  IF v_md5 IS NULL OR v_md5 NOT IN ('ba2522796b17071a3162b60457f28191', 'b4d6b2c0b89b5756c577aa9a4bcefd19') THEN
    RAISE EXCEPTION 'S836 step 2 pre-flight: pos_min_till_build changed since this was written (md5 %).', v_md5;
  END IF;
  IF to_regprocedure('public.move_pos_order_table(uuid, uuid, integer)') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.pos_orders'::regclass AND tgname = 'pos_orders_release_tables_close') THEN
    RAISE EXCEPTION 'S836 step 2 pre-flight: 20261014120000 is not live — apply it (and deploy crest-v452) first';
  END IF;
END;
$$;


-- ── 1. The till floor: crest-v452 ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.pos_min_till_build()
RETURNS integer
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT 452
$$;


-- ── 2. What this file changed, live (the last statement, so `db query` prints it) ────────────
SELECT
  public.pos_min_till_build() AS till_floor,
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.pos_min_till_build()'::regprocedure) = 'b4d6b2c0b89b5756c577aa9a4bcefd19' AS floor_body_ok;
