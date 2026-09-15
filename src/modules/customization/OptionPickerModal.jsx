import { useMemo, useState } from 'react'
import Modal from '../../components/Modal'
import { nprInt } from '../../shared/nepalMoney'
import {
  ruleText, describeSelection, selectionProblems, defaultSelection, inclFromEx, signedPrice,
} from '../../shared/optionPricing'
import { DIET_LABEL } from './customizationData'

// Crest Customization (S758 stage 5): the choice window a waiter sees when tapping a dish that has
// option groups. Owner decision: it opens on EVERY tap of such a dish, so nobody forgets to ask.
//
// The price shown is the till's twin of the server's (describeSelection); the bill is priced by
// save_pos_order_items from the option ids alone, so nothing here can set what a guest pays.
//
// A group with max 1 behaves as a radio (a new pick replaces the old one); any other group as
// checkboxes that stop at the maximum. Add stays disabled until every group's rule is met, with the
// group that is short named on screen rather than a dead button.

export default function OptionPickerModal({
  recipe, dishGroups, catalog, vatRate = 0, initialIds, confirmLabel = 'Add to order', onConfirm, onClose, zIndex = 1100,
}) {
  const [selected, setSelected] = useState(() => initialIds ?? defaultSelection(dishGroups))
  const [tried, setTried] = useState(false)

  const attachByGroup = useMemo(
    () => Object.fromEntries(dishGroups.map(d => [d.group.id, d.attachment])), [dishGroups])
  const desc = useMemo(
    () => describeSelection(selected, { ...catalog, attachByGroup }), [selected, catalog, attachByGroup])
  const problems = selectionProblems(dishGroups, selected)
  const unit = (Number(recipe.selling_price) || 0) + desc.delta
  const incl = n => Math.round(inclFromEx(n, vatRate))

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
    if (problems.length) { setTried(true); return }
    onConfirm(selected)
  }

  return (
    <Modal onClose={onClose} title={recipe.name} maxWidth={520} zIndex={zIndex}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        {dishGroups.map(({ group, rule, options }) => {
          const count = options.filter(o => selected.includes(o.id)).length
          const short = tried && problems.some(p => p.group.id === group.id)
          const labelId = `opt-group-${group.id}`
          return (
            <fieldset key={group.id} style={{ border: 'none', margin: 0, padding: 0 }}
              role={rule.max === 1 ? 'radiogroup' : 'group'} aria-labelledby={labelId}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                <span id={labelId} style={{ fontWeight: 700, fontSize: 14, color: 'var(--theme-text1)' }}>{group.name}</span>
                <span style={{ fontSize: 12, color: short ? 'var(--theme-red-text)' : 'var(--theme-text3)' }}>
                  {ruleText(rule)}{rule.max !== 1 && count > 0 ? ` · ${count} picked` : ''}
                </span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 8 }}>
                {options.map(o => {
                  const on = selected.includes(o.id)
                  const full = !on && rule.max != null && rule.max !== 1 && count >= rule.max
                  const price = o.is_removal ? '' : signedPrice(incl(o.price_delta))
                  return (
                    <button
                      key={o.id}
                      type="button"
                      role={rule.max === 1 ? 'radio' : 'checkbox'}
                      aria-checked={on}
                      disabled={full}
                      onClick={() => toggle(group, rule, o.id)}
                      style={{
                        minHeight: 48, padding: '8px 10px', textAlign: 'left', cursor: full ? 'not-allowed' : 'pointer',
                        display: 'flex', flexDirection: 'column', gap: 2, fontFamily: 'inherit',
                        background: on ? 'color-mix(in srgb, var(--theme-accent) 14%, var(--theme-card))' : 'var(--theme-input-bg)',
                        border: `${on ? 2 : 1}px solid ${on ? 'var(--theme-accent)' : 'var(--theme-border)'}`,
                        color: 'var(--theme-text1)', opacity: full ? 0.5 : 1,
                      }}
                    >
                      <span style={{ fontSize: 13, fontWeight: on ? 700 : 500 }}>
                        {o.is_removal && <span style={{ color: 'var(--theme-red-text)', fontWeight: 700 }}>✕ </span>}
                        {o.name}
                      </span>
                      <span style={{ fontSize: 11, color: 'var(--theme-text3)' }}>
                        {[price, o.diet ? DIET_LABEL[o.diet] : ''].filter(Boolean).join(' · ')}
                      </span>
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

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, borderTop: '1px solid var(--theme-border)', paddingTop: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 160 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--theme-text1)' }}>NPR {nprInt(incl(unit))}</div>
            {desc.summary && <div style={{ fontSize: 12, color: 'var(--theme-text3)' }}>{desc.summary}</div>}
          </div>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={confirm} aria-disabled={problems.length > 0}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  )
}
