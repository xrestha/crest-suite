import { useState, useCallback, useEffect } from 'react'
import Modal from '../../../components/Modal'

const KEYS = [['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9'], ['C', '0', '⌫']]
const PRESETS = [5, 10, 15, 20]
const MAX_LEN = 3 // up to 999 minutes — comfortably above any real kitchen prep time

// Calculator-style popup shown when kitchen/bar staff tap "Start" on a KOT/BOT ticket — required
// before the ticket can move to In Progress, so every started ticket has an estimate to show
// front-of-house (PosOrders.jsx table badge) and to compare against actual prep time later
// (KotLog.jsx Register tab). Digit-grid pattern adapted from the PIN pad in PosLogin.jsx, but
// unmasked since this is a plain minutes value, not a PIN.
export default function EstimateTimeModal({ ticket, onConfirm, onClose }) {
  const [value, setValue] = useState('')

  const pressKey = useCallback((k) => {
    if (k === '⌫') { setValue(v => v.slice(0, -1)); return }
    if (k === 'C') { setValue(''); return }
    if (!k) return
    setValue(v => (v === '0' ? k : v.length < MAX_LEN ? v + k : v))
  }, [])

  const minutes = parseInt(value, 10) || 0
  const canConfirm = minutes > 0

  useEffect(() => {
    function onKey(e) {
      if (e.key >= '0' && e.key <= '9') pressKey(e.key)
      else if (e.key === 'Backspace') pressKey('⌫')
      else if (e.key === 'Escape') onClose()
      else if (e.key === 'Enter' && canConfirm) onConfirm(minutes)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pressKey, canConfirm, minutes, onConfirm, onClose])

  return (
    <Modal onClose={onClose} title="Estimated Prep Time" maxWidth={360}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 13, color: 'var(--theme-text3)', marginBottom: 2 }}>
          {ticket.table_name || 'Takeaway'} <span style={{ color: 'var(--theme-text3)' }}>#{ticket.order_no}</span>
        </div>
        {/* One line per item so a kitchen note can sit under the dish it belongs to (S754) — the cook
            estimates prep time for "no onion, extra spicy", not just the dish name. Tickets
            written before notes were carried onto pos_kot_log.items have no key and show none. */}
        <div style={{ fontSize: 13, color: 'var(--theme-text2)', marginBottom: 8 }}>
          {(ticket.items || []).map((i, idx) => {
            const note = typeof i?.notes === 'string' ? i.notes.trim() : ''
            // S809 3d (FLOOR-KITCHEN-2): the estimate is for what is left to make. A dish taken off the
            // order since the ticket was sent is struck through (the board's own `removals`), a reduced
            // one shows its new count, and each dish shows its choices as the card does.
            const removed = (ticket.removals?.[idx] || []).reduce((n, e) => n + (Number(e.qty) || 0), 0)
            const left = Math.max(0, (Number(i.qty) || 0) - removed)
            return (
              <div key={idx}>
                {removed > 0 && left === 0
                  ? <span><s style={{ color: 'var(--theme-text3)' }}>{i.qty}× {i.name}</s> <span style={{ color: 'var(--theme-red-text)' }}>cancelled</span></span>
                  : removed > 0
                    ? <span><s style={{ color: 'var(--theme-text3)' }}>{i.qty}</s> → {left}× {i.name}</span>
                    : <span>{i.qty}× {i.name}</span>}
                {left > 0 && (i.options || []).map((o, n) => (
                  <div key={n} style={{ fontSize: 13, color: o.is_removal ? 'var(--theme-red-text)' : 'var(--theme-text1)', fontWeight: o.is_removal ? 700 : 400 }}>
                    {o.is_removal ? `NO ${String(o.kitchen || '').replace(/^no\s+/i, '')}` : `+ ${o.kitchen}`}
                  </div>
                ))}
                {left > 0 && note && <div style={{ fontSize: 13, color: 'var(--theme-text1)' }}>↳ {note}</div>}
              </div>
            )
          })}
        </div>

        <div style={{ fontSize: 32, fontWeight: 700, color: value ? 'var(--theme-text1)' : 'var(--theme-text3)', marginBottom: 10, fontVariantNumeric: 'tabular-nums' }}>
          {value || '0'} <span style={{ fontSize: 14, fontWeight: 400, color: 'var(--theme-text3)' }}>min</span>
        </div>

        <div style={{ display: 'flex', gap: 9, justifyContent: 'center', marginBottom: 10 }}>
          {PRESETS.map(p => (
            <button
              key={p}
              className="btn btn-ghost"
              style={{ fontSize: 14, padding: '7px 16px', borderColor: minutes === p ? 'var(--theme-accent)' : undefined, color: minutes === p ? 'var(--theme-accent-ink)' : undefined }}
              // A preset IS the answer (S776): tapping one starts the ticket. Start used to be three taps —
              // Start, a preset, then Confirm & Start — with a cook's hands full. Typed minutes still confirm.
              onClick={() => onConfirm(p)}
            >
              Start · {p}m
            </button>
          ))}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 58px)', gap: 8, justifyContent: 'center', margin: '0 auto 10px' }}>
          {KEYS.flat().map((k, i) => (
            <button
              key={i}
              onClick={() => pressKey(k)}
              disabled={!k}
              style={{
                width: 58, height: 58, borderRadius: 0,
                background: k ? 'var(--theme-card)' : 'transparent',
                border: k ? '1px solid var(--theme-border)' : 'none',
                color: k === 'C' ? 'var(--theme-text3)' : 'var(--theme-text1)',
                fontSize: k === '⌫' || k === 'C' ? 14 : 18,
                fontWeight: 600,
                cursor: k ? 'pointer' : 'default',
              }}
            >
              {k}
            </button>
          ))}
        </div>

        <button
          className="btn btn-primary"
          style={{ width: '100%', padding: '10px', fontSize: 15 }}
          disabled={!canConfirm}
          onClick={() => onConfirm(minutes)}
        >
          Confirm &amp; Start{minutes ? ` (${minutes} min)` : ''}
        </button>
      </div>
    </Modal>
  )
}
