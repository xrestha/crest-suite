// S756 (D20): the frozen Monthly Owner Report's dead-stock section must reach the live Dead Stock
// page's verdict through the SAME module — deadStockCalc.js — or a report frozen at close disagrees
// with the page it summarises, permanently. The source is read so a private copy of the rule cannot
// creep back, and a fixture pins the one case the old one-month rule got wrong: an item still for
// two months is Slow, not Dead.
import fs from 'fs'
import path from 'path'

jest.mock('../../supabaseClient', () => ({ supabase: { from: jest.fn(), rpc: jest.fn() } }))
jest.mock('../../shared/scopedDb', () => ({ scopedFrom: jest.fn() }))

// eslint-disable-next-line import/first
import { buildDeadStockSection, historyFor } from './computeInventoryDeadStock'

const src = fs.readFileSync(path.join(__dirname, 'computeInventoryDeadStock.js'), 'utf8')

describe('computeInventoryDeadStock source', () => {
  test('classifies through deadStockCalc.js and keeps no private copy of the rule', () => {
    expect(src).toMatch(/from '\.\.\/ims\/stockcount\/deadStockCalc'/)
    for (const fn of ['judgeItemPeriod', 'classifyItem', 'suggestNextStep']) expect(src).toContain(`${fn}(`)
    expect(src).not.toMatch(/SLOW_THRESHOLD\s*=/)
    expect(src).not.toMatch(/used\s*===\s*0\s*\?\s*'Dead'/)
  })

  test('every period-scoped read is paged and chunked, and a failed read throws', () => {
    for (const t of ['opening_stock', 'purchase_entries', 'wastages', 'staff_meals', 'closing_stock']) {
      expect(src).toMatch(new RegExp(`byMonth\\('${t}'`))
    }
    expect(src).toMatch(/fetchAllRowsChunked\(ids, c =>\s*\n?\s*supabase\.from\(table\)/)
    expect(src).toMatch(/fetchAllRowsChunked\(ids, c => scopedFrom\('vendor_returns'/)
    expect(src).toMatch(/fetchAllRows\(\(\) => scopedFrom\('items'/)
    expect(src).toContain('throwFirstError(results)')
  })
})

const P = (id, m) => ({ id, bs_year: 2082, bs_month: m, status: 'closed' })
const periods = [P('p1', 1), P('p2', 2), P('p3', 3)]
const items = ['A', 'B', 'C', 'D'].map(id => ({ id, name: `Item ${id}`, per_uom_rate: 100 }))
const open = (period_id, item_id, qty) => ({ period_id, item_id, qty })
const close = (period_id, item_id, physical_qty) => ({ period_id, item_id, physical_qty })

function build(overrides = {}) {
  return buildDeadStockSection({
    history: historyFor(periods, P('p3', 3)),
    items,
    openings: [
      open('p1', 'A', 20), open('p2', 'A', 10), open('p3', 'A', 10),   // moved, then still ×2
      open('p1', 'B', 5), open('p2', 'B', 5), open('p3', 'B', 5),      // still ×3
      open('p3', 'C', 8),                                              // not counted this month
      open('p1', 'D', 4), open('p2', 'D', 4), open('p3', 'D', 4),      // still, but p2 uncounted
    ],
    purchases: [], returns: [], wastages: [], staffMeals: [],
    closings: [
      close('p1', 'A', 10), close('p2', 'A', 10), close('p3', 'A', 10),
      close('p1', 'B', 5), close('p2', 'B', 5), close('p3', 'B', 5),
      close('p1', 'D', 4), close('p3', 'D', 4),
    ],
    vendors: [],
    asOf: new Date(2025, 6, 16),
    ...overrides,
  })
}

describe('buildDeadStockSection', () => {
  test('an item still for two counted months is Slow, not Dead', () => {
    const a = build().items.find(i => i.itemId === 'A')
    expect(a).toMatchObject({ status: 'Slow', stillMonths: 2, used: 0, valueAtRisk: 1000 })
  })

  test('three consecutive counted still months is Dead, with a next step', () => {
    const b = build().items.find(i => i.itemId === 'B')
    expect(b).toMatchObject({ status: 'Dead', stillMonths: 3, atLeast: true })
    expect(b.suggestion).toMatch(/special/)
  })

  test('an uncounted month breaks the streak rather than counting as still', () => {
    expect(build().items.find(i => i.itemId === 'D')).toMatchObject({ status: 'Slow', stillMonths: 1 })
  })

  test('the S717 states are counted, and the section says which rule it used', () => {
    const s = build()
    expect(s).toMatchObject({
      rule: 'streak', deadAfterMonths: 3, historyMonths: 3,
      assessedCount: 3, uncountedCount: 1, inconsistentCount: 0,
      deadCount: 1, slowCount: 2,
    })
    expect(s.items.find(i => i.itemId === 'C')).toBeUndefined()
  })

  test('a count of 0 is a count, and counted above available is inconsistent', () => {
    const s = build({
      openings: [open('p3', 'A', 5), open('p3', 'B', 2)],
      closings: [close('p3', 'A', 0), close('p3', 'B', 9)],
    })
    expect(s).toMatchObject({ assessedCount: 1, inconsistentCount: 1, deadCount: 0, slowCount: 0 })
  })
})

describe('historyFor', () => {
  test('ends at the report period and ignores later months, newest first', () => {
    const h = historyFor([...periods, P('p4', 4)], P('p2', 2))
    expect(h.map(p => p.id)).toEqual(['p2', 'p1'])
  })
})
