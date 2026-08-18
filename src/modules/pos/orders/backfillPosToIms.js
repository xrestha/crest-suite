import { explodeRecipeIngredients } from '../../../utils/recipeCost'
import { daysInBsMonth, adToBs, bsDayBoundaryIso } from '../../../utils/bsCalendar'

// Posts POS bills into IMS that were closed while no matching BS period was open.
//
// PosOrders' writeSalesEntries() bails when it can't find an open period for today, so the bill
// closes, prints and takes an invoice number while Inventory never sees its revenue or ingredient
// usage (S573). Those bills carry `ims_posted_at IS NULL`. Once the period is created, this
// reposts them and stamps the flag.
//
// Deliberately derives everything from STORED rows rather than reusing writeSalesEntries: that
// function closes over live component state (the current cart, the Pay tab's comp picker, the
// bill-level discount ratio), none of which exists after the fact. `pos_order_items.comped` is the
// durable record of the same split, and the discount is re-derived from the order's own
// discount_amount — so this reaches the same answer from the data instead of from the screen.
//
// Sources match the live path exactly and that matters: revenue-facing IMS reports exclude
// 'pos_comp' because a comped dish was never paid for, while consumption-facing reports sum every
// source because the food was still prepared. Getting this wrong would silently misstate either
// revenue or variance.

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
 * @returns {{ posted: number, skipped: number, error?: string }}
 */
