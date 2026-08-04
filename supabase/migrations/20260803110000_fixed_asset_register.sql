-- Fixed Asset Register (Pro IMS) — tangible fixed assets for a client's business (equipment,
-- furniture, vehicles, kitchen machinery), NOT the items/ims stock system and NOT internal Bloom
-- Hospitality assets. assets_ prefix per explicit instruction, consistent with ims_gate_passes'
-- ims_ precedent and pos_/hr_ module prefixes.

CREATE TABLE public.assets_categories (
    id                        uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    client_id                 uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
    name                      text NOT NULL,
    default_useful_life_years numeric(5,2),
    default_depreciation_method text DEFAULT 'straight_line'
        CHECK (default_depreciation_method = 'straight_line'), -- only BOOK method in v1
    -- Nepal Income Tax Act pooled-WDV tax pool this category's assets typically belong to (A-E) —
    -- seeds assets_register.tax_pool at asset-creation time, load-bearing (not just a label).
    tax_pool_hint             text CHECK (tax_pool_hint IN ('A','B','C','D','E')),
    sort_order                integer DEFAULT 0,
    created_at                timestamp with time zone DEFAULT now()
);

CREATE TABLE public.assets_register (
    id                     uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    client_id              uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
    -- No ON DELETE, mirrors items.category_id -> categories(id): deleting a category with assets
    -- still assigned must fail loudly, not silently orphan them.
    category_id            uuid REFERENCES public.assets_categories(id),
    asset_code             text,              -- auto-assigned "AST-0001" by trigger below
    name                   text NOT NULL,
    description            text,
    location               text,
    quantity               numeric NOT NULL DEFAULT 1 CHECK (quantity > 0),
    unit_cost              numeric NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
    total_cost             numeric GENERATED ALWAYS AS ((quantity * unit_cost)) STORED,
    acquisition_date       date NOT NULL,
    useful_life_years      numeric(5,2) NOT NULL CHECK (useful_life_years > 0),
    salvage_value          numeric NOT NULL DEFAULT 0 CHECK (salvage_value >= 0),
    depreciation_method    text NOT NULL DEFAULT 'straight_line'
                             CHECK (depreciation_method = 'straight_line'), -- BOOK depreciation only
    -- Nepal tax pool (A-E), seeded from category.tax_pool_hint, overridable — same seed-then-
    -- freely-editable pattern as depreciation_method. NULL = not tracked for Nepal tax pooling.
    tax_pool               text CHECK (tax_pool IN ('A','B','C','D','E')),
    personal_use_percent   numeric NOT NULL DEFAULT 0
                             CHECK (personal_use_percent >= 0 AND personal_use_percent <= 100),
    status                 text NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active', 'disposed', 'written_off')),
    disposal_date          date,
    disposal_proceeds      numeric,
    disposal_gain_loss     numeric,          -- frozen at disposal time (depreciationCompute.js)
    last_physically_verified_at date,
    custodian_user_id      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    department             text,             -- free-form cost center for v1
    notes                  text,
    created_by             uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    updated_at             timestamp with time zone DEFAULT now(),
    created_at             timestamp with time zone DEFAULT now()
);

CREATE INDEX assets_register_client_status_idx ON public.assets_register (client_id, status);
CREATE UNIQUE INDEX assets_register_client_asset_code_key ON public.assets_register (client_id, asset_code);

CREATE TABLE public.assets_depreciation_runs (
    id            uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    client_id     uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
    period_start  date NOT NULL,
    period_end    date NOT NULL,
    -- Preview is pure client-side computation (writes nothing); a run row is only ever INSERTed
    -- already 'posted'. status/CHECK kept for a future "save draft, resume later" feature — no v1
    -- code path writes 'draft'.
    status        text NOT NULL DEFAULT 'posted' CHECK (status IN ('draft', 'posted')),
    posted_at     timestamp with time zone,
    posted_by     uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_by    uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    notes         text,
    created_at    timestamp with time zone DEFAULT now()
    -- Deliberately NO UNIQUE(client_id, period_start, period_end) — a correction for a mistake in
    -- an already-posted period is a brand NEW run (possibly same period range), never an edit to
    -- the old one. Do not add this constraint later without re-reading this comment.
);

CREATE INDEX assets_depreciation_runs_client_period_idx
  ON public.assets_depreciation_runs (client_id, period_end DESC);

