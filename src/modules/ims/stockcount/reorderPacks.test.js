// Reorder quantities in packs (S756, D18). Each case is a way the pack line could print a
// believable wrong number rather than an error.
import { packsFor, packText, reorderQtyText, fmtQty } from './reorderPacks'

const rice = { uom: 'GM', purchase_unit: 'SACK', conversion_factor: 25000 }

describe('packsFor', () => {
  test('rounds UP to whole packs — half a sack cannot be bought, and one short is below par', () => {
    expect(packsFor(12500, rice)).toEqual({ packs: 1, unit: 'SACK', packSize: 25000, packedQty: 25000 })
    expect(packsFor(25001, rice).packs).toBe(2)
    expect(packsFor(50000, rice).packs).toBe(2)
  })

  test('float noise from par − on hand does not buy a second pack', () => {
    expect(packsFor(25000.0000000004, rice).packs).toBe(1)
    expect(packsFor(0.1 + 0.2 + 24999.7, rice).packs).toBe(1)
  })

  test('no pack size means base units only: cf ≤ 1, a missing cf, or a cf with no purchase unit', () => {
    expect(packsFor(500, { uom: 'GM', purchase_unit: 'KG', conversion_factor: 1 })).toBeNull()
    expect(packsFor(500, { uom: 'GM', purchase_unit: 'KG', conversion_factor: null })).toBeNull()
    expect(packsFor(500, { uom: 'GM', purchase_unit: null, conversion_factor: 1000 })).toBeNull()
    expect(packsFor(500, { uom: 'GM' })).toBeNull()
    expect(packsFor(500, null)).toBeNull()
  })

  test('nothing to buy is not "0 SACK"', () => {
    expect(packsFor(0, rice)).toBeNull()
    expect(packsFor(-3, rice)).toBeNull()
  })

  test('a conversion factor stored as a string still works', () => {
    expect(packsFor(30, { uom: 'BTL', purchase_unit: 'CTN', conversion_factor: '24' }).packs).toBe(2)
  })
})

describe('text', () => {
  test('both units on one line, with the pack size stated so the reader can check the rounding', () => {
    expect(reorderQtyText(12500, rice)).toBe('12,500 GM (1 SACK of 25,000 GM)')
    expect(reorderQtyText(60000, rice)).toBe('60,000 GM (3 SACK of 25,000 GM each)')
  })

  test('base units only where there is no pack, and decimals are kept on a quantity', () => {
    expect(reorderQtyText(0.45, { uom: 'KG' })).toBe('0.45 KG')
    expect(packText(0.45, { uom: 'KG' })).toBe('')
  })

  test('Nepali digit grouping on a large quantity', () => {
    expect(fmtQty(1250000)).toBe('12,50,000')
  })
})
