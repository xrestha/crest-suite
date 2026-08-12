import { Navigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import SubscriptionLock from './SubscriptionLock'

export default function ProtectedRoute({ children, adminOnly = false }) {
  const { session, profile, ready, accessLocked } = useAuth()

  if (!ready) {
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

  return children
}
