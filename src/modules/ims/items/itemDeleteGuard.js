import { ITEM_REF_TABLES, USAGE_LABELS, forceDeleteBlockedText } from './itemRefTables'

// S792 (FIGURES-1, owner decision D29): hiding never changes history. Past months keep every
// purchase and count the item is on, on the monthly summary and every other report; hiding only
// takes it off the pickers and the stock sheet from now on. The old wording said a hidden item left
// stock valuation and the monthly summary, which D29 ruled out.
export const HIDE_INSTEAD =
  'Hide it instead: it keeps every record it is already on, and past months keep its purchases and counts. ' +
  'Hiding only takes it off the pickers and the stock sheet from now on, so hide it once its stock is down to zero.'

/**
 * What pressing Del on an Item Master row does, decided from the usage scan alone. Moved out of
 * `deleteItem` in S855 (PERF-3) so every branch is pinned by Items.test.js. Returns one of:
 *
 *   { action: 'refuse', text, scanPending? }  say `text` on the page and stop
 *   { action: 'force', lead }                 admin: offer force-delete, the dialog led by `lead`
 *   { action: 'confirm' }                     nothing references the item: the plain delete confirm
 *
 * `status` is the scan's tri-state: 'pending' (still running), 'ok' (answered) or 'failed'.
 *
 * Fails CLOSED: anything but 'ok' refuses, whatever `refs` holds. Three of the eleven referencing
 * tables are ON DELETE CASCADE, so "the database will stop me" is true for five of them and false
 * for three: a delete run on an unchecked item does not fail safely, it destroys requisition lines,
 * staff meals and vendor returns without asking. Since S855 the list paints before the scan lands,
 * so "pending" is a state a press can now meet, and it must not read as "nothing references it"
 * (the S706 rule) or as a failed check (it is about to answer). `scanPending` marks that refusal so
 * the page can take it down once the scan answers.
 */
export function deleteGuard({ name, refs = [], status, failed = [], isAdmin = false }) {
  if (status === 'pending') {
    return {
      action: 'refuse', scanPending: true,
      text: `Still checking where "${name}" is used. Try again in a moment.`,
    }
  }
  if (status !== 'ok') {
    return {
      action: 'refuse',
      text:
        `Crest could not check where "${name}" is used${failed.length ? ` — ${failed.join(', ')} could not be read` : ''}, so it will not delete it. ` +
        'Some of those records would be removed along with the item rather than blocking the delete, and there is no undo. Reload the page and try again; if the check keeps failing, hide the item instead.',
    }
  }
  if (refs.length === 0) return { action: 'confirm' }
  const fullNames = refs.map(code => USAGE_LABELS[code] || code).join(', ')
  if (!isAdmin) {
    // "Deleting it would take those records with it" is only true of the tables that CASCADE.
    // A Closing Stock count or a purchase line refuses the delete rather than going with it, so
    // the message claims erasure only for the tables where it would really happen (S766).
    const erased = ITEM_REF_TABLES.filter(t => t.cascades && refs.includes(t.label)).map(t => t.name)
    return {
      action: 'refuse',
      text:
        `"${name}" cannot be deleted — it has records in ${fullNames}, and an item stays in Item Master for as long as any record names it.` +
        (erased.length ? ` Deleting it would also erase its ${erased.join(', ')} records.` : '') +
        ` ${HIDE_INSTEAD}`,
    }
  }
  // S849 (PNL-8): an item that moved between outlets is never force-deleted. force_delete_item
  // refuses it (one outlet's half of a transfer must not vanish while the other half stands), so
  // the dialog is not offered at all: the page says why and points at Hide.
  const blocked = forceDeleteBlockedText(refs)
  if (blocked) return { action: 'refuse', text: `"${name}" cannot be deleted — it has records in ${fullNames}. ${blocked}` }
  return { action: 'force', lead: `"${name}" is referenced in ${fullNames}.` }
}
