-- ════════════════════════════════════════════════════════════════════════════════════════════
-- S835, POS small leftovers, second pass: the server halves of the found-while-fixing list
-- (POS_TODO.md S809.4) the owner approved on 2026-10-14.
--
--   (1) A table out of service takes no new order (FLOOR-KITCHEN-7's server half, D19).
--       guard_pos_order_insert refuses an open order on an inactive table, hint
--       pos_table_inactive_new_order. It reads the table FOR SHARE, so a retire at the same moment
--       waits for the insert (and pos_tables_guard_open_bill then sees the bill), or the insert waits
--       for the retire.
--   (2) D41 (owner): a table with bills on record is not deleted; Inactive keeps it and its history.
--       pos_tables_guard_open_order_delete refuses it, hint pos_table_has_bills, after its open-bill
--       refusal. Danger Zone deletes orders before tables, and a whole-client deletion is still let
--       through (the clients row is gone inside that cascade).
--   (3) A booking is a no-show only from its booked time (D23's server half; the page has gated it
--       since S818). New pos_reservations_guard_no_show, BEFORE UPDATE OF status, hint
--       reservation_no_show_early. A guest who calls to say they will not come is a Cancel.
--   (4) Unblocking a till login checks every employee record it is linked to: the home one and each
--       outlet's (profile_employee_links, S798 3f-1). Gone at any outlet keeps it blocked.
--       pos_set_login_blocked, hint pos_unblock_leaver as before.
--   (5) D39 (owner): the Owner sees who last reset each staff PIN. New get_staff_pin_resets(client),
--       DEFINER, the Owner of that outlet and the operator only (hint pin_resets_owner_only), read
--       from the staff_pin_vault UPDATE rows admin-user-ops writes (S809 1f). The operator's name
--       is never shown: "Crest support".
--   (6) A QR payment matched to an open bill that is then cleared is left unmatched for staff to
--       sort out, instead of refusing the clear: pos_payment_confirmations.matched_order_id becomes
--       ON DELETE SET NULL (it was NO ACTION). The SET NULL runs as the table owner, so
--       pos_payment_confirmations_guard lets it through. 0 confirmations live.
--   (7) A guest whose choices price a dish below zero is told so, not that the choices are gone:
--       submit_guest_order collects those dishes apart, hint below_zero_options (DETAIL: the dish
--       names, the shape unavailable_options uses). An older guest page shows its default sentence.
--   (8) Menu copy (push_master_data): the preview of a dish matched to a branch's own by code or
--       name now says its price is replaced with HQ's when prices are pushed (the push did it and
--       the preview never said), and _plan is dropped first, so a second call in one transaction
--       no longer fails with 42P07.
--   (9) recipes.is_active and recipes.pos_enabled are NOT NULL (0 NULL rows live, checked
--       2026-10-14). The till's menu read wanted true and the save took NULL; now they cannot differ.
--  (10) An index on pos_parking_slips (client_id, time_in) for the All tab's date range.
--
-- Built on the live bodies, md5(prosrc), read 2026-10-14: guard_pos_order_insert
-- 555ea55be0f69a7ef19a1ce6b06b8e99 (20261009200000), pos_tables_guard_open_order_delete
-- be8e7161ada08175d9295682b3322499 (20260916110000), pos_set_login_blocked
-- 0793f45a42b2838f951126602cc1d490 (20261010100000), submit_guest_order
-- 8dcdb6f40c30b80449e4bb8547c350e8 (20261014100000), push_master_data
-- 18817185fce6a1eaf215afc52876ee53 (20261009240000). Each is patched FROM ITS LIVE DEFINITION
-- (pg_get_functiondef) by exact text replacement; pg_temp.s835_patch refuses unless each old text
-- occurs exactly once, so a body that moved stops the file instead of being half-patched.
-- Signatures and return types are unchanged, so grants and triggers stay. Section 0 accepts the
-- live hash or the one this file writes, so a re-run passes.
--
-- No app is required first: the till already words an inactive table itself (S817), and every new
-- refusal has its sentence in errorText.js from crest-v451. No till floor change.
--
-- To undo: re-create the five patched functions from the files named above; DROP TRIGGER
-- pos_reservations_guard_no_show ON pos_reservations and DROP FUNCTION
-- pos_reservations_guard_no_show(); DROP FUNCTION get_staff_pin_resets(uuid); put the confirmation
-- key back as NO ACTION; ALTER recipes ... DROP NOT NULL on the two columns; DROP INDEX
-- pos_parking_slips_client_time_in_idx.
--
-- The probe (section 11) acts at BLOOM CAFE (or the first POS outlet with an unblocked POS manager
-- and an Owner) as the migration's role, an anonymous guest, that manager and that Owner, inside a
-- block that rolls itself back. It blocks and unblocks the manager's till login inside that block
-- (ending its sessions until the rollback), takes the outlet's invoice-number lock for one probe
-- bill, and runs a menu-copy preview as an outlet group's Owner if one exists. If any check fails,
-- nothing lands.
-- ════════════════════════════════════════════════════════════════════════════════════════════


