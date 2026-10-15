import {
  upcomingOccasions, customerIdsWithOccasion, windowDays, occasionDatesOf, maxDayOf, adDaysInMonth,
  daysAwayLabel, occasionWhat, occasionDayLabel, occasionWish, storedDateLabel,
} from './occasions'

// S843: birthdays and anniversaries in the next N days. Calendar facts used below, from the verified
// table: 2026-10-15 is 29 Ashwin 2083, a Thursday; Ashwin 2083 has 31 days and Kartik 2083 has 30;
// Chaitra 2083 has 30 days, so 28 Chaitra is three days before 1 Baisakh 2084 (2027-04-14);
// 2026-12-28 is 13 Poush 2083; 2027-02-26 is 14 Falgun 2083 and 2028-02-26 is 14 Falgun 2084.

const ASHWIN_29 = { year: 2083, month: 6, day: 29 }
const AGREED = '2026-10-01T04:00:00+00:00'

function bs(id, name, month, day, year = null, extra = {}) {
  return { id, name, phone: '9800000000', consent_at: AGREED, birth_month: month, birth_day: day, birth_year: year, birth_calendar: 'BS', ...extra }
}
function ad(id, name, month, day, year = null, extra = {}) {
  return { id, name, phone: '9800000000', consent_at: AGREED, birth_month: month, birth_day: day, birth_year: year, birth_calendar: 'AD', ...extra }
}
const days = items => items.map(i => [i.name, i.daysAway])

describe('windowDays', () => {
  test('today is day 0, and the days walk through the end of a BS month', () => {
    const w = windowDays(ASHWIN_29, 4)
    expect(w.map(x => [x.bs.month, x.bs.day])).toEqual([[6, 29], [6, 30], [6, 31], [7, 1]])
    expect(w.map(x => x.i)).toEqual([0, 1, 2, 3])
    expect(w[0].ad.getFullYear()).toBe(2026)
    expect(w[0].ad.getMonth()).toBe(9)
    expect(w[0].ad.getDate()).toBe(15)
    expect(w[3].ad.getDate()).toBe(18)
  })

  test('Chaitra rolls into Baisakh of the next BS year', () => {
    const w = windowDays({ year: 2083, month: 12, day: 28 }, 5)
    expect(w.map(x => `${x.bs.year}-${x.bs.month}-${x.bs.day}`)).toEqual(['2083-12-28', '2083-12-29', '2083-12-30', '2084-1-1', '2084-1-2'])
    expect([w[3].ad.getFullYear(), w[3].ad.getMonth() + 1, w[3].ad.getDate()]).toEqual([2027, 4, 14])
  })

  test('no days, or no today, is an empty window', () => {
    expect(windowDays(ASHWIN_29, 0)).toEqual([])
    expect(windowDays(null, 7)).toEqual([])
  })
})

