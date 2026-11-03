// The allergen vocabulary: the UK/EU 14, the ONE definition (S870).
//
// Allergens used to be free text, and the guest menu filter matches exact strings, so a guest who
// excluded "milk" still saw a dish its ingredient called "dairy". Every allergen an ingredient
// (items.nutrition.allergens) or a choice (pos_options.allergens) carries is now one of these keys.
//
// The database holds the same mapping: allergen_keys() in migration
// 20261103120000_allergen_tick_list_s870, which normalises every write by trigger, so an old
// cached bundle, a branch push or a restore that still writes "dairy" stores "milk". SYNONYMS
// below and that migration's VALUES list must stay equal; allergens.test.js reads the migration
// and fails when they drift.
//
// A word that maps to nothing is never dropped: it stays beside the keys as typed (lowercased),
// and an ingredient carrying one counts as not checked until someone ticks the right box.

export const ALLERGENS = [
  { key: 'gluten',      label: 'Gluten',      hint: 'Wheat (maida, atta, suji), barley, rye, oats' },
  { key: 'milk',        label: 'Milk',        hint: 'Dairy: ghee, paneer, butter, cream, curd, khuwa' },
  { key: 'eggs',        label: 'Eggs',        hint: 'Including mayonnaise' },
  { key: 'peanuts',     label: 'Peanuts',     hint: 'Groundnuts, peanut butter' },
  { key: 'tree nuts',   label: 'Tree nuts',   hint: 'Cashew, almond, walnut, pistachio' },
  { key: 'soy',         label: 'Soy',         hint: 'Soybean (bhatmas), soy sauce, tofu' },
  { key: 'sesame',      label: 'Sesame',      hint: 'Til seeds and oil' },
  { key: 'fish',        label: 'Fish',        hint: 'Including fish sauce' },
  { key: 'crustaceans', label: 'Crustaceans', hint: 'Prawn, shrimp, crab, lobster' },
  { key: 'molluscs',    label: 'Molluscs',    hint: 'Squid, mussels, clams, oysters' },
  { key: 'mustard',     label: 'Mustard',     hint: 'Seeds, paste, powder and mustard oil' },
  { key: 'celery',      label: 'Celery',      hint: 'Stalks, leaves, seeds, celery salt' },
  { key: 'sulphites',   label: 'Sulphites',   hint: 'Wine, dried fruit, some vinegars' },
  { key: 'lupin',       label: 'Lupin',       hint: 'Lupin flour and seeds' },
]

export const ALLERGEN_KEYS = ALLERGENS.map(a => a.key)

// Words that mean a key. Each key also matches itself. "shellfish" names both crustaceans and
// molluscs, and over-declaring is the safe side.
export const SYNONYMS = {
  gluten: ['wheat', 'maida', 'atta', 'barley', 'rye', 'oat', 'oats', 'spelt', 'cereals containing gluten'],
  milk: ['dairy', 'lactose', 'ghee', 'paneer', 'butter', 'cheese', 'cream', 'curd', 'yogurt', 'yoghurt', 'whey', 'casein', 'khuwa'],
  eggs: ['egg'],
  peanuts: ['peanut', 'groundnut', 'groundnuts'],
  'tree nuts': ['tree nut', 'nut', 'nuts', 'almond', 'almonds', 'cashew', 'cashews', 'walnut', 'walnuts', 'pistachio', 'pistachios', 'hazelnut', 'hazelnuts', 'pecan', 'pecans', 'macadamia'],
  soy: ['soya', 'soybean', 'soybeans', 'soy bean', 'soy beans', 'soya bean', 'soya beans'],
  sesame: ['sesame seed', 'sesame seeds', 'til'],
  fish: [],
  crustaceans: ['crustacean', 'shellfish', 'prawn', 'prawns', 'shrimp', 'shrimps', 'crab', 'lobster'],
  molluscs: ['mollusc', 'mollusk', 'mollusks', 'shellfish', 'squid', 'mussel', 'mussels', 'clam', 'clams', 'oyster', 'oysters', 'octopus'],
  mustard: ['mustard seed', 'mustard seeds', 'mustard oil'],
  celery: ['celeriac'],
  sulphites: ['sulphite', 'sulfite', 'sulfites', 'sulphur dioxide', 'sulfur dioxide', 'sulphur dioxide and sulphites'],
  lupin: ['lupine', 'lupins'],
}

// word -> [keys], built once. Every key maps to itself.
export const WORD_TO_KEYS = (() => {
  const map = {}
  const add = (word, key) => { (map[word] = map[word] || []).includes(key) || map[word].push(key) }
  ALLERGEN_KEYS.forEach(key => {
    add(key, key)
    ;(SYNONYMS[key] || []).forEach(word => add(word, key))
  })
  return map
})()

const LABEL = Object.fromEntries(ALLERGENS.map(a => [a.key, a.label]))

// One typed word in its matching shape: lowercase and trimmed, an Open Food Facts "en:" prefix
// dropped, dashes and underscores as spaces, single spaces. allergen_keys() in SQL does exactly this.
function cleanWord(w) {
  return String(w).toLowerCase().trim().replace(/^[a-z]{2}:/, '').replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Free text ("Dairy; wheat, kodo"), an array, or a stored canonical string, to
 * { keys: ['gluten','milk'] in list order, other: ['kodo'] }.
 */
export function normaliseAllergens(raw) {
  const words = Array.isArray(raw)
    ? raw.flatMap(x => String(x ?? '').split(/[,;/]/))
    : String(raw ?? '').split(/[,;/]/)
  const keys = new Set()
  const other = []
  words.map(cleanWord).filter(Boolean).forEach(w => {
    const hit = WORD_TO_KEYS[w]
    if (hit) hit.forEach(k => keys.add(k))
    else if (!other.includes(w)) other.push(w)
  })
  return { keys: ALLERGEN_KEYS.filter(k => keys.has(k)), other }
}

/** The stored shape: keys in list order, then unmatched words. "gluten, milk, kodo". */
export function allergensToText({ keys = [], other = [] }) {
  return [...ALLERGEN_KEYS.filter(k => keys.includes(k)), ...other].join(', ')
}

/** A key's label, or an unmatched word as typed. */
export function allergenLabel(word) {
  return LABEL[word] || word
}

/** Keys first in list order, unmatched words after, for display. */
export function sortAllergens(list) {
  const known = ALLERGEN_KEYS.filter(k => list.includes(k))
  const rest = list.filter(w => !LABEL[w])
  return [...known, ...rest]
}
