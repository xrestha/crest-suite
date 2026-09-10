---
paths:
  - "supabase/**"
  - "src/pages/AuditLog.js"
---

# SQL authoring: RLS policies, indexes, grants, migrations, audit triggers

> Moved out of the root CLAUDE.md (2026-08-18 /doctor pass) so it loads only when working on these files. Root CLAUDE.md keeps the universal invariants.

- RLS is enabled on every table. The standard policy pattern uses an inline subquery:

  ```sql
  (SELECT role FROM profiles WHERE id = (select auth.uid())) = 'admin'
  OR client_id = (SELECT client_id FROM profiles WHERE id = (select auth.uid()))
  ```

  **Wrap `auth.uid()` as `(select auth.uid())` in every new policy** (S542) — a bare call is re-evaluated once per candidate row; the scalar-subquery form becomes an InitPlan the planner evaluates once per query. This is Supabase's `auth_rls_initplan` lint, and it had accumulated on 41 policies before `20260812130000` swept them. Use `ALTER POLICY` for this kind of expression-only fix rather than DROP + CREATE: it leaves the command and role list untouched, so no table sits with a policy missing and there's no chance of fumbling a `FOR`/`TO` clause. An omitted clause is left as-is, which is also what stops a `FOR SELECT` policy being handed an illegal `WITH CHECK`.

- **One permissive policy per (table, command) — reach for a single `<x>_all`, not a per-command set** (S542). Postgres ORs together every permissive policy matching a (role, command) pair and must execute all of them for every row. Three generations of the same rule had stacked up on 15 tables: `admin_all_<x>` (`TO authenticated`, `is_admin()`), a broad `<x>_all`, and per-command `<x>_select/insert/update/delete` repeating `<x>_all` four ways — with `admin_all_<x>` a strict subset of both others, so pure overhead. `20260812120000` collapsed all of them to the surviving `<x>_all`. Two traps this surfaced, both worth checking on any new policy: **a `CREATE POLICY` with no `FOR` clause is `FOR ALL`**, not the command its name implies (`hr_employees_update` was silently `FOR ALL` and overlapped its three siblings), and **a `FOR ALL` policy with no `WITH CHECK` uses its `USING` expression as the check** — which is why `client_purchase_orders` and `client_access_purchase_orders` were functionally identical rather than complementary. RESTRICTIVE policies are unaffected by any of this: they AND with whatever permissive policies remain, so removing redundant permissive ones can never widen access.

- **Scope a client-scoped policy with `my_client_id()`. Never spell its body out** (S710). Thirty-eight live policies carried `client_id = (SELECT profiles.client_id FROM profiles WHERE id = auth.uid())` — which is what `my_client_id()` USED to be, before S548 redefined it as `coalesce(active_client_id, client_id)`. The whole multi-outlet design is "change one function and every policy follows"; an inlined copy silently opts out of it, and nine of the twenty-five were written *after* S548 by copying the table next door. It cannot be caught by testing today (with `active_client_id` NULL the two are byte-identical) and it fails quietly (a switched outlet reads `{ data: [], error: null }`). Fixed in `20260909160000` + `20260909180000`; `SELECT tablename, policyname FROM pg_policies WHERE schemaname='public' AND (qual LIKE '%profiles.client_id%' OR with_check LIKE '%profiles.client_id%')` must stay empty. **Run that against `pg_policies`, never against the migration files** — thirteen of the thirty-eight are written unqualified (`SELECT client_id FROM profiles WHERE id = ...`) and Postgres re-prints them qualified, so the repo's spelling and the catalog's spelling differ and a grep over the files misses them. That is exactly how the first migration shipped 13 short. Same reasoning for `is_admin()` — call it, don't re-derive `role = 'admin'` inline.

- **`is_admin()` / `my_client_id()` / `is_hr_self_service()` are called per row, and no linter will tell you.** All three are `LANGUAGE sql STABLE SECURITY DEFINER`, and Postgres refuses to inline a SECURITY DEFINER SQL function (`inline_function()` bails on `prosecdef`), so each is a real function call per row rather than a subquery the planner can hoist. The `auth_rls_initplan` lint only pattern-matches `auth.<fn>()` and `current_setting()`, so it is silent on all three — they appear in roughly **120 policies** and are the larger per-row cost. Wrapping them as `(select public.is_admin())` hoists them the same way; **this has not been done project-wide** (S542 scoped it out pending a live `EXPLAIN`), only in the two policies that migration recreated from scratch, `hr_employees_update` and `vendor_returns_all`. Write new policies with the wrapped form.

- **Index a foreign key because something queries it, not because a linter listed it** (S543). The advisor's `unindexed_foreign_keys` lint reports every FK without a covering index — 79 of them here — but an index is written on every INSERT/UPDATE, and `pos_order_items`/`stock_movements` take a write per line per bill. `20260727140000` swept `client_id`/`period_id`/`item_id`/`recipe_id` (46 indexes) and **three of the indexes it created now show up under the `unused_index` lint**, so the cost is not hypothetical. `20260812140000` indexed 36 of the 79, chosen by grepping `src/` for `.eq('<col>'`/`.in('<col>'` plus PostgREST embedded-select syntax. Two things that grep settled which inspection would have got wrong: **no `*_by` column is ever filtered on** (a grep for `.eq('<anything>_by'` returns zero hits — they are display lookups resolved via `get_client_profile_names()`, so the ~20 audit-trail FKs are deliberately unindexed), and **`hr_advance_repayments` is read whole-table and grouped in JS**, so its `advance_id` needs nothing while `payroll_run_id` — filtered by a `scopedDelete` in `PayrollRun.jsx` — does. The standing trap the same pass found: `pos_order_items` had `client_id` indexed but not `order_id`, which is the column 32 call sites actually filter on. **When adding an index, check which column the code filters by, not which column names the parent.**

