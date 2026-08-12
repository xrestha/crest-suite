import { useState } from 'react'
import { useAuth } from '../context/AuthContext'

// Full-page lock shown in place of the app once a client's subscription has lapsed.
//
// Rendered from ProtectedRoute rather than from any page, so there is exactly one place this
// decision is made — a per-page check would reopen the whole app the first time someone adds a
// route and forgets the guard, which is how clients.is_active ended up enforcing nothing at all.
//
// Sign out stays reachable on purpose: a locked till still needs to hand the device back, and an
// Owner may need to sign in as a different (unlocked) client.
export default function SubscriptionLock() {
  const { accessReason, profile, signOut, subscribeRequested, requestSubscription, trialPurgeInDays } = useAuth()
  const [sending, setSending] = useState(false)

  const clientName = profile?.clients?.name || 'Your account'

  const COPY = {
    trial: {
      title: 'Your free trial has ended',
      body: trialPurgeInDays !== null && trialPurgeInDays > 0
        ? `Your data is safe and will be kept for ${trialPurgeInDays} more day${trialPurgeInDays !== 1 ? 's' : ''}. Subscribe before then and everything you entered during the trial carries straight over.`
        : 'Subscribe to restore access. Contact us about your data — the standard retention window has passed.',
    },
    expired: {
      title: 'Subscription expired',
      body: 'Access has been paused because the subscription for this property has lapsed. Your data has not been deleted — renewing restores everything exactly as you left it.',
    },
    deactivated: {
      title: 'Account deactivated',
      body: 'This account has been deactivated by Crest. Your data has not been deleted. Get in touch and we can reactivate it.',
    },
  }
  const copy = COPY[accessReason] || COPY.expired

  return (
    <div style={{
      minHeight: '100vh', background: 'var(--theme-bg)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
    }}>
      <div style={{
        maxWidth: 520, width: '100%', background: 'var(--theme-card)',
        border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-lg)',
        padding: '32px 34px', textAlign: 'center',
      }} role="status">
        {/* Alpha tint + full-opacity signal text — --theme-red has no paired foreground token
            and ranges from light to dark across the ten presets, so a solid fill is unreadable
            on roughly half of them (DESIGN.md). */}
        <div style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 52, height: 52, borderRadius: 'var(--radius-full)',
          background: 'rgba(248,113,113,0.12)', border: '1px solid rgba(248,113,113,0.3)',
          fontSize: 24, marginBottom: 18,
        }}>🔒</div>

        <h1 style={{
          margin: '0 0 6px', fontSize: 20, fontWeight: 700,
          color: 'var(--theme-text1)', fontFamily: 'Georgia, serif',
        }}>{copy.title}</h1>

        <div style={{ fontSize: 12, color: 'var(--theme-text3)', marginBottom: 16 }}>{clientName}</div>

        <p style={{ margin: '0 0 24px', fontSize: 13, lineHeight: 1.65, color: 'var(--theme-text2)' }}>
          {copy.body}
        </p>

        <div style={{
          display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap',
          paddingTop: 20, borderTop: '1px solid var(--theme-border-lt)',
        }}>
          {!subscribeRequested ? (
            <button
              className="btn btn-primary"
              disabled={sending}
              onClick={async () => { setSending(true); await requestSubscription(); setSending(false) }}
            >
              {sending ? 'Sending…' : 'I Want to Subscribe →'}
            </button>
          ) : (
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--theme-green)', alignSelf: 'center' }}>
              ✓ Request sent — we'll be in touch shortly
            </span>
          )}
          <button className="btn btn-ghost" onClick={signOut}>Sign Out</button>
        </div>
      </div>
    </div>
  )
}
