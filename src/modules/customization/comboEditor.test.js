import {
  isComboDish, emptyCombo, emptyPick, newPickItem, assembleCombos, pickSummary, isSetMeal,
  editorFromCombo, prefillFromDishes, moveItem, setDefault, setPickDishes, validateCombo,
  comboPayload, comboForShares, sameEditorState,
} from './comboEditor'
import { comboShares } from './comboPricing'

const recipes = {
  veg:    { id: 'veg', name: 'Veg Momo', category: 'Momo', selling_price: 200, vat_rate: 0.13, is_active: true },
  chk:    { id: 'chk', name: 'Chicken Momo', category: 'Momo', selling_price: 240, vat_rate: 0.13, is_active: true },
  coke:   { id: 'coke', name: 'Coke', category: 'Beverage', selling_price: 100, vat_rate: 0.13, is_active: true },
  papad:  { id: 'papad', name: 'Papad', category: null, selling_price: null, vat_rate: 0.13, is_active: true, pos_enabled: false },
  sauce:  { id: 'sauce', name: 'Momo Sauce', category: 'Sub-Recipe', selling_price: 0, is_active: true },
  old:    { id: 'old', name: 'Old Thali', category: 'Food', selling_price: 300, is_active: false },
}
const byId = new Map(Object.values(recipes).map(r => [r.id, r]))
const recipeOf = id => byId.get(id)

const saved = {
  id: 'c1', name: 'Momo Combo', guest_price: '350.00', description: 'Momo and a drink', is_active: true, on_guest_menu: false, sort: 2,
}
const savedGroups = [
  { id: 'g2', combo_id: 'c1', name: 'Pick a drink', sort: 1 },
  { id: 'g1', combo_id: 'c1', name: 'Pick a momo', sort: 0 },
]
const savedItems = [
  { id: 'i3', group_id: 'g2', recipe_id: 'coke', extra_price: '0', is_default: true, sort: 0 },
  { id: 'i2', group_id: 'g1', recipe_id: 'chk', extra_price: '50.00', is_default: false, sort: 1 },
  { id: 'i1', group_id: 'g1', recipe_id: 'veg', extra_price: '0', is_default: true, sort: 0 },
]

function validState(over = {}) {
  return {
    ...emptyCombo(0),
    name: 'Momo Combo',
    price: '350',
    picks: [
      { key: 'p1', id: null, name: 'Pick a momo', items: [{ key: 'a', recipe_id: 'veg', extra: '', is_default: true }, { key: 'b', recipe_id: 'chk', extra: '50', is_default: false }] },
      { key: 'p2', id: null, name: 'Pick a drink', items: [{ key: 'c', recipe_id: 'coke', extra: '', is_default: false }] },
    ],
    ...over,
  }
}

describe('isComboDish', () => {
  it('takes an active dish, priced or not, and refuses a Sub-Recipe or an inactive one', () => {
    expect(isComboDish(recipes.veg)).toBe(true)
    expect(isComboDish(recipes.papad)).toBe(true)
    expect(isComboDish(recipes.sauce)).toBe(false)
    expect(isComboDish(recipes.old)).toBe(false)
    expect(isComboDish(undefined)).toBe(false)
  })
})

describe('assembleCombos / pickSummary / isSetMeal', () => {
  it('nests picks and dishes under their combo in display order', () => {
    const [c] = assembleCombos([saved], savedGroups, savedItems)
    expect(c.groups.map(g => g.name)).toEqual(['Pick a momo', 'Pick a drink'])
    expect(c.groups[0].items.map(i => i.recipe_id)).toEqual(['veg', 'chk'])
    expect(pickSummary(c.groups)).toBe('Pick a momo (2) · Pick a drink (1)')
    expect(isSetMeal(c.groups)).toBe(false)
  })
  it('calls a combo whose every pick has one dish a set meal, and an empty one not', () => {
    expect(isSetMeal([{ items: [{}] }, { items: [{}] }])).toBe(true)
    expect(isSetMeal([])).toBe(false)
  })
  it('orders combos by sort, then name', () => {
    const list = assembleCombos([
      { id: 'x', name: 'Zed', sort: 0 }, { id: 'y', name: 'Alpha', sort: 0 }, { id: 'z', name: 'First', sort: -1 },
    ], [], [])
    expect(list.map(c => c.name)).toEqual(['First', 'Alpha', 'Zed'])
  })
})

describe('editorFromCombo → comboPayload', () => {
  it('round-trips a saved combo, keeping each pick\'s id and sending the client', () => {
    const [c] = assembleCombos([saved], savedGroups, savedItems)
    const state = editorFromCombo(c)
    expect(state.price).toBe('350')
    expect(state.picks[0].items[1].extra).toBe('50')
    expect(state.picks[0].items[0].extra).toBe('')
    expect(comboPayload(state, 'client-1')).toEqual({
      id: 'c1',
      client_id: 'client-1',
      name: 'Momo Combo',
      guest_price: 350,
      description: 'Momo and a drink',
      is_active: true,
      on_guest_menu: false,
      sort: 2,
      groups: [
        { id: 'g1', name: 'Pick a momo', sort: 0, items: [
          { recipe_id: 'veg', extra_price: 0, is_default: true, sort: 0 },
          { recipe_id: 'chk', extra_price: 50, is_default: false, sort: 1 },
        ] },
        { id: 'g2', name: 'Pick a drink', sort: 1, items: [
          { recipe_id: 'coke', extra_price: 0, is_default: true, sort: 0 },
        ] },
      ],
    })
  })
  it('sends no id for a new combo or a new pick, trims names and blanks an empty description', () => {
    const p = comboPayload(validState({ name: '  Momo Combo ', description: '   ', price: '349.999' }), 'client-1')
    expect(p.id).toBeUndefined()
    expect(p.name).toBe('Momo Combo')
    expect(p.description).toBeNull()
    expect(p.guest_price).toBe(350)
    expect(p.groups.every(g => !('id' in g))).toBe(true)
    expect(p.groups.map(g => g.sort)).toEqual([0, 1])
  })
})

