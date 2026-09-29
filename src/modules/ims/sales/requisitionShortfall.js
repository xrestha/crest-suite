// The Requisitions over-issue check, as pure arithmetic (S792, SALES-7).
//
// The check compared each LINE with the item's estimated on-hand, so a slip carrying one item on
// two lines — 5 kg of flour for the kitchen line and 5 kg for pastry, with ~7 kg on the shelf —
// passed, because each 5 kg is under 7 on its own. What leaves the store is the SUM, so the sum is
// what gets compared: one total per item across the slip, then one comparison per item.

// Float sums like 0.1 + 0.2 land a hair above 0.3, which would flag a slip that takes exactly
// what is on the shelf. Six decimals is finer than any unit anyone issues in.
const tidy = n => Math.round(n * 1e6) / 1e6

/**
 * What a slip issues of each item: Map(item_id → { issuing, lines }), in the order the items first
 * appear. `lines` is how many lines carried the item, so the warning can say "across 2 lines".
 * A line with no item is skipped; a blank or non-numeric quantity counts as 0.
 */
export function issuingByItem(lines) {
  const totals = new Map()
  for (const l of lines || []) {
    if (!l?.item_id) continue
    const prev = totals.get(l.item_id) || { issuing: 0, lines: 0 }
    totals.set(l.item_id, { issuing: tidy(prev.issuing + (parseFloat(l.qty_issued) || 0)), lines: prev.lines + 1 })
  }
  return totals
}

/**
 * The items a slip would issue more of than the estimated on-hand: `[{ item_id, issuing, available,
 * lines }]`. An item missing from `onHand` has nothing on hand (0) — the same reading the per-line
 * check made. Issuing exactly what is on hand is not a shortfall.
 */
export function findShortfalls(lines, onHand) {
  const out = []
  for (const [item_id, { issuing, lines: count }] of issuingByItem(lines)) {
    const available = Number(onHand?.[item_id]) || 0
    if (issuing <= available) continue
    out.push({ item_id, issuing, available, lines: count })
  }
  return out
}
