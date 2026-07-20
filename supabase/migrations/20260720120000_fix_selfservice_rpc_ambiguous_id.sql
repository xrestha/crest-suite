-- Three self-service RPCs declare `RETURNS TABLE(id uuid, ...)`. That OUT parameter `id` is an
-- in-scope PL/pgSQL variable for the whole function body, so the caller-lookup line
--
--   SELECT hr_employee_id INTO v_employee_id FROM profiles WHERE id = auth.uid() ...
--
-- resolves `id` ambiguously (OUT param vs. profiles.id) and raises 42702 on EVERY call, for every
-- employee, regardless of data. The sibling RPCs that return SETOF <table> instead of RETURNS
-- TABLE never declare an `id` variable, which is why only these three were affected.
--
-- Symptom was silent: supabase.rpc() hands back {data: null, error}, and SelfServiceHome does
-- `setPayslips(data || [])`, so a hard RPC failure rendered as the empty state "No finalized
-- payslips yet." — indistinguishable from genuinely having no payslips. Found S~2026-07-20 when a
-- finalized Ashadh 2083 payroll never appeared for the employee it belonged to.
--
-- Fix: alias profiles and qualify the column. Bodies are otherwise byte-identical to the
-- originals (20260707260000, 20260709120000, 20260707270000).

CREATE OR REPLACE FUNCTION public.get_my_hr_payslips() RETURNS TABLE(
    id uuid, bs_year integer, bs_month integer, pay_basis text, basic numeric, allowances numeric,
    gross numeric, ot_amount numeric, ssf_employee numeric, other_deductions numeric,
    advance_deduction numeric, tds numeric, net_pay numeric, run_status text
) LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_employee_id uuid;
BEGIN
  SELECT pr.hr_employee_id INTO v_employee_id
    FROM profiles pr WHERE pr.id = auth.uid() AND pr.hr_self_service = true;
  IF v_employee_id IS NULL THEN RETURN; END IF;

  RETURN QUERY
    SELECT p.id, mp.bs_year, mp.bs_month, p.pay_basis, p.basic, p.allowances,
           p.gross, p.ot_amount, p.ssf_employee, p.other_deductions,
           p.advance_deduction, p.tds, p.net_pay, r.status
    FROM hr_payslips p
    JOIN hr_payroll_runs r ON r.id = p.run_id
    JOIN monthly_periods mp ON mp.id = r.period_id
    WHERE p.employee_id = v_employee_id AND r.status = 'finalized'
    ORDER BY mp.bs_year DESC, mp.bs_month DESC;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_my_client_vendors() RETURNS TABLE(id uuid, name text)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_client_id uuid;
BEGIN
  SELECT pr.client_id INTO v_client_id
    FROM profiles pr WHERE pr.id = auth.uid() AND pr.hr_self_service = true;
  IF v_client_id IS NULL THEN RETURN; END IF;
  RETURN QUERY SELECT v.id, v.name FROM vendors v
    WHERE v.client_id = v_client_id AND v.is_active = true ORDER BY v.name;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_my_swap_requests() RETURNS TABLE(
    id uuid, requester_employee_id uuid, requester_name text, target_employee_id uuid,
    target_name text, bs_year integer, bs_month integer, requester_bs_day integer,
    target_bs_day integer, requester_shift_name text, target_shift_name text, status text,
    note text, created_at timestamp with time zone
) LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_employee_id uuid;
BEGIN
  SELECT pr.hr_employee_id INTO v_employee_id
    FROM profiles pr WHERE pr.id = auth.uid() AND pr.hr_self_service = true;
  IF v_employee_id IS NULL THEN RETURN; END IF;

  RETURN QUERY
    SELECT s.id, s.requester_employee_id, re.full_name, s.target_employee_id, te.full_name,
           s.bs_year, s.bs_month, s.requester_bs_day, s.target_bs_day,
           rst.name, tst.name, s.status, s.note, s.created_at
    FROM hr_shift_swap_requests s
    JOIN hr_employees re ON re.id = s.requester_employee_id
    JOIN hr_employees te ON te.id = s.target_employee_id
    LEFT JOIN hr_shift_types rst ON rst.id = s.requester_shift_type_id
    LEFT JOIN hr_shift_types tst ON tst.id = s.target_shift_type_id
    WHERE s.requester_employee_id = v_employee_id OR s.target_employee_id = v_employee_id
    ORDER BY s.created_at DESC;
END;
$$;

-- CREATE OR REPLACE preserves existing grants, but re-assert the anon revokes from
-- 20260712210000 so a future replace can't silently reopen them.
REVOKE EXECUTE ON FUNCTION public.get_my_hr_payslips() FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_my_client_vendors() FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_my_swap_requests() FROM anon;
