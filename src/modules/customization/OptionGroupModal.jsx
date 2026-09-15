import { useState } from 'react'
import Modal from '../../components/Modal'
import Tip from '../../components/Tip'
import FieldError, { fieldAria } from '../../components/FieldError'
import ActionError, { asActionError } from '../../components/ActionError'
import { useScopedDb } from '../../shared/hooks/useScopedDb'
import { GROUP_COLS } from './customizationData'
import { ruleText } from '../../shared/optionPricing'
import { moveRovingFocus, rovingTabIndex } from '../../shared/rovingFocus'

// Create or edit one option group — written for a restaurant owner, not a form designer (S758).
//
// What the owner decides, in the order they think about it: a name, what KIND of choice it is
// (three cards with an example each), and — for anything but a size — one sentence built from two
// dropdowns ("Guests may skip this and can pick any number"). Everything else (the kitchen ticket
// wording, "first picks free", offering it) sits under More options, closed unless it already holds
// something.
//
// Picking a kind RESETS the pick rule to that kind's default. It used to keep whatever was in the
// boxes, so tapping Size (1/1) and then Add-ons left an add-on group reading "Pick exactly 1" under
// help text promising "the guest can pick several".
//
// The database holds every rule checked here (a size is pick-exactly-one, min <= max, free picks <=
// max), so the checks exist to put the sentence in the right place, not to be the guard.

// The three kinds differ in what they DO, and the hint says that rather than repeating the pick
// rule twice: a size sets the dish's price, an add-on can add to it, a choice is usually free.
const KINDS = [
  { key: 'size',   title: 'Size',    example: 'Half / Full · Small / Large', hint: 'Picks one · each size sets the dish price', rule: { min: 1, max: 1 } },
  { key: 'addon',  title: 'Add-ons', example: 'Extra cheese · Add egg · No onion', hint: 'Picks several · each can add to the price', rule: { min: 0, max: null } },
  { key: 'choice', title: 'Choice',  example: 'Mild / Medium / Hot',         hint: 'Picks one · usually free',                   rule: { min: 1, max: 1 } },
]

const MIN_CHOICES = [0, 1, 2, 3, 4, 5]
const MAX_CHOICES = [1, 2, 3, 4, 5, 6, 8, 10]

const minLabel = n => (n === 0 ? 'may skip this' : n === 1 ? 'must choose at least 1' : `must choose at least ${n}`)
const maxLabel = n => (n == null ? 'any number' : n === 1 ? 'only 1' : `up to ${n}`)

// A saved group can hold a value the dropdown does not list; keep it selectable rather than
// silently snapping it to the nearest one on open.
const withCurrent = (list, v) => (v == null || list.includes(v) ? list : [...list, v].sort((a, b) => a - b))

