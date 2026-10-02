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
// S801 (owner): "after VAT" is how SOME bills print a line, not all of them. A tax invoice in the
// IRD layout — Big Mart's, reported live — prints each line's amount BEFORE VAT and adds VAT once
// at the foot, so copying the Amount column into a box read as after-VAT took 13% OUT of every VAT
// line instead of adding it on: rates 11.5% low and the bill short by its whole VAT. The bill now
// says which way its paper prints (`totals_basis`). After VAT is the default and is D34 unchanged.
// Before VAT: Rate = Total ÷ Qty whether or not the line is ticked, so ticking VAT keeps both and
// adds 13% on top. Switching the choice keeps every typed Total and re-works its Rate — D34's own
// rule, applied to the bill's choice as it is to the tick.
//
// Pure, so the rule is pinned by billLineVat.test.js rather than by whoever next edits the form.

export const VAT_FACTOR = 1.13

export const TOTALS_AFTER_VAT = 'after_vat'
export const TOTALS_BEFORE_VAT = 'before_vat'

const typed = v => v !== '' && v != null

/** The bill's choice from its header. Anything but an explicit before-VAT reads as after VAT (D34). */
export function totalsBasisOf(header) {
  return header?.totals_basis === TOTALS_BEFORE_VAT ? TOTALS_BEFORE_VAT : TOTALS_AFTER_VAT
}

/**
 * The header with its choice set. After VAT REMOVES the key rather than storing the default, so a
 * header that never left it is byte-identical to one written before the choice existed — the draft
 * store compares headers as strings, and an edit draft whose baseline no longer matches is treated
 * as a bill someone else saved since (purchaseBillDraft.js, draftBaseMoved).
 */
export function withHeaderTotalsBasis(header, basis) {
  const { totals_basis: _drop, ...rest } = header || {}
  return basis === TOTALS_BEFORE_VAT ? { ...rest, totals_basis: TOTALS_BEFORE_VAT } : rest
}

/**
 * The ex-VAT Rate that makes `qty` of this line come to `total`. The Total includes VAT only when
 * the line is ticked AND the bill prints its totals after VAT. A string to 5 decimals (the Rate
 * box's own precision), or null when either figure is missing, zero or not a number, so the caller
 * keeps whatever Rate it had.
 */
export function rateFromLineTotal(qty, total, vatInclusive, basis = TOTALS_AFTER_VAT) {
  const q = parseFloat(qty)
  const t = parseFloat(total)
  if (!(q > 0) || !(t > 0)) return null
  const includesVat = vatInclusive && basis !== TOTALS_BEFORE_VAT
  return String((t / q / (includesVat ? VAT_FACTOR : 1)).toFixed(5))
}

/** The line after its Total box is typed into: the draft is kept, the Rate re-derived from it. */
export function withLineTotal(line, amtStr, basis = TOTALS_AFTER_VAT) {
  const rate = rateFromLineTotal(line.qty, amtStr, line.vat_inclusive, basis)
  return { ...line, _amtDraft: amtStr, rate: rate ?? line.rate }
}

/**
 * The line after its VAT tick is set to `vatInclusive`. A typed Total stays exactly as typed and
 * the Rate is re-derived from it on the new basis; with no typed Total the Rate is untouched. On a
 * before-VAT bill the re-derived Rate is the same one, so the tick only adds or removes the 13%.
 */
export function withLineVat(line, vatInclusive, basis = TOTALS_AFTER_VAT) {
  const next = { ...line, vat_inclusive: vatInclusive }
  if (!typed(line._amtDraft)) return next
  const rate = rateFromLineTotal(line.qty, line._amtDraft, vatInclusive, basis)
  return rate == null ? next : { ...next, rate }
}

/**
 * The header's VAT toggle-all: every line ticked unless every line already is, in which case every
 * line is unticked — each through withLineVat, so a typed Total survives it the same way.
 */
export function withAllLinesVat(lines, basis = TOTALS_AFTER_VAT) {
  const list = lines || []
  const allVat = list.length > 0 && list.every(l => l.vat_inclusive)
  return list.map(l => withLineVat(l, !allVat, basis))
}

/**
 * Every line after the bill's choice is switched to `basis`: a typed Total stays exactly as typed
 * and its Rate is re-worked on the new basis. A line whose Rate was typed is untouched — the Rate
 * box is ex-VAT on either kind of bill.
 */
export function withTotalsBasis(lines, basis) {
  return (lines || []).map(l => {
    if (!typed(l._amtDraft)) return l
    const rate = rateFromLineTotal(l.qty, l._amtDraft, l.vat_inclusive, basis)
    return rate == null ? l : { ...l, rate }
  })
}
