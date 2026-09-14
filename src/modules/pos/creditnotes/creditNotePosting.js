import { fetchAllRows, fetchAllRowsChunked, runChunkedByIds } from '../../../shared/fetchAllRows'
import { daysInBsMonth, adToBs, bsDayBoundaryIso } from '../../../utils/bsCalendar'

// A credit note's revenue reversal in Inventory (S747).
//
// Issuing a credit note takes the credited bill's revenue back out of IMS by posting NEGATIVE
// sales_entries (source 'pos_credit'). It used to be best-effort and silent: no open period for
// today → nothing written and nothing said, and a refused insert was never read. The note printed
// while Inventory revenue stayed overstated by the whole bill, with no way to post it afterwards.
//
// Now the same shape bills already have (S573): `pos_credit_notes.ims_posted_at` is stamped only
// once the reversal has landed, every reversal row carries `pos_credit_note_id`, the issue screen
// says when it could not post, and Periods → Post POS bills to Inventory posts the waiting notes.
// That link is what the backfill asks before posting — never the stamp alone, which can fail to
// land after the rows did.

/**
 * The reversal rows for one credited bill: exactly the revenue its close POSTED, negated.
 *
 * Mirrors backfillPosToIms.js / writeSalesEntries clause for clause. Comped lines are skipped (they
 * were posted as 'pos_comp' at zero revenue, so there is nothing to take back), and the bill-level
 * discount is spread over the payable lines the same way — `unit_price × discRatio`. The reversal
 * used the raw `unit_price`, so a discounted bill's credit note took back MORE revenue than the
 * bill had ever put in, and a whole-bill comp (`writeoff`) was reversed as if it had been paid.
 */
export function creditNoteReversalRows({ order, items, periodId, bsDay, creditNoteId }) {
  if (!order || order.close_type === 'writeoff') return []
  const payable = (items || []).filter(i => i.recipe_id && !i.comped)
  const payableGross = payable.reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.unit_price) || 0), 0)
  const discount = Number(order.discount_amount) || 0
  const discRatio = payableGross > 0 ? Math.max(0, 1 - discount / payableGross) : 1
  return payable.map(i => ({
    period_id: periodId,
    recipe_id: i.recipe_id,
    bs_day: bsDay,
    qty_sold: -(Number(i.qty) || 0),
    source: 'pos_credit',
    unit_price: (Number(i.unit_price) || 0) * discRatio,
    vat_rate: i.vat_rate ?? 0,
    pos_credit_note_id: creditNoteId,
  }))
}

/**
 * Posts one just-issued note into TODAY's open period — the period the correction is discovered
 * in, not the original bill's. Never throws: a credit note is already issued and numbered when
 * this runs, so the answer is a result the screen can word, not a refusal.
 *
 * @returns {Promise<{ posted: boolean, reason?: 'no_period'|'closed'|'read'|'write', error?: any }>}
 */
export async function postCreditNoteToIms({ supabase, scopedFrom, scopedUpdate, note, order, items, today }) {
  const { data: period, error: pErr } = await scopedFrom('monthly_periods', 'id, status')
    .eq('bs_year', today.year).eq('bs_month', today.month).maybeSingle()
  if (pErr) return { posted: false, reason: 'read', error: pErr }
  if (!period) return { posted: false, reason: 'no_period' }
  if (period.status !== 'open') return { posted: false, reason: 'closed' }

  const rows = creditNoteReversalRows({ order, items, periodId: period.id, bsDay: today.day, creditNoteId: note.id })
  if (rows.length > 0) {
    // Plain supabase.from: sales_entries is period-scoped, not in CLIENT_SCOPED_TABLES.
    const { error } = await supabase.from('sales_entries').insert(rows)
    if (error) return { posted: false, reason: 'write', error }
  }
  const { error: stampErr } = await scopedUpdate('pos_credit_notes', { ims_posted_at: new Date().toISOString() }).eq('id', note.id)
  // The rows landed; only the stamp did not. The backfill finds them by pos_credit_note_id and
  // stamps the note instead of posting it again, so this is a false "waiting" mark, not a risk.
  if (stampErr) console.error('credit note ims_posted_at stamp failed', stampErr)
  return { posted: true }
}

