import { Navigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

export default function ProtectedRoute({ children, adminOnly = false }) {
  const { session, profile, ready } = useAuth()

  if (!ready) {
    return (
      <div style={{
        minHeight: '100vh', background: '#0f1117',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: '#c9a84c', fontSize: 14, letterSpacing: '0.08em'
      }}>
        Loading…
      </div>
    )
  }

  if (!session) return <Navigate to="/login" replace />
  if (adminOnly && profile?.role !== 'admin') return <Navigate to="/dashboard" replace />
  if (!profile) return <Navigate to="/login" replace />

  return children
}
