-- S798 stage 3f-2 — someone who works at two of your outlets and leaves one keeps their login at the other.
-- Finding GAP-OUTLETS-3 (docs/hr-review-s798/GAP-OUTLETS.md), decision H22 (a) in HR_TODO.md S798.1, and the
-- owner's answer of 2026-10-04 for a login whose HOME outlet is settled: move its home. The slice is in
-- S798.4. hr_final_settlements_guard, finalize_final_settlement, reopen_final_settlement and
-- get_client_profile_names are rebuilt from their LIVE bodies (read 2026-10-04), not from an older migration.
--
-- Final Settlement found a leaver's logins by profiles.hr_employee_id at the settled outlet only, and banned
-- every one it found:
-- 1. Ramesh's login belongs to Thamel; he moved to Lakeside and still works there, his login linked to his
--    Lakeside record (3f-1). Settling his Thamel record banned the whole login and signed him out, Lakeside
--    included. The only unban was Reopen.
-- 2. Sita's login belongs to Thamel and reaches Lakeside, where she is also on the payroll. Settling her
--    Lakeside record found no login there, so she could still open Lakeside's payroll, payslips and bank
--    sheet at HR Manager rank after her job there ended.
--
-- What this does:
-- (1) settlement_login_plan(record): every login tied to a record and what settling it does to each:
--     'block' (a login with no other job in the group, as before), 'move' (a home HR login linked to an
--     active record at another outlet it can open: its home becomes that outlet, so it keeps working there
--     and can no longer open this one) or 'remove_access' (a login from another outlet linked to this
--     record loses this outlet only). The confirm (settlement_linked_logins) and Finalize both read it, so
--     what the confirm says is what Finalize does. Internal: no client may call it.
-- (2) hr_final_settlements.login_changes: each move and each access removal, with what Reopen needs to put
--     it back. Written only by finalize and reopen: the guard empties it on insert and freezes it on a
--     draft; a finalized row was already frozen whole.
-- (3) finalize_final_settlement applies the plan. Moving a login's home fires
--     profiles_client_move_clears_outlet_state, which drops every outlet tick, so ticks to a third outlet
--     are put back; this outlet's is not, since it was home. SETTLEMENT-6 (H20) now also counts an HR
--     Manager login from another outlet linked to the record: taking its access away is the Owner's call,
--     as revoke_outlet_access is.
-- (4) reopen_final_settlement puts back each change, but only where the login still sits where the
--     settlement left it. What it cannot put back stays in login_changes with a "not_undone" reason, for
--     the draft to show.
-- (5) get_client_profile_names also names the logins whose home is another outlet of the group. A moved
--     login would otherwise lose its name on everything it recorded here, and a login that decided things
--     here through Outlet Access never had one.
--
-- On apply, only (5) reads differently, and only for a grouped outlet (BLOOM's two). No login has an Outlet
-- Access tick or a cross-outlet link today (live 2026-10-04), so every plan is 'block', exactly the old
-- loop. Reversal: drop settlement_login_plan and the column, put back the previous
-- bodies of the four functions, and DROP + CREATE settlement_linked_logins with its three old columns.

-- ── (2) The record of what a settlement did to logins it did not block ───────────────────────────────
ALTER TABLE public.hr_final_settlements
  ADD COLUMN IF NOT EXISTS login_changes jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.hr_final_settlements.login_changes IS
  'S798 3f-2: logins this settlement moved to another outlet (kind moved) or took this outlet away from (kind access_removed), with what reopen_final_settlement needs to put each back. After a Reopen: only the changes it could not put back, each with not_undone. Written only by finalize/reopen.';

CREATE OR REPLACE FUNCTION public.hr_final_settlements_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_skipped text;
  v_months constant text[] := ARRAY['Baisakh','Jestha','Ashadh','Shrawan','Bhadra','Ashwin',
                                    'Kartik','Mangsir','Poush','Magh','Falgun','Chaitra'];
BEGIN
  -- S798 GAP-OPERATOR-3: the amount a paid mark records is stamped for EVERY caller, the operator
  -- included, and only fills an empty one. It sat below the seam, so an operator's mark stored none.
  IF TG_OP = 'UPDATE' AND OLD.status = 'finalized' AND OLD.paid_at IS NULL AND NEW.paid_at IS NOT NULL THEN
    NEW.paid_amount := COALESCE(NEW.paid_amount, OLD.net_payout);
  END IF;

  -- S798 3a (GAP-OPERATOR-1, H3): the operator passes only on INSERT, which is all an Export/Import
  -- restore into an empty company does. Every later change takes the managers' path.
  IF current_user NOT IN ('anon', 'authenticated')
     OR (TG_OP = 'INSERT' AND COALESCE(public.is_admin(), false)) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'settlement_must_start_draft: a settlement is saved as a draft and finalized with the Finalize button';
    END IF;
    NEW.finalized_at := NULL; NEW.paid_at := NULL; NEW.paid_method := NULL; NEW.paid_amount := NULL;
    NEW.advance_recovered := 0; NEW.reopened_at := NULL; NEW.reopened_by := NULL; NEW.reopen_reason := NULL;
    NEW.prior_status := NULL; NEW.prior_end_date := NULL; NEW.prior_access_blocked := NULL;
    NEW.blocked_logins := '{}';
    NEW.paid_adjustments := '[]'::jsonb;  -- S798 3b: written only by record_settlement_difference
    NEW.login_changes := '[]'::jsonb;  -- S798 3f-2: written only by finalize / reopen
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    -- A whole-client deletion cascades through: once the clients row is gone nothing here applies.
    IF EXISTS (SELECT 1 FROM clients WHERE id = OLD.client_id) THEN
      IF OLD.status = 'finalized' THEN
        RAISE EXCEPTION 'settlement_finalized: a finalized settlement cannot be deleted — reopen it first';
      END IF;
      -- S798 3b SETTLEMENT-1 (H4): a draft that was paid before it was reopened is the only record of
      -- that payment.
      IF OLD.paid_at IS NOT NULL THEN
        RAISE EXCEPTION 'settlement_paid_record: this settlement was paid (NPR %) before it was reopened, and it is the record of that payment — it cannot be deleted; correct it and finalize it again',
          to_char(COALESCE(OLD.paid_amount, OLD.net_payout, 0), 'FM99,99,99,990.00');
      END IF;
      -- S798 3b GAP-PAY-STATE-4 (H5): payroll left this person out of those months because this settlement
      -- was paying them. Deleting it leaves that pay to nobody.
      IF OLD.reopened_at IS NOT NULL THEN
        SELECT string_agg(v_months[x.bs_month] || ' ' || x.bs_year, ', ' ORDER BY x.bs_year, x.bs_month)
          INTO v_skipped
          FROM public.settlement_skipped_payroll_months(OLD.employee_id, OLD.last_working_date) x;
        IF v_skipped IS NOT NULL THEN
          RAISE EXCEPTION 'settlement_payroll_skipped: payroll for % was finalized without %, because this settlement was paying it — finalize this settlement again, or reopen that payroll and Regenerate so they are paid there, before deleting it',
            v_skipped, COALESCE(NULLIF(btrim(OLD.employee_name), ''), 'this employee');
        END IF;
      END IF;
    END IF;
    RETURN OLD;
  END IF;

  -- UPDATE
  IF OLD.status = 'draft' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'settlement_finalize_path: a settlement is finalized with the Finalize button, not by editing it';
    END IF;
    NEW.finalized_at := OLD.finalized_at; NEW.advance_recovered := OLD.advance_recovered;
    NEW.paid_at := OLD.paid_at; NEW.paid_method := OLD.paid_method; NEW.paid_amount := OLD.paid_amount;
    NEW.reopened_at := OLD.reopened_at; NEW.reopened_by := OLD.reopened_by; NEW.reopen_reason := OLD.reopen_reason;
    NEW.prior_status := OLD.prior_status; NEW.prior_end_date := OLD.prior_end_date;
    NEW.prior_access_blocked := OLD.prior_access_blocked;
    NEW.blocked_logins := OLD.blocked_logins;
    NEW.paid_adjustments := OLD.paid_adjustments;  -- S798 3b
    NEW.login_changes := OLD.login_changes;  -- S798 3f-2: Reopen reads it; a client must not plant a grant
    RETURN NEW;
  END IF;

  IF OLD.paid_at IS NULL AND NEW.paid_at IS NOT NULL AND btrim(COALESCE(NEW.paid_method, '')) <> ''
     AND (to_jsonb(NEW) - ARRAY['paid_at', 'paid_method', 'paid_amount'])
       = (to_jsonb(OLD) - ARRAY['paid_at', 'paid_method', 'paid_amount']) THEN
    NEW.paid_amount := OLD.net_payout;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'settlement_finalized: this settlement is finalized — reopen it first';
END;
$function$;

-- ── (1) What settling a record does to each login tied to it ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.settlement_login_plan(p_employee_id uuid)
 RETURNS TABLE(profile_id uuid, full_name text, modules text, hr_manager boolean, action text,
               to_client_id uuid, to_employee_id uuid, outlet_name text)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  -- Logins whose home is the record's outlet and that are linked to it there (profiles.hr_employee_id).
  SELECT p.id,
         COALESCE(p.full_name, 'a login')::text,
         concat_ws(', ',
           CASE WHEN p.hr_role IS NOT NULL THEN 'HR' END,
           CASE WHEN p.ims_role IS NOT NULL THEN 'IMS' END,
           CASE WHEN p.pos_email IS NOT NULL THEN 'POS' END)::text,
         COALESCE(p.hr_role = 'manager', false),
         CASE WHEN mv.client_id IS NULL THEN 'block' ELSE 'move' END,
         mv.client_id,
         mv.employee_id,
         mv.outlet_name
    FROM hr_employees e
    JOIN clients hc ON hc.id = e.client_id
    JOIN profiles p ON p.hr_employee_id = e.id AND p.client_id = e.client_id
    -- Another job in the group (H22): a link to an active record at an outlet of the same group this
    -- login can still open. Only HR logins are linked across outlets (link_hr_login). Two such jobs
    -- cannot happen in a two-outlet group; with three, the oldest link wins.
    LEFT JOIN LATERAL (
      SELECT l.client_id, l.employee_id, oc.name::text AS outlet_name
        FROM profile_employee_links l
        JOIN hr_employees le ON le.id = l.employee_id AND le.client_id = l.client_id
        JOIN profile_outlet_access a ON a.profile_id = l.profile_id AND a.client_id = l.client_id
        JOIN clients oc ON oc.id = l.client_id
       WHERE l.profile_id = p.id
         AND p.hr_role IS NOT NULL
         AND l.client_id <> e.client_id
         AND le.status IN ('active', 'probation')
         AND hc.group_id IS NOT NULL
         AND oc.group_id = hc.group_id
       ORDER BY l.linked_at, l.id
       LIMIT 1
    ) mv ON true
   WHERE e.id = p_employee_id
     AND (p.pos_email IS NOT NULL OR p.ims_role IS NOT NULL OR p.hr_role IS NOT NULL)
  UNION ALL
  -- Logins from another outlet linked to this record (profile_employee_links): they lose this outlet.
  SELECT p.id,
         COALESCE(p.full_name, 'a login')::text,
         concat_ws(', ',
           CASE WHEN p.hr_role IS NOT NULL THEN 'HR' END,
           CASE WHEN p.ims_role IS NOT NULL THEN 'IMS' END,
           CASE WHEN p.pos_email IS NOT NULL THEN 'POS' END)::text,
         COALESCE(p.hr_role = 'manager', false),
         'remove_access',
         NULL::uuid,
         NULL::uuid,
         ec.name::text
    FROM hr_employees e
    JOIN clients ec ON ec.id = e.client_id
    JOIN profile_employee_links l ON l.employee_id = e.id AND l.client_id = e.client_id
    JOIN profiles p ON p.id = l.profile_id AND p.client_id <> e.client_id
   WHERE e.id = p_employee_id
   ORDER BY 2
$function$;

-- Internal: finalize and the confirm call it as their owner. Supabase's default privileges grant EXECUTE
-- on a new public function to anon and authenticated by name, so revoking PUBLIC alone leaves them.
REVOKE ALL ON FUNCTION public.settlement_login_plan(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settlement_login_plan(uuid) TO service_role;

-- ── The confirm's list: what Finalize will do to each login ─────────────────────────────────────────
-- New columns, so DROP + CREATE. The caller test is the live one (S798 3b).
DROP FUNCTION IF EXISTS public.settlement_linked_logins(uuid);
CREATE FUNCTION public.settlement_linked_logins(p_employee_id uuid)
 RETURNS TABLE(full_name text, modules text, hr_manager boolean, action text, outlet_name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT x.full_name, x.modules, x.hr_manager, x.action, x.outlet_name
    FROM hr_employees e
    CROSS JOIN LATERAL public.settlement_login_plan(e.id) x
   WHERE e.id = p_employee_id
     AND COALESCE(public.hr_is_manager_rank() AND (public.is_admin() OR e.client_id = public.my_client_id()), false)
   ORDER BY 1
$function$;

REVOKE ALL ON FUNCTION public.settlement_linked_logins(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.settlement_linked_logins(uuid) TO authenticated, service_role;

-- ── (3) Finalize applies the plan ───────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.finalize_final_settlement(p_settlement_id uuid)
 RETURNS hr_final_settlements
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  s hr_final_settlements;
  e hr_employees;
  a record;
  l record;
  v_outstanding numeric;
  v_claims uuid[];
  v_claim_total numeric;
  v_stored_claims uuid[];
  v_recover numeric;
  v_take numeric;
  v_recovered numeric := 0;
  v_new_status text;
  v_blocked text[] := '{}';
  v_month record;
  v_paid record;
  v_ot record;
  v_rate numeric;
  v_ot_hours numeric;
  v_ot_amount numeric;
  v_from_day integer;
  v_att record;
  v_basis text;
  v_unpaid numeric;
  v_earned numeric;
  v_fy integer;
  v_fest record;
  v_name text;
  v_mgr text;
  v_open text;
  v_pending_leave integer;
  v_pending_ot integer;
  v_pending_tada integer;
  v_pending_tada_amount numeric;
  v_changes jsonb := '[]'::jsonb;
  v_keep jsonb;
  v_link profile_employee_links;
  v_access profile_outlet_access;
  v_months constant text[] := ARRAY['Baisakh','Jestha','Ashadh','Shrawan','Bhadra','Ashwin',
                                    'Kartik','Mangsir','Poush','Magh','Falgun','Chaitra'];
BEGIN
  SELECT * INTO s FROM hr_final_settlements WHERE id = p_settlement_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'settlement_not_found: this settlement no longer exists';
  END IF;
  IF NOT COALESCE(public.hr_is_manager_rank() AND (public.is_admin() OR s.client_id = public.my_client_id()), false) THEN
    RAISE EXCEPTION 'settlement_rank: finalizing a settlement needs the Owner or an HR manager' USING ERRCODE = '42501';
  END IF;
  IF NOT public.hr_self_decision_exempt() AND public.hr_is_own_employee(s.employee_id) THEN
    RAISE EXCEPTION 'hr_own_request: you cannot finalize your own settlement — someone else must';
  END IF;

  PERFORM public.hr_pay_lock(s.client_id);
  SELECT * INTO s FROM hr_final_settlements WHERE id = p_settlement_id FOR UPDATE;
  IF s.status <> 'draft' THEN
    RAISE EXCEPTION 'settlement_already_finalized: this settlement was finalized somewhere else — reload the page';
  END IF;
  IF s.calc_version < 2 OR s.settle_bs_year IS NULL OR s.settle_bs_month IS NULL THEN
    RAISE EXCEPTION 'settlement_stale: this draft was calculated by an older version — open it and save it again';
  END IF;
  SELECT b.bs_year, b.bs_month, b.ad_start, b.days, (s.last_working_date - b.ad_start) + 1 AS last_day
    INTO v_month
    FROM bs_months b
   WHERE b.bs_year = s.settle_bs_year AND b.bs_month = s.settle_bs_month
     AND s.last_working_date >= b.ad_start AND s.last_working_date < b.ad_start + b.days;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'settlement_stale: the saved month does not match the last working date — open it and save it again';
  END IF;

  SELECT * INTO e FROM hr_employees WHERE id = s.employee_id AND client_id = s.client_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'settlement_employee_missing: this employee record no longer exists';
  END IF;
  v_name := COALESCE(NULLIF(btrim(s.employee_name), ''), 'This employee');

  -- S798 H26 (SETTLEMENT-5): a last working day before the CURRENT join date is an earlier employment.
  -- Finalizing it would mark the working rehire as left, off payroll and locked out.
  IF e.join_date IS NOT NULL AND e.join_date > s.last_working_date THEN
    RAISE EXCEPTION 'settlement_rehired: % was taken back on % — this settlement belongs to an earlier employment and cannot be finalized; pay any correction by hand and note it',
      v_name, e.join_date;
  END IF;

  IF EXISTS (
    SELECT 1 FROM hr_final_settlements x
     WHERE x.employee_id = s.employee_id AND x.status = 'finalized' AND x.id <> s.id
       AND (e.join_date IS NULL OR x.last_working_date >= e.join_date)) THEN
    RAISE EXCEPTION 'settlement_overlap: this employee already has a finalized settlement for this spell of service — reopen that one instead';
  END IF;

  -- S798 3b SETTLEMENT-6 (H20): only the Owner finalizes the settlement of someone holding an HR Manager
  -- login. Finalize bans that login, and HR Staff leaves a manager's login to the Owner.
  IF NOT public.hr_self_decision_exempt() THEN
    -- S798 3f-2: an HR Manager login from another outlet linked to this record counts too. Settling here
    -- takes that outlet away from it, and removing a login's access is the Owner's (revoke_outlet_access).
    SELECT string_agg(x.full_name, ', ' ORDER BY x.full_name) INTO v_mgr
      FROM public.settlement_login_plan(e.id) x
     WHERE x.hr_manager;
    IF v_mgr IS NOT NULL THEN
      RAISE EXCEPTION 'settlement_manager_login: % holds an HR Manager login (%) — only the Owner finalizes the settlement of someone with an HR Manager login',
        v_name, v_mgr;
    END IF;
  END IF;

  -- Payroll that already pays the last month or a later one — within this spell of service only
  -- (S791): after a rehire, the new employment's payslips are the new employment's, and this older
  -- settlement's months end before the rehire's join month.
  IF EXISTS (
    SELECT 1 FROM hr_payslips p
      JOIN hr_payroll_runs r ON r.id = p.run_id
      JOIN monthly_periods mp ON mp.id = r.period_id
      JOIN bs_months pb ON pb.bs_year = mp.bs_year AND pb.bs_month = mp.bs_month
     WHERE p.employee_id = s.employee_id AND r.status = 'finalized'
       AND mp.bs_year * 12 + mp.bs_month >= s.settle_bs_year * 12 + s.settle_bs_month
       AND (e.join_date IS NULL OR e.join_date <= s.last_working_date OR pb.ad_start + pb.days <= e.join_date)) THEN
    RAISE EXCEPTION 'settlement_month_paid: a finalized payroll run already pays this employee for the final month or later — reopen that run, or move the last working date';
  END IF;

  -- S791: a salary payment recorded for the last month or a later one. Reopen is allowed after payment
  -- (S782), so the payslip check above passes on a reopened run while the money stands; the settlement
  -- then paid the month a second time. Refused, never netted off: undo the payment first.
  SELECT mp.bs_year, mp.bs_month, sp.amount, sp.paid_on
    INTO v_paid
    FROM hr_salary_payments sp
    JOIN hr_payroll_runs r ON r.id = sp.run_id
    JOIN monthly_periods mp ON mp.id = r.period_id
    JOIN bs_months pb ON pb.bs_year = mp.bs_year AND pb.bs_month = mp.bs_month
   WHERE sp.employee_id = s.employee_id AND sp.client_id = s.client_id AND sp.voided_at IS NULL
     AND mp.bs_year * 12 + mp.bs_month >= s.settle_bs_year * 12 + s.settle_bs_month
     AND (e.join_date IS NULL OR e.join_date <= s.last_working_date OR pb.ad_start + pb.days <= e.join_date)
   ORDER BY mp.bs_year, mp.bs_month, sp.paid_on
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'settlement_salary_paid: %''s salary for % % is recorded as paid (NPR % on %) — this settlement pays that month itself, so it would be paid twice; undo that payment on the Payroll page (Undo payment) first, then finalize',
      v_name, v_months[v_paid.bs_month], v_paid.bs_year,
      to_char(v_paid.amount, 'FM99,99,99,990.00'), v_paid.paid_on;
  END IF;

  -- S798 3b SETTLEMENT-2 (H15): every earlier month this settlement's tax year and gratuity offset read
  -- must be final. A month still a draft is later finalized with its own SSF, paying that month's
  -- gratuity a second time, and its own tax projection, neither of which this settlement saw. A month
  -- finalized without them (or not run yet) pays them nothing.
  SELECT string_agg(v_months[x.bs_month] || ' ' || x.bs_year || CASE x.state
           WHEN 'draft' THEN ' (still a draft)' WHEN 'not_run' THEN ' (not run yet)'
           ELSE ' (finalized without them)' END, ', ' ORDER BY x.bs_year, x.bs_month)
    INTO v_open
    FROM public.settlement_open_prior_months(s.employee_id, s.last_working_date) x;
  IF v_open IS NOT NULL THEN
    RAISE EXCEPTION 'settlement_prior_month_open: payroll for an earlier month is not final for %: % — finalize that payroll first (reopen and Regenerate a month that left them out), then recalculate and finalize this settlement',
      v_name, v_open;
  END IF;

  -- S798 3b GAP-PAY-STATE-2 (H11): leave or overtime still awaiting a decision. Pending leave is paid as
  -- worked and encashed again, pending overtime is paid by nobody, and the month locks once this is
  -- finalized, so neither could be approved afterwards.
  SELECT count(*) INTO v_pending_leave
    FROM hr_leave_requests r
   WHERE r.employee_id = s.employee_id AND r.client_id = s.client_id AND r.status = 'pending'
     AND r.start_date <= s.last_working_date
     AND (e.join_date IS NULL OR r.end_date >= e.join_date);
  SELECT count(*) INTO v_pending_ot
    FROM hr_overtime_entries o
   WHERE o.employee_id = s.employee_id AND o.client_id = s.client_id AND o.status = 'pending'
     AND o.bs_year = v_month.bs_year AND o.bs_month = v_month.bs_month
     AND (o.bs_day IS NULL OR o.bs_day <= v_month.last_day);
  IF v_pending_leave > 0 OR v_pending_ot > 0 THEN
    RAISE EXCEPTION 'settlement_pending_requests: % has % leave request(s) and % overtime entr(ies) up to the last working day still waiting for a decision — approve or reject each in Leave and Overtime, then recalculate and finalize',
      v_name, v_pending_leave, v_pending_ot;
  END IF;

  -- S798 3b BONUS-LEDGERS-3 (H11): a travel claim still pending. The settlement pays approved claims
  -- only, and no payroll will ever include a leaver, so a claim approved afterwards is paid by nobody.
  SELECT count(*), COALESCE(sum(c.total_amount), 0) INTO v_pending_tada, v_pending_tada_amount
    FROM hr_tada_claims c
   WHERE c.employee_id = s.employee_id AND c.client_id = s.client_id AND c.status = 'pending';
  IF v_pending_tada > 0 THEN
    RAISE EXCEPTION 'settlement_pending_tada: % has % travel claim(s) (NPR %) still waiting for a decision — approve or reject each in TADA Claims, then recalculate and finalize',
      v_name, v_pending_tada, to_char(v_pending_tada_amount, 'FM99,99,99,990.00');
  END IF;

  -- The first day of the final month this employment covers: a monthly joiner in this month is paid
  -- from the join day (the engine docks the days before it as not employed); everyone else from day 1.
  v_basis := COALESCE(s.pay_basis, 'monthly');
  v_from_day := CASE WHEN v_basis = 'monthly' AND e.join_date IS NOT NULL
                          AND e.join_date >= v_month.ad_start AND e.join_date <= s.last_working_date
                     THEN (e.join_date - v_month.ad_start) + 1 ELSE 1 END;

  -- S791: the overtime this draft pays must be the overtime on file. Payroll leaves a settled leaver
  -- out, so overtime approved after the draft was calculated would otherwise be paid by nothing.
  -- Hours are compared exactly; rupees within Rs. 2 (the engine rounds its two OT parts separately in
  -- floating point, and a weekday entry re-typed as holiday moves the pay by far more than that).
  SELECT * INTO v_ot FROM public.hr_ot_on_file(
    s.client_id, s.employee_id, v_month.bs_year, v_month.bs_month, v_from_day, v_month.last_day);
  v_rate := CASE v_basis
              WHEN 'hourly' THEN COALESCE(s.basic_salary, 0)
              WHEN 'daily'  THEN COALESCE(s.basic_salary, 0) / 8
              ELSE COALESCE(s.basic_salary, 0) / (v_month.days * 8)
            END;
  v_ot_hours := v_ot.attendance_hours + v_ot.weekday_hours + v_ot.holiday_hours;
  v_ot_amount := round(v_ot.attendance_hours * v_rate * 1.5)
               + round(v_ot.weekday_hours * v_rate * 1.5 + v_ot.holiday_hours * v_rate * 2);
  IF abs(COALESCE(s.month_ot_hours, 0) - v_ot_hours) > 0.005
     OR abs(COALESCE(s.month_ot_amount, 0) - v_ot_amount) > 2 THEN
    RAISE EXCEPTION 'settlement_stale_ot: overtime for the last month changed since this draft was calculated — it pays % hours (NPR %), and % hours (about NPR %) are approved or on the attendance sheet up to the last working day now',
      round(COALESCE(s.month_ot_hours, 0), 2), to_char(COALESCE(s.month_ot_amount, 0), 'FM99,99,99,990.00'),
      round(v_ot_hours, 2), to_char(v_ot_amount, 'FM99,99,99,990.00');
  END IF;

  -- S798 SETTLEMENT-3: the attendance this draft pays must be the attendance on file. The month's sheet
  -- locks once this settlement is finalized, so an absence marked after the screen loaded was paid and
  -- could not be seen to differ. The engine's own arithmetic (payrollCompute.js computePayslip):
  --   monthly: unpaid days = absent + unpaid leave + half of each half day / half unpaid leave
  --            + days outside the employment (before the join day, after the last working day)
  --   daily:   wage = basic x (present + half of a half day + paid leave + a paid half + half of an
  --            unpaid half + holiday), rounded to the rupee
  --   hourly:  wage = basic x (hours worked - overtime hours + 8 per paid leave or holiday + 4 per
  --            paid half), rounded to the rupee
  SELECT * INTO v_att FROM public.hr_attendance_on_file(
    s.client_id, s.employee_id, v_month.bs_year, v_month.bs_month, v_from_day, v_month.last_day);
  IF v_basis = 'monthly' THEN
    v_unpaid := v_att.absent + v_att.unpaid_leave + 0.5 * v_att.half_day + 0.5 * v_att.half_unpaid_leave
              + LEAST(v_month.days, (v_from_day - 1) + (v_month.days - v_month.last_day));
    IF abs(COALESCE(s.month_unpaid_days, 0) - v_unpaid) > 0.001 THEN
      RAISE EXCEPTION 'settlement_stale_attendance: attendance for the last month changed since this draft was calculated — it docks % unpaid days, and the attendance sheet now comes to % up to the last working day',
        round(COALESCE(s.month_unpaid_days, 0), 2), round(v_unpaid, 2);
    END IF;
  ELSE
    v_earned := round(COALESCE(s.basic_salary, 0) * CASE v_basis
      WHEN 'daily' THEN v_att.present + 0.5 * v_att.half_day + v_att.paid_leave + v_att.half_paid_leave
                      + 0.5 * v_att.half_unpaid_leave + v_att.holiday
      ELSE GREATEST(0, v_att.sum_hours - v_att.sum_ot)
           + 8 * (v_att.paid_leave + v_att.holiday) + 4 * v_att.half_paid_leave
    END);
    IF abs(COALESCE(s.month_gross, 0) - v_earned) > 1 THEN
      RAISE EXCEPTION 'settlement_stale_attendance: attendance for the last month changed since this draft was calculated — it pays NPR % for the days worked, and the attendance sheet now comes to NPR % up to the last working day',
        to_char(COALESCE(s.month_gross, 0), 'FM99,99,99,990.00'), to_char(v_earned, 'FM99,99,99,990.00');
    END IF;
  END IF;

  -- S798 GAP-PAY-STATE-3: a festival share is not paid on top of a festival allowance already paid
  -- this fiscal year (the page's festivalAlreadyPaid: a finalized row with an amount, in the FY of
  -- the settlement month). Under the same hr_pay_lock the festival guard takes.
  IF COALESCE(s.festival_pro, 0) > 0 THEN
    v_fy := CASE WHEN s.settle_bs_month >= 4 THEN s.settle_bs_year ELSE s.settle_bs_year - 1 END;
    SELECT f.festival_name, f.bs_year, f.bs_month, f.amount INTO v_fest
      FROM hr_festival_allowances f
     WHERE f.employee_id = s.employee_id AND f.client_id = s.client_id
       AND f.status = 'finalized' AND COALESCE(f.amount, 0) > 0
       AND f.bs_year * 12 + f.bs_month BETWEEN v_fy * 12 + 4 AND (v_fy + 1) * 12 + 3
     ORDER BY f.bs_year, f.bs_month
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'settlement_festival_paid: % was paid the % allowance (NPR %, % %) this fiscal year, and this draft also pays a festival share of NPR % — tick "Festival allowance paid this FY" and save again',
        v_name, v_fest.festival_name, to_char(v_fest.amount, 'FM99,99,99,990.00'), v_months[v_fest.bs_month], v_fest.bs_year,
        to_char(s.festival_pro, 'FM99,99,99,990.00');
    END IF;
  END IF;

  SELECT COALESCE(SUM(GREATEST(x.amount - public.hr_advance_repaid(x.id), 0)), 0) INTO v_outstanding
    FROM hr_advances x
   WHERE x.employee_id = s.employee_id AND x.client_id = s.client_id AND x.status = 'active';
  -- Exact to the paisa (S791): advance_deduction is stored at paisa, and a one-paisa difference is
  -- a different balance to recover.
  IF round(v_outstanding, 2) <> round(COALESCE(s.advance_deduction, 0), 2) THEN
    RAISE EXCEPTION 'settlement_stale_advances: this employee''s outstanding advances changed since the settlement was calculated (now NPR %) — reload it', round(v_outstanding, 2);
  END IF;

  SELECT COALESCE(array_agg(c.id ORDER BY c.id), '{}'), COALESCE(SUM(c.total_amount), 0)
    INTO v_claims, v_claim_total
    FROM hr_tada_claims c
   WHERE c.employee_id = s.employee_id AND c.client_id = s.client_id AND c.status = 'approved';
  SELECT COALESCE(array_agg(x ORDER BY x), '{}') INTO v_stored_claims FROM unnest(s.tada_claim_ids) x;
  IF v_claims IS DISTINCT FROM v_stored_claims OR abs(v_claim_total - COALESCE(s.tada_amount, 0)) > 0.01 THEN
    RAISE EXCEPTION 'settlement_stale_tada: this employee''s approved travel claims changed since the settlement was calculated — reload it';
  END IF;

  v_recover := LEAST(v_outstanding, GREATEST(0, COALESCE(s.net_payout, 0) + COALESCE(s.advance_deduction, 0)));
  FOR a IN
    SELECT x.id, x.amount, public.hr_advance_repaid(x.id) AS repaid
      FROM hr_advances x
     WHERE x.employee_id = s.employee_id AND x.client_id = s.client_id AND x.status = 'active'
     ORDER BY x.issued_date NULLS LAST, x.id
  LOOP
    EXIT WHEN v_recover <= 0.005;
    v_take := round(LEAST(GREATEST(a.amount - a.repaid, 0), v_recover), 2);
    IF v_take > 0.005 THEN
      INSERT INTO hr_advance_repayments (client_id, advance_id, employee_id, repaid_date, amount, notes, final_settlement_id)
      VALUES (s.client_id, a.id, s.employee_id, s.last_working_date, v_take, 'Final settlement', s.id);
      v_recover := v_recover - v_take;
      v_recovered := v_recovered + v_take;
    END IF;
  END LOOP;

  UPDATE hr_tada_claims
     SET status = 'paid', paid_method = 'Final Settlement', paid_at = now(), final_settlement_id = s.id
   WHERE id = ANY (v_claims);

  v_new_status := CASE s.separation_reason WHEN 'termination' THEN 'terminated' WHEN 'retirement' THEN 'inactive' ELSE 'resigned' END;

  UPDATE hr_final_settlements
     SET prior_status = COALESCE(prior_status, e.status),
         prior_end_date = CASE WHEN prior_status IS NULL THEN e.end_date ELSE prior_end_date END,
         prior_access_blocked = COALESCE(prior_access_blocked, e.access_blocked)
   WHERE id = s.id;

  UPDATE hr_employees
     SET status = v_new_status, end_date = s.last_working_date, access_blocked = true
   WHERE id = e.id;

  -- The leaver's staff logins, as settlement_login_plan reads them for the confirm (S798 3f-2, H22):
  -- block          a login with no other job in the group. One already banned by something else is left
  --                alone, so Reopen never unbans what this settlement did not ban.
  -- move           a home HR login linked to an active record at another outlet it can open. Its home
  --                becomes that outlet: it keeps working there, at the same rank, and can no longer open
  --                this one. Not signed out; an open window here is sent to its new home.
  -- remove_access  a login from another outlet linked to this record loses this outlet only.
  FOR l IN
    SELECT x.profile_id, x.full_name, x.action, x.to_client_id, x.to_employee_id, x.outlet_name,
           (u.banned_until IS NOT NULL AND u.banned_until >= now()) AS banned
      FROM public.settlement_login_plan(e.id) x
      JOIN auth.users u ON u.id = x.profile_id
     WHERE x.profile_id IS DISTINCT FROM (select auth.uid())
  LOOP
    IF l.action = 'block' THEN
      CONTINUE WHEN l.banned;
      UPDATE auth.users SET banned_until = TIMESTAMPTZ '2999-12-31 00:00:00+00' WHERE id = l.profile_id;
      DELETE FROM auth.sessions WHERE user_id = l.profile_id;
      UPDATE profiles SET settlement_blocked_by = s.id WHERE id = l.profile_id;
      v_blocked := v_blocked || l.full_name;

    ELSIF l.action = 'move' THEN
      SELECT * INTO v_link FROM profile_employee_links k
       WHERE k.profile_id = l.profile_id AND k.client_id = l.to_client_id;
      SELECT * INTO v_access FROM profile_outlet_access k
       WHERE k.profile_id = l.profile_id AND k.client_id = l.to_client_id;
      -- profiles_client_move_clears_outlet_state drops every outlet tick on a home change. Keep the ones
      -- to a third outlet; this outlet has none, having been home, and the new home needs none.
      SELECT COALESCE(jsonb_agg(jsonb_build_object('client_id', k.client_id, 'granted_by', k.granted_by,
                                                   'created_at', k.created_at)), '[]'::jsonb)
        INTO v_keep
        FROM profile_outlet_access k
       WHERE k.profile_id = l.profile_id AND k.client_id NOT IN (s.client_id, l.to_client_id);
      -- The link there becomes the home link: profile_employee_links holds only non-home outlets.
      DELETE FROM profile_employee_links k WHERE k.profile_id = l.profile_id AND k.client_id = l.to_client_id;
      UPDATE profiles SET client_id = l.to_client_id, hr_employee_id = l.to_employee_id WHERE id = l.profile_id;
      INSERT INTO profile_outlet_access (profile_id, client_id, granted_by, created_at)
      SELECT l.profile_id, (k->>'client_id')::uuid, (k->>'granted_by')::uuid, (k->>'created_at')::timestamptz
        FROM jsonb_array_elements(v_keep) k
      ON CONFLICT DO NOTHING;
      v_changes := v_changes || jsonb_build_object(
        'kind', 'moved', 'profile_id', l.profile_id, 'name', l.full_name,
        'from_client_id', s.client_id, 'from_employee_id', e.id,
        'to_client_id', l.to_client_id, 'to_employee_id', l.to_employee_id, 'outlet', l.outlet_name,
        'linked_by', v_link.linked_by, 'linked_at', v_link.linked_at,
        'granted_by', v_access.granted_by, 'granted_at', v_access.created_at);

    ELSE
      SELECT * INTO v_link FROM profile_employee_links k
       WHERE k.profile_id = l.profile_id AND k.client_id = s.client_id;
      SELECT * INTO v_access FROM profile_outlet_access k
       WHERE k.profile_id = l.profile_id AND k.client_id = s.client_id;
      DELETE FROM profile_employee_links k WHERE k.profile_id = l.profile_id AND k.client_id = s.client_id;
      DELETE FROM profile_outlet_access k WHERE k.profile_id = l.profile_id AND k.client_id = s.client_id;
      -- A removal evicts, as revoke_outlet_access does: a window working here stops resolving here.
      UPDATE profiles SET active_client_id = NULL WHERE id = l.profile_id AND active_client_id = s.client_id;
      v_changes := v_changes || jsonb_build_object(
        'kind', 'access_removed', 'profile_id', l.profile_id, 'name', l.full_name,
        'client_id', s.client_id, 'employee_id', e.id, 'outlet', l.outlet_name,
        'linked_by', v_link.linked_by, 'linked_at', v_link.linked_at,
        'had_access', v_access.profile_id IS NOT NULL,
        'granted_by', v_access.granted_by, 'granted_at', v_access.created_at);
    END IF;
  END LOOP;

  UPDATE hr_final_settlements
     SET status = 'finalized', finalized_at = now(), advance_recovered = v_recovered, blocked_logins = v_blocked,
         login_changes = v_changes
   WHERE id = s.id
  RETURNING * INTO s;
  RETURN s;
END;
$function$;

-- ── (4) Reopen puts back what Finalize changed ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reopen_final_settlement(p_settlement_id uuid, p_reason text)
 RETURNS hr_final_settlements
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  s hr_final_settlements;
  v_written_off text;
  v_join date;
  c record;
  t profiles;
  v_reason text;
  v_left jsonb := '[]'::jsonb;
  v_keep jsonb;
  v_to uuid;
  v_to_emp uuid;
BEGIN
  SELECT * INTO s FROM hr_final_settlements WHERE id = p_settlement_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'settlement_not_found: this settlement no longer exists';
  END IF;
  IF NOT COALESCE(public.hr_is_manager_rank() AND (public.is_admin() OR s.client_id = public.my_client_id()), false) THEN
    RAISE EXCEPTION 'settlement_rank: reopening a settlement needs the Owner or an HR manager' USING ERRCODE = '42501';
  END IF;
  IF NOT public.hr_self_decision_exempt() AND public.hr_is_own_employee(s.employee_id) THEN
    RAISE EXCEPTION 'hr_own_request: you cannot reopen your own settlement — someone else must';
  END IF;
  IF btrim(COALESCE(p_reason, '')) = '' THEN
    RAISE EXCEPTION 'settlement_reopen_reason: say why this settlement is being reopened';
  END IF;

  PERFORM public.hr_pay_lock(s.client_id);
  SELECT * INTO s FROM hr_final_settlements WHERE id = p_settlement_id FOR UPDATE;
  IF s.status <> 'finalized' THEN
    RAISE EXCEPTION 'settlement_not_finalized: this settlement is already a draft — reload the page';
  END IF;

  -- S798 H26 (SETTLEMENT-5): an earlier employment's settlement stays as it was paid once the person
  -- is taken back. Reopening it recomputes it on the NEW spell and re-bans a working login.
  SELECT e.join_date INTO v_join FROM hr_employees e WHERE e.id = s.employee_id;
  IF v_join IS NOT NULL AND v_join > s.last_working_date THEN
    RAISE EXCEPTION 'settlement_rehired: % was taken back on % — this settlement belongs to an earlier employment and cannot be reopened; pay any correction by hand and note it',
      COALESCE(NULLIF(btrim(s.employee_name), ''), 'This employee'), v_join;
  END IF;

  SELECT string_agg(DISTINCT COALESCE(x.purpose, 'Advance'), ', ') INTO v_written_off
    FROM hr_advance_repayments r JOIN hr_advances x ON x.id = r.advance_id
   WHERE r.final_settlement_id = s.id AND x.status = 'written_off';
  IF v_written_off IS NOT NULL THEN
    RAISE EXCEPTION 'settlement_reopen_written_off: an advance this settlement recovered has since been written off (%) — put it back to active in Advances & Loans first', v_written_off;
  END IF;

  DELETE FROM hr_advance_repayments WHERE final_settlement_id = s.id;

  UPDATE hr_tada_claims
     SET status = 'approved', paid_at = NULL, paid_method = NULL, final_settlement_id = NULL
   WHERE final_settlement_id = s.id AND status = 'paid';

  UPDATE auth.users SET banned_until = NULL
   WHERE id IN (SELECT id FROM profiles WHERE settlement_blocked_by = s.id);
  UPDATE profiles SET settlement_blocked_by = NULL WHERE settlement_blocked_by = s.id;

  -- S798 3f-2: put back each move and each removed access this settlement made, but only where the
  -- login still sits where the settlement left it. Something changed by hand since is never overwritten:
  -- it stays in login_changes with the reason, and the draft names it.
  FOR c IN SELECT x.value AS ch FROM jsonb_array_elements(COALESCE(s.login_changes, '[]'::jsonb)) x LOOP
    v_reason := NULL;
    SELECT * INTO t FROM profiles p WHERE p.id = (c.ch->>'profile_id')::uuid FOR UPDATE;
    IF NOT FOUND THEN
      v_reason := 'the login no longer exists';

    ELSIF c.ch->>'kind' = 'moved' THEN
      v_to := (c.ch->>'to_client_id')::uuid;
      v_to_emp := (c.ch->>'to_employee_id')::uuid;
      IF (c.ch->>'from_client_id')::uuid IS DISTINCT FROM s.client_id
         OR (c.ch->>'from_employee_id')::uuid IS DISTINCT FROM s.employee_id THEN
        v_reason := 'it does not belong to this settlement';
      ELSIF t.client_id IS DISTINCT FROM v_to OR t.hr_employee_id IS DISTINCT FROM v_to_emp THEN
        v_reason := 'the login has been moved or relinked since';
      ELSIF NOT EXISTS (SELECT 1 FROM clients a JOIN clients b ON b.group_id = a.group_id
                         WHERE a.id = s.client_id AND b.id = v_to) THEN
        v_reason := 'the two outlets are no longer in one group';
      ELSIF EXISTS (SELECT 1 FROM profiles o
                     WHERE o.hr_employee_id = s.employee_id AND o.hr_role IS NOT NULL AND o.id <> t.id)
         OR EXISTS (SELECT 1 FROM profile_employee_links k WHERE k.employee_id = s.employee_id) THEN
        v_reason := 'another login is now linked to this employee record';
      ELSE
        -- Moving home back drops every tick again (profiles_client_move_clears_outlet_state): keep the
        -- third outlets, and give back the outlet it moved to, with its link.
        SELECT COALESCE(jsonb_agg(jsonb_build_object('client_id', k.client_id, 'granted_by', k.granted_by,
                                                     'created_at', k.created_at)), '[]'::jsonb)
          INTO v_keep
          FROM profile_outlet_access k
         WHERE k.profile_id = t.id AND k.client_id NOT IN (s.client_id, v_to);
        UPDATE profiles SET client_id = s.client_id, hr_employee_id = s.employee_id WHERE id = t.id;
        INSERT INTO profile_outlet_access (profile_id, client_id, granted_by, created_at)
        SELECT t.id, (k->>'client_id')::uuid, (k->>'granted_by')::uuid, (k->>'created_at')::timestamptz
          FROM jsonb_array_elements(v_keep) k
        UNION ALL
        SELECT t.id, v_to, (c.ch->>'granted_by')::uuid, COALESCE((c.ch->>'granted_at')::timestamptz, now())
        ON CONFLICT DO NOTHING;
        INSERT INTO profile_employee_links (profile_id, client_id, employee_id, linked_by, linked_at)
        VALUES (t.id, v_to, v_to_emp, (c.ch->>'linked_by')::uuid, COALESCE((c.ch->>'linked_at')::timestamptz, now()))
        ON CONFLICT DO NOTHING;
        IF NOT EXISTS (SELECT 1 FROM profile_employee_links k
                        WHERE k.profile_id = t.id AND k.client_id = v_to AND k.employee_id = v_to_emp) THEN
          v_reason := 'the login is back here, but its link to the employee record at '
                      || COALESCE(c.ch->>'outlet', 'the other outlet') || ' could not be put back';
        END IF;
      END IF;

    ELSIF c.ch->>'kind' = 'access_removed' THEN
      IF (c.ch->>'client_id')::uuid IS DISTINCT FROM s.client_id
         OR (c.ch->>'employee_id')::uuid IS DISTINCT FROM s.employee_id THEN
        v_reason := 'it does not belong to this settlement';
      ELSIF t.client_id = s.client_id THEN
        v_reason := 'the login now belongs to this outlet';
      ELSIF NOT EXISTS (SELECT 1 FROM clients a JOIN clients b ON b.group_id = a.group_id
                         WHERE a.id = s.client_id AND b.id = t.client_id) THEN
        v_reason := 'its outlet is no longer in this group';
      ELSE
        IF COALESCE((c.ch->>'had_access')::boolean, true) THEN
          INSERT INTO profile_outlet_access (profile_id, client_id, granted_by, created_at)
          VALUES (t.id, s.client_id, (c.ch->>'granted_by')::uuid, COALESCE((c.ch->>'granted_at')::timestamptz, now()))
          ON CONFLICT DO NOTHING;
        END IF;
        -- link_hr_login's rules: an HR login, one link per login per outlet, one HR login per record.
        INSERT INTO profile_employee_links (profile_id, client_id, employee_id, linked_by, linked_at)
        SELECT t.id, s.client_id, s.employee_id, (c.ch->>'linked_by')::uuid,
               COALESCE((c.ch->>'linked_at')::timestamptz, now())
         WHERE t.hr_role IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM profiles o
                            WHERE o.hr_employee_id = s.employee_id AND o.hr_role IS NOT NULL AND o.id <> t.id)
        ON CONFLICT DO NOTHING;
        IF NOT EXISTS (SELECT 1 FROM profile_employee_links k
                        WHERE k.profile_id = t.id AND k.client_id = s.client_id AND k.employee_id = s.employee_id) THEN
          v_reason := 'its access is back, but its link to this employee record could not be put back';
        END IF;
      END IF;

    ELSE
      v_reason := 'this change is not one Reopen knows';
    END IF;

    IF v_reason IS NOT NULL THEN
      v_left := v_left || (c.ch || jsonb_build_object('not_undone', v_reason));
    END IF;
  END LOOP;

  UPDATE hr_final_settlements
     SET status = 'draft', finalized_at = NULL, advance_recovered = 0, blocked_logins = '{}', login_changes = v_left,
         reopened_at = now(), reopened_by = (select auth.uid()), reopen_reason = btrim(p_reason)
   WHERE id = s.id
  RETURNING * INTO s;
  RETURN s;
END;
$function$;

-- ── (5) Names on records a login from another outlet made here ──────────────────────────────────────
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
  IF caller_role = 'admin' OR caller_client_id = p_client_id THEN
    RETURN QUERY
      SELECT p.id, p.full_name FROM profiles p
       WHERE p.client_id = p_client_id OR p.id = auth.uid()
          -- S798 3f-2: a login whose home is another outlet of this one's group. It may have decided
          -- things here through Outlet Access, or been moved from here when its owner left this outlet.
          OR p.client_id IN (SELECT c2.id FROM clients c1 JOIN clients c2 ON c2.group_id = c1.group_id
                              WHERE c1.id = p_client_id);
  END IF;
END;
$function$;

NOTIFY pgrst, 'reload schema';
