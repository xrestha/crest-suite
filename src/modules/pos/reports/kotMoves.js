// The KOT Log's sent-versus-held arithmetic (S836): what the kitchen was sent for each bill, what
// moved to another bill afterwards, and what each bill should therefore still hold. Shared by
// Reconciliation and Bill Trail so the two tabs can never disagree about what counts as a
// discrepancy, and kept out of KotLog.jsx so it can be tested without a page.
//
// Food already sent to the kitchen can change bills (pos_table_moves, migration 20261014120000):
// "Moved dishes" to another table, a "Part bill" split off so one guest pays separately, and "Put
// back" when that part bill goes back onto the table's bill. For those three kinds ONLY the kitchen
// ticket stays on the bill it was sent from, so without this a dish moved to table 5 read on the old
// bill as "Reduced/removed after sending". A join re-points the tickets with the food, and a moved
// bill keeps its own id, so neither is counted here.
//
// The SQL twin is pos_moved_out_sent(order, key) in that migration, which the kitchen's Clear reads:
// net sent moved out of a bill = Σ lines.sent_qty where the bill is the FROM side − Σ where it is the
// TO side, skipping a row whose two sides are the same bill. The twin keys a dish on recipe#selection
// (else the name); this page has always keyed a dish on its recipe alone (orderItemKey below), so here
// the moved counts are summed per recipe the same way the tickets and the lines are.

/** The record kinds whose dishes carry sent food away from the ticket that sent it. */
export const KOT_MOVE_KINDS = ['move_dishes', 'part_bill', 'part_back']

/** What each record kind is called on the Moves tab and its sheet. */
export const MOVE_KIND_LABEL = {
  move: 'Moved bill',
  join: 'Joined table',
  release: 'Released table',
  move_dishes: 'Moved dishes',
  part_bill: 'Part bill',
  part_back: 'Put back',
}

/**
 * One bill's one dish, the key every map below shares. A line with no recipe (an old row) keys as
 * `${orderId}::null` whether the null came from the database or a missing JSON key, so its tickets,
 * its lines and its moves land in one bucket and never on a real dish.
 */
export function orderItemKey(orderId, recipeId) {
  return `${orderId}::${recipeId ?? null}`
}

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/**
 * Total ever sent, per (order_id, recipe_id) — summing every log row's printed qty gives the true
 * cumulative quantity sent to the kitchen for that item across the order's lifetime.
 */
export function sumSentQtyByOrderItem(logs) {
  const sentByOrderItem = {}
  for (const log of logs || []) {
    for (const i of (log.items || [])) {
      const key = orderItemKey(log.order_id, i.recipe_id)
      sentByOrderItem[key] = sentByOrderItem[key] || { orderId: log.order_id, recipeId: i.recipe_id ?? null, name: i.name, qty: 0 }
      sentByOrderItem[key].qty += i.qty
    }
  }
  return sentByOrderItem
}

/**
 * What each bill holds now, per (order_id, recipe_id). Sum, not assign — a partially-comped line
 * (apply_pos_item_comps splits it into two pos_order_items rows sharing the same order_id+recipe_id:
 * the shrunk paid remainder and a new comped row) would otherwise have one row silently overwrite the
 * other, understating the true current qty and falsely flagging a legitimate comp as a shrinkage
 * discrepancy.
 */
export function sumCurrentQtyByOrderItem(items) {
  const currentByOrderItem = {}
  for (const i of (items || [])) {
    const key = orderItemKey(i.order_id, i.recipe_id)
    currentByOrderItem[key] = (currentByOrderItem[key] || 0) + i.qty
  }
  return currentByOrderItem
}

/**
 * The two reads of the record (FROM side in the range's bills, TO side in them) as one list. A move
 * between two bills that are both in the range comes back from both reads, and counting it twice
 * would double what moved.
 */
export function mergeMovesById(...lists) {
  const byId = new Map()
  for (const list of lists) for (const m of list || []) if (m && !byId.has(m.id)) byId.set(m.id, m)
  return [...byId.values()]
}

/**
 * Net sent food moved OUT of each bill, per (order_id, recipe_id): positive when it left for another
 * bill, negative when it came in from another bill's ticket. Only KOT_MOVE_KINDS count; a row whose
 * two sides are the same bill is skipped (as the SQL twin's IS DISTINCT FROM); a side whose bill is
 * gone (a put-back part bill is deleted, and the record's link to it is SET NULL) is skipped on that
 * side only, so a part bill split off and put back still nets to zero on the table's bill. A line's
 * sent_qty that is not a number counts as 0, as in the twin. Keys that net to zero are dropped.
 */
