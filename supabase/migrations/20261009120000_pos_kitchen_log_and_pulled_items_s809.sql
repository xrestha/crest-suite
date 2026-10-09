-- ════════════════════════════════════════════════════════════════════════════════════════════
-- S809 stage 1, slice 1d: the kitchen-ticket log and the pulled-item record can only be written
-- the way the till writes them, and a fired dish cannot be quietly marked "not sent".
--
--   DATABASE-1 (P1). pos_kot_log had a same-client FOR ALL policy, INSERT/UPDATE/DELETE granted
--   to authenticated and no trigger. Any login of the outlet, a Staff PIN included, could delete
--   or rewrite the tickets KOT Reconciliation checks bills against, post a ticket naming any order,
--   backdate it, re-attribute it, or push another table's tickets back or off the Kitchen Display.
--   pos_kot_removals took any INSERT with removed_by / removed_at as sent, so a pulled-item record
--   could be filed under a colleague's name at any time.
--
--     (1) guard_pos_kot_log, BEFORE INSERT/UPDATE/DELETE. A client session never deletes a ticket:
--         not directly (DELETE is also revoked), and not by deleting its order, whose cascade the
--         trigger sees through the JWT (pos-billing.md S755: a cascade runs as the table owner, so
--         current_user cannot tell who asked). On insert the order must be this outlet's, the time
--         and the kitchen stage are the server's, and sent_by is kept only when it names a POS login
--         of this outlet; otherwise it is the login that sent it (owner decision Q1 b, 2026-10-08:
--         an offline ticket keeps the waiter the till recorded). On update only the kitchen stage
--         moves, forward only; 'cancelled' needs a supervisor or a voided order, and is final.
--     (2) guard_pos_kot_removals, BEFORE INSERT/UPDATE/DELETE. A client session's insert lands only
--         from inside save_pos_order_items (a transaction flag around its one insert) or from the
--         operator's restore. The two delete triggers are SECURITY DEFINER and pass as the owner.
--
--   ORDER-FLOW-2 (P1). A waiter could take a cooked dish off the bill with no pulled-item record by
--   first saving the line as "not sent", then removing it: the removal diff and both delete
--   triggers count the STORED sent quantity, which had just become 0. Two ways in: a PATCH
--   (guard_pos_item_price let sent_to_kot / sent_qty through) and save_pos_order_items itself
--   (its replacement rows took the browser's sent_qty).
--
--     (3) save_pos_order_items: a replacement row keeps at least what the kitchen already has of its
--         line, shared out over the rows of that line, never more than a row's quantity. A sent
--         count now goes down only with the quantity, and the removal record has already written
--         that up. sent_to_kot stays as sent: false with sent_qty = qty is the order screen's own
--         "edited since it was sent" state (a changed note).
--     (4) guard_pos_item_price: a direct UPDATE that lowers a line's sent count is refused
--         (pos_item_sent_lowered). No screen has written these columns directly since S754.
--
-- Built on LIVE bodies read 2026-10-09 (md5(prosrc)):
--     save_pos_order_items(uuid, jsonb, text, integer)   24aed2bd6fe8a285414f3714fe650e05
--     guard_pos_item_price()                              dbf54c84f0942160041149fcdac5392a
-- Section 0 refuses to run if either changed since. Slice 1b changes save_pos_order_items: merge
-- the "S809 1d" blocks of section 3 onto the body 1b leaves live, then put that body's md5 here.
--
-- Live before this migration: 48 tickets (BLOOM CAFE only), 0 naming another outlet's order;
-- 1 pulled-item row, 0 crossing outlets; 0 order lines with sent_qty above qty. No constraint is
-- added and no row is rewritten: the triggers judge new writes only.
--
-- The probe at the end runs as the outlet's Owner, a Staff-rank POS login and the operator inside
-- a block that rolls itself back. If any check fails, the whole migration fails and nothing lands.
-- ════════════════════════════════════════════════════════════════════════════════════════════


-- ── 0. Pre-flight: the bodies this file replaces are the ones it was built on ─────────────────
DO $$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc
   WHERE oid = 'public.save_pos_order_items(uuid, jsonb, text, integer)'::regprocedure;
  IF v_md5 IS DISTINCT FROM '24aed2bd6fe8a285414f3714fe650e05' THEN
    RAISE EXCEPTION 'S809 1d: save_pos_order_items changed since this slice was drafted (live md5 %) — merge section 3 onto the live body and update the md5 in section 0', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc
   WHERE oid = 'public.guard_pos_item_price()'::regprocedure;
  IF v_md5 IS DISTINCT FROM 'dbf54c84f0942160041149fcdac5392a' THEN
    RAISE EXCEPTION 'S809 1d: guard_pos_item_price changed since this slice was drafted (live md5 %) — merge section 4 onto the live body and update the md5 in section 0', v_md5;
  END IF;
END;
$$;


-- ── 1. A kitchen ticket is written once, and only its kitchen stage moves (DATABASE-1) ─────────
--
-- SECURITY DEFINER, and "who asked" is read from the JWT rather than current_user, for two reasons:
--   * the sender check reads a colleague's profile, which a waiter's RLS view of profiles (self or
--     admin) cannot see, and a guard whose read is narrower than its target passes or refuses by
--     accident (the S749 lesson);
--   * deleting a ticket's order cascades into this table as the table owner, so current_user there
--     is the owner whoever asked. The JWT still says who did. pos_kot_log.order_id is ON DELETE
--     CASCADE, so without this a waiter could post a ticket on an empty order of their own, have it
--     cooked, and delete the order to take the ticket with it.
-- Passed through: the service role, a request with no JWT (migrations, cron), and the operator (the
-- restore re-inserts tickets as they were; Clear Occupied deletes open orders and their tickets; a
-- profile delete sets sent_by NULL). A SECURITY DEFINER function that writes this table on a
-- client's behalf is checked like the client, so give it a transaction flag of its own, as
-- save_pos_order_items does for pos_kot_removals below.
--
-- The writers this admits, all in src/ (v412 included): PosOrders logKotSend (INSERT, no time or
-- stage sent), the offline replay (INSERT of the queued payload, sent_by = the waiter who sent it),
-- markOrderServed (ready → served), closeOrder's void (→ cancelled, after the order is voided, by a
-- supervisor), and KitchenDisplay advance (new → in_progress → ready → served). Each status write is
-- conditional on the status the screen saw, so a forward-only rule never meets the app.
CREATE OR REPLACE FUNCTION public.guard_pos_kot_log()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid          uuid := (SELECT auth.uid());
  v_order_client uuid;
  v_from         integer;
  v_to           integer;
  -- The kitchen-stage columns: the only ones a client session may change on a ticket.
  v_stage        CONSTANT text[] := ARRAY['status', 'started_at', 'ready_at', 'served_at',
                                          'estimated_prep_minutes', 'status_updated_by'];
