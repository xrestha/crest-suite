/**
 * The restore inserts a backup table by table, in RESTORE_ORDER, and abandons a table on its first
 * refused chunk. So a table placed before a parent its foreign keys name loses every row that names
 * that parent, and the restore went on to report success (S809 DATABASE-3): pos_parking_slips sat
 * before pos_orders (a slip names its bill) and pos_cash_movements before pos_credit_notes (a cash
 * refund names its note), so a restore dropped every linked parking slip, and once one refund existed,
 * every Cash In / Out of every shift. The order had been written as "the reverse of the delete
 * order", which only holds for NO ACTION keys; both of these are SET NULL.
 *
 * This reads every foreign key in supabase/migrations (migrationForeignKeys.js, checked against the
 * live catalog) and fails on a child placed before its parent, so the next key added to a restored
 * table fails here rather than in an operator's restore. It also holds the restore to the export:
 * every table a backup carries is restored or left out with a stated reason (DATABASE-6).
 */
import { foreignKeysFromMigrations, MIGRATIONS_DIR } from '../../../shared/migrationForeignKeys'
import {
  RESTORE_ORDER, RESTORE_LEFT_OUT, RESTORED_ELSEWHERE, DEFERRED_LINKS,
  isAttributionColumn, restoreCoverage, lostRowsLine,
} from './restoreClientData'
import { PERIOD_SCOPED_TABLES, PARENT_SCOPED_TABLES } from './exportClientData'
import { CLIENT_SCOPED_TABLES } from '../../../shared/scopedDb'

jest.mock('../../../supabaseClient', () => ({ supabase: {} }))

const fks = foreignKeysFromMigrations(MIGRATIONS_DIR)

describe('the migration reader', () => {
  it('finds the schema\'s foreign keys at all', () => {
    // Guards the parser: one that silently matched nothing would make every test below pass.
    expect(fks.length).toBeGreaterThanOrEqual(240)
    const has = (table, col, parent) => fks.some(f => f.table === table && f.cols.includes(col) && f.parent === parent)
    expect(has('pos_parking_slips', 'order_id', 'pos_orders')).toBe(true)
    expect(has('pos_cash_movements', 'pos_credit_note_id', 'pos_credit_notes')).toBe(true)
    // Declared inside a DO block (S737), the shape a plain statement scan misses.
    expect(has('closing_stock', 'counted_by', 'profiles')).toBe(true)
  })
})

describe('RESTORE_ORDER', () => {
  it('names each table once', () => {
    expect(new Set(RESTORE_ORDER).size).toBe(RESTORE_ORDER.length)
  })

  it('puts every table after each parent its foreign keys name', () => {
    const at = t => RESTORE_ORDER.indexOf(t)
    const late = fks
      .filter(f => at(f.table) >= 0 && at(f.parent) >= 0 && f.table !== f.parent)
      // Restored empty (attribution columns) or filled by a second pass (DEFERRED_LINKS).
      .filter(f => !f.cols.every(c => isAttributionColumn(c) || (DEFERRED_LINKS[f.table] || []).includes(c)))
      .filter(f => at(f.parent) > at(f.table))
      .map(f => `${f.table}.${f.cols.join(',')} -> ${f.parent}`)
    expect(late).toEqual([])
  })

  it('restores parking slips after the bills they name, and cash after its notes and shifts', () => {
    const at = t => RESTORE_ORDER.indexOf(t)
    expect(at('pos_parking_slips')).toBeGreaterThan(at('pos_orders'))
    expect(at('pos_cash_movements')).toBeGreaterThan(at('pos_credit_notes'))
    expect(at('pos_cash_movements')).toBeGreaterThan(at('pos_shifts'))
    expect(at('pos_credit_notes')).toBeGreaterThan(at('pos_orders'))
  })

  it('leaves out the live-only guest QR tables, with a reason, instead of reporting them failed', () => {
    for (const t of ['pos_guest_order_requests', 'pos_payment_confirmations']) {
      expect(RESTORE_ORDER).not.toContain(t)
      expect(typeof RESTORE_LEFT_OUT[t]).toBe('string')
    }
  })

  it('has a step, or a stated reason, for every table a backup carries', () => {
    const exported = [
      ...CLIENT_SCOPED_TABLES,
      ...PERIOD_SCOPED_TABLES,
      ...PARENT_SCOPED_TABLES.map(t => t.table),
      ...RESTORED_ELSEWHERE,
    ]
    const uncovered = exported.filter(t => !RESTORE_ORDER.includes(t) && !RESTORE_LEFT_OUT[t] && !RESTORED_ELSEWHERE.includes(t))
    expect(uncovered).toEqual([])
    // And nothing is both restored and left out.
    expect(Object.keys(RESTORE_LEFT_OUT).filter(t => RESTORE_ORDER.includes(t))).toEqual([])
  })
})

describe('restoreCoverage', () => {
  it('notes a left-out table with rows, and names a table no step restores', () => {
    const { leftOut, unknown } = restoreCoverage({
      pos_orders: [{ id: 1 }],
      pos_guest_order_requests: [{ id: 1 }, { id: 2 }],
      pos_payment_confirmations: [],
      profiles: [{ id: 'a' }],
      some_new_table: [{ id: 1 }, { id: 2 }, { id: 3 }],
    })
    expect(leftOut).toEqual([{ table: 'pos_guest_order_requests', rows: 2, why: RESTORE_LEFT_OUT.pos_guest_order_requests }])
    expect(unknown).toEqual([{ table: 'some_new_table', rows: 3 }])
  })

  it('is empty for a backup of restored tables only', () => {
    expect(restoreCoverage({ items: [{ id: 1 }], settings: [{ id: 1 }] })).toEqual({ leftOut: [], unknown: [] })
    expect(restoreCoverage(undefined)).toEqual({ leftOut: [], unknown: [] })
  })
})

describe('lostRowsLine', () => {
  it('says how many rows stayed behind, and why', () => {
    expect(lostRowsLine('pos_cash_movements', 6, 0, 'violates foreign key constraint'))
      .toBe('pos_cash_movements: 6 of 6 rows not restored (violates foreign key constraint)')
    expect(lostRowsLine('pos_order_items', 1200, 1000, 'x')).toBe('pos_order_items: 200 of 1,200 rows not restored (x)')
    expect(lostRowsLine('items', 1, 0, 'y')).toBe('items: 1 of 1 row not restored (y)')
  })
})
