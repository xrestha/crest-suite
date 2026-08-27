---
paths:
  - "src/contexts/AuthContext.js"
  - "src/pages/Login.js"
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

An Owner account is created by one of two paths, and they produce a byte-identical profile: `register_trial` (the public trial form on `/login` — creates the `clients` row, the auth user and a `profiles` row of `role:'client'` + `client_id`, then signs them straight in), or Admin → Clients → Manage → Users, which calls the generic `createUser` action and upserts the same `{ id, client_id, full_name, role:'client' }` (`ClientDrawer.js`). Nothing anywhere writes an "owner" flag, because there isn't one.

**That is the trap worth stating plainly: Owner is the ABSENCE of staff markers, so giving the owner's own login a staff role demotes them.** `isOwner` is `role==='client'` with none of `pos_role`/`ims_role`/`hr_role`/`hr_self_service` set, which is what makes an owner resolve to `'manager'` on all three rank axes for free. Assign that same login an IMS role from `/ims-staff` and the negative test flips: they lose Owner-level access — Suite features included — and get only what that rank permits. The owner should never appear in a staff list; those rows are for staff. (Same mechanism as the `isOwner`/`isCallerOwner`/`is_client_owner()` triplet in `CLAUDE.md`'s four privilege invariants — a new marker column must be added to all three.)

What an owner sees after signing in is then four independent things: the module flags (sidebar sections + route access), `clients.plan` (which IMS tier features), `clients.suite_plan` (the owner-altitude features behind `SuiteGate`), and `getAccessState` (a lapsed subscription shows `SubscriptionLock` instead of the app). A multi-outlet owner switches outlets from the sidebar. A locked-out owner self-serves via "Forgot password?" on the login card; failing that, admin can reset it — `requireStaffTarget` deliberately exempts admin callers so that stays possible.

**Deactivating an HR employee does not, by itself, revoke their Self-Service login — S561 tried gating on `status` and had to be reverted the same day.** `hr_employees.status` and `profiles.hr_self_service` are two unrelated columns, so an employee marked Inactive keeps full PIN-login access (payslips, leave, roster) indefinitely — that part of S561's diagnosis was correct. But the fix it shipped (`hr-selfservice-login` refusing login when the linked `hr_employees.status === 'inactive'`) collided head-on with `status` already meaning something else load-bearing: `PayrollRun.jsx`/`PayrollCalculation.jsx`/`FinalSettlement.jsx` all query employees via `.in('status', ['active','probation'])`, so the same act that blocks login also drops the employee from every payroll picker — exactly backwards for the real case (an employee who just resigned and still needs their final payslip run). Reverted same-day. **`status` must stay a single-purpose payroll-eligibility field.**

**S563 shipped the real fix: `hr_employees.access_blocked`, a boolean fully independent of `status` (migration `20260815100000`).** Employees now has a checkbox column (header select-all + per row) and a bulk action bar — Deactivate blocks Self-Service login, Activate restores it — that writes `access_blocked` alone via `scopedUpdate`, never `status`. `hr-selfservice-login` embeds `hr_employees(access_blocked)` via `profiles.hr_employee_id` and refuses with the same generic "Invalid credentials" every other rejection path returns. Because `status` is never touched, blocking/unblocking login can never again remove someone from a payroll picker. **The migration must be applied by hand in the Supabase SQL Editor before this works** — this machine has no DB credentials to run it directly; until it's applied, the Edge Function's embedded select on a nonexistent column will fail every Self-Service login, not just blocked ones. Verify the column exists before relying on this.

**Deactivate had no inverse (fixed S562).** `EmployeeForm.jsx`'s footer only ever rendered a Deactivate button (`employee.status === 'active'`) — once flipped to Inactive, the Edit form offered no way back to Active short of Delete-and-re-add, which loses the employee's history. Added a mirrored `handleActivate()` and a green Activate button rendered when `employee.status === 'inactive'`. Note this `status` Deactivate/Activate pair is orthogonal to S563's `access_blocked` Deactivate/Activate pair above — same words, two different columns, two different pages (Edit form vs. Employees list bulk bar).
