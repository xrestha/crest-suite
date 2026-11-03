import { useRef, useState } from 'react'
import Modal from '../../components/Modal'
import Tip from '../../components/Tip'
import FieldError, { fieldAria } from '../../components/FieldError'
import ActionError from '../../components/ActionError'
import { useScopedDb } from '../../shared/hooks/useScopedDb'
import { useConfirm } from '../../shared/hooks/useConfirm'
import { settleWithin } from '../../utils/withTimeout'
import { GROUP_COLS, SIZE_SCALING_HELP, CUSTOMIZATION_WRITE_MS, writeFailure } from './customizationData'
import { ruleText, SIZE_SCALING_LABEL } from '../../shared/optionPricing'
import { moveRovingFocus, rovingTabIndex } from '../../shared/rovingFocus'
import { groupEditEffects, groupEditRefusal, shortfallText } from './optionChecks'

// Create or edit one option group — written for a restaurant owner, not a form designer (S758).
//
// What the owner decides, in the order they think about it: a name, what KIND of choice it is
// (three cards with an example each), and — for anything but a size — one sentence built from two
// dropdowns ("Guests may skip this and can pick any number"). Everything else (the kitchen ticket
// wording, "first picks free", offering it) sits under More settings, closed unless it already holds
// something.
//
// Picking a kind RESETS the pick rule to that kind's default. It used to keep whatever was in the
// boxes, so tapping Size (1/1) and then Add-ons left an add-on group reading "Pick exactly 1" under
// help text promising "the guest can pick several".
//
// The database holds every rule checked here (a size is pick-exactly-one, min <= max, free picks <=
// max), so the checks exist to put the sentence in the right place, not to be the guard.
//
// S760: a non-size group also says what a bigger SIZE does to its picks — nothing, more stock, or
// more stock and a higher price. A size group is always "nothing" (the database holds that too).
// The column is written only when it differs from what is saved, so an ordinary edit still saves on
// a database the S760 migration has not reached.
//
// S862 SETUP-3: the dialog runs the checks the page's Hide and Show again run. `catalog` is the
// page's { groups, options, attachments } and `attachedDishes` the dishes this group is on, so a
// save that would let one of them be ordered below zero is refused (ticking Shown on a hidden group
// was the unchecked way back), and one that leaves a dish with more to pick than the group offers
// asks first. SETUP-4: a group holding a "No …" choice cannot become a Size (the database refuses
// it as group_kind_has_removals), so that is said when Size is picked, from `group.options`.
//
// S867 (critique): the words follow the owner's list (a guest taps a choice; the kind stored as
// 'choice' reads Preference). The size-scaling chooser shows only where it can matter: a client
// with a build-your-own dish, or a group already set to scale. Hidden, it saves what it would have
// (none for a new group, the stored value for an edit). The dialog keeps OptionModal's shape, a
// scrolling body under 90vh with the buttons outside it, so Create stays on a 390px phone screen.

// The three kinds differ in what they DO, and the hint says that rather than repeating the pick
// rule twice: a size prices the dish (as a difference that follows the dish's own price, S809 4h),
// an add-on can add to it, a preference is usually free.
const KINDS = [
  { key: 'size',   title: 'Size',       example: 'Half / Full · Small / Large', hint: 'Picks one · each size prices the dish and moves with it', rule: { min: 1, max: 1 } },
  { key: 'addon',  title: 'Add-ons',    example: 'Extra cheese · Add egg · No onion', hint: 'Picks several · each can add to the price', rule: { min: 0, max: null } },
  { key: 'choice', title: 'Preference', example: 'Mild / Medium / Hot',         hint: 'Picks one · usually free',                   rule: { min: 1, max: 1 } },
]

const MIN_CHOICES = [0, 1, 2, 3, 4, 5]
const MAX_CHOICES = [1, 2, 3, 4, 5, 6, 8, 10]

const minLabel = n => (n === 0 ? 'may skip this' : n === 1 ? 'must choose at least 1' : `must choose at least ${n}`)
const maxLabel = n => (n == null ? 'any number' : n === 1 ? 'only 1' : `up to ${n}`)

// A saved group can hold a value the dropdown does not list; keep it selectable rather than
// silently snapping it to the nearest one on open.
const withCurrent = (list, v) => (v == null || list.includes(v) ? list : [...list, v].sort((a, b) => a - b))

