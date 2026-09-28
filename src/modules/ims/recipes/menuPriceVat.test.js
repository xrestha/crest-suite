import {
  vatModeOf, guestVatRate, guestPriceOf, storedFromMenuPrice, panPriceMismatches, repricingOf,
} from './menuPriceVat'

// S792 RECIPES-2 / D31. On a PAN-bill outlet the till charges `selling_price` exactly (no VAT is
// added, whatever the dish's vat_rate says), so the price the owner types must be stored whole.
// Before this every pricing screen divided it by 1.13: typed NPR 500, till billed NPR 442.

const ctx = (over = {}) => ({
  settings: { is_vat_registered: true }, loading: false, settingsLoadError: null, settingsClientId: 'c1', ...over,
})

describe('vatModeOf — only an explicit false is a PAN-bill outlet', () => {
  test('registered → vat, false → pan', () => {
    expect(vatModeOf(ctx(), 'c1')).toBe('vat')
    expect(vatModeOf(ctx({ settings: { is_vat_registered: false } }), 'c1')).toBe('pan')
  })

  test('NULL, missing, and no settings row all bill WITH VAT, as the till reads them (`?? true`)', () => {
    expect(vatModeOf(ctx({ settings: { is_vat_registered: null } }), 'c1')).toBe('vat')
    expect(vatModeOf(ctx({ settings: {} }), 'c1')).toBe('vat')
    expect(vatModeOf(ctx({ settings: undefined }), 'c1')).toBe('vat')
  })

  test('unknown while loading, after a failed read, for another client, or with no client', () => {
    expect(vatModeOf(ctx({ loading: true, settings: { is_vat_registered: false } }), 'c1')).toBeNull()
    expect(vatModeOf(ctx({ settingsLoadError: { message: 'x' } }), 'c1')).toBeNull()
    expect(vatModeOf(ctx({ settingsClientId: 'c2' }), 'c1')).toBeNull()
    expect(vatModeOf(ctx({ settingsClientId: undefined }), 'c1')).toBeNull()
    expect(vatModeOf(ctx(), null)).toBeNull()
    expect(vatModeOf(null, 'c1')).toBeNull()
  })
})

describe('what the till charges', () => {
  test('a PAN-bill outlet adds no VAT, whatever the dish carries', () => {
    expect(guestVatRate(0.13, 'pan')).toBe(0)
    expect(guestVatRate(0.13, 'vat')).toBe(0.13)
    expect(guestVatRate(0, 'vat')).toBe(0)
  })

  test('guestPriceOf mirrors the tile: selling_price × (1 + (vatReg ? vat : 0))', () => {
    const momo = { selling_price: '442.4779', vat_rate: 0.13 }
    expect(guestPriceOf(momo, 'vat')).toBeCloseTo(500, 3)
    expect(guestPriceOf(momo, 'pan')).toBeCloseTo(442.4779, 4)
    expect(guestPriceOf({ selling_price: 400, vat_rate: null }, 'vat')).toBeCloseTo(452, 6)   // NULL = 13%
    expect(guestPriceOf({ selling_price: null }, 'vat')).toBeNull()
  })
})

describe('storedFromMenuPrice — the typed price, on the outlet’s basis', () => {
  test('VAT outlet: VAT taken off at the dish’s own rate, to 4 dp', () => {
    expect(storedFromMenuPrice(500, 0.13, 'vat')).toEqual({ selling_price: 442.4779, vat_rate: 0.13 })
    expect(storedFromMenuPrice(500, 0, 'vat')).toEqual({ selling_price: 500, vat_rate: 0 })
    // A missing rate is 13%, never Number(null) = 0.
    expect(storedFromMenuPrice(500, null, 'vat')).toEqual({ selling_price: 442.4779, vat_rate: 0.13 })
  })

  test('PAN-bill outlet (D31): stored whole with vat_rate 0, so the till charges what was typed', () => {
    const s = storedFromMenuPrice(500, 0.13, 'pan')
    expect(s).toEqual({ selling_price: 500, vat_rate: 0 })
    expect(guestPriceOf(s, 'pan')).toBe(500)
    expect(storedFromMenuPrice('349.5', 0.13, 'pan')).toEqual({ selling_price: 349.5, vat_rate: 0 })
  })

  test('nothing is stored with the mode unknown, or without a positive price', () => {
    expect(storedFromMenuPrice(500, 0.13, null)).toBeNull()
    expect(storedFromMenuPrice(0, 0.13, 'pan')).toBeNull()
    expect(storedFromMenuPrice('', 0.13, 'vat')).toBeNull()
    expect(storedFromMenuPrice(-5, 0.13, 'vat')).toBeNull()
  })

  test('a VAT round trip returns the typed price to the paisa', () => {
    const s = storedFromMenuPrice(490, 0.13, 'vat')
    expect(Math.round(guestPriceOf(s, 'vat') * 100) / 100).toBe(490)
  })
})

