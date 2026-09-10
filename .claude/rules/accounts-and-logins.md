---
paths:
  - "src/context/AuthContext.js"
  - "src/pages/Login.js"
  - "src/pages/Signup.js"
  - "src/pages/adminClients/**"
  - "src/modules/hr/employees/**"
  - "src/modules/hr/selfservice/**"
  - "src/modules/pos/staff/**"
  - "src/modules/ims/staff/**"
---

# Who logs in where, and how an Owner account comes to exist

> Moved out of the root CLAUDE.md (2026-08-27 /doctor pass) so it loads only when working on
> these files. Root CLAUDE.md keeps the universal invariants.

### Who logs in where, and how an Owner account comes to exist

Asked directly (S554) and answerable only by reading three files, so it belongs here. **There are three front doors, and a client owner uses exactly one of them.**

| Door | Route | Credential | Who |
| --- | --- | --- | --- |
| Main | `/login` | email + password | Owner, **IMS staff, HR staff**, Crest admin |
| POS | `/pos/login` | 4–6 digit PIN on a device-bound picker | POS till staff |
| Self-Service | `/hr/self-service` | 4–6 digit PIN | Employees checking payslips/leave/roster |

IMS and HR staff share the owner's front door and are separated by role, not by entrance — which is what IMS Staff's own subtitle ("Staff log in with their email and password, same as you do") means. Only POS and Self-Service have their own PIN entrances, and **an owner never uses a PIN.**

An Owner account is created by one of two paths, and they produce a byte-identical profile: `register_trial` (the public trial form on `/signup`, split out of `/login` in S689 — creates the `clients` row, the auth user and a `profiles` row of `role:'client'` + `client_id`, then signs them straight in), or Admin → Clients → Manage → Users, which calls the generic `createUser` action and upserts the same `{ id, client_id, full_name, role:'client' }` (`ClientDrawer.js`). Nothing anywhere writes an "owner" flag, because there isn't one.

**That is the trap worth stating plainly: Owner is the ABSENCE of staff markers, so giving the owner's own login a staff role demotes them.** `isOwner` is `role==='client'` with none of `pos_role`/`ims_role`/`hr_role`/`hr_self_service` set, which is what makes an owner resolve to `'manager'` on all three rank axes for free. Assign that same login an IMS role from `/ims-staff` and the negative test flips: they lose Owner-level access — Suite features included — and get only what that rank permits. The owner should never appear in a staff list; those rows are for staff. (Same mechanism as the `isOwner`/`isCallerOwner`/`is_client_owner()` triplet in `CLAUDE.md`'s four privilege invariants — a new marker column must be added to all three.)

