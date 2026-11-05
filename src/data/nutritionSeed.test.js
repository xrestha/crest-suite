import TABLES from './foodTables.json'
import {
  NUTRITION_SEED, LIBRARY_SOURCES, REGIONAL_KITCHEN_NAMES, loadLibrary, suggestSeeds, searchLibrary, basisUnitFor,
  seedFigures, seedSourceText,
} from './nutritionSeed'
import { normaliseAllergens } from '../shared/constants/allergens'

const top = (lib, name) => suggestSeeds(lib, name, { strongOnly: true })[0]

describe('the regional tables (foodTables.json, built by scripts/food-tables)', () => {
  test('every row is whole: an id once, a known source, figures that are numbers', () => {
    const ids = new Set()
    TABLES.forEach(r => {
      expect(ids.has(r.id)).toBe(false)
      ids.add(r.id)
      expect(['DFTQC Nepal', 'IFCT 2017']).toContain(r.source)
      expect(r.name && r.group && r.ref).toBeTruthy()
      ;['energy_kcal', 'protein_g', 'carbs_g', 'fat_g'].forEach(k => {
        expect(Number.isFinite(r[k]) && r[k] >= 0).toBe(true)
      })
    })
    expect(TABLES.filter(r => r.source === 'DFTQC Nepal').length).toBeGreaterThan(550)
    expect(TABLES.filter(r => r.source === 'IFCT 2017').length).toBeGreaterThan(530)
  })

  test('allergens are only the 14 keys', () => {
    TABLES.forEach(r => expect(normaliseAllergens(r.allergens).other).toEqual([]))
  })

  // The Nepal book counts energy as 4P + 4C + 9F; a kept row agrees with it, printed or recalculated.
  test('every Nepal row agrees with its own protein, fat and carbohydrate', () => {
    TABLES.filter(r => r.source === 'DFTQC Nepal').forEach(r => {
      const calc = 4 * r.protein_g + 4 * r.carbs_g + 9 * r.fat_g
      expect(Math.abs(calc - r.energy_kcal)).toBeLessThanOrEqual(Math.max(7, 0.035 * r.energy_kcal))
    })
  })

  test('a Nepal row has sugar and sodium only when borrowed, and never more sugar than carbohydrate', () => {
    TABLES.filter(r => r.source === 'DFTQC Nepal').forEach(r => {
      if (r.borrowed) {
        expect(Number.isFinite(r.sugar_g) && Number.isFinite(r.sodium_mg)).toBe(true)
        expect(r.sugar_g).toBeLessThanOrEqual(r.carbs_g)
      } else {
        expect(r.sugar_g).toBeNull()
        expect(r.sodium_mg).toBeNull()
      }
    })
    TABLES.filter(r => r.source === 'IFCT 2017').forEach(r => {
      expect(Number.isFinite(r.sugar_g) && Number.isFinite(r.sodium_mg)).toBe(true)
    })
  })

  test('foods that read as allergens by name but are not', () => {
    const byName = n => TABLES.find(r => r.name === n)
    expect(byName('Milk fish').allergens).toBe('fish')
    expect(byName('Eggs, Cat fish').allergens).toBe('fish')
    expect(byName('Oyster').allergens).toBe('molluscs')
    expect(byName('Sel roti').allergens).toBe('')
    expect(byName('Rice vermicelli (Thai)').allergens).toBe('')
    expect(byName('Cashew fruit').allergens).toBe('')
    expect(byName('Wai Wai').allergens).toBe('gluten')
    expect(byName('Rahu').allergens).toBe('fish')
  })
})

