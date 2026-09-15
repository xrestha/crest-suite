import { nextCodeAfter, priceImpactPhrase } from './Items'

// Items.js imports AuthContext/scopedDb, which import the real supabaseClient — mock it so this
// test exercises only the pure helpers exported beside the page (S756).
// jest.mock is hoisted above the import by babel-jest, so the mock is in place before it loads.
jest.mock('../../../supabaseClient', () => ({ supabase: { from: jest.fn(), rpc: jest.fn(), auth: {} } }))

describe('nextCodeAfter (S756: the prefix is escaped before it reaches RegExp)', () => {
  test('takes the max over matching codes', () => {
    expect(nextCodeAfter('itm', ['ITM-001', 'ITM-012', 'ITM-003'])).toBe('ITM-013')
  })

  test('a prefix with regex metacharacters matches literally', () => {
    // Unescaped, "A+" meant "one or more A", so AAA-050 counted as an A+ code.
    expect(nextCodeAfter('A+', ['A+-004', 'AAA-050'])).toBe('A+-005')
    // Unescaped, "V.N" matched "VXN-900".
    expect(nextCodeAfter('V.N', ['V.N-002', 'VXN-900'])).toBe('V.N-003')
  })

  test('a prefix that is not a valid pattern on its own does not throw', () => {
    expect(() => nextCodeAfter('(', ['(-001'])).not.toThrow()
    expect(nextCodeAfter('(', ['(-001'])).toBe('(-002')
  })

  test('an empty book starts at 001', () => {
    expect(nextCodeAfter('ITM', [])).toBe('ITM-001')
  })
})

describe('priceImpactPhrase (S756 D5)', () => {
  test('names only the records a price re-values, merging opening and closing counts', () => {
    expect(priceImpactPhrase({ OS: 2, CS: 1, W: 12, P: 40, VR: 3, PO: 2 }))
      .toEqual({ text: '3 stock counts and 12 wastage entries', total: 15 })
  })

  test('purchases alone re-value nothing', () => {
    expect(priceImpactPhrase({ P: 40, PO: 1 })).toBeNull()
    expect(priceImpactPhrase({})).toBeNull()
  })

  test('singular forms', () => {
    expect(priceImpactPhrase({ SM: 1 })).toEqual({ text: '1 staff meal', total: 1 })
  })
})
