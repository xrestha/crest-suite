/**
 * The sentence the period-close ConfirmModal shows about this month's closing count.
 *
 * WHY (S613): closing a period is the product's highest-stakes action — it locks the month AND
 * mints the frozen Monthly Report, and COGS subtracts closing stock, so a period closed without
 * a count freezes "closing = 0 for every item" into an artifact nothing ever recomputes. Payroll
 * Finalize earned a data-derived gate in S570; the close only ever had advisory prose. This is
 * that gate — it INFORMS and never BLOCKS (an admin correcting history legitimately closes
 * uncounted months), and a preflight that could not run says so rather than asserting anything.
 *
 * Extracted from Periods.js in S616 so the four branches are covered by tests: they are the only
 * warning a client owner gets before an irreversible write, and three of the four are reachable
 * only against data that is inconvenient to stage by hand.
 *
 * @param {{counted: number, items: number}|null} pre - null when the preflight itself failed.
 * @returns {{danger: boolean, text: string}}
 */
export function closingCountNote(pre) {
  if (!pre) return { danger: false, text: "Couldn't check this month's closing count — make sure Closing Stock is entered before closing." }
  // Nothing to count is not the same fact as nothing counted. A client whose item master is
  // empty (a fresh signup closing its first month) would otherwise get the red alarm, stating
  // "0 of 0 active items" — which reads as a defect in the product at the exact moment the
  // operator is deciding whether to trust it.
  if (pre.items === 0) return { danger: false, text: 'There are no active items to count, so nothing is missing from this month’s closing stock.' }
  if (pre.counted === 0) return { danger: true, text: `No closing stock has been counted for this month (0 of ${pre.items} active items). Closed like this, every item's closing stock counts as ZERO in COGS and in the frozen Monthly Report.` }
  if (pre.counted < pre.items) return { danger: false, text: `${pre.counted} of ${pre.items} active items have a closing count — items without one are treated as zero stock in COGS and the frozen Monthly Report.` }
  return { danger: false, text: `All ${pre.items} active items have a closing count.` }
}
