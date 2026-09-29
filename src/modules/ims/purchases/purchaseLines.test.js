import { fmtLineRate, linesWithUnlistedItems, unlistedItemsText } from './purchaseLines'

describe('fmtLineRate (S792, PURCHASES-9)', () => {
  test('keeps a sub-paisa per-base-unit rate that a 2-decimal format printed as 0', () => {
    expect(fmtLineRate(0.004)).toBe('0.004')
    expect(fmtLineRate('0.00035')).toBe('0.00035')
  })

  test('prints an ordinary rate to the paisa, with Nepali grouping', () => {
    expect(fmtLineRate(250)).toBe('250.00')
    expect(fmtLineRate(0.5)).toBe('0.50')
    expect(fmtLineRate(0.115)).toBe('0.115')
    expect(fmtLineRate(0.12345)).toBe('0.1235')
    expect(fmtLineRate(1.5)).toBe('1.50')
    expect(fmtLineRate(125000)).toBe('1,25,000.00')
  })

  test('a free line (rate 0) is a real 0.00, not a missing rate', () => {
    expect(fmtLineRate(0)).toBe('0.00')
    expect(fmtLineRate('0')).toBe('0.00')
  })

  test('a rate that is not a number still reads as missing', () => {
    expect(fmtLineRate(null)).toBe('—')
    expect(fmtLineRate('')).toBe('—')
  })
})

describe('linesWithUnlistedItems (S792, PURCHASES-10)', () => {
  const items = [{ id: 'a' }, { id: 'b' }]

  test('lists a line whose item is not in the list, with its row on the form', () => {
    const lines = [{ item_id: 'a' }, { item_id: 'gone' }, { item_id: 'b' }]
    expect(linesWithUnlistedItems(lines, items)).toEqual([{ line: lines[1], row: 2 }])
  })

  test('a line with no item picked is not its business', () => {
    expect(linesWithUnlistedItems([{ item_id: '' }, { item_id: null }], items)).toEqual([])
  })

  test('empty inputs are safe', () => {
    expect(linesWithUnlistedItems(null, null)).toEqual([])
    expect(linesWithUnlistedItems([{ item_id: 'x' }], null)).toEqual([{ line: { item_id: 'x' }, row: 1 }])
  })
})

describe('unlistedItemsText', () => {
  test('names the row and the item, and says nothing was saved', () => {
    const text = unlistedItemsText([{ line: { item_id: 'x' }, row: 3 }], { x: 'Cheese Slice' })
    expect(text).toMatch(/^The bill was not saved\. Row 3 \("Cheese Slice"\) uses an item hidden or removed/)
    expect(text).toMatch(/Remove that row with ×/)
  })

  test('falls back to the row number when the name could not be read, and lists several', () => {
    const text = unlistedItemsText([
      { line: { item_id: 'x' }, row: 2 },
      { line: { item_id: 'y' }, row: 4 },
      { line: { item_id: 'z' }, row: 5 },
    ], { y: 'Paneer' })
    expect(text).toMatch(/Row 2, row 4 \("Paneer"\) and row 5 use items/)
    expect(text).toMatch(/Remove those rows/)
  })
})
