import { fcBand } from '../shared/imsFormulas'

// The food-cost marks named once, above a table whose FC % cells carry the mark beside the figure
// and the band's name only in a `title` (S864). A touch screen never opens a title, so a tablet
// reader saw ✓ △ ▲ with no key on every dish, a build-your-own range included. One line names all
// three at this outlet's own thresholds, built from fcBand itself, so the key cannot disagree with
// the cells under it and costs the table no width.
export default function FcBandKey({ settings, style }) {
  const { warn, critical } = fcBand(0, settings)
  const bands = [fcBand(warn, settings), fcBand(critical, settings), fcBand(critical + 1, settings)]
  return (
    <p className="page-footnote" style={{ margin: '0 0 8px', ...style }}>
      Food cost:{' '}
      {bands.map((b, i) => (
        <span key={b.key} style={{ whiteSpace: 'nowrap' }}>
          {i > 0 && ' · '}
          <span style={{ color: b.color, fontWeight: 600 }}>{b.mark}</span> {b.label}
        </span>
      ))}
    </p>
  )
}
