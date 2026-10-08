import { ArrowRightLeft } from 'lucide-react'
import { dayKey, rowKind } from './todayView'

// One Sunday–Saturday week of the employee's own roster.
//
// The week (rather than a whole month) is a deliberate, older decision: an employee wants "what am
// I doing this week", and a month-long list is a scroll past weeks of already-past days to reach
// today. What this component changes is the ROW.
//
// It iterates the seven calendar days, not the rows the RPC returned — get_my_roster only returns
// days that exist and are published, so rendering its result directly would answer "am I working
// on Thursday?" by silently omitting Thursday.
export default function RosterWeek({ days, roster, publishedDays, today, onRequestSwap, labelFor }) {
  // Working days only (S803): a Day Off or a leave marker is a roster row but not a day on duty
  // (staff-app.md, S692), so five shifts and two days off read "7 of 7 days scheduled".
  const scheduled = days.filter(d => { const row = roster.get(dayKey(d)); return row && rowKind(row) === 'work' }).length

  return (
    <>
      <p className="ss-label" style={{ marginBottom: 10 }}>
        This week
        <span className="ss-label-aside">{scheduled} of {days.length} days scheduled</span>
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {days.map(d => {
          const row = roster.get(dayKey(d))
          // Per day (S798): a week can be half published, and its draft days say so.
          const published = publishedDays.has(dayKey(d))
          const off = row && rowKind(row) !== 'work'
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
                    ? 'Not scheduled'   // words, as todayView says them; a bare "—" was read aloud as "dash"
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
                  colleague to trade for nothing. The word sits beside the ⇄ (S806): a bare icon told
                  a first-time user nothing, and the aria-label reached only a screen reader. */}
              {published && row && !off && (
                <button
                  className="btn btn-ghost"
                  onClick={() => onRequestSwap(d)}
                  aria-label={`Request a swap for ${labelFor(d)}`}
                  style={{ flexShrink: 0, minWidth: 44, padding: '0 10px', justifyContent: 'center' }}
                >
                  <ArrowRightLeft size={16} aria-hidden="true" /> Swap
                </button>
              )}
            </div>
          )
        })}
      </div>
    </>
  )
}
