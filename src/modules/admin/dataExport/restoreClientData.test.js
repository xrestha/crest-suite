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
import fs from 'fs'
import path from 'path'
import {
  RESTORE_ORDER, RESTORE_LEFT_OUT, RESTORED_ELSEWHERE, DEFERRED_LINKS, GENERATED_COLUMNS,
  isAttributionColumn, restoreCoverage, lostRowsLine, partBillsAfterParents,
  transferHeadersForRestore, transferLinesForRestore, clientRowRestorePlan, CLIENT_IDENTITY_COLUMNS,
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
    // S836: inline in a CREATE TABLE IF NOT EXISTS, and an ADD COLUMN IF NOT EXISTS self-reference.
    expect(has('pos_table_joins', 'table_id', 'pos_tables')).toBe(true)
    expect(has('pos_table_joins', 'order_id', 'pos_orders')).toBe(true)
    expect(has('pos_table_moves', 'to_order_id', 'pos_orders')).toBe(true)
    expect(has('pos_orders', 'part_of_order_id', 'pos_orders')).toBe(true)
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

  it('restores payment receipts after their shifts and bills, their lines after them, and cash after both (S843)', () => {
    const at = t => RESTORE_ORDER.indexOf(t)
    // The migration reader sees the new keys, or the ordering test above passes vacuously for them.
    const has = (table, col, parent) => fks.some(f => f.table === table && f.cols.includes(col) && f.parent === parent)
    expect(has('pos_credit_receipts', 'shift_id', 'pos_shifts')).toBe(true)
    expect(has('pos_credit_receipt_lines', 'receipt_id', 'pos_credit_receipts')).toBe(true)
    expect(has('pos_credit_receipt_lines', 'order_id', 'pos_orders')).toBe(true)
    expect(has('pos_cash_movements', 'credit_receipt_id', 'pos_credit_receipts')).toBe(true)
    expect(at('pos_credit_receipts')).toBeGreaterThan(at('pos_shifts'))
    expect(at('pos_credit_receipts')).toBeGreaterThan(at('pos_orders'))
    expect(at('pos_credit_receipt_lines')).toBeGreaterThan(at('pos_credit_receipts'))
    expect(at('pos_cash_movements')).toBeGreaterThan(at('pos_credit_receipts'))
    // Membership types before the customers who hold one.
    expect(at('pos_membership_types')).toBeGreaterThanOrEqual(0)
    expect(at('pos_membership_types')).toBeLessThan(at('pos_customers'))
    // Who took or cancelled a payment is attribution: restored empty, the name kept in the file.
    expect(isAttributionColumn('received_by')).toBe(true)
    expect(isAttributionColumn('cancelled_by')).toBe(true)
  })

  it('restores the joined tables and the record of moves after the tables and bills they name (S836)', () => {
    const at = t => RESTORE_ORDER.indexOf(t)
    for (const t of ['pos_table_joins', 'pos_table_moves']) {
      expect(at(t)).toBeGreaterThan(at('pos_orders'))
      expect(at(t)).toBeGreaterThan(at('pos_tables'))
    }
    // Who joined or moved is attribution: restored empty, the name kept in the file.
    expect(isAttributionColumn('joined_by')).toBe(true)
    expect(isAttributionColumn('moved_by')).toBe(true)
    // A part bill's link goes in with its row (partBillsAfterParents), never by a second pass the
    // bill guards would refuse.
    expect(DEFERRED_LINKS.pos_orders).not.toContain('part_of_order_id')
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

describe('partBillsAfterParents', () => {
  it('puts every part bill after the bill it was split off, keeping the order otherwise', () => {
    const rows = [
      { id: 'p1', part_of_order_id: 'b2' },
      { id: 'b1', part_of_order_id: null },
      { id: 'p2', part_of_order_id: 'b1' },
      { id: 'b2' },
    ]
    expect(partBillsAfterParents(rows).map(r => r.id)).toEqual(['b1', 'b2', 'p1', 'p2'])
  })

  it('empties a link to a bill the backup does not hold, as the key would have, and keeps the row', () => {
    const out = partBillsAfterParents([{ id: 'p1', part_of_order_id: 'gone', total: 5 }, { id: 'b1' }])
    expect(out).toEqual([{ id: 'p1', part_of_order_id: null, total: 5 }, { id: 'b1' }])
  })

  it('leaves a backup with no part bills as it was', () => {
    const rows = [{ id: 'a' }, { id: 'b', part_of_order_id: null }]
    expect(partBillsAfterParents(rows)).toEqual(rows)
    expect(partBillsAfterParents([])).toEqual([])
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

// S849 ASSETS-3: Postgres refuses a generated column in an INSERT, so a restored table carrying one
// that GENERATED_COLUMNS does not name loses every row. Read every migration for them.
function generatedColumnsFromMigrations(dir) {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
  const cols = new Map() // "table.column" -> true
  for (const f of files) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8').replace(/--[^\n]*/g, '')
    // Walk statements in order so a later DROP undoes an earlier definition (last definition wins).
    let table = null
    const re = /(CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?(\w+)"?)|(ALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?(?:public\.)?"?(\w+)"?)|(DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?"?(\w+)"?)|(DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:public\.)?"?(\w+)"?)|((?:ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?)?"?(\w+)"?\s+[\w ()]+?\s+GENERATED\s+ALWAYS\s+AS\s*\()/gi
    let m
    while ((m = re.exec(sql))) {
      if (m[2]) table = m[2]
      else if (m[4]) table = m[4]
      else if (m[6] && table) cols.delete(`${table}.${m[6]}`)
      else if (m[8]) { for (const k of [...cols.keys()]) if (k.startsWith(`${m[8]}.`)) cols.delete(k) }
      else if (m[10] && table) cols.set(`${table}.${m[10]}`, true)
    }
  }
  return [...cols.keys()]
}

describe('GENERATED_COLUMNS', () => {
  const found = generatedColumnsFromMigrations(MIGRATIONS_DIR)

  it('the migration reader finds the generated columns at all', () => {
    expect(found).toEqual(expect.arrayContaining(['items.per_uom_rate', 'pos_customers.phone_canonical', 'assets_register.total_cost']))
  })

  it('names every generated column of every restored table', () => {
    const missing = found
      .map(k => k.split('.'))
      .filter(([table]) => RESTORE_ORDER.includes(table))
      .filter(([table, col]) => !(GENERATED_COLUMNS[table] || []).includes(col))
      .map(([table, col]) => `${table}.${col}`)
    expect(missing).toEqual([])
  })
})

describe('S849 tables in the restore', () => {
  const at = t => RESTORE_ORDER.indexOf(t)
  it('restores stock transfers after items and months, headers before lines', () => {
    expect(at('ims_stock_transfers')).toBeGreaterThan(at('items'))
    expect(at('ims_stock_transfers')).toBeGreaterThan(at('monthly_periods'))
    expect(at('ims_stock_transfer_lines')).toBeGreaterThan(at('ims_stock_transfers'))
  })
  it('restores tax pool opening corrections right after the openings', () => {
    expect(at('assets_tax_pool_opening_corrections')).toBe(at('assets_tax_pool_openings') + 1)
  })
})

describe('transferHeadersForRestore', () => {
  const header = over => ({ id: 't1', to_client_id: 'b', sent_period_id: 'p1', ended_period_id: null, status: 'on_the_way', ...over })

  it('empties a receiver that no longer exists, keeping the row', () => {
    const { rows, dropped } = transferHeadersForRestore([header()], ['c'], ['p1'])
    expect(dropped).toBe(0)
    expect(rows).toEqual([header({ to_client_id: null })])
  })

  it("empties a received transfer's ending month (the receiver's), keeps a cancelled one's own month", () => {
    const { rows } = transferHeadersForRestore([
      header({ id: 'r', status: 'received', ended_period_id: 'their-month' }),
      header({ id: 'c', status: 'cancelled', ended_period_id: 'p2' }),
    ], ['b'], ['p1', 'p2'])
    expect(rows.find(r => r.id === 'r').ended_period_id).toBeNull()
    expect(rows.find(r => r.id === 'c').ended_period_id).toBe('p2')
    expect(rows.every(r => r.to_client_id === 'b')).toBe(true)
  })

  it('leaves out and counts a header whose sending month is not in the backup', () => {
    const { rows, dropped } = transferHeadersForRestore([header(), header({ id: 't2', sent_period_id: 'elsewhere' })], ['b'], ['p1'])
    expect(rows.map(r => r.id)).toEqual(['t1'])
    expect(dropped).toBe(1)
  })
})

describe('transferLinesForRestore', () => {
  it("empties the link to a header the restore does not hold (a received line's), keeping the line", () => {
    const lines = [
      { id: 'l1', transfer_id: 't1', period_id: 'p1', leg: 'sent' },
      { id: 'l2', transfer_id: 'senders', period_id: 'p1', leg: 'received' },
    ]
    const { rows, dropped } = transferLinesForRestore(lines, ['t1'], ['p1'])
    expect(dropped).toBe(0)
    expect(rows).toEqual([lines[0], { ...lines[1], transfer_id: null }])
  })

  it('leaves out and counts a line whose month the backup does not hold', () => {
    const { rows, dropped } = transferLinesForRestore([{ id: 'l1', transfer_id: null, period_id: 'gone' }], [], ['p1'])
    expect(rows).toEqual([])
    expect(dropped).toBe(1)
  })
})

describe('clientRowRestorePlan (S849 DATABASE-7)', () => {
  const exported = {
    id: 'old', name: 'BLOOM CAFE', created_at: '2026-01-01', last_backup_at: '2026-10-01', trial_purge_at: null,
    location: 'Thamel', contact_person: 'Asha', contact_phone: '98', legal_name: 'Bloom Pvt Ltd', pan_no: '123',
    registered_address: 'KTM', signatory_name: 'Asha', signatory_title: 'Director',
    plan: 'growth', billing_cycle: 'annual', ims_enabled: true, ims_ends_at: '2027-06-30',
    hr_enabled: true, hr_ends_at: '2027-06-30', pos_enabled: true, pos_ends_at: null,
    customization_enabled: true, customization_ends_at: '2027-01-01',
    suite_plan: 'pro', suite_ends_at: '2027-07-15', is_internal: true, group_id: 'g1',
  }
  const fresh = { id: 'new', location: '', contact_person: null, pan_no: '999', plan: 'starter', ims_enabled: true }

  it('fills blank identity details only, never overwriting one', () => {
    const { fill } = clientRowRestorePlan(exported, fresh)
    expect(fill.location).toBe('Thamel')
    expect(fill.contact_person).toBe('Asha')
    expect(fill.pan_no).toBeUndefined()
    expect(Object.keys(fill).every(k => CLIENT_IDENTITY_COLUMNS.includes(k))).toBe(true)
  })

  it('names every commercial and structural value it did not restore, the group by name', () => {
    const { notes } = clientRowRestorePlan(exported, fresh, { groupName: 'Bloom Cafe Group' })
    expect(notes).toMatch(/^Not restored, re-enter in Billing/)
    for (const word of ['IMS Growth', 'annual billing', 'HR on', 'POS on', 'Customization on', 'Crest Suite Pro', 'Demo outlet', "outlet group 'Bloom Cafe Group'"]) {
      expect(notes).toContain(word)
    }
  })

  it('never carries ids, stamps or the backup date', () => {
    const { fill, notes } = clientRowRestorePlan(exported, fresh)
    for (const k of ['id', 'created_at', 'last_backup_at', 'trial_purge_at', 'name']) expect(fill[k]).toBeUndefined()
    expect(notes).not.toMatch(/last_backup|created_at/)
  })

  it('says nothing when the target already matches, and names a group that is gone', () => {
    const same = { ...exported, id: 'new' }
    expect(clientRowRestorePlan(exported, same).notes).toBeNull()
    expect(clientRowRestorePlan({ group_id: 'g' }, {}).notes).toMatch(/an outlet group that no longer exists/)
  })
})
