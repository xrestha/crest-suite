// Pure "book" depreciation computation — no React, no Supabase. Straight-line, per-asset.
// Mirrors payrollCompute.js's contract (pure functions, plain objects in/out).
//
// This is deliberately a SEPARATE system from taxPoolCompute.js (Nepal's statutory pooled-WDV
// tax depreciation) — the two are expected to disagree with each other, that's normal, not a bug.

const MS_PER_DAY = 86400000

// Parses a "YYYY-MM-DD" date string (or Date) into a UTC-midnight day count, avoiding the
// local-timezone/DST off-by-one bugs that mixing `new Date(str)` (parsed as UTC) with
// `new Date(y,m-1,d)` (parsed as local) would introduce into day-count arithmetic.
function toUtcDay(dateLike) {
  const d = dateLike instanceof Date ? dateLike : new Date(`${dateLike}T00:00:00Z`)
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / MS_PER_DAY)
}

const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100

// Full annual straight-line charge — never negative (a mis-entered salvage_value > total_cost
// would otherwise produce a negative "depreciation").
export function annualStraightLineAmount({ totalCost, salvageValue, usefulLifeYears }) {
  if (!usefulLifeYears || usefulLifeYears <= 0) return 0
  return Math.max(0, (totalCost - salvageValue) / usefulLifeYears)
}

// Scales annualAmount down to (a) this period's own length (so a shorter-than-a-year period,
// if this ever supports monthly periods, gets a proportionally smaller charge) and (b) the
// fraction of the period actually held, if acquisitionDate falls after periodStart. Returns 0 if
// the asset wasn't yet acquired by periodEnd.
export function proRatedAmount({ annualAmount, periodStart, periodEnd, acquisitionDate }) {
  const startDay = toUtcDay(periodStart)
  const endDay = toUtcDay(periodEnd)
  const acqDay = toUtcDay(acquisitionDate)
  if (acqDay > endDay) return 0

  const periodDays = endDay - startDay + 1
  if (periodDays <= 0) return 0
  const periodFullCharge = annualAmount * (periodDays / 365)

  const heldStartDay = Math.max(startDay, acqDay)
  const heldDays = endDay - heldStartDay + 1
  if (heldDays <= 0) return 0

  return periodFullCharge * (heldDays / periodDays)
}

// Never depreciate below salvage_value, and never a negative charge.
export function clampToSalvageFloor({ openingNbv, proposedCharge, salvageValue }) {
  const maxCharge = Math.max(0, openingNbv - salvageValue)
  return Math.min(Math.max(0, proposedCharge), maxCharge)
}

// One asset's full computed line for a run's period. `priorSchedule` is the most recent POSTED
// schedule row for this asset (or null/undefined for its first-ever run — openingNbv then falls
// back to the asset's own total_cost).
export function computeAssetDepreciationLine({ asset, priorSchedule, periodStart, periodEnd }) {
  const openingNbv = priorSchedule ? priorSchedule.closing_nbv : asset.total_cost
  const annualDepreciation = annualStraightLineAmount({
    totalCost: asset.total_cost,
    salvageValue: asset.salvage_value,
    usefulLifeYears: asset.useful_life_years,
  })
  const rawCharge = proRatedAmount({
    annualAmount: annualDepreciation,
    periodStart,
    periodEnd,
    acquisitionDate: asset.acquisition_date,
  })
  const depreciationAmount = r2(clampToSalvageFloor({
    openingNbv,
    proposedCharge: rawCharge,
    salvageValue: asset.salvage_value,
  }))
  const closingNbv = r2(openingNbv - depreciationAmount)

  return {
    asset_id: asset.id,
    opening_nbv: r2(openingNbv),
    annual_depreciation: r2(annualDepreciation),
    depreciation_amount: depreciationAmount,
    closing_nbv: closingNbv,
  }
}

