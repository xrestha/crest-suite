// FLOOR-KITCHEN-8 (S817 4i): the page's copy of pos_tables_client_name_live_key.
import { tableNameKey, tableNameClash, quickSetupNames, quickSetupClashes, nextQuickSetupStart } from './tableNames'

const floor = [
  { id: 't1', name: 'Table 1', status: 'available' },
  { id: 't2', name: 'Table 2', status: 'occupied' },
  { id: 't3', name: 'Table 3', status: 'inactive' },
  { id: 'g1', name: 'Garden 1', status: 'reserved' },
  { id: 'b9', name: 'Table 9b', status: 'available' },
]

describe('tableNameKey', () => {
  it('ignores spaces at either end and capitals, as the index does', () => {
    expect(tableNameKey('  TABLE 1 ')).toBe('table 1')
    expect(tableNameKey(null)).toBe('')
  })
})

describe('tableNameClash', () => {
  it('finds a table in service with the same name, whatever its capitals and spaces', () => {
    expect(tableNameClash(' table 2', floor)?.id).toBe('t2')
    expect(tableNameClash('GARDEN 1', floor)?.id).toBe('g1')
  })

  it('leaves a retired table out, so its name can be used again', () => {
    expect(tableNameClash('Table 3', floor)).toBeNull()
  })

  it('does not count the table being edited against itself', () => {
    expect(tableNameClash('Table 1', floor, 't1')).toBeNull()
    expect(tableNameClash('Table 1', floor, 't2')?.id).toBe('t1')
  })

  it('finds nothing for an empty name', () => {
    expect(tableNameClash('  ', floor)).toBeNull()
  })
})

describe('Quick Setup', () => {
  it('names a batch from its prefix and start', () => {
    expect(quickSetupNames({ prefix: ' Table ', start: '4', count: '3' })).toEqual(['Table 4', 'Table 5', 'Table 6'])
    expect(quickSetupNames({ prefix: 'Table', start: '', count: '0' })).toEqual([])
  })

  it('names every clash in the batch, and none for a retired table', () => {
    expect(quickSetupClashes(quickSetupNames({ prefix: 'Table', start: 1, count: 5 }), floor)).toEqual(['Table 1', 'Table 2'])
  })

  it('starts one past the highest number already used with the prefix, retired tables included', () => {
    expect(nextQuickSetupStart('Table', floor)).toBe(4)
    expect(nextQuickSetupStart('table', floor)).toBe(4)
    expect(nextQuickSetupStart('Garden', floor)).toBe(2)
    expect(nextQuickSetupStart('Patio', floor)).toBe(1)
    expect(nextQuickSetupStart('', floor)).toBe(1)
  })

  it('ignores a name that only starts with the prefix', () => {
    expect(nextQuickSetupStart('Tab', floor)).toBe(1)
    expect(nextQuickSetupStart('Table 9', [{ name: 'Table 9b' }])).toBe(1)
  })
})
