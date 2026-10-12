import { explodeRecipeIngredients } from '../../../utils/recipeCost'
import { lineIngredientDeltas, loadDeltaExplosion, deltaItems } from '../../../utils/orderLineIngredients'
import { fetchAllRows, fetchAllRowsChunked, runChunkedByIds } from '../../../shared/fetchAllRows'
import { daysInBsMonth, bsDayBoundaryIso } from '../../../utils/bsCalendar'
import { nepalDayInPeriod } from '../../../shared/nepalPeriodDay'
import { settleWithin, withTimeout } from '../../../utils/withTimeout'
import { storedDiscountRatio } from './closeAttempt'

// A closed POS bill's sales and stock use, posted into Inventory (IMS) from what is STORED on it.
//
// Two callers, one preparation (S809 4e, IMS-HANDOFF-8/10). The till posts the bill it just closed
// (postClosedBill, below); Periods and the floor's "Post to Inventory" post every bill a month is still
// waiting for (backfillPosOrdersToIms: a bill closed while its month was not open in Inventory carries
// `ims_posted_at IS NULL` until then, S573). Both build their rows with billSalesRows and
// billMovementRows, so a bill reaches Inventory the same way whichever path got there first.
//
// Both read the bill as the SERVER holds it, never the screen: its stored lines (a comped row is comped
// whole: `pos_order_items.comped` is the durable record of the Pay tab's comp picker), its stored
// discount spread over the non-comped lines, and the day it closed in Nepal (`closed_at` is the
// server's). The till used to post from the cart, under the tablet's date at the moment of posting and
// the screen's order id, so a bill closed at 23:59 and posted after midnight landed on the next day,
// or in the next month.
//
// Sources matter: revenue-facing IMS reports exclude 'pos_comp' because a comped dish was never paid
// for, while consumption-facing reports sum every source because the food was still prepared. Getting
// this wrong would silently misstate either revenue or variance.

/**
 * The stored line columns a bill posts from: the select of one bill's lines (postClosedBill), and the
 * backfill's `pos_order_items(...)` embed. `selection_key` and the options snapshot carry a customized
 * line's choice stock lines (S758), exactly as the server froze them onto the bill.
 */
export const BILL_POST_LINES = 'recipe_id, qty, unit_price, vat_rate, comped, selection_key, pos_order_item_options(ingredient_deltas)'

const lineDeltas = i => (i.selection_key ? lineIngredientDeltas(i.pos_order_item_options) : null)
const recipeLines = order => (order?.pos_order_items || []).filter(i => i.recipe_id)

/**
 * A closed bill's `sales_entries` rows. Pure.
 *
 * `order` is `{ id, close_type, discount_amount, pos_order_items }` with BILL_POST_LINES lines. Only a
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

const recipeIdsOf = orders => [...new Set(orders.flatMap(o => recipeLines(o).map(i => i.recipe_id)))]
const deltaListsOf = orders => orders.flatMap(o => recipeLines(o).map(lineDeltas).filter(Boolean))
const isAlreadyPosted = err => err?.hint === 'pos_bill_already_posted' || /pos_bill_already_posted/.test(err?.message || '')

/**
 * Posts ONE bill the till has closed. `bill` is the STORED `pos_orders` row (the close's
 * `.select('*')`, or the read-back of a close settled after its answer was lost), never the screen's.
 *
 * - The month is the one OPEN in Inventory, and the day is the day the bill closed there, in Nepal
 *   (nepalDayInPeriod over the server's `closed_at`). A bill closed in any other month is left
 *   unposted (`other_month`): Periods → Post POS bills, or the floor's Post to Inventory, posts it into
 *   its own month, dated the same way.
 * - The lines are read back from the bill, bounded; a failed read posts nothing.
 * - The sales rows go in ONE statement. The database marks the bill posted in the same transaction and
 *   refuses a second statement for it (pos_bill_already_posted), which counts as posted here: another
 *   device got there first, with its own movements.
 * - The stock movements follow, best-effort and bounded: a depletion problem never un-posts revenue.
 *
 * Never throws (a caller may still bound the whole). `empty` is a bill with no recipe line: nothing to
 * post, so the caller marks it.
 * @returns {Promise<{ posted: boolean, reason?: 'period_read'|'no_open'|'other_month'|'lines_read'|'write', error?, empty?: boolean, already?: boolean }>}
 */
