import fs from 'fs'
import path from 'path'
import { npr, nprInt, npr2, nprExact, nprOrDash, nprPaisa, nprWords, NPR_LOCALE } from './nepalMoney'

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

  test('nprPaisa shows paisa only when the amount has any (S791)', () => {
    expect(nprPaisa(500.5)).toBe('500.50')
    expect(nprPaisa(2499.25)).toBe('2,499.25')
    expect(nprPaisa(1248650)).toBe('12,48,650')
    expect(nprPaisa(1000.1 - 500.05)).toBe('500.05')   // float noise is not paisa
    expect(nprPaisa(null)).toBe('0')
  })

  test('a figure that rounds to zero has no minus sign (S877)', () => {
    expect(nprInt(-0.3)).toBe('0')             // Math.round gives -0, Intl printed "-0"
    expect(nprInt(-0)).toBe('0')
    expect(npr2(-0.001)).toBe('0.00')          // Intl printed "-0.00"
    expect(npr2(-0.004)).toBe('0.00')
    expect(npr(-0.4)).toBe('NPR 0')
    expect(nprExact(-0.002)).toBe('NPR 0.00')
    expect(nprPaisa(-0.001)).toBe('0')
    expect(nprOrDash(-0.2)).toBe('NPR 0')
    // A real negative keeps its sign, and the rounding is unchanged.
    expect(nprInt(-0.5)).toBe('0')             // Math.round(-0.5) is -0: rounds to zero
    expect(nprInt(-0.6)).toBe('-1')
    expect(npr(-1234.4)).toBe('NPR -1,234')
    expect(npr2(-0.005)).toBe('-0.01')         // Intl rounds half away from zero, as before
    expect(npr2(-0.01)).toBe('-0.01')
    expect(npr2(-1500)).toBe('-1,500.00')
    expect(nprPaisa(-500.5)).toBe('-500.50')
    expect(nprInt(-100000)).toBe('-1,00,000')
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
