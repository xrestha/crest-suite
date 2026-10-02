// Which modules the main Dashboard shows, and whether that page is a cross-module Home (S800).
//
// One definition for two readers. ClientDashboard decides from it which module sections to render;
// Layout decides from it whether the top bar carries a Home tab and whether the IMS tab opens the
// Inventory Dashboard or the main Dashboard. If the two disagreed, a client could get a Home tab
// that opens a single-module page, or lose the IMS charts with no Inventory Dashboard to find them
// on. A section needs the module switched on for the client AND this login's own rank in it: the
// staff-isolation policies return an empty read rather than an error, so a section shown to a
// login without the rank renders confident zeros (S750).
export function dashboardModules({ clientModules, hasImsAccess, hasHrAccess, hasPosAccess }) {
  return {
    ims: !!clientModules?.ims && hasImsAccess('staff'),
    hr: !!clientModules?.hr && hasHrAccess('staff'),
    pos: !!clientModules?.pos && hasPosAccess('staff'),
  }
}

// Two or more module sections make /dashboard a Home: one column of headline cards per module, with
// each module's charts on that module's own dashboard. With one, /dashboard IS that module's
// dashboard, exactly as before S800, and there is no Home tab to go with it.
export function isOverviewHome(modules) {
  return [modules.ims, modules.hr, modules.pos].filter(Boolean).length >= 2
}

export const IMS_DASHBOARD_PATH = '/ims/dashboard'
