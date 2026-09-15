import { useMemo, useRef, useState } from 'react'
import Modal from '../../../components/Modal'
import { npr } from '../../../shared/nepalMoney'
import {
  describeSelection, selectionProblems, defaultSelection, inclFromEx,
} from '../../../shared/optionPricing'
import { moveRovingFocus, rovingTabIndex } from '../../../shared/rovingFocus'

// Crest Customization on the QR menu (S758 stage 6): the sheet a guest picks a dish's choices in.
// Same rules as the till's OptionPickerModal — describeSelection is the twin of the server's pricer
// — laid out for a phone held in one hand: 48px targets, the running price and the Add button
// always at the bottom, and a group that is still short named beside the button rather than a dead
// control. Veg/egg marks and allergens are shown per choice (owner decision).
//
// Prices are the guest-facing figure: VAT applied only when the outlet is VAT-registered, the same
// rule priceIncVat on the menu uses.
//
// S759 critique fixes: a backdrop tap never discards picks (Modal's `dirty` prop — a chip click
// fires neither onInput nor onChange, so the sheet's own guard could not see it); a pick the
// group's first-N deal makes free reads "Included" with the list price struck through; the group
// heading says how many free picks are used; the chip states live in guestMenu.css (`.gm-option`)
// rather than inline; a radiogroup is one Tab stop with arrow keys between chips; and the dish
// name stays pinned while a long sheet scrolls.

// The same mark the menu card draws beside a dish (GuestMenu.jsx's is_veg square): a 12px outlined
// square with a dot, green for veg, red for non-veg. Egg is the market's third convention and takes
// the page's amber. The word survives as the accessible name and the title.
const DIET_MARK = {
  veg: { label: 'Vegetarian', title: 'Veg', color: 'var(--theme-green)' },
  egg: { label: 'Contains egg', title: 'Egg', color: 'var(--theme-amber)' },
  non_veg: { label: 'Non-vegetarian', title: 'Non-Veg', color: 'var(--theme-red)' },
}

function DietMark({ diet }) {
  const m = DIET_MARK[diet]
  if (!m) return null
  return (
    <span
      role="img" aria-label={m.label} title={m.title}
      style={{
        display: 'inline-block', width: 12, height: 12, borderRadius: 2, flexShrink: 0,
        border: `1.5px solid ${m.color}`, verticalAlign: '-1px', marginRight: 5,
      }}>
      <span aria-hidden="true" style={{
        display: 'block', width: 6, height: 6, margin: '2px auto', borderRadius: '50%', background: m.color,
      }} />
    </span>
  )
}

// Rule wording for a guest: sentence case, no "Optional ·" prefix, no "· first N free" tail —
// the free picks are stated live under the heading instead.
function guestRuleText({ min, max }) {
  if (max === 1) return 'Pick 1'
  if (min > 0 && max != null && min === max) return `Pick ${min}`
  if (min > 0 && max != null) return `Pick ${min} to ${max}`
  if (min > 0) return `Pick at least ${min}`
  if (max != null) return `Pick up to ${max}`
  return 'Pick any number'
}

const sameIds = (a, b) => {
  if (a.length !== b.length) return false
  const x = [...a].sort(), y = [...b].sort()
  return x.every((id, i) => id === y[i])
}

const FOCUSABLE_CHIP = '[role="radio"]:not([disabled]), [role="checkbox"]:not([disabled])'

