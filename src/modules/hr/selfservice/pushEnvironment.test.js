import { PUSH, pushState, isIos } from './pushEnvironment'

// The base case: everything present, nothing decided yet.
const ok = {
  ios: false, standalone: false, hasServiceWorker: true, hasPushManager: true,
  permission: 'default', subscribed: false, configured: true,
}

describe('pushState', () => {
  it('reports ENABLED whenever a subscription already exists, whatever else is true', () => {
    expect(pushState({ ...ok, subscribed: true })).toBe(PUSH.ENABLED)
    // Even on an iOS tab with no PushManager: if we are subscribed, we are subscribed.
    expect(pushState({
      ...ok, subscribed: true, ios: true, standalone: false, hasPushManager: false, permission: 'denied',
    })).toBe(PUSH.ENABLED)
  })

  it('tells an iOS tab to install BEFORE it tells it the browser cannot do push', () => {
    // This is the whole ordering argument: an iPhone opening the portal from a chat app has no
    // PushManager, and "not supported" would be wrong and a dead end.
    expect(pushState({ ...ok, ios: true, standalone: false, hasPushManager: false }))
      .toBe(PUSH.NEEDS_INSTALL)
  })

  it('treats an installed iOS app like any other capable device', () => {
    expect(pushState({ ...ok, ios: true, standalone: true })).toBe(PUSH.READY)
  })

  it('reports UNSUPPORTED with no service worker or no PushManager', () => {
    expect(pushState({ ...ok, hasServiceWorker: false })).toBe(PUSH.UNSUPPORTED)
    expect(pushState({ ...ok, hasPushManager: false })).toBe(PUSH.UNSUPPORTED)
  })

  it('reports UNSUPPORTED when the build has no VAPID key, rather than offering a button that throws', () => {
    expect(pushState({ ...ok, configured: false })).toBe(PUSH.UNSUPPORTED)
  })

  it('keeps DENIED separate from UNSUPPORTED — only the user can undo a denial', () => {
    expect(pushState({ ...ok, permission: 'denied' })).toBe(PUSH.DENIED)
  })

  it('reports READY when permission is default or already granted but unsubscribed', () => {
    expect(pushState({ ...ok, permission: 'default' })).toBe(PUSH.READY)
    expect(pushState({ ...ok, permission: 'granted' })).toBe(PUSH.READY)
  })
})

describe('isIos', () => {
  it('matches the iOS device families', () => {
    expect(isIos('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe(true)
    expect(isIos('Mozilla/5.0 (iPad; CPU OS 16_4 like Mac OS X)')).toBe(true)
    expect(isIos('Mozilla/5.0 (iPod touch; CPU iPhone OS 15_0 like Mac OS X)')).toBe(true)
  })

  it('does not match Android or desktop', () => {
    expect(isIos('Mozilla/5.0 (Linux; Android 14; Pixel 8)')).toBe(false)
    expect(isIos('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe(false)
  })

  it('does not match a real Mac, which reports the same UA as an iPad pretending to be one', () => {
    // jsdom's navigator.maxTouchPoints is 0, i.e. not a touch device.
    expect(isIos('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe(false)
  })
})
