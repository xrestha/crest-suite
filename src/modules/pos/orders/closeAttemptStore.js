import { CLOSE_LAND_GRACE_MS } from './closeAttempt'

// Payment tries whose answer never came back, kept on this tablet (S833, stage 6).
//
// Since S776 a close whose answer was lost leaves a mark (PosOrders' closeAttemptRef) that locks the
// bill's payment until a read settles it. The mark lived in memory, so a reload, leaving Orders or a PIN
// lock forgot it: a bill that might still close could be charged again. It is kept here now, by outlet,
// order and login, as posLockedCart.js keeps an unsent cart. Nothing here reaches the server.
//
// The login that pressed gets its mark back whole: the 15 s poll finishes a bill that closed (Split legs,
// points) as it would have. Another login on this tablet (owner decision, 2026-10-13) sees the bill locked
// for a moment, with who pressed, until a read finds it closed or still open once nothing of that try can
// land. A closed bill stays on record for the presser, who still owes it its legs and points; a try that
// never landed is forgotten for everyone.

const KEY = 'crest_pos_close_attempts'

// A try older than this has long been settled one way or the other.
export const KEPT_CLOSE_MAX_AGE_MS = 24 * 60 * 60 * 1000

function readAll() {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || '[]')
    return Array.isArray(parsed) ? parsed.filter(e => e && e.orderId && e.profileId && e.clientId) : []
  } catch (_) {
    return []
  }
}

function writeAll(list) {
  try {
    if (list.length === 0) localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, JSON.stringify(list))
  } catch (e) {
    // A full or blocked store: the mark lives in memory only, as it did before S833.
    console.error('could not keep the payment try on this tablet:', e)
  }
}

const fresh = (list, now) => list.filter(e => now - (Number(e.savedAt) || 0) < KEPT_CLOSE_MAX_AGE_MS)

/** Replaces this login's kept tries at this outlet with `attempts` (the in-memory marks). */
export function keepOwnCloseAttempts({ profileId, profileName = '', clientId, attempts, now = Date.now() }) {
  if (!profileId || !clientId) return
  const others = fresh(readAll(), now).filter(e => !(e.profileId === profileId && e.clientId === clientId))
  const mine = attempts.filter(a => a?.orderId).map(a => ({
    orderId: a.orderId, closeType: a.closeType, tableId: a.tableId || null, where: a.where || '',
    sent: a.sent || null, finalAfter: a.finalAfter ?? null, lastWriteAt: a.lastWriteAt ?? null,
    profileId, profileName, clientId, savedAt: now,
  }))
  writeAll([...others, ...mine])
}

/** Forgets one login's kept try on one bill (another login found it never landed). */
export function dropKeptCloseAttempt({ profileId, clientId, orderId }) {
  const all = readAll()
  const left = all.filter(e => !(e.profileId === profileId && e.clientId === clientId && e.orderId === orderId))
  if (left.length !== all.length) writeAll(left)
}

/** When "still open" becomes final for a kept try. A write still travelling when the page went away
 *  was cut off then, and no later than its own time limit (`writeLimitMs`); what the server had already
 *  received finishes within CLOSE_LAND_GRACE_MS of that. Never earlier than the mark itself said. */
export function restoredFinalAfter(entry, now, writeLimitMs) {
  const lastWrite = Number(entry.lastWriteAt) || Number(entry.savedAt) || 0
  const cutOff = Math.min(now, lastWrite + writeLimitMs)
  return Math.max(Number(entry.finalAfter) || 0, cutOff + CLOSE_LAND_GRACE_MS)
}

/** This outlet's kept tries, split into this login's (`own`, marks ready for closeAttemptRef) and other
 *  logins' (`foreign`, one per bill, carrying who pressed in `by`). */
export function restoreCloseAttempts({ profileId, clientId, writeLimitMs, now = Date.now() }) {
  const all = readAll()
  const kept = fresh(all, now)
  if (kept.length !== all.length) writeAll(kept)
  const here = kept.filter(e => e.clientId === clientId)
  const asMark = e => ({
    orderId: e.orderId, closeType: e.closeType, tableId: e.tableId, where: e.where, sent: e.sent,
    writesInFlight: 0, finalAfter: restoredFinalAfter(e, now, writeLimitMs), lastWriteAt: e.lastWriteAt ?? null,
  })
  const own = here.filter(e => e.profileId === profileId).map(asMark)
  const ownIds = new Set(own.map(a => a.orderId))
  const foreign = new Map()
  for (const e of here) {
    if (e.profileId === profileId || ownIds.has(e.orderId)) continue
    const mark = { ...asMark(e), foreign: true, profileId: e.profileId, by: e.profileName || 'Another login' }
    const prev = foreign.get(e.orderId)
    if (!prev || mark.finalAfter > prev.finalAfter) foreign.set(e.orderId, mark)
  }
  return { own, foreign: [...foreign.values()] }
}

/** What a login sees on a bill another login's kept try is holding. */
export function foreignCloseText(mark) {
  const what = mark.closeType === 'void' ? 'Void' : mark.closeType === 'writeoff' ? 'Complimentary' : 'Confirm Payment'
  return `${mark.by} pressed ${what} on this bill and no answer came back, so it may still go through. It stays locked until the till has checked — usually within a minute — so it is not charged twice.`
}
