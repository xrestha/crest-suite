// The legal document registry — the one place that knows which version of the Terms and Privacy
// Policy is current, when it took effect, and what its content hash is.
//
// This module is deliberately TINY and holds no prose. Login.js imports it to stamp the acceptance
// it sends to the server, and Login.js is on the critical path of the landing page. The documents
// themselves live in src/legal/generated/legalText.js (~27 kB) and are reached only through
// loadLegalText(), which is a dynamic import — so the legal routes pay for the text and nothing
// else does.
//
// WHY THE VERSION AND THE TEXT SHIP TOGETHER, rather than the version living in the database.
// The spec this was built from wanted a `legal_documents` table holding both, with the app reading
// the current version from it. That fails badly against this app's service worker, which is
// cache-first for static assets: a database that says "1.1 is current" against a browser still
// serving the cached 1.0 chunk would show someone the old text above a checkbox recording that they
// accepted the new one. Keeping version, hash and prose in one bundled module makes that state
// unrepresentable — they are the same deploy or they are neither. The cost is that publishing a new
// version is a deploy, which it was always going to be, since the text is written in git.
//
// Publishing a new version of a document (Privacy 1.1 was the first, 2026-11-03):
//   1. Copy the current file (e.g. privacy-v1.1.md) to the next version's name and edit the copy.
//      Never edit or delete a published file: every acceptance row links to the version it
//      recorded, and /legal/<doc>/<version> serves that file's own bytes and hash.
//   2. Append the new file to its list in SOURCES in scripts/hash-legal.mjs (last = current), then
//      run node scripts/hash-legal.mjs. It emits the current text as before plus every earlier
//      version (LEGAL_PRIOR_META / LEGAL_PRIOR_TEXT), all in the one lazily loaded text chunk.
//   3. Move the outgoing version's REGISTRY entry into PRIOR_VERSIONS below, unchanged (its
//      `requiresReacceptance` included: the acceptance floor is read from it), and write the new
//      version, effective dates and `changeSummary` into REGISTRY.
//   4. Decide `requiresReacceptance` for the new version. true: every Owner must accept THIS
//      version, even one who accepted an earlier one. false: an earlier acceptance still stands,
//      and only an outlet that never accepted any version is asked (see acceptanceFloor()). Privacy
//      §12 asks for fresh acceptance only where a change materially affects Customer Data.
//   5. Bump CACHE_NAME in public/service-worker.js, or existing users keep the old text.
//   6. Write the "In short" box for the new version in ./legalSummaries.js, checking every line
//      against the clause it cites. It is keyed by version on purpose: a new version renders NO
//      summary until one is written for it, because a paraphrase of a clause that has since
//      changed is worse than none.

import { LEGAL_META, LEGAL_PRIOR_META } from './generated/legalMeta'

// ── The production origin ────────────────────────────────────────────────────────────────────
//
// TO SET IT, DO ONE OF THESE — there is nowhere else to change:
//   1. Add REACT_APP_SITE_ORIGIN=https://your-domain.com to the Vercel project's environment
//      variables (preferred — no code change, and preview deploys can differ from production), or
//   2. Replace SITE_ORIGIN_FALLBACK below with the domain.
//
// Why it cannot just use window.location.origin. On screen that would be right, and `siteOrigin()`
// does prefer it. But the printed Subscription Agreement quotes these URLs as the evidence of what
// was incorporated by reference into a signed contract, and a contract that cites
// "localhost:3000/legal/terms" — or a vercel.app preview URL — is worthless. A signed document has
// to name the address the documents will still be at in three years.
//
// Until it is set, `legalReadiness()` reports SITE_ORIGIN as missing and every draft banner in the
// product says so, exactly like an unfilled [[NEEDS VALUE]] marker in the prose. That is
// deliberate: the failure mode of a wrong domain here is a contract clause nobody can verify, and
// it is silent.
const SITE_ORIGIN_FALLBACK = ''

