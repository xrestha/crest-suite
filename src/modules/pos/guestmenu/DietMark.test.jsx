// The food mark (S846): each diet draws a different SHAPE inside the square, so the mark reads without
// its colour, and one read rule turns a recipe's two columns into a diet.
import { render, screen } from '@testing-library/react'
import DietMark, { DietLabel, dietOfDish, DIET_WORDS } from './DietMark'

/* eslint-disable testing-library/no-node-access, testing-library/no-container */
const shapeOf = container => container.querySelector('svg [data-shape]')

describe('DietMark', () => {
  it('draws a dot for veg, a triangle for non-veg and an E for egg, each with its name', () => {
    // Render one mark, check its name, and hand back the shape inside its square.
    const drawn = (diet, name) => {
      const { container, unmount } = render(<DietMark diet={diet} />)
      expect(screen.getByRole('img', { name })).toBeTruthy()
      const shape = shapeOf(container)
      const hasText = !!container.querySelector('text')
      unmount()
      return { tag: shape.tagName.toLowerCase(), kind: shape.getAttribute('data-shape'), d: shape.getAttribute('d'), hasText }
    }
    const dot = drawn('veg', 'Vegetarian')
    const triangle = drawn('non_veg', 'Non-vegetarian')
    const letter = drawn('egg', 'Contains egg')
    expect([dot.tag, dot.kind]).toEqual(['circle', 'dot'])
    expect([triangle.tag, triangle.kind]).toEqual(['path', 'triangle'])
    expect([letter.tag, letter.kind]).toEqual(['path', 'egg'])
    // A drawn E, not a font glyph: no <text> in the mark, and not the triangle's outline.
    expect(letter.hasText).toBe(false)
    expect(letter.d).not.toBe(triangle.d)
  })

  it('keeps its outlined square and carries the short word as its title', () => {
    const { container } = render(<DietMark diet="egg" />)
    const rect = container.querySelector('svg rect')
    expect(rect.getAttribute('fill')).toBe('none')
    expect(rect.getAttribute('stroke')).toBe('currentColor')
    expect(screen.getByRole('img', { name: 'Contains egg' }).getAttribute('title')).toBe('Egg')
    expect(screen.getByRole('img', { name: 'Contains egg' }).className).toContain('diet-mark--egg')
  })

  it('draws nothing for an unknown or unstated diet', () => {
    const { container } = render(<><DietMark diet={null} /><DietMark diet="vegan" /></>)
    expect(container.innerHTML).toBe('')
  })

  it('a decorative mark has no name of its own, and DietLabel prints the word beside it', () => {
    render(<><DietLabel diet="non_veg" /><DietLabel diet="egg" long /></>)
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByText('Non-veg')).toBeTruthy()
    expect(screen.getByText('Contains egg')).toBeTruthy()
  })

  it('names the short and long words for every kind', () => {
    expect(DIET_WORDS).toEqual({
      veg: { short: 'Veg', long: 'Vegetarian' },
      egg: { short: 'Egg', long: 'Contains egg' },
      non_veg: { short: 'Non-veg', long: 'Non-vegetarian' },
    })
  })
})

describe('dietOfDish', () => {
  it.each([
    [true, false, 'veg'],
    [true, true, 'veg'], // is_veg wins: a veg dish is veg whatever is_egg says
    [true, undefined, 'veg'],
    [false, true, 'egg'],
    [false, false, 'non_veg'],
    [false, undefined, 'non_veg'], // a database without is_egg yet
    [false, null, 'non_veg'],
    [null, true, null], // nothing stated: egg alone is not a diet
    [null, false, null],
    [undefined, undefined, null],
  ])('(is_veg %p, is_egg %p) is %p', (isVeg, isEgg, diet) => {
    expect(dietOfDish(isVeg, isEgg)).toBe(diet)
  })
})
