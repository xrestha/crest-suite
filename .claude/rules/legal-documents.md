---
paths:
  - "src/legal/**"
  - "src/pages/Legal.jsx"
  - "src/pages/Legal.css"
  - "src/pages/SubscriptionAgreement.jsx"
  - "src/pages/help/LegalTab.jsx"
  - "src/pages/adminClients/ClientLegalTab.jsx"
  - "src/components/LegalReacceptance.jsx"
  - "src/components/ProtectedRoute.js"
  - "scripts/hash-legal.mjs"
  - "supabase/migrations/20260903150000_trial_auto_purge.sql"
---

# Terms, Privacy Policy and the acceptance ledger (S672)

Built 2026-09-03 from an outside-authored spec. The spec's legal TEXTS were good; its
implementation plan was written against an imagined schema (`shared_tenants`, a `shared_` prefix, a
role called `owner`, a pgcrypto hashing trigger, a Storage bucket) and none of those exist here.
What follows is what the code actually does and why it diverges.

## The problem it closed

`Login.js` had told every trial signup *"By starting a trial you agree to our Terms of Service and
Privacy Policy"* since the form was written. The documents did not exist — no route, no file, no
text — the words were **not links**, and nothing recorded that anyone had agreed to anything: no
version, no timestamp, no address, no user agent. The one sentence in the product claiming a
contract existed was the only evidence one might.

## Version, hash and prose ship in the SAME bundle, deliberately

The spec wanted a `legal_documents` table holding the text, with the app reading "current version"
from the database. **That combination is unsafe here**: the service worker is cache-first, so a DB
saying "1.1 is current" against a browser still serving the cached 1.0 chunk would show someone the
old text above a checkbox recording that they accepted the new one.

