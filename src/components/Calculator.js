import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { GripHorizontal } from 'lucide-react'
import { evaluate } from '../utils/evalMath'

// Quick Calculator — a small always-available scratchpad for the arithmetic that comes up
// mid-task (unit conversions, pack maths, a quick margin check) without leaving the page you're
// on and losing an in-progress form.
//
// Shares evalMath's parser with QtyInput, so what evaluates in a stock-count box evaluates
// identically here. Portalled to document.body for the same reason CommandPalette is: it must
// escape any overflow:hidden / stacking context of whatever page is mounted underneath.
//
// It is deliberately NOT a modal (S704). It had been built on Modal.js's shape — a
// `position: fixed; inset: 0` scrim over the whole viewport with `onClick={onClose}` — which made
// the one thing the tool exists for the one thing it prevented: reading a figure off the page
// while you work it out. Worse, the scrim was also the close affordance, so the reflex of
// clicking the number you wanted to check dismissed the calculator. A scrim is the right control
// for a dialog that owns a decision; this owns nothing. So there is no backdrop, no
// click-outside-to-close and no focus trap, and the panel floats where the user drags it.

const KEYS = [
  ['7', '8', '9', '/'],
  ['4', '5', '6', '*'],
  ['1', '2', '3', '-'],
  ['0', '.', '(', ')'],
]

const PANEL_W = 380
// Minimum gap kept between the panel and every viewport edge, so a drag can never park it
// half-off-screen where the header — the only way to drag it back — is unreachable.
const EDGE = 12
// Above every Modal in the app (the highest zIndex any caller passes is 2100 — ShiftPicker /
// SuggestPopover) and below Tip's 9999, which must stay on top of everything including this.
// A floating tool a dialog can bury is a tool you cannot use where you most need it: the
// purchase-bill form is exactly where someone reaches for Alt+C.
const Z = 2500

function defaultPos() {
  const w = Math.min(PANEL_W, window.innerWidth - EDGE * 2)
  return { left: Math.max(EDGE, window.innerWidth - w - 24), top: 88 }
}

