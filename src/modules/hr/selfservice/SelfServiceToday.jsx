import { CalendarCheck, CalendarClock, Coffee, ArrowLeftRight, Wallet, AlertTriangle } from 'lucide-react'

// The Home screen — the answer to "am I working, and when?", which is what an employee opens
// this app for. Everything here comes from RPCs the Roster and Pay tabs already call; there is no
// new backend behind it, and no figure on this screen is computed anywhere else.
//
// Purely presentational: every value arrives as a prop, so the whole screen is reachable in a
// test without a Supabase client. The container owns loading and errors.
//
// The governing rule is that a section renders only when it has something to SAY. A phone screen
// that lists "no swap requests / no payslips / nothing today" has spent the whole viewport
// telling someone that nothing happened.

function Section({ title, aside, children }) {
  return (
    <section className="ss-section">
      <h2 className="ss-label">
        {title}
        {aside && <span className="ss-label-aside">{aside}</span>}
      </h2>
      {children}
    </section>
  )
}

// A failed read and an empty month are different facts and must never look the same — this is the
// screen where the reader has nothing else to check the answer against.
function LoadError({ text, onRetry }) {
  return (
    <div className="card" role="alert" style={{ padding: 14, borderColor: 'color-mix(in srgb, var(--theme-red) 35%, var(--theme-border))' }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <AlertTriangle size={17} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2, color: 'var(--theme-red-text)' }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: 'var(--theme-text1)' }}>{text}</p>
          {onRetry && (
            <button className="btn btn-ghost" style={{ marginTop: 10, fontSize: 13 }} onClick={onRetry}>Try again</button>
          )}
        </div>
      </div>
    </div>
  )
}

function Quiet({ Icon, title, note }) {
  return (
    <div className="card" style={{ padding: 16, display: 'flex', gap: 12, alignItems: 'center' }}>
      <Icon size={20} aria-hidden="true" style={{ flexShrink: 0, color: 'var(--theme-text3)' }} />
      <div>
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--theme-text1)' }}>{title}</div>
        {note && <div style={{ fontSize: 12, marginTop: 2, color: 'var(--theme-text3)' }}>{note}</div>}
      </div>
    </div>
  )
}

const shiftTime = row => (row?.shift_start ? `${row.shift_start} – ${row.shift_end}` : null)

export default function SelfServiceToday({
  today, next, swapsForMe, latestPayslip,
  rosterErr, payslipsErr, onRetryRoster, onRetryPayslips,
  labelFor, onGo,
}) {
  return (
    <>
      <Section title="Today" aside={today?.cell ? labelFor(today.cell) : undefined}>
        {rosterErr ? (
          <LoadError text={rosterErr} onRetry={onRetryRoster} />
        ) : today.state === 'unknown' ? (
          <Quiet Icon={CalendarClock} title="Loading your week…" />
        ) : today.state === 'unpublished' ? (
          <Quiet
            Icon={CalendarClock}
            title="Not published yet"
            note="Your manager hasn't published this month's roster. It will appear here as soon as they do."
          />
        ) : today.state === 'not-scheduled' ? (
          <Quiet Icon={CalendarClock} title="Not scheduled today" note="You are not on the roster for today." />
        ) : today.state === 'off' ? (
          <Quiet Icon={Coffee} title="Day off" note={today.row.shift_type_name} />
        ) : (
          <div className="card" style={{ padding: 16, display: 'flex', gap: 12, alignItems: 'center' }}>
            <CalendarCheck size={20} aria-hidden="true" style={{ flexShrink: 0, color: 'var(--theme-accent-ink)' }} />
            <div>
              <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--theme-text1)' }}>{today.row.shift_type_name}</div>
              {shiftTime(today.row) && (
                <div style={{ fontSize: 13, marginTop: 2, color: 'var(--theme-text2)' }}>{shiftTime(today.row)}</div>
              )}
            </div>
          </div>
        )}
      </Section>

      {/* Only ever the next day actually WORKED — see nextShift() in todayView.js. */}
      {!rosterErr && next && (
        <Section title="Next shift">
          <button className="ss-day" onClick={() => onGo('roster')} style={{ cursor: 'pointer', font: 'inherit' }}>
            <span className="ss-day-date" style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text1)' }}>
              {labelFor(next.cell, 'short')}
            </span>
            <span style={{ flex: 1, minWidth: 0, fontSize: 14, color: 'var(--theme-text2)' }}>
              {next.row.shift_type_name}
              {shiftTime(next.row) && <span style={{ color: 'var(--theme-text3)' }}> · {shiftTime(next.row)}</span>}
            </span>
          </button>
        </Section>
      )}

      {swapsForMe.length > 0 && (
        <Section title="Needs you">
          <button
            className="card ss-attention"
            onClick={() => onGo('roster')}
            style={{ padding: 16, width: '100%', textAlign: 'left', font: 'inherit', cursor: 'pointer', display: 'flex', gap: 12, alignItems: 'center' }}
          >
            <ArrowLeftRight size={20} aria-hidden="true" style={{ flexShrink: 0, color: 'var(--theme-amber-text)' }} />
            <span>
              <span style={{ display: 'block', fontSize: 15, fontWeight: 600, color: 'var(--theme-text1)' }}>
                {swapsForMe.length} shift swap{swapsForMe.length === 1 ? '' : 's'} to answer
              </span>
              <span style={{ display: 'block', fontSize: 12, marginTop: 2, color: 'var(--theme-text2)' }}>
                {[...new Set(swapsForMe.map(s => s.requester_name).filter(Boolean))].join(', ')}
              </span>
            </span>
          </button>
        </Section>
      )}

      <Section title="Latest payslip">
        {payslipsErr ? (
          <LoadError text={payslipsErr} onRetry={onRetryPayslips} />
        ) : latestPayslip === undefined ? (
          <Quiet Icon={Wallet} title="Loading…" />
        ) : latestPayslip === null ? (
          <Quiet Icon={Wallet} title="No payslips yet" note="Your payslip appears here once payroll is finalised." />
        ) : (
          <button
            className="card"
            onClick={() => onGo('pay')}
            style={{ padding: 16, width: '100%', textAlign: 'left', font: 'inherit', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}
          >
            <span>
              <span style={{ display: 'block', fontSize: 15, fontWeight: 600, color: 'var(--theme-text1)' }}>{latestPayslip.label}</span>
              <span style={{ display: 'block', fontSize: 12, marginTop: 2, color: 'var(--theme-text3)' }}>Net pay</span>
            </span>
            <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--theme-green-text)', whiteSpace: 'nowrap' }}>
              NPR {latestPayslip.net}
            </span>
          </button>
        )}
      </Section>
    </>
  )
}
