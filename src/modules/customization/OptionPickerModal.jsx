import { useMemo, useRef, useState } from 'react'
import Modal from '../../components/Modal'
import { nprInt } from '../../shared/nepalMoney'
import {
  ruleText, describeSelection, selectionProblems, defaultSelection, inclFromEx, signedPrice, scaledDelta,
} from '../../shared/optionPricing'
import { moveRovingFocus, rovingTabIndex } from '../../shared/rovingFocus'
import { DIET_LABEL } from './customizationData'

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

const SAME_AS_LAST_MAX = 60

function sameIds(a, b) {
  if (!a || !b || a.length !== b.length) return false
  const sa = [...a].map(String).sort().join('+')
  const sb = [...b].map(String).sort().join('+')
  return sa === sb
}

export default function OptionPickerModal({
  recipe, dishGroups, catalog, vatRate = 0, initialIds, initialQty, lastIds = null,
  confirmLabel = 'Add to order', onConfirm, onClose, zIndex = 1100,
}) {
  const [selected, setSelected] = useState(() => initialIds ?? defaultSelection(dishGroups))
  const [qty, setQty] = useState(() => Math.max(1, Number(initialQty) || 1))
  const [tried, setTried] = useState(false)
  const fieldsetRefs = useRef({})

  const attachByGroup = useMemo(
    () => Object.fromEntries(dishGroups.map(d => [d.group.id, d.attachment])), [dishGroups])
  const fullCatalog = useMemo(() => ({ ...catalog, attachByGroup }), [catalog, attachByGroup])
  const desc = useMemo(() => describeSelection(selected, fullCatalog), [selected, fullCatalog])
  const lastDesc = useMemo(
    () => (lastIds && lastIds.length ? describeSelection(lastIds, fullCatalog) : null), [lastIds, fullCatalog])
  const problems = selectionProblems(dishGroups, selected)
  const unit = (Number(recipe.selling_price) || 0) + desc.delta
  const incl = n => Math.round(inclFromEx(n, vatRate))
  // The picks that fall under a group's first-N-free allowance, as the server would price them.
  const freeIds = useMemo(() => new Set(desc.options.filter(o => o.included).map(o => String(o.option_id))), [desc])
  const showSameAsLast = lastDesc && !sameIds(lastIds, selected)

  function toggle(group, rule, optionId) {
    setSelected(prev => {
      const inGroup = new Set(dishGroups.find(d => d.group.id === group.id).options.map(o => o.id))
      const has = prev.includes(optionId)
      if (rule.max === 1) {
        const others = prev.filter(id => !inGroup.has(id))
        // A required single pick cannot be un-picked by tapping it again — only replaced.
        if (has) return rule.min >= 1 ? prev : others
        return [...others, optionId]
      }
      if (has) return prev.filter(id => id !== optionId)
      const count = prev.filter(id => inGroup.has(id)).length
      if (rule.max != null && count >= rule.max) return prev
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

  const summaryOfLast = lastDesc
    ? (lastDesc.summary.length > SAME_AS_LAST_MAX ? `${lastDesc.summary.slice(0, SAME_AS_LAST_MAX - 1)}…` : lastDesc.summary)
    : ''

  return (
    <Modal onClose={onClose} title={recipe.name} maxWidth={520} zIndex={zIndex}
      panelStyle={{ maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}>
      <div style={{ overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: 18, paddingRight: 2 }}>
        {showSameAsLast && (
          <div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSelected([...lastIds])}
              title={lastDesc.summary}>
              Same as last: {summaryOfLast}
            </button>
          </div>
        )}

        {dishGroups.map(({ group, rule, options }) => {
          const count = options.filter(o => selected.includes(o.id)).length
          const short = tried && problems.some(p => p.group.id === group.id)
          const labelId = `opt-group-${group.id}`
          const isRadio = rule.max === 1
          const usedFree = rule.included > 0
            ? desc.options.filter(o => o.group_id === group.id && o.included).length
            : 0
          const baseRule = ruleText({ ...rule, included: 0 })
          const anyChecked = count > 0
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
                    {usedFree} of {rule.included} free picks used
                  </span>
                )}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 8 }}>
                {options.map((o, i) => {
                  const on = selected.includes(o.id)
                  const full = !on && rule.max != null && !isRadio && count >= rule.max
                  // S760: at the size picked so far — a topping on a Large bowl reads its Large price.
                  const listPrice = incl(scaledDelta(o, group, desc.portion_factor))
                  const isFree = on && freeIds.has(String(o.id)) && listPrice !== 0
                  const priceNode = o.is_removal
                    ? null
                    : isFree
                      ? <><span style={{ color: 'var(--theme-text2)' }}>Included</span> <s style={{ color: 'var(--theme-text3)' }}>{signedPrice(listPrice)}</s></>
                      : (signedPrice(listPrice) || null)
                  const metaParts = [
                    priceNode,
                    full ? `Max ${rule.max}` : null,
                    o.diet ? DIET_LABEL[o.diet] : null,
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
                      disabled={full}
                      tabIndex={isRadio ? rovingTabIndex(on || (!anyChecked && i === 0)) : 0}
                      onClick={() => toggle(group, rule, o.id)}
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
              {short && (
                <p role="alert" className="field-error" style={{ margin: '6px 0 0' }}>
                  {rule.min > count ? `Choose ${rule.min - count} more from ${group.name}.` : `Too many picked in ${group.name}.`}
                </p>
              )}
            </fieldset>
          )
        })}
      </div>

      <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10, borderTop: '1px solid var(--theme-border)', paddingTop: 12, marginTop: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 160 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--theme-text1)' }}>
            NPR {nprInt(incl(unit) * qty)}
            {qty > 1 && (
              <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--theme-text3)', marginLeft: 6 }}>
                NPR {nprInt(incl(unit))} × {qty}
              </span>
            )}
          </div>
          {desc.summary && <div style={{ fontSize: 12, color: 'var(--theme-text3)' }}>{desc.summary}</div>}
        </div>
        <div role="group" aria-label="Quantity" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <button type="button" className="btn btn-ghost" style={{ minWidth: 48, minHeight: 48, justifyContent: 'center' }}
            onClick={() => setQty(q => Math.max(1, q - 1))} disabled={qty <= 1} aria-label="One fewer">−</button>
          <span aria-live="polite" style={{ minWidth: 28, textAlign: 'center', fontWeight: 700, fontSize: 15, color: 'var(--theme-text1)' }}>{qty}</span>
          <button type="button" className="btn btn-ghost" style={{ minWidth: 48, minHeight: 48, justifyContent: 'center' }}
            onClick={() => setQty(q => q + 1)} aria-label="One more">+</button>
        </div>
        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={confirm} aria-disabled={problems.length > 0}>
          {confirmLabel}
        </button>
      </div>
    </Modal>
  )
}