// Preview for every active asset for a period — pure computation, writes nothing. Disposed/
// written-off assets are excluded (their depreciation is frozen at disposal).
export function computeDepreciationPreview({ assets, priorScheduleByAssetId, periodStart, periodEnd }) {
  return assets
    .filter(a => a.status === 'active')
    .map(asset => computeAssetDepreciationLine({
      asset, priorSchedule: priorScheduleByAssetId?.[asset.id], periodStart, periodEnd,
    }))
}

// gain (positive) or loss (negative) at disposal — proceeds vs. the asset's own closing NBV as
// of its disposal date.
export function computeDisposalGainLoss({ closingNbvAtDisposal, disposalProceeds }) {
  return r2(disposalProceeds - closingNbvAtDisposal)
}

// "YYYY-MM-DD" shifted by n whole days, entirely in UTC so no local offset or DST can move it.
export function addDaysIso(dateLike, n) {
  const day = toUtcDay(dateLike) + n
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10)
}

// The depreciation a schedule row actually charged: a manager's override when there is one,
// otherwise the computed figure. An adjustment run's lines carry a NEGATIVE override (S756).
export function effectiveDepreciation(row) {
  const v = row?.override_amount != null ? row.override_amount : row?.depreciation_amount
  return parseFloat(v) || 0
}

// Latest posted schedule row per asset. Ordered by period_end, then created_at, then id — NOT by
// period_end alone: an adjustment run (S756) re-uses the period of the run it reverses, so two
// rows share a period_end and only the later-written one carries the asset's current NBV. Callers
// used to rely on "last write wins" over a period_end-ordered array, which picked between those
// two by whatever order PostgREST happened to return.
export function latestPostedByAsset(rows) {
  const out = {}
  const key = r => `${r.period_end || ''}|${r.created_at || ''}|${r.id || ''}`
  for (const r of rows || []) {
    const cur = out[r.asset_id]
    if (!cur || key(r) > key(cur)) out[r.asset_id] = r
  }
  return out
}

// D24 (owner decision, S756): a disposal charges depreciation UP TO the disposal date before the
// gain or loss is struck. Before this, the gain/loss was measured against the NBV at the last
// posted run, so an asset sold ten months into a year kept ten months of depreciation on the
// books as a gain it never earned (or hid that much of a loss).
//
// The charge is the SAME straight-line arithmetic a run uses (computeAssetDepreciationLine: annual
// ÷ 365 per day held, salvage floor), over the days from the day after the last posted
// period_end — or the acquisition date, for an asset never through a run — to the disposal date
// inclusive. Returns the schedule line to post (null when there are no uncharged days) and the
// NBV the gain/loss must be measured against.
//
// `postedPastDisposal` is true when a posted run already reaches beyond the disposal date. The
// NBV then includes depreciation charged for days after the asset left, which this function does
// not unwind — reversing posted depreciation is an adjustment run's job, never a silent edit —
// so the caller must say so.
export function computeDisposalDepreciation({ asset, lastPosted, disposalDate }) {
  const lastEnd = lastPosted?.period_end || null
  const periodStart = lastEnd ? addDaysIso(lastEnd, 1) : String(asset.acquisition_date).slice(0, 10)
  const postedPastDisposal = !!lastEnd && toUtcDay(lastEnd) > toUtcDay(disposalDate)
  const openingNbv = r2(lastPosted ? parseFloat(lastPosted.closing_nbv) : asset.total_cost)

  if (toUtcDay(periodStart) > toUtcDay(disposalDate)) {
    return { periodStart, periodEnd: disposalDate, line: null, extraDepreciation: 0, nbvAtDisposal: openingNbv, postedPastDisposal }
  }
  const line = computeAssetDepreciationLine({ asset, priorSchedule: lastPosted || null, periodStart, periodEnd: disposalDate })
  return {
    periodStart,
    periodEnd: disposalDate,
    line: line.depreciation_amount > 0 ? line : null,
    extraDepreciation: line.depreciation_amount,
    nbvAtDisposal: line.closing_nbv,
    postedPastDisposal,
  }
}

