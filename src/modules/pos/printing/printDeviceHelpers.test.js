import {
  PAIR_ALPHABET, normalizePairCode, formatPairCode, isValidPairCode, pairCodeProblem,
  parseIPv4, isPrivateIPv4, printerAddressProblem, portProblem,
  orderedStations, stationsText, momentText, agoText, pairCodeLive, deviceStatus, printerReport,
  stationRoute, jobStateView, emptyDeviceForm, formFromDevice, validateDeviceForm, printersPayload,
} from './printDeviceHelpers'
import { nepalTime, nepalBsLong } from '../../../shared/nepalTime'

// 2026-10-14 12:00 Nepal (06:15 UTC).
const NOW = Date.parse('2026-10-14T06:15:00Z')
const iso = ms => new Date(ms).toISOString()

describe('pairing codes', () => {
  test('the alphabet has no I, O, 0 or 1', () => {
    expect(PAIR_ALPHABET).toHaveLength(32)
    for (const ch of 'IO01') expect(PAIR_ALPHABET).not.toContain(ch)
  })

  test('spaces, dashes and case are ignored', () => {
    expect(normalizePairCode(' abcd-efgh ')).toBe('ABCDEFGH')
    expect(normalizePairCode('ab cd—ef gh')).toBe('ABCDEFGH')
    expect(normalizePairCode(null)).toBe('')
  })

  test('shown grouped XXXX-XXXX, the dash only once a fifth character is typed', () => {
    expect(formatPairCode('abcdefgh')).toBe('ABCD-EFGH')
    expect(formatPairCode('abcd')).toBe('ABCD')
    expect(formatPairCode('abcde')).toBe('ABCD-E')
    expect(formatPairCode('ABCD-')).toBe('ABCD') // backspacing over the last character drops the dash
    expect(formatPairCode('abcd efgh jk')).toBe('ABCD-EFGH') // never longer than 8
  })

  test('valid only at 8 characters from the alphabet', () => {
    expect(isValidPairCode('abcd-efgh')).toBe(true)
    expect(isValidPairCode('ABCD EFG2')).toBe(true)
    expect(isValidPairCode('ABCD-EFG')).toBe(false)
    expect(isValidPairCode('ABCD-EFGO')).toBe(false)
    expect(isValidPairCode('ABCD-EFG1')).toBe(false)
  })

  test('says what is wrong in words', () => {
    expect(pairCodeProblem('')).toMatch(/8-character code/)
    expect(pairCodeProblem('ABCD-EFG')).toBe('The code has 8 characters; this has 7.')
    expect(pairCodeProblem('ABCD-EFG0')).toMatch(/no I, O, 0 or 1/)
    expect(pairCodeProblem('abcd efgh')).toBe('')
  })
})

