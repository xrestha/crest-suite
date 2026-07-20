-- Follow-up to 20260720150000. While verifying that migration, found the same "Postgres grants
-- ALL on CREATE TABLE, nobody ever trimmed it back" pattern at the table level, not just on
-- functions -- and wider than the single stray TRUNCATE grant flagged there:
--
--   * anon and authenticated both hold TRUNCATE, REFERENCES, TRIGGER on every public table.
--     Inert for anon/authenticated regardless of role -- PostgREST's REST/RPC surface has no path
--     to issue any of the three, and REFERENCES/TRIGGER additionally require CREATE privilege on
--     the table neither role has. TRUNCATE is the one worth removing anyway: it bypasses RLS
--     entirely (RLS only governs SELECT/INSERT/UPDATE/DELETE), so it's a latent irreversible-
--     data-loss surface if any future code path ever executes raw SQL as one of these roles.
--
--   * anon separately holds full SELECT/INSERT/UPDATE/DELETE (not just the inert three above) on
--     22 real tables: categories, clients, closing_stock, feature_flags,
--     hr_festival_allowances, hr_holiday_calendar, hr_overtime_entries, inventory_summary, items,
--     monthly_periods, opening_stock, overheads, par_levels, profiles, purchase_entries,
--     recipe_ingredients, recipes, sales_entries, settings, vendor_returns, vendors, wastages.
--     Verified every INSERT/UPDATE/DELETE policy on all 22 requires `is_admin() OR client_id =
--     my_client_id()` (or the equivalent through a parent table), which is false for anon -- so
--     today none of this is actually writable. But that safety is circumstantial, not structural:
--     it depends entirely on is_admin()/my_client_id() staying callable by anon, which is only
--     true because 20260720150000 deliberately left them alone (they gate a real anon-reachable
--     read on `settings`). If those 4 helpers are ever revisited without remembering this chain,
--     22 tables' worth of RLS silently stops being enforceable for anon and starts erroring
--     instead -- fail-closed, not a leak, but still worth not depending on. Removing anon's base
--     grant makes the real boundary "anon cannot touch this table at all", not "anon can touch it
--     but a policy currently says no".
--
-- settings is the one exception: anon keeps SELECT. settings_select's `client_id IS NULL OR ...`
-- branch is a genuine, intentional public read (pre-login app_name/app_tagline), confirmed by
-- direct test in 20260720150000. INSERT/UPDATE/DELETE on settings are still stripped from anon --
-- write policies already block them, and there's no legitimate reason for anon to hold the base
-- grant either.

REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM anon, authenticated;

REVOKE INSERT, UPDATE, DELETE, SELECT ON
  categories, clients, closing_stock, feature_flags, hr_festival_allowances, hr_holiday_calendar,
  hr_overtime_entries, inventory_summary, items, monthly_periods, opening_stock, overheads,
  par_levels, profiles, purchase_entries, recipe_ingredients, recipes, sales_entries,
  vendor_returns, vendors, wastages
FROM anon;

REVOKE INSERT, UPDATE, DELETE ON settings FROM anon;
-- settings' SELECT grant to anon is intentionally kept -- do not add it to the block above.

NOTIFY pgrst, 'reload schema';
