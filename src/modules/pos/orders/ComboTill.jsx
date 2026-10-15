import Tip from '../../../components/Tip'
import { fmtNpr, btnSm } from './posOrdersConstants'

// Combos on the order screen (S839, docs/pos-combos.md): the menu's Combos tiles and a combo's block
// in the cart. The order screen owns every state and handler; these only lay them out, so the cart's
// own pieces (a dish's sent marks, its kitchen note) come in as render functions and look the same
// on a combo's dish as on any line.

/**
 * The Combos tab of the till menu: one tile per combo, its name and price (what the guest pays), and
 * how many of it are on this order. S846: the accent is only for what is pressed or current, so the
 * price is ink and a combo on the order is told by an ink count badge and a text2 border, as on the
 * dish tiles (MenuGrid). A combo tile carries no food mark: its dishes have their own.
 */
export function ComboTiles({ combos, countOf, onPick }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: 10 }}>
      {combos.map(c => {
        const n = countOf(c.id)
        const setMeal = c.groups.every(g => g.items.length === 1)
        return (
          <button key={c.id} type="button" className="till-tile" onClick={() => onPick(c)}
            aria-label={`${c.name}, ${fmtNpr(c.guest_price)}${n ? `, ${n} on this order` : ''}`}
            style={{
              background: 'var(--theme-card)',
              border: `1px solid ${n ? 'var(--theme-text2)' : 'var(--theme-border)'}`,
              borderRadius: 'var(--radius-md)', padding: '12px 10px', cursor: 'pointer', textAlign: 'left',
              display: 'flex', flexDirection: 'column', gap: 6, position: 'relative', transition: 'border-color 0.12s',
            }}>
            {n > 0 && (
              <span aria-hidden="true" style={{
                position: 'absolute', top: 6, right: 8, background: 'var(--theme-text1)', color: 'var(--theme-card)',
                borderRadius: 'var(--radius-full)', fontSize: 11, fontWeight: 700, padding: '1px 7px',
                fontVariantNumeric: 'tabular-nums',
              }}>{n}</span>
            )}
            <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--theme-text1)', lineHeight: 1.3, paddingRight: n ? 28 : 0 }}>{c.name}</span>
            <span style={{ fontSize: 12, color: 'var(--theme-text1)', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{fmtNpr(c.guest_price)}</span>
            <span style={{ fontSize: 10, color: 'var(--theme-text3)' }}>
              {setMeal ? 'Set meal' : `Pick ${c.groups.filter(g => g.items.length > 1).length === 1 ? 'a dish' : 'dishes'}`}
            </span>
          </button>
        )
      })}
    </div>
  )
}

/**
 * One combo on the cart: its name, one quantity for every dish, its total and Remove, then each dish
 * indented with its own sent marks, choices and note. A dish has no quantity or remove of its own (the
 * server refuses a combo missing a dish); Swap changes it within its pick.
 *
 * `block` is groupComboBlocks' entry. `lineTotalOf(item)` is a dish's amount as the cart shows a line.
 * `swapLabelOf(item)` is 'Swap' or 'Change' when the dish can be changed, else null. `troubleOf(item)`
 * is the choice-trouble sentence for an unsaved dish, or null.
 */
export function ComboCartBlock({ block, lineTotalOf, renderMarks, renderNote, swapLabelOf, troubleOf, onQty, onRemove, onSwap }) {
  const total = block.dishes.reduce((s, d) => s + lineTotalOf(d.item), 0)
  const name = block.name
  return (
    <div role="group" aria-label={`${name}, combo`} style={{ borderBottom: '1px solid var(--theme-border)', padding: '9px 0', display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text1)', lineHeight: 1.3 }}>{name}</span>
          <Tip style={{ display: 'inline-flex', borderBottom: 'none', cursor: 'default' }}
            text="A combo: its dishes go to their own stations but share one quantity. Remove takes the whole combo off; Swap changes one dish within its pick. A bill discount does not apply to a combo.">
            <span className="badge badge-gray" style={{ fontSize: 10, cursor: 'default' }}>Combo</span>
          </Tip>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
          <button type="button" onClick={() => onQty(block.id, block.qty - 1)} className="till-hit" style={btnSm} aria-label={`One fewer ${name}`}>−</button>
          <span style={{ minWidth: 22, textAlign: 'center', fontWeight: 700, color: 'var(--theme-text1)', fontSize: 13 }}>{block.qty}</span>
          <button type="button" onClick={() => onQty(block.id, block.qty + 1)} className="till-hit" style={btnSm} aria-label={`One more ${name}`}>+</button>
        </div>
        <span style={{ fontSize: 13, color: 'var(--theme-text1)', fontWeight: 600, minWidth: 68, textAlign: 'right', flexShrink: 0 }}>{fmtNpr(total)}</span>
        <button type="button" onClick={() => onRemove(block.id)} title="Remove the combo" aria-label={`Remove ${name}`} className="till-hit"
          style={{ background: 'none', border: 'none', color: 'var(--theme-text3)', cursor: 'pointer', fontSize: 18, padding: '0 2px', lineHeight: 1, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>×</button>
      </div>
      <ul style={{ listStyle: 'none', margin: 0, padding: '0 0 0 12px', borderLeft: '2px solid var(--theme-border)', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {block.dishes.map(({ item, idx }) => {
          const swap = swapLabelOf(item)
          const trouble = troubleOf(item)
          return (
            <li key={idx} data-cart-line style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13, color: 'var(--theme-text1)', lineHeight: 1.3 }}>{item.name}</span>
                  {renderMarks(item)}
                </div>
                {swap && (
                  <Tip text={swap === 'Swap'
                    ? 'Change this dish for another of its pick. If it was already sent, it is taken off with a reason and the new dish goes on the next ticket.'
                    : 'Change this dish’s choices. If it was already sent, it is taken off with a reason and made again with the new choices.'}>
                    <button type="button" className="btn btn-ghost btn-sm till-hit--row"
                      aria-label={`${swap} ${item.name} in ${name}`}
                      onClick={() => onSwap(block.id, item)}>{swap}</button>
                  </Tip>
                )}
              </div>
              {item.option_summary && (
                <span style={{ fontSize: 11, color: 'var(--theme-text2)', lineHeight: 1.35 }}>{item.option_summary}</span>
              )}
              {trouble && <span style={{ fontSize: 11, color: 'var(--theme-red-text)', lineHeight: 1.35 }}>{trouble}</span>}
              {renderNote(item, idx)}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
