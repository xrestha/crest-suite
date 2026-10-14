import { supabase } from '../../../supabaseClient'
import { settleWithin } from '../../../utils/withTimeout'
import { noAnswer } from '../orders/sendAttempt'

// The till's half of kitchen and bar printers (S837; contract in docs/kitchen-printers.md). A ticket
// for a station whose print device is online is queued instead of opening the till's print window;
// the till watches it and, when it has not printed in PRINT_FALLBACK_MS, offers Print here.

export const PRINT_FALLBACK_MS = 20000   // a queued ticket not on paper by now gets the banner
export const ROUTES_REFRESH_MS = 15000   // how often the till re-reads which stations have a device
export const WATCH_POLL_MS     = 5000    // how often an unprinted ticket's state is read
const RPC_MS = 8000

export const stationWord = station => (station === 'BOT' ? 'Bar' : 'Kitchen')

// A database without the S837 functions (a release deployed before its migration) answers this, and
// the till then prints everything itself, as it did before.
const missingFunction = error => ['PGRST202', '42883'].includes(error?.code)

/** Which device prints each station: `{ KOT: { device_id, device_name, online } | null, BOT: … }`.
 *  A failed read answers `error` and no routes, so the caller keeps its last good answer. */
export async function readPrintRoutes(clientId) {
  if (!clientId) return { routes: {}, error: null }
  const { data, error } = await settleWithin(
    supabase.rpc('get_pos_print_routes', { p_client_id: clientId }), RPC_MS, 'Reading the kitchen printers')
  if (error) return missingFunction(error) ? { routes: {}, error: null } : { routes: null, error }
  return { routes: data && typeof data === 'object' ? data : {}, error: null }
}

/** The route a ticket for this station takes, or null when it prints on the till. */
export function onlineRouteFor(routes, station) {
  const r = routes?.[station]
  return r && r.online ? r : null
}

/** Queue jobs. `noAnswer` means it may still have landed: the watch settles that, and Print here's
 *  claim decides who prints, so a ticket cannot come out twice. */
export async function queuePrintJobs(clientId, jobs) {
  const res = await settleWithin(
    supabase.rpc('queue_pos_print_jobs', { p_client_id: clientId, p_jobs: jobs }), RPC_MS, 'Sending the ticket to the printer')
  if (!res.error) return { ok: true }
  return { ok: false, noAnswer: noAnswer(res), error: res.error }
}

export async function readPrintJobStatus(clientId, ids) {
  if (!ids.length) return { rows: [], error: null }
  const { data, error } = await settleWithin(
    supabase.rpc('get_pos_print_job_status', { p_client_id: clientId, p_ids: ids }), RPC_MS, 'Checking the kitchen printer')
  if (error) return { rows: null, error }
  return { rows: Array.isArray(data) ? data : [], error: null }
}

export async function claimPrintJobForTill(clientId, job) {
  return settleWithin(
    supabase.rpc('claim_pos_print_job_for_till', { p_client_id: clientId, p_job: job }), RPC_MS, 'Taking the ticket back to this till')
}

/** What the watch shows for one queued ticket, from its last known state. `entry` is the till's own
 *  record ({ queuedAt, sendFailed }); `row` the server's status row, or undefined when the server has
 *  no such job (yet). Answers { done, needsAction, reason }. */
export function watchVerdict(entry, row, now) {
  if (row?.state === 'printed') return { done: true, needsAction: false, reason: '' }
  if (entry.sendFailed) {
    return { done: false, needsAction: true, reason: 'It could not be sent to the printer computer.' }
  }
  const waited = now - entry.queuedAt >= PRINT_FALLBACK_MS
  const where = row?.device_name || entry.deviceName || 'the printer computer'
  switch (row?.state) {
    case 'printing':
      return { done: false, needsAction: false, reason: '' }
    case 'failed':
    case 'retrying':
      return { done: false, needsAction: row.state === 'failed' || waited, reason: row.fail_reason ? `${where}: ${row.fail_reason}` : `${where} could not print it.` }
    case 'expired':
      return { done: false, needsAction: true, reason: `${where} never printed it.` }
    case 'waiting':
      return { done: false, needsAction: waited, reason: `${where} has not picked it up — is it switched on?` }
    default:
      return { done: false, needsAction: waited, reason: 'It has not reached the printer computer.' }
  }
}
