import { nextVendorCodeAfter } from './Vendors'

// Vendors.js imports AuthContext/scopedDb, which import the real supabaseClient — mock it so this
// test exercises only the pure helper exported beside the page (S756).
// jest.mock is hoisted above the import by babel-jest, so the mock is in place before it loads.
jest.mock('../../../supabaseClient', () => ({ supabase: { from: jest.fn(), rpc: jest.fn(), auth: {} } }))

describe('nextVendorCodeAfter (S756: the prefix is escaped before it reaches RegExp)', () => {
  test('takes the max over matching codes, archived vendors included by the caller', () => {
    expect(nextVendorCodeAfter('vnd', ['VND-001', 'VND-009', null, 'VND-004'])).toBe('VND-010')
  })

  test('regex metacharacters in the prefix match literally', () => {
    expect(nextVendorCodeAfter('V.N', ['V.N-002', 'VXN-900'])).toBe('V.N-003')
    expect(nextVendorCodeAfter('A+', ['A+-001', 'AA-077'])).toBe('A+-002')
  })

  test('an invalid-pattern prefix does not throw', () => {
    expect(() => nextVendorCodeAfter('[', ['[-003'])).not.toThrow()
    expect(nextVendorCodeAfter('[', ['[-003'])).toBe('[-004')
  })
})
