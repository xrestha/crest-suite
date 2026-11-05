// Crest's guess at an ingredient's allergens from its NAME (S870). A guess only: the Check allergens
// list shows it with the word it came from, and nothing counts as checked until a person confirms.
//
// Why a word list and not the nutrition library: the library matches loosely ("OAT MILK" found
// "Buffalo milk"), which is fine for a calorie estimate and wrong for an allergen. Here every rule
// is a whole word or phrase, longer phrases win and use up their words, so "oat milk" is gluten and
// never milk, "peanut butter" is peanuts and never milk, and "corn flour" is nothing.
//
// Three other answers besides allergens:
//  - checkLabel: a mixed or branded product (a sauce, a spice mix, a sausage) whose allergens only
//    its label knows. Never confirmed in bulk.
//  - notFood: packaging (a cup, a lid). Suggested only when no allergen word matched, so "MILK
//    CARTON" stays milk, and only when no label word comes AFTER the last packaging word (S887):
//    in English the thing a name is comes last, so "DIP CUP" is a cup, while "KOREAN RICE BOWL
//    GRAVY" and "BOWL SAUCE" are a gravy and a sauce, and ask for the label.
//  - nothing matched: shown as "no allergen words found", which a person may confirm as none.
//
// A near miss (S877, owner decision): "ICE CREAN" matched nothing, so it read as "no allergen
// words" and could be confirmed as containing none. A name word of 5 or more letters that matched
// no rule and is ONE edit (a letter changed, added or removed, or two neighbouring letters swapped)
// from an allergen word goes into checkLabel, with what it looked like in nearMiss. It never adds a
// key: a near miss is a reason to read the label, never a match. A word Crest already knows (a
// label word such as "paste" or "batter", a packaging word, a word of any phrase here, or a real
// word listed in REAL_WORDS such as "bitter") is not a misspelling, and a near miss outranks
// packaging the way an allergen word does.

import { ALLERGEN_KEYS } from './allergens'

