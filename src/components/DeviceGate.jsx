import SupportContactLine from './SupportContactLine'
import './DeviceGate.css'

/**
 * The screen a PIN device shows when it cannot sign anyone in (S855): a till that was never
 * activated or whose key was refused (PosLogin), and a stock-count device that was never set up,
 * was signed out, or scanned an expired code (ImsCountLogin). It was TillGate inside PosLogin.jsx
 * (S852) and an inline-styled paragraph on the count screen; one component now, so the two front
 * doors say how to get in the same way: what is wrong, the steps in order, who can do them, and
 * Crest support for a floor that is stuck.
 *
 * @param {boolean}   alert          the whole card is announced (a key refused, a device signed out)
 * @param {string}    icon           optional emoji above the heading (decorative)
 * @param {string}    title          the h1
 * @param {node}      lead           one sentence: why this device cannot sign anyone in
 * @param {node[]}    steps          the set-up steps, in order (an ordered list)
 * @param {node}      ask            who can do it, and who cannot
 * @param {node}      notice         what went wrong on this device, in red above the lead; `children` works too
 * @param {string}    actionLabel    the one button (omit for none)
 * @param {string}    actionVariant  the button colour: 'primary' (default) or 'ghost'
 * @param {function}  onAction
 */
export default function DeviceGate({
  alert = false, icon = null, title, lead = null, steps = [], ask = null, notice = null, children = null,
  actionLabel = '', actionVariant = 'primary', onAction,
}) {
  const noticeContent = notice || children
  return (
    <main className="device-gate">
      <div className="card device-gate__card" role={alert ? 'alert' : undefined}>
        {icon && <div aria-hidden="true" className="device-gate__icon">{icon}</div>}
        <h1 className="device-gate__title">{title}</h1>
        {/* Its own alert only when the card is not one already: an alert inside an alert is read twice. */}
        {noticeContent && <p className="device-gate__notice" role={alert ? undefined : 'alert'}>{noticeContent}</p>}
        {lead && <p>{lead}</p>}
        {steps.length > 0 && <ol>{steps.map((step, i) => <li key={i}>{step}</li>)}</ol>}
        {ask && <p>{ask}</p>}
        <p className="device-gate__help">Stuck? Crest support: <SupportContactLine variant="inline" /></p>
        {actionLabel && (
          <button type="button" className={`btn btn-${actionVariant === 'ghost' ? 'ghost' : 'primary'}`} onClick={onAction}>
            {actionLabel}
          </button>
        )}
      </div>
    </main>
  )
}
