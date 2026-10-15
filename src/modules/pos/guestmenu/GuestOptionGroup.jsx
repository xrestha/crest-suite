import { Check } from 'lucide-react'
import { npr } from '../../../shared/nepalMoney'
import { moveRovingFocus, rovingTabIndex } from '../../../shared/rovingFocus'
import { tidyName, guestRuleText } from './guestMenuHelpers'
import DietMark from './DietMark'

// One option group as a guest picks it: its heading and rule, the free picks used, and its choices as
// chips (S844: one copy, shared by the dish sheet and the combo sheet; each had its own until then).
// The till's choice window (OptionPickerModal) is a different component on purpose.
//
// A group that takes one pick is a radiogroup with one Tab stop and arrow keys between its chips; any
// other is a group of checkboxes. A chip that would go past the group's maximum is disabled and says
// "Max N"; a "No …" removal takes no place under the maximum (S809 4h). A pick the group's first-N
// deal makes free reads "Included" with the list price struck through.

/** The chips the sheets focus when a group is short of its rule. */
export const FOCUSABLE_CHIP = '[role="radio"]:not([disabled]), [role="checkbox"]:not([disabled])'

/** "+NPR 50" / "−NPR 40": a choice's price as a change to the dish's. */
export const signedNpr = n => `${n > 0 ? '+' : '−'}${npr(Math.abs(n))}`

/**
 * @param {object} props
 * @param {object} props.group  the option group row (`id`, `kind`, …)
 * @param {{ min, max, included }} props.rule
 * @param {Array} props.options  the group's offered choices
 * @param {string} props.label  the heading the group is named by
 * @param {string} props.labelId  the heading's id, unique on the sheet
 * @param {(el: HTMLElement | null) => void} props.groupRef  the sheet's handle, for focusing a short group
 * @param {string[]} props.selectedIds  the option ids picked so far
 * @param {Set<string>} props.freeIds  picks the group's first-N deal makes free
 * @param {(o: object, group: object) => number} props.priceAt  a choice's price change, as the guest pays it
 * @param {(o: object) => number} [props.sizePrice]  given, a SIZE group's chips show the dish's whole
 *   price at that size instead of a change (the dish sheet; S767)
 * @param {boolean} props.short  the guest pressed on while this group is short of its rule
 * @param {(groupId: string, rule: object, optionId: string) => void} props.onToggle
 */
export default function GuestOptionGroup({ group, rule, options, label, labelId, groupRef, selectedIds, freeIds, priceAt, sizePrice, short, onToggle }) {
  const single = rule.max === 1
  const isSize = !!sizePrice && group.kind === 'size'
  const picked = options.filter(o => selectedIds.includes(o.id))
  const realCount = picked.filter(o => !o.is_removal).length
  const usedFree = picked.filter(o => freeIds.has(o.id)).length
  const pricedLeft = options.some(o => !selectedIds.includes(o.id) && !o.is_removal && priceAt(o, group) !== 0)
  const anyChecked = picked.length > 0
  return (
    <div
      ref={groupRef}
      tabIndex={-1}
      role={single ? 'radiogroup' : 'group'} aria-labelledby={labelId}
      onKeyDown={e => moveRovingFocus(e, single ? '[role="radio"]' : '[role="checkbox"]')}
      className="gm-group"
    >
      <div className="gm-group-head">
        <span id={labelId} className="gm-group-name">{label}</span>
        <span className={`gm-group-rule${short ? ' is-short' : ''}`}>
          {rule.min > 0 && <span className="gm-required">Required</span>}
          {guestRuleText(rule, options.length)}
        </span>
      </div>
      {rule.included > 0 && (
        <p className={`gm-group-free${usedFree > 0 ? ' is-used' : ''}`}>
          {usedFree} of {rule.included} free {rule.included === 1 ? 'pick' : 'picks'} used{pricedLeft ? ' · then each adds its price' : ''}
        </p>
      )}
      <div className="gm-options">
        {options.map((o, i) => {
          const on = selectedIds.includes(o.id)
          const full = !on && !o.is_removal && rule.max != null && !single && realCount >= rule.max
          const d = priceAt(o, group)
          const free = on && freeIds.has(o.id) && d !== 0
          const allergens = Array.isArray(o.allergens) ? o.allergens : []
          return (
            <button
              key={o.id} type="button"
              role={single ? 'radio' : 'checkbox'} aria-checked={on}
              disabled={full} aria-disabled={full || undefined}
              tabIndex={single ? rovingTabIndex(on || (!anyChecked && i === 0)) : 0}
              onClick={() => onToggle(group.id, rule, o.id)}
              className="gm-chip gm-option"
            >
              <span aria-hidden="true" className={`gm-option-mark ${single ? 'gm-option-mark--radio' : 'gm-option-mark--check'}`}>
                {!single && on && <Check size={14} strokeWidth={3} />}
              </span>
              <span className="gm-option-body">
                <span className={`gm-option-name${on ? ' is-on' : ''}`}>{tidyName(o.name)}</span>
                {(o.diet || allergens.length > 0) && (
                  <span className="gm-option-meta">
                    {o.diet && <DietMark diet={o.diet} />}
                    {allergens.length > 0 && `Contains ${allergens.join(', ')}`}
                  </span>
                )}
              </span>
              {full ? (
                <span className="gm-option-price">Max {rule.max}</span>
              ) : isSize ? (
                <span className="gm-option-price is-strong">{npr(sizePrice(o))}</span>
              ) : free ? (
                <span className="gm-option-price">Included <s>{signedNpr(d)}</s></span>
              ) : (!o.is_removal && d !== 0) ? (
                <span className="gm-option-price">{signedNpr(d)}</span>
              ) : null}
            </button>
          )
        })}
      </div>
    </div>
  )
}
