--
-- PostgreSQL database dump
--


-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.10

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: admin_clear_audit_logs(uuid, text, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_clear_audit_logs(p_client_id uuid DEFAULT NULL::uuid, p_table_name text DEFAULT NULL::text, p_cutoff timestamp with time zone DEFAULT NULL::timestamp with time zone) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  deleted_count integer;
BEGIN
  DELETE FROM audit_logs
  WHERE
    (p_client_id  IS NULL OR client_id  = p_client_id)
    AND (p_table_name IS NULL OR table_name = p_table_name)
    AND (p_cutoff     IS NULL OR created_at >= p_cutoff);
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;


--
-- Name: assign_pos_credit_note_no(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assign_pos_credit_note_no() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NEW.credit_note_no IS NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('pos_credit_note_no:' || NEW.client_id::text || ':' || NEW.invoice_fy));
    SELECT COALESCE(MAX(credit_note_no), 0) + 1 INTO NEW.credit_note_no
    FROM pos_credit_notes WHERE client_id = NEW.client_id AND invoice_fy = NEW.invoice_fy;
  END IF;
  RETURN NEW;
END $$;


--
-- Name: assign_pos_invoice_no(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assign_pos_invoice_no() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NEW.status = 'billed' AND NEW.invoice_no IS NULL AND NEW.invoice_fy IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('pos_invoice_no:' || NEW.client_id::text || ':' || NEW.invoice_fy || ':' || NEW.close_type));
    SELECT COALESCE(MAX(invoice_no), 0) + 1 INTO NEW.invoice_no
    FROM pos_orders WHERE client_id = NEW.client_id AND invoice_fy = NEW.invoice_fy AND close_type = NEW.close_type;
  END IF;
  RETURN NEW;
END $$;


--
-- Name: assign_pos_order_no(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assign_pos_order_no() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NEW.order_no IS NULL THEN
    -- serialize per client so two simultaneous opens can't grab the same number
    PERFORM pg_advisory_xact_lock(hashtext('pos_order_no:' || NEW.client_id::text));
    SELECT COALESCE(MAX(order_no), 0) + 1 INTO NEW.order_no
    FROM pos_orders WHERE client_id = NEW.client_id;
  END IF;
  RETURN NEW;
END $$;


--
-- Name: client_user_emails(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.client_user_emails(p_client_id uuid) RETURNS TABLE(id uuid, email text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT u.id, u.email
  FROM public.profiles p
  JOIN auth.users u ON u.id = p.id
  WHERE p.client_id = p_client_id
    AND public.is_admin();
$$;


--
-- Name: find_user_id_by_email(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.find_user_id_by_email(p_email text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  uid uuid;
BEGIN
  IF (SELECT role FROM public.profiles WHERE id = auth.uid()) <> 'admin' THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  SELECT id INTO uid FROM auth.users WHERE lower(email) = lower(p_email) LIMIT 1;
  RETURN uid;
END;
$$;


--
-- Name: get_cooccurrence(uuid, uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_cooccurrence(p_client_id uuid, p_recipe_id uuid, p_days integer DEFAULT 90) RETURNS TABLE(paired_recipe_id uuid, co_count bigint)
    LANGUAGE sql STABLE SECURITY DEFINER
    AS $$
  SELECT b.recipe_id AS paired_recipe_id, COUNT(*) AS co_count
  FROM pos_order_items a
  JOIN pos_order_items b ON a.order_id = b.order_id AND a.recipe_id != b.recipe_id
  JOIN pos_orders o ON o.id = a.order_id
  WHERE a.client_id = p_client_id
    AND a.recipe_id = p_recipe_id
    AND o.created_at >= NOW() - (p_days || ' days')::INTERVAL
  GROUP BY b.recipe_id
  ORDER BY co_count DESC
  LIMIT 10;
$$;


--
-- Name: get_pos_staff(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_pos_staff(p_client_id uuid) RETURNS TABLE(id uuid, full_name text, pos_role text, pos_email text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT id, full_name, pos_role, pos_email
  FROM profiles
  WHERE client_id = p_client_id
    AND pos_role IS NOT NULL
    AND pos_email IS NOT NULL
  ORDER BY full_name;
$$;


--
-- Name: get_pos_staff_list(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_pos_staff_list(p_client_id uuid) RETURNS TABLE(id uuid, full_name text, pos_role text, pos_job_title text, last_seen_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  caller_client_id uuid;
  caller_role text;
BEGIN
  SELECT p.client_id, p.role INTO caller_client_id, caller_role
  FROM profiles p WHERE p.id = auth.uid();

  IF caller_role = 'admin' OR caller_client_id = p_client_id THEN
    RETURN QUERY
      SELECT p.id, p.full_name, p.pos_role, p.pos_job_title, p.last_seen_at
      FROM profiles p
      WHERE p.client_id = p_client_id
        AND p.role = 'client'
        AND p.pos_email IS NOT NULL
      ORDER BY p.full_name;
  END IF;
END;
$$;


--
-- Name: handle_new_user(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_new_user() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  insert into public.profiles (id, full_name, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    'client'
  )
  on conflict (id) do nothing;
  return new;
exception when others then
  return new;
end;
$$;


--
-- Name: is_admin(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_admin() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select role = 'admin' from profiles where id = auth.uid()
$$;


--
-- Name: log_audit(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.log_audit() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'auth'
    AS $$
DECLARE
  _client_id uuid; _client_name text; _user_id uuid; _user_name text; _record_id uuid;
BEGIN
  _user_id := auth.uid();
  SELECT full_name INTO _user_name FROM profiles WHERE id = _user_id;

  IF TG_OP = 'DELETE' THEN
    _record_id := OLD.id;
    IF TG_TABLE_NAME IN ('purchase_entries','opening_stock','closing_stock','wastages') THEN
      SELECT client_id INTO _client_id FROM monthly_periods WHERE id = OLD.period_id;
    ELSE _client_id := OLD.client_id; END IF;
  ELSE
    _record_id := NEW.id;
    IF TG_TABLE_NAME IN ('purchase_entries','opening_stock','closing_stock','wastages') THEN
      SELECT client_id INTO _client_id FROM monthly_periods WHERE id = NEW.period_id;
    ELSE _client_id := NEW.client_id; END IF;
  END IF;

  -- Nested IF so OLD.status is only accessed when table is monthly_periods
  IF TG_TABLE_NAME = 'monthly_periods' THEN
    IF TG_OP = 'UPDATE' THEN
      IF OLD.status = NEW.status THEN RETURN NULL; END IF;
    END IF;
  END IF;

  IF _client_id IS NOT NULL THEN
    SELECT name INTO _client_name FROM clients WHERE id = _client_id;
  END IF;

  INSERT INTO audit_logs (client_id, client_name, user_id, user_name, table_name, action, record_id, old_data, new_data)
  VALUES (_client_id, _client_name, _user_id, _user_name, TG_TABLE_NAME, TG_OP, _record_id,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END,
    CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END);
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$;


--
-- Name: my_client_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.my_client_id() RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select client_id from profiles where id = auth.uid()
$$;


--
-- Name: request_subscription(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.request_subscription() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  UPDATE clients
  SET subscribe_requested = true,
      subscribe_requested_at = now()
  WHERE id = (SELECT client_id FROM profiles WHERE id = auth.uid());
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: audit_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_logs (
    id bigint NOT NULL,
    client_id uuid,
    client_name text,
    user_id uuid,
    user_name text,
    table_name text NOT NULL,
    action text NOT NULL,
    record_id uuid,
    old_data jsonb,
    new_data jsonb,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: audit_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.audit_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: audit_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.audit_logs_id_seq OWNED BY public.audit_logs.id;


--
-- Name: budgets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.budgets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid,
    period_id uuid,
    category_id uuid,
    amount numeric DEFAULT 0
);


--
-- Name: categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.categories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid NOT NULL,
    name text NOT NULL,
    sort_order integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: clients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.clients (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    location text,
    contact_person text,
    contact_phone text,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    is_premium boolean DEFAULT false,
    plan text DEFAULT 'starter'::text,
    trial_ends_at timestamp with time zone,
    subscription_ends_at timestamp with time zone,
    hr_enabled boolean DEFAULT false,
    hr_plan text,
    ims_enabled boolean DEFAULT true,
    is_trial boolean DEFAULT false,
    trial_start_date timestamp with time zone,
    trial_expires_at timestamp with time zone,
    trial_purge_at timestamp with time zone,
    subscribe_requested boolean DEFAULT false,
    subscribe_requested_at timestamp with time zone,
    billing_cycle text DEFAULT 'monthly'::text,
    ims_ends_at timestamp with time zone,
    hr_ends_at timestamp with time zone,
    pos_ends_at timestamp with time zone,
    pos_enabled boolean DEFAULT false,
    pos_plan text,
    CONSTRAINT clients_plan_check CHECK ((plan = ANY (ARRAY['starter'::text, 'growth'::text, 'pro'::text]))),
    CONSTRAINT clients_pos_plan_check CHECK ((pos_plan = ANY (ARRAY['starter'::text, 'growth'::text, 'pro'::text])))
);


--
-- Name: closing_stock; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.closing_stock (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    period_id uuid NOT NULL,
    item_id uuid NOT NULL,
    physical_qty numeric DEFAULT 0 NOT NULL,
    counted_by text,
    counted_at timestamp with time zone DEFAULT now()
);


--
-- Name: demand_forecast_daily; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.demand_forecast_daily (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid NOT NULL,
    recipe_id uuid,
    bs_year integer NOT NULL,
    bs_month integer NOT NULL,
    bs_day integer NOT NULL,
    forecast_covers numeric,
    forecast_qty numeric,
    forecast_revenue numeric,
    model_basis text,
    horizon_days integer,
    generated_at timestamp with time zone DEFAULT now(),
    revenue_estimated boolean DEFAULT false,
    CONSTRAINT demand_forecast_daily_horizon_days_check CHECK ((horizon_days = ANY (ARRAY[7, 30]))),
    CONSTRAINT demand_forecast_daily_model_basis_check CHECK ((model_basis = ANY (ARRAY['pos'::text, 'manual'::text])))
);


--
-- Name: demand_forecast_run_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.demand_forecast_run_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid NOT NULL,
    run_at timestamp with time zone DEFAULT now(),
    method text,
    rows_written integer,
    error text
);


--
-- Name: feature_flags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.feature_flags (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid NOT NULL,
    sales_entry boolean,
    monthly_summary boolean,
    payment_summary boolean,
    vendor_report boolean,
    variance_report boolean,
    fifo_report boolean,
    reorder_report boolean,
    price_tracker boolean,
    recipe_costing boolean,
    menu_engineering boolean,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    overheads boolean,
    budget_vs_actual boolean,
    best_sellers boolean,
    vat_report boolean,
    purchase_orders boolean,
    requisitions boolean,
    wastage_report boolean,
    dead_stock boolean,
    recipe_margin boolean,
    period_comparison boolean,
    non_vat_report boolean,
    theoretical_variance boolean,
    annual_summary boolean,
    outstanding_payables boolean,
    shrinkage_report boolean,
    nutrition_facts boolean DEFAULT false,
    stock_report boolean DEFAULT false,
    settings boolean,
    staff_meals boolean DEFAULT false,
    menu_repricing boolean,
    menu_pricing boolean,
    demand_forecast boolean DEFAULT false,
    combo_builder boolean DEFAULT false
);


--
-- Name: hr_advance_repayments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hr_advance_repayments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid NOT NULL,
    advance_id uuid NOT NULL,
    employee_id uuid NOT NULL,
    repaid_date date NOT NULL,
    amount numeric(12,2) NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    payroll_run_id uuid,
    CONSTRAINT hr_advance_repayments_amount_check CHECK ((amount > (0)::numeric))
);


--
-- Name: hr_advances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hr_advances (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid NOT NULL,
    employee_id uuid NOT NULL,
    type text DEFAULT 'advance'::text NOT NULL,
    issued_date date NOT NULL,
    amount numeric(12,2) NOT NULL,
    installment_amount numeric(12,2),
    purpose text,
    status text DEFAULT 'active'::text NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT hr_advances_amount_check CHECK ((amount > (0)::numeric)),
    CONSTRAINT hr_advances_status_check CHECK ((status = ANY (ARRAY['active'::text, 'settled'::text]))),
    CONSTRAINT hr_advances_type_check CHECK ((type = ANY (ARRAY['advance'::text, 'loan'::text])))
);


--
-- Name: hr_attendance; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hr_attendance (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid NOT NULL,
    employee_id uuid NOT NULL,
    period_id uuid NOT NULL,
    bs_day integer NOT NULL,
    status text DEFAULT 'present'::text NOT NULL,
    hours_worked numeric(5,2) DEFAULT 0,
    ot_hours numeric(5,2) DEFAULT 0,
    note text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT hr_attendance_status_check CHECK ((status = ANY (ARRAY['present'::text, 'absent'::text, 'half_day'::text, 'paid_leave'::text, 'unpaid_leave'::text, 'weekly_off'::text, 'holiday'::text])))
);


--
-- Name: hr_employees; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hr_employees (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid NOT NULL,
    employee_code text,
    full_name text NOT NULL,
    gender text,
    date_of_birth date,
    pan_no text,
    citizenship_no text,
    designation text,
    department text,
    employment_type text DEFAULT 'permanent'::text,
    join_date date NOT NULL,
    end_date date,
    status text DEFAULT 'active'::text,
    phone text,
    email text,
    address text,
    emergency_contact_name text,
    emergency_contact_phone text,
    bank_name text,
    bank_account_no text,
    bank_branch text,
    ssf_no text,
    basic_salary numeric(12,2) DEFAULT 0,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    pay_basis text DEFAULT 'monthly'::text,
    supervisor_id uuid,
    retirement_date date,
    marital_status text,
    spouse_name text,
    father_name text,
    mother_name text,
    grandfather_name text,
    children_count integer,
    nominee_name text,
    nominee_relationship text,
    nominee_contact text,
    perm_province text,
    perm_district text,
    perm_municipality text,
    perm_ward text,
    perm_tole text,
    same_as_permanent boolean DEFAULT false,
    temp_province text,
    temp_district text,
    temp_municipality text,
    temp_ward text,
    temp_tole text,
    ssf_enrolled boolean DEFAULT false,
    life_insurance_premium numeric DEFAULT 0,
    health_insurance_premium numeric DEFAULT 0,
    CONSTRAINT hr_employees_employment_type_check CHECK ((employment_type = ANY (ARRAY['permanent'::text, 'probation'::text, 'contract'::text, 'part_time'::text]))),
    CONSTRAINT hr_employees_gender_check CHECK ((gender = ANY (ARRAY['male'::text, 'female'::text, 'other'::text]))),
    CONSTRAINT hr_employees_pay_basis_check CHECK ((pay_basis = ANY (ARRAY['monthly'::text, 'daily'::text, 'hourly'::text]))),
    CONSTRAINT hr_employees_status_check CHECK ((status = ANY (ARRAY['active'::text, 'inactive'::text, 'resigned'::text, 'terminated'::text])))
);


--
-- Name: hr_festival_allowances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hr_festival_allowances (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid NOT NULL,
    employee_id uuid NOT NULL,
    bs_year integer NOT NULL,
    festival_name text DEFAULT 'Dashain'::text NOT NULL,
    pay_basis text,
    basic numeric(12,2) DEFAULT 0,
    months_worked numeric(4,1) DEFAULT 12,
    amount numeric(12,2) DEFAULT 0,
    status text DEFAULT 'draft'::text NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now(),
    tds integer DEFAULT 0 NOT NULL,
    CONSTRAINT hr_festival_allowances_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'finalized'::text])))
);


--
-- Name: hr_holiday_calendar; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hr_holiday_calendar (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid NOT NULL,
    bs_year integer NOT NULL,
    bs_month integer NOT NULL,
    bs_day integer NOT NULL,
    name text NOT NULL,
    holiday_type text DEFAULT 'public'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT hr_holiday_calendar_bs_day_check CHECK (((bs_day >= 1) AND (bs_day <= 32))),
    CONSTRAINT hr_holiday_calendar_bs_month_check CHECK (((bs_month >= 1) AND (bs_month <= 12))),
    CONSTRAINT hr_holiday_calendar_holiday_type_check CHECK ((holiday_type = ANY (ARRAY['public'::text, 'optional'::text])))
);


--
-- Name: hr_leave_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hr_leave_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid NOT NULL,
    employee_id uuid NOT NULL,
    leave_type_id uuid,
    start_date date NOT NULL,
    end_date date NOT NULL,
    days numeric(5,1) DEFAULT 0 NOT NULL,
    reason text,
    status text DEFAULT 'pending'::text NOT NULL,
    decided_at timestamp with time zone,
    note text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT hr_leave_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'cancelled'::text])))
);


--
-- Name: hr_leave_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hr_leave_types (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid NOT NULL,
    name text NOT NULL,
    code text NOT NULL,
    paid boolean DEFAULT true NOT NULL,
    annual_quota numeric(5,1) DEFAULT 0 NOT NULL,
    carry_forward boolean DEFAULT false NOT NULL,
    color text DEFAULT '#60a5fa'::text,
    active boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: hr_overtime_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hr_overtime_entries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid NOT NULL,
    employee_id uuid NOT NULL,
    bs_year integer NOT NULL,
    bs_month integer NOT NULL,
    bs_day integer NOT NULL,
    ot_hours numeric NOT NULL,
    ot_type text DEFAULT 'weekday'::text NOT NULL,
    reason text,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT hr_overtime_entries_bs_day_check CHECK (((bs_day >= 1) AND (bs_day <= 32))),
    CONSTRAINT hr_overtime_entries_bs_month_check CHECK (((bs_month >= 1) AND (bs_month <= 12))),
    CONSTRAINT hr_overtime_entries_ot_hours_check CHECK ((ot_hours > (0)::numeric)),
    CONSTRAINT hr_overtime_entries_ot_type_check CHECK ((ot_type = ANY (ARRAY['weekday'::text, 'holiday'::text]))),
    CONSTRAINT hr_overtime_entries_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])))
);


