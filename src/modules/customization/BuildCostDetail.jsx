import Tip from '../../components/Tip'
import { npr2 } from '../../shared/nepalMoney'
import { fcBand } from '../../shared/imsFormulas'

// Crest Customization (S760): the per-size rows behind a build-your-own dish's cost range, opened
// from its row on Recipe Costing or Menu Pricing. Every FC % carries fcBand's mark, not only its
// colour, so a Large bowl drifting into the red is readable without the hue.

function Fc({ pct, settings }) {
  if (pct == null) return <span style={{ color: 'var(--theme-text3)' }}>—</span>
  const b = fcBand(pct, settings)
  return <span style={{ color: b.color, fontWeight: 600 }} title={b.label}>{pct.toFixed(1)}% {b.mark}</span>
}

/** "NPR 128.00 – 296.00" or a single figure when both ends agree. */
export function costRangeText(range) {
  if (!range || range.empty) return ''
  return range.lowCost === range.highCost ? npr2(range.lowCost) : `${npr2(range.lowCost)} – ${npr2(range.highCost).replace(/^NPR\s*/, '')}`
}

export function fcRangeNode(range, settings) {
  if (!range || range.empty || range.highFc == null) return <span style={{ color: 'var(--theme-text3)' }}>—</span>
  const b = fcBand(range.highFc, settings)
  const text = Math.abs(range.highFc - range.lowFc) < 0.05
    ? `${range.highFc.toFixed(1)}%`
    : `${range.lowFc.toFixed(1)}–${range.highFc.toFixed(1)}%`
  return <span style={{ color: b.color }} title={`The dearest build: ${b.label}`}>{text} {b.mark}</span>
}

export default function BuildCostDetail({ range, settings, vatNote = true }) {
  if (!range || range.empty) return null
  return (
    <div style={{ padding: '4px 0 8px' }}>
      <div className="table-wrap">
        <table className="data-table" style={{ fontSize: 12.5 }}>
          <thead>
            <tr>
              <th>Size</th>
              <th style={{ textAlign: 'right' }}>
                <Tip width={280} text="The lowest price a guest can order this size at: in every required group, the cheapest pick, and nothing optional.">Cheapest build · price</Tip>
              </th>
              <th style={{ textAlign: 'right' }}>Cost</th>
              <th style={{ textAlign: 'right' }}>FC %</th>
              <th style={{ textAlign: 'right' }}>
                <Tip width={300} text={`What guests usually build, priced at this size: ${range.typicalSource}. Toppings and bases set to scale with the size cost more on a bigger plate.`}>Typical build · price</Tip>
              </th>
              <th style={{ textAlign: 'right' }}>Cost</th>
              <th style={{ textAlign: 'right' }}>FC %</th>
            </tr>
          </thead>
          <tbody>
            {range.rows.map(r => (
              <tr key={r.size || 'one'}>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {r.size || 'One size'}
                  {r.size && r.portion !== 1 && <span style={{ color: 'var(--theme-text3)', marginLeft: 6 }}>{r.portion}×</span>}
                </td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{npr2(r.cheapest.price)}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{npr2(r.cheapest.cost)}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}><Fc pct={r.cheapest.fcPct} settings={settings} /></td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{npr2(r.typical.price)}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{npr2(r.typical.cost)}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}><Fc pct={r.typical.fcPct} settings={settings} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p style={{ margin: '6px 0 0', fontSize: 11.5, color: 'var(--theme-text3)' }}>
        Typical build: {range.typicalSource}. Costs use today’s item rates{vatNote ? '; prices are before VAT' : ''}.
      </p>
    </div>
  )
}
