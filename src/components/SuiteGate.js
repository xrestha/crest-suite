import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

const SUITE_RANK = { starter: 0, growth: 1, pro: 2 }

const MODULE_LABELS = { ims: 'Crest IMS', hr: 'Crest HR', pos: 'Crest POS' }

// Gates on the Suite bundle axis (clients.suite_plan) + a required module set — independent of
// PremiumGate's per-module plan/hasFeature() machinery. Unlike ModuleGate/PremiumGate, this never
// navigates away on failure: the nav entry must always stay visible, and an ineligible viewer
// lands on an inline explanation/upsell in place instead of being bounced.
// requireModules defaults to ['ims','hr'] — Owner Dashboard's original, unchanged behavior.
// The Monthly Owner/Manager Report passes requireModules={['ims']} instead (every client
// qualifies module-wise, since ims_enabled defaults true — this gate is effectively tier-only in
// practice there, and the report page itself further adapts sections per module beyond that).
export default function SuiteGate({ children, minTier = 'growth', featureKey, featureLabel = 'This feature', requireModules = ['ims', 'hr'] }) {
  const { isAdmin, imsEnabled, hrEnabled, posEnabled, suitePlan, hasFeature } = useAuth()
  const navigate = useNavigate()

  const moduleState = { ims: imsEnabled, hr: hrEnabled, pos: posEnabled }
  const missingModules = requireModules.filter(m => !moduleState[m])
  const modulesOk = missingModules.length === 0
  const tierOk = isAdmin || (SUITE_RANK[suitePlan] ?? -1) >= SUITE_RANK[minTier]
  const overridden = !isAdmin && featureKey && hasFeature(featureKey)

  if (isAdmin || (modulesOk && (tierOk || overridden))) return children

  if (!modulesOk) {
    return (
      <div className="card" style={{ textAlign: 'center', padding: '48px 24px' }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>⊛</div>
        <p style={{ fontSize: 15, color: 'var(--theme-text1)', fontWeight: 600, margin: '0 0 8px' }}>
          {featureLabel} needs {missingModules.map(m => MODULE_LABELS[m]).join(' and ')}
        </p>
        <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: 0 }}>
          Contact your consultant to activate the missing module.
        </p>
      </div>
    )
  }

  return (
    <div
      onClick={() => navigate('/pricing')}
      className="card"
      style={{ textAlign: 'center', padding: '48px 24px', cursor: 'pointer', borderStyle: 'dashed', borderColor: 'rgba(129,140,248,0.4)' }}
    >
      <div style={{ fontSize: 32, marginBottom: 12 }}>🔒</div>
      <p style={{ fontSize: 15, color: '#818cf8', fontWeight: 700, margin: '0 0 8px' }}>Unlock with Crest Suite Growth</p>
      <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: 0 }}>
        {featureLabel} is part of the Suite bundle — cross-module data across {requireModules.map(m => MODULE_LABELS[m]).join(', ')}. View plans →
      </p>
    </div>
  )
}
