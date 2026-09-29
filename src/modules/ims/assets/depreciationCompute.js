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
const dayOf = d => String(d || '').slice(0, 10)

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

// D40 (S792 stage 4): depreciation an asset had already taken before Crest — from last year's books
// — as `opening_accumulated_depreciation` "as of" `opening_as_of` (the register's two opening
// columns). It is not a posted charge: no run carries it, so the Overheads memo
// (depreciationInWindow) never counts it, and it is read only here, from the asset row.
// `asOf` null counts it; with a date, only on or after `opening_as_of` (the Valuation report).
// An amount with no date — which the database refuses — counts as taken from the start.
export function openingAccumulated(asset, asOf = null) {
  const amt = parseFloat(asset?.opening_accumulated_depreciation) || 0
  if (amt <= 0) return 0
  if (asOf && asset.opening_as_of && dayOf(asset.opening_as_of) > dayOf(asOf)) return 0
  return amt
}

// The first day a run may charge this asset: its acquisition date, or — when depreciation was
// already taken before Crest — the day after `opening_as_of`, whichever is later. Those earlier
// days are inside the opening amount, so charging them again would take them twice.
export function chargeStartDate(asset) {
  const acq = dayOf(asset?.acquisition_date)
  if (!(openingAccumulated(asset) > 0) || !asset.opening_as_of) return acq
  const after = addDaysIso(dayOf(asset.opening_as_of), 1)
  return after > acq ? after : acq
}

