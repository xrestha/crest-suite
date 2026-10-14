import { createClient } from '@supabase/supabase-js'
import { supabase } from '../../../supabaseClient'
import { withTimeout } from '../../../utils/withTimeout'

// Thin wrappers for the kitchen and bar printer functions (S837; contract in
// docs/kitchen-printers.md). Each one answers `{ data, error }` and never throws: a timeout or a
// dropped connection comes back as `error`, so a caller has one branch for every failure, and every
// call is bounded because a supabase call can hang for ever (CLAUDE.md).
//
// The manager functions RAISE when they refuse (42501 not allowed, 22023 bad input). The device
// functions answer `{ ok: false, code }` instead, as `data`; callers read `data.ok`.

export const HELPER_DOWNLOAD_URL = `${process.env.REACT_APP_SUPABASE_URL}/storage/v1/object/public/downloads/CrestPrintHelper.zip`

const READ_MS = 15000
const WRITE_MS = 20000
const DEVICE_MS = 15000

// The device functions are keyed by the device's own id and secret, never by a login. The app's
// client sends whichever login is signed in on that computer, and one whose sign-in has lapsed and
// cannot refresh is refused by the API before the function runs (PGRST301), so the counter PC would
// stop printing because somebody's session ran out. This second client never holds a session: it
// calls as anon, whoever is signed in. Its own storage key keeps it apart from the app's session.
let deviceClient = null
function anonClient() {
  if (!deviceClient) {
    deviceClient = createClient(process.env.REACT_APP_SUPABASE_URL, process.env.REACT_APP_SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'crest-print-device' },
    })
  }
  return deviceClient
}

export async function callPrintRpc(fn, params, ms = WRITE_MS, label = 'Request', client = supabase) {
  try {
    const { data, error } = await withTimeout(client.rpc(fn, params), ms, label)
    if (error) return { data: null, error }
    return { data: data ?? null, error: null }
  } catch (error) {
    return { data: null, error }
  }
}

// ── Manager (POS Setup → Printers) ──────────────────────────────────────────────────────────────

export const listPrintDevices = clientId =>
  callPrintRpc('list_pos_print_devices', { p_client_id: clientId }, READ_MS, 'Loading printer computers')

export const listPrintJobs = (clientId, limit = 20) =>
  callPrintRpc('list_pos_print_jobs', { p_client_id: clientId, p_limit: limit }, READ_MS, 'Loading recent prints')

export const createPrintDevice = ({ clientId, name, kind, stations, printers }) =>
  callPrintRpc('create_pos_print_device', {
    p_client_id: clientId, p_name: name, p_kind: kind, p_stations: stations, p_printers: printers,
  }, WRITE_MS, 'Adding the printer computer')

export const updatePrintDevice = ({ deviceId, name, stations, printers }) =>
  callPrintRpc('update_pos_print_device', {
    p_device_id: deviceId, p_name: name, p_stations: stations, p_printers: printers,
  }, WRITE_MS, 'Saving the printer computer')

export const issuePrintPairCode = deviceId =>
  callPrintRpc('issue_pos_print_pair_code', { p_device_id: deviceId }, WRITE_MS, 'Making a pairing code')

export const removePrintDevice = deviceId =>
  callPrintRpc('remove_pos_print_device', { p_device_id: deviceId }, WRITE_MS, 'Removing the printer computer')

export const sendPrintTest = ({ deviceId, station, doc }) =>
  callPrintRpc('send_pos_print_test', { p_device_id: deviceId, p_station: station, p_doc: doc }, WRITE_MS, 'Sending the test ticket')

// ── Print device (the /print-station page; anon, the device's own id and secret) ────────────────

export const pairPrintDevice = (code, info) =>
  callPrintRpc('pos_print_device_pair', { p_code: code, p_info: info }, DEVICE_MS, 'Pairing', anonClient())

export const pollPrintDevice = (deviceId, secret, info) =>
  callPrintRpc('pos_print_device_poll', { p_device_id: deviceId, p_secret: secret, p_info: info }, DEVICE_MS, 'Checking for tickets', anonClient())

export const reportPrintDevice = (deviceId, secret, printed, failed) =>
  callPrintRpc('pos_print_device_report', {
    p_device_id: deviceId, p_secret: secret, p_printed: printed, p_failed: failed,
  }, DEVICE_MS, 'Reporting printed tickets', anonClient())

/** The `rpc` the print station runner takes: the two device calls it makes, by name. */
export function deviceRpc(fn, params) {
  return callPrintRpc(fn, params, DEVICE_MS, fn === 'pos_print_device_report' ? 'Reporting printed tickets' : 'Checking for tickets', anonClient())
}
