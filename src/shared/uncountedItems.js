/**
 * Items that held stock in a period but have no closing count — and whether that gap is big enough
 * that the period's food cost % must not be judged (S756, owner decision D6).
 *
 * WHY THIS EXISTS
 *
 * COGS = opening + net purchases − wastage − staff meals − closing. An item with NO closing count
 * contributes a closing of zero, so its whole opening stock and every purchase read as consumed.
 * On the summary pages (Stock Count's Summary, Monthly Summary, Annual Summary, Period Comparison)
 * that is not an error anyone sees: COGS just comes out high, FC% comes out high, and `fcBand()`
 * paints it amber or red with a ▲ — a verdict about the kitchen built out of a shelf nobody counted.
 * The variance pages already exclude and name such items (S719); these pages cannot exclude them,
 * because their totals must keep tying to the Periods close and the frozen report, so they keep the
 * totals and instead NAME the gap and WITHHOLD the verdict while it is material.
 *
 * WHAT COUNTS AS "COUNTED" — the S695 rule, and closePeriod.js's `physical_qty IS NOT NULL`:
 * a closing_stock row with physical_qty 0 IS a count ("we looked, there was none"). A blank, a
 * NULL physical_qty or no row at all is not. Callers build `countedIds` from rows whose
 * physical_qty is not null — never from `> 0`, which would turn every counted-empty shelf into an
 * uncounted one.
 *
 * WHICH ITEMS ARE ASKED ABOUT: active, non-sub-recipe items with stock PRESENCE in the period —
 * an opening quantity or a purchase. An item with neither has nothing a missing count could
 * overstate, and listing it would bury the ones that matter.
 *
 * MATERIALITY (the owner's rule): the gap is material when EITHER
 *   - the uncounted items are ≥ 5% of the items with stock presence, OR
 *   - their opening + purchase value is ≥ 5% of the period's COGS.
 * Two tests, whichever is more forgiving to the reader — the S644 shape: a count share alone
 * ignores that one uncounted case of saffron can outweigh forty uncounted spice jars, and a value
 * share alone ignores a long tail of small items that together say the count was not finished.
 * A COGS of zero or less with any uncounted value is material: there is no denominator to be small
 * against, and a negative COGS is itself a sign of a broken count.
 */

export const UNCOUNTED_MATERIAL_SHARE = 0.05
/** Names shown before the rest collapse behind a disclosure. */
export const UNCOUNTED_NAME_LIMIT = 10

const num = v => {
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : 0
}

const has = (set, id) => {
  if (!set) return false
  if (set instanceof Set || set instanceof Map) return set.has(id)
  return Object.prototype.hasOwnProperty.call(set, id)
}

/** The owner's materiality rule, on already-aggregated figures. */
export function isMaterialGap({ presentCount = 0, uncountedCount = 0, uncountedValue = 0, cogs = 0 } = {}) {
  if (!(uncountedCount > 0)) return false
  if (presentCount > 0 && uncountedCount / presentCount >= UNCOUNTED_MATERIAL_SHARE) return true
  if (!(cogs > 0)) return uncountedValue > 0
  return uncountedValue / cogs >= UNCOUNTED_MATERIAL_SHARE
}

/**
 * The gap for ONE period.
 *
 * @param {object}   args
 * @param {object[]} args.items         item rows: `{ id, name, per_uom_rate, is_active?, is_sub_recipe? }`.
 *                                      Inactive and sub-recipe rows are ignored here whatever the
 *                                      caller loaded.
 * @param {object}   args.openingQty    item id → opening quantity (base units)
 * @param {object}   args.purchaseQty   item id → purchased quantity (base units)
 * @param {object}  [args.purchaseValue] item id → what the purchases cost (net of bill discount).
 *                                      Falls back to qty × per_uom_rate for an id it lacks.
 * @param {Set|object} args.countedIds  ids with a closing row whose physical_qty is NOT null
 * @param {number}   args.cogs          the period's COGS, for the value half of the rule
 * @returns {{ presentCount, uncountedCount, uncountedValue, cogs, material, uncounted: {id,name,value}[] }}
 *          `uncounted` is sorted by value, largest first, so the names a reader sees before the
 *          list collapses are the ones moving the figure most.
 */
export function findUncountedItems({ items, openingQty = {}, purchaseQty = {}, purchaseValue, countedIds, cogs = 0 }) {
  let presentCount = 0
  let uncountedValue = 0
  const uncounted = []
  for (const item of items || []) {
    if (!item || item.is_active === false || item.is_sub_recipe) continue
    const open = num(openingQty[item.id])
    const bought = num(purchaseQty[item.id])
    if (!(open > 0) && !(bought > 0)) continue
    presentCount++
    if (has(countedIds, item.id)) continue
    const rate = num(item.per_uom_rate)
    const boughtValue = purchaseValue && has(purchaseValue, item.id) ? num(purchaseValue[item.id]) : bought * rate
    const value = open * rate + boughtValue
    uncountedValue += value
    uncounted.push({ id: item.id, name: item.name || '(unnamed item)', value })
  }
  uncounted.sort((a, b) => b.value - a.value || String(a.name).localeCompare(String(b.name)))
  const gap = { presentCount, uncountedCount: uncounted.length, uncountedValue, cogs: num(cogs), uncounted }
  gap.material = isMaterialGap(gap)
  return gap
}

