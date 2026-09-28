// Pure Nepal statutory pooled-WDV tax depreciation computation — no React, no Supabase. A
// genuinely separate system from depreciationCompute.js's book (straight-line, per-asset)
// depreciation; the two are expected to disagree with each other. See taxPoolConstants.js for
// the rates/caps and the "verify before filing" caveat.
import { adToBs, getBsFiscalYear, getBsFiscalYearStart } from '../../../utils/bsCalendar'
import { POOL_RATES, REPAIR_CAP_RATE } from './taxPoolConstants'

const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100

// A stored `date` column ("YYYY-MM-DD") as LOCAL midnight of that calendar day (S756).
//
// `new Date('2026-01-15')` is UTC midnight, and adToBs() reads the Date's LOCAL getters. East of
// Greenwich (Nepal, +05:45) that is still the 15th, so this never showed on a till in Kathmandu —
// but for a viewer anywhere west of UTC (the operator abroad, an accountant's laptop set to
// another zone) it is the evening of the 14th, one BS day early. On the first day of Magh or of
// Baisakh that one day moves the asset into the previous proration tier, so the pool's allowance
// is computed at the wrong fraction of the rate and can be POSTED that way. depreciationCompute.js
// avoids the same trap for day counts by staying in UTC throughout; here the consumer is adToBs,
// which is local by design, so the parse has to be local too.
export function parseAdDateLocal(dateLike) {
  if (dateLike instanceof Date) return dateLike
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateLike || ''))
  if (!m) return new Date(dateLike)
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

// The fiscal year label ("82/83") a stored AD date falls in — the year the Tax Depreciation tab
// counts an asset bought on it as an addition. Parsed local, like the tier below.
export function fiscalYearOfAdDate(dateLike) {
  const bs = adToBs(parseAdDateLocal(dateLike))
  return bs && Number.isFinite(bs.year) ? getBsFiscalYear(bs.year, bs.month) : null
}

// Which proration tier an acquisition falls into within a BS fiscal year (Schedule 2's
// "beginning of the income year to the last day of Poush" = full rate; the next quarter
// (Magh-Chaitra) = 2/3; the last quarter (Baisakh-Ashadh) = 1/3). `fiscalYearStartBs` is the BS
// year the fiscal year STARTS in (e.g. getBsFiscalYearStart()'s output) — the fiscal year runs
// Shrawan (month 4) of that year through Ashadh (month 3) of the following year.
export function acquisitionProrationTier({ acquisitionDate, fiscalYearStartBs }) {
  const { year, month } = adToBs(parseAdDateLocal(acquisitionDate))

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

// One Pool E asset's amortization for the fiscal year starting in BS `fiscalYearStartBs`, on its own
// schedule (S792, COSTS-6): the first-year amount in the fiscal year it was bought (full or half,
// per computeIntangibleAmortization's tier, judged against THAT year), the annual amount after,
// and never more in total than its cost — so it stops at the end of its useful life, a half first
// year leaving a half final year. The pool used to add the annual amount every year for ever, so
// software 30,000 / 3 years amortized 10,000 a year into its fourth year and beyond; and an asset
// bought after the year being previewed was amortized in it too. Cumulative amounts are compared
// unrounded, so a cost that does not divide evenly leaves no stray paisa for a year after the last.
export function intangibleAmortizationForYear({ cost, usefulLifeYears, acquisitionDate, fiscalYearStartBs }) {
  const life = parseFloat(usefulLifeYears)
  const total = parseFloat(cost) || 0
  const bs = adToBs(parseAdDateLocal(acquisitionDate))
  const yearIndex = bs ? fiscalYearStartBs - getBsFiscalYearStart(bs.year, bs.month) : NaN
  const acquiredThisYear = yearIndex === 0
  if (!Number.isFinite(yearIndex) || yearIndex < 0 || !(life > 0) || !(total > 0)) return { amount: 0, acquiredThisYear }
  const boughtFy = fiscalYearStartBs - yearIndex
  const annual = total / life
  const first = acquisitionProrationTier({ acquisitionDate, fiscalYearStartBs: boughtFy }) === 'full' ? annual : annual / 2
  const cumulativeThrough = k => (k < 0 ? 0 : Math.min(total, first + annual * k))
  return { amount: r2(Math.max(0, r2(cumulativeThrough(yearIndex)) - r2(cumulativeThrough(yearIndex - 1)))), acquiredThisYear }
}

// Pool E's line for a fiscal year (S792, COSTS-6). Additions are this year's purchases at cost;
// the charge is each active Pool E asset's own amortization for the year, and never more than the
// pool holds (opening + additions). Without that clamp an opening of 0 — a missing prior-year run,
// COSTS-5 — still posted a year's amortization as a deduction on a pool worth nothing, with the
// closing value clamped to 0 beside it. A `depreciation_amount` below `scheduled` is what the caller
// names on screen.
export function computeIntangiblePool({ assets, openingWdv, fiscalYearStartBs }) {
  let additions = 0, scheduled = 0
  for (const a of assets || []) {
    if (a.tax_pool !== 'E' || a.status !== 'active') continue
    const { amount, acquiredThisYear } = intangibleAmortizationForYear({
      cost: a.total_cost, usefulLifeYears: a.useful_life_years, acquisitionDate: a.acquisition_date, fiscalYearStartBs,
    })
    if (acquiredThisYear) additions += parseFloat(a.total_cost) || 0
    scheduled += amount
  }
  const base = r2(Math.max(0, (parseFloat(openingWdv) || 0) + additions))
  const depreciation = r2(Math.min(scheduled, base))
  return {
    additions: r2(additions),
    scheduled: r2(scheduled),
    depreciation_base: base,
    depreciation_amount: depreciation,
    closing_wdv: r2(base - depreciation),
  }
}

// Which posted run a fiscal year's pools open from, and whether a year is missing in between
// (S792, COSTS-5 — the warning; typing opening values in is D40, stage 4). `runs` are the client's
// posted assets_tax_pool_runs ({ id, fiscal_year, created_at }); `fiscal_year` is the short label,
// "82/83". The prior year's latest run is the one the pools open from, as post() promises when a
// year is posted twice. `earlierLabel` is the latest posted year BEFORE the prior one: set while
// the prior year has no run, it means a year was skipped, and every pool opening at 0 is a gap,
// not a first year.
export function priorPoolRun({ runs, fiscalYearStartBs }) {
  const priorLabel = getBsFiscalYear(fiscalYearStartBs - 1, 4)
  const startOf = label => { const m = /^(\d{1,2})\//.exec(String(label || '')); return m ? Number(m[1]) : null }
  const priorShort = startOf(priorLabel)
  let priorRun = null, earlierShort = null, earlierLabel = null
  for (const r of runs || []) {
    if (r.fiscal_year === priorLabel) {
      if (!priorRun || String(r.created_at || '') > String(priorRun.created_at || '')) priorRun = r
      continue
    }
    const s = startOf(r.fiscal_year)
    if (s != null && s < priorShort && (earlierShort == null || s > earlierShort)) { earlierShort = s; earlierLabel = r.fiscal_year }
  }
  return { priorLabel, priorRun, earlierLabel: priorRun ? null : earlierLabel }
}
