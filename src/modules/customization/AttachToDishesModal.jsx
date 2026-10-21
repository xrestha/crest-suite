import { useMemo, useState } from 'react'
import Modal from '../../components/Modal'
import ActionError from '../../components/ActionError'
import { useScopedDb } from '../../shared/hooks/useScopedDb'
import { settleWithin } from '../../utils/withTimeout'
import { runChunkedByIds } from '../../shared/fetchAllRows'
import { CUSTOMIZATION_WRITE_MS, writeFailure, detachFailure } from './customizationData'
import { npr, nprInt } from '../../shared/nepalMoney'
import { dishesBelowZero, belowZeroText } from '../../shared/optionPricing'

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
// overrides (min/max/default) are left to the dish dialog and untouched here. Both halves are keyed
// writes, so pressing Save again after a timeout makes the same change again (S852).

const RETRY_IS_SAFE = 'Saving again is safe, because it makes the same change again.'

// `catalog` (S835): the page's { groups, options, attachments }, so each dish is priced over every
// group it offers, not this group alone.
export default function AttachToDishesModal({ group, dishes, attachments, catalog, onClose, onSaved }) {
  const { scopedUpsert, scopedDelete } = useScopedDb()
  const initial = useMemo(
    () => new Set(attachments.filter(a => a.group_id === group.id).map(a => a.recipe_id)),
    [attachments, group.id],
  )
  const dishById = useMemo(() => new Map(dishes.map(d => [d.id, d])), [dishes])
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

  // S809 4h (CUSTOMIZATION-6, D17): a dish newly ticked that this group takes below zero is refused
  // here, before the till refuses it mid-service. "Select all" on a category is how a NPR 80 Kids
  // Momo picks up a "Half" made NPR 100 cheaper. S835: each dish is priced over every group it
  // offers, so this group's −30 beside another group's −60 is caught too. A dish that ALREADY
  // carries the group and can go below zero is not this save's doing, so it is named, not refused
  // (owner decision, S835): unticking it would hide the problem rather than fix it. And taking a
  // group a dish MUST pick from off it can drop a paid pick a cheaper size was leaning on, so an
  // untick that lands a dish below zero is refused the same way.
  const { belowZero, droppedBelow, alreadyBelow } = useMemo(() => {
    const ticked = dishes.filter(d => picked.has(d.id) && !initial.has(d.id))
    const unticked = dishes.filter(d => !picked.has(d.id) && initial.has(d.id))
    const kept = dishes.filter(d => picked.has(d.id) && initial.has(d.id))
    const nextSortByDish = {}
    catalog.attachments.forEach(a => { nextSortByDish[a.recipe_id] = Math.max(nextSortByDish[a.recipe_id] ?? -1, a.sort || 0) })
    const after = {
      ...catalog,
      attachments: [
        ...catalog.attachments.filter(a => a.group_id !== group.id || picked.has(a.recipe_id)),
        ...ticked.map(d => ({ recipe_id: d.id, group_id: group.id, sort: (nextSortByDish[d.id] ?? -1) + 1 })),
      ],
    }
    return {
      belowZero: dishesBelowZero(ticked, after, { before: catalog }),
      droppedBelow: dishesBelowZero(unticked, after, { before: catalog }),
      alreadyBelow: dishesBelowZero(kept, catalog),
    }
  }, [dishes, picked, initial, catalog, group.id])
  const refused = belowZero.length + droppedBelow.length > 0

  const toggle = id => setPicked(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n })
  const setMany = (ids, on) => setPicked(p => { const n = new Set(p); ids.forEach(id => (on ? n.add(id) : n.delete(id))); return n })

  async function save() {
    if (saving || refused) return
    setSaving(true)
    setActionError(null)
    const nextSortByDish = {}
    attachments.forEach(a => { nextSortByDish[a.recipe_id] = Math.max(nextSortByDish[a.recipe_id] ?? -1, a.sort || 0) })
    const adds = dishes.filter(d => picked.has(d.id) && !initial.has(d.id)).map(d => ({
      recipe_id: d.id, group_id: group.id, sort: (nextSortByDish[d.id] ?? -1) + 1,
    }))
    if (adds.length) {
      const { error } = await settleWithin(scopedUpsert('pos_recipe_option_groups', adds, { onConflict: 'recipe_id,group_id' }),
        CUSTOMIZATION_WRITE_MS, 'Saving the dishes')
      if (error) { setSaving(false); setActionError(writeFailure(error, RETRY_IS_SAFE)); return }
    }
    const removeRows = attachments.filter(a => a.group_id === group.id && !picked.has(a.recipe_id))
    const removeIds = removeRows.map(a => a.id)
    if (removeIds.length) {
      // In chunks (S852): `.in('id', …)` travels in the URL, and unticking a group from a whole menu
      // made one URL of every id. A chunk that answered is off; the one that failed, and any after
      // it, are named as still offering the group.
      const detached = new Set()
      const { error } = await runChunkedByIds(removeIds, async ids => {
        const r = await settleWithin(scopedDelete('pos_recipe_option_groups').in('id', ids),
          CUSTOMIZATION_WRITE_MS, 'Saving the dishes')
        if (!r.error) ids.forEach(id => detached.add(id))
        return r
      })
      if (error) {
        setSaving(false)
        const nameOf = a => dishById.get(a.recipe_id)?.name || 'a dish'
        setActionError(detachFailure({
          groupName: group.name,
          added: adds.length > 0,
          off: removeRows.filter(a => detached.has(a.id)).map(nameOf),
          still: removeRows.filter(a => !detached.has(a.id)).map(nameOf),
          error,
          retry: RETRY_IS_SAFE,
        }))
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
      {belowZero.length > 0 && (
        <p role="alert" className="field-error" style={{ margin: '12px 0 0' }}>
          {belowZeroText(belowZero)}, and the till refuses a dish priced below zero. Untick {belowZero.length === 1 ? 'it' : 'them'}, or change the option’s price first.
        </p>
      )}
      {droppedBelow.length > 0 && (
        <p role="alert" className="field-error" style={{ margin: '12px 0 0' }}>
          Taking “{group.name}” off: {belowZeroText(droppedBelow)}, and the till refuses a dish priced below zero. Keep {droppedBelow.length === 1 ? 'it' : 'them'} ticked, or change the prices first.
        </p>
      )}
      {alreadyBelow.length > 0 && (
        <p role="status" style={{ margin: '12px 0 0', fontSize: 13, color: 'var(--theme-amber-text)' }}>
          △ Already on: {reachList(alreadyBelow)} with these choices — fix {alreadyBelow.length === 1 ? 'its' : 'their'} prices.
        </p>
      )}
      <ActionError error={actionError} />
      <div style={{ display: 'flex', gap: 10, marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--theme-border)', flexShrink: 0 }}>
        <button className="btn btn-ghost" style={{ flex: 1, justifyContent: 'center' }} onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" style={{ flex: 2, justifyContent: 'center' }} onClick={save}
          disabled={saving || changed === 0} aria-disabled={refused || undefined} aria-busy={saving || undefined}>
          {saving ? 'Saving…' : changed ? `Save (${changed} change${changed === 1 ? '' : 's'})` : 'No changes'}
        </button>
      </div>
    </Modal>
  )
}

// "Veg Momo can reach NPR −20", "… and Kids Momo can reach NPR −5", then "and 3 more".
function reachList(found) {
  const parts = found.slice(0, 3).map(({ dish, incl }) => `${dish.name} can reach NPR −${nprInt(Math.abs(Math.round(incl)))}`)
  if (found.length > 3) parts.push(`${found.length - 3} more`)
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0]
}
