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
// Adding version 1.1 of a document:
//   1. Copy src/legal/terms-v1.0.md to terms-v1.1.md and edit it.
//   2. Point SOURCES in scripts/hash-legal.mjs at the new file; keep the old one listed under
//      PRIOR_VERSIONS below so /legal/terms/1.0 still resolves.
//   3. node scripts/hash-legal.mjs
//   4. Bump `version` and the effective dates here, and set requiresReacceptance if the change
//      materially affects the customer's rights.
//   5. Bump CACHE_NAME in public/service-worker.js, or existing users keep the old text.

import { LEGAL_META } from './generated/legalMeta'

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
    version: '1.0',
    effectiveAd: '2026-09-03',
    effectiveAdLabel: '3 September 2026',
    effectiveBs: '2083-05-18',
    effectiveBsLabel: '18 Bhadra 2083',
    requiresReacceptance: true,
    changeSummary: null,
  },
}

// Superseded versions, kept so /legal/terms/1.0 keeps resolving after 1.1 ships. An acceptance row
// references a version forever; a URL in it that 404s makes the record harder to rely on, not
// merely untidy. Empty until there is a second version of anything.
export const PRIOR_VERSIONS = {}

/** Everything known about the current version of a document, hash included. */
export function legalDoc(docType) {
  const base = REGISTRY[docType]
  if (!base) return null
  const meta = LEGAL_META[docType] || {}
  return {
    ...base,
    // The source filename, so the page can offer the EXACT bytes the hash was taken over. Without
    // it the published hash is only checkable by someone who can reach the git repo, which is a
    // poor kind of verifiable for a document aimed at a customer's lawyer.
    filename: meta.filename || `${docType}-v${base.version}.md`,
    sha256: meta.sha256 || null,
    bytes: meta.bytes || 0,
    missing: meta.missing || [],
  }
}

export const LEGAL_DOCS = Object.fromEntries(DOC_TYPES.map((t) => [t, legalDoc(t)]))

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
 * The documents that should currently block a tenant Owner until accepted.
 *
 * `requiresReacceptance` alone is NOT sufficient, and this function exists so that can never be
 * forgotten: a document still carrying an unfilled placeholder is excluded no matter what its flag
 * says. Gating every Owner in the product behind a blocking screen showing them
 * "[[NEEDS VALUE: COMPANY_REG_NO]]" would be worse than the consent gap it was meant to close, and
 * the two settings live far enough apart in this file that someone will eventually set one without
 * checking the other.
 *
 * Both the gate's own render and AuthContext's decision read this, so they cannot disagree.
 */
export function docsRequiringReacceptance() {
  // Returns DOCUMENTS, not doc-type strings. Both callers read `.docType`, `.version` and
  // `.sha256` off these, and the first draft of this returned strings: the gate rendered blank
  // fields, and — far worse — AuthContext compared an accepted row's doc_version against
  // `undefined`, so the condition stayed true forever and an Owner who accepted would have been
  // held at the blocking screen permanently with no way out. Caught by reacceptGuard.test.js.
  return DOC_TYPES.map(legalDoc).filter((d) => d && d.requiresReacceptance && !isDraft(d.docType))
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

/** The text, on demand. Only the /legal routes and the re-acceptance gate should call this. */
export async function loadLegalText(docType) {
  const { LEGAL_TEXT } = await import('./generated/legalText')
  return LEGAL_TEXT[docType] || null
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
