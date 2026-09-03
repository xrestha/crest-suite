-- Vendors: an ARCHIVE state, so a supplier that has been bought from can leave the Vendors page
-- without taking its name off the records that reference it.
--
-- Why the row cannot simply be deleted. Every report that names a vendor on a historical record
-- resolves that name by JOINING `vendors` (purchase_entries, purchase_orders and vendor_returns
-- store only `vendor_id`; `ims_gate_passes` is the sole table keeping a `vendor_name` of its own).
-- So the name lives in exactly one place, and deleting the row is what erases it from history.
--
-- Nor would a delete fail safely. purchase_entries and purchase_orders hold a plain FK, so Postgres
-- refuses and nothing is lost — but vendor_returns and ims_gate_passes are ON DELETE SET NULL, so
-- there the delete SUCCEEDS and those rows quietly lose their supplier, with nothing on any screen
-- to say it happened. Half the tables would be protected and half would not.
--
-- Archiving keeps the row, so every FK, join and report is untouched and history keeps its name,
-- and takes the vendor off the Vendors page and out of every vendor picker. It is reversible:
-- clearing archived_at puts it back on the page as an inactive vendor.
--
-- A hard DELETE remains available, and only where it is genuinely free: a vendor nothing points at.

ALTER TABLE public.vendors ADD COLUMN IF NOT EXISTS archived_at timestamptz;

COMMENT ON COLUMN public.vendors.archived_at IS
  'Set when the vendor was removed from the Vendors page while its name stays resolvable on historical records. NULL means live. Archived vendors are always inactive.';

-- Enforced here rather than left to the UI, because `is_active` is the column every purchase,
-- purchase-order and gate-pass picker filters on: an archived vendor that stayed active would keep
-- appearing in the dropdowns it was archived to leave. Restoring clears archived_at and leaves the
-- vendor inactive, so the two never have to be reasoned about in the same write.
ALTER TABLE public.vendors DROP CONSTRAINT IF EXISTS vendors_archived_is_inactive;
ALTER TABLE public.vendors ADD CONSTRAINT vendors_archived_is_inactive
  CHECK (archived_at IS NULL OR is_active IS NOT TRUE);

-- No grant or policy change: grants are table-level and the existing vendors policies already
-- cover this column.

notify pgrst, 'reload schema';
