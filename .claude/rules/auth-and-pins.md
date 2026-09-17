---
paths:
  - "src/pages/Login.js"
  - "src/pages/Signup.js"
  - "src/pages/ResetPassword.js"
  - "src/utils/weakPasswords.js"
  - "src/modules/pos/staff/**"
  - "src/modules/ims/staff/**"
  - "src/modules/hr/staff/**"
  - "src/modules/hr/employees/EmployeeList.jsx"
  - "src/modules/pos/devices/**"
  - "src/modules/pos/login/**"
  - "src/modules/pos/Pos.js"
  - "src/modules/hr/selfservice/**"
  - "src/modules/ims/count/**"
  - "supabase/functions/**"
---

# Auth pages, password policy, leaked-password protection, PIN vault

> Moved out of the root CLAUDE.md (2026-08-18 /doctor pass) so it loads only when working on these files. Root CLAUDE.md keeps the universal invariants.

### Every `type="password"` input needs an explicit `autoComplete`

> Moved out of the root CLAUDE.md (2026-09-15 /doctor pass); a one-line stub stays there.

Without one, Chrome guesses from `type` + surrounding context — and any `type="password"` field anywhere on the page makes it treat the nearest preceding text input as a login username, which has bled a saved login into unrelated fields (a `SearchableSelect` search box, a signup form) more than once (S329). Use `autoComplete="new-password"` on every PIN/account-creation field (POS Staff Add/Reset PIN, Enable Self-Service, trial signup), and `autoComplete="username"` / `"current-password"` on an actual sign-in form's email/password. PIN-pad login screens (POS/HR Self-Service) build their own keypad UI rather than a text input, so they're unaffected.

### Password policy lives in one constant, and the server holds an independent copy

