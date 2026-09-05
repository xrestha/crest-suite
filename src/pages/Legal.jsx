// Public legal document pages: /legal/terms, /legal/privacy, and /legal/:docType/:version.
//
// No auth, no Layout, no ModuleGate. These have to be readable by someone who has not signed up,
// which is the whole point — the trial checkbox links here, and a checkbox whose terms are behind a
// login is not informed consent. It is also why this page cannot live in Settings, where the first
// draft of the plan put the acceptance history: /settings sits behind ModuleGate module="ims", so a
// POS-only or HR-only client cannot reach it at all.
//
// The text is fetched through loadLegalText()'s dynamic import rather than a static one, so the
// ~27 kB of prose is its own chunk and the landing page does not carry it.
//
// This page does NOT white-label. Every other signed-out surface reads settings.app_name and is
// right to — a client's staff sign in at /login. These documents are a contract between
// COMPANY.name and the customer, so the header, the copyright line and the printed running foot all
// name the provider. See the comment on PRODUCT_NAME in src/legal/index.js.

import { useEffect, useMemo, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { Hexagon, Printer, Check, Copy, ChevronDown, Download, ShieldCheck } from 'lucide-react'

import { printWithTitle } from '../utils/printTitle'
import LegalMarkdown, { stripDocFrontMatter } from '../legal/LegalMarkdown'
// The one support address (src/shared/supportContact.js re-exports legal's own COMPANY.supportEmail)
// — this used to be a hardcoded mailto: link to "support@" the crestsuite .com domain, which the
// project does not own (see supportAddress.test.js, which asserts that link never comes back).
import { SUPPORT_EMAIL } from '../shared/supportContact'
import {
  COMPANY,
  DOC_TYPES,
  PRODUCT_NAME,
  legalDoc,
  loadLegalText,
  isDraft,
  legalPath,
  PRIOR_VERSIONS,
} from '../legal'
import './Legal.css'

/**
 * Section list for the contents rail, taken from the document's own `## ` headings using the same
 * slug rule LegalMarkdown applies. Deriving both from the visible text rather than maintaining a
 * separate table of contents is what stops the two drifting apart — a rail entry that scrolls
 * nowhere is worse than no rail.
 */
function buildToc(md) {
  return String(md || '')
    .split('\n')
    .map((line) => line.match(/^##\s+(.*)$/))
    .filter(Boolean)
    .map((m) => {
      const label = m[1].replace(/[*`]/g, '')
      return {
        label,
        id: label
          .toLowerCase()
          .replace(/[*`[\]()]/g, '')
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, ''),
      }
    })
}

export default function Legal() {
  const { docType, version } = useParams()

  const [text, setText] = useState(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [copied, setCopied] = useState(false)
  const [verifyOpen, setVerifyOpen] = useState(false)
  // Whether the contents list is open on a phone. Above 900px the rail is always open and this
  // state is inert (the toggle is display:none there); below it the list starts CLOSED. Measured
  // at 390×844 before this existed, the Terms' first sentence sat at y=976 — below the whole first
  // screen — behind a 559px card of eighteen links. A reader who tapped "Terms of Service" should
  // meet the terms, not a map of them.
  const [tocOpen, setTocOpen] = useState(false)

  const doc = DOC_TYPES.includes(docType) ? legalDoc(docType) : null

  // Derived above the effects, not below them, because the effect has to know whether the URL is
  // asking for a version this bundle can actually produce. PRIOR_VERSIONS is empty until a second
  // version of anything ships, so today the mismatch branch only catches a typo or a stale link —
  // but an acceptance row references its version forever, so it has to exist before it is needed.
  const requestedVersion = version || doc?.version
  const isCurrentVersion = Boolean(doc) && requestedVersion === doc.version
  const knownPriorVersion = Boolean(PRIOR_VERSIONS[`${docType}-${requestedVersion}`])
  const draft = Boolean(doc) && isDraft(docType)

  useEffect(() => {
    let alive = true
    // No document, or a version whose wording this bundle does not hold. Either way there is
    // nothing to fetch, and fetching anyway would put the CURRENT text under a banner naming a
    // different version.
    if (!doc || !isCurrentVersion) {
      setText(null)
      setLoadFailed(false)
      return undefined
    }
    setText(null)
    setLoadFailed(false)
    loadLegalText(docType, requestedVersion)
      .then((t) => {
        if (!alive) return
        // A missing document is a failed read, not an empty one. Rendering nothing here would show
        // a legal page with no terms on it, which reads as "there are no terms".
        if (t) setText(t)
        else setLoadFailed(true)
      })
      .catch(() => {
        if (alive) setLoadFailed(true)
      })
    return () => {
      alive = false
    }
  }, [docType, doc, isCurrentVersion, requestedVersion])

  // The tab, the bookmark and the browser history entry. index.html's <title> is a static
  // "Crest Suite", so before this both documents — the two most link-shared, most bookmarked pages
  // in the product — were indistinguishable from each other and from the app, and a screen reader
  // announced nothing on arrival (WCAG 2.4.2, Level A). Same save-and-restore shape as GuestMenu's.
  // printWithTitle composes with it: that swaps in its own title and restores on `afterprint`.
  const pageTitle = doc ? `${doc.title} — ${PRODUCT_NAME}` : `Document not found — ${PRODUCT_NAME}`
  useEffect(() => {
    const previous = document.title
    document.title = pageTitle
    return () => {
      document.title = previous
    }
  }, [pageTitle])

  const toc = useMemo(() => buildToc(text), [text])
  // Rendered without the document's own title and version line, which the page header above already
  // carries. `text` itself is never touched — it is what the Download button hands over and what
  // the hash was taken across.
  const bodyText = useMemo(() => (text ? stripDocFrontMatter(text) : null), [text])

  const printName = doc ? `${PRODUCT_NAME} ${doc.title} v${doc.version}` : PRODUCT_NAME

  /**
   * Hands over the exact bytes the hash was computed from.
   *
   * Without this the published hash is only checkable by someone who can reach the git repo, which
   * is a poor kind of verifiable for a document aimed at a customer's lawyer. Copy-to-clipboard was
   * the other option and is worse: the clipboard normalises line endings on Windows, so the pasted
   * text would hash to something different and the check would fail for a reason nobody could see.
   * A Blob preserves the bytes.
   */
  function downloadSource() {
    if (!text) return
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = doc.filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    // Revoked on the next tick rather than immediately — Safari has not always finished reading
    // the blob by the time click() returns.
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  function copyHash() {
    if (!doc.sha256 || !navigator.clipboard) return
    navigator.clipboard.writeText(doc.sha256).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      },
      () => {}
    )
  }

  // The shell is drawn once, around every state. It used to be skipped on the not-found branch,
  // which left a stale external link landing on a page with no brand, no way to sign in and no
  // footer — the two states that most need the chrome were the two that did without it.
  const shell = (children, plain = false) => (
    <div className="legal-page">
      <nav className="legal-nav" aria-label="Legal documents">
        <div className="legal-brand">
          <Hexagon
            size={22}
            strokeWidth={2.25}
            aria-hidden="true"
            style={{ color: 'var(--theme-accent)', flexShrink: 0 }}
          />
          <span className="legal-brand-name">{PRODUCT_NAME}</span>
        </div>

        <div className="legal-nav-actions">
          {DOC_TYPES.map((t) => (
            <Link
              key={t}
              to={legalPath(t)}
              className={
                t === docType
                  ? 'btn btn-sm legal-nav-link legal-nav-link--current'
                  : 'btn btn-ghost btn-sm legal-nav-link'
              }
              aria-current={t === docType ? 'page' : undefined}
            >
              {legalDoc(t).title}
            </Link>
          ))}
          {/* A Link, not a button calling navigate(): its two neighbours are links to the same kind
              of destination, and a button cannot be middle-clicked or opened in a new tab. */}
          <Link to="/login" className="btn btn-ghost btn-sm legal-nav-link">
            Sign in
          </Link>
        </div>
      </nav>

      <main className={plain ? 'legal-main legal-main--plain' : 'legal-main'}>{children}</main>

      <footer className="legal-footer">
        {/* The provider, not the tenant: this is a copyright line over Crest's own legal text. */}
        <span>
          © {new Date().getFullYear()} {COMPANY.name}
        </span>
        <span className="legal-footer-links">
          <Link to={legalPath('terms')}>Terms of Service</Link>
          <Link to={legalPath('privacy')}>Privacy Policy</Link>
          <Link to="/pricing">Pricing</Link>
          <Link to="/login">Sign in</Link>
        </span>
      </footer>

      {/* Repeats on every printed page — see Legal.css. A filed or posted copy of a contract has to
          be identifiable from any single sheet. */}
      {doc && (
        <div className="legal-print-foot" aria-hidden="true">
          {PRODUCT_NAME} · {doc.title} · v{doc.version} · effective {doc.effectiveAdLabel} · sha256{' '}
          {doc.sha256}
        </div>
      )}
    </div>
  )

  // An unknown document type is a 404, not a blank page. App.js routes bare /legal to the Terms,
  // so the only way here now is a typed or stale address with a segment we do not recognise.
  if (!doc) {
    return shell(
      <>
        <h1 className="legal-doc-title">Document not found</h1>
        <p className="legal-p">
          There is no legal document at this address. The current documents are the{' '}
          <Link className="legal-link" to={legalPath('terms')}>
            Terms of Service
          </Link>{' '}
          and the{' '}
          <Link className="legal-link" to={legalPath('privacy')}>
            Privacy Policy
          </Link>
          .
        </p>
      </>,
      true
    )
  }

  return shell(
    <>
      <header className="legal-doc-head">
        <h1 className="legal-doc-title">{doc.title}</h1>

        {/* On a version we cannot serve, the meta row and the verify panel are deliberately absent:
            both describe the version in FORCE, and printing "Version 1.0 · sha256 2af14e…" on a
            page the reader reached by asking for 0.9 attaches the current document's fingerprint to
            a different document's address. The banner below names the version in force and links
            to it, which is the whole of what this page can honestly say. */}
        {isCurrentVersion && (
          <>
            <div className="legal-meta-row">
              <span className="legal-meta-item">
                <span className="legal-meta-key">Version</span>
                {doc.version}
              </span>
              <span className="legal-meta-item">
                <span className="legal-meta-key">Effective</span>
                {doc.effectiveAdLabel} ({doc.effectiveBsLabel} BS)
              </span>
              <button
                type="button"
                className="btn btn-ghost btn-sm legal-no-print"
                onClick={() => printWithTitle(printName)}
              >
                <Printer size={13} aria-hidden="true" style={{ verticalAlign: -2 }} /> Print / Save
                PDF
              </button>
            </div>

            {/* The content hash used to sit in the row above, beside the version and the effective
                date. It is the wrong altitude for that company: a restaurant owner reading these
                terms has no use for a 64-character digest, while the version and the date are
                exactly what they came to check. It is not removed, because for a lawyer or an
                auditor it is the most load-bearing thing on the page — it is what makes "version
                1.0" mean one specific wording rather than a label anyone could reuse after an edit.
                So it moves one disclosure down, where it costs the ordinary reader nothing and the
                person who needs it can still find it.

                A real <button> with aria-expanded/aria-controls, per the pattern Help.js's
                FeatureCard already uses — not a div with an onClick. */}
            <button
              type="button"
              className="legal-verify-toggle legal-no-print"
              aria-expanded={verifyOpen}
              aria-controls={`legal-verify-${docType}`}
              onClick={() => setVerifyOpen((v) => !v)}
            >
              <ShieldCheck size={13} aria-hidden="true" />
              Verify this document
              <ChevronDown
                size={13}
                aria-hidden="true"
                className={`legal-verify-chev${verifyOpen ? ' legal-verify-chev--open' : ''}`}
              />
            </button>

            {verifyOpen && (
              <div id={`legal-verify-${docType}`} className="legal-verify legal-no-print">
                <p className="legal-verify-lead">
                  Every published version of this document has a SHA-256 fingerprint. Change one
                  character anywhere in it and this value changes completely — so it identifies this
                  exact wording, not just its version number. It is recorded against every
                  acceptance and printed on any signed Subscription Agreement.
                </p>
                <div className="legal-verify-row">
                  <span className="legal-meta-key">SHA-256</span>
                  <code className="legal-verify-hash">{doc.sha256}</code>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={copyHash}>
                    {copied ? (
                      <><Check size={12} aria-hidden="true" style={{ verticalAlign: -2 }} /> Copied</>
                    ) : (
                      <><Copy size={12} aria-hidden="true" style={{ verticalAlign: -2 }} /> Copy</>
                    )}
                  </button>
                </div>
                <p className="legal-verify-lead">
                  To check it yourself, download the exact text this was taken over and hash it:
                </p>
                <pre className="legal-verify-cmd">sha256sum {doc.filename}</pre>
                {/* btn-primary, not a bare `btn`. `.btn` alone carries the box — padding, radius,
                    weight, focus ring — and declares no background or colour at all, so this
                    rendered as browser-default button chrome: #f0f0f0 on black, on a #0f1117 panel.
                    Same silent half-a-job failure the badge classes were fixed for. */}
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={downloadSource}
                  disabled={!text}
                >
                  <Download size={12} aria-hidden="true" style={{ verticalAlign: -2 }} /> Download
                  the exact text
                </button>
                <p className="legal-verify-note">
                  The file downloads with Unix line endings, which is what the hash is taken over —
                  opening it in an editor that converts them and saving would change the result.
                </p>
              </div>
            )}
          </>
        )}
      </header>

      {/* Rendered between the head and the body on every viewport. It used to be the first child of
          .legal-main, which put eighteen section links ahead of the title on a phone — the grid
          hides source order on desktop and hands it straight back the moment the columns collapse.
          Placed explicitly in the grid instead, so the rail keeps the left column and the reading
          order stays title → contents → document. */}
      {toc.length > 0 && (
        <nav className="legal-toc" aria-labelledby="legal-toc-label">
          <h2 className="legal-toc-label" id="legal-toc-label">
            Contents
          </h2>
          {/* The phone's version of the label above: a real disclosure button, shown only below
              900px (Legal.css), where the rail has no gutter of its own and would otherwise stand
              between the title and the first sentence. Two elements rather than one button styled
              two ways, because a button that does nothing on desktop is a control that lies. */}
          <button
            type="button"
            className="legal-toc-toggle"
            aria-expanded={tocOpen}
            aria-controls="legal-toc-list"
            onClick={() => setTocOpen((v) => !v)}
          >
            <span className="legal-toc-toggle-label">Contents</span>
            <span className="legal-toc-count">{toc.length} sections</span>
            <ChevronDown
              size={14}
              aria-hidden="true"
              className={`legal-verify-chev${tocOpen ? ' legal-verify-chev--open' : ''}`}
            />
          </button>
          <ol
            id="legal-toc-list"
            className={`legal-toc-list${tocOpen ? '' : ' legal-toc-list--collapsed'}`}
          >
            {toc.map((s) => (
              <li key={s.id}>
                {/* Choosing a section closes the list on a phone, so the reader lands on the text
                    rather than under the same eighteen links they just scrolled past. Inert on
                    desktop, where the collapsed class has no rule. */}
                <a href={`#${s.id}`} onClick={() => setTocOpen(false)}>
                  {s.label}
                </a>
              </li>
            ))}
          </ol>
        </nav>
      )}

      <article>
        {/* Part E rule 5 of the source spec, made structural: a document still carrying an
            unfilled placeholder must never present itself as being in force. The banner is
            driven by the same detector the build and the tests use, so it cannot be forgotten
            once the values are filled — it disappears on its own. */}
        {draft && (
          <div className="legal-banner legal-banner--draft" role="status">
            <strong>Draft — not yet in force.</strong> This document is still missing details of
            the contracting company and has not been reviewed by a Nepal-licensed lawyer. It is
            published here for review only and does not yet govern any account.
          </div>
        )}

        {!isCurrentVersion && (
          <div className="legal-banner legal-banner--old" role="status">
            <strong>This is not the current version.</strong>{' '}
            {knownPriorVersion
              ? `Version ${requestedVersion} has been superseded.`
              : `Version ${requestedVersion} is not a version of this document that we published.`}{' '}
            Only the wording in force is published here, so the text of {requestedVersion} is not
            shown — asking us for it is the reliable way to get it, at{' '}
            <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>. The version in force is{' '}
            <Link to={legalPath(docType)}>
              {doc.version}, effective {doc.effectiveAdLabel}
            </Link>
            .
          </div>
        )}

        {loadFailed && (
          <div className="legal-banner legal-banner--old" role="alert">
            <strong>This document could not be loaded.</strong> Please reload the page. If it
            keeps happening, email{' '}
            <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> and we will send it
            to you directly.
          </div>
        )}

        {isCurrentVersion && !loadFailed && (
          text === null ? (
            <p className="legal-p legal-loading">Loading…</p>
          ) : (
            <LegalMarkdown text={bodyText} />
          )
        )}
      </article>
    </>
  )
}
