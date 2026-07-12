import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { daysInBsMonth, getBsToday, bsToAd, adToBs, formatAd, BS_MONTHS } from '../utils/bsCalendar'
import SearchableSelect from './SearchableSelect'

const DAY_LABELS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']

// Wide enough for any realistic Date of Birth or business date without the list getting
// unwieldy — this one component is shared by DOB, join/retirement dates, purchase dates,
// leave requests, etc., so it can't be tuned per-usage. Note: the precise BS day-count table
// (bsCalendar.js) only covers 2079–2087; years outside that already fall back to a flat
// 30-day/month approximation — pre-existing, unrelated to this picker, just reachable faster now.
const YEAR_RANGE = Array.from({ length: 91 }, (_, i) => 2000 + i) // 2000..2090
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
}) {
  const locked = lockYear != null && lockMonth != null
  const today  = getBsToday()

  // Resolve the currently-selected BS date from value, per mode
  const selected = locked
    ? (value ? { year: lockYear, month: lockMonth, day: parseInt(value) } : null)
    : (value ? adToBs(new Date(value.includes('T') ? value : value + 'T00:00:00')) : null)

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
      left:  Math.min(rect.left, window.innerWidth - 284),
      width: Math.min(Math.max(rect.width, 260), 280),
      above,
    })
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
    if (navMonth === 1) { setNavYear(y => y - 1); setNavMonth(12) }
    else setNavMonth(m => m - 1)
  }
  function nextMonth() {
    if (locked) return
    if (navMonth === 12) { setNavYear(y => y + 1); setNavMonth(1) }
    else setNavMonth(m => m + 1)
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

  const displayValue = selected
    ? `${selected.day} ${BS_MONTHS[selected.month - 1]} ${selected.year}`
    : ''

  const navBtn = (enabled) => ({
    background: 'none', border: 'none',
    cursor: enabled ? 'pointer' : 'default',
    color: enabled ? 'var(--theme-text2)' : 'transparent',
    fontSize: 18, lineHeight: 1, padding: '2px 8px',
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
        minWidth:  260,
        maxHeight: 'calc(100vh - 16px)',
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
            <select
              value={navMonth}
              onChange={e => setNavMonth(parseInt(e.target.value, 10))}
              style={{
                flex: 1.3, minWidth: 0, background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)',
                borderRadius: 5, padding: '4px 4px', fontSize: 11, color: 'var(--theme-text1)',
                fontFamily: 'inherit', cursor: 'pointer',
              }}
            >
              {BS_MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select>
            <SearchableSelect
              value={String(navYear)}
              onChange={v => setNavYear(parseInt(v, 10))}
              options={YEAR_OPTIONS}
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
          if (!day) return <div key={i} style={{ height: 26 }} />
          const isToday = day === today.day && navMonth === today.month && navYear === today.year
          const isSel   = selected && day === selected.day && navMonth === selected.month && navYear === selected.year
          return (
            <button
              key={i}
              type="button"
              onClick={() => selectDay(day)}
              style={{
                width: '100%', height: 26, border: 'none',
                borderRadius: 4, fontSize: 11, cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontWeight: isSel || isToday ? 700 : 400,
                background: isSel
                  ? 'var(--theme-accent)'
                  : isToday
                    ? 'rgba(201,168,76,0.12)'
                    : 'transparent',
                color: isSel
                  ? '#0f1117'
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
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, color: 'var(--theme-accent)', fontWeight: 600, padding: '2px 4px', fontFamily: 'inherit' }}
          >
            Today
          </button>
        ) : <span />}
        {clearable && value && (
          <button
            type="button"
            onClick={() => { onChange(''); setOpen(false) }}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, color: 'var(--theme-text3)', padding: '2px 4px', fontFamily: 'inherit' }}
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
      <button
        type="button"
        id={id}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => !disabled && setOpen(o => !o)}
        style={{
          width: '100%', textAlign: 'left', cursor: disabled ? 'not-allowed' : 'pointer',
          background: 'var(--theme-input-bg)', border: `1px solid ${open ? 'var(--theme-accent)' : 'var(--theme-border)'}`,
          borderRadius: 6, padding: '8px 10px', fontSize: 13,
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
