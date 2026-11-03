import { useEffect, useMemo, useRef, useState } from 'react'
import Modal from '../../components/Modal'
import Tip from '../../components/Tip'
import ActionError from '../../components/ActionError'
import FieldError, { fieldAria } from '../../components/FieldError'
import ReportLoadError from '../../components/ReportLoadError'
import { useScopedDb } from '../../shared/hooks/useScopedDb'
import { settleWithin, isTimeout } from '../../utils/withTimeout'
import { loadOptionCatalog, KIND_LABEL, CUSTOMIZATION_READ_MS, CUSTOMIZATION_WRITE_MS, writeFailure } from './customizationData'
import { effectiveRule, ruleText, dishesBelowZero, belowZeroText, belowZeroAmount } from '../../shared/optionPricing'
import { andList } from '../../shared/offeredPicks'
import { twoSizesText } from './optionChecks'

// Which option groups one dish offers. Opened from two places that must behave identically — the
// Dishes tab of Option Groups and the "Customize" button on Menu Pricing — so it loads its own data
// rather than trusting whichever page opened it to have loaded the same columns.
//
// Saving is a DIFF: ticked groups are upserted on (recipe_id, group_id), unticked ones deleted
// afterwards, so a failure part-way leaves more attached rather than less. Both halves are keyed
// writes, so pressing Save again after a timeout sets the same groups again (S852).

const RETRY_IS_SAFE = 'Saving again is safe, because it sets the same groups again.'
// Save is a precondition press while the dialog cannot save (S863): it stays pressable and says why.
const STILL_LOADING = 'The groups are still loading. Save once they appear.'
const NOT_LOADED = 'The groups could not be loaded, so there is nothing to save yet. Press Try again above.'

const toInt = v => (v === '' || v == null ? null : Number.parseInt(v, 10))

