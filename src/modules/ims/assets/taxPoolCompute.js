// Pure Nepal statutory pooled-WDV tax depreciation computation — no React, no Supabase. A
// genuinely separate system from depreciationCompute.js's book (straight-line, per-asset)
// depreciation; the two are expected to disagree with each other. See taxPoolConstants.js for
// the rates/caps and the "verify before filing" caveat.
import { adToBs, getBsFiscalYear, getBsFiscalYearStart } from '../../../utils/bsCalendar'
import { POOL_RATES, REPAIR_CAP_RATE, SMALL_POOL_BALANCE } from './taxPoolConstants'
import { parseAdDateLocal } from '../../../shared/nepalTime'
import { assetHeldOn } from './depreciationCompute'

const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100
// The leading BS year of a short fiscal-year label ("82/83" → 82), or null.
const startOf = label => { const m = /^(\d{1,2})\//.exec(String(label || '')); return m ? Number(m[1]) : null }

// A stored `date` column ("YYYY-MM-DD") as LOCAL midnight of that calendar day (S756). It lives in
// src/shared/nepalTime.js since S798 stage 2e, where the Owner Report's labour figures use it too.
//
// `new Date('2026-01-15')` is UTC midnight, and adToBs() reads the Date's LOCAL getters. East of
// Greenwich (Nepal, +05:45) that is still the 15th, so this never showed on a till in Kathmandu —
// but for a viewer anywhere west of UTC (the operator abroad, an accountant's laptop set to
// another zone) it is the evening of the 14th, one BS day early. On the first day of Magh or of
// Baisakh that one day moves the asset into the previous proration tier, so the pool's allowance
// is computed at the wrong fraction of the rate and can be POSTED that way. depreciationCompute.js
// avoids the same trap for day counts by staying in UTC throughout; here the consumer is adToBs,
// which is local by design, so the parse has to be local too.
export { parseAdDateLocal }

// The fiscal year label ("82/83") a stored AD date falls in — the year the Tax Depreciation tab
// counts an asset bought on it as an addition. Parsed local, like the tier below.
export function fiscalYearOfAdDate(dateLike) {
  const bs = adToBs(parseAdDateLocal(dateLike))
  return bs && Number.isFinite(bs.year) ? getBsFiscalYear(bs.year, bs.month) : null
}

// The BS year the fiscal year of a stored AD date STARTS in (a date in Bhadra 2082 → 2082, one in
// Baisakh 2083 → 2082), or null for no date. Parsed local, like the tier below.
export function fiscalYearStartOfAdDate(dateLike) {
  if (!dateLike) return null
  const bs = adToBs(parseAdDateLocal(dateLike))
  return bs && Number.isFinite(bs.year) ? getBsFiscalYearStart(bs.year, bs.month) : null
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
//
// S849 (ASSETS-2, ASSETS-18): the pool never closes below zero, and the three outcomes the Act
// names are worked out instead of being clamped away. With
//   deferred    = ⅓ of the ⅔-tier additions + ⅔ of the ⅓-tier additions (what §2(5)(b) adds to
//                 the base only next year),
//   valueBefore = opening + repair carried in − disposal proceeds + every addition at full value,
//   base        = valueBefore − deferred (the depreciation base, "A" in Schedule 2 §2(2)):
//   (a) `dissolved` (Schedule 2 §4(2): every asset of the class is gone at year end): no
//       depreciation, the pool closes at 0, and what was left is a terminal deduction this year —
//       or, if the proceeds were more than the pool was worth, the excess is balancing income.
//       Nothing carries forward, so this year's deferred additions are deducted too: Crest's
//       reading of the same-year-purchase edge, not a quoted rule. The base is still reported
//       (floored at 0), because the Section 16 repair cap is measured against it.
//   (b) base below 0 (the §2(3) proviso and §4(1)): the proceeds exceeded the pool, so the excess
//       is business income this year, the base floors at 0, nothing is depreciated, and the pool
//       closes at the deferred part of this year's additions.
//   (c) otherwise the rate applies to the base; and if what is left of the base is above 0 but
//       below NPR 2,000 (Schedule 2 §2(6)), it is written off in full this year
//       (`small_balance_written_off`, an on-screen note only) and the pool closes at `deferred`.
// Until S849 the closing value went negative instead: the excess silently cut every later year's
// depreciation, and since S849 the database refuses a negative closing_wdv outright.
// In every case: opening + carried + additions − disposals − depreciation − terminal + income
// = closing (poolLineAddsUp).
export function computePoolMovement({
  pool, openingWdv, additionsFull, additionsTwoThird, additionsOneThird,
  disposalProceeds, priorYearCapitalizedRepairExcess = 0, dissolved = false,
}) {
  const rate = POOL_RATES[pool]
  if (!rate) throw new Error(`computePoolMovement: no flat rate for pool "${pool}" — Pool E uses computeIntangibleAmortization instead.`)

  const n = v => parseFloat(v) || 0
  const twoThird = n(additionsTwoThird), oneThird = n(additionsOneThird)
  // Prior year's capitalized repair excess joins the base at full weight, same as opening WDV —
  // Section 16(3) capitalizes it into the pool's base "at the beginning of next income year".
  const valueBefore = n(openingWdv) + n(priorYearCapitalizedRepairExcess) - n(disposalProceeds)
    + n(additionsFull) + twoThird + oneThird
  const deferred = twoThird / 3 + oneThird * 2 / 3
  const base = r2(valueBefore - deferred)
  const nothingElse = { balancing_income: 0, terminal_deduction: 0, small_balance_written_off: 0 }

  if (dissolved) {
    return {
      ...nothingElse,
      depreciation_base: Math.max(0, base),
      depreciation_amount: 0,
      terminal_deduction: r2(Math.max(0, valueBefore)),
      balancing_income: r2(Math.max(0, -valueBefore)),
      closing_wdv: 0,
    }
  }
  if (base < 0) {
    return { ...nothingElse, depreciation_base: 0, depreciation_amount: 0, balancing_income: r2(-base), closing_wdv: r2(deferred) }
  }

  let depreciation = r2(base * rate)
  let smallBalance = 0
  const left = r2(base - depreciation)
  if (left > 0 && left < SMALL_POOL_BALANCE) {
    smallBalance = left
    depreciation = base
  }
  return {
    ...nothingElse,
    depreciation_base: base,
    depreciation_amount: depreciation,
    small_balance_written_off: smallBalance,
    closing_wdv: r2(Math.max(0, valueBefore - depreciation)),
  }
}

// Section 16(2) — deductible repair/maintenance expense on a pool is capped at REPAIR_CAP_RATE (7%)
// of the pool's DEPRECIATION BASE for the year: the base its rate is applied to, which is
// computePoolMovement's `depreciation_base` (S849, ASSETS-1). Until S849 the cap was 5% of the
// value left AFTER depreciation. Anything above the cap is not deducted this year; it's returned as
// `capitalizedExcess` for the CALLER to carry forward into NEXT year's run as that pool's
// `priorYearCapitalizedRepairExcess` (stored there as `repair_carried_in`) — it must NOT be added
// into THIS year's own closing_wdv (Section 16(3) capitalizes it "at the beginning of next income
// year", not this one).
export function computeRepairCapCheck({ repairExpenseTotal, depreciationBase }) {
  const total = parseFloat(repairExpenseTotal) || 0
  const cap = Math.max(0, parseFloat(depreciationBase) || 0) * REPAIR_CAP_RATE
  const deductible = r2(Math.min(total, cap))
  const capitalizedExcess = r2(Math.max(0, total - cap))
  return { deductible, capitalizedExcess }
}

// The identity a printed schedule row must satisfy (S849, ASSETS-10): opening + repair carried in
// + additions − disposals − depreciation − write-off + income = closing. Pools A–D only: Pool E
// takes its disposed assets out at their unclaimed value, not at the proceeds it reports.
export function poolLineAddsUp(l, tolerance = 0.02) {
  const n = v => parseFloat(v) || 0
  const expected = n(l.opening_wdv) + n(l.repair_carried_in) + n(l.additions_full) + n(l.additions_two_third)
    + n(l.additions_one_third) - n(l.disposal_proceeds) - n(l.depreciation_amount)
    - n(l.terminal_deduction) + n(l.balancing_income)
  return Math.abs(expected - n(l.closing_wdv)) <= tolerance
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
export function intangibleAmortizationForYear(args) {
  const { yearIndex, cumulativeThrough } = intangibleSchedule(args)
  const acquiredThisYear = yearIndex === 0
  if (!Number.isFinite(yearIndex) || yearIndex < 0) return { amount: 0, acquiredThisYear }
  return { amount: r2(Math.max(0, r2(cumulativeThrough(yearIndex)) - r2(cumulativeThrough(yearIndex - 1)))), acquiredThisYear }
}

// One Pool E asset's schedule as seen from the fiscal year starting in `fiscalYearStartBs`:
// `yearIndex` (0 = the year it was bought, negative = bought later, NaN = no readable date) and
// `cumulativeThrough(k)`, the amount claimed by the end of year k of its life (0 for an unusable
// cost or life, so such an asset claims nothing).
//
// D40 (Q5): Pool E takes no typed pool opening. An asset's "depreciation already taken" before
// Crest (`openingAccumulated`, as of `openingAsOf`) is instead read as amortised through the END
// of the fiscal year `openingAsOf` falls in: by then the cumulative is that amount (capped at
// cost), and each year after adds the annual amount until cost is reached. A figure from last
// year's books is normally as of the year-end, which is exactly this; a mid-year date claims the
// rest of that year on the next one's schedule rather than splitting a year.
function intangibleSchedule({ cost, usefulLifeYears, acquisitionDate, fiscalYearStartBs, openingAccumulated = 0, openingAsOf = null }) {
  const life = parseFloat(usefulLifeYears)
  const total = parseFloat(cost) || 0
  const bs = acquisitionDate ? adToBs(parseAdDateLocal(acquisitionDate)) : null
  const yearIndex = bs ? fiscalYearStartBs - getBsFiscalYearStart(bs.year, bs.month) : NaN
  if (!Number.isFinite(yearIndex) || yearIndex < 0 || !(life > 0) || !(total > 0)) return { yearIndex, cumulativeThrough: () => 0 }
  const boughtFy = fiscalYearStartBs - yearIndex
  const annual = total / life
  const first = acquisitionProrationTier({ acquisitionDate, fiscalYearStartBs: boughtFy }) === 'full' ? annual : annual / 2
  const scheduled = k => (k < 0 ? 0 : Math.min(total, first + annual * k))
  const taken = Math.min(total, parseFloat(openingAccumulated) || 0)
  const takenFy = taken > 0 ? fiscalYearStartOfAdDate(openingAsOf) : null
  if (takenFy == null) return { yearIndex, cumulativeThrough: scheduled }
  const takenIndex = Math.max(0, takenFy - boughtFy)
  return {
    yearIndex,
    cumulativeThrough: k => (k < 0 ? 0 : k < takenIndex ? Math.min(taken, scheduled(k)) : Math.min(total, taken + annual * (k - takenIndex))),
  }
}

// The intangibleSchedule() arguments for one register row.
const intangibleArgs = (a, fiscalYearStartBs) => ({
  cost: a.total_cost, usefulLifeYears: a.useful_life_years, acquisitionDate: a.acquisition_date, fiscalYearStartBs,
  openingAccumulated: a.opening_accumulated_depreciation, openingAsOf: a.opening_as_of,
})

// Pool E's line for a fiscal year (S792, COSTS-6). Additions are this year's purchases at cost;
// the charge is each Pool E asset's own amortization for the year, and never more than the pool
// holds (opening + additions). Without that clamp an opening of 0 — a missing prior-year run,
// COSTS-5 — still posted a year's amortization as a deduction on a pool worth nothing, with the
// closing value clamped to 0 beside it. A `depreciation_amount` below `scheduled` is what the caller
// names on screen.
//
// Which assets were in the pool is judged against THE YEAR, not today's status (S792 stage 3, the
// COSTS-4 lesson). Only active assets used to count, so software sold in a later year vanished from
// the schedule of every year it was held in — its purchase and its amortization both — and one sold
// this year kept its unclaimed value in the pool for ever, with no asset left to amortize it:
//   - gone in an EARLIER year: not in this year's pool at all;
//   - gone THIS year: no amortization this year, and it leaves the pool at the value not yet
//     claimed (`disposed_value`). Each Pool E asset is claimed on its own schedule, so its sale price
//     is not netted into the pool the way Pools A–D net theirs; `disposal_proceeds` reports it for
//     the accountant, who decides the gain or loss. This plan's own reading of Schedule 2, like the
//     half-year rule above — verify before filing;
//   - gone in a LATER year, or still held: as if active.
// A disposed asset with no disposal date cannot be placed in a year and stays out, as before.
//
// `derived_opening` (D40, Q5) is what the pool held at the start of the year by its assets' own
// schedules: each asset bought in an earlier year and still held, at cost less what its schedule
// (and any "already taken" figure) had claimed by then. The caller opens Pool E at it when the year
// before has no posted run, instead of at 0 — Pool E takes no typed opening, so this is where an
// asset bought before Crest enters the pool. Pass `openingWdv` as null for that; `opening_wdv` in
// the result is whichever was used.
export function computeIntangiblePool({ assets, openingWdv, fiscalYearStartBs }) {
  let additions = 0, scheduled = 0, disposedValue = 0, proceeds = 0, derivedOpening = 0
  for (const a of assets || []) {
    if (a.tax_pool !== 'E') continue
    const goneFy = a.status === 'active' ? null : fiscalYearStartOfAdDate(a.disposal_date)
    if (a.status !== 'active' && goneFy == null) continue
    if (goneFy != null && goneFy < fiscalYearStartBs) continue
    const args = intangibleArgs(a, fiscalYearStartBs)
    const { yearIndex, cumulativeThrough } = intangibleSchedule(args)
    if (!Number.isFinite(yearIndex) || yearIndex < 0) continue // bought after this year
    const cost = parseFloat(a.total_cost) || 0
    if (yearIndex === 0) additions += cost
    else derivedOpening += Math.max(0, cost - r2(cumulativeThrough(yearIndex - 1)))
    if (goneFy === fiscalYearStartBs) {
      disposedValue += Math.max(0, cost - r2(cumulativeThrough(yearIndex - 1)))
      proceeds += parseFloat(a.disposal_proceeds) || 0
      continue
    }
    scheduled += intangibleAmortizationForYear(args).amount
  }
  // `openingWdv` null/undefined: no posted run for the year before, so open at the derived value.
  const opening = openingWdv == null ? derivedOpening : (parseFloat(openingWdv) || 0)
  const base = r2(Math.max(0, opening + additions - disposedValue))
  const depreciation = r2(Math.min(scheduled, base))
  return {
    opening_wdv: r2(opening),
    additions: r2(additions),
    derived_opening: r2(derivedOpening),
    disposed_value: r2(disposedValue),
    disposal_proceeds: r2(proceeds),
    scheduled: r2(scheduled),
    depreciation_base: base,
    depreciation_amount: depreciation,
    closing_wdv: r2(base - depreciation),
  }
}

// Which posted run a fiscal year's pools open from, and whether a year is missing in between
// (S792, COSTS-5). `runs` are the client's posted assets_tax_pool_runs ({ id, fiscal_year,
// created_at }); `fiscal_year` is the short label, "82/83". The prior year's latest run is the one
// the pools open from, as post() promises when a year is posted twice. `earlierLabel` is the latest
// posted year BEFORE the prior one: set while the prior year has no run, it means a year was
// skipped, and every pool opening at 0 is a gap, not a first year.
//
// D40: `openings` are the client's assets_tax_pool_openings rows ({ pool, fiscal_year, opening_wdv,
// repair_carry_forward }). `typedOpenings` maps pool → { openingWdv, repairCarryForward } for the
// ones typed for THIS year, and is filled only when the prior year has no run: a real run always
// wins. One typed for another year is not used — for a later year it has not started yet, and for
// an earlier one the years in between are what carry it.
export function priorPoolRun({ runs, fiscalYearStartBs, openings = [] }) {
  const priorLabel = getBsFiscalYear(fiscalYearStartBs - 1, 4)
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
  const typedOpenings = {}
  if (!priorRun) {
    const thisLabel = getBsFiscalYear(fiscalYearStartBs, 4)
    for (const o of openings || []) {
      if (o.fiscal_year !== thisLabel || !['A', 'B', 'C', 'D'].includes(o.pool)) continue
      typedOpenings[o.pool] = {
        openingWdv: parseFloat(o.opening_wdv) || 0,
        repairCarryForward: parseFloat(o.repair_carry_forward) || 0,
      }
    }
  }
  return { priorLabel, priorRun, earlierLabel: priorRun ? null : earlierLabel, typedOpenings }
}

// D40 (Q4): whether a typed opening is locked — a POSTED run exists for its fiscal year or a later
// one, so that run (or the chain it started) already carries it. Mirrors the database's
// assets_tax_pool_openings_lock trigger, which is what actually refuses the write; this only lets
// the tab say so before anyone types. Returns the earliest such year's label, or null.
export function openingLockedBy({ opening, runs }) {
  const from = startOf(opening?.fiscal_year)
  if (from == null) return null
  let best = null
  for (const r of runs || []) {
    const s = startOf(r.fiscal_year)
    if (s != null && s >= from && (best == null || s < best.s)) best = { s, label: r.fiscal_year }
  }
  return best ? best.label : null
}

export const POOLS_AD = ['A', 'B', 'C', 'D']
const num = v => parseFloat(v) || 0

// The fields post_tax_pool_run stores for each line, and nothing else: a preview line also carries
// what is only said on screen (dissolved, small_balance_written_off).
export const POSTED_LINE_FIELDS = [
  'pool', 'opening_wdv', 'repair_carried_in', 'additions_full', 'additions_two_third', 'additions_one_third',
  'disposal_proceeds', 'repair_expense_total', 'repair_expense_deductible', 'repair_expense_capitalized',
  'depreciation_base', 'depreciation_amount', 'balancing_income', 'terminal_deduction', 'closing_wdv',
]
export function postedLinePayload(lines) {
  return (lines || []).map(l => Object.fromEntries(POSTED_LINE_FIELDS.map(k => [k, k === 'pool' ? l.pool : num(l[k])])))
}

// The whole tax schedule for one fiscal year, from inputs already read (S849, ASSETS-2): the per-pool
// loop moved here out of TaxPoolTab.preview(), so ticking "this pool was closed" recomputes without
// a re-read, and every row is unit-tested.
//   assets             the register as read for this preview (every status)
//   fyStart            the BS year the fiscal year starts in (2083 for 83/84)
//   fyStartAd/fyEndAd  its first and last day as "YYYY-MM-DD" (formatAd)
//   priorLinesByPool   pool → the line of the year before's latest posted run, if there is one
//   typedOpenings      pool → { openingWdv, repairCarryForward } typed for THIS year (priorPoolRun)
//   openings           every assets_tax_pool_openings row, to tell where a pool's value came from
//   repairTotalsByPool pool → this year's repair spend
//   closedPools        { C: true }: pools the user said were sold or scrapped in full this year
//
// Which pools are dissolved (Schedule 2 §4(2)): a pool whose register holds at least one asset
// disposed of in the year and none still held at its end. It is marked automatically only when the
// register explains the pool's whole value — no value was ever typed for it from a tax return (for
// this year or an earlier one), which may include assets bought before Crest. Otherwise the pool is
// listed in `askDissolve` and dissolved only when `closedPools` says so.
//
// `untracked` (ASSETS-5): assets with no tax pool that were held at some point in the year (bought by
// its end, and still active or gone on or after its first day). The schedule leaves them out.
export function buildTaxPoolLines({
  assets, fyStart, fyStartAd, fyEndAd, priorLinesByPool = {}, typedOpenings = {}, openings = [],
  repairTotalsByPool = {}, closedPools = {},
}) {
  const list = assets || []
  const inYear = d => !!d && String(d).slice(0, 10) >= fyStartAd && String(d).slice(0, 10) <= fyEndAd
  const gone = a => a.status !== 'active'
  const askDissolve = []
  const lines = POOLS_AD.map(pool => {
    // A real run for the year before always wins; a typed opening (D40) only stands in for one.
    const prior = priorLinesByPool[pool]
    const typed = prior ? null : typedOpenings[pool]
    const openingWdv = prior ? num(prior.closing_wdv) : typed ? num(typed.openingWdv) : 0
    const carriedIn = prior ? num(prior.repair_expense_capitalized) : typed ? num(typed.repairCarryForward) : 0

    let additionsFull = 0, additionsTwoThird = 0, additionsOneThird = 0, disposalProceeds = 0
    let disposedInYear = 0, heldAtEnd = 0
    for (const a of list) {
      if (a.tax_pool !== pool) continue
      if (inYear(a.acquisition_date)) {
        const tier = acquisitionProrationTier({ acquisitionDate: a.acquisition_date, fiscalYearStartBs: fyStart })
        if (tier === 'full') additionsFull += num(a.total_cost)
        else if (tier === 'two_third') additionsTwoThird += num(a.total_cost)
        else if (tier === 'one_third') additionsOneThird += num(a.total_cost)
      }
      if (gone(a) && inYear(a.disposal_date)) { disposalProceeds += num(a.disposal_proceeds); disposedInYear++ }
      if (assetHeldOn(a, fyEndAd)) heldAtEnd++
    }

    const emptied = disposedInYear > 0 && heldAtEnd === 0
    const typedEver = (openings || []).some(o => o.pool === pool
      && startOf(o.fiscal_year) != null && startOf(o.fiscal_year) <= fyStart % 100
      && (num(o.opening_wdv) > 0 || num(o.repair_carry_forward) > 0))
    const autoDissolved = emptied && !typedEver
    if (emptied && typedEver) askDissolve.push(pool)
    const dissolved = autoDissolved || (emptied && typedEver && !!closedPools[pool])

    const movement = computePoolMovement({
      pool, openingWdv, additionsFull, additionsTwoThird, additionsOneThird, disposalProceeds,
      priorYearCapitalizedRepairExcess: carriedIn, dissolved,
    })
    const repairExpenseTotal = r2(num(repairTotalsByPool[pool]))
    const repairCap = computeRepairCapCheck({ repairExpenseTotal, depreciationBase: movement.depreciation_base })

    return {
      pool, opening_wdv: r2(openingWdv), repair_carried_in: r2(carriedIn),
      additions_full: r2(additionsFull), additions_two_third: r2(additionsTwoThird), additions_one_third: r2(additionsOneThird),
      disposal_proceeds: r2(disposalProceeds),
      repair_expense_total: repairExpenseTotal, repair_expense_deductible: repairCap.deductible,
      repair_expense_capitalized: repairCap.capitalizedExcess,
      depreciation_base: movement.depreciation_base, depreciation_amount: movement.depreciation_amount,
      balancing_income: movement.balancing_income, terminal_deduction: movement.terminal_deduction,
      closing_wdv: movement.closing_wdv,
      small_balance_written_off: movement.small_balance_written_off,
      dissolved, autoDissolved,
    }
  })

  // Pool E — intangibles, straight-line per asset, not a shared-rate declining balance pool. Each
  // asset on its own schedule, stopping at the end of its useful life, never more than the pool
  // holds (S792, COSTS-6); one sold this year leaves at its unclaimed value and its price is
  // reported under Disposals without being netted in. With no run for the year before, Pool E opens
  // at what its assets' own schedules leave unclaimed (D40, Q5), instead of at 0.
  const priorE = priorLinesByPool.E
  const poolE = computeIntangiblePool({ assets: list, openingWdv: priorE ? num(priorE.closing_wdv) : null, fiscalYearStartBs: fyStart })
  lines.push({
    pool: 'E', opening_wdv: poolE.opening_wdv, repair_carried_in: 0,
    additions_full: poolE.additions, additions_two_third: 0, additions_one_third: 0,
    disposal_proceeds: poolE.disposal_proceeds, repair_expense_total: 0, repair_expense_deductible: 0, repair_expense_capitalized: 0,
    depreciation_base: poolE.depreciation_base, depreciation_amount: poolE.depreciation_amount,
    balancing_income: 0, terminal_deduction: 0, closing_wdv: poolE.closing_wdv,
    small_balance_written_off: 0, dissolved: false, autoDissolved: false,
  })

  const untracked = list
    .filter(a => !a.tax_pool
      && !!a.acquisition_date && String(a.acquisition_date).slice(0, 10) <= fyEndAd
      && (a.status === 'active' || (!!a.disposal_date && String(a.disposal_date).slice(0, 10) >= fyStartAd)))
    .map(a => ({ id: a.id, asset_code: a.asset_code, name: a.name, total_cost: num(a.total_cost) }))

  return { lines, untracked, askDissolve, poolE }
}

// Which posted fiscal years need posting again, oldest first (S849, ASSETS-9 / SU7 b).
//
// For every posted year Y, its latest run (the one the next year opens from, as priorPoolRun picks
// it) is compared pool by pool with what Y would open from TODAY: the latest run of Y−1 (its
// closing_wdv and repair_expense_capitalized), else the opening typed for Y, else 0. Pool E takes no
// typed opening, so it is compared only against Y−1's closing. Y is listed when any opening_wdv or
// repair_carried_in differs by more than half a paisa. Working from the figures catches a corrected
// typed opening AND the older gap where an earlier year was posted again after a later one.
//
// `runs` are posted assets_tax_pool_runs ({ id, fiscal_year, created_at, posted_at }); `lines` every
// posted line ({ run_id, pool, opening_wdv, repair_carried_in, closing_wdv,
// repair_expense_capitalized }); `openings` the typed openings; `corrections` the
// assets_tax_pool_opening_corrections rows. Each listed year carries `why`: the corrections of its
// typed opening made after its latest post (one RPC call shares one corrected_at, so they are
// grouped), else the year before posted again since, else a plain mismatch.
export function schedulesToPostAgain({ runs, lines, openings = [], corrections = [] }) {
  const latest = new Map() // startOf(label) → run
  for (const r of runs || []) {
    const s = startOf(r.fiscal_year)
    if (s == null) continue
    const cur = latest.get(s)
    if (!cur || String(r.created_at || '') > String(cur.created_at || '')) latest.set(s, r)
  }
  const linesByRun = new Map()
  for (const l of lines || []) {
    if (!linesByRun.has(l.run_id)) linesByRun.set(l.run_id, {})
    linesByRun.get(l.run_id)[l.pool] = l
  }
  const postedAt = r => String(r?.posted_at || r?.created_at || '')
  const out = []
  for (const s of [...latest.keys()].sort((a, b) => a - b)) {
    const run = latest.get(s)
    const label = run.fiscal_year
    const mine = linesByRun.get(run.id) || {}
    const priorRun = latest.get(s - 1) || null
    const priorLines = priorRun ? (linesByRun.get(priorRun.id) || {}) : null
    const pools = []
    for (const pool of [...POOLS_AD, 'E']) {
      const line = mine[pool]
      let wantOpening, wantCarried
      if (priorLines) {
        wantOpening = num(priorLines[pool]?.closing_wdv)
        wantCarried = pool === 'E' ? null : num(priorLines[pool]?.repair_expense_capitalized)
      } else {
        if (pool === 'E') continue
        const typed = (openings || []).find(o => o.pool === pool && o.fiscal_year === label)
        wantOpening = typed ? num(typed.opening_wdv) : 0
        wantCarried = typed ? num(typed.repair_carry_forward) : 0
      }
      const off = Math.abs(num(line?.opening_wdv) - wantOpening) > 0.005
        || (wantCarried != null && Math.abs(num(line?.repair_carried_in) - wantCarried) > 0.005)
      if (off) pools.push(pool)
    }
    if (pools.length === 0) continue

    const after = (corrections || [])
      .filter(c => c.fiscal_year === label && String(c.corrected_at || '') > postedAt(run))
      .sort((a, b) => String(b.corrected_at || '').localeCompare(String(a.corrected_at || '')))
    let why
    if (after.length) {
      const at = after[0].corrected_at
      why = { kind: 'correction', corrections: after.filter(c => c.corrected_at === at) }
    } else if (priorRun && postedAt(priorRun) > postedAt(run)) {
      why = { kind: 'reposted', priorLabel: priorRun.fiscal_year, at: postedAt(priorRun) }
    } else {
      why = { kind: 'mismatch' }
    }
    out.push({ fiscalYear: label, fyShort: s, run, pools, why })
  }
  return out
}
