import { useMemo, useRef, useState } from 'react'
import Modal from '../../components/Modal'
import Tip from '../../components/Tip'
import FieldError, { fieldAria } from '../../components/FieldError'
import ActionError, { asActionError } from '../../components/ActionError'
import { supabase } from '../../supabaseClient'
import { settleWithin } from '../../utils/withTimeout'
import { isTimeoutError, isNetworkError } from '../../shared/errorText'
import { npr, nprPaisa } from '../../shared/nepalMoney'
import { comboShares } from './comboPricing'
import {
  emptyPick, moveItem, setDefault, setPickDishes, validateCombo, comboPayload, comboForShares,
  sameEditorState, isComboDish, isSetMeal,
} from './comboEditor'
import ComboDishPicker from './ComboDishPicker'

// Create or edit one combo (S839, docs/pos-combos.md). The combo is a price and a list of PICKS; a
// pick is one dish from a short list, each dish with an optional extra charge. A pick with one dish
// is included automatically, so a combo whose every pick has one dish is a set meal.
//
// Nothing here prices a bill: save_pos_combo stores the combo whole and the server splits the price
// over the dishes when one is sold. The split shown per pick is comboShares(), the browser twin of
// pos_combo_shares, so the owner sees what each dish will be recorded at before saving.
//
// The price is what the guest pays (VAT included on a VAT outlet) and is stored as typed, so an
// outlet whose VAT status is still loading only changes the label, never what is saved.
//
// S862 COMBOS-6: a NEW combo whose Save got no answer may have been created, and pressing again is
// then refused as a name already taken. `recheckList(name)` re-reads the list behind the dialog and
// answers whether a combo of that name is in it (null when the read failed), so the dialog can say so
// rather than leave the owner to rename it into a duplicate.

const SAVE_TIMEOUT_MS = 20000

