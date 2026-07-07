-- Fixes a real, pre-existing bug found while testing the new Delivery Partners tab
-- (Table Management → Delivery Partners, S290): settings_insert/settings_update were admin-only,
-- with no allowance for a regular (non-admin) client login to write their OWN settings row —
-- unlike every other client-scoped table in this app, which follows
-- "is_admin() OR client_id = my_client_id()".
--
-- Because Postgres/PostgREST doesn't surface an RLS-blocked write as an error (it just matches
-- zero rows, same as a WHERE clause matching nothing), every settings-writing tab in
-- PosTableManagement.jsx (Discounts, Quick Notes, Ticket Routing, and now Delivery Partners) has
-- been silently no-op'ing for any real (non-admin) client login — the UI reports "saved"
-- successfully while nothing actually persists. Only a Crest admin "view as" session could ever
-- have actually written to this table. Confirmed directly: Casa Acai Cafe's settings row had
-- pos_foodmandu_commission_pct/pos_pathao_commission_pct still null after a client login saved
-- them and got a green "saved" confirmation.
--
-- Doesn't touch the global-defaults row (client_id IS NULL, app_name/app_tagline etc.) — a real
-- client's own client_id can never equal NULL, so that row stays admin-only automatically.
DROP POLICY settings_insert ON public.settings;
CREATE POLICY settings_insert ON public.settings FOR INSERT
  WITH CHECK (public.is_admin() OR client_id = public.my_client_id());

DROP POLICY settings_update ON public.settings;
CREATE POLICY settings_update ON public.settings FOR UPDATE
  USING (public.is_admin() OR client_id = public.my_client_id());

NOTIFY pgrst, 'reload schema';
