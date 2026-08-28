import { evaluate, looksLikeExpression } from './evalMath'

// looksLikeExpression must recognise EVERYTHING tokenize() normalises — when it lagged
// (no ASCII x/X, no comma), "12x4" and "1,200" skipped evaluation and reached callers as
// raw strings whose parseFloat read a prefix (12 and 1) — a silently wrong rate (S623).
test('looksLikeExpression covers every operator spelling tokenize accepts', () => {
  expect(looksLikeExpression('12*4')).toBe(true)
  expect(looksLikeExpression('12x4')).toBe(true)
  expect(looksLikeExpression('12X4')).toBe(true)
  expect(looksLikeExpression('12×4')).toBe(true)
  expect(looksLikeExpression('24÷2')).toBe(true)
  expect(looksLikeExpression('1,200')).toBe(true)
  expect(looksLikeExpression('(12+8)')).toBe(true)
  expect(looksLikeExpression('5-2')).toBe(true)
})

test('a plain number or leading minus is NOT an expression', () => {
  expect(looksLikeExpression('146')).toBe(false)
  expect(looksLikeExpression('388.50')).toBe(false)
  expect(looksLikeExpression('-5')).toBe(false)
  expect(looksLikeExpression('')).toBe(false)
})

test('evaluate normalises commas and ascii multiplication', () => {
  expect(evaluate('1,200')).toBe(1200)
  expect(evaluate('12x4')).toBe(48)
  expect(evaluate('12X4')).toBe(48)
  expect(evaluate('1,200/16')).toBe(75)
  expect(evaluate('3*24+7')).toBe(79)
})

test('evaluate refuses garbage, division by zero and partial readings', () => {
  expect(evaluate('5oo')).toBe(null)
  expect(evaluate('3*')).toBe(null)
  expect(evaluate('2+(4')).toBe(null)
  expect(evaluate('5/0')).toBe(null)
  expect(evaluate('5 5')).toBe(null)
})
