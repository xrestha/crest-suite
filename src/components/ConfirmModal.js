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
//
// The Confirm button is NOT disabled while busy (S852). Disabling the button a keyboard user just
// pressed drops focus to <body> for as long as the write takes (up to CONFIRM_TIMEOUT_MS, 30s), and
// the next Tab then leaves the dialog. It stays focusable and wears `aria-busy` + `aria-disabled`
// (the `.btn[aria-busy]` treatment), a second press does nothing, and a polite status line says the
// busy label out loud, since a label change on a focused button is not announced.
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
  // Passed straight through to Modal. A confirm raised from inside another raised dialog — POS's
  // shift-close sheet sits at 1100 — has to clear it, or the confirm renders underneath the thing
  // it is confirming. Modal nests correctly (only the top of its stack answers Escape/Tab); this
  // is purely about paint order, which CSS decides separately.
  zIndex,
}) {
  return (
    <Modal title={title} onClose={busy ? () => {} : onCancel} maxWidth={480} zIndex={zIndex}>
      <div style={{ fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.6 }}>{children}</div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
        <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>{cancelLabel}</button>
        <button
          type="button"
          className={danger ? 'btn btn-danger' : 'btn btn-primary'}
          onClick={busy ? undefined : onConfirm}
          aria-busy={busy || undefined}
          aria-disabled={busy || undefined}
        >
          {busy ? busyLabel : confirmLabel}
        </button>
      </div>
      <span className="sr-only" role="status">{busy ? `${busyLabel} Please wait.` : ''}</span>
    </Modal>
  )
}
