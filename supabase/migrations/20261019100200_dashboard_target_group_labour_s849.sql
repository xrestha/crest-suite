-- STATUS: complete (draft for review; not applied)
--
-- S849 cluster OD — the dashboard Target guard (DATABASE-8) and the group labour inputs (GAPS-4 / SU11 (a)).
-- Proposed file name: supabase/migrations/20261016xxxxxx_dashboard_target_and_group_labour_s849.sql
--
-- Objects:
--   §1  REPLACE  public.ims_monthly_periods_guard()            trigger function (trigger unchanged)
--         Change: the two projection-snapshot columns may be written only (a) by a login that can open the
--         dashboard's IMS figures — the Owner, the operator (already returns early) or an IMS login of
--         rank staff+ that is not a count PIN (ims_caller_has_rank('staff')) — and (b) as a snapshot the
--         dashboard can show: model exactly 3 (sales) / 4 (purchases), the values of dailyForecast.js
--         SNAPSHOT_MODEL since S850 (20261018100000, commit 43f61389; was 2 / 3 when this was drafted), and
--         byWeekday an array of exactly 7 non-negative numbers (the browser clamps each weekday at 0 in
--         makeSnapshot, plan-OD.md DATABASE-8 decision (a): a credit-note or return-only weekday can
--         average below zero). A stored snapshot may be
--         replaced only while it is NOT the current model (empty, legacy, or a planted 999), which is the
--         browser's own staleSnapshotFilter rule — so a planted model can no longer block the month.
--         Every other branch is byte-identical to 20260928140000_ims_integrity_s792.sql:663-731.
--         Rollback: re-run the CREATE OR REPLACE body from 20260928140000_ims_integrity_s792.sql:663-731.
--         Coupling: a SNAPSHOT_MODEL bump in dailyForecast.js changes the two literals below in the same
--         commit (snapshotModelGuard.test.js pins them; see plan-OD.md DATABASE-8).
--   §2  CREATE   public.get_group_labour_inputs(integer, integer, uuid)  SECURITY DEFINER, STABLE
--         New. Per member outlet of a group, the HR wage estimate's inputs for one BS month when that outlet
--         is included, has Crest HR, has a period and has NO finalized payroll run for it (a finalized run
--         already reaches the group through get_group_pnl.labour_payroll).
--         p_group_id (ACCESS-8 contract, the same last parameter on every group read RPC): NULL → the
--         caller's own group (Owner or operator; my_group_id()); NOT NULL → Crest support's view of that
--         group, operator only (COALESCE(is_admin(), false), else 42501); an unknown group id is P0002
--         (added in review 2, the contract the other three group reads follow).
--         Depends on public.client_suite_live(uuid) (ACCESS cluster): apply after that migration.
--         Rollback: DROP FUNCTION IF EXISTS public.get_group_labour_inputs(integer, integer, uuid);
--         (no table, no data; the browser falls back to "labour not loaded" for HR outlets without payroll).
--   NOTIFY pgrst (new RPC).
--
-- No data clean-up: the live check found no planted Target (CASA Bhadra 2083's legacy slope/intercept
-- snapshot has no model key; it is a closed month and stays as it is — the new rule treats it as replaceable,
-- exactly as the browser already does).

BEGIN;

-- ══ §1. The dashboard's frozen Target: right shape, right model, right login (DATABASE-8) ═══════════════
--
-- S792 made the snapshot move forward only, but its shape test stopped at "a numeric model and an array":
-- any login of the outlet, a till PIN included, could PATCH {"model": 999, "byWeekday": []} on the 1st and
-- every later capture was refused for the month (2 is not newer than 999), or write a well-formed snapshot
-- into the empty column and plant made-up targets. Now: an IMS login (staff and up, never a count PIN) or the
-- Owner; exactly the model the dashboard draws; seven non-negative numbers; and a current-model Target is
-- frozen while anything else (empty, legacy, planted) may be replaced once.
--
-- Body: 20260928140000_ims_integrity_s792.sql:663-731, plus the S849 lines in the snapshot block.
CREATE OR REPLACE FUNCTION public.ims_monthly_periods_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  c_free constant text[] := ARRAY['sales_projection_snapshot', 'purch_projection_snapshot'];
  v_changed text[];
  v_owner boolean;
  v_col text;
  v_o jsonb;
  v_n jsonb;
  v_model numeric;
  v_ok boolean;
