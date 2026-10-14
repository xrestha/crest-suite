// Table move, join and split (S836): the floor's arithmetic, kept apart from PosOrders.jsx so it can be
// tested. The database decides (move_pos_order_table, join_pos_tables, move_pos_order_lines,
// split_pos_part_bill, put_back_part_bill, release_joined_table, migration 20261014120000); these only
// decide what the till OFFERS, and say the same no the server would.

// The table whose own bill a joined table is on: the floor's tableOrders (table id → that table's open
// bill) holds it under the main table's id. Null when this till's floor read has not caught up.
export function mainTableOfJoin(joinOrderId, tableOrders) {
  if (!joinOrderId) return null
  return Object.keys(tableOrders || {}).find(id => tableOrders[id]?.orderId === joinOrderId) || null
}

// The tables joined to one bill, in floor order.
export function joinedTablesOf(orderId, tableJoins, tables) {
  if (!orderId) return []
  return (tables || []).filter(t => tableJoins?.[t.id] === orderId)
}

// What a table offers in the Move or join dialog. One action per tile: `move` (a free table, Move
// mode), `join` (Join mode, or a table with a bill in Move mode — moving onto it would make two bills
// on one table, so the till offers the join the server would ask for), or null with the reason.
export function tableMoveChoice(t, { mode, tableOrders, tableJoins, currentTableId, currentOrderId, nameOf = () => 'another table' }) {
  const own = tableOrders?.[t.id] || null
  const joinedTo = tableJoins?.[t.id] || null
  if (t.id === currentTableId) return { action: null, hasBill: false, label: 'This bill' }
  if (joinedTo && joinedTo === currentOrderId) return { action: null, hasBill: false, label: 'On this bill' }
  if (joinedTo) {
    const main = mainTableOfJoin(joinedTo, tableOrders)
    const withName = main ? nameOf(main) : 'another table'
    return { action: null, hasBill: false, label: `With ${withName}`, hint: `${t.name} is on ${withName}'s bill. Release it from that bill first.` }
  }
  if (t.status === 'inactive') return { action: null, hasBill: false, label: 'Out of service' }
  if (own?.offlinePending) {
    return { action: null, hasBill: true, label: 'Not uploaded yet', hint: `${t.name}'s order is still on a till waiting to upload. Try again once it has.` }
  }
  if (own) {
    const items = Number(own.itemCount) || 0
    return { action: 'join', hasBill: true, label: `Has a bill · ${items} item${items === 1 ? '' : 's'} · join it` }
  }
  return mode === 'move'
    ? { action: 'move', hasBill: false, label: `Free · ${t.capacity || 0} seats` }
    : { action: 'join', hasBill: false, label: 'Free · add as extra seats' }
}

// Where some dishes may go: any table but this bill's own and its joined ones, in service, not on
// another bill's join (the dishes would land on that bill: offered, and named), and not waiting to
// upload. `bill` says which bill receives them.
export function dishTargetChoice(t, { tableOrders, tableJoins, currentTableId, currentOrderId, nameOf = () => 'another table' }) {
  const own = tableOrders?.[t.id] || null
  const joinedTo = tableJoins?.[t.id] || null
  if (t.id === currentTableId || (joinedTo && joinedTo === currentOrderId)) return { ok: false, label: 'This bill' }
  if (t.status === 'inactive') return { ok: false, label: 'Out of service' }
  if (own?.offlinePending) return { ok: false, label: 'Not uploaded yet' }
  if (joinedTo) {
    const main = mainTableOfJoin(joinedTo, tableOrders)
    return { ok: true, hasBill: true, label: `On ${main ? nameOf(main) : 'another table'}'s bill` }
  }
  if (own) return { ok: true, hasBill: true, label: 'Has a bill' }
  return { ok: true, hasBill: false, label: 'Free' }
}

// The dialog's counts as the server's picks: [{ item_id, qty }] for every line with a count above 0,
// each capped at its line. Comped lines never move (the server refuses them too).
export function picksFromCounts(lines, counts) {
  const out = []
  for (const l of lines || []) {
    if (!l?.id || l.comped) continue
    const q = Math.min(Math.max(0, Math.floor(Number(counts?.[l.id]) || 0)), Number(l.qty) || 0)
    if (q > 0) out.push({ item_id: l.id, qty: q })
  }
  return out
}