BEGIN
  IF COALESCE((SELECT auth.jwt() ->> 'role'), '') NOT IN ('anon', 'authenticated')
     OR COALESCE(public.is_admin(), false) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pos_kot_ticket_locked: a kitchen ticket is the record of what was sent to the kitchen or bar, so it cannot be deleted, and nor can an order that has one — void the order instead'
      USING ERRCODE = '42501', HINT = 'pos_kot_ticket_locked';
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- The foreign key checks only that the order exists; RLS checks only the ticket's own client.
    SELECT o.client_id INTO v_order_client FROM pos_orders o WHERE o.id = NEW.order_id;
    IF v_order_client IS DISTINCT FROM NEW.client_id THEN
      RAISE EXCEPTION 'pos_kot_other_outlet: a kitchen ticket can only be sent for an order of its own outlet'
        USING ERRCODE = '23503', HINT = 'pos_kot_other_outlet';
    END IF;

    -- A ticket starts new, now. The till sends none of these; an offline replay is logged at upload,
    -- exactly as the column default always did.
    NEW.sent_at                := now();
    NEW.status                 := 'new';
    NEW.started_at             := NULL;
    NEW.ready_at               := NULL;
    NEW.served_at              := NULL;
    NEW.estimated_prep_minutes := NULL;
    NEW.status_updated_by      := NULL;

    -- Q1 (b). Offline, the till queues the ticket under the waiter who sent it and uploads it later
    -- under whoever is signed in then. That waiter is kept when they are a POS login of this outlet;
    -- anyone else (another outlet's login, an Owner or manager without a POS login, a made-up id)
    -- becomes the login that uploaded it. An online send names its own login, which is always kept.
    IF NEW.sent_by IS DISTINCT FROM v_uid AND NOT COALESCE(EXISTS (
         SELECT 1 FROM profiles p
          WHERE p.id = NEW.sent_by
            AND (p.pos_role IS NOT NULL OR p.pos_email IS NOT NULL)
            AND NEW.client_id IN (p.client_id, p.active_client_id)), false) THEN
      NEW.sent_by := v_uid;
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE. An allow-list, so a column added later is locked by default (invariant #1's reason).
  IF (to_jsonb(NEW) - v_stage) IS DISTINCT FROM (to_jsonb(OLD) - v_stage) THEN
    RAISE EXCEPTION 'pos_kot_ticket_locked: a kitchen ticket is the record of what was sent to the kitchen or bar — what it says, which order it is for, who sent it and when cannot be changed; only its kitchen stage moves'
      USING ERRCODE = '42501', HINT = 'pos_kot_ticket_locked';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled' THEN
      -- The till cancels a voided order's tickets right after the void; nothing else cancels one.
      IF NOT COALESCE(public.pos_caller_has_rank('supervisor')
                      OR EXISTS (SELECT 1 FROM pos_orders o
                                  WHERE o.id = NEW.order_id AND o.status = 'voided'), false) THEN
        RAISE EXCEPTION 'pos_kot_cancel_rank: a kitchen ticket is cancelled when its order is voided, or by a POS supervisor or above'
          USING ERRCODE = '42501', HINT = 'pos_kot_cancel_rank';
      END IF;
    ELSE
      v_from := CASE OLD.status WHEN 'new' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'ready' THEN 2 WHEN 'served' THEN 3 END;
      v_to   := CASE NEW.status WHEN 'new' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'ready' THEN 2 WHEN 'served' THEN 3 END;
      -- A cancelled ticket has no rank (NULL), so it never moves again.
      IF NOT COALESCE(v_to > v_from, false) THEN
        RAISE EXCEPTION 'pos_kot_status_backwards: a kitchen ticket only moves forward (new, started, ready, served), and a cancelled ticket stays cancelled'
          USING ERRCODE = '42501', HINT = 'pos_kot_status_backwards';
      END IF;
    END IF;
    NEW.status_updated_by := v_uid;
  ELSE
    NEW.status_updated_by := OLD.status_updated_by;
  END IF;
  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION public.guard_pos_kot_log() FROM PUBLIC;

DROP TRIGGER IF EXISTS guard_pos_kot_log ON public.pos_kot_log;
CREATE TRIGGER guard_pos_kot_log
  BEFORE INSERT OR UPDATE OR DELETE ON public.pos_kot_log
  FOR EACH ROW EXECUTE FUNCTION public.guard_pos_kot_log();

-- No client writer deletes a ticket (grep: none in src/; Danger Zone is the service role, and a
-- cascade needs no grant on the child). The trigger words the cascade case; this closes the direct
-- one even if the trigger is ever disabled.
REVOKE DELETE ON public.pos_kot_log FROM PUBLIC, anon, authenticated;

-- The schema's default privileges also handed both tables TRUNCATE / REFERENCES / TRIGGER /
-- MAINTAIN for the browser roles (the S782 trap; live relacl anon=Dxtm, authenticated=arDxtm on
-- pos_kot_removals). TRUNCATE skips RLS and row triggers. PostgREST cannot reach them, so this is
-- hygiene, closed here because this migration is the one that fences these two tables.
REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON public.pos_kot_log, public.pos_kot_removals
  FROM PUBLIC, anon, authenticated;


-- ── 2. A pulled-item record comes only from the removal it records (DATABASE-1) ───────────────
--
-- SECURITY INVOKER with the current_user seam, the house shape: record_pos_kot_removals_on_line_delete
-- and record_pos_kot_removals_on_order_delete are SECURITY DEFINER, so they write as the owner and
-- pass; so do the foreign keys' SET NULL (order deleted) and CASCADE (client deleted), and the
-- service role (Danger Zone). save_pos_order_items is INVOKER, so it marks its own insert with
-- crest.pos_kot_removals_rpc, which a PostgREST table request cannot set. The operator's restore
-- inserts history as it was. authenticated holds no UPDATE or DELETE here; the refusal covers them
-- anyway in case a grant is ever added.
CREATE OR REPLACE FUNCTION public.guard_pos_kot_removals()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF current_setting('crest.pos_kot_removals_rpc', true) = 'on' THEN
      RETURN NEW;
    END IF;
    IF COALESCE(public.is_admin(), false) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'pos_kot_removal_direct: a pulled-item record is written by the order screen when a dish already sent comes off the bill — it cannot be written, changed or deleted directly'
    USING ERRCODE = '42501', HINT = 'pos_kot_removal_direct';
END;
$fn$;
REVOKE ALL ON FUNCTION public.guard_pos_kot_removals() FROM PUBLIC;

DROP TRIGGER IF EXISTS guard_pos_kot_removals ON public.pos_kot_removals;
CREATE TRIGGER guard_pos_kot_removals
  BEFORE INSERT OR UPDATE OR DELETE ON public.pos_kot_removals
  FOR EACH ROW EXECUTE FUNCTION public.guard_pos_kot_removals();


-- ── 3. save_pos_order_items: the record's own flag, and a kitchen count that never drops ──────
--
-- The LIVE body (md5 24aed2bd6fe8a285414f3714fe650e05) with three blocks marked "S809 1d" and one
-- changed expression (the replacement rows' sent_qty). Nothing else differs. Grants are kept by
-- CREATE OR REPLACE (postgres, authenticated).
CREATE OR REPLACE FUNCTION public.save_pos_order_items(p_order_id uuid, p_rows jsonb, p_removal_reason text DEFAULT NULL::text, p_expected_version integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_client_id uuid;
  v_status    text;
  v_version   integer;
  v_vat_reg   boolean;
  v_inserted  integer := 0;
  v_bad       text;
  v_items     jsonb;
  v_prev      jsonb;
  v_rows      jsonb;
  v_opt       jsonb;
  v_existing  text[];
  v_any_opts  boolean;
BEGIN
  IF p_order_id IS NULL THEN
    RAISE EXCEPTION 'p_order_id is required';
  END IF;

  IF p_rows IS NOT NULL AND jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'p_rows must be a json array';
  END IF;

  -- client_id is derived from the order, never taken as a parameter. RLS hides another client's
  -- order, which reads as not found.
  SELECT client_id, status, items_version
    INTO v_client_id, v_status, v_version
    FROM pos_orders WHERE id = p_order_id
    FOR UPDATE;
  IF v_client_id IS NULL THEN
    RAISE EXCEPTION 'order not found or not visible: %', p_order_id;
  END IF;

  IF v_status IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'order_not_open: this bill is already closed, so its items cannot be changed — reload the floor'
      USING ERRCODE = 'P0001', HINT = 'order_not_open';
  END IF;

  IF p_expected_version IS NOT NULL AND p_expected_version IS DISTINCT FROM v_version THEN
    RAISE EXCEPTION 'stale_order: this order was changed on another device since it was opened here — reload it before saving'
      USING ERRCODE = 'P0001', HINT = 'stale_order',
            DETAIL = format('expected version %s, current version %s', p_expected_version, v_version);
  END IF;

  -- ── Validate the incoming lines ────────────────────────────────────────────────────────────
  SELECT string_agg(DISTINCT reason, '; ') INTO v_bad
    FROM (
      SELECT CASE
               WHEN NULLIF(r->>'recipe_id', '') IS NULL THEN 'a line with no menu item'
               WHEN COALESCE((r->>'qty')::integer, 1) < 1 THEN format('%s with a quantity below 1', COALESCE(r->>'name', 'a line'))
               WHEN r ? 'options' AND jsonb_typeof(r->'options') NOT IN ('array', 'null') THEN format('%s with unreadable options', COALESCE(r->>'name', 'a line'))
             END AS reason
        FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb)) AS r
    ) x
   WHERE reason IS NOT NULL;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'line_not_on_menu: %', v_bad USING ERRCODE = 'P0001', HINT = 'line_not_on_menu';
  END IF;

  -- Normalise every row once: its chosen option ids (distinct, sorted as text — the same order
  -- JavaScript's default sort gives lowercase uuids), its selection key, its line key, and an id
  -- minted now so the options snapshot can be linked to the line it belongs to.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id',            gen_random_uuid(),
           'n',             x.n,
           'src',           x.v,
           'recipe_id',     x.recipe_id,
           'has_options',   cardinality(x.opt_ids) > 0,
           'option_ids',    to_jsonb(x.opt_ids),
           'selection_key', array_to_string(x.opt_ids, '+'),
           'line_key',      x.recipe_id || CASE WHEN cardinality(x.opt_ids) > 0 THEN '#' || array_to_string(x.opt_ids, '+') ELSE '' END
         ) ORDER BY x.n), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT r.n, r.v, NULLIF(r.v->>'recipe_id', '') AS recipe_id,
             COALESCE((
               SELECT array_agg(o ORDER BY o COLLATE "C")
                 FROM (SELECT DISTINCT lower(e)::uuid::text AS o
                         FROM jsonb_array_elements_text(
                                CASE WHEN jsonb_typeof(r.v->'options') = 'array' THEN r.v->'options' ELSE '[]'::jsonb END) e) d
             ), ARRAY[]::text[]) AS opt_ids
        FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb)) WITH ORDINALITY AS r(v, n)
    ) x;

  v_any_opts := EXISTS (SELECT 1 FROM jsonb_array_elements(v_rows) r WHERE (r->>'has_options')::boolean);

  -- Line keys already on this order: an existing line keeps its price and snapshot, a new one is
  -- checked against today's menu.
  SELECT COALESCE(array_agg(recipe_id::text || CASE WHEN selection_key <> '' THEN '#' || selection_key ELSE '' END), ARRAY[]::text[])
    INTO v_existing
    FROM pos_order_items WHERE order_id = p_order_id AND recipe_id IS NOT NULL;

  -- A NEW line (a recipe not already on this order) must be on the till menu.
  SELECT string_agg(DISTINCT COALESCE(rec.name, r->'src'->>'name', r->>'recipe_id'), ', ') INTO v_bad
    FROM jsonb_array_elements(v_rows) AS r
    LEFT JOIN recipes rec
           ON rec.id = (r->>'recipe_id')::uuid
          AND rec.client_id = v_client_id
   WHERE NOT EXISTS (SELECT 1 FROM pos_order_items i
                      WHERE i.order_id = p_order_id AND i.recipe_id = (r->>'recipe_id')::uuid)
     AND NOT COALESCE(rec.id IS NOT NULL
                      AND rec.is_active IS NOT FALSE
                      AND rec.pos_enabled IS NOT FALSE
                      AND rec.category IS DISTINCT FROM 'Sub-Recipe', false);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'line_not_on_menu: % is not on the menu any more — remove it from the order and save again', v_bad
      USING ERRCODE = 'P0001', HINT = 'line_not_on_menu';
  END IF;

  -- ── Options on NEW lines ───────────────────────────────────────────────────────────────────
  IF v_any_opts THEN
    IF NOT public.customization_live(v_client_id) AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(v_rows) r
          WHERE (r->>'has_options')::boolean AND NOT (r->>'line_key') = ANY (v_existing)) THEN
      RAISE EXCEPTION 'order_options_off: Crest Customization is not switched on for this outlet, so dishes cannot be ordered with options'
        USING ERRCODE = 'P0001', HINT = 'order_options_off';
    END IF;

    -- Every chosen option is this outlet's, offered, and in a group this dish offers.
    SELECT string_agg(DISTINCT COALESCE(rec.name, r->>'recipe_id'), ', ') INTO v_bad
      FROM jsonb_array_elements(v_rows) r
      CROSS JOIN LATERAL jsonb_array_elements_text(r->'option_ids') e
      LEFT JOIN recipes rec ON rec.id = (r->>'recipe_id')::uuid
     WHERE (r->>'has_options')::boolean
       AND NOT (r->>'line_key') = ANY (v_existing)
       AND NOT EXISTS (
             SELECT 1
               FROM pos_options o
               JOIN pos_option_groups g ON g.id = o.group_id
               JOIN pos_recipe_option_groups a ON a.group_id = g.id AND a.recipe_id = (r->>'recipe_id')::uuid
              WHERE o.id = e::uuid AND o.client_id = v_client_id AND o.is_active AND g.is_active);
    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION 'option_not_on_menu: an option chosen for % is no longer offered on it — change the choices and save again', v_bad
        USING ERRCODE = 'P0001', HINT = 'option_not_on_menu';
    END IF;

    -- Every group the dish offers gets a number of picks its rule allows. A group with no offered
    -- options is skipped: a guest cannot be made to choose from nothing.
    SELECT string_agg(DISTINCT format('%s: %s', COALESCE(rec.name, 'a dish'), g.name), '; ') INTO v_bad
      FROM jsonb_array_elements(v_rows) r
      JOIN pos_recipe_option_groups a ON a.recipe_id = (r->>'recipe_id')::uuid AND a.client_id = v_client_id
      JOIN pos_option_groups g ON g.id = a.group_id AND g.is_active
      LEFT JOIN recipes rec ON rec.id = a.recipe_id
      CROSS JOIN LATERAL (
        SELECT count(*) AS picked
          FROM jsonb_array_elements_text(r->'option_ids') e
          JOIN pos_options o ON o.id = e::uuid AND o.group_id = g.id
      ) c
     WHERE (r->>'has_options')::boolean
       AND NOT (r->>'line_key') = ANY (v_existing)
       AND EXISTS (SELECT 1 FROM pos_options o2 WHERE o2.group_id = g.id AND o2.is_active)
       AND (c.picked < COALESCE(a.min_override, g.min_select)
            OR c.picked > COALESCE(a.max_override, g.max_select, c.picked));
    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION 'option_count: the choices do not fit what the dish allows (%) — change the choices and save again', v_bad
        USING ERRCODE = 'P0001', HINT = 'option_count';
    END IF;
  END IF;

  SELECT COALESCE(is_vat_registered, true) INTO v_vat_reg FROM settings WHERE client_id = v_client_id;
  v_vat_reg := COALESCE(v_vat_reg, true);

  -- ── Record any already-fired quantity about to disappear ───────────────────────────────────
  -- Grouped by LINE key since S758, so pulling one of two customized Momo lines names that one.
  -- S809 1d (DATABASE-1): pos_kot_removals refuses a client session's insert unless this flag is
  -- on, so a pulled-item record can only come from this diff (or from the two delete triggers,
  -- which are SECURITY DEFINER). On for this one statement only.
  PERFORM set_config('crest.pos_kot_removals_rpc', 'on', true);
  WITH before_sent AS (
    SELECT COALESCE(recipe_id::text || CASE WHEN selection_key <> '' THEN '#' || selection_key ELSE '' END, name) AS k,
           MIN(recipe_id::text)            AS rid,
           MIN(name)                       AS nm,
           NULLIF(MIN(selection_key), '')  AS sel,
           MIN(option_summary)             AS summ,
           SUM(GREATEST(COALESCE(sent_qty, 0),
                        CASE WHEN COALESCE(sent_to_kot, false) THEN qty ELSE 0 END)) AS sent_qty
      FROM pos_order_items
     WHERE order_id = p_order_id
       AND COALESCE(comped, false) = false
     GROUP BY COALESCE(recipe_id::text || CASE WHEN selection_key <> '' THEN '#' || selection_key ELSE '' END, name)
  ), after_all AS (
    SELECT COALESCE(r->>'line_key', r->'src'->>'name')     AS k,
           SUM(COALESCE((r->'src'->>'qty')::integer, 1))  AS qty
      FROM jsonb_array_elements(v_rows) AS r
     GROUP BY COALESCE(r->>'line_key', r->'src'->>'name')
  )
  INSERT INTO pos_kot_removals (client_id, order_id, recipe_id, item_name, qty_removed, reason, removed_by, selection_key, option_summary)
  SELECT v_client_id, p_order_id, b.rid::uuid, b.nm,
         (b.sent_qty - COALESCE(a.qty, 0))::integer,
         NULLIF(BTRIM(COALESCE(p_removal_reason, '')), ''),
         (SELECT auth.uid()),
         b.sel, b.summ
    FROM before_sent b
    LEFT JOIN after_all a ON a.k = b.k
   WHERE b.sent_qty - COALESCE(a.qty, 0) > 0;
  PERFORM set_config('crest.pos_kot_removals_rpc', 'off', true);  -- S809 1d

  -- Prices and snapshots already on the order, keyed by LINE, captured before the replacement
  -- deletes them. A non-comped line wins over a comped split of the same line.
  SELECT COALESCE(jsonb_object_agg(s.lk, jsonb_build_object(
           'unit_price', s.unit_price, 'vat_rate', s.vat_rate, 'name', s.name, 'category', s.category,
           'base_unit_price', s.base_unit_price, 'options_delta', s.options_delta, 'option_summary', s.option_summary,
           'options', s.options)), '{}'::jsonb)
    INTO v_prev
    FROM (
      SELECT DISTINCT ON (i.recipe_id, i.selection_key)
             i.recipe_id::text || CASE WHEN i.selection_key <> '' THEN '#' || i.selection_key ELSE '' END AS lk,
             i.unit_price, i.vat_rate, i.name, i.category, i.base_unit_price, i.options_delta, i.option_summary,
             COALESCE((SELECT jsonb_agg(jsonb_build_object(
                         'group_id', x.group_id, 'option_id', x.option_id, 'group_name', x.group_name,
                         'group_kind', x.group_kind, 'option_name', x.option_name, 'kitchen_name', x.kitchen_name,
                         'is_removal', x.is_removal, 'price_delta', x.price_delta, 'list_price_delta', x.list_price_delta,
                         'included', x.included, 'ingredient_deltas', x.ingredient_deltas, 'sort', x.sort) ORDER BY x.sort, x.id)
                         FROM pos_order_item_options x WHERE x.order_item_id = i.id), '[]'::jsonb) AS options
        FROM pos_order_items i
       WHERE i.order_id = p_order_id AND i.recipe_id IS NOT NULL
       ORDER BY i.recipe_id, i.selection_key, COALESCE(i.comped, false), i.created_at
    ) s;

  -- Fresh options for NEW customized lines, priced now: the group's first `included_count` picks
  -- (by the group's own order) are free. Keyed by the minted line id.
  IF v_any_opts THEN
    SELECT COALESCE(jsonb_object_agg(line_id, jsonb_build_object(
             'delta', delta, 'summary', summary, 'options', options)), '{}'::jsonb)
      INTO v_opt
      FROM (
        SELECT c.line_id,
               SUM(c.charged)                                                            AS delta,
               string_agg(c.option_name || CASE WHEN c.included AND c.list_delta <> 0 THEN ' (incl.)' ELSE '' END,
                          ' · ' ORDER BY c.group_sort, c.gsort, c.osort, c.option_name)   AS summary,
               jsonb_agg(jsonb_build_object(
                 'group_id', c.group_id, 'option_id', c.option_id, 'group_name', c.group_name, 'group_kind', c.kind,
                 'option_name', c.option_name, 'kitchen_name', c.kitchen_name, 'is_removal', c.is_removal,
                 'price_delta', c.charged, 'list_price_delta', c.list_delta, 'included', c.included,
                 'ingredient_deltas', c.ingredients,
                 'sort', (c.group_sort * 1000 + c.osort)) ORDER BY c.group_sort, c.gsort, c.osort, c.option_name) AS options
          FROM (
            SELECT (r->>'id') AS line_id, o.id AS option_id, o.group_id, g.name AS group_name, g.kind,
                   o.name AS option_name, o.kitchen_name, o.is_removal,
                   -- S760: a non-size option in a 'stock_and_price' group costs its price × the size's
                   -- portion factor; the first-N free rule still applies first, so a free pick stays 0.
                   round(o.price_delta * CASE WHEN g.size_scaling = 'stock_and_price' THEN f.factor ELSE 1 END, 2) AS list_delta,
                   COALESCE(a.sort, 0) AS group_sort, g.sort AS gsort, o.sort AS osort,
                   (row_number() OVER (PARTITION BY r->>'id', o.group_id ORDER BY o.sort, o.name, o.id) <= g.included_count) AS included,
                   CASE WHEN row_number() OVER (PARTITION BY r->>'id', o.group_id ORDER BY o.sort, o.name, o.id) <= g.included_count
                        THEN 0
                        ELSE round(o.price_delta * CASE WHEN g.size_scaling = 'stock_and_price' THEN f.factor ELSE 1 END, 2) END AS charged,
                   -- S760: stock lines are frozen SCALED, so every IMS reader stays unchanged. A size
                   -- group is always 'none' (CHECK), so a size's own lines are never scaled.
                   COALESCE((SELECT jsonb_agg(CASE WHEN oi.item_id IS NOT NULL
                                                  THEN jsonb_build_object('item_id', oi.item_id, 'qty',
                                                         round(oi.qty_per_portion * CASE WHEN g.size_scaling IN ('stock', 'stock_and_price') THEN f.factor ELSE 1 END, 4))
                                                  ELSE jsonb_build_object('sub_recipe_id', oi.sub_recipe_id, 'qty',
                                                         round(oi.qty_per_portion * CASE WHEN g.size_scaling IN ('stock', 'stock_and_price') THEN f.factor ELSE 1 END, 4)) END
                                              ORDER BY oi.id)
                               FROM pos_option_ingredients oi WHERE oi.option_id = o.id), '[]'::jsonb) AS ingredients
              FROM jsonb_array_elements(v_rows) r
              CROSS JOIN LATERAL public.pos_selection_portion_factor(
                ARRAY(SELECT e2::uuid FROM jsonb_array_elements_text(r->'option_ids') e2)) AS f(factor)
              CROSS JOIN LATERAL jsonb_array_elements_text(r->'option_ids') e
              JOIN pos_options o ON o.id = e::uuid AND o.client_id = v_client_id
              JOIN pos_option_groups g ON g.id = o.group_id
              LEFT JOIN pos_recipe_option_groups a ON a.recipe_id = (r->>'recipe_id')::uuid AND a.group_id = g.id
             WHERE (r->>'has_options')::boolean
               AND NOT (r->>'line_key') = ANY (v_existing)
          ) c
         GROUP BY c.line_id
      ) q;
  END IF;
  v_opt := COALESCE(v_opt, '{}'::jsonb);

  -- ── S809 1d (ORDER-FLOW-2): a save never lowers what the kitchen already has ──────────────
  -- Each incoming row gets 'kitchen': its share of what the kitchen already has of its line (the
  -- stored rows, with the same definition of sent as the record above), shared out over the rows
  -- of that line in order and never more than a row's own quantity. The replacement row keeps at
  -- least that as sent_qty, whatever the browser sent, so a sent count goes down only with the
  -- quantity, and the record above has already written that up. Until S809 a save sending
  -- sent_qty 0 zeroed the stored count, and the removal that followed found nothing to record.
  -- sent_to_kot is left as sent: false with sent_qty = qty is the order screen's own "changed
  -- since it was sent" state (an edited note), which must still show as unsent there.
  WITH stored_sent AS (
    SELECT COALESCE(recipe_id::text || CASE WHEN selection_key <> '' THEN '#' || selection_key ELSE '' END, name) AS k,
           SUM(GREATEST(COALESCE(sent_qty, 0),
                        CASE WHEN COALESCE(sent_to_kot, false) THEN qty ELSE 0 END)) AS sent
      FROM pos_order_items
     WHERE order_id = p_order_id
       AND COALESCE(comped, false) = false
     GROUP BY 1
  ), incoming AS (
    SELECT e.v, (e.v->>'n')::bigint AS n, COALESCE((e.v->'src'->>'qty')::integer, 1) AS q
      FROM jsonb_array_elements(v_rows) AS e(v)
  )
  SELECT COALESCE(jsonb_agg(w.v || jsonb_build_object('kitchen', w.kitchen) ORDER BY w.n), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT i.v, i.n,
             LEAST(i.q, GREATEST(COALESCE(s.sent, 0)
                                 - COALESCE(SUM(i.q) OVER (PARTITION BY i.v->>'line_key' ORDER BY i.n
                                                           ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0),
                                 0)) AS kitchen
        FROM incoming i
        LEFT JOIN stored_sent s ON s.k = i.v->>'line_key'
    ) w;

  -- This transaction's writes to pos_order_items / pos_order_item_options are the RPC's own.
  PERFORM set_config('crest.pos_items_rpc', 'on', true);

  DELETE FROM pos_order_items WHERE order_id = p_order_id;

  IF jsonb_array_length(v_rows) > 0 THEN
    INSERT INTO pos_order_items (
      id, order_id, client_id, recipe_id, name, category, qty, unit_price, vat_rate,
      sent_to_kot, sent_qty, notes, selection_key, base_unit_price, options_delta, option_summary
    )
    SELECT
      (r->>'id')::uuid,
      p_order_id,
      v_client_id,
      rec.id,
      COALESCE(v_prev -> (r->>'line_key') ->> 'name', rec.name),
      COALESCE(v_prev -> (r->>'line_key') ->> 'category', NULLIF(rec.category, ''), 'Other'),
      COALESCE((r->'src'->>'qty')::integer, 1),
      COALESCE((v_prev -> (r->>'line_key') ->> 'unit_price')::numeric,
               COALESCE(rec.selling_price, 0) + COALESCE((v_opt -> (r->>'id') ->> 'delta')::numeric, 0),
               0),
      COALESCE((v_prev -> (r->>'line_key') ->> 'vat_rate')::numeric,
               CASE WHEN v_vat_reg THEN COALESCE(rec.vat_rate, 0.13) ELSE 0 END),
      COALESCE((r->'src'->>'sent_to_kot')::boolean, false),
      -- S809 1d (ORDER-FLOW-2): never below what the kitchen already has of this line (above).
      GREATEST(COALESCE((r->'src'->>'sent_qty')::integer, 0), COALESCE((r->>'kitchen')::integer, 0), 0),
      NULLIF(r->'src'->>'notes', ''),
      r->>'selection_key',
      CASE WHEN r->>'selection_key' <> '' THEN
        COALESCE((v_prev -> (r->>'line_key') ->> 'base_unit_price')::numeric, rec.selling_price) END,
      CASE WHEN r->>'selection_key' <> '' THEN
        COALESCE((v_prev -> (r->>'line_key') ->> 'options_delta')::numeric, (v_opt -> (r->>'id') ->> 'delta')::numeric, 0) END,
      CASE WHEN r->>'selection_key' <> '' THEN
        COALESCE(v_prev -> (r->>'line_key') ->> 'option_summary', v_opt -> (r->>'id') ->> 'summary') END
    FROM jsonb_array_elements(v_rows) AS r
    JOIN recipes rec ON rec.id = (r->>'recipe_id')::uuid AND rec.client_id = v_client_id;

    GET DIAGNOSTICS v_inserted = ROW_COUNT;

    INSERT INTO pos_order_item_options (
      client_id, order_id, order_item_id, recipe_id, group_id, option_id, group_name, group_kind,
      option_name, kitchen_name, is_removal, price_delta, list_price_delta, included, ingredient_deltas, sort
    )
    SELECT v_client_id, p_order_id, (r->>'id')::uuid, (r->>'recipe_id')::uuid,
           NULLIF(s->>'group_id', '')::uuid, NULLIF(s->>'option_id', '')::uuid, s->>'group_name', s->>'group_kind',
           s->>'option_name', s->>'kitchen_name', COALESCE((s->>'is_removal')::boolean, false),
           COALESCE((s->>'price_delta')::numeric, 0), COALESCE((s->>'list_price_delta')::numeric, 0),
           COALESCE((s->>'included')::boolean, false), COALESCE(s->'ingredient_deltas', '[]'::jsonb),
           COALESCE((s->>'sort')::integer, 0)
      FROM jsonb_array_elements(v_rows) AS r
      JOIN pos_order_items li ON li.id = (r->>'id')::uuid
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN (r->>'line_key') = ANY (v_existing) AND v_prev ? (r->>'line_key')
             THEN COALESCE(v_prev -> (r->>'line_key') -> 'options', '[]'::jsonb)
             ELSE COALESCE(v_opt -> (r->>'id') -> 'options', '[]'::jsonb) END) AS s
     WHERE r->>'selection_key' <> '';
  END IF;

  PERFORM set_config('crest.pos_items_rpc', 'off', true);

  -- Every row must have landed: a recipe the JOIN could not see (RLS, another client) would
  -- otherwise vanish from the order silently.
  IF v_inserted <> COALESCE(jsonb_array_length(p_rows), 0) THEN
    RAISE EXCEPTION 'line_not_on_menu: % of % lines could not be matched to this outlet''s menu',
      COALESCE(jsonb_array_length(p_rows), 0) - v_inserted, COALESCE(jsonb_array_length(p_rows), 0)
      USING ERRCODE = 'P0001', HINT = 'line_not_on_menu';
  END IF;

  UPDATE pos_orders SET items_version = items_version + 1
   WHERE id = p_order_id
   RETURNING items_version INTO v_version;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', i.id, 'recipe_id', i.recipe_id, 'name', i.name, 'category', i.category,
           'qty', i.qty, 'unit_price', i.unit_price, 'vat_rate', i.vat_rate,
           'sent_to_kot', i.sent_to_kot, 'sent_qty', i.sent_qty, 'notes', i.notes,
           'selection_key', i.selection_key, 'base_unit_price', i.base_unit_price,
           'options_delta', i.options_delta, 'option_summary', i.option_summary,
           'options', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                         'option_id', x.option_id, 'group_id', x.group_id, 'group_name', x.group_name,
                         'group_kind', x.group_kind, 'option_name', x.option_name, 'kitchen_name', x.kitchen_name,
                         'is_removal', x.is_removal, 'price_delta', x.price_delta, 'included', x.included,
                         'ingredient_deltas', x.ingredient_deltas) ORDER BY x.sort, x.id)
                         FROM pos_order_item_options x WHERE x.order_item_id = i.id), '[]'::jsonb))
           ORDER BY i.created_at, i.id), '[]'::jsonb)
    INTO v_items
    FROM pos_order_items i WHERE i.order_id = p_order_id;

  RETURN jsonb_build_object('inserted', v_inserted, 'items_version', v_version, 'items', v_items);