--
-- Name: hr_payroll_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hr_payroll_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid NOT NULL,
    period_id uuid NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    finalized_at timestamp with time zone,
    CONSTRAINT hr_payroll_runs_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'finalized'::text])))
);


--
-- Name: hr_payslips; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hr_payslips (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    run_id uuid NOT NULL,
    client_id uuid NOT NULL,
    employee_id uuid NOT NULL,
    pay_basis text,
    basic numeric(12,2) DEFAULT 0,
    allowances numeric(12,2) DEFAULT 0,
    gross numeric(12,2) DEFAULT 0,
    present_days numeric(5,1) DEFAULT 0,
    absent_days numeric(5,1) DEFAULT 0,
    worked_days numeric(5,1) DEFAULT 0,
    hours_worked numeric(7,2) DEFAULT 0,
    ot_hours numeric(7,2) DEFAULT 0,
    ot_amount numeric(12,2) DEFAULT 0,
    absence_deduction numeric(12,2) DEFAULT 0,
    ssf_employee numeric(12,2) DEFAULT 0,
    ssf_employer numeric(12,2) DEFAULT 0,
    other_deductions numeric(12,2) DEFAULT 0,
    tds numeric(12,2) DEFAULT 0,
    net_pay numeric(12,2) DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    advance_deduction numeric DEFAULT 0
);


--
-- Name: hr_roster; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hr_roster (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid NOT NULL,
    employee_id uuid NOT NULL,
    shift_type_id uuid,
    bs_year integer NOT NULL,
    bs_month integer NOT NULL,
    bs_day integer NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: hr_salary_components; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hr_salary_components (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid NOT NULL,
    employee_id uuid NOT NULL,
    name text NOT NULL,
    type text NOT NULL,
    calc_type text DEFAULT 'fixed'::text NOT NULL,
    value numeric(12,2) DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT hr_salary_components_calc_type_check CHECK ((calc_type = ANY (ARRAY['fixed'::text, 'percent_of_basic'::text]))),
    CONSTRAINT hr_salary_components_type_check CHECK ((type = ANY (ARRAY['earning'::text, 'deduction'::text])))
);


--
-- Name: hr_shift_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hr_shift_types (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid NOT NULL,
    name text NOT NULL,
    color text DEFAULT '#6B7280'::text NOT NULL,
    start_time text,
    end_time text,
    hours numeric,
    sort_order integer DEFAULT 0 NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid NOT NULL,
    category_id uuid,
    name text NOT NULL,
    uom text NOT NULL,
    purchase_qty numeric NOT NULL,
    rate numeric NOT NULL,
    per_uom_rate numeric GENERATED ALWAYS AS ((rate / NULLIF(purchase_qty, (0)::numeric))) STORED,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    purchase_unit text,
    base_unit text,
    conversion_factor numeric DEFAULT 1,
    item_code text,
    yield_pct numeric(5,2) DEFAULT 100 NOT NULL,
    is_sub_recipe boolean DEFAULT false,
    nutrition jsonb
);


--
-- Name: monthly_periods; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.monthly_periods (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid NOT NULL,
    bs_year integer NOT NULL,
    bs_month integer NOT NULL,
    status text DEFAULT 'open'::text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT monthly_periods_bs_month_check CHECK (((bs_month >= 1) AND (bs_month <= 12))),
    CONSTRAINT monthly_periods_status_check CHECK ((status = ANY (ARRAY['open'::text, 'closed'::text])))
);


--
-- Name: opening_stock; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.opening_stock (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    period_id uuid NOT NULL,
    item_id uuid NOT NULL,
    qty numeric DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: purchase_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.purchase_entries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    period_id uuid NOT NULL,
    item_id uuid NOT NULL,
    vendor_id uuid,
    bs_day integer NOT NULL,
    qty numeric NOT NULL,
    rate numeric NOT NULL,
    invoice_ref text,
    created_at timestamp with time zone DEFAULT now(),
    expiry_date date,
    payment_method text DEFAULT 'Cash'::text,
    vat_inclusive boolean DEFAULT false,
    paid_at date,
    purchase_group_id uuid DEFAULT gen_random_uuid(),
    discount_amount numeric(12,2) DEFAULT 0,
    CONSTRAINT purchase_entries_bs_day_check CHECK (((bs_day >= 1) AND (bs_day <= 32))),
    CONSTRAINT purchase_entries_payment_method_check CHECK ((payment_method = ANY (ARRAY['Cash'::text, 'Credit'::text, 'FonePay'::text])))
);


--
-- Name: wastages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wastages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    period_id uuid NOT NULL,
    item_id uuid NOT NULL,
    bs_day integer,
    qty numeric DEFAULT 0 NOT NULL,
    reason text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: inventory_summary; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.inventory_summary WITH (security_invoker='on') AS
 SELECT mp.id AS period_id,
    mp.client_id,
    mp.bs_year,
    mp.bs_month,
    i.id AS item_id,
    i.name AS item_name,
    i.uom,
    i.per_uom_rate,
    c.name AS category,
    COALESCE(os.qty, (0)::numeric) AS opening_qty,
    COALESCE(sum(pe.qty), (0)::numeric) AS purchased_qty,
    COALESCE(ws.qty, (0)::numeric) AS wastage_qty,
    COALESCE(cs.physical_qty, (0)::numeric) AS closing_qty,
    (((COALESCE(os.qty, (0)::numeric) + COALESCE(sum(pe.qty), (0)::numeric)) - COALESCE(ws.qty, (0)::numeric)) - COALESCE(cs.physical_qty, (0)::numeric)) AS used_qty,
    (COALESCE(os.qty, (0)::numeric) * i.per_uom_rate) AS opening_value,
    (COALESCE(cs.physical_qty, (0)::numeric) * i.per_uom_rate) AS closing_value
   FROM ((((((public.monthly_periods mp
     JOIN public.items i ON ((i.client_id = mp.client_id)))
     LEFT JOIN public.categories c ON ((c.id = i.category_id)))
     LEFT JOIN public.opening_stock os ON (((os.period_id = mp.id) AND (os.item_id = i.id))))
     LEFT JOIN public.purchase_entries pe ON (((pe.period_id = mp.id) AND (pe.item_id = i.id))))
     LEFT JOIN public.closing_stock cs ON (((cs.period_id = mp.id) AND (cs.item_id = i.id))))
     LEFT JOIN ( SELECT wastages.period_id,
            wastages.item_id,
            sum(wastages.qty) AS qty
           FROM public.wastages
          GROUP BY wastages.period_id, wastages.item_id) ws ON (((ws.period_id = mp.id) AND (ws.item_id = i.id))))
  GROUP BY mp.id, mp.client_id, mp.bs_year, mp.bs_month, i.id, i.name, i.uom, i.per_uom_rate, c.name, os.qty, ws.qty, cs.physical_qty;


--
-- Name: overheads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.overheads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid NOT NULL,
    period_id uuid,
    category text NOT NULL,
    description text,
    amount numeric DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    bucket text DEFAULT 'overhead'::text
);


--
-- Name: par_levels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.par_levels (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid NOT NULL,
    item_id uuid,
    par_qty numeric DEFAULT 0,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: payable_payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payable_payments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    purchase_entry_id uuid,
    amount numeric(12,2) NOT NULL,
    paid_at date DEFAULT CURRENT_DATE NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now(),
    client_id uuid NOT NULL
);


--
-- Name: pos_credit_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pos_credit_notes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid NOT NULL,
    order_id uuid NOT NULL,
    credit_note_no integer,
    invoice_fy text NOT NULL,
    original_invoice_no integer NOT NULL,
    original_invoice_label text NOT NULL,
    original_invoice_date_bs text NOT NULL,
    reason text NOT NULL,
    gross_amount numeric DEFAULT 0 NOT NULL,
    discount_amount numeric DEFAULT 0 NOT NULL,
    taxable_amount numeric DEFAULT 0 NOT NULL,
    non_taxable_amount numeric DEFAULT 0 NOT NULL,
    vat_amount numeric DEFAULT 0 NOT NULL,
    net_amount numeric DEFAULT 0 NOT NULL,
    buyer_name text,
    buyer_address text,
    buyer_pan text,
    buyer_phone text,
    issued_by uuid,
    print_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: pos_customers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pos_customers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid NOT NULL,
    name text NOT NULL,
    phone text NOT NULL,
    address text,
    pan text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    phone_canonical text GENERATED ALWAYS AS (regexp_replace(
CASE
    WHEN (regexp_replace(phone, '\D'::text, ''::text, 'g'::text) ~ '^977.{8,}'::text) THEN SUBSTRING(regexp_replace(phone, '\D'::text, ''::text, 'g'::text) FROM 4)
    ELSE regexp_replace(phone, '\D'::text, ''::text, 'g'::text)
END, '^0+'::text, ''::text)) STORED
);


--
-- Name: pos_kot_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pos_kot_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid NOT NULL,
    order_id uuid NOT NULL,
    order_no integer,
    table_name text,
    station text NOT NULL,
    items jsonb NOT NULL,
    sent_by uuid,
    sent_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pos_kot_log_station_check CHECK ((station = ANY (ARRAY['KOT'::text, 'BOT'::text])))
);


--
-- Name: pos_order_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pos_order_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id uuid NOT NULL,
    client_id uuid NOT NULL,
    recipe_id uuid,
    name text NOT NULL,
    qty integer DEFAULT 1 NOT NULL,
    unit_price numeric DEFAULT 0 NOT NULL,
    vat_rate numeric DEFAULT 0 NOT NULL,
    notes text,
    sent_to_kot boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    category text
);


