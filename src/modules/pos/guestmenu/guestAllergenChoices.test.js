import { choiceHidden, ruleReachable, safeDishGroups } from './guestAllergenChoices'
import { groupsForDish, defaultSelection } from '../../../shared/optionPricing'

// S877 (owner decision): hide the CHOICE, not the dish. A choice carrying an allergen the guest hides
// leaves the dish's sheet; the dish leaves the menu only when it cannot be ordered without one.

const PIZZA = 'r-pizza'
const catalog = {
  groups: [
    { id: 'g-base', name: 'Base', kind: 'other', min_select: 1, max_select: 1, included_count: 0, sort: 0, is_active: true },
    { id: 'g-top', name: 'Toppings', kind: 'addon', min_select: 0, max_select: null, included_count: 0, sort: 1, is_active: true },
  ],
  options: [
    // The default base carries milk; the thin base does not.
    { id: 'o-cheesy', group_id: 'g-base', name: 'Cheese-stuffed base', price_delta: 80, is_default: true, sort: 0, is_active: true, allergens: ['gluten', 'milk'] },
    { id: 'o-thin', group_id: 'g-base', name: 'Thin base', price_delta: 0, sort: 1, is_active: true, allergens: ['gluten'] },
    { id: 'o-cheese', group_id: 'g-top', name: 'Extra cheese', price_delta: 60, sort: 0, is_active: true, allergens: ['milk'] },
    { id: 'o-olive', group_id: 'g-top', name: 'Olives', price_delta: 40, sort: 1, is_active: true },
  ],
  attachments: [
    { id: 'a1', recipe_id: PIZZA, group_id: 'g-base', sort: 0 },
    { id: 'a2', recipe_id: PIZZA, group_id: 'g-top', sort: 1 },
  ],
}
const pizza = groupsForDish(PIZZA, catalog)
const idsOf = groups => groups.map(d => [d.group.id, d.options.map(o => o.id)])

describe('choiceHidden', () => {
  test('a choice is hidden only for an allergen it carries', () => {
    expect(choiceHidden(catalog.options[2], ['milk'])).toBe(true)
    expect(choiceHidden(catalog.options[2], ['eggs'])).toBe(false)
    expect(choiceHidden(catalog.options[3], ['milk'])).toBe(false)
    expect(choiceHidden(catalog.options[2], [])).toBe(false)
  })
})

describe('safeDishGroups', () => {
  test('with no allergen hidden, the dish is offered exactly as before', () => {
    const safe = safeDishGroups(pizza, [])
    expect(safe.groups).toBe(pizza)
    expect(safe).toMatchObject({ hidden: 0, orderable: true })
  })

  test('hides the choice, not the dish', () => {
    const safe = safeDishGroups(pizza, ['milk'])
    expect(safe.orderable).toBe(true)
    expect(safe.hidden).toBe(2)
    expect(idsOf(safe.groups)).toEqual([['g-base', ['o-thin']], ['g-top', ['o-olive']]])
    expect(safe.groups.map(d => d.hiddenCount)).toEqual([1, 1])
  })

  test('a default that carries a hidden allergen is not picked when a safe choice exists', () => {
    expect(defaultSelection(pizza)).toEqual(['o-cheesy'])
    expect(defaultSelection(safeDishGroups(pizza, ['milk']).groups)).toEqual([])
  })

  test('the dish leaves the menu when a group that must have a pick has none left', () => {
    const safe = safeDishGroups(pizza, ['gluten'])
    expect(safe.orderable).toBe(false)
    // Only the toppings are left to show, and the dish is no longer offered at all.
    expect(idsOf(safe.groups)).toEqual([['g-top', ['o-cheese', 'o-olive']]])
  })

  test('an optional group with every choice hidden simply goes, and the dish stays', () => {
    const allMilk = groupsForDish(PIZZA, { ...catalog, options: catalog.options.map(o => (o.group_id === 'g-top' ? { ...o, allergens: ['milk'] } : o)) })
    const safe = safeDishGroups(allMilk, ['milk'])
    expect(safe.orderable).toBe(true)
    expect(idsOf(safe.groups)).toEqual([['g-base', ['o-thin']]])
  })

  test('a group needing more picks than are left can no longer be ordered', () => {
    const two = groupsForDish(PIZZA, { ...catalog, groups: catalog.groups.map(g => (g.id === 'g-top' ? { ...g, min_select: 2 } : g)) })
    expect(safeDishGroups(two, ['milk']).orderable).toBe(false)
    expect(safeDishGroups(two, ['eggs']).orderable).toBe(true)
  })

  test('a line being changed keeps its own picks on the sheet', () => {
    const safe = safeDishGroups(pizza, ['milk'], { keep: ['o-cheese'] })
    expect(idsOf(safe.groups)).toEqual([['g-base', ['o-thin']], ['g-top', ['o-cheese', 'o-olive']]])
    expect(safe.hidden).toBe(1)
  })
})

describe('ruleReachable', () => {
  const opt = (id, is_removal = false) => ({ id, is_removal })
  test('an optional group is always met', () => {
    expect(ruleReachable({ min: 0, max: 1 }, [])).toBe(true)
  })
  test('a one-pick group needs one choice', () => {
    expect(ruleReachable({ min: 1, max: 1 }, [opt('a')])).toBe(true)
    expect(ruleReachable({ min: 1, max: 1 }, [])).toBe(false)
  })
  test('a "No …" removal answers the minimum without taking a place under the maximum', () => {
    expect(ruleReachable({ min: 3, max: 2 }, [opt('a'), opt('b'), opt('no', true)])).toBe(true)
    expect(ruleReachable({ min: 3, max: 2 }, [opt('a'), opt('b'), opt('c')])).toBe(false)
    // A one-pick group is a single radio on the sheet: it can never give two.
    expect(ruleReachable({ min: 2, max: 1 }, [opt('a'), opt('no', true)])).toBe(false)
    expect(ruleReachable({ min: 2, max: null }, [opt('a'), opt('b')])).toBe(true)
  })
})
