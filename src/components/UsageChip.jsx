import Tip from './Tip'

/**
 * The at-a-glance mark that a row already HAS records somewhere — "🔗 P, VR" — with a tooltip
 * naming them in full. Item Master has shown one per item since the force-delete guard was built;
 * this is that same chip, promoted out of `Items.js` when Vendors needed it beside the vendor name.
 *
 * It reads as one mark rather than two because it is literally one definition. The version in
 * `Items.js` was a hand-rolled `.badge-yellow`: byte-identical fill (`rgba(201,168,76,0.12)`) and
 * foreground (`--theme-accent-ink`), plus a 1px border and one pixel less padding. Copying those
 * inline styles to a second page is how a "matching" chip drifts — so the class is what both pages
 * now wear, which also gets them the accent-tinted CATEGORICAL treatment on purpose: a row having
 * history is a fact about the row, not a warning about it, and amber is this product's warning.
 *
 *   <UsageChip codes={['P', 'VR']} text="Has records in: Purchases, Vendor Returns." />
 *
 * `codes` are the short forms shown in the chip; `text` is the whole sentence a reader gets on
 * hover, so each page can say what its own references mean and what follows from them. Renders
 * nothing when there are no codes — the caller decides whether an empty cell shows a dash.
 */
export default function UsageChip({ codes, text, width = 260 }) {
  if (!codes || codes.length === 0) return null
  return (
    // The badge carries its own affordance, so Tip's dashed underline would only draw a second
    // line under a pill that already looks interactive.
    <Tip width={width} text={text} style={{ border: 'none', display: 'inline-flex' }}>
      <span className="badge badge-yellow" style={{ whiteSpace: 'nowrap', cursor: 'help' }}>
        🔗 {codes.join(', ')}
      </span>
    </Tip>
  )
}
