import { Navigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import SubscriptionLock from './SubscriptionLock'
import LegalReacceptance from './LegalReacceptance'

export default function ProtectedRoute({ children, adminOnly = false }) {
  const { session, profile, ready, loading, accessLocked, legalReacceptRequired } = useAuth()

  // A session whose profile is still loading is NOT a signed-out user. Redirecting to /login
  // there raced Login's own `if (ready && session) -> /dashboard` guard and ping-ponged between
  // the two routes until the fetch landed — "Maximum update depth exceeded" on every sign-in.
  // Falls through to the checks below once the fetch settles, so a genuinely profile-less
  // session (a real fetch failure) still reaches /login rather than hanging here forever.
  if (!ready || (session && !profile && loading)) {
    return (
      <div style={{
        minHeight: '100vh', background: 'var(--theme-bg, #0f1117)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--theme-accent, #c9a84c)', fontSize: 14, letterSpacing: '0.08em'
      }}>
        Loading…
      </div>
    )
  }

  if (!session) return <Navigate to="/login" replace />
  if (adminOnly && profile?.role !== 'admin') return <Navigate to="/dashboard" replace />
  if (!profile) return <Navigate to="/login" replace />
  // An HR self-service account's whole app is /hr/self-service (outside this Layout) — it has
  // no business on any Layout route, and RLS blocks its data there anyway.
  if (profile.hr_self_service) return <Navigate to="/hr/self-service" replace />
  // A lapsed subscription is enforced at this single choke point — every in-app route, IMS/HR/POS
  // alike, mounts through the one <ProtectedRoute><Layout/></ProtectedRoute> in App.js. Admin is
  // already exempted inside accessLocked, so an adminOnly route is unaffected.
  if (accessLocked) return <SubscriptionLock />
  // Same choke point, same reasoning as the lock above: every in-app route mounts through this one
  // ProtectedRoute, so the gate cannot be forgotten on a route added later. It resolves to false
  // for admin, for every staff account type, and whenever the acceptance read failed — only a
  // client Owner with a genuinely outstanding document is held. Ordered AFTER accessLocked because
  // a lapsed client has a more immediate problem than an unaccepted document, and being asked to
  // agree to terms for a product you currently cannot open reads as a demand rather than a notice.
  if (legalReacceptRequired) return <LegalReacceptance />

  return children
}