So there is **no `legal_documents` table**. `src/legal/*.md` is canonical, in git;
`scripts/hash-legal.mjs` computes the SHA-256 and emits `generated/legalMeta.js` (tiny — safe to
import anywhere, and `Login.js` does) and `generated/legalText.js` (~27 kB, reached only through
`loadLegalText()`'s dynamic import). `src/legal/index.js` is the registry.

- **Editing a document means re-running `node scripts/hash-legal.mjs`.** `legalHash.test.js` fails
  if you forget — it recomputes from the markdown *without* importing the generator, because a test
  that verifies a generator by calling the generator only proves it is deterministic.
- **The hash is over LF bytes with the BOM stripped.** It is a promise a third party can check with
  `sha256sum`; if it changed with the checkout platform it would promise nothing.
- **Publishing a new version is a deploy, and requires a `CACHE_NAME` bump**, or existing users keep
  the old text.
- **Hashing is not done in SQL.** pgcrypto lives in the `extensions` schema on Supabase and every
  `SECURITY DEFINER` body here sets `search_path TO 'public'`, so an unqualified `digest()` fails at
  runtime — the same call `20260812110000_pin_vault.sql` already documented avoiding.

## `[[NEEDS VALUE: X]]` is a machine-detected draft marker

A document still carrying one is a DRAFT: `isDraft()` reports it, the public page shows a banner,
the admin Legal tab warns, and the agreement generator refuses to look finished. Part E rule 5 of
the source spec — *a Terms page showing a raw placeholder in public is worse than the passive
sentence it replaced*.

**v1.0 is complete as of 2026-09-03** — registration no., PAN and registered office are filled and
`legalCompany.test.js` asserts no marker survived. The provider's identity now exists in three
places (both `.md` files and the `COMPANY` constant the printed agreement reads from); that
duplication is unavoidable, because the markdown must carry literal text to be hashable, so the
test asserts every `COMPANY` value still appears verbatim in both documents. The failure it guards
is quiet: correct a number in the Terms, re-hash, ship — and tomorrow's signed agreement still
carries the old one, with two documents naming two different companies and nothing failing.

**`legalReadiness()` still reports `SITE_ORIGIN` as missing**, which is correct: the documents are
finished, the deployment configuration is not. See the production-origin block in
`src/legal/index.js`.

## Acceptance is written by the SERVER, never the browser

The spec proposed an `INSERT` policy for `authenticated` with the row carrying its own `user_id`,
`ip_address` and `user_agent`. That is self-attested twice over — a browser cannot know its own
public IP, and per S531 invariant #3 attribution the subject chooses is not attribution.

`legal_acceptances` therefore has **a SELECT policy and nothing else**, and `authenticated` holds
only a SELECT grant. Writes go through `admin-user-ops`:

| Action | Who | Notes |
| --- | --- | --- |
| `register_trial` | anon | Refuses the signup outright without `accepted_legal`. Rolls back the auth user and client if the ledger insert fails — an account with no consent record is the state this exists to end |
| `record_legal_acceptance` | Owner/admin | The re-acceptance gate |
| `record_paper_agreement` | admin only | Writes the agreement **plus** the Terms and Privacy versions it incorporates by reference |

The browser sends only `{version, sha256}` per document — what the bundle it had loaded actually
displayed, which is the fact worth recording. IP and user agent are read off the request.

## Three registrations are deliberately skipped

Documented at length in `20260903130000_legal_acceptances.sql`'s header, because each reads as an
oversight: **`deleteClientData`** (a data wipe must not erase consent — retained 7 years per the
Privacy Policy, which is also why `client_id` is `ON DELETE SET NULL` beside a denormalised
`client_name`), **`CLIENT_SCOPED_TABLES`** (nothing in the browser writes it), and
**`RESTORE_ORDER`** (restore inserts from the browser, which has no grant — and an acceptance
re-insertable from a spreadsheet would not be evidence).

## The gate is a full page, not a Modal

`Modal` closes on Escape and backdrop click unconditionally — there is no `dismissible={false}`, so
a gate built on it is dismissible by one keypress. `LegalReacceptance` renders *instead of* the app
from `ProtectedRoute`, exactly like `SubscriptionLock`, Sign Out included. Ordered **after**
`accessLocked`: a lapsed client has a more immediate problem, and being asked to agree to terms for
a product you cannot currently open reads as a demand.

**`requiresReacceptance` is ON for v1.0 as of 2026-09-03**, so every tenant Owner is held until they
accept. That is what closes the gap the clickwrap could not reach: it bound new signups from the day
it shipped and left every existing client with no consent record.

Two properties keep that safe. **`docsRequiringReacceptance()` is the only thing either consumer
reads** — AuthContext's decision and the gate's own render — and it excludes a DRAFT document no
matter what its flag says, so a v1.1 copied from v1.0 with a placeholder left in cannot gate anyone.
And the whole read **fails OPEN** on error (`legalAccepted === null`), because a dropped connection
must not lock every owner out of the product.

**That helper returned doc-type STRINGS in its first draft, and it is worth knowing why that was
nearly catastrophic rather than cosmetic.** Both callers read `.docType`/`.version` off the result.
The gate would have rendered blank fields — visible, someone would report it — but AuthContext
compared an accepted row's `doc_version` against `undefined`, so the gate condition stayed true
after a successful acceptance: an Owner who accepted would have been held at the blocking screen
**permanently, with no way out except Sign Out**. `reacceptGuard.test.js` caught it. The branch had
no live data, which is exactly why it needed a test rather than a read-through.

## The gate must never be able to sit on "Recording…" (S674)

The paragraph above is about the gate staying up because the *comparison* was wrong. This is the
same end state reached at runtime, and it shipped in S672 alongside it. Two rules, both now in the
code:

- **Every await in `accept()` is bounded, and `busy` clears in a `finally`.** `busy` used to clear
  only in the `catch`, on the reasoning that a successful accept unmounts the gate. `refreshProfile`
  → `fetchProfile` makes several sequential Supabase reads, any of which can hang forever, and it
  runs **after** the acceptance is already written — so a hang there leaves the row in a seven-year
  ledger, the gate up, and the screen's only control reading "Recording…" for good. The file's own
  header comment had explained that exact hazard for the call immediately above it.
- **Reaching the line after `refreshProfile()` means the gate did not clear**, so it says so and
  offers a Reload. Do not silently re-arm the button: a second press writes a duplicate row.

**Call the Edge Function through `adminOp` (`src/shared/adminOp.js`), never
`supabase.functions.invoke` directly.** invoke reports every non-2xx as the same `Edge Function
returned a non-2xx status code`, which collapses `Unknown action: record_legal_acceptance` — what
you get when the function has not been redeployed since S672 added the action, and the single most
likely thing to be wrong — into the same string as `Forbidden` and a failed insert. `adminOp` reads
the response body. It moved out of `src/pages/adminClients/` for this: a route guard reaching into a
page directory is what made skipping the wrapper the path of least resistance.

## Where each surface lives, and why not where you'd expect

- **Client-facing acceptance record → Help, not Settings.** `/settings` sits behind
  `ModuleGate module="ims"`, so a POS-only or HR-only client can never reach it. `/help` is the one
  in-app page with no module or plan gate.
- **Staff are shown an explicit "owner only" message rather than an empty table.** The four
  RESTRICTIVE families fence them off, and a restrictive SELECT returns `{data: [], error: null}` —
  on this page an empty table is a claim that the business has agreed to nothing.
- **`/legal/subscription-agreement/print` is a sub-route with no nav item**, so nothing gates it:
  the role check is in the component after every hook, and because the client id is a URL parameter
  a non-admin is pinned to their own `clientId` whatever the query string says.
- **Route order matters**: the print route is declared BEFORE `/legal/:docType`, or `:docType`
  swallows `subscription-agreement`.

## The markdown renderer is ours, on purpose

`LegalMarkdown.jsx` handles the subset the two documents use. react-markdown v9 is ESM-only and
CRA 5's Jest leaves `node_modules` untransformed, so any test importing the page would have died at
the import. The input is not arbitrary — it is two files in this repo, byte-asserted by
`legalHash.test.js` — and `LegalMarkdown.test.jsx` renders the REAL documents and fails on any
markdown that survives to the reader.

## Two Jest fixes came with this and unlock component tests generally

react-router-dom@7.17 declares `main: ./dist/main.js`, **a file it does not ship**, and Jest 27
resolves by `main` because it predates `exports`. Plus jsdom here has no `TextEncoder`, which
react-router touches at import time. The `moduleNameMapper` block in `package.json` and the shim in
`setupTests.js` fix both — which is a large part of why this codebase had almost no component tests.

## The automatic trial purge (the retention promise, made real)

Terms 4.3/7.6 and Privacy 9 promise a lapsed trial's data is deleted. `trial_purge_at` had been
written at every signup since the form was built and **nothing read it** — `data-export.md` even
said so outright ("`trial_purge_at` still deletes nothing… build the parachute before the jump").
`20260903150000` is the jump.

It runs unattended against live tenant data, which makes it the most dangerous code in the product.
Everything about it is arranged around one question: **what would have to be true for this to delete
a paying customer?** The realistic answer is not a bug — `is_trial` is cleared by exactly one thing,
the "Convert to paid" button, so an admin who takes payment and forgets it leaves a real customer at
`is_trial = true` with a long-past purge date.

**Six guards, all in SQL** (`trials_due_for_purge()`), so the decision is auditable from the SQL
editor without reading Deno: still a trial · purge date passed · **no paid module window open**
(the one that catches the forgotten button) · not asking to subscribe · nobody signed in since
expiry · **a backup exists taken after the trial ended**. That last one is not new policy —
`data-export.md` already named `last_backup_at` as "the gate any future purge must check", and the
whole T-72h `useAutoPurgeBackup` mechanism exists as the parachute for this.

Four properties worth keeping:

- **The function returns overdue trials WITH a `blocked_reason`, not a filtered safe-list.** An
  operator must be able to see "four are overdue and none has a backup"; a query that omitted them
  could never show it. The Edge Function purges only `blocked_reason IS NULL` rows and logs the rest
  as `skipped` — it re-decides nothing, because two implementations of "may this be deleted" is how
  a preview comes to lie.
- **One delete sequence.** `deleteClientDataFor()` was extracted from the Danger Zone action for
  this; a second hand-ordered copy of ~130 FK-sensitive deletes would drift the first time a table
  was added to one and not the other, and the symptom is a row that quietly survives a wipe.
- **The `clients` row survives**, deactivated and stamped `trial_purged_at`. Deleting it would take
  `legal_acceptances.client_id` with it and erase which business a consent record belonged to — a
  record the same policy retains for 7 years. Customer Data is deleted; the account shell is not.
- **`dry_run` defaults TRUE.** An unattended deleter whose default is "delete" is one hand-run away
  from disaster. Cron passes `dry_run: false` explicitly.

Two settings must be set before it can do anything (`app.settings.functions_url`,
`app.settings.anon_key`); until then the POST goes nowhere and fails harmlessly. Authentication is a
DB-generated `app_secrets.purge_secret`, so there is nothing to copy by hand — the `pin_pepper`
precedent.

## Clauses that promise more than the code does — read before publishing

Reconciled in the text already: §7.5 no longer claims self-serve export (there is none; it is an
assisted export on request), the sub-processor table lists only providers that are actually live,
and trial terms say 7 days / 15 days because that is what `register_trial` writes.

§4.3 / §7.6 and Privacy §9 are now backed by the automatic purge above.

**Still outstanding, and not coding problems:** Privacy §8's 72-hour breach notification is a
process commitment with no mechanism, and there is still no transactional email, so anything shaped
like "we will email you" is done by hand. `trial_signup_attempts` also still has no cleanup — its
own migration documents a manual `DELETE`, and Privacy §9 now promises 12 months for it.
