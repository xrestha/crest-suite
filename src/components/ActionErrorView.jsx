/**
 * `<ActionError>`'s renderer on its own, without the error table (S876, PERF-8). ActionError.jsx
 * re-exports this as its default, so every page keeps importing ActionError as before; only a screen
 * on the main file (TillOutletGate, LegalReacceptance) imports it from here, because ActionError.jsx
 * also carries `asActionError`, and with it all of errorText.js. Those screens convert through
 * `errorInfoLater` in shared/lazyErrorText.js instead. The contract is ActionError.jsx's.
 *
 * `role="alert"` so the failure is announced at the moment it appears — a user who pressed Save
 * and heard nothing has been told the save succeeded.
 */
export default function ActionError({ error, className = '' }) {
  if (!error) return null
  const { text, detail } = typeof error === 'string' ? { text: error, detail: '' } : error
  if (!text) return null
  return (
    <div className={`action-error ${className}`.trim()} role="alert">
      <p className="action-error-text">{text}</p>
      {detail && <p className="action-error-detail">{detail}</p>}
    </div>
  )
}
