// S809 3m (FLOOR-KITCHEN-3, owner decision Q15 (1)): an empty bar list means no bar; only NULL is
// the Beverage default. Every reader of settings.pos_bot_categories goes through barCategoriesOf, so
// the till, Ticket Routing, Sales Report and the Settings rename cannot read the column two ways.
import fs from 'fs'
import path from 'path'
import { barCategoriesOf, DEFAULT_BAR_CATEGORIES, NO_BAR_TEXT } from './ticketRouting'

describe('barCategoriesOf', () => {
  test('a list that was never set is the Beverage default', () => {
    expect(barCategoriesOf(null)).toEqual(['Beverage'])
    expect(barCategoriesOf(undefined)).toEqual(['Beverage'])
  })
  test('an empty list is no bar, not the default', () => {
    expect(barCategoriesOf([])).toEqual([])
    expect(new Set(barCategoriesOf([])).has('Beverage')).toBe(false)
  })
  test('a saved list is used exactly as saved', () => {
    expect(barCategoriesOf(['Cocktails', 'Beer'])).toEqual(['Cocktails', 'Beer'])
    expect(barCategoriesOf(['Food'])).not.toContain('Beverage')
  })
  test('anything that is not a list falls back to the default rather than throwing', () => {
    expect(barCategoriesOf('Beverage')).toEqual(['Beverage'])
    expect(barCategoriesOf({})).toEqual(['Beverage'])
  })
  test('the default cannot be changed by a caller', () => {
    expect(Object.isFrozen(DEFAULT_BAR_CATEGORIES)).toBe(true)
  })
  test('the no-bar sentence is the owner-approved wording', () => {
    expect(NO_BAR_TEXT).toBe('No bar: every dish prints on the kitchen ticket.')
  })
})

describe('no reader takes an empty list for the default any more', () => {
  const src = rel => fs.readFileSync(path.join(__dirname, rel), 'utf8')
  const readers = {
    till: src('orders/PosOrders.jsx'),
    routing: src('tables/PosTableManagement.jsx'),
    salesReport: src('reports/SalesReport.jsx'),
    settings: src('../../pages/Settings.js'),
  }
  test.each(Object.keys(readers))('%s reads pos_bot_categories through barCategoriesOf', name => {
    const code = readers[name]
    expect(code).toMatch(/barCategoriesOf\(/)
    // The two shapes that read [] as ['Beverage']: `?.length ? … : ['Beverage']` and `length > 0`.
    expect(code).not.toMatch(/pos_bot_categories\?\.length/)
    expect(code).not.toMatch(/pos_bot_categories\.length > 0/)
    expect(code).not.toMatch(/arr\?\.length \? arr : \['Beverage'\]/)
  })
  test('the till hides its BOT button when nothing goes to the bar', () => {
    expect(readers.till).toMatch(/botCategories\.size > 0 && <div/)
  })
})
