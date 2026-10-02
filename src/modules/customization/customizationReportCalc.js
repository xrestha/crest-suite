// Crest Customization Report (S758 stage 8): the pure arithmetic, kept out of the page so it can be
// tested and so the four tabs cannot disagree about what a "customized plate" is.
//
// Definitions, stated once:
//   plate            one unit of qty on a bill line. A line of 3 × "Momo, Half + cheese" is three
//                    plates, and each of its choices was picked three times.
//   customizable     a dish that has at least one option group attached today, or that sold with a
//                    choice in the range (a group detached since still counts for its own sales).
//   extra charged    Σ the price each choice actually added (snapshot price_delta, so a free
//                    "first N" pick adds 0) × plates, EX-VAT and BEFORE any bill-level discount —
//                    the discount is spread over whole bills, not over choices. Comped plates were
//                    made but not paid for, so they count as picks and add nothing charged.
//                    Split by sign into `extrasEarned` (the positive picks — add-ons) and
//                    `sizeAdjustments` (the negative ones — a Half priced below the dish), because a
//                    net figure hid a size discount inside the add-on income (S759).
//   group kind       from the option catalog as it is TODAY (`kindByOptionId`); a snapshot whose
//                    option has since been deleted, or written by a bundle that stored no option
//                    id, is 'unknown'. `listPriceDelta` is the option's list price the same way —
//                    null when unknown — so the Margin tab can tell a free-by-design choice from
//                    a paid one that lost money.
//   cost per plate   the choice's frozen stock lines valued at TODAY's item rate. The lines are what
//                    was on the plate; the rate is the only one available and moves with purchases,
//                    which the page says.

const num = v => Number(v) || 0

/**
 * @param {{ lines, snapshots, attachedRecipeIds, kindByOptionId?, listPriceByOptionId? }} input
 *   lines      [{ id, recipe_id, name, qty, comped, selection_key }] — paid bills in range
 *   snapshots  [{ order_item_id, option_id, group_name, option_name, is_removal, price_delta }]
 *   attachedRecipeIds  Set of recipe ids with a group attached today
 *   kindByOptionId     { [option_id]: 'size' | 'addon' | 'choice' } from today's catalog
 *   listPriceByOptionId { [option_id]: number } today's list price_delta per option
 */
export function buildCustomizationReport({ lines, snapshots, attachedRecipeIds, kindByOptionId = {}, listPriceByOptionId = {} }) {
  const byLine = new Map()
  for (const s of snapshots || []) {
    if (!byLine.has(s.order_item_id)) byLine.set(s.order_item_id, [])
    byLine.get(s.order_item_id).push(s)
  }

  const options = new Map()   // option key -> row
  const dishes = new Map()    // recipe_id -> { name, plates, customizedPlates }
  const removalsByDish = new Map() // `${recipe}|${optionKey}` -> row
  let customizablePlates = 0
  let customizedPlates = 0
  let extrasEarned = 0
  let sizeAdjustments = 0

  const attached = attachedRecipeIds || new Set()
  const soldCustomized = new Set((lines || []).filter(l => l.selection_key).map(l => l.recipe_id))

  for (const l of lines || []) {
    if (!l.recipe_id) continue
    const plates = num(l.qty)
    if (plates <= 0) continue
    const customizable = attached.has(l.recipe_id) || soldCustomized.has(l.recipe_id)
    if (!customizable) continue
    customizablePlates += plates
    const d = dishes.get(l.recipe_id) || { recipe_id: l.recipe_id, name: l.name, plates: 0, customizedPlates: 0 }
    d.plates += plates
    const picks = l.selection_key ? (byLine.get(l.id) || []) : []
    if (picks.length) {
      d.customizedPlates += plates
      customizedPlates += plates
    }
    dishes.set(l.recipe_id, d)

    for (const p of picks) {
      const key = p.option_id || `${p.group_name}|${p.option_name}`
      const charged = l.comped ? 0 : num(p.price_delta) * plates
      const o = options.get(key) || {
        key, option_id: p.option_id || null, option_name: p.option_name, group_name: p.group_name,
        is_removal: !!p.is_removal, picks: 0, charged: 0, dishes: new Set(), sampleDeltas: p.ingredient_deltas || null,
      }
      o.picks += plates
      o.charged += charged
      o.dishes.add(l.name)
      if (!o.sampleDeltas && p.ingredient_deltas) o.sampleDeltas = p.ingredient_deltas
      options.set(key, o)
      if (charged > 0) extrasEarned += charged
      else sizeAdjustments += charged
      if (p.is_removal) {
        const rk = `${l.recipe_id}|${key}`
        const r = removalsByDish.get(rk) || { dish: l.name, option_name: p.option_name, picks: 0, dishPlates: 0, recipe_id: l.recipe_id }
        r.picks += plates
        removalsByDish.set(rk, r)
      }
    }
  }

  for (const r of removalsByDish.values()) r.dishPlates = dishes.get(r.recipe_id)?.plates || 0

  const optionRows = [...options.values()]
    .map(o => {
      const known = o.option_id != null && Object.prototype.hasOwnProperty.call(listPriceByOptionId || {}, o.option_id)
      return {
        ...o,
        dishes: [...o.dishes].sort(),
        chargedPerPick: o.picks ? o.charged / o.picks : 0,
        group_kind: (o.option_id != null && kindByOptionId?.[o.option_id]) || 'unknown',
        listPriceDelta: known ? num(listPriceByOptionId[o.option_id]) : null,
      }
    })
    .sort((a, b) => b.picks - a.picks || String(a.option_name).localeCompare(String(b.option_name)))

  return {
    customizablePlates,
    customizedPlates,
    customizedShare: customizablePlates > 0 ? customizedPlates / customizablePlates : null,
    extraCharged: extrasEarned + sizeAdjustments,
    extrasEarned,
    sizeAdjustments,
    options: optionRows,
    removals: optionRows.filter(o => o.is_removal),
    removalsByDish: [...removalsByDish.values()].sort((a, b) => b.picks - a.picks),
    dishes: [...dishes.values()]
      .map(d => ({ ...d, share: d.plates ? d.customizedPlates / d.plates : 0 }))
      .sort((a, b) => b.plates - a.plates || String(a.name).localeCompare(String(b.name))),
  }
}