export default function OptionGroupModal({ group, attachedCount = 0, nextSort, onClose, onSaved }) {
  const { scopedInsert, scopedUpdate } = useScopedDb()
  const [name, setName] = useState(group?.name || '')
  const [kind, setKind] = useState(group?.kind || 'addon')
  const [min, setMin] = useState(group ? (group.min_select ?? 0) : 0)
  const [max, setMax] = useState(group ? (group.max_select ?? null) : null)
  const [included, setIncluded] = useState(group?.included_count || 0)
  const [kitchenName, setKitchenName] = useState(group?.kitchen_name || '')
  const [active, setActive] = useState(group ? group.is_active !== false : true)
  const [moreOpen, setMoreOpen] = useState(() => !!(group && (group.kitchen_name || group.included_count || group.is_active === false)))
  const [nameError, setNameError] = useState('')
  const [saving, setSaving] = useState(false)
  const [actionError, setActionError] = useState(null)

  const isSize = kind === 'size'
  const effMin = isSize ? 1 : min
  const effMax = isSize ? 1 : max
  const effIncluded = kind === 'addon' ? Math.min(included, effMax ?? included) : 0

  function pickKind(k) {
    if (k === kind) return
    const def = KINDS.find(x => x.key === k).rule
    setKind(k)
    setMin(def.min)
    setMax(def.max)
    if (k !== 'addon') setIncluded(0)
  }

  function pickMin(v) {
    setMin(v)
    if (max != null && v > max) setMax(v) // "must choose 3, up to 2" is not a rule anyone means
  }

  function pickMax(raw) {
    const v = raw === 'any' ? null : Number(raw)
    setMax(v)
    if (v != null && min > v) setMin(v)
    if (v != null && included > v) setIncluded(v)
  }

  async function save() {
    if (saving) return
    if (!name.trim()) { setNameError('Give the group a name — guests see it, e.g. “Extras” or “Choose your size”.'); return }
    setNameError('')
    setSaving(true)
    setActionError(null)
    const row = {
      name: name.trim(),
      kitchen_name: kitchenName.trim() || null,
      kind,
      min_select: effMin,
      max_select: effMax,
      included_count: effIncluded,
      is_active: active,
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

  const summary = ruleText({ min: effMin, max: effMax, included: effIncluded })
  // Changing a live group's kind resets its pick rule for every dish it is on. Said before Save,
  // not discovered on the till.
  const kindChangedLive = !!group && kind !== group.kind && attachedCount > 0

  return (
    <Modal onClose={onClose} title={group ? `Edit group — ${group.name}` : 'New option group'} maxWidth={560}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div className="form-field" style={{ margin: 0 }}>
          <label htmlFor="og-name">Name</label>
          <input id="og-name" autoFocus value={name} onChange={e => setName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && save()}
            placeholder="e.g. Extras" {...fieldAria('og-name', nameError)} />
          <FieldError id="og-name" message={nameError} />
        </div>

        <div>
          <span className="field-label" id="og-kind-label" style={{ display: 'block', marginBottom: 8 }}>What is it?</span>
          <div role="radiogroup" aria-labelledby="og-kind-label"
            onKeyDown={e => moveRovingFocus(e, '[role="radio"]')?.click()}
            style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 }}>
            {KINDS.map(k => {
              const on = kind === k.key
              return (
                <button key={k.key} type="button" role="radio" aria-checked={on} className="kind-card"
                  tabIndex={rovingTabIndex(on)} onClick={() => pickKind(k.key)}>
                  <span className="kind-card__title">{k.title}</span>
                  <span className="kind-card__example">{k.example}</span>
                  <span className="kind-card__hint">{k.hint}</span>
                </button>
              )
            })}
          </div>
          {kindChangedLive && (
            <p role="alert" style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--theme-amber-text)' }}>
              This group is on {attachedCount} dish{attachedCount === 1 ? '' : 'es'}. Changing its kind resets the pick rule to “{summary}” for all of them the moment you save; bills already rung are not affected.
            </p>
          )}
        </div>

        {isSize ? (
          <p style={{ margin: 0, fontSize: 13, color: 'var(--theme-text2)' }}>
            Guests always pick exactly one size. You set each size's price when you add it.
          </p>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 14 }}>
            <span>Guests</span>
            <select aria-label="How many the guest must choose" className="form-select" value={min}
              onChange={e => pickMin(Number(e.target.value))} style={{ width: 'auto' }}>
              {withCurrent(MIN_CHOICES, min).map(n => <option key={n} value={n}>{minLabel(n)}</option>)}
            </select>
            <span>and can pick</span>
            <select aria-label="The most the guest can pick" className="form-select" value={max == null ? 'any' : max}
              onChange={e => pickMax(e.target.value)} style={{ width: 'auto' }}>
              {withCurrent(MAX_CHOICES, max).filter(n => n >= Math.max(1, min)).map(n => <option key={n} value={n}>{maxLabel(n)}</option>)}
              <option value="any">{maxLabel(null)}</option>
            </select>
          </div>
        )}

        <p style={{ margin: 0, fontSize: 13, color: 'var(--theme-text2)' }}>
          Guests will see: <strong style={{ color: 'var(--theme-text1)' }}>{summary}</strong>
        </p>

        <div>
          <button type="button" className="btn btn-ghost btn-sm" aria-expanded={moreOpen} aria-controls="og-more"
            onClick={() => setMoreOpen(o => !o)}>
            {moreOpen ? '▾' : '▸'} More options
          </button>
          {moreOpen && (
            <div id="og-more" style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 12, paddingLeft: 12, borderLeft: '1px solid var(--theme-border)' }}>
              <div className="form-field" style={{ margin: 0 }}>
                <label htmlFor="og-kitchen">
                  <Tip width={260} text="Optional shorter wording printed on the kitchen ticket instead of the group name. Leave blank to print the name.">Kitchen ticket name</Tip>
                </label>
                <input id="og-kitchen" value={kitchenName} onChange={e => setKitchenName(e.target.value)} placeholder="Same as the name" />
              </div>
              {kind === 'addon' && (
                <div className="form-field" style={{ margin: 0 }}>
                  <label htmlFor="og-incl">
                    <Tip width={300} text="For a deal like “2 toppings included, pay for each extra”. Of what the guest picks, the ones listed EARLIEST in this group are the free ones — not the cheapest — so put the options you are happy to give away at the top of the list (Move up on the Groups page). The till and guest menu show a pick as Included once it is free.">Free picks before charging</Tip>
                  </label>
                  <select id="og-incl" className="form-select" value={effIncluded} onChange={e => setIncluded(Number(e.target.value))} style={{ width: 'auto' }}>
                    {Array.from({ length: (effMax ?? 10) + 1 }, (_, n) => n).map(n => (
                      <option key={n} value={n}>{n === 0 ? 'None — every pick is charged' : `First ${n} free`}</option>
                    ))}
                  </select>
                </div>
              )}
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                <input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} />
                <Tip width={260} text="Untick to hide this group without deleting it — the same as Hide on the Groups page. It stays on its dishes; old bills are not affected.">Shown on the till and guest menu</Tip>
              </label>
            </div>
          )}
        </div>

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
