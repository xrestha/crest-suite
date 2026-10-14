import { stationWord } from './printQueue'
import './StationPrintAlerts.css'

// The till's "hasn't printed" banner (S837). One row per queued kitchen or bar slip that its print
// device has not put on paper in time, with Print here (this till's print window, after the claim
// says no device has it) and Dismiss. It sits above the order screen (z 1000) and under every till
// dialog (1100+), never traps focus, and is rendered in all three of PosOrders' returns.
export default function StationPrintAlerts({ alerts, notice, busyId, onPrintHere, onDismiss }) {
  if (!alerts.length && !notice) return null
  return (
    <div className="station-print-alerts no-print">
      {alerts.map(a => (
        <div key={a.job.id} className="station-print-alert" role="alert">
          <div className="station-print-alert__text">
            <strong>{stationWord(a.job.station)} {a.job.kind === 'void' ? 'VOID slip' : a.job.kind === 'move' ? 'move slip' : 'ticket'}{a.job.label ? ` · ${a.job.label}` : ''}</strong>
            {' '}has not printed. <span className="station-print-alert__why">{a.reason}</span>
          </div>
          <div className="station-print-alert__actions">
            <button type="button" className="btn btn-primary btn-sm" disabled={busyId != null} onClick={() => onPrintHere(a.job.id)}>
              {busyId === a.job.id ? 'Checking…' : 'Print here'}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={busyId === a.job.id} onClick={() => onDismiss(a.job.id)}
              aria-label={`Dismiss — the ${stationWord(a.job.station).toLowerCase()} has this ticket`}>
              Dismiss
            </button>
          </div>
        </div>
      ))}
      {notice && <div className="station-print-alert station-print-alert--note" role="status">{notice}</div>}
    </div>
  )
}
