import { npr2 } from '../../../shared/nepalMoney'
import { useEffect, useRef, useState } from 'react'
import { supabase } from '../../../supabaseClient'
import { bsToAd, formatAd, daysInBsMonth, formatBsDay } from '../../../utils/bsCalendar'
import BsCalendarPicker from '../../../components/BsCalendarPicker'
import Tip from '../../../components/Tip'
import SearchableSelect from '../../../components/SearchableSelect'
import QtyInput from '../../../components/QtyInput'
import FieldError, { fieldAria } from '../../../components/FieldError'
import { invalidStyle } from '../../../shared/inlineFieldState'
import ActionError, { asActionError } from '../../../components/ActionError'
import { useConfirm } from '../../../shared/hooks/useConfirm'
import { nepalTime, nepalBsLong } from '../../../shared/nepalTime'
import {
  getCf, calcBillTotals, billDiscountError, fmtRate, lineState, PURCHASE_PAYMENT_METHODS,
  parseInvoiceAmount, invoiceAmountError, invoiceMismatch, invoiceMismatchText,
} from './purchasesHelpers'
import {
  billDraftId, billDraftSignature, readBillDraft, saveBillDraft, clearBillDraft,
} from './purchaseBillDraft'

const EMPTY_HEADER = { vendor_id: '', bs_day: '', invoice_ref: '', payment_method: 'Cash', discount: '', vat_inclusive: false, invoice_vat: '', invoice_total: '' }
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
    // S756 (D13): blank when the bill was saved without them — never '0', which is a real figure.
    invoice_vat: first.invoice_vat_amount == null ? '' : String(first.invoice_vat_amount),
    invoice_total: first.invoice_total_amount == null ? '' : String(first.invoice_total_amount),
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
  // The bill as it was OPENED. `initial` above is rebuilt on every render and only its first value
  // ever reaches useState, so the baseline a draft is measured against — and the state "discard
  // the restored draft" goes back to — is captured once, here.
  const pristineRef = useRef(null)
  if (pristineRef.current === null) {
    pristineRef.current = { ...initial, signature: billDraftSignature(initial.header, initial.lines) }
  }

  // S779 — what the reader had typed when the page last died. See purchaseBillDraft.js for why a
  // page dies with a bill in it (a Chrome auto-update restart, a backgrounded tab discarded, a
  // deploy-triggered chunk reload) and why localStorage rather than session or server state.
  // Read once, in a useState initialiser, so the restored bill is the form's FIRST render: seeding
  // it in an effect would mount the blank form, then replace it, and a keystroke landing in that
  // gap would be typed into state that is about to be thrown away.
  const draftId = billDraftId({ groupId: editingGroupId, periodId: period?.id })
  const [restoredDraft] = useState(() => readBillDraft(draftId))
  const [billHeader, setBillHeader] = useState(() => ({ ...initial.header, ...(restoredDraft?.header || {}) }))
  const [billLines, setBillLines]   = useState(() => (
    // Merged over a fresh line so a draft written by an older build, before a field existed, comes
    // back with that field defined rather than undefined in a controlled input. The stored `_key`
    // wins where there is one.
    restoredDraft ? restoredDraft.lines.map(l => ({ ...newLine(), ...l })) : initial.lines
  ))
  const [draftRestoredAt, setDraftRestoredAt] = useState(() => restoredDraft?.savedAt || null)
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState('')
  // Per-field validation. `error` above stays the form-level channel — a rejected write, and the
  // "add at least one line" rule, which belongs to the line table rather than any one box (S603).
  const [dayErr, setDayErr] = useState('')
  const [discountErr, setDiscountErr] = useState('')
  const [invoiceVatErr, setInvoiceVatErr] = useState('')
  const [invoiceTotalErr, setInvoiceTotalErr] = useState('')
  // A bill that has SAVED stays unsaveable for the rest of this form's life (S756). The page still
  // has work to do after the RPC returns — print the voucher, read Item Master for rate changes —
  // before it navigates away, and `setSaving(false)` used to run BEFORE onSaved: for that whole
  // window Save was live again, and a second click minted a fresh crypto.randomUUID() group and
  // wrote the bill twice. Every exit from a successful save is a navigation, so nothing needs the
  // button back. The ref is the guard that does not wait for a render: two clicks inside one frame
  // both see `saving === false` in state.
  const [saved, setSaved] = useState(false)
  const committingRef = useRef(false)
  // The duplicate-bill question (S698). A warning, never a hard stop — some vendors reuse numbers.
  const { ask: askConfirm, confirmEl } = useConfirm()

  // Mirror the bill to localStorage as it is typed (S779). Two triggers, because they cover
  // different deaths: a 400ms debounce catches the ordinary case at typing speed without writing
  // per keystroke, and visibilitychange/pagehide write NOW — hidden is the last event a page is
  // guaranteed to see before the OS discards it or the browser restarts itself, and the debounce
  // would not have fired for whatever was typed in the last fraction of a second.
  //
  // `saved` stops it dead: once the bill is committed the draft is cleared, and a straggling write
  // would put it straight back for the next reader of this period to be offered.
  useEffect(() => {
    if (!draftId || saved) return undefined
    const flush = () => saveBillDraft(draftId, {
      header: billHeader, lines: billLines, baseSignature: pristineRef.current.signature,
    })
    const onVisibility = () => { if (document.visibilityState === 'hidden') flush() }
    const t = setTimeout(flush, 400)
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', flush)
    return () => {
      clearTimeout(t)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', flush)
    }
  }, [draftId, billHeader, billLines, saved])

  // Throw the restored draft away and go back to the bill as it was opened — blank for a new bill,
  // the saved lines for an edit.
  function discardRestoredDraft() {
    setBillHeader(pristineRef.current.header)
    setBillLines(pristineRef.current.lines)
    setDraftRestoredAt(null)
    clearBillDraft(draftId)
  }

  // Cancel has always thrown the typing away — that is what it means. It must therefore also throw
  // the draft away, or the next visit to this bill would offer back the very bill just abandoned.
  function cancelBill() {
    clearBillDraft(draftId)
    onClose()
  }

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

  // S765 — the keyboard path through the highest-frequency form in the product.
  //
  // This file had ZERO onKeyDown, zero autoFocus and zero refs. "+ Add Item" was reachable only by
  // tabbing past every field of every existing line (or by mouse), nothing focused the new row, and
  // nothing committed a row on Enter — so a bookkeeper entering a 15-line supplier bill off paper
  // crossed ~135 tab stops, and adding line 16 meant traversing all of them again.
  //
  // Focus moves on the NEXT frame because the row does not exist in the DOM until React has
  // committed the state update that creates it.
  function addBillLine() {
    const line = newLine()
    setBillLines(prev => [...prev, line])
    requestAnimationFrame(() => document.getElementById(`bill-item-${line._key}`)?.focus())
  }

  // Enter on the row's LAST field (Days) means "this line is done" — add the next one and put the
  // cursor in its item picker. Shift+Enter is left alone so it can never fight a form submit.
  function lineKeyDown(e) {
    if (e.key !== 'Enter' || e.shiftKey) return
    e.preventDefault()
    addBillLine()
  }
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
    if (saved || committingRef.current) return
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

    // 0 ≤ discount ≤ the goods it comes off (S756). The box is `type="number" min="0"` outside any
    // <form>, so the browser enforced neither bound and a negative, or oversized, discount saved a
    // grand total below zero. Measured over the lines that will actually SAVE, which is what
    // calcBillTotals prices once it lands. A CHECK on the table is being added separately; this is
    // the sentence under the box.
    const discountMsg = billDiscountError(billHeader.discount, calcBillTotals(valid, 0).subTotal)
    if (discountMsg) { setDiscountErr(discountMsg); return }
    setDiscountErr('')

    // The supplier's printed figures (S756, D13) are optional and a mismatch never stops a save —
    // but a figure that is not a number, or is negative, is refused by name rather than saved as a
    // guess (the table's CHECK would refuse a negative anyway, with a far worse sentence).
    const vatMsg = invoiceAmountError(billHeader.invoice_vat, "VAT on the supplier's invoice")
    const totalMsg = invoiceAmountError(billHeader.invoice_total, 'invoice total')
    setInvoiceVatErr(vatMsg); setInvoiceTotalErr(totalMsg)
    if (vatMsg || totalMsg) return

    // An edit with nothing to supersede is a contradiction, and the one that would duplicate the
    // bill. Refuse — the page only renders this form for an edit once it has loaded the bill's
    // rows, so reaching here means something is wrong.
    if (editingGroupId && (editingEntries || []).length === 0) {
      setError('This bill could not be re-read, so it was not saved. Reopen it from the list and try again.')
      return
    }

    setError('')
    setSaving(true)
    // Held for the duplicate check too: a second click while it is in flight would otherwise run
    // its own check and, finding nothing, commit alongside the first.
    committingRef.current = true
    const dup = await findDuplicateBill()
    committingRef.current = false
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
    // Reached from Save directly AND from the duplicate-bill dialog's run(); both go through here.
    if (saved || committingRef.current) return
    committingRef.current = true
    setSaving(true); setError('')

    const discountAmt = parseFloat(billHeader.discount) || 0
    // Bill-level, repeated on every line like the discount. null (not 0) when the box is blank:
    // "not typed" and "the bill prints no VAT" are different facts (S756, D13).
    const invoiceVat = parseInvoiceAmount(billHeader.invoice_vat)
    const invoiceTotal = parseInvoiceAmount(billHeader.invoice_total)
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
        invoice_vat_amount:   invoiceVat,
        invoice_total_amount: invoiceTotal,
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
      committingRef.current = false
      setSaving(false); return
    }

    // The bill is committed. Saving stays on, and `saved` keeps Save disabled, through onSaved and
    // the navigation it ends in (S756 — see `saved` above). Only a throw from onSaved hands the
    // form back, and then with a sentence that does not invite a second save: the first one landed.
    // The kept draft goes first (S779): it exists only to survive a page that dies with an UNSAVED
    // bill in it, and this bill is now on the server. Cleared before onSaved, which navigates.
    clearBillDraft(draftId)
    setSaved(true)
    try {
      await onSaved(billHeader, valid, savedCreatedAt || null)
    } catch (err) {
      const { text, detail } = asActionError(err)
      setError({ text: `The bill is saved. What follows a save (the printed voucher, the Item Master rate check) did not finish — do not save it again; go back to Purchases to see it. ${text}`, detail })
    } finally {
      setSaving(false)
    }
  }

  // No QuickCalculator here any more. The form carried its own second instance plus a header
  // button only because the Modal around it ran a document keydown listener that ate Escape
  // before the calculator saw it (see the comment in Calculator.js). On a route there is no such
  // listener, so Layout.js's global Alt+C calculator — which was always mounted underneath —
  // simply works, and a duplicate would now be two calculators on one screen.
  return (
    <>
      {/* What came back (S779). Never silent: the reader left this page expecting to have lost the
          bill, so an unannounced set of lines on screen is a bill they did not knowingly type. It
          states plainly that nothing is recorded yet, and offers the other answer — start clean —
          rather than making them empty the rows by hand. */}
      {draftRestoredAt && (
        <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 18, padding: '10px 14px', fontSize: 12, lineHeight: 1.55, color: 'var(--theme-text2)', border: '1px solid color-mix(in srgb, var(--theme-amber) 35%, transparent)', background: 'color-mix(in srgb, var(--theme-amber) 8%, transparent)', borderRadius: 'var(--radius-sm)' }}>
          <span style={{ flex: '1 1 340px' }}>
            <strong style={{ color: 'var(--theme-amber-text)' }}>↺ Brought back what you were typing.</strong>{' '}
            This bill was still unsaved when the page closed on {nepalBsLong(draftRestoredAt)}, {nepalTime(draftRestoredAt)}.
            Nothing has been recorded yet — check it over and Save.
          </span>
          <button className="btn btn-ghost" onClick={discardRestoredDraft} style={{ flex: '0 0 auto' }}>
            {editingGroupId ? 'Discard these changes' : 'Start a blank bill'}
          </button>
        </div>
      )}

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
            onChange={e => { setDiscountErr(''); setBillHeader(h => ({ ...h, discount: e.target.value })) }}
            placeholder="0"
            {...fieldAria('purcha-f3', discountErr)}
            style={invalidStyle({ background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', padding: '7px 10px', fontSize: 13, color: 'var(--theme-red-text)', outline: 'none', width: '90px', textAlign: 'right' }, discountErr)} />
        </div>
        <div className="form-field">
          <label htmlFor="purcha-f4"><Tip text="Cash: paid on delivery. Credit: pay later. FonePay: digital payment. Applied to all items on this bill.">Payment</Tip></label>
          <select id="purcha-f4" className="form-select" style={{ fontSize: 13 }} value={billHeader.payment_method} onChange={e => setBillHeader(h => ({ ...h, payment_method: e.target.value }))}>
            {PURCHASE_PAYMENT_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
      </div>
      {/* The discount's message sits under the whole header row rather than inside its 90px
          column, where a sentence would stand ten lines tall and push the row's bottom-aligned
          neighbours out of line. Same control id, so the box's aria-describedby still resolves. */}
      {discountErr && <div style={{ marginTop: -12, marginBottom: 14 }}><FieldError id="purcha-f3" message={discountErr} /></div>}

      <div style={{ borderTop: '1px solid var(--theme-border)', marginBottom: 16 }} />

      {/* Line items table — mirrors a vendor bill: Item | Qty | Rate | Total | VAT | Amount */}
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
              {/* Total then VAT then Amount (S779, owner's call). The tick used to sit between Rate
                  and Total, which split the two boxes that hold the same fact — the rate per unit
                  and the line's money — and put a checkbox in the tab path between them. It now
                  sits where it is read: after the figure taken off the bill, before the Amount it
                  changes, so ticking it and watching Amount move is one glance left to right. */}
              <th style={{ textAlign: 'right', fontSize: 11, color: 'var(--theme-text2)', padding: '0 8px 10px', textTransform: 'uppercase', letterSpacing: '0.07em', width: 105 }}>
                <Tip text="Enter total paid for this line — Rate is back-calculated automatically." width={230}>Total (NPR)</Tip>
              </th>
              <th style={{ textAlign: 'center', fontSize: 11, color: 'var(--theme-text2)', padding: '0 4px 10px', textTransform: 'uppercase', letterSpacing: '0.07em', width: 40 }}>
                <Tip text="Check to apply 13% VAT to this line item only." width={210}>VAT</Tip>
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
                        id={`bill-item-${line._key}`}
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
                    <td style={{ padding: '6px 4px 4px', verticalAlign: 'middle', textAlign: 'center' }}>
                      <input
                        type="checkbox"
                        aria-label={`VAT-inclusive line for ${selItem?.name || 'new line'}`}
                        checked={line.vat_inclusive}
                        onChange={() => updateBillLine(line._key, 'vat_inclusive', !line.vat_inclusive)}
                        style={{ cursor: 'pointer', width: 15, height: 15, accentColor: 'var(--theme-amber)' }}
                      />
                      {/* 10px, not 9: 9 is the chevron GLYPH step on the type ramp and 10 is the
                          floor for real text (DESIGN.md → Typography). This is a live VAT marker
                          on a money row, not a decorative caret. */}
                      {line.vat_inclusive && <div style={{ fontSize: 10, color: 'var(--theme-amber-text)', marginTop: 2, fontWeight: 700 }}>13%</div>}
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
                        onKeyDown={lineKeyDown}
                        title="Enter days to auto-fill expiry date. Press Enter to start the next line."
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

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginTop: 14, gap: 16, flexWrap: 'wrap' }}>
        {/* The supplier's own printed figures (S756, owner decision D13). Optional, and never a
            block: a difference is shown here, beside the figures it is compared with, so the reader
            can find the mis-keyed line before saving — and saves anyway if the paper is what's wrong.
            Text inputs with inputMode="decimal" rather than type="number", so "9,702.00" typed the
            way the bill prints it is read as a number instead of silently emptied by the browser. */}
        {(() => {
          const totals = calcBillTotals(billLines, billHeader.discount)
          const invoiceVat = parseInvoiceAmount(billHeader.invoice_vat)
          const invoiceTotal = parseInvoiceAmount(billHeader.invoice_total)
          const usable = n => (n === null || Number.isNaN(n) || n < 0 ? null : n)
          const check = totals.subTotal > 0
            ? invoiceMismatch({ invoiceVat: usable(invoiceVat), invoiceTotal: usable(invoiceTotal) }, totals)
            : { checked: false, mismatch: false }
          const inputStyle = { background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', padding: '7px 10px', fontSize: 13, color: 'var(--theme-text1)', outline: 'none', width: 130, textAlign: 'right' }
          return (
            <div style={{ maxWidth: 480, flex: '1 1 320px' }}>
              <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>
                <Tip text="Optional. Copy these two figures straight off the supplier's paper bill and Crest checks them against the lines you entered. If they differ by more than NPR 1 you'll see why before you save — usually a rate typed in the wrong unit, a missed line, or VAT ticked on the wrong item. Leave both blank to skip the check." width={320}>As printed on the supplier's bill</Tip>
                <span style={{ textTransform: 'none', letterSpacing: 0, marginLeft: 6, color: 'var(--theme-text3)' }}>(optional)</span>
              </div>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <div className="form-field" style={{ marginBottom: 0 }}>
                  <label htmlFor="purcha-inv-vat"><Tip text="The VAT amount exactly as the supplier's bill prints it. Type 0 if the bill shows no VAT; leave blank if you don't want this checked." width={260}>VAT on supplier's invoice</Tip></label>
                  <input id="purcha-inv-vat" type="text" inputMode="decimal" autoComplete="off"
                    value={billHeader.invoice_vat}
                    onChange={e => { setInvoiceVatErr(''); setBillHeader(h => ({ ...h, invoice_vat: e.target.value })) }}
                    placeholder="e.g. 702.00"
                    {...fieldAria('purcha-inv-vat', invoiceVatErr)}
                    style={invalidStyle(inputStyle, invoiceVatErr)} />
                </div>
                <div className="form-field" style={{ marginBottom: 0 }}>
                  <label htmlFor="purcha-inv-total"><Tip text="The final amount the supplier's bill asks for — after its discount and including VAT. Leave blank if you don't want this checked." width={260}>Invoice total</Tip></label>
                  <input id="purcha-inv-total" type="text" inputMode="decimal" autoComplete="off"
                    value={billHeader.invoice_total}
                    onChange={e => { setInvoiceTotalErr(''); setBillHeader(h => ({ ...h, invoice_total: e.target.value })) }}
                    placeholder="e.g. 9,702.00"
                    {...fieldAria('purcha-inv-total', invoiceTotalErr)}
                    style={invalidStyle(inputStyle, invoiceTotalErr)} />
                </div>
              </div>
              <FieldError id="purcha-inv-vat" message={invoiceVatErr} />
              <FieldError id="purcha-inv-total" message={invoiceTotalErr} />
              {check.mismatch && (
                <div role="status" style={{ marginTop: 8, padding: '8px 12px', fontSize: 12, lineHeight: 1.5, color: 'var(--theme-text2)', border: '1px solid color-mix(in srgb, var(--theme-amber) 35%, transparent)', background: 'color-mix(in srgb, var(--theme-amber) 8%, transparent)', borderRadius: 'var(--radius-sm)' }}>
                  <strong style={{ color: 'var(--theme-amber-text)' }}>△ Doesn't match the supplier's bill.</strong>{' '}
                  {invoiceMismatchText(check, { crestVat: totals.vatTotal, crestTotal: totals.grandTotal, invoiceVat, invoiceTotal })}
                  {' '}Check each line's rate and unit, the VAT ticks and the discount. You can still save — the difference will show as a flag on the Purchases list and the VAT Report.
                </div>
              )}
              {check.checked && !check.mismatch && (
                <div style={{ marginTop: 6, fontSize: 12, color: 'var(--theme-green-text)' }}>✓ Matches the supplier's bill (within NPR 1).</div>
              )}
            </div>
          )
        })()}
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
        <button className="btn btn-ghost" onClick={cancelBill}>Cancel</button>
        <button className="btn btn-primary" onClick={saveBill} disabled={saving || saved} aria-busy={saving || undefined}>
          {(() => {
            if (saved) return 'Saved'
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
