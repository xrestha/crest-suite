import { useMemo, useRef, useState } from 'react'
import Modal from '../../components/Modal'
import { npr, nprInt } from '../../shared/nepalMoney'
import {
  ruleText, describeSelection, selectionProblems, defaultSelection, inclFromEx, signedPrice, scaledDelta,
} from '../../shared/optionPricing'
import { moveRovingFocus, rovingTabIndex } from '../../shared/rovingFocus'
import { offeredPicks, goneChoicesText } from '../../shared/offeredPicks'
import { DIET_LABEL } from './customizationData'
import DietMark from '../pos/guestmenu/DietMark'

// Crest Customization (S758 stage 5, reshaped S759): the choice window a waiter sees for a dish
// that has option groups. It no longer opens on every tap of such a dish (owner decision, S759):
// when the dish's defaults already satisfy every group's rule the tap adds the default line at
// once, and the window opens only when a required group has no default — or from the cart's
// Choices / Change button, where the line's current picks are the starting selection.
//
// The price shown is the till's twin of the server's (describeSelection); the bill is priced by
// save_pos_order_items from the option ids alone, so nothing here can set what a guest pays.
//
// A group with max 1 behaves as a radio (a new pick replaces the old one); any other group as
// checkboxes that stop at the maximum. Add stays pressable while a rule is unmet — the press
// names the group that is short, scrolls to it and focuses its first chip, rather than a dead
// button that explains nothing.
//
// `lastIds` is the selection this recipe was last added with on this till; when it differs from
// the starting selection a one-tap "Same as last" restores it. `initialQty` seeds the quantity
// stepper (a Change call passes the line's qty). `onConfirm(selected, qty)`.
//
// `showQty={false}` (S840) hides the stepper and prices one unit, for a caller whose quantity is
// decided elsewhere: the combo window opens a combo dish's own choices here, and that dish's
// quantity is the combo's, so a stepper would be buttons that do nothing.
//
// S809 3o (CUSTOMIZATION-2): the window starts from, and "Same as last" restores, only the picks
// the dish still offers (`offeredPicks`). A pick hidden as sold out, deleted, or in a group hidden
// or taken off the dish used to ride along unseen — the window lists offered options only, so it
// could neither show nor remove it — and every save of the order was refused for it. What was
// dropped is named at the top; `lineOptions` (the line's own choices) names one the catalog no
// longer has. With no group left to offer (`dishGroups` empty), Update dish makes the line plain.
//
// S863 (till audit, owner decision on prices): a SIZE chip on a dish of its own shows the dish's
// whole price at that size ("Half · NPR 160"), as the guest menu does, never a change from a base
// price this window never shows. No total is quoted while a required group has nothing picked: the
// footer says "Choose a size" (or "Choose from <group>") instead. `inCombo` is the combo window's
// call for a combo dish's own choices: the dish is priced by the combo, so sizes keep their extra
// charge and the footer says what the choices add ("No extra charge", "Choices add NPR 50"), never
// "NPR 0". A stray backdrop tap no longer drops the picks or the quantity (`dirty`).

// Both till windows' panel (ComboPickerModal imports it): as tall as the overlay leaves, which pads
// 40px top and bottom and by the guest-order bar, so the pinned Add row never falls below the fold.
// The dynamic viewport where the browser has it (a tablet's URL bar), the plain one on an older tablet,
// whose browser would drop a `dvh` value whole and leave the panel uncapped.
const VIEWPORT_H = typeof CSS !== 'undefined' && CSS.supports?.('height', '100dvh') ? '100dvh' : '100vh'
export const PICKER_PANEL_STYLE = Object.freeze({
  maxHeight: `calc(${VIEWPORT_H} - 80px - var(--arrival-alert-h, 0px))`,
  display: 'flex',
  flexDirection: 'column',
})

/**
 * The first group a total cannot be quoted without: a required group with nothing picked, a size
 * before any other. `{ group, text }`, or null when every required group has an answer.
 */
