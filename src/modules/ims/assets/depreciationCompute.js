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
