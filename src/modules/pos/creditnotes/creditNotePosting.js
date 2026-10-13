import { fetchAllRows, fetchAllRowsChunked } from '../../../shared/fetchAllRows'
import { daysInBsMonth, bsDayBoundaryIso } from '../../../utils/bsCalendar'
import { withTimeout } from '../../../utils/withTimeout'
import { billCountsForIms } from '../orders/inventorySince'

// A credit note's revenue reversal in Inventory (S747).
//
// Issuing a credit note takes the credited bill's revenue back out of IMS with NEGATIVE sales_entries
// (source 'pos_credit'), each carrying `pos_credit_note_id`, and stamps `pos_credit_notes.ims_posted_at`
// once they land. A note whose food was NOT served (S809 2e, Q10 a, `pos_credit_notes.restock`) posts
// them as 'pos_credit_restock', which the shared depletion rule counts, and puts its bill's own POS Sale
// stock lines back, item by item.
//
// Since S832 (5f-4, owner Q32) the SERVER does all of it, as the bill's own post has since S830:
// `pos_credit_notes_post_to_inventory` posts a note inside the insert that issues it, from the stored
// bill (`pos_post_credit_note_into`: the bill's own 'pos' sales rows negated, its 'pos_sale' stock
// lines put back for a "not served" note, in one transaction), into the open month holding the day it
// was issued in Nepal. A failed post never refuses the note; the note waits, unmarked. Waiting notes go
// through `post_waiting_credit_notes`, after the month's bills. This file reads the mark back and
// words why a note waits, asks the server to post waiting notes, and counts them for Periods. It
// writes nothing itself.

/**
 * Whether a just-issued note is in Inventory, and if not, why — the issue screen's notice. The note's
 * own insert has already posted it or not (the server's mark is the truth); the insert's answer is
 * the row before that post marked it, so the mark is read back. Never throws: the note is issued and
 * numbered by now, so the answer is a result the screen can word.
 *
 * A note on a bill closed before the outlet's Inventory began ('before_inventory', S831 5f-3, Q31 a)
 * is never sent and reads nothing. An unmarked note is waiting; its reason is the server's, read the
 * way it reads it: no month started for today ('no_period'), today's month closed ('closed'), a "not
 * served" note whose bill's sale is not in yet ('bill_waiting'), or the post itself failed ('write').
 * A failed read of the mark is 'read': whether it went in is unknown, and the floor's count says.
 *
 * @returns {Promise<{ posted: boolean, reason?: 'no_period'|'closed'|'read'|'write'|'bill_waiting'|'before_inventory', error?: any }>}
 */
export async function creditNoteInInventory({ supabase, scopedFrom, note, order, today, imsSince = null }) {
  if (!billCountsForIms(order?.closed_at, imsSince)) return { posted: false, reason: 'before_inventory' }
  const { data: row, error } = await scopedFrom('pos_credit_notes', 'ims_posted_at').eq('id', note.id).maybeSingle()
  if (error) return { posted: false, reason: 'read', error }
  if (row?.ims_posted_at) return { posted: true }

  // It waits. Why, as pos_post_credit_note_to_ims decides it. A read failing here leaves the plain
  // "waiting" sentence, which is still true.
  const { data: period, error: pErr } = await scopedFrom('monthly_periods', 'id, status')
    .eq('bs_year', today.year).eq('bs_month', today.month).maybeSingle()
  if (pErr) return { posted: false, reason: 'write', error: pErr }
  if (!period) return { posted: false, reason: 'no_period' }
  if (period.status !== 'open') return { posted: false, reason: 'closed' }
  if (note?.restock === true) {
    // The link, never the bill's mark (S573). Plain supabase.from: sales_entries is period-scoped.
    const { data: sale, error: sErr } = await supabase.from('sales_entries').select('id')
      .eq('pos_order_id', order.id).eq('source', 'pos').limit(1)
    if (!sErr && (sale || []).length === 0) return { posted: false, reason: 'bill_waiting' }
  }
  return { posted: false, reason: 'write' }
}

