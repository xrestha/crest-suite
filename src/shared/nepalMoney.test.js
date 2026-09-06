import fs from 'fs'
import path from 'path'
import { npr, nprInt, npr2, nprExact, nprOrDash, nprWords, NPR_LOCALE } from './nepalMoney'

describe('nepalMoney groups in lakh and crore', () => {
  test('the shapes the 52 local formatters had, now grouped the Nepali way', () => {
    expect(nprInt(1248650)).toBe('12,48,650')
    expect(npr(12345678)).toBe('NPR 1,23,45,678')
    expect(npr2(342500)).toBe('3,42,500.00')
    expect(nprExact(1234.5)).toBe('NPR 1,234.50')
    expect(npr(999)).toBe('NPR 999')          // no group under a thousand
    expect(nprInt(100000)).toBe('1,00,000')   // one lakh
  })

  test('rounding matches what the local one-liners did', () => {
    expect(nprInt(1234.5)).toBe('1,235')       // Math.round
    expect(npr2(1234.567)).toBe('1,234.57')
    expect(npr(null)).toBe('NPR 0')            // `Math.round(n || 0)`
    expect(nprInt(undefined)).toBe('0')
    expect(npr2(undefined)).toBe('0.00')
  })

  test('a missing figure is a dash, not a zero', () => {
    expect(nprOrDash(null)).toBe('—')
    expect(nprOrDash(undefined)).toBe('—')
    expect(nprOrDash(0)).toBe('NPR 0')
  })

  test('digits and words agree on the same number', () => {
    expect(nprInt(342500)).toBe('3,42,500')
    expect(nprWords(342500)).toBe('Three Lakh Forty-Two Thousand Five Hundred')
  })

  test('the premise: the locale every site used before S683 is not Nepali', () => {
    // If a future ICU teaches `en-NP` lakh grouping this test will fail, and the locale constant
    // can be reconsidered — but only then.
    expect((1248650).toLocaleString('en-NP')).toBe('1,248,650')
    expect((1248650).toLocaleString(NPR_LOCALE)).toBe('12,48,650')
  })
})

// The class this module exists to close comes back one call site at a time, and nothing at
// runtime flags a `1,248,650`. So the test reads the source (the S675 technique): no money-shaped
// toLocaleString may name any locale but NPR_LOCALE, and a bare toLocaleString() — which formats
// in whatever locale the viewer's browser has — is allowed only on a Date construct, which is
// what the three legitimate ones are.
describe('nepalMoney: no site formats a number in another locale (source scan)', () => {
  const SRC = path.resolve(__dirname, '..')
  const files = []
  ;(function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(js|jsx)$/.test(e.name) && !/\.test\.(js|jsx)$/.test(e.name)) files.push(p)
    }
  })(SRC)

  test('no toLocaleString / Intl.NumberFormat with en-NP or en-US', () => {
    const bad = []
    for (const f of files) {
      const lines = fs.readFileSync(f, 'utf8').split('\n')
      lines.forEach((l, i) => {
        if (/(toLocaleString|Intl\.NumberFormat)\(\s*['"]en-(NP|US)['"]/.test(l)) bad.push(`${path.relative(SRC, f)}:${i + 1}`)
      })
    }
    expect(bad).toEqual([])
  })

  test('a bare toLocaleString() appears only on a Date construct', () => {
    const bad = []
    for (const f of files) {
      const lines = fs.readFileSync(f, 'utf8').split('\n')
      lines.forEach((l, i) => {
        if (/\.toLocaleString\(\)/.test(l) && !/new Date\(/.test(l)) bad.push(`${path.relative(SRC, f)}:${i + 1}`)
      })
    }
    expect(bad).toEqual([])
  })
})
