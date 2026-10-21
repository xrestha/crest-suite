import { fillTemplate } from '../reservations/whatsappLink'
import { serviceDayStartIso } from '../../../shared/nepalTime'
import { settleWithin } from '../../../utils/withTimeout'

// The walk-in waitlist on the POS floor (S854). A party waiting for a table: name, optional phone,
// party size and the wait the host quoted. Kept in public.pos_waitlist, apart from pos_reservations,
// whose table holds, conflict checks, Full counts and Covers split all assume a booked time.
//
// The status only moves forward, and the database enforces it (pos_waitlist_guard, migration
// 20261021100000): waiting -> notified -> seated / left / cancelled. The server stamps notified_at,
// seated_at, left_at and cancelled_at itself, so nothing here sends a time. Every write is guarded
// on the status it expects, with `.select()`, so a party another device already moved comes back
// as zero rows rather than as a silent success (errorText.js, S738).

export const WAITLIST_SELECT =
  'id, customer_name, phone, party_size, quoted_minutes, status, notes, notified_at, seated_at, left_at, cancelled_at, order_id, created_at'

/** The two statuses that are still on the list. */
export const LIVE_STATUSES = ['waiting', 'notified']

/** The quick buttons for the wait the host quotes, in minutes (owner decision S854). */
export const QUOTE_CHOICES = [10, 20, 30, 45, 60]
export const DEFAULT_QUOTE = 20

export const MAX_PARTY = 99
export const MAX_NAME = 80
export const MAX_PHONE = 30

export const WAITLIST_READ_MS = 15000
export const WAITLIST_WRITE_MS = 15000

// No apostrophes anywhere in this copy: it travels in a URL and in JS strings.
export const WAITLIST_READY_TEMPLATE =
  'Hello {name}, your table at {outlet} is ready. Please come to the host stand.'
const WAITLIST_READY_TEMPLATE_NO_OUTLET =
  'Hello {name}, your table is ready. Please come to the host stand.'

function toMs(now) {
  if (now instanceof Date) return now.getTime()
  const n = Number(now)
  return Number.isFinite(n) ? n : Date.now()
}

/** Whole minutes the party has waited since it was added. Never negative (a tablet clock behind). */
export function waitedMinutes(entry, now = Date.now()) {
  const start = Date.parse(entry?.created_at)
  if (!Number.isFinite(start)) return 0
  return Math.max(0, Math.floor((toMs(now) - start) / 60000))
}

/** True once the party has waited longer than it was quoted. Waiting exactly the quote is not over. */
export function isOverdue(entry, now = Date.now()) {
  const quoted = Number(entry?.quoted_minutes)
  if (!Number.isFinite(quoted) || quoted <= 0) return false
  return waitedMinutes(entry, now) > quoted
}

/** Minutes past the quote, 0 when not over. */
export function minutesOver(entry, now = Date.now()) {
  const quoted = Number(entry?.quoted_minutes)
  if (!Number.isFinite(quoted) || quoted <= 0) return 0
  return Math.max(0, waitedMinutes(entry, now) - quoted)
}

/** The parties still on the list, oldest first (the order they are called back in). */
export function liveEntries(rows) {
  return (rows || [])
    .filter(r => r && LIVE_STATUSES.includes(r.status))
    .slice()
    .sort((a, b) => ((Date.parse(a.created_at) || 0) - (Date.parse(b.created_at) || 0))
      || String(a.id).localeCompare(String(b.id)))
}

/** The WhatsApp message telling a party their table is ready. */
export function readyMessage(entry, outletName) {
  const outlet = String(outletName || '').trim()
  const template = outlet ? WAITLIST_READY_TEMPLATE : WAITLIST_READY_TEMPLATE_NO_OUTLET
  return fillTemplate(template, { name: String(entry?.customer_name || '').trim(), outlet })
}

function digitCount(s) {
  return String(s || '').replace(/\D/g, '').length
}

/**
 * Field-level validation for the Add form. Returns `{}` when the draft can be saved, else one
 * message per field: `name`, `phone`, `party`, `quote`.
 */
export function validateWaitlistDraft({ name, phone, partySize, quotedMinutes } = {}) {
  const errors = {}
  const n = String(name || '').trim()
  if (!n) errors.name = 'Enter the name the party will answer to.'
  else if (n.length > MAX_NAME) errors.name = `Keep the name to ${MAX_NAME} characters.`
  const p = String(phone || '').trim()
  if (p && (digitCount(p) < 7 || p.length > MAX_PHONE)) {
    errors.phone = 'Check the number: it needs at least 7 digits. Or leave it empty.'
  }
  const size = Number(partySize)
  if (!Number.isInteger(size) || size < 1 || size > MAX_PARTY) errors.party = `Party size is 1 to ${MAX_PARTY}.`
  const q = Number(quotedMinutes)
  if (!Number.isInteger(q) || q < 1 || q > 240) errors.quote = 'Pick the wait you quoted.'
  return errors
}

