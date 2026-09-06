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

## The support contact is DATA the admin edits, and the constants are the floor under it (S683)

`src/shared/supportContact.js` holds the floor: `SUPPORT_EMAIL` (a re-export of
`COMPANY.supportEmail` from `src/legal/index.js`, never a copy — that file's own comment explains
why three copies of a contact fact is how two end up disagreeing), `SUPPORT_HOURS` (general hours
only), and a floor mobile. The LIVE value is `settings.support_contact` — a jsonb column on the
**platform row** (`client_id IS NULL`), edited in **Settings → Support**, upper section.

That row was chosen because it already has exactly the right shape and needed no policy work:
`settings_select` lets every reader including `anon` on `/login` SELECT it, and only `is_admin()`
can UPDATE it. Migration `20260906120000_platform_support_contact.sql` adds the column and
**asserts the `client_id IS NULL` arm is still in `settings_select`** — a future tightening that
dropped it would silently blank six surfaces. The frontend fails soft (`SettingsProvider` keeps
`platformSupport` null on a read error, so the constants render) — applying the migration late
costs the edit screen and nothing else.

**Why it was built.** The phone shipped as `'[[NEEDS VALUE: SUPPORT_PHONE]]'` from S673 to S683 —
three days in which Help → Support promised "outlet-down issues any time" with no line to call —
because the only way to set it was a commit. Every consumer correctly hid the phone rather than
render the marker, which is exactly why nothing looked broken. The floor mobile is now the
founder's own (Bloom Hospitality has no landline yet); the admin screen is where the office line,
a separate WhatsApp/Viber number, or an IT department's contact goes later, with no deploy.

**Fixed channel slots, deliberately not a list** (decided 2026-09-06): `mobile`, `landline`,
`whatsapp`, `viber`, `email`, `website`, plus `hours` and an emergency switch. The crash page and
the offline banners need ONE number on a button, and a fixed shape keeps "which one" a property of
the data. `whatsapp`/`viber` blank → fall back to `mobile`, never to the landline (a landline
cannot take either). **Viber is offered beside WhatsApp** because it is Nepal's household default
for free calls (10M+ users); its deep link is `viber://chat?number=977…` — country code, no `+`,
no leading zero. **Social handles were considered and scratched**: a crashed till does not need a
TikTok link. **`anydesk` is Crest's own AnyDesk ID/alias, and it is never a link.** Remote help on
a Nepali till runs the other way — the client installs AnyDesk and sends Crest *their* 9-digit
address; an `anydesk:<id>` deep link would open a session onto Crest's machine. Crest's alias is
published because AnyDesk shows the requester's alias in the client's accept dialog: it is how a
client refuses an impostor. Help → Support only; a consultant override leaves it in place.

**The emergency promise is a switch, not a sentence.** `emergency_enabled` + `emergency_channel`
name which line is answered outside `hours`; `resolveSupportContact()` returns `emergency` only
while the switch is on AND the named channel has a number. The Help page prints it from the
block variant — the S673 hardcoded `Tip` gloss was removed so it cannot drift from the setting.
It defaults ON with the mobile, mirroring the promise the S673 string had already made, so
filling the row never silently withdraws it.

**Where a client finds it.** The sidebar's bottom rail carries a **Support** button (`LifeBuoy`)
beside Help, landing on `/help?section=support`; `Help.js` reads `?section=` against
`HELP_SECTIONS` and follows it on change, so a link can name the section — before S683 it lived
only in component state, six tabs in, and "where is support?" was the first question asked once
the contact became editable. The Settings → Support form's Mobile field names the built-in floor in
its own placeholder and hint while blank, because the emergency dropdown and the preview show a
resolved number, and a number the reader can see but cannot find a box for reads as "not editable".

**Don't reach for `SUPPORT_PHONE_RAW` directly anywhere else** — it is module-private, read only
inside `supportPhone()`. Every call site goes through `useSupportContact()`, which is now one line
over `resolveSupportContact()`.

## `resolveSupportContact()` — the one merge, three layers, a pure function

Precedence per field: **this client's consultant** (`settings.contact_phone`/`contact_email`/
`contact_website` on the client's own row — Settings → Support, lower section) → **platform row**
→ **constants**. A consultant phone replaces the WHOLE phone family (call, WhatsApp, Viber derive
from it; the Crest landline is dropped) — the point of the override is to route that client to
one person, not to mix that person's mobile with Crest's office line. Hours are always Crest's.
`website` has no constant floor. All of this is asserted in `supportContact.test.js`; a new
surface calls the hook and never re-derives precedence.

**The platform row's `contact_*` columns are NOT a consultant.** The old Contact tab wrote them
onto the `client_id IS NULL` row whenever an admin used it with no client selected, and signed-out
`SettingsProvider` loads that row as `settings` — so passing `settings` straight in as `client`
showed those legacy values on `/login` over the Support tab (found from a screenshot, S683).
`useSupportContact()` passes a row as `client` only when it carries a `client_id`;
`platformSupportFromRow()` folds the legacy columns into the platform contact instead, as a seed
that a saved `support_contact` supersedes.

Two write paths exist because they target different rows: `savePlatformSupport()` always writes
the `client_id IS NULL` row, whichever client the admin is viewing; the consultant fields ride on
the page's ordinary `saveSettings()`. Using `saveSettings()` for the platform contact would write
it onto the viewed client's row, where nothing reads it.

## `SupportContactLine` — three variants, one component

`inline` (one text line, · separated — the login footer, the two offline banners), `buttons`
(`btn btn-ghost` Call/WhatsApp/Email — the crash page, `SubscriptionLock`, and since S683 `ModuleMissingCard` behind `ModuleGate` and `SuiteGate`; `PremiumGate` renders its own labelled rows from the hook), `block`
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
