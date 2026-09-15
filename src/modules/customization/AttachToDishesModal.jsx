import { useMemo, useState } from 'react'
import Modal from '../../components/Modal'
import ActionError, { asActionError } from '../../components/ActionError'
import { useScopedDb } from '../../shared/hooks/useScopedDb'
import { npr } from '../../shared/nepalMoney'

// Attach ONE group to many dishes — the bulk half of attaching (S759).
//
// AttachGroupsModal is dish → groups, which is the right shape from Menu Pricing ("what does this
// momo offer?") and the wrong one for setup: an owner who has just built "Size" has forty dishes
// to put it on and was paying forty dialogs. This is group → dishes: every dish under its category,
// a select-all per category, a search box, and one save.
//
// Saving is the same DIFF AttachGroupsModal does — ticked dishes upserted first, unticked deleted
// after — so a failure part-way leaves more attached rather than less. A new attachment takes the
// next sort slot on ITS dish, so it lands after whatever that dish already offers; per-dish
// overrides (min/max/default) are left to the dish dialog and untouched here.

export default function AttachToDishesModal({ group, dishes, attachments, onClose, onSaved }) {
  const { scopedUpsert, scopedDelete } = useScopedDb()
  const initial = useMemo(
    () => new Set(attachments.filter(a => a.group_id === group.id).map(a => a.recipe_id)),
    [attachments, group.id],
  )
  const [picked, setPicked] = useState(() => new Set(initial))
  const [search, setSearch] = useState('')
  const [saving, setSaving] = useState(false)
  const [actionError, setActionError] = useState(null)

  const byCategory = useMemo(() => {
    const q = search.trim().toLowerCase()
    const map = new Map()
    dishes.forEach(d => {
      if (q && !d.name.toLowerCase().includes(q) && !(d.category || '').toLowerCase().includes(q)) return
      const cat = d.category || 'No category'
      if (!map.has(cat)) map.set(cat, [])
      map.get(cat).push(d)
    })
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [dishes, search])

  const changed = useMemo(() => {
    let n = 0
    dishes.forEach(d => { if (picked.has(d.id) !== initial.has(d.id)) n++ })
    return n
  }, [dishes, picked, initial])

  const toggle = id => setPicked(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n })
  const setMany = (ids, on) => setPicked(p => { const n = new Set(p); ids.forEach(id => (on ? n.add(id) : n.delete(id))); return n })

  async function save() {
    if (saving) return
    setSaving(true)
    setActionError(null)
    const nextSortByDish = {}
    attachments.forEach(a => { nextSortByDish[a.recipe_id] = Math.max(nextSortByDish[a.recipe_id] ?? -1, a.sort || 0) })
    const adds = dishes.filter(d => picked.has(d.id) && !initial.has(d.id)).map(d => ({
      recipe_id: d.id, group_id: group.id, sort: (nextSortByDish[d.id] ?? -1) + 1,
    }))
    if (adds.length) {
      const { error } = await scopedUpsert('pos_recipe_option_groups', adds, { onConflict: 'recipe_id,group_id' })
      if (error) { setSaving(false); setActionError(asActionError(error)); return }
    }
    const removeIds = attachments.filter(a => a.group_id === group.id && !picked.has(a.recipe_id)).map(a => a.id)
    if (removeIds.length) {
      const { error } = await scopedDelete('pos_recipe_option_groups').in('id', removeIds)
      if (error) {
        setSaving(false)
        const a = asActionError(error)
        setActionError({ text: `The dishes you ticked now offer “${group.name}”, but the ones you unticked still do. ${a.text}`, detail: a.detail })
        onSaved?.({ partial: true })
        return
      }
    }
    setSaving(false)
    onSaved?.({ added: adds.length, removed: removeIds.length })
    onClose()
  }

  const pickedCount = dishes.filter(d => picked.has(d.id)).length

  return (
    <Modal onClose={onClose} title={`Offer “${group.name}” on…`} maxWidth={620}
      panelStyle={{ maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}>
      <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--theme-text2)' }}>
        Tick every dish that offers this group. A ticked dish opens the choice window on the till and the choice sheet on the QR menu.
      </p>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        <input className="form-input form-input--auto" style={{ width: 240 }} placeholder="Search dishes…"
          aria-label="Search dishes by name or category" value={search} onChange={e => setSearch(e.target.value)} />
        <span style={{ fontSize: 12, color: 'var(--theme-text2)' }}>
          {pickedCount} of {dishes.length} dish{dishes.length === 1 ? '' : 'es'}
        </span>
        <button type="button" className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }}
          onClick={() => setMany(dishes.map(d => d.id), pickedCount < dishes.length)}>
          {pickedCount < dishes.length ? 'Select all' : 'Clear all'}
        </button>
      </div>

      <div style={{ overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: 14 }}>
        {dishes.length === 0 ? (
          <div className="empty-state">No dishes yet. Dishes are made in Recipe Costing (or Menu Pricing on a POS-only plan).</div>
        ) : byCategory.length === 0 ? (
          <div className="empty-state">No dishes match “{search.trim()}”.</div>
        ) : byCategory.map(([cat, list]) => {
          const on = list.filter(d => picked.has(d.id)).length
          const all = on === list.length
          return (
            <section key={cat} aria-labelledby={`atd-${cat}`}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, fontSize: 13, marginBottom: 6, cursor: 'pointer' }}>
                <input type="checkbox" checked={all} ref={el => { if (el) el.indeterminate = on > 0 && !all }}
                  aria-label={`Every dish in ${cat}`} onChange={() => setMany(list.map(d => d.id), !all)} />
                <span id={`atd-${cat}`}>{cat}</span>
                <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--theme-text3)' }}>{on} of {list.length}</span>
              </label>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 4, paddingLeft: 24 }}>
                {list.map(d => (
                  <label key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, minHeight: 32, cursor: 'pointer' }}>
                    <input type="checkbox" checked={picked.has(d.id)} onChange={() => toggle(d.id)} />
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</span>
                    <span style={{ fontSize: 11, color: 'var(--theme-text3)', whiteSpace: 'nowrap' }}>
                      {d.inclPrice > 0 ? npr(d.inclPrice) : ''}{d.pos_enabled ? '' : ' · not on POS'}
                    </span>
                  </label>
                ))}
              </div>
            </section>
          )
        })}
      </div>
      <ActionError error={actionError} />
      <div style={{ display: 'flex', gap: 10, marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--theme-border)', flexShrink: 0 }}>
        <button className="btn btn-ghost" style={{ flex: 1, justifyContent: 'center' }} onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" style={{ flex: 2, justifyContent: 'center' }} onClick={save}
          disabled={saving || changed === 0} aria-busy={saving || undefined}>
          {saving ? 'Saving…' : changed ? `Save (${changed} change${changed === 1 ? '' : 's'})` : 'No changes'}
        </button>
      </div>
    </Modal>
  )
}
