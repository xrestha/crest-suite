-- S708 — the Vendors delete guard stops being advice.
--
-- S671 built the guard in the browser and built it well: Vendors.js enumerates all four
-- referencing tables, re-reads the counts at click time rather than trusting its page-load
-- snapshot, fails CLOSED when that re-read errors, and offers Archive as the lossless alternative.
-- Every one of those is necessary. None of them is a guard, for the reason S707 had just written
-- down one table over: a delete guard that lives only in the page is a guard on the page, not on
-- the table.
--
-- WHAT THE BROWSER GUARD DOES NOT COVER
--
-- `vendors` carries one permissive policy after the S542 consolidation —
-- `client_id = my_client_id() OR is_admin()`, FOR ALL — plus RESTRICTIVE fences excluding POS PIN
-- staff and HR self-service (S316). There is no `no_ims_staff` fence, because IMS needs the
-- supplier list. So the accounts that can issue `DELETE /rest/v1/vendors?id=eq.<uuid>` with
-- nothing but their own JWT and the public anon key are: admin, the Owner, and EVERY IMS account
-- of any rank — including `ims_role = 'staff'`, which cannot open the Vendors page at all
-- (`hasImsAccess('supervisor')` in Vendors.js, `minImsRole: 'supervisor'` on the nav item), and
-- for whom the page's admin-only Delete control does not render in the first place.
--
-- What that delete does splits two/two, and the two halves fail in opposite directions:
--
--   purchase_entries, purchase_orders   plain FK        Postgres REFUSES; nothing is lost
--   vendor_returns, ims_gate_passes     ON DELETE SET NULL   the delete SUCCEEDS, silently
--
-- So a guard that leans on "the database will stop me" is right about two tables and wrong about
-- two, with no error on the wrong half — the `confdeltype` rule, which was learned on this very
-- table and then only ever enforced in JavaScript.
--
-- The recoverability picture is worse here than it was for items, and in a specific way worth
-- stating. `ims_gate_passes` keeps a `vendor_name` of its own, so it loses only the link.
-- `vendor_returns` keeps NO name — the `vendors` row is the only copy — and while its `log_audit`
-- trigger does record the SET NULL as an UPDATE with the old `vendor_id` in the OLD snapshot, that
-- id now resolves to a row that no longer exists: `vendors` itself carries no audit trigger, so
-- the deleted row leaves no snapshot anywhere and the supplier's NAME is gone for good. A return
-- is money credited back by a supplier the client can no longer identify.
--
-- WHY A TRIGGER AND NOT A `SECURITY DEFINER` RPC
--
-- Privilege invariant #3 settled this shape already: S576/S579 chose triggers "rather than RPCs,
-- because an RPC protects only the callers that choose to call it and leaves the open policy in
-- place." A `delete_vendor()` RPC would leave `vendors_all` FOR ALL exactly as wide as it is today
-- and protect only Vendors.js, which is the one caller that already behaves. It also would not fix
-- the second half of the problem, which is not about REST at all: the page's own click-time
-- re-check and its DELETE are two round trips, so a bill entered on another till in between is
-- checked before it exists and deleted around afterwards. A BEFORE DELETE trigger is inside the
-- same statement, which is the only place that race closes.
--
-- SECURITY INVOKER for the same reason `guard_profiles_privileged_columns()` is: `current_user` is
-- the seam that lets the service role through, and under DEFINER it would be the owner every time
-- and the carve-out could never fire.
--
-- WHY THERE IS NO `force_delete_vendor()`
--
-- Deliberate, and the one place this migration departs from its S707 sibling. `force_delete_item`
-- exists because an item can be a genuine mis-entry that someone needs gone along with the handful
-- of rows attached to it. A vendor with history is not that: it is a supplier the client really did
-- buy from, and the only thing a force-delete could do is destroy the purchase record that proves
-- it. S671 already shipped the right answer — `archived_at` keeps the row so every FK, join and
-- report is untouched, and takes the vendor off the page and out of every picker, reversibly. So
-- the sanctioned way through is Archive, and this trigger has no bypass for a client account of
-- any rank, operator included. The service role remains the escape hatch it is everywhere else,
-- which is what keeps Danger Zone and support tooling working.
--
-- A NOTE ON DELETING A CLIENT. `vendors_client_id_fkey` is ON DELETE CASCADE, and ClientDrawer
-- deletes the `clients` row from the browser. That sequence runs `deleteClientData` (service role)
-- first, which empties purchase_entries, purchase_orders, vendor_returns and ims_gate_passes well
-- before it reaches `vendors` — so the cascade normally fires on rows that reference nothing. If
-- that step failed partway, the client-row delete now REFUSES instead of cascading a half-deleted
-- vendor list away silently, and ClientDrawer's own handler already says the right thing ("Run
-- Delete Client again to finish"), which re-runs the service-role step.

