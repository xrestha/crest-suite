import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

const MODULE_LABELS = { ims: 'Crest IMS', hr: 'Crest HR', pos: 'Crest POS' }

// Gates on the Crest Suite Pro axis (clients.suite_plan) + a required module set — independent of
// PremiumGate's per-module plan/hasFeature() machinery. Unlike ModuleGate/PremiumGate, this never
// navigates away on failure: the nav entry must always stay visible, and an ineligible viewer
// lands on an inline explanation/upsell in place instead of being bounced.
//
// Suite has ONE tier. It used to carry starter/growth/pro ranks, but both call sites were
// minTier="growth" — so Suite Starter unlocked nothing at all, and Suite Pro added nothing over
// Suite Growth on its own axis. suite_plan is now NULL | 'pro' and this is a flat check.
//
// requireModules defaults to ['ims','hr'] — Owner Dashboard's original, unchanged behavior.
// Monthly Owner/Manager Report, Demand Forecast and Fixed Assets pass ['ims'] instead.
export default function SuiteGate({ children, featureKey, featureLabel = 'This feature', requireModules = ['ims', 'hr'] }) {
  const { isAdmin, imsEnabled, hrEnabled, posEnabled, suitePlan, hasFeature } = useAuth()
  const navigate = useNavigate()

  const moduleState = { ims: imsEnabled, hr: hrEnabled, pos: posEnabled }
  const missingModules = requireModules.filter(m => !moduleState[m])
  const modulesOk = missingModules.length === 0
  const tierOk = isAdmin || suitePlan === 'pro'
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
      style={{ textAlign: 'center', padding: '48px 24px', cursor: 'pointer', borderStyle: 'dashed', borderColor: 'var(--theme-focus-ring)' }}
    >
      <div style={{ fontSize: 32, marginBottom: 12 }}>🔒</div>
      <p style={{ fontSize: 15, color: 'var(--theme-accent)', fontWeight: 700, margin: '0 0 8px' }}>Unlock with Crest Suite Pro</p>
      <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: 0 }}>
        {featureLabel} is part of Crest Suite Pro — the owner layer added on top of your modules. View plans →
      </p>
    </div>
  )
}
