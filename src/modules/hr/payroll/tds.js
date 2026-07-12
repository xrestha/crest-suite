// Nepal income-tax / TDS engine. Pure functions, no React/Supabase.
// See memory: nepal-payroll-law.
//
// Method: YTD cumulative projection. Each month we project annual taxable
// income (actuals so far this fiscal year + current month rate for the rest),
// compute annual tax, take the cumulative share due through the current month,
// and subtract tax already withheld earlier in the year. Self-correcting.

// Deduction cap: SSF/EPF/CIT retirement contribution is deductible up to the
// lower of NPR 500,000 or one-third of assessable income.
const RETIREMENT_CAP_ABS = 500000

// Insurance premium deduction caps (Nepal Income Tax Act 2058, Section 12).
const LIFE_INS_CAP   = 40000
const HEALTH_INS_CAP = 20000

// FY 2083/84 onward (effective Shrawan 1, 2083 / mid-July 2026) — unified.
// Married/single distinction removed from this FY onward.
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

// FY 2082/83 — married/couple schedule. Same as single but +1L on first 3 bands.
// (This distinction was removed from FY 2083/84 onward — unified schedule applies.)
export const SLABS_2082_83_MARRIED = [
  { upTo: 600000,  rate: 0.01, first: true },
  { upTo: 800000,  rate: 0.10 },
  { upTo: 1100000, rate: 0.20 },
  { upTo: 2000000, rate: 0.30 },
  { upTo: 5000000, rate: 0.36 },
  { upTo: Infinity, rate: 0.39 },
]

// Nepal fiscal year runs Shrawan (BS month 4) → Ashadh (month 3) of next year.
export function fiscalYearOf(bsYear, bsMonth) {
  if (bsMonth >= 4) return { fyStart: bsYear, monthInFy: bsMonth - 3 } // Shrawan = 1
  return { fyStart: bsYear - 1, monthInFy: bsMonth + 9 }              // Baisakh = 10 … Ashadh = 12
}

// FY 2083/84+ uses unified slabs; FY 2082/83 uses married/single distinction.
export function slabsFor(fyStart, isMarried = false) {
  if (fyStart >= 2083) return SLABS_2083_84
  return isMarried ? SLABS_2082_83_MARRIED : SLABS_2082_83_SINGLE
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

// Current month's TDS via YTD cumulative projection, PLUS every intermediate value along the
// way — used by the Calculation/Review page to show its work. `computeMonthlyTds` below is a
// thin wrapper returning just the final number, so there's exactly one implementation and the
// two can never drift apart.
// ytd* = sums from PRIOR finalized payslips this fiscal year (months before this one).
// isMarried: use married tax schedule (only effective for FY 2082/83 and earlier).
// festivalBonus: one-time bonus included in this month's annual income projection.
export function computeMonthlyTdsBreakdown({
  period, monthlyGross, monthlySsf, ytdGross = 0, ytdSsf = 0, ytdWithheld = 0, ytdMonths,
  isSsf = false, annualLifeInsurance = 0, annualHealthInsurance = 0,
  isMarried = false, festivalBonus = 0,
}) {
  const { fyStart, monthInFy } = fiscalYearOf(period.bs_year, period.bs_month)
  const slabs = slabsFor(fyStart, isMarried)

  const monthsAtCurrent = 13 - monthInFy
  const annualGross = ytdGross + monthlyGross * monthsAtCurrent + festivalBonus
  const annualSsf   = ytdSsf   + monthlySsf   * monthsAtCurrent

  const ssfDeduction       = Math.min(annualSsf, Math.min(RETIREMENT_CAP_ABS, annualGross / 3))
  const insuranceDeduction = Math.min(annualLifeInsurance, LIFE_INS_CAP) + Math.min(annualHealthInsurance, HEALTH_INS_CAP)
  const annualTaxable      = Math.max(0, annualGross - ssfDeduction - insuranceDeduction)

  const annualTax = applySlabs(annualTaxable, slabs, isSsf)
  // Spread annualTax evenly across the months this employee is actually paid within the FY —
  // NOT always /12. A mid-year joiner has fewer prior months (ytdMonths) than a continuously
  // employed staffer, so annualTax/12*monthInFy would front-load most of the year's tax into
  // their first paycheck. `ytdMonths` defaults to `monthInFy - 1` (continuous employment since
  // FY start) when the caller doesn't supply the real prior-payslip count, which makes
  // monthsEmployedTotal reduce to exactly 12 — i.e. the original monthInFy/12 formula.
  const priorMonths         = ytdMonths ?? (monthInFy - 1)
  const monthsEmployedSoFar = priorMonths + 1
  const monthsEmployedTotal = priorMonths + monthsAtCurrent
  const cumulativeDue = monthsEmployedTotal > 0 ? (annualTax * monthsEmployedSoFar) / monthsEmployedTotal : annualTax
  const tds = Math.max(0, Math.round(cumulativeDue - ytdWithheld))

  return {
    tds, fyStart, monthInFy, monthsAtCurrent, slabs, isSsf,
    ytdGross, ytdSsf, ytdWithheld, annualGross, annualSsf,
    ssfDeduction, insuranceDeduction, annualTaxable, annualTax, cumulativeDue,
    monthsEmployedSoFar, monthsEmployedTotal,
  }
}

export function computeMonthlyTds(args) {
  return computeMonthlyTdsBreakdown(args).tds
}

// TDS on a one-time lump-sum payment (festival bonus, gratuity, settlement).
// Uses incremental marginal method: tax(annualTaxable + bonus) − tax(annualTaxable).
// annualTaxable: estimated annual taxable income WITHOUT the bonus (already net of SSF/insurance).
// bonusAmount:   gross lump-sum amount to tax.
// fyStart:       fiscal year start (from fiscalYearOf).
export function computeBonusTds({ annualTaxable, bonusAmount, isSsf = false, isMarried = false, fyStart }) {
  if (!bonusAmount || bonusAmount <= 0) return 0
  const slabs    = slabsFor(fyStart, isMarried)
  const taxBase  = applySlabs(Math.max(0, annualTaxable), slabs, isSsf)
  const taxTotal = applySlabs(Math.max(0, annualTaxable + bonusAmount), slabs, isSsf)
  return Math.max(0, Math.round(taxTotal - taxBase))
}
