---
paths:
  - "src/utils/subscription.js"
  - "src/components/ProtectedRoute.js"
  - "src/components/SubscriptionLock.js"
  - "src/pages/AdminClients.js"
  - "src/pages/adminClients/**"
  - "src/components/Layout.js"
---

# Subscription access — the third guard, and the one that used to enforce nothing (S544)

`ModuleGate`/`PremiumGate`/`SuiteGate` all answer "which features has this client bought". None of them answers "is this client still paying". Until S544 **nothing did**: `clients.is_active` and every `*_ends_at` column were read only by the admin UI — `is_active` appears in no RLS policy and nowhere in `AuthContext`/`Login`/`ProtectedRoute`, so a client marked Inactive, or lapsed years ago, kept full access forever. The Activate/Deactivate button was a badge colour.

`getAccessState(client)` in `src/utils/subscription.js` is now the single place that decision is made, sharing the "farthest end date across all modules" logic with `getSubStatus`. It is consumed as `accessLocked`/`accessReason`/`graceDaysLeft` from `AuthContext`, and enforced in **`ProtectedRoute`** — the one choke point every in-app route (IMS, HR, POS alike) passes through via `<ProtectedRoute><Layout /></ProtectedRoute>` in `App.js`. A locked client sees `SubscriptionLock.js` in place of the app. **Do not add this check per-page**: a per-page guard reopens the whole product the first time someone adds a route and forgets it, which is precisely how `is_active` came to mean nothing.

Four rules, each of which cost something to learn:

- **It fails OPEN.** A client with no end date on any module has never been given one — most of the existing book predates per-module dates — and must keep working. Only a date that exists *and* has passed locks anything.
- **`GRACE_DAYS` (7) exists because a lapsed invoice here is usually a collection delay**, not a decision to leave; cutting a restaurant off at midnight on the due date strands a live service. Expiry shows a countdown banner in `Layout.js` first, then locks. Trials get **no** grace — their expiry date *is* the decision point, and `trial_purge_at`'s retention window is about keeping the data, not access.
- **`AdminClients.js`'s auto-deactivation sweep must honour the same `GRACE_DAYS`.** It flips `is_active = false` for clients whose dates have all passed, and it runs on every visit to Admin → Clients. Since `is_active = false` is an *immediate* lock, sweeping at the raw expiry date silently defeated the grace period — a client would be cut off early because an admin happened to open a page. The sweep now measures against `now − GRACE_DAYS`; the manual Deactivate button is deliberately unaffected.
- **There is now a THIRD gate on the same line (S672).** `ProtectedRoute` renders
  `LegalReacceptance` immediately after `accessLocked`, for a client Owner with an outstanding
  Terms/Privacy version. Same reasoning as this one — one choke point, never per-page — and it
  also fails open. See `.claude/rules/legal-documents.md`.
- **This is a UI gate, not a security boundary.** RLS still lets a locked client's JWT read and write its own rows. Real enforcement would mean an expiry check inside the RESTRICTIVE policy families on ~50 tables. Also note **two doors stay open** after the lock: HR Self-Service (`/hr/self-service` is mounted *outside* `ProtectedRoute`) and the public guest-menu ordering route (`get_guest_menu` gates on `pos_enabled` only).
