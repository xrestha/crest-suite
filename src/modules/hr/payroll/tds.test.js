import {
  fiscalYearOf, slabsFor, applySlabs, computeMonthlyTds, computeBonusTds, computeMonthlyTdsBreakdown, retirementRelief,
  projectBonusTaxableBase,
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

// S748 — CIT / provident fund comes off taxable income, in ONE bucket with SSF.
describe('retirement relief (SSF + CIT share a cap)', () => {
  const period = { bs_year: 2083, bs_month: 4 } // Shrawan 2083 — month 1 of FY 2083/84

  test('a CIT contribution lowers TDS', () => {
    // 150,000/month → 18,00,000/yr. Without relief: 10,000 + 50,000 + 60,000 = 1,20,000 → 10,000/month.
    const without = computeMonthlyTds({ period, monthlyGross: 150000, monthlySsf: 0 })
    // CIT 10,000/month → 1,20,000/yr deducted → taxable 16,80,000 → 10,000 + 50,000 + 36,000 = 96,000.
    const withCit = computeMonthlyTds({ period, monthlyGross: 150000, monthlySsf: 0, monthlyRetirement: 10000 })
    expect(without).toBe(10000)
    expect(withCit).toBe(8000)
  })

  test('SSF and CIT together are capped at a third of annual income, not each', () => {
    const b = computeMonthlyTdsBreakdown({
      period, monthlyGross: 100000, monthlySsf: 11000, monthlyRetirement: 30000, isSsf: true,
    })
    // 1,32,000 SSF + 3,60,000 CIT = 4,92,000, capped at 12,00,000 / 3 = 4,00,000.
    expect(b.retirementDeduction).toBe(400000)
    expect(b.annualTaxable).toBe(800000)
  })

  test('the absolute NPR 5,00,000 cap applies to the combined figure', () => {
    expect(retirementRelief(900000, 3000000)).toBe(500000)
    expect(retirementRelief(120000, 1800000)).toBe(120000)
    expect(retirementRelief(0, 1800000)).toBe(0)
  })

  test('prior months’ CIT counts toward the year', () => {
    const b = computeMonthlyTdsBreakdown({
      period: { bs_year: 2083, bs_month: 6 }, // month 3
      monthlyGross: 150000, monthlySsf: 0, monthlyRetirement: 10000,
      ytdGross: 300000, ytdRetirement: 20000, ytdMonths: 2,
    })
    expect(b.annualOtherRetirement).toBe(20000 + 10000 * 10)
  })
})

// S750 — Festival Allowance and Incentive Run tax a bonus on ONE projected base.
describe('projectBonusTaxableBase', () => {
  // The arithmetic both pages carried inline before, SSF only.
  const oldSsfOnly = ({ basic, ytd, isSsf, life = 0, health = 0 }) => {
    const remaining = Math.max(0, 12 - (ytd?.months || 0))
    const projGross = (ytd?.gross || 0) + basic * remaining
    const projSsf = (ytd?.ssf || 0) + (isSsf ? Math.min(basic, 100000) * 0.11 * remaining : 0)
    const ssfDed = Math.min(projSsf, Math.min(500000, projGross / 3))
    return Math.max(0, projGross - ssfDed - Math.min(life, 40000) - Math.min(health, 20000))
  }

  test('with no CIT it equals the old SSF-only projection exactly', () => {
    const cases = [
      { basic: 25000, ytd: undefined, isSsf: false },
      { basic: 25000, ytd: { gross: 75000, ssf: 8250, months: 3 }, isSsf: true, life: 50000, health: 10000 },
      { basic: 180000, ytd: { gross: 900000, ssf: 55000, months: 5 }, isSsf: true },
    ]
    for (const c of cases) {
      expect(projectBonusTaxableBase({
        basic: c.basic, ytd: c.ytd,
        monthlySsf: c.isSsf ? Math.min(c.basic, 100000) * 0.11 : 0,
        annualLifeInsurance: c.life || 0, annualHealthInsurance: c.health || 0,
      })).toBeCloseTo(oldSsfOnly(c), 6)
    }
  })

  test('CIT — this year so far and still to come — lowers the base, inside the shared cap', () => {
    const withoutCit = projectBonusTaxableBase({ basic: 150000, ytd: { gross: 300000, months: 2 } })
    const withCit = projectBonusTaxableBase({
      basic: 150000, ytd: { gross: 300000, retirement: 20000, months: 2 }, monthlyRetirement: 10000,
    })
    // 20,000 already saved + 10,000 × 10 months to come = 1,20,000 relief.
    expect(withoutCit - withCit).toBe(120000)
  })
})
