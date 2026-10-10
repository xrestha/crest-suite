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
//   group kind       AS BILLED (S809 3o, REPORTS-12): the snapshot's `group_kind`, the kind most of
//                    the choice's plates were billed under. Today's catalog (`kindByOptionId`) only
//                    fills in a snapshot row that has none; with neither it is 'unknown'. Until S809
//                    the catalog decided, so a size deleted after a month of sales became 'unknown'
//                    and could win "Most added".
//   list price       AS BILLED, the same way: the snapshot's `list_price_delta` (the choice's own
//                    price on that bill, scaled to the size for a 'stock_and_price' group), averaged
//                    over the plates as `listPriceDelta`, with today's catalog price only for a row
//                    that carries none. `freePicks` (plates inside a group's "first N free", the
//                    snapshot's `included`) and `compedPicks` say why some plates paid less, and
//                    `freeByDesign` is a choice whose every plate was billed at a list price of 0.
//                    Judged against today's catalog, a mid-month price rise read as "incl. free
//                    picks" and a choice made free on the last day hid a month of losses in grey.
//   cost per plate   each plate's OWN frozen stock lines (S809 3o, REPORTS-4), valued at TODAY's item
//                    rate and averaged over the plates whose choice carried stock lines. A size
//                    scales a topping's lines on the bill (S760), so one bill's lines are one size's
//                    portion: the report used to cost every plate at whichever bill the read
//                    returned first, a loss or a healthy margin by chance. Picks are grouped by
//                    their stock lines (`deltaSets`), so each distinct set is costed once. A pick
//                    whose choice had no stock lines yet (`[]`) is left out of the average, not
//                    taken as the choice's answer. The rate is the only one available and moves
//                    with purchases, which the page says.

const num = v => Number(v) || 0
const has = (obj, k) => k != null && Object.prototype.hasOwnProperty.call(obj || {}, k)

// The kind most of a choice's plates were billed under; ties go to the kind seen first.
const billedKind = kindPlates => {
  let best = null
  for (const [k, n] of Object.entries(kindPlates)) if (best == null || n > kindPlates[best]) best = k
  return best
}

/**
 * @param {{ lines, snapshots, attachedRecipeIds, kindByOptionId?, listPriceByOptionId? }} input
 *   lines      [{ id, recipe_id, name, qty, comped, selection_key }] — paid bills in range
 *   snapshots  [{ order_item_id, option_id, group_name, group_kind, option_name, is_removal,
 *                price_delta, list_price_delta, included, ingredient_deltas }] — as billed
 *   attachedRecipeIds  Set of recipe ids with a group attached today
 *   kindByOptionId     { [option_id]: 'size' | 'addon' | 'choice' } today's catalog, for a row with no kind
 *   listPriceByOptionId { [option_id]: number } today's list price_delta, for a row with no list price
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
        is_removal: !!p.is_removal, picks: 0, charged: 0, dishes: new Set(),
        kindPlates: {}, listSum: 0, listPlates: 0, pricedPlates: 0, freePicks: 0, compedPicks: 0, deltaSets: new Map(),
      }
      o.picks += plates
      o.charged += charged
      o.dishes.add(l.name)
      // REPORTS-12: the kind and list price this plate was billed with; today's catalog only fills a gap.
      const kind = p.group_kind || (p.option_id != null ? kindByOptionId?.[p.option_id] : null)
      if (kind) o.kindPlates[kind] = (o.kindPlates[kind] || 0) + plates
      const list = p.list_price_delta != null ? num(p.list_price_delta)
        : has(listPriceByOptionId, p.option_id) ? num(listPriceByOptionId[p.option_id]) : null
      if (list != null) {
        o.listSum += list * plates
        o.listPlates += plates
        if (list !== 0) o.pricedPlates += plates
      }
      if (p.included) o.freePicks += plates
      if (l.comped) o.compedPicks += plates
      // REPORTS-4: every plate's own stock lines, grouped by identical sets.
      if (Array.isArray(p.ingredient_deltas) && p.ingredient_deltas.length > 0) {
        const sig = JSON.stringify(p.ingredient_deltas)
        const set = o.deltaSets.get(sig) || { deltas: p.ingredient_deltas, plates: 0 }
        set.plates += plates
        o.deltaSets.set(sig, set)
      }
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
    .map(({ kindPlates, listSum, listPlates, pricedPlates, deltaSets, ...o }) => ({
      ...o,
      dishes: [...o.dishes].sort(),
      chargedPerPick: o.picks ? o.charged / o.picks : 0,
      group_kind: billedKind(kindPlates) || 'unknown',
      // The average list price per plate as billed; null when no plate's list price is known.
      listPriceDelta: listPlates ? listSum / listPlates : null,
      freeByDesign: listPlates > 0 && listPlates === o.picks && pricedPlates === 0,
      deltaSets: [...deltaSets.values()],
    }))
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
 * Cost per plate of each choice: every plate's own frozen stock lines through the delta explosion,
 * valued at the given per-base-unit rates, averaged over the plates that carried stock lines
 * (S809 3o, REPORTS-4: a Large bowl's granola is costed as a Large bowl's, a Regular's as a
 * Regular's). `costedPicks` is how many plates that average covers. Null when no plate of the
 * choice carried stock lines (it changes nothing in stock), which the page shows as "no stock
 * lines" rather than a cost of 0.
 * @param {object[]} optionRows  from buildCustomizationReport
 * @param {(deltas) => Array<{item_id, qty}>} toItems  deltaItems bound to an explosion
 * @param {Record<string, number>} rateByItem
 */
export function withOptionCosts(optionRows, toItems, rateByItem) {
  return (optionRows || []).map(o => {
    let total = 0
    let costedPicks = 0
    for (const { deltas, plates } of o.deltaSets || []) {
      const perPlate = toItems(deltas).reduce((s, { item_id, qty }) => s + qty * num(rateByItem?.[item_id]), 0)
      total += perPlate * plates
      costedPicks += plates
    }
    return { ...o, costPerPick: costedPicks > 0 ? total / costedPicks : null, costedPicks }
  })
}

/** Every distinct set of stock lines in a report, for one delta explosion (REPORTS-4). */
export function allDeltaSets(optionRows) {
  return (optionRows || []).flatMap(o => (o.deltaSets || []).map(s => s.deltas))
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
