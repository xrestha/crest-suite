import { useState } from 'react'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import Modal from '../../../components/Modal'
import Fab from '../../../components/Fab'
import { getCf } from './purchasesHelpers'

const EMPTY_RETURN = { purchase_entry_id: '', qty: '', notes: '' }

// Vendor Returns tab — record + list returns against an existing purchase entry. Rate, vendor,
// and payment method are always inherited from the linked purchase (a return can't have its own).
export default function ReturnsTab({ period, purchases, returns, isLocked, effectiveClientId, onChanged }) {
  const { scopedUpdate, scopedInsert, scopedDelete } = useScopedDb()
  const [showReturnForm, setShowReturnForm] = useState(false)
  const [returnForm, setReturnForm]         = useState(EMPTY_RETURN)
  const [returnSaving, setReturnSaving]     = useState(false)
  const [returnError, setReturnError]       = useState('')
  const [editingReturnId, setEditingReturnId] = useState(null)

  function openNewReturn() {
    setEditingReturnId(null)
    setReturnForm(EMPTY_RETURN)
    setReturnError('')
    setShowReturnForm(true)
  }

  function openEditReturn(ret) {
    setEditingReturnId(ret.id)
    const cf = getCf(ret.items)
    setReturnForm({
      purchase_entry_id: ret.purchase_entry_id || '',
      qty: cf > 1 ? ret.qty / cf : ret.qty,   // DB stores base units; form shows purchase units
      notes: ret.notes || ''
    })
    setReturnError('')
    setShowReturnForm(true)
  }

  // When a purchase is selected, auto-derive item/vendor/rate/payment from it
  function getLinkedPurchase(purchaseEntryId) {
    return purchases.find(p => p.id === purchaseEntryId) || null
  }

  async function saveReturn() {
    if (!effectiveClientId) { setReturnError('No client selected. Pick a client in the top-left switcher before saving.'); return }
    if (!returnForm.purchase_entry_id) { setReturnError('Select a purchase entry to return against.'); return }
    const linked = getLinkedPurchase(returnForm.purchase_entry_id)
    if (!linked) { setReturnError('Linked purchase not found.'); return }
    const retQty = parseFloat(returnForm.qty)
    if (!returnForm.qty || retQty <= 0) { setReturnError('Enter a valid return quantity.'); return }
    const retCf = getCf(linked.items)
    const baseRetQty = retQty * retCf
    const linkedQty = parseFloat(linked.qty)
    // Previously only checked THIS return against the original purchase qty, never against
    // returns already recorded against the same purchase_entry_id — two 8kg returns against a
    // 10kg purchase both individually passed (8 <= 10), returning 16kg total and producing
    // negative effective stock in Variance/FIFO. Excludes the row being edited from its own cap.
    const priorReturnedQty = returns
      .filter(r => r.purchase_entry_id === linked.id && r.id !== editingReturnId)
      .reduce((sum, r) => sum + (parseFloat(r.qty) || 0), 0)
    const remainingQty = linkedQty - priorReturnedQty
    if (baseRetQty > remainingQty) {
      const maxDisplay = retCf > 1 ? `${(remainingQty / retCf).toFixed(3)} ${linked.items?.purchase_unit}` : `${remainingQty} ${linked.items?.uom}`
      setReturnError(`Return qty cannot exceed remaining returnable qty (${maxDisplay} — ${priorReturnedQty > 0 ? 'some was already returned' : 'exceeds original purchase qty'}).`)
      return
    }

    setReturnSaving(true)
    setReturnError('')

    const payload = {
      period_id:          period.id,
      purchase_entry_id:  linked.id,
      item_id:            linked.item_id,
      vendor_id:          linked.vendor_id || null,
      qty:                baseRetQty,
      rate:               parseFloat(linked.rate),
      payment_method:     linked.payment_method || 'Cash',
      bs_day:             linked.bs_day,
      notes:              returnForm.notes.trim() || null
    }

    if (editingReturnId) {
      const { error } = await scopedUpdate('vendor_returns', payload).eq('id', editingReturnId)
      if (error) { setReturnError(error.message); setReturnSaving(false); return }
    } else {
      const { error } = await scopedInsert('vendor_returns', payload)
      if (error) { setReturnError(error.message); setReturnSaving(false); return }
    }

    setReturnSaving(false)
    setShowReturnForm(false)
    setEditingReturnId(null)
    onChanged()
  }

  async function deleteReturn(id) {
    if (!window.confirm('Delete this return entry?')) return
    await scopedDelete('vendor_returns').eq('id', id)
    onChanged()
  }

  const returnTotal = returns.reduce((s, r) => s + r.qty * r.rate, 0)

  return (
    <>
      {purchases.length === 0 && (
        <div style={{ background: 'rgba(201,168,76,0.06)', border: '1px solid rgba(201,168,76,0.2)', borderRadius: 8, padding: '12px 16px', marginBottom: 20, fontSize: 13, color: 'var(--theme-accent)' }}>
          No purchases exist for this period yet. Add purchases first before recording returns.
        </div>
      )}

      {/* Return Add/Edit Form */}
      {showReturnForm && (
        <Modal onClose={() => { setShowReturnForm(false); setEditingReturnId(null) }} title={editingReturnId ? 'Edit Return' : 'Record Return to Vendor'}>
          <div style={{ display: 'grid', gridTemplateColumns: '3fr 1fr 2fr', gap: 16 }}>
            <div className="form-field">
              <label>Purchase Entry to Return *</label>
              <select
                value={returnForm.purchase_entry_id}
                onChange={e => setReturnForm(f => ({ ...f, purchase_entry_id: e.target.value, qty: '' }))}
              >
                <option value="">— Select a purchase entry —</option>
                {purchases.map(p => {
                  const cf = getCf(p.items)
                  const dQty  = cf > 1 ? p.qty / cf : p.qty
                  const dUnit = cf > 1 ? p.items?.purchase_unit : p.items?.uom
                  const dRate = cf > 1 ? p.rate * cf : p.rate
                  return (
                    <option key={p.id} value={p.id}>
                      Day {p.bs_day} · {p.items?.name} · {Number(dQty).toLocaleString(undefined, { maximumFractionDigits: 3 })} {dUnit} @ NPR {Number(dRate).toLocaleString(undefined, { maximumFractionDigits: 2 })} ({p.payment_method || 'Cash'}) {p.vendors?.name ? `— ${p.vendors.name}` : ''}
                    </option>
                  )
                })}
              </select>
            </div>

            <div className="form-field">
              {(() => {
                const linked = getLinkedPurchase(returnForm.purchase_entry_id)
                const cf = getCf(linked?.items)
                const inputUnit = cf > 1 ? linked.items.purchase_unit : (linked?.items?.uom || '')
                const maxInInputUnits = linked ? (cf > 1 ? linked.qty / cf : linked.qty) : ''
                return (
                  <>
                    <label>Return Qty {inputUnit ? `(${inputUnit})` : ''} *</label>
                    <input
                      type="number" min="0.001" step="any"
                      value={returnForm.qty}
                      onChange={e => setReturnForm(f => ({ ...f, qty: e.target.value }))}
                      placeholder={maxInInputUnits ? `Max ${Number(maxInInputUnits).toLocaleString(undefined, { maximumFractionDigits: 3 })}` : '0'}
                    />
                    {linked && (
                      <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginTop: 4 }}>
                        Original: {cf > 1
                          ? `${(linked.qty / cf).toLocaleString(undefined, { maximumFractionDigits: 3 })} ${linked.items.purchase_unit} (${Number(linked.qty).toLocaleString()} ${linked.items?.uom})`
                          : `${Number(linked.qty).toLocaleString()} ${linked.items?.uom}`}
                      </div>
                    )}
                    {cf > 1 && returnForm.qty && (
                      <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 2 }}>
                        = {(parseFloat(returnForm.qty) * cf).toLocaleString()} {linked?.items?.uom}
                      </div>
                    )}
                  </>
                )
              })()}
            </div>

            <div className="form-field">
              <label>Notes (optional)</label>
              <input
                value={returnForm.notes}
                onChange={e => setReturnForm(f => ({ ...f, notes: e.target.value }))}
                placeholder="Reason for return, damaged batch, etc."
              />
            </div>
          </div>

          {/* Auto-inherited fields preview */}
          {returnForm.purchase_entry_id && (() => {
            const linked = getLinkedPurchase(returnForm.purchase_entry_id)
            if (!linked) return null
            const cf = getCf(linked.items)
            const displayRate = cf > 1 ? linked.rate * cf : linked.rate
            const displayRateUnit = cf > 1 ? linked.items?.purchase_unit : linked.items?.uom
            const baseRetQty = returnForm.qty ? parseFloat(returnForm.qty) * cf : 0
            const retValue = baseRetQty * linked.rate
            return (
              <div style={{ marginTop: 12, padding: '10px 14px', background: 'rgba(248,113,113,0.06)', border: '1px solid rgba(248,113,113,0.15)', borderRadius: 6, fontSize: 13, color: 'var(--theme-text2)', display: 'flex', gap: 24, flexWrap: 'wrap' }}>
                <span>Rate: <strong style={{ color: 'var(--theme-text1)' }}>NPR {Number(displayRate).toLocaleString(undefined, { maximumFractionDigits: 2 })}/{displayRateUnit}</strong></span>
                <span>Vendor: <strong style={{ color: 'var(--theme-text1)' }}>{linked.vendors?.name || '—'}</strong></span>
                <span>Payment: <strong style={{ color: 'var(--theme-text1)' }}>{linked.payment_method || 'Cash'}</strong></span>
                {retValue > 0 && <span>Return Value: <strong style={{ color: 'var(--theme-red)' }}>−NPR {retValue.toLocaleString('en-NP', { maximumFractionDigits: 0 })}</strong></span>}
                <span style={{ color: 'var(--theme-text3)', fontSize: 11 }}>Rate, vendor & payment inherited from original purchase</span>
              </div>
            )
          })()}

          {returnError && <p style={{ color: 'var(--theme-red)', fontSize: 13, margin: '10px 0 0' }}>{returnError}</p>}
          <div className="form-actions">
            <button className="btn btn-ghost" onClick={() => { setShowReturnForm(false); setEditingReturnId(null) }}>Cancel</button>
            <button className="btn btn-primary" style={{ background: 'var(--theme-red)', borderColor: 'var(--theme-red)' }} onClick={saveReturn} disabled={returnSaving}>
              {returnSaving ? 'Saving…' : editingReturnId ? 'Update Return' : 'Record Return'}
            </button>
          </div>
        </Modal>
      )}

      {/* Returns table */}
      <div className="card">
        {returns.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">↩</div>
            <p className="empty-state-text">No returns recorded for this period. Click + Add Return to record a vendor return.</p>
          </div>
        ) : (
          <div className="table-wrap table-wrap--fab-clear">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Day</th><th>Item</th><th>Vendor</th>
                  <th style={{ textAlign: 'right' }}>Returned Qty</th><th>UOM</th>
                  <th style={{ textAlign: 'right' }}>Rate</th>
                  <th style={{ textAlign: 'right' }}>Return Value</th>
                  <th>Payment</th><th>Notes</th><th></th>
                </tr>
              </thead>
              <tbody>
                {returns.map(ret => (
                  <tr key={ret.id}>
                    <td style={{ fontWeight: 700, color: 'var(--theme-accent)' }}>{ret.bs_day || '—'}</td>
                    <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{ret.items?.name}</td>
                    <td style={{ color: 'var(--theme-text2)' }}>{ret.vendors?.name || <span style={{ color: 'var(--theme-text3)' }}>—</span>}</td>
                    {(() => {
                      const cf = getCf(ret.items)
                      const displayQty  = cf > 1 ? ret.qty / cf : ret.qty
                      const displayUnit = cf > 1 ? ret.items.purchase_unit : ret.items?.uom
                      const displayRate = cf > 1 ? ret.rate * cf : ret.rate
                      return (
                        <>
                          <td style={{ textAlign: 'right', color: 'var(--theme-red)', fontWeight: 600 }}>
                            −{Number(displayQty).toLocaleString(undefined, { maximumFractionDigits: 3 })}
                            {cf > 1 && <div style={{ fontSize: 10, color: 'var(--theme-text3)' }}>{Number(ret.qty).toLocaleString()} {ret.items?.uom}</div>}
                          </td>
                          <td style={{ color: 'var(--theme-text2)' }}>{displayUnit}</td>
                          <td style={{ textAlign: 'right' }}>{Number(displayRate).toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                        </>
                      )
                    })()}
                    <td style={{ textAlign: 'right', color: 'var(--theme-red)', fontWeight: 700 }}>
                      −NPR {(ret.qty * ret.rate).toLocaleString('en-NP', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </td>
                    <td>
                      <span className={`badge ${ret.payment_method === 'Cash' ? 'badge-green' : ret.payment_method === 'Credit' ? 'badge-red' : 'badge-yellow'}`}>
                        {ret.payment_method || 'Cash'}
                      </span>
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--theme-text2)' }}>{ret.notes || '—'}</td>
                    <td style={{ textAlign: 'right' }}>
                      {!isLocked && (
                        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                          <button className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 8px' }} onClick={() => openEditReturn(ret)}>Edit</button>
                          <button className="btn btn-danger" style={{ fontSize: 11, padding: '4px 8px' }} onClick={() => deleteReturn(ret.id)}>Del</button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
                <tr style={{ borderTop: '2px solid var(--theme-border)' }}>
                  <td colSpan={6} style={{ fontWeight: 700, color: 'var(--theme-text2)', paddingTop: 12 }}>Total Returns</td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-red)', fontSize: 15, paddingTop: 12 }}>
                    −NPR {returnTotal.toLocaleString('en-NP', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </td>
                  <td colSpan={3}></td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>
      <Fab onClick={openNewReturn} label="+ Add Return" show={!isLocked && !showReturnForm && purchases.length > 0} />
    </>
  )
}
