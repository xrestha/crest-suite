// D37 (S792 stage 4): a second count of an item someone else has already counted asks
// "replace, or add yours?" instead of silently replacing it.
//
// save_closing_counts (migration 20260929100000) does the check and the write in one statement
// per item: in 'check' mode it writes nothing for an item another person holds and hands the stored
// count back as a conflict; 'replace' and 'add' are the counter's answer. The add happens in the
// database, so two tablets adding at the same moment both land. Pure helpers only — Stock.js owns
// the calls and the state.

export const COUNT_MODES = ['check', 'replace', 'add']

// The rows the RPC takes. `by` is the counter of these figures as the page stamps them
// (countedByFields(), or the queued op's countedBy on a replay).
export function closingRpcRows(entries, by, mode = 'check') {
  return entries.map(e => ({
    item_id: e.itemId,
    qty: e.qty,
    mode: e.mode || mode,
    counted_by: by?.counted_by || null,
    counted_by_name: by?.counted_by_name || null,
  }))
}

// Thrown by the save paths when the server kept a count back. Carries the conflicts as returned
// plus what this screen tried to save, so the dialog can show both figures.
export class CountConflictError extends Error {
  constructor(conflicts) {
    super('count_conflict')
    this.name = 'CountConflictError'
    this.conflicts = conflicts
  }
}

// True when save_closing_counts is not in the schema yet — the migration is applied
// by hand, so there is a window where this code runs before it exists (the persistSalesDay
// precedent). Only a missing function falls back; every other error is returned as is.
// (persistSalesDay's isMissingFunctionError, not imported: that module loads the Supabase client,
// and this one stays pure so its tests run without one.)
export function rpcMissing(error) {
  if (!error) return false
  if (error.code === 'PGRST202' || error.code === '42883') return true
  return /could not find the function/i.test(`${error.message || ''} ${error.details || ''} ${error.hint || ''}`)
}

// Rounds away float dust from an add (0.1 + 0.2) without inventing precision a count never had.
export function addCounts(a, b) {
  return Math.round(((Number(a) || 0) + (Number(b) || 0)) * 1000) / 1000
}

// "Ram 12 + Sita 8" when a total was added from more than one count; otherwise the one name.
export function countedByLine(row) {
  const parts = Array.isArray(row?.count_parts) ? row.count_parts : null
  if (parts && parts.length > 1) {
    return parts.map(p => `${p.name || 'someone'} ${fmtQty(p.qty)}`).join(' + ')
  }
  return row?.counted_by_name || null
}

export function fmtQty(q) {
  const n = Number(q)
  if (!Number.isFinite(n)) return String(q ?? '')
  return String(Math.round(n * 1000) / 1000)
}

// One conflict in words: "Ram already counted 12 kg at 10:42."
export function conflictSentence(conflict, uom, timeText) {
  const who = countedByLine(conflict) || 'Someone'
  const multi = Array.isArray(conflict?.count_parts) && conflict.count_parts.length > 1
  const unit = uom ? ` ${uom}` : ''
  const at = timeText ? ` at ${timeText}` : ''
  return multi
    ? `This item already holds ${fmtQty(conflict.physical_qty)}${unit} (${who})${at}.`
    : `${who} already counted ${fmtQty(conflict.physical_qty)}${unit}${at}.`
}

// Every row of a multi-item dialog needs a choice before it can be saved.
export function allChosen(rows) {
  return rows.length > 0 && rows.every(r => r.choice === 'add' || r.choice === 'replace' || r.choice === 'keep')
}
