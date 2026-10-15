import { useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { X, Check } from 'lucide-react'
import Modal from '../../../components/Modal'
import { npr } from '../../../shared/nepalMoney'
import {
  describeSelection, selectionProblems, defaultSelection, inclFromEx, scaledDelta, groupsForDish,
} from '../../../shared/optionPricing'
import { moveRovingFocus, rovingTabIndex } from '../../../shared/rovingFocus'
import { selectionKeyOf } from '../orders/posOrdersConstants'
import { comboGuestTotal } from '../../customization/comboPricing'
import { tidyName, guestRuleText, matchesSearch } from './guestMenuHelpers'
import { useLeaveConfirm, LeaveConfirm } from './GuestOptionSheet'

// Combos on the QR menu (S839, docs/pos-combos.md): the sheet a guest builds one combo in. A combo is
// sold at one price ("Momo Combo, NPR 350") and made of picks ("Pick a momo", "Pick a drink"), each
// exactly one dish from a short list, some dishes with an extra charge ("Chicken +NPR 50").
//
// It walks like the build-your-own sheet (GuestOptionSheet `stepped`): one step per pick that asks a
// question, then a Review step with the whole combo and Add. A pick with one dish asks nothing and
// reads "Included" on Review. A picked dish that has its own choices (a size, an add-on) takes them in
// the same step, under the same rules as the dish on its own (owner decision): those are charged on top.
//
// Prices are what the guest pays. `guest_price` and `extra_price` already are (VAT-inclusive on a
// VAT-registered outlet, the price itself on a PAN outlet); a dish's own choices are stored ex-VAT and
// shown through its VAT rate, as the dish sheet shows them. The server prices every line itself.
//
// The pure helpers below are exported for GuestMenu and the tests; the page keeps no second copy.
//
// The phone's Back (S842, owner decision) walks back one step and asks before picks are lost, exactly
// as the dish sheet does (GuestOptionSheet's useLeaveConfirm / LeaveConfirm, through `backRef`).

const bySortThenName = (a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0)
  || String(a.name || '').localeCompare(String(b.name || '')) || String(a.id || a.recipe_id || '').localeCompare(String(b.id || b.recipe_id || ''))

/** A combo's picks in the order the guest answers them, each with its dishes in menu order. */
export function comboPicksOf(combo) {
  return [...(combo?.groups || [])]
    .sort(bySortThenName)
    .map(g => ({ ...g, items: [...(g.items || [])].sort(bySortThenName) }))
}

/** Whether a combo can be ordered at all: at least one pick, and a dish in every pick. */
export function comboOrderable(combo) {
  const picks = comboPicksOf(combo)
  return !!combo?.id && picks.length > 0 && picks.every(g => g.items.length > 0)
}

/** The cart key of one combo with these picks. The same combo with the same picks is one line. */
export function comboCartKey(comboId, picks) {
  const parts = (picks || [])
    .map(p => `${p.group_id}=${p.recipe_id}${p.option_ids?.length ? `#${selectionKeyOf(p.option_ids)}` : ''}`)
    .sort()
  return `combo:${comboId}|${parts.join('|')}`
}

/** The dish a pick starts on: its default, else its only dish, else none (the guest must choose). */
export function defaultDishOf(pick) {
  const items = pick?.items || []
  return (items.find(it => it.is_default) || (items.length === 1 ? items[0] : null))?.recipe_id || null
}

/** A cart combo line as submit_guest_order takes it: { combo_id, qty, note, picks: [{ group_id, recipe_id, options }] }. */
export function comboOrderItem(line) {
  return {
    combo_id: line.combo_id,
    qty: line.qty,
    note: line.note || null,
    picks: (line.picks || []).map(p => ({ group_id: p.group_id, recipe_id: p.recipe_id, options: [...(p.option_ids || [])] })),
  }
}

/**
 * One picked dish's own choices, priced as the guest pays: { incl, summary }. `ctx` is
 * { optionMaps: { optionsById, groupsById }, dishGroupsByRecipe, vatOf(recipeId) }.
 */
export function pickChoices(pick, ctx) {
  if (!pick?.recipe_id || !pick.option_ids?.length) return { incl: 0, summary: '' }
  const dg = ctx?.dishGroupsByRecipe?.[pick.recipe_id] || []
  const desc = describeSelection(pick.option_ids, {
    ...(ctx?.optionMaps || {}), attachByGroup: Object.fromEntries(dg.map(d => [d.group.id, d.attachment])),
  })
  return { incl: inclFromEx(desc.delta, ctx?.vatOf ? ctx.vatOf(pick.recipe_id) : 0), summary: desc.summary }
}

/** The menu entry a pick names, or undefined: `{ recipe_id, name, is_veg, extra_price, … }`. */
function pickedItem(picks, pick) {
  return picks.find(g => g.id === pick.group_id)?.items.find(it => it.recipe_id === pick.recipe_id)
}

/**
 * What a guest pays for one of this combo with these picks, before the bill's rounding: the combo's
 * price, the picked dishes' extra charges, and every dish's own choices.
 */
export function comboUnitPrice(combo, picks, ctx) {
  const all = comboPicksOf(combo)
  const chosen = (picks || []).filter(p => p?.recipe_id)
  const items = chosen.map(p => pickedItem(all, p)).filter(Boolean)
  return comboGuestTotal(combo, items) + chosen.reduce((s, p) => s + pickChoices(p, ctx).incl, 0)
}

/** "Momo Combo (Chicken Momo, Coke)": how the order tracker names one combo. */
export function comboOrderName(combo, picks) {
  const all = comboPicksOf(combo)
  const names = (picks || []).map(p => pickedItem(all, p)?.name).filter(Boolean).map(tidyName)
  const name = tidyName(combo?.name || 'Combo')
  return names.length ? `${name} (${names.join(', ')})` : name
}

/** What is in a combo, for its menu row: a one-dish pick by the dish, a choice by the pick's name. */
export function comboContents(combo) {
  return comboPicksOf(combo)
    .map(g => (g.items.length === 1 ? tidyName(g.items[0].name) : `${tidyName(g.name)} (${g.items.length} choices)`))
    .join(' + ')
}

/**
 * Why a combo line in the cart can no longer be ordered from this catalog — 'gone' (the combo is no
 * longer offered), 'changed' (its picks or a pick's dishes changed) or 'choices' (a dish's choices no
 * longer fit what it offers) — or null when it still can. `catalog` is { groups, options, attachments }.
 */
export function comboLineProblem(line, combosById, catalog) {
  const combo = combosById?.[line?.combo_id]
  if (!combo || !comboOrderable(combo)) return 'gone'
  const picks = comboPicksOf(combo)
  const given = line.picks || []
  if (given.length !== picks.length) return 'changed'
  for (const g of picks) {
    const p = given.find(x => x.group_id === g.id)
    if (!p || !g.items.some(it => it.recipe_id === p.recipe_id)) return 'changed'
    const dg = groupsForDish(p.recipe_id, catalog || {})
    if (dg.length === 0) {
      if ((p.option_ids || []).length) return 'choices'
      continue
    }
    const offered = new Set(dg.flatMap(d => d.options.map(o => o.id)))
    if (!(p.option_ids || []).every(id => offered.has(id)) || selectionProblems(dg, p.option_ids).length) return 'choices'
  }
  return null
}

/**
 * The cart once combos that did reach the restaurant are taken out of it, each by the quantity it
 * sent (the combo half of guestMenuHelpers' cartWithout). Lines that are not combos are ignored.
 */
export function comboCartWithout(cart, sentLines) {
  const out = { ...(cart || {}) }
  for (const l of sentLines || []) {
    if (!l?.combo_id) continue
    const k = comboCartKey(l.combo_id, l.picks)
    const line = out[k]
    if (!line) continue
    const left = (Number(line.qty) || 0) - (Number(l.qty) || 0)
    if (left > 0) out[k] = { ...line, qty: left }
    else delete out[k]
  }
  return out
}

/**
 * Whether a combo stays on the menu under the guest's search and filters. Vegetarian-only keeps a
 * combo whose every pick offers a vegetarian dish; a hidden allergen keeps one whose every pick
 * offers a dish free of it (by the dish's recorded allergens, `allergensOf(recipeId)`). The search
 * reads the combo's name and description and its dishes' names.
 */
export function comboMatches(combo, { query = '', vegOnly = false, excludedAllergens = [], allergensOf = () => [] } = {}) {
  const picks = comboPicksOf(combo)
  if (vegOnly && !picks.every(g => g.items.some(it => it.is_veg === true))) return false
  if (excludedAllergens.length > 0
    && !picks.every(g => g.items.some(it => !(allergensOf(it.recipe_id) || []).some(a => excludedAllergens.includes(a))))) return false
  if (!String(query || '').trim()) return true
  return matchesSearch({ name: tidyName(combo.name), description: combo.description, category: 'Combos' }, query)
    || picks.some(g => g.items.some(it => matchesSearch({ name: tidyName(it.name) }, query)))
}

// The market's veg / non-veg mark (an outlined square with a dot), as the menu row draws it, and the
// choice sheet's egg mark for an option's `diet`. The word is the accessible name.
const DIET = {
  veg: { label: 'Vegetarian', title: 'Veg', modifier: 'gm-diet--veg' },
  egg: { label: 'Contains egg', title: 'Egg', modifier: 'gm-diet--egg' },
  non_veg: { label: 'Non-vegetarian', title: 'Non-veg', modifier: 'gm-diet--nonveg' },
}
function DietMark({ diet }) {
  const m = DIET[diet]
  if (!m) return null
  return (
    <span role="img" aria-label={m.label} title={m.title} className={`gm-diet ${m.modifier}`}>
      <span aria-hidden="true" />
    </span>
  )
}
const dietOfDish = isVeg => (isVeg === true ? 'veg' : isVeg === false ? 'non_veg' : null)

const signedNpr = n => `${n > 0 ? '+' : '−'}${npr(Math.abs(n))}`
const FOCUSABLE_CHIP = '[role="radio"]:not([disabled]), [role="checkbox"]:not([disabled])'

/**
 * @param {object} props
 * @param {object} props.combo  one entry of get_guest_menu_options' `combos`
 * @param {Record<string, Array>} props.dishGroupsByRecipe  each dish's option groups (groupsForDish)
 * @param {{ optionsById, groupsById }} props.catalog
 * @param {(recipeId: string) => number} props.vatOf  the VAT rate a dish's choices are shown through
 * @param {Array<{ group_id, recipe_id, option_ids }>} [props.initialPicks]  an edit's picks
 * @param {boolean} [props.editing]  opens on Review and says Update
 * @param {(picks: Array<{ group_id, recipe_id, option_ids }>) => void} props.onConfirm
 * @param {{ current: { back: () => boolean } | null }} [props.backRef]  GuestMenu's handle for the phone's Back (S842)
 */
export default function GuestComboSheet({ combo, dishGroupsByRecipe, catalog, vatOf, initialPicks, editing = false, onConfirm, onClose, backRef }) {
  const picks = useMemo(() => comboPicksOf(combo), [combo])
  const groupsOf = rid => dishGroupsByRecipe?.[rid] || []
  const ctx = { optionMaps: catalog, dishGroupsByRecipe, vatOf }
  const comboName = tidyName(combo.name)

  // Captured once: what the sheet opened with, so a backdrop tap can tell "looked" from "picked".
  const [initial] = useState(() => {
    const chosen = {}
    const opts = {}
    for (const g of picks) {
      const given = (initialPicks || []).find(p => p.group_id === g.id)
      const rid = given && g.items.some(it => it.recipe_id === given.recipe_id) ? given.recipe_id : defaultDishOf(g)
      chosen[g.id] = rid
      if (rid) {
        opts[`${g.id}|${rid}`] = given && given.recipe_id === rid
          ? [...(given.option_ids || [])]
          : defaultSelection(dishGroupsByRecipe?.[rid] || [])
      }
    }
    return { chosen, opts }
  })
  const [chosen, setChosen] = useState(initial.chosen)
  // A dish's choices are kept per pick AND dish, so going back to a dish brings its choices back.
  const [opts, setOpts] = useState(initial.opts)
  const optsFor = (gid, rid) => opts[`${gid}|${rid}`] ?? defaultSelection(groupsOf(rid))

  const current = picks.map(g => ({
    group_id: g.id, recipe_id: chosen[g.id] || null, option_ids: chosen[g.id] ? optsFor(g.id, chosen[g.id]) : [],
  }))
  const initialList = picks.map(g => ({
    group_id: g.id, recipe_id: initial.chosen[g.id] || null,
    option_ids: initial.chosen[g.id] ? (initial.opts[`${g.id}|${initial.chosen[g.id]}`] || []) : [],
  }))
  const dirty = comboCartKey(combo.id, current) !== comboCartKey(combo.id, initialList)
  const price = Math.round(comboUnitPrice(combo, current, ctx))

  // A pick asks a question when it offers more than one dish, or its one dish has choices of its own.
  const steps = useMemo(
    () => picks.filter(g => g.items.length > 1 || (dishGroupsByRecipe?.[g.items[0]?.recipe_id] || []).length > 0),
    [picks, dishGroupsByRecipe],
  )
  // An edit, and a set meal that asks nothing, open on Review.
  const startStep = editing ? steps.length : 0
  const [step, setStep] = useState(startStep)
  const [returnToReview, setReturnToReview] = useState(false)
  const [tried, setTried] = useState(false)
  const onReview = step >= steps.length
  const stepPick = onReview ? null : steps[step]
  const groupRefs = useRef({})
  const stepHeadRef = useRef(null)

  useEffect(() => {
    const el = stepHeadRef.current
    if (!el) return
    el.focus({ preventScroll: true })
    const panel = el.closest('.modal-sheet')
    if (panel) panel.scrollTop = 0
  }, [step])

  /** What still stops this pick: no dish chosen, or its dish's choices short of a rule. */
  function problemOf(g) {
    const rid = chosen[g.id]
    if (!rid) return { group: g, kind: 'dish' }
    const p = selectionProblems(groupsOf(rid), optsFor(g.id, rid))[0]
    return p ? { group: g, kind: 'choice', problem: p } : null
  }
  const stepProblem = stepPick ? problemOf(stepPick) : null

  function focusProblem(p) {
    const key = p.kind === 'dish' ? p.group.id : `${p.group.id}|${p.problem.group.id}`
    const el = groupRefs.current[key]
    const chip = el?.querySelector(FOCUSABLE_CHIP)
    ;(chip || el)?.focus({ preventScroll: true })
  }

  function goNext() {
    if (stepProblem) { setTried(true); focusProblem(stepProblem); return }
    setTried(false)
    if (returnToReview) { setReturnToReview(false); setStep(steps.length); return }
    setStep(s => Math.min(s + 1, steps.length))
  }

  function confirmFromReview() {
    const first = picks.map(problemOf).find(Boolean)
    if (first) {
      const idx = steps.findIndex(g => g.id === first.group.id)
      setTried(true)
      setReturnToReview(true)
      setStep(idx < 0 ? 0 : idx)
      return
    }
    onConfirm(current.map(p => ({ ...p, option_ids: [...p.option_ids] })))
  }

  // ── The phone's Back (S842) ── true = taken, the sheet stays; false = nothing to lose, close it.
  const leave = useLeaveConfirm()
  function handleBack() {
    if (leave.open) { leave.keep(); return true }
    if (returnToReview) { setTried(false); setReturnToReview(false); setStep(steps.length); return true }
    if (step > 0 && step !== startStep) { setTried(false); setStep(s => s - 1); return true }
    if (dirty) { leave.ask(); return true }
    return false
  }
  useImperativeHandle(backRef, () => ({ back: handleBack }))

  function chooseDish(gid, rid) {
    setChosen(prev => ({ ...prev, [gid]: rid }))
  }

  // The dish sheet's toggle (GuestOptionSheet), on this pick's dish.
  function toggle(gid, rid, dishGroupId, rule, optionId) {
    const key = `${gid}|${rid}`
    setOpts(prev => {
      const cur = prev[key] ?? defaultSelection(groupsOf(rid))
      const groupOptions = groupsOf(rid).find(d => d.group.id === dishGroupId)?.options || []
      const inGroup = new Set(groupOptions.map(o => o.id))
      const has = cur.includes(optionId)
      let next
      if (rule.max === 1) {
        const others = cur.filter(id => !inGroup.has(id))
        next = has ? (rule.min >= 1 ? cur : others) : [...others, optionId]
      } else if (has) {
        next = cur.filter(id => id !== optionId)
      } else {
        // S809 4h (Q20 a): a "No …" removal takes no place under the maximum.
        const real = groupOptions.filter(o => !o.is_removal && cur.includes(o.id)).length
        const isRemoval = groupOptions.some(o => o.id === optionId && o.is_removal)
        next = (!isRemoval && rule.max != null && real >= rule.max) ? cur : [...cur, optionId]
      }
      return next === cur ? prev : { ...prev, [key]: next }
    })
  }

  const addLabel = `${editing ? 'Update' : 'Add to order'} · ${npr(price)}`
  const nextLabel = `${returnToReview ? 'Back to review' : 'Next'} · ${npr(price)}`

  const problemText = p => {
    if (p.kind === 'dish') return `Choose one from ${tidyName(p.group.name)}.`
    const q = p.problem
    return q.rule.min > q.count
      ? `Choose ${q.rule.min - q.count} more from ${tidyName(q.group.name)}.`
      : `Too many chosen in ${tidyName(q.group.name)}. Remove ${q.real - q.rule.max}.`
  }

  return (
    <Modal variant="sheet" title={comboName} onClose={onClose} dirty={dirty}>
      <div className="gm-sheet-head gm-sheet-head--dish">
        <div className="gm-sheet-head-row">
          <div style={{ minWidth: 0 }}>
            <h2 className="gm-sheet-title">{comboName}</h2>
            {combo.description && <p className="gm-sheet-sub">{combo.description}</p>}
          </div>
          <button type="button" className="btn btn-ghost btn-icon gm-close" onClick={onClose} aria-label="Close" title="Close">
            <X size={20} aria-hidden="true" />
          </button>
        </div>
        {steps.length > 0 && (
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
        <ul className="gm-review" aria-label={`Your ${comboName}`}>
          {picks.map(g => {
            const rid = chosen[g.id]
            const it = g.items.find(x => x.recipe_id === rid)
            const extra = Number(it?.extra_price) || 0
            const choices = rid ? pickChoices({ recipe_id: rid, option_ids: optsFor(g.id, rid) }, ctx) : null
            const asks = steps.some(s => s.id === g.id)
            const choiceDelta = choices ? Math.round(choices.incl) : 0
            return (
              <li key={g.id} className="gm-review-row">
                <div style={{ minWidth: 0, flex: 1 }}>
                  <span className="gm-review-group">{tidyName(g.name)}</span>
                  {!it ? (
                    <span className="gm-review-none">Not chosen yet</span>
                  ) : (
                    <>
                      <span className="gm-review-pick">
                        <span style={{ minWidth: 0 }}>
                          {dietOfDish(it.is_veg) && <><DietMark diet={dietOfDish(it.is_veg)} />{' '}</>}
                          {tidyName(it.name)}
                        </span>
                        <span className="gm-review-price">{extra > 0 ? `+${npr(extra)}` : 'Included'}</span>
                      </span>
                      {choices?.summary && (
                        <span className="gm-review-pick">
                          <span style={{ minWidth: 0 }}>{tidyName(choices.summary)}</span>
                          <span className="gm-review-price">{choiceDelta === 0 ? '' : signedNpr(choiceDelta)}</span>
                        </span>
                      )}
                    </>
                  )}
                </div>
                {asks && (
                  <button type="button" className="btn btn-ghost btn-sm gm-review-change"
                    aria-label={`Change ${tidyName(g.name)}`}
                    onClick={() => { setTried(false); setReturnToReview(true); setStep(steps.findIndex(s => s.id === g.id)) }}>Change</button>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {stepPick && (
        <PickStep
          pick={stepPick}
          chosenId={chosen[stepPick.id]}
          optionIds={chosen[stepPick.id] ? optsFor(stepPick.id, chosen[stepPick.id]) : []}
          dishGroups={chosen[stepPick.id] ? groupsOf(chosen[stepPick.id]) : []}
          catalog={catalog}
          vat={chosen[stepPick.id] && vatOf ? vatOf(chosen[stepPick.id]) : 0}
          tried={tried}
          problem={stepProblem}
          groupRefs={groupRefs}
          onChooseDish={rid => chooseDish(stepPick.id, rid)}
          onToggle={(dishGroupId, rule, optionId) => toggle(stepPick.id, chosen[stepPick.id], dishGroupId, rule, optionId)}
        />
      )}

      <div className="gm-sheet-foot">
        {leave.open ? (
          <LeaveConfirm leave={leave} editing={editing} onLeave={onClose} />
        ) : (
          <>
            {tried && stepProblem && <p role="alert" className="gm-error">{problemText(stepProblem)}</p>}
            <div className="gm-sheet-foot-row">
              {step > 0 && !returnToReview && (
                <button type="button" className="btn btn-ghost gm-sheet-back"
                  onClick={() => { setTried(false); setStep(s => Math.max(0, s - 1)) }}>Back</button>
              )}
              {onReview ? (
                <button type="button" ref={leave.returnRef} className="btn btn-primary gm-sheet-primary" onClick={confirmFromReview}>
                  {addLabel}
                </button>
              ) : (
                <button type="button" ref={leave.returnRef} className="btn btn-primary gm-sheet-primary"
                  aria-disabled={!!stepProblem} onClick={goNext}>
                  {nextLabel}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}

// One pick's step: its dishes as one radio group (or the one dish, included), then the picked dish's
// own choice groups, drawn as the dish sheet draws them.
function PickStep({ pick, chosenId, optionIds, dishGroups, catalog, vat, tried, problem, groupRefs, onChooseDish, onToggle }) {
  const single = pick.items.length === 1
  const labelId = `gc-pick-${pick.id}`
  const dish = pick.items.find(it => it.recipe_id === chosenId)
  const attachByGroup = useMemo(() => Object.fromEntries(dishGroups.map(d => [d.group.id, d.attachment])), [dishGroups])
  const desc = useMemo(() => describeSelection(optionIds, { ...catalog, attachByGroup }), [optionIds, catalog, attachByGroup])
  const freeIds = useMemo(() => new Set(desc.options.filter(o => o.included).map(o => o.option_id)), [desc])
  const problems = selectionProblems(dishGroups, optionIds)
  const priceAt = (o, group) => Math.round(inclFromEx(scaledDelta(o, group, desc.portion_factor), vat))
  const dishShort = tried && problem?.kind === 'dish'

  return (
    <div className="gm-groups">
      {single ? (
        <div className="gm-group" ref={el => { groupRefs.current[pick.id] = el }} tabIndex={-1}>
          <div className="gm-group-head">
            <span id={labelId} className="gm-group-name">{tidyName(pick.name)}</span>
            <span className="gm-group-rule">Included</span>
          </div>
          <p className="gm-review-pick">
            <span style={{ minWidth: 0 }}>
              {dietOfDish(pick.items[0].is_veg) && <><DietMark diet={dietOfDish(pick.items[0].is_veg)} />{' '}</>}
              {tidyName(pick.items[0].name)}
            </span>
            {Number(pick.items[0].extra_price) > 0 && <span className="gm-review-price">+{npr(Number(pick.items[0].extra_price))}</span>}
          </p>
        </div>
      ) : (
        <div
          ref={el => { groupRefs.current[pick.id] = el }}
          tabIndex={-1} role="radiogroup" aria-labelledby={labelId}
          onKeyDown={e => moveRovingFocus(e, '[role="radio"]')}
          className="gm-group"
        >
          <div className="gm-group-head">
            <span id={labelId} className="gm-group-name">{tidyName(pick.name)}</span>
            <span className={`gm-group-rule${dishShort ? ' is-short' : ''}`}>
              <span className="gm-required">Required</span>
              Pick 1
            </span>
          </div>
          <div className="gm-options">
            {pick.items.map((it, i) => {
              const on = it.recipe_id === chosenId
              const extra = Number(it.extra_price) || 0
              const diet = dietOfDish(it.is_veg)
              return (
                <button
                  key={it.recipe_id} type="button" role="radio" aria-checked={on}
                  tabIndex={rovingTabIndex(on || (!chosenId && i === 0))}
                  onClick={() => onChooseDish(it.recipe_id)}
                  className="gm-chip gm-option"
                >
                  <span aria-hidden="true" className="gm-option-mark gm-option-mark--radio" />
                  <span className="gm-option-body">
                    <span className={`gm-option-name${on ? ' is-on' : ''}`}>{tidyName(it.name)}</span>
                    {diet && <span className="gm-option-meta"><DietMark diet={diet} /></span>}
                  </span>
                  {extra > 0 && <span className="gm-option-price">+{npr(extra)}</span>}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {dish && dishGroups.map(({ group, rule, options }) => {
        const singleChoice = rule.max === 1
        const picked = options.filter(o => optionIds.includes(o.id))
        const realCount = picked.filter(o => !o.is_removal).length
        const short = tried && problems.some(p => p.group.id === group.id)
        const groupLabelId = `gc-opt-${pick.id}-${group.id}`
        const usedFree = picked.filter(o => freeIds.has(o.id)).length
        const pricedLeft = options.some(o => !optionIds.includes(o.id) && !o.is_removal && priceAt(o, group) !== 0)
        const anyChecked = picked.length > 0
        return (
          <div
            key={group.id}
            ref={el => { groupRefs.current[`${pick.id}|${group.id}`] = el }}
            tabIndex={-1}
            role={singleChoice ? 'radiogroup' : 'group'} aria-labelledby={groupLabelId}
            onKeyDown={e => moveRovingFocus(e, singleChoice ? '[role="radio"]' : '[role="checkbox"]')}
            className="gm-group"
          >
            <div className="gm-group-head">
              <span id={groupLabelId} className="gm-group-name">{tidyName(dish.name)}: {tidyName(group.name)}</span>
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
                const on = optionIds.includes(o.id)
                const full = !on && !o.is_removal && rule.max != null && !singleChoice && realCount >= rule.max
                const d = priceAt(o, group)
                const free = on && freeIds.has(o.id) && d !== 0
                const allergens = Array.isArray(o.allergens) ? o.allergens : []
                return (
                  <button
                    key={o.id} type="button"
                    role={singleChoice ? 'radio' : 'checkbox'} aria-checked={on}
                    disabled={full} aria-disabled={full || undefined}
                    tabIndex={singleChoice ? rovingTabIndex(on || (!anyChecked && i === 0)) : 0}
                    onClick={() => onToggle(group.id, rule, o.id)}
                    className="gm-chip gm-option"
                  >
                    <span aria-hidden="true" className={`gm-option-mark ${singleChoice ? 'gm-option-mark--radio' : 'gm-option-mark--check'}`}>
                      {!singleChoice && on && <Check size={14} strokeWidth={3} />}
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
      })}
    </div>
  )
}
