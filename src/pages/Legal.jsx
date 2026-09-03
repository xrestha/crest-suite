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

import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, Link } from 'react-router-dom'
import { Hexagon, Printer, Check, Copy, ChevronDown, Download, ShieldCheck } from 'lucide-react'

import { useSettings } from '../context/SettingsContext'
import { printWithTitle } from '../utils/printTitle'
import LegalMarkdown from '../legal/LegalMarkdown'
// The one support address (src/shared/supportContact.js re-exports legal's own COMPANY.supportEmail)
// — this used to be a hardcoded mailto: link to "support@" the crestsuite .com domain, which the
// project does not own (see supportAddress.test.js, which asserts that link never comes back).
import { SUPPORT_EMAIL } from '../shared/supportContact'
import {
  DOC_TYPES,
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
  const navigate = useNavigate()
  const { settings } = useSettings()

  const [text, setText] = useState(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [copied, setCopied] = useState(false)
  const [verifyOpen, setVerifyOpen] = useState(false)

  const doc = DOC_TYPES.includes(docType) ? legalDoc(docType) : null

  useEffect(() => {
    let alive = true
    if (!doc) return undefined
    setText(null)
    setLoadFailed(false)
    loadLegalText(docType)
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
  }, [docType, doc])

  const toc = useMemo(() => buildToc(text), [text])

  // An unknown document type is a 404, not a blank page. App.js has no catch-all route, so
  // without this an address like /legal/nonsense renders an empty document shell.
  if (!doc) {
    return (
      <div className="legal-page">
        <main className="legal-main" style={{ display: 'block' }}>
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
        </main>
      </div>
    )
  }

  // A version in the URL that is not the current one. PRIOR_VERSIONS is empty until a second
  // version of anything ships, so today this only ever catches a typo or a stale link — but an
  // acceptance row references its version forever, so the branch has to exist before it is needed.
  const requestedVersion = version || doc.version
  const isCurrentVersion = requestedVersion === doc.version
  const knownPriorVersion = Boolean(PRIOR_VERSIONS[`${docType}-${requestedVersion}`])
  const draft = isDraft(docType)

  const printName = `${settings?.app_name || 'Crest Suite'} ${doc.title} v${doc.version}`

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

  return (
    <div className="legal-page">
      <nav className="legal-nav">
        <div className="legal-brand">
          {settings?.logo_url ? (
            <img
              src={settings.logo_url}
              alt=""
              style={{ width: 22, height: 22, objectFit: 'contain', borderRadius: 4, flexShrink: 0 }}
            />
          ) : (
            <Hexagon
              size={22}
              strokeWidth={2.25}
              aria-hidden="true"
              style={{ color: 'var(--theme-accent)', flexShrink: 0 }}
            />
          )}
          <span className="legal-brand-name">{settings?.app_name || 'Crest Suite'}</span>
        </div>

        <div className="legal-nav-actions">
          {DOC_TYPES.map((t) => (
            <Link
              key={t}
              to={legalPath(t)}
              className={t === docType ? 'btn btn-sm' : 'btn btn-ghost btn-sm'}
              aria-current={t === docType ? 'page' : undefined}
            >
              {legalDoc(t).title}
            </Link>
          ))}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate('/login')}>
            Sign in →
          </button>
        </div>
      </nav>

      <main className="legal-main">
        <aside className="legal-toc" aria-label="Contents">
          <div className="legal-toc-label">Contents</div>
          {toc.map((s) => (
            <a key={s.id} href={`#${s.id}`}>
              {s.label}
            </a>
          ))}
        </aside>

        <article>
          <header className="legal-doc-head">
            <h1 className="legal-doc-title">{doc.title}</h1>
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
                <button
                  type="button"
                  className="btn btn-sm"
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
          </header>

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
              The version in force is{' '}
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

          {text === null && !loadFailed ? (
            <p className="legal-p" style={{ color: 'var(--theme-text3)' }}>
              Loading…
            </p>
          ) : (
            text && <LegalMarkdown text={text} />
          )}
        </article>
      </main>

      <footer className="legal-footer">
        <span>
          © {new Date().getFullYear()} {settings?.app_name || 'Crest Suite'}
        </span>
        <span style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
          <Link to={legalPath('terms')}>Terms of Service</Link>
          <Link to={legalPath('privacy')}>Privacy Policy</Link>
          <Link to="/pricing">Pricing</Link>
          <Link to="/login">Sign in</Link>
        </span>
      </footer>

      {/* Repeats on every printed page — see Legal.css. A filed or posted copy of a contract has to
          be identifiable from any single sheet. */}
      <div className="legal-print-foot" aria-hidden="true">
        {settings?.app_name || 'Crest Suite'} · {doc.title} · v{doc.version} · effective{' '}
        {doc.effectiveAdLabel} · sha256 {doc.sha256}
      </div>
    </div>
  )
}
