import { useMemo, useRef, useState } from 'react'
import Modal from '../../components/Modal'
import { npr } from '../../shared/nepalMoney'
import {
  describeSelection, selectionProblems, defaultSelection, inclFromEx, signedPrice, STANDARD_VAT,
} from '../../shared/optionPricing'
import { offeredPicks } from '../../shared/offeredPicks'
import { moveRovingFocus, rovingTabIndex } from '../../shared/rovingFocus'
import OptionPickerModal, { PICKER_PANEL_STYLE } from './OptionPickerModal'

// Combos (S839, docs/pos-combos.md): the till's window for a combo whose picks need an answer — a
// pick-your-own deal, or a set meal whose dish needs a choice of its own. One section per pick, a
// radio list of its dishes with each one's extra charge, the default preselected. A picked dish that
// has option groups takes its own choices (owner decision 2026-10-14: charged on top), through the
// ordinary choice window.
//
// The same window swaps one dish of a combo already on the order (`onlyGroupId`): it lists that
// pick's dishes only, starting from the dish it holds now (`initialPicks`), and has no quantity.
//
// Every price here is a display twin: the combo's price plus the picked extras and choices, as the
// guest pays them. save_pos_order_items prices each dish of the combo itself from today's split.
// `onConfirm({ picks: [{ group_id, recipe_id, option_ids }], qty })` — every pick, the shown ones
// as answered here, the others as they started.
//
// S863 (till audit): a Swap is told the combo's quantity (`initialQty` with `showQty={false}`), since
// the swap changes the dish in every unit of the combo, and the footer says so ("Both (×2) get this
// dish") beside the total for all of them. Picking a dish whose required choice has no default opens
// that dish's choices at once. Each part and the total are shown in whole rupees from the same
// figures, so the parts on screen add up to the total under them. A stray backdrop tap no longer
// drops the picks or the quantity.

const lower = v => (v == null ? '' : String(v).toLowerCase())
const bySort = (a, b) => ((Number(a.sort) || 0) - (Number(b.sort) || 0)) || (lower(a.id) < lower(b.id) ? -1 : lower(a.id) > lower(b.id) ? 1 : 0)
const attachOf = dishGroups => Object.fromEntries((dishGroups || []).map(d => [d.group.id, d.attachment]))
const sameIds = (a, b) => {
  const x = (a || []).map(String).sort()
  const y = (b || []).map(String).sort()
  return x.length === y.length && x.every((v, i) => v === y[i])
}