export async function backfillPosOrdersToIms({ supabase, scopedFrom, scopedInsert, scopedUpdate, period }) {
  if (!period?.id) return { posted: 0, skipped: 0, error: 'No period given' }

  const { fromIso, toIso } = bsMonthRangeIso(period.bs_year, period.bs_month)

  const { data: orders, error: oErr } = await scopedFrom(
    'pos_orders',
    'id, close_type, closed_at, discount_amount, pos_order_items(recipe_id, qty, unit_price, vat_rate, comped)'
  )
    .eq('status', 'billed')
    .is('ims_posted_at', null)
    .gte('closed_at', fromIso).lte('closed_at', toIso)
    .order('closed_at')

  if (oErr) return { posted: 0, skipped: 0, error: oErr.message }
  let list = orders || []
  if (list.length === 0) return { posted: 0, skipped: 0 }

  // ims_posted_at IS NULL means "not posted" only for bills closed AFTER that column existed. On
  // older rows it means "unknown", and treating unknown as unposted double-posted three bills on
  // test data (2026-08-18), duplicating their revenue.
  //
  // The guard asks the only question that matters — does revenue already exist for this bill —
  // against sales_entries.pos_order_id. An earlier version inferred it from stock_movements
  // instead and was WRONG for exactly the case that bit us: writeSalesEntries writes revenue
  // first and depletion second inside a try/catch that swallows failures, so a bill can have
  // revenue and no movements. Two of the three double-posted bills were that shape.
  //
  // Rows written before migration 20260818170000 have a NULL pos_order_id and are invisible to
  // this check, so a bill posted before then can still double-post. That is why the SQL cleanup
  // in the S573 notes stays worth running once per client before the first backfill.
  const { data: already } = await supabase
    .from('sales_entries').select('pos_order_id')
    .in('pos_order_id', list.map(o => o.id))
  const alreadyPosted = new Set((already || []).map(r => r.pos_order_id).filter(Boolean))
  let preStamped = 0
  if (alreadyPosted.size > 0) {
    for (const id of alreadyPosted) {
      await scopedUpdate('pos_orders', { ims_posted_at: new Date().toISOString() }).eq('id', id)
      preStamped++
    }
    list = list.filter(o => !alreadyPosted.has(o.id))
  }
  if (list.length === 0) return { posted: 0, skipped: preStamped }

  // One explosion for every recipe across every order, rather than per order.
  const recipeIds = [...new Set(list.flatMap(o => (o.pos_order_items || []).map(i => i.recipe_id).filter(Boolean)))]
  const breakdown = recipeIds.length > 0 ? await explodeRecipeIngredients(supabase, recipeIds) : {}

  let posted = 0, skipped = preStamped
  for (const o of list) {
    const items = (o.pos_order_items || []).filter(i => i.recipe_id)
    if (items.length === 0) {
      // Nothing to post (e.g. an all-non-recipe bill) — stamp it so it stops being chased.
      await scopedUpdate('pos_orders', { ims_posted_at: new Date().toISOString() }).eq('id', o.id)
      skipped++
      continue
    }

    const bsDay = adToBs(new Date(o.closed_at)).day

    // A bill-level discount reduces the taxable base proportionally across payable (non-comped)
    // lines — the same treatment the live path applies, or every revenue-based IMS report would
    // overstate revenue by the discount actually granted. Comped lines stay at full price: they
    // are already zero-revenue by source, and consumption reports never read unit_price from them.
    const payableGross = items
      .filter(i => !i.comped)
      .reduce((s, i) => s + (i.qty * i.unit_price), 0)
    const discount = Number(o.discount_amount) || 0
    const discRatio = payableGross > 0 ? Math.max(0, 1 - discount / payableGross) : 1

    // A whole-order Complimentary close comps everything regardless of the per-line flag.
    const wholeComp = o.close_type === 'writeoff'

    const salesRows = items.map(i => {
      const isComp = wholeComp || i.comped
      return {
        period_id: period.id,
        recipe_id: i.recipe_id,
        bs_day: bsDay,
        qty_sold: i.qty,
        source: isComp ? 'pos_comp' : 'pos',
        unit_price: isComp ? i.unit_price : i.unit_price * discRatio,
        vat_rate: i.vat_rate ?? 0,
        pos_order_id: o.id,
      }
    })

    // Plain supabase.from, not scopedInsert: sales_entries is scoped by period_id, not client_id,
    // so it is deliberately excluded from CLIENT_SCOPED_TABLES and scopedDb throws for it. The
    // period we were handed is already client-scoped, which is what makes this safe — and it's
    // exactly what PosOrders' own writeSalesEntries does.
    const { error: sErr } = await supabase.from('sales_entries').insert(salesRows)
    if (sErr) { skipped++; continue }

    // Ingredient depletion, split by the same sale/comp buckets.
    const agg = { pos_sale: {}, pos_comp: {} }
    items.forEach(i => {
      const bucket = (wholeComp || i.comped) ? 'pos_comp' : 'pos_sale'
      ;(breakdown[i.recipe_id] || []).forEach(({ item_id, qty }) => {
        agg[bucket][item_id] = (agg[bucket][item_id] || 0) + qty * i.qty
      })
    })
    const movementRows = Object.entries(agg).flatMap(([source, m]) =>
      Object.entries(m).map(([item_id, qty]) => ({
        item_id, period_id: period.id, bs_day: bsDay, qty: -qty, source, ref_id: o.id,
      }))
    )
    if (movementRows.length > 0) {
      const { error: mErr } = await scopedInsert('stock_movements', movementRows)
      // Matches the live path: a failed depletion write is logged, not fatal — the revenue is
      // already in and rolling it back would be worse than a known-incomplete depletion.
      if (mErr) console.error('backfill stock_movements failed for order', o.id, mErr)
    }

    await scopedUpdate('pos_orders', { ims_posted_at: new Date().toISOString() }).eq('id', o.id)
    posted++
  }

  return { posted, skipped }
}

// Exported for the caller's confirm dialog — how many bills are waiting for this period.
export async function countUnpostedForPeriod({ supabase, scopedFrom, period }) {
  if (!period?.id) return 0
  const { fromIso, toIso } = bsMonthRangeIso(period.bs_year, period.bs_month)
  // Counts candidates, then subtracts those that already have revenue rows — so the number in
  // the confirm dialog matches what will actually be posted rather than over-promising.
  const { data: candidates } = await scopedFrom('pos_orders', 'id')
    .eq('status', 'billed').is('ims_posted_at', null)
    .gte('closed_at', fromIso).lte('closed_at', toIso)
  const ids = (candidates || []).map(o => o.id)
  if (ids.length === 0) return 0
  const { data: already } = await supabase
    .from('sales_entries').select('pos_order_id').in('pos_order_id', ids)
  const posted = new Set((already || []).map(r => r.pos_order_id).filter(Boolean))
  return ids.filter(id => !posted.has(id)).length
}