-- ── 0. Pre-flight ──────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.guard_pos_order_insert()'::regprocedure;
  IF v_md5 IS NULL OR v_md5 NOT IN ('555ea55be0f69a7ef19a1ce6b06b8e99', 'becdecf2d6d114379a735e44749b3e73') THEN
    RAISE EXCEPTION 'S835 pre-flight: guard_pos_order_insert changed since this was written (md5 %). Rebuild from the live body.', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.pos_tables_guard_open_order_delete()'::regprocedure;
  IF v_md5 IS NULL OR v_md5 NOT IN ('be8e7161ada08175d9295682b3322499', 'c46a03a89678e82c41129a2a31b3fabe') THEN
    RAISE EXCEPTION 'S835 pre-flight: pos_tables_guard_open_order_delete changed since this was written (md5 %). Rebuild from the live body.', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.pos_set_login_blocked(uuid, boolean, uuid)'::regprocedure;
  IF v_md5 IS NULL OR v_md5 NOT IN ('0793f45a42b2838f951126602cc1d490', '0804c5f22df300632dcca4f6eb75c427') THEN
    RAISE EXCEPTION 'S835 pre-flight: pos_set_login_blocked changed since this was written (md5 %). Rebuild from the live body.', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.submit_guest_order(uuid, jsonb, text, integer, uuid)'::regprocedure;
  IF v_md5 IS NULL OR v_md5 NOT IN ('8dcdb6f40c30b80449e4bb8547c350e8', '05b2d225a29979180405ce7660813a3b') THEN
    RAISE EXCEPTION 'S835 pre-flight: submit_guest_order changed since this was written (md5 %). Rebuild from the live body.', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.push_master_data(uuid[], text[], boolean)'::regprocedure;
  IF v_md5 IS NULL OR v_md5 NOT IN ('18817185fce6a1eaf215afc52876ee53', '7d934093b1453b707436476cb4f92263') THEN
    RAISE EXCEPTION 'S835 pre-flight: push_master_data changed since this was written (md5 %). Rebuild from the live body.', v_md5;
  END IF;
  -- (9) is a decision, not a cleanup, if a NULL has appeared since 2026-10-14: stop and ask.
  IF EXISTS (SELECT 1 FROM public.recipes WHERE is_active IS NULL OR pos_enabled IS NULL) THEN
    RAISE EXCEPTION 'S835 pre-flight: a recipe now has a NULL is_active or pos_enabled; decide on or off before making them required';
  END IF;
END;
$$;

-- The patcher: one exact replacement, refused unless the old text occurs exactly once.
CREATE OR REPLACE FUNCTION pg_temp.s835_patch(p_src text, p_old text, p_new text)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_n integer;
BEGIN
  v_n := (length(p_src) - length(replace(p_src, p_old, ''))) / length(p_old);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'S835 patch: expected the old text once, found it % time(s): %', v_n, left(p_old, 120);
  END IF;
  RETURN replace(p_src, p_old, p_new);
END;
$$;


