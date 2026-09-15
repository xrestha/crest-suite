import { useMemo, useState } from 'react'
import Modal from '../../components/Modal'
import Tip from '../../components/Tip'
import SearchableSelect from '../../components/SearchableSelect'
import QtyInput from '../../components/QtyInput'
import FieldError, { fieldAria } from '../../components/FieldError'
import ActionError, { asActionError } from '../../components/ActionError'
import { useScopedDb } from '../../shared/hooks/useScopedDb'
import { OPTION_COLS, DIET_LABEL, parseAllergens } from './customizationData'
import { exFromIncl, inclFromEx, signedPrice } from '../../shared/optionPricing'
import { npr } from '../../shared/nepalMoney'

// Create or edit one option inside a group.
//
// PRICE. Stored ex-VAT (the recipes.selling_price convention) and entered as what the guest pays.
// A SIZE option is entered as the full price of that size when every dish the group is attached to
// has the same price — the owner's own menu reads "Half 150, Full 250" — and as a difference from
// the dish price otherwise, with each attached dish's result shown underneath, because one stored
// difference cannot be two different full prices.
//
// INGREDIENTS (IMS only). Each line ADDS to or TAKES OFF the plate, per ONE plate, in the item's
// own unit. Stored signed. An option with no lines changes nothing in stock, and the list on the
// Groups page says so, so that is a choice rather than an accident.
//
// PORTION (S760, size options only). How big a plate this size is against a regular one — Small
// 0.75, Large 1.5. Groups set to scale with the size multiply their stock (and price, if chosen) by
// it. Blank means 1×, and the column is written only when it changes, so an ordinary edit still
// saves on a database the S760 migration has not reached.

const newKey = () => Math.random().toString(36).slice(2)

