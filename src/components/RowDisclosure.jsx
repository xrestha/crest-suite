/**
 * The control that expands a table row's detail — a real `<button>`, living inside a `<td>`.
 *
 * WHY THIS EXISTS (S595). Four tables put `role="button"` + `tabIndex` + an `onKeyDown` on the
 * `<tr>` itself. That role **overrides the row's implicit `row` role**, which takes the row out of
 * the table's structure: a screen reader stops associating that row's cells with their column
 * headers, so every figure in it loses the label that gave it meaning. On tables that are almost
 * entirely currency columns — Vendor Report, Outstanding Payables, Supplier Price Tracker,
 * Supplier Contribution — that is the whole content.
 *
 * The rule was already written down, in `.impeccable/design.json`'s don't-list, and *only* there:
 * it had never made it into DESIGN.md's prose. So nothing a human or an agent actually reads said
 * it, and the pattern got copied forward four times, most recently by an accessibility fix (S594)
 * that was reaching for the incumbent shape in good faith. This component is the answer to that:
 * one control, one place, so the fifth copy has nothing to copy from.
 *
 * The row keeps its `onClick` — clicking anywhere on the row still toggles, which is the behaviour
 * every one of these pages already had — and this button `stopPropagation()`s so the two handlers
 * cannot both fire and cancel each other out. Enter/Space need no handler at all: a real button
 * already does that, natively and on every platform.
 *
 * `controls` is optional on purpose. `aria-controls` needs exactly one element id, and Supplier
 * Price Tracker's detail is *many* sibling `<tr>`s rather than one — pointing it at the first would
 * be a claim about the other rows that isn't true. `aria-expanded` is the load-bearing attribute
 * and is always set.
 */
export default function RowDisclosure({ expanded, onToggle, controls, label, children }) {
  return (
    <button
      type="button"
      className="row-disclosure"
      aria-expanded={expanded}
      aria-controls={controls || undefined}
      aria-label={label}
      onClick={e => { e.stopPropagation(); onToggle() }}
    >
      {children || <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>}
    </button>
  )
}
