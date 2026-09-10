/**
 * Which paths an IMS PIN count account may reach.
 *
 * WHY (S737): a PIN count account exists to do one job on a shared store-room tablet — enter a
 * closing count — and is created by a manager who is handing out a 4-digit PIN, not a login. It
 * carries `ims_role = 'staff'`, which on its own would open Purchases, Gate Passes, Sales Entry
 * and Requisitions to anyone who picks the tablet up.
 *
 * Deliberately modelled on `posTeamAccess.js` rather than invented: one predicate, read by the
 * sidebar and the command palette (through `isItemVisible`) AND by `ProtectedRoute`, so a page
 * nobody has written yet is already unreachable — which is what fail-closed has to mean. The
 * enforcement sits in `ProtectedRoute` rather than `ModuleGate` because `/dashboard` carries no
 * `ModuleGate` at all: the count tablet would otherwise have landed on the client's revenue.
 *
 * Help is on the list on purpose. It reads no client data, and the person most likely to need
 * "how do I count a sub-recipe" is the one holding the tablet.
 */
export const IMS_COUNT_ALLOWED_PATHS = ['/stock', '/help']

/** Where a count account is sent when it lands somewhere it cannot use. */
export const IMS_COUNT_HOME = '/stock'

/** Whether a count-only account may reach `path`. Every other account reaches everything. */
export function imsCountPathReachable(countOnly, path) {
  if (!countOnly) return true
  return IMS_COUNT_ALLOWED_PATHS.includes(path)
}