describe('printer addresses', () => {
  test.each([
    ['10.0.0.1', true], ['10.255.255.254', true],
    ['172.16.0.1', true], ['172.31.255.254', true], ['172.15.0.1', false], ['172.32.0.1', false],
    ['192.168.1.50', true], [' 192.168.1.50 ', true], ['192.169.1.1', false],
    ['8.8.8.8', false], ['127.0.0.1', false],
    ['192.168.1', false], ['192.168.1.256', false], ['192.168.01.5', false], ['192.168.1.50.1', false],
    ['', false], ['printer.local', false],
  ])('%s private: %s', (addr, expected) => {
    expect(isPrivateIPv4(addr)).toBe(expected)
  })

  test('parses only plain dotted quads', () => {
    expect(parseIPv4('192.168.1.50')).toEqual([192, 168, 1, 50])
    expect(parseIPv4('192.168.1.-1')).toBeNull()
    expect(parseIPv4('1e2.168.1.5')).toBeNull()
  })

  test('the problem sentence names the fix', () => {
    expect(printerAddressProblem('')).toMatch(/for example 192\.168\.1\.50/)
    expect(printerAddressProblem('192.168.1')).toMatch(/four numbers with dots/)
    expect(printerAddressProblem('8.8.8.8')).toMatch(/restaurant's own network/)
    expect(printerAddressProblem('192.168.1.50')).toBe('')
  })

  test('port is a whole number from 1 to 65535', () => {
    expect(portProblem('9100')).toBe('')
    expect(portProblem(9100)).toBe('')
    for (const bad of ['', '0', '65536', '91.5', 'abc', ' ']) expect(portProblem(bad)).toMatch(/9100/)
  })
})

describe('stations', () => {
  test('KOT before BOT, unknown values dropped', () => {
    expect(orderedStations(['BOT', 'KOT', 'XYZ'])).toEqual(['KOT', 'BOT'])
    expect(orderedStations(null)).toEqual([])
  })
  test('in words', () => {
    expect(stationsText(['KOT'])).toBe('Kitchen')
    expect(stationsText(['BOT'])).toBe('Bar')
    expect(stationsText(['BOT', 'KOT'])).toBe('Kitchen and bar')
    expect(stationsText([])).toBe('')
  })
})

describe('times', () => {
  test('ago text', () => {
    expect(agoText(iso(NOW - 1000), NOW)).toBe('just now')
    expect(agoText(iso(NOW - 4000), NOW)).toBe('4 s ago')
    expect(agoText(iso(NOW - 90000), NOW)).toBe('1 min ago')
    expect(agoText(iso(NOW - 2 * 3600000), NOW)).toBe('2 h ago')
    expect(agoText(iso(NOW + 5000), NOW)).toBe('just now') // a clock behind the server's
    expect(agoText(null, NOW)).toBe('')
  })

  test('a moment today is its clock time; another day carries the day', () => {
    const today = iso(NOW - 3600000)
    expect(momentText(today, NOW)).toBe(nepalTime(today))
    const yesterday = iso(NOW - 26 * 3600000)
    expect(momentText(yesterday, NOW)).toBe(`${nepalBsLong(yesterday)} · ${nepalTime(yesterday)}`)
    expect(momentText(null, NOW)).toBe('')
  })

  test('a pairing code is live until it expires', () => {
    expect(pairCodeLive(iso(NOW + 1000), NOW)).toBe(true)
    expect(pairCodeLive(iso(NOW - 1000), NOW)).toBe(false)
    expect(pairCodeLive(null, NOW)).toBe(false)
  })
})

describe('deviceStatus', () => {
  test('online, with how long ago it was seen', () => {
    const st = deviceStatus({ paired: true, online: true, last_seen_at: iso(NOW - 4000) }, NOW)
    expect(st).toMatchObject({ badge: 'badge-green', text: 'Online', detail: 'Seen 4 s ago' })
  })

  test('offline is amber (the tills print instead) with the time last seen', () => {
    const seen = iso(NOW - 600000)
    const st = deviceStatus({ paired: true, online: false, last_seen_at: seen }, NOW)
    expect(st).toMatchObject({ badge: 'badge-amber', text: 'Offline', detail: `Last seen ${nepalTime(seen)}` })
  })

  test('paired but never checked in', () => {
    expect(deviceStatus({ paired: true, online: false, last_seen_at: null }, NOW).detail).toMatch(/not checked in/)
  })

  test('not paired: the code this page issued, with its expiry', () => {
    const exp = iso(NOW + 15 * 60000)
    const st = deviceStatus({ paired: false, pair_code_expires_at: exp }, NOW, { code: 'ABCDEFGH', expiresAt: exp })
    expect(st.text).toBe('Waiting to pair')
    expect(st.detail).toBe(`Pairing code ABCD-EFGH, good until ${nepalTime(exp)}`)
  })

  test('not paired: a code made elsewhere is only an expiry', () => {
    const exp = iso(NOW + 60000)
    expect(deviceStatus({ paired: false, pair_code_expires_at: exp }, NOW).detail).toMatch(/A pairing code is out/)
  })

  test('not paired and no live code', () => {
    const st = deviceStatus({ paired: false, pair_code_expires_at: iso(NOW - 1) }, NOW, { code: 'ABCDEFGH', expiresAt: iso(NOW - 1) })
    expect(st).toMatchObject({ badge: 'badge-gray', text: 'Not paired yet' })
  })

  test('a paired device with a new code out says so beside its status', () => {
    const exp = iso(NOW + 60000)
    const st = deviceStatus({ paired: true, online: true, last_seen_at: iso(NOW) }, NOW, { code: 'ABCDEFGH', expiresAt: exp })
    expect(st.text).toBe('Online')
    expect(st.pairing).toMatch(/^Pairing code ABCD-EFGH/)
  })

  test("a printer's last report, by station", () => {
    const d = { status: { printers: [{ station: 'KOT', ok: false, error: 'Out of paper' }, { station: 'BOT', ok: true }] } }
    expect(printerReport(d, 'KOT')).toEqual({ ok: false, error: 'Out of paper' })
    expect(printerReport(d, 'BOT')).toEqual({ ok: true, error: '' })
    expect(printerReport({ status: null }, 'KOT')).toBeNull()
  })
})

describe('stationRoute', () => {
  const a = { id: 'a', name: 'Counter PC', stations: ['KOT', 'BOT'], paired: true, online: false }
  const b = { id: 'b', name: 'Bar laptop', stations: ['BOT'], paired: true, online: true }
  const c = { id: 'c', name: 'New PC', stations: ['KOT'], paired: false, online: false }

  test('an online device first', () => {
    expect(stationRoute([a, b], 'BOT')).toEqual({ state: 'online', device: b })
  })
  test('then a paired one, offline', () => {
    expect(stationRoute([c, a], 'KOT')).toEqual({ state: 'offline', device: a })
  })
  test('then one waiting to pair', () => {
    expect(stationRoute([c], 'KOT')).toEqual({ state: 'unpaired', device: c })
  })
  test('none', () => {
    expect(stationRoute([b], 'KOT')).toEqual({ state: 'none', device: null })
    expect(stationRoute(null, 'KOT')).toEqual({ state: 'none', device: null })
  })
})

describe('jobStateView', () => {
  test('printed by a device is green; printed on the till is amber', () => {
    expect(jobStateView({ state: 'printed', printed_via: 'device' })).toMatchObject({ badge: 'badge-green', text: 'Printed' })
    expect(jobStateView({ state: 'printed', printed_via: 'till' })).toMatchObject({ badge: 'badge-amber', text: 'Printed on the till' })
  })
  test('retrying and failed carry the reason', () => {
    expect(jobStateView({ state: 'retrying', fail_reason: 'Paper out' })).toEqual({ badge: 'badge-amber', text: 'Retrying', reason: 'Paper out' })
    expect(jobStateView({ state: 'failed', fail_reason: 'Offline' })).toEqual({ badge: 'badge-red', text: 'Failed', reason: 'Offline' })
  })
  test('expired, waiting, printing', () => {
    expect(jobStateView({ state: 'expired' })).toMatchObject({ badge: 'badge-red', reason: 'Not printed within 15 minutes.' })
    expect(jobStateView({ state: 'waiting' }).text).toBe('Waiting')
    expect(jobStateView({ state: 'printing' }).text).toBe('Printing')
  })
  test('an unknown state shows as itself, never as a guess', () => {
    expect(jobStateView({ state: 'mystery' })).toEqual({ badge: 'badge-gray', text: 'mystery', reason: '' })
  })
})

describe('the Add / Edit form', () => {
  const helperForm = () => ({
    ...emptyDeviceForm(),
    name: 'Counter PC',
    kind: 'helper',
    stations: ['BOT', 'KOT'],
    printers: {
      KOT: { host: '192.168.1.50', port: '9100', width: 80 },
      BOT: { host: '192.168.1.51', port: ' 9101 ', width: 58 },
    },
  })

  test('a fresh form is a page printing kitchen tickets', () => {
    expect(emptyDeviceForm()).toMatchObject({ name: '', kind: 'page', stations: ['KOT'] })
  })

  test('name and stations are required', () => {
    const errors = validateDeviceForm({ ...emptyDeviceForm(), name: '  ', stations: [] })
    expect(errors.name).toMatch(/Counter PC/)
    expect(errors.stations).toMatch(/at least one/)
  })

  test('a name over 60 characters is refused', () => {
    expect(validateDeviceForm({ ...emptyDeviceForm(), name: 'x'.repeat(61) }).name).toMatch(/60/)
    expect(validateDeviceForm({ ...emptyDeviceForm(), name: 'x'.repeat(60) })).toEqual({})
  })

  test('a page needs no printer rows', () => {
    const form = { ...emptyDeviceForm(), name: 'Counter PC', printers: { KOT: { host: 'junk', port: 'x', width: 1 }, BOT: {} } }
    expect(validateDeviceForm(form)).toEqual({})
    expect(printersPayload(form)).toEqual([])
  })

  test('a helper checks each chosen station\'s printer, and only those', () => {
    const form = helperForm()
    expect(validateDeviceForm(form)).toEqual({})
    form.printers.KOT = { host: '8.8.8.8', port: '0', width: 70 }
    form.printers.BOT = { host: 'junk', port: '9100', width: 80 }
    form.stations = ['KOT']
    const errors = validateDeviceForm(form)
    expect(Object.keys(errors).sort()).toEqual(['KOT.host', 'KOT.port', 'KOT.width'])
  })

  test('the payload is one printer per station, KOT first, numbers as numbers', () => {
    expect(printersPayload(helperForm())).toEqual([
      { station: 'KOT', host: '192.168.1.50', port: 9100, width: 80 },
      { station: 'BOT', host: '192.168.1.51', port: 9101, width: 58 },
    ])
  })

  test('an existing device fills the form, keeping a row for each station', () => {
    const form = formFromDevice({
      name: 'Bar laptop', kind: 'helper', stations: ['BOT'],
      printers: [{ station: 'BOT', host: '10.0.0.9', port: 9100, width: 58 }],
    })
    expect(form).toMatchObject({ name: 'Bar laptop', kind: 'helper', stations: ['BOT'] })
    expect(form.printers.BOT).toEqual({ host: '10.0.0.9', port: '9100', width: 58 })
    expect(form.printers.KOT).toEqual({ host: '', port: '9100', width: 80 })
  })
})
