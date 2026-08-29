import { FIXED_HOLIDAYS, MOVABLE_HOLIDAYS, resolveYear, movableForFy } from './holidayData'
import { daysInBsMonth, BS_MONTHS } from '../../../utils/bsCalendar'

// These tables are transcribed from the Nepal Gazette by hand, and Overtime.jsx pays the 2×
// public-holiday rate off what lands in them — so a typo here is a wrong figure on a real payslip,
// not a wrong label on a screen. Nothing below re-derives a date (there is no algorithm to check
// them against); they assert the properties a transcription slip actually breaks.

describe('holiday tables', () => {
  const bsYears = Object.keys(MOVABLE_HOLIDAYS).map(Number)

  it('has at least one transcribed BS year', () => {
    expect(bsYears.length).toBeGreaterThan(0)
  })

  // A day past the end of its month is the classic transcription slip (Ashwin has 31 days in 2083
  // and 30 in 2084, so Fulpati on "Ashwin 31" is valid in one year and impossible in the next).
  // The DB's own CHECK only bounds bs_day at 1..32, so it would accept every one of these.
  it.each(bsYears)('every movable date in BS %i exists in that month', bsYear => {
    MOVABLE_HOLIDAYS[bsYear].forEach(h => {
      const max = daysInBsMonth(bsYear, h.m)
      expect(h.m).toBeGreaterThanOrEqual(1)
      expect(h.m).toBeLessThanOrEqual(12)
      expect(`${h.name}: ${BS_MONTHS[h.m - 1]} ${h.d}`)
        .toBe(`${h.name}: ${BS_MONTHS[h.m - 1]} ${Math.min(Math.max(h.d, 1), max)}`)
    })
  })

  // Names are the seed's dedupe key AND its correction key, so two rows sharing one is a row that
  // can never be seeded and a "correction" that would fight itself on every press.
  it.each(bsYears)('BS %i has no duplicate holiday names', bsYear => {
    const names = MOVABLE_HOLIDAYS[bsYear].map(h => h.name)
    expect(names).toHaveLength(new Set(names).size)
  })

  it('has no name shared between the fixed and movable tables', () => {
    const fixed = new Set(FIXED_HOLIDAYS.map(h => h.name))
    bsYears.forEach(y => MOVABLE_HOLIDAYS[y].forEach(h => {
      expect(fixed.has(h.name)).toBe(false)
    }))
  })

  it('has no duplicate names among the fixed holidays', () => {
    const names = FIXED_HOLIDAYS.map(h => h.name)
    expect(names).toHaveLength(new Set(names).size)
  })

  // Every fixed date has to be reachable in BOTH halves of a fiscal year's calendar, since
  // resolveYear puts Baishakh–Ashadh in the following BS year where month lengths differ.
  it.each([2082, 2083, 2084])('every fixed date exists in FY %i/..', fyYear => {
    FIXED_HOLIDAYS.forEach(h => {
      const bsYear = resolveYear(fyYear, h.bs_month)
      expect(h.bs_day).toBeLessThanOrEqual(daysInBsMonth(bsYear, h.bs_month))
      expect(h.bs_day).toBeGreaterThanOrEqual(1)
    })
  })

  // The one date the whole change exists to correct.
  it("puts Martyrs' Day on Magh 16, not Magh 5", () => {
    const md = FIXED_HOLIDAYS.find(h => h.name.includes('Martyrs'))
    expect(md).toBeDefined()
    expect([md.bs_month, md.bs_day]).toEqual([10, 16])
  })
})

describe('resolveYear', () => {
  it('puts Shrawan onwards in the FY start year', () => {
    expect(resolveYear(2083, 4)).toBe(2083)   // Shrawan
    expect(resolveYear(2083, 12)).toBe(2083)  // Chaitra
  })
  it('puts Baishakh–Ashadh in the following year', () => {
    expect(resolveYear(2083, 1)).toBe(2084)   // Baishakh
    expect(resolveYear(2083, 3)).toBe(2084)   // Ashadh
  })
})

describe('movableForFy', () => {
  it('draws Shrawan onwards from the FY year and stamps the right bs_year', () => {
    const { rows } = movableForFy(2083)
    const dashain = rows.find(h => h.name === 'Bijaya Dashami (Dashain)')
    expect(dashain).toMatchObject({ m: 7, d: 4, bs_year: 2083 })
    expect(rows.every(h => (h.bs_year === 2083 ? h.m >= 4 : h.m <= 3))).toBe(true)
  })

  it('excludes the FY year\'s own Baishakh–Ashadh, which belong to the PREVIOUS fiscal year', () => {
    const { rows } = movableForFy(2083)
    // Buddha Jayanti is Baishakh 18 2083 — inside BS 2083 but inside FY 2082/83.
    expect(rows.find(h => h.name.startsWith('Buddha Jayanti'))).toBeUndefined()
    expect(movableForFy(2082).rows.find(h => h.name.startsWith('Buddha Jayanti')))
      .toMatchObject({ m: 1, d: 18, bs_year: 2083 })
  })

  // The reporting half matters as much as the rows: an FY whose second BS year has not been
  // gazetted yet must come back NAMED, so the page can say the tail is uncovered instead of
  // seeding short and looking complete.
  it('reports a BS year it holds no table for', () => {
    expect(movableForFy(2083).missing).toEqual([2084])
    expect(movableForFy(2082).missing).toEqual([2082])
    expect(movableForFy(2090).missing).toEqual([2090, 2091])
  })
})

describe('legacy names', () => {
  // A rename in FIXED_HOLIDAYS is only safe because the seed also matches the old name. If a name
  // is ever changed without adding the previous one here, every client who seeded before the
  // change gets a second row on the same day and no error anywhere.
  it('never lets a legacy name collide with a current one', () => {
    const current = new Set(FIXED_HOLIDAYS.map(h => h.name))
    FIXED_HOLIDAYS.forEach(h => (h.legacy || []).forEach(n => {
      expect(current.has(n)).toBe(false)
    }))
  })

  it('keeps the pre-S635 name for the one fixed holiday that was renamed', () => {
    const pj = FIXED_HOLIDAYS.find(h => h.name.startsWith('Prithvi'))
    expect(pj.legacy).toContain("Prithvi Narayan Shah's Birthday")
  })
})
