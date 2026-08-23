import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { daysInBsMonth, getBsToday, bsToAd, adToBsSafe, formatAd, BS_MONTHS, BS_YEAR_MIN, BS_YEAR_MAX } from '../utils/bsCalendar'
import SearchableSelect from './SearchableSelect'

const DAY_LABELS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']

// Exactly the verified BS_CALENDAR range (2000–2087 as of S559) — this one component is shared
// by DOB, join/retirement dates, purchase dates, leave requests, etc., and it both DISPLAYS and
// WRITES dates, so a year outside the verified table must not be selectable at all: bsToAd on an
// approximated year would silently store a wrong AD date (the S559 five-days-out DOB bug).
const YEAR_RANGE = Array.from({ length: BS_YEAR_MAX - BS_YEAR_MIN + 1 }, (_, i) => BS_YEAR_MIN + i)
const YEAR_OPTIONS = YEAR_RANGE.map(y => ({ value: String(y), label: String(y) }))

/**
 * Visual BS calendar picker — two modes:
 *
 * FREE mode (default):
 *   value:    AD ISO string "YYYY-MM-DD" or ""
 *   onChange: called with "YYYY-MM-DD"
 *   Month navigation enabled.
 *
 * PERIOD-LOCKED mode (pass lockYear + lockMonth):
 *   value:    day number within the locked BS month (string/number) or ""
 *   onChange: called with the day number as a string
 *   No month navigation — the grid is pinned to the locked period.
 */
