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

// One asset's full computed line for a run's period. `openingNbv` is the asset's book value going
// into the period — bookValue() over its posted rows (S792, COSTS-2); omitted, it is the asset's own
// total_cost, i.e. its first-ever run.
export function computeAssetDepreciationLine({ asset, openingNbv: openingIn, periodStart, periodEnd }) {
  const openingNbv = openingIn != null ? (parseFloat(openingIn) || 0) : asset.total_cost
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
// written-off assets are excluded (their depreciation is frozen at disposal). `positions` is
// bookPositionsByAsset() over the client's posted schedule.
export function computeDepreciationPreview({ assets, positions, periodStart, periodEnd }) {
  return assets
    .filter(a => a.status === 'active')
    .map(asset => computeAssetDepreciationLine({
      asset, openingNbv: bookValue(asset, positions?.[asset.id]), periodStart, periodEnd,
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

const dayOf = d => String(d || '').slice(0, 10)

// Where each asset stands on the books, from its POSTED schedule rows (S792, COSTS-2).
//
// Current NBV used to be the closing_nbv of the asset's latest row BY PERIOD END. But every posting
// opens from the book value current at the moment it is posted, so the chain runs in POSTING order,
// and the D24 corrections are exactly the postings that break period order: an adjustment re-uses
// the period of the run it reverses, so reversing any run but the last-ending one lost to that
// later run's row; a back-dated run posted after a later one lost the same way; and "post the right
// figures as a normal run" after a reversal ended before the adjustment and lost to it. Register,
// Asset Card, Valuation and the next run's opening then ignored the write-back while the Overheads
// memo, which sums the charges, counted it.
//
// So book value is cost less every charge actually posted, reversals included, whatever period
// each covers (`charged`, through bookValue()). In an unbroken chain that equals the last-posted
// row's closing NBV. Where the chain is broken — rows posted before this fix, or a cost edited
// after posting (COSTS-8) — it is the figure that agrees with the depreciation expense.
//
// `asOf` ("YYYY-MM-DD") keeps only rows for periods ending on or before it: the Valuation report's
// "as of". A reversal posted later for an earlier period counts there; a run ending after the date
// does not.
//
// `chargedThrough` is the last day depreciation still stands charged for: the latest period_end
// among periods NOT reversed in full. An adjustment posts the same period_start/period_end as the
// run it reverses, so a period whose rows include a negative line and net to nothing was, on the
// books, never charged — and a disposal (D24) charges from the day after `chargedThrough`, not from
// the day after the reversed run. A partly reversed period still counts as charged: the reversal
// corrected its amount, not its days. A zero charge with no reversal (an asset already at salvage,
// an override to 0) also counts: those days were deliberately charged nothing.
export function bookPositionsByAsset(rows, asOf = null) {
  const cut = asOf ? dayOf(asOf) : null
  const acc = {}
  for (const r of rows || []) {
    const end = dayOf(r.period_end)
    if (cut && end > cut) continue
    const a = acc[r.asset_id] || (acc[r.asset_id] = { charged: 0, rows: 0, periods: {} })
    const amt = effectiveDepreciation(r)
    a.charged += amt
    a.rows++
    const key = `${dayOf(r.period_start)}|${end}`
    const g = a.periods[key] || (a.periods[key] = { end, net: 0, reversed: false })
    g.net += amt
    if (amt < 0) g.reversed = true
  }
  const out = {}
  for (const [assetId, a] of Object.entries(acc)) {
    let through = null
    for (const g of Object.values(a.periods)) {
      if (g.reversed && g.net <= 0.005) continue
      if (!through || g.end > through) through = g.end
    }
    out[assetId] = { charged: r2(a.charged), rows: a.rows, chargedThrough: through }
  }
  return out
}

// Book value from a bookPositionsByAsset() entry: cost less what has been charged. No position
// (nothing posted) is the full cost.
export function bookValue(asset, position) {
  return r2((parseFloat(asset?.total_cost) || 0) - (position?.charged || 0))
}

// Which of the figures depreciation is worked out from an asset edit changes (S792, COSTS-8, the
// D5 precedent: warn, naming what changes, before saving). `next` is the register payload about to
// be written. Returns null when none moves; otherwise { cost, acquired, life, salvage } for each
// that does, each { from, to }, plus `annual` — the straight-line charge a full year gets before
// and after, which is what the next run feels.
export function depreciationInputChanges(asset, next) {
  const num = v => parseFloat(v) || 0
  const out = {}
  const oldCost = r2(num(asset.total_cost))
  const newCost = r2(num(next.quantity) * num(next.unit_cost))
  if (Math.abs(oldCost - newCost) > 0.005) out.cost = { from: oldCost, to: newCost }
  if (dayOf(asset.acquisition_date) !== dayOf(next.acquisition_date)) out.acquired = { from: dayOf(asset.acquisition_date), to: dayOf(next.acquisition_date) }
  if (Math.abs(num(asset.useful_life_years) - num(next.useful_life_years)) > 1e-9) out.life = { from: num(asset.useful_life_years), to: num(next.useful_life_years) }
  if (Math.abs(num(asset.salvage_value) - num(next.salvage_value)) > 0.005) out.salvage = { from: num(asset.salvage_value), to: num(next.salvage_value) }
  if (Object.keys(out).length === 0) return null
  const annualOf = (cost, salvage, life) => r2(annualStraightLineAmount({ totalCost: cost, salvageValue: salvage, usefulLifeYears: life }))
  out.annual = {
    from: annualOf(oldCost, num(asset.salvage_value), num(asset.useful_life_years)),
    to: annualOf(newCost, num(next.salvage_value), num(next.useful_life_years)),
  }
  return out
}

// D24 (owner decision, S756): a disposal charges depreciation UP TO the disposal date before the
// gain or loss is struck. Before this, the gain/loss was measured against the NBV at the last
// posted run, so an asset sold ten months into a year kept ten months of depreciation on the
// books as a gain it never earned (or hid that much of a loss).
//
// The charge is the SAME straight-line arithmetic a run uses (computeAssetDepreciationLine: annual
// ÷ 365 per day held, salvage floor), over the days from the day after `chargedThrough` — or the
// acquisition date, for an asset with nothing still charged — to the disposal date inclusive,
// opening at the asset's book value. `position` is the asset's bookPositionsByAsset() entry: since
// S792 (COSTS-2) a run that was reversed in full no longer counts as charging its days, so the
// D24 advice — reverse the run that reaches past the disposal date, then dispose — charges the days
// the asset was actually held. Returns the schedule line to post (null when there are no uncharged
// days) and the NBV the gain/loss must be measured against.
//
// `postedPastDisposal` is true when a posted, un-reversed run already reaches beyond the disposal
// date. The NBV then includes depreciation charged for days after the asset left, which this
// function does not unwind — reversing posted depreciation is an adjustment run's job, never a
// silent edit — so the caller must say so, naming `chargedThrough`.
export function computeDisposalDepreciation({ asset, position, disposalDate }) {
  const chargedThrough = position?.chargedThrough || null
  const periodStart = chargedThrough ? addDaysIso(chargedThrough, 1) : dayOf(asset.acquisition_date)
  const postedPastDisposal = !!chargedThrough && toUtcDay(chargedThrough) > toUtcDay(disposalDate)
  const openingNbv = bookValue(asset, position)

  if (toUtcDay(periodStart) > toUtcDay(disposalDate)) {
    return { periodStart, periodEnd: disposalDate, line: null, extraDepreciation: 0, nbvAtDisposal: openingNbv, postedPastDisposal, chargedThrough }
  }
  const line = computeAssetDepreciationLine({ asset, openingNbv, periodStart, periodEnd: disposalDate })
  return {
    periodStart,
    periodEnd: disposalDate,
    line: line.depreciation_amount > 0 ? line : null,
    extraDepreciation: line.depreciation_amount,
    nbvAtDisposal: line.closing_nbv,
    postedPastDisposal,
    chargedThrough,
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

// rows: [{ categoryName, totalCost, nbv }] — one row per asset held on the valuation date with
// personal_use_percent === 0, `nbv` already resolved by the caller (computeValuationAsOf). Computed
// on read — no stored aggregate.
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

// Was the asset on the books at the end of `asOf`? Acquired on or before it, and not yet gone:
// still active, or disposed / written off AFTER that date (S792, COSTS-4). Filtering on today's
// status dropped a fridge sold in Poush out of the valuation for the Ashadh before it, when it was
// still owned — understating cost, accumulated depreciation and NBV for that date.
export function assetHeldOn(asset, asOf) {
  const day = dayOf(asOf)
  if (!asset || dayOf(asset.acquisition_date) > day) return false
  if (asset.status === 'active') return true
  const gone = dayOf(asset.disposal_date)
  return !!gone && gone > day
}

// The portfolio valuation as of a date (S792, COSTS-2/COSTS-4): every asset held on that date with
// no personal use, each at cost less the charges posted for periods ending on or before it. Not a
// chosen "latest row" — see bookPositionsByAsset() for why a row cannot carry the book value.
export function computeValuationAsOf({ assets, postedRows, asOf }) {
  const positions = bookPositionsByAsset(postedRows, asOf)
  const rows = (assets || [])
    .filter(a => (a.personal_use_percent ?? 0) === 0 && assetHeldOn(a, asOf))
    .map(a => ({
      categoryName: a.assets_categories?.name || 'Uncategorized',
      totalCost: parseFloat(a.total_cost) || 0,
      nbv: bookValue(a, positions[a.id]),
    }))
  return computePortfolioValuation(rows)
}
