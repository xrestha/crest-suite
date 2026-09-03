// The blocking gate an Owner sees when a new version of the Terms or Privacy Policy demands a
// fresh acceptance.
//
// A FULL PAGE, not a Modal, and that is not a style choice. `Modal` closes on Escape and on a
// backdrop click, unconditionally — there is no `dismissible={false}`. A gate built on it would be
// dismissible by pressing one key, which is not a gate. `SubscriptionLock` is the existing pattern
// for "render this INSTEAD of the app", and this follows it exactly, Sign Out included: a person
// who does not want to accept must still be able to leave.
//
// Mounted from ProtectedRoute, which is the single choke point every in-app route passes through.
// Deliberately NOT added per-page — a per-page gate reopens the whole product the first time
// somebody adds a route and forgets, which is exactly how clients.is_active came to mean nothing.

import { useState } from 'react'
import { ScrollText, ExternalLink } from 'lucide-react'

import { useAuth } from '../context/AuthContext'
import { supabase } from '../supabaseClient'
import { withTimeout } from '../utils/withTimeout'
import ActionError, { asActionError } from './ActionError'
import { docsRequiringReacceptance, acceptancePayload, legalPath } from '../legal'

export default function LegalReacceptance() {
  const { signOut, refreshProfile } = useAuth()
  const [checked, setChecked] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const pending = docsRequiringReacceptance()

  async function accept() {
    if (!checked || busy) return
    setBusy(true)
    setError(null)
    try {
      // withTimeout because a supabase-js call can hang forever: every call awaits
      // getAccessToken() before it reaches fetch(), so when the auth layer stalls the promise
      // neither resolves nor rejects and the `finally` that clears `busy` never runs. On a screen
      // whose only control is this button, that is a permanently dead page.
      const { data, error: fnErr } = await withTimeout(
        supabase.functions.invoke('admin-user-ops', {
          body: {
            action: 'record_legal_acceptance',
            accepted_legal: acceptancePayload(pending.map((d) => d.docType)),
          },
        }),
        20000,
        'Recording your acceptance'
      )
      if (fnErr) throw fnErr
      if (data?.error) throw new Error(data.error)

      // Re-read the profile so the gate clears from the same state that raised it, rather than
      // being hidden by local state that the next page load would contradict.
      await refreshProfile()
    } catch (e) {
      setError(asActionError(e, 'operator'))
      setBusy(false)
    }
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--theme-bg)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div className="card" style={{ maxWidth: 620, width: '100%', padding: '32px 30px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
          <ScrollText size={26} aria-hidden="true" style={{ color: 'var(--theme-accent)' }} />
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: 'var(--theme-text1)' }}>
            We&apos;ve updated our terms
          </h1>
        </div>

        <p
          style={{
            margin: '0 0 18px',
            fontSize: 14,
            lineHeight: 1.65,
            color: 'var(--theme-text2)',
          }}
        >
          {pending.length > 1
            ? 'These documents have changed since you last accepted them. Please review and accept them to continue using Crest Suite.'
            : 'This document has changed since you last accepted it. Please review and accept it to continue using Crest Suite.'}
        </p>

        <ul style={{ listStyle: 'none', margin: '0 0 20px', padding: 0 }}>
          {pending.map((d) => (
            <li
              key={d.docType}
              style={{
                border: '1px solid var(--theme-border)',
                borderRadius: 'var(--radius-md)',
                padding: '12px 14px',
                marginBottom: 10,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <a
                  href={legalPath(d.docType)}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    fontSize: 14,
                    fontWeight: 600,
                    color: 'var(--theme-accent-ink)',
                    textDecoration: 'underline',
                    textUnderlineOffset: 2,
                  }}
                >
                  {d.title} <ExternalLink size={12} aria-hidden="true" style={{ verticalAlign: -1 }} />
                </a>
                <span style={{ fontSize: 11, color: 'var(--theme-text3)' }}>
                  Version {d.version} · effective {d.effectiveAdLabel}
                </span>
              </div>
              {/* Only rendered when there is one. A "What changed" heading over an empty box is a
                  worse answer than not offering the summary at all. */}
              {d.changeSummary && (
                <p style={{ margin: '8px 0 0', fontSize: 13, lineHeight: 1.55, color: 'var(--theme-text2)' }}>
                  {d.changeSummary}
                </p>
              )}
            </li>
          ))}
        </ul>

        {/* Label wraps the control, so it is associated without htmlFor and the whole sentence is
            the hit target. */}
        <label
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 10,
            fontSize: 14,
            lineHeight: 1.55,
            color: 'var(--theme-text1)',
            cursor: 'pointer',
            marginBottom: 20,
          }}
        >
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
            style={{ width: 16, height: 16, flexShrink: 0, marginTop: 2, accentColor: 'var(--theme-accent)', cursor: 'pointer' }}
          />
          <span>
            I have read and agree to {pending.length > 1 ? 'these documents' : 'this document'} on
            behalf of my business.
          </span>
        </label>

        {error && <ActionError error={error} />}

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 4 }}>
          <button type="button" className="btn btn-primary" onClick={accept} disabled={!checked || busy}>
            {busy ? 'Recording…' : 'Accept and continue'}
          </button>
          {/* Leaving must stay possible. A gate with no exit is a lockout. */}
          <button type="button" className="btn btn-ghost" onClick={signOut} disabled={busy}>
            Sign out
          </button>
        </div>

        <p style={{ margin: '18px 0 0', fontSize: 11, lineHeight: 1.55, color: 'var(--theme-text3)' }}>
          Only the account owner is asked to accept. Your staff can keep working while this is
          outstanding.
        </p>
      </div>
    </div>
  )
}
