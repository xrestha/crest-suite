// Help → Legal: the in-app home for the Terms and Privacy Policy, and the tenant's own record of
// what it accepted and when.
//
// Why it lives on Help rather than Settings, which is where the plan first put it: /settings is
// wrapped in ModuleGate module="ims", so a POS-only or HR-only client cannot reach it at all. A
// legal record has to be reachable by every tenant regardless of which modules they bought, and
// /help is the one in-app page with no module or plan gate on it — reachable from the sidebar rail
// on every screen in the product.
//
// Lazy-loaded from Help.js so its query and markup are not in the chunk every other tab pays for.

import { useEffect, useState } from 'react'

import { useAuth } from '../../context/AuthContext'
import { supabase } from '../../supabaseClient'
import { withTimeout } from '../../utils/withTimeout'
import ActionError, { asActionError } from '../../components/ActionError'
import Tip from '../../components/Tip'
import { nepalTime, nepalDateLong, nepalBsLong } from '../../shared/nepalTime'
import { DOC_TYPES, legalDoc, legalPath, legalVersionPath, isDraft } from '../../legal'

const METHOD_LABEL = {
  clickwrap_trial: 'Accepted online at signup',
  clickwrap_reaccept: 'Accepted online',
  signed_paper: 'Signed paper agreement',
}

const DOC_LABEL = {
  terms: 'Terms of Service',
  privacy: 'Privacy Policy',
  subscription_agreement: 'Subscription Agreement',
}