--
-- Name: pos_order_payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pos_order_payments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id uuid NOT NULL,
    client_id uuid NOT NULL,
    payment_method text NOT NULL,
    amount numeric NOT NULL,
    tendered_amount numeric,
    recorded_by uuid,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pos_order_payments_payment_method_check CHECK ((payment_method = ANY (ARRAY['Cash'::text, 'Card'::text, 'eSewa'::text, 'Khalti'::text, 'FonePay'::text])))
);


--
-- Name: pos_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pos_orders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid NOT NULL,
    table_id uuid,
    table_name text,
    status text DEFAULT 'open'::text NOT NULL,
    covers integer DEFAULT 1 NOT NULL,
    notes text,
    opened_by uuid,
    opened_at timestamp with time zone DEFAULT now(),
    closed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    order_no integer,
    close_type text,
    payment_method text,
    paid_amount numeric,
    tendered_amount numeric,
    close_reason text,
    closed_by uuid,
    buyer_name text,
    buyer_address text,
    buyer_pan text,
    buyer_phone text,
    bill_remarks text,
    invoice_no integer,
    invoice_fy text,
    print_count integer DEFAULT 0,
    discount_amount numeric,
    discount_reason text,
    credit_settled_at timestamp with time zone,
    credit_settled_by uuid,
    credit_settled_method text,
    shift_id uuid,
    credit_note_id uuid,
    CONSTRAINT pos_orders_close_type_check CHECK ((close_type = ANY (ARRAY['paid'::text, 'writeoff'::text, 'void'::text]))),
    CONSTRAINT pos_orders_credit_settled_method_check CHECK ((credit_settled_method = ANY (ARRAY['Cash'::text, 'Card'::text, 'eSewa'::text, 'Khalti'::text, 'FonePay'::text]))),
    CONSTRAINT pos_orders_payment_method_check CHECK ((payment_method = ANY (ARRAY['Cash'::text, 'Card'::text, 'eSewa'::text, 'Khalti'::text, 'FonePay'::text, 'Credit'::text, 'Split'::text])))
);


--
-- Name: pos_shifts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pos_shifts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid NOT NULL,
    label text,
    status text DEFAULT 'open'::text NOT NULL,
    opened_at timestamp with time zone DEFAULT now() NOT NULL,
    opened_by uuid,
    opening_cash numeric DEFAULT 0 NOT NULL,
    opening_denominations jsonb,
    closed_at timestamp with time zone,
    closed_by uuid,
    closing_cash numeric,
    closing_denominations jsonb,
    CONSTRAINT pos_shifts_status_check CHECK ((status = ANY (ARRAY['open'::text, 'closed'::text])))
);


--
-- Name: pos_tables; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pos_tables (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid NOT NULL,
    name text NOT NULL,
    section text,
    capacity integer DEFAULT 2,
    status text DEFAULT 'available'::text,
    sort_order integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT pos_tables_status_check CHECK ((status = ANY (ARRAY['available'::text, 'occupied'::text, 'reserved'::text, 'inactive'::text])))
);


--
-- Name: profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.profiles (
    id uuid NOT NULL,
    client_id uuid,
    full_name text,
    role text DEFAULT 'client'::text,
    created_at timestamp with time zone DEFAULT now(),
    last_seen_at timestamp with time zone,
    pos_role text,
    pos_email text,
    hr_employee_id uuid,
    pos_job_title text,
    CONSTRAINT profiles_pos_role_check CHECK ((pos_role = ANY (ARRAY['staff'::text, 'supervisor'::text, 'manager'::text]))),
    CONSTRAINT profiles_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'client'::text])))
);


--
-- Name: purchase_order_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.purchase_order_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    po_id uuid NOT NULL,
    item_id uuid NOT NULL,
    qty_ordered numeric(12,3) NOT NULL,
    unit_price numeric(12,2) DEFAULT 0,
    qty_received numeric(12,3) DEFAULT 0
);


--
-- Name: purchase_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.purchase_orders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid NOT NULL,
    vendor_id uuid,
    period_id uuid NOT NULL,
    po_number text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    notes text,
    expected_date date,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: recipe_ingredients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recipe_ingredients (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    recipe_id uuid NOT NULL,
    item_id uuid,
    qty_per_portion numeric NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    sub_recipe_id uuid,
    CONSTRAINT ingredient_source_check CHECK ((((item_id IS NOT NULL) AND (sub_recipe_id IS NULL)) OR ((item_id IS NULL) AND (sub_recipe_id IS NOT NULL))))
);


--
-- Name: recipe_suggestions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recipe_suggestions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid NOT NULL,
    recipe_id uuid NOT NULL,
    suggest_recipe_id uuid NOT NULL,
    sort_order integer DEFAULT 0
);


--
-- Name: recipes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recipes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid NOT NULL,
    name text NOT NULL,
    category text,
    selling_price numeric,
    vat_rate numeric DEFAULT 0.13,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    yield_qty numeric DEFAULT 1,
    yield_uom text DEFAULT 'portion'::text,
    target_fc_pct numeric DEFAULT 30,
    recipe_code text,
    linked_item_id uuid,
    pos_enabled boolean DEFAULT true,
    me_class text,
    hsc_code text,
    cost_price numeric,
    CONSTRAINT recipes_me_class_check CHECK ((me_class = ANY (ARRAY['star'::text, 'plowhouse'::text, 'puzzle'::text, 'dog'::text])))
);


--
-- Name: requisition_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.requisition_lines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    requisition_id uuid,
    item_id uuid,
    qty_requested numeric DEFAULT 0 NOT NULL,
    qty_issued numeric DEFAULT 0
);


--
-- Name: requisitions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.requisitions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid NOT NULL,
    period_id uuid,
    bs_day integer NOT NULL,
    department text DEFAULT 'Kitchen'::text,
    status text DEFAULT 'draft'::text,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT requisitions_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'issued'::text])))
);


--
-- Name: sales_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sales_entries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    period_id uuid NOT NULL,
    recipe_id uuid NOT NULL,
    bs_day integer NOT NULL,
    qty_sold numeric DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    source text DEFAULT 'manual'::text,
    CONSTRAINT sales_entries_source_check CHECK ((source = ANY (ARRAY['manual'::text, 'pos'::text])))
);


--
-- Name: settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid,
    app_name text DEFAULT 'Crest Inventory'::text,
    app_tagline text DEFAULT 'Hospitality cost control, built for Nepal.'::text,
    property_address text,
    property_phone text,
    property_email text,
    vat_number text,
    fc_warning_pct numeric DEFAULT 35,
    fc_critical_pct numeric DEFAULT 45,
    expiry_warning_days integer DEFAULT 7,
    variance_flag_pct numeric DEFAULT 10,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    item_code_prefix text DEFAULT 'ITM'::text,
    contact_phone text,
    contact_email text,
    contact_website text,
    logo_url text,
    sub_recipe_code_prefix text DEFAULT 'SRC'::text,
    vendor_code_prefix text DEFAULT 'VND'::text,
    recipe_categories text[],
    pos_custom_roles jsonb DEFAULT '[]'::jsonb,
    pos_bot_categories text[],
    pos_note_presets text[],
    is_vat_registered boolean DEFAULT true,
    invoice_prefix text,
    pos_discount_reasons text[],
    payment_qr_data text,
    covers_per_staff_target numeric DEFAULT 20,
    combo_discount_pct numeric DEFAULT 10
);


--
-- Name: staff_meals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_meals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    period_id uuid,
    item_id uuid,
    qty numeric DEFAULT 0 NOT NULL,
    type text DEFAULT 'staff'::text,
    CONSTRAINT staff_meals_type_check CHECK ((type = ANY (ARRAY['staff'::text, 'comp'::text])))
);


--
-- Name: stock_movements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stock_movements (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid NOT NULL,
    item_id uuid NOT NULL,
    period_id uuid NOT NULL,
    bs_day integer,
    qty numeric NOT NULL,
    source text NOT NULL,
    ref_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: vendor_returns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vendor_returns (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid NOT NULL,
    period_id uuid NOT NULL,
    purchase_entry_id uuid,
    item_id uuid NOT NULL,
    vendor_id uuid,
    qty numeric NOT NULL,
    rate numeric DEFAULT 0 NOT NULL,
    payment_method text DEFAULT 'Cash'::text NOT NULL,
    bs_day integer,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT vendor_returns_payment_method_check CHECK ((payment_method = ANY (ARRAY['Cash'::text, 'Credit'::text, 'FonePay'::text]))),
    CONSTRAINT vendor_returns_qty_check CHECK ((qty > (0)::numeric))
);


--
-- Name: vendors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vendors (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid NOT NULL,
    name text NOT NULL,
    contact_person text,
    phone text,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    address text,
    pan_vat_no text,
    vendor_code text
);


--
-- Name: audit_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs ALTER COLUMN id SET DEFAULT nextval('public.audit_logs_id_seq'::regclass);


--
-- Name: audit_logs audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id);


--
-- Name: budgets budgets_period_id_category_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budgets
    ADD CONSTRAINT budgets_period_id_category_id_key UNIQUE (period_id, category_id);


--
-- Name: budgets budgets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budgets
    ADD CONSTRAINT budgets_pkey PRIMARY KEY (id);


--
-- Name: categories categories_client_name_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_client_name_unique UNIQUE (client_id, name);


--
-- Name: categories categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_pkey PRIMARY KEY (id);


--
-- Name: clients clients_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clients
    ADD CONSTRAINT clients_pkey PRIMARY KEY (id);


--
-- Name: closing_stock closing_stock_period_id_item_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.closing_stock
    ADD CONSTRAINT closing_stock_period_id_item_id_key UNIQUE (period_id, item_id);


--
-- Name: closing_stock closing_stock_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.closing_stock
    ADD CONSTRAINT closing_stock_pkey PRIMARY KEY (id);


--
-- Name: demand_forecast_daily demand_forecast_daily_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.demand_forecast_daily
    ADD CONSTRAINT demand_forecast_daily_pkey PRIMARY KEY (id);


--
-- Name: demand_forecast_run_log demand_forecast_run_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.demand_forecast_run_log
    ADD CONSTRAINT demand_forecast_run_log_pkey PRIMARY KEY (id);


--
-- Name: feature_flags feature_flags_client_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feature_flags
    ADD CONSTRAINT feature_flags_client_id_key UNIQUE (client_id);


--
-- Name: feature_flags feature_flags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feature_flags
    ADD CONSTRAINT feature_flags_pkey PRIMARY KEY (id);


--
-- Name: hr_advance_repayments hr_advance_repayments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_advance_repayments
    ADD CONSTRAINT hr_advance_repayments_pkey PRIMARY KEY (id);


--
-- Name: hr_advances hr_advances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_advances
    ADD CONSTRAINT hr_advances_pkey PRIMARY KEY (id);


--
-- Name: hr_attendance hr_attendance_employee_id_period_id_bs_day_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_attendance
    ADD CONSTRAINT hr_attendance_employee_id_period_id_bs_day_key UNIQUE (employee_id, period_id, bs_day);


--
-- Name: hr_attendance hr_attendance_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_attendance
    ADD CONSTRAINT hr_attendance_pkey PRIMARY KEY (id);


--
-- Name: hr_employees hr_employees_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_employees
    ADD CONSTRAINT hr_employees_pkey PRIMARY KEY (id);


--
-- Name: hr_festival_allowances hr_festival_allowances_client_id_employee_id_bs_year_festiv_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_festival_allowances
    ADD CONSTRAINT hr_festival_allowances_client_id_employee_id_bs_year_festiv_key UNIQUE (client_id, employee_id, bs_year, festival_name);


--
-- Name: hr_festival_allowances hr_festival_allowances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_festival_allowances
    ADD CONSTRAINT hr_festival_allowances_pkey PRIMARY KEY (id);


--
-- Name: hr_holiday_calendar hr_holiday_calendar_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_holiday_calendar
    ADD CONSTRAINT hr_holiday_calendar_pkey PRIMARY KEY (id);


--
-- Name: hr_leave_requests hr_leave_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_leave_requests
    ADD CONSTRAINT hr_leave_requests_pkey PRIMARY KEY (id);


--
-- Name: hr_leave_types hr_leave_types_client_id_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_leave_types
    ADD CONSTRAINT hr_leave_types_client_id_code_key UNIQUE (client_id, code);


--
-- Name: hr_leave_types hr_leave_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_leave_types
    ADD CONSTRAINT hr_leave_types_pkey PRIMARY KEY (id);


--
-- Name: hr_overtime_entries hr_overtime_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_overtime_entries
    ADD CONSTRAINT hr_overtime_entries_pkey PRIMARY KEY (id);


--
-- Name: hr_payroll_runs hr_payroll_runs_client_id_period_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_payroll_runs
    ADD CONSTRAINT hr_payroll_runs_client_id_period_id_key UNIQUE (client_id, period_id);


--
-- Name: hr_payroll_runs hr_payroll_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_payroll_runs
    ADD CONSTRAINT hr_payroll_runs_pkey PRIMARY KEY (id);


--
-- Name: hr_payslips hr_payslips_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_payslips
    ADD CONSTRAINT hr_payslips_pkey PRIMARY KEY (id);


--
-- Name: hr_payslips hr_payslips_run_id_employee_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_payslips
    ADD CONSTRAINT hr_payslips_run_id_employee_id_key UNIQUE (run_id, employee_id);


--
-- Name: hr_roster hr_roster_client_id_employee_id_bs_year_bs_month_bs_day_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_roster
    ADD CONSTRAINT hr_roster_client_id_employee_id_bs_year_bs_month_bs_day_key UNIQUE (client_id, employee_id, bs_year, bs_month, bs_day);


--
-- Name: hr_roster hr_roster_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_roster
    ADD CONSTRAINT hr_roster_pkey PRIMARY KEY (id);


