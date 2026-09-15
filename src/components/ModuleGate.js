import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { STATION_TEAM_HOME } from '../shared/posTeamAccess'

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
 */
export default function ModuleGate({ children, module, anyOf }) {
  const { isAdmin, imsEnabled, hrEnabled, posEnabled, customizationEnabled, canReachPosPath } = useAuth()
  const { pathname } = useLocation()

  if (isAdmin) return children

  const enabled = { ims: imsEnabled, hr: hrEnabled, pos: posEnabled, customization: customizationEnabled }
  const modules = anyOf || [module]
  if (!modules.some(m => enabled[m])) return <Navigate to="/dashboard" replace />

  // Customization (S758) is POS-side work, so a station team is fenced from it exactly as from
  // any POS route it is not allowlisted for.
  if ((modules.includes('pos') || modules.includes('customization')) && !canReachPosPath(pathname)) return <Navigate to={STATION_TEAM_HOME} replace />

  return children
}
