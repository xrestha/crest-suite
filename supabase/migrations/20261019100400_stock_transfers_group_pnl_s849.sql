-- STATUS: complete (revised 2026-10-19 for "counts once the branch confirms"; §1b item reference list; review-migrations-2 N5/N7/N8 applied; draft, apply only after the owner's explicit "apply")
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- S849 PNL — Consolidated P&L fixes (S848 review PNL-1/2/3/8/11, ACCESS-1's P&L filter, ACCESS-8's
-- support view) and the new stock transfer between outlets (PNL-8, owner decision SU10 (a); receipt
-- confirmed by the branch, owner answer (b) of 2026-10-16).
--
-- APPLY ORDER: after the ACCESS cluster's migration (it defines public.client_suite_live(uuid), which
-- §2 calls; the pre-flight refuses to run without it), and BEFORE the GROUP cluster's migration (its
-- get_group_summary reads ims_stock_transfer_lines; GROUP's pre-flight refuses without it). So:
-- ACCESS → OR → OD → FORECAST → PNL → GROUP → ASSETS. When copied into supabase/migrations/, stamp it
-- after 20261018100000 (S850), which redefines nothing this file replaces or calls.
--
-- Objects:
--   §1  CREATE TABLE  public.ims_stock_transfers                  (header; + indexes, RLS, 4 policies, grants)
--       CREATE TABLE  public.ims_stock_transfer_lines             (lines that count; + indexes, RLS, 4 policies, grants)
--       CREATE FUNCTION public.guard_ims_stock_transfer_lines()   (trigger, INVOKER, on both tables)
--       CREATE TRIGGER  guard_ims_stock_transfers, audit_ims_stock_transfers                 (header)
--       CREATE TRIGGER  guard_ims_stock_transfer_lines, ims_item_same_client, audit_ims_stock_transfer_lines
--       CREATE FUNCTION public.stock_transfer_open_day(uuid)      (internal, VOLATILE, no browser grant)
--       CREATE FUNCTION public.send_stock_transfer(uuid, uuid, uuid, jsonb, text, boolean)
--       CREATE FUNCTION public.receive_stock_transfer(uuid)
--       CREATE FUNCTION public.end_stock_transfer(uuid, text, text)        (cancel / refuse)
--   §1b REPLACE the item reference list (same signatures, grants kept by CREATE OR REPLACE):
--       public.item_reference_counts(uuid[])  (+ ims_stock_transfer_lines; base 20260919120000)
--       public.force_delete_item(uuid)        (refuses a transferred item; base 20260919120000)
--       public.item_has_references(uuid)      (+ ims_stock_transfer_lines; base 20260928140000)
--   §2  DROP public.get_group_pnl(integer, integer); CREATE public.get_group_pnl(integer, integer, uuid)
--       (p_group_id DEFAULT NULL = the support view; return shape grows: 11 new columns; no overload left)
--   §3  ALTER TABLE public.feature_flags ADD COLUMN stock_transfers
--
-- Rollback, per object:
--   §1  Only while no transfer exists (SELECT count(*) FROM ims_stock_transfers = 0), and after §1b:
--       DROP FUNCTION public.end_stock_transfer(uuid, text, text);
--       DROP FUNCTION public.receive_stock_transfer(uuid);
--       DROP FUNCTION public.send_stock_transfer(uuid, uuid, uuid, jsonb, text, boolean);
--       DROP FUNCTION public.stock_transfer_open_day(uuid);
--       DROP TABLE public.ims_stock_transfer_lines; DROP TABLE public.ims_stock_transfers;
--         (each drops its triggers and policies; lines first, they reference the header)
--       DROP FUNCTION public.guard_ims_stock_transfer_lines();
--       Once transfers exist, dropping the table silently moves every affected outlet's stock figures
--       back to "the stock left with no record" — never do it without the owner.
--   §1b Re-run item_reference_counts and force_delete_item from 20260919120000 and item_has_references
--       from 20260928140000 (CREATE OR REPLACE; signatures unchanged) BEFORE dropping the table in §1:
--       the three bodies name it. itemRefTables.js rolls back with them.
--   §2  DROP FUNCTION public.get_group_pnl(integer, integer, uuid); then re-run its CREATE + the two
--       grant lines from 20261003120000_hr_labour2_s798.sql (the frontend must be rolled back with it:
--       the page reads the new columns by name and passes p_group_id in the support view).
--   §3  ALTER TABLE public.feature_flags DROP COLUMN stock_transfers;  (only together with the
--       frontend: FeatureAccessModal sends every DEFAULT_FLAGS key in one upsert).
--
-- Nothing here writes business data. There is no data clean-up section.
-- ════════════════════════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 0. Pre-flight ────────────────────────────────────────────────────────────────────────────────
DO $pre$
DECLARE
  v_md5 text;
BEGIN
  IF to_regprocedure('public.client_suite_live(uuid)') IS NULL THEN
    RAISE EXCEPTION 'S849 PNL pre-flight: public.client_suite_live(uuid) is missing. Apply the ACCESS migration first.';
  END IF;

  -- get_group_pnl must still be the 20261003120000 body (live md5 read on 2026-10-15, PNL.md).
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = to_regprocedure('public.get_group_pnl(integer,integer)');
  IF v_md5 IS DISTINCT FROM 'f0245bd9d1582ad176a062e39828d18d' THEN
    RAISE EXCEPTION 'S849 PNL pre-flight: get_group_pnl changed since 2026-10-15 (md5 %). Rebuild §2 from the live body.', v_md5;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace
              AND proname IN ('send_stock_transfer', 'receive_stock_transfer', 'end_stock_transfer',
                              'cancel_stock_transfer', 'stock_transfer_open_day', 'guard_ims_stock_transfer_lines')) THEN
    RAISE EXCEPTION 'S849 PNL pre-flight: a stock-transfer function already exists. Read it before re-running.';
  END IF;

  IF to_regclass('public.ims_stock_transfer_lines') IS NOT NULL OR to_regclass('public.ims_stock_transfers') IS NOT NULL THEN
    RAISE EXCEPTION 'S849 PNL pre-flight: a stock-transfer table already exists.';
  END IF;

  -- The support view adds a third parameter; nothing else may have created that signature already.
  IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'get_group_pnl'
               AND oid <> to_regprocedure('public.get_group_pnl(integer,integer)')) THEN
    RAISE EXCEPTION 'S849 PNL pre-flight: another get_group_pnl signature exists. Read it before re-running.';
  END IF;

  -- §1b replaces three bodies; each must still be the body this file was built from. md5 of prosrc,
  -- computed from the migration text on 2026-10-19 (the same computation reproduces get_group_pnl's
  -- live md5 above, so the live bodies were applied from those files byte for byte).
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = to_regprocedure('public.item_reference_counts(uuid[])');
  IF v_md5 IS DISTINCT FROM 'b97c46dc5108ce81bd0d5528c16a3639' THEN
    RAISE EXCEPTION 'S849 PNL pre-flight: item_reference_counts changed since 20260919120000 (md5 %). Rebuild §1b from the live body.', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = to_regprocedure('public.force_delete_item(uuid)');
  IF v_md5 IS DISTINCT FROM '5be65f50a4f12ef0eb21566524f5bc51' THEN
    RAISE EXCEPTION 'S849 PNL pre-flight: force_delete_item changed since 20260919120000 (md5 %). Rebuild §1b from the live body.', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = to_regprocedure('public.item_has_references(uuid)');
  IF v_md5 IS DISTINCT FROM 'd3443f36e24b9481e21079ce362d8734' THEN
    RAISE EXCEPTION 'S849 PNL pre-flight: item_has_references changed since 20260928140000 (md5 %). Rebuild §1b from the live body.', v_md5;
  END IF;

  -- Helpers this file calls, as their latest migrations define them.
  IF to_regprocedure('public.is_admin()') IS NULL
     OR to_regprocedure('public.my_client_id()') IS NULL
     OR to_regprocedure('public.is_client_owner()') IS NULL
     OR to_regprocedure('public.my_group_id()') IS NULL
     OR to_regprocedure('public.ims_caller_has_rank(text)') IS NULL
     OR to_regprocedure('public.ims_item_same_client()') IS NULL
     OR to_regprocedure('public.log_audit()') IS NULL
     OR to_regprocedure('public.is_hr_self_service()') IS NULL
     OR to_regprocedure('public.is_pos_pin_staff()') IS NULL
     OR to_regprocedure('public.is_hr_role_staff()') IS NULL
     OR to_regclass('public.bs_months') IS NULL
     OR to_regclass('public.client_groups') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'clients' AND column_name = 'ims_since') THEN
    RAISE EXCEPTION 'S849 PNL pre-flight: a helper this migration relies on is missing.';
  END IF;
END
$pre$;


