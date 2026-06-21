import { Navigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

export default function ModuleGate({ children, module }) {
  const { isAdmin, imsEnabled, hrEnabled } = useAuth()

  if (isAdmin) return children

  if (module === 'ims' && !imsEnabled) return <Navigate to="/dashboard" replace />
  if (module === 'hr'  && !hrEnabled)  return <Navigate to="/dashboard" replace />

  return children
}
