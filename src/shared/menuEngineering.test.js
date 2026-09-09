import { classify, median, menuFcPct, unratedReason, FC_CUTOFF } from './menuEngineering'

describe('menuFcPct', () => {
  test('is null when the dish has no selling price', () => {
    expect(menuFcPct(120, 0)).toBeNull()
    expect(menuFcPct(120, null)).toBeNull()
  })

  test('is null when the dish has no costed ingredients', () => {
    // The bug this file exists for: `120 cost / 400 price` is a ratio, `0 / 400` is not — it is
    // "we have not costed this dish" wearing the most flattering number on the scale.
    expect(menuFcPct(0, 400)).toBeNull()
  })

  test('is the real ratio when both are present', () => {
    expect(menuFcPct(140, 400)).toBeCloseTo(35)
    expect(menuFcPct(500, 400)).toBeCloseTo(125) // a genuine loss-maker is rated, not hidden
  })
})

describe('classify', () => {
  test('an unrated dish gets no quadrant rather than the best one', () => {
    // Before S715 this returned 'Star': fcPct was forced to 0, 0 <= 35, and a busy uncosted dish
    // came back "Keep on menu. Feature prominently."
    expect(classify(null, 50, 10)).toBeNull()
    expect(classify(undefined, 50, 10)).toBeNull()
    expect(classify(Infinity, 50, 10)).toBeNull()
  })

  test('a dish that sold nothing is never high popularity, even when the median is 0', () => {
    // On a menu where under half the items sell, median() is 0 and `0 >= 0` made every unsold
    // dish popular — Plowhorse and Dog were unreachable for the whole period.
    expect(classify(20, 0, 0)).toBe('Plowhorse')
    expect(classify(50, 0, 0)).toBe('Dog')
  })

  test('a dish that did sell keeps the quadrant it had before', () => {
    expect(classify(20, 30, 10)).toBe('Star')
    expect(classify(20, 5, 10)).toBe('Plowhorse')
    expect(classify(50, 30, 10)).toBe('Puzzle')
    expect(classify(50, 5, 10)).toBe('Dog')
  })

  test('the cutoff is inclusive on the profitable side', () => {
    expect(classify(FC_CUTOFF, 30, 10)).toBe('Star')
    expect(classify(FC_CUTOFF + 0.1, 30, 10)).toBe('Puzzle')
  })

  test('sitting exactly on the median counts as popular', () => {
    expect(classify(20, 10, 10)).toBe('Star')
  })
})

describe('median', () => {
  test('spans every recipe passed, zero-sale ones included', () => {
    expect(median([0, 0, 0, 8])).toBe(0)
    expect(median([1, 2, 3])).toBe(2)
    expect(median([1, 2, 3, 4])).toBe(2.5)
    expect(median([])).toBe(0)
  })

  test('does not mutate its input', () => {
    const qtys = [5, 1, 3]
    median(qtys)
    expect(qtys).toEqual([5, 1, 3])
  })
})

describe('unratedReason', () => {
  test('names which half is missing, so the row has a next step', () => {
    expect(unratedReason(0, 0)).toMatch(/price and no costed/)
    expect(unratedReason(120, 0)).toMatch(/No selling price/)
    expect(unratedReason(0, 400)).toMatch(/No costed ingredients/)
    expect(unratedReason(120, 400)).toBeNull()
  })
})
