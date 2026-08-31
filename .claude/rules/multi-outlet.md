---
paths:
  - "src/context/AuthContext.js"
  - "src/pages/dashboard/GroupDashboard.jsx"
  - "src/shared/scopedDb.js"
  - "src/shared/hooks/useScopedDb.js"
  - "src/pages/adminClients/**"
  - "supabase/migrations/**"
---

# Multi-outlet: one login, several clients (S548)

A group of outlets is several `clients` rows joined by `clients.group_id → client_groups`. An Owner switches between them from the sidebar; the Group Console (`/group-dashboard`, Suite Pro) rolls them up.

**The architecture is selected-outlet indirection, NOT policy rewriting.** `my_client_id()` appears in ~151 places across 18 migrations. Rewriting them to a set-returning `my_client_ids()` would touch every policy on ~50 tables and permanently widen RLS from "one client" to "any client in my group", removing RLS as the backstop behind `scopedDb`'s filter. Instead `profiles.active_client_id` was added and **only `my_client_id()` changed**, to `coalesce(active_client_id, client_id)`. Every policy keeps its exact shape and resolves to the selected outlet. The frontend gets it free: `useScopedDb` binds `clientId` from `AuthContext`, so one value re-scopes ~200 call sites and all 65 `CLIENT_SCOPED_TABLES`.

Both columns default NULL, so an ungrouped client is byte-identical to before — which is what makes this safe to have shipped across the whole book at once.

Five things to know before touching it:

- **`active_client_id` is privilege-bearing and must never be user-writable.** It decides which tenant every RLS policy resolves to. It is deliberately NOT on `guard_profiles_privileged_columns()`'s allow-list (S531 invariant #1); `set_active_outlet()` is the only write path, and under `SECURITY DEFINER` `current_user` is the owner so the guard passes it through — the same mechanism `record_pos_pin_attempt` relies on.
- **Membership is validated at WRITE time, not in `my_client_id()`.** That function runs per row across ~120 policies, so it stays a join-free `coalesce`; a trigger on `clients.group_id` clears stale selections instead.
- **`clients_select` is the one policy that had to widen** — it was `id = my_client_id() OR is_admin()`, so a customer could not read that a sibling outlet existed at all.
- **Group-spanning reads cannot go through scoped queries** — that's intended. `get_group_summary()` is `SECURITY DEFINER` with its own caller check, returns **raw aggregates** (the page derives food-cost %/labour %, so this doesn't become a fourth definition of those formulas), filters to `suite_plan = 'pro'` **server-side**, and returns excluded outlets by name so the page can state its coverage. A client-side filter would ship an unpaid outlet's revenue to the browser and then hide it.
- **Outlets keep independent periods** (`monthly_periods` is `UNIQUE(client_id, bs_year, bs_month)`), so align on `(bs_year, bs_month)`, never `period_id`. And **`pos_orders` has no `period_id` or BS columns** — only AD `closed_at` — while BS→AD conversion lives in JS, so the RPC takes `p_ad_start`/`p_ad_end` from the caller.

Suite Pro is sold **per outlet**, including inside a group, which is why the console shows only paid outlets and names the rest rather than silently under-reporting. Switching is blocked while the offline queue is non-empty (**both** `getQueue()` and `getPosOrderQueue()` — stock ops write against the current tenant just as POS orders do).

**Who may switch is `profile_outlet_access`, and it grants REACH, never RANK (S617).** An Owner reaches every outlet in the group; anyone else reaches their home outlet plus what they have been allowlisted into, at the same rank they already hold. Deliberately not a per-outlet role matrix — that would put a second rank rule into `AuthContext`, all three `hasXAccess` helpers and `is_client_owner()`. The table has **no write policy at all**, so `set_outlet_access()` is the only path, and a revoke clears `active_client_id` so it evicts rather than merely denying the next switch.

**HQ→branch master-data push is built** (`push_master_data`, S617), and three of its refusals are the rules, not the implementation. **`items.rate` is never pushed on update** — that is what the BRANCH pays its own supplier and the input to every costing figure it produces, so HQ's rate would put another city's prices into its food cost; it is seeded on create only, because the column is NOT NULL. **Selling price is a separate opt-in**, never swept along with the recipe definition. **An ingredient with no counterpart at the branch is reported, never dropped** — a recipe costed from a silently-shortened list is the wrong-number-nobody-questions shape. Records are matched on `master_id` (`items`/`recipes` have no `UNIQUE(client_id, name)`; only `categories` does), with **one** exception: the first push into a branch that already has data has no `master_id` yet, so it matches by name once, calls it `adopt`, and shows every one in the preview before writing. The preview IS the plan — a dry run computes into a temp table with pure SELECTs and the write pass applies from that same table, because two implementations of "what will happen" is how a preview comes to lie.

**Three defects sat in this feature from S548 until S617 and none were reachable, because no client has ever had a `group_id`.** Worth knowing as a shape: a feature with no users accumulates faults that every review passes over. `set_active_outlet()` and `get_group_summary()` each checked group MEMBERSHIP and called it authorisation, so the Owner-only rule lived only in React; `/group-dashboard` had no role guard at all while the command palette advertised it; and `active_client_id` was read in two places in `AuthContext` and never selected, so switching outlets would have left every scoped query filtering on the home id while RLS resolved to the new one — every client-scoped table returning zero rows with `error: null`.
