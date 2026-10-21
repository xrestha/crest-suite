import { useState, useEffect, useRef, useId } from 'react'
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

// What Tab cycles through inside the open popover. Unlike Modal's list it skips `tabindex="-1"`
// buttons, which is every day but the roving one.
const POPOVER_FOCUSABLE = 'button:not([disabled]):not([tabindex="-1"]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
const ARROW_DAYS = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }

// The day cells are inline-styled with `outline: none`, and `:focus-visible` has no inline form, so
// the ring is drawn from this test instead (S841). Older engines without the selector get the ring.
const isFocusVisible = el => { try { return el.matches(':focus-visible') } catch { return true } }

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
  // The day the arrow keys last moved to, or null for the shown month's default (selected day,
  // else today, else the 1st). Only that day's button is a Tab stop: a roving tabindex (S841).
  const [activeDay, setActiveDay] = useState(null)
  // Whether the focused day was reached by keyboard, so it wears the focus ring. Only the roving
  // day can hold keyboard focus, so a flag is enough; a per-day value would follow the wrong cell
  // when a page turn reuses the focused button for another day.
  const [dayRing, setDayRing] = useState(false)

  const triggerRef = useRef(null)
  const buttonRef  = useRef(null)
  const popoverRef = useRef(null)
  // What the next render should focus: 'day' (the roving day) or 'year' (the year field's button,
  // after a pick unmounts its search box). A ref, so setting it never renders by itself.
  const focusPendingRef = useRef(null)
  const popoverId = useId()
  const yearId = useId()

  // Keep nav pinned to the locked period whenever it changes
  useEffect(() => {
    if (locked) { setNavYear(lockYear); setNavMonth(lockMonth) }
  }, [locked, lockYear, lockMonth])

  // Opening (free mode) navigates to the selected date, or today. This was an effect on `open`;
  // it is set in the same batch as `open` now (S841), so the popover's first render already shows
  // the right month and the focus move below lands on the right day, not on the last visit's.
  function openPicker() {
    if (!locked) {
      if (selected) { setNavYear(selected.year); setNavMonth(selected.month) }
      else          { setNavYear(today.year);    setNavMonth(today.month) }
    }
    setActiveDay(null)
    focusPendingRef.current = 'day'
    setOpen(true)
  }

  // Every close from inside the popover hands focus back to the trigger; the popover is about to
  // unmount, and focus inside it would otherwise fall to <body> (S841).
  function closePicker() {
    setOpen(false)
    buttonRef.current?.focus()
  }

  // Move focus into the popover on open, and after an arrow key or a year pick re-renders it.
  // No dependency list on purpose: it acts only when focusPendingRef asks it to.
  useEffect(() => {
    const want = focusPendingRef.current
    if (!open || !want) return
    focusPendingRef.current = null
    const pop = popoverRef.current
    const el = want === 'year'
      ? pop?.querySelector('button[aria-haspopup="listbox"]')
      : pop?.querySelector('button[data-bs-day][tabindex="0"]')
    el?.focus()
  })

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
  //
  // Tab and Shift+Tab cycle inside the popover (S841). It is portalled to <body>, so inside a Modal,
  // whose trap covers only its own panel, Tab went from the trigger straight to the next field and
  // the calendar could not be reached by keyboard at all (POS Reservations' booking form).
  // preventDefault is what makes Modal's own listener stand down: it returns on `defaultPrevented`.
  useEffect(() => {
    if (!open) return undefined
    const onKey = e => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
        buttonRef.current?.focus()
        return
      }
      if (e.key !== 'Tab') return
      const items = Array.from(popoverRef.current?.querySelectorAll(POPOVER_FOCUSABLE) || [])
      if (items.length === 0) return
      e.preventDefault()
      const i = items.indexOf(document.activeElement)
      const step = e.shiftKey ? -1 : 1
      const next = i === -1
        ? items[e.shiftKey ? items.length - 1 : 0]
        : items[(i + step + items.length) % items.length]
      next.focus()
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
    setActiveDay(null)
    if (navMonth === 1) {
      if (navYear <= BS_YEAR_MIN) return // don't walk off the verified table
      setNavYear(y => y - 1); setNavMonth(12)
    } else setNavMonth(m => m - 1)
  }
  function nextMonth() {
    if (locked) return
    setActiveDay(null)
    if (navMonth === 12) {
      if (navYear >= BS_YEAR_MAX) return // don't walk off the verified table
      setNavYear(y => y + 1); setNavMonth(1)
    } else setNavMonth(m => m + 1)
  }

  // Arrow keys on a day: ±1 day across, ±7 down (S841). Past the month's edge they turn the page,
  // except in locked mode (the grid is pinned to its period) and at the verified table's ends,
  // the same bound prevMonth/nextMonth keep. Month lengths come from the table, never 30.
  function onDayKeyDown(e, day) {
    const delta = ARROW_DAYS[e.key]
    if (!delta) return
    e.preventDefault()
    let y = navYear, m = navMonth, d = day + delta
    const len = daysInBsMonth(y, m)
    if (d < 1 || d > len) {
      if (locked) return
      if (d < 1) {
        if (m === 1) { if (y <= BS_YEAR_MIN) return; y -= 1; m = 12 } else m -= 1
        d += daysInBsMonth(y, m)
      } else {
        if (m === 12) { if (y >= BS_YEAR_MAX) return; y += 1; m = 1 } else m += 1
        d -= len
      }
    }
    setNavYear(y); setNavMonth(m); setActiveDay(d)
    focusPendingRef.current = 'day'
  }

  function selectDay(day) {
    onChange(locked ? String(day) : formatAd(bsToAd(navYear, navMonth, day)))
    closePicker()
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
    closePicker()
  }

  // Build calendar grid cells: null = blank padding, number = day
  const firstDow  = bsToAd(navYear, navMonth, 1).getDay()
  const daysCount = daysInBsMonth(navYear, navMonth)
  const cells     = []
  for (let i = 0; i < firstDow; i++) cells.push(null)
  for (let d = 1; d <= daysCount; d++) cells.push(d)
  while (cells.length % 7 !== 0) cells.push(null)

  // The one day button that is a Tab stop: where the arrows last went, else the selected day if
  // it is in view, else today if it is, else the 1st.
  const inView = d => Number.isInteger(d) && d >= 1 && d <= daysCount
  const shows  = bs => bs && bs.year === navYear && bs.month === navMonth
  const rovingDay = [activeDay, shows(selected) && selected.day, shows(today) && today.day].find(inView) || 1

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
    borderRadius: 0, fontFamily: 'inherit',
  })

  const popover = open ? createPortal(
    <div
      ref={popoverRef}
      id={popoverId}
      // A dialog, not a modal one: nothing behind it is made inert, so no aria-modal (S841).
      role="dialog"
      aria-label="Choose a date"
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
        borderRadius: 0,
        boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
        padding:   '10px 10px 6px',
      }}
    >
      {/* Month/year navigation (locked mode keeps the plain label, no controls to jump around) */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4, marginBottom: 6 }}>
        <button type="button" className="picker-btn" style={navBtn(!locked)} onClick={prevMonth} disabled={locked} aria-label="Previous month">‹</button>
        {locked ? (
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--theme-text1)' }}>
            {BS_MONTHS[navMonth - 1]} {navYear}
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 4, flex: 1, minWidth: 0 }}>
            <select aria-label="Month"
              value={navMonth}
              onChange={e => { setNavMonth(parseInt(e.target.value, 10)); setActiveDay(null) }}
              style={{
                flex: 1.3, minWidth: 0, background: 'var(--theme-input-bg)', border: '1px solid var(--theme-input-border)',
                borderRadius: 0, padding: touch ? '10px 8px' : '4px 4px',
                // 16px on touch: below it iOS zooms the viewport the moment this select is opened.
                fontSize: touch ? 16 : 11, minHeight: touch ? 44 : undefined,
                color: 'var(--theme-text1)',
                fontFamily: 'inherit', cursor: 'pointer',
              }}
            >
              {BS_MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select>
            {/* SearchableSelect's `id` lands on its trigger, so a hidden label names the year field
                the way aria-label names the month one (S841); it read as a bare "2082" button. */}
            <label htmlFor={yearId} className="sr-only">Year</label>
            <SearchableSelect
              id={yearId}
              value={String(navYear)}
              // A pick unmounts the year search box that had focus; hand it to the year field's
              // button so the keyboard stays inside the popover (S841).
              onChange={v => { setNavYear(parseInt(v, 10)); setActiveDay(null); focusPendingRef.current = 'year' }}
              options={YEAR_OPTIONS}
              touch={touch}
              style={{ flex: 1 }}
            />
          </div>
        )}
        <button type="button" className="picker-btn" style={navBtn(!locked)} onClick={nextMonth} disabled={locked} aria-label="Next month">›</button>
      </div>

      {/* Day-of-week headers. 10px, the floor for text: 9px is the chevron step, for a glyph (S852). */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 1, marginBottom: 2 }}>
        {DAY_LABELS.map(d => (
          <div key={d} style={{ textAlign: 'center', fontSize: 10, fontWeight: 700, color: 'var(--theme-text3)', padding: '1px 0' }}>
            {d}
          </div>
        ))}
      </div>

      {/* Day grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 1 }}>
        {cells.map((day, i) => {
          if (!day) return <div key={i} style={{ height: touch ? 44 : 26 }} />
          const isToday = day === today.day && navMonth === today.month && navYear === today.year
          const isSel   = !!selected && day === selected.day && navMonth === selected.month && navYear === selected.year
          // The full BS date as the name, and the states as attributes, so neither the selected day
          // nor today is carried by colour alone (S841).
          return (
            <button
              key={i}
              type="button"
              data-bs-day={day}
              tabIndex={day === rovingDay ? 0 : -1}
              aria-label={`${day} ${BS_MONTHS[navMonth - 1]} ${navYear}`}
              aria-pressed={isSel}
              aria-current={isToday ? 'date' : undefined}
              onClick={() => selectDay(day)}
              onKeyDown={e => onDayKeyDown(e, day)}
              onFocus={e => setDayRing(isFocusVisible(e.currentTarget))}
              onBlur={() => setDayRing(false)}
              style={{
                width: '100%', height: touch ? 44 : 26, border: 'none',
                borderRadius: touch ? 'var(--radius-sm)' : 'var(--radius-xs)', fontSize: touch ? 15 : 11, cursor: 'pointer',
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
                    ? 'var(--theme-accent-ink)'
                    : 'var(--theme-text1)',
                outline: isToday && !isSel ? '1px solid var(--theme-accent)' : 'none',
                // The focus pair as an inset: the outline token, then a card-coloured gap so the
                // ring still reads on the selected day's accent fill.
                boxShadow: dayRing && day === rovingDay
                  ? 'inset 0 0 0 2px var(--theme-focus-outline), inset 0 0 0 4px var(--theme-card)'
                  : 'none',
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
            className="picker-btn"
            onClick={goToday}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: touch ? 14 : 11, color: 'var(--theme-accent-ink)', fontWeight: 600, padding: touch ? '10px 8px' : '2px 4px', minHeight: touch ? 44 : undefined, fontFamily: 'inherit' }}
          >
            Today
          </button>
        ) : <span />}
        {clearable && value && (
          <button
            type="button"
            className="picker-btn"
            onClick={() => { onChange(''); closePicker() }}
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
      {/* `picker-trigger` carries the keyboard focus pair (Layout.css), which an inline style cannot
          express; the inline `boxShadow: 'none'` here had cancelled the browser ring and put nothing
          in its place (S852). So the inline shadow is set only while open, and left to the class
          otherwise. */}
      <button
        ref={buttonRef}
        type="button"
        id={id}
        className="picker-trigger"
        aria-label={ariaLabel}
        aria-describedby={invalid && id ? `${id}-err` : undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        disabled={disabled}
        onClick={() => { if (disabled) return; if (open) setOpen(false); else openPicker() }}
        style={{
          width: '100%', textAlign: 'left', cursor: disabled ? 'not-allowed' : 'pointer',
          // Disabled steps the surface DOWN, as a disabled .form-input does: the well goes and the
          // border drops to border-lt, while the date stays as readable as it was (S852). It had
          // kept the full field look, and with the stronger input border it would read as editable.
          background: disabled ? 'transparent' : 'var(--theme-input-bg)',
          // Invalid outranks open: focusing the field the user has to fix is exactly when the
          // signal must not disappear.
          border: `1px solid ${invalid ? 'var(--theme-red)' : open ? 'var(--theme-accent)' : disabled ? 'var(--theme-border-lt)' : 'var(--theme-input-border)'}`,
          borderRadius: 'var(--radius-md)', padding: touch ? '11px 12px' : '8px 10px',
          minHeight: touch ? 44 : undefined, fontSize: touch ? 16 : 13,
          color: displayValue ? 'var(--theme-text1)' : 'var(--theme-text3)',
          boxShadow: open ? '0 0 0 3px var(--theme-focus-ring)' : undefined,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          // The motion token, so the reduced-motion block (which zeroes it) reaches this too.
          fontFamily: 'inherit', transition: 'border-color var(--motion-fast) var(--ease-standard)',
        }}
      >
        <span>{displayValue || placeholder}</span>
        <span style={{ color: 'var(--theme-text3)', fontSize: 13, flexShrink: 0 }}>▾</span>
      </button>
      {popover}
    </div>
  )
}
