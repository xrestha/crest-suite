// Pure Nepal statutory pooled-WDV tax depreciation computation — no React, no Supabase. A
// genuinely separate system from depreciationCompute.js's book (straight-line, per-asset)
// depreciation; the two are expected to disagree with each other. See taxPoolConstants.js for
// the rates/caps and the "verify before filing" caveat.
import { adToBs } from '../../../utils/bsCalendar'
import { POOL_RATES, REPAIR_CAP_RATE } from './taxPoolConstants'

const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100

// Which proration tier an acquisition falls into within a BS fiscal year (Schedule 2's
// "beginning of the income year to the last day of Poush" = full rate; the next quarter
// (Magh-Chaitra) = 2/3; the last quarter (Baisakh-Ashadh) = 1/3). `fiscalYearStartBs` is the BS
// year the fiscal year STARTS in (e.g. getBsFiscalYearStart()'s output) — the fiscal year runs
// Shrawan (month 4) of that year through Ashadh (month 3) of the following year.
export function acquisitionProrationTier({ acquisitionDate, fiscalYearStartBs }) {
  const d = acquisitionDate instanceof Date ? acquisitionDate : new Date(acquisitionDate)
  const { year, month } = adToBs(d)

  if (year === fiscalYearStartBs && month >= 4 && month <= 9) return 'full'        // Shrawan-Poush
  if (year === fiscalYearStartBs && month >= 10 && month <= 12) return 'two_third' // Magh-Chaitra
  if (year === fiscalYearStartBs + 1 && month >= 1 && month <= 3) return 'one_third' // Baisakh-Ashadh
  return null // outside this fiscal year — caller shouldn't be bucketing it here
}

// One pool's full-year movement (Pools A-D only — declining balance). Additions get the FULL
// value added to the pool going forward (closingWdv), but only a fraction of the RATE applied to
// them in their first year (the acquisition-tier proration) — the discount is on the depreciation
// allowance, not on the addition's book value itself.
export function computePoolMovement({
  pool, openingWdv, additionsFull, additionsTwoThird, additionsOneThird,
  disposalProceeds, priorYearCapitalizedRepairExcess = 0,
}) {
  const rate = POOL_RATES[pool]
  if (!rate) throw new Error(`computePoolMovement: no flat rate for pool "${pool}" — Pool E uses computeIntangibleAmortization instead.`)

  // Prior year's capitalized repair excess joins the base at full weight, same as opening WDV —
  // Section 16(3) capitalizes it into the pool's base "at the beginning of next income year".
  const baseForRate = (openingWdv + priorYearCapitalizedRepairExcess) - disposalProceeds
    + additionsFull + additionsTwoThird * (2 / 3) + additionsOneThird * (1 / 3)

  const rawDepreciation = Math.max(0, baseForRate) * rate

  // The pool's own running balance, before this year's depreciation — additions enter at full
  // value regardless of proration tier (proration only discounted this year's charge, above).
  const closingBeforeDepreciation = (openingWdv + priorYearCapitalizedRepairExcess) - disposalProceeds
    + additionsFull + additionsTwoThird + additionsOneThird

  // Never let the pool go negative — a disposal exceeding the pool's remaining value is an edge
  // case (a "balancing charge" under the Act) out of scope for v1; clamp rather than go negative.
  const depreciationAmount = r2(Math.min(rawDepreciation, Math.max(0, closingBeforeDepreciation)))
  const closingWdv = r2(closingBeforeDepreciation - depreciationAmount)

  return {
    depreciation_base: r2(Math.max(0, baseForRate)),
    depreciation_amount: depreciationAmount,
    closing_wdv: closingWdv,
  }
}

// Section 16 — deductible repair/maintenance expense on a pool is capped at REPAIR_CAP_RATE of
// the pool's CLOSING depreciation base for the year (the balance remaining at year-end, i.e.
// AFTER this year's own depreciation — not the opening or pre-depreciation base). Anything above
// the cap is not deducted this year; it's returned as `capitalizedExcess` for the CALLER to carry
// forward into NEXT year's run as that pool's `priorYearCapitalizedRepairExcess` — it must NOT be
// added into THIS year's own closing_wdv (Section 16(3) capitalizes it "at the beginning of next
// income year", not this one).
export function computeRepairCapCheck({ repairExpenseTotal, closingWdv }) {
  const cap = Math.max(0, closingWdv) * REPAIR_CAP_RATE
  const deductible = r2(Math.min(repairExpenseTotal, cap))
  const capitalizedExcess = r2(Math.max(0, repairExpenseTotal - cap))
  return { deductible, capitalizedExcess }
}

// Pool E (intangibles) — straight-line over useful life, NOT pooled/declining-balance like A-D.
// Schedule 2 prorates the first year "adjusted to the nearest half year" — interpreted here as:
// acquired in the first half of the fiscal year (Shrawan-Poush) gets the full annual amount,
// acquired in the second half (Magh-Ashadh) gets half. This is this plan's own interpretation of
// an ambiguous statutory phrase, not a certainty — verify before relying on it for a real filing.
export function computeIntangibleAmortization({ cost, usefulLifeYears, acquisitionDate, fiscalYearStartBs }) {
  if (!usefulLifeYears || usefulLifeYears <= 0) return { annual_amortization: 0, first_year_amount: 0 }
  const annual = cost / usefulLifeYears
  const tier = acquisitionProrationTier({ acquisitionDate, fiscalYearStartBs })
  // 'full' (Shrawan-Poush) is the first half of the FY -> full amount. 'two_third' (Magh-Chaitra)
  // and 'one_third' (Baisakh-Ashadh) are both in the second half -> half amount.
  const firstYearAmount = tier === 'full' ? annual : annual / 2
  return { annual_amortization: r2(annual), first_year_amount: r2(firstYearAmount) }
}
