import { lazy } from 'react'
import { useAuth } from '../context/AuthContext'
import ClientDashboard from './dashboard/ClientDashboard'

// The operator's overview is its own chunk: every Owner and staff login lands on this page, and on a
// slow link they should not download the platform admin's screen with their own. Layout's
// <Suspense> around <Outlet /> shows the route fallback while it loads.
const AdminDashboardOverview = lazy(() => import('./dashboard/AdminDashboardOverview'))

export default function Dashboard() {
  const { isAdmin, adminViewClientId, clientId, profile } = useAuth()
  const showAdminDash = isAdmin && !adminViewClientId
  // Keyed on the outlet (S849, GAPS-3): an outlet switch remounts Home, so the new mount seeds from the
  // (already cleared) session cache and shows skeletons, never the previous outlet's figures.
  return showAdminDash ? <AdminDashboardOverview /> : <ClientDashboard key={clientId || profile?.client_id || 'none'} />
}
