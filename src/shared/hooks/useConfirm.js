import { useState, useCallback, useRef } from 'react'
import ConfirmModal from '../../components/ConfirmModal'

/**
 * An upper bound on how long a confirm stays busy (S803). Opt-in, per page: `useConfirm({ timeoutMs:
 * CONFIRM_TIMEOUT_MS, onTimeout: () => setMsg('error:' + CONFIRM_TIMEOUT_TEXT) })`. Above the 25s
 * the HR writes give themselves, so a run that bounds its own writes reports in its own words first.
 */
export const CONFIRM_TIMEOUT_MS = 30000
export const CONFIRM_TIMEOUT_TEXT = 'Could not confirm that finished — the server took too long to answer. '
  + 'It may still have gone through, so reload the page to see what is stored before trying again.'

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
 *
 * A dialog held busy cannot be cancelled — that is the point — so a run that never answers used to
 * leave it on screen until a reload (S803, the HR audit: 18 runs, none of their writes bounded).
 * `useConfirm({ timeoutMs, onTimeout })` releases the dialog once the run has been busy that long
 * and calls `onTimeout(ask)` so the page can say what it could not confirm. The run is not
 * cancelled — a request cannot be recalled — and if it settles later its own success or error
 * message still lands, which is the truthful outcome. A single ask may override either option.
 */
export function useConfirm(options = {}) {
  const [pending, setPending] = useState(null)
  const [busy, setBusy] = useState(false)
  const optionsRef = useRef(options)
  optionsRef.current = options
  const ask = useCallback(opts => setPending(opts), [])
  const cancel = useCallback(() => setPending(null), [])

  async function run() {
    if (!pending) return
    const current = pending
    setBusy(true)
    const limit = current.timeoutMs ?? optionsRef.current.timeoutMs
    const onTimeout = current.onTimeout ?? optionsRef.current.onTimeout
    // Clear only the ask that just ran: a run() that itself asks a follow-up question (Items'
    // delete discovering hidden references and offering a force-delete) must not have that
    // second dialog wiped by the first one's cleanup.
    let timer
    try {
      const work = Promise.resolve().then(() => current.run())
      if (!limit) { await work; return }
      // Keep a late rejection from surfacing as unhandled once the dialog has already let go.
      work.catch(err => console.error('confirm run failed after its time limit:', err))
      const TIMED_OUT = {}
      const outcome = await Promise.race([work, new Promise(res => { timer = setTimeout(() => res(TIMED_OUT), limit) })])
      if (outcome === TIMED_OUT && onTimeout) onTimeout(current)
    } finally {
      clearTimeout(timer)
      setBusy(false)
      setPending(p => (p === current ? null : p))
    }
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
