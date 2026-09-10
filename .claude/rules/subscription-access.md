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
- **`AdminClients.js`'s auto-deactivation sweep IS `getAccessState(c).reason === 'expired'`, not a copy of it (S736).** It flips `is_active = false` for clients whose dates have all passed, and it runs on every visit to Admin → Clients. Since `is_active = false` is an *immediate* lock, sweeping at the raw expiry date silently defeated the grace period — a client would be cut off early because an admin happened to open a page (S544 fixed that with a hand-computed `now − GRACE_DAYS` cutoff). S736 removed the copy altogether: the sweep carried its own date resolution (module dates first, the legacy `subscription_ends_at` only when no module date existed) and it disagreed with the lock screen at the edges — a legacy end date outliving the module dates was ignored by the sweep and honoured by the lock, and the cutoff was a calendar day stricter than the grace the banner counted down. `reason === 'expired'` is exactly the sweep's predicate, already excludes trials (they return `'trial'`/`'pending'`), and fails open on no dates. The manual Deactivate button is deliberately unaffected, but **it now asks first** — it is the one control on the page that locks a live property instantly, and it sat beside Features with nothing between the click and the lock while Archive required the typed name.
- **The Suite add-on honours its own date, through `suiteLive(client)` (S736).** `suite_ends_at` had driven the ★ SUITE pill and the MRR figure since S552 while `SuiteGate` and the nav's PRO chip read `suite_plan` alone — so a lapsed Suite read "Not billing" on Admin → Clients with every Suite page still open, and the drawer's tooltip said the date gated them. `AuthContext.suitePlan` now resolves to `null` once the date is `GRACE_DAYS` past, using the same `suite_ends_at → IMS window` fallback `clientMrr.js` uses, and fails open with no date at all. Two consumers, one predicate: do not re-derive it in a gate.
- **There is now a THIRD gate on the same line (S672).** `ProtectedRoute` renders
  `LegalReacceptance` immediately after `accessLocked`, for a client Owner with an outstanding
  Terms/Privacy version. Same reasoning as this one — one choke point, never per-page — and it
  also fails open. See `.claude/rules/legal-documents.md`.
- **A fifth state sits BEFORE the trial-expiry branch: `pending` (S697).** A self-service signup
  is created with `trial_approved_at = NULL` and opens on the day an admin presses **Approve** in
  Admin → Clients' Trial Accounts panel. `getAccessState` returns `reason: 'pending'` for
  `is_trial && !trial_approved_at`, and `SubscriptionLock` shows the "we will call you" copy —
  accent tone, phone icon, no subscribe button, no retention talk, because the person reading it
  is almost always a real owner who just signed up. It is checked before expiry on purpose: the
  dates `register_trial` writes at signup are PROVISIONAL (they exist so an abandoned signup still
  ages into the purge job), and `approveTrial` rewrites all four so the 7 days start at approval.
  Two things must keep the stamp: the admin "+ New Client" form (hand-onboarded, approved by
  definition) and migration `20260908130000`'s backfill of every pre-existing trial. `trialPending`
  from `AuthContext` is what keeps the day-one trial banner quiet until the trial has started.
  The trial itself is **Growth with IMS, HR and POS all on** — safe to hand out only because
  nobody sees it until approved, which is why the approval gate and the richer trial shipped as
  one change and must not be separated.
- **This is a UI gate, not a security boundary.** RLS still lets a locked client's JWT read and write its own rows. Real enforcement would mean an expiry check inside the RESTRICTIVE policy families on ~50 tables. Also note **two doors stay open** after the lock: HR Self-Service (`/hr/self-service` is mounted *outside* `ProtectedRoute`) and the public guest-menu ordering route (`get_guest_menu` gates on `pos_enabled` only).
