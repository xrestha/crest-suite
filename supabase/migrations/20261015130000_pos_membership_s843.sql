-- ════════════════════════════════════════════════════════════════════════════════════════════
-- S843, POS membership cards, customer birthdays and anniversaries, and a credit limit per
-- customer: the server half.
--
-- Owner decisions (2026-10-15):
--   * Membership cards are given, changed and taken away by a POS manager, the Owner or the
--     operator only.
--   * A birthday and an anniversary are kept per customer in the Nepali (BS) or the English (AD)
--     calendar, chosen per date. Month and day are required, the year is optional.
--   * Neither date is kept without the customer's agreement. The agreement is recorded with the
--     server's time and the login that recorded it, never a time or a name the device sends.
--   * A card's discount is an ordinary bill discount, inside the cashier's own discount cap. Nothing
--     here touches pos_orders or guard_pos_order_close.
--   * A manager may set a credit limit per customer. The till only warns: nothing in the database
--     refuses a Credit bill over it.
--
-- What this file changes:
--   (1) pos_membership_types, a new table: one row per kind of card an outlet gives ("Gold, 10%,
--       12 months"). Same-client RLS (one permissive FOR ALL policy, the wrapped helpers) plus the
--       restrictive trio pos_loyalty_schemes carries (Self-Service, IMS staff, HR-role staff). POS
--       PIN logins are deliberately not fenced: the till reads the types. guard_pos_membership_types
--       (BEFORE, SECURITY INVOKER, the current_user seam): every write needs a POS manager, the Owner
--       or the operator; the outlet cannot change; the server stamps created_by / created_at; a type
--       a customer still holds is not deleted (membership_type_in_use: switch it off instead).
--       Audited by log_audit().
--   (2) pos_customers gains birth_* / anniv_* (month, day, optional year, 'BS' or 'AD'), consent_at /
--       consent_by, membership_type_id, card_no, card_issued_on, card_expires_on and credit_limit,
--       with CHECKs, a card number unique per outlet (case and spaces ignored), and indexes for the
--       birthday and anniversary lists.
--   (3) pos_customers_guard_loyalty, rebuilt from its live body (20261012170000): a card, a card
--       number or date, or a credit limit needs a POS manager (rank_required); a type given must be
--       this outlet's and switched on (membership_type_invalid); a birthday, an anniversary or the
--       consent needs a POS supervisor (rank_required); consent is stamped by the server and kept as
--       recorded; withdrawing it clears both dates in the same save (consent_required). The fast
--       path that lets the till's customer upsert through now also requires every new column to be
--       untouched: before, any update leaving scheme, phone, outlet and id alone passed unchecked.
--   (4) The three customer audit triggers also fire on a membership, card or credit-limit change.
--       Birthdays, anniversaries and consent are deliberately left out of their WHEN clauses
--       (section 4 says why, and what that does not cover).
--
-- What depends on it (app, same release):
--   * src/shared/scopedDb.js: 'pos_membership_types' in CLIENT_SCOPED_TABLES (also what exports it).
--   * src/modules/admin/dataExport/restoreClientData.js: 'pos_membership_types' in RESTORE_ORDER
--     BEFORE 'pos_customers' (restoreClientData.test.js reads this file's foreign key).
--   * supabase/functions/admin-user-ops/index.ts: the client delete and the POS module clear delete
--     pos_customers BEFORE pos_membership_types (the key is NO ACTION; the guard lets the service
--     role through). POS_RECORD_WORDS needs 'pos_customers.consent_by' and
--     'pos_membership_types.created_by': both are new keys to a login that
--     pos_login_reference_columns() now counts, so POS Staff offers Block, not Delete, for a login
--     that recorded a consent or made a type. posLoginRecords.test.js fails until they are worded.
--     Then redeploy admin-user-ops.
--   * src/shared/errorText.js: hints rank_required (messages start "pos_customers:" or
--     "pos_membership_types:"), membership_type_invalid, membership_type_in_use,
--     membership_type_outlet_locked, consent_required.
--   No till sends any new column, and the till's customer upsert passes the fast path unchanged, so
--   the till build floor stays where it is.
--
-- Built on the live pos_customers_guard_loyalty body read 2026-10-15 (the body 20261012170000
-- wrote). Section 0 pins two literal lines copied from it, because its md5 could not be read from
-- the live database when this file was written. Section 0 also refuses a second run: the new columns
-- must not exist yet. The file locks pos_customers for its length (a second or two); a bill close
-- that saves a customer waits for it.
--
-- To undo (dropping the columns loses every card, limit, date and consent recorded since):
--   DROP TRIGGER audit_pos_customers_enrolment_ins / _upd / _del ON pos_customers and re-create them
--   from 20261010110000 section 7; re-create pos_customers_guard_loyalty from 20261012170000
--   section 3; ALTER TABLE pos_customers DROP COLUMN membership_type_id, card_no, card_issued_on,
--   card_expires_on, credit_limit, birth_month, birth_day, birth_year, birth_calendar, anniv_month,
--   anniv_day, anniv_year, anniv_calendar, consent_at, consent_by (their CHECKs, key and indexes go
--   with them); DROP TABLE pos_membership_types; DROP FUNCTION guard_pos_membership_types().
--
-- The probe (section 5) acts at BLOOM CAFE (or the first POS outlet with an Owner and a POS till
-- login) as its Owner, as that till login made a plain supervisor and then staff, and as the
-- operator, inside a block that rolls itself back. If any check fails, nothing lands.
-- ════════════════════════════════════════════════════════════════════════════════════════════


-- ── 0. Pre-flight ──────────────────────────────────────────────────────────────────────────────
-- The guard's md5(prosrc) could not be read from the live database when this was written, so the
-- body is pinned by two literal lines copied from it: the comment over the enrolment test this file
-- rewrites, and the phone-lock sentence 20261012170000 last changed. Both must be present.
DO $$
DECLARE
  v_src  text;
  v_cols text;
BEGIN
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = to_regprocedure('public.pos_customers_guard_loyalty()');
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'S843 pre-flight: public.pos_customers_guard_loyalty() does not exist';
  END IF;
  -- And by md5, read from the live database by the main session on 2026-10-15.
  IF md5(v_src) IS DISTINCT FROM '8de45d984d5fd1e4d9f65bb1d62d2718'
     OR position($pina$  -- Reached only by an enrolment change: an INSERT with a scheme, or an UPDATE of the scheme.$pina$ IN v_src) = 0
     OR position($pinb$    RAISE EXCEPTION 'pos_customer_phone_locked: a customer''s phone number and outlet are what their loyalty points and bill history belong to, so they cannot be changed — a new number starts a new customer the first time a bill is closed with it, and the Owner or a POS manager takes a regular''s points to their new number with Move to a new number (the ⋯ on their row in Customers → Loyalty)'$pinb$ IN v_src) = 0 THEN
    RAISE EXCEPTION 'S843 pre-flight: pos_customers_guard_loyalty changed since this file was written (md5 %). Rebuild from the live body.', md5(v_src);
  END IF;

  IF to_regclass('public.pos_customers') IS NULL THEN
    RAISE EXCEPTION 'S843 pre-flight: public.pos_customers does not exist';
  END IF;
  SELECT string_agg(a.attname::text, ', ' ORDER BY a.attname) INTO v_cols
    FROM pg_attribute a
   WHERE a.attrelid = 'public.pos_customers'::regclass AND a.attnum > 0 AND NOT a.attisdropped
     AND a.attname IN ('birth_month', 'birth_day', 'birth_year', 'birth_calendar',
                       'anniv_month', 'anniv_day', 'anniv_year', 'anniv_calendar',
                       'consent_at', 'consent_by', 'membership_type_id', 'card_no',
                       'card_issued_on', 'card_expires_on', 'credit_limit');
  IF v_cols IS NOT NULL THEN
    RAISE EXCEPTION 'S843 pre-flight: pos_customers already has %. This file has run before, or something else added them.', v_cols;
  END IF;
  IF to_regclass('public.pos_membership_types') IS NOT NULL THEN
    RAISE EXCEPTION 'S843 pre-flight: public.pos_membership_types already exists';
  END IF;
  IF to_regprocedure('public.pos_caller_has_rank(text)') IS NULL OR to_regprocedure('public.log_audit()') IS NULL THEN
    RAISE EXCEPTION 'S843 pre-flight: pos_caller_has_rank(text) or log_audit() is missing';
  END IF;
END;
$$;


-- ── 1. Membership types ──────────────────────────────────────────────────────────────────────
-- One row per kind of card an outlet gives. valid_months is how long a card of this type runs from
-- the day it is given (NULL: it does not expire); the app works out card_expires_on from it.
CREATE TABLE public.pos_membership_types (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id    uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  name         text NOT NULL CONSTRAINT pos_membership_types_name_check CHECK (char_length(btrim(name)) BETWEEN 1 AND 40),
  discount_pct numeric(5,2) NOT NULL CONSTRAINT pos_membership_types_discount_pct_check CHECK (discount_pct > 0 AND discount_pct <= 100),
  valid_months integer CONSTRAINT pos_membership_types_valid_months_check CHECK (valid_months IS NULL OR valid_months BETWEEN 1 AND 120),
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid REFERENCES public.profiles(id) ON DELETE SET NULL
);

-- One name per outlet, ignoring case and outer spaces. It leads on client_id, so it also serves the
-- outlet's list and the clients cascade: no second index on client_id (pos_combos' shape).
CREATE UNIQUE INDEX pos_membership_types_client_name_key
  ON public.pos_membership_types (client_id, lower(btrim(name)));

COMMENT ON TABLE public.pos_membership_types IS
  'S843: the kinds of membership card an outlet gives (name, discount %, months a card runs). Written by a POS manager, the Owner or the operator (guard_pos_membership_types). A type a customer holds is switched off, never deleted. The discount is an ordinary bill discount inside the cashier''s own cap.';

-- RLS: one permissive FOR ALL policy, my_client_id() (never its body), every helper wrapped so it is
-- evaluated once per query, and the whole test COALESCEd.
ALTER TABLE public.pos_membership_types ENABLE ROW LEVEL SECURITY;

CREATE POLICY pos_membership_types_all ON public.pos_membership_types
  FOR ALL TO authenticated
  USING (COALESCE((SELECT public.is_admin()) OR client_id = (SELECT public.my_client_id()), false))
  WITH CHECK (COALESCE((SELECT public.is_admin()) OR client_id = (SELECT public.my_client_id()), false));

-- The restrictive trio pos_loyalty_schemes carries. POS PIN logins are deliberately NOT fenced out:
-- the till reads the types to price a member's bill.
CREATE POLICY no_self_service_accounts ON public.pos_membership_types AS RESTRICTIVE FOR ALL
  USING (NOT (SELECT public.is_hr_self_service())) WITH CHECK (NOT (SELECT public.is_hr_self_service()));
CREATE POLICY no_ims_staff ON public.pos_membership_types AS RESTRICTIVE FOR ALL
  USING (NOT (SELECT public.is_ims_staff())) WITH CHECK (NOT (SELECT public.is_ims_staff()));
CREATE POLICY no_hr_role_staff ON public.pos_membership_types AS RESTRICTIVE FOR ALL
  USING (NOT (SELECT public.is_hr_role_staff())) WITH CHECK (NOT (SELECT public.is_hr_role_staff()));

-- Nothing for anon; the four row commands for logins (RLS and the guard narrow them); everything for
-- the service role (Danger Zone). No TRUNCATE, REFERENCES or TRIGGER for either browser role.
REVOKE ALL ON public.pos_membership_types FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pos_membership_types TO authenticated;
GRANT ALL ON public.pos_membership_types TO service_role;

-- SECURITY INVOKER, so current_user tells a client session from the service role, the migration's
-- role, a DEFINER body or a cascade's own statements (guard_profiles_privileged_columns' seam).
CREATE OR REPLACE FUNCTION public.guard_pos_membership_types()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Deleting the whole client (ClientDrawer, from the operator's session): inside that cascade the
  -- client row is already gone (the S748 test). The operator sees every client, so the read is whole.
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM clients c WHERE c.id = OLD.client_id) THEN
    RETURN OLD;
  END IF;

  IF NOT COALESCE(public.pos_caller_has_rank('manager'), false) THEN
    RAISE EXCEPTION 'pos_membership_types: only the Owner or a POS manager can add, change or delete a membership type'
      USING ERRCODE = '42501', HINT = 'rank_required';
  END IF;

  IF TG_OP = 'DELETE' THEN
    -- The foreign key (NO ACTION) refuses this anyway; this says why, in words. A holder the caller
    -- cannot see is still refused by the key.
    IF EXISTS (SELECT 1 FROM pos_customers pc WHERE pc.membership_type_id = OLD.id) THEN
      RAISE EXCEPTION 'membership_type_in_use: customers still hold this membership type, so it cannot be deleted — switch it off instead, so it is no longer given to anyone new'
        USING ERRCODE = '23503', HINT = 'membership_type_in_use';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- The operator's restore puts a type back as it was made: dated before the restore, its
    -- created_by emptied as every *_by is. Every other insert is stamped here.
    IF NOT (COALESCE(public.is_admin(), false) AND COALESCE(NEW.created_at < now(), false)) THEN
      NEW.created_at := now();
      NEW.created_by := (SELECT auth.uid());
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.client_id IS DISTINCT FROM OLD.client_id OR NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'membership_type_outlet_locked: a membership type belongs to the outlet that made it and cannot be moved to another'
      USING ERRCODE = '42501', HINT = 'membership_type_outlet_locked';
  END IF;
  NEW.created_at := OLD.created_at;
  NEW.created_by := OLD.created_by;
  RETURN NEW;