describe('upcomingOccasions — Nepali (BS) dates', () => {
  test('today, a few days on, and outside a 7-day window but inside 30', () => {
    const rows = [bs('a', 'Asha', 6, 29), bs('b', 'Bina', 7, 1), bs('c', 'Chandra', 7, 10)]
    expect(days(upcomingOccasions(rows, 7, ASHWIN_29))).toEqual([['Asha', 0], ['Bina', 3]])
    expect(days(upcomingOccasions(rows, 30, ASHWIN_29))).toEqual([['Asha', 0], ['Bina', 3], ['Chandra', 12]])
  })

  test('7 days is today and the six after it', () => {
    const rows = [bs('a', 'Day six', 7, 4), bs('b', 'Day seven', 7, 5)]
    expect(days(upcomingOccasions(rows, 7, ASHWIN_29))).toEqual([['Day six', 6]])
    expect(days(upcomingOccasions(rows, 8, ASHWIN_29))).toEqual([['Day six', 6], ['Day seven', 7]])
  })

  test('a day past the month\'s length falls on its last day', () => {
    // Ashwin 2083 has 31 days, so a stored 32 Ashwin is the 31st, two days away.
    expect(days(upcomingOccasions([bs('a', 'Asha', 6, 32)], 7, ASHWIN_29))).toEqual([['Asha', 2]])
    // Kartik 2083 has 30 days, so a stored 31 Kartik is 30 Kartik: 2 days of Ashwin left + 30.
    expect(days(upcomingOccasions([bs('a', 'Asha', 7, 31)], 40, ASHWIN_29))).toEqual([['Asha', 32]])
  })

  test('across Chaitra into Baisakh, the age counted against the new BS year', () => {
    const rows = [bs('a', 'Asha', 1, 1, 2050), bs('b', 'Bina', 12, 30, 2050)]
    const items = upcomingOccasions(rows, 7, { year: 2083, month: 12, day: 28 })
    expect(days(items)).toEqual([['Bina', 2], ['Asha', 3]])
    expect(items.find(i => i.name === 'Bina').years).toBe(33) // 30 Chaitra 2083
    expect(items.find(i => i.name === 'Asha').years).toBe(34) // 1 Baisakh 2084
    expect(items.find(i => i.name === 'Asha').adIso).toBe('2027-04-14')
  })
})

describe('upcomingOccasions — English (AD) dates', () => {
  test('across December into January, the age counted against the AD year', () => {
    const rows = [ad('a', 'Asha', 1, 2, 1990), ad('b', 'Bina', 12, 30, 1990)]
    const items = upcomingOccasions(rows, 7, { year: 2083, month: 9, day: 13 }) // 2026-12-28
    expect(days(items)).toEqual([['Bina', 2], ['Asha', 5]])
    expect(items[0].years).toBe(36)
    expect(items[1].years).toBe(37)
    expect(items[1].adIso).toBe('2027-01-02')
    expect(items[1].weekday).toBe('Saturday')
  })

  test('29 February falls on the 28th in a year without one, and on the 29th in a leap year', () => {
    const rows = [ad('a', 'Leap', 2, 29)]
    const plain = upcomingOccasions(rows, 7, { year: 2083, month: 11, day: 14 }) // 2027-02-26
    expect(days(plain)).toEqual([['Leap', 2]])
    expect(plain[0].adIso).toBe('2027-02-28')
    const leap = upcomingOccasions(rows, 7, { year: 2084, month: 11, day: 14 }) // 2028-02-26
    expect(days(leap)).toEqual([['Leap', 3]])
    expect(leap[0].adIso).toBe('2028-02-29')
  })
})

describe('upcomingOccasions — what is listed, and in what order', () => {
  test('no year stored, or a year not yet passed, gives no age', () => {
    const items = upcomingOccasions([bs('a', 'Asha', 6, 29), bs('b', 'Bina', 6, 29, 2090)], 7, ASHWIN_29)
    expect(items.map(i => i.years)).toEqual([null, null])
  })

  test('a customer who has not agreed is never listed, whatever is stored', () => {
    const rows = [bs('a', 'Asha', 6, 29, null, { consent_at: null })]
    expect(upcomingOccasions(rows, 7, ASHWIN_29)).toEqual([])
  })

  test('a date missing its calendar or day is skipped', () => {
    const rows = [
      bs('a', 'No calendar', 6, 29, null, { birth_calendar: null }),
      bs('b', 'No day', 6, null),
    ]
    expect(upcomingOccasions(rows, 7, ASHWIN_29)).toEqual([])
  })

  test('sorted by days away, then name; a birthday before an anniversary on the same day', () => {
    const rows = [
      bs('z', 'zoe', 6, 30),
      { ...bs('b', 'Bina', 6, 29), anniv_month: 6, anniv_day: 29, anniv_year: 2075, anniv_calendar: 'BS' },
      bs('a', 'Asha', 6, 30),
    ]
    const items = upcomingOccasions(rows, 7, ASHWIN_29)
    expect(items.map(i => `${i.name}:${i.kind}:${i.daysAway}`)).toEqual([
      'Bina:birthday:0', 'Bina:anniversary:0', 'Asha:birthday:1', 'zoe:birthday:1',
    ])
    expect(items[1].years).toBe(8)
    expect(items[1].key).toBe('b:anniversary')
  })

  test('the ids with something coming up', () => {
    const rows = [bs('a', 'Asha', 6, 29), bs('b', 'Bina', 8, 1)]
    expect([...customerIdsWithOccasion(rows, 7, ASHWIN_29)]).toEqual(['a'])
  })
})

