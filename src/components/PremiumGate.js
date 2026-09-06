import { useAuth } from '../context/AuthContext'
import { useNavigate } from 'react-router-dom'
import { useSupportContact } from '../shared/hooks/useSupportContact'
import { FEATURE_GROUPS, FEATURE_LABELS } from '../shared/featureCatalog'

const PLAN_RANK  = { starter: 0, growth: 1, pro: 2 }
const PLAN_LABEL = { starter: 'Starter', growth: 'Growth', pro: 'Pro' }

// The other features the needed tier brings, for the sentence under the headline. Derived from
// the catalog rather than a hand-typed list, which had drifted from the tier grid twice.
function alsoIn(tier, exceptLabel) {
  const labels = (FEATURE_GROUPS.find(g => g.tier === tier)?.features || [])
    .map(f => f.label).filter(l => l !== exceptLabel)
  const shown = labels.slice(0, 6)
  const more = labels.length - shown.length
  if (shown.length === 0) return ''
  return shown.join(', ') + (more > 0 ? ` and ${more} more` : '')
}

// minPlan: 'growth' | 'pro'  (default: 'growth')
// featureKey: still supported as an admin override — Starter clients with a flag set can pass.
// Since S683 it also names the feature: the page headlined the PLAN ("Growth Plan Required") and
// buried the thing the reader had just clicked in a ten-item paragraph.
export default function PremiumGate({ children, featureKey, minPlan = 'growth' }) {
  const { isAdmin, isOwner, plan, hasFeature } = useAuth()
  const navigate = useNavigate()
  // Called unconditionally (Rules of Hooks) even on the allowed path, where its result goes
  // unused. The client's own consultant details win when settings.contact_phone/email are set;
  // Crest's own support line fills in otherwise (S673) — this used to fall through to a bare
  // "Contact your Crest consultant to upgrade" with no way to actually do that.
  const { phone, email, website, telHref } = useSupportContact()

  const meetsMinPlan = isAdmin || (PLAN_RANK[plan] >= PLAN_RANK[minPlan])
  const allowed      = meetsMinPlan || (featureKey && hasFeature(featureKey))

  if (allowed) return children

  const planNeeded   = PLAN_LABEL[minPlan] || 'Growth'
  const planCurrent  = PLAN_LABEL[plan] || 'Starter'
  const featureLabel = FEATURE_LABELS[featureKey]
  const rest = alsoIn(minPlan, featureLabel)

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
      <div style={{
        maxWidth: 480, width: '100%',
        background: 'var(--theme-card)', border: '1px solid var(--theme-focus-ring)',
        borderRadius: 'var(--radius-lg)', boxShadow: 'var(--theme-card-shadow)', padding: '40px 36px', textAlign: 'center'
      }}>
        <div style={{
          width: 56, height: 56, borderRadius: '50%',
          background: 'var(--theme-focus-ring)', border: '1px solid var(--theme-focus-ring)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          margin: '0 auto 20px', fontSize: 24
        }} aria-hidden="true">🔒</div>

        <h2 style={{ margin: '0 0 8px', fontSize: 20, color: 'var(--theme-text1)', fontFamily: 'Georgia, serif' }}>
          {featureLabel ? `${featureLabel} is on the ${planNeeded} plan` : `${planNeeded} Plan Required`}
        </h2>
        <p style={{ fontSize: 14, color: 'var(--theme-text2)', margin: '0 0 28px', lineHeight: 1.6 }}>
          Your outlet is on <strong style={{ color: 'var(--theme-accent-ink)' }}>{planCurrent}</strong>.{' '}
          {planNeeded} adds {featureLabel ? <>{featureLabel}{rest ? ' — and ' : ''}</> : null}{rest}.{' '}
          Nothing you already record changes.
        </p>

        {isOwner || isAdmin ? (
          <div style={{
            background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)',
            borderRadius: 'var(--radius-md)', padding: '20px 24px', marginBottom: 24, textAlign: 'left'
          }}>
            <p style={{ fontSize: 11, color: 'var(--theme-text2)', margin: '0 0 12px', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              Contact us to upgrade
            </p>
            {phone && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                <span style={{ color: 'var(--theme-accent-ink)', fontSize: 14 }} aria-hidden="true">📞</span>
                <a href={telHref} style={{ color: 'var(--theme-text1)', fontSize: 14, textDecoration: 'none' }}>{phone}</a>
              </div>
            )}
            {email && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                <span style={{ color: 'var(--theme-accent-ink)', fontSize: 14 }} aria-hidden="true">✉</span>
                <a href={`mailto:${email}`} style={{ color: 'var(--theme-text1)', fontSize: 14, textDecoration: 'none' }}>{email}</a>
              </div>
            )}
            {website && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ color: 'var(--theme-accent-ink)', fontSize: 14 }} aria-hidden="true">🌐</span>
                <a href={website.startsWith('http') ? website : `https://${website}`}
                  target="_blank" rel="noopener noreferrer"
                  style={{ color: 'var(--theme-text1)', fontSize: 14, textDecoration: 'none' }}>{website}</a>
              </div>
            )}
          </div>
        ) : (
          // A staff login cannot upgrade anything; a contact block here is a pitch with no door
          // behind it. Say who can, and stop.
          <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: '0 0 24px' }}>
            A plan is switched on for the whole outlet, not per login — ask the account owner.
          </p>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
          <button className="btn btn-ghost" onClick={() => navigate(-1)} style={{ fontSize: 13 }}>← Go Back</button>
          {(isOwner || isAdmin) && (
            <button className="btn btn-primary" onClick={() => navigate('/pricing')} style={{ fontSize: 13 }}>View plans →</button>
          )}
        </div>
      </div>
    </div>
  )
}
