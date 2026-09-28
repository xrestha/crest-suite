// The arithmetic behind a purchase bill line's Total box and its VAT tick (S792, owner decision D34).
//
// A line has a Qty, an ex-VAT Rate, a VAT tick, and an optional typed Total (`_amtDraft`) — the
// figure copied off the paper, from which the Rate is worked out. D34: **the typed Total is after
// VAT when VAT is ticked, and ticking or unticking VAT changes the Rate, never the Total.**
//
// It used to depend on the order of keystrokes. `setLineTotal` divided by 1.13 only if the line was
// ALREADY ticked, and ticking VAT afterwards cleared the Total and kept the Rate. So Qty 10, Total
// 1,130, then Tab to the tick (S779 made that the tab order) left Rate 113 ex-VAT and Amount
// 1,276.90; tick first, then type 1,130, gave Rate 100 and Amount 1,130 — the same keystrokes, 13%
// apart. The header's VAT toggle-all flipped every tick and kept every typed Total, so a column of
// 1,130s sat beside Amounts reading 1,276.90: two figures on one row disagreeing, the thing S698
// removed.
//
// A line whose Rate was typed and whose Total was not keeps its Rate when VAT is ticked: the Rate
// is the ex-VAT figure off the paper then, and ticking VAT adds 13% on top of it, as the Rate box's
// own tooltip says. D34 is about the Total box — it only binds where a Total was typed.
//
// Pure, so the rule is pinned by billLineVat.test.js rather than by whoever next edits the form.

export const VAT_FACTOR = 1.13

const typed = v => v !== '' && v != null

/**
 * The ex-VAT Rate that makes `qty` of this line come to `total` — after VAT when `vatInclusive`.
 * A string to 5 decimals (the Rate box's own precision), or null when either figure is missing,
 * zero or not a number, so the caller keeps whatever Rate it had.
 */
export function rateFromLineTotal(qty, total, vatInclusive) {
  const q = parseFloat(qty)
  const t = parseFloat(total)
  if (!(q > 0) || !(t > 0)) return null
  return String((t / q / (vatInclusive ? VAT_FACTOR : 1)).toFixed(5))
}

/** The line after its Total box is typed into: the draft is kept, the Rate re-derived from it. */
export function withLineTotal(line, amtStr) {
  const rate = rateFromLineTotal(line.qty, amtStr, line.vat_inclusive)
  return { ...line, _amtDraft: amtStr, rate: rate ?? line.rate }
}

/**
 * The line after its VAT tick is set to `vatInclusive`. A typed Total stays exactly as typed and
 * the Rate is re-derived from it on the new basis; with no typed Total the Rate is untouched.
 */
export function withLineVat(line, vatInclusive) {
  const next = { ...line, vat_inclusive: vatInclusive }
  if (!typed(line._amtDraft)) return next
  const rate = rateFromLineTotal(line.qty, line._amtDraft, vatInclusive)
  return rate == null ? next : { ...next, rate }
}

/**
 * The header's VAT toggle-all: every line ticked unless every line already is, in which case every
 * line is unticked — each through withLineVat, so a typed Total survives it the same way.
 */
export function withAllLinesVat(lines) {
  const list = lines || []
  const allVat = list.length > 0 && list.every(l => l.vat_inclusive)
  return list.map(l => withLineVat(l, !allVat))
}
