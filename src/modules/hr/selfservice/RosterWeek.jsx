import { ArrowLeftRight } from 'lucide-react'
import { isOffDay } from '../payrollConstants'
import { dayKey } from './todayView'

// One Sunday–Saturday week of the employee's own roster.
//
// The week (rather than a whole month) is a deliberate, older decision: an employee wants "what am
// I doing this week", and a month-long list is a scroll past weeks of already-past days to reach
// today. What this component changes is the ROW.
//
// It iterates the seven calendar days, not the rows the RPC returned — get_my_roster only returns
// days that exist and are published, so rendering its result directly would answer "am I working
// on Thursday?" by silently omitting Thursday.
export default function RosterWeek({ days, roster, publishMap, today, onRequestSwap, labelFor }) {
  const scheduled = days.filter(d => roster.get(dayKey(d))).length

  return (
    <>
      <p className="ss-label" style={{ marginBottom: 10 }}>
        This week
        <span className="ss-label-aside">{scheduled} of {days.length} days scheduled</span>
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {days.map(d => {
          const row = roster.get(dayKey(d))
          const published = publishMap.get(`${d.bsYear}-${d.bsMonth}`)
          const off = row && isOffDay(row.shift_type_name)
          const isToday = d.bsYear === today.year && d.bsMonth === today.month && d.bsDay === today.day
          const cls = ['ss-day', !row && 'ss-day--blank', off && 'ss-day--off', isToday && 'ss-day--today']
            .filter(Boolean).join(' ')

          return (
            <div key={dayKey(d)} className={cls}>
              <span
                className="ss-day-date"
                style={{ fontSize: 13, fontWeight: row ? 700 : 500, color: row ? 'var(--theme-text1)' : 'var(--theme-text3)' }}
              >
                {labelFor(d, 'short')}
              </span>

              <span style={{ flex: 1, minWidth: 0, fontSize: 14, color: row ? 'var(--theme-text2)' : 'var(--theme-text3)' }}>
                {!published
                  ? 'Not published yet'
                  : !row
                    ? '—'
                    : (
                      <>
                        {row.shift_type_name}
                        {/* Its own line: a long shift name plus a time range wraps mid-string at
                            390px otherwise, and every row breaks in a different place. */}
                        {row.shift_start && (
                          <span style={{ display: 'block', fontSize: 12, color: 'var(--theme-text3)' }}>
                            {row.shift_start} – {row.shift_end}
                          </span>
                        )}
                      </>
                    )}
              </span>

              {isToday && <span className="badge-gray" style={{ flexShrink: 0 }}>Today</span>}

              {/* Only on a day this employee actually works. It used to render on every published
                  row at the same weight as the shift itself — including days off, where it asks a
                  colleague to trade for nothing. */}
              {published && row && !off && (
                <button
                  className="btn btn-ghost"
                  onClick={() => onRequestSwap(d)}
                  aria-label={`Request a swap for ${labelFor(d)}`}
                  style={{ flexShrink: 0, width: 44, minWidth: 44, padding: 0, justifyContent: 'center' }}
                >
                  <ArrowLeftRight size={16} aria-hidden="true" />
                </button>
              )}
            </div>
          )
        })}
      </div>
    </>
  )
}
