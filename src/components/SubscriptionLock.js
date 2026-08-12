import { useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { useSettings } from '../context/SettingsContext'
import { Lock } from 'lucide-react'

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
  const { settings } = useSettings()
  const [sending, setSending] = useState(false)

  const clientName = profile?.clients?.name || 'Your account'

  // Every copy variant below ends by asking the client to get in touch, and this screen used to
  // give them no way to do it — no phone, no email, nothing. The details exist in settings and are
  // already rendered by Help.js, which sits behind this very lock. A lapsed invoice here is
  // usually a collection delay rather than a decision to leave (see GRACE_DAYS), so the one screen
  // whose entire job is restarting a conversation must not be the one screen that severs it.
  const phone = settings?.contact_phone || ''
  const email = settings?.contact_email || ''

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
      }}>
        {/* Alpha tint + full-opacity signal text — --theme-red has no paired foreground token
            and ranges from light to dark across the ten presets, so a solid fill is unreadable
            on roughly half of them (DESIGN.md). */}
        <div style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 52, height: 52, borderRadius: 'var(--radius-full)',
          background: 'rgba(248,113,113,0.12)', border: '1px solid rgba(248,113,113,0.3)',
          marginBottom: 18, color: 'var(--theme-red-text)',
        }}><Lock size={22} strokeWidth={2} aria-hidden="true" /></div>

        <h1 style={{
          margin: '0 0 6px', fontSize: 20, fontWeight: 700,
          color: 'var(--theme-text1)', fontFamily: 'Georgia, serif',
        }}>{copy.title}</h1>

        <div style={{ fontSize: 12, color: 'var(--theme-text3)', marginBottom: 16 }}>{clientName}</div>

        <p style={{ margin: '0 0 16px', fontSize: 13, lineHeight: 1.65, color: 'var(--theme-text2)' }}>
          {copy.body}
        </p>

        {/* PRODUCT.md names "what happens to my data if I stop paying?" as a real objection in this
            market, and this is the exact screen where it is live. The answer is already true —
            every client can be exported in full on request — so state it here rather than only in
            the positioning doc. */}
        <p style={{ margin: '0 0 20px', fontSize: 12, lineHeight: 1.6, color: 'var(--theme-text3)' }}>
          Your records are yours. We can export everything to Excel and hand it back on request,
          whatever the state of your subscription.
        </p>

        {(phone || email) && (
          <div style={{
            display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap',
            marginBottom: 20, fontSize: 13,
          }}>
            {phone && (
              <a className="btn btn-ghost" href={`tel:${phone.replace(/\s+/g, '')}`}>Call {phone}</a>
            )}
            {email && (
              <a className="btn btn-ghost" href={`mailto:${email}?subject=${encodeURIComponent(`Reactivate ${clientName}`)}`}>Email us</a>
            )}
          </div>
        )}

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
            /* role="status" belongs on the thing that CHANGES, not on the whole panel — scoped to
               the panel it re-announced the heading, body and both buttons on every internal
               update. */
            <span role="status" style={{ fontSize: 12, fontWeight: 600, color: 'var(--theme-green-text)', alignSelf: 'center' }}>
              ✓ Request sent — we'll be in touch shortly
            </span>
          )}
          <button className="btn btn-ghost" onClick={signOut}>Sign Out</button>
        </div>
      </div>
    </div>
  )
}
