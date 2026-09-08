import { npr2 } from '../../../shared/nepalMoney'
import { useState } from 'react'
import { supabase } from '../../../supabaseClient'
import { bsToAd, formatAd, daysInBsMonth, formatBsDay } from '../../../utils/bsCalendar'
import BsCalendarPicker from '../../../components/BsCalendarPicker'
import Tip from '../../../components/Tip'
import SearchableSelect from '../../../components/SearchableSelect'
import QtyInput from '../../../components/QtyInput'
import FieldError from '../../../components/FieldError'
import ActionError, { asActionError } from '../../../components/ActionError'
import { useConfirm } from '../../../shared/hooks/useConfirm'
import { getCf, calcBillTotals, fmtRate, lineState, PURCHASE_PAYMENT_METHODS } from './purchasesHelpers'

const EMPTY_HEADER = { vendor_id: '', bs_day: '', invoice_ref: '', payment_method: 'Cash', discount: '', vat_inclusive: false }
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
  // The duplicate-bill question (S698). A warning, never a hard stop — some vendors reuse numbers.
  const { ask: askConfirm, confirmEl } = useConfirm()

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
      // The Total box is a DRAFT that back-computes the rate; once any input to that arithmetic
      // moves, the draft no longer describes the row. Qty was missing from this list (S698): type
      // qty 10 + total 1000 → rate 100, then correct qty to 20 — the rate stayed, Amount read 2,000
      // and the Total box still said 1000. Two figures on one row disagreeing, and the one the
      // reader trusts most is the one they typed.
      if (field === 'rate' || field === 'vat_inclusive' || field === 'qty') updated._amtDraft = ''
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

  // Has this vendor's bill number been entered before? Two people keying the same paper bill is
  // the most common real double count, and until S698 the form gave no signal. Same vendor, same
  // reference (case-insensitive), any month, excluding the bill being edited. A read that fails
  // is reported as "could not check", never treated as "no duplicate" — a guard that drops its
  // read passes vacuously (S613).
  async function findDuplicateBill() {
    const ref = billHeader.invoice_ref.trim()
    if (!ref || !billHeader.vendor_id) return null
    const { data, error: dupErr } = await supabase.from('purchase_entries')
      .select('id, bs_day, purchase_group_id, monthly_periods!inner(bs_year, bs_month)')
      .eq('vendor_id', billHeader.vendor_id)
      .ilike('invoice_ref', ref)
      .order('created_at')
      .limit(50)
    if (dupErr) return { error: dupErr }
    const others = (data || []).filter(r => (r.purchase_group_id || r.id) !== editingGroupId)
    if (others.length === 0) return null
    const first = others[0]
    return {
      bills: new Set(others.map(r => r.purchase_group_id || r.id)).size,
      when: `${formatBsDay(first.bs_day, first.monthly_periods?.bs_month)} ${first.monthly_periods?.bs_year || ''}`.trim(),
    }
  }

  async function saveBill() {
    const maxDay = period ? daysInBsMonth(period.bs_year, period.bs_month) : 32
    if (!billHeader.bs_day || billHeader.bs_day < 1 || billHeader.bs_day > maxDay) {
      setDayErr(`Enter a valid BS day (1–${maxDay}).`); return
    }
    setDayErr('')

    // Refuse an incomplete row by name rather than dropping it. The old filter silently left out
    // any row missing a price — so a bill saved with fewer lines than the reader had typed, and
    // the only hint was the count on the Save button.
    const incomplete = billLines
      .map((l, idx) => ({ l, idx, state: lineState(l) }))
      .filter(x => x.state === 'incomplete')
    if (incomplete.length > 0) {
      const names = incomplete.map(({ l, idx }) => {
        const item = items.find(i => i.id === l.item_id)
        return item ? `"${item.name}"` : `row ${idx + 1}`
      })
      setError(`${names.join(', ')} ${incomplete.length === 1 ? 'is' : 'are'} missing an item or a quantity above 0. Fill ${incomplete.length === 1 ? 'it' : 'them'} in, or remove the row with ×. A rate of 0 is fine — that is a free line.`)
      return
    }
    const valid = billLines.filter(l => lineState(l) === 'complete')
    if (valid.length === 0) { setError('Add at least one item with a quantity.'); return }

    // An edit with nothing to supersede is a contradiction, and the one that would duplicate the
    // bill. Refuse — the page only renders this form for an edit once it has loaded the bill's
    // rows, so reaching here means something is wrong.
    if (editingGroupId && (editingEntries || []).length === 0) {
      setError('This bill could not be re-read, so it was not saved. Reopen it from the list and try again.')
      return
    }

    setError('')
    setSaving(true)
    const dup = await findDuplicateBill()
    setSaving(false)
    if (dup?.error) {
      const { text } = asActionError(dup.error)
      askConfirm({
        title: 'Could not check for a duplicate bill',
        body: <p style={{ margin: 0 }}>Crest could not check whether this vendor already has bill #{billHeader.invoice_ref.trim()} on record ({text}). Save it anyway?</p>,
        confirmLabel: 'Save anyway', busyLabel: 'Saving…',
        run: () => commitBill(valid),
      })
      return
    }
    if (dup) {
      const vendor = vendors.find(v => v.id === billHeader.vendor_id)
      askConfirm({
        title: 'This bill number is already on record',
        body: (
          <p style={{ margin: 0 }}>
            <strong>{vendor?.name || 'This vendor'}</strong> already has bill <strong>#{billHeader.invoice_ref.trim()}</strong> entered on {dup.when}
            {dup.bills > 1 ? ` (${dup.bills} times)` : ''}. Saving again records the same bill twice, and every purchase figure counts it twice.
            Only save if the vendor genuinely reused the number.
          </p>
        ),
        confirmLabel: 'Save anyway', danger: true, busyLabel: 'Saving…',
        run: () => commitBill(valid),
      })
      return
    }
    await commitBill(valid)
  }

  // The write. ONE transaction since S698: `save_purchase_bill` deletes the superseded lines and
  // inserts the replacements inside a single statement, so an edit can no longer leave the bill
  // holding both versions (the S648 double-count) — either the whole replacement lands or none of
  // it does. The RPC also refuses a bill with vendor payments recorded against it, because those
  // payments cascade off the lines it would delete; that refusal reaches here as an error the
  // errorText table knows how to word.
  async function commitBill(valid) {
    setSaving(true); setError('')

    const discountAmt = parseFloat(billHeader.discount) || 0
    const lines = valid.map(l => {
      const item = items.find(i => i.id === l.item_id)
      const cf = getCf(item)
      const exVatRate = parseFloat(l.rate) || 0  // entered rate is always ex-VAT (NetRate on bill); 0 = free line
      return {
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

    // A bill's entry time has to survive its own corrections (S670). The save replaces every
    // line, so without carrying the stamp forward each edit would restamp created_at to now():
    // the Purchases list (ordered bs_day, created_at, id) would jump the bill to the end of its
    // day, and the "Entered" time on screen would become the moment of the last typo fix.
    //
    // The earliest superseded row wins — that is when this bill entered the book. Lines ADDED
    // during the edit inherit it too, which is the intent: there is no old-line/new-line
    // distinction to preserve, and a per-line stamp would make the bill's displayed time depend on
    // which line happened to sort first. The raw string is carried through rather than a
    // re-serialised Date, so Postgres' own microsecond precision survives. NULL on a new bill lets
    // DEFAULT now() fire.
    const supersededIds = editingGroupId ? (editingEntries || []).map(e => e.id) : []
    const billCreatedAt = editingGroupId
      ? (editingEntries || [])
          .map(e => e.created_at)
          .filter(Boolean)
          .reduce((a, b) => (a && +new Date(a) <= +new Date(b) ? a : b), null)
      : null

    // The superseded ids are the rows this form was opened on — never `purchase_group_id =
    // editingGroupId`. That predicate silently missed the LEGACY case (purchase_group_id IS NULL,
    // keyed by the row's own id) and duplicated the bill until S648. The RPC deletes exactly these
    // ids and asserts the count, so a line someone else removed since the bill was opened is
    // reported rather than silently replaced.
    const { data: savedCreatedAt, error: rpcErr } = await supabase.rpc('save_purchase_bill', {
      p_period_id:      period.id,
      p_group_id:       editingGroupId || crypto.randomUUID(),
      p_lines:          lines,
      p_superseded_ids: supersededIds.length > 0 ? supersededIds : null,
      p_created_at:     billCreatedAt || null,
    })
    if (rpcErr) {
      const { text, detail } = asActionError(rpcErr)
      // No claim that nothing landed: a dead connection does not prove that (error-messages rule).
      // On an edit the honest next step is to look, since a retry over a committed replacement
      // is refused by the RPC's own stale check rather than duplicated.
      setError({
        text: editingGroupId
          ? `${text}\n\nReopen this bill from the list to see what it holds before trying again.`
          : text,
        detail,
      })
      setSaving(false); return
    }

    setSaving(false)
    onSaved(billHeader, valid, savedCreatedAt || null)
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
            {/* An archived/inactive vendor stays on the bill that names it. The picker lists active
                vendors only, so before S698 a bill whose vendor had since been archived rendered
                "— None —" here while state still held the id: save untouched kept the vendor,
                touch the dropdown and it was gone with no way back. The page appends the bill's
                own vendor when it is missing, flagged so it is not mistaken for a live choice. */}
            {vendors.map(v => <option key={v.id} value={v.id}>{v.name}{v._inactive ? ' (inactive)' : ''}</option>)}
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
            // Track: amber when any line carries VAT, slate (text3) when none — NOT the border
            // token, which is the card's own edge colour and left a white knob on it at ~1.2:1.
            // The state label is TEXT and takes the amber-text variant / fog; coloured with the
            // track token it measured 1.44:1 on Light and 1.27:1 on Dark in the "No VAT" state (S682).
            const knobBg = someVat ? 'var(--theme-amber)' : 'var(--theme-text3)'
            const labelColor = someVat ? 'var(--theme-amber-text)' : 'var(--theme-text2)'
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
                  <div style={{ position: 'absolute', top: 3, left: allVat ? 17 : someVat ? 11 : 3, width: 12, height: 12, borderRadius: 0, background: 'var(--theme-card)', transition: 'left 0.2s' }} />
                </div>
                <span style={{ fontSize: 13, fontWeight: someVat ? 700 : 400, color: labelColor, letterSpacing: '0.04em' }}>
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
            {PURCHASE_PAYMENT_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
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
                <Tip text="Ex-VAT price for ONE of whatever the Qty column is counting — the base unit (GM, PCS…), or the purchase unit where the item has a conversion set. Item Master's price for that same unit is shown under each box. Leave it 0 for free goods (buy 10 get 1 free): stock goes up, spend does not. Check the VAT box on each line for items attracting 13% VAT." width={300}>Rate (NPR)</Tip>
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
                      {cf > 1 && line.qty && <div style={{ fontSize: 10, color: 'var(--theme-text3)', textAlign: 'right', marginTop: 2 }}>= {(parseFloat(line.qty) * cf).toLocaleString('en-IN')} {selItem?.uom}</div>}
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
                            {lineAmount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
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
          const fmt = npr2
          const itemCount = billLines.filter(l => lineState(l) === 'complete').length
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

      <ActionError error={error} />
      {/* Cancel is plain ghost: it carried the red tint + red border DESIGN.md reserves for
          destructive actions, on a fully reversible action on an unsaved form — the same treatment
          Purchases' real "Delete All" uses. And the row is one group at the right edge rather than
          `1fr auto 1fr`, which pushed Cancel and Save to opposite ends of a 1160px modal. */}
      <div className="form-actions" style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8 }}>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={saveBill} disabled={saving}>
          {(() => {
            if (saving) return 'Saving…'
            if (editingGroupId) return 'Update Bill'
            const n = billLines.filter(l => lineState(l) === 'complete').length
            return `Save ${n || ''} Entr${n === 1 ? 'y' : 'ies'}`
          })()}
        </button>
      </div>
      {confirmEl}
    </>
  )
}