export default function Calculator({ open, onClose }) {
  const [expr, setExpr] = useState('')
  // Tape entries are newest-first: the one you just did is the one you're most likely to reuse.
  const [tape, setTape] = useState([])
  const [copied, setCopied] = useState(null)
  // Position survives close/reopen for the same reason the tape does — you put it where it does
  // not cover the figure you are reading, and reopening should not undo that. Session-scoped
  // (this component stays mounted in Layout), not persisted: a position saved on one monitor is
  // how a panel gets stranded off-screen on another.
  const [pos, setPos] = useState(defaultPos)
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef(null)
  const panelRef = useRef(null)
  const dragRef = useRef(null)

  const live = evaluate(expr)

  // Keeps the whole panel inside the viewport. Measures the live element rather than trusting the
  // constants, because the panel's height changes with the tape and its width shrinks on a phone.
  function clampPos(next) {
    const el = panelRef.current
    const w = el ? el.offsetWidth : PANEL_W
    const h = el ? el.offsetHeight : 320
    return {
      left: Math.min(Math.max(next.left, EDGE), Math.max(EDGE, window.innerWidth - w - EDGE)),
      top: Math.min(Math.max(next.top, EDGE), Math.max(EDGE, window.innerHeight - h - EDGE)),
    }
  }

  useEffect(() => {
    // Keep the tape across open/close within a session — reopening to re-check a figure you
    // worked out a minute ago is the common case. Only the expression box resets.
    if (open) {
      setExpr('')
      // Re-clamp on open: the window may have been resized while the panel was closed and
      // holding a position that no longer fits.
      setPos(p => clampPos(p))
      setTimeout(() => inputRef.current?.focus(), 0)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open) return
    // Functional updater rather than `pos` in the dep array: depending on the position would
    // tear down and re-attach this listener on every frame of a drag.
    function onResize() { setPos(p => clampPos(p)) }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Document-level, not just the input's onKeyDown: this can be open on top of a Modal (see
  // PurchaseBillForm), which has its own document keydown listener that closes IT on Escape.
  // MUST be capture-phase (the `true` third arg), not bubble — this is not optional. Modal's
  // listener attaches unconditionally the moment the modal itself mounts, before the calculator
  // is ever opened; this one only attaches later, when `open` flips true. Same-phase (bubble)
  // listeners on one target fire in registration order, so Modal's earlier-registered listener
  // would always run and close the parent BEFORE this one even gets a chance to call
  // stopImmediatePropagation — registration order can't be won here, no matter what runs inside
  // the handler. Capture-phase listeners always fire before bubble-phase ones regardless of
  // when either was registered, which is what actually makes this deterministic.
  useEffect(() => {
    if (!open) return
    function onKeyDown(e) {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      onClose()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [open, onClose])

  // --- Drag -----------------------------------------------------------------------------------
  // Pointer events with setPointerCapture, not mousedown plus document listeners: capture routes
  // every subsequent move/up back to this element even when the pointer outruns it or leaves the
  // window, and one code path covers mouse, touch and pen.
  function onHandlePointerDown(e) {
    // The × and the grip live inside the handle; a press on the × is a click, not a drag.
    if (e.target.closest('button')) return
    const el = panelRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    dragRef.current = { dx: e.clientX - r.left, dy: e.clientY - r.top }
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragging(true)
    // Suppresses the text selection that would otherwise sweep across the page during a drag.
    e.preventDefault()
  }

  function onHandlePointerMove(e) {
    if (!dragRef.current) return
    setPos(clampPos({ left: e.clientX - dragRef.current.dx, top: e.clientY - dragRef.current.dy }))
  }

  function endDrag(e) {
    if (!dragRef.current) return
    dragRef.current = null
    setDragging(false)
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch (_) { /* already released */ }
  }

  // WCAG 2.5.7 (Dragging Movements). The reason to move this panel is to uncover the figure
  // underneath it, so a mouse-only affordance puts that out of reach of a keyboard user
  // entirely. The grip is focusable and the arrow keys nudge it; Shift moves in bigger steps.
  function onHandleKeyDown(e) {
    const step = e.shiftKey ? 48 : 8
    const delta = {
      ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step],
    }[e.key]
    if (!delta) return
    e.preventDefault()
    setPos(clampPos({ left: pos.left + delta[0], top: pos.top + delta[1] }))
  }

  function commit() {
    const result = evaluate(expr)
    if (result === null) return
    setTape(t => [{ expr: expr.trim(), result, id: Date.now() }, ...t].slice(0, 50))
    // Chain from the result, the way a real calculator does — you usually keep going.
    setExpr(String(result))
    inputRef.current?.focus()
  }

  function press(k) {
    setExpr(e => e + k)
    inputRef.current?.focus()
  }

  async function copy(value) {
    try {
      await navigator.clipboard.writeText(String(value))
      setCopied(value)
      setTimeout(() => setCopied(null), 1200)
    } catch (_) {
      // Clipboard permission denied / insecure context — the number is on screen to read.
    }
  }

  // Escape is handled by the document-level listener above (needs stopImmediatePropagation to
  // beat a parent Modal's own Escape handler); this only needs Enter.
  function handleKeyDown(e) {
    if (e.key === 'Enter') { e.preventDefault(); commit() }
  }

  if (!open) return null

  const tapeSum = tape.reduce((s, t) => s + t.result, 0)

  const keyBtn = {
    padding: '12px 0', fontSize: 18, fontWeight: 600, cursor: 'pointer',
    background: 'var(--theme-bg)', border: '1px solid var(--theme-border)',
    borderRadius: 0, color: 'var(--theme-text1)', fontFamily: 'inherit',
  }
  const opBtn = { ...keyBtn, color: 'var(--theme-accent-ink)' }

  return createPortal(
    <div
      ref={panelRef}
      // A floating tool has no business in a printed report, and without a scrim it is much
      // easier to leave one open over a page someone then prints.
      // `calc-panel` carries the height cap: never taller than the viewport, so clampPos always
      // has somewhere to put it. It is a class so it can say 100vh and then 100dvh (S852).
      className="no-print calc-panel"
      // role="dialog" WITHOUT aria-modal: nothing behind it is inert, and claiming otherwise
      // would tell a screen reader the rest of the page is unavailable when it is exactly as
      // available as it was before.
      role="dialog"
      aria-label="Quick Calculator"
      style={{
        position: 'fixed', left: pos.left, top: pos.top, zIndex: Z,
        width: 'min(380px, calc(100vw - 24px))',
        overflowY: 'auto', overflowX: 'hidden',
        background: 'var(--theme-card)', border: '1px solid var(--theme-border)',
        borderRadius: 0,
        // Carries the whole job of lifting the panel off the page now that there is no scrim
        // behind it, so it stays deliberately heavier than --theme-card-shadow.
        boxShadow: '0 24px 64px rgba(0,0,0,0.4)',
      }}
    >
      {/* Header — also the drag surface. A real clickable × sits alongside the Esc hint: Escape
          is fixed (capture-phase, see above) but a mouse-clickable close is the reliable
          affordance regardless of any future nesting quirk, same pattern as Modal.js's own close
          button. The row itself carries no role: it holds a real <button>, and interactive
          content inside a role="button" container is invalid and unfocusable (S653) — so the
          keyboard affordance lives on the grip, which holds only an icon. */}
      <div
        className="calc-drag-row"
        onPointerDown={onHandlePointerDown}
        onPointerMove={onHandlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px',
          borderBottom: '1px solid var(--theme-border)',
          cursor: dragging ? 'grabbing' : 'grab',
          // Without this a touch drag scrolls the page underneath instead of moving the panel.
          touchAction: 'none', userSelect: 'none',
        }}
      >
        <span
          className="calc-drag-grip"
          role="button"
          tabIndex={0}
          aria-label="Move calculator — use the arrow keys"
          title="Drag to move, or focus this and use the arrow keys"
          onKeyDown={onHandleKeyDown}
        >
          <GripHorizontal size={14} strokeWidth={2} aria-hidden="true" />
        </span>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--theme-text1)', flex: 1 }}>Quick Calculator</span>
        <span style={{ fontSize: 'var(--font-size-micro)', color: 'var(--theme-text3)', border: '1px solid var(--theme-border)', borderRadius: 0, padding: '1px 5px' }}>Esc</span>
        <button
          className="btn btn-ghost"
          onClick={onClose}
          title="Close"
          aria-label="Close calculator"
          style={{ fontSize: 18, lineHeight: 1, padding: '2px 9px' }}
        >×</button>
      </div>

      {/* Expression + live result */}
      <div style={{ padding: '12px 14px 10px' }}>
        <input aria-label="Calculation"
          ref={inputRef}
          value={expr}
          onChange={e => setExpr(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="3*24+7"
          inputMode="decimal"
          autoComplete="off"
          style={{
            width: '100%', background: 'var(--theme-input-bg)', border: '1px solid var(--theme-input-border)',
            borderRadius: 0, padding: '10px 12px', fontSize: 18, color: 'var(--theme-text1)',
            outline: 'none', textAlign: 'right', fontFamily: 'inherit',
          }}
        />
        {/* A real button when there is a result to copy (S852). It was a clickable div: no Tab
            stop, no name, so the copy was mouse-only. With nothing to copy it is plain text. */}
        {live === null ? (
          <div style={{ marginTop: 10, textAlign: 'right', fontSize: 32, fontWeight: 700, minHeight: 40, color: 'var(--theme-text3)' }}>
            {expr.trim() ? '—' : ''}
          </div>
        ) : (
          <button
            type="button"
            className="calc-text-btn"
            onClick={() => copy(live)}
            title="Click to copy"
            aria-label={copied === live ? 'Copied' : `Copy ${live.toLocaleString('en-IN')}`}
            style={{
              display: 'block', width: '100%', marginTop: 10, textAlign: 'right', fontSize: 32, fontWeight: 700,
              minHeight: 40, color: 'var(--theme-accent-ink)',
            }}
          >
            {copied === live ? '✓ copied' : live.toLocaleString('en-IN')}
          </button>
        )}
      </div>

      {/* Keypad */}
      <div style={{ padding: '0 14px 12px', display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 6 }}>
        {/* `calc-key` carries the focus pair, which an inline style cannot express (S852). C and ⌫
            are named, because a screen reader read the first as the letter and the second as
            nothing at all. */}
        {KEYS.map((row, ri) => (
          row.map(k => (
            <button key={k} type="button" className="calc-key" onClick={() => press(k)} style={'0123456789.'.includes(k) ? keyBtn : opBtn}>
              {k === '*' ? '×' : k === '/' ? '÷' : k}
            </button>
          )).concat(
            ri === 0 ? [<button key="clr" type="button" className="calc-key" aria-label="Clear" title="Clear" onClick={() => setExpr('')} style={{ ...keyBtn, color: 'var(--theme-red-text)', fontSize: 15 }}>C</button>]
            : ri === 1 ? [<button key="del" type="button" className="calc-key" aria-label="Delete last character" title="Delete last character" onClick={() => setExpr(e => e.slice(0, -1))} style={{ ...keyBtn, fontSize: 15 }}>⌫</button>]
            : ri === 2 ? [<button key="plus" type="button" className="calc-key" onClick={() => press('+')} style={opBtn}>+</button>]
            : [<button key="eq" type="button" className="calc-key" onClick={commit} disabled={live === null} style={{ ...keyBtn, background: 'var(--theme-accent)', borderColor: 'var(--theme-accent)', color: 'var(--theme-accent-text)', opacity: live === null ? 0.4 : 1 }}>=</button>]
          )
        ))}
      </div>

      {/* Tape */}
      {tape.length > 0 && (
        <div style={{ borderTop: '1px solid var(--theme-border)', maxHeight: '26vh', overflowY: 'auto' }}>
          {/* Two real buttons per line (S852): the expression reuses it, the result copies it. The
              row was a clickable div holding a clickable span, so neither could be reached from the
              keyboard, and a nested control is invalid inside a clickable container anyway. */}
          {tape.map(t => (
            <div key={t.id} className="calc-tape-row">
              <button
                type="button"
                className="calc-text-btn"
                onClick={() => { setExpr(t.expr); inputRef.current?.focus() }}
                title="Click to reuse this expression"
                aria-label={`Reuse ${t.expr}`}
                style={{
                  flex: 1, minWidth: 0, padding: '8px 6px 8px 14px', textAlign: 'left', fontSize: 14,
                  color: 'var(--theme-text3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}
              >
                {t.expr}
              </button>
              <button
                type="button"
                className="calc-text-btn"
                onClick={() => copy(t.result)}
                title="Click to copy"
                aria-label={copied === t.result ? 'Copied' : `Copy ${t.result.toLocaleString('en-IN')}`}
                style={{ padding: '8px 14px 8px 6px', fontSize: 14, color: 'var(--theme-text1)', fontWeight: 600 }}
              >
                {copied === t.result ? '✓' : t.result.toLocaleString('en-IN')}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Tape footer */}
      {tape.length > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderTop: '1px solid var(--theme-border)', fontSize: 13 }}>
          <span style={{ flex: 1, color: 'var(--theme-text3)' }}>Sum of tape</span>
          <span style={{ color: 'var(--theme-accent-ink)', fontWeight: 700 }}>{tapeSum.toLocaleString('en-IN')}</span>
          <button
            type="button"
            className="calc-text-btn"
            onClick={() => setTape([])}
            aria-label="Clear tape"
            style={{ color: 'var(--theme-text3)', fontSize: 12 }}
          >
            Clear
          </button>
        </div>
      )}
    </div>,
    document.body
  )
}