/**
 * Posts a month's waiting credit notes through the server (post_waiting_credit_notes, S832 5f-4), a
 * batch per call, until nothing is left or a call moves nothing. Call it after the month's bills
 * (postWaitingBills), so a "not served" note finds its bill in. Who may: the Owner and the operator
 * any month, a POS manager the open month (the server refuses anyone else, `rank_required`). Never
 * throws except on a timeout.
 *
 * @returns {Promise<{ posted: number, skipped: number, billWaiting: number, waiting: number|null, failedText?: string, error?: any }>}
 *   `skipped`: already in Inventory, or nothing to take back (marked). `waiting`: the month's notes
 *   still not in after the last call; `billWaiting` of them wait for their bill.
 */
export async function postWaitingCreditNotes(supabase, periodId, { batch = 200, maxCalls = 20, stepMs = 30000 } = {}) {
  let posted = 0
  let skipped = 0
  let billWaiting = 0
  let waiting = null
  let failedText
  for (let call = 0; call < maxCalls; call++) {
    const { data, error } = await withTimeout(
      supabase.rpc('post_waiting_credit_notes', { p_period_id: periodId, p_limit: batch }),
      stepMs, 'Posting credit notes to Inventory')
    if (error) return { posted, skipped, billWaiting, waiting, error }
    const done = Number(data?.posted) || 0
    const marked = (Number(data?.already) || 0) + (Number(data?.nothing_to_post) || 0)
    posted += done
    skipped += marked
    billWaiting = Number(data?.bill_waiting) || 0
    waiting = data?.remaining ?? null
    failedText = data?.error || undefined
    if (!waiting || done + marked === 0) break
  }
  return { posted, skipped, billWaiting, waiting, ...(failedText ? { failedText } : {}) }
}

function bsMonthRangeIso(bsYear, bsMonth) {
  return {
    fromIso: bsDayBoundaryIso(bsYear, bsMonth, 1, false),
    toIso:   bsDayBoundaryIso(bsYear, bsMonth, daysInBsMonth(bsYear, bsMonth), true),
  }
}

// Notes issued inside this period's BS month and not yet stamped, leaving out a note on a bill closed
// before the outlet's Inventory began (S831 5f-3, Q31 a): it is never sent, so it never waits. The
// bill's close comes with each note (the hinted embed: pos_orders also points back at the note).
async function unpostedNotesFor({ scopedFrom, period, imsSince = null }) {
  const { fromIso, toIso } = bsMonthRangeIso(period.bs_year, period.bs_month)
  const res = await fetchAllRows(() => scopedFrom('pos_credit_notes', 'id, order_id, created_at, restock, pos_orders!pos_credit_notes_order_id_fkey(closed_at)')
    .is('ims_posted_at', null)
    .gte('created_at', fromIso).lte('created_at', toIso)
    .order('created_at').order('id'))
  if (res.error || !imsSince) return res
  return { ...res, data: (res.data || []).filter(n => billCountsForIms(n.pos_orders?.closed_at, imsSince)) }
}

// Of these notes, the ids whose reversal rows already exist. A failed read is returned as an
// error, never as "none": reading it as none is how a note would be counted as waiting twice.
async function alreadyReversed({ supabase, ids }) {
  const { data, error } = await fetchAllRowsChunked(ids,
    chunk => supabase.from('sales_entries').select('pos_credit_note_id, id').in('pos_credit_note_id', chunk).order('id'))
  if (error) return { error }
  return { set: new Set((data || []).map(r => r.pos_credit_note_id).filter(Boolean)) }
}

/**
 * How many credit notes issued in this period's month are still waiting — for Periods' confirm.
 * Throws on a failed read, as countUnpostedForPeriod does.
 */
export async function countUnpostedCreditNotesForPeriod({ supabase, scopedFrom, period, imsSince = null }) {
  if (!period?.id) return 0
  const { data, error } = await unpostedNotesFor({ scopedFrom, period, imsSince })
  if (error) throw new Error(error.message)
  const ids = (data || []).map(n => n.id)
  if (ids.length === 0) return 0
  const done = await alreadyReversed({ supabase, ids })
  if (done.error) throw new Error(done.error.message)
  return ids.filter(id => !done.set.has(id)).length
}