// S887: every hand-typed USDA row was checked against FoodData Central. A food FDC does not have
// was replaced by the same food in the Nepal or Indian table, or removed where neither has it
// (owner decision 2026-11-05).
describe('the USDA list after the S887 check', () => {
  const REPLACED = ['Beaten rice (chiura)', 'Paneer / cheese (soft)', 'Khuwa / mawa', 'Jaggery (gud/sakhar)',
    'Fish (freshwater, raw)']
  const REMOVED = ['Garam masala / mixed spice', 'Tea leaves (dry)']
  const usda = NUTRITION_SEED.filter(r => r.source === 'USDA')

  test('no USDA row is a food that went to a regional table or was removed', () => {
    const names = new Set(usda.map(r => r.name))
    ;[...REPLACED, ...REMOVED].forEach(n => expect(names.has(n)).toBe(false))
    // Nor under another name: their kitchen words are on no USDA row.
    const words = new Set(usda.flatMap(r => r.match))
    ;['chiura', 'poha', 'beaten rice', 'paneer', 'chenna', 'khuwa', 'mawa', 'khoa', 'jaggery', 'gud', 'sakhar',
      'chaku', 'fish', 'machha', 'rohu', 'garam', 'masala', 'mixed spice', 'tea', 'chiya', 'chai patti']
      .forEach(w => expect(words.has(w)).toBe(false))
  })

  test('every USDA figure is a number or left out, never text', () => {
    usda.forEach(r => ['energy_kcal', 'protein_g', 'carbs_g', 'fat_g', 'sugar_g', 'sodium_mg'].forEach(k => {
      if (r[k] != null) expect(Number.isFinite(r[k]) && r[k] >= 0).toBe(true)
    }))
  })

  test('a kitchen name points at a table row that exists, and adds no row', () => {
    Object.keys(REGIONAL_KITCHEN_NAMES).forEach(id => expect(TABLES.some(r => r.id === id)).toBe(true))
  })
})