END;
$function$;

-- A trigger function needs no EXECUTE grant (checked at CREATE TRIGGER, never at fire time).
REVOKE ALL ON FUNCTION public.guard_pos_membership_types() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER guard_pos_membership_types
  BEFORE INSERT OR UPDATE OR DELETE ON public.pos_membership_types
  FOR EACH ROW EXECUTE FUNCTION public.guard_pos_membership_types();

CREATE TRIGGER audit_pos_membership_types
  AFTER INSERT OR DELETE OR UPDATE ON public.pos_membership_types
  FOR EACH ROW EXECUTE FUNCTION public.log_audit();


-- ── 2. The customer's card, limit and dates ──────────────────────────────────────────────────
-- membership_type_id is NO ACTION, not RESTRICT (pos_loyalty_ledger_customer_id_fkey's reasoning):
-- both refuse deleting a type a customer holds, but NO ACTION is checked at the end of the
-- statement, so deleting a client, which cascades into both tables in one statement, still works.
-- consent_by and the type's created_by point at profiles, SET NULL, so pos_login_reference_columns()
-- counts them: POS Staff will not delete a login whose name these records carry.
ALTER TABLE public.pos_customers
  ADD COLUMN birth_month smallint,
  ADD COLUMN birth_day smallint,
  ADD COLUMN birth_year smallint,
  ADD COLUMN birth_calendar text,
  ADD COLUMN anniv_month smallint,
  ADD COLUMN anniv_day smallint,
  ADD COLUMN anniv_year smallint,
  ADD COLUMN anniv_calendar text,
  ADD COLUMN consent_at timestamptz,
  ADD COLUMN consent_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN membership_type_id uuid REFERENCES public.pos_membership_types(id) ON DELETE NO ACTION,
  ADD COLUMN card_no text,
  ADD COLUMN card_issued_on date,
  ADD COLUMN card_expires_on date,
  ADD COLUMN credit_limit numeric(12,2);

-- A CHECK passes on NULL, so every rule that could evaluate to NULL is COALESCEd to false.
-- A BS month has 29 to 32 days depending on the year, and the year is optional, so a BS day is held
-- to 1..32 only. An AD day is held to its month's length (29 for February: a year may be absent).
ALTER TABLE public.pos_customers
  ADD CONSTRAINT pos_customers_birth_calendar_check
    CHECK (COALESCE(birth_calendar IS NULL OR birth_calendar IN ('BS', 'AD'), false)),
  ADD CONSTRAINT pos_customers_anniv_calendar_check
    CHECK (COALESCE(anniv_calendar IS NULL OR anniv_calendar IN ('BS', 'AD'), false)),
  ADD CONSTRAINT pos_customers_birth_month_check
    CHECK (COALESCE(birth_month IS NULL OR birth_month BETWEEN 1 AND 12, false)),
  ADD CONSTRAINT pos_customers_anniv_month_check
    CHECK (COALESCE(anniv_month IS NULL OR anniv_month BETWEEN 1 AND 12, false)),
  ADD CONSTRAINT pos_customers_birth_day_check
    CHECK (COALESCE(birth_day IS NULL
                    OR (birth_day BETWEEN 1 AND 32
                        AND (birth_calendar IS DISTINCT FROM 'AD'
                             OR birth_day <= CASE birth_month WHEN 2 THEN 29 WHEN 4 THEN 30 WHEN 6 THEN 30
                                                              WHEN 9 THEN 30 WHEN 11 THEN 30 ELSE 31 END)), false)),
  ADD CONSTRAINT pos_customers_anniv_day_check
    CHECK (COALESCE(anniv_day IS NULL
                    OR (anniv_day BETWEEN 1 AND 32
                        AND (anniv_calendar IS DISTINCT FROM 'AD'
                             OR anniv_day <= CASE anniv_month WHEN 2 THEN 29 WHEN 4 THEN 30 WHEN 6 THEN 30
                                                              WHEN 9 THEN 30 WHEN 11 THEN 30 ELSE 31 END)), false)),
  -- Month, day and calendar come together or not at all.
  ADD CONSTRAINT pos_customers_birth_parts_check
    CHECK ((birth_month IS NULL) = (birth_day IS NULL) AND (birth_month IS NULL) = (birth_calendar IS NULL)),
  ADD CONSTRAINT pos_customers_anniv_parts_check
    CHECK ((anniv_month IS NULL) = (anniv_day IS NULL) AND (anniv_month IS NULL) = (anniv_calendar IS NULL)),
  -- The year is optional, and only with a month.
  ADD CONSTRAINT pos_customers_birth_year_check
    CHECK (COALESCE(birth_year IS NULL OR (birth_month IS NOT NULL AND birth_year BETWEEN 1900 AND 2200), false)),
  ADD CONSTRAINT pos_customers_anniv_year_check
    CHECK (COALESCE(anniv_year IS NULL OR (anniv_month IS NOT NULL AND anniv_year BETWEEN 1900 AND 2200), false)),
  -- No date without the customer's agreement; and who recorded it only with when.
  ADD CONSTRAINT pos_customers_dates_need_consent
    CHECK (consent_at IS NOT NULL OR (birth_month IS NULL AND anniv_month IS NULL)),
  ADD CONSTRAINT pos_customers_consent_by_check
    CHECK (consent_by IS NULL OR consent_at IS NOT NULL),
  -- A card belongs to a membership.
  ADD CONSTRAINT pos_customers_card_no_check
    CHECK (COALESCE(card_no IS NULL OR char_length(btrim(card_no)) BETWEEN 1 AND 30, false)),
  ADD CONSTRAINT pos_customers_card_needs_membership
    CHECK (membership_type_id IS NOT NULL OR (card_no IS NULL AND card_issued_on IS NULL AND card_expires_on IS NULL)),
  ADD CONSTRAINT pos_customers_card_dates_check
    CHECK (COALESCE(card_expires_on IS NULL OR card_issued_on IS NULL OR card_expires_on >= card_issued_on, false)),
  ADD CONSTRAINT pos_customers_credit_limit_check
    CHECK (COALESCE(credit_limit IS NULL OR credit_limit >= 0, false));

-- One card number per outlet, ignoring case and outer spaces.
CREATE UNIQUE INDEX pos_customers_client_card_no_key
  ON public.pos_customers (client_id, upper(btrim(card_no))) WHERE card_no IS NOT NULL;
-- "Birthdays this month" and "anniversaries this month", per outlet.
CREATE INDEX pos_customers_birth_month_idx
  ON public.pos_customers (client_id, birth_month) WHERE birth_month IS NOT NULL;
CREATE INDEX pos_customers_anniv_month_idx
  ON public.pos_customers (client_id, anniv_month) WHERE anniv_month IS NOT NULL;
-- The type guard's "does anyone hold it?" and the key's own check on a type's delete.
CREATE INDEX pos_customers_membership_type_idx
  ON public.pos_customers (membership_type_id) WHERE membership_type_id IS NOT NULL;

COMMENT ON COLUMN public.pos_customers.birth_calendar IS
  'S843: BS or AD, the calendar birth_month and birth_day (and the optional birth_year) are in. Kept only with consent_at. anniv_* is the same shape for an anniversary.';
COMMENT ON COLUMN public.pos_customers.consent_at IS
  'S843: when the customer agreed to their birthday and anniversary being kept. Stamped by the server (pos_customers_guard_loyalty) with consent_by, the login that recorded it. A client value is ignored. Cleared only together with every date.';
COMMENT ON COLUMN public.pos_customers.membership_type_id IS
  'S843: the membership card this customer holds. Given, changed and taken away by a POS manager, the Owner or the operator, with card_no, card_issued_on and card_expires_on (AD dates). Its discount is an ordinary bill discount.';
COMMENT ON COLUMN public.pos_customers.credit_limit IS
  'S843: the most this customer may owe on Credit bills, set by a POS manager. The till warns past it. Nothing in the database refuses a bill over it.';


-- ── 3. The customer guard, rebuilt from its live body ─────────────────────────────────────────
-- Unchanged: the DELETE branch, the current_user seam, the phone lock, the operator's exemption and
-- the enrolment rank test (which now runs only when the scheme itself changes, the one case that
-- used to reach it). Added: the fast path tests every new column; (a) a type given must be this
-- outlet's and switched on, for every client session, the operator included, except that the
-- operator's restore may put back a customer holding a type since switched off; (c) consent is the
-- server's record; then, after the operator's exemption, (a) a card or a credit limit needs a POS
-- manager and (b) a birthday, an anniversary or the consent needs a POS supervisor.
CREATE OR REPLACE FUNCTION public.pos_customers_guard_loyalty()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_type_client uuid;
  v_type_active boolean;
  v_card        boolean;
  v_personal    boolean;
BEGIN
  -- S809 1i (DATABASE-5): a delete never takes a customer's points history with it.
  IF TG_OP = 'DELETE' THEN
    IF current_user NOT IN ('anon', 'authenticated') THEN
      RETURN OLD;
    END IF;
    IF EXISTS (SELECT 1 FROM pos_loyalty_ledger l WHERE l.customer_id = OLD.id) THEN
      RAISE EXCEPTION 'pos_customer_has_points_history: this customer has a loyalty points history (every point earned and spent, and which bills spent them), so the customer cannot be deleted — take them off their scheme in Customers → Loyalty instead'
        USING ERRCODE = '42501', HINT = 'pos_customer_has_points_history';
    END IF;
    IF OLD.loyalty_scheme_id IS NOT NULL
       AND NOT COALESCE(public.pos_caller_has_rank('manager'), false) THEN
      RAISE EXCEPTION 'pos_customer_delete_rank: this customer is enrolled in a loyalty scheme, and only the Owner or a POS manager can take a customer out of one'
        USING ERRCODE = '42501', HINT = 'pos_customer_delete_rank';
    END IF;
    RETURN OLD;
  END IF;

  -- Cheap test first: this fires on every bill closed with a name and phone. The till's upsert
  -- re-sends the phone and outlet it matched on, so its row leaves all four of these unchanged.
  -- S843: it sends no membership, card, credit limit, birthday, anniversary or consent either, so
  -- those are tested here too. Any of them set or changed takes the long way below.
  IF (TG_OP = 'INSERT'
      AND NEW.loyalty_scheme_id IS NULL
      AND NEW.membership_type_id IS NULL AND NEW.card_no IS NULL AND NEW.card_issued_on IS NULL
      AND NEW.card_expires_on IS NULL AND NEW.credit_limit IS NULL
      AND NEW.birth_month IS NULL AND NEW.birth_day IS NULL AND NEW.birth_year IS NULL AND NEW.birth_calendar IS NULL
      AND NEW.anniv_month IS NULL AND NEW.anniv_day IS NULL AND NEW.anniv_year IS NULL AND NEW.anniv_calendar IS NULL
      AND NEW.consent_at IS NULL AND NEW.consent_by IS NULL)
     OR (TG_OP = 'UPDATE'
         AND NEW.loyalty_scheme_id IS NOT DISTINCT FROM OLD.loyalty_scheme_id
         AND NEW.phone             IS NOT DISTINCT FROM OLD.phone
         AND NEW.client_id         IS NOT DISTINCT FROM OLD.client_id
         AND NEW.id                IS NOT DISTINCT FROM OLD.id
         AND (NEW.membership_type_id, NEW.card_no, NEW.card_issued_on, NEW.card_expires_on, NEW.credit_limit)
             IS NOT DISTINCT FROM (OLD.membership_type_id, OLD.card_no, OLD.card_issued_on, OLD.card_expires_on, OLD.credit_limit)
         AND (NEW.birth_month, NEW.birth_day, NEW.birth_year, NEW.birth_calendar,
              NEW.anniv_month, NEW.anniv_day, NEW.anniv_year, NEW.anniv_calendar,
              NEW.consent_at, NEW.consent_by)
             IS NOT DISTINCT FROM (OLD.birth_month, OLD.birth_day, OLD.birth_year, OLD.birth_calendar,
                                   OLD.anniv_month, OLD.anniv_day, OLD.anniv_year, OLD.anniv_calendar,
                                   OLD.consent_at, OLD.consent_by)) THEN
    RETURN NEW;
  END IF;
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;

  -- S809 1i (CUSTOMERS-PARKING-7): the balance belongs to the phone, because the loyalty RPCs find
  -- the customer by the phone on the bill. No screen changes a phone, an outlet or an id.
  IF TG_OP = 'UPDATE'
     AND (NEW.phone     IS DISTINCT FROM OLD.phone
       OR NEW.client_id IS DISTINCT FROM OLD.client_id
       OR NEW.id        IS DISTINCT FROM OLD.id) THEN
    RAISE EXCEPTION 'pos_customer_phone_locked: a customer''s phone number and outlet are what their loyalty points and bill history belong to, so they cannot be changed — a new number starts a new customer the first time a bill is closed with it, and the Owner or a POS manager takes a regular''s points to their new number with Move to a new number (the ⋯ on their row in Customers → Loyalty)'
      USING ERRCODE = '42501', HINT = 'pos_customer_phone_locked';
  END IF;

  -- S843: a card number is kept trimmed and upper-cased, the way the till looks it up (and the way
  -- the unique key compares it), whoever typed it and however.
  IF NEW.card_no IS NOT NULL THEN
    NEW.card_no := NULLIF(upper(btrim(NEW.card_no)), '');
  END IF;

  -- S843 (a): a membership type given is this outlet's own, whoever gives it, and is switched on.
  -- The operator's restore may put back a customer holding a type since switched off. The read is
  -- the caller's own (INVOKER): a type the caller cannot see is refused, never let through.
  IF NEW.membership_type_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.membership_type_id IS DISTINCT FROM OLD.membership_type_id) THEN
    SELECT t.client_id, t.is_active INTO v_type_client, v_type_active
      FROM pos_membership_types t
     WHERE t.id = NEW.membership_type_id;
    IF v_type_client IS DISTINCT FROM NEW.client_id
       OR (NOT COALESCE(v_type_active, false) AND NOT COALESCE(public.is_admin(), false)) THEN
      RAISE EXCEPTION 'membership_type_invalid: a customer can only be given one of this outlet''s own membership types, and only one that is switched on'
        USING ERRCODE = '23514', HINT = 'membership_type_invalid';
    END IF;
  END IF;

  -- S843 (c): the consent is the server's record. Agreeing stamps the server's time and the login
  -- that recorded it, whatever the device sent; a recorded consent is kept as recorded; clearing it
  -- clears who recorded it too, and needs every date cleared in the same save. The operator's
  -- restore inserts a customer with the consent dated as it was (before the restore; consent_by
  -- comes back empty, as every *_by does).
  IF TG_OP = 'INSERT' THEN
    IF NEW.consent_at IS NULL THEN
      NEW.consent_by := NULL;
    ELSIF NOT (COALESCE(public.is_admin(), false) AND COALESCE(NEW.consent_at < now(), false)) THEN
      NEW.consent_at := now();
      NEW.consent_by := (SELECT auth.uid());
    END IF;
  ELSIF OLD.consent_at IS NULL THEN
    IF NEW.consent_at IS NULL THEN
      NEW.consent_by := NULL;
    ELSE
      NEW.consent_at := now();
      NEW.consent_by := (SELECT auth.uid());
    END IF;
  ELSIF NEW.consent_at IS NULL THEN
    NEW.consent_by := NULL;
  ELSE
    NEW.consent_at := OLD.consent_at;
    NEW.consent_by := OLD.consent_by;
  END IF;
  IF NEW.consent_at IS NULL
     AND (NEW.birth_month IS NOT NULL OR NEW.birth_day IS NOT NULL OR NEW.birth_year IS NOT NULL OR NEW.birth_calendar IS NOT NULL
       OR NEW.anniv_month IS NOT NULL OR NEW.anniv_day IS NOT NULL OR NEW.anniv_year IS NOT NULL OR NEW.anniv_calendar IS NOT NULL) THEN
    RAISE EXCEPTION 'consent_required: a birthday or an anniversary is kept only when the customer has agreed to it — record that they agreed, or, to withdraw their agreement, clear both dates in the same save'
      USING ERRCODE = '23514', HINT = 'consent_required';
  END IF;

  -- The operator's restore inserts enrolled customers, card holders and customers with dates; it
  -- passes the rank tests below as before. The two tests above apply to it too.
  IF COALESCE(public.is_admin(), false) THEN
    RETURN NEW;
  END IF;

  -- Enrolment: an INSERT with a scheme, or an UPDATE of the scheme. S843: since more than an
  -- enrolment change now reaches this point, the test names the change it is about.
  IF ((TG_OP = 'INSERT' AND NEW.loyalty_scheme_id IS NOT NULL)
      OR (TG_OP = 'UPDATE' AND NEW.loyalty_scheme_id IS DISTINCT FROM OLD.loyalty_scheme_id))
     AND NOT COALESCE(public.pos_caller_has_rank('manager'), false) THEN
    RAISE EXCEPTION 'loyalty_enrol_rank: only the Owner or a POS manager can enrol a customer in a loyalty scheme'
      USING ERRCODE = '42501', HINT = 'loyalty_enrol_rank';
  END IF;

  -- S843 (a) and (b), on what will actually be stored (after the consent above).
  IF TG_OP = 'INSERT' THEN
    v_card := NEW.membership_type_id IS NOT NULL OR NEW.card_no IS NOT NULL OR NEW.card_issued_on IS NOT NULL
           OR NEW.card_expires_on IS NOT NULL OR NEW.credit_limit IS NOT NULL;
    v_personal := NEW.birth_month IS NOT NULL OR NEW.birth_day IS NOT NULL OR NEW.birth_year IS NOT NULL
               OR NEW.birth_calendar IS NOT NULL OR NEW.anniv_month IS NOT NULL OR NEW.anniv_day IS NOT NULL
               OR NEW.anniv_year IS NOT NULL OR NEW.anniv_calendar IS NOT NULL
               OR NEW.consent_at IS NOT NULL OR NEW.consent_by IS NOT NULL;
  ELSE
    v_card := (NEW.membership_type_id, NEW.card_no, NEW.card_issued_on, NEW.card_expires_on, NEW.credit_limit)
              IS DISTINCT FROM (OLD.membership_type_id, OLD.card_no, OLD.card_issued_on, OLD.card_expires_on, OLD.credit_limit);
    v_personal := (NEW.birth_month, NEW.birth_day, NEW.birth_year, NEW.birth_calendar,
                   NEW.anniv_month, NEW.anniv_day, NEW.anniv_year, NEW.anniv_calendar,
                   NEW.consent_at, NEW.consent_by)
                  IS DISTINCT FROM (OLD.birth_month, OLD.birth_day, OLD.birth_year, OLD.birth_calendar,
                                    OLD.anniv_month, OLD.anniv_day, OLD.anniv_year, OLD.anniv_calendar,
                                    OLD.consent_at, OLD.consent_by);
  END IF;
  IF v_card AND NOT COALESCE(public.pos_caller_has_rank('manager'), false) THEN
    RAISE EXCEPTION 'pos_customers: only the Owner or a POS manager can give, change or take away a customer''s membership card, or set their credit limit'
      USING ERRCODE = '42501', HINT = 'rank_required';
  END IF;
  IF v_personal AND NOT COALESCE(public.pos_caller_has_rank('supervisor'), false) THEN
    RAISE EXCEPTION 'pos_customers: only a POS supervisor or manager, or the Owner, can record or change a customer''s birthday, anniversary or agreement to keep them'
      USING ERRCODE = '42501', HINT = 'rank_required';
  END IF;
  RETURN NEW;
