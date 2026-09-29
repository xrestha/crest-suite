import { afterCategorySaved } from './AssetCategoryModal'

// AssetCategoryModal imports useScopedDb, which imports the real supabaseClient — mock it so this
// test exercises only the pure helper. jest.mock is hoisted above the import by babel-jest.
jest.mock('../../../supabaseClient', () => ({ supabase: { from: jest.fn(), rpc: jest.fn(), auth: {} } }))

// S792 (COSTS-13): a retry after a later row fails must not insert the earlier rows again.
describe('afterCategorySaved', () => {
  const kitchen = { _key: 'new-1', id: null, name: 'Kitchen', default_useful_life_years: '5', tax_pool_hint: 'D', _dirty: true }
  const furniture = { _key: 'new-2', id: null, name: 'Furniture', default_useful_life_years: '7', tax_pool_hint: '', _dirty: true }

  test('an inserted row keeps its new id and is no longer waiting to be saved', () => {
    const rows = afterCategorySaved([kitchen, furniture], kitchen, 'cat-1')
    expect(rows[0]).toEqual({ ...kitchen, id: 'cat-1', _dirty: false })
    expect(rows[1]).toBe(furniture)
    // What the next Save sends: only the row that did not land, and nothing as a second insert.
    expect(rows.filter(r => r._dirty).map(r => r._key)).toEqual(['new-2'])
  })

  test('an updated row keeps its id', () => {
    const saved = { ...kitchen, _key: 'cat-9', id: 'cat-9' }
    expect(afterCategorySaved([saved], saved, undefined)[0]).toMatchObject({ id: 'cat-9', _dirty: false })
  })

  test('a field edited while the save was in flight keeps the row dirty', () => {
    const editedSince = { ...kitchen, name: 'Kitchen Equipment' }
    expect(afterCategorySaved([editedSince], kitchen, 'cat-1')[0]).toMatchObject({ id: 'cat-1', _dirty: true, name: 'Kitchen Equipment' })
  })
})