export const SITE_ORIGIN =
  (typeof process !== 'undefined' && process.env && process.env.REACT_APP_SITE_ORIGIN) ||
  SITE_ORIGIN_FALLBACK

export const SITE_ORIGIN_SET = Boolean(SITE_ORIGIN)

/** The origin to build a link from: the live one on screen, the configured one everywhere else. */
export function siteOrigin() {
  if (typeof window !== 'undefined' && window.location && window.location.origin) {
    return window.location.origin
  }
  return SITE_ORIGIN
}

/**
 * The provider's own legal identity — the facts that appear in BOTH markdown documents and on the
 * printed Subscription Agreement.
 *
 * Three copies of a company registration number is how two of them end up disagreeing. The markdown
 * has to carry the literal text (it is what gets hashed, and a hash over a template would verify
 * nothing), so the duplication cannot be removed there — but the agreement generator reads from
 * here rather than hand-typing a third. `legalCompany.test.js` asserts every value below still
 * appears verbatim in both documents, which is what makes the pair safe to leave duplicated.
 */
export const COMPANY = {
  name: 'Bloom Hospitality Pvt. Ltd.',
  regNo: '398714/83/84',
  pan: '623688353',
  address: 'Saraswatinagar-6, Kathmandu',
  // One address for all three roles, because it is the one that exists. The crestsuite.com
  // mailboxes these replaced were never provisioned -- and a Privacy Policy directing a data
  // subject to a mailbox nobody reads is a statutory contact point that does not work, not a
  // cosmetic detail. Split them back out once the domain has real mailboxes behind it.
  legalEmail: 'bloomhospitalitynp@gmail.com',
  privacyEmail: 'bloomhospitalitynp@gmail.com',
  supportEmail: 'bloomhospitalitynp@gmail.com',
  privacyOfficer: 'Aashish Shrestha',
}

/**
 * The product's own name, on the surfaces that speak for the PROVIDER rather than for a tenant.
 *
 * Not `settings.app_name`. Every other signed-out page is right to white-label — a client's staff
 * sign in at /login and it should carry their brand — but these documents are a contract between
 * COMPANY.name above and the customer, and the first sentence of both says so. Reading app_name
 * here put a tenant's trading name in the header, in "© <year> …" under Crest's own legal text and
 * in the running foot of every printed copy, so a filed contract identified itself by the name of
 * one of the parties it binds. It was also literally wrong in production: signed out there is no
 * client, so SettingsContext loads the `client_id IS NULL` row, and that row's app_name is whatever
 * the operator last saved there.
 *
 * DESIGN.md already draws this line for a neighbouring case — "Product names are not the client's
 * to rebrand", which is why Pricing's plan names stay "Crest IMS" and "Crest HR".
 */
export const PRODUCT_NAME = 'Crest Suite'

export const DOC_TYPES = ['terms', 'privacy']

const REGISTRY = {
  terms: {
    docType: 'terms',
    title: 'Terms of Service',
    version: '1.0',
    effectiveAd: '2026-09-03',
    effectiveAdLabel: '3 September 2026',
    effectiveBs: '2083-05-18',
    effectiveBsLabel: '18 Bhadra 2083',
    // ON as of 2026-09-03. Every tenant Owner is held at a blocking screen until they accept, and
    // that is the point: no client on the platform had ever recorded consent to anything, so the
    // clickwrap added the same day bound new signups and left every existing one untouched. Staff
    // are never gated — they are not the contracting party and their work is unaffected.
    //
    // Safe to turn on only because the documents are complete; docsRequiringReacceptance() enforces
    // that independently, so a future draft cannot gate anyone even if this stays true.
    requiresReacceptance: true,
    changeSummary: null,
  },
  privacy: {
    docType: 'privacy',
    title: 'Privacy Policy',
    version: '1.1',
    effectiveAd: '2026-11-03',
    effectiveAdLabel: '3 November 2026',
    effectiveBs: '2083-07-17',
    effectiveBsLabel: '17 Kartik 2083',
    // OFF for 1.1, by owner decision (2026-11-03). 1.1 adds Sentry, which receives an error report
    // when the app fails, to the sub-processor list (§4, §5, §6, §9). That is not a material change
    // to Customer Data under §12, so clients are told by email and nobody is asked again: an outlet
    // that accepted 1.0 keeps that acceptance. An outlet with no privacy acceptance at all is still
    // asked, because 1.0 required one (acceptanceFloor()).
    requiresReacceptance: false,
    changeSummary:
      'Adds Sentry, the service that receives an error report when the app fails on a device, to the list of service providers (sections 4, 5, 6 and 9).',
  },
}

