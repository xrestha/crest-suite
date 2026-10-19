// The consequence copy for an outlet-group change in Admin → Clients → Manage → Billing (S849
// GROUP-11). Joining a group hands every member's Owner the reach of an Owner into this client —
// sales, payroll, closed months, staff — and this client's Owner theirs, so the drawer asks first and
// says exactly that, by name. Pure, so the sentences are tested rather than read off a screenshot.
import { andList } from '../../shared/offeredPicks'

/**
 * @param {object} p
 * @param {string} p.clientName   the client being moved
 * @param {object|null} p.fromGroup  { id, name, hq_client_id } it is in now, or null
 * @param {object|null} p.toGroup    { id, name } it is moving to, or null to leave
 * @param {string[]} p.fromOthers names of the OTHER outlets of fromGroup
 * @param {string[]} p.toOthers   names of the OTHER outlets of toGroup
 * @param {string} p.clientId
 * @returns {{ title: string, body: string[], confirmLabel: string }}
 */
export function groupChangeCopy({ clientName, clientId, fromGroup, toGroup, fromOthers = [], toOthers = [] }) {
  const name = clientName || 'This client'
  const body = []
  if (fromGroup) {
    body.push(fromOthers.length
      ? `${name} leaves ${fromGroup.name}; its Owner can no longer open ${andList(fromOthers)}, and theirs can no longer open it.`
      : `${name} leaves ${fromGroup.name}.`)
    if (fromGroup.hq_client_id && fromGroup.hq_client_id === clientId) {
      body.push(`${name} is ${fromGroup.name}'s HQ, so ${fromGroup.name} will have no HQ and Push to branches stops until you pick a new one under HQ outlet.`)
    }
  }
  if (toGroup) {
    body.push(toOthers.length
      ? `Owners of ${andList(toOthers)} will be able to open ${name} as its Owner — sales, payroll, closed months, staff — and ${name}'s Owner theirs.`
      : `${toGroup.name} has no other outlets yet, so nobody else reaches ${name} until one joins.`)
  }
  body.push('Users switched into another outlet are signed back to their own.')
  const title = toGroup
    ? `Put ${name} in ${toGroup.name}?`
    : `Take ${name} out of ${fromGroup?.name || 'its group'}?`
  const confirmLabel = toGroup ? (fromGroup ? 'Move to this group' : 'Join this group') : 'Leave the group'
  return { title, body, confirmLabel }
}
