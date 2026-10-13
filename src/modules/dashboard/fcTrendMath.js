/**
 * The Food Cost % — Monthly Trend chart's arithmetic (S826): which months may be compared, what the
 * Average is made of, what a month cost in rupees against the Good line, how low a month with an
 * incomplete count could really be, and which stretch of the line is drawn solid, faded or dashed.
 *
 * WHY THIS FILE EXISTS
 *
 * A client's chart drew Asha → Shra → Bhad → Ashw as a steady fall from 60% to 43%, and the data said
 * none of it. Asha and Shra were closed with incomplete counts (D6, the grey dots), and an uncounted
 * item counts its whole stock as used, so both read HIGH by an unknown amount. Ashw was Spend % so
 * far, a different measure (D30). Bhad was the one solid figure. Around it the chart said three more
 * wrong things: the Average (51.5%) blended both grey months in, Best month and Highest month were
 * both Bhad (one counted month wins and loses at once), and the 35% Good line was not drawn at all,
 * because Recharts discards a reference line outside an auto domain.
 *
 * So: the Average, Best and Highest are made from fully counted months only; Best and Highest need
 * two of them; a grey month carries the range its true figure lies in; and the line itself says
 * which stretches it can vouch for.
 *
 * Pure: no Supabase, no React. `loadFcTrend` in ClientDashboard builds the points; the chart draws
 * the rows this returns.
 */

/** Best month and Highest month need this many fully counted months; one month cannot be both. */
export const MIN_COMPARED_MONTHS = 2

const round1 = n => Math.round(n * 10) / 10
const sum = (list, key) => list.reduce((s, p) => s + (Number(p[key]) || 0), 0)
const isClosed = p => !!p && !p.open
const isCounted = p => isClosed(p) && !p.unjudged
const isGrey = p => isClosed(p) && !!p.unjudged
const pctChange = (now, before) => (before > 0 && now != null ? ((now - before) / before) * 100 : null)

/**
 * The lowest a grey month's Food Cost % could really be, or null when it has no range to show.
 *
 * An uncounted item enters COGS with a closing of zero, so its opening stock and its purchases all
 * read as used (uncountedItems.js). `uncountedValue` is that stock's opening + purchase value, so
 * the month's true COGS lies between `cogs − uncountedValue` (none of it used) and `cogs` (all of
 * it used). The low end over-reaches slightly — the item's wastage and staff meals were already
 * taken off COGS — which makes the range wider than it has to be, never narrower.
 */
export function lowestPossibleFc(p) {
  if (!isGrey(p) || p.fc == null || p.cogs == null || !(p.revenue > 0) || !(p.uncountedValue > 0)) return null
  const low = (Math.max(0, p.cogs - p.uncountedValue) / p.revenue) * 100
  return round1(Math.min(low, p.fc))
}

/**
 * NPR a closed month spent on stock above (positive) or under (negative) the client's Good line —
 * what that month's sales would have cost at exactly `warnPct`. Each point of Food Cost % is 1% of
 * the month's sales, so this is the figure the percentage is standing in for.
 */
export function aboveGoodLine(p, warnPct) {
  if (!isClosed(p) || p.cogs == null || !(p.revenue > 0) || warnPct == null) return null
  return p.cogs - (warnPct / 100) * p.revenue
}

/**
 * Everything the chart draws, from the points `loadFcTrend` built (chronological; the open month,
 * when present, last).
 *
 * Returns
 *   rows        the points, each with the series the chart plots:
 *                 solid   fc on a fully counted month (segments between two of them are solid)
 *                 faded   fc on a grey month and on its neighbours, so every segment touching a grey
 *                         month is drawn faint; a counted–counted segment is in both and the solid
 *                         line is drawn over it
 *                 bridge  fc on the open month and the month before it: the dashed last step
 *                 range   [fc − low, 0] for ErrorBar (lower and upper error), grey months only
 *               plus lowFc, aboveGood (NPR, signed) and change (vs the closed month before).
 *   average     { pct, months, leftOut } — Σ COGS ÷ Σ sales over fully counted months, or null
 *   best, highest   counted points, or null below MIN_COMPARED_MONTHS
 *   above       { npr, months } — Σ aboveGood over counted months (= (average − warn) × their sales)
 *   pointValue  NPR one point of Food Cost % is worth in an average closed month's sales
 *   closedCount, countedCount
 */
export function fcTrendView(points, { warnPct } = {}) {
  const list = points || []
  const closed = list.filter(isClosed)
  const counted = closed.filter(isCounted)

  const countedRev = sum(counted, 'revenue')
  const average = countedRev > 0
    ? { pct: (sum(counted, 'cogs') / countedRev) * 100, months: counted.length, leftOut: closed.length - counted.length }
    : null

  const compared = counted.length >= MIN_COMPARED_MONTHS
  const best = compared ? counted.reduce((b, p) => (p.fc < b.fc ? p : b)) : null
  const highest = compared ? counted.reduce((w, p) => (p.fc > w.fc ? p : w)) : null

  const above = average && warnPct != null
    ? { npr: counted.reduce((s, p) => s + aboveGoodLine(p, warnPct), 0), months: counted.length }
    : null

  // Sales are not touched by a missing count, so every closed month is a fair sample of them.
  const closedRev = sum(closed, 'revenue')
  const pointValue = closed.length && closedRev > 0 ? closedRev / closed.length / 100 : null

  const openIdx = list.findIndex(p => p && p.open)
  let prevClosed = null
  const rows = list.map((p, i) => {
    const low = lowestPossibleFc(p)
    const onBridge = openIdx > 0 && (i === openIdx || (i === openIdx - 1 && isClosed(p)))
    let change = null
    if (isClosed(p) && prevClosed) {
      const bothCounted = isCounted(p) && isCounted(prevClosed)
      change = {
        prevLabel: prevClosed.label,
        salesPct: pctChange(p.revenue, prevClosed.revenue),
        // A grey month's stock used is overstated, so a change measured to or from it is not real.
        usedPct: bothCounted ? pctChange(p.cogs, prevClosed.cogs) : null,
        fcPts: bothCounted ? round1(p.fc - prevClosed.fc) : null,
      }
    }
    if (isClosed(p)) prevClosed = p
    return {
      ...p,
      solid: isCounted(p) ? p.fc : null,
      faded: isClosed(p) && (isGrey(p) || isGrey(list[i - 1]) || isGrey(list[i + 1])) ? p.fc : null,
      bridge: onBridge ? p.fc : null,
      lowFc: low,
      range: low != null ? [round1(p.fc - low), 0] : null,
      aboveGood: isCounted(p) ? aboveGoodLine(p, warnPct) : null,
      change,
    }
  })

  return { rows, average, best, highest, above, pointValue, closedCount: closed.length, countedCount: counted.length }
}