--
-- Name: hr_salary_components hr_salary_components_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_salary_components
    ADD CONSTRAINT hr_salary_components_pkey PRIMARY KEY (id);


--
-- Name: hr_shift_types hr_shift_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_shift_types
    ADD CONSTRAINT hr_shift_types_pkey PRIMARY KEY (id);


--
-- Name: items items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.items
    ADD CONSTRAINT items_pkey PRIMARY KEY (id);


--
-- Name: monthly_periods monthly_periods_client_id_bs_year_bs_month_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monthly_periods
    ADD CONSTRAINT monthly_periods_client_id_bs_year_bs_month_key UNIQUE (client_id, bs_year, bs_month);


--
-- Name: monthly_periods monthly_periods_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monthly_periods
    ADD CONSTRAINT monthly_periods_pkey PRIMARY KEY (id);


--
-- Name: opening_stock opening_stock_period_id_item_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.opening_stock
    ADD CONSTRAINT opening_stock_period_id_item_id_key UNIQUE (period_id, item_id);


--
-- Name: opening_stock opening_stock_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.opening_stock
    ADD CONSTRAINT opening_stock_pkey PRIMARY KEY (id);


--
-- Name: overheads overheads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.overheads
    ADD CONSTRAINT overheads_pkey PRIMARY KEY (id);


--
-- Name: par_levels par_levels_client_id_item_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.par_levels
    ADD CONSTRAINT par_levels_client_id_item_id_key UNIQUE (client_id, item_id);


--
-- Name: par_levels par_levels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.par_levels
    ADD CONSTRAINT par_levels_pkey PRIMARY KEY (id);


--
-- Name: payable_payments payable_payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payable_payments
    ADD CONSTRAINT payable_payments_pkey PRIMARY KEY (id);


--
-- Name: pos_credit_notes pos_credit_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_credit_notes
    ADD CONSTRAINT pos_credit_notes_pkey PRIMARY KEY (id);


--
-- Name: pos_customers pos_customers_client_id_phone_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_customers
    ADD CONSTRAINT pos_customers_client_id_phone_key UNIQUE (client_id, phone);


--
-- Name: pos_customers pos_customers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_customers
    ADD CONSTRAINT pos_customers_pkey PRIMARY KEY (id);


--
-- Name: pos_kot_log pos_kot_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_kot_log
    ADD CONSTRAINT pos_kot_log_pkey PRIMARY KEY (id);


--
-- Name: pos_order_items pos_order_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_order_items
    ADD CONSTRAINT pos_order_items_pkey PRIMARY KEY (id);


--
-- Name: pos_order_payments pos_order_payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_order_payments
    ADD CONSTRAINT pos_order_payments_pkey PRIMARY KEY (id);


--
-- Name: pos_orders pos_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_orders
    ADD CONSTRAINT pos_orders_pkey PRIMARY KEY (id);


--
-- Name: pos_shifts pos_shifts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_shifts
    ADD CONSTRAINT pos_shifts_pkey PRIMARY KEY (id);


--
-- Name: pos_tables pos_tables_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_tables
    ADD CONSTRAINT pos_tables_pkey PRIMARY KEY (id);


--
-- Name: profiles profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);


--
-- Name: purchase_entries purchase_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_entries
    ADD CONSTRAINT purchase_entries_pkey PRIMARY KEY (id);


--
-- Name: purchase_order_items purchase_order_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_order_items
    ADD CONSTRAINT purchase_order_items_pkey PRIMARY KEY (id);


--
-- Name: purchase_orders purchase_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_orders
    ADD CONSTRAINT purchase_orders_pkey PRIMARY KEY (id);


--
-- Name: recipe_ingredients recipe_ingredients_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recipe_ingredients
    ADD CONSTRAINT recipe_ingredients_pkey PRIMARY KEY (id);


--
-- Name: recipe_ingredients recipe_ingredients_recipe_id_item_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recipe_ingredients
    ADD CONSTRAINT recipe_ingredients_recipe_id_item_id_key UNIQUE (recipe_id, item_id);


--
-- Name: recipe_suggestions recipe_suggestions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recipe_suggestions
    ADD CONSTRAINT recipe_suggestions_pkey PRIMARY KEY (id);


--
-- Name: recipe_suggestions recipe_suggestions_recipe_id_suggest_recipe_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recipe_suggestions
    ADD CONSTRAINT recipe_suggestions_recipe_id_suggest_recipe_id_key UNIQUE (recipe_id, suggest_recipe_id);


--
-- Name: recipes recipes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recipes
    ADD CONSTRAINT recipes_pkey PRIMARY KEY (id);


--
-- Name: requisition_lines requisition_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.requisition_lines
    ADD CONSTRAINT requisition_lines_pkey PRIMARY KEY (id);


--
-- Name: requisitions requisitions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.requisitions
    ADD CONSTRAINT requisitions_pkey PRIMARY KEY (id);


--
-- Name: sales_entries sales_entries_period_id_recipe_id_bs_day_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_entries
    ADD CONSTRAINT sales_entries_period_id_recipe_id_bs_day_key UNIQUE (period_id, recipe_id, bs_day);


--
-- Name: sales_entries sales_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_entries
    ADD CONSTRAINT sales_entries_pkey PRIMARY KEY (id);


--
-- Name: settings settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settings
    ADD CONSTRAINT settings_pkey PRIMARY KEY (id);


--
-- Name: staff_meals staff_meals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_meals
    ADD CONSTRAINT staff_meals_pkey PRIMARY KEY (id);


--
-- Name: stock_movements stock_movements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT stock_movements_pkey PRIMARY KEY (id);


--
-- Name: vendor_returns vendor_returns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_returns
    ADD CONSTRAINT vendor_returns_pkey PRIMARY KEY (id);


--
-- Name: vendors vendors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendors
    ADD CONSTRAINT vendors_pkey PRIMARY KEY (id);


--
-- Name: wastages wastages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wastages
    ADD CONSTRAINT wastages_pkey PRIMARY KEY (id);


--
-- Name: hr_holiday_calendar_client_id_bs_year_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX hr_holiday_calendar_client_id_bs_year_idx ON public.hr_holiday_calendar USING btree (client_id, bs_year);


--
-- Name: hr_overtime_entries_client_id_bs_year_bs_month_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX hr_overtime_entries_client_id_bs_year_bs_month_idx ON public.hr_overtime_entries USING btree (client_id, bs_year, bs_month);


--
-- Name: hr_overtime_entries_employee_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX hr_overtime_entries_employee_id_idx ON public.hr_overtime_entries USING btree (employee_id);


--
-- Name: idx_pos_customers_phone_canonical; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pos_customers_phone_canonical ON public.pos_customers USING btree (phone_canonical);


--
-- Name: pos_credit_notes_order_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX pos_credit_notes_order_id_key ON public.pos_credit_notes USING btree (order_id);


--
-- Name: pos_shifts_one_open_per_client; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX pos_shifts_one_open_per_client ON public.pos_shifts USING btree (client_id) WHERE (status = 'open'::text);


--
-- Name: stock_movements_client_item_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX stock_movements_client_item_idx ON public.stock_movements USING btree (client_id, item_id);


--
-- Name: stock_movements_period_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX stock_movements_period_idx ON public.stock_movements USING btree (period_id);


--
-- Name: closing_stock audit_closing_stock; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_closing_stock AFTER INSERT OR DELETE OR UPDATE ON public.closing_stock FOR EACH ROW EXECUTE FUNCTION public.log_audit();


--
-- Name: hr_employees audit_hr_employees; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_hr_employees AFTER INSERT OR DELETE OR UPDATE ON public.hr_employees FOR EACH ROW EXECUTE FUNCTION public.log_audit();


--
-- Name: hr_festival_allowances audit_hr_festival_allowances; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_hr_festival_allowances AFTER INSERT OR DELETE OR UPDATE ON public.hr_festival_allowances FOR EACH ROW EXECUTE FUNCTION public.log_audit();


--
-- Name: hr_leave_requests audit_hr_leave_requests; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_hr_leave_requests AFTER INSERT OR DELETE OR UPDATE ON public.hr_leave_requests FOR EACH ROW EXECUTE FUNCTION public.log_audit();


--
-- Name: hr_leave_types audit_hr_leave_types; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_hr_leave_types AFTER INSERT OR DELETE OR UPDATE ON public.hr_leave_types FOR EACH ROW EXECUTE FUNCTION public.log_audit();


--
-- Name: hr_payroll_runs audit_hr_payroll_runs; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_hr_payroll_runs AFTER INSERT OR DELETE OR UPDATE ON public.hr_payroll_runs FOR EACH ROW EXECUTE FUNCTION public.log_audit();


--
-- Name: hr_salary_components audit_hr_salary_components; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_hr_salary_components AFTER INSERT OR DELETE OR UPDATE ON public.hr_salary_components FOR EACH ROW EXECUTE FUNCTION public.log_audit();


--
-- Name: items audit_items; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_items AFTER INSERT OR DELETE OR UPDATE ON public.items FOR EACH ROW EXECUTE FUNCTION public.log_audit();


--
-- Name: monthly_periods audit_monthly_periods; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_monthly_periods AFTER UPDATE ON public.monthly_periods FOR EACH ROW EXECUTE FUNCTION public.log_audit();


--
-- Name: opening_stock audit_opening_stock; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_opening_stock AFTER INSERT OR DELETE OR UPDATE ON public.opening_stock FOR EACH ROW EXECUTE FUNCTION public.log_audit();


--
-- Name: profiles audit_profiles; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_profiles AFTER INSERT OR DELETE OR UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.log_audit();


--
-- Name: purchase_entries audit_purchase_entries; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_purchase_entries AFTER INSERT OR DELETE OR UPDATE ON public.purchase_entries FOR EACH ROW EXECUTE FUNCTION public.log_audit();


--
-- Name: vendor_returns audit_vendor_returns; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_vendor_returns AFTER INSERT OR DELETE OR UPDATE ON public.vendor_returns FOR EACH ROW EXECUTE FUNCTION public.log_audit();


--
-- Name: wastages audit_wastages; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_wastages AFTER INSERT OR DELETE OR UPDATE ON public.wastages FOR EACH ROW EXECUTE FUNCTION public.log_audit();


--
-- Name: pos_credit_notes trg_assign_pos_credit_note_no; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_assign_pos_credit_note_no BEFORE INSERT ON public.pos_credit_notes FOR EACH ROW EXECUTE FUNCTION public.assign_pos_credit_note_no();


--
-- Name: pos_orders trg_assign_pos_invoice_no; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_assign_pos_invoice_no BEFORE UPDATE ON public.pos_orders FOR EACH ROW EXECUTE FUNCTION public.assign_pos_invoice_no();


--
-- Name: pos_orders trg_assign_pos_order_no; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_assign_pos_order_no BEFORE INSERT ON public.pos_orders FOR EACH ROW EXECUTE FUNCTION public.assign_pos_order_no();


--
-- Name: audit_logs audit_logs_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE SET NULL;


--
-- Name: budgets budgets_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budgets
    ADD CONSTRAINT budgets_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.categories(id) ON DELETE CASCADE;


--
-- Name: budgets budgets_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budgets
    ADD CONSTRAINT budgets_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: budgets budgets_period_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budgets
    ADD CONSTRAINT budgets_period_id_fkey FOREIGN KEY (period_id) REFERENCES public.monthly_periods(id) ON DELETE CASCADE;


--
-- Name: categories categories_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: closing_stock closing_stock_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.closing_stock
    ADD CONSTRAINT closing_stock_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id);


--
-- Name: closing_stock closing_stock_period_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.closing_stock
    ADD CONSTRAINT closing_stock_period_id_fkey FOREIGN KEY (period_id) REFERENCES public.monthly_periods(id) ON DELETE CASCADE;


--
-- Name: demand_forecast_daily demand_forecast_daily_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.demand_forecast_daily
    ADD CONSTRAINT demand_forecast_daily_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: demand_forecast_daily demand_forecast_daily_recipe_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.demand_forecast_daily
    ADD CONSTRAINT demand_forecast_daily_recipe_id_fkey FOREIGN KEY (recipe_id) REFERENCES public.recipes(id) ON DELETE CASCADE;


--
-- Name: demand_forecast_run_log demand_forecast_run_log_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.demand_forecast_run_log
    ADD CONSTRAINT demand_forecast_run_log_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: feature_flags feature_flags_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feature_flags
    ADD CONSTRAINT feature_flags_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id);


--
-- Name: hr_advance_repayments hr_advance_repayments_advance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_advance_repayments
    ADD CONSTRAINT hr_advance_repayments_advance_id_fkey FOREIGN KEY (advance_id) REFERENCES public.hr_advances(id) ON DELETE CASCADE;


--
-- Name: hr_advance_repayments hr_advance_repayments_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_advance_repayments
    ADD CONSTRAINT hr_advance_repayments_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: hr_advance_repayments hr_advance_repayments_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_advance_repayments
    ADD CONSTRAINT hr_advance_repayments_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.hr_employees(id) ON DELETE CASCADE;


--
-- Name: hr_advance_repayments hr_advance_repayments_payroll_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_advance_repayments
    ADD CONSTRAINT hr_advance_repayments_payroll_run_id_fkey FOREIGN KEY (payroll_run_id) REFERENCES public.hr_payroll_runs(id);


--
-- Name: hr_advances hr_advances_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_advances
    ADD CONSTRAINT hr_advances_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: hr_advances hr_advances_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_advances
    ADD CONSTRAINT hr_advances_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.hr_employees(id) ON DELETE CASCADE;


--
-- Name: hr_attendance hr_attendance_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_attendance
    ADD CONSTRAINT hr_attendance_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: hr_attendance hr_attendance_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_attendance
    ADD CONSTRAINT hr_attendance_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.hr_employees(id) ON DELETE CASCADE;


