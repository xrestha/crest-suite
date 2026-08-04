-- Expands the Admin Audit Log (S518): audits the previously-uncovered POS money-risk
-- surface (pos_orders status/void/discount/invoice transitions, pos_credit_notes) and
-- admin-only client management (clients plan/module flags, feature_flags overrides), fixes
-- two dead entries the frontend already claimed to track (hr_attendance, hr_payslips had
-- labels/help-panel rows but no trigger), and adds noise-skip clauses so the new coverage
-- doesn't flood the table with non-events (a PIN retry, a bill reprint, a covers tweak).
--
-- log_audit() itself (definition in 20260705074838_baseline_schema.sql) is unchanged in
-- shape -- CREATE OR REPLACE is safe here since the return type (trigger) never changes.

CREATE OR REPLACE FUNCTION public.log_audit() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'auth'
    AS $$
DECLARE
  _client_id uuid; _client_name text; _user_id uuid; _user_name text; _record_id uuid;
  _old jsonb; _new jsonb;
BEGIN
  _user_id := auth.uid();
  SELECT full_name INTO _user_name FROM profiles WHERE id = _user_id;

  IF TG_OP = 'DELETE' THEN
    _record_id := OLD.id;
    IF TG_TABLE_NAME IN ('purchase_entries','opening_stock','closing_stock','wastages') THEN
      SELECT client_id INTO _client_id FROM monthly_periods WHERE id = OLD.period_id;
    ELSIF TG_TABLE_NAME = 'clients' THEN
      -- the clients table has no client_id column -- the row's own id IS the client, and its
      -- name must come off OLD directly since a re-SELECT after a DELETE would find nothing
      _client_id := OLD.id; _client_name := OLD.name;
    ELSE _client_id := OLD.client_id; END IF;
  ELSE
    _record_id := NEW.id;
    IF TG_TABLE_NAME IN ('purchase_entries','opening_stock','closing_stock','wastages') THEN
      SELECT client_id INTO _client_id FROM monthly_periods WHERE id = NEW.period_id;
    ELSIF TG_TABLE_NAME = 'clients' THEN
      _client_id := NEW.id; _client_name := NEW.name;
    ELSE _client_id := NEW.client_id; END IF;
  END IF;

  -- monthly_periods: only a status transition (open/closed) is audit-worthy
  IF TG_TABLE_NAME = 'monthly_periods' AND TG_OP = 'UPDATE' THEN
    IF OLD.status = NEW.status THEN RETURN NULL; END IF;
  END IF;

  -- profiles: PIN-lockout counters and last_seen_at churn on every login attempt / page load
  -- (record_pos_pin_attempt, record_hr_pin_attempt, session keep-alive) -- not audit signal,
  -- and left unfiltered would flood the table with zero-content rows on every failed PIN entry
  IF TG_TABLE_NAME = 'profiles' AND TG_OP = 'UPDATE' THEN
    IF (to_jsonb(OLD) - ARRAY['pos_pin_failed_attempts','pos_pin_locked_until','hr_pin_failed_attempts','hr_pin_locked_until','last_seen_at'])
       = (to_jsonb(NEW) - ARRAY['pos_pin_failed_attempts','pos_pin_locked_until','hr_pin_failed_attempts','hr_pin_locked_until','last_seen_at'])
    THEN RETURN NULL; END IF;
  END IF;

  -- pos_orders: covers/print_count/comp_print_count/notes change on nearly every item edit or
  -- bill reprint during a live order -- only real state transitions (status, close_type,
  -- discount, void, payment, invoice_no, credit settlement) are audit-worthy
  IF TG_TABLE_NAME = 'pos_orders' AND TG_OP = 'UPDATE' THEN
    IF (to_jsonb(OLD) - ARRAY['covers','print_count','comp_print_count','notes'])
       = (to_jsonb(NEW) - ARRAY['covers','print_count','comp_print_count','notes'])
    THEN RETURN NULL; END IF;
  END IF;

  IF _client_id IS NOT NULL AND _client_name IS NULL THEN
    SELECT name INTO _client_name FROM clients WHERE id = _client_id;
  END IF;

  _old := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END;
  _new := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END;

  -- pos_device_secret is the unguessable per-client secret that gates the anonymous
  -- get_pos_staff RPC (S372) -- never let it reach the audit trail, admin-only viewer or not
  IF TG_TABLE_NAME = 'clients' THEN
    IF _old IS NOT NULL THEN _old := _old - 'pos_device_secret'; END IF;
    IF _new IS NOT NULL THEN _new := _new - 'pos_device_secret'; END IF;
  END IF;

  INSERT INTO audit_logs (client_id, client_name, user_id, user_name, table_name, action, record_id, old_data, new_data)
  VALUES (_client_id, _client_name, _user_id, _user_name, TG_TABLE_NAME, TG_OP, _record_id, _old, _new);
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$;

-- Fix dead frontend entries: AuditLog.js has always listed these two as tracked, but no
-- trigger ever existed for them.
CREATE OR REPLACE TRIGGER audit_hr_attendance AFTER INSERT OR DELETE OR UPDATE ON public.hr_attendance FOR EACH ROW EXECUTE FUNCTION public.log_audit();
CREATE OR REPLACE TRIGGER audit_hr_payslips AFTER INSERT OR DELETE OR UPDATE ON public.hr_payslips FOR EACH ROW EXECUTE FUNCTION public.log_audit();

-- New coverage: the POS money-risk surface (voids, discounts, comps, credit notes) and
-- admin-only client/feature management, previously invisible to the audit log entirely.
CREATE OR REPLACE TRIGGER audit_pos_orders AFTER INSERT OR DELETE OR UPDATE ON public.pos_orders FOR EACH ROW EXECUTE FUNCTION public.log_audit();
CREATE OR REPLACE TRIGGER audit_pos_credit_notes AFTER INSERT OR DELETE OR UPDATE ON public.pos_credit_notes FOR EACH ROW EXECUTE FUNCTION public.log_audit();
CREATE OR REPLACE TRIGGER audit_clients AFTER INSERT OR DELETE OR UPDATE ON public.clients FOR EACH ROW EXECUTE FUNCTION public.log_audit();
CREATE OR REPLACE TRIGGER audit_feature_flags AFTER INSERT OR DELETE OR UPDATE ON public.feature_flags FOR EACH ROW EXECUTE FUNCTION public.log_audit();
