import {
  daysInBsMonth, bsToAd, adToBs, adToBsSafe, getBsFiscalYear, formatAd, bsAddDays, bsDiffDays,
  BS_YEAR_MIN, BS_YEAR_MAX, BS_MONTHS, BS_MONTHS_SHORT, bsDayOrdinal, formatBsDay, formatAdAsBs,
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

// Reality anchors: Baisakh 1 (Nepali New Year) for EVERY BS year 2000-2083 (docs/CROSS-REPO.md,
// 2026-09-02). The round-trip sweep below proves adToBs/bsToAd are a bijection over the table, not
// that the table is right — both directions read the same BS_CALENDAR, so a mistyped month length
// round-trips perfectly. One anchor per year localizes a bad row to that year, and catches a
// compensating pair (+1 in one month, -1 in another) that spans a year boundary.
//
// Sourced 2026-09-14 INDEPENDENTLY of bsCalendar.js — read from each site's published calendar,
// never computed from this table:
//   - hamropatro.com, nepalicalendar.rat32.com, ashesh.com.np, nepcal.com, englishtonepali.com:
//     all five agree on all 84 years.
//   - nepalicalendar.org agrees on 83/84; it gives 2057 as 2000-04-14, but its own Chaitra 2056
//     page leaves 2000-04-13 with no BS date, so 2000-04-13 stands (also mypatro.com).
//   - 2072-2083 are additionally confirmed by timeanddate.com, calendarific.com and
//     officeholidays.com, which publish Nepali New Year as a holiday date.
// CAVEAT: for 2000-2071 the calendar sites very likely share one widely circulated table, so those
// anchors prove agreement with the published calendar, not with a primary gazette source.
// 2084-2087 are deliberately absent: they are extrapolations (see .claude/rules/bs-calendar.md).
describe('Baisakh 1 reality anchors, every BS year 2000-2083', () => {
  const NEW_YEAR = [
    [2000, '1943-04-14'], [2001, '1944-04-13'], [2002, '1945-04-13'], [2003, '1946-04-13'],
    [2004, '1947-04-14'], [2005, '1948-04-13'], [2006, '1949-04-13'], [2007, '1950-04-13'],
    [2008, '1951-04-14'], [2009, '1952-04-13'], [2010, '1953-04-13'], [2011, '1954-04-13'],
    [2012, '1955-04-14'], [2013, '1956-04-13'], [2014, '1957-04-13'], [2015, '1958-04-13'],
    [2016, '1959-04-14'], [2017, '1960-04-13'], [2018, '1961-04-13'], [2019, '1962-04-13'],
    [2020, '1963-04-14'], [2021, '1964-04-13'], [2022, '1965-04-13'], [2023, '1966-04-13'],
    [2024, '1967-04-14'], [2025, '1968-04-13'], [2026, '1969-04-13'], [2027, '1970-04-14'],
    [2028, '1971-04-14'], [2029, '1972-04-13'], [2030, '1973-04-13'], [2031, '1974-04-14'],
    [2032, '1975-04-14'], [2033, '1976-04-13'], [2034, '1977-04-13'], [2035, '1978-04-14'],
    [2036, '1979-04-14'], [2037, '1980-04-13'], [2038, '1981-04-13'], [2039, '1982-04-14'],
    [2040, '1983-04-14'], [2041, '1984-04-13'], [2042, '1985-04-13'], [2043, '1986-04-14'],
    [2044, '1987-04-14'], [2045, '1988-04-13'], [2046, '1989-04-13'], [2047, '1990-04-14'],
    [2048, '1991-04-14'], [2049, '1992-04-13'], [2050, '1993-04-13'], [2051, '1994-04-14'],
    [2052, '1995-04-14'], [2053, '1996-04-13'], [2054, '1997-04-13'], [2055, '1998-04-14'],
    [2056, '1999-04-14'], [2057, '2000-04-13'], [2058, '2001-04-14'], [2059, '2002-04-14'],
    [2060, '2003-04-14'], [2061, '2004-04-13'], [2062, '2005-04-14'], [2063, '2006-04-14'],
    [2064, '2007-04-14'], [2065, '2008-04-13'], [2066, '2009-04-14'], [2067, '2010-04-14'],
    [2068, '2011-04-14'], [2069, '2012-04-13'], [2070, '2013-04-14'], [2071, '2014-04-14'],
    [2072, '2015-04-14'], [2073, '2016-04-13'], [2074, '2017-04-14'], [2075, '2018-04-14'],
    [2076, '2019-04-14'], [2077, '2020-04-13'], [2078, '2021-04-14'], [2079, '2022-04-14'],
    [2080, '2023-04-14'], [2081, '2024-04-13'], [2082, '2025-04-14'], [2083, '2026-04-14'],
  ]

  test('covers every year from 2000 to 2083 exactly once', () => {
    expect(NEW_YEAR.map(([y]) => y)).toEqual(Array.from({ length: 84 }, (_, i) => 2000 + i))
  })

  test.each(NEW_YEAR)('Baisakh 1, %i BS = %s', (year, ad) => {
    expect(formatAd(bsToAd(year, 1, 1))).toBe(ad)
    expect(adToBsSafe(d(ad))).toEqual({ year, month: 1, day: 1 })
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

// S709 — the display half of the storage convention. A date is picked in BS, stored as AD, and had
// been read back raw on Purchase Orders' Expected Delivery: in the list, and on the printed order
// the supplier receives.
describe('formatAdAsBs', () => {
  test('renders a stored AD date as the BS date it was picked as', () => {
    // The round trip its callers actually make: BsCalendarPicker commits formatAd(bsToAd(...)).
    expect(formatAdAsBs(formatAd(bsToAd(2082, 5, 15)))).toBe('15 Bhadra 2082')
    expect(formatAdAsBs(formatAd(bsToAd(2082, 1, 1)))).toBe('1 Baisakh 2082')
    expect(formatAdAsBs(formatAd(bsToAd(2083, 12, 30)))).toBe('30 Chaitra 2083')
  })

  test('parses a bare YYYY-MM-DD at LOCAL midnight, not UTC', () => {
    // new Date('2025-08-31') is UTC midnight, which at Nepal's +05:45 is still the 30th — the same
    // off-by-one formatAd exists to prevent on the way in. Both spellings must agree.
    expect(formatAdAsBs('2025-08-31')).toBe(formatAdAsBs('2025-08-31T00:00:00'))
  })

  test('falls back to the truthful AD value outside the verified table, labelled as AD', () => {
    expect(formatAdAsBs('1901-01-01')).toBe('1901-01-01 (AD)')
    expect(formatAdAsBs('2200-01-01')).toBe('2200-01-01 (AD)')
  })

  test('renders the caller\'s own dash for an absent date', () => {
    expect(formatAdAsBs(null)).toBe('—')
    expect(formatAdAsBs('')).toBe('—')
    expect(formatAdAsBs(undefined, { fallback: 'not set' })).toBe('not set')
  })
})
