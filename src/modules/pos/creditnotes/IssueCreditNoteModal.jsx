import { npr } from '../../../shared/nepalMoney'
import { useState, useEffect } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { supabase } from '../../../supabaseClient'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { getBsFiscalYear, adToBsSafe, BS_MONTHS } from '../../../utils/bsCalendar'
import { nepalBs } from '../../../shared/nepalTime'
import { computeOrderAmounts, billVatRegistered } from '../../../utils/posBillingMath'
import { printCreditNote } from './creditNoteHtml'
import Modal from '../../../components/Modal'
import Tip from '../../../components/Tip'
import ReportLoadError from '../../../components/ReportLoadError'
import { errorLine, errorText, isNetworkError } from '../../../shared/errorText'
import { postCreditNoteToIms } from './creditNotePosting'
import { withTimeout, settleWithin, isTimeout } from '../../../utils/withTimeout'

// "Was money returned to the customer?" (S754, owner decision). Asked on every note, because a
// Credit Note corrects the VAT register and says nothing about the drawer: a cash refund handed
// over the counter with no record reads as a shortfall at the shift close, which is exactly the
// variance the Z-report exists to explain. Cash writes a pos_cash_movements refund on the open
// shift; Other and None store nothing in cash. The answer is stored in pos_credit_notes.refund_method
// (S755) and shown in the Credit Note Book — never on the printed note: it used to be appended to
// the reason, which printed on the statutory document as if it were the reason.
const REFUND_OPTIONS = [
  { value: 'cash',  label: 'Cash',  hint: 'Paid out of the till — recorded as a Refund on the open shift, so the drawer count expects it.' },
  { value: 'other', label: 'Other (card, QR, bank)', hint: 'Returned outside the till. Nothing is taken off the drawer count.' },
  { value: 'none',  label: 'None',  hint: 'No money went back — e.g. the bill is billed again to the right customer, or it is a Credit bill nobody has paid yet.' },
]

// "Was the food on this bill served?" (S809 2e, owner decision Q10 a). Every bill counts its dishes as
// used in Inventory. When a bill is cancelled because it is billed again on a new bill, or because it
// was a duplicate, the same food would be counted twice — so "No" puts it back
// (pos_credit_notes.restock; creditNotePosting.js). Asked only where Inventory is on.
const FOOD_OPTIONS = [
  { value: 'served',     label: 'Yes — the guest had it',
    hint: 'Inventory keeps this food as used. Right for money back on food that was eaten, sent back or taken away.' },
  { value: 'not_served', label: 'No — billed again on a new bill, or a duplicate',
    hint: "This food goes back into this month's Inventory, so it is not counted twice (once here and once on the other bill)." },
]

// A credit note here always credits the WHOLE bill (decision 2026-08-18 — partial credits are not
// supported). 'Price correction' and 'Billing error' were removed from these chips because both
// describe a partial adjustment: offering them invited staff to reach for a credit note to fix one
// wrong line and silently credit the entire invoice instead. The remaining three are all
// whole-bill situations by nature.
const REASON_CHIPS = ['Wrong customer', 'Tax correction', 'Duplicate bill']

const fmtNpr = npr

function invoiceLabel(order, vatReg, prefix) {
  return `${vatReg ? 'TI' : 'PB'}${order.invoice_no}-${prefix}${prefix ? '-' : ''}${order.invoice_fy || ''}`
}

