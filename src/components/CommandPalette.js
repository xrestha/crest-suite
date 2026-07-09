import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

// Flat search across every destination the sidebar's grouped panels would otherwise require
// clicking through several collapsed groups to find. `items` is pre-filtered by the caller
// (Layout.js) using the exact same isItemVisible() predicate the rendered nav uses, so a result
// can never surface a page this user isn't actually allowed to open.
export default function CommandPalette({ open, onClose, items, onSelect }) {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef(null)

  const results = query.trim()
    ? items.filter(i => i.label.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 30)
    : items.slice(0, 30)

  useEffect(() => {
    if (open) {
      setQuery('')
      setActiveIndex(0)
      // Let the portal mount before focusing.
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [open])

  useEffect(() => { setActiveIndex(0) }, [query])

  function handleKeyDown(e) {
    if (e.key === 'Escape') { onClose(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIndex(i => Math.min(i + 1, results.length - 1)); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIndex(i => Math.max(i - 1, 0)); return }
    if (e.key === 'Enter') {
      e.preventDefault()
      const item = results[activeIndex]
      if (item) onSelect(item)
    }
  }

  if (!open) return null

  return createPortal(
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 400, background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '14vh 16px 40px',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 520, background: 'var(--theme-card)',
          border: '1px solid var(--theme-border)', borderRadius: 10,
          boxShadow: '0 24px 64px rgba(0,0,0,0.4)', overflow: 'hidden',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: '1px solid var(--theme-border)' }}>
          <span style={{ color: 'var(--theme-text3)', fontSize: 15 }}>⌕</span>
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search pages and reports…"
            style={{
              flex: 1, background: 'none', border: 'none', outline: 'none',
              color: 'var(--theme-text1)', fontSize: 'var(--font-size-nav-item)', fontFamily: 'inherit',
            }}
          />
          <span style={{ fontSize: 'var(--font-size-micro)', color: 'var(--theme-text3)', border: '1px solid var(--theme-border)', borderRadius: 4, padding: '1px 5px' }}>Esc</span>
        </div>
        <div style={{ maxHeight: '52vh', overflowY: 'auto', padding: '6px 0' }}>
          {results.length === 0 ? (
            <div style={{ padding: '20px 16px', fontSize: 13, color: 'var(--theme-text3)', textAlign: 'center' }}>
              No pages match "{query}"
            </div>
          ) : results.map((item, i) => (
            <div
              key={item.to}
              onMouseEnter={() => setActiveIndex(i)}
              onClick={() => onSelect(item)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '9px 16px', cursor: 'pointer',
                background: i === activeIndex ? 'var(--theme-table-hover)' : 'none',
                borderLeft: `2px solid ${i === activeIndex ? 'var(--theme-accent)' : 'transparent'}`,
              }}
            >
              <span style={{ width: 16, textAlign: 'center', fontSize: 'var(--font-size-nav-icon)', flexShrink: 0 }}>{item.icon}</span>
              <span style={{ flex: 1, fontSize: 'var(--font-size-nav-item)', color: 'var(--theme-text1)' }}>{item.label}</span>
              {item.groupLabel && (
                <span style={{ fontSize: 'var(--font-size-micro)', color: 'var(--theme-text3)' }}>{item.groupLabel}</span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body
  )
}
