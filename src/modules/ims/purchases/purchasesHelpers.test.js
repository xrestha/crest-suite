import { lineState } from './purchasesHelpers'

// What a bill line IS before it is saved (S698). The old filter — item && qty > 0 && rate > 0 —
// dropped a row with an item and a quantity but no price from the save with nothing on screen to
// say so, and made free goods (buy 10 get 1 free) unrecordable. Three states, each with a
// different consequence: blank is ignored, incomplete is refused BY NAME, complete saves — and a
// complete line with rate 0 or blank is a free line.

const line = over => ({ item_id: '', qty: '', rate: '', expiry_date: '', shelf_life: '', vat_inclusive: false, _amtDraft: '', ...over })

describe('lineState', () => {
  test('the default empty row is blank, not incomplete', () => {
    expect(lineState(line())).toBe('blank')
  })

  test('item + qty + rate is complete', () => {
    expect(lineState(line({ item_id: 'i1', qty: '10', rate: '25' }))).toBe('complete')
    expect(lineState(line({ item_id: 'i1', qty: 10, rate: 25 }))).toBe('complete')   // QtyInput commits numbers
  })

  test('a free line — item + qty, rate blank or 0 — is complete', () => {
    expect(lineState(line({ item_id: 'i1', qty: '1', rate: '' }))).toBe('complete')
    expect(lineState(line({ item_id: 'i1', qty: '1', rate: '0' }))).toBe('complete')
    expect(lineState(line({ item_id: 'i1', qty: 1, rate: 0 }))).toBe('complete')
  })

  test('an item with no quantity is incomplete, never silently dropped', () => {
    expect(lineState(line({ item_id: 'i1' }))).toBe('incomplete')
    expect(lineState(line({ item_id: 'i1', qty: '0', rate: '25' }))).toBe('incomplete')
    expect(lineState(line({ item_id: 'i1', qty: 0 }))).toBe('incomplete')
  })

  test('a quantity or rate with no item is incomplete', () => {
    expect(lineState(line({ qty: '5' }))).toBe('incomplete')
    expect(lineState(line({ rate: '25' }))).toBe('incomplete')
    expect(lineState(line({ rate: 25 }))).toBe('incomplete')
  })

  test('a negative rate is incomplete', () => {
    expect(lineState(line({ item_id: 'i1', qty: '1', rate: '-5' }))).toBe('incomplete')
  })

  test('an expiry or shelf life alone marks the row touched, so it is refused rather than ignored', () => {
    expect(lineState(line({ expiry_date: '2026-10-01' }))).toBe('incomplete')
    expect(lineState(line({ shelf_life: '30' }))).toBe('incomplete')
  })
})
