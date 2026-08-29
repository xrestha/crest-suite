import { setIfChanged, rowsSignature, mapSignature } from './setIfChanged'

// Stands in for React's setState: records what the updater returned, so a test can assert that a
// no-change poll returned the SAME reference — which is what makes React bail out of the render.
function makeSetter(initial) {
  let value = initial
  const calls = []
  const setter = updater => {
    const next = typeof updater === 'function' ? updater(value) : updater
    calls.push({ next, changed: next !== value })
    value = next
  }
  return { setter, calls, get: () => value }
}

describe('setIfChanged', () => {
  test('a poll returning equal-but-new rows keeps the previous reference', () => {
    const prev = [{ id: 'a', status: 'new' }, { id: 'b', status: 'ready' }]
    const { setter, calls, get } = makeSetter(prev)
    const fresh = [{ id: 'a', status: 'new' }, { id: 'b', status: 'ready' }] // new objects, same data
    setIfChanged(setter, fresh, rows => rowsSignature(rows, ['id', 'status']))
    expect(calls[0].changed).toBe(false)
    expect(get()).toBe(prev)
  })

  test('a changed field is not swallowed', () => {
    const prev = [{ id: 'a', status: 'new' }]
    const { setter, get } = makeSetter(prev)
    const fresh = [{ id: 'a', status: 'ready' }]
    setIfChanged(setter, fresh, rows => rowsSignature(rows, ['id', 'status']))
    expect(get()).toBe(fresh)
  })

  test('an added or removed row is not swallowed', () => {
    const prev = [{ id: 'a', status: 'new' }]
    const one = makeSetter(prev)
    setIfChanged(one.setter, [{ id: 'a', status: 'new' }, { id: 'b', status: 'new' }],
      rows => rowsSignature(rows, ['id', 'status']))
    expect(one.get()).toHaveLength(2)

    const two = makeSetter(prev)
    setIfChanged(two.setter, [], rows => rowsSignature(rows, ['id', 'status']))
    expect(two.get()).toHaveLength(0)
  })

  test('a reordered list counts as a change — order is what the screen draws', () => {
    const prev = [{ id: 'a' }, { id: 'b' }]
    const { setter, calls } = makeSetter(prev)
    setIfChanged(setter, [{ id: 'b' }, { id: 'a' }], rows => rowsSignature(rows, ['id']))
    expect(calls[0].changed).toBe(true)
  })
})

describe('rowsSignature', () => {
  test('null and undefined field values do not collide with a different row count', () => {
    expect(rowsSignature([{ id: 'a', s: null }], ['id', 's']))
      .not.toBe(rowsSignature([{ id: 'a' }, { s: null }], ['id', 's']))
  })

  test('a non-array is its own signature rather than throwing', () => {
    expect(rowsSignature(null, ['id'])).toBe('x')
    expect(rowsSignature(undefined, ['id'])).toBe('x')
  })
})

describe('mapSignature', () => {
  test('insertion order does not matter', () => {
    expect(mapSignature({ t1: 'new', t2: 'ready' })).toBe(mapSignature({ t2: 'ready', t1: 'new' }))
  })

  test('a changed value, key or size is a change', () => {
    const base = { t1: 'new' }
    expect(mapSignature(base)).not.toBe(mapSignature({ t1: 'ready' }))
    expect(mapSignature(base)).not.toBe(mapSignature({ t2: 'new' }))
    expect(mapSignature(base)).not.toBe(mapSignature({ t1: 'new', t2: 'new' }))
  })

  test('valueOf projects a nested value — the guest-request shape', () => {
    const ids = list => (list || []).map(r => r.id).join(',')
    const a = { t1: [{ id: 'r1', items: [1] }] }
    const b = { t1: [{ id: 'r1', items: [1, 2] }] }   // same request, re-read
    const c = { t1: [{ id: 'r1' }, { id: 'r2' }] }    // a genuinely new request
    expect(mapSignature(a, ids)).toBe(mapSignature(b, ids))
    expect(mapSignature(a, ids)).not.toBe(mapSignature(c, ids))
  })

  test('an empty map and a missing map are distinguishable', () => {
    expect(mapSignature({})).not.toBe(mapSignature(null))
  })
})