`MIN_PASSWORD_LENGTH` (`src/utils/weakPasswords.js`, 8 — NIST SP 800-63B-4's floor) is the single source of truth for every client-side password check: the trial signup form and `ResetPassword.js` both read it, and both render it into their own placeholder text so the hint can never drift from the rule. `register_trial` in `admin-user-ops/index.ts` necessarily carries its own hardcoded copy — an Edge Function can't import from the bundle — so **changing the floor means editing both, plus a `supabase functions deploy admin-user-ops`.** These three used to disagree (S534): the two client checks said 6 while the server said 8, so a 7-character password passed the form, contradicted the placeholder the user had just read, and was rejected by the server.

`weakPasswordReason(password, { businessName, email })` in the same file is the offline half of NIST's blocklist-screening control — common passwords, single-character repeats, sequential runs, and passwords derived from the business name or email local-part. It is deliberately **client-side only and not a security boundary**: the server enforces length alone, so treat this as a UX guardrail that stops someone picking their own restaurant's name as a password, not as something an attacker can't skip. The breached-password half now exists server-side (below) — `isPasswordPwned()` in the Edge Function, *alongside* this rather than instead of it. It runs in Deno, so the `connect-src` caveat this note used to carry does not apply; `api.pwnedpasswords.com` needs **no** `vercel.json` entry. Adding the same check to a *frontend* path still would.

### Leaked-password protection: the dashboard toggle covers less than it looks like, and PINs are why (S538)

The Security Advisor's "Leaked Password Protection Disabled" warning is real but the toggle is **not** the fix, for two reasons that only show up in GoTrue's source:

- **`adminUserCreate` never calls `checkPasswordStrength()`, `adminUserUpdate` does.** So `auth.admin.createUser()` bypasses the HIBP check entirely and `auth.admin.updateUserById()` enforces it. Every account this project creates goes through `createUser` — including `register_trial`, the public signup form and the single most important password in the app. **Enabling the toggle does nothing for signup.** It does genuinely cover `ResetPassword.js` (user-facing `/user` endpoint) and `reset_ims_password`/`reset_hr_password` (`updateUserById`).
- **It would have broken `reset_pos_pin` outright — and this half is now OBSOLETE (S688).** That one is `updateUserById` with a 4–6 digit PIN, and every 4-digit string plus effectively every 6-digit numeric is in the Pwned Passwords corpus. The asymmetry makes it confusing rather than obvious: creating a POS staff member keeps working while resetting their PIN fails on *every possible value*.

**That second reason stopped being true one session later and nothing said so (S688).** The pepper (S539) and the deletion of the raw-PIN fallback (S569) mean `admin-user-ops` never hands GoTrue a 4-digit string again — every PIN write goes through `derivePinPassword()` and stores a base64url HMAC, which HIBP will never match. So the toggle can no longer break `reset_pos_pin`, and enabling it adds genuine coverage to `ResetPassword.js` and `reset_ims_password`/`reset_hr_password`. **The first reason still stands** — `adminUserCreate` skips `checkPasswordStrength()`, so the toggle does nothing for signup and the per-path `isPasswordPwned()` calls remain the only thing covering account creation. Left as the owner's decision, not flipped; what is on record here is that the blocker is gone.

Worth generalising: **a fix that removes a constraint does not go back and update the decisions that were made because of it.** S538's reasoning was correct when written and half-obsolete within a session, with nothing to flag it. When the Security Advisor re-raises a warning you have already dismissed, re-read the *rationale* rather than re-dismissing from the note.

**PINs are no longer auth passwords.** `supabase/functions/_shared/pinPassword.ts` derives the stored password as `HMAC-SHA256(PIN_PEPPER, "<email>:<pin>")`, base64url. The account's own generated `pos_email`/`hr_self_service_email` is the salt (both the create side and the login side have it); `PIN_PEPPER` is an Edge Function secret. This also closes a hole `pos-staff-login`'s own header had already described and that S531/S532 did not fix: because the PIN *was* the password, anyone with an account's email could brute-force GoTrue's `/token` endpoint directly with the anon key, where our lockout RPCs are simply not on the path — hiding `pos_email` (`20260810180000`) raised the cost of starting but changed nothing about the mechanism. With a pepper the password is no longer computable off-server, so that route stops existing and **every** path to a POS/Self-Service session runs through the Edge Function that enforces the lockout.

**Every `createUser` password path carries its own `isPasswordPwned()` call** — `register_trial`, `create_ims_staff`, `create_hr_staff` — precisely because the toggle can't reach them. Skipping the two staff ones would leave a feature disagreeing with itself: their `reset_*_password` counterparts go through `updateUserById` and *are* screened, so a breached password would be settable at creation and refused on reset. All three fail open on a null result, logged, so a HIBP outage never blocks account creation.

**The pepper lives in the database, not in an Edge Function secret, and it *is* rotatable (S539).** It is a column on the admin-only `app_secrets` singleton (`20260812110000`), generated by Postgres itself — no `supabase secrets set`, nothing to copy into a password manager, covered by the normal Supabase backups. The first draft used an env var and warned that it was neither recoverable nor rotatable (PINs were stored nowhere, so losing it meant hand-resetting every POS and Self-Service account across every client); that was true and unacceptable, and `staff_pin_vault` is what fixes it — see the PIN vault section below. A `PIN_PEPPER` env var still **overrides** the DB value if set, purely so an environment already running the env-based build keeps deriving the same passwords; the intended end state is not to set it at all. `derivePinPassword()` **throws** when no pepper can be resolved from either source rather than falling back to the raw PIN; that is fail-closed on purpose, unlike the lockout RPCs' documented fail-open stance, because a silent fallback would write a brute-forceable password to a real account and look perfectly healthy doing it.

**`getAppSecrets()` caches for 60 seconds, and that TTL is load-bearing.** Each warm Edge Function instance holds its own copy, so caching forever would leave `pos-staff-login`/`hr-selfservice-login` deriving with the old pepper after a rotation until they happened to recycle — breaking logins for an unbounded stretch. 60s bounds it to a minute. Don't raise it without re-reading that.

**The raw-PIN lazy-upgrade fallback is GONE (S569, 2026-08-18).** Both login functions used to try the derived password and fall back to the raw PIN, upgrading the account on success — a deliberate migration window that left direct brute-force open for any account that hadn't signed in since the pepper deploy. On 2026-08-18 a live vault-coverage check (`profiles` with `pos_email`/`hr_self_service` left-joined against `staff_pin_vault`) reached zero stragglers — the last three were cleared by one real login (RONISH), one till login (SARITA, the test POS account), and deleting a defunct test Self-Service account (Huang, Bhatti Choila) outright — and the fallback blocks were deleted from both functions and deployed. **Every PIN account now authenticates against the peppered derivation only**; an account somehow still carrying a raw-PIN password (there should be none) would simply fail login and needs a Reset PIN (POS) or re-enroll (Self-Service — there is still no `reset_hr_pin` action; since S748 `create_hr_self_service_login` refuses an employee who already has a login, so re-enrolling is Remove then Enable). Don't reintroduce a raw-PIN sign-in path; it reopens the off-server brute-force route the pepper exists to close.

**Deploy order:** apply `20260812110000` (which creates `app_secrets` and generates the pepper) **first**, then deploy all three functions (`admin-user-ops`, `pos-staff-login`, `hr-selfservice-login`), and only then consider the dashboard toggle. Deploying before the migration exists makes every PIN login throw — `getAppSecrets()` has no pepper to resolve and fails closed.

### The PIN vault: staff PINs are recoverable by the platform admin, on purpose (S539)

`staff_pin_vault` (`20260812110000`) stores every POS / HR Self-Service / IMS count PIN encrypted with AES-GCM under `app_secrets.pin_vault_key`, admin-only at the RLS level. **Its primary purpose is disaster recovery, not lookup**: with plaintext PINs recoverable, a lost or rotated pepper becomes `admin-user-ops`' `rederive_pin_passwords` action (walk the vault, re-derive, `updateUserById` each) instead of a mass manual reset. That is the *only* reason the pepper is now rotatable.

**This is a deliberate weakening and should be described as one.** PINs stop being one-way; a compromised admin session now yields every staff PIN where before it yielded only the ability to reset them. Accepted because these are employer-assigned 4–6 digit till codes the assigning manager already types themselves (`PosStaff.jsx` has always been a plain input, never a generator), mitigated by admin-only RLS, AES-GCM at rest under a separate key, and an `audit_logs` row per reveal that records who looked at which account and never the PIN itself. **Scope is PINs only** — `create_ims_staff`/`create_hr_staff` passwords are user-chosen, 8+ chars and very likely reused elsewhere, so they stay one-way and must never be added to this vault.

Three things worth knowing before touching it:

- **A new PIN KIND is four lists, and three of them fail silently (S737).** `ims_count` was the third, and adding a fourth means: the `kind` CHECK on `staff_pin_vault`; `rederive_pin_passwords`' salt lookup — a wrong salt mints a password no login can ever reproduce, so it is a `SALT_COLUMN` map now and an unknown kind FAILS rather than defaulting to the other branch of a ternary; `restore_staff_accounts`' branch **together with** the account's email column in `exportClientData.js`'s roster select, since a kind present in one and not the other reports a fully restorable account as unrecoverable; and `log_audit()`'s `profiles` noise-skip array, or every wrong PIN writes a zero-content row into `audit_logs`. Only the first of those four raises anything.
- **Vault writes are best-effort and must stay that way.** `vaultPin()` in `admin-user-ops` logs and continues on failure. The account is fully valid without a vault row — the PIN works, login works, only admin recovery is unavailable — so failing a staff creation over a vault error would trade a recovery convenience for an outage on a live restaurant floor.
- **The login functions' legacy-PIN branch is the only place a pre-existing account's plaintext PIN is ever observable**, so it doubles as the backfill: it writes the vault row alongside the password upgrade. Accounts that never sign in and are never reset simply stay unrecoverable, which `rederive_pin_passwords` reports (`unrecoverable` count) rather than hides.
- **Viewing is platform-admin only** (`view_staff_pin` gates on `isCallerAdmin`), surfaced in Admin → Clients → Staff PINs, deliberately *not* on `PosStaff.jsx` where Owners and POS managers would see it. A forgotten PIN is still the Owner's one-click Reset PIN. Widening the gate is one line, but it exposes every PIN to every client login.

### A key per POS tablet, and the shared key retired by hand (S754)

Migration `20260916120000` and `pos-staff-login` were applied and deployed live on 2026-09-14. **Until S754 every till of a client held one value, `client_secrets.pos_device_secret`,
copied into the localStorage of every tablet ever activated.** A lost, sold or stolen tablet could
only be cut off by rotating the key for the whole floor. Nothing recorded which tablets held it or
when one was last used.

- **`pos_devices` is one row per tablet and holds only `secret_hash`**, which is plain SHA-256.
  There is deliberately no pepper: the secret is 244 bits of CSPRNG output, so its hash cannot be
  guessed the way a 4–6 digit PIN's can. `register_pos_device(p_client_id, p_name)` returns the raw
  secret exactly once, straight into localStorage (`pos_device_id` + `pos_device_secret`).
  `list_pos_devices` returns metadata only, and `revoke_pos_device` retires one tablet.
  `pos_device_caller_may_manage` limits all three to admin, the Owner or a POS manager of that
  outlet whose login is not settlement-blocked.
- **The table has no client grants and therefore no RLS policies** — `client_secrets`' reasoning:
  Postgres has no column-level RLS, so any SELECT an Owner could run would show the hash. RLS is
  still enabled, so a grant added by mistake opens nothing on its own.
- **Not `log_audit()`-audited** (it snapshots whole rows, hash included). The three write functions
  insert their own audit row with the hash removed, using the trigger's vocabulary so the Audit Log
  page renders it.
- **Not exported, not restored.** A backup is a file on someone's disk, and a device credential must
  not come back to life from one. A restored client re-activates each tablet in one tap.
- **The sign-in gate.** `pos-staff-login` calls `verify_pos_device` (a per-tablet key) or
  `verify_pos_legacy_device` (the shared key). Both are service-role only, and each is one UPDATE
  that matches and stamps last use. **It fails CLOSED with a 503**, unlike the lockout RPCs: a read
  error is a refusal, but `PosLogin` reads a 5xx as "couldn't reach the server" and keeps the PIN,
  rather than telling the floor to re-activate the till over a blip. Both refusals return the
  same 401 string, because which half failed is not something to tell a caller holding a dead key.
  The picker is `get_pos_device_staff`, which RAISES on a dead key rather than returning no rows, so
  "revoked" and "no staff" are different screens.

**The shared key is retired explicitly, never automatically when the first tablet registers.** An
outlet with three tills that re-activates one would otherwise lose the other two mid-service.
`pos-staff-login` stamps `pos_legacy_key_last_used_at` on every legacy sign-in, and Till Devices shows
that stamp. A manager presses Switch off once the tablets have moved.
`retire_pos_legacy_device_key` then **rotates** `client_secrets.pos_device_secret` to a value no
tablet holds, so every path still comparing against it stops matching at once. That includes
`get_pos_staff` and a stale `pos-staff-login`, so neither had to be redefined.
`get_pos_device_secret` refuses to hand the key out after that. Deactivating a tablet that has
its own key revokes that key, not just the localStorage copy.

**`pos-staff-login` falls back to the pre-S754 check only on `PGRST202`** (the verify function is
not in the schema cache, i.e. the function deployed ahead of the migration), so a deploy-order slip
does not lock out every tablet already on a floor. Any other error refuses. **When every client has
switched the shared key off, delete the legacy branch, its fallback and `get_pos_staff`'s secret
comparison** (`POS_TODO.md` A2). **Archive, Clear Client Data, Delete Client and the trial purge revoke every
tablet key and rotate/retire the shared key (S755)**. `revokeClientTablets` runs first inside
`deleteClientDataFor`, with the service role, because `revoke_pos_device` and
`retire_pos_legacy_device_key` refuse a caller with no session. The caller is recorded as
`revoked_by`. A restore brings neither back, so each tablet is re-activated from Till Devices.

### Login and sign-up page UX (moved)

Seven login and sign-up page traps (the generic credential error, `pointer: coarse` touch sizing, `.login-page` as its own scrollport, `role="alert"` on errors, the one-screen fit, contrast-script traps, and page-not-card layout): `.claude/rules/login-pages.md` (auto-loads for `Login`, `Signup` and `ResetPassword`).