export default function OptionModal({
  group, option, ingredients, attachedDishes, vat, imsEnabled,
  itemChoices, onClose, onSaved,
}) {
  const { scopedInsert, scopedUpdate, scopedDelete } = useScopedDb()
  const isSize = group.kind === 'size'

  // One distinct incl-VAT dish price across every dish this group is on → full-price entry.
  const dishPrices = useMemo(() => Array.from(new Set(attachedDishes.map(d => Math.round(d.inclPrice)))), [attachedDishes])
  const fullPriceMode = isSize && dishPrices.length === 1
  const basePrice = fullPriceMode ? dishPrices[0] : null

  const storedDeltaIncl = option ? inclFromEx(option.price_delta, vat) : 0
  const [form, setForm] = useState(() => ({
    name: option?.name || '',
    kitchen_name: option?.kitchen_name || '',
    price: option
      ? String(Math.round(fullPriceMode ? basePrice + storedDeltaIncl : storedDeltaIncl))
      : (fullPriceMode ? String(basePrice) : ''),
    is_removal: !!option?.is_removal,
    is_default: !!option?.is_default,
    diet: option?.diet || '',
    allergens: (option?.allergens || []).join(', '),
    is_active: option ? option.is_active !== false : true,
    portion: option?.portion_factor != null ? String(Number(option.portion_factor)) : '',
  }))
  const [lines, setLines] = useState(() => (ingredients || []).map(i => ({
    key: newKey(),
    id: i.id,
    ref: i.item_id ? `item:${i.item_id}` : `sub:${i.sub_recipe_id}`,
    direction: Number(i.qty_per_portion) < 0 ? 'remove' : 'add',
    qty: String(Math.abs(Number(i.qty_per_portion))),
  })))
  // The basics (name, add-or-take-off, price) are always on screen; the rest opens on demand, and
  // opens by itself when it already holds something so an edit never hides a saved value.
  const [detailsOpen, setDetailsOpen] = useState(() => !!(option && (option.kitchen_name || option.diet
    || (option.allergens || []).length || option.is_default || option.is_active === false)))
  const [stockOpen, setStockOpen] = useState(() => (ingredients || []).length > 0)
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)
  const [actionError, setActionError] = useState(null)
  const set = patch => setForm(f => ({ ...f, ...patch }))

  const priceNum = form.price === '' ? 0 : Number(form.price)
  const deltaIncl = fullPriceMode ? priceNum - basePrice : priceNum
  const choiceByRef = useMemo(() => new Map(itemChoices.map(c => [c.value, c])), [itemChoices])
  // What "More details" holds, said on the closed button so a folded section is not a hidden one.
  const detailSummary = [
    form.diet ? DIET_LABEL[form.diet] : null,
    parseAllergens(form.allergens).length ? 'allergens' : null,
    form.is_default ? 'pre-selected' : null,
    form.kitchen_name.trim() ? 'ticket name' : null,
    form.is_active ? null : 'hidden',
  ].filter(Boolean).join(' · ')

  function validate() {
    const e = {}
    if (!form.name.trim()) e.name = 'Give the option a name, e.g. “Extra cheese”.'
    if (!form.is_removal && form.price !== '' && !Number.isFinite(Number(form.price))) e.price = 'Enter a number.'
    if (fullPriceMode && form.price !== '' && Number(form.price) < 0) e.price = 'A price cannot be below zero.'
    if (isSize && form.portion !== '' && !(Number(form.portion) > 0 && Number(form.portion) <= 10)) {
      e.portion = 'Enter a portion above 0 and up to 10 — 1 is a regular plate, 1.5 is half as much again.'
    }
    lines.forEach((l, i) => {
      if (!l.ref) e[`line${i}`] = 'Choose an item.'
      else if (!(Number(l.qty) > 0)) e[`line${i}`] = 'Enter an amount above zero.'
    })
    const refs = lines.map(l => l.ref).filter(Boolean)
    if (new Set(refs).size !== refs.length) e.lines = 'The same item is listed twice — combine them into one line.'
    // A message inside a folded section is a message nobody reads.
    if (Object.keys(e).some(k => k.startsWith('line'))) setStockOpen(true)
    setErrors(e)
    return Object.keys(e).length === 0
  }

  async function save() {
    if (saving || !validate()) return
    setSaving(true)
    setActionError(null)
    const row = {
      name: form.name.trim(),
      kitchen_name: form.kitchen_name.trim() || null,
      price_delta: form.is_removal ? 0 : exFromIncl(deltaIncl, vat),
      is_removal: isSize ? false : form.is_removal,
      is_default: form.is_default,
      diet: form.is_removal ? null : (form.diet || null),
      allergens: form.is_removal ? [] : parseAllergens(form.allergens),
      is_active: form.is_active,
    }
    if (isSize) {
      const nextPortion = form.portion === '' || Number(form.portion) === 1 ? null : Math.round(Number(form.portion) * 1000) / 1000
      const savedPortion = option?.portion_factor == null ? null : Number(option.portion_factor)
      if (nextPortion !== savedPortion) row.portion_factor = nextPortion
    }

    let saved
    if (option) {
      const { data, error } = await scopedUpdate('pos_options', row).eq('id', option.id).select(OPTION_COLS)
      if (error) { setSaving(false); setActionError(asActionError(error)); return }
      if (!data?.length) {
        setSaving(false)
        setActionError('This option no longer exists — it may have been deleted on another device. Close this and reload the page.')
        return
      }
      saved = data[0]
    } else {
      const { data, error } = await scopedInsert('pos_options', { ...row, group_id: group.id, sort: nextSortOf(group) }, { single: true })
      if (error) { setSaving(false); setActionError(asActionError(error)); return }
      saved = data
    }

    if (imsEnabled) {
      const failure = await saveIngredients(saved.id)
      if (failure) {
        setSaving(false)
        const a = asActionError(failure)
        // The option row DID land; only the ingredient list is uncertain. Say which state it is in.
        setActionError({
          text: `“${saved.name}” was saved, but its ingredient list was not fully updated — check it and save again. ${a.text}`,
          detail: a.detail,
        })
        onSaved(saved, { keepOpen: true })
        return
      }
    }
    setSaving(false)
    onSaved(saved)
  }

  // Additions and changes first, removals last — a half-finished save leaves more than it takes,
  // the same order Recipes.js and Menu Pricing's pairings use.
  async function saveIngredients(optionId) {
    const existingIds = new Set((ingredients || []).map(i => i.id))
    const keptIds = new Set(lines.filter(l => l.id).map(l => l.id))
    const toRow = l => {
      const [kind, refId] = l.ref.split(':')
      const qty = Number(l.qty) * (l.direction === 'remove' ? -1 : 1)
      return { option_id: optionId, item_id: kind === 'item' ? refId : null, sub_recipe_id: kind === 'sub' ? refId : null, qty_per_portion: qty }
    }
    const inserts = lines.filter(l => !l.id).map(toRow)
    if (inserts.length) {
      const { error } = await scopedInsert('pos_option_ingredients', inserts)
      if (error) return error
    }
    const updates = await Promise.all(lines.filter(l => l.id).map(l =>
      scopedUpdate('pos_option_ingredients', toRow(l)).eq('id', l.id)))
    const upErr = updates.find(r => r.error)
    if (upErr) return upErr.error
    const removed = [...existingIds].filter(id => !keptIds.has(id))
    if (removed.length) {
      const { error } = await scopedDelete('pos_option_ingredients').in('id', removed)
      if (error) return error
    }
    return null
  }

  const priceLabel = fullPriceMode
    ? `Price of this size${vat > 0 ? ' (incl. VAT)' : ''}`
    : isSize
      ? `Price difference from the dish${vat > 0 ? ' (incl. VAT)' : ''}`
      : `Extra charge${vat > 0 ? ' (incl. VAT)' : ''}`

  return (
    <Modal onClose={onClose} title={option ? `Edit option — ${option.name}` : `New option in ${group.name}`} maxWidth={620}
      panelStyle={{ maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}>
      <div style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 16, paddingRight: 2 }}>
        <div className="form-field" style={{ margin: 0 }}>
          <label htmlFor="opt-name">Name</label>
          <input id="opt-name" autoFocus value={form.name} onChange={e => set({ name: e.target.value })}
            onKeyDown={e => e.key === 'Enter' && save()}
            placeholder={isSize ? 'e.g. Half' : 'e.g. Extra cheese'} {...fieldAria('opt-name', errors.name)} />
          <FieldError id="opt-name" message={errors.name} />
        </div>

        {!isSize && (
          <div role="radiogroup" aria-label="Does this option add something or take something off?" className="tab-bar" style={{ margin: 0 }}>
            {[[false, 'Adds or changes something'], [true, 'Takes something off (“No …”)']].map(([removal, label]) => (
              <button key={String(removal)} type="button" role="radio" aria-checked={form.is_removal === removal}
                className={`tab-btn${form.is_removal === removal ? ' tab-btn--active' : ''}`}
                onClick={() => set({ is_removal: removal, ...(removal ? { price: '' } : {}) })}>
                {label}
              </button>
            ))}
          </div>
        )}
        {form.is_removal && (
          <p style={{ margin: 0, fontSize: 12, color: 'var(--theme-text2)' }}>
            Always free. Prints in bold as <strong>NO {form.name.replace(/^no\s+/i, '') || '…'}</strong> on the kitchen ticket.
          </p>
        )}

        {!form.is_removal && (
          <div className="form-field">
            <label htmlFor="opt-price">
              <Tip width={300} text={fullPriceMode
                ? 'Type the full menu price of this size. Every dish this group is on currently costs the same, so the difference is worked out for you.'
                : isSize
                  ? 'This group is on dishes with different prices, so enter how much this size adds or takes off (negative for a smaller portion). The result for each dish is shown below.'
                  : 'How much this option adds to the dish. Leave blank or 0 if it is free.'}>
                {priceLabel}
              </Tip>
            </label>
            <input id="opt-price" type="number" step="any" value={form.price} placeholder={fullPriceMode ? String(basePrice) : '0'}
              onChange={e => set({ price: e.target.value })} {...fieldAria('opt-price', errors.price)} style={{ maxWidth: 220 }} />
            <FieldError id="opt-price" message={errors.price} />
            <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--theme-text2)' }}>
              {fullPriceMode
                ? <>Dish price {npr(basePrice)} → this size {npr(Math.max(0, basePrice + deltaIncl))} ({signedPrice(deltaIncl) || 'same price'}).</>
                : isSize && attachedDishes.length > 0
                  ? <>
                      {attachedDishes.slice(0, 6).map(d => `${d.name}: ${npr(d.inclPrice)} → ${npr(Math.max(0, d.inclPrice + deltaIncl))}`).join(' · ')}
                      {attachedDishes.length > 6 && (
                        <Tip width={300} text={attachedDishes.slice(6).map(d => `${d.name}: ${npr(d.inclPrice)} → ${npr(Math.max(0, d.inclPrice + deltaIncl))}`).join(' · ')}>
                          <span> · +{attachedDishes.length - 6} more</span>
                        </Tip>
                      )}
                    </>
                  : isSize
                    ? 'Put this group on a dish to enter the full price of each size instead.'
                    : deltaIncl ? `Guests see ${signedPrice(deltaIncl)} beside this option.` : 'Guests see no price — it is free.'}
            </p>
            {option && (
              <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--theme-text3)' }}>
                A new price applies to the next dish ordered. Dishes already on a table keep the price they were ordered at.
              </p>
            )}
            {vat > 0 && (
              <Tip width={300} text={`Saved as ${npr(exFromIncl(deltaIncl, vat))} before VAT, so the guest pays this on a 13% dish. A dish sold without VAT charges the before-VAT amount instead.`}>
                <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--theme-text3)' }}>
                  Includes VAT · how a no-VAT dish charges it
                </p>
              </Tip>
            )}
          </div>
        )}

        {isSize && (
          <div className="form-field" style={{ margin: 0 }}>
            <label htmlFor="opt-portion">
              <Tip width={320} text="How big this size is against a regular plate. Small 0.75, Medium 1, Large 1.5. Groups on the dish that scale with size (toppings, a base) use this to work out stock and, if chosen, price — chicken popcorn on a Large bowl uses 1.5× the chicken. Leave blank for a regular plate.">Portion</Tip>
            </label>
            <QtyInput id="opt-portion" value={form.portion} placeholder="1"
              onChange={v => set({ portion: v === '' || v == null ? '' : String(v) })}
              onCommit={v => set({ portion: v === '' || v == null ? '' : String(v) })}
              wrapperStyle={{ maxWidth: 140 }} {...fieldAria('opt-portion', errors.portion)} />
            <FieldError id="opt-portion" message={errors.portion} />
            <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--theme-text2)' }}>
              {form.portion === '' || Number(form.portion) === 1
                ? 'A regular plate: toppings and bases use their normal amount.'
                : Number(form.portion) > 0
                  ? `${Number(form.portion)}× a regular plate: a topping that uses 30 g uses ${Math.round(30 * Number(form.portion) * 10) / 10} g at this size.`
                  : ''}
            </p>
          </div>
        )}

        <div>
          <button type="button" className="btn btn-ghost btn-sm" aria-expanded={detailsOpen} aria-controls="opt-details"
            onClick={() => setDetailsOpen(o => !o)}>
            {detailsOpen ? '▾' : '▸'} More details
            {!detailsOpen && detailSummary && <span style={{ marginLeft: 8, fontWeight: 400, color: 'var(--theme-text3)' }}>{detailSummary}</span>}
          </button>
          {detailsOpen && (
        <div id="opt-details" style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 12, paddingLeft: 12, borderLeft: '1px solid var(--theme-border)' }}>
        <div className="form-field" style={{ margin: 0 }}>
          <label htmlFor="opt-kitchen">
            <Tip width={240} text="Optional shorter wording for the kitchen ticket — e.g. “XTRA CHZ”. Leave blank to print the option name.">Kitchen ticket name</Tip>
          </label>
          <input id="opt-kitchen" value={form.kitchen_name} onChange={e => set({ kitchen_name: e.target.value })} placeholder="Same as the name" />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
          {!form.is_removal && (
            <div className="form-field" style={{ margin: 0 }}>
              <label htmlFor="opt-diet">
                <Tip width={260} text="What this option adds to the plate. Choose Non-veg for “Add chicken” so the guest menu stops showing a veg dish as veg once it is picked.">Veg / Egg / Non-veg</Tip>
              </label>
              <select id="opt-diet" className="form-select" value={form.diet} onChange={e => set({ diet: e.target.value })}>
                <option value="">Not stated</option>
                {Object.entries(DIET_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
          )}
          {!form.is_removal && (
            <div className="form-field" style={{ margin: 0 }}>
              <label htmlFor="opt-allergens">
                <Tip width={260} text="Comma-separated, the same tags as dishes use — e.g. dairy, gluten, nuts. Shown to guests beside the option.">Allergens</Tip>
              </label>
              <input id="opt-allergens" value={form.allergens} onChange={e => set({ allergens: e.target.value })} placeholder="e.g. dairy" />
            </div>
          )}
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
            <input type="checkbox" checked={form.is_default} onChange={e => set({ is_default: e.target.checked })} />
            <Tip width={260} text="Pre-ticked when the picker opens, on every dish this group is on — e.g. “Full” in a size group or “Medium” spice. The guest can still change it.">Pre-selected</Tip>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
            <input type="checkbox" checked={form.is_active} onChange={e => set({ is_active: e.target.checked })} />
            <Tip width={260} text="Untick to hide it (e.g. out of stock) without deleting it — the same as Hide on the Groups page.">Shown on the till and guest menu</Tip>
          </label>
        </div>
        </div>
          )}
        </div>

        {imsEnabled && (
          <div>
          <button type="button" className="btn btn-ghost btn-sm" aria-expanded={stockOpen} aria-controls="opt-stock"
            onClick={() => setStockOpen(o => !o)}>
            {stockOpen ? '▾' : '▸'} Stock per plate
            <span style={{ marginLeft: 8, fontWeight: 400, color: lines.length ? 'var(--theme-text3)' : 'var(--theme-amber-text)' }}>
              {lines.length ? `${lines.length} ingredient line${lines.length === 1 ? '' : 's'}` : 'none — stock will not change'}
            </span>
          </button>
          {stockOpen && (
          <div id="opt-stock" style={{ marginTop: 12, paddingLeft: 12, borderLeft: '1px solid var(--theme-border)' }}>
            <p style={{ margin: '0 0 10px', fontSize: 12, color: 'var(--theme-text2)' }}>
              What picking this does to stock, per plate — e.g. “Extra cheese” adds 30 GM of cheese, “No onion” takes off 20 GM of onion.
            </p>
            {lines.length === 0 && (
              <p style={{ margin: '0 0 10px', fontSize: 12, color: 'var(--theme-text2)' }}>
                No ingredients — picking this option will not change stock or food cost.
              </p>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {lines.map((l, i) => {
                const choice = choiceByRef.get(l.ref)
                return (
                  <div key={l.key}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <select aria-label={`Line ${i + 1}: adds or takes off`} className="form-select" value={l.direction}
                        onChange={e => setLines(ls => ls.map(x => x.key === l.key ? { ...x, direction: e.target.value } : x))}
                        style={{ width: 120 }}>
                        <option value="add">Adds</option>
                        <option value="remove">Takes off</option>
                      </select>
                      {/* Item first, then the amount in ITS unit — the unit was blank until an item was chosen. */}
                      <div style={{ flex: '1 1 200px', minWidth: 180 }}>
                        <SearchableSelect id={`opt-line-${l.key}`} value={l.ref} options={itemChoices}
                          placeholder="— Choose a stock item or sub-recipe —"
                          onChange={v => setLines(ls => ls.map(x => x.key === l.key ? { ...x, ref: v } : x))}
                          invalid={errors[`line${i}`] || ''} />
                      </div>
                      <QtyInput aria-label={`Line ${i + 1}: amount${choice?.unit ? ` in ${choice.unit}` : ''}`} className="form-input form-input--auto"
                        value={l.qty} placeholder="0"
                        onChange={v => setLines(ls => ls.map(x => x.key === l.key ? { ...x, qty: v === '' ? '' : String(v) } : x))}
                        onCommit={v => setLines(ls => ls.map(x => x.key === l.key ? { ...x, qty: v === '' ? '' : String(v) } : x))}
                        style={{ width: 90 }} />
                      <span style={{ fontSize: 12, color: 'var(--theme-text2)', minWidth: 32 }}>{choice?.unit || <span style={{ color: 'var(--theme-text3)' }}>unit</span>}</span>
                      <button type="button" className="btn btn-ghost btn-sm" aria-label={`Remove line ${i + 1}`}
                        onClick={() => setLines(ls => ls.filter(x => x.key !== l.key))}>Remove</button>
                    </div>
                    {errors[`line${i}`] && <span className="field-error" role="alert">{errors[`line${i}`]}</span>}
                  </div>
                )
              })}
            </div>
            {errors.lines && <span className="field-error" role="alert">{errors.lines}</span>}
            <button type="button" className="btn btn-ghost btn-sm" style={{ marginTop: 10 }}
              onClick={() => setLines(ls => [...ls, { key: newKey(), id: null, ref: '', direction: form.is_removal ? 'remove' : 'add', qty: '' }])}>
              + Add ingredient line
            </button>
          </div>
          )}
          </div>
        )}

        <ActionError error={actionError} />
      </div>
      <div style={{ display: 'flex', gap: 10, marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--theme-border)', flexShrink: 0 }}>
        <button className="btn btn-ghost" style={{ flex: 1, justifyContent: 'center' }} onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" style={{ flex: 2, justifyContent: 'center' }} onClick={save} disabled={saving} aria-busy={saving || undefined}>
          {saving ? 'Saving…' : option ? 'Save option' : 'Add option'}
        </button>
      </div>
    </Modal>
  )
}

// New options go to the end of their group. `group.options` is attached by the page.
function nextSortOf(group) {
  const sorts = (group.options || []).map(o => o.sort || 0)
  return sorts.length ? Math.max(...sorts) + 1 : 0
}
