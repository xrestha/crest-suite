import { useState } from 'react'
import Modal from '../../../components/Modal'
import Tip from '../../../components/Tip'
import { fmtNpr } from './posOrdersConstants'
import { dishTargetChoice, picksFromCounts, picksTakeEverything } from './tableMoves'

// Pick some of a bill's dishes (S836, owner decisions 2026-10-14). `mode` 'dishes' sends them to
// another table (its bill, or a new one there); 'part' makes them a part bill that opens straight into
// Payment, with its own invoice. Lines are the bill AS STORED (their ids are what the server moves),
// read when the dialog opened. Food already sent moves first, as the server moves it.
export default function MoveDishesModal({ mode, lines, tables, tableOrders, tableJoins, currentTableId, currentOrderId, covers, lineTotal, busy, onSubmit, onClose }) {
  const [counts, setCounts] = useState({})
  const [tableId, setTableId] = useState('')
  const [guests, setGuests] = useState(mode === 'part' ? 1 : 0)
  const [error, setError] = useState('')
  const part = mode === 'part'
  const nameOf = id => tables.find(t => t.id === id)?.name || 'another table'
  const movable = (lines || []).filter(l => !l.comped)
  const picks = picksFromCounts(movable, counts)
  const units = picks.reduce((n, p) => n + p.qty, 0)
  const pickedTotal = picks.reduce((s, p) => {
    const l = movable.find(x => x.id === p.item_id)
    return s + (l ? lineTotal(l, p.qty) : 0)
  }, 0)
  const target = tableId ? tables.find(t => t.id === tableId) : null
  const targetChoice = target ? dishTargetChoice(target, { tableOrders, tableJoins, currentTableId, currentOrderId, nameOf }) : null
  const maxGuests = Math.max(0, (Number(covers) || 1) - 1)

  const setCount = (l, n) => setCounts(c => ({ ...c, [l.id]: Math.min(Math.max(0, n), Number(l.qty) || 0) }))
  const submit = () => {
    setError('')
    if (picks.length === 0) { setError('Pick at least one dish.'); return }
    if (picksTakeEverything(movable, picks)) {
      setError(part
        ? 'That is the whole bill — close this and take payment on it instead.'
        : 'That is every dish on this bill — use Move or join to move the whole bill instead.')
      return
    }
    if (!part && !targetChoice?.ok) { setError('Pick the table the dishes go to.'); return }
    onSubmit({ picks, tableId: part ? null : tableId, covers: guests })
  }

  return (
    <Modal title={part ? 'Pay part now' : 'Move dishes to a table'} onClose={busy ? () => {} : onClose} maxWidth={560}>
      <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: '0 0 12px', lineHeight: 1.5 }}>
        {part
          ? 'Pick what this guest is paying for. Those dishes go on a bill of their own, with its own invoice number, and the payment opens straight away. The rest stays on this table.'
          : 'Pick the dishes and how many of each, then the table they go to. Food already sent moves first, and the kitchen gets a slip for anything still being made.'}
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: '40vh', overflowY: 'auto', marginBottom: 12 }}>
        {movable.map(l => {
          const n = counts[l.id] || 0
          const sent = Math.min(Number(l.sent_qty) || 0, Number(l.qty) || 0)
          return (
            <div key={l.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderBottom: '1px solid var(--theme-border)' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--theme-text1)' }}>{l.name} <span style={{ color: 'var(--theme-text3)', fontWeight: 400 }}>×{l.qty}</span></div>
                {l.option_summary && <div style={{ fontSize: 11, color: 'var(--theme-text3)' }}>{l.option_summary}</div>}
                {sent > 0 && <div style={{ fontSize: 11, color: 'var(--theme-text3)' }}>{sent === Number(l.qty) ? 'All sent to the kitchen' : `${sent} sent to the kitchen`}</div>}
              </div>
              <button type="button" className="btn btn-ghost till-hit" onClick={() => setCount(l, n - 1)} disabled={busy || n === 0} aria-label={`One fewer ${l.name}`}>−</button>
              <span style={{ minWidth: 28, textAlign: 'center', fontWeight: 700, fontSize: 15 }} aria-live="polite">{n}</span>
              <button type="button" className="btn btn-ghost till-hit" onClick={() => setCount(l, n + 1)} disabled={busy || n >= Number(l.qty)} aria-label={`One more ${l.name}`}>+</button>
            </div>
          )
        })}
      </div>

      {!part && (
        <div className="form-field" style={{ marginBottom: 12 }}>
          <label htmlFor="move-dishes-table">To table</label>
          <select id="move-dishes-table" className="form-select" value={tableId} onChange={e => setTableId(e.target.value)} disabled={busy}>
            <option value="">— Pick a table —</option>
            {tables.map(t => {
              const c = dishTargetChoice(t, { tableOrders, tableJoins, currentTableId, currentOrderId, nameOf })
              return <option key={t.id} value={t.id} disabled={!c.ok}>{t.name} — {c.label}</option>
            })}
          </select>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <Tip text={part
          ? 'Guests who pay with this part bill and leave. They come off this table’s guest count. Leave it at 0 when one guest pays for some dishes and stays.'
          : 'Guests who move with the dishes. They come off this table’s guest count and onto the other table’s. Leave it at 0 when only food moves.'}>
          <span style={{ fontSize: 13, color: 'var(--theme-text2)' }}>{part ? 'Guests paying' : 'Guests moving'}</span>
        </Tip>
        <button type="button" className="btn btn-ghost till-hit" onClick={() => setGuests(g => Math.max(0, g - 1))} disabled={busy || guests === 0} aria-label="One guest fewer">−</button>
        <span style={{ minWidth: 22, textAlign: 'center', fontWeight: 700 }}>{guests}</span>
        <button type="button" className="btn btn-ghost till-hit" onClick={() => setGuests(g => Math.min(maxGuests, g + 1))} disabled={busy || guests >= maxGuests} aria-label="One guest more">+</button>
      </div>

      {units > 0 && (
        <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: '0 0 10px' }}>
          {units} item{units === 1 ? '' : 's'} · {fmtNpr(pickedTotal)}{part ? ' before any discount' : ''}
        </p>
      )}
      {error && <p role="alert" className="field-error" style={{ margin: '0 0 10px' }}>{error}</p>}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={submit} aria-disabled={busy || units === 0} disabled={busy}>
          {busy ? 'Working…'
            : part ? 'Make part bill and take payment'
            : units > 0 ? `Move ${units} to ${target ? target.name : 'the table'}` : 'Move dishes'}
        </button>
      </div>
    </Modal>
  )
}