CREATE TABLE public.assets_depreciation_schedule (
    id                   uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    client_id            uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
    run_id               uuid NOT NULL REFERENCES public.assets_depreciation_runs(id) ON DELETE CASCADE,
    -- No ON DELETE: deleting an asset with posted depreciation history must fail loudly, not
    -- silently destroy financial records.
    asset_id             uuid NOT NULL REFERENCES public.assets_register(id),
    period_start         date NOT NULL,
    period_end           date NOT NULL,
    opening_nbv          numeric NOT NULL,
    annual_depreciation  numeric NOT NULL,
    depreciation_amount  numeric NOT NULL,  -- pro-rated + salvage-floor-clamped, pre-override
    override_amount      numeric,           -- manager's line-level override, if any
    override_reason      text,              -- required whenever override_amount is set
    closing_nbv          numeric NOT NULL,
    is_posted            boolean NOT NULL DEFAULT true,
    created_at           timestamp with time zone DEFAULT now(),
    CONSTRAINT assets_depreciation_schedule_override_reason_check
        CHECK (override_amount IS NULL OR override_reason IS NOT NULL)
);

CREATE INDEX assets_depreciation_schedule_asset_idx
  ON public.assets_depreciation_schedule (asset_id, period_end DESC);
CREATE INDEX assets_depreciation_schedule_client_period_idx
  ON public.assets_depreciation_schedule (client_id, period_end DESC);

-- ── Auto-numbered asset code ─────────────────────────────────────────────────────────────
-- Adapted from assign_pos_order_no()'s exact idiom: SECURITY DEFINER, SET search_path,
-- pg_advisory_xact_lock per client, BEFORE INSERT, IF NEW.col IS NULL guard. Genuinely new vs.
-- this codebase's other human-readable codes (item_code/po_number are computed in the FRONTEND,
-- not a DB trigger) — deliberately race-proof via the advisory lock instead, matching
-- pos_order_no's convention since assets, unlike items, could plausibly be added from two
-- sessions at once.
CREATE FUNCTION public.assign_asset_code() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_next integer;
BEGIN
  IF NEW.asset_code IS NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('asset_code:' || NEW.client_id::text));
    SELECT COALESCE(MAX((regexp_match(asset_code, '^AST-(\d+)$'))[1]::integer), 0) + 1
      INTO v_next
      FROM assets_register WHERE client_id = NEW.client_id;
    NEW.asset_code := 'AST-' || lpad(v_next::text, 4, '0');
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_assign_asset_code BEFORE INSERT ON public.assets_register
  FOR EACH ROW EXECUTE FUNCTION public.assign_asset_code();

-- ── Posted-row immutability — new, stricter than hr_payroll_runs' finalize/reopen precedent ──
-- hr_payroll_runs' "finalized = locked" is app-layer only (PayrollRun.jsx checks
-- run.status==='finalized' before writes); its correction path is an admin "Reopen" reversing
-- status in place. This spec is deliberately stricter: once posted, immutable at the DB level,
-- no reopen — a correction is a brand new run.
--
-- auth.uid() IS NOT NULL is the guard, not an unconditional block, so Danger Zone
-- (admin-user-ops, service-role client) can still wipe a client's data including posted
-- depreciation history. A service-role connection has no per-request user JWT 'sub' claim, so
-- auth.uid() reads NULL for it — the same primitive log_audit()/my_client_id() already rely on
-- (auth.uid() via a JWT claims lookup); checked directly here since a trigger, unlike RLS, isn't
-- bypassed by service_role's rolbypassrls automatically.
CREATE FUNCTION public.enforce_asset_schedule_immutable() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND OLD.is_posted = true THEN
    RAISE EXCEPTION 'Posted depreciation schedule rows are immutable — post a new adjustment run instead of editing this one.';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER trg_enforce_asset_schedule_immutable
  BEFORE UPDATE OR DELETE ON public.assets_depreciation_schedule
  FOR EACH ROW EXECUTE FUNCTION public.enforce_asset_schedule_immutable();

-- ── RLS: standard same-client policy (all 4 tables) ────────────────────────────────────────
ALTER TABLE public.assets_categories            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assets_register              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assets_depreciation_runs     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assets_depreciation_schedule ENABLE ROW LEVEL SECURITY;

CREATE POLICY assets_categories_client ON public.assets_categories FOR ALL
  USING ((SELECT role FROM profiles WHERE id = auth.uid()) = 'admin'
         OR client_id = (SELECT client_id FROM profiles WHERE id = auth.uid()))
  WITH CHECK ((SELECT role FROM profiles WHERE id = auth.uid()) = 'admin'
         OR client_id = (SELECT client_id FROM profiles WHERE id = auth.uid()));

