jest.mock('../supabaseClient', () => ({
  supabase: {
    from: jest.fn(),
    __chain: {
      select: jest.fn(), eq: jest.fn(), order: jest.fn(),
      insert: jest.fn(), update: jest.fn(), delete: jest.fn(), upsert: jest.fn(),
    },
  },
}))

import { supabase } from '../supabaseClient'
import { scopedFrom, scopedInsert, scopedUpsert, scopedUpdate, scopedDelete, CLIENT_SCOPED_TABLES } from './scopedDb'

const chain = supabase.__chain
const NO_CLIENT_SENTINEL = '00000000-0000-0000-0000-000000000000'

// react-scripts' Jest preset runs with resetMocks: true, which wipes mockReturnValue
// between tests — so the chain has to be re-wired here rather than once in the factory.
beforeEach(() => {
  jest.clearAllMocks()
  Object.values(chain).forEach(fn => fn.mockReturnValue(chain))
  supabase.from.mockReturnValue(chain)
})

describe('table allowlist', () => {
  test('refuses to operate on a table outside CLIENT_SCOPED_TABLES', () => {
    expect(() => scopedFrom('purchase_entries', 'client-1')).toThrow(/not in CLIENT_SCOPED_TABLES/)
  })

  test('items, vendors, and categories are in the allowlist (used by the migrated pages)', () => {
    expect(CLIENT_SCOPED_TABLES).toEqual(expect.arrayContaining(['items', 'vendors', 'categories']))
  })
})

describe('scopedFrom', () => {
  test('filters the select to the given clientId', () => {
    scopedFrom('items', 'client-1')
    expect(supabase.from).toHaveBeenCalledWith('items')
    expect(chain.select).toHaveBeenCalledWith('*')
    expect(chain.eq).toHaveBeenCalledWith('client_id', 'client-1')
  })

  test('accepts a custom column list', () => {
    scopedFrom('items', 'client-1', 'id, name')
    expect(chain.select).toHaveBeenCalledWith('id, name')
  })

  test('fails closed to a sentinel that matches no real row when clientId is missing', () => {
    scopedFrom('items', null)
    expect(chain.eq).toHaveBeenCalledWith('client_id', NO_CLIENT_SENTINEL)
  })
})

describe('scopedInsert', () => {
  test('stamps client_id onto the row and inserts', async () => {
    await scopedInsert('vendors', 'client-1', { name: 'Big Mart' })
    expect(supabase.from).toHaveBeenCalledWith('vendors')
    expect(chain.insert).toHaveBeenCalledWith({ name: 'Big Mart', client_id: 'client-1' })
  })

  test('stamps client_id onto every row of a bulk insert', async () => {
    await scopedInsert('categories', 'client-1', [{ name: 'A' }, { name: 'B' }])
    expect(chain.insert).toHaveBeenCalledWith([
      { name: 'A', client_id: 'client-1' },
      { name: 'B', client_id: 'client-1' },
    ])
  })

  test('refuses to insert without a clientId — never touches supabase at all', async () => {
    const result = await scopedInsert('vendors', null, { name: 'Big Mart' })
    expect(supabase.from).not.toHaveBeenCalled()
    expect(result.data).toBeNull()
    expect(result.error.message).toMatch(/No client selected/)
  })
})

describe('scopedUpsert', () => {
  test('stamps client_id and forwards upsert options', async () => {
    await scopedUpsert('categories', 'client-1', [{ name: 'Dairy' }], { onConflict: 'client_id,name' })
    expect(chain.upsert).toHaveBeenCalledWith(
      [{ name: 'Dairy', client_id: 'client-1' }],
      { onConflict: 'client_id,name' }
    )
  })

  test('refuses to upsert without a clientId', async () => {
    const result = await scopedUpsert('categories', null, [{ name: 'Dairy' }])
    expect(supabase.from).not.toHaveBeenCalled()
    expect(result.error.message).toMatch(/No client selected/)
  })
})

describe('scopedUpdate', () => {
  test('scopes the update to the given clientId', () => {
    scopedUpdate('items', 'client-1', { is_active: false })
    expect(chain.update).toHaveBeenCalledWith({ is_active: false })
    expect(chain.eq).toHaveBeenCalledWith('client_id', 'client-1')
  })

  test('fails closed when clientId is missing, instead of updating every client\'s rows', () => {
    scopedUpdate('items', null, { is_active: false })
    expect(chain.eq).toHaveBeenCalledWith('client_id', NO_CLIENT_SENTINEL)
  })
})

describe('scopedDelete', () => {
  test('scopes the delete to the given clientId', () => {
    scopedDelete('vendors', 'client-1')
    expect(chain.delete).toHaveBeenCalled()
    expect(chain.eq).toHaveBeenCalledWith('client_id', 'client-1')
  })

  test('fails closed when clientId is missing, instead of deleting every client\'s rows', () => {
    scopedDelete('vendors', null)
    expect(chain.eq).toHaveBeenCalledWith('client_id', NO_CLIENT_SENTINEL)
  })
})
