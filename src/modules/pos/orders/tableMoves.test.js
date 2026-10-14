import {
  mainTableOfJoin, joinedTablesOf, tableMoveChoice, dishTargetChoice, picksFromCounts, picksTakeEverything,
  moveLineKey, moveSlipItems, movedSentByKey, moveNoticeItems, partBillLabel,
} from './tableMoves'

const T = (id, extra = {}) => ({ id, name: id.toUpperCase(), capacity: 4, status: 'available', ...extra })
const tables = [T('t1'), T('t2'), T('t3'), T('t4', { status: 'inactive' }), T('t5')]
const tableOrders = { t1: { orderId: 'o1', itemCount: 3 }, t2: { orderId: 'o2', itemCount: 1 }, t5: { orderId: 'o5', itemCount: 2, offlinePending: true } }
const tableJoins = { t3: 'o1' }
const nameOf = id => tables.find(t => t.id === id)?.name

describe('joins on the floor', () => {
  test('a joined table points at the table whose bill it is on', () => {
    expect(mainTableOfJoin('o1', tableOrders)).toBe('t1')
    expect(mainTableOfJoin('o9', tableOrders)).toBeNull()
    expect(mainTableOfJoin(null, tableOrders)).toBeNull()
  })
  test('a bill lists its joined tables in floor order', () => {
    expect(joinedTablesOf('o1', tableJoins, tables).map(t => t.id)).toEqual(['t3'])
    expect(joinedTablesOf('o2', tableJoins, tables)).toEqual([])
  })
})

describe('tableMoveChoice', () => {
  const ctx = mode => ({ mode, tableOrders, tableJoins, currentTableId: 't1', currentOrderId: 'o1', nameOf })
  test("the bill's own table and its joined ones take nothing", () => {
    expect(tableMoveChoice(T('t1'), ctx('move')).action).toBeNull()
    expect(tableMoveChoice(T('t3'), ctx('join'))).toMatchObject({ action: null, label: 'On this bill' })
  })
  test('a free table moves in Move mode and becomes extra seats in Join mode', () => {
    expect(tableMoveChoice(T('t9'), ctx('move'))).toMatchObject({ action: 'move', hasBill: false })
    expect(tableMoveChoice(T('t9'), ctx('join'))).toMatchObject({ action: 'join', hasBill: false })
  })
  test('a table with a bill offers the join in both modes, never a second bill on it', () => {
    expect(tableMoveChoice(T('t2'), ctx('move'))).toMatchObject({ action: 'join', hasBill: true })
    expect(tableMoveChoice(T('t2'), ctx('join'))).toMatchObject({ action: 'join', hasBill: true })
  })
  test('out of service, not uploaded, or on another bill: no action, with the reason', () => {
    expect(tableMoveChoice(T('t4', { status: 'inactive' }), ctx('move'))).toMatchObject({ action: null, label: 'Out of service' })
    expect(tableMoveChoice(T('t5'), ctx('join'))).toMatchObject({ action: null, label: 'Not uploaded yet' })
    const other = { ...ctx('move'), currentTableId: 't2', currentOrderId: 'o2' }
    expect(tableMoveChoice(T('t3'), other)).toMatchObject({ action: null, label: 'With T1' })
  })
})

describe('dishTargetChoice', () => {
  const ctx = { tableOrders, tableJoins, currentTableId: 't2', currentOrderId: 'o2', nameOf }
  test('a joined table takes dishes onto the bill it is on, and says whose', () => {
    expect(dishTargetChoice(T('t3'), ctx)).toMatchObject({ ok: true, hasBill: true, label: "On T1's bill" })
  })
  test('this bill, out of service and not uploaded are refused; free and busy are offered', () => {
    expect(dishTargetChoice(T('t2'), ctx).ok).toBe(false)
    expect(dishTargetChoice(T('t4', { status: 'inactive' }), ctx).ok).toBe(false)
    expect(dishTargetChoice(T('t5'), ctx).ok).toBe(false)
    expect(dishTargetChoice(T('t1'), ctx)).toMatchObject({ ok: true, hasBill: true })
    expect(dishTargetChoice(T('t9'), ctx)).toMatchObject({ ok: true, hasBill: false })
  })
})

