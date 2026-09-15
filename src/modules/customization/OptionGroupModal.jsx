import { useState } from 'react'
import Modal from '../../components/Modal'
import Tip from '../../components/Tip'
import FieldError, { fieldAria } from '../../components/FieldError'
import ActionError, { asActionError } from '../../components/ActionError'
import { useScopedDb } from '../../shared/hooks/useScopedDb'
import { KIND_LABEL, KIND_HELP, GROUP_COLS } from './customizationData'
import { ruleText } from '../../shared/optionPricing'

// Create or edit one option group. The database holds every rule this form checks (a size group is
// pick-exactly-one, min <= max, "first N included" cannot exceed max), so the checks here exist to
// put the sentence under the right box, not to be the guard.

const toInt = v => (v === '' || v == null ? null : Number.parseInt(v, 10))

export default function OptionGroupModal({ group, nextSort, onClose, onSaved }) {
  const { scopedInsert, scopedUpdate } = useScopedDb()
  const [form, setForm] = useState(() => ({
    name: group?.name || '',
    kitchen_name: group?.kitchen_name || '',
    kind: group?.kind || 'addon',
    min_select: group ? String(group.min_select ?? 0) : '0',
    max_select: group ? (group.max_select == null ? '' : String(group.max_select)) : '',
    included_count: group ? String(group.included_count ?? 0) : '0',
    is_active: group ? group.is_active !== false : true,
  }))
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)
  const [actionError, setActionError] = useState(null)

  const set = patch => setForm(f => ({ ...f, ...patch }))
  const isSize = form.kind === 'size'
  const min = isSize ? 1 : (toInt(form.min_select) ?? 0)
  const max = isSize ? 1 : toInt(form.max_select)
  const included = form.kind === 'addon' ? (toInt(form.included_count) ?? 0) : 0

  function validate() {
    const e = {}
    if (!form.name.trim()) e.name = 'Give the group a name — guests see it, e.g. "Choose your size".'
    if (!isSize) {
      if (!Number.isInteger(min) || min < 0) e.min = 'Minimum must be 0 or more.'
      if (max != null && (!Number.isInteger(max) || max < 1)) e.max = 'Maximum must be 1 or more, or blank for no limit.'
      if (max != null && Number.isInteger(min) && min > max) e.max = 'Maximum cannot be below the minimum.'
      if (!Number.isInteger(included) || included < 0) e.included = 'Must be 0 or more.'
      else if (max != null && included > max) e.included = `Cannot include more than the ${max} a guest may pick.`
    }
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
      kind: form.kind,
      min_select: min,
      max_select: max,
      included_count: included,
      is_active: form.is_active,
    }
    const { data, error } = group
      ? await scopedUpdate('pos_option_groups', row).eq('id', group.id).select(GROUP_COLS)
      : await scopedInsert('pos_option_groups', { ...row, sort: nextSort || 0 })
    setSaving(false)
    if (error) { setActionError(asActionError(error)); return }
    // A zero-row update is a refusal that says nothing (S738): the group was removed meanwhile.
    if (group && !data?.length) {
      setActionError('This group no longer exists — it may have been deleted on another device. Close this and reload the page.')
      return
    }
    onSaved(Array.isArray(data) ? data[0] : data)
  }

  return (
    <Modal onClose={onClose} title={group ? `Edit group — ${group.name}` : 'New option group'} maxWidth={520}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div className="form-field">
          <label htmlFor="og-name">
            <Tip width={260} text="What the guest and the waiter see above the choices, e.g. “Choose your size” or “Extras”.">Group name *</Tip>
          </label>
          <input id="og-name" autoFocus value={form.name} onChange={e => set({ name: e.target.value })}
            placeholder="e.g. Extras" {...fieldAria('og-name', errors.name)} />
          <FieldError id="og-name" message={errors.name} />
        </div>

        <div className="form-field">
          <label htmlFor="og-kitchen">
            <Tip width={260} text="Optional shorter name printed on the kitchen ticket instead of the group name. Leave blank to use the group name.">Kitchen ticket name</Tip>
          </label>
          <input id="og-kitchen" value={form.kitchen_name} onChange={e => set({ kitchen_name: e.target.value })} placeholder="e.g. EXTRA" />
        </div>

        <div className="form-field">
          <span className="field-label" id="og-kind-label">What kind of choice is it?</span>
          <div role="radiogroup" aria-labelledby="og-kind-label" className="tab-bar" style={{ marginBottom: 6 }}>
            {['size', 'addon', 'choice'].map(k => (
              <button key={k} type="button" role="radio" aria-checked={form.kind === k}
                className={`tab-btn${form.kind === k ? ' tab-btn--active' : ''}`}
                onClick={() => set({ kind: k, ...(k === 'size' ? { min_select: '1', max_select: '1' } : {}) })}>
                {KIND_LABEL[k]}
              </button>
            ))}
          </div>
          <p style={{ margin: 0, fontSize: 12, color: 'var(--theme-text2)' }}>{KIND_HELP[form.kind]}</p>
        </div>

        {!isSize && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 }}>
            <div className="form-field">
              <label htmlFor="og-min">
                <Tip width={240} text="How many the guest MUST pick. 0 means the whole group is optional; 1 means they cannot order the dish without choosing.">Must pick at least</Tip>
              </label>
              <input id="og-min" type="number" min="0" step="1" value={form.min_select}
                onChange={e => set({ min_select: e.target.value })} {...fieldAria('og-min', errors.min)} />
              <FieldError id="og-min" message={errors.min} />
            </div>
            <div className="form-field">
              <label htmlFor="og-max">
                <Tip width={240} text="The most the guest may pick. Leave blank for no limit. 1 turns the group into a single choice.">Can pick at most</Tip>
              </label>
              <input id="og-max" type="number" min="1" step="1" value={form.max_select} placeholder="No limit"
                onChange={e => set({ max_select: e.target.value })} {...fieldAria('og-max', errors.max)} />
              <FieldError id="og-max" message={errors.max} />
            </div>
            {form.kind === 'addon' && (
              <div className="form-field">
                <label htmlFor="og-incl">
                  <Tip width={260} text="How many of the guest's picks are free before the add-on prices apply — e.g. 2 means “2 toppings included, then pay for each extra”. The free ones are the first in this group's order, not the cheapest.">First picks free</Tip>
                </label>
                <input id="og-incl" type="number" min="0" step="1" value={form.included_count}
                  onChange={e => set({ included_count: e.target.value })} {...fieldAria('og-incl', errors.included)} />
                <FieldError id="og-incl" message={errors.included} />
              </div>
            )}
          </div>
        )}

        <p style={{ margin: 0, fontSize: 13, color: 'var(--theme-text1)' }}>
          Guests will see: <strong>{ruleText({ min, max, included })}</strong>
        </p>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          <input type="checkbox" checked={form.is_active} onChange={e => set({ is_active: e.target.checked })} />
          <Tip width={260} text="A hidden group stays attached to its dishes but is not offered on the till or the guest menu. Old bills are not affected either way.">Offer this group on the till and guest menu</Tip>
        </label>

        <ActionError error={actionError} />
      </div>
      <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
        <button className="btn btn-ghost" style={{ flex: 1, justifyContent: 'center' }} onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" style={{ flex: 2, justifyContent: 'center' }} onClick={save} disabled={saving} aria-busy={saving || undefined}>
          {saving ? 'Saving…' : group ? 'Save group' : 'Create group'}
        </button>
      </div>
    </Modal>
  )
}