export default function AttachGroupsModal({ recipe, onClose, onSaved }) {
  const { scopedFrom, scopedUpsert, scopedDelete } = useScopedDb()
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [groups, setGroups] = useState([])
  const [options, setOptions] = useState([])
  const [optionsByGroup, setOptionsByGroup] = useState({})
  const [existing, setExisting] = useState([])
  const [draft, setDraft] = useState({}) // { [groupId]: { on, min, max, def, sort } }
  const [saving, setSaving] = useState(false)
  // A second press mid-save is dropped by this ref, not by disabling the focused button (S863).
  const savingRef = useRef(false)
  const [actionError, setActionError] = useState(null)
  const [earlyPress, setEarlyPress] = useState(false) // Save pressed before the groups were read
  const [attempt, setAttempt] = useState(0) // Retry after a failed or timed-out load (S852)
  // After a move, focus goes to the moved group's same arrow, or its other one at an end (S863).
  const pendingFocus = useRef(null)

  useEffect(() => {
    let alive = true
    ;(async () => {
      // settleWithin answers a timeout as `{ error }`, the shape a refused catalog read already has.
      const cat = await settleWithin(loadOptionCatalog(scopedFrom, { recipeId: recipe.id }), CUSTOMIZATION_READ_MS, 'Loading the choices')
      if (!alive) return
      if (cat.error) { setLoadError(cat.error); setLoading(false); return }
      const byGroup = {}
      cat.options.filter(o => o.is_active !== false).forEach(o => {
        if (!byGroup[o.group_id]) byGroup[o.group_id] = []
        byGroup[o.group_id].push(o)
      })
      const current = {}
      cat.attachments.forEach(a => {
        current[a.group_id] = {
          on: true,
          min: a.min_override == null ? '' : String(a.min_override),
          max: a.max_override == null ? '' : String(a.max_override),
          def: a.default_option_id || '',
          sort: a.sort || 0,
        }
      })
      setGroups(cat.groups)
      setOptions(cat.options)
      setOptionsByGroup(byGroup)
      setExisting(cat.attachments)
      setDraft(current)
      setLoading(false)
    })()
    return () => { alive = false }
  }, [recipe.id, scopedFrom, attempt])

  function retryLoad() {
    setLoading(true)
    setLoadError(null)
    setEarlyPress(false)
    setAttempt(n => n + 1)
  }

  const visibleGroups = useMemo(
    // A hidden group that is still attached stays listed, so it can be detached.
    () => groups.filter(g => g.is_active !== false || draft[g.id]?.on),
    [groups, draft],
  )
  const chosen = visibleGroups.filter(g => draft[g.id]?.on)
  // S862 SETUP-8: two Size groups on one dish ask for two sizes and multiply both portions.
  const twoSizes = twoSizesText(recipe.name, chosen.filter(g => g.kind === 'size').map(g => g.name))

  // S809 4h (CUSTOMIZATION-6, D17): a setup that takes this dish below zero is refused here, before
  // the till refuses it mid-service. Option Groups passes the dish with `inclPrice`, Menu Pricing
  // its row with `exVat` / `inclVat`. S835: over the whole dish as it would be saved — every ticked
  // group with this dish's own must-pick / at-most — so two cheaper groups that only go below zero
  // together are caught, and so is unticking a paid group a cheaper size was leaning on. A dish
  // already below zero that the ticks here leave alone is said, not refused: the fix is a price.
  const dish = { ...recipe, selling_price: recipe.selling_price ?? recipe.exVat, inclPrice: recipe.inclPrice ?? recipe.inclVat }
  const draftAttachments = chosen.map(g => ({
    recipe_id: recipe.id,
    group_id: g.id,
    min_override: g.kind === 'size' ? null : toInt(draft[g.id].min),
    max_override: g.kind === 'size' ? null : toInt(draft[g.id].max),
    sort: draft[g.id].sort ?? 0,
  }))
  const before = { groups, options, attachments: existing }
  const belowZero = loading || loadError ? [] : dishesBelowZero([dish], { groups, options, attachments: draftAttachments }, { before })
  const alreadyBelow = loading || loadError || belowZero.length ? [] : dishesBelowZero([dish], { groups, options, attachments: draftAttachments })

  const toggle = g => setDraft(d => {
    const cur = d[g.id]
    if (cur?.on) return { ...d, [g.id]: { ...cur, on: false } }
    const nextSort = Math.max(-1, ...Object.values(d).filter(x => x.on).map(x => x.sort || 0)) + 1
    return { ...d, [g.id]: { on: true, min: cur?.min ?? '', max: cur?.max ?? '', def: cur?.def ?? '', sort: cur?.sort ?? nextSort } }
  })
  const patch = (gid, p) => setDraft(d => ({ ...d, [gid]: { ...d[gid], ...p } }))

  // `field` is the box that is wrong (S863), so the message sits under it and Save focuses it.
  // 'both' is a minimum above a maximum this dish set too: one sentence names both boxes.
  function overrideError(g) {
    const d = draft[g.id]
    if (!d?.on || g.kind === 'size') return null
    const min = toInt(d.min), max = toInt(d.max)
    if (d.min !== '' && (!Number.isInteger(min) || min < 0)) return { field: 'min', text: 'Minimum must be 0 or more.' }
    if (d.max !== '' && (!Number.isInteger(max) || max < 1)) return { field: 'max', text: 'Maximum must be 1 or more.' }
    const rule = effectiveRule(g, { min_override: min, max_override: max })
    if (rule.max != null && rule.min > rule.max) {
      const field = d.min !== '' && d.max !== '' ? 'both' : d.max !== '' ? 'max' : 'min'
      return { field, text: 'Minimum cannot be above maximum for this dish.' }
    }
    return null
  }

  // S862 SETUP-3: a minimum above what the group offers takes the dish off the till and the QR
  // menu (option_count), so it is said here rather than found after the save. A group with nothing
  // to pick is skipped by the server, and a hidden one is not offered, so neither is named.
  function shortNote(g, rule) {
    const offered = (optionsByGroup[g.id] || []).length
    if (g.is_active === false || offered === 0 || !(rule.min > offered)) return null
    return `${recipe.name} must pick ${rule.min} from “${g.name}”, which offers only ${offered} option${offered === 1 ? '' : 's'}, so it cannot be ordered on the till or the QR menu until the group has more options or the minimum is lowered.`
  }

  // The order the picker and the guest sheet show the groups in. Chosen groups are listed by
  // their draft sort; a move swaps two of them and renumbers densely so a save writes what is on
  // screen (S759).
  const ordered = useMemo(
    () => chosen.slice().sort((a, b) => (draft[a.id]?.sort ?? 0) - (draft[b.id]?.sort ?? 0)),
    [chosen, draft],
  )
  function moveGroup(idx, dir) {
    const other = idx + dir
    if (other < 0 || other >= ordered.length) return
    const seq = ordered.slice()
    ;[seq[idx], seq[other]] = [seq[other], seq[idx]]
    pendingFocus.current = { id: ordered[idx].id, dir }
    setDraft(d => {
      const n = { ...d }
      seq.forEach((g, i) => { n[g.id] = { ...n[g.id], sort: i } })
      return n
    })
  }
  // The arrow just pressed can land at an end of the list and turn disabled, which drops focus
  // to the page; the moved group's other arrow takes it then.
  useEffect(() => {
    const t = pendingFocus.current
    if (!t) return
    pendingFocus.current = null
    const arrow = d => document.getElementById(`att-move-${d < 0 ? 'up' : 'down'}-${t.id}`)
    const same = arrow(t.dir)
    ;(same && !same.disabled ? same : arrow(-t.dir))?.focus()
  }, [draft])

  async function save() {
    if (savingRef.current) return
    if (loading || loadError) { setEarlyPress(true); return }
    if (belowZero.length) return
    // The rule error is already under its own fields (inline, role="alert"); a second copy at the
    // bottom was two channels for one message. Take the reader to the box that is wrong.
    const badGroup = ordered.find(g => overrideError(g))
    if (badGroup) {
      const { field } = overrideError(badGroup)
      document.getElementById(`att-${field === 'max' ? 'max' : 'min'}-${badGroup.id}`)?.focus()
      return
    }
    savingRef.current = true
    setSaving(true)
    setActionError(null)
    try {
      await writeChoices()
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  async function writeChoices() {
    const rows = ordered.map((g, i) => {
      const d = draft[g.id]
      return {
        recipe_id: recipe.id,
        group_id: g.id,
        min_override: g.kind === 'size' ? null : toInt(d.min),
        max_override: g.kind === 'size' ? null : toInt(d.max),
        default_option_id: d.def || null,
        sort: i,
      }
    })
    if (rows.length) {
      const { error } = await settleWithin(scopedUpsert('pos_recipe_option_groups', rows, { onConflict: 'recipe_id,group_id' }),
        CUSTOMIZATION_WRITE_MS, 'Saving the choices')
      if (error) {
        setActionError(writeFailure(error, RETRY_IS_SAFE))
        return
      }
    }
    const removed = existing.filter(a => !draft[a.group_id]?.on)
    const removedIds = removed.map(a => a.id)
    if (removedIds.length) {
      const { data, error } = await settleWithin(scopedDelete('pos_recipe_option_groups').in('id', removedIds).select('id'),
        CUSTOMIZATION_WRITE_MS, 'Saving the choices')
      if (error) {
        const a = writeFailure(error, RETRY_IS_SAFE)
        setActionError(isTimeout(error)
          ? { text: `The groups you ticked were saved, but the server took too long to answer about the ones you unticked, so they may still be on ${recipe.name}. ${RETRY_IS_SAFE}`, detail: a.detail }
          : { text: `The groups you ticked were saved, but the ones you unticked are still on ${recipe.name}. ${a.text}`, detail: a.detail })
        onSaved?.(rows.length, { partial: true })
        return
      }
      // S862 SETUP-10: a delete RLS matched to nothing (the outlet moved on another device) answers
      // with no error, so the rows it returned are what came off.
      const gone = new Set((data || []).map(r => r.id))
      const left = removed.filter(a => !gone.has(a.id))
      if (left.length) {
        const nameOf = a => `“${groups.find(g => g.id === a.group_id)?.name || 'a group'}”`
        setActionError(`${rows.length ? 'The groups you ticked were saved, but ' : ''}${andList(left.map(nameOf))} may still be on ${recipe.name}: it may have changed on another device. Reload the page to check before you save again.`)
        onSaved?.(rows.length, { partial: true })
        return
      }
    }
    onSaved?.(rows.length)
    onClose()
  }

  return (
    <Modal onClose={onClose} title={`Choices — ${recipe.name}`} maxWidth={620}
      panelStyle={{ maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}>
      <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--theme-text2)' }}>
        Tick the option groups this dish offers, in the order guests should see them. A dish with none ticked is ordered exactly as today — one tap, no choices.
      </p>
      <div style={{ overflowY: 'auto', flex: 1 }}>
        {loading ? (
          <div className="loading-state">Loading…</div>
        ) : loadError ? (
          <ReportLoadError error={loadError} onRetry={retryLoad} />
        ) : visibleGroups.length === 0 ? (
          <div className="empty-state">No option groups yet. Create one on the Option Groups page first — for example “Size” or “Extras”.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {[...ordered, ...visibleGroups.filter(g => !draft[g.id]?.on)].map(g => {
              const d = draft[g.id]
              const on = !!d?.on
              const pos = on ? ordered.indexOf(g) : -1
              const opts = optionsByGroup[g.id] || []
              const rule = effectiveRule(g, on ? { min_override: toInt(d.min), max_override: toInt(d.max) } : null)
              const err = overrideError(g)
              // The box(es) the message is about; 'both' shares one message between the two boxes.
              const errId = err ? `att-${err.field === 'max' ? 'max' : 'min'}-${g.id}` : null
              const minAria = err && err.field !== 'max' ? fieldAria(errId, err.text) : {}
              const maxAria = err && err.field !== 'min' ? fieldAria(errId, err.text) : {}
              const earlier = `Show ${g.name} earlier`, later = `Show ${g.name} later`
              return (
                <div key={g.id} className="card card--compact" style={{ margin: 0, borderColor: on ? 'var(--theme-accent)' : undefined }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                    {/* Wraps on a phone (S863), so the rule text never runs under the arrows. */}
                    <label style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '4px 10px', cursor: 'pointer', flex: 1, minWidth: 0, minHeight: 30 }}>
                      <input type="checkbox" checked={on} onChange={() => toggle(g)} />
                      {on && <span style={{ fontSize: 11, color: 'var(--theme-text3)', minWidth: 14 }}>{pos + 1}.</span>}
                      <span style={{ fontWeight: 600, minWidth: 0, overflowWrap: 'break-word' }}>{g.name}</span>
                      <span className="badge-gray">{KIND_LABEL[g.kind]}</span>
                      {g.is_active === false && <span className="badge-gray">Hidden</span>}
                      <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--theme-text2)' }}>{ruleText(rule)}</span>
                    </label>
                    {on && ordered.length > 1 && (
                      <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
                        <button type="button" id={`att-move-up-${g.id}`} className="btn btn-ghost btn-icon" aria-label={earlier} title={earlier}
                          disabled={pos === 0} onClick={() => moveGroup(pos, -1)}>↑</button>
                        <button type="button" id={`att-move-down-${g.id}`} className="btn btn-ghost btn-icon" aria-label={later} title={later}
                          disabled={pos === ordered.length - 1} onClick={() => moveGroup(pos, 1)}>↓</button>
                      </div>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--theme-text3)', margin: '4px 0 0 26px' }}>
                    {opts.length ? opts.map(o => o.name).join(' · ') : 'No options in this group yet'}
                  </div>
                  {on && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, margin: '10px 0 0 26px', alignItems: 'flex-end' }}>
                      {g.kind !== 'size' && (
                        <>
                          <div className="form-field" style={{ margin: 0 }}>
                            <label htmlFor={`att-min-${g.id}`}>
                              <Tip width={240} text="Leave blank to use the group's own rule. Set it to require a pick on this dish only.">Must pick (this dish)</Tip>
                            </label>
                            <input id={`att-min-${g.id}`} type="number" min="0" step="1" value={d.min} placeholder={String(g.min_select ?? 0)}
                              aria-label={`Must pick (this dish) from ${g.name}`} {...minAria}
                              onChange={e => patch(g.id, { min: e.target.value })} style={{ width: 90 }} />
                          </div>
                          <div className="form-field" style={{ margin: 0 }}>
                            <label htmlFor={`att-max-${g.id}`}>
                              <Tip width={240} text="Leave blank to use the group's own limit.">At most (this dish)</Tip>
                            </label>
                            <input id={`att-max-${g.id}`} type="number" min="1" step="1" value={d.max}
                              placeholder={g.max_select == null ? 'No limit' : String(g.max_select)}
                              aria-label={`At most (this dish) from ${g.name}`} {...maxAria}
                              onChange={e => patch(g.id, { max: e.target.value })} style={{ width: 90 }} />
                          </div>
                        </>
                      )}
                      {opts.length > 0 && (
                        <div className="form-field" style={{ margin: 0 }}>
                          <label htmlFor={`att-def-${g.id}`}>
                            <Tip width={260} text="Pre-ticked when this dish is ordered. “Group default” uses whichever options are marked pre-selected in the group.">Pre-selected on this dish</Tip>
                          </label>
                          <select id={`att-def-${g.id}`} className="form-select" value={d.def} onChange={e => patch(g.id, { def: e.target.value })}
                            aria-label={`Pre-selected on this dish from ${g.name}`}>
                            <option value="">Group default</option>
                            {opts.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                          </select>
                        </div>
                      )}
                      {err && <div style={{ flexBasis: '100%' }}><FieldError id={errId} message={err.text} /></div>}
                      {!err && shortNote(g, rule) && (
                        <span role="status" style={{ flexBasis: '100%', fontSize: 12, color: 'var(--theme-amber-text)' }}>△ {shortNote(g, rule)}</span>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
      {belowZero.length > 0 && (
        <p role="alert" className="field-error" style={{ margin: '12px 0 0' }}>
          {belowZeroText(belowZero)}, and the till refuses a dish priced below zero. Change what is ticked here, or change the prices in Option Groups first.
        </p>
      )}
      {twoSizes && (
        <p role="status" style={{ margin: '12px 0 0', fontSize: 13, color: 'var(--theme-amber-text)' }}>△ {twoSizes}</p>
      )}
      {alreadyBelow.length > 0 && (
        <p role="status" style={{ margin: '12px 0 0', fontSize: 13, color: 'var(--theme-amber-text)' }}>
          △ {recipe.name} can already reach {belowZeroAmount(alreadyBelow[0].incl)} with these choices, and the till refuses it at that price — fix its prices in Option Groups.
        </p>
      )}
      <ActionError error={actionError || (earlyPress && loading ? STILL_LOADING : earlyPress && loadError ? NOT_LOADED : null)} />
      <div className="form-actions form-actions--split">
        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={save}
          aria-disabled={(belowZero.length > 0 || loading || !!loadError) || undefined} aria-busy={saving || undefined}>
          {saving ? 'Saving…' : `Save${chosen.length ? ` (${chosen.length} group${chosen.length === 1 ? '' : 's'})` : ''}`}
        </button>
      </div>
    </Modal>
  )
}
