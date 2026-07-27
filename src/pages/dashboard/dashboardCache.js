// Thin, page-specific wrapper around the shared sessionDataCache — kept so ClientDashboard.jsx's
// existing imports don't need to change. See src/shared/sessionDataCache.js for how this works.
import { readPageCache, writePageCache } from '../../shared/sessionDataCache'

export function readDashboardCache(section, clientId) {
  return readPageCache('dashboard', section, clientId)
}

export function writeDashboardCache(section, clientId, value) {
  writePageCache('dashboard', section, clientId, value)
}
