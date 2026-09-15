import { useMemo, useState } from 'react'
import Modal from '../../../components/Modal'
import { npr } from '../../../shared/nepalMoney'
import {
  ruleText, describeSelection, selectionProblems, defaultSelection, inclFromEx,
} from '../../../shared/optionPricing'

// Crest Customization on the QR menu (S758 stage 6): the sheet a guest picks a dish's choices in.
// Same rules as the till's OptionPickerModal — describeSelection is the twin of the server's pricer
// — laid out for a phone held in one hand: 48px targets, the running price and the Add button
// always at the bottom, and a group that is still short named beside the button rather than a dead
// control. Veg/egg marks and allergens are shown per choice (owner decision).
//
// Prices are the guest-facing figure: VAT applied only when the outlet is VAT-registered, the same
// rule priceIncVat on the menu uses.

const DIET_MARK = { veg: 'Veg', egg: 'Egg', non_veg: 'Non-veg' }

export default function GuestOptionSheet({ item, dishGroups, catalog, vatRegistered, initialIds, editing, onConfirm, onClose }) {
  const [selected, setSelected] = useState(() => initialIds ?? defaultSelection(dishGroups))
  const [tried, setTried] = useState(false)
  const vat = vatRegistered ? (parseFloat(item.vat_rate) || 0) : 0

  const attachByGroup = useMemo(() => Object.fromEntries(dishGroups.map(d => [d.group.id, d.attachment])), [dishGroups])
  const desc = useMemo(() => describeSelection(selected, { ...catalog, attachByGroup }), [selected, catalog, attachByGroup])
  const problems = selectionProblems(dishGroups, selected)
  const price = Math.round(inclFromEx((parseFloat(item.selling_price) || 0) + desc.delta, vat))

  function toggle(groupId, rule, optionId) {
    setSelected(prev => {
      const inGroup = new Set(dishGroups.find(d => d.group.id === groupId).options.map(o => o.id))
      const has = prev.includes(optionId)
      if (rule.max === 1) {
        const others = prev.filter(id => !inGroup.has(id))
        if (has) return rule.min >= 1 ? prev : others
        return [...others, optionId]
      }
      if (has) return prev.filter(id => id !== optionId)
      if (rule.max != null && prev.filter(id => inGroup.has(id)).length >= rule.max) return prev
      return [...prev, optionId]
    })
  }

  const shortGroup = problems[0]

  return (
    <Modal variant="sheet" title={item.name} onClose={onClose}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, marginBottom: 14 }}>
        <div style={{ minWidth: 0 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: 'var(--theme-text1)' }}>{item.name}</h2>
          {item.description && <p style={{ margin: '4px 0 0', fontSize: 12.5, color: 'var(--theme-text2)' }}>{item.description}</p>}
        </div>
        <button type="button" className="btn btn-ghost" onClick={onClose} aria-label="Close"
          style={{ width: 44, minWidth: 44, minHeight: 44, padding: 0, justifyContent: 'center' }}>✕</button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 20, paddingBottom: 8 }}>
        {dishGroups.map(({ group, rule, options }) => {
          const count = options.filter(o => selected.includes(o.id)).length
          const short = tried && problems.some(p => p.group.id === group.id)
          const labelId = `g-opt-${group.id}`
          return (
            <div key={group.id} role={rule.max === 1 ? 'radiogroup' : 'group'} aria-labelledby={labelId}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
                <span id={labelId} style={{ fontSize: 15, fontWeight: 700, color: 'var(--theme-text1)' }}>{group.name}</span>
                <span style={{ fontSize: 12, color: short ? 'var(--theme-red-text)' : 'var(--theme-text3)', textAlign: 'right' }}>
                  {rule.min > 0 ? 'Required · ' : ''}{ruleText(rule).replace(/^Optional · /, '')}
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {options.map(o => {
                  const on = selected.includes(o.id)
                  const full = !on && rule.max != null && rule.max !== 1 && count >= rule.max
                  const d = Math.round(inclFromEx(o.price_delta, vat))
                  const allergens = Array.isArray(o.allergens) ? o.allergens : []
                  return (
                    <button
                      key={o.id} type="button"
                      role={rule.max === 1 ? 'radio' : 'checkbox'} aria-checked={on} disabled={full}
                      onClick={() => toggle(group.id, rule, o.id)}
                      className="gm-chip"
                      style={{
                        display: 'flex', alignItems: 'center', gap: 10, minHeight: 48, padding: '10px 12px',
                        borderRadius: 8, textAlign: 'left', fontFamily: 'inherit', cursor: full ? 'not-allowed' : 'pointer',
                        border: `${on ? 2 : 1}px solid ${on ? 'var(--theme-accent)' : 'var(--theme-border)'}`,
                        background: on ? 'color-mix(in srgb, var(--theme-accent) 10%, var(--theme-card))' : 'var(--theme-input-bg)',
                        color: 'var(--theme-text1)', opacity: full ? 0.5 : 1,
                      }}
                    >
                      <span aria-hidden="true" style={{
                        width: 18, height: 18, flexShrink: 0, borderRadius: rule.max === 1 ? '50%' : 4,
                        border: `2px solid ${on ? 'var(--theme-accent)' : 'var(--theme-border-lt)'}`,
                        background: on ? 'var(--theme-accent)' : 'transparent',
                      }} />
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: 'block', fontSize: 14, fontWeight: on ? 600 : 400 }}>{o.name}</span>
                        {(o.diet || allergens.length > 0) && (
                          <span style={{ display: 'block', fontSize: 11.5, color: 'var(--theme-text3)', textTransform: 'none' }}>
                            {[o.diet ? DIET_MARK[o.diet] : '', allergens.length ? `Contains ${allergens.join(', ')}` : ''].filter(Boolean).join(' · ')}
                          </span>
                        )}
                      </span>
                      {!o.is_removal && d !== 0 && (
                        <span style={{ fontSize: 13, color: 'var(--theme-text2)', whiteSpace: 'nowrap' }}>
                          {d > 0 ? '+' : '−'}{npr(Math.abs(d))}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
              {rule.included > 0 && (
                <p style={{ margin: '6px 0 0', fontSize: 11.5, color: 'var(--theme-text3)' }}>
                  The first {rule.included} {rule.included === 1 ? 'choice is' : 'choices are'} included in the price.
                </p>
              )}
            </div>
          )
        })}
      </div>

      <div style={{
        position: 'sticky', bottom: 0, background: 'var(--theme-card)', paddingTop: 12, marginTop: 8,
        borderTop: '1px solid var(--theme-border)', display: 'flex', flexDirection: 'column', gap: 8,
      }}>
        {tried && shortGroup && (
          <p role="alert" style={{ margin: 0, fontSize: 12.5, color: 'var(--theme-red-text)' }}>
            {shortGroup.rule.min > shortGroup.count
              ? `Please choose ${shortGroup.group.name.toLowerCase()} to continue.`
              : `Too many chosen in ${shortGroup.group.name}.`}
          </p>
        )}
        <button
          type="button" className="btn btn-primary" style={{ minHeight: 48, fontSize: 15 }}
          aria-disabled={problems.length > 0}
          onClick={() => { if (problems.length) { setTried(true); return } onConfirm(selected) }}
        >
          {editing ? 'Update' : 'Add to order'} · {npr(price)}
        </button>
      </div>
    </Modal>
  )
}
