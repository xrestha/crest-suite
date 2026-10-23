import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { STATION_TEAM_HOME } from '../shared/posTeamAccess'
import ModuleMissingCard from './ModuleMissingCard'

/**
 * Module-level route guard: is the module this route belongs to switched on for the client?
 *
 * `module` names one. `anyOf` names several, for a route two modules share — /menu-pricing is
 * reached from both the IMS and the POS nav and was the one in-app route with no ModuleGate at
 * all, so an HR-only client could type its way onto the POS-only branch (S683).
 *
 * A POS route also asks `canReachPosPath`: a kitchen/bar account (`pos_team`) may reach the KDS
 * and nothing else, and until S683 that allowlist lived only in the sidebar — a nav condition,
 * not a guard. It now sits here, on every POS route, so a page nobody has written yet is already
 * unreachable to a station team. See shared/posTeamAccess.js. Admin passes everything, as before.
 *
 * The IMS PIN count account (S737) is the same shape on the IMS side, but its guard is in
 * `ProtectedRoute`, not here — `/dashboard` carries no ModuleGate, so this file is not a choke
 * point for it. See shared/imsCountAccess.js.
 *
 * S862 ADD-7: a module that is off renders ModuleMissingCard in place, as the S683 rule promised and
 * SuiteGate already did. It was a silent `<Navigate to="/dashboard">`, so an Owner opening a bookmarked
 * Customization page after it lapsed landed on the dashboard told nothing. ProtectedRoute holds every
 * route until the profile has loaded, and the operator, whose viewed switches load later, passes
 * above. A client row that failed to load leaves every switch reading off (clientKnown false), and
 * that is 'unknown', never 'missing': a paying Owner on a weak connection must not be told to buy the
 * module (SuiteGate's ACCESS-11 rule). Layout says the same in its banner.
 */
export function moduleGateOutcome(auth, modules, pathname) {
  const { isAdmin, imsEnabled, hrEnabled, posEnabled, customizationEnabled, canReachPosPath } = auth
  if (isAdmin) return { kind: 'pass' }
  // Customization (S758) is POS-side work, so a station team is fenced from it exactly as from
  // any POS route it is not allowlisted for. Asked before the module, so a kitchen login is never
  // told to have a module switched on for a page it could not open anyway.
  if ((modules.includes('pos') || modules.includes('customization')) && !canReachPosPath(pathname)) return { kind: 'station' }
  if (auth.clientKnown === false) return { kind: 'unknown' }
  const enabled = { ims: imsEnabled, hr: hrEnabled, pos: posEnabled, customization: customizationEnabled }
  if (!modules.some(m => enabled[m])) return { kind: 'missing', missing: modules.filter(m => !enabled[m]) }
  return { kind: 'pass' }
}

export default function ModuleGate({ children, module, anyOf }) {
  const auth = useAuth()
  const { pathname } = useLocation()
  const modules = anyOf || [module]
  const outcome = moduleGateOutcome(auth, modules, pathname)

  if (outcome.kind === 'station') return <Navigate to={STATION_TEAM_HOME} replace />
  if (outcome.kind === 'unknown') {
    return (
      <div className="card" role="status" style={{ textAlign: 'center', padding: '48px 24px' }}>
        <p style={{ fontSize: 15, color: 'var(--theme-text1)', fontWeight: 700, margin: '0 0 8px' }}>
          Could not check which modules are on for this outlet
        </p>
        <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: '0 0 20px', lineHeight: 1.6 }}>
          The details of this outlet did not load, so this page cannot open yet. Nothing has changed. Reload the page to try again.
        </p>
        <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>Reload the page</button>
      </div>
    )
  }
  if (outcome.kind === 'missing') return <ModuleMissingCard modules={outcome.missing} anyOf={!!anyOf} />
  return children
}
