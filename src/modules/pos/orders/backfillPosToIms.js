import { lineIngredientDeltas, deltaItems } from '../../../utils/orderLineIngredients'
import { fetchAllRows, fetchAllRowsChunked } from '../../../shared/fetchAllRows'
import { daysInBsMonth, bsDayBoundaryIso } from '../../../utils/bsCalendar'
import { withTimeout } from '../../../utils/withTimeout'
import { storedDiscountRatio } from './closeAttempt'

// A closed POS bill's sales and stock use in Inventory (IMS).
//
// The DATABASE posts them since S830 (5f-1, 5f-2): the close posts its own bill
// (pos_orders_post_to_inventory), and a bill that waited (its month not open in Inventory, or a failed
// post) is posted by post_waiting_pos_bills, which Periods and the floor's "Post to Inventory" call
// through postWaitingBills below. Both run one server step (pos_post_bill_into) from the STORED bill,
// dated by the day it closed in Nepal, sales and stock lines in one transaction.
//
// billSalesRows and billMovementRows are the app's statement of that step: the SQL copies
// (pos_bill_sales_rows, pos_bill_stock_lines) are held to them by serverPostTwin.test.js and each
// migration's probe (owner decision Q30 a). Change one and change the other, with a migration whose
// probe asserts the new numbers.
//
// Sources matter: revenue-facing IMS reports exclude 'pos_comp' because a comped dish was never paid
// for, while consumption-facing reports sum every source because the food was still prepared. Getting
// this wrong would silently misstate either revenue or variance.

const lineDeltas = i => (i.selection_key ? lineIngredientDeltas(i.pos_order_item_options) : null)
const recipeLines = order => (order?.pos_order_items || []).filter(i => i.recipe_id)

/**
 * A closed bill's `sales_entries` rows. Pure.
 *
 * `order` is `{ id, close_type, discount_amount, pos_order_items }`, each line `{ recipe_id, qty,
 * unit_price, vat_rate, comped, selection_key, pos_order_item_options: [{ ingredient_deltas }] }`. Only a
 * line with a recipe posts. A comped line, and every line of a Complimentary (`writeoff`) bill, posts
 * as 'pos_comp' at full price (zero revenue by source; consumption reports read only its qty). Every
 * other line posts as 'pos' at its price less the bill discount spread over the bill's non-comped lines
 * (storedDiscountRatio: the share the till's bill and the server's discount cap use), or every
 * revenue-based IMS report would overstate revenue by the discount granted. VAT is the line's rate as
 * billed, 0 when none was stored. Each row carries the bill's own id and its line's choices.
 */
export function billSalesRows(order, period, bsDay) {
  const wholeComp = order.close_type === 'writeoff'
  const disc = wholeComp ? 0 : storedDiscountRatio(order.pos_order_items, order.discount_amount)
  return recipeLines(order).map(i => {
    const isComp = wholeComp || !!i.comped
    const deltas = lineDeltas(i)
    return {
      period_id: period.id,
      recipe_id: i.recipe_id,
      bs_day: bsDay,
      qty_sold: i.qty,
      source: isComp ? 'pos_comp' : 'pos',
      unit_price: isComp ? i.unit_price : i.unit_price * (1 - disc),
      vat_rate: i.vat_rate ?? 0,
      pos_order_id: order.id,
      ...(deltas ? { ingredient_deltas: deltas } : {}),
    }
  })
}

/**
 * A closed bill's `stock_movements` rows: each recipe line's raw items per plate (`breakdown`, as
 * explodeRecipeIngredients returns it) plus its choices' stock lines (`explosion`, for deltaItems),
 * times its quantity, summed per item into 'pos_sale' and 'pos_comp' (the sales rows' split). An item
 * whose quantity sums to zero is dropped. Pure.
 */
export function billMovementRows(order, period, bsDay, { breakdown = {}, explosion = null } = {}) {
  const wholeComp = order.close_type === 'writeoff'
  const agg = { pos_sale: {}, pos_comp: {} }
  for (const i of recipeLines(order)) {
    const bucket = (wholeComp || i.comped) ? 'pos_comp' : 'pos_sale'
    const deltas = lineDeltas(i)
    const extra = deltas ? deltaItems(deltas, explosion) : []
    for (const { item_id, qty } of [...(breakdown[i.recipe_id] || []), ...extra]) {
      agg[bucket][item_id] = (agg[bucket][item_id] || 0) + qty * i.qty
    }
  }
  return Object.entries(agg).flatMap(([source, m]) =>
    Object.entries(m)
      .filter(([, qty]) => Math.abs(qty) > 1e-9)
      .map(([item_id, qty]) => ({ item_id, period_id: period.id, bs_day: bsDay, qty: -qty, source, ref_id: order.id }))
  )
}

