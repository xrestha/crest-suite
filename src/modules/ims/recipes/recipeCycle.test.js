import fs from 'fs'
import path from 'path'
import { findRecipeCycle, isRecipeCycleError, recipeCycleText } from './recipeCycle'

// S792 RECIPES-7: the cycle check read the page's in-memory recipe book. These tests hand the walk
// a "database" instead — the saved sub-recipe lines — and a reader that records what it was asked.

// Saved lines: parent -> [sub-recipes it contains]
function dbOf(lines) {
  const calls = []
  const readSubLines = async ids => {
    calls.push([...ids])
    return { data: ids.flatMap(id => (lines[id] || []).map(sub => ({ recipe_id: id, sub_recipe_id: sub }))), error: null }
  }
  return { readSubLines, calls }
}

describe('findRecipeCycle', () => {
  it("finds the loop another tab just saved: Sauce B now holds Sauce A, and A is adding B", async () => {
    const db = dbOf({ B: ['A'] })
    expect(await findRecipeCycle({ recipeId: 'A', subRecipeIds: ['B'], ...db })).toEqual({ chain: ['B'], error: null })
  })

  it('follows a longer chain and returns it from the new sub-recipe down', async () => {
    const db = dbOf({ B: ['C', 'X'], C: ['D'], D: ['A'], X: [] })
    const r = await findRecipeCycle({ recipeId: 'A', subRecipeIds: ['X', 'B'], ...db })
    expect(r).toEqual({ chain: ['B', 'C', 'D'], error: null })
    // One read per level, each scoped to the recipes it walks.
    expect(db.calls).toEqual([['X', 'B'], ['C'], ['D']])
  })

  it('a base shared by two branches is not a loop, and an old loop elsewhere does not hang it', async () => {
    const db = dbOf({ B: ['Stock', 'Roux'], Roux: ['Stock'], Stock: [], P: ['Q'], Q: ['P'] })
    expect(await findRecipeCycle({ recipeId: 'A', subRecipeIds: ['B', 'P'], ...db })).toEqual({ chain: null, error: null })
  })

  it('a recipe naming itself is a loop of one', async () => {
    const db = dbOf({})
    expect(await findRecipeCycle({ recipeId: 'A', subRecipeIds: ['A'], ...db })).toEqual({ chain: ['A'], error: null })
    expect(db.calls).toEqual([])
  })

  it('reads nothing when the list names no sub-recipe', async () => {
    const db = dbOf({})
    expect(await findRecipeCycle({ recipeId: 'A', subRecipeIds: [], ...db })).toEqual({ chain: null, error: null })
    expect(db.calls).toEqual([])
  })

  it('a check that could not run has not passed: a failed read, or a chain too deep to finish', async () => {
    const failing = async () => ({ data: null, error: { message: 'Failed to fetch' } })
    expect(await findRecipeCycle({ recipeId: 'A', subRecipeIds: ['B'], readSubLines: failing }))
      .toEqual({ chain: null, error: { message: 'Failed to fetch' } })
    const deep = dbOf({ B: ['C'], C: ['D'], D: ['E'] })
    const r = await findRecipeCycle({ recipeId: 'A', subRecipeIds: ['B'], ...deep, maxRounds: 2 })
    expect(r.chain).toBeNull()
    expect(r.error.message).toMatch(/stopped after 2 levels/)
  })
})

describe('isRecipeCycleError', () => {
  it("recognises the trigger's refusal by its SQLSTATE and tag, wherever the tag rides", () => {
    expect(isRecipeCycleError({ code: '23514', message: 'recipe_cycle' })).toBe(true)
    expect(isRecipeCycleError({ code: '23514', message: 'x', hint: 'recipe_cycle' })).toBe(true)
    expect(isRecipeCycleError({ code: '23514', message: 'new row violates check constraint "qty_positive"' })).toBe(false)
    expect(isRecipeCycleError({ code: '42501', message: 'recipe_cycle' })).toBe(false)
    expect(isRecipeCycleError(null)).toBe(false)
  })
})

describe('recipeCycleText', () => {
  it('names every dish in the loop, and the one to remove', () => {
    expect(recipeCycleText('Pasta Sauce', ['Tomato Base'])).toBe(
      '"Pasta Sauce" can\'t contain "Tomato Base": "Tomato Base" already contains "Pasta Sauce", so "Pasta Sauce" would be made from itself. Remove "Tomato Base" from its ingredients.')
    expect(recipeCycleText('Pasta Sauce', ['Tomato Base', 'Herb Oil'])).toBe(
      '"Pasta Sauce" can\'t contain "Tomato Base": "Tomato Base" contains "Herb Oil", which contains "Pasta Sauce", so "Pasta Sauce" would be made from itself. Remove "Tomato Base" from its ingredients.')
  })

  it('still refuses in a sentence when the chain could not be named', () => {
    expect(recipeCycleText('Pasta Sauce', null)).toMatch(/would end up containing itself/)
    expect(recipeCycleText('Pasta Sauce', ['Pasta Sauce'])).toBe('"Pasta Sauce" can\'t be one of its own ingredients.')
  })
})

describe('Recipes.js save', () => {
  const src = fs.readFileSync(path.join(__dirname, 'Recipes.js'), 'utf8')
  it('checks for a loop against the database, not the page\'s own recipe book', () => {
    expect(src).not.toMatch(/wouldCreateCycle/)
    expect(src).toMatch(/findCycleFromDb\(selectedRecipe\.id, newSubIds\)/)
    // …before the first write of the save, so a refusal changes nothing.
    expect(src.indexOf('findCycleFromDb(selectedRecipe.id, newSubIds)')).toBeLessThan(src.indexOf("scopedUpdate('recipes', payload)"))
  })
  it("words the database's own refusal rather than passing it to the generic table", () => {
    expect(src).toMatch(/isRecipeCycleError\(ingError\)/)
  })
})