-- ── (a) The lookup ──────────────────────────────────────────────────────────────────────────
--
-- One row per (vendor, referencing table) that actually holds a row. SECURITY DEFINER because a
-- guard that drops its read passes vacuously: `ims_gate_passes` and `vendor_returns` sit behind
-- restrictive fences that `vendors` does not, so a caller whose RLS view of those is narrower than
-- its view of `vendors` would otherwise be told the vendor is unreferenced — the guard failing open
-- for exactly the accounts it exists to stop. The caller check is on the VENDOR's client, wrapped
-- in COALESCE per the fail-open rule, and the service role is recognised by the absence of a JWT
-- subject rather than by name.
--
-- Output columns are `ref_vendor_id` / `ref_table` / `ref_count`, not `vendor_id`: a RETURNS TABLE
-- column name is in scope inside the body, and `vendor_id` is a real column on all four tables, so
-- naming it that makes every reference to it ambiguous.
--
-- The table list is the SQL twin of `VENDOR_REF_TABLES` in `src/modules/ims/vendors/Vendors.js`.
-- The two must not diverge: the page's list decides what the reader is TOLD is attached, this one
-- decides what is actually refused.

CREATE OR REPLACE FUNCTION public.vendor_reference_counts(p_ids uuid[])
RETURNS TABLE (ref_vendor_id uuid, ref_table text, ref_count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
  WITH scoped AS (
    SELECT v.id
      FROM vendors v
     WHERE v.id = ANY (p_ids)
       AND COALESCE(
             (select auth.uid()) IS NULL
             OR is_admin()
             OR v.client_id = my_client_id(),
             false)
  ), refs AS (
              SELECT 'purchase_entries'::text AS t, x.vendor_id FROM purchase_entries x JOIN scoped s ON s.id = x.vendor_id
    UNION ALL SELECT 'purchase_orders',           x.vendor_id FROM purchase_orders   x JOIN scoped s ON s.id = x.vendor_id
    UNION ALL SELECT 'vendor_returns',            x.vendor_id FROM vendor_returns    x JOIN scoped s ON s.id = x.vendor_id
    UNION ALL SELECT 'ims_gate_passes',           x.vendor_id FROM ims_gate_passes   x JOIN scoped s ON s.id = x.vendor_id
  )
  SELECT r.vendor_id, r.t, count(*)::bigint
    FROM refs r
   GROUP BY r.vendor_id, r.t;
$fn$;

REVOKE EXECUTE ON FUNCTION public.vendor_reference_counts(uuid[]) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.vendor_reference_counts(uuid[]) TO authenticated, service_role;

-- ── (b) The delete guard ────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.vendors_guard_referenced_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
DECLARE
  v_tables text;
BEGIN
  -- SECURITY INVOKER on purpose (see the header): `current_user` is the only thing that separates
  -- a browser JWT from the service role, and the service role has to stay able to empty a client.
  IF current_user IN ('anon', 'authenticated') THEN
    SELECT string_agg(DISTINCT r.ref_table, ', ' ORDER BY r.ref_table)
      INTO v_tables
      FROM vendor_reference_counts(ARRAY[OLD.id]) r;

    IF v_tables IS NOT NULL THEN
      RAISE EXCEPTION 'vendor_has_references: vendor % is referenced in %', OLD.id, v_tables
        USING ERRCODE = 'P0001',
              HINT = 'Deactivate the vendor and then archive it — the row is kept and hidden, so every past record keeps its supplier.';
    END IF;
  END IF;
  RETURN OLD;
END;
$fn$;

DROP TRIGGER IF EXISTS vendors_guard_referenced_delete ON public.vendors;
CREATE TRIGGER vendors_guard_referenced_delete
  BEFORE DELETE ON public.vendors
  FOR EACH ROW EXECUTE FUNCTION public.vendors_guard_referenced_delete();

NOTIFY pgrst, 'reload schema';

-- Verification ---------------------------------------------------------------------------------
--   -- the trigger is attached and enabled
--   SELECT tgname, tgenabled FROM pg_trigger
--    WHERE tgrelid = 'public.vendors'::regclass AND NOT tgisinternal;
--
--   -- the lookup is not reachable by anon, and is DEFINER while the guard is INVOKER
--   SELECT has_function_privilege('anon', 'public.vendor_reference_counts(uuid[])', 'EXECUTE'); -- false
--   SELECT proname, prosecdef FROM pg_proc
--    WHERE proname IN ('vendor_reference_counts', 'vendors_guard_referenced_delete');
--
--   -- and the guard actually refuses on the half the FKs do not cover. Run as a client JWT, in a
--   -- transaction you roll back — before this migration the DELETE below SUCCEEDED:
--   BEGIN;
--     DELETE FROM vendors WHERE id = '<a vendor with only a vendor_return or gate pass>';
--     -- expect P0001 vendor_has_references
--   ROLLBACK;
--
--   -- a vendor nothing points at still deletes, which is the case Vendors.js offers Delete on
--   BEGIN;
--     DELETE FROM vendors WHERE id = '<a vendor with no records>';  -- expect DELETE 1
--   ROLLBACK;
