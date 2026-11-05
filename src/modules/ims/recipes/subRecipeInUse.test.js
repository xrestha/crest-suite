import { recipeNamesOf, choiceNamesOf, subRecipeInUseText } from './subRecipeInUse'

// A Customization choice's stock line holds a sub-recipe through a plain FK, and the delete
// pre-check only read recipe_ingredients, so the refusal arrived as the generic "use Hide".

const live = { customizationLive: true, isAdmin: false, canEditChoices: true }
const off = { customizationLive: false, isAdmin: false, canEditChoices: true }
const operatorOff = { customizationLive: false, isAdmin: true, canEditChoices: true }

// S886, owner decision: once a choice holds it, the refusal also offers Hide.
const HIDE_CHOICES = 'Or use Hide if you just want it out of your recipe lists: those choices keep working and keep taking it off stock.'
const HIDE_BOTH = 'Or use Hide if you just want it out of your recipe lists: those recipes and choices keep using it and keep taking it off stock.'

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

  it('choices only: names Group › Choice and sends the reader to Choice Groups', () => {
    expect(subRecipeInUseText({ ...base, ...live, choiceNames: ['Toppings › Granola'] }))
      .toBe('Can\'t delete "House Granola" — it\'s a stock line on these choices: Toppings › Granola. Remove it from those choices in Choice Groups first. ' + HIDE_CHOICES)
  })

  it('both: names both in one message', () => {
    expect(subRecipeInUseText({ ...base, ...live, recipeNames: ['Parfait'], choiceNames: ['Toppings › Granola'] }))
      .toBe('Can\'t delete "House Granola" — it\'s used as an ingredient in: Parfait, and it\'s a stock line on these choices: Toppings › Granola. Remove it from those recipes, and from those choices in Choice Groups, first. ' + HIDE_BOTH)
  })

  it('Customization off, Owner: says the choices cannot be changed here and to ask Crest support', () => {
    const text = subRecipeInUseText({ ...base, ...off, choiceNames: ['Toppings › Granola'] })
    expect(text).toBe('Can\'t delete "House Granola" — it\'s a stock line on these choices: Toppings › Granola. Crest Customization is switched off at this outlet, so those choices can\'t be changed here — ask Crest support to remove it from them, then try again. ' + HIDE_CHOICES)
    expect(text).not.toMatch(/Remove it from those choices in Choice Groups/)
  })

  it('Customization off, Owner, recipes too: the recipes are still theirs to fix', () => {
    expect(subRecipeInUseText({ ...base, ...off, recipeNames: ['Parfait'], choiceNames: ['Toppings › Granola'] }))
      .toMatch(/Remove it from those recipes first\. Crest Customization is switched off at this outlet, so those choices can't be changed here — ask Crest support/)
  })

  it('Customization off, recipes only: nothing about Customization', () => {
    expect(subRecipeInUseText({ ...base, ...off, recipeNames: ['Parfait'] }))
      .toBe('Can\'t delete "House Granola" — it\'s used as an ingredient in: Parfait. Remove it from those recipes first.')
  })

  it('Customization off, Crest support: can still edit the choices, so is sent to Choice Groups', () => {
    const text = subRecipeInUseText({ ...base, ...operatorOff, choiceNames: ['Toppings › Granola'] })
    expect(text).toBe('Can\'t delete "House Granola" — it\'s a stock line on these choices: Toppings › Granola. Remove it from those choices in Choice Groups first. Crest Customization is switched off at this outlet, but as Crest support you can still edit its choices. ' + HIDE_CHOICES)
    expect(text).not.toMatch(/ask Crest support/)
  })

  it('Customization live, Crest support: the plain Choice Groups sentence', () => {
    expect(subRecipeInUseText({ ...base, customizationLive: true, isAdmin: true, canEditChoices: true, choiceNames: ['Toppings › Granola'] }))
      .toBe('Can\'t delete "House Granola" — it\'s a stock line on these choices: Toppings › Granola. Remove it from those choices in Choice Groups first. ' + HIDE_CHOICES)
  })

  it('Customization live, a rank that cannot edit choices: ask the Owner or a manager', () => {
    expect(subRecipeInUseText({ ...base, customizationLive: true, isAdmin: false, canEditChoices: false, choiceNames: ['Toppings › Granola'] }))
      .toBe('Can\'t delete "House Granola" — it\'s a stock line on these choices: Toppings › Granola. Ask the Owner or a manager to remove it from those choices in Choice Groups. ' + HIDE_CHOICES)
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

  it('choices only: names the consequence and offers Hide (S886)', () => {
    expect(subRecipeInUseText({ ...base, ...live, choiceNames: ['Toppings › Granola'] }))
      .toBe('"House Granola" is a stock line on these choices: Toppings › Granola, so it can\'t stop being a Sub-Recipe — those choices would keep taking it off stock while it disappeared from Choice Groups. Remove it from those choices in Choice Groups first. ' + HIDE_CHOICES)
  })

  it('both: one sentence naming both', () => {
    expect(subRecipeInUseText({ ...base, ...live, recipeNames: ['Parfait'], choiceNames: ['Toppings › Granola'] }))
      .toBe('"House Granola" is an ingredient in Parfait and a stock line on these choices: Toppings › Granola, so it can\'t stop being a Sub-Recipe — they would keep consuming it while it disappeared from the recipes\' ingredient pickers and from Choice Groups. Remove it from those recipes, and from those choices in Choice Groups, first. ' + HIDE_BOTH)
  })

  it('Customization off, Owner: ask Crest support', () => {
    expect(subRecipeInUseText({ ...base, ...off, choiceNames: ['Toppings › Granola'] }))
      .toMatch(/Crest Customization is switched off at this outlet, so those choices can't be changed here — ask Crest support to remove it from them, then try again\. Or use Hide/)
  })

  it('Customization off, Crest support: Choice Groups, not "ask Crest support"', () => {
    const text = subRecipeInUseText({ ...base, ...operatorOff, choiceNames: ['Toppings › Granola'] })
    expect(text).toMatch(/Remove it from those choices in Choice Groups first\. Crest Customization is switched off at this outlet, but as Crest support you can still edit its choices\. Or use Hide/)
    expect(text).not.toMatch(/ask Crest support/)
  })
})

// S886, owner decision: Hide is an Inventory action on the recipe row, so a refusal that names a
// choice offers it whatever the reader can do about the choice itself.
describe('subRecipeInUseText — offers Hide once a choice holds it (S886)', () => {
  const accessCases = {
    edit: live,
    operator: operatorOff,
    rank: { customizationLive: true, isAdmin: false, canEditChoices: false },
    off,
  }

  for (const action of ['delete', 'recategorise']) {
    for (const [label, access] of Object.entries(accessCases)) {
      it(`${action}, ${label}: choices only end on the choices sentence, once`, () => {
        const text = subRecipeInUseText({ action, name: 'House Granola', ...access, choiceNames: ['Toppings › Granola'] })
        expect(text.endsWith(' ' + HIDE_CHOICES)).toBe(true)
        expect(text.match(/Hide/g)).toHaveLength(1)
      })

      it(`${action}, ${label}: recipes and choices end on the recipes-and-choices sentence, once`, () => {
        const text = subRecipeInUseText({ action, name: 'House Granola', ...access, recipeNames: ['Parfait'], choiceNames: ['Toppings › Granola'] })
        expect(text.endsWith(' ' + HIDE_BOTH)).toBe(true)
        expect(text.match(/Hide/g)).toHaveLength(1)
      })
    }
  }

  it('a recipes-only delete still offers no Hide, in any access case', () => {
    for (const access of Object.values(accessCases)) {
      expect(subRecipeInUseText({ action: 'delete', name: 'House Granola', ...access, recipeNames: ['Parfait'] })).not.toMatch(/Hide/)
    }
  })

  it('a recipes-only move out of the category keeps only its own S714 Hide', () => {
    const text = subRecipeInUseText({ action: 'recategorise', name: 'House Granola', ...live, recipeNames: ['Parfait'] })
    expect(text.match(/Hide/g)).toHaveLength(1)
    expect(text).not.toMatch(/recipe lists/)
  })
})
