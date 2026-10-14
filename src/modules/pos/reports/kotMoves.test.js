import {
  KOT_MOVE_KINDS, MOVE_KIND_LABEL, orderItemKey, sumSentQtyByOrderItem, sumCurrentQtyByOrderItem,
  mergeMovesById, netMovedOutSent, expectedHeldByOrderItem, flagOrderDiscrepancies, sentFoodMovedIn,
  movedText, moveDishesText, moveSideText,
} from './kotMoves'

// Two bills at two tables. A sent 3 Momo and 1 Tea on its own tickets; B sent nothing of either.
const A = 'order-a'
const B = 'order-b'
const P = 'order-part'
const MOMO = 'recipe-momo'
const TEA = 'recipe-tea'

const LOGS = [
  { order_id: A, items: [{ recipe_id: MOMO, name: 'Momo', qty: 2 }, { recipe_id: TEA, name: 'Tea', qty: 1 }] },
  { order_id: A, items: [{ recipe_id: MOMO, name: 'Momo', qty: 1 }] },
]
const line = (recipe_id, name, qty, sent_qty) => ({ recipe_id, selection_key: '', name, qty, sent_qty, unit_price: 200 })
const move = (id, kind, from_order_id, to_order_id, lines) => ({ id, kind, from_order_id, to_order_id, lines })

// The whole tab's arithmetic, as KotLog.jsx runs it.
function flags(orders, logs, items, moves) {
  const orderById = Object.fromEntries(orders.map(o => [o.id, o]))
  const held = expectedHeldByOrderItem(sumSentQtyByOrderItem(logs), netMovedOutSent(moves))
  return flagOrderDiscrepancies(orderById, held, sumCurrentQtyByOrderItem(items))
}
const billed = id => ({ id, status: 'billed', close_type: 'paid' })

describe('a dish moved to another table', () => {
  const moves = [move('m1', 'move_dishes', A, B, [line(MOMO, 'Momo', 2, 2)])]
  const items = [
    { order_id: A, recipe_id: MOMO, name: 'Momo', qty: 1 },
    { order_id: A, recipe_id: TEA, name: 'Tea', qty: 1 },
    { order_id: B, recipe_id: MOMO, name: 'Momo', qty: 2 },
  ]

  test('without the record, the old bill reads as food removed after sending (the bug)', () => {
    const rows = flags([billed(A), billed(B)], LOGS, items, [])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ key: orderItemKey(A, MOMO), sentQty: 3, currentQty: 1, discrepancy: 2, reason: 'Reduced/removed after sending' })
  })

  test('with it, neither bill is flagged', () => {
    expect(flags([billed(A), billed(B)], LOGS, items, moves)).toEqual([])
  })

  test('net moved out is +2 on the bill it left and −2 on the bill it reached', () => {
    const out = netMovedOutSent(moves)
    expect(out[orderItemKey(A, MOMO)].qty).toBe(2)
    expect(out[orderItemKey(B, MOMO)].qty).toBe(-2)
    expect(out[orderItemKey(A, TEA)]).toBeUndefined()
  })

  test('the receiving bill is held to the food it received, though it sent none itself', () => {
    const reduced = items.map(i => (i.order_id === B ? { ...i, qty: 1 } : i))
    const rows = flags([billed(A), billed(B)], LOGS, reduced, moves)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ key: orderItemKey(B, MOMO), name: 'Momo', sentQty: 0, movedOut: -2, currentQty: 1, discrepancy: 1 })
  })

  test('only the SENT part of a moved line counts', () => {
    const partSent = [move('m2', 'move_dishes', A, B, [line(MOMO, 'Momo', 3, 1)])]
    expect(netMovedOutSent(partSent)[orderItemKey(A, MOMO)].qty).toBe(1)
    const unsent = [move('m3', 'move_dishes', A, B, [line(MOMO, 'Momo', 2, 0)])]
    expect(netMovedOutSent(unsent)).toEqual({})
  })
})

