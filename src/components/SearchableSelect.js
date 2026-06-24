import { useState, useRef, useEffect, useMemo } from 'react'

// Type-to-filter combobox for long option lists (e.g. 200+ items).
// Drop-in replacement for a <select>: pass value, onChange(value), and
// options=[{ value, label }]. The dropdown is position:fixed so it is never
// clipped by a modal/table overflow.
export default function SearchableSelect({ value, onChange, options, placeholder = '— Select —', style }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const [coords, setCoords] = useState(null)
  const rootRef = useRef(null)
  const inputRef = useRef(null)
  const listRef = useRef(null)

  const selected = options.find(o => o.value === value)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return options
    return options.filter(o => o.label.toLowerCase().includes(q))
  }, [options, query])

  function measure() {
    const r = rootRef.current?.getBoundingClientRect()
    if (!r) return
    const margin = 4, inputH = 40
    const spaceBelow = window.innerHeight - r.bottom - margin
    const spaceAbove = r.top - margin
    // Flip the panel above the field when there isn't enough room below (e.g. a row near the
    // bottom of the screen) and there's more room above — keeps the list on-screen, no scrolling.
    const openUp = spaceBelow < 220 && spaceAbove > spaceBelow
    const listMax = Math.max(120, Math.min(260, (openUp ? spaceAbove : spaceBelow) - inputH - 8))
    if (openUp) {
      setCoords({ up: true, bottom: window.innerHeight - r.top + margin, left: r.left, width: r.width, listMax })
    } else {
      setCoords({ up: false, top: r.bottom + margin, left: r.left, width: r.width, listMax })
    }
  }

  function openIt() { setQuery(''); setHighlight(0); measure(); setOpen(true) }
  function close() { setOpen(false); setQuery('') }

  // Reposition on scroll/resize; close on outside click.
  useEffect(() => {
    if (!open) return
    measure()
    function onDoc(e) { if (rootRef.current && !rootRef.current.contains(e.target)) close() }
    window.addEventListener('scroll', measure, true)
    window.addEventListener('resize', measure)
    document.addEventListener('mousedown', onDoc)
    return () => {
      window.removeEventListener('scroll', measure, true)
      window.removeEventListener('resize', measure)
      document.removeEventListener('mousedown', onDoc)
    }
  }, [open])

  useEffect(() => { if (open && inputRef.current) inputRef.current.focus() }, [open])
  useEffect(() => { setHighlight(0) }, [query])
  useEffect(() => {
    if (open && listRef.current && listRef.current.children[highlight]) {
      listRef.current.children[highlight].scrollIntoView({ block: 'nearest' })
    }
  }, [highlight, open])

  function pick(opt) { onChange(opt.value); close() }

  function onKeyDown(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight(h => Math.min(h + 1, filtered.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight(h => Math.max(h - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); if (filtered[highlight]) pick(filtered[highlight]) }
    else if (e.key === 'Escape') { e.preventDefault(); close() }
  }

  return (
    <div ref={rootRef} style={{ position: 'relative', ...style }}>
      <button
        type="button"
        onClick={() => (open ? close() : openIt())}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
          background: '#0f1117', border: '1px solid #2a2f3d', borderRadius: 5, padding: '7px 10px',
          fontSize: 13, color: '#e8e0d0', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit',
        }}
      >
        <span style={{ color: selected ? '#e8e0d0' : '#6b7280', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {selected ? selected.label : placeholder}
        </span>
        <span style={{ color: '#6b7280', flexShrink: 0 }}>▾</span>
      </button>

      {open && coords && (
        <div style={{
          position: 'fixed',
          ...(coords.up ? { bottom: coords.bottom } : { top: coords.top }),
          left: coords.left, width: coords.width, zIndex: 1000,
          background: '#181c27', border: '1px solid #2a2f3d', borderRadius: 6,
          boxShadow: '0 10px 30px rgba(0,0,0,0.5)', overflow: 'hidden',
        }}>
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Type to search…"
            style={{
              width: '100%', boxSizing: 'border-box', background: '#0f1117', border: 'none',
              borderBottom: '1px solid #2a2f3d', padding: '9px 11px', fontSize: 13, color: '#e8e0d0',
              outline: 'none', fontFamily: 'inherit',
            }}
          />
          <div ref={listRef} style={{ maxHeight: coords.listMax, overflowY: 'auto' }}>
            {filtered.length === 0 ? (
              <div style={{ padding: '12px', fontSize: 12, color: '#6b7280' }}>No matches</div>
            ) : filtered.map((opt, i) => (
              <div
                key={opt.value}
                onMouseEnter={() => setHighlight(i)}
                onMouseDown={e => e.preventDefault()}
                onClick={() => pick(opt)}
                style={{
                  padding: '8px 11px', fontSize: 13, cursor: 'pointer',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  background: i === highlight ? '#2a2f3d' : 'transparent',
                  color: opt.value === value ? '#c9a84c' : '#e8e0d0',
                }}
              >
                {opt.label}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