describe('matching', () => {
  let lib
  beforeAll(async () => { lib = await loadLibrary() })

  test('the library is the USDA rows plus both tables', () => {
    expect(lib.rows).toHaveLength(NUTRITION_SEED.length + TABLES.length)
    expect(new Set(lib.rows.map(r => r.source))).toEqual(new Set(LIBRARY_SOURCES))
  })

  test.each([
    ['RICE', 'Rice, raw (milled)'], ['CHAMAL', 'Rice, raw (milled)'], ['RARA NOODLES', 'Rara'],
    ['KUKHURA KO MASU', 'Chicken (broiler, raw)'], ['MUTTON', 'Goat meat (khasi) (lean)'],
    ['BUFF', 'Buffalo meat (buff) (lean)'], ['ROTI', 'Roti, whole wheat'], ['BHINDI', 'Ladies finger (okra) (bhindi)'],
    ['RAYO SAAG', 'Mustard leaves'], ['MUSTARD OIL', 'Mustard oil'], ['SOYA CHUNKS', 'Nutrela (soya chunks)'],
    ['CHICKEN MOMO', 'Chicken momo'], ['TOMATO', 'Tomato'], ['GINGER', 'Ginger'],
  ])('%s fills from %s', (item, food) => {
    expect(top(lib, item)?.name).toBe(food)
  })

  // A food sharing only a word with the item is offered in the picker, never filled on a guess.
  test.each(['OAT MILK', 'MOMO WRAPPER', 'PRICE TAG', 'TISSUE PAPER', 'GAS CYLINDER', 'FISH SAUCE'])('%s is never filled', item => {
    expect(top(lib, item)).toBeUndefined()
  })

  test('each food is one row: a table food appears once, kitchen names or not', () => {
    const ids = lib.rows.filter(r => r.id).map(r => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toHaveLength(TABLES.length)
  })

  // S887: a food FDC does not have fills from the same food in a regional table, labelled with it.
  test.each([
    ['CHIURA', 'NP-A26'], ['BEATEN RICE', 'NP-A26'], ['POHA', 'NP-A26'], ['PANEER', 'NP-M7'],
    ['KHUWA', 'IN-L004'], ['MAWA', 'IN-L004'], ['JAGGERY', 'NP-O17'], ['GUD', 'NP-O17'], ['SAKHAR', 'NP-O17'],
    ['FISH', 'IN-S006'], ['MACHHA', 'IN-S006'], ['ROHU', 'NP-L10'],
  ])('%s fills from the table row %s', (item, id) => {
    const row = top(lib, item)
    expect(row?.id).toBe(id)
    expect(seedSourceText(row)).toMatch(/^(DFTQC Nepal|IFCT 2017): /)
  })

  test('a kitchen name wins only a tie: white jaggery and chaku keep their own rows', () => {
    expect(top(lib, 'WHITE JAGGERY')?.id).toBe('NP-O13')
    expect(top(lib, 'CHAKU')?.id).toBe('NP-O14')
    expect(top(lib, 'TUNA FISH')?.name).toBe('Tuna')
  })

  test('neither FDC nor the regional tables have garam masala or dry tea, so nothing fills them', () => {
    expect(top(lib, 'GARAM MASALA')).toBeUndefined()
    expect(top(lib, 'TEA')).toBeUndefined()
    expect(top(lib, 'CHIYA')).toBeUndefined()
  })

  test('plain and instant noodles are two rows, and plain noodles carry no egg', () => {
    expect(top(lib, 'CHOWMEIN NOODLES')).toMatchObject({ name: 'Noodles (dry)', source: 'USDA', allergens: 'gluten' })
    expect(top(lib, 'INSTANT NOODLES')).toMatchObject({ name: 'Instant noodles (dry)', source: 'USDA' })
    expect(top(lib, 'WAI WAI')?.name).toBe('Wai Wai')
  })

  test('cheddar is cheddar, never processed cheese', () => {
    expect(top(lib, 'CHEDDAR')?.name).toBe('Cheese (cheddar)')
    expect(top(lib, 'PROCESSED CHEESE')?.name).toBe('Cheese (processed)')
  })

  test('a typed search finds kitchen names and word starts within one source', () => {
    expect(searchLibrary(lib, 'kukhura', 'IFCT 2017')[0].name).toMatch(/^Chicken, poultry/)
    expect(searchLibrary(lib, 'chick', 'DFTQC Nepal').map(r => r.name)).toContain('Chicken momo')
    expect(searchLibrary(lib, 'eggplant', 'DFTQC Nepal')[0].name).toBe('Brinjal (bhanta)')
    expect(searchLibrary(lib, 'sisnu', 'IFCT 2017')).toEqual([])
    searchLibrary(lib, 'rice', 'USDA').forEach(r => expect(r.source).toBe('USDA'))
  })
})

describe('applying a pick', () => {
  const nepal = TABLES.find(r => r.id === 'NP-M1')
  const momo = TABLES.find(r => r.id === 'NP-P13')

  test('the basis follows the ingredient: ml for a litre item, g for a weighed one, the food for a piece', () => {
    expect(basisUnitFor('LTR', nepal)).toBe('ML')
    expect(basisUnitFor('KG', nepal)).toBe('GM')
    expect(basisUnitFor('PCS', nepal)).toBe('GM')
    expect(basisUnitFor('PCS', { unit: 'ML' })).toBe('ML')
  })

  test('a figure the table does not have stays null, never 0', () => {
    expect(seedFigures(momo).sugar_g).toBeNull()
    expect(seedFigures(momo).sodium_mg).toBeNull()
    expect(seedFigures(momo).energy_kcal).toBe(momo.energy_kcal)
  })

  test('the saved source names the table, the food, its page and any borrowed figures', () => {
    expect(seedSourceText(nepal)).toBe('DFTQC Nepal: Buffalo milk (page 41); sugar and sodium from IFCT 2017: Milk, whole, Buffalo')
    expect(seedSourceText(momo)).toBe('DFTQC Nepal: Buff momo (page 45)')
    expect(seedSourceText(NUTRITION_SEED[0])).toBe('USDA')
  })
})
