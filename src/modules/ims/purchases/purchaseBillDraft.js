// The half-typed supplier bill a page reload would otherwise throw away (S779).
//
// PurchaseBillForm holds a whole bill — vendor, day, discount, the supplier's printed figures and
// a row per item — in React state and nowhere else until Save. A bill keyed off paper is commonly
// 10–20 lines, so anything that ends the page's life takes twenty minutes of typing with it:
// Chrome restarting itself for an auto-update (the case that reported this), a phone or tablet
// discarding a backgrounded tab to reclaim memory, Chrome's own memory saver on a laptop, and this
// app's recoverFromChunkError() reload when a deploy lands mid-entry. None of those are failures
// the form can prevent and none of them warn first.
//
// So the bill is mirrored into localStorage as it is typed and read back on the next mount.
// localStorage, not sessionStorage: a browser that restarts itself opens a NEW session, which is
// exactly the case reported. Nothing here ever reaches the server — a draft is not a saved bill,
// it is only what the reader had on screen — and it is cleared the moment the real save lands or
// the reader cancels, so a restored draft always means "this was still unsaved".
//
// Deliberately NOT the offline IndexedDB queue (utils/offlineQueue.js): that queue REPLAYS writes
// once the connection returns, and a half-typed bill must never be written by anything but the
// person who finishes it.

const KEY = 'crest_purchase_bill_drafts'

// A bill nobody has come back to inside a week is not one anyone is still keying. Generous on
// purpose: the reader is not told a draft is being kept, so the only cost of an old one is the
// restore notice offering to throw it away.
export const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Which bill a draft belongs to, and WHO typed it.
 *
 * The bill half is a period or purchase-group UUID, so it is already unique across clients on a
 * device an admin switches tenants on — no client id is needed and none is stored.
 *
 * The profile half is the S731 rule ("a cache outlives the session that filled it") applied to a
 * store that deliberately survives one. Crest runs on shared store-room and counting tablets where
 * a PIN session ends on an idle lock, so keeping the bill across a sign-out is the whole point —
 * but keyed by bill alone, the NEXT login to open that period would be handed a half-typed bill
 * under the words "what you were typing", and could save someone else's keying under their own
 * name. Keyed by login it comes back for the person who typed it and for nobody else, which is
 * what posLockedCart.js does with an unsent till cart for the same reason.
 *
 * Fail closed: no login, or no bill, means no draft is kept or read rather than one shared bucket.
 */
export function billDraftId({ groupId, periodId, profileId } = {}) {
  if (!profileId) return null
  if (groupId) return `edit:${groupId}:${profileId}`
  return periodId ? `new:${periodId}:${profileId}` : null
}

/**
 * The bill's contents as a comparable string, minus the per-mount line keys — `_key` is
 * `Date.now() + Math.random()` and differs on every mount, so leaving it in would make every
 * freshly opened bill look changed.
 */
export function billDraftSignature(header, lines) {
  return JSON.stringify({
    header: header || {},
    lines: (lines || []).map(l => {
      const { _key, ...rest } = l || {}
      return rest
    }),
  })
}

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
    // A full or blocked store (private mode, a quota already spent). The bill is then exactly as
    // safe as it was before this file existed — lost on a reload — and the console says so rather
    // than the form claiming a safety net it does not have.
    console.error('could not keep the purchase bill draft:', e)
    return false
  }
}

function prune(all, now) {
  const out = {}
  for (const [id, entry] of Object.entries(all)) {
    if (entry && now - (Number(entry.savedAt) || 0) <= DRAFT_MAX_AGE_MS) out[id] = entry
  }
  return out
}

/**
 * Keeps the bill for `id`, replacing any earlier draft of the same bill. Returns true when
 * something was stored.
 *
 * `baseSignature` is the bill as it was OPENED, and a draft is only ever the DIFFERENCE from it:
 * on a new bill that means "the reader has typed something", and on an edit "there are unsaved
 * corrections". Matching the baseline deletes the draft instead of storing it, so opening a bill
 * and touching nothing — or undoing back to where you started — leaves nothing to restore.
 */
export function saveBillDraft(id, { header, lines, baseSignature }, now = Date.now()) {
  if (!id) return false
  const unchanged = billDraftSignature(header, lines) === baseSignature
  const all = prune(readAll(), now)
  if (unchanged) {
    if (!(id in all)) return false
    delete all[id]
    writeAll(all)
    return false
  }
  all[id] = { header, lines, savedAt: now }
  return writeAll(all)
}

/** The draft kept for `id`, or null. A read never writes, so an expired one is simply not returned. */
export function readBillDraft(id, now = Date.now()) {
  if (!id) return null
  const hit = prune(readAll(), now)[id]
  if (!hit || !hit.header || typeof hit.header !== 'object') return null
  if (!Array.isArray(hit.lines) || hit.lines.length === 0) return null
  return hit
}

/** Forgets the draft for `id` — the bill saved for real, or the reader cancelled it. */
export function clearBillDraft(id) {
  if (!id) return
  const all = readAll()
  if (!(id in all)) return
  delete all[id]
  writeAll(all)
}
