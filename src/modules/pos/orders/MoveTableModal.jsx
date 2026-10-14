import { useState } from 'react'
import Modal from '../../../components/Modal'
import Tip from '../../../components/Tip'
import { FilterChips } from '../../../components/Tabs'
import { tableMoveChoice } from './tableMoves'

// Move this bill to another table, or bring another table onto it (S836, owner decisions 2026-10-14).
// Two modes, so every tile has ONE action: Move takes the bill to a free table (a table with its own
// bill offers the join instead); Join adds a table to this bill — a free one as extra seats, or one
// with a bill, whose dishes, guests and kitchen tickets then come onto this one. Both tables stay
// taken until the bill is paid. Which tables can take which action is tableMoveChoice's, so the
// tiles and the till's own refusal agree.
export default function MoveTableModal({ tables, tableOrders, tableJoins, currentTableId, currentOrderId, busy, onMove, onJoin, onClose }) {
  const [mode, setMode] = useState('move')
  const sections = [...new Set(tables.map(t => t.section || ''))]
  const nameOf = id => tables.find(t => t.id === id)?.name || 'another table'

  return (
    <Modal title="Move or join a table" onClose={busy ? () => {} : onClose} maxWidth={620}>
      <FilterChips
        label="What to do"
        options={[
          { key: 'move', label: 'Move this bill' },
          { key: 'join', label: 'Join a table to this bill' },
        ]}
        active={mode}
        onChange={setMode}
      />
      <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: '10px 0 14px', lineHeight: 1.5 }}>
        {mode === 'move'
          ? 'Pick a free table. The bill, its dishes, guests and booking go with it, and this table becomes free. The kitchen gets a move slip for food still being made.'
          : 'Pick a table to put on this bill. A free table becomes extra seats; a table with its own bill brings its dishes and guests onto this one. Both stay taken until the bill is paid.'}
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxHeight: '55vh', overflowY: 'auto' }}>
        {sections.map(section => (
          <div key={section || 'none'}>
            {sections.length > 1 && (
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 }}>
                {section || 'No section'}
              </div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(132px, 1fr))', gap: 8 }}>
              {tables.filter(t => (t.section || '') === section).map(t => {
                const choice = tableMoveChoice(t, { mode, tableOrders, tableJoins, currentTableId, currentOrderId, nameOf })
                const act = () => {
                  if (busy || !choice.action) return
                  if (choice.action === 'move') onMove(t)
                  else onJoin(t, { hasBill: choice.hasBill })
                }
                const tile = (
                  <button
                    type="button"
                    className="btn btn-ghost till-hit--row"
                    onClick={act}
                    aria-disabled={!choice.action || busy}
                    style={{
                      display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2,
                      padding: '10px 12px', textAlign: 'left', width: '100%',
                      ...(choice.action ? {} : { borderStyle: 'dashed', cursor: 'default', color: 'var(--theme-text3)' }),
                    }}
                  >
                    <span style={{ fontWeight: 700, fontSize: 14, color: choice.action ? 'var(--theme-text1)' : 'var(--theme-text3)' }}>{t.name}</span>
                    <span style={{ fontSize: 11 }}>{choice.label}</span>
                  </button>
                )
                return choice.hint
                  ? <Tip key={t.id} text={choice.hint}>{tile}</Tip>
                  : <div key={t.id}>{tile}</div>
              })}
            </div>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
        <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>{busy ? 'Working…' : 'Cancel'}</button>
      </div>
    </Modal>
  )
}
