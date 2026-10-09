import { accountOutlet, outletMovedElsewhere, outletMovedText, outletHeldText, announceOutletSwitch, listenForOutletSwitch } from './outletWatch'

describe('accountOutlet', () => {
  test('the selected outlet wins over home, as my_client_id() resolves it', () => {
    expect(accountOutlet({ active_client_id: 'lakeside', client_id: 'thamel' })).toBe('lakeside')
    expect(accountOutlet({ active_client_id: null, client_id: 'thamel' })).toBe('thamel')
    expect(accountOutlet(null)).toBe(null)
  })
})

describe('outletMovedElsewhere', () => {
  test('a switch on another device moves the account off the outlet this window shows', () => {
    expect(outletMovedElsewhere('thamel', { active_client_id: 'lakeside', client_id: 'thamel' })).toBe(true)
  })

  test('a revoke clears the selection, so the account is home while the window still shows the sibling', () => {
    expect(outletMovedElsewhere('lakeside', { active_client_id: null, client_id: 'thamel' })).toBe(true)
  })

  test('the same outlet, or nothing to compare, is not a move', () => {
    expect(outletMovedElsewhere('thamel', { active_client_id: null, client_id: 'thamel' })).toBe(false)
    expect(outletMovedElsewhere('lakeside', { active_client_id: 'lakeside', client_id: 'thamel' })).toBe(false)
    expect(outletMovedElsewhere(null, { client_id: 'thamel' })).toBe(false)
    expect(outletMovedElsewhere('thamel', null)).toBe(false)
  })
})

describe('outletMovedText', () => {
  test('names the outlet when it is known and still says what happened when it is not', () => {
    expect(outletMovedText('Lakeside')).toMatch(/^This window now shows Lakeside:/)
    expect(outletMovedText(null)).toMatch(/^This window now shows another outlet:/)
    expect(outletMovedText('Lakeside')).toMatch(/not saved was not kept/)
  })

  test('a till order kept on the way out is said to be kept, and where it comes back (S809)', () => {
    const t = outletMovedText('Lakeside', { cartKeptAt: 'Thamel' })
    expect(t).toMatch(/till order you had not sent is kept/)
    expect(t).toMatch(/open Orders at Thamel again/)
    expect(t).toMatch(/Anything else typed there/)
  })
})

describe('outletHeldText', () => {
  test('says why the window stayed, where, and what it is waiting for', () => {
    const t = outletHeldText({ here: 'Thamel', there: 'Lakeside', pending: 2 })
    expect(t).toMatch(/^Your account moved to Lakeside in another window/)
    expect(t).toMatch(/2 changes made offline at Thamel that have not reached the server/)
    expect(t).toMatch(/until your account is back on Thamel\.$/)
  })

  test('one change, and an outlet it does not know', () => {
    const t = outletHeldText({ here: 'Thamel', there: null, pending: 1 })
    expect(t).toMatch(/^Your account moved in another window/)
    expect(t).toMatch(/1 change made offline at Thamel that has not/)
  })
})

describe('the cross-tab announcement', () => {
  const Real = global.BroadcastChannel
  let channels
  beforeEach(() => {
    channels = []
    // A minimal in-process BroadcastChannel: delivers to every OTHER open object with the name,
    // which is what the browser does.
    global.BroadcastChannel = class {
      constructor(name) { this.name = name; this.onmessage = null; this.closed = false; channels.push(this) }
      postMessage(data) {
        channels.filter(c => c !== this && !c.closed && c.name === this.name)
          .forEach(c => c.onmessage && c.onmessage({ data }))
      }
      close() { this.closed = true }
    }
  })
  afterEach(() => { global.BroadcastChannel = Real })

  test('a listener for the same login hears it; another login does not', () => {
    let mine = 0
    let theirs = 0
    const stopMine = listenForOutletSwitch('user-a', () => { mine++ })
    const stopTheirs = listenForOutletSwitch('user-b', () => { theirs++ })
    // Same module instance means the same tab id, which a real other tab would not share.
    // Simulate the other tab by posting a message with a different tab id directly.
    const other = new global.BroadcastChannel('crest-outlet')
    other.postMessage({ type: 'outlet-switched', userId: 'user-a', tab: 'other-tab' })
    expect(mine).toBe(1)
    expect(theirs).toBe(0)
    stopMine(); stopTheirs()
  })

  test('a tab never answers its own announcement', () => {
    let calls = 0
    const stop = listenForOutletSwitch('user-a', () => { calls++ })
    announceOutletSwitch('user-a')
    expect(calls).toBe(0)
    stop()
  })

  test('without BroadcastChannel both sides are no-ops', () => {
    global.BroadcastChannel = undefined
    expect(() => announceOutletSwitch('user-a')).not.toThrow()
    const stop = listenForOutletSwitch('user-a', () => {})
    expect(() => stop()).not.toThrow()
  })
})
