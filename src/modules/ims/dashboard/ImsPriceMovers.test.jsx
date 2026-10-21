import { moverVerdict, PRICE_MOVE_PCT, PRICE_MOVE_FLOOR_NPR } from './ImsPriceMovers'
import { priceMovers } from './priceMovers'

// The card's reads are not exercised here, only the verdict, so its data layer is stubbed.
jest.mock('../../../supabaseClient', () => ({ supabase: {} }))
jest.mock('../../../shared/hooks/useScopedDb', () => ({ useScopedDb: () => ({ scopedFrom: () => null }) }))
jest.mock('../../../pages/periods/closePeriod', () => ({ previousExistingPeriod: () => null }))

const row = (rateBefore, rateNow, qtyNow) => ({
  rateBefore, rateNow, qtyNow,
  impact: (rateNow - rateBefore) * qtyNow,
  changePct: ((rateNow - rateBefore) / rateBefore) * 100,
})

test('the dead zone is 2% of the old price or NPR 100 this month', () => {
  expect(PRICE_MOVE_PCT).toBe(2)
  expect(PRICE_MOVE_FLOOR_NPR).toBe(100)
})

test('a real rise is a red ▲ and a real fall a green ▼, with the size printed', () => {
  // +6% on 100 kg = NPR 3,000 dearer this month
  expect(moverVerdict(row(500, 530, 100))).toEqual({ glyph: '▲', color: 'var(--theme-red-text)', word: 'dearer', pct: '6.0%' })
  // −5% on 120 kg at 100 = NPR 600 cheaper
  expect(moverVerdict(row(100, 95, 120))).toEqual({ glyph: '▼', color: 'var(--theme-green-text)', word: 'cheaper', pct: '5.0%' })
})

test('a small percentage on a big spend is noise, and so is a big percentage worth little', () => {
  // +1.5% on NPR 50,000 of rice = NPR 750: inside the 2% band
  const small = moverVerdict(row(100, 101.5, 500))
  expect(small.glyph).toBe('≈')
  expect(small.color).toBe('var(--theme-text3)')
  expect(small.pct).toBe('1.5%')
  // +40% on a spice bought once = NPR 20: under the NPR 100 floor
  const cheap = moverVerdict(row(50, 70, 1))
  expect(cheap.glyph).toBe('≈')
  expect(cheap.pct).toBe('40.0%')
})

test('the edge of the band is still inside it', () => {
  // exactly 2% of NPR 10,000 = NPR 200 dearer
  expect(moverVerdict(row(100, 102, 100)).glyph).toBe('≈')
  // exactly NPR 100 on a 10% rise
  expect(moverVerdict(row(10, 11, 100)).glyph).toBe('≈')
  expect(moverVerdict(row(10, 11.1, 100)).glyph).toBe('▲')
})

test('reads the rows priceMovers returns', () => {
  const items = { chk: { name: 'Chicken', uom: 'kg' } }
  const [r] = priceMovers([{ item_id: 'chk', qty: 100, rate: 530 }], [{ item_id: 'chk', qty: 80, rate: 500 }], items)
  expect(moverVerdict(r).glyph).toBe('▲')
})
