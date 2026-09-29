-- S792 stage 4, D37: a second count of an already-counted item asks "replace, or add yours?"
--
-- Every closing count used to be a plain PostgREST upsert on (period_id, item_id), so the second
-- tablet to count Rice (store room 12 kg, kitchen 8 kg) silently REPLACED the first. This adds:
--
--   1. closing_stock.count_parts jsonb — who contributed to an added total, [{by, name, qty, at}].
--      NULL for an ordinary single count; set only when a figure was ADDED to another.
--   2. closing_stock_tally_parts() — BEFORE INSERT OR UPDATE, named to fire after
--      closing_stock_stamp_counter (BEFORE triggers run by name). Stamps counted_at with the
--      server's now() (it was the tablet's clock) and keeps count_parts honest: appended on an add,
--      cleared on any other change of figure or counter, never writable on its own.
--   3. closing_stock_guard_recount() gains one carve-out (Q6 (a)): with recount protection on, a
--      staff counter may ADD to another person's count — the figure only grows and the first count
--      stays in count_parts — but may still never replace or delete it.
--   4. save_closing_counts(p_period_id, p_rows) — the one save path for a counted (non-blank)
--      closing figure. Per row: mode 'check' writes only when nobody else holds the row, otherwise
--      writes NOTHING for that item and returns the stored count as a conflict; 'replace' and 'add'
--      are the counter's answer. The add is one atomic statement, so two tablets adding at once
--      both land. SECURITY INVOKER on purpose: section-scope RLS, the closed-month lock, the recount
--      guard and the counter stamp all keep applying, unchanged.
--
-- Blank-cell deletes stay plain PostgREST deletes (unchanged).
--
-- Reverse: DROP FUNCTION public.save_closing_counts(uuid, jsonb); DROP TRIGGER
-- closing_stock_tally_parts ON public.closing_stock; DROP FUNCTION public.closing_stock_tally_parts();
-- re-run closing_stock_guard_recount() from 20260910120000; ALTER TABLE public.closing_stock DROP
-- COLUMN count_parts. The app falls back to the plain upsert when the RPC is missing (PGRST202).

-- ══ 1. count_parts ═══════════════════════════════════════════════════════════════════════════════
ALTER TABLE public.closing_stock ADD COLUMN IF NOT EXISTS count_parts jsonb;

COMMENT ON COLUMN public.closing_stock.count_parts IS
  'S792 D37: the counts an added total is made of, [{by, name, qty, at}]. NULL for a single count. Written only by closing_stock_tally_parts().';


-- ══ 2. The tally trigger ═════════════════════════════════════════════════════════════════════════
-- SECURITY INVOKER: it only rewrites NEW. auth.uid() IS NULL is the service role (restore, Danger
-- Zone), which keeps exactly what it sends — a restore must put count_parts and counted_at back as
-- they were.
CREATE OR REPLACE FUNCTION public.closing_stock_tally_parts()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_add boolean := COALESCE(current_setting('crest.count_add', true), '') = 'on';
BEGIN
  IF (select auth.uid()) IS NULL THEN RETURN NEW; END IF;

  IF TG_OP = 'UPDATE'
     AND NOT v_add
     AND NEW.physical_qty IS NOT DISTINCT FROM OLD.physical_qty
     AND NEW.counted_by   IS NOT DISTINCT FROM OLD.counted_by THEN
    -- Nothing counted changed: the parts and the time stay as they were, whatever was sent.
    NEW.count_parts := OLD.count_parts;
    NEW.counted_at  := OLD.counted_at;
    RETURN NEW;
  END IF;

  NEW.counted_at := now();

  IF TG_OP = 'UPDATE' AND v_add THEN
    NEW.count_parts :=
      COALESCE(OLD.count_parts, jsonb_build_array(jsonb_build_object(
        'by', OLD.counted_by, 'name', OLD.counted_by_name, 'qty', OLD.physical_qty, 'at', OLD.counted_at)))
      || jsonb_build_array(jsonb_build_object(
        'by', NEW.counted_by, 'name', NEW.counted_by_name, 'qty', NEW.physical_qty - OLD.physical_qty, 'at', now()));
  ELSE
    NEW.count_parts := NULL;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.closing_stock_tally_parts() FROM PUBLIC;

DROP TRIGGER IF EXISTS closing_stock_tally_parts ON public.closing_stock;
CREATE TRIGGER closing_stock_tally_parts
  BEFORE INSERT OR UPDATE ON public.closing_stock
  FOR EACH ROW EXECUTE FUNCTION public.closing_stock_tally_parts();


-- ══ 3. The recount guard: a staff counter may ADD ════════════════════════════════════════════════
-- Body as 20260910120000 plus the carve-out. `crest.count_add` is set, transaction-local, only by
-- save_closing_counts' add statement (PostgREST lets a caller set request.* settings, never
-- crest.*), and the figure must not shrink — so the carve-out cannot be used to replace a count.
CREATE OR REPLACE FUNCTION public.closing_stock_guard_recount() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN RETURN COALESCE(NEW, OLD); END IF;
  IF NOT public.ims_recount_guard_on() THEN RETURN COALESCE(NEW, OLD); END IF;

  -- Nobody has claimed this row yet, or the claimant is the person writing now.
  IF OLD.counted_by IS NULL OR OLD.counted_by = (select auth.uid()) THEN RETURN COALESCE(NEW, OLD); END IF;

  IF COALESCE((SELECT p.ims_role FROM profiles p WHERE p.id = (select auth.uid())), '') <> 'staff' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- D37 (S792): adding a second location's count keeps the first count whole.
  IF TG_OP = 'UPDATE'
     AND COALESCE(current_setting('crest.count_add', true), '') = 'on'
     AND COALESCE(NEW.physical_qty >= OLD.physical_qty, false) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'closing_count_locked: counted by %', COALESCE(OLD.counted_by_name, 'another staff member');
