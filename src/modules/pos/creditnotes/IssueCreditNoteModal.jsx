import { npr } from '../../../shared/nepalMoney'
import { useState, useEffect } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { supabase } from '../../../supabaseClient'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { getBsToday, getBsFiscalYear, adToBsSafe, BS_MONTHS } from '../../../utils/bsCalendar'
import { computeOrderAmounts } from '../../../utils/posBillingMath'
import { printCreditNote } from './creditNoteHtml'
import Modal from '../../../components/Modal'
import Tip from '../../../components/Tip'
import ReportLoadError from '../../../components/ReportLoadError'
import { errorLine, errorText, isNetworkError } from '../../../shared/errorText'
import { postCreditNoteToIms } from './creditNotePosting'

// "Was money returned to the customer?" (S754, owner decision). Asked on every note, because a
// Credit Note corrects the VAT register and says nothing about the drawer: a cash refund handed
// over the counter with no record reads as a shortfall at the shift close, which is exactly the
// variance the Z-report exists to explain. Cash writes a pos_cash_movements refund on the open
// shift; Other and None store nothing in cash and say so on the note's own reason line (the note
// has no separate remarks field).
const REFUND_OPTIONS = [
  { value: 'cash',  label: 'Cash',  hint: 'Paid out of the till — recorded as a Refund on the open shift, so the drawer count expects it.' },
  { value: 'other', label: 'Other (card, QR, bank)', hint: 'Returned outside the till. Nothing is taken off the drawer count.' },
  { value: 'none',  label: 'None',  hint: 'No money went back — e.g. the bill was re-issued to the right customer.' },
]
const REFUND_REASON_SUFFIX = { other: ' (money returned by card, QR or bank)', none: ' (no money returned)' }

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
  const { clientId, profile, hasPosAccess } = useAuth()
  const { scopedFrom, scopedInsert, scopedUpdate } = useScopedDb()

  const [items, setItems] = useState([])
  const [settings, setSettings] = useState({ is_vat_registered: true, invoice_prefix: '', vat_number: '', property_address: '', property_phone: '' })
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
  const [loyaltyRetrying, setLoyaltyRetrying] = useState(false)

  async function readOpenShift() {
    const { data, error } = await scopedFrom('pos_shifts', 'id, label, opened_at').eq('status', 'open').maybeSingle()
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

  useEffect(() => {
    if (!clientId) return
    let cancelled = false
    ;(async () => {
      const results = await Promise.all([
        scopedFrom('pos_order_items', 'recipe_id, name, qty, unit_price, vat_rate, comped').eq('order_id', order.id),
        supabase.from('settings').select('is_vat_registered, invoice_prefix, vat_number, property_address, property_phone').eq('client_id', clientId).maybeSingle(),
        supabase.from('clients').select('name').eq('id', clientId).single(),
      ])
      if (cancelled) return
      // S754: all three reads dropped `error`. A failed item read computed NPR 0 and still let a
      // permanent, sequentially-numbered note be issued; a failed settings read fell to the
      // `?? true` below and printed a PAN-bill client's note as a VAT Tax Invoice correction.
      const failed = results.find(r => r.error)
      if (failed) { setLoadError(failed.error); setLoading(false); return }
      const [{ data: its }, { data: st }, { data: cl }] = results
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

  const vatReg = settings.is_vat_registered
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

  // The note's side-effects (S754): the cash refund on the open shift, then the loyalty reversal.
  // Returns the warnings to show; never throws.
  async function settleAfterIssue(note, cashShift) {
    const warnings = []
    const noteLabel = `Credit Note ${note.credit_note_no ?? ''}`.trim()

    if (refundMode === 'cash' && cashShift) {
      // At most the note's net (the database refuses more), and exactly one per note
      // (pos_cash_movements_one_refund_per_note) — so a double tap cannot pay out twice.
      const refundAmt = Math.round((Number(note.net_amount ?? amounts.net) || 0) * 100) / 100
      if (refundAmt > 0) {
        try {
          const { error: refundErr } = await scopedInsert('pos_cash_movements', {
            shift_id: cashShift.id,
            direction: 'out',
            kind: 'refund',
            amount: refundAmt,
            pos_credit_note_id: note.id,
            order_id: order.id,
            reason: `${noteLabel} refund — ${reason.trim()}`.slice(0, 500),
            created_by: profile?.id || null,
          })
          if (refundErr) throw refundErr
        } catch (err) {
          // Not "was not recorded": a dropped response can follow a landed write.
          warnings.push({
            kind: 'cash',
            text: `The cash refund of ${fmtNpr(refundAmt)} could not be confirmed on the open shift. Check Shifts → Current Shift → Cash In / Out: if there is no Refund line for ${noteLabel}, the drawer will read short by that amount at close — record it there as a Cash Out.`,
            detail: errorLine(err),
          })
        }
      }
    }

    const loyalty = await reverseLoyalty(note)
    if (loyalty) warnings.push(loyalty)
    return warnings
  }

  // Takes back the points this bill earned and returns the points spent on it (S754, owner
  // decision). Idempotent on the server, so the notice's retry button is safe to press twice.
  async function reverseLoyalty(note) {
    try {
      const { error: lErr } = await supabase.rpc('reverse_loyalty_for_credit_note', { p_credit_note_id: note.id })
      if (lErr) throw lErr
      return null
    } catch (err) {
      return {
        kind: 'loyalty',
        text: "This bill's loyalty points could not be reversed just now, so the customer's balance may still include points the bill earned, or be missing points spent on it. Try again below; if it keeps failing, the Owner can correct the balance.",
        detail: errorLine(err),
      }
    }
  }

  async function retryLoyalty() {
    if (!imsNotice?.created) return
    setLoyaltyRetrying(true)
    const w = await reverseLoyalty(imsNotice.created)
    setLoyaltyRetrying(false)
    setImsNotice(n => ({
      ...n,
      warnings: [...(n.warnings || []).filter(x => x.kind !== 'loyalty'), ...(w ? [w] : [])],
      loyaltyRetried: !w,
    }))
  }

  async function handleConfirm() {
    if (loading || loadError || !amounts) return
    if (nothingToCredit) { setMsg('error:This bill has no charged lines to credit, so no Credit Note can be issued against it.'); return }
    if (!reason.trim()) { setMsg('error:Enter a reason for this Credit Note.'); return }
    if (!refundMode) { setMsg('error:Say whether money was returned to the customer — Cash, Other or None.'); return }
    setSubmitting(true); setMsg('')

    // S754: a cash refund needs an OPEN shift to go on, and that is checked again here rather than
    // trusted from when Cash was picked — the shift can close while the reason is being typed.
    // Refused before anything is written, so "nothing was issued" is true on both branches.
    let cashShift = null
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
      cashShift = r.shift
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
    const today = getBsToday()
    const issuance_fy = getBsFiscalYear(today.year, today.month)

    const payload = {
      order_id: order.id,
      invoice_fy: issuance_fy,
      original_invoice_no: order.invoice_no,
      original_invoice_label,
      original_invoice_date_bs,
      // Other / None are recorded here and nowhere else — the note has no remarks column, and
      // "no cash left the till" is exactly what a reader of the note later needs to know (S754).
      reason: reason.trim() + (REFUND_REASON_SUFFIX[refundMode] || ''),
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

    const { data: created, error } = await scopedInsert('pos_credit_notes', payload, { single: true })
    if (error) {
      // S754. Three different facts, three sentences. credit_note_exists is the guard refusing a
      // second note on this bill (another manager, or a retry after a lost response that did land).
      // A dropped connection proves nothing about whether the note was written, so it must not say
      // "nothing has changed"; the guard makes a retry safe, and the Credit Note Book is the place
      // that can tell them. Any other refusal is raised before the insert, so it may say so.
      const text = error.hint === 'credit_note_exists' || /credit_note_exists/.test(error.message || '')
        ? `error:${errorText(error, 'operator')} (${[error.code, error.message].filter(Boolean).join(' · ')})`
        : isNetworkError(error)
          ? 'error:The connection dropped, so it is not known whether this Credit Note was issued. Check the Credit Note Book before trying again — if it is there, it is valid, and a second one for this bill will be refused. ' + errorLine(error)
          : 'error:The credit note was not issued — nothing has changed. ' + errorLine(error)
      setMsg(text); setSubmitting(false); return
    }

    // This link is what stops the same bill being credited twice — CreditNotes.jsx offers only
    // orders with `credit_note_id IS NULL`. Its error used to go unchecked, so a failed write left
    // a real credit note issued against a bill the list still presented as un-credited.
    const { error: linkErr } = await scopedUpdate('pos_orders', { credit_note_id: created.id }).eq('id', order.id)

    // S754: what went back to the customer, and the loyalty the bill moved. Both run whether or not
    // the link landed — the note is issued, numbered and valid either way, and the money and the
    // points follow the NOTE, not the link. Both are after-the-fact: a failure is a warning that
    // names what now reads wrong and where to fix it, never a reason to withhold the document.
    const warnings = await settleAfterIssue(created, cashShift)

    if (linkErr) {
      setMsg(`error:Credit note ${created.credit_note_no ?? ''} was created, but linking it to the bill failed (${errorLine(linkErr)}). Do NOT issue another one for this bill — contact support to link it, or the same bill can be credited twice.` +
        (warnings.length ? ' Also: ' + warnings.map(w => w.text).join(' ') : ''))
      setSubmitting(false)
      return
    }

    // Revenue correction into TODAY's open period (the period the correction is discovered in), not
    // the original bill's. Stock/ingredient depletion is deliberately NOT reversed — the food was
    // already served; this corrects billing/tax, not stock. It used to skip silently with no open
    // period and never read its insert's error (S747); now a note that could not post is stamped
    // "waiting", said so here, counted on the POS floor and posted from Periods.
    const ims = await postCreditNoteToIms({ supabase, scopedFrom, scopedUpdate, note: created, order, items, today })

    const print = await printCreditNote(clientId, created, payableItems, settings, outletName, hscMap)
    // S754: a blocked pop-up printed nothing, and the modal closed as though it had.
    const printText = print.printed ? ''
      : 'The print window was blocked by the browser, so nothing printed. Allow pop-ups for this site, then print it from Credit Notes → Credit Note Book → Reprint.'

    setSubmitting(false)
    if (ims.posted && print.printed && warnings.length === 0) { onIssued?.(created); return }
    // The note is issued, numbered and printed whatever happens here, so this is a notice with one
    // button, not an error with a retry: Periods' backfill is the retry.
    const month = `${BS_MONTHS[today.month - 1]} ${today.year}`
    setImsNotice({
      created,
      printed: print.printed,
      imsPosted: ims.posted,
      printText,
      warnings,
      text: ims.posted ? '' : ims.reason === 'no_period'
        ? `There is no Inventory period for ${month} yet, so this credit note has not been taken off Inventory sales. Once ${month} is opened in Periods, a manager presses "Post POS bills to Inventory" on it and the note is posted then.`
        : ims.reason === 'closed'
          ? `${month} is closed in Inventory, so this credit note has not been taken off Inventory sales. An admin can post it from Periods with "Post POS bills to Inventory" on ${month}.`
          : `This credit note could not be taken off Inventory sales just now (the connection or the database refused it). It is marked as waiting — a manager can post it from Periods with "Post POS bills to Inventory" on ${month}.`,
      detail: ims.error ? errorLine(ims.error) : '',
    })
  }

  if (imsNotice) {
    const noticeWarnings = imsNotice.warnings || []
    const problems = [
      !imsNotice.printed && 'did not print',
      !imsNotice.imsPosted && 'is not yet in Inventory',
      noticeWarnings.some(w => w.kind === 'cash') && 'its cash refund needs checking',
      noticeWarnings.some(w => w.kind === 'loyalty') && 'its loyalty points are not reversed',
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
          {noticeWarnings.map(w => (
            <div key={w.kind} style={{ marginTop: 8 }}>
              {w.text}
              {w.detail && <div style={{ marginTop: 4, fontSize: 11, color: 'var(--theme-text3)', fontFamily: 'monospace' }}>{w.detail}</div>}
            </div>
          ))}
          {imsNotice.loyaltyRetried && <div role="status" style={{ marginTop: 8, color: 'var(--theme-green-text)' }}>✓ Loyalty points reversed.</div>}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          {noticeWarnings.some(w => w.kind === 'loyalty') && (
            <button className="btn btn-ghost" onClick={retryLoyalty} disabled={loyaltyRetrying} aria-busy={loyaltyRetrying || undefined}>
              {loyaltyRetrying ? 'Reversing…' : 'Retry loyalty reversal'}
            </button>
          )}
          <button className="btn btn-primary" onClick={() => onIssued?.(imsNotice.created)}>Done</button>
        </div>
      </Modal>
    )
  }

  return (
    <Modal title="Issue Credit Note" onClose={onClose} maxWidth={520}>
        <p style={{ margin: '0 0 14px', fontSize: 12, color: 'var(--theme-text3)' }}>
          Corrects {order.invoice_no != null ? invoiceLabel(order, vatReg, settings.invoice_prefix) : `Order #${order.order_no}`}. This is a formal VAT-Rules Credit Note — it reduces revenue for this fiscal month but does not touch stock.
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

            {/* S754 (owner decision): required before Issue. A radio group, not chips — exactly one
                answer, and it has to be readable back as the answer given. */}
            <fieldset style={{ border: 'none', padding: 0, margin: '0 0 12px' }}>
              <legend style={{ ...labelStyle, padding: 0 }}>
                <Tip text="A Credit Note corrects the VAT register; it does not move money by itself. Cash is recorded as a Refund on the open shift so the drawer count expects it. Other and None are written on the note's reason line and take nothing off the drawer." width={320}>
                  Was money returned to the customer?
                </Tip>{' '}<span style={{ color: 'var(--theme-red-text)' }}>*</span>
              </legend>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px' }}>
                {REFUND_OPTIONS.map(o => (
                  <label key={o.value} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--theme-text1)', cursor: 'pointer' }}>
                    <input type="radio" name="icn-refund" value={o.value} checked={refundMode === o.value}
                      onChange={() => { setRefundMode(o.value); setMsg('') }} />
                    {o.label}
                  </label>
                ))}
              </div>
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
                    {fmtNpr(amounts.net)} goes out of the drawer on the open shift{refundShift.shift.label ? ` (${refundShift.shift.label})` : ''}.
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

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={onClose} disabled={submitting}>Cancel</button>
              <button className="btn btn-primary" onClick={handleConfirm}
                disabled={submitting || nothingToCredit || !refundMode || (refundMode === 'cash' && (refundShift.loading || refundShift.shift === null))}>
                {submitting ? 'Issuing…' : 'Issue & Print'}
              </button>
            </div>
          </>
        )}
    </Modal>
  )
}

const labelStyle = { display: 'block', fontSize: 11, color: 'var(--theme-text3)', marginBottom: 4 }
const inputStyle = { background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)', borderRadius: 0, padding: '7px 10px', fontSize: 13, color: 'var(--theme-text1)', outline: 'none', width: '100%' }