// Shared by two entry points — the Recent Bills "Credit Note" quick action (same-day) and the
// standalone /pos/credit-notes "Issue New" search (any date). Self-contained: fetches its own
// settings/outlet/HSC data rather than depending on the caller's cached state, so it works
// identically from either page.
export default function IssueCreditNoteModal({ order, onClose, onIssued }) {
  const { clientId, profile, hasPosAccess, imsEnabled } = useAuth()
  const { scopedFrom, scopedInsert, scopedUpdate } = useScopedDb()

  const [items, setItems] = useState([])
  const [settings, setSettings] = useState({ is_vat_registered: true, invoice_prefix: '', vat_number: '', property_address: '', property_phone: '' })
  // The bill's own tax-status stamp (S809 2c), read here rather than taken from the caller's row so
  // neither entry point can leave it out.
  const [billStamp, setBillStamp] = useState(null)
  const [outletName, setOutletName] = useState('')
  const [hscMap, setHscMap] = useState({})
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)

  const [reason, setReason] = useState('')
  const [buyerName, setBuyerName] = useState(order.buyer_name || '')
  const [buyerAddress, setBuyerAddress] = useState(order.buyer_address || '')
  const [buyerPan, setBuyerPan] = useState(order.buyer_pan || '')
  const [buyerPhone, setBuyerPhone] = useState(order.buyer_phone || '')
  const [submitting, setSubmitting] = useState(false)
  const [msg, setMsg] = useState('')
  // Set when the note issued but its Inventory reversal could not post (S747).
  const [imsNotice, setImsNotice] = useState(null)
  // S754: how money went back, and the shift a cash refund lands on. `shift` is undefined until
  // read, null when no shift is open; `shiftError` a read that failed (which is not "none open").
  const [refundMode, setRefundMode] = useState('')
  const [refundShift, setRefundShift] = useState({ loading: false, shift: undefined, error: null })
  // S809 2e: the answer to "Was the food on this bill served?" ('served' | 'not_served').
  const [foodAnswer, setFoodAnswer] = useState('')
  // S809 2e (SHIFTS-3): the cash this bill brought into the drawer — the server's own figure
  // (pos_bill_cash_taken), the same one the note's refund is recorded with.
  const [cashTaken, setCashTaken] = useState(null)

  async function readOpenShift() {
    const { data, error } = await settleWithin(
      scopedFrom('pos_shifts', 'id, label, opened_at').eq('status', 'open').maybeSingle(), 15000, 'Checking for an open shift')
    return { shift: error ? undefined : (data || null), error: error || null }
  }

  // Read as soon as Cash is picked, so "open a shift first" is said BEFORE Issue — not after a
  // permanent, numbered note already exists with nowhere to put its refund.
  useEffect(() => {
    if (refundMode !== 'cash' || !clientId) return
    let cancelled = false
    setRefundShift({ loading: true, shift: undefined, error: null })
    readOpenShift().then(r => { if (!cancelled) setRefundShift({ loading: false, ...r }) })
    return () => { cancelled = true }
  }, [refundMode, clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  // S809 2e (SHIFTS-3): how much of this bill came into the drawer in cash, as the server works it out
  // (pos_bill_cash_taken — the figure the note's refund is recorded with). A read of its own, beside
  // the bill's load below. A failed read stops the note like any failed load: the refund is unknown.
  useEffect(() => {
    if (!clientId) return
    let cancelled = false
    settleWithin(supabase.rpc('pos_bill_cash_taken', { p_order_id: order.id }), 20000, 'Reading the cash on this bill')
      .then(({ data, error }) => {
        if (cancelled) return
        if (error) { setLoadError(error); setLoading(false); return }
        setCashTaken(Number(data) || 0)
      })
    return () => { cancelled = true }
  }, [clientId, order.id])

  useEffect(() => {
    if (!clientId) return
    let cancelled = false
    ;(async () => {
      const results = await Promise.all([
        scopedFrom('pos_order_items', 'recipe_id, name, qty, unit_price, vat_rate, comped, option_summary, pos_order_item_options(option_name, price_delta, ingredient_deltas, sort)').eq('order_id', order.id),
        supabase.from('settings').select('is_vat_registered, invoice_prefix, vat_number, property_address, property_phone').eq('client_id', clientId).maybeSingle(),
        supabase.from('clients').select('name').eq('id', clientId).single(),
        scopedFrom('pos_orders', 'vat_registered').eq('id', order.id).maybeSingle(),
      ])
      if (cancelled) return
      // S754: all three reads dropped `error`. A failed item read computed NPR 0 and still let a
      // permanent, sequentially-numbered note be issued; a failed settings read fell to the
      // `?? true` below and printed a PAN-bill client's note as a VAT Tax Invoice correction.
      const failed = results.find(r => r.error)
      if (failed) { setLoadError(failed.error); setLoading(false); return }
      const [{ data: its }, { data: st }, { data: cl }, { data: billRow }] = results
      // Awaited before Issue is enabled, and checked: it used to land after loading cleared, so a
      // quick Issue (or a failed read) printed a permanent document with every HSC column blank.
      const recipeIds = [...new Set((its || []).map(i => i.recipe_id).filter(Boolean))]
      let hsc = {}
      if (recipeIds.length > 0) {
        const { data: recs, error: hscErr } = await scopedFrom('recipes', 'id, hsc_code').in('id', recipeIds)
        if (cancelled) return
        if (hscErr) { setLoadError(hscErr); setLoading(false); return }
        hsc = Object.fromEntries((recs || []).map(r => [r.id, r.hsc_code]))
      }
      setItems(its || [])
      setSettings({
        is_vat_registered: st?.is_vat_registered ?? true,
        invoice_prefix: st?.invoice_prefix || '',
        vat_number: st?.vat_number || '',
        property_address: st?.property_address || '',
        property_phone: st?.property_phone || '',
      })
      setOutletName(cl?.name || '')
      setBillStamp(billRow || null)
      setHscMap(hsc)
      setLoading(false)
    })().catch(err => { if (!cancelled) { setLoadError(err); setLoading(false) } })
    return () => { cancelled = true }
  }, [clientId, order.id, scopedFrom])

  if (!hasPosAccess('manager')) {
    return (
      <Modal title="Issue Credit Note" onClose={onClose} maxWidth={420}>
        <p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Issuing a Credit Note requires Manager access or above.</p>
      </Modal>
    )
  }

  // S809 2c (CREDIT-NOTES-5): the note is worked out, labelled (TI or PB, stored for good in
  // original_invoice_label) and printed as the bill was issued. A PAN bill credited after the outlet
  // registers stays a PB reference with no VAT; a Tax Invoice credited after it deregisters keeps its
  // VAT, so the note's figures equal the bill's and guard_pos_credit_note accepts it. Today's setting
  // decides only for a bill with no stamp.
  const vatReg = billVatRegistered(billStamp, settings.is_vat_registered)
  // Item-level comps were never billed at menu price (they printed on their own Complimentary
  // Slip — see PosOrders.jsx), so a Credit Note correcting this bill's revenue must exclude them
  // too, or its face value overstates what the party actually paid. The sales_entries reversal
  // below now uses this same payableItems list — a comped item was posted as source='pos_comp',
  // never 'pos', so reversing it too under 'pos_credit' would create a negative entry with no
  // matching positive one to offset, wrongly understating that recipe's revenue.
  const payableItems = items.filter(i => !i.comped)
  const amounts = !loading && !loadError ? computeOrderAmounts(order, payableItems, vatReg) : null
  // S754: a note crediting nothing is still a permanent, numbered document in the VAT register.
  const nothingToCredit = !loading && !loadError && (payableItems.length === 0 || !(amounts?.net > 0))

  // S809 2e (SHIFTS-3): what a Cash refund takes out of the drawer — the cash this bill took, never more
  // than the note. The database records exactly this (pos_credit_note_settle), so the sentence and the
  // drawer cannot disagree. 0 for a card, QR or points bill, and for a Credit bill nobody has paid yet.
  const cashOut = amounts ? Math.min(Number(cashTaken) || 0, amounts.net) : 0
  const askFood = imsEnabled !== false
  // The food goes back in the month the note is issued in, beside its revenue reversal. For a bill
  // billed again now that is right (the new bill uses the food again this month). For a duplicate
  // charged in an earlier month it is not: that month's stock count has already settled its food.
  const billBs = order.closed_at ? nepalBs(new Date(order.closed_at)) : null
  const nowBs = nepalBs(new Date())
  const billFromEarlierMonth = !!(billBs && nowBs && (billBs.year !== nowBs.year || billBs.month !== nowBs.month))

  // The note's side-effects (S754) — the bill marked credited, the cash refund on the open shift and the
  // loyalty reversal — happen in the database, in the same transaction as the note itself (S809 2e,
  // CREDIT-NOTES-2: pos_credit_note_settle). They used to be three more requests from this screen, and a
  // dropped connection after the note landed left the bill "owed", the drawer short and the points
  // unreversed, with nothing that could run them later. What is left here: the print and Inventory.

  async function handleConfirm() {
    if (loading || loadError || !amounts) return
    if (nothingToCredit) { setMsg('error:This bill has no charged lines to credit, so no Credit Note can be issued against it.'); return }
    if (!reason.trim()) { setMsg('error:Enter a reason for this Credit Note.'); return }
    if (askFood && !foodAnswer) { setMsg('error:Say whether the food on this bill was served — Yes or No.'); return }
    if (!refundMode) { setMsg('error:Say whether money was returned to the customer — Cash, Other or None.'); return }
    if (refundMode === 'cash' && !(cashOut > 0)) { setMsg('error:No cash was taken for this bill, so none can go back out of the drawer. Choose Other or None.'); return }
    setSubmitting(true); setMsg('')

    // S754: a cash refund needs an OPEN shift to go on, and that is checked again here rather than
    // trusted from when Cash was picked — the shift can close while the reason is being typed.
    // Refused before anything is written, so "nothing was issued" is true on both branches. (Since
    // S809 2e the database refuses the note too when no shift is open: credit_note_refund_no_shift.)
    if (refundMode === 'cash') {
      const r = await readOpenShift()
      setRefundShift({ loading: false, ...r })
      if (r.error) {
        setMsg('error:Could not check whether a shift is open, so no Credit Note was issued. Try again, or choose Other or None if the money did not come out of the till. ' + errorLine(r.error))
        setSubmitting(false); return
      }
      if (!r.shift) {
        setMsg('error:No shift is open, so a cash refund has nowhere to be recorded and no Credit Note was issued. Open a shift to record a cash refund, or choose Other or None.')
        setSubmitting(false); return
      }
    }

    const bs = adToBsSafe(new Date(order.closed_at))
    const original_invoice_date_bs = bs ? `${bs.day} ${BS_MONTHS[bs.month - 1]} ${bs.year}` : `${String(order.closed_at).slice(0, 10)} (AD)`
    const original_invoice_label = invoiceLabel(order, vatReg, settings.invoice_prefix)
    // The CN's own invoice_fy (which drives its sequential credit_note_no via
    // assign_pos_credit_note_no) is the fiscal year it's actually issued in — matching the
    // revenue-reversal logic below ("the period the correction is discovered in"), not the
    // original bill's period. A CN issued after a fiscal-year rollover would otherwise number
    // itself into that old, already-closed FY's sequence. The original bill stays fully
    // traceable regardless via original_invoice_no/original_invoice_label/original_invoice_date_bs.
    // S809 2b (CREDIT-NOTES-4): Nepal's date, not the tablet's clock and time zone. The database sets
    // the note's year itself (guard_pos_credit_note) and ignores this one; the printed note reads the
    // stored year back (`created`). The Inventory reversal below lands on this Nepal day.
    const today = nepalBs(new Date())
    const issuance_fy = today ? getBsFiscalYear(today.year, today.month) : null

    const payload = {
      order_id: order.id,
      invoice_fy: issuance_fy,
      original_invoice_no: order.invoice_no,
      original_invoice_label,
      original_invoice_date_bs,
      reason: reason.trim(),
      // S755: its own column, off the printed note. The database checks the amounts below against
      // the bill (guard_pos_credit_note, HINT credit_note_amounts) — they are not trusted as sent.
      refund_method: refundMode,
      // S809 2e (Q10 a): the food was not served on this bill, so its stock goes back in Inventory.
      restock: askFood && foodAnswer === 'not_served',
      gross_amount: amounts.grossAmt,
      discount_amount: amounts.discount,
      taxable_amount: amounts.taxableBase,
      non_taxable_amount: amounts.nonTaxableBase,
      vat_amount: amounts.vatAmt,
      net_amount: amounts.net,
      buyer_name: buyerName.trim() || null,
      buyer_address: buyerAddress.trim() || null,
      buyer_pan: buyerPan.trim() || null,
      buyer_phone: buyerPhone.trim() || null,
      issued_by: profile?.id || null,
    }

    // S809 2e (CREDIT-NOTES-2): one request does it all — the note, the bill marked credited, the cash
    // refund and the loyalty reversal land together or not at all (pos_credit_note_settle). Bounded,
    // because a hung request would leave "Issuing…" up for good.
    const { data: created, error } = await settleWithin(scopedInsert('pos_credit_notes', payload, { single: true }), 20000, 'Issuing the Credit Note')
    if (error) {
      // S754. Three different facts, three sentences. credit_note_exists is the guard refusing a
      // second note on this bill (another manager, or a retry after a lost response that did land).
      // A dropped connection (or no answer in time) proves nothing about whether the note was
      // written, so it must not say "nothing has changed"; the guard makes a retry safe, and the
      // Credit Note Book is the place that can tell them. Any other refusal is raised inside the
      // insert's own transaction, which rolled back whole, so it may say so.
      const text = error.hint === 'credit_note_exists' || /credit_note_exists/.test(error.message || '')
        ? `error:${errorText(error, 'operator')} (${[error.code, error.message].filter(Boolean).join(' · ')})`
        : isNetworkError(error) || isTimeout(error)
          ? 'error:The connection dropped, so it is not known whether this Credit Note was issued. Check the Credit Note Book before trying again. If it is there, it is complete — the bill is marked credited, any cash refund is on the shift and any points are reversed — and only its printing is left: press Print on it there. A second note for this bill would be refused. ' + errorLine(error)
          : 'error:The credit note was not issued — nothing has changed. ' + errorLine(error)
      setMsg(text); setSubmitting(false); return
    }

    // S809 2e: printed first, while the press that issued it still counts as the manager's own (a
    // browser blocks a pop-up opened long after the tap) — the bill's order since S776: print, then
    // everything else. It used to wait behind up to eight round trips.

    const print = await printCreditNote(clientId, created, payableItems, settings, outletName, hscMap, vatReg)
    // S754: a blocked pop-up printed nothing, and the modal closed as though it had.
    const printText = print.printed ? ''
      : 'The print window was blocked by the browser, so nothing printed. Allow pop-ups for this site, then print it from Credit Notes → Credit Note Book → Print.'

    // Revenue correction into TODAY's open period (the period the correction is discovered in), not
    // the original bill's. Stock comes back only when the food was not served on this bill (S809 2e,
    // Q10 a); otherwise the food was used and this corrects money and tax only. It used to skip
    // silently with no open period and never read its insert's error (S747); now a note that could
    // not post is stamped "waiting", said so here, counted on the POS floor and posted from Periods.
    let ims
    try {
      ims = await withTimeout(postCreditNoteToIms({ supabase, scopedFrom, scopedInsert, scopedUpdate, note: created, order, items, today }), 30000, 'Posting to Inventory')
    } catch (err) {
      ims = { posted: false, reason: 'write', error: err }
    }

    setSubmitting(false)
    if (ims.posted && print.printed) { onIssued?.(created); return }
    // The note is issued, numbered and printed whatever happens here, so this is a notice with one
    // button, not an error with a retry: Periods' backfill is the retry.
    const month = `${BS_MONTHS[today.month - 1]} ${today.year}`
    setImsNotice({
      created,
      printed: print.printed,
      imsPosted: ims.posted,
      printText,
      text: ims.posted ? '' : ims.reason === 'no_period'
        ? `There is no Inventory period for ${month} yet, so this credit note has not been taken off Inventory sales. Once ${month} is opened in Periods, a manager presses "Post POS bills to Inventory" on it and the note is posted then.`
        : ims.reason === 'closed'
          ? `${month} is closed in Inventory, so this credit note has not been taken off Inventory sales. An admin can post it from Periods with "Post POS bills to Inventory" on ${month}.`
          : ims.reason === 'bill_waiting'
            ? `This bill has not reached Inventory yet, so this credit note waits for it: its food can only go back once the bill's own sale is in. In Periods, press "Post POS bills to Inventory" on the month the bill was charged in, then on ${month}; the note is posted then.`
            : `This credit note could not be taken off Inventory sales just now (the connection or the database refused it). It is marked as waiting — a manager can post it from Periods with "Post POS bills to Inventory" on ${month}.`,
      detail: ims.error ? errorLine(ims.error) : '',
    })
  }

  if (imsNotice) {
    // S809 2e: the refund and the points can no longer be left behind — they land with the note.
    const problems = [
      !imsNotice.printed && 'did not print',
      !imsNotice.imsPosted && 'is not yet in Inventory',
    ].filter(Boolean)
    return (
      <Modal title="Credit Note issued" onClose={() => onIssued?.(imsNotice.created)} maxWidth={480}>
        <div role="alert" style={{
          background: 'color-mix(in srgb, var(--theme-amber) 8%, transparent)',
          border: '1px solid color-mix(in srgb, var(--theme-amber) 35%, transparent)',
          padding: '12px 14px', fontSize: 13, color: 'var(--theme-text2)', marginBottom: 14,
        }}>
          <strong style={{ display: 'block', color: 'var(--theme-amber-text)', marginBottom: 4 }}>
            {problems.length > 0
              ? `⚠ Credit Note ${imsNotice.created?.credit_note_no ?? ''} is valid${imsNotice.printed ? ' and printed' : ''} — but ${problems.join(', and ')}`
              : `✓ Credit Note ${imsNotice.created?.credit_note_no ?? ''} is valid and printed`}
          </strong>
          {imsNotice.printText && <div style={{ marginBottom: imsNotice.text ? 8 : 0 }}>{imsNotice.printText}</div>}
          {imsNotice.text}
          {imsNotice.detail && <div style={{ marginTop: 6, fontSize: 11, color: 'var(--theme-text3)', fontFamily: 'monospace' }}>{imsNotice.detail}</div>}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button className="btn btn-primary" onClick={() => onIssued?.(imsNotice.created)}>Done</button>
        </div>
      </Modal>
    )
  }

  return (
    <Modal title="Issue Credit Note" onClose={onClose} maxWidth={520}>
        <p style={{ margin: '0 0 14px', fontSize: 12, color: 'var(--theme-text3)' }}>
          Corrects {order.invoice_no != null ? invoiceLabel(order, vatReg, settings.invoice_prefix) : `Order #${order.order_no}`}. This is a formal VAT-Rules Credit Note — it reduces revenue for this fiscal month{askFood ? ', and puts the food back into stock only if you say it was not served' : ''}.
        </p>

        {loading ? <p style={{ color: 'var(--theme-text3)', fontSize: 13 }}>Loading bill…</p> : loadError ? (
          <>
            <ReportLoadError error={loadError} />
            <p style={{ fontSize: 12, color: 'var(--theme-text2)', margin: '10px 0' }}>
              No Credit Note can be issued until this bill's lines and the outlet's tax settings have loaded —
              the amount to credit is unknown. Close this and open the bill again.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={onClose}>Close</button>
            </div>
          </>
        ) : (
          <>
            <div className="table-wrap" style={{ maxHeight: 160, overflowY: 'auto', border: '1px solid var(--theme-border)', borderRadius: 0, marginBottom: 12 }}>
              <table className="data-table" style={{ fontSize: 12 }}>
                <thead><tr><th>Item</th><th>Qty</th><th>Amount</th></tr></thead>
                <tbody>
                  {payableItems.map((i, idx) => (
                    <tr key={idx}><td>{i.name}</td><td>{i.qty}</td><td>{fmtNpr(i.qty * i.unit_price)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--theme-accent-ink)', marginBottom: 14 }}>
              Net amount to credit: {fmtNpr(amounts.net)}
            </div>
            {nothingToCredit && (
              <p role="alert" style={{ fontSize: 12, color: 'var(--theme-red-text)', margin: '-6px 0 14px' }}>
                This bill has no charged lines (or every line was complimentary), so there is nothing to credit and no Credit Note can be issued against it.
              </p>
            )}

            <label style={labelStyle} htmlFor="icn-reason">Reason <span style={{ color: 'var(--theme-red-text)' }}>*</span></label>
            <div role="group" aria-label="Common reasons" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
              {REASON_CHIPS.map(r => (
                <button key={r} type="button" className="tab-btn" onClick={() => setReason(r)}
                  style={{ fontSize: 11, padding: '4px 10px' }}>{r}</button>
              ))}
            </div>
            <textarea id="icn-reason" value={reason} onChange={e => setReason(e.target.value)} rows={2}
              placeholder="e.g. Bill raised against the wrong customer"
              style={{ ...inputStyle, width: '100%', resize: 'vertical', marginBottom: 12 }} />

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
              <div><label style={labelStyle} htmlFor="issue-credit-note-modal-buyer-name">Buyer Name</label><input id="issue-credit-note-modal-buyer-name" style={inputStyle} value={buyerName} onChange={e => setBuyerName(e.target.value)} /></div>
              <div><label style={labelStyle} htmlFor="issue-credit-note-modal-buyer-pan">Buyer PAN</label><input id="issue-credit-note-modal-buyer-pan" style={inputStyle} value={buyerPan} onChange={e => setBuyerPan(e.target.value)} /></div>
              <div><label style={labelStyle} htmlFor="issue-credit-note-modal-address">Address</label><input id="issue-credit-note-modal-address" style={inputStyle} value={buyerAddress} onChange={e => setBuyerAddress(e.target.value)} /></div>
              <div><label style={labelStyle} htmlFor="issue-credit-note-modal-phone">Phone</label><input id="issue-credit-note-modal-phone" style={inputStyle} value={buyerPhone} onChange={e => setBuyerPhone(e.target.value)} /></div>
            </div>

            {/* S809 2e (owner decision Q10 a): required before Issue where Inventory is on. A radio
                group like the money question below — one answer, readable back as the answer given. */}
            {askFood && (
              <fieldset style={{ border: 'none', padding: 0, margin: '0 0 12px' }}>
                <legend style={{ ...labelStyle, padding: 0 }}>
                  <Tip text="Every bill counts its dishes as used in Inventory. If this bill is being billed again on a new bill, or was a duplicate of another bill, the same food would be counted twice — answer No and this note puts it back, so Stock Report, the Reorder list and this month's Variance stay right. If the guest ate the food, or it was cooked and sent back, answer Yes: it was used, even though the money comes back. Kept with the note in the Credit Note Book; not printed on it." width={340}>
                    Was the food on this bill served?
                  </Tip>{' '}<span style={{ color: 'var(--theme-red-text)' }}>*</span>
                </legend>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px' }}>
                  {FOOD_OPTIONS.map(o => (
                    <label key={o.value} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--theme-text1)', cursor: 'pointer' }}>
                      <input type="radio" name="icn-food" value={o.value} checked={foodAnswer === o.value}
                        onChange={() => { setFoodAnswer(o.value); setMsg('') }} />
                      {o.label}
                    </label>
                  ))}
                </div>
                {foodAnswer && (
                  <p style={{ fontSize: 11, color: 'var(--theme-text3)', margin: '6px 0 0' }}>
                    {FOOD_OPTIONS.find(o => o.value === foodAnswer)?.hint}
                  </p>
                )}
                {foodAnswer === 'not_served' && billFromEarlierMonth && (
                  <p role="note" style={{ fontSize: 12, color: 'var(--theme-amber-text)', margin: '6px 0 0' }}>
                    △ This bill was charged in {BS_MONTHS[billBs.month - 1]} {billBs.year}. If it was a duplicate, that month's stock count has
                    already settled its food — answer Yes. Answer No only if the food is being billed again on a new bill now.
                  </p>
                )}
              </fieldset>
            )}

            {/* S754 (owner decision): required before Issue. A radio group, not chips — exactly one
                answer, and it has to be readable back as the answer given. */}
            <fieldset style={{ border: 'none', padding: 0, margin: '0 0 12px' }}>
              <legend style={{ ...labelStyle, padding: 0 }}>
                <Tip text="A Credit Note corrects the VAT register; it does not move money by itself. Cash takes back out of the drawer only the cash this bill brought in — the part paid by card or QR goes back that way, and points spent on it return as points — and records it as a Refund on the open shift, so the drawer count expects it. Other and None take nothing off the drawer. The answer is kept with the note in the Credit Note Book and is not printed on it." width={340}>
                  Was money returned to the customer?
                </Tip>{' '}<span style={{ color: 'var(--theme-red-text)' }}>*</span>
              </legend>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px' }}>
                {REFUND_OPTIONS.map(o => {
                  // S809 2e (SHIFTS-3): no cash came in for this bill, so none can go out for it.
                  const off = o.value === 'cash' && !(cashOut > 0)
                  return (
                    <label key={o.value} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: off ? 'var(--theme-text3)' : 'var(--theme-text1)', cursor: off ? 'not-allowed' : 'pointer' }}>
                      <input type="radio" name="icn-refund" value={o.value} checked={refundMode === o.value} disabled={off}
                        onChange={() => { setRefundMode(o.value); setMsg('') }} />
                      {o.label}
                    </label>
                  )
                })}
              </div>
              {cashTaken === null ? (
                <p role="status" style={{ fontSize: 11, color: 'var(--theme-text3)', margin: '6px 0 0' }}>Checking how much of this bill was paid in cash…</p>
              ) : !(cashOut > 0) && (
                <p style={{ fontSize: 11, color: 'var(--theme-text3)', margin: '6px 0 0' }}>
                  No cash was taken for this bill (it was paid by card, QR or points, or it is a Credit bill nobody has paid yet), so Cash is off.
                  Choose Other if the money went back by card, QR or bank. If you hand cash over anyway, record it in Shifts as a Cash Out.
                </p>
              )}
              {refundMode && (
                <p style={{ fontSize: 11, color: 'var(--theme-text3)', margin: '6px 0 0' }}>
                  {REFUND_OPTIONS.find(o => o.value === refundMode)?.hint}
                </p>
              )}
              {refundMode === 'cash' && (
                refundShift.loading ? (
                  <p role="status" style={{ fontSize: 12, color: 'var(--theme-text3)', margin: '6px 0 0' }}>Checking for an open shift…</p>
                ) : refundShift.error ? (
                  <p role="alert" style={{ fontSize: 12, color: 'var(--theme-amber-text)', margin: '6px 0 0' }}>
                    Could not check whether a shift is open. Issue will check again; if it still cannot, nothing is issued.
                  </p>
                ) : refundShift.shift === null ? (
                  <p role="alert" style={{ fontSize: 12, color: 'var(--theme-amber-text)', margin: '6px 0 0' }}>
                    △ No shift is open. Open a shift to record a cash refund, or choose Other or None.
                  </p>
                ) : refundShift.shift ? (
                  <p style={{ fontSize: 12, color: 'var(--theme-text2)', margin: '6px 0 0' }}>
                    {cashOut < amounts.net
                      ? `${fmtNpr(cashOut)} of this bill was paid in cash — that much goes out of the drawer`
                      : `${fmtNpr(cashOut)} goes out of the drawer`} on the open shift{refundShift.shift.label ? ` (${refundShift.shift.label})` : ''}.
                  </p>
                ) : null
              )}
            </fieldset>

            {msg && <p role="alert" style={{ color: msg.startsWith('error:') ? 'var(--theme-red-text)' : 'var(--theme-green-text)', fontSize: 12, marginBottom: 8 }}>{msg.replace('error:', '')}</p>}

            {/* The irreversibility warning was previously only inside a Tip on the button — and
                this page runs on a tablet, where hover does not exist, so it was invisible at the
                one moment it mattered. It is body copy now. */}
            <p style={{ fontSize: 12, color: 'var(--theme-amber-text)', margin: '0 0 10px', lineHeight: 1.6 }}>
              This credits the <strong>whole bill</strong> and cannot be undone. A sequentially-numbered
              Credit Note is issued and printed, and this month's revenue is reduced by the credited amount.
              Any loyalty points the bill earned are taken back, and any spent on it are returned.
            </p>

            {/* aria-disabled, not disabled (S776, the S759 pattern): a press names what is missing in the
                alert line above and moves to that field. A disabled Issue & Print gave a manager holding a
                customer's returned bill no reason at all. handleConfirm refuses each of these itself. */}
            {(() => {
              const issueBlocker = nothingToCredit ? { label: 'Nothing to credit on this bill' }
                : !reason.trim() ? { label: 'Enter a reason first', focus: () => document.getElementById('icn-reason')?.focus() }
                : askFood && !foodAnswer ? { label: 'Say whether the food was served', focus: () => document.querySelector('input[name="icn-food"]')?.focus() }
                : !refundMode ? { label: 'Say whether money was returned', focus: () => document.querySelector('input[name="icn-refund"]')?.focus() }
                : refundMode === 'cash' && refundShift.shift === null ? { label: 'Open a shift, or choose Other or None' }
                : null
              return (
                <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                  <button className="btn btn-ghost" onClick={onClose} disabled={submitting}>Cancel</button>
                  <button className="btn btn-primary"
                    onClick={() => { issueBlocker?.focus?.(); handleConfirm() }}
                    disabled={submitting || (refundMode === 'cash' && refundShift.loading)}
                    aria-disabled={!submitting && issueBlocker ? true : undefined}>
                    {submitting ? 'Issuing…' : issueBlocker ? issueBlocker.label : 'Issue & Print'}
                  </button>
                </div>
              )
            })()}
          </>
        )}
    </Modal>
  )
}

const labelStyle = { display: 'block', fontSize: 11, color: 'var(--theme-text3)', marginBottom: 4 }
const inputStyle = { background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)', borderRadius: 0, padding: '7px 10px', fontSize: 13, color: 'var(--theme-text1)', outline: 'none', width: '100%' }