END;
$$;


-- ══ 4. save_closing_counts ═══════════════════════════════════════════════════════════════════════
-- p_rows: [{item_id, qty, mode: 'check'|'replace'|'add', counted_by?, counted_by_name?}]
-- Returns {saved: [{item_id, physical_qty, counted_by, counted_by_name, counted_at, count_parts}],
--          conflicts: [{item_id, physical_qty, counted_by, counted_by_name, counted_at, count_parts}]}
--
-- "Someone else holds the row" means a stored count whose counted_by is set and is not the counter
-- of this figure (counted_by as sent, which a queued offline figure carries; else the caller). A
-- row with no counter predates S737 and is replaced as before. The rows are handled in item order,
-- so two Save Alls over overlapping items lock in the same order and cannot deadlock.
CREATE OR REPLACE FUNCTION public.save_closing_counts(p_period_id uuid, p_rows jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_me        uuid := (select auth.uid());
  v_row       jsonb;
  v_item      uuid;
  v_qty       numeric;
  v_mode      text;
  v_by        uuid;
  v_name      text;
  v_cur       closing_stock%ROWTYPE;
  v_new       closing_stock%ROWTYPE;
  v_found     boolean;
  v_saved     jsonb := '[]'::jsonb;
  v_conflicts jsonb := '[]'::jsonb;
BEGIN
  IF v_me IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;
  IF p_period_id IS NULL OR p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'count_rows_invalid: expected an array of counts' USING ERRCODE = '22023';
  END IF;

  FOR v_row IN
    SELECT value FROM jsonb_array_elements(p_rows) ORDER BY value ->> 'item_id'
  LOOP
    v_item := NULLIF(v_row ->> 'item_id', '')::uuid;
    v_qty  := (v_row ->> 'qty')::numeric;
    v_mode := COALESCE(v_row ->> 'mode', 'check');
    v_by   := COALESCE(NULLIF(v_row ->> 'counted_by', '')::uuid, v_me);
    v_name := v_row ->> 'counted_by_name';
    v_new  := NULL;

    IF v_item IS NULL THEN
      RAISE EXCEPTION 'count_rows_invalid: a count has no item' USING ERRCODE = '22023';
    END IF;
    IF v_qty IS NULL OR v_qty < 0 THEN
      RAISE EXCEPTION 'count_qty_invalid: a count must be 0 or more' USING ERRCODE = '22023';
    END IF;
    IF v_mode NOT IN ('check', 'replace', 'add') THEN
      RAISE EXCEPTION 'count_rows_invalid: unknown mode %', v_mode USING ERRCODE = '22023';
    END IF;

    -- A 'check' with no row yet inserts, and one that lost a same-instant race to another insert
    -- goes round once more and is judged against the row that won.
    FOR attempt IN 1..2 LOOP
      SELECT * INTO v_cur FROM closing_stock
       WHERE period_id = p_period_id AND item_id = v_item
       FOR UPDATE;
      v_found := FOUND;

      IF v_mode = 'check' AND v_found
         AND v_cur.counted_by IS NOT NULL AND v_cur.counted_by <> v_by THEN
        v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object(
          'item_id', v_item, 'physical_qty', v_cur.physical_qty, 'counted_by', v_cur.counted_by,
          'counted_by_name', v_cur.counted_by_name, 'counted_at', v_cur.counted_at,
          'count_parts', v_cur.count_parts));
        EXIT;
      END IF;

      IF NOT v_found THEN
        INSERT INTO closing_stock (period_id, item_id, physical_qty, counted_by, counted_by_name)
        VALUES (p_period_id, v_item, v_qty, v_by, v_name)
        ON CONFLICT (period_id, item_id) DO NOTHING
        RETURNING * INTO v_new;
        IF FOUND THEN EXIT; END IF;
        IF attempt = 2 THEN
          RAISE EXCEPTION 'count_save_raced: the count for this item changed while saving; save it again'
            USING ERRCODE = '40001';
        END IF;
        CONTINUE;
      END IF;

      IF v_mode = 'add' THEN
        PERFORM set_config('crest.count_add', 'on', true);
        UPDATE closing_stock
           SET physical_qty = physical_qty + v_qty,
               counted_by = v_by, counted_by_name = v_name
         WHERE id = v_cur.id
        RETURNING * INTO v_new;
        PERFORM set_config('crest.count_add', '', true);
      ELSE
        UPDATE closing_stock
           SET physical_qty = v_qty,
               counted_by = v_by, counted_by_name = v_name
         WHERE id = v_cur.id
        RETURNING * INTO v_new;
      END IF;
      EXIT;
    END LOOP;

    IF v_new.id IS NOT NULL THEN
      v_saved := v_saved || jsonb_build_array(jsonb_build_object(
        'item_id', v_new.item_id, 'physical_qty', v_new.physical_qty, 'counted_by', v_new.counted_by,
        'counted_by_name', v_new.counted_by_name, 'counted_at', v_new.counted_at,
        'count_parts', v_new.count_parts));
    END IF;
  END LOOP;

  RETURN jsonb_build_object('saved', v_saved, 'conflicts', v_conflicts);
END;
$function$;

REVOKE ALL ON FUNCTION public.save_closing_counts(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_closing_counts(uuid, jsonb) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
