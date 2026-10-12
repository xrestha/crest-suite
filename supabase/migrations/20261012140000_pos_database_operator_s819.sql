-- ════════════════════════════════════════════════════════════════════════════════════════════
-- S819, POS stage 4, slice 4k: bills and their lines belong to a client the database knows, the
-- polls that run all service day read an index, and Crest support meets the same ticket and
-- parking-slip rules as the restaurant, under a name the Owner can read.
--
--   DATABASE-7 (P3). pos_orders and pos_order_items had no foreign key to clients, and
--   pos_order_items.recipe_id none to recipes. A client deleted with POS rows left behind kept them
--   in the live tables (the review found one open order of a deleted client), and a dish deleted
--   over REST left its bill lines pointing at nothing. The orphan the review found is gone live
--   (0 orphan orders, 0 orphan lines, 0 lines on a deleted dish, read 2026-10-12), so section 0
--   refuses to run if any orphan has come back rather than deleting a bill on its own.
--     * pos_orders.client_id and pos_order_items.client_id → clients ON DELETE CASCADE. A backstop:
--       Delete Client, Archive and the trial purge clear POS through deleteClientDataFor first.
--     * pos_order_items.recipe_id → recipes, a plain FK that refuses (owner D27 a), the same answer
--       sales_entries.recipe_id gives: a dish that is on any bill is hidden, never deleted. Recipe
--       Costing already refuses it up front (S711) and words a 23503 from its delete. Delete Client
--       removes bill lines before recipes; Clear IMS keeps recipes; the restore loads recipes before
--       bill lines. idx_pos_order_items_recipe_id already covers the check a recipe delete runs.
--     * All three are added NOT VALID and then VALIDATEd, so the scan runs under the weaker lock.
--
--   DATABASE-8 (P3). The floor, the Kitchen Display, the nav badges and Home re-read every order and
--   ticket the outlet ever had on every poll (4,248 bills and 7,503 tickets live). One index per
--   query that runs today (the S543 rule):
--     * idx_pos_orders_open (client_id) WHERE status = 'open': the floor every 15 s per till
--       (PosOrders' floor read), the nav badge every 60 s, the shift close and Clear-all checks.
--     * idx_pos_kot_log_live (client_id, sent_at) WHERE status IN ('new','in_progress','ready'):
--       the Kitchen Display board every 4 s per screen, the POS Dashboard and Home's attention row.
--     * idx_pos_kot_log_cancelled (client_id, cancelled_at) WHERE status = 'cancelled': the Kitchen
--       Display's voided-order read (S817 4i), every 4 s per screen.
--     * idx_pos_orders_closed (client_id, closed_at): the report ranges (Sales Report, Covers,
--       Sales Exceptions, KOT Log's bill lookups, the One Lakh and IMS-posting reads).
--     Shifts are left alone: one row a day, as the review advised.
--
--   S809.4 (3d): the operator bypassed guard_pos_kot_log entirely, so a ticket support moved on the
--   Kitchen Display kept the tablet's times and could go backwards, against Q26 (a). Now the operator
--   passes only its RESTORE (an INSERT of a ticket dated before this transaction, the 1l shape: no
--   till sends sent_at, so a screen's ticket is dated now() by the column default). Everything else
--   support sends meets the Owner's rules; it keeps only the rank exemption, which
--   pos_caller_has_rank already grants it. One addition for every caller: a DELETE that is part of
--   deleting the whole client (the client row already gone) passes, because ClientDrawer deletes the
--   clients row from the operator's browser session and the new pos_orders cascade reaches tickets.
--
--   S809.4 (3i): pos_parking_slips_guard let the operator INSERT anything; its comment said 1l had
--   narrowed it to a restore and the body never was. Now the restore (created_at before this
--   transaction; the issue screen never sends it) is all that passes; a slip support issues from
--   the screen is numbered, timed and attributed by the server like anyone's.
--
--   GAP-OPERATOR-3 (P3). get_client_profile_names returned this client's logins, its group's, and
--   the caller's own row, so everything Crest support did read "—" to the Owner: 3 voids, 9 closed
--   bills, a shift and the only credit note at BLOOM CAFE. It now also returns every Crest operator
--   login, named "Crest support" (owner D28 b: no personal name). The operator sees the same label
--   on its own work, so both read one page. Every caller uses the result as an id → name map, so the
--   reports, Shifts, KOT Log, Credit Notes, Requisitions, reprints and the export follow at once.
--   The till's own print of a bill support closes says the same (D29 a, src/modules/pos/orders/
--   posOrdersConstants.js CREST_SUPPORT_LABEL, held to this file by its test). The caller check is
--   wrapped in COALESCE now; it failed closed already (IF NULL does not fire), the rule is the rule.
--
-- Built on the live bodies, md5(prosrc): guard_pos_kot_log 03c9f7767e5da970e0fdd9ebd0a9dce8 (S817
-- 4i, 20261012120000), pos_parking_slips_guard cea81cf68f95469e271b0b8327d9bfe9 (S809 1k,
-- 20261009170000), get_client_profile_names 4ae1b6ed11ce6db20a04ae2a0032f31e (S798 3f-2,
-- 20261004120000). Section 0 refuses any other body. Signatures, return types, SECURITY and
-- search_path are unchanged, so CREATE OR REPLACE keeps every grant and both triggers stay attached.
--
-- No till sends anything new and no RPC changes shape: the till build floor is unchanged. No Edge
-- Function deploy.
--
-- To undo: DROP the three constraints (pos_orders_client_id_fkey, pos_order_items_client_id_fkey,
-- pos_order_items_recipe_id_fkey) and the four indexes, and re-run the three functions'
-- CREATE OR REPLACE from 20261012120000, 20261009170000 and 20261004120000.
--
-- The probe at the end acts as BLOOM CAFE's operator and Owner inside a block that rolls itself
-- back. If any check fails, nothing lands.
-- ════════════════════════════════════════════════════════════════════════════════════════════


-- ── 0. Pre-flight: the bodies this file replaces, and no orphan in the way ─────────────────────
-- Each second hash is the body this migration writes, so a re-run passes.
DO $$
DECLARE
  v_md5 text;
  v_n   bigint;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.guard_pos_kot_log()'::regprocedure;
  IF v_md5 IS NULL OR v_md5 NOT IN ('03c9f7767e5da970e0fdd9ebd0a9dce8', '2d7855019e27b458a526c7da0dbef297') THEN
    RAISE EXCEPTION 'S819 4k pre-flight: guard_pos_kot_log changed since this was written (md5 %). Rebuild from the live body.', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.pos_parking_slips_guard()'::regprocedure;
  IF v_md5 IS NULL OR v_md5 NOT IN ('cea81cf68f95469e271b0b8327d9bfe9', '9b4cdf11d8007ec10746e08fab064cab') THEN
    RAISE EXCEPTION 'S819 4k pre-flight: pos_parking_slips_guard changed since this was written (md5 %). Rebuild from the live body.', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.get_client_profile_names(uuid)'::regprocedure;
  IF v_md5 IS NULL OR v_md5 NOT IN ('4ae1b6ed11ce6db20a04ae2a0032f31e', '1aba42084b1feab9d1cc617a0490a801') THEN
    RAISE EXCEPTION 'S819 4k pre-flight: get_client_profile_names changed since this was written (md5 %). Rebuild from the live body.', v_md5;
  END IF;

  SELECT count(*) INTO v_n FROM public.pos_orders o
   WHERE NOT EXISTS (SELECT 1 FROM public.clients c WHERE c.id = o.client_id);
  IF v_n > 0 THEN
    RAISE EXCEPTION 'S819 4k pre-flight: % bill(s) belong to a client that no longer exists. Look at them before this FK goes on; this file deletes no bill.', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.pos_order_items i
   WHERE NOT EXISTS (SELECT 1 FROM public.clients c WHERE c.id = i.client_id);
  IF v_n > 0 THEN
    RAISE EXCEPTION 'S819 4k pre-flight: % bill line(s) belong to a client that no longer exists', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.pos_order_items i
   WHERE i.recipe_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.recipes r WHERE r.id = i.recipe_id);
  IF v_n > 0 THEN
    RAISE EXCEPTION 'S819 4k pre-flight: % bill line(s) point at a dish that no longer exists', v_n;
  END IF;
END;
$$;


-- ── 1. DATABASE-7: bills and lines belong to a client, and a dish on a bill stays ──────────────
ALTER TABLE public.pos_orders DROP CONSTRAINT IF EXISTS pos_orders_client_id_fkey;
ALTER TABLE public.pos_orders
  ADD CONSTRAINT pos_orders_client_id_fkey FOREIGN KEY (client_id)
  REFERENCES public.clients(id) ON DELETE CASCADE NOT VALID;
ALTER TABLE public.pos_orders VALIDATE CONSTRAINT pos_orders_client_id_fkey;

ALTER TABLE public.pos_order_items DROP CONSTRAINT IF EXISTS pos_order_items_client_id_fkey;
ALTER TABLE public.pos_order_items
  ADD CONSTRAINT pos_order_items_client_id_fkey FOREIGN KEY (client_id)
  REFERENCES public.clients(id) ON DELETE CASCADE NOT VALID;
ALTER TABLE public.pos_order_items VALIDATE CONSTRAINT pos_order_items_client_id_fkey;

-- No ON DELETE clause: NO ACTION, so deleting a dish that is on a bill is refused (D27 a).
ALTER TABLE public.pos_order_items DROP CONSTRAINT IF EXISTS pos_order_items_recipe_id_fkey;
ALTER TABLE public.pos_order_items
  ADD CONSTRAINT pos_order_items_recipe_id_fkey FOREIGN KEY (recipe_id)
  REFERENCES public.recipes(id) NOT VALID;
ALTER TABLE public.pos_order_items VALIDATE CONSTRAINT pos_order_items_recipe_id_fkey;


-- ── 2. DATABASE-8: one index per poll ─────────────────────────────────────────────────────────
-- Plain CREATE INDEX: the tables are small enough that the brief lock is milliseconds, and
-- CONCURRENTLY cannot run inside the transaction this file is applied in.
CREATE INDEX IF NOT EXISTS idx_pos_orders_open
  ON public.pos_orders (client_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_pos_orders_closed
  ON public.pos_orders (client_id, closed_at);
CREATE INDEX IF NOT EXISTS idx_pos_kot_log_live
  ON public.pos_kot_log (client_id, sent_at) WHERE status IN ('new', 'in_progress', 'ready');
CREATE INDEX IF NOT EXISTS idx_pos_kot_log_cancelled
  ON public.pos_kot_log (client_id, cancelled_at) WHERE status = 'cancelled';


-- ── 3. guard_pos_kot_log: the operator's restore passes, nothing else it sends ─────────────────
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
  IF COALESCE((SELECT auth.jwt() ->> 'role'), '') NOT IN ('anon', 'authenticated') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- ── S819 4k (S809.4, Q26 a): the operator's restore, and nothing else it sends ─────────────
  -- restoreClientData re-inserts a client's tickets as they were, each dated when it was first
  -- sent. No till sends sent_at, so a ticket sent from a screen (by the operator too) is dated now()
  -- by the column default and meets every rule below. The operator keeps only the rank exemption:
  -- pos_caller_has_rank admits it at every level.
  IF TG_OP = 'INSERT' AND COALESCE(public.is_admin(), false) AND COALESCE(NEW.sent_at < now(), false) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    -- S819 4k: deleting the whole client. ClientDrawer deletes the clients row from the operator's
    -- session once deleteClientDataFor has cleared POS, and the pos_orders cascade (DATABASE-7)
    -- reaches any ticket left behind. Inside that cascade the client row is already gone; this body
    -- is DEFINER, so the test sees it whatever the caller's policies are.
    IF NOT EXISTS (SELECT 1 FROM clients c WHERE c.id = OLD.client_id) THEN
      RETURN OLD;
    END IF;
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


-- ── 4. pos_parking_slips_guard: the operator's restore passes, nothing else it sends ──────────
CREATE OR REPLACE FUNCTION public.pos_parking_slips_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_invoice integer;
  v_cutoff  timestamptz;
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- ── S819 4k (S809.4, Q26 a): the operator's restore, and nothing else it sends ───────────
    -- restoreClientData re-inserts a client's slips as they were, each dated when it was issued.
    -- The issue screen never sends created_at, so a slip issued from it (by the operator too) is
    -- dated now() by the column default and meets every rule below; the operator keeps only the
    -- rank exemption, which pos_caller_has_rank grants it.
    IF COALESCE(public.is_admin(), false) AND COALESCE(NEW.created_at < now(), false) THEN
      RETURN NEW;
    END IF;
    IF NOT COALESCE(public.pos_caller_has_rank('supervisor'), false) THEN
      RAISE EXCEPTION 'pos_parking_slips: issuing a parking slip needs a POS supervisor, a POS manager or the Owner'
        USING ERRCODE = '42501', HINT = 'pos_parking_slip_rank';
    END IF;
    IF NEW.order_id IS NOT NULL THEN
      SELECT o.invoice_no INTO v_invoice
        FROM pos_orders o
       WHERE o.id = NEW.order_id AND o.client_id = NEW.client_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'pos_parking_slips: a parking slip can only be linked to a bill of its own outlet'
          USING ERRCODE = '23503', HINT = 'pos_parking_slip_bill';
      END IF;
    END IF;
    NEW.slip_no         := NULL;          -- numbered next by trg_assign_pos_parking_slip_no
    NEW.bill_invoice_no := v_invoice;     -- the linked bill's own number, never the tablet's
    NEW.issued_by       := (select auth.uid());
    NEW.time_in         := now();
    NEW.created_at      := now();
    NEW.status          := 'open';
    NEW.time_out        := NULL;
    NEW.exited_by       := NULL;
    NEW.auto_closed     := false;
    NEW.print_count     := 0;
    RETURN NEW;
  END IF;

  -- UPDATE. After issue a slip is only printed again or closed.
  IF (to_jsonb(NEW) - ARRAY['print_count', 'status', 'time_out', 'exited_by', 'auto_closed'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['print_count', 'status', 'time_out', 'exited_by', 'auto_closed']) THEN
    RAISE EXCEPTION 'pos_parking_slips: an issued parking slip cannot be rewritten; it can only be printed again or marked exited'
      USING ERRCODE = '42501', HINT = 'pos_parking_slip_locked';
  END IF;
  IF NOT COALESCE(public.pos_caller_has_rank('staff'), false) THEN
    RAISE EXCEPTION 'pos_parking_slips: printing or closing a parking slip needs a POS login (Staff rank or above) or the Owner'
      USING ERRCODE = '42501', HINT = 'rank_required';
  END IF;

  -- A print is one more copy, whatever count the tablet last saw. It never goes back down.
  IF NEW.print_count IS DISTINCT FROM OLD.print_count THEN
    NEW.print_count := OLD.print_count + 1;
  END IF;

  IF (NEW.status, NEW.time_out, NEW.exited_by, NEW.auto_closed)
     IS DISTINCT FROM (OLD.status, OLD.time_out, OLD.exited_by, OLD.auto_closed) THEN
    IF OLD.status = 'closed' THEN
      IF NEW.status IS DISTINCT FROM 'closed' THEN
        RAISE EXCEPTION 'pos_parking_slips: a closed parking slip stays closed'
          USING HINT = 'pos_parking_slip_closed';
      END IF;
      -- Closed again (two tablets, or Mark Exited after the sweep): the first close stands.
      NEW.time_out    := OLD.time_out;
      NEW.exited_by   := OLD.exited_by;
      NEW.auto_closed := OLD.auto_closed;
    ELSE
      IF NEW.status IS DISTINCT FROM 'closed' THEN
        RAISE EXCEPTION 'pos_parking_slips: an open parking slip changes only by being marked exited'
          USING ERRCODE = '42501', HINT = 'pos_parking_slip_locked';
      END IF;
      IF NEW.auto_closed THEN
        -- The page's sweep closes a slip from before the 6 AM (Nepal) that started today's service
        -- day (PosParkingSlips.jsx). 30 minutes of slack for a tablet clock running fast, so the
        -- sweep a till sends is never refused for a few minutes' drift.
        v_cutoff := (date_trunc('day', ((now() + interval '30 minutes') AT TIME ZONE 'Asia/Kathmandu') - interval '6 hours')
                     + interval '6 hours') AT TIME ZONE 'Asia/Kathmandu';
        IF OLD.time_in >= v_cutoff THEN
          RAISE EXCEPTION 'pos_parking_slips: only a slip from an earlier service day closes automatically; mark this vehicle exited instead'
            USING HINT = 'pos_parking_slip_not_stale';
        END IF;
      END IF;
      NEW.time_out  := now();
      NEW.exited_by := CASE WHEN NEW.auto_closed THEN NULL ELSE (select auth.uid()) END;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;


-- ── 5. get_client_profile_names: Crest support has a name the Owner can read ──────────────────
CREATE OR REPLACE FUNCTION public.get_client_profile_names(p_client_id uuid)
 RETURNS TABLE(id uuid, full_name text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  caller_client_id uuid;
  caller_role text;
BEGIN
  SELECT COALESCE(p.active_client_id, p.client_id), p.role INTO caller_client_id, caller_role FROM profiles p WHERE p.id = auth.uid();
  IF COALESCE(caller_role = 'admin' OR caller_client_id = p_client_id, false) THEN
    RETURN QUERY
      -- S819 4k (GAP-OPERATOR-3, D28 b): a Crest operator login is "Crest support" to everyone,
      -- itself included, and never its own name; the till prints the same words
      -- (posOrdersConstants.js CREST_SUPPORT_LABEL).
      SELECT p.id, (CASE WHEN p.role = 'admin' THEN 'Crest support' ELSE p.full_name END)::text
        FROM profiles p
       WHERE p.client_id = p_client_id OR p.id = auth.uid()
          -- S798 3f-2: a login whose home is another outlet of this one's group. It may have decided
          -- things here through Outlet Access, or been moved from here when its owner left this outlet.
          OR p.client_id IN (SELECT c2.id FROM clients c1 JOIN clients c2 ON c2.group_id = c1.group_id
                              WHERE c1.id = p_client_id)
          -- S819 4k: Crest support, whose own profile belongs to no client, acts inside one.
          OR p.role = 'admin';
  END IF;
END;
$function$;


-- ── 6. Probe: catalog, then each changed rule acted out, rolled back ──────────────────────────
DO $$
DECLARE
  v_client   uuid;
  v_admin    uuid;
  v_owner    uuid;
  v_order    uuid;
  v_ticket   uuid;
  v_live     uuid;
  v_restored uuid;
  v_slip     uuid;
  v_oldslip  uuid;
  v_recipe   uuid;
  v_row      record;
  v_n        bigint;
  v_name     text;
  v_refused  boolean;
  v_past     timestamptz := now() - interval '10 days';
BEGIN
  -- ── Catalog: the three FKs as written and validated, the four indexes on their leading column ──
  SELECT count(*) INTO v_n FROM pg_constraint
   WHERE contype = 'f' AND convalidated
     AND ((conrelid = 'public.pos_orders'::regclass AND conname = 'pos_orders_client_id_fkey'
           AND confrelid = 'public.clients'::regclass AND confdeltype = 'c')
       OR (conrelid = 'public.pos_order_items'::regclass AND conname = 'pos_order_items_client_id_fkey'
           AND confrelid = 'public.clients'::regclass AND confdeltype = 'c')
       OR (conrelid = 'public.pos_order_items'::regclass AND conname = 'pos_order_items_recipe_id_fkey'
           AND confrelid = 'public.recipes'::regclass AND confdeltype = 'a'));
  IF v_n <> 3 THEN
    RAISE EXCEPTION 'S819 4k: % of the 3 foreign keys are in place as written', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM pg_index ix
    JOIN pg_class ic ON ic.oid = ix.indexrelid
    JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = ix.indkey[0]
   WHERE ic.relname IN ('idx_pos_orders_open', 'idx_pos_orders_closed', 'idx_pos_kot_log_live', 'idx_pos_kot_log_cancelled')
     AND a.attname = 'client_id' AND ix.indisvalid;
  IF v_n <> 4 THEN
    RAISE EXCEPTION 'S819 4k: % of the 4 indexes are valid and lead with client_id', v_n;
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled <> 'D'
       AND ((tgrelid = 'public.pos_kot_log'::regclass AND tgname = 'guard_pos_kot_log')
         OR (tgrelid = 'public.pos_parking_slips'::regclass AND tgname = 'pos_parking_slips_guard'))) <> 2 THEN
    RAISE EXCEPTION 'S819 4k: a guard trigger is missing or disabled';
  END IF;

  -- ── Who acts: BLOOM CAFE (or the first POS outlet with an Owner), its Owner, the operator ──
  SELECT c.id, p.id INTO v_client, v_owner
    FROM public.clients c JOIN public.profiles p ON p.client_id = c.id
   WHERE c.pos_enabled AND COALESCE(p.active_client_id, p.client_id) = c.id
     AND p.role = 'client' AND p.pos_role IS NULL AND p.pos_email IS NULL
     AND p.ims_role IS NULL AND p.hr_role IS NULL AND NOT COALESCE(p.hr_self_service, false)
   ORDER BY (c.name = 'BLOOM CAFE') DESC, c.name, p.id LIMIT 1;
  SELECT p.id INTO v_admin FROM public.profiles p WHERE p.role = 'admin' ORDER BY p.id LIMIT 1;
  IF v_client IS NULL OR v_admin IS NULL THEN
    RAISE EXCEPTION 'S819 4k probe: no POS outlet with an Owner, or no operator login';
  END IF;

  BEGIN
    -- Setup, as the migration's own role (every guard lets it through): an open takeaway with one
    -- line on a test dish, and one ticket for it.
    INSERT INTO public.recipes (client_id, name) VALUES (v_client, 'S819 4k probe dish') RETURNING id INTO v_recipe;
    INSERT INTO public.pos_orders (client_id) VALUES (v_client) RETURNING id INTO v_order;
    INSERT INTO public.pos_order_items (order_id, client_id, name, recipe_id, qty, unit_price)
      VALUES (v_order, v_client, 'S819 4k probe dish', v_recipe, 1, 100);
    INSERT INTO public.pos_kot_log (client_id, order_id, station, items)
      VALUES (v_client, v_order, 'KOT', '[{"name": "S819 4k probe dish", "qty": 1}]'::jsonb)
      RETURNING id INTO v_ticket;

    -- (a) DATABASE-7: a dish on a bill cannot be deleted; a bill cannot name a client that does not exist.
    v_refused := false;
    BEGIN
      DELETE FROM public.recipes WHERE id = v_recipe;
    EXCEPTION WHEN foreign_key_violation THEN v_refused := true;
    END;
    IF NOT v_refused THEN
      RAISE EXCEPTION 'S819 4k probe: a dish on a bill line was deleted';
    END IF;
    v_refused := false;
    BEGIN
      INSERT INTO public.pos_orders (client_id) VALUES (gen_random_uuid());
    EXCEPTION WHEN foreign_key_violation THEN v_refused := true;
    END;
    IF NOT v_refused THEN
      RAISE EXCEPTION 'S819 4k probe: a bill was saved for a client that does not exist';
    END IF;

    -- From here on, the operator's own session.
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_admin)::text, true);
    SET LOCAL ROLE authenticated;

    -- (b) A Kitchen Display tap by support: the server's time, its own login, forward only.
    UPDATE public.pos_kot_log SET status = 'in_progress', started_at = '2001-01-01', estimated_prep_minutes = 9
     WHERE id = v_ticket;
    SELECT status, started_at, status_updated_by INTO v_row FROM public.pos_kot_log WHERE id = v_ticket;
    IF v_row.status IS DISTINCT FROM 'in_progress' OR v_row.started_at IS DISTINCT FROM now()
       OR v_row.status_updated_by IS DISTINCT FROM v_admin THEN
      RAISE EXCEPTION 'S819 4k probe: support''s Start kept % / % / %', v_row.status, v_row.started_at, v_row.status_updated_by;
    END IF;
    v_refused := false;
    BEGIN
      UPDATE public.pos_kot_log SET status = 'new' WHERE id = v_ticket;
    EXCEPTION WHEN insufficient_privilege THEN v_refused := true;
    END;
    IF NOT v_refused THEN
      RAISE EXCEPTION 'S819 4k probe: support moved a ticket backwards';
    END IF;
    v_refused := false;
    BEGIN
      UPDATE public.pos_kot_log SET items = '[]'::jsonb WHERE id = v_ticket;
    EXCEPTION WHEN insufficient_privilege THEN v_refused := true;
    END;
    IF NOT v_refused THEN
      RAISE EXCEPTION 'S819 4k probe: support rewrote what a ticket says';
    END IF;
    -- A delete is refused by the guard, or by a missing grant or policy; either way the ticket stays.
    BEGIN
      DELETE FROM public.pos_kot_log WHERE id = v_ticket;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;

    -- (c) A ticket support sends from a screen starts new, now, whatever was sent with it.
    INSERT INTO public.pos_kot_log (client_id, order_id, station, items, status, started_at)
      VALUES (v_client, v_order, 'KOT', '[{"name": "S819 4k probe dish", "qty": 1}]'::jsonb, 'served', '2001-01-01')
      RETURNING id INTO v_live;
    -- (d) The restore: a ticket dated before this transaction comes back as it was.
    INSERT INTO public.pos_kot_log (client_id, order_id, station, items, status, sent_at, served_at)
      VALUES (v_client, v_order, 'KOT', '[{"name": "S819 4k probe dish", "qty": 1}]'::jsonb, 'served', v_past, v_past)
      RETURNING id INTO v_restored;

    -- (e) A parking slip support issues from the screen is numbered, timed and signed by the server;
    -- a restored one comes back as it was.
    INSERT INTO public.pos_parking_slips (client_id, vehicle_number, slip_no, time_in, status, print_count)
      VALUES (v_client, 'S819 PROBE', 999998, '2001-01-01', 'closed', 7)
      RETURNING id INTO v_slip;
    INSERT INTO public.pos_parking_slips (client_id, vehicle_number, slip_no, time_in, created_at, status, print_count)
      VALUES (v_client, 'S819 OLD', 999997, v_past, v_past, 'closed', 2)
      RETURNING id INTO v_oldslip;

    -- (f) GAP-OPERATOR-3, as support: its own row reads Crest support.
    SELECT n.full_name INTO v_name FROM public.get_client_profile_names(v_client) n WHERE n.id = v_admin;
    IF v_name IS DISTINCT FROM 'Crest support' THEN
      RAISE EXCEPTION 'S819 4k probe: support sees itself as %', v_name;
    END IF;

    RESET ROLE;

    -- Results, read as the migration's role.
    IF NOT EXISTS (SELECT 1 FROM public.pos_kot_log WHERE id = v_ticket AND status = 'in_progress'
                   AND items @> '[{"name": "S819 4k probe dish"}]'::jsonb) THEN
      RAISE EXCEPTION 'S819 4k probe: support deleted or changed a ticket';
    END IF;
    SELECT status, started_at, sent_at, sent_by INTO v_row FROM public.pos_kot_log WHERE id = v_live;
    IF v_row.status IS DISTINCT FROM 'new' OR v_row.started_at IS NOT NULL OR v_row.sent_at IS DISTINCT FROM now()
       OR v_row.sent_by IS DISTINCT FROM v_admin THEN
      RAISE EXCEPTION 'S819 4k probe: support''s ticket was kept as % / % / % / %', v_row.status, v_row.started_at, v_row.sent_at, v_row.sent_by;
    END IF;
    SELECT status, sent_at INTO v_row FROM public.pos_kot_log WHERE id = v_restored;
    IF v_row.status IS DISTINCT FROM 'served' OR v_row.sent_at IS DISTINCT FROM v_past THEN
      RAISE EXCEPTION 'S819 4k probe: a restored ticket came back as % / %', v_row.status, v_row.sent_at;
    END IF;
    SELECT slip_no, time_in, status, print_count, issued_by INTO v_row FROM public.pos_parking_slips WHERE id = v_slip;
    IF v_row.slip_no = 999998 OR v_row.time_in IS DISTINCT FROM now() OR v_row.status IS DISTINCT FROM 'open'
       OR v_row.print_count <> 0 OR v_row.issued_by IS DISTINCT FROM v_admin THEN
      RAISE EXCEPTION 'S819 4k probe: support''s slip was kept as % / % / % / % / %', v_row.slip_no, v_row.time_in, v_row.status, v_row.print_count, v_row.issued_by;
    END IF;
    SELECT slip_no, status, print_count INTO v_row FROM public.pos_parking_slips WHERE id = v_oldslip;
    IF v_row.slip_no IS DISTINCT FROM 999997 OR v_row.status IS DISTINCT FROM 'closed' OR v_row.print_count <> 2 THEN
      RAISE EXCEPTION 'S819 4k probe: a restored slip came back as % / % / %', v_row.slip_no, v_row.status, v_row.print_count;
    END IF;

    -- (g) GAP-OPERATOR-3, as the Owner: support is named, the Owner keeps their own name.
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_owner)::text, true);
    SELECT n.full_name INTO v_name FROM public.get_client_profile_names(v_client) n WHERE n.id = v_admin;
    IF v_name IS DISTINCT FROM 'Crest support' THEN
      RAISE EXCEPTION 'S819 4k probe: the Owner sees support as %', v_name;
    END IF;
    SELECT n.full_name INTO v_name FROM public.get_client_profile_names(v_client) n WHERE n.id = v_owner;
    IF v_name IS DISTINCT FROM (SELECT p.full_name FROM public.profiles p WHERE p.id = v_owner) THEN
      RAISE EXCEPTION 'S819 4k probe: the Owner''s own name came back as %', v_name;
    END IF;
    SELECT count(*) INTO v_n FROM public.get_client_profile_names(v_client) n GROUP BY n.id HAVING count(*) > 1 LIMIT 1;
    IF v_n IS NOT NULL THEN
      RAISE EXCEPTION 'S819 4k probe: a login comes back twice';
    END IF;
    -- A caller of another client still gets nothing.
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', gen_random_uuid())::text, true);
    IF EXISTS (SELECT 1 FROM public.get_client_profile_names(v_client)) THEN
      RAISE EXCEPTION 'S819 4k probe: a session with no profile read this client''s names';
    END IF;
    PERFORM set_config('request.jwt.claims', '', true);

    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 's819_4k_probe_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 's819_4k_probe_rollback' THEN RAISE; END IF;
  END;
