-- ════════════════════════════════════════════════════════════════════════════════════════════
-- S817, POS stage 4, slice 4i: a voided order's tickets tell the kitchen to stop, a table is not
-- retired or renamed under an open bill, two tables in service never share a name, and a guest's
-- QR order still waiting when its table's bill closes is answered.
--
--   FLOOR-KITCHEN-4 (P3, owner D18). A voided order's tickets vanished from the Kitchen Display
--   without a word, mid-cook included, and the cancel was the till's best-effort write after the
--   void, so a bill voided any other way (REST) left its tickets live and ringing all evening.
--     * New column pos_kot_log.cancelled_at, the server's clock, stamped by guard_pos_kot_log when a
--       ticket enters 'cancelled' (any path: a void, the kitchen's Clear, a supervisor). NULL on
--       insert; a client session cannot write it. Older cancelled tickets keep NULL.
--     * New AFTER UPDATE trigger pos_orders_void_cancels_tickets: the moment a bill goes open →
--       voided, every ticket of it still on the board (new, in_progress, ready) is cancelled in the
--       same transaction, as the voider. D18: a Served ticket stays Served — that food went out, and
--       "cancelled" would tell the KOT Log the kitchen was stopped. (The till cancelled every ticket,
--       served ones included; live, 12 of 12 voided-order tickets are cancelled.)
--     * The Kitchen Display reads a voided order's tickets cancelled in the last few minutes and shows
--       them struck through as "VOIDED — stop" (app, same release); the till prints a VOID slip.
--
--   S809.4 follow-up (3g): a guest QR order still waiting when its table's bill closes was never
--   answered by anything, so it rang on and the next party's screen offered its Accept.
--     * New AFTER UPDATE trigger pos_orders_close_turns_away_guest_orders: when a table's bill closes
--       (billed or voided), every guest order still pending for that table is turned away
--       ('dismissed'), in the same transaction (D21). The guest's own page already words a turned-
--       away order. guard_pos_guest_order_request stamps decided_at/decided_by for a client session;
--       the UPDATE sets the same two itself for any other caller.
--
--   FLOOR-KITCHEN-7 (P3, owner D19). POS Setup let any login mark a table Inactive while it had an
--   open bill: the floor then refused every tap on it, and the close put it back to Available.
--     * New BEFORE UPDATE trigger pos_tables_guard_open_bill (DEFINER, so its order lookup is never
--       narrower than the caller's view): a table with an open bill is not taken out of service
--       (hint pos_table_inactive_open_bill), for every login, the operator included.
--     * pos_tables_guard_rank: the cheap status-only path no longer covers Inactive. Taking a table
--       out of service or bringing it back needs a POS manager (D19); Available / Occupied / Reserved
--       stay any POS login's, as the till flips them on every seat and bill.
--
--   FLOOR-KITCHEN-8 (P3, owner D20). Nothing stopped two tables sharing a name (Quick Setup's
--   defaults recreate "Table 1-10"), and a rename mid-meal split one order's tickets and bill.
--     * Unique index pos_tables_client_name_live_key on (client_id, lower(btrim(name))) over tables
--       in service only. Partial because GUEST-7 was closed as accepted (Q21 c): retiring a table and
--       adding a new one under the same name is still the only way to a new QR code. Live: 0 clashes.
--     * pos_tables_guard_open_bill also refuses a rename while the table has an open bill
--       (hint pos_table_rename_open_bill, D20): rename it once the bill is closed.
--
--   ORDER-FLOW-19 (P3). record_pos_kot_removals_on_order_delete grouped fired food by dish, so a
--   plain and a customized plate pulled together read as one "x 2" with no choices. It now groups by
--   the line key and records selection_key and option_summary, exactly as its twin
--   record_pos_kot_removals_on_line_delete does. Reached by no app path today (POS_TODO A2).
--
-- Built on the LIVE bodies (pg_get_functiondef, md5(prosrc), read 2026-10-12). Section 0 refuses to
-- run over any other body; every change inside a replaced body is marked "S817 4i".
--   guard_pos_kot_log()                        5a29bcf4f39e563d85f5716c57acf482  (20261010130000)
--   pos_tables_guard_rank()                    d02eb0f6c6641bd8f4e4127769839263  (20260916110000)
--   record_pos_kot_removals_on_order_delete()  a2b843145e42badbc068f3a2a54465e4  (20260917100000)
-- No signature changes; CREATE OR REPLACE keeps each one's SECURITY setting and its proacl
-- ({postgres=X/postgres}: trigger functions take no grant). Called, not replaced:
-- pos_caller_has_rank(text) 100bd1bd1e2a1a1c3a6f4cb105a8e887, guard_pos_guest_order_request()
-- 78258b26afcc9b7df24374505bf0abb9, guard_pos_order_close() 2b5f4cd801170bafc620052cf40d2620.
-- New: column pos_kot_log.cancelled_at; functions pos_orders_void_cancels_tickets(),
-- pos_orders_close_turns_away_guest_orders() (both INVOKER: they write as the closer, through the
-- closer's RLS and the guards above) and pos_tables_guard_open_bill() (DEFINER), each REVOKEd from
-- PUBLIC with no grant back; their three triggers; index pos_tables_client_name_live_key.
--
-- Live before this migration (2026-10-12): 26 tables (23 available, 3 occupied, 0 inactive), 0 name
-- clashes; 0 inactive tables with an open bill; 0 pending guest orders; 0 live tickets on a voided
-- order.
--
-- Ship order: this migration BEFORE the app (the Kitchen Display reads cancelled_at). A till on
-- crest-v432 or older still cancels a voided order's tickets itself afterwards, which now changes
-- nothing (they are cancelled already; a Served one it moves to cancelled, as before). Its release
-- of a table on close is unconditional, so on a retired table a Staff closer's release is refused
-- and logged to the console (the bill is closed either way). The till build floor is unchanged.
--
-- To undo: DROP TRIGGER pos_orders_void_cancels_tickets, pos_orders_close_turns_away_guest_orders ON
-- pos_orders and pos_tables_guard_open_bill ON pos_tables, then their three functions; DROP INDEX
-- pos_tables_client_name_live_key; re-create the three replaced bodies from the files named above;
-- ALTER TABLE pos_kot_log DROP COLUMN cancelled_at (after the old guard is back, or it names it).
--
-- The probe at the end runs as a BLOOM CAFE POS PIN login (made a POS manager with Allow Void, then
-- Staff) and the migration's own role, inside a block that rolls itself back. If any check fails,
-- nothing lands.
-- ════════════════════════════════════════════════════════════════════════════════════════════


-- ── 0. Pre-flight: the bodies this file replaces are the ones it was built on ─────────────────
-- The second hash of each pair is the body this migration writes, so a re-run passes.
DO $$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.guard_pos_kot_log()'::regprocedure;
  IF v_md5 NOT IN ('5a29bcf4f39e563d85f5716c57acf482', '03c9f7767e5da970e0fdd9ebd0a9dce8') THEN
    RAISE EXCEPTION 'S817 4i pre-flight: guard_pos_kot_log changed since this was written (md5 %). Rebuild from the live body.', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.pos_tables_guard_rank()'::regprocedure;
  IF v_md5 NOT IN ('d02eb0f6c6641bd8f4e4127769839263', '6f62a8347143118b81e005103cf3fc7a') THEN
    RAISE EXCEPTION 'S817 4i pre-flight: pos_tables_guard_rank changed since this was written (md5 %). Rebuild from the live body.', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.record_pos_kot_removals_on_order_delete()'::regprocedure;
  IF v_md5 NOT IN ('a2b843145e42badbc068f3a2a54465e4', 'a61910fc82ddf7341b8cd802411e5209') THEN
    RAISE EXCEPTION 'S817 4i pre-flight: record_pos_kot_removals_on_order_delete changed since this was written (md5 %). Rebuild from the live body.', v_md5;
  END IF;
  -- FLOOR-KITCHEN-8's index would fail on a clash anyway; this names it.
  IF EXISTS (SELECT 1 FROM public.pos_tables WHERE status IS DISTINCT FROM 'inactive'
              GROUP BY client_id, lower(btrim(name)) HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'S817 4i pre-flight: an outlet has two tables in service with the same name — rename one first';
  END IF;
END;
$$;


-- ── 1. When a kitchen ticket was cancelled (FLOOR-KITCHEN-4) ─────────────────────────────────
ALTER TABLE public.pos_kot_log ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;

COMMENT ON COLUMN public.pos_kot_log.cancelled_at IS
  'S817 4i: when this ticket was cancelled (its order voided, the kitchen''s Clear, or a supervisor), the server''s clock, stamped by guard_pos_kot_log. NULL on a ticket never cancelled and on one cancelled before S817. The Kitchen Display shows a voided order''s recently cancelled tickets as stopped.';


-- ── 2. guard_pos_kot_log: cancelled_at is a stage time (live body + the S817 4i lines) ───────
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
  -- The kitchen-stage columns: the only ones a client session may change on a ticket. S817 4i adds
  -- cancelled_at, which like the other stage times is the server's (stamped below).
  v_stage        CONSTANT text[] := ARRAY['status', 'started_at', 'ready_at', 'served_at',
                                          'estimated_prep_minutes', 'status_updated_by', 'cancelled_at'];
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
    NEW.cancelled_at           := NULL;   -- S817 4i

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
  -- empty rather than inventing one, so it never enters a prep-time figure. A cancel stamps cancelled_at (S817 4i).
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'in_progress' THEN
    NEW.started_at := now();
  ELSE
    NEW.started_at             := OLD.started_at;
    NEW.estimated_prep_minutes := OLD.estimated_prep_minutes;
  END IF;
  NEW.ready_at  := CASE WHEN NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'ready'  THEN now() ELSE OLD.ready_at  END;
  NEW.served_at := CASE WHEN NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'served' THEN now() ELSE OLD.served_at END;
  -- S817 4i (FLOOR-KITCHEN-4): when a ticket was cancelled, so the Kitchen Display can keep a voided
  -- order's tickets up as stopped for a few minutes instead of letting them vanish mid-cook.
  NEW.cancelled_at := CASE WHEN NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'cancelled' THEN now() ELSE OLD.cancelled_at END;
  -- ── end S809 3d ──
  RETURN NEW;
END;
$function$;


-- ── 3. A void cancels the tickets still on the board (FLOOR-KITCHEN-4, D18) ──────────────────
-- INVOKER: it writes as the voider, through the voider's RLS, and guard_pos_kot_log admits the cancel
-- because the order is now voided, stamping status_updated_by and cancelled_at itself. The two are
-- also set here for a caller that guard waves through (the operator, the service role), so every
-- cancel carries a time. A Served ticket is left Served: that food went out.
CREATE OR REPLACE FUNCTION public.pos_orders_void_cancels_tickets()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  UPDATE pos_kot_log
     SET status            = 'cancelled',
         cancelled_at      = now(),
         status_updated_by = (SELECT p.id FROM profiles p WHERE p.id = (SELECT auth.uid()))
   WHERE order_id = NEW.id
     AND status IN ('new', 'in_progress', 'ready');
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.pos_orders_void_cancels_tickets() FROM PUBLIC;

DROP TRIGGER IF EXISTS pos_orders_void_cancels_tickets ON public.pos_orders;
CREATE TRIGGER pos_orders_void_cancels_tickets
  AFTER UPDATE OF status ON public.pos_orders
  FOR EACH ROW
  WHEN (OLD.status = 'open' AND NEW.status = 'voided')
  EXECUTE FUNCTION public.pos_orders_void_cancels_tickets();


-- ── 4. A table's bill closing answers its waiting guest orders (S809.4 / 3g, D21) ────────────
-- INVOKER, as the closer. guard_pos_guest_order_request stamps decided_at and decided_by for a client
-- session (and clears order_id on a dismissal); the same two are set here for any other caller. A
-- takeaway has no table and no QR guest order.
CREATE OR REPLACE FUNCTION public.pos_orders_close_turns_away_guest_orders()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  UPDATE pos_guest_order_requests
     SET status     = 'dismissed',
         decided_at = now(),
         decided_by = (SELECT p.id FROM profiles p WHERE p.id = (SELECT auth.uid()))
   WHERE client_id = NEW.client_id
     AND table_id  = NEW.table_id
     AND status    = 'pending';
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.pos_orders_close_turns_away_guest_orders() FROM PUBLIC;

DROP TRIGGER IF EXISTS pos_orders_close_turns_away_guest_orders ON public.pos_orders;
CREATE TRIGGER pos_orders_close_turns_away_guest_orders
  AFTER UPDATE OF status ON public.pos_orders
  FOR EACH ROW
  WHEN (OLD.status = 'open' AND NEW.status IN ('billed', 'voided') AND NEW.table_id IS NOT NULL)
  EXECUTE FUNCTION public.pos_orders_close_turns_away_guest_orders();


-- ── 5. A table with an open bill is not retired or renamed (FLOOR-KITCHEN-7, -8; D20) ────────
-- DEFINER, like pos_tables_guard_open_order_delete beside it, so the order lookup is never narrower
-- than the caller's view. Every login, the operator included: the operator is exempt from rank,
-- never from the record. The WHEN clause keeps the till's status flips from ever calling it.
CREATE OR REPLACE FUNCTION public.pos_tables_guard_open_bill()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_order_no integer;
BEGIN
  SELECT o.order_no INTO v_order_no
    FROM pos_orders o
   WHERE o.client_id = OLD.client_id AND o.table_id = OLD.id AND o.status = 'open'
   ORDER BY o.opened_at DESC
   LIMIT 1;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF NEW.status = 'inactive' AND OLD.status IS DISTINCT FROM 'inactive' THEN
    RAISE EXCEPTION 'pos_table_inactive_open_bill: % has an open bill (order #%) — bill or void it before taking the table out of service', OLD.name, COALESCE(v_order_no::text, '?')
      USING HINT = 'pos_table_inactive_open_bill';
  END IF;
  IF NEW.name IS DISTINCT FROM OLD.name THEN
    RAISE EXCEPTION 'pos_table_rename_open_bill: % has an open bill (order #%) — rename it once that bill is closed, so the bill and its kitchen tickets keep one name', OLD.name, COALESCE(v_order_no::text, '?')
      USING HINT = 'pos_table_rename_open_bill';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.pos_tables_guard_open_bill() FROM PUBLIC;

DROP TRIGGER IF EXISTS pos_tables_guard_open_bill ON public.pos_tables;
CREATE TRIGGER pos_tables_guard_open_bill
  BEFORE UPDATE ON public.pos_tables
  FOR EACH ROW
  WHEN ((NEW.status = 'inactive' AND OLD.status IS DISTINCT FROM 'inactive') OR NEW.name IS DISTINCT FROM OLD.name)
  EXECUTE FUNCTION public.pos_tables_guard_open_bill();


-- ── 6. pos_tables_guard_rank: retiring or restoring a table is a POS manager's (D19) ─────────
CREATE OR REPLACE FUNCTION public.pos_tables_guard_rank()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') OR COALESCE(public.is_admin(), false) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  -- Cheap test first: the till flips status on every seat and every bill.
  -- S817 4i (FLOOR-KITCHEN-7, D19): but not into or out of Inactive. Taking a table out of service
  -- also switches off QR ordering on it, and is a setup decision, not till work.
  IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - 'status') = (to_jsonb(OLD) - 'status')
     AND NEW.status IS DISTINCT FROM 'inactive' AND OLD.status IS DISTINCT FROM 'inactive' THEN
    RETURN NEW;
  END IF;
  IF NOT public.pos_caller_has_rank('manager') THEN
    RAISE EXCEPTION 'pos_tables_rank: only the Owner or a POS manager can add, rename, move or delete tables, or take one out of service or back'
      USING ERRCODE = '42501', HINT = 'pos_tables_rank';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$function$;


-- ── 7. Two tables in service never share a name (FLOOR-KITCHEN-8) ───────────────────────────
-- Spaces at either end and capitals ignored, as POS Setup compares them. Retired tables are left out
-- (see the header: GUEST-7's only way to a new QR code).
CREATE UNIQUE INDEX IF NOT EXISTS pos_tables_client_name_live_key
  ON public.pos_tables (client_id, lower(btrim(name)))
  WHERE status IS DISTINCT FROM 'inactive';


-- ── 8. The pulled-item record of a deleted order groups by line (ORDER-FLOW-19) ─────────────
CREATE OR REPLACE FUNCTION public.record_pos_kot_removals_on_order_delete()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF OLD.status IS DISTINCT FROM 'open' THEN
    RETURN OLD;
  END IF;
  IF current_setting('crest.pos_items_rpc', true) = 'on' THEN
    RETURN OLD;
  END IF;
  IF COALESCE((SELECT auth.jwt() ->> 'role'), '') <> 'authenticated' THEN
    RETURN OLD;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM clients c WHERE c.id = OLD.client_id) THEN
    RETURN OLD;
  END IF;

  -- S817 4i (ORDER-FLOW-19): one row per LINE (recipe plus selection, else the name), with the line's
  -- choices, exactly as record_pos_kot_removals_on_line_delete and save_pos_order_items record a pull.
  INSERT INTO pos_kot_removals (client_id, order_id, order_no, table_name, recipe_id, item_name, qty_removed, reason, removed_by, selection_key, option_summary)
  SELECT OLD.client_id, OLD.id, OLD.order_no, OLD.table_name,
         MIN(rec.id::text)::uuid, MIN(l.name), SUM(l.sent)::integer, 'Table cleared',
         (SELECT p.id FROM profiles p WHERE p.id = (SELECT auth.uid())),
         NULLIF(MIN(l.selection_key), ''), MIN(l.option_summary)
    FROM (
      SELECT i.recipe_id, i.name, i.selection_key, i.option_summary,
             LEAST(i.qty, GREATEST(COALESCE(i.sent_qty, 0),
                                   CASE WHEN COALESCE(i.sent_to_kot, false) THEN i.qty ELSE 0 END)) AS sent
        FROM pos_order_items i
       WHERE i.order_id = OLD.id AND NOT COALESCE(i.comped, false)
    ) l
    LEFT JOIN recipes rec ON rec.id = l.recipe_id
   GROUP BY COALESCE(l.recipe_id::text || CASE WHEN l.selection_key <> '' THEN '#' || l.selection_key ELSE '' END, l.name)
  HAVING SUM(l.sent) > 0;

  RETURN OLD;
END;
$function$;


-- ── 9. Probe: as a BLOOM CAFE POS PIN login, rolled back ────────────────────────────────────────
DO $$
DECLARE
  v_c    uuid;    -- BLOOM CAFE
  v_u    uuid;    -- a POS PIN login of BLOOM CAFE: a POS manager with Allow Void, then Staff
  v_rec  uuid;    -- any dish of BLOOM CAFE
  v_t1 uuid; v_t2 uuid; v_t3 uuid;
  v_o1   uuid;    -- open on T1, then voided
  v_o2   uuid;    -- open on T2 throughout
  v_od   uuid;    -- an open takeaway with fired lines, deleted
  v_q1 uuid; v_q3 uuid;
  v_n    integer;
  v_m    integer;
  v_k    integer;
  v_hint text;
  v_msg  text;
  v_ok   boolean;
BEGIN
  SELECT id INTO v_c FROM public.clients WHERE name = 'BLOOM CAFE';
  SELECT p.id INTO v_u
    FROM public.profiles p
   WHERE p.role = 'client' AND COALESCE(p.active_client_id, p.client_id) = v_c AND p.pos_email IS NOT NULL
   ORDER BY (p.pos_role = 'manager') DESC NULLS LAST, p.id
   LIMIT 1;
  SELECT r.id INTO v_rec FROM public.recipes r
   WHERE r.client_id = v_c AND COALESCE(r.category, '') <> 'Sub-Recipe'
   ORDER BY r.id LIMIT 1;
  IF v_c IS NULL OR v_u IS NULL OR v_rec IS NULL THEN
    RAISE EXCEPTION 'S817 4i probe: needs BLOOM CAFE, a POS PIN login of it and a dish (got %, %, %)', v_c, v_u, v_rec;
  END IF;
  IF EXISTS (SELECT 1 FROM public.pos_tables WHERE client_id = v_c AND name ILIKE 'S817 4i probe%') THEN
    RAISE EXCEPTION 'S817 4i probe: a probe table name is already in use at BLOOM CAFE';
  END IF;

  BEGIN
    -- Slice 1b's build gate (if a floor is set when this runs) reads this header.
    PERFORM set_config('request.headers', '{"x-crest-build":"crest-v999999"}', true);

    -- ── Setup, as the migration's own role (no JWT yet, so every guard lets it through) ──────
    -- The stand-in loses every other staff marker (a restrictive policy would otherwise turn an
    -- "allowed" into a vacuous 0 rows).
    UPDATE public.profiles
       SET pos_role = 'manager', pos_allow_void = true, pos_discount_limit = 10, pos_blocked_at = NULL,
           settlement_blocked_by = NULL, ims_role = NULL, hr_role = NULL, hr_self_service = false
     WHERE id = v_u;

    INSERT INTO public.pos_tables (client_id, name, capacity, status, sort_order)
      VALUES (v_c, 'S817 4i probe T1', 2, 'occupied', 9901) RETURNING id INTO v_t1;
    INSERT INTO public.pos_tables (client_id, name, capacity, status, sort_order)
      VALUES (v_c, 'S817 4i probe T2', 2, 'occupied', 9902) RETURNING id INTO v_t2;
    INSERT INTO public.pos_tables (client_id, name, capacity, status, sort_order)
      VALUES (v_c, 'S817 4i probe T3', 2, 'available', 9903) RETURNING id INTO v_t3;
    INSERT INTO public.pos_orders (client_id, status, table_id, table_name)
      VALUES (v_c, 'open', v_t1, 'S817 4i probe T1') RETURNING id INTO v_o1;
    INSERT INTO public.pos_orders (client_id, status, table_id, table_name)
      VALUES (v_c, 'open', v_t2, 'S817 4i probe T2') RETURNING id INTO v_o2;
    INSERT INTO public.pos_orders (client_id, status, table_name)
      VALUES (v_c, 'open', 'S817 4i probe D') RETURNING id INTO v_od;

    -- T1's order: a ticket in New, one In Progress and one already Served.
    INSERT INTO public.pos_kot_log (client_id, order_id, order_no, table_name, station, items, status)
      SELECT v_c, v_o1, o.order_no, 'S817 4i probe T1', s.station,
             jsonb_build_array(jsonb_build_object('recipe_id', v_rec, 'name', 'S817 probe dish', 'qty', 1)), s.status
        FROM public.pos_orders o
       CROSS JOIN (VALUES ('KOT', 'new'), ('KOT', 'in_progress'), ('BOT', 'served')) AS s(station, status)
       WHERE o.id = v_o1;
    -- A guest order waiting at T1 and one at T3.
    INSERT INTO public.pos_guest_order_requests (client_id, table_id, items)
      VALUES (v_c, v_t1, '[]'::jsonb) RETURNING id INTO v_q1;
    INSERT INTO public.pos_guest_order_requests (client_id, table_id, items)
      VALUES (v_c, v_t3, '[]'::jsonb) RETURNING id INTO v_q3;
    -- The takeaway: a plain plate and a customized plate of the same dish, both fired.
    INSERT INTO public.pos_order_items (order_id, client_id, recipe_id, name, qty, unit_price, sent_to_kot, sent_qty, selection_key, option_summary)
      VALUES (v_od, v_c, v_rec, 'S817 probe dish', 1, 100, true, 1, '', NULL),
             (v_od, v_c, v_rec, 'S817 probe dish', 1, 120, true, 1, 'probe-sel', 'Large');

    -- ── (a) ORDER-FLOW-19: a browser's delete of the open takeaway records two lines ─────────
    -- The JWT says authenticated while current_user stays the migration's role: the only way to reach
    -- this path, since a real browser's delete of an order with lines is refused (POS_TODO A2).
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_u, 'role', 'authenticated')::text, true);
    DELETE FROM public.pos_orders WHERE id = v_od;
    SELECT count(*),
           count(*) FILTER (WHERE selection_key = 'probe-sel' AND option_summary = 'Large' AND qty_removed = 1),
           count(*) FILTER (WHERE selection_key IS NULL AND qty_removed = 1 AND removed_by = v_u)
      INTO v_n, v_m, v_k
      FROM public.pos_kot_removals
     WHERE client_id = v_c AND table_name = 'S817 4i probe D';
    IF v_n <> 2 OR v_m <> 1 OR v_k <> 1 THEN
      RAISE EXCEPTION 'S817 4i probe: the deleted takeaway recorded % pulled rows (% customized, % plain; want 2, 1, 1)', v_n, v_m, v_k;
    END IF;

    -- ── As the POS manager, through RLS and the INVOKER triggers ─────────────────────────────
    SET LOCAL ROLE authenticated;
    IF COALESCE(public.is_admin(), false) OR COALESCE(public.is_client_owner(), false)
       OR NOT public.pos_caller_has_rank('manager') THEN
      RAISE EXCEPTION 'S817 4i probe: the stand-in % is not a plain POS manager', v_u;
    END IF;

    -- (b) FLOOR-KITCHEN-4 and the S809.4 follow-up: voiding T1's bill cancels its live tickets and
    -- turns away T1's waiting guest order, and nothing else.
    UPDATE public.pos_orders SET status = 'voided', close_type = 'void' WHERE id = v_o1;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'S817 4i probe: the void updated % rows', v_n;
    END IF;
    SELECT count(*) FILTER (WHERE status = 'cancelled' AND cancelled_at IS NOT NULL AND status_updated_by = v_u),
           count(*) FILTER (WHERE status = 'served' AND cancelled_at IS NULL)
      INTO v_n, v_m
      FROM public.pos_kot_log WHERE order_id = v_o1;
    IF v_n <> 2 OR v_m <> 1 THEN
      RAISE EXCEPTION 'S817 4i probe: after the void, % tickets cancelled and stamped (want 2), % still served (want 1)', v_n, v_m;
    END IF;
    SELECT COALESCE(status = 'dismissed' AND decided_by = v_u AND decided_at IS NOT NULL AND order_id IS NULL, false)
      INTO v_ok FROM public.pos_guest_order_requests WHERE id = v_q1;
    IF NOT COALESCE(v_ok, false) THEN
      RAISE EXCEPTION 'S817 4i probe: T1''s waiting guest order was not turned away by the void';
    END IF;
    IF (SELECT status FROM public.pos_guest_order_requests WHERE id = v_q3) IS DISTINCT FROM 'pending' THEN
      RAISE EXCEPTION 'S817 4i probe: T3''s guest order was answered by T1''s void';
    END IF;

    -- (c) FLOOR-KITCHEN-7 / -8: T2 has an open bill, so it is neither retired nor renamed.
    BEGIN
      UPDATE public.pos_tables SET status = 'inactive' WHERE id = v_t2;
      RAISE EXCEPTION 'S817 4i probe: a table with an open bill was taken out of service';
    EXCEPTION WHEN raise_exception THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
      IF v_hint IS DISTINCT FROM 'pos_table_inactive_open_bill' THEN
        RAISE EXCEPTION 'S817 4i probe: retiring T2 was refused with % (%)', v_hint, v_msg;
      END IF;
    END;
    BEGIN
      UPDATE public.pos_tables SET name = 'S817 4i probe T2 renamed' WHERE id = v_t2;
      RAISE EXCEPTION 'S817 4i probe: a table with an open bill was renamed';
    EXCEPTION WHEN raise_exception THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
      IF v_hint IS DISTINCT FROM 'pos_table_rename_open_bill' THEN
        RAISE EXCEPTION 'S817 4i probe: renaming T2 was refused with % (%)', v_hint, v_msg;
      END IF;
    END;
    -- T1's bill is closed now: the manager may rename it and take it out of service.
    UPDATE public.pos_tables SET name = 'S817 4i probe T1x' WHERE id = v_t1;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    UPDATE public.pos_tables SET status = 'inactive' WHERE id = v_t1;
    GET DIAGNOSTICS v_m = ROW_COUNT;
    IF v_n <> 1 OR v_m <> 1 THEN
      RAISE EXCEPTION 'S817 4i probe: the manager''s rename / retire of T1 changed % / % rows', v_n, v_m;
    END IF;

    -- (d) FLOOR-KITCHEN-8: a name in service is refused whatever its capitals and spaces; a retired
    -- table's name may be used again.
    BEGIN
      INSERT INTO public.pos_tables (client_id, name, capacity, sort_order)
        VALUES (v_c, ' s817 4I PROBE t3 ', 2, 9904);
      RAISE EXCEPTION 'S817 4i probe: a second "S817 4i probe T3" was added';
    EXCEPTION WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_msg = CONSTRAINT_NAME;
      IF v_msg IS DISTINCT FROM 'pos_tables_client_name_live_key' THEN
        RAISE EXCEPTION 'S817 4i probe: the clash was refused by % instead', v_msg;
      END IF;
    END;
    INSERT INTO public.pos_tables (client_id, name, capacity, sort_order)
      VALUES (v_c, 'S817 4i probe T1x', 2, 9905);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'S817 4i probe: the retired T1x''s name could not be used again';
    END IF;

    -- ── As the same login at Staff rank ───────────────────────────────────────────────────────
    RESET ROLE;
    UPDATE public.profiles SET pos_role = 'staff' WHERE id = v_u;
    SET LOCAL ROLE authenticated;
    IF public.pos_caller_has_rank('supervisor') OR NOT public.pos_caller_has_rank('staff') THEN
      RAISE EXCEPTION 'S817 4i probe: the stand-in % is not plain Staff now', v_u;
    END IF;

    -- (e) The control: Staff still seats a table, as the till does on every order.
    UPDATE public.pos_tables SET status = 'occupied' WHERE id = v_t3;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'S817 4i probe: Staff could not mark T3 occupied (% rows)', v_n;
    END IF;
    -- (f) D19: Staff neither retires a table nor brings one back.
    BEGIN
      UPDATE public.pos_tables SET status = 'inactive' WHERE id = v_t3;
      RAISE EXCEPTION 'S817 4i probe: Staff took T3 out of service';
    EXCEPTION WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'pos_tables_rank' THEN
        RAISE EXCEPTION 'S817 4i probe: Staff retiring T3 was refused with %', v_hint;
      END IF;
    END;
    BEGIN
      UPDATE public.pos_tables SET status = 'available' WHERE id = v_t1;
      RAISE EXCEPTION 'S817 4i probe: Staff brought the retired T1 back';
    EXCEPTION WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'pos_tables_rank' THEN
        RAISE EXCEPTION 'S817 4i probe: Staff restoring T1 was refused with %', v_hint;
      END IF;
    END;

    -- (g) cancelled_at is the server's: a client session's value is ignored, not stored.
    UPDATE public.pos_kot_log SET cancelled_at = now() - interval '1 day'
     WHERE order_id = v_o1 AND status = 'served';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 OR EXISTS (SELECT 1 FROM public.pos_kot_log WHERE order_id = v_o1 AND status = 'served' AND cancelled_at IS NOT NULL) THEN
      RAISE EXCEPTION 'S817 4i probe: a client session wrote cancelled_at on a served ticket (% rows)', v_n;
    END IF;

    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 's817_4i_probe_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 's817_4i_probe_rollback' THEN RAISE; END IF;
  END;
END;
$$;

NOTIFY pgrst, 'reload schema';

-- Read back after applying (one statement per call):
--   SELECT p.oid::regprocedure, md5(p.prosrc), p.prosecdef, p.proacl FROM pg_proc p
--    WHERE p.pronamespace = 'public'::regnamespace
--      AND p.proname IN ('guard_pos_kot_log', 'pos_tables_guard_rank', 'record_pos_kot_removals_on_order_delete',
--                        'pos_orders_void_cancels_tickets', 'pos_orders_close_turns_away_guest_orders',
--                        'pos_tables_guard_open_bill');
--     expect guard_pos_kot_log 03c9f7767e5da970e0fdd9ebd0a9dce8 (DEFINER), pos_tables_guard_rank 6f62a8347143118b81e005103cf3fc7a (INVOKER),
--     record_pos_kot_removals_on_order_delete a61910fc82ddf7341b8cd802411e5209 (DEFINER); the two pos_orders functions
--     INVOKER and pos_tables_guard_open_bill DEFINER; proacl {postgres=X/postgres} on all six.
--   SELECT tgname, pg_get_triggerdef(oid) FROM pg_trigger
--    WHERE tgrelid IN ('public.pos_orders'::regclass, 'public.pos_tables'::regclass) AND NOT tgisinternal;
--   SELECT indexrelid::regclass, pg_get_indexdef(indexrelid) FROM pg_index WHERE indrelid = 'public.pos_tables'::regclass;
--   SELECT column_name, data_type, is_nullable FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'pos_kot_log' AND column_name = 'cancelled_at';