// AD instants bounding a BS month, for matching pos_orders.closed_at (a real timestamptz).
// Uses bsDayBoundaryIso rather than .toISOString() on a bsToAd Date — that returns local midnight,
// which at Nepal's UTC+05:45 lands on the previous day (the trap CLAUDE.md records twice).
function bsMonthRangeIso(bsYear, bsMonth) {
  const lastDay = daysInBsMonth(bsYear, bsMonth)
  return {
    fromIso: bsDayBoundaryIso(bsYear, bsMonth, 1, false),
    toIso:   bsDayBoundaryIso(bsYear, bsMonth, lastDay, true),
  }
}

/**
 * Posts a month's waiting till bills into Inventory on the server (S830 5f-2): post_waiting_pos_bills
 * runs the close's own post on up to `batch` of the month's waiting bills per call, each in its own
 * subtransaction, and is called again until a call moves nothing or none wait. Who may is the server's
 * to decide: the Owner and the operator any month, a POS manager of the outlet its open month (a refusal
 * comes back as `error`, hint rank_required). Each call is bounded; a timeout throws, and what earlier
 * calls posted stays posted.
 *
 * @returns {Promise<{ posted: number, skipped: number, waiting: number|null, failedText?: string, error? }>}
 *   `skipped`: already in Inventory or with no dish (marked done). `waiting`: the month's bills still
 *   not in Inventory after the last call (a failed post, or one the server declined), with the last
 *   call's first failure in `failedText`. `error`: a call refused or failed.
 */
export async function postWaitingBills(supabase, periodId, { batch = 100, maxCalls = 40, stepMs = 30000 } = {}) {
  let posted = 0
  let skipped = 0
  let waiting = null
  let failedText
  for (let call = 0; call < maxCalls; call++) {
    const { data, error } = await withTimeout(
      supabase.rpc('post_waiting_pos_bills', { p_period_id: periodId, p_limit: batch }),
      stepMs, 'Posting till bills to Inventory')
    if (error) return { posted, skipped, waiting, error }
    const done = Number(data?.posted) || 0
    const marked = (Number(data?.already) || 0) + (Number(data?.nothing_to_post) || 0)
    posted += done
    skipped += marked
    waiting = data?.remaining ?? null
    failedText = data?.error || undefined
    if (!waiting || done + marked === 0) break
  }
  return { posted, skipped, waiting, ...(failedText ? { failedText } : {}) }
}

// Exported for the caller's confirm dialog — how many bills are waiting for this period.
//
// It reads as the signed-in login, so it is only for a login that can read till bills (the Owner,
// the operator, a POS login): an IMS login meets no_ims_staff, reads an empty table with no error,
// and would get 0 here (IMS-HANDOFF-1). An IMS login asks pos_ims_waiting_counts (posImsWaiting.js).
export async function countUnpostedForPeriod({ supabase, scopedFrom, period }) {
  if (!period?.id) return 0
  const { fromIso, toIso } = bsMonthRangeIso(period.bs_year, period.bs_month)
  // Counts candidates, then subtracts those that already have revenue rows — so the number in
  // the confirm dialog matches what will actually be posted rather than over-promising. Both
  // reads are paged for the same reasons the backfill's own are: a month of bills outgrows the
  // 1000-row cap, and the second returns a row per sold line rather than per bill.
  const { data: candidates, error: cErr } = await fetchAllRows(() => scopedFrom('pos_orders', 'id')
    .eq('status', 'billed').is('ims_posted_at', null)
    .gte('closed_at', fromIso).lte('closed_at', toIso)
    .order('id'))
  if (cErr) throw new Error(cErr.message)
  const ids = (candidates || []).map(o => o.id)
  if (ids.length === 0) return 0
  const { data: already, error: aErr } = await fetchAllRowsChunked(
    ids,
    chunk => supabase.from('sales_entries').select('pos_order_id, id').in('pos_order_id', chunk).order('id')
  )
  if (aErr) throw new Error(aErr.message)
  const posted = new Set((already || []).map(r => r.pos_order_id).filter(Boolean))
  return ids.filter(id => !posted.has(id)).length
}
