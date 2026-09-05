import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Ellipsis } from 'lucide-react'

/**
 * The overflow menu for a table row's SECONDARY actions — the moves a host makes a few times a
 * night, kept behind one control so the move they make every time can stand alone (S681).
 *
 * WHY THIS EXISTS. Reservations rendered every legal status move as its own `btn-ghost btn-sm`:
 * a booked row carried six identical 12px pills, with the two irreversible ones (No-show, Cancel)
 * interleaved among the routine ones. Twenty rows on a Saturday is 120 look-alike buttons, and
 * Hick's law fails on the page's most-used control. The shape the row wants is: one next step, the
 * contact button, and everything else here.
 *
 * It is a real menu, not a dropdown of divs: the trigger carries `aria-haspopup="menu"` and
 * `aria-expanded`; the panel is `role="menu"` of `role="menuitem"` buttons; arrows cycle, Home/End
 * jump, Escape and Tab close and return focus to the trigger; a click outside closes. The panel is
 * portalled and `position: fixed`, because every table on this product sits inside a `.table-wrap`
 * with `overflow-x: auto`, which would clip an in-flow panel at the row's edge.
 *
 * `items` — `[{ key, label, onSelect, danger?, disabled?, hint? }]`, or `'-'` for a separator.
 * Falsy entries are skipped so a caller can write `cond && { ... }`. Renders nothing at all when no
 * item survives, so a row with no secondary moves has no dead control.
 */
export default function RowMenu({ label, items, disabled = false, busy = false }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState(null)
  const btnRef = useRef(null)
  const menuRef = useRef(null)
  const menuId = useId()

  const list = (items || []).filter(Boolean)
  // Trim separators that would lead, trail, or double up once the conditional items are gone.
  const entries = list.filter((it, i) => !(it === '-' && (i === 0 || i === list.length - 1 || list[i - 1] === '-')))
  const actionable = entries.filter(it => it !== '-')

  const close = (refocus = true) => {
    setOpen(false)
    if (refocus) btnRef.current?.focus()
  }

  const openMenu = () => {
    const r = btnRef.current?.getBoundingClientRect()
    if (!r) return
    // Estimate the panel height to decide whether it opens above or below; 40px per item is the
    // coarse-pointer row height, so the estimate errs toward flipping early, never toward
    // overflowing the bottom edge.
    const est = actionable.length * 40 + entries.filter(it => it === '-').length * 9 + 10
    const below = r.bottom + est + 8 <= window.innerHeight
    setPos({
      top: below ? r.bottom + 4 : undefined,
      bottom: below ? undefined : window.innerHeight - r.top + 4,
      right: Math.max(8, window.innerWidth - r.right),
    })
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    const panel = menuRef.current
    const itemsEl = () => Array.from(panel?.querySelectorAll('[role="menuitem"]:not([disabled])') || [])
    itemsEl()[0]?.focus()

    const onKey = e => {
      const els = itemsEl()
      const i = els.indexOf(document.activeElement)
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return }
      if (e.key === 'Tab') { close(false); return }
      if (e.key === 'ArrowDown') { e.preventDefault(); els[(i + 1) % els.length]?.focus(); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); els[(i - 1 + els.length) % els.length]?.focus(); return }
      if (e.key === 'Home') { e.preventDefault(); els[0]?.focus(); return }
      if (e.key === 'End') { e.preventDefault(); els[els.length - 1]?.focus() }
    }
    const onDown = e => {
      if (panel?.contains(e.target) || btnRef.current?.contains(e.target)) return
      close(false)
    }
    const onScroll = () => close(false)
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('touchstart', onDown, { passive: true })
    window.addEventListener('resize', onScroll)
    // Capture phase: the table-wrap's own horizontal scroll never bubbles to document.
    document.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('touchstart', onDown)
      window.removeEventListener('resize', onScroll)
      document.removeEventListener('scroll', onScroll, true)
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  if (actionable.length === 0) return null

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="btn btn-ghost btn-sm btn-icon"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        title={label}
        aria-busy={busy || undefined}
        disabled={disabled}
        onClick={() => (open ? close() : openMenu())}
      >
        <Ellipsis aria-hidden="true" />
      </button>
      {open && pos && createPortal(
        <div ref={menuRef} id={menuId} role="menu" aria-label={label} className="row-menu"
          style={{ top: pos.top, bottom: pos.bottom, right: pos.right }}>
          {entries.map((it, i) => it === '-'
            ? <div key={`sep-${i}`} role="separator" className="row-menu-sep" />
            : (
              <button
                key={it.key || it.label}
                type="button"
                role="menuitem"
                className={`row-menu-item${it.danger ? ' row-menu-item--danger' : ''}`}
                disabled={!!it.disabled}
                title={it.disabled && it.hint ? it.hint : undefined}
                onClick={() => { close(false); it.onSelect?.() }}
              >
                {it.label}
                {it.disabled && it.hint && <span className="row-menu-hint">{it.hint}</span>}
              </button>
            ))}
        </div>,
        document.body
      )}
    </>
  )
}