// [phrase, keys]. An empty keys list is a phrase that USES UP its words and means "none": "coconut
// milk" must not fall through to "milk".
const RULES = [
  // Plant milks, butters and flours that only look like an allergen.
  ['oat milk', ['gluten']], ['almond milk', ['tree nuts']], ['soy milk', ['soy']], ['soya milk', ['soy']],
  ['coconut milk', []], ['coconut cream', []], ['rice milk', []],
  ['peanut butter', ['peanuts']], ['cocoa butter', []], ['butter beans', []], ['shea butter', []],
  ['corn flour', []], ['cornflour', []], ['rice flour', []], ['gram flour', []], ['besan', []],
  ['buckwheat flour', []], ['buckwheat', []], ['coconut flour', []], ['almond flour', ['tree nuts']],
  ['cream of tartar', []], ['nutmeg', []], ['soy sauce', ['soy', 'gluten']], ['soya sauce', ['soy', 'gluten']],
  ['oyster sauce', ['molluscs']], ['fish sauce', ['fish']], ['egg noodles', ['eggs', 'gluten']],
  ['ice cream', ['milk']], ['milk powder', ['milk']], ['condensed milk', ['milk']],
  ['mustard oil', ['mustard']], ['sesame oil', ['sesame']], ['celery salt', ['celery']],
  ['pizza base', ['gluten']], ['bread crumbs', ['gluten']], ['dried apricot', ['sulphites']],
  ['dried apricots', ['sulphites']], ['pine nut', ['tree nuts']], ['pine nuts', ['tree nuts']],
  ['brazil nut', ['tree nuts']], ['brazil nuts', ['tree nuts']], ['wai wai', ['gluten']],
  // Gluten
  ['wheat', ['gluten']], ['maida', ['gluten']], ['atta', ['gluten']], ['aata', ['gluten']], ['flour', ['gluten']],
  ['bread', ['gluten']], ['bun', ['gluten']], ['buns', ['gluten']], ['baguette', ['gluten']], ['croissant', ['gluten']],
  ['croissants', ['gluten']], ['roti', ['gluten']], ['naan', ['gluten']], ['paratha', ['gluten']], ['pasta', ['gluten']],
  ['spaghetti', ['gluten']], ['macaroni', ['gluten']], ['penne', ['gluten']], ['fusilli', ['gluten']],
  ['noodle', ['gluten']], ['noodles', ['gluten']], ['chowmein', ['gluten']], ['semolina', ['gluten']],
  ['suji', ['gluten']], ['sooji', ['gluten']], ['barley', ['gluten']], ['rye', ['gluten']], ['oat', ['gluten']],
  ['oats', ['gluten']], ['oatmeal', ['gluten']], ['granola', ['gluten']], ['muesli', ['gluten']],
  ['biscuit', ['gluten']], ['biscuits', ['gluten']], ['cookie', ['gluten']], ['cookies', ['gluten']],
  ['cake', ['gluten']], ['rusk', ['gluten']], ['cracker', ['gluten']], ['crackers', ['gluten']],
  ['breadcrumbs', ['gluten']], ['panko', ['gluten']], ['couscous', ['gluten']], ['bulgur', ['gluten']],
  ['beer', ['gluten']], ['waffle', ['gluten']], ['pancake', ['gluten']], ['tortilla', ['gluten']],
  ['donut', ['gluten']], ['doughnut', ['gluten']], ['muffin', ['gluten']], ['brownie', ['gluten']],
  ['ramen', ['gluten']], ['tiramisu', ['milk', 'eggs']],
  // Milk
  ['milk', ['milk']], ['dairy', ['milk']], ['paneer', ['milk']], ['cheese', ['milk']], ['cheddar', ['milk']],
  ['mozzarella', ['milk']], ['parmesan', ['milk']], ['cream', ['milk']], ['butter', ['milk']], ['ghee', ['milk']],
  ['curd', ['milk']], ['dahi', ['milk']], ['yogurt', ['milk']], ['yoghurt', ['milk']], ['khuwa', ['milk']],
  ['khoa', ['milk']], ['mawa', ['milk']], ['whey', ['milk']], ['casein', ['milk']], ['lactose', ['milk']],
  ['buttermilk', ['milk']], ['chhurpi', ['milk']], ['custard', ['milk', 'eggs']], ['pesto', ['milk', 'tree nuts']],
  // Eggs
  ['egg', ['eggs']], ['eggs', ['eggs']], ['anda', ['eggs']], ['mayonnaise', ['eggs']], ['mayo', ['eggs']],
  ['meringue', ['eggs']],
  // Peanuts, and "badam", which is peanut in Nepali and almond in Hindi: both, the safe side.
  ['peanut', ['peanuts']], ['peanuts', ['peanuts']], ['groundnut', ['peanuts']], ['groundnuts', ['peanuts']],
  ['badam', ['peanuts', 'tree nuts']],
  // Tree nuts
  ['almond', ['tree nuts']], ['almonds', ['tree nuts']], ['cashew', ['tree nuts']], ['cashews', ['tree nuts']],
  ['kaju', ['tree nuts']], ['walnut', ['tree nuts']], ['walnuts', ['tree nuts']], ['akhrot', ['tree nuts']],
  ['pistachio', ['tree nuts']], ['pistachios', ['tree nuts']], ['pista', ['tree nuts']], ['hazelnut', ['tree nuts']],
  ['hazelnuts', ['tree nuts']], ['pecan', ['tree nuts']], ['pecans', ['tree nuts']], ['macadamia', ['tree nuts']],
  ['praline', ['tree nuts']], ['marzipan', ['tree nuts']], ['nut', ['tree nuts']], ['nuts', ['tree nuts']],
  // Soy
  ['soy', ['soy']], ['soya', ['soy']], ['soybean', ['soy']], ['soybeans', ['soy']], ['bhatmas', ['soy']],
  ['tofu', ['soy']], ['edamame', ['soy']], ['miso', ['soy']], ['tempeh', ['soy']],
  // Sesame
  ['sesame', ['sesame']], ['til', ['sesame']], ['tahini', ['sesame']],
  // Fish
  ['fish', ['fish']], ['machha', ['fish']], ['tuna', ['fish']], ['salmon', ['fish']], ['sardine', ['fish']],
  ['sardines', ['fish']], ['anchovy', ['fish']], ['anchovies', ['fish']], ['cod', ['fish']], ['tilapia', ['fish']],
  ['rohu', ['fish']], ['trout', ['fish']], ['basa', ['fish']], ['mackerel', ['fish']],
  // Crustaceans
  ['prawn', ['crustaceans']], ['prawns', ['crustaceans']], ['shrimp', ['crustaceans']], ['shrimps', ['crustaceans']],
  ['crab', ['crustaceans']], ['lobster', ['crustaceans']], ['crayfish', ['crustaceans']], ['jhinga', ['crustaceans']],
  // Molluscs
  ['squid', ['molluscs']], ['calamari', ['molluscs']], ['octopus', ['molluscs']], ['mussel', ['molluscs']],
  ['mussels', ['molluscs']], ['clam', ['molluscs']], ['clams', ['molluscs']], ['oyster', ['molluscs']],
  ['oysters', ['molluscs']], ['scallop', ['molluscs']], ['scallops', ['molluscs']],
  ['shellfish', ['crustaceans', 'molluscs']],
  // Mustard, celery, sulphites, lupin
  ['mustard', ['mustard']], ['tori', ['mustard']], ['celery', ['celery']], ['celeriac', ['celery']],
  ['wine', ['sulphites']], ['raisin', ['sulphites']], ['raisins', ['sulphites']], ['rasins', ['sulphites']],
  ['kishmish', ['sulphites']],
  ['lupin', ['lupin']], ['lupine', ['lupin']],
]

