import { useState } from 'react'
import Modal from '../../../components/Modal'
import ActionError from '../../../components/ActionError'
import { nepalTime } from '../../../shared/nepalTime'
import { addCounts, allChosen, conflictSentence, fmtQty } from './countConflict'

// D37 (S792 stage 4): "Ram already counted 12 kg at 10:42 — replace, or add yours?"
//
// One item gives three buttons that act at once. Several (a Save All, or figures replayed from the
// offline queue) give one choice per item and a single Save, so nobody has to answer a stack of
// dialogs. "Keep theirs" leaves the stored count as it is and shows it on screen; for a figure
// counted offline it also takes that figure off this device.
//
// rows: [{ itemId, name, uom, mine, other: {physical_qty, counted_by_name, counted_at, count_parts}, op? }]
export default function CountConflictModal({ rows, busy, error, onResolve, onClose }) {
  const [choices, setChoices] = useState({})
  const single = rows.length === 1
  const withChoices = rows.map(r => ({ ...r, choice: choices[r.itemId] || null }))
  const replayed = rows.some(r => r.op)

  const choose = (itemId, choice) => setChoices(prev => ({ ...prev, [itemId]: choice }))
  const chooseAll = choice => setChoices(Object.fromEntries(rows.map(r => [r.itemId, choice])))

  const choiceButtons = (r, act) => {
    const total = addCounts(r.other.physical_qty, r.mine)
    const unit = r.uom ? ` ${r.uom}` : ''
    const opts = [
      { id: 'add', label: `Add yours (= ${fmtQty(total)}${unit})`, cls: 'btn-primary' },
      { id: 'replace', label: `Replace with ${fmtQty(r.mine)}${unit}`, cls: 'btn-ghost' },
      { id: 'keep', label: r.op ? `Keep ${fmtQty(r.other.physical_qty)}, discard yours` : `Keep ${fmtQty(r.other.physical_qty)}`, cls: 'btn-ghost' },
    ]
    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }} role={act ? undefined : 'group'} aria-label={act ? undefined : `Choice for ${r.name}`}>
        {opts.map(o => {
          const picked = !act && choices[r.itemId] === o.id
          return (
            <button key={o.id} type="button" disabled={busy}
              className={`btn btn-sm ${act ? o.cls : (picked ? 'btn-primary' : 'btn-ghost')}`}
              aria-pressed={act ? undefined : picked}
              onClick={() => (act ? onResolve([{ ...r, choice: o.id }]) : choose(r.itemId, o.id))}>
              {o.label}
            </button>
          )
        })}
      </div>
    )
  }

  const describe = r => (
    <>
      <div style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{r.name}</div>
      <div>
        {conflictSentence(r.other, r.uom, r.other.counted_at ? nepalTime(r.other.counted_at) : null)}{' '}
        {r.op ? `${r.op.countedBy?.counted_by_name || 'This device'} counted ${fmtQty(r.mine)}${r.uom ? ` ${r.uom}` : ''} offline.` : `You counted ${fmtQty(r.mine)}${r.uom ? ` ${r.uom}` : ''}.`}
      </div>
    </>
  )

  return (
    <Modal title={single ? 'Already counted' : `${rows.length} items already counted`} onClose={busy ? () => {} : onClose} maxWidth={560}>
      <div style={{ fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.6 }}>
        <p style={{ marginTop: 0 }}>
          {single ? 'Someone else counted this item first. ' : 'Someone else counted these items first. '}
          If you counted a different place (the store room and the kitchen, say), <strong>add yours</strong>.
          If you counted the same stock again, <strong>replace</strong> it.
          {replayed ? ' These figures were counted on this device while it was offline.' : ''}
        </p>
        {single ? (
          <>
            {describe(rows[0])}
            {choiceButtons(rows[0], true)}
          </>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => chooseAll('add')}>Add all</button>
              <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => chooseAll('replace')}>Replace all</button>
            </div>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, maxHeight: '50vh', overflowY: 'auto' }}>
              {rows.map(r => (
                <li key={`${r.periodId}:${r.itemId}`} style={{ padding: '10px 0', borderTop: '1px solid var(--theme-border)' }}>
                  {describe(r)}
                  {choiceButtons(r, false)}
                </li>
              ))}
            </ul>
          </>
        )}
        <ActionError error={error} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
        <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
          {replayed ? 'Decide later' : 'Cancel'}
        </button>
        {!single && (
          <button type="button" className="btn btn-primary" disabled={busy || !allChosen(withChoices)}
            onClick={() => onResolve(withChoices)}>
            {busy ? 'Saving…' : 'Save choices'}
          </button>
        )}
      </div>
    </Modal>
  )
}
