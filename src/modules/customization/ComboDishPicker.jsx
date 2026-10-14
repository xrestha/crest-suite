import { useMemo, useState } from 'react'
import Modal from '../../components/Modal'
import { npr } from '../../shared/nepalMoney'

// Choose the dishes one pick of a combo offers (S839). The layout is AttachToDishesModal's: a search
// box, every dish under its category, a tick per dish. It writes nothing: Done hands the ticked ids
// back to the combo editor, which keeps each staying dish's extra charge and default.
//
// `dishes` are the outlet's active non-Sub-Recipe dishes, each with `guestPrice` (what a guest pays
// for it alone). A dish not On POS can still be ticked: it is then sold only inside combos.
export default function ComboDishPicker({ pickName, dishes, chosen, onClose, onDone }) {
  const [picked, setPicked] = useState(() => new Set(chosen))
  const [search, setSearch] = useState('')

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

  const shown = byCategory.reduce((n, [, list]) => n + list.length, 0)
  const toggle = id => setPicked(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n })
  const setMany = (ids, on) => setPicked(p => { const n = new Set(p); ids.forEach(id => (on ? n.add(id) : n.delete(id))); return n })

  // Every dish in the order this dialog lists them, search or not (sort is stable, so by name within
  // a category, as the page loaded them).
  const listOrder = useMemo(() => [...dishes]
    .sort((a, b) => (a.category || 'No category').localeCompare(b.category || 'No category'))
    .map(d => d.id), [dishes])

  // Dishes already in the pick keep their order; new ones follow in the order they are listed here.
  // A ticked dish the search is hiding is still ticked.
  const done = () => onDone([
    ...chosen.filter(id => picked.has(id)),
    ...listOrder.filter(id => picked.has(id) && !chosen.includes(id)),
  ])

  const changed = picked.size !== chosen.length || chosen.some(id => !picked.has(id))

  return (
    <Modal onClose={onClose} title={`Dishes in “${pickName || 'this pick'}”`} maxWidth={620} zIndex={110}
      panelStyle={{ maxHeight: '90vh', display: 'flex', flexDirection: 'column' }} dirty={changed}>
      <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--theme-text2)' }}>
        Tick every dish a guest may choose for this pick. Tick just one to include it automatically.
      </p>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        <input className="form-input form-input--auto" style={{ width: 240, maxWidth: '100%' }} placeholder="Search dishes…"
          aria-label="Search dishes by name or category" value={search} onChange={e => setSearch(e.target.value)} />
        <span style={{ fontSize: 12, color: 'var(--theme-text2)' }} role="status">
          {picked.size} ticked{search.trim() ? ` · ${shown} of ${dishes.length} shown` : ''}
        </span>
      </div>

      <div style={{ overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: 14 }}>
        {dishes.length === 0 ? (
          <div className="empty-state">No dishes yet. Dishes are made in Recipe Costing (or Menu Pricing on a POS-only plan).</div>
        ) : byCategory.length === 0 ? (
          <div className="empty-state">No dishes match “{search.trim()}”.</div>
        ) : byCategory.map(([cat, list]) => {
          const on = list.filter(d => picked.has(d.id)).length
          const all = on === list.length
          const catId = `cdp-${cat.replace(/[^a-z0-9]+/gi, '-')}`
          return (
            <section key={cat} aria-labelledby={catId}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, fontSize: 13, marginBottom: 6, cursor: 'pointer' }}>
                <input type="checkbox" checked={all} ref={el => { if (el) el.indeterminate = on > 0 && !all }}
                  aria-label={`Every dish in ${cat}`} onChange={() => setMany(list.map(d => d.id), !all)} />
                <span id={catId}>{cat}</span>
                <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--theme-text3)' }}>{on} of {list.length}</span>
              </label>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(220px, 100%), 1fr))', gap: 4, paddingLeft: 24 }}>
                {list.map(d => (
                  <label key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, minHeight: 32, cursor: 'pointer' }}>
                    <input type="checkbox" checked={picked.has(d.id)} onChange={() => toggle(d.id)} />
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={d.name}>{d.name}</span>
                    <span style={{ fontSize: 11, color: 'var(--theme-text3)', whiteSpace: 'nowrap' }}>
                      {d.guestPrice > 0 ? npr(d.guestPrice) : 'no menu price'}{d.pos_enabled === false ? ' · not sold alone' : ''}
                    </span>
                  </label>
                ))}
              </div>
            </section>
          )
        })}
      </div>

      <div style={{ display: 'flex', gap: 10, marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--theme-border)', flexShrink: 0 }}>
        <button type="button" className="btn btn-ghost" style={{ flex: 1, justifyContent: 'center' }} onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" style={{ flex: 2, justifyContent: 'center' }} onClick={done}>
          {picked.size === 0 ? 'Done — no dishes' : `Done — ${picked.size} dish${picked.size === 1 ? '' : 'es'}`}
        </button>
      </div>
    </Modal>
  )
}
