import { useAuth } from '../context/AuthContext'
import { useSettings } from '../context/SettingsContext'
import { useNavigate } from 'react-router-dom'

const PLAN_RANK  = { starter: 0, growth: 1, pro: 2 }
const PLAN_LABEL = { starter: 'Starter', growth: 'Growth', pro: 'Pro' }

// minPlan: 'growth' | 'pro'  (default: 'growth')
// featureKey: still supported as an admin override — Starter clients with a flag set can pass
export default function PremiumGate({ children, featureKey, minPlan = 'growth' }) {
  const { isAdmin, plan, hasFeature } = useAuth()
  const { settings } = useSettings()
  const navigate = useNavigate()

  const meetsMinPlan = isAdmin || (PLAN_RANK[plan] >= PLAN_RANK[minPlan])
  const allowed      = meetsMinPlan || (featureKey && hasFeature(featureKey))

  if (allowed) return children

  const phone      = settings?.contact_phone   || ''
  const email      = settings?.contact_email   || ''
  const website    = settings?.contact_website || ''
  const planNeeded = PLAN_LABEL[minPlan] || 'Growth'

  const upgradeDesc = minPlan === 'pro'
    ? 'Upgrade to unlock Menu Engineering, FIFO/Expiry Tracking, Vendor Report, Supplier Price Tracker, Overheads & P&L, Period Comparison, Theoretical Variance, and Custom Settings.'
    : 'Upgrade to unlock Sales Entry, Recipe Costing, Variance Report, Payment Summary, Budget vs Actual, Best & Worst Sellers, Dead Stock, Recipe Margin, and more.'

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
      <div style={{
        maxWidth: 480, width: '100%',
        background: '#181c27', border: '1px solid rgba(201,168,76,0.25)',
        borderRadius: 12, padding: '40px 36px', textAlign: 'center'
      }}>
        <div style={{
          width: 56, height: 56, borderRadius: '50%',
          background: 'rgba(201,168,76,0.1)', border: '1px solid rgba(201,168,76,0.3)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          margin: '0 auto 20px', fontSize: 24
        }}>🔒</div>

        <h2 style={{ margin: '0 0 8px', fontSize: 20, color: '#e8e0d0', fontFamily: 'Georgia, serif' }}>
          {planNeeded} Plan Required
        </h2>
        <p style={{ fontSize: 14, color: '#6b7280', margin: '0 0 28px', lineHeight: 1.6 }}>
          This module is available on the{' '}
          <strong style={{ color: '#c9a84c' }}>{planNeeded} plan</strong> and above.{' '}
          {upgradeDesc}
        </p>

        <div style={{
          background: '#0f1117', border: '1px solid #2a2f3d',
          borderRadius: 8, padding: '20px 24px', marginBottom: 24, textAlign: 'left'
        }}>
          <p style={{ fontSize: 11, color: '#6b7280', margin: '0 0 12px', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Contact us to upgrade
          </p>
          {phone && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <span style={{ color: '#c9a84c', fontSize: 14 }}>📞</span>
              <a href={`tel:${phone}`} style={{ color: '#e8e0d0', fontSize: 14, textDecoration: 'none' }}>{phone}</a>
            </div>
          )}
          {email && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <span style={{ color: '#c9a84c', fontSize: 14 }}>✉</span>
              <a href={`mailto:${email}`} style={{ color: '#e8e0d0', fontSize: 14, textDecoration: 'none' }}>{email}</a>
            </div>
          )}
          {website && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ color: '#c9a84c', fontSize: 14 }}>🌐</span>
              <a href={website.startsWith('http') ? website : `https://${website}`}
                target="_blank" rel="noopener noreferrer"
                style={{ color: '#e8e0d0', fontSize: 14, textDecoration: 'none' }}>{website}</a>
            </div>
          )}
          {!phone && !email && !website && (
            <p style={{ color: '#4b5563', fontSize: 13, margin: 0 }}>Contact your Crest consultant to upgrade.</p>
          )}
        </div>

        <button className="btn btn-ghost" onClick={() => navigate(-1)} style={{ fontSize: 13 }}>← Go Back</button>
      </div>
    </div>
  )
}