-- ── 1. A table out of service takes no new order ──────────────────────────────────────────────
DO $do$
DECLARE
  v_def text;
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.guard_pos_order_insert()'::regprocedure) = 'becdecf2d6d114379a735e44749b3e73' THEN
    RETURN; -- a re-run
  END IF;
  v_def := pg_get_functiondef('public.guard_pos_order_insert()'::regprocedure);
  v_def := pg_temp.s835_patch(v_def,
$o$BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;

  -- Cheap test first: the ordinary insert pays no identity lookup.
$o$,
$n$DECLARE
  v_table_status text;
  v_table_name   text;
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;

  -- S835 (FLOOR-KITCHEN-7's server half, D19): a table out of service takes no new order. The till
  -- checks its floor read, which can be 15 s old. FOR SHARE makes a retire at the same moment wait
  -- for this insert (pos_tables_guard_open_bill then sees the bill), or this insert wait for it.
  IF NEW.table_id IS NOT NULL AND NEW.status = 'open' THEN
    SELECT t.status, t.name INTO v_table_status, v_table_name
      FROM pos_tables t WHERE t.id = NEW.table_id FOR SHARE;
    IF v_table_status = 'inactive' THEN
      RAISE EXCEPTION 'pos_table_inactive_new_order: % is out of service, so it takes no new order', v_table_name
        USING ERRCODE = '23514', HINT = 'pos_table_inactive_new_order';
    END IF;
  END IF;

  -- Cheap test first: the ordinary insert pays no identity lookup.
$n$);
  EXECUTE v_def;
END;
$do$;


-- ── 2. A table with bills on record is not deleted (D41) ──────────────────────────────────────
DO $do$
DECLARE
  v_def text;
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.pos_tables_guard_open_order_delete()'::regprocedure) = 'c46a03a89678e82c41129a2a31b3fabe' THEN
    RETURN;
  END IF;
  v_def := pg_get_functiondef('public.pos_tables_guard_open_order_delete()'::regprocedure);
  v_def := pg_temp.s835_patch(v_def,
$o$      USING HINT = 'pos_table_has_open_order';
  END IF;
  RETURN OLD;
$o$,
$n$      USING HINT = 'pos_table_has_open_order';
  END IF;
  -- S835 (owner decision D41): nor one with bills on record. Its bills would keep the id of a
  -- table that no longer exists; Inactive keeps the table and its history together.
  IF EXISTS (SELECT 1 FROM pos_orders o WHERE o.table_id = OLD.id) THEN
    RAISE EXCEPTION 'pos_table_has_bills: % has bills on record — take it out of service instead, so its history stays with it', OLD.name
      USING ERRCODE = '23503', HINT = 'pos_table_has_bills';
  END IF;
  RETURN OLD;
$n$);
  EXECUTE v_def;
END;
$do$;


-- ── 3. A no-show only from the booked time (D23's server half) ────────────────────────────────
-- SECURITY INVOKER for the current_user seam: the service role and DEFINER bodies pass. OLD's
-- booked time, the one the page showed, so a write that also moves the time cannot skip the rule.
CREATE OR REPLACE FUNCTION public.pos_reservations_guard_no_show()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;
  IF NEW.status = 'no_show' AND OLD.status IS DISTINCT FROM 'no_show' AND now() < OLD.reserved_for THEN
    RAISE EXCEPTION 'reservation_no_show_early: % is booked for a later time — a party is a no-show only once its booked time has passed; a guest who says they will not come is a Cancel', OLD.customer_name
      USING ERRCODE = '23514', HINT = 'reservation_no_show_early';
  END IF;
  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION public.pos_reservations_guard_no_show() FROM PUBLIC;
DROP TRIGGER IF EXISTS pos_reservations_guard_no_show ON public.pos_reservations;
CREATE TRIGGER pos_reservations_guard_no_show
  BEFORE UPDATE OF status ON public.pos_reservations
  FOR EACH ROW EXECUTE FUNCTION public.pos_reservations_guard_no_show();


-- ── 4. Unblock checks every employee record the login is linked to ────────────────────────────
DO $do$
DECLARE
  v_def text;
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.pos_set_login_blocked(uuid, boolean, uuid)'::regprocedure) = '0804c5f22df300632dcca4f6eb75c427' THEN
    RETURN;
  END IF;
  v_def := pg_get_functiondef('public.pos_set_login_blocked(uuid, boolean, uuid)'::regprocedure);
  v_def := pg_temp.s835_patch(v_def,
$o$  IF EXISTS (SELECT 1 FROM hr_employees e
              WHERE e.id = p.hr_employee_id AND e.status NOT IN ('active', 'probation')) THEN
$o$,
$n$  -- S835: every employee record the login is linked to counts, the home one (hr_employee_id) and
  -- each outlet's (profile_employee_links, S798 3f-1). Gone at any outlet keeps it blocked.
  IF EXISTS (SELECT 1 FROM hr_employees e
              WHERE (e.id = p.hr_employee_id
                     OR e.id IN (SELECT l.employee_id FROM profile_employee_links l WHERE l.profile_id = p.id))
                AND e.status NOT IN ('active', 'probation')) THEN
$n$);
  EXECUTE v_def;
END;
$do$;


-- ── 5. Who last reset each staff PIN (D39) ────────────────────────────────────────────────────
-- audit_logs is admin-only, so the Owner reads this one answer through a DEFINER function: per staff
-- login, its latest reset and who did it. The operator's own name never reaches a client.
CREATE OR REPLACE FUNCTION public.get_staff_pin_resets(p_client_id uuid)
RETURNS TABLE (user_id uuid, reset_at timestamptz, reset_by_name text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
  IF NOT COALESCE(public.is_admin()
                  OR (public.is_client_owner() AND p_client_id = public.my_client_id()), false) THEN
    RAISE EXCEPTION 'pin_resets_owner_only: only the Owner sees who reset a staff PIN'
      USING ERRCODE = '42501', HINT = 'pin_resets_owner_only';
  END IF;
  RETURN QUERY
  SELECT DISTINCT ON (a.record_id)
         a.record_id::uuid,
         a.created_at::timestamptz,
         (CASE WHEN COALESCE(actor.role = 'admin', false) THEN 'Crest support'
               ELSE COALESCE(NULLIF(btrim(actor.full_name), ''), a.user_name) END)::text
    FROM audit_logs a
    LEFT JOIN profiles actor ON actor.id = a.user_id
   WHERE a.client_id = p_client_id
     AND a.table_name = 'staff_pin_vault'
     AND a.action = 'UPDATE'
     AND a.record_id IS NOT NULL
     AND COALESCE(a.new_data->>'pin_reset', '') = 'true'
   ORDER BY a.record_id, a.id DESC;
END;
$fn$;
REVOKE ALL ON FUNCTION public.get_staff_pin_resets(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_staff_pin_resets(uuid) TO authenticated, service_role;


-- ── 6. A cleared bill's QR payment is left unmatched ──────────────────────────────────────────
ALTER TABLE public.pos_payment_confirmations
  DROP CONSTRAINT IF EXISTS pos_payment_confirmations_matched_order_id_fkey;
ALTER TABLE public.pos_payment_confirmations
  ADD CONSTRAINT pos_payment_confirmations_matched_order_id_fkey
  FOREIGN KEY (matched_order_id) REFERENCES public.pos_orders(id) ON DELETE SET NULL;


-- ── 7. A guest's dish priced below zero by its choices ────────────────────────────────────────
DO $do$
DECLARE
  v_def text;
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.submit_guest_order(uuid, jsonb, text, integer, uuid)'::regprocedure) = '05b2d225a29979180405ce7660813a3b' THEN
    RETURN;
  END IF;
  v_def := pg_get_functiondef('public.submit_guest_order(uuid, jsonb, text, integer, uuid)'::regprocedure);
  v_def := pg_temp.s835_patch(v_def,
$o$  v_bad_options text[] := '{}';
$o$,
$n$  v_bad_options text[] := '{}';
  v_below_zero  text[] := '{}';  -- S835
$n$);
  v_def := pg_temp.s835_patch(v_def,
$o$      v_sel := public.pos_price_selection(v_client_id, r.id, v_opt_ids);
      IF v_sel->>'problem' IS NOT NULL THEN
$o$,
$n$      v_sel := public.pos_price_selection(v_client_id, r.id, v_opt_ids);
      -- S835: priced below zero by its choices is not "no longer available". The guest is told to
      -- pick other choices or ask staff (below_zero_options, below).
      IF v_sel->>'problem' = 'option_price_below_zero' THEN
        v_below_zero := v_below_zero || r.name;
        CONTINUE;
      END IF;
      IF v_sel->>'problem' IS NOT NULL THEN
$n$);
  v_def := pg_temp.s835_patch(v_def,
$o$      USING HINT = 'unavailable_options',
            DETAIL = to_jsonb(ARRAY(SELECT DISTINCT u FROM unnest(v_bad_options) u ORDER BY 1))::text;
  END IF;
$o$,
$n$      USING HINT = 'unavailable_options',
            DETAIL = to_jsonb(ARRAY(SELECT DISTINCT u FROM unnest(v_bad_options) u ORDER BY 1))::text;
  END IF;

  -- S835: after the choices that are gone, so the guest fixes those first.
  IF cardinality(v_below_zero) > 0 THEN
    RAISE EXCEPTION 'Some dishes cannot be ordered with the choices picked'
      USING HINT = 'below_zero_options',
            DETAIL = to_jsonb(ARRAY(SELECT DISTINCT u FROM unnest(v_below_zero) u ORDER BY 1))::text;
  END IF;
$n$);
  EXECUTE v_def;
END;
$do$;


-- ── 8. Menu copy: a matched dish's price in the preview, and a second call ────────────────────
DO $do$
DECLARE
  v_def text;
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.push_master_data(uuid[], text[], boolean)'::regprocedure) = '7d934093b1453b707436476cb4f92263' THEN
    RETURN;
  END IF;
  v_def := pg_get_functiondef('public.push_master_data(uuid[], text[], boolean)'::regprocedure);
  v_def := pg_temp.s835_patch(v_def,
$o$  CREATE TEMP TABLE _plan (
$o$,
$n$  -- S835: dropped first. ON COMMIT DROP keeps it until the transaction ends, so a second call in
  -- one transaction failed with 42P07.
  DROP TABLE IF EXISTS pg_temp._plan;
  CREATE TEMP TABLE _plan (
$n$);
  v_def := pg_temp.s835_patch(v_def,
$o$               CASE WHEN d.id IS NULL AND c.id IS NOT NULL THEN 'matched an existing recipe with the same code'
                    WHEN d.id IS NULL AND n.id IS NOT NULL THEN 'matched an existing recipe of the same name'
                    WHEN v_vat_differs AND s.category IS DISTINCT FROM 'Sub-Recipe' THEN NULL
                    -- S809 2h: what a NEW dish arrives as (the INSERT below copies HQ's price
                    -- whether or not prices were asked for), and a price push never blanks a
                    -- branch's price with one HQ does not have.
                    WHEN d.id IS NULL AND s.category IS DISTINCT FROM 'Sub-Recipe'
                         AND NOT COALESCE(s.selling_price > 0, false)
                      THEN 'added OFF the till with no price: HQ has not priced it yet. Set its price at this branch, then switch it On POS'
                    WHEN d.id IS NULL AND s.category IS DISTINCT FROM 'Sub-Recipe'
                      THEN 'added at HQ''s price, ' ||
$o$,
$n$               -- S835: the match is said on its own, and the price clause after it follows a matched
               -- dish too: the apply writes HQ's price over the branch's own when prices are pushed,
               -- and the preview used to stop at the match.
               CASE WHEN d.id IS NULL AND c.id IS NOT NULL THEN 'matched an existing recipe with the same code'
                    WHEN d.id IS NULL AND n.id IS NOT NULL THEN 'matched an existing recipe of the same name' END,
               CASE WHEN v_vat_differs AND s.category IS DISTINCT FROM 'Sub-Recipe' THEN NULL
                    -- S809 2h: what a NEW dish arrives as (the INSERT below copies HQ's price
                    -- whether or not prices were asked for), and a price push never blanks a
                    -- branch's price with one HQ does not have.
                    WHEN COALESCE(d.id, c.id, n.id) IS NULL AND s.category IS DISTINCT FROM 'Sub-Recipe'
                         AND NOT COALESCE(s.selling_price > 0, false)
                      THEN 'added OFF the till with no price: HQ has not priced it yet. Set its price at this branch, then switch it On POS'
                    WHEN COALESCE(d.id, c.id, n.id) IS NULL AND s.category IS DISTINCT FROM 'Sub-Recipe'
                      THEN 'added at HQ''s price, ' ||
$n$);
  v_def := pg_temp.s835_patch(v_def,
$o$                      THEN 'selling price left as the branch has it: HQ has no price for it'
                    WHEN v_do_prc THEN 'selling price included'
$o$,
$n$                      THEN 'selling price left as the branch has it: HQ has no price for it'
                    WHEN v_do_prc AND d.id IS NULL AND COALESCE(s.selling_price > 0, false)
                      THEN 'its selling price is replaced with HQ''s'
                    WHEN v_do_prc THEN 'selling price included'
$n$);
  EXECUTE v_def;
END;
$do$;


-- ── 9. A dish's two switches are never blank ──────────────────────────────────────────────────
ALTER TABLE public.recipes
  ALTER COLUMN is_active SET NOT NULL,
  ALTER COLUMN pos_enabled SET NOT NULL;


-- ── 10. Parking slips by date ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS pos_parking_slips_client_time_in_idx
  ON public.pos_parking_slips (client_id, time_in);


-- ── 11. Prove it ──────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_client uuid; v_other uuid;
  v_mgr    uuid; v_owner uuid; v_admin uuid;
  v_t_in uuid; v_t_out uuid; v_t_hist uuid; v_t_free uuid;
  v_dish uuid; v_gs uuid; v_reg uuid; v_half uuid;
  v_o1 uuid; v_o2 uuid; v_conf uuid; v_emp uuid;
  v_res_late uuid; v_res_due uuid;
  v_hint text; v_detail text; v_s text; v_n integer; v_fy text;
  v_gowner uuid; v_hq uuid; v_branch uuid;
  v_push text := 'skipped: no outlet group with an HQ, a branch and an Owner';
BEGIN
  -- ── Where: a POS outlet with settings, an unblocked POS manager till login and an Owner ───────
  SELECT c.id INTO v_client
    FROM public.clients c
   WHERE c.pos_enabled AND COALESCE(public.client_access_open(c.id), false)
     AND EXISTS (SELECT 1 FROM public.settings s WHERE s.client_id = c.id)
     AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.client_id = c.id AND p.active_client_id IS NULL
                    AND p.pos_role = 'manager' AND p.pos_email IS NOT NULL
                    AND p.settlement_blocked_by IS NULL AND p.pos_blocked_at IS NULL)
     AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.client_id = c.id
                    AND COALESCE(p.active_client_id, p.client_id) = c.id AND p.role = 'client'
                    AND p.pos_role IS NULL AND p.pos_email IS NULL AND p.ims_role IS NULL
                    AND p.hr_role IS NULL AND NOT COALESCE(p.hr_self_service, false))
   ORDER BY (c.name = 'BLOOM CAFE') DESC, c.name LIMIT 1;
  IF v_client IS NULL THEN
    RAISE EXCEPTION 'S835 probe: no POS outlet with settings, an unblocked POS manager and an Owner';
  END IF;
  SELECT p.id INTO v_mgr FROM public.profiles p
   WHERE p.client_id = v_client AND p.active_client_id IS NULL AND p.pos_role = 'manager' AND p.pos_email IS NOT NULL
     AND p.settlement_blocked_by IS NULL AND p.pos_blocked_at IS NULL ORDER BY p.id LIMIT 1;
  SELECT p.id INTO v_owner FROM public.profiles p
   WHERE p.client_id = v_client AND COALESCE(p.active_client_id, p.client_id) = v_client AND p.role = 'client'
     AND p.pos_role IS NULL AND p.pos_email IS NULL AND p.ims_role IS NULL
     AND p.hr_role IS NULL AND NOT COALESCE(p.hr_self_service, false)
   ORDER BY p.id LIMIT 1;
  SELECT p.id INTO v_admin FROM public.profiles p WHERE p.role = 'admin' ORDER BY p.id LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'S835 probe: no Crest operator login to stand in for "Crest support"';
  END IF;
  SELECT c.id INTO v_other FROM public.clients c WHERE c.id <> v_client ORDER BY c.id LIMIT 1;
  IF EXISTS (SELECT 1 FROM public.pos_orders WHERE client_id = v_client AND order_no BETWEEN 990871 AND 990879) THEN
    RAISE EXCEPTION 'S835 probe: a probe order number is already in use at this outlet';
  END IF;
  v_fy := public.pos_invoice_fy(now());

  BEGIN
    PERFORM set_config('request.headers', '{"x-crest-build":"crest-v999999"}', true);

    -- ── Setup, as the migration's own role ────────────────────────────────────────────────────
    -- The manager stand-in loses every other staff marker (a restrictive policy would otherwise
    -- turn an "allowed" into a vacuous 0 rows).
    UPDATE public.profiles SET ims_role = NULL, hr_role = NULL, hr_self_service = false WHERE id = v_mgr;
    INSERT INTO public.pos_tables (client_id, name) VALUES (v_client, 'S835 probe in') RETURNING id INTO v_t_in;
    INSERT INTO public.pos_tables (client_id, name, status) VALUES (v_client, 'S835 probe out', 'inactive') RETURNING id INTO v_t_out;
    INSERT INTO public.pos_tables (client_id, name) VALUES (v_client, 'S835 probe history') RETURNING id INTO v_t_hist;
    INSERT INTO public.pos_tables (client_id, name) VALUES (v_client, 'S835 probe free') RETURNING id INTO v_t_free;
    UPDATE public.clients SET customization_enabled = true WHERE id = v_client AND NOT public.customization_live(v_client);
    INSERT INTO public.recipes (client_id, name, category, selling_price, vat_rate, is_active, pos_enabled)
      VALUES (v_client, 'S835 probe bowl', 'Food', 70.80, 0, true, true) RETURNING id INTO v_dish;
    INSERT INTO public.pos_option_groups (client_id, name, kind, min_select, max_select, included_count, size_scaling, sort, is_active)
      VALUES (v_client, 'S835 probe Size', 'size', 1, 1, 0, 'none', 900, true) RETURNING id INTO v_gs;
    INSERT INTO public.pos_options (client_id, group_id, name, price_delta, portion_factor, sort, is_active)
      VALUES (v_client, v_gs, 'Regular', 0, 1, 0, true) RETURNING id INTO v_reg;
    INSERT INTO public.pos_options (client_id, group_id, name, price_delta, portion_factor, sort, is_active)
      VALUES (v_client, v_gs, 'Half', -88.50, 0.5, 1, true) RETURNING id INTO v_half;
    INSERT INTO public.pos_recipe_option_groups (client_id, recipe_id, group_id, sort)
      VALUES (v_client, v_dish, v_gs, 0);

    -- ── (7) a guest's Half takes the dish below zero: its own hint, the dish named ─────────────
    SET LOCAL ROLE anon;
    v_hint := NULL; v_detail := NULL;
    BEGIN
      PERFORM public.submit_guest_order(v_t_in,
        jsonb_build_array(jsonb_build_object('recipe_id', v_dish, 'qty', 1, 'options', jsonb_build_array(v_half))), NULL, 1, NULL);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_detail = PG_EXCEPTION_DETAIL;
    END;
    RESET ROLE;
    IF v_hint IS DISTINCT FROM 'below_zero_options' OR COALESCE(v_detail, '') NOT LIKE '%S835 probe bowl%' THEN
      RAISE EXCEPTION 'S835 probe: a guest''s below-zero dish answered % (%)', COALESCE(v_hint, 'nothing'), COALESCE(v_detail, '');
    END IF;

    -- ── (1) as the manager: no new order on a table out of service; one in service opens ───────
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_mgr)::text, true);
    SET LOCAL ROLE authenticated;
    v_hint := NULL;
    BEGIN
      INSERT INTO public.pos_orders (client_id, order_no, table_id, table_name) VALUES (v_client, 990871, v_t_out, 'S835 probe out');
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    END;
    INSERT INTO public.pos_orders (client_id, order_no, table_id, table_name)
      VALUES (v_client, 990872, v_t_in, 'S835 probe in') RETURNING id INTO v_o1;
    RESET ROLE;
    IF v_hint IS DISTINCT FROM 'pos_table_inactive_new_order' OR v_o1 IS NULL THEN
      RAISE EXCEPTION 'S835 probe: an order on a table out of service answered %, one in service %', COALESCE(v_hint, 'nothing'), v_o1;
    END IF;

    -- ── (6) a QR payment matched to that open bill; the manager clears the bill ────────────────
    INSERT INTO public.pos_payment_confirmations (client_id, provider, amount, txn_ref, matched_order_id)
      VALUES (v_client, 'fonepay', 1, 'S835-probe', v_o1) RETURNING id INTO v_conf;
    SET LOCAL ROLE authenticated;
    DELETE FROM public.pos_orders WHERE id = v_o1;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RESET ROLE;
    IF v_n <> 1 OR (SELECT matched_order_id FROM public.pos_payment_confirmations WHERE id = v_conf) IS NOT NULL THEN
      RAISE EXCEPTION 'S835 probe: clearing a bill with a matched QR payment deleted % row(s), and left the payment matched to %',
        v_n, (SELECT matched_order_id FROM public.pos_payment_confirmations WHERE id = v_conf);
    END IF;

    -- ── (2) a table with a closed bill is not deleted; an unused one is ────────────────────────
    INSERT INTO public.pos_orders (client_id, order_no, table_id, table_name)
      VALUES (v_client, 990873, v_t_hist, 'S835 probe history') RETURNING id INTO v_o2;
    INSERT INTO public.pos_order_items (order_id, client_id, name, recipe_id, qty, unit_price, vat_rate)
      VALUES (v_o2, v_client, 'S835 probe bowl', v_dish, 1, 70.80, 0);
    UPDATE public.pos_orders
       SET status = 'billed', close_type = 'paid', payment_method = 'Cash', discount_amount = 0, paid_amount = 70.80,
           vat_registered = false, invoice_fy = v_fy, closed_at = now()
     WHERE id = v_o2;
    SET LOCAL ROLE authenticated;
    v_hint := NULL;
    BEGIN
      DELETE FROM public.pos_tables WHERE id = v_t_hist;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    END;
    DELETE FROM public.pos_tables WHERE id = v_t_free;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RESET ROLE;
    IF v_hint IS DISTINCT FROM 'pos_table_has_bills' OR v_n <> 1
       OR NOT EXISTS (SELECT 1 FROM public.pos_tables WHERE id = v_t_hist) THEN
      RAISE EXCEPTION 'S835 probe: deleting a table with a bill answered %; an unused one deleted % row(s)', COALESCE(v_hint, 'nothing'), v_n;
    END IF;

    -- ── (3) a no-show before the booked time is refused; after it, it lands ────────────────────
    INSERT INTO public.pos_reservations (client_id, customer_name, phone, party_size, reserved_for, status)
      VALUES (v_client, 'S835 probe later', '9800000835', 2, now() + interval '1 day', 'booked') RETURNING id INTO v_res_late;
    INSERT INTO public.pos_reservations (client_id, customer_name, phone, party_size, reserved_for, status)
      VALUES (v_client, 'S835 probe due', '9800000836', 2, now() - interval '1 hour', 'booked') RETURNING id INTO v_res_due;
    SET LOCAL ROLE authenticated;
    v_hint := NULL;
    BEGIN
      UPDATE public.pos_reservations SET status = 'no_show', no_show_at = now() WHERE id = v_res_late;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    END;
    UPDATE public.pos_reservations SET status = 'no_show', no_show_at = now() WHERE id = v_res_due;
    RESET ROLE;
    IF v_hint IS DISTINCT FROM 'reservation_no_show_early'
       OR (SELECT status FROM public.pos_reservations WHERE id = v_res_due) IS DISTINCT FROM 'no_show'
       OR (SELECT status FROM public.pos_reservations WHERE id = v_res_late) IS DISTINCT FROM 'booked' THEN
      RAISE EXCEPTION 'S835 probe: an early no-show answered %; the due one is %', COALESCE(v_hint, 'nothing'),
        (SELECT status FROM public.pos_reservations WHERE id = v_res_due);
    END IF;

    -- ── (5) PIN resets: the Owner reads the latest per login, the operator as "Crest support";
    --        the manager is refused ───────────────────────────────────────────────────────────
    INSERT INTO public.audit_logs (client_id, client_name, user_id, user_name, table_name, action, record_id, new_data)
      VALUES (v_client, 'S835 probe', v_mgr, 'S835 probe manager', 'staff_pin_vault', 'UPDATE', v_mgr,
              '{"kind":"pos","staff_member":"S835","pin_reset":true}'::jsonb);
    INSERT INTO public.audit_logs (client_id, client_name, user_id, user_name, table_name, action, record_id, new_data)
      VALUES (v_client, 'S835 probe', v_admin, 'operator@example.invalid', 'staff_pin_vault', 'UPDATE', v_mgr,
              '{"kind":"pos","staff_member":"S835","pin_reset":true}'::jsonb);
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_owner)::text, true);
    SET LOCAL ROLE authenticated;
    SELECT r.reset_by_name INTO v_s FROM public.get_staff_pin_resets(v_client) r WHERE r.user_id = v_mgr;
    RESET ROLE;
    IF v_s IS DISTINCT FROM 'Crest support' THEN
      RAISE EXCEPTION 'S835 probe: the Owner read the latest PIN reset as by %', COALESCE(v_s, 'nobody');
    END IF;
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_mgr)::text, true);
    SET LOCAL ROLE authenticated;
    v_hint := NULL;
    BEGIN
      PERFORM * FROM public.get_staff_pin_resets(v_client);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    END;
    RESET ROLE;
    PERFORM set_config('request.jwt.claims', '', true);
    IF v_hint IS DISTINCT FROM 'pin_resets_owner_only' THEN
      RAISE EXCEPTION 'S835 probe: a POS manager reading PIN resets answered %', COALESCE(v_hint, 'nothing');
    END IF;

    -- ── (4) Unblock: allowed while every linked record is current, refused once one is gone ─────
    IF public.pos_set_login_blocked(v_mgr, true, NULL) IS DISTINCT FROM 'blocked'
       OR public.pos_set_login_blocked(v_mgr, false, NULL) IS DISTINCT FROM 'unblocked' THEN
      RAISE EXCEPTION 'S835 probe: block then unblock of a current login did not round-trip';
    END IF;
    INSERT INTO public.hr_employees (client_id, full_name, join_date, status)
      VALUES (v_other, 'S835 probe leaver', current_date - 400, 'resigned') RETURNING id INTO v_emp;
    INSERT INTO public.profile_employee_links (profile_id, client_id, employee_id) VALUES (v_mgr, v_other, v_emp);
    PERFORM public.pos_set_login_blocked(v_mgr, true, NULL);
    v_hint := NULL;
    BEGIN
      PERFORM public.pos_set_login_blocked(v_mgr, false, NULL);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    END;
    IF v_hint IS DISTINCT FROM 'pos_unblock_leaver' THEN
      RAISE EXCEPTION 'S835 probe: unblocking a login gone at a linked outlet answered %', COALESCE(v_hint, 'unblocked');
    END IF;

    -- ── (9) a blank switch is refused ─────────────────────────────────────────────────────────
    v_s := 'accepted';
    BEGIN
      INSERT INTO public.recipes (client_id, name, category, is_active) VALUES (v_client, 'S835 probe blank', 'Food', NULL);
    EXCEPTION WHEN not_null_violation THEN
      GET STACKED DIAGNOSTICS v_s = COLUMN_NAME;
    END;
    IF v_s IS DISTINCT FROM 'is_active' THEN
      RAISE EXCEPTION 'S835 probe: a recipe with a blank is_active was %', v_s;
    END IF;

    -- ── (8) as an outlet group's Owner: two previews in one transaction, and a dish matched by
    --        name says its price is replaced ─────────────────────────────────────────────────────
    SELECT p.id, g.hq_client_id INTO v_gowner, v_hq
      FROM public.profiles p
      JOIN public.clients c ON c.id = p.client_id
      JOIN public.client_groups g ON g.id = c.group_id
     WHERE g.hq_client_id IS NOT NULL AND p.role = 'client'
       AND p.pos_role IS NULL AND p.pos_email IS NULL AND p.ims_role IS NULL
       AND p.hr_role IS NULL AND NOT COALESCE(p.hr_self_service, false)
       AND EXISTS (SELECT 1 FROM public.clients b WHERE b.group_id = g.id AND b.id <> g.hq_client_id)
     ORDER BY p.id LIMIT 1;
    IF v_gowner IS NOT NULL THEN
      SELECT b.id INTO v_branch FROM public.clients b JOIN public.clients h ON h.id = v_hq
       WHERE b.group_id = h.group_id AND b.id <> v_hq ORDER BY b.id LIMIT 1;
      INSERT INTO public.recipes (client_id, name, category, selling_price, vat_rate, is_active, pos_enabled)
        VALUES (v_hq, 'S835 probe match', 'Food', 250, 0, true, true);
      INSERT INTO public.recipes (client_id, name, category, selling_price, vat_rate, is_active, pos_enabled)
        VALUES (v_branch, 'S835 probe match', 'Food', 200, 0, true, true);
      PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_gowner)::text, true);
      SET LOCAL ROLE authenticated;
      PERFORM * FROM public.push_master_data(ARRAY[v_branch], ARRAY['recipes', 'prices'], true);
      SELECT x.detail INTO v_s FROM public.push_master_data(ARRAY[v_branch], ARRAY['recipes', 'prices'], true) x
       WHERE x.entity = 'recipes' AND x.record_name = 'S835 probe match';
      RESET ROLE;
      PERFORM set_config('request.jwt.claims', '', true);
      IF COALESCE(v_s, '') NOT LIKE 'matched an existing recipe of the same name%'
         OR (COALESCE(v_s, '') NOT LIKE '%replaced with HQ%' AND COALESCE(v_s, '') NOT LIKE '%left as this branch has them%') THEN
        RAISE EXCEPTION 'S835 probe: the second preview said "%" for a dish matched by name', COALESCE(v_s, 'nothing');
      END IF;
      v_push := 'ran twice: ' || v_s;
    END IF;

    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('request.headers', '', true);
    RAISE NOTICE 'S835 probe: menu-copy preview %', v_push;
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 's835_probe_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 's835_probe_rollback' THEN RAISE; END IF;
  END;