export default function ComboEditorModal({
  initial, isNew, prefilled = false, dishes, recipeById, vatMode, otherNames, clientId, onClose, onSaved, recheckList,
}) {
  const [state, setState] = useState(initial)
  const initialRef = useRef(initial)
  const [tried, setTried] = useState(false) // field messages show once Save has been pressed
  const [saving, setSaving] = useState(false)
  const [actionError, setActionError] = useState(null)
  const [listNote, setListNote] = useState(null) // what the re-read list says after an unclear save
  const [pickerFor, setPickerFor] = useState(null) // pick key

  const vatReg = vatMode !== 'pan'
  const recipeOf = id => recipeById.get(id)
  const dishById = useMemo(() => new Map(dishes.map(d => [d.id, d])), [dishes])
  const guestPriceOf = id => dishById.get(id)?.guestPrice || 0

  const shares = useMemo(
    () => comboShares(comboForShares(state), id => recipeById.get(id), vatReg),
    [state, recipeById, vatReg],
  )
  const priceNum = Number(String(state.price).replace(/,/g, ''))
  const hasPrice = priceNum > 0

  // What the cheapest dish of every pick costs ordered on its own — the comparison an owner prices
  // a combo against. Only when every pick has a priced dish, or the sum would understate it.
  const cheapestEach = state.picks.map(p => {
    const prices = p.items.map(it => guestPriceOf(it.recipe_id)).filter(v => v > 0)
    return prices.length ? Math.min(...prices) : null
  })
  const cheapestApart = cheapestEach.length && cheapestEach.every(v => v != null)
    ? cheapestEach.reduce((a, b) => a + b, 0) : null

  const set = patch => setState(s => ({ ...s, ...patch }))
  const setPick = (key, fn) => setState(s => ({ ...s, picks: s.picks.map(p => (p.key === key ? fn(p) : p)) }))
  const setItem = (pickKey, itemKey, patch) =>
    setPick(pickKey, p => ({ ...p, items: p.items.map(it => (it.key === itemKey ? { ...it, ...patch } : it)) }))

  // Once Save has been pressed the messages follow the edits, so a fixed box clears as it is typed.
  const err = tried ? validateCombo(state, { recipeOf, otherNames }) : { pickName: {}, pickDishes: {}, extra: {} }

  function addPick() {
    const p = emptyPick()
    setState(s => ({ ...s, picks: [...s.picks, p] }))
    // The new pick's name box, once it has rendered.
    setTimeout(() => document.getElementById(`cp-name-${p.key}`)?.focus(), 0)
  }

  async function save() {
    if (saving) return
    const v = validateCombo(state, { recipeOf, otherNames })
    setTried(true)
    if (!v.ok) {
      const firstId = v.name ? 'combo-name'
        : v.price ? 'combo-price'
          : v.picks ? 'combo-add-pick'
            : (() => {
              for (const p of state.picks) {
                if (v.pickName[p.key]) return `cp-name-${p.key}`
                if (v.pickDishes[p.key]) return `cp-dishes-${p.key}`
                const bad = p.items.find(it => v.extra[it.key])
                if (bad) return `cp-extra-${bad.key}`
              }
              return null
            })()
      if (firstId) document.getElementById(firstId)?.focus()
      return
    }
    setSaving(true)
    setActionError(null)
    setListNote(null)
    const { data, error } = await settleWithin(
      supabase.rpc('save_pos_combo', { p_combo: comboPayload(state, clientId) }),
      SAVE_TIMEOUT_MS, 'Saving the combo',
    )
    setSaving(false)
    if (error) {
      setActionError(asActionError(error))
      const unanswered = isTimeoutError(error) || isNetworkError(error)
      const nameTaken = error.hint === 'combo_name_taken' || /combo_name_taken/.test(error.message || '')
      if (isNew && recheckList && (unanswered || nameTaken)) {
        const name = state.name.trim()
        const listed = await recheckList(name)
        if (listed === true) {
          setListNote(unanswered
            ? `“${name}” is now in the combo list behind this window, so this save most likely went through. Close this window and check it there, rather than saving it again under another name.`
            : `A combo named “${name}” is already in the list behind this window. If an earlier Save lost its answer, that is this combo: close this window and check it before giving this one another name.`)
        } else if (listed === false && unanswered) {
          setListNote(`The combo list behind this window was read again and “${name}” is not in it yet. Wait a moment, then check the list before saving again.`)
        }
      }
      return
    }
    onSaved({ id: data, name: state.name.trim(), isNew })
  }

  const pickerPick = pickerFor ? state.picks.find(p => p.key === pickerFor) : null
  const setMeal = isSetMeal(state.picks)
  const priceLabel = `Price the guest pays${vatMode === 'pan' ? ' (no VAT — PAN bill)' : ' (incl. VAT)'}`

  return (
    <Modal onClose={onClose} title={isNew ? 'New combo' : `Edit combo — ${initial.name}`} maxWidth={780}
      panelStyle={{ maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}
      dirty={!sameEditorState(state, initialRef.current)}>
      <div style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 18, paddingRight: 2 }}>
        {prefilled && (
          <p className="note-banner" style={{ margin: 0 }}>
            <strong>Started from Combo Builder.</strong> One pick for each dish, at the suggested price. Add more dishes to a pick to let the guest choose, or save it as it is for a set meal.
          </p>
        )}

        <div className="field-grid">
          <div className="form-field field-grid__wide" style={{ margin: 0 }}>
            <label htmlFor="combo-name">Name</label>
            <input id="combo-name" autoFocus={!prefilled} value={state.name} onChange={e => set({ name: e.target.value })}
              placeholder="e.g. Momo Combo" {...fieldAria('combo-name', err.name)} />
            <FieldError id="combo-name" message={err.name} />
          </div>
          <div className="form-field" style={{ margin: 0 }}>
            <label htmlFor="combo-price">
              <Tip width={300} text={`The one price for the whole combo, as the guest pays it${vatReg ? ', VAT included' : ''}. It is shared out over the dishes on the bill (each pick shows its part below). A dish’s extra charge is added on top.`}>
                {priceLabel}
              </Tip>
            </label>
            <input id="combo-price" type="number" step="any" min="0" inputMode="decimal" value={state.price}
              onChange={e => set({ price: e.target.value })} placeholder="e.g. 350" {...fieldAria('combo-price', err.price)} />
            <FieldError id="combo-price" message={err.price} />
            {cheapestApart != null && hasPrice && (
              <span style={{ fontSize: 12, color: 'var(--theme-text2)' }}>
                Ordered on their own, the cheapest dish of every pick comes to {npr(cheapestApart)}.
              </span>
            )}
          </div>
          <div className="form-field field-grid__wide" style={{ margin: 0 }}>
            <label htmlFor="combo-desc">
              <Tip width={260} text="Shown under the combo’s name on the QR guest menu. Optional.">Description (guest menu)</Tip>
            </label>
            <input id="combo-desc" value={state.description} onChange={e => set({ description: e.target.value })}
              placeholder="e.g. Any momo with a soft drink" />
          </div>
          <div className="field-grid__wide" style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
              <input type="checkbox" checked={state.is_active} onChange={e => set({ is_active: e.target.checked })} />
              <Tip width={260} text="Untick to stop selling it without deleting it. Bills already rung keep it.">On sale on the till</Tip>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
              <input type="checkbox" checked={state.on_guest_menu} onChange={e => set({ on_guest_menu: e.target.checked })} />
              <Tip width={260} text="Guests can order it from the table QR menu, while it is also on sale.">On the QR guest menu</Tip>
            </label>
          </div>
        </div>

        <div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
            <h3 style={{ margin: 0, fontSize: 15 }}>
              <Tip width={320} text="A pick is one dish the guest gets, chosen from the dishes you list in it. A pick with one dish is included automatically — that is how you build a set meal.">Picks</Tip>
            </h3>
            {hasPrice && state.picks.length > 0 && (
              <Tip width={340} text="The combo price is shared over the picks in proportion to each pick’s cheapest dish’s menu price, so reports show each dish’s fair share. Swapping a dish within a pick never moves the others; an extra charge goes to its own dish.">
                <span style={{ fontSize: 12, color: 'var(--theme-text2)' }}>How the price is split</span>
              </Tip>
            )}
          </div>
          {setMeal && (
            <p style={{ margin: '0 0 10px', fontSize: 12, color: 'var(--theme-text2)' }}>
              Set meal: every pick has one dish, so the till adds the whole combo in one tap.
            </p>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {state.picks.map((p, pi) => {
              const share = shares[p.key]
              const defaultKey = p.items.find(it => it.is_default)?.key || null
              const multi = p.items.length > 1
              const pickLabel = p.name.trim() || `pick ${pi + 1}`
              return (
                <section key={p.key} aria-label={`Pick ${pi + 1}`}
                  style={{ border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-md)', padding: 12 }}>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 10 }}>
                    <div className="form-field" style={{ margin: 0, flex: '1 1 220px' }}>
                      <label htmlFor={`cp-name-${p.key}`}>Pick {pi + 1}</label>
                      <input id={`cp-name-${p.key}`} value={p.name} placeholder="e.g. Pick a momo"
                        onChange={e => setPick(p.key, x => ({ ...x, name: e.target.value }))}
                        {...fieldAria(`cp-name-${p.key}`, err.pickName[p.key])} />
                      <FieldError id={`cp-name-${p.key}`} message={err.pickName[p.key]} />
                    </div>
                    {hasPrice && share != null && (
                      <span style={{ fontSize: 13, color: 'var(--theme-text2)', whiteSpace: 'nowrap', paddingBottom: 9 }}>
                        about <strong style={{ color: 'var(--theme-text1)' }}>{npr(share)}</strong> of the price
                      </span>
                    )}
                    <div style={{ display: 'flex', gap: 4, paddingBottom: 2 }}>
                      <button type="button" className="btn btn-ghost btn-icon" aria-label={`Move ${pickLabel} up`} title={`Move ${pickLabel} up`}
                        disabled={pi === 0} onClick={() => set({ picks: moveItem(state.picks, pi, -1) })}>↑</button>
                      <button type="button" className="btn btn-ghost btn-icon" aria-label={`Move ${pickLabel} down`} title={`Move ${pickLabel} down`}
                        disabled={pi === state.picks.length - 1} onClick={() => set({ picks: moveItem(state.picks, pi, 1) })}>↓</button>
                      <button type="button" className="btn btn-ghost btn-icon btn-icon--delete" aria-label={`Remove ${pickLabel}`} title={`Remove ${pickLabel}`}
                        onClick={() => set({ picks: state.picks.filter(x => x.key !== p.key) })}>×</button>
                    </div>
                  </div>

                  {p.items.length > 0 && (
                    <div className="table-wrap" style={{ marginBottom: 8 }}>
                      <table className="data-table table-stack">
                        <thead>
                          <tr>
                            <th>Dish</th>
                            <th style={{ textAlign: 'right' }}>
                              <Tip width={240} text={`What a guest pays for the dish ordered on its own${vatReg ? ', VAT included' : ''}. The pick’s cheapest dish decides its part of the combo price.`}>On its own</Tip>
                            </th>
                            <th>
                              <Tip width={260} text={`Added to the combo price when the guest picks this dish${vatReg ? ', VAT included' : ''} — e.g. +50 for Chicken over Veg. Leave blank for none.`}>Extra charge</Tip>
                            </th>
                            {multi && (
                              <th>
                                <Tip width={240} text="Ticked for the guest when the combo opens, on the till and the QR menu. They can still pick another.">Default</Tip>
                              </th>
                            )}
                            <th style={{ width: 1 }}><span className="sr-only">Order and remove</span></th>
                          </tr>
                        </thead>
                        <tbody>
                          {p.items.map((it, ii) => {
                            const r = recipeOf(it.recipe_id)
                            const gone = !isComboDish(r)
                            const own = guestPriceOf(it.recipe_id)
                            const dishName = r?.name || 'A removed dish'
                            return (
                              <tr key={it.key} className={gone ? 'row-tinted' : undefined}>
                                <td>
                                  <span style={{ fontWeight: 500 }}>{dishName}</span>
                                  <div style={{ fontSize: 11, color: gone ? 'var(--theme-amber-text)' : 'var(--theme-text3)' }}>
                                    {gone
                                      ? '△ No longer an active dish — take it out'
                                      : [r.category || 'No category', r.pos_enabled === false ? 'not sold alone' : null].filter(Boolean).join(' · ')}
                                  </div>
                                </td>
                                <td className="stack-third" data-label="On its own" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                                  {own > 0 ? npr(own) : <span style={{ color: 'var(--theme-text3)' }}>no menu price</span>}
                                </td>
                                <td className="stack-third" data-label="Extra charge">
                                  <input id={`cp-extra-${it.key}`} className="form-input form-input--auto" type="number" step="any" min="0" inputMode="decimal"
                                    style={{ width: 110 }} placeholder="0" value={it.extra}
                                    aria-label={`Extra charge for ${dishName} in ${pickLabel}`}
                                    onChange={e => setItem(p.key, it.key, { extra: e.target.value })}
                                    {...fieldAria(`cp-extra-${it.key}`, err.extra[it.key])} />
                                  <div><FieldError id={`cp-extra-${it.key}`} message={err.extra[it.key]} /></div>
                                </td>
                                {multi && (
                                  <td className="stack-third" data-label="Default">
                                    <input type="radio" name={`cp-default-${p.key}`} checked={it.is_default}
                                      aria-label={`${dishName} is the default in ${pickLabel}`}
                                      onChange={() => setPick(p.key, x => setDefault(x, it.key))} />
                                  </td>
                                )}
                                <td style={{ whiteSpace: 'nowrap' }}>
                                  <div style={{ display: 'flex', gap: 2 }}>
                                    <button type="button" className="btn btn-ghost btn-icon" aria-label={`Move ${dishName} up`} title={`Move ${dishName} up`}
                                      disabled={ii === 0} onClick={() => setPick(p.key, x => ({ ...x, items: moveItem(x.items, ii, -1) }))}>↑</button>
                                    <button type="button" className="btn btn-ghost btn-icon" aria-label={`Move ${dishName} down`} title={`Move ${dishName} down`}
                                      disabled={ii === p.items.length - 1} onClick={() => setPick(p.key, x => ({ ...x, items: moveItem(x.items, ii, 1) }))}>↓</button>
                                    <button type="button" className="btn btn-ghost btn-icon btn-icon--delete"
                                      aria-label={`Take ${dishName} out of ${pickLabel}`} title={`Take ${dishName} out of ${pickLabel}`}
                                      onClick={() => setPick(p.key, x => ({ ...x, items: x.items.filter(y => y.key !== it.key) }))}>×</button>
                                  </div>
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                    <button type="button" id={`cp-dishes-${p.key}`}
                      className={`btn btn-sm ${p.items.length ? 'btn-ghost' : 'btn-primary'}`}
                      aria-describedby={err.pickDishes[p.key] ? `cp-dishes-${p.key}-err` : undefined}
                      onClick={() => setPickerFor(p.key)}>
                      {p.items.length ? 'Choose dishes…' : '+ Add dishes'}
                    </button>
                    {p.items.length === 1 && (
                      <span style={{ fontSize: 12, color: 'var(--theme-text2)' }}>Included automatically — the guest is not asked.</span>
                    )}
                    {multi && (
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--theme-text2)' }}>
                        <input type="radio" name={`cp-default-${p.key}`} checked={defaultKey == null}
                          onChange={() => setPick(p.key, x => setDefault(x, null))} />
                        No default — the guest chooses
                      </label>
                    )}
                  </div>
                  <div><FieldError id={`cp-dishes-${p.key}`} message={err.pickDishes[p.key]} /></div>
                </section>
              )
            })}
          </div>

          <div style={{ marginTop: 12 }}>
            <Tip width={300} text="A pick with one dish is included automatically — that is how you build a set meal. Give a pick several dishes to let the guest choose one.">
              <button type="button" id="combo-add-pick" className={`btn btn-sm ${state.picks.length ? 'btn-ghost' : 'btn-primary'}`}
                aria-describedby={err.picks ? 'combo-add-pick-err' : undefined} onClick={addPick}>
                + Add a pick
              </button>
            </Tip>
            <div><FieldError id="combo-add-pick" message={err.picks} /></div>
          </div>
        </div>

        {hasPrice && state.picks.length > 0 && (
          <p style={{ margin: 0, fontSize: 12, color: 'var(--theme-text2)' }}>
            The bill prints one line — “{state.name.trim() || 'the combo'}”, NPR {nprPaisa(priceNum)} plus any extra charges — with its dishes listed under it. Each dish still goes to its own kitchen or bar, takes its own stock and keeps its own VAT.
          </p>
        )}

        <ActionError error={actionError} />
        {listNote && <p role="status" className="note-banner" style={{ margin: 0 }}>{listNote}</p>}
      </div>
      <div style={{ display: 'flex', gap: 10, marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--theme-border)', flexShrink: 0 }}>
        <button type="button" className="btn btn-ghost" style={{ flex: 1, justifyContent: 'center' }} onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" style={{ flex: 2, justifyContent: 'center' }} onClick={save}
          disabled={saving} aria-busy={saving || undefined}>
          {saving ? 'Saving…' : isNew ? 'Create combo' : 'Save combo'}
        </button>
      </div>

      {pickerPick && (
        <ComboDishPicker
          pickName={pickerPick.name.trim()}
          dishes={dishes}
          chosen={pickerPick.items.map(it => it.recipe_id)}
          onClose={() => setPickerFor(null)}
          onDone={ids => { setPick(pickerPick.key, x => setPickDishes(x, ids)); setPickerFor(null) }}
        />
      )}
    </Modal>
  )
}
