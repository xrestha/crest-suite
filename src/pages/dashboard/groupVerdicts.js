// The Group Console's per-row rules (S849 GROUP-4, GAPS-5, DOCS-9). Pure, pinned by
// groupVerdicts.test.js, so the page only draws what these decide.
//
// One clock for every outlet: OD's `mtdClock({ bs_year, bs_month })` (Nepal "today", finished days
// only). On the month still running:
//   - every RATIO divides the finished days: get_group_summary is asked with p_through_day =
//     clock.countedDays and returns revenue_counted / net_purchases_counted beside the full figures
//     (a Bulk bs_day 0 row counts, OD's inCountedDays). The money COLUMNS keep showing everything so
//     far, today included (the dashboards' tile rule).
//   - day 1 has no finished day, so every ratio is "—" (`firstDay`).
//   - before SETTLE_DAY a Spend % so far carries no colour and no ✓/△/▲ — purchases land in lumps and
//     sales accrue daily (the dashboards' `periodTooEarly`). A closed month's Food Cost % never waits.
//   - labour arrives from OD's groupOutletLabour already prorated to the finished days; only a lump
//     (festival, incentive, final settlement) is not, so a row carrying one is not judged mid-month
//     (the Owner Dashboard's lumpAheadOfRevenue).
//   - the revenue change against last month compares part of a month with a whole one, so it is
//     shown without a verdict and says "so far vs all of <month>". A like-for-like day comparison is
//     not built: a Bulk month is one bs_day 0 row, so last month's "same days" would be all of it.
import { periodCostRatio, groupCostRatio, fcBasisOf } from '../../modules/ims/reports/foodCostBasis'
import { compareFigures } from '../../shared/compareFigures'

// The dashboards' own settle threshold (ClientDashboard, OwnerDashboard), deliberately the same.
export const SETTLE_DAY = 10

export const FIRST_DAY_TEXT = 'Ratios start after today — the first full day'

const num = v => Number(v) || 0
const inScope = r => !!r && !!r.is_included && r.has_period !== false

// A figure a row shows, or null for a dash (DOCS-9 / SU21): an outlet left out of the figures, or one
// with no period for the month (it counts as zero in the totals, but its row never prints NPR 0 as if
// that were its month). Covers still shows its count: guests are read from till bills, which need no
// period.
export function rowFigure(r, key) {
  if (!r || !r.is_included) return null
  if (r.has_period === false && key !== 'covers') return null
  return num(r[key])
}

// The pair a RATIO divides: the finished days on the running month, the whole month otherwise. An
// older database with no counted columns falls back to the full pair.
export function ratioPair(r, clock) {
  if (!clock?.running) return { revenue: num(r?.revenue), netPurchases: num(r?.net_purchases) }
  return {
    revenue: num(r?.revenue_counted ?? r?.revenue),
    netPurchases: num(r?.net_purchases_counted ?? r?.net_purchases),
  }
}

// A row's cost ratio (foodCostBasis.periodCostRatio's shape), or null for a dash. A closed month is
// Food Cost % over its whole month and is never withheld; otherwise Spend % so far on the clock's pair.
export function rowCostRatio(r, clock) {
  if (!inScope(r)) return null
  if (fcBasisOf(r.period_status) === 'cogs') {
    return periodCostRatio({ status: r.period_status, revenue: r.revenue, cogs: r.cogs })
  }
  const p = ratioPair(r, clock)
  const ratio = periodCostRatio({ status: r.period_status, revenue: p.revenue, netPurchases: p.netPurchases })
  return clock?.firstDay ? { ...ratio, pct: null } : ratio
}

// The group's cost ratio on the same clock: groupCostRatio's rule (Food Cost % only when every
// included outlet with a period has closed the month), and its Spend % so far on the counted pair.
export function groupRatioOf(rows, clock) {
  const whole = groupCostRatio(rows)
  if (whole.basis === 'cogs' || !clock?.running) return whole
  const counted = groupCostRatio((rows || []).map(r => {
    const p = ratioPair(r, clock)
    return { ...r, revenue: p.revenue, net_purchases: p.netPurchases }
  }))
  return clock.firstDay ? { ...counted, pct: null } : counted
}

// Whether a cost ratio's colour and mark are withheld: a Spend % so far before SETTLE_DAY on the
// running month. A Food Cost % (a closed month) never is.
export function costBandWithheld(ratio, clock) {
  if (!ratio || ratio.basis === 'cogs') return false
  return !!clock?.running && clock.today != null && clock.today < SETTLE_DAY
}

// Labour ÷ revenue for one row on the clock's pair, or null for a dash. groupOutletLabour already
// prorates a run or a Labor tab and accrues the estimate to the counted days, so both sides of the
// ratio sit on the same days.
export function rowLabourPct(r, clock) {
  if (!inScope(r) || !r.labour?.hasFigure || clock?.firstDay) return null
  const rev = ratioPair(r, clock).revenue
  return rev > 0 ? (r.labour.amount / rev) * 100 : null
}

// A lump paid in the running month is not spread over it, so it sits over part of a month's sales.
export function labourWithheld(labour, clock) {
  return !!clock?.running && clock.countedDays < clock.monthDays && !!labour?.other
}

// No band and no mark on a row's Labour %: OD withheld it (pay not set, nobody on payroll, a failed
// or unreadable read) or a lump sits ahead of revenue.
export function labourBandWithheld(labour, clock) {
  return !!labour?.verdictWithheld || labourWithheld(labour, clock)
}

// Each outlet's revenue against last month's, as the line under the Revenue cell, or null for none.
// prevRevenue: undefined = the comparison read failed; null = that outlet had no month to compare.
// → { text, good } — good is null (neutral) on the running month and inside the dead zone.
export function revenueChange(r, clock, prevLabel) {
  if (!inScope(r)) return null
  if (r.prevRevenue === undefined) return { text: `vs ${prevLabel}: couldn't check`, good: null }
  const cmp = compareFigures(num(r.revenue), r.prevRevenue, { floor: 1000 })
  if (!cmp) return null
  const pct = Math.round(cmp.gapPct)
  if (clock?.running) return { text: `${cmp.glyph} ${pct}% so far vs all of ${prevLabel}`, good: null }
  return { text: `${cmp.glyph} ${pct}% vs ${prevLabel}`, good: cmp.good }
}

// Lowest / highest marks (S800) over [{ id, pct }]: only with three or more figures, and none when
// they are all equal. A withheld figure is passed as null by the caller, so it is never ranked.
export function rankMarks(values) {
  const xs = (values || []).filter(v => v.pct != null && Number.isFinite(v.pct))
  if (xs.length < 3) return {}
  const sorted = [...xs].sort((a, b) => a.pct - b.pct)
  return sorted[0].pct === sorted[sorted.length - 1].pct ? {} : { low: sorted[0].id, high: sorted[sorted.length - 1].id }
}
