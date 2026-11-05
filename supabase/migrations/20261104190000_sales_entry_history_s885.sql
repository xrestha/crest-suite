-- S885: who changed a day's sales, and what it said before.
--
-- Owner decisions (2026-11-04, asked in plain words): the Owner and IMS managers can see every change a
-- signed-in person makes to Sales Entry, deletions included; the till's own automatic sales are not
-- logged (each already traces to its bill); history starts the day this goes live.
--
-- Why a narrow table and not log_audit(): log_audit reads NEW/OLD.client_id, which sales_entries does
-- not have, and its EXCEPTION handler would swallow the fault, so it would record nothing. It would
-- also store full rows in the operator-only audit_logs, log the 2N delete-and-reinsert rows every
-- Save Day writes, and be erased by the operator's 90-day purge.
--
-- How it nets: save_sales_day deletes the day's manual rows and inserts the new set in one
-- transaction, so row ids change on every save. Each row event adds into ONE history row per
-- (transaction, month, day, dish): a delete adds to the "before", an insert to the "after". A
-- deferred trigger then drops every history row whose before equals its after, so re-saving
-- unchanged figures records nothing.
--
-- Who is logged: only a signed-in person (current_user anon/authenticated inside the INVOKER row
-- trigger). The till posts inside SECURITY DEFINER bodies, the support tools run as the service role,
-- and a cascade from a deleted month or client runs as the owner; none of those is logged. An operator
-- restore (old created_at) is not a change either. A person deleting a till row by hand IS logged.
--
-- 1. sales_entry_history: RLS on with NO client policies and no client grants; written only by the
--    SECURITY DEFINER helper below, read only through get_sales_history().
-- 2. sales_history_note(): the DEFINER writer. Callable only from inside a trigger
--    (pg_trigger_depth() >= 1), so a direct RPC call cannot write a false history.
-- 3. sales_entries_note_history(): the SECURITY INVOKER row trigger function (it must be INVOKER, or
--    current_user would be the owner every time and the "is this a person" test would never pass).
-- 4. sales_entry_history_net: the deferred constraint trigger that drops unchanged rows at commit.
-- 5. get_sales_history(p_period_id, p_before_id, p_limit): SECURITY DEFINER read for the Owner, an IMS
--    manager or the operator; newest first, paged by id.
-- The Danger Zone clears (admin-user-ops) delete the client's rows; both FKs cascade too. Not exported,
-- like audit_logs. No restrictive staff-isolation list applies: no client role can read the table.
--
-- Reverse:
--   DROP TRIGGER IF EXISTS sales_entries_history_ins ON public.sales_entries;
--   DROP TRIGGER IF EXISTS sales_entries_history_upd ON public.sales_entries;
--   DROP TRIGGER IF EXISTS sales_entries_history_del ON public.sales_entries;
--   DROP FUNCTION IF EXISTS public.get_sales_history(uuid, bigint, integer);
--   DROP FUNCTION IF EXISTS public.sales_entries_note_history();
--   DROP FUNCTION IF EXISTS public.sales_history_note(uuid, integer, uuid, numeric, numeric, numeric, boolean);
--   DROP TABLE IF EXISTS public.sales_entry_history;   -- also drops sales_entry_history_net
--   DROP FUNCTION IF EXISTS public.sales_entry_history_drop_unchanged();

-- ══ 1. The record ════════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.sales_entry_history (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_id       uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  period_id       uuid NOT NULL REFERENCES public.monthly_periods(id) ON DELETE CASCADE,
  bs_day          integer NOT NULL,
  -- No FK: a dish deleted later keeps its history under the name it had.
  recipe_id       uuid,
  recipe_name     text,
  old_qty         numeric,
  new_qty         numeric,
  old_value       numeric,
  new_value       numeric,
  changed_by      uuid,
  changed_by_name text,
  changed_at      timestamptz NOT NULL DEFAULT now(),
  txid            bigint NOT NULL DEFAULT txid_current(),
  CONSTRAINT sales_entry_history_one_per_change UNIQUE NULLS NOT DISTINCT (txid, period_id, bs_day, recipe_id)
);

COMMENT ON TABLE public.sales_entry_history IS
  'Hand changes to Sales Entry (S885): one row per transaction, month, day and dish; old_qty NULL = added, new_qty NULL = removed. Written only by sales_history_note(), read only by get_sales_history().';

