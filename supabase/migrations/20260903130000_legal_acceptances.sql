-- Legal acceptance ledger: the record that a tenant agreed to a specific version of the Terms of
-- Service and Privacy Policy, on a specific date, from a specific address.
--
-- Why this table has to exist at all. `Login.js` has told every trial signup "By starting a trial
-- you agree to our Terms of Service and Privacy Policy" since the trial form was written. Those
-- documents did not exist, the words were not links, and NOTHING recorded that anyone agreed to
-- anything -- no version, no timestamp, no address, no user agent. The one sentence in the product
-- claiming a contract exists was the only evidence that one might. Under the Electronic
-- Transactions Act 2063 an e-contract needs clearly expressed offer and acceptance; a passive line
-- with no record is the weakest possible form of both.
--
-- Why it is append-only and NOT written by the browser. The spec this was built from proposed an
-- INSERT policy for `authenticated` where user_id = auth.uid(), with the row carrying its own
-- ip_address and user_agent. That is self-attested evidence twice over: a browser cannot know its
-- own public IP, and per this project's own invariant (S531 #3, S576/S579), attribution the
-- subject of the attribution can choose is not attribution. So there is deliberately NO insert,
-- update or delete policy here for `authenticated` at all. Every write goes through the service
-- role inside `admin-user-ops`, which reads the address and user agent off the request itself. A
-- client can read its own ledger and can do nothing else to it.
--
-- Why client_id is ON DELETE SET NULL with a denormalised client_name. The Privacy Policy commits
-- to keeping acceptance records for 7 years after an account ends -- they are the evidence of the
-- contract, and their whole value is surviving the relationship. A plain FK would either block the
-- client delete or take the ledger with it. `audit_logs` already has exactly this shape and for
-- exactly this reason.
--
-- THREE REGISTRATIONS ARE DELIBERATELY SKIPPED, and the next person will read each as an
-- oversight. They are not. A new business table normally joins all of these:
--
--   deleteClientData (admin-user-ops Danger Zone) -- SKIPPED. Clearing a client's data must not
--     clear the record that it accepted the terms. That record is retained for 7 years after the
--     account ends and its whole value is outliving the relationship.
--   CLIENT_SCOPED_TABLES (src/shared/scopedDb.js) -- SKIPPED. Nothing in the browser writes this
--     table; every write is service-role, inside admin-user-ops. Adding it would advertise a
--     scopedInsert/scopedUpdate path that the grants below deliberately refuse. It also drives the
--     Export workbook, and this is Crest's evidence of a contract, not client data to migrate.
--   RESTORE_ORDER (modules/admin/dataExport/restoreClientData.js) -- SKIPPED, and it could not work
--     anyway: restore runs `supabase.from(table).insert(...)` from the browser, which has no INSERT
--     grant here. An acceptance that could be re-inserted from a spreadsheet would not be evidence.
--
-- The document text itself is NOT stored here. It lives in src/legal/*.md in git, with its version,
-- effective date and SHA-256 exported from src/legal/index.js alongside it, so the re-acceptance
-- gate and the text it gates on always ship in the same bundle and can never disagree. A DB-side
-- "current version" read against a service-worker-cached bundle could ask someone to accept v1.1
-- while showing them v1.0. The hash is computed by scripts/hash-legal.mjs and asserted by a jest
-- test -- NOT by a pgcrypto trigger, because pgcrypto lives in the `extensions` schema here and
-- every SECURITY DEFINER body sets search_path TO 'public', so an unqualified digest() fails at
-- runtime (see 20260812110000_pin_vault.sql lines 51-56).

CREATE TABLE IF NOT EXISTS public.legal_acceptances (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- SET NULL + denormalised name: the ledger outlives the client row. See header.
  client_id       uuid REFERENCES public.clients(id) ON DELETE SET NULL,
  client_name     text,
  user_id         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  user_email      text,

  doc_type        text NOT NULL CHECK (doc_type IN ('terms','privacy','subscription_agreement')),
  doc_version     text NOT NULL,
  content_sha256  text NOT NULL,

  method          text NOT NULL CHECK (method IN ('clickwrap_trial','clickwrap_reaccept','signed_paper')),
  accepted_at     timestamptz NOT NULL DEFAULT now(),

  -- text, not inet: register_trial already falls back to the literal string 'unknown' when
  -- x-forwarded-for is absent (index.ts:75), and an inet column cannot hold that. Recording
  -- "we did not learn the address" is more honest than a NULL that reads as "not captured yet".
  ip_address      text,
  user_agent      text,

  -- signed_paper only.
  signatory_name  text,
  signatory_title text,
  signed_on_date  date,
  stamped         boolean,
  recorded_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  created_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.legal_acceptances IS
  'Append-only record of a tenant accepting a version of the Terms of Service, Privacy Policy or Subscription Agreement. Written only by the service role. Retained 7 years after the client ends, per the Privacy Policy, which is why client_id is ON DELETE SET NULL and client_name is denormalised.';

COMMENT ON COLUMN public.legal_acceptances.content_sha256 IS
  'SHA-256 of the exact document text accepted, copied from src/legal/index.js at acceptance time. This is what makes the acceptance verifiable against the published text.';

COMMENT ON COLUMN public.legal_acceptances.ip_address IS
  'First hop of x-forwarded-for, read server-side. May be the literal string unknown. Never supplied by the browser.';

-- The two reads this table serves: "what has this client accepted" (the re-acceptance gate, and the
-- client's own Legal tab) and "show me the history newest first" (the admin drawer).
CREATE INDEX IF NOT EXISTS legal_acceptances_client_doc_idx
  ON public.legal_acceptances (client_id, doc_type, accepted_at DESC);

ALTER TABLE public.legal_acceptances ENABLE ROW LEVEL SECURITY;

-- One permissive policy, SELECT only. There is no insert/update/delete policy on purpose -- see
-- header. COALESCE around is_admin() because it returns NULL, not false, for an authenticated
-- session with no profiles row (S630). USING treats NULL as false, so this particular policy is
-- safe either way -- but the wrapped form is the house rule, and the next policy someone writes by
-- copying this one may well be a guard where NULL falls open.
DROP POLICY IF EXISTS legal_acceptances_select ON public.legal_acceptances;
CREATE POLICY legal_acceptances_select ON public.legal_acceptances
  FOR SELECT TO authenticated
  USING (
    COALESCE((SELECT public.is_admin()), false)
    OR client_id = (SELECT public.my_client_id())
  );

-- RESTRICTIVE staff-isolation, all four families. The ledger names the Owner who signed, their
-- email and the address they signed from; no staff account type has any business reading it. Same
-- posture as monthly_owner_reports (20260721010000), which is the closest existing analogue.
-- A new business table inherits none of these -- they are created inside DO/FOREACH blocks in
-- 20260708130000 / 20260719120000 / 20260720170000, so a grep for CREATE POLICY does not find them
-- and it is easy to believe a table is covered when it is not.
DROP POLICY IF EXISTS no_self_service_accounts ON public.legal_acceptances;
CREATE POLICY no_self_service_accounts ON public.legal_acceptances AS RESTRICTIVE FOR ALL
  USING (NOT public.is_hr_self_service()) WITH CHECK (NOT public.is_hr_self_service());

DROP POLICY IF EXISTS no_pos_pin_staff ON public.legal_acceptances;
CREATE POLICY no_pos_pin_staff ON public.legal_acceptances AS RESTRICTIVE FOR ALL
  USING (NOT public.is_pos_pin_staff()) WITH CHECK (NOT public.is_pos_pin_staff());

DROP POLICY IF EXISTS no_ims_staff ON public.legal_acceptances;
CREATE POLICY no_ims_staff ON public.legal_acceptances AS RESTRICTIVE FOR ALL
  USING (NOT public.is_ims_staff()) WITH CHECK (NOT public.is_ims_staff());

DROP POLICY IF EXISTS no_hr_role_staff ON public.legal_acceptances;
CREATE POLICY no_hr_role_staff ON public.legal_acceptances AS RESTRICTIVE FOR ALL
  USING (NOT public.is_hr_role_staff()) WITH CHECK (NOT public.is_hr_role_staff());

-- Raw-SQL tables get NO role grants in this project -- a missing GRANT is a 401 that looks like an
-- RLS failure. SELECT only for authenticated: the policy above already narrows it, and withholding
-- the INSERT/UPDATE/DELETE grant means even a permissive policy added here by mistake later cannot
-- open a write path from the browser.
GRANT SELECT ON public.legal_acceptances TO authenticated;
GRANT ALL    ON public.legal_acceptances TO service_role;

-- No audit trigger. log_audit() stores full row snapshots, so an acceptance would be duplicated
-- into audit_logs complete with the signer's email and IP -- and audit_logs is purgeable by
-- admin_clear_audit_logs, which is the opposite of what a legal ledger is for. This table is its
-- own record. Same reasoning that keeps client_secrets unaudited (S531 invariant #4).

notify pgrst, 'reload schema';

-- Verification -------------------------------------------------------------------------------
-- Expect: t
-- SELECT relrowsecurity FROM pg_class WHERE oid = 'public.legal_acceptances'::regclass;
--
-- Expect exactly 5 rows: legal_acceptances_select (permissive) + the 4 restrictive families.
-- SELECT policyname, permissive, cmd FROM pg_policies
--  WHERE schemaname = 'public' AND tablename = 'legal_acceptances' ORDER BY policyname;
--
-- Expect: t, f, f, f  -- authenticated may read and may NOT write.
-- SELECT has_table_privilege('authenticated','public.legal_acceptances','SELECT'),
--        has_table_privilege('authenticated','public.legal_acceptances','INSERT'),
--        has_table_privilege('authenticated','public.legal_acceptances','UPDATE'),
--        has_table_privilege('authenticated','public.legal_acceptances','DELETE');
--
-- Expect: client_id -- assert on the catalog, not the index name. CREATE INDEX IF NOT EXISTS
-- reports success whether or not it did anything, and a name proves nothing about leading column.
-- SELECT a.attname FROM pg_index i
--   JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
--  WHERE i.indrelid = 'public.legal_acceptances'::regclass;