// Superseded versions, kept so /legal/privacy/1.0 keeps resolving with ITS OWN text and hash after
// 1.1 ships. An acceptance row references a version forever; a link in it that shows a different
// wording, or none, makes the record harder to rely on. Each entry is the REGISTRY entry as it stood
// while that version was current, `requiresReacceptance` included, because acceptanceFloor() reads
// it. Keyed `${docType}-${version}`, the same key as LEGAL_PRIOR_META and LEGAL_PRIOR_TEXT.
export const PRIOR_VERSIONS = {
  'privacy-1.0': {
    docType: 'privacy',
    title: 'Privacy Policy',
    version: '1.0',
    effectiveAd: '2026-09-03',
    effectiveAdLabel: '3 September 2026',
    effectiveBs: '2083-05-18',
    effectiveBsLabel: '18 Bhadra 2083',
    requiresReacceptance: true,
    changeSummary: null,
  },
}

function withMeta(base, meta) {
  return {
    ...base,
    // The source filename, so the page can offer the EXACT bytes the hash was taken over. Without
    // it the published hash is only checkable by someone who can reach the git repo, which is a
    // poor kind of verifiable for a document aimed at a customer's lawyer.
    filename: meta.filename || `${base.docType}-v${base.version}.md`,
    sha256: meta.sha256 || null,
    bytes: meta.bytes || 0,
    missing: meta.missing || [],
  }
}

/** Everything known about the current version of a document, hash included. */
export function legalDoc(docType) {
  const base = REGISTRY[docType]
  if (!base) return null
  return withMeta(base, LEGAL_META[docType] || {})
}

/**
 * One superseded version, with its own hash, filename and byte count, or null when this bundle does
 * not hold that version. Never the current version: ask legalDoc() for that.
 */
export function priorLegalDoc(docType, version) {
  const key = `${docType}-${version}`
  const base = PRIOR_VERSIONS[key]
  if (!base) return null
  return withMeta(base, LEGAL_PRIOR_META[key] || {})
}

// Built once, so a page can use them as effect dependencies: legalDoc() returns a new object on
// every call.
export const LEGAL_DOCS = Object.fromEntries(DOC_TYPES.map((t) => [t, legalDoc(t)]))
export const LEGAL_PRIOR_DOCS = Object.fromEntries(
  Object.values(PRIOR_VERSIONS).map((p) => [`${p.docType}-${p.version}`, priorLegalDoc(p.docType, p.version)])
)

/**
 * Compares two "major.minor" version strings by number ("1.10" is after "1.9"). Negative, zero or
 * positive, like a sort comparator.
 */
export function compareLegalVersions(x, y) {
  const parts = (v) => String(v).split('.').map((n) => parseInt(n, 10) || 0)
  const a = parts(x)
  const b = parts(y)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0)
    if (d !== 0) return d
  }
  return 0
}

/**
 * The oldest version whose acceptance still satisfies the gate: the newest published version
 * (current or prior) that set `requiresReacceptance`. Null when no version ever required acceptance,
 * and then the document never gates anyone.
 *
 * So a version published with `requiresReacceptance: false` keeps every earlier acceptance standing
 * (Privacy 1.1: the floor stays 1.0) while still asking an outlet that never accepted ANY version,
 * because some earlier version required acceptance. A later version that sets the flag again moves
 * the floor up to itself, and an acceptance below it no longer counts.
 */