--
-- Name: hr_attendance hr_attendance_period_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_attendance
    ADD CONSTRAINT hr_attendance_period_id_fkey FOREIGN KEY (period_id) REFERENCES public.monthly_periods(id) ON DELETE CASCADE;


--
-- Name: hr_employees hr_employees_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_employees
    ADD CONSTRAINT hr_employees_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: hr_employees hr_employees_supervisor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_employees
    ADD CONSTRAINT hr_employees_supervisor_id_fkey FOREIGN KEY (supervisor_id) REFERENCES public.hr_employees(id) ON DELETE SET NULL;


--
-- Name: hr_festival_allowances hr_festival_allowances_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_festival_allowances
    ADD CONSTRAINT hr_festival_allowances_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: hr_festival_allowances hr_festival_allowances_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_festival_allowances
    ADD CONSTRAINT hr_festival_allowances_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.hr_employees(id) ON DELETE CASCADE;


--
-- Name: hr_holiday_calendar hr_holiday_calendar_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_holiday_calendar
    ADD CONSTRAINT hr_holiday_calendar_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: hr_leave_requests hr_leave_requests_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_leave_requests
    ADD CONSTRAINT hr_leave_requests_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: hr_leave_requests hr_leave_requests_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_leave_requests
    ADD CONSTRAINT hr_leave_requests_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.hr_employees(id) ON DELETE CASCADE;


--
-- Name: hr_leave_requests hr_leave_requests_leave_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_leave_requests
    ADD CONSTRAINT hr_leave_requests_leave_type_id_fkey FOREIGN KEY (leave_type_id) REFERENCES public.hr_leave_types(id) ON DELETE SET NULL;


--
-- Name: hr_leave_types hr_leave_types_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_leave_types
    ADD CONSTRAINT hr_leave_types_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: hr_overtime_entries hr_overtime_entries_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_overtime_entries
    ADD CONSTRAINT hr_overtime_entries_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: hr_overtime_entries hr_overtime_entries_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_overtime_entries
    ADD CONSTRAINT hr_overtime_entries_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.hr_employees(id) ON DELETE CASCADE;


--
-- Name: hr_payroll_runs hr_payroll_runs_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_payroll_runs
    ADD CONSTRAINT hr_payroll_runs_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: hr_payroll_runs hr_payroll_runs_period_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_payroll_runs
    ADD CONSTRAINT hr_payroll_runs_period_id_fkey FOREIGN KEY (period_id) REFERENCES public.monthly_periods(id) ON DELETE CASCADE;


--
-- Name: hr_payslips hr_payslips_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_payslips
    ADD CONSTRAINT hr_payslips_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: hr_payslips hr_payslips_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_payslips
    ADD CONSTRAINT hr_payslips_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.hr_employees(id) ON DELETE CASCADE;


--
-- Name: hr_payslips hr_payslips_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_payslips
    ADD CONSTRAINT hr_payslips_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.hr_payroll_runs(id) ON DELETE CASCADE;


--
-- Name: hr_roster hr_roster_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_roster
    ADD CONSTRAINT hr_roster_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: hr_roster hr_roster_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_roster
    ADD CONSTRAINT hr_roster_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.hr_employees(id) ON DELETE CASCADE;


--
-- Name: hr_roster hr_roster_shift_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_roster
    ADD CONSTRAINT hr_roster_shift_type_id_fkey FOREIGN KEY (shift_type_id) REFERENCES public.hr_shift_types(id) ON DELETE SET NULL;


--
-- Name: hr_salary_components hr_salary_components_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_salary_components
    ADD CONSTRAINT hr_salary_components_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: hr_salary_components hr_salary_components_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_salary_components
    ADD CONSTRAINT hr_salary_components_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.hr_employees(id) ON DELETE CASCADE;


--
-- Name: hr_shift_types hr_shift_types_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_shift_types
    ADD CONSTRAINT hr_shift_types_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: items items_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.items
    ADD CONSTRAINT items_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.categories(id);


--
-- Name: items items_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.items
    ADD CONSTRAINT items_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: monthly_periods monthly_periods_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monthly_periods
    ADD CONSTRAINT monthly_periods_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: opening_stock opening_stock_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.opening_stock
    ADD CONSTRAINT opening_stock_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id);


--
-- Name: opening_stock opening_stock_period_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.opening_stock
    ADD CONSTRAINT opening_stock_period_id_fkey FOREIGN KEY (period_id) REFERENCES public.monthly_periods(id) ON DELETE CASCADE;


--
-- Name: overheads overheads_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.overheads
    ADD CONSTRAINT overheads_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id);


--
-- Name: overheads overheads_period_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.overheads
    ADD CONSTRAINT overheads_period_id_fkey FOREIGN KEY (period_id) REFERENCES public.monthly_periods(id);


--
-- Name: par_levels par_levels_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.par_levels
    ADD CONSTRAINT par_levels_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id);


--
-- Name: par_levels par_levels_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.par_levels
    ADD CONSTRAINT par_levels_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id);


--
-- Name: payable_payments payable_payments_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payable_payments
    ADD CONSTRAINT payable_payments_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id);


--
-- Name: payable_payments payable_payments_purchase_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payable_payments
    ADD CONSTRAINT payable_payments_purchase_entry_id_fkey FOREIGN KEY (purchase_entry_id) REFERENCES public.purchase_entries(id) ON DELETE CASCADE;


--
-- Name: pos_credit_notes pos_credit_notes_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_credit_notes
    ADD CONSTRAINT pos_credit_notes_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id);


--
-- Name: pos_credit_notes pos_credit_notes_issued_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_credit_notes
    ADD CONSTRAINT pos_credit_notes_issued_by_fkey FOREIGN KEY (issued_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: pos_credit_notes pos_credit_notes_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_credit_notes
    ADD CONSTRAINT pos_credit_notes_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.pos_orders(id);


--
-- Name: pos_customers pos_customers_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_customers
    ADD CONSTRAINT pos_customers_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: pos_kot_log pos_kot_log_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_kot_log
    ADD CONSTRAINT pos_kot_log_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id);


--
-- Name: pos_kot_log pos_kot_log_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_kot_log
    ADD CONSTRAINT pos_kot_log_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.pos_orders(id) ON DELETE CASCADE;


--
-- Name: pos_kot_log pos_kot_log_sent_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_kot_log
    ADD CONSTRAINT pos_kot_log_sent_by_fkey FOREIGN KEY (sent_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: pos_order_items pos_order_items_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_order_items
    ADD CONSTRAINT pos_order_items_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.pos_orders(id) ON DELETE CASCADE;


--
-- Name: pos_order_payments pos_order_payments_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_order_payments
    ADD CONSTRAINT pos_order_payments_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: pos_order_payments pos_order_payments_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_order_payments
    ADD CONSTRAINT pos_order_payments_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.pos_orders(id) ON DELETE CASCADE;


--
-- Name: pos_order_payments pos_order_payments_recorded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_order_payments
    ADD CONSTRAINT pos_order_payments_recorded_by_fkey FOREIGN KEY (recorded_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: pos_orders pos_orders_closed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_orders
    ADD CONSTRAINT pos_orders_closed_by_fkey FOREIGN KEY (closed_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: pos_orders pos_orders_credit_note_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_orders
    ADD CONSTRAINT pos_orders_credit_note_id_fkey FOREIGN KEY (credit_note_id) REFERENCES public.pos_credit_notes(id);


--
-- Name: pos_orders pos_orders_credit_settled_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_orders
    ADD CONSTRAINT pos_orders_credit_settled_by_fkey FOREIGN KEY (credit_settled_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: pos_orders pos_orders_shift_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_orders
    ADD CONSTRAINT pos_orders_shift_id_fkey FOREIGN KEY (shift_id) REFERENCES public.pos_shifts(id) ON DELETE SET NULL;


--
-- Name: pos_shifts pos_shifts_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_shifts
    ADD CONSTRAINT pos_shifts_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: pos_shifts pos_shifts_closed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_shifts
    ADD CONSTRAINT pos_shifts_closed_by_fkey FOREIGN KEY (closed_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: pos_shifts pos_shifts_opened_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_shifts
    ADD CONSTRAINT pos_shifts_opened_by_fkey FOREIGN KEY (opened_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: pos_tables pos_tables_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_tables
    ADD CONSTRAINT pos_tables_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: profiles profiles_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id);


--
-- Name: profiles profiles_hr_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_hr_employee_id_fkey FOREIGN KEY (hr_employee_id) REFERENCES public.hr_employees(id) ON DELETE SET NULL;


--
-- Name: profiles profiles_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: purchase_entries purchase_entries_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_entries
    ADD CONSTRAINT purchase_entries_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id);


--
-- Name: purchase_entries purchase_entries_period_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_entries
    ADD CONSTRAINT purchase_entries_period_id_fkey FOREIGN KEY (period_id) REFERENCES public.monthly_periods(id) ON DELETE CASCADE;


--
-- Name: purchase_entries purchase_entries_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_entries
    ADD CONSTRAINT purchase_entries_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.vendors(id);


--
-- Name: purchase_order_items purchase_order_items_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_order_items
    ADD CONSTRAINT purchase_order_items_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id);


--
-- Name: purchase_order_items purchase_order_items_po_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_order_items
    ADD CONSTRAINT purchase_order_items_po_id_fkey FOREIGN KEY (po_id) REFERENCES public.purchase_orders(id) ON DELETE CASCADE;


--
-- Name: purchase_orders purchase_orders_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_orders
    ADD CONSTRAINT purchase_orders_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: purchase_orders purchase_orders_period_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_orders
    ADD CONSTRAINT purchase_orders_period_id_fkey FOREIGN KEY (period_id) REFERENCES public.monthly_periods(id);


--
-- Name: purchase_orders purchase_orders_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_orders
    ADD CONSTRAINT purchase_orders_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.vendors(id);


--
-- Name: recipe_ingredients recipe_ingredients_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recipe_ingredients
    ADD CONSTRAINT recipe_ingredients_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id);


--
-- Name: recipe_ingredients recipe_ingredients_recipe_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recipe_ingredients
    ADD CONSTRAINT recipe_ingredients_recipe_id_fkey FOREIGN KEY (recipe_id) REFERENCES public.recipes(id) ON DELETE CASCADE;


--
-- Name: recipe_ingredients recipe_ingredients_sub_recipe_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recipe_ingredients
    ADD CONSTRAINT recipe_ingredients_sub_recipe_id_fkey FOREIGN KEY (sub_recipe_id) REFERENCES public.recipes(id);


--
-- Name: recipe_suggestions recipe_suggestions_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recipe_suggestions
    ADD CONSTRAINT recipe_suggestions_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: recipe_suggestions recipe_suggestions_recipe_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recipe_suggestions
    ADD CONSTRAINT recipe_suggestions_recipe_id_fkey FOREIGN KEY (recipe_id) REFERENCES public.recipes(id) ON DELETE CASCADE;


--
-- Name: recipe_suggestions recipe_suggestions_suggest_recipe_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recipe_suggestions
    ADD CONSTRAINT recipe_suggestions_suggest_recipe_id_fkey FOREIGN KEY (suggest_recipe_id) REFERENCES public.recipes(id) ON DELETE CASCADE;


--
-- Name: recipes recipes_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recipes
    ADD CONSTRAINT recipes_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: recipes recipes_linked_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recipes
    ADD CONSTRAINT recipes_linked_item_id_fkey FOREIGN KEY (linked_item_id) REFERENCES public.items(id);


--
-- Name: requisition_lines requisition_lines_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.requisition_lines
    ADD CONSTRAINT requisition_lines_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id) ON DELETE CASCADE;


--
-- Name: requisition_lines requisition_lines_requisition_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.requisition_lines
    ADD CONSTRAINT requisition_lines_requisition_id_fkey FOREIGN KEY (requisition_id) REFERENCES public.requisitions(id) ON DELETE CASCADE;


--
-- Name: requisitions requisitions_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.requisitions
    ADD CONSTRAINT requisitions_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: requisitions requisitions_period_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.requisitions
    ADD CONSTRAINT requisitions_period_id_fkey FOREIGN KEY (period_id) REFERENCES public.monthly_periods(id) ON DELETE CASCADE;


--
-- Name: sales_entries sales_entries_period_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_entries
    ADD CONSTRAINT sales_entries_period_id_fkey FOREIGN KEY (period_id) REFERENCES public.monthly_periods(id) ON DELETE CASCADE;


--
-- Name: sales_entries sales_entries_recipe_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_entries
    ADD CONSTRAINT sales_entries_recipe_id_fkey FOREIGN KEY (recipe_id) REFERENCES public.recipes(id);


--
-- Name: settings settings_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settings
    ADD CONSTRAINT settings_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: staff_meals staff_meals_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_meals
    ADD CONSTRAINT staff_meals_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id) ON DELETE CASCADE;


--
-- Name: staff_meals staff_meals_period_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_meals
    ADD CONSTRAINT staff_meals_period_id_fkey FOREIGN KEY (period_id) REFERENCES public.monthly_periods(id) ON DELETE CASCADE;


--
-- Name: stock_movements stock_movements_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT stock_movements_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id);


--
-- Name: stock_movements stock_movements_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT stock_movements_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id);


--
-- Name: stock_movements stock_movements_period_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT stock_movements_period_id_fkey FOREIGN KEY (period_id) REFERENCES public.monthly_periods(id);


--
-- Name: stock_movements stock_movements_ref_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT stock_movements_ref_id_fkey FOREIGN KEY (ref_id) REFERENCES public.pos_orders(id) ON DELETE SET NULL;


--
-- Name: vendor_returns vendor_returns_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_returns
    ADD CONSTRAINT vendor_returns_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: vendor_returns vendor_returns_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_returns
    ADD CONSTRAINT vendor_returns_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id) ON DELETE CASCADE;


