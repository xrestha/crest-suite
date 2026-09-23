---
name: apply-migration
description: Write a Supabase migration and take it live. Plan first, write the file, then STOP and wait for the user's explicit "apply" in a new message before supabase db query --linked; then verify against the live catalog.
---

# Apply a migration

A migration is a production change. This procedure has two halves with a hard stop between them.

## Half 1: plan and write (nothing touches the live database)

1. **Plan first, always.** Say what the migration changes (tables, columns, functions, policies, grants), what depends on it, and how it would be reversed. Wait for approval of the plan.
2. **Create the file** `supabase/migrations/<YYYYMMDDHHMMSS>_<description>.sql`, timestamped after the newest file there (or scaffold it with `supabase migration new <description>`).
3. **Write the SQL** to `.claude/rules/supabase-sql.md`, which loads when the file is opened. The checks most often missed:
   - A table created in raw SQL gets no SELECT/INSERT/UPDATE/DELETE grants here: add explicit `GRANT`s to `authenticated`. It DOES get TRUNCATE, REFERENCES, TRIGGER and MAINTAIN for `anon` and `authenticated` from the schema's default privileges, so `REVOKE` those in the same migration (S782).
   - Policies call `my_client_id()`, never its body, and every authorisation condition is wrapped in `COALESCE(…, false)`.
   - A new business table joins every matching restrictive staff-isolation policy list.
   - `CREATE OR REPLACE FUNCTION` cannot change a function's return columns; drop it first.
   - End with `NOTIFY pgrst, 'reload schema';` when the API surface changes.
   - App-side registration (`CLIENT_SCOPED_TABLES`, Danger Zone, export `RESTORE_ORDER`) is in the `new-feature-checklist` skill.
4. **STOP.** Give the user the file path and a plain summary of what it will do, name any Edge Function deploy that goes with it, and ask them to reply "apply". **Never run `supabase db query --linked` in the same turn as writing or editing the migration.** Wait for an explicit "apply" in a new message. Approving the plan is not approval to apply.

## Half 2: apply and prove it (only after "apply")

5. **Apply** through the Bash tool, reading the exit code:
   `supabase db query --linked -f supabase/migrations/<file>.sql > /tmp/migration.log 2>&1; echo "exit=$?"; tail -40 /tmp/migration.log`
   The linked CLI goes through the Management API, so no database password is needed. If the file changed after the user said "apply", stop and ask again.
6. **Deploy the paired Edge Function**, if step 4 named one: `supabase functions deploy <name>`, in the same exit-code shape.
7. **Verify against the live catalog.** A committed migration is not evidence the migration ran (S753): `db query` and the Dashboard do not record in `supabase_migrations.schema_migrations`, so `supabase migration list` cannot tell you. Read each object back (`information_schema.columns`, `pg_policies`, `pg_get_functiondef`, `information_schema.role_table_grants`), one read per call, because a multi-statement `db query` returns only the last statement's rows.
8. **Exercise a changed guard or `SECURITY DEFINER` body as a real user** where it matters: a `DO` block that sets `request.jwt.claims` with `set_config(…, true)`, makes its temporary writes, calls the function and ends in `RAISE EXCEPTION` carrying the results, so everything rolls back. If a permission check blocks this, say so; do not skip it silently.
9. **Record it.** The CHANGELOG entry names the migration id, says "applied live" and says how it was verified. Then finish with the `ship-change` skill.

If a browser console shows `PGRST204` or `42703` on a column a migration adds, suspect an unapplied file before a code bug. Never run ad hoc schema SQL without saving it as a migration file first: that file is the only record of what changed and when.
