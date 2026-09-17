# supabase-sql.md: archived sections

Moved word for word out of .claude/rules/supabase-sql.md in the S770 context pass (2026-09-17). This is history and is not auto-loaded: no rules glob matches docs/. The live rule stays in the rules file, usually with a pointer here. Line numbers refer to the rules file before the move.

---

_Original lines 354–354:_

**Security headers live in `vercel.json`, and that file cannot carry comments** — it is strict JSON validated against Vercel's schema, so the usual `"//": "why"` trick fails the *build* rather than being ignored. **`connect-src` is the control that matters most — it is the exfiltration boundary, and adding any new third-party API call requires adding its origin there or it fails silently in production and works fine in dev.** The rest of the rationale is in `.claude/rules/security-headers.md`.

---

_Lines 75–80 of the rules file after the first S770 move, replaced later in S770 by a pointer to the `apply-migration` skill:_

**Workflow for every schema change:**

1. Create a new file: `supabase/migrations/<YYYYMMDDHHMMSS>_<description>.sql` (or `supabase migration new <description>` to scaffold the filename).
2. Write the SQL in that file.
3. Apply it — paste it into the Supabase Dashboard → SQL Editor, **or** run it from this machine with `supabase db query --linked -f supabase/migrations/<file>.sql` (the CLI is authenticated and linked; it goes through the Management API, so no DB password is needed — S747 applied three migrations this way). Applying is a production change: confirm with Aashish first. A multi-statement `db query` returns only the LAST statement's rows, so run verification reads one per call. To exercise a function body as a real user without leaving data behind, use a `DO` block that sets `request.jwt.claims` with `set_config(…, true)`, does its temporary writes, calls the function and ends in `RAISE EXCEPTION` carrying the results — the exception rolls everything back.
4. Commit the file. **A committed migration is not evidence the migration ran (S753).** `20260814130000` sat in the repo for a month while the live `monthly_periods` had neither column; migrations applied through the Dashboard or `db query` are not recorded in `supabase_migrations.schema_migrations`, so `supabase migration list` cannot tell you. After applying, read the object back from the live catalog, and when a browser console shows `PGRST204` / `42703` on a column a migration adds, suspect an unapplied file before a code bug. Never run ad hoc schema SQL in the dashboard without also saving it as a migration file first — that file is the only record of what changed and when.