export function acceptanceFloor(docType) {
  const current = REGISTRY[docType]
  if (!current) return null
  const versions = [
    current,
    ...Object.values(PRIOR_VERSIONS).filter((p) => p.docType === docType),
  ]
  return versions
    .filter((v) => v.requiresReacceptance)
    .map((v) => v.version)
    .reduce((best, v) => (best === null || compareLegalVersions(v, best) > 0 ? v : best), null)
}

/** True when an accepted ledger version satisfies this document's gate. */
export function acceptanceSatisfies(doc, acceptedVersion) {
  const floor = acceptanceFloor(doc.docType)
  if (floor === null) return true
  if (acceptedVersion == null) return false
  return compareLegalVersions(acceptedVersion, floor) >= 0
}

/**
 * A document still carrying an unfilled [[NEEDS VALUE: X]] marker is a draft and must not be
 * presented as being in force. Part E rule 5 of the source spec: a Terms page showing a raw
 * placeholder in public is worse than the passive sentence it replaced.
 */
export function isDraft(docType) {
  return (legalDoc(docType)?.missing.length || 0) > 0
}

/** Every value still needed before any of this can be published, across all documents. */
export function missingLegalValues() {
  return [...new Set(DOC_TYPES.flatMap((t) => legalDoc(t)?.missing || []))].sort()
}

export function anyLegalDraft() {
  return DOC_TYPES.some(isDraft)
}

/**
 * The documents that CAN hold a tenant Owner at the gate: every complete document with an
 * acceptance floor (some version of it required acceptance). Whether a given outlet is actually
 * held is outstandingLegalDocs(), which also reads its ledger.
 *
 * A flag alone is NOT sufficient, and this function exists so that can never be forgotten: a
 * document still carrying an unfilled placeholder is excluded no matter what its flag says. Gating
 * every Owner in the product behind a blocking screen showing them "[[NEEDS VALUE: COMPANY_REG_NO]]"
 * would be worse than the consent gap it was meant to close, and the two settings live far enough
 * apart in this file that someone will eventually set one without checking the other.
 *
 * The name predates Privacy 1.1, when a document either required its current version or did not
 * gate at all. It now also covers a document that needs only a FIRST acceptance.
 */
export function docsRequiringReacceptance() {
  // Returns DOCUMENTS, not doc-type strings. Both callers read `.docType`, `.version` and
  // `.sha256` off these, and the first draft of this returned strings: the gate rendered blank
  // fields, and — far worse — AuthContext compared an accepted row's doc_version against
  // `undefined`, so the condition stayed true forever and an Owner who accepted would have been
  // held at the blocking screen permanently with no way out. Caught by reacceptGuard.test.js.
  return DOC_TYPES.map(legalDoc).filter(
    (d) => d && acceptanceFloor(d.docType) !== null && !isDraft(d.docType)
  )
}

/**
 * The documents this outlet still has to accept, from its own ledger rows (`{ doc_type,
 * doc_version }`, AuthContext's `legalAccepted`). Empty means the gate stays down.
 *
 * AuthContext's decision and the gate's own list both read this, so they cannot disagree: the gate
 * shows exactly the documents that raised it, and accepting them is exactly what clears it.
 * `accepted` null (a failed read) counts nothing as accepted; AuthContext fails OPEN before it
 * asks, so that branch only ever shapes the gate's copy.
 */
export function outstandingLegalDocs(accepted) {
  const rows = accepted || []
  return docsRequiringReacceptance().filter(
    (doc) => !rows.some((r) => r.doc_type === doc.docType && acceptanceSatisfies(doc, r.doc_version))
  )
}