CREATE POLICY assets_register_client ON public.assets_register FOR ALL
  USING ((SELECT role FROM profiles WHERE id = auth.uid()) = 'admin'
         OR client_id = (SELECT client_id FROM profiles WHERE id = auth.uid()))
  WITH CHECK ((SELECT role FROM profiles WHERE id = auth.uid()) = 'admin'
         OR client_id = (SELECT client_id FROM profiles WHERE id = auth.uid()));

CREATE POLICY assets_depreciation_runs_client ON public.assets_depreciation_runs FOR ALL
  USING ((SELECT role FROM profiles WHERE id = auth.uid()) = 'admin'
         OR client_id = (SELECT client_id FROM profiles WHERE id = auth.uid()))
  WITH CHECK ((SELECT role FROM profiles WHERE id = auth.uid()) = 'admin'
         OR client_id = (SELECT client_id FROM profiles WHERE id = auth.uid()));

CREATE POLICY assets_depreciation_schedule_client ON public.assets_depreciation_schedule FOR ALL
  USING ((SELECT role FROM profiles WHERE id = auth.uid()) = 'admin'
         OR client_id = (SELECT client_id FROM profiles WHERE id = auth.uid()))
  WITH CHECK ((SELECT role FROM profiles WHERE id = auth.uid()) = 'admin'
         OR client_id = (SELECT client_id FROM profiles WHERE id = auth.uid()));

-- ── RESTRICTIVE staff-isolation policies: 3 of 4, deliberately excluding no_ims_staff ───────
-- Apply no_self_service_accounts + no_pos_pin_staff + no_hr_role_staff to all 4 tables, mirroring
-- ims_gate_passes' shape (not monthly_owner_reports' full 4-of-4). Do NOT apply no_ims_staff:
-- is_ims_staff() is COALESCE(ims_role IS NOT NULL, false) — it does not check rank. Applying it
-- would block a genuine ims_role='manager' STAFF ACCOUNT (a promoted employee, distinct from the
-- plain Owner login) from ever reading this table, even though hasImsAccess('manager') says
-- they're allowed to post, and the NAV item (minImsRole:'supervisor') says supervisor+ can view.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'assets_categories', 'assets_register', 'assets_depreciation_runs', 'assets_depreciation_schedule'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY no_self_service_accounts ON public.%I AS RESTRICTIVE FOR ALL '
      || 'USING (NOT public.is_hr_self_service()) WITH CHECK (NOT public.is_hr_self_service())', t);
    EXECUTE format(
      'CREATE POLICY no_pos_pin_staff ON public.%I AS RESTRICTIVE FOR ALL '
      || 'USING (NOT public.is_pos_pin_staff()) WITH CHECK (NOT public.is_pos_pin_staff())', t);
    EXECUTE format(
      'CREATE POLICY no_hr_role_staff ON public.%I AS RESTRICTIVE FOR ALL '
      || 'USING (NOT public.is_hr_role_staff()) WITH CHECK (NOT public.is_hr_role_staff())', t);
  END LOOP;
END $$;

-- ── Audit trail — same curated set as items/purchase_entries/hr_payroll_runs/hr_employees ──
CREATE TRIGGER audit_assets_register AFTER INSERT OR DELETE OR UPDATE ON public.assets_register
  FOR EACH ROW EXECUTE FUNCTION public.log_audit();
CREATE TRIGGER audit_assets_depreciation_runs AFTER INSERT OR DELETE OR UPDATE ON public.assets_depreciation_runs
  FOR EACH ROW EXECUTE FUNCTION public.log_audit();
-- log_audit() is generic over any table with id + direct client_id — no special-casing needed.

-- ── Sequence-trigger anon hardening (matches the S372/20260712210000 sweep pattern) ────────
REVOKE EXECUTE ON FUNCTION public.assign_asset_code() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.assign_asset_code() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.enforce_asset_schedule_immutable() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.enforce_asset_schedule_immutable() TO authenticated, service_role;

-- ── GRANTs (raw-SQL tables get no role grants in this project by default) ──────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON public.assets_categories            TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.assets_register              TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.assets_depreciation_runs     TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.assets_depreciation_schedule TO authenticated;

NOTIFY pgrst, 'reload schema';
