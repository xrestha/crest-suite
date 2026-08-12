import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

const MAX_RESULTS = 30

// Flat search across every destination the sidebar's grouped panels would otherwise require
// clicking through several collapsed groups to find. `items` is pre-filtered by the caller
// (Layout.js) using the exact same isItemVisible() predicate the rendered nav uses, so a result
// can never surface a page this user isn't actually allowed to open.
//
// This is the fastest path to any of ~86 routes, and it is the mitigation for every IA problem in
// the sidebar — so it carries a real dialog contract (role, label, Escape at the container, focus
// restored to the trigger) and real combobox semantics, matching SearchableSelect.js. Before that
// it announced nothing at all: no dialog role, no listbox, results as plain <div>s, and an Escape
// handler bound to the <input> alone, so two Tab presses put focus on <body> with the overlay
// still up and the visible "Esc" hint no longer working.
export default function CommandPalette({ open, onClose, items, onSelect }) {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef(null)
  const restoreRef = useRef(null)

  const q = query.trim().toLowerCase()
  const matches = q ? items.filter(i => i.label.toLowerCase().includes(q)) : items
  const results = matches.slice(0, MAX_RESULTS)
  const hidden = matches.length - results.length

  useEffect(() => {
    if (open) {
      // Remember who opened it so focus can go back there — closing used to drop focus to <body>,
      // which restarts the 41-stop walk through the sidebar.
      restoreRef.current = document.activeElement
      setQuery('')
      setActiveIndex(0)
      // Let the portal mount before focusing.
      setTimeout(() => inputRef.current?.focus(), 0)
    } else if (restoreRef.current) {
      restoreRef.current.focus?.()
      restoreRef.current = null
    }
  }, [open])

  useEffect(() => { setActiveIndex(0) }, [query])

  // Bound to the CONTAINER, not the input: an Escape handler that only fires while the input has
  // focus is not an Escape handler.
  function handleKeyDown(e) {
    if (e.key === 'Escape') { e.stopPropagation(); onClose(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIndex(i => Math.min(i + 1, results.length - 1)); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIndex(i => Math.max(i - 1, 0)); return }
    if (e.key === 'Home') { e.preventDefault(); setActiveIndex(0); return }
    if (e.key === 'End') { e.preventDefault(); setActiveIndex(results.length - 1); return }
    // Single-element trap. The listbox uses aria-activedescendant, so the input is the only thing
    // here that should ever hold focus; without this, Tab walks straight out of an open overlay.
    if (e.key === 'Tab') { e.preventDefault(); inputRef.current?.focus(); return }
    if (e.key === 'Enter') {
      e.preventDefault()
      const item = results[activeIndex]
      if (item) onSelect(item)
    }
  }

  if (!open) return null

  const activeId = results[activeIndex] ? `palette-opt-${activeIndex}` : undefined

  return createPortal(
    <div
      onClick={onClose}
      onKeyDown={handleKeyDown}
      style={{
        position: 'fixed', inset: 0, zIndex: 400, background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '14vh 16px 40px',
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search pages and reports"
        onClick={e => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 520, background: 'var(--theme-card)',
          border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-lg)',
          boxShadow: '0 24px 64px rgba(0,0,0,0.4)', overflow: 'hidden',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: '1px solid var(--theme-border)' }}>
          <span aria-hidden="true" style={{ color: 'var(--theme-text3)', fontSize: 15 }}>⌕</span>
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-listbox"
            aria-autocomplete="list"
            aria-activedescendant={activeId}
            aria-label="Search pages and reports"
            placeholder="Search pages and reports…"
            style={{
              flex: 1, background: 'none', border: 'none', outline: 'none',
              color: 'var(--theme-text1)', fontSize: 'var(--font-size-nav-item)', fontFamily: 'inherit',
            }}
          />
          <span style={{ fontSize: 'var(--font-size-micro)', color: 'var(--theme-text3)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', padding: '1px 5px' }}>Esc</span>
        </div>

        {/* Announced, not just shown — a sighted user sees the list shrink as they type; without a
            live region a screen-reader user gets no feedback that anything matched at all. */}
        <span className="sr-only" role="status" aria-live="polite">
          {matches.length === 0 ? `No pages match ${query}` : `${matches.length} page${matches.length === 1 ? '' : 's'} match`}
        </span>

        <div id="palette-listbox" role="listbox" aria-label="Pages" style={{ maxHeight: '52vh', overflowY: 'auto', padding: '6px 0' }}>
          {results.length === 0 ? (
            <div style={{ padding: '20px 16px', fontSize: 13, color: 'var(--theme-text3)', textAlign: 'center' }}>
              No pages match "{query}"
            </div>
          ) : results.map((item, i) => (
            <div
              key={item.to}
              id={`palette-opt-${i}`}
              role="option"
              aria-selected={i === activeIndex}
              onMouseEnter={() => setActiveIndex(i)}
              onClick={() => onSelect(item)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '9px 16px', cursor: 'pointer',
                background: i === activeIndex ? 'var(--theme-table-hover)' : 'none',
                borderLeft: `2px solid ${i === activeIndex ? 'var(--theme-accent)' : 'transparent'}`,
              }}
            >
              <span aria-hidden="true" style={{ width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                {item.icon && <item.icon size={14} strokeWidth={1.75} />}
              </span>
              <span style={{ flex: 1, fontSize: 'var(--font-size-nav-item)', color: 'var(--theme-text1)' }}>{item.label}</span>
              {/* Which module a result belongs to. Four destinations named "…Report" live in three
                  different modules, so without this the list is genuinely ambiguous. */}
              {item.groupLabel && (
                <span style={{ fontSize: 'var(--font-size-micro)', color: 'var(--theme-text3)', flexShrink: 0 }}>{item.groupLabel}</span>
              )}
            </div>
          ))}
          {/* The cap used to be silent, so an empty query on a 41-destination panel simply looked
              like the whole list. */}
          {hidden > 0 && (
            <div style={{ padding: '8px 16px 4px', fontSize: 'var(--font-size-micro)', color: 'var(--theme-text3)', textAlign: 'center' }}>
              Showing {results.length} of {matches.length} — keep typing to narrow
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
