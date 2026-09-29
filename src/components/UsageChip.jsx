import Tip from './Tip'

/**
 * The at-a-glance mark that a row already HAS records somewhere — "🔗 Purchases, Recipes +2" — with a
 * tooltip naming them in full. Item Master has shown one per item since the force-delete guard was
 * built; this is that same chip, promoted out of `Items.js` when Vendors needed it beside the vendor
 * name.
 *
 * It reads as one mark rather than two because it is literally one definition — the version in
 * `Items.js` was a hand-rolled badge, and copying inline styles to a second page is how a "matching"
 * chip drifts. A row having history is a fact about the row, not a warning, so it is neutral: it wore
 * the accent-tinted categorical badge until S796, when the IMS critique took the accent off every
 * category (DESIGN.md → The One Signal Meaning Rule) — under Modernist Light that tint is red.
 *
 *   <UsageChip names={['Purchases', 'Vendor Returns']} text="Has records in: Purchases, Vendor Returns." />
 *
 * `names` are the plain words shown in the chip: the first two, then "+N" (S796). The chip used to
 * print CODES ("R, W, OS, CS, PAR, MV") explained only by a hover, which never opens on a phone and
 * asked an owner reading English as a second language to decode a legend. `codes` is still accepted
 * for a caller that has no names. `text` is the whole sentence a reader gets on hover, so each page
 * can say what its own references mean and what follows from them. Renders nothing when the list is
 * empty — the caller decides whether an empty cell shows a dash.
 */
const SHOWN = 2

export default function UsageChip({ names, codes, text, width = 260 }) {
  const list = names && names.length ? names : codes
  if (!list || list.length === 0) return null
  const more = list.length - SHOWN
  return (
    // The badge carries its own affordance, so Tip's dashed underline would only draw a second
    // line under a pill that already looks interactive.
    <Tip width={width} text={text} style={{ border: 'none', display: 'inline-flex' }}>
      <span className="badge badge-gray" style={{ whiteSpace: 'nowrap', cursor: 'help', textTransform: 'none' }}>
        🔗 {list.slice(0, SHOWN).join(', ')}{more > 0 ? ` +${more}` : ''}
      </span>
    </Tip>
  )
}