describe('the dates a customer row holds', () => {
  test('both kinds, with the year as a number or null', () => {
    const c = { ...bs('a', 'Asha', 6, 29, 2050), anniv_month: 2, anniv_day: 14, anniv_year: null, anniv_calendar: 'AD' }
    expect(occasionDatesOf(c)).toEqual([
      { kind: 'birthday', calendar: 'BS', month: 6, day: 29, year: 2050 },
      { kind: 'anniversary', calendar: 'AD', month: 2, day: 14, year: null },
    ])
  })

  test('the longest a month can be, as the form offers it', () => {
    expect(maxDayOf('BS', 6)).toBe(32)          // no year: any BS year
    expect(maxDayOf('BS', 3, 2083)).toBe(32)    // Asar 2083
    expect(maxDayOf('BS', 7, 2083)).toBe(30)    // Kartik 2083
    expect(maxDayOf('BS', 7, 2200)).toBe(32)    // past the verified table
    expect(maxDayOf('AD', 2)).toBe(29)
    expect(maxDayOf('AD', 2, 2027)).toBe(28)
    expect(maxDayOf('AD', 2, 2028)).toBe(29)
    expect(maxDayOf('AD', 4)).toBe(30)
    expect(adDaysInMonth(12)).toBe(31)
  })

  test('a stored date in words', () => {
    expect(storedDateLabel({ calendar: 'BS', month: 6, day: 29, year: 2050 })).toBe('29 Ashwin 2050 (BS)')
    expect(storedDateLabel({ calendar: 'AD', month: 3, day: 14, year: null })).toBe('14 March (AD)')
  })
})

describe('the words on a row', () => {
  test('days away', () => {
    expect(daysAwayLabel(0)).toBe('today')
    expect(daysAwayLabel(1)).toBe('tomorrow')
    expect(daysAwayLabel(5)).toBe('in 5 days')
  })

  test('what it is, and the day in BS with its weekday', () => {
    const [today] = upcomingOccasions([bs('a', 'Asha Rai', 6, 29, 2053)], 7, ASHWIN_29)
    expect(occasionWhat(today)).toBe('Birthday · turns 30')
    expect(occasionDayLabel(today)).toBe('Thursday, 29 Ashwin')
    expect(occasionWhat({ kind: 'anniversary', years: 1 })).toBe('Anniversary · 1 year')
    expect(occasionWhat({ kind: 'anniversary', years: null })).toBe('Anniversary')
  })

  test('the wish names the first name and the outlet, and says the day when it is not today', () => {
    const [today] = upcomingOccasions([bs('a', 'Asha Rai', 6, 29)], 7, ASHWIN_29)
    expect(occasionWish(today, 'Bloom Cafe')).toBe('Happy birthday, Asha! Warm wishes from all of us at Bloom Cafe. We would love to celebrate with you.')
    const [later] = upcomingOccasions([{ ...bs('b', 'Bina', 1, 1), birth_month: null, anniv_month: 7, anniv_day: 1, anniv_calendar: 'BS' }], 7, ASHWIN_29)
    expect(occasionWish(later)).toBe('Wishing you a very happy anniversary, Bina, coming up on Sunday, 1 Kartik! Warm wishes. We would love to celebrate with you.')
  })
})
