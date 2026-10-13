import { customerBookAfterRead } from './customerBook'

// S833 (S809.4 3l): a reload that fails keeps the last good list; a failed first read is the error card.
describe('customerBookAfterRead', () => {
  const empty = { clientId: null, rows: null, error: null, stale: null }
  const rows = [{ id: 'c1', name: 'Sita' }, { id: 'c2', name: 'Ram' }]
  const fail = { name: 'TimeoutError', message: 'Reading the customer book timed out after 20s' }

  test('a read that lands shows its rows for that outlet', () => {
    expect(customerBookAfterRead(empty, 'A', { data: rows, error: null }))
      .toEqual({ clientId: 'A', rows, error: null, stale: null })
  })

  test('a read that lands with no rows is an empty book, not a failure', () => {
    expect(customerBookAfterRead(empty, 'A', { data: null, error: null }))
      .toEqual({ clientId: 'A', rows: [], error: null, stale: null })
  })

  test('a failed first read is the error, with no list', () => {
    expect(customerBookAfterRead(empty, 'A', { data: null, error: fail }))
      .toEqual({ clientId: 'A', rows: null, error: fail, stale: null })
  })

  test('a failed reload of the same outlet keeps the list it had and marks it out of date', () => {
    const shown = { clientId: 'A', rows, error: null, stale: null }
    const next = customerBookAfterRead(shown, 'A', { data: null, error: fail })
    expect(next.rows).toBe(rows)
    expect(next).toMatchObject({ clientId: 'A', error: null, stale: fail })
  })

  test("a failed read for another outlet never keeps the first outlet's customers", () => {
    const shown = { clientId: 'A', rows, error: null, stale: null }
    expect(customerBookAfterRead(shown, 'B', { data: null, error: fail }))
      .toEqual({ clientId: 'B', rows: null, error: fail, stale: null })
  })

  test('a reload that lands after a failed one clears the out-of-date mark', () => {
    const stale = { clientId: 'A', rows, error: null, stale: fail }
    const fresh = [{ id: 'c3', name: 'Hari' }]
    expect(customerBookAfterRead(stale, 'A', { data: fresh, error: null }))
      .toEqual({ clientId: 'A', rows: fresh, error: null, stale: null })
  })

  test('a failed retry after a failed first read stays the error card', () => {
    const failed = { clientId: 'A', rows: null, error: fail, stale: null }
    const again = { message: 'TypeError: Failed to fetch' }
    expect(customerBookAfterRead(failed, 'A', { data: null, error: again }))
      .toEqual({ clientId: 'A', rows: null, error: again, stale: null })
  })
})