export function netMovedOutSent(moves) {
  const out = {}
  for (const m of moves || []) {
    if (!m || !KOT_MOVE_KINDS.includes(m.kind)) continue
    if (m.from_order_id === m.to_order_id) continue
    for (const l of (Array.isArray(m.lines) ? m.lines : [])) {
      const sent = num(l?.sent_qty)
      if (sent === 0) continue
      for (const [orderId, sign] of [[m.from_order_id, 1], [m.to_order_id, -1]]) {
        if (orderId == null) continue
        const key = orderItemKey(orderId, l.recipe_id)
        const e = out[key] || (out[key] = { orderId, recipeId: l.recipe_id ?? null, name: l.name, qty: 0 })
        e.qty += sign * sent
      }
    }
  }
  for (const key of Object.keys(out)) if (out[key].qty === 0) delete out[key]
  return out
}

/**
 * Did sent food reach this bill from another bill's ticket? Bill Trail's "No KOT" means food served
 * with no ticket at all, and a part bill split off after the kitchen had its dishes has no ticket of
 * its own for exactly the right reason; it must not wear that warning.
 */
export function sentFoodMovedIn(moves, orderId) {
  if (orderId == null) return false
  return (moves || []).some(m => m && KOT_MOVE_KINDS.includes(m.kind)
    && m.to_order_id === orderId && m.from_order_id !== orderId
    && (Array.isArray(m.lines) ? m.lines : []).some(l => num(l?.sent_qty) > 0))
}

/**
 * What each bill should still hold of each dish: tickets sent − net moved out. Keyed over every dish
 * that was either sent on the bill's own tickets or moved onto it, so food sent on another bill's
 * ticket and then taken off this one is caught here too.
 */
export function expectedHeldByOrderItem(sentByOrderItem, movedOutByOrderItem) {
  const held = {}
  for (const [key, s] of Object.entries(sentByOrderItem || {})) {
    held[key] = { orderId: s.orderId, recipeId: s.recipeId, name: s.name, sentQty: s.qty, movedOut: 0, expected: s.qty }
  }
  for (const [key, m] of Object.entries(movedOutByOrderItem || {})) {
    const e = held[key] || (held[key] = { orderId: m.orderId, recipeId: m.recipeId, name: m.name, sentQty: 0, movedOut: 0, expected: 0 })
    e.movedOut += m.qty
    e.expected -= m.qty
  }
  return held
}

/**
 * The flagged rows: a bill holding less of a dish than it should (`discrepancy` > 0), and every dish
 * a voided bill should still have held (the food was cooked and given away). Since S836 a voided
 * bill's dish whose sent food all moved to another bill is not flagged: that food is the other
 * bill's now, and that bill's own row answers for it.
 */
export function flagOrderDiscrepancies(orderById, heldByOrderItem, currentByOrderItem) {
  const rows = []
  for (const [key, entry] of Object.entries(heldByOrderItem || {})) {
    const order = orderById[entry.orderId]
    if (!order) continue
    const currentQty = currentByOrderItem[key] || 0
    const discrepancy = entry.expected - currentQty
    const voided = order.status === 'voided'
    if (discrepancy > 0 || (voided && entry.expected > 0)) {
      rows.push({
        key,
        order, name: entry.name, sentQty: entry.sentQty, movedOut: entry.movedOut, currentQty, discrepancy,
        reason: voided ? 'Order voided — food was sent' : 'Reduced/removed after sending',
      })
    }
  }
  return rows
}

/** A Reconciliation row's Moved cell: "2 out", "1 in", or "—". */
export function movedText(movedOut) {
  if (!movedOut) return '—'
  return movedOut > 0 ? `${movedOut} out` : `${-movedOut} in`
}

/** A record line list as "Momo ×2, Tea ×1", or "—" when nothing moved with it. */
export function moveDishesText(lines) {
  const list = (Array.isArray(lines) ? lines : []).filter(Boolean)
  if (list.length === 0) return '—'
  return list.map(l => `${l.name || 'Dish'} ×${num(l.qty)}`).join(', ')
}

/**
 * One side of a record as "T5 #124". The names are as they were at the time (the record keeps names,
 * not links). A side with a bill but no table is a takeaway; a joined table with no bill of its own
 * is the table alone; nothing at all is "—".
 */
export function moveSideText(tableName, orderNo) {
  const hasNo = orderNo != null
  const name = tableName || (hasNo ? 'Takeaway' : null)
  const parts = [name, hasNo ? `#${orderNo}` : null].filter(Boolean)
  return parts.length > 0 ? parts.join(' ') : '—'
}