/** This service day's live parties (the day rolls over at 6 AM Nepal, as parking does). */
export function loadLiveWaitlist(db, { nowMs = Date.now(), timeoutMs = WAITLIST_READ_MS } = {}) {
  return settleWithin(
    db.scopedFrom('pos_waitlist', WAITLIST_SELECT)
      .in('status', LIVE_STATUSES)
      .gte('created_at', serviceDayStartIso(nowMs))
      .order('created_at')
      .order('id'),
    timeoutMs,
    'Waitlist'
  )
}

function isOwnIdRetry(error) {
  return error?.code === '23505' && /pos_waitlist_pkey/i.test(String(error?.message || ''))
}

/**
 * Add a party. `id` is made by the form once per draft, so a second press after a lost answer
 * meets the first row's primary key instead of adding the party twice; that comes back as
 * `{ error: null, row: null, duplicate: true }` and the caller re-reads the list.
 */
export async function addWaitlistEntry(db, draft, { id, timeoutMs = WAITLIST_WRITE_MS } = {}) {
  const row = {
    customer_name: String(draft?.name || '').trim(),
    phone: String(draft?.phone || '').trim() || null,
    party_size: Number(draft?.partySize),
    quoted_minutes: Number(draft?.quotedMinutes),
    notes: String(draft?.notes || '').trim() || null,
  }
  if (id) row.id = id
  const { data, error } = await settleWithin(db.scopedInsert('pos_waitlist', row), timeoutMs, 'Adding to the waitlist')
  if (error) {
    if (isOwnIdRetry(error)) return { error: null, row: null, duplicate: true }
    return { error, row: null }
  }
  const saved = Array.isArray(data) ? data[0] : data
  return { error: null, row: saved || null }
}

// One status move, guarded on the statuses it may leave. `count` is the rows the server says it
// wrote: 0 means another device moved the party first (or the party is not this outlet's).
async function moveWaitlistStatus(db, entryId, patch, from, label, timeoutMs) {
  const { data, error } = await settleWithin(
    db.scopedUpdate('pos_waitlist', patch).eq('id', entryId).in('status', from).select(WAITLIST_SELECT),
    timeoutMs,
    label
  )
  if (error) return { error, count: 0, row: null }
  const rows = Array.isArray(data) ? data : []
  return { error: null, count: rows.length, row: rows[0] || null }
}

/** Mark that the party was told their table is ready (WhatsApp or a call). Only from waiting. */
export function notifyWaitlistEntry(db, entryId, { timeoutMs = WAITLIST_WRITE_MS } = {}) {
  return moveWaitlistStatus(db, entryId, { status: 'notified' }, ['waiting'], 'Marking the party as told', timeoutMs)
}

/** The party went away before a table came up. */
export function markWaitlistLeft(db, entryId, { timeoutMs = WAITLIST_WRITE_MS } = {}) {
  return moveWaitlistStatus(db, entryId, { status: 'left' }, LIVE_STATUSES, 'Marking the party as left', timeoutMs)
}

/** The entry was a mistake, or the party called to say they are not coming. */
export function cancelWaitlistEntry(db, entryId, { timeoutMs = WAITLIST_WRITE_MS } = {}) {
  return moveWaitlistStatus(db, entryId, { status: 'cancelled' }, LIVE_STATUSES, 'Cancelling the waitlist entry', timeoutMs)
}

/**
 * Link a seated party to the bill it became. Call it right after the order's FIRST save, with the
 * new order id (the database refuses `seated` without a bill, and a bill of another outlet).
 * Resolves `{ error, count, row, alreadySeated }`:
 *   · count 1: seated now;
 *   · count 0 and alreadySeated: a retry after a lost answer, the party is already on this bill;
 *   · count 0 otherwise: the party left the list on another device first (row says how, when it
 *     could be read back); the order itself is unaffected.
 */
export async function markWaitlistSeated(db, entryId, orderId, { timeoutMs = WAITLIST_WRITE_MS } = {}) {
  const res = await moveWaitlistStatus(
    db, entryId, { status: 'seated', order_id: orderId }, LIVE_STATUSES, 'Seating the waitlist party', timeoutMs
  )
  if (res.error || res.count > 0) return { ...res, alreadySeated: false }
  const { data, error } = await settleWithin(
    db.scopedFrom('pos_waitlist', WAITLIST_SELECT).eq('id', entryId).limit(1),
    timeoutMs,
    'Reading the waitlist party back'
  )
  const row = !error && Array.isArray(data) ? data[0] || null : null
  const alreadySeated = !!row && row.status === 'seated' && row.order_id === orderId
  return { error: null, count: alreadySeated ? 1 : 0, row, alreadySeated }
}
