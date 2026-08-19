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
          {ticket.table_name || 'Takeaway'} <span style={{ opacity: 0.7 }}>#{ticket.order_no}</span>
        </div>
        <div style={{ fontSize: 13, color: 'var(--theme-text2)', marginBottom: 8 }}>
          {(ticket.items || []).map(i => `${i.qty}× ${i.name}`).join(', ')}
        </div>

        <div style={{ fontSize: 34, fontWeight: 700, color: value ? 'var(--theme-text1)' : 'var(--theme-text3)', marginBottom: 10, fontVariantNumeric: 'tabular-nums' }}>
          {value || '0'} <span style={{ fontSize: 14, fontWeight: 400, color: 'var(--theme-text3)' }}>min</span>
        </div>

        <div style={{ display: 'flex', gap: 9, justifyContent: 'center', marginBottom: 10 }}>
          {PRESETS.map(p => (
            <button
              key={p}
              className="btn btn-ghost"
              style={{ fontSize: 14, padding: '7px 16px', borderColor: minutes === p ? 'var(--theme-accent)' : undefined, color: minutes === p ? 'var(--theme-accent-ink)' : undefined }}
              onClick={() => setValue(String(p))}
            >
              {p}m
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
                width: 58, height: 58, borderRadius: '50%',
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