// Mixed or branded products: their allergens are on the label, not in the name. A plain ground
// spice ("cumin powder") is not one, so "powder" alone is not here; baking powder is, by phrase.
const CHECK_LABEL = new Set([
  'sauce', 'ketchup', 'mix', 'masala', 'seasoning', 'spread', 'jam', 'sausage', 'sausages', 'salami', 'nugget',
  'nuggets', 'patty', 'patties', 'dressing', 'chocolate', 'premix', 'paste', 'stock', 'cube', 'cubes', 'gravy',
  'cereal', 'ham', 'bacon', 'chips', 'biscoff', 'nutella', 'marinade', 'dip', 'pickle', 'achar',
  'topping', 'filling', 'batter', 'crumb', 'coating',
  // Food heads that follow a packaging word in real names ("RICE BOWL GRAVY", "BOWL MARINATION"), S887.
  'marination', 'marinades', 'garnish', 'toppings', 'fillings', 'sauces', 'dressings',
])
const CHECK_LABEL_PHRASES = ['baking powder', 'custard powder', 'cheese powder']

// Packaging, cleaning and other supplies, as words and as phrases. Read against the real item book:
// cups and lids, but also mops, LPG and a software subscription sit in Item Master. "paper" is not
// food unless it is rice paper; a bag is not food unless it is a tea bag.
const NOT_FOOD = new Set([
  'cup', 'cups', 'lid', 'lids', 'bowl', 'bowls', 'straw', 'straws', 'napkin', 'napkins', 'tissue', 'tissues',
  'foil', 'cling', 'container', 'containers', 'spoon', 'spoons', 'fork', 'forks', 'plate', 'plates', 'box',
  'boxes', 'sticker', 'stickers', 'carton', 'cartons', 'bag', 'bags', 'pouch', 'pouches', 'tray', 'trays',
  'glove', 'gloves', 'toothpick', 'toothpicks', 'sleeve', 'sleeves', 'kraft', 'plastic', 'disposable',
  'takeaway', 'cutlery', 'stirrer', 'stirrers', 'detergent', 'sanitizer', 'sanitiser', 'soap',
  'paper', 'brush', 'cleaner', 'mop', 'pad', 'handwash', 'towel', 'towels', 'cylinder', 'lpg', 'mosquito',
  'freshner', 'freshener', 'scrub', 'toilet', 'thermal', 'charge', 'software', 'lizol', 'surf', 'garbage',
  'dustpan', 'broom', 'wipes', 'sponge', 'bin',
])
const NOT_FOOD_PHRASES = ['food wrap', 'cling film', 'cling wrap', 'kitchen roll']
const FOOD_DESPITE = ['rice paper', 'tea bag', 'tea bags']

// Longest phrases first, so a phrase uses up its words before a shorter rule can see them.
const COMPILED = RULES
  .map(([phrase, keys]) => ({ phrase, words: phrase.split(' '), keys }))
  .sort((a, b) => b.words.length - a.words.length)

function tokens(name) {
  return String(name || '').toLowerCase().replace(/[^a-z]+/g, ' ').trim().split(' ').filter(Boolean)
}

// The words a near miss is measured against: each one-word rule that names an allergen. A word of
// a longer phrase ("dried" in "dried apricot", "salt" in "celery salt") names none by itself, and
// measuring against it would read FRIED as DRIED.
const NEAR_MISS_MIN = 5
const ALLERGEN_WORDS = RULES.filter(([phrase, keys]) => keys.length > 0 && !phrase.includes(' ')).map(([phrase]) => phrase)
// Real words one letter from an allergen word, met in item books: BITTER gourd (butter), BROAD
// beans (bread), FLOOR mop (flour), a pizza CUTTER (butter), GOATS milk (oats), FAIRY washing-up
// liquid (dairy), kitchen TWINE (wine). None is a misspelling, so none asks for the label.
const REAL_WORDS = ['bitter', 'broad', 'floor', 'cutter', 'goats', 'fairy', 'twine']
// Every word Crest already has a rule for, in any list: never a misspelling of something else.
const KNOWN_WORDS = new Set([
  ...RULES.flatMap(([phrase]) => phrase.split(' ')),
  ...CHECK_LABEL, ...NOT_FOOD, ...REAL_WORDS,
  ...[...CHECK_LABEL_PHRASES, ...NOT_FOOD_PHRASES, ...FOOD_DESPITE].flatMap(p => p.split(' ')),
])

