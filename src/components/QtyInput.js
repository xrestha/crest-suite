import { useRef, useState } from 'react'
import { evaluate, looksLikeExpression } from '../utils/evalMath'

// A numeric field that also accepts arithmetic: type "3*24+7" in a stock-count box and it
// commits 79. Counting stock is full of this ("3 cartons of 24 plus 7 loose"), and doing the
// sum elsewhere then typing the answer back is where transcription errors get in.
//
// The important invariant: the raw expression lives ONLY in this component's local `draft`.
// The parent is only ever handed a number (or ''), so live totals, COGS math, offline queue
// entries and DB writes can never see a half-typed "3*24" and parseFloat it down to 3.
//
// Plain numeric typing is passed straight through on every keystroke exactly as the old
// <input type="number"> did — the deferred-commit path only engages once the text actually
// contains an operator, so nothing about the normal case changes.
//
// Note this renders type="text", since type="number" refuses to hold "3*24" at all.
// inputMode="decimal" keeps the numeric keypad on mobile, and the spinners it loses were
// already hidden by CSS on the mobile stock inputs.
export default function QtyInput({
  value,
  onChange,
  onCommit,
  wrapperStyle,
  disabled,
  style,
  ...rest
}) {
  const [draft, setDraft] = useState(null) // non-null only while focused
  // Escape's cancel flag must be a ref, not state: Escape blurs the field, and the blur's
  // commit() runs synchronously in the same task — before React has re-rendered — so it closes
  // over the PRE-Escape `draft` and would happily commit the expression Escape was meant to
  // discard (measured: Esc after "12*4" committed 48, byte-identical to Enter — S623).
  const cancelRef = useRef(false)

  const asText = value === '' || value == null ? '' : String(value)
  const shown = draft !== null ? draft : asText

  const isExpr = draft !== null && looksLikeExpression(draft)
  const preview = isExpr ? evaluate(draft) : null

  // Callers right-align these boxes to sit flush with a numeric column at rest. But a native
  // input scrolled to keep the caret visible clips from the LEFT under text-align:right — once
  // an expression like "760*2" outgrows the box, the leading digit gets sliced mid-glyph
  // instead of just scrolling off, reading as garbled ("i0*2" for what was actually typed as
  // "760*2"). Left-align only while actively editing, so typing is always readable from the
  // start; revert to the caller's alignment once committed and showing the resting value.
  const inputStyle = draft !== null ? { ...style, textAlign: 'left' } : style

  function handleChange(e) {
    const raw = e.target.value
    setDraft(raw)
    // Only mirror plain numbers upward while typing. An in-progress expression deliberately
    // leaves the parent on its last good value so row totals don't flicker through nonsense —
    // and so does anything that doesn't parse as itself ("5oo"): the old <input type="number">
    // reported '' for that, so a stray character must never reach a parent whose parseFloat
    // would read a prefix of it. Blur then evaluates or reverts it (see commit()).
    if (!looksLikeExpression(raw) && !Number.isNaN(Number(raw))) onChange?.(raw)
  }

  function commit() {
    if (cancelRef.current) {
      // Escape asked for a revert; this blur-commit runs before the setDraft(null) has
      // re-rendered, so without the ref it would still see the discarded draft.
      cancelRef.current = false
      setDraft(null)
      return
    }
    if (draft === null) return
    const raw = draft.trim()
    let next

    if (raw === '') {
      next = ''
    } else {
      // Everything non-empty goes through evaluate(), expression or not: it computes "3*24+7",
      // normalises anything tokenize() accepts ("1,200" → 1200, "12x4" → 48), and returns null
      // for an incomplete expression ("3*", "2+(4") or genuine garbage ("5oo"), which reverts to
      // the last good value. Never hand the raw string up: a parent's parseFloat would read a
      // prefix of it ("1,200" → 1) and store a confidently wrong figure (S623).
      const result = evaluate(raw)
      next = result === null ? (value ?? '') : result
    }

    setDraft(null)
    onChange?.(next)
    onCommit?.(next)
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') {
      // Blur and let onBlur run commit() exactly once — calling commit() here too made every
      // Enter fire onCommit twice (the keydown's commit, then the blur's, both from the same
      // still-rendered closure), double-running any call site whose onCommit writes.
      e.preventDefault()
      e.currentTarget.blur()
    }
    if (e.key === 'Escape') {
      // Only consume Escape when there is an edit to cancel — then it reverts this box and
      // must NOT also close a host Modal (stopPropagation keeps it from the document-level
      // listener). An untouched box lets Escape through, so the dialog's normal Esc-to-close
      // still works.
      if (draft !== null && draft !== asText) {
        e.preventDefault()
        e.stopPropagation()
        cancelRef.current = true
        setDraft(null)
        e.currentTarget.blur()
      }
    }
  }

  return (
    <span style={{ position: 'relative', display: 'inline-block', ...wrapperStyle }}>
      <input
        type="text"
        inputMode="decimal"
        autoComplete="off"
        value={shown}
        disabled={disabled}
        onChange={handleChange}
        onFocus={() => setDraft(asText)}
        onBlur={commit}
        onKeyDown={handleKeyDown}
        style={inputStyle}
        {...rest}
      />
      {isExpr && (
        <span
          style={{
            position: 'absolute', right: 0, bottom: '100%', marginBottom: 3,
            fontSize: 11, fontWeight: 700, lineHeight: 1.4,
            padding: '2px 7px', borderRadius: 4, whiteSpace: 'nowrap',
            pointerEvents: 'none', zIndex: 5,
            background: 'var(--theme-card)',
            border: `1px solid ${preview === null ? 'rgba(248,113,113,0.45)' : 'rgba(201,168,76,0.45)'}`,
            color: preview === null ? 'var(--theme-red)' : 'var(--theme-accent)',
          }}
        >
          {preview === null ? '⌫ incomplete' : `= ${preview.toLocaleString()}`}
        </span>
      )}
    </span>
  )
}
