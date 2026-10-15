import { memo } from 'react'
import { vatOf, fmtNpr, kotTimerLabel, isComboLine } from './posOrdersConstants'
import DietMark, { dietOfDish } from '../guestmenu/DietMark'

// The order screen's dish tiles (S842), moved out of PosOrders so they render only when something a
// tile shows has changed. Inside the one 8,500-line component every keystroke anywhere on the screen
// (the menu search, a kitchen note, "Cash received" in the payment window) rebuilt every tile, each
// running a find and a reduce over the cart: ~1,000 elements reconciled per character on a 200-dish
// menu, on the cheapest tablet in the restaurant.
//
// The till owns every state and handler; this only lays the tiles out. `addRef` is the till's
// latest-ref to addItem (the closeOrderRef pattern), so a tile never calls a stale closure and the
// memo never sees a new function.
//
// S846: a dish's food mark (DietMark, the guest menu's own) leads its name when the recipe states
// it; the till's menu rows carry `is_veg` and `is_egg`. And the accent is only for what is pressed or
// current (owner decision, as in IMS and HR): the price is ink, and a dish already on the order is
// told by its ink quantity badge and a text2 border, not an accent tint.

/** The dishes the grid shows: the category tab, then a name or Product Code match. One definition,
 * used by the till for its empty-state check and by the grid itself, so the two cannot disagree. */
export function filterMenu(menu, menuTab, menuQuery) {
  return (menuTab === 'All' ? menu : menu.filter(r => r.category === menuTab))
    // Match on name OR Product Code so staff can ring an item by its code (e.g. "MOM-03").
    .filter(r => r.name.toLowerCase().includes(menuQuery) || (r.recipe_code || '').toLowerCase().includes(menuQuery))
}

// What a tile reads from the cart: each dish's count and whether its first line has gone to the
// kitchen. A note, a discount or a price typed elsewhere changes none of it.
function tileSignature(orderItems) {
  return orderItems.map(i => (isComboLine(i) ? '' : `${i.recipe_id}:${i.qty}:${i.sent_to_kot ? 1 : 0}`)).join('|')
}

function MenuGrid({ menu, menuTab, menuQuery, orderItems, vatReg, dishGroupsByRecipe, orderKotTickets, kotNow, addRef }) {
  // A combo's dish counts on its combo's tile, not here (S839). Every line of a dish, customized ones
  // included (S758), is one tile and one count; the first line's sent mark drives its timer.
  const inCart = new Map()
  for (const i of orderItems) {
    if (isComboLine(i)) continue
    const had = inCart.get(i.recipe_id)
    if (had) had.qty += i.qty
    else inCart.set(i.recipe_id, { qty: i.qty, sent: !!i.sent_to_kot })
  }
  // Most-recently-sent ticket holding this dish: if it went in two sends, the newer one is the one a
  // waiter checking on it cares about. A cart line follows its own line instead (ticketForLine).
  const ticketFor = recipeId => orderKotTickets.find(t => (t.items || []).some(i => i.recipe_id === recipeId)) || null

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))',
      gap: 10,
    }}>
      {filterMenu(menu, menuTab, menuQuery).map(r => {
        const vat   = vatReg ? vatOf(r) : 0
        const price = Math.round((parseFloat(r.selling_price) || 0) * (1 + vat))
        const inOrd = inCart.get(r.id)
        const hasOptions = !!dishGroupsByRecipe[r.id]
        const kotTimer = inOrd?.sent ? kotTimerLabel(ticketFor(r.id), kotNow) : null
        const diet = dietOfDish(r.is_veg, r.is_egg)
        return (
          <button key={r.id} className="till-tile" onClick={() => addRef.current(r)} style={{
            background: 'var(--theme-card)',
            border: `1px solid ${inOrd ? 'var(--theme-text2)' : 'var(--theme-border)'}`,
            borderRadius: 'var(--radius-md)', padding: '12px 10px',
            cursor: 'pointer', textAlign: 'left',
            display: 'flex', flexDirection: 'column', gap: 6,
            position: 'relative', transition: 'border-color 0.12s',
          }}>
            {inOrd && (
              <span style={{
                position: 'absolute', top: 6, right: 8,
                background: 'var(--theme-text1)', color: 'var(--theme-card)',
                borderRadius: 'var(--radius-full)', fontSize: 11, fontWeight: 700, padding: '1px 7px',
                fontVariantNumeric: 'tabular-nums',
              }}>{inOrd.qty}</span>
            )}
            <span style={{
              fontWeight: 600, fontSize: 13, color: 'var(--theme-text1)',
              lineHeight: 1.3, paddingRight: inOrd ? 28 : 0,
            }}>{diet && <DietMark diet={diet} className="diet-mark--lead" />}{r.name}</span>
            <span style={{ fontSize: 12, color: 'var(--theme-text1)', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
              {fmtNpr(price)}
            </span>
            {hasOptions && (
              <span style={{ fontSize: 10, color: 'var(--theme-text3)' }}>Choices</span>
            )}
            {kotTimer && (
              <span style={{ fontSize: 10, fontWeight: 600, color: kotTimer.color }}>
                {kotTimer.text}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

// Re-render only when something a tile draws has moved. `menu`, `dishGroupsByRecipe` and
// `orderKotTickets` keep their identity until their own data changes (state, a memo, and polls that
// set only on a change); the cart is compared by what the tiles read of it.
function sameTiles(a, b) {
  return a.menu === b.menu && a.menuTab === b.menuTab && a.menuQuery === b.menuQuery
    && a.vatReg === b.vatReg && a.dishGroupsByRecipe === b.dishGroupsByRecipe
    && a.orderKotTickets === b.orderKotTickets && a.kotNow === b.kotNow && a.addRef === b.addRef
    && (a.orderItems === b.orderItems || tileSignature(a.orderItems) === tileSignature(b.orderItems))
}

export { sameTiles }
export default memo(MenuGrid, sameTiles)
