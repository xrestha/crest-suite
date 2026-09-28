import { npr } from '../../../shared/nepalMoney'

// S792 (RECIPES-2, D31): on a PAN-bill outlet, the dishes whose stored price the till charges at
// less than the menu price the owner last saw. Before D31 every pricing screen took 13% (the dish's
// VAT rate) off the typed price, and the till — which adds no VAT on a PAN bill — then charged what
// was left: typed NPR 500, billed NPR 442. The owner decided the rows are NOT rewritten for them;
// this lists each one with both figures so it can be re-entered once. Recipe Costing and both
// branches of Menu Pricing render it; `fixHint` says where, on that screen, the price is re-entered.
//
// `mismatches` comes from panPriceMismatches() (menuPriceVat.js), so a dish re-entered under D31
// (vat_rate 0) drops off the list on the next load. Nothing here is a verdict colour: amber is the
// product's warning, and a count leads so the list does not have to be read to know the size.

const SHOW = 6

function line(m) {
  return (
    <li key={m.id}>
      <strong style={{ color: 'var(--theme-text1)' }}>{m.name}</strong>: the menu showed {npr(m.shownPrice)}, the till charges {npr(m.tillPrice)}
    </li>
  )
}

export default function PanPriceBanner({ mismatches, fixHint }) {
  if (!mismatches?.length) return null
  const n = mismatches.length
  const head = mismatches.slice(0, SHOW)
  const rest = mismatches.slice(SHOW)
  return (
    <div role="note" className="no-print" style={{
      marginBottom: 16, padding: '10px 14px', fontSize: 12, lineHeight: 1.55, color: 'var(--theme-text2)',
      border: '1px solid color-mix(in srgb, var(--theme-amber) 35%, transparent)',
      background: 'color-mix(in srgb, var(--theme-amber) 8%, transparent)', borderRadius: 'var(--radius-sm)',
    }}>
      <div style={{ fontWeight: 600, color: 'var(--theme-amber-text)', marginBottom: 4 }}>
        △ {n} {n === 1 ? 'dish is' : 'dishes are'} charged less than the price you set
      </div>
      <div>
        This outlet gives PAN bills (it is not VAT-registered), so the till adds no VAT and a guest pays
        exactly the price stored for a dish. {n === 1 ? 'This one was' : 'These were'} priced with VAT taken
        off the price you typed, so the till charges less than your menu says. Nothing has been changed for
        you. {fixHint}
      </div>
      <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{head.map(line)}</ul>
      {rest.length > 0 && (
        <details style={{ marginTop: 4 }}>
          <summary style={{ cursor: 'pointer' }}>{rest.length} more</summary>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{rest.map(line)}</ul>
        </details>
      )}
    </div>
  )
}
