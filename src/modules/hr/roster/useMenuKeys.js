import { useEffect } from 'react'

// The keyboard model for the roster's two popovers (ShiftPicker, SuggestPopover), copied from
// RowMenu (S803). Both declared role="menu" and were portalled to the end of <body>, but never took
// focus: Enter on a board cell opened the picker while focus stayed on the cell, the other cells are
// tabIndex -1, so Tab left the board and the shifts sat after every other control on the page — a
// keyboard manager could open the picker and not reach "Morning". Now: the first item takes focus
// on open, arrows cycle, Home/End jump, Escape and Tab close and put focus back on the cell, and a
// close by choosing an item returns focus there too.
//
// `focusKey` re-runs the first-item focus when the menu swaps its list (Suggest's employee step →
// shift step) without re-binding anything else.
export default function useMenuKeys(panelRef, anchorRef, onClose, focusKey) {
  useEffect(() => {
    const panel = panelRef.current
    // A header control (Suggest's "‹ Back") is reachable by arrow but is not where the list starts.
    const first = panel?.querySelector('[role="menuitem"]:not([disabled]):not([data-menu-secondary])')
      || panel?.querySelector('[role="menuitem"]:not([disabled])')
    first?.focus({ preventScroll: true })
  }, [panelRef, focusKey])

  useEffect(() => {
    const items = () => Array.from(panelRef.current?.querySelectorAll('[role="menuitem"]:not([disabled])') || [])
    const backToCell = () => anchorRef.current?.focus({ preventScroll: true })
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); backToCell(); return }
      const els = items()
      const i = els.indexOf(document.activeElement)
      if (i === -1) return            // focus is elsewhere (a mouse user kept it on the board)
      if (e.key === 'Tab') { e.preventDefault(); onClose(); backToCell(); return }
      if (e.key === 'ArrowDown') { e.preventDefault(); els[(i + 1) % els.length]?.focus(); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); els[(i - 1 + els.length) % els.length]?.focus(); return }
      if (e.key === 'Home') { e.preventDefault(); els[0]?.focus(); return }
      if (e.key === 'End') { e.preventDefault(); els[els.length - 1]?.focus() }
    }
    function onDown(e) {
      if (panelRef.current?.contains(e.target) || anchorRef.current?.contains(e.target)) return
      onClose()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
      // Choosing an item unmounts the menu with focus inside it; the browser then drops focus to
      // <body>, losing the reader's place on a 40-row board. Give it back to the cell.
      if (!document.activeElement || document.activeElement === document.body) backToCell()
    }
  }, [panelRef, anchorRef, onClose])
}
