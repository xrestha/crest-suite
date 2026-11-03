import Tip from '../../components/Tip'
import { npr2 } from '../../shared/nepalMoney'
import { fcBand } from '../../shared/imsFormulas'

// Crest Customization (S760): the per-size rows behind a build-your-own dish's cost range, opened
// from its row on Recipe Costing or Menu Pricing. Every FC % carries fcBand's mark, not only its
// colour, so a Large bowl drifting into the red is readable without the hue.
//
// S863: the band WORD shows under each FC % (it was only a `title`, which a touch screen cannot
// open); a two-row header names which build each Price / Cost / FC % belongs to; Size wraps, since
// this table sits inside the host page's own scrolling table; NPR is stated once, on the first header.

/** "Healthy", "Watch", "Too high": the band's name without its thresholds. */
const bandWord = b => String(b?.label || '').replace(/\s*\(.*\)$/, '')

function Fc({ pct, settings }) {
  if (pct == null) return <span style={{ color: 'var(--theme-text3)' }}>—</span>
  const b = fcBand(pct, settings)
  return (
    <>
      <span style={{ color: b.color, fontWeight: 600, whiteSpace: 'nowrap' }} title={b.label}>{pct.toFixed(1)}% {b.mark}</span>
      <span className="cell-sub">{bandWord(b)}</span>
    </>
  )
}

/**
 * "128.00 – 296.00", or a single figure when both ends agree. No currency prefix: `npr2` carries
 * none, so a caller that needs "NPR" states it once beside the range.
 */
export function costRangeText(range) {
  if (!range || range.empty) return ''
  return range.lowCost === range.highCost ? npr2(range.lowCost) : `${npr2(range.lowCost)} – ${npr2(range.highCost)}`
}

// The mark (✓ △ ▲) is the visible band cue here, as in every other FC % cell of the Recipe Costing
// and Menu Pricing columns this renders into; the band's name stays in the title there, and shows in
// words in the per-size detail below the row.
export function fcRangeNode(range, settings) {
  if (!range || range.empty || range.highFc == null) return <span style={{ color: 'var(--theme-text3)' }}>—</span>
  const b = fcBand(range.highFc, settings)
  const text = Math.abs(range.highFc - range.lowFc) < 0.05
    ? `${range.highFc.toFixed(1)}%`
    : `${range.lowFc.toFixed(1)}–${range.highFc.toFixed(1)}%`
  return <span style={{ color: b.color }} title={`The dearest build: ${b.label}`}>{text} {b.mark}</span>
}

const NUM = { textAlign: 'right', whiteSpace: 'nowrap' }

export default function BuildCostDetail({ range, settings, vatNote = true }) {
  if (!range || range.empty) return null
  return (
    <div style={{ padding: '4px 0 8px' }}>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th rowSpan={2} scope="col" style={{ verticalAlign: 'bottom' }}>
                <Tip text={`All figures in NPR${vatNote ? '; prices are before VAT' : ''}.`}>Size</Tip>
              </th>
              <th colSpan={3} scope="colgroup" style={{ textAlign: 'center' }}>
                <Tip width={280} text="The lowest price a guest can order this size at: in every required group, the cheapest choice, and nothing optional.">Cheapest build</Tip>
              </th>
              <th colSpan={3} scope="colgroup" style={{ textAlign: 'center' }}>
                <Tip width={300} text={`What guests usually build, priced at this size: ${range.typicalSource}. Toppings and bases set to scale with the size cost more on a bigger plate.`}>Typical build</Tip>
              </th>
            </tr>
            <tr>
              <th scope="col" style={{ textAlign: 'right' }}>Price</th>
              <th scope="col" style={{ textAlign: 'right' }}>Cost</th>
              <th scope="col" style={{ textAlign: 'right' }}>FC %</th>
              <th scope="col" style={{ textAlign: 'right' }}>Price</th>
              <th scope="col" style={{ textAlign: 'right' }}>Cost</th>
              <th scope="col" style={{ textAlign: 'right' }}>FC %</th>
            </tr>
          </thead>
          <tbody>
            {range.rows.map(r => (
              <tr key={r.size || 'one'}>
                <td>
                  {r.size || 'One size'}
                  {r.size && r.portion !== 1 && <span style={{ color: 'var(--theme-text3)', marginLeft: 6, whiteSpace: 'nowrap' }}>{r.portion}×</span>}
                </td>
                <td style={NUM}>{npr2(r.cheapest.price)}</td>
                <td style={NUM}>{npr2(r.cheapest.cost)}</td>
                <td style={{ textAlign: 'right' }}><Fc pct={r.cheapest.fcPct} settings={settings} /></td>
                <td style={NUM}>{npr2(r.typical.price)}</td>
                <td style={NUM}>{npr2(r.typical.cost)}</td>
                <td style={{ textAlign: 'right' }}><Fc pct={r.typical.fcPct} settings={settings} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="page-footnote">
        Typical build: {range.typicalSource}. Costs use the item rates of today{vatNote ? '; prices are before VAT' : ''}.
      </p>
    </div>
  )
}
