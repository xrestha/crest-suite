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
import { Hexagon, Printer, Check, Copy } from 'lucide-react'

import { useSettings } from '../context/SettingsContext'
import { printWithTitle } from '../utils/printTitle'
import LegalMarkdown from '../legal/LegalMarkdown'
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

  const shortHash = doc.sha256 ? doc.sha256.slice(0, 12) : '—'
  const printName = `${settings?.app_name || 'Crest Suite'} ${doc.title} v${doc.version}`

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
              <span className="legal-meta-item">
                <span className="legal-meta-key">SHA-256</span>
                <button
                  type="button"
                  className="legal-hash"
                  onClick={copyHash}
                  title={doc.sha256 || ''}
                  aria-label={`Copy the full SHA-256 hash of this document. Begins ${shortHash}.`}
                >
                  {copied ? (
                    <>
                      <Check size={11} aria-hidden="true" style={{ verticalAlign: -1 }} /> copied
                    </>
                  ) : (
                    <>
                      {shortHash}…{' '}
                      <Copy size={11} aria-hidden="true" style={{ verticalAlign: -1 }} />
                    </>
                  )}
                </button>
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
              <a href="mailto:support@crestsuite.com">support@crestsuite.com</a> and we will send it
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