BEGIN
  IF TG_OP = 'DELETE' OR current_user NOT IN ('anon', 'authenticated') OR COALESCE(public.is_admin(), false) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  v_owner := COALESCE(public.is_client_owner(), false);

  IF TG_OP = 'INSERT' THEN
    IF NOT public.ims_caller_has_rank('supervisor') THEN
      RAISE EXCEPTION 'monthly_periods: starting a month needs the account owner or an IMS supervisor or manager'
        USING ERRCODE = '42501', HINT = 'period_rank';
    END IF;
    IF NEW.status IS DISTINCT FROM 'open' THEN
      RAISE EXCEPTION 'monthly_periods: a month starts open and is closed with End Period'
        USING ERRCODE = '42501', HINT = 'period_rank';
    END IF;
    RETURN NEW;
  END IF;

  -- S792: the frozen Target moves forward only.
  -- S849 (DATABASE-8): and only as a snapshot the dashboard can draw, from a login that can open it.
  FOREACH v_col IN ARRAY c_free LOOP
    v_o := to_jsonb(OLD) -> v_col;
    v_n := to_jsonb(NEW) -> v_col;
    IF v_n IS DISTINCT FROM v_o THEN
      -- ims_caller_has_rank is COALESCE'd inside (admin, Owner, IMS staff+ that is not a count PIN).
      IF NOT COALESCE(public.ims_caller_has_rank('staff'), false) THEN
        RAISE EXCEPTION 'monthly_periods: this month''s target is set by the dashboard of the account owner or an IMS login'
          USING ERRCODE = '42501', HINT = 'snapshot_rank';
      END IF;
      -- dailyForecast.js SNAPSHOT_MODEL = { sales: 3, purch: 4 } (S850). A bump there changes these in the same
      -- commit (snapshotModelGuard.test.js reads both literals and compares them with SNAPSHOT_MODEL).
      v_model := CASE v_col WHEN 'sales_projection_snapshot' THEN 3 ELSE 4 END;
      -- Nested, not one OR chain: jsonb_array_length raises on a non-array, and CASE fixes the order.
      v_ok := jsonb_typeof(v_n -> 'model') = 'number' AND jsonb_typeof(v_n -> 'byWeekday') = 'array';
      IF COALESCE(v_ok, false) THEN
        v_ok := (v_n ->> 'model')::numeric = v_model
                AND jsonb_array_length(v_n -> 'byWeekday') = 7
                AND NOT EXISTS (
                  SELECT 1 FROM jsonb_array_elements(v_n -> 'byWeekday') e
                   WHERE CASE WHEN jsonb_typeof(e) = 'number' THEN (e #>> '{}')::numeric < 0 ELSE true END);
      END IF;
      IF NOT COALESCE(v_ok, false)
         -- A Target of the current model is frozen for the month; anything else may be replaced once.
         OR COALESCE(CASE WHEN jsonb_typeof(v_o -> 'model') = 'number'
                          THEN (v_o ->> 'model')::numeric = v_model ELSE false END, false) THEN
        RAISE EXCEPTION 'monthly_periods: this month''s target is already set, and only a newer forecast can replace it'
          USING ERRCODE = '42501', HINT = 'snapshot_frozen';
      END IF;
    END IF;
  END LOOP;

  SELECT COALESCE(array_agg(k), '{}') INTO v_changed
    FROM jsonb_object_keys(to_jsonb(NEW)) k
   WHERE NOT (k = ANY (c_free))
     AND (to_jsonb(NEW) -> k) IS DISTINCT FROM (to_jsonb(OLD) -> k);
  IF cardinality(v_changed) = 0 THEN
    RETURN NEW;
  END IF;

  -- Closing the month: the Periods page's own audience.
  IF v_changed = ARRAY['status'] AND OLD.status = 'open' AND NEW.status = 'closed' THEN
    IF public.ims_caller_has_rank('supervisor') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'monthly_periods: closing the month needs the account owner or an IMS supervisor or manager'
      USING ERRCODE = '42501', HINT = 'period_rank';
  END IF;

  -- Reopening, relabelling (which moves every row of the month into another reporting month) and
  -- anything else: the Owner.
  IF v_owner THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'monthly_periods: reopening or renaming a month needs the account owner (%)', array_to_string(v_changed, ', ')
    USING ERRCODE = '42501', HINT = 'period_rank';
END;
$$;
-- A trigger function needs no EXECUTE grant (checked at CREATE TRIGGER); keep it off PUBLIC as 20260918100000 did.
REVOKE ALL ON FUNCTION public.ims_monthly_periods_guard() FROM PUBLIC;


-- ══ §2. The group's HR wage-estimate inputs (GAPS-4, SU11 (a)) ═════════════════════════════════════════
--
-- The Group Console and the group P&L take labour from get_group_pnl: payroll when a run is finalized, else
-- the Overheads Labor tab. SU11 (a) makes labour for an HR outlet "finalized payroll, else the HR wage
-- estimate" on every page, and the browser cannot read a sibling outlet's HR tables (RLS is the home/active
-- client). This hands back, per member outlet, exactly the rows the estimate (labourEstimate.js) needs, and
-- only when it needs them: included in the group figures, Crest HR on, a period for the month, and no
-- finalized run for it. Employee rows carry no name and no SSF number — a boolean `ssf_contributor`
-- (enrolled AND a number on file, isSsfContributor's test) — so nothing beyond the arithmetic leaves the
-- sibling outlet. Settlements are every finalized one of the outlet (a handful); payrollRoster() filters
-- by the month's end in JS, which keeps BS→AD conversion out of SQL.
--
-- Authorisation mirrors get_group_pnl (20261003120000): Owner or operator, COALESCE'd; group from the
-- caller's HOME client (my_group_id). With p_group_id (ACCESS-8, "Build a support view"): operator only,
-- and that group by id — the same last parameter every group read RPC takes.
-- "Included" is NOT one rule shared by all three group functions (review M1): get_group_pnl (PNL) counts an
-- outlet when client_suite_live() is true OR its consolidated_pnl flag is on; get_group_summary (GROUP)
-- counts client_suite_live() only. This function returns the wider of the two, i.e. exactly get_group_pnl's
-- rule (a superset of get_group_summary's), so neither page loses an outlet's estimate; each page still
-- filters the rows by its own list.
-- No two-argument form ever went live; drop one defensively so a partial earlier apply cannot leave an
-- overload PostgREST would bind for a two-key payload (supabase-sql.md: appending a parameter forks).
DROP FUNCTION IF EXISTS public.get_group_labour_inputs(integer, integer);

CREATE OR REPLACE FUNCTION public.get_group_labour_inputs(p_bs_year integer, p_bs_month integer, p_group_id uuid DEFAULT NULL)
RETURNS TABLE(
  client_id uuid,
  is_included boolean,
  hr_enabled boolean,
  period_id uuid,
  period_status text,
  has_finalized_run boolean,
  employees jsonb,
  components jsonb,
  ot_entries jsonb,
  attendance jsonb,
  settlements jsonb
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_group uuid;
BEGIN
  IF p_group_id IS NOT NULL THEN
    -- Crest support's view of a client's group (ACCESS-8): the operator only, any group by id.
    IF NOT COALESCE(public.is_admin(), false) THEN
      RAISE EXCEPTION 'Not permitted: only Crest support can view another group''s figures.' USING ERRCODE = '42501';
    END IF;
    -- The support-view contract (plan-GROUP ACCESS-8; get_group_pnl, get_group_summary and
    -- get_group_item_prices do the same): an unknown group id is P0002, never an empty answer.
    IF NOT EXISTS (SELECT 1 FROM client_groups g WHERE g.id = p_group_id) THEN
      RAISE EXCEPTION 'That outlet group does not exist.' USING ERRCODE = 'P0002';
    END IF;
    v_group := p_group_id;
  ELSE
    IF NOT (COALESCE(public.is_admin(), false) OR COALESCE(public.is_client_owner(), false)) THEN
      RAISE EXCEPTION 'Not permitted: only an owner can see group figures.' USING ERRCODE = '42501';
    END IF;
    v_group := public.my_group_id();
    IF v_group IS NULL THEN
      RAISE EXCEPTION 'Not permitted: you are not part of an outlet group.' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF p_bs_year IS NULL OR p_bs_month IS NULL OR p_bs_month < 1 OR p_bs_month > 12 THEN
    RAISE EXCEPTION 'get_group_labour_inputs: a BS year and a month 1-12 are required' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH outlets AS (
    -- Lead, S849 merge (review M1): the widest of the two pages' rules, so neither loses an outlet's
    -- estimate. get_group_pnl also counts an outlet by its own consolidated_pnl flag; get_group_summary
    -- counts Suite-live only. Each page still applies its own inclusion to the rows it shows.
    SELECT c.id,
           (COALESCE(public.client_suite_live(c.id), false)
            OR EXISTS (SELECT 1 FROM feature_flags ff
                        WHERE ff.client_id = c.id AND ff.consolidated_pnl IS TRUE)) AS included,
           COALESCE(c.hr_enabled, false)                   AS hr
      FROM clients c
     WHERE c.group_id = v_group
  ),
  per AS (
    SELECT o.id AS cid, o.included, o.hr, mp.id AS pid, mp.status,
           COALESCE(EXISTS (
             SELECT 1 FROM hr_payroll_runs r WHERE r.period_id = mp.id AND r.status = 'finalized'
           ), false) AS finalized
      FROM outlets o
      LEFT JOIN monthly_periods mp
        ON mp.client_id = o.id AND mp.bs_year = p_bs_year AND mp.bs_month = p_bs_month
  ),
  wanted AS (
    SELECT per.*, (per.included AND per.hr AND per.pid IS NOT NULL AND NOT per.finalized) AS needs
      FROM per
  )
  SELECT
    w.cid,
    w.included,
    w.hr,
    w.pid,
    w.status,
    w.finalized,
    CASE WHEN w.needs THEN COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', e.id, 'status', e.status, 'basic_salary', e.basic_salary, 'pay_basis', e.pay_basis,
               'ssf_contributor', (COALESCE(e.ssf_enrolled, false) AND btrim(COALESCE(e.ssf_no, '')) <> ''),
               'join_date', e.join_date, 'end_date', e.end_date) ORDER BY e.id)
        FROM hr_employees e
       WHERE e.client_id = w.cid
    ), '[]'::jsonb) END,
    CASE WHEN w.needs THEN COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'employee_id', sc.employee_id, 'type', sc.type, 'calc_type', sc.calc_type, 'value', sc.value)
             ORDER BY sc.id)
        FROM hr_salary_components sc
       WHERE sc.client_id = w.cid AND sc.type = 'earning'
    ), '[]'::jsonb) END,
    CASE WHEN w.needs THEN COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'employee_id', ot.employee_id, 'bs_day', ot.bs_day, 'ot_hours', ot.ot_hours, 'ot_type', ot.ot_type)
             ORDER BY ot.id)
        FROM hr_overtime_entries ot
       WHERE ot.client_id = w.cid AND ot.status = 'approved'
         AND ot.bs_year = p_bs_year AND ot.bs_month = p_bs_month
    ), '[]'::jsonb) END,
    CASE WHEN w.needs THEN COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'employee_id', a.employee_id, 'bs_day', a.bs_day, 'status', a.status,
               'hours_worked', a.hours_worked, 'ot_hours', a.ot_hours)
             ORDER BY a.id)
        FROM hr_attendance a
       WHERE a.period_id = w.pid
    ), '[]'::jsonb) END,
    CASE WHEN w.needs THEN COALESCE((
      SELECT jsonb_agg(jsonb_build_object('employee_id', s.employee_id, 'last_working_date', s.last_working_date)
             ORDER BY s.id)
        FROM hr_final_settlements s
       WHERE s.client_id = w.cid AND s.status = 'finalized'
    ), '[]'::jsonb) END
  FROM wanted w
  ORDER BY w.cid;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_group_labour_inputs(integer, integer, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_group_labour_inputs(integer, integer, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_group_labour_inputs(integer, integer, uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
