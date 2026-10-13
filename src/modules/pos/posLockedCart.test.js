import {
  keepLockedCart, takeLockedCart, listLockedCarts, lockedCartWhere, runBeforePosLock, lockedCartFor,
  sessionEndKeepsCart, beforePosLockRunning, LOCKED_CART_MAX_AGE_MS, POS_BEFORE_LOCK_EVENT,
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

  // S809 GAP-OUTLETS-1: the outlet stop keeps the cart through the same event, and says why.
  it('passes the reason to the order screen, and none for a plain lock', async () => {
    const reasons = []
    const onLock = e => reasons.push(e.detail.reason)
    window.addEventListener(POS_BEFORE_LOCK_EVENT, onLock)
    await runBeforePosLock(1000)
    await runBeforePosLock(1000, 'outlet')
    window.removeEventListener(POS_BEFORE_LOCK_EVENT, onLock)
    expect(reasons).toEqual([undefined, 'outlet'])
  })

  it('reports a kept cart without taking it, for that login on that outlet only', () => {
    const t0 = 2_000_000
    keepLockedCart(cart(), t0)
    expect(lockedCartFor('p-ram', 'c-1', t0).savedAt).toBe(t0)
    expect(lockedCartFor('p-ram', 'c-2', t0)).toBeNull()
    expect(lockedCartFor('p-sita', 'c-1', t0)).toBeNull()
    expect(lockedCartFor(null, 'c-1', t0)).toBeNull()
    // Still there to be taken.
    expect(takeLockedCart('p-ram', 'c-1', t0)).not.toBeNull()
    expect(lockedCartFor('p-ram', 'c-1', t0)).toBeNull()
  })

  // S833 (S809.4): a till PIN session that ends by itself keeps the cart the way a lock does.
  describe('a session that ends by itself', () => {
    const pin = { id: 'p-ram', role: 'client', pos_role: 'staff' }
    const ending = (over = {}) => ({ endingUserId: 'p-ram', profile: pin, boundTablet: true, ownSignOut: false, lockRunning: false, ...over })

    it('keeps the cart for a PIN login on an activated tablet', () => {
      expect(sessionEndKeepsCart(ending())).toBe(true)
      expect(sessionEndKeepsCart(ending({ profile: { ...pin, pos_role: 'manager' } }))).toBe(true)
    })

    it('never for an Owner or an admin, whatever rank they resolve to', () => {
      expect(sessionEndKeepsCart(ending({ profile: { id: 'p-ram', role: 'client', pos_role: null } }))).toBe(false)
      expect(sessionEndKeepsCart(ending({ profile: { id: 'p-ram', role: 'admin', pos_role: 'manager' } }))).toBe(false)
    })

    it('never on a browser that is not an activated till', () => {
      expect(sessionEndKeepsCart(ending({ boundTablet: false }))).toBe(false)
    })

    it('not for our own sign-out, nor while a lock is already keeping it', () => {
      expect(sessionEndKeepsCart(ending({ ownSignOut: true }))).toBe(false)
      expect(sessionEndKeepsCart(ending({ lockRunning: true }))).toBe(false)
    })

    it('once per ending, and only with the ending login\'s own profile in hand', () => {
      expect(sessionEndKeepsCart(ending({ endingUserId: null }))).toBe(false)
      expect(sessionEndKeepsCart(ending({ profile: null }))).toBe(false)
      expect(sessionEndKeepsCart(ending({ profile: { ...pin, id: 'p-sita' } }))).toBe(false)
    })

    it('files the cart only under the ending login', async () => {
      // Read inside the listener, asserted after: a throw in a listener would not fail the test.
      const seen = []
      const onLock = e => {
        seen.push(e.detail.reason, e.detail.profileId)
        // The order screen names someone else: refused, and nothing is written.
        seen.push(keepLockedCart(cart({ profileId: 'p-sita' })), keepLockedCart(cart()))
      }
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
      window.addEventListener(POS_BEFORE_LOCK_EVENT, onLock)
      await runBeforePosLock(1000, 'ended', { profileId: 'p-ram' })
      window.removeEventListener(POS_BEFORE_LOCK_EVENT, onLock)
      errSpy.mockRestore()
      expect(seen).toEqual(['ended', 'p-ram', false, true])
      expect(lockedCartFor('p-sita', 'c-1')).toBeNull()
      expect(lockedCartFor('p-ram', 'c-1')).not.toBeNull()
      // Outside such a run nothing is narrowed: a lock keeps whatever login the screen names.
      expect(keepLockedCart(cart({ profileId: 'p-sita' }))).toBe(true)
    })

    it('says a run is under way until its handed-back work is done', async () => {
      let release
      const onLock = e => e.detail.waitUntil(new Promise(r => { release = r }))
      window.addEventListener(POS_BEFORE_LOCK_EVENT, onLock)
      expect(beforePosLockRunning()).toBe(false)
      const run = runBeforePosLock(1000)
      expect(beforePosLockRunning()).toBe(true)
      release()
      await run
      expect(beforePosLockRunning()).toBe(false)
      window.removeEventListener(POS_BEFORE_LOCK_EVENT, onLock)
    })
  })
})
