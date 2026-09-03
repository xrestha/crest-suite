---
paths:
  - "src/shared/supportContact.js"
  - "src/shared/supportContact.test.js"
  - "src/shared/supportAddress.test.js"
  - "src/shared/hooks/useSupportContact.js"
  - "src/shared/appVersion.js"
  - "src/shared/appVersion.test.js"
  - "src/components/SupportContactLine.jsx"
  - "src/components/AppErrorBoundary.jsx"
  - "src/components/AppErrorBoundary.test.jsx"
  - "src/pages/Login.js"
  - "src/pages/Legal.jsx"
  - "src/components/SubscriptionLock.js"
  - "src/components/PremiumGate.js"
  - "src/pages/Help.js"
  - "public/service-worker.js"
---

# A support contact that exists on the screens where the app is broken (S673)

Built from an outside-authored spec (`crest-suite-support-button-spec.md`) whose implementation
plan assumed a schema that does not exist here — `shared_tenants`, a `shared_` prefix, Supabase
Realtime routing (used nowhere in this codebase; every near-real-time surface is `setInterval`
polling). This session shipped only Part B.6 — contact details plus a crash boundary — not the
ticket table, the operator alert, or the admin inbox. See "Later" below for what's deferred and
where the groundwork for it already sits.

## One phone number, one definition, ships unfilled

`src/shared/supportContact.js` is the only place Crest's own support phone, hours and email exist.
`SUPPORT_EMAIL` re-exports `COMPANY.supportEmail` from `src/legal/index.js` rather than copying it —
that file's own comment explains why three copies of a contact fact is how two of them end up
disagreeing.

The phone ships as `'[[NEEDS VALUE: SUPPORT_PHONE]]'`, the same draft-marker convention
`isDraft()` uses for the legal documents. **`supportPhone()` returns `null` while it stands, and
every consumer hides the phone rather than ever rendering the placeholder** — `SupportContactLine`
simply omits the Call/WhatsApp entry when `telHref`/`whatsappHref` are null. To activate it: edit
`SUPPORT_PHONE_RAW` in `supportContact.js` to the real digits. No other file needs to change.

**Don't reach for `SUPPORT_PHONE_RAW` directly anywhere else** — it is module-private on purpose,
referenced only inside `supportPhone()`'s own guard. Every call site goes through `supportPhone()`
or `useSupportContact()`, so the "hide while unfilled" rule can never be bypassed by a shortcut.

## `useSupportContact()` — the constant-is-the-floor merge

`settings.contact_phone`/`contact_email` (Settings → Contact, admin-only, per client — labelled
"Upgrade Contact Details") win wherever an admin has actually set them, routing that client to
their own consultant. Crest's own line fills in otherwise. Before this, `SubscriptionLock`,
`PremiumGate` and `Help` each read `settings.contact_phone` raw and fell through to nothing (or a
bare "Contact your Crest consultant to upgrade" with no way to actually do that) whenever the field
was blank — which is its default. Any new surface needing a support contact should call the hook,
not read `settings.contact_*` directly.

`website` has no platform-wide fallback — there is no Crest marketing site to point at — so it
stays whatever the per-client field holds, possibly empty.

## `SupportContactLine` — three variants, one component

`inline` (one text line, · separated — the login footer, the two offline banners), `buttons`
(`btn btn-ghost` Call/WhatsApp/Email — the crash page, `SubscriptionLock`, `PremiumGate`), `block`
(labelled rows plus the hours line — Help's Support tab). Reach for one of these before hand-rolling
a contact row a fourth time.

**The `buttons` variant labels the email link "Email us", not the raw address.** A test asserting
"the fallback contains the support email" has to check the link's `href`, not its visible text —
this cost a round writing `AppErrorBoundary.test.jsx`.

## `AppErrorBoundary` — what it catches, and what it structurally cannot

There was no error boundary anywhere in this codebase before this file. A throw in any lazy route
used to propagate past both `Suspense` boundaries (Suspense catches promises, not errors) straight
to the React root, which unmounted the whole tree to a blank page with nothing reported anywhere.

Two instances, and the split is deliberate:

- **App scope** (`App.js`, wrapping `ThemeProvider`) — catches a crash in the providers themselves.
  Because theme CSS variables are set imperatively by `ThemeContext.js` and won't exist if
  `ThemeProvider` is what crashed, this fallback's colours are **literal `PRESETS.dark` hex values**
  used only as `var(--theme-x, #hex)` fallbacks — not arbitrary near-misses; keep them byte-exact
  with `ThemeContext.js`'s `PRESETS.dark` or the impeccable hook will (correctly) flag them as
  undocumented colours. `ProtectedRoute.js`'s loading screen already does the same thing.
- **Page scope** (`Layout.js`, wrapping only `<Suspense><Outlet /></Suspense>`, **not** the whole
  `<main>`) — the sidebar and header survive a page crash, and `resetKey={location.pathname}`
  clears the error on navigation. Wrapping more of `<main>` would let a `Layout` render error be
  swallowed here instead of falling through to the app-scope boundary.

**What it cannot catch, structurally, not as an oversight**: an error thrown from an event handler
(a button's `onClick`), a rejected promise nothing awaits, anything thrown before React mounts, and
an error thrown by the fallback itself. `ProtectedRoute` renders `SubscriptionLock`/
`LegalReacceptance` **before** `children`, so those two screens are covered by the app-scope
boundary only, never the page-scope one.

**"Copy details" is redacted, not just short.** The clipboard payload strips anything
`pin|password|token|secret|key|bearer`-shaped, JWT-shaped triples, and long base64 runs — a thrown
error's message or stack can carry a query string, and this text is going into WhatsApp or email,
not staying inside the product. Deliberately excludes the user's email and the client name too.

## `APP_VERSION` and `CACHE_NAME` move together

`src/shared/appVersion.js`'s `APP_VERSION` must be bumped in the **same commit** as `CACHE_NAME` in
`public/service-worker.js` — `appVersion.test.js` reads that file off disk and fails if they
disagree, the same pattern `legalHash.test.js` uses for the legal documents. This was chosen over a
`REACT_APP_BUILD` env var (silently empty locally) and over reading `caches.keys()` at runtime
(async, absent in dev, and reports the *cached* version rather than the one actually running).

## Later — the ticket phase this session deliberately did not build

Tickets, the operator alert (Telegram/email/SMS) and the admin inbox from the source spec are not
built. Notes for whoever picks it up:

- **Standing up transactional email costs a Privacy Policy amendment.** `privacy-v1.0.md` states no
  third-party transactional email provider is used and commits to 15 days' notice before a new
  sub-processor handles Customer Data. A ticket-alert email carrying a client name and message makes
  the vendor a sub-processor — budget the re-hash and the notice period into that work, not into
  surprise.
- **No Storage bucket for attachments without re-verifying the S531/hr_employee_photo failure
  mode** — `20260714140000_hr_employee_photo_revert.sql` documents an exhaustive, unresolved 42501
  failure on a new authenticated-INSERT bucket.
- **Follow `trial_signup_attempts`' rate-limit shape** (per-IP then a global circuit-breaker, the
  attempt row written *before* the work, HTTP 429 not a SQL exception) and
  `20260903150000_trial_auto_purge.sql`'s `x-purge-secret`/pg_cron/pg_net pattern for the alert
  function — both are the closest live precedents in this codebase, not `shared_`/Realtime.