export function unansweredGroup(dishGroups, selected) {
  const open = (dishGroups || []).filter(d => (Number(d.rule?.min) || 0) > 0 && !d.options.some(o => selected.includes(o.id)))
  const d = open.find(x => x.group.kind === 'size') || open[0]
  if (!d) return null
  return { group: d.group, text: d.group.kind === 'size' ? 'Choose a size' : `Choose from ${d.group.name}` }
}

function sameIds(a, b) {
  if (!a || !b || a.length !== b.length) return false
  const sa = [...a].map(String).sort().join('+')
  const sb = [...b].map(String).sort().join('+')
  return sa === sb
}

export default function OptionPickerModal({
  recipe, dishGroups, catalog, vatRate = 0, initialIds, initialQty, lastIds = null, lineOptions = null,
  confirmLabel = 'Add to order', showQty = true, inCombo = false, onConfirm, onClose, zIndex = 1100,
}) {
  const [start] = useState(() => offeredPicks(initialIds ?? defaultSelection(dishGroups), dishGroups))
  const [selected, setSelected] = useState(start.kept)
  const [startQty] = useState(() => Math.max(1, Number(initialQty) || 1))
  const [qty, setQty] = useState(startQty)
  const [tried, setTried] = useState(false)
  // S867: the group whose full chip was just pressed. A full chip stays pressable (aria-disabled),
  // so the press can say why nothing happened; `disabled` took it out of the Tab order unannounced.
  const [fullPressed, setFullPressed] = useState(null)
  const fieldsetRefs = useRef({})

  const attachByGroup = useMemo(
    () => Object.fromEntries(dishGroups.map(d => [d.group.id, d.attachment])), [dishGroups])
  const fullCatalog = useMemo(() => ({ ...catalog, attachByGroup }), [catalog, attachByGroup])
  const desc = useMemo(() => describeSelection(selected, fullCatalog), [selected, fullCatalog])
  const lastOffered = useMemo(() => (lastIds ? offeredPicks(lastIds, dishGroups).kept : null), [lastIds, dishGroups])
  const lastDesc = useMemo(
    () => (lastOffered && lastOffered.length ? describeSelection(lastOffered, fullCatalog) : null), [lastOffered, fullCatalog])
  const problems = selectionProblems(dishGroups, selected)
  const base = Number(recipe.selling_price) || 0
  const unit = base + desc.delta
  const incl = n => Math.round(inclFromEx(n, vatRate))
  // The picks that fall under a group's first-N-free allowance, as the server would price them.
  const freeIds = useMemo(() => new Set(desc.options.filter(o => o.included).map(o => String(o.option_id))), [desc])
  const showSameAsLast = lastDesc && !sameIds(lastOffered, selected)
  const shownQty = showQty ? qty : 1
  // Chip taps fire neither input nor change, so Modal's own guard never turns on: say it outright.
  const dirty = !sameIds(selected, start.kept) || (showQty && qty !== startQty)
  const waiting = unansweredGroup(dishGroups, selected)
  // A size on a dish of its own is priced as the whole dish at that size, as the guest sheet prices it.
  const sizePrice = o => incl(base + (Number(o.price_delta) || 0))

  // The footer's price line: nothing quoted before a required pick; in a combo, what the choices add.
  let priceText
  let eachText = null
  if (waiting) {
    priceText = waiting.text
  } else if (inCombo) {
    const charge = incl(desc.delta)
    priceText = charge === 0 ? 'No extra charge' : charge > 0 ? `Choices add ${npr(charge)}` : `Choices take ${npr(-charge)} off`
  } else {
    priceText = `NPR ${nprInt(incl(unit) * shownQty)}`
    if (shownQty > 1) eachText = `NPR ${nprInt(incl(unit))} × ${shownQty}`
  }

  function toggle(group, rule, optionId) {
    setSelected(prev => {
      const groupOptions = dishGroups.find(d => d.group.id === group.id).options
      const inGroup = new Set(groupOptions.map(o => o.id))
      const has = prev.includes(optionId)
      if (rule.max === 1) {
        const others = prev.filter(id => !inGroup.has(id))
        // A required single pick cannot be un-picked by tapping it again — only replaced.
        if (has) return rule.min >= 1 ? prev : others
        return [...others, optionId]
      }
      if (has) return prev.filter(id => id !== optionId)
      // S809 4h (Q20 a): a "No …" removal takes no place under the maximum.
      const real = groupOptions.filter(o => !o.is_removal && prev.includes(o.id)).length
      const isRemoval = groupOptions.some(o => o.id === optionId && o.is_removal)
      if (!isRemoval && rule.max != null && real >= rule.max) return prev
      return [...prev, optionId]
    })
  }

  function confirm() {
    if (problems.length) {
      setTried(true)
      // Take the reader to the group that is short — on a phone it may be two screens up.
      const el = fieldsetRefs.current[problems[0].group.id]
      if (el) {
        el.scrollIntoView?.({ block: 'center' })
        const chip = el.querySelector('[role="radio"], [role="checkbox"]')
        ;(chip || el).focus?.()
      }
      return
    }
    onConfirm(selected, qty)
  }

  return (
    <Modal onClose={onClose} title={recipe.name} maxWidth={520} zIndex={zIndex} dirty={dirty}
      panelStyle={PICKER_PANEL_STYLE}>
      <div className="picker-body">
        {start.gone.length > 0 && (
          <div role="status" className="note-banner" style={{ margin: 0 }}>
            <strong>Taken off, no longer offered:</strong> {goneChoicesText(start.gone, catalog?.optionsById, lineOptions)}.{' '}
            {dishGroups.length > 0
              ? 'Pick again if the guest wants something else.'
              : `${recipe.name} has no choices on the menu right now, so it goes as the plain dish.`}
          </div>
        )}
        {/* The whole summary on the button, wrapping: a tablet has no hover, so a cut summary with
            the rest in `title` was a restore nobody could read before tapping it (S863). */}
        {showSameAsLast && (
          <button type="button" className="btn btn-ghost btn-sm btn--block till-hit--row"
            onClick={() => setSelected([...lastOffered])}>
            {`Same as last: ${lastDesc.summary}`}
          </button>
        )}

        {dishGroups.map(({ group, rule, options }) => {
          const count = options.filter(o => selected.includes(o.id)).length
          const realCount = options.filter(o => !o.is_removal && selected.includes(o.id)).length
          const short = tried && problems.some(p => p.group.id === group.id)
          const labelId = `opt-group-${group.id}`
          const isRadio = rule.max === 1
          const usedFree = rule.included > 0
            ? desc.options.filter(o => o.group_id === group.id && o.included).length
            : 0
          const baseRule = ruleText({ ...rule, included: 0 })
          const anyChecked = count > 0
          const isSize = !inCombo && group.kind === 'size'
          return (
            <fieldset key={group.id}
              ref={el => { fieldsetRefs.current[group.id] = el }}
              tabIndex={-1}
              style={{ border: 'none', margin: 0, padding: 0, outline: 'none' }}
              role={isRadio ? 'radiogroup' : 'group'} aria-labelledby={labelId}
              onKeyDown={e => moveRovingFocus(e, isRadio ? '[role="radio"]' : '[role="checkbox"]')}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                <span id={labelId} style={{ fontWeight: 700, fontSize: 14, color: 'var(--theme-text1)' }}>{group.name}</span>
                <span style={{ fontSize: 12, color: short ? 'var(--theme-red-text)' : 'var(--theme-text3)' }}>
                  {baseRule}{!isRadio && count > 0 ? ` · ${count} picked` : ''}
                </span>
                {rule.included > 0 && (
                  <span style={{ fontSize: 12, color: usedFree >= 1 ? 'var(--theme-text2)' : 'var(--theme-text3)' }}>
                    {usedFree} of {rule.included} free choices used
                  </span>
                )}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 8 }}>
                {options.map((o, i) => {
                  const on = selected.includes(o.id)
                  const full = !on && !o.is_removal && rule.max != null && !isRadio && realCount >= rule.max
                  // S760: at the size picked so far — a topping on a Large bowl reads its Large price.
                  const listPrice = incl(scaledDelta(o, group, desc.portion_factor))
                  const isFree = on && freeIds.has(String(o.id)) && listPrice !== 0
                  const priceNode = isSize
                    ? npr(sizePrice(o))
                    : o.is_removal
                      ? null
                      : isFree
                        ? <><span style={{ color: 'var(--theme-text2)' }}>Included</span> <s style={{ color: 'var(--theme-text3)' }}>{signedPrice(listPrice)}</s></>
                        : (signedPrice(listPrice) || null)
                  const metaParts = [
                    priceNode,
                    full ? `Max ${rule.max}` : null,
                    // S846: the shape-coded mark before the word, the guest menu's own (DietMark).
                    // Decorative: the word beside it is the name.
                    o.diet && DIET_LABEL[o.diet] ? <><DietMark diet={o.diet} decorative className="diet-mark--lead" />{DIET_LABEL[o.diet]}</> : null,
                  ].filter(Boolean)
                  // The mark for a removal: a quiet "No" prefix, only when the name does not already
                  // say it. The red ✕ this replaced shared the danger hue with Void and was read
                  // aloud literally.
                  const showNo = o.is_removal && !/^no\s/i.test(String(o.name || ''))
                  return (
                    <button
                      key={o.id}
                      type="button"
                      className="choice-chip"
                      role={isRadio ? 'radio' : 'checkbox'}
                      aria-checked={on}
                      aria-disabled={full || undefined}
                      tabIndex={isRadio ? rovingTabIndex(on || (!anyChecked && i === 0)) : 0}
                      onClick={() => {
                        if (full) { setFullPressed(group.id); return }
                        if (fullPressed === group.id) setFullPressed(null)
                        toggle(group, rule, o.id)
                      }}
                    >
                      <span className="choice-chip__name">
                        {showNo && <span className="badge badge-gray" style={{ marginRight: 5, verticalAlign: 'middle' }}>No</span>}
                        {o.name}
                      </span>
                      {metaParts.length > 0 && (
                        <span className="choice-chip__meta">
                          {metaParts.map((p, n) => <span key={n}>{n > 0 ? ' · ' : ''}{p}</span>)}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
              {fullPressed === group.id && !short && realCount >= (rule.max ?? Infinity) && (
                <p role="status" style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--theme-text2)' }}>
                  Up to {rule.max} from {group.name}. Untick one to choose another.
                </p>
              )}
              {short && (
                <p role="alert" className="field-error" style={{ margin: '6px 0 0' }}>
                  {rule.min > count ? `Choose ${rule.min - count} more from ${group.name}.` : `Too many picked in ${group.name}.`}
                </p>
              )}
            </fieldset>
          )
        })}
      </div>

      <div className="picker-footer">
        <div className="picker-footer__total">
          <div className="picker-footer__price" data-testid="option-picker-total">
            {priceText}
            {eachText && <span className="picker-footer__each">{eachText}</span>}
          </div>
          {desc.summary && <div className="picker-footer__note">{desc.summary}</div>}
        </div>
        {showQty && (
          <div role="group" aria-label="Quantity" className="picker-qty">
            {/* aria-disabled, not disabled, at 1: a disabled button drops the focus of the finger or key
                that just pressed it to the top of the page. The press does nothing there. */}
            <button type="button" className="btn btn-ghost till-hit"
              onClick={() => setQty(q => (q <= 1 ? q : q - 1))} aria-disabled={qty <= 1}
              aria-label={`One fewer ${recipe.name}`}>−</button>
            <span aria-live="polite" className="picker-qty__value">{qty}</span>
            <button type="button" className="btn btn-ghost till-hit"
              onClick={() => setQty(q => q + 1)} aria-label={`One more ${recipe.name}`}>+</button>
          </div>
        )}
        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={confirm} aria-disabled={problems.length > 0}>
          {confirmLabel}
        </button>
      </div>
    </Modal>
  )
}