END;
$function$;


-- ── 4. The customer book's audit triggers ────────────────────────────────────────────────────
-- log_audit() is the shared AFTER trigger (full row snapshots, the signed-in login). The WHEN clauses
-- keep the till's upsert out, as before, and now also catch a membership, card or credit-limit
-- change. card_no and the card dates need no INSERT/DELETE test of their own: a card cannot exist
-- without a membership (pos_customers_card_needs_membership).
--
-- Birthdays, anniversaries and the consent are deliberately NOT in any WHEN clause. They are personal
-- data (Nepal's Individual Privacy Act, 2075), and a change to them alone must not copy the customer
-- row into audit_logs, which is kept for years and read by the operator. What this does not cover:
-- log_audit() snapshots the WHOLE row, so a row written for a membership, phone or enrolment change
-- still carries the dates as they stood. Keeping them out of those rows too would need a pos_customers
-- strip clause inside log_audit() (the clients.pos_device_secret shape), which this file does not add.
DROP TRIGGER IF EXISTS audit_pos_customers_enrolment_ins ON public.pos_customers;
CREATE TRIGGER audit_pos_customers_enrolment_ins
  AFTER INSERT ON public.pos_customers
  FOR EACH ROW WHEN (NEW.loyalty_scheme_id IS NOT NULL
                     OR NEW.membership_type_id IS NOT NULL
                     OR NEW.credit_limit IS NOT NULL)
  EXECUTE FUNCTION public.log_audit();

DROP TRIGGER IF EXISTS audit_pos_customers_enrolment_upd ON public.pos_customers;
CREATE TRIGGER audit_pos_customers_enrolment_upd
  AFTER UPDATE ON public.pos_customers
  FOR EACH ROW WHEN (OLD.loyalty_scheme_id IS DISTINCT FROM NEW.loyalty_scheme_id
                     OR OLD.phone IS DISTINCT FROM NEW.phone
                     OR OLD.client_id IS DISTINCT FROM NEW.client_id
                     OR OLD.membership_type_id IS DISTINCT FROM NEW.membership_type_id
                     OR OLD.card_no IS DISTINCT FROM NEW.card_no
                     OR OLD.card_expires_on IS DISTINCT FROM NEW.card_expires_on
                     OR OLD.credit_limit IS DISTINCT FROM NEW.credit_limit)
  EXECUTE FUNCTION public.log_audit();

DROP TRIGGER IF EXISTS audit_pos_customers_enrolment_del ON public.pos_customers;
CREATE TRIGGER audit_pos_customers_enrolment_del
  AFTER DELETE ON public.pos_customers
  FOR EACH ROW WHEN (OLD.loyalty_scheme_id IS NOT NULL
                     OR OLD.membership_type_id IS NOT NULL
                     OR OLD.credit_limit IS NOT NULL)
  EXECUTE FUNCTION public.log_audit();


-- ── 5. Prove it ───────────────────────────────────────────────────────────────────────────────
-- The catalog first, asserted on catalog columns; then the probe, which rolls itself back.
DO $$
DECLARE
  -- Phone numbers no real guest has: asserted absent from the outlet's customer book first.
  c_p1 CONSTANT text := '9100843001';   -- the regular: a birthday, then a card
  c_p2 CONSTANT text := '9100843002';   -- a second customer, for the refusals
  c_p3 CONSTANT text := '9100843003';   -- the operator's restore shape
  c_p4 CONSTANT text := '9100843004';   -- the Owner's new customer with an anniversary
  c_p5 CONSTANT text := '9100843005';   -- a new customer from the till
  c_cols CONSTANT text[] := ARRAY['birth_month', 'birth_day', 'birth_year', 'birth_calendar',
                                  'anniv_month', 'anniv_day', 'anniv_year', 'anniv_calendar',
                                  'consent_at', 'consent_by', 'membership_type_id', 'card_no',
                                  'card_issued_on', 'card_expires_on', 'credit_limit'];
  c_checks CONSTANT text[] := ARRAY['pos_customers_birth_calendar_check', 'pos_customers_anniv_calendar_check',
                                    'pos_customers_birth_month_check', 'pos_customers_anniv_month_check',
                                    'pos_customers_birth_day_check', 'pos_customers_anniv_day_check',
                                    'pos_customers_birth_parts_check', 'pos_customers_anniv_parts_check',
                                    'pos_customers_birth_year_check', 'pos_customers_anniv_year_check',
                                    'pos_customers_dates_need_consent', 'pos_customers_consent_by_check',
                                    'pos_customers_card_no_check', 'pos_customers_card_needs_membership',
                                    'pos_customers_card_dates_check', 'pos_customers_credit_limit_check'];
  v_types   regclass := 'public.pos_membership_types'::regclass;
  v_cust    regclass := 'public.pos_customers'::regclass;
  v_priv    text;
  v_client  uuid;
  v_owner   uuid;
  v_staff   uuid;
  v_admin   uuid;
  v_other   uuid;
  v_type    uuid;
  v_type_off  uuid;
  v_type_else uuid;
  v_type_old  uuid;
  v_c1      uuid;
  v_c2      uuid;
  v_c3      uuid;
  v_c4      uuid;
  v_n       bigint;
  v_hint    text;
  v_msg     text;
  v_state   text;
  v_src     text;
  v_at      timestamptz;
  v_by      uuid;
  r         record;
BEGIN
  -- ── The table, its policies and its grants ───────────────────────────────────────────────────
  IF NOT COALESCE((SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = v_types), false) THEN
    RAISE EXCEPTION 'S843: pos_membership_types has RLS off';
  END IF;
  SELECT count(*) INTO v_n FROM pg_policy p WHERE p.polrelid = v_types AND p.polpermissive;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'S843: pos_membership_types has % permissive policies, not 1', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM pg_policy p
   WHERE p.polrelid = v_types AND p.polpermissive AND p.polname = 'pos_membership_types_all' AND p.polcmd = '*'
     AND p.polroles = ARRAY[(SELECT ro.oid FROM pg_roles ro WHERE ro.rolname = 'authenticated')]
     AND position('my_client_id' IN pg_get_expr(p.polqual, p.polrelid)) > 0
     AND position('my_client_id' IN pg_get_expr(p.polwithcheck, p.polrelid)) > 0
     AND position('profiles' IN pg_get_expr(p.polqual, p.polrelid)) = 0;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'S843: pos_membership_types_all is not FOR ALL TO authenticated over my_client_id()';
  END IF;
  SELECT count(*) INTO v_n FROM pg_policy p WHERE p.polrelid = v_types AND NOT p.polpermissive;
  IF v_n <> 3 OR (SELECT count(*) FROM pg_policy p
                   WHERE p.polrelid = v_types AND NOT p.polpermissive AND p.polcmd = '*'
                     AND p.polname IN ('no_self_service_accounts', 'no_ims_staff', 'no_hr_role_staff')) <> 3 THEN
    RAISE EXCEPTION 'S843: pos_membership_types has % restrictive policies, not the three staff fences', v_n;
  END IF;
  FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
    IF has_table_privilege('anon', 'public.pos_membership_types', v_priv) THEN
      RAISE EXCEPTION 'S843: anon holds % on pos_membership_types', v_priv;
    END IF;
    IF has_table_privilege('authenticated', 'public.pos_membership_types', v_priv)
       IS DISTINCT FROM (v_priv IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')) THEN
      RAISE EXCEPTION 'S843: authenticated % on pos_membership_types is not as granted', v_priv;
    END IF;
  END LOOP;
  IF NOT has_table_privilege('service_role', 'public.pos_membership_types', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.pos_membership_types', 'DELETE') THEN
    RAISE EXCEPTION 'S843: the service role cannot read or delete pos_membership_types (Danger Zone needs both)';
  END IF;

  -- ── The two guards: INVOKER, a fixed search_path, attached and enabled ───────────────────────
  SELECT count(*) INTO v_n FROM pg_proc p
   WHERE p.oid IN ('public.guard_pos_membership_types()'::regprocedure, 'public.pos_customers_guard_loyalty()'::regprocedure)
     AND NOT p.prosecdef AND 'search_path=public' = ANY (p.proconfig);
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'S843: a guard is SECURITY DEFINER or has no fixed search_path (% of 2 as built)', v_n;
  END IF;
  -- tgtype: ROW 1, BEFORE 2, INSERT 4, DELETE 8, UPDATE 16.
  SELECT count(*) INTO v_n FROM pg_trigger t
   WHERE NOT t.tgisinternal AND t.tgenabled = 'O'
     AND ((t.tgrelid = v_types AND t.tgname = 'guard_pos_membership_types'
           AND t.tgfoid = 'public.guard_pos_membership_types()'::regprocedure AND t.tgtype = 31)
       OR (t.tgrelid = v_types AND t.tgname = 'audit_pos_membership_types'
           AND t.tgfoid = 'public.log_audit()'::regprocedure AND t.tgtype = 29)
       OR (t.tgrelid = v_cust AND t.tgfoid = 'public.pos_customers_guard_loyalty()'::regprocedure
           AND (t.tgtype & 31) = 31));
  IF v_n <> 3 THEN
    RAISE EXCEPTION 'S843: % of the 3 guard and audit triggers are attached and enabled as built', v_n;
  END IF;
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = 'public.pos_customers_guard_loyalty()'::regprocedure;
  IF position('NEW.membership_type_id' IN v_src) = 0 OR position('consent_required' IN v_src) = 0
     OR position('pos_caller_has_rank(''supervisor'')' IN v_src) = 0
     OR position('pos_customer_has_points_history' IN v_src) = 0 OR position('pos_customer_phone_locked' IN v_src) = 0
     OR position('loyalty_enrol_rank' IN v_src) = 0
     OR position('IF COALESCE(public.is_admin(), false) THEN' IN v_src) = 0
     OR position('IF current_user NOT IN (''anon'', ''authenticated'') THEN' IN v_src) = 0 THEN
    RAISE EXCEPTION 'S843: pos_customers_guard_loyalty is not the body this file writes';
  END IF;

  -- ── The three customer audit triggers: the new columns in, the personal ones out ────────────
  v_n := 0;
  FOR r IN SELECT t.tgname, t.tgfoid, t.tgenabled, pg_get_triggerdef(t.oid) AS def
             FROM pg_trigger t
            WHERE t.tgrelid = v_cust
              AND t.tgname IN ('audit_pos_customers_enrolment_ins', 'audit_pos_customers_enrolment_upd',
                               'audit_pos_customers_enrolment_del') LOOP
    v_n := v_n + 1;
    IF r.tgfoid <> 'public.log_audit()'::regprocedure OR r.tgenabled <> 'O'
       OR position('loyalty_scheme_id' IN r.def) = 0
       OR position('membership_type_id' IN r.def) = 0 OR position('credit_limit' IN r.def) = 0
       OR position('birth_' IN r.def) > 0 OR position('anniv_' IN r.def) > 0 OR position('consent' IN r.def) > 0
       OR (r.tgname = 'audit_pos_customers_enrolment_upd'
           AND (position('card_no' IN r.def) = 0 OR position('card_expires_on' IN r.def) = 0
                OR position('phone' IN r.def) = 0 OR position('client_id' IN r.def) = 0)) THEN
      RAISE EXCEPTION 'S843: % is not as built: %', r.tgname, r.def;
    END IF;
  END LOOP;
  IF v_n <> 3 THEN
    RAISE EXCEPTION 'S843: % of the 3 customer audit triggers exist', v_n;
  END IF;

  -- ── The columns, their keys, CHECKs and indexes ──────────────────────────────────────────────
  SELECT count(*) INTO v_n FROM pg_attribute a
   WHERE a.attrelid = v_cust AND a.attnum > 0 AND NOT a.attisdropped AND a.attname::text = ANY (c_cols)
     AND a.atttypid = CASE WHEN a.attname IN ('birth_month', 'birth_day', 'birth_year',
                                              'anniv_month', 'anniv_day', 'anniv_year') THEN 'int2'::regtype
                           WHEN a.attname IN ('birth_calendar', 'anniv_calendar', 'card_no') THEN 'text'::regtype
                           WHEN a.attname = 'consent_at' THEN 'timestamptz'::regtype
                           WHEN a.attname IN ('consent_by', 'membership_type_id') THEN 'uuid'::regtype
                           WHEN a.attname IN ('card_issued_on', 'card_expires_on') THEN 'date'::regtype
                           WHEN a.attname = 'credit_limit' THEN 'numeric'::regtype END;
  IF v_n <> 15 THEN
    RAISE EXCEPTION 'S843: % of the 15 new pos_customers columns exist with their types', v_n;
  END IF;
  IF (SELECT c.confdeltype FROM pg_constraint c
       WHERE c.conrelid = v_cust AND c.contype = 'f' AND c.confrelid = v_types
         AND c.conkey = ARRAY[(SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = v_cust AND a.attname = 'membership_type_id')])
     IS DISTINCT FROM 'a'
     OR (SELECT c.confdeltype FROM pg_constraint c
          WHERE c.conrelid = v_cust AND c.contype = 'f' AND c.confrelid = 'public.profiles'::regclass
            AND c.conkey = ARRAY[(SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = v_cust AND a.attname = 'consent_by')])
        IS DISTINCT FROM 'n'
     OR (SELECT c.confdeltype FROM pg_constraint c
          WHERE c.conrelid = v_types AND c.contype = 'f' AND c.confrelid = 'public.profiles'::regclass)
        IS DISTINCT FROM 'n'
     OR (SELECT c.confdeltype FROM pg_constraint c
          WHERE c.conrelid = v_types AND c.contype = 'f' AND c.confrelid = 'public.clients'::regclass)
        IS DISTINCT FROM 'c' THEN
    RAISE EXCEPTION 'S843: a foreign key''s delete action is not as built (membership NO ACTION, consent_by and created_by SET NULL, client CASCADE)';
  END IF;
  SELECT count(*) INTO v_n FROM pg_constraint c
   WHERE c.conrelid = v_cust AND c.contype = 'c' AND c.convalidated AND c.conname::text = ANY (c_checks);
  IF v_n <> cardinality(c_checks) THEN
    RAISE EXCEPTION 'S843: % of the % customer CHECKs are in place and validated', v_n, cardinality(c_checks);
  END IF;
  SELECT count(*) INTO v_n FROM pg_index i
   WHERE i.indisvalid
     AND ((i.indexrelid = 'public.pos_customers_client_card_no_key'::regclass AND i.indisunique AND i.indpred IS NOT NULL
           AND i.indkey[0] = (SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = v_cust AND a.attname = 'client_id'))
       OR (i.indexrelid = 'public.pos_customers_birth_month_idx'::regclass AND i.indpred IS NOT NULL
           AND i.indkey[0] = (SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = v_cust AND a.attname = 'client_id')
           AND i.indkey[1] = (SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = v_cust AND a.attname = 'birth_month'))
       OR (i.indexrelid = 'public.pos_customers_anniv_month_idx'::regclass AND i.indpred IS NOT NULL
           AND i.indkey[0] = (SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = v_cust AND a.attname = 'client_id')
           AND i.indkey[1] = (SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = v_cust AND a.attname = 'anniv_month'))
       OR (i.indexrelid = 'public.pos_customers_membership_type_idx'::regclass AND i.indpred IS NOT NULL
           AND i.indkey[0] = (SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = v_cust AND a.attname = 'membership_type_id'))
       OR (i.indexrelid = 'public.pos_membership_types_client_name_key'::regclass AND i.indisunique
           AND i.indkey[0] = (SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = v_types AND a.attname = 'client_id')));
  IF v_n <> 5 THEN
    RAISE EXCEPTION 'S843: % of the 5 new indexes are valid and lead on the columns built', v_n;
  END IF;

  -- ── Who acts: BLOOM CAFE (or the first POS outlet with an Owner and a POS till login) ─────────
  SELECT c.id, o.id, s.id INTO v_client, v_owner, v_staff
    FROM public.clients c
    JOIN LATERAL (SELECT p.id FROM public.profiles p
                   WHERE COALESCE(p.active_client_id, p.client_id) = c.id AND p.role = 'client'
                     AND p.pos_role IS NULL AND p.pos_email IS NULL AND p.ims_role IS NULL AND p.hr_role IS NULL
                     AND NOT COALESCE(p.hr_self_service, false)
                   ORDER BY p.id LIMIT 1) o ON true
    JOIN LATERAL (SELECT p.id FROM public.profiles p
                   WHERE COALESCE(p.active_client_id, p.client_id) = c.id AND p.role = 'client'
                     AND p.pos_email IS NOT NULL AND p.settlement_blocked_by IS NULL AND p.pos_blocked_at IS NULL
                   ORDER BY p.id LIMIT 1) s ON true
   WHERE c.pos_enabled
   ORDER BY (c.name = 'BLOOM CAFE') DESC, c.name
   LIMIT 1;
  SELECT p.id INTO v_admin FROM public.profiles p
   WHERE p.role = 'admin' AND p.pos_role IS NULL AND p.ims_role IS NULL AND p.hr_role IS NULL
     AND p.pos_email IS NULL AND NOT COALESCE(p.hr_self_service, false)
   ORDER BY p.id LIMIT 1;
  SELECT c.id INTO v_other FROM public.clients c WHERE c.id <> v_client ORDER BY c.id LIMIT 1;
  IF v_client IS NULL OR v_admin IS NULL THEN
    RAISE EXCEPTION 'S843 probe: needs a POS outlet with an Owner and a POS till login, and the operator (got %, %)', v_client, v_admin;
  END IF;
  IF EXISTS (SELECT 1 FROM public.pos_customers pc
              WHERE pc.client_id = v_client
                AND (pc.phone IN (c_p1, c_p2, c_p3, c_p4, c_p5) OR pc.phone_canonical IN (c_p1, c_p2, c_p3, c_p4, c_p5))) THEN
    RAISE EXCEPTION 'S843 probe: a probe phone number is already in the outlet''s customer book';
  END IF;

  BEGIN
    -- The till build gate (if a floor is set when this runs) reads this header.
    PERFORM set_config('request.headers', '{"x-crest-build":"crest-v999999"}', true);

    -- ── Setup, as the migration's own role ────────────────────────────────────────────────────
    -- The till login becomes a plain POS supervisor with no other staff marker (a restrictive policy
    -- would otherwise turn an "allowed" into a vacuous 0 rows).
    UPDATE public.profiles
       SET pos_role = 'supervisor', ims_role = NULL, hr_role = NULL, hr_self_service = false
     WHERE id = v_staff;
    INSERT INTO public.pos_customers (client_id, name, phone) VALUES (v_client, 'S843 probe one', c_p1) RETURNING id INTO v_c1;
    INSERT INTO public.pos_customers (client_id, name, phone) VALUES (v_client, 'S843 probe two', c_p2) RETURNING id INTO v_c2;
    IF v_other IS NOT NULL THEN
      INSERT INTO public.pos_membership_types (client_id, name, discount_pct)
        VALUES (v_other, 'S843 probe elsewhere', 5) RETURNING id INTO v_type_else;
    END IF;

    -- ── (1) The Owner adds two types; the server stamps who and when ───────────────────────────
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_owner)::text, true);
    SET LOCAL ROLE authenticated;
    INSERT INTO public.pos_membership_types (client_id, name, discount_pct, valid_months, created_at, created_by)
      VALUES (v_client, 'S843 probe Gold', 10, 12, '2000-01-01T00:00:00Z', v_staff) RETURNING id INTO v_type;
    INSERT INTO public.pos_membership_types (client_id, name, discount_pct)
      VALUES (v_client, 'S843 probe Silver', 5) RETURNING id INTO v_type_off;
    v_state := NULL;
    BEGIN
      INSERT INTO public.pos_membership_types (client_id, name, discount_pct) VALUES (v_client, '  s843 PROBE gold ', 7);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    END;
    RESET ROLE;
    IF v_state IS DISTINCT FROM '23505' THEN
      RAISE EXCEPTION 'S843 probe: a second type of the same name (other case, spaces) answered %', COALESCE(v_state, 'saved');
    END IF;
    IF (SELECT t.created_by FROM public.pos_membership_types t WHERE t.id = v_type) IS DISTINCT FROM v_owner
       OR (SELECT t.created_at FROM public.pos_membership_types t WHERE t.id = v_type) IS DISTINCT FROM now() THEN
      RAISE EXCEPTION 'S843 probe: a new type was not stamped with its maker and the server''s time';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.audit_logs l
                    WHERE l.table_name = 'pos_membership_types' AND l.record_id = v_type AND l.action = 'INSERT') THEN
      RAISE EXCEPTION 'S843 probe: adding a membership type wrote no audit row';
    END IF;

    -- ── (2) A POS supervisor: no type, no card, no credit limit ─────────────────────────────────
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_staff)::text, true);
    SET LOCAL ROLE authenticated;
    v_hint := NULL; v_msg := NULL;
    BEGIN
      INSERT INTO public.pos_membership_types (client_id, name, discount_pct) VALUES (v_client, 'S843 probe Bronze', 3);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
    END;
    IF v_hint IS DISTINCT FROM 'rank_required' OR v_msg NOT LIKE 'pos_membership_types:%' THEN
      RAISE EXCEPTION 'S843 probe: a supervisor adding a type answered % (%)', COALESCE(v_hint, 'saved'), v_msg;
    END IF;
    v_hint := NULL; v_msg := NULL;
    BEGIN
      UPDATE public.pos_customers SET membership_type_id = v_type WHERE id = v_c1;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
    END;
    IF v_hint IS DISTINCT FROM 'rank_required' OR v_msg NOT LIKE 'pos_customers:%' THEN
      RAISE EXCEPTION 'S843 probe: a supervisor giving a card answered % (%)', COALESCE(v_hint, 'saved'), v_msg;
    END IF;
    v_hint := NULL; v_msg := NULL;
    BEGIN
      UPDATE public.pos_customers SET credit_limit = 5000 WHERE id = v_c1;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
    END;
    IF v_hint IS DISTINCT FROM 'rank_required' THEN
      RAISE EXCEPTION 'S843 probe: a supervisor setting a credit limit answered % (%)', COALESCE(v_hint, 'saved'), v_msg;
    END IF;

    -- ── (3) The supervisor records a BS birthday (32 Ashadh) with the customer's agreement ──────
    -- The device's time and name for the agreement are not taken: the server stamps its own.
    UPDATE public.pos_customers
       SET birth_month = 3, birth_day = 32, birth_calendar = 'BS',
           consent_at = '2000-01-01T00:00:00Z', consent_by = v_owner
     WHERE id = v_c1;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'S843 probe: a supervisor could not record a birthday with consent (% rows)', v_n;
    END IF;

    -- ── (4) What the supervisor cannot do with the dates ───────────────────────────────────────
    -- A new time on a recorded consent is ignored, not taken.
    UPDATE public.pos_customers SET consent_at = '2001-01-01T00:00:00Z', consent_by = v_owner WHERE id = v_c1;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'S843 probe: re-sending a consent was refused or matched nothing (% rows)', v_n;
    END IF;
    -- A date with no agreement.
    v_hint := NULL; v_msg := NULL;
    BEGIN
      UPDATE public.pos_customers SET anniv_month = 1, anniv_day = 15, anniv_calendar = 'AD' WHERE id = v_c2;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
    END;
    IF v_hint IS DISTINCT FROM 'consent_required' THEN
      RAISE EXCEPTION 'S843 probe: an anniversary with no consent answered % (%)', COALESCE(v_hint, 'saved'), v_msg;
    END IF;
    -- Withdrawing the agreement while the birthday stays.
    v_hint := NULL; v_msg := NULL;
    BEGIN
      UPDATE public.pos_customers SET consent_at = NULL WHERE id = v_c1;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
    END;
    IF v_hint IS DISTINCT FROM 'consent_required' THEN
      RAISE EXCEPTION 'S843 probe: withdrawing consent with a birthday left answered % (%)', COALESCE(v_hint, 'saved'), v_msg;
    END IF;
    -- 31 April AD, and a year with no month: the CHECKs.
    v_state := NULL;
    BEGIN
      UPDATE public.pos_customers SET anniv_month = 4, anniv_day = 31, anniv_calendar = 'AD' WHERE id = v_c1;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    END;
    IF v_state IS DISTINCT FROM '23514' THEN
      RAISE EXCEPTION 'S843 probe: 31 April AD answered %', COALESCE(v_state, 'saved');
    END IF;
    v_state := NULL;
    BEGIN
      UPDATE public.pos_customers SET anniv_year = 2010 WHERE id = v_c1;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    END;
    IF v_state IS DISTINCT FROM '23514' THEN
      RAISE EXCEPTION 'S843 probe: a year with no month answered %', COALESCE(v_state, 'saved');
    END IF;
    RESET ROLE;
    SELECT pc.consent_at, pc.consent_by INTO v_at, v_by FROM public.pos_customers pc WHERE pc.id = v_c1;
    IF v_at IS DISTINCT FROM now() OR v_by IS DISTINCT FROM v_staff THEN
      RAISE EXCEPTION 'S843 probe: the consent reads % by %, not the server''s time and the supervisor', v_at, v_by;
    END IF;

    -- ── (5) A Staff-rank till login: no dates, but the till's upsert and a new customer pass ──────
    UPDATE public.profiles SET pos_role = 'staff' WHERE id = v_staff;
    SET LOCAL ROLE authenticated;
    v_hint := NULL; v_msg := NULL;
    BEGIN
      UPDATE public.pos_customers SET birth_year = 1990 WHERE id = v_c1;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
    END;
    IF v_hint IS DISTINCT FROM 'rank_required' OR v_msg NOT LIKE 'pos_customers:%' THEN
      RAISE EXCEPTION 'S843 probe: a Staff-rank login changing a birthday answered % (%)', COALESCE(v_hint, 'saved'), v_msg;
    END IF;
    INSERT INTO public.pos_customers (client_id, name, phone) VALUES (v_client, 'S843 probe one at the till', c_p1)
      ON CONFLICT ON CONSTRAINT pos_customers_client_id_phone_key DO UPDATE SET name = EXCLUDED.name;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'S843 probe: the till''s customer upsert matched % rows', v_n;
    END IF;
    INSERT INTO public.pos_customers (client_id, name, phone) VALUES (v_client, 'S843 probe five', c_p5);
    RESET ROLE;
    IF (SELECT pc.name FROM public.pos_customers pc WHERE pc.id = v_c1) IS DISTINCT FROM 'S843 probe one at the till'
       OR (SELECT pc.birth_day FROM public.pos_customers pc WHERE pc.id = v_c1) IS DISTINCT FROM 32::smallint
       OR (SELECT pc.consent_by FROM public.pos_customers pc WHERE pc.id = v_c1) IS DISTINCT FROM v_staff THEN
      RAISE EXCEPTION 'S843 probe: the till''s upsert did not save the name, or changed a date or the consent';
    END IF;
    UPDATE public.profiles SET pos_role = 'supervisor' WHERE id = v_staff;
    -- Nothing so far changed a scheme, a phone, a membership or a limit: no audit row, birthdays included.
    SELECT count(*) INTO v_n FROM public.audit_logs l WHERE l.table_name = 'pos_customers' AND l.record_id = v_c1;
    IF v_n <> 0 THEN
      RAISE EXCEPTION 'S843 probe: a birthday, a consent or the till''s upsert wrote % audit rows', v_n;
    END IF;

    -- ── (6) The Owner gives the card and a limit; the refusals around them ─────────────────────
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_owner)::text, true);
    SET LOCAL ROLE authenticated;
    UPDATE public.pos_customers
       SET membership_type_id = v_type, card_no = 'S843-G-001', card_issued_on = current_date,
           card_expires_on = current_date + 365, credit_limit = 5000
     WHERE id = v_c1;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'S843 probe: the Owner could not give a card (% rows)', v_n;
    END IF;
    -- The same card number on another customer, in other letters and spaces.
    v_state := NULL;
    BEGIN
      UPDATE public.pos_customers SET membership_type_id = v_type, card_no = ' s843-g-001 ' WHERE id = v_c2;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    END;
    IF v_state IS DISTINCT FROM '23505' THEN
      RAISE EXCEPTION 'S843 probe: a second customer with the same card number answered %', COALESCE(v_state, 'saved');
    END IF;
    -- A card number with no membership, an expiry before the issue, a negative limit.
    v_state := NULL;
    BEGIN
      UPDATE public.pos_customers SET card_no = 'S843-X-002' WHERE id = v_c2;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    END;
    IF v_state IS DISTINCT FROM '23514' THEN
      RAISE EXCEPTION 'S843 probe: a card number with no membership answered %', COALESCE(v_state, 'saved');
    END IF;
    v_state := NULL;
    BEGIN
      UPDATE public.pos_customers SET card_expires_on = current_date - 1 WHERE id = v_c1;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    END;
    IF v_state IS DISTINCT FROM '23514' THEN
      RAISE EXCEPTION 'S843 probe: a card expiring before it was given answered %', COALESCE(v_state, 'saved');
    END IF;
    v_state := NULL;
    BEGIN
      UPDATE public.pos_customers SET credit_limit = -1 WHERE id = v_c1;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    END;
    IF v_state IS DISTINCT FROM '23514' THEN
      RAISE EXCEPTION 'S843 probe: a negative credit limit answered %', COALESCE(v_state, 'saved');
    END IF;
    -- A switched-off type, and another outlet's.
    UPDATE public.pos_membership_types SET is_active = false WHERE id = v_type_off;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'S843 probe: the Owner could not switch a type off (% rows)', v_n;
    END IF;
    v_hint := NULL; v_msg := NULL;
    BEGIN
      UPDATE public.pos_customers SET membership_type_id = v_type_off WHERE id = v_c2;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
    END;
    IF v_hint IS DISTINCT FROM 'membership_type_invalid' THEN
      RAISE EXCEPTION 'S843 probe: giving a switched-off type answered % (%)', COALESCE(v_hint, 'saved'), v_msg;
    END IF;
    IF v_type_else IS NOT NULL THEN
      v_hint := NULL; v_msg := NULL;
      BEGIN
        UPDATE public.pos_customers SET membership_type_id = v_type_else WHERE id = v_c2;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
      END;
      IF v_hint IS DISTINCT FROM 'membership_type_invalid' THEN
        RAISE EXCEPTION 'S843 probe: giving another outlet''s type answered % (%)', COALESCE(v_hint, 'saved'), v_msg;
      END IF;
    END IF;
    -- A type a customer holds is not deleted, nor moved to another outlet; one nobody holds is deleted.
    v_hint := NULL; v_msg := NULL;
    BEGIN
      DELETE FROM public.pos_membership_types WHERE id = v_type;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
    END;
    IF v_hint IS DISTINCT FROM 'membership_type_in_use' THEN
      RAISE EXCEPTION 'S843 probe: deleting a type a customer holds answered % (%)', COALESCE(v_hint, 'deleted'), v_msg;
    END IF;
    IF v_other IS NOT NULL THEN
      v_hint := NULL; v_msg := NULL;
      BEGIN
        UPDATE public.pos_membership_types SET client_id = v_other WHERE id = v_type;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
      END;
      IF v_hint IS DISTINCT FROM 'membership_type_outlet_locked' THEN
        RAISE EXCEPTION 'S843 probe: moving a type to another outlet answered % (%)', COALESCE(v_hint, 'saved'), v_msg;
      END IF;
    END IF;
    DELETE FROM public.pos_membership_types WHERE id = v_type_off;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'S843 probe: the Owner could not delete a type nobody holds (% rows)', v_n;
    END IF;
    -- The Owner's new customer with an anniversary (29 February AD): consent stamped now, by the Owner.
    INSERT INTO public.pos_customers (client_id, name, phone, anniv_month, anniv_day, anniv_calendar, consent_at)
      VALUES (v_client, 'S843 probe four', c_p4, 2, 29, 'AD', '2000-01-01T00:00:00Z') RETURNING id INTO v_c4;
    RESET ROLE;
    SELECT count(*) INTO v_n FROM public.audit_logs l WHERE l.table_name = 'pos_customers' AND l.record_id = v_c1;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'S843 probe: giving a card and a limit wrote % audit rows, not 1', v_n;
    END IF;
    SELECT pc.consent_at, pc.consent_by INTO v_at, v_by FROM public.pos_customers pc WHERE pc.id = v_c4;
    IF v_at IS DISTINCT FROM now() OR v_by IS DISTINCT FROM v_owner THEN
      RAISE EXCEPTION 'S843 probe: a new customer''s consent reads % by %, not the server''s time and the Owner', v_at, v_by;
    END IF;
    IF EXISTS (SELECT 1 FROM public.audit_logs l WHERE l.table_name = 'pos_customers' AND l.record_id = v_c4) THEN
      RAISE EXCEPTION 'S843 probe: a new customer with only an anniversary was copied into the audit log';
    END IF;

    -- ── (7) The supervisor withdraws the agreement: both dates and the consent go together ───────
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_staff)::text, true);
    SET LOCAL ROLE authenticated;
    UPDATE public.pos_customers
       SET consent_at = NULL, birth_month = NULL, birth_day = NULL, birth_year = NULL, birth_calendar = NULL
     WHERE id = v_c1;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RESET ROLE;
    IF v_n <> 1
       OR (SELECT pc.consent_at FROM public.pos_customers pc WHERE pc.id = v_c1) IS NOT NULL
       OR (SELECT pc.consent_by FROM public.pos_customers pc WHERE pc.id = v_c1) IS NOT NULL
       OR (SELECT pc.membership_type_id FROM public.pos_customers pc WHERE pc.id = v_c1) IS DISTINCT FROM v_type THEN
      RAISE EXCEPTION 'S843 probe: withdrawing consent left it recorded, or touched the card (% rows)', v_n;
    END IF;

    -- ── (8) The operator's restore: a switched-off type and a customer holding it, as they were ──
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_admin)::text, true);
    SET LOCAL ROLE authenticated;
    INSERT INTO public.pos_membership_types (client_id, name, discount_pct, is_active, created_at)
      VALUES (v_client, 'S843 probe restored', 15, false, '2025-01-01T00:00:00Z') RETURNING id INTO v_type_old;
    INSERT INTO public.pos_customers (client_id, name, phone, birth_month, birth_day, birth_calendar, consent_at,
                                      membership_type_id, card_no, card_issued_on, card_expires_on)
      VALUES (v_client, 'S843 probe three', c_p3, 1, 1, 'BS', '2025-01-01T00:00:00Z',
              v_type_old, 'S843-R-003', '2025-01-01', '2026-01-01') RETURNING id INTO v_c3;
    RESET ROLE;
    IF (SELECT t.created_at FROM public.pos_membership_types t WHERE t.id = v_type_old) IS DISTINCT FROM '2025-01-01T00:00:00Z'::timestamptz
       OR (SELECT pc.consent_at FROM public.pos_customers pc WHERE pc.id = v_c3) IS DISTINCT FROM '2025-01-01T00:00:00Z'::timestamptz THEN
      RAISE EXCEPTION 'S843 probe: the operator''s restore did not keep a type''s date or a customer''s consent as they were';
    END IF;

    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('request.headers', '', true);
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 's843_probe_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 's843_probe_rollback' THEN RAISE; END IF;
  END;
