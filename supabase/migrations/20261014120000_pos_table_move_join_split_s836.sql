-- ════════════════════════════════════════════════════════════════════════════════════════════
-- S836, POS table move, join and split (POS_TODO.md A, the owner's first-ranked build), the
-- server half. Owner decisions 2026-10-14: a joined table stays taken, linked to the one bill,
-- until that bill closes; the splits are "pay part now" (its own bill and invoice) and "move
-- dishes to a table" (an equal split is one bill and printed share slips, no server change); any
-- POS login may move, join or split, and every move is recorded with who and when; the kitchen is
-- told by a move slip and its screen (the app's half).
--
--   (1) pos_orders.part_of_order_id: a part bill (its own invoice) split off an open bill. It has
--       no table (table_id NULL, table_name the table's), so "one open bill per table" stands.
--   (2) pos_table_joins: a table joined to another table's open bill. One row per joined table;
--       it goes when that bill closes or is cleared (pos_orders_release_tables).
--   (3) pos_table_moves: the record. Every move, join, release, dish move, part bill and put-back,
--       with the lines and their sent counts, who and when. Written only by the functions below
--       (and the operator's restore). The kitchen's sums read it: food sent and then moved to
--       another bill is still owed by the ticket that carried it (pos_moved_out_sent).
--   (4) Six functions, SECURITY DEFINER, any POS rank of the bill's outlet (pos_caller_has_rank
--       'staff'): move_pos_order_table, join_pos_tables, release_joined_table,
--       move_pos_order_lines, split_pos_part_bill, put_back_part_bill. Each locks its bills in id
--       order and then its tables, refuses a bill another device changed (stale_order on
--       items_version, as save_pos_order_items does), moves lines with their price, choices
--       snapshot and sent count (sent units first), and bumps items_version on every bill it
--       touches, so a till holding the old view is refused its next save or close and reloads.
--       A dish already on the receiving bill becomes one line with it, at the LOWER of the two
--       prices (owner default: a guest never pays more than either bill asked).
--   (5) A join takes over the absorbed bill: its lines, kitchen tickets, pulled-item records,
--       guest orders, seated bookings and part bills move to the bill that stays, and the emptied
--       bill is deleted (its number lives on in the record and on its tickets). Refused while it
--       holds loyalty points.
--   (6) guard_pos_order_close: a client session can no longer move an open order by PATCHing
--       table_id/table_name (ignored, not refused). guard_pos_order_insert: no new order on a
--       joined table (pos_table_joined); a client cannot make a part bill. guard_pos_kot_log: a
--       join may re-point tickets (crest.pos_table_join_rpc), and the kitchen's Clear counts food
--       moved to another bill as still owed.
--   (7) pos_orders_release_tables: closing or clearing a bill frees its table and its joined
--       tables (when no other open bill holds them) and turns away the joined tables' waiting
--       guest orders. The till freed only the table on its screen, which after a move elsewhere
--       could be another party's.
--   (8) get_group_summary counts a part bill's guests as seated, as coversMath.isDineIn does from
--       crest-v452: it has no table of its own, but it was served at one.
--
-- Built on the live bodies, md5(prosrc), read 2026-10-14: guard_pos_order_close
-- 93873af6cdb5452c412396e829e8d41a (20261013100000), guard_pos_order_insert
-- becdecf2d6d114379a735e44749b3e73 (20261014110000), guard_pos_kot_log
-- 2d7855019e27b458a526c7da0dbef297 (20261012140000), get_group_summary
-- b2aee04b499dbb3ce5bc29bb0f56b2d9 (20261010170000). Each is patched FROM ITS LIVE DEFINITION
-- by exact text replacement (pg_temp.s836_patch refuses unless each old text occurs exactly
-- once). Section 0 accepts the live hash or the one this file writes, so a re-run passes.
--
-- The app is crest-v452. Nothing here breaks an older till: the new column, tables and functions
-- are unused by it. But an older till frees the table on its screen at a close, which after a
-- move may be another party's, so 20261014130000 raises the till floor to 452 AFTER crest-v452
-- is deployed. admin-user-ops is redeployed with the two new tables in deleteClientDataFor.
--
-- To undo: DROP the six functions, pos_move_lines(uuid, uuid, jsonb), pos_merge_line(uuid),
-- pos_moved_out_sent(uuid, text), pos_move_check_rank(), pos_move_check_order(pos_orders,
-- integer, text), pos_move_check_table(pos_tables); DROP TRIGGER pos_orders_release_tables_close
-- and pos_orders_release_tables_delete ON pos_orders and DROP FUNCTION
-- pos_orders_release_tables(); re-create the three patched guards and get_group_summary from the
-- files named above;
-- DROP TABLE pos_table_joins, pos_table_moves (and their guard functions); ALTER TABLE pos_orders
-- DROP COLUMN part_of_order_id.
--
-- The probe (section 11) acts at BLOOM CAFE (or the first POS outlet with an unblocked POS till
-- login) as the migration's role and as that login, made a plain Staff-rank login inside a block
-- that rolls itself back. It closes two probe bills (taking the outlet's invoice-number lock for
-- a moment). If any check fails, nothing lands.
-- ════════════════════════════════════════════════════════════════════════════════════════════


-- ── 0. Pre-flight ──────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.guard_pos_order_close()'::regprocedure;
  IF v_md5 IS NULL OR v_md5 NOT IN ('93873af6cdb5452c412396e829e8d41a', 'ad92a74549be6bf5a06d7d93172935b2') THEN
    RAISE EXCEPTION 'S836 pre-flight: guard_pos_order_close changed since this was written (md5 %). Rebuild from the live body.', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.guard_pos_order_insert()'::regprocedure;
  IF v_md5 IS NULL OR v_md5 NOT IN ('becdecf2d6d114379a735e44749b3e73', '9a861b3c577ee0cab90cde9986b999bc') THEN
    RAISE EXCEPTION 'S836 pre-flight: guard_pos_order_insert changed since this was written (md5 %). Rebuild from the live body.', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.guard_pos_kot_log()'::regprocedure;
  IF v_md5 IS NULL OR v_md5 NOT IN ('2d7855019e27b458a526c7da0dbef297', 'ef5b2f1f772675e7839f3a05edc6600e') THEN
    RAISE EXCEPTION 'S836 pre-flight: guard_pos_kot_log changed since this was written (md5 %). Rebuild from the live body.', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.get_group_summary(integer, integer, date, date)'::regprocedure;
  IF v_md5 IS NULL OR v_md5 NOT IN ('b2aee04b499dbb3ce5bc29bb0f56b2d9', 'dc7e1fd26ce0186a282c10d144f5c407') THEN
    RAISE EXCEPTION 'S836 pre-flight: get_group_summary changed since this was written (md5 %). Rebuild from the live body.', v_md5;
  END IF;
END;
$$;

-- The patcher: one exact replacement, refused unless the old text occurs exactly once.
CREATE OR REPLACE FUNCTION pg_temp.s836_patch(p_src text, p_old text, p_new text)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_n integer;
BEGIN
  v_n := (length(p_src) - length(replace(p_src, p_old, ''))) / length(p_old);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'S836 patch: expected the old text once, found it % time(s): %', v_n, left(p_old, 120);
  END IF;
  RETURN replace(p_src, p_old, p_new);
END;
$$;


-- ── 1. A part bill, the joined tables and the record ─────────────────────────────────────────
-- (1) A part bill points at the bill it was split off. SET NULL: that bill may be cleared while
-- the part bill waits (the part bill is then paid on its own). Indexed for the floor and the
-- put-back.
ALTER TABLE public.pos_orders
  ADD COLUMN IF NOT EXISTS part_of_order_id uuid REFERENCES public.pos_orders(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS pos_orders_part_of_order_idx
  ON public.pos_orders (part_of_order_id) WHERE part_of_order_id IS NOT NULL;

-- (2) A table joined to another table's open bill. UNIQUE (table_id): a table is on one bill. The
-- surrogate id is for the backup (every restored table carries one). The table and the bill both
-- CASCADE: a join means nothing without either, and Danger Zone deletes tables after bills.
-- joined_by and moved_by (below) point at profiles, SET NULL, so pos_login_reference_columns()
-- counts them: POS Staff will not delete a login whose name these records still carry.
CREATE TABLE IF NOT EXISTS public.pos_table_joins (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  table_id  uuid NOT NULL UNIQUE REFERENCES public.pos_tables(id) ON DELETE CASCADE,
  order_id  uuid NOT NULL REFERENCES public.pos_orders(id) ON DELETE CASCADE,
  joined_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  joined_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pos_table_joins_order_idx ON public.pos_table_joins (order_id);

-- (3) The record. The bills are SET NULL (a joined or put-back bill is deleted; its number and
-- table stay here as written); the tables are names as they were, not links.
CREATE TABLE IF NOT EXISTS public.pos_table_moves (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('move', 'join', 'release', 'move_dishes', 'part_bill', 'part_back')),
  from_order_id   uuid REFERENCES public.pos_orders(id) ON DELETE SET NULL,
  to_order_id     uuid REFERENCES public.pos_orders(id) ON DELETE SET NULL,
  from_order_no   integer,
  to_order_no     integer,
  from_table_id   uuid,
  from_table_name text,
  to_table_id     uuid,
  to_table_name   text,
  lines           jsonb NOT NULL DEFAULT '[]'::jsonb,
  covers_moved    integer,
  moved_by        uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  moved_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pos_table_moves_from_order_idx ON public.pos_table_moves (from_order_id) WHERE from_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS pos_table_moves_to_order_idx   ON public.pos_table_moves (to_order_id)   WHERE to_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS pos_table_moves_client_moved_idx ON public.pos_table_moves (client_id, moved_at);

-- RLS: one permissive FOR ALL per table, my_client_id() (never its body), every operand wrapped.
ALTER TABLE public.pos_table_joins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_table_moves ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pos_table_joins_client ON public.pos_table_joins;
CREATE POLICY pos_table_joins_client ON public.pos_table_joins
  TO authenticated
  USING (COALESCE(client_id = (SELECT public.my_client_id()) OR (SELECT public.is_admin()), false))
  WITH CHECK (COALESCE(client_id = (SELECT public.my_client_id()) OR (SELECT public.is_admin()), false));

DROP POLICY IF EXISTS pos_table_moves_client ON public.pos_table_moves;
CREATE POLICY pos_table_moves_client ON public.pos_table_moves
  TO authenticated
  USING (COALESCE(client_id = (SELECT public.my_client_id()) OR (SELECT public.is_admin()), false))
  WITH CHECK (COALESCE(client_id = (SELECT public.my_client_id()) OR (SELECT public.is_admin()), false));

-- Staff-account isolation, the trio every pos_* business table carries. POS PIN staff are not
-- fenced out: the floor reads the joins, and any POS login may move a table.
DO $do$
DECLARE
  v_t text;
BEGIN
  FOREACH v_t IN ARRAY ARRAY['pos_table_joins', 'pos_table_moves'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS no_self_service_accounts ON public.%I', v_t);
    EXECUTE format('DROP POLICY IF EXISTS no_ims_staff ON public.%I', v_t);
    EXECUTE format('DROP POLICY IF EXISTS no_hr_role_staff ON public.%I', v_t);
    EXECUTE format('CREATE POLICY no_self_service_accounts ON public.%I AS RESTRICTIVE FOR ALL USING (NOT public.is_hr_self_service()) WITH CHECK (NOT public.is_hr_self_service())', v_t);
    EXECUTE format('CREATE POLICY no_ims_staff ON public.%I AS RESTRICTIVE FOR ALL USING (NOT public.is_ims_staff()) WITH CHECK (NOT public.is_ims_staff())', v_t);
    EXECUTE format('CREATE POLICY no_hr_role_staff ON public.%I AS RESTRICTIVE FOR ALL USING (NOT public.is_hr_role_staff()) WITH CHECK (NOT public.is_hr_role_staff())', v_t);
  END LOOP;
END;
$do$;

-- Raw-SQL tables get no role grants here. authenticated reads both, and INSERTs only for the
-- operator's restore (the guards below refuse every other client write). No UPDATE or DELETE:
-- the functions are DEFINER, and Danger Zone is the service role.
GRANT SELECT, INSERT ON public.pos_table_joins TO authenticated;
GRANT SELECT, INSERT ON public.pos_table_moves TO authenticated;
GRANT ALL ON public.pos_table_joins TO service_role;
GRANT ALL ON public.pos_table_moves TO service_role;

-- Written only by the functions (DEFINER, so current_user is the owner and passes), the service
-- role, a cascade, and the operator's restore of rows dated before the restore (S819's shape).
CREATE OR REPLACE FUNCTION public.guard_pos_table_moves()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'INSERT' AND COALESCE(public.is_admin(), false) AND COALESCE(NEW.moved_at < now(), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'pos_table_move_direct: the record of a table move is written by the move itself — it cannot be written, changed or deleted directly'
    USING ERRCODE = '42501', HINT = 'pos_table_move_direct';
END;
$fn$;
REVOKE ALL ON FUNCTION public.guard_pos_table_moves() FROM PUBLIC;
DROP TRIGGER IF EXISTS guard_pos_table_moves ON public.pos_table_moves;
CREATE TRIGGER guard_pos_table_moves
  BEFORE INSERT OR UPDATE OR DELETE ON public.pos_table_moves
  FOR EACH ROW EXECUTE FUNCTION public.guard_pos_table_moves();

CREATE OR REPLACE FUNCTION public.guard_pos_table_joins()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'INSERT' AND COALESCE(public.is_admin(), false) AND COALESCE(NEW.joined_at < now(), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'pos_table_join_direct: tables are joined and released from the order screen — a join cannot be written, changed or deleted directly'
    USING ERRCODE = '42501', HINT = 'pos_table_join_direct';
END;
$fn$;
REVOKE ALL ON FUNCTION public.guard_pos_table_joins() FROM PUBLIC;
DROP TRIGGER IF EXISTS guard_pos_table_joins ON public.pos_table_joins;
CREATE TRIGGER guard_pos_table_joins
  BEFORE INSERT OR UPDATE OR DELETE ON public.pos_table_joins
  FOR EACH ROW EXECUTE FUNCTION public.guard_pos_table_joins();


-- ── 2. The shared steps ──────────────────────────────────────────────────────────────────────
-- Internal: no grant to any browser role. They run inside the DEFINER functions (as the owner)
-- and inside guard_pos_kot_log (DEFINER).

-- Food sent and then moved off this bill, less food sent elsewhere and moved onto it, for one
-- dish (save_pos_order_items' line key: recipe#selection, else the name). A join re-points the
-- tickets with the food, so it is not counted here; a move of the whole bill keeps its id.
CREATE OR REPLACE FUNCTION public.pos_moved_out_sent(p_order_id uuid, p_key text)
RETURNS numeric
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $fn$
  SELECT COALESCE(SUM(CASE WHEN m.from_order_id = p_order_id THEN 1 ELSE -1 END
                      * CASE WHEN jsonb_typeof(l->'sent_qty') = 'number' THEN (l->>'sent_qty')::numeric ELSE 0 END), 0)
    FROM pos_table_moves m
   CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(m.lines) = 'array' THEN m.lines ELSE '[]'::jsonb END) AS l
   WHERE m.kind IN ('move_dishes', 'part_bill', 'part_back')
     AND (m.from_order_id = p_order_id OR m.to_order_id = p_order_id)
     AND m.from_order_id IS DISTINCT FROM m.to_order_id
     AND COALESCE((l->>'recipe_id')
                    || CASE WHEN COALESCE(l->>'selection_key', '') <> '' THEN '#' || (l->>'selection_key') ELSE '' END,
                  l->>'name') = p_key
$fn$;
REVOKE ALL ON FUNCTION public.pos_moved_out_sent(uuid, text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.pos_move_check_rank()
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $fn$
BEGIN
  IF NOT COALESCE(public.pos_caller_has_rank('staff'), false) THEN
    RAISE EXCEPTION 'pos_move_rank: only a POS login of this outlet can move, join or split a table'
      USING ERRCODE = '42501', HINT = 'pos_move_rank';
  END IF;
END;
$fn$;
REVOKE ALL ON FUNCTION public.pos_move_check_rank() FROM PUBLIC;

-- A bill the caller may act on: of the caller's outlet, open, and as the till last read it.
CREATE OR REPLACE FUNCTION public.pos_move_check_order(p_o public.pos_orders, p_expected integer, p_what text)
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $fn$
BEGIN
  IF p_o.id IS NULL OR NOT COALESCE(public.is_admin() OR p_o.client_id = public.my_client_id(), false) THEN
    RAISE EXCEPTION 'pos_move_order_missing: % is no longer open — it was closed or cleared on another device', p_what
      USING ERRCODE = 'P0001', HINT = 'pos_move_order_missing';
  END IF;
  IF p_o.status IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'order_not_open: % is already closed — reload the floor', p_what
      USING ERRCODE = 'P0001', HINT = 'order_not_open';
  END IF;
  IF p_expected IS NOT NULL AND p_o.items_version IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION 'stale_order: % was changed on another device since it was opened here — reload it and try again', p_what
      USING ERRCODE = 'P0001', HINT = 'stale_order',
            DETAIL = format('expected version %s, current version %s', p_expected, p_o.items_version);
  END IF;
END;
$fn$;
REVOKE ALL ON FUNCTION public.pos_move_check_order(public.pos_orders, integer, text) FROM PUBLIC;

-- A table a bill may move to or take in: on the floor plan, in service, and on no other bill.
CREATE OR REPLACE FUNCTION public.pos_move_check_table(p_t public.pos_tables)
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $fn$
DECLARE
  v_with text;
BEGIN
  IF p_t.id IS NULL THEN
    RAISE EXCEPTION 'pos_move_table_missing: that table is not on this outlet''s floor plan any more'
      USING ERRCODE = 'P0001', HINT = 'pos_move_table_missing';
  END IF;
  IF p_t.status = 'inactive' THEN
    RAISE EXCEPTION 'pos_table_inactive_new_order: % is out of service, so it takes no bill', p_t.name
      USING ERRCODE = '23514', HINT = 'pos_table_inactive_new_order';
  END IF;
  SELECT COALESCE(o.table_name, 'another table') INTO v_with
    FROM pos_table_joins j JOIN pos_orders o ON o.id = j.order_id
   WHERE j.table_id = p_t.id;
  IF FOUND THEN
    RAISE EXCEPTION 'pos_table_joined: % is joined to %''s bill — pick another table, or release it first', p_t.name, v_with
      USING ERRCODE = '23514', HINT = 'pos_table_joined';
  END IF;
END;
$fn$;
REVOKE ALL ON FUNCTION public.pos_move_check_table(public.pos_tables) FROM PUBLIC;

-- p_item is a line already on its new bill. If that bill holds another uncomped line of
-- the same dish and choices, the two become one: save_pos_order_items keys a stored price by line,
-- so two rows of one line would leave its next save pricing both at one of them. The row with the
-- LOWER price survives (owner default: a guest never pays more than either bill asked), carrying
-- both quantities and both sent counts; the other row and its choices snapshot go. Notes join.
-- Called with crest.pos_items_rpc on, so the deleted row writes no "Table cleared" pull record.
CREATE OR REPLACE FUNCTION public.pos_merge_line(p_item uuid)
RETURNS uuid
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
DECLARE
  r       pos_order_items;
  t       pos_order_items;
  v_keep  pos_order_items;
  v_drop  pos_order_items;
  v_sent  integer;
BEGIN
  SELECT * INTO r FROM pos_order_items WHERE id = p_item FOR UPDATE;
  IF r.id IS NULL OR r.recipe_id IS NULL OR r.comped THEN
    RETURN r.id;
  END IF;
  SELECT * INTO t FROM pos_order_items i
   WHERE i.order_id = r.order_id AND i.id <> r.id AND i.recipe_id = r.recipe_id
     AND i.selection_key = r.selection_key AND NOT i.comped
   ORDER BY i.created_at, i.id
   LIMIT 1
   FOR UPDATE;
  IF t.id IS NULL THEN
    RETURN r.id;
  END IF;
  v_sent := GREATEST(r.sent_qty, CASE WHEN COALESCE(r.sent_to_kot, false) THEN r.qty ELSE 0 END)
          + GREATEST(t.sent_qty, CASE WHEN COALESCE(t.sent_to_kot, false) THEN t.qty ELSE 0 END);
  IF r.unit_price < t.unit_price THEN
    v_keep := r; v_drop := t;
  ELSE
    v_keep := t; v_drop := r;
  END IF;
  UPDATE pos_order_items
     SET qty         = r.qty + t.qty,
         sent_qty    = v_sent,
         sent_to_kot = COALESCE(r.sent_to_kot, false) AND COALESCE(t.sent_to_kot, false),
         notes       = CASE
                         WHEN NULLIF(btrim(v_drop.notes), '') IS NULL OR v_drop.notes = v_keep.notes THEN v_keep.notes
                         WHEN NULLIF(btrim(v_keep.notes), '') IS NULL THEN v_drop.notes
                         ELSE v_keep.notes || '; ' || v_drop.notes
                       END
   WHERE id = v_keep.id;
  DELETE FROM pos_order_items WHERE id = v_drop.id;   -- its choices snapshot goes with it (CASCADE)
  RETURN v_keep.id;
END;
$fn$;
REVOKE ALL ON FUNCTION public.pos_merge_line(uuid) FROM PUBLIC;

-- Moves lines from one open bill to another, both locked by the caller. p_picks NULL moves every
-- row whole, comped leftovers of a cancelled close included (a join, a put-back). Otherwise
-- [{item_id, qty}]: rows of p_from, not comped, 1..qty each; a row moved whole keeps its id, a
-- part becomes a new row with the same price, VAT, notes and a copy of its choices snapshot.
-- Sent units move first (the cooked food goes where the guests are, as a comp takes them), so
-- the sent counts on both sides add up to what the kitchen has. Returns what moved, for the
-- record: [{recipe_id, selection_key, name, qty, sent_qty, unit_price}].
CREATE OR REPLACE FUNCTION public.pos_move_lines(p_from uuid, p_to uuid, p_picks jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
DECLARE
  v_client uuid;
  v_out    jsonb := '[]'::jsonb;
  r        pos_order_items;
  v_pick   jsonb;
  v_item   uuid;
  v_q      integer;
  v_sent   integer;
  v_move   integer;
  v_new    uuid;
BEGIN
  SELECT client_id INTO v_client FROM pos_orders WHERE id = p_to;

  IF p_picks IS NULL THEN
    FOR r IN SELECT * FROM pos_order_items WHERE order_id = p_from ORDER BY created_at, id FOR UPDATE LOOP
      v_sent := GREATEST(r.sent_qty, CASE WHEN COALESCE(r.sent_to_kot, false) THEN r.qty ELSE 0 END);
      UPDATE pos_order_items SET order_id = p_to WHERE id = r.id;
      UPDATE pos_order_item_options SET order_id = p_to WHERE order_item_id = r.id;
      PERFORM public.pos_merge_line(r.id);
      v_out := v_out || jsonb_build_object('recipe_id', r.recipe_id, 'selection_key', r.selection_key, 'name', r.name,
                                           'qty', r.qty, 'sent_qty', v_sent, 'unit_price', r.unit_price);
    END LOOP;
    RETURN v_out;
  END IF;

  IF jsonb_typeof(p_picks) IS DISTINCT FROM 'array' OR jsonb_array_length(p_picks) = 0 THEN
    RAISE EXCEPTION 'pos_move_nothing: pick at least one dish to move'
      USING ERRCODE = 'P0001', HINT = 'pos_move_nothing';
  END IF;
  IF (SELECT count(DISTINCT x->>'item_id') FROM jsonb_array_elements(p_picks) x) <> jsonb_array_length(p_picks) THEN
    RAISE EXCEPTION 'pos_move_nothing: each dish is picked once, with how many of it to move'
      USING ERRCODE = 'P0001', HINT = 'pos_move_nothing';
  END IF;

  FOR v_pick IN SELECT * FROM jsonb_array_elements(p_picks) LOOP
    v_item := CASE WHEN COALESCE(v_pick->>'item_id', '') ~ '^[0-9a-fA-F-]{36}$' THEN (v_pick->>'item_id')::uuid END;
    v_q    := CASE WHEN jsonb_typeof(v_pick->'qty') = 'number' AND (v_pick->>'qty') ~ '^[0-9]{1,6}$'
                   THEN (v_pick->>'qty')::integer END;
    SELECT * INTO r FROM pos_order_items WHERE id = v_item AND order_id = p_from FOR UPDATE;
    IF r.id IS NULL THEN
      RAISE EXCEPTION 'pos_move_line_missing: a dish you picked is no longer on this bill — it changed on another device; reload it and try again'
        USING ERRCODE = 'P0001', HINT = 'pos_move_line_missing';
    END IF;
    IF r.comped THEN
      RAISE EXCEPTION 'pos_move_line_comped: % is complimentary on this bill, so it stays here', r.name
        USING ERRCODE = 'P0001', HINT = 'pos_move_line_comped';
    END IF;
    IF v_q IS NULL OR v_q < 1 OR v_q > r.qty THEN
      RAISE EXCEPTION 'pos_move_qty_invalid: % can be moved 1 to % at a time', r.name, r.qty
        USING ERRCODE = 'P0001', HINT = 'pos_move_qty_invalid';
    END IF;
    v_sent := GREATEST(r.sent_qty, CASE WHEN COALESCE(r.sent_to_kot, false) THEN r.qty ELSE 0 END);
    v_move := LEAST(v_q, v_sent);
    IF v_q = r.qty THEN
      UPDATE pos_order_items SET order_id = p_to WHERE id = r.id;
      UPDATE pos_order_item_options SET order_id = p_to WHERE order_item_id = r.id;
      v_new := r.id;
    ELSE
      UPDATE pos_order_items SET qty = r.qty - v_q, sent_qty = v_sent - v_move WHERE id = r.id;
      INSERT INTO pos_order_items (order_id, client_id, recipe_id, name, qty, unit_price, vat_rate, notes, sent_to_kot,
                                   category, sent_qty, selection_key, base_unit_price, options_delta, option_summary)
      VALUES (p_to, v_client, r.recipe_id, r.name, v_q, r.unit_price, r.vat_rate, r.notes, v_move >= v_q,
              r.category, v_move, r.selection_key, r.base_unit_price, r.options_delta, r.option_summary)
      RETURNING id INTO v_new;
      INSERT INTO pos_order_item_options (client_id, order_id, order_item_id, recipe_id, group_id, option_id, group_name,
                                          group_kind, option_name, kitchen_name, is_removal, price_delta,
                                          list_price_delta, included, ingredient_deltas, sort)
      SELECT x.client_id, p_to, v_new, x.recipe_id, x.group_id, x.option_id, x.group_name,
             x.group_kind, x.option_name, x.kitchen_name, x.is_removal, x.price_delta,
             x.list_price_delta, x.included, x.ingredient_deltas, x.sort
        FROM pos_order_item_options x
       WHERE x.order_item_id = r.id;
    END IF;
    PERFORM public.pos_merge_line(v_new);
    v_out := v_out || jsonb_build_object('recipe_id', r.recipe_id, 'selection_key', r.selection_key, 'name', r.name,
                                         'qty', v_q, 'sent_qty', v_move, 'unit_price', r.unit_price);
  END LOOP;
  RETURN v_out;
END;
$fn$;
REVOKE ALL ON FUNCTION public.pos_move_lines(uuid, uuid, jsonb) FROM PUBLIC;


-- ── 3. The three guards, and the group summary's seated guests ──────────────────────────────
DO $do$
DECLARE
  v_def text;
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.guard_pos_order_close()'::regprocedure) = 'ad92a74549be6bf5a06d7d93172935b2' THEN
    RETURN; -- a re-run
  END IF;
  v_def := pg_get_functiondef('public.guard_pos_order_close()'::regprocedure);
  v_def := pg_temp.s836_patch(v_def,
$o$  -- ── end S809 1c ──────────────────────────────────────────────────────────────────────────

  -- ── (A) A billed or voided bill is locked ──────────────────────────────────────────────────
$o$,
$n$  -- ── end S809 1c ──────────────────────────────────────────────────────────────────────────

  -- ── S836: an open order's table moves only through the table functions ──────────────────
  -- move_pos_order_table, join_pos_tables and the dish moves write table_id, table_name and
  -- part_of_order_id with the record of who moved what (pos_table_moves); they are DEFINER, so
  -- they never reach this line. Anything a client session sends for them is ignored rather than
  -- refused: the offline upload re-sends an order's table on a retry, and must neither fail nor
  -- put a moved bill back on its old table.
  IF OLD.status = 'open' THEN
    NEW.table_id         := OLD.table_id;
    NEW.table_name       := OLD.table_name;
    NEW.part_of_order_id := OLD.part_of_order_id;
  END IF;
  -- ── end S836 ──

  -- ── (A) A billed or voided bill is locked ──────────────────────────────────────────────────
$n$);
  EXECUTE v_def;
END;
$do$;

DO $do$
DECLARE
  v_def text;
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.guard_pos_order_insert()'::regprocedure) = '9a861b3c577ee0cab90cde9986b999bc' THEN
    RETURN; -- a re-run
  END IF;
  v_def := pg_get_functiondef('public.guard_pos_order_insert()'::regprocedure);
  v_def := pg_temp.s836_patch(v_def,
$o$    IF v_table_status = 'inactive' THEN
      RAISE EXCEPTION 'pos_table_inactive_new_order: % is out of service, so it takes no new order', v_table_name
        USING ERRCODE = '23514', HINT = 'pos_table_inactive_new_order';
    END IF;
  END IF;
$o$,
$n$    IF v_table_status = 'inactive' THEN
      RAISE EXCEPTION 'pos_table_inactive_new_order: % is out of service, so it takes no new order', v_table_name
        USING ERRCODE = '23514', HINT = 'pos_table_inactive_new_order';
    END IF;
    -- S836: nor does a table joined to another table's bill (pos_table_joins): its guests are on
    -- that bill. Not 23505, which the till reads as "this table already has an open order".
    IF EXISTS (SELECT 1 FROM pos_table_joins j WHERE j.table_id = NEW.table_id) THEN
      RAISE EXCEPTION 'pos_table_joined: % is joined to another table''s bill — open that bill, or release the table first', v_table_name
        USING ERRCODE = '23514', HINT = 'pos_table_joined';
    END IF;
  END IF;
$n$);
  v_def := pg_temp.s836_patch(v_def,
$o$    -- the close. A value sent here is dropped, not refused.
    NEW.vat_registered := NULL;
$o$,
$n$    -- the close. A value sent here is dropped, not refused.
    NEW.vat_registered := NULL;
    -- S836: a part bill is made only by split_pos_part_bill (DEFINER, never here). The operator's
    -- restore keeps an open part bill's link (is_admin() is asked only when one is sent).
    IF NEW.part_of_order_id IS NOT NULL AND NOT COALESCE(public.is_admin(), false) THEN
      NEW.part_of_order_id := NULL;
    END IF;
$n$);
  EXECUTE v_def;
END;
$do$;

DO $do$
DECLARE
  v_def text;
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.guard_pos_kot_log()'::regprocedure) = 'ef5b2f1f772675e7839f3a05edc6600e' THEN
    RETURN; -- a re-run
  END IF;
  v_def := pg_get_functiondef('public.guard_pos_kot_log()'::regprocedure);
  v_def := pg_temp.s836_patch(v_def,
$o$  -- UPDATE. An allow-list, so a column added later is locked by default (invariant #1's reason).
$o$,
$n$  -- ── S836: a join hands the absorbed bill's tickets to the bill that stays ─────────────────
  -- join_pos_tables re-points them in its own transaction (crest.pos_table_join_rpc, which a
  -- PostgREST request cannot set), so the kitchen's record follows the food to the bill it is
  -- now on. What each ticket says, the table and number it printed with, who sent it, when, and
  -- its stage are untouched: only order_id may differ.
  IF TG_OP = 'UPDATE' AND current_setting('crest.pos_table_join_rpc', true) = 'on'
     AND (to_jsonb(NEW) - 'order_id') = (to_jsonb(OLD) - 'order_id') THEN
    RETURN NEW;
  END IF;

  -- UPDATE. An allow-list, so a column added later is locked by default (invariant #1's reason).
$n$);
  v_def := pg_temp.s836_patch(v_def,
$o$                                  i.name) = m.k)
                 >
$o$,
$n$                                  i.name) = m.k)
                 -- S836: plus what was sent and then moved to another bill (pos_moved_out_sent):
                 -- this ticket still owes it, at its new table.
                 + public.pos_moved_out_sent(OLD.order_id, m.k)
                 >
$n$);
  EXECUTE v_def;
END;
$do$;

DO $do$
DECLARE
  v_def text;
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.get_group_summary(integer, integer, date, date)'::regprocedure) = 'dc7e1fd26ce0186a282c10d144f5c407' THEN
    RETURN; -- a re-run
  END IF;
  v_def := pg_get_functiondef('public.get_group_summary(integer, integer, date, date)'::regprocedure);
  v_def := pg_temp.s836_patch(v_def,
$o$         AND po.table_id IS NOT NULL
$o$,
$n$         -- S836: a part bill (pay part now) was served at a table too, though it has none of its own.
         AND (po.table_id IS NOT NULL OR po.part_of_order_id IS NOT NULL)
$n$);
  EXECUTE v_def;
END;
$do$;


-- ── 4. A closed or cleared bill frees its tables ─────────────────────────────────────────────
-- AFTER UPDATE OF status (open → billed or voided) and BEFORE DELETE of an open bill (Clear, or
-- the join and put-back deleting the bill they emptied). Frees the bill's own table and its joined
-- tables while no other open bill or join holds them, drops its joins, and at a close turns away
-- the joined tables' waiting guest orders as pos_orders_close_turns_away_guest_orders does for its
-- own table (S817, D21). DEFINER: it writes another row's table status for whoever closed the bill.
-- Inside a whole-client deletion the tables are going too, so it stands aside.
CREATE OR REPLACE FUNCTION public.pos_orders_release_tables()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_o      pos_orders;
  v_joined uuid[];
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_o := OLD;
    IF v_o.status IS DISTINCT FROM 'open'
       OR NOT EXISTS (SELECT 1 FROM clients c WHERE c.id = v_o.client_id) THEN
      RETURN OLD;
    END IF;
  ELSE
    v_o := NEW;
    IF NOT (OLD.status = 'open' AND NEW.status IN ('billed', 'voided')) THEN
      RETURN NEW;
    END IF;
  END IF;

  SELECT array_agg(j.table_id) INTO v_joined FROM pos_table_joins j WHERE j.order_id = v_o.id;
  IF TG_OP = 'UPDATE' AND v_joined IS NOT NULL THEN
    UPDATE pos_guest_order_requests
       SET status     = 'dismissed',
           decided_at = now(),
           decided_by = (SELECT p.id FROM profiles p WHERE p.id = (SELECT auth.uid()))
     WHERE client_id = v_o.client_id
       AND table_id  = ANY (v_joined)
       AND status    = 'pending';
  END IF;
  DELETE FROM pos_table_joins WHERE order_id = v_o.id;
  UPDATE pos_tables t
     SET status = 'available'
   WHERE t.client_id = v_o.client_id
     AND t.status = 'occupied'
     AND (t.id = v_o.table_id OR t.id = ANY (COALESCE(v_joined, '{}'::uuid[])))
     AND NOT EXISTS (SELECT 1 FROM pos_orders o WHERE o.table_id = t.id AND o.status = 'open' AND o.id <> v_o.id)
     AND NOT EXISTS (SELECT 1 FROM pos_table_joins j WHERE j.table_id = t.id);
  RETURN COALESCE(NEW, OLD);
END;
$fn$;
REVOKE ALL ON FUNCTION public.pos_orders_release_tables() FROM PUBLIC;
DROP TRIGGER IF EXISTS pos_orders_release_tables_close ON public.pos_orders;
CREATE TRIGGER pos_orders_release_tables_close
  AFTER UPDATE OF status ON public.pos_orders
  FOR EACH ROW EXECUTE FUNCTION public.pos_orders_release_tables();
DROP TRIGGER IF EXISTS pos_orders_release_tables_delete ON public.pos_orders;
CREATE TRIGGER pos_orders_release_tables_delete
  BEFORE DELETE ON public.pos_orders
  FOR EACH ROW EXECUTE FUNCTION public.pos_orders_release_tables();


-- ── 5. Move a whole bill to a free table ─────────────────────────────────────────────────────
-- The bill keeps its id, lines, tickets and number. Its joined tables are released (the group is
-- moving; join again at the new table). Its guests' unanswered QR order and its seated booking's
-- table go with it; a booking whose new table clashes with another hold keeps its old link, and
-- the answer says so (warning booking_table_kept).
CREATE OR REPLACE FUNCTION public.move_pos_order_table(p_order_id uuid, p_to_table_id uuid, p_expected_version integer DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_o      pos_orders;
  v_t      pos_tables;
  v_busy   uuid;
  v_joined uuid[];
  v_warn   text;
BEGIN
  PERFORM public.pos_move_check_rank();
  SELECT * INTO v_o FROM pos_orders WHERE id = p_order_id FOR UPDATE;
  PERFORM public.pos_move_check_order(v_o, p_expected_version, 'This bill');
  IF v_o.part_of_order_id IS NOT NULL THEN
    RAISE EXCEPTION 'pos_part_bill_locked: a part bill is paid, or put back on its table — it does not move'
      USING ERRCODE = 'P0001', HINT = 'pos_part_bill_locked';
  END IF;
  SELECT * INTO v_t FROM pos_tables WHERE id = p_to_table_id AND client_id = v_o.client_id FOR UPDATE;
  IF v_t.id IS NOT NULL AND v_t.id = v_o.table_id THEN
    RAISE EXCEPTION 'pos_move_same_table: this bill is already on %', v_t.name
      USING ERRCODE = 'P0001', HINT = 'pos_move_same_table';
  END IF;
  PERFORM public.pos_move_check_table(v_t);
  SELECT o.id INTO v_busy FROM pos_orders o
   WHERE o.client_id = v_o.client_id AND o.table_id = v_t.id AND o.status = 'open'
   LIMIT 1;
  IF v_busy IS NOT NULL THEN
    RAISE EXCEPTION 'pos_move_table_busy: % already has a bill — join the two instead', v_t.name
      USING ERRCODE = 'P0001', HINT = 'pos_move_table_busy', DETAIL = v_busy::text;
  END IF;

  SELECT array_agg(j.table_id) INTO v_joined FROM pos_table_joins j WHERE j.order_id = v_o.id;
  DELETE FROM pos_table_joins WHERE order_id = v_o.id;
  UPDATE pos_orders
     SET table_id = v_t.id, table_name = v_t.name, items_version = items_version + 1
   WHERE id = v_o.id;
  UPDATE pos_tables t
     SET status = 'available'
   WHERE t.client_id = v_o.client_id
     AND t.status = 'occupied'
     AND (t.id = v_o.table_id OR t.id = ANY (COALESCE(v_joined, '{}'::uuid[])))
     AND NOT EXISTS (SELECT 1 FROM pos_orders o WHERE o.table_id = t.id AND o.status = 'open')
     AND NOT EXISTS (SELECT 1 FROM pos_table_joins j WHERE j.table_id = t.id);
  UPDATE pos_tables SET status = 'occupied' WHERE id = v_t.id AND status IS DISTINCT FROM 'inactive';

  IF v_o.table_id IS NOT NULL THEN
    -- One waiting guest order per table: one already waiting at the new table keeps it there.
    UPDATE pos_guest_order_requests r
       SET table_id = v_t.id
     WHERE r.client_id = v_o.client_id AND r.table_id = v_o.table_id AND r.status = 'pending'
       AND NOT EXISTS (SELECT 1 FROM pos_guest_order_requests r2 WHERE r2.table_id = v_t.id AND r2.status = 'pending');
    BEGIN
      UPDATE pos_reservation_tables rt
         SET table_id = v_t.id
       WHERE rt.table_id = v_o.table_id
         AND rt.reservation_id IN (SELECT r.id FROM pos_reservations r WHERE r.order_id = v_o.id AND r.status = 'seated')
         AND NOT EXISTS (SELECT 1 FROM pos_reservation_tables x WHERE x.reservation_id = rt.reservation_id AND x.table_id = v_t.id);
    EXCEPTION WHEN OTHERS THEN
      v_warn := 'booking_table_kept';
    END;
  END IF;

  INSERT INTO pos_table_moves (client_id, kind, from_order_id, to_order_id, from_order_no, to_order_no,
                               from_table_id, from_table_name, to_table_id, to_table_name, covers_moved, moved_by)
  VALUES (v_o.client_id, 'move', v_o.id, v_o.id, v_o.order_no, v_o.order_no,
          v_o.table_id, v_o.table_name, v_t.id, v_t.name, v_o.covers, (SELECT auth.uid()));

  RETURN jsonb_build_object('order_id', v_o.id, 'order_no', v_o.order_no, 'items_version', v_o.items_version + 1,
                            'table_id', v_t.id, 'table_name', v_t.name, 'from_table_name', v_o.table_name,
                            'released_table_ids', COALESCE(to_jsonb(v_joined), '[]'::jsonb), 'warning', v_warn);
END;
$fn$;
REVOKE ALL ON FUNCTION public.move_pos_order_table(uuid, uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.move_pos_order_table(uuid, uuid, integer) TO authenticated, service_role;


-- ── 6. Join a table onto a bill ──────────────────────────────────────────────────────────────
-- Both tables stay taken, on this one bill, until it closes (owner decision). A table with a bill
-- of its own brings that bill in whole: lines (one line per dish, the lower price), kitchen
-- tickets (crest.pos_table_join_rpc), pulled-item records, guest orders, seated bookings, part
-- bills, its own joins and its share of the record; covers add up; the emptied bill is deleted.
CREATE OR REPLACE FUNCTION public.join_pos_tables(p_order_id uuid, p_table_id uuid,
                                                  p_expected_version integer DEFAULT NULL,
                                                  p_other_expected_version integer DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_client uuid;
  v_o2_id  uuid;
  v_o      pos_orders;
  v_o2     pos_orders;
  v_t      pos_tables;
  v_lines  jsonb := '[]'::jsonb;
  v_covers integer := 0;
BEGIN
  PERFORM public.pos_move_check_rank();
  -- The joining table's own bill, read now and locked with this one in id order (a save or close
  -- locks one bill, and every function here locks bills before tables).
  SELECT client_id INTO v_client FROM pos_orders WHERE id = p_order_id;
  SELECT o.id INTO v_o2_id FROM pos_orders o
   WHERE o.client_id = v_client AND o.table_id = p_table_id AND o.status = 'open' AND o.id <> p_order_id
   LIMIT 1;
  PERFORM 1 FROM pos_orders WHERE id IN (p_order_id, v_o2_id) ORDER BY id FOR UPDATE;

  SELECT * INTO v_o FROM pos_orders WHERE id = p_order_id;
  PERFORM public.pos_move_check_order(v_o, p_expected_version, 'This bill');
  IF v_o.part_of_order_id IS NOT NULL THEN
    RAISE EXCEPTION 'pos_part_bill_locked: a part bill is paid, or put back on its table — no table joins it'
      USING ERRCODE = 'P0001', HINT = 'pos_part_bill_locked';
  END IF;
  IF v_o.table_id IS NULL THEN
    RAISE EXCEPTION 'pos_join_needs_table: a takeaway has no table for another to join — move it to a table first'
      USING ERRCODE = 'P0001', HINT = 'pos_join_needs_table';
  END IF;
  SELECT * INTO v_t FROM pos_tables WHERE id = p_table_id AND client_id = v_o.client_id FOR UPDATE;
  IF v_t.id IS NOT NULL AND (v_t.id = v_o.table_id
                             OR EXISTS (SELECT 1 FROM pos_table_joins j WHERE j.table_id = v_t.id AND j.order_id = v_o.id)) THEN
    RAISE EXCEPTION 'pos_join_already: % is already on this bill', v_t.name
      USING ERRCODE = 'P0001', HINT = 'pos_join_already';
  END IF;
  PERFORM public.pos_move_check_table(v_t);

  -- The table's bill as it stands under the locks.
  SELECT * INTO v_o2 FROM pos_orders o
   WHERE o.client_id = v_o.client_id AND o.table_id = v_t.id AND o.status = 'open';
  IF v_o2.id IS DISTINCT FROM v_o2_id THEN
    RAISE EXCEPTION 'pos_move_retry: % changed on another device just now — try again', v_t.name
      USING ERRCODE = 'P0001', HINT = 'pos_move_retry';
  END IF;

  IF v_o2.id IS NOT NULL THEN
    PERFORM public.pos_move_check_order(v_o2, p_other_expected_version, v_t.name || '''s bill');
    IF EXISTS (SELECT 1 FROM pos_order_payments p WHERE p.order_id = v_o2.id) THEN
      RAISE EXCEPTION 'pos_join_points_held: %''s bill has loyalty points taken off it — hand them back on that bill first, then join', v_t.name
        USING ERRCODE = 'P0001', HINT = 'pos_join_points_held';
    END IF;
    PERFORM set_config('crest.pos_items_rpc', 'on', true);
    v_lines := public.pos_move_lines(v_o2.id, v_o.id, NULL);
    PERFORM set_config('crest.pos_items_rpc', 'off', true);
    PERFORM set_config('crest.pos_table_join_rpc', 'on', true);
    UPDATE pos_kot_log SET order_id = v_o.id WHERE order_id = v_o2.id;
    PERFORM set_config('crest.pos_table_join_rpc', 'off', true);
    UPDATE pos_kot_removals          SET order_id = v_o.id WHERE order_id = v_o2.id;
    UPDATE pos_guest_order_requests  SET order_id = v_o.id WHERE order_id = v_o2.id;
    UPDATE pos_reservations          SET order_id = v_o.id WHERE order_id = v_o2.id;
    UPDATE pos_orders                SET part_of_order_id = v_o.id WHERE part_of_order_id = v_o2.id;
    UPDATE pos_table_joins           SET order_id = v_o.id WHERE order_id = v_o2.id;
    UPDATE pos_table_moves SET from_order_id = v_o.id
     WHERE from_order_id = v_o2.id AND kind IN ('move_dishes', 'part_bill', 'part_back');
    UPDATE pos_table_moves SET to_order_id = v_o.id
     WHERE to_order_id = v_o2.id AND kind IN ('move_dishes', 'part_bill', 'part_back');
    v_covers := v_o2.covers;
    -- Empty now: no lines, tickets or payment lines. pos_orders_release_tables frees its table,
    -- which the join below takes straight back.
    DELETE FROM pos_orders WHERE id = v_o2.id;
  END IF;

  INSERT INTO pos_table_joins (client_id, table_id, order_id, joined_by)
  VALUES (v_o.client_id, v_t.id, v_o.id, (SELECT auth.uid()));
  UPDATE pos_tables SET status = 'occupied' WHERE id = v_t.id AND status IS DISTINCT FROM 'inactive';
  UPDATE pos_orders SET covers = covers + v_covers, items_version = items_version + 1 WHERE id = v_o.id;

  INSERT INTO pos_table_moves (client_id, kind, from_order_id, to_order_id, from_order_no, to_order_no,
                               from_table_id, from_table_name, to_table_id, to_table_name, lines, covers_moved, moved_by)
  VALUES (v_o.client_id, 'join', NULL, v_o.id, v_o2.order_no, v_o.order_no,
          v_t.id, v_t.name, v_o.table_id, v_o.table_name, v_lines, v_covers, (SELECT auth.uid()));

  RETURN jsonb_build_object('order_id', v_o.id, 'order_no', v_o.order_no, 'items_version', v_o.items_version + 1,
                            'table_name', v_o.table_name, 'joined_table_id', v_t.id, 'joined_table_name', v_t.name,
                            'absorbed_order_id', v_o2.id, 'absorbed_order_no', v_o2.order_no,
                            'covers', v_o.covers + v_covers, 'lines', v_lines);
END;
$fn$;
REVOKE ALL ON FUNCTION public.join_pos_tables(uuid, uuid, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.join_pos_tables(uuid, uuid, integer, integer) TO authenticated, service_role;


-- ── 7. Release a joined table ────────────────────────────────────────────────────────────────
-- Nobody sits there any more: the table comes off the bill and is free. No food moves.
CREATE OR REPLACE FUNCTION public.release_joined_table(p_table_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_order uuid;
  v_o     pos_orders;
  v_t     pos_tables;
BEGIN
  PERFORM public.pos_move_check_rank();
  SELECT j.order_id INTO v_order FROM pos_table_joins j WHERE j.table_id = p_table_id;
  SELECT * INTO v_o FROM pos_orders WHERE id = v_order FOR UPDATE;
  SELECT * INTO v_t FROM pos_tables WHERE id = p_table_id FOR UPDATE;
  IF v_o.id IS NULL OR v_t.id IS NULL OR v_t.client_id IS DISTINCT FROM v_o.client_id
     OR NOT COALESCE(public.is_admin() OR v_o.client_id = public.my_client_id(), false) THEN
    RAISE EXCEPTION 'pos_release_not_joined: that table is not joined to a bill any more'
      USING ERRCODE = 'P0001', HINT = 'pos_release_not_joined';
  END IF;
  DELETE FROM pos_table_joins WHERE table_id = v_t.id AND order_id = v_o.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pos_release_not_joined: % is not joined to a bill any more', v_t.name
      USING ERRCODE = 'P0001', HINT = 'pos_release_not_joined';
  END IF;
  UPDATE pos_tables SET status = 'available' WHERE id = v_t.id AND status = 'occupied';
  INSERT INTO pos_table_moves (client_id, kind, from_order_id, to_order_id, from_order_no, to_order_no,
                               from_table_id, from_table_name, to_table_id, to_table_name, moved_by)
  VALUES (v_o.client_id, 'release', v_o.id, v_o.id, v_o.order_no, v_o.order_no,
          v_t.id, v_t.name, v_o.table_id, v_o.table_name, (SELECT auth.uid()));
  RETURN jsonb_build_object('order_id', v_o.id, 'table_id', v_t.id, 'table_name', v_t.name);
END;
$fn$;
REVOKE ALL ON FUNCTION public.release_joined_table(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.release_joined_table(uuid) TO authenticated, service_role;


-- ── 8. Move some dishes to a table ───────────────────────────────────────────────────────────
-- To the bill already at that table (its own, or the one it is joined to), or a new bill there.
-- p_covers is how many guests go with the dishes (0 when only the food moves): a new bill takes
-- at least 1, and this bill keeps at least 1. Moving every dish this way is refused: that is
-- Move, which keeps the bill and its tickets whole.
CREATE OR REPLACE FUNCTION public.move_pos_order_lines(p_from_order_id uuid, p_to_table_id uuid, p_lines jsonb,
                                                       p_expected_version integer DEFAULT NULL,
                                                       p_to_expected_version integer DEFAULT NULL,
                                                       p_covers integer DEFAULT 0)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_client uuid;
  v_to_id  uuid;
  v_o      pos_orders;
  v_to     pos_orders;
  v_t      pos_tables;
  v_lines  jsonb;
  v_c      integer := GREATEST(COALESCE(p_covers, 0), 0);
  v_new    boolean := false;
BEGIN
  PERFORM public.pos_move_check_rank();
  SELECT client_id INTO v_client FROM pos_orders WHERE id = p_from_order_id;
  SELECT o.id INTO v_to_id FROM pos_orders o
   WHERE o.client_id = v_client AND o.table_id = p_to_table_id AND o.status = 'open'
   LIMIT 1;
  IF v_to_id IS NULL THEN
    SELECT j.order_id INTO v_to_id FROM pos_table_joins j WHERE j.table_id = p_to_table_id;
  END IF;
  PERFORM 1 FROM pos_orders WHERE id IN (p_from_order_id, v_to_id) ORDER BY id FOR UPDATE;

  SELECT * INTO v_o FROM pos_orders WHERE id = p_from_order_id;
  PERFORM public.pos_move_check_order(v_o, p_expected_version, 'This bill');
  IF v_o.part_of_order_id IS NOT NULL THEN
    RAISE EXCEPTION 'pos_part_bill_locked: a part bill is paid, or put back on its table — its dishes do not move'
      USING ERRCODE = 'P0001', HINT = 'pos_part_bill_locked';
  END IF;
  IF EXISTS (SELECT 1 FROM pos_order_payments p WHERE p.order_id = v_o.id) THEN
    RAISE EXCEPTION 'pos_move_points_held: this bill has loyalty points taken off it — hand them back first, then move its dishes'
      USING ERRCODE = 'P0001', HINT = 'pos_move_points_held';
  END IF;
  SELECT * INTO v_t FROM pos_tables WHERE id = p_to_table_id AND client_id = v_o.client_id FOR UPDATE;
  IF v_t.id IS NULL THEN
    RAISE EXCEPTION 'pos_move_table_missing: that table is not on this outlet''s floor plan any more'
      USING ERRCODE = 'P0001', HINT = 'pos_move_table_missing';
  END IF;
  IF v_t.status = 'inactive' THEN
    RAISE EXCEPTION 'pos_table_inactive_new_order: % is out of service, so it takes no bill', v_t.name
      USING ERRCODE = '23514', HINT = 'pos_table_inactive_new_order';
  END IF;

  SELECT * INTO v_to FROM pos_orders o
   WHERE o.client_id = v_o.client_id AND o.table_id = v_t.id AND o.status = 'open';
  IF v_to.id IS NULL THEN
    SELECT o.* INTO v_to FROM pos_table_joins j JOIN pos_orders o ON o.id = j.order_id WHERE j.table_id = v_t.id;
  END IF;
  IF v_to.id IS DISTINCT FROM v_to_id THEN
    RAISE EXCEPTION 'pos_move_retry: % changed on another device just now — try again', v_t.name
      USING ERRCODE = 'P0001', HINT = 'pos_move_retry';
  END IF;
  IF v_to.id = v_o.id OR v_t.id = v_o.table_id THEN
    RAISE EXCEPTION 'pos_move_same_bill: % is on this same bill', v_t.name
      USING ERRCODE = 'P0001', HINT = 'pos_move_same_bill';
  END IF;

  IF v_to.id IS NOT NULL THEN
    PERFORM public.pos_move_check_order(v_to, p_to_expected_version, v_t.name || '''s bill');
  ELSE
    INSERT INTO pos_orders (client_id, table_id, table_name, covers, opened_by)
    VALUES (v_o.client_id, v_t.id, v_t.name, GREATEST(v_c, 1), (SELECT auth.uid()))
    RETURNING * INTO v_to;
    v_new := true;
    UPDATE pos_tables SET status = 'occupied' WHERE id = v_t.id AND status IS DISTINCT FROM 'inactive';
  END IF;

  PERFORM set_config('crest.pos_items_rpc', 'on', true);
  v_lines := public.pos_move_lines(v_o.id, v_to.id, p_lines);
  PERFORM set_config('crest.pos_items_rpc', 'off', true);
  IF NOT EXISTS (SELECT 1 FROM pos_order_items i WHERE i.order_id = v_o.id AND NOT i.comped) THEN
    RAISE EXCEPTION 'pos_move_all_lines: that is every dish on this bill — use Move to move the whole bill'
      USING ERRCODE = 'P0001', HINT = 'pos_move_all_lines';
  END IF;

  UPDATE pos_orders SET covers = GREATEST(covers - v_c, 1), items_version = items_version + 1 WHERE id = v_o.id;
  UPDATE pos_orders
     SET covers = CASE WHEN v_new THEN covers ELSE covers + v_c END, items_version = items_version + 1
   WHERE id = v_to.id;

  INSERT INTO pos_table_moves (client_id, kind, from_order_id, to_order_id, from_order_no, to_order_no,
                               from_table_id, from_table_name, to_table_id, to_table_name, lines, covers_moved, moved_by)
  VALUES (v_o.client_id, 'move_dishes', v_o.id, v_to.id, v_o.order_no, v_to.order_no,
          v_o.table_id, v_o.table_name, v_t.id, v_t.name, v_lines, v_c, (SELECT auth.uid()));

  RETURN jsonb_build_object('from_order_id', v_o.id, 'from_items_version', v_o.items_version + 1,
                            'to_order_id', v_to.id, 'to_order_no', v_to.order_no, 'to_items_version', v_to.items_version + 1,
                            'to_table_id', v_t.id, 'to_table_name', v_t.name, 'to_bill_table_name', v_to.table_name,
                            'new_bill', v_new, 'lines', v_lines);
END;
$fn$;
REVOKE ALL ON FUNCTION public.move_pos_order_lines(uuid, uuid, jsonb, integer, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.move_pos_order_lines(uuid, uuid, jsonb, integer, integer, integer) TO authenticated, service_role;


-- ── 9. Pay part now: a part bill ─────────────────────────────────────────────────────────────
-- The picked dishes go to a new bill of their own (no table; the table's name; part_of_order_id),
-- which the till opens straight into Payment and closes like any bill, with its own invoice
-- number. p_covers is how many guests pay with it (0 when one of the table pays for food and
-- stays). Paying for everything is the bill's own Payment, so that is refused; so is a delivery
-- platform's order, which the platform pays as one.
CREATE OR REPLACE FUNCTION public.split_pos_part_bill(p_from_order_id uuid, p_lines jsonb,
                                                      p_expected_version integer DEFAULT NULL,
                                                      p_covers integer DEFAULT 1)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_o     pos_orders;
  v_p     pos_orders;
  v_lines jsonb;
  v_c     integer := GREATEST(COALESCE(p_covers, 1), 0);
BEGIN
  PERFORM public.pos_move_check_rank();
  SELECT * INTO v_o FROM pos_orders WHERE id = p_from_order_id FOR UPDATE;
  PERFORM public.pos_move_check_order(v_o, p_expected_version, 'This bill');
  IF v_o.part_of_order_id IS NOT NULL THEN
    RAISE EXCEPTION 'pos_part_bill_locked: this is already a part bill — take payment on it, or put it back'
      USING ERRCODE = 'P0001', HINT = 'pos_part_bill_locked';
  END IF;
  IF v_o.delivery_partner IS NOT NULL THEN
    RAISE EXCEPTION 'pos_part_delivery: a delivery platform''s order is paid as one bill'
      USING ERRCODE = 'P0001', HINT = 'pos_part_delivery';
  END IF;
  IF EXISTS (SELECT 1 FROM pos_order_payments p WHERE p.order_id = v_o.id) THEN
    RAISE EXCEPTION 'pos_move_points_held: this bill has loyalty points taken off it — hand them back first, then split it'
      USING ERRCODE = 'P0001', HINT = 'pos_move_points_held';
  END IF;

  INSERT INTO pos_orders (client_id, table_id, table_name, covers, opened_by, part_of_order_id)
  VALUES (v_o.client_id, NULL, v_o.table_name, v_c, (SELECT auth.uid()), v_o.id)
  RETURNING * INTO v_p;

  PERFORM set_config('crest.pos_items_rpc', 'on', true);
  v_lines := public.pos_move_lines(v_o.id, v_p.id, p_lines);
  PERFORM set_config('crest.pos_items_rpc', 'off', true);
  IF NOT EXISTS (SELECT 1 FROM pos_order_items i WHERE i.order_id = v_o.id AND NOT i.comped) THEN
    RAISE EXCEPTION 'pos_part_all_lines: that is the whole bill — take payment on it instead'
      USING ERRCODE = 'P0001', HINT = 'pos_part_all_lines';
  END IF;

  UPDATE pos_orders SET covers = GREATEST(covers - v_c, 1), items_version = items_version + 1 WHERE id = v_o.id;
  UPDATE pos_orders SET items_version = items_version + 1 WHERE id = v_p.id;

  INSERT INTO pos_table_moves (client_id, kind, from_order_id, to_order_id, from_order_no, to_order_no,
                               from_table_id, from_table_name, to_table_id, to_table_name, lines, covers_moved, moved_by)
  VALUES (v_o.client_id, 'part_bill', v_o.id, v_p.id, v_o.order_no, v_p.order_no,
          v_o.table_id, v_o.table_name, NULL, v_o.table_name, v_lines, v_c, (SELECT auth.uid()));

  RETURN jsonb_build_object('part_order_id', v_p.id, 'part_order_no', v_p.order_no, 'part_items_version', v_p.items_version + 1,
                            'from_order_id', v_o.id, 'from_items_version', v_o.items_version + 1,
                            'table_name', v_o.table_name, 'covers', v_c, 'lines', v_lines);
END;
$fn$;
REVOKE ALL ON FUNCTION public.split_pos_part_bill(uuid, jsonb, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.split_pos_part_bill(uuid, jsonb, integer, integer) TO authenticated, service_role;


-- ── 10. Put a part bill back ─────────────────────────────────────────────────────────────────
-- Its payment was cancelled: every line returns to the table's bill (one line per dish), its
-- covers too, and the part bill is deleted. Refused once the table's bill is closed, or once the
-- part bill sent food of its own (it then has its own kitchen tickets, so it is paid on its own).
CREATE OR REPLACE FUNCTION public.put_back_part_bill(p_part_order_id uuid,
                                                     p_expected_version integer DEFAULT NULL,
                                                     p_parent_expected_version integer DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_parent uuid;
  v_p      pos_orders;
  v_o      pos_orders;
  v_lines  jsonb;
BEGIN
  PERFORM public.pos_move_check_rank();
  SELECT part_of_order_id INTO v_parent FROM pos_orders WHERE id = p_part_order_id;
  PERFORM 1 FROM pos_orders WHERE id IN (p_part_order_id, v_parent) ORDER BY id FOR UPDATE;

  SELECT * INTO v_p FROM pos_orders WHERE id = p_part_order_id;
  PERFORM public.pos_move_check_order(v_p, p_expected_version, 'This part bill');
  IF v_p.part_of_order_id IS NULL THEN
    RAISE EXCEPTION 'pos_part_not_part: this bill was not split off another, so there is nothing to put it back on'
      USING ERRCODE = 'P0001', HINT = 'pos_part_not_part';
  END IF;
  IF v_p.part_of_order_id IS DISTINCT FROM v_parent THEN
    RAISE EXCEPTION 'pos_move_retry: this part bill changed on another device just now — try again'
      USING ERRCODE = 'P0001', HINT = 'pos_move_retry';
  END IF;
  SELECT * INTO v_o FROM pos_orders WHERE id = v_parent;
  IF v_o.id IS NULL OR v_o.status IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'pos_part_parent_closed: the table''s bill is closed already — take payment on this part bill instead'
      USING ERRCODE = 'P0001', HINT = 'pos_part_parent_closed';
  END IF;
  PERFORM public.pos_move_check_order(v_o, p_parent_expected_version, COALESCE(v_o.table_name, 'The table') || '''s bill');
  IF EXISTS (SELECT 1 FROM pos_kot_log k WHERE k.order_id = v_p.id) THEN
    RAISE EXCEPTION 'pos_part_bill_has_tickets: this part bill sent food of its own to the kitchen — take payment on it instead'
      USING ERRCODE = 'P0001', HINT = 'pos_part_bill_has_tickets';
  END IF;
  IF EXISTS (SELECT 1 FROM pos_order_payments p WHERE p.order_id = v_p.id) THEN
    RAISE EXCEPTION 'pos_move_points_held: this part bill has loyalty points taken off it — hand them back first, then put it back'
      USING ERRCODE = 'P0001', HINT = 'pos_move_points_held';
  END IF;

  PERFORM set_config('crest.pos_items_rpc', 'on', true);
  v_lines := public.pos_move_lines(v_p.id, v_o.id, NULL);
  PERFORM set_config('crest.pos_items_rpc', 'off', true);
  UPDATE pos_kot_removals SET order_id = v_o.id WHERE order_id = v_p.id;
  UPDATE pos_orders SET covers = covers + v_p.covers, items_version = items_version + 1 WHERE id = v_o.id;
  INSERT INTO pos_table_moves (client_id, kind, from_order_id, to_order_id, from_order_no, to_order_no,
                               from_table_id, from_table_name, to_table_id, to_table_name, lines, covers_moved, moved_by)
  VALUES (v_o.client_id, 'part_back', v_p.id, v_o.id, v_p.order_no, v_o.order_no,
          NULL, v_p.table_name, v_o.table_id, v_o.table_name, v_lines, v_p.covers, (SELECT auth.uid()));
  DELETE FROM pos_orders WHERE id = v_p.id;

  RETURN jsonb_build_object('order_id', v_o.id, 'order_no', v_o.order_no, 'items_version', v_o.items_version + 1,
                            'table_id', v_o.table_id, 'table_name', v_o.table_name, 'lines', v_lines);
END;
$fn$;
REVOKE ALL ON FUNCTION public.put_back_part_bill(uuid, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.put_back_part_bill(uuid, integer, integer) TO authenticated, service_role;


-- ── 11. Prove it ──────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_client uuid; v_other uuid; v_staff uuid;
  v_ta uuid; v_tb uuid; v_tc uuid; v_td uuid; v_tout uuid; v_telse uuid;
  v_dish uuid; v_tea uuid;
  v_o1 uuid; v_o2 uuid; v_o3 uuid; v_p1 uuid; v_p2 uuid;
  v_k1 uuid; v_k2 uuid; v_req uuid; v_res uuid;
  v_row uuid; v_r jsonb; v_hint text; v_hint2 text; v_n integer; v_fy text;
BEGIN
  -- ── Where: a POS outlet with settings and an unblocked POS till login ───────────────────────
  SELECT c.id INTO v_client
    FROM public.clients c
   WHERE c.pos_enabled AND COALESCE(public.client_access_open(c.id), false)
     AND EXISTS (SELECT 1 FROM public.settings s WHERE s.client_id = c.id)
     AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.client_id = c.id AND p.active_client_id IS NULL
                    AND p.pos_role IS NOT NULL AND p.pos_email IS NOT NULL
                    AND p.settlement_blocked_by IS NULL AND p.pos_blocked_at IS NULL)
   ORDER BY (c.name = 'BLOOM CAFE') DESC, c.name LIMIT 1;
  IF v_client IS NULL THEN
    RAISE EXCEPTION 'S836 probe: no POS outlet with settings and an unblocked POS till login';
  END IF;
  SELECT p.id INTO v_staff FROM public.profiles p
   WHERE p.client_id = v_client AND p.active_client_id IS NULL AND p.pos_role IS NOT NULL AND p.pos_email IS NOT NULL
     AND p.settlement_blocked_by IS NULL AND p.pos_blocked_at IS NULL
   ORDER BY (p.pos_role = 'staff') DESC, p.id LIMIT 1;
  SELECT c.id INTO v_other FROM public.clients c WHERE c.id <> v_client ORDER BY c.id LIMIT 1;
  v_fy := public.pos_invoice_fy(now());

  BEGIN
    PERFORM set_config('request.headers', '{"x-crest-build":"crest-v999999"}', true);

    -- ── Setup, as the migration's own role ────────────────────────────────────────────────────
    -- The stand-in is a plain Staff-rank till login, the lowest rank these functions take, with
    -- no other staff marker (a restrictive policy would otherwise turn an "allowed" into 0 rows).
    UPDATE public.profiles SET pos_role = 'staff', ims_role = NULL, hr_role = NULL, hr_self_service = false WHERE id = v_staff;
    INSERT INTO public.pos_tables (client_id, name) VALUES (v_client, 'S836 probe A') RETURNING id INTO v_ta;
    INSERT INTO public.pos_tables (client_id, name) VALUES (v_client, 'S836 probe B') RETURNING id INTO v_tb;
    INSERT INTO public.pos_tables (client_id, name) VALUES (v_client, 'S836 probe C') RETURNING id INTO v_tc;
    INSERT INTO public.pos_tables (client_id, name) VALUES (v_client, 'S836 probe D') RETURNING id INTO v_td;
    INSERT INTO public.pos_tables (client_id, name, status) VALUES (v_client, 'S836 probe out', 'inactive') RETURNING id INTO v_tout;
    INSERT INTO public.pos_tables (client_id, name) VALUES (v_other, 'S836 probe elsewhere') RETURNING id INTO v_telse;
    INSERT INTO public.recipes (client_id, name, category, selling_price, vat_rate, is_active, pos_enabled)
      VALUES (v_client, 'S836 probe momo', 'Food', 100, 0, true, true) RETURNING id INTO v_dish;
    INSERT INTO public.recipes (client_id, name, category, selling_price, vat_rate, is_active, pos_enabled)
      VALUES (v_client, 'S836 probe tea', 'Beverage', 50, 0, true, true) RETURNING id INTO v_tea;
    -- A on its own bill: 3 momo at 100, all sent on one ticket. B: 2 momo at 90 (an older menu
    -- price) sent on one ticket, and a tea not sent yet.
    INSERT INTO public.pos_orders (client_id, table_id, table_name, covers) VALUES (v_client, v_ta, 'S836 probe A', 2) RETURNING id INTO v_o1;
    INSERT INTO public.pos_order_items (order_id, client_id, name, recipe_id, qty, unit_price, vat_rate, sent_to_kot, sent_qty)
      VALUES (v_o1, v_client, 'S836 probe momo', v_dish, 3, 100, 0, true, 3);
    INSERT INTO public.pos_kot_log (client_id, order_id, order_no, table_name, station, items)
      VALUES (v_client, v_o1, (SELECT order_no FROM public.pos_orders WHERE id = v_o1), 'S836 probe A', 'KOT',
              jsonb_build_array(jsonb_build_object('recipe_id', v_dish, 'name', 'S836 probe momo', 'qty', 3)))
      RETURNING id INTO v_k1;
    INSERT INTO public.pos_orders (client_id, table_id, table_name, covers) VALUES (v_client, v_tb, 'S836 probe B', 3) RETURNING id INTO v_o2;
    INSERT INTO public.pos_order_items (order_id, client_id, name, recipe_id, qty, unit_price, vat_rate, sent_to_kot, sent_qty)
      VALUES (v_o2, v_client, 'S836 probe momo', v_dish, 2, 90, 0, true, 2);
    INSERT INTO public.pos_order_items (order_id, client_id, name, recipe_id, qty, unit_price, vat_rate, sent_to_kot, sent_qty)
      VALUES (v_o2, v_client, 'S836 probe tea', v_tea, 1, 50, 0, false, 0);
    INSERT INTO public.pos_kot_log (client_id, order_id, order_no, table_name, station, items)
      VALUES (v_client, v_o2, (SELECT order_no FROM public.pos_orders WHERE id = v_o2), 'S836 probe B', 'KOT',
              jsonb_build_array(jsonb_build_object('recipe_id', v_dish, 'name', 'S836 probe momo', 'qty', 2)))
      RETURNING id INTO v_k2;
    UPDATE public.pos_tables SET status = 'occupied' WHERE id IN (v_ta, v_tb);
    -- A's guests have a QR order waiting and are a seated booking.
    INSERT INTO public.pos_guest_order_requests (client_id, table_id, items) VALUES (v_client, v_ta, '[]'::jsonb) RETURNING id INTO v_req;
    INSERT INTO public.pos_reservations (client_id, customer_name, phone, party_size, reserved_for, status, order_id)
      VALUES (v_client, 'S836 probe guest', '9800000836', 2, now() - interval '30 minutes', 'seated', v_o1) RETURNING id INTO v_res;
    INSERT INTO public.pos_reservation_tables (client_id, reservation_id, table_id) VALUES (v_client, v_res, v_ta);

    -- ── (1) as Staff: moves that are refused, then A's bill to C ───────────────────────────────
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_staff)::text, true);
    SET LOCAL ROLE authenticated;
    v_hint := NULL;
    BEGIN PERFORM public.move_pos_order_table(v_o1, v_tb, NULL); EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT; END;
    IF v_hint IS DISTINCT FROM 'pos_move_table_busy' THEN RAISE EXCEPTION 'S836 probe: a move onto a table with a bill answered %', COALESCE(v_hint, 'nothing'); END IF;
    v_hint := NULL;
    BEGIN PERFORM public.move_pos_order_table(v_o1, v_tout, NULL); EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT; END;
    IF v_hint IS DISTINCT FROM 'pos_table_inactive_new_order' THEN RAISE EXCEPTION 'S836 probe: a move onto a table out of service answered %', COALESCE(v_hint, 'nothing'); END IF;
    v_hint := NULL;
    BEGIN PERFORM public.move_pos_order_table(v_o1, v_telse, NULL); EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT; END;
    IF v_hint IS DISTINCT FROM 'pos_move_table_missing' THEN RAISE EXCEPTION 'S836 probe: a move onto another outlet''s table answered %', COALESCE(v_hint, 'nothing'); END IF;
    v_hint := NULL;
    BEGIN PERFORM public.move_pos_order_table(v_o1, v_tc, 7); EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT; END;
    IF v_hint IS DISTINCT FROM 'stale_order' THEN RAISE EXCEPTION 'S836 probe: a move from a stale view answered %', COALESCE(v_hint, 'nothing'); END IF;
    v_r := public.move_pos_order_table(v_o1, v_tc, 0);
    RESET ROLE;
    IF (SELECT table_id FROM public.pos_orders WHERE id = v_o1) IS DISTINCT FROM v_tc
       OR (SELECT table_name FROM public.pos_orders WHERE id = v_o1) IS DISTINCT FROM 'S836 probe C'
       OR (SELECT items_version FROM public.pos_orders WHERE id = v_o1) <> 1
       OR (v_r->>'items_version')::integer <> 1
       OR (SELECT status FROM public.pos_tables WHERE id = v_ta) IS DISTINCT FROM 'available'
       OR (SELECT status FROM public.pos_tables WHERE id = v_tc) IS DISTINCT FROM 'occupied'
       OR (SELECT table_id FROM public.pos_guest_order_requests WHERE id = v_req) IS DISTINCT FROM v_tc
       OR NOT EXISTS (SELECT 1 FROM public.pos_reservation_tables WHERE reservation_id = v_res AND table_id = v_tc)
       OR NOT EXISTS (SELECT 1 FROM public.pos_table_moves WHERE kind = 'move' AND from_order_id = v_o1
                         AND from_table_name = 'S836 probe A' AND to_table_name = 'S836 probe C' AND moved_by = v_staff) THEN
      RAISE EXCEPTION 'S836 probe: moving A''s bill to C left table %, tables A % / C %, the guest order on %, the record %',
        (SELECT table_name FROM public.pos_orders WHERE id = v_o1),
        (SELECT status FROM public.pos_tables WHERE id = v_ta), (SELECT status FROM public.pos_tables WHERE id = v_tc),
        (SELECT table_id FROM public.pos_guest_order_requests WHERE id = v_req),
        (SELECT count(*) FROM public.pos_table_moves WHERE from_order_id = v_o1);
    END IF;

    -- ── (2) a direct write cannot move a bill: its table is kept ─────────────────────────────────
    SET LOCAL ROLE authenticated;
    UPDATE public.pos_orders SET table_id = v_ta, table_name = 'S836 probe sneaky' WHERE id = v_o1;
    RESET ROLE;
    IF (SELECT table_id FROM public.pos_orders WHERE id = v_o1) IS DISTINCT FROM v_tc
       OR (SELECT table_name FROM public.pos_orders WHERE id = v_o1) IS DISTINCT FROM 'S836 probe C' THEN
      RAISE EXCEPTION 'S836 probe: a direct write moved the bill to %', (SELECT table_name FROM public.pos_orders WHERE id = v_o1);
    END IF;

    -- ── (3) join B (with its own bill) onto the bill at C ─────────────────────────────────────
    SET LOCAL ROLE authenticated;
    v_r := public.join_pos_tables(v_o1, v_tb, 1, 0);
    RESET ROLE;
    SELECT count(*) INTO v_n FROM public.pos_order_items WHERE order_id = v_o1 AND recipe_id = v_dish;
    IF EXISTS (SELECT 1 FROM public.pos_orders WHERE id = v_o2)
       OR v_n <> 1
       OR (SELECT qty FROM public.pos_order_items WHERE order_id = v_o1 AND recipe_id = v_dish) <> 5
       OR (SELECT sent_qty FROM public.pos_order_items WHERE order_id = v_o1 AND recipe_id = v_dish) <> 5
       OR (SELECT unit_price FROM public.pos_order_items WHERE order_id = v_o1 AND recipe_id = v_dish) <> 90
       OR (SELECT qty FROM public.pos_order_items WHERE order_id = v_o1 AND recipe_id = v_tea) IS DISTINCT FROM 1
       OR (SELECT covers FROM public.pos_orders WHERE id = v_o1) <> 5
       OR (SELECT items_version FROM public.pos_orders WHERE id = v_o1) <> 2
       OR (SELECT order_id FROM public.pos_kot_log WHERE id = v_k2) IS DISTINCT FROM v_o1
       OR (SELECT order_id FROM public.pos_table_joins WHERE table_id = v_tb) IS DISTINCT FROM v_o1
       OR (SELECT status FROM public.pos_tables WHERE id = v_tb) IS DISTINCT FROM 'occupied'
       OR NOT EXISTS (SELECT 1 FROM public.pos_table_moves WHERE kind = 'join' AND to_order_id = v_o1 AND from_table_name = 'S836 probe B') THEN
      RAISE EXCEPTION 'S836 probe: the join left B''s bill %, % momo row(s) on C''s bill (qty %, sent %, price %), covers %, B''s ticket on %, the join %',
        (SELECT status FROM public.pos_orders WHERE id = v_o2), v_n,
        (SELECT max(qty) FROM public.pos_order_items WHERE order_id = v_o1 AND recipe_id = v_dish),
        (SELECT max(sent_qty) FROM public.pos_order_items WHERE order_id = v_o1 AND recipe_id = v_dish),
        (SELECT max(unit_price) FROM public.pos_order_items WHERE order_id = v_o1 AND recipe_id = v_dish),
        (SELECT covers FROM public.pos_orders WHERE id = v_o1),
        (SELECT order_id FROM public.pos_kot_log WHERE id = v_k2),
        (SELECT order_id FROM public.pos_table_joins WHERE table_id = v_tb);
    END IF;
    -- No new bill on a joined table.
    SET LOCAL ROLE authenticated;
    v_hint := NULL;
    BEGIN
      INSERT INTO public.pos_orders (client_id, table_id, table_name) VALUES (v_client, v_tb, 'S836 probe B');
    EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    END;
    RESET ROLE;
    IF v_hint IS DISTINCT FROM 'pos_table_joined' THEN
      RAISE EXCEPTION 'S836 probe: a new bill on a joined table answered %', COALESCE(v_hint, 'nothing');
    END IF;

    -- ── (4) all 5 momo to D, a free table: a new bill there; the tea stays ─────────────────────
    SELECT id INTO v_row FROM public.pos_order_items WHERE order_id = v_o1 AND recipe_id = v_dish;
    SET LOCAL ROLE authenticated;
    v_r := public.move_pos_order_lines(v_o1, v_td, jsonb_build_array(jsonb_build_object('item_id', v_row, 'qty', 5)), 2, NULL, 1);
    RESET ROLE;
    v_o3 := (v_r->>'to_order_id')::uuid;
    IF (SELECT table_id FROM public.pos_orders WHERE id = v_o3) IS DISTINCT FROM v_td
       OR (SELECT qty FROM public.pos_order_items WHERE order_id = v_o3 AND recipe_id = v_dish) IS DISTINCT FROM 5
       OR (SELECT sent_qty FROM public.pos_order_items WHERE order_id = v_o3 AND recipe_id = v_dish) IS DISTINCT FROM 5
       OR EXISTS (SELECT 1 FROM public.pos_order_items WHERE order_id = v_o1 AND recipe_id = v_dish)
       OR (SELECT covers FROM public.pos_orders WHERE id = v_o1) <> 4
       OR (SELECT covers FROM public.pos_orders WHERE id = v_o3) <> 1
       OR (SELECT status FROM public.pos_tables WHERE id = v_td) IS DISTINCT FROM 'occupied'
       OR public.pos_moved_out_sent(v_o1, v_dish::text) <> 5
       OR public.pos_moved_out_sent(v_o3, v_dish::text) <> -5 THEN
      RAISE EXCEPTION 'S836 probe: moving the momo to D left % there (sent %), covers % / %, moved-out counts % / %',
        (SELECT qty FROM public.pos_order_items WHERE order_id = v_o3 AND recipe_id = v_dish),
        (SELECT sent_qty FROM public.pos_order_items WHERE order_id = v_o3 AND recipe_id = v_dish),
        (SELECT covers FROM public.pos_orders WHERE id = v_o1), (SELECT covers FROM public.pos_orders WHERE id = v_o3),
        public.pos_moved_out_sent(v_o1, v_dish::text), public.pos_moved_out_sent(v_o3, v_dish::text);
    END IF;
    -- The kitchen: C's first ticket (3 momo) is still owed (at D), so a Staff login cannot clear
    -- it. Without the moved-out count the bill would hold none and the clear would pass.
    SET LOCAL ROLE authenticated;
    v_hint := NULL;
    BEGIN UPDATE public.pos_kot_log SET status = 'cancelled' WHERE id = v_k1; EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT; END;
    -- Moving the last dish (the tea) is Move, not a dish move.
    SELECT id INTO v_row FROM public.pos_order_items WHERE order_id = v_o1 AND recipe_id = v_tea;
    v_hint2 := NULL;
    BEGIN
      PERFORM public.move_pos_order_lines(v_o1, v_ta, jsonb_build_array(jsonb_build_object('item_id', v_row, 'qty', 1)), 3, NULL, 0);
    EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_hint2 = PG_EXCEPTION_HINT; END;
    RESET ROLE;
    IF v_hint IS DISTINCT FROM 'pos_kot_clear_food_left' OR v_hint2 IS DISTINCT FROM 'pos_move_all_lines' THEN
      RAISE EXCEPTION 'S836 probe: clearing a ticket whose food moved answered %; moving the last dish answered %',
        COALESCE(v_hint, 'cleared'), COALESCE(v_hint2, 'moved');
    END IF;

    -- ── (5) pay part now at D: 2 momo to a part bill, put back, then 1 to a part bill, paid ────
    SELECT id INTO v_row FROM public.pos_order_items WHERE order_id = v_o3 AND recipe_id = v_dish;
    SET LOCAL ROLE authenticated;
    v_r := public.split_pos_part_bill(v_o3, jsonb_build_array(jsonb_build_object('item_id', v_row, 'qty', 2)), 1, 1);
    v_p1 := (v_r->>'part_order_id')::uuid;
    RESET ROLE;
    IF (SELECT part_of_order_id FROM public.pos_orders WHERE id = v_p1) IS DISTINCT FROM v_o3
       OR (SELECT table_id FROM public.pos_orders WHERE id = v_p1) IS NOT NULL
       OR (SELECT table_name FROM public.pos_orders WHERE id = v_p1) IS DISTINCT FROM 'S836 probe D'
       OR (SELECT qty FROM public.pos_order_items WHERE order_id = v_p1) IS DISTINCT FROM 2
       OR (SELECT sent_qty FROM public.pos_order_items WHERE order_id = v_p1) IS DISTINCT FROM 2
       OR (SELECT qty FROM public.pos_order_items WHERE order_id = v_o3) IS DISTINCT FROM 3
       OR (SELECT sent_qty FROM public.pos_order_items WHERE order_id = v_o3) IS DISTINCT FROM 3 THEN
      RAISE EXCEPTION 'S836 probe: the part bill holds % (sent %), D''s bill %',
        (SELECT qty FROM public.pos_order_items WHERE order_id = v_p1), (SELECT sent_qty FROM public.pos_order_items WHERE order_id = v_p1),
        (SELECT qty FROM public.pos_order_items WHERE order_id = v_o3);
    END IF;
    SET LOCAL ROLE authenticated;
    v_r := public.put_back_part_bill(v_p1, 1, 2);
    RESET ROLE;
    SELECT count(*) INTO v_n FROM public.pos_order_items WHERE order_id = v_o3;
    IF EXISTS (SELECT 1 FROM public.pos_orders WHERE id = v_p1) OR v_n <> 1
       OR (SELECT qty FROM public.pos_order_items WHERE order_id = v_o3) <> 5
       OR (SELECT sent_qty FROM public.pos_order_items WHERE order_id = v_o3) <> 5
       OR public.pos_moved_out_sent(v_o3, v_dish::text) <> -5 THEN
      RAISE EXCEPTION 'S836 probe: putting the part bill back left it %, % row(s) on D''s bill', (SELECT status FROM public.pos_orders WHERE id = v_p1), v_n;
    END IF;
    SELECT id INTO v_row FROM public.pos_order_items WHERE order_id = v_o3;
    SET LOCAL ROLE authenticated;
    v_hint := NULL;
    BEGIN
      PERFORM public.split_pos_part_bill(v_o3, jsonb_build_array(jsonb_build_object('item_id', v_row, 'qty', 5)), 3, 1);
    EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT; END;
    v_r := public.split_pos_part_bill(v_o3, jsonb_build_array(jsonb_build_object('item_id', v_row, 'qty', 1)), 3, 0);
    v_p2 := (v_r->>'part_order_id')::uuid;
    RESET ROLE;
    IF v_hint IS DISTINCT FROM 'pos_part_all_lines' THEN
      RAISE EXCEPTION 'S836 probe: a part bill of the whole bill answered %', COALESCE(v_hint, 'made');
    END IF;

    -- ── (6) closing: the part bill frees nothing; C's bill frees C and joined B ──────────────────
    PERFORM set_config('request.jwt.claims', '', true);
    UPDATE public.pos_orders
       SET status = 'billed', close_type = 'paid', payment_method = 'Cash', discount_amount = 0, paid_amount = 90,
           vat_registered = false, invoice_fy = v_fy, closed_at = now()
     WHERE id = v_p2;
    IF (SELECT status FROM public.pos_tables WHERE id = v_td) IS DISTINCT FROM 'occupied' THEN
      RAISE EXCEPTION 'S836 probe: paying a part bill freed its table';
    END IF;
    UPDATE public.pos_orders
       SET status = 'billed', close_type = 'paid', payment_method = 'Cash', discount_amount = 0, paid_amount = 50,
           vat_registered = false, invoice_fy = v_fy, closed_at = now()
     WHERE id = v_o1;
    IF (SELECT status FROM public.pos_tables WHERE id = v_tc) IS DISTINCT FROM 'available'
       OR (SELECT status FROM public.pos_tables WHERE id = v_tb) IS DISTINCT FROM 'available'
       OR EXISTS (SELECT 1 FROM public.pos_table_joins WHERE order_id = v_o1) THEN
      RAISE EXCEPTION 'S836 probe: closing the joined bill left C %, B %', (SELECT status FROM public.pos_tables WHERE id = v_tc),
        (SELECT status FROM public.pos_tables WHERE id = v_tb);
    END IF;

    -- ── (7) join a free table onto D's bill and release it; then a login with no POS rank ───────
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_staff)::text, true);
    SET LOCAL ROLE authenticated;
    v_r := public.join_pos_tables(v_o3, v_ta, NULL, NULL);
    v_r := public.release_joined_table(v_ta);
    RESET ROLE;
    IF EXISTS (SELECT 1 FROM public.pos_table_joins WHERE table_id = v_ta)
       OR (SELECT status FROM public.pos_tables WHERE id = v_ta) IS DISTINCT FROM 'available'
       OR NOT EXISTS (SELECT 1 FROM public.pos_table_moves WHERE kind = 'release' AND from_table_id = v_ta) THEN
      RAISE EXCEPTION 'S836 probe: releasing a joined table left it %', (SELECT status FROM public.pos_tables WHERE id = v_ta);
    END IF;
    -- An IMS manager of the outlet (no POS rank, and not the Owner) is refused.
    UPDATE public.profiles SET pos_role = NULL, pos_email = NULL, ims_role = 'manager' WHERE id = v_staff;
    SET LOCAL ROLE authenticated;
    v_hint := NULL;
    BEGIN PERFORM public.move_pos_order_table(v_o3, v_ta, NULL); EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT; END;
    RESET ROLE;
    IF v_hint IS DISTINCT FROM 'pos_move_rank' THEN
      RAISE EXCEPTION 'S836 probe: a login with no POS rank moving a bill answered %', COALESCE(v_hint, 'moved');
    END IF;

    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('request.headers', '', true);
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 's836_probe_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 's836_probe_rollback' THEN RAISE; END IF;
  END;
END;
$$;


NOTIFY pgrst, 'reload schema';


-- ── 12. What this file changed, live (the last statement, so `db query` prints it) ────────────
SELECT
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.guard_pos_order_close()'::regprocedure) = 'ad92a74549be6bf5a06d7d93172935b2' AS close_guard_ok,
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.guard_pos_order_insert()'::regprocedure) = '9a861b3c577ee0cab90cde9986b999bc' AS insert_guard_ok,
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.guard_pos_kot_log()'::regprocedure) = 'ef5b2f1f772675e7839f3a05edc6600e' AS ticket_guard_ok,
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.get_group_summary(integer, integer, date, date)'::regprocedure) = 'dc7e1fd26ce0186a282c10d144f5c407' AS group_summary_ok,
  (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prosecdef
      AND proname IN ('move_pos_order_table', 'join_pos_tables', 'release_joined_table',
                      'move_pos_order_lines', 'split_pos_part_bill', 'put_back_part_bill')) AS definer_functions,
  has_function_privilege('anon', 'public.move_pos_order_table(uuid, uuid, integer)', 'EXECUTE') AS anon_can_move,
  has_function_privilege('authenticated', 'public.split_pos_part_bill(uuid, jsonb, integer, integer)', 'EXECUTE') AS logins_can_split,
  has_function_privilege('authenticated', 'public.pos_move_lines(uuid, uuid, jsonb)', 'EXECUTE') AS logins_can_call_mover,
  has_table_privilege('authenticated', 'public.pos_table_moves', 'UPDATE') AS logins_can_update_record,
  has_table_privilege('anon', 'public.pos_table_joins', 'SELECT') AS anon_can_read_joins,
  (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('pos_table_joins', 'pos_table_moves')) AS policies,
  (SELECT string_agg(tgname, ', ' ORDER BY tgname) FROM pg_trigger
    WHERE tgrelid = 'public.pos_orders'::regclass AND tgname LIKE 'pos_orders_release_tables%') AS release_triggers,
  (SELECT confdeltype::text FROM pg_constraint WHERE conrelid = 'public.pos_orders'::regclass
      AND contype = 'f' AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'public.pos_orders'::regclass AND attname = 'part_of_order_id')]) AS part_of_on_delete;