What an owner sees after signing in is then four independent things: the module flags (sidebar sections + route access), `clients.plan` (which IMS tier features), `clients.suite_plan` (the owner-altitude features behind `SuiteGate`), and `getAccessState` (a lapsed subscription shows `SubscriptionLock` instead of the app). A multi-outlet owner switches outlets from the top bar (from the drawer's client badge below 768px). A locked-out owner self-serves via "Forgot password?" on the login card; failing that, admin can reset it — `requireStaffTarget` deliberately exempts admin callers so that stays possible.

**Deactivating an HR employee does not, by itself, revoke their Self-Service login — S561 tried gating on `status` and had to be reverted the same day.** `hr_employees.status` and `profiles.hr_self_service` are two unrelated columns, so an employee marked Inactive keeps full PIN-login access (payslips, leave, roster) indefinitely — that part of S561's diagnosis was correct. But the fix it shipped (`hr-selfservice-login` refusing login when the linked `hr_employees.status === 'inactive'`) collided head-on with `status` already meaning something else load-bearing: `PayrollRun.jsx`/`PayrollCalculation.jsx`/`FinalSettlement.jsx` all query employees via `.in('status', ['active','probation'])`, so the same act that blocks login also drops the employee from every payroll picker — exactly backwards for the real case (an employee who just resigned and still needs their final payslip run). Reverted same-day. **`status` must stay a single-purpose payroll-eligibility field.**

**S563 shipped the real fix: `hr_employees.access_blocked`, a boolean fully independent of `status` (migration `20260815100000`).** Employees now has a checkbox column (header select-all + per row) and a bulk action bar — Deactivate blocks Self-Service login, Activate restores it — that writes `access_blocked` alone via `scopedUpdate`, never `status`. `hr-selfservice-login` embeds `hr_employees(access_blocked)` via `profiles.hr_employee_id` and refuses with the same generic "Invalid credentials" every other rejection path returns. Because `status` is never touched, blocking/unblocking login can never again remove someone from a payroll picker. **The migration must be applied by hand in the Supabase SQL Editor before this works** — this machine has no DB credentials to run it directly; until it's applied, the Edge Function's embedded select on a nonexistent column will fail every Self-Service login, not just blocked ones. Verify the column exists before relying on this.

**Deactivate had no inverse (fixed S562).** `EmployeeForm.jsx`'s footer only ever rendered a Deactivate button (`employee.status === 'active'`) — once flipped to Inactive, the Edit form offered no way back to Active short of Delete-and-re-add, which loses the employee's history. Added a mirrored `handleActivate()` and a green Activate button rendered when `employee.status === 'inactive'`. Note this `status` Deactivate/Activate pair is orthogonal to S563's `access_blocked` Deactivate/Activate pair above — same words, two different columns, two different pages (Edit form vs. Employees list bulk bar).

## Session, profile reads and the HR/POS employee link

Migrated from the root `CLAUDE.md` (S663) — these are reachable from `AuthContext` and the staff screens this file already scopes to.

- **`onAuthStateChange` always fires `INITIAL_SESSION` on subscribe — don't also fetch the profile yourself without gating on event type (S463).** `AuthContext.js`'s effect used to call its own `initialize()` (`getSession()` + `fetchProfile()`) *and* subscribe via `supabase.auth.onAuthStateChange(callback)`, with the callback re-running `fetchProfile()` for every event unconditionally. Checked against the installed `@supabase/auth-js` source (`GoTrueClient.ts`'s `_emitInitialSession`, scheduled in an IIFE the moment you subscribe): `onAuthStateChange` **always** replays the current session as an `INITIAL_SESSION` event, in production exactly as in dev — not a React StrictMode artifact (checked; `index.js` does wrap the app in `StrictMode`, which was a real candidate before ruling it out). So `initialize()` and the callback's `INITIAL_SESSION` replay both independently ran the full `profiles` → `Promise.all(clients, feature_flags)` → `last_seen_at` `PATCH` waterfall on **every single page load** — confirmed live via the network tab (`profiles` ×2, `clients` ×2, `feature_flags` ×3, `PATCH` ×2 on one dashboard load). `TOKEN_REFRESHED` compounded it further: `startSessionKeepAlive` (S458) calls `ensureFreshSession()` on every tab `focus`/`visibilitychange`/`online`, not just once an hour, so the same redundant waterfall was also re-running on ordinary alt-tabbing throughout a session — this, not any one slow query, was the real cause of "pages load slowly, sometimes get stuck." Fixed by returning early on `event === 'INITIAL_SESSION' || event === 'TOKEN_REFRESHED'` **after** `setSession(session)` already ran (so context consumers still see a refreshed token) but **before** `fetchProfile()` — nothing about who the user is changes on either event. Re-verified live: `profiles`/`clients`/`PATCH` each fire exactly once now. A second `feature_flags` read remains — that's `SettingsContext`'s own independent fetch, a separate provider, not part of this bug.
- `profiles` itself is the one table that does **not** follow the standard same-client pattern above — `profiles_select` RLS is self-or-admin only (`id = auth.uid() OR is_admin()`). A raw `supabase.from('profiles').eq('client_id', ...)` query, run by a real (non-admin) client login, silently returns nothing but the caller's own row. To resolve another staff member's name (closed_by/comped_by/sent_by/etc.), call the `get_client_profile_names(p_client_id)` RPC (all profiles for that client) or `get_pos_staff_list(p_client_id)` (PIN-based POS staff only, excludes the Owner — used by Staff Management specifically). Never a raw `profiles` query for anyone but the caller's own row.
- **`profiles.hr_employee_id`** links a login to an `hr_employees` record — originally written only by HR Self-Service (`create_hr_self_service_login`), and as of S328 also optionally written by `create_pos_staff` (POS Staff's "+ Add Staff" → HR Employee mode) so a client running both HR and POS doesn't have to enter the same person twice under two different names. A partial unique index (`profiles_hr_employee_pos_unique` on `hr_employee_id WHERE pos_email IS NOT NULL`) plus an Edge Function check stop the same employee from getting two POS accounts; nothing stops one employee from separately having both a POS account and an HR Self-Service account, since those are different login mechanisms for the same person.

## Staff role systems (POS / IMS / HR)

Migrated from the root `CLAUDE.md` (S663).

Three independent rank axes on `profiles` — `pos_role`, `ims_role`, `hr_role` (each `staff|supervisor|manager`, `NULL` = no access to that module at all) — checked via `hasPosAccess(minLevel)` / `hasImsAccess(minLevel)` / `hasHrAccess(minLevel)` in `AuthContext.js` (`POS_RANK`/`IMS_RANK`/`HR_RANK`, identical `{staff:1,supervisor:2,manager:3}` shape, deliberately mirrored — IMS copied POS's shape at S417, HR copied IMS's at S430). A staff account having one of these set implies nothing about the other two — a POS PIN account with no `ims_role` is correctly blocked from every IMS page. Admin/Owner always resolve to `'manager'` on all three — **which makes the resolved ranks (`posRole`/`imsRole`/`hrRole` from `useAuth()`) the WRONG test for "is this a staff/till session"**: gate any staff-only behaviour on the raw `profile.pos_role` (etc.) column, never the rank. Layout.js's `isPinStaff` exists because gating the POS idle lock on the rank signed every admin/Owner out after 3 idle minutes on any machine that had ever completed POS device binding (S583, reported as a session mystery). `isOwner` is a **negative** test (`role==='client'` with none of `pos_role`/`ims_role`/`hr_role`/`hr_self_service` set) — assigning any one of these to an account deliberately demotes it out of Owner-level access, so a new staff-account marker must be added to every `isOwner`/`isCallerOwner` computation (`AuthContext.js` and `admin-user-ops/index.ts` both) or it silently breaks Owner detection for every other marker.

Each axis gates two things that must both be kept in sync when adding a page: the **route guard** (`if (!hasXAccess(minLevel)) return <Navigate to="/dashboard" replace />` inside the page component itself) and **nav visibility** (a `minPosRole`/`minImsRole`/`minHrRole` tag on the `Layout.js` nav item, read by the shared `isItemVisible()` predicate that also drives the command palette and pinned favorites). A page with one but not the other is either unreachable-but-still-linked, or reachable-but-hidden — a dashboard/summary page that's the redirect *target* of a guard is the easiest place to miss this, since it's tempting to assume the redirect target is inherently safe (see S430's dashboard leak in `CHANGELOG/S400-S449.md`, where the redirect target itself leaked the data every other page was gated to protect).

`pos_team` (`foh|kitchen|bar`, default `foh`, added S431) is a separate, **orthogonal** axis on `profiles` — which physical station a POS account works, independent of `pos_role`'s rank (a kitchen-team account can be Staff or Manager rank; the team axis only changes what's in its nav, not what its rank permits). Gated by an explicit allowlist (`Layout.js`'s `KITCHEN_TEAM_ALLOWED_PATHS`) rather than per-item tags — fail-closed, so a newly-added POS page is hidden from kitchen/bar by default until someone deliberately adds it to the list. `KitchenDisplay.jsx` additionally uses it to lock the KOT/BOT ticket-station toggle (not the same "station" concept — `pos_kot_log.station` is the ticket's printer routing, unrelated to the staff `pos_team` column) to the account's own queue.

`pos_discount_limit` (nullable numeric %, `NULL` = unlimited) and `pos_allow_void` (boolean, default `false`, added S517) are two more per-staff overrides on `profiles`, same family as `pos_team` — a manager sets them per staff member on `/pos/staff` (POS Staff), and both are enforced in `PosOrders.jsx` against `profile.pos_discount_limit`/`pos_allow_void` from `useAuth()` (never against rank alone — a Supervisor isn't automatically capped/voidable, only whoever has the flag set). **`admin-user-ops`'s `update_pos_role` action must build every field it writes conditionally** (`if (x !== undefined) updatePayload.x = x`), never unconditionally as `x || null` — `updateTeam`/`updateDiscountLimit`/`updateAllowVoid` each call this one action with only their own single field in the request body, so any field written unconditionally gets silently reset to its default on every other field's update. This bit `pos_role` itself: it was unconditional from the start (only `pos_team` got the conditional treatment when added at S431), so setting a staff member's Discount Limit or Allow Void was silently wiping their role to "No Access" — found live smoke-testing S517 against a real staff account, fixed by making `pos_role`/`pos_job_title` conditional too. Any future field added to this same staff-permission family must follow the conditional pattern from the start, not retrofit it after the same bug repeats.

## The staff pages: what a module manager may and may not do (S729)

Found re-analysing `ImsStaff.jsx`; the rules hold for `HrStaff.jsx` and `PosStaff.jsx` too.

- **A list RPC that returns login emails is rank-gated to whoever can ACT on the list.**
  `get_ims_staff_list` / `get_hr_role_staff_list` require admin, the Owner, or a manager of that
  module (`20260910120000`). They had gated on same-client alone — the shape S531 closed on the
  eligible-users pair and left on the sibling that returns every staff email. `get_pos_staff_list`
  returns no email (PIN accounts have a synthetic one) and stays same-client. **The page's own
  `hasImsAccess('manager')` redirect is not a guard on the RPC**: `useEffect` fires before the
  `Navigate` renders, and a direct call needs no page.
- **A manager never acts on a peer manager, and never on their own row.** `requireManageableTarget()`
  in `admin-user-ops` runs after `requireStaffTarget()` on every role change, delete and password
  reset (own password excepted). Before it, "Managers can only be deleted by admin" was two
  requests long — clear the role, then delete — and a manager could reset a peer's password and
  sign in as them. **The Owner is exempt alongside admin.** A new staff-management action takes
  both helpers, in that order.
- **Converting a marker-less login into staff must refuse the LAST one.** Owner is the absence of
  markers, so "Existing User" mode on a client's only plain login leaves no Owner at all.
  `isLastOwnerLogin()` guards `update_ims_role` and `update_hr_role`; a failed count counts as last.
- **The custom-role scheme seeds from the defaults and refuses to strand a login.** `effectiveRoles`
  is "custom if any, else defaults", so the first custom role used to REPLACE Staff / Supervisor /
  Manager while every login still held one — the row's `<select>` rendered blank beside a badge
  reading Supervisor. Now: the first custom role is added beside the defaults; a role that logins
  hold cannot be removed; Reset refuses while a custom title is held; a title outside the scheme
  renders as its own option with an amber orphan mark, never as the first role sharing its level.
  **Still open on HrStaff and PosStaff.**
- **Help copy that tells the Owner to give their own login a role is teaching the demotion trap.**
  The IMS Staff tip said exactly that for 300 sessions. The Owner's login already has every page;
  the person taking over gets a Manager login of their own.
- **Audit rows from `admin-user-ops` carry no actor.** `log_audit()` reads `auth.uid()`, which is
  null under the service role, so a role grant or password reset is recorded but not by whom — on
  all three staff pages. Known, unfixed.