describe('a part bill split off and then put back', () => {
  const items = [
    { order_id: A, recipe_id: MOMO, name: 'Momo', qty: 3 },
    { order_id: A, recipe_id: TEA, name: 'Tea', qty: 1 },
  ]

  test('nets to zero on the table\'s bill while the part bill still exists', () => {
    const moves = [
      move('m1', 'part_bill', A, P, [line(MOMO, 'Momo', 2, 2)]),
      move('m2', 'part_back', P, A, [line(MOMO, 'Momo', 2, 2)]),
    ]
    expect(netMovedOutSent(moves)).toEqual({})
    expect(flags([billed(A)], LOGS, items, moves)).toEqual([])
  })

  test('nets to zero once the put-back part bill is deleted and the record\'s links to it are null', () => {
    const moves = [
      move('m1', 'part_bill', A, null, [line(MOMO, 'Momo', 2, 2)]),
      move('m2', 'part_back', null, A, [line(MOMO, 'Momo', 2, 2)]),
    ]
    expect(netMovedOutSent(moves)).toEqual({})
    expect(flags([billed(A)], LOGS, items, moves)).toEqual([])
  })

  test('a part bill paid on its own: the table\'s bill holds less, the part bill holds the rest', () => {
    const moves = [move('m1', 'part_bill', A, P, [line(MOMO, 'Momo', 2, 2)])]
    const split = [
      { order_id: A, recipe_id: MOMO, name: 'Momo', qty: 1 },
      { order_id: A, recipe_id: TEA, name: 'Tea', qty: 1 },
      { order_id: P, recipe_id: MOMO, name: 'Momo', qty: 2 },
    ]
    expect(flags([billed(A), billed(P)], LOGS, split, moves)).toEqual([])
  })
})

test('a join row is ignored: it re-points the tickets with the food', () => {
  const moves = [
    move('j1', 'join', null, A, [line(MOMO, 'Momo', 2, 2)]),
    move('j2', 'join', B, A, [line(MOMO, 'Momo', 2, 2)]),
    move('mv', 'move', A, A, []),
    move('rl', 'release', A, A, []),
  ]
  expect(netMovedOutSent(moves)).toEqual({})
})

test('a line with no recipe lands on the no-recipe bucket, never on a real dish', () => {
  const moves = [move('m1', 'move_dishes', A, B, [line(null, 'Open item', 1, 1), line(MOMO, 'Momo', 1, 1)])]
  const out = netMovedOutSent(moves)
  expect(out[orderItemKey(A, null)]).toMatchObject({ recipeId: null, name: 'Open item', qty: 1 })
  expect(out[orderItemKey(B, null)].qty).toBe(-1)
  expect(out[orderItemKey(A, MOMO)].qty).toBe(1)
  // A missing key and a null key are the same bucket, for tickets, lines and moves alike.
  expect(orderItemKey(A, undefined)).toBe(orderItemKey(A, null))
  const noKey = [move('m2', 'move_dishes', A, B, [{ name: 'Open item', qty: 1, sent_qty: 1 }])]
  expect(netMovedOutSent(noKey)[orderItemKey(A, null)].qty).toBe(1)
})

test('a row whose two sides are the same bill is ignored', () => {
  const moves = [move('m1', 'move_dishes', A, A, [line(MOMO, 'Momo', 2, 2)])]
  expect(netMovedOutSent(moves)).toEqual({})
})

test('a malformed line or list counts nothing (the SQL twin\'s jsonb_typeof checks)', () => {
  const moves = [
    move('m1', 'move_dishes', A, B, null),
    move('m2', 'move_dishes', A, B, { recipe_id: MOMO }),
    move('m3', 'move_dishes', A, B, [line(MOMO, 'Momo', 2, '2'), null, line(MOMO, 'Momo', 2, null)]),
  ]
  expect(netMovedOutSent(moves)).toEqual({})
  expect(netMovedOutSent(null)).toEqual({})
})

test('the two reads are merged by id, so a move between two bills in the range counts once', () => {
  const m = move('m1', 'move_dishes', A, B, [line(MOMO, 'Momo', 2, 2)])
  const merged = mergeMovesById([m], [{ ...m }, move('m2', 'part_bill', A, P, [])], null)
  expect(merged.map(x => x.id)).toEqual(['m1', 'm2'])
  expect(netMovedOutSent(merged)[orderItemKey(A, MOMO)].qty).toBe(2)
})

