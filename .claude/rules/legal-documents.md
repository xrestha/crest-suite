---
paths:
  - "src/legal/**"
  - "src/pages/Legal.jsx"
  - "src/pages/Legal.css"
  - "src/pages/SubscriptionAgreement.jsx"
  - "src/pages/SubscriptionAgreement.css"
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

## `doc_type` filters take `reacceptDocTypes()`, never `docsRequiringReacceptance()` (S675)

The objects-versus-strings distinction above has now gone wrong in **both** directions, and both
times the symptom was identical: every Owner held at the gate, accepting changing nothing. The
second time it was live.

`AuthContext` filtered the ledger with `.in('doc_type', docsRequiringReacceptance())`. PostgREST
stringifies what it is given, so the filter was on the literal text `[object Object]` — no rows,
**`error: null`**. A successful read asserting the client had accepted nothing.

**Both safeguards on this screen were bypassed by that, and it is worth seeing why.** The read
fails OPEN on error, but there was no error. And `reacceptGuard.test.js` existed *specifically*
because of the first occurrence — it tests the helper, and the helper was right both times. **The
fault was at the call site, which chose the wrong one of two correct functions, so a test of the
helper passes while the product is shut.**

So the split is now explicit and the rule is on the *reader*, not the writer:

- **Comparing against the `doc_type` COLUMN** → `reacceptDocTypes()` (strings).
- **Rendering a document, or reading its `version`/`sha256`** → `docsRequiringReacceptance()`.
- **Neither caller does the `.map` itself.** That is what made the two interchangeable at a glance.

`reacceptGuard.test.js` now also reads the **source** of `src/` and fails on any `.in('doc_type', …)`
given anything but a types-shaped value. Both source guards were checked against the exact string
that shipped, because a source-scanning test that matches nothing is indistinguishable from one that
passes.

**The general shape, worth carrying beyond this file: a filter that matches nothing returns
`{ data: [], error: null }`, which every fail-open guard reads as a good answer.** Same family as
the 1000-row truncation rule and the RESTRICTIVE-policy empty read — an empty result is not evidence
of an empty table.

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
- **Dates on both Legal tabs go through `nepalDateLong` ("4 September 2026"), not `nepalDateAd`
  (S676).** `nepalDateAd` is `en-US` by S670's deliberate choice for the printed bill, so it gives
  `09/04/2026` — which a DD/MM reader (Nepal) takes as 9 April. On a bill that is a format habit;
  on the acceptance ledger the date is the fact on record. Named month, day first, matching the
  registry's `effectiveAdLabel` on the same panel. Leave `nepalDateAd` alone — the bills are a
  separate decision.

## The legal pages do NOT white-label (S678)

Every other signed-out surface reads `settings.app_name` and is right to — a client's staff sign
in at `/login`, and DESIGN.md's Brand Lockup Rule exists so the mark and the wordmark name the
same brand there. **These documents are the exception**, because they are a contract between
`COMPANY.name` and the customer and their own first sentence says so. Reading `app_name` here put
a tenant's trading name in the header, in `© <year> …` beneath Crest's own legal text, and in the
running foot of every printed copy — so a filed contract identified itself by the name of one of
the parties it binds.

It was also wrong in fact, not just in principle: signed out there is no client, so
`SettingsContext` loads the `client_id IS NULL` row, and production's global row carries whatever
the operator last saved. The live page rendered **BHATTI CHOILA** as the brand of Crest's Terms of
Service.

`PRODUCT_NAME` in `src/legal/index.js` is the one value, used by `Legal.jsx` (brand, print foot,
print job title) and `SubscriptionAgreement.jsx` (`providerName`, matching its already-hardcoded
`<h1>`); the footer copyright is `COMPANY.name`. Same line DESIGN.md draws for Pricing's plan
names — product names are not the client's to rebrand.

## A versioned URL must not serve a version it does not hold (S678)