- **"Unused index" is not "useless index."** It means the planner has not chosen it since the last stats reset. Of the 9 flagged at S543, four are new features with no data yet and three are tables too small for an index scan to win — including `idx_trial_signup_attempts_ip`, which guards `register_trial`'s per-IP rate limit and becomes load-bearing exactly when that table stops being small. None were dropped. The only genuinely dead one is `idx_pos_customers_phone_canonical` (no reader in `src/` or `supabase/functions/`; `phone_canonical` appears only in a comment in `src/utils/phone.js`), left pending a decision on whether that digital-receipt lookup is happening.

  **Fixing `unindexed_foreign_keys` trades it one-for-one against `unused_index`, so the Info total does not move.** A brand-new index has `idx_scan = 0` by definition, so the advisor reclassifies it the moment it is created rather than dropping it from the list: S543 took 79 unindexed FKs + 9 unused indexes to 43 + 45 — still exactly 88. **Do not "clean up" the unused list by dropping those 36.** They are the S543 indexes waiting on traffic; several (the `assets_*` ones, `monthly_owner_reports.period_id`) may sit there indefinitely because their features are low-volume by nature, and that is correct. Before dropping any index because the advisor calls it unused, find the query it was built for — `git log -S <index_name> -- supabase/migrations` will name the migration and its reasoning. **The Info count is not a number to drive to zero**; unlike Errors and Warnings, some of these lints are in direct tension with each other.

