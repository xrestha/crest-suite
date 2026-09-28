import { isCostedByBuild, BYO_STATUS, BYO_REASON } from './buildYourOwnRating'

// S792 RECIPES-1: which dishes the menu reports show as "Not rated — costed by build".
describe('isCostedByBuild', () => {
  const bowl = { id: 'acai', category: 'Food', is_build_your_own: true }

  it('is true for a marked dish while Crest Customization is on', () => {
    expect(isCostedByBuild(bowl, true)).toBe(true)
  })

  it('follows Recipe Costing: with the module off the dish is costed like any other', () => {
    expect(isCostedByBuild(bowl, false)).toBe(false)
    expect(isCostedByBuild(bowl, undefined)).toBe(false)
  })

  it('is false for an unmarked dish, a missing mark and a sub-recipe', () => {
    expect(isCostedByBuild({ ...bowl, is_build_your_own: false }, true)).toBe(false)
    expect(isCostedByBuild({ id: 'momo', category: 'Food' }, true)).toBe(false)
    expect(isCostedByBuild({ ...bowl, category: 'Sub-Recipe' }, true)).toBe(false)
    expect(isCostedByBuild(null, true)).toBe(false)
  })

  it('names the state the precedent settled, and where the real cost is', () => {
    expect(BYO_STATUS).toBe('Not rated — costed by build')
    expect(BYO_REASON).toMatch(/Recipe Costing/)
  })
})