describe('panPriceMismatches — dishes the till charges less than the menu showed', () => {
  const book = [
    { id: 'a', name: 'Momo', category: 'Food', selling_price: 442.4779, vat_rate: 0.13, is_active: true },
    { id: 'b', name: 'Chiya', category: 'Beverage', selling_price: 60, vat_rate: 0, is_active: true },       // already right
    { id: 'c', name: 'Aloo Paratha', category: 'Food', selling_price: 200, vat_rate: null, is_active: true }, // NULL = 13%
    { id: 'd', name: 'Hidden', category: 'Food', selling_price: 300, vat_rate: 0.13, is_active: false },
    { id: 'e', name: 'Sauce', category: 'Sub-Recipe', selling_price: 50, vat_rate: 0.13 },
    { id: 'f', name: 'Unpriced', category: 'Food', selling_price: null, vat_rate: 0.13 },
  ]

  test('lists priced, active menu dishes with a VAT rate, with both prices rounded like the tile', () => {
    expect(panPriceMismatches(book)).toEqual([
      { id: 'c', name: 'Aloo Paratha', shownPrice: 226, tillPrice: 200 },
      { id: 'a', name: 'Momo', shownPrice: 500, tillPrice: 442 },
    ])
  })

  test('a dish re-entered under D31 (vat 0) leaves the list', () => {
    const fixed = book.map(r => r.id === 'a' ? { ...r, ...storedFromMenuPrice(500, 0.13, 'pan') } : r)
    expect(panPriceMismatches(fixed).map(m => m.id)).toEqual(['c'])
  })

  test('empty input is an empty list', () => {
    expect(panPriceMismatches(null)).toEqual([])
  })
})

describe('repricingOf — the suggestion and the gap it promises', () => {
  const row = { cost: 150, price: 442.4779, targetPct: 30, storedVat: 0.13, qty: 10 }

  test('VAT outlet: suggestion includes VAT; the gap de-VATs the ROUNDED suggestion (S724)', () => {
    const r = repricingOf(row, 'vat')
    expect(r.suggestedMenuPrice).toBe(565)                       // 150 / 0.30 = 500 × 1.13 = 565
    expect(r.priceGap).toBeCloseTo(565 / 1.13 - 442.4779, 6)    // 57.52…
    expect(r.monthlyOpportunity).toBeCloseTo(r.priceGap * 10, 6)
  })

  test('PAN-bill outlet: no VAT in the suggestion, and the gap is against the whole price', () => {
    const r = repricingOf(row, 'pan')
    expect(r.suggestedMenuPrice).toBe(500)
    expect(r.priceGap).toBeCloseTo(500 - 442.4779, 6)
  })

  test('no cost, or the mode unknown, suggests nothing — never NPR 0', () => {
    expect(repricingOf({ ...row, cost: null }, 'vat')).toEqual({ suggestedMenuPrice: null, priceGap: null, monthlyOpportunity: null })
    expect(repricingOf(row, null).suggestedMenuPrice).toBeNull()
  })

  test('a negative period qty is no opportunity', () => {
    expect(repricingOf({ ...row, qty: -3 }, 'vat').monthlyOpportunity).toBe(0)
  })
})