END;
$function$;


-- ── 4. guard_pos_item_price: a line's sent count does not go down outside the save ────────────
--
-- The LIVE body (md5 dbf54c84f0942160041149fcdac5392a) with one block marked "S809 1d", inside the
-- branch that lets a non-price UPDATE through. A notes edit and a count going UP still pass.
CREATE OR REPLACE FUNCTION public.guard_pos_item_price()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.unit_price      IS NOT DISTINCT FROM OLD.unit_price
     AND NEW.vat_rate        IS NOT DISTINCT FROM OLD.vat_rate
     AND NEW.qty             IS NOT DISTINCT FROM OLD.qty
     AND NEW.recipe_id       IS NOT DISTINCT FROM OLD.recipe_id
     AND NEW.order_id        IS NOT DISTINCT FROM OLD.order_id
     AND NEW.client_id       IS NOT DISTINCT FROM OLD.client_id
     AND NEW.name            IS NOT DISTINCT FROM OLD.name
     AND NEW.category        IS NOT DISTINCT FROM OLD.category
     AND NEW.selection_key   IS NOT DISTINCT FROM OLD.selection_key
     AND NEW.base_unit_price IS NOT DISTINCT FROM OLD.base_unit_price
     AND NEW.options_delta   IS NOT DISTINCT FROM OLD.options_delta
     AND NEW.option_summary  IS NOT DISTINCT FROM OLD.option_summary THEN
    -- S809 1d (ORDER-FLOW-2): the kitchen count on a line may go up here, never down. No screen
    -- has written these columns directly since S754 (the sent flag rides on the save), and a
    -- direct "not sent" PATCH was how a fired dish left the bill with no pulled-item record:
    -- the delete afterwards found nothing sent to record. A count goes down only through
    -- save_pos_order_items, with the quantity, and that writes the record.
    IF GREATEST(COALESCE(NEW.sent_qty, 0), CASE WHEN COALESCE(NEW.sent_to_kot, false) THEN NEW.qty ELSE 0 END)
         < GREATEST(COALESCE(OLD.sent_qty, 0), CASE WHEN COALESCE(OLD.sent_to_kot, false) THEN OLD.qty ELSE 0 END)
       AND current_setting('crest.pos_items_rpc', true) IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION 'pos_item_sent_lowered: a dish already sent to the kitchen or bar cannot be marked as not sent — take it off on the order screen, which records who pulled it and why'
        USING ERRCODE = '42501', HINT = 'pos_item_sent_lowered';
    END IF;
    RETURN NEW;
  END IF;

  IF current_setting('crest.pos_items_rpc', true) = 'on' THEN
    RETURN NEW;
  END IF;

  -- The operator's restore inserts historical lines as they were billed.
  IF TG_OP = 'INSERT' AND COALESCE(public.is_admin(), false) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'pos_order_items: order lines are saved through the order screen, which prices them from the menu — they cannot be written directly'
    USING ERRCODE = '42501', HINT = 'line_not_on_menu';
