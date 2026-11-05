import {
  categoryNameProblem, categoryLock, isProtectedCategory, isHeadOfficeCopy, removeTargets, itemCountsByCategory,
  removeNeedsTarget, removeConsequence, mergeResultText, nextSortOrder, cleanCategoryName,
  HEAD_OFFICE_REASON, PROTECTED_REASON, REMOVE_RANK_REASON,
} from './categoryManage'

const cats = [
  { id: 'c1', name: 'Dairy', sort_order: 0 },
  { id: 'c2', name: 'Groceries', sort_order: 3 },
  { id: 'c3', name: 'Beverage', sort_order: 1, master_id: 'hq-c3' },
]

describe('categoryNameProblem', () => {
  test('blank, too long and a clash in any capitals or spacing are refused', () => {
    expect(categoryNameProblem('   ', cats)).toMatch(/Type a name/)
    expect(categoryNameProblem('x'.repeat(61), cats)).toMatch(/60 characters/)
    expect(categoryNameProblem('Dairy', cats)).toBe('There is already a category called "Dairy".')
    expect(categoryNameProblem('  DAIRY ', cats)).toMatch(/differs only in capitals or spaces/)
  })

  test('Sub-Recipes cannot be taken, in any spelling', () => {
    expect(categoryNameProblem('Sub-Recipes', cats)).toMatch(/Recipe Costing files sub-recipes/)
    expect(categoryNameProblem('sub-recipes', cats)).toMatch(/Recipe Costing files sub-recipes/)
  })

  test('a rename may keep its own name in new capitals', () => {
    expect(categoryNameProblem('DAIRY', cats, { exceptId: 'c1' })).toBeNull()
    expect(categoryNameProblem('Groceries', cats, { exceptId: 'c1' })).toMatch(/already a category/)
    expect(categoryNameProblem('Spices', cats)).toBeNull()
  })

  test('cleanCategoryName joins spaces', () => {
    expect(cleanCategoryName('  Frozen   Food ')).toBe('Frozen Food')
  })
})

describe('categoryLock: who may rename and remove what', () => {
  test('a supervisor renames but may not remove; the Owner or a manager may do both', () => {
    expect(categoryLock(cats[0], { canRemove: false })).toEqual({ rename: null, remove: REMOVE_RANK_REASON })
    expect(categoryLock(cats[0], { canRemove: true })).toEqual({ rename: null, remove: null })
  })

  test('Sub-Recipes is never renamed or removed, by anyone, in any spelling', () => {
    expect(isProtectedCategory({ name: 'Sub-Recipes' })).toBe(true)
    expect(isProtectedCategory({ name: ' sub-recipes ' })).toBe(true)
    expect(isProtectedCategory({ name: 'Sub Recipes' })).toBe(false)
    expect(categoryLock({ id: 's', name: 'Sub-Recipes' }, { canRemove: true })).toEqual({ rename: PROTECTED_REASON, remove: PROTECTED_REASON })
  })

  test('a head-office copy is locked at a branch, and only while the outlet is in a group', () => {
    expect(isHeadOfficeCopy(cats[2], true)).toBe(true)
    expect(categoryLock(cats[2], { inGroup: true, canRemove: true })).toEqual({ rename: HEAD_OFFICE_REASON, remove: HEAD_OFFICE_REASON })
    expect(isHeadOfficeCopy(cats[2], false)).toBe(false)
    expect(categoryLock(cats[2], { inGroup: false, canRemove: true })).toEqual({ rename: null, remove: null })
    expect(isHeadOfficeCopy(cats[0], true)).toBe(false)
  })
})

describe('removing', () => {
  test('targets are every other category, never Sub-Recipes', () => {
    const all = [...cats, { id: 'sr', name: 'Sub-Recipes' }]
    expect(removeTargets(all, cats[0]).map(c => c.id)).toEqual(['c2', 'c3'])
  })

  test('counts come from the item book, hidden items included', () => {
    const counts = itemCountsByCategory([
      { category_id: 'c1', is_active: true }, { category_id: 'c1', is_active: false }, { category_id: null }, { category_id: 'c2' },
    ])
    expect(counts).toEqual({ c1: { all: 2, hidden: 1 }, c2: { all: 1, hidden: 0 } })
  })

  test('a target is needed exactly when there are items or budgets', () => {
    expect(removeNeedsTarget({ items: 0, budgets: 0 })).toBe(false)
    expect(removeNeedsTarget({ items: 0, budgets: 2 })).toBe(true)
    expect(removeNeedsTarget({ items: 3, budgets: 0 })).toBe(true)
  })

  test('the consequence names the counts, the merge of budgets and that it cannot be undone', () => {
    const text = removeConsequence({ from: cats[0], to: cats[1], items: 12, hidden: 2, budgets: 3 })
    expect(text).toMatch(/^12 items \(2 of them hidden\) and 3 monthly budgets \(in a month where "Groceries" already has a budget, the two amounts are added together\) move from "Dairy" to "Groceries"/)
    expect(text).toMatch(/assigned to "Groceries" instead/)
    expect(text).toMatch(/This cannot be undone\.$/)
    expect(removeConsequence({ from: cats[0], items: 0, budgets: 0 })).toMatch(/holds no items and no monthly budgets, so it is simply removed/)
  })

  test('the result notice reads the counts the function returned', () => {
    expect(mergeResultText('Dairy', 'Groceries', { items_moved: 12, budgets_merged: 1, budgets_moved: 2, assignments_moved: 0 }))
      .toBe('Removed "Dairy": 12 items moved, 1 monthly budget added to the ones already there, 2 monthly budgets moved to "Groceries".')
    expect(mergeResultText('Empty', undefined, { items_moved: 0 })).toBe('Removed "Empty".')
  })

  test('a new category sorts after the rest', () => {
    expect(nextSortOrder(cats)).toBe(4)
    expect(nextSortOrder([{ name: 'Sub-Recipes', sort_order: 999 }])).toBe(0)
    expect(nextSortOrder([])).toBe(0)
  })
})
