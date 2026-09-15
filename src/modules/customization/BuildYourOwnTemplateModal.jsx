import { useMemo, useState } from 'react'
import { supabase } from '../../supabaseClient'
import Modal from '../../components/Modal'
import Tip from '../../components/Tip'
import SearchableSelect from '../../components/SearchableSelect'
import FieldError, { fieldAria } from '../../components/FieldError'
import ActionError, { asActionError } from '../../components/ActionError'

// Crest Customization (S760) — the build-your-own template.
//
// An acai bowl, a pizza or a salad is built the same way: a size, a base, sauces, toppings. This
// makes those four groups for ONE dish, puts them on it in that order and marks the dish
// build-your-own, so the till always opens its choice window and the guest menu walks it step by
// step. It creates structure, not a menu: the sizes arrive as Small 0.75 / Medium / Large 1.5 at no
// extra charge, and the owner then adds the bases, sauces and toppings and sets every price.
//
// One RPC (create_build_your_own_template), one transaction: either all of it lands or none of it.
// Group names are unique per client, so the groups are named after the dish ("Acai Bowl · Base") —
// two build-your-own dishes rarely share a base, and a pizza's base list should not be an acai
// bowl's.

export default function BuildYourOwnTemplateModal({ dishes, buildYourOwn = [], groupNames = [], onClose, onSaved }) {
  const candidates = useMemo(
    () => dishes.filter(d => d.category !== 'Sub-Recipe').map(d => ({
      value: d.id,
      label: `${d.name}${buildYourOwn.includes(d.id) ? ' (already build-your-own)' : ''}`,
    })),
    [dishes, buildYourOwn],
  )
  const [dishId, setDishId] = useState('')
  const [prefix, setPrefix] = useState('')
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)
  const [actionError, setActionError] = useState(null)

  const dish = dishes.find(d => d.id === dishId) || null
  const shownPrefix = (prefix.trim() || dish?.name || 'Dish').slice(0, 60)
  const names = ['Size', 'Base', 'Sauces', 'Toppings'].map(s => `${shownPrefix} · ${s}`)
  const taken = useMemo(() => {
    const have = new Set(groupNames.map(n => String(n).trim().toLowerCase()))
    return names.filter(n => have.has(n.toLowerCase()))
  }, [groupNames, names]) // eslint-disable-line react-hooks/exhaustive-deps

  async function create() {
    if (saving) return
    const e = {}
    if (!dishId) e.dish = 'Choose the dish guests build — e.g. Acai Bowl.'
    if (taken.length) e.prefix = `A group called “${taken[0]}” already exists. Type a different name for the groups.`
    setErrors(e)
    if (Object.keys(e).length) return
    setSaving(true)
    setActionError(null)
    const { data, error } = await supabase.rpc('create_build_your_own_template', {
      p_recipe_id: dishId, p_prefix: prefix.trim() || null,
    })
    setSaving(false)
    if (error) { setActionError(asActionError(error)); return }
    onSaved({ dish, result: data })
  }

  return (
    <Modal onClose={onClose} title="Build-your-own template" maxWidth={560}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--theme-text2)' }}>
          For a dish guests build in steps, like an acai bowl, pizza or salad. This creates four groups on the dish, in the order guests choose:
        </p>
        <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: 'var(--theme-text1)', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <li><strong>Size</strong>: Small, Medium, Large. A Large plate uses 1.5× the base and toppings.</li>
          <li><strong>Base</strong>: pick exactly 1, such as acai puree or a pizza base. Uses more at a bigger size.</li>
          <li><strong>Sauces</strong>: up to 2, such as mayo or fish sauce. Uses more at a bigger size.</li>
          <li><strong>Toppings</strong>: any number, such as chicken popcorn, fruit or curd. Costs and uses more at a bigger size.</li>
        </ol>

        <div className="form-field" style={{ margin: 0 }}>
          <label htmlFor="byo-dish">Dish</label>
          <SearchableSelect id="byo-dish" value={dishId} onChange={v => setDishId(v)} options={candidates}
            placeholder="Choose a dish…" invalid={errors.dish} />
          <FieldError id="byo-dish" message={errors.dish} />
        </div>

        <div className="form-field" style={{ margin: 0 }}>
          <label htmlFor="byo-prefix">
            <Tip width={300} text="Group names must be different from each other, so each group is named after the dish. Change it if you want shorter names on the Groups page. Guests see the name too, so keep it readable.">Name the groups after</Tip>
          </label>
          <input id="byo-prefix" value={prefix} onChange={ev => setPrefix(ev.target.value)} maxLength={60}
            placeholder={dish?.name || 'The dish name'} {...fieldAria('byo-prefix', errors.prefix)} />
          <FieldError id="byo-prefix" message={errors.prefix} />
          <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--theme-text2)' }}>
            Creates: {names.join(', ')}.
          </p>
        </div>

        <p style={{ margin: 0, fontSize: 12, color: 'var(--theme-text3)' }}>
          Nothing is priced yet. Add the bases, sauces and toppings next, set their prices on the Groups tab, and set each size’s price there too.
        </p>

        <ActionError error={actionError} />
      </div>
      <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
        <button type="button" className="btn btn-ghost" style={{ flex: 1, justifyContent: 'center' }} onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" style={{ flex: 2, justifyContent: 'center' }}
          onClick={create} disabled={saving} aria-busy={saving || undefined}>
          {saving ? 'Creating…' : 'Create the four groups'}
        </button>
      </div>
    </Modal>
  )
}