describe('prefillFromDishes (Combo Builder hand-off)', () => {
  it('makes one pick per dish, named after its category, at the suggested price', () => {
    const s = prefillFromDishes(['veg', 'coke'], '345', byId, 4)
    expect(s.price).toBe('345')
    expect(s.name).toBe('Veg Momo + Coke')
    expect(s.sort).toBe(4)
    expect(s.picks.map(p => p.name)).toEqual(['Momo', 'Beverage'])
    expect(s.picks.map(p => p.items.map(i => i.recipe_id))).toEqual([['veg'], ['coke']])
  })
  it('names a pick after the dish when the category is taken or missing, and skips what is not a dish', () => {
    const s = prefillFromDishes(['veg', 'chk', 'papad', 'sauce', 'old', 'nope', 'veg'], 'abc', byId)
    expect(s.price).toBe('')
    expect(s.picks.map(p => p.name)).toEqual(['Momo', 'Chicken Momo', 'Papad'])
    expect(prefillFromDishes(['nope'], 300, byId).name).toBe('')
  })
})

describe('moveItem / setDefault / setPickDishes', () => {
  it('moves within bounds and leaves the list alone past an edge', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c'])
    const l = ['a', 'b']
    expect(moveItem(l, 0, -1)).toBe(l)
    expect(moveItem(l, 1, 1)).toBe(l)
  })
  it('keeps at most one default, and can clear it', () => {
    const p = validState().picks[0]
    expect(setDefault(p, 'b').items.map(i => i.is_default)).toEqual([false, true])
    expect(setDefault(p, null).items.map(i => i.is_default)).toEqual([false, false])
  })
  it('keeps a staying dish\'s charge and place, drops the rest and appends new ones', () => {
    const p = validState().picks[0]
    const next = setPickDishes(p, ['coke', 'chk'])
    expect(next.items.map(i => i.recipe_id)).toEqual(['chk', 'coke'])
    expect(next.items[0]).toEqual(p.items[1])
    expect(next.items[1].extra).toBe('')
  })
})

describe('validateCombo', () => {
  it('passes a complete combo', () => {
    expect(validateCombo(validState(), { recipeOf }).ok).toBe(true)
  })
  it('names the combo name, price and missing picks', () => {
    const v = validateCombo({ ...emptyCombo(), price: '0' }, { recipeOf })
    expect(v.ok).toBe(false)
    expect(v.name).toMatch(/name/)
    expect(v.price).toMatch(/more than 0/)
    expect(v.picks).toMatch(/at least one pick/)
    expect(validateCombo({ ...validState(), price: '' }, { recipeOf }).price).toMatch(/Type what the guest pays/)
    expect(validateCombo({ ...validState(), price: 'abc' }, { recipeOf }).price).toMatch(/more than 0/)
  })
  it('refuses a name another combo has, whatever its case or spaces', () => {
    const v = validateCombo(validState(), { recipeOf, otherNames: ['  momo combo '] })
    expect(v.ok).toBe(false)
    expect(v.name).toMatch(/already a combo/)
  })
  it('flags an unnamed pick, a repeated pick name and an empty pick, on that pick', () => {
    const s = validState()
    s.picks.push({ ...emptyPick(), key: 'p3', name: 'pick a MOMO ' })
    s.picks.push({ ...emptyPick(), key: 'p4', name: '', items: [newPickItem('coke')] })
    const v = validateCombo(s, { recipeOf })
    expect(v.ok).toBe(false)
    expect(v.pickName.p3).toMatch(/already called/)
    expect(v.pickDishes.p3).toMatch(/at least one dish/)
    expect(v.pickName.p4).toMatch(/Name pick 4/)
  })
  it('flags a dish that left the menu, two defaults, and a negative extra charge', () => {
    const s = validState()
    s.picks[1].items.push({ key: 'd', recipe_id: 'old', extra: '', is_default: false })
    s.picks[0].items[1].is_default = true
    s.picks[0].items[1].extra = '-5'
    const v = validateCombo(s, { recipeOf })
    expect(v.pickDishes.p2).toMatch(/“Old Thali” is no longer an active dish/)
    expect(v.pickDishes.p1).toMatch(/Only one dish can be the default/)
    expect(v.extra.b).toMatch(/0 or more/)
  })
})

describe('comboForShares', () => {
  it('previews the split comboShares gives, by pick key, before anything is saved', () => {
    const shares = comboShares(comboForShares(validState()), recipeOf, true)
    // Cheapest momo 226 vs Coke 113 → two thirds and one third of 350.
    expect(shares.p1).toBeCloseTo(233.33, 2)
    expect(shares.p2).toBeCloseTo(116.67, 2)
    expect(shares.p1 + shares.p2).toBeCloseTo(350, 6)
  })
  it('reads an unparseable price as 0', () => {
    expect(comboForShares(validState({ price: 'x' })).guest_price).toBe(0)
  })
})

describe('sameEditorState', () => {
  it('ignores the local row keys and sees a real change', () => {
    const a = validState()
    const b = { ...a, picks: a.picks.map(p => ({ ...p, items: p.items.map(i => ({ ...i, key: i.key + 'x' })) })) }
    expect(sameEditorState(a, b)).toBe(true)
    expect(sameEditorState(a, { ...a, name: 'Other' })).toBe(false)
  })
})
