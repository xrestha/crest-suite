import fs from 'fs'
import path from 'path'
import {
  ALLERGENS, ALLERGEN_KEYS, WORD_TO_KEYS, normaliseAllergens, allergensToText, allergenLabel, sortAllergens,
} from './allergens'

// The guest menu filter compares allergens as exact strings, so every word that reaches it has to
// be one of the 14 keys. The database normalises writes with its own copy of the synonym list
// (allergen_keys() in the S870 migration). If the two copies drift, a word the app maps is stored
// as an unmatched word, or the reverse, and nothing errors. This test reads the migration.

const MIGRATION = path.join(__dirname, '..', '..', '..', 'supabase', 'migrations', '20261103120000_allergen_tick_list_s870.sql')

function sqlWordToKeys() {
  const sql = fs.readFileSync(MIGRATION, 'utf8')
  const block = sql.split('-- ALLERGEN SYNONYMS BEGIN')[1].split('-- ALLERGEN SYNONYMS END')[0]
  const map = {}
  const re = /\('([^']+)',\s*'([^']+)'\)/g
  let m
  while ((m = re.exec(block)) !== null) (map[m[1]] = map[m[1]] || []).push(m[2])
  return map
}

describe('allergen list', () => {
  test('the 14 keys are unique and lowercase', () => {
    expect(ALLERGENS).toHaveLength(14)
    expect(new Set(ALLERGEN_KEYS).size).toBe(14)
    ALLERGEN_KEYS.forEach(k => expect(k).toBe(k.toLowerCase()))
  })

  test('the migration maps exactly the same words to the same keys', () => {
    const sql = sqlWordToKeys()
    const sorted = m => Object.fromEntries(Object.keys(m).sort().map(w => [w, [...m[w]].sort()]))
    expect(sorted(sql)).toEqual(sorted(WORD_TO_KEYS))
  })
})

describe('normaliseAllergens', () => {
  test('free text from before S870 maps onto the keys, in list order', () => {
    expect(normaliseAllergens('Dairy; wheat, kodo')).toEqual({ keys: ['gluten', 'milk'], other: ['kodo'] })
    expect(normaliseAllergens('soy, gluten')).toEqual({ keys: ['gluten', 'soy'], other: [] })
    expect(normaliseAllergens('egg / peanut')).toEqual({ keys: ['eggs', 'peanuts'], other: [] })
  })

  test('shellfish declares both crustaceans and molluscs', () => {
    expect(normaliseAllergens('shellfish').keys).toEqual(['crustaceans', 'molluscs'])
  })

  test('Open Food Facts tags lose their language prefix and dashes', () => {
    expect(normaliseAllergens('en:milk, en:sulphur-dioxide-and-sulphites, en:sesame-seeds, en:nuts').keys)
      .toEqual(['milk', 'tree nuts', 'sesame', 'sulphites'])
  })

  test('an unmatched word is kept, lowercased, once', () => {
    expect(normaliseAllergens('Kiwi, kiwi, milk')).toEqual({ keys: ['milk'], other: ['kiwi'] })
  })

  test('arrays, blanks and null are accepted', () => {
    expect(normaliseAllergens(['milk', 'Dairy', '', null])).toEqual({ keys: ['milk'], other: [] })
    expect(normaliseAllergens('')).toEqual({ keys: [], other: [] })
    expect(normaliseAllergens(null)).toEqual({ keys: [], other: [] })
  })

  test('the stored text round-trips', () => {
    const n = normaliseAllergens('kiwi, Dairy, wheat')
    const text = allergensToText(n)
    expect(text).toBe('gluten, milk, kiwi')
    expect(normaliseAllergens(text)).toEqual(n)
  })
})

describe('display helpers', () => {
  test('labels a key and leaves an unmatched word as typed', () => {
    expect(allergenLabel('tree nuts')).toBe('Tree nuts')
    expect(allergenLabel('kiwi')).toBe('kiwi')
  })

  test('sorts keys in list order with unmatched words last', () => {
    expect(sortAllergens(['kiwi', 'milk', 'gluten'])).toEqual(['gluten', 'milk', 'kiwi'])
  })
})
