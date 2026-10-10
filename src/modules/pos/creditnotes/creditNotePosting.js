import { fetchAllRows, fetchAllRowsChunked, runChunkedByIds } from '../../../shared/fetchAllRows'
import { daysInBsMonth, bsDayBoundaryIso } from '../../../utils/bsCalendar'
import { lineIngredientDeltas } from '../../../utils/orderLineIngredients'
import { nepalDayInPeriod } from '../../../shared/nepalPeriodDay'

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
//
// S809 2e (CREDIT-NOTES-1, owner decision Q10 a): a note whose food was NOT served on its bill (the
// bill is billed again on a new one, or it was a duplicate — `pos_credit_notes.restock`) posts the
// same reversal rows under source 'pos_credit_restock', which the shared depletion rule counts, so
// the plates come back out of stock usage; and it puts the bill's own POS Sale depletion back into
// stock_movements, item by item (source 'pos_credit_restock', ref_id the bill). Revenue and every
// revenue report read the rows exactly as a 'pos_credit' reversal. The database refuses a plain
// 'pos_credit' row for such a note (credit_note_restock_mismatch), so a page older than this cannot
// post it as if the food was served.
export const CREDIT_SOURCE = 'pos_credit'
export const RESTOCK_SOURCE = 'pos_credit_restock'

/**
 * The reversal rows for one credited bill: exactly the revenue its close POSTED, negated.
 *
 * Mirrors backfillPosToIms.js / writeSalesEntries clause for clause. Comped lines are skipped (they
 * were posted as 'pos_comp' at zero revenue, so there is nothing to take back), and the bill-level
 * discount is spread over the payable lines the same way — `unit_price × discRatio`. The reversal
 * used the raw `unit_price`, so a discounted bill's credit note took back MORE revenue than the
 * bill had ever put in, and a whole-bill comp (`writeoff`) was reversed as if it had been paid.
 */
export function creditNoteReversalRows({ order, items, periodId, bsDay, creditNoteId, restock = false }) {
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
    source: restock ? RESTOCK_SOURCE : CREDIT_SOURCE,
    unit_price: (Number(i.unit_price) || 0) * discRatio,
    vat_rate: i.vat_rate ?? 0,
    pos_credit_note_id: creditNoteId,
    // A customized line's choices ride along (S758) so a reader rebuilding usage from sales treats
    // the reversal as the same plate the sale was.
    ...(lineIngredientDeltas(i.pos_order_item_options || i.options) ? { ingredient_deltas: lineIngredientDeltas(i.pos_order_item_options || i.options) } : {}),
  }))
}

/**
 * The stock a "not served" note puts back (S809 2e): its bill's own POS Sale depletion, negated item
 * by item, on the note's Inventory day. Only items the bill took stock of — nothing when the bill's
 * depletion never landed (a dish with no ingredients, or a failed write), which is what the ledger
 * holds. `saleMovements` are the bill's 'pos_sale' stock_movements rows (item_id, negative qty).
 */
export function creditNoteRestockMovements({ saleMovements, periodId, bsDay, orderId }) {
  const byItem = new Map()
  for (const m of saleMovements || []) {
    if (!m.item_id) continue
    byItem.set(m.item_id, (byItem.get(m.item_id) || 0) + (Number(m.qty) || 0))
  }
  return [...byItem]
    .filter(([, qty]) => qty < -1e-9)
    .map(([item_id, qty]) => ({ item_id, period_id: periodId, bs_day: bsDay, qty: -qty, source: RESTOCK_SOURCE, ref_id: orderId }))
}

// What a "not served" note needs before it posts: whether its bill's own sale reached Inventory (the
// link, never the bill's stamp — S573), and the stock that sale took. Posted before its bill, the note
// would put back stock the bill has not taken yet, and the bill's later post would take it again; so
// the note waits for its bill, which is the order Periods already posts in (bills, then notes).
async function readRestockSource({ supabase, scopedFrom, orderId }) {
  const [posted, moves] = await Promise.all([
    supabase.from('sales_entries').select('id').eq('pos_order_id', orderId).eq('source', 'pos').limit(1),
    fetchAllRows(() => scopedFrom('stock_movements', 'item_id, qty').eq('ref_id', orderId).eq('source', 'pos_sale').order('id')),
  ])
  const error = posted.error || moves.error
  if (error) return { error }
  return { billPosted: (posted.data || []).length > 0, saleMovements: moves.data || [] }
}

// Best-effort, as the bill's own depletion is (writeSalesEntries, S573): the revenue reversal is what
// the waiting mark tracks. The database keeps one row per bill and item
// (stock_movements_one_restock_per_bill_item), so a second post is refused rather than doubled.
async function writeRestockMovements({ scopedInsert, rows }) {
  if (rows.length === 0) return
  if (!scopedInsert) { console.error('credit note restock: no scopedInsert given, stock not put back'); return }
  const { error } = await scopedInsert('stock_movements', rows)
  if (error) console.error('credit note restock: stock_movements write failed', error)
}