- **Verify an index by its leading column, not its name.** `CREATE INDEX IF NOT EXISTS` reports success whether or not it did anything, and an index existing under the expected name proves nothing about whether the planner can use it for a given predicate. Check `pg_index.indkey[0]` instead — join `pg_class`/`pg_attribute` and assert the column is the *first* column of some index on that table. Same discipline as the anon-revoke lesson above: never stop at "Success. No rows returned."

  **Generalises to every catalog assertion: assert on a catalog column, never on a formatted string whose shape you assumed (S630).** A migration asserting an overload had been dropped compared `pg_get_function_identity_arguments(p.oid)` against `'uuid, jsonb, text'` — but that function renders parameter **names** too, so the real value is `p_table_id uuid, p_items jsonb, p_notes text` and neither comparison could ever match. (The Advisor's own JSON export shows the true format, which is where to check.) The failure mode is the dangerous asymmetry, not the typo: the paired checks silently disagreed — "is the old one gone?" passed *vacuously* because it found nothing, while "is the new one still there?" raised. A vacuous pass and a false alarm from one bad string. Use `pg_proc.pronargs`/`proargtypes`, `pg_index.indkey`, `has_function_privilege(...)` — values Postgres computes, not text it formats for humans.

- **Reconstructing live RLS state by replaying `supabase/migrations/` works, but a regex for literal `CREATE POLICY` will miss the restrictive ones.** With no DB password on this machine, replaying the migrations in filename order (tracking CREATE/DROP per `table||name`) reproduced both advisor lint lists exactly, which is what made it safe to write RLS changes against. But the S316/S419/S430 staff-isolation policies are created via `EXECUTE format(...)` inside `DO` blocks, so a text scan reports them as absent — a first pass at S542 wrongly concluded only 4 tables carried them. Same shape as the S521 grep lesson: verify against the mechanism, not a substring match.

- **Public, unauthenticated routes** (a page with no login at all — `/pos/login`, `/pos/menu/:tableId`) can't gate data access through `profiles`/`auth.uid()` the normal way, since there's no session. The established pattern: a plain SQL or PL/pgSQL function, **always `SECURITY DEFINER`** (an anonymous caller has no RLS-passing identity at all, so even a function reading "already-public-by-design" data needs it), callable by the `anon` role via Postgres's default PUBLIC-execute grant. The function itself does whatever authorization makes sense for that page (e.g. `get_guest_menu` resolves table → client → checks `pos_enabled`) and returns only deliberately whitelisted columns — never a full row, never anything from a sales/orders table. Anonymous callers hitting an internal helper function directly (bypassing the public entry point) are still blocked by that helper's own RLS as long as the helper isn't itself `SECURITY DEFINER`. A 2026-07-12 Security Advisor pass also found the `anon` PUBLIC-execute grant had never been revoked from 22 other `SECURITY DEFINER` functions that are meant for authenticated sessions only (most already had the standard caller check below, so this was defense-in-depth, not an active hole) — see `20260712210000_security_advisor_anon_execute_hardening.sql`. **`get_pos_staff` used to be the one exception with genuinely no internal auth check at all** — it read `profiles` (whose `profiles_select` RLS is self-or-admin-only per the note above, so a non-`SECURITY DEFINER` version would've returned zero rows) and trusted whatever `p_client_id` the frontend passed in, sourced from a plain, unverified `localStorage` value written once at device activation. S372 (2026-07-13) found this let anyone who set `localStorage['pos_device_client_id']` to a guessed/obtained client UUID pull that client's full staff roster (names + emails) from an anonymous browser — fixed by adding `clients.pos_device_secret` (an unguessable per-client value, migration `20260713010859_pos_device_secret_hardening.sql`) as a required second parameter, fetched by `Pos.js` only from an authenticated session and verified server-side inside the function before returning any rows.
- **`get_hr_self_service_staff` had the identical shape as `get_pos_staff` above, missed by both the `20260712210000` sweep (one day before S372) and S372 itself — and was structurally worse.** It returned every `hr_self_service` employee's `full_name` *and* `hr_self_service_email` to a fully anonymous caller for any `p_client_id`, no check at all. Unlike POS's device-bound secret (extracted once from one terminal's `localStorage`, never re-shared), `SelfServiceLogin.jsx`'s `client_id` is a URL an admin hands out as a QR code/link to their **entire staff by design** — the "secret" is deliberately mass-distributed, so a `pos_device_secret`-style fix doesn't transfer: a shared self-service secret would face the exact same distribution problem the `client_id` already has. Found 2026-07-28 via a routine Security Advisor export; worse on inspection — the email wasn't even rendered by the picker UI (only `full_name`/initials show), it was fetched solely so the old client-side flow could pass it straight into `supabase.auth.signInWithPassword()`. Fixed at the root instead of by gating: `get_hr_self_service_staff` (migration `20260728100000`) now returns only `id, full_name` — the same low-sensitivity shape already accepted for `get_guest_menu`-style pre-auth pickers — and the actual sign-in moved server-side into a new Edge Function, `hr-selfservice-login`, which resolves `staff_id → email` with the service role and calls `signInWithPassword` itself, returning only the resulting session tokens. The email now never serializes to the browser at any point in the login flow. PIN lockout (`check_hr_pin_lock`/`record_hr_pin_attempt`, keyed by `staff_id`) is unchanged.
- **Every `SECURITY DEFINER` function meant for a *logged-in* caller (not the public/anon case above) must check the caller itself** — `SECURITY DEFINER` bypasses RLS entirely, so skipping this check isn't "relying on RLS as a backstop," it's no check at all. The standard shape, used by `apply_pos_item_comps`/`get_pos_staff_list`/`get_client_profile_names`/`get_cooccurrence`/`get_next_pos_comp_slip_no`: `IF NOT COALESCE(public.is_admin() OR p_client_id = (SELECT client_id FROM profiles WHERE id = auth.uid()), false) THEN RAISE EXCEPTION ...`. **The `COALESCE(..., false)` is load-bearing and this rule shipped without it until S630 — see the next bullet.** A Security Advisor pass (S293, 2026-07-07) found two functions shipped without it — `admin_clear_audit_logs` (zero check at all; any authenticated user could wipe every client's audit log — the `adminOnly` frontend route guard on `AuditLog.js` doesn't protect the RPC itself) and `get_cooccurrence` (no caller-matches-`p_client_id` check; leaked any client's item-pairing sales data to any other logged-in user, or even `anon`). Also always set `SET search_path TO 'public'` explicitly on new functions — the Advisor's `function_search_path_mutable` warning is cheap to avoid and was missing on 4 functions as of S293.

- **`IF NOT <check> THEN RAISE` fails OPEN, because `is_admin()` returns NULL rather than false (S630).** The bullet above is the rule this project has followed since S293, and for seven weeks it prescribed a guard that does not guard. `is_admin()` is `select role = 'admin' from profiles where id = auth.uid()` — a `LANGUAGE sql` scalar, so **zero matching rows returns NULL, not false**. `NOT NULL` is NULL, `IF NULL THEN` never fires, and execution falls straight through into the privileged body. Every other operand behaves the same way: `p_client_id = my_client_id()` is NULL for a caller with no profile, and `false OR NULL` is still NULL.

  Four functions carried it. Worst was `admin_clear_audit_logs` — all three parameters `DEFAULT NULL` and each clause is `(p_x IS NULL OR col = p_x)`, so an argument-less call collapses every clause to TRUE and the body is an **unfiltered `DELETE FROM audit_logs`: the whole forensic record, every tenant**, with `authenticated` holding EXECUTE. Note this is the *same function* S293 fixed for having no check at all; the replacement check was itself vacuous. `find_user_id_by_email` carried the other common spelling, `IF (SELECT role FROM profiles WHERE id = auth.uid()) <> 'admin'` — `NULL <> 'admin'` is NULL, identical outcome. `get_cooccurrence` and `get_hr_self_service_status` leaked rather than destroyed.

  **The reachable state is an authenticated session with no `profiles` row**, and it is not exotic: `handle_new_user()` ends `exception when others then return new`, so any failure of its profile insert leaves an auth account that signs in normally and permanently has none. An issued access token also outlives the row by up to its TTL after an admin deletes a user.

  **Wrap the whole condition, do not harden `is_admin()`.** Making the helper return false would not close `get_cooccurrence` or `get_hr_self_service_status`, whose second operand is independently NULL for the same caller — they would keep falling open while looking fixed. Wrapping catches every NULL source at once, and changing `is_admin()` would alter how it evaluates inside ~120 policies where NULL and false are already indistinguishable. `set_active_outlet` (S617) is the one place that got this right unprompted; `get_pos_device_secret` matches the shape but is safe, because a preceding NULL-safe `IF caller_client_id IS DISTINCT FROM p_client_id` raises first.

  Generalises past `is_admin()`: **assume any three-valued expression in a guard is a fail-open until it is wrapped** — the same trap bit `apply_pos_item_comps`' rank check via `NULL IN ('supervisor','manager')` (S531). Fixed in `20260829120000`, which asserts it behaviourally rather than by inspection: it sets a profile-less JWT claim, proves `is_admin()` really does return NULL for it, and requires all four functions to raise.

- **A new `SECURITY DEFINER` function needs its REVOKE in the same migration that creates it.** Postgres grants `EXECUTE` to `PUBLIC` by default, so every function ships anon-callable unless the migration says otherwise, and a hardening pass only ever fixes what exists on the day it runs. `clear_stale_active_outlet` was created by `20260812170000` **seven hours after** `20260812100000` swept every other function, and so became the tenth entry on a list that migration's closing note predicted would settle at nine. It `RETURNS trigger` and is therefore not invocable, so nothing was open — the drift is the lesson, not the exposure. **A trigger function needs no grant at all**: EXECUTE is checked at `CREATE TRIGGER` time, never at fire time, which `guard_pos_order_close` proves by having run on every POS bill close since 2026-08-19 holding none. So prefer `REVOKE ALL ... FROM PUBLIC` with no grant back (its pattern) over the older `assign_*` pattern that grants `authenticated` back for no reason — those seven showed up under lint `0029` purely because of it until `20260907130000` revoked them (S688). They were never exposed — PostgREST will not serve a `RETURNS trigger` function as RPC — so this was lint hygiene, not a hole.

- **Appending a defaulted parameter with `CREATE OR REPLACE` creates a SECOND function, and the fault comes in families.** Postgres keys `CREATE OR REPLACE` on the full argument-type signature, so `CREATE OR REPLACE FUNCTION f(a, b, c DEFAULT x)` over an existing `f(a, b)` leaves both live. S630 found and dropped one (`submit_guest_order`'s 3-arg overload) and did not check whether the same edit had been made elsewhere; S688's advisor export showed it had, twice — `submit_my_leave_request` (`p_day_type`) and `submit_my_tada_claim` (`p_start_point`), both dropped by `20260907130000`. `20260810190000` had meanwhile granted **both** signatures of each, which is the tell: a grant list naming two signatures of one function is reporting a bug, not a design. **PostgREST binds an overload by the argument keys in the payload**, so the stale body is reachable by anyone who sends the old key set, and every later fix lands on the live body only. The advisor lists each signature separately — that export is the cheapest way to find these. Drop the stale one explicitly (`DROP FUNCTION IF EXISTS public.f(a_types);` — `CREATE OR REPLACE` cannot); afterwards a short payload resolves to the live body through its own parameter default, which is strictly better than reaching older code.

- **`REVOKE EXECUTE ... FROM anon` (or any role) is a silent no-op if `PUBLIC` still holds the grant.** Postgres ACLs are additive — a role's effective privilege is its own grants **union** `PUBLIC`'s — so revoking from a role that never had its own separate grant entry changes nothing, with no error to say so. This is exactly what happened to the `20260712210000` migration referenced above: `REVOKE EXECUTE ... FROM anon` ran on all 25 functions, reported success, and **never took effect on a single one** — `has_function_privilege('anon', ..., 'EXECUTE')` still returned `true` a week later. Found 2026-07-20 while re-verifying an unrelated RPC fix, not by the original migration or any test. Fixed in `20260720150000_fix_ineffective_anon_execute_revokes.sql` (functions: `REVOKE ... FROM PUBLIC` then `GRANT ... TO authenticated, service_role` — `service_role` needs the explicit grant too, it is **not** a Postgres superuser in this project, only `rolbypassrls`) and `20260720160000_anon_least_privilege_table_grants.sql` (the identical pattern at the table level: `anon`/`authenticated` both held stray `TRUNCATE`/`REFERENCES`/`TRIGGER` on every table, and `anon` separately held full `SELECT`/`INSERT`/`UPDATE`/`DELETE` on 22 real tables including `profiles`/`clients`/`sales_entries`, safe only because every write policy on them requires `client_id = my_client_id()`). Deliberately left alone at the time: `is_admin()`/`my_client_id()`/`is_hr_self_service()`/`is_pos_pin_staff()` (and later `is_ims_staff()`/`is_hr_role_staff()`) — they're embedded in RLS policies across dozens of tables, and `anon` has a genuine, intentional `SELECT` grant on `settings` for a pre-login `app_name` read gated by a policy that calls `my_client_id()`; tested in a rolled-back transaction that revoking it from `PUBLIC` breaks that read with `permission denied for function my_client_id` even filtered to the safe row, since Postgres doesn't reliably short-circuit past the second `OR` operand once RLS folds into the row filter.

  **That exemption list was four functions too long, and `20260812100000` corrects it (S538).** The test behind it only ever covered `my_client_id()`; the other five were added by association. Reading the policy settles it — `settings_select` is `client_id IS NULL OR client_id = my_client_id() OR is_admin()`, so the anon path touches **exactly those two**. The four staff-marker helpers appear only in the RESTRICTIVE staff-isolation policies, and on `settings` those cover INSERT/UPDATE only, never SELECT. Re-tested in a rolled-back transaction with all four revoked: the anon `app_name` read still returns. So `is_ims_staff()`/`is_hr_role_staff()`/`is_pos_pin_staff()`/`is_hr_self_service()` are now `PUBLIC`-revoked and granted to `authenticated`/`service_role` like everything else; the migration bakes the anon read in as a guard and additionally asserts that `is_admin()`/`my_client_id()` were *not* revoked, since extending the list by association is the exact mistake it undoes. **`is_admin()` and `my_client_id()` stay exempt permanently** — revoking either blanks the app name for every signed-out visitor, with no error surfaced to the page. Broader lesson: an exemption list justified by one test covering one member is not a reasoned list, and the cheapest way to check is to read the policy and see which functions it actually names.

  **Always verify a revoke actually worked** with `has_function_privilege('anon', 'public.foo(...)', 'EXECUTE')` / `has_table_privilege('anon', 'public.sometable', 'SELECT')` — never trust "Success. No rows returned" from the SQL Editor alone.
- **An EXECUTE grant is per *signature*, not per function name — so adding a parameter to a hardened function silently re-opens it.** Second, independent trap on top of the PUBLIC-vs-role one above: that one is "your revoke went to the wrong grantee", this one is "your revoke went to the wrong function". `REVOKE ... FROM PUBLIC` on `foo(a, b)` does nothing to `foo(a, b, c)`, and a new overload is created carrying Postgres's default `GRANT EXECUTE TO PUBLIC`. Found 2026-08-10 (S532) by running `has_function_privilege('anon', p.oid, 'EXECUTE')` across all of `pg_proc` and reading the result: `submit_my_leave_request`, `submit_my_tada_claim` and `submit_guest_order` each appeared **twice** — every one had been extended by one parameter after the `20260712210000`/`20260720150000` sweeps, and the new signature was never revoked. Both overloads of each were anon-executable. When adding a parameter to any function that has ever been revoked, revoke the **new** signature too, and keep the old one revoked rather than dropped — the service worker is cache-first, so a device can still be running a bundle that calls the old arity, and `DROP FUNCTION` turns that into a hard failure instead of a stale-but-working form.

  **But a surviving overload that can absorb the old arity through its own defaults makes dropping strictly better, and S532 stopped one step short of that (S630).** The trap has a third face: `CREATE OR REPLACE` keys on the full argument-type signature, so **appending a defaulted parameter does not replace anything — it forks the function**, and the old body then silently misses every subsequent fix. `20260707230000` believed the opposite in a comment (*"CREATE OR REPLACE-compatible … no DROP needed"*), and the 3-arg `submit_guest_order` sat frozen at its 2026-07-07 state for seven weeks while the covers clamp and the `unique_violation` handler landed only on the 4-arg one. S532 saw the pair, read it correctly as a *grant* problem, and left both live; neither is revoked because guest ordering is anon-callable by design, so revoking the stale one would break a stale client exactly as dropping normally would. Dropping it does not, because PostgREST calls by named argument: a 3-key payload now resolves to the 4-arg body via `p_covers`'s default. **Check whether the survivor's defaults cover the old call shape — if they do, drop; if they don't, revoke and leave it.** The reason to care was not the API surface but a number: a 3-key call writes `covers = 1`, and `PosOrders.jsx` skips the covers numpad entirely when a pending guest request exists, so staff are never prompted and the bill records one cover into the Covers Report.
- **A frontend-only relocation is not a hardening.** The same S532 pass found `record_pos_pin_attempt`/`record_hr_pin_attempt`/`check_*_pin_lock` still anon-executable: S531 moved the calls *into* the Edge Functions (invariant #3 above) and verified the browser no longer calls them — a grep of `src/` finds zero call sites, only comments — but never revoked the EXECUTE grant the browser had needed. `record_*_pin_attempt` has no auth check of any kind and its success branch is `UPDATE profiles SET *_pin_failed_attempts = 0, *_pin_locked_until = NULL WHERE id = p_staff_id`, so a single anonymous POST reset the lockout counter for an arbitrary staff member. On HR Self-Service that was the whole control: `hr-selfservice-login` takes `{staff_id, pin}` and nothing else (no device secret, unlike `pos-staff-login`), and `get_hr_self_service_staff` hands out `staff_id`s to anonymous callers by design — reset every 4th guess and a 4-digit PIN falls in ≤10,000 unthrottled tries. Fixed in `20260810190000` (`service_role` only for the four lockout functions; `authenticated` for the rest). **Whenever a call moves from the browser to the server, the matching grant must move with it** — the old grant is not merely redundant, it is the exact surface the move was meant to close.
- **The Admin Audit Log (`audit_logs` table, `log_audit()` trigger function, `src/pages/AuditLog.js`) is one generic trigger reused across every audited table, not a bespoke one per table** — `log_audit()` fires `AFTER INSERT OR DELETE OR UPDATE`, stamps `client_id`/`client_name`/`user_id`/`user_name`, and stores the full `to_jsonb(OLD)`/`to_jsonb(NEW)` row snapshot. As of S518, the frontend also computes its diff generically — `diffFields()` in `AuditLog.js` compares every key in `old_data`/`new_data` and renders whatever changed, instead of the pre-S518 hand-written per-table `switch` that silently showed nothing for any field nobody remembered to add a case for (found live: `profiles.pos_discount_limit`/`pos_allow_void` changed with zero visible summary for weeks after shipping). **Any table with a high-frequency housekeeping column needs an explicit noise-skip clause inside `log_audit()` itself, not just a frontend filter** — without it, the generic diff would surface real spam: `profiles` gets touched on every login/session-refresh (`last_seen_at`) and every PIN attempt (`pos_pin_failed_attempts`/`hr_pin_failed_attempts`/their `*_locked_until` pairs), and `pos_orders` gets touched on every item edit or bill reprint (`covers`/`print_count`/`comp_print_count`) — both tables have a dedicated `IF ... to_jsonb(OLD) - ARRAY[...] = to_jsonb(NEW) - ARRAY[...] THEN RETURN NULL` block (same shape as the pre-existing `monthly_periods` status-only check) so a no-real-change write never even gets inserted, mirrored by a matching `IGNORE_KEYS`/`TABLE_EXTRA_IGNORE` set in the frontend for rows written before the trigger fix shipped. `clients` additionally has `pos_device_secret` stripped from both snapshots before insert — a genuine secret (see `get_pos_staff` note above) has no reason to ever land in a table, admin-only viewer or not. Coverage as of S518 (`20260804040000_audit_log_expanded_coverage.sql`): `purchase_entries`, `vendor_returns`, `opening_stock`, `closing_stock`, `wastages`, `monthly_periods` (status only), `items`, `profiles`, `hr_employees`, `hr_salary_components`, `hr_attendance`, `hr_payslips`, `hr_payroll_runs`, `hr_festival_allowances`, `hr_leave_types`, `hr_leave_requests`, `pos_orders` (meaningful transitions only), `pos_credit_notes`, `clients`, `feature_flags` — deliberately still excluded: `sales_entries`/vendors/recipes (no trigger), and POS line-item tables (`pos_order_items`, `pos_kot_log`, `pos_order_payments`) since per-item audit volume would dwarf the signal. **`CREATE OR REPLACE FUNCTION`/`CREATE OR REPLACE TRIGGER` succeeding doesn't retroactively re-filter rows already written under the old function body** — after deploying a new noise-skip clause, old rows that match the new skip condition still exist and will read as "(no tracked field changed)" in the UI once the frontend's ignore-list also hides those fields; that's expected leftover history, not a sign the fix didn't take. Confirmed live (S518) with the same discipline as the anon-revoke lesson above: `pg_get_functiondef('public.log_audit()'::regprocedure)` to read back the actually-deployed function body, then a real `UPDATE ... last_seen_at = now()` + a `count(*)` on `audit_logs` in the following minute to prove zero rows were written — don't stop at the dashboard's "Success" message.

### Schema migrations

The Supabase CLI is installed and linked to the live project (`supabase link`, ref in `supabase/.temp/`). `supabase/migrations/` is the source of truth for schema history — a root-level `supabase_schema.sql` snapshot used to serve this purpose and is retired as of the `20260705074838_baseline_schema.sql` migration (a full `pg_dump --schema-only` of the live DB at that point in time).

**Workflow for every schema change:**

1. Create a new file: `supabase/migrations/<YYYYMMDDHHMMSS>_<description>.sql` (or `supabase migration new <description>` to scaffold the filename).
2. Write the SQL in that file.
3. Apply it the normal way — paste it into the Supabase Dashboard → SQL Editor and run it.
4. Commit the file. Never run ad hoc schema SQL in the dashboard without also saving it as a migration file first — that file is the only record of what changed and when.

**Docker note:** `supabase db pull` / `supabase db dump` require Docker Desktop (they shell out to a version-matched `pg_dump` via a Docker image) — not installed on this machine. The baseline was produced instead with a standalone `pg_dump 17.10` client (`C:\Program Files\PostgreSQL\17\bin`) against the pooler connection string, which is sufficient for the write-a-file-by-hand workflow above. Installing Docker Desktop would additionally unlock `supabase db diff` (auto-generates a migration from a local schema change) — not required unless that workflow is wanted later. Docker's absence does **not** block Edge Function deploys — `supabase functions deploy <name>` doesn't need it, and the CLI on this machine is already authenticated + linked (`supabase projects list` works without any login step), so a function can be shipped directly from here with no manual dashboard upload.

**`CREATE OR REPLACE FUNCTION` cannot change an existing function's return columns** (Postgres error `42P13`, "cannot change return type of existing function," with a hint pointing at `DROP FUNCTION` first) — this includes adding, removing, or reordering `RETURNS TABLE(...)` columns, even if the function body and parameter list are otherwise unchanged. Caught live (S464, `20260728100000_hr_self_service_staff_drop_email.sql`) shrinking a function from 3 output columns to 2. The fix is always `DROP FUNCTION IF EXISTS public.foo(arg_types);` immediately before the `CREATE FUNCTION` — the `IF EXISTS` keeps the migration idempotent (safe to paste and run again if a prior attempt partially failed, since a failed statement in the Dashboard SQL Editor does not commit anything before it in the same paste unless explicitly wrapped in its own transaction control). Changing only the function *body* (same signature, same return shape) is unaffected — plain `CREATE OR REPLACE` still works for that, which is why this hadn't come up in any of this project's many prior `CREATE OR REPLACE FUNCTION` migrations.

**A plpgsql body is NOT validated at `CREATE` time, so a migration that applies cleanly can still ship a function that fails on its first call (S735).** Postgres parses the body for syntax only; every SQL expression inside is resolved the first time that statement executes. `save_purchase_bill` shipped `SELECT max(po_id) …` over a uuid column in S709 — Postgres has no `max(uuid)` — and the migration ran green, the source-text assertion (`prosrc LIKE '%v_po_id%'`) passed, and every bill *edit* then failed with `42883 function max(uuid) does not exist` until S735. Two consequences: **a `prosrc LIKE` assertion proves a feature is mentioned, not that it runs** — when a migration changes a function's body, the verification block should call it once inside a `BEGIN … ROLLBACK`; and **`42883` does not always mean an unapplied migration** — `errorText.js` words it that way, which is right for a missing RPC and wrong for an applied function calling something that does not exist. `min`/`max` exist for the ordered types only; for "the one non-NULL value in this set" of a uuid column use `WHERE col IS NOT NULL … LIMIT 1`.

**And a CALL only exercises the body it actually reaches (S737).** The rule above says a migration
that changes a function body should call it once inside `BEGIN … ROLLBACK`. S737 did exactly that
for `get_ims_staff_list`, the block passed, and the function raised `42804 structure of query does
not match function result type` on **every** real call — IMS Staff and Stock Count → Settings both
rendering their failed-read card. The verification ran in the SQL editor, where `auth.uid()` is
NULL, so the function's own caller check was false and `RETURN QUERY` never executed. The call
proved the function could be ENTERED, not that its body works.

So: **where the body sits behind an authorisation check, a call that the guard rejects is not a
test.** Either give the block a caller the guard accepts, or — simpler and what
`20260910150000` does — create a scratch `pg_temp` function holding the identical SELECT and the
identical `RETURNS TABLE`, call it, and drop it, so the tuple descriptors really are compared.
Have it print the source column types with `RAISE NOTICE` too: plpgsql's 42804 names no column, so
a failure is otherwise a guess.

The underlying trap is worth knowing on its own: **`RETURN QUERY` compares attribute type OIDs
EXACTLY**, and `character varying` is not `text` even though the two are binary-coercible.
`auth.users.email` is varchar. Cast every returned column to the type the signature declares —
that is a property of the statement rather than of whatever schema sits underneath it, so it
cannot break again when GoTrue changes a column.

## `updated_at` is not maintained by the database — check before you trust it (S620)

**Only ONE table in this schema maintains `updated_at` by trigger: `pos_reservations`
(`pos_reservations_touch`, `touch_updated_at()`, migration `20260904200000`, S677).** Everywhere
else the column exists with `DEFAULT now()`, which fires on INSERT only, so unless application code
writes it explicitly on every UPDATE it stays frozen at the row's creation time forever. A new table
that wants a live `updated_at` attaches that same trigger function — do not write a second one.

That makes it reliable on some tables and meaningless on others, which is worse than uniformly
absent — it reads as trustworthy because you last saw it work somewhere else:

| Table | `updated_at` |
| --- | --- |
| `feature_flags`, `par_levels`, `settings`, `client_secrets` | written by app code — usable |
| `pos_reservations` | maintained by trigger (`pos_reservations_touch`) — usable |
| **`hr_employees`, `pos_customers`** | **column exists, nothing writes it — always equals `created_at`** |

This shipped a real near-miss. `scripts/bs-date-audit.mjs` proposes corrections to stored dates and
guarded against touching an already-corrected value with "was this row updated after the fix?". On
`hr_employees` that guard could not fire once. It reported `0 need review`, meant nothing by it, and
would have overwritten two correct dates on a live employee record — caught only because the owner
knew the man's actual last working day. The fix reads per-field write times from `audit_logs`
instead (`log_audit()` snapshots the whole row, so the last entry where a COLUMN changed is when it
took its current value).

Two rules follow:

- **Before writing any logic that depends on `updated_at`, grep for something that writes it.**
  A guard on a column nobody updates is the same vacuous shape as a guard that drops its read error.
- **Adding `updated_at` to a new table does nothing on its own.** Either write it from the app on
  every update path, or add a `BEFORE UPDATE` trigger — a bare column is a promise the schema does
  not keep. `audit_logs` is the reliable alternative for tables carrying a `log_audit()` trigger
  (currently `hr_employees` and `hr_leave_requests` among the HR/date tables), though note audit
  logging in this project only begins **2026-08-04**, so it cannot date anything written earlier.

## Edge Functions and the restrictive staff-isolation families

Migrated from the root `CLAUDE.md` (S663).

- Admin operations that need the service role key go through the Supabase Edge Function `admin-user-ops` (deployed at `supabase/functions/admin-user-ops/`). Never put `SUPABASE_SERVICE_ROLE_KEY` in the frontend bundle.
- Real Web Push (Roster publish + shift-swap notifications) is sent from the Edge Function `hr-push` (`supabase/functions/hr-push/`) — the only place holding the VAPID private key (`VAPID_PRIVATE_KEY` secret; the public half is `REACT_APP_VAPID_PUBLIC_KEY`, safe to expose). `src/utils/webPush.js` handles the frontend subscribe flow, including the iOS Safari quirk where the Push API is only available to a page added to the Home Screen, never a regular tab.
- `hr-selfservice-login` (`supabase/functions/hr-selfservice-login/`, added S464) completes HR Self-Service PIN login server-side: takes `{ staff_id, pin }`, resolves the real email with the service role, calls `signInWithPassword` itself, and returns only the resulting session tokens — added specifically so the browser never has to hold or transmit the account's actual email during login. `SelfServiceLogin.jsx` calls it via `supabase.functions.invoke(...)` and then `supabase.auth.setSession({access_token, refresh_token})` on success, since `signInWithPassword` used to do that step implicitly and now the real auth call happens off-browser.
- `ims-staff-login` (`supabase/functions/ims-staff-login/`, added S737) is the stock-count tablet's equivalent — `{ client_id, device_secret, staff_id, pin }`, the device gate first, then the lockout, then the derived password, returning only session tokens. `verify_jwt = false` for the same reason: it runs before there is a session. Its device secret is `client_secrets.ims_device_secret`, which a tablet obtains only by redeeming a short-lived enrolment token off the QR a manager shows in Stock Count → Settings — never by pressing a button on the device, which a store-room tablet has no manager session to press.
- **Staff accounts are same-client at the RLS level** — POS PIN staff (`pos_email IS NOT NULL`), IMS staff (`ims_role IS NOT NULL`, whether they sign in with a password or an S737 count PIN), HR staff (`hr_role IS NOT NULL`), and HR self-service accounts (`hr_self_service = true`) all share `role='client'` + `client_id` with the owner, so the standard admin-or-same-client policy alone gives any of them owner-level data access. S316 (`20260708130000_staff_account_business_table_isolation.sql`) fenced off POS/self-service with **RESTRICTIVE** `no_self_service_accounts` / `no_pos_pin_staff` policies per table; S419 added `no_ims_staff` for IMS staff; S430 added `no_hr_role_staff` for HR staff (helpers: `is_hr_self_service()`, `is_pos_pin_staff()`, `is_ims_staff()`, `is_hr_role_staff()`). **When creating a new business table, add it to every matching restrictive-policy list** — a new table doesn't inherit the exclusions, and a bare same-client policy re-opens the hole for whichever staff-account type's JWT touches it.

## A purchase bill saves through `save_purchase_bill`, and a paid bill cannot be deleted (S698)

`save_purchase_bill(p_period_id, p_group_id, p_lines, p_superseded_ids, p_created_at)` (migration
`20260908140000`) is the purchases twin of `save_sales_day` below: `PurchaseBillForm.jsx` is its
only caller, and it deletes the superseded line ids and inserts the replacements in ONE
transaction. Until S698 the edit path was two HTTP requests (insert, then delete), and a failure
between them left the bill holding both versions and every purchase figure double-counting it.
Same `SECURITY INVOKER` reasoning as the sales one — `purchase_entries` carries the restrictive
staff-isolation families and every one of them must keep applying. Two properties are load-bearing:

- **The delete runs first and its row count is ASSERTED.** Under RLS a row the caller may not
  delete simply does not delete, and a row someone else already removed is the same silence — so
  an unasserted count is the S648 duplicate one layer down. A mismatch raises `purchase_bill_stale`
  and rolls the whole save back; `errorText.js` words it.
- **A bill with vendor payments is refused** (`purchase_bill_has_payments`). `payable_payments`
  is `ON DELETE CASCADE` off `purchase_entries`, so an edit — which deletes lines — or a delete
  silently erased money that had left the bank. Decision (Aashish, 2026-09-08): block, never warn.

The block lives in THREE places on purpose. `purchase_entries_guard_paid_delete` is a `BEFORE
DELETE` trigger, because the list page's Delete and Delete All never go through the RPC and a
delete the browser can skip is advisory (invariant #3); it keys off `current_user IN ('anon',
'authenticated')` exactly as `guard_profiles_privileged_columns()` does, so the service role passes
— Danger Zone deletes a client's `payable_payments` BEFORE its `purchase_entries` anyway. The RPC
checks before writing so the message is the bill's own. And `Purchases.js` pre-checks through
`purchase_bill_payments(p_ids)` so the refusal is worded before anything is attempted — that
lookup is `SECURITY DEFINER` (with its own caller check, wrapped in `COALESCE`) so the guard cannot
pass vacuously for an account whose RLS view of `payable_payments` is narrower than its view of
`purchase_entries`. **A guard that drops its read passes vacuously**, so the pre-check refuses on a
failed read too. No legacy fallback: the migration must be applied before the frontend deploys, and
until it is, Save reports the function as unavailable rather than saving the old two-step way.

## A PO receipt is one transaction too — `receive_purchase_order` (S709)

`receive_purchase_order(p_po_id, p_bs_day, p_payment_method, p_vat_inclusive, p_group_id, p_lines)`
(migration `20260909150000`) is the third member of this family, and it exists because
`PurchaseOrders.js` writes `purchase_entries` — the same table the two above protect — through a
path that had none of their discipline. It was FOUR round trips: insert the bills, one
`qty_received` update per line, then the status. Same `SECURITY INVOKER` reasoning as its siblings.
Four properties are load-bearing:

- **`qty_received` is INCREMENTED, not assigned.** The browser used to write
  `snapshot + receiving`, off a snapshot read when the screen opened — so two people receiving one
  delivery each banked it and the second erased the first, and the over-receive check was computed
  off the same stale number. The PO row is taken `FOR UPDATE` first, so concurrent receipts queue
  and the remaining-quantity check is true at the moment it is applied.
- **The status write cannot go missing.** It was the one call in the old path with no error check
  at all, and its absence left the PO on `draft` holding received quantities — the exact state in
  which Edit (draft-only) replaces the line rows at `qty_received: 0` and the delivery can be
  received and billed twice. The status is now derived from the table inside the same statement.
- **It enforces the closed-period lock** (`po_period_closed`, `is_admin()` carve-out wrapped in
  COALESCE). The first server-side half of a lock that is browser-only on the other five pages —
  see `closed-periods.md` for why this one needed it.
- **It writes `purchase_entries.po_id`**, the link back to the order. `save_purchase_bill` was
  amended in the same migration to CARRY that link through an edit (`max(po_id)` of the superseded
  rows, read before the delete); without that, correcting a typo on a received bill in Purchases
  silently cut it loose. **A link that does not survive an ordinary edit is not a link**, and the
  assertion block checks the carry-through is still there.

`purchase_orders_guard_delete` is the fourth `BEFORE DELETE` trigger of the shape below, refusing
two things: a non-admin delete (the page's own `if (!isAdmin) return`, which was the whole of the
enforcement — every IMS account could `DELETE /rest/v1/purchase_orders` including a `staff` rank
that cannot open the page), and any order with bills against it. `po_id` is `ON DELETE SET NULL`,
so without that second refusal the delete would SUCCEED and strip the link off the bills — the
`confdeltype` trap, again, on a column added the same day.

### The same shape on `items` (S707), and what makes it a pattern

`items_guard_referenced_delete` (`20260909130000`) is the second instance and copies this one
deliberately: a `BEFORE DELETE` trigger, SECURITY INVOKER, keyed on `current_user IN ('anon',
'authenticated')`, with a `SECURITY DEFINER` lookup (`item_reference_counts`) so the guard cannot
pass vacuously for a caller whose RLS view of the child tables is narrower than its view of the
parent. Three things generalise from having done it twice:

- **The RPC is not the alternative to the trigger; it is the layer above it.** An RPC protects only
  the callers that choose to call it and leaves the permissive policy exactly as wide (invariant
  #3). `items` is deliberately absent from the `no_ims_staff` restrictive list, so *any* IMS
  account — including an `ims_role = 'staff'` that cannot open Item Master at all — could
  `DELETE /rest/v1/items?id=eq.<uuid>` with its own JWT. A page-level guard is a guard on the page.
- **`SECURITY DEFINER` is how the sanctioned path gets through its own guard.** `current_user` is
  the owner inside a DEFINER body, so `force_delete_item()` passes the INVOKER trigger that refuses
  everyone else — the same seam `set_active_outlet()` uses to be the only writer of
  `profiles.active_client_id`. That makes the pair worth asserting in a test: swap either keyword
  and they stop working in opposite directions, silently.
- **A destructive multi-table action belongs in ONE function body, because that is one
  transaction.** `force_delete_item()` replaced twelve sequential HTTP requests whose ninth could
  fail with the first eight tables already emptied — a state no error message can describe
  correctly. Atomicity is not an optimisation here; it is what lets the failure message say
  "nothing was removed" and be true.

### The third instance, on `vendors` (S708) — and the variation worth noticing

`vendors_guard_referenced_delete` (`20260909140000`) is the same shape again: `BEFORE DELETE`,
SECURITY INVOKER, the `current_user IN ('anon','authenticated')` seam, a `SECURITY DEFINER` lookup
(`vendor_reference_counts`) over the four tables that hold a `vendor_id`. `vendors` carries no
`no_ims_staff` fence either, so the same sentence applies verbatim — every IMS account of any rank
could delete a supplier over REST, and two of its four FKs are `ON DELETE SET NULL`, so Postgres
refused nothing on that half.

**The variation: there is deliberately no `force_delete_vendor()`.** That is the first time this
pattern has shipped without its DEFINER escape hatch, and the reason generalises. `force_delete_item`
exists because an item can be a genuine mis-entry someone needs gone along with its rows. A vendor
with history is not a mis-entry — it is a supplier the client really did buy from, and the only
thing a force-delete could do is destroy the record proving it. **The sanctioned way through a guard
does not have to be a privileged bypass; where a lossless state change already exists, that is the
way through.** For vendors it is `archived_at` (S671): the row is kept and hidden, so every FK, join
and report is untouched. The service role stays exempt via the same `current_user` seam, which is
what keeps Danger Zone working — and it deletes all four referencing tables before `vendors` anyway.

So the trigger has no bypass for a client account of any rank, operator included. When adding a
fourth instance, decide which of the two shapes it is before writing the migration: a DEFINER
force-path is a real answer, but so is refusing outright and pointing at the state change.

**A list that must exist in both JS and SQL needs a test that reads both.** `ITEM_REF_TABLES` is now
mirrored inside two SQL functions, and the server cannot import a `.js` module.
`itemRefTables.test.js` parses the migration and asserts membership *and* order. Strip `--` comments
before asserting on a function body — a header explaining why the sibling is `SECURITY DEFINER` will
otherwise fail the assertion that this one is not. **`VENDOR_REF_TABLES` has no such test** — it
is inline in `Vendors.js` and mirrored in `vendor_reference_counts`, correct today and held together
by nothing, so a fifth table with a `vendor_id` FK reaches neither copy on its own.

## Sales Entry saves through one atomic RPC, not three round trips

Migrated from the root `CLAUDE.md` (S663).

`save_sales_day(p_period_id, p_bs_day, p_rows)` (migration `20260727120000`) does delete + insert + cross-mode cleanup in a single transaction; `src/modules/ims/sales/persistSalesDay.js` is the only caller and serves **both** Daily (`bsDay` 1–32) and Bulk (`bsDay` 0) — they're the same operation, the 0 just flips which side the cross-mode cleanup supersedes. It was three separate HTTP requests until S456, which meant a stall between the delete and the insert left the day's rows deleted with nothing written back (a live smoke test measured one round trip at 12.4s against sub-second neighbours, so this was reachable, not theoretical).

The function is deliberately **`SECURITY INVOKER`** (i.e. no `SECURITY DEFINER`). `sales_entries` carries RESTRICTIVE staff-isolation policies (`no_self_service_accounts`, `no_hr_role_staff`) on top of the permissive client-scoping ones, and INVOKER keeps every one of them enforced for free. Adding `SECURITY DEFINER` here would silently punch through that isolation and require hand-reimplementing all four checks — don't.

`persistSalesDay` also carries a legacy three-call fallback, used **only** when the RPC returns `PGRST202`/`42883` (function not in the schema cache). That exists purely because this project applies migrations by hand in the dashboard, so there's a real window where deployed code predates the migration; it is not a retry-on-failure path, and every other error is rethrown untouched so nothing gets written twice. Once the migration is applied everywhere, the fallback and `isMissingFunctionError` can be deleted.

**`depleteManualSales()` reads its POS-supersedes guard BEFORE it deletes the day, and stops on a failed read (S683).** It used to delete this day's manual movements first and then read `sales_entries` for POS rows with `const { data: posRows } = …` — so a dead connection gave an empty index, every manual row counted as "not superseded", and a recipe POS had already depleted was depleted a second time. That is CLAUDE.md's "a guard that drops its read error passes vacuously" rule, live in the money path it was written about. Read first, then delete, then reinsert; a failed read or a refused delete leaves the previous save's depletion in place, which is the only state that is not a double count. `depleteManualSales.test.js` pins all four branches.