-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- §1  Stock transfers between outlets of one group (PNL-8, SU10 (a); owner answer (b): the branch
--     confirms receipt)
-- ════════════════════════════════════════════════════════════════════════════════════════════════
--
-- THE INVARIANT: a row in ims_stock_transfer_lines exists only when it counts for that outlet's figures.
-- So every stock reader (periodCost, buildStockRows, variance, the summaries, get_group_pnl,
-- get_group_summary) sums the lines by direction per period_id and needs no notion of "pending".
--
--   send     → header 'on_the_way' + 'sent' lines (out) in the SENDER's open month, today.
--   receive  → 'received' lines (in) in the RECEIVER's open month, today; header 'received' (final).
--   cancel   (sender's manager / Owner) or refuse (receiver's supervisor+ / Owner), both with a reason,
--            only while on the way → 'returned' lines (in) in the SENDER's open month, today; header
--            'cancelled' / 'refused'. The stock is back at the sender.
--   After receipt nothing is reversed: a mistake is corrected by sending the stock back (a new transfer).
--   Neither the receipt nor the return may land in a month before the one the stock left in
--   (stock_transfer_receiver_behind / _sender_behind), so the on-the-way span is never negative.
--
-- WHO writes WHERE. Every write lands in exactly one outlet's books, and the caller must belong there:
-- the sender's supervisor+ writes the sender's lines; the receiver's supervisor+ writes the receiver's
-- lines (receive) or, still in the sender's group, the sender's returned lines (refuse); the sender's
-- manager writes its own returned lines (cancel); the Owner acts for outlets of their own group only
-- (my_group_id(), from the home outlet); the operator anywhere. All of it COALESCE'd whole.
--
-- While on the way the stock is in NEITHER outlet's figures: it left the sender (its 'sent' lines) and
-- has not reached the receiver. The header carries the plan (lines jsonb) so the receiver can see what
-- is coming, and the period rows of sending and of ending (sent_/ended_period_id), so the group P&L can
-- say what was on the way at a month's end (get_group_pnl.on_the_way_val). Those are read through the
-- period row, never the stored label, so a month relabel moves the note with the lines (review N5).
-- Lines per transfer: at most 500 (review N8).
--
-- Every line goes into an OPEN month only (the owner's rule: send needs the sender's month open,
-- receive needs the receiver's), dated today, or the open month's last day when that month has ended
-- and is not closed yet. No transfer function ever writes a line into a closed month, for anyone (the
-- operator included); only the operator's restore INSERT, which re-creates history, is not month-checked.
-- Raw items only: the page sends prep as the raw ingredients it was made from, because every COGS and
-- variance figure costs prep at that level. Same rate on every line of a transfer (the sender's
-- per_uom_rate frozen at sending), so sent, received and returned values are equal to the paisa.
--
-- Not a purchase and not a supplier return: nothing statutory or vendor-facing reads either table.
-- Written ONLY by send / receive / end_stock_transfer (SECURITY DEFINER), plus the operator's restore
-- (INSERT) and the service role's Danger Zone (admin-user-ops: this outlet's lines, then the transfers
-- it sent; a sister outlet's lines stay, unlinked, because that stock really moved).

-- ── The header: one row per transfer, readable by both outlets ──────────────────────────────────
-- client_id is the SENDER (so log_audit and the scoped layer work for the sender's view); the
-- receiver reads its incoming transfers through to_client_id. Deleting the sending client cascades its
-- headers; the receiver's lines then keep counting with transfer_id NULL (ON DELETE SET NULL below).
CREATE TABLE public.ims_stock_transfers (
  id               uuid PRIMARY KEY,
  client_id        uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  to_client_id     uuid REFERENCES public.clients(id) ON DELETE SET NULL,
  from_name        text NOT NULL,
  to_name          text NOT NULL,
  status           text NOT NULL CHECK (status IN ('on_the_way', 'received', 'cancelled', 'refused')),
  lines            jsonb NOT NULL CHECK (jsonb_typeof(lines) = 'array'),
  total_value      numeric NOT NULL CHECK (total_value > 0),
  note             text,
  sent_at          timestamptz NOT NULL DEFAULT now(),
  sent_bs_year     integer NOT NULL,
  sent_bs_month    integer NOT NULL CHECK (sent_bs_month BETWEEN 1 AND 12),
  sent_bs_day      integer NOT NULL CHECK (sent_bs_day BETWEEN 1 AND 32),
  -- S849 review N5: the month the 'sent' lines are in, as a period row. A month relabel (Owner,
  -- ims_monthly_periods_guard) moves the lines with their period; the stored sent_/ended_bs_* labels
  -- stay as recorded (display), and every figure and check reads the period row's CURRENT label.
  sent_period_id   uuid NOT NULL REFERENCES public.monthly_periods(id),
  sent_by          uuid,
  sent_by_name     text,
  ended_at         timestamptz,
  ended_bs_year    integer,
  ended_bs_month   integer CHECK (ended_bs_month BETWEEN 1 AND 12),
  ended_bs_day     integer CHECK (ended_bs_day BETWEEN 1 AND 32),
  -- The month the received / returned lines are in (the receiver's period for 'received', the
  -- sender's for 'cancelled' / 'refused'). SET NULL: deleting the receiving client removes its months
  -- and must not be refused by the sender's header; readers then fall back to the stored label.
  ended_period_id  uuid REFERENCES public.monthly_periods(id) ON DELETE SET NULL,
  ended_by         uuid,
  ended_by_name    text,
  end_reason       text,
  CONSTRAINT ims_stock_transfers_ended_pair
    CHECK (COALESCE((status = 'on_the_way') = (ended_at IS NULL), false)
           AND COALESCE((ended_at IS NULL) = (ended_bs_year IS NULL), false)),
  CONSTRAINT ims_stock_transfers_reason
    CHECK (COALESCE((status IN ('cancelled', 'refused')) = (end_reason IS NOT NULL), false)),
  CONSTRAINT ims_stock_transfers_not_self CHECK (to_client_id IS NULL OR to_client_id <> client_id),
  CONSTRAINT ims_stock_transfers_ended_period
    CHECK (COALESCE(status <> 'on_the_way' OR ended_period_id IS NULL, false))
);

COMMENT ON TABLE public.ims_stock_transfers IS
  'S849 (PNL-8): one row per stock transfer between two outlets of one group. client_id = the sender, to_client_id = the receiver. on_the_way → received (final) | cancelled (sender) | refused (receiver). lines = the plan at sending (sender item, receiving item, qty, rate). The stock figures read ims_stock_transfer_lines, never this table, except the group P&L''s on-the-way note.';

CREATE INDEX ims_stock_transfers_client_idx ON public.ims_stock_transfers (client_id, sent_at);
CREATE INDEX ims_stock_transfers_to_idx     ON public.ims_stock_transfers (to_client_id, status);

-- ── The lines: one row per item per leg, each counting for its own outlet ───────────────────────
CREATE TABLE public.ims_stock_transfer_lines (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id             uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  period_id             uuid NOT NULL REFERENCES public.monthly_periods(id),
  transfer_id           uuid REFERENCES public.ims_stock_transfers(id) ON DELETE SET NULL,
  leg                   text NOT NULL CHECK (leg IN ('sent', 'received', 'returned')),
  direction             text NOT NULL CHECK (direction IN ('out', 'in')),
  counterpart_client_id uuid,
  counterpart_name      text NOT NULL,
  bs_day                integer NOT NULL CHECK (bs_day BETWEEN 1 AND 32),
  item_id               uuid NOT NULL REFERENCES public.items(id),
  qty                   numeric NOT NULL CHECK (qty > 0),
  rate                  numeric NOT NULL CHECK (rate > 0),
  value                 numeric GENERATED ALWAYS AS (qty * rate) STORED,
  prep_label            text,
  created_by            uuid,
  created_by_name       text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ims_stock_transfer_lines_one_item UNIQUE (transfer_id, leg, item_id),
  CONSTRAINT ims_stock_transfer_lines_leg_direction
    CHECK (COALESCE((leg = 'sent') = (direction = 'out'), false))
);

COMMENT ON TABLE public.ims_stock_transfer_lines IS
  'S849 (PNL-8): stock transfer lines that COUNT for this outlet: sent (out, sender, at sending), received (in, receiver, at receipt), returned (in, sender, when a transfer on the way is cancelled or refused). value = qty × the sender''s rate frozen at sending. Every stock figure reads in like a purchase and out like a supplier return; VAT, payables and vendor reports never read it. A row exists only once it counts, so readers need no status filter. Written only by the stock-transfer functions.';

CREATE INDEX ims_stock_transfer_lines_period_idx   ON public.ims_stock_transfer_lines (period_id);
CREATE INDEX ims_stock_transfer_lines_client_idx   ON public.ims_stock_transfer_lines (client_id, created_at);
CREATE INDEX ims_stock_transfer_lines_transfer_idx ON public.ims_stock_transfer_lines (transfer_id);
CREATE INDEX ims_stock_transfer_lines_item_idx     ON public.ims_stock_transfer_lines (item_id);

-- RLS: one permissive FOR ALL per table, my_client_id() (never its body), every operand wrapped. The
-- header is readable by either outlet; a line only by its own outlet.
ALTER TABLE public.ims_stock_transfers      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ims_stock_transfer_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY ims_stock_transfers_all ON public.ims_stock_transfers
  TO authenticated
  USING (COALESCE(client_id = (SELECT public.my_client_id())
                  OR to_client_id = (SELECT public.my_client_id())
                  OR (SELECT public.is_admin()), false))
  WITH CHECK (COALESCE(client_id = (SELECT public.my_client_id()) OR (SELECT public.is_admin()), false));

CREATE POLICY ims_stock_transfer_lines_all ON public.ims_stock_transfer_lines
  TO authenticated
  USING (COALESCE(client_id = (SELECT public.my_client_id()) OR (SELECT public.is_admin()), false))
  WITH CHECK (COALESCE(client_id = (SELECT public.my_client_id()) OR (SELECT public.is_admin()), false));

-- The three staff-isolation families every IMS business table carries (S316 / S430). IMS staff are
-- NOT fenced: Stock Report, Variance and Stock Count read the lines at IMS staff/supervisor rank.
DO $do$
DECLARE
  v_t text;
BEGIN
  FOREACH v_t IN ARRAY ARRAY['ims_stock_transfers', 'ims_stock_transfer_lines'] LOOP
    EXECUTE format('CREATE POLICY no_self_service_accounts ON public.%I AS RESTRICTIVE FOR ALL USING (NOT public.is_hr_self_service()) WITH CHECK (NOT public.is_hr_self_service())', v_t);
    EXECUTE format('CREATE POLICY no_pos_pin_staff ON public.%I AS RESTRICTIVE FOR ALL USING (NOT public.is_pos_pin_staff()) WITH CHECK (NOT public.is_pos_pin_staff())', v_t);
    EXECUTE format('CREATE POLICY no_hr_role_staff ON public.%I AS RESTRICTIVE FOR ALL USING (NOT public.is_hr_role_staff()) WITH CHECK (NOT public.is_hr_role_staff())', v_t);
  END LOOP;
END
$do$;

-- Grants: read for every signed-in login (RLS narrows it), INSERT only so the operator's restore can
-- write (the guard refuses everyone else). No UPDATE / DELETE / TRUNCATE / REFERENCES / TRIGGER /
-- MAINTAIN for browser roles: the DEFINER functions write, and Danger Zone is the service role.
REVOKE ALL ON public.ims_stock_transfers, public.ims_stock_transfer_lines FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.ims_stock_transfers, public.ims_stock_transfer_lines TO authenticated;
GRANT ALL ON public.ims_stock_transfers, public.ims_stock_transfer_lines TO service_role;

-- The guard, one function on both tables: browser roles never write, except the operator's restore
-- INSERT. SECURITY INVOKER on the current_user seam, so the DEFINER functions (current_user = owner)
-- and the service role pass, as guard_profiles_privileged_columns() and the S843 receipt guards do.
-- A foreign-key action (lines.transfer_id SET NULL when a sender's header goes) runs as the table
-- owner, so a client deletion's cascade passes too.
-- A new line's month, and a new header's sending month, must be its own outlet's (every writer, the
-- operator's restore included):
-- ims_item_same_client checks the item, this checks the period. INSERT only: nothing updates a line
-- but the SET NULL above, and a cascade may already have removed the period it would look up.
-- Nested IFs: plpgsql resolves every NEW field an expression names, and the header has no period_id.
CREATE FUNCTION public.guard_ims_stock_transfer_lines()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $function$
BEGIN
  IF current_user IN ('anon', 'authenticated') THEN
    IF NOT (TG_OP = 'INSERT' AND COALESCE(public.is_admin(), false)) THEN
      RAISE EXCEPTION 'stock_transfer_rpc_only: a stock transfer is sent, received and cancelled from Stock Transfers only'
        USING ERRCODE = '42501', HINT = 'stock_transfer_rpc_only';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' AND TG_TABLE_NAME = 'ims_stock_transfer_lines' THEN
    IF NOT EXISTS (SELECT 1 FROM public.monthly_periods mp
                    WHERE mp.id = NEW.period_id AND mp.client_id = NEW.client_id) THEN
      RAISE EXCEPTION 'stock_transfer_period_other_client: a transfer line goes in a month of its own outlet'
        USING ERRCODE = '23503', HINT = 'stock_transfer_period_other_client';
    END IF;
  END IF;
  -- The header's sending month is the sender's own (review N5's period link, same rule).
  IF TG_OP = 'INSERT' AND TG_TABLE_NAME = 'ims_stock_transfers' THEN
    IF NOT EXISTS (SELECT 1 FROM public.monthly_periods mp
                    WHERE mp.id = NEW.sent_period_id AND mp.client_id = NEW.client_id) THEN
      RAISE EXCEPTION 'stock_transfer_period_other_client: a transfer is sent from a month of its own outlet'
        USING ERRCODE = '23503', HINT = 'stock_transfer_period_other_client';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.guard_ims_stock_transfer_lines() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER guard_ims_stock_transfers
  BEFORE INSERT OR UPDATE OR DELETE ON public.ims_stock_transfers
  FOR EACH ROW EXECUTE FUNCTION public.guard_ims_stock_transfer_lines();
CREATE TRIGGER guard_ims_stock_transfer_lines
  BEFORE INSERT OR UPDATE OR DELETE ON public.ims_stock_transfer_lines
  FOR EACH ROW EXECUTE FUNCTION public.guard_ims_stock_transfer_lines();

-- An item of another business can never ride on a line (the S792 trigger, 'client' kind).
CREATE TRIGGER ims_item_same_client
  BEFORE INSERT OR UPDATE OF item_id, client_id ON public.ims_stock_transfer_lines
  FOR EACH ROW EXECUTE FUNCTION public.ims_item_same_client('client');

-- Audit Log: both tables carry client_id, which log_audit() reads (the header under the sender).
CREATE TRIGGER audit_ims_stock_transfers
  AFTER INSERT OR DELETE OR UPDATE ON public.ims_stock_transfers
  FOR EACH ROW EXECUTE FUNCTION public.log_audit();
CREATE TRIGGER audit_ims_stock_transfer_lines
  AFTER INSERT OR DELETE OR UPDATE ON public.ims_stock_transfer_lines
  FOR EACH ROW EXECUTE FUNCTION public.log_audit();


-- ── stock_transfer_open_day: the outlet's open month and the day a line written now is dated ──────
-- Internal (no browser grant). The one OPEN period (monthly_periods allows one); the day is today in
-- Nepal, or the month's last day when the month has ended and is not closed yet. An open month that
-- has not started yet, or no open month, refuses: nothing is ever written into a closed month.
-- The period row is taken FOR SHARE, so a Close Period running at the same moment waits for this
-- transaction (and, if it committed first, the re-check finds the month closed and refuses). That
-- makes the function VOLATILE: Postgres refuses a row lock inside a STABLE function.
CREATE FUNCTION public.stock_transfer_open_day(
  p_client_id   uuid,
  OUT o_period_id uuid,
  OUT o_bs_year   integer,
  OUT o_bs_month  integer,
  OUT o_bs_day    integer)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Kathmandu')::date;
  v_start date;
  v_days  integer;
  v_name  text;
BEGIN
  SELECT mp.id, mp.bs_year, mp.bs_month, bm.ad_start, bm.days
    INTO o_period_id, o_bs_year, o_bs_month, v_start, v_days
    FROM monthly_periods mp
    JOIN bs_months bm ON bm.bs_year = mp.bs_year AND bm.bs_month = mp.bs_month
   WHERE mp.client_id = p_client_id AND mp.status = 'open'
   ORDER BY mp.bs_year DESC, mp.bs_month DESC
   LIMIT 1
   FOR SHARE OF mp;

  IF o_period_id IS NULL THEN
    SELECT c.name INTO v_name FROM clients c WHERE c.id = p_client_id;
    RAISE EXCEPTION 'stock_transfer_no_open_period: % has no open month in Inventory', COALESCE(v_name, 'That outlet')
      USING ERRCODE = '22023', HINT = 'stock_transfer_no_open_period';
  END IF;
  IF v_today < v_start THEN
    SELECT c.name INTO v_name FROM clients c WHERE c.id = p_client_id;
    RAISE EXCEPTION 'stock_transfer_month_ahead: % has opened a month that has not started yet', COALESCE(v_name, 'That outlet')
      USING ERRCODE = '22023', HINT = 'stock_transfer_month_ahead';
  END IF;
  o_bs_day := LEAST(v_today - v_start + 1, v_days);
END;
$function$;
REVOKE ALL ON FUNCTION public.stock_transfer_open_day(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.stock_transfer_open_day(uuid) TO service_role;


-- ── send_stock_transfer ──────────────────────────────────────────────────────────────────────────
-- p_lines: [{ "item_id": uuid, "qty": n, "prep_label": "from 5 kg Momo filling" }] — raw items of the
-- SENDING outlet, quantities in the item's own unit. Lines naming the same item are merged. A value
-- that is not a uuid / a plain positive number reads as missing (a per-line problem), never a raw cast
-- error.
-- Who: an Inventory supervisor or manager of the sending outlet (the outlet this login has selected),
-- the Owner (from that outlet), or the operator. p_dry_run = true returns the plan the write would apply
-- (per line: rate, value, the receiving item or the reason it cannot go) and writes nothing; the page
-- always previews first. A replayed p_transfer_id returns { replayed: true } and writes nothing (an id
-- already used by ANOTHER outlet's transfer is refused as stock_transfer_bad).
-- The sending item: the sender's own ACTIVE raw item (a hidden one is off its count sheet). The
-- receiving item: the receiver's active raw item sharing COALESCE(master_id, id), same unit.
-- The preview's `total` sums the 2-dp line values the preview shows; the header's total_value is the
-- exact Σ qty × rate, which equals Σ lines.value to the last digit (on_the_way_val reads it).
-- Refusals (HINT = code, worded by errorText.js; each raised before anything is written):
-- stock_transfer_bad, stock_transfer_too_many_lines, stock_transfer_rank, stock_transfer_not_sibling,
-- stock_transfer_no_inventory, stock_transfer_no_open_period, stock_transfer_month_ahead,
-- stock_transfer_empty, stock_transfer_lines_bad. Per-line problems in the plan: not_this_outlet,
-- hidden, prep, qty, no_rate, no_match, ambiguous, unit, same_item_twice.
CREATE FUNCTION public.send_stock_transfer(
  p_transfer_id    uuid,
  p_from_client_id uuid,
  p_to_client_id   uuid,
  p_lines          jsonb,
  p_note           text    DEFAULT NULL,
  p_dry_run        boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid    uuid := (SELECT auth.uid());
  v_dry    boolean := COALESCE(p_dry_run, false);
  v_from   record;
  v_to     record;
  v_day    record;
  v_note   text := NULLIF(left(btrim(COALESCE(p_note, '')), 500), '');
  v_plan   jsonb;
  v_count  integer;
  v_bad    integer;
  v_total  numeric;
  v_exact  numeric;
  v_name   text;
  v_status text;
  v_owner  uuid;
BEGIN
  IF p_transfer_id IS NULL OR p_from_client_id IS NULL OR p_to_client_id IS NULL THEN
    RAISE EXCEPTION 'stock_transfer_bad: a transfer needs its id, the sending outlet and the receiving outlet'
      USING ERRCODE = '22023', HINT = 'stock_transfer_bad';
  END IF;
  -- Review N8: at most 500 lines per transfer (each line is one row and one audit row per leg; a
  -- larger delivery goes as two transfers). Counted before anything is planned or written.
  IF jsonb_typeof(p_lines) = 'array' AND jsonb_array_length(p_lines) > 500 THEN
    RAISE EXCEPTION 'stock_transfer_too_many_lines: a transfer holds at most 500 lines (this one has %); send it as two', jsonb_array_length(p_lines)
      USING ERRCODE = '22023', HINT = 'stock_transfer_too_many_lines';
  END IF;

  -- Who: the operator, or an Inventory supervisor or manager of the SENDING outlet, which must be the
  -- outlet this login has selected (ims_caller_has_rank answers true for the Owner and refuses a count
  -- PIN and a blocked login). Wrapped whole: is_admin() and my_client_id() are NULL for a login with
  -- no profile, and NULL must refuse.
  IF NOT COALESCE(public.is_admin()
                  OR (p_from_client_id = public.my_client_id()
                      AND public.ims_caller_has_rank('supervisor')), false) THEN
    RAISE EXCEPTION 'stock_transfer_rank: stock is sent by an Inventory supervisor or manager of the sending outlet, or the Owner'
      USING ERRCODE = '42501', HINT = 'stock_transfer_rank';
  END IF;

  -- One request at a time per transfer id, so a retried send cannot be written twice.
  PERFORM pg_advisory_xact_lock(hashtextextended('stock_transfer:' || p_transfer_id::text, 0));
  IF NOT v_dry THEN
    SELECT t.status, t.client_id INTO v_status, v_owner FROM ims_stock_transfers t WHERE t.id = p_transfer_id;
    IF v_status IS NOT NULL THEN
      IF v_owner IS DISTINCT FROM p_from_client_id THEN
        RAISE EXCEPTION 'stock_transfer_bad: that transfer id is already used; reload Stock Transfers and send again'
          USING ERRCODE = '22023', HINT = 'stock_transfer_bad';
      END IF;
      RETURN jsonb_build_object('transfer_id', p_transfer_id, 'replayed', true, 'status', v_status);
    END IF;
  END IF;

  -- The two outlets: different, both in one group, the caller's own group unless operator.
  SELECT c.id, c.name, c.group_id, c.ims_enabled INTO v_from FROM clients c WHERE c.id = p_from_client_id;
  SELECT c.id, c.name, c.group_id, c.ims_enabled INTO v_to   FROM clients c WHERE c.id = p_to_client_id;
  IF v_from.id IS NULL OR v_to.id IS NULL OR v_from.id = v_to.id
     OR NOT COALESCE(v_from.group_id IS NOT NULL AND v_from.group_id = v_to.group_id, false)
     OR NOT COALESCE(public.is_admin() OR public.my_group_id() = v_from.group_id, false) THEN
    RAISE EXCEPTION 'stock_transfer_not_sibling: stock can only be sent to another outlet in the same group'
      USING ERRCODE = '42501', HINT = 'stock_transfer_not_sibling';
  END IF;
  -- NULL counts as on, as everywhere else (clients.ims_enabled DEFAULT true).
  IF v_from.ims_enabled IS FALSE OR v_to.ims_enabled IS FALSE THEN
    RAISE EXCEPTION 'stock_transfer_no_inventory: both outlets need Crest Inventory switched on'
      USING ERRCODE = '22023', HINT = 'stock_transfer_no_inventory';
  END IF;

  -- The sender's open month and today's day in it (refuses if there is none). The receiver's month is
  -- checked when it receives, not now: the stock is on the way until then.
  SELECT * INTO v_day FROM public.stock_transfer_open_day(v_from.id);

  -- The plan. Lines naming one item are merged. The receiving item is the one sharing
  -- COALESCE(master_id, id) (the owner's S800 rule, never a name match), not prep, same unit.
  -- A foreign item's name, unit, rate and receiving match are never echoed back.
  WITH raw AS (
    SELECT CASE WHEN btrim(e ->> 'item_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                THEN btrim(e ->> 'item_id')::uuid END                          AS item_id,
           CASE WHEN btrim(e ->> 'qty') ~ '^[0-9]{1,12}(\.[0-9]{1,6})?$'
                THEN btrim(e ->> 'qty')::numeric END                           AS qty,
           NULLIF(left(btrim(COALESCE(e ->> 'prep_label', '')), 200), '')      AS prep_label
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_lines) = 'array' THEN p_lines ELSE '[]'::jsonb END) e
  ),
  agg AS (
    SELECT r.item_id,
           sum(r.qty)                              AS qty,
           bool_or(r.qty IS NULL)                  AS qty_missing,
           string_agg(DISTINCT r.prep_label, '; ') AS prep_label
      FROM raw r
     GROUP BY r.item_id
  ),
  lined AS (
    SELECT a.item_id, a.qty, a.qty_missing, a.prep_label,
           (s.client_id = v_from.id)              AS mine,
           s.name                                 AS s_name,
           s.uom                                  AS s_uom,
           COALESCE(s.is_sub_recipe, false)       AS s_prep,
           (s.is_active IS DISTINCT FROM false)   AS s_active,
           s.per_uom_rate                         AS rate,
           m.n                                    AS matches,
           m.id                                   AS to_item_id,
           m.name                                 AS to_name,
           m.uom                                  AS to_uom
      FROM agg a
      LEFT JOIN items s ON s.id = a.item_id
      LEFT JOIN LATERAL (
        SELECT count(*)                             AS n,
               (array_agg(t.id   ORDER BY t.id))[1] AS id,
               (array_agg(t.name ORDER BY t.id))[1] AS name,
               (array_agg(t.uom  ORDER BY t.id))[1] AS uom
          FROM items t
         WHERE s.id IS NOT NULL
           AND t.client_id = v_to.id
           AND NOT COALESCE(t.is_sub_recipe, false)
           AND t.is_active IS DISTINCT FROM false   -- a hidden item is off the count sheet: stock put there is never counted
           AND COALESCE(t.master_id, t.id) = COALESCE(s.master_id, s.id)
      ) m ON true
  ),
  judged AS (
    SELECT l.*,
           count(*) OVER (PARTITION BY CASE WHEN l.matches = 1 THEN l.to_item_id END) AS to_dupes,
           CASE
             WHEN l.item_id IS NULL OR NOT COALESCE(l.mine, false)              THEN 'not_this_outlet'
             WHEN NOT l.s_active                                                THEN 'hidden'   -- review N7: off the sender's count sheet
             WHEN l.s_prep                                                      THEN 'prep'
             WHEN l.qty_missing OR l.qty IS NULL OR l.qty <= 0                  THEN 'qty'
             WHEN l.rate IS NULL OR l.rate <= 0                                 THEN 'no_rate'
             WHEN COALESCE(l.matches, 0) = 0                                    THEN 'no_match'
             WHEN l.matches > 1                                                 THEN 'ambiguous'
             WHEN lower(btrim(l.to_uom)) IS DISTINCT FROM lower(btrim(l.s_uom)) THEN 'unit'
           END AS problem0
      FROM lined l
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'item_id',    j.item_id,
           'name',       CASE WHEN j.mine THEN j.s_name END,
           'uom',        CASE WHEN j.mine THEN j.s_uom END,
           'qty',        j.qty,
           'rate',       CASE WHEN j.mine THEN j.rate END,
           'value',      CASE WHEN j.mine THEN round(COALESCE(j.qty * j.rate, 0), 2) ELSE 0 END,
           'prep_label', j.prep_label,
           'to_item_id', CASE WHEN j.mine AND j.matches = 1 THEN j.to_item_id END,
           'to_name',    CASE WHEN j.mine AND j.matches = 1 THEN j.to_name END,
           'problem',    COALESCE(j.problem0, CASE WHEN j.to_dupes > 1 THEN 'same_item_twice' END)
         ) ORDER BY j.s_name, j.item_id), '[]'::jsonb)
    INTO v_plan
    FROM judged j;

  SELECT count(*),
         count(*) FILTER (WHERE x ->> 'problem' IS NOT NULL),
         COALESCE(sum((x ->> 'value')::numeric), 0),
         COALESCE(sum((x ->> 'qty')::numeric * (x ->> 'rate')::numeric), 0)
    INTO v_count, v_bad, v_total, v_exact
    FROM jsonb_array_elements(v_plan) x;

  IF v_count = 0 THEN
    RAISE EXCEPTION 'stock_transfer_empty: add at least one item to send'
      USING ERRCODE = '22023', HINT = 'stock_transfer_empty';
  END IF;

  IF v_dry THEN
    RETURN jsonb_build_object('dry_run', true, 'ok', v_bad = 0, 'lines', v_plan, 'total', round(v_total, 2),
                              'from_name', v_from.name, 'to_name', v_to.name,
                              'sent_bs_year', v_day.o_bs_year, 'sent_bs_month', v_day.o_bs_month,
                              'sent_bs_day', v_day.o_bs_day);
  END IF;

  IF v_bad > 0 THEN
    RAISE EXCEPTION 'stock_transfer_lines_bad: % of the lines cannot be sent; preview the transfer to see why', v_bad
      USING ERRCODE = '22023', HINT = 'stock_transfer_lines_bad';
  END IF;

  SELECT p.full_name INTO v_name FROM profiles p WHERE p.id = v_uid;

  INSERT INTO ims_stock_transfers
         (id, client_id, to_client_id, from_name, to_name, status, lines, total_value, note,
          sent_at, sent_bs_year, sent_bs_month, sent_bs_day, sent_period_id, sent_by, sent_by_name)
  VALUES (p_transfer_id, v_from.id, v_to.id, v_from.name, v_to.name, 'on_the_way', v_plan, v_exact, v_note,
          now(), v_day.o_bs_year, v_day.o_bs_month, v_day.o_bs_day, v_day.o_period_id, v_uid, v_name);

  -- The stock leaves the sender now: its 'sent' lines count in the sender's open month.
  INSERT INTO ims_stock_transfer_lines
         (client_id, period_id, transfer_id, leg, direction, counterpart_client_id, counterpart_name,
          bs_day, item_id, qty, rate, prep_label, created_by, created_by_name)
  SELECT v_from.id, v_day.o_period_id, p_transfer_id, 'sent', 'out', v_to.id, v_to.name,
         v_day.o_bs_day, (x ->> 'item_id')::uuid, (x ->> 'qty')::numeric, (x ->> 'rate')::numeric,
         x ->> 'prep_label', v_uid, v_name
    FROM jsonb_array_elements(v_plan) x;

  RETURN jsonb_build_object('transfer_id', p_transfer_id, 'replayed', false, 'status', 'on_the_way',
                            'lines', v_count, 'total', round(v_total, 2),
                            'sent_bs_year', v_day.o_bs_year, 'sent_bs_month', v_day.o_bs_month,
                            'sent_bs_day', v_day.o_bs_day);
END;
$function$;

REVOKE ALL ON FUNCTION public.send_stock_transfer(uuid, uuid, uuid, jsonb, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.send_stock_transfer(uuid, uuid, uuid, jsonb, text, boolean) TO authenticated, service_role;


-- ── receive_stock_transfer ───────────────────────────────────────────────────────────────────────
-- Who: an Inventory supervisor or manager of the RECEIVING outlet (selected by this login), the Owner
-- of the group (from any of its outlets) while the receiver is still in the sender's group and the
-- Owner's, or the operator. The whole transfer is received at once, into the receiver's open month,
-- today, at the sender's frozen rate. Final: after this nothing is reversed.
-- Refusals: stock_transfer_bad, stock_transfer_not_found, stock_transfer_rank,
-- stock_transfer_not_on_the_way, stock_transfer_outlet_gone, stock_transfer_no_open_period,
-- stock_transfer_month_ahead, stock_transfer_receiver_behind, stock_transfer_item_changed.
-- A transfer already received returns { already: 'received' }.
-- Review N6, kept by decision: an outlet that has LEFT the sender's group can still receive stock sent
-- before it left, with its own supervisor's login: the receipt writes only its own books and the stock
-- did arrive. It also makes the transfer final, so the sender can no longer cancel it.
CREATE FUNCTION public.receive_stock_transfer(p_transfer_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid        uuid := (SELECT auth.uid());
  v_t          record;
  v_from_group uuid;
  v_to_group   uuid;
  v_day        record;
  v_bad        integer;
  v_name       text;
  v_sent_y     integer;
  v_sent_m     integer;
BEGIN
  IF p_transfer_id IS NULL THEN
    RAISE EXCEPTION 'stock_transfer_bad: which transfer?' USING ERRCODE = '22023', HINT = 'stock_transfer_bad';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('stock_transfer:' || p_transfer_id::text, 0));
  SELECT * INTO v_t FROM ims_stock_transfers t WHERE t.id = p_transfer_id FOR UPDATE;
  IF v_t.id IS NULL THEN
    RAISE EXCEPTION 'stock_transfer_not_found: that transfer does not exist'
      USING ERRCODE = '22023', HINT = 'stock_transfer_not_found';
  END IF;

  -- Who. The received lines land in the RECEIVER's books, so the Owner may receive only for an
  -- outlet in their own group that is still in the sender's group (an outlet that has left the group
  -- receives with its own login). Wrapped whole: is_admin(), is_client_owner(), my_group_id() and
  -- my_client_id() are each NULL for a login with no profile.
  SELECT c.group_id INTO v_from_group FROM clients c WHERE c.id = v_t.client_id;
  SELECT c.group_id INTO v_to_group   FROM clients c WHERE c.id = v_t.to_client_id;
  IF NOT COALESCE(public.is_admin()
                  OR (public.is_client_owner()
                      AND v_to_group IS NOT NULL AND v_to_group = v_from_group
                      AND public.my_group_id() = v_to_group)
                  OR (v_t.to_client_id = public.my_client_id() AND public.ims_caller_has_rank('supervisor')), false) THEN
    RAISE EXCEPTION 'stock_transfer_rank: stock is received by an Inventory supervisor or manager of the receiving outlet, or the Owner'
      USING ERRCODE = '42501', HINT = 'stock_transfer_rank';
  END IF;

  IF v_t.status = 'received' THEN
    RETURN jsonb_build_object('transfer_id', p_transfer_id, 'already', 'received');
  END IF;
  IF v_t.status <> 'on_the_way' THEN
    RAISE EXCEPTION 'stock_transfer_not_on_the_way: that transfer was % and can no longer be received', v_t.status
      USING ERRCODE = '22023', HINT = 'stock_transfer_not_on_the_way';
  END IF;
  IF v_t.to_client_id IS NULL THEN
    RAISE EXCEPTION 'stock_transfer_outlet_gone: the receiving outlet no longer exists; cancel the transfer'
      USING ERRCODE = '22023', HINT = 'stock_transfer_outlet_gone';
  END IF;

  -- The receiver's open month and today's day in it. It may not be a month before the sending month:
  -- the stock would then count at the receiver before it left the sender. The sending month is the
  -- CURRENT label of the period the sent lines are in (review N5: a relabel moves them), the stored
  -- label only if that period is gone.
  SELECT * INTO v_day FROM public.stock_transfer_open_day(v_t.to_client_id);
  SELECT mp.bs_year, mp.bs_month INTO v_sent_y, v_sent_m FROM monthly_periods mp WHERE mp.id = v_t.sent_period_id;
  v_sent_y := COALESCE(v_sent_y, v_t.sent_bs_year);
  v_sent_m := COALESCE(v_sent_m, v_t.sent_bs_month);
  IF (v_day.o_bs_year, v_day.o_bs_month) < (v_sent_y, v_sent_m) THEN
    RAISE EXCEPTION 'stock_transfer_receiver_behind: % is still on an earlier month than the one the stock was sent in; close that month first', v_t.to_name
      USING ERRCODE = '22023', HINT = 'stock_transfer_receiver_behind';
  END IF;

  -- Every receiving item must still be the receiver's own active raw item in the same unit.
  SELECT count(*) INTO v_bad
    FROM jsonb_array_elements(v_t.lines) x
    LEFT JOIN items i ON i.id = (x ->> 'to_item_id')::uuid
   WHERE i.id IS NULL
      OR i.client_id IS DISTINCT FROM v_t.to_client_id
      OR COALESCE(i.is_sub_recipe, false)
      OR i.is_active IS FALSE
      OR lower(btrim(i.uom)) IS DISTINCT FROM lower(btrim(x ->> 'uom'));
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'stock_transfer_item_changed: % of the items changed at the receiving outlet since sending; refuse it and send it again', v_bad
      USING ERRCODE = '22023', HINT = 'stock_transfer_item_changed';
  END IF;

  SELECT p.full_name INTO v_name FROM profiles p WHERE p.id = v_uid;

  -- The stock arrives now: the 'received' lines count in the receiver's open month.
  INSERT INTO ims_stock_transfer_lines
         (client_id, period_id, transfer_id, leg, direction, counterpart_client_id, counterpart_name,
          bs_day, item_id, qty, rate, prep_label, created_by, created_by_name)
  SELECT v_t.to_client_id, v_day.o_period_id, v_t.id, 'received', 'in', v_t.client_id, v_t.from_name,
         v_day.o_bs_day, (x ->> 'to_item_id')::uuid, (x ->> 'qty')::numeric, (x ->> 'rate')::numeric,
         x ->> 'prep_label', v_uid, v_name
    FROM jsonb_array_elements(v_t.lines) x;

  UPDATE ims_stock_transfers t
     SET status = 'received', ended_at = now(),
         ended_bs_year = v_day.o_bs_year, ended_bs_month = v_day.o_bs_month, ended_bs_day = v_day.o_bs_day,
         ended_period_id = v_day.o_period_id,
         ended_by = v_uid, ended_by_name = v_name
   WHERE t.id = v_t.id;

  RETURN jsonb_build_object('transfer_id', p_transfer_id, 'status', 'received',
                            'received_bs_year', v_day.o_bs_year, 'received_bs_month', v_day.o_bs_month,
                            'received_bs_day', v_day.o_bs_day);
END;
$function$;

REVOKE ALL ON FUNCTION public.receive_stock_transfer(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.receive_stock_transfer(uuid) TO authenticated, service_role;


-- ── end_stock_transfer: cancel (sender) or refuse (receiver), only while on the way ───────────────
-- p_action 'cancel': the sending outlet's Inventory manager, the Owner of the sender's group, or the
-- operator.
-- p_action 'refuse': the receiving outlet's Inventory supervisor or manager while it is still in the
-- sender's group (refusing writes the SENDER's books), the Owner of the sender's group, or the operator.
-- Both need a reason (3+ characters) and both put the stock back at the SENDER: 'returned' lines in the
-- sender's open month, today. A received transfer is final (send the stock back instead).
-- Refusals: stock_transfer_bad, stock_transfer_reason, stock_transfer_not_found, stock_transfer_rank,
-- stock_transfer_not_on_the_way, stock_transfer_no_open_period, stock_transfer_month_ahead,
-- stock_transfer_sender_behind, stock_transfer_item_hidden.
-- The same action repeated returns { already: <status> }.
CREATE FUNCTION public.end_stock_transfer(p_transfer_id uuid, p_action text, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid        uuid := (SELECT auth.uid());
  v_reason     text := NULLIF(left(btrim(COALESCE(p_reason, '')), 500), '');
  v_status     text;
  v_t          record;
  v_from_group uuid;
  v_to_group   uuid;
  v_day        record;
  v_name       text;
  v_sent_y     integer;
  v_sent_m     integer;
  v_hidden     text;
BEGIN
  IF p_transfer_id IS NULL OR p_action IS NULL OR p_action NOT IN ('cancel', 'refuse') THEN
    RAISE EXCEPTION 'stock_transfer_bad: say which transfer, and cancel or refuse'
      USING ERRCODE = '22023', HINT = 'stock_transfer_bad';
  END IF;
  IF v_reason IS NULL OR length(v_reason) < 3 THEN
    RAISE EXCEPTION 'stock_transfer_reason: say why the transfer is being %', CASE p_action WHEN 'cancel' THEN 'cancelled' ELSE 'refused' END
      USING ERRCODE = '22023', HINT = 'stock_transfer_reason';
  END IF;
  v_status := CASE p_action WHEN 'cancel' THEN 'cancelled' ELSE 'refused' END;

  PERFORM pg_advisory_xact_lock(hashtextextended('stock_transfer:' || p_transfer_id::text, 0));
  SELECT * INTO v_t FROM ims_stock_transfers t WHERE t.id = p_transfer_id FOR UPDATE;
  IF v_t.id IS NULL THEN
    RAISE EXCEPTION 'stock_transfer_not_found: that transfer does not exist'
      USING ERRCODE = '22023', HINT = 'stock_transfer_not_found';
  END IF;

  -- Who. The returned lines land in the SENDER's books, so the Owner must be of the sender's group,
  -- and a receiver may refuse only while it is still in the sender's group. Wrapped whole.
  SELECT c.group_id INTO v_from_group FROM clients c WHERE c.id = v_t.client_id;
  SELECT c.group_id INTO v_to_group   FROM clients c WHERE c.id = v_t.to_client_id;
  IF NOT COALESCE(public.is_admin()
                  OR (public.is_client_owner() AND v_from_group IS NOT NULL AND public.my_group_id() = v_from_group)
                  OR (p_action = 'cancel' AND v_t.client_id = public.my_client_id()
                      AND public.ims_caller_has_rank('manager'))
                  OR (p_action = 'refuse' AND v_t.to_client_id = public.my_client_id()
                      AND v_to_group IS NOT NULL AND v_to_group = v_from_group
                      AND public.ims_caller_has_rank('supervisor')), false) THEN
    RAISE EXCEPTION 'stock_transfer_rank: a transfer on the way is cancelled by the sending outlet''s Inventory manager or refused by the receiving outlet''s supervisor or manager, or by the Owner'
      USING ERRCODE = '42501', HINT = 'stock_transfer_rank';
  END IF;

  IF v_t.status = v_status THEN
    RETURN jsonb_build_object('transfer_id', p_transfer_id, 'already', v_status);
  END IF;
  IF v_t.status <> 'on_the_way' THEN
    RAISE EXCEPTION 'stock_transfer_not_on_the_way: that transfer was % and can no longer be cancelled or refused', v_t.status
      USING ERRCODE = '22023', HINT = 'stock_transfer_not_on_the_way';
  END IF;

  -- Back at the sender: its open month and today's day in it. Not a month before the sending month:
  -- a Reopen of an earlier month (the later one closed, none open) would otherwise put the stock
  -- back before it left, and the on-the-way span would run backwards.
  SELECT * INTO v_day FROM public.stock_transfer_open_day(v_t.client_id);
  SELECT mp.bs_year, mp.bs_month INTO v_sent_y, v_sent_m FROM monthly_periods mp WHERE mp.id = v_t.sent_period_id;
  v_sent_y := COALESCE(v_sent_y, v_t.sent_bs_year);   -- the period's CURRENT label (review N5)
  v_sent_m := COALESCE(v_sent_m, v_t.sent_bs_month);
  IF (v_day.o_bs_year, v_day.o_bs_month) < (v_sent_y, v_sent_m) THEN
    RAISE EXCEPTION 'stock_transfer_sender_behind: % has an earlier month open than the one the stock was sent in; it can come back once that month or a later one is open', v_t.from_name
      USING ERRCODE = '22023', HINT = 'stock_transfer_sender_behind';
  END IF;

  -- Review N7: the stock comes back onto the sender's items. Stock Count's sheet lists active items
  -- only (Stock.js reads hidden items for the Summary, never for entry), so stock returned onto an
  -- item hidden since sending could never be counted and would read as used at the month's close.
  -- Refused, naming the items; the sending outlet unhides them, then cancels or refuses again.
  SELECT string_agg(DISTINCT i.name, ', ' ORDER BY i.name) INTO v_hidden
    FROM jsonb_array_elements(v_t.lines) x
    JOIN items i ON i.id = (x ->> 'item_id')::uuid
   WHERE i.is_active IS FALSE;
  IF v_hidden IS NOT NULL THEN
    RAISE EXCEPTION 'stock_transfer_item_hidden: % is hidden at %; unhide it in Item Master there before the stock can go back', v_hidden, v_t.from_name
      USING ERRCODE = '22023', HINT = 'stock_transfer_item_hidden';
  END IF;

  SELECT p.full_name INTO v_name FROM profiles p WHERE p.id = v_uid;

  INSERT INTO ims_stock_transfer_lines
         (client_id, period_id, transfer_id, leg, direction, counterpart_client_id, counterpart_name,
          bs_day, item_id, qty, rate, prep_label, created_by, created_by_name)
  SELECT v_t.client_id, v_day.o_period_id, v_t.id, 'returned', 'in', v_t.to_client_id, v_t.to_name,
         v_day.o_bs_day, (x ->> 'item_id')::uuid, (x ->> 'qty')::numeric, (x ->> 'rate')::numeric,
         x ->> 'prep_label', v_uid, v_name
    FROM jsonb_array_elements(v_t.lines) x;

  UPDATE ims_stock_transfers t
     SET status = v_status, ended_at = now(),
         ended_bs_year = v_day.o_bs_year, ended_bs_month = v_day.o_bs_month, ended_bs_day = v_day.o_bs_day,
         ended_period_id = v_day.o_period_id,
         ended_by = v_uid, ended_by_name = v_name, end_reason = v_reason
   WHERE t.id = v_t.id;

  RETURN jsonb_build_object('transfer_id', p_transfer_id, 'status', v_status,
                            'returned_bs_year', v_day.o_bs_year, 'returned_bs_month', v_day.o_bs_month,
                            'returned_bs_day', v_day.o_bs_day);
END;
$function$;

REVOKE ALL ON FUNCTION public.end_stock_transfer(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.end_stock_transfer(uuid, text, text) TO authenticated, service_role;


-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- §1b  The item reference list learns the transfer lines (LEAD.md, TRANSFER: "SQL → PNL mig")
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- ims_stock_transfer_lines.item_id is a thirteenth plain foreign key to items(id): NO ACTION, like
-- purchase_entries, so a delete is refused, never cascaded. The list of those tables lives in
-- src/modules/ims/items/itemRefTables.js and, as its SQL twin, in the three functions below;
-- itemRefTables.test.js reads every migration's item FKs and the LATEST migration defining the first
-- two, so itemRefTables.js gains { table: 'ims_stock_transfer_lines', label: 'TR', name: 'Stock
-- Transfers', cascades: false } in the same release, in the same place as here: after stock_movements,
-- before purchase_entries. Nothing references the lines, so any place before items is a valid
-- dependency order.
--
--   item_reference_counts: Item Master's Used In badge and the BEFORE DELETE trigger. An item that was
--     sent, received or returned counts as referenced; without this a transferred item read unused and
--     its delete was then refused by the plain FK with a raw 23503. ims_items_guard's unit lock
--     (item_unit_locked) reads this function too, so a transferred item's unit is fixed (D5).
--   force_delete_item: REFUSES (force_delete_item_transferred) an item on any transfer line, or named
--     by a transfer still on the way, before anything is removed. Deleting one outlet's lines would
--     leave the other outlet's half of the same movement standing (stock out of nowhere, or into
--     nowhere), and cancelling a transfer on the way would then fail on the missing item. Hide is the
--     lossless way. The table stays in the clearing list so the twin matches itemRefTables.js (the test
--     compares the arrays); behind the refusal it always clears 0 rows.
--   item_has_references: push_master_data's unit lock for a BRANCH item (GROUP calls it, does not
--     redefine it). A branch item with only transfer lines keeps its unit too.
--
-- Bodies copied from the live definitions (md5 pinned in the pre-flight), changing only that.
-- Signatures and return types are unchanged, so CREATE OR REPLACE keeps the grants.

CREATE OR REPLACE FUNCTION public.item_reference_counts(p_ids uuid[])
RETURNS TABLE (ref_item_id uuid, ref_table text, ref_count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
  WITH scoped AS (
    SELECT i.id
      FROM items i
     WHERE i.id = ANY (p_ids)
       AND COALESCE(
             (select auth.uid()) IS NULL
             OR is_admin()
             OR i.client_id = my_client_id(),
             false)
  ), refs AS (
              SELECT 'vendor_returns'::text  AS t, x.item_id FROM vendor_returns      x JOIN scoped s ON s.id = x.item_id
    UNION ALL SELECT 'recipe_ingredients',      x.item_id FROM recipe_ingredients   x JOIN scoped s ON s.id = x.item_id
    UNION ALL SELECT 'pos_option_ingredients',  x.item_id FROM pos_option_ingredients x JOIN scoped s ON s.id = x.item_id
    UNION ALL SELECT 'requisition_lines',       x.item_id FROM requisition_lines    x JOIN scoped s ON s.id = x.item_id
    UNION ALL SELECT 'staff_meals',             x.item_id FROM staff_meals          x JOIN scoped s ON s.id = x.item_id
    UNION ALL SELECT 'wastages',                x.item_id FROM wastages             x JOIN scoped s ON s.id = x.item_id
    UNION ALL SELECT 'opening_stock',           x.item_id FROM opening_stock        x JOIN scoped s ON s.id = x.item_id
    UNION ALL SELECT 'closing_stock',           x.item_id FROM closing_stock        x JOIN scoped s ON s.id = x.item_id
    UNION ALL SELECT 'par_levels',              x.item_id FROM par_levels           x JOIN scoped s ON s.id = x.item_id
    UNION ALL SELECT 'purchase_order_items',    x.item_id FROM purchase_order_items x JOIN scoped s ON s.id = x.item_id
    UNION ALL SELECT 'stock_movements',         x.item_id FROM stock_movements      x JOIN scoped s ON s.id = x.item_id
    UNION ALL SELECT 'ims_stock_transfer_lines', x.item_id FROM ims_stock_transfer_lines x JOIN scoped s ON s.id = x.item_id
    UNION ALL SELECT 'purchase_entries',        x.item_id FROM purchase_entries     x JOIN scoped s ON s.id = x.item_id
  )
  SELECT r.item_id, r.t, count(*)::bigint
    FROM refs r
   GROUP BY r.item_id, r.t;
$fn$;

CREATE OR REPLACE FUNCTION public.force_delete_item(p_item_id uuid)
RETURNS TABLE (cleared_table text, rows_deleted integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_client uuid;
  v_tbl    text;
  v_n      integer;
BEGIN
  IF NOT COALESCE(is_admin(), false) THEN
    RAISE EXCEPTION 'force_delete_item_not_permitted: only a Crest operator can force-delete an item'
      USING ERRCODE = 'P0001',
            HINT = 'Hide the item instead — it keeps every record it is already on.';
  END IF;

  SELECT client_id INTO v_client FROM items WHERE id = p_item_id;
  IF v_client IS NULL THEN
    RAISE EXCEPTION 'force_delete_item_missing: that item no longer exists'
      USING ERRCODE = 'P0001',
            HINT = 'Reload Item Master — someone else may have deleted it already.';
  END IF;

  -- S849 (PNL-8): a stock transfer is one movement recorded at two outlets. Removing this outlet's
  -- half would leave the other outlet's half standing, and a transfer still on the way could no
  -- longer be cancelled (its return names this item). Refused before anything is removed.
  IF EXISTS (SELECT 1 FROM ims_stock_transfer_lines WHERE item_id = p_item_id)
     OR EXISTS (SELECT 1 FROM ims_stock_transfers t
                 WHERE t.status = 'on_the_way'
                   AND (t.lines @> jsonb_build_array(jsonb_build_object('item_id', p_item_id))
                        OR t.lines @> jsonb_build_array(jsonb_build_object('to_item_id', p_item_id)))) THEN
    RAISE EXCEPTION 'force_delete_item_transferred: that item was sent or received between outlets, so it cannot be force-deleted'
      USING ERRCODE = 'P0001',
            HINT = 'Hide the item instead — both outlets keep the transfer on their books.';
  END IF;

  -- itemRefTables.js order, which is a DEPENDENCY order and not a preference: vendor_returns
  -- references purchase_entries as well as items, so it must go first.
  FOREACH v_tbl IN ARRAY ARRAY[
    'vendor_returns', 'recipe_ingredients', 'pos_option_ingredients', 'requisition_lines', 'staff_meals', 'wastages',
    'opening_stock', 'closing_stock', 'par_levels', 'purchase_order_items', 'stock_movements',
    'ims_stock_transfer_lines', 'purchase_entries'
  ] LOOP
    EXECUTE format('DELETE FROM public.%I WHERE item_id = $1', v_tbl) USING p_item_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n > 0 THEN
      cleared_table := v_tbl;
      rows_deleted  := v_n;
      RETURN NEXT;
    END IF;
  END LOOP;

  -- SECURITY DEFINER, so current_user here is the function owner and the items trigger waves this
  -- through — as does guard_pos_option_edit on pos_option_ingredients. Nothing else can reach this.
  DELETE FROM items WHERE id = p_item_id;
  cleared_table := 'items';
  rows_deleted  := 1;
  RETURN NEXT;
END;
$fn$;

-- Owner-only EXECUTE stays as 20260928140000 left it (no grant back): called only from inside
-- push_master_data, a SECURITY DEFINER body running as the owner.
CREATE OR REPLACE FUNCTION public.item_has_references(p_item_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (SELECT 1 FROM vendor_returns         WHERE item_id = p_item_id)
      OR EXISTS (SELECT 1 FROM recipe_ingredients     WHERE item_id = p_item_id)
      OR EXISTS (SELECT 1 FROM pos_option_ingredients WHERE item_id = p_item_id)
      OR EXISTS (SELECT 1 FROM requisition_lines      WHERE item_id = p_item_id)
      OR EXISTS (SELECT 1 FROM staff_meals            WHERE item_id = p_item_id)
      OR EXISTS (SELECT 1 FROM wastages               WHERE item_id = p_item_id)
      OR EXISTS (SELECT 1 FROM opening_stock          WHERE item_id = p_item_id)
      OR EXISTS (SELECT 1 FROM closing_stock          WHERE item_id = p_item_id)
      OR EXISTS (SELECT 1 FROM par_levels             WHERE item_id = p_item_id)
      OR EXISTS (SELECT 1 FROM purchase_order_items   WHERE item_id = p_item_id)
      OR EXISTS (SELECT 1 FROM stock_movements        WHERE item_id = p_item_id)
      OR EXISTS (SELECT 1 FROM ims_stock_transfer_lines WHERE item_id = p_item_id)
      OR EXISTS (SELECT 1 FROM purchase_entries       WHERE item_id = p_item_id)
$$;
REVOKE ALL ON FUNCTION public.item_has_references(uuid) FROM PUBLIC;


-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- §2  get_group_pnl, rebuilt from its live body (20261003120000, md5 pinned above)
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- Changes, and only these:
--   · p_group_id uuid DEFAULT NULL (ACCESS-8, the support view): when given, the caller must be the
--     operator (is_admin, COALESCE'd; else 42501), an unknown id is P0002 (GROUP's contract), and the
--     group is p_group_id; when NULL, the Owner/admin
--     check and my_group_id() exactly as before. One signature: the two-argument one is dropped.
--   · included = client_suite_live(c.id) OR the outlet's consolidated_pnl flag (ACCESS-1 / PNL-9: the
--     twin of SuiteGate's `tierOk || overridden`; the end date and grace now count).
--   · purchases_val / returns_val also carry stock transfers in / out (PNL-8) — folded in so every
--     consumer that derives COGS from them (this page, GroupDashboard's withGroupCogs) is right without
--     a change; transfer_in_val / transfer_out_val repeat the two parts for display.
--   · has_closing = a closing row with a count (physical_qty IS NOT NULL), not any row (PNL-2).
--   · stock_items / uncounted_count / uncounted_val: uncountedItems.js's findUncountedItems in SQL (PNL-2).
--   · delivery_commission / delivery_unsettled: deliveryCommission.js's rule in SQL (PNL-1, SU3 (a)).
--   · depreciation_memo: Overheads' D23 memo in SQL — posted runs pro-rated by overlapping days (PNL-3).
--   · till_waiting_bills / till_waiting_notes: pos_ims_waiting_counts' rule (S831) for this month (PNL-11).
--   · on_the_way_val: stock this outlet SENT and that was neither received nor returned by the month's
--     end (sent month <= this month < ended month, read through the header's sent_/ended_period_id so
--     a relabel moves it with the lines, review N5). It is in no outlet's figures at that month end; the
--     page states it under the matrix (PNL-8, owner answer (b)).
-- The month's AD days come from bs_months, cut at Nepal midnight, as get_group_summary does (S809 3n).
-- A month bs_months does not hold (outside BS 2000–2087) returns NULL for the windowed columns.
-- Return columns and arguments grow, so DROP then CREATE, and the grants are restated.

DROP FUNCTION IF EXISTS public.get_group_pnl(integer, integer);

CREATE FUNCTION public.get_group_pnl(p_bs_year integer, p_bs_month integer, p_group_id uuid DEFAULT NULL)
 RETURNS TABLE(client_id uuid, client_name text, is_included boolean, has_period boolean, period_status text, revenue numeric, opening_val numeric, purchases_val numeric, returns_val numeric, wastage_val numeric, staff_meals_val numeric, closing_val numeric, has_closing boolean, labour_payroll numeric, labour_bucket numeric, overheads_val numeric, tax_fees_val numeric, labour_festival numeric, labour_incentive numeric, labour_settlement numeric, transfer_in_val numeric, transfer_out_val numeric, stock_items integer, uncounted_count integer, uncounted_val numeric, delivery_commission numeric, delivery_unsettled integer, depreciation_memo numeric, till_waiting_bills integer, till_waiting_notes integer, on_the_way_val numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_group    uuid;
  v_ad_start date;
  v_ad_end   date;
  v_from     timestamptz;
  v_to       timestamptz;
BEGIN
  -- Owner or admin, exactly as get_group_summary() since S617 (20260827140000). This function
  -- checked group MEMBERSHIP alone and called it authorisation, so any staff login of a grouped
  -- client -- a POS PIN waiter included -- could POST it and read every Suite outlet's revenue,
  -- COGS, labour and overheads. COALESCE on both: each returns NULL, not false, for a caller with
  -- no profile, and NOT(NULL OR NULL) never fires the branch (the S579/S630 fail-open shape).
  IF p_group_id IS NOT NULL THEN
    -- S849 (ACCESS-8): the support view. Crest support reads the group it names; nobody else may name
    -- a group. COALESCE'd: is_admin() is NULL for a login with no profile.
    IF NOT COALESCE(public.is_admin(), false) THEN
      RAISE EXCEPTION 'Not permitted: only Crest support can read a group by its id.'
        USING ERRCODE = '42501';
    END IF;
    -- The contract GROUP's three reads follow (mig-GROUP §7-§9): an unknown id is P0002, not 0 rows.
    IF NOT EXISTS (SELECT 1 FROM client_groups g WHERE g.id = p_group_id) THEN
      RAISE EXCEPTION 'That outlet group does not exist.' USING ERRCODE = 'P0002';
    END IF;
    v_group := p_group_id;
  ELSE
    IF NOT (COALESCE(public.is_admin(), false) OR COALESCE(public.is_client_owner(), false)) THEN
      RAISE EXCEPTION 'Not permitted: only an owner can see group figures.';
    END IF;

    v_group := public.my_group_id();
    IF v_group IS NULL THEN
      RAISE EXCEPTION 'Not permitted: you are not part of an outlet group.';
    END IF;
  END IF;

  -- S849: the BS month as AD days (inclusive) and as a Nepal-midnight window [v_from, v_to).
  SELECT bm.ad_start,
         bm.ad_start + bm.days - 1,
         bm.ad_start::timestamp AT TIME ZONE 'Asia/Kathmandu',
         (bm.ad_start + bm.days)::timestamp AT TIME ZONE 'Asia/Kathmandu'
    INTO v_ad_start, v_ad_end, v_from, v_to
    FROM bs_months bm
   WHERE bm.bs_year = p_bs_year AND bm.bs_month = p_bs_month;

  RETURN QUERY
  WITH outlets AS (
    -- S849 (ACCESS-1 / PNL-9): Suite live by its end date and grace (client_suite_live, the SQL twin
    -- of suiteLive), or this page's own feature flag, as SuiteGate decides for the outlet itself.
    SELECT c.id, c.name, c.ims_since,
           (COALESCE(public.client_suite_live(c.id), false)
            OR EXISTS (SELECT 1 FROM feature_flags ff
                        WHERE ff.client_id = c.id AND ff.consolidated_pnl IS TRUE)) AS included
      FROM clients c
     WHERE c.group_id = v_group
  ),
  per AS (
    SELECT o.id AS cid, mp.id AS period_id, mp.status
      FROM outlets o
      LEFT JOIN monthly_periods mp
        ON mp.client_id = o.id AND mp.bs_year = p_bs_year AND mp.bs_month = p_bs_month
  ),
  -- One row per bill per period: its single discount, and its gross over ALL lines.
  bill AS (
    SELECT pe.period_id,
           COALESCE(
             pe.purchase_group_id::text,
             COALESCE(pe.vendor_id::text, '') || '|' ||
             COALESCE(pe.invoice_ref, '')     || '|' ||
             COALESCE(pe.bs_day::text, '')
           )                                    AS bill_key,
           max(COALESCE(pe.discount_amount, 0)) AS discount,
           sum(pe.qty * pe.rate)                AS gross
      FROM purchase_entries pe
      JOIN per ON per.period_id = pe.period_id
     GROUP BY 1, 2
  ),
  -- S849 (PNL-2): each item's purchases in the period, qty and cost (net of its bill-discount share,
  -- D32 basis) — the per-item form of purchases_val below, for the uncounted-items gap.
  pline AS (
    SELECT pe.period_id, pe.item_id,
           sum(pe.qty) AS qty,
           sum((pe.qty * pe.rate
                - COALESCE(b.discount, 0) * (pe.qty * pe.rate) / NULLIF(b.gross, 0))
               * CASE WHEN COALESCE(pe.vat_inclusive, false) AND pe.vat_is_cost THEN 1.13 ELSE 1 END) AS cost
      FROM purchase_entries pe
      JOIN per ON per.period_id = pe.period_id
      LEFT JOIN bill b
        ON b.period_id = pe.period_id
       AND b.bill_key  = COALESCE(
             pe.purchase_group_id::text,
             COALESCE(pe.vendor_id::text, '') || '|' ||
             COALESCE(pe.invoice_ref, '')     || '|' ||
             COALESCE(pe.bs_day::text, '')
           )
     GROUP BY pe.period_id, pe.item_id
  ),
  -- S849 (PNL-8): stock transfer lines per item in the period (sent = out; received and returned =
  -- in), valued at their own frozen rate. A line exists only once it counts, so no status filter.
  tline AS (
    SELECT tl.period_id, tl.item_id,
           COALESCE(sum(tl.qty)   FILTER (WHERE tl.direction = 'in'),  0) AS in_qty,
           COALESCE(sum(tl.value) FILTER (WHERE tl.direction = 'in'),  0) AS in_cost,
           COALESCE(sum(tl.value) FILTER (WHERE tl.direction = 'out'), 0) AS out_cost
      FROM ims_stock_transfer_lines tl
      JOIN per ON per.period_id = tl.period_id
     GROUP BY tl.period_id, tl.item_id
  ),
  tsum AS (
    SELECT t.period_id, sum(t.in_cost) AS t_in, sum(t.out_cost) AS t_out
      FROM tline t
      JOIN items i ON i.id = t.item_id AND NOT i.is_sub_recipe  -- S792 (D29): hidden items keep their history
     GROUP BY t.period_id
  ),
  -- S849 (PNL-2): presence = an active raw item with an opening quantity or bought / received
  -- quantity above 0; counted = a closing row whose physical_qty is not null (a 0 is a count);
  -- value = opening × today's rate + what it cost to bring in. findUncountedItems' rule.
  stock_rows AS (
    SELECT x.period_id, x.item_id,
           sum(x.open_qty) AS open_qty, sum(x.in_qty) AS in_qty, sum(x.in_cost) AS in_cost
      FROM (
        SELECT os.period_id, os.item_id, os.qty AS open_qty, 0::numeric AS in_qty, 0::numeric AS in_cost
          FROM opening_stock os
          JOIN per ON per.period_id = os.period_id
        UNION ALL
        SELECT pl.period_id, pl.item_id, 0, pl.qty, pl.cost FROM pline pl
        UNION ALL
        SELECT t.period_id, t.item_id, 0, t.in_qty, t.in_cost FROM tline t WHERE t.in_qty > 0
      ) x
     GROUP BY x.period_id, x.item_id
  ),
  gap AS (
    SELECT g.period_id,
           count(*)                                         AS gap_items,
           count(*) FILTER (WHERE NOT g.counted)            AS gap_uncounted,
           COALESCE(sum(g.cost) FILTER (WHERE NOT g.counted), 0) AS gap_value
      FROM (
        SELECT sr.period_id,
               COALESCE(sr.open_qty, 0) * COALESCE(i.per_uom_rate, 0) + COALESCE(sr.in_cost, 0) AS cost,
               EXISTS (SELECT 1 FROM closing_stock cs
                        WHERE cs.period_id = sr.period_id AND cs.item_id = sr.item_id
                          AND cs.physical_qty IS NOT NULL) AS counted
          FROM stock_rows sr
          JOIN items i ON i.id = sr.item_id AND NOT i.is_sub_recipe AND i.is_active IS DISTINCT FROM false
         WHERE COALESCE(sr.open_qty, 0) > 0 OR COALESCE(sr.in_qty, 0) > 0
      ) g
     GROUP BY g.period_id
  ),
  -- S849 (PNL-1, SU3 (a)): delivery-partner commission on the bills SOLD this BS month. Per bill: its
  -- uncancelled receipt lines' commission when it has any receipt line (S843), else the commission
  -- recorded on the bill (settled before S843). deliveryCommission.js is the JS copy.
  dbill AS (
    SELECT po.client_id AS cid, po.id, po.credit_settled_at, po.credit_note_id, po.commission_amount
      FROM pos_orders po
      JOIN outlets o ON o.id = po.client_id AND o.included
     WHERE v_from IS NOT NULL
       AND po.delivery_partner IS NOT NULL
       AND po.status = 'billed'
       AND po.close_type = 'paid'
       AND po.closed_at >= v_from
       AND po.closed_at <  v_to
  ),
  dcomm AS (
    SELECT d.cid,
           sum(CASE WHEN EXISTS (SELECT 1 FROM pos_credit_receipt_lines l WHERE l.order_id = d.id)
                    THEN COALESCE((SELECT sum(l.commission)
                                     FROM pos_credit_receipt_lines l
                                     JOIN pos_credit_receipts r ON r.id = l.receipt_id AND r.cancelled_at IS NULL
                                    WHERE l.order_id = d.id), 0)
                    ELSE COALESCE(d.commission_amount, 0)
               END) AS comm,
           count(*) FILTER (WHERE d.credit_settled_at IS NULL AND d.credit_note_id IS NULL) AS unsettled
      FROM dbill d
     GROUP BY d.cid
  ),
  -- S849 (PNL-3, SU19): posted depreciation overlapping the month, pro-rated by overlapping days —
  -- Overheads' loadDepreciationMemo / depreciationInWindow. A memo: never subtracted.
  depr AS (
    SELECT s.client_id AS cid,
           round(sum(COALESCE(s.override_amount, s.depreciation_amount)
                     * (LEAST(s.period_end, v_ad_end) - GREATEST(s.period_start, v_ad_start) + 1)::numeric
                     / NULLIF(s.period_end - s.period_start + 1, 0)), 2) AS amount
      FROM assets_depreciation_schedule s
      JOIN outlets o ON o.id = s.client_id AND o.included
     WHERE v_ad_start IS NOT NULL
       AND s.is_posted
       AND s.period_start <= v_ad_end
       AND s.period_end   >= v_ad_start
     GROUP BY s.client_id
  ),
  -- S849 (PNL-11): till bills and credit notes of this month still waiting for Inventory —
  -- pos_ims_waiting_counts' rule (20261013190000), for one month: billed, not posted, closed on or
  -- after the outlet's Inventory start, no sales row yet.
  waiting AS (
    SELECT w.cid, sum(w.b) AS bills, sum(w.n) AS notes
      FROM (
        SELECT po.client_id AS cid, 1 AS b, 0 AS n
          FROM pos_orders po
          JOIN outlets o ON o.id = po.client_id AND o.included
         WHERE v_from IS NOT NULL
           AND po.status = 'billed'
           AND po.ims_posted_at IS NULL
           AND (o.ims_since IS NULL OR po.closed_at >= o.ims_since)
           AND po.closed_at >= v_from
           AND po.closed_at <  v_to
           AND NOT EXISTS (SELECT 1 FROM sales_entries s WHERE s.pos_order_id = po.id)
        UNION ALL
        SELECT cn.client_id, 0, 1
          FROM pos_credit_notes cn
          JOIN outlets o ON o.id = cn.client_id AND o.included
         WHERE v_from IS NOT NULL
           AND cn.ims_posted_at IS NULL
           AND cn.created_at >= v_from
           AND cn.created_at <  v_to
           AND NOT EXISTS (SELECT 1 FROM pos_orders bo WHERE bo.id = cn.order_id AND bo.closed_at < o.ims_since)
           AND NOT EXISTS (SELECT 1 FROM sales_entries s WHERE s.pos_credit_note_id = cn.id)
      ) w
     GROUP BY w.cid
  ),
  -- S849 (PNL-8, owner answer (b)): stock this outlet sent that was still on the way at the month's
  -- end — sent in this month or before, received / returned after it or not yet. The months are the
  -- CURRENT labels of the periods the lines are in (review N5: a relabel moves the lines with their
  -- period); the stored labels only when that period row is gone (a deleted receiving client).
  way AS (
    SELECT t.client_id AS cid, sum(t.total_value) AS amount
      FROM ims_stock_transfers t
      JOIN outlets o ON o.id = t.client_id AND o.included
      LEFT JOIN monthly_periods sp ON sp.id = t.sent_period_id
      LEFT JOIN monthly_periods ep ON ep.id = t.ended_period_id
     WHERE (COALESCE(sp.bs_year, t.sent_bs_year), COALESCE(sp.bs_month, t.sent_bs_month)) <= (p_bs_year, p_bs_month)
       AND (t.status = 'on_the_way'
            OR (COALESCE(ep.bs_year, t.ended_bs_year), COALESCE(ep.bs_month, t.ended_bs_month)) > (p_bs_year, p_bs_month))
     GROUP BY t.client_id
  )
  SELECT
    o.id,
    o.name,
    o.included,
    (per.period_id IS NOT NULL),
    per.status,
    CASE WHEN o.included THEN COALESCE((
      SELECT sum(se.qty_sold * COALESCE(se.unit_price, r.selling_price, 0) - COALESCE(se.discount, 0))
        FROM sales_entries se JOIN recipes r ON r.id = se.recipe_id
       WHERE se.period_id = per.period_id AND se.source IS DISTINCT FROM 'pos_comp'  -- NULL-safe: a legacy row predates the column
    ), 0) END,
    CASE WHEN o.included THEN COALESCE((
      SELECT sum(os.qty * COALESCE(i.per_uom_rate, 0))
        FROM opening_stock os
        JOIN items i ON i.id = os.item_id AND NOT i.is_sub_recipe  -- S792 (D29): hidden items keep their history
       WHERE os.period_id = per.period_id
    ), 0) END,
    -- purchases_val: gross line value LESS this line's proportional share of its bill's discount,
    -- then on the COST basis (D32): × 1.13 on a VAT line of a vat_is_cost (PAN-bill) bill.
    -- S849 (PNL-8): plus stock transferred IN at its own rate (transfer_in_val repeats that part).
    CASE WHEN o.included THEN COALESCE((
      SELECT sum(
               (pe.qty * pe.rate
                - COALESCE(b.discount, 0) * (pe.qty * pe.rate) / NULLIF(b.gross, 0))
               * CASE WHEN COALESCE(pe.vat_inclusive, false) AND pe.vat_is_cost THEN 1.13 ELSE 1 END  -- D32
             )
        FROM purchase_entries pe
        JOIN items i ON i.id = pe.item_id AND NOT i.is_sub_recipe  -- S792 (D29): hidden items keep their history
        LEFT JOIN bill b
          ON b.period_id = pe.period_id
         AND b.bill_key  = COALESCE(
               pe.purchase_group_id::text,
               COALESCE(pe.vendor_id::text, '') || '|' ||
               COALESCE(pe.invoice_ref, '')     || '|' ||
               COALESCE(pe.bs_day::text, '')
             )
       WHERE pe.period_id = per.period_id
    ), 0) + COALESCE(ts.t_in, 0) END,
    -- returns_val: list value, on the basis of the line it went back against (D32). An unlinked
    -- return (no line) stays ex-VAT, as periodCost.js's returnCostValue does.
    -- S849 (PNL-8): plus stock transferred OUT at its own rate (transfer_out_val repeats that part).
    CASE WHEN o.included THEN COALESCE((
      SELECT sum(vr.qty * vr.rate
                 * CASE WHEN COALESCE(lp.vat_inclusive, false) AND COALESCE(lp.vat_is_cost, false) THEN 1.13 ELSE 1 END)  -- D32
        FROM vendor_returns vr
        JOIN items i ON i.id = vr.item_id AND NOT i.is_sub_recipe  -- S792 (D29): hidden items keep their history
        LEFT JOIN purchase_entries lp ON lp.id = vr.purchase_entry_id  -- D32
       WHERE vr.period_id = per.period_id
    ), 0) + COALESCE(ts.t_out, 0) END,
    CASE WHEN o.included THEN COALESCE((
      SELECT sum(w.qty * COALESCE(i.per_uom_rate, 0))
        FROM wastages w
        JOIN items i ON i.id = w.item_id AND NOT i.is_sub_recipe  -- S792 (D29): hidden items keep their history
       WHERE w.period_id = per.period_id
    ), 0) END,
    CASE WHEN o.included THEN COALESCE((
      SELECT sum(sm.qty * COALESCE(i.per_uom_rate, 0))
        FROM staff_meals sm
        JOIN items i ON i.id = sm.item_id AND NOT i.is_sub_recipe  -- S792 (D29): hidden items keep their history
       WHERE sm.period_id = per.period_id
    ), 0) END,
    CASE WHEN o.included THEN COALESCE((
      SELECT sum(cs.physical_qty * COALESCE(i.per_uom_rate, 0))
        FROM closing_stock cs
        JOIN items i ON i.id = cs.item_id AND NOT i.is_sub_recipe  -- S792 (D29): hidden items keep their history
       WHERE cs.period_id = per.period_id
    ), 0) END,
    -- S849 (PNL-2): a count, not a row — a closing row with a blank count is not a count.
    CASE WHEN o.included THEN EXISTS (
      SELECT 1 FROM closing_stock cs WHERE cs.period_id = per.period_id AND cs.physical_qty IS NOT NULL
    ) ELSE false END,
    CASE WHEN o.included THEN (
      -- S798 3c (H19): pay EARNED — gross less the absence deduction — as payrollLabourTotal.
      SELECT sum(ps.gross - COALESCE(ps.absence_deduction, 0) + COALESCE(ps.ot_amount, 0) + COALESCE(ps.ssf_employer, 0))
        FROM hr_payslips ps JOIN hr_payroll_runs pr ON pr.id = ps.run_id
       WHERE pr.client_id = o.id AND pr.period_id = per.period_id AND pr.status = 'finalized'
    ) END,
    CASE WHEN o.included THEN COALESCE((
      SELECT sum(oh.amount) FROM overheads oh
       WHERE oh.period_id = per.period_id AND COALESCE(oh.bucket, 'overhead') = 'labor'
    ), 0) END,
    CASE WHEN o.included THEN COALESCE((
      SELECT sum(oh.amount) FROM overheads oh
       WHERE oh.period_id = per.period_id AND COALESCE(oh.bucket, 'overhead') = 'overhead'
    ), 0) END,
    CASE WHEN o.included THEN COALESCE((
      SELECT sum(oh.amount) FROM overheads oh
       WHERE oh.period_id = per.period_id AND COALESCE(oh.bucket, 'overhead') = 'tax_fees'
    ), 0) END,
    -- S798 3c (H18): labour paid outside the monthly run, in the month it is paid — labourSource.js's
    -- otherLabourTotals(), which groupOutletLabour adds to labour_payroll. Finalized rows only, and
    -- only for an outlet with a period that month, as every other figure in this row needs one.
    CASE WHEN o.included THEN COALESCE((
      SELECT sum(fa.amount) FROM hr_festival_allowances fa
       WHERE per.period_id IS NOT NULL AND fa.client_id = o.id AND fa.status = 'finalized'
         AND fa.bs_year = p_bs_year AND fa.bs_month = p_bs_month
    ), 0) END,
    CASE WHEN o.included THEN COALESCE((
      SELECT sum(hi.amount) FROM hr_incentives hi
       WHERE per.period_id IS NOT NULL AND hi.client_id = o.id AND hi.status = 'finalized'
         AND hi.bs_year = p_bs_year AND hi.bs_month = p_bs_month
    ), 0) END,
    -- A Final Settlement by the month it was settled: the part-month salary (already gross − unpaid
    -- days + overtime), employer SSF, leave encashment, festival share, notice pay and gratuity, less
    -- the notice deduction the business keeps. Travel claims are reimbursement, not labour.
    -- settlementLabourCost() is the JS copy; a settlement with no settle month (pre-S752) is in no month.
    CASE WHEN o.included THEN COALESCE((
      SELECT sum(COALESCE(fs.partial_salary, 0) + COALESCE(fs.month_ssf_employer, 0) + COALESCE(fs.leave_encashment, 0)
                 + COALESCE(fs.festival_pro, 0) + COALESCE(fs.notice_pay, 0) + COALESCE(fs.gratuity, 0)
                 - COALESCE(fs.notice_deduction, 0))
        FROM hr_final_settlements fs
       WHERE per.period_id IS NOT NULL AND fs.client_id = o.id AND fs.status = 'finalized'
         AND fs.settle_bs_year = p_bs_year AND fs.settle_bs_month = p_bs_month
    ), 0) END,
    -- S849 (PNL-8): the transfer parts of purchases_val / returns_val, for display.
    CASE WHEN o.included THEN COALESCE(ts.t_in, 0) END,
    CASE WHEN o.included THEN COALESCE(ts.t_out, 0) END,
    -- S849 (PNL-2): the uncounted-items gap; the page applies isMaterialGap() with its own COGS.
    CASE WHEN o.included THEN COALESCE(g.gap_items, 0)::integer END,
    CASE WHEN o.included THEN COALESCE(g.gap_uncounted, 0)::integer END,
    CASE WHEN o.included THEN COALESCE(g.gap_value, 0) END,
    -- S849 (PNL-1): commission, and the month's delivery bills not settled yet. NULL outside bs_months.
    CASE WHEN o.included AND per.period_id IS NOT NULL AND v_from IS NOT NULL THEN COALESCE(dc.comm, 0) END,
    CASE WHEN o.included AND per.period_id IS NOT NULL AND v_from IS NOT NULL THEN COALESCE(dc.unsettled, 0)::integer END,
    -- S849 (PNL-3): the depreciation memo. NULL outside bs_months.
    CASE WHEN o.included AND per.period_id IS NOT NULL AND v_ad_start IS NOT NULL THEN COALESCE(dp.amount, 0) END,
    -- S849 (PNL-11): waiting till bills / credit notes dated in the month, period or not (a missing
    -- period is one reason a bill waits). NULL outside bs_months.
    CASE WHEN o.included AND v_from IS NOT NULL THEN COALESCE(wt.bills, 0)::integer END,
    CASE WHEN o.included AND v_from IS NOT NULL THEN COALESCE(wt.notes, 0)::integer END,
    -- S849 (PNL-8): value on the way between outlets at the month's end, by sender.
    CASE WHEN o.included THEN round(COALESCE(way.amount, 0), 2) END
  FROM outlets o
  JOIN per ON per.cid = o.id
  LEFT JOIN tsum    ts ON ts.period_id = per.period_id
  LEFT JOIN gap     g  ON g.period_id  = per.period_id
  LEFT JOIN dcomm   dc ON dc.cid = o.id
  LEFT JOIN depr    dp ON dp.cid = o.id
  LEFT JOIN waiting wt ON wt.cid = o.id
  LEFT JOIN way        ON way.cid = o.id
  ORDER BY o.name;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_group_pnl(integer, integer, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_group_pnl(integer, integer, uuid) FROM anon;
GRANT  EXECUTE ON FUNCTION public.get_group_pnl(integer, integer, uuid) TO authenticated, service_role;


-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- §3  feature_flags.stock_transfers (new-feature checklist step 1)
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- FeatureAccessModal's Save sends every DEFAULT_FLAGS key in one upsert, so the column must exist
-- before the frontend adds the key (S547). The key goes in STARTER_KEYS (Record & Comply).
ALTER TABLE public.feature_flags ADD COLUMN IF NOT EXISTS stock_transfers boolean DEFAULT false;


-- ── 4. Self-checks: refuse to commit a half-landed shape ────────────────────────────────────────
DO $post$
DECLARE
  v_res text;
BEGIN
  IF to_regprocedure('public.get_group_pnl(integer,integer)') IS NOT NULL THEN
    RAISE EXCEPTION 'S849 PNL: the two-argument get_group_pnl is still there (no overload may be left)';
  END IF;
  SELECT pg_get_function_result(to_regprocedure('public.get_group_pnl(integer,integer,uuid)')) INTO v_res;
  IF v_res IS NULL OR position('on_the_way_val numeric' IN v_res) = 0
     OR position('delivery_commission numeric' IN v_res) = 0 THEN
    RAISE EXCEPTION 'S849 PNL: get_group_pnl did not land with the new columns (%)', v_res;
  END IF;

  IF has_function_privilege('anon', 'public.get_group_pnl(integer,integer,uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.send_stock_transfer(uuid,uuid,uuid,jsonb,text,boolean)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.receive_stock_transfer(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.end_stock_transfer(uuid,text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.stock_transfer_open_day(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.stock_transfer_open_day(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'S849 PNL: a P&L or stock-transfer function is executable by a role it must not be';
  END IF;

  IF has_table_privilege('authenticated', 'public.ims_stock_transfer_lines', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.ims_stock_transfer_lines', 'DELETE')
     OR has_table_privilege('authenticated', 'public.ims_stock_transfer_lines', 'TRUNCATE')
     OR has_table_privilege('authenticated', 'public.ims_stock_transfer_lines', 'REFERENCES')
     OR has_table_privilege('authenticated', 'public.ims_stock_transfer_lines', 'TRIGGER')
     OR has_table_privilege('authenticated', 'public.ims_stock_transfers', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.ims_stock_transfers', 'DELETE')
     OR has_table_privilege('authenticated', 'public.ims_stock_transfers', 'TRUNCATE')
     OR has_table_privilege('authenticated', 'public.ims_stock_transfers', 'REFERENCES')
     OR has_table_privilege('authenticated', 'public.ims_stock_transfers', 'TRIGGER')
     OR has_table_privilege('authenticated', 'public.ims_stock_transfer_lines', 'MAINTAIN')
     OR has_table_privilege('authenticated', 'public.ims_stock_transfers', 'MAINTAIN')
     OR has_table_privilege('anon', 'public.ims_stock_transfer_lines', 'SELECT')
     OR has_table_privilege('anon', 'public.ims_stock_transfers', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.ims_stock_transfer_lines', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.ims_stock_transfers', 'INSERT') THEN
    RAISE EXCEPTION 'S849 PNL: stock-transfer table grants are not exactly SELECT, INSERT for authenticated';
  END IF;

  -- Review N5/N7/N8 landed in the bodies: the line cap and the hidden-item problem in send, the
  -- hidden-item refusal in end, the period link in all three and in get_group_pnl's on-the-way rule.
  IF position('stock_transfer_too_many_lines' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.send_stock_transfer(uuid,uuid,uuid,jsonb,text,boolean)'::regprocedure)) = 0
     OR position('''hidden''' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.send_stock_transfer(uuid,uuid,uuid,jsonb,text,boolean)'::regprocedure)) = 0
     OR position('stock_transfer_item_hidden' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.end_stock_transfer(uuid,text,text)'::regprocedure)) = 0
     OR position('sent_period_id' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.receive_stock_transfer(uuid)'::regprocedure)) = 0
     OR position('sent_period_id' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.end_stock_transfer(uuid,text,text)'::regprocedure)) = 0
     OR position('t.ended_period_id' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.get_group_pnl(integer,integer,uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'S849 PNL: a review N5/N7/N8 change is missing from a stock-transfer body';
  END IF;

  IF (SELECT provolatile FROM pg_proc WHERE oid = to_regprocedure('public.stock_transfer_open_day(uuid)')) IS DISTINCT FROM 'v' THEN
    RAISE EXCEPTION 'S849 PNL: stock_transfer_open_day must be VOLATILE (it locks the period row)';
  END IF;

  -- §1b: the three bodies name the new table, and the force-delete refuses before it clears.
  IF position('ims_stock_transfer_lines' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.item_reference_counts(uuid[])'::regprocedure)) = 0
     OR position('ims_stock_transfer_lines' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.item_has_references(uuid)'::regprocedure)) = 0
     OR position('force_delete_item_transferred' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.force_delete_item(uuid)'::regprocedure)) = 0
     OR NOT has_function_privilege('authenticated', 'public.item_reference_counts(uuid[])', 'EXECUTE')
     OR has_function_privilege('anon', 'public.force_delete_item(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.item_has_references(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'S849 PNL: the item reference list did not land as §1b wrote it (bodies or grants)';
  END IF;

  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public'
        AND tablename IN ('ims_stock_transfers', 'ims_stock_transfer_lines')
        AND policyname IN ('no_self_service_accounts', 'no_pos_pin_staff', 'no_hr_role_staff')
        AND permissive = 'RESTRICTIVE') <> 6 THEN
    RAISE EXCEPTION 'S849 PNL: a stock-transfer table is missing a restrictive staff-isolation policy';
  END IF;

  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public'
        AND policyname IN ('ims_stock_transfers_all', 'ims_stock_transfer_lines_all')
        AND position('my_client_id' IN qual) > 0 AND position('my_client_id' IN with_check) > 0) <> 2 THEN
    RAISE EXCEPTION 'S849 PNL: a stock-transfer client policy is not over my_client_id()';
  END IF;

  -- Foreign keys by catalog value (S630): the client CASCADE ('c') on both; the header link, the
  -- receiver and the ending month SET NULL ('n'); the lines' period and item and the header's sending
  -- month NO ACTION ('a'), so a month or an item with transfer lines cannot be deleted from under them.
  IF (SELECT string_agg(k.label, ',' ORDER BY k.label COLLATE "C")
        FROM (SELECT r.relname || '.' || a.attname || '=' || c.confdeltype::text AS label
                FROM pg_constraint c
                JOIN pg_class r     ON r.oid = c.conrelid
                JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
               WHERE c.contype = 'f'
                 AND c.conrelid IN ('public.ims_stock_transfers'::regclass, 'public.ims_stock_transfer_lines'::regclass)) k)
     IS DISTINCT FROM
     'ims_stock_transfer_lines.client_id=c,ims_stock_transfer_lines.item_id=a,ims_stock_transfer_lines.period_id=a,ims_stock_transfer_lines.transfer_id=n,ims_stock_transfers.client_id=c,ims_stock_transfers.ended_period_id=n,ims_stock_transfers.sent_period_id=a,ims_stock_transfers.to_client_id=n' THEN
    RAISE EXCEPTION 'S849 PNL: a stock-transfer foreign key has the wrong delete action';
  END IF;

  IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal
        AND ((tgrelid = 'public.ims_stock_transfer_lines'::regclass
              AND tgname IN ('guard_ims_stock_transfer_lines', 'ims_item_same_client', 'audit_ims_stock_transfer_lines'))
          OR (tgrelid = 'public.ims_stock_transfers'::regclass
              AND tgname IN ('guard_ims_stock_transfers', 'audit_ims_stock_transfers')))) <> 5 THEN
    RAISE EXCEPTION 'S849 PNL: a stock-transfer trigger is missing';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'feature_flags' AND column_name = 'stock_transfers') THEN
    RAISE EXCEPTION 'S849 PNL: feature_flags.stock_transfers is missing';
  END IF;
END
$post$;

NOTIFY pgrst, 'reload schema';

COMMIT;