// One asset's full computed line for a run's period. `openingNbv` is the asset's book value going
// into the period — bookValue() over its posted rows (S792, COSTS-2); omitted, it is the asset's
// cost less any depreciation taken before Crest (D40), i.e. its first-ever run. The charge runs
// from chargeStartDate(), never over days the opening amount already covers.
export function computeAssetDepreciationLine({ asset, openingNbv: openingIn, periodStart, periodEnd }) {
  const openingNbv = openingIn != null ? (parseFloat(openingIn) || 0) : bookValue(asset, null)
  const annualDepreciation = annualStraightLineAmount({
    totalCost: asset.total_cost,
    salvageValue: asset.salvage_value,
    usefulLifeYears: asset.useful_life_years,
  })
  const rawCharge = proRatedAmount({
    annualAmount: annualDepreciation,
    periodStart,
    periodEnd,
    acquisitionDate: chargeStartDate(asset),
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
// `chargedThrough` is the last day depreciation still stands charged for — the latest such day over
// every period (periodChargedThrough below). A disposal (D24) charges from the day after it.
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
    const start = dayOf(r.period_start)
    const key = `${start}|${end}`
    const g = a.periods[key] || (a.periods[key] = { start, end, charges: [], reversals: [] })
    const annual = parseFloat(r.annual_depreciation)
    if (amt < 0) g.reversals.push({ amount: -amt, annual })
    else g.charges.push({ amount: amt, left: amt, annual })
  }
  const out = {}
  for (const [assetId, a] of Object.entries(acc)) {
    let through = null
    for (const g of Object.values(a.periods)) {
      const last = periodChargedThrough(g)
      if (last && (!through || last > through)) through = last
    }
    out[assetId] = { charged: r2(a.charged), rows: a.rows, chargedThrough: through }
  }
  return out
}

// The last day of ONE period that still stands charged, or null when none of it does.
//
// An adjustment posts the same period_start/period_end as the run it reverses, so a period's rows
// are settled together. Each negative line is matched to the charge it reverses — the one it undoes
// exactly, else the one with the same annual figure (previewReversal copies it onto the reversal),
// else the largest left — and the period stands charged for as many of its days as its
// most-charged run still covers, at that run's own daily rate. Reversed in full: none of it.
// Reversed in part: its FIRST days only, because a part reversal is read as taking back the LAST
// days of the period — which is what D24's advice asks for (take back what a run charged past a
// disposal date). Until S792 stage 3 a part reversal left the whole period charged, so reversing
// exactly the days after a disposal still read "charged past this date", and reversing more left
// the days in between charged by nobody. Rounded to the nearest day, since posted amounts are
// rounded to the paisa. The documented correction — reverse in full, then post the right figures
// for the same dates — is two runs here: the reversed one covers nothing and the new one covers
// the period. A zero charge with no reversal (an asset already at salvage, an override to 0)
// covers the whole period: those days were deliberately charged nothing.
function periodChargedThrough({ start, end, charges, reversals }) {
  // Largest reversal first, so one that undoes a whole run finds that run before a smaller
  // reversal has taken a bite out of it.
  for (const rev of [...reversals].sort((x, y) => y.amount - x.amount)) {
    const open = charges.filter(c => c.left > 0.005)
    const target = open.find(c => Math.abs(c.left - rev.amount) <= 0.005)
      || open.find(c => Number.isFinite(rev.annual) && Number.isFinite(c.annual) && Math.abs(c.annual - rev.annual) <= 0.005)
      || open.reduce((best, c) => (!best || c.left > best.left ? c : best), null)
    if (target) target.left = Math.max(0, target.left - rev.amount)
  }
  const span = toUtcDay(end) - toUtcDay(start) + 1
  if (span <= 0) return null
  let days = 0
  for (const c of charges) {
    const d = c.amount <= 0.005 ? span : Math.round(span * (c.left / c.amount))
    if (d > days) days = d
  }
  if (days <= 0) return null
  return days >= span ? end : addDaysIso(start, days - 1)
}

// Book value from a bookPositionsByAsset() entry: cost less any depreciation taken before Crest
// (D40, openingAccumulated) less what has been charged. No position (nothing posted) is cost less
// that opening amount. `asOf` (the Valuation report's date) counts the opening amount only on or
// after its own date; the position passed must then be the one cut at the same date.
export function bookValue(asset, position, asOf = null) {
  return r2((parseFloat(asset?.total_cost) || 0) - openingAccumulated(asset, asOf) - (position?.charged || 0))
}

// Which of the figures depreciation is worked out from an asset edit changes (S792, COSTS-8, the
// D5 precedent: warn, naming what changes, before saving). `next` is the register payload about to
// be written. Returns null when none moves; otherwise { cost, acquired, life, salvage, opening,
// openingAsOf } for each that does, each { from, to }, plus `annual` — the straight-line charge a
// full year gets before and after, which is what the next run feels. `opening`/`openingAsOf` are
// D40's "already taken before Crest" pair: an edit moves the book value and where runs start from.
export function depreciationInputChanges(asset, next) {
  const num = v => parseFloat(v) || 0
  const out = {}
  const oldCost = r2(num(asset.total_cost))
  const newCost = r2(num(next.quantity) * num(next.unit_cost))
  if (Math.abs(oldCost - newCost) > 0.005) out.cost = { from: oldCost, to: newCost }
  if (dayOf(asset.acquisition_date) !== dayOf(next.acquisition_date)) out.acquired = { from: dayOf(asset.acquisition_date), to: dayOf(next.acquisition_date) }
  if (Math.abs(num(asset.useful_life_years) - num(next.useful_life_years)) > 1e-9) out.life = { from: num(asset.useful_life_years), to: num(next.useful_life_years) }
  if (Math.abs(num(asset.salvage_value) - num(next.salvage_value)) > 0.005) out.salvage = { from: num(asset.salvage_value), to: num(next.salvage_value) }
  // Only when the payload carries the field: a caller that does not write it changes nothing.
  if ('opening_accumulated_depreciation' in next
      && Math.abs(num(asset.opening_accumulated_depreciation) - num(next.opening_accumulated_depreciation)) > 0.005) {
    out.opening = { from: r2(num(asset.opening_accumulated_depreciation)), to: r2(num(next.opening_accumulated_depreciation)) }
  }
  if ('opening_as_of' in next && dayOf(asset.opening_as_of) !== dayOf(next.opening_as_of)) {
    out.openingAsOf = { from: dayOf(asset.opening_as_of) || null, to: dayOf(next.opening_as_of) || null }
  }
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
// where depreciation taken before Crest (D40) counts as charged through its `opening_as_of`,
// opening at the asset's book value. `position` is the asset's bookPositionsByAsset() entry: since
// S792 (COSTS-2) a run that was reversed in full no longer counts as charging its days, and since
// stage 3 one reversed in part counts only for the days its remaining charge covers — so the D24
// advice (reverse the run that reaches past the disposal date, in full or just the days after it,
// then dispose) charges the days the asset was actually held. Returns the schedule line to post
// (null when there are no uncharged days) and the NBV the gain/loss must be measured against.
//
// `postedPastDisposal` is true when a posted, un-reversed run already reaches beyond the disposal
// date. The NBV then includes depreciation charged for days after the asset left, which this
// function does not unwind — reversing posted depreciation is an adjustment run's job, never a
// silent edit — so the caller must say so, naming `chargedThrough`.
export function computeDisposalDepreciation({ asset, position, disposalDate }) {
  const postedThrough = position?.chargedThrough || null
  // `postedPastDisposal` is about POSTED runs, the thing an adjustment can reverse; the opening
  // amount is not a run, so it only moves where the charge starts.
  const postedPastDisposal = !!postedThrough && toUtcDay(postedThrough) > toUtcDay(disposalDate)
  const openingThrough = openingAccumulated(asset) > 0 && asset.opening_as_of ? dayOf(asset.opening_as_of) : null
  const chargedThrough = postedThrough && (!openingThrough || postedThrough > openingThrough) ? postedThrough : openingThrough
  const periodStart = chargedThrough ? addDaysIso(chargedThrough, 1) : dayOf(asset.acquisition_date)
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
// are negative and net off against the run they reverse. Depreciation taken before Crest (D40,
// openingAccumulated) is deliberately NOT counted: it is no period's expense in these books.
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
// no personal use, each at cost less the charges posted for periods ending on or before it, and less
// any depreciation taken before Crest once the date reaches its `opening_as_of` (D40). Not a
// chosen "latest row" — see bookPositionsByAsset() for why a row cannot carry the book value.
export function computeValuationAsOf({ assets, postedRows, asOf }) {
  const positions = bookPositionsByAsset(postedRows, asOf)
  const rows = (assets || [])
    .filter(a => (a.personal_use_percent ?? 0) === 0 && assetHeldOn(a, asOf))
    .map(a => ({
      categoryName: a.assets_categories?.name || 'Uncategorized',
      totalCost: parseFloat(a.total_cost) || 0,
      nbv: bookValue(a, positions[a.id], asOf),
    }))
  return computePortfolioValuation(rows)
}
