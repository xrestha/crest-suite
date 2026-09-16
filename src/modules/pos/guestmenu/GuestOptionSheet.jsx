import { useEffect, useMemo, useRef, useState } from 'react'
import { X, Check } from 'lucide-react'
import Modal from '../../../components/Modal'
import { npr } from '../../../shared/nepalMoney'
import {
  describeSelection, selectionProblems, defaultSelection, inclFromEx, scaledDelta,
} from '../../../shared/optionPricing'
import { moveRovingFocus, rovingTabIndex } from '../../../shared/rovingFocus'
import { tidyName, guestRuleText } from './guestMenuHelpers'

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
//
// S760, build-your-own dishes (`stepped`): the same groups, one per step — the Size step first, so
// every later price is already the price at that size — then a Review step with the whole bowl and
// Add. Next stays pressable while the step is short and says what is missing; an optional step with
// nothing picked reads Skip. Going back and changing the size re-prices everything already picked,
// because every price on the sheet is read through scaledDelta at the current size.
//
// S767 critique fixes, so a guest is not doing sums while deciding what to pay:
//   - a SIZE choice shows the dish's full price at that size ("Half · NPR 160"), never a difference
//     from a base price the sheet never shows ("−NPR 100"); extras keep their "+NPR 50";
//   - no price is quoted until a size is chosen — "Next · NPR 260" before any size was a price for a
//     dish that could not be ordered — and the button says "Choose a size" instead;
//   - the button is never dimmed. Its words say what is missing, and pressing it goes there; the
//     dimmed form measured 3.36:1, under AA;
//   - "Pick 2 to 10" for a group of three choices is capped to the choices offered;
//   - "Change" on Review comes straight back to Review after that one step;
//   - the step count sits in the pinned header, where it can no longer scroll under it, and no
//     longer repeats the group name printed directly below it.

// The same mark the menu row draws beside a dish: an outlined square with a dot, green for veg, red
// for non-veg. Egg is the market's third convention and takes amber. The word is the accessible name.
const DIET_MARK = {
  veg: { label: 'Vegetarian', title: 'Veg', modifier: 'gm-diet--veg' },
  egg: { label: 'Contains egg', title: 'Egg', modifier: 'gm-diet--egg' },
  non_veg: { label: 'Non-vegetarian', title: 'Non-veg', modifier: 'gm-diet--nonveg' },
}

function DietMark({ diet }) {
  const m = DIET_MARK[diet]
  if (!m) return null
  return (
    <span role="img" aria-label={m.label} title={m.title} className={`gm-diet ${m.modifier}`}>
      <span aria-hidden="true" />
    </span>
  )
}

const sameIds = (a, b) => {
  if (a.length !== b.length) return false
  const x = [...a].sort(), y = [...b].sort()
  return x.every((id, i) => id === y[i])
}

const FOCUSABLE_CHIP = '[role="radio"]:not([disabled]), [role="checkbox"]:not([disabled])'