-- The page reads one month newest-first; the Danger Zone deletes by client.
CREATE INDEX IF NOT EXISTS idx_sales_entry_history_period_id ON public.sales_entry_history (period_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_sales_entry_history_client_id ON public.sales_entry_history (client_id);

ALTER TABLE public.sales_entry_history ENABLE ROW LEVEL SECURITY;
-- The S782 trap both ways: nothing for the browser roles, explicit rights for the service role.
REVOKE ALL ON TABLE public.sales_entry_history FROM PUBLIC;
REVOKE ALL ON TABLE public.sales_entry_history FROM anon;
REVOKE ALL ON TABLE public.sales_entry_history FROM authenticated;
GRANT SELECT, DELETE ON TABLE public.sales_entry_history TO service_role;

-- ══ 2. The writer ════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.sales_history_note(
  p_period_id uuid,
  p_bs_day    integer,
  p_recipe_id uuid,
  p_qty       numeric,
  p_price     numeric,
  p_discount  numeric,
  p_is_old    boolean
)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_client  uuid;
  v_value   numeric;
  v_name    text;
  v_by      uuid := auth.uid();
  v_by_name text;
BEGIN
  IF pg_trigger_depth() < 1 THEN
    RAISE EXCEPTION 'sales_history_note is written by the Sales Entry trigger only'
      USING ERRCODE = '42501';
  END IF;

  SELECT mp.client_id INTO v_client FROM monthly_periods mp WHERE mp.id = p_period_id;
  IF v_client IS NULL THEN
    RETURN;
  END IF;

  -- The line's money: qty x price less its discount. A row with no price has no value (NULL), and a
  -- NULL anywhere in a dish-day keeps that side unknown rather than understated.
  v_value := CASE WHEN p_price IS NULL THEN NULL
                  ELSE COALESCE(p_qty, 0) * p_price - COALESCE(p_discount, 0) END;
  SELECT r.name INTO v_name FROM recipes r WHERE r.id = p_recipe_id;
  SELECT NULLIF(btrim(p.full_name), '') INTO v_by_name FROM profiles p WHERE p.id = v_by;

  IF p_is_old THEN
    INSERT INTO sales_entry_history AS h
           (client_id, period_id, bs_day, recipe_id, recipe_name, old_qty, old_value, changed_by, changed_by_name)
    VALUES (v_client, p_period_id, p_bs_day, p_recipe_id, v_name, COALESCE(p_qty, 0), v_value, v_by, v_by_name)
    ON CONFLICT ON CONSTRAINT sales_entry_history_one_per_change DO UPDATE
       SET old_qty   = COALESCE(h.old_qty, 0) + EXCLUDED.old_qty,
           old_value = CASE WHEN h.old_qty IS NULL THEN EXCLUDED.old_value
                            ELSE h.old_value + EXCLUDED.old_value END;
  ELSE
    INSERT INTO sales_entry_history AS h
           (client_id, period_id, bs_day, recipe_id, recipe_name, new_qty, new_value, changed_by, changed_by_name)
    VALUES (v_client, p_period_id, p_bs_day, p_recipe_id, v_name, COALESCE(p_qty, 0), v_value, v_by, v_by_name)
    ON CONFLICT ON CONSTRAINT sales_entry_history_one_per_change DO UPDATE
       SET new_qty   = COALESCE(h.new_qty, 0) + EXCLUDED.new_qty,
           new_value = CASE WHEN h.new_qty IS NULL THEN EXCLUDED.new_value
                            ELSE h.new_value + EXCLUDED.new_value END;
  END IF;
END
$function$;

REVOKE ALL ON FUNCTION public.sales_history_note(uuid, integer, uuid, numeric, numeric, numeric, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sales_history_note(uuid, integer, uuid, numeric, numeric, numeric, boolean) FROM anon;
-- authenticated needs it: the INVOKER trigger below calls it in the writer's session. A direct call is
-- refused by the trigger-depth test above.
GRANT EXECUTE ON FUNCTION public.sales_history_note(uuid, integer, uuid, numeric, numeric, numeric, boolean) TO authenticated;

-- ══ 3. The row trigger on sales_entries ══════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.sales_entries_note_history()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' AND COALESCE(public.is_admin(), false) AND NEW.created_at < now() - interval '1 minute' THEN
    RETURN NULL;
  END IF;

  IF TG_OP IN ('DELETE', 'UPDATE') THEN
    PERFORM public.sales_history_note(OLD.period_id, OLD.bs_day, OLD.recipe_id,
                                      OLD.qty_sold, OLD.unit_price, OLD.discount, true);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM public.sales_history_note(NEW.period_id, NEW.bs_day, NEW.recipe_id,
                                      NEW.qty_sold, NEW.unit_price, NEW.discount, false);
  END IF;
  RETURN NULL;
END
$function$;
REVOKE ALL ON FUNCTION public.sales_entries_note_history() FROM PUBLIC;

-- AFTER, so a row the closed-month or rank guard refuses is never recorded. A person only ever inserts
-- manual rows (ims_sales_entries_guard), so the WHEN only spares the till's posts a function call.
DROP TRIGGER IF EXISTS sales_entries_history_ins ON public.sales_entries;
CREATE TRIGGER sales_entries_history_ins AFTER INSERT ON public.sales_entries
  FOR EACH ROW WHEN (COALESCE(NEW.source, 'manual') = 'manual')
  EXECUTE FUNCTION public.sales_entries_note_history();
DROP TRIGGER IF EXISTS sales_entries_history_upd ON public.sales_entries;
CREATE TRIGGER sales_entries_history_upd AFTER UPDATE ON public.sales_entries
  FOR EACH ROW EXECUTE FUNCTION public.sales_entries_note_history();
DROP TRIGGER IF EXISTS sales_entries_history_del ON public.sales_entries;
CREATE TRIGGER sales_entries_history_del AFTER DELETE ON public.sales_entries
  FOR EACH ROW EXECUTE FUNCTION public.sales_entries_note_history();

-- ══ 4. Net out unchanged re-saves at commit ══════════════════════════════════════════════════════
-- SECURITY DEFINER: it fires at COMMIT in the writer's session, and authenticated holds no rights on
-- the table. It only ever deletes the row it fired for, and only when that row records no change.
CREATE OR REPLACE FUNCTION public.sales_entry_history_drop_unchanged()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  DELETE FROM sales_entry_history h
   WHERE h.id = NEW.id
     AND COALESCE(h.old_qty, 0) = COALESCE(h.new_qty, 0)
     AND (h.old_value IS NOT DISTINCT FROM h.new_value
          -- "nothing" and "a zero line" are the same figure
          OR ((h.old_qty IS NULL OR h.new_qty IS NULL) AND COALESCE(h.old_value, 0) = COALESCE(h.new_value, 0)));
  RETURN NULL;
END
$function$;
REVOKE ALL ON FUNCTION public.sales_entry_history_drop_unchanged() FROM PUBLIC;

DROP TRIGGER IF EXISTS sales_entry_history_net ON public.sales_entry_history;
CREATE CONSTRAINT TRIGGER sales_entry_history_net
  AFTER INSERT OR UPDATE ON public.sales_entry_history
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.sales_entry_history_drop_unchanged();

-- ══ 5. The read ══════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.get_sales_history(
  p_period_id uuid,
  p_before_id bigint  DEFAULT NULL::bigint,
  p_limit     integer DEFAULT 200
)
 RETURNS TABLE (
   id              bigint,
   bs_day          integer,
   recipe_id       uuid,
   recipe_name     text,
   old_qty         numeric,
   new_qty         numeric,
   old_value       numeric,
   new_value       numeric,
   changed_by_name text,
   changed_at      timestamptz
 )
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
DECLARE
  v_client uuid;
BEGIN
  SELECT mp.client_id INTO v_client FROM monthly_periods mp WHERE mp.id = p_period_id;

  -- COALESCE around the whole condition (S630): every operand can be NULL for some caller.
  IF NOT COALESCE(
       v_client IS NOT NULL
       AND (public.is_admin()
            OR (v_client = public.my_client_id() AND public.ims_caller_has_rank('manager'))),
       false) THEN
    RAISE EXCEPTION 'sales_history_rank: the sales change history is for the Owner and IMS managers'
      USING ERRCODE = '42501', HINT = 'sales_history_rank';
  END IF;

  RETURN QUERY
    SELECT h.id::bigint,
           h.bs_day::integer,
           h.recipe_id::uuid,
           COALESCE(r.name, h.recipe_name)::text,
           h.old_qty::numeric,
           h.new_qty::numeric,
           h.old_value::numeric,
           h.new_value::numeric,
           h.changed_by_name::text,
           h.changed_at::timestamptz
      FROM sales_entry_history h
      LEFT JOIN recipes r ON r.id = h.recipe_id
     WHERE h.period_id = p_period_id
       AND (p_before_id IS NULL OR h.id < p_before_id)
     ORDER BY h.id DESC
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500);
END
$function$;

REVOKE ALL ON FUNCTION public.get_sales_history(uuid, bigint, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_sales_history(uuid, bigint, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_sales_history(uuid, bigint, integer) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

-- ══ 6. Self-check (catalog values) ═══════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF has_table_privilege('authenticated', 'public.sales_entry_history', 'SELECT')
     OR has_table_privilege('anon', 'public.sales_entry_history', 'SELECT') THEN
    RAISE EXCEPTION 'S885: a browser role can read sales_entry_history directly';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.sales_entry_history', 'DELETE') THEN
    RAISE EXCEPTION 'S885: service_role cannot clear sales_entry_history (Danger Zone)';
  END IF;
  IF has_function_privilege('anon', 'public.get_sales_history(uuid, bigint, integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.sales_history_note(uuid, integer, uuid, numeric, numeric, numeric, boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'S885: anon can execute a sales history function';
  END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE oid = 'public.sales_entries_note_history()'::regprocedure) THEN
    RAISE EXCEPTION 'S885: sales_entries_note_history must be SECURITY INVOKER';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.sales_entries'::regclass
        AND tgname IN ('sales_entries_history_ins', 'sales_entries_history_upd', 'sales_entries_history_del')) <> 3 THEN
    RAISE EXCEPTION 'S885: the three sales_entries history triggers are not all present';
  END IF;
END $$;