--
-- Name: vendor_returns vendor_returns_period_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_returns
    ADD CONSTRAINT vendor_returns_period_id_fkey FOREIGN KEY (period_id) REFERENCES public.monthly_periods(id) ON DELETE CASCADE;


--
-- Name: vendor_returns vendor_returns_purchase_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_returns
    ADD CONSTRAINT vendor_returns_purchase_entry_id_fkey FOREIGN KEY (purchase_entry_id) REFERENCES public.purchase_entries(id) ON DELETE SET NULL;


--
-- Name: vendor_returns vendor_returns_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_returns
    ADD CONSTRAINT vendor_returns_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.vendors(id) ON DELETE SET NULL;


--
-- Name: vendors vendors_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendors
    ADD CONSTRAINT vendors_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: wastages wastages_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wastages
    ADD CONSTRAINT wastages_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id);


--
-- Name: wastages wastages_period_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wastages
    ADD CONSTRAINT wastages_period_id_fkey FOREIGN KEY (period_id) REFERENCES public.monthly_periods(id) ON DELETE CASCADE;


--
-- Name: categories admin_all_categories; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_all_categories ON public.categories TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());


--
-- Name: clients admin_all_clients; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_all_clients ON public.clients TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());


--
-- Name: closing_stock admin_all_closing; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_all_closing ON public.closing_stock TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());


--
-- Name: items admin_all_items; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_all_items ON public.items TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());


--
-- Name: opening_stock admin_all_opening; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_all_opening ON public.opening_stock TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());


--
-- Name: purchase_entries admin_all_purchases; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_all_purchases ON public.purchase_entries TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());


--
-- Name: recipe_ingredients admin_all_recipe_ing; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_all_recipe_ing ON public.recipe_ingredients TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());


--
-- Name: recipes admin_all_recipes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_all_recipes ON public.recipes TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());


--
-- Name: sales_entries admin_all_sales; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_all_sales ON public.sales_entries TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());


--
-- Name: vendors admin_all_vendors; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_all_vendors ON public.vendors TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());


--
-- Name: wastages admin_all_wastages; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_all_wastages ON public.wastages TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());


--
-- Name: audit_logs admin_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_read ON public.audit_logs FOR SELECT USING ((( SELECT profiles.role
   FROM public.profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text));


--
-- Name: audit_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: budgets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.budgets ENABLE ROW LEVEL SECURITY;

--
-- Name: categories; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;

--
-- Name: categories categories_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY categories_all ON public.categories USING (((client_id = public.my_client_id()) OR public.is_admin())) WITH CHECK (((client_id = public.my_client_id()) OR public.is_admin()));


--
-- Name: categories categories_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY categories_delete ON public.categories FOR DELETE USING ((public.is_admin() OR (client_id = public.my_client_id())));


--
-- Name: categories categories_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY categories_insert ON public.categories FOR INSERT WITH CHECK ((public.is_admin() OR (client_id = public.my_client_id())));


--
-- Name: categories categories_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY categories_select ON public.categories FOR SELECT USING ((public.is_admin() OR (client_id = public.my_client_id())));


--
-- Name: categories categories_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY categories_update ON public.categories FOR UPDATE USING ((public.is_admin() OR (client_id = public.my_client_id())));


--
-- Name: hr_advance_repayments client_access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY client_access ON public.hr_advance_repayments USING (((( SELECT profiles.role
   FROM public.profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text) OR (client_id = ( SELECT profiles.client_id
   FROM public.profiles
  WHERE (profiles.id = auth.uid())))));


--
-- Name: hr_advances client_access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY client_access ON public.hr_advances USING (((( SELECT profiles.role
   FROM public.profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text) OR (client_id = ( SELECT profiles.client_id
   FROM public.profiles
  WHERE (profiles.id = auth.uid())))));


--
-- Name: hr_roster client_access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY client_access ON public.hr_roster USING (((( SELECT profiles.role
   FROM public.profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text) OR (client_id = ( SELECT profiles.client_id
   FROM public.profiles
  WHERE (profiles.id = auth.uid())))));


--
-- Name: hr_shift_types client_access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY client_access ON public.hr_shift_types USING (((( SELECT profiles.role
   FROM public.profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text) OR (client_id = ( SELECT profiles.client_id
   FROM public.profiles
  WHERE (profiles.id = auth.uid())))));


--
-- Name: purchase_order_items client_access_purchase_order_items; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY client_access_purchase_order_items ON public.purchase_order_items USING (((po_id IN ( SELECT purchase_orders.id
   FROM public.purchase_orders
  WHERE (purchase_orders.client_id IN ( SELECT profiles.client_id
           FROM public.profiles
          WHERE (profiles.id = auth.uid()))))) OR (EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))))) WITH CHECK (((po_id IN ( SELECT purchase_orders.id
   FROM public.purchase_orders
  WHERE (purchase_orders.client_id IN ( SELECT profiles.client_id
           FROM public.profiles
          WHERE (profiles.id = auth.uid()))))) OR (EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text))))));


--
-- Name: purchase_orders client_access_purchase_orders; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY client_access_purchase_orders ON public.purchase_orders USING (((client_id IN ( SELECT profiles.client_id
   FROM public.profiles
  WHERE (profiles.id = auth.uid()))) OR (EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))))) WITH CHECK (((client_id IN ( SELECT profiles.client_id
   FROM public.profiles
  WHERE (profiles.id = auth.uid()))) OR (EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text))))));


