import { useAuth } from '../context/AuthContext'
import AdminDashboardOverview from './dashboard/AdminDashboardOverview'
import ClientDashboard from './dashboard/ClientDashboard'

export default function Dashboard() {
  const { isAdmin, adminViewClientId } = useAuth()
  const showAdminDash = isAdmin && !adminViewClientId
  return showAdminDash ? <AdminDashboardOverview /> : <ClientDashboard />
}
