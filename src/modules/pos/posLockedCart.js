import { withTimeout } from '../../utils/withTimeout'

// The unsent cart a till lock would otherwise throw away (S776, owner decision).
//
// The idle lock (usePosIdleLock) and the Lock POS button both sign a PIN session out, and the order
// screen's cart is React state only. So a waiter who spent three minutes at a table came back to the
// PIN pad with the order gone — and the countdown that should have warned them rendered underneath
// the till. The owner's call: keep the cart for the login that typed it, bring it back when that same
// login signs in on this device, and say so on the PIN screen. Not "never lock" (every closed_by and
// comped_by reads whoever last typed a PIN) and not "warn louder" (a warning nobody is there to see).
//
// Nothing here reaches the server. The lines come back as UNSENT, onto the order they came from, and a
// different PIN never gets them. localStorage rather than the offline IndexedDB queue, because that
// queue REPLAYS writes, and these lines are not to be written by anyone but the waiter who returns for
// them. Keyed by login, so two waiters locking in turn each keep their own.

const KEY = 'crest_pos_locked_carts'

// A cart older than a service is not an order anyone is coming back for.
export const LOCKED_CART_MAX_AGE_MS = 12 * 60 * 60 * 1000

export const POS_BEFORE_LOCK_EVENT = 'crest:pos-before-lock'

function readAll() {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch (_) {
    return {}
  }
}

function writeAll(all) {
  try {
    if (Object.keys(all).length === 0) localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, JSON.stringify(all))
    return true
  } catch (e) {
    // A full or blocked store: the cart is lost exactly as it was before this existed, and said so.
    console.error('could not keep the locked cart:', e)
    return false
  }
}

function prune(all, now) {
  const out = {}
  for (const [id, entry] of Object.entries(all)) {
    if (entry && now - (Number(entry.savedAt) || 0) <= LOCKED_CART_MAX_AGE_MS) out[id] = entry
  }
  return out
}

/** Where the kept lines belong, the way the waiter knows it. */
export function lockedCartWhere(entry) {
  if (entry?.tableName) return entry.tableName
  return entry?.orderNo ? `Takeaway #${entry.orderNo}` : 'a new takeaway'
}

/** Keeps `entry` for its login, replacing any earlier cart that login left. False when nothing was kept. */
export function keepLockedCart(entry, now = Date.now()) {
  if (!entry?.profileId || !entry?.clientId || !Array.isArray(entry.items) || entry.items.length === 0) return false
  if (!(Number(entry.unsentUnits) > 0)) return false
  const all = prune(readAll(), now)
  all[entry.profileId] = { ...entry, savedAt: now }
  return writeAll(all)
}

/** Removes and returns the cart this login left on this outlet's till, or null. */
export function takeLockedCart(profileId, clientId, now = Date.now()) {
  const all = prune(readAll(), now)
  const hit = profileId ? all[profileId] : null
  if (!hit || hit.clientId !== clientId) {
    writeAll(all)
    return null
  }
  delete all[profileId]
  writeAll(all)
  return hit
}

/** What the PIN screen says is waiting: one row per login, for this outlet only. */
export function listLockedCarts(clientId, now = Date.now()) {
  if (!clientId) return []
  return Object.values(prune(readAll(), now))
    .filter(e => e.clientId === clientId)
    .map(e => ({ profileId: e.profileId, name: e.profileName || 'a staff member', where: lockedCartWhere(e), units: Number(e.unsentUnits) || 0 }))
}

// Called by Layout just before a PIN session signs out. The order screen listens (it holds the cart)
// and may hand back work that must finish first — a points redemption left standing by an unfinished
// close — through `waitUntil`. Bounded, so a dead connection cannot keep the till from locking.
export async function runBeforePosLock(ms = 5000) {
  const pending = []
  window.dispatchEvent(new CustomEvent(POS_BEFORE_LOCK_EVENT, {
    detail: { waitUntil: p => pending.push(Promise.resolve(p)) },
  }))
  if (pending.length === 0) return
  await withTimeout(Promise.allSettled(pending), ms, 'Handing work back before the lock').catch(e => {
    console.error('before-lock work did not finish; locking anyway:', e)
  })
}
