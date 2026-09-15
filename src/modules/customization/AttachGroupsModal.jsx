import { useEffect, useMemo, useState } from 'react'
import Modal from '../../components/Modal'
import Tip from '../../components/Tip'
import ActionError, { asActionError } from '../../components/ActionError'
import ReportLoadError from '../../components/ReportLoadError'
import { useScopedDb } from '../../shared/hooks/useScopedDb'
import { loadOptionCatalog, KIND_LABEL } from './customizationData'
import { effectiveRule, ruleText } from '../../shared/optionPricing'

// Which option groups one dish offers. Opened from two places that must behave identically — the
// Dishes tab of Option Groups and the "Customize" button on Menu Pricing — so it loads its own data
// rather than trusting whichever page opened it to have loaded the same columns.
//
// Saving is a DIFF: ticked groups are upserted on (recipe_id, group_id), unticked ones deleted
// afterwards, so a failure part-way leaves more attached rather than less.

const toInt = v => (v === '' || v == null ? null : Number.parseInt(v, 10))

export default function AttachGroupsModal({ recipe, onClose, onSaved }) {
  const { scopedFrom, scopedUpsert, scopedDelete } = useScopedDb()
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [groups, setGroups] = useState([])
  const [optionsByGroup, setOptionsByGroup] = useState({})
  const [existing, setExisting] = useState([])
  const [draft, setDraft] = useState({}) // { [groupId]: { on, min, max, def, sort } }
  const [saving, setSaving] = useState(false)
  const [actionError, setActionError] = useState(null)

  useEffect(() => {
    let alive = true
    ;(async () => {
      const cat = await loadOptionCatalog(scopedFrom, { recipeId: recipe.id })
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
      setOptionsByGroup(byGroup)
      setExisting(cat.attachments)
      setDraft(current)
      setLoading(false)
    })()
    return () => { alive = false }
  }, [recipe.id, scopedFrom])

  const visibleGroups = useMemo(
    // A hidden group that is still attached stays listed, so it can be detached.
    () => groups.filter(g => g.is_active !== false || draft[g.id]?.on),
    [groups, draft],
  )
  const chosen = visibleGroups.filter(g => draft[g.id]?.on)

  const toggle = g => setDraft(d => {
    const cur = d[g.id]
    if (cur?.on) return { ...d, [g.id]: { ...cur, on: false } }
    const nextSort = Math.max(-1, ...Object.values(d).filter(x => x.on).map(x => x.sort || 0)) + 1
    return { ...d, [g.id]: { on: true, min: cur?.min ?? '', max: cur?.max ?? '', def: cur?.def ?? '', sort: cur?.sort ?? nextSort } }
  })
  const patch = (gid, p) => setDraft(d => ({ ...d, [gid]: { ...d[gid], ...p } }))

  function overrideError(g) {
    const d = draft[g.id]
    if (!d?.on || g.kind === 'size') return null
    const min = toInt(d.min), max = toInt(d.max)
    if (d.min !== '' && (!Number.isInteger(min) || min < 0)) return 'Minimum must be 0 or more.'
    if (d.max !== '' && (!Number.isInteger(max) || max < 1)) return 'Maximum must be 1 or more.'
    const rule = effectiveRule(g, { min_override: min, max_override: max })
    if (rule.max != null && rule.min > rule.max) return 'Minimum cannot be above maximum for this dish.'
    return null
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
    setDraft(d => {
      const n = { ...d }
      seq.forEach((g, i) => { n[g.id] = { ...n[g.id], sort: i } })
      return n
    })
  }

  async function save() {
    if (saving) return
    // The rule error is already under its own fields (inline, role="alert"); a second copy at the
    // bottom was two channels for one message. Take the reader to the field instead.
    const badGroup = chosen.find(g => overrideError(g))
    if (badGroup) {
      document.getElementById(`att-min-${badGroup.id}`)?.focus()
      return
    }
    setSaving(true)
    setActionError(null)

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
      const { error } = await scopedUpsert('pos_recipe_option_groups', rows, { onConflict: 'recipe_id,group_id' })
      if (error) {
        setSaving(false)
        setActionError(asActionError(error))
        return
      }
    }
    const removedIds = existing.filter(a => !draft[a.group_id]?.on).map(a => a.id)
    if (removedIds.length) {
      const { error } = await scopedDelete('pos_recipe_option_groups').in('id', removedIds)
      if (error) {
        setSaving(false)
        const a = asActionError(error)
        setActionError({ text: `The groups you ticked were saved, but the ones you unticked are still on ${recipe.name}. ${a.text}`, detail: a.detail })
        onSaved?.(rows.length)
        return
      }
    }
    setSaving(false)
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
          <ReportLoadError error={loadError} />
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
              return (
                <div key={g.id} className="card card--compact" style={{ margin: 0, borderColor: on ? 'var(--theme-accent)' : undefined }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', flex: 1, minWidth: 0 }}>
                      <input type="checkbox" checked={on} onChange={() => toggle(g)} />
                      {on && <span style={{ fontSize: 11, color: 'var(--theme-text3)', minWidth: 14 }}>{pos + 1}.</span>}
                      <span style={{ fontWeight: 600 }}>{g.name}</span>
                      <span className="badge-yellow">{KIND_LABEL[g.kind]}</span>
                      {g.is_active === false && <span className="badge-gray">Hidden</span>}
                      <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--theme-text2)' }}>{ruleText(rule)}</span>
                    </label>
                    {on && ordered.length > 1 && (
                      <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
                        <button type="button" className="btn btn-ghost btn-icon" aria-label={`Show ${g.name} earlier`} disabled={pos === 0} onClick={() => moveGroup(pos, -1)}>↑</button>
                        <button type="button" className="btn btn-ghost btn-icon" aria-label={`Show ${g.name} later`} disabled={pos === ordered.length - 1} onClick={() => moveGroup(pos, 1)}>↓</button>
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
                              onChange={e => patch(g.id, { min: e.target.value })} style={{ width: 90 }} />
                          </div>
                          <div className="form-field" style={{ margin: 0 }}>
                            <label htmlFor={`att-max-${g.id}`}>
                              <Tip width={240} text="Leave blank to use the group's own limit.">At most (this dish)</Tip>
                            </label>
                            <input id={`att-max-${g.id}`} type="number" min="1" step="1" value={d.max}
                              placeholder={g.max_select == null ? 'No limit' : String(g.max_select)}
                              onChange={e => patch(g.id, { max: e.target.value })} style={{ width: 90 }} />
                          </div>
                        </>
                      )}
                      {opts.length > 0 && (
                        <div className="form-field" style={{ margin: 0 }}>
                          <label htmlFor={`att-def-${g.id}`}>
                            <Tip width={260} text="Pre-ticked when this dish is ordered. “Group default” uses whichever options are marked pre-selected in the group.">Pre-selected on this dish</Tip>
                          </label>
                          <select id={`att-def-${g.id}`} className="form-select" value={d.def} onChange={e => patch(g.id, { def: e.target.value })}>
                            <option value="">Group default</option>
                            {opts.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                          </select>
                        </div>
                      )}
                      {err && <span className="field-error" role="alert" style={{ flexBasis: '100%' }}>{err}</span>}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
      <ActionError error={actionError} />
      <div style={{ display: 'flex', gap: 10, marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--theme-border)', flexShrink: 0 }}>
        <button className="btn btn-ghost" style={{ flex: 1, justifyContent: 'center' }} onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" style={{ flex: 2, justifyContent: 'center' }} onClick={save}
          disabled={saving || loading || !!loadError} aria-busy={saving || undefined}>
          {saving ? 'Saving…' : `Save${chosen.length ? ` (${chosen.length} group${chosen.length === 1 ? '' : 's'})` : ''}`}
        </button>
      </div>
    </Modal>
  )
}
