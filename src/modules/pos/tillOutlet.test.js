import { TILL_PATHS, isTillPath, readTillDevice, tillStop, outletSwitchArg } from './tillOutlet'

describe('isTillPath', () => {
  test('the screens that bill, ticket or hold the drawer', () => {
    for (const p of TILL_PATHS) expect(isTillPath(p)).toBe(true)
    expect(isTillPath('/pos/orders/')).toBe(true)
  })

  test('reports, setup and look-alike paths follow the login', () => {
    expect(isTillPath('/pos/sales-report')).toBe(false)
    expect(isTillPath('/pos/kds-settings')).toBe(false)
    expect(isTillPath('/pos')).toBe(false)
    expect(isTillPath('/dashboard')).toBe(false)
    expect(isTillPath(undefined)).toBe(false)
  })
})

describe('readTillDevice', () => {
  beforeEach(() => localStorage.clear())

  test('a browser never activated is not a till', () => {
    expect(readTillDevice()).toEqual({ clientId: null, clientName: '' })
  })

  test('reads what Till Devices wrote', () => {
    localStorage.setItem('pos_device_client_id', 'bloom')
    localStorage.setItem('pos_device_client_name', 'BLOOM CAFE')
    expect(readTillDevice()).toEqual({ clientId: 'bloom', clientName: 'BLOOM CAFE' })
  })

  test('blocked storage reads as no till rather than throwing', () => {
    const spy = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    expect(readTillDevice()).toEqual({ clientId: null, clientName: '' })
    spy.mockRestore()
  })
})

describe('tillStop', () => {
  test("BLOOM's counter tablet runs while the window shows BLOOM", () => {
    expect(tillStop({ deviceClientId: 'bloom', clientId: 'bloom', held: false })).toBe(null)
  })

  test('it stops once the login has taken the window to PKR', () => {
    expect(tillStop({ deviceClientId: 'bloom', clientId: 'pkr', held: false })).toBe('away')
  })

  test('a browser that is no till follows its login, as S798 decided', () => {
    expect(tillStop({ deviceClientId: null, clientId: 'pkr', held: false })).toBe(null)
  })

  test('a window holding offline changes stops wherever it is, on a till or not', () => {
    expect(tillStop({ deviceClientId: 'bloom', clientId: 'bloom', held: true })).toBe('held')
    expect(tillStop({ deviceClientId: null, clientId: 'bloom', held: true })).toBe('held')
  })

  test('no outlet yet is not evidence of anything', () => {
    expect(tillStop({ deviceClientId: 'bloom', clientId: null, held: false })).toBe(null)
  })
})

describe('outletSwitchArg', () => {
  test('home goes as NULL, the reset every login may make', () => {
    expect(outletSwitchArg('bloom', 'bloom')).toBe(null)
    expect(outletSwitchArg(null, 'bloom')).toBe(null)
  })

  test('a sibling goes by id, and the server checks the reach', () => {
    expect(outletSwitchArg('bloom', 'pkr')).toBe('bloom')
  })
})
