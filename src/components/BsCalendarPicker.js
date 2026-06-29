import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { daysInBsMonth, getBsToday, bsToAd, adToBs, formatAd, BS_MONTHS } from '../utils/bsCalendar'

const DAY_LABELS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']

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
}) {
  const locked = lockYear != null && lockMonth != null
  const today  = getBsToday()

  // Resolve the currently-selected BS date from value, per mode
  const selected = locked
    ? (value ? { year: lockYear, month: lockMonth, day: parseInt(value) } : null)
    : (value ? adToBs(new Date(value + 'T00:00:00')) : null)

  const [navYear,  setNavYear]  = useState(selected?.year  || lockYear  || today.year)
  const [navMonth, setNavMonth] = useState(selected?.month || lockMonth || today.month)
  const [open,     setOpen]     = useState(false)
  const [pos,      setPos]      = useState({ top: 0, left: 0, width: 0, above: false })

  const triggerRef = useRef(null)

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
    const above      = spaceBelow < 320
    setPos({
      top:   above ? rect.top : rect.bottom + 4,
      left:  rect.left,
      width: Math.max(rect.width, 280),
      above,
    })
  }, [open])

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handler = e => { if (!triggerRef.current?.contains(e.target)) setOpen(false) }
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
      onMouseDown={e => e.stopPropagation()}
      style={{
        position:  'fixed',
        top:       pos.above ? undefined : pos.top,
        bottom:    pos.above ? window.innerHeight - pos.top : undefined,
        left:      pos.left,
        width:     pos.width,
        minWidth:  280,
        zIndex:    9999,
        background: 'var(--theme-card)',
        border:    '1px solid var(--theme-border)',
        borderRadius: 10,
        boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
        padding:   '12px 12px 8px',
      }}
    >
      {/* Month navigation (arrows hidden in locked mode) */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <button style={navBtn(!locked)} onClick={prevMonth} disabled={locked}>‹</button>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--theme-text1)' }}>
          {BS_MONTHS[navMonth - 1]} {navYear}
        </div>
        <button style={navBtn(!locked)} onClick={nextMonth} disabled={locked}>›</button>
      </div>

      {/* Day-of-week headers */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, marginBottom: 4 }}>
        {DAY_LABELS.map(d => (
          <div key={d} style={{ textAlign: 'center', fontSize: 10, fontWeight: 700, color: 'var(--theme-text3)', padding: '2px 0' }}>
            {d}
          </div>
        ))}
      </div>

      {/* Day grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2 }}>
        {cells.map((day, i) => {
          if (!day) return <div key={i} />
          const isToday = day === today.day && navMonth === today.month && navYear === today.year
          const isSel   = selected && day === selected.day && navMonth === selected.month && navYear === selected.year
          return (
            <button
              key={i}
              type="button"
              onClick={() => selectDay(day)}
              style={{
                width: '100%', aspectRatio: '1', border: 'none',
                borderRadius: 6, fontSize: 12, cursor: 'pointer',
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
        marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--theme-border)',
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