/**
 * The same set as `docsRequiringReacceptance()`, reduced to doc-type STRINGS.
 *
 * Exists because the distinction has now gone wrong in both directions, each time producing the
 * identical symptom — an Owner permanently held at the gate, accepting changing nothing. The first
 * draft of the function above returned strings and its callers wanted objects; then AuthContext
 * passed the objects straight into a `.in('doc_type', …)` filter, which PostgREST stringified to
 * "[object Object]", matched no rows, and returned `{ data: [], error: null }` — a successful read
 * reporting that the client had accepted nothing (S674).
 *
 * So: anything comparing against the `doc_type` COLUMN calls this; anything rendering a document or
 * reading its version and hash calls `docsRequiringReacceptance()`. Neither caller should be doing
 * the `.map` itself.
 */
export function reacceptDocTypes() {
  return docsRequiringReacceptance().map((d) => d.docType)
}

/**
 * Is v1.0 publishable, and if not, what is still missing?
 *
 * Covers BOTH the unfilled [[NEEDS VALUE]] markers in the prose and the unset production origin.
 * One check, because they fail the same way — a document that looks finished and is not — and a
 * reader should not have to know that one lives in markdown and the other in an env var.
 */
export function legalReadiness() {
  const missing = missingLegalValues()
  if (!SITE_ORIGIN_SET) missing.push('SITE_ORIGIN')
  return { ready: missing.length === 0, missing: missing.sort() }
}

/**
 * The text, on demand. Only the /legal routes and the re-acceptance gate should call this.
 *
 * `version` is optional, and passing it is what makes a versioned URL honest. Both acceptance
 * tables deep-link to the version they recorded, so the single link whose purpose is "show me the
 * text I agreed to" must answer with THAT text: the current version from `LEGAL_TEXT`, a superseded
 * one from `LEGAL_PRIOR_TEXT` (its own bytes, matching its own hash), and anything this bundle does
 * not hold with null, never the current wording under another version's banner. Legal.jsx says
 * plainly which version it cannot show.
 */
export async function loadLegalText(docType, version) {
  const doc = legalDoc(docType)
  if (!doc) return null
  const current = !version || version === doc.version
  const priorKey = `${docType}-${version}`
  if (!current && !PRIOR_VERSIONS[priorKey]) return null
  const { LEGAL_TEXT, LEGAL_PRIOR_TEXT } = await import('./generated/legalText')
  return (current ? LEGAL_TEXT[docType] : LEGAL_PRIOR_TEXT[priorKey]) || null
}

/**
 * What the browser tells the server it is accepting. The server records the version and hash from
 * THIS payload, so the ledger says what the person was actually shown — the bundle they had loaded
 * — rather than what the server happened to believe was current at that moment. The two can differ
 * for exactly as long as a cached bundle survives a deploy, which is the whole reason the gate and
 * the text ship together.
 *
 * Note what is NOT here: no IP, no user agent, no user id, no client id. A browser cannot know its
 * own address, and a subject that chooses its own attribution has not been attributed. All four are
 * read server-side off the request inside admin-user-ops.
 */
export function acceptancePayload(docTypes = DOC_TYPES) {
  return docTypes.reduce((acc, t) => {
    const d = legalDoc(t)
    if (d) acc[t] = { version: d.version, sha256: d.sha256 }
    return acc
  }, {})
}

/** Path to the current version of a document. */
export function legalPath(docType) {
  return `/legal/${docType}`
}

/** Path to one specific version, for a link that must keep meaning what it meant. */
export function legalVersionPath(docType, version) {
  return `/legal/${docType}/${version}`
}

/**
 * Absolute URL, for print and anything that leaves the browser.
 *
 * Returns a visibly unfinished string rather than a plausible-looking wrong one when the origin has
 * not been set — a printed agreement citing the wrong domain is worse than one that admits it does
 * not know, because only the second gets noticed before signature.
 */
export function legalAbsoluteUrl(docType, version) {
  const path = version ? legalVersionPath(docType, version) : legalPath(docType)
  if (!SITE_ORIGIN_SET) return `[SET REACT_APP_SITE_ORIGIN]${path}`
  return `${SITE_ORIGIN}${path}`
}
