import { useMemo, useRef, useState } from 'react'
import Modal from '../../components/Modal'
import { npr } from '../../shared/nepalMoney'
import {
  describeSelection, selectionProblems, defaultSelection, inclFromEx, signedPrice, STANDARD_VAT,
} from '../../shared/optionPricing'
import { offeredPicks } from '../../shared/offeredPicks'
import { moveRovingFocus, rovingTabIndex } from '../../shared/rovingFocus'
import OptionPickerModal from './OptionPickerModal'

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

const lower = v => (v == null ? '' : String(v).toLowerCase())
const bySort = (a, b) => ((Number(a.sort) || 0) - (Number(b.sort) || 0)) || (lower(a.id) < lower(b.id) ? -1 : lower(a.id) > lower(b.id) ? 1 : 0)
const attachOf = dishGroups => Object.fromEntries((dishGroups || []).map(d => [d.group.id, d.attachment]))

export default function ComboPickerModal({
  combo, recipeOf, vatReg = true, dishGroupsOf = () => undefined, catalog = {},
  initialPicks = null, onlyGroupId = null, initialQty = 1, showQty = true,
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
  const [qty, setQty] = useState(() => Math.max(1, Number(initialQty) || 1))
  const [tried, setTried] = useState(false)
  const [choicesFor, setChoicesFor] = useState(null)
  const sectionRefs = useRef({})
  const dirty = picks !== start

  const describeFor = (rid, ids) => {
    const dg = dishGroupsOf(rid)
    if (!dg || !(ids || []).length) return null
    return describeSelection(ids, { ...catalog, attachByGroup: attachOf(dg) })
  }
  // What a guest pays for this pick on top of the combo price: the dish's extra and its choices.
  const pickCharge = g => {
    const p = picks[g.id]
    if (!p?.recipe_id) return 0
    const item = g.items.find(i => i.recipe_id === p.recipe_id)
    const desc = describeFor(p.recipe_id, p.option_ids)
    return (Number(item?.extra_price) || 0) + (desc ? inclFromEx(desc.delta, vatOfDish(p.recipe_id)) : 0)
  }
  const unit = (Number(combo?.guest_price) || 0) + groups.reduce((s, g) => s + pickCharge(g), 0)

  // What still needs an answer, per shown pick: a dish, or a choice the dish requires.
  const problemOf = g => {
    const p = picks[g.id]
    if (!p?.recipe_id) return `Pick one from ${g.name}.`
    const dg = dishGroupsOf(p.recipe_id)
    if (!dg) return null
    const first = selectionProblems(dg, p.option_ids || [])[0]
    if (!first) return null
    const name = recipeOf(p.recipe_id)?.name || 'this dish'
    return first.count < (Number(first.rule?.min) || 0)
      ? `Choose ${first.rule.min - first.count} more from ${first.group.name} for ${name}. Tap Choices.`
      : `Too many picked in ${first.group.name} for ${name}. Tap Choices.`
  }
  const problems = shown.map(g => ({ g, text: problemOf(g) })).filter(x => x.text)

  function choose(g, recipeId) {
    setPicks(prev => {
      if (prev[g.id]?.recipe_id === recipeId) return prev
      return { ...prev, [g.id]: { recipe_id: recipeId, option_ids: defaultIdsOf(recipeId) } }
    })
  }

  function confirm() {
    if (problems.length) {
      setTried(true)
      const el = sectionRefs.current[problems[0].g.id]
      if (el) {
        el.scrollIntoView?.({ block: 'center' })
        const target = el.querySelector('[role="radio"][aria-checked="true"], [role="radio"], button')
        ;(target || el).focus?.()
      }
      return
    }
    onConfirm({
      picks: groups.map(g => ({ group_id: g.id, recipe_id: picks[g.id]?.recipe_id || null, option_ids: picks[g.id]?.option_ids || [] })),
      qty: showQty ? qty : Math.max(1, Number(initialQty) || 1),
    })
  }

  const choicesGroup = choicesFor ? groups.find(g => g.id === choicesFor) : null
  const choicesPick = choicesGroup ? picks[choicesGroup.id] : null
  const choicesRecipe = choicesPick ? recipeOf(choicesPick.recipe_id) : null
  const title = onlyGroupId && shown[0] ? `${combo.name}: ${shown[0].name}` : combo?.name || 'Combo'

  return (
    <>
      <Modal onClose={onClose} title={title} maxWidth={560} zIndex={zIndex} dirty={dirty}
        panelStyle={{ maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: 18, paddingRight: 2 }}>
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
            const choiceCharge = desc ? Math.round(inclFromEx(desc.delta, vatOfDish(p.recipe_id))) : 0
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
                    <button type="button" className="btn btn-ghost btn-sm till-hit--row"
                      aria-label={`Choices for ${dishName}`} onClick={() => setChoicesFor(g.id)}>Choices</button>
                  </div>
                )}
                {problem && <p role="alert" className="field-error" style={{ margin: '6px 0 0' }}>{problem}</p>}
              </section>
            )
          })}
        </div>

        <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10, borderTop: '1px solid var(--theme-border)', paddingTop: 12, marginTop: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 160 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--theme-text1)' }} data-testid="combo-picker-total">
              {npr(unit * (showQty ? qty : 1))}
              {showQty && qty > 1 && (
                <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--theme-text3)', marginLeft: 6 }}>{npr(unit)} × {qty}</span>
              )}
            </div>
            <div style={{ fontSize: 12, color: 'var(--theme-text3)' }}>
              {onlyGroupId ? 'The combo with this dish' : 'The combo price, with any extra charge picked'}
            </div>
          </div>
          {showQty && (
            <div role="group" aria-label="Quantity" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <button type="button" className="btn btn-ghost till-hit" onClick={() => setQty(q => Math.max(1, q - 1))}
                disabled={qty <= 1} aria-label={`One fewer ${combo?.name || 'combo'}`}>−</button>
              <span aria-live="polite" style={{ minWidth: 28, textAlign: 'center', fontWeight: 700, fontSize: 15, color: 'var(--theme-text1)' }}>{qty}</span>
              <button type="button" className="btn btn-ghost till-hit" onClick={() => setQty(q => q + 1)}
                aria-label={`One more ${combo?.name || 'combo'}`}>+</button>
            </div>
          )}
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={confirm} aria-disabled={problems.length > 0}>{confirmLabel}</button>
        </div>
      </Modal>

      {/* The picked dish's own choices, in the ordinary choice window, above this one. Its price line
          reads the choices' charge alone (the dish is priced by the combo); its quantity is the combo's,
          so it shows no stepper of its own. */}
      {choicesGroup && choicesRecipe && (
        <OptionPickerModal
          recipe={{ ...choicesRecipe, name: `${choicesRecipe.name} (in ${combo.name})`, selling_price: 0 }}
          dishGroups={dishGroupsOf(choicesPick.recipe_id) || []}
          catalog={catalog}
          vatRate={vatOfDish(choicesPick.recipe_id)}
          initialIds={choicesPick.option_ids}
          confirmLabel="Use these choices"
          showQty={false}
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
