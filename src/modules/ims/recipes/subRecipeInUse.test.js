import { recipeNamesOf, choiceNamesOf, subRecipeInUseText } from './subRecipeInUse'

// A Customization choice's stock line holds a sub-recipe through a plain FK, and the delete
// pre-check only read recipe_ingredients, so the refusal arrived as the generic "use Hide".

const live = { customizationLive: true, isAdmin: false, canEditChoices: true }
const off = { customizationLive: false, isAdmin: false, canEditChoices: true }
const operatorOff = { customizationLive: false, isAdmin: true, canEditChoices: true }

const choiceRow = (group, option) => ({ option_id: `${group}-${option}`, pos_options: { name: option, pos_option_groups: { name: group } } })

describe('recipeNamesOf / choiceNamesOf', () => {
  it('names each parent recipe once', () => {
    expect(recipeNamesOf([{ recipes: { name: 'Acai Bowl' } }, { recipes: { name: 'Acai Bowl' } }, { recipes: null }]))
      .toEqual(['Acai Bowl'])
    expect(recipeNamesOf(null)).toEqual([])
  })

  it('names a choice as Group › Choice, once each', () => {
    expect(choiceNamesOf([choiceRow('Toppings', 'Granola'), choiceRow('Toppings', 'Granola'), choiceRow('Bowls', 'Extra granola')]))
      .toEqual(['Toppings › Granola', 'Bowls › Extra granola'])
  })

  it('still counts a line whose names did not come back — a found line must refuse', () => {
    expect(choiceNamesOf([{ option_id: 'x', pos_options: null }])).toEqual(['an unnamed choice'])
    expect(choiceNamesOf([{ option_id: 'x', pos_options: { name: 'Granola', pos_option_groups: null } }])).toEqual(['Granola'])
  })
})

