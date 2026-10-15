import { nepalTime, nepalBsLong, nepalDateLong, nepalCivilDate } from '../../../shared/nepalTime'

// The plain-logic half of kitchen and bar printers (S837; contract in docs/kitchen-printers.md):
// pairing codes, printer addresses, the words a status is shown in, and the Add/Edit form's rules.
// Everything here is pure, so POS Setup → Printers and the print station page read one definition.

// ── Pairing codes ────────────────────────────────────────────────────────────────────────────────
// 8 characters from this alphabet, shown XXXX-XXXX. There is no I, O, 0 or 1 in it, so nothing a
// person reads off a screen can be mistaken for another character. Spaces, dashes and case are
// ignored when typed.
export const PAIR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const PAIR_CODE_LENGTH = 8

const SEPARATORS = /[\s\-‐-―_.]/g

/** What was typed, as the 8 characters the server compares: upper case, no spaces or dashes. */
export function normalizePairCode(input) {
  return String(input ?? '').toUpperCase().replace(SEPARATORS, '')
}

/** A code as it is shown and as the input box keeps it: XXXX-XXXX, the dash only once it is needed. */
export function formatPairCode(input) {
  const n = normalizePairCode(input).slice(0, PAIR_CODE_LENGTH)
  return n.length > 4 ? `${n.slice(0, 4)}-${n.slice(4)}` : n
}

export function isValidPairCode(input) {
  const n = normalizePairCode(input)
  return n.length === PAIR_CODE_LENGTH && [...n].every(ch => PAIR_ALPHABET.includes(ch))
}

/** '' when the code can be sent, else the sentence that says what is wrong with it. */
export function pairCodeProblem(input) {
  const n = normalizePairCode(input)
  if (!n) return 'Type the 8-character code shown in POS Setup → Printers.'
  if ([...n].some(ch => !PAIR_ALPHABET.includes(ch))) {
    return 'The code uses only letters and the numbers 2 to 9. There is no I, O, 0 or 1 in it.'
  }
  if (n.length !== PAIR_CODE_LENGTH) return `The code has 8 characters; this has ${n.length}.`
  return ''
}

// ── Printer addresses (the Print Helper's network printers) ─────────────────────────────────────
export const DEFAULT_PORT = 9100
export const PAPER_WIDTHS = [80, 58]

// One part of a dotted address: 0-255, no leading zero (010 means different things to different
// programs, so it is refused rather than guessed).
const OCTET = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/

export function parseIPv4(input) {
  const parts = String(input ?? '').trim().split('.')
  if (parts.length !== 4 || !parts.every(p => OCTET.test(p))) return null
  return parts.map(Number)
}

