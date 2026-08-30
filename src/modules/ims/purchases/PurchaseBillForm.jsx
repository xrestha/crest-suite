import { useState } from 'react'
import { supabase } from '../../../supabaseClient'
import { bsToAd, formatAd, daysInBsMonth } from '../../../utils/bsCalendar'
import BsCalendarPicker from '../../../components/BsCalendarPicker'
import Tip from '../../../components/Tip'
import SearchableSelect from '../../../components/SearchableSelect'
import QtyInput from '../../../components/QtyInput'
import FieldError from '../../../components/FieldError'
import { getCf, calcBillTotals, fmtRate } from './purchasesHelpers'

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
// (period, items, vendors) and gets a single onSaved(validLines) callback so it can print the
// voucher and run its own "did any item's rate change" check.
//
// This was a <Modal maxWidth={1160}> until S647. It is the widest surface in the product — the
// line table alone declares minWidth: 956 — so on any laptop it was a wide form scrolling inside
// an overlay that was itself scrolling, on top of a page that could not be consulted while it was
// open. It is now the body of a real route (PurchaseBillPage) and renders at the full content
// width. Kept as a separate component from the page so the page owns routing, loading and what
// happens after a save, and this file stays what it always was: the form.
export default function PurchaseBillForm({ period, items, itemOptions, vendors, editingGroupId, editingEntries, onClose, onSaved }) {
  const initial = editingEntries?.length ? initFromEditingEntries(editingEntries, items) : { header: { ...EMPTY_HEADER }, lines: [newLine()] }
  const [billHeader, setBillHeader] = useState(initial.header)
  const [billLines, setBillLines]   = useState(initial.lines)
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState('')
  // Per-field validation. `error` above stays the form-level channel — a rejected write, and the
  // "add at least one line" rule, which belongs to the line table rather than any one box (S603).
  const [dayErr, setDayErr] = useState('')

  function handleHeaderDayChange(day) {
    setDayErr('')
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
        // The rate box must match whatever unit the qty box is counting: base units normally, and
        // purchase units when the item carries a conversion. `per_uom_rate` is the price of ONE base
        // unit (items are stored in their smallest unit — see Items.js), so scaling it by cf gives
        // the right prefill in both cases. Prefilling `items.rate` did too, right up until an item
        // was saved with a pack size in `purchase_qty` — then a 500 GM bottle's NPR 388.50 landed in
        // a row counting grams and billed 500 bottles. Purchase Orders has always done it this way.
        const cf = getCf(item)
        const per = parseFloat(item?.per_uom_rate)
        if (per > 0) updated.rate = String(parseFloat((per * cf).toFixed(5)))
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
      setDayErr(`Enter a valid BS day (1–${maxDay}).`); return
    }
    setDayErr('')
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
      // An edit with nothing to supersede is a contradiction, and the one that would duplicate the
      // bill: the insert below always runs, so if this list were empty we would add a second copy
      // of every line and delete none. Refuse instead — the caller only renders this form for an
      // edit once it has loaded the bill's rows, so reaching here means something is wrong.
      const supersededIds = (editingEntries || []).map(e => e.id)
      if (supersededIds.length === 0) {
        setError('This bill could not be re-read, so it was not saved. Reopen it from the list and try again.')
        setSaving(false); return
      }

      // Insert the new lines BEFORE removing the old ones (not delete-then-insert) — if the
      // insert fails partway (network blip, an item deleted mid-edit), the bill keeps its
      // previous, still-valid line items instead of being left with none.
      const { error: insErr } = await supabase.from('purchase_entries')
        .insert(entries.map(e => ({ ...e, purchase_group_id: editingGroupId })))
      if (insErr) { setError(insErr.message); setSaving(false); return }

      // Remove the superseded lines BY ID — the rows this form was opened on — not by matching
      // `purchase_group_id = editingGroupId`.
      //
      // That predicate silently missed the LEGACY case and duplicated the bill (fixed S648). A bill
      // written before grouping existed has `purchase_group_id IS NULL`, so the list keys it by the
      // row's own id (`p.purchase_group_id || p.id`) and hands that id here as editingGroupId. The
      // insert above then stamps the NEW rows with it — but the original row's group column is
      // still NULL, so the delete matched nothing but the rows it had just written, and the old
      // line survived alongside its own replacement. Every figure in IMS that sums purchases would
      // have counted that bill's original line twice, with nothing on screen to say so.
      //
      // Deleting the loaded ids is exact in both cases and needs no `.not('id','in',…)` guard,
      // since a fresh insert can never collide with an id we already held. It also declines to
      // delete a line added to this bill by someone else since it was opened: the group predicate
      // would have taken that with it, and removing a row this editor never saw is the worse of
      // the two failures. Not chunked — the list is one vendor bill's lines.
      const { error: delErr } = await supabase.from('purchase_entries')
        .delete().in('id', supersededIds)
      if (delErr) { setError(delErr.message); setSaving(false); return }
    } else {
      const groupId = crypto.randomUUID()
      const { error: insErr } = await supabase.from('purchase_entries').insert(entries.map(e => ({ ...e, purchase_group_id: groupId })))
      if (insErr) { setError(insErr.message); setSaving(false); return }
    }

    setSaving(false)
    onSaved(billHeader, valid)
  }

  // No QuickCalculator here any more. The form carried its own second instance plus a header
  // button only because the Modal around it ran a document keydown listener that ate Escape
  // before the calculator saw it (see the comment in Calculator.js). On a route there is no such
  // listener, so Layout.js's global Alt+C calculator — which was always mounted underneath —
  // simply works, and a duplicate would now be two calculators on one screen.
  return (
    <>
      {/* Header row */}
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1.4fr auto 90px 1fr', gap: 14, marginBottom: 20, alignItems: 'end' }}>
        <div className="form-field">
          <label htmlFor="purcha-f1">Vendor</label>
          <select id="purcha-f1" className="form-select" style={{ fontSize: 13 }} value={billHeader.vendor_id} onChange={e => setBillHeader(h => ({ ...h, vendor_id: e.target.value }))}>
            <option value="">— None —</option>
            {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </div>
        <div className="form-field">
          <label htmlFor="pb-day">Day (BS) *</label>
          <BsCalendarPicker id="pb-day" lockYear={period?.bs_year} lockMonth={period?.bs_month} value={billHeader.bs_day} onChange={handleHeaderDayChange} placeholder="Pick day" invalid={dayErr} />
          <FieldError id="pb-day" message={dayErr} />
        </div>
        <div className="form-field">
          <label htmlFor="purcha-f2"><Tip text="Vendor's invoice or bill number. Shared across all items on this bill." width={240}>Invoice Ref</Tip></label>
          <input id="purcha-f2" value={billHeader.invoice_ref} onChange={e => setBillHeader(h => ({ ...h, invoice_ref: e.target.value }))} placeholder="Optional"
            style={{ background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', padding: '7px 10px', fontSize: 13, color: 'var(--theme-text1)', outline: 'none', width: '100%', boxSizing: 'border-box' }} />
        </div>
        <div className="form-field">
          <span className="field-label"><Tip text="Apply 13% VAT to all line items at once. You can also toggle VAT on each individual line row." width={270}>VAT</Tip></span>
          {(() => {
            const allVat  = billLines.every(l => l.vat_inclusive)
            const someVat = billLines.some(l => l.vat_inclusive)
            const knobBg = allVat ? 'var(--theme-amber)' : someVat ? 'var(--theme-amber)' : 'var(--theme-border)'
            const knobOpacity = someVat && !allVat ? 0.6 : 1
            return (
              <button
                type="button"
                aria-label="Apply 13% VAT to all line items"
                aria-pressed={allVat ? true : someVat ? 'mixed' : false}
                onClick={() => setBillLines(ls => ls.map(l => ({ ...l, vat_inclusive: !allVat })))}
                style={{ cursor: 'pointer', background: 'none', border: 'none', padding: '8px 4px', display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}
              >
                <div style={{ width: 34, height: 18, borderRadius: 'var(--radius-md)', background: knobBg, opacity: knobOpacity, position: 'relative', transition: 'background 0.2s, opacity 0.2s', flexShrink: 0 }}>
                  <div style={{ position: 'absolute', top: 3, left: allVat ? 17 : someVat ? 11 : 3, width: 12, height: 12, borderRadius: '50%', background: '#fff', transition: 'left 0.2s' }} />
                </div>
                <span style={{ fontSize: 13, fontWeight: someVat ? 700 : 400, color: knobBg, opacity: knobOpacity, letterSpacing: '0.04em' }}>
                  {allVat ? 'VAT 13%' : someVat ? 'VAT Mixed' : 'No VAT'}
                </span>
              </button>
            )
          })()}
        </div>
        <div className="form-field">
          <label htmlFor="purcha-f3"><Tip text="Promo or trade discount on the total bill. Applied before VAT — VAT is levied only on the net taxable amount." width={260}>Discount (NPR)</Tip></label>
          <input id="purcha-f3" type="number" min="0" step="any"
            value={billHeader.discount}
            onChange={e => setBillHeader(h => ({ ...h, discount: e.target.value }))}
            placeholder="0"
            style={{ background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', padding: '7px 10px', fontSize: 13, color: 'var(--theme-red-text)', outline: 'none', width: '90px', textAlign: 'right' }} />
        </div>
        <div className="form-field">
          <label htmlFor="purcha-f4"><Tip text="Cash: paid on delivery. Credit: pay later. FonePay: digital payment. Applied to all items on this bill.">Payment</Tip></label>
          <select id="purcha-f4" className="form-select" style={{ fontSize: 13 }} value={billHeader.payment_method} onChange={e => setBillHeader(h => ({ ...h, payment_method: e.target.value }))}>
            {PAYMENT_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
      </div>

      <div style={{ borderTop: '1px solid var(--theme-border)', marginBottom: 16 }} />

      {/* Line items table — mirrors vendor bill: Item | Qty | NetRate | NetAmt | VAT */}
      <div className="table-wrap">
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 956 }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', fontSize: 11, color: 'var(--theme-text2)', padding: '0 8px 10px 0', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                <Tip text="Select the item to purchase." width={200}>Item *</Tip>
              </th>
              <th style={{ textAlign: 'right', fontSize: 11, color: 'var(--theme-text2)', padding: '0 8px 10px', textTransform: 'uppercase', letterSpacing: '0.07em', width: 118 }}>Qty *</th>
              <th style={{ textAlign: 'right', fontSize: 11, color: 'var(--theme-text2)', padding: '0 8px 10px', textTransform: 'uppercase', letterSpacing: '0.07em', width: 105 }}>
                <Tip text="Ex-VAT price for ONE of whatever the Qty column is counting — the base unit (GM, PCS…), or the purchase unit where the item has a conversion set. Item Master's price for that same unit is shown under each box. Check the VAT box on each line for items attracting 13% VAT." width={300}>Rate (NPR) *</Tip>
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
              // Item Master's price for one of whatever the qty box is counting. Shown under the
              // rate so a rate entered in the wrong unit is visible on the row itself rather than
              // only in the grand total, where a 500× error still reads as a plausible number.
              const masterRate = (parseFloat(selItem?.per_uom_rate) || 0) * cf
              const rateEntered = parseFloat(line.rate) || 0
              const rateOffBy = masterRate > 0 && rateEntered > 0 ? rateEntered / masterRate : 1
              const rateSuspect = rateOffBy > 5 || rateOffBy < 0.2
              const lineBase = (parseFloat(line.qty) || 0) * (parseFloat(line.rate) || 0)
              const lineAmount = line.vat_inclusive ? lineBase * 1.13 : lineBase
              const cellInput = { background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', padding: '7px 10px', fontSize: 13, color: 'var(--theme-text1)', outline: 'none', width: '100%', textAlign: 'right' }
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
                      <div style={{ position: 'relative' }}>
                        {inputUnit && (
                          <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 11, color: 'var(--theme-text3)', pointerEvents: 'none' }}>
                            {inputUnit}
                          </span>
                        )}
                        <QtyInput value={line.qty} placeholder="0"
                          onChange={v => updateBillLine(line._key, 'qty', v)}
                          wrapperStyle={{ width: '100%' }}
                          style={{ ...cellInput, boxSizing: 'border-box', fontFamily: 'inherit', paddingLeft: inputUnit ? 34 : cellInput.padding.split(' ')[1] }} />
                      </div>
                      {cf > 1 && line.qty && <div style={{ fontSize: 10, color: 'var(--theme-text3)', textAlign: 'right', marginTop: 2 }}>= {(parseFloat(line.qty) * cf).toLocaleString()} {selItem?.uom}</div>}
                    </td>
                    <td style={{ padding: '6px 8px 4px', verticalAlign: 'middle' }}>
                      <QtyInput value={line.rate} placeholder="0"
                        onChange={v => updateBillLine(line._key, 'rate', v)}
                        wrapperStyle={{ width: '100%' }}
                        style={{ ...cellInput, boxSizing: 'border-box', fontFamily: 'inherit' }} />
                      {masterRate > 0 && (
                        <div style={{ fontSize: 10, textAlign: 'right', marginTop: 2, color: rateSuspect ? 'var(--theme-amber-text)' : 'var(--theme-text3)' }}>
                          {rateSuspect ? '⚠ ' : ''}Master: {fmtRate(masterRate)}/{inputUnit || selItem?.uom}
                        </div>
                      )}
                    </td>
                    <td style={{ padding: '6px 4px 4px', verticalAlign: 'middle', textAlign: 'center' }}>
                      <input
                        type="checkbox"
                        aria-label={`VAT-inclusive line for ${selItem?.name || 'new line'}`}
                        checked={line.vat_inclusive}
                        onChange={() => updateBillLine(line._key, 'vat_inclusive', !line.vat_inclusive)}
                        style={{ cursor: 'pointer', width: 15, height: 15, accentColor: 'var(--theme-amber)' }}
                      />
                      {line.vat_inclusive && <div style={{ fontSize: 9, color: 'var(--theme-amber-text)', marginTop: 2, fontWeight: 700 }}>13%</div>}
                    </td>
                    <td style={{ padding: '6px 8px 4px', verticalAlign: 'middle' }}>
                      <input
                        type="number" min="0" step="any"
                        aria-label={`Line total for ${selItem?.name || 'new line'}`}
                        value={line._amtDraft}
                        placeholder={lineAmount > 0 ? lineAmount.toFixed(2) : ''}
                        onChange={e => setLineTotal(line._key, e.target.value)}
                        style={cellInput}
                      />
                    </td>
                    <td style={{ padding: '6px 8px 4px', verticalAlign: 'middle', textAlign: 'right' }}>
                      {lineAmount > 0 && (
                        <>
                          <div style={{ fontSize: 13, color: 'var(--theme-accent-ink)', fontWeight: 600, paddingTop: 7 }}>
                            {lineAmount.toLocaleString('en-NP', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </div>
                          {line.vat_inclusive && parseFloat(line.rate) > 0 && (
                            <div style={{ fontSize: 10, color: 'var(--theme-amber-text)', marginTop: 2 }}>
                              +VAT {(parseFloat(line.rate) * 0.13 * (parseFloat(line.qty) || 1)).toFixed(2)}
                            </div>
                          )}
                        </>
                      )}
                    </td>
                    <td style={{ padding: '6px 8px 6px', verticalAlign: 'middle' }}>
                      <input type="date" aria-label={`Expiry date for ${selItem?.name || 'new line'}`} value={line.expiry_date}
                        onChange={e => updateBillLine(line._key, 'expiry_date', e.target.value)}
                        style={{ background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', padding: '7px 8px', fontSize: 12, color: 'var(--theme-text2)', outline: 'none', width: '100%' }} />
                    </td>
                    <td style={{ padding: '6px 8px 6px', verticalAlign: 'middle' }}>
                      <input type="number" min="0" aria-label={`Shelf life in days for ${selItem?.name || 'new line'}`} value={line.shelf_life} placeholder="Days"
                        onChange={e => updateBillLine(line._key, 'shelf_life', e.target.value)}
                        title="Enter days to auto-fill expiry date"
                        style={{ background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', padding: '7px 8px', fontSize: 12, color: 'var(--theme-text2)', outline: 'none', width: '100%', textAlign: 'right' }} />
                    </td>
                    <td style={{ padding: '6px 0 6px', verticalAlign: 'middle', textAlign: 'right' }}>
                      <button onClick={() => removeBillLine(line._key)} aria-label="Remove line"
                        style={{ background: 'none', border: 'none', color: 'var(--theme-text2)', cursor: 'pointer', fontSize: 18, padding: '10px', lineHeight: 1 }}>×</button>
                    </td>
                  </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Acts on the table above, so it lives under the table — not in the form's action row,
          where it was previously a solid --theme-amber fill competing with Save for the eye. */}
      <button className="btn btn-ghost" onClick={addBillLine} style={{ marginTop: 10 }}>+ Add Item</button>

      <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'flex-end', marginTop: 14, gap: 16 }}>
        {(() => {
          const { taxableBase, nonTaxableBase, subTotal, discount, vatTotal, grandTotal } = calcBillTotals(billLines, billHeader.discount)
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
                  Discount: <span style={{ color: 'var(--theme-red-text)', fontWeight: 600, marginLeft: 8 }}>− NPR {fmt(discount)}</span>
                </div>
              )}
              {vatTotal > 0 && (
                <div style={{ color: 'var(--theme-text3)', marginBottom: 3 }}>
                  VAT (13%): <span style={{ color: 'var(--theme-amber-text)', fontWeight: 600, marginLeft: 8 }}>NPR {fmt(vatTotal)}</span>
                </div>
              )}
              <div style={{ color: 'var(--theme-accent-ink)', fontWeight: 700, fontSize: 14, borderTop: '1px solid var(--theme-border)', paddingTop: 6 }}>
                Grand Total: NPR {fmt(grandTotal)}
              </div>
            </div>
          )
        })()}
      </div>

      {error && <p role="alert" style={{ color: 'var(--theme-red-text)', fontSize: 13, margin: '12px 0 0' }}>{error}</p>}
      {/* Cancel is plain ghost: it carried the red tint + red border DESIGN.md reserves for
          destructive actions, on a fully reversible action on an unsaved form — the same treatment
          Purchases' real "Delete All" uses. And the row is one group at the right edge rather than
          `1fr auto 1fr`, which pushed Cancel and Save to opposite ends of a 1160px modal. */}
      <div className="form-actions" style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8 }}>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={saveBill} disabled={saving}>
          {saving ? 'Saving…' : editingGroupId ? 'Update Bill' : `Save ${billLines.filter(l => l.item_id && parseFloat(l.qty) > 0 && parseFloat(l.rate) > 0).length || ''} Entr${billLines.filter(l => l.item_id && parseFloat(l.qty) > 0 && parseFloat(l.rate) > 0).length === 1 ? 'y' : 'ies'}`}
        </button>
      </div>
    </>
  )
}