export default function GuestOptionSheet({ item, dishGroups, catalog, vatRegistered, initialIds, editing, onConfirm, onClose }) {
  // Captured once: what the sheet opened with, so a backdrop tap can tell "looked" from "picked".
  const [initial] = useState(() => initialIds ?? defaultSelection(dishGroups))
  const [selected, setSelected] = useState(initial)
  const [tried, setTried] = useState(false)
  const groupRefs = useRef({})
  const vat = vatRegistered ? (parseFloat(item.vat_rate) || 0) : 0

  const attachByGroup = useMemo(() => Object.fromEntries(dishGroups.map(d => [d.group.id, d.attachment])), [dishGroups])
  const desc = useMemo(() => describeSelection(selected, { ...catalog, attachByGroup }), [selected, catalog, attachByGroup])
  const freeIds = useMemo(() => new Set(desc.options.filter(o => o.included).map(o => o.option_id)), [desc])
  const problems = selectionProblems(dishGroups, selected)
  const price = Math.round(inclFromEx((parseFloat(item.selling_price) || 0) + desc.delta, vat))
  const dirty = !sameIds(selected, initial)

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

  function refuseAdd() {
    setTried(true)
    const el = groupRefs.current[problems[0]?.group.id]
    if (!el) return
    el.scrollIntoView({ block: 'center' })
    const chip = el.querySelector(FOCUSABLE_CHIP)
    ;(chip || el).focus({ preventScroll: true })
  }

  const shortGroup = problems[0]

  return (
    <Modal variant="sheet" title={item.name} onClose={onClose} dirty={dirty}>
      <div className="gm-sheet-head">
        <div style={{ minWidth: 0 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: 'var(--theme-text1)' }}>{item.name}</h2>
          {item.description && <p style={{ margin: '4px 0 0', fontSize: 12.5, color: 'var(--theme-text2)' }}>{item.description}</p>}
        </div>
        <button type="button" className="btn btn-ghost" onClick={onClose} aria-label="Close"
          style={{ width: 44, minWidth: 44, minHeight: 44, padding: 0, justifyContent: 'center' }}>✕</button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 20, paddingBottom: 8 }}>
        {dishGroups.map(({ group, rule, options }) => {
          const single = rule.max === 1
          const picked = options.filter(o => selected.includes(o.id))
          const count = picked.length
          const short = tried && problems.some(p => p.group.id === group.id)
          const labelId = `g-opt-${group.id}`
          const usedFree = picked.filter(o => freeIds.has(o.id)).length
          const pricedLeft = options.some(o => !selected.includes(o.id) && !o.is_removal && Math.round(inclFromEx(o.price_delta, vat)) !== 0)
          const anyChecked = count > 0
          return (
            <div
              key={group.id}
              ref={el => { groupRefs.current[group.id] = el }}
              tabIndex={-1}
              role={single ? 'radiogroup' : 'group'} aria-labelledby={labelId}
              onKeyDown={e => moveRovingFocus(e, single ? '[role="radio"]' : '[role="checkbox"]')}
              style={{ outline: 'none' }}
            >
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
                <span id={labelId} style={{ fontSize: 15, fontWeight: 700, color: 'var(--theme-text1)' }}>{group.name}</span>
                <span style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12,
                  color: short ? 'var(--theme-red-text)' : 'var(--theme-text3)', textAlign: 'right', whiteSpace: 'nowrap',
                }}>
                  {rule.min > 0 && <span className="gm-required">Required</span>}
                  {guestRuleText(rule)}
                </span>
              </div>
              {rule.included > 0 && (
                <p style={{ margin: '-4px 0 8px', fontSize: 12, color: usedFree > 0 ? 'var(--theme-text2)' : 'var(--theme-text3)' }}>
                  {usedFree} of {rule.included} free {rule.included === 1 ? 'pick' : 'picks'} used{pricedLeft ? ' · then +price each' : ''}
                </p>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {options.map((o, i) => {
                  const on = selected.includes(o.id)
                  const full = !on && rule.max != null && !single && count >= rule.max
                  const d = Math.round(inclFromEx(o.price_delta, vat))
                  const free = on && freeIds.has(o.id) && d !== 0
                  const allergens = Array.isArray(o.allergens) ? o.allergens : []
                  const priceText = `${d > 0 ? '+' : '−'}${npr(Math.abs(d))}`
                  return (
                    <button
                      key={o.id} type="button"
                      role={single ? 'radio' : 'checkbox'} aria-checked={on}
                      disabled={full} aria-disabled={full || undefined}
                      tabIndex={single ? rovingTabIndex(on || (!anyChecked && i === 0)) : 0}
                      onClick={() => toggle(group.id, rule, o.id)}
                      className="gm-chip gm-option"
                    >
                      <span aria-hidden="true" className="gm-option-mark" style={{ borderRadius: single ? '50%' : 4 }} />
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: 'block', fontSize: 14, fontWeight: on ? 600 : 400 }}>{o.name}</span>
                        {(o.diet || allergens.length > 0) && (
                          <span style={{ display: 'block', fontSize: 11.5, color: 'var(--theme-text3)', textTransform: 'none' }}>
                            {o.diet && <DietMark diet={o.diet} />}
                            {allergens.length > 0 && `Contains ${allergens.join(', ')}`}
                          </span>
                        )}
                      </span>
                      {full ? (
                        <span style={{ fontSize: 12, color: 'var(--theme-text3)', whiteSpace: 'nowrap' }}>Max {rule.max}</span>
                      ) : free ? (
                        <span style={{ fontSize: 13, color: 'var(--theme-text2)', whiteSpace: 'nowrap' }}>
                          Included <s style={{ color: 'var(--theme-text3)', marginLeft: 4 }}>{priceText}</s>
                        </span>
                      ) : (!o.is_removal && d !== 0) ? (
                        <span style={{ fontSize: 13, color: 'var(--theme-text2)', whiteSpace: 'nowrap' }}>{priceText}</span>
                      ) : null}
                    </button>
                  )
                })}
              </div>
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
              ? `Please choose ${shortGroup.rule.min - shortGroup.count} more from ${shortGroup.group.name} to continue.`
              : `Too many chosen in ${shortGroup.group.name} — remove ${shortGroup.count - shortGroup.rule.max}.`}
          </p>
        )}
        <button
          type="button" className="btn btn-primary" style={{ minHeight: 48, fontSize: 15 }}
          aria-disabled={problems.length > 0}
          onClick={() => { if (problems.length) { refuseAdd(); return } onConfirm(selected) }}
        >
          {editing ? 'Update' : 'Add to order'} · {npr(price)}
        </button>
      </div>
    </Modal>
  )
}