export default function OptionGroupModal({ group, attachedCount = 0, nextSort, catalog = null, attachedDishes = [], onClose, onSaved }) {
  const { scopedInsert, scopedUpdate } = useScopedDb()
  const { ask, confirmEl } = useConfirm()
  const [name, setName] = useState(group?.name || '')
  const [kind, setKind] = useState(group?.kind || 'addon')
  const [min, setMin] = useState(group ? (group.min_select ?? 0) : 0)
  const [max, setMax] = useState(group ? (group.max_select ?? null) : null)
  const [included, setIncluded] = useState(group?.included_count || 0)
  const [kitchenName, setKitchenName] = useState(group?.kitchen_name || '')
  const [active, setActive] = useState(group ? group.is_active !== false : true)
  const [scaling, setScaling] = useState(group?.size_scaling || 'none')
  const [moreOpen, setMoreOpen] = useState(() => !!(group && (group.kitchen_name || group.included_count || group.is_active === false)))
  const [nameError, setNameError] = useState('')
  const [saving, setSaving] = useState(false)
  // Save stays pressable while it writes (disabling it drops keyboard focus to the page), so a second
  // press is turned away here; a ref, because a press can land before the re-render.
  const busyRef = useRef(false)
  const [actionError, setActionError] = useState(null)

  const isSize = kind === 'size'
  const effMin = isSize ? 1 : min
  const effMax = isSize ? 1 : max
  const effIncluded = kind === 'addon' ? Math.min(included, effMax ?? included) : 0
  const removalBlocksSize = isSize && !!group && group.kind !== 'size' && (group.options || []).some(o => o.is_removal)
  // S867: only a build-your-own dish scales a group by size, so the chooser is offered where one
  // exists, or where this group already scales (so it can be set back).
  const offerScaling = !isSize && ((catalog?.buildYourOwn?.length || 0) > 0 || (group?.size_scaling || 'none') !== 'none')

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

  function save() {
    if (busyRef.current || saving) return
    if (!name.trim()) { setNameError('Give the group a name — guests see it, e.g. “Extras” or “Choose your size”.'); return }
    setNameError('')
    if (removalBlocksSize) return
    setActionError(null)
    const nextScaling = isSize ? 'none' : scaling
    if (group) {
      const next = { kind, min_select: effMin, max_select: effMax, included_count: effIncluded, is_active: active, size_scaling: nextScaling }
      const { belowZero, short } = groupEditEffects(group, next, catalog, attachedDishes)
      if (belowZero.length) {
        setActionError(groupEditRefusal(group.name, belowZero, { showing: group.is_active === false && active }))
        return
      }
      if (short.length) {
        const nameOf = id => attachedDishes.find(d => d.id === id)?.name || 'a dish'
        ask({
          title: `Save “${name.trim()}”?`,
          confirmLabel: 'Save anyway',
          busyLabel: 'Saving…',
          body: <p style={{ margin: 0 }}>{shortfallText(name.trim(), short, nameOf)}</p>,
          run: () => write(nextScaling),
        })
        return
      }
    }
    return write(nextScaling)
  }

  async function write(nextScaling) {
    if (busyRef.current) return
    busyRef.current = true
    try { await writeRow(nextScaling) } finally { busyRef.current = false }
  }

  async function writeRow(nextScaling) {
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
    if (nextScaling !== (group?.size_scaling || 'none')) row.size_scaling = nextScaling
    const { data, error } = await settleWithin(group
      ? scopedUpdate('pos_option_groups', row).eq('id', group.id).select(GROUP_COLS)
      : scopedInsert('pos_option_groups', { ...row, sort: nextSort || 0 }),
    CUSTOMIZATION_WRITE_MS, 'Saving the group')
    setSaving(false)
    if (error) { setActionError(writeFailure(error)); return }
    // A zero-row update is a refusal that says nothing (S738): the group was removed meanwhile.
    if (group && !data?.length) {
      setActionError('This group no longer exists — it may have been deleted on another device. Close this and reload the page.')
      return
    }
    onSaved(Array.isArray(data) ? data[0] : data)
  }

  const summary = ruleText({ min: effMin, max: effMax, included: effIncluded })
  // Changing a live group's kind resets its pick rule for every dish it is on. Said before Save,
  // not discovered on the till. Since S809 4h (CUSTOMIZATION-7) the database clears each dish's own
  // rule for the group in the same save (`pos_option_group_kind_resets_rules`), so this holds.
  const kindChangedLive = !!group && kind !== group.kind && attachedCount > 0

  return (
    <Modal onClose={onClose} title={group ? `Edit group — ${group.name}` : 'New choice group'} maxWidth={560}
      panelStyle={{ maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}>
      <div style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 20, paddingRight: 2 }}>
        <div className="form-field" style={{ margin: 0 }}>
          <label htmlFor="og-name">Name</label>
          <input id="og-name" autoFocus value={name} onChange={e => setName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && save()}
            placeholder="e.g. Extras" {...fieldAria('og-name', nameError)} />
          <FieldError id="og-name" message={nameError} />
        </div>

        {/* Inside a .form-field, so the caption takes the same type as "Name" above it (S863). */}
        <div className="form-field" style={{ margin: 0 }}>
          <span className="field-label" id="og-kind-label">What is it?</span>
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
          {removalBlocksSize && (
            <p role="alert" className="field-error" style={{ margin: 0 }}>
              This group has a “No …” choice, and a size cannot be one. Delete the “No …” choice first, or keep the group as Add-ons or Preference.
            </p>
          )}
          {kindChangedLive && !removalBlocksSize && (
            <p role="alert" style={{ margin: 0, fontSize: 12, color: 'var(--theme-amber-text)' }}>
              This group is on {attachedCount} dish{attachedCount === 1 ? '' : 'es'}. Changing its kind resets the rule to “{summary}” for all of them the moment you save, including any rule a dish had of its own; bills already rung are not affected.
            </p>
          )}
        </div>

        {isSize ? (
          <p style={{ margin: 0, fontSize: 13, color: 'var(--theme-text2)' }}>
            {/* S867: the order that makes a size take its full menu price, said where Size is picked. */}
            Guests always pick exactly one size. {attachedCount > 0
              ? 'You set each size’s price when you add it.'
              : 'Put the group on its dishes before you add the sizes, so each size takes its full menu price.'}
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

        {offerScaling && (
          <div className="form-field" style={{ margin: 0 }}>
            <span className="field-label" id="og-scaling-label">
              <Tip width={320} text="For build-your-own dishes. A size carries a portion — Small 0.75, Large 1.5 — and this decides what that portion does to the choices in this group. Example: toppings on an acai bowl scale stock and price, so chicken popcorn on a Large bowl uses 1.5× the chicken and costs 1.5× as much.">When a bigger size is picked</Tip>
            </span>
            <div role="radiogroup" aria-labelledby="og-scaling-label"
              onKeyDown={e => moveRovingFocus(e, '[role="radio"]')?.click()}
              style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 }}>
              {Object.keys(SIZE_SCALING_LABEL).map(k => {
                const on = scaling === k
                return (
                  <button key={k} type="button" role="radio" aria-checked={on} className="choice-chip"
                    tabIndex={rovingTabIndex(on)} onClick={() => setScaling(k)}>
                    <span className="choice-chip__name">{SIZE_SCALING_LABEL[k]}</span>
                  </button>
                )
              })}
            </div>
            <p style={{ margin: 0, fontSize: 12, color: 'var(--theme-text2)' }}>{SIZE_SCALING_HELP[scaling]}</p>
          </div>
        )}

        <p style={{ margin: 0, fontSize: 13, color: 'var(--theme-text2)' }}>
          Guests will see: <strong style={{ color: 'var(--theme-text1)' }}>{summary}</strong>
        </p>

        <div>
          <button type="button" className="btn btn-ghost btn-sm" aria-expanded={moreOpen} aria-controls="og-more"
            onClick={() => setMoreOpen(o => !o)}>
            {moreOpen ? '▾' : '▸'} More settings
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
                    <Tip width={300} text="For a deal like “2 toppings included, pay for each extra”. Of what the guest picks, the ones listed EARLIEST in this group are the free ones — not the cheapest — so put the choices you are happy to give away at the top of the list (↑ on the Choice Groups page). The till and guest menu show a choice as Included once it is free. A “No …” choice is never a free one, and it takes no place under “up to”.">Free choices before charging</Tip>
                  </label>
                  <select id="og-incl" className="form-select" value={effIncluded} onChange={e => setIncluded(Number(e.target.value))} style={{ width: 'auto' }}>
                    {Array.from({ length: (effMax ?? 10) + 1 }, (_, n) => n).map(n => (
                      <option key={n} value={n}>{n === 0 ? 'None — every choice is charged' : `First ${n} free`}</option>
                    ))}
                  </select>
                </div>
              )}
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                <input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} />
                <Tip width={260} text="Untick to hide this group without deleting it — the same as Hide on the Choice Groups page. It stays on its dishes; old bills are not affected.">Shown on the till and guest menu</Tip>
              </label>
            </div>
          )}
        </div>

        <ActionError error={actionError} />
      </div>
      {confirmEl}
      <div className="form-actions form-actions--split">
        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={save}
          aria-disabled={removalBlocksSize || undefined} aria-busy={saving || undefined}>
          {saving ? 'Saving…' : group ? 'Save group' : 'Create group'}
        </button>
      </div>
    </Modal>
  )
}
