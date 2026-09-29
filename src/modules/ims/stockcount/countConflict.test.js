import { addCounts, allChosen, closingRpcRows, conflictSentence, countedByLine, CountConflictError, fmtQty } from './countConflict'

describe('countConflict (D37)', () => {
  test('closingRpcRows stamps the counter and the mode on every row', () => {
    const by = { counted_by: 'u1', counted_by_name: 'Ram' }
    expect(closingRpcRows([{ itemId: 'i1', qty: 12 }, { itemId: 'i2', qty: 0, mode: 'add' }], by, 'check')).toEqual([
      { item_id: 'i1', qty: 12, mode: 'check', counted_by: 'u1', counted_by_name: 'Ram' },
      { item_id: 'i2', qty: 0, mode: 'add', counted_by: 'u1', counted_by_name: 'Ram' },
    ])
  })

  test('addCounts rounds away float dust but keeps grams', () => {
    expect(addCounts(0.1, 0.2)).toBe(0.3)
    expect(addCounts('12', 8)).toBe(20)
    expect(addCounts(1.2345, 0)).toBe(1.235)
  })

  test('countedByLine names every contributor to an added total', () => {
    expect(countedByLine({ counted_by_name: 'Sita', count_parts: [{ name: 'Ram', qty: 12 }, { name: 'Sita', qty: 8 }] })).toBe('Ram 12 + Sita 8')
    expect(countedByLine({ counted_by_name: 'Ram', count_parts: null })).toBe('Ram')
    expect(countedByLine({ counted_by_name: null })).toBeNull()
  })

  test('conflictSentence says who counted what, and when', () => {
    expect(conflictSentence({ physical_qty: 12, counted_by_name: 'Ram' }, 'kg', '10:42 AM')).toBe('Ram already counted 12 kg at 10:42 AM.')
    expect(conflictSentence({ physical_qty: 20, counted_by_name: 'Sita', count_parts: [{ name: 'Ram', qty: 12 }, { name: 'Sita', qty: 8 }] }, 'kg', null))
      .toBe('This item already holds 20 kg (Ram 12 + Sita 8).')
  })

  test('a count of 0 is a count, and prints as 0', () => {
    expect(fmtQty(0)).toBe('0')
    expect(fmtQty('2.50')).toBe('2.5')
  })

  test('the multi-item dialog saves only once every row has an answer', () => {
    expect(allChosen([])).toBe(false)
    expect(allChosen([{ choice: 'add' }, { choice: null }])).toBe(false)
    expect(allChosen([{ choice: 'add' }, { choice: 'replace' }, { choice: 'keep' }])).toBe(true)
  })

  test('CountConflictError carries the conflicts', () => {
    const err = new CountConflictError([{ item_id: 'i1' }])
    expect(err).toBeInstanceOf(Error)
    expect(err.conflicts).toEqual([{ item_id: 'i1' }])
  })
})

test('rpcMissing falls back only for a function the schema does not have yet', () => {
  const { rpcMissing } = require('./countConflict')
  expect(rpcMissing({ code: 'PGRST202' })).toBe(true)
  expect(rpcMissing({ code: '42883' })).toBe(true)
  expect(rpcMissing({ code: '42501', message: 'closing_count_locked: counted by Ram' })).toBe(false)
  expect(rpcMissing(null)).toBe(false)
})
