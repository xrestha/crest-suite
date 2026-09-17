// The decision controls HR's approval queues share (S768) — Leave, Overtime, TADA Claims and Shift
// Swaps.
//
// Four queues had four Approve/Reject designs: green and red text on 11px ghost buttons (Leave),
// the same with different padding (Overtime), ✓/✕ glyphs (TADA), and a filled accent primary beside
// a ghost (Swaps). A manager clears all four in one sitting, so the same decision looked different
// on every page — and green/red on a BUTTON spent the verdict colours on an action that has not
// happened yet. Both buttons are the same neutral small ghost now; the label is the difference, and
// each carries the person's name so a screen reader moving down a column hears whose it is.
//
// None of the queues had a batch path either, so the end of a month was one click per row. The bar
// approves every pending row on screen after a confirm that states the total, runs the page's own
// single-row approval for each (so every guard that row would meet still applies), and reports what
// did not go through by name rather than failing the batch on the first refusal.

export function DecisionButtons({ who, onApprove, onReject, disabled, stopPropagation = false }) {
  const wrap = fn => e => { if (stopPropagation) e.stopPropagation(); fn() }
  return (
    <>
      <button type="button" className="btn btn-ghost btn-sm" disabled={disabled} onClick={wrap(onApprove)} aria-label={`Approve — ${who}`}>Approve</button>
      <button type="button" className="btn btn-ghost btn-sm" disabled={disabled} onClick={wrap(onReject)} aria-label={`Reject — ${who}`}>Reject</button>
    </>
  )
}

// Shown only when there are at least two pending rows: a batch of one is a row button.
export function BulkApproveBar({ count, noun, detail, onApprove, disabled }) {
  if (!count || count < 2) return null
  return (
    <div className="bulk-approve no-print">
      <span className="bulk-approve__text">
        <strong>{count}</strong> {noun} waiting{detail ? <> · {detail}</> : null}
      </span>
      <button type="button" className="btn btn-ghost btn-sm" onClick={onApprove} disabled={disabled}>
        Approve all {count}…
      </button>
    </div>
  )
}

/**
 * Run a single-row decision for each item, one after another, and collect the outcome. `decide(item)`
 * resolves to `true` when that row went through, or to a sentence saying why it did not. Sequential on
 * purpose: several of these write attendance or re-read a row's status first, and a batch racing its
 * own rows is how two approvals of one leave both mark the same days.
 */
export async function decideEach(items, decide) {
  const done = []
  const failed = []
  for (const item of items) {
    let outcome
    try { outcome = await decide(item) } catch (e) { outcome = e?.message || 'it could not be saved' }
    if (outcome === true) done.push(item)
    else failed.push({ item, reason: outcome || 'it was not saved' })
  }
  return { done, failed }
}