END;
$function$;


-- ── 5. Prove it ────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_n        int;
  v_type     int;
  v_owner    uuid;
  v_a        uuid;
  v_b        uuid;
  v_staff    uuid;
  v_admin    uuid;
  v_foreign  uuid;
  v_recipe   uuid;
  v_o1       uuid;
  v_o2       uuid;
  v_o3       uuid;
  v_ob       uuid;
  v_ov       uuid;
  v_t1       uuid;
  v_t2       uuid;
  v_t3       uuid;
  v_tv       uuid;
  v_by       uuid;
  v_at       timestamptz;
  v_status   text;
  v_reason   text;
  v_qty      int;
  v_sent     int;
  v_flag     boolean;
  v_hint     text;
  v_line     jsonb;
BEGIN
  -- Catalog: both guards are BEFORE ROW triggers on INSERT, UPDATE and DELETE (tgtype 1+2+4+8+16),
  -- enabled; the ticket log has no DELETE grant left for a client and keeps the ones the till uses.
  SELECT count(*), min(tgtype) INTO v_n, v_type FROM pg_trigger
   WHERE NOT tgisinternal AND tgenabled = 'O' AND tgtype = 31
     AND ((tgrelid = 'public.pos_kot_log'::regclass      AND tgname = 'guard_pos_kot_log')
       OR (tgrelid = 'public.pos_kot_removals'::regclass AND tgname = 'guard_pos_kot_removals'));
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'S809 1d: expected the two kitchen-log guards as BEFORE ROW INSERT/UPDATE/DELETE triggers, found %', v_n;
  END IF;
  IF has_table_privilege('authenticated', 'public.pos_kot_log', 'DELETE')
     OR NOT has_table_privilege('authenticated', 'public.pos_kot_log', 'INSERT')
     OR NOT has_table_privilege('authenticated', 'public.pos_kot_log', 'UPDATE')
     OR NOT has_table_privilege('authenticated', 'public.pos_kot_log', 'SELECT') THEN
    RAISE EXCEPTION 'S809 1d: pos_kot_log grants for authenticated are not SELECT/INSERT/UPDATE without DELETE';
  END IF;

  -- The callers: a POS outlet's Owner at the outlet it works in, which has a POS PIN login and a dish
  -- on its till menu (BLOOM CAFE today); that PIN login, demoted to Staff inside the block (S792's
  -- stand-in method); the operator; another outlet; and a profile that is not a POS login here.
  SELECT p.id, COALESCE(p.active_client_id, p.client_id) INTO v_owner, v_a
    FROM public.profiles p
    JOIN public.clients c ON c.id = COALESCE(p.active_client_id, p.client_id)
   WHERE p.role = 'client' AND c.pos_enabled
     AND p.pos_email IS NULL AND p.pos_role IS NULL AND p.ims_role IS NULL AND p.hr_role IS NULL
     AND NOT COALESCE(p.hr_self_service, false)
     AND EXISTS (SELECT 1 FROM public.profiles s
                  WHERE s.client_id = c.id AND s.pos_email IS NOT NULL AND s.role = 'client'
                    AND s.ims_role IS NULL AND s.hr_role IS NULL AND NOT COALESCE(s.hr_self_service, false)
                    AND s.settlement_blocked_by IS NULL
                    AND COALESCE(s.active_client_id, s.client_id) = c.id)
     AND EXISTS (SELECT 1 FROM public.recipes r
                  WHERE r.client_id = c.id AND r.is_active IS NOT FALSE AND r.pos_enabled IS NOT FALSE
                    AND r.category IS DISTINCT FROM 'Sub-Recipe')
   ORDER BY p.id
   LIMIT 1;
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'S809 1d probe: no POS Owner login with a PIN login and a till menu to test with';
  END IF;
  SELECT s.id INTO v_staff FROM public.profiles s
   WHERE s.client_id = v_a AND s.pos_email IS NOT NULL AND s.role = 'client'
     AND s.ims_role IS NULL AND s.hr_role IS NULL AND NOT COALESCE(s.hr_self_service, false)
     AND s.settlement_blocked_by IS NULL AND COALESCE(s.active_client_id, s.client_id) = v_a
   ORDER BY s.id
   LIMIT 1;
  SELECT id INTO v_admin FROM public.profiles WHERE role = 'admin' ORDER BY id LIMIT 1;
  SELECT id INTO v_b FROM public.clients WHERE id <> v_a ORDER BY id LIMIT 1;
  SELECT id INTO v_recipe FROM public.recipes
   WHERE client_id = v_a AND is_active IS NOT FALSE AND pos_enabled IS NOT FALSE
     AND category IS DISTINCT FROM 'Sub-Recipe'
   ORDER BY id
   LIMIT 1;
  SELECT p.id INTO v_foreign FROM public.profiles p
   WHERE p.role = 'client' AND p.id <> v_owner AND p.id <> v_staff
     AND NOT COALESCE((p.pos_role IS NOT NULL OR p.pos_email IS NOT NULL)
                      AND v_a IN (p.client_id, p.active_client_id), false)
   ORDER BY p.id
   LIMIT 1;
  IF v_staff IS NULL OR v_admin IS NULL OR v_b IS NULL OR v_recipe IS NULL OR v_foreign IS NULL THEN
    RAISE EXCEPTION 'S809 1d probe: needs a PIN login, an operator, a second client, a menu dish and a non-POS profile (got %, %, %, %, %)',
      v_staff, v_admin, v_b, v_recipe, v_foreign;
  END IF;

  BEGIN
    -- Setup, as the migration's own role (no JWT, so every guard passes it): another outlet's open
    -- order, a voided order here whose ticket the kitchen has ready, and the Staff stand-in.
    INSERT INTO public.pos_orders (client_id, table_name) VALUES (v_b, 'S809 1d probe B') RETURNING id INTO v_ob;
    INSERT INTO public.pos_orders (client_id, table_name, status, close_type)
      VALUES (v_a, 'S809 1d probe V', 'voided', 'void') RETURNING id INTO v_ov;
    INSERT INTO public.pos_kot_log (client_id, order_id, station, items, status)
      VALUES (v_a, v_ov, 'KOT', '[{"name":"S809 probe","qty":1}]', 'ready') RETURNING id INTO v_tv;
    UPDATE public.profiles SET pos_role = 'staff' WHERE id = v_staff;

    -- Now as the Owner, through RLS and every trigger.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    IF NOT COALESCE(public.is_client_owner(), false) THEN
      RAISE EXCEPTION 'S809 1d probe: % is not an Owner login', v_owner;
    END IF;

    -- ORDER-FLOW-2 ────────────────────────────────────────────────────────────────────────────
    INSERT INTO public.pos_orders (client_id, table_name) VALUES (v_a, 'S809 1d probe 1') RETURNING id INTO v_o1;
    v_line := jsonb_build_object('recipe_id', v_recipe, 'name', 'S809 probe', 'qty', 3, 'sent_to_kot', true, 'sent_qty', 3);
    PERFORM public.save_pos_order_items(v_o1, jsonb_build_array(v_line), NULL, NULL);

    -- (a) Through the save: the same three, sent back as "not sent". The kitchen count stays 3, the
    -- flag stays as sent (false), and nothing is recorded because nothing left the bill.
    PERFORM public.save_pos_order_items(v_o1,
      jsonb_build_array(v_line || '{"sent_to_kot": false, "sent_qty": 0}'::jsonb), NULL, NULL);
    SELECT i.qty, i.sent_qty, i.sent_to_kot INTO v_qty, v_sent, v_flag
      FROM public.pos_order_items i WHERE i.order_id = v_o1;
    IF v_qty IS DISTINCT FROM 3 OR v_sent IS DISTINCT FROM 3 OR v_flag IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'S809 1d probe: a "not sent" save left qty %, sent_qty %, sent_to_kot %', v_qty, v_sent, v_flag;
    END IF;
    SELECT count(*) INTO v_n FROM public.pos_kot_removals WHERE order_id = v_o1;
    IF v_n <> 0 THEN
      RAISE EXCEPTION 'S809 1d probe: a save that kept every dish recorded % pull(s)', v_n;
    END IF;

    -- (b) Through a PATCH.
    BEGIN
      UPDATE public.pos_order_items SET sent_qty = 0, sent_to_kot = false WHERE order_id = v_o1;
      RAISE EXCEPTION 'S809 1d probe: a direct PATCH lowered a line''s sent count';
    EXCEPTION WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'pos_item_sent_lowered' THEN
        RAISE EXCEPTION 'S809 1d probe: the sent-count PATCH was refused with hint %', v_hint;
      END IF;
    END;

    -- Control: a note on the same line still saves directly.
    UPDATE public.pos_order_items SET notes = 'S809 probe note' WHERE order_id = v_o1;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'S809 1d probe: a notes edit changed % line(s)', v_n;
    END IF;

    -- (c) A real pull, 3 → 1, is recorded under the login with its reason, and the count follows.
    PERFORM public.save_pos_order_items(v_o1,
      jsonb_build_array(v_line || '{"qty": 1, "sent_to_kot": false, "sent_qty": 1}'::jsonb), 'S809 probe reason', NULL);
    SELECT count(*), min(qty_removed), min(removed_by::text)::uuid, min(reason)
      INTO v_n, v_qty, v_by, v_reason
      FROM public.pos_kot_removals WHERE order_id = v_o1;
    IF v_n <> 1 OR v_qty IS DISTINCT FROM 2 OR v_by IS DISTINCT FROM v_owner OR v_reason IS DISTINCT FROM 'S809 probe reason' THEN
      RAISE EXCEPTION 'S809 1d probe: the 3 → 1 pull recorded % row(s), qty %, by %, reason %', v_n, v_qty, v_by, v_reason;
    END IF;
    SELECT i.qty, i.sent_qty INTO v_qty, v_sent FROM public.pos_order_items i WHERE i.order_id = v_o1;
    IF v_qty IS DISTINCT FROM 1 OR v_sent IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION 'S809 1d probe: after the pull the line is qty %, sent_qty %', v_qty, v_sent;
    END IF;
    IF current_setting('crest.pos_kot_removals_rpc', true) IS DISTINCT FROM 'off' THEN
      RAISE EXCEPTION 'S809 1d probe: the removal flag is still % after the save returned', current_setting('crest.pos_kot_removals_rpc', true);
    END IF;

    -- DATABASE-1, pulled items ─────────────────────────────────────────────────────────────────
    -- (d) No pulled-item record by hand, in anyone's name, at any time — even in the same
    -- transaction as a save.
    BEGIN
      INSERT INTO public.pos_kot_removals (client_id, order_id, item_name, qty_removed, reason, removed_by, removed_at)
        VALUES (v_a, v_o1, 'S809 forged', 4, 'guest complaint', v_staff, now() - interval '1 day');
      RAISE EXCEPTION 'S809 1d probe: a hand-written pulled-item record was accepted';
    EXCEPTION WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'pos_kot_removal_direct' THEN
        RAISE EXCEPTION 'S809 1d probe: the forged pulled item was refused with hint %', v_hint;
      END IF;
    END;

    -- (e) A REST delete of the sent line still records, through the DEFINER line-delete trigger.
    DELETE FROM public.pos_order_items WHERE order_id = v_o1;
    SELECT count(*) INTO v_n FROM public.pos_kot_removals
     WHERE order_id = v_o1 AND reason = 'Table cleared' AND qty_removed = 1 AND removed_by = v_owner;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'S809 1d probe: deleting a sent line wrote % "Table cleared" record(s)', v_n;
    END IF;

    -- DATABASE-1, tickets ──────────────────────────────────────────────────────────────────────
    -- (f) The time, the stage and a made-up sender are the server's.
    INSERT INTO public.pos_kot_log (client_id, order_id, station, items, sent_by, sent_at, status, served_at)
      VALUES (v_a, v_o1, 'KOT', '[{"name":"S809 probe","qty":2}]', v_foreign, '2020-01-01 12:00+05:45', 'served', '2020-01-01 12:00+05:45')
      RETURNING id, sent_by, sent_at, status INTO v_t1, v_by, v_at, v_status;
    IF v_by IS DISTINCT FROM v_owner OR v_at IS DISTINCT FROM now() OR v_status IS DISTINCT FROM 'new' THEN
      RAISE EXCEPTION 'S809 1d probe: a sent ticket kept sender %, time %, stage %', v_by, v_at, v_status;
    END IF;

    -- (g) Q1 (b): a POS login of this outlet named by the till is kept (the offline upload shape:
    -- the Owner's session uploading a waiter's queued ticket).
    INSERT INTO public.pos_kot_log (client_id, order_id, station, items, sent_by)
      VALUES (v_a, v_o1, 'BOT', '[{"name":"S809 probe","qty":1}]', v_staff)
      RETURNING id, sent_by INTO v_t2, v_by;
    IF v_by IS DISTINCT FROM v_staff THEN
      RAISE EXCEPTION 'S809 1d probe: the queued waiter % became %', v_staff, v_by;
    END IF;

    -- (h) Not for another outlet's order.
    BEGIN
      INSERT INTO public.pos_kot_log (client_id, order_id, station, items)
        VALUES (v_a, v_ob, 'KOT', '[{"name":"S809 probe","qty":1}]');
      RAISE EXCEPTION 'S809 1d probe: a ticket for another outlet''s order was accepted';
    EXCEPTION WHEN foreign_key_violation THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'pos_kot_other_outlet' THEN
        RAISE EXCEPTION 'S809 1d probe: the other-outlet ticket was refused with hint %', v_hint;
      END IF;
    END;

    -- (i) What a ticket says, and who sent it, cannot change.
    BEGIN
      UPDATE public.pos_kot_log SET items = '[{"name":"S809 probe","qty":0}]' WHERE id = v_t1;
      RAISE EXCEPTION 'S809 1d probe: a ticket''s items were rewritten';
    EXCEPTION WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'pos_kot_ticket_locked' THEN
        RAISE EXCEPTION 'S809 1d probe: the items rewrite was refused with hint %', v_hint;
      END IF;
    END;
    BEGIN
      UPDATE public.pos_kot_log SET sent_by = v_staff WHERE id = v_t1;
      RAISE EXCEPTION 'S809 1d probe: a ticket was re-attributed';
    EXCEPTION WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'pos_kot_ticket_locked' THEN
        RAISE EXCEPTION 'S809 1d probe: the re-attribution was refused with hint %', v_hint;
      END IF;
    END;

    -- (j) The stage moves forward, stamped with the login that moved it, and never back.
    UPDATE public.pos_kot_log
       SET status = 'in_progress', started_at = now(), estimated_prep_minutes = 10, status_updated_by = v_foreign
     WHERE id = v_t1
     RETURNING status_updated_by INTO v_by;
    IF v_by IS DISTINCT FROM v_owner THEN
      RAISE EXCEPTION 'S809 1d probe: Start was stamped as % rather than the login %', v_by, v_owner;
    END IF;
    BEGIN
      UPDATE public.pos_kot_log SET status = 'new' WHERE id = v_t1;
      RAISE EXCEPTION 'S809 1d probe: a started ticket was moved back to new';
    EXCEPTION WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'pos_kot_status_backwards' THEN
        RAISE EXCEPTION 'S809 1d probe: the backwards move was refused with hint %', v_hint;
      END IF;
    END;

    -- (k) No delete: not directly (no grant), and not by deleting the ticket's order, here an empty
    -- order of the waiter's own — the fake-ticket route.
    BEGIN
      DELETE FROM public.pos_kot_log WHERE id = v_t1;
      RAISE EXCEPTION 'S809 1d probe: a ticket was deleted directly';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    INSERT INTO public.pos_orders (client_id, table_name) VALUES (v_a, 'S809 1d probe 2') RETURNING id INTO v_o2;
    INSERT INTO public.pos_kot_log (client_id, order_id, station, items)
      VALUES (v_a, v_o2, 'KOT', '[{"name":"S809 probe","qty":4}]') RETURNING id INTO v_t3;
    BEGIN
      DELETE FROM public.pos_orders WHERE id = v_o2;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      RAISE EXCEPTION 'S809 1d probe: deleting an open order (% row) took its kitchen ticket with it', v_n;
    EXCEPTION WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'pos_kot_ticket_locked' THEN
        RAISE EXCEPTION 'S809 1d probe: the order delete was refused with hint %', v_hint;
      END IF;
    END;
    SELECT count(*) INTO v_n FROM public.pos_kot_log WHERE id = v_t3;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'S809 1d probe: the ticket on the refused order delete is gone';
    END IF;

    -- (l) A Staff login moves a ticket on, but cannot cancel one whose order is still open ...
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
    IF COALESCE(public.pos_caller_has_rank('supervisor'), false) THEN
      RAISE EXCEPTION 'S809 1d probe: the Staff stand-in % still ranks as supervisor', v_staff;
    END IF;
    UPDATE public.pos_kot_log SET status = 'ready', ready_at = now() WHERE id = v_t1
     RETURNING status_updated_by INTO v_by;
    IF v_by IS DISTINCT FROM v_staff THEN
      RAISE EXCEPTION 'S809 1d probe: Ready was stamped as % rather than the Staff login', v_by;
    END IF;
    BEGIN
      UPDATE public.pos_kot_log SET status = 'cancelled' WHERE id = v_t1;
      RAISE EXCEPTION 'S809 1d probe: a Staff login cancelled a ticket on an open order';
    EXCEPTION WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'pos_kot_cancel_rank' THEN
        RAISE EXCEPTION 'S809 1d probe: the Staff cancel was refused with hint %', v_hint;
      END IF;
    END;

    -- (m) ... and the till's void path still cancels a voided order's tickets, which then stay
    -- cancelled. (The void itself needs a supervisor; the cancel is allowed by the order's state.)
    UPDATE public.pos_kot_log SET status = 'cancelled' WHERE order_id = v_ov;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'S809 1d probe: cancelling a voided order''s tickets changed % row(s)', v_n;
    END IF;
    BEGIN
      UPDATE public.pos_kot_log SET status = 'ready' WHERE id = v_tv;
      RAISE EXCEPTION 'S809 1d probe: a cancelled ticket came back';
    EXCEPTION WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'pos_kot_status_backwards' THEN
        RAISE EXCEPTION 'S809 1d probe: un-cancelling was refused with hint %', v_hint;
      END IF;
    END;

    -- (n) The operator's restore keeps a ticket and a pulled item exactly as backed up.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    IF NOT COALESCE(public.is_admin(), false) THEN
      RAISE EXCEPTION 'S809 1d probe: % is not the operator', v_admin;
    END IF;
    INSERT INTO public.pos_kot_log (client_id, order_id, station, items, sent_by, sent_at, status)
      VALUES (v_a, v_o1, 'KOT', '[{"name":"S809 restored","qty":1}]', v_foreign, '2026-01-01 12:00+05:45', 'served')
      RETURNING sent_by, sent_at, status INTO v_by, v_at, v_status;
    IF v_by IS DISTINCT FROM v_foreign OR v_at IS DISTINCT FROM '2026-01-01 12:00+05:45'::timestamptz
       OR v_status IS DISTINCT FROM 'served' THEN
      RAISE EXCEPTION 'S809 1d probe: the restore''s ticket became sender %, time %, stage %', v_by, v_at, v_status;
    END IF;
    INSERT INTO public.pos_kot_removals (client_id, order_id, item_name, qty_removed, reason, removed_by, removed_at)
      VALUES (v_a, v_o1, 'S809 restored', 1, 'restored', v_foreign, '2026-01-01 12:00+05:45');

    -- (o) Clear Occupied: the operator deletes an open order's lines, then the order. Its ticket goes
    -- with it through the new trigger, and the fired food is recorded as "Table cleared" — a record
    -- that keeps its order number when the foreign key sets order_id NULL.
    INSERT INTO public.pos_orders (client_id, table_name) VALUES (v_a, 'S809 1d probe 3') RETURNING id INTO v_o3;
    PERFORM public.save_pos_order_items(v_o3,
      jsonb_build_array(v_line || '{"qty": 2, "sent_qty": 2}'::jsonb), NULL, NULL);
    INSERT INTO public.pos_kot_log (client_id, order_id, station, items)
      VALUES (v_a, v_o3, 'KOT', '[{"name":"S809 probe","qty":2}]');
    DELETE FROM public.pos_order_items WHERE order_id = v_o3;
    DELETE FROM public.pos_orders WHERE id = v_o3;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'S809 1d probe: Clear Occupied deleted % order(s)', v_n;
    END IF;
    SELECT count(*) INTO v_n FROM public.pos_kot_log WHERE order_id = v_o3;
    IF v_n <> 0 THEN
      RAISE EXCEPTION 'S809 1d probe: Clear Occupied left % ticket(s)', v_n;
    END IF;
    SELECT count(*) INTO v_n FROM public.pos_kot_removals
     WHERE order_id IS NULL AND table_name = 'S809 1d probe 3' AND reason = 'Table cleared' AND qty_removed = 2;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'S809 1d probe: Clear Occupied left % "Table cleared" record(s) for the fired food', v_n;
    END IF;

    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 's809_1d_probe_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 's809_1d_probe_rollback' THEN RAISE; END IF;
  END;
END;
$$;

NOTIFY pgrst, 'reload schema';

-- Read back after applying (one statement per call):
--   SELECT c.relname, t.tgname, t.tgenabled, t.tgtype FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
--    WHERE c.relname IN ('pos_kot_log', 'pos_kot_removals') AND NOT t.tgisinternal ORDER BY 1, 2;
--   SELECT relname, relacl FROM pg_class WHERE relname IN ('pos_kot_log', 'pos_kot_removals');
--   SELECT proname, prosecdef, md5(prosrc), proacl FROM pg_proc
--    WHERE proname IN ('guard_pos_kot_log', 'guard_pos_kot_removals', 'save_pos_order_items', 'guard_pos_item_price') ORDER BY 1;
--     guard_pos_item_price  283c9d6288fb0a31c549ca9c1fce7ae7 (as drafted)
--     save_pos_order_items  6237a343f566d8fa04b822ca653f742a as drafted on the pre-1b body; after the
--                           1b merge, whatever the merged file's body hashes to
--   SELECT has_function_privilege('authenticated', 'public.guard_pos_kot_log()', 'EXECUTE');   -- false
--   SELECT has_table_privilege('authenticated', 'public.pos_kot_log', 'DELETE');                -- false