export default function ComboPickerModal({
  combo, recipeOf, vatReg = true, dishGroupsOf = () => undefined, catalog = {},
  initialPicks = null, onlyGroupId = null, initialQty = 1, showQty = true, soldLines = null, swapShare = null,
  confirmLabel = 'Add to order', onConfirm, onClose, zIndex = 1100,
}) {
  const groups = useMemo(() => [...(combo?.groups || [])].sort(bySort), [combo])
  const shown = onlyGroupId ? groups.filter(g => lower(g.id) === lower(onlyGroupId)) : groups
  const vatOfDish = rid => {
    if (!vatReg) return 0
    const r = recipeOf(rid)
    return r?.vat_rate === null || r?.vat_rate === undefined ? STANDARD_VAT : Number(r.vat_rate) || 0
  }
  const defaultIdsOf = rid => {
    const dg = dishGroupsOf(rid)
    return dg ? defaultSelection(dg) : []
  }

  // { [groupId]: { recipe_id, option_ids } | null }. Started from the dishes given (a Swap, the dish the
  // pick holds now, its choices cut to those still offered); else each pick's default dish with its
  // default choices. A given dish the pick no longer offers starts unpicked, so nothing is swapped unseen.
  const [start] = useState(() => {
    const out = {}
    for (const g of groups) {
      const given = (initialPicks || []).find(p => lower(p.group_id) === lower(g.id))
      if (initialPicks) {
        out[g.id] = given && g.items.some(i => i.recipe_id === given.recipe_id)
          ? { recipe_id: given.recipe_id, option_ids: offeredPicks(given.option_ids || [], dishGroupsOf(given.recipe_id)).kept }
          : null
        continue
      }
      const d = g.items.find(i => i.is_default) || g.items[0]
      out[g.id] = d ? { recipe_id: d.recipe_id, option_ids: defaultIdsOf(d.recipe_id) } : null
    }
    return out
  })
  const [picks, setPicks] = useState(start)
  const [startQty] = useState(() => Math.max(1, Number(initialQty) || 1))
  const [qty, setQty] = useState(startQty)
  const [tried, setTried] = useState(false)
  const [choicesFor, setChoicesFor] = useState(null)
  const sectionRefs = useRef({})
  // Chip taps fire neither input nor change, so Modal's own guard never turns on: say it outright.
  const dirty = picks !== start || (showQty && qty !== startQty)
  // Without a stepper the quantity is the caller's: a Swap's is the combo's own, every unit of which
  // takes the new dish.
  const fixedQty = Math.max(1, Number(initialQty) || 1)
  const shownQty = showQty ? qty : fixedQty

  const describeFor = (rid, ids) => {
    const dg = dishGroupsOf(rid)
    if (!dg || !(ids || []).length) return null
    return describeSelection(ids, { ...catalog, attachByGroup: attachOf(dg) })
  }
  // A dish's choices as the guest pays for them, in the whole rupees the section line shows.
  const choiceChargeOf = (rid, desc) => (desc ? Math.round(inclFromEx(desc.delta, vatOfDish(rid))) : 0)
  // What a guest pays for this pick on top of the combo price: the dish's extra and its choices. Each
  // part is rounded as it is shown (the chip, the section line), so the total is the sum of what the
  // waiter can see (S863). Display only: save_pos_order_items prices every dish itself.
  const pickCharge = g => {
    const p = picks[g.id]
    if (!p?.recipe_id) return 0
    const item = g.items.find(i => i.recipe_id === p.recipe_id)
    return Math.round(Number(item?.extra_price) || 0) + choiceChargeOf(p.recipe_id, describeFor(p.recipe_id, p.option_ids))
  }
  // S864: a Swap prices from the bill, as save_pos_order_items does. Every other dish of the combo keeps
  // the price it was rung at (`soldLines`), and the dish swapped in takes the replaced dish's share
  // (`swapShare`) plus its own extra and choices at today's prices. Re-picking the dish it holds, with
  // the same choices, shows the bill's own figure. Without the basis (an older caller) the combo's
  // price plus every pick's charge, as before.
  const swapUnit = (() => {
    const g = onlyGroupId ? shown[0] : null
    if (!g || !soldLines || swapShare == null) return null
    const gid = lower(g.id)
    const others = soldLines.filter(l => lower(l.group_id) !== gid).reduce((s, l) => s + (Number(l.incl) || 0), 0)
    const own = soldLines.find(l => lower(l.group_id) === gid)
    const p = picks[g.id]
    const s0 = start[g.id]
    if (own && p && s0 && p.recipe_id === s0.recipe_id && sameIds(p.option_ids, s0.option_ids)) {
      return Math.round(others + (Number(own.incl) || 0))
    }
    return Math.round(others + Number(swapShare)) + pickCharge(g)
  })()
  const unit = swapUnit ?? Math.round(Number(combo?.guest_price) || 0) + groups.reduce((s, g) => s + pickCharge(g), 0)

  // What still needs an answer, per shown pick: a dish (`kind: 'dish'`), or a choice the dish
  // requires (`kind: 'choice'`).
  const problemOf = g => {
    const p = picks[g.id]
    if (!p?.recipe_id) return { kind: 'dish', text: `Pick one from ${g.name}.` }
    const dg = dishGroupsOf(p.recipe_id)
    if (!dg) return null
    const first = selectionProblems(dg, p.option_ids || [])[0]
    if (!first) return null
    const name = recipeOf(p.recipe_id)?.name || 'this dish'
    return {
      kind: 'choice',
      text: first.count < (Number(first.rule?.min) || 0)
        ? `Choose ${first.rule.min - first.count} more from ${first.group.name} for ${name}. Tap Choices.`
        : `Too many picked in ${first.group.name} for ${name}. Tap Choices.`,
    }
  }
  const problems = shown.map(g => ({ g, ...problemOf(g) })).filter(x => x.text)

  function choose(g, recipeId) {
    if (picks[g.id]?.recipe_id === recipeId) return
    const ids = defaultIdsOf(recipeId)
    setPicks(prev => ({ ...prev, [g.id]: { recipe_id: recipeId, option_ids: ids } }))
    // S863: a dish whose required choice has no default opens its choices at once, rather than
    // leaving the waiter to notice the line under it and tap Choices.
    const dg = dishGroupsOf(recipeId)
    if (dg && selectionProblems(dg, ids).length) setChoicesFor(g.id)
  }

  // A selector list answers in DOCUMENT order, not in the order it is written, so one query put the
  // section's first chip ahead of its checked one and of its Choices button. Asked one at a time.
  function focusProblem({ g, kind }) {
    const el = sectionRefs.current[g.id]
    if (!el) return
    el.scrollIntoView?.({ block: 'center' })
    const order = kind === 'choice'
      ? ['[data-combo-choices]', '[role="radio"][aria-checked="true"]', '[role="radio"]']
      : ['[role="radio"][aria-checked="true"]', '[role="radio"]']
    const target = order.map(sel => el.querySelector(sel)).find(Boolean)
    ;(target || el).focus?.()
  }

  function confirm() {
    if (problems.length) {
      setTried(true)
      focusProblem(problems[0])
      return
    }
    onConfirm({
      picks: groups.map(g => ({ group_id: g.id, recipe_id: picks[g.id]?.recipe_id || null, option_ids: picks[g.id]?.option_ids || [] })),
      qty: shownQty,
    })
  }

  const choicesGroup = choicesFor ? groups.find(g => g.id === choicesFor) : null
  const choicesPick = choicesGroup ? picks[choicesGroup.id] : null
  const choicesRecipe = choicesPick ? recipeOf(choicesPick.recipe_id) : null
  const title = onlyGroupId && shown[0] ? `${combo.name}: ${shown[0].name}` : combo?.name || 'Combo'
  const footNote = !onlyGroupId
    ? 'The combo price, with any extra charge picked'
    : shownQty === 1 ? 'The combo with this dish'
      : shownQty === 2 ? 'Both (×2) get this dish'
        : `All ${shownQty} (×${shownQty}) get this dish`

  return (
    <>
      <Modal onClose={onClose} title={title} maxWidth={560} zIndex={zIndex} dirty={dirty}
        panelStyle={PICKER_PANEL_STYLE}>
        <div className="picker-body">
          {!onlyGroupId && combo?.description && (
            <p style={{ margin: 0, fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.45 }}>{combo.description}</p>
          )}
          {onlyGroupId && (
            <p style={{ margin: 0, fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.45 }}>
              Pick the dish this guest wants instead. The rest of the combo stays as it is. A dish already sent to the
              kitchen or bar is taken off with a reason, and the new one goes on the next ticket.
            </p>
          )}
          {shown.map(g => {
            const labelId = `combo-pick-${g.id}`
            const p = picks[g.id]
            const anyChecked = !!p?.recipe_id
            const dg = p?.recipe_id ? dishGroupsOf(p.recipe_id) : null
            const desc = p?.recipe_id ? describeFor(p.recipe_id, p.option_ids) : null
            const choiceCharge = desc ? choiceChargeOf(p.recipe_id, desc) : 0
            const problem = tried ? problems.find(x => x.g.id === g.id)?.text : null
            const dishName = p?.recipe_id ? recipeOf(p.recipe_id)?.name || 'this dish' : ''
            return (
              <section key={g.id} ref={el => { sectionRefs.current[g.id] = el }} tabIndex={-1} style={{ outline: 'none' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                  <span id={labelId} style={{ fontWeight: 700, fontSize: 14, color: 'var(--theme-text1)' }}>{g.name}</span>
                  <span style={{ fontSize: 12, color: problem ? 'var(--theme-red-text)' : 'var(--theme-text3)' }}>
                    {g.items.length === 1 ? 'Comes with' : 'Pick one'}
                  </span>
                </div>
                <div role="radiogroup" aria-labelledby={labelId}
                  onKeyDown={e => moveRovingFocus(e, '[role="radio"]')}
                  style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 8 }}>
                  {g.items.map((it, i) => {
                    const r = recipeOf(it.recipe_id)
                    const on = p?.recipe_id === it.recipe_id
                    const extra = signedPrice(it.extra_price)
                    const meta = [extra || null, dishGroupsOf(it.recipe_id) ? 'Choices' : null].filter(Boolean)
                    return (
                      <button key={it.id || it.recipe_id} type="button" className="choice-chip"
                        role="radio" aria-checked={on}
                        tabIndex={rovingTabIndex(on || (!anyChecked && i === 0))}
                        onClick={() => choose(g, it.recipe_id)}>
                        <span className="choice-chip__name">{r?.name || 'Dish'}</span>
                        {meta.length > 0 && (
                          <span className="choice-chip__meta">{meta.map((m, n) => <span key={n}>{n > 0 ? ' · ' : ''}{m}</span>)}</span>
                        )}
                      </button>
                    )
                  })}
                </div>
                {dg && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                    <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: 'var(--theme-text2)', lineHeight: 1.4 }}>
                      {dishName}: {desc?.summary || 'no choices picked'}{choiceCharge ? ` · ${signedPrice(choiceCharge)}` : ''}
                    </span>
                    <button type="button" className="btn btn-ghost btn-sm till-hit--row" data-combo-choices
                      aria-label={`Choices for ${dishName}`} onClick={() => setChoicesFor(g.id)}>Choices</button>
                  </div>
                )}
                {problem && <p role="alert" className="field-error" style={{ margin: '6px 0 0' }}>{problem}</p>}
              </section>
            )
          })}
        </div>

        <div className="picker-footer">
          <div className="picker-footer__total">
            <div className="picker-footer__price" data-testid="combo-picker-total">
              {npr(unit * shownQty)}
              {shownQty > 1 && <span className="picker-footer__each">{npr(unit)} × {shownQty}</span>}
            </div>
            <div className="picker-footer__note">{footNote}</div>
          </div>
          {showQty && (
            <div role="group" aria-label="Quantity" className="picker-qty">
              {/* aria-disabled, not disabled, at 1: a disabled button drops the focus of the finger or
                  key that just pressed it to the top of the page. The press does nothing there. */}
              <button type="button" className="btn btn-ghost till-hit" onClick={() => setQty(q => (q <= 1 ? q : q - 1))}
                aria-disabled={qty <= 1} aria-label={`One fewer ${combo?.name || 'combo'}`}>−</button>
              <span aria-live="polite" className="picker-qty__value">{qty}</span>
              <button type="button" className="btn btn-ghost till-hit" onClick={() => setQty(q => q + 1)}
                aria-label={`One more ${combo?.name || 'combo'}`}>+</button>
            </div>
          )}
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={confirm} aria-disabled={problems.length > 0}>{confirmLabel}</button>
        </div>
      </Modal>

      {/* The picked dish's own choices, in the ordinary choice window, above this one. Its price line
          reads the choices' charge alone (`inCombo`: the dish is priced by the combo); its quantity is
          the combo's, so it shows no stepper of its own. */}
      {choicesGroup && choicesRecipe && (
        <OptionPickerModal
          recipe={{ ...choicesRecipe, name: `${choicesRecipe.name} (in ${combo.name})`, selling_price: 0 }}
          dishGroups={dishGroupsOf(choicesPick.recipe_id) || []}
          catalog={catalog}
          vatRate={vatOfDish(choicesPick.recipe_id)}
          initialIds={choicesPick.option_ids}
          confirmLabel="Use these choices"
          showQty={false}
          inCombo
          zIndex={zIndex + 100}
          onClose={() => setChoicesFor(null)}
          onConfirm={ids => {
            const gid = choicesGroup.id
            setPicks(prev => ({ ...prev, [gid]: { ...prev[gid], option_ids: [...ids].map(String) } }))
            setChoicesFor(null)
          }}
        />
      )}
    </>
  )
}
