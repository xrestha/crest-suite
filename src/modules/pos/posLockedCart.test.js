import {
  keepLockedCart, takeLockedCart, listLockedCarts, lockedCartWhere, runBeforePosLock,
  LOCKED_CART_MAX_AGE_MS, POS_BEFORE_LOCK_EVENT,
} from './posLockedCart'

const cart = (over = {}) => ({
  profileId: 'p-ram', profileName: 'Ram', clientId: 'c-1',
  tableId: 't-5', tableName: 'Table 5', orderId: null, orderNo: null, covers: 2,
  items: [{ recipe_id: 'r-momo', name: 'VEG MOMO', qty: 3 }], unsentUnits: 3,
  ...over,
})

describe('posLockedCart', () => {
  beforeEach(() => localStorage.clear())

  it('keeps a cart for the login that typed it and gives it back to that login only', () => {
    expect(keepLockedCart(cart())).toBe(true)
    expect(takeLockedCart('p-sita', 'c-1')).toBeNull()
    const back = takeLockedCart('p-ram', 'c-1')
    expect(back.items[0].name).toBe('VEG MOMO')
    expect(back.covers).toBe(2)
    // One-shot: a second sign-in does not bring the same lines back twice.
    expect(takeLockedCart('p-ram', 'c-1')).toBeNull()
  })

  it('never hands a cart to the same login on a different outlet', () => {
    keepLockedCart(cart())
    expect(takeLockedCart('p-ram', 'c-2')).toBeNull()
    expect(takeLockedCart('p-ram', 'c-1')).not.toBeNull()
  })

  it('keeps two waiters apart on one till', () => {
    keepLockedCart(cart())
    keepLockedCart(cart({ profileId: 'p-sita', profileName: 'Sita', tableName: 'Table 2', unsentUnits: 1 }))
    expect(listLockedCarts('c-1').map(k => `${k.name}:${k.where}:${k.units}`).sort())
      .toEqual(['Ram:Table 5:3', 'Sita:Table 2:1'])
  })

  it('keeps nothing when nothing is unsent', () => {
    expect(keepLockedCart(cart({ unsentUnits: 0 }))).toBe(false)
    expect(keepLockedCart(cart({ items: [] }))).toBe(false)
    expect(listLockedCarts('c-1')).toEqual([])
  })

  it('drops a cart older than a service', () => {
    const t0 = 1_000_000
    keepLockedCart(cart(), t0)
    expect(listLockedCarts('c-1', t0 + LOCKED_CART_MAX_AGE_MS)).toHaveLength(1)
    expect(takeLockedCart('p-ram', 'c-1', t0 + LOCKED_CART_MAX_AGE_MS + 1)).toBeNull()
  })

  it('survives a corrupt store', () => {
    localStorage.setItem('crest_pos_locked_carts', '{not json')
    expect(listLockedCarts('c-1')).toEqual([])
    expect(keepLockedCart(cart())).toBe(true)
  })

  it('names where the lines belong', () => {
    expect(lockedCartWhere(cart())).toBe('Table 5')
    expect(lockedCartWhere(cart({ tableName: null, orderNo: 31 }))).toBe('Takeaway #31')
    expect(lockedCartWhere(cart({ tableName: null }))).toBe('a new takeaway')
  })

  it('waits for work handed back before the lock, but not for ever', async () => {
    let finished = false
    const onLock = e => e.detail.waitUntil(new Promise(r => setTimeout(() => { finished = true; r() }, 10)))
    window.addEventListener(POS_BEFORE_LOCK_EVENT, onLock)
    await runBeforePosLock(1000)
    expect(finished).toBe(true)
    window.removeEventListener(POS_BEFORE_LOCK_EVENT, onLock)

    const hang = e => e.detail.waitUntil(new Promise(() => {}))
    window.addEventListener(POS_BEFORE_LOCK_EVENT, hang)
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    await expect(runBeforePosLock(20)).resolves.toBeUndefined()
    errSpy.mockRestore()
    window.removeEventListener(POS_BEFORE_LOCK_EVENT, hang)
  })
})