export default function LegalTab() {
  const { clientId, isAdmin, isOwner } = useAuth()

  const [rows, setRows] = useState(null)
  const [loadError, setLoadError] = useState(null)

  // Staff accounts are fenced off this table by four RESTRICTIVE policies, and a restrictive
  // SELECT filter returns { data: [], error: null } — indistinguishable from "nothing accepted".
  // So the UI decides who is shown the history rather than letting an empty result speak, which
  // would read to a waiter as "this business has agreed to nothing".
  const maySeeHistory = isAdmin || isOwner

  useEffect(() => {
    if (!maySeeHistory || !clientId) return undefined
    let alive = true
    setRows(null)
    setLoadError(null)
    ;(async () => {
      try {
        const { data, error } = await withTimeout(
          supabase
            .from('legal_acceptances')
            .select('id, doc_type, doc_version, content_sha256, method, accepted_at, ip_address, signatory_name, signatory_title, signed_on_date, stamped, user_email')
            .eq('client_id', clientId)
            .order('accepted_at', { ascending: false }),
          20000,
          'Loading your acceptance history'
        )
        if (!alive) return
        // A failed read is not an empty history. The distinction matters more here than almost
        // anywhere else in the product: an empty table on this page is a claim about whether a
        // contract exists.
        if (error) setLoadError(asActionError(error, 'operator'))
        else setRows(data || [])
      } catch (e) {
        if (alive) setLoadError(asActionError(e, 'operator'))
      }
    })()
    return () => { alive = false }
  }, [clientId, maySeeHistory])

  return (
    <div>
      {/* ── The documents ─────────────────────────────────────────────────────────────────── */}
      <h2 style={{ fontSize: 17, fontWeight: 700, margin: '0 0 6px', color: 'var(--theme-text1)' }}>
        Our agreements with you
      </h2>
      <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: '0 0 18px', lineHeight: 1.65 }}>
        These are the documents that govern your use of Crest Suite. Each one carries a version, an
        effective date and a content hash, so the text you agreed to can always be identified
        exactly. Each opens with a short plain-language summary; the numbered sections beneath it
        are the agreement itself.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14, marginBottom: 34 }}>
        {DOC_TYPES.map((t) => {
          const doc = legalDoc(t)
          return (
            <div key={t} className="card" style={{ padding: '16px 18px' }}>
              <a
                href={legalPath(t)}
                target="_blank"
                rel="noopener noreferrer"
                style={{ fontSize: 15, fontWeight: 700, color: 'var(--theme-accent-ink)', textDecoration: 'underline', textUnderlineOffset: 2 }}
              >
                {doc.title} ↗
              </a>
              <div style={{ fontSize: 12, color: 'var(--theme-text2)', marginTop: 8, lineHeight: 1.7 }}>
                <div>Version {doc.version}</div>
                <div>Effective {doc.effectiveAdLabel} ({doc.effectiveBsLabel} BS)</div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 4 }}>
                  <Tip text="A SHA-256 fingerprint of the document text. If even one character of the document changed, this would change too — so it is how you or your lawyer can confirm the copy you hold is the copy we published.">
                    <span style={{ fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--theme-text3)', fontWeight: 700 }}>
                      Hash
                    </span>
                  </Tip>
                  <code style={{ fontFamily: "source-code-pro, Menlo, Monaco, Consolas, 'Courier New', monospace", fontSize: 11, color: 'var(--theme-text2)' }}>
                    {doc.sha256 ? `${doc.sha256.slice(0, 12)}…` : '—'}
                  </code>
                </div>
              </div>
              {/* badge-sentence: the badge classes carry `text-transform: capitalize`, which is
                  right for a one-word status and turned this into "Draft — Not Yet In Force". */}
              {isDraft(t) && (
                <div className="badge-amber badge-sentence" style={{ marginTop: 10, display: 'inline-block' }}>
                  Draft — not yet in force
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* ── The record ────────────────────────────────────────────────────────────────────── */}
      <h2 style={{ fontSize: 17, fontWeight: 700, margin: '0 0 6px', color: 'var(--theme-text1)' }}>
        Your acceptance record
      </h2>
      <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: '0 0 16px', lineHeight: 1.65 }}>
        Every acceptance is recorded permanently and cannot be edited or deleted, by you or by us.
        This is the evidence that the agreement exists.
      </p>

      {!maySeeHistory ? (
        <p style={{ fontSize: 13, color: 'var(--theme-text3)', lineHeight: 1.65 }}>
          Only the account owner can see the acceptance record, because it names the person who
          signed and the address they signed from. The documents above are open to everyone.
        </p>
      ) : loadError ? (
        <ActionError error={loadError} className="action-error--top" />
      ) : rows === null ? (
        <p style={{ fontSize: 13, color: 'var(--theme-text3)' }}>Loading…</p>
      ) : rows.length === 0 ? (
        <p style={{ fontSize: 13, color: 'var(--theme-text3)', lineHeight: 1.65 }}>
          No acceptance is on record for this account yet. If your account was created before we
          published these documents, we will ask you to accept them the next time they change.
        </p>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Document</th>
                <th>Version</th>
                <th>How</th>
                <th>Who</th>
                <th>When</th>
                <th>
                  <Tip text="The public address the acceptance was submitted from, recorded by our servers. For a signed paper agreement this is the address of the Crest staff member who filed it.">
                    <span>From</span>
                  </Tip>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    {/* Links to the exact version accepted, not the current one — the whole point
                        of the row is which text was agreed to. */}
                    <a
                      href={legalVersionPath(r.doc_type, r.doc_version)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn-linklike"
                    >
                      {DOC_LABEL[r.doc_type] || r.doc_type}
                    </a>
                    <span className="cell-sub" style={{ fontFamily: "source-code-pro, Menlo, Monaco, Consolas, 'Courier New', monospace" }}>
                      {r.content_sha256 ? `${r.content_sha256.slice(0, 12)}…` : ''}
                    </span>
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>{r.doc_version}</td>
                  <td>
                    {METHOD_LABEL[r.method] || r.method}
                    {r.method === 'signed_paper' && r.stamped && (
                      <span className="badge-yellow" style={{ marginLeft: 6 }}>Stamped</span>
                    )}
                  </td>
                  <td>
                    {r.signatory_name || r.user_email || '—'}
                    {r.signatory_title && (
                      <span className="cell-sub">{r.signatory_title}</span>
                    )}
                  </td>
                  {/* nepalTime/nepalDateLong rather than toLocaleString: every clock in this
                      product is pinned to Nepal, so an operator reading a client's record from
                      anywhere else sees the time the signer actually saw. Long form, not
                      nepalDateAd's "09/04/2026" — a DD/MM reader takes that as 9 April, and on
                      this table the date is the record.

                      BS underneath, because it is the calendar the reader signs in and the
                      effective dates two cards above already read "3 September 2026 (18 Bhadra
                      2083 BS)". .cell-sub rather than an inline-styled span: an inline colour on a
                      descendant beats @media print's `th, td { color: black }` and prints theme
                      grey on white paper. nowrap on the DATE, not the cell — this column has two
                      long lines and the table has to be able to give width back somewhere. */}
                  <td>
                    <span style={{ whiteSpace: 'nowrap' }}>
                      {r.signed_on_date
                        ? nepalDateLong(`${r.signed_on_date}T00:00:00+05:45`)
                        : nepalDateLong(r.accepted_at)}
                    </span>
                    <span className="cell-sub">
                      {[
                        nepalBsLong(r.signed_on_date ? `${r.signed_on_date}T00:00:00+05:45` : r.accepted_at),
                        r.signed_on_date ? 'signed' : nepalTime(r.accepted_at),
                      ].filter(Boolean).join(' · ')}
                    </span>
                  </td>
                  <td style={{ whiteSpace: 'nowrap', fontFamily: "source-code-pro, Menlo, Monaco, Consolas, 'Courier New', monospace", fontSize: 11 }}>
                    {r.ip_address || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
