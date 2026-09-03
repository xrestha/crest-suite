-- The counterparty's legal identity, so a Subscription Agreement can name who is actually signing.
--
-- Why these columns did not already exist. `clients` has carried `name`, `location`,
-- `contact_person` and `contact_phone` since the baseline, and every one of them is an OPERATIONAL
-- label: `name` is the trading name that appears in the sidebar, `location` is a free-text
-- neighbourhood. None of them identifies a legal person. There is no PAN field for a client
-- anywhere in this schema -- `hr_employees.pan_no` and `vendors.pan_vat_no` are the client's
-- employees and the client's suppliers, not the client itself. So the printable agreement had
-- nothing to fill its Parties block from.
--
-- Why not reuse settings.property_address / settings.vat_number. Those are real and close, but they
-- are the wrong record for this. They are print-header fields the CLIENT edits itself, described in
-- Settings as "These appear on printed reports and the Monthly Summary header" -- the address the
-- restaurant puts on its own guest bills, and the VAT number it quotes to the IRD. A contract's
-- counterparty details are recorded by the operator drawing up the contract, are not the client's
-- to revise unilaterally, and must persist even for a client that has never opened Settings (or
-- that cannot: /settings is behind ModuleGate module="ims", so a POS-only client never sees it).
-- `settings.client_id` is also nullable, which is not a shape a contract party should hang off.
--
-- The two are still related in practice and the admin form prefills `pan_no` from
-- `settings.vat_number` where one exists, so nobody types the same number twice -- but the value
-- that goes on the agreement is the one stored here.
--
-- None of these columns changes what a client pays, so the "anything added to clients that changes
-- what a client pays needs a place in the admin list" rule does not bite. They do get an admin
-- surface in the same change (ClientDrawer's Legal tab); a legal-entity field with nowhere to enter
-- it is a column that stays NULL forever.

ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS legal_name         text;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS pan_no             text;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS registered_address text;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS signatory_name     text;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS signatory_title    text;

COMMENT ON COLUMN public.clients.legal_name IS
  'Registered legal name of the contracting business. Distinct from clients.name, which is the trading name shown in the app. NULL until an operator records it.';
COMMENT ON COLUMN public.clients.pan_no IS
  'The client business PAN / VAT number, as the counterparty on a Subscription Agreement. Prefilled in the admin form from settings.vat_number where one exists, but stored independently -- settings is client-editable print-header data.';
COMMENT ON COLUMN public.clients.registered_address IS
  'Registered office address of the contracting business, for the agreement Parties block. Distinct from settings.property_address, which is the outlet address printed on the client own reports.';
COMMENT ON COLUMN public.clients.signatory_name IS
  'Name of the person authorised to bind the customer business, as printed on the agreement signature block.';
COMMENT ON COLUMN public.clients.signatory_title IS
  'Title of that signatory (Proprietor, Managing Director, Partner...).';

-- Where this client stands on paper. Deliberately a single status rather than a pair of booleans:
-- the four states are ordered and mutually exclusive, and two booleans allow (signed = true,
-- pending = true) which means nothing.
--
--   none           no acceptance of any kind on record -- an account created before the clickwrap
--                  shipped, or one an admin created directly rather than through register_trial.
--   trial_accepted the trial signup clickwrap was accepted. This is the ONLY state the app itself
--                  ever writes without an operator.
--   paper_pending  an agreement has been generated and sent, and is waiting on a signed return.
--   paper_signed   a signed and stamped original (or scan) is back and recorded.
--
-- `none` is the default on purpose, and every existing client lands there -- which is accurate.
-- Backfilling them to trial_accepted would be inventing a consent event that never happened, which
-- is the one thing this whole change exists to stop.
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS agreement_status text NOT NULL DEFAULT 'none';
ALTER TABLE public.clients DROP CONSTRAINT IF EXISTS clients_agreement_status_check;
ALTER TABLE public.clients ADD CONSTRAINT clients_agreement_status_check
  CHECK (agreement_status IN ('none','trial_accepted','paper_pending','paper_signed'));

ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS agreement_signed_at timestamptz;

COMMENT ON COLUMN public.clients.agreement_status IS
  'none | trial_accepted | paper_pending | paper_signed. Summary of clients standing on paper; the per-document detail is in legal_acceptances, which is the record of authority.';
COMMENT ON COLUMN public.clients.agreement_signed_at IS
  'When the signed paper agreement was recorded. NULL unless agreement_status = paper_signed.';

-- No grant or policy change: grants are table-level and the existing clients policies already cover
-- these columns. Note clients carries a log_audit() trigger (20260804040000), so every change to
-- these fields is already captured with old/new snapshots and attribution -- which is exactly the
-- secondary evidence trail a contract record wants, on top of legal_acceptances itself.

notify pgrst, 'reload schema';

-- Verification -------------------------------------------------------------------------------
-- Expect 7 rows.
-- SELECT column_name, data_type, is_nullable, column_default
--   FROM information_schema.columns
--  WHERE table_schema = 'public' AND table_name = 'clients'
--    AND column_name IN ('legal_name','pan_no','registered_address','signatory_name',
--                        'signatory_title','agreement_status','agreement_signed_at')
--  ORDER BY column_name;
--
-- Expect every existing client at 'none' and nothing else.
-- SELECT agreement_status, count(*) FROM public.clients GROUP BY 1;
--
-- Expect the CHECK to be present and to refuse an unknown value (should RAISE):
-- UPDATE public.clients SET agreement_status = 'nonsense' WHERE false;
