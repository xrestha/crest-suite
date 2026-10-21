import { useState, useRef, useEffect, useMemo, useId } from 'react'

// Type-to-filter combobox for long option lists (e.g. 200+ items).
// Drop-in replacement for a <select>: pass value, onChange(value), and
// options=[{ value, label }]. The dropdown is position:fixed so it is never
// clipped by a modal/table overflow.
// `id` exists so a real <label htmlFor> can name this control the way it names a native <select>
// — without it the trigger reads to a screen reader as an unnamed button, which is what every
// call site had before S551. It lands on the trigger button (the element that is focused when
// the control is closed) and is mirrored onto the filter input's aria-labelledby when open.
//
// `touch` is opt-in rather than a `@media (pointer: coarse)` rule because every size in this
// component is an INLINE style, and a media query cannot reach an inline style — that is exactly
// the hazard DESIGN.md names. Two things change and both are load-bearing on a phone: the filter
// input goes to 16px, below which iOS Safari zooms the viewport on focus and never zooms back;
// and the trigger and option rows clear the 44px touch target instead of measuring ~31px and
// ~33px. Passed by the Crest Staff portal only, so the admin app's density is untouched.
// `invalid` is the validation message this select's field is showing, or falsy. It has to be a
// PROP rather than a CSS hook because every colour here is an inline style, so the
// `[aria-invalid="true"]` rules in Layout.css have no path to the trigger — the same reason
// `touch` is a prop. Passing the message itself (not a boolean) lets the trigger point
// `aria-describedby` at the <FieldError> rendered beside it, which is the half a screen reader
// actually receives; `aria-invalid` is deliberately NOT set, since this trigger is a <button> and
// that attribute is unsupported on the button role.
export default function SearchableSelect({ value, onChange, options, placeholder = '— Select —', style, id, touch = false, invalid = '' }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const [coords, setCoords] = useState(null)
  const rootRef = useRef(null)
  const triggerRef = useRef(null)
  const inputRef = useRef(null)
  const listRef = useRef(null)
  const uid = useId()
  const listboxId = `${uid}-listbox`
  const optionId = v => `${uid}-opt-${v}`

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

  // Close when focus moves to something outside (S842). The mousedown close above never sees Tab,
  // so tabbing out of the filter left the list open over the next field. The trigger, the filter
  // box and the fixed panel all sit inside rootRef, so one focusout covers all three. A null
  // relatedTarget is ignored: a window switch, a press on the panel's padding, or Safari's
  // unfocusable button click (closing there made the trigger's own click reopen the list).
  function onBlur(e) {
    if (open && e.relatedTarget && !rootRef.current?.contains(e.relatedTarget)) close()
  }

  // A pick and an Escape hand focus back to the trigger (S852). Both unmount the filter box that
  // has focus, so it fell to <body>: inside a dialog the next Tab left the dialog, and on a long
  // form the keyboard restarted from the top of the page. The trigger is focused FIRST, so a caller
  // whose onChange moves focus on (to the next field) still wins. A Tab out and an outside press
  // close without this: focus is already going where the user sent it.
  function returnFocus() { triggerRef.current?.focus() }
  function pick(opt) { returnFocus(); close(); onChange(opt.value) }

  function onKeyDown(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight(h => Math.min(h + 1, filtered.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight(h => Math.max(h - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); if (filtered[highlight]) pick(filtered[highlight]) }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); returnFocus(); close() }
  }

  return (
    <div ref={rootRef} onBlur={onBlur} style={{ position: 'relative', ...style }}>
      {/* `picker-trigger` is the keyboard focus pair (Layout.css): an inline style has no
          :focus-visible, so this trigger had shown the browser ring or nothing (S852). */}
      <button
        ref={triggerRef}
        type="button"
        id={id}
        className="picker-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-describedby={invalid && id ? `${id}-err` : undefined}
        onClick={() => (open ? close() : openIt())}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
          background: 'var(--theme-input-bg)',
          border: `1px solid ${invalid ? 'var(--theme-red)' : 'var(--theme-input-border)'}`,
          borderRadius: 'var(--radius-md)',
          padding: touch ? '11px 12px' : '7px 10px', minHeight: touch ? 44 : undefined,
          fontSize: touch ? 16 : 13, color: 'var(--theme-text1)', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit',
        }}
      >
        <span style={{ color: selected ? 'var(--theme-text1)' : 'var(--theme-text2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {selected ? selected.label : placeholder}
        </span>
        <span style={{ color: 'var(--theme-text2)', flexShrink: 0 }}>▾</span>
      </button>

      {open && coords && (
        <div style={{
          position: 'fixed',
          ...(coords.up ? { bottom: coords.bottom } : { top: coords.top }),
          left: coords.left, width: coords.width, zIndex: 1000,
          background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--theme-card-shadow)', overflow: 'hidden',
        }}>
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Type to search…"
            autoComplete="off"
            role="combobox"
            aria-labelledby={id}
            aria-expanded="true"
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-activedescendant={filtered[highlight] ? optionId(filtered[highlight].value) : undefined}
            style={{
              width: '100%', boxSizing: 'border-box', background: 'var(--theme-input-bg)', border: 'none',
              borderBottom: '1px solid var(--theme-border)', padding: touch ? '12px 12px' : '9px 11px',
              fontSize: touch ? 16 : 13, color: 'var(--theme-text1)',
              outline: 'none', fontFamily: 'inherit',
            }}
          />
          <div ref={listRef} id={listboxId} role="listbox" style={{ maxHeight: coords.listMax, overflowY: 'auto' }}>
            {filtered.length === 0 ? (
              <div style={{ padding: '12px', fontSize: 12, color: 'var(--theme-text2)' }}>No matches</div>
            ) : filtered.map((opt, i) => (
              <div
                key={opt.value}
                id={optionId(opt.value)}
                role="option"
                aria-selected={opt.value === value}
                onMouseEnter={() => setHighlight(i)}
                onMouseDown={e => e.preventDefault()}
                onClick={() => pick(opt)}
                style={{
                  padding: touch ? '12px 12px' : '8px 11px', minHeight: touch ? 44 : undefined,
                  display: touch ? 'flex' : undefined, alignItems: touch ? 'center' : undefined,
                  fontSize: touch ? 15 : 13, cursor: 'pointer',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  background: i === highlight ? 'var(--theme-table-hover)' : 'transparent',
                  color: opt.value === value ? 'var(--theme-accent-ink)' : 'var(--theme-text1)',
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
