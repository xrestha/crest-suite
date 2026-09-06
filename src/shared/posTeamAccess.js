/**
 * Which POS paths a kitchen/bar account may reach.
 *
 * WHY (S683): `pos_team` (S431) marks an account as 'kitchen' or 'bar' — it has no use for the
 * till, the floor, customers or the cash drawer, whatever its `pos_role` rank. Layout.js expressed
 * that as an allowlist on the NAV, with a comment calling it fail-closed. It was fail-closed for
 * the sidebar and for nothing else: `posTeam` reached four files in the whole tree and no POS page
 * read it for access, so a kitchen account typing /pos/orders got the till and, at supervisor
 * rank, /pos/shifts — the cash-drawer reconciliation. A nav condition is not a guard (CLAUDE.md,
 * "a page reachable by URL needs the guard its nav item implies"); this axis had escaped every
 * sweep because it is not a `min*Role` tag.
 *
 * One predicate now, read by the sidebar and the command palette (through `isItemVisible`) AND by
 * `ModuleGate` on every POS route — so a new POS page is unreachable to a station team until
 * someone adds it here, which is what "fail-closed" was supposed to mean.
 */
export const KITCHEN_TEAM_ALLOWED_PATHS = ['/pos/kds']

/** Where a station-team account is sent when it lands somewhere it cannot use. */
export const STATION_TEAM_HOME = '/pos/kds'

export function isStationTeam(posTeam) {
  return posTeam === 'kitchen' || posTeam === 'bar'
}

/** Whether an account on `posTeam` may reach `path`. Every other team reaches everything. */
export function posPathReachable(posTeam, path) {
  if (!isStationTeam(posTeam)) return true
  return KITCHEN_TEAM_ALLOWED_PATHS.includes(path)
}
