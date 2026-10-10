-- ════════════════════════════════════════════════════════════════════════════════════════════
-- S809 stage 3, slice 3d: the kitchen can clear a ticket whose dishes were all taken off, without
-- pretending to cook it, and a ticket's kitchen times are the server's clock, not the tablet's.
--
--   FLOOR-KITCHEN-2 (P2). A waiter fires KOT #57 "2 × Chicken Momo", then takes both off the order
--   ("Wrong item fired"). The ticket stayed in New: the Kitchen Display kept ringing for it, turned it
--   amber and red as late, and the only way to make it stop was to press Start and then Ready on food
--   nobody cooked. That told the floor "Table 4: Ready" (a green strip, "food in the pass, run it") and
--   added an uncooked ticket to KOT Log's prep times. Slice 1d (20261009120000) made cancelling a
--   ticket Supervisor-only, so a Kitchen login had no honest way out at all.
--
--     guard_pos_kot_log: a cancel is still allowed to a POS supervisor or above and on a voided
--     order, as before. NEW: any POS login of the outlet (pos_caller_has_rank('staff'): a kitchen or
--     bar login included, a blocked one not) may cancel ("Clear") a ticket in New, In Progress or
--     Ready once the order no longer holds what it carries. The test is the ORDER's state, not the
--     tablet's say-so: for each dish on the ticket (its line key, save_pos_order_items' own
--     recipe#selection or name), what the order still counts as sent to the kitchen (the same
--     definition of sent, comped rows included) must be no more than what the order's OTHER
--     uncancelled tickets carry. So a dish pulled from one of two tickets clears one ticket, never
--     both, and a ticket whose food was never logged (a failed ticket insert) is not clearable below
--     Supervisor. A ticket with no dish on it (a CHANGE ticket, S809 3a) is never "all taken off": its
--     path stays Seen (new → served). A refused clear says why (pos_kot_clear_food_left).
--
--   S809.4 (from 1d). started_at, ready_at and served_at came from the tablet's clock, so a ticket's
--   prep time could be shaded (or simply wrong on a tablet whose clock drifts), and the guest's "about
--   N minutes" (get_guest_order_progress / get_guest_table_status: started_at + estimate − now()) mixed
--   the tablet's clock with the server's.
--
--     guard_pos_kot_log, on every client UPDATE: each stage time is stamped now() when the ticket
--     moves INTO that stage and is otherwise kept as stored, whatever the request sends. The estimate
--     is taken only on the move into In Progress (the Start dialog) and is fixed after that, so a
--     "Done in 12 min (est. 15)" cannot be tidied up afterwards. A cancel stamps no stage time.
--     Nothing is refused for sending times: an older Kitchen Display or till still sends its own and
--     they are ignored.
--
--   FLOOR-KITCHEN-5 and FLOOR-KITCHEN-6 are app-only (KitchenDisplay.jsx, EstimateTimeModal.jsx and
--   PosOrders.jsx's markOrderServed): a Ready ticket the board stops showing after 10 minutes is now
--   marked served by the board (a ready → served move this guard already admits, now server-timed),
--   and the board's poll and taps are ordered and time-limited.
--
-- Built on the LIVE body (pg_get_functiondef, md5(prosrc), read 2026-10-10 with stage-3 wave 1 live):
--   guard_pos_kot_log()   da727376d6856b2686281194076d207a  (slice 1d's, 20261009120000)
-- Every change inside it is a block marked "S809 3d". Same signature, SECURITY DEFINER, search_path
-- public, proacl {postgres=X/postgres} (a trigger function needs no grant); CREATE OR REPLACE keeps it.
-- The trigger itself (BEFORE INSERT OR DELETE OR UPDATE, FOR EACH ROW) is not touched.
-- Called, not replaced: pos_caller_has_rank(text) 100bd1bd1e2a1a1c3a6f4cb105a8e887 (slice 3i's: admin,
-- the Owner, or a POS login at the rank that neither a Final Settlement nor POS Staff has blocked),
-- is_admin(), auth.uid(), auth.jwt().
-- Not touched (owned by other stage-3 slices drafted at the same time): get_guest_order_progress and
-- get_guest_table_status (3b; both read started_at, which this file makes the server's), anything on
-- pos_guest_order_requests, sales_entries or stock_movements.
--
-- Live before this migration (2026-10-10, after the Bloom demo seed): pos_kot_log holds 7,515 tickets
-- (BLOOM CAFE 4,661, BLOOM CAFE - PKR 2,854): 7,503 served, 12 cancelled, 0 new / in progress / ready,
-- 0 CHANGE tickets, 0 with `items` that is not a JSON array. 0 tickets with a stage time out of order
-- (started before sent, ready before started, served before ready), 0 served without a time, 0 with an
-- estimate outside 1–999. No constraint is added and no row is rewritten: the guard judges new writes
-- only, and the stored times stay as they were.
--
-- Ship order: either way round is safe; this migration first is the clean one. A till or Kitchen
-- Display on crest-v425 or older is refused nothing it does in normal service:
--   * Start / Ready / Served / Seen on the Kitchen Display and ✓ Served on the order screen send their
--     own times; they land, and the stored times are the server's.
--   * The void's "cancel this order's tickets" still passes (a voided order).
--   * An older Kitchen Display has no Clear button; its workaround (Start, Ready, Served on an empty
--     ticket) still works, now server-timed.
-- The new Kitchen Display on the OLD guard: a Kitchen or Staff login's Clear is refused with
-- pos_kot_cancel_rank, the card goes back where it was and says only a supervisor can cancel.
--
-- The probe at the end runs as BLOOM CAFE's Owner and one of its POS PIN logins (made a Staff rank,
-- then blocked, inside the block) and the operator, in a block that rolls itself back. It writes its
-- own orders, lines and tickets. If any check fails, nothing lands.
-- ════════════════════════════════════════════════════════════════════════════════════════════


-- ── 0. Pre-flight: the body this file replaces is the one it was built on ───────────────────────
-- The second hash is the body this migration writes, so a re-run passes.
DO $$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.guard_pos_kot_log()'::regprocedure;
  IF v_md5 IS DISTINCT FROM 'da727376d6856b2686281194076d207a' AND v_md5 IS DISTINCT FROM '5a29bcf4f39e563d85f5716c57acf482' THEN
    RAISE EXCEPTION 'S809 3d: guard_pos_kot_log changed since this slice was drafted (live md5 %) — merge the "S809 3d" blocks of section 1 onto the live body and update the md5 in section 0', v_md5;
  END IF;
  IF to_regprocedure('public.pos_caller_has_rank(text)') IS NULL THEN
    RAISE EXCEPTION 'S809 3d: pos_caller_has_rank(text) is missing; this guard calls it';
  END IF;
END;
$$;


-- ── 1. guard_pos_kot_log: Clear a ticket the order no longer holds; stage times are the server's ─
CREATE OR REPLACE FUNCTION public.guard_pos_kot_log()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid          uuid := (SELECT auth.uid());
  v_order_client uuid;
  v_from         integer;
  v_to           integer;
  -- The kitchen-stage columns: the only ones a client session may change on a ticket.
  v_stage        CONSTANT text[] := ARRAY['status', 'started_at', 'ready_at', 'served_at',
                                          'estimated_prep_minutes', 'status_updated_by'];
  -- S809 3d: the dishes on the ticket being cleared, and whether the order still holds any of them.
  v_dishes       integer;
  v_food_left    boolean;
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
      -- The till cancels a voided order's tickets right after the void; a supervisor may cancel any.
      IF NOT COALESCE(public.pos_caller_has_rank('supervisor')
                      OR EXISTS (SELECT 1 FROM pos_orders o
                                  WHERE o.id = NEW.order_id AND o.status = 'voided'), false) THEN
        -- ── S809 3d (FLOOR-KITCHEN-2): the kitchen clears a ticket the order no longer holds ──
        -- Any POS login of the outlet, at a stage the kitchen still owns. A served ticket is history.
        IF NOT COALESCE(public.pos_caller_has_rank('staff'), false)
           OR OLD.status NOT IN ('new', 'in_progress', 'ready') THEN
          RAISE EXCEPTION 'pos_kot_cancel_rank: a kitchen ticket is cancelled when its order is voided, by a POS supervisor or above, or by any POS login once every dish on it has been taken off the order'
            USING ERRCODE = '42501', HINT = 'pos_kot_cancel_rank';
        END IF;
        -- Per dish on this ticket (save_pos_order_items' line key: recipe#selection, else the name):
        -- what the order still counts as sent (its definition of sent, comped rows included) against
        -- what the order's OTHER uncancelled tickets carry. More sent than they carry means some of
        -- it is still this ticket's to make. A CHANGE line (qty 0) is no dish; a line whose qty is not
        -- a number is not one either. CASE, not AND, so a malformed qty can never reach the cast.
        WITH mine AS (
          SELECT DISTINCT COALESCE((l->>'recipe_id')
                                     || CASE WHEN COALESCE(l->>'selection_key', '') <> '' THEN '#' || (l->>'selection_key') ELSE '' END,
                                   l->>'name') AS k
            FROM jsonb_array_elements(CASE WHEN jsonb_typeof(OLD.items) = 'array' THEN OLD.items ELSE '[]'::jsonb END) AS l
           WHERE NOT (l @> '{"change": true}'::jsonb)
             AND CASE WHEN jsonb_typeof(l->'qty') = 'number' THEN (l->>'qty')::numeric ELSE 0 END > 0
        )
        SELECT count(*),
               COALESCE(bool_or(
                 (SELECT COALESCE(SUM(GREATEST(COALESCE(i.sent_qty, 0),
                                               CASE WHEN COALESCE(i.sent_to_kot, false) THEN i.qty ELSE 0 END)), 0)
                    FROM pos_order_items i
                   WHERE i.order_id = OLD.order_id
                     AND COALESCE(i.recipe_id::text || CASE WHEN i.selection_key <> '' THEN '#' || i.selection_key ELSE '' END,
                                  i.name) = m.k)
                 >
                 (SELECT COALESCE(SUM(CASE WHEN jsonb_typeof(l2->'qty') = 'number' THEN (l2->>'qty')::numeric ELSE 0 END), 0)
                    FROM pos_kot_log k2
                   CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(k2.items) = 'array' THEN k2.items ELSE '[]'::jsonb END) AS l2
                   WHERE k2.order_id = OLD.order_id
                     AND k2.id <> OLD.id
                     AND k2.status <> 'cancelled'
                     AND NOT (l2 @> '{"change": true}'::jsonb)
                     AND COALESCE((l2->>'recipe_id')
                                    || CASE WHEN COALESCE(l2->>'selection_key', '') <> '' THEN '#' || (l2->>'selection_key') ELSE '' END,
                                  l2->>'name') = m.k)
               ), false)
          INTO v_dishes, v_food_left
          FROM mine m;
        IF COALESCE(v_dishes, 0) = 0 THEN
          RAISE EXCEPTION 'pos_kot_cancel_rank: a kitchen ticket is cancelled when its order is voided, by a POS supervisor or above, or by any POS login once every dish on it has been taken off the order — this ticket carries no dish (a changed instruction is cleared with Seen)'
            USING ERRCODE = '42501', HINT = 'pos_kot_cancel_rank';
        END IF;
        IF v_food_left THEN
          RAISE EXCEPTION 'pos_kot_clear_food_left: the kitchen clears a ticket only once every dish on it has been taken off the order, and this order still holds some of what it carries — make it, or have a POS supervisor clear the ticket'
            USING ERRCODE = '42501', HINT = 'pos_kot_clear_food_left';
        END IF;
        -- ── end S809 3d ──
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

  -- ── S809 3d (S809.4): a stage time is the server's, stamped when the ticket enters that stage ──
  -- Whatever the tablet sends is ignored (an older Kitchen Display or till still sends its own clock,
  -- and is not refused for it). The estimate is the cook's, taken at Start and fixed from then on.
  -- A move straight past a stage (a CHANGE ticket's Seen, new → served) leaves that stage's time
  -- empty rather than inventing one, so it never enters a prep-time figure. A cancel stamps nothing.
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'in_progress' THEN
    NEW.started_at := now();
  ELSE
    NEW.started_at             := OLD.started_at;
    NEW.estimated_prep_minutes := OLD.estimated_prep_minutes;
  END IF;
  NEW.ready_at  := CASE WHEN NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'ready'  THEN now() ELSE OLD.ready_at  END;
  NEW.served_at := CASE WHEN NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'served' THEN now() ELSE OLD.served_at END;
  -- ── end S809 3d ──
  RETURN NEW;
END;
$function$;


-- ── 2. Prove it ────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_n        int;
  v_owner    uuid;
  v_a        uuid;
  v_staff    uuid;
  v_admin    uuid;
  v_ra       text := gen_random_uuid()::text;   -- made-up dish ids: order lines carry no recipe FK
  v_rb       text := gen_random_uuid()::text;
  v_rc       text := gen_random_uuid()::text;
  v_rd       text := gen_random_uuid()::text;
  v_re       text := gen_random_uuid()::text;
  v_o        uuid;
  v_ov       uuid;
  v_t1       uuid;
  v_t2       uuid;
  v_t3       uuid;
  v_t5       uuid;
  v_t6       uuid;
  v_t7       uuid;
  v_t8       uuid;
  v_t9       uuid;
  v_t10      uuid;
  v_t11      uuid;
  v_t12      uuid;
  v_t13      uuid;
  v_tg       uuid;
  v_tv       uuid;
  v_by       uuid;
  v_status   text;
  v_start    timestamptz;
  v_ready    timestamptz;
  v_served   timestamptz;
  v_est      int;
  v_hint     text;
BEGIN
  -- Catalog: the guard is still the BEFORE ROW INSERT/UPDATE/DELETE trigger (tgtype 1+2+4+8+16),
  -- enabled, and the function kept its shape and its (empty) grants.
  SELECT count(*) INTO v_n FROM pg_trigger
   WHERE tgrelid = 'public.pos_kot_log'::regclass AND tgname = 'guard_pos_kot_log'
     AND NOT tgisinternal AND tgenabled = 'O' AND tgtype = 31;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'S809 3d: guard_pos_kot_log is not the enabled BEFORE ROW INSERT/UPDATE/DELETE trigger on pos_kot_log';
  END IF;
  SELECT count(*) INTO v_n FROM pg_proc
   WHERE oid = 'public.guard_pos_kot_log()'::regprocedure
     AND prosecdef AND proconfig = ARRAY['search_path=public']
     AND NOT has_function_privilege('authenticated', oid, 'EXECUTE')
     AND NOT has_function_privilege('anon', oid, 'EXECUTE');
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'S809 3d: guard_pos_kot_log is not SECURITY DEFINER with search_path public and no client grant';
  END IF;

  -- The callers: a POS outlet's Owner at the outlet it works in that has a POS PIN login (BLOOM CAFE
  -- today); that PIN login, made a Staff rank inside the block (S792's stand-in method); the operator.
  SELECT p.id, COALESCE(p.active_client_id, p.client_id) INTO v_owner, v_a
    FROM public.profiles p
    JOIN public.clients c ON c.id = COALESCE(p.active_client_id, p.client_id)
   WHERE p.role = 'client' AND c.pos_enabled
     AND p.pos_email IS NULL AND p.pos_role IS NULL AND p.ims_role IS NULL AND p.hr_role IS NULL
     AND NOT COALESCE(p.hr_self_service, false)
     AND EXISTS (SELECT 1 FROM public.profiles s
                  WHERE s.client_id = c.id AND s.pos_email IS NOT NULL AND s.role = 'client'
                    AND s.ims_role IS NULL AND s.hr_role IS NULL AND NOT COALESCE(s.hr_self_service, false)
                    AND COALESCE(s.active_client_id, s.client_id) = c.id)
   ORDER BY p.id
   LIMIT 1;
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'S809 3d probe: no POS Owner login with a PIN login to test with';
  END IF;
  SELECT s.id INTO v_staff FROM public.profiles s
   WHERE s.client_id = v_a AND s.pos_email IS NOT NULL AND s.role = 'client'
     AND s.ims_role IS NULL AND s.hr_role IS NULL AND NOT COALESCE(s.hr_self_service, false)
     AND COALESCE(s.active_client_id, s.client_id) = v_a
   ORDER BY s.id
   LIMIT 1;
  SELECT id INTO v_admin FROM public.profiles WHERE role = 'admin' ORDER BY id LIMIT 1;
  IF v_staff IS NULL OR v_admin IS NULL THEN
    RAISE EXCEPTION 'S809 3d probe: needs a PIN login and an operator (got %, %)', v_staff, v_admin;
  END IF;

  BEGIN
    -- ── Setup, as the migration's own role (no JWT, so every guard passes it) ──
    -- One open order. What it still holds, as save_pos_order_items would have left it:
    --   B ×1 sent · C ×1 sent · D ×1 sent · E (no choices) ×1 sent · E "garlic" ×1 sent ·
    --   "S809 3d open dish held" ×1 sent.
    -- A was sent and taken off entirely, so the order has no A line at all.
    UPDATE public.profiles SET pos_role = 'staff', pos_blocked_at = NULL, settlement_blocked_by = NULL WHERE id = v_staff;
    INSERT INTO public.pos_orders (client_id, table_name) VALUES (v_a, 'S809 3d probe') RETURNING id INTO v_o;
    INSERT INTO public.pos_order_items (order_id, client_id, recipe_id, name, qty, unit_price, vat_rate, sent_to_kot, sent_qty, selection_key) VALUES
      (v_o, v_a, v_rb::uuid, 'S809 3d B', 1, 100, 0, true, 1, ''),
      (v_o, v_a, v_rc::uuid, 'S809 3d C', 1, 100, 0, true, 1, ''),
      (v_o, v_a, v_rd::uuid, 'S809 3d D', 1, 100, 0, true, 1, ''),
      (v_o, v_a, v_re::uuid, 'S809 3d E', 1, 100, 0, true, 1, ''),
      (v_o, v_a, v_re::uuid, 'S809 3d E', 1, 120, 0, true, 1, 'probe-garlic'),
      (v_o, v_a, NULL,       'S809 3d open dish held', 1, 100, 0, true, 1, '');
    INSERT INTO public.pos_orders (client_id, table_name, status, close_type)
      VALUES (v_a, 'S809 3d probe V', 'voided', 'void') RETURNING id INTO v_ov;

    -- The order's tickets, as the till logged them (inserted here, so stages can be set directly).
    INSERT INTO public.pos_kot_log (client_id, order_id, station, items) VALUES   -- T1: A ×2, all taken off
      (v_a, v_o, 'KOT', jsonb_build_array(jsonb_build_object('recipe_id', v_ra, 'name', 'S809 3d A', 'qty', 2))) RETURNING id INTO v_t1;
    INSERT INTO public.pos_kot_log (client_id, order_id, station, items) VALUES   -- T2: B ×1, still ordered
      (v_a, v_o, 'KOT', jsonb_build_array(jsonb_build_object('recipe_id', v_rb, 'name', 'S809 3d B', 'qty', 1))) RETURNING id INTO v_t2;
    INSERT INTO public.pos_kot_log (client_id, order_id, station, items) VALUES   -- T3: a CHANGE ticket for B (S809 3a)
      (v_a, v_o, 'KOT', jsonb_build_array(jsonb_build_object('recipe_id', v_rb, 'name', 'S809 3d B', 'qty', 0, 'change', true, 'notes', 'no peanuts'))) RETURNING id INTO v_t3;
    INSERT INTO public.pos_kot_log (client_id, order_id, station, items) VALUES   -- T5 and T6: C ×1 each, one of them taken off
      (v_a, v_o, 'KOT', jsonb_build_array(jsonb_build_object('recipe_id', v_rc, 'name', 'S809 3d C', 'qty', 1))) RETURNING id INTO v_t5;
    INSERT INTO public.pos_kot_log (client_id, order_id, station, items) VALUES
      (v_a, v_o, 'KOT', jsonb_build_array(jsonb_build_object('recipe_id', v_rc, 'name', 'S809 3d C', 'qty', 1))) RETURNING id INTO v_t6;
    INSERT INTO public.pos_kot_log (client_id, order_id, station, items, status, started_at, estimated_prep_minutes) VALUES   -- T7: D ×2, one taken off, started
      (v_a, v_o, 'KOT', jsonb_build_array(jsonb_build_object('recipe_id', v_rd, 'name', 'S809 3d D', 'qty', 2)), 'in_progress', now(), 10) RETURNING id INTO v_t7;
    INSERT INTO public.pos_kot_log (client_id, order_id, station, items, status, started_at, ready_at) VALUES   -- T8: E "extra cheese" ×1, taken off; the plain E stays
      (v_a, v_o, 'KOT', jsonb_build_array(jsonb_build_object('recipe_id', v_re, 'name', 'S809 3d E', 'qty', 1, 'selection_key', 'probe-cheese',
        'options', jsonb_build_array(jsonb_build_object('kitchen', 'Extra cheese', 'is_removal', false)))), 'ready', now() - interval '9 minutes', now() - interval '2 minutes') RETURNING id INTO v_t8;
    INSERT INTO public.pos_kot_log (client_id, order_id, station, items) VALUES   -- T13: E "garlic" ×1, still ordered
      (v_a, v_o, 'KOT', jsonb_build_array(jsonb_build_object('recipe_id', v_re, 'name', 'S809 3d E', 'qty', 1, 'selection_key', 'probe-garlic'))) RETURNING id INTO v_t13;
    INSERT INTO public.pos_kot_log (client_id, order_id, station, items) VALUES   -- T9: an open dish (no recipe), taken off
      (v_a, v_o, 'BOT', jsonb_build_array(jsonb_build_object('recipe_id', NULL, 'name', 'S809 3d open dish gone', 'qty', 1))) RETURNING id INTO v_t9;
    INSERT INTO public.pos_kot_log (client_id, order_id, station, items) VALUES   -- T10: an open dish, still ordered
      (v_a, v_o, 'BOT', jsonb_build_array(jsonb_build_object('name', 'S809 3d open dish held', 'qty', 1))) RETURNING id INTO v_t10;
    INSERT INTO public.pos_kot_log (client_id, order_id, station, items, status, served_at) VALUES   -- T11: A ×1, served long ago
      (v_a, v_o, 'KOT', jsonb_build_array(jsonb_build_object('recipe_id', v_ra, 'name', 'S809 3d A', 'qty', 1)), 'served', now() - interval '1 hour') RETURNING id INTO v_t11;
    INSERT INTO public.pos_kot_log (client_id, order_id, station, items) VALUES   -- T12: A ×1, taken off (for the blocked login)
      (v_a, v_o, 'KOT', jsonb_build_array(jsonb_build_object('recipe_id', v_ra, 'name', 'S809 3d A', 'qty', 1))) RETURNING id INTO v_t12;
    INSERT INTO public.pos_kot_log (client_id, order_id, station, items) VALUES   -- Tg: `items` not an array (none live; must not break the sums)
      (v_a, v_o, 'KOT', '{"not": "an array"}'::jsonb) RETURNING id INTO v_tg;
    INSERT INTO public.pos_kot_log (client_id, order_id, station, items) VALUES   -- Tv: a voided order's ticket
      (v_a, v_ov, 'KOT', jsonb_build_array(jsonb_build_object('recipe_id', v_ra, 'name', 'S809 3d A', 'qty', 1))) RETURNING id INTO v_tv;

    -- ── As the Staff login, through RLS and the trigger ──
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    IF COALESCE(public.pos_caller_has_rank('supervisor'), false) OR NOT COALESCE(public.pos_caller_has_rank('staff'), false) THEN
      RAISE EXCEPTION 'S809 3d probe: the stand-in % is not a Staff rank', v_staff;
    END IF;

    -- (a) Start, as an older Kitchen Display sends it: its own clock and a made-up mover. The server
    --     stamps the time and the login; the cook's estimate is kept.
    UPDATE public.pos_kot_log
       SET status = 'in_progress', started_at = '2020-01-01 12:00+05:45', estimated_prep_minutes = 12, status_updated_by = v_owner
     WHERE id = v_t2 AND status = 'new'
     RETURNING started_at, estimated_prep_minutes, status_updated_by INTO v_start, v_est, v_by;
    IF v_start IS DISTINCT FROM now() OR v_est IS DISTINCT FROM 12 OR v_by IS DISTINCT FROM v_staff THEN
      RAISE EXCEPTION 'S809 3d probe: Start stored time %, estimate %, mover % (want now, 12, the Staff login)', v_start, v_est, v_by;
    END IF;
    -- (b) A later write of the times or the estimate alone changes nothing, and is not refused.
    UPDATE public.pos_kot_log SET started_at = '2020-01-01 12:00+05:45', estimated_prep_minutes = 99 WHERE id = v_t2
     RETURNING started_at, estimated_prep_minutes INTO v_start, v_est;
    IF v_start IS DISTINCT FROM now() OR v_est IS DISTINCT FROM 12 THEN
      RAISE EXCEPTION 'S809 3d probe: a times-only write moved the start to % and the estimate to %', v_start, v_est;
    END IF;
    -- (c) Ready and (d) Served are the server's too, and leave the earlier stage's time alone.
    UPDATE public.pos_kot_log SET status = 'ready', ready_at = '2020-01-01 12:00+05:45' WHERE id = v_t2 AND status = 'in_progress'
     RETURNING ready_at, started_at INTO v_ready, v_start;
    IF v_ready IS DISTINCT FROM now() OR v_start IS DISTINCT FROM now() THEN
      RAISE EXCEPTION 'S809 3d probe: Ready stored ready %, start %', v_ready, v_start;
    END IF;
    UPDATE public.pos_kot_log SET status = 'served', served_at = '2020-01-01 12:00+05:45' WHERE id = v_t2 AND status = 'ready'
     RETURNING served_at, ready_at INTO v_served, v_ready;
    IF v_served IS DISTINCT FROM now() OR v_ready IS DISTINCT FROM now() THEN
      RAISE EXCEPTION 'S809 3d probe: Served stored served %, ready %', v_served, v_ready;
    END IF;

    -- (e) A CHANGE card's Seen (S809 3a) still moves new → served, with no start or ready time.
    UPDATE public.pos_kot_log SET status = 'served', served_at = '2020-01-01 12:00+05:45' WHERE id = v_t3 AND status = 'new'
     RETURNING status, served_at, started_at, ready_at INTO v_status, v_served, v_start, v_ready;
    IF v_status IS DISTINCT FROM 'served' OR v_served IS DISTINCT FROM now() OR v_start IS NOT NULL OR v_ready IS NOT NULL THEN
      RAISE EXCEPTION 'S809 3d probe: Seen on a CHANGE card left %, served %, start %, ready %', v_status, v_served, v_start, v_ready;
    END IF;

    -- (f) Clear: a ticket whose every dish was taken off, in New. No stage time is invented.
    UPDATE public.pos_kot_log SET status = 'cancelled' WHERE id = v_t1 AND status = 'new'
     RETURNING status, status_updated_by, started_at, ready_at, served_at INTO v_status, v_by, v_start, v_ready, v_served;
    IF v_status IS DISTINCT FROM 'cancelled' OR v_by IS DISTINCT FROM v_staff
       OR v_start IS NOT NULL OR v_ready IS NOT NULL OR v_served IS NOT NULL THEN
      RAISE EXCEPTION 'S809 3d probe: clearing a fully pulled ticket left %, by %, times % / % / %', v_status, v_by, v_start, v_ready, v_served;
    END IF;
    -- ... and it stays cleared.
    BEGIN
      UPDATE public.pos_kot_log SET status = 'new' WHERE id = v_t1;
      RAISE EXCEPTION 'S809 3d probe: a cleared ticket came back';
    EXCEPTION WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'pos_kot_status_backwards' THEN
        RAISE EXCEPTION 'S809 3d probe: un-clearing was refused with hint %', v_hint;
      END IF;
    END;

    -- (g) Two tickets carried C and one C was taken off: either ticket may be cleared, not both.
    UPDATE public.pos_kot_log SET status = 'cancelled' WHERE id = v_t6;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'S809 3d probe: clearing the pulled one of two C tickets changed % row(s)', v_n;
    END IF;
    BEGIN
      UPDATE public.pos_kot_log SET status = 'cancelled' WHERE id = v_t5;
      RAISE EXCEPTION 'S809 3d probe: both C tickets were cleared for one C taken off';
    EXCEPTION WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'pos_kot_clear_food_left' THEN
        RAISE EXCEPTION 'S809 3d probe: the second C clear was refused with hint %', v_hint;
      END IF;
    END;

    -- (h) A started ticket with only part of its dish taken off is not the kitchen's to clear.
    BEGIN
      UPDATE public.pos_kot_log SET status = 'cancelled' WHERE id = v_t7;
      RAISE EXCEPTION 'S809 3d probe: a part-pulled ticket was cleared';
    EXCEPTION WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'pos_kot_clear_food_left' THEN
        RAISE EXCEPTION 'S809 3d probe: the part-pulled clear was refused with hint %', v_hint;
      END IF;
    END;

    -- (i) A dish with choices is its own line: the "extra cheese" one taken off clears from Ready,
    --     although a plain one stays on the order. Its kitchen times stay as they were.
    UPDATE public.pos_kot_log SET status = 'cancelled' WHERE id = v_t8 AND status = 'ready'
     RETURNING status, ready_at INTO v_status, v_ready;
    IF v_status IS DISTINCT FROM 'cancelled' OR v_ready IS DISTINCT FROM now() - interval '2 minutes' THEN
      RAISE EXCEPTION 'S809 3d probe: clearing the pulled customized dish left %, ready %', v_status, v_ready;
    END IF;
    --     ... while the "garlic" one, still on the order, is not the kitchen's to clear.
    BEGIN
      UPDATE public.pos_kot_log SET status = 'cancelled' WHERE id = v_t13;
      RAISE EXCEPTION 'S809 3d probe: a customized dish still on the order was cleared';
    EXCEPTION WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'pos_kot_clear_food_left' THEN
        RAISE EXCEPTION 'S809 3d probe: the held customized dish clear was refused with hint %', v_hint;
      END IF;
    END;

    -- (j) An open dish (no recipe) is matched by its name: gone clears, still ordered does not.
    UPDATE public.pos_kot_log SET status = 'cancelled' WHERE id = v_t9;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'S809 3d probe: clearing the pulled open dish changed % row(s)', v_n;
    END IF;
    BEGIN
      UPDATE public.pos_kot_log SET status = 'cancelled' WHERE id = v_t10;
      RAISE EXCEPTION 'S809 3d probe: an open dish still on the order was cleared';
    EXCEPTION WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'pos_kot_clear_food_left' THEN
        RAISE EXCEPTION 'S809 3d probe: the held open dish clear was refused with hint %', v_hint;
      END IF;
    END;

    -- (k) A served ticket is history, (l) a ticket with no dish has nothing to clear: both still
    --     need a supervisor, as before.
    BEGIN
      UPDATE public.pos_kot_log SET status = 'cancelled' WHERE id = v_t11;
      RAISE EXCEPTION 'S809 3d probe: a Staff login cancelled a served ticket';
    EXCEPTION WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'pos_kot_cancel_rank' THEN
        RAISE EXCEPTION 'S809 3d probe: the served-ticket cancel was refused with hint %', v_hint;
      END IF;
    END;
    BEGIN
      UPDATE public.pos_kot_log SET status = 'cancelled' WHERE id = v_tg;
      RAISE EXCEPTION 'S809 3d probe: a Staff login cancelled a ticket with no dish on it';
    EXCEPTION WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'pos_kot_cancel_rank' THEN
        RAISE EXCEPTION 'S809 3d probe: the no-dish cancel was refused with hint %', v_hint;
      END IF;
    END;

    -- (m) The till's void path still cancels a voided order's tickets.
    UPDATE public.pos_kot_log SET status = 'cancelled' WHERE order_id = v_ov;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'S809 3d probe: cancelling a voided order''s tickets changed % row(s)', v_n;
    END IF;

    -- (n) A blocked login holds no POS rank (S809 3i), so it clears nothing.
    RESET ROLE;
    UPDATE public.profiles SET pos_blocked_at = now() WHERE id = v_staff;
    SET LOCAL ROLE authenticated;
    BEGIN
      UPDATE public.pos_kot_log SET status = 'cancelled' WHERE id = v_t12;
      RAISE EXCEPTION 'S809 3d probe: a blocked login cleared a ticket';
    EXCEPTION WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'pos_kot_cancel_rank' THEN
        RAISE EXCEPTION 'S809 3d probe: the blocked login''s clear was refused with hint %', v_hint;
      END IF;
    END;

    -- (o) The Owner (supervisor and above) still cancels a ticket whose food the order holds.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    IF NOT COALESCE(public.is_client_owner(), false) THEN
      RAISE EXCEPTION 'S809 3d probe: % is not an Owner login', v_owner;
    END IF;
    UPDATE public.pos_kot_log SET status = 'cancelled' WHERE id = v_t5
     RETURNING status_updated_by INTO v_by;
    IF v_by IS DISTINCT FROM v_owner THEN
      RAISE EXCEPTION 'S809 3d probe: the Owner''s cancel was stamped as %', v_by;
    END IF;

    -- (p) The operator's restore still keeps a ticket's stage and times exactly as backed up.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    IF NOT COALESCE(public.is_admin(), false) THEN
      RAISE EXCEPTION 'S809 3d probe: % is not the operator', v_admin;
    END IF;
    INSERT INTO public.pos_kot_log (client_id, order_id, station, items, sent_at, status, started_at, ready_at, served_at, estimated_prep_minutes)
      VALUES (v_a, v_o, 'KOT', '[{"name":"S809 3d restored","qty":1}]', '2026-01-01 12:00+05:45', 'served',
              '2026-01-01 12:01+05:45', '2026-01-01 12:09+05:45', '2026-01-01 12:12+05:45', 10)
      RETURNING started_at, ready_at, served_at, estimated_prep_minutes INTO v_start, v_ready, v_served, v_est;
    IF v_start IS DISTINCT FROM '2026-01-01 12:01+05:45'::timestamptz OR v_ready IS DISTINCT FROM '2026-01-01 12:09+05:45'::timestamptz
       OR v_served IS DISTINCT FROM '2026-01-01 12:12+05:45'::timestamptz OR v_est IS DISTINCT FROM 10 THEN
      RAISE EXCEPTION 'S809 3d probe: the restore''s ticket became start %, ready %, served %, estimate %', v_start, v_ready, v_served, v_est;
    END IF;

    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 's809_3d_probe_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 's809_3d_probe_rollback' THEN RAISE; END IF;
  END;
END;
$$;

NOTIFY pgrst, 'reload schema';

-- Read back after applying (one statement per call):
--   SELECT proname, md5(prosrc), prosecdef, proconfig, proacl FROM pg_proc
--    WHERE oid = 'public.guard_pos_kot_log()'::regprocedure;
--     expect 5a29bcf4f39e563d85f5716c57acf482, t, {search_path=public}, {postgres=X/postgres}
--   SELECT tgname, tgenabled, tgtype, pg_get_triggerdef(oid) FROM pg_trigger
--    WHERE tgrelid = 'public.pos_kot_log'::regclass AND NOT tgisinternal;   -- guard_pos_kot_log only, O, 31
--   SELECT has_function_privilege('authenticated', 'public.guard_pos_kot_log()', 'EXECUTE');   -- f
--   SELECT relacl FROM pg_class WHERE oid = 'public.pos_kot_log'::regclass;
--     unchanged: {postgres=arwdDxtm/postgres,authenticated=arw/postgres,service_role=arwdDxtm/postgres}
--   After the first real service on the new build (one statement):
--   SELECT count(*) FILTER (WHERE started_at < sent_at) AS start_before_sent,
--          count(*) FILTER (WHERE ready_at < started_at) AS ready_before_start,
--          count(*) FILTER (WHERE served_at < ready_at) AS served_before_ready
--     FROM public.pos_kot_log WHERE sent_at >= now() - interval '1 day';   -- 0, 0, 0
