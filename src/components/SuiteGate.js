import { useNavigate, Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import ModuleMissingCard from './ModuleMissingCard'

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
//
// The module-missing branch is ModuleMissingCard (S683) — shared with ModuleGate, so both name
// the module and both offer a way to act. This gate's own card used to say "Contact your
// consultant" with no phone, email or link: the one gate not on useSupportContact().
export default function SuiteGate({ children, featureKey, featureLabel = 'This feature', requireModules = ['ims', 'hr'] }) {
  const { isAdmin, isOwner, imsEnabled, hrEnabled, posEnabled, suitePlan, hasFeature } = useAuth()
  const navigate = useNavigate()

  const moduleState = { ims: imsEnabled, hr: hrEnabled, pos: posEnabled }
  const missingModules = requireModules.filter(m => !moduleState[m])
  const modulesOk = missingModules.length === 0
  const tierOk = isAdmin || suitePlan === 'pro'
  const overridden = !isAdmin && featureKey && hasFeature(featureKey)

  if (isAdmin || (modulesOk && (tierOk || overridden))) return children

  if (!modulesOk) return <ModuleMissingCard what={featureLabel} modules={missingModules} />

  // A real <button>, not a clickable card. This gate REPLACES the whole page body, so on
  // /owner-dashboard, /owner-report and /group-dashboard it is the only interactive thing in
  // <main> — as a bare onClick div it had no role, no tab stop and no key handler, which left a
  // keyboard user with no route to pricing at all from those three routes. Same shape as
  // PremiumGate's upsell, which never had the bug.
  //
  // Only the OWNER is offered plans: a supervisor reaches Demand Forecast and Fixed Assets by
  // nav (they are Suite-billed but IMS-shaped), and "View plans" for someone who cannot buy is a
  // pitch with no door behind it (S683).
  return (
    <div
      className="card"
      style={{ textAlign: 'center', padding: '48px 24px', borderStyle: 'dashed', borderColor: 'var(--theme-focus-ring)' }}
    >
      <div style={{ fontSize: 32, marginBottom: 12 }} aria-hidden="true">🔒</div>
      <p style={{ fontSize: 15, color: 'var(--theme-accent-ink)', fontWeight: 700, margin: '0 0 8px' }}>Unlock with Crest Suite Pro</p>
      <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: '0 0 20px', lineHeight: 1.6 }}>
        {featureLabel} is part of Crest Suite Pro — the owner layer added on top of your modules.
        {!isOwner && ' It is switched on for the whole outlet, not per login — ask the account owner.'}
      </p>
      {isOwner
        ? <button className="btn btn-primary" onClick={() => navigate('/pricing')}>View plans →</button>
        : <Link to="/dashboard" className="btn btn-ghost" style={{ textDecoration: 'none' }}>Go to Dashboard</Link>}
    </div>
  )
}