/** Whether two different words are one edit apart: a letter changed, added, removed, or two neighbours swapped. */
export function oneEditApart(a, b) {
  if (a === b || Math.abs(a.length - b.length) > 1) return false
  if (a.length === b.length) {
    const diff = []
    for (let i = 0; i < a.length && diff.length <= 2; i++) if (a[i] !== b[i]) diff.push(i)
    if (diff.length === 1) return true
    return diff.length === 2 && diff[1] === diff[0] + 1 && a[diff[0]] === b[diff[1]] && a[diff[1]] === b[diff[0]]
  }
  const [s, l] = a.length < b.length ? [a, b] : [b, a]
  let i = 0
  while (i < s.length && s[i] === l[i]) i++
  return s.slice(i) === l.slice(i + 1)
}

/** The allergen word a name word looks like, or null (see the header: a near miss). */
function nearMissOf(word) {
  if (word.length < NEAR_MISS_MIN || KNOWN_WORDS.has(word)) return null
  return ALLERGEN_WORDS.find(w => oneEditApart(word, w)) || null
}

/**
 * The guess for one ingredient name.
 * → { keys: [list order], reasons: { key: ['word', …] }, checkLabel: ['sauce', …], notFood: 'cup' | null,
 *     nearMiss: [{ word: 'crean', like: 'cream' }, …] }
 * A near-miss word is in checkLabel too, so the row is never confirmed on the guess.
 */
export function suggestAllergens(name) {
  const t = tokens(name)
  const used = new Array(t.length).fill(false)
  const reasons = {}
  for (const rule of COMPILED) {
    const n = rule.words.length
    for (let i = 0; i + n <= t.length; i++) {
      if (used.slice(i, i + n).some(Boolean)) continue
      if (rule.words.every((w, j) => t[i + j] === w)) {
        for (let j = 0; j < n; j++) used[i + j] = true
        rule.keys.forEach(k => { (reasons[k] = reasons[k] || []).includes(rule.phrase) || reasons[k].push(rule.phrase) })
      }
    }
  }
  const keys = ALLERGEN_KEYS.filter(k => reasons[k])
  const joined = ` ${t.join(' ')} `
  const has = phrase => joined.includes(` ${phrase} `)
  const nearMiss = []
  t.forEach((w, i) => {
    const like = used[i] ? null : nearMissOf(w)
    if (like && !nearMiss.some(n => n.word === w)) nearMiss.push({ word: w, like })
  })
  // Where a phrase ends in the name, each time it occurs.
  const endsOf = phrase => {
    const p = phrase.split(' ')
    const out = []
    for (let i = 0; i + p.length <= t.length; i++) if (p.every((w, j) => t[i + j] === w)) out.push(i + p.length - 1)
    return out
  }
  const labelAt = [
    ...CHECK_LABEL_PHRASES.flatMap(endsOf),
    ...t.map((w, i) => (!used[i] && CHECK_LABEL.has(w) ? i : -1)).filter(i => i >= 0),
  ]
  const lastPackAt = Math.max(-1, ...NOT_FOOD_PHRASES.flatMap(endsOf), ...t.map((w, i) => (NOT_FOOD.has(w) ? i : -1)))
  // A packaging word outranks a label word only when it comes LAST of the two (S887): the head of an
  // English name is its last word, so "dip cup" is a cup and "rice bowl gravy" is a gravy. It never
  // outranks an allergen word ("milk carton") or a near miss of one ("ice crean cup" might be ice cream).
  const packWord = keys.length === 0 && nearMiss.length === 0 && !FOOD_DESPITE.some(has)
    && lastPackAt >= 0 && !labelAt.some(i => i > lastPackAt)
    ? NOT_FOOD_PHRASES.find(has) || t.find(w => NOT_FOOD.has(w)) || null
    : null
  const checkLabel = packWord ? [] : [
    ...CHECK_LABEL_PHRASES.filter(has),
    ...t.filter((w, i) => !used[i] && CHECK_LABEL.has(w)),
    ...nearMiss.map(n => n.word),
  ]
  return { keys, reasons, checkLabel: [...new Set(checkLabel)], notFood: packWord, nearMiss }
}

/** "“crean” looks like “cream”", for the Check allergens list and the Nutrition form. */
export function nearMissText(nearMiss) {
  return (nearMiss || []).map(n => `“${n.word}” looks like “${n.like}”`).join(', ')
}