export async function postClosedBill({ supabase, scopedFrom, scopedInsert, bill, loadStockLines, stepMs = 15000 }) {
  const { data: open, error: pErr } = await settleWithin(
    scopedFrom('monthly_periods', 'id, bs_year, bs_month, status').eq('status', 'open').maybeSingle(),
    stepMs, 'Checking which month is open in Inventory')
  if (pErr) return { posted: false, reason: 'period_read', error: pErr }
  if (!open) return { posted: false, reason: 'no_open' }
  const bsDay = nepalDayInPeriod(bill?.closed_at, open)
  if (bsDay == null) return { posted: false, reason: 'other_month' }

  const { data: lines, error: lErr } = await settleWithin(
    scopedFrom('pos_order_items', BILL_POST_LINES).eq('order_id', bill.id),
    stepMs, 'Reading the bill')
  if (lErr) return { posted: false, reason: 'lines_read', error: lErr }
  const order = { ...bill, pos_order_items: lines || [] }

  const salesRows = billSalesRows(order, open, bsDay)
  if (salesRows.length === 0) return { posted: true, empty: true }
  // Plain supabase.from: sales_entries is scoped by period, not client, so scopedDb throws for it; the
  // period it names came through the scoped read above.
  const { error: sErr } = await supabase.from('sales_entries').insert(salesRows)
  if (sErr) {
    if (isAlreadyPosted(sErr)) return { posted: true, already: true }
    return { posted: false, reason: 'write', error: sErr }
  }

  try {
    const { breakdown, explosion } = await withTimeout(
      loadStockLines(recipeIdsOf([order]), deltaListsOf([order])), stepMs, 'Reading the recipe book')
    const moves = billMovementRows(order, open, bsDay, { breakdown, explosion })
    if (moves.length > 0) {
      const { error: mErr } = await withTimeout(scopedInsert('stock_movements', moves), stepMs, 'Recording the stock used')
      if (mErr) console.error('stock_movements write failed (the sales are in Inventory):', mErr)
    }
  } catch (err) {
    console.error('stock_movements write did not finish (the sales are in Inventory):', err)
  }
  return { posted: true }
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

// How many orders' writes are collapsed into one set of requests. The whole point of a batch is
// that a month of bills costs a bounded number of round trips instead of three per bill, so the
// only reason not to use one giant batch is payload size and blast radius: 40 orders is roughly
// 250 sales rows and ~1,000 movement rows per request, and a failed batch falls back to
// per-order writes so one bad bill never takes its neighbours down with it.
const WRITE_BATCH = 40

/**
 * `loadStockLines(recipeIds, deltaLists)` (S809 3j, optional) is how the recipe book is read: it
 * returns `{ breakdown, explosion }` as explodeRecipeIngredients and loadDeltaExplosion do. The till's
 * floor passes posStockLines (pos_recipe_book), because a POS manager on a Staff PIN cannot read
 * `items` and every trim loss would read as 100%; Periods (the Owner, the operator) leaves it out
 * and reads the tables directly, as before.
 *
 * @returns {{ posted: number, skipped: number, error?: string }}
 */
export async function backfillPosOrdersToIms({ supabase, scopedFrom, scopedInsert, scopedUpdate, period, loadStockLines = null }) {
  if (!period?.id) return { posted: 0, skipped: 0, error: 'No period given' }

  const { fromIso, toIso } = bsMonthRangeIso(period.bs_year, period.bs_month)

  // Paged: a month of till bills passes 1000 rows at any real volume, and a bare select would
  // return the first 1000 with no error — so the backfill would silently post part of the month
  // and report success. `.order('id')` is the unique tiebreaker paging needs; `closed_at` alone
  // is not unique (two bills close in the same second).
  const { data: orders, error: oErr } = await fetchAllRows(() => scopedFrom(
    'pos_orders',
    // The lines the till's own post reads (BILL_POST_LINES), so both paths prepare the same rows.
    `id, close_type, closed_at, discount_amount, pos_order_items(${BILL_POST_LINES})`
  )
    .eq('status', 'billed')
    .is('ims_posted_at', null)
    .gte('closed_at', fromIso).lte('closed_at', toIso)
    .order('closed_at').order('id'))

  if (oErr) return { posted: 0, skipped: 0, error: oErr.message }
  let list = orders || []
  if (list.length === 0) return { posted: 0, skipped: 0 }

  // ims_posted_at IS NULL means "not posted" only for bills closed AFTER that column existed. On
  // older rows it means "unknown", and treating unknown as unposted double-posted three bills on
  // test data (2026-08-18), duplicating their revenue.
  //
  // The guard asks the only question that matters — does revenue already exist for this bill —
  // against sales_entries.pos_order_id. An earlier version inferred it from stock_movements
  // instead and was WRONG for exactly the case that bit us: the till's post (postClosedBill, once
  // writeSalesEntries) writes revenue first and depletion second, best-effort, so a bill can have
  // revenue and no movements. Two of the three double-posted bills were that shape.
  //
  // Chunked AND paged, because this guard fails in the one direction that matters: it returns one
  // row per SOLD LINE, so a few hundred bills is already thousands of rows, and a truncated read
  // makes bills look unposted that are not — re-posting revenue is precisely the bug the guard
  // exists to prevent. (A long `.in()` list would also outrun the request URL.)
  //
  // Rows written before migration 20260818170000 have a NULL pos_order_id and are invisible to
  // this check, so a bill posted before then can still double-post. That is why the SQL cleanup
  // in the S573 notes stays worth running once per client before the first backfill.
  const { data: already, error: aErr } = await fetchAllRowsChunked(
    list.map(o => o.id),
    ids => supabase.from('sales_entries').select('pos_order_id, id').in('pos_order_id', ids).order('id')
  )
  // A dropped error here is the double-post: an empty `already` reads exactly like "none of these
  // bills has revenue yet", and every one of them would then be posted a second time.
  if (aErr) return { posted: 0, skipped: 0, error: `Could not check which bills already posted: ${aErr.message}` }
  const alreadyPosted = new Set((already || []).map(r => r.pos_order_id).filter(Boolean))
  let preStamped = 0
  if (alreadyPosted.size > 0) {
    // One update for the whole set, not one per bill — the payload is identical for every id, so
    // the loop this replaces was purely a round trip per row.
    const { error: stampErr } = await runChunkedByIds([...alreadyPosted], ids =>
      scopedUpdate('pos_orders', { ims_posted_at: new Date().toISOString() }).in('id', ids))
    if (stampErr) console.error('backfill pre-stamp failed', stampErr)
    preStamped = alreadyPosted.size
    list = list.filter(o => !alreadyPosted.has(o.id))
  }
  if (list.length === 0) return { posted: 0, skipped: preStamped }

  // One explosion for every recipe across every order, rather than per order.
  const recipeIds = recipeIdsOf(list)
  const allDeltas = deltaListsOf(list)
  let breakdown, explosion
  if (loadStockLines) {
    ;({ breakdown, explosion } = await loadStockLines(recipeIds, allDeltas))
  } else {
    breakdown = recipeIds.length > 0 ? await explodeRecipeIngredients(supabase, recipeIds) : {}
    explosion = allDeltas.length > 0 ? await loadDeltaExplosion(supabase, allDeltas) : null
  }

  // Everything each bill contributes, derived up front so the write pass below is pure batching.
  // An order with no recipe lines (an all-non-recipe bill) has nothing to post and is stamped so
  // it stops being chased.
  const prepared = []
  const nothingToPost = []
  let undated = 0
  for (const o of list) {
    if (recipeLines(o).length === 0) { nothingToPost.push(o.id); continue }

    // The day the bill closed IN NEPAL (S792, SALES-6). `adToBs(new Date(closed_at))` read the
    // viewer's clock zone while the window above is Nepal's, so a backfill run from abroad dated a
    // just-after-midnight bill to the previous day — the last day of the month before, stored inside
    // this period. A bill that cannot be placed in this period is left unposted and unstamped, so the
    // next run chases it, rather than being written under a day number that is not its own.
    const bsDay = nepalDayInPeriod(o.closed_at, period)
    if (bsDay == null) {
      console.error('backfill: bill closed outside this period in Nepal time, left unposted', o.id, o.closed_at)
      undated++
      continue
    }

    // The rows the till's own post would write for this bill (the discount, the comps, the
    // Complimentary close and the choices are all decided there, once).
    prepared.push({
      id: o.id,
      salesRows: billSalesRows(o, period, bsDay),
      movementRows: billMovementRows(o, period, bsDay, { breakdown, explosion }),
    })
  }

  let posted = 0, skipped = preStamped + undated
  const stampNow = () => new Date().toISOString()

  if (nothingToPost.length > 0) {
    const { error } = await runChunkedByIds(nothingToPost, ids =>
      scopedUpdate('pos_orders', { ims_posted_at: stampNow() }).in('id', ids))
    if (error) console.error('backfill stamp of no-op bills failed', error)
    skipped += nothingToPost.length
  }

  for (let start = 0; start < prepared.length; start += WRITE_BATCH) {
    const batch = prepared.slice(start, start + WRITE_BATCH)

    // Plain supabase.from, not scopedInsert: sales_entries is scoped by period_id, not client_id,
    // so it is deliberately excluded from CLIENT_SCOPED_TABLES and scopedDb throws for it. The
    // period we were handed is already client-scoped, which is what makes this safe — and it's
    // exactly what PosOrders' own writeSalesEntries does.
    const { error: sErr } = await supabase.from('sales_entries')
      .insert(batch.flatMap(b => b.salesRows))

    // One rejected bill must not cost its 39 neighbours. Retry the batch a bill at a time so the
    // failure is isolated to whichever bills actually caused it, and every one of them is
    // reported rather than only the first — a batch that stopped at the first error would leave
    // the rest unposted with nothing saying which.
    let ok = batch
    if (sErr) {
      ok = []
      for (const b of batch) {
        const { error } = await supabase.from('sales_entries').insert(b.salesRows)
        if (error) { console.error('backfill sales_entries failed for order', b.id, error); skipped++ }
        else ok.push(b)
      }
    }
    if (ok.length === 0) continue

    const movementRows = ok.flatMap(b => b.movementRows)
    if (movementRows.length > 0) {
      const { error: mErr } = await scopedInsert('stock_movements', movementRows)
      // Matches the live path: a failed depletion write is logged, not fatal — the revenue is
      // already in and rolling it back would be worse than a known-incomplete depletion.
      if (mErr) console.error('backfill stock_movements failed for orders', ok.map(b => b.id), mErr)
    }

    // Stamped only after its revenue landed, so a run the caller abandons on its wall clock
    // leaves every unstamped bill for the next one to pick up.
    const { error: uErr } = await runChunkedByIds(ok.map(b => b.id), ids =>
      scopedUpdate('pos_orders', { ims_posted_at: stampNow() }).in('id', ids))
    if (uErr) console.error('backfill ims_posted_at stamp failed', uErr)
    posted += ok.length
  }

  return { posted, skipped }
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