describe('picks', () => {
  const lines = [{ id: 'a', qty: 3 }, { id: 'b', qty: 1 }, { id: 'c', qty: 2, comped: true }]
  test('counts become picks, capped at the line, comped and zero left out', () => {
    expect(picksFromCounts(lines, { a: 5, b: 0, c: 2 })).toEqual([{ item_id: 'a', qty: 3 }])
    expect(picksFromCounts(lines, { a: 1.7, b: '1' })).toEqual([{ item_id: 'a', qty: 1 }, { item_id: 'b', qty: 1 }])
  })
  test('every dish picked is "everything"; a comped leftover is no dish', () => {
    expect(picksTakeEverything(lines, [{ item_id: 'a', qty: 3 }, { item_id: 'b', qty: 1 }])).toBe(true)
    expect(picksTakeEverything(lines, [{ item_id: 'a', qty: 2 }, { item_id: 'b', qty: 1 }])).toBe(false)
  })
})

describe('the move slip', () => {
  const tickets = [
    { station: 'KOT', status: 'new', items: [{ recipe_id: 'r1', name: 'Momo', qty: 2 }, { recipe_id: 'r2', name: 'Chowmein', qty: 1, selection_key: 'x+y', options: [{ option_name: 'Egg' }] }] },
    { station: 'KOT', status: 'ready', items: [{ recipe_id: 'r1', name: 'Momo', qty: 1 }] },
    { station: 'KOT', status: 'served', items: [{ recipe_id: 'r3', name: 'Soup', qty: 1 }] },
    { station: 'BOT', status: 'in_progress', items: [{ recipe_id: 'r4', name: 'Lassi', qty: 2 }, { recipe_id: 'r4', name: 'Lassi', qty: 0, change: true }] },
    { station: 'KOT', status: 'cancelled', items: [{ recipe_id: 'r1', name: 'Momo', qty: 5 }] },
  ]
  test('a whole move lists what each station still has to make, served and cancelled left out', () => {
    const s = moveSlipItems(tickets)
    expect(s.KOT).toEqual([
      expect.objectContaining({ name: 'Momo', qty: 3 }),
      expect.objectContaining({ name: 'Chowmein', qty: 1, selection_key: 'x+y' }),
    ])
    expect(s.BOT).toEqual([expect.objectContaining({ name: 'Lassi', qty: 2 })])
  })
  test('a dish move lists only the moved dishes, capped at the sent units that moved', () => {
    const only = movedSentByKey([{ recipe_id: 'r1', name: 'Momo', qty: 2, sent_qty: 2 }, { recipe_id: 'r4', name: 'Lassi', qty: 1, sent_qty: 0 }])
    expect(moveSlipItems(tickets, only)).toEqual({ KOT: [expect.objectContaining({ name: 'Momo', qty: 2 })] })
  })
  test('nothing live is no slip', () => {
    expect(moveSlipItems([{ station: 'KOT', status: 'served', items: [{ name: 'X', qty: 1 }] }])).toEqual({})
  })
  test('a line keys by recipe and choices, else by name', () => {
    expect(moveLineKey({ recipe_id: 'r', selection_key: 'a+b' })).toBe('r#a+b')
    expect(moveLineKey({ recipe_id: 'r', selection_key: '' })).toBe('r')
    expect(moveLineKey({ name: 'Open item' })).toBe('name:Open item')
  })
  test('the kitchen notice is change lines saying where the food came from', () => {
    expect(moveNoticeItems([{ recipe_id: 'r1', name: 'Momo', qty: 2, selection_key: '' }], 'T3')).toEqual([
      { recipe_id: 'r1', name: 'Momo', notes: 'Moved from T3 (×2)', qty: 0, change: true },
    ])
  })
})

test('a part bill is named after its table', () => {
  expect(partBillLabel('T3', 41)).toBe('T3 · part bill #41')
  expect(partBillLabel(null, null)).toBe('Table · part bill')
})
