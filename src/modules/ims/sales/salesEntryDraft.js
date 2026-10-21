// The half-typed Bulk Entry grid a page reload would otherwise throw away.
//
// Sales Entry's Bulk tab holds a period's typed quantities — one box per dish, commonly 50 to 90
// of them — in React state (`bulkForm`) and nowhere else until Save. It is the other long entry
// screen the S779 purchase-bill draft was written for, and it dies the same ways: Chrome
// restarting itself for an auto-update, a phone or tablet discarding a backgrounded tab, Chrome's
// memory saver, and this app's own recoverFromChunkError() reload when a deploy lands mid-entry.
//
// So the typed figures are mirrored into localStorage and read back when the period loads again.
// purchaseBillDraft.js is the pattern and carries the reasoning; the load-bearing parts, kept here:
// localStorage (a restarted browser opens a new session, so sessionStorage would be empty), never
// the offline queue (a draft is a restore, never a send), keyed by the period AND the login, only
// the DIFFERENCE from the saved figures is stored, and the draft is cleared when the save lands or
// the reader discards it. Nothing here reaches the server.

const KEY = 'crest_sales_entry_drafts'

// A month of typing nobody has come back to inside a week is not one anyone is still entering.
// The same window as the purchase bill draft, for the same reason.
export const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Which grid a draft belongs to, and WHO typed it. `bulk:` names the tab: only Bulk Entry is
 * drafted (Daily Entry is one day of figures at a time, a few minutes of work, not a month).
 *
 * The period id is a UUID, so it is already unique across clients on a device an admin switches
 * tenants on. The profile half is the S731 rule for a store that deliberately survives a sign-out:
 * keyed by period alone, the next login on a shared tablet would be handed someone else's figures
 * under "you typed these" and could save them under their own name. Fail closed: no login, or no
 * period, means no draft is kept or read.
 */
export function salesDraftId({ periodId, profileId } = {}) {
  if (!profileId || !periodId) return null
  return `bulk:${periodId}:${profileId}`
}

const qtyOf = v => parseFloat(v) || 0

/**
 * The saved Bulk figures (`{ recipe_id: qty }`, as loadSales builds them) as a comparable string.
 * Sorted by dish, and a zero is the same as no row: the grid shows both as an empty box.
 */
export function salesDraftSignature(saved) {
  const entries = Object.entries(saved || {})
    .map(([id, q]) => [id, qtyOf(q)])
    .filter(([, q]) => q !== 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return JSON.stringify(entries)
}

/**
 * The typed boxes that say something different from the saved figures, and only those. A box
 * typed back to its saved value, or a blank over nothing saved, is not a change. A blank over a
 * saved figure IS one (Clear All, or a box emptied by hand): saving it removes that figure.
 */
export function salesDraftChanges(form, saved) {
  const out = {}
  for (const [id, typed] of Object.entries(form || {})) {
    if (typed === undefined || typed === null) continue
    if (qtyOf(typed) !== qtyOf((saved || {})[id])) out[id] = String(typed)
  }
  return out
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
    // A full or blocked store (private mode, a quota already spent). The figures are then exactly
    // as safe as they were before this file existed, and the console says so.
    console.error('could not keep the sales entry draft:', e)
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
 * Keeps what was typed for `id`, replacing any earlier draft of the same grid. Returns true when
 * something was stored.
 *
 * `baseline` is the saved figures the boxes were typed over, and the draft is only the DIFFERENCE
 * from them: opening the month and touching nothing, or typing every box back to what was saved,
 * deletes the draft instead of storing it. The baseline's signature goes WITH the draft, so a later
 * visit can tell whether the month it was typed against is still the month in the database.
 */
export function saveSalesDraft(id, { form, baseline }, now = Date.now()) {
  if (!id) return false
  const changes = salesDraftChanges(form, baseline)
  const all = prune(readAll(), now)
  if (Object.keys(changes).length === 0) {
    if (!(id in all)) return false
    delete all[id]
    writeAll(all)
    return false
  }
  all[id] = { form: changes, savedAt: now, baseSignature: salesDraftSignature(baseline) }
  return writeAll(all)
}

/**
 * Whether the saved figures a draft was typed against have changed since: someone saved this
 * month's Bulk figures after the draft was kept (another device, another login, another tab, or a
 * Daily Entry save that replaced the Bulk rows). Putting the draft back then would lay older typing
 * over newer figures under "you typed these", and Save would write it. A draft with no baseline
 * cannot be proven current, so it counts as moved and the reader is asked.
 */
export function draftBaseMoved(draft, currentSignature) {
  if (!draft) return false
  if (typeof draft.baseSignature !== 'string') return true
  return draft.baseSignature !== currentSignature
}

/** The draft kept for `id`, or null. A read never writes, so an expired one is simply not returned. */
export function readSalesDraft(id, now = Date.now()) {
  if (!id) return null
  const hit = prune(readAll(), now)[id]
  if (!hit || !hit.form || typeof hit.form !== 'object' || Array.isArray(hit.form)) return null
  if (Object.keys(hit.form).length === 0) return null
  return hit
}

/** Forgets the draft for `id`: the figures saved for real, or the reader discarded them. */
export function clearSalesDraft(id) {
  if (!id) return
  const all = readAll()
  if (!(id in all)) return
  delete all[id]
  writeAll(all)
}