END;
$$;


-- ── 7. What this slice acts on, live (the last statement, so `db query` prints it) ────────────
SELECT
  (SELECT count(*) FROM public.pos_orders WHERE status = 'open') AS open_bills,
  (SELECT count(*) FROM public.pos_kot_log WHERE status IN ('new', 'in_progress', 'ready')) AS live_tickets,
  (SELECT count(*) FROM public.pos_orders o JOIN public.profiles p ON p.id = o.closed_by WHERE p.role = 'admin') AS bills_closed_by_support,
  (SELECT count(*) FROM public.pos_kot_log k JOIN public.profiles p ON p.id = k.sent_by WHERE p.role = 'admin') AS tickets_sent_by_support,
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.guard_pos_kot_log()'::regprocedure) AS kot_md5,
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.pos_parking_slips_guard()'::regprocedure) AS slip_md5,
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.get_client_profile_names(uuid)'::regprocedure) AS names_md5;

-- Read back after applying (one statement per call):
--   SELECT conname, convalidated, confdeltype FROM pg_constraint
--    WHERE conname IN ('pos_orders_client_id_fkey', 'pos_order_items_client_id_fkey', 'pos_order_items_recipe_id_fkey');
--     expect three rows, all validated; c, c, a.
--   SELECT indexname, indexdef FROM pg_indexes
--    WHERE indexname IN ('idx_pos_orders_open', 'idx_pos_orders_closed', 'idx_pos_kot_log_live', 'idx_pos_kot_log_cancelled');
--   SELECT p.proname, md5(prosrc), prosecdef, proacl FROM pg_proc p
--    WHERE p.oid IN ('public.guard_pos_kot_log()'::regprocedure, 'public.pos_parking_slips_guard()'::regprocedure,
--                    'public.get_client_profile_names(uuid)'::regprocedure);
--     expect the three hashes in section 0's second slots, prosecdef t / f / t, and the same proacl as before.
