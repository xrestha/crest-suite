import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { evaluate } from '../utils/evalMath'

// Quick Calculator — a small always-available scratchpad for the arithmetic that comes up
// mid-task (unit conversions, pack maths, a quick margin check) without leaving the page you're
// on and losing an in-progress form.
//
// Shares evalMath's parser with QtyInput, so what evaluates in a stock-count box evaluates
// identically here. Portalled to document.body for the same reason CommandPalette is: it must
// escape any overflow:hidden / stacking context of whatever page is mounted underneath.

const KEYS = [
  ['7', '8', '9', '/'],
  ['4', '5', '6', '*'],
  ['1', '2', '3', '-'],
  ['0', '.', '(', ')'],
]

export default function Calculator({ open, onClose }) {
  const [expr, setExpr] = useState('')
  // Tape entries are newest-first: the one you just did is the one you're most likely to reuse.
  const [tape, setTape] = useState([])
  const [copied, setCopied] = useState(null)
  const inputRef = useRef(null)

  const live = evaluate(expr)

  useEffect(() => {
    // Keep the tape across open/close within a session — reopening to re-check a figure you
    // worked out a minute ago is the common case. Only the expression box resets.
    if (open) {
      setExpr('')
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [open])

  // Document-level, not just the input's onKeyDown: this can be nested inside a Modal (see
  // PurchaseBillModal), which has its own document keydown listener that closes IT on Escape.
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
    borderRadius: 6, color: 'var(--theme-text1)', fontFamily: 'inherit',
  }
  const opBtn = { ...keyBtn, color: 'var(--theme-accent)' }

  return createPortal(
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 400, background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '12vh 16px 40px',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 380, background: 'var(--theme-card)',
          border: '1px solid var(--theme-border)', borderRadius: 10,
          boxShadow: '0 24px 64px rgba(0,0,0,0.4)', overflow: 'hidden',
        }}
      >
        {/* Header — a real clickable × alongside the Esc hint. Escape is fixed (capture-phase,
            see above) but a mouse-clickable close is the reliable affordance regardless of any
            future nesting quirk, same pattern as Modal.js's own close button. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: '1px solid var(--theme-border)' }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--theme-text1)', flex: 1 }}>Quick Calculator</span>
          <span style={{ fontSize: 'var(--font-size-micro)', color: 'var(--theme-text3)', border: '1px solid var(--theme-border)', borderRadius: 4, padding: '1px 5px' }}>Esc</span>
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
          <input
            ref={inputRef}
            value={expr}
            onChange={e => setExpr(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="3*24+7"
            inputMode="decimal"
            autoComplete="off"
            style={{
              width: '100%', background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)',
              borderRadius: 6, padding: '10px 12px', fontSize: 18, color: 'var(--theme-text1)',
              outline: 'none', textAlign: 'right', fontFamily: 'inherit',
            }}
          />
          <div
            onClick={() => live !== null && copy(live)}
            title={live !== null ? 'Click to copy' : undefined}
            style={{
              marginTop: 10, textAlign: 'right', fontSize: 32, fontWeight: 700, minHeight: 40,
              color: live === null ? 'var(--theme-text3)' : 'var(--theme-accent)',
              cursor: live !== null ? 'pointer' : 'default',
            }}
          >
            {live === null ? (expr.trim() ? '—' : '') : (copied === live ? '✓ copied' : live.toLocaleString())}
          </div>
        </div>

        {/* Keypad */}
        <div style={{ padding: '0 14px 12px', display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 6 }}>
          {KEYS.map((row, ri) => (
            row.map(k => (
              <button key={k} onClick={() => press(k)} style={'0123456789.'.includes(k) ? keyBtn : opBtn}>
                {k === '*' ? '×' : k === '/' ? '÷' : k}
              </button>
            )).concat(
              ri === 0 ? [<button key="clr" onClick={() => setExpr('')} style={{ ...keyBtn, color: 'var(--theme-red)', fontSize: 15 }}>C</button>]
              : ri === 1 ? [<button key="del" onClick={() => setExpr(e => e.slice(0, -1))} style={{ ...keyBtn, fontSize: 15 }}>⌫</button>]
              : ri === 2 ? [<button key="plus" onClick={() => press('+')} style={opBtn}>+</button>]
              : [<button key="eq" onClick={commit} disabled={live === null} style={{ ...keyBtn, background: 'var(--theme-accent)', borderColor: 'var(--theme-accent)', color: 'var(--theme-accent-text)', opacity: live === null ? 0.4 : 1 }}>=</button>]
            )
          ))}
        </div>

        {/* Tape */}
        {tape.length > 0 && (
          <div style={{ borderTop: '1px solid var(--theme-border)', maxHeight: '26vh', overflowY: 'auto' }}>
            {tape.map(t => (
              <div
                key={t.id}
                onClick={() => { setExpr(t.expr); inputRef.current?.focus() }}
                title="Click to reuse this expression"
                style={{
                  display: 'flex', alignItems: 'baseline', gap: 10, padding: '8px 14px',
                  cursor: 'pointer', fontSize: 14,
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--theme-table-hover)' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'none' }}
              >
                <span style={{ flex: 1, color: 'var(--theme-text3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.expr}</span>
                <span
                  onClick={e => { e.stopPropagation(); copy(t.result) }}
                  title="Click to copy"
                  style={{ color: 'var(--theme-text1)', fontWeight: 600 }}
                >
                  {copied === t.result ? '✓' : t.result.toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Tape footer */}
        {tape.length > 1 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderTop: '1px solid var(--theme-border)', fontSize: 13 }}>
            <span style={{ flex: 1, color: 'var(--theme-text3)' }}>Sum of tape</span>
            <span style={{ color: 'var(--theme-accent)', fontWeight: 700 }}>{tapeSum.toLocaleString()}</span>
            <button
              onClick={() => setTape([])}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--theme-text3)', fontSize: 12, fontFamily: 'inherit', padding: 0 }}
            >
              Clear
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}
