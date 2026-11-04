import { searchUsdaFoods, fetchUsdaNutrition } from './usdaNutrition'

// Trimmed from a real FoodData Central answer for "kiwi" (2026-11-04): the SR Legacy juice ranks
// first and carries energy as 1008; the Foundation raw fruit carries none and gives Atwater kcal.
const KIWI = {
  foods: [
    { fdcId: 174111, description: 'Beverages, Kiwi Strawberry Juice Drink', foodNutrients: [
      { nutrientId: 1008, value: 47 }, { nutrientId: 1003, value: 0 }, { nutrientId: 1005, value: 12.3 },
      { nutrientId: 1004, value: 0 }, { nutrientId: 2000, value: 11.6 }, { nutrientId: 1093, value: 11 },
    ] },
    { fdcId: 2710831, description: 'Kiwifruit (kiwi), green, peeled, raw', foodNutrients: [
      { nutrientId: 2047, value: 65.1 }, { nutrientId: 2048, value: 58.5 }, { nutrientId: 1003, value: 1.01 },
      { nutrientId: 1005, value: 13.8 }, { nutrientId: 1004, value: 0.64 }, { nutrientId: 1063, value: 8.56 },
      { nutrientId: 1093, value: 2.28 },
    ] },
    { fdcId: 1, description: 'No energy at all', foodNutrients: [{ nutrientId: 1003, value: 1 }] },
  ],
}

function answer(status, body) {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) })
}

afterEach(() => { delete global.fetch })

describe('searchUsdaFoods (S883)', () => {
  test('lists every food with an energy figure, Foundation foods through Atwater kcal', async () => {
    global.fetch = jest.fn(() => answer(200, KIWI))
    const { foods, error } = await searchUsdaFoods('kiwi')
    expect(error).toBeNull()
    expect(foods.map(f => f.name)).toEqual(['Beverages, Kiwi Strawberry Juice Drink', 'Kiwifruit (kiwi), green, peeled, raw'])
    expect(foods[1]).toMatchObject({
      code: '2710831', source: 'USDA FDC', unit: 'GM',
      energy_kcal: 59, protein_g: 1, carbs_g: 13.8, fat_g: 0.6, sugar_g: 8.6, sodium_mg: 2,
    })
  })

  test('a 429 is the hourly allowance, not a dead connection', async () => {
    global.fetch = jest.fn(() => answer(429, { error: { code: 'OVER_RATE_LIMIT' } }))
    expect(await searchUsdaFoods('kiwi')).toEqual({ foods: [], error: 'rate_limit' })
  })

  test('another refusal and no answer are told apart', async () => {
    global.fetch = jest.fn(() => answer(500, {}))
    expect((await searchUsdaFoods('kiwi')).error).toBe('refused')
    global.fetch = jest.fn(() => Promise.reject(new TypeError('Failed to fetch')))
    expect((await searchUsdaFoods('kiwi')).error).toBe('unreachable')
  })
})

describe('fetchUsdaNutrition reads Atwater energy too', () => {
  test('a Foundation first hit is no longer dropped for lacking 1008', async () => {
    global.fetch = jest.fn(() => answer(200, { foods: [KIWI.foods[1]] }))
    const out = await fetchUsdaNutrition('kiwi')
    expect(out).toMatchObject({ basis_qty: 100, basis_unit: 'GM', energy_kcal: 58.5, source: 'USDA FDC' })
  })
})