/** A private (restaurant network) IPv4 address: 10/8, 172.16/12 or 192.168/16. */
export function isPrivateIPv4(input) {
  const p = parseIPv4(input)
  if (!p) return false
  const [a, b] = p
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

export function printerAddressProblem(input) {
  const t = String(input ?? '').trim()
  if (!t) return "Type the printer's address, for example 192.168.1.50."
  if (!parseIPv4(t)) return 'That is not an address. It is four numbers with dots between them, for example 192.168.1.50.'
  if (!isPrivateIPv4(t)) {
    return "That is not an address on the restaurant's own network. A printer's address starts with 192.168., 10., or 172.16. to 172.31."
  }
  return ''
}

export function portProblem(input) {
  const t = String(input ?? '').trim()
  const n = Number(t)
  if (!t || !Number.isInteger(n) || n < 1 || n > 65535) {
    return 'The port is a whole number from 1 to 65535. Kitchen printers almost always use 9100.'
  }
  return ''
}

// ── Stations and kinds ──────────────────────────────────────────────────────────────────────────
export const STATIONS = ['KOT', 'BOT']
export const STATION_NAME = { KOT: 'Kitchen', BOT: 'Bar' }
// KOT vs BOT is a category, not a status (pos-billing.md, S613): KOT purple, BOT grey (S846; it was
// the accent tag until POS took the accent off every category). Same values as posSignals.js.
export const STATION_BADGE = { KOT: 'badge-purple', BOT: 'badge-gray' }
export const KIND_NAME = { page: 'Print station page', helper: 'Print helper' }

/** The stations a device covers, in KOT-then-BOT order, unknown values dropped. */
export function orderedStations(stations) {
  const list = Array.isArray(stations) ? stations : []
  return STATIONS.filter(s => list.includes(s))
}

/** "Kitchen", "Bar", "Kitchen and bar". */
export function stationsText(stations) {
  const names = orderedStations(stations).map(s => STATION_NAME[s])
  if (names.length === 2) return `${names[0]} and ${names[1].toLowerCase()}`
  return names[0] || ''
}

// ── Times ───────────────────────────────────────────────────────────────────────────────────────
const sameNepalDay = (a, b) => {
  const da = nepalCivilDate(a)
  const db = nepalCivilDate(b)
  return !!da && !!db && da.getTime() === db.getTime()
}

/** A moment as Nepal clock time, with the day in front when it was not today. */
export function momentText(iso, nowMs = Date.now()) {
  if (!iso) return ''
  const time = nepalTime(iso)
  if (!time) return ''
  if (sameNepalDay(iso, nowMs)) return time
  return `${nepalBsLong(iso) || nepalDateLong(iso)} · ${time}`
}

/** "just now", "4 s ago", "3 min ago", "2 h ago"; '' for nothing. A clock behind the server's reads "just now". */
export function agoText(iso, nowMs = Date.now()) {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const s = Math.max(0, Math.round((nowMs - t) / 1000))
  if (s < 3) return 'just now'
  if (s < 60) return `${s} s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ago`
  return `${Math.floor(m / 60)} h ago`
}

// ── A printer computer's status ─────────────────────────────────────────────────────────────────

/** True while a pairing code issued for the device is still good. */
export function pairCodeLive(expiresIso, nowMs = Date.now()) {
  const t = Date.parse(expiresIso)
  return Number.isFinite(t) && t > nowMs
}

/**
 * How a device stands, as a badge and a line under it. `issued` is the code this page issued in
 * this visit ({ code, expiresAt }); the list never returns a code, only when one expires.
 *
 * Offline is amber, not red: tickets still reach the kitchen, from each till's own print window.
 */
export function deviceStatus(device, nowMs = Date.now(), issued = null) {
  const codeExpiry = issued?.expiresAt || device?.pair_code_expires_at
  const codeLine = issued?.code && pairCodeLive(issued.expiresAt, nowMs)
    ? `Pairing code ${formatPairCode(issued.code)}, good until ${momentText(issued.expiresAt, nowMs)}`
    : pairCodeLive(codeExpiry, nowMs)
      ? `A pairing code is out, good until ${momentText(codeExpiry, nowMs)}`
      : ''

  if (!device?.paired) {
    if (codeLine) return { badge: 'badge-amber', text: 'Waiting to pair', detail: codeLine }
    return { badge: 'badge-gray', text: 'Not paired yet', detail: 'Make a pairing code to connect it.' }
  }
  if (device.online) {
    return { badge: 'badge-green', text: 'Online', detail: `Seen ${agoText(device.last_seen_at, nowMs)}`, pairing: codeLine }
  }
  if (!device.last_seen_at) {
    return { badge: 'badge-amber', text: 'Offline', detail: 'Paired, but it has not checked in yet.', pairing: codeLine }
  }
  return { badge: 'badge-amber', text: 'Offline', detail: `Last seen ${momentText(device.last_seen_at, nowMs)}`, pairing: codeLine }
}

/** The device's last report for one station's printer ({ ok, error }), or null when it sent none. */
export function printerReport(device, station) {
  const list = Array.isArray(device?.status?.printers) ? device.status.printers : []
  const hit = list.find(p => p && p.station === station)
  if (!hit) return null
  return { ok: !!hit.ok, error: hit.error ? String(hit.error) : '' }
}

/**
 * Where one station's tickets print now, the way get_pos_print_routes chooses: an online device
 * covering it first, then a paired one, then one still waiting to pair.
 * → { state: 'online' | 'offline' | 'unpaired' | 'none', device }
 */
export function stationRoute(devices, station) {
  const covering = (Array.isArray(devices) ? devices : []).filter(d => orderedStations(d?.stations).includes(station))
  const online = covering.find(d => d.online)
  if (online) return { state: 'online', device: online }
  const paired = covering.find(d => d.paired)
  if (paired) return { state: 'offline', device: paired }
  if (covering.length) return { state: 'unpaired', device: covering[0] }
  return { state: 'none', device: null }
}

// ── A queued job ────────────────────────────────────────────────────────────────────────────────

// A map, not a switch with a default arm: a state this page does not know shows as itself, never
// as a guess.
const JOB_STATE = {
  printed: { badge: 'badge-green', text: 'Printed' },
  printing: { badge: 'badge-gray', text: 'Printing' },
  waiting: { badge: 'badge-gray', text: 'Waiting' },
  retrying: { badge: 'badge-amber', text: 'Retrying' },
  failed: { badge: 'badge-red', text: 'Failed' },
  expired: { badge: 'badge-red', text: 'Expired' },
}

/** → { badge, text, reason } for a job row of list_pos_print_jobs. */
export function jobStateView(job) {
  if (job?.state === 'printed' && job.printed_via === 'till') {
    // Printed, but not by a printer computer: the waiter pressed Print here. Worth noticing.
    return { badge: 'badge-amber', text: 'Printed on the till', reason: '' }
  }
  const base = JOB_STATE[job?.state]
  if (!base) return { badge: 'badge-gray', text: String(job?.state || '—'), reason: '' }
  let reason = ''
  if (job.state === 'retrying' || job.state === 'failed') reason = job.fail_reason ? String(job.fail_reason) : ''
  if (job.state === 'expired') reason = 'Not printed within 15 minutes.'
  return { ...base, reason }
}

export const JOB_KIND_NAME = { ticket: '', reprint: 'Reprint', void: 'Void slip', move: 'Move slip', test: 'Test print' }

// ── The Add / Edit form ─────────────────────────────────────────────────────────────────────────
export const NAME_MAX = 60

const blankPrinter = () => ({ host: '', port: String(DEFAULT_PORT), width: 80 })

export function emptyDeviceForm() {
  return { name: '', kind: 'page', stations: ['KOT'], printers: { KOT: blankPrinter(), BOT: blankPrinter() } }
}

/** The form for an existing device. Printer rows are kept per station, so unticking and ticking a
 *  station again does not lose what was typed. */
export function formFromDevice(device) {
  const form = emptyDeviceForm()
  form.name = String(device?.name || '')
  form.kind = device?.kind === 'helper' ? 'helper' : 'page'
  form.stations = orderedStations(device?.stations)
  for (const p of Array.isArray(device?.printers) ? device.printers : []) {
    if (!STATIONS.includes(p?.station)) continue
    form.printers[p.station] = {
      host: String(p.host || ''),
      port: String(p.port ?? DEFAULT_PORT),
      width: Number(p.width) === 58 ? 58 : 80,
    }
  }
  return form
}

/** Errors keyed by field: name, kind, stations, and `${station}.host` / `${station}.port` / `${station}.width`. */
export function validateDeviceForm(form) {
  const errors = {}
  const name = String(form?.name ?? '').trim()
  if (!name) errors.name = 'Give it a name your staff will recognise, for example Counter PC.'
  else if (name.length > NAME_MAX) errors.name = `Keep the name to ${NAME_MAX} characters or fewer.`
  if (form?.kind !== 'page' && form?.kind !== 'helper') errors.kind = 'Choose how this computer prints.'
  const stations = orderedStations(form?.stations)
  if (stations.length === 0) errors.stations = 'Tick at least one: kitchen tickets, bar tickets, or both.'
  if (form?.kind === 'helper') {
    for (const s of stations) {
      const p = form.printers?.[s] || {}
      const host = printerAddressProblem(p.host)
      if (host) errors[`${s}.host`] = host
      const port = portProblem(p.port)
      if (port) errors[`${s}.port`] = port
      if (!PAPER_WIDTHS.includes(Number(p.width))) errors[`${s}.width`] = 'Choose 80 mm or 58 mm.'
    }
  }
  return errors
}

/** What create/update_pos_print_device take as p_printers: one per station for a helper, [] for a page. */
export function printersPayload(form) {
  if (form?.kind !== 'helper') return []
  return orderedStations(form.stations).map(s => {
    const p = form.printers?.[s] || {}
    return { station: s, host: String(p.host || '').trim(), port: Number(String(p.port).trim()), width: Number(p.width) }
  })
}
