import { useState, useCallback } from 'react'
import ConfirmModal from '../../components/ConfirmModal'

/**
 * The consequence dialog, as one line per page instead of three pieces of state.
 *
 * WHY (S682). `ConfirmModal` existed since S575 and was adopted by exactly the pages that had been
 * named in a critique — Periods, PayrollRun, Roster, AttendanceSheet, FinalSettlement — while 24
 * more `window.confirm()`s stood in HR alone, several of them on irreversible ledger rows (a loan,
 * an OT entry that is pay, a holiday that drives the 2× rate, a shift type whose deletion blanks
 * every roster cell using it). Each adopter had hand-rolled the same `pendingConfirm` state, the
 * same `busy` flag and the same `run()` wrapper. That boilerplate was the adoption tax, and this
 * pays it once.
 *
 *   const { ask: askConfirm, confirmEl } = useConfirm()
 *   ...
 *   askConfirm({
 *     title: 'Delete this advance?',
 *     body: <p style={{ margin: 0 }}>NPR 20,000 issued 3rd Bhadra is removed from the ledger. This cannot be undone.</p>,
 *     confirmLabel: 'Delete', danger: true,
 *     run: async () => { const { error } = await scopedDelete(...); if (error) setError(...) },
 *   })
 *   ...
 *   {confirmEl}   // once, at the end of the page's root
 *
 * `body` is the consequence copy — what will actually happen — never "Are you sure?". `run` is
 * awaited with the dialog held open in its busy state, so a mid-write Escape cannot strand a
 * half-committed action; it is the run's job to surface its own error (the dialog closes either
 * way, because the page's ActionError is where the failure belongs). `zIndex` passes through for
 * a confirm raised from inside a fixed layer above 100.
 */
export function useConfirm() {
  const [pending, setPending] = useState(null)
  const [busy, setBusy] = useState(false)
  const ask = useCallback(opts => setPending(opts), [])
  const cancel = useCallback(() => setPending(null), [])

  async function run() {
    if (!pending) return
    const current = pending
    setBusy(true)
    // Clear only the ask that just ran: a run() that itself asks a follow-up question (Items'
    // delete discovering hidden references and offering a force-delete) must not have that
    // second dialog wiped by the first one's cleanup.
    try { await current.run() } finally { setBusy(false); setPending(p => (p === current ? null : p)) }
  }

  const confirmEl = pending ? (
    <ConfirmModal
      title={pending.title}
      confirmLabel={pending.confirmLabel}
      cancelLabel={pending.cancelLabel}
      danger={!!pending.danger}
      busy={busy}
      busyLabel={pending.busyLabel}
      zIndex={pending.zIndex}
      onConfirm={run}
      onCancel={cancel}
    >
      {pending.body}
    </ConfirmModal>
  ) : null

  return { ask, confirmEl }
}