END;
$$;


NOTIFY pgrst, 'reload schema';


-- ── 6. What this file changed, live (the last statement, so `db query` prints it) ─────────────
SELECT
  to_regclass('public.pos_membership_types') IS NOT NULL AS membership_types_table,
  (SELECT count(*) FROM pg_policy p WHERE p.polrelid = 'public.pos_membership_types'::regclass AND p.polpermissive) AS types_permissive_policies,
  (SELECT count(*) FROM pg_policy p WHERE p.polrelid = 'public.pos_membership_types'::regclass AND NOT p.polpermissive) AS types_restrictive_policies,
  has_table_privilege('anon', 'public.pos_membership_types', 'SELECT') AS anon_can_read_types,
  has_table_privilege('authenticated', 'public.pos_membership_types', 'TRUNCATE') AS logins_can_truncate_types,
  (SELECT count(*) FROM pg_attribute a
    WHERE a.attrelid = 'public.pos_customers'::regclass AND NOT a.attisdropped
      AND a.attname IN ('birth_month', 'birth_day', 'birth_year', 'birth_calendar', 'anniv_month', 'anniv_day',
                        'anniv_year', 'anniv_calendar', 'consent_at', 'consent_by', 'membership_type_id', 'card_no',
                        'card_issued_on', 'card_expires_on', 'credit_limit')) AS customer_columns_added,
  (SELECT confdeltype::text FROM pg_constraint
    WHERE conrelid = 'public.pos_customers'::regclass AND contype = 'f'
      AND confrelid = 'public.pos_membership_types'::regclass) AS membership_fk_on_delete,
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.pos_customers_guard_loyalty()'::regprocedure) AS customers_guard_md5,
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.guard_pos_membership_types()'::regprocedure) AS types_guard_md5,
  (SELECT count(*) FROM pg_trigger t
    WHERE t.tgrelid = 'public.pos_customers'::regclass AND t.tgname LIKE 'audit_pos_customers_enrolment_%'
      AND position('membership_type_id' IN pg_get_triggerdef(t.oid)) > 0) AS audit_triggers_with_membership,
  (SELECT count(*) FROM public.pos_customers) AS customers;

-- Read back after applying (one statement per call):
--   SELECT tgname, pg_get_triggerdef(oid) FROM pg_trigger
--    WHERE tgrelid = 'public.pos_customers'::regclass AND NOT tgisinternal ORDER BY tgname;
--     expect the guard, the enrolment stamp and the three audit triggers, the audit WHENs naming
--     membership_type_id and credit_limit and no birth_/anniv_/consent column.
