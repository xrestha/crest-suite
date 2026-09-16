/**
 * "This period is closed" — the one banner, for the one state (S765).
 *
 * WHY. Five IMS entry screens carried this inline, and four of them were byte-identical: Purchases,
 * Sales, Stock Count and Overheads all rendered the same 9-property style object with the same
 * sentence, while Purchase Orders had drifted to its own wording ("Orders here are read-only and no
 * delivery can be received into it"). That is the shape `design-system.md` already names — an
 * identical inline style object at several sites has several chances to drift, and this one had
 * taken its first.
 *
 * The lock and the notice are the same fact, so any page that adopts the `isLocked` line owes its
 * reader this. Note Stock Count, Overheads and Requisitions still do not render it at all
 * (`closed-periods.md`); this component is what they should reach for when they do.
 *
 * `note` is for a page whose consequence genuinely differs — Purchase Orders' "no delivery can be
 * received into it" is real and worth keeping, so it rides as a second clause rather than as a
 * second banner. `canEdit` flips the same banner to the AMBER form an admin or Owner gets: they are
 * permitted to edit a closed month, so red would read as a block on an action that will succeed
 * (`closed-periods.md` — "Admin must be TOLD the month is closed").
 */
export default function ClosedPeriodBanner({ periodLabel, note, canEdit = false, style }) {
  const hue = canEdit ? 'amber' : 'red'
  return (
    <div
      role="status"
      style={{
        background: `color-mix(in srgb, var(--theme-${hue}) 8%, transparent)`,
        border: `1px solid color-mix(in srgb, var(--theme-${hue}) 25%, transparent)`,
        borderRadius: 'var(--radius-sm)',
        padding: '12px 16px',
        marginBottom: 20,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        fontSize: 13,
        color: `var(--theme-${hue}-text)`,
        ...style,
      }}
    >
      <span aria-hidden="true">{canEdit ? '✎' : '🔒'}</span>
      <span>
        <strong>{periodLabel ? `${periodLabel} is closed.` : 'This period is closed.'}</strong>{' '}
        {canEdit
          ? 'You can still edit it, and the frozen monthly report will not update on its own — regenerate the snapshot when you are done.'
          : 'Data is read-only. Contact your admin to re-open if needed.'}
        {note ? ` ${note}` : ''}
      </span>
    </div>
  )
}