/**
 * The "Most added" tile: the most-picked option that is neither a removal nor a size. A size is
 * picked on every plate of a dish that has one — it is a question the guest must answer, not a
 * thing they asked for — so it would win the tile on every menu with a Half/Full. Rows arrive
 * sorted by picks desc, so the first survivor is the answer. Null when nothing qualifies.
 */
export function mostAddedOf(optionRows) {
  return (optionRows || []).find(o => !o.is_removal && o.group_kind !== 'size') || null
}

/**
 * Cost per plate of each choice: its frozen stock lines through the delta explosion, valued at the
 * given per-base-unit rates. Null when the choice has no stock lines (it changes nothing in stock),
 * which the page shows as "no stock lines" rather than a cost of 0.
 * @param {object[]} optionRows  from buildCustomizationReport
 * @param {(deltas) => Array<{item_id, qty}>} toItems  deltaItems bound to an explosion
 * @param {Record<string, number>} rateByItem
 */
export function withOptionCosts(optionRows, toItems, rateByItem) {
  return (optionRows || []).map(o => {
    if (!o.sampleDeltas?.length) return { ...o, costPerPick: null }
    const cost = toItems(o.sampleDeltas).reduce((s, { item_id, qty }) => s + qty * num(rateByItem?.[item_id]), 0)
    return { ...o, costPerPick: cost }
  })
}

/**
 * The lines of one set of bills, and only their choices (S800). The page reads the chosen range and
 * the equal range before it in one pass, then slices each out, so the comparison and the trend cost
 * no second round of reads. Lines carry `order_id`; a choice belongs to the line it was picked on.
 */
export function sliceByOrders(lines, snapshots, orderIds) {
  const ids = orderIds instanceof Set ? orderIds : new Set(orderIds)
  const sliced = (lines || []).filter(l => ids.has(l.order_id))
  const lineIds = new Set(sliced.map(l => l.id))
  return { lines: sliced, snapshots: (snapshots || []).filter(s => lineIds.has(s.order_item_id)) }
}

// A dish's weekly share counts only from this many plates — a week of three plates swings 33 points
// on one guest, which is noise, not a trend.
export const TREND_MIN_PLATES = 5
// A fall this large, week on week, is flagged (percentage points).
export const TREND_DROP_POINTS = 10

/**
 * The weekly share of plates customized, for the `topN` dishes with the most plates over the whole
 * range (S800). `weekOfOrder` maps an order id to its week index (0 = oldest); `weekCount` is how
 * many weeks there are. Which dishes are customizable is decided over the WHOLE range (attached
 * today, or sold with a choice anywhere in it), so a quiet week cannot flip a dish in and out.
 * A week under TREND_MIN_PLATES for a dish is null for it, drawn as a gap, never as 0%.
 *
 * `drops` names the dishes whose last week fell by TREND_DROP_POINTS or more against the week
 * before — the flag the owner acts on.
 */
export function weeklyDishShares({ lines, snapshots, weekOfOrder, weekCount, attachedRecipeIds, topN = 5 }) {
  const attached = new Set([...(attachedRecipeIds || []), ...(lines || []).filter(l => l.selection_key).map(l => l.recipe_id)])
  const whole = buildCustomizationReport({ lines, snapshots, attachedRecipeIds: attached })
  const top = whole.dishes.slice(0, topN).map(d => ({ recipe_id: d.recipe_id, name: d.name }))
  const weeks = Array.from({ length: weekCount }, () => new Set())
  for (const [orderId, w] of weekOfOrder) if (w >= 0 && w < weekCount) weeks[w].add(orderId)
  const rows = weeks.map((ids, w) => {
    const s = sliceByOrders(lines, snapshots, ids)
    const rep = buildCustomizationReport({ lines: s.lines, snapshots: s.snapshots, attachedRecipeIds: attached })
    const byDish = new Map(rep.dishes.map(d => [d.recipe_id, d]))
    const row = { week: w }
    for (const d of top) {
      const x = byDish.get(d.recipe_id)
      row[d.recipe_id] = x && x.plates >= TREND_MIN_PLATES ? Math.round(x.share * 1000) / 10 : null
    }
    return row
  })
  const drops = []
  if (rows.length >= 2) {
    const last = rows[rows.length - 1], prev = rows[rows.length - 2]
    for (const d of top) {
      const a = prev[d.recipe_id], b = last[d.recipe_id]
      if (a != null && b != null && a - b >= TREND_DROP_POINTS) drops.push({ ...d, from: a, to: b })
    }
  }
  return { dishes: top, rows, drops }
}
