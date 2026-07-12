import {
  fiscalYearOf, slabsFor, applySlabs, computeMonthlyTds, computeBonusTds,
  SLABS_2083_84, SLABS_2082_83_SINGLE, SLABS_2082_83_MARRIED,
} from './tds'

describe('fiscalYearOf', () => {
  test('Shrawan (month 4) starts a new fiscal year, as month 1 of it', () => {
    expect(fiscalYearOf(2082, 4)).toEqual({ fyStart: 2082, monthInFy: 1 })
  })

  test('Ashadh (month 3) is the last month (12) of the PRIOR fiscal year', () => {
    expect(fiscalYearOf(2082, 3)).toEqual({ fyStart: 2081, monthInFy: 12 })
  })

  test('Baisakh (month 1) is month 10 of the fiscal year that started the prior BS year', () => {
    expect(fiscalYearOf(2083, 1)).toEqual({ fyStart: 2082, monthInFy: 10 })
  })
})

describe('slabsFor', () => {
  test('FY 2083/84 onward uses the unified schedule regardless of marital status', () => {
    expect(slabsFor(2083, false)).toBe(SLABS_2083_84)
    expect(slabsFor(2083, true)).toBe(SLABS_2083_84)
  })

  test('FY 2082/83 and earlier still splits by marital status', () => {
    expect(slabsFor(2082, false)).toBe(SLABS_2082_83_SINGLE)
    expect(slabsFor(2082, true)).toBe(SLABS_2082_83_MARRIED)
  })
})

describe('applySlabs', () => {
  test('taxable income within the first band only pays that band\'s rate', () => {
    expect(applySlabs(500000, SLABS_2083_84, false)).toBe(5000) // 500,000 * 1%
  })

  test('SSF contributors get the first (1%) slab waived entirely', () => {
    expect(applySlabs(500000, SLABS_2083_84, true)).toBe(0)
  })

  test('income spanning multiple bands is taxed marginally, not at the top rate', () => {
    // 1,000,000 @ 1% + 500,000 @ 10% + 500,000 @ 20% = 10,000 + 50,000 + 100,000
    expect(applySlabs(2000000, SLABS_2083_84, false)).toBe(160000)
  })

  test('the marginal calculation still waives only the first band for SSF contributors', () => {
    // same as above minus the waived 10,000 first-band tax
    expect(applySlabs(2000000, SLABS_2083_84, true)).toBe(150000)
  })
})

describe('computeMonthlyTds', () => {
  const period = { bs_year: 2083, bs_month: 4 } // Shrawan = month 1 of FY 2083/84

  test('projects annual income from a steady monthly gross and returns this month\'s share', () => {
    const tds = computeMonthlyTds({ period, monthlyGross: 100000, monthlySsf: 0 })
    // annualGross = 100,000 * 12 = 1,200,000 -> annualTax = 30,000 -> month 1 of 12 = 2,500
    expect(tds).toBe(2500)
  })

  test('is self-correcting: steady income yields the same monthly TDS every month', () => {
    const month1 = computeMonthlyTds({ period, monthlyGross: 100000, monthlySsf: 0 })
    const month2 = computeMonthlyTds({
      period: { bs_year: 2083, bs_month: 5 },
      monthlyGross: 100000, monthlySsf: 0,
      ytdGross: 100000, ytdSsf: 0, ytdWithheld: month1,
    })
    expect(month2).toBe(month1)
  })

  test('never returns a negative TDS even if prior withholding overshot the projection', () => {
    const tds = computeMonthlyTds({
      period, monthlyGross: 100000, monthlySsf: 0, ytdWithheld: 999999,
    })
    expect(tds).toBe(0)
  })

  test('a mid-year joiner is taxed over the months they actually work, not front-loaded', () => {
    // Hired in FY month 7 (bs_month 10 -> monthInFy 7) — ytdMonths=0 (no prior payslips),
    // monthsAtCurrent=6 (months 7..12 of the FY remain, including this one).
    const hirePeriod = { bs_year: 2083, bs_month: 10 }
    const month1 = computeMonthlyTds({
      period: hirePeriod, monthlyGross: 100000, monthlySsf: 0, ytdMonths: 0,
    })
    // annualGross = 100,000 * 6 = 600,000 -> annualTax = 6,000 -> spread over 6 employed months
    // (not 12) -> 1,000/month, not front-loaded to 7/12 of the year's tax.
    expect(month1).toBe(1000)
  })

  test('a mid-year joiner reaches the same steady monthly TDS as a full-year employee with equal pay', () => {
    const month1 = computeMonthlyTds({
      period: { bs_year: 2083, bs_month: 10 }, monthlyGross: 100000, monthlySsf: 0, ytdMonths: 0,
    })
    const month2 = computeMonthlyTds({
      period: { bs_year: 2083, bs_month: 11 }, monthlyGross: 100000, monthlySsf: 0,
      ytdGross: 100000, ytdWithheld: month1, ytdMonths: 1,
    })
    expect(month2).toBe(month1)
  })
})

describe('computeBonusTds', () => {
  test('taxes a lump-sum bonus at the marginal rate on top of projected annual income', () => {
    // annualTaxable 1,200,000 -> tax 30,000; +100,000 bonus -> taxable 1,300,000 -> tax 40,000
    const tds = computeBonusTds({ annualTaxable: 1200000, bonusAmount: 100000, fyStart: 2083 })
    expect(tds).toBe(10000)
  })

  test('a zero or negative bonus owes no tax', () => {
    expect(computeBonusTds({ annualTaxable: 1200000, bonusAmount: 0, fyStart: 2083 })).toBe(0)
    expect(computeBonusTds({ annualTaxable: 1200000, bonusAmount: -500, fyStart: 2083 })).toBe(0)
  })
})