// A REGULAR run's override is a replacement charge for the period, so it is bounded the way the
// computed charge is: never negative (that would be a write-up, which is an adjustment run's job)
// and never past the salvage floor. Returns a sentence naming the bound, or '' when valid (S756).
export function regularOverrideError({ override, openingNbv, salvageValue }) {
  if (override === '' || override == null) return ''
  const v = parseFloat(override)
  if (!isFinite(v)) return 'Enter a number, or leave it blank to use the computed figure.'
  if (v < 0) return 'An override cannot be negative. To reverse depreciation already posted, use an adjustment run.'
  const max = r2(Math.max(0, (parseFloat(openingNbv) || 0) - (parseFloat(salvageValue) || 0)))
  if (v > max + 0.005) return `At most ${max.toLocaleString('en-IN')} — more would take the asset below its salvage value.`
  return ''
}

// An ADJUSTMENT run's line reverses part or all of one posted line, so it is bounded by that
// line's own charge: between 0 and minus what it charged. `charged` is effectiveDepreciation() of
// the line being reversed.
export function adjustmentOverrideError({ override, charged }) {
  if (override === '' || override == null) return 'Enter the amount to reverse, or 0 to leave this asset out.'
  const v = parseFloat(override)
  if (!isFinite(v)) return 'Enter a number.'
  const lo = Math.min(0, -charged), hi = Math.max(0, -charged)
  if (v < lo - 0.005 || v > hi + 0.005) {
    return `Between ${r2(lo).toLocaleString('en-IN')} and ${r2(hi).toLocaleString('en-IN')} — that run charged ${r2(charged).toLocaleString('en-IN')} for this asset, and a reversal cannot undo more than it charged.`
  }
  return ''
}

// D23 (owner decision, S756): the depreciation charged inside a window of AD dates, for a MEMO
// line — never subtracted from anything. A posted run can span a year while the window is one BS
// month, so a row is counted by the share of its days that fall inside the window; without that a
// single annual run would land its whole year on whichever month overlapped it. Adjustment lines
// are negative and net off against the run they reverse.
export function depreciationInWindow(rows, windowStart, windowEnd) {
  const ws = toUtcDay(windowStart), we = toUtcDay(windowEnd)
  let amount = 0, count = 0, prorated = false
  for (const r of rows || []) {
    const rs = toUtcDay(r.period_start), re = toUtcDay(r.period_end)
    const overlap = Math.min(re, we) - Math.max(rs, ws) + 1
    const span = re - rs + 1
    if (overlap <= 0 || span <= 0) continue
    if (overlap < span) prorated = true
    amount += effectiveDepreciation(r) * (overlap / span)
    count++
  }
  return { amount: r2(amount), count, prorated }
}

// rows: [{ categoryName, totalCost, nbv }] — one row per active, personal_use_percent === 0
// asset, `nbv` already resolved by the caller to that asset's latest POSTED closing_nbv (or its
// total_cost if it's never been through a posted run yet). Computed on read — no stored aggregate.
export function computePortfolioValuation(rows) {
  const totalCost = rows.reduce((s, r) => s + r.totalCost, 0)
  const nbv = rows.reduce((s, r) => s + r.nbv, 0)
  const byCategoryMap = {}
  rows.forEach(row => {
    const key = row.categoryName || 'Uncategorized'
    if (!byCategoryMap[key]) byCategoryMap[key] = { categoryName: key, totalCost: 0, nbv: 0 }
    byCategoryMap[key].totalCost += row.totalCost
    byCategoryMap[key].nbv += row.nbv
  })
  const byCategory = Object.values(byCategoryMap).map(c => ({
    ...c, accumulatedDepreciation: r2(c.totalCost - c.nbv),
  }))
  return {
    totalCost: r2(totalCost),
    accumulatedDepreciation: r2(totalCost - nbv),
    nbv: r2(nbv),
    byCategory,
  }
}