function bsMonthRangeIso(bsYear, bsMonth) {
  return {
    fromIso: bsDayBoundaryIso(bsYear, bsMonth, 1, false),
    toIso:   bsDayBoundaryIso(bsYear, bsMonth, daysInBsMonth(bsYear, bsMonth), true),
  }
}

// Notes issued inside this period's BS month and not yet stamped.
async function unpostedNotesFor({ scopedFrom, period }) {
  const { fromIso, toIso } = bsMonthRangeIso(period.bs_year, period.bs_month)
  return fetchAllRows(() => scopedFrom('pos_credit_notes', 'id, order_id, created_at')
    .is('ims_posted_at', null)
    .gte('created_at', fromIso).lte('created_at', toIso)
    .order('created_at').order('id'))
}

// Of these notes, the ids whose reversal rows already exist. A failed read is returned as an
// error, never as "none": reading it as none is how a note would be reversed twice.
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
export async function countUnpostedCreditNotesForPeriod({ supabase, scopedFrom, period }) {
  if (!period?.id) return 0
  const { data, error } = await unpostedNotesFor({ scopedFrom, period })
  if (error) throw new Error(error.message)
  const ids = (data || []).map(n => n.id)
  if (ids.length === 0) return 0
  const done = await alreadyReversed({ supabase, ids })
  if (done.error) throw new Error(done.error.message)
  return ids.filter(id => !done.set.has(id)).length
}

/**
 * Posts every waiting credit note from this period's month into it. Idempotent: a note whose
 * reversal rows exist is stamped, not posted again. One note at a time — notes are rare, and a
 * refused one must not cost the others.
 *
 * @returns {Promise<{ posted: number, skipped: number, error?: string }>}
 */
export async function backfillCreditNotesToIms({ supabase, scopedFrom, scopedUpdate, period }) {
  if (!period?.id) return { posted: 0, skipped: 0, error: 'No period given' }
  const { data: notes, error: nErr } = await unpostedNotesFor({ scopedFrom, period })
  if (nErr) return { posted: 0, skipped: 0, error: nErr.message }
  let list = notes || []
  if (list.length === 0) return { posted: 0, skipped: 0 }

  const done = await alreadyReversed({ supabase, ids: list.map(n => n.id) })
  if (done.error) return { posted: 0, skipped: 0, error: `Could not check which credit notes already posted: ${done.error.message}` }
  const stamp = () => new Date().toISOString()
  let skipped = 0
  if (done.set.size > 0) {
    const { error } = await runChunkedByIds([...done.set], ids => scopedUpdate('pos_credit_notes', { ims_posted_at: stamp() }).in('id', ids))
    if (error) console.error('credit note pre-stamp failed', error)
    skipped += done.set.size
    list = list.filter(n => !done.set.has(n.id))
  }
  if (list.length === 0) return { posted: 0, skipped }

  const { data: orders, error: oErr } = await fetchAllRowsChunked(list.map(n => n.order_id),
    chunk => scopedFrom('pos_orders', 'id, close_type, discount_amount, pos_order_items(recipe_id, qty, unit_price, vat_rate, comped)')
      .in('id', chunk).order('id'))
  if (oErr) return { posted: 0, skipped, error: `Could not read the credited bills: ${oErr.message}` }
  const orderById = new Map((orders || []).map(o => [o.id, o]))

  let posted = 0
  for (const note of list) {
    const order = orderById.get(note.order_id)
    if (!order) { console.error('credit note backfill: bill not found for note', note.id); skipped++; continue }
    const rows = creditNoteReversalRows({
      order, items: order.pos_order_items, periodId: period.id,
      bsDay: adToBs(new Date(note.created_at)).day, creditNoteId: note.id,
    })
    if (rows.length > 0) {
      const { error } = await supabase.from('sales_entries').insert(rows)
      if (error) { console.error('credit note backfill insert failed for note', note.id, error); skipped++; continue }
    }
    const { error: sErr } = await scopedUpdate('pos_credit_notes', { ims_posted_at: stamp() }).eq('id', note.id)
    if (sErr) console.error('credit note backfill stamp failed for note', note.id, sErr)
    posted++
  }
  return { posted, skipped }
}
