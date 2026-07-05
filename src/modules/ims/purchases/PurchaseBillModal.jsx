import { useState } from 'react'
import { supabase } from '../../../supabaseClient'
import { bsToAd, formatAd, daysInBsMonth } from '../../../utils/bsCalendar'
import BsCalendarPicker from '../../../components/BsCalendarPicker'
import Tip from '../../../components/Tip'
import Modal from '../../../components/Modal'
import SearchableSelect from '../../../components/SearchableSelect'
import { getCf } from './purchasesHelpers'

const EMPTY_HEADER = { vendor_id: '', bs_day: '', invoice_ref: '', payment_method: 'Cash', discount: '', vat_inclusive: false }
const PAYMENT_METHODS = ['Cash', 'Credit', 'FonePay']
const newLine = () => ({ _key: Date.now() + Math.random(), item_id: '', qty: '', rate: '', expiry_date: '', shelf_life: '', vat_inclusive: false, _amtDraft: '' })

// Builds the initial header/lines from the group of raw purchase_entries being edited — mirrors
// the old Purchases.js openEditGroup(). Purchase-unit qty/rate are converted back from the
// base-unit values stored in the DB (see CLAUDE.md's "Purchases: qty/rate storage convention").
function initFromEditingEntries(entries, items) {
  const first = entries[0]
  const header = {
    vendor_id: first.vendor_id || '',
    bs_day: String(first.bs_day),
    invoice_ref: first.invoice_ref || '',
    payment_method: first.payment_method || 'Cash',
    discount: first.discount_amount ? String(first.discount_amount) : '',
    vat_inclusive: first.vat_inclusive || false,
  }
  const lines = entries.map(e => {
    const item = items.find(i => i.id === e.item_id)
    const cf = getCf(item)
    return {
      _key: Date.now() + Math.random(),
      item_id: e.item_id,
      qty: String(cf > 1 ? e.qty / cf : e.qty),
      rate: String(cf > 1 ? e.rate * cf : e.rate),
      expiry_date: e.expiry_date || '',
      shelf_life: '',
      vat_inclusive: e.vat_inclusive || false,
      _amtDraft: '',
    }
  })
  return { header, lines }
}