/**
 * Several periods' gaps as one — Annual Summary's year total. Presence is counted per item-per-
 * period, so "5% of items" becomes 5% of item-months, which is what the year's COGS is built from.
 */
export function mergeGaps(gaps) {
  const merged = { presentCount: 0, uncountedCount: 0, uncountedValue: 0, cogs: 0, uncounted: [] }
  for (const g of gaps || []) {
    if (!g) continue
    merged.presentCount += g.presentCount
    merged.uncountedCount += g.uncountedCount
    merged.uncountedValue += g.uncountedValue
    merged.cogs += g.cogs
  }
  merged.material = isMaterialGap(merged)
  return merged
}

/** The headline sentence. `scope` names the period, e.g. "Bhadra 2083". */
export function gapHeadline(gap, scope) {
  if (!gap || !gap.uncountedCount) return ''
  const n = gap.uncountedCount
  const lead = `${n} of ${gap.presentCount} item${gap.presentCount === 1 ? '' : 's'} ${n === 1 ? 'has' : 'have'} no closing count${scope ? ` for ${scope}` : ''}`
  return gap.material
    ? `${lead} — food cost is overstated until ${n === 1 ? 'it is' : 'they are'} counted`
    : `${lead} — a small gap, but COGS still counts ${n === 1 ? 'its' : 'their'} whole stock as used`
}

/** One line for an Excel sheet's notes or a print header — the headline plus every name. */
export function gapNote(gap, scope) {
  if (!gap || !gap.uncountedCount) return null
  const names = gap.uncounted.map(u => u.name).join(', ')
  const verdict = gap.material ? ' Food cost % is not judged for this period: the count is incomplete.' : ''
  return `${gapHeadline(gap, scope)}.${verdict}${names ? ` Not counted: ${names}.` : ''}`
}

/** "12.3%" with no colour, no ✓/△/▲ — the shape of fcFigure() for a figure that is not judged. */
export function unjudgedFcFigure(pct, { decimals = 1, reason = 'Not judged: count incomplete' } = {}) {
  const valid = pct != null && Number.isFinite(pct)
  return {
    style: { color: 'var(--theme-text1)' },
    title: valid ? `${reason} — food cost reads high until every item with stock is counted.` : undefined,
    text: valid ? `${pct.toFixed(decimals)}%` : '—',
    band: { key: 'unjudged', label: reason, mark: '', color: 'var(--theme-text1)' },
  }
}

// The product's amber banner — PayrollRun's stale-draft card, the whole border tinted and an 8%
// fill (design-system.md, S741). Taken wholesale so the four pages that show this cannot drift.
const amberBanner = {
  marginBottom: 16, padding: '12px 16px', fontSize: 13, lineHeight: 1.6,
  color: 'var(--theme-text2)',
  borderColor: 'color-mix(in srgb, var(--theme-amber) 35%, transparent)',
  background: 'color-mix(in srgb, var(--theme-amber) 8%, transparent)',
}

/**
 * The warning, naming the count and the items. The first UNCOUNTED_NAME_LIMIT names (largest value
 * first) are always visible; the rest sit behind a native <details>, so nothing needs state and the
 * disclosure is keyboard-operable for free. `children` carries a page-specific closing sentence.
 */
export function UncountedItemsBanner({ gap, scope, children, className = '' }) {
  if (!gap || !gap.uncountedCount) return null
  const shown = gap.uncounted.slice(0, UNCOUNTED_NAME_LIMIT)
  const rest = gap.uncounted.slice(UNCOUNTED_NAME_LIMIT)
  return (
    <div role="alert" className={`card ${className}`.trim()} style={amberBanner}>
      <strong style={{ color: 'var(--theme-amber-text)' }}>△ {gapHeadline(gap, scope)}.</strong>{' '}
      {gap.material
        ? 'Without a count, everything still on the shelf reads as used. Totals below still include them; food cost % is shown without a verdict until the count is finished.'
        : 'Totals below include them.'}
      {children ? <> {children}</> : null}
      <div style={{ marginTop: 6 }}>
        Not counted: {shown.map(u => u.name).join(', ')}
        {rest.length > 0 && (
          <details style={{ display: 'inline' }}>
            <summary style={{ display: 'inline', cursor: 'pointer', color: 'var(--theme-accent-ink)' }}>
              {' '}and {rest.length} more
            </summary>
            {' '}{rest.map(u => u.name).join(', ')}
          </details>
        )}
      </div>
    </div>
  )
}