`LEGAL_TEXT` is keyed by **doc type alone**, so this bundle only ever holds the current wording.
`loadLegalText(docType)` ignored the version entirely, which meant `/legal/terms/0.9` rendered
v1.0's full text underneath a banner reading *"Version 0.9 is not a version of this document that
we published"* — and after 1.1 ships, `/legal/terms/1.0` would render **1.1's text** under
*"Version 1.0 has been superseded"*. Both acceptance tables deep-link there with the version they
recorded, so the single link whose entire purpose is *"show me the text I agreed to"* would have
shown a different document, correctly labelled, with nothing saying so.

`loadLegalText(docType, version)` now returns null for anything but the current version, and the
page renders **no body, no meta row and no hash** — the hash is the sharp one: printing v1.0's
fingerprint on a page reached by asking for 0.9 attaches this document's identity to another
document's address, which is the opposite of what the fingerprint is for. The banner says what it
cannot show and gives the support address.

**This is the safe failure, not the finished one.** Step 5 of the "Adding version 1.1" checklist
in `index.js` says so: make `SOURCES` a list per doc type and emit prior versions before
publishing 1.1, or the ledger's own links answer with an apology.

## The "In short" box is page chrome, keyed by version (S679)

`src/legal/legalSummaries.js` holds a five-or-six-line plain-language summary per
`${docType}-${version}`, rendered by `Legal.jsx` above §1 inside an `<aside>` that says, in its own
note, that it is not part of the agreement. **It lives outside the markdown on purpose**: the `.md`
is hashed byte for byte and every ledger row records that hash, so a sentence added to the document
is a new version, a re-hash and a re-acceptance for every Owner. A reader's aid must not cost that.

Three properties to keep:

- **Keyed by version, and a missing key renders nothing.** v1.1 shows no box until someone writes
  one against v1.1's clauses — step 7 of the "Adding version 1.1" checklist in `index.js`. A
  paraphrase of a clause that has since changed is worse than none.
- **Every line names one section, and the link is resolved from the live contents list**
  (`sectionHref` in `Legal.jsx`, the same `buildToc` the rail uses), never a hardcoded slug. A
  renumbered heading turns the reference into plain text on screen instead of a link to nowhere.
- **Not printed** (`legal-no-print`). A filed copy carries the agreement and nothing that could be
  mistaken for part of it.

Check each line against its clause when writing one. The wording is the discipline; the mechanism
only stops it drifting silently.

## Heading levels: `##` is h2, and the page owns h1 (S679)

`LegalMarkdown` once shifted every markdown level down by one so the document's own `# ` title
could sit under the page's `<h1>`. S678 began stripping that title for render, which left the
shift with nothing to justify it and a real cost: the only level-2 heading on the page was the
rail's "Contents", and a screen reader walking level-2 headings found a table of contents and no
document. `#` → h2 (defensive; it is stripped anyway), `##` → h2, `###` → h3. The CSS classes stay
keyed on the *markdown* level (`legal-h2` is a `##`), so the renderer test asserts the outline.

## Below 640px the tables are stacked cards, and the ARIA roles are why that is safe (S679)

`Legal.css` sets `display: block` on the Privacy tables' `table`/`tbody`/`tr`/`td` under
`screen and (max-width: 640px)` and prints each cell's column name from `data-label`, which the
renderer sets from the header row (inline markup stripped). **Chrome and Safari drop a table's
implicit ARIA roles when its display changes**, so the renderer also sets `role="table"` /
`rowgroup` / `row` / `columnheader` / `cell` explicitly — jsx-a11y calls them redundant, CI treats
the warning as an error, and the block carries an `eslint-disable` with the reason. Do not remove
the roles to quiet the linter; on a phone they are the only thing keeping the sub-processor table a
table.

## The document's front matter is stripped for RENDER, never from `text` (S678)

Both `.md` files open with `# Crest Suite Terms of Service` and `**Version 1.0 — Effective 3
September 2026 (18 Bhadra 2083 BS)**`. On screen those are the page header said twice, in a
different typeface, one rule apart. `stripDocFrontMatter()` (exported from `LegalMarkdown.jsx`)
drops them for display only.

**It must never touch the stored `text`.** That string is what the Download button hands over and
what the SHA-256 was taken across; a copy that opens without its own title and version identifies
nothing once it is off the page, and one byte's difference makes the published hash unverifiable.
The function is written defensively — a document that does not open this way is returned
untouched — and only drops the version line when it really is the version line.

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