--
-- Name: budgets client_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY client_own ON public.budgets USING (((( SELECT profiles.role
   FROM public.profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text) OR (client_id = ( SELECT profiles.client_id
   FROM public.profiles
  WHERE (profiles.id = auth.uid()))))) WITH CHECK (((( SELECT profiles.role
   FROM public.profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text) OR (client_id = ( SELECT profiles.client_id
   FROM public.profiles
  WHERE (profiles.id = auth.uid())))));


--
-- Name: demand_forecast_daily client_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY client_own ON public.demand_forecast_daily TO authenticated USING (((client_id = ( SELECT profiles.client_id
   FROM public.profiles
  WHERE (profiles.id = auth.uid()))) OR (( SELECT profiles.role
   FROM public.profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text))) WITH CHECK (((client_id = ( SELECT profiles.client_id
   FROM public.profiles
  WHERE (profiles.id = auth.uid()))) OR (( SELECT profiles.role
   FROM public.profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text)));


--
-- Name: demand_forecast_run_log client_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY client_own ON public.demand_forecast_run_log TO authenticated USING (((client_id = ( SELECT profiles.client_id
   FROM public.profiles
  WHERE (profiles.id = auth.uid()))) OR (( SELECT profiles.role
   FROM public.profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text))) WITH CHECK (((client_id = ( SELECT profiles.client_id
   FROM public.profiles
  WHERE (profiles.id = auth.uid()))) OR (( SELECT profiles.role
   FROM public.profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text)));


--
-- Name: hr_attendance client_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY client_own ON public.hr_attendance USING (((( SELECT profiles.role
   FROM public.profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text) OR (client_id = ( SELECT profiles.client_id
   FROM public.profiles
  WHERE (profiles.id = auth.uid()))))) WITH CHECK (((( SELECT profiles.role
   FROM public.profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text) OR (client_id = ( SELECT profiles.client_id
   FROM public.profiles
  WHERE (profiles.id = auth.uid())))));


--
-- Name: hr_festival_allowances client_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY client_own ON public.hr_festival_allowances USING (((( SELECT profiles.role
   FROM public.profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text) OR (client_id = ( SELECT profiles.client_id
   FROM public.profiles
  WHERE (profiles.id = auth.uid()))))) WITH CHECK (((( SELECT profiles.role
   FROM public.profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text) OR (client_id = ( SELECT profiles.client_id
   FROM public.profiles
  WHERE (profiles.id = auth.uid())))));


--
-- Name: hr_leave_requests client_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY client_own ON public.hr_leave_requests USING (((( SELECT profiles.role
   FROM public.profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text) OR (client_id = ( SELECT profiles.client_id
   FROM public.profiles
  WHERE (profiles.id = auth.uid()))))) WITH CHECK (((( SELECT profiles.role
   FROM public.profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text) OR (client_id = ( SELECT profiles.client_id
   FROM public.profiles
  WHERE (profiles.id = auth.uid())))));


--
-- Name: hr_leave_types client_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY client_own ON public.hr_leave_types USING (((( SELECT profiles.role
   FROM public.profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text) OR (client_id = ( SELECT profiles.client_id
   FROM public.profiles
  WHERE (profiles.id = auth.uid()))))) WITH CHECK (((( SELECT profiles.role
   FROM public.profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text) OR (client_id = ( SELECT profiles.client_id
   FROM public.profiles
  WHERE (profiles.id = auth.uid())))));


--
-- Name: hr_payroll_runs client_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY client_own ON public.hr_payroll_runs USING (((( SELECT profiles.role
   FROM public.profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text) OR (client_id = ( SELECT profiles.client_id
   FROM public.profiles
  WHERE (profiles.id = auth.uid()))))) WITH CHECK (((( SELECT profiles.role
   FROM public.profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text) OR (client_id = ( SELECT profiles.client_id
   FROM public.profiles
  WHERE (profiles.id = auth.uid())))));


--
-- Name: hr_payslips client_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY client_own ON public.hr_payslips USING (((( SELECT profiles.role
   FROM public.profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text) OR (client_id = ( SELECT profiles.client_id
   FROM public.profiles
  WHERE (profiles.id = auth.uid()))))) WITH CHECK (((( SELECT profiles.role
   FROM public.profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text) OR (client_id = ( SELECT profiles.client_id
   FROM public.profiles
  WHERE (profiles.id = auth.uid())))));


--
-- Name: hr_salary_components client_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY client_own ON public.hr_salary_components USING (((( SELECT profiles.role
   FROM public.profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text) OR (client_id = ( SELECT profiles.client_id
   FROM public.profiles
  WHERE (profiles.id = auth.uid()))))) WITH CHECK (((( SELECT profiles.role
   FROM public.profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text) OR (client_id = ( SELECT profiles.client_id
   FROM public.profiles
  WHERE (profiles.id = auth.uid())))));


--
-- Name: payable_payments client_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY client_own ON public.payable_payments USING (((( SELECT profiles.role
   FROM public.profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text) OR (client_id = ( SELECT profiles.client_id
   FROM public.profiles
  WHERE (profiles.id = auth.uid()))))) WITH CHECK (((( SELECT profiles.role
   FROM public.profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text) OR (client_id = ( SELECT profiles.client_id
   FROM public.profiles
  WHERE (profiles.id = auth.uid())))));


--
-- Name: pos_credit_notes client_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY client_own ON public.pos_credit_notes USING (((( SELECT profiles.role
   FROM public.profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text) OR (client_id = ( SELECT profiles.client_id
   FROM public.profiles
  WHERE (profiles.id = auth.uid()))))) WITH CHECK (((( SELECT profiles.role
   FROM public.profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text) OR (client_id = ( SELECT profiles.client_id
   FROM public.profiles
  WHERE (profiles.id = auth.uid())))));


--
-- Name: pos_kot_log client_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY client_own ON public.pos_kot_log USING (((( SELECT profiles.role
   FROM public.profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text) OR (client_id = ( SELECT profiles.client_id
   FROM public.profiles
  WHERE (profiles.id = auth.uid()))))) WITH CHECK (((( SELECT profiles.role
   FROM public.profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text) OR (client_id = ( SELECT profiles.client_id
   FROM public.profiles
  WHERE (profiles.id = auth.uid())))));


--
-- Name: pos_order_payments client_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY client_own ON public.pos_order_payments USING (((( SELECT profiles.role
   FROM public.profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text) OR (client_id = ( SELECT profiles.client_id
   FROM public.profiles
  WHERE (profiles.id = auth.uid()))))) WITH CHECK (((( SELECT profiles.role
   FROM public.profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text) OR (client_id = ( SELECT profiles.client_id
   FROM public.profiles
  WHERE (profiles.id = auth.uid())))));


--
-- Name: pos_tables client_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY client_own ON public.pos_tables USING (((( SELECT profiles.role
   FROM public.profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text) OR (client_id = ( SELECT profiles.client_id
   FROM public.profiles
  WHERE (profiles.id = auth.uid()))))) WITH CHECK (((( SELECT profiles.role
   FROM public.profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text) OR (client_id = ( SELECT profiles.client_id
   FROM public.profiles
  WHERE (profiles.id = auth.uid())))));


--
-- Name: recipe_suggestions client_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY client_own ON public.recipe_suggestions TO authenticated USING (((client_id = ( SELECT profiles.client_id
   FROM public.profiles
  WHERE (profiles.id = auth.uid()))) OR (( SELECT profiles.role
   FROM public.profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text)));


--
-- Name: requisition_lines client_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY client_own ON public.requisition_lines USING (((( SELECT profiles.role
   FROM public.profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text) OR (requisition_id IN ( SELECT requisitions.id
   FROM public.requisitions
  WHERE (requisitions.client_id = ( SELECT profiles.client_id
           FROM public.profiles
          WHERE (profiles.id = auth.uid()))))))) WITH CHECK (((( SELECT profiles.role
   FROM public.profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text) OR (requisition_id IN ( SELECT requisitions.id
   FROM public.requisitions
  WHERE (requisitions.client_id = ( SELECT profiles.client_id
           FROM public.profiles
          WHERE (profiles.id = auth.uid())))))));


--
-- Name: requisitions client_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY client_own ON public.requisitions USING (((( SELECT profiles.role
   FROM public.profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text) OR (client_id = ( SELECT profiles.client_id
   FROM public.profiles
  WHERE (profiles.id = auth.uid()))))) WITH CHECK (((( SELECT profiles.role
   FROM public.profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text) OR (client_id = ( SELECT profiles.client_id
   FROM public.profiles
  WHERE (profiles.id = auth.uid())))));


--
-- Name: staff_meals client_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY client_own ON public.staff_meals USING (((( SELECT profiles.role
   FROM public.profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text) OR (period_id IN ( SELECT monthly_periods.id
   FROM public.monthly_periods
  WHERE (monthly_periods.client_id = ( SELECT profiles.client_id
           FROM public.profiles
          WHERE (profiles.id = auth.uid()))))))) WITH CHECK (((( SELECT profiles.role
   FROM public.profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text) OR (period_id IN ( SELECT monthly_periods.id
   FROM public.monthly_periods
  WHERE (monthly_periods.client_id = ( SELECT profiles.client_id
           FROM public.profiles
          WHERE (profiles.id = auth.uid())))))));


--
-- Name: hr_employees client_owns_employees; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY client_owns_employees ON public.hr_employees USING ((client_id = public.my_client_id()));


--
-- Name: purchase_order_items client_po_items; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY client_po_items ON public.purchase_order_items USING (((po_id IN ( SELECT purchase_orders.id
   FROM public.purchase_orders
  WHERE (purchase_orders.client_id IN ( SELECT profiles.client_id
           FROM public.profiles
          WHERE (profiles.id = auth.uid()))))) OR (EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text))))));


--
-- Name: purchase_orders client_purchase_orders; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY client_purchase_orders ON public.purchase_orders USING (((client_id IN ( SELECT profiles.client_id
   FROM public.profiles
  WHERE (profiles.id = auth.uid()))) OR (EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text))))));


--
-- Name: hr_holiday_calendar client_rw; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY client_rw ON public.hr_holiday_calendar USING (((( SELECT profiles.role
   FROM public.profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text) OR (client_id = ( SELECT profiles.client_id
   FROM public.profiles
  WHERE (profiles.id = auth.uid()))))) WITH CHECK (((( SELECT profiles.role
   FROM public.profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text) OR (client_id = ( SELECT profiles.client_id
   FROM public.profiles
  WHERE (profiles.id = auth.uid())))));


--
-- Name: hr_overtime_entries client_rw; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY client_rw ON public.hr_overtime_entries USING (((( SELECT profiles.role
   FROM public.profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text) OR (client_id = ( SELECT profiles.client_id
   FROM public.profiles
  WHERE (profiles.id = auth.uid()))))) WITH CHECK (((( SELECT profiles.role
   FROM public.profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text) OR (client_id = ( SELECT profiles.client_id
   FROM public.profiles
  WHERE (profiles.id = auth.uid())))));


--
-- Name: clients; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;

--
-- Name: clients clients_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY clients_delete ON public.clients FOR DELETE USING (public.is_admin());


--
-- Name: clients clients_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY clients_insert ON public.clients FOR INSERT WITH CHECK (public.is_admin());


--
-- Name: clients clients_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY clients_select ON public.clients FOR SELECT USING (((id = public.my_client_id()) OR public.is_admin()));


--
-- Name: clients clients_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY clients_update ON public.clients FOR UPDATE USING (public.is_admin());


--
-- Name: closing_stock closing_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY closing_insert ON public.closing_stock FOR INSERT WITH CHECK ((public.is_admin() OR (( SELECT monthly_periods.client_id
   FROM public.monthly_periods
  WHERE (monthly_periods.id = closing_stock.period_id)) = public.my_client_id())));


--
-- Name: closing_stock closing_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY closing_select ON public.closing_stock FOR SELECT USING ((public.is_admin() OR (( SELECT monthly_periods.client_id
   FROM public.monthly_periods
  WHERE (monthly_periods.id = closing_stock.period_id)) = public.my_client_id())));


--
-- Name: closing_stock; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.closing_stock ENABLE ROW LEVEL SECURITY;

--
-- Name: closing_stock closing_stock_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY closing_stock_all ON public.closing_stock USING ((public.is_admin() OR (EXISTS ( SELECT 1
   FROM public.monthly_periods p
  WHERE ((p.id = closing_stock.period_id) AND (p.client_id = public.my_client_id())))))) WITH CHECK ((public.is_admin() OR (EXISTS ( SELECT 1
   FROM public.monthly_periods p
  WHERE ((p.id = closing_stock.period_id) AND (p.client_id = public.my_client_id()))))));


--
-- Name: closing_stock closing_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY closing_update ON public.closing_stock FOR UPDATE USING ((public.is_admin() OR (( SELECT monthly_periods.client_id
   FROM public.monthly_periods
  WHERE (monthly_periods.id = closing_stock.period_id)) = public.my_client_id())));


--
-- Name: demand_forecast_daily; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.demand_forecast_daily ENABLE ROW LEVEL SECURITY;

--
-- Name: demand_forecast_run_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.demand_forecast_run_log ENABLE ROW LEVEL SECURITY;

--
-- Name: feature_flags; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.feature_flags ENABLE ROW LEVEL SECURITY;

--
-- Name: feature_flags feature_flags_rls; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY feature_flags_rls ON public.feature_flags USING ((public.is_admin() OR (client_id = public.my_client_id()))) WITH CHECK ((public.is_admin() OR (client_id = public.my_client_id())));


--
-- Name: hr_advance_repayments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.hr_advance_repayments ENABLE ROW LEVEL SECURITY;

--
-- Name: hr_advance_repayments hr_advance_repayments_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY hr_advance_repayments_policy ON public.hr_advance_repayments USING (((( SELECT profiles.role
   FROM public.profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text) OR (client_id = ( SELECT profiles.client_id
   FROM public.profiles
  WHERE (profiles.id = auth.uid())))));


--
-- Name: hr_advances; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.hr_advances ENABLE ROW LEVEL SECURITY;

--
-- Name: hr_advances hr_advances_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY hr_advances_policy ON public.hr_advances USING (((( SELECT profiles.role
   FROM public.profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text) OR (client_id = ( SELECT profiles.client_id
   FROM public.profiles
  WHERE (profiles.id = auth.uid())))));


--
-- Name: hr_attendance; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.hr_attendance ENABLE ROW LEVEL SECURITY;

--
-- Name: hr_employees; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.hr_employees ENABLE ROW LEVEL SECURITY;

--
-- Name: hr_employees hr_employees_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY hr_employees_delete ON public.hr_employees FOR DELETE USING (((( SELECT profiles.role
   FROM public.profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text) OR (client_id = ( SELECT profiles.client_id
   FROM public.profiles
  WHERE (profiles.id = auth.uid())))));


--
-- Name: hr_employees hr_employees_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY hr_employees_insert ON public.hr_employees FOR INSERT WITH CHECK (((( SELECT profiles.role
   FROM public.profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text) OR (client_id = ( SELECT profiles.client_id
   FROM public.profiles
  WHERE (profiles.id = auth.uid())))));


--
-- Name: hr_employees hr_employees_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY hr_employees_select ON public.hr_employees FOR SELECT USING (((( SELECT profiles.role
   FROM public.profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text) OR (client_id = ( SELECT profiles.client_id
   FROM public.profiles
  WHERE (profiles.id = auth.uid())))));


--
-- Name: hr_employees hr_employees_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY hr_employees_update ON public.hr_employees FOR UPDATE USING (((( SELECT profiles.role
   FROM public.profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text) OR (client_id = ( SELECT profiles.client_id
   FROM public.profiles
  WHERE (profiles.id = auth.uid()))))) WITH CHECK (((( SELECT profiles.role
   FROM public.profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text) OR (client_id = ( SELECT profiles.client_id
   FROM public.profiles
  WHERE (profiles.id = auth.uid())))));


--
-- Name: hr_festival_allowances; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.hr_festival_allowances ENABLE ROW LEVEL SECURITY;

--
-- Name: hr_holiday_calendar; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.hr_holiday_calendar ENABLE ROW LEVEL SECURITY;

--
-- Name: hr_leave_requests; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.hr_leave_requests ENABLE ROW LEVEL SECURITY;

--
-- Name: hr_leave_types; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.hr_leave_types ENABLE ROW LEVEL SECURITY;

--
-- Name: hr_overtime_entries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.hr_overtime_entries ENABLE ROW LEVEL SECURITY;

--
-- Name: hr_payroll_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.hr_payroll_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: hr_payslips; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.hr_payslips ENABLE ROW LEVEL SECURITY;

--
-- Name: hr_roster; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.hr_roster ENABLE ROW LEVEL SECURITY;

--
-- Name: hr_salary_components; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.hr_salary_components ENABLE ROW LEVEL SECURITY;

--
-- Name: hr_shift_types; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.hr_shift_types ENABLE ROW LEVEL SECURITY;

--
-- Name: items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.items ENABLE ROW LEVEL SECURITY;

--
-- Name: items items_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY items_all ON public.items USING (((client_id = public.my_client_id()) OR public.is_admin())) WITH CHECK (((client_id = public.my_client_id()) OR public.is_admin()));


--
-- Name: items items_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY items_delete ON public.items FOR DELETE USING ((public.is_admin() OR (client_id = public.my_client_id())));


--
-- Name: items items_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY items_insert ON public.items FOR INSERT WITH CHECK ((public.is_admin() OR (client_id = public.my_client_id())));


--
-- Name: items items_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY items_select ON public.items FOR SELECT USING ((public.is_admin() OR (client_id = public.my_client_id())));


--
-- Name: items items_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY items_update ON public.items FOR UPDATE USING ((public.is_admin() OR (client_id = public.my_client_id())));


--
-- Name: monthly_periods; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.monthly_periods ENABLE ROW LEVEL SECURITY;

--
-- Name: monthly_periods monthly_periods_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY monthly_periods_all ON public.monthly_periods USING (((client_id = public.my_client_id()) OR public.is_admin())) WITH CHECK (((client_id = public.my_client_id()) OR public.is_admin()));


--
-- Name: opening_stock opening_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY opening_insert ON public.opening_stock FOR INSERT WITH CHECK ((public.is_admin() OR (( SELECT monthly_periods.client_id
   FROM public.monthly_periods
  WHERE (monthly_periods.id = opening_stock.period_id)) = public.my_client_id())));


--
-- Name: opening_stock opening_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY opening_select ON public.opening_stock FOR SELECT USING ((public.is_admin() OR (( SELECT monthly_periods.client_id
   FROM public.monthly_periods
  WHERE (monthly_periods.id = opening_stock.period_id)) = public.my_client_id())));


--
-- Name: opening_stock; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.opening_stock ENABLE ROW LEVEL SECURITY;

--
-- Name: opening_stock opening_stock_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY opening_stock_all ON public.opening_stock USING ((public.is_admin() OR (EXISTS ( SELECT 1
   FROM public.monthly_periods p
  WHERE ((p.id = opening_stock.period_id) AND (p.client_id = public.my_client_id())))))) WITH CHECK ((public.is_admin() OR (EXISTS ( SELECT 1
   FROM public.monthly_periods p
  WHERE ((p.id = opening_stock.period_id) AND (p.client_id = public.my_client_id()))))));


--
-- Name: opening_stock opening_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY opening_update ON public.opening_stock FOR UPDATE USING ((public.is_admin() OR (( SELECT monthly_periods.client_id
   FROM public.monthly_periods
  WHERE (monthly_periods.id = opening_stock.period_id)) = public.my_client_id())));


--
-- Name: overheads; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.overheads ENABLE ROW LEVEL SECURITY;

--
-- Name: overheads overheads_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY overheads_all ON public.overheads USING (((client_id = public.my_client_id()) OR public.is_admin())) WITH CHECK (((client_id = public.my_client_id()) OR public.is_admin()));


--
-- Name: par_levels; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.par_levels ENABLE ROW LEVEL SECURITY;

--
-- Name: par_levels par_levels_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY par_levels_all ON public.par_levels USING (((client_id = public.my_client_id()) OR public.is_admin())) WITH CHECK (((client_id = public.my_client_id()) OR public.is_admin()));


--
-- Name: payable_payments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payable_payments ENABLE ROW LEVEL SECURITY;

--
-- Name: pos_credit_notes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pos_credit_notes ENABLE ROW LEVEL SECURITY;

--
-- Name: pos_customers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pos_customers ENABLE ROW LEVEL SECURITY;

--
-- Name: pos_customers pos_customers_client; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pos_customers_client ON public.pos_customers TO authenticated USING (((client_id = ( SELECT profiles.client_id
   FROM public.profiles
  WHERE (profiles.id = auth.uid()))) OR (( SELECT profiles.role
   FROM public.profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text)));


--
-- Name: pos_kot_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pos_kot_log ENABLE ROW LEVEL SECURITY;

--
-- Name: pos_order_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pos_order_items ENABLE ROW LEVEL SECURITY;

--
-- Name: pos_order_items pos_order_items_client; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pos_order_items_client ON public.pos_order_items TO authenticated USING (((client_id = ( SELECT profiles.client_id
   FROM public.profiles
  WHERE (profiles.id = auth.uid()))) OR (( SELECT profiles.role
   FROM public.profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text)));


--
-- Name: pos_order_payments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pos_order_payments ENABLE ROW LEVEL SECURITY;

--
-- Name: pos_orders; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pos_orders ENABLE ROW LEVEL SECURITY;

--
-- Name: pos_orders pos_orders_client; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pos_orders_client ON public.pos_orders TO authenticated USING (((client_id = ( SELECT profiles.client_id
   FROM public.profiles
  WHERE (profiles.id = auth.uid()))) OR (( SELECT profiles.role
   FROM public.profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text)));


--
-- Name: pos_shifts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pos_shifts ENABLE ROW LEVEL SECURITY;

--
-- Name: pos_shifts pos_shifts_client; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pos_shifts_client ON public.pos_shifts TO authenticated USING (((client_id = ( SELECT profiles.client_id
   FROM public.profiles
  WHERE (profiles.id = auth.uid()))) OR (( SELECT profiles.role
   FROM public.profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text)));


--
-- Name: pos_tables; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pos_tables ENABLE ROW LEVEL SECURITY;

--
-- Name: profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: profiles profiles_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY profiles_delete ON public.profiles FOR DELETE USING (public.is_admin());


--
-- Name: profiles profiles_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY profiles_insert ON public.profiles FOR INSERT WITH CHECK (public.is_admin());


--
-- Name: profiles profiles_pos_role_manager_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY profiles_pos_role_manager_update ON public.profiles FOR UPDATE TO authenticated USING (((client_id = ( SELECT profiles_1.client_id
   FROM public.profiles profiles_1
  WHERE (profiles_1.id = auth.uid()))) AND (( SELECT profiles_1.pos_role
   FROM public.profiles profiles_1
  WHERE (profiles_1.id = auth.uid())) = 'manager'::text))) WITH CHECK ((client_id = ( SELECT profiles_1.client_id
   FROM public.profiles profiles_1
  WHERE (profiles_1.id = auth.uid()))));


--
-- Name: profiles profiles_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY profiles_select ON public.profiles FOR SELECT USING (((id = auth.uid()) OR public.is_admin()));


--
-- Name: profiles profiles_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY profiles_update ON public.profiles FOR UPDATE USING (((id = auth.uid()) OR public.is_admin())) WITH CHECK (((id = auth.uid()) OR public.is_admin()));


--
-- Name: purchase_entries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.purchase_entries ENABLE ROW LEVEL SECURITY;

--
-- Name: purchase_entries purchase_entries_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY purchase_entries_all ON public.purchase_entries USING ((public.is_admin() OR (EXISTS ( SELECT 1
   FROM public.monthly_periods p
  WHERE ((p.id = purchase_entries.period_id) AND (p.client_id = public.my_client_id())))))) WITH CHECK ((public.is_admin() OR (EXISTS ( SELECT 1
   FROM public.monthly_periods p
  WHERE ((p.id = purchase_entries.period_id) AND (p.client_id = public.my_client_id()))))));


--
-- Name: purchase_order_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.purchase_order_items ENABLE ROW LEVEL SECURITY;

--
-- Name: purchase_orders; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.purchase_orders ENABLE ROW LEVEL SECURITY;

--
-- Name: purchase_entries purchases_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY purchases_delete ON public.purchase_entries FOR DELETE USING ((public.is_admin() OR (( SELECT monthly_periods.client_id
   FROM public.monthly_periods
  WHERE (monthly_periods.id = purchase_entries.period_id)) = public.my_client_id())));


--
-- Name: purchase_entries purchases_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY purchases_insert ON public.purchase_entries FOR INSERT WITH CHECK ((public.is_admin() OR (( SELECT monthly_periods.client_id
   FROM public.monthly_periods
  WHERE (monthly_periods.id = purchase_entries.period_id)) = public.my_client_id())));


--
-- Name: purchase_entries purchases_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY purchases_select ON public.purchase_entries FOR SELECT USING ((public.is_admin() OR (( SELECT monthly_periods.client_id
   FROM public.monthly_periods
  WHERE (monthly_periods.id = purchase_entries.period_id)) = public.my_client_id())));


--
-- Name: purchase_entries purchases_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY purchases_update ON public.purchase_entries FOR UPDATE USING ((public.is_admin() OR (( SELECT monthly_periods.client_id
   FROM public.monthly_periods
  WHERE (monthly_periods.id = purchase_entries.period_id)) = public.my_client_id())));


--
-- Name: recipe_ingredients recipe_ing_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY recipe_ing_delete ON public.recipe_ingredients FOR DELETE USING ((public.is_admin() OR (( SELECT recipes.client_id
   FROM public.recipes
  WHERE (recipes.id = recipe_ingredients.recipe_id)) = public.my_client_id())));


--
-- Name: recipe_ingredients recipe_ing_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY recipe_ing_insert ON public.recipe_ingredients FOR INSERT WITH CHECK ((public.is_admin() OR (( SELECT recipes.client_id
   FROM public.recipes
  WHERE (recipes.id = recipe_ingredients.recipe_id)) = public.my_client_id())));


--
-- Name: recipe_ingredients recipe_ing_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY recipe_ing_select ON public.recipe_ingredients FOR SELECT USING ((public.is_admin() OR (( SELECT recipes.client_id
   FROM public.recipes
  WHERE (recipes.id = recipe_ingredients.recipe_id)) = public.my_client_id())));


--
-- Name: recipe_ingredients recipe_ing_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY recipe_ing_update ON public.recipe_ingredients FOR UPDATE USING ((public.is_admin() OR (( SELECT recipes.client_id
   FROM public.recipes
  WHERE (recipes.id = recipe_ingredients.recipe_id)) = public.my_client_id())));


--
-- Name: recipe_ingredients; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.recipe_ingredients ENABLE ROW LEVEL SECURITY;

--
-- Name: recipe_ingredients recipe_ingredients_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY recipe_ingredients_all ON public.recipe_ingredients USING ((public.is_admin() OR (EXISTS ( SELECT 1
   FROM public.recipes r
  WHERE ((r.id = recipe_ingredients.recipe_id) AND (r.client_id = public.my_client_id())))))) WITH CHECK ((public.is_admin() OR (EXISTS ( SELECT 1
   FROM public.recipes r
  WHERE ((r.id = recipe_ingredients.recipe_id) AND (r.client_id = public.my_client_id()))))));


--
-- Name: recipe_suggestions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.recipe_suggestions ENABLE ROW LEVEL SECURITY;

--
-- Name: recipes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.recipes ENABLE ROW LEVEL SECURITY;

--
-- Name: recipes recipes_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY recipes_all ON public.recipes USING (((client_id = public.my_client_id()) OR public.is_admin())) WITH CHECK (((client_id = public.my_client_id()) OR public.is_admin()));


--
-- Name: recipes recipes_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY recipes_delete ON public.recipes FOR DELETE USING ((public.is_admin() OR (client_id = public.my_client_id())));


--
-- Name: recipes recipes_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY recipes_insert ON public.recipes FOR INSERT WITH CHECK ((public.is_admin() OR (client_id = public.my_client_id())));


--
-- Name: recipes recipes_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY recipes_select ON public.recipes FOR SELECT USING ((public.is_admin() OR (client_id = public.my_client_id())));


--
-- Name: recipes recipes_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY recipes_update ON public.recipes FOR UPDATE USING ((public.is_admin() OR (client_id = public.my_client_id())));


--
-- Name: requisition_lines; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.requisition_lines ENABLE ROW LEVEL SECURITY;

--
-- Name: requisitions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.requisitions ENABLE ROW LEVEL SECURITY;

--
-- Name: sales_entries sales_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sales_delete ON public.sales_entries FOR DELETE USING ((public.is_admin() OR (( SELECT monthly_periods.client_id
   FROM public.monthly_periods
  WHERE (monthly_periods.id = sales_entries.period_id)) = public.my_client_id())));


--
-- Name: sales_entries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sales_entries ENABLE ROW LEVEL SECURITY;

--
-- Name: sales_entries sales_entries_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sales_entries_all ON public.sales_entries USING ((public.is_admin() OR (EXISTS ( SELECT 1
   FROM public.monthly_periods p
  WHERE ((p.id = sales_entries.period_id) AND (p.client_id = public.my_client_id())))))) WITH CHECK ((public.is_admin() OR (EXISTS ( SELECT 1
   FROM public.monthly_periods p
  WHERE ((p.id = sales_entries.period_id) AND (p.client_id = public.my_client_id()))))));


--
-- Name: sales_entries sales_entries_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sales_entries_select ON public.sales_entries FOR SELECT USING (((( SELECT profiles.role
   FROM public.profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text) OR (period_id IN ( SELECT monthly_periods.id
   FROM public.monthly_periods
  WHERE (monthly_periods.client_id = ( SELECT profiles.client_id
           FROM public.profiles
          WHERE (profiles.id = auth.uid())))))));


--
-- Name: sales_entries sales_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sales_insert ON public.sales_entries FOR INSERT WITH CHECK ((public.is_admin() OR (( SELECT monthly_periods.client_id
   FROM public.monthly_periods
  WHERE (monthly_periods.id = sales_entries.period_id)) = public.my_client_id())));


--
-- Name: sales_entries sales_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sales_select ON public.sales_entries FOR SELECT USING ((public.is_admin() OR (( SELECT monthly_periods.client_id
   FROM public.monthly_periods
  WHERE (monthly_periods.id = sales_entries.period_id)) = public.my_client_id())));


--
-- Name: sales_entries sales_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sales_update ON public.sales_entries FOR UPDATE USING ((public.is_admin() OR (( SELECT monthly_periods.client_id
   FROM public.monthly_periods
  WHERE (monthly_periods.id = sales_entries.period_id)) = public.my_client_id())));


--
-- Name: settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;

--
-- Name: settings settings_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY settings_insert ON public.settings FOR INSERT WITH CHECK (public.is_admin());


--
-- Name: settings settings_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY settings_select ON public.settings FOR SELECT USING (((client_id IS NULL) OR (client_id = public.my_client_id()) OR public.is_admin()));


--
-- Name: settings settings_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY settings_update ON public.settings FOR UPDATE USING (public.is_admin());


--
-- Name: staff_meals; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.staff_meals ENABLE ROW LEVEL SECURITY;

--
-- Name: stock_movements; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.stock_movements ENABLE ROW LEVEL SECURITY;

--
-- Name: stock_movements stock_movements_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY stock_movements_all ON public.stock_movements USING (((( SELECT profiles.role
   FROM public.profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text) OR (client_id = ( SELECT profiles.client_id
   FROM public.profiles
  WHERE (profiles.id = auth.uid())))));


--
-- Name: vendor_returns; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.vendor_returns ENABLE ROW LEVEL SECURITY;

--
-- Name: vendor_returns vendor_returns: admin all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "vendor_returns: admin all" ON public.vendor_returns USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));


--
-- Name: vendor_returns vendor_returns: client delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "vendor_returns: client delete" ON public.vendor_returns FOR DELETE USING ((client_id = public.my_client_id()));


--
-- Name: vendor_returns vendor_returns: client insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "vendor_returns: client insert" ON public.vendor_returns FOR INSERT WITH CHECK ((client_id = ( SELECT profiles.client_id
   FROM public.profiles
  WHERE (profiles.id = auth.uid()))));


--
-- Name: vendor_returns vendor_returns: client read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "vendor_returns: client read" ON public.vendor_returns FOR SELECT USING ((client_id = public.my_client_id()));


--
-- Name: vendor_returns vendor_returns: client update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "vendor_returns: client update" ON public.vendor_returns FOR UPDATE USING ((client_id = public.my_client_id())) WITH CHECK ((client_id = public.my_client_id()));


--
-- Name: vendors; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.vendors ENABLE ROW LEVEL SECURITY;

--
-- Name: vendors vendors_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY vendors_all ON public.vendors USING (((client_id = public.my_client_id()) OR public.is_admin())) WITH CHECK (((client_id = public.my_client_id()) OR public.is_admin()));


--
-- Name: vendors vendors_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY vendors_delete ON public.vendors FOR DELETE USING ((public.is_admin() OR (client_id = public.my_client_id())));


--
-- Name: vendors vendors_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY vendors_insert ON public.vendors FOR INSERT WITH CHECK ((public.is_admin() OR (client_id = public.my_client_id())));


--
-- Name: vendors vendors_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY vendors_select ON public.vendors FOR SELECT USING ((public.is_admin() OR (client_id = public.my_client_id())));


--
-- Name: vendors vendors_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY vendors_update ON public.vendors FOR UPDATE USING ((public.is_admin() OR (client_id = public.my_client_id())));


--
-- Name: wastages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.wastages ENABLE ROW LEVEL SECURITY;

--
-- Name: wastages wastages_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY wastages_all ON public.wastages USING ((public.is_admin() OR (EXISTS ( SELECT 1
   FROM public.monthly_periods p
  WHERE ((p.id = wastages.period_id) AND (p.client_id = public.my_client_id())))))) WITH CHECK ((public.is_admin() OR (EXISTS ( SELECT 1
   FROM public.monthly_periods p
  WHERE ((p.id = wastages.period_id) AND (p.client_id = public.my_client_id()))))));


--
-- Name: wastages wastages_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY wastages_delete ON public.wastages FOR DELETE USING ((public.is_admin() OR (( SELECT monthly_periods.client_id
   FROM public.monthly_periods
  WHERE (monthly_periods.id = wastages.period_id)) = public.my_client_id())));


--
-- Name: wastages wastages_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY wastages_insert ON public.wastages FOR INSERT WITH CHECK ((public.is_admin() OR (( SELECT monthly_periods.client_id
   FROM public.monthly_periods
  WHERE (monthly_periods.id = wastages.period_id)) = public.my_client_id())));


--
-- Name: wastages wastages_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY wastages_select ON public.wastages FOR SELECT USING ((public.is_admin() OR (( SELECT monthly_periods.client_id
   FROM public.monthly_periods
  WHERE (monthly_periods.id = wastages.period_id)) = public.my_client_id())));


--
-- Name: wastages wastages_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY wastages_update ON public.wastages FOR UPDATE USING ((public.is_admin() OR (( SELECT monthly_periods.client_id
   FROM public.monthly_periods
  WHERE (monthly_periods.id = wastages.period_id)) = public.my_client_id())));


--
-- PostgreSQL database dump complete
--