/**
 * Posts one just-issued note into TODAY's open period — the period the correction is discovered
 * in, not the original bill's. Never throws: a credit note is already issued and numbered when
 * this runs, so the answer is a result the screen can word, not a refusal.
 *
 * A note whose food was not served (`note.restock`, S809 2e) also puts its bill's stock back, and
 * waits ('bill_waiting') while the bill's own sale has not reached Inventory.
 *
 * @returns {Promise<{ posted: boolean, reason?: 'no_period'|'closed'|'read'|'write'|'bill_waiting', error?: any }>}
 */
export async function postCreditNoteToIms({ supabase, scopedFrom, scopedInsert, scopedUpdate, note, order, items, today }) {
  const { data: period, error: pErr } = await scopedFrom('monthly_periods', 'id, status')
    .eq('bs_year', today.year).eq('bs_month', today.month).maybeSingle()
  if (pErr) return { posted: false, reason: 'read', error: pErr }
  if (!period) return { posted: false, reason: 'no_period' }
  if (period.status !== 'open') return { posted: false, reason: 'closed' }

  const restock = note?.restock === true
  const rows = creditNoteReversalRows({ order, items, periodId: period.id, bsDay: today.day, creditNoteId: note.id, restock })
  let restockRows = []
  if (restock && rows.length > 0) {
    const src = await readRestockSource({ supabase, scopedFrom, orderId: order.id })
    if (src.error) return { posted: false, reason: 'read', error: src.error }
    if (!src.billPosted) return { posted: false, reason: 'bill_waiting' }
    restockRows = creditNoteRestockMovements({ saleMovements: src.saleMovements, periodId: period.id, bsDay: today.day, orderId: order.id })
  }
  if (rows.length > 0) {
    // Plain supabase.from: sales_entries is period-scoped, not in CLIENT_SCOPED_TABLES.
    const { error } = await supabase.from('sales_entries').insert(rows)
    // S809 3j: another post got there first (a manager's Post to Inventory on the floor, or the
    // Owner's in Periods, in the same moment). The database took the note off Inventory sales once,
    // marked it, and refused this second reversal, so the note IS posted; its stock, if any, went
    // back with that post.
    if (error && (error.hint === 'pos_credit_note_already_posted' || /pos_credit_note_already_posted/.test(error.message || ''))) return { posted: true }
    if (error) return { posted: false, reason: 'write', error }
  }
  await writeRestockMovements({ scopedInsert, rows: restockRows })
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
  return fetchAllRows(() => scopedFrom('pos_credit_notes', 'id, order_id, created_at, restock')
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
 * refused one must not cost the others. A "not served" note (S809 2e) puts its bill's stock back,
 * and stays waiting (skipped) while its bill's own sale has not reached Inventory.
 *
 * @returns {Promise<{ posted: number, skipped: number, error?: string }>}
 */
export async function backfillCreditNotesToIms({ supabase, scopedFrom, scopedInsert, scopedUpdate, period }) {
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
    chunk => scopedFrom('pos_orders', 'id, close_type, discount_amount, pos_order_items(recipe_id, qty, unit_price, vat_rate, comped, pos_order_item_options(ingredient_deltas))')
      .in('id', chunk).order('id'))
  if (oErr) return { posted: 0, skipped, error: `Could not read the credited bills: ${oErr.message}` }
  const orderById = new Map((orders || []).map(o => [o.id, o]))

  let posted = 0
  for (const note of list) {
    const order = orderById.get(note.order_id)
    if (!order) { console.error('credit note backfill: bill not found for note', note.id); skipped++; continue }
    // The day the note was issued IN NEPAL (S792, SALES-6) — the window above is Nepal's, and
    // `adToBs(new Date(created_at))` read the viewer's clock zone instead. A note that cannot be
    // placed in this period is left waiting rather than written under a day number not its own.
    const bsDay = nepalDayInPeriod(note.created_at, period)
    if (bsDay == null) { console.error('credit note backfill: note issued outside this period in Nepal time, left waiting', note.id, note.created_at); skipped++; continue }
    const restock = note.restock === true
    const rows = creditNoteReversalRows({
      order, items: order.pos_order_items, periodId: period.id,
      bsDay, creditNoteId: note.id, restock,
    })
    let restockRows = []
    if (restock && rows.length > 0) {
      const src = await readRestockSource({ supabase, scopedFrom, orderId: order.id })
      if (src.error) { console.error('credit note backfill: could not read the bill a not-served note puts back', note.id, src.error); skipped++; continue }
      if (!src.billPosted) { console.error('credit note backfill: its bill has not reached Inventory yet, note left waiting', note.id); skipped++; continue }
      restockRows = creditNoteRestockMovements({ saleMovements: src.saleMovements, periodId: period.id, bsDay, orderId: order.id })
    }
    if (rows.length > 0) {
      const { error } = await supabase.from('sales_entries').insert(rows)
      if (error) { console.error('credit note backfill insert failed for note', note.id, error); skipped++; continue }
    }
    await writeRestockMovements({ scopedInsert, rows: restockRows })
    const { error: sErr } = await scopedUpdate('pos_credit_notes', { ims_posted_at: stamp() }).eq('id', note.id)
    if (sErr) console.error('credit note backfill stamp failed for note', note.id, sErr)
    posted++
  }
  return { posted, skipped }
}
