import { useState, useEffect } from 'react'
import { daysInBsMonth, getBsToday, bsToAd, adToBs, formatAd, BS_MONTHS } from '../utils/bsCalendar'

/**
 * BS day picker for a fixed BS year/month (typically the selected period).
 * Shows the correct number of days for that month, a "Today" shortcut
 * when the period is the current BS month, and the AD-equivalent date
 * for the selected day.
 */
export default function BsDatePicker({ bsYear, bsMonth, value, onChange, disabled }) {
  const dayCount = daysInBsMonth(bsYear, bsMonth)
  const days = Array.from({ length: dayCount }, (_, i) => i + 1)
  const today = getBsToday()
  const isCurrentMonth = today.year === bsYear && today.month === bsMonth
  const adDate = value ? bsToAd(bsYear, bsMonth, parseInt(value)) : null

  return (
    <div>
      <div style={{ display: 'flex', gap: 6 }}>
        <select
          value={value}
          onChange={e => onChange(e.target.value)}
          disabled={disabled}
          style={{ flex: 1 }}
        >
          <option value="">— Day —</option>
          {days.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
        {isCurrentMonth && (
          <button
            type="button"
            className="btn btn-ghost"
            style={{ fontSize: 11, padding: '6px 8px', whiteSpace: 'nowrap' }}
            disabled={disabled}
            onClick={() => onChange(String(today.day))}
          >
            Today
          </button>
        )}
      </div>
      {adDate && (
        <span style={{ fontSize: 11, color: '#6b7280', marginTop: 4, display: 'block' }}>
          ≈ {formatAd(adDate)} (AD)
        </span>
      )}
    </div>
  )
}

/**
 * Full BS date picker — year + month + day selectors.
 * value: ISO string (AD) or '' | onChange: called with ISO string when complete.
 */
export function BsFullDatePicker({ value, onChange }) {
  const today = getBsToday()
  const init  = value ? adToBs(new Date(value)) : null

  const [bsYear,  setBsYear]  = useState(init?.year  || today.year)
  const [bsMonth, setBsMonth] = useState(init?.month || today.month)
  const [bsDay,   setBsDay]   = useState(init?.day   || '')

  const years    = Array.from({ length: 12 }, (_, i) => today.year - 1 + i)
  const dayCount = daysInBsMonth(bsYear, bsMonth)

  useEffect(() => {
    if (bsDay && parseInt(bsDay) > dayCount) setBsDay(String(dayCount))
  }, [bsMonth, bsYear]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (bsYear && bsMonth && bsDay) {
      onChange(bsToAd(bsYear, bsMonth, parseInt(bsDay)).toISOString())
    }
  }, [bsYear, bsMonth, bsDay]) // eslint-disable-line react-hooks/exhaustive-deps

  const adDate = bsDay ? bsToAd(bsYear, bsMonth, parseInt(bsDay)) : null

  const sel = {
    background: '#0f1117', border: '1px solid #2a2f3d',
    borderRadius: 6, color: '#e8e0d0', padding: '6px 8px',
    fontSize: 13, cursor: 'pointer', fontFamily: 'inherit'
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 8 }}>
        <select value={bsYear} onChange={e => setBsYear(parseInt(e.target.value))} style={{ ...sel, flex: '0 0 80px' }}>
          {years.map(y => <option key={y} value={y}>{y}</option>)}
        </select>
        <select value={bsMonth} onChange={e => setBsMonth(parseInt(e.target.value))} style={{ ...sel, flex: 1 }}>
          {BS_MONTHS.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
        </select>
        <select value={bsDay} onChange={e => setBsDay(e.target.value)} style={{ ...sel, flex: '0 0 70px' }}>
          <option value="">Day</option>
          {Array.from({ length: dayCount }, (_, i) => i + 1).map(d => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>
      </div>
      {adDate && (
        <span style={{ fontSize: 11, color: '#6b7280', marginTop: 5, display: 'block' }}>
          ≈ {formatAd(adDate)} AD
        </span>
      )}
    </div>
  )
}