END;
$$;


NOTIFY pgrst, 'reload schema';


-- ── 12. What this file changed, live (the last statement, so `db query` prints it) ────────────
SELECT
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.guard_pos_order_insert()'::regprocedure) = 'becdecf2d6d114379a735e44749b3e73' AS insert_guard_ok,
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.pos_tables_guard_open_order_delete()'::regprocedure) = 'c46a03a89678e82c41129a2a31b3fabe' AS table_delete_ok,
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.pos_set_login_blocked(uuid, boolean, uuid)'::regprocedure) = '0804c5f22df300632dcca4f6eb75c427' AS unblock_ok,
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.submit_guest_order(uuid, jsonb, text, integer, uuid)'::regprocedure) = '05b2d225a29979180405ce7660813a3b' AS guest_submit_ok,
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.push_master_data(uuid[], text[], boolean)'::regprocedure) = '7d934093b1453b707436476cb4f92263' AS push_ok,
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.pos_reservations_guard_no_show()'::regprocedure) = '9bd2add296f78c29e39376e24c9859fd' AS no_show_ok,
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.get_staff_pin_resets(uuid)'::regprocedure) = '05f0dab08bf2ad386dfa0a9bc6d66e51' AS resets_ok,
  (SELECT string_agg(tgname, ', ' ORDER BY tgname) FROM pg_trigger WHERE tgrelid = 'public.pos_reservations'::regclass AND tgname = 'pos_reservations_guard_no_show') AS no_show_trigger,
  has_function_privilege('anon', 'public.get_staff_pin_resets(uuid)', 'EXECUTE') AS anon_can_read_resets,
  has_function_privilege('authenticated', 'public.get_staff_pin_resets(uuid)', 'EXECUTE') AS logins_can_call_resets,
  (SELECT confdeltype::text FROM pg_constraint WHERE conname = 'pos_payment_confirmations_matched_order_id_fkey') AS confirmation_on_delete,
  (SELECT string_agg(a.attname::text || ':' || a.attnotnull::text, ', ' ORDER BY a.attname)
     FROM pg_attribute a WHERE a.attrelid = 'public.recipes'::regclass AND a.attname IN ('is_active', 'pos_enabled')) AS recipe_switches_not_null,
  (SELECT a.attname::text FROM pg_index i JOIN pg_class x ON x.oid = i.indexrelid
     JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[1]
    WHERE x.relname = 'pos_parking_slips_client_time_in_idx' AND i.indkey[0] = (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.pos_parking_slips'::regclass AND attname = 'client_id')) AS slip_index_second_column;
