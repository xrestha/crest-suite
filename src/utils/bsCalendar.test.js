import {
  daysInBsMonth, bsToAd, adToBs, getBsFiscalYear, formatAd, bsAddDays, bsDiffDays,
} from './bsCalendar'

describe('daysInBsMonth', () => {
  test('reads the real month-length table, not a fixed 30/31', () => {
    expect(daysInBsMonth(2082, 1)).toBe(31)
    expect(daysInBsMonth(2082, 3)).toBe(32)
    expect(daysInBsMonth(2082, 9)).toBe(29)
  })

  // Corrected S349 (2026-07-11) — verified month-by-month against Hamro Patro. Jestha/Ashadh/
  // Shrawan were transposed and Ashwin was short by a day; locking in the corrected values so a
  // future edit can't silently re-introduce the same transposition.
  test('BS 2083 matches the corrected month-length table (S349)', () => {
    expect(daysInBsMonth(2083, 1)).toBe(31)  // Baisakh
    expect(daysInBsMonth(2083, 2)).toBe(31)  // Jestha
    expect(daysInBsMonth(2083, 3)).toBe(32)  // Ashadh
    expect(daysInBsMonth(2083, 4)).toBe(31)  // Shrawan
    expect(daysInBsMonth(2083, 5)).toBe(31)  // Bhadra
    expect(daysInBsMonth(2083, 6)).toBe(31)  // Ashwin
    expect(daysInBsMonth(2083, 7)).toBe(30)  // Kartik
    expect(daysInBsMonth(2083, 8)).toBe(29)  // Mangsir
    expect(daysInBsMonth(2083, 9)).toBe(30)  // Poush
    expect(daysInBsMonth(2083, 10)).toBe(29) // Magh
    expect(daysInBsMonth(2083, 11)).toBe(30) // Falgun
    expect(daysInBsMonth(2083, 12)).toBe(30) // Chaitra
  })

  test('falls back to a 30-day approximation outside the covered range', () => {
    expect(daysInBsMonth(2099, 5)).toBe(30)
  })
})

describe('bsToAd / adToBs — anchor and round trip', () => {
  test('the documented anchor holds: BS 2079/01/01 = AD 12 Apr 2022', () => {
    const ad = bsToAd(2079, 1, 1)
    expect(ad.getFullYear()).toBe(2022)
    expect(ad.getMonth()).toBe(3) // 0-indexed: April
    expect(ad.getDate()).toBe(12)
  })

  test('the anchor converts back to itself', () => {
    expect(adToBs(new Date(2022, 3, 12))).toEqual({ year: 2079, month: 1, day: 1 })
  })

  test('round-trips through several BS dates, including a leap-length month', () => {
    const dates = [
      [2079, 1, 1], [2082, 3, 32], [2084, 6, 15], [2087, 12, 30],
    ]
    for (const [y, m, d] of dates) {
      expect(adToBs(bsToAd(y, m, d))).toEqual({ year: y, month: m, day: d })
    }
  })
})

describe('getBsFiscalYear', () => {
  test('Shrawan (month 4) starts the fiscal year it names', () => {
    expect(getBsFiscalYear(2082, 4)).toBe('82/83')
  })

  test('Ashadh (month 3) is still the tail of the PRIOR fiscal year', () => {
    expect(getBsFiscalYear(2082, 3)).toBe('81/82')
  })

  test('Baisakh (month 1) falls inside the fiscal year that started the previous BS year', () => {
    expect(getBsFiscalYear(2083, 1)).toBe('82/83')
  })
})

describe('formatAd', () => {
  test('zero-pads month and day for <input type="date">', () => {
    expect(formatAd(new Date(2026, 0, 5))).toBe('2026-01-05')
    expect(formatAd(new Date(2026, 10, 23))).toBe('2026-11-23')
  })
})

describe('bsAddDays', () => {
  test('rolls into the next month using that month\'s real length', () => {
    // BS 2082 month 1 (Baisakh) has 31 days
    expect(bsAddDays(2082, 1, 31, 1)).toEqual({ year: 2082, month: 2, day: 1 })
  })

  test('rolls across a year boundary', () => {
    // BS 2079 month 12 (Chaitra) has 30 days — the last day of the BS year
    expect(bsAddDays(2079, 12, 30, 1)).toEqual({ year: 2080, month: 1, day: 1 })
  })

  test('negative n subtracts days, rolling back into the prior month', () => {
    expect(bsAddDays(2082, 2, 1, -1)).toEqual({ year: 2082, month: 1, day: 31 })
  })
})

describe('bsDiffDays', () => {
  test('counts days within a single month', () => {
    expect(bsDiffDays(2082, 1, 1, 2082, 1, 31)).toBe(30)
  })

  test('counts a full BS year using the real (variable) year length, not a fixed 365', () => {
    // BS 2082's twelve month-lengths sum to 366, not 365
    expect(bsDiffDays(2082, 1, 1, 2083, 1, 1)).toBe(366)
  })

  test('is negative when the second date is earlier', () => {
    expect(bsDiffDays(2082, 1, 31, 2082, 1, 1)).toBe(-30)
  })
})
