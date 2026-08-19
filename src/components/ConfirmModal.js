import Modal from './Modal'

// One shared confirmation dialog for the product's consequential actions, so the sentence that
// commits a period close, a payroll finalize or a short drawer is delivered by the product's own
// Modal (Escape, focus trap, focus restore, themed, stacks under S574's rules) rather than
// window.confirm's OS chrome. Native confirm remains acceptable for routine single-row deletes;
// reach for this when the action changes other ledgers, locks a period, or moves money.
//
// Render it conditionally like any Modal. `children` is the consequence copy — prefer a short
// list of what will actually happen over "Are you sure?". While `busy`, Cancel and the backdrop
// are inert so a mid-write Escape can't strand a half-committed action.
export default function ConfirmModal({
  title,
  children,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  busy = false,
  busyLabel = 'Working…',
  onConfirm,
  onCancel,
}) {
  return (
    <Modal title={title} onClose={busy ? () => {} : onCancel} maxWidth={480}>
      <div style={{ fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.6 }}>{children}</div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
        <button className="btn" onClick={onCancel} disabled={busy}>{cancelLabel}</button>
        <button className={danger ? 'btn btn-danger' : 'btn btn-primary'} onClick={onConfirm} disabled={busy}>
          {busy ? busyLabel : confirmLabel}
        </button>
      </div>
    </Modal>
  )
}