export default function BsCalendarPicker({
  value, onChange,
  lockYear, lockMonth,
  placeholder = 'Select BS date',
  disabled = false, clearable = false,
  id, ariaLabel,
  // The validation message this picker's field is showing, or falsy. It has to be a PROP for the
  // same reason `touch` does: every size and colour in this component is an inline style, so the
  // `[aria-invalid="true"]` rules in Layout.css have no path to the trigger. Passing the message
  // itself (rather than a boolean) lets the trigger point `aria-describedby` at the `<FieldError>`
  // rendered beside it, which is the half that makes the state announced rather than merely red.
  invalid = '',
  // Opt-in phone sizing for the Crest Staff portal. It has to be a prop, not a
  // `@media (pointer: coarse)` rule, because every size in this component is an inline style and
  // a media query cannot reach one. On the default path nothing changes; with `touch` the day
  // cells go from 26px to 44 (a 26px cell in a 7-column grid is a ~36×26 target — under WCAG
  // 2.2's 24px floor once the gap is counted, and nowhere near a thumb), the nav arrows and month
  // select come up with them, and the popover fills the width it is given instead of a 280px cap.
  touch = false,
}) {
  const locked = lockYear != null && lockMonth != null
  const today  = getBsToday()

  // Resolve the currently-selected BS date from value, per mode. adToBsSafe (not adToBs): a
  // stored AD date outside the verified table (pre-1943 / post-2031) converts to a confidently
  // WRONG BS date under the plain function — better to show the raw AD date (below) and let the
  // grid open at today than to display and potentially re-save an approximation.
  const selected = locked
    ? (value ? { year: lockYear, month: lockMonth, day: parseInt(value) } : null)
    : (value ? adToBsSafe(new Date(value.includes('T') ? value : value + 'T00:00:00')) : null)

  const [navYear,  setNavYear]  = useState(selected?.year  || lockYear  || today.year)
  const [navMonth, setNavMonth] = useState(selected?.month || lockMonth || today.month)
  const [open,     setOpen]     = useState(false)
  const [pos,      setPos]      = useState({ top: 0, left: 0, width: 0, above: false })

  const triggerRef = useRef(null)
  const popoverRef = useRef(null)

  // Keep nav pinned to the locked period whenever it changes
  useEffect(() => {
    if (locked) { setNavYear(lockYear); setNavMonth(lockMonth) }
  }, [locked, lockYear, lockMonth])

  // When picker opens (free mode), navigate to the selected date (or today)
  useEffect(() => {
    if (!open || locked) return
    if (selected) { setNavYear(selected.year); setNavMonth(selected.month) }
    else          { setNavYear(today.year);    setNavMonth(today.month) }
  }, [open]) // eslint-disable-line

  // Position the dropdown
  useEffect(() => {
    if (!open || !triggerRef.current) return
    const rect       = triggerRef.current.getBoundingClientRect()
    const spaceBelow = window.innerHeight - rect.bottom
    const above      = spaceBelow < 240
    setPos({
      top:   above ? Math.max(8, rect.top - 4) : rect.bottom + 4,
      // On touch the calendar takes the full width of the field it belongs to (clamped to the
      // viewport), so a 44px day cell has room to be 44px wide as well as tall.
      left:  touch ? Math.max(8, Math.min(rect.left, window.innerWidth - rect.width - 8))
                   : Math.min(rect.left, window.innerWidth - 284),
      width: touch ? Math.min(Math.max(rect.width, 300), window.innerWidth - 16)
                   : Math.min(Math.max(rect.width, 260), 280),
      above,
    })
  }, [open, touch])

  // Escape closes the calendar, and must not reach anything else.
  //
  // Modal listens for Escape on `document` in the bubble phase, so without this the key closed
  // the whole dialog the picker was opened from — on the employee portal that meant a half-filled
  // leave request vanishing because someone dismissed a date picker. Capture phase plus
  // stopPropagation is what keeps the outer dialog out of it; the picker only claims the key
  // while it is actually open.
  useEffect(() => {
    if (!open) return undefined
    const onKey = e => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setOpen(false)
      triggerRef.current?.querySelector('button')?.focus()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [open])

  // Close on outside click. Checks both the trigger AND the portaled popover (the popover's
  // DOM node lives under document.body, not under triggerRef, since it's a portal) — this lets
  // the event keep bubbling to document instead of being swallowed here, which matters because
  // the nested Year SearchableSelect relies on its own document-level listener to self-close;
  // swallowing the event earlier left it stuck open when e.g. the Month select was used next.
  useEffect(() => {
    if (!open) return
    const handler = e => {
      if (triggerRef.current?.contains(e.target)) return
      if (popoverRef.current?.contains(e.target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  function prevMonth() {
    if (locked) return
    if (navMonth === 1) {
      if (navYear <= BS_YEAR_MIN) return // don't walk off the verified table
      setNavYear(y => y - 1); setNavMonth(12)
    } else setNavMonth(m => m - 1)
  }
  function nextMonth() {
    if (locked) return
    if (navMonth === 12) {
      if (navYear >= BS_YEAR_MAX) return // don't walk off the verified table
      setNavYear(y => y + 1); setNavMonth(1)
    } else setNavMonth(m => m + 1)
  }

  function selectDay(day) {
    onChange(locked ? String(day) : formatAd(bsToAd(navYear, navMonth, day)))
    setOpen(false)
  }

  // "Today" — in locked mode only valid when the locked period is the current BS month
  const todayInView = locked
    ? (lockYear === today.year && lockMonth === today.month)
    : true

  function goToday() {
    if (locked) {
      onChange(String(today.day))
    } else {
      setNavYear(today.year)
      setNavMonth(today.month)
      onChange(formatAd(bsToAd(today.year, today.month, today.day)))
    }
    setOpen(false)
  }

  // Build calendar grid cells: null = blank padding, number = day
  const firstDow  = bsToAd(navYear, navMonth, 1).getDay()
  const daysCount = daysInBsMonth(navYear, navMonth)
  const cells     = []
  for (let i = 0; i < firstDow; i++) cells.push(null)
  for (let d = 1; d <= daysCount; d++) cells.push(d)
  while (cells.length % 7 !== 0) cells.push(null)

  // A value whose BS conversion is out of the verified range still displays — as its truthful
  // AD form — rather than as a silently-approximated BS date or a blank that reads as "unset".
  const displayValue = selected
    ? `${selected.day} ${BS_MONTHS[selected.month - 1]} ${selected.year}`
    : (!locked && value ? `${value.slice(0, 10)} (AD)` : '')

  const navBtn = (enabled) => ({
    background: 'none', border: 'none',
    cursor: enabled ? 'pointer' : 'default',
    color: enabled ? 'var(--theme-text2)' : 'transparent',
    fontSize: touch ? 22 : 18, lineHeight: 1,
    padding: touch ? '8px 14px' : '2px 8px', minHeight: touch ? 44 : undefined,
    borderRadius: 4, fontFamily: 'inherit',
  })

  const popover = open ? createPortal(
    <div
      ref={popoverRef}
      style={{
        position:  'fixed',
        top:       pos.above ? undefined : pos.top,
        bottom:    pos.above ? window.innerHeight - pos.top + 4 : undefined,
        left:      pos.left,
        width:     pos.width,
        minWidth:  touch ? 0 : 260,
        // dvh, not vh: a phone browser's chrome collapses on scroll and vh does not follow it.
        maxHeight: 'calc(100dvh - 16px)',
        overflowY: 'auto',
        zIndex:    9999,
        background: 'var(--theme-card)',
        border:    '1px solid var(--theme-border)',
        borderRadius: 10,
        boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
        padding:   '10px 10px 6px',
      }}
    >
      {/* Month/year navigation (locked mode keeps the plain label, no controls to jump around) */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4, marginBottom: 6 }}>
        <button style={navBtn(!locked)} onClick={prevMonth} disabled={locked}>‹</button>
        {locked ? (
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--theme-text1)' }}>
            {BS_MONTHS[navMonth - 1]} {navYear}
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 4, flex: 1, minWidth: 0 }}>
            <select aria-label="Month"
              value={navMonth}
              onChange={e => setNavMonth(parseInt(e.target.value, 10))}
              style={{
                flex: 1.3, minWidth: 0, background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)',
                borderRadius: 5, padding: touch ? '10px 8px' : '4px 4px',
                // 16px on touch: below it iOS zooms the viewport the moment this select is opened.
                fontSize: touch ? 16 : 11, minHeight: touch ? 44 : undefined,
                color: 'var(--theme-text1)',
                fontFamily: 'inherit', cursor: 'pointer',
              }}
            >
              {BS_MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select>
            <SearchableSelect
              value={String(navYear)}
              onChange={v => setNavYear(parseInt(v, 10))}
              options={YEAR_OPTIONS}
              touch={touch}
              style={{ flex: 1 }}
            />
          </div>
        )}
        <button style={navBtn(!locked)} onClick={nextMonth} disabled={locked}>›</button>
      </div>

      {/* Day-of-week headers */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 1, marginBottom: 2 }}>
        {DAY_LABELS.map(d => (
          <div key={d} style={{ textAlign: 'center', fontSize: 9, fontWeight: 700, color: 'var(--theme-text3)', padding: '1px 0' }}>
            {d}
          </div>
        ))}
      </div>

      {/* Day grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 1 }}>
        {cells.map((day, i) => {
          if (!day) return <div key={i} style={{ height: touch ? 44 : 26 }} />
          const isToday = day === today.day && navMonth === today.month && navYear === today.year
          const isSel   = selected && day === selected.day && navMonth === selected.month && navYear === selected.year
          return (
            <button
              key={i}
              type="button"
              onClick={() => selectDay(day)}
              style={{
                width: '100%', height: touch ? 44 : 26, border: 'none',
                borderRadius: touch ? 'var(--radius-sm)' : 4, fontSize: touch ? 15 : 11, cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontWeight: isSel || isToday ? 700 : 400,
                background: isSel
                  ? 'var(--theme-accent)'
                  : isToday
                    ? 'var(--theme-focus-ring)'
                    : 'transparent',
                color: isSel
                  ? 'var(--theme-accent-text)'
                  : isToday
                    ? 'var(--theme-accent)'
                    : 'var(--theme-text1)',
                outline: isToday && !isSel ? '1px solid var(--theme-accent)' : 'none',
                fontFamily: 'inherit',
              }}
            >
              {day}
            </button>
          )
        })}
      </div>

      {/* Footer */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        marginTop: 5, paddingTop: 5, borderTop: '1px solid var(--theme-border)',
      }}>
        {todayInView ? (
          <button
            type="button"
            onClick={goToday}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: touch ? 14 : 11, color: 'var(--theme-accent-ink)', fontWeight: 600, padding: touch ? '10px 8px' : '2px 4px', minHeight: touch ? 44 : undefined, fontFamily: 'inherit' }}
          >
            Today
          </button>
        ) : <span />}
        {clearable && value && (
          <button
            type="button"
            onClick={() => { onChange(''); setOpen(false) }}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: touch ? 14 : 11, color: 'var(--theme-text3)', padding: touch ? '10px 8px' : '2px 4px', minHeight: touch ? 44 : undefined, fontFamily: 'inherit' }}
          >
            Clear
          </button>
        )}
      </div>
    </div>,
    document.body
  ) : null

  return (
    <div ref={triggerRef} style={{ position: 'relative' }}>
      {/* The invalid state reaches the trigger as aria-describedby, NOT aria-invalid: this is a
          <button>, and aria-invalid is not supported on the button role — a button cannot be in an
          invalid VALUE state, so assistive tech ignores it (and jsx-a11y flags it). Pointing at the
          <FieldError> beside it is what actually reaches a screen-reader user; the red border below
          is the sighted half. Making this a real combobox, the way SearchableSelect became one in
          S521, would earn aria-invalid properly — a larger change than the one this belongs to. */}
      <button
        type="button"
        id={id}
        aria-label={ariaLabel}
        aria-describedby={invalid && id ? `${id}-err` : undefined}
        disabled={disabled}
        onClick={() => !disabled && setOpen(o => !o)}
        style={{
          width: '100%', textAlign: 'left', cursor: disabled ? 'not-allowed' : 'pointer',
          background: 'var(--theme-input-bg)',
          // Invalid outranks open: focusing the field the user has to fix is exactly when the
          // signal must not disappear.
          border: `1px solid ${invalid ? 'var(--theme-red)' : open ? 'var(--theme-accent)' : 'var(--theme-border)'}`,
          borderRadius: touch ? 'var(--radius-md)' : 6, padding: touch ? '11px 12px' : '8px 10px',
          minHeight: touch ? 44 : undefined, fontSize: touch ? 16 : 13,
          color: displayValue ? 'var(--theme-text1)' : 'var(--theme-text3)',
          boxShadow: open ? '0 0 0 3px var(--theme-focus-ring)' : 'none',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          fontFamily: 'inherit', transition: 'border-color 0.15s',
        }}
      >
        <span>{displayValue || placeholder}</span>
        <span style={{ color: 'var(--theme-text3)', fontSize: 13, flexShrink: 0 }}>▾</span>
      </button>
      {popover}
    </div>
  )
}
