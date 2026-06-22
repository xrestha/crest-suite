// Nepal income-tax / TDS engine. Pure functions, no React/Supabase.
// See memory: nepal-payroll-law. Slabs are ANNUAL, single-person schedule
// (married/single distinction not modelled — see S112 decision).
//
// Method: YTD cumulative projection. Each month we project annual taxable
// income (actuals so far this fiscal year + current month rate for the rest),
// compute annual tax, take the cumulative share due through the current month,
// and subtract tax already withheld earlier in the year. Self-correcting.

// Deduction cap: SSF/EPF/CIT retirement contribution is deductible up to the
// lower of NPR 500,000 or one-third of assessable income.
const RETIREMENT_CAP_ABS = 500000

// FY 2083/84 onward (effective Shrawan 1, 2083 / mid-July 2026) — unified.
export const SLABS_2083_84 = [
  { upTo: 1000000, rate: 0.01, first: true },
  { upTo: 1500000, rate: 0.10 },
  { upTo: 2500000, rate: 0.20 },
  { upTo: 4000000, rate: 0.27 },
  { upTo: Infinity, rate: 0.29 },
]

// FY 2082/83 — single-person schedule.
export const SLABS_2082_83_SINGLE = [
  { upTo: 500000,  rate: 0.01, first: true },
  { upTo: 700000,  rate: 0.10 },
  { upTo: 1000000, rate: 0.20 },
  { upTo: 2000000, rate: 0.30 },
  { upTo: 5000000, rate: 0.36 },
  { upTo: Infinity, rate: 0.39 },
]

// Nepal fiscal year runs Shrawan (BS month 4) → Ashadh (month 3) of next year.
export function fiscalYearOf(bsYear, bsMonth) {
  if (bsMonth >= 4) return { fyStart: bsYear, monthInFy: bsMonth - 3 } // Shrawan = 1
  return { fyStart: bsYear - 1, monthInFy: bsMonth + 9 }              // Baisakh = 10 … Ashadh = 12
}

export function slabsFor(fyStart) {
  return fyStart >= 2083 ? SLABS_2083_84 : SLABS_2082_83_SINGLE
}

// Annual tax for a taxable amount. SSF contributors get the 1% first slab
// (Social Security Tax) waived entirely.
export function applySlabs(taxable, slabs, isSsfContributor) {
  let tax = 0, prev = 0
  for (const s of slabs) {
    if (taxable <= prev) break
    const band = Math.min(taxable, s.upTo) - prev
    const rate = (s.first && isSsfContributor) ? 0 : s.rate
    tax += band * rate
    prev = s.upTo
  }
  return tax
}

// Current month's TDS via YTD cumulative projection.
// ytd* = sums from PRIOR finalized payslips this fiscal year (months before this one).
export function computeMonthlyTds({ period, monthlyGross, monthlySsf, ytdGross = 0, ytdSsf = 0, ytdWithheld = 0, isSsf = false }) {
  const { fyStart, monthInFy } = fiscalYearOf(period.bs_year, period.bs_month)
  const slabs = slabsFor(fyStart)

  const monthsAtCurrent = 13 - monthInFy            // current month + remaining months of the FY
  const annualGross = ytdGross + monthlyGross * monthsAtCurrent
  const annualSsf   = ytdSsf   + monthlySsf   * monthsAtCurrent

  const ssfDeduction  = Math.min(annualSsf, Math.min(RETIREMENT_CAP_ABS, annualGross / 3))
  const annualTaxable = Math.max(0, annualGross - ssfDeduction)

  const annualTax     = applySlabs(annualTaxable, slabs, isSsf)
  const cumulativeDue = (annualTax / 12) * monthInFy
  return Math.max(0, Math.round(cumulativeDue - ytdWithheld))
}