describe('subRecipeInUseText — delete', () => {
  const base = { action: 'delete', name: 'House Granola' }

  it('is null when nothing uses it', () => {
    expect(subRecipeInUseText({ ...base, ...live })).toBeNull()
  })

  it('recipes only: the sentence the page always said', () => {
    expect(subRecipeInUseText({ ...base, ...live, recipeNames: ['Acai Bowl', 'Parfait'] }))
      .toBe('Can\'t delete "House Granola" — it\'s used as an ingredient in: Acai Bowl, Parfait. Remove it from those recipes first.')
  })

  it('choices only: names Group › Choice and sends the reader to Option Groups', () => {
    expect(subRecipeInUseText({ ...base, ...live, choiceNames: ['Toppings › Granola'] }))
      .toBe('Can\'t delete "House Granola" — it\'s a stock line on these choices: Toppings › Granola. Remove it from those choices in Option Groups first.')
  })

  it('both: names both in one message', () => {
    expect(subRecipeInUseText({ ...base, ...live, recipeNames: ['Parfait'], choiceNames: ['Toppings › Granola'] }))
      .toBe('Can\'t delete "House Granola" — it\'s used as an ingredient in: Parfait, and it\'s a stock line on these choices: Toppings › Granola. Remove it from those recipes, and from those choices in Option Groups, first.')
  })

  it('Customization off, Owner: says the choices cannot be changed here and to ask Crest support', () => {
    const text = subRecipeInUseText({ ...base, ...off, choiceNames: ['Toppings › Granola'] })
    expect(text).toBe('Can\'t delete "House Granola" — it\'s a stock line on these choices: Toppings › Granola. Crest Customization is switched off at this outlet, so those choices can\'t be changed here — ask Crest support to remove it from them, then try again.')
    expect(text).not.toMatch(/Remove it from those choices in Option Groups/)
  })

  it('Customization off, Owner, recipes too: the recipes are still theirs to fix', () => {
    expect(subRecipeInUseText({ ...base, ...off, recipeNames: ['Parfait'], choiceNames: ['Toppings › Granola'] }))
      .toMatch(/Remove it from those recipes first\. Crest Customization is switched off at this outlet, so those choices can't be changed here — ask Crest support/)
  })

  it('Customization off, recipes only: nothing about Customization', () => {
    expect(subRecipeInUseText({ ...base, ...off, recipeNames: ['Parfait'] }))
      .toBe('Can\'t delete "House Granola" — it\'s used as an ingredient in: Parfait. Remove it from those recipes first.')
  })

  it('Customization off, Crest support: can still edit the choices, so is sent to Option Groups', () => {
    const text = subRecipeInUseText({ ...base, ...operatorOff, choiceNames: ['Toppings › Granola'] })
    expect(text).toBe('Can\'t delete "House Granola" — it\'s a stock line on these choices: Toppings › Granola. Remove it from those choices in Option Groups first. Crest Customization is switched off at this outlet, but as Crest support you can still edit its choices.')
    expect(text).not.toMatch(/ask Crest support/)
  })

  it('Customization live, Crest support: the plain Option Groups sentence', () => {
    expect(subRecipeInUseText({ ...base, customizationLive: true, isAdmin: true, canEditChoices: true, choiceNames: ['Toppings › Granola'] }))
      .toBe('Can\'t delete "House Granola" — it\'s a stock line on these choices: Toppings › Granola. Remove it from those choices in Option Groups first.')
  })

  it('Customization live, a rank that cannot edit choices: ask the Owner or a manager', () => {
    expect(subRecipeInUseText({ ...base, customizationLive: true, isAdmin: false, canEditChoices: false, choiceNames: ['Toppings › Granola'] }))
      .toBe('Can\'t delete "House Granola" — it\'s a stock line on these choices: Toppings › Granola. Ask the Owner or a manager to remove it from those choices in Option Groups.')
  })
})

describe('subRecipeInUseText — moving it out of the Sub-Recipe category', () => {
  const base = { action: 'recategorise', name: 'House Granola' }

  it('is null when nothing uses it', () => {
    expect(subRecipeInUseText({ ...base, ...live })).toBeNull()
  })

  it('recipes only: the S714 sentence word for word, Hide included', () => {
    expect(subRecipeInUseText({ ...base, ...live, recipeNames: ['Parfait'] }))
      .toBe('"House Granola" is an ingredient in Parfait, so it can\'t stop being a Sub-Recipe — those recipes would keep consuming it while it disappeared from their ingredient pickers. Remove it from them first, or use Hide if you just want it off the menu.')
  })

  it('choices only: names the consequence and does not offer Hide (it hides the line too)', () => {
    const text = subRecipeInUseText({ ...base, ...live, choiceNames: ['Toppings › Granola'] })
    expect(text).toBe('"House Granola" is a stock line on these choices: Toppings › Granola, so it can\'t stop being a Sub-Recipe — those choices would keep taking it off stock while it disappeared from Option Groups. Remove it from those choices in Option Groups first.')
    expect(text).not.toMatch(/Hide/)
  })

  it('both: one sentence naming both', () => {
    expect(subRecipeInUseText({ ...base, ...live, recipeNames: ['Parfait'], choiceNames: ['Toppings › Granola'] }))
      .toBe('"House Granola" is an ingredient in Parfait and a stock line on these choices: Toppings › Granola, so it can\'t stop being a Sub-Recipe — they would keep consuming it while it disappeared from the recipes\' ingredient pickers and from Option Groups. Remove it from those recipes, and from those choices in Option Groups, first.')
  })

  it('Customization off, Owner: ask Crest support', () => {
    expect(subRecipeInUseText({ ...base, ...off, choiceNames: ['Toppings › Granola'] }))
      .toMatch(/Crest Customization is switched off at this outlet, so those choices can't be changed here — ask Crest support to remove it from them, then try again\.$/)
  })

  it('Customization off, Crest support: Option Groups, not "ask Crest support"', () => {
    const text = subRecipeInUseText({ ...base, ...operatorOff, choiceNames: ['Toppings › Granola'] })
    expect(text).toMatch(/Remove it from those choices in Option Groups first\. Crest Customization is switched off at this outlet, but as Crest support you can still edit its choices\.$/)
    expect(text).not.toMatch(/ask Crest support/)
  })
})
