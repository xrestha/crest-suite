import { useAuth } from '../context/AuthContext'
import AdminDashboardOverview from './dashboard/AdminDashboardOverview'
import ClientDashboard from './dashboard/ClientDashboard'

export default function Dashboard() {
  const { isAdmin, adminViewClientId, clientId, profile } = useAuth()
  const showAdminDash = isAdmin && !adminViewClientId
  // Keyed on the outlet (S849, GAPS-3): an outlet switch remounts Home, so the new mount seeds from the
  // (already cleared) session cache and shows skeletons, never the previous outlet's figures.
  return showAdminDash ? <AdminDashboardOverview /> : <ClientDashboard key={clientId || profile?.client_id || 'none'} />
}