// Whether the picks take every dish off the bill (the server refuses that: Move, or the bill's own
// Payment, is the way). Comped lines do not count as dishes left.
export function picksTakeEverything(lines, picks) {
  const picked = new Map((picks || []).map(p => [p.item_id, p.qty]))
  return (lines || []).filter(l => !l.comped).every(l => (picked.get(l.id) || 0) >= (Number(l.qty) || 0))
}

// One dish's identity, as save_pos_order_items and the kitchen guard key it: recipe#choices, else the name.
export const moveLineKey = l => (l?.recipe_id
  ? `${l.recipe_id}${l.selection_key ? `#${l.selection_key}` : ''}`
  : `name:${l?.name || ''}`)

// What a station still has to make for a bill, from its tickets that are not served or cancelled
// (change tickets left out), as move-slip lines per station: { KOT: [...], BOT: [...] }, one line per
// dish with the quantities added up. `onlyKeys` (a Map of line key → units moved that were already
// sent) narrows it to the dishes that moved, each capped at what moved: a dish move only tells the
// kitchen about the food that left.
export function moveSlipItems(tickets, onlyKeys = null) {
  const live = new Set(['new', 'in_progress', 'ready'])
  const byStation = { KOT: new Map(), BOT: new Map() }
  for (const t of tickets || []) {
    if (!live.has(t?.status) || !byStation[t.station]) continue
    for (const i of t.items || []) {
      if (!i || i.change === true) continue
      const qty = Number(i.qty) || 0
      if (qty <= 0) continue
      const k = moveLineKey(i)
      const m = byStation[t.station]
      const prev = m.get(k)
      m.set(k, prev ? { ...prev, qty: prev.qty + qty } : { name: i.name, qty, notes: i.notes || '', options: i.options || null, recipe_id: i.recipe_id || null, selection_key: i.selection_key || '', combo_name: i.combo_name || null })  // S839: the MOVE slip names a combo dish's combo
    }
  }
  const out = {}
  for (const st of ['KOT', 'BOT']) {
    let lines = [...byStation[st].entries()]
    if (onlyKeys) {
      const left = new Map(onlyKeys)
      lines = lines.map(([k, l]) => {
        const cap = left.get(k) || 0
        const qty = Math.min(l.qty, cap)
        if (qty > 0) left.set(k, cap - qty)
        return [k, { ...l, qty }]
      }).filter(([, l]) => l.qty > 0)
    }
    if (lines.length) out[st] = lines.map(([, l]) => l)
  }
  return out
}

// The sent units of each dish a move took (its answer's `lines`), keyed as moveSlipItems wants.
export function movedSentByKey(lines) {
  const m = new Map()
  for (const l of lines || []) {
    const sent = Number(l?.sent_qty) || 0
    if (sent <= 0) continue
    const k = moveLineKey(l)
    m.set(k, (m.get(k) || 0) + sent)
  }
  return m
}

// The Kitchen Display's notice of a move: a CHANGE ticket (qty 0, change: true; kitchenNotes.js) per
// station, on the bill that now carries the food and under its table, one line per dish with where
// it came from. Its Seen clears it; no ticket count includes it.
export function moveNoticeItems(slipLines, fromName) {
  return (slipLines || []).map(l => ({
    recipe_id: l.recipe_id || null,
    name: l.name,
    ...(l.selection_key ? { selection_key: l.selection_key, options: l.options || null } : {}),
    ...(l.combo_name ? { combo_name: l.combo_name } : {}),   // S839: the KDS names a combo dish's combo
    notes: `Moved from ${fromName} (×${l.qty})`,
    qty: 0,
    change: true,
  }))
}

// A part bill's name on the floor and the Billing list.
export const partBillLabel = (tableName, orderNo) => `${tableName || 'Table'} · part bill${orderNo ? ` #${orderNo}` : ''}`