// Add/Edit Purchase Bill — a multi-row bill entry form. Self-contained: owns its own
// header/line state and the save/validation logic; the parent only supplies the data it needs
// (period, items, vendors) and gets a single onSaved(validLines) callback so it can reload the
// purchases list and run its own "did any item's rate change" check.
export default function PurchaseBillModal({ period, items, itemOptions, vendors, editingGroupId, editingEntries, onClose, onSaved }) {
  const initial = editingEntries?.length ? initFromEditingEntries(editingEntries, items) : { header: { ...EMPTY_HEADER }, lines: [newLine()] }
  const [billHeader, setBillHeader] = useState(initial.header)
  const [billLines, setBillLines]   = useState(initial.lines)
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState('')

  function handleHeaderDayChange(day) {
    setBillHeader(h => ({ ...h, bs_day: day }))
    if (day && period) {
      setBillLines(prev => prev.map(l => {
        if (!l.shelf_life) return l
        const ad = bsToAd(period.bs_year, period.bs_month, parseInt(day))
        const exp = new Date(ad); exp.setDate(exp.getDate() + parseInt(l.shelf_life))
        return { ...l, expiry_date: formatAd(exp) }
      }))
    }
  }

  function updateBillLine(key, field, val) {
    setBillLines(prev => prev.map(l => {
      if (l._key !== key) return l
      const updated = { ...l, [field]: val }
      if (field === 'item_id') {
        const item = items.find(i => i.id === val)
        if (item?.rate) updated.rate = String(item.rate)
        updated._amtDraft = ''
      }
      if (field === 'rate' || field === 'vat_inclusive') updated._amtDraft = ''
      if (field === 'shelf_life' && val && billHeader.bs_day && period) {
        const ad = bsToAd(period.bs_year, period.bs_month, parseInt(billHeader.bs_day))
        const exp = new Date(ad); exp.setDate(exp.getDate() + parseInt(val))
        updated.expiry_date = formatAd(exp)
      }
      return updated
    }))
  }

  function setLineTotal(key, amtStr) {
    setBillLines(prev => prev.map(l => {
      if (l._key !== key) return l
      const qty = parseFloat(l.qty)
      const amt = parseFloat(amtStr)
      const rate = (qty > 0 && amt > 0)
        ? String((amt / qty / (l.vat_inclusive ? 1.13 : 1)).toFixed(5))
        : l.rate
      return { ...l, _amtDraft: amtStr, rate }
    }))
  }

  function addBillLine() { setBillLines(prev => [...prev, newLine()]) }
  function removeBillLine(key) { setBillLines(prev => prev.length > 1 ? prev.filter(l => l._key !== key) : prev) }

  async function saveBill() {
    const maxDay = period ? daysInBsMonth(period.bs_year, period.bs_month) : 32
    if (!billHeader.bs_day || billHeader.bs_day < 1 || billHeader.bs_day > maxDay) {
      setError(`Enter a valid BS day (1–${maxDay}).`); return
    }
    const valid = billLines.filter(l => l.item_id && parseFloat(l.qty) > 0 && parseFloat(l.rate) > 0)
    if (valid.length === 0) { setError('Add at least one item with item, qty and rate filled.'); return }

    setSaving(true); setError('')

    const discountAmt = parseFloat(billHeader.discount) || 0
    const entries = valid.map(l => {
      const item = items.find(i => i.id === l.item_id)
      const cf = getCf(item)
      const exVatRate = parseFloat(l.rate)  // entered rate is always ex-VAT (NetRate on bill)
      return {
        period_id:       period.id,
        item_id:         l.item_id,
        vendor_id:       billHeader.vendor_id || null,
        bs_day:          parseInt(billHeader.bs_day),
        qty:             parseFloat(l.qty) * cf,
        rate:            exVatRate / cf,
        invoice_ref:     billHeader.invoice_ref.trim() || null,
        expiry_date:     l.expiry_date || null,
        payment_method:  billHeader.payment_method || 'Cash',
        vat_inclusive:   l.vat_inclusive || false,
        discount_amount: discountAmt,
      }
    })

    if (editingGroupId) {
      const { error: delErr } = await supabase.from('purchase_entries').delete().eq('purchase_group_id', editingGroupId)
      if (delErr) { setError(delErr.message); setSaving(false); return }
      const { error: insErr } = await supabase.from('purchase_entries').insert(entries.map(e => ({ ...e, purchase_group_id: editingGroupId })))
      if (insErr) { setError(insErr.message); setSaving(false); return }
    } else {
      const groupId = crypto.randomUUID()
      const { error: insErr } = await supabase.from('purchase_entries').insert(entries.map(e => ({ ...e, purchase_group_id: groupId })))
      if (insErr) { setError(insErr.message); setSaving(false); return }
    }

    setSaving(false)
    onSaved(valid)
  }

  return (
    <Modal onClose={onClose} title={editingGroupId ? 'Edit Purchase Bill' : 'Add Purchase Bill'} maxWidth={1160}>
      {/* Header row */}
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1.4fr auto 90px 1fr', gap: 14, marginBottom: 20, alignItems: 'end' }}>
        <div className="form-field">
          <label>Vendor</label>
          <select className="form-select" style={{ fontSize: 13 }} value={billHeader.vendor_id} onChange={e => setBillHeader(h => ({ ...h, vendor_id: e.target.value }))}>
            <option value="">— None —</option>
            {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </div>
        <div className="form-field">
          <label>Day (BS) *</label>
          <BsCalendarPicker lockYear={period?.bs_year} lockMonth={period?.bs_month} value={billHeader.bs_day} onChange={handleHeaderDayChange} placeholder="Pick day" />
        </div>
        <div className="form-field">
          <label><Tip text="Vendor's invoice or bill number. Shared across all items on this bill." width={240}>Invoice Ref</Tip></label>
          <input value={billHeader.invoice_ref} onChange={e => setBillHeader(h => ({ ...h, invoice_ref: e.target.value }))} placeholder="Optional"
            style={{ background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 5, padding: '7px 10px', fontSize: 13, color: 'var(--theme-text1)', outline: 'none', width: '100%', boxSizing: 'border-box' }} />
        </div>
        <div className="form-field">
          <label><Tip text="Apply 13% VAT to all line items at once. You can also toggle VAT on each individual line row." width={270}>VAT</Tip></label>
          {(() => {
            const allVat  = billLines.every(l => l.vat_inclusive)
            const someVat = billLines.some(l => l.vat_inclusive)
            return (
              <button
                type="button"
                onClick={() => setBillLines(ls => ls.map(l => ({ ...l, vat_inclusive: !allVat })))}
                style={{ cursor: 'pointer', background: 'none', border: 'none', padding: '8px 4px', display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}
              >
                <div style={{ width: 34, height: 18, borderRadius: 9, background: allVat ? '#f59e0b' : someVat ? '#b45309' : 'var(--theme-border)', position: 'relative', transition: 'background 0.2s', flexShrink: 0 }}>
                  <div style={{ position: 'absolute', top: 3, left: allVat ? 17 : someVat ? 11 : 3, width: 12, height: 12, borderRadius: '50%', background: '#fff', transition: 'left 0.2s' }} />
                </div>
                <span style={{ fontSize: 13, fontWeight: someVat ? 700 : 400, color: allVat ? '#f59e0b' : someVat ? '#b45309' : 'var(--theme-text3)', letterSpacing: '0.04em' }}>
                  {allVat ? 'VAT 13%' : someVat ? 'VAT Mixed' : 'No VAT'}
                </span>
              </button>
            )
          })()}
        </div>
        <div className="form-field">
          <label><Tip text="Promo or trade discount on the total bill. Applied before VAT — VAT is levied only on the net taxable amount." width={260}>Discount (NPR)</Tip></label>
          <input type="number" min="0" step="any"
            value={billHeader.discount}
            onChange={e => setBillHeader(h => ({ ...h, discount: e.target.value }))}
            placeholder="0"
            style={{ background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 5, padding: '7px 10px', fontSize: 13, color: 'var(--theme-red)', outline: 'none', width: '90px', textAlign: 'right' }} />
        </div>
        <div className="form-field">
          <label><Tip text="Cash: paid on delivery. Credit: pay later. FonePay: digital payment. Applied to all items on this bill.">Payment</Tip></label>
          <select className="form-select" style={{ fontSize: 13 }} value={billHeader.payment_method} onChange={e => setBillHeader(h => ({ ...h, payment_method: e.target.value }))}>
            {PAYMENT_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
      </div>

      <div style={{ borderTop: '1px solid var(--theme-border)', marginBottom: 16 }} />

      {/* Line items table — mirrors vendor bill: Item | Qty | NetRate | NetAmt | VAT */}
      <div className="table-wrap">
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 920 }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', fontSize: 11, color: 'var(--theme-text2)', padding: '0 8px 10px 0', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                <Tip text="Select the item to purchase." width={200}>Item *</Tip>
              </th>
              <th style={{ textAlign: 'right', fontSize: 11, color: 'var(--theme-text2)', padding: '0 8px 10px', textTransform: 'uppercase', letterSpacing: '0.07em', width: 82 }}>Qty *</th>
              <th style={{ textAlign: 'right', fontSize: 11, color: 'var(--theme-text2)', padding: '0 8px 10px', textTransform: 'uppercase', letterSpacing: '0.07em', width: 105 }}>
                <Tip text="Enter the ex-VAT rate per unit. Check the VAT box on each line for items attracting 13% VAT." width={270}>Rate (NPR) *</Tip>
              </th>
              <th style={{ textAlign: 'center', fontSize: 11, color: 'var(--theme-text2)', padding: '0 4px 10px', textTransform: 'uppercase', letterSpacing: '0.07em', width: 40 }}>
                <Tip text="Check to apply 13% VAT to this line item only." width={210}>VAT</Tip>
              </th>
              <th style={{ textAlign: 'right', fontSize: 11, color: 'var(--theme-text2)', padding: '0 8px 10px', textTransform: 'uppercase', letterSpacing: '0.07em', width: 105 }}>
                <Tip text="Enter total paid for this line — Rate is back-calculated automatically." width={230}>Total (NPR)</Tip>
              </th>
              <th style={{ textAlign: 'right', fontSize: 11, color: 'var(--theme-text2)', padding: '0 8px 10px', textTransform: 'uppercase', letterSpacing: '0.07em', width: 105 }}>
                <Tip text="Amount = Qty × Rate. For VAT items: Qty × Rate × 1.13 (what you actually pay)." width={240}>Amount</Tip>
              </th>
              <th style={{ textAlign: 'left', fontSize: 11, color: 'var(--theme-text2)', padding: '0 8px 10px', textTransform: 'uppercase', letterSpacing: '0.07em', width: 140 }}>
                <Tip text="Expiry date of this batch (AD). Fill Shelf Life to auto-calculate." width={230}>Expiry Date</Tip>
              </th>
              <th style={{ textAlign: 'right', fontSize: 11, color: 'var(--theme-text2)', padding: '0 8px 10px', textTransform: 'uppercase', letterSpacing: '0.07em', width: 95 }}>
                <Tip text="Enter shelf-life in days and the expiry date will be auto-filled from the bill date." width={240}>Days</Tip>
              </th>
              <th style={{ width: 28 }}></th>
            </tr>
          </thead>
          <tbody>
            {billLines.map((line) => {
              const selItem = items.find(i => i.id === line.item_id)
              const cf = getCf(selItem)
              const inputUnit = cf > 1 ? selItem.purchase_unit : (selItem?.uom || '')
              const lineBase = (parseFloat(line.qty) || 0) * (parseFloat(line.rate) || 0)
              const lineAmount = line.vat_inclusive ? lineBase * 1.13 : lineBase
              const cellInput = { background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 5, padding: '7px 10px', fontSize: 13, color: 'var(--theme-text1)', outline: 'none', width: '100%', textAlign: 'right' }
              return (
                  <tr key={line._key} style={{ borderBottom: '1px solid var(--theme-card)' }}>
                    <td style={{ padding: '6px 8px 6px 0', verticalAlign: 'middle' }}>
                      <SearchableSelect
                        value={line.item_id}
                        onChange={v => updateBillLine(line._key, 'item_id', v)}
                        options={itemOptions}
                        placeholder="— Select item —"
                      />
                    </td>
                    <td style={{ padding: '6px 8px 4px', verticalAlign: 'middle' }}>
                      <input type="number" min="0" step="any" value={line.qty} placeholder="0"
                        onChange={e => updateBillLine(line._key, 'qty', e.target.value)}
                        style={cellInput} />
                      {inputUnit && <div style={{ fontSize: 10, color: 'var(--theme-text2)', textAlign: 'right', marginTop: 2 }}>{inputUnit}</div>}
                      {cf > 1 && line.qty && <div style={{ fontSize: 10, color: 'var(--theme-text3)', textAlign: 'right' }}>= {(parseFloat(line.qty) * cf).toLocaleString()} {selItem?.uom}</div>}
                    </td>
                    <td style={{ padding: '6px 8px 4px', verticalAlign: 'middle' }}>
                      <input type="number" min="0" step="any" value={line.rate} placeholder="0"
                        onChange={e => updateBillLine(line._key, 'rate', e.target.value)}
                        style={cellInput} />
                    </td>
                    <td style={{ padding: '6px 4px 4px', verticalAlign: 'middle', textAlign: 'center' }}>
                      <input
                        type="checkbox"
                        checked={line.vat_inclusive}
                        onChange={() => updateBillLine(line._key, 'vat_inclusive', !line.vat_inclusive)}
                        style={{ cursor: 'pointer', width: 15, height: 15, accentColor: '#f59e0b' }}
                      />
                      {line.vat_inclusive && <div style={{ fontSize: 9, color: '#f59e0b', marginTop: 2, fontWeight: 700 }}>13%</div>}
                    </td>
                    <td style={{ padding: '6px 8px 4px', verticalAlign: 'middle' }}>
                      <input
                        type="number" min="0" step="any"
                        value={line._amtDraft}
                        placeholder={lineAmount > 0 ? lineAmount.toFixed(2) : ''}
                        onChange={e => setLineTotal(line._key, e.target.value)}
                        style={cellInput}
                      />
                    </td>
                    <td style={{ padding: '6px 8px 4px', verticalAlign: 'middle', textAlign: 'right' }}>
                      {lineAmount > 0 && (
                        <>
                          <div style={{ fontSize: 13, color: 'var(--theme-accent)', fontWeight: 600, paddingTop: 7 }}>
                            {lineAmount.toLocaleString('en-NP', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </div>
                          {line.vat_inclusive && parseFloat(line.rate) > 0 && (
                            <div style={{ fontSize: 10, color: 'var(--theme-amber)', marginTop: 2 }}>
                              +VAT {(parseFloat(line.rate) * 0.13 * (parseFloat(line.qty) || 1)).toFixed(2)}
                            </div>
                          )}
                        </>
                      )}
                    </td>
                    <td style={{ padding: '6px 8px 6px', verticalAlign: 'middle' }}>
                      <input type="date" value={line.expiry_date}
                        onChange={e => updateBillLine(line._key, 'expiry_date', e.target.value)}
                        style={{ background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 5, padding: '7px 8px', fontSize: 12, color: 'var(--theme-text2)', outline: 'none', width: '100%' }} />
                    </td>
                    <td style={{ padding: '6px 8px 6px', verticalAlign: 'middle' }}>
                      <input type="number" min="0" value={line.shelf_life} placeholder="Days"
                        onChange={e => updateBillLine(line._key, 'shelf_life', e.target.value)}
                        title="Enter days to auto-fill expiry date"
                        style={{ background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 5, padding: '7px 8px', fontSize: 12, color: 'var(--theme-text2)', outline: 'none', width: '100%', textAlign: 'right' }} />
                    </td>
                    <td style={{ padding: '6px 0 6px', verticalAlign: 'middle', textAlign: 'right' }}>
                      <button onClick={() => removeBillLine(line._key)}
                        style={{ background: 'none', border: 'none', color: 'var(--theme-text2)', cursor: 'pointer', fontSize: 18, padding: '4px', lineHeight: 1 }}>×</button>
                    </td>
                  </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'flex-end', marginTop: 14, gap: 16 }}>
        {(() => {
          const taxableBase    = billLines.reduce((s, l) => l.vat_inclusive ? s + (parseFloat(l.qty)||0) * (parseFloat(l.rate)||0) : s, 0)
          const nonTaxableBase = billLines.reduce((s, l) => !l.vat_inclusive ? s + (parseFloat(l.qty)||0) * (parseFloat(l.rate)||0) : s, 0)
          const subTotal       = taxableBase + nonTaxableBase
          const discount       = parseFloat(billHeader.discount) || 0
          // Discount spread proportionally; VAT levied only on taxable portion after discount
          const vatTaxable     = subTotal > 0 ? taxableBase * (1 - discount / subTotal) : 0
          const vatTotal       = vatTaxable * 0.13
          const grandTotal     = subTotal - discount + vatTotal
          if (subTotal === 0) return null
          const fmt = n => n.toLocaleString('en-NP', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
          const itemCount = billLines.filter(l => l.item_id && parseFloat(l.qty) > 0 && parseFloat(l.rate) > 0).length
          return (
            <div style={{ textAlign: 'right', fontSize: 13, minWidth: 300 }}>
              <div style={{ color: 'var(--theme-text3)', marginBottom: 3 }}>
                Items: <span style={{ color: 'var(--theme-text1)', fontWeight: 600, marginLeft: 8 }}>{itemCount}</span>
              </div>
              {taxableBase > 0 && (
                <div style={{ color: 'var(--theme-text3)', marginBottom: 3 }}>
                  Taxable (ex-VAT): <span style={{ color: 'var(--theme-text1)', fontWeight: 600, marginLeft: 8 }}>NPR {fmt(taxableBase)}</span>
                </div>
              )}
              {nonTaxableBase > 0 && (
                <div style={{ color: 'var(--theme-text3)', marginBottom: 3 }}>
                  Non-taxable: <span style={{ color: 'var(--theme-text1)', fontWeight: 600, marginLeft: 8 }}>NPR {fmt(nonTaxableBase)}</span>
                </div>
              )}
              {discount > 0 && (
                <div style={{ color: 'var(--theme-text3)', marginBottom: 3 }}>
                  Discount: <span style={{ color: 'var(--theme-red)', fontWeight: 600, marginLeft: 8 }}>− NPR {fmt(discount)}</span>
                </div>
              )}
              {vatTotal > 0 && (
                <div style={{ color: 'var(--theme-text3)', marginBottom: 3 }}>
                  VAT (13%): <span style={{ color: 'var(--theme-amber)', fontWeight: 600, marginLeft: 8 }}>NPR {fmt(vatTotal)}</span>
                </div>
              )}
              <div style={{ color: 'var(--theme-accent)', fontWeight: 700, fontSize: 14, borderTop: '1px solid var(--theme-border)', paddingTop: 6 }}>
                Grand Total: NPR {fmt(grandTotal)}
              </div>
            </div>
          )
        })()}
      </div>

      {error && <p style={{ color: 'var(--theme-red)', fontSize: 13, margin: '12px 0 0' }}>{error}</p>}
      <div className="form-actions" style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center' }}>
        <button className="btn btn-ghost" onClick={onClose}
          style={{ justifySelf: 'start', fontSize: 13, color: 'var(--theme-red)', borderColor: 'rgba(248,113,113,0.35)', background: 'rgba(248,113,113,0.07)' }}>Cancel</button>
        <button className="btn" onClick={addBillLine}
          style={{ fontSize: 13, background: 'var(--theme-amber)', color: '#000', borderColor: 'var(--theme-amber)' }}>
          + Add Item
        </button>
        <button className="btn btn-primary" onClick={saveBill} disabled={saving} style={{ justifySelf: 'end', fontSize: 13 }}>
          {saving ? 'Saving…' : editingGroupId ? 'Update Bill' : `Save ${billLines.filter(l => l.item_id && parseFloat(l.qty) > 0 && parseFloat(l.rate) > 0).length || ''} Entr${billLines.filter(l => l.item_id && parseFloat(l.qty) > 0 && parseFloat(l.rate) > 0).length === 1 ? 'y' : 'ies'}`}
        </button>
      </div>
    </Modal>
  )
}