export default function GuestOptionSheet({ item, dishGroups, catalog, vatRegistered, initialIds, editing, stepped = false, onConfirm, onClose }) {
  // Captured once: what the sheet opened with, so a backdrop tap can tell "looked" from "picked".
  const [initial] = useState(() => initialIds ?? defaultSelection(dishGroups))
  const [selected, setSelected] = useState(initial)
  const [tried, setTried] = useState(false)
  const groupRefs = useRef({})
  const vat = vatRegistered ? (parseFloat(item.vat_rate) || 0) : 0
  const dishName = tidyName(item.name)
  const base = parseFloat(item.selling_price) || 0

  const attachByGroup = useMemo(() => Object.fromEntries(dishGroups.map(d => [d.group.id, d.attachment])), [dishGroups])
  const desc = useMemo(() => describeSelection(selected, { ...catalog, attachByGroup }), [selected, catalog, attachByGroup])
  const freeIds = useMemo(() => new Set(desc.options.filter(o => o.included).map(o => o.option_id)), [desc])
  const problems = selectionProblems(dishGroups, selected)
  const price = Math.round(inclFromEx(base + desc.delta, vat))
  const dirty = !sameIds(selected, initial)
  // A required size group with nothing picked: there is no price to quote yet.
  const sizeUnpicked = dishGroups.some(d => d.group.kind === 'size' && d.rule.min > 0 && !d.options.some(o => selected.includes(o.id)))

  // S760: the walk. Size groups first (their pick decides every later price), the rest in dish order.
  const steps = useMemo(() => (stepped
    ? [...dishGroups.filter(d => d.group.kind === 'size'), ...dishGroups.filter(d => d.group.kind !== 'size')]
    : dishGroups), [stepped, dishGroups])
  // An edit opens on Review: the guest already built this bowl and is here to change one thing.
  const [step, setStep] = useState(() => (stepped && editing ? steps.length : 0))
  // Set by "Change" on Review: finishing that one step returns to Review rather than walking every
  // later step again.
  const [returnToReview, setReturnToReview] = useState(false)
  const onReview = stepped && step >= steps.length
  const stepHeadRef = useRef(null)
  useEffect(() => {
    if (!stepped) return
    const el = stepHeadRef.current
    if (!el) return
    el.focus({ preventScroll: true })
    // The pinned header holds the step count; the step's own content starts at the top.
    const panel = el.closest('.modal-sheet')
    if (panel) panel.scrollTop = 0
  }, [stepped, step])
  const visibleGroups = stepped ? (onReview ? [] : [steps[step]]) : dishGroups
  const stepProblem = stepped && !onReview ? problems.find(p => p.group.id === steps[step].group.id) : null
  const priceAt = (o, group) => Math.round(inclFromEx(scaledDelta(o, group, desc.portion_factor), vat))
  // A size is priced as the whole dish at that size.
  const sizePrice = o => Math.round(inclFromEx(base + (Number(o.price_delta) || 0), vat))
  const currentStepIsUnpickedSize = stepped && !onReview && steps[step].group.kind === 'size' && !steps[step].options.some(o => selected.includes(o.id))

  function goNext() {
    if (stepProblem) {
      setTried(true)
      const el = groupRefs.current[stepProblem.group.id]
      const chip = el?.querySelector(FOCUSABLE_CHIP)
      ;(chip || el)?.focus({ preventScroll: true })
      return
    }
    setTried(false)
    if (returnToReview) { setReturnToReview(false); setStep(steps.length); return }
    setStep(s => Math.min(s + 1, steps.length))
  }

  function confirmFromReview() {
    if (problems.length) {
      // A pick went stale since its step (a size change cannot do this, but an edit opened on
      // Review can start short) — go to the first step that is short and say so there.
      const idx = steps.findIndex(d => d.group.id === problems[0].group.id)
      setTried(true)
      setReturnToReview(true)
      setStep(idx < 0 ? 0 : idx)
      return
    }
    onConfirm(selected)
  }

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
  const addLabel = sizeUnpicked ? 'Choose a size' : `${editing ? 'Update' : 'Add to order'} · ${npr(price)}`
  const nextLabel = (() => {
    if (onReview) return addLabel
    if (currentStepIsUnpickedSize) return 'Choose a size'
    const d = steps[step]
    const verb = returnToReview ? 'Back to review' : (d && d.rule.min === 0 && !d.options.some(o => selected.includes(o.id)) ? 'Skip' : 'Next')
    return sizeUnpicked ? verb : `${verb} · ${npr(price)}`
  })()

  return (
    <Modal variant="sheet" title={dishName} onClose={onClose} dirty={dirty}>
      <div className="gm-sheet-head gm-sheet-head--dish">
        <div className="gm-sheet-head-row">
          <div style={{ minWidth: 0 }}>
            <h2 className="gm-sheet-title">{dishName}</h2>
            {item.description && <p className="gm-sheet-sub">{item.description}</p>}
          </div>
          <button type="button" className="btn btn-ghost btn-icon gm-close" onClick={onClose} aria-label="Close" title="Close">
            <X size={20} aria-hidden="true" />
          </button>
        </div>
        {stepped && (
          <div className="gm-steps">
            <p ref={stepHeadRef} tabIndex={-1} className="gm-steps-label" aria-live="polite">
              {onReview ? `Review · step ${steps.length + 1} of ${steps.length + 1}` : `Step ${step + 1} of ${steps.length + 1}`}
            </p>
            <div className="gm-steps-bar" role="progressbar" aria-label="Your progress"
              aria-valuemin={1} aria-valuemax={steps.length + 1} aria-valuenow={Math.min(step, steps.length) + 1}>
              <span style={{ transform: `scaleX(${(Math.min(step, steps.length) + 1) / (steps.length + 1)})` }} />
            </div>
          </div>
        )}
      </div>

      {onReview && (
        <ul className="gm-review" aria-label={`Your ${dishName}`}>
          {steps.map(({ group, options }, i) => {
            const picked = options.filter(o => selected.includes(o.id))
            return (
              <li key={group.id} className="gm-review-row">
                <div style={{ minWidth: 0, flex: 1 }}>
                  <span className="gm-review-group">{tidyName(group.name)}</span>
                  {picked.length === 0 ? (
                    <span className="gm-review-none">None</span>
                  ) : picked.map(o => {
                    const d = group.kind === 'size' ? null : priceAt(o, group)
                    const free = d != null && freeIds.has(o.id) && d !== 0
                    return (
                      <span key={o.id} className="gm-review-pick">
                        <span style={{ minWidth: 0 }}>{tidyName(o.name)}</span>
                        <span className="gm-review-price">
                          {group.kind === 'size' ? npr(sizePrice(o)) : o.is_removal || d === 0 ? '' : free ? 'Included' : `${d > 0 ? '+' : '−'}${npr(Math.abs(d))}`}
                        </span>
                      </span>
                    )
                  })}
                </div>
                <button type="button" className="btn btn-ghost btn-sm gm-review-change"
                  aria-label={`Change ${tidyName(group.name)}`}
                  onClick={() => { setTried(false); setReturnToReview(true); setStep(i) }}>Change</button>
              </li>
            )
          })}
        </ul>
      )}

      <div className="gm-groups">
        {visibleGroups.map(({ group, rule, options }) => {
          const single = rule.max === 1
          const isSize = group.kind === 'size'
          const picked = options.filter(o => selected.includes(o.id))
          const count = picked.length
          const short = tried && problems.some(p => p.group.id === group.id)
          const labelId = `g-opt-${group.id}`
          const usedFree = picked.filter(o => freeIds.has(o.id)).length
          const pricedLeft = options.some(o => !selected.includes(o.id) && !o.is_removal && priceAt(o, group) !== 0)
          const anyChecked = count > 0
          return (
            <div
              key={group.id}
              ref={el => { groupRefs.current[group.id] = el }}
              tabIndex={-1}
              role={single ? 'radiogroup' : 'group'} aria-labelledby={labelId}
              onKeyDown={e => moveRovingFocus(e, single ? '[role="radio"]' : '[role="checkbox"]')}
              className="gm-group"
            >
              <div className="gm-group-head">
                <span id={labelId} className="gm-group-name">{tidyName(group.name)}</span>
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
                  const on = selected.includes(o.id)
                  const full = !on && rule.max != null && !single && count >= rule.max
                  // S760: at the size picked so far.
                  const d = priceAt(o, group)
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
                        <span className="gm-option-price">
                          Included <s>{priceText}</s>
                        </span>
                      ) : (!o.is_removal && d !== 0) ? (
                        <span className="gm-option-price">{priceText}</span>
                      ) : null}
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>

      <div className="gm-sheet-foot">
        {tried && (stepped ? stepProblem : shortGroup) && (() => {
          const p = stepped ? stepProblem : shortGroup
          return (
            <p role="alert" className="gm-error">
              {p.rule.min > p.count
                ? `Choose ${p.rule.min - p.count} more from ${tidyName(p.group.name)}.`
                : `Too many chosen in ${tidyName(p.group.name)}. Remove ${p.count - p.rule.max}.`}
            </p>
          )
        })()}
        {!stepped ? (
          <button
            type="button" className="btn btn-primary gm-sheet-primary"
            aria-disabled={problems.length > 0}
            onClick={() => { if (problems.length) { refuseAdd(); return } onConfirm(selected) }}
          >
            {addLabel}
          </button>
        ) : (
          <div className="gm-sheet-foot-row">
            {step > 0 && !returnToReview && (
              <button type="button" className="btn btn-ghost gm-sheet-back"
                onClick={() => { setTried(false); setStep(s => Math.max(0, s - 1)) }}>Back</button>
            )}
            {onReview ? (
              <button type="button" className="btn btn-primary gm-sheet-primary"
                aria-disabled={problems.length > 0} onClick={confirmFromReview}>
                {addLabel}
              </button>
            ) : (
              <button type="button" className="btn btn-primary gm-sheet-primary"
                aria-disabled={!!stepProblem} onClick={goNext}>
                {nextLabel}
              </button>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}
