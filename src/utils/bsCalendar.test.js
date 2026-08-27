import {
  daysInBsMonth, bsToAd, adToBs, adToBsSafe, getBsFiscalYear, formatAd, bsAddDays, bsDiffDays,
  BS_YEAR_MIN, BS_YEAR_MAX, BS_MONTHS, BS_MONTHS_SHORT, bsDayOrdinal, formatBsDay,
} from './bsCalendar'

const d = s => new Date(s + 'T00:00:00')

describe('daysInBsMonth', () => {
  test('reads the real month-length table, not a fixed 30/31', () => {
    expect(daysInBsMonth(2082, 1)).toBe(31)
    expect(daysInBsMonth(2082, 3)).toBe(32)
    expect(daysInBsMonth(2082, 9)).toBe(30)
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
  // Corrected S352 (2026-07-11): the anchor was 2 days off (12 Apr instead of 14 Apr) — see the
  // note above BS_CALENDAR in bsCalendar.js. 14 April 2022 is the well-documented date Nepali New
  // Year 2079 actually fell on (a Thursday), reproduced independently via two open-source
  // calendar libraries' data.
  test('the documented anchor holds: BS 2079/01/01 = AD 14 Apr 2022', () => {
    const ad = bsToAd(2079, 1, 1)
    expect(ad.getFullYear()).toBe(2022)
    expect(ad.getMonth()).toBe(3) // 0-indexed: April
    expect(ad.getDate()).toBe(14)
  })

  test('the anchor converts back to itself', () => {
    expect(adToBs(new Date(2022, 3, 14))).toEqual({ year: 2079, month: 1, day: 1 })
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
    // BS 2081's twelve month-lengths sum to 366, not 365
    expect(bsDiffDays(2081, 1, 1, 2082, 1, 1)).toBe(366)
  })

  test('is negative when the second date is earlier', () => {
    expect(bsDiffDays(2082, 1, 31, 2082, 1, 1)).toBe(-30)
  })
})

// Table extended back to 2000 BS (2026-08-15) so dates of birth and historic joining dates convert
// correctly — see the note above BS_CALENDAR in bsCalendar.js. BS_CALENDAR is data, not logic: a
// single mistyped month length shifts every date after it by a day and nothing else in the app
// would notice. That has happened three times already for the pre-extension table (S347/S349/S352).
// The anchors below are externally verifiable facts, and the round-trip sweep is what actually
// catches a bad row.
describe('BS <-> AD anchors (2000 BS extension)', () => {
  // Each of these is checkable against any public Nepali date converter.
  const ANCHORS = [
    ['1943-04-14', 2000, 1, 1, 'Baisakh 1, 2000 BS — the first year in the table'],
    ['1979-12-30', 2036, 9, 15, '15 Poush 2036 — a date of birth, the case that exposed the old bug'],
    ['2022-04-14', 2079, 1, 1, 'Baisakh 1, 2079 — Nepali New Year, a well-documented Thursday'],
    ['2026-08-13', 2083, 4, 28, 'a present-day date that was already correct before the table grew'],
  ]

  test.each(ANCHORS)('%s <-> %i/%i/%i (%s)', (ad, year, month, day) => {
    expect(adToBs(d(ad))).toEqual({ year, month, day })
    expect(formatAd(bsToAd(year, month, day))).toBe(ad)
  })

  test('Baisakh 1, 2079 fell on a Thursday', () => {
    expect(bsToAd(2079, 1, 1).getDay()).toBe(4)
  })
})

// adToBsSafe() (added 2026-08-15 as a follow-up to the table extension) is what actually closes the
// bug: BS_CALENDAR being complete doesn't help a caller that still calls the unguarded adToBs() and
// trusts whatever it returns. Ported verbatim from the sister HSS app, which shipped this the same
// way — see the note above BS_YEAR_MIN/BS_YEAR_MAX in bsCalendar.js.
describe('adToBsSafe guard', () => {
  test('covers dates of birth, not just recent transactions', () => {
    expect(BS_YEAR_MIN).toBe(2000)
    expect(BS_YEAR_MAX).toBe(2087)
  })

  test('agrees with adToBs() inside the verified range', () => {
    expect(adToBsSafe(d('1979-12-30'))).toEqual({ year: 2036, month: 9, day: 15 })
    expect(adToBsSafe(d('2026-08-13'))).toEqual({ year: 2083, month: 4, day: 28 })
  })

  // The whole point of adToBsSafe: outside the table adToBs returns a confident WRONG answer
  // rather than throwing, so anything that displays a converted date must get null instead.
  test('returns null outside the table, where adToBs would still answer', () => {
    const tooOld = d('1943-04-13') // one day before the table starts
    expect(adToBs(tooOld)).toBeTruthy()
    expect(adToBsSafe(tooOld)).toBeNull()
  })

  test('rejects an invalid date rather than guessing', () => {
    expect(adToBsSafe(new Date('nonsense'))).toBeNull()
  })

  test('accepts a date-like value (string/number), not only a Date instance', () => {
    expect(adToBsSafe('2022-04-14')).toEqual({ year: 2079, month: 1, day: 1 })
  })
})

describe('table integrity (2000-2087)', () => {
  // A BS year is always 365 or 366 days. A mistyped month length usually breaks this immediately.
  test('every year in the table is 365 or 366 days', () => {
    for (let y = 2000; y <= 2087; y++) {
      const len = Math.round((bsToAd(y + 1, 1, 1) - bsToAd(y, 1, 1)) / 86400000)
      expect([365, 366]).toContain(len)
    }
  })

  // The real guard: walk every single day across the whole range and require a clean round trip.
  // One wrong month length anywhere shows up here as thousands of failures.
  test('every day from 1943 to 2031 round-trips AD -> BS -> AD', () => {
    let checked = 0
    for (const t = d('1943-04-14'); t < d('2031-01-01'); t.setDate(t.getDate() + 1)) {
      const bs = adToBsSafe(t)
      expect(bs).not.toBeNull()
      expect(formatAd(bsToAd(bs.year, bs.month, bs.day))).toBe(formatAd(t))
      checked++
    }
    expect(checked).toBeGreaterThan(32000)
  })

  test('consecutive AD days map to consecutive BS days across a month boundary', () => {
    // Poush 2036 has 30 days in the table; 30 Poush -> 1 Magh must be one AD day apart.
    expect(formatAd(bsToAd(2036, 10, 1))).toBe(
      formatAd(new Date(bsToAd(2036, 9, 30).getTime() + 86400000))
    )
  })
})

describe('BS_MONTHS_SHORT', () => {
  it('has one label per month, in the same order', () => {
    expect(BS_MONTHS_SHORT).toHaveLength(BS_MONTHS.length)
    BS_MONTHS_SHORT.forEach((short, i) => {
      expect(BS_MONTHS[i].startsWith(short)).toBe(true)
    })
  })

  // The whole reason this array exists: BS_MONTHS[i].slice(0, 3) renders both Ashadh and Ashwin
  // as "Ash", so an 11-month chart axis showed two different months under one label.
  it('is unique, so no two months can share an axis label', () => {
    expect(new Set(BS_MONTHS_SHORT).size).toBe(BS_MONTHS_SHORT.length)
  })
})

describe('bsDayOrdinal / formatBsDay', () => {
  test('BS months run to 32 days, so the 11-13 exception has to be real', () => {
    expect(bsDayOrdinal(1)).toBe('1st')
    expect(bsDayOrdinal(2)).toBe('2nd')
    expect(bsDayOrdinal(3)).toBe('3rd')
    expect(bsDayOrdinal(4)).toBe('4th')
    expect(bsDayOrdinal(11)).toBe('11th')
    expect(bsDayOrdinal(12)).toBe('12th')
    expect(bsDayOrdinal(13)).toBe('13th')
    expect(bsDayOrdinal(21)).toBe('21st')
    expect(bsDayOrdinal(22)).toBe('22nd')
    expect(bsDayOrdinal(31)).toBe('31st')
    expect(bsDayOrdinal(32)).toBe('32nd')
  })

  test('names the month a period-scoped Day column was leaning on its header to supply', () => {
    expect(formatBsDay(1, 5)).toBe('1st Bhadra')
    expect(formatBsDay(22, 9)).toBe('22nd Poush')
  })

  // Degrade to the bare ordinal rather than naming the WRONG month: a caller with no period
  // loaded yet passes undefined, and BS_MONTHS[-1] / BS_MONTHS[12] are both undefined.
  test('an absent or out-of-range month drops the name instead of inventing one', () => {
    expect(formatBsDay(1)).toBe('1st')
    expect(formatBsDay(1, 0)).toBe('1st')
    expect(formatBsDay(1, 13)).toBe('1st')
  })

  // Day 0 is Sales' Bulk-entry sentinel, and every caller renders its own dash for it.
  test('returns empty for day 0 and for junk', () => {
    expect(formatBsDay(0, 5)).toBe('')
    expect(formatBsDay(null, 5)).toBe('')
    expect(formatBsDay(undefined, 5)).toBe('')
    expect(bsDayOrdinal('')).toBe('')
  })
})
