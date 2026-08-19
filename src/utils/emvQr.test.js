import { crc16, parseEmvQr, validateEmvQr, buildDynamicQr } from './emvQr'

// Build a structurally-valid EMVCo payload from tag pairs, with a correct CRC — the same shape a
// real standee QR decodes to. Using crc16 itself to seal fixtures is fine: validateEmvQr's CRC
// check still catches any tampering test because the tamper happens AFTER sealing.
const tlv = (id, v) => id + String(v.length).padStart(2, '0') + v
function seal(pairs) {
  const body = pairs.map(([id, v]) => tlv(id, v)).join('') + '6304'
  return body + crc16(body)
}

// A synthetic FonePay Business-style static QR: GUID in the merchant-account-information range
// (tag 26), static POI (01="11"), NPR currency, a merchant name, and an existing tag 62 subfield
// (02="abc") that buildDynamicQr must preserve when merging in its own reference.
const FONEPAY_STATIC = seal([
  ['00', '01'],
  ['01', '11'],
  ['26', tlv('00', 'fonepay.com') + tlv('01', 'MER123456')],
  ['52', '5812'],
  ['53', '524'],
  ['58', 'NP'],
  ['59', 'CASA ACAI CAFE'],
  ['60', 'KATHMANDU'],
  ['62', tlv('02', 'abc')],
])

const NCHL_STATIC = seal([
  ['00', '01'],
  ['01', '11'],
  ['30', tlv('00', 'np.org.nchl.nepalpay') + tlv('01', 'ACQ001')],
  ['53', '524'],
  ['58', 'NP'],
  ['59', 'C.M.S. HOSPITALITY'],
  ['60', 'KATHMANDU'],
])

describe('validateEmvQr', () => {
  test('accepts a valid payload and reads the merchant name', () => {
    const r = validateEmvQr(FONEPAY_STATIC)
    expect(r.ok).toBe(true)
    expect(r.merchantName).toBe('CASA ACAI CAFE')
  })

  test('names a personal wallet QR for what it is, not a parse error', () => {
    // A real eSewa P2P "receive money" QR decodes to JSON — pasted live during the Plan A test.
    const r = validateEmvQr('{\n  "name" : "A person",\n  "eSewa_id" : "9800000000"\n}')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/personal wallet QR/)
  })

  test('rejects a tampered payload on CRC', () => {
    const tampered = FONEPAY_STATIC.replace('CASA', 'CASB')
    expect(validateEmvQr(tampered).ok).toBe(false)
  })

  test('detects the FonePay network from the merchant-account GUID', () => {
    expect(validateEmvQr(FONEPAY_STATIC).network).toBe('FonePay')
  })

  test('detects NepalPay/NCHL', () => {
    expect(validateEmvQr(NCHL_STATIC).network).toBe('NepalPay/NCHL')
  })

  test('network scan reads account tags only, never the merchant name', () => {
    // A merchant literally named "ESEWA CAFE" on a FonePay QR must still detect as FonePay —
    // tag 59 is outside the 02–51 merchant-account range the detector scans.
    const named = seal([
      ['00', '01'], ['01', '11'],
      ['26', tlv('00', 'fonepay.com')],
      ['53', '524'], ['58', 'NP'], ['59', 'ESEWA CAFE'], ['60', 'KATHMANDU'],
    ])
    expect(validateEmvQr(named).network).toBe('FonePay')
  })

  test('unknown network reports null, not a guess', () => {
    const generic = seal([
      ['00', '01'], ['01', '11'],
      ['26', tlv('00', 'somebank.com.np')],
      ['53', '524'], ['58', 'NP'], ['59', 'GENERIC MERCHANT'], ['60', 'KATHMANDU'],
    ])
    expect(validateEmvQr(generic).network).toBe(null)
  })
})

describe('buildDynamicQr', () => {
  test('produces a valid dynamic payload from a FonePay-shaped static QR', () => {
    const out = buildDynamicQr(FONEPAY_STATIC, 535, 'CR123')
    expect(out).not.toBe(null)
    // The result must itself validate — CRC recomputed correctly over the new body.
    expect(validateEmvQr(out).ok).toBe(true)

    const tags = Object.fromEntries(parseEmvQr(out).map(t => [t.id, t.value]))
    expect(tags['01']).toBe('12')            // static → dynamic POI
    expect(tags['54']).toBe('535.00')        // exact amount, two decimals
    // Existing tag-62 subfields survive; our Reference Label (05) merges in beside them.
    const sub = Object.fromEntries(parseEmvQr(tags['62']).map(t => [t.id, t.value]))
    expect(sub['02']).toBe('abc')
    expect(sub['05']).toBe('CR123')
  })

  test('rejects an invalid base payload', () => {
    expect(buildDynamicQr('not a qr', 100, 'CR1')).toBe(null)
  })
})
