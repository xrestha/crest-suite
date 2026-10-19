import { readPageCache, writePageCache, setPageCacheUser, clearPageCache } from './sessionDataCache'

// S849 GAPS-7: the page cache belongs to the signed-in user, not only to the client.
describe('sessionDataCache', () => {
  beforeEach(() => {
    sessionStorage.clear()
    setPageCacheUser(null)
  })

  it('keys each entry by the signed-in user as well as the client', () => {
    setPageCacheUser('user-a')
    writePageCache('dashboard', 'items', 'client-1', [1, 2])
    expect(readPageCache('dashboard', 'items', 'client-1')).toEqual([1, 2])
    const keys = Object.keys(sessionStorage)
    expect(keys.some(k => k.includes('user-a') && k.includes('client-1'))).toBe(true)
  })

  it('another account of the same client reads nothing back', () => {
    setPageCacheUser('owner')
    writePageCache('dashboard', 'items', 'client-1', ['owner-only rows'])
    setPageCacheUser('ims-staff')
    expect(readPageCache('dashboard', 'items', 'client-1')).toBeNull()
  })

  it('reads and writes nothing while no user is known', () => {
    writePageCache('dashboard', 'items', 'client-1', ['x'])
    expect(Object.keys(sessionStorage)).toHaveLength(0)
    setPageCacheUser('user-a')
    writePageCache('dashboard', 'items', 'client-1', ['x'])
    setPageCacheUser(null)
    expect(readPageCache('dashboard', 'items', 'client-1')).toBeNull()
  })

  it('clearPageCache removes only the page-cache keys', () => {
    setPageCacheUser('user-a')
    writePageCache('dashboard', 'items', 'client-1', ['x'])
    sessionStorage.setItem('guest_menu_cart', '{"a":1}')
    clearPageCache()
    expect(sessionStorage.getItem('guest_menu_cart')).toBe('{"a":1}')
    expect(readPageCache('dashboard', 'items', 'client-1')).toBeNull()
  })
})
