import { useState } from 'react'
import Modal from '../../../components/Modal'

const CONFIRM_WORD = 'DELETE'

// Typed confirmation before a save silently wipes the opposite entry mode's rows (S457).
//
// Deliberately a typing gate rather than a plain OK/Cancel: this deletes an unbounded number of
// rows the user cannot see from the screen they're on (a Bulk save wipes that item's entire month
// of daily entries), it is irreversible, and sales_entries has no audit trail to recover from.
// A one-click confirm gets muscle-memoried away; retyping the word forces the count to be read.
export default function SupersedeConfirmModal({ mode, superseded, recipeNames, onCancel, onConfirm }) {
  const [typed, setTyped] = useState('')
  const armed = typed.trim().toUpperCase() === CONFIRM_WORD

  const isBulk = mode === 'bulk'
  const what = isBulk ? 'daily entries' : 'period-total (Bulk) entries'
  const because = isBulk
    ? 'Saving a Bulk period total for an item replaces every Daily entry that item has in this period — otherwise reports would count the same sales twice.'
    : 'Saving a Daily entry for an item replaces the Bulk period total that item has — otherwise reports would count the same sales twice.'

  return (
    <Modal onClose={onCancel} title={`Delete ${superseded.total} ${what}?`} maxWidth={620}>
      <div style={{
        background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.25)',
        borderRadius: 8, padding: '12px 14px', marginBottom: 16, fontSize: 13, color: 'var(--theme-red)',
      }}>
        This cannot be undone. Deleted sales entries are not recoverable.
      </div>

      <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.6 }}>{because}</p>

      <div className="table-wrap" style={{ maxHeight: 260, overflowY: 'auto', marginBottom: 16 }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>Menu Item</th>
              <th style={{ textAlign: 'right' }}>Entries</th>
              <th style={{ textAlign: 'right' }}>Total Qty</th>
              {isBulk && <th style={{ textAlign: 'right' }}>Days</th>}
            </tr>
          </thead>
          <tbody>
            {superseded.byRecipe.map(e => (
              <tr key={e.recipeId}>
                <td style={{ fontWeight: 600 }}>{recipeNames[e.recipeId] || 'Unknown item'}</td>
                <td style={{ textAlign: 'right', color: 'var(--theme-red)', fontWeight: 600 }}>{e.count}</td>
                <td style={{ textAlign: 'right' }}>{e.qty.toLocaleString()}</td>
                {isBulk && (
                  <td style={{ textAlign: 'right', fontSize: 12, color: 'var(--theme-text3)' }}>
                    {e.days.join(', ')}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="form-field" style={{ marginBottom: 16 }}>
        <label>
          Type <strong style={{ color: 'var(--theme-text1)', letterSpacing: 0.5 }}>{CONFIRM_WORD}</strong> to confirm
        </label>
        <input
          type="text"
          value={typed}
          onChange={e => setTyped(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && armed) onConfirm() }}
          placeholder={CONFIRM_WORD}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          style={{ letterSpacing: 1 }}
        />
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
        <button
          className="btn"
          onClick={onConfirm}
          disabled={!armed}
          style={{
            color: armed ? 'var(--theme-red)' : 'var(--theme-text3)',
            borderColor: armed ? 'rgba(248,113,113,0.5)' : 'var(--theme-border)',
            background: armed ? 'rgba(248,113,113,0.10)' : 'transparent',
          }}
        >Delete {superseded.total} & Save</button>
      </div>
    </Modal>
  )
}