describe('a voided bill', () => {
  const voided = id => ({ id, status: 'voided', close_type: 'void' })

  test('still flags the food it should have held', () => {
    const items = [{ order_id: A, recipe_id: MOMO, name: 'Momo', qty: 3 }, { order_id: A, recipe_id: TEA, name: 'Tea', qty: 1 }]
    const rows = flags([voided(A)], LOGS, items, [])
    expect(rows.map(r => r.name).sort()).toEqual(['Momo', 'Tea'])
    expect(rows.every(r => r.reason === 'Order voided — food was sent' && r.discrepancy === 0)).toBe(true)
  })

  test('does not answer for sent food that moved to another bill before the void', () => {
    const moves = [move('m1', 'move_dishes', A, B, [line(MOMO, 'Momo', 3, 3)])]
    const items = [{ order_id: A, recipe_id: TEA, name: 'Tea', qty: 1 }, { order_id: B, recipe_id: MOMO, name: 'Momo', qty: 3 }]
    const rows = flags([voided(A), billed(B)], LOGS, items, moves)
    expect(rows.map(r => `${r.order.id}:${r.name}`)).toEqual([`${A}:Tea`])
  })

  test('answers for sent food moved onto it from another bill', () => {
    const moves = [move('m1', 'move_dishes', A, B, [line(MOMO, 'Momo', 2, 2)])]
    const items = [{ order_id: A, recipe_id: MOMO, name: 'Momo', qty: 1 }, { order_id: A, recipe_id: TEA, name: 'Tea', qty: 1 }, { order_id: B, recipe_id: MOMO, name: 'Momo', qty: 2 }]
    const rows = flags([billed(A), voided(B)], LOGS, items, moves)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ key: orderItemKey(B, MOMO), sentQty: 0, movedOut: -2, reason: 'Order voided — food was sent' })
  })
})

test('a bill with no tickets of its own that received sent food is told apart from "No KOT"', () => {
  const moves = [
    move('m1', 'part_bill', A, P, [line(MOMO, 'Momo', 2, 2)]),
    move('m2', 'move_dishes', A, B, [line(TEA, 'Tea', 1, 0)]),   // unsent food only
    move('j1', 'join', null, A, [line(MOMO, 'Momo', 1, 1)]),      // a join is not counted
  ]
  expect(sentFoodMovedIn(moves, P)).toBe(true)
  expect(sentFoodMovedIn(moves, B)).toBe(false)
  expect(sentFoodMovedIn(moves, A)).toBe(false)
  expect(sentFoodMovedIn(moves, null)).toBe(false)
  expect(sentFoodMovedIn(null, P)).toBe(false)
})

test('a partly comped line is two rows of one dish, summed', () => {
  const cur = sumCurrentQtyByOrderItem([
    { order_id: A, recipe_id: MOMO, qty: 2 },
    { order_id: A, recipe_id: MOMO, qty: 1 },
  ])
  expect(cur[orderItemKey(A, MOMO)]).toBe(3)
})

test('the kinds counted are the three that leave the ticket behind', () => {
  expect(KOT_MOVE_KINDS).toEqual(['move_dishes', 'part_bill', 'part_back'])
  expect(Object.keys(MOVE_KIND_LABEL).sort()).toEqual(['join', 'move', 'move_dishes', 'part_back', 'part_bill', 'release'])
})

test('the Moves tab\'s plain words', () => {
  expect(moveDishesText([line(MOMO, 'Momo', 2, 2), line(TEA, 'Tea', 1, 0)])).toBe('Momo ×2, Tea ×1')
  expect(moveDishesText([])).toBe('—')
  expect(moveDishesText(null)).toBe('—')
  expect(moveSideText('T5', 124)).toBe('T5 #124')
  expect(moveSideText('T3', null)).toBe('T3')           // a joined table with no bill of its own
  expect(moveSideText(null, 12)).toBe('Takeaway #12')
  expect(moveSideText(null, null)).toBe('—')
  expect(movedText(2)).toBe('2 out')
  expect(movedText(-1)).toBe('1 in')
  expect(movedText(0)).toBe('—')
})
